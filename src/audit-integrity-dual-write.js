/**
 * V1.37 C4: Prepared WAL + crash recovery core (library coordinator).
 *
 * Public surface:
 *   appendAuditEventWithIntegrityDualWrite(dataDir, event, options?)
 *     → sanitize/strict/preflight → resolve root → enqueue once → S3 dual-write
 *   recoverAuditIntegrityDualWrite(root)
 *     → resolve + fresh lease → bootstrap / recover prepared / idle validate
 *   recoverAndValidateAuditIntegrityDualWrite(root)
 *     → C3-compatible alias of explicit recover
 *
 * @internal:
 *   ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease)
 *     S3a–S3d with real prepared recovery (C4)
 *
 * Does NOT wire production appendAuditEvent (C5).
 * Does NOT import audit-log (no cycle).
 * Does NOT reimplement journal hash/link or events strict parser formulas.
 *
 * TEST ONLY crash injection uses Symbol key DUAL_WRITE_TEST_CRASH_HOOK
 * (not a plain options key; never imported by audit-log/server).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  SafeDataFileError,
  assertSafeDataRoot,
  safeAppendText,
  safeAtomicWriteBytes,
  safeReadBytes,
  safeReadText,
} from './safe-data-files.js';
import { ERROR_CODES } from './error-codes.js';
import {
  enqueueAuditIntegrityWriteTask,
  assertAuditIntegrityWriteLease,
} from './audit-integrity-write-queue.js';
import {
  AuditIntegrityDualWriteError,
  loadDualWriteStateUnlocked,
  publishDualWriteStateUnlocked,
  buildSuccessfulIdleLastFieldsFromPrepared,
} from './audit-integrity-dual-write-state.js';
import {
  AuditIntegrityJournalError,
  AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
  AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES,
  initializeAuditIntegrityJournalUnlocked,
  inspectAuditIntegrityJournalFile,
  planAuditIntegrityEventLinkUnlocked,
  publishPlannedAuditIntegrityEventLinkAtomicUnlocked,
} from './audit-integrity-journal.js';
import {
  AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
  AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES,
  AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES,
  AUDIT_CROSS_STORE_MAX_EVENT_LINES,
  AuditIntegrityCrossStoreError,
  verifyAuditIntegrityAgainstEventStore,
} from './audit-integrity-cross-store.js';
import {
  sanitizeAuditEvent,
  projectStrictCanonicalSanitizedEvent,
  stringifyStrictCanonicalSanitizedEvent,
  computeAuditIntegrityEventPayloadDigest,
  parseStrictCanonicalAuditEventLinesText,
  StrictCanonicalAuditEventLinesParseError,
} from './audit-event-schema.js';

const EMPTY_FILE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Allowed supplemental post-check relationships after real verifier receipt. */
const ALLOWED_SUPPLEMENTAL_RELATIONSHIPS = Object.freeze(new Set([
  'equal',
  'events-suffix-of-journal',
  'journal-suffix-of-events',
]));

/**
 * TEST ONLY crash-injection key. Not a production options field.
 * Values: 'after-prepared' | 'after-journal' | 'after-events'
 * Per-call only; no module-global force/bypass setter.
 */
export const DUAL_WRITE_TEST_CRASH_HOOK = Symbol('linke.audit-integrity-dual-write.test-crash');

/**
 * TEST ONLY per-call hook after events write, before primary post-check.
 * Must be an async/sync function; never a module-global mutable force.
 * Used for scoped post-rename external-swap fault injection.
 */
export const DUAL_WRITE_TEST_AFTER_EVENTS_WRITE = Symbol(
  'linke.audit-integrity-dual-write.test-after-events-write',
);

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
function throwCursorMismatch() {
  throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
}

/**
 * @returns {never}
 */
function throwRecoveryConflict() {
  throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT);
}

/**
 * @returns {never}
 */
function throwIoError() {
  throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
}

/**
 * @param {string | Buffer} value
 * @returns {string}
 */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @returns {string} 32 lowercase hex generationId
 */
function newGenerationId() {
  return randomBytes(16).toString('hex');
}

/**
 * Local retention normalize (mirrors audit-log; dual-write must not import audit-log).
 * @param {unknown} retention
 * @returns {null | { maxEvents: number }}
 */
function normalizeRetentionLocal(retention) {
  if (retention === undefined || retention === null || retention === false) return null;
  if (typeof retention !== 'object' || Array.isArray(retention)) {
    throw new Error('auditRetention must be an object when provided');
  }
  const maxEvents = Number(/** @type {{ maxEvents?: unknown }} */ (retention).maxEvents);
  if (!Number.isInteger(maxEvents) || maxEvents < 0) {
    throw new Error('auditRetention.maxEvents must be a non-negative integer');
  }
  if (maxEvents === 0) return null;
  return { maxEvents };
}

/**
 * Fatal UTF-8 decode — never replacement character.
 * @param {Buffer} bytes
 * @returns {string}
 */
function fatalUtf8Decode(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isEnoent(err) {
  return Boolean(err && typeof err === 'object' && /** @type {{ code?: unknown }} */ (err).code === 'ENOENT');
}

/**
 * Read events store raw bytes + present flag. Exact ENOENT → absent.
 * Other Safe/IO failures → dual-write IO (path-free). Oversize Safe → IO
 * (caller may remap size >16MiB paths that already use cross-store max).
 *
 * @param {string} resolvedRoot
 * @returns {Promise<{ present: boolean, bytes: Buffer }>}
 */
async function readEventsBytes(resolvedRoot) {
  try {
    const bytes = await safeReadBytes(
      resolvedRoot,
      AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
      { maxBytes: AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES },
    );
    return { present: true, bytes };
  } catch (error) {
    if (isEnoent(error)) {
      return { present: false, bytes: Buffer.alloc(0) };
    }
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    if (error instanceof SafeDataFileError) throwIoError();
    throwIoError();
  }
}

/**
 * Cross-store size-window read: oversize / Safe → CROSS_STORE_IO (not bounds).
 * @param {string} resolvedRoot
 * @returns {Promise<{ present: boolean, bytes: Buffer }>}
 */
async function readEventsBytesCrossStoreWindow(resolvedRoot) {
  try {
    const bytes = await safeReadBytes(
      resolvedRoot,
      AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
      { maxBytes: AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES },
    );
    return { present: true, bytes };
  } catch (error) {
    if (isEnoent(error)) {
      return { present: false, bytes: Buffer.alloc(0) };
    }
    if (error instanceof AuditIntegrityCrossStoreError) throw error;
    // SafeDataFileError includes size > maxBytes → cross-store IO (size≠bounds).
    throw new AuditIntegrityCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR);
  }
}

