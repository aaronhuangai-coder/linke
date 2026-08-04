/**
 * One-shot claim-to-HTTPS delivery coordinator.
 *
 * Owns the bounded policy: claim → execute → complete/release for a single
 * local attempt. Returns only deeply frozen sanitized public receipts, or the
 * fixed path-free audit-delivery-unavailable error.
 *
 * No direct network, timers, wall-clock reads, filesystem access, outbox or
 * stream state, or host-surface wiring. Durable claim and transport settle
 * through injected dependencies; production binds the real claim coordinator
 * and HTTPS executor.
 */

import { types as utilTypes } from 'node:util';

import {
  claimAuditIntegrityAlertDelivery,
  completeAuditIntegrityAlertDelivery,
  releaseAuditIntegrityAlertDelivery,
} from './audit-integrity-alert-delivery-claim.js';
import { executeAuditIntegrityAlertHttpsRequest } from './audit-integrity-alert-https-transport.js';
import { ERROR_CODES, LinkeError } from './error-codes.js';

const DEPS_KEYS = Object.freeze([
  'claimDelivery',
  'executeRequest',
  'completeDelivery',
  'releaseDelivery',
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

const TRANSPORT_RESULT_KEYS = Object.freeze(['schemaVersion', 'status']);

const COMPLETE_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'completed',
  'streamId',
  'sequence',
  'pendingCount',
]);

const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
 * Canonical millisecond UTC ISO-8601 timestamp.
 *
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
 * Exact dependency object for the test factory / internal binder.
 *
 * @param {unknown} deps
 * @returns {{
 *   claimDelivery: Function,
 *   executeRequest: Function,
 *   completeDelivery: Function,
 *   releaseDelivery: Function,
 * }}
 */
function bindDeps(deps) {
  assertPlainDataObject(deps);
  assertExactKeyOrder(deps, DEPS_KEYS);
  const record = /** @type {Record<string, unknown>} */ (deps);
  if (typeof record.claimDelivery !== 'function') fail();
  if (typeof record.executeRequest !== 'function') fail();
  if (typeof record.completeDelivery !== 'function') fail();
  if (typeof record.releaseDelivery !== 'function') fail();
  // Snapshot function references so later mutation of the deps object cannot
  // rebind this deliver instance (and never the production export).
  return {
    claimDelivery: /** @type {Function} */ (record.claimDelivery),
    executeRequest: /** @type {Function} */ (record.executeRequest),
    completeDelivery: /** @type {Function} */ (record.completeDelivery),
    releaseDelivery: /** @type {Function} */ (record.releaseDelivery),
  };
}

/**
 * Validate a claim coordinator receipt and classify the branch.
 *
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
    // Request is opaque to this coordinator and is handed to execute as-is.
    // Absence is fail-closed before any transport or complete/release call.
    if (record.request === null || record.request === undefined) fail();
    // expiresAt is validated for shape but not exposed on public receipts.
    assertCanonicalIso(record.expiresAt);
    return {
      kind: 'claimed',
      claimId: assertUuidV4(record.claimId),
      streamId: assertUuidV4(record.streamId),
      sequence: assertPositiveSafeInteger(record.sequence),
      request: record.request,
    };
  }

  fail();
}

/**
 * Exact transport settlement: accepted or rejected only.
 *
 * @param {unknown} value
 * @returns {{ status: 'accepted' | 'rejected' }}
 */
function parseTransportResult(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, TRANSPORT_RESULT_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (record.schemaVersion !== 1) fail();
  if (record.status === 'accepted' || record.status === 'rejected') {
    return { status: record.status };
  }
  fail();
}

/**
 * Exact complete coordinator receipt.
 *
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
 * Public empty receipt — no claimId, request, or capability fields.
 *
 * @returns {Readonly<object>}
 */
function emptyPublicReceipt() {
  return deepFreeze({
    schemaVersion: 1,
    status: 'empty',
    delivered: false,
  });
}

/**
 * Public busy receipt — sanitized; no claimId or request.
 *
 * @param {{ streamId: string, sequence: number, expiresAt: string }} busy
 * @returns {Readonly<object>}
 */
function busyPublicReceipt(busy) {
  return deepFreeze({
    schemaVersion: 1,
    status: 'busy',
    delivered: false,
    streamId: busy.streamId,
    sequence: busy.sequence,
    expiresAt: busy.expiresAt,
  });
}

