import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;
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

export async function appendAuditEvent(dataDir, event) {
  const dir = join(dataDir, 'audit');
  await mkdir(dir, { recursive: true });
  const sanitized = sanitizeAuditEvent(event);
  await appendFile(auditFilePath(dataDir), JSON.stringify(sanitized) + '\n', 'utf-8');
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
