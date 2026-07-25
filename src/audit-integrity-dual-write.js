/**
 * V1.37 journal-first crash-recoverable audit dual-write coordinator implementation
 *
 * Signature ceiling (only allowed completion claim):
 *   V1.37 journal-first crash-recoverable audit dual-write coordinator implementation
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
 * Production wiring (C5 delivered; sole controlled caller):
 *   src/audit-log.js is the only production static importer of this module and
 *   appendAuditEvent body calls appendAuditEventWithIntegrityDualWrite exactly once.
 *   server.js / agent.js never import this coordinator (they use audit-log only).
 * Does NOT import audit-log (no cycle).
 * Does NOT reimplement journal hash/link or events strict parser formulas.
 *
 * BLOCKED / not delivered (do not claim):
 * - T6d.3 complete / M6d Exit / production-hardening ready / Gold ready
 * - authenticity / external trusted anchor / HMAC / signature
 * - multi-process exclusive lock (single-process queue only)
 * - journal rotation / monitor / alert
 * - end-to-end production audit delivery (caller may swallow failures)
 * - state continuity under adversarial state deletion (delete state → re-bootstrap; not protection)
 * - WORM / immutable
 * - automatic next generation / production detects as full e2e delivery
 *
 * Honest limitations:
 * - T6d.3 still partial only (not T6d.3 complete; not M6d Exit)
 * - single-process write queue only; no multi-process exclusive lock
 * - server.recordAudit / agent appendNasReplicationAudit remain best-effort catch
 *   (not end-to-end production audit delivery)
 * - not state continuity under adversarial state deletion: missing state may re-bootstrap
 *   from self-consistent journal/events; that is a limitation, not delivered protection
 * - no external authenticity / HMAC / signature / WORM / immutable
 * - no journal rotation / monitor / alert
 *
 * Forbidden capability compound (prefix + suffix joined) is never written as a
 * contiguous English literal in this file; tests scan via runtime concat.
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
import {
  AuditIntegrityRotationError,
  assertAuditIntegrityRotationAllowsAppendUnlocked,
} from './audit-integrity-rotation-state.js';

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
 * Module-private sentinel for the idle-cursor cross-store probe stage only.
 * Wraps ANY error from assertEventsUtf8Baseline + verifyCrossStoreBaseline so
 * production can catch-all remap to cursor-mismatch (V1.37 contract) while
 * the inspector unwraps for precise journal/cross-store classification.
 *
 * Not exported. Path-free: message is a fixed sentinel; never copies
 * underlying path/message into public observation surfaces.
 */
class IdleCursorCrossStoreProbeError extends Error {
  /**
   * @param {unknown} underlying
   */
  constructor(underlying) {
    super('idle-cursor-cross-store-probe');
    this.name = 'IdleCursorCrossStoreProbeError';
    /** @type {unknown} */
    this.underlying = underlying;
  }
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
 * Private granular read-only idle cursor/cross-store classification (V1.38).
 * Reuses journal/events fingerprint + cross-store SoT — no formula copy.
 *
 * Stage contract (inspector SoT; production remaps only via wrapper):
 *   1) first measureJournalFingerprint — typed journal errors rethrow unwrapped
 *   2) journal/events raw fingerprint field mismatch →
 *        { cursorMatch:'mismatch', receipt:null } (journal verified; cross not run)
 *   3) readEventsBytes dual-write IO — rethrow unwrapped (events layer)
 *   4) assertEventsUtf8Baseline + verifyCrossStoreBaseline — ANY throw is wrapped
 *        in IdleCursorCrossStoreProbeError (incl second journal probe JournalError,
 *        CrossStoreError, recovery-conflict, unexpected). underlying preserved.
 *   5) receipt ok but strictRecordCount ≠ idle state →
 *        { cursorMatch:'mismatch', receipt }
 *   6) success → { cursorMatch:'match', receipt }
 *
 * Production catches IdleCursorCrossStoreProbeError → throwCursorMismatch (V1.37).
 * Inspector unwraps underlying for precise journal/cross-store outcomes.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} state idle dual-write state
 * @returns {Promise<{
 *   cursorMatch: 'match'|'mismatch',
 *   receipt: { state: string, retainedEventCount: number, relationship: string }|null
 * }>}
 */
