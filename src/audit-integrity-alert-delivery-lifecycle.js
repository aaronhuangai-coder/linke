/**
 * Canonical lifecycle WAL for audit integrity alert delivery (Task 2).
 *
 * Owns parse / serialize / load / publish / idle assertion / idle factory.
 * Missing leaf is logical idle (null watermark) without creating the file.
 * All public failures collapse to path-free audit-delivery-unavailable.
 *
 * Does NOT import clocks, process identity, outbox, claim algorithms, stream,
 * request, transport, agent, server, network, DLQ, or retry coordinator modules.
 * Does NOT perform claim/complete/release/tick.
 *
 * Hostile object contract: utilTypes.isProxy first (no traps), then plain
 * Object.prototype only + Reflect.ownKeys exact order + own enumerable data
 * descriptors only. Never JSON.stringify(hostile) before validating descriptors.
 * Full-file raw identity: compact JSON + exactly one trailing newline.
 */

import { types as utilTypes } from 'node:util';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertAuditIntegrityWriteLease } from './audit-integrity-write-queue.js';
import {
  assertSafeDataRoot,
  safeAtomicWriteText,
  safeReadText,
} from './safe-data-files.js';

/** Relative path under data root for the single-object lifecycle WAL. */
export const AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH =
  'audit/integrity-alert-delivery-lifecycle.json';

/**
 * safeReadText / publish maxBytes bound. Fixed positive safe integer large enough
 * for the largest legal dead-letter-prepared fixture and small path-free rows.
 */
export const AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES = 16_384;

const SCHEMA_VERSION = 1;

const TOP_KEYS = Object.freeze([
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

const OUTCOME_KEYS = Object.freeze(['kind', 'detail']);
const DEAD_LETTER_KEYS = Object.freeze([
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
const CLAIM_NESTED_KEYS = Object.freeze(['claimId', 'streamId', 'sequence']);
const FINGERPRINT_KEYS = Object.freeze([
  'sha256',
  'byteLength',
  'entryCount',
  'nextSequence',
]);

const STATUS_IDLE = 'idle';
const STATUS_IN_FLIGHT = 'in-flight';
const STATUS_RETRY_WAIT = 'retry-wait';
const STATUS_ACCEPTED_PENDING = 'accepted-pending-completion';
const STATUS_DEAD_LETTER_PREPARED = 'dead-letter-prepared';
const STATUS_BLOCKED = 'blocked';

const DEAD_LETTER_REASONS = Object.freeze([
  'terminal-http',
  'attempts-exhausted-retryable',
  'attempts-exhausted-uncertain',
]);

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const PATH_FREE_TOKEN_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

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
 * Plain data object: not null/array/Proxy; prototype must be Object.prototype
 * (null-prototype objects are rejected by the hostile contract).
 * utilTypes.isProxy runs BEFORE getPrototypeOf / ownKeys so traps never fire.
 *
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (utilTypes.isProxy(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Reject Proxy / non-plain / symbol / non-enumerable / accessor own keys.
 * isProxy first — do not call Proxy traps then decide.
 *
 * @param {unknown} value
 * @returns {object}
 */
function assertPlainDataObject(value) {
  if (!isPlainObject(value)) fail();
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key === 'symbol') fail();
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
 * Exact Reflect.ownKeys order (call only after assertPlainDataObject so every
 * own key is already an enumerable string data property).
 *
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
 * Canonical lowercase UUIDv4.
 * @param {unknown} value
 * @returns {string}
 */
function assertUuidV4(value) {
  if (typeof value !== 'string' || !UUID_V4_RE.test(value)) fail();
  return value;
}

/**
 * Canonical millisecond UTC ISO string (Date#toISOString identity).
 * @param {unknown} value
 * @returns {string}
 */
function assertMsUtc(value) {
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
 * Path-free closed token (kebab-case, no path/secret material).
 * @param {unknown} value
 * @returns {string}
 */
function assertPathFreeToken(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    fail();
  }
  if (!PATH_FREE_TOKEN_RE.test(value)) fail();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertSha256Hex(value) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) fail();
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
 * Fresh canonical idle object (unfrozen).
 * @param {null|string} lastObservedAt
 * @returns {object}
 */
function buildIdleCanonical(lastObservedAt) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: STATUS_IDLE,
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
  };
}

/**
 * @param {unknown} value
 * @returns {{ kind: string, detail: string|null }}
 */
function parseOutcomeObject(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, OUTCOME_KEYS);
  if (typeof obj.kind !== 'string') fail();
  if (obj.detail !== null && typeof obj.detail !== 'string') fail();
  return {
    kind: obj.kind,
    detail: obj.detail,
  };
}

/**
 * @param {unknown} value
 * @returns {{ sha256: string, byteLength: number, entryCount: number, nextSequence: number }}
 */
function parseFingerprint(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, FINGERPRINT_KEYS);
  return {
    sha256: assertSha256Hex(obj.sha256),
    byteLength: assertNonNegativeSafeInteger(obj.byteLength),
    entryCount: assertNonNegativeSafeInteger(obj.entryCount),
    nextSequence: assertPositiveSafeInteger(obj.nextSequence),
  };
}

/**
 * @param {unknown} value
 * @param {number} expectedSequence
 * @returns {object}
 */
function parseSourceAlert(value, expectedSequence) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, SOURCE_ALERT_KEYS);
  const sequence = assertPositiveSafeInteger(obj.sequence);
  if (sequence !== expectedSequence) fail();
  const checkedAt = assertMsUtc(obj.checkedAt);
  const code = assertPathFreeToken(obj.code);
  if (typeof obj.recoveryRequired !== 'boolean') fail();
  const nextAction = assertPathFreeToken(obj.nextAction);
  let reasonCode = null;
  if (obj.reasonCode !== null) {
    reasonCode = assertPathFreeToken(obj.reasonCode);
  }
  return {
    sequence,
    checkedAt,
    code,
    recoveryRequired: obj.recoveryRequired,
    nextAction,
    reasonCode,
  };
}

