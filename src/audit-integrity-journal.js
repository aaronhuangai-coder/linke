/**
 * Audit integrity journal — unkeyed hash-chain structural consistency foundation.
 * 无密钥哈希链结构一致性基座（V1.35 partial foundation / T6d.3 partial only）.
 *
 * Verifies ONLY journal-internal structure self-consistency.
 * Does NOT provide authenticity or cryptographic anti-tamper resistance.
 * No external trusted anchor / HMAC / signature.
 * Cannot detect: self-consistent suffix rewrite; legal tail truncation;
 * events-only mutation; full-file / new-generation replacement.
 * payloadDigest at verify: format check + link preimage input only;
 * does NOT recompute event payload preimage and does NOT look up events.
 *
 * BLOCKED (V1.35 — do not claim complete):
 * - T6d.3 complete / M6d Exit / production-hardening ready / production integration
 * - production dual-write (events.jsonl ↔ integrity-journal)
 * - public surface (server/agent/Web/HTTP/CLI)
 * - external trusted anchor / HMAC / signature / head file / priorChainHeadDigest
 * - new generation after chain-break / automatic next generation / recovery / auto-repair / truncate
 * - retention / rotation / monitor / alert
 * - capability / approval binding
 * - multi-process exclusive writer lock
 * - missing trusted-recovery authorization model
 * - authenticity / tamper-resistance / cryptographic anti-tamper / compliance audit-chain complete
 * - detection of: suffix rewrite | tail truncation | events-only mutation | full-file replacement
 *   (no external anchor; honest limitation tests must PASS with verify success)
 *
 * ALLOWED capability name only:
 *   unkeyed hash-chain structural consistency foundation
 *   无密钥哈希链结构一致性基座
 */

import { createHash } from 'node:crypto';
import {
  SafeDataFileError,
  assertSafeDataRoot,
  safeCreateExclusiveText,
  safeReadText,
} from './safe-data-files.js';
import { ERROR_CODES, assertRegisteredErrorCode } from './error-codes.js';

/** Relative path under data root for the integrity journal (not events.jsonl). */
export const AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH = 'audit/integrity-journal.jsonl';

/** safeReadText maxBytes; size overlimit → io-error (never bounds-exceeded). */
export const AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES = 1_572_864;

/** Append preflight allows existing lines ≤ this value (open counts as record #1). */
export const AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES = 4096;

/** API-reachable max lines after a legal append (= existing 4096 + 1). */
export const AUDIT_INTEGRITY_JOURNAL_MAX_LINES_AFTER_APPEND = 4097;

/** Per-line UTF-8 max (checked before JSON.parse); over → bounds-exceeded. */
export const AUDIT_INTEGRITY_JOURNAL_MAX_RECORD_LINE_BYTES = 374;

const SCHEMA_VERSION = 1;
const RECORD_KIND_OPEN = 'generation-open';
const RECORD_KIND_EVENT = 'event-link';

const DOMAIN_GENERATION_OPEN = 'linke.audit-integrity-journal.v1.generation-open\u0000';
const DOMAIN_EVENT_LINK = 'linke.audit-integrity-journal.v1.event-link\u0000';

const GENERATION_ID_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const RECORD_KEYS = Object.freeze([
  'schemaVersion',
  'recordKind',
  'generationId',
  'sequence',
  'previousLinkDigest',
  'payloadDigest',
  'linkDigest',
]);

/**
 * Sole per-resolved-root write queue (module-private).
 * Shared by initialize (now) and append (Task5) — do not rename to init-only
 * and do not create a second Map for append.
 * key = assertSafeDataRoot(resolvedRoot); value = cleanup Promise (identity pattern).
 * @type {Map<string, Promise<unknown>>}
 */
const auditIntegrityJournalQueues = new Map();

/**
 * Path-free journal error: message === code; name fixed; code from registry only.
 * Never embeds path, underlying errno text, or cause messages.
 */
export class AuditIntegrityJournalError extends Error {
  /**
   * @param {string} code registered ERROR_CODES value
   */
  constructor(code) {
    const registered = assertRegisteredErrorCode(code);
    super(registered);
    this.name = 'AuditIntegrityJournalError';
    this.code = registered;
  }
}

/**
 * @param {string} code
 * @returns {never}
 */
function throwJournalError(code) {
  throw new AuditIntegrityJournalError(code);
}

/**
 * Rejection-safe per-root enqueue (identity cleanup; rejections do not poison next).
 * @param {string} resolvedRoot
 * @param {() => Promise<unknown>} task
 * @returns {Promise<unknown>}
 */
