/**
 * Audit integrity journal — unkeyed hash-chain structural consistency foundation.
 * 无密钥哈希链结构一致性基座（V1.35 partial foundation / T6d.3 partial only）.
 *
 * Verifies ONLY journal-internal structure self-consistency.
 * Does NOT provide authenticity or cryptographic anti-tamper resistance.
 * No external trusted anchor / HMAC / signature.
 * Cannot detect: self-consistent suffix rewrite; legal tail truncation;
 * external-event-store-only mutation; full-file / new-generation replacement.
 * payloadDigest at verify: format check + link preimage input only;
 * does NOT recompute event payload preimage and does NOT look up events.
 *
 * BLOCKED (V1.35 — do not claim complete):
 * - BLOCKED / not delivered: T6d.3 complete / M6d Exit / production-hardening ready / production integration
 * - BLOCKED: production dual-write (external audit event store ↔ integrity journal)
 * - public surface (server/agent/Web/HTTP/CLI)
 * - external trusted anchor / HMAC / signature / head file / priorChainHeadDigest
 * - BLOCKED / not delivered: new generation after chain-break / automatic next generation / recovery / auto-repair / truncate
 * - retention / rotation / monitor / alert
 * - capability / approval binding
 * - multi-process exclusive writer lock
 * - missing trusted-recovery authorization model
 * - authenticity / tamper-resistance / cryptographic anti-tamper / compliance audit-chain complete
 * - detection of: suffix rewrite | tail truncation | external-event-store-only mutation | full-file replacement
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
  safeAtomicWriteText,
  safeCreateExclusiveText,
  safeReadText,
} from './safe-data-files.js';
import { ERROR_CODES, assertRegisteredErrorCode } from './error-codes.js';
import {
  computeAuditIntegrityEventPayloadDigest as computeEventPayloadDigestSoT,
  projectStrictCanonicalSanitizedEvent,
  stringifyStrictCanonicalSanitizedEvent,
} from './audit-event-schema.js';
import {
  assertAuditIntegrityWriteLease,
  enqueueAuditIntegrityWriteTask,
} from './audit-integrity-write-queue.js';
import { assertDualWriteStateAbsentUnlocked } from './audit-integrity-dual-write-state.js';

/** Relative path under data root for the integrity journal; independent from legacy audit event storage. */
export const AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH = 'audit/integrity-journal.jsonl';

/** safeReadText maxBytes; size overlimit → io-error (never bounds-exceeded). */
export const AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES = 1_572_864;

/** Append preflight allows existing lines ≤ this value (open counts as record #1). */
export const AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES = 4096;

/** API-reachable max lines after a legal append (= existing 4096 + 1). */
export const AUDIT_INTEGRITY_JOURNAL_MAX_LINES_AFTER_APPEND = 4097;

/** Per-line UTF-8 max (checked before JSON.parse); over → bounds-exceeded. */
export const AUDIT_INTEGRITY_JOURNAL_MAX_RECORD_LINE_BYTES = 374;

/**
 * Per-line UTF-8 max for a v2 generation-open line (exact 10-key canonical record).
 * v1 lines and all event-link lines stay bounded by
 * AUDIT_INTEGRITY_JOURNAL_MAX_RECORD_LINE_BYTES.
 */
export const AUDIT_INTEGRITY_JOURNAL_V2_OPEN_MAX_LINE_BYTES = 477;

const SCHEMA_VERSION = 1;
const SCHEMA_VERSION_V2 = 2;
const RECORD_KIND_OPEN = 'generation-open';
const RECORD_KIND_EVENT = 'event-link';

const DOMAIN_GENERATION_OPEN = 'linke.audit-integrity-journal.v1.generation-open\u0000';
const DOMAIN_EVENT_LINK = 'linke.audit-integrity-journal.v1.event-link\u0000';
const DOMAIN_V2_GENERATION_OPEN = 'linke.audit-integrity-journal.v2.generation-open\u0000';
const DOMAIN_V2_EVENT_LINK = 'linke.audit-integrity-journal.v2.event-link\u0000';

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

/** Exact 10-key canonical order for a v2 generation-open record. */
const V2_OPEN_RECORD_KEYS = Object.freeze([
  'schemaVersion',
  'recordKind',
  'generationId',
  'previousGenerationId',
  'previousHeadDigest',
  'archiveManifestDigest',
  'sequence',
  'previousLinkDigest',
  'payloadDigest',
  'linkDigest',
]);

/**
 * Byte prefix of every canonical v2 generation-open line. Gates the pre-parse
 * 477-byte allowance so other 375..477-byte lines still fail bounds before parse.
 */