/**
 * Measure journal fingerprint from real current bytes + inspect SoT.
 * Retains inspect payloadDigests / eventCount for Jpost tail binding (never discarded).
 * @param {string} resolvedRoot
 */
async function measureJournalFingerprint(resolvedRoot) {
  const snapshot = await inspectAuditIntegrityJournalFile(resolvedRoot);
  let raw;
  try {
    raw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES },
    );
  } catch (error) {
    if (error instanceof AuditIntegrityJournalError) throw error;
    if (isEnoent(error)) {
      throw new AuditIntegrityJournalError(ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED);
    }
    throw new AuditIntegrityJournalError(ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
  }
  return {
    generationId: snapshot.generationId,
    recordCount: snapshot.recordCount,
    headDigest: snapshot.headDigest,
    eventCount: snapshot.eventCount,
    // Defensive copy — inspect already freezes, but callers must not mutate SoT.
    payloadDigests: snapshot.payloadDigests.slice(),
    rawByteLength: Buffer.byteLength(raw, 'utf8'),
    rawSha256: sha256Hex(raw),
  };
}

/**
 * Pure receipt-shape validator for dual-write supplemental post-check.
 * Path-free: only checks receipt state/relationship shape. No I/O, no module
 * state mutation, no verifier bypass, no public-path injection.
 *
 * Allowed receipt means "this receipt shape alone would pass the gate" —
 * production still MUST call real verifyAuditIntegrityAgainstEventStore first.
 *
 * @param {unknown} receipt
 * @throws {AuditIntegrityDualWriteError} RECOVERY_CONFLICT when not allowed
 */
export function validateAuditIntegrityDualWritePostReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throwRecoveryConflict();
  }
  const state = /** @type {{ state?: unknown, relationship?: unknown }} */ (receipt).state;
  const relationship =
    /** @type {{ state?: unknown, relationship?: unknown }} */ (receipt).relationship;
  if (state !== 'verified' && state !== 'partial') {
    throwRecoveryConflict();
  }
  if (typeof relationship !== 'string' || !ALLOWED_SUPPLEMENTAL_RELATIONSHIPS.has(relationship)) {
    throwRecoveryConflict();
  }
}

/**
 * Structural relationship via V1.36 verifier SoT.
 * Only verified | partial receipts are usable for bootstrap.
 * @param {string} resolvedRoot
 */
async function verifyCrossStoreBaseline(resolvedRoot) {
  const receipt = await verifyAuditIntegrityAgainstEventStore(resolvedRoot);
  if (receipt.state !== 'verified' && receipt.state !== 'partial') {
    throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT);
  }
  return {
    state: receipt.state,
    retainedEventCount: receipt.retainedEventCount,
    relationship: receipt.relationship,
  };
}

/**
 * Fail-closed invalid UTF-8 baseline before treating events as legal.
 * @param {Buffer} bytes
 */
function assertEventsUtf8Baseline(bytes) {
  if (bytes.length === 0) return;
  try {
    fatalUtf8Decode(bytes);
  } catch {
    throw new AuditIntegrityCrossStoreError(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
    );
  }
}

/**
 * Build events fingerprint from bytes probe + strict count.
 * @param {{ present: boolean, bytes: Buffer }} eventsProbe
 * @param {number} strictRecordCount
 */
function buildEventsFingerprint(eventsProbe, strictRecordCount) {
  if (!eventsProbe.present) {
    return {
      present: false,
      byteLength: 0,
      sha256: EMPTY_FILE_SHA256,
      strictRecordCount: 0,
    };
  }
  return {
    present: true,
    byteLength: eventsProbe.bytes.length,
    sha256: sha256Hex(eventsProbe.bytes),
    strictRecordCount,
  };
}

/**
 * @param {{ present: boolean, byteLength: number, sha256: string, strictRecordCount: number }} a
 * @param {{ present: boolean, byteLength: number, sha256: string, strictRecordCount: number }} b
 */
function eventsFpEqual(a, b) {
  return (
    a.present === b.present
    && a.byteLength === b.byteLength
    && a.sha256 === b.sha256
    && a.strictRecordCount === b.strictRecordCount
  );
}

/**
 * @param {{ recordCount: number, headDigest: string, rawByteLength: number, rawSha256: string }} a
 * @param {{ recordCount: number, headDigest: string, rawByteLength: number, rawSha256: string }} b
 */
function journalFpEqual(a, b) {
  return (
    a.recordCount === b.recordCount
    && a.headDigest === b.headDigest
    && a.rawByteLength === b.rawByteLength
    && a.rawSha256 === b.rawSha256
  );
}

/**
 * Fatal-decode events bytes then parse via shared strict-canonical SoT.
 * Hot/bootstrap/retention: preserve typed cross-store bounds/invalid layering.
 * Recovery callers map failures to RECOVERY_CONFLICT themselves.
 *
 * @param {Buffer} bytes
 * @returns {{ lines: readonly string[], events: readonly object[], count: number }}
 */
function parseStrictEventsBytesTyped(bytes) {
  if (bytes.length === 0) {
    return Object.freeze({
      lines: Object.freeze([]),
      events: Object.freeze([]),
      count: 0,
    });
  }
  let raw;
  try {
    raw = fatalUtf8Decode(bytes);
  } catch {
    throw new AuditIntegrityCrossStoreError(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
    );
  }
  try {
    return parseStrictCanonicalAuditEventLinesText(raw, {
      maxLineBytes: AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES,
      maxLines: AUDIT_CROSS_STORE_MAX_EVENT_LINES,
    });
  } catch (error) {
    if (error instanceof StrictCanonicalAuditEventLinesParseError) {
      if (error.kind === 'bounds') {
        throw new AuditIntegrityCrossStoreError(
          ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
        );
      }
      throw new AuditIntegrityCrossStoreError(
        ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
      );
    }
    throw new AuditIntegrityCrossStoreError(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
    );
  }
}

