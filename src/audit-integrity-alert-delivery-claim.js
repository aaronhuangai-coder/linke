/**
 * Audit integrity alert delivery claim coordinator (Task 3).
 *
 * Local durable claim / complete / release only — no transport, scheduler,
 * network I/O, timers, Agent/Server/Web wiring, or wall-clock reads.
 *
 * Consumes existing claim-state, stream ensure/under-lease read, outbox
 * read / lease-guarded ack, pure request builder, shared write queue, and
 * LaunchAgent process identity reader.
 */

import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { buildAuditIntegrityAlertDeliveryRequest } from './audit-integrity-alert-delivery.js';
import {
  loadAuditIntegrityAlertDeliveryClaimState,
  publishAuditIntegrityAlertDeliveryClaimState,
} from './audit-integrity-alert-delivery-claim-state.js';
import {
  ensureAuditIntegrityAlertDeliveryStream,
  readAuditIntegrityAlertDeliveryStreamUnderLease,
} from './audit-integrity-alert-delivery-stream.js';
import {
  acknowledgeAuditIntegrityAlertOutboxHeadUnderLease,
  readAuditIntegrityAlertOutbox,
} from './audit-integrity-alert-outbox.js';
import { enqueueAuditIntegrityWriteTask } from './audit-integrity-write-queue.js';
import { createLaunchAgentProcessIdentityReader } from './launchagent-lifecycle/process-identity.js';
import { assertSafeDataRoot } from './safe-data-files.js';

/** Claim wall TTL in milliseconds (exact). Expiry alone does not revoke the token. */
export const AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_TTL_MS = 120_000;

const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CAPABILITY_KEYS = Object.freeze(['claimId', 'streamId', 'sequence']);

const CLAIM_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'claimId',
  'streamId',
  'sequence',
  'expiresAt',
  'request',
]);

const COMPLETE_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'completed',
  'streamId',
  'sequence',
  'pendingCount',
]);

const RELEASE_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'released',
  'streamId',
  'sequence',
]);

/**
 * @returns {LinkeError}
 */
function unavailableError() {
  return new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
}

/**
 * @returns {never}
 */
function fail() {
  throw unavailableError();
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (utilTypes.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject Proxy / non-plain / symbol / non-enumerable / accessor own keys.
 * utilTypes.isProxy first so hostile traps never fire.
 *
 * @param {unknown} value
 * @returns {object}
 */
function assertPlainDataObject(value) {
  if (!isPlainObject(value)) fail();
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== 'string') fail();
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc) fail();
    if (!desc.enumerable) fail();
    if (desc.get !== undefined || desc.set !== undefined) fail();
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) fail();
  }
  return value;
}

/**
 * @param {object} obj
 * @param {readonly string[]} expected
 */
function assertExactKeyOrder(obj, expected) {
  const keys = Reflect.ownKeys(obj);
  if (keys.length !== expected.length) fail();
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== expected[i]) fail();
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertCanonicalNow(value) {
  if (typeof value !== 'string' || !MS_UTC_RE.test(value)) fail();
  let iso;
  try {
    iso = new Date(value).toISOString();
  } catch {
    fail();
  }
  if (iso !== value) fail();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertUuidV4(value) {
  if (typeof value !== 'string' || !UUID_V4_RE.test(value)) fail();
  return value;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function assertPositiveSafeInteger(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail();
  }
  return value;
}

/**
 * Exact capability {claimId,streamId,sequence} before any filesystem mutation.
 *
 * @param {unknown} claim
 * @returns {{ claimId: string, streamId: string, sequence: number }}
 */
function assertCapability(claim) {
  const obj = assertPlainDataObject(claim);
  assertExactKeyOrder(obj, CAPABILITY_KEYS);
  return {
    claimId: assertUuidV4(obj.claimId),
    streamId: assertUuidV4(obj.streamId),
    sequence: assertPositiveSafeInteger(obj.sequence),
  };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (!Object.isFrozen(value)) Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
  }
  return value;
}

/**
 * @param {string} status
 * @param {string | null} claimId
 * @param {string | null} streamId
 * @param {number | null} sequence
 * @param {string | null} expiresAt
 * @param {object | null} request
 */
function freezeClaimReceipt(status, claimId, streamId, sequence, expiresAt, request) {
  const receipt = {
    schemaVersion: 1,
    status,
    claimId,
    streamId,
    sequence,
    expiresAt,
    request,
  };
  if (Reflect.ownKeys(receipt).length !== CLAIM_RECEIPT_KEYS.length) fail();
  for (let i = 0; i < CLAIM_RECEIPT_KEYS.length; i += 1) {
    if (Reflect.ownKeys(receipt)[i] !== CLAIM_RECEIPT_KEYS[i]) fail();
  }
  return deepFreeze(receipt);
}

