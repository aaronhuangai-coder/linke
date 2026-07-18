/**
 * Audit integrity dual-write durable single-slot state (V1.37 C2).
 *
 * Real full schema/parser/load/publish/path-occupancy absent gate.
 * Does NOT import journal / coordinator / audit-log.
 * Does NOT bootstrap (C3) or recover (C4).
 * Does NOT recompute journal raw post hash / linkDigest formulas.
 * payloadDigest relationship uses shared SoT from audit-event-schema only.
 *
 * Hostile object contract: utilTypes.isProxy first (no traps), then plain
 * prototype + own enumerable data properties only. publish parses the caller
 * object in place — never JSON.stringify(hostile) → JSON.parse whitewash.
 * Full-file raw identity: parser text must equal JSON.stringify(canonical).
 * Post-write: exact raw reopen compare, then parse; any post-check failure → IO.
 */

import { types as utilTypes } from 'node:util';
import {
  SafeDataFileError,
  safeAtomicWriteText,
  safeReadText,
} from './safe-data-files.js';
import { ERROR_CODES, assertRegisteredErrorCode } from './error-codes.js';
import {
  computeAuditIntegrityEventPayloadDigest,
  projectStrictCanonicalSanitizedEvent,
  stringifyStrictCanonicalSanitizedEvent,
} from './audit-event-schema.js';
import { assertAuditIntegrityWriteLease } from './audit-integrity-write-queue.js';

/** Relative path under data root for the dual-write single-slot WAL/cursor. */
export const AUDIT_INTEGRITY_DUAL_WRITE_STATE_RELATIVE_PATH =
  'audit/integrity-dual-write-state.json';

/** safeReadText maxBytes; oversize read → dual-write-io-error. */
export const AUDIT_DUAL_WRITE_STATE_MAX_BYTES = 65536;

const SCHEMA_VERSION = 1;
const GENERATION_ID_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
/** Lowercase UUID-like 8-4-4-4-12 (project contract; not RFC version/variant). */
const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const EMPTY_FILE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const IDLE_TOP_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'generationId',
  'journal',
  'events',
  'lastTransactionId',
  'lastPayloadDigest',
  'lastSequence',
]);

const PREPARED_TOP_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'transactionId',
  'generationId',
  'retention',
  'event',
  'payloadDigest',
  'eventLineUtf8',
  'journal',
  'events',
]);

const JOURNAL_FP_KEYS = Object.freeze([
  'recordCount',
  'headDigest',
  'rawByteLength',
  'rawSha256',
]);

const JOURNAL_POST_KEYS = Object.freeze([
  'recordCount',
  'headDigest',
  'rawByteLength',
  'rawSha256',
  'sequence',
  'linkDigest',
  'previousLinkDigest',
]);

const EVENTS_FP_KEYS = Object.freeze([
  'present',
  'byteLength',
  'sha256',
  'strictRecordCount',
]);

const PREPARED_JOURNAL_KEYS = Object.freeze(['pre', 'post']);
const PREPARED_EVENTS_KEYS = Object.freeze(['pre', 'post']);
const RETENTION_KEYS = Object.freeze(['maxEvents']);

/**
 * Path-free dual-write error: message === code; name fixed; registry only.
 * Never embeds path, errno text, raw event body, or secrets.
 */
export class AuditIntegrityDualWriteError extends Error {
  /**
   * @param {string} code registered ERROR_CODES value
   */
  constructor(code) {
    const registered = assertRegisteredErrorCode(code);
    super(registered);
    this.name = 'AuditIntegrityDualWriteError';
    this.code = registered;
  }
}

/**
 * @param {string} code
 * @returns {never}
 */
function throwDualWriteError(code) {
  throw new AuditIntegrityDualWriteError(code);
}

/**
 * @returns {never}
 */
function throwStateInvalid() {
  throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
}

/**
 * @returns {never}
 */
function throwIoError() {
  throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
}

/**
 * @returns {never}
 */
function throwDirectBlocked() {
  throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED);
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
 * isProxy first — do not call Proxy traps then decide.
 *
 * @param {unknown} value
 * @returns {object}
 */