/**
 * Recovery-path parse: any UTF-8/bounds/strict failure → RECOVERY_CONFLICT.
 * @param {Buffer} bytes
 * @returns {{ lines: readonly string[], events: readonly object[], count: number }}
 */
function parseStrictEventsBytesForRecovery(bytes) {
  try {
    return parseStrictEventsBytesTyped(bytes);
  } catch {
    throwRecoveryConflict();
  }
}

/**
 * Assert journal live fingerprint is trustworthy for count/digest tail binding.
 * Empty payloadDigests array or eventCount mismatch → not a valid exact-post match.
 * @param {{
 *   recordCount: number,
 *   eventCount: number,
 *   payloadDigests: string[],
 * }} fp
 * @returns {boolean}
 */
function journalLiveCountsTrustworthy(fp) {
  if (!Array.isArray(fp.payloadDigests)) return false;
  if (fp.eventCount !== fp.payloadDigests.length) return false;
  // open record + event-links
  if (fp.recordCount !== fp.eventCount + 1) return false;
  return true;
}

/**
 * Jpost tail binding: last journal payloadDigest must equal prepared.payloadDigest.
 * Abnormal/empty payloads → not bound (caller treats as conflict/other).
 * @param {{
 *   eventCount: number,
 *   payloadDigests: string[],
 *   recordCount: number,
 * }} fp
 * @param {object} prepared
 * @returns {boolean}
 */
function journalTailMatchesPrepared(fp, prepared) {
  if (!journalLiveCountsTrustworthy(fp)) return false;
  if (fp.payloadDigests.length === 0) return false;
  const tail = fp.payloadDigests[fp.payloadDigests.length - 1];
  return tail === prepared.payloadDigest;
}

/**
 * Bootstrap idle when state is exact-missing (load returned null).
 * @param {string} resolvedRoot
 * @param {object} lease
 */
async function bootstrapDualWriteIdleUnlocked(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  let journalMissing = false;
  try {
    await inspectAuditIntegrityJournalFile(resolvedRoot);
  } catch (error) {
    if (
      error instanceof AuditIntegrityJournalError
      && error.code === ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED
    ) {
      journalMissing = true;
    } else {
      throw error;
    }
  }

  const eventsProbe = await readEventsBytes(resolvedRoot);
  if (eventsProbe.present) {
    assertEventsUtf8Baseline(eventsProbe.bytes);
  }

  let cross = await verifyCrossStoreBaseline(resolvedRoot);

  let generationId;
  if (journalMissing) {
    generationId = newGenerationId();
    await initializeAuditIntegrityJournalUnlocked(resolvedRoot, lease, { generationId });
    cross = await verifyCrossStoreBaseline(resolvedRoot);
  }

  const journalFp = await measureJournalFingerprint(resolvedRoot);
  generationId = journalFp.generationId;

  // Re-read events after possible journal init (events unchanged; re-snapshot for consistency).
  const eventsAfter = await readEventsBytes(resolvedRoot);
  if (eventsAfter.present) {
    assertEventsUtf8Baseline(eventsAfter.bytes);
  }
  const eventsFp = buildEventsFingerprint(eventsAfter, cross.retainedEventCount);

  const idle = {
    schemaVersion: 1,
    status: 'idle',
    generationId,
    journal: {
      recordCount: journalFp.recordCount,
      headDigest: journalFp.headDigest,
      rawByteLength: journalFp.rawByteLength,
      rawSha256: journalFp.rawSha256,
    },
    events: eventsFp,
    lastTransactionId: null,
    lastPayloadDigest: null,
    lastSequence: null,
  };

  return publishDualWriteStateUnlocked(resolvedRoot, lease, idle);
}

/**
 * Exact idle cursor validation against live store bytes.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} state
 */
async function validateIdleCursorAgainstStoresUnlocked(resolvedRoot, lease, state) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  const journalFp = await measureJournalFingerprint(resolvedRoot);

  if (journalFp.generationId !== state.generationId) {
    throwCursorMismatch();
  }
  if (
    journalFp.recordCount !== state.journal.recordCount
    || journalFp.headDigest !== state.journal.headDigest
    || journalFp.rawByteLength !== state.journal.rawByteLength
    || journalFp.rawSha256 !== state.journal.rawSha256
  ) {
    throwCursorMismatch();
  }

  const eventsProbe = await readEventsBytes(resolvedRoot);
  if (eventsProbe.present) {
    try {
      assertEventsUtf8Baseline(eventsProbe.bytes);
    } catch {
      throwCursorMismatch();
    }
  }

  const rawPresent = eventsProbe.present;
  const rawByteLength = eventsProbe.present ? eventsProbe.bytes.length : 0;
  const rawSha256 = eventsProbe.present ? sha256Hex(eventsProbe.bytes) : EMPTY_FILE_SHA256;

  if (
    rawPresent !== state.events.present
    || rawByteLength !== state.events.byteLength
    || rawSha256 !== state.events.sha256
  ) {
    throwCursorMismatch();
  }

  let strictRecordCount;
  try {
    const cross = await verifyCrossStoreBaseline(resolvedRoot);
    strictRecordCount = cross.retainedEventCount;
  } catch {
    throwCursorMismatch();
  }
  if (strictRecordCount !== state.events.strictRecordCount) {
    throwCursorMismatch();
  }

  return state;
}

/**
 * Classify journal relative to prepared fingerprints (before any repair write).
 * exact-post additionally binds inspect tail payloadDigest + eventCount trust.
 * @param {string} resolvedRoot
 * @param {object} prepared
 * @returns {Promise<'exact-pre'|'exact-post'|'other'>}
 */