/**
 * @param {unknown} value
 * @param {string} expectedClaimId
 * @param {string} expectedStreamId
 * @param {number} expectedSequence
 * @returns {{ claimId: string, streamId: string, sequence: number }}
 */
function parseNestedClaim(value, expectedClaimId, expectedStreamId, expectedSequence) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, CLAIM_NESTED_KEYS);
  const claimId = assertUuidV4(obj.claimId);
  const streamId = assertUuidV4(obj.streamId);
  const sequence = assertPositiveSafeInteger(obj.sequence);
  if (claimId !== expectedClaimId) fail();
  if (streamId !== expectedStreamId) fail();
  if (sequence !== expectedSequence) fail();
  return { claimId, streamId, sequence };
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
 * @param {string} topClaimId
 * @param {string} topStreamId
 * @param {number} topSequence
 * @param {{ kind: string, detail: string|null }} outcome
 * @returns {object}
 */
function parseDeadLetter(value, topClaimId, topStreamId, topSequence, outcome) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, DEAD_LETTER_KEYS);

  const deadLetterId = assertUuidV4(obj.deadLetterId);
  if (typeof obj.reason !== 'string') fail();
  if (!DEAD_LETTER_REASONS.includes(obj.reason)) fail();
  const reason = obj.reason;

  // Terminal family binding: outcome kind/detail must match nested reason.
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

  const sourceAlert = parseSourceAlert(obj.sourceAlert, topSequence);
  const claim = parseNestedClaim(obj.claim, topClaimId, topStreamId, topSequence);
  const deadLetterPre = parseFingerprint(obj.deadLetterPre);
  const deadLetterPost = parseFingerprint(obj.deadLetterPost);
  const outboxPre = parseFingerprint(obj.outboxPre);
  const outboxPost = parseFingerprint(obj.outboxPost);
  const preparedAt = assertMsUtc(obj.preparedAt);

  const appendOk = deadLetterPost.entryCount === deadLetterPre.entryCount + 1
    && deadLetterPost.nextSequence === deadLetterPre.nextSequence + 1
    && Number.isSafeInteger(deadLetterPre.entryCount + 1)
    && Number.isSafeInteger(deadLetterPre.nextSequence + 1);
  const idempotentOk = fingerprintsEqual(deadLetterPre, deadLetterPost);
  if (!appendOk && !idempotentOk) fail();

  if (outboxPre.entryCount < 1) fail();
  if (outboxPost.entryCount !== outboxPre.entryCount - 1) fail();
  if (outboxPost.nextSequence !== outboxPre.nextSequence) fail();

  return {
    deadLetterId,
    reason,
    sourceAlert,
    claim,
    deadLetterPre,
    deadLetterPost,
    outboxPre,
    outboxPost,
    preparedAt,
  };
}

