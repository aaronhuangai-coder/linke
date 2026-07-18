/**
 * V1.36 audit event/journal cross-store structural consistency verifier.
 *
 * Signature ceiling (only allowed completion claim):
 *   V1.36 audit event/journal cross-store structural consistency verifier implementation
 *
 * BLOCKED / not delivered (do not claim):
 * - T6d.3 complete / M6d Exit / production-hardening ready
 * - production dual-write / production integration / production detects
 * - authenticity / external trusted anchor / HMAC / signature
 * - automatic next generation / repair / recovery / rotation
 * - public HTTP/CLI/Web/Agent surface / Gold / GA / V2 / cross-LAN
 * - writer cursor / occurrence binding / full unjournaled-tail detection
 *
 * Honest limitations:
 * - only structural J↔E payloadDigest relationship on explicit call
 * - retention suffix is structure-only (not deletion authorization)
 * - paired rewrite / consistent dual-suffix may still verify
 * - replay-shaped E=…+J+J may be partial journal-suffix (not broken)
 * - concurrent writer intermediate states may fail-closed; never partial-mask misalign
 * - SHA-256 digests are comparison inputs only (not authenticity)
 *
 * Forbidden capability compound (prefix + suffix joined) is never written as a
 * contiguous English literal in this file; tests scan via runtime concat.
 */

import {
  SafeDataFileError,
  assertSafeDataRoot,
  safeReadText,
} from './safe-data-files.js';
import { stringifyStrictCanonicalSanitizedEvent } from './audit-event-schema.js';
import {
  AuditIntegrityJournalError,
  computeAuditIntegrityEventPayloadDigest,
  inspectAuditIntegrityJournalFile,
} from './audit-integrity-journal.js';
import { ERROR_CODES, assertRegisteredErrorCode } from './error-codes.js';

/** Relative path under data root for the HTTP audit event store (literal; not imported). */
export const AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH = 'audit/events.jsonl';

/** safeReadText maxBytes for events; size overlimit → cross-store-io-error (never bounds). */
export const AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES = 16_777_216;

/** CPU / sequence comparison line-count cap (independent constant; not floor-derived). */
export const AUDIT_CROSS_STORE_MAX_EVENT_LINES = 8192;

/**
 * Per-line UTF-8 max before JSON.parse (excludes newline).
 * Proven by independent NUL and lone-surrogate canaries at 16050.
 */
export const AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES = 16050;

/**
 * Path-free cross-store error: message === code; name fixed; code from registry only.
 * Never embeds path, underlying errno text, raw cause, or body.
 */
export class AuditIntegrityCrossStoreError extends Error {
  /**
   * @param {string} code registered ERROR_CODES value
   */
  constructor(code) {
    const registered = assertRegisteredErrorCode(code);
    super(registered);
    this.name = 'AuditIntegrityCrossStoreError';
    this.code = registered;
  }
}

/**
 * @param {string} code
 * @returns {never}
 */
function throwCrossStoreError(code) {
  throw new AuditIntegrityCrossStoreError(code);
}

/**
 * Index-by-index exact equality. Empty arrays are handled by the empty branch
 * of classify; this helper never uses set/multiset/includes/head/count-only.
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
function isExactEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Non-empty proper suffix: short is a contiguous tail of long, strictly shorter,
 * length > 0. Index-by-index only — never set/head/count.
 * @param {readonly string[]} shortSeq
 * @param {readonly string[]} longSeq
 * @returns {boolean}
 */
function isNonEmptyProperSuffix(shortSeq, longSeq) {
  if (shortSeq.length === 0) return false;
  if (longSeq.length <= shortSeq.length) return false;
  const offset = longSeq.length - shortSeq.length;
  for (let i = 0; i < shortSeq.length; i += 1) {
    if (shortSeq[i] !== longSeq[offset + i]) return false;
  }
  return true;
}

/**
 * Classify J↔E relationship. Order is frozen (design §3.1 / plan appendix A).
 * @param {readonly string[]} J
 * @param {readonly string[]} E
 * @returns {{
 *   state: 'verified' | 'partial',
 *   relationship: string,
 *   matched: number,
 *   uncovered: number,
 * }}
 */
function classifyRelationship(J, E) {
  // 1. both empty (1a/1b)
  if (J.length === 0 && E.length === 0) {
    return { state: 'verified', relationship: 'empty', matched: 0, uncovered: 0 };
  }
  // 2. exact equal nonempty
  if (isExactEqual(J, E) && J.length > 0) {
    return {
      state: 'verified',
      relationship: 'equal',
      matched: J.length,
      uncovered: 0,
    };
  }
  // 3. E nonempty proper suffix of J
  if (isNonEmptyProperSuffix(E, J)) {
    return {
      state: 'verified',
      relationship: 'events-suffix-of-journal',
      matched: E.length,
      uncovered: 0,
    };
  }
  // 4. J nonempty proper suffix of E
  if (isNonEmptyProperSuffix(J, E)) {
    return {
      state: 'partial',
      relationship: 'journal-suffix-of-events',
      matched: J.length,
      uncovered: E.length - J.length,
    };
  }
  // 5. J empty && E nonempty → partial/uncovered-events
  if (J.length === 0 && E.length > 0) {
    return {
      state: 'partial',
      relationship: 'uncovered-events',
      matched: 0,
      uncovered: E.length,
    };
  }
  // 6. else broken (includes J>0 && E=[] — no empty-suffix loophole)
  throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
}