async function classifyJournalForPrepared(resolvedRoot, prepared) {
  let fp;
  try {
    fp = await measureJournalFingerprint(resolvedRoot);
  } catch {
    return 'other';
  }
  // Live counts must always be trustworthy when inspect succeeds.
  if (!journalLiveCountsTrustworthy(fp)) return 'other';

  if (journalFpEqual(fp, prepared.journal.pre)) {
    // pre has no new event yet; tail must NOT equal prepared.payloadDigest when
    // eventCount matches pre (pre.recordCount - 1 events). No extra tail require.
    return 'exact-pre';
  }
  if (journalFpEqual(fp, prepared.journal.post)) {
    // Jpost: force tail payloadDigest === prepared.payloadDigest.
    if (!journalTailMatchesPrepared(fp, prepared)) return 'other';
    return 'exact-post';
  }
  return 'other';
}

/**
 * Classify events relative to prepared (present/length/sha first; strict count
 * is bound separately via assertPreparedEventsStrictCountsBeforeWrite).
 * @param {{ present: boolean, bytes: Buffer }} current
 * @param {object} prepared
 * @returns {'exact-pre'|'exact-post'|'created-empty-partial'|'byte-partial'|'other'}
 */
function classifyEventsForPrepared(current, prepared) {
  const pre = prepared.events.pre;
  const post = prepared.events.post;
  const retention = prepared.retention;

  const currentFp = current.present
    ? {
      present: true,
      byteLength: current.bytes.length,
      sha256: sha256Hex(current.bytes),
      strictRecordCount: 0,
    }
    : {
      present: false,
      byteLength: 0,
      sha256: EMPTY_FILE_SHA256,
      strictRecordCount: 0,
    };

  // exact-post by present/byteLength/sha256 (strict count bound before any write)
  if (
    currentFp.present === post.present
    && currentFp.byteLength === post.byteLength
    && currentFp.sha256 === post.sha256
  ) {
    return 'exact-post';
  }

  // exact-pre by present/byteLength/sha256
  if (
    currentFp.present === pre.present
    && currentFp.byteLength === pre.byteLength
    && currentFp.sha256 === pre.sha256
  ) {
    return 'exact-pre';
  }

  // Retention enabled: only exact-pre / exact-post / other
  if (retention !== null) {
    return 'other';
  }

  // --- retention null six-state partials ---

  // created-empty-partial: pre absent + emptyDigest + current present regular empty
  if (
    pre.present === false
    && pre.byteLength === 0
    && pre.sha256 === EMPTY_FILE_SHA256
    && current.present === true
    && current.bytes.length === 0
  ) {
    return 'created-empty-partial';
  }

  // byte partial: current = exact pre bytes + nonempty strict prefix of eventLine
  // preBytes from current verified prefix only (never journal raw).
  const eventLineBytes = Buffer.from(prepared.eventLineUtf8, 'utf8');
  if (current.present && pre.present && current.bytes.length > pre.byteLength) {
    const prefix = current.bytes.subarray(0, pre.byteLength);
    if (sha256Hex(prefix) === pre.sha256 && prefix.length === pre.byteLength) {
      const rest = current.bytes.subarray(pre.byteLength);
      if (
        rest.length > 0
        && rest.length < eventLineBytes.length
        && eventLineBytes.subarray(0, rest.length).equals(rest)
      ) {
        return 'byte-partial';
      }
    }
  }

  // partial from absent pre: current is nonempty strict prefix of eventLine only
  if (
    pre.present === false
    && pre.byteLength === 0
    && current.present
    && current.bytes.length > 0
    && current.bytes.length < eventLineBytes.length
    && eventLineBytes.subarray(0, current.bytes.length).equals(current.bytes)
  ) {
    return 'byte-partial';
  }

  return 'other';
}

/**
 * Bind real events bytes strictRecordCount to prepared BEFORE any journal/events write.
 * exact-pre / exact-post: full current image count must match prepared pre/post.
 * partial / created-empty: verified pre prefix (or absent/empty) count === prepared pre.
 * Partial suffix line itself is not decoded.
 *
 * @param {{ present: boolean, bytes: Buffer }} current
 * @param {'exact-pre'|'exact-post'|'created-empty-partial'|'byte-partial'|'other'} eventsClass
 * @param {object} prepared
 */
function assertPreparedEventsStrictCountsBeforeWrite(current, eventsClass, prepared) {
  if (eventsClass === 'other') return;

  if (eventsClass === 'exact-post') {
    if (!current.present) throwRecoveryConflict();
    const parsed = parseStrictEventsBytesForRecovery(current.bytes);
    if (parsed.count !== prepared.events.post.strictRecordCount) {
      throwRecoveryConflict();
    }
    return;
  }

  if (eventsClass === 'exact-pre') {
    if (!current.present) {
      if (prepared.events.pre.strictRecordCount !== 0) throwRecoveryConflict();
      return;
    }
    const parsed = parseStrictEventsBytesForRecovery(current.bytes);
    if (parsed.count !== prepared.events.pre.strictRecordCount) {
      throwRecoveryConflict();
    }
    return;
  }

  // created-empty-partial / byte-partial: bind pre prefix count only.
  const pre = prepared.events.pre;
  /** @type {Buffer} */
  let preBytes;
  if (eventsClass === 'created-empty-partial') {
    preBytes = Buffer.alloc(0);
  } else if (eventsClass === 'byte-partial') {
    if (!current.present) throwRecoveryConflict();
    if (pre.present && pre.byteLength > 0) {
      preBytes = Buffer.from(current.bytes.subarray(0, pre.byteLength));
      if (sha256Hex(preBytes) !== pre.sha256) throwRecoveryConflict();
    } else {
      preBytes = Buffer.alloc(0);
    }
  } else {
    throwRecoveryConflict();
  }

  if (preBytes.length === 0) {
    if (prepared.events.pre.strictRecordCount !== 0) throwRecoveryConflict();
    return;
  }
  const parsedPre = parseStrictEventsBytesForRecovery(preBytes);
  if (parsedPre.count !== prepared.events.pre.strictRecordCount) {
    throwRecoveryConflict();
  }
}

/**
 * Publish idle from prepared post fingerprints + last* assignment.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} prepared
 */