async function measureIdleCursorAgainstStoresGranularUnlocked(resolvedRoot, lease, state) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  // 1) first journal measure — typed journal errors (not-init / chain / io / bounds)
  // rethrow unwrapped (V1.37: measureJournalFingerprint outside try-catch).
  const journalFp = await measureJournalFingerprint(resolvedRoot);

  // 2) raw journal fingerprint field mismatch (incl generationId) — stage preserved.
  if (journalFp.generationId !== state.generationId) {
    return { cursorMatch: 'mismatch', receipt: null };
  }
  if (
    journalFp.recordCount !== state.journal.recordCount
    || journalFp.headDigest !== state.journal.headDigest
    || journalFp.rawByteLength !== state.journal.rawByteLength
    || journalFp.rawSha256 !== state.journal.rawSha256
  ) {
    return { cursorMatch: 'mismatch', receipt: null };
  }

  // 3) Events raw read may throw dual-write IO (after journal verified; cross-store not run).
  // Unwrapped — same as V1.37 (readEventsBytes outside cross-store catch).
  const eventsProbe = await readEventsBytes(resolvedRoot);
  const rawPresent = eventsProbe.present;
  const rawByteLength = eventsProbe.present ? eventsProbe.bytes.length : 0;
  const rawSha256 = eventsProbe.present ? sha256Hex(eventsProbe.bytes) : EMPTY_FILE_SHA256;

  // 2b) raw events fingerprint field mismatch (present/byteLength/sha256 only).
  if (
    rawPresent !== state.events.present
    || rawByteLength !== state.events.byteLength
    || rawSha256 !== state.events.sha256
  ) {
    return { cursorMatch: 'mismatch', receipt: null };
  }

  // 4) UTF-8 baseline + cross-store SoT — wrap ANY throw for V1.37 production catch-all
  // (includes second journal inspect race → AuditIntegrityJournalError).
  /** @type {{ state: string, retainedEventCount: number, relationship: string }} */
  let receipt;
  try {
    if (eventsProbe.present) {
      assertEventsUtf8Baseline(eventsProbe.bytes);
    }
    receipt = await verifyCrossStoreBaseline(resolvedRoot);
  } catch (error) {
    if (error instanceof IdleCursorCrossStoreProbeError) throw error;
    throw new IdleCursorCrossStoreProbeError(error);
  }

  // 5) strictRecordCount vs idle state after successful receipt (result metadata).
  if (receipt.retainedEventCount !== state.events.strictRecordCount) {
    return { cursorMatch: 'mismatch', receipt };
  }

  // 6) success
  return { cursorMatch: 'match', receipt };
}

/**
 * Exact idle cursor validation against live store bytes (production path).
 * Delegates to granular precise helper, then remaps:
 *   - mismatch results → cursor-mismatch
 *   - IdleCursorCrossStoreProbeError (entire cross-store stage, any underlying)
 *     → cursor-mismatch (V1.37 catch-all; no underlying-type guessing)
 * First-stage journal typed errors and events dual-write IO propagate as-is.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} state
 */