function enqueueAuditIntegrityJournalTask(resolvedRoot, task) {
  const previous = auditIntegrityJournalQueues.get(resolvedRoot) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const cleanup = run.finally(() => {
    if (auditIntegrityJournalQueues.get(resolvedRoot) === cleanup) {
      auditIntegrityJournalQueues.delete(resolvedRoot);
    }
  });
  cleanup.catch(() => {});
  auditIntegrityJournalQueues.set(resolvedRoot, cleanup);
  return run;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @param {string} generationId
 * @returns {string}
 */
function generationOpenLinkDigest(generationId) {
  return sha256Hex(
    DOMAIN_GENERATION_OPEN
      + generationId
      + '\u0000'
      + '0'
      + '\u0000'
      + 'null'
      + '\u0000'
      + 'null',
  );
}

/**
 * @param {{ generationId: string, sequence: number, previousLinkDigest: string, payloadDigest: string }} parts
 * @returns {string}
 */
function eventLinkDigest(parts) {
  return sha256Hex(
    DOMAIN_EVENT_LINK
      + parts.generationId
      + '\u0000'
      + String(parts.sequence)
      + '\u0000'
      + parts.previousLinkDigest
      + '\u0000'
      + parts.payloadDigest,
  );
}

/**
 * Exact 7-key canonical JSON line (no trailing newline).
 * @param {{
 *   schemaVersion: number,
 *   recordKind: string,
 *   generationId: string,
 *   sequence: number,
 *   previousLinkDigest: string | null,
 *   payloadDigest: string | null,
 *   linkDigest: string,
 * }} record
 * @returns {string}
 */
function canonicalRecordLine(record) {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    recordKind: record.recordKind,
    generationId: record.generationId,
    sequence: record.sequence,
    previousLinkDigest: record.previousLinkDigest,
    payloadDigest: record.payloadDigest,
    linkDigest: record.linkDigest,
  });
}

/**
 * @param {unknown} generationId
 * @returns {string}
 */
function assertGenerationId(generationId) {
  if (typeof generationId !== 'string' || !GENERATION_ID_RE.test(generationId)) {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_GENERATION_ID_INVALID);
  }
  return generationId;
}

/**
 * Safely read options.generationId: any property-access throw maps to
 * generation-id-invalid (never io; never copies cause/message).
 * @param {unknown} options
 * @returns {string}
 */
function readGenerationIdOption(options) {
  let generationId;
  try {
    generationId = options == null ? undefined : options.generationId;
  } catch {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_GENERATION_ID_INVALID);
  }
  return assertGenerationId(generationId);
}

/**
 * Map root/safe I/O failures to path-free io-error (includes size maxBytes overlimit).
 * @param {unknown} error
 * @returns {never}
 */