const V2_OPEN_LINE_PREFIX = '{"schemaVersion":2,"recordKind":"generation-open",';

/**
 * Module-private plan brand store (plan object identity → private raw payload).
 * Caller must not read/write raw; only plan serializable metadata is returned.
 * @type {WeakMap<object, {
 *   resolvedRoot: string,
 *   leaseIdentity: object,
 *   rawPreText: string,
 *   rawPostText: string,
 * }>}
 */
const auditIntegrityJournalPlanPayloads = new WeakMap();

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
 * v2 generation-open link digest: v2 open domain over the ten-key preimage
 * (generationId / previousGenerationId / previousHeadDigest / archiveManifestDigest,
 * then fixed sequence 0, null previousLinkDigest, null payloadDigest).
 * @param {{
 *   generationId: string,
 *   previousGenerationId: string,
 *   previousHeadDigest: string,
 *   archiveManifestDigest: string,
 * }} parts
 * @returns {string}
 */
function v2GenerationOpenLinkDigest(parts) {
  // Build the NUL field separator without placing a raw zero byte in source text.
  const nul = String.fromCharCode(0);
  return sha256Hex(
    DOMAIN_V2_GENERATION_OPEN
      + parts.generationId
      + nul
      + parts.previousGenerationId
      + nul
      + parts.previousHeadDigest
      + nul
      + parts.archiveManifestDigest
      + nul
      + '0'
      + nul
      + 'null'
      + nul
      + 'null',
  );
}

/**
 * Event-link digest under the homogeneous generation domain.
 * @param {number} schemaVersion 1 → v1 event-link domain; 2 → v2 event-link domain
 * @param {{ generationId: string, sequence: number, previousLinkDigest: string, payloadDigest: string }} parts
 * @returns {string}
 */