async function validateIdleCursorAgainstStoresUnlocked(resolvedRoot, lease, state) {
  try {
    const result = await measureIdleCursorAgainstStoresGranularUnlocked(
      resolvedRoot,
      lease,
      state,
    );
    if (result.cursorMatch === 'mismatch') {
      throwCursorMismatch();
    }
    return state;
  } catch (error) {
    // V1.37 catch-all: cross-store stage (UTF-8 / cross-store typed / second journal
    // probe JournalError / recovery-conflict / unexpected) → cursor-mismatch.
    if (error instanceof IdleCursorCrossStoreProbeError) {
      throwCursorMismatch();
    }
    throw error;
  }
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
 * Lease-bound read-only exact-idle validator for rotation and other same-root
 * callers. Loads existing dual-write state only: never bootstraps, never recovers
 * prepared, never publishes/writes. Missing or non-idle state is STATE_INVALID.
 * On exact idle, reuses the existing idle cursor/cross-store validator (no formula copy).
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @returns {Promise<object>} validated idle dual-write state
 */
export async function validateAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);
  const state = await loadDualWriteStateUnlocked(resolvedRoot, lease);
  if (state === null || state.status !== 'idle') {
    throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
  }
  return validateIdleCursorAgainstStoresUnlocked(resolvedRoot, lease, state);
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

// ── V1.38 public read-only inspector ───────────────────────────────────

/** @typedef {'absent'|'idle'|'prepared'|'invalid'|'io-error'} DualWriteStatePresence */
/** @typedef {'idle'|'prepared'|null} DualWriteStateStatus */
/** @typedef {'n/a'|'match'|'mismatch'|'skipped'} DualWriteCursorMatch */
/** @typedef {'missing'|'verified'|'typed-error'|'skipped'} DualWriteJournalOutcome */
/** @typedef {'ok'|'typed-error'|'skipped'} DualWriteCrossStoreOutcome */
/** @typedef {'none'|'state'|'journal'|'events'|'cross-store'|'cursor'|'root'} DualWriteErrorLayer */

/**
 * @typedef {object} DualWriteReadOnlyObservation
 * @property {DualWriteStatePresence} statePresence
 * @property {DualWriteStateStatus} stateStatus
 * @property {boolean} storesEmpty
 * @property {DualWriteCursorMatch} cursorMatch
 * @property {DualWriteJournalOutcome} journalOutcome
 * @property {DualWriteCrossStoreOutcome} crossStoreOutcome
 * @property {string|null} relationship
 * @property {string|null} reasonCode
 * @property {DualWriteErrorLayer} errorLayer
 */

/**
 * Deep-freeze observation with exact key order (path-free; no dualWriteState).
 * @param {DualWriteReadOnlyObservation} fields
 * @returns {Readonly<DualWriteReadOnlyObservation>}
 */
function freezeReadOnlyObservation(fields) {
  return Object.freeze({
    statePresence: fields.statePresence,
    stateStatus: fields.stateStatus,
    storesEmpty: fields.storesEmpty,
    cursorMatch: fields.cursorMatch,
    journalOutcome: fields.journalOutcome,
    crossStoreOutcome: fields.crossStoreOutcome,
    relationship: fields.relationship,
    reasonCode: fields.reasonCode,
    errorLayer: fields.errorLayer,
  });
}

/**
 * #7 Sio / #7b RootFail full frozen observation mapping (design §3.2).
 * @param {'state'|'root'} errorLayer
 * @returns {Readonly<DualWriteReadOnlyObservation>}
 */
function freezeIoObservation(errorLayer) {
  return freezeReadOnlyObservation({
    statePresence: 'io-error',
    stateStatus: null,
    storesEmpty: false,
    cursorMatch: 'skipped',
    journalOutcome: 'skipped',
    crossStoreOutcome: 'skipped',
    relationship: null,
    reasonCode: ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
    errorLayer,
  });
}

/**
 * Narrow typed-error observation helper for paths where stage is fully known
 * at the call site. Prefer explicit freeze at call sites when stage must be
 * preserved; this helper only maps pure journal-first typed failures without
 * inventing completed probes.
 *
 * @param {unknown} error
 * @param {{
 *   statePresence: DualWriteStatePresence,
 *   stateStatus: DualWriteStateStatus,
 *   storesEmpty?: boolean,
 *   cursorMatch: DualWriteCursorMatch,
 * }} base
 * @returns {Readonly<DualWriteReadOnlyObservation>}
 */
