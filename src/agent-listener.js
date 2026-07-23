import { createServer as createHttpsServer } from 'node:https';
import { PassThrough } from 'node:stream';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertSupportedDeviceProtocol } from './device-protocol.js';

/** Maximum accepted JSON request body size for Agent G0a routes (bytes). */
export const MAX_AGENT_JSON_BODY_BYTES = 64 * 1024;

/** Upload create JSON body hard bound (bytes). */
const MAX_UPLOAD_CREATE_BODY_BYTES = 8 * 1024 * 1024;

const G0A_TOTAL_MS = 15_000;
const UPLOAD_CREATE_TOTAL_MS = 30_000;
const UPLOAD_STATUS_TOTAL_MS = 15_000;
const UPLOAD_CHUNK_TOTAL_MS = 120_000;
const UPLOAD_CHUNK_IDLE_MS = 15_000;
const RESTORE_JSON_TOTAL_MS = 15_000;
const RESTORE_CHUNK_TOTAL_MS = 120_000;

const RETRY_AFTER_MIN_SEC = 1;
const RETRY_AFTER_MAX_SEC = 30;
const BACKPRESSURE_RETRY_AFTER_SEC = '1';

const UPLOAD_SERVICE_METHODS = Object.freeze([
  'create',
  'status',
  'putChunk',
  'finalize',
  'abort',
]);

const RESTORE_SERVICE_METHODS = Object.freeze([
  'claim',
  'getTask',
  'getChunk',
  'updateProgress',
  'acceptReceipt',
  'acceptCleanup',
]);

/** Top-level allowlist for successful upload JSON responses (design §9.3). */
const UPLOAD_RESPONSE_KEYS = Object.freeze([
  'uploadId',
  'snapshotId',
  'manifestDigest',
  'deviceId',
  'status',
  'expiresAt',
  'acked',
  'fileIndex',
  'chunkIndex',
  'chunkOffset',
  'confirmedBytes',
  'totalBytes',
  'complete',
  'boundary',
  'missingSummary',
  'activeUploadId',
  'activeSnapshotId',
  'activeManifestDigest',
  'activeExpiresAt',
]);

const MISSING_SUMMARY_KEYS = Object.freeze([
  'next',
  'remainingFiles',
  'remainingBytes',
  'remainingChunks',
  'complete',
]);

const NEXT_POINTER_KEYS = Object.freeze([
  'fileIndex',
  'chunkIndex',
  'offset',
  'size',
  'complete',
]);

const BOUNDARY_KEYS = Object.freeze([
  'fileIndex',
  'chunkIndex',
  'offset',
  'confirmedBytes',
  'complete',
]);

/** Claim task summary allowlist (design §8.4). */
const RESTORE_CLAIM_TASK_KEYS = Object.freeze([
  'taskId',
  'snapshotId',
  'manifestDigest',
  'relativeTarget',
  'status',
  'fileCount',
  'totalBytes',
  'chunkSize',
  'createdAt',
  'claimedAt',
  'cancelRequested',
]);

/** GET task allowlist (design §8.5). */
const RESTORE_TASK_KEYS = Object.freeze([
  'taskId',
  'snapshotId',
  'manifestDigest',
  'relativeTarget',
  'status',
  'cancelRequested',
  'cleanupAuthorized',
  'fileCount',
  'totalBytes',
  'chunkSize',
  'createdAt',
  'claimedAt',
  'completedAt',
  'updatedAt',
  'files',
]);

const RESTORE_FILE_ENTRY_KEYS = Object.freeze([
  'fileIndex',
  'path',
  'size',
  'sha256',
  'chunkCount',
]);

const RESTORE_PROGRESS_KEYS = Object.freeze([
  'ok',
  'cancelRequested',
]);

const RESTORE_RECEIPT_ACK_KEYS = Object.freeze([
  'ok',
  'taskId',
  'status',
  'cleanupAuthorized',
  'receiptId',
]);

const RESTORE_CLEANUP_ACK_KEYS = Object.freeze([
  'ok',
  'taskId',
  'status',
  'cleanupId',
  'cleanupAckAt',
]);

const DEVICE_ID_HEADER_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const REGISTERED_CODES = new Set(Object.values(ERROR_CODES));

/**
 * Clamp to a valid HTTP status so writeHead never throws on forged values.
 * @param {unknown} statusCode
 * @param {number} [fallback=500]
 * @returns {number}
 */
function safeHttpStatus(statusCode, fallback = 500) {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return fallback;
  }
  return statusCode;
}

/**
 * Normalize error statuses to a safe HTTP 4xx/5xx only.
 * @param {unknown} statusCode
 * @returns {number}
 */
function normalizeErrorStatus(statusCode) {
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
    return 500;
  }
  return statusCode;
}

/**
 * Emit a single JSON response with fixed cache and length headers.
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} body
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(res, statusCode, body, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  const status = safeHttpStatus(statusCode, 500);
  const serialized = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(serialized);
}

/**
 * Release request flow-control without awaiting end; swallow late stream errors.
 * @param {import('node:http').IncomingMessage} req
 */
function releaseRequestStream(req) {
  try {
    req.on('error', () => {});
    if (!req.readableEnded && !req.destroyed) {
      req.resume();
    }
  } catch {
    // ignore — client may already have aborted
  }
}

/**
 * Safe Retry-After header from a finite, non-negative retryAfterMs only.
 * Seconds are ceiled and clamped to 1..30 (never 0 or >30).
 * @param {unknown} decision
 * @returns {Record<string, string>}
 */
function rateLimitHeaders(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return {};
  const ms = /** @type {{ retryAfterMs?: unknown }} */ (decision).retryAfterMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return {};
  const seconds = Math.ceil(ms / 1000);
  const clamped = Math.min(RETRY_AFTER_MAX_SEC, Math.max(RETRY_AFTER_MIN_SEC, seconds));
  return { 'retry-after': String(clamped) };
}

/**
 * Fixed bounded Retry-After for upload/restore backpressure (not IP device-rate-limited).
 * @returns {Record<string, string>}
 */
function backpressureHeaders() {
  return { 'retry-after': BACKPRESSURE_RETRY_AFTER_SEC };
}

/**
 * Emit a single binary response with fixed cache and length headers.
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {Buffer} body
 * @param {Record<string, string>} [extraHeaders]
 */