/**
 * @param {unknown} claimId
 * @param {unknown} claimExpiresAt
 * @returns {{ claimId: string, claimExpiresAt: string }}
 */
function parseClaimPairRequired(claimId, claimExpiresAt) {
  if (claimId === null || claimExpiresAt === null) fail();
  return {
    claimId: assertUuidV4(claimId),
    claimExpiresAt: assertMsUtc(claimExpiresAt),
  };
}

/**
 * @param {string} streamId
 * @param {number} sequence
 * @param {unknown} idempotencyKey
 * @returns {string}
 */
function assertIdempotencyKey(streamId, sequence, idempotencyKey) {
  const expected = `audit-integrity-alert:${streamId}:${sequence}`;
  if (typeof idempotencyKey !== 'string' || idempotencyKey !== expected) fail();
  return expected;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function assertAttemptCountRange(value, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail();
  if (value < min || value > max) fail();
  return value;
}

/**
 * Shared object-schema entry for caller objects and JSON.parse output.
 * Asserts plain data on the original value first (Proxy/class rejected before
 * any nested field walk / stringify whitewash).
 *
 * @param {unknown} value
 * @returns {object} unfrozen canonical state (defensive snapshot)
 */
function parseStateObject(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, TOP_KEYS);

  if (obj.schemaVersion !== SCHEMA_VERSION) fail();
  if (typeof obj.status !== 'string') fail();

  const status = obj.status;

  if (status === STATUS_IDLE) {
    let lastObservedAt = null;
    if (obj.lastObservedAt !== null) {
      lastObservedAt = assertMsUtc(obj.lastObservedAt);
    }
    if (obj.streamId !== null) fail();
    if (obj.sequence !== null) fail();
    if (obj.idempotencyKey !== null) fail();
    if (obj.attemptId !== null) fail();
    if (obj.attemptCount !== 0) fail();
    if (obj.firstAttemptAt !== null) fail();
    if (obj.lastAttemptAt !== null) fail();
    if (obj.nextAttemptAt !== null) fail();
    if (obj.claimId !== null) fail();
    if (obj.claimExpiresAt !== null) fail();
    if (obj.outcome !== null) fail();
    if (obj.deadLetter !== null) fail();
    return buildIdleCanonical(lastObservedAt);
  }

  // All non-idle rows require full binding fields except status-specific nulls.
  const lastObservedAt = assertMsUtc(obj.lastObservedAt);
  const streamId = assertUuidV4(obj.streamId);
  const sequence = assertPositiveSafeInteger(obj.sequence);
  const idempotencyKey = assertIdempotencyKey(streamId, sequence, obj.idempotencyKey);
  const attemptId = assertUuidV4(obj.attemptId);
  const firstAttemptAt = assertMsUtc(obj.firstAttemptAt);
  const lastAttemptAt = assertMsUtc(obj.lastAttemptAt);

  if (status === STATUS_IN_FLIGHT) {
    const attemptCount = assertAttemptCountRange(obj.attemptCount, 1, 8);
    if (obj.nextAttemptAt !== null) fail();
    if (obj.outcome !== null) fail();
    if (obj.deadLetter !== null) fail();
    const claim = parseClaimPairRequired(obj.claimId, obj.claimExpiresAt);
    return {
      schemaVersion: SCHEMA_VERSION,
      status: STATUS_IN_FLIGHT,
      lastObservedAt,
      streamId,
      sequence,
      idempotencyKey,
      attemptId,
      attemptCount,
      firstAttemptAt,
      lastAttemptAt,
      nextAttemptAt: null,
      claimId: claim.claimId,
      claimExpiresAt: claim.claimExpiresAt,
      outcome: null,
      deadLetter: null,
    };
  }

  if (status === STATUS_RETRY_WAIT) {
    const attemptCount = assertAttemptCountRange(obj.attemptCount, 1, 7);
    const nextAttemptAt = assertMsUtc(obj.nextAttemptAt);
    if (obj.deadLetter !== null) fail();
    if (obj.outcome === null) fail();
    const outcome = parseOutcomeObject(obj.outcome);

    if (outcome.kind === 'unknown') {
      if (outcome.detail !== null && outcome.detail !== 'uncertain-network') fail();
      const claim = parseClaimPairRequired(obj.claimId, obj.claimExpiresAt);
      return {
        schemaVersion: SCHEMA_VERSION,
        status: STATUS_RETRY_WAIT,
        lastObservedAt,
        streamId,
        sequence,
        idempotencyKey,
        attemptId,
        attemptCount,
        firstAttemptAt,
        lastAttemptAt,
        nextAttemptAt,
        claimId: claim.claimId,
        claimExpiresAt: claim.claimExpiresAt,
        outcome: { kind: 'unknown', detail: outcome.detail },
        deadLetter: null,
      };
    }

    if (outcome.kind === 'retryable-rejected') {
      if (outcome.detail !== 'retryable-http') fail();
      // Dual claim binding: both V or both N only.
      let claimId = null;
      let claimExpiresAt = null;
      if (obj.claimId === null && obj.claimExpiresAt === null) {
        // release completed
      } else {
        const claim = parseClaimPairRequired(obj.claimId, obj.claimExpiresAt);
        claimId = claim.claimId;
        claimExpiresAt = claim.claimExpiresAt;
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        status: STATUS_RETRY_WAIT,
        lastObservedAt,
        streamId,
        sequence,
        idempotencyKey,
        attemptId,
        attemptCount,
        firstAttemptAt,
        lastAttemptAt,
        nextAttemptAt,
        claimId,
        claimExpiresAt,
        outcome: { kind: 'retryable-rejected', detail: 'retryable-http' },
        deadLetter: null,
      };
    }

    fail();
  }

  if (status === STATUS_ACCEPTED_PENDING) {
    const attemptCount = assertAttemptCountRange(obj.attemptCount, 1, 8);
    if (obj.nextAttemptAt !== null) fail();
    if (obj.deadLetter !== null) fail();
    if (obj.outcome === null) fail();
    const outcome = parseOutcomeObject(obj.outcome);
    if (outcome.kind !== 'accepted' || outcome.detail !== null) fail();
    const claim = parseClaimPairRequired(obj.claimId, obj.claimExpiresAt);
    return {
      schemaVersion: SCHEMA_VERSION,
      status: STATUS_ACCEPTED_PENDING,
      lastObservedAt,
      streamId,
      sequence,
      idempotencyKey,
      attemptId,
      attemptCount,
      firstAttemptAt,
      lastAttemptAt,
      nextAttemptAt: null,
      claimId: claim.claimId,
      claimExpiresAt: claim.claimExpiresAt,
      outcome: { kind: 'accepted', detail: null },
      deadLetter: null,
    };
  }

  if (status === STATUS_DEAD_LETTER_PREPARED) {
    const attemptCount = assertAttemptCountRange(obj.attemptCount, 1, 8);
    if (obj.nextAttemptAt !== null) fail();
    if (obj.outcome === null) fail();
    if (obj.deadLetter === null) fail();
    const outcome = parseOutcomeObject(obj.outcome);
    const claim = parseClaimPairRequired(obj.claimId, obj.claimExpiresAt);
    const deadLetter = parseDeadLetter(
      obj.deadLetter,
      claim.claimId,
      streamId,
      sequence,
      outcome,
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      status: STATUS_DEAD_LETTER_PREPARED,
      lastObservedAt,
      streamId,
      sequence,
      idempotencyKey,
      attemptId,
      attemptCount,
      firstAttemptAt,
      lastAttemptAt,
      nextAttemptAt: null,
      claimId: claim.claimId,
      claimExpiresAt: claim.claimExpiresAt,
      outcome: { kind: outcome.kind, detail: outcome.detail },
      deadLetter,
    };
  }

  if (status === STATUS_BLOCKED) {
    const attemptCount = assertAttemptCountRange(obj.attemptCount, 1, 8);
    if (obj.nextAttemptAt !== null) fail();
    if (obj.deadLetter !== null) fail();
    if (obj.outcome === null) fail();
    const outcome = parseOutcomeObject(obj.outcome);
    if (outcome.kind !== 'blocked' || outcome.detail !== 'dead-letter-full') fail();
    const claim = parseClaimPairRequired(obj.claimId, obj.claimExpiresAt);
    return {
      schemaVersion: SCHEMA_VERSION,
      status: STATUS_BLOCKED,
      lastObservedAt,
      streamId,
      sequence,
      idempotencyKey,
      attemptId,
      attemptCount,
      firstAttemptAt,
      lastAttemptAt,
      nextAttemptAt: null,
      claimId: claim.claimId,
      claimExpiresAt: claim.claimExpiresAt,
      outcome: { kind: 'blocked', detail: 'dead-letter-full' },
      deadLetter: null,
    };
  }

  fail();
}