function eventLinkDigest(schemaVersion, parts) {
  const domain = schemaVersion === SCHEMA_VERSION
    ? DOMAIN_EVENT_LINK
    : DOMAIN_V2_EVENT_LINK;
  return sha256Hex(
    domain
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
 * Exact 10-key canonical v2 open JSON line (no trailing newline).
 * @param {{
 *   schemaVersion: number,
 *   recordKind: string,
 *   generationId: string,
 *   previousGenerationId: string,
 *   previousHeadDigest: string,
 *   archiveManifestDigest: string,
 *   sequence: number,
 *   previousLinkDigest: string | null,
 *   payloadDigest: string | null,
 *   linkDigest: string,
 * }} record
 * @returns {string}
 */
function canonicalV2OpenLine(record) {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    recordKind: record.recordKind,
    generationId: record.generationId,
    previousGenerationId: record.previousGenerationId,
    previousHeadDigest: record.previousHeadDigest,
    archiveManifestDigest: record.archiveManifestDigest,
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
 * Expected schema version defaults to v1 so all v1 validation stays unchanged.
 * @param {unknown} record
 * @param {number} [expectedSchemaVersion]
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
function assertPlainRecordShape(record, expectedSchemaVersion = SCHEMA_VERSION) {
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

  if (schemaVersion !== expectedSchemaVersion) {
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
 * v2 generation-open detection: exact byte prefix gates the 477-byte allowance.
 * @param {string} line
 * @returns {boolean}
 */
function isV2OpenLine(line) {
  return line.startsWith(V2_OPEN_LINE_PREFIX);
}

/**
 * Validate a parsed v2 generation-open record: exact ten-key order + types (format only).
 * @param {unknown} record
 * @returns {{
 *   schemaVersion: number,
 *   recordKind: string,
 *   generationId: string,
 *   previousGenerationId: string,
 *   previousHeadDigest: string,
 *   archiveManifestDigest: string,
 *   sequence: number,
 *   previousLinkDigest: string | null,
 *   payloadDigest: string | null,
 *   linkDigest: string,
 * }}
 */
function assertV2PlainOpenShape(record) {
  if (!isPlainObject(record)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  const keys = Object.keys(record);
  if (keys.length !== V2_OPEN_RECORD_KEYS.length) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  for (let i = 0; i < V2_OPEN_RECORD_KEYS.length; i += 1) {
    if (keys[i] !== V2_OPEN_RECORD_KEYS[i]) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
  }

  const schemaVersion = record.schemaVersion;
  const recordKind = record.recordKind;
  const generationId = record.generationId;
  const previousGenerationId = record.previousGenerationId;
  const previousHeadDigest = record.previousHeadDigest;
  const archiveManifestDigest = record.archiveManifestDigest;
  const sequence = record.sequence;
  const previousLinkDigest = record.previousLinkDigest;
  const payloadDigest = record.payloadDigest;
  const linkDigest = record.linkDigest;

  if (schemaVersion !== SCHEMA_VERSION_V2) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (recordKind !== RECORD_KIND_OPEN) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (typeof generationId !== 'string' || !GENERATION_ID_RE.test(generationId)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (typeof previousGenerationId !== 'string' || !GENERATION_ID_RE.test(previousGenerationId)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (typeof previousHeadDigest !== 'string' || !HEX64_RE.test(previousHeadDigest)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (typeof archiveManifestDigest !== 'string' || !HEX64_RE.test(archiveManifestDigest)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  if (sequence !== 0) throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  if (previousLinkDigest !== null) throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  if (payloadDigest !== null) throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  if (typeof linkDigest !== 'string' || !HEX64_RE.test(linkDigest)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }

  return {
    schemaVersion,
    recordKind,
    generationId,
    previousGenerationId,
    previousHeadDigest,
    archiveManifestDigest,
    sequence,
    previousLinkDigest,
    payloadDigest,
    linkDigest,
  };
}

/**
 * Count existing journal lines for append preflight when raw has a trailing newline.
 * Returns null when tail is malformed — full structure verify owns chain-broken.
 * @param {string} raw
 * @returns {number | null}
 */
function countExistingLinesForAppendPreflight(raw) {
  if (raw === '' || !raw.endsWith('\n')) return null;
  const body = raw.slice(0, -1);
  if (body === '') return 0;
  return body.split('\n').length;
}

/**
 * Full structure verify on already-read UTF-8 raw (design §8).
 * Private fields headSequence / eventCount / payloadDigests support append + inspect;
 * public verify receipt must omit private digests array (never leak into old receipt).
 * @param {string} raw
 * @returns {{
 *   generationId: string,
 *   recordCount: number,
 *   headDigest: string,
 *   headSequence: number,
 *   eventCount: number,
 *   payloadDigests: string[],
 * }}
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
  /** @type {string[]} event-link payloadDigest only (never open null) */
  const payloadDigests = [];
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
    const expectedLink = eventLinkDigest(SCHEMA_VERSION, {
      generationId: rec.generationId,
      sequence: rec.sequence,
      previousLinkDigest: rec.previousLinkDigest,
      payloadDigest: rec.payloadDigest,
    });
    if (rec.linkDigest !== expectedLink) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
    // event-link only; open payloadDigest is null and excluded.
    payloadDigests.push(/** @type {string} */ (rec.payloadDigest));
  }

  const head = records[records.length - 1];
  return {
    generationId,
    recordCount: records.length,
    headDigest: head.linkDigest,
    headSequence: head.sequence,
    eventCount: payloadDigests.length,
    payloadDigests,
  };
}

/**
 * v2 binding digest input guard: 64 lowercase hex, registered codes only.
 * @param {unknown} value
 * @returns {string}
 */
function assertV2BindingDigest(value) {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  return value;
}

/**
 * Safely read one v2 binding digest option: any property-access throw maps to
 * chain-broken (never io; never copies cause/message).
 * @param {unknown} options
 * @param {string} key
 * @returns {string}
 */
function readV2BindingDigestOption(options, key) {
  let value;
  try {
    value = options == null ? undefined : options[key];
  } catch {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  return assertV2BindingDigest(value);
}

/**
 * Full structure verify of a homogeneous v2 generation on already-read UTF-8 raw.
 * Ten-key v2 open under the v2 open domain; shared 7-key event records under the
 * v2 event-link domain. Per-line bound: 477 only for v2-open-prefixed lines, 374 else.
 * Private headSequence / eventCount / payloadDigests mirror verifyRawJournal so
 * inspect/file consumers can share one generation-aware path; public text verify
 * receipts continue to omit those private fields.
 * @param {string} raw
 * @returns {{
 *   generationId: string,
 *   recordCount: number,
 *   headDigest: string,
 *   binding: {
 *     previousGenerationId: string,
 *     previousHeadDigest: string,
 *     archiveManifestDigest: string,
 *   },
 *   headSequence: number,
 *   eventCount: number,
 *   payloadDigests: string[],
 * }}
 */
function verifyRawV2Journal(raw) {
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

  /** @type {Array<ReturnType<typeof assertV2PlainOpenShape> | ReturnType<typeof assertPlainRecordShape>>} */
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Per-line UTF-8 bound BEFORE JSON.parse; 477 gated on the v2 open prefix.
    const v2Open = isV2OpenLine(line);
    const maxLineBytes = v2Open
      ? AUDIT_INTEGRITY_JOURNAL_V2_OPEN_MAX_LINE_BYTES
      : AUDIT_INTEGRITY_JOURNAL_MAX_RECORD_LINE_BYTES;
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
      throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }

    if (v2Open) {
      const record = assertV2PlainOpenShape(parsed);
      if (canonicalV2OpenLine(record) !== line) {
        throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
      }
      records.push(record);
    } else {
      const record = assertPlainRecordShape(parsed, SCHEMA_VERSION_V2);
      if (canonicalRecordLine(record) !== line) {
        throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
      }
      records.push(record);
    }
  }

  const open = records[0];
  if (open.recordKind !== RECORD_KIND_OPEN) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }
  const binding = {
    previousGenerationId: open.previousGenerationId,
    previousHeadDigest: open.previousHeadDigest,
    archiveManifestDigest: open.archiveManifestDigest,
  };
  const expectedOpen = v2GenerationOpenLinkDigest({
    generationId: open.generationId,
    previousGenerationId: open.previousGenerationId,
    previousHeadDigest: open.previousHeadDigest,
    archiveManifestDigest: open.archiveManifestDigest,
  });
  if (open.linkDigest !== expectedOpen) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }

  const generationId = open.generationId;
  /** @type {string[]} event-link payloadDigest only (never open null) */
  const payloadDigests = [];
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
    const expectedLink = eventLinkDigest(SCHEMA_VERSION_V2, {
      generationId: rec.generationId,
      sequence: rec.sequence,
      previousLinkDigest: rec.previousLinkDigest,
      payloadDigest: rec.payloadDigest,
    });
    if (rec.linkDigest !== expectedLink) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
    payloadDigests.push(/** @type {string} */ (rec.payloadDigest));
  }

  const head = records[records.length - 1];
  return {
    generationId,
    recordCount: records.length,
    headDigest: head.linkDigest,
    binding,
    headSequence: head.sequence,
    eventCount: payloadDigests.length,
    payloadDigests,
  };
}

/**
 * Generation-aware full-structure verify of already-read UTF-8 raw.
 * Homogeneous v2-open raw -> verifyRawV2Journal (477-byte open bound);
 * otherwise legacy verifyRawJournal (v1 374-byte bound, mixed v1/v2 rejected).
 * Shared by file verify/inspect, append plan, and append post-write reopen verify.
 * Schema/domain choice for append is derived only from this result (never caller options).
 *
 * @param {string} raw
 * @returns {{
 *   generationId: string,
 *   recordCount: number,
 *   headDigest: string,
 *   headSequence: number,
 *   eventCount: number,
 *   payloadDigests: string[],
 *   binding?: {
 *     previousGenerationId: string,
 *     previousHeadDigest: string,
 *     archiveManifestDigest: string,
 *   },
 * }}
 */
function verifyRawJournalGenerationAware(raw) {
  if (isV2OpenLine(raw)) {
    return verifyRawV2Journal(raw);
  }
  return verifyRawJournal(raw);
}

/**
 * Append event-link schema/domain for a generation-aware verify receipt.
 * v2 generations carry binding; v1 receipts never do. Caller input must not decide this.
 *
 * @param {{ binding?: unknown }} verified
 * @returns {1|2}
 */
function appendSchemaVersionFromVerified(verified) {
  return Object.prototype.hasOwnProperty.call(verified, 'binding')
    ? SCHEMA_VERSION_V2
    : SCHEMA_VERSION;
}

/**
 * @internal Exclusive create under active write lease (no enqueue).
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {{ generationId: string }} options
 * @returns {Promise<{ state: 'initialized', generationId: string, recordCount: 1, headDigest: string }>}
 */
export async function initializeAuditIntegrityJournalUnlocked(resolvedRoot, lease, options = {}) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  // generationId already validated by public wrapper; re-validate for direct unlocked callers.
  const generationId = readGenerationIdOption(options);

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
}

/**
 * Exclusive create of generation-open (O_EXCL concurrent init only; not authenticity).
 * C2+: resolve root → shared queue once → active lease → real state-absent gate → unlocked init.
 * Success receipt allowlist: state, generationId, recordCount:1, headDigest.
 * Does not create dual-write state (bootstrap is C3).
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

  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    await assertDualWriteStateAbsentUnlocked(resolvedRoot, lease);
    return initializeAuditIntegrityJournalUnlocked(resolvedRoot, lease, { generationId });
  });
}

/**
 * Compatibility export: thin wrapper over shared audit-event-schema SoT.
 * Maps strict projection failures to AUDIT_INTEGRITY_EVENT_INVALID.
 * Does not call sanitize; does not invent id/time; no formula fork.
 *
 * @param {unknown} strictEvent already strict-acceptable event (no sanitize defaults)
 * @returns {string} 64 lowercase hex
 * @throws {AuditIntegrityJournalError} AUDIT_INTEGRITY_EVENT_INVALID on strict failure
 */
export function computeAuditIntegrityEventPayloadDigest(strictEvent) {
  try {
    return computeEventPayloadDigestSoT(strictEvent);
  } catch {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
  }
}

/**
 * @internal Read-only event-link planning (unique SoT). NO filesystem mutation / NO enqueue.
 * Returns module-issued frozen plan with only serializable pre/post metadata.
 * rawPreText/rawPostText stored in module-private WeakMap by plan identity.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {{ generationId: string, event: unknown }} options
 * @returns {Promise<object>}
 */
export async function planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, options = {}) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  const generationId = readGenerationIdOption(options);

  let event;
  try {
    event = options == null ? undefined : options.event;
  } catch {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
  }

  // Shared payloadDigest SoT (audit-event-schema); validates strict projection too.
  // Journal remains unique SoT for sequence / previous / link / raw post.
  let payloadDigest;
  try {
    payloadDigest = computeEventPayloadDigestSoT(event);
  } catch {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
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

  // Append line-count preflight (existing > 4096 → bounds) BEFORE full verify so that
  // verify's legal max of 4097 does not mask the append preflight at 4096.
  const existingLines = countExistingLinesForAppendPreflight(raw);
  if (existingLines !== null && existingLines > AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES) {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
  }

  // Generation-aware full verify: homogeneous v1 or v2 only (mixed stays chain-broken).
  const verified = verifyRawJournalGenerationAware(raw);

  if (verified.generationId !== generationId) {
    throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  }

  // Schema/domain from verified generation only — never from caller options.
  const schemaVersion = appendSchemaVersionFromVerified(verified);

  // Reachable upper bound for sequence is 4096: append preflight allows existing ≤4096
  // and verify forces sequence===line index; existing 4097 is already bounds-rejected.
  const sequence = verified.headSequence + 1;
  const previousLinkDigest = verified.headDigest;
  const linkDigest = eventLinkDigest(schemaVersion, {
    generationId,
    sequence,
    previousLinkDigest,
    payloadDigest,
  });

  // Append only a 7-key event-link; v2 open generationBinding bytes stay untouched.
  const record = {
    schemaVersion,
    recordKind: RECORD_KIND_EVENT,
    generationId,
    sequence,
    previousLinkDigest,
    payloadDigest,
    linkDigest,
  };
  const recordLine = canonicalRecordLine(record);
  const recordLineBytes = Buffer.byteLength(recordLine, 'utf8');
  // size → IO, line/count → BOUNDS priority (design §7.2).
  if (recordLineBytes > AUDIT_INTEGRITY_JOURNAL_MAX_RECORD_LINE_BYTES) {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
  }

  const postRecordCount = verified.recordCount + 1;
  if (postRecordCount > AUDIT_INTEGRITY_JOURNAL_MAX_LINES_AFTER_APPEND) {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
  }

  const rawPostText = `${raw}${recordLine}\n`;
  const rawPostBytes = Buffer.byteLength(rawPostText, 'utf8');
  if (rawPostBytes > AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES) {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
  }

  const preMeta = Object.freeze({
    recordCount: verified.recordCount,
    headDigest: verified.headDigest,
    rawByteLength: Buffer.byteLength(raw, 'utf8'),
    rawSha256: sha256Hex(raw),
  });
  const postMeta = Object.freeze({
    recordCount: postRecordCount,
    headDigest: linkDigest,
    rawByteLength: rawPostBytes,
    rawSha256: sha256Hex(rawPostText),
    sequence,
    linkDigest,
    previousLinkDigest,
  });
  const plan = Object.freeze({
    generationId,
    payloadDigest,
    pre: preMeta,
    post: postMeta,
  });

  auditIntegrityJournalPlanPayloads.set(plan, {
    resolvedRoot,
    leaseIdentity: lease,
    rawPreText: raw,
    rawPostText,
  });

  return plan;
}

/**
 * @internal Publish WeakMap rawPost after re-read current === exact rawPre;
 * after atomic write MUST reopen+full verify exact plan.post.
 *
 * One-shot consumption boundary (C1):
 * - Private payload is deleted in `finally` only after a publish attempt that has
 *   already passed the current root + active lease assertion.
 * - Pre-check failures (wrong-root / expired lease / outside ALS context /
 *   missing or forged lease) throw from `assertAuditIntegrityWriteLease` before
 *   the try body and do **not** consume the plan.
 * - Once that assertion passes, the plan is always consumed — whether the body
 *   succeeds, hits chain-broken / I/O, or rejects forged/mismatched private payload.
 *   (Not a vague “success-or-fail always consumes” claim for lease pre-checks.)
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} plan
 * @returns {Promise<{
 *   state: 'appended',
 *   generationId: string,
 *   sequence: number,
 *   recordCount: number,
 *   headDigest: string,
 *   payloadDigest: string,
 * }>}
 */
export async function publishPlannedAuditIntegrityEventLinkAtomicUnlocked(
  resolvedRoot,
  lease,
  plan,
) {
  // Lease/root/ALS pre-check is intentionally outside try/finally so failures here
  // do not consume the plan (see one-shot boundary above).
  assertAuditIntegrityWriteLease(resolvedRoot, lease);

  const privatePayload = auditIntegrityJournalPlanPayloads.get(plan);
  try {
    if (privatePayload === undefined) {
      // Forged / non-module-issued / already consumed plan (lease assertion already passed).
      throw new SafeDataFileError();
    }
    if (privatePayload.resolvedRoot !== resolvedRoot) {
      throw new SafeDataFileError();
    }
    if (privatePayload.leaseIdentity !== lease) {
      throw new SafeDataFileError();
    }

    // Re-read current journal: must exact rawPre (not hash alone).
    let currentRaw;
    try {
      currentRaw = await safeReadText(resolvedRoot, AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH, {
        maxBytes: AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES,
      });
    } catch (error) {
      if (error instanceof AuditIntegrityJournalError) throw error;
      if (error instanceof SafeDataFileError) {
        mapIoError(error);
      }
      mapIoError(error);
    }
    if (currentRaw !== privatePayload.rawPreText) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }

    try {
      await safeAtomicWriteText(
        resolvedRoot,
        AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
        privatePayload.rawPostText,
        { mode: 0o600 },
      );
    } catch (error) {
      if (error instanceof AuditIntegrityJournalError) throw error;
      mapIoError(error);
    }

    // MUST reopen + full verify exact plan.post after atomic write returns.
    let postRaw;
    try {
      postRaw = await safeReadText(resolvedRoot, AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH, {
        maxBytes: AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES,
      });
    } catch (error) {
      if (error instanceof AuditIntegrityJournalError) throw error;
      if (error instanceof SafeDataFileError) {
        mapIoError(error);
      }
      mapIoError(error);
    }
    if (postRaw !== privatePayload.rawPostText) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }
    // Generation-aware reopen verify of exact rawPost (not plan hash alone; not v1-only).
    const postVerified = verifyRawJournalGenerationAware(postRaw);
    if (
      postVerified.recordCount !== plan.post.recordCount
      || postVerified.headDigest !== plan.post.headDigest
      || postVerified.generationId !== plan.generationId
      || sha256Hex(postRaw) !== plan.post.rawSha256
      || Buffer.byteLength(postRaw, 'utf8') !== plan.post.rawByteLength
    ) {
      throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
    }

    return {
      state: 'appended',
      generationId: plan.generationId,
      sequence: plan.post.sequence,
      recordCount: plan.post.recordCount,
      headDigest: plan.post.headDigest,
      payloadDigest: plan.payloadDigest,
    };
  } finally {
    // One-shot: drop private payload after a lease-asserted publish attempt only
    // (assert above is outside this try/finally — pre-check failures do not reach here).
    auditIntegrityJournalPlanPayloads.delete(plan);
  }
}

