import { randomUUID } from 'node:crypto';
import {
  SafeDataFileError,
  safeAppendText,
  safeAtomicWriteText,
  safeReadText,
} from './safe-data-files.js';

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;
const auditFileQueues = new Map();
const AUDIT_RELATIVE_PATH = 'audit/events.jsonl';
const STRING_FIELDS = [
  'id',
  'createdAt',
  'type',
  'method',
  'path',
  'outcome',
  'requestId',
  'deviceId',
  'snapshotId',
  'operation',
  'message',
  'targetName',
  'attemptId',
  'errorCode',
];

const NON_NEGATIVE_INTEGER_FIELDS = [
  'fileCount',
  'totalBytes',
  'verifiedFileCount',
  'retryCount',
];

const BOOLEAN_FIELDS = [
  'wouldWrite',
  'executionRequired',
];

function toIsoString(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback.toISOString();
}

function sanitizeString(value, maxLength = 200) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, maxLength);
}

function normalizeLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_AUDIT_LIMIT;
  return Math.min(parsed, MAX_AUDIT_LIMIT);
}

function auditQueueKey(dataDir) {
  return `${dataDir}\0${AUDIT_RELATIVE_PATH}`;
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

function withAuditFileQueue(queueKey, task) {
  const previous = auditFileQueues.get(queueKey) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const cleanup = run.finally(() => {
    if (auditFileQueues.get(queueKey) === cleanup) {
      auditFileQueues.delete(queueKey);
    }
  });
  // Keep chain linked via cleanup, but do not leave its rejection unhandled when
  // callers only await `run` (intentional fail-closed append/compaction errors).
  cleanup.catch(() => {});
  auditFileQueues.set(queueKey, cleanup);
  return run;
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

async function compactAuditFile(dataDir, retention) {
  const raw = await readAuditRaw(dataDir);
  if (raw === null) return;

  const lines = raw.split('\n').filter((line) => line.trim());
  if (lines.length <= retention.maxEvents) return;

  const retained = lines.slice(-retention.maxEvents);
  await safeAtomicWriteText(
    dataDir,
    AUDIT_RELATIVE_PATH,
    `${retained.join('\n')}\n`,
    { mode: 0o600 },
  );
}

export function sanitizeAuditEvent(event = {}, now = new Date()) {
  const fallbackDate = now instanceof Date ? now : new Date(now);
  const sanitized = {
    id: sanitizeString(event.id) || randomUUID(),
    createdAt: toIsoString(event.createdAt || fallbackDate, fallbackDate),
  };

  for (const field of STRING_FIELDS) {
    if (field === 'id' || field === 'createdAt') continue;
    const value = sanitizeString(event[field]);
    if (value) sanitized[field] = value;
  }

  if (Number.isInteger(event.statusCode)) sanitized.statusCode = event.statusCode;

  for (const field of NON_NEGATIVE_INTEGER_FIELDS) {
    if (Number.isInteger(event[field]) && event[field] >= 0) {
      sanitized[field] = event[field];
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    if (typeof event[field] === 'boolean') {
      sanitized[field] = event[field];
    }
  }

  return sanitized;
}

export async function appendAuditEvent(dataDir, event, options = {}) {
  const sanitized = sanitizeAuditEvent(event);
  const line = `${JSON.stringify(sanitized)}\n`;
  const retention = normalizeAuditRetention(options.retention);
  const queueKey = auditQueueKey(dataDir);

  if (!retention && !auditFileQueues.has(queueKey)) {
    try {
      await safeAppendText(dataDir, AUDIT_RELATIVE_PATH, line);
    } catch (error) {
      if (error instanceof SafeDataFileError) throw error;
      throw auditIoError();
    }
    return sanitized;
  }

  await withAuditFileQueue(queueKey, async () => {
    try {
      await safeAppendText(dataDir, AUDIT_RELATIVE_PATH, line);
      if (retention) {
        await compactAuditFile(dataDir, retention);
      }
    } catch (error) {
      if (error instanceof SafeDataFileError) throw error;
      throw auditIoError();
    }
  });
  return sanitized;
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