/**
 * Rebuild canonical JSON text with frozen key order + exactly one trailing newline.
 * @param {object} state already-validated canonical state
 * @returns {string}
 */
function serializeCanonicalState(state) {
  return `${JSON.stringify(state)}\n`;
}

/**
 * Pure strict parser for lifecycle WAL text.
 * Requires exactly one trailing newline; rejects BOM, empty, multi-line body,
 * trailing garbage, and non-canonical raw after schema parse.
 *
 * @param {string} raw
 * @returns {Readonly<object>}
 */
function parseLifecycleText(raw) {
  if (typeof raw !== 'string') fail();
  if (
    Buffer.byteLength(raw, 'utf8')
    > AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES
  ) {
    fail();
  }
  if (raw.length === 0) fail();
  if (raw.charCodeAt(0) === 0xfeff) fail();
  if (!raw.endsWith('\n')) fail();
  const text = raw.slice(0, -1);
  if (text.length === 0) fail();
  if (text.includes('\n')) fail();
  if (/^\s/.test(text) || /\s$/.test(text)) fail();

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail();
  }

  const canonical = parseStateObject(value);
  if (serializeCanonicalState(canonical) !== raw) fail();
  return deepFreeze(canonical);
}

/**
 * @param {null|string} previous
 * @param {null|string} next
 * @returns {boolean}
 */
