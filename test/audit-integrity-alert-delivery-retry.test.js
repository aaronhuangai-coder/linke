/**
 * Task 5 RED — explicit durable retry tick coordinator (non-DLQ paths).
 * Authority:
 *   .superpowers/sdd/2026-08-05-audit-integrity-alert-durable-retry-plan/task-5-brief.md
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md
 *     (§5.5 deps, §8 paths, §13 public receipts)
 *
 * Production (must remain absent on this RED HEAD):
 *   src/audit-integrity-alert-delivery-retry.js
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   test name + assert message = `durable retry tick implementation missing`
 * Full matrix registers only when both public exports exist.
 *
 * Pure injected factory deps only (authorize / claim / lifecycle / outbox /
 * claim-state / DLQ / detailed executor / pure due+classify). No real network,
 * scheduler, agent/server/web, or overlapping-tick integration (Task 7).
 * Terminal dead-letter success receipts are Task 6 — this suite requires
 * fail-closed on terminal decisions, never green `dead-lettered`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { buildAuditIntegrityAlertDeliveryRequest } from '../src/audit-integrity-alert-delivery.js';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-retry.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);
const PRODUCTION_MODULE_MARKER = 'audit-integrity-alert-delivery-retry';

const MISSING_MSG = 'durable retry tick implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

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

/** Exact public receipt top keys (§13.2). */
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

const CLOSED_RECEIPT_STATUSES = Object.freeze([
  'idle',
  'empty',
  'not-due',
  'busy',
  'delivered',
  'retry-scheduled',
  'dead-lettered',
  'blocked',
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
const CAPABILITY_KEYS = Object.freeze(['claimId', 'streamId', 'sequence']);
const DETAILED_RESULT_KEYS = Object.freeze(['schemaVersion', 'kind']);
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
const DLQ_SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'entryCount',
  'nextSequence',
  'entries',
]);

const DATA_DIR = '/safe/secret-data-dir-delivery-retry';
const ENDPOINT = 'https://alerts.acme.com/hooks/audit-integrity';
const SECRET_TOKEN = 'Bearer secret-token-xyz-999';
const SECRET_PATH = '/Users/ah/secret/delivery-retry.json';
const SECRET_HOST = 'evil-retry.acme.com';
const SECRET_IP = '203.0.113.77';
const SECRET_BODY = '{"body-secret":"do-not-leak"}';

const STREAM_ID = 'b2222222-c222-4222-9222-f22222222222';
const CLAIM_ID = 'a1111111-b111-4111-8111-e11111111111';
const CLAIM_ID_B = 'd4444444-e444-4444-8444-f44444444444';
const ATTEMPT_ID_1 = 'c3333333-d333-4333-a333-033333333333';
const ATTEMPT_ID_2 = 'e5555555-f555-4555-9555-155555555555';
const SEQUENCE = 1;

const FIXED_NOW = '2026-08-05T12:00:00.000Z';
const FIXED_CHECKED_AT = '2026-08-05T11:59:00.000Z';
const CLAIM_EXPIRES_AT = '2026-08-05T12:02:00.000Z';
const WATERMARK = '2026-08-05T11:00:00.000Z';

/**
 * Hand-checked backoff table from design §8.3 for lastAttemptAt=FIXED_NOW.
 * attemptCountAfterFailure 1..7 → nextAttemptAt.
 */
const BACKOFF_DUE_BY_ATTEMPT = Object.freeze({
  1: '2026-08-05T12:00:30.000Z',
  2: '2026-08-05T12:02:00.000Z',
  3: '2026-08-05T12:10:00.000Z',
  4: '2026-08-05T12:30:00.000Z',
  5: '2026-08-05T14:00:00.000Z',
  6: '2026-08-05T20:00:00.000Z',
  7: '2026-08-06T12:00:00.000Z',
});

/** Hand-checked max(backoffDue attempt1, CLAIM_EXPIRES_AT). */
const UNCERTAIN_DUE_ATTEMPT_1 = CLAIM_EXPIRES_AT; // max(12:00:30Z, 12:02:00Z)

const IDEMPOTENCY_KEY = `audit-integrity-alert:${STREAM_ID}:${SEQUENCE}`;

const FORBIDDEN_RECEIPT_FIELDS = Object.freeze([
  'claimId',
  'attemptId',
  'endpoint',
  'url',
  'headers',
  'body',
  'request',
  'response',
  'statusCode',
  'token',
  'authorization',
  'error',
  'errno',
  'deadLetter',
  'sha256',
]);

/**
 * @typedef {{
 *   tickAuditIntegrityAlertDelivery: Function,
 *   createAuditIntegrityAlertDeliveryRetryForTesting: Function,
 * }} RetryApi
 */

/** @type {null | RetryApi} */
let retryApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.tickAuditIntegrityAlertDelivery === 'function'
    && typeof mod.createAuditIntegrityAlertDeliveryRetryForTesting === 'function'
  ) {
    retryApi = {
      tickAuditIntegrityAlertDelivery: mod.tickAuditIntegrityAlertDelivery,
      createAuditIntegrityAlertDeliveryRetryForTesting:
        mod.createAuditIntegrityAlertDeliveryRetryForTesting,
    };
    implementationMissing = false;
  }
} catch (error) {
  // Swallow only target-module not-found. Never hide syntax/load/runtime errors.
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  const message = String(
    error && typeof error === 'object' && 'message' in error
      ? /** @type {{ message?: unknown }} */ (error).message
      : error,
  );
  const url = String(
    error && typeof error === 'object' && 'url' in error
      ? /** @type {{ url?: unknown }} */ (error).url
      : '',
  );
  const targetsTargetModule = message.includes(PRODUCTION_MODULE_MARKER)
    || url.includes(PRODUCTION_MODULE_MARKER)
    || message.includes(PRODUCTION_MODULE_PATH)
    || url.includes(PRODUCTION_MODULE_PATH);
  if (!targetsTargetModule) {
    throw error;
  }
  implementationMissing = true;
  retryApi = null;
}

/**
 * @returns {RetryApi}
 */
function requireApi() {
  if (implementationMissing || retryApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {RetryApi} */ (retryApi);
}

// ─── Exact-key / freeze / error helpers ───────────────────────────────────

/**
 * @param {unknown} obj
 * @param {readonly string[]} expected
 * @param {string} [label]
 */
function assertExactKeys(obj, expected, label = 'value') {
  assert.deepEqual(
    Object.keys(/** @type {object} */ (obj)),
    [...expected],
    `${label} must have exact key order ${expected.join(',')}`,
  );
}

/**
 * @param {unknown} value
 * @param {string} [path]
 */
function assertDeeplyFrozen(value, path = 'root') {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `expected frozen at ${path}`);
  for (const key of Object.keys(/** @type {object} */ (value))) {
    assertDeeplyFrozen(
      /** @type {Record<string, unknown>} */ (value)[key],
      `${path}.${key}`,
    );
  }
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
 * @param {unknown} error
 * @param {string[]} [leakTokens]
 */
function assertUnavailable(error, leakTokens = []) {
  assert.equal(error && /** @type {{ name?: string }} */ (error).name, 'LinkeError');
  assert.equal(error && /** @type {{ code?: string }} */ (error).code, CODE_UNAVAILABLE);
  assert.equal(
    error && /** @type {{ message?: string }} */ (error).message,
    CODE_UNAVAILABLE,
  );
  assert.equal(
    /** @type {{ message: string }} */ (error).message,
    /** @type {{ code: string }} */ (error).code,
  );
  assert.equal(/** @type {{ cause?: unknown }} */ (error).cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(/** @type {object} */ (error), 'cause'));

  const publicParts = [
    /** @type {{ name: string }} */ (error).name,
    /** @type {{ code: string }} */ (error).code,
    /** @type {{ message: string }} */ (error).message,
    String(/** @type {{ statusCode?: unknown }} */ (error).statusCode),
    String(/** @type {{ retryable?: unknown }} */ (error).retryable),
    ...Object.keys(/** @type {object} */ (error))
      .filter((key) => key !== 'stack')
      .map((key) => String(/** @type {Record<string, unknown>} */ (error)[key])),
  ].join('\0');

  for (const token of [
    ENDPOINT,
    DATA_DIR,
    SECRET_TOKEN,
    SECRET_PATH,
    SECRET_HOST,
    SECRET_IP,
    SECRET_BODY,
    CLAIM_ID,
    ATTEMPT_ID_1,
    IDEMPOTENCY_KEY,
    'authorization',
    'Bearer',
    'claimId',
    'attemptId',
    'statusCode',
    'ENOENT',
    'ECONNRESET',
    '/Users/',
    '/var/',
    '/private/',
    '/tmp/',
    'alerts.acme.com',
    ...leakTokens,
  ]) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `public error must not leak ${token}`);
  }
  return true;
}

/**
 * @param {() => unknown} fn
 * @param {string[]} [leakTokens]
 */
function expectUnavailable(fn, leakTokens = []) {
  assert.throws(fn, (error) => {
    assertUnavailable(error, leakTokens);
    return true;
  });
}

/**
 * @param {Promise<unknown>} promise
 * @param {string[]} [leakTokens]
 */
async function expectUnavailableAsync(promise, leakTokens = []) {
  await assert.rejects(promise, (error) => {
    assertUnavailable(error, leakTokens);
    return true;
  });
}

/**
 * Receipts: exact keys, deep freeze, no capability/endpoint/body/IP/path.
 * @param {unknown} receipt
 * @param {string[]} [extraLeakTokens]
 */