/**
 * @internal MUST reuse plan… + publishPlanned… (unique SoT; not V1.35 safeAppend).
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {{ generationId: string, event: unknown }} options
 * @returns {Promise<{
 *   state: 'appended',
 *   generationId: string,
 *   sequence: number,
 *   recordCount: number,
 *   headDigest: string,
 *   payloadDigest: string,
 * }>}
 */
export async function appendAuditIntegrityEventUnlocked(resolvedRoot, lease, options = {}) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);
  const plan = await planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, options);
  return publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedRoot, lease, plan);
}

/**
 * Append one event-link after full structure verify (shared write queue as initialize).
 * C2+: resolve root → shared queue once → active lease → real state-absent gate → unlocked plan+publish.
 * Success receipt proves write-time post-sanitize projection digest + structural chain only —
 * not authenticity, not external audit event provenance.
 * Does not create dual-write state (bootstrap is C3).
 *
 * Function signature semantics use only `{ generationId, event }`.
 * Plain options keys such as `sequence` / `previousLinkDigest` are ignored and must not be read.
 *
 * @param {string} root existing safe data root
 * @param {{ generationId: string, event: object }} [options]
 * @returns {Promise<{
 *   state: 'appended',
 *   generationId: string,
 *   sequence: number,
 *   recordCount: number,
 *   headDigest: string,
 *   payloadDigest: string,
 * }>}
 */
