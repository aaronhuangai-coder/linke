/**
 * Explicit durable retry tick coordinator for audit integrity alert delivery.
 *
 * Task 5+6: empty / not-due / busy / delivered / retry-scheduled paths plus
 * dead-letter transaction order, prepared crash recovery, sticky DLQ-full
 * blocked, and fingerprint continue-condition fail-closed.
 *
 * Advancement is only via programmatic tick(now): at most one detailed network
 * request per tick, open in-flight before every request, no scheduler/timers.
 *
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md
 *   .superpowers/sdd/.../task-6-brief.md
 */

import { createHash, randomUUID } from 'node:crypto';
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
  AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES,
  AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES,
  AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH,
  appendAuditIntegrityAlertDeadLetterUnderLease,
  fingerprintAuditIntegrityAlertDeadLetterRaw,
  readAuditIntegrityAlertDeadLetter,
} from './audit-integrity-alert-dead-letter.js';
import { executeAuditIntegrityAlertHttpsRequestDetailed } from './audit-integrity-alert-https-transport.js';
import {
  AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_BYTES,
  AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
  readAuditIntegrityAlertOutbox,
} from './audit-integrity-alert-outbox.js';
import {
  classifyAuditIntegrityAlertRetryDecision,
  computeAuditIntegrityAlertRetryDueAt,
  computeAuditIntegrityAlertUncertainDueAt,
} from './audit-integrity-alert-retry-policy.js';
import {
  assertAuditIntegrityWriteLease,
  enqueueAuditIntegrityWriteTask,
} from './audit-integrity-write-queue.js';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertSafeDataRoot, safeReadText } from './safe-data-files.js';

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
const FINGERPRINT_KEYS = Object.freeze([
  'sha256',
  'byteLength',
  'entryCount',
  'nextSequence',
]);
const DEAD_LETTER_NESTED_KEYS = Object.freeze([
  'deadLetterId',
  'reason',
  'sourceAlert',
  'claim',
  'deadLetterPre',
  'deadLetterPost',
  'outboxPre',
  'outboxPost',
  'preparedAt',
]);
const SOURCE_ALERT_KEYS = Object.freeze([
  'sequence',
  'checkedAt',
  'code',
  'recoveryRequired',
  'nextAction',
  'reasonCode',
]);
const NESTED_CLAIM_KEYS = Object.freeze(['claimId', 'streamId', 'sequence']);
const DLQ_SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'entryCount',
  'nextSequence',
  'entries',
]);
const CALLER_DLQ_ENTRY_KEYS = Object.freeze([
  'deadLetterId',
  'streamId',
  'sequence',
  'idempotencyKey',
  'enqueuedAt',
  'attemptCount',
  'firstAttemptAt',
  'lastAttemptAt',
  'reason',
  'sourceAlert',
]);
const PERSISTED_DLQ_ENTRY_KEYS = Object.freeze([
  'deadLetterSequence',
  'deadLetterId',
  'streamId',
  'sequence',
  'idempotencyKey',
  'enqueuedAt',
  'attemptCount',
  'firstAttemptAt',
  'lastAttemptAt',
  'reason',
  'sourceAlert',
]);

const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const DETAILED_KINDS = new Set([
  'accepted',
  'retryable-rejected',
  'terminal-rejected',
]);

const DEAD_LETTER_REASONS = new Set([
  'terminal-http',
  'attempts-exhausted-retryable',
  'attempts-exhausted-uncertain',
]);

const EMPTY_DLQ_RAW = '{"schemaVersion":1,"nextSequence":1,"entries":[]}\n';

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

  if (status === 'dead-letter-prepared') {
    if (record.nextAttemptAt !== null) fail();
    if (record.attemptCount < 1) fail();
    assertUuidV4(record.claimId);
    assertCanonicalIso(record.claimExpiresAt);
    const outcome = parseOutcome(record.outcome);
    const deadLetter = parseNestedDeadLetter(
      record.deadLetter,
      /** @type {string} */ (record.claimId),
      /** @type {string} */ (record.streamId),
      /** @type {number} */ (record.sequence),
      outcome,
    );
    return { ...record, outcome, deadLetter };
  }

  if (status === 'blocked') {
    if (record.nextAttemptAt !== null) fail();
    if (record.deadLetter !== null) fail();
    if (record.attemptCount < 1) fail();
    assertUuidV4(record.claimId);
    assertCanonicalIso(record.claimExpiresAt);
    const outcome = parseOutcome(record.outcome);
    if (outcome.kind !== 'blocked' || outcome.detail !== 'dead-letter-full') {
      fail();
    }
    return { ...record, outcome };
  }

  fail();
}

/**
 * @param {unknown} value
 * @returns {{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 * }}
 */
function parseFingerprint(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, FINGERPRINT_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (typeof record.sha256 !== 'string' || !SHA256_HEX_RE.test(record.sha256)) {
    fail();
  }
  return {
    sha256: record.sha256,
    byteLength: assertNonNegativeSafeInteger(record.byteLength),
    entryCount: assertNonNegativeSafeInteger(record.entryCount),
    nextSequence: assertPositiveSafeInteger(record.nextSequence),
  };
}

/**
 * @param {{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 * }} a
 * @param {{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 * }} b
 * @returns {boolean}
 */
function fingerprintsEqual(a, b) {
  return a.sha256 === b.sha256
    && a.byteLength === b.byteLength
    && a.entryCount === b.entryCount
    && a.nextSequence === b.nextSequence;
}

/**
 * @param {unknown} value
 * @param {number} expectedSequence
 * @returns {Record<string, unknown>}
 */
function parseSourceAlert(value, expectedSequence) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, SOURCE_ALERT_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (assertPositiveSafeInteger(record.sequence) !== expectedSequence) fail();
  assertCanonicalIso(record.checkedAt);
  if (typeof record.code !== 'string') fail();
  if (typeof record.recoveryRequired !== 'boolean') fail();
  if (typeof record.nextAction !== 'string') fail();
  if (record.reasonCode !== null && typeof record.reasonCode !== 'string') fail();
  return {
    sequence: record.sequence,
    checkedAt: record.checkedAt,
    code: record.code,
    recoveryRequired: record.recoveryRequired,
    nextAction: record.nextAction,
    reasonCode: record.reasonCode,
  };
}

/**
 * @param {unknown} value
 * @param {string} expectedClaimId
 * @param {string} expectedStreamId
 * @param {number} expectedSequence
 * @param {{ kind: string, detail: string | null }} outcome
 * @returns {Record<string, unknown>}
 */