function sendBinary(res, statusCode, body, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  const status = safeHttpStatus(statusCode, 500);
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  res.writeHead(status, {
    'content-type': 'application/octet-stream',
    'content-length': buf.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(buf);
}

/**
 * True for Promise or thenable values (async rate-limit decisions are rejected).
 * @param {unknown} value
 * @returns {boolean}
 */
function isThenable(value) {
  return value != null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof /** @type {{ then?: unknown }} */ (value).then === 'function';
}

/**
 * Strict fail-closed evaluation of rateLimit.check().
 * Only plain objects with allowed === true continue; allowed === false → 429;
 * any other shape/thenable/throw → dependency fault.
 * @param {{ check: Function }} rateLimit
 * @param {string} clientKey
 * @returns {{ kind: 'allow' } | { kind: 'limit', decision: object } | { kind: 'error' }}
 */
function evaluateRateLimit(rateLimit, clientKey) {
  let decision;
  try {
    decision = rateLimit.check(clientKey);
  } catch {
    return { kind: 'error' };
  }
  if (isThenable(decision)) return { kind: 'error' };
  if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) {
    return { kind: 'error' };
  }
  if (decision.allowed === true) return { kind: 'allow' };
  if (decision.allowed === false) return { kind: 'limit', decision };
  return { kind: 'error' };
}

/**
 * Count named header occurrences in rawHeaders (case-insensitive).
 * Odd-length rawHeaders or non-string names → -1 (fail-close).
 * @param {import('node:http').IncomingMessage} req
 * @param {string} nameLower
 * @returns {number}
 */
function countRawHeader(req, nameLower) {
  const raw = req.rawHeaders;
  if (!Array.isArray(raw)) return -1;
  if (raw.length % 2 !== 0) return -1;
  let count = 0;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    if (typeof name !== 'string') return -1;
    if (name.toLowerCase() === nameLower) {
      count += 1;
    }
  }
  return count;
}

/**
 * Count Authorization header occurrences in rawHeaders (case-insensitive).
 * Node may keep only the first in req.headers.authorization.
 * @param {import('node:http').IncomingMessage} req
 * @returns {number}
 */
function countAuthorizationHeaders(req) {
  const count = countRawHeader(req, 'authorization');
  return count < 0 ? 0 : count;
}

/**
 * Extract a single Bearer device token; rejects missing/duplicate/malformed headers.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function bearerToken(req) {
  // Must be exactly one Authorization line in the wire headers.
  if (countAuthorizationHeaders(req) !== 1) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  if (
    header.includes(',')
    || header.includes('\n')
    || header.includes('\r')
    || header.includes('\0')
  ) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  if (!header.startsWith('Bearer ')) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  const token = header.slice('Bearer '.length);
  if (token.length === 0 || /\s/.test(token)) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  return token;
}

/**
 * Upload auth triad: exact-one Authorization / X-Linke-Device-Id / X-Linke-Protocol-Version.
 * Fail-closed on rawHeaders odd length / non-string names / duplicates.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ token: string, deviceId: string, protocolVersion: number }}
 */
function parseUploadAuthTriad(req) {
  const authCount = countRawHeader(req, 'authorization');
  if (authCount !== 1) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  const token = bearerToken(req);

  const deviceCount = countRawHeader(req, 'x-linke-device-id');
  if (deviceCount !== 1) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  const deviceId = req.headers['x-linke-device-id'];
  if (
    typeof deviceId !== 'string'
    || deviceId.length === 0
    || /[\x00-\x1f\x7f]/.test(deviceId)
    || !DEVICE_ID_HEADER_PATTERN.test(deviceId)
  ) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }

  const protocolCount = countRawHeader(req, 'x-linke-protocol-version');
  if (protocolCount !== 1) {
    throw new LinkeError(ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED, { statusCode: 426 });
  }
  const protocolRaw = req.headers['x-linke-protocol-version'];
  if (typeof protocolRaw !== 'string' || !/^(0|[1-9]\d*)$/.test(protocolRaw)) {
    throw new LinkeError(ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED, { statusCode: 426 });
  }
  const protocolNumber = Number(protocolRaw);
  if (!Number.isSafeInteger(protocolNumber)) {
    throw new LinkeError(ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED, { statusCode: 426 });
  }
  const protocolVersion = assertSupportedDeviceProtocol(protocolNumber);

  return { token, deviceId, protocolVersion };
}

/**
 * Read and parse a JSON object body with a hard byte bound.
 * Crosses the limit → immediate reject; does not wait for stream end / final chunk.
 * Oversize maps uniquely to device-request-invalid status 400 (design §6.4).
 * @param {import('node:http').IncomingMessage} req
 * @param {{
 *   maxBytes?: number,
 *   isAborted?: () => boolean,
 * }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
function readAgentBody(req, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : MAX_AGENT_JSON_BODY_BYTES;
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;

  return new Promise((resolve, reject) => {
    if (isAborted()) {
      reject(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
      return;
    }

    const declared = req.headers['content-length'];
    if (typeof declared === 'string' && declared.length > 0 && !declared.includes(',')) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > maxBytes) {
        releaseRequestStream(req);
        reject(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const detach = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      detach();
      releaseRequestStream(req);
      reject(error);
    };

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      detach();
      resolve(value);
    };

    const onData = (chunk) => {
      if (settled || isAborted()) {
        if (!settled && isAborted()) {
          fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        }
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      if (isAborted()) {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      const raw = Buffer.concat(chunks);
      chunks.length = 0;
      if (raw.length === 0) {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      succeed(parsed);
    };

    const onError = () => {
      fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Exact create envelope: { manifest, manifestDigest } only.
 * @param {Record<string, unknown>} parsed
 * @returns {{ manifest: object, manifestDigest: string }}
 */