function observationFromJournalTypedError(error, base) {
  if (error instanceof AuditIntegrityJournalError) {
    const notInit = error.code === ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED;
    return freezeReadOnlyObservation({
      statePresence: base.statePresence,
      stateStatus: base.stateStatus,
      storesEmpty: base.storesEmpty === true,
      cursorMatch: base.cursorMatch,
      journalOutcome: notInit ? 'missing' : 'typed-error',
      crossStoreOutcome: 'skipped',
      relationship: null,
      reasonCode: error.code,
      errorLayer: 'journal',
    });
  }
  // Unexpected: fail-closed path-free dual-write IO (no fake probe outcomes).
  return freezeIoObservation('state');
}

/**
 * State-absent read-only classification (#1 / #2a / #2b).
 * Preserves journalOutcome when subsequent cross-store typed error hits.
 * @param {string} resolvedRoot
 * @returns {Promise<Readonly<DualWriteReadOnlyObservation>>}
 */
async function observeStateAbsentReadOnly(resolvedRoot) {
  /** @type {DualWriteJournalOutcome} */
  let journalOutcome = 'skipped';
  let journalMissing = false;

  try {
    await inspectAuditIntegrityJournalFile(resolvedRoot);
    journalOutcome = 'verified';
  } catch (error) {
    if (
      error instanceof AuditIntegrityJournalError
      && error.code === ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED
    ) {
      journalMissing = true;
      journalOutcome = 'missing';
    } else if (error instanceof AuditIntegrityJournalError) {
      // #2b typed journal (integrity or IO) — cross-store not executed; cursor n/a.
      return observationFromJournalTypedError(error, {
        statePresence: 'absent',
        stateStatus: null,
        storesEmpty: false,
        cursorMatch: 'n/a',
      });
    } else {
      return freezeIoObservation('state');
    }
  }

  try {
    const receipt = await verifyAuditIntegrityAgainstEventStore(resolvedRoot);
    const eventsEmpty = receipt.retainedEventCount === 0;
    // SoT: journal missing/NOT_INITIALIZED AND events missing-or-zero-strict.
    const storesEmpty = journalMissing && eventsEmpty;

    if (storesEmpty) {
      // #1 cold empty — relationship null fixed (not receipt 'empty').
      return freezeReadOnlyObservation({
        statePresence: 'absent',
        stateStatus: null,
        storesEmpty: true,
        cursorMatch: 'n/a',
        journalOutcome: 'missing',
        crossStoreOutcome: 'ok',
        relationship: null,
        reasonCode: null,
        errorLayer: 'none',
      });
    }

    // #2a state-missing + receipt success — relationship exact receipt enum.
    return freezeReadOnlyObservation({
      statePresence: 'absent',
      stateStatus: null,
      storesEmpty: false,
      cursorMatch: 'n/a',
      journalOutcome,
      crossStoreOutcome: 'ok',
      relationship: typeof receipt.relationship === 'string' ? receipt.relationship : null,
      reasonCode: null,
      errorLayer: 'none',
    });
  } catch (error) {
    // Cross-store path may rethrow AuditIntegrityJournalError from its own journal
    // inspect (race after our first probe). Map precisely as journal error — not
    // generic dual-write IO / errorLayer state.
    if (error instanceof AuditIntegrityJournalError) {
      return observationFromJournalTypedError(error, {
        statePresence: 'absent',
        stateStatus: null,
        storesEmpty: false,
        cursorMatch: 'n/a',
      });
    }
    // #2b: journal probe already completed (verified|missing) — keep it; mark cross-store.
    if (error instanceof AuditIntegrityCrossStoreError) {
      return freezeReadOnlyObservation({
        statePresence: 'absent',
        stateStatus: null,
        storesEmpty: false,
        cursorMatch: 'n/a',
        journalOutcome,
        crossStoreOutcome: 'typed-error',
        relationship: null,
        reasonCode: error.code,
        errorLayer: 'cross-store',
      });
    }
    // Unexpected under lease after journal probe — fail-closed; do not invent probe outcomes.
    return freezeReadOnlyObservation({
      statePresence: 'absent',
      stateStatus: null,
      storesEmpty: false,
      cursorMatch: 'n/a',
      journalOutcome,
      crossStoreOutcome: 'skipped',
      relationship: null,
      reasonCode: ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
      errorLayer: 'state',
    });
  }
}