function parseNestedDeadLetter(
  value,
  expectedClaimId,
  expectedStreamId,
  expectedSequence,
  outcome,
) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, DEAD_LETTER_NESTED_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  const deadLetterId = assertUuidV4(record.deadLetterId);
  if (typeof record.reason !== 'string' || !DEAD_LETTER_REASONS.has(record.reason)) {
    fail();
  }
  const reason = record.reason;

  if (reason === 'terminal-http') {
    if (outcome.kind !== 'terminal-rejected' || outcome.detail !== 'terminal-http') {
      fail();
    }
  } else if (reason === 'attempts-exhausted-retryable') {
    if (
      outcome.kind !== 'attempts-exhausted'
      || outcome.detail !== 'attempts-exhausted-retryable'
    ) {
      fail();
    }
  } else if (reason === 'attempts-exhausted-uncertain') {
    if (
      outcome.kind !== 'attempts-exhausted'
      || outcome.detail !== 'attempts-exhausted-uncertain'
    ) {
      fail();
    }
  } else {
    fail();
  }

  const sourceAlert = parseSourceAlert(record.sourceAlert, expectedSequence);
  const claimObj = assertPlainDataObject(record.claim);
  assertExactKeyOrder(claimObj, NESTED_CLAIM_KEYS);
  const claimRecord = /** @type {Record<string, unknown>} */ (claimObj);
  const claimId = assertUuidV4(claimRecord.claimId);
  const streamId = assertUuidV4(claimRecord.streamId);
  const sequence = assertPositiveSafeInteger(claimRecord.sequence);
  if (claimId !== expectedClaimId) fail();
  if (streamId !== expectedStreamId) fail();
  if (sequence !== expectedSequence) fail();

  const deadLetterPre = parseFingerprint(record.deadLetterPre);
  const deadLetterPost = parseFingerprint(record.deadLetterPost);
  const outboxPre = parseFingerprint(record.outboxPre);
  const outboxPost = parseFingerprint(record.outboxPost);
  const preparedAt = assertCanonicalIso(record.preparedAt);

  const appendOk = deadLetterPost.entryCount === deadLetterPre.entryCount + 1
    && deadLetterPost.nextSequence === deadLetterPre.nextSequence + 1;
  const idempotentOk = fingerprintsEqual(deadLetterPre, deadLetterPost);
  if (!appendOk && !idempotentOk) fail();

  if (outboxPre.entryCount < 1) fail();
  if (outboxPost.entryCount !== outboxPre.entryCount - 1) fail();
  if (outboxPost.nextSequence !== outboxPre.nextSequence) fail();

  return {
    deadLetterId,
    reason,
    sourceAlert,
    claim: { claimId, streamId, sequence },
    deadLetterPre,
    deadLetterPost,
    outboxPre,
    outboxPost,
    preparedAt,
  };
}

/**
 * @param {unknown} value
 * @returns {{
 *   status: 'empty' | 'ready',
 *   entryCount: number,
 *   nextSequence: number,
 *   entries: object[],
 * }}
 */
function parseDlqSnapshot(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, DLQ_SNAPSHOT_KEYS);
  const record = /** @type {Record<string, unknown>} */ (obj);
  if (record.schemaVersion !== 1) fail();
  if (record.status !== 'empty' && record.status !== 'ready') fail();
  const entryCount = assertNonNegativeSafeInteger(record.entryCount);
  const nextSequence = assertPositiveSafeInteger(record.nextSequence);
  if (!Array.isArray(record.entries)) fail();

  // entryCount is the authoritative capacity signal for preflight (including
  // capacity-full). Inspect/harness snapshots may omit materializing every
  // entry body while still reporting entryCount (e.g. fullDeadLetterSnapshot
  // with entryCount=256 and entries=[]). Never require
  // entries.length === entryCount. Over-capacity is rejected; at-capacity is
  // legal and must remain parseable so the coordinator can publish sticky
  // blocked before any append.
  if (record.entries.length > entryCount) fail();
  if (entryCount > AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES) fail();
  // Allocator continuity: nextSequence is always entryCount + 1 (empty → 1,
  // full-256 → 257).
  if (nextSequence !== entryCount + 1) fail();

  if (record.status === 'empty') {
    if (entryCount !== 0 || record.entries.length !== 0) fail();
  }
  // status === 'ready' + entryCount === MAX_ENTRIES (+ nextSequence MAX+1) is
  // a legal capacity-full inspect snapshot even when entries is [].

  /** @type {object[]} */
  const entries = [];
  for (const entry of record.entries) {
    const e = assertPlainDataObject(entry);
    assertExactKeyOrder(e, PERSISTED_DLQ_ENTRY_KEYS);
    const er = /** @type {Record<string, unknown>} */ (e);
    assertPositiveSafeInteger(er.deadLetterSequence);
    assertUuidV4(er.deadLetterId);
    assertUuidV4(er.streamId);
    assertPositiveSafeInteger(er.sequence);
    if (typeof er.idempotencyKey !== 'string') fail();
    assertCanonicalIso(er.enqueuedAt);
    assertAttemptCount(er.attemptCount);
    if (/** @type {number} */ (er.attemptCount) < 1) fail();
    assertCanonicalIso(er.firstAttemptAt);
    assertCanonicalIso(er.lastAttemptAt);
    if (typeof er.reason !== 'string' || !DEAD_LETTER_REASONS.has(er.reason)) {
      fail();
    }
    parseSourceAlert(er.sourceAlert, /** @type {number} */ (er.sequence));
    entries.push(er);
  }

  return {
    status: /** @type {'empty' | 'ready'} */ (record.status),
    entryCount,
    nextSequence,
    entries,
  };
}

/**
 * @param {string} rawText
 * @param {number} entryCount
 * @param {number} nextSequence
 * @returns {{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 * }}
 */
function fingerprintRawText(rawText, entryCount, nextSequence) {
  return {
    sha256: createHash('sha256').update(rawText, 'utf8').digest('hex'),
    byteLength: Buffer.byteLength(rawText, 'utf8'),
    entryCount,
    nextSequence,
  };
}

/**
 * Canonical DLQ full-file text (compact JSON + trailing LF).
 *
 * @param {{ schemaVersion: number, nextSequence: number, entries: object[] }} state
 * @returns {string}
 */
function serializeCanonicalDlq(state) {
  const entries = state.entries.map((entry) => {
    const e = /** @type {Record<string, any>} */ (entry);
    const sa = e.sourceAlert;
    return {
      deadLetterSequence: e.deadLetterSequence,
      deadLetterId: e.deadLetterId,
      streamId: e.streamId,
      sequence: e.sequence,
      idempotencyKey: e.idempotencyKey,
      enqueuedAt: e.enqueuedAt,
      attemptCount: e.attemptCount,
      firstAttemptAt: e.firstAttemptAt,
      lastAttemptAt: e.lastAttemptAt,
      reason: e.reason,
      sourceAlert: {
        sequence: sa.sequence,
        checkedAt: sa.checkedAt,
        code: sa.code,
        recoveryRequired: sa.recoveryRequired,
        nextAction: sa.nextAction,
        reasonCode: sa.reasonCode,
      },
    };
  });
  return `${JSON.stringify({
    schemaVersion: 1,
    nextSequence: state.nextSequence,
    entries,
  })}\n`;
}