function assertPlainDataObject(value) {
  if (!isPlainObject(value)) throwStateInvalid();
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key === 'symbol') throwStateInvalid();
    if (typeof key !== 'string') throwStateInvalid();
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc) throwStateInvalid();
    if (!desc.enumerable) throwStateInvalid();
    if (desc.get !== undefined || desc.set !== undefined) throwStateInvalid();
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) throwStateInvalid();
  }
  return value;
}

/**
 * @param {object} obj
 * @param {readonly string[]} expected
 */
function assertExactKeyOrder(obj, expected) {
  const keys = Object.keys(obj);
  if (keys.length !== expected.length) throwStateInvalid();
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== expected[i]) throwStateInvalid();
  }
}

/**
 * @param {unknown} value
 * @param {{ min?: number }} [opts]
 * @returns {number}
 */
function assertSafeInteger(value, opts = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throwStateInvalid();
  if (opts.min !== undefined && value < opts.min) throwStateInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertGenerationId(value) {
  if (typeof value !== 'string' || !GENERATION_ID_RE.test(value)) throwStateInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertHex64(value) {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) throwStateInvalid();
  return value;
}

/**
 * Lowercase UUID-like 8-4-4-4-12 string (not RFC version/variant gated).
 * @param {unknown} value
 * @returns {string}
 */
function assertUuidLike(value) {
  if (typeof value !== 'string' || !UUID_LIKE_RE.test(value)) throwStateInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) {
    // Still freeze nested if partially frozen.
  } else {
    Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {{
 *   recordCount: number,
 *   headDigest: string,
 *   rawByteLength: number,
 *   rawSha256: string,
 * }}
 */
function parseJournalFingerprint(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, JOURNAL_FP_KEYS);
  return {
    recordCount: assertSafeInteger(obj.recordCount, { min: 1 }),
    headDigest: assertHex64(obj.headDigest),
    rawByteLength: assertSafeInteger(obj.rawByteLength, { min: 0 }),
    rawSha256: assertHex64(obj.rawSha256),
  };
}

/**
 * @param {unknown} value
 * @returns {{
 *   recordCount: number,
 *   headDigest: string,
 *   rawByteLength: number,
 *   rawSha256: string,
 *   sequence: number,
 *   linkDigest: string,
 *   previousLinkDigest: string,
 * }}
 */
function parseJournalPostFingerprint(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, JOURNAL_POST_KEYS);
  return {
    recordCount: assertSafeInteger(obj.recordCount, { min: 1 }),
    headDigest: assertHex64(obj.headDigest),
    rawByteLength: assertSafeInteger(obj.rawByteLength, { min: 0 }),
    rawSha256: assertHex64(obj.rawSha256),
    sequence: assertSafeInteger(obj.sequence, { min: 0 }),
    linkDigest: assertHex64(obj.linkDigest),
    previousLinkDigest: assertHex64(obj.previousLinkDigest),
  };
}

/**
 * @param {unknown} value
 * @returns {{
 *   present: boolean,
 *   byteLength: number,
 *   sha256: string,
 *   strictRecordCount: number,
 * }}
 */
function parseEventsFingerprint(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, EVENTS_FP_KEYS);
  if (typeof obj.present !== 'boolean') throwStateInvalid();
  const byteLength = assertSafeInteger(obj.byteLength, { min: 0 });
  const sha256 = assertHex64(obj.sha256);
  const strictRecordCount = assertSafeInteger(obj.strictRecordCount, { min: 0 });
  if (obj.present === false) {
    if (byteLength !== 0) throwStateInvalid();
    if (sha256 !== EMPTY_FILE_SHA256) throwStateInvalid();
    if (strictRecordCount !== 0) throwStateInvalid();
  }
  return {
    present: obj.present,
    byteLength,
    sha256,
    strictRecordCount,
  };
}

/**
 * @param {unknown} event
 * @returns {Record<string, unknown>}
 */
function parsePreparedEvent(event) {
  const obj = assertPlainDataObject(event);
  let projected;
  try {
    projected = projectStrictCanonicalSanitizedEvent(obj);
  } catch {
    throwStateInvalid();
  }
  // Object.keys must match projected STRICT order exactly (no extra/wrong order).
  const expectedKeys = Object.keys(projected);
  assertExactKeyOrder(obj, expectedKeys);
  for (const key of expectedKeys) {
    if (!Object.is(obj[key], projected[key])) throwStateInvalid();
  }
  return projected;
}

