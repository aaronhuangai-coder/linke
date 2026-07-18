/**
 * V1.37 C3: dual-write coordinator bootstrap + idle cursor validation.
 *
 * Public surface (this boundary):
 *   recoverAndValidateAuditIntegrityDualWrite(root)
 *     → resolve safe root → enqueue shared queue once → unlocked ensure idle
 *
 * @internal:
 *   ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease)
 *     S3a load state
 *     S3b prepared → recovery-not-yet-exposed (RECOVERY_CONFLICT); C4 replaces
 *     S3c state missing → bootstrap idle (verified|partial only; never broken)
 *     S3d idle → exact cursor validate (mismatch → CURSOR_MISMATCH)
 *
 * Does NOT implement C4 recovery classifier/repair.
 * Does NOT wire production appendAuditEvent (C5).
 * Does NOT reimplement state parser, journal hash/link, or events strict parser.
 * Does NOT create a second queue Map.
 *
 * Limitation (honest, not delivered protection): state deletion + forged
 * self-consistent stores can re-trigger bootstrap; V1.37 has no external
 * authenticity anchor and does not deliver state continuity.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  SafeDataFileError,
  assertSafeDataRoot,
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
} from './audit-integrity-dual-write-state.js';
import {
  AuditIntegrityJournalError,
  AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
  AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES,
  initializeAuditIntegrityJournalUnlocked,
  inspectAuditIntegrityJournalFile,
} from './audit-integrity-journal.js';
import {
  AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
  AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES,
  verifyAuditIntegrityAgainstEventStore,
} from './audit-integrity-cross-store.js';

const EMPTY_FILE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
  // C3 boundary: recovery-not-yet-exposed. C4 replaces this gate with recoverPrepared.
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
 * Read events store raw + present flag. Exact ENOENT → absent.
 * Other Safe/IO failures → dual-write IO (path-free).
 *
 * @param {string} resolvedRoot
 * @returns {Promise<{ present: boolean, raw: string }>}
 */
async function readEventsRaw(resolvedRoot) {
  try {
    const raw = await safeReadText(
      resolvedRoot,
      AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
      { maxBytes: AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES },
    );
    return { present: true, raw };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { present: false, raw: '' };
    }
    if (error instanceof AuditIntegrityDualWriteError) throw error;
    if (error instanceof SafeDataFileError) throwIoError();
    throwIoError();
  }
}

/**
 * Measure journal fingerprint from real current bytes + inspect SoT.
 * Propagates journal typed errors (only exact NOT_INITIALIZED is missing).
 *
 * @param {string} resolvedRoot
 * @returns {Promise<{
 *   generationId: string,
 *   recordCount: number,
 *   headDigest: string,
 *   rawByteLength: number,
 *   rawSha256: string,
 * }>}
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
    if (error && error.code === 'ENOENT') {
      throw new AuditIntegrityJournalError(ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED);
    }
    throw new AuditIntegrityJournalError(ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
  }
  return {
    generationId: snapshot.generationId,
    recordCount: snapshot.recordCount,
    headDigest: snapshot.headDigest,
    rawByteLength: Buffer.byteLength(raw, 'utf8'),
    rawSha256: sha256Hex(raw),
  };
}

/**
 * Structural relationship via V1.36 verifier SoT.
 * Only verified | partial receipts are usable for bootstrap.
 * broken / parse errors propagate typed (never swallowed as missing).
 *
 * @param {string} resolvedRoot
 * @returns {Promise<{
 *   state: 'verified' | 'partial',
 *   retainedEventCount: number,
 * }>}
 */
async function verifyCrossStoreBaseline(resolvedRoot) {
  const receipt = await verifyAuditIntegrityAgainstEventStore(resolvedRoot);
  if (receipt.state !== 'verified' && receipt.state !== 'partial') {
    // Verifier contract only returns verified|partial or throws; never write idle.
    throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT);
  }
  return {
    state: receipt.state,
    retainedEventCount: receipt.retainedEventCount,
  };
}

