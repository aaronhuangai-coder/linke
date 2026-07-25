/**
 * Audit integrity rotation WAL state + archive manifest (V1.43 Task 2).
 *
 * Manual rotation foundation: parse / build / lease-bound load / publish /
 * ordinary-append allow gate (assertAuditIntegrityRotationAllowsAppendUnlocked).
 * Does NOT implement coordinator, archive commit, recovery, CLI,
 * monitor, HTTP, scheduling, or deletion.
 * Does NOT import journal formulas, coordinator, audit-log, agent, or monitor.
 * payloadDigest relationship uses shared SoT from audit-event-schema only.
 *
 * Hostile object contract: utilTypes.isProxy first (no traps), then plain
 * prototype + Reflect.ownKeys exact order + own enumerable data descriptors
 * only. Never JSON.stringify(hostile) before validating descriptors.
 * Canonical raw is exact JSON.stringify with no trailing newline.
 */

import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import {
  safeAtomicWriteText,
  safeReadText,
} from './safe-data-files.js';
import { ERROR_CODES, assertRegisteredErrorCode } from './error-codes.js';
import { computeAuditIntegrityEventPayloadDigest } from './audit-event-schema.js';
import { assertAuditIntegrityWriteLease } from './audit-integrity-write-queue.js';

/** Relative path under data root for the rotation single-slot WAL state. */
export const AUDIT_INTEGRITY_ROTATION_STATE_RELATIVE_PATH =
  'audit/integrity-rotation-state.json';

/** safeReadText maxBytes; direct parse oversize → rotation-bounds-exceeded. */
export const AUDIT_INTEGRITY_ROTATION_STATE_MAX_BYTES = 131072;

/** Archive manifest canonical raw max UTF-8 bytes. */
export const AUDIT_INTEGRITY_ARCHIVE_MANIFEST_MAX_BYTES = 16384;

const SCHEMA_VERSION = 1;
const GENERATION_ID_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
/** Lowercase UUID-like 8-4-4-4-12 (project contract; not RFC version/variant). */
const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATUSES = new Set([
  'prepared',
  'archive-committed',
  'journal-published',
  'events-published',
  'completed',
]);

const TOP_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'rotationId',
  'createdAt',
  'previousGenerationId',
  'previousHeadDigest',
  'nextGenerationId',
  'archiveRelativePath',
  'archiveManifestDigest',
  'rotationEvent',
  'journal',
  'events',
]);

const ROTATION_EVENT_KEYS = Object.freeze(['event', 'eventLineUtf8', 'payloadDigest']);
const ROTATION_EVENT_EVENT_KEYS = Object.freeze([
  'id',
  'createdAt',
  'type',
  'outcome',
  'operation',
  'message',
]);
const JOURNAL_KEYS = Object.freeze(['previous', 'next']);
const JOURNAL_FP_KEYS = Object.freeze([
  'schemaVersion',
  'recordCount',
  'headDigest',
  'rawByteLength',
  'rawSha256',
]);
const EVENTS_KEYS = Object.freeze(['sealed', 'post']);
const EVENTS_FP_KEYS = Object.freeze([
  'present',
  'strictRecordCount',
  'rawByteLength',
  'rawSha256',
]);

const MANIFEST_TOP_KEYS = Object.freeze([
  'schemaVersion',
  'recordKind',
  'rotationId',
  'createdAt',
  'previousGenerationId',
  'previousJournalSchemaVersion',
  'previousHeadDigest',
  'journal',
  'events',
  'nextGenerationId',
  'rotationEventId',
  'rotationEventPayloadDigest',
]);
const MANIFEST_JOURNAL_KEYS = Object.freeze([
  'rawByteLength',
  'rawSha256',
  'recordCount',
]);
const MANIFEST_EVENTS_KEYS = Object.freeze([
  'present',
  'rawByteLength',
  'rawSha256',
  'strictRecordCount',
]);

const ROTATION_EVENT_TYPE = 'audit-integrity-rotation';
const ROTATION_EVENT_OUTCOME = 'committed';
const ROTATION_EVENT_OPERATION = 'generation-transition';
const ROTATION_EVENT_MESSAGE =
  'audit integrity generation rotation committed';
const MANIFEST_RECORD_KIND = 'audit-integrity-rotation-manifest';

/**
 * Path-free rotation error: message === code; name fixed; registry only.
 * Never embeds path, errno text, raw body, or secrets. No cause property.
 */