/**
 * @param {unknown} retention
 * @returns {null | { maxEvents: number }}
 */
function parseRetention(retention) {
  if (retention === null) return null;
  const obj = assertPlainDataObject(retention);
  assertExactKeyOrder(obj, RETENTION_KEYS);
  return {
    maxEvents: assertSafeInteger(obj.maxEvents, { min: 1 }),
  };
}

/**
 * @param {object} raw already assertPlainDataObject'd top-level
 * @returns {object}
 */
function parseIdleState(raw) {
  assertExactKeyOrder(raw, IDLE_TOP_KEYS);
  if (raw.schemaVersion !== SCHEMA_VERSION) throwStateInvalid();
  if (raw.status !== 'idle') throwStateInvalid();
  const generationId = assertGenerationId(raw.generationId);
  // Nested fingerprints: assertPlainDataObject before field reads (Proxy/class/toJSON).
  const journal = parseJournalFingerprint(raw.journal);
  const events = parseEventsFingerprint(raw.events);

  const lastTransactionId = raw.lastTransactionId;
  const lastPayloadDigest = raw.lastPayloadDigest;
  const lastSequence = raw.lastSequence;

  const allNull =
    lastTransactionId === null
    && lastPayloadDigest === null
    && lastSequence === null;
  const allNonNull =
    lastTransactionId !== null
    && lastPayloadDigest !== null
    && lastSequence !== null;

  if (!allNull && !allNonNull) throwStateInvalid();

  if (allNonNull) {
    assertUuidLike(lastTransactionId);
    assertHex64(lastPayloadDigest);
    assertSafeInteger(lastSequence, { min: 0 });
    if (lastSequence !== journal.recordCount - 1) throwStateInvalid();
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'idle',
    generationId,
    journal,
    events,
    lastTransactionId: allNull ? null : lastTransactionId,
    lastPayloadDigest: allNull ? null : lastPayloadDigest,
    lastSequence: allNull ? null : lastSequence,
  };
}

/**
 * @param {object} raw already assertPlainDataObject'd top-level
 * @returns {object}
 */
function parsePreparedState(raw) {
  assertExactKeyOrder(raw, PREPARED_TOP_KEYS);
  if (raw.schemaVersion !== SCHEMA_VERSION) throwStateInvalid();
  if (raw.status !== 'prepared') throwStateInvalid();

  const transactionId = assertUuidLike(raw.transactionId);
  const generationId = assertGenerationId(raw.generationId);
  const retention = parseRetention(raw.retention);
  const event = parsePreparedEvent(raw.event);

  if (typeof raw.eventLineUtf8 !== 'string') throwStateInvalid();
  let expectedLine;
  try {
    expectedLine = `${stringifyStrictCanonicalSanitizedEvent(event)}\n`;
  } catch {
    throwStateInvalid();
  }
  if (raw.eventLineUtf8 !== expectedLine) throwStateInvalid();

  const payloadDigest = assertHex64(raw.payloadDigest);
  let expectedDigest;
  try {
    expectedDigest = computeAuditIntegrityEventPayloadDigest(event);
  } catch {
    throwStateInvalid();
  }
  if (payloadDigest !== expectedDigest) throwStateInvalid();

  const journalObj = assertPlainDataObject(raw.journal);
  assertExactKeyOrder(journalObj, PREPARED_JOURNAL_KEYS);
  const journalPre = parseJournalFingerprint(journalObj.pre);
  const journalPost = parseJournalPostFingerprint(journalObj.post);

  // Relationship invariants (parser does NOT recompute raw post hash / link formula).
  if (journalPost.recordCount !== journalPre.recordCount + 1) throwStateInvalid();
  if (journalPost.sequence !== journalPre.recordCount) throwStateInvalid();
  if (journalPost.previousLinkDigest !== journalPre.headDigest) throwStateInvalid();
  if (journalPost.linkDigest !== journalPost.headDigest) throwStateInvalid();

  const eventsObj = assertPlainDataObject(raw.events);
  assertExactKeyOrder(eventsObj, PREPARED_EVENTS_KEYS);
  const eventsPre = parseEventsFingerprint(eventsObj.pre);
  const eventsPost = parseEventsFingerprint(eventsObj.post);

  if (eventsPost.present !== true) throwStateInvalid();

  if (retention === null) {
    if (eventsPost.strictRecordCount !== eventsPre.strictRecordCount + 1) {
      throwStateInvalid();
    }
  } else {
    const expected = Math.min(eventsPre.strictRecordCount + 1, retention.maxEvents);
    if (eventsPost.strictRecordCount !== expected) throwStateInvalid();
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'prepared',
    transactionId,
    generationId,
    retention,
    event,
    payloadDigest,
    eventLineUtf8: raw.eventLineUtf8,
    journal: {
      pre: journalPre,
      post: journalPost,
    },
    events: {
      pre: eventsPre,
      post: eventsPost,
    },
  };
}

