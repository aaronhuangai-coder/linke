/**
 * Explicit durable retry tick coordinator for audit integrity alert delivery.
 *
 * Task 5: empty / not-due / busy / delivered / retry-scheduled paths only.
 * Terminal / attempts-exhausted dead-letter success paths remain Task 6 —
 * those decisions fail closed here with fixed unavailable (no outbox ack, no DLQ).
 *
 * Advancement is only via programmatic tick(now): at most one detailed network
 * request per tick, open in-flight before every request, no scheduler/timers.
 *
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md
 *   .superpowers/sdd/.../task-5-brief.md (PM recovery freeze)
 */

import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  claimAuditIntegrityAlertDelivery,
  completeAuditIntegrityAlertDelivery,
  releaseAuditIntegrityAlertDelivery,
} from './audit-integrity-alert-delivery-claim.js';
import {
  loadAuditIntegrityAlertDeliveryClaimState,
} from './audit-integrity-alert-delivery-claim-state.js';
import {
  createIdleAuditIntegrityAlertDeliveryLifecycle,
  loadAuditIntegrityAlertDeliveryLifecycle,
  publishAuditIntegrityAlertDeliveryLifecycleUnderLease,
} from './audit-integrity-alert-delivery-lifecycle.js';
import {
  appendAuditIntegrityAlertDeadLetterUnderLease,
  readAuditIntegrityAlertDeadLetter,
} from './audit-integrity-alert-dead-letter.js';
import { executeAuditIntegrityAlertHttpsRequestDetailed } from './audit-integrity-alert-https-transport.js';
import { readAuditIntegrityAlertOutbox } from './audit-integrity-alert-outbox.js';
import {
  classifyAuditIntegrityAlertRetryDecision,
  computeAuditIntegrityAlertRetryDueAt,
  computeAuditIntegrityAlertUncertainDueAt,
} from './audit-integrity-alert-retry-policy.js';
import { enqueueAuditIntegrityWriteTask } from './audit-integrity-write-queue.js';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertSafeDataRoot } from './safe-data-files.js';

/** Exact §5.5 ordered deps keys for createAuditIntegrityAlertDeliveryRetryForTesting. */
const DEPS_KEYS = Object.freeze([
  'authorizeDestination',
  'claimDelivery',
  'completeDelivery',
  'releaseDelivery',
  'loadLifecycle',
  'publishLifecycle',
  'readOutbox',
  'loadClaimState',
  'readDeadLetter',
  'appendDeadLetter',
  'executeRequestDetailed',
  'computeRetryDue',
  'computeUncertainDue',
  'classifyRetryDecision',
]);

const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'streamId',
  'sequence',
  'attemptCount',
  'nextAttemptAt',
  'pendingCount',
  'detail',
]);

const LIFECYCLE_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'lastObservedAt',
  'streamId',
  'sequence',
  'idempotencyKey',
  'attemptId',
  'attemptCount',
  'firstAttemptAt',
  'lastAttemptAt',
  'nextAttemptAt',
  'claimId',
  'claimExpiresAt',
  'outcome',
  'deadLetter',
]);

const OUTBOX_KEYS = Object.freeze(['schemaVersion', 'nextSequence', 'entries']);
const OUTBOX_ENTRY_KEYS = Object.freeze([
  'sequence',
  'checkedAt',
  'code',
  'recoveryRequired',
  'nextAction',
  'reasonCode',
]);
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
const DETAILED_RESULT_KEYS = Object.freeze(['schemaVersion', 'kind']);
const OUTCOME_KEYS = Object.freeze(['kind', 'detail']);
const CLAIM_STATE_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'claimId',
  'streamId',
  'sequence',
  'ownerPid',
  'bootSessionIdentity',
  'processStartIdentity',
  'claimedAt',
  'expiresAt',
]);
const IDENTITY_KEYS = Object.freeze(['available', 'value']);