async function publishIdleFromPreparedUnlocked(resolvedRoot, lease, prepared) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);
  const last = buildSuccessfulIdleLastFieldsFromPrepared(prepared);
  const idle = {
    schemaVersion: 1,
    status: 'idle',
    generationId: prepared.generationId,
    journal: {
      recordCount: prepared.journal.post.recordCount,
      headDigest: prepared.journal.post.headDigest,
      rawByteLength: prepared.journal.post.rawByteLength,
      rawSha256: prepared.journal.post.rawSha256,
    },
    events: {
      present: prepared.events.post.present,
      byteLength: prepared.events.post.byteLength,
      sha256: prepared.events.post.sha256,
      strictRecordCount: prepared.events.post.strictRecordCount,
    },
    lastTransactionId: last.lastTransactionId,
    lastPayloadDigest: last.lastPayloadDigest,
    lastSequence: last.lastSequence,
  };
  return publishDualWriteStateUnlocked(resolvedRoot, lease, idle);
}

/**
 * Primary post fingerprint check against prepared expected post.
 * Journal: fingerprints + generation + tail payloadDigest binding.
 * Events: present/length/sha + real strict parse count === prepared post.
 * @param {string} resolvedRoot
 * @param {object} prepared
 */
async function assertPrimaryPostFingerprints(resolvedRoot, prepared) {
  const journalFp = await measureJournalFingerprint(resolvedRoot);
  if (!journalFpEqual(journalFp, prepared.journal.post)) {
    throwRecoveryConflict();
  }
  if (journalFp.generationId !== prepared.generationId) {
    throwRecoveryConflict();
  }
  // Hot/recovery primary post-check always binds tail payloadDigest.
  if (!journalTailMatchesPrepared(journalFp, prepared)) {
    throwRecoveryConflict();
  }

  const eventsProbe = await readEventsBytes(resolvedRoot);
  const post = prepared.events.post;
  if (!eventsProbe.present || !post.present) {
    throwRecoveryConflict();
  }
  if (
    eventsProbe.bytes.length !== post.byteLength
    || sha256Hex(eventsProbe.bytes) !== post.sha256
  ) {
    throwRecoveryConflict();
  }
  // Primary post: strict parse/count against prepared post.
  const parsed = parseStrictEventsBytesForRecovery(eventsProbe.bytes);
  if (parsed.count !== post.strictRecordCount) {
    throwRecoveryConflict();
  }
}

/**
 * Supplemental cross-store post-check via real verifier every time.
 * empty / uncovered-events / broken / throw / other → RECOVERY_CONFLICT (prepared kept).
 * No global force/bypass setter; pure validator only checks receipt shape.
 * @param {string} resolvedRoot
 */
async function assertSupplementalPostRelationship(resolvedRoot) {
  let receipt;
  try {
    receipt = await verifyAuditIntegrityAgainstEventStore(resolvedRoot);
  } catch {
    throwRecoveryConflict();
  }
  validateAuditIntegrityDualWritePostReceipt(receipt);
}

/**
 * Rebuild plan from prepared + assert exact match with prepared.journal pre/post.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} prepared
 */
async function rebuildAndAssertPlanFromPrepared(resolvedRoot, lease, prepared) {
  const plan = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
    generationId: prepared.generationId,
    event: prepared.event,
  });
  if (plan.generationId !== prepared.generationId) throwRecoveryConflict();
  if (plan.payloadDigest !== prepared.payloadDigest) throwRecoveryConflict();
  if (!journalFpEqual(plan.pre, prepared.journal.pre)) throwRecoveryConflict();
  if (
    plan.post.recordCount !== prepared.journal.post.recordCount
    || plan.post.headDigest !== prepared.journal.post.headDigest
    || plan.post.rawByteLength !== prepared.journal.post.rawByteLength
    || plan.post.rawSha256 !== prepared.journal.post.rawSha256
    || plan.post.sequence !== prepared.journal.post.sequence
    || plan.post.linkDigest !== prepared.journal.post.linkDigest
    || plan.post.previousLinkDigest !== prepared.journal.post.previousLinkDigest
  ) {
    throwRecoveryConflict();
  }
  return plan;
}

/**
 * Repair events to exact prepared post via one atomic image write (null partial only).
 * preBytes from current verified prefix or empty — never journal raw.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} prepared
 * @param {{ present: boolean, bytes: Buffer }} current
 * @param {'created-empty-partial'|'byte-partial'|'exact-pre'} classification
 */
async function repairEventsAtomicImageUnlocked(
  resolvedRoot,
  lease,
  prepared,
  current,
  classification,
) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);
  const eventLineBytes = Buffer.from(prepared.eventLineUtf8, 'utf8');
  const pre = prepared.events.pre;
  /** @type {Buffer} */
  let preBytes;
  if (classification === 'created-empty-partial' || (classification === 'exact-pre' && !pre.present)) {
    preBytes = Buffer.alloc(0);
  } else if (classification === 'exact-pre' && pre.present && pre.byteLength === 0) {
    preBytes = Buffer.alloc(0);
  } else if (classification === 'exact-pre' && pre.present) {
    // Redo path uses current exact pre bytes (verified by classifier).
    if (!current.present || current.bytes.length !== pre.byteLength) throwRecoveryConflict();
    if (sha256Hex(current.bytes) !== pre.sha256) throwRecoveryConflict();
    preBytes = Buffer.from(current.bytes);
  } else if (classification === 'byte-partial') {
    if (!current.present) throwRecoveryConflict();
    if (pre.present && pre.byteLength > 0) {
      preBytes = Buffer.from(current.bytes.subarray(0, pre.byteLength));
      if (sha256Hex(preBytes) !== pre.sha256) throwRecoveryConflict();
    } else {
      preBytes = Buffer.alloc(0);
    }
  } else {
    throwRecoveryConflict();
  }

  const postBytes = Buffer.concat([preBytes, eventLineBytes]);
  if (postBytes.length !== prepared.events.post.byteLength) throwRecoveryConflict();
  if (sha256Hex(postBytes) !== prepared.events.post.sha256) throwRecoveryConflict();

  // Re-read pathname before repair (rename honesty).
  const recheck = await readEventsBytes(resolvedRoot);
  if (recheck.present !== current.present) throwRecoveryConflict();
  if (recheck.present) {
    if (!recheck.bytes.equals(current.bytes)) throwRecoveryConflict();
  }

  try {
    await safeAtomicWriteBytes(
      resolvedRoot,
      AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
      postBytes,
      { mode: 0o600 },
    );
  } catch {
    throwIoError();
  }

  const after = await readEventsBytes(resolvedRoot);
  if (!after.present || sha256Hex(after.bytes) !== prepared.events.post.sha256) {
    throwRecoveryConflict();
  }
}

