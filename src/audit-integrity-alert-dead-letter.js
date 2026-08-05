/**
 * Bounded audit-integrity alert dead-letter FIFO (Task 3).
 *
 * Append-only inspectable quarantine under an active same-root write lease.
 * Missing leaf reads as empty without creating the file. Corrupt / unsafe /
 * oversize → path-free audit-delivery-unavailable with zero repair.
 *
 * Allowed surface: constants + read / append-under-lease / fingerprint raw.
 * No requeue, drop, rewrite, delete, or operator advance APIs.
 *
 * Hostile object contract: utilTypes.isProxy first (no traps), then plain
 * Object.prototype + Reflect.ownKeys exact order + own enumerable data
 * descriptors only. Full-file raw identity: compact JSON + one trailing LF.
 */

import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertAuditIntegrityWriteLease } from './audit-integrity-write-queue.js';
import {
  assertSafeDataRoot,
  safeAtomicWriteText,
  safeReadText,
} from './safe-data-files.js';

/** Relative path under data root for the dead-letter FIFO leaf. */
export const AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH =
  'audit/integrity-alert-dead-letter.json';

/** UTF-8 byte upper bound for durable DLQ leaf (1 MiB). */
export const AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES = 1_048_576;

/** Maximum persisted quarantine entries. */
export const AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES = 256;

const SCHEMA_VERSION = 1;

const TOP_FILE_KEYS = Object.freeze(['schemaVersion', 'nextSequence', 'entries']);