function isWatermarkRollback(previous, next) {
  if (previous === null) return false;
  if (next === null) return true;
  return next < previous;
}

/**
 * Load lifecycle WAL from dataDir.
 * Missing leaf → fresh deep-frozen canonical idle (null watermark) without
 * creating the file. Corrupt / oversize / symlink / directory → unavailable.
 *
 * @param {unknown} dataDir
 * @returns {Promise<Readonly<object>>}
 */
export async function loadAuditIntegrityAlertDeliveryLifecycle(dataDir) {
  try {
    const resolvedRoot = await assertSafeDataRoot(dataDir);

    let raw;
    try {
      raw = await safeReadText(
        resolvedRoot,
        AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH,
        { maxBytes: AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES },
      );
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return deepFreeze(buildIdleCanonical(null));
      }
      fail();
    }

    return parseLifecycleText(raw);
  } catch {
    throw unavailableError();
  }
}

/**
 * Atomic publish of lifecycle WAL under an active same-root audit write lease.
 * Resolves the safe root, asserts the lease before any read or write, validates
 * state, loads previous canonical state under the lease, rejects lastObservedAt
 * rollback when a previous non-null watermark is later, writes mode 0600 within
 * the max-byte bound, reopens with exact raw equality, then returns a new
 * deep-frozen exact-key copy.
 *
 * @param {unknown} dataDir
 * @param {unknown} lease
 * @param {unknown} state
 * @returns {Promise<Readonly<object>>}
 */