export async function appendAuditIntegrityEvent(root, options = {}) {
  // Only read generationId + event. Never touch sequence / previousLinkDigest / other extras
  // (even if those getters throw — must not affect a legal append).
  // Hostile getter / validation runs before enqueue (error priority preserved).
  const generationId = readGenerationIdOption(options);

  let event;
  try {
    event = options == null ? undefined : options.event;
  } catch {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
  }

  // Call-time strict projection snapshot BEFORE any root / I/O / await / enqueue.
  // Freezes a plain scalar snapshot so callers cannot TOCTOU-mutate the queued payload.
  // Journal plan remains the unique SoT for canonical string / payloadDigest / linkDigest:
  // unlocked plan still calls stringifyStrictCanonicalSanitizedEvent(snapshot) once.
  // Do not invent a second canonical/digest formula here.
  let eventSnapshot;
  try {
    eventSnapshot = Object.freeze(projectStrictCanonicalSanitizedEvent(event));
  } catch {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
  }

  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(root);
  } catch (error) {
    if (error instanceof AuditIntegrityJournalError) throw error;
    mapIoError(error);
  }

  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    await assertDualWriteStateAbsentUnlocked(resolvedRoot, lease);
    return appendAuditIntegrityEventUnlocked(resolvedRoot, lease, {
      generationId,
      event: eventSnapshot,
    });
  });
}