function emptyReceipt() {
  return freezeClaimReceipt('empty', null, null, null, null, null);
}

/**
 * @param {string} streamId
 * @param {number} sequence
 * @param {string} expiresAt
 */
function busyReceipt(streamId, sequence, expiresAt) {
  return freezeClaimReceipt('busy', null, streamId, sequence, expiresAt, null);
}

/**
 * @param {string} claimId
 * @param {string} streamId
 * @param {number} sequence
 * @param {string} expiresAt
 * @param {object} request
 */
function claimedReceipt(claimId, streamId, sequence, expiresAt, request) {
  return freezeClaimReceipt('claimed', claimId, streamId, sequence, expiresAt, request);
}

/**
 * @param {'completed' | 'already-completed'} status
 * @param {string} streamId
 * @param {number} sequence
 * @param {number} pendingCount
 */
function completeReceipt(status, streamId, sequence, pendingCount) {
  const receipt = {
    schemaVersion: 1,
    status,
    completed: true,
    streamId,
    sequence,
    pendingCount,
  };
  if (Reflect.ownKeys(receipt).length !== COMPLETE_RECEIPT_KEYS.length) fail();
  for (let i = 0; i < COMPLETE_RECEIPT_KEYS.length; i += 1) {
    if (Reflect.ownKeys(receipt)[i] !== COMPLETE_RECEIPT_KEYS[i]) fail();
  }
  return deepFreeze(receipt);
}

/**
 * @param {string} streamId
 * @param {number} sequence
 */
function releasedReceipt(streamId, sequence) {
  const receipt = {
    schemaVersion: 1,
    status: 'released',
    released: true,
    streamId,
    sequence,
  };
  if (Reflect.ownKeys(receipt).length !== RELEASE_RECEIPT_KEYS.length) fail();
  for (let i = 0; i < RELEASE_RECEIPT_KEYS.length; i += 1) {
    if (Reflect.ownKeys(receipt)[i] !== RELEASE_RECEIPT_KEYS[i]) fail();
  }
  return deepFreeze(receipt);
}

/**
 * Canonical idle claim state (plain, unfrozen) for publish.
 * @returns {object}
 */
function idleClaimState() {
  return {
    schemaVersion: 1,
    status: 'idle',
    claimId: null,
    streamId: null,
    sequence: null,
    ownerPid: null,
    bootSessionIdentity: null,
    processStartIdentity: null,
    claimedAt: null,
    expiresAt: null,
  };
}

/**
 * @param {object} identity current() result
 * @returns {{
 *   bootSessionIdentity: { available: true, value: string },
 *   processStartIdentity: { available: true, value: string },
 * }}
 */
function assertAvailableIdentity(identity) {
  if (identity === null || typeof identity !== 'object') fail();
  const boot = identity.bootSessionIdentity;
  const proc = identity.processStartIdentity;
  if (
    boot === null
    || typeof boot !== 'object'
    || boot.available !== true
    || typeof boot.value !== 'string'
    || boot.value.length === 0
  ) {
    fail();
  }
  if (
    proc === null
    || typeof proc !== 'object'
    || proc.available !== true
    || typeof proc.value !== 'string'
    || proc.value.length === 0
  ) {
    fail();
  }
  return {
    bootSessionIdentity: { available: true, value: boot.value },
    processStartIdentity: { available: true, value: proc.value },
  };
}

/**
 * FIFO head relation for a claimed sequence vs current outbox.
 * @param {object} outbox frozen outbox snapshot
 * @param {number} claimSequence
 * @returns {'current-head' | 'residual' | 'impossible'}
 */
function classifyHeadRelation(outbox, claimSequence) {
  const entries = outbox.entries;
  if (entries.length > 0) {
    const headSeq = entries[0].sequence;
    if (claimSequence === headSeq) return 'current-head';
    if (claimSequence < headSeq) return 'residual';
    return 'impossible';
  }
  // empty outbox
  if (outbox.nextSequence > claimSequence) return 'residual';
  return 'impossible';
}

/**
 * Publish a fresh claimed state for the current FIFO head and return receipt.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {string} endpoint
 * @param {string} streamId
 * @param {object} headEntry
 * @param {string} now
 * @param {{
 *   bootSessionIdentity: { available: true, value: string },
 *   processStartIdentity: { available: true, value: string },
 * }} identity
 */