export class AuditIntegrityRotationError extends Error {
  /**
   * @param {string} code registered ERROR_CODES value
   */
  constructor(code) {
    const registered = assertRegisteredErrorCode(code);
    super(registered);
    this.name = 'AuditIntegrityRotationError';
    this.code = registered;
  }
}

/**
 * @param {string} code
 * @returns {never}
 */
function throwRotationError(code) {
  throw new AuditIntegrityRotationError(code);
}

/** @returns {never} */
function throwStateInvalid() {
  throwRotationError(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_STATE_INVALID);
}

/** @returns {never} */
function throwIoError() {
  throwRotationError(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_IO_ERROR);
}

/** @returns {never} */
function throwBoundsExceeded() {
  throwRotationError(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_BOUNDS_EXCEEDED);
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
 * @param {unknown} value
 * @returns {string}
 */
function assertUuidLike(value) {
  if (typeof value !== 'string' || !UUID_LIKE_RE.test(value)) throwStateInvalid();
  return value;
}

/**
 * Strict ISO createdAt: exact Date#toISOString() identity.
 * @param {unknown} value
 * @returns {string}
 */
function assertStrictIso(value) {
  if (typeof value !== 'string') throwStateInvalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throwStateInvalid();
  }
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
 * @param {string} text
 * @returns {string}
 */
function sha256Utf8Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @param {unknown} value
 * @returns {{
 *   schemaVersion: number,
 *   recordCount: number,
 *   headDigest: string,
 *   rawByteLength: number,
 *   rawSha256: string,
 * }}
 */
function parseJournalFingerprint(value, { schemaAllowed, fixedSchema, fixedRecordCount }) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, JOURNAL_FP_KEYS);
  const schemaVersion = assertSafeInteger(obj.schemaVersion, { min: 1 });
  if (fixedSchema !== undefined) {
    if (schemaVersion !== fixedSchema) throwStateInvalid();
  } else if (!schemaAllowed.has(schemaVersion)) {
    throwStateInvalid();
  }
  const recordCount = assertSafeInteger(obj.recordCount, { min: 0 });
  if (fixedRecordCount !== undefined && recordCount !== fixedRecordCount) {
    throwStateInvalid();
  }
  return {
    schemaVersion,
    recordCount,
    headDigest: assertHex64(obj.headDigest),
    rawByteLength: assertSafeInteger(obj.rawByteLength, { min: 0 }),
    rawSha256: assertHex64(obj.rawSha256),
  };
}

/**
 * @param {unknown} value
 * @returns {{
 *   present: boolean,
 *   strictRecordCount: number,
 *   rawByteLength: number,
 *   rawSha256: string,
 * }}
 */
function parseEventsFingerprint(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, EVENTS_FP_KEYS);
  if (typeof obj.present !== 'boolean') throwStateInvalid();
  return {
    present: obj.present,
    strictRecordCount: assertSafeInteger(obj.strictRecordCount, { min: 0 }),
    rawByteLength: assertSafeInteger(obj.rawByteLength, { min: 0 }),
    rawSha256: assertHex64(obj.rawSha256),
  };
}

/**
 * @param {unknown} value
 * @returns {{
 *   event: {
 *     id: string,
 *     createdAt: string,
 *     type: string,
 *     outcome: string,
 *     operation: string,
 *     message: string,
 *   },
 *   eventLineUtf8: string,
 *   payloadDigest: string,
 * }}
 */