/**
 * Canonical outbox full-file text.
 *
 * @param {{ nextSequence: number, entries: object[] }} state
 * @returns {string}
 */
function serializeCanonicalOutbox(state) {
  const entries = state.entries.map((entry) => {
    const e = /** @type {Record<string, unknown>} */ (entry);
    return {
      sequence: e.sequence,
      checkedAt: e.checkedAt,
      code: e.code,
      recoveryRequired: e.recoveryRequired,
      nextAction: e.nextAction,
      reasonCode: e.reasonCode,
    };
  });
  return `${JSON.stringify({
    schemaVersion: 1,
    nextSequence: state.nextSequence,
    entries,
  })}\n`;
}

/**
 * Fingerprint current DLQ snapshot (missing/empty leaf → empty identity).
 *
 * @param {{
 *   status: string,
 *   entryCount: number,
 *   nextSequence: number,
 *   entries: object[],
 * }} snapshot
 * @returns {{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 * }}
 */
function fingerprintDlqSnapshot(snapshot) {
  if (snapshot.entryCount === 0) {
    return fingerprintRawText(EMPTY_DLQ_RAW, 0, 1);
  }
  const raw = serializeCanonicalDlq({
    schemaVersion: 1,
    nextSequence: snapshot.nextSequence,
    entries: snapshot.entries,
  });
  // Prefer module helper when raw is legal durable text.
  try {
    return {
      ...fingerprintAuditIntegrityAlertDeadLetterRaw(raw),
    };
  } catch {
    return fingerprintRawText(raw, snapshot.entryCount, snapshot.nextSequence);
  }
}

/**
 * Would-be post fingerprint after appending one caller entry onto a pre snapshot.
 *
 * @param {object} callerEntry
 * @param {{
 *   entryCount: number,
 *   nextSequence: number,
 *   entries: object[],
 * }} preSnapshot
 * @returns {{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 *   persistedEntry: object,
 * }}
 */
function wouldBePostFromCaller(callerEntry, preSnapshot) {
  const c = /** @type {Record<string, any>} */ (callerEntry);
  // Exact-duplicate identity: if same (streamId, sequence) already present with
  // matching non-allocator fields, post equals pre (no-op).
  for (const existing of preSnapshot.entries) {
    const e = /** @type {Record<string, any>} */ (existing);
    if (e.streamId === c.streamId && e.sequence === c.sequence) {
      const preFp = fingerprintDlqSnapshot({
        status: preSnapshot.entryCount === 0 ? 'empty' : 'ready',
        entryCount: preSnapshot.entryCount,
        nextSequence: preSnapshot.nextSequence,
        entries: preSnapshot.entries,
      });
      return { ...preFp, persistedEntry: existing };
    }
  }

  const persistedEntry = {
    deadLetterSequence: preSnapshot.nextSequence,
    deadLetterId: c.deadLetterId,
    streamId: c.streamId,
    sequence: c.sequence,
    idempotencyKey: c.idempotencyKey,
    enqueuedAt: c.enqueuedAt,
    attemptCount: c.attemptCount,
    firstAttemptAt: c.firstAttemptAt,
    lastAttemptAt: c.lastAttemptAt,
    reason: c.reason,
    sourceAlert: {
      sequence: c.sourceAlert.sequence,
      checkedAt: c.sourceAlert.checkedAt,
      code: c.sourceAlert.code,
      recoveryRequired: c.sourceAlert.recoveryRequired,
      nextAction: c.sourceAlert.nextAction,
      reasonCode: c.sourceAlert.reasonCode,
    },
  };
  const entries = [...preSnapshot.entries, persistedEntry];
  const nextSequence = preSnapshot.nextSequence + 1;
  const raw = serializeCanonicalDlq({
    schemaVersion: 1,
    nextSequence,
    entries,
  });
  const fp = fingerprintRawText(raw, entries.length, nextSequence);
  return { ...fp, persistedEntry };
}

/**
 * @param {object} outbox parsed outbox
 * @returns {{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 * }}
 */
function fingerprintOutboxSnapshot(outbox) {
  const raw = serializeCanonicalOutbox(outbox);
  return fingerprintRawText(
    raw,
    outbox.entries.length,
    outbox.nextSequence,
  );
}

/**
 * @param {object} outbox
 * @returns {{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 * }}
 */
function fingerprintOutboxPostAfterAck(outbox) {
  if (outbox.entries.length < 1) fail();
  const post = {
    nextSequence: outbox.nextSequence,
    entries: outbox.entries.slice(1),
  };
  return fingerprintOutboxSnapshot(post);
}

/**
 * @param {Record<string, unknown>} head outbox entry
 * @returns {Record<string, unknown>}
 */
function sourceAlertFromHead(head) {
  return {
    sequence: head.sequence,
    checkedAt: head.checkedAt,
    code: head.code,
    recoveryRequired: head.recoveryRequired,
    nextAction: head.nextAction,
    reasonCode: head.reasonCode,
  };
}

/**
 * @param {string} reason
 * @returns {{ kind: string, detail: string }}
 */
function outcomeForDeadLetterReason(reason) {
  if (reason === 'terminal-http') {
    return { kind: 'terminal-rejected', detail: 'terminal-http' };
  }
  if (reason === 'attempts-exhausted-retryable') {
    return {
      kind: 'attempts-exhausted',
      detail: 'attempts-exhausted-retryable',
    };
  }
  if (reason === 'attempts-exhausted-uncertain') {
    return {
      kind: 'attempts-exhausted',
      detail: 'attempts-exhausted-uncertain',
    };
  }
  fail();
}

/**
 * @param {string} decision classifyRetryDecision result
 * @returns {string} nested/public dead-letter reason
 */
function reasonFromDecision(decision) {
  if (decision === 'dead-letter-terminal-http') return 'terminal-http';
  if (decision === 'dead-letter-attempts-exhausted-retryable') {
    return 'attempts-exhausted-retryable';
  }
  if (decision === 'dead-letter-attempts-exhausted-uncertain') {
    return 'attempts-exhausted-uncertain';
  }
  fail();
}

/**
 * Build caller DLQ entry (10 keys, no deadLetterSequence).
 *
 * @param {{
 *   deadLetterId: string,
 *   streamId: string,
 *   sequence: number,
 *   idempotencyKey: string,
 *   enqueuedAt: string,
 *   attemptCount: number,
 *   firstAttemptAt: string,
 *   lastAttemptAt: string,
 *   reason: string,
 *   sourceAlert: object,
 * }} fields
 * @returns {object}
 */