/**
 * Parse events raw UTF-8 into payloadDigest sequence E.
 * Priority after successful read:
 *   line count / per-line → bounds;
 *   final newline / interior blank / JSON / strict / raw canonical → event-invalid.
 * Does not call sanitize; does not skip bad lines.
 * @param {string} raw
 * @returns {string[]}
 */
function parseEventsToPayloadDigests(raw) {
  // Only missing/zero-byte raw is empty E=[]; any blank line (incl. sole '\n') is invalid.
  if (raw === '') return [];

  // Bounds checks first (design §5.2): strip at most one final newline, then always split.
  // Non-empty raw must not collapse to E=[] via body==='' (e.g. raw='\n' → lines=['']).
  const body = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const lines = body.split('\n');

  if (lines.length > AUDIT_CROSS_STORE_MAX_EVENT_LINES) {
    throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED);
  }
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES) {
      throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED);
    }
  }

  // After bounds: final newline required for non-empty files.
  if (!raw.endsWith('\n')) {
    throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID);
  }

  // Interior / blank empty lines.
  for (const line of lines) {
    if (line === '') {
      throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID);
    }
  }

  /** @type {string[]} */
  const digests = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID);
    }

    let canonical;
    try {
      // stringifyStrict projects first; rejects null/array/Proxy/extra keys/types.
      canonical = stringifyStrictCanonicalSanitizedEvent(parsed);
    } catch {
      throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID);
    }

    // Raw line must already be exact strict canonical UTF-8 (no rewrite/sanitize).
    if (canonical !== line) {
      throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID);
    }

    // Digest SoT from journal C1 — never copy DOMAIN/formula here.
    let digest;
    try {
      digest = computeAuditIntegrityEventPayloadDigest(parsed);
    } catch {
      throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID);
    }
    digests.push(digest);
  }
  return digests;
}

/**
 * Build frozen 8-key receipt (fixed key order). No ok/raw/digests/path/body.
 * @param {{
 *   state: 'verified' | 'partial',
 *   relationship: string,
 *   generationId: string | null,
 *   headDigest: string | null,
 *   journalEventCount: number,
 *   retainedEventCount: number,
 *   matchedEventCount: number,
 *   uncoveredEventCount: number,
 * }} fields
 */
function buildReceipt(fields) {
  return Object.freeze({
    state: fields.state,
    relationship: fields.relationship,
    generationId: fields.generationId,
    headDigest: fields.headDigest,
    journalEventCount: fields.journalEventCount,
    retainedEventCount: fields.retainedEventCount,
    matchedEventCount: fields.matchedEventCount,
    uncoveredEventCount: fields.uncoveredEventCount,
  });
}

/**
 * Read-only retention-aware structural relationship check J ↔ E.
 * Completely read-only: no queue, no write/append/init/repair/retry.
 *
 * @param {string} root existing safe data root
 * @param {object} [options] reserved; contract does not read any option keys
 *   (hostile getter/Proxy must not run — void options only)
 * @returns {Promise<{
 *   state: 'verified' | 'partial',
 *   relationship: string,
 *   generationId: string | null,
 *   headDigest: string | null,
 *   journalEventCount: number,
 *   retainedEventCount: number,
 *   matchedEventCount: number,
 *   uncoveredEventCount: number,
 * }>}
 */
export async function verifyAuditIntegrityAgainstEventStore(root, options = {}) {
  // Reserved options slot; do not touch properties (hostile getter/Proxy must not run).
  void options;

  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(root);
  } catch {
    throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR);
  }

  // --- journal side ---
  /** @type {string[]} */
  let J = [];
  /** @type {string | null} */
  let generationId = null;
  /** @type {string | null} */
  let headDigest = null;

  try {
    const snapshot = await inspectAuditIntegrityJournalFile(resolvedRoot);
    J = [...snapshot.payloadDigests];
    generationId = snapshot.generationId;
    headDigest = snapshot.headDigest;
  } catch (error) {
    // ONLY exact NOT_INITIALIZED → J=[] / meta null; all other journal errors rethrow typed.
    if (
      error instanceof AuditIntegrityJournalError
      && error.code === ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED
    ) {
      J = [];
      generationId = null;
      headDigest = null;
    } else {
      throw error;
    }
  }

  // --- events side ---
  let raw;
  try {
    raw = await safeReadText(resolvedRoot, AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH, {
      maxBytes: AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      raw = '';
    } else if (error instanceof AuditIntegrityCrossStoreError) {
      throw error;
    } else if (error instanceof SafeDataFileError) {
      throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR);
    } else {
      throwCrossStoreError(ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR);
    }
  }

  const E = parseEventsToPayloadDigests(raw);
  const rel = classifyRelationship(J, E);

  return buildReceipt({
    state: rel.state,
    relationship: rel.relationship,
    generationId,
    headDigest,
    journalEventCount: J.length,
    retainedEventCount: E.length,
    matchedEventCount: rel.matched,
    uncoveredEventCount: rel.uncovered,
  });
}