/**
 * Publish events for retention-enabled atomic final image.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {Buffer} finalBytes
 */
async function publishEventsFinalImageUnlocked(resolvedRoot, lease, finalBytes) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);
  try {
    await safeAtomicWriteBytes(
      resolvedRoot,
      AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
      finalBytes,
      { mode: 0o600 },
    );
  } catch {
    throwIoError();
  }
}

/**
 * Hot-path null retention append of exact event line.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {string} eventLineUtf8
 */
async function appendEventsLineUnlocked(resolvedRoot, lease, eventLineUtf8) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);
  try {
    await safeAppendText(
      resolvedRoot,
      AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
      eventLineUtf8,
    );
  } catch {
    throwIoError();
  }
}

/**
 * Recover prepared transaction until idle, or throw RECOVERY_CONFLICT (prepared kept).
 * Classifies journal + events BEFORE any repair write.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} prepared
 * @returns {Promise<object>} frozen idle
 */
async function recoverPreparedUnlocked(resolvedRoot, lease, prepared) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  const journalClass = await classifyJournalForPrepared(resolvedRoot, prepared);
  const eventsCurrent = await readEventsBytes(resolvedRoot);
  // Partial / pre-post classification is pure bytes BEFORE any UTF-8 decode.
  // Mid-UTF-8 byte partials are recoverable; only non-partial paths require baseline UTF-8.
  const eventsClass = classifyEventsForPrepared(eventsCurrent, prepared);

  if (journalClass === 'other' || eventsClass === 'other') {
    throwRecoveryConflict();
  }

  // CP-X and Jpre + non-exact-pre events: conflict; no store writes.
  if (journalClass === 'exact-pre' && eventsClass !== 'exact-pre') {
    throwRecoveryConflict();
  }

  // exact-pre / exact-post baselines must be valid UTF-8 (not replacement).
  if (
    (eventsClass === 'exact-pre' || eventsClass === 'exact-post')
    && eventsCurrent.present
    && eventsCurrent.bytes.length > 0
  ) {
    try {
      assertEventsUtf8Baseline(eventsCurrent.bytes);
    } catch {
      throwRecoveryConflict();
    }
  }

  // Bind real strictRecordCount to prepared BEFORE any journal publish.
  // Jpre path: events count verified here so hostile count cannot write journal first.
  assertPreparedEventsStrictCountsBeforeWrite(eventsCurrent, eventsClass, prepared);

  // --- Journal repair (only exact-pre) ---
  if (journalClass === 'exact-pre') {
    const plan = await rebuildAndAssertPlanFromPrepared(resolvedRoot, lease, prepared);
    await publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedRoot, lease, plan);
  }
  // exact-post: no journal write

  // Re-observe events after journal step (pathname honesty); classify before decode.
  const eventsAfterJournal = await readEventsBytes(resolvedRoot);
  const eventsClass2 = classifyEventsForPrepared(eventsAfterJournal, prepared);
  if (eventsClass2 === 'other') {
    throwRecoveryConflict();
  }
  if (
    (eventsClass2 === 'exact-pre' || eventsClass2 === 'exact-post')
    && eventsAfterJournal.present
    && eventsAfterJournal.bytes.length > 0
  ) {
    try {
      assertEventsUtf8Baseline(eventsAfterJournal.bytes);
    } catch {
      throwRecoveryConflict();
    }
  }
  // Re-bind counts on re-observed image (still before events repair write).
  assertPreparedEventsStrictCountsBeforeWrite(eventsAfterJournal, eventsClass2, prepared);

  // --- Events repair ---
  if (eventsClass2 === 'exact-post') {
    // skip events write
  } else if (prepared.retention === null) {
    if (
      eventsClass2 === 'exact-pre'
      || eventsClass2 === 'created-empty-partial'
      || eventsClass2 === 'byte-partial'
    ) {
      if (eventsClass2 === 'exact-pre') {
        // Redo append path via atomic image (no truncate/reappend).
        await repairEventsAtomicImageUnlocked(
          resolvedRoot,
          lease,
          prepared,
          eventsAfterJournal,
          'exact-pre',
        );
      } else {
        await repairEventsAtomicImageUnlocked(
          resolvedRoot,
          lease,
          prepared,
          eventsAfterJournal,
          eventsClass2,
        );
      }
    } else {
      throwRecoveryConflict();
    }
  } else {
    // retention enabled: only exact-pre redo atomic final; exact-post already handled
    if (eventsClass2 === 'exact-pre') {
      // Rebuild final image from prepared eventLine + pre bytes (current verified pre).
      const eventLineBytes = Buffer.from(prepared.eventLineUtf8, 'utf8');
      let finalBytes;
      if (!prepared.events.pre.present || prepared.events.pre.byteLength === 0) {
        // Build from empty/pre-absent using retention final logic via event lines only.
        finalBytes = await buildRetentionFinalBytesFromPre(
          Buffer.alloc(0),
          false,
          prepared.eventLineUtf8,
          prepared.retention.maxEvents,
        );
      } else {
        if (!eventsAfterJournal.present) throwRecoveryConflict();
        if (sha256Hex(eventsAfterJournal.bytes) !== prepared.events.pre.sha256) {
          throwRecoveryConflict();
        }
        finalBytes = await buildRetentionFinalBytesFromPre(
          eventsAfterJournal.bytes,
          true,
          prepared.eventLineUtf8,
          prepared.retention.maxEvents,
        );
      }
      if (sha256Hex(finalBytes) !== prepared.events.post.sha256) throwRecoveryConflict();
      if (finalBytes.length !== prepared.events.post.byteLength) throwRecoveryConflict();
      await publishEventsFinalImageUnlocked(resolvedRoot, lease, finalBytes);
    } else {
      throwRecoveryConflict();
    }
  }

  await assertPrimaryPostFingerprints(resolvedRoot, prepared);
  await assertSupplementalPostRelationship(resolvedRoot);
  return publishIdleFromPreparedUnlocked(resolvedRoot, lease, prepared);
}