const PERSISTED_ENTRY_KEYS = Object.freeze([
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

/** Caller entry omits allocator-owned deadLetterSequence. */
const CALLER_ENTRY_KEYS = Object.freeze([
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

const SOURCE_ALERT_KEYS = Object.freeze([
  'sequence',
  'checkedAt',
  'code',
  'recoveryRequired',
  'nextAction',
  'reasonCode',
]);

const FINGERPRINT_KEYS = Object.freeze([
  'sha256',
  'byteLength',
  'entryCount',
  'nextSequence',
]);

const DEAD_LETTER_REASONS = Object.freeze([
  'terminal-http',
  'attempts-exhausted-retryable',
  'attempts-exhausted-uncertain',
]);

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
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
 * Plain data object: not null/array/Proxy; prototype must be Object.prototype.
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
 * Exact Reflect.ownKeys order (after assertPlainDataObject).
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
 * attemptCount is closed 1..8.
 * @param {unknown} value
 * @returns {number}
 */
function assertAttemptCount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail();
  if (value < 1 || value > 8) fail();
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
 * Path-free closed token (kebab-case).
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
 * Exact idempotency key grammar for (streamId, sequence).
 * @param {string} streamId
 * @param {number} sequence
 * @param {unknown} idempotencyKey
 * @returns {string}
 */
function assertIdempotencyKey(streamId, sequence, idempotencyKey) {
  const expected = `audit-integrity-alert:${streamId}:${sequence}`;
  if (typeof idempotencyKey !== 'string' || idempotencyKey !== expected) fail();
  return idempotencyKey;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertReason(value) {
  if (typeof value !== 'string') fail();
  if (!DEAD_LETTER_REASONS.includes(value)) fail();
  return value;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (!Object.isFrozen(value)) Object.freeze(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      deepFreeze(value[i]);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {number} expectedSequence
 * @returns {{
 *   sequence: number,
 *   checkedAt: string,
 *   code: string,
 *   recoveryRequired: boolean,
 *   nextAction: string,
 *   reasonCode: string | null,
 * }}
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
 * Shared field parse for the 10 non-allocator entry fields (caller or persisted tail).
 *
 * @param {object} obj already plain + exact keys for the 10-field set
 * @returns {object}
 */
function parseSharedEntryFields(obj) {
  const deadLetterId = assertUuidV4(obj.deadLetterId);
  const streamId = assertUuidV4(obj.streamId);
  const sequence = assertPositiveSafeInteger(obj.sequence);
  const idempotencyKey = assertIdempotencyKey(streamId, sequence, obj.idempotencyKey);
  const enqueuedAt = assertMsUtc(obj.enqueuedAt);
  const attemptCount = assertAttemptCount(obj.attemptCount);
  const firstAttemptAt = assertMsUtc(obj.firstAttemptAt);
  const lastAttemptAt = assertMsUtc(obj.lastAttemptAt);
  const reason = assertReason(obj.reason);
  const sourceAlert = parseSourceAlert(obj.sourceAlert, sequence);
  return {
    deadLetterId,
    streamId,
    sequence,
    idempotencyKey,
    enqueuedAt,
    attemptCount,
    firstAttemptAt,
    lastAttemptAt,
    reason,
    sourceAlert,
  };
}

/**
 * Caller entry: exact 10 keys, no deadLetterSequence, plain Object.prototype.
 *
 * @param {unknown} value
 * @returns {object}
 */
function parseCallerEntry(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, CALLER_ENTRY_KEYS);
  return parseSharedEntryFields(obj);
}

/**
 * Persisted entry: deadLetterSequence first, then the 10 shared fields.
 *
 * @param {unknown} value
 * @returns {object}
 */
function parsePersistedEntry(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, PERSISTED_ENTRY_KEYS);
  const deadLetterSequence = assertPositiveSafeInteger(obj.deadLetterSequence);
  const shared = parseSharedEntryFields(obj);
  return {
    deadLetterSequence,
    ...shared,
  };
}

/**
 * Rebuild compact full-file text with frozen key order + one trailing LF.
 *
 * @param {{ schemaVersion: number, nextSequence: number, entries: object[] }} state
 * @returns {string}
 */
function serializeFileState(state) {
  const entries = state.entries.map((entry) => ({
    deadLetterSequence: entry.deadLetterSequence,
    deadLetterId: entry.deadLetterId,
    streamId: entry.streamId,
    sequence: entry.sequence,
    idempotencyKey: entry.idempotencyKey,
    enqueuedAt: entry.enqueuedAt,
    attemptCount: entry.attemptCount,
    firstAttemptAt: entry.firstAttemptAt,
    lastAttemptAt: entry.lastAttemptAt,
    reason: entry.reason,
    sourceAlert: {
      sequence: entry.sourceAlert.sequence,
      checkedAt: entry.sourceAlert.checkedAt,
      code: entry.sourceAlert.code,
      recoveryRequired: entry.sourceAlert.recoveryRequired,
      nextAction: entry.sourceAlert.nextAction,
      reasonCode: entry.sourceAlert.reasonCode,
    },
  }));
  return `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    nextSequence: state.nextSequence,
    entries,
  })}\n`;
}

/**
 * Pure strict parser for durable DLQ text.
 * Rejects empty, BOM, missing/double LF, pretty JSON, reordered keys, oversize.
 *
 * @param {string} raw
 * @returns {{ schemaVersion: number, nextSequence: number, entries: object[] }}
 */
function parseFileText(raw) {
  if (typeof raw !== 'string') fail();
  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength > AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES) fail();
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

  // JSON.parse yields plain objects with Object.prototype; still assert shape.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  if (utilTypes.isProxy(value)) fail();
  if (Object.getPrototypeOf(value) !== Object.prototype) fail();
  assertExactKeyOrder(value, TOP_FILE_KEYS);

  if (value.schemaVersion !== SCHEMA_VERSION) fail();
  const nextSequence = assertPositiveSafeInteger(value.nextSequence);
  if (!Array.isArray(value.entries)) fail();
  if (value.entries.length > AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES) fail();

  /** @type {object[]} */
  const entries = [];
  /** @type {Set<string>} */
  const identities = new Set();
  for (let i = 0; i < value.entries.length; i += 1) {
    const entry = parsePersistedEntry(value.entries[i]);
    // Frozen allocator history: index i must be deadLetterSequence i + 1 (origin 1, no gaps).
    if (entry.deadLetterSequence !== i + 1) {
      fail();
    }
    const identity = `${entry.streamId}\0${entry.sequence}`;
    if (identities.has(identity)) fail();
    identities.add(identity);
    entries.push(entry);
  }

  // nextSequence is exact allocator continuation: entries.length + 1 (empty → 1).
  if (nextSequence !== entries.length + 1) fail();

  const state = {
    schemaVersion: SCHEMA_VERSION,
    nextSequence,
    entries,
  };
  if (serializeFileState(state) !== raw) fail();
  return state;
}

/**
 * @param {string} rawText
 * @param {{ entryCount: number, nextSequence: number }} counters
 * @returns {Readonly<{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 * }>}
 */
function buildFingerprint(rawText, counters) {
  const sha256 = createHash('sha256').update(rawText, 'utf8').digest('hex');
  const byteLength = Buffer.byteLength(rawText, 'utf8');
  return deepFreeze({
    sha256,
    byteLength,
    entryCount: counters.entryCount,
    nextSequence: counters.nextSequence,
  });
}

/**
 * Empty missing-leaf snapshot (status empty only).
 * @returns {Readonly<object>}
 */
function freezeEmptySnapshot() {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    status: 'empty',
    entryCount: 0,
    nextSequence: 1,
    entries: [],
  });
}

/**
 * Ready snapshot from parsed durable state (defensive copies).
 * @param {{ schemaVersion: number, nextSequence: number, entries: object[] }} state
 * @returns {Readonly<object>}
 */
function freezeReadySnapshot(state) {
  const entries = state.entries.map((entry) => ({
    deadLetterSequence: entry.deadLetterSequence,
    deadLetterId: entry.deadLetterId,
    streamId: entry.streamId,
    sequence: entry.sequence,
    idempotencyKey: entry.idempotencyKey,
    enqueuedAt: entry.enqueuedAt,
    attemptCount: entry.attemptCount,
    firstAttemptAt: entry.firstAttemptAt,
    lastAttemptAt: entry.lastAttemptAt,
    reason: entry.reason,
    sourceAlert: {
      sequence: entry.sourceAlert.sequence,
      checkedAt: entry.sourceAlert.checkedAt,
      code: entry.sourceAlert.code,
      recoveryRequired: entry.sourceAlert.recoveryRequired,
      nextAction: entry.sourceAlert.nextAction,
      reasonCode: entry.sourceAlert.reasonCode,
    },
  }));
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    status: 'ready',
    entryCount: entries.length,
    nextSequence: state.nextSequence,
    entries,
  });
}

