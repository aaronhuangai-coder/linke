import {
  SafeDataFileError,
  safeReadText,
} from './safe-data-files.js';
import { sanitizeAuditEvent } from './audit-event-schema.js';
import { appendAuditEventWithIntegrityDualWrite } from './audit-integrity-dual-write.js';

// Local binding for appendAuditEvent + public re-export (must not use export-from alone).
export { sanitizeAuditEvent };

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;
const AUDIT_RELATIVE_PATH = 'audit/events.jsonl';

function normalizeLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_AUDIT_LIMIT;
  return Math.min(parsed, MAX_AUDIT_LIMIT);
}

function positiveIntegerOrZero(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function auditIoError() {
  return new SafeDataFileError();
}

export function normalizeAuditRetention(retention) {
  if (retention === undefined || retention === null || retention === false) return null;
  if (typeof retention !== 'object' || Array.isArray(retention)) {
    throw new Error('auditRetention must be an object when provided');
  }

  const maxEvents = positiveIntegerOrZero(retention.maxEvents);
  if (maxEvents === null) {
    throw new Error('auditRetention.maxEvents must be a non-negative integer');
  }
  if (maxEvents === 0) return null;
  return { maxEvents };
}

export function parseAuditRetentionMaxEvents(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const maxEvents = Number(raw);
  if (!Number.isInteger(maxEvents) || maxEvents < 0) {
    throw new Error('LINKE_AUDIT_MAX_EVENTS must be a non-negative integer');
  }
  if (maxEvents === 0) return null;
  return { maxEvents };
}

async function readAuditRaw(dataDir) {
  try {
    return await safeReadText(dataDir, AUDIT_RELATIVE_PATH);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    if (error instanceof SafeDataFileError) throw error;
    throw auditIoError();
  }
}

/**
 * Production dual-write entry: sanitize (keep) → retention snapshot → exact-one
 * coordinator call. Does not forward Symbol test hooks or arbitrary options extras.
 * @param {string} dataDir
 * @param {object} event
 * @param {{ retention?: unknown }} [options]
 * @returns {Promise<object>} sanitized event
 */
export async function appendAuditEvent(dataDir, event, options = {}) {
  // sanitize-first: event getter throws surface before options.retention is touched.
  const sanitized = sanitizeAuditEvent(event);

  // Call-time retention snapshot exactly once (hostile options getter / TOCTOU).
  // Prior contract: options=null → TypeError on property access; default {} / undefined only.
  // Plain retention only — never pass DUAL_WRITE_TEST_* Symbols or extras.
  const retention = normalizeAuditRetention(options.retention);

  // Exact-one coordinator call. Coordinator re-sanitizes but id/createdAt stay stable
  // on an already-sanitized plain object. Return value matches prior append contract.
  return appendAuditEventWithIntegrityDualWrite(dataDir, sanitized, { retention });
}

export async function readAuditEvents(dataDir, options = {}) {
  let raw;
  try {
    raw = await readAuditRaw(dataDir);
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    throw auditIoError();
  }
  if (raw === null) return [];

  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore incomplete/corrupt lines; future hardening can surface this as a health signal.
    }
  }

  return events.reverse().slice(0, normalizeLimit(options.limit));
}