async function publishFreshClaim(
  resolvedRoot,
  lease,
  endpoint,
  streamId,
  headEntry,
  now,
  identity,
) {
  // Pure request first — only after success mint claimId and persist.
  const request = buildAuditIntegrityAlertDeliveryRequest(
    endpoint,
    streamId,
    headEntry,
  );

  let claimId;
  try {
    claimId = randomUUID();
  } catch {
    fail();
  }
  if (typeof claimId !== 'string' || !UUID_V4_RE.test(claimId)) fail();

  const expiresAt = new Date(
    Date.parse(now) + AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_TTL_MS,
  ).toISOString();

  const claimedState = {
    schemaVersion: 1,
    status: 'claimed',
    claimId,
    streamId,
    sequence: headEntry.sequence,
    ownerPid: process.pid,
    bootSessionIdentity: {
      available: true,
      value: identity.bootSessionIdentity.value,
    },
    processStartIdentity: {
      available: true,
      value: identity.processStartIdentity.value,
    },
    claimedAt: now,
    expiresAt,
  };

  await publishAuditIntegrityAlertDeliveryClaimState(
    resolvedRoot,
    lease,
    claimedState,
  );

  return claimedReceipt(
    claimId,
    streamId,
    headEntry.sequence,
    expiresAt,
    request,
  );
}

/**
 * Claim the current FIFO head for delivery (or report empty/busy).
 *
 * @param {unknown} dataDir
 * @param {unknown} endpoint
 * @param {unknown} now
 * @returns {Promise<Readonly<object>>}
 */
export async function claimAuditIntegrityAlertDelivery(dataDir, endpoint, now) {
  try {
    const canonicalNow = assertCanonicalNow(now);

    const reader = createLaunchAgentProcessIdentityReader();
    const currentIdentity = await reader.current();
    const identity = assertAvailableIdentity(currentIdentity);

    // Snapshot outbox outside the queue. Empty → exact Empty, no stream ensure, no claim write.
    const snapshot = await readAuditIntegrityAlertOutbox(dataDir);
    if (snapshot.entries.length === 0) {
      return emptyReceipt();
    }

    // Non-empty: ensure stable stream outside the claim's single queue entry.
    const ensured = await ensureAuditIntegrityAlertDeliveryStream(dataDir);
    if (
      ensured === null
      || typeof ensured !== 'object'
      || typeof ensured.streamId !== 'string'
      || !UUID_V4_RE.test(ensured.streamId)
    ) {
      fail();
    }
    const ensuredStreamId = ensured.streamId;

    const resolvedRoot = await assertSafeDataRoot(dataDir);

    return await enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
      // Under-lease stream re-read: missing/corrupt or drift from ensured → fail closed.
      const streamState = await readAuditIntegrityAlertDeliveryStreamUnderLease(
        resolvedRoot,
        lease,
      );
      if (
        streamState === null
        || streamState.streamId !== ensuredStreamId
      ) {
        fail();
      }
      const currentStreamId = streamState.streamId;

      const outbox = await readAuditIntegrityAlertOutbox(dataDir);
      const claimState = await loadAuditIntegrityAlertDeliveryClaimState(
        resolvedRoot,
        lease,
      );

      // Empty + idle after ensure: Empty without creating a claim leaf.
      if (outbox.entries.length === 0 && claimState.status === 'idle') {
        return emptyReceipt();
      }

      if (claimState.status === 'claimed') {
        // Stream must match persisted claim before FIFO classification.
        if (claimState.streamId !== currentStreamId) fail();

        const relation = classifyHeadRelation(outbox, claimState.sequence);

        if (relation === 'impossible') fail();

        if (relation === 'residual') {
          await publishAuditIntegrityAlertDeliveryClaimState(
            resolvedRoot,
            lease,
            idleClaimState(),
          );
          if (outbox.entries.length === 0) {
            return emptyReceipt();
          }
          // Fall through to create a fresh claim for the current head.
        } else {
          // current-head: observe owner liveness / wall TTL.
          const observation = await reader.observe(claimState);
          const status = observation && observation.status;

          if (
            status === 'dead'
            || status === 'pid-reused'
            || status === 'boot-session-mismatch'
          ) {
            // Immediate replace — fall through to fresh claim.
          } else if (status === 'alive-same-owner') {
            const nowMs = Date.parse(canonicalNow);
            const claimedAtMs = Date.parse(claimState.claimedAt);
            const expiresAtMs = Date.parse(claimState.expiresAt);
            if (nowMs < claimedAtMs) {
              // Clock rollback with live owner: Busy, expose existing expiry only.
              return busyReceipt(
                currentStreamId,
                outbox.entries[0].sequence,
                claimState.expiresAt,
              );
            }
            if (nowMs < expiresAtMs) {
              return busyReceipt(
                currentStreamId,
                outbox.entries[0].sequence,
                claimState.expiresAt,
              );
            }
            // now >= expiresAt with live owner → replace.
          } else {
            // unavailable or unknown → fail closed, zero mutation.
            fail();
          }
        }
      } else if (claimState.status !== 'idle') {
        fail();
      }

      // Idle (or residual-cleared / replace path): require a current head.
      if (outbox.entries.length === 0) {
        return emptyReceipt();
      }

      const head = outbox.entries[0];
      return publishFreshClaim(
        resolvedRoot,
        lease,
        endpoint,
        currentStreamId,
        head,
        canonicalNow,
        identity,
      );
    });
  } catch {
    throw unavailableError();
  }
}