function assertPublicReceiptSanitized(receipt, extraLeakTokens = []) {
  assert.equal(typeof receipt, 'object');
  assert.notEqual(receipt, null);
  assertExactKeys(receipt, RECEIPT_KEYS, 'public receipt');
  assertDeeplyFrozen(receipt);

  const r = /** @type {Record<string, unknown>} */ (receipt);
  assert.equal(r.schemaVersion, 1);
  assert.equal(CLOSED_RECEIPT_STATUSES.includes(/** @type {string} */ (r.status)), true);

  for (const field of FORBIDDEN_RECEIPT_FIELDS) {
    assert.equal(
      Object.hasOwn(r, field),
      false,
      `receipt must not expose forbidden field ${field}`,
    );
  }

  const text = JSON.stringify(receipt);
  for (const token of [
    'claimId',
    'attemptId',
    ENDPOINT,
    SECRET_TOKEN,
    SECRET_PATH,
    SECRET_HOST,
    SECRET_IP,
    SECRET_BODY,
    'authorization',
    'content-type',
    'statusCode',
    'Bearer',
    'alerts.acme.com',
    '/Users/',
    '/var/',
    '/private/',
    '/tmp/',
    IDEMPOTENCY_KEY,
    CLAIM_ID,
    ATTEMPT_ID_1,
    ...extraLeakTokens,
  ]) {
    if (!token || token.length < 2) continue;
    assert.equal(text.includes(token), false, `receipt must not contain ${token}`);
  }
}

/**
 * @param {unknown} receipt
 * @param {{
 *   status: string,
 *   streamId: string | null,
 *   sequence: number | null,
 *   attemptCount: number | null,
 *   nextAttemptAt: string | null,
 *   pendingCount: number | null,
 *   detail: string | null,
 * }} expected
 */
function assertExactReceipt(receipt, expected) {
  assertPublicReceiptSanitized(receipt);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    status: expected.status,
    streamId: expected.streamId,
    sequence: expected.sequence,
    attemptCount: expected.attemptCount,
    nextAttemptAt: expected.nextAttemptAt,
    pendingCount: expected.pendingCount,
    detail: expected.detail,
  });
}

// ─── Canonical fixtures (real shapes; hand-checked expectations) ──────────

/**
 * @param {number} sequence
 * @param {object} [overrides]
 */
function headEntry(sequence = SEQUENCE, overrides = {}) {
  return {
    sequence,
    checkedAt: FIXED_CHECKED_AT,
    code: 'uninitialized',
    recoveryRequired: false,
    nextAction: 'initialize-via-production-write',
    reasonCode: null,
    ...overrides,
  };
}

/**
 * @param {number} sequence
 * @param {string} [streamId]
 */
function canonicalRequest(sequence = SEQUENCE, streamId = STREAM_ID) {
  return buildAuditIntegrityAlertDeliveryRequest(
    ENDPOINT,
    streamId,
    headEntry(sequence),
  );
}

/**
 * @param {string | null} [lastObservedAt]
 */
function idleLifecycle(lastObservedAt = null) {
  return deepFreeze({
    schemaVersion: 1,
    status: 'idle',
    lastObservedAt,
    streamId: null,
    sequence: null,
    idempotencyKey: null,
    attemptId: null,
    attemptCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    claimId: null,
    claimExpiresAt: null,
    outcome: null,
    deadLetter: null,
  });
}

/**
 * Open in-flight lifecycle row (outcome null, nextAttemptAt null, claim V).
 * @param {object} [fields]
 */
function inFlightLifecycle(fields = {}) {
  const attemptCount = fields.attemptCount ?? 1;
  const attemptId = fields.attemptId ?? ATTEMPT_ID_1;
  const lastAttemptAt = fields.lastAttemptAt ?? FIXED_NOW;
  const firstAttemptAt = fields.firstAttemptAt ?? lastAttemptAt;
  return deepFreeze({
    schemaVersion: 1,
    status: 'in-flight',
    lastObservedAt: fields.lastObservedAt ?? FIXED_NOW,
    streamId: fields.streamId ?? STREAM_ID,
    sequence: fields.sequence ?? SEQUENCE,
    idempotencyKey: fields.idempotencyKey
      ?? `audit-integrity-alert:${fields.streamId ?? STREAM_ID}:${fields.sequence ?? SEQUENCE}`,
    attemptId,
    attemptCount,
    firstAttemptAt,
    lastAttemptAt,
    nextAttemptAt: null,
    claimId: fields.claimId ?? CLAIM_ID,
    claimExpiresAt: fields.claimExpiresAt ?? CLAIM_EXPIRES_AT,
    outcome: null,
    deadLetter: null,
  });
}

/**
 * @param {'unknown' | 'retryable-rejected'} kind
 * @param {object} [fields]
 */
function retryWaitLifecycle(kind, fields = {}) {
  const detail = fields.detail !== undefined
    ? fields.detail
    : (kind === 'unknown'
      ? (fields.detailExplicit === 'null' ? null : 'uncertain-network')
      : 'retryable-http');
  const claimId = Object.prototype.hasOwnProperty.call(fields, 'claimId')
    ? fields.claimId
    : CLAIM_ID;
  const claimExpiresAt = Object.prototype.hasOwnProperty.call(fields, 'claimExpiresAt')
    ? fields.claimExpiresAt
    : CLAIM_EXPIRES_AT;
  return deepFreeze({
    schemaVersion: 1,
    status: 'retry-wait',
    lastObservedAt: fields.lastObservedAt ?? FIXED_NOW,
    streamId: fields.streamId ?? STREAM_ID,
    sequence: fields.sequence ?? SEQUENCE,
    idempotencyKey: fields.idempotencyKey ?? IDEMPOTENCY_KEY,
    attemptId: fields.attemptId ?? ATTEMPT_ID_1,
    attemptCount: fields.attemptCount ?? 1,
    firstAttemptAt: fields.firstAttemptAt ?? FIXED_NOW,
    lastAttemptAt: fields.lastAttemptAt ?? FIXED_NOW,
    nextAttemptAt: fields.nextAttemptAt ?? BACKOFF_DUE_BY_ATTEMPT[1],
    claimId,
    claimExpiresAt,
    outcome: deepFreeze({ kind, detail }),
    deadLetter: null,
  });
}

/**
 * @param {object} [fields]
 */
function acceptedPendingLifecycle(fields = {}) {
  return deepFreeze({
    schemaVersion: 1,
    status: 'accepted-pending-completion',
    lastObservedAt: fields.lastObservedAt ?? FIXED_NOW,
    streamId: fields.streamId ?? STREAM_ID,
    sequence: fields.sequence ?? SEQUENCE,
    idempotencyKey: fields.idempotencyKey ?? IDEMPOTENCY_KEY,
    attemptId: fields.attemptId ?? ATTEMPT_ID_1,
    attemptCount: fields.attemptCount ?? 1,
    firstAttemptAt: fields.firstAttemptAt ?? FIXED_NOW,
    lastAttemptAt: fields.lastAttemptAt ?? FIXED_NOW,
    nextAttemptAt: null,
    claimId: fields.claimId ?? CLAIM_ID,
    claimExpiresAt: fields.claimExpiresAt ?? CLAIM_EXPIRES_AT,
    outcome: deepFreeze({ kind: 'accepted', detail: null }),
    deadLetter: null,
  });
}

/**
 * @param {object[]} entries
 * @param {number} [nextSequence]
 */
function outboxSnapshot(entries, nextSequence) {
  const next = nextSequence ?? (
    entries.length === 0
      ? 1
      : Math.max(...entries.map((e) => e.sequence)) + 1
  );
  return deepFreeze({
    schemaVersion: 1,
    nextSequence: next,
    entries: entries.map((e) => {
      assertExactKeys(e, OUTBOX_ENTRY_KEYS, 'outbox entry fixture');
      return { ...e };
    }),
  });
}

function emptyOutbox() {
  return outboxSnapshot([], 1);
}

/**
 * Head sequence 1 plus two successors (2,3) — complete pendingCount must be 2.
 */
function outboxHeadPlusTwoSuccessors() {
  return outboxSnapshot([
    headEntry(1),
    headEntry(2),
    headEntry(3),
  ], 4);
}

function outboxSingleHead() {
  return outboxSnapshot([headEntry(1)], 2);
}

/**
 * @param {'empty' | 'busy' | 'claimed'} status
 * @param {object} [fields]
 */
function claimFixture(status, fields = {}) {
  if (status === 'empty') {
    return deepFreeze({
      schemaVersion: 1,
      status: 'empty',
      claimId: null,
      streamId: null,
      sequence: null,
      expiresAt: null,
      request: null,
    });
  }
  if (status === 'busy') {
    return deepFreeze({
      schemaVersion: 1,
      status: 'busy',
      claimId: null,
      streamId: fields.streamId ?? STREAM_ID,
      sequence: fields.sequence ?? SEQUENCE,
      expiresAt: fields.expiresAt ?? CLAIM_EXPIRES_AT,
      request: null,
    });
  }
  const streamId = fields.streamId ?? STREAM_ID;
  const sequence = fields.sequence ?? SEQUENCE;
  const request = fields.request ?? canonicalRequest(sequence, streamId);
  return deepFreeze({
    schemaVersion: 1,
    status: 'claimed',
    claimId: fields.claimId ?? CLAIM_ID,
    streamId,
    sequence,
    expiresAt: fields.expiresAt ?? CLAIM_EXPIRES_AT,
    request,
  });
}

/**
 * @param {'completed' | 'already-completed'} status
 * @param {object} [fields]
 */