/**
 * Load durable DLQ under root. Missing leaf → logical empty (nextSequence 1).
 * Present zero-byte / corrupt / unsafe → unavailable.
 *
 * @param {string} resolvedRoot
 * @returns {Promise<{
 *   state: { schemaVersion: number, nextSequence: number, entries: object[] },
 *   raw: string | null,
 * }>}
 */
async function loadDeadLetter(resolvedRoot) {
  let raw;
  try {
    raw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES },
    );
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        state: {
          schemaVersion: SCHEMA_VERSION,
          nextSequence: 1,
          entries: [],
        },
        raw: null,
      };
    }
    fail();
  }
  const state = parseFileText(raw);
  return { state, raw };
}

/**
 * Compare 10 non-allocator fields of a persisted row to a validated caller entry.
 *
 * @param {object} persisted
 * @param {object} caller
 * @returns {boolean}
 */
function entryMatchesCaller(persisted, caller) {
  if (persisted.deadLetterId !== caller.deadLetterId) return false;
  if (persisted.streamId !== caller.streamId) return false;
  if (persisted.sequence !== caller.sequence) return false;
  if (persisted.idempotencyKey !== caller.idempotencyKey) return false;
  if (persisted.enqueuedAt !== caller.enqueuedAt) return false;
  if (persisted.attemptCount !== caller.attemptCount) return false;
  if (persisted.firstAttemptAt !== caller.firstAttemptAt) return false;
  if (persisted.lastAttemptAt !== caller.lastAttemptAt) return false;
  if (persisted.reason !== caller.reason) return false;
  const a = persisted.sourceAlert;
  const b = caller.sourceAlert;
  return a.sequence === b.sequence
    && a.checkedAt === b.checkedAt
    && a.code === b.code
    && a.recoveryRequired === b.recoveryRequired
    && a.nextAction === b.nextAction
    && a.reasonCode === b.reasonCode;
}

/**
 * Fingerprint exact durable raw DLQ bytes after canonical validation.
 * SHA-256 is lowercase hex of the exact raw UTF-8 bytes.
 *
 * @param {unknown} rawText
 * @returns {Readonly<{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 * }>}
 */
export function fingerprintAuditIntegrityAlertDeadLetterRaw(rawText) {
  try {
    if (typeof rawText !== 'string') fail();
    const state = parseFileText(rawText);
    return buildFingerprint(rawText, {
      entryCount: state.entries.length,
      nextSequence: state.nextSequence,
    });
  } catch {
    throw unavailableError();
  }
}

/**
 * Inspect-only read of the dead-letter FIFO.
 * Missing leaf → frozen status empty (creates nothing). Present canonical → ready.
 * Present zero-byte / corrupt / unsafe → path-free unavailable, zero repair.
 *
 * @param {unknown} dataDir
 * @returns {Promise<Readonly<object>>}
 */