/**
 * Complete a delivery claim: exact head ack then idle, or residual idle only.
 *
 * @param {unknown} dataDir
 * @param {unknown} claim
 * @returns {Promise<Readonly<object>>}
 */
export async function completeAuditIntegrityAlertDelivery(dataDir, claim) {
  // Capability validation before any filesystem mutation / root resolve.
  let capability;
  try {
    capability = assertCapability(claim);
  } catch {
    throw unavailableError();
  }

  try {
    const resolvedRoot = await assertSafeDataRoot(dataDir);

    return await enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
      const streamState = await readAuditIntegrityAlertDeliveryStreamUnderLease(
        resolvedRoot,
        lease,
      );
      if (streamState === null) fail();
      const currentStreamId = streamState.streamId;

      const outbox = await readAuditIntegrityAlertOutbox(dataDir);
      const claimState = await loadAuditIntegrityAlertDeliveryClaimState(
        resolvedRoot,
        lease,
      );

      if (claimState.status !== 'claimed') fail();
      if (claimState.claimId !== capability.claimId) fail();
      if (claimState.streamId !== capability.streamId) fail();
      if (claimState.sequence !== capability.sequence) fail();
      if (claimState.streamId !== currentStreamId) fail();
      if (currentStreamId !== capability.streamId) fail();

      const relation = classifyHeadRelation(outbox, claimState.sequence);

      if (relation === 'impossible') fail();

      if (relation === 'residual') {
        // Post-ack residual: idle only; never remove successor head.
        await publishAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
          idleClaimState(),
        );
        return completeReceipt(
          'already-completed',
          capability.streamId,
          capability.sequence,
          outbox.entries.length,
        );
      }

      // Exact current head: outbox ack first, then idle. Order is deliberate.
      const headSequence = outbox.entries[0].sequence;
      if (headSequence !== capability.sequence) fail();

      const ack = await acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(
        resolvedRoot,
        lease,
        capability.sequence,
      );
      if (
        ack === null
        || typeof ack !== 'object'
        || ack.acknowledged !== true
        || ack.sequence !== capability.sequence
      ) {
        fail();
      }

      // If idle publish fails after successful ack, outer catch returns unavailable
      // while residual evidence remains for the next complete → already-completed.
      await publishAuditIntegrityAlertDeliveryClaimState(
        resolvedRoot,
        lease,
        idleClaimState(),
      );

      return completeReceipt(
        'completed',
        capability.streamId,
        capability.sequence,
        ack.pendingCount,
      );
    });
  } catch {
    throw unavailableError();
  }
}

/**
 * Release a live claim to idle without touching the outbox FIFO.
 *
 * @param {unknown} dataDir
 * @param {unknown} claim
 * @returns {Promise<Readonly<object>>}
 */
export async function releaseAuditIntegrityAlertDelivery(dataDir, claim) {
  let capability;
  try {
    capability = assertCapability(claim);
  } catch {
    throw unavailableError();
  }

  try {
    const resolvedRoot = await assertSafeDataRoot(dataDir);

    return await enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
      const streamState = await readAuditIntegrityAlertDeliveryStreamUnderLease(
        resolvedRoot,
        lease,
      );
      if (streamState === null) fail();
      const currentStreamId = streamState.streamId;

      const claimState = await loadAuditIntegrityAlertDeliveryClaimState(
        resolvedRoot,
        lease,
      );

      if (claimState.status !== 'claimed') fail();
      if (claimState.claimId !== capability.claimId) fail();
      if (claimState.streamId !== capability.streamId) fail();
      if (claimState.sequence !== capability.sequence) fail();
      if (claimState.streamId !== currentStreamId) fail();
      if (currentStreamId !== capability.streamId) fail();

      await publishAuditIntegrityAlertDeliveryClaimState(
        resolvedRoot,
        lease,
        idleClaimState(),
      );

      return releasedReceipt(capability.streamId, capability.sequence);
    });
  } catch {
    throw unavailableError();
  }
}