/**
 * Build retention final retained suffix bytes (one atomic image).
 * @param {Buffer} preBytes
 * @param {boolean} prePresent
 * @param {string} eventLineUtf8
 * @param {number} maxEvents
 * @returns {Promise<Buffer>}
 */
async function buildRetentionFinalBytesFromPre(preBytes, prePresent, eventLineUtf8, maxEvents) {
  void prePresent;
  const preParsed = preBytes.length === 0
    ? { lines: /** @type {readonly string[]} */ ([]) }
    : parseStrictEventsBytesTyped(preBytes);
  /** @type {string[]} */
  const bodies = [...preParsed.lines];
  const newBody = eventLineUtf8.endsWith('\n')
    ? eventLineUtf8.slice(0, -1)
    : eventLineUtf8;
  // Validate new line is exact strict canonical via shared SoT (single-line file).
  let newParsed;
  try {
    newParsed = parseStrictCanonicalAuditEventLinesText(`${newBody}\n`, {
      maxLineBytes: AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES,
      maxLines: AUDIT_CROSS_STORE_MAX_EVENT_LINES,
    });
  } catch (error) {
    if (error instanceof StrictCanonicalAuditEventLinesParseError) {
      if (error.kind === 'bounds') {
        throw new AuditIntegrityCrossStoreError(
          ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
        );
      }
      throw new AuditIntegrityCrossStoreError(
        ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
      );
    }
    throw new AuditIntegrityCrossStoreError(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
    );
  }
  if (newParsed.count !== 1 || newParsed.lines[0] !== newBody) {
    throw new AuditIntegrityCrossStoreError(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
    );
  }
  bodies.push(newBody);
  const retained = bodies.slice(-maxEvents);
  const text = retained.map((line) => `${line}\n`).join('');
  return Buffer.from(text, 'utf8');
}

/**
 * @internal Ensure dual-write idle cursor is ready under an active same-root lease.
 * Prepared → real recovery (C4); success → idle; failure keeps prepared.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @returns {Promise<object>}
 */
export async function ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  const state = await loadDualWriteStateUnlocked(resolvedRoot, lease);

  if (state !== null && state.status === 'prepared') {
    return recoverPreparedUnlocked(resolvedRoot, lease, state);
  }

  if (state === null) {
    return bootstrapDualWriteIdleUnlocked(resolvedRoot, lease);
  }

  if (state.status === 'idle') {
    return validateIdleCursorAgainstStoresUnlocked(resolvedRoot, lease, state);
  }

  throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
}

/**
 * Explicit recovery/bootstrap/idle validation; resolve + fresh shared queue lease.
 * @param {string} root
 * @returns {Promise<object>}
 */
export async function recoverAuditIntegrityDualWrite(root) {
  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(root);
  } catch (error) {
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    throwIoError();
  }

  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    return ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease);
  });
}

/**
 * C3-compatible public recover/validate entry — delegates to explicit recovery.
 * @param {string} root
 * @returns {Promise<object>}
 */
export async function recoverAndValidateAuditIntegrityDualWrite(root) {
  return recoverAuditIntegrityDualWrite(root);
}

/**
 * Build prepared object + expected events post image bytes for a new transaction.
 * All store preflight (journal plan + events bounds) happens here before prepared publish.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} idle
 * @param {{
 *   strictEvent: object,
 *   eventLineUtf8: string,
 *   payloadDigest: string,
 *   retention: null | { maxEvents: number },
 * }} ctx
 */
async function buildPreparedAndPlan(resolvedRoot, lease, idle, ctx) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  const { strictEvent, eventLineUtf8, payloadDigest, retention } = ctx;
  const eventLineBytes = Buffer.from(eventLineUtf8, 'utf8');
  // Cross-store per-line cap excludes trailing newline (design §7.2 / V1.36).
  const eventLineBodyLen = eventLineUtf8.endsWith('\n')
    ? Buffer.byteLength(eventLineUtf8.slice(0, -1), 'utf8')
    : eventLineBytes.length;
  if (eventLineBodyLen > AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES) {
    throw new AuditIntegrityCrossStoreError(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
    );
  }

  // Journal plan is unique SoT for sequence/link/raw post.
  const plan = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
    generationId: idle.generationId,
    event: strictEvent,
  });
  if (plan.payloadDigest !== payloadDigest) {
    throw new AuditIntegrityJournalError(ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
  }

  // Live events pre snapshot (bytes) + validate matches idle cursor.
  const eventsProbe = await readEventsBytesCrossStoreWindow(resolvedRoot);
  if (eventsProbe.present) {
    assertEventsUtf8Baseline(eventsProbe.bytes);
  }
  const livePreFp = buildEventsFingerprint(
    eventsProbe,
    idle.events.strictRecordCount,
  );
  // Present/byte/sha must match idle; strict from idle (verified at ensure).
  if (
    livePreFp.present !== idle.events.present
    || livePreFp.byteLength !== idle.events.byteLength
    || livePreFp.sha256 !== idle.events.sha256
  ) {
    throwCursorMismatch();
  }

  /** @type {Buffer} */
  let postBytes;
  let postStrictCount;
  if (retention === null) {
    if (!eventsProbe.present) {
      postBytes = Buffer.from(eventLineBytes);
    } else {
      postBytes = Buffer.concat([eventsProbe.bytes, eventLineBytes]);
    }
    postStrictCount = idle.events.strictRecordCount + 1;
  } else {
    postBytes = await buildRetentionFinalBytesFromPre(
      eventsProbe.present ? eventsProbe.bytes : Buffer.alloc(0),
      eventsProbe.present,
      eventLineUtf8,
      retention.maxEvents,
    );
    postStrictCount = Math.min(idle.events.strictRecordCount + 1, retention.maxEvents);
  }

  if (postStrictCount > AUDIT_CROSS_STORE_MAX_EVENT_LINES) {
    throw new AuditIntegrityCrossStoreError(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
    );
  }
  if (postBytes.length > AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES) {
    throw new AuditIntegrityCrossStoreError(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR,
    );
  }

  const eventsPost = {
    present: true,
    byteLength: postBytes.length,
    sha256: sha256Hex(postBytes),
    strictRecordCount: postStrictCount,
  };

  const prepared = {
    schemaVersion: 1,
    status: 'prepared',
    transactionId: randomUUID(),
    generationId: idle.generationId,
    retention: retention === null ? null : { maxEvents: retention.maxEvents },
    event: strictEvent,
    payloadDigest,
    eventLineUtf8,
    journal: {
      pre: {
        recordCount: plan.pre.recordCount,
        headDigest: plan.pre.headDigest,
        rawByteLength: plan.pre.rawByteLength,
        rawSha256: plan.pre.rawSha256,
      },
      post: {
        recordCount: plan.post.recordCount,
        headDigest: plan.post.headDigest,
        rawByteLength: plan.post.rawByteLength,
        rawSha256: plan.post.rawSha256,
        sequence: plan.post.sequence,
        linkDigest: plan.post.linkDigest,
        previousLinkDigest: plan.post.previousLinkDigest,
      },
    },
    events: {
      pre: {
        present: idle.events.present,
        byteLength: idle.events.byteLength,
        sha256: idle.events.sha256,
        strictRecordCount: idle.events.strictRecordCount,
      },
      post: eventsPost,
    },
  };

  return { prepared, plan, postBytes };
}