function completeFixture(status, fields = {}) {
  return deepFreeze({
    schemaVersion: 1,
    status,
    completed: true,
    streamId: fields.streamId ?? STREAM_ID,
    sequence: fields.sequence ?? SEQUENCE,
    pendingCount: fields.pendingCount ?? 0,
  });
}

/**
 * @param {object} [fields]
 */
function releaseFixture(fields = {}) {
  return deepFreeze({
    schemaVersion: 1,
    status: 'released',
    released: true,
    streamId: fields.streamId ?? STREAM_ID,
    sequence: fields.sequence ?? SEQUENCE,
  });
}

/**
 * @param {'accepted' | 'retryable-rejected' | 'terminal-rejected'} kind
 */
function detailedResult(kind) {
  return deepFreeze({ schemaVersion: 1, kind });
}

function idleClaimState() {
  return deepFreeze({
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
  });
}

/**
 * @param {object} [fields]
 */
function claimedClaimState(fields = {}) {
  return deepFreeze({
    schemaVersion: 1,
    status: 'claimed',
    claimId: fields.claimId ?? CLAIM_ID,
    streamId: fields.streamId ?? STREAM_ID,
    sequence: fields.sequence ?? SEQUENCE,
    ownerPid: fields.ownerPid ?? 4242,
    bootSessionIdentity: deepFreeze({ available: true, value: 'boot-session-a' }),
    processStartIdentity: deepFreeze({ available: true, value: 'process-start-a' }),
    claimedAt: fields.claimedAt ?? FIXED_NOW,
    expiresAt: fields.expiresAt ?? CLAIM_EXPIRES_AT,
  });
}

function emptyDeadLetter() {
  return deepFreeze({
    schemaVersion: 1,
    status: 'ok',
    entryCount: 0,
    nextSequence: 1,
    entries: [],
  });
}

function unavailableError() {
  return new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
}

/**
 * Independent pure classify oracle (not production under test).
 * @param {number} attemptCount
 * @param {string} kind
 */
function oracleClassify(attemptCount, kind) {
  if (kind === 'accepted') return 'accept-complete';
  if (kind === 'terminal-rejected') return 'dead-letter-terminal-http';
  if (kind === 'retryable-rejected') {
    return attemptCount >= 8
      ? 'dead-letter-attempts-exhausted-retryable'
      : 'retry-wait';
  }
  if (kind === 'uncertain') {
    return attemptCount >= 8
      ? 'dead-letter-attempts-exhausted-uncertain'
      : 'uncertain-hold';
  }
  return 'fail-closed';
}

/**
 * Independent pure retry-due oracle using hand-checked table for FIXED_NOW.
 * @param {string} lastAttemptAt
 * @param {number} attemptCountAfterFailure
 */
function oracleRetryDue(lastAttemptAt, attemptCountAfterFailure) {
  assert.equal(lastAttemptAt, FIXED_NOW, 'fixture lastAttemptAt must be FIXED_NOW for table');
  const due = BACKOFF_DUE_BY_ATTEMPT[attemptCountAfterFailure];
  assert.equal(typeof due, 'string', `missing hand-checked backoff for attempt ${attemptCountAfterFailure}`);
  return due;
}

/**
 * @param {string} lastAttemptAt
 * @param {number} attemptCountAfterFailure
 * @param {string} claimExpiresAt
 */
function oracleUncertainDue(lastAttemptAt, attemptCountAfterFailure, claimExpiresAt) {
  const backoffDue = oracleRetryDue(lastAttemptAt, attemptCountAfterFailure);
  return backoffDue >= claimExpiresAt ? backoffDue : claimExpiresAt;
}

// ─── Injected harness ─────────────────────────────────────────────────────

/**
 * Counting pure-deps harness with durable in-memory lifecycle/outbox/claim.
 * @param {{
 *   authorize?: (endpoint: unknown) => string,
 *   claim?: object | Error | (() => object | Promise<object> | Error),
 *   complete?: object | Error | (() => object | Promise<object>),
 *   release?: object | Error | (() => object | Promise<object>),
 *   lifecycle?: object | (() => object),
 *   outbox?: object | (() => object),
 *   claimState?: object | (() => object),
 *   deadLetter?: object | (() => object),
 *   detailed?: object | Error | (() => object | Promise<object>),
 *   onPublish?: (row: object, meta: { callIndex: number }) => void | Promise<void>,
 *   failPublishWhen?: (row: object) => boolean,
 *   afterCompleteReadOutbox?: boolean,
 * }} [script]
 */
function createHarness(script = {}) {
  /** @type {string[]} */
  const order = [];
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(DEPS_KEYS.map((k) => [k, 0]));
  /** @type {unknown[][]} */
  const argsLog = [];
  /** @type {object[]} */
  const published = [];
  /** @type {object[]} */
  const lifecycleSnapshots = [];

  // Do not eagerly invoke function scripts at harness construction — authorize
  // gates and multi-tick outer state must control first observation.
  let lifecycle = typeof script.lifecycle === 'function'
    ? idleLifecycle()
    : (script.lifecycle ?? idleLifecycle());
  let outbox = typeof script.outbox === 'function'
    ? emptyOutbox()
    : (script.outbox ?? emptyOutbox());
  let claimState = typeof script.claimState === 'function'
    ? idleClaimState()
    : (script.claimState ?? idleClaimState());
  let deadLetter = typeof script.deadLetter === 'function'
    ? emptyDeadLetter()
    : (script.deadLetter ?? emptyDeadLetter());

  let postCompleteOutboxReads = 0;
  let completeSucceeded = false;

  /**
   * @param {unknown} value
   * @param {string} label
   */
  async function resolveScript(value, label) {
    if (value instanceof Error) throw value;
    if (typeof value === 'function') {
      const result = await value();
      if (result instanceof Error) throw result;
      return result;
    }
    if (value === undefined) {
      throw new Error(`test harness missing script for ${label}`);
    }
    return value;
  }

  /**
   * @param {string} name
   * @param {unknown[]} args
   */
  function record(name, args) {
    counts[name] += 1;
    order.push(name);
    argsLog.push([name, ...args]);
  }

  const deps = {
    authorizeDestination(...args) {
      record('authorizeDestination', args);
      if (typeof script.authorize === 'function') {
        return script.authorize(args[0]);
      }
      // Success: bit-identical primitive endpoint sole argument.
      assert.equal(args.length, 1);
      assert.equal(typeof args[0], 'string');
      return args[0];
    },
    async claimDelivery(...args) {
      record('claimDelivery', args);
      return resolveScript(
        Object.prototype.hasOwnProperty.call(script, 'claim')
          ? script.claim
          : claimFixture('empty'),
        'claim',
      );
    },
    async completeDelivery(...args) {
      record('completeDelivery', args);
      const result = await resolveScript(
        Object.prototype.hasOwnProperty.call(script, 'complete')
          ? script.complete
          : completeFixture('completed', { pendingCount: 0 }),
        'complete',
      );
      completeSucceeded = true;
      return result;
    },
    async releaseDelivery(...args) {
      record('releaseDelivery', args);
      return resolveScript(
        Object.prototype.hasOwnProperty.call(script, 'release')
          ? script.release
          : releaseFixture(),
        'release',
      );
    },
    async loadLifecycle(...args) {
      record('loadLifecycle', args);
      if (typeof script.lifecycle === 'function') {
        lifecycle = script.lifecycle();
      }
      return lifecycle;
    },
    async publishLifecycle(...args) {
      record('publishLifecycle', args);
      const row = /** @type {object} */ (args[0] ?? args[args.length - 1]);
      // Accept either (row) or (dataDir, row) or (dataDir, lease, row) — record row object.
      let publishedRow = row;
      for (const a of args) {
        if (
          a
          && typeof a === 'object'
          && !Array.isArray(a)
          && Object.hasOwn(/** @type {object} */ (a), 'status')
          && Object.hasOwn(/** @type {object} */ (a), 'schemaVersion')
        ) {
          publishedRow = /** @type {object} */ (a);
          break;
        }
      }
      if (typeof script.failPublishWhen === 'function' && script.failPublishWhen(publishedRow)) {
        throw unavailableError();
      }
      if (typeof script.onPublish === 'function') {
        await script.onPublish(publishedRow, { callIndex: published.length });
      }
      const frozen = deepFreeze(JSON.parse(JSON.stringify(publishedRow)));
      published.push(frozen);
      lifecycleSnapshots.push(frozen);
      lifecycle = frozen;
      return frozen;
    },
    async readOutbox(...args) {
      record('readOutbox', args);
      if (completeSucceeded) {
        postCompleteOutboxReads += 1;
      }
      if (typeof script.outbox === 'function') {
        outbox = script.outbox();
      }
      return outbox;
    },
    async loadClaimState(...args) {
      record('loadClaimState', args);
      if (typeof script.claimState === 'function') {
        claimState = script.claimState();
      }
      return claimState;
    },
    async readDeadLetter(...args) {
      record('readDeadLetter', args);
      if (typeof script.deadLetter === 'function') {
        deadLetter = script.deadLetter();
      }
      return deadLetter;
    },
    async appendDeadLetter(...args) {
      record('appendDeadLetter', args);
      throw new Error('appendDeadLetter must not run in Task 5 non-DLQ paths');
    },
    async executeRequestDetailed(...args) {
      record('executeRequestDetailed', args);
      return resolveScript(
        Object.prototype.hasOwnProperty.call(script, 'detailed')
          ? script.detailed
          : detailedResult('accepted'),
        'detailed',
      );
    },
    computeRetryDue(...args) {
      record('computeRetryDue', args);
      const [lastAttemptAt, attemptCountAfterFailure] = args;
      return oracleRetryDue(
        /** @type {string} */ (lastAttemptAt),
        /** @type {number} */ (attemptCountAfterFailure),
      );
    },
    computeUncertainDue(...args) {
      record('computeUncertainDue', args);
      const [lastAttemptAt, attemptCountAfterFailure, claimExpiresAt] = args;
      return oracleUncertainDue(
        /** @type {string} */ (lastAttemptAt),
        /** @type {number} */ (attemptCountAfterFailure),
        /** @type {string} */ (claimExpiresAt),
      );
    },
    classifyRetryDecision(...args) {
      record('classifyRetryDecision', args);
      const [attemptCount, kind] = args;
      return oracleClassify(
        /** @type {number} */ (attemptCount),
        /** @type {string} */ (kind),
      );
    },
  };

  assertExactKeys(deps, DEPS_KEYS, 'harness deps');

  return {
    deps,
    order,
    counts,
    argsLog,
    published,
    get lifecycle() {
      return lifecycle;
    },
    set lifecycle(next) {
      lifecycle = next;
    },
    get outbox() {
      return outbox;
    },
    set outbox(next) {
      outbox = next;
    },
    get claimState() {
      return claimState;
    },
    set claimState(next) {
      claimState = next;
    },
    get postCompleteOutboxReads() {
      return postCompleteOutboxReads;
    },
    snapshotCounts() {
      return { ...counts };
    },
  };
}