function parseRotationEvent(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, ROTATION_EVENT_KEYS);

  const eventObj = assertPlainDataObject(obj.event);
  assertExactKeyOrder(eventObj, ROTATION_EVENT_EVENT_KEYS);

  const id = assertUuidLike(eventObj.id);
  const createdAt = assertStrictIso(eventObj.createdAt);
  if (eventObj.type !== ROTATION_EVENT_TYPE) throwStateInvalid();
  if (eventObj.outcome !== ROTATION_EVENT_OUTCOME) throwStateInvalid();
  if (eventObj.operation !== ROTATION_EVENT_OPERATION) throwStateInvalid();
  if (eventObj.message !== ROTATION_EVENT_MESSAGE) throwStateInvalid();

  const event = {
    id,
    createdAt,
    type: ROTATION_EVENT_TYPE,
    outcome: ROTATION_EVENT_OUTCOME,
    operation: ROTATION_EVENT_OPERATION,
    message: ROTATION_EVENT_MESSAGE,
  };

  if (typeof obj.eventLineUtf8 !== 'string') throwStateInvalid();
  const eventJson = JSON.stringify(event);
  const expectedLine = `${eventJson}\n`;
  if (obj.eventLineUtf8 !== expectedLine) throwStateInvalid();
  // Exactly one trailing newline; no other line break in UTF-8 bytes.
  if (obj.eventLineUtf8.indexOf('\n') !== obj.eventLineUtf8.length - 1) {
    throwStateInvalid();
  }

  const payloadDigest = assertHex64(obj.payloadDigest);
  let expectedDigest;
  try {
    expectedDigest = computeAuditIntegrityEventPayloadDigest(event);
  } catch {
    throwStateInvalid();
  }
  if (payloadDigest !== expectedDigest) throwStateInvalid();

  return {
    event,
    eventLineUtf8: obj.eventLineUtf8,
    payloadDigest,
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
  assertExactKeyOrder(obj, TOP_KEYS);

  if (obj.schemaVersion !== SCHEMA_VERSION) throwStateInvalid();
  if (typeof obj.status !== 'string' || !STATUSES.has(obj.status)) throwStateInvalid();

  const rotationId = assertUuidLike(obj.rotationId);
  const createdAt = assertStrictIso(obj.createdAt);
  const previousGenerationId = assertGenerationId(obj.previousGenerationId);
  const previousHeadDigest = assertHex64(obj.previousHeadDigest);
  const nextGenerationId = assertGenerationId(obj.nextGenerationId);
  if (previousGenerationId === nextGenerationId) throwStateInvalid();

  if (typeof obj.archiveRelativePath !== 'string') throwStateInvalid();
  const expectedArchivePath = `audit/archive/${previousGenerationId}`;
  if (obj.archiveRelativePath !== expectedArchivePath) throwStateInvalid();

  const archiveManifestDigest = assertHex64(obj.archiveManifestDigest);
  const rotationEvent = parseRotationEvent(obj.rotationEvent);

  if (rotationId !== rotationEvent.event.id) throwStateInvalid();
  if (createdAt !== rotationEvent.event.createdAt) throwStateInvalid();

  const journalObj = assertPlainDataObject(obj.journal);
  assertExactKeyOrder(journalObj, JOURNAL_KEYS);
  const journalPrevious = parseJournalFingerprint(journalObj.previous, {
    schemaAllowed: new Set([1, 2]),
  });
  const journalNext = parseJournalFingerprint(journalObj.next, {
    fixedSchema: 2,
    fixedRecordCount: 2,
  });
  if (journalPrevious.headDigest !== previousHeadDigest) throwStateInvalid();

  const eventsObj = assertPlainDataObject(obj.events);
  assertExactKeyOrder(eventsObj, EVENTS_KEYS);
  const sealed = parseEventsFingerprint(eventsObj.sealed);
  const post = parseEventsFingerprint(eventsObj.post);
  if (post.present !== true) throwStateInvalid();
  if (post.strictRecordCount !== sealed.strictRecordCount + 1) throwStateInvalid();
  const expectedPostBytes =
    sealed.rawByteLength + Buffer.byteLength(rotationEvent.eventLineUtf8, 'utf8');
  if (post.rawByteLength !== expectedPostBytes) throwStateInvalid();

  return {
    schemaVersion: SCHEMA_VERSION,
    status: obj.status,
    rotationId,
    createdAt,
    previousGenerationId,
    previousHeadDigest,
    nextGenerationId,
    archiveRelativePath: expectedArchivePath,
    archiveManifestDigest,
    rotationEvent,
    journal: {
      previous: journalPrevious,
      next: journalNext,
    },
    events: {
      sealed,
      post,
    },
  };
}

/**
 * Pure strict parser for rotation state text.
 * No trailing newline. Full-file raw identity:
 *   raw === JSON.stringify(canonical)
 * Over-limit UTF-8 → ROTATION_BOUNDS_EXCEEDED.
 *
 * @param {string} raw
 * @returns {Readonly<object>}
 */