/**
 * S3 dual-write commit under active lease (idle already ensured).
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} idle
 * @param {{
 *   sanitized: object,
 *   strictEvent: object,
 *   eventLineUtf8: string,
 *   payloadDigest: string,
 *   retention: null | { maxEvents: number },
 *   crashHook?: string,
 * }} ctx
 */
async function commitDualWriteUnlocked(resolvedRoot, lease, idle, ctx) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  const { prepared, plan, postBytes } = await buildPreparedAndPlan(
    resolvedRoot,
    lease,
    idle,
    ctx,
  );

  // S3g: durable prepared BEFORE any journal/events mutation.
  await publishDualWriteStateUnlocked(resolvedRoot, lease, prepared);

  if (ctx.crashHook === 'after-prepared') {
    const err = new Error('TEST_CRASH_AFTER_PREPARED');
    err.code = 'TEST_CRASH_AFTER_PREPARED';
    throw err;
  }

  // S3h: journal post via module plan SoT; atomic write then exact plan.post check inside publish.
  await publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedRoot, lease, plan);

  if (ctx.crashHook === 'after-journal') {
    const err = new Error('TEST_CRASH_AFTER_JOURNAL');
    err.code = 'TEST_CRASH_AFTER_JOURNAL';
    throw err;
  }

  // S3i: events — two exclusive strategies.
  if (ctx.retention === null) {
    await appendEventsLineUnlocked(resolvedRoot, lease, ctx.eventLineUtf8);
  } else {
    await publishEventsFinalImageUnlocked(resolvedRoot, lease, postBytes);
  }

  if (ctx.crashHook === 'after-events') {
    const err = new Error('TEST_CRASH_AFTER_EVENTS');
    err.code = 'TEST_CRASH_AFTER_EVENTS';
    throw err;
  }

  // TEST ONLY per-call after-events-write hook (scoped; not module-global).
  if (typeof ctx.afterEventsWriteHook === 'function') {
    await ctx.afterEventsWriteHook(resolvedRoot);
  }

  // S3j primary fingerprints
  await assertPrimaryPostFingerprints(resolvedRoot, prepared);

  // S3k supplemental — always real verifier (no global bypass).
  await assertSupplementalPostRelationship(resolvedRoot);

  // S3l idle
  await publishIdleFromPreparedUnlocked(resolvedRoot, lease, prepared);

  return ctx.sanitized;
}

/**
 * Journal-first dual-write core. Return sanitized event (appendAuditEvent contract).
 * Completes sanitize → strict → stringify/digest/retention normalize before resolve/enqueue.
 * Enqueues exactly once.
 *
 * @param {string} dataDir
 * @param {unknown} event
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function appendAuditEventWithIntegrityDualWrite(dataDir, event, options = {}) {
  // Snapshot options before any await (call-time hostile/TOCTOU).
  let retentionInput;
  let crashHook;
  let afterEventsWriteHook;
  try {
    retentionInput = options == null ? undefined : options.retention;
    crashHook = options == null ? undefined : options[DUAL_WRITE_TEST_CRASH_HOOK];
    afterEventsWriteHook = options == null
      ? undefined
      : options[DUAL_WRITE_TEST_AFTER_EVENTS_WRITE];
  } catch {
    throw new AuditIntegrityJournalError(ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
  }

  const sanitized = sanitizeAuditEvent(event);
  let strictEvent;
  let eventLineUtf8;
  let payloadDigest;
  try {
    strictEvent = projectStrictCanonicalSanitizedEvent(sanitized);
    eventLineUtf8 = `${stringifyStrictCanonicalSanitizedEvent(strictEvent)}\n`;
    payloadDigest = computeAuditIntegrityEventPayloadDigest(strictEvent);
  } catch {
    throw new AuditIntegrityJournalError(ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
  }

  // Snapshot line/digest/event before enqueue (immutable strings / plain object copy).
  const frozenEvent = { ...strictEvent };
  const frozenLine = eventLineUtf8;
  const frozenDigest = payloadDigest;
  const retention = normalizeRetentionLocal(retentionInput);

  // Business line body bounds before side effects (excludes trailing newline).
  const frozenBodyLen = frozenLine.endsWith('\n')
    ? Buffer.byteLength(frozenLine.slice(0, -1), 'utf8')
    : Buffer.byteLength(frozenLine, 'utf8');
  if (frozenBodyLen > AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES) {
    throw new AuditIntegrityCrossStoreError(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
    );
  }

  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(dataDir);
  } catch (error) {
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    throwIoError();
  }

  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    const idle = await ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease);
    return commitDualWriteUnlocked(resolvedRoot, lease, idle, {
      sanitized,
      strictEvent: frozenEvent,
      eventLineUtf8: frozenLine,
      payloadDigest: frozenDigest,
      retention,
      crashHook: typeof crashHook === 'string' ? crashHook : undefined,
      afterEventsWriteHook:
        typeof afterEventsWriteHook === 'function' ? afterEventsWriteHook : undefined,
    });
  });
}