/**
 * Idle-state read-only classification (P6a–P6i via granular helper).
 * Outcome fields always reflect real probe stage from granular result/throws.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} state
 * @returns {Promise<Readonly<DualWriteReadOnlyObservation>>}
 */
async function observeStateIdleReadOnly(resolvedRoot, lease, state) {
  try {
    const result = await measureIdleCursorAgainstStoresGranularUnlocked(
      resolvedRoot,
      lease,
      state,
    );

    // Raw fingerprint mismatch: journal verified; cross-store not executed.
    if (result.cursorMatch === 'mismatch' && result.receipt === null) {
      return freezeReadOnlyObservation({
        statePresence: 'idle',
        stateStatus: 'idle',
        storesEmpty: false,
        cursorMatch: 'mismatch',
        journalOutcome: 'verified',
        crossStoreOutcome: 'skipped',
        relationship: null,
        reasonCode: ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH,
        errorLayer: 'cursor',
      });
    }

    // Strict-count mismatch after successful receipt: journal verified; cross-store ok.
    if (result.cursorMatch === 'mismatch' && result.receipt !== null) {
      return freezeReadOnlyObservation({
        statePresence: 'idle',
        stateStatus: 'idle',
        storesEmpty: false,
        cursorMatch: 'mismatch',
        journalOutcome: 'verified',
        crossStoreOutcome: 'ok',
        relationship: null,
        reasonCode: ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH,
        errorLayer: 'cursor',
      });
    }

    const receipt = result.receipt;
    const relationship =
      receipt && typeof receipt.relationship === 'string' ? receipt.relationship : null;

    if (relationship === 'empty') {
      // #12 idle + empty — relationship-empty fail-closed attention only.
      // storesEmpty SoT is cold journal-missing ∧ events-empty; NOT relationship=empty.
      return freezeReadOnlyObservation({
        statePresence: 'idle',
        stateStatus: 'idle',
        storesEmpty: false,
        cursorMatch: 'match',
        journalOutcome: 'verified',
        crossStoreOutcome: 'ok',
        relationship: 'empty',
        reasonCode: null,
        errorLayer: 'none',
      });
    }

    if (relationship === 'uncovered-events') {
      // #13 uncovered-events — fail-closed; reasonCode null fixed.
      return freezeReadOnlyObservation({
        statePresence: 'idle',
        stateStatus: 'idle',
        storesEmpty: false,
        cursorMatch: 'match',
        journalOutcome: 'verified',
        crossStoreOutcome: 'ok',
        relationship: 'uncovered-events',
        reasonCode: null,
        errorLayer: 'none',
      });
    }

    if (relationship !== null && ALLOWED_SUPPLEMENTAL_RELATIONSHIPS.has(relationship)) {
      // #4 healthy precursor.
      return freezeReadOnlyObservation({
        statePresence: 'idle',
        stateStatus: 'idle',
        storesEmpty: false,
        cursorMatch: 'match',
        journalOutcome: 'verified',
        crossStoreOutcome: 'ok',
        relationship,
        reasonCode: null,
        errorLayer: 'none',
      });
    }

    // Unexpected relationship — fail-closed integrity-shaped observation.
    return freezeReadOnlyObservation({
      statePresence: 'idle',
      stateStatus: 'idle',
      storesEmpty: false,
      cursorMatch: 'match',
      journalOutcome: 'verified',
      crossStoreOutcome: 'ok',
      relationship: null,
      reasonCode: null,
      errorLayer: 'none',
    });
  } catch (error) {
    // #11 idle + not-initialized / other journal typed from first measure — unwrapped.
    if (error instanceof AuditIntegrityJournalError) {
      const notInit = error.code === ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED;
      return freezeReadOnlyObservation({
        statePresence: 'idle',
        stateStatus: 'idle',
        storesEmpty: false,
        cursorMatch: 'skipped',
        journalOutcome: notInit ? 'missing' : 'typed-error',
        crossStoreOutcome: 'skipped',
        relationship: null,
        reasonCode: error.code,
        errorLayer: 'journal',
      });
    }

    // Cross-store stage wrapper — unwrap underlying for precise classification.
    // Production remaps the whole wrapper to cursor-mismatch; inspector must not.
    if (error instanceof IdleCursorCrossStoreProbeError) {
      const underlying = error.underlying;

      // Second journal probe race inside verifyCrossStoreBaseline.
      if (underlying instanceof AuditIntegrityJournalError) {
        const notInit = underlying.code === ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED;
        return freezeReadOnlyObservation({
          statePresence: 'idle',
          stateStatus: 'idle',
          storesEmpty: false,
          cursorMatch: 'skipped',
          journalOutcome: notInit ? 'missing' : 'typed-error',
          crossStoreOutcome: 'skipped',
          relationship: null,
          reasonCode: underlying.code,
          errorLayer: 'journal',
        });
      }

      if (underlying instanceof AuditIntegrityCrossStoreError) {
        return freezeReadOnlyObservation({
          statePresence: 'idle',
          stateStatus: 'idle',
          storesEmpty: false,
          cursorMatch: 'skipped',
          journalOutcome: 'verified',
          crossStoreOutcome: 'typed-error',
          relationship: null,
          reasonCode: underlying.code,
          errorLayer: 'cross-store',
        });
      }

      // verifyCrossStoreBaseline recovery-conflict: journal verified; receipt unusable.
      if (
        underlying instanceof AuditIntegrityDualWriteError
        && underlying.code === ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT
      ) {
        return freezeReadOnlyObservation({
          statePresence: 'idle',
          stateStatus: 'idle',
          storesEmpty: false,
          cursorMatch: 'skipped',
          journalOutcome: 'verified',
          crossStoreOutcome: 'skipped',
          relationship: null,
          reasonCode: underlying.code,
          errorLayer: 'cross-store',
        });
      }

      // Unexpected under cross-store stage — path-free dual-write IO; no raw leak.
      return freezeReadOnlyObservation({
        statePresence: 'idle',
        stateStatus: 'idle',
        storesEmpty: false,
        cursorMatch: 'skipped',
        journalOutcome: 'verified',
        crossStoreOutcome: 'skipped',
        relationship: null,
        reasonCode: ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
        errorLayer: 'cross-store',
      });
    }

    // Events-layer dual-write IO (e.g. readEventsBytes) after journal verified; unwrapped.
    if (
      error instanceof AuditIntegrityDualWriteError
      && error.code === ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR
    ) {
      return freezeReadOnlyObservation({
        statePresence: 'idle',
        stateStatus: 'idle',
        storesEmpty: false,
        cursorMatch: 'skipped',
        journalOutcome: 'verified',
        crossStoreOutcome: 'skipped',
        relationship: null,
        reasonCode: error.code,
        errorLayer: 'events',
      });
    }

    // Fail-closed; do not invent completed probe outcomes.
    return freezeReadOnlyObservation({
      statePresence: 'idle',
      stateStatus: 'idle',
      storesEmpty: false,
      cursorMatch: 'skipped',
      journalOutcome: 'skipped',
      crossStoreOutcome: 'skipped',
      relationship: null,
      reasonCode: ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
      errorLayer: 'state',
    });
  }
}