function mapIoError(error) {
  void error;
  throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate one parsed record plain shape + exact key order + types (format only).
 * @param {unknown} record
 * @returns {{
 *   schemaVersion: number,
 *   recordKind: string,
 *   generationId: string,
 *   sequence: number,
 *   previousLinkDigest: string | null,
 *   payloadDigest: string | null,
 *   linkDigest: string,
 * }}
 */
function assertPlainRecordShape(record) {
  if (!isPlainObject(record)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  const keys = Object.keys(record);
  if (keys.length !== RECORD_KEYS.length) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  for (let i = 0; i < RECORD_KEYS.length; i += 1) {
    if (keys[i] !== RECORD_KEYS[i]) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
  }

  const schemaVersion = record.schemaVersion;
  const recordKind = record.recordKind;
  const generationId = record.generationId;
  const sequence = record.sequence;
  const previousLinkDigest = record.previousLinkDigest;
  const payloadDigest = record.payloadDigest;
  const linkDigest = record.linkDigest;

  if (schemaVersion !== SCHEMA_VERSION) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (recordKind !== RECORD_KIND_OPEN && recordKind !== RECORD_KIND_EVENT) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (typeof generationId !== 'string' || !GENERATION_ID_RE.test(generationId)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (!Number.isSafeInteger(sequence)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (typeof linkDigest !== 'string' || !HEX64_RE.test(linkDigest)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }

  if (recordKind === RECORD_KIND_OPEN) {
    if (sequence !== 0) throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    if (previousLinkDigest !== null) throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    if (payloadDigest !== null) throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  } else {
    if (sequence < 1) throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    if (typeof previousLinkDigest !== 'string' || !HEX64_RE.test(previousLinkDigest)) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
    // payloadDigest: format only (64 lowercase hex); not recomputed against events.
    if (typeof payloadDigest !== 'string' || !HEX64_RE.test(payloadDigest)) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
  }

  return {
    schemaVersion,
    recordKind,
    generationId,
    sequence,
    previousLinkDigest,
    payloadDigest,
    linkDigest,
  };
}

/**
 * Full structure verify on already-read UTF-8 raw (design §8).
 * @param {string} raw
 * @returns {{ generationId: string, recordCount: number, headDigest: string }}
 */
function verifyRawJournal(raw) {
  if (raw === '') throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  if (!raw.endsWith('\n')) throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);

  const body = raw.slice(0, -1);
  const lines = body === '' ? [] : body.split('\n');

  for (const line of lines) {
    if (line === '') throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (lines.length === 0) throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);

  // Bounds: line count (API max 4097) — not chain corruption; not size io.
  if (lines.length > AUDIT_INTEGRITY_JOURNAL_MAX_LINES_AFTER_APPEND) {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
  }

  /** @type {ReturnType<typeof assertPlainRecordShape>[]} */
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Per-line UTF-8 bound BEFORE JSON.parse.
    if (Buffer.byteLength(line, 'utf8') > AUDIT_INTEGRITY_JOURNAL_MAX_RECORD_LINE_BYTES) {
      throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }

    const record = assertPlainRecordShape(parsed);
    const reserialized = canonicalRecordLine(record);
    if (reserialized !== line) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
    records.push(record);
  }

  const open = records[0];
  if (open.recordKind !== RECORD_KIND_OPEN) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (open.sequence !== 0 || open.previousLinkDigest !== null || open.payloadDigest !== null) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  const expectedOpen = generationOpenLinkDigest(open.generationId);
  if (open.linkDigest !== expectedOpen) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }

  const generationId = open.generationId;
  for (let i = 1; i < records.length; i += 1) {
    const rec = records[i];
    if (rec.recordKind !== RECORD_KIND_EVENT) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
    if (rec.sequence !== i) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
    if (rec.generationId !== generationId) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
    const prev = records[i - 1];
    if (rec.previousLinkDigest !== prev.linkDigest) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
    // payloadDigest used as link preimage input only (format already checked).
    const expectedLink = eventLinkDigest({
      generationId: rec.generationId,
      sequence: rec.sequence,
      previousLinkDigest: rec.previousLinkDigest,
      payloadDigest: rec.payloadDigest,
    });
    if (rec.linkDigest !== expectedLink) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
  }

  const head = records[records.length - 1];
  return {
    generationId,
    recordCount: records.length,
    headDigest: head.linkDigest,
  };
}

/**
 * Exclusive create of generation-open (O_EXCL concurrent init only; not authenticity).
 * Success receipt allowlist: state, generationId, recordCount:1, headDigest.
 *
 * @param {string} root existing safe data root
 * @param {{ generationId: string }} options
 * @returns {Promise<{ state: 'initialized', generationId: string, recordCount: 1, headDigest: string }>}
 */
export async function initializeAuditIntegrityJournal(root, options = {}) {
  const generationId = readGenerationIdOption(options);

  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(root);
  } catch (error) {
    if (error instanceof AuditIntegrityJournalError) throw error;
    mapIoError(error);
  }

  return enqueueAuditIntegrityJournalTask(resolvedRoot, async () => {
    const linkDigest = generationOpenLinkDigest(generationId);
    const record = {
      schemaVersion: SCHEMA_VERSION,
      recordKind: RECORD_KIND_OPEN,
      generationId,
      sequence: 0,
      previousLinkDigest: null,
      payloadDigest: null,
      linkDigest,
    };
    const line = `${canonicalRecordLine(record)}\n`;

    let result;
    try {
      result = await safeCreateExclusiveText(
        resolvedRoot,
        AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
        line,
        { mode: 0o600 },
      );
    } catch (error) {
      if (error instanceof AuditIntegrityJournalError) throw error;
      // SafeDataFileError / other open failures → io-error (not already-initialized).
      mapIoError(error);
    }

    // created:false: file/dir/symlink/malicious leaf/concurrent loser — unified; NOT io.
    if (!result || result.created !== true) {
      throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_ALREADY_INITIALIZED);
    }

    return {
      state: 'initialized',
      generationId,
      recordCount: 1,
      headDigest: linkDigest,
    };
  });
}

/**
 * Read-only structural verify of the journal file (may run outside the write queue).
 * Success means internal structure self-consistency only — not authenticity.
 *
 * @param {string} root existing safe data root
 * @returns {Promise<{ state: 'verified', generationId: string, recordCount: number, headDigest: string }>}
 */
export async function verifyAuditIntegrityJournalFile(root) {
  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(root);
  } catch (error) {
    if (error instanceof AuditIntegrityJournalError) throw error;
    mapIoError(error);
  }

  let raw;
  try {
    raw = await safeReadText(resolvedRoot, AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH, {
      maxBytes: AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED);
    }
    if (error instanceof AuditIntegrityJournalError) throw error;
    if (error instanceof SafeDataFileError) {
      mapIoError(error);
    }
    mapIoError(error);
  }

  const result = verifyRawJournal(raw);
  return {
    state: 'verified',
    generationId: result.generationId,
    recordCount: result.recordCount,
    headDigest: result.headDigest,
  };
}