function buildCallerDlqEntry(fields) {
  const entry = {
    deadLetterId: fields.deadLetterId,
    streamId: fields.streamId,
    sequence: fields.sequence,
    idempotencyKey: fields.idempotencyKey,
    enqueuedAt: fields.enqueuedAt,
    attemptCount: fields.attemptCount,
    firstAttemptAt: fields.firstAttemptAt,
    lastAttemptAt: fields.lastAttemptAt,
    reason: fields.reason,
    sourceAlert: {
      sequence: fields.sourceAlert.sequence,
      checkedAt: fields.sourceAlert.checkedAt,
      code: fields.sourceAlert.code,
      recoveryRequired: fields.sourceAlert.recoveryRequired,
      nextAction: fields.sourceAlert.nextAction,
      reasonCode: fields.sourceAlert.reasonCode,
    },
  };
  assertExactKeyOrder(entry, CALLER_DLQ_ENTRY_KEYS);
  return entry;
}

/**
 * @param {Record<string, unknown>} inflight
 * @param {string} reason
 * @param {object} nestedDeadLetter
 * @returns {object}
 */
function buildDeadLetterPreparedRow(inflight, reason, nestedDeadLetter) {
  return {
    schemaVersion: 1,
    status: 'dead-letter-prepared',
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
    outcome: outcomeForDeadLetterReason(reason),
    deadLetter: nestedDeadLetter,
  };
}

/**
 * @param {Record<string, unknown>} inflight
 * @returns {object}
 */
function buildBlockedDeadLetterFullRow(inflight) {
  return {
    schemaVersion: 1,
    status: 'blocked',
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
    outcome: { kind: 'blocked', detail: 'dead-letter-full' },
    deadLetter: null,
  };
}

/**
 * @param {object} entry persisted DLQ entry
 * @param {Record<string, unknown>} prepared nested deadLetter
 * @param {Record<string, unknown>} lifecycle
 * @returns {boolean}
 */
function persistedEntryMatchesPrepared(entry, prepared, lifecycle) {
  const e = /** @type {Record<string, any>} */ (entry);
  const p = prepared;
  if (e.deadLetterId !== p.deadLetterId) return false;
  if (e.streamId !== lifecycle.streamId) return false;
  if (e.sequence !== lifecycle.sequence) return false;
  if (e.idempotencyKey !== lifecycle.idempotencyKey) return false;
  if (e.attemptCount !== lifecycle.attemptCount) return false;
  if (e.firstAttemptAt !== lifecycle.firstAttemptAt) return false;
  if (e.lastAttemptAt !== lifecycle.lastAttemptAt) return false;
  if (e.reason !== p.reason) return false;
  const a = e.sourceAlert;
  const b = /** @type {Record<string, any>} */ (p.sourceAlert);
  return a.sequence === b.sequence
    && a.checkedAt === b.checkedAt
    && a.code === b.code
    && a.recoveryRequired === b.recoveryRequired
    && a.nextAction === b.nextAction
    && a.reasonCode === b.reasonCode;
}

/**
 * Full in-flight binding check: current durable lifecycle must match the open
 * in-flight row on every binding field (status/stream/sequence/idempotency/
 * attempt/timestamps/claim/outcome). Fail closed on any mismatch.
 *
 * @param {Record<string, unknown>} current
 * @param {Record<string, unknown>} inflight
 */
function assertCurrentInFlightBinding(current, inflight) {
  if (current.status !== 'in-flight') fail();
  if (current.schemaVersion !== 1) fail();
  if (current.streamId !== inflight.streamId) fail();
  if (current.sequence !== inflight.sequence) fail();
  if (current.idempotencyKey !== inflight.idempotencyKey) fail();
  if (current.attemptId !== inflight.attemptId) fail();
  if (current.attemptCount !== inflight.attemptCount) fail();
  if (current.firstAttemptAt !== inflight.firstAttemptAt) fail();
  if (current.lastAttemptAt !== inflight.lastAttemptAt) fail();
  if (current.lastObservedAt !== inflight.lastObservedAt) fail();
  if (current.nextAttemptAt !== null) fail();
  if (current.claimId !== inflight.claimId) fail();
  if (current.claimExpiresAt !== inflight.claimExpiresAt) fail();
  if (current.outcome !== null) fail();
  if (current.deadLetter !== null) fail();
}

/**
 * Binding fields retained from in-flight onto prepared/blocked must still match
 * the live open in-flight row under lease (full fail-closed, not watermark-only).
 *
 * @param {Record<string, unknown>} current
 * @param {Record<string, unknown>} row prepared or blocked target
 */
function assertCurrentInFlightMatchesTargetRow(current, row) {
  if (current.status !== 'in-flight') fail();
  if (current.schemaVersion !== 1) fail();
  if (current.streamId !== row.streamId) fail();
  if (current.sequence !== row.sequence) fail();
  if (current.idempotencyKey !== row.idempotencyKey) fail();
  if (current.attemptId !== row.attemptId) fail();
  if (current.attemptCount !== row.attemptCount) fail();
  if (current.firstAttemptAt !== row.firstAttemptAt) fail();
  if (current.lastAttemptAt !== row.lastAttemptAt) fail();
  if (current.lastObservedAt !== row.lastObservedAt) fail();
  if (current.nextAttemptAt !== null) fail();
  if (current.claimId !== row.claimId) fail();
  if (current.claimExpiresAt !== row.claimExpiresAt) fail();
  if (current.outcome !== null) fail();
  if (current.deadLetter !== null) fail();
}

/**
 * Load outbox under lease from exact raw bytes; fingerprint is full four-field
 * identity of those raw UTF-8 bytes. Formal outbox read owns full semantics,
 * capacity, continuous sequences, nextSequence, and canonical validation;
 * serializeCanonicalOutbox(formal snapshot) must equal the lease-local exact raw.
 * Missing leaf keeps canonical empty.
 *
 * @param {string} resolvedRoot
 * @returns {Promise<{
 *   outbox: { schemaVersion: number, nextSequence: number, entries: object[] },
 *   outboxPre: {
 *     sha256: string,
 *     byteLength: number,
 *     entryCount: number,
 *     nextSequence: number,
 *   },
 * }>}
 */
async function loadOutboxRawFingerprintUnderRoot(resolvedRoot) {
  let raw;
  try {
    raw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_BYTES },
    );
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
      const empty = { schemaVersion: 1, nextSequence: 1, entries: /** @type {object[]} */ ([]) };
      const emptyRaw = serializeCanonicalOutbox(empty);
      return {
        outbox: empty,
        outboxPre: fingerprintRawText(emptyRaw, 0, 1),
      };
    }
    fail();
  }
  if (typeof raw !== 'string' || raw.length === 0) fail();

  // Formal module: full entry semantics, capacity, continuous sequence,
  // nextSequence continuity, and canonical raw re-serialize equality.
  let outbox;
  try {
    outbox = await readAuditIntegrityAlertOutbox(resolvedRoot);
  } catch {
    fail();
  }
  if (serializeCanonicalOutbox(outbox) !== raw) fail();
  return {
    outbox,
    outboxPre: fingerprintRawText(
      raw,
      outbox.entries.length,
      outbox.nextSequence,
    ),
  };
}