const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const DETAILED_KINDS = new Set([
  'accepted',
  'retryable-rejected',
  'terminal-rejected',
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
 * Plain data object: not null/array/Proxy; prototype Object.prototype or null.
 * utilTypes.isProxy runs BEFORE getPrototypeOf / ownKeys so traps never fire.
 *
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (utilTypes.isProxy(value)) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject Proxy / non-plain / symbol / non-enumerable / accessor own keys.
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
function assertCanonicalIso(value) {
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
 * @param {unknown} value
 * @returns {number}
 */
function assertNonNegativeSafeInteger(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail();
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function assertAttemptCount(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail();
  if (value < 0 || value > 8) fail();
  return value;
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
 * Exact dependency object for the test factory. Reads functions only via own
 * data descriptors so accessors never run. Snapshots all 14 function refs.
 *
 * @param {unknown} deps
 * @returns {Record<string, Function>}
 */
function bindDeps(deps) {
  assertPlainDataObject(deps);
  assertExactKeyOrder(deps, DEPS_KEYS);

  /** @type {Record<string, Function>} */
  const bound = {};
  for (const key of DEPS_KEYS) {
    const desc = Object.getOwnPropertyDescriptor(deps, key);
    if (!desc || typeof desc.value !== 'function') fail();
    bound[key] = /** @type {Function} */ (desc.value);
  }
  return bound;
}

/**
 * @param {unknown} value
 * @returns {{ kind: string, detail: string | null }}
 */
function parseOutcome(value) {
  if (value === null) fail();
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, OUTCOME_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (typeof record.kind !== 'string') fail();
  if (record.detail !== null && typeof record.detail !== 'string') fail();
  return {
    kind: record.kind,
    detail: /** @type {string | null} */ (record.detail),
  };
}

/**
 * Snapshot and lightly validate a loaded lifecycle row for coordinator use.
 * Hostile/malformed rows fail closed. Full publish grammar is owned by the
 * lifecycle module on durable write.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function parseLifecycle(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, LIFECYCLE_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (record.schemaVersion !== 1) fail();
  if (typeof record.status !== 'string') fail();

  const status = record.status;
  if (status === 'idle') {
    if (record.streamId !== null) fail();
    if (record.sequence !== null) fail();
    if (record.idempotencyKey !== null) fail();
    if (record.attemptId !== null) fail();
    if (record.attemptCount !== 0) fail();
    if (record.firstAttemptAt !== null) fail();
    if (record.lastAttemptAt !== null) fail();
    if (record.nextAttemptAt !== null) fail();
    if (record.claimId !== null) fail();
    if (record.claimExpiresAt !== null) fail();
    if (record.outcome !== null) fail();
    if (record.deadLetter !== null) fail();
    if (record.lastObservedAt !== null) assertCanonicalIso(record.lastObservedAt);
    return { ...record };
  }

  // Non-idle: common stream binding
  if (record.deadLetter !== null && status !== 'dead-letter-prepared') fail();
  assertUuidV4(record.streamId);
  assertPositiveSafeInteger(record.sequence);
  if (typeof record.idempotencyKey !== 'string') fail();
  assertUuidV4(record.attemptId);
  assertAttemptCount(record.attemptCount);
  assertCanonicalIso(record.firstAttemptAt);
  assertCanonicalIso(record.lastAttemptAt);
  assertCanonicalIso(record.lastObservedAt);

  if (status === 'in-flight') {
    if (record.outcome !== null) fail();
    if (record.nextAttemptAt !== null) fail();
    assertUuidV4(record.claimId);
    assertCanonicalIso(record.claimExpiresAt);
    if (record.attemptCount < 1) fail();
    return { ...record };
  }

  if (status === 'retry-wait') {
    assertCanonicalIso(record.nextAttemptAt);
    const outcome = parseOutcome(record.outcome);
    if (outcome.kind !== 'unknown' && outcome.kind !== 'retryable-rejected') fail();
    if (record.claimId === null) {
      if (record.claimExpiresAt !== null) fail();
    } else {
      assertUuidV4(record.claimId);
      assertCanonicalIso(record.claimExpiresAt);
    }
    if (record.attemptCount < 1 || record.attemptCount > 7) fail();
    return { ...record, outcome };
  }

  if (status === 'accepted-pending-completion') {
    if (record.nextAttemptAt !== null) fail();
    const outcome = parseOutcome(record.outcome);
    if (outcome.kind !== 'accepted' || outcome.detail !== null) fail();
    assertUuidV4(record.claimId);
    assertCanonicalIso(record.claimExpiresAt);
    if (record.attemptCount < 1) fail();
    return { ...record, outcome };
  }

  // blocked / dead-letter-prepared / unknown → Task 5 fail closed
  fail();
}

/**
 * @param {unknown} value
 * @returns {{ schemaVersion: number, nextSequence: number, entries: object[] }}
 */
function parseOutbox(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, OUTBOX_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (record.schemaVersion !== 1) fail();
  assertPositiveSafeInteger(record.nextSequence);
  if (!Array.isArray(record.entries)) fail();
  const entries = [];
  for (const entry of record.entries) {
    const e = assertPlainDataObject(entry);
    assertExactKeyOrder(e, OUTBOX_ENTRY_KEYS);
    assertPositiveSafeInteger(/** @type {Record<string, unknown>} */ (e).sequence);
    entries.push(e);
  }
  return {
    schemaVersion: 1,
    nextSequence: /** @type {number} */ (record.nextSequence),
    entries,
  };
}

/**
 * @param {unknown} value
 * @returns {{
 *   kind: 'empty',
 * } | {
 *   kind: 'busy',
 *   streamId: string,
 *   sequence: number,
 *   expiresAt: string,
 * } | {
 *   kind: 'claimed',
 *   claimId: string,
 *   streamId: string,
 *   sequence: number,
 *   expiresAt: string,
 *   request: unknown,
 * }}
 */
function parseClaimReceipt(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, CLAIM_RECEIPT_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (record.schemaVersion !== 1) fail();

  if (record.status === 'empty') {
    if (record.claimId !== null) fail();
    if (record.streamId !== null) fail();
    if (record.sequence !== null) fail();
    if (record.expiresAt !== null) fail();
    if (record.request !== null) fail();
    return { kind: 'empty' };
  }

  if (record.status === 'busy') {
    if (record.claimId !== null) fail();
    if (record.request !== null) fail();
    return {
      kind: 'busy',
      streamId: assertUuidV4(record.streamId),
      sequence: assertPositiveSafeInteger(record.sequence),
      expiresAt: assertCanonicalIso(record.expiresAt),
    };
  }

  if (record.status === 'claimed') {
    if (record.request === null || record.request === undefined) fail();
    return {
      kind: 'claimed',
      claimId: assertUuidV4(record.claimId),
      streamId: assertUuidV4(record.streamId),
      sequence: assertPositiveSafeInteger(record.sequence),
      expiresAt: assertCanonicalIso(record.expiresAt),
      request: record.request,
    };
  }

  fail();
}

/**
 * @param {unknown} value
 * @returns {{
 *   status: 'completed' | 'already-completed',
 *   streamId: string,
 *   sequence: number,
 *   pendingCount: number,
 * }}
 */
function parseCompleteReceipt(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, COMPLETE_RECEIPT_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (record.schemaVersion !== 1) fail();
  if (record.status !== 'completed' && record.status !== 'already-completed') {
    fail();
  }
  if (record.completed !== true) fail();
  return {
    status: /** @type {'completed' | 'already-completed'} */ (record.status),
    streamId: assertUuidV4(record.streamId),
    sequence: assertPositiveSafeInteger(record.sequence),
    pendingCount: assertNonNegativeSafeInteger(record.pendingCount),
  };
}

/**
 * @param {unknown} value
 * @param {{ claimId: string, streamId: string, sequence: number }} capability
 */
function parseReleaseReceipt(value, capability) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, RELEASE_RECEIPT_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (record.schemaVersion !== 1) fail();
  if (record.status !== 'released') fail();
  if (record.released !== true) fail();
  if (assertUuidV4(record.streamId) !== capability.streamId) fail();
  if (assertPositiveSafeInteger(record.sequence) !== capability.sequence) fail();
}

/**
 * @param {unknown} value
 * @returns {'accepted' | 'retryable-rejected' | 'terminal-rejected'}
 */
function parseDetailedResult(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, DETAILED_RESULT_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (record.schemaVersion !== 1) fail();
  if (typeof record.kind !== 'string' || !DETAILED_KINDS.has(record.kind)) fail();
  return /** @type {'accepted' | 'retryable-rejected' | 'terminal-rejected'} */ (
    record.kind
  );
}

/**
 * Nested process/boot identity: exact {available:true, value:<path-free string>}.
 *
 * @param {unknown} value
 * @returns {{ available: true, value: string }}
 */
function parseClaimIdentity(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, IDENTITY_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (record.available !== true) fail();
  if (typeof record.value !== 'string' || record.value.length === 0) fail();
  if (
    record.value.includes('/')
    || record.value.includes('\\')
    || record.value.includes('\n')
    || record.value.includes('\r')
    || record.value.includes('\0')
  ) {
    fail();
  }
  return {
    available: true,
    value: record.value,
  };
}

/**
 * Complete real claim-state shape (idle or claimed). Rejects Proxy/accessors
 * via assertPlainDataObject before any field walk.
 *
 * @param {unknown} value
 * @returns {{
 *   status: 'idle',
 * } | {
 *   status: 'claimed',
 *   claimId: string,
 *   streamId: string,
 *   sequence: number,
 * }}
 */
function parseClaimState(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, CLAIM_STATE_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (record.schemaVersion !== 1) fail();

  if (record.status === 'idle') {
    if (record.claimId !== null) fail();
    if (record.streamId !== null) fail();
    if (record.sequence !== null) fail();
    if (record.ownerPid !== null) fail();
    if (record.bootSessionIdentity !== null) fail();
    if (record.processStartIdentity !== null) fail();
    if (record.claimedAt !== null) fail();
    if (record.expiresAt !== null) fail();
    return { status: 'idle' };
  }

  if (record.status === 'claimed') {
    const claimId = assertUuidV4(record.claimId);
    const streamId = assertUuidV4(record.streamId);
    const sequence = assertPositiveSafeInteger(record.sequence);
    assertPositiveSafeInteger(record.ownerPid);
    parseClaimIdentity(record.bootSessionIdentity);
    parseClaimIdentity(record.processStartIdentity);
    const claimedAt = assertCanonicalIso(record.claimedAt);
    const expiresAt = assertCanonicalIso(record.expiresAt);
    if (!(Date.parse(claimedAt) < Date.parse(expiresAt))) fail();
    return {
      status: 'claimed',
      claimId,
      streamId,
      sequence,
    };
  }

  fail();
}

/**
 * @param {{ claimId: string, streamId: string, sequence: number }} claimed
 * @returns {{ claimId: string, streamId: string, sequence: number }}
 */
function exactCapability(claimed) {
  return {
    claimId: claimed.claimId,
    streamId: claimed.streamId,
    sequence: claimed.sequence,
  };
}

/**
 * @param {string} streamId
 * @param {number} sequence
 * @returns {string}
 */
function buildIdempotencyKey(streamId, sequence) {
  return `audit-integrity-alert:${streamId}:${sequence}`;
}

/**
 * Public receipt factory — exact §13.2 keys, deep frozen.
 *
 * @param {{
 *   status: string,
 *   streamId: string | null,
 *   sequence: number | null,
 *   attemptCount: number | null,
 *   nextAttemptAt: string | null,
 *   pendingCount: number | null,
 *   detail: string | null,
 * }} fields
 * @returns {Readonly<object>}
 */
function publicReceipt(fields) {
  const receipt = {
    schemaVersion: 1,
    status: fields.status,
    streamId: fields.streamId,
    sequence: fields.sequence,
    attemptCount: fields.attemptCount,
    nextAttemptAt: fields.nextAttemptAt,
    pendingCount: fields.pendingCount,
    detail: fields.detail,
  };
  assertExactKeyOrder(receipt, RECEIPT_KEYS);
  return deepFreeze(receipt);
}

/**
 * @param {Record<string, unknown>} lifecycle
 * @param {string} now
 */
function assertClockNotRollback(lifecycle, now) {
  const watermark = lifecycle.lastObservedAt;
  if (watermark !== null && typeof watermark === 'string' && now < watermark) {
    fail();
  }
}

/**
 * Outbox head sequence must match lifecycle-bound sequence for relation checks.
 * Entries never carry streamId; stream identity is lifecycle/claim only.
 *
 * @param {{ entries: object[] }} outbox
 * @param {unknown} sequence
 */
function assertOutboxHeadSequence(outbox, sequence) {
  if (outbox.entries.length === 0) fail();
  const head = /** @type {Record<string, unknown>} */ (outbox.entries[0]);
  if (head.sequence !== sequence) fail();
}

/**
 * @param {Record<string, Function>} deps
 * @param {unknown} dataDir
 * @param {object} row
 * @returns {Promise<unknown>}
 */
async function publishLifecycle(deps, dataDir, row) {
  return deps.publishLifecycle(dataDir, row);
}

/**
 * Build open in-flight row from claim + prior lifecycle attempt accounting.
 *
 * @param {{
 *   claimId: string,
 *   streamId: string,
 *   sequence: number,
 *   expiresAt: string,
 * }} claim
 * @param {string} now
 * @param {Record<string, unknown>} priorLifecycle
 * @returns {object}
 */
function buildInFlightRow(claim, now, priorLifecycle) {
  const priorCount = typeof priorLifecycle.attemptCount === 'number'
    ? priorLifecycle.attemptCount
    : 0;
  const attemptCount = priorCount + 1;
  if (attemptCount < 1 || attemptCount > 8) fail();

  const priorFirst = priorLifecycle.firstAttemptAt;
  const firstAttemptAt = typeof priorFirst === 'string' ? priorFirst : now;
  const priorWatermark = priorLifecycle.lastObservedAt;
  let lastObservedAt = now;
  if (typeof priorWatermark === 'string' && priorWatermark > now) {
    fail();
  }
  if (typeof priorWatermark === 'string' && priorWatermark > lastObservedAt) {
    lastObservedAt = priorWatermark;
  }

  return {
    schemaVersion: 1,
    status: 'in-flight',
    lastObservedAt,
    streamId: claim.streamId,
    sequence: claim.sequence,
    idempotencyKey: buildIdempotencyKey(claim.streamId, claim.sequence),
    attemptId: randomUUID(),
    attemptCount,
    firstAttemptAt,
    lastAttemptAt: now,
    nextAttemptAt: null,
    claimId: claim.claimId,
    claimExpiresAt: claim.expiresAt,
    outcome: null,
    deadLetter: null,
  };
}

/**
 * @param {Record<string, unknown>} inflight
 * @param {string} nextAttemptAt
 * @param {{ kind: string, detail: string | null }} outcome
 * @param {string | null} claimId
 * @param {string | null} claimExpiresAt
 * @returns {object}
 */
function buildRetryWaitRow(inflight, nextAttemptAt, outcome, claimId, claimExpiresAt) {
  return {
    schemaVersion: 1,
    status: 'retry-wait',
    lastObservedAt: inflight.lastObservedAt,
    streamId: inflight.streamId,
    sequence: inflight.sequence,
    idempotencyKey: inflight.idempotencyKey,
    attemptId: inflight.attemptId,
    attemptCount: inflight.attemptCount,
    firstAttemptAt: inflight.firstAttemptAt,
    lastAttemptAt: inflight.lastAttemptAt,
    nextAttemptAt,
    claimId,
    claimExpiresAt,
    outcome: { kind: outcome.kind, detail: outcome.detail },
    deadLetter: null,
  };
}

/**
 * @param {Record<string, unknown>} inflight
 * @returns {object}
 */
function buildAcceptedPendingRow(inflight) {
  return {
    schemaVersion: 1,
    status: 'accepted-pending-completion',
    lastObservedAt: inflight.lastObservedAt,
    streamId: inflight.streamId,
    sequence: inflight.sequence,
    idempotencyKey: inflight.idempotencyKey,
    attemptId: inflight.attemptId,
    attemptCount: inflight.attemptCount,
    firstAttemptAt: inflight.firstAttemptAt,
    lastAttemptAt: inflight.lastAttemptAt,
    nextAttemptAt: null,
    claimId: inflight.claimId,
    claimExpiresAt: inflight.claimExpiresAt,
    outcome: { kind: 'accepted', detail: null },
    deadLetter: null,
  };
}

/**
 * Idle retaining watermark only (exact lifecycle idle grammar).
 *
 * @param {unknown} lastObservedAt
 * @returns {Readonly<object>}
 */
function buildIdleRow(lastObservedAt) {
  return createIdleAuditIntegrityAlertDeliveryLifecycle(
    lastObservedAt === undefined ? null : lastObservedAt,
  );
}

/**
 * Claim empty/busy/claimed branch helper after a successful claimDelivery.
 *
 * @param {Record<string, Function>} deps
 * @param {unknown} dataDir
 * @param {string} authorized
 * @param {string} canonicalNow
 * @param {Record<string, unknown>} lifecycle
 * @param {number} pendingCount
 * @param {number} busyAttemptCount
 * @returns {Promise<Readonly<object>>}
 */
async function claimAndEnter(
  deps,
  dataDir,
  authorized,
  canonicalNow,
  lifecycle,
  pendingCount,
  busyAttemptCount,
) {
  const claimReceipt = parseClaimReceipt(
    await deps.claimDelivery(dataDir, authorized, canonicalNow),
  );
  if (claimReceipt.kind === 'empty') {
    return publicReceipt({
      status: 'empty',
      streamId: null,
      sequence: null,
      attemptCount: null,
      nextAttemptAt: null,
      pendingCount: 0,
      detail: null,
    });
  }
  if (claimReceipt.kind === 'busy') {
    return publicReceipt({
      status: 'busy',
      streamId: claimReceipt.streamId,
      sequence: claimReceipt.sequence,
      attemptCount: busyAttemptCount,
      nextAttemptAt: null,
      pendingCount,
      detail: null,
    });
  }
  if (lifecycle.sequence !== null && claimReceipt.sequence !== lifecycle.sequence) {
    fail();
  }
  if (lifecycle.streamId !== null && claimReceipt.streamId !== lifecycle.streamId) {
    fail();
  }
  return enterAttempt(
    deps,
    dataDir,
    claimReceipt,
    lifecycle,
    canonicalNow,
    pendingCount,
  );
}

/**
 * Core tick bound to snapshotted dependency functions.
 *
 * @param {Record<string, Function>} deps
 * @returns {(dataDir: unknown, endpoint: unknown, now: unknown) => Promise<Readonly<object>>}
 */
function createTick(deps) {
  return async function tick(dataDir, endpoint, now) {
    try {
      // Pure first gate: canonical-now before every dependency call.
      const canonicalNow = assertCanonicalIso(now);

      // Authorize exactly once with the original primitive endpoint.
      const authorized = deps.authorizeDestination(endpoint);
      if (typeof authorized !== 'string') fail();
      if (authorized !== endpoint) fail();

      const lifecycleRaw = await deps.loadLifecycle(dataDir);
      let lifecycle = parseLifecycle(lifecycleRaw);
      assertClockNotRollback(lifecycle, canonicalNow);

      const outbox = parseOutbox(await deps.readOutbox(dataDir));
      const pendingCount = outbox.entries.length;

      // ── Crash recovery: durable open in-flight → retry-wait unknown ──
      if (lifecycle.status === 'in-flight') {
        assertOutboxHeadSequence(outbox, lifecycle.sequence);
        const effectiveDue = deps.computeUncertainDue(
          lifecycle.lastAttemptAt,
          lifecycle.attemptCount,
          lifecycle.claimExpiresAt,
        );
        if (typeof effectiveDue !== 'string') fail();
        assertCanonicalIso(effectiveDue);

        const waitRow = buildRetryWaitRow(
          lifecycle,
          effectiveDue,
          { kind: 'unknown', detail: null },
          /** @type {string} */ (lifecycle.claimId),
          /** @type {string} */ (lifecycle.claimExpiresAt),
        );
        await publishLifecycle(deps, dataDir, waitRow);

        // Conversion tick never networks; report due vs not-due only.
        if (canonicalNow < effectiveDue) {
          return publicReceipt({
            status: 'not-due',
            streamId: /** @type {string} */ (lifecycle.streamId),
            sequence: /** @type {number} */ (lifecycle.sequence),
            attemptCount: /** @type {number} */ (lifecycle.attemptCount),
            nextAttemptAt: effectiveDue,
            pendingCount,
            detail: null,
          });
        }
        return publicReceipt({
          status: 'retry-scheduled',
          streamId: /** @type {string} */ (lifecycle.streamId),
          sequence: /** @type {number} */ (lifecycle.sequence),
          attemptCount: /** @type {number} */ (lifecycle.attemptCount),
          nextAttemptAt: effectiveDue,
          pendingCount,
          detail: null,
        });
      }

      // ── Accepted-pending-completion residual recovery ──
      if (lifecycle.status === 'accepted-pending-completion') {
        const capability = exactCapability({
          claimId: /** @type {string} */ (lifecycle.claimId),
          streamId: /** @type {string} */ (lifecycle.streamId),
          sequence: /** @type {number} */ (lifecycle.sequence),
        });
        // Head may be residual after prior ack; complete validates relation.
        const completed = parseCompleteReceipt(
          await deps.completeDelivery(dataDir, capability),
        );
        if (completed.streamId !== capability.streamId) fail();
        if (completed.sequence !== capability.sequence) fail();

        await publishLifecycle(
          deps,
          dataDir,
          buildIdleRow(lifecycle.lastObservedAt),
        );

        return publicReceipt({
          status: 'delivered',
          streamId: completed.streamId,
          sequence: completed.sequence,
          attemptCount: /** @type {number} */ (lifecycle.attemptCount),
          nextAttemptAt: null,
          pendingCount: completed.pendingCount,
          detail: null,
        });
      }

      // ── Retry-wait paths ──
      if (lifecycle.status === 'retry-wait') {
        assertOutboxHeadSequence(outbox, lifecycle.sequence);
        const outcome = /** @type {{ kind: string, detail: string | null }} */ (
          lifecycle.outcome
        );

        // Release-pending recovery: loaded retry-wait retryable with claim V.
        // Observe claim file once; idle residual aligns WAL without release.
        if (
          outcome.kind === 'retryable-rejected'
          && lifecycle.claimId !== null
        ) {
          const capability = exactCapability({
            claimId: /** @type {string} */ (lifecycle.claimId),
            streamId: /** @type {string} */ (lifecycle.streamId),
            sequence: /** @type {number} */ (lifecycle.sequence),
          });

          const claimState = parseClaimState(
            await deps.loadClaimState(dataDir),
          );

          if (claimState.status === 'claimed') {
            if (claimState.claimId !== capability.claimId) fail();
            if (claimState.streamId !== capability.streamId) fail();
            if (claimState.sequence !== capability.sequence) fail();
            parseReleaseReceipt(
              await deps.releaseDelivery(dataDir, capability),
              capability,
            );
          } else if (claimState.status !== 'idle') {
            fail();
          }
          // status === 'idle': no releaseDelivery; align claim fields N only.

          const claimN = buildRetryWaitRow(
            lifecycle,
            /** @type {string} */ (lifecycle.nextAttemptAt),
            outcome,
            null,
            null,
          );
          await publishLifecycle(deps, dataDir, claimN);
          lifecycle = parseLifecycle(claimN);
        }

        const dueAt = /** @type {string} */ (lifecycle.nextAttemptAt);
        if (canonicalNow < dueAt) {
          return publicReceipt({
            status: 'not-due',
            streamId: /** @type {string} */ (lifecycle.streamId),
            sequence: /** @type {number} */ (lifecycle.sequence),
            attemptCount: /** @type {number} */ (lifecycle.attemptCount),
            nextAttemptAt: dueAt,
            pendingCount,
            detail: null,
          });
        }

        // Due (claim-N or claim-V): existing claimDelivery replacement rules,
        // then new open in-flight + one detailed request from the receipt.
        // claim-V at due is at/over claimExpiresAt (effectiveDue = max(backoff,
        // claimExpiresAt)); never synthesize request/capability from old row.
        return claimAndEnter(
          deps,
          dataDir,
          authorized,
          canonicalNow,
          lifecycle,
          pendingCount,
          /** @type {number} */ (lifecycle.attemptCount),
        );
      }

      // ── Idle ──
      if (lifecycle.status === 'idle') {
        if (pendingCount === 0) {
          return publicReceipt({
            status: 'empty',
            streamId: null,
            sequence: null,
            attemptCount: null,
            nextAttemptAt: null,
            pendingCount: 0,
            detail: null,
          });
        }

        return claimAndEnter(
          deps,
          dataDir,
          authorized,
          canonicalNow,
          lifecycle,
          pendingCount,
          0,
        );
      }

      fail();
    } catch {
      throw unavailableError();
    }
  };
}

/**
 * Publish open in-flight, issue at most one detailed request, settle.
 *
 * @param {Record<string, Function>} deps
 * @param {unknown} dataDir
 * @param {{
 *   kind: 'claimed',
 *   claimId: string,
 *   streamId: string,
 *   sequence: number,
 *   expiresAt: string,
 *   request: unknown,
 * }} claim
 * @param {Record<string, unknown>} priorLifecycle
 * @param {string} now
 * @param {number} pendingCount
 * @returns {Promise<Readonly<object>>}
 */
async function enterAttempt(deps, dataDir, claim, priorLifecycle, now, pendingCount) {
  const inflight = buildInFlightRow(claim, now, priorLifecycle);
  await publishLifecycle(deps, dataDir, inflight);

  // Catch only rejection/throw from the detailed request. A resolved but
  // malformed value must parse outside that catch so schema failure fails
  // closed after open in-flight + one request (no settlement publish).
  /** @type {'accepted' | 'retryable-rejected' | 'terminal-rejected' | 'uncertain'} */
  let detailedKind;
  /** @type {unknown} */
  let detailedResolved;
  let requestThrew = false;
  try {
    detailedResolved = await deps.executeRequestDetailed(claim.request);
  } catch {
    requestThrew = true;
  }
  if (requestThrew) {
    detailedKind = 'uncertain';
  } else {
    detailedKind = parseDetailedResult(detailedResolved);
  }

  const decision = deps.classifyRetryDecision(inflight.attemptCount, detailedKind);
  if (typeof decision !== 'string') fail();

  if (decision === 'accept-complete') {
    const pendingRow = buildAcceptedPendingRow(inflight);
    await publishLifecycle(deps, dataDir, pendingRow);

    const capability = exactCapability({
      claimId: claim.claimId,
      streamId: claim.streamId,
      sequence: claim.sequence,
    });
    const completed = parseCompleteReceipt(
      await deps.completeDelivery(dataDir, capability),
    );
    if (completed.streamId !== capability.streamId) fail();
    if (completed.sequence !== capability.sequence) fail();

    await publishLifecycle(
      deps,
      dataDir,
      buildIdleRow(pendingRow.lastObservedAt),
    );

    return publicReceipt({
      status: 'delivered',
      streamId: completed.streamId,
      sequence: completed.sequence,
      attemptCount: /** @type {number} */ (inflight.attemptCount),
      nextAttemptAt: null,
      pendingCount: completed.pendingCount,
      detail: null,
    });
  }

  if (decision === 'retry-wait') {
    const backoffDue = deps.computeRetryDue(
      inflight.lastAttemptAt,
      inflight.attemptCount,
    );
    if (typeof backoffDue !== 'string') fail();
    assertCanonicalIso(backoffDue);

    const waitV = buildRetryWaitRow(
      inflight,
      backoffDue,
      { kind: 'retryable-rejected', detail: 'retryable-http' },
      claim.claimId,
      claim.expiresAt,
    );
    await publishLifecycle(deps, dataDir, waitV);

    const capability = exactCapability({
      claimId: claim.claimId,
      streamId: claim.streamId,
      sequence: claim.sequence,
    });
    parseReleaseReceipt(
      await deps.releaseDelivery(dataDir, capability),
      capability,
    );

    const waitN = buildRetryWaitRow(
      inflight,
      backoffDue,
      { kind: 'retryable-rejected', detail: 'retryable-http' },
      null,
      null,
    );
    await publishLifecycle(deps, dataDir, waitN);

    return publicReceipt({
      status: 'retry-scheduled',
      streamId: claim.streamId,
      sequence: claim.sequence,
      attemptCount: /** @type {number} */ (inflight.attemptCount),
      nextAttemptAt: backoffDue,
      pendingCount,
      detail: 'retryable-http',
    });
  }

  if (decision === 'uncertain-hold') {
    const effectiveDue = deps.computeUncertainDue(
      inflight.lastAttemptAt,
      inflight.attemptCount,
      claim.expiresAt,
    );
    if (typeof effectiveDue !== 'string') fail();
    assertCanonicalIso(effectiveDue);

    const waitRow = buildRetryWaitRow(
      inflight,
      effectiveDue,
      { kind: 'unknown', detail: 'uncertain-network' },
      claim.claimId,
      claim.expiresAt,
    );
    await publishLifecycle(deps, dataDir, waitRow);

    return publicReceipt({
      status: 'retry-scheduled',
      streamId: claim.streamId,
      sequence: claim.sequence,
      attemptCount: /** @type {number} */ (inflight.attemptCount),
      nextAttemptAt: effectiveDue,
      pendingCount,
      detail: 'uncertain-network',
    });
  }

  // Task 6 terminal / attempts-exhausted decisions: fail closed, no DLQ/ack.
  // Open in-flight may already be durable (stage-specific causality).
  fail();
}

/**
 * Production adapters: real claim/complete/release, lifecycle under shared
 * write lease, outbox/claim-state/DLQ, detailed HTTPS executor, pure policy.
 *
 * @returns {Record<string, Function>}
 */
function createProductionDeps() {
  return {
    authorizeDestination() {
      // Overridden per-tick with policy.authorize.
      fail();
    },
    claimDelivery: claimAuditIntegrityAlertDelivery,
    completeDelivery: completeAuditIntegrityAlertDelivery,
    releaseDelivery: releaseAuditIntegrityAlertDelivery,
    async loadLifecycle(dataDir) {
      return loadAuditIntegrityAlertDeliveryLifecycle(dataDir);
    },
    async publishLifecycle(dataDir, state) {
      const resolvedRoot = await assertSafeDataRoot(dataDir);
      return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) =>
        publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          dataDir,
          lease,
          state,
        ),
      );
    },
    async readOutbox(dataDir) {
      return readAuditIntegrityAlertOutbox(dataDir);
    },
    async loadClaimState(dataDir) {
      const resolvedRoot = await assertSafeDataRoot(dataDir);
      return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) =>
        loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease),
      );
    },
    async readDeadLetter(dataDir) {
      return readAuditIntegrityAlertDeadLetter(dataDir);
    },
    async appendDeadLetter(dataDir, entry) {
      const resolvedRoot = await assertSafeDataRoot(dataDir);
      return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) =>
        appendAuditIntegrityAlertDeadLetterUnderLease(dataDir, lease, entry),
      );
    },
    executeRequestDetailed: executeAuditIntegrityAlertHttpsRequestDetailed,
    computeRetryDue: computeAuditIntegrityAlertRetryDueAt,
    computeUncertainDue: computeAuditIntegrityAlertUncertainDueAt,
    classifyRetryDecision: classifyAuditIntegrityAlertRetryDecision,
  };
}