/**
 * Build events fingerprint from raw probe + strict count from verifier.
 *
 * @param {{ present: boolean, raw: string }} eventsProbe
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
    byteLength: Buffer.byteLength(eventsProbe.raw, 'utf8'),
    sha256: sha256Hex(eventsProbe.raw),
    strictRecordCount,
  };
}

/**
 * Bootstrap idle when state is exact-missing (load returned null).
 * Never auto-repair Jbad; never write idle on broken J↔E.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @returns {Promise<object>} frozen idle state
 */
async function bootstrapDualWriteIdleUnlocked(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  // --- journal presence probe (only exact NOT_INITIALIZED = missing) ---
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
      // Jbad / IO / bounds / dir leaf / etc. — propagate typed; do not init/repair.
      throw error;
    }
  }

  // --- events probe before any write (Ebad must fail before journal/state write) ---
  const eventsProbe = await readEventsRaw(resolvedRoot);

  // Cross-store structural check (also validates events strict parse via verifier SoT).
  // When journal missing: J=[] side; Ebad throws here before init.
  // When journal present: broken relationship throws; verified|partial allowed.
  let cross = await verifyCrossStoreBaseline(resolvedRoot);

  let generationId;
  if (journalMissing) {
    generationId = newGenerationId();
    await initializeAuditIntegrityJournalUnlocked(resolvedRoot, lease, { generationId });
    // Re-check after init (must remain verified|partial; never broken).
    cross = await verifyCrossStoreBaseline(resolvedRoot);
  }

  const journalFp = await measureJournalFingerprint(resolvedRoot);
  generationId = journalFp.generationId;

  const eventsFp = buildEventsFingerprint(eventsProbe, cross.retainedEventCount);

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
 * generationId mismatch and any fingerprint drift → CURSOR_MISMATCH.
 * Underlying structural journal failures may propagate as more specific typed journal errors.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} state frozen idle from load
 * @returns {Promise<object>} same idle when exact match
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

  const eventsProbe = await readEventsRaw(resolvedRoot);
  // Prefer raw fingerprint compare (present/bytes/sha) without needing parse success
  // for the drift decision; strict count re-checked via verifier when raw matches.
  const rawPresent = eventsProbe.present;
  const rawByteLength = eventsProbe.present
    ? Buffer.byteLength(eventsProbe.raw, 'utf8')
    : 0;
  const rawSha256 = eventsProbe.present
    ? sha256Hex(eventsProbe.raw)
    : EMPTY_FILE_SHA256;

  if (
    rawPresent !== state.events.present
    || rawByteLength !== state.events.byteLength
    || rawSha256 !== state.events.sha256
  ) {
    throwCursorMismatch();
  }

  // Raw matches → reconfirm strictRecordCount via cross-store SoT (no formula fork).
  // Parse/relationship failure with idle present is external drift → cursor-mismatch.
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
 * @internal Ensure dual-write idle cursor is ready under an active same-root lease.
 * Must be called inside enqueueAuditIntegrityWriteTask callback (or equivalent ALS lease).
 *
 * @param {string} resolvedRoot absolute normalized resolved root
 * @param {object} lease active audit integrity write lease
 * @returns {Promise<object>} frozen path-free idle state
 */
export async function ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  const state = await loadDualWriteStateUnlocked(resolvedRoot, lease);

  // S3b: prepared → recovery-not-yet-exposed (C3). MUST NOT no-op as idle; MUST NOT clear.
  if (state !== null && state.status === 'prepared') {
    throwRecoveryConflict();
  }

  // S3c: exact missing (load null = ENOENT only) → bootstrap
  if (state === null) {
    return bootstrapDualWriteIdleUnlocked(resolvedRoot, lease);
  }

  // S3d: idle → exact validate
  if (state.status === 'idle') {
    return validateIdleCursorAgainstStoresUnlocked(resolvedRoot, lease, state);
  }

  // Any other status should already have failed C2 parser; fail closed.
  throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
}

/**
 * Public recover/validate entry: resolve root → enqueue once → unlocked ensure idle.
 * Nested enqueue is forbidden by queue infrastructure.
 * Does not gate-before-enqueue.
 *
 * Success: frozen path-free idle state (no paths, raw event bodies, or secrets).
 *
 * @param {string} root existing safe data root
 * @returns {Promise<object>}
 */
export async function recoverAndValidateAuditIntegrityDualWrite(root) {
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