/**
 * Shared object-schema entry for caller objects and JSON.parse output.
 * Asserts plain data on the original value first (Proxy/class rejected before
 * any nested field walk / stringify whitewash).
 *
 * @param {unknown} value
 * @returns {object} unfrozen canonical state
 */
function parseStateObject(value) {
  const obj = assertPlainDataObject(value);
  if (typeof obj.status !== 'string') throwStateInvalid();
  if (obj.status === 'idle') {
    return parseIdleState(obj);
  }
  if (obj.status === 'prepared') {
    return parsePreparedState(obj);
  }
  throwStateInvalid();
}

/**
 * Pure strict parser for dual-write state text.
 * Allows exactly one trailing '\n'; rejects BOM, empty, multi-line, trailing garbage.
 * After schema parse, locks full-file raw identity:
 *   text (optional single trailing newline stripped) === JSON.stringify(canonical)
 * Returns deep-frozen canonical state object.
 *
 * @param {string} raw
 * @returns {Readonly<object>}
 */
export function parseAuditIntegrityDualWriteStateText(raw) {
  if (typeof raw !== 'string') throwStateInvalid();
  if (Buffer.byteLength(raw, 'utf8') > AUDIT_DUAL_WRITE_STATE_MAX_BYTES) {
    throwStateInvalid();
  }
  if (raw.length === 0) throwStateInvalid();
  if (raw.charCodeAt(0) === 0xfeff) throwStateInvalid();

  let text = raw;
  if (text.endsWith('\n')) {
    text = text.slice(0, -1);
  }
  if (text.length === 0) throwStateInvalid();
  if (text.includes('\n')) throwStateInvalid();
  if (/^\s/.test(text) || /\s$/.test(text)) throwStateInvalid();

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throwStateInvalid();
  }

  // Same schema path as publish in-memory objects (no second parser).
  const canonical = parseStateObject(value);

  // Full-file raw canonical identity: fixed key order, no internal whitespace,
  // no duplicate keys, no alternative escapes.
  if (text !== JSON.stringify(canonical)) throwStateInvalid();

  return deepFreeze(canonical);
}

/**
 * Successful idle last* assignment sources from a validated prepared state (S3l).
 * Parser still enforces lastSequence === journal.recordCount - 1 on idle.
 * Unexpected input / Proxy traps are remapped to path-free STATE_INVALID.
 *
 * @param {unknown} prepared
 * @returns {{
 *   lastTransactionId: string,
 *   lastPayloadDigest: string,
 *   lastSequence: number,
 * }}
 */
export function buildSuccessfulIdleLastFieldsFromPrepared(prepared) {
  try {
    const parsed = parseStateObject(prepared);
    if (parsed.status !== 'prepared') throwStateInvalid();
    return deepFreeze({
      lastTransactionId: parsed.transactionId,
      lastPayloadDigest: parsed.payloadDigest,
      lastSequence: parsed.journal.post.sequence,
    });
  } catch (error) {
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    throwStateInvalid();
  }
}

/**
 * Rebuild canonical JSON text with frozen key order + trailing newline.
 * @param {object} state already-validated canonical state
 * @returns {string}
 */
function serializeCanonicalState(state) {
  return `${JSON.stringify(state)}\n`;
}

/**
 * Load dual-write state under active lease.
 * Missing exact ENOENT → null.
 * Oversize / symlink / dir / other Safe → dual-write-io-error.
 * Invalid schema raw → STATE_INVALID (not remapped to IO).
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @returns {Promise<object|null>}
 */