/**
 * Load DLQ under lease from exact raw bytes (or canonical empty when missing).
 *
 * @param {string} resolvedRoot
 * @returns {Promise<{
 *   dlqSnap: {
 *     status: 'empty' | 'ready',
 *     entryCount: number,
 *     nextSequence: number,
 *     entries: object[],
 *   },
 *   deadLetterPre: {
 *     sha256: string,
 *     byteLength: number,
 *     entryCount: number,
 *     nextSequence: number,
 *   },
 * }>}
 */
async function loadDlqRawFingerprintUnderRoot(resolvedRoot) {
  let raw;
  try {
    raw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES },
    );
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
      return {
        dlqSnap: {
          status: 'empty',
          entryCount: 0,
          nextSequence: 1,
          entries: [],
        },
        deadLetterPre: fingerprintRawText(EMPTY_DLQ_RAW, 0, 1),
      };
    }
    fail();
  }
  if (typeof raw !== 'string' || raw.length === 0) fail();
  const deadLetterPre = fingerprintAuditIntegrityAlertDeadLetterRaw(raw);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail();
  }
  if (!isPlainObject(parsed)) fail();
  const record = /** @type {Record<string, unknown>} */ (parsed);
  if (!Array.isArray(record.entries)) fail();
  const dlqSnap = parseDlqSnapshot({
    schemaVersion: 1,
    status: record.entries.length === 0 ? 'empty' : 'ready',
    entryCount: record.entries.length,
    nextSequence: record.nextSequence,
    entries: record.entries,
  });
  if (
    deadLetterPre.entryCount !== dlqSnap.entryCount
    || deadLetterPre.nextSequence !== dlqSnap.nextSequence
  ) {
    fail();
  }
  return { dlqSnap, deadLetterPre };
}

/**
 * Production-only §10 Step 1+2 under one shared write lease:
 * revalidate full in-flight binding, outbox head + four-field raw fingerprint,
 * claim capability, DLQ raw pre/post/capacity; then publish blocked or prepared.
 *
 * @param {unknown} dataDir
 * @param {Record<string, unknown>} inflight
 * @param {string} reason
 * @returns {Promise<
 *   | { kind: 'blocked' }
 *   | {
 *       kind: 'prepared',
 *       callerEntry: object,
 *       deadLetterPost: {
 *         sha256: string,
 *         byteLength: number,
 *         entryCount: number,
 *         nextSequence: number,
 *       },
 *     }
 * >}
 */
async function productionAtomicDeadLetterPreflight(dataDir, inflight, reason) {
  const resolvedRoot = await assertSafeDataRoot(dataDir);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    assertAuditIntegrityWriteLease(resolvedRoot, lease);

    // 1. Revalidate current lifecycle ↔ in-flight full binding.
    const current = parseLifecycle(
      await loadAuditIntegrityAlertDeliveryLifecycle(dataDir),
    );
    assertCurrentInFlightBinding(current, inflight);

    // 2. Outbox exact head + full four-field raw fingerprint.
    const { outbox, outboxPre } = await loadOutboxRawFingerprintUnderRoot(
      resolvedRoot,
    );
    assertOutboxHeadSequence(outbox, inflight.sequence);
    const head = /** @type {Record<string, unknown>} */ (outbox.entries[0]);
    const sourceAlert = sourceAlertFromHead(head);
    const outboxPost = fingerprintOutboxPostAfterAck(outbox);

    // 3. Claim capability still bound.
    const claimState = parseClaimState(
      await loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease),
    );
    if (claimState.status !== 'claimed') fail();
    if (claimState.claimId !== inflight.claimId) fail();
    if (claimState.streamId !== inflight.streamId) fail();
    if (claimState.sequence !== inflight.sequence) fail();

    // 4. DLQ raw pre fingerprint + capacity inputs.
    const { dlqSnap, deadLetterPre } = await loadDlqRawFingerprintUnderRoot(
      resolvedRoot,
    );

    const deadLetterId = randomUUID();
    const callerEntry = buildCallerDlqEntry({
      deadLetterId,
      streamId: /** @type {string} */ (inflight.streamId),
      sequence: /** @type {number} */ (inflight.sequence),
      idempotencyKey: /** @type {string} */ (inflight.idempotencyKey),
      enqueuedAt: /** @type {string} */ (inflight.lastAttemptAt),
      attemptCount: /** @type {number} */ (inflight.attemptCount),
      firstAttemptAt: /** @type {string} */ (inflight.firstAttemptAt),
      lastAttemptAt: /** @type {string} */ (inflight.lastAttemptAt),
      reason,
      sourceAlert,
    });

    // Entry cap → sticky blocked (same lease; no prepared).
    if (dlqSnap.entryCount >= AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES) {
      await publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
        dataDir,
        lease,
        buildBlockedDeadLetterFullRow(inflight),
      );
      return { kind: /** @type {const} */ ('blocked') };
    }

    // Would-be post + byte-cap proof under same lease.
    const wouldBe = wouldBePostFromCaller(callerEntry, dlqSnap);
    if (wouldBe.byteLength > AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES) {
      await publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
        dataDir,
        lease,
        buildBlockedDeadLetterFullRow(inflight),
      );
      return { kind: /** @type {const} */ ('blocked') };
    }

    const deadLetterPost = {
      sha256: wouldBe.sha256,
      byteLength: wouldBe.byteLength,
      entryCount: wouldBe.entryCount,
      nextSequence: wouldBe.nextSequence,
    };

    const nestedDeadLetter = {
      deadLetterId,
      reason,
      sourceAlert,
      claim: {
        claimId: inflight.claimId,
        streamId: inflight.streamId,
        sequence: inflight.sequence,
      },
      deadLetterPre,
      deadLetterPost,
      outboxPre,
      outboxPost,
      preparedAt: inflight.lastAttemptAt,
    };
    assertExactKeyOrder(nestedDeadLetter, DEAD_LETTER_NESTED_KEYS);

    const preparedRow = buildDeadLetterPreparedRow(
      inflight,
      reason,
      nestedDeadLetter,
    );
    await publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
      dataDir,
      lease,
      preparedRow,
    );
    return {
      kind: /** @type {const} */ ('prepared'),
      callerEntry,
      deadLetterPost,
    };
  });
}