/**
 * Read-only structural verify of the journal file (may run outside the write queue).
 * Success means internal structure self-consistency only — not authenticity.
 * Generation-aware: v2 open uses verifyRawV2Journal (477-byte open bound);
 * v1 remains verifyRawJournal. Receipt allowlist unchanged:
 * state/generationId/recordCount/headDigest only (private payloadDigests never enter).
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

  const result = verifyRawJournalGenerationAware(raw);
  return {
    state: 'verified',
    generationId: result.generationId,
    recordCount: result.recordCount,
    headDigest: result.headDigest,
  };
}

/**
 * @internal read-only snapshot after full structure verify (same parser strength as verify).
 * No write queue; no raw records/path/event body/linkDigest list.
 * Generation-aware: v2 open uses verifyRawV2Journal so post-rotation v2 journals
 * inspect cleanly for dual/cross-store cursors. Snapshot fixed keys/order;
 * payloadDigests deep-copied + frozen (event-link only).
 *
 * @param {string} root existing safe data root
 * @param {object} [options] reserved; current contract does not read option keys
 * @returns {Promise<{
 *   generationId: string,
 *   headDigest: string,
 *   recordCount: number,
 *   eventCount: number,
 *   payloadDigests: readonly string[],
 * }>}
 */
export async function inspectAuditIntegrityJournalFile(root, options = {}) {
  // Reserved options slot; do not touch properties (hostile getter/Proxy must not run).
  void options;

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

  const result = verifyRawJournalGenerationAware(raw);
  return Object.freeze({
    generationId: result.generationId,
    headDigest: result.headDigest,
    recordCount: result.recordCount,
    eventCount: result.eventCount,
    payloadDigests: Object.freeze(result.payloadDigests.slice()),
  });
}