export async function loadDualWriteStateUnlocked(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  let raw;
  try {
    raw = await safeReadText(resolvedRoot, AUDIT_INTEGRITY_DUAL_WRITE_STATE_RELATIVE_PATH, {
      maxBytes: AUDIT_DUAL_WRITE_STATE_MAX_BYTES,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    // SafeDataFileError and other failures → io-error (path-free).
    throwIoError();
  }

  try {
    return parseAuditIntegrityDualWriteStateText(raw);
  } catch (error) {
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    throwStateInvalid();
  }
}

/**
 * Atomic publish of dual-write state under active lease.
 * Preflight: parseStateObject on caller value (never stringify-hostile whitewash),
 * then serialize ≤65536 → else STATE_INVALID without touching disk.
 * Post-write: safeReadText reopen → exact raw === expectedText first → then parse;
 * any post read/parse/missing/invalid/mismatch → DUAL_WRITE_IO_ERROR.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {unknown} state
 * @returns {Promise<object>} deep-frozen loaded state
 */
export async function publishDualWriteStateUnlocked(resolvedRoot, lease, state) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  // Direct object parse — reject Proxy/class/accessor before any stringify.
  let canonical;
  try {
    canonical = deepFreeze(parseStateObject(state));
  } catch (error) {
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    throwStateInvalid();
  }

  const expectedText = serializeCanonicalState(canonical);
  // Guard-before-write only (legal schema is below cap; monkeypatch can force branch).
  if (Buffer.byteLength(expectedText, 'utf8') > AUDIT_DUAL_WRITE_STATE_MAX_BYTES) {
    throwStateInvalid();
  }

  try {
    await safeAtomicWriteText(
      resolvedRoot,
      AUDIT_INTEGRITY_DUAL_WRITE_STATE_RELATIVE_PATH,
      expectedText,
      { mode: 0o600 },
    );
  } catch (error) {
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    throwIoError();
  }

  // Post-write external swap / post-check failure → always dual-write IO.
  // Input preflight schema invalid already returned STATE_INVALID above.
  let postRaw;
  try {
    postRaw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_DUAL_WRITE_STATE_RELATIVE_PATH,
      { maxBytes: AUDIT_DUAL_WRITE_STATE_MAX_BYTES },
    );
  } catch (error) {
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    throwIoError();
  }

  // Exact raw first (before parse): different bytes → IO, even if still valid JSON.
  if (postRaw !== expectedText) throwIoError();

  let loaded;
  try {
    loaded = parseAuditIntegrityDualWriteStateText(postRaw);
  } catch {
    // Post-check parse failure after write is external integrity/IO, not input invalid.
    throwIoError();
  }
  if (loaded === null) throwIoError();
  if (loaded.status !== canonical.status) throwIoError();
  if (JSON.stringify(loaded) !== JSON.stringify(canonical)) throwIoError();

  return loaded;
}

/**
 * Path occupancy absent gate under active lease (lease proves critical section only).
 * Does NOT parse schema to judge occupancy.
 *
 * - exact ENOENT (parent or leaf missing) → allow (returns undefined)
 * - regular file any content / empty / valid / invalid / oversize → occupied
 * - symlink / directory / permission / SafeDataFileError / unsafe → occupied
 * - occupied → DIRECT_MUTATION_BLOCKED (no recover, no mutation, path-free)
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @returns {Promise<void>}
 */
export async function assertDualWriteStateAbsentUnlocked(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  // Small maxBytes probe: any successful read or non-ENOENT failure ⇒ occupied.
  try {
    await safeReadText(resolvedRoot, AUDIT_INTEGRITY_DUAL_WRITE_STATE_RELATIVE_PATH, {
      maxBytes: 1,
    });
    // Regular file (including empty) exists → occupied.
    throwDirectBlocked();
  } catch (error) {
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    if (error && error.code === 'ENOENT') {
      // Exact absent allow.
      return undefined;
    }
    // SafeDataFileError (symlink/dir/permission/oversize>1) or other → occupied.
    if (error instanceof SafeDataFileError) {
      throwDirectBlocked();
    }
    // Any non-ENOENT failure that is not lease-related → treat as occupied.
    throwDirectBlocked();
  }
}
