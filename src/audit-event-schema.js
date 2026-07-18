import { createHash, randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';

/**
 * Unique SoT domain for audit integrity event payloadDigest.
 * Shared by journal plan/public wrapper and dual-write state parser.
 * Formula lives only here — do not copy into dual-write-state or coordinator.
 */
const AUDIT_INTEGRITY_EVENT_PAYLOAD_DOMAIN =
  'linke.audit-integrity-journal.v1.event-payload\u0000';

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

/** Fixed allowlist order for strict canonical projection / stringify. */
const STRICT_FIELD_ORDER = [
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
  'statusCode',
  'fileCount',
  'totalBytes',
  'verifiedFileCount',
  'retryCount',
  'wouldWrite',
  'executionRequired',
];

const STRICT_ALLOWED = new Set(STRICT_FIELD_ORDER);

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

/**
 * Byte-stable sanitize extracted from audit-log (line-equivalent behavior).
 * May invent id/time for missing fields; journal must only hash post-sanitize events.
 * @param {object} [event]
 * @param {Date|string|number} [now]
 * @returns {object}
 */
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

function failStrict() {
  throw new Error('audit-event-strict-projection-invalid');
}

function isPlainObjectPrototype(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertStrictStringField(value) {
  if (typeof value !== 'string') failStrict();
  if (sanitizeString(value) !== value) failStrict();
  if (!value) failStrict();
  return value;
}

/**
 * Strict createdAt: same string constraints, then exact Date#toISOString() form.
 * Does not normalize; rejects invalid / offset / missing-ms forms sanitize would rewrite.
 * @param {unknown} value
 * @returns {string}
 */
function assertStrictCreatedAt(value) {
  const text = assertStrictStringField(value);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) failStrict();
  return text;
}

function assertStrictStatusCode(value) {
  if (!Number.isInteger(value)) failStrict();
  return value;
}

function assertStrictNonNegativeInteger(value) {
  if (!Number.isInteger(value) || value < 0) failStrict();
  return value;
}

function assertStrictBoolean(value) {
  if (typeof value !== 'boolean') failStrict();
  return value;
}

/**
 * Fail-closed strict projection of a post-sanitize audit event.
 * Does not invent id/time; rejects hostile shapes and extra keys.
 * @param {unknown} event
 * @returns {object}
 */
export function projectStrictCanonicalSanitizedEvent(event) {
  if (event === null || typeof event !== 'object') failStrict();
  if (Array.isArray(event)) failStrict();
  if (typeof event === 'function') failStrict();
  if (utilTypes.isProxy(event)) failStrict();
  if (!isPlainObjectPrototype(event)) failStrict();

  const ownKeys = Reflect.ownKeys(event);
  for (const key of ownKeys) {
    if (typeof key === 'symbol') failStrict();
    if (typeof key !== 'string') failStrict();
    if (!STRICT_ALLOWED.has(key)) failStrict();

    const desc = Object.getOwnPropertyDescriptor(event, key);
    if (!desc) failStrict();
    if (!desc.enumerable) failStrict();
    if (desc.get !== undefined || desc.set !== undefined) failStrict();
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) failStrict();

    const value = desc.value;
    if (typeof value === 'function') failStrict();
  }

  if (!Object.prototype.hasOwnProperty.call(event, 'id')) failStrict();
  if (!Object.prototype.hasOwnProperty.call(event, 'createdAt')) failStrict();

  /** @type {Record<string, unknown>} */
  const projected = {};

  for (const field of STRICT_FIELD_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(event, field)) continue;
    const value = event[field];

    if (field === 'id') {
      projected[field] = assertStrictStringField(value);
      continue;
    }

    if (field === 'createdAt') {
      projected[field] = assertStrictCreatedAt(value);
      continue;
    }

    if (STRING_FIELDS.includes(field)) {
      projected[field] = assertStrictStringField(value);
      continue;
    }

    if (field === 'statusCode') {
      projected[field] = assertStrictStatusCode(value);
      continue;
    }

    if (NON_NEGATIVE_INTEGER_FIELDS.includes(field)) {
      projected[field] = assertStrictNonNegativeInteger(value);
      continue;
    }

    if (BOOLEAN_FIELDS.includes(field)) {
      projected[field] = assertStrictBoolean(value);
      continue;
    }

    failStrict();
  }

  return projected;
}

/**
 * Fixed-order JSON stringify of a strict-projected post-sanitize event.
 * @param {unknown} event
 * @returns {string}
 */
export function stringifyStrictCanonicalSanitizedEvent(event) {
  const projected = projectStrictCanonicalSanitizedEvent(event);
  /** @type {Record<string, unknown>} */
  const ordered = {};
  for (const field of STRICT_FIELD_ORDER) {
    if (Object.prototype.hasOwnProperty.call(projected, field)) {
      ordered[field] = projected[field];
    }
  }
  return JSON.stringify(ordered);
}

/**
 * Unique SoT for event payloadDigest hex (journal domain + strict canonical UTF-8).
 * Does not invent id/time; does not call sanitize.
 * Throws the same strict projection Error on hostile shapes.
 *
 * @param {unknown} strictEvent already strict-acceptable event
 * @returns {string} 64 lowercase hex
 */
export function computeAuditIntegrityEventPayloadDigest(strictEvent) {
  const canonicalEventUtf8 = stringifyStrictCanonicalSanitizedEvent(strictEvent);
  return createHash('sha256')
    .update(AUDIT_INTEGRITY_EVENT_PAYLOAD_DOMAIN + canonicalEventUtf8)
    .digest('hex');
}