/**
 * @param {RetryApi} api
 * @param {ReturnType<typeof createHarness>} harness
 */
function tickWith(api, harness) {
  return api.createAuditIntegrityAlertDeliveryRetryForTesting(harness.deps);
}

/**
 * @param {ReturnType<typeof createHarness>} harness
 * @param {string[]} names
 */
function countOf(harness, ...names) {
  return names.reduce((sum, n) => sum + harness.counts[n], 0);
}

/**
 * Zero durable mutation / network / claim after a pure gate.
 * @param {ReturnType<typeof createHarness>} harness
 */
function assertZeroDownstream(harness) {
  assert.equal(harness.counts.claimDelivery, 0);
  assert.equal(harness.counts.completeDelivery, 0);
  assert.equal(harness.counts.releaseDelivery, 0);
  assert.equal(harness.counts.publishLifecycle, 0);
  assert.equal(harness.counts.executeRequestDetailed, 0);
  assert.equal(harness.counts.appendDeadLetter, 0);
  assert.equal(harness.published.length, 0);
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('audit integrity alert delivery retry tick (Task 5 RED)', () => {
  // Old-HEAD: exactly one dedicated RED. Full matrix only when exports exist.
  if (implementationMissing || retryApi === null) {
    it('durable retry tick implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── 1. Exports, receipt shapes, factory deps hostility ─────────────────

  describe('1 exports, receipt shapes, deps closed hostile', () => {
    it('exports tick and test factory; registered fixed error code', () => {
      // Catch: missing public surface or wrong error registry code.
      const api = requireApi();
      assert.equal(typeof api.tickAuditIntegrityAlertDelivery, 'function');
      assert.equal(
        typeof api.createAuditIntegrityAlertDeliveryRetryForTesting,
        'function',
      );
      assert.equal(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, CODE_UNAVAILABLE);
    });

    it('factory returns async tick(dataDir, endpoint, now); empty receipt shape frozen', async () => {
      // Catch: wrong arity surface or empty receipt key/status/pendingCount drift.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(),
        outbox: emptyOutbox(),
        claim: claimFixture('empty'),
      });
      const tick = tickWith(api, harness);
      assert.equal(typeof tick, 'function');
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);
      assertExactReceipt(receipt, {
        status: 'empty',
        streamId: null,
        sequence: null,
        attemptCount: null,
        nextAttemptAt: null,
        pendingCount: 0,
        detail: null,
      });
    });

    it('factory rejects extra/missing/reordered/accessor/Proxy/non-function deps with zero effects', () => {
      // Catch: accepting hostile §5.5 key sets or non-functions that rebind later.
      const api = requireApi();
      const good = createHarness();
      let trapHits = 0;

      const trapProxy = new Proxy(good.deps, {
        get(_t, prop) {
          trapHits += 1;
          throw new Error(`trap-get:${String(prop)}:${SECRET_PATH}`);
        },
        ownKeys() {
          trapHits += 1;
          throw new Error(`trap-ownKeys:${SECRET_TOKEN}`);
        },
        getOwnPropertyDescriptor() {
          trapHits += 1;
          throw new Error(`trap-desc:${SECRET_HOST}`);
        },
        getPrototypeOf() {
          trapHits += 1;
          throw new Error(`trap-proto:${SECRET_IP}`);
        },
        has() {
          trapHits += 1;
          throw new Error(`trap-has:${SECRET_BODY}`);
        },
      });

      const { proxy: revokedProxy, revoke } = Proxy.revocable({ ...good.deps }, {});
      revoke();

      const accessorDeps = {};
      for (const key of DEPS_KEYS) {
        Object.defineProperty(accessorDeps, key, {
          enumerable: true,
          get() {
            trapHits += 1;
            throw new Error(`accessor:${key}:${SECRET_PATH}`);
          },
        });
      }

      const nonFunctionDeps = { ...good.deps, claimDelivery: 'not-a-function' };
      const extraKey = { ...good.deps, extra: () => {} };
      const missingKey = { ...good.deps };
      delete missingKey.appendDeadLetter;

      const reordered = {};
      const reversed = [...DEPS_KEYS].reverse();
      for (const key of reversed) {
        reordered[key] = good.deps[key];
      }

      class DepsClass {
        constructor() {
          for (const key of DEPS_KEYS) {
            this[key] = good.deps[key];
          }
        }
      }

      const withSymbol = { ...good.deps, [Symbol('leak')]: SECRET_PATH };
      const nonEnum = { ...good.deps };
      Object.defineProperty(nonEnum, 'hidden', {
        value: SECRET_TOKEN,
        enumerable: false,
      });

      const cases = [
        null,
        undefined,
        [],
        'deps',
        1,
        true,
        missingKey,
        extraKey,
        reordered,
        nonFunctionDeps,
        { ...good.deps, executeRequestDetailed: null },
        { ...good.deps, authorizeDestination: 1 },
        new Proxy(good.deps, {}),
        trapProxy,
        revokedProxy,
        accessorDeps,
        nonEnum,
        withSymbol,
        new DepsClass(),
      ];

      for (const deps of cases) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDeliveryRetryForTesting(deps),
          [SECRET_PATH, SECRET_TOKEN, SECRET_HOST, SECRET_IP, SECRET_BODY],
        );
      }
      assert.equal(trapHits, 0, 'hostile Proxy/accessor traps must never fire');
    });

    it('public receipts never expose claimId/attemptId/endpoint/body/IP/path and are deep-frozen', async () => {
      // Catch: privacy field leakage or shallow freeze on nested receipt values.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('accepted'),
        complete: completeFixture('completed', { pendingCount: 0 }),
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);
      assertExactReceipt(receipt, {
        status: 'delivered',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 1,
        nextAttemptAt: null,
        pendingCount: 0,
        detail: null,
      });
      assertPublicReceiptSanitized(receipt);
    });
  });

  // ── 2. Canonical-now + authorize-before-read ───────────────────────────

  describe('2 canonical-now gate and authorize-before-read/claim', () => {
    it('non-canonical now fails closed with zero dependency calls (missing ms / offset / non-string)', async () => {
      // Catch: clock coercion or authorize/load before canonical-now validation.
      const api = requireApi();
      const badNows = [
        '2026-08-05T00:00:00Z',
        '2026-08-05T00:00:00.000+00:00',
        '2026-08-05T00:00:00.000',
        1,
        null,
        undefined,
        true,
        { iso: FIXED_NOW },
        new Date(FIXED_NOW),
        'not-iso',
      ];

      for (const badNow of badNows) {
        const harness = createHarness({
          lifecycle: idleLifecycle(),
          outbox: outboxSingleHead(),
          claim: claimFixture('claimed'),
        });
        const tick = tickWith(api, harness);
        await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, badNow));
        assert.equal(harness.order.length, 0, `zero deps for now=${String(badNow)}`);
        assertZeroDownstream(harness);
        assert.equal(harness.counts.authorizeDestination, 0);
        assert.equal(harness.counts.loadLifecycle, 0);
        assert.equal(harness.counts.readOutbox, 0);
      }
    });

    it('authorizeDestination(endpoint) sole primitive arg before lifecycle/outbox/claim/request', async () => {
      // Catch: authorize after durable reads, wrong arity, or non-identity authorized string.
      const api = requireApi();
      const endpoint = ENDPOINT;
      let authorized = false;
      const harness = createHarness({
        authorize: (ep) => {
          assert.equal(authorized, false, 'authorize exactly once before reads');
          assert.equal(ep, endpoint);
          assert.equal(typeof ep, 'string');
          authorized = true;
          return ep; // bit-identical primitive
        },
        lifecycle: () => {
          assert.equal(authorized, true, 'loadLifecycle only after authorize');
          return idleLifecycle(WATERMARK);
        },
        outbox: () => {
          assert.equal(authorized, true, 'readOutbox only after authorize');
          return emptyOutbox();
        },
        claim: claimFixture('empty'),
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, endpoint, FIXED_NOW);
      assertExactReceipt(receipt, {
        status: 'empty',
        streamId: null,
        sequence: null,
        attemptCount: null,
        nextAttemptAt: null,
        pendingCount: 0,
        detail: null,
      });
      assert.equal(harness.counts.authorizeDestination, 1);
      assert.equal(harness.order[0], 'authorizeDestination');
      assert.deepEqual(harness.argsLog[0], ['authorizeDestination', endpoint]);
      assert.ok(
        harness.order.indexOf('loadLifecycle') > 0
          || harness.order.indexOf('readOutbox') > 0,
        'authorize precedes observation reads',
      );
    });

    it('authorization denial causes zero durable effects and zero claim/request/publish', async () => {
      // Catch: claim/network after allowlist denial.
      const api = requireApi();
      const harness = createHarness({
        authorize: () => {
          throw unavailableError();
        },
        lifecycle: idleLifecycle(),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('accepted'),
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.authorizeDestination, 1);
      assert.equal(harness.counts.loadLifecycle, 0);
      assert.equal(harness.counts.readOutbox, 0);
      assertZeroDownstream(harness);
    });
  });

  // ── 3. Open in-flight before detailed request ──────────────────────────

  describe('3 open in-flight before detailed request', () => {
    it('publishes in-flight (outcome null, claim V, attemptCount+1) before executeRequestDetailed', async () => {
      // Catch: network before durable open in-flight or wrong in-flight field bindings.
      const api = requireApi();
      /** @type {object | null} */
      let inflightRow = null;
      let requestSeen = false;
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
        detailed: async () => {
          requestSeen = true;
          assert.notEqual(inflightRow, null, 'in-flight must publish before request');
          return detailedResult('accepted');
        },
        complete: completeFixture('completed', { pendingCount: 0 }),
        onPublish: (row) => {
          if (row.status === 'in-flight') {
            assert.equal(requestSeen, false, 'request must not precede in-flight publish');
            assert.equal(row.outcome, null);
            assert.equal(row.nextAttemptAt, null);
            assert.equal(row.claimId, CLAIM_ID);
            assert.equal(row.claimExpiresAt, CLAIM_EXPIRES_AT);
            assert.equal(row.attemptCount, 1);
            assert.equal(row.streamId, STREAM_ID);
            assert.equal(row.sequence, SEQUENCE);
            assert.equal(row.idempotencyKey, IDEMPOTENCY_KEY);
            assert.equal(row.deadLetter, null);
            inflightRow = row;
          }
        },
      });
      const tick = tickWith(api, harness);
      await tick(DATA_DIR, ENDPOINT, FIXED_NOW);
      assert.notEqual(inflightRow, null);
      assert.equal(harness.counts.executeRequestDetailed, 1);
      const inflightIdx = harness.order.indexOf('publishLifecycle');
      const requestIdx = harness.order.indexOf('executeRequestDetailed');
      assert.ok(inflightIdx >= 0 && requestIdx > inflightIdx);
    });

    it('publishLifecycle failure for open in-flight keeps executeRequestDetailed count at 0', async () => {
      // Catch: network attempt when open in-flight durability failed.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('accepted'),
        failPublishWhen: (row) => row.status === 'in-flight',
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.executeRequestDetailed, 0);
      assert.equal(harness.counts.completeDelivery, 0);
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(harness.counts.appendDeadLetter, 0);
    });
  });

  // ── 4. Accepted path + pendingCount=2 residual ─────────────────────────

  describe('4 accepted-pending-completion then complete (pendingCount=2)', () => {
    it('accepted -> accepted-pending -> complete once -> idle watermark retained -> delivered; never release', async () => {
      // Catch: complete before accepted-pending, release on accept, or wrong delivered fields.
      const api = requireApi();
      const statuses = [];
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxHeadPlusTwoSuccessors(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('accepted'),
        complete: completeFixture('completed', {
          streamId: STREAM_ID,
          sequence: SEQUENCE,
          pendingCount: 2,
        }),
        onPublish: (row) => {
          statuses.push(row.status);
        },
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);

      assert.deepEqual(
        statuses.filter((s) => s === 'in-flight'
          || s === 'accepted-pending-completion'
          || s === 'idle'),
        ['in-flight', 'accepted-pending-completion', 'idle'],
      );

      const pending = harness.published.find((p) => p.status === 'accepted-pending-completion');
      assert.ok(pending);
      assert.deepEqual(pending.outcome, { kind: 'accepted', detail: null });
      assert.equal(pending.claimId, CLAIM_ID);
      assert.equal(pending.nextAttemptAt, null);

      const idle = harness.published.find((p) => p.status === 'idle');
      assert.ok(idle);
      assert.equal(idle.lastObservedAt !== null, true, 'idle retains watermark');
      assert.equal(idle.attemptCount, 0);
      assert.equal(idle.claimId, null);
      assert.equal(idle.streamId, null);

      assert.equal(harness.counts.completeDelivery, 1);
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(harness.counts.appendDeadLetter, 0);
      assert.equal(harness.counts.executeRequestDetailed, 1);

      // pendingCount copies complete receipt (2 successors remain); no post-complete outbox read.
      assertExactReceipt(receipt, {
        status: 'delivered',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 1,
        nextAttemptAt: null,
        pendingCount: 2,
        detail: null,
      });
      assert.equal(
        harness.postCompleteOutboxReads,
        0,
        'must never invent pendingCount via post-complete outbox read',
      );

      // complete capability exact keys only.
      const completeArgs = harness.argsLog.find((e) => e[0] === 'completeDelivery');
      assert.ok(completeArgs);
      const capability = completeArgs.find(
        (a) => a && typeof a === 'object' && Object.hasOwn(/** @type {object} */ (a), 'claimId'),
      );
      assert.ok(capability);
      assertExactKeys(capability, CAPABILITY_KEYS, 'complete capability');
      assert.deepEqual(capability, {
        claimId: CLAIM_ID,
        streamId: STREAM_ID,
        sequence: SEQUENCE,
      });
    });

    it('accepted-pending + complete fails: claim preserved; next tick completes only; zero network', async () => {
      // Catch: re-request after accepted-pending or dropping claim on complete failure.
      const api = requireApi();
      let lifecycle = acceptedPendingLifecycle();
      const claimState = claimedClaimState();
      let completeCalls = 0;

      const harness = createHarness({
        lifecycle: () => lifecycle,
        outbox: outboxHeadPlusTwoSuccessors(),
        claimState: () => claimState,
        claim: claimFixture('busy'),
        complete: async () => {
          completeCalls += 1;
          if (completeCalls === 1) throw unavailableError();
          return completeFixture('completed', { pendingCount: 2 });
        },
        detailed: detailedResult('accepted'),
        onPublish: (row) => {
          lifecycle = deepFreeze(JSON.parse(JSON.stringify(row)));
        },
      });

      const tick = tickWith(api, harness);

      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.executeRequestDetailed, 0);
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(lifecycle.status, 'accepted-pending-completion');
      assert.equal(lifecycle.claimId, CLAIM_ID);
      assert.equal(harness.counts.completeDelivery, 1);

      const beforeSecond = harness.snapshotCounts();
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);
      assert.equal(
        harness.counts.executeRequestDetailed - beforeSecond.executeRequestDetailed,
        0,
        'recovery tick must not network',
      );
      assert.equal(harness.counts.completeDelivery - beforeSecond.completeDelivery, 1);
      assertExactReceipt(receipt, {
        status: 'delivered',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 1,
        nextAttemptAt: null,
        pendingCount: 2,
        detail: null,
      });
      assert.equal(harness.postCompleteOutboxReads, 0);
    });
  });

  // ── 5. Retryable release V->N + release recovery ───────────────────────

  describe('5 retryable-rejected release choreography V then N', () => {
    it('retryable: retry-wait claim V -> release -> claim N -> retry-scheduled only after N', async () => {
      // Catch: release before claim-V wait, success receipt before claim-N, wrong nextAttemptAt.
      const api = requireApi();
      /** @type {string[]} */
      const waitPhases = [];
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('retryable-rejected'),
        release: releaseFixture(),
        onPublish: (row) => {
          if (row.status === 'retry-wait') {
            waitPhases.push(row.claimId === null ? 'N' : 'V');
            assert.equal(row.outcome.kind, 'retryable-rejected');
            assert.equal(row.outcome.detail, 'retryable-http');
            assert.equal(row.nextAttemptAt, BACKOFF_DUE_BY_ATTEMPT[1]);
            if (row.claimId !== null) {
              assert.equal(row.claimId, CLAIM_ID);
              assert.equal(row.claimExpiresAt, CLAIM_EXPIRES_AT);
            } else {
              assert.equal(row.claimExpiresAt, null);
            }
          }
        },
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);

      assert.deepEqual(waitPhases, ['V', 'N']);
      assert.equal(harness.counts.releaseDelivery, 1);
      assert.equal(harness.counts.executeRequestDetailed, 1);
      assert.equal(harness.counts.completeDelivery, 0);
      assert.equal(harness.counts.appendDeadLetter, 0);

      const releaseIdx = harness.order.indexOf('releaseDelivery');
      const waitPublishIdxs = harness.order
        .map((n, i) => (n === 'publishLifecycle' ? i : -1))
        .filter((i) => i >= 0);
      // At least two retry-wait publishes around release.
      assert.ok(waitPublishIdxs.length >= 2);
      assertExactReceipt(receipt, {
        status: 'retry-scheduled',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 1,
        nextAttemptAt: BACKOFF_DUE_BY_ATTEMPT[1],
        pendingCount: 1,
        detail: 'retryable-http',
      });
      // Ensure release sits between V and N publishes.
      const vPublish = harness.published.findIndex(
        (p) => p.status === 'retry-wait' && p.claimId === CLAIM_ID,
      );
      const nPublish = harness.published.findIndex(
        (p) => p.status === 'retry-wait' && p.claimId === null,
      );
      assert.ok(vPublish >= 0 && nPublish > vPublish);
      assert.ok(releaseIdx > 0);
    });

    it('same-tick release failure after claim-V: throw unavailable; total request stays 1; recovery is release-only then due re-claim', async () => {
      // Catch: zero-request rewrite of original settlement, re-request on release recovery, or success receipt on release fail.
      const api = requireApi();
      let releaseCalls = 0;
      let claimCalls = 0;
      let detailedCalls = 0;
      /** @type {object} */
      let lifecycle = idleLifecycle(WATERMARK);

      const harness = createHarness({
        lifecycle: () => lifecycle,
        outbox: outboxSingleHead(),
        // Claimed residual after release failure: recovery loadClaimState must see claim V.
        claimState: claimedClaimState({ claimId: CLAIM_ID }),
        claim: async () => {
          claimCalls += 1;
          if (claimCalls === 1) return claimFixture('claimed', { claimId: CLAIM_ID });
          return claimFixture('claimed', { claimId: CLAIM_ID_B });
        },
        detailed: async () => {
          detailedCalls += 1;
          // First settlement is retryable; only a later due attempt may request again.
          if (detailedCalls === 1) return detailedResult('retryable-rejected');
          return detailedResult('accepted');
        },
        complete: completeFixture('completed', { pendingCount: 0 }),
        release: async () => {
          releaseCalls += 1;
          if (releaseCalls === 1) throw unavailableError();
          return releaseFixture();
        },
        onPublish: (row) => {
          lifecycle = deepFreeze(JSON.parse(JSON.stringify(row)));
        },
      });

      const tick = tickWith(api, harness);

      // Tick 1: original attempt settles retryable, claim-V wait, release fails.
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.executeRequestDetailed, 1);
      assert.equal(detailedCalls, 1);
      assert.equal(lifecycle.status, 'retry-wait');
      assert.equal(lifecycle.claimId, CLAIM_ID);
      assert.equal(lifecycle.outcome.kind, 'retryable-rejected');
      assert.equal(lifecycle.outcome.detail, 'retryable-http');
      assert.equal(lifecycle.nextAttemptAt, BACKOFF_DUE_BY_ATTEMPT[1]);
      assert.equal(harness.counts.releaseDelivery, 1);
      assert.equal(
        harness.published.some((p) => p.status === 'retry-wait' && p.claimId === null),
        false,
        'claim-N must not publish on release failure',
      );

      // Tick 2: release recovery only; still zero additional network.
      const afterFail = harness.snapshotCounts();
      // now still before nextAttemptAt so after release-N should be not-due.
      const receipt2 = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);
      assert.equal(
        harness.counts.executeRequestDetailed - afterFail.executeRequestDetailed,
        0,
      );
      assert.equal(detailedCalls, 1);
      assert.equal(harness.counts.releaseDelivery - afterFail.releaseDelivery, 1);
      assert.equal(lifecycle.claimId, null);
      assert.equal(lifecycle.claimExpiresAt, null);
      assertExactReceipt(receipt2, {
        status: 'not-due',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 1,
        nextAttemptAt: BACKOFF_DUE_BY_ATTEMPT[1],
        pendingCount: 1,
        detail: null,
      });

      // Tick 3: now >= nextAttemptAt with claim fields N → fresh claim + new in-flight + request 2.
      const afterRelease = harness.snapshotCounts();
      await tick(DATA_DIR, ENDPOINT, BACKOFF_DUE_BY_ATTEMPT[1]);
      assert.equal(
        harness.counts.executeRequestDetailed - afterRelease.executeRequestDetailed,
        1,
        'only the new due attempt may raise request total from 1 to 2',
      );
      assert.equal(harness.counts.executeRequestDetailed, 2);
      assert.equal(detailedCalls, 2);
    });

    it('release-pending claim-V + claim file already idle: loadClaimState once, align N without release, not-due', async () => {
      // Catch: blindly calling release when the claim file is already idle.
      const api = requireApi();
      // Hand-checked: FIXED_NOW 12:00:00.000Z < attempt-1 backoff due 12:00:30.000Z.
      const nextAttemptAt = '2026-08-05T12:00:30.000Z';
      assert.equal(nextAttemptAt, BACKOFF_DUE_BY_ATTEMPT[1]);
      assert.equal(FIXED_NOW < nextAttemptAt, true);

      // Durable release-pending: retry-wait + retryable-rejected + claim fields V + future due.
      const releasePending = deepFreeze({
        schemaVersion: 1,
        status: 'retry-wait',
        lastObservedAt: FIXED_NOW,
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        idempotencyKey: IDEMPOTENCY_KEY,
        attemptId: ATTEMPT_ID_1,
        attemptCount: 1,
        firstAttemptAt: FIXED_NOW,
        lastAttemptAt: FIXED_NOW,
        nextAttemptAt,
        claimId: CLAIM_ID,
        claimExpiresAt: CLAIM_EXPIRES_AT,
        outcome: deepFreeze({ kind: 'retryable-rejected', detail: 'retryable-http' }),
        deadLetter: null,
      });
      assertExactKeys(releasePending, LIFECYCLE_KEYS, 'release-pending lifecycle');

      // Real claim file is already idle (full exact idle claim-state shape).
      const alreadyIdleClaim = deepFreeze({
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
      });
      assertExactKeys(alreadyIdleClaim, CLAIM_STATE_KEYS, 'already-idle claim state');
      assert.deepEqual(alreadyIdleClaim, idleClaimState());

      const harness = createHarness({
        lifecycle: releasePending,
        outbox: outboxSingleHead(),
        claimState: alreadyIdleClaim,
        // Hostile scripts: any of these running means the alignment branch is wrong.
        claim: claimFixture('claimed'),
        release: releaseFixture(),
        complete: completeFixture('completed', { pendingCount: 0 }),
        detailed: detailedResult('accepted'),
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);

      // Observe claim file once; never release when already idle.
      assert.equal(harness.counts.loadClaimState, 1);
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(harness.counts.executeRequestDetailed, 0);
      assert.equal(harness.counts.claimDelivery, 0);
      assert.equal(harness.counts.completeDelivery, 0);
      assert.equal(harness.counts.appendDeadLetter, 0);

      // Align WAL only: same retry-wait ledger with claim fields N/N.
      assert.equal(harness.published.length, 1);
      assert.deepEqual(harness.published[0], {
        schemaVersion: 1,
        status: 'retry-wait',
        lastObservedAt: FIXED_NOW,
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        idempotencyKey: IDEMPOTENCY_KEY,
        attemptId: ATTEMPT_ID_1,
        attemptCount: 1,
        firstAttemptAt: FIXED_NOW,
        lastAttemptAt: FIXED_NOW,
        nextAttemptAt,
        claimId: null,
        claimExpiresAt: null,
        outcome: { kind: 'retryable-rejected', detail: 'retryable-http' },
        deadLetter: null,
      });
      assertExactKeys(harness.published[0], LIFECYCLE_KEYS, 'aligned claim-N retry-wait');
      assert.equal(harness.lifecycle.claimId, null);
      assert.equal(harness.lifecycle.claimExpiresAt, null);

      // Public not-due before due; preserved nextAttemptAt; detail null on not-due.
      assertExactReceipt(receipt, {
        status: 'not-due',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 1,
        nextAttemptAt,
        pendingCount: 1,
        detail: null,
      });
    });
  });

  // ── 6. Settled uncertain path ──────────────────────────────────────────

  describe('6 settled uncertain retry-wait retains claim', () => {
    it('detailed throw -> retry-wait unknown/uncertain-network, effectiveDue, claim V, never release', async () => {
      // Catch: release on uncertain, wrong due (backoff-only), or wrong outcome tokens.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
        detailed: unavailableError(),
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);

      const wait = harness.published.find((p) => p.status === 'retry-wait');
      assert.ok(wait);
      assert.deepEqual(wait.outcome, { kind: 'unknown', detail: 'uncertain-network' });
      assert.equal(wait.nextAttemptAt, UNCERTAIN_DUE_ATTEMPT_1);
      assert.equal(wait.claimId, CLAIM_ID);
      assert.equal(wait.claimExpiresAt, CLAIM_EXPIRES_AT);
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(harness.counts.completeDelivery, 0);
      assert.equal(harness.counts.appendDeadLetter, 0);
      assert.equal(harness.counts.executeRequestDetailed, 1);
      assert.equal(harness.counts.computeUncertainDue, 1);

      assertExactReceipt(receipt, {
        status: 'retry-scheduled',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 1,
        nextAttemptAt: UNCERTAIN_DUE_ATTEMPT_1,
        pendingCount: 1,
        detail: 'uncertain-network',
      });
    });

    it('due retry-wait unknown claim-V dead/expired replaceable: claimDelivery once then NEW in-flight + request', async () => {
      // Catch §11.3 gap: due unknown claim-V with dead/expired replaceable must not
      // bypass claimDelivery by synthesizing a claim from the old lifecycle row
      // (source ~1043-1068). Must follow existing claim replacement rules, then
      // publish new open in-flight with the replacement receipt and one detailed
      // request using that receipt's request. §8.4.1 effectiveDue = max(backoffDue,
      // claimExpiresAt) so this due tick is at/over the old claimExpiresAt.
      //
      // Input: durable retry-wait unknown (detail uncertain-network), claim fields V
      // (OLD claimId + claimExpiresAt at expiry boundary), nextAttemptAt <= now,
      // attemptCount in 1..7, outbox head sequence matches.
      const api = requireApi();
      assert.notEqual(CLAIM_ID, CLAIM_ID_B, 'OLD and NEW claim ids must differ');
      const OLD_CLAIM_ID = CLAIM_ID;
      const NEW_CLAIM_ID = CLAIM_ID_B;
      // Hand-checked: attemptCount=1 uncertain effectiveDue is CLAIM_EXPIRES_AT.
      const DUE_NOW = CLAIM_EXPIRES_AT;
      assert.equal(DUE_NOW, UNCERTAIN_DUE_ATTEMPT_1);
      assert.equal(FIXED_NOW < DUE_NOW, true);
      // Fresh replacement TTL boundary after the due tick (distinct from OLD expiresAt).
      const FRESH_CLAIM_EXPIRES_AT = '2026-08-05T12:04:00.000Z';
      assert.equal(FRESH_CLAIM_EXPIRES_AT > DUE_NOW, true);

      // Recognizable replacement request — must not equal a rebuild from outbox head.
      const replacementRequest = deepFreeze({
        __marker: 'replacement-request-from-claimDelivery',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
      });
      assert.notDeepEqual(
        replacementRequest,
        canonicalRequest(SEQUENCE, STREAM_ID),
        'replacement request must be distinct from lifecycle/outbox rebuild',
      );

      const harness = createHarness({
        lifecycle: retryWaitLifecycle('unknown', {
          claimId: OLD_CLAIM_ID,
          claimExpiresAt: CLAIM_EXPIRES_AT,
          nextAttemptAt: DUE_NOW,
          attemptCount: 1,
          attemptId: ATTEMPT_ID_1,
          lastAttemptAt: FIXED_NOW,
          firstAttemptAt: FIXED_NOW,
          detail: 'uncertain-network',
        }),
        outbox: outboxSingleHead(),
        // claimDelivery implements existing replacement rules: NEW claimId, same
        // stream/sequence, fresh expiresAt, and the recognizable request above.
        claim: claimFixture('claimed', {
          claimId: NEW_CLAIM_ID,
          streamId: STREAM_ID,
          sequence: SEQUENCE,
          expiresAt: FRESH_CLAIM_EXPIRES_AT,
          request: replacementRequest,
        }),
        // Finish the path after fix: accepted + complete with NEW capability.
        detailed: detailedResult('accepted'),
        complete: completeFixture('completed', {
          streamId: STREAM_ID,
          sequence: SEQUENCE,
          pendingCount: 0,
        }),
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, ENDPOINT, DUE_NOW);

      // 1) claimDelivery exactly once with (DATA_DIR, ENDPOINT, now).
      assert.equal(
        harness.counts.claimDelivery,
        1,
        'due unknown claim-V replaceable must invoke claimDelivery (not synthetic old claim)',
      );
      const claimCall = harness.argsLog.find((e) => e[0] === 'claimDelivery');
      assert.ok(claimCall);
      assert.deepEqual(
        claimCall.slice(1),
        [DATA_DIR, ENDPOINT, DUE_NOW],
        'claimDelivery args must be exactly (dataDir, endpoint, now)',
      );

      // 2) One detailed request; must carry the replacement receipt request.
      assert.equal(harness.counts.executeRequestDetailed, 1);
      const detailedCall = harness.argsLog.find((e) => e[0] === 'executeRequestDetailed');
      assert.ok(detailedCall);
      assert.equal(detailedCall.length, 2);
      assert.equal(
        detailedCall[1],
        replacementRequest,
        'detailed request must be the claimDelivery replacement request, not a rebuild',
      );
      assert.notDeepEqual(
        detailedCall[1],
        canonicalRequest(SEQUENCE, STREAM_ID),
        'must not rebuild/reuse request from old lifecycle + outbox head',
      );

      // 3) First new open in-flight uses NEW claim + fresh expiresAt + new attemptId
      //    + attemptCount+1; same stream/sequence/idempotency; publish before request.
      const inflight = harness.published.find((p) => p.status === 'in-flight');
      assert.ok(inflight, 'must publish new open in-flight for the next attempt');
      assert.equal(inflight.claimId, NEW_CLAIM_ID);
      assert.notEqual(inflight.claimId, OLD_CLAIM_ID);
      assert.equal(inflight.claimExpiresAt, FRESH_CLAIM_EXPIRES_AT);
      assert.notEqual(inflight.claimExpiresAt, CLAIM_EXPIRES_AT);
      assert.notEqual(inflight.attemptId, ATTEMPT_ID_1);
      assert.equal(typeof inflight.attemptId, 'string');
      assert.equal(inflight.attemptCount, 2);
      assert.equal(inflight.streamId, STREAM_ID);
      assert.equal(inflight.sequence, SEQUENCE);
      assert.equal(inflight.idempotencyKey, IDEMPOTENCY_KEY);
      assert.equal(inflight.outcome, null);
      assert.equal(inflight.nextAttemptAt, null);

      const firstPublishIdx = harness.order.indexOf('publishLifecycle');
      const requestIdx = harness.order.indexOf('executeRequestDetailed');
      assert.ok(firstPublishIdx >= 0, 'open in-flight publish must occur');
      assert.ok(
        requestIdx > firstPublishIdx,
        'open in-flight publish must precede the detailed request',
      );
      assert.equal(
        harness.published[0].status,
        'in-flight',
        'first durable publish on this due tick must be the new open in-flight',
      );
      assert.equal(harness.published[0].claimId, NEW_CLAIM_ID);

      // 4) Complete uses NEW claim capability; final delivered (accepted path).
      assert.equal(harness.counts.completeDelivery, 1);
      assert.equal(harness.counts.releaseDelivery, 0);
      const completeCall = harness.argsLog.find((e) => e[0] === 'completeDelivery');
      assert.ok(completeCall);
      const capability = completeCall.find(
        (a) => a && typeof a === 'object' && Object.hasOwn(/** @type {object} */ (a), 'claimId'),
      );
      assert.ok(capability);
      assertExactKeys(capability, CAPABILITY_KEYS, 'complete capability');
      assert.deepEqual(capability, {
        claimId: NEW_CLAIM_ID,
        streamId: STREAM_ID,
        sequence: SEQUENCE,
      });
      assert.notEqual(
        /** @type {{ claimId: string }} */ (capability).claimId,
        OLD_CLAIM_ID,
        'complete capability must not reuse OLD claimId',
      );

      assertExactReceipt(receipt, {
        status: 'delivered',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 2,
        nextAttemptAt: null,
        pendingCount: 0,
        detail: null,
      });
    });
  });

  // ── 7. Loaded open in-flight crash conversion ──────────────────────────

  describe('7 loaded open in-flight crash conversion (zero network)', () => {
    it('durable in-flight at entry -> retry-wait unknown detail null, effectiveDue, claim V, attemptCount unchanged', async () => {
      // Catch: re-request against open in-flight or attemptCount increment on conversion.
      const api = requireApi();
      const open = inFlightLifecycle({
        attemptCount: 2,
        attemptId: ATTEMPT_ID_2,
        lastAttemptAt: FIXED_NOW,
        firstAttemptAt: WATERMARK,
      });
      // Hand-checked: attemptCountAfterFailure=2 → backoff 12:02:00Z; max with claimExpires 12:02:00Z.
      const expectedDue = '2026-08-05T12:02:00.000Z';
      const harness = createHarness({
        lifecycle: open,
        outbox: outboxSingleHead(),
        claimState: claimedClaimState({ claimId: CLAIM_ID }),
        claim: claimFixture('busy'),
        detailed: detailedResult('accepted'),
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);

      assert.equal(harness.counts.executeRequestDetailed, 0);
      assert.equal(harness.counts.claimDelivery, 0);
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(harness.counts.completeDelivery, 0);

      const wait = harness.published.find((p) => p.status === 'retry-wait');
      assert.ok(wait);
      assert.deepEqual(wait.outcome, { kind: 'unknown', detail: null });
      assert.equal(wait.attemptCount, 2);
      assert.equal(wait.attemptId, ATTEMPT_ID_2);
      assert.equal(wait.claimId, CLAIM_ID);
      assert.equal(wait.claimExpiresAt, CLAIM_EXPIRES_AT);
      assert.equal(wait.nextAttemptAt, expectedDue);

      // now == FIXED_NOW < expectedDue → not-due (or retry-scheduled if due equality treated ready;
      // design: return retry-scheduled or not-due according to now vs nextAttemptAt).
      // FIXED_NOW < expectedDue ⇒ not-due.
      assertExactReceipt(receipt, {
        status: 'not-due',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 2,
        nextAttemptAt: expectedDue,
        pendingCount: 1,
        detail: null,
      });
    });
  });

  // ── 8. empty / not-due / busy / clock rollback ─────────────────────────

  describe('8 empty, not-due, busy, clock rollback', () => {
    it('empty outbox + idle lifecycle → empty receipt, zero claim/request', async () => {
      // Catch: claim/network on empty outbox or wrong empty pendingCount.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(),
        outbox: emptyOutbox(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('accepted'),
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);
      assertExactReceipt(receipt, {
        status: 'empty',
        streamId: null,
        sequence: null,
        attemptCount: null,
        nextAttemptAt: null,
        pendingCount: 0,
        detail: null,
      });
      assert.equal(harness.counts.claimDelivery, 0);
      assert.equal(harness.counts.executeRequestDetailed, 0);
      assert.equal(harness.counts.publishLifecycle, 0);
    });

    it('now < nextAttemptAt on retry-wait → not-due, zero request', async () => {
      // Catch: early retry before backoff due.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: retryWaitLifecycle('retryable-rejected', {
          claimId: null,
          claimExpiresAt: null,
          nextAttemptAt: BACKOFF_DUE_BY_ATTEMPT[1],
          detail: 'retryable-http',
        }),
        outbox: outboxSingleHead(),
        claimState: idleClaimState(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('accepted'),
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);
      assertExactReceipt(receipt, {
        status: 'not-due',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 1,
        nextAttemptAt: BACKOFF_DUE_BY_ATTEMPT[1],
        pendingCount: 1,
        detail: null,
      });
      assert.equal(harness.counts.executeRequestDetailed, 0);
      assert.equal(harness.counts.claimDelivery, 0);
    });

    it('claim busy → busy receipt, zero request/complete/release', async () => {
      // Catch: treating busy as claimable or wrong busy nextAttemptAt/pendingCount.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxSingleHead(),
        claim: claimFixture('busy', {
          streamId: STREAM_ID,
          sequence: SEQUENCE,
          expiresAt: CLAIM_EXPIRES_AT,
        }),
      });
      const tick = tickWith(api, harness);
      const receipt = await tick(DATA_DIR, ENDPOINT, FIXED_NOW);
      assertExactReceipt(receipt, {
        status: 'busy',
        streamId: STREAM_ID,
        sequence: SEQUENCE,
        attemptCount: 0,
        nextAttemptAt: null,
        pendingCount: 1,
        detail: null,
      });
      assert.equal(harness.counts.executeRequestDetailed, 0);
      assert.equal(harness.counts.completeDelivery, 0);
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(harness.counts.publishLifecycle, 0);
    });

    it('now < lastObservedAt → fixed throw, zero mutation', async () => {
      // Catch: clock rollback acceptance.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle('2026-08-05T13:00:00.000Z'),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.publishLifecycle, 0);
      assert.equal(harness.counts.claimDelivery, 0);
      assert.equal(harness.counts.executeRequestDetailed, 0);
    });
  });

  // ── 9. Task 6 terminal fail-closed boundary ────────────────────────────

  describe('9 Task 6 terminal fail-closed boundary (no dead-letter success)', () => {
    it('terminal-rejected decision fails closed; no outbox ack, no DLQ append, no success receipt', async () => {
      // Catch: Task 5 implementing dead-letter success path early.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('terminal-rejected'),
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.executeRequestDetailed, 1);
      assert.equal(harness.counts.completeDelivery, 0);
      assert.equal(harness.counts.appendDeadLetter, 0);
      assert.equal(harness.counts.releaseDelivery, 0);
      // Open in-flight may have been published before settlement; no DLQ/ack after.
      assert.equal(
        harness.published.some((p) => p.status === 'dead-letter-prepared'),
        false,
      );
      assert.equal(
        harness.published.some((p) => p.status === 'idle'),
        false,
      );
    });

    it('attempts-exhausted retryable decision fails closed without dead-lettered receipt', async () => {
      // Catch: attempts-exhausted success receipt before Task 6.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('retryable-rejected'),
      });
      // Force attemptCount 8 via pre-seeded open attempt path: claim then publish with 8.
      // Simpler: start from retry-wait due with attemptCount 7, new attempt becomes 8.
      harness.lifecycle = retryWaitLifecycle('retryable-rejected', {
        claimId: null,
        claimExpiresAt: null,
        attemptCount: 7,
        nextAttemptAt: FIXED_NOW,
        detail: 'retryable-http',
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.appendDeadLetter, 0);
      assert.equal(harness.counts.completeDelivery, 0);
      assert.equal(
        harness.published.some((p) => p.status === 'dead-letter-prepared'),
        false,
      );
    });
  });

  // ── 10. Stage-specific malformed downstream causality ──────────────────

  describe('10 stage-specific malformed downstream causality', () => {
    it('malformed initial lifecycle snapshot: only observation reads; zero durable mutation', async () => {
      // Catch: publish/claim after corrupt lifecycle load.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: deepFreeze({ schemaVersion: 1, status: 'nope' }),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.publishLifecycle, 0);
      assert.equal(harness.counts.claimDelivery, 0);
      assert.equal(harness.counts.executeRequestDetailed, 0);
      assert.equal(harness.counts.completeDelivery, 0);
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(harness.counts.appendDeadLetter, 0);
    });

    it('malformed claim receipt: one claim allowed; no later publish/request/complete/release/DLQ', async () => {
      // Catch: continuing after non-schema claim receipt.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxSingleHead(),
        claim: deepFreeze({ schemaVersion: 1, status: 'claimed' }),
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.claimDelivery, 1);
      assert.equal(harness.counts.publishLifecycle, 0);
      assert.equal(harness.counts.executeRequestDetailed, 0);
      assert.equal(harness.counts.completeDelivery, 0);
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(harness.counts.appendDeadLetter, 0);
    });

    it('malformed detailed result: after open in-flight + one request; no later settlement publish/complete/release/DLQ', async () => {
      // Catch: false universal "zero prior durable writes" on unavailable after request.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
        detailed: deepFreeze({ schemaVersion: 1, kind: 'not-a-kind' }),
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.executeRequestDetailed, 1);
      assert.equal(
        harness.published.some((p) => p.status === 'in-flight'),
        true,
        'open in-flight necessarily precedes malformed detailed observation',
      );
      assert.equal(
        harness.published.some((p) => p.status === 'accepted-pending-completion'
          || p.status === 'retry-wait'
          || p.status === 'idle'),
        false,
      );
      assert.equal(harness.counts.completeDelivery, 0);
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(harness.counts.appendDeadLetter, 0);
    });

    it('malformed complete receipt: after accepted-pending + one complete; no later idle/release/DLQ', async () => {
      // Catch: idle publish after malformed complete or universal zero-write assertion.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxHeadPlusTwoSuccessors(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('accepted'),
        complete: deepFreeze({
          schemaVersion: 1,
          status: 'completed',
          completed: true,
          // missing streamId/sequence/pendingCount — malformed
        }),
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.completeDelivery, 1);
      assert.equal(
        harness.published.some((p) => p.status === 'accepted-pending-completion'),
        true,
      );
      assert.equal(
        harness.published.some((p) => p.status === 'idle'),
        false,
      );
      assert.equal(harness.counts.releaseDelivery, 0);
      assert.equal(harness.counts.appendDeadLetter, 0);
    });

    it('malformed release receipt: after retry-wait claim-V + one release; no claim-N / extra request / DLQ', async () => {
      // Catch: claim-N publish after malformed release or extra network.
      const api = requireApi();
      const harness = createHarness({
        lifecycle: idleLifecycle(WATERMARK),
        outbox: outboxSingleHead(),
        claim: claimFixture('claimed'),
        detailed: detailedResult('retryable-rejected'),
        release: deepFreeze({ schemaVersion: 1, status: 'released' }),
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.executeRequestDetailed, 1);
      assert.equal(harness.counts.releaseDelivery, 1);
      assert.equal(
        harness.published.some((p) => p.status === 'retry-wait' && p.claimId === CLAIM_ID),
        true,
      );
      assert.equal(
        harness.published.some((p) => p.status === 'retry-wait' && p.claimId === null),
        false,
      );
      assert.equal(harness.counts.appendDeadLetter, 0);
    });
  });

  // ── 11. Outbox relation + privacy fixed errors ─────────────────────────

  describe('11 outbox sequence relation and fixed public errors', () => {
    it('outbox entries never carry streamId/claimId/attemptId/idempotencyKey; relation uses sequence only', async () => {
      // Catch: inventing streamId on outbox entries or ignoring sequence mismatch.
      const api = requireApi();
      const entry = headEntry(1);
      assertExactKeys(entry, OUTBOX_ENTRY_KEYS, 'outbox entry');
      assert.equal(Object.hasOwn(entry, 'streamId'), false);
      assert.equal(Object.hasOwn(entry, 'claimId'), false);
      assert.equal(Object.hasOwn(entry, 'attemptId'), false);
      assert.equal(Object.hasOwn(entry, 'idempotencyKey'), false);

      // Lifecycle sequence mismatch vs outbox head must fail closed.
      const harness = createHarness({
        lifecycle: retryWaitLifecycle('retryable-rejected', {
          sequence: 99,
          claimId: null,
          claimExpiresAt: null,
          nextAttemptAt: FIXED_NOW,
          idempotencyKey: `audit-integrity-alert:${STREAM_ID}:99`,
        }),
        outbox: outboxSingleHead(),
        claimState: idleClaimState(),
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(tick(DATA_DIR, ENDPOINT, FIXED_NOW));
      assert.equal(harness.counts.executeRequestDetailed, 0);
      assert.equal(harness.counts.claimDelivery, 0);
    });

    it('all public throws are path-free audit-delivery-unavailable LinkeError', async () => {
      // Catch: leaking endpoint/path/status through thrown errors.
      const api = requireApi();
      const harness = createHarness({
        authorize: () => {
          throw new Error(`deny ${ENDPOINT} at ${SECRET_PATH} via ${SECRET_IP}`);
        },
        lifecycle: idleLifecycle(),
        outbox: outboxSingleHead(),
      });
      const tick = tickWith(api, harness);
      await expectUnavailableAsync(
        tick(DATA_DIR, ENDPOINT, FIXED_NOW),
        [ENDPOINT, SECRET_PATH, SECRET_IP],
      );
    });
  });
});