function parseCreateEnvelope(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  let symbolCount = 0;
  try {
    symbolCount = Object.getOwnPropertySymbols(parsed).length;
  } catch {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  if (symbolCount > 0) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  let keys;
  try {
    keys = Object.keys(parsed);
  } catch {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  if (keys.length !== 2) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  const keySet = new Set(keys);
  if (!keySet.has('manifest') || !keySet.has('manifestDigest')) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  let manifest;
  let manifestDigest;
  try {
    manifest = /** @type {{ manifest?: unknown }} */ (parsed).manifest;
    manifestDigest = /** @type {{ manifestDigest?: unknown }} */ (parsed).manifestDigest;
  } catch {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  if (typeof manifestDigest !== 'string') {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  return { manifest, manifestDigest };
}

/**
 * Normalize optional heartbeat hostname; default "unknown".
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHostname(value) {
  if (value === undefined) return 'unknown';
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 255
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  return value;
}

/**
 * Map thrown values to a public registered error code + safe status.
 * Never echoes raw exception text. Controlled numeric 507 is retained.
 * @param {unknown} error
 * @returns {{ code: string, statusCode: number }}
 */
function publicFailure(error) {
  if (error instanceof LinkeError && REGISTERED_CODES.has(error.code)) {
    return {
      code: error.code,
      statusCode: normalizeErrorStatus(error.statusCode),
    };
  }
  return {
    code: ERROR_CODES.DEVICE_INTERNAL_ERROR,
    statusCode: 500,
  };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeJsonPrimitive(value) {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Copy a small plain object using an allowlist of keys only (no hostile getters on walk).
 * @param {unknown} value
 * @param {readonly string[]} allowedKeys
 * @returns {Record<string, unknown> | undefined}
 */
function projectPlainAllowlist(value, allowedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of allowedKeys) {
    let has = false;
    try {
      has = Object.prototype.hasOwnProperty.call(value, key);
    } catch {
      continue;
    }
    if (!has) continue;
    let raw;
    try {
      raw = /** @type {Record<string, unknown>} */ (value)[key];
    } catch {
      continue;
    }
    if (isSafeJsonPrimitive(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function projectMissingSummary(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of MISSING_SUMMARY_KEYS) {
    let has = false;
    try {
      has = Object.prototype.hasOwnProperty.call(value, key);
    } catch {
      continue;
    }
    if (!has) continue;
    let raw;
    try {
      raw = /** @type {Record<string, unknown>} */ (value)[key];
    } catch {
      continue;
    }
    if (key === 'next') {
      const next = projectPlainAllowlist(raw, NEXT_POINTER_KEYS);
      if (next) out.next = next;
      continue;
    }
    if (isSafeJsonPrimitive(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Safe projection of upload service success results (frozen plain object).
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function projectUploadSuccess(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({});
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of UPLOAD_RESPONSE_KEYS) {
    let has = false;
    try {
      has = Object.prototype.hasOwnProperty.call(value, key);
    } catch {
      continue;
    }
    if (!has) continue;
    let raw;
    try {
      raw = /** @type {Record<string, unknown>} */ (value)[key];
    } catch {
      continue;
    }
    if (key === 'missingSummary') {
      const summary = projectMissingSummary(raw);
      if (summary) out.missingSummary = summary;
      continue;
    }
    if (key === 'boundary') {
      const boundary = projectPlainAllowlist(raw, BOUNDARY_KEYS);
      if (boundary) out.boundary = boundary;
      continue;
    }
    if (isSafeJsonPrimitive(raw)) {
      out[key] = raw;
    }
  }
  return Object.freeze(out);
}

/**
 * Project a restore file entry (exact allowlist; path is snapshot-root-relative only).
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function projectRestoreFileEntry(value) {
  return projectPlainAllowlist(value, RESTORE_FILE_ENTRY_KEYS);
}

/**
 * Project GET task / claim task object with nested files[] allowlist.
 * @param {unknown} value
 * @param {readonly string[]} allowedKeys
 * @returns {Record<string, unknown>}
 */
function projectRestoreObject(value, allowedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({});
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of allowedKeys) {
    let has = false;
    try {
      has = Object.prototype.hasOwnProperty.call(value, key);
    } catch {
      continue;
    }
    if (!has) continue;
    let raw;
    try {
      raw = /** @type {Record<string, unknown>} */ (value)[key];
    } catch {
      continue;
    }
    if (key === 'files') {
      if (!Array.isArray(raw)) continue;
      /** @type {Record<string, unknown>[]} */
      const files = [];
      for (const entry of raw) {
        const projected = projectRestoreFileEntry(entry);
        if (projected) files.push(projected);
      }
      out.files = files;
      continue;
    }
    if (isSafeJsonPrimitive(raw)) {
      out[key] = raw;
    }
  }
  return Object.freeze(out);
}

/**
 * Safe projection of restore service success results by route kind.
 * @param {string} kind
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function projectRestoreSuccess(kind, value) {
  if (kind === 'claim') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return Object.freeze({ task: null });
    }
    let task;
    try {
      task = /** @type {{ task?: unknown }} */ (value).task;
    } catch {
      return Object.freeze({ task: null });
    }
    if (task === null || task === undefined) {
      return Object.freeze({ task: null });
    }
    return Object.freeze({
      task: projectRestoreObject(task, RESTORE_CLAIM_TASK_KEYS),
    });
  }
  if (kind === 'getTask') {
    return projectRestoreObject(value, RESTORE_TASK_KEYS);
  }
  if (kind === 'progress') {
    return projectRestoreObject(value, RESTORE_PROGRESS_KEYS);
  }
  if (kind === 'receipts') {
    return projectRestoreObject(value, RESTORE_RECEIPT_ACK_KEYS);
  }
  if (kind === 'cleanup') {
    return projectRestoreObject(value, RESTORE_CLEANUP_ACK_KEYS);
  }
  return Object.freeze({});
}

/**
 * Resolve injectable timer surface; hostile/partial falls back per-function to global.
 * @param {unknown} timers
 * @returns {{
 *   now: () => number,
 *   setTimeout: (fn: Function, ms: number, ...args: unknown[]) => unknown,
 *   clearTimeout: (id: unknown) => void,
 * }}
 */
function resolveTimers(timers) {
  const fallbackNow = () => Date.now();
  const fallbackSet = (fn, ms, ...args) => globalThis.setTimeout(fn, ms, ...args);
  const fallbackClear = (id) => {
    globalThis.clearTimeout(/** @type {any} */ (id));
  };

  if (timers == null || typeof timers !== 'object' || Array.isArray(timers)) {
    return { now: fallbackNow, setTimeout: fallbackSet, clearTimeout: fallbackClear };
  }

  /** @type {() => number} */
  let now = fallbackNow;
  /** @type {(fn: Function, ms: number, ...args: unknown[]) => unknown} */
  let setTimeoutFn = fallbackSet;
  /** @type {(id: unknown) => void} */
  let clearTimeoutFn = fallbackClear;

  try {
    const n = /** @type {{ now?: unknown }} */ (timers).now;
    if (typeof n === 'function') {
      now = () => {
        try {
          const v = n();
          return typeof v === 'number' && Number.isFinite(v) ? v : Date.now();
        } catch {
          return Date.now();
        }
      };
    }
  } catch {
    // keep fallback
  }

  try {
    const s = /** @type {{ setTimeout?: unknown }} */ (timers).setTimeout;
    if (typeof s === 'function') {
      setTimeoutFn = (fn, ms, ...args) => s(fn, ms, ...args);
    }
  } catch {
    // keep fallback
  }

  try {
    const c = /** @type {{ clearTimeout?: unknown }} */ (timers).clearTimeout;
    if (typeof c === 'function') {
      clearTimeoutFn = (id) => {
        try {
          c(id);
        } catch {
          // ignore
        }
      };
    }
  } catch {
    // keep fallback
  }

  return { now, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn };
}

/**
 * Complete uploadService surface: non-array object with five function methods.
 * Hostile getters / incomplete methods → null (no half-registration).
 * @param {unknown} uploadService
 * @returns {object | null}
 */
function resolveUploadService(uploadService) {
  if (uploadService == null) return null;
  if (typeof uploadService !== 'object' || Array.isArray(uploadService)) return null;
  try {
    for (const method of UPLOAD_SERVICE_METHODS) {
      const fn = /** @type {Record<string, unknown>} */ (uploadService)[method];
      if (typeof fn !== 'function') return null;
    }
  } catch {
    return null;
  }
  return uploadService;
}

/**
 * Complete uploadRateLimit surface: non-array object with function check.
 * missing/null/array/incomplete/hostile getter → null (no half-registration).
 * @param {unknown} uploadRateLimit
 * @returns {{ check: Function } | null}
 */
function resolveUploadRateLimit(uploadRateLimit) {
  if (uploadRateLimit == null) return null;
  if (typeof uploadRateLimit !== 'object' || Array.isArray(uploadRateLimit)) return null;
  try {
    const check = /** @type {{ check?: unknown }} */ (uploadRateLimit).check;
    if (typeof check !== 'function') return null;
  } catch {
    return null;
  }
  return /** @type {{ check: Function }} */ (uploadRateLimit);
}

/**
 * Complete restoreService surface: non-array object with six function methods.
 * Hostile getters / incomplete methods / thrown traps → null (no half-registration).
 * @param {unknown} restoreService
 * @returns {object | null}
 */
function resolveRestoreService(restoreService) {
  if (restoreService == null) return null;
  if (typeof restoreService !== 'object' || Array.isArray(restoreService)) return null;
  try {
    for (const method of RESTORE_SERVICE_METHODS) {
      const fn = /** @type {Record<string, unknown>} */ (restoreService)[method];
      if (typeof fn !== 'function') return null;
    }
  } catch {
    return null;
  }
  return restoreService;
}

/**
 * Complete restoreRateLimit surface: non-array object with function check.
 * missing/null/array/incomplete/hostile getter → null (no half-registration).
 * @param {unknown} restoreRateLimit
 * @returns {{ check: Function } | null}
 */
function resolveRestoreRateLimit(restoreRateLimit) {
  if (restoreRateLimit == null) return null;
  if (typeof restoreRateLimit !== 'object' || Array.isArray(restoreRateLimit)) return null;
  try {
    const check = /** @type {{ check?: unknown }} */ (restoreRateLimit).check;
    if (typeof check !== 'function') return null;
  } catch {
    return null;
  }
  return /** @type {{ check: Function }} */ (restoreRateLimit);
}

/**
 * Strict non-negative decimal integer path segment (no leading zeros; safe int).
 * @param {string} raw
 * @returns {number | null}
 */
function parseStrictNonNegIndex(raw) {
  if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/**
 * Build a bounded readable bridge for chunk bodies.
 * Forwards original req body bytes; copies rawHeaders/url for C3 parse only.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{
 *   bridge: import('node:stream').PassThrough & {
 *     rawHeaders?: unknown,
 *     url?: unknown,
 *     method?: unknown,
 *     headers?: unknown,
 *   },
 *   stop: () => void,
 * }}
 */
function createChunkBodyBridge(req) {
  const bridge = /** @type {import('node:stream').PassThrough & {
    rawHeaders?: unknown,
    url?: unknown,
    method?: unknown,
    headers?: unknown,
  }} */ (new PassThrough({ highWaterMark: 8 * 1024 * 1024 + 64 * 1024 }));

  try {
    bridge.rawHeaders = Array.isArray(req.rawHeaders)
      ? req.rawHeaders.slice()
      : req.rawHeaders;
  } catch {
    try {
      bridge.rawHeaders = req.rawHeaders;
    } catch {
      // leave undefined — C3 will fail-closed
    }
  }
  try {
    bridge.url = req.url;
  } catch {
    // ignore
  }
  try {
    bridge.method = req.method;
  } catch {
    // ignore
  }
  try {
    bridge.headers = req.headers;
  } catch {
    // ignore
  }

  let stopped = false;
  // Avoid unhandled bridge errors after stop/destroy.
  try {
    bridge.on('error', () => {});
  } catch {
    // ignore
  }

  /** @param {Error} [err] */
  const onSourceError = (err) => {
    if (stopped) return;
    try {
      if (!bridge.destroyed) bridge.destroy(err);
    } catch {
      // ignore
    }
  };

  try {
    // Swallow late source errors so unpipe/destroy cannot become unhandled.
    req.on('error', onSourceError);
  } catch {
    // ignore
  }

  try {
    req.pipe(bridge);
  } catch {
    try {
      if (!bridge.destroyed) bridge.destroy();
    } catch {
      // ignore
    }
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      req.unpipe(bridge);
    } catch {
      // ignore
    }
    try {
      req.removeListener('error', onSourceError);
    } catch {
      // ignore
    }
    try {
      if (typeof req.pause === 'function') req.pause();
    } catch {
      // ignore
    }
    try {
      if (!bridge.destroyed) {
        bridge.destroy();
      }
    } catch {
      // ignore
    }
  };

  return { bridge, stop };
}

/**
 * Strict upload route match (no query / trailing slash / decode speculation).
 * uploadId is the raw path segment string for C3 validation.
 * @param {string | undefined} method
 * @param {string | undefined} url
 * @returns {{ kind: string, uploadId?: string } | null}
 */
function matchUploadRoute(method, url) {
  if (typeof method !== 'string' || typeof url !== 'string') return null;
  if (url.includes('?')) return null;

  if (method === 'POST' && url === '/agent/upload/sessions') {
    return { kind: 'create' };
  }

  const matched = /^\/agent\/upload\/sessions\/([^/]+)(?:\/(chunks|finalize|abort))?$/.exec(url);
  if (!matched) return null;

  const uploadId = matched[1];
  const action = matched[2];

  if (method === 'GET' && action === undefined) {
    return { kind: 'status', uploadId };
  }
  if (method === 'POST' && action === 'chunks') {
    return { kind: 'chunk', uploadId };
  }
  if (method === 'POST' && action === 'finalize') {
    return { kind: 'finalize', uploadId };
  }
  if (method === 'POST' && action === 'abort') {
    return { kind: 'abort', uploadId };
  }
  return null;
}

/**
 * Strict restore route match (no query / trailing slash / decode speculation).
 * Indices are raw path segments; handler validates strict non-neg decimal safe ints.
 * @param {string | undefined} method
 * @param {string | undefined} url
 * @returns {{
 *   kind: string,
 *   taskId?: string,
 *   fileIndexRaw?: string,
 *   chunkIndexRaw?: string,
 * } | null}
 */
function matchRestoreRoute(method, url) {
  if (typeof method !== 'string' || typeof url !== 'string') return null;
  if (url.includes('?')) return null;

  if (method === 'POST' && url === '/agent/restore/tasks/claim') {
    return { kind: 'claim' };
  }

  const taskGet = /^\/agent\/restore\/tasks\/([^/]+)$/.exec(url);
  if (method === 'GET' && taskGet) {
    return { kind: 'getTask', taskId: taskGet[1] };
  }

  const chunk = /^\/agent\/restore\/tasks\/([^/]+)\/files\/([^/]+)\/chunks\/([^/]+)$/.exec(url);
  if (method === 'GET' && chunk) {
    return {
      kind: 'chunk',
      taskId: chunk[1],
      fileIndexRaw: chunk[2],
      chunkIndexRaw: chunk[3],
    };
  }

  const action = /^\/agent\/restore\/tasks\/([^/]+)\/(progress|receipts|cleanup)$/.exec(url);
  if (method === 'POST' && action) {
    const actionName = action[2];
    return {
      kind: actionName === 'progress'
        ? 'progress'
        : actionName === 'receipts'
          ? 'receipts'
          : 'cleanup',
      taskId: action[1],
    };
  }

  return null;
}

/**
 * Claim body: empty stream or exact `{}` only; unknown keys → restore-task-invalid.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ isAborted?: () => boolean }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
function readClaimBody(req, options = {}) {
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  const maxBytes = MAX_AGENT_JSON_BODY_BYTES;

  return new Promise((resolve, reject) => {
    if (isAborted()) {
      reject(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
      return;
    }

    const declared = req.headers['content-length'];
    if (typeof declared === 'string' && declared.length > 0 && !declared.includes(',')) {
      const length = Number(declared);
      if (Number.isFinite(length) && length === 0) {
        releaseRequestStream(req);
        resolve(Object.freeze({}));
        return;
      }
      if (Number.isFinite(length) && length > maxBytes) {
        releaseRequestStream(req);
        reject(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const detach = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      detach();
      releaseRequestStream(req);
      reject(error);
    };

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      detach();
      resolve(value);
    };

    const onData = (chunk) => {
      if (settled || isAborted()) {
        if (!settled && isAborted()) {
          fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        }
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      if (isAborted()) {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      const raw = Buffer.concat(chunks);
      chunks.length = 0;
      if (raw.length === 0) {
        succeed(Object.freeze({}));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      let keys;
      try {
        keys = Object.keys(parsed);
      } catch {
        fail(new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID));
        return;
      }
      if (keys.length !== 0) {
        fail(new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID));
        return;
      }
      succeed(Object.freeze({}));
    };

    const onError = () => {
      fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Progress body exact keys: fileIndex / chunkIndex / receivedBytes (safe ints ≥ 0).
 * @param {Record<string, unknown>} parsed
 * @returns {{ fileIndex: number, chunkIndex: number, receivedBytes: number }}
 */
function parseProgressBody(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
  }
  let keys;
  try {
    keys = Object.keys(parsed);
  } catch {
    throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
  }
  if (keys.length !== 3) {
    throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
  }
  const keySet = new Set(keys);
  if (
    !keySet.has('fileIndex')
    || !keySet.has('chunkIndex')
    || !keySet.has('receivedBytes')
  ) {
    throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
  }
  let fileIndex;
  let chunkIndex;
  let receivedBytes;
  try {
    fileIndex = /** @type {{ fileIndex?: unknown }} */ (parsed).fileIndex;
    chunkIndex = /** @type {{ chunkIndex?: unknown }} */ (parsed).chunkIndex;
    receivedBytes = /** @type {{ receivedBytes?: unknown }} */ (parsed).receivedBytes;
  } catch {
    throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
  }
  if (typeof fileIndex !== 'number' || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
    throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
  }
  if (typeof chunkIndex !== 'number' || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
  }
  if (
    typeof receivedBytes !== 'number'
    || !Number.isSafeInteger(receivedBytes)
    || receivedBytes < 0
  ) {
    throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
  }
  return { fileIndex, chunkIndex, receivedBytes };
}

/**
 * Per-request idempotent settle + deadline timers + request-scoped AbortSignal.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ReturnType<typeof resolveTimers>} timers
 */
function createSettleGate(req, res, timers) {
  let settled = false;
  const controller = new AbortController();
  const requestSignal = controller.signal;
  /** @type {unknown[]} */
  const timerIds = [];
  /** @type {unknown | null} */
  let idleTimerId = null;
  /** @type {Array<() => void>} */
  const cleanups = [];
  /** @type {((error: Error) => void) | null} */
  let abortWait = null;
  const aborted = new Promise((_, reject) => {
    abortWait = reject;
  });
  // Prevent unhandled rejection if nobody races against aborted.
  aborted.catch(() => {});

  const clearTimers = () => {
    for (const id of timerIds) {
      try {
        timers.clearTimeout(id);
      } catch {
        // ignore
      }
    }
    timerIds.length = 0;
    if (idleTimerId != null) {
      try {
        timers.clearTimeout(idleTimerId);
      } catch {
        // ignore
      }
      idleTimerId = null;
    }
  };

  const runCleanups = () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    cleanups.length = 0;
  };

  /**
   * Abort request-scoped signal without leaking reason. Idempotent.
   */
  const abortRequestSignal = () => {
    try {
      if (!requestSignal.aborted) {
        controller.abort();
      }
    } catch {
      // ignore — never leak abort reason / raw error
    }
  };

  /**
   * Deadline/cancel path only: idempotent signal abort + reject the race waiter.
   * Normal 2xx/4xx/5xx settle must NOT call this (completed work is not cancelled).
   */
  const cancel = () => {
    abortRequestSignal();
    // Unblock any raced service await so deadline cannot hang the handler.
    if (abortWait) {
      try {
        abortWait(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
      } catch {
        // ignore
      }
      abortWait = null;
    }
  };

  /**
   * @param {number} statusCode
   * @param {object} body
   * @param {Record<string, string>} [extraHeaders]
   * @returns {boolean}
   */
  const settle = (statusCode, body, extraHeaders = {}) => {
    if (settled) return false;
    settled = true;
    // settle does not abort signal — only cancel() (deadlines) does.
    clearTimers();
    // Stream/bridge cleanup before JSON so late body cannot enter service.
    runCleanups();
    try {
      sendJson(res, statusCode, body, extraHeaders);
    } catch {
      // last-resort: response may already be closed
    }
    // Soft-release after unique JSON so TLS clients see response, not only ECONNRESET.
    // Bridge must already be unpiped/stopped in cleanups so resume does not feed service.
    try {
      releaseRequestStream(req);
    } catch {
      // ignore
    }
    return true;
  };

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  const settleError = (error) => {
    const failure = publicFailure(error);
    /** @type {Record<string, string>} */
    const headers = {};
    if (
      error instanceof LinkeError
      && (
        error.code === ERROR_CODES.UPLOAD_BACKPRESSURE
        || error.code === ERROR_CODES.RESTORE_BACKPRESSURE
      )
    ) {
      Object.assign(headers, backpressureHeaders());
    }
    return settle(failure.statusCode, { error: failure.code }, headers);
  };

  /**
   * Single-settle binary success path (restore chunk GET).
   * @param {number} statusCode
   * @param {Buffer} body
   * @param {Record<string, string>} [extraHeaders]
   * @returns {boolean}
   */
  const settleBinary = (statusCode, body, extraHeaders = {}) => {
    if (settled) return false;
    settled = true;
    clearTimers();
    runCleanups();
    try {
      sendBinary(res, statusCode, body, extraHeaders);
    } catch {
      // last-resort: response may already be closed
    }
    try {
      releaseRequestStream(req);
    } catch {
      // ignore
    }
    return true;
  };

  /**
   * Race a service/body promise against cancel-abort so deadlines cannot hang the handler.
   * @template T
   * @param {Promise<T>} promise
   * @returns {Promise<T>}
   */
  const race = (promise) => Promise.race([promise, aborted]);

  /**
   * @param {number} ms
   * @param {() => void} onFire
   */
  const armTotal = (ms, onFire) => {
    try {
      const id = timers.setTimeout(() => {
        if (settled) return;
        onFire();
      }, ms);
      timerIds.push(id);
    } catch {
      // timer arm failure: request continues without deadline (fail open only on timer API)
    }
  };

  /**
   * Chunk idle timer: non-empty `data` on the original source resets; empty does not.
   * Observes the source req (not the bridge) so bytes are not swallowed.
   * @param {number} idleMs
   * @param {() => void} onFire
   * @param {import('node:stream').Readable | import('node:http').IncomingMessage} [source]
   */
  const armChunkIdle = (idleMs, onFire, source = req) => {
    const rearm = () => {
      if (settled) return;
      if (idleTimerId != null) {
        try {
          timers.clearTimeout(idleTimerId);
        } catch {
          // ignore
        }
        idleTimerId = null;
      }
      try {
        idleTimerId = timers.setTimeout(() => {
          if (settled) return;
          onFire();
        }, idleMs);
      } catch {
        // ignore
      }
    };

    rearm();

    /**
     * @param {Buffer | string | unknown} chunk
     */
    const onData = (chunk) => {
      if (settled) return;
      let length = 0;
      try {
        if (Buffer.isBuffer(chunk)) {
          length = chunk.length;
        } else if (typeof chunk === 'string') {
          length = chunk.length;
        } else if (chunk && typeof chunk === 'object' && typeof /** @type {{ length?: unknown }} */ (chunk).length === 'number') {
          length = /** @type {{ length: number }} */ (chunk).length;
        }
      } catch {
        length = 0;
      }
      if (length > 0) {
        rearm();
      }
    };

    try {
      source.on('data', onData);
      cleanups.push(() => {
        try {
          source.removeListener('data', onData);
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore — total timer still bounds the request
    }
  };

  return {
    isSettled: () => settled,
    signal: requestSignal,
    cancel,
    settle,
    settleBinary,
    settleError,
    race,
    armTotal,
    armChunkIdle,
    addCleanup: (fn) => {
      if (typeof fn === 'function') cleanups.push(fn);
    },
  };
}

/**
 * Create the TLS-only device listener; no Web or management routes are mounted.
 * @param {{
 *   identity?: { keyPem?: string, certPem?: string },
 *   registry?: {
 *     consumeEnrollment: Function,
 *     authenticate: Function,
 *     beginTokenRotation: Function,
 *     confirmTokenRotation: Function,
 *   },
 *   onHeartbeat?: (event: {
 *     deviceId: string,
 *     hostname: string,
 *     remoteAddress: string,
 *   }) => Promise<void> | void,
 *   rateLimit?: { check: (clientKey: string) => { allowed: boolean, retryAfterMs?: number } },
 *   uploadRateLimit?: { check: (clientKey: string) => { allowed: boolean, retryAfterMs?: number } },
 *   uploadService?: {
 *     create: Function,
 *     status: Function,
 *     putChunk: Function,
 *     finalize: Function,
 *     abort: Function,
 *   },
 *   restoreRateLimit?: { check: (clientKey: string) => { allowed: boolean, retryAfterMs?: number } },
 *   restoreService?: {
 *     claim: Function,
 *     getTask: Function,
 *     getChunk: Function,
 *     updateProgress: Function,
 *     acceptReceipt: Function,
 *     acceptCleanup: Function,
 *   },
 *   timers?: {
 *     now?: () => number,
 *     setTimeout?: (fn: Function, ms: number, ...args: unknown[]) => unknown,
 *     clearTimeout?: (id: unknown) => void,
 *   },
 * }} [options]
 * @returns {import('node:https').Server}
 */
export function createAgentListener({
  identity,
  registry,
  onHeartbeat = async () => {},
  rateLimit,
  uploadRateLimit,
  uploadService,
  restoreRateLimit,
  restoreService,
  timers,
} = {}) {
  if (!identity?.keyPem || !identity?.certPem || !registry) {
    throw new Error('identity and registry are required');
  }

  // Fail-closed registration: both complete service AND complete uploadRateLimit.check.
  const resolvedUploadService = resolveUploadService(uploadService);
  const resolvedUploadRateLimit = resolveUploadRateLimit(uploadRateLimit);
  const uploadRoutesEnabled = resolvedUploadService != null && resolvedUploadRateLimit != null;
  // Dual-gate: complete restoreService AND complete restoreRateLimit.check.
  const resolvedRestoreService = resolveRestoreService(restoreService);
  const resolvedRestoreRateLimit = resolveRestoreRateLimit(restoreRateLimit);
  const restoreRoutesEnabled = resolvedRestoreService != null && resolvedRestoreRateLimit != null;
  const resolvedTimers = resolveTimers(timers);

  const server = createHttpsServer({
    key: identity.keyPem,
    cert: identity.certPem,
    minVersion: 'TLSv1.2',
  }, (req, res) => {
    handleAgentRequest(req, res, {
      registry,
      onHeartbeat,
      rateLimit,
      uploadRateLimit: uploadRoutesEnabled ? resolvedUploadRateLimit : null,
      uploadService: uploadRoutesEnabled ? resolvedUploadService : null,
      restoreRateLimit: restoreRoutesEnabled ? resolvedRestoreRateLimit : null,
      restoreService: restoreRoutesEnabled ? resolvedRestoreService : null,
      timers: resolvedTimers,
    }).catch(() => {
      try {
        sendJson(res, 500, { error: ERROR_CODES.DEVICE_INTERNAL_ERROR });
      } catch {
        // last-resort: avoid unhandled rejection if response is already closed
      }
    });
  });

  server.headersTimeout = 10_000;
  // Design §6.4: close server-level hard ceiling; per-route handler deadlines are SoT.
  server.requestTimeout = 0;
  return server;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   registry: object,
 *   onHeartbeat: Function,
 *   rateLimit?: { check: Function },
 *   uploadRateLimit?: { check: Function },
 *   uploadService: object | null,
 *   restoreRateLimit?: { check: Function },
 *   restoreService: object | null,
 *   timers: ReturnType<typeof resolveTimers>,
 * }} deps
 */
async function handleAgentRequest(req, res, deps) {
  const {
    registry,
    onHeartbeat,
    rateLimit,
    uploadRateLimit,
    uploadService,
    restoreRateLimit,
    restoreService,
    timers,
  } = deps;

  const method = req.method;
  const url = req.url;
  const uploadRoute = uploadService ? matchUploadRoute(method, url) : null;

  if (uploadRoute && uploadService) {
    return handleUploadRequest(req, res, uploadRoute, {
      registry,
      uploadRateLimit,
      uploadService,
      timers,
    });
  }

  const restoreRoute = restoreService ? matchRestoreRoute(method, url) : null;

  if (restoreRoute && restoreService) {
    return handleRestoreRequest(req, res, restoreRoute, {
      registry,
      restoreRateLimit,
      restoreService,
      timers,
    });
  }

  const gate = createSettleGate(req, res, timers);
  gate.armTotal(G0A_TOTAL_MS, () => {
    // Deadline: abort-before-response (cancel signal, then unique JSON).
    gate.cancel();
    gate.settle(400, { error: ERROR_CODES.DEVICE_REQUEST_INVALID });
  });

  try {
    if (rateLimit) {
      const verdict = evaluateRateLimit(rateLimit, req.socket.remoteAddress || 'unknown');
      if (verdict.kind === 'error') {
        return gate.settle(500, { error: ERROR_CODES.DEVICE_INTERNAL_ERROR });
      }
      if (verdict.kind === 'limit') {
        return gate.settle(
          429,
          { error: ERROR_CODES.DEVICE_RATE_LIMITED },
          rateLimitHeaders(verdict.decision),
        );
      }
    }

    if (method === 'POST' && url === '/agent/enroll') {
      const body = await gate.race(readAgentBody(req, { isAborted: gate.isSettled }));
      if (gate.isSettled()) return undefined;
      const result = await gate.race(registry.consumeEnrollment({
        deviceId: body.deviceId,
        code: body.enrollmentCode,
        protocolVersion: body.protocolVersion,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(201, {
        deviceId: result.deviceId,
        deviceToken: result.token,
        protocolVersion: result.protocolVersion,
      });
    }

    if (method === 'POST' && url === '/agent/heartbeat') {
      const token = bearerToken(req);
      const body = await gate.race(readAgentBody(req, { isAborted: gate.isSettled }));
      if (gate.isSettled()) return undefined;
      const device = await gate.race(registry.authenticate({
        deviceId: body.deviceId,
        token,
        protocolVersion: body.protocolVersion,
      }));
      if (gate.isSettled()) return undefined;
      await gate.race(Promise.resolve(onHeartbeat({
        deviceId: device.deviceId,
        hostname: normalizeHostname(body.hostname),
        remoteAddress: req.socket.remoteAddress || 'unknown',
      })));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, { deviceId: device.deviceId, accepted: true });
    }

    if (method === 'POST' && url === '/agent/token/rotate') {
      const token = bearerToken(req);
      const body = await gate.race(readAgentBody(req, { isAborted: gate.isSettled }));
      if (gate.isSettled()) return undefined;
      const result = await gate.race(registry.beginTokenRotation({
        deviceId: body.deviceId,
        token,
        protocolVersion: body.protocolVersion,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, {
        deviceId: result.deviceId,
        deviceToken: result.token,
      });
    }

    if (method === 'POST' && url === '/agent/token/rotate/confirm') {
      const token = bearerToken(req);
      const body = await gate.race(readAgentBody(req, { isAborted: gate.isSettled }));
      if (gate.isSettled()) return undefined;
      const result = await gate.race(registry.confirmTokenRotation({
        deviceId: body.deviceId,
        token,
        protocolVersion: body.protocolVersion,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, {
        deviceId: result.deviceId,
        rotated: result.rotated,
      });
    }

    // Fixed route table only: never await body drain on unknown routes.
    return gate.settle(404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
  } catch (error) {
    if (gate.isSettled()) return undefined;
    const failure = publicFailure(error);
    return gate.settle(failure.statusCode, { error: failure.code });
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ kind: string, uploadId?: string }} route
 * @param {{
 *   registry: object,
 *   uploadRateLimit: { check: Function },
 *   uploadService: object,
 *   timers: ReturnType<typeof resolveTimers>,
 * }} deps
 */
async function handleUploadRequest(req, res, route, deps) {
  const { registry, uploadRateLimit, uploadService, timers } = deps;
  const gate = createSettleGate(req, res, timers);
  const signal = gate.signal;

  const totalMs = route.kind === 'create'
    ? UPLOAD_CREATE_TOTAL_MS
    : route.kind === 'chunk'
      ? UPLOAD_CHUNK_TOTAL_MS
      : UPLOAD_STATUS_TOTAL_MS;

  const timeoutCode = route.kind === 'chunk'
    ? ERROR_CODES.UPLOAD_CHUNK_INVALID
    : ERROR_CODES.DEVICE_REQUEST_INVALID;

  // Total deadline from request start (chunk idle arms only after auth + bridge).
  gate.armTotal(totalMs, () => {
    // Deadline: abort-before-response (cancel signal, then unique JSON).
    gate.cancel();
    gate.settle(400, { error: timeoutCode });
  });

  try {
    // Path-aware pre-auth upload limiter only (never legacy rateLimit).
    // Registration guarantees a complete check function; still fail-closed on shape/throw/thenable.
    const verdict = evaluateRateLimit(uploadRateLimit, req.socket.remoteAddress || 'unknown');
    if (verdict.kind === 'error') {
      return gate.settle(500, { error: ERROR_CODES.DEVICE_INTERNAL_ERROR });
    }
    if (verdict.kind === 'limit') {
      return gate.settle(
        429,
        { error: ERROR_CODES.DEVICE_RATE_LIMITED },
        rateLimitHeaders(verdict.decision),
      );
    }

    // Auth triad + authenticate before body / bridge / service lookup.
    const triad = parseUploadAuthTriad(req);
    const device = await gate.race(registry.authenticate({
      deviceId: triad.deviceId,
      token: triad.token,
      protocolVersion: triad.protocolVersion,
    }));
    if (gate.isSettled()) return undefined;

    const authenticatedDeviceId = device && typeof device.deviceId === 'string'
      ? device.deviceId
      : null;
    if (typeof authenticatedDeviceId !== 'string' || authenticatedDeviceId.length === 0) {
      throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
    }

    if (route.kind === 'create') {
      const body = await gate.race(readAgentBody(req, {
        maxBytes: MAX_UPLOAD_CREATE_BODY_BYTES,
        isAborted: gate.isSettled,
      }));
      if (gate.isSettled()) return undefined;
      const envelope = parseCreateEnvelope(body);
      const result = await gate.race(uploadService.create({
        authenticatedDeviceId,
        manifest: envelope.manifest,
        claimedManifestDigest: envelope.manifestDigest,
        signal,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(201, projectUploadSuccess(result));
    }

    if (route.kind === 'status') {
      const result = await gate.race(uploadService.status({
        authenticatedDeviceId,
        uploadId: route.uploadId,
        signal,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, projectUploadSuccess(result));
    }

    if (route.kind === 'chunk') {
      // Auth done: start bridge + idle, then service. Do not pre-read binary body.
      const { bridge, stop } = createChunkBodyBridge(req);
      gate.addCleanup(stop);
      // Idle observes original req non-empty data; total already armed from request start.
      gate.armChunkIdle(UPLOAD_CHUNK_IDLE_MS, () => {
        // Chunk idle deadline: abort-before-response.
        gate.cancel();
        gate.settle(400, { error: ERROR_CODES.UPLOAD_CHUNK_INVALID });
      }, req);

      const result = await gate.race(uploadService.putChunk({
        authenticatedDeviceId,
        request: bridge,
        stream: bridge,
        signal,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, projectUploadSuccess(result));
    }

    if (route.kind === 'finalize') {
      // Must not wait for request body end.
      const result = await gate.race(uploadService.finalize({
        authenticatedDeviceId,
        uploadId: route.uploadId,
        signal,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, projectUploadSuccess(result));
    }

    if (route.kind === 'abort') {
      const result = await gate.race(uploadService.abort({
        authenticatedDeviceId,
        uploadId: route.uploadId,
        signal,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, projectUploadSuccess(result));
    }

    return gate.settle(404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
  } catch (error) {
    if (gate.isSettled()) return undefined;
    return gate.settleError(error);
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   kind: string,
 *   taskId?: string,
 *   fileIndexRaw?: string,
 *   chunkIndexRaw?: string,
 * }} route
 * @param {{
 *   registry: object,
 *   restoreRateLimit: { check: Function },
 *   restoreService: object,
 *   timers: ReturnType<typeof resolveTimers>,
 * }} deps
 */
async function handleRestoreRequest(req, res, route, deps) {
  const { registry, restoreRateLimit, restoreService, timers } = deps;
  const gate = createSettleGate(req, res, timers);
  const signal = gate.signal;

  const totalMs = route.kind === 'chunk'
    ? RESTORE_CHUNK_TOTAL_MS
    : RESTORE_JSON_TOTAL_MS;

  /** Arm total after auth so deadline tests can observe service entry + signal abort. */
  const armRestoreTotal = () => {
    gate.armTotal(totalMs, () => {
      gate.cancel();
      gate.settle(400, { error: ERROR_CODES.DEVICE_REQUEST_INVALID });
    });
  };

  try {
    // 0. Path-aware pre-auth restore limiter only (never legacy / upload buckets).
    const verdict = evaluateRateLimit(restoreRateLimit, req.socket.remoteAddress || 'unknown');
    if (verdict.kind === 'error') {
      return gate.settle(500, { error: ERROR_CODES.DEVICE_INTERNAL_ERROR });
    }
    if (verdict.kind === 'limit') {
      return gate.settle(
        429,
        { error: ERROR_CODES.DEVICE_RATE_LIMITED },
        rateLimitHeaders(verdict.decision),
      );
    }

    // 1–2. Auth triad + authenticate before body / taskId service lookup.
    const triad = parseUploadAuthTriad(req);
    const device = await gate.race(registry.authenticate({
      deviceId: triad.deviceId,
      token: triad.token,
      protocolVersion: triad.protocolVersion,
    }));
    if (gate.isSettled()) return undefined;

    const authenticatedDeviceId = device && typeof device.deviceId === 'string'
      ? device.deviceId
      : null;
    if (typeof authenticatedDeviceId !== 'string' || authenticatedDeviceId.length === 0) {
      throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
    }

    // Deadline covers post-auth body + service work (chunk 120s / JSON 15s).
    armRestoreTotal();

    if (route.kind === 'claim') {
      await gate.race(readClaimBody(req, { isAborted: gate.isSettled }));
      if (gate.isSettled()) return undefined;
      const result = await gate.race(restoreService.claim({
        deviceId: authenticatedDeviceId,
        signal,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, projectRestoreSuccess('claim', result));
    }

    if (route.kind === 'getTask') {
      const result = await gate.race(restoreService.getTask({
        deviceId: authenticatedDeviceId,
        taskId: route.taskId,
        signal,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, projectRestoreSuccess('getTask', result));
    }

    if (route.kind === 'chunk') {
      const fileIndex = parseStrictNonNegIndex(route.fileIndexRaw || '');
      const chunkIndex = parseStrictNonNegIndex(route.chunkIndexRaw || '');
      if (fileIndex === null || chunkIndex === null) {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
      }
      // getChunk owns locks.runTransfer; route never calls runTransfer itself.
      const result = await gate.race(restoreService.getChunk({
        deviceId: authenticatedDeviceId,
        taskId: route.taskId,
        fileIndex,
        chunkIndex,
        signal,
      }));
      if (gate.isSettled()) return undefined;

      let body;
      let headers;
      try {
        body = /** @type {{ body?: unknown }} */ (result)?.body;
        headers = /** @type {{ headers?: unknown }} */ (result)?.headers;
      } catch {
        throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
      }
      if (!Buffer.isBuffer(body)) {
        throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
      }
      if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
      }

      /** @type {Record<string, string>} */
      const outHeaders = {
        'cache-control': 'no-store',
      };
      try {
        const h = /** @type {Record<string, unknown>} */ (headers);
        if (typeof h.taskId === 'string') outHeaders['x-linke-task-id'] = h.taskId;
        if (Number.isSafeInteger(h.fileIndex)) {
          outHeaders['x-linke-file-index'] = String(h.fileIndex);
        }
        if (Number.isSafeInteger(h.chunkIndex)) {
          outHeaders['x-linke-chunk-index'] = String(h.chunkIndex);
        }
        if (Number.isSafeInteger(h.chunkOffset) || h.chunkOffset === 0) {
          outHeaders['x-linke-chunk-offset'] = String(h.chunkOffset);
        }
        if (Number.isSafeInteger(h.chunkSize) || h.chunkSize === 0) {
          outHeaders['x-linke-chunk-size'] = String(h.chunkSize);
        }
        if (typeof h.chunkSha256 === 'string') {
          outHeaders['x-linke-chunk-sha256'] = h.chunkSha256;
        }
      } catch {
        throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
      }

      return gate.settleBinary(200, body, outHeaders);
    }

    if (route.kind === 'progress') {
      const body = await gate.race(readAgentBody(req, {
        maxBytes: MAX_AGENT_JSON_BODY_BYTES,
        isAborted: gate.isSettled,
      }));
      if (gate.isSettled()) return undefined;
      const progress = parseProgressBody(body);
      const result = await gate.race(restoreService.updateProgress({
        deviceId: authenticatedDeviceId,
        taskId: route.taskId,
        fileIndex: progress.fileIndex,
        chunkIndex: progress.chunkIndex,
        receivedBytes: progress.receivedBytes,
        signal,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, projectRestoreSuccess('progress', result));
    }

    if (route.kind === 'receipts') {
      const body = await gate.race(readAgentBody(req, {
        maxBytes: MAX_AGENT_JSON_BODY_BYTES,
        isAborted: gate.isSettled,
      }));
      if (gate.isSettled()) return undefined;
      const result = await gate.race(restoreService.acceptReceipt({
        deviceId: authenticatedDeviceId,
        taskId: route.taskId,
        receipt: body,
        signal,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, projectRestoreSuccess('receipts', result));
    }

    if (route.kind === 'cleanup') {
      const body = await gate.race(readAgentBody(req, {
        maxBytes: MAX_AGENT_JSON_BODY_BYTES,
        isAborted: gate.isSettled,
      }));
      if (gate.isSettled()) return undefined;
      const result = await gate.race(restoreService.acceptCleanup({
        deviceId: authenticatedDeviceId,
        taskId: route.taskId,
        cleanupReceipt: body,
        signal,
      }));
      if (gate.isSettled()) return undefined;
      return gate.settle(200, projectRestoreSuccess('cleanup', result));
    }

    return gate.settle(404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
  } catch (error) {
    if (gate.isSettled()) return undefined;
    return gate.settleError(error);
  }
}