export async function publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
  dataDir,
  lease,
  state,
) {
  try {
    const resolvedRoot = await assertSafeDataRoot(dataDir);
    assertAuditIntegrityWriteLease(resolvedRoot, lease);

    // Defensive snapshot + bounds before first await after lease assert
    // (no stringify whitewash of hostile inputs).
    const canonical = parseStateObject(state);
    const expectedText = serializeCanonicalState(canonical);
    if (
      Buffer.byteLength(expectedText, 'utf8')
      > AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES
    ) {
      fail();
    }

    let previousRaw;
    let previous = null;
    try {
      previousRaw = await safeReadText(
        resolvedRoot,
        AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH,
        { maxBytes: AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES },
      );
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        previous = deepFreeze(buildIdleCanonical(null));
        previousRaw = null;
      } else {
        fail();
      }
    }
    if (previousRaw !== null) {
      previous = parseLifecycleText(previousRaw);
    }

    if (
      isWatermarkRollback(
        /** @type {{ lastObservedAt: null|string }} */ (previous).lastObservedAt,
        canonical.lastObservedAt,
      )
    ) {
      fail();
    }

    try {
      await safeAtomicWriteText(
        resolvedRoot,
        AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH,
        expectedText,
        { mode: 0o600 },
      );
    } catch {
      fail();
    }

    let postRaw;
    try {
      postRaw = await safeReadText(
        resolvedRoot,
        AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH,
        { maxBytes: AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES },
      );
    } catch {
      fail();
    }

    if (postRaw !== expectedText) fail();
    return parseLifecycleText(postRaw);
  } catch {
    throw unavailableError();
  }
}

/**
 * Manual-ack exclusion gate: returns undefined only for exact idle grammar
 * (null or retained watermark). Non-idle, hostile, or illegal idle bindings
 * throw fixed audit-delivery-unavailable. Does not perform I/O.
 *
 * @param {unknown} state
 * @returns {undefined}
 */
export function assertAuditIntegrityAlertDeliveryLifecycleIdle(state) {
  try {
    const canonical = parseStateObject(state);
    if (canonical.status !== STATUS_IDLE) fail();
    return undefined;
  } catch {
    throw unavailableError();
  }
}

/**
 * Build a new deeply frozen exact idle object with the supplied watermark
 * (`null` or canonical millisecond UTC ISO). Rejects non-canonical and hostile
 * watermarks with fixed audit-delivery-unavailable.
 *
 * @param {unknown} lastObservedAt
 * @returns {Readonly<object>}
 */
export function createIdleAuditIntegrityAlertDeliveryLifecycle(lastObservedAt) {
  try {
    if (lastObservedAt === null) {
      return deepFreeze(buildIdleCanonical(null));
    }
    // Primitive string check — no prototype/reflection on non-strings (Proxy-safe).
    if (typeof lastObservedAt !== 'string') fail();
    const watermark = assertMsUtc(lastObservedAt);
    return deepFreeze(buildIdleCanonical(watermark));
  } catch {
    throw unavailableError();
  }
}