export async function readAuditIntegrityAlertDeadLetter(dataDir) {
  try {
    const resolvedRoot = await assertSafeDataRoot(dataDir);
    let raw;
    try {
      raw = await safeReadText(
        resolvedRoot,
        AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH,
        { maxBytes: AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES },
      );
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return freezeEmptySnapshot();
      }
      fail();
    }
    const state = parseFileText(raw);
    return freezeReadySnapshot(state);
  } catch {
    throw unavailableError();
  }
}

/**
 * Append one sanitized quarantine entry under an active same-root write lease.
 * Signature is exactly (dataDir, lease, entry) — no prepared deadLetterPost.
 * Allocates deadLetterSequence monotonically; exact (streamId, sequence) match
 * on all 10 non-allocator fields is idempotent; field mismatch fails closed.
 * Returns frozen post fingerprint of durable raw bytes.
 *
 * @param {unknown} dataDir resolved absolute data root
 * @param {unknown} lease active audit integrity write lease
 * @param {unknown} entry caller entry (10 keys; no deadLetterSequence)
 * @returns {Promise<Readonly<{
 *   sha256: string,
 *   byteLength: number,
 *   entryCount: number,
 *   nextSequence: number,
 * }>>}
 */
export async function appendAuditIntegrityAlertDeadLetterUnderLease(
  dataDir,
  lease,
  entry,
) {
  try {
    assertAuditIntegrityWriteLease(dataDir, lease);

    // Snapshot + validate caller before any filesystem await.
    const caller = parseCallerEntry(entry);

    const { state, raw } = await loadDeadLetter(/** @type {string} */ (dataDir));

    // Identity lookup: (streamId, sequence).
    let existing = null;
    for (const row of state.entries) {
      if (row.streamId === caller.streamId && row.sequence === caller.sequence) {
        existing = row;
        break;
      }
    }

    if (existing !== null) {
      if (!entryMatchesCaller(existing, caller)) fail();
      // Idempotent: zero rewrite; fingerprint current durable bytes.
      if (raw === null) fail();
      return buildFingerprint(raw, {
        entryCount: state.entries.length,
        nextSequence: state.nextSequence,
      });
    }

    if (state.entries.length >= AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES) {
      fail();
    }
    if (!Number.isSafeInteger(state.nextSequence + 1)) fail();

    const deadLetterSequence = state.nextSequence;
    const persisted = {
      deadLetterSequence,
      deadLetterId: caller.deadLetterId,
      streamId: caller.streamId,
      sequence: caller.sequence,
      idempotencyKey: caller.idempotencyKey,
      enqueuedAt: caller.enqueuedAt,
      attemptCount: caller.attemptCount,
      firstAttemptAt: caller.firstAttemptAt,
      lastAttemptAt: caller.lastAttemptAt,
      reason: caller.reason,
      sourceAlert: {
        sequence: caller.sourceAlert.sequence,
        checkedAt: caller.sourceAlert.checkedAt,
        code: caller.sourceAlert.code,
        recoveryRequired: caller.sourceAlert.recoveryRequired,
        nextAction: caller.sourceAlert.nextAction,
        reasonCode: caller.sourceAlert.reasonCode,
      },
    };

    const nextState = {
      schemaVersion: SCHEMA_VERSION,
      nextSequence: state.nextSequence + 1,
      entries: [...state.entries, persisted],
    };
    const expectedText = serializeFileState(nextState);
    if (
      Buffer.byteLength(expectedText, 'utf8')
      > AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES
    ) {
      fail();
    }

    try {
      await safeAtomicWriteText(
        /** @type {string} */ (dataDir),
        AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH,
        expectedText,
        { mode: 0o600 },
      );
    } catch {
      fail();
    }

    let postRaw;
    try {
      postRaw = await safeReadText(
        /** @type {string} */ (dataDir),
        AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH,
        { maxBytes: AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES },
      );
    } catch {
      fail();
    }

    if (postRaw !== expectedText) fail();
    // Re-validate durable raw identity (append-helper-owned only).
    const postState = parseFileText(postRaw);
    return buildFingerprint(postRaw, {
      entryCount: postState.entries.length,
      nextSequence: postState.nextSequence,
    });
  } catch {
    throw unavailableError();
  }
}