/**
 * First-tick dead-letter transaction (§10): preflight → prepared → append →
 * compare → complete → idle. Or sticky blocked on DLQ full before prepared.
 *
 * When production injects atomicDeadLetterPreflight, Step 1+2 run under one
 * shared write lease (binding/outbox/claim/DLQ/capacity/publish). Testing
 * factory leaves the hook unset and uses exact ordered deps calls.
 *
 * @param {Record<string, Function>} deps
 * @param {unknown} dataDir
 * @param {Record<string, unknown>} inflight
 * @param {string} reason
 * @param {number} pendingCount
 * @param {null | ((dataDir: unknown, inflight: Record<string, unknown>, reason: string) => Promise<object>)} atomicPreflight
 * @returns {Promise<Readonly<object>>}
 */
async function runDeadLetterTransaction(
  deps,
  dataDir,
  inflight,
  reason,
  pendingCount,
  atomicPreflight,
) {
  /** @type {object} */
  let callerEntry;
  /** @type {{
   *   sha256: string,
   *   byteLength: number,
   *   entryCount: number,
   *   nextSequence: number,
   * }} */
  let deadLetterPost;

  if (typeof atomicPreflight === 'function') {
    // Production: Step 1+2 atomic under one enqueueAuditIntegrityWriteTask.
    const step12 = await atomicPreflight(dataDir, inflight, reason);
    if (!isPlainObject(step12)) fail();
    const kind = /** @type {Record<string, unknown>} */ (step12).kind;
    if (kind === 'blocked') {
      return publicReceipt({
        status: 'blocked',
        streamId: /** @type {string} */ (inflight.streamId),
        sequence: /** @type {number} */ (inflight.sequence),
        attemptCount: /** @type {number} */ (inflight.attemptCount),
        nextAttemptAt: null,
        pendingCount,
        detail: 'dead-letter-full',
      });
    }
    if (kind !== 'prepared') fail();
    const prepared = /** @type {Record<string, unknown>} */ (step12);
    if (prepared.callerEntry === null || typeof prepared.callerEntry !== 'object') {
      fail();
    }
    callerEntry = /** @type {object} */ (prepared.callerEntry);
    deadLetterPost = parseFingerprint(prepared.deadLetterPost);
  } else {
    // Testing path: exact deps sequence (readDeadLetter → publish → append…).
    const dlqSnap = parseDlqSnapshot(await deps.readDeadLetter(dataDir));
    const deadLetterPre = fingerprintDlqSnapshot(dlqSnap);

    const outbox = parseOutbox(await deps.readOutbox(dataDir));
    assertOutboxHeadSequence(outbox, inflight.sequence);
    const head = /** @type {Record<string, unknown>} */ (outbox.entries[0]);
    const sourceAlert = sourceAlertFromHead(head);
    const outboxPre = fingerprintOutboxSnapshot(outbox);
    const outboxPost = fingerprintOutboxPostAfterAck(outbox);

    const deadLetterId = randomUUID();
    callerEntry = buildCallerDlqEntry({
      deadLetterId,
      streamId: /** @type {string} */ (inflight.streamId),
      sequence: /** @type {number} */ (inflight.sequence),
      idempotencyKey: /** @type {string} */ (inflight.idempotencyKey),
      enqueuedAt: /** @type {string} */ (inflight.lastAttemptAt),
      attemptCount: /** @type {number} */ (inflight.attemptCount),
      firstAttemptAt: /** @type {string} */ (inflight.firstAttemptAt),
      lastAttemptAt: /** @type {string} */ (inflight.lastAttemptAt),
      reason,
      sourceAlert,
    });

    if (dlqSnap.entryCount >= AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES) {
      await publishLifecycle(
        deps,
        dataDir,
        buildBlockedDeadLetterFullRow(inflight),
      );
      return publicReceipt({
        status: 'blocked',
        streamId: /** @type {string} */ (inflight.streamId),
        sequence: /** @type {number} */ (inflight.sequence),
        attemptCount: /** @type {number} */ (inflight.attemptCount),
        nextAttemptAt: null,
        pendingCount,
        detail: 'dead-letter-full',
      });
    }

    const wouldBe = wouldBePostFromCaller(callerEntry, dlqSnap);
    if (wouldBe.byteLength > AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES) {
      await publishLifecycle(
        deps,
        dataDir,
        buildBlockedDeadLetterFullRow(inflight),
      );
      return publicReceipt({
        status: 'blocked',
        streamId: /** @type {string} */ (inflight.streamId),
        sequence: /** @type {number} */ (inflight.sequence),
        attemptCount: /** @type {number} */ (inflight.attemptCount),
        nextAttemptAt: null,
        pendingCount,
        detail: 'dead-letter-full',
      });
    }

    deadLetterPost = {
      sha256: wouldBe.sha256,
      byteLength: wouldBe.byteLength,
      entryCount: wouldBe.entryCount,
      nextSequence: wouldBe.nextSequence,
    };

    const nestedDeadLetter = {
      deadLetterId,
      reason,
      sourceAlert,
      claim: {
        claimId: inflight.claimId,
        streamId: inflight.streamId,
        sequence: inflight.sequence,
      },
      deadLetterPre,
      deadLetterPost,
      outboxPre,
      outboxPost,
      preparedAt: inflight.lastAttemptAt,
    };
    assertExactKeyOrder(nestedDeadLetter, DEAD_LETTER_NESTED_KEYS);

    const preparedRow = buildDeadLetterPreparedRow(
      inflight,
      reason,
      nestedDeadLetter,
    );
    await publishLifecycle(deps, dataDir, preparedRow);
  }

  // Step 3 — append under independent lease; compare returned actual post.
  const actualPostRaw = await deps.appendDeadLetter(dataDir, callerEntry);
  const actualPost = parseFingerprint(actualPostRaw);
  if (!fingerprintsEqual(actualPost, deadLetterPost)) {
    // Fail closed: no complete, no release, no idle; stay prepared.
    fail();
  }

  // Step 4 — complete exact head (ack then clear claim).
  const capability = exactCapability({
    claimId: /** @type {string} */ (inflight.claimId),
    streamId: /** @type {string} */ (inflight.streamId),
    sequence: /** @type {number} */ (inflight.sequence),
  });
  const completed = parseCompleteReceipt(
    await deps.completeDelivery(dataDir, capability),
  );
  if (completed.streamId !== capability.streamId) fail();
  if (completed.sequence !== capability.sequence) fail();

  // Step 5 — idle watermark retained; claim fields finally N.
  await publishLifecycle(
    deps,
    dataDir,
    buildIdleRow(inflight.lastObservedAt),
  );

  return publicReceipt({
    status: 'dead-lettered',
    streamId: completed.streamId,
    sequence: completed.sequence,
    attemptCount: /** @type {number} */ (inflight.attemptCount),
    nextAttemptAt: null,
    pendingCount: completed.pendingCount,
    detail: reason,
  });
}