export function parseAuditIntegrityRotationStateText(raw) {
  if (typeof raw !== 'string') throwStateInvalid();
  if (Buffer.byteLength(raw, 'utf8') > AUDIT_INTEGRITY_ROTATION_STATE_MAX_BYTES) {
    throwBoundsExceeded();
  }
  if (raw.length === 0) throwStateInvalid();
  if (raw.charCodeAt(0) === 0xfeff) throwStateInvalid();
  if (raw.includes('\n') || raw.includes('\r')) throwStateInvalid();
  if (/^\s/.test(raw) || /\s$/.test(raw)) throwStateInvalid();

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throwStateInvalid();
  }

  const canonical = parseStateObject(value);
  if (raw !== JSON.stringify(canonical)) throwStateInvalid();
  return deepFreeze(canonical);
}

/**
 * @param {unknown} value
 * @returns {{
 *   rawByteLength: number,
 *   rawSha256: string,
 *   recordCount: number,
 * }}
 */
function parseManifestJournal(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, MANIFEST_JOURNAL_KEYS);
  return {
    rawByteLength: assertSafeInteger(obj.rawByteLength, { min: 0 }),
    rawSha256: assertHex64(obj.rawSha256),
    recordCount: assertSafeInteger(obj.recordCount, { min: 0 }),
  };
}

/**
 * @param {unknown} value
 * @returns {{
 *   present: boolean,
 *   rawByteLength: number,
 *   rawSha256: string,
 *   strictRecordCount: number,
 * }}
 */
function parseManifestEvents(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, MANIFEST_EVENTS_KEYS);
  if (typeof obj.present !== 'boolean') throwStateInvalid();
  return {
    present: obj.present,
    rawByteLength: assertSafeInteger(obj.rawByteLength, { min: 0 }),
    rawSha256: assertHex64(obj.rawSha256),
    strictRecordCount: assertSafeInteger(obj.strictRecordCount, { min: 0 }),
  };
}

/**
 * Shared object-schema entry for archive manifest fields.
 *
 * @param {unknown} value
 * @returns {object} unfrozen canonical manifest
 */
function parseManifestObject(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, MANIFEST_TOP_KEYS);

  if (obj.schemaVersion !== SCHEMA_VERSION) throwStateInvalid();
  if (obj.recordKind !== MANIFEST_RECORD_KIND) throwStateInvalid();

  const rotationId = assertUuidLike(obj.rotationId);
  const createdAt = assertStrictIso(obj.createdAt);
  const previousGenerationId = assertGenerationId(obj.previousGenerationId);
  const previousJournalSchemaVersion = assertSafeInteger(
    obj.previousJournalSchemaVersion,
    { min: 1 },
  );
  if (previousJournalSchemaVersion !== 1 && previousJournalSchemaVersion !== 2) {
    throwStateInvalid();
  }
  const previousHeadDigest = assertHex64(obj.previousHeadDigest);
  const journal = parseManifestJournal(obj.journal);
  const events = parseManifestEvents(obj.events);
  const nextGenerationId = assertGenerationId(obj.nextGenerationId);
  if (previousGenerationId === nextGenerationId) throwStateInvalid();
  const rotationEventId = assertUuidLike(obj.rotationEventId);
  if (rotationId !== rotationEventId) throwStateInvalid();
  const rotationEventPayloadDigest = assertHex64(obj.rotationEventPayloadDigest);

  return {
    schemaVersion: SCHEMA_VERSION,
    recordKind: MANIFEST_RECORD_KIND,
    rotationId,
    createdAt,
    previousGenerationId,
    previousJournalSchemaVersion,
    previousHeadDigest,
    journal,
    events,
    nextGenerationId,
    rotationEventId,
    rotationEventPayloadDigest,
  };
}

/**
 * Pure strict parser for archive manifest text.
 * No trailing newline. Over-limit UTF-8 → ROTATION_BOUNDS_EXCEEDED.
 *
 * @param {string} raw
 * @returns {Readonly<object>}
 */
export function parseAuditIntegrityArchiveManifestText(raw) {
  if (typeof raw !== 'string') throwStateInvalid();
  if (Buffer.byteLength(raw, 'utf8') > AUDIT_INTEGRITY_ARCHIVE_MANIFEST_MAX_BYTES) {
    throwBoundsExceeded();
  }
  if (raw.length === 0) throwStateInvalid();
  if (raw.charCodeAt(0) === 0xfeff) throwStateInvalid();
  if (raw.includes('\n') || raw.includes('\r')) throwStateInvalid();
  if (/^\s/.test(raw) || /\s$/.test(raw)) throwStateInvalid();

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throwStateInvalid();
  }

  const canonical = parseManifestObject(value);
  if (raw !== JSON.stringify(canonical)) throwStateInvalid();
  return deepFreeze(canonical);
}