/**
 * Lease-gated read-only observation (no bootstrap/recover/publish/write).
 * @param {string} resolvedRoot
 * @param {object} lease
 * @returns {Promise<Readonly<DualWriteReadOnlyObservation>>}
 */
async function observeAuditIntegrityDualWriteReadOnlyUnlocked(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  let state;
  try {
    state = await loadDualWriteStateUnlocked(resolvedRoot, lease);
  } catch (error) {
    if (error instanceof AuditIntegrityDualWriteError) {
      if (error.code === ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID) {
        return freezeReadOnlyObservation({
          statePresence: 'invalid',
          stateStatus: null,
          storesEmpty: false,
          cursorMatch: 'skipped',
          journalOutcome: 'skipped',
          crossStoreOutcome: 'skipped',
          relationship: null,
          reasonCode: ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
          errorLayer: 'state',
        });
      }
      if (error.code === ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR) {
        // #7 Sio full freeze.
        return freezeIoObservation('state');
      }
    }
    return freezeIoObservation('state');
  }

  // #3 prepared short-circuit — relationship null; do not probe cross-store/journal for fill.
  if (state !== null && state.status === 'prepared') {
    return freezeReadOnlyObservation({
      statePresence: 'prepared',
      stateStatus: 'prepared',
      storesEmpty: false,
      cursorMatch: 'skipped',
      journalOutcome: 'skipped',
      crossStoreOutcome: 'skipped',
      relationship: null,
      reasonCode: null,
      errorLayer: 'none',
    });
  }

  if (state === null) {
    return observeStateAbsentReadOnly(resolvedRoot);
  }

  if (state.status === 'idle') {
    return observeStateIdleReadOnly(resolvedRoot, lease, state);
  }

  // Unexpected status after load (schema should forbid) — treat as invalid.
  return freezeReadOnlyObservation({
    statePresence: 'invalid',
    stateStatus: null,
    storesEmpty: false,
    cursorMatch: 'skipped',
    journalOutcome: 'skipped',
    crossStoreOutcome: 'skipped',
    relationship: null,
    reasonCode: ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
    errorLayer: 'state',
  });
}