/**
 * Crash recovery for durable dead-letter-prepared (§11.1).
 *
 * @param {Record<string, Function>} deps
 * @param {unknown} dataDir
 * @param {Record<string, unknown>} lifecycle
 * @returns {Promise<Readonly<object>>}
 */
async function recoverDeadLetterPrepared(deps, dataDir, lifecycle) {
  const prepared = /** @type {Record<string, unknown>} */ (lifecycle.deadLetter);
  if (prepared === null || typeof prepared !== 'object') fail();
  const sequence = /** @type {number} */ (lifecycle.sequence);
  const streamId = /** @type {string} */ (lifecycle.streamId);
  const reason = /** @type {string} */ (prepared.reason);
  const preparedPost = parseFingerprint(prepared.deadLetterPost);

  const outbox = parseOutbox(await deps.readOutbox(dataDir));
  const claimState = parseClaimState(await deps.loadClaimState(dataDir));
  const dlq = parseDlqSnapshot(await deps.readDeadLetter(dataDir));

  /** @type {'pre' | 'post'} */
  let outboxRelation;
  if (outbox.entries.length === 0) {
    outboxRelation = 'post';
  } else {
    const headSeq = /** @type {Record<string, unknown>} */ (outbox.entries[0])
      .sequence;
    if (headSeq === sequence) {
      outboxRelation = 'pre';
    } else if (
      typeof headSeq === 'number'
      && headSeq > sequence
    ) {
      outboxRelation = 'post';
    } else {
      fail();
    }
  }

  /** @type {object | null} */
  let matchingEntry = null;
  for (const entry of dlq.entries) {
    const e = /** @type {Record<string, unknown>} */ (entry);
    if (e.streamId === streamId && e.sequence === sequence) {
      matchingEntry = entry;
      break;
    }
  }
  const dlqRelation = matchingEntry !== null ? 'post' : 'pre';

  // DLQ pre + outbox post → fail closed (outbox advanced without DLQ evidence).
  if (dlqRelation === 'pre' && outboxRelation === 'post') {
    fail();
  }

  if (matchingEntry !== null) {
    if (!persistedEntryMatchesPrepared(matchingEntry, prepared, lifecycle)) {
      fail();
    }
  }

  // Outbox still has the bound head.
  // §11.1 truth table (outbox-pre branch):
  //   DLQ-post → step 4 complete/ack only — NEVER append
  //   DLQ-pre  → step 3 append + compare, then step 4
  // Entry identity (streamId, sequence) is the sole post/pre axis here.
  // Do not re-append merely because prepared.deadLetterPre !== deadLetterPost
  // or because a static prepared post SHA differs from reconstructed live
  // bytes — that would violate post/pre append=0 (9D).
  if (outboxRelation === 'pre') {
    if (dlqRelation === 'pre') {
      // Step 3 — resume append; sole continue condition is actual === prepared.
      const callerEntry = buildCallerDlqEntry({
        deadLetterId: /** @type {string} */ (prepared.deadLetterId),
        streamId,
        sequence,
        idempotencyKey: /** @type {string} */ (lifecycle.idempotencyKey),
        enqueuedAt: /** @type {string} */ (lifecycle.lastAttemptAt),
        attemptCount: /** @type {number} */ (lifecycle.attemptCount),
        firstAttemptAt: /** @type {string} */ (lifecycle.firstAttemptAt),
        lastAttemptAt: /** @type {string} */ (lifecycle.lastAttemptAt),
        reason,
        sourceAlert: /** @type {object} */ (prepared.sourceAlert),
      });
      const actualPostRaw = await deps.appendDeadLetter(dataDir, callerEntry);
      const actualPost = parseFingerprint(actualPostRaw);
      if (!fingerprintsEqual(actualPost, preparedPost)) {
        fail();
      }
    }
    // else dlqRelation === 'post': step 4 only — zero appendDeadLetter calls.

    const capability = exactCapability({
      claimId: /** @type {string} */ (lifecycle.claimId),
      streamId,
      sequence,
    });
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
      status: 'dead-lettered',
      streamId: completed.streamId,
      sequence: completed.sequence,
      attemptCount: /** @type {number} */ (lifecycle.attemptCount),
      nextAttemptAt: null,
      pendingCount: completed.pendingCount,
      detail: reason,
    });
  }

  // outbox post + dlq post
  if (dlqRelation !== 'post') fail();

  if (claimState.status === 'claimed') {
    if (claimState.claimId !== lifecycle.claimId) fail();
    if (claimState.streamId !== streamId) fail();
    if (claimState.sequence !== sequence) fail();

    const capability = exactCapability({
      claimId: /** @type {string} */ (lifecycle.claimId),
      streamId,
      sequence,
    });
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
      status: 'dead-lettered',
      streamId: completed.streamId,
      sequence: completed.sequence,
      attemptCount: /** @type {number} */ (lifecycle.attemptCount),
      nextAttemptAt: null,
      pendingCount: completed.pendingCount,
      detail: reason,
    });
  }

  if (claimState.status === 'idle') {
    // Lifecycle idle only; no complete/append/network.
    await publishLifecycle(
      deps,
      dataDir,
      buildIdleRow(lifecycle.lastObservedAt),
    );

    return publicReceipt({
      status: 'dead-lettered',
      streamId,
      sequence,
      attemptCount: /** @type {number} */ (lifecycle.attemptCount),
      nextAttemptAt: null,
      pendingCount: outbox.entries.length,
      detail: reason,
    });
  }

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
 * @param {null | ((dataDir: unknown, inflight: Record<string, unknown>, reason: string) => Promise<object>)} atomicPreflight
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
  atomicPreflight,
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
    atomicPreflight,
  );
}

/**
 * Core tick bound to snapshotted dependency functions.
 * Optional production-only atomicDeadLetterPreflight is never part of the
 * testing factory exact ordered deps contract.
 *
 * @param {Record<string, Function>} deps
 * @param {null | ((dataDir: unknown, inflight: Record<string, unknown>, reason: string) => Promise<object>)} [atomicDeadLetterPreflight]
 * @returns {(dataDir: unknown, endpoint: unknown, now: unknown) => Promise<Readonly<object>>}
 */
