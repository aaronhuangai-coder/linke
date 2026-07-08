import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;
const auditFileQueues = new Map();
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

function auditFilePath(dataDir) {
  return join(dataDir, 'audit', 'events.jsonl');
}

function positiveIntegerOrZero(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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

function withAuditFileQueue(filePath, task) {
  const previous = auditFileQueues.get(filePath) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const cleanup = run.finally(() => {
    if (auditFileQueues.get(filePath) === cleanup) {
      auditFileQueues.delete(filePath);
    }
  });
  auditFileQueues.set(filePath, cleanup);
  return run;
}

async function compactAuditFile(filePath, retention) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  const lines = raw.split('\n').filter((line) => line.trim());
  if (lines.length <= retention.maxEvents) return;

  const retained = lines.slice(-retention.maxEvents);
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${retained.join('\n')}\n`, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // Best effort cleanup; caller still receives the compaction failure.
    }
    throw err;
  }
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
  if (Number.isInteger(event.fileCount) && event.fileCount >= 0) sanitized.fileCount = event.fileCount;

  return sanitized;
}

export async function appendAuditEvent(dataDir, event, options = {}) {
  const dir = join(dataDir, 'audit');
  await mkdir(dir, { recursive: true });
  const filePath = auditFilePath(dataDir);
  const sanitized = sanitizeAuditEvent(event);
  const line = `${JSON.stringify(sanitized)}\n`;
  const retention = normalizeAuditRetention(options.retention);

  if (!retention && !auditFileQueues.has(filePath)) {
    await appendFile(filePath, line, 'utf-8');
    return sanitized;
  }

  await withAuditFileQueue(filePath, async () => {
    await appendFile(filePath, line, 'utf-8');
    if (retention) {
      await compactAuditFile(filePath, retention);
    }
  });
  return sanitized;
}

export async function readAuditEvents(dataDir, options = {}) {
  let raw;
  try {
    raw = await readFile(auditFilePath(dataDir), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

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