/**
 * Public read-only consistent observation of dual-write integrity stores.
 * assertSafeDataRoot first; RootFail → frozen path-free IO observation
 * (enqueue 0; no root create). Valid resolvedRoot only → enqueue exactly
 * once + fresh lease → observe → return frozen snapshot.
 * NEVER bootstrap / recover / publish / write any store.
 *
 * @param {string} dataDir
 * @param {object} [options] fully reserved; void options; no property/reflection/enumeration
 * @returns {Promise<Readonly<DualWriteReadOnlyObservation>>}
 */
export async function inspectAuditIntegrityDualWriteReadOnly(dataDir, options = {}) {
  // Fully reserved options slot: void only — no property/reflection/enumeration.
  // Hostile Proxy traps on options must not run on this path.
  void options;

  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(dataDir);
  } catch {
    // #7b RootFail: enqueue 0; no root create; path-free IO observation.
    return freezeIoObservation('root');
  }

  // Valid resolved root only → exactly one enqueue + fresh lease.
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    assertAuditIntegrityWriteLease(resolvedRoot, lease);
    return observeAuditIntegrityDualWriteReadOnlyUnlocked(resolvedRoot, lease);
  });
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
    // Rotation gate before any dual-state load/interpret/bootstrap/recover or store mutation.
    const completedRotation =
      await assertAuditIntegrityRotationAllowsAppendUnlocked(resolvedRoot, lease);
    const idle = await ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease);
    if (
      completedRotation !== null
      && idle.generationId !== completedRotation.nextGenerationId
    ) {
      throw new AuditIntegrityRotationError(
        ERROR_CODES.AUDIT_INTEGRITY_ROTATION_CONFLICT,
      );
    }
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