/**
 * Generation-aware read-only structural verify of raw journal text (sync; no I/O).
 * Homogeneous v1 raw delegates to verifyRawJournal unchanged; homogeneous v2 raw
 * verifies the ten-key v2 open under the v2 open domain and shared 7-key event
 * records under the v2 event-link domain. Mixed v1/v2 raw is audit-chain-broken.
 * v1 receipt has exactly schemaVersion/generationId/recordCount/headDigest and no
 * generationBinding property; v2 receipt adds a frozen three-key generationBinding.
 * Success means internal structure self-consistency only — not authenticity.
 *
 * @param {string} raw
 * @returns {{
 *   schemaVersion: number,
 *   generationId: string,
 *   recordCount: number,
 *   headDigest: string,
 *   generationBinding?: {
 *     previousGenerationId: string,
 *     previousHeadDigest: string,
 *     archiveManifestDigest: string,
 *   },
 * }}
 */
export function verifyAuditIntegrityJournalText(raw) {
  if (typeof raw !== 'string') throwJournalError(ERROR_CODES.AUDIT_CHAIN_BROKEN);
  // Full-file envelope first: size overlimit is io-error (never bounds-exceeded)
  // and must gate before v2-open detection, splitting, parsing, or per-line bounds.
  if (Buffer.byteLength(raw, 'utf8') > AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES) {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
  }
  if (isV2OpenLine(raw)) {
    const result = verifyRawV2Journal(raw);
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION_V2,
      generationId: result.generationId,
      recordCount: result.recordCount,
      headDigest: result.headDigest,
      generationBinding: Object.freeze({
        previousGenerationId: result.binding.previousGenerationId,
        previousHeadDigest: result.binding.previousHeadDigest,
        archiveManifestDigest: result.binding.archiveManifestDigest,
      }),
    });
  }
  const result = verifyRawJournal(raw);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    generationId: result.generationId,
    recordCount: result.recordCount,
    headDigest: result.headDigest,
  });
}