/**
 * Build canonical archive manifest + rawText + independent digest.
 * Validates hostile input first (never stringify-whitewash).
 * Returns deeply frozen {manifest, rawText, digest}; manifest has no own digest.
 *
 * @param {unknown} fields
 * @returns {Readonly<{
 *   manifest: Readonly<object>,
 *   rawText: string,
 *   digest: string,
 * }>}
 */
export function buildAuditIntegrityArchiveManifest(fields) {
  let canonical;
  try {
    canonical = parseManifestObject(fields);
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwStateInvalid();
  }

  const rawText = JSON.stringify(canonical);
  if (Buffer.byteLength(rawText, 'utf8') > AUDIT_INTEGRITY_ARCHIVE_MANIFEST_MAX_BYTES) {
    throwBoundsExceeded();
  }
  const digest = sha256Utf8Hex(rawText);
  return deepFreeze({
    manifest: deepFreeze(canonical),
    rawText,
    digest,
  });
}

/**
 * Load rotation state under active lease.
 * Missing exact ENOENT → null.
 * Oversize / SafeData failures → ROTATION_IO_ERROR.
 * Invalid schema raw → STATE_INVALID (not remapped to IO).
 * Lease assert is outside mapping try so invalid lease remains SafeDataFileError.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @returns {Promise<object|null>}
 */
export async function loadAuditIntegrityRotationStateUnlocked(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  let raw;
  try {
    raw = await safeReadText(resolvedRoot, AUDIT_INTEGRITY_ROTATION_STATE_RELATIVE_PATH, {
      maxBytes: AUDIT_INTEGRITY_ROTATION_STATE_MAX_BYTES,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwIoError();
  }

  try {
    return parseAuditIntegrityRotationStateText(raw);
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwStateInvalid();
  }
}

/**
 * Ordinary dual-write append gate under an active same-root lease.
 * Reuses loadAuditIntegrityRotationStateUnlocked (no second safeRead/parser path).
 *
 * - exact missing WAL → null (allow existing v1 / dual-write path)
 * - nonterminal status → AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED (no recover/publish/write)
 * - completed → deep-frozen parsed WAL (generation bind for caller)
 * - invalid / io / lease errors preserve load* typed layering (never remapped here)
 *
 * No options, public bypass, or automatic recovery.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @returns {Promise<object|null>}
 */
export async function assertAuditIntegrityRotationAllowsAppendUnlocked(
  resolvedRoot,
  lease,
) {
  const state = await loadAuditIntegrityRotationStateUnlocked(resolvedRoot, lease);
  if (state === null) return null;
  if (state.status === 'completed') {
    // parse/load already deep-freezes; return as generation-bind receipt.
    return state;
  }
  // prepared | archive-committed | journal-published | events-published
  throwRotationError(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED);
}

/**
 * Atomic publish of rotation state under active lease.
 * Preflight: parseStateObject on caller value (never stringify-hostile whitewash),
 * then serialize >131072 → BOUNDS without touching disk.
 * Write mode 0600; post-write exact raw reopen + parse; any post failure → IO.
 * Lease assert is outside mapping try so invalid lease remains SafeDataFileError.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {unknown} state
 * @returns {Promise<object>} deep-frozen loaded state
 */
export async function publishAuditIntegrityRotationStateUnlocked(
  resolvedRoot,
  lease,
  state,
) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  let canonical;
  try {
    canonical = deepFreeze(parseStateObject(state));
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwStateInvalid();
  }

  const expectedText = JSON.stringify(canonical);
  if (Buffer.byteLength(expectedText, 'utf8') > AUDIT_INTEGRITY_ROTATION_STATE_MAX_BYTES) {
    throwBoundsExceeded();
  }

  try {
    await safeAtomicWriteText(
      resolvedRoot,
      AUDIT_INTEGRITY_ROTATION_STATE_RELATIVE_PATH,
      expectedText,
      { mode: 0o600 },
    );
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwIoError();
  }

  let postRaw;
  try {
    postRaw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_ROTATION_STATE_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_ROTATION_STATE_MAX_BYTES },
    );
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwIoError();
  }

  if (postRaw !== expectedText) throwIoError();

  let loaded;
  try {
    loaded = parseAuditIntegrityRotationStateText(postRaw);
  } catch {
    throwIoError();
  }
  if (JSON.stringify(loaded) !== expectedText) throwIoError();
  return loaded;
}