/**
 * Production tick: authorize-before-claim using the already-compiled policy
 * capability, then advance at most one unit of work.
 *
 * @param {unknown} dataDir
 * @param {unknown} endpoint
 * @param {unknown} now
 * @param {unknown} policy already-compiled destination allowlist capability
 * @returns {Promise<Readonly<object>>}
 */
export async function tickAuditIntegrityAlertDelivery(
  dataDir,
  endpoint,
  now,
  policy,
) {
  try {
    if (policy === null || typeof policy !== 'object') fail();
    if (utilTypes.isProxy(policy)) fail();
    const authorize = /** @type {{ authorize?: unknown }} */ (policy).authorize;
    if (typeof authorize !== 'function') fail();

    const deps = createProductionDeps();
    deps.authorizeDestination = /** @type {Function} */ (authorize);
    const tick = createTick(deps);
    return await tick(dataDir, endpoint, now);
  } catch {
    throw unavailableError();
  }
}

/**
 * Test-only factory. deps must be a plain non-Proxy data object with exact
 * ordered §5.5 keys (all functions). Snapshots the fourteen functions; later
 * mutation of deps cannot rebind the returned tick. Never invokes Proxy or
 * accessor traps on hostile deps.
 *
 * Returned tick is called as tick(dataDir, endpoint, now).
 *
 * @param {unknown} deps
 * @returns {(dataDir: unknown, endpoint: unknown, now: unknown) => Promise<Readonly<object>>}
 */
export function createAuditIntegrityAlertDeliveryRetryForTesting(deps) {
  try {
    const bound = bindDeps(deps);
    return createTick(bound);
  } catch {
    throw unavailableError();
  }
}