/**
 * Pure/synchronous v2 generation image builder: no filesystem, no queue, no lease.
 * Emits one v2 open line and one v2 event line (each with trailing newline).
 * Event payloadDigest uses the shared strict event payload digest SoT.
 * Returns a frozen exact nine-key receipt with a frozen three-key generationBinding.
 *
 * @param {{
 *   generationId: string,
 *   previousGenerationId: string,
 *   previousHeadDigest: string,
 *   archiveManifestDigest: string,
 *   rotationEvent: unknown,
 * }} options
 * @returns {{
 *   rawText: string,
 *   schemaVersion: number,
 *   generationId: string,
 *   recordCount: number,
 *   headDigest: string,
 *   eventPayloadDigest: string,
 *   rawByteLength: number,
 *   rawSha256: string,
 *   generationBinding: {
 *     previousGenerationId: string,
 *     previousHeadDigest: string,
 *     archiveManifestDigest: string,
 *   },
 * }}
 */
export function buildAuditIntegrityV2GenerationImage(options = {}) {
  const generationId = readGenerationIdOption(options);
  let previousGenerationId;
  try {
    previousGenerationId = options == null ? undefined : options.previousGenerationId;
  } catch {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_GENERATION_ID_INVALID);
  }
  previousGenerationId = assertGenerationId(previousGenerationId);
  const previousHeadDigest = readV2BindingDigestOption(options, 'previousHeadDigest');
  const archiveManifestDigest = readV2BindingDigestOption(options, 'archiveManifestDigest');

  let rotationEvent;
  try {
    rotationEvent = options == null ? undefined : options.rotationEvent;
  } catch {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
  }
  let payloadDigest;
  try {
    payloadDigest = computeEventPayloadDigestSoT(rotationEvent);
  } catch {
    throwJournalError(ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID);
  }

  const openLinkDigest = v2GenerationOpenLinkDigest({
    generationId,
    previousGenerationId,
    previousHeadDigest,
    archiveManifestDigest,
  });
  const openLine = canonicalV2OpenLine({
    schemaVersion: SCHEMA_VERSION_V2,
    recordKind: RECORD_KIND_OPEN,
    generationId,
    previousGenerationId,
    previousHeadDigest,
    archiveManifestDigest,
    sequence: 0,
    previousLinkDigest: null,
    payloadDigest: null,
    linkDigest: openLinkDigest,
  });

  const eventLink = eventLinkDigest(SCHEMA_VERSION_V2, {
    generationId,
    sequence: 1,
    previousLinkDigest: openLinkDigest,
    payloadDigest,
  });
  const eventLine = canonicalRecordLine({
    schemaVersion: SCHEMA_VERSION_V2,
    recordKind: RECORD_KIND_EVENT,
    generationId,
    sequence: 1,
    previousLinkDigest: openLinkDigest,
    payloadDigest,
    linkDigest: eventLink,
  });

  const rawText = `${openLine}\n${eventLine}\n`;
  return Object.freeze({
    rawText,
    schemaVersion: SCHEMA_VERSION_V2,
    generationId,
    recordCount: 2,
    headDigest: eventLink,
    eventPayloadDigest: payloadDigest,
    rawByteLength: Buffer.byteLength(rawText, 'utf8'),
    rawSha256: sha256Hex(rawText),
    generationBinding: Object.freeze({
      previousGenerationId,
      previousHeadDigest,
      archiveManifestDigest,
    }),
  });
}