/**
 * Public delivered receipt — sanitized; no claimId or request.
 *
 * @param {{
 *   status: 'completed' | 'already-completed',
 *   streamId: string,
 *   sequence: number,
 *   pendingCount: number,
 * }} completed
 * @returns {Readonly<object>}
 */
function deliveredPublicReceipt(completed) {
  return deepFreeze({
    schemaVersion: 1,
    status: 'delivered',
    delivered: true,
    streamId: completed.streamId,
    sequence: completed.sequence,
    pendingCount: completed.pendingCount,
    completionStatus: completed.status,
  });
}

/**
 * Build the exact claim capability passed to complete/release.
 * Only {claimId, streamId, sequence} — never request, expiresAt, or status.
 *
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
 * Core one-shot policy bound to dependency functions.
 *
 * Branch rules:
 * - empty/busy → sanitized receipt; zero execute/complete/release
 * - claimed + accepted → execute once, complete once, never release
 * - claimed + rejected → release once, never complete, then unavailable
 * - execute throw / malformed transport → uncertain; never complete/release
 * - complete throw after accepted → never release; unavailable
 * - release throw after rejected → never complete; unavailable
 *
 * @param {{
 *   claimDelivery: Function,
 *   executeRequest: Function,
 *   completeDelivery: Function,
 *   releaseDelivery: Function,
 * }} deps
 * @returns {(dataDir: unknown, endpoint: unknown, now: unknown) => Promise<Readonly<object>>}
 */
function createDeliver(deps) {
  return async function deliverOnce(dataDir, endpoint, now) {
    try {
      const claim = parseClaimReceipt(
        await deps.claimDelivery(dataDir, endpoint, now),
      );

      if (claim.kind === 'empty') {
        return emptyPublicReceipt();
      }
      if (claim.kind === 'busy') {
        return busyPublicReceipt(claim);
      }

      // claimed: derive exact capability before any transport settlement.
      const capability = exactCapability(claim);

      const transport = parseTransportResult(
        await deps.executeRequest(claim.request),
      );

      if (transport.status === 'accepted') {
        // Verified 2xx: complete exactly once. Never release on this branch,
        // even when completion fails (at-least-once / residual recovery).
        const completed = parseCompleteReceipt(
          await deps.completeDelivery(dataDir, capability),
        );
        return deliveredPublicReceipt(completed);
      }

      // Explicit rejected non-2xx: release once, never complete, then fail.
      await deps.releaseDelivery(dataDir, capability);
      fail();
    } catch {
      // Collapse every failure (including already-fixed LinkeError) to a fresh
      // path-free unavailable error so raw causes never escape the boundary.
      throw unavailableError();
    }
  };
}

/** Production deps: real claim coordinator + production HTTPS executor. */
const PRODUCTION_DEPS = {
  claimDelivery: claimAuditIntegrityAlertDelivery,
  executeRequest: executeAuditIntegrityAlertHttpsRequest,
  completeDelivery: completeAuditIntegrityAlertDelivery,
  releaseDelivery: releaseAuditIntegrityAlertDelivery,
};

const productionDeliver = createDeliver(PRODUCTION_DEPS);

/**
 * Production one-shot delivery: claim local head, attempt one HTTPS settlement,
 * then complete or release per accepted/rejected policy.
 *
 * @param {unknown} dataDir
 * @param {unknown} endpoint
 * @param {unknown} now
 * @returns {Promise<Readonly<object>>}
 */
export async function deliverAuditIntegrityAlertOnce(dataDir, endpoint, now) {
  return productionDeliver(dataDir, endpoint, now);
}

/**
 * Test-only factory. deps must be a plain object with exact ordered keys
 * claimDelivery, executeRequest, completeDelivery, releaseDelivery (all functions).
 * Snapshots the four functions; cannot mutate the production binding.
 *
 * @param {unknown} deps
 * @returns {(dataDir: unknown, endpoint: unknown, now: unknown) => Promise<Readonly<object>>}
 */
export function createAuditIntegrityAlertDeliveryOnceForTesting(deps) {
  try {
    return createDeliver(bindDeps(deps));
  } catch {
    throw unavailableError();
  }
}