function createTick(deps, atomicDeadLetterPreflight = null) {
  const atomicPreflight =
    typeof atomicDeadLetterPreflight === 'function'
      ? atomicDeadLetterPreflight
      : null;

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

      // Sticky dead-letter-full blocked: after authorize + loadLifecycle,
      // before readOutbox — zero extra mutation/network.
      if (lifecycle.status === 'blocked') {
        const outcome = /** @type {{ kind: string, detail: string | null }} */ (
          lifecycle.outcome
        );
        if (outcome.kind !== 'blocked' || outcome.detail !== 'dead-letter-full') {
          fail();
        }
        return publicReceipt({
          status: 'blocked',
          streamId: /** @type {string} */ (lifecycle.streamId),
          sequence: /** @type {number} */ (lifecycle.sequence),
          attemptCount: /** @type {number} */ (lifecycle.attemptCount),
          nextAttemptAt: null,
          // Head retained; sticky short-circuit cannot observe outbox length.
          pendingCount: 1,
          detail: 'dead-letter-full',
        });
      }

      // Dead-letter-prepared crash recovery before ordinary outbox head work.
      // Recovery itself re-reads outbox/claim/DLQ under its own steps.
      if (lifecycle.status === 'dead-letter-prepared') {
        return recoverDeadLetterPrepared(deps, dataDir, lifecycle);
      }

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
          atomicPreflight,
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
          atomicPreflight,
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
 * @param {null | ((dataDir: unknown, inflight: Record<string, unknown>, reason: string) => Promise<object>)} atomicPreflight
 * @returns {Promise<Readonly<object>>}
 */
async function enterAttempt(
  deps,
  dataDir,
  claim,
  priorLifecycle,
  now,
  pendingCount,
  atomicPreflight,
) {
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

  // Terminal / attempts-exhausted → dead-letter transaction (§10).
  if (
    decision === 'dead-letter-terminal-http'
    || decision === 'dead-letter-attempts-exhausted-retryable'
    || decision === 'dead-letter-attempts-exhausted-uncertain'
  ) {
    const reason = reasonFromDecision(decision);
    return runDeadLetterTransaction(
      deps,
      dataDir,
      inflight,
      reason,
      pendingCount,
      atomicPreflight,
    );
  }

  fail();
}

/**
 * Residual production publish of dead-letter-prepared / blocked under one
 * shared write lease. Primary production path uses productionAtomicDeadLetterPreflight
 * (Step 1+2 atomic). This residual path still fail-closes with full binding,
 * full four-field outbox raw fingerprint compare, claim capability, and
 * lease-proven entry-cap (blocked) or prepared nested proof.
 *
 * @param {unknown} dataDir
 * @param {object} state
 * @returns {Promise<unknown>}
 */
async function publishPreparedOrBlockedUnderLease(dataDir, state) {
  const resolvedRoot = await assertSafeDataRoot(dataDir);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    assertAuditIntegrityWriteLease(resolvedRoot, lease);

    const row = parseLifecycle(state);
    if (row.status !== 'dead-letter-prepared' && row.status !== 'blocked') {
      fail();
    }

    // Full in-flight binding (not watermark-only).
    const current = parseLifecycle(
      await loadAuditIntegrityAlertDeliveryLifecycle(dataDir),
    );
    assertCurrentInFlightMatchesTargetRow(current, row);

    // Outbox exact head + full four-field raw fingerprint.
    const { outbox, outboxPre: liveOutboxPre } =
      await loadOutboxRawFingerprintUnderRoot(resolvedRoot);
    assertOutboxHeadSequence(outbox, row.sequence);

    // Claim capability still bound for prepared/blocked matrix (fields V).
    const claimState = parseClaimState(
      await loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease),
    );
    if (claimState.status !== 'claimed') fail();
    if (claimState.claimId !== row.claimId) fail();
    if (claimState.streamId !== row.streamId) fail();
    if (claimState.sequence !== row.sequence) fail();

    // DLQ raw identity. Corrupt fails closed with zero mutation.
    const { dlqSnap, deadLetterPre: liveDlqPre } =
      await loadDlqRawFingerprintUnderRoot(resolvedRoot);

    if (row.status === 'blocked') {
      // Residual blocked publish: re-prove entry cap under lease only.
      // Byte-cap blocked is decided inside productionAtomicDeadLetterPreflight
      // (candidate serialized under the same lease). Never accept blocked
      // when entryCount is below MAX without that proof.
      if (dlqSnap.entryCount < AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES) {
        fail();
      }
    }

    if (row.status === 'dead-letter-prepared') {
      const nested = /** @type {Record<string, unknown>} */ (row.deadLetter);
      const pre = parseFingerprint(nested.deadLetterPre);
      if (!fingerprintsEqual(pre, liveDlqPre)) fail();
      const post = parseFingerprint(nested.deadLetterPost);
      if (post.entryCount > AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES) {
        fail();
      }
      if (post.byteLength > AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES) {
        fail();
      }
      // Full four-field outbox fingerprint (sha256/byteLength/entryCount/nextSequence).
      const preparedOutboxPre = parseFingerprint(nested.outboxPre);
      if (!fingerprintsEqual(preparedOutboxPre, liveOutboxPre)) fail();
      const preparedOutboxPost = parseFingerprint(nested.outboxPost);
      const liveOutboxPost = fingerprintOutboxPostAfterAck(outbox);
      if (!fingerprintsEqual(preparedOutboxPost, liveOutboxPost)) fail();
    }

    return publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
      dataDir,
      lease,
      state,
    );
  });
}

/**
 * Production adapters: real claim/complete/release, lifecycle under shared
 * write lease, outbox/claim-state/DLQ, detailed HTTPS executor, pure policy.
 * Does not include the production-only atomic preflight hook (injected via
 * createTick second argument by tickAuditIntegrityAlertDelivery).
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
      // Residual prepared/blocked path (primary path uses atomic preflight).
      if (
        state
        && typeof state === 'object'
        && !Array.isArray(state)
        && (
          /** @type {{ status?: unknown }} */ (state).status === 'dead-letter-prepared'
          || /** @type {{ status?: unknown }} */ (state).status === 'blocked'
        )
      ) {
        return publishPreparedOrBlockedUnderLease(dataDir, state);
      }
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
      // Independent durable step: re-acquire shared write lease.
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
 * capability, then advance at most one unit of work. Injects production-only
 * atomic dead-letter preflight into createTick (not part of testing deps).
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
    // Production-only: §10 Step 1+2 under one shared write lease.
    const tick = createTick(deps, productionAtomicDeadLetterPreflight);
    return await tick(dataDir, endpoint, now);
  } catch {
    throw unavailableError();
  }
}

/**
 * Test-only factory. deps must be a plain non-Proxy data object with exact
 * ordered §5.5 keys (all functions). Snapshots the fourteen functions; later
 * mutation of deps cannot rebind the returned tick. Never invokes Proxy or
 * accessor traps on hostile deps. Does not inject production atomic preflight.
 *
 * Returned tick is called as tick(dataDir, endpoint, now).
 *
 * @param {unknown} deps
 * @returns {(dataDir: unknown, endpoint: unknown, now: unknown) => Promise<Readonly<object>>}
 */
export function createAuditIntegrityAlertDeliveryRetryForTesting(deps) {
  try {
    const bound = bindDeps(deps);
    return createTick(bound, null);
  } catch {
    throw unavailableError();
  }
}
