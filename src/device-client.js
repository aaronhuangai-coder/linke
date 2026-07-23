import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { resolve as pathResolve } from 'node:path';
import { DEVICE_PROTOCOL_VERSION } from './device-protocol.js';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from './error-codes.js';
import { openSafeRootRelativeRead } from './safe-data-files.js';
import {
  assertSafeManifestPath,
  projectCanonicalUploadManifest,
} from './upload-manifest.js';
import { UPLOAD_CHUNK_SIZE } from './upload-session-store.js';

/** Server uploadId / snapshotId UUID shape (lowercase). */
const UPLOAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MANIFEST_DIGEST_RE = /^[a-f0-9]{64}$/;
/** Create / chunk success may continue only for these non-terminal statuses. */
const CREATE_CONTINUABLE_STATUSES = new Set(['initialized', 'receiving', 'verifying']);
/** Status GET may return these session statuses. */
const STATUS_QUERY_STATUSES = new Set(['initialized', 'receiving', 'verifying', 'committed']);

/** Maximum accepted JSON response body size for pinned client requests (bytes). */
export const MAX_PINNED_JSON_RESPONSE_BYTES = 64 * 1024;

/** Maximum allowed request timeout for pinned client requests (ms). */
export const MAX_PINNED_REQUEST_TIMEOUT_MS = 300_000;

/** Contiguous upload chunk size (bytes); mirrors server CHUNK_SIZE. */
export const CLIENT_UPLOAD_CHUNK_SIZE = UPLOAD_CHUNK_SIZE;

/** Default client resume/retry budget for network and retryable HTTP errors. */
export const DEFAULT_UPLOAD_MAX_RESUME_ATTEMPTS = 8;

/** Bounded Retry-After seconds (design §7: 1–30). */
const RETRY_AFTER_MIN_SEC = 1;
const RETRY_AFTER_MAX_SEC = 30;

/** Default per-route client timeouts (ms), aligned with design §6.4. */
const CLIENT_CREATE_TIMEOUT_MS = 30_000;
const CLIENT_STATUS_TIMEOUT_MS = 15_000;
const CLIENT_CHUNK_TIMEOUT_MS = 120_000;
const CLIENT_FINALIZE_TIMEOUT_MS = 15_000;
const CLIENT_ABORT_TIMEOUT_MS = 15_000;

/**
 * Normalize a certificate SHA-256 fingerprint to lowercase 64 hex.
 * Accepts optional colon separators and mixed case.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeFingerprint(value) {
  const normalized = String(value || '').replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 400 });
  }
  return normalized;
}

/**
 * Safely serialize a request body to JSON string.
 * Any stringify failure maps to a fixed registered error without leaking structure.
 * @param {unknown} body
 * @returns {string}
 */
function serializeRequestBody(body) {
  let serialized;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  if (typeof serialized !== 'string') {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  return serialized;
}

/**
 * Validate timeoutMs as a positive finite integer within the hard upper bound.
 * Must run before any request/socket is created.
 * @param {unknown} timeoutMs
 * @returns {number}
 */
function normalizeTimeoutMs(timeoutMs) {
  if (!Number.isInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_PINNED_REQUEST_TIMEOUT_MS) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  return timeoutMs;
}

/**
 * True only for explicit HTTP success status codes 200–299.
 * @param {unknown} statusCode
 * @returns {boolean}
 */
function isSuccessStatus(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode <= 299;
}

/**
 * Parse and validate a safe HTTPS Agent URL.
 * Rejects credentials, query, hash, non-HTTPS, and unparseable input without echoing it.
 * @param {unknown} agentUrl
 * @returns {URL}
 */
function parseAgentUrl(agentUrl) {
  let url;
  try {
    url = new URL(String(agentUrl ?? ''));
  } catch {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_BIND_INVALID, { statusCode: 400 });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_BIND_INVALID, { statusCode: 400 });
  }
  if (!url.hostname) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_BIND_INVALID, { statusCode: 400 });
  }
  return url;
}

/**
 * Map non-success HTTP status to a LinkeError using only registered codes
 * and safe 400–599 status values.
 * @param {number} statusCode
 * @param {unknown} response
 * @returns {LinkeError}
 */
function errorFromHttpResponse(statusCode, response) {
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
    return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  let publicCode = ERROR_CODES.DEVICE_REQUEST_INVALID;
  if (response && typeof response === 'object' && 'error' in response) {
    try {
      publicCode = assertRegisteredErrorCode(
        /** @type {{ error?: unknown }} */ (response).error,
      );
    } catch {
      publicCode = ERROR_CODES.DEVICE_REQUEST_INVALID;
    }
  }
  return new LinkeError(publicCode, { statusCode });
}

/**
 * Transport-class failure (socket / timeout / disconnect).
 * Default LinkeError status 500 → resume-retryable for upload budget paths.
 * @returns {LinkeError}
 */
function requestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
}

/**
 * Alias for transport settle failures (socket error / request timeout).
 * @returns {LinkeError}
 */
function transportInvalidError() {
  return requestInvalidError();
}

/**
 * Local client / wire-shape / protocol-shape failure (not transport).
 * statusCode 400 so resume logic never treats it as a retryable network settle.
 * @returns {LinkeError}
 */
function localRequestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
}

/**
 * Local-only resume budget exhausted (HTTP N/A; never a server code).
 * @returns {LinkeError}
 */
function resumeExhaustedError() {
  return new LinkeError(ERROR_CODES.UPLOAD_RESUME_EXHAUSTED, {
    statusCode: null,
    retryable: false,
  });
}

/**
 * True for plain JSON objects only (not null, arrays, or scalars).
 * Must run before reading any response field.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainResponseObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse Retry-After header into bounded seconds 1..30, or null if absent/invalid.
 * @param {unknown} headers
 * @returns {number | null}
 */
function parseBoundedRetryAfterSec(headers) {
  if (!headers || typeof headers !== 'object') return null;
  let raw;
  try {
    raw = /** @type {Record<string, unknown>} */ (headers)['retry-after']
      ?? /** @type {Record<string, unknown>} */ (headers)['Retry-After'];
  } catch {
    return null;
  }
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  const seconds = Math.ceil(n);
  if (!Number.isInteger(seconds)) return null;
  return Math.min(RETRY_AFTER_MAX_SEC, Math.max(RETRY_AFTER_MIN_SEC, seconds));
}

/**
 * Map non-success HTTP status for pinned binary/upload clients.
 * 429: only exact device-rate-limited / upload-backpressure keep 429 + Retry-After.
 * 507: only exact upload-capacity-insufficient; never coerce other codes.
 * Unknown / wrong codes → fixed device-request-invalid (no retryAfterSec).
 * @param {number} statusCode
 * @param {unknown} response
 * @param {unknown} [headers]
 * @returns {LinkeError}
 */
function errorFromPinnedHttpResponse(statusCode, response, headers) {
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
    return localRequestInvalidError();
  }

  // 507 capacity: numeric 507 + exact wire code only (not WebDAV; no coerce).
  if (statusCode === 507) {
    if (
      isPlainResponseObject(response)
      && response.error === ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT
    ) {
      return new LinkeError(ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT, {
        statusCode: 507,
        retryable: false,
      });
    }
    // Wrong/unknown 507 body → non-retry wire-shape invalid.
    return localRequestInvalidError();
  }

  // 429 dual mapping: only the two registered codes; never guess rate-limited.
  if (statusCode === 429) {
    if (!isPlainResponseObject(response) || typeof response.error !== 'string') {
      return localRequestInvalidError();
    }
    if (
      response.error === ERROR_CODES.DEVICE_RATE_LIMITED
      || response.error === ERROR_CODES.UPLOAD_BACKPRESSURE
    ) {
      const err = new LinkeError(/** @type {string} */ (response.error), {
        statusCode: 429,
        retryable: true,
      });
      const retryAfterSec = parseBoundedRetryAfterSec(headers);
      if (retryAfterSec !== null) {
        err.retryAfterSec = retryAfterSec;
      }
      return err;
    }
    // Unknown or registered-but-wrong code on 429 → non-retry, no Retry-After.
    return localRequestInvalidError();
  }

  // Fail-closed: response must be a plain object with registered error when non-2xx.
  if (!isPlainResponseObject(response) || typeof response.error !== 'string') {
    return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode });
  }

  let publicCode = ERROR_CODES.DEVICE_REQUEST_INVALID;
  try {
    publicCode = assertRegisteredErrorCode(response.error);
  } catch {
    publicCode = ERROR_CODES.DEVICE_REQUEST_INVALID;
  }
  return new LinkeError(publicCode, { statusCode });
}

/**
 * Normalize optional AbortSignal; reject already-aborted without raw AbortError text.
 * @param {unknown} signal
 * @returns {AbortSignal | undefined}
 */
function normalizeAbortSignal(signal) {
  if (signal === undefined || signal === null) return undefined;
  if (typeof signal !== 'object' || typeof /** @type {{ aborted?: unknown }} */ (signal).aborted !== 'boolean') {
    throw requestInvalidError();
  }
  if (/** @type {AbortSignal} */ (signal).aborted) {
    throw requestInvalidError();
  }
  return /** @type {AbortSignal} */ (signal);
}

/**
 * Serialize body for pinned binary request: Buffer, UTF-8 string, or JSON value.
 * @param {unknown} body
 * @param {'buffer' | 'json' | 'none'} bodyMode
 * @returns {Buffer | null}
 */
function serializePinnedBody(body, bodyMode) {
  if (bodyMode === 'none' || body === undefined || body === null) {
    return null;
  }
  if (bodyMode === 'buffer') {
    if (!Buffer.isBuffer(body)) {
      throw requestInvalidError();
    }
    return body;
  }
  // json
  const serialized = serializeRequestBody(body);
  return Buffer.from(serialized, 'utf8');
}

/**
 * Validate protocolVersion as a finite integer for the mandatory wire header.
 * @param {unknown} protocolVersion
 * @returns {number}
 */
function normalizeProtocolVersionHeader(protocolVersion) {
  if (!Number.isInteger(protocolVersion)) {
    throw requestInvalidError();
  }
  return protocolVersion;
}

/**
 * Validate non-empty deviceId / token for mandatory upload auth triad (no echo).
 * @param {unknown} deviceId
 * @param {unknown} token
 */
function assertAuthTriadInputs(deviceId, token) {
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw requestInvalidError();
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
}

/**
 * Resolve snapshotRoot to an absolute directory path without echoing it.
 * @param {unknown} snapshotRoot
 * @returns {string}
 */
function normalizeSnapshotRoot(snapshotRoot) {
  if (typeof snapshotRoot !== 'string' || snapshotRoot.length === 0) {
    throw localRequestInvalidError();
  }
  try {
    const resolved = pathResolve(snapshotRoot);
    if (typeof resolved !== 'string' || resolved.length === 0) {
      throw localRequestInvalidError();
    }
    return resolved;
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    throw localRequestInvalidError();
  }
}

/**
 * Read a byte slice via production openSafeRootRelativeRead (ancestor lstat walk +
 * leaf O_NOFOLLOW/fstat). Failures never include path, errno, or stack text.
 * @param {string} rootAbs
 * @param {string} relPath
 * @param {number} offset
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
async function readRootRelativeSlice(rootAbs, relPath, offset, length) {
  let safeRel;
  try {
    safeRel = assertSafeManifestPath(relPath);
  } catch {
    throw localRequestInvalidError();
  }
  if (
    !Number.isSafeInteger(offset)
    || offset < 0
    || !Number.isSafeInteger(length)
    || length <= 0
  ) {
    throw localRequestInvalidError();
  }

  /** @type {{ handle: import('node:fs/promises').FileHandle, size: number } | undefined} */
  let opened;
  try {
    opened = await openSafeRootRelativeRead(rootAbs, safeRel);
  } catch {
    // SafeDataFileError / ENOENT / any system error → fixed local invalid (no path/errno).
    throw localRequestInvalidError();
  }

  const { handle, size } = opened;
  try {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw localRequestInvalidError();
    }
    if (offset + length > size) {
      throw localRequestInvalidError();
    }
    const buf = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(
        buf,
        filled,
        length - filled,
        offset + filled,
      );
      if (bytesRead === 0) {
        throw localRequestInvalidError();
      }
      filled += bytesRead;
    }
    return buf;
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    throw localRequestInvalidError();
  } finally {
    try {
      await handle.close();
    } catch {
      // ignore close failures
    }
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isServerUploadId(value) {
  return typeof value === 'string' && UPLOAD_ID_RE.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isManifestDigest(value) {
  return typeof value === 'string' && MANIFEST_DIGEST_RE.test(value);
}

/**
 * Strict create success gate: legal uploadId + exact identity + continuable status.
 * Failures are non-retryable wire-shape errors.
 * @param {unknown} response
 * @param {{ deviceId: string, snapshotId: string, manifestDigest: string }} expected
 * @returns {{
 *   uploadId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 *   deviceId: string,
 *   status: string,
 *   missingSummary?: unknown,
 * }}
 */
function assertCreateSuccess(response, expected) {
  if (!isPlainResponseObject(response)) {
    throw localRequestInvalidError();
  }
  if (!isServerUploadId(response.uploadId)) {
    throw localRequestInvalidError();
  }
  if (response.deviceId !== expected.deviceId) {
    throw localRequestInvalidError();
  }
  if (response.snapshotId !== expected.snapshotId || !isServerUploadId(response.snapshotId)) {
    throw localRequestInvalidError();
  }
  if (
    response.manifestDigest !== expected.manifestDigest
    || !isManifestDigest(response.manifestDigest)
  ) {
    throw localRequestInvalidError();
  }
  if (
    typeof response.status !== 'string'
    || !CREATE_CONTINUABLE_STATUSES.has(response.status)
  ) {
    throw localRequestInvalidError();
  }
  /** @type {{
   *   uploadId: string,
   *   snapshotId: string,
   *   manifestDigest: string,
   *   deviceId: string,
   *   status: string,
   *   missingSummary?: unknown,
   * }} */
  const out = {
    uploadId: /** @type {string} */ (response.uploadId),
    snapshotId: /** @type {string} */ (response.snapshotId),
    manifestDigest: /** @type {string} */ (response.manifestDigest),
    deviceId: /** @type {string} */ (response.deviceId),
    status: /** @type {string} */ (response.status),
  };
  if (Object.prototype.hasOwnProperty.call(response, 'missingSummary')) {
    out.missingSummary = response.missingSummary;
  }
  return out;
}

/**
 * Strict finalize success: exact identity + status=committed (no local fabricate).
 * Failures are non-retryable wire-shape errors.
 * @param {unknown} response
 * @param {{
 *   uploadId: string,
 *   deviceId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 * }} expected
 * @returns {{
 *   uploadId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 *   deviceId: string,
 *   status: 'committed',
 * }}
 */
function assertFinalizeSuccess(response, expected) {
  if (!isPlainResponseObject(response)) {
    throw localRequestInvalidError();
  }
  if (response.uploadId !== expected.uploadId || !isServerUploadId(response.uploadId)) {
    throw localRequestInvalidError();
  }
  if (response.deviceId !== expected.deviceId) {
    throw localRequestInvalidError();
  }
  if (response.snapshotId !== expected.snapshotId || !isServerUploadId(response.snapshotId)) {
    throw localRequestInvalidError();
  }
  if (
    response.manifestDigest !== expected.manifestDigest
    || !isManifestDigest(response.manifestDigest)
  ) {
    throw localRequestInvalidError();
  }
  if (response.status !== 'committed') {
    throw localRequestInvalidError();
  }
  return {
    uploadId: expected.uploadId,
    snapshotId: expected.snapshotId,
    manifestDigest: expected.manifestDigest,
    deviceId: expected.deviceId,
    status: 'committed',
  };
}

/**
 * Strict chunk 2xx ACK: exact identity + continuable status (no required acked field).
 * @param {unknown} response
 * @param {{
 *   uploadId: string,
 *   deviceId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 * }} expected
 */
function assertChunkAckSuccess(response, expected) {
  if (!isPlainResponseObject(response)) {
    throw localRequestInvalidError();
  }
  if (response.uploadId !== expected.uploadId || !isServerUploadId(response.uploadId)) {
    throw localRequestInvalidError();
  }
  if (response.deviceId !== expected.deviceId) {
    throw localRequestInvalidError();
  }
  if (response.snapshotId !== expected.snapshotId || !isServerUploadId(response.snapshotId)) {
    throw localRequestInvalidError();
  }
  if (
    response.manifestDigest !== expected.manifestDigest
    || !isManifestDigest(response.manifestDigest)
  ) {
    throw localRequestInvalidError();
  }
  if (
    typeof response.status !== 'string'
    || !CREATE_CONTINUABLE_STATUSES.has(response.status)
  ) {
    throw localRequestInvalidError();
  }
}

/**
 * Strict abort 2xx: exact uploadId + deviceId + status=aborted.
 * @param {unknown} response
 * @param {{ uploadId: string, deviceId: string }} expected
 * @returns {{ uploadId: string, deviceId: string, status: 'aborted' }}
 */
function assertAbortSuccess(response, expected) {
  if (!isPlainResponseObject(response)) {
    throw localRequestInvalidError();
  }
  if (response.uploadId !== expected.uploadId || !isServerUploadId(response.uploadId)) {
    throw localRequestInvalidError();
  }
  if (response.deviceId !== expected.deviceId) {
    throw localRequestInvalidError();
  }
  if (response.status !== 'aborted') {
    throw localRequestInvalidError();
  }
  return {
    uploadId: expected.uploadId,
    deviceId: expected.deviceId,
    status: 'aborted',
  };
}

/**
 * Apply server missingSummary onto the confirmed set.
 * Omitted (undefined) is allowed; present-but-hostile is non-retry fail-close.
 * When present: complete must be boolean; complete=true omits next and marks all
 * plan steps confirmed; complete=false requires next that exact-matches one plan step.
 *
 * @param {Set<string>} confirmed
 * @param {Array<{
 *   fileIndex: number,
 *   chunkIndex: number,
 *   offset: number,
 *   size: number,
 * }>} plan
 * @param {unknown} missingSummary
 */
function applyMissingSummaryProgress(confirmed, plan, missingSummary) {
  if (missingSummary === undefined) return;
  if (!isPlainResponseObject(missingSummary)) {
    throw localRequestInvalidError();
  }
  if (typeof missingSummary.complete !== 'boolean') {
    throw localRequestInvalidError();
  }

  if (missingSummary.complete === true) {
    if (Object.prototype.hasOwnProperty.call(missingSummary, 'next')
      && missingSummary.next !== undefined) {
      throw localRequestInvalidError();
    }
    for (const key of ['remainingFiles', 'remainingBytes', 'remainingChunks']) {
      if (!Object.prototype.hasOwnProperty.call(missingSummary, key)) continue;
      const v = /** @type {Record<string, unknown>} */ (missingSummary)[key];
      if (!Number.isSafeInteger(v) || /** @type {number} */ (v) !== 0) {
        throw localRequestInvalidError();
      }
    }
    confirmed.clear();
    for (const step of plan) {
      confirmed.add(`${step.fileIndex}:${step.chunkIndex}`);
    }
    return;
  }

  // complete === false
  if (!isPlainResponseObject(missingSummary.next)) {
    throw localRequestInvalidError();
  }
  const next = /** @type {Record<string, unknown>} */ (missingSummary.next);
  if (!Number.isSafeInteger(next.fileIndex) || /** @type {number} */ (next.fileIndex) < 0) {
    throw localRequestInvalidError();
  }
  if (!Number.isSafeInteger(next.chunkIndex) || /** @type {number} */ (next.chunkIndex) < 0) {
    throw localRequestInvalidError();
  }
  if (!Number.isSafeInteger(next.offset) || /** @type {number} */ (next.offset) < 0) {
    throw localRequestInvalidError();
  }
  if (!Number.isSafeInteger(next.size) || /** @type {number} */ (next.size) <= 0) {
    throw localRequestInvalidError();
  }
  if (
    Object.prototype.hasOwnProperty.call(next, 'complete')
    && next.complete !== false
  ) {
    throw localRequestInvalidError();
  }

  const nextFile = /** @type {number} */ (next.fileIndex);
  const nextChunk = /** @type {number} */ (next.chunkIndex);
  const nextOffset = /** @type {number} */ (next.offset);
  const nextSize = /** @type {number} */ (next.size);

  const match = plan.find(
    (step) => step.fileIndex === nextFile
      && step.chunkIndex === nextChunk
      && step.offset === nextOffset
      && step.size === nextSize,
  );
  if (!match) {
    throw localRequestInvalidError();
  }

  confirmed.clear();
  for (const step of plan) {
    if (
      step.fileIndex < nextFile
      || (step.fileIndex === nextFile && step.chunkIndex < nextChunk)
    ) {
      confirmed.add(`${step.fileIndex}:${step.chunkIndex}`);
    }
  }
}

/**
 * Strict status GET success for resume realignment.
 * @param {unknown} response
 * @param {{
 *   uploadId: string,
 *   deviceId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 * }} expected
 * @param {Array<{
 *   fileIndex: number,
 *   chunkIndex: number,
 *   offset: number,
 *   size: number,
 * }>} plan
 * @param {Set<string>} confirmed
 */
function assertStatusSuccess(response, expected, plan, confirmed) {
  if (!isPlainResponseObject(response)) {
    throw localRequestInvalidError();
  }
  if (response.uploadId !== expected.uploadId || !isServerUploadId(response.uploadId)) {
    throw localRequestInvalidError();
  }
  if (response.deviceId !== expected.deviceId) {
    throw localRequestInvalidError();
  }
  if (response.snapshotId !== expected.snapshotId || !isServerUploadId(response.snapshotId)) {
    throw localRequestInvalidError();
  }
  if (
    response.manifestDigest !== expected.manifestDigest
    || !isManifestDigest(response.manifestDigest)
  ) {
    throw localRequestInvalidError();
  }
  if (
    typeof response.status !== 'string'
    || !STATUS_QUERY_STATUSES.has(response.status)
  ) {
    throw localRequestInvalidError();
  }
  if (Object.prototype.hasOwnProperty.call(response, 'missingSummary')) {
    applyMissingSummaryProgress(confirmed, plan, response.missingSummary);
  }
}

/**
 * Build contiguous chunk plan from projected integrity entries (skip 0-byte files).
 * @param {{ path: string, size: number, sha256: string }[]} entries
 * @returns {Array<{
 *   fileIndex: number,
 *   path: string,
 *   fileSize: number,
 *   fileSha256: string,
 *   chunkIndex: number,
 *   offset: number,
 *   size: number,
 * }>}
 */
function buildChunkPlan(entries) {
  /** @type {Array<{
   *   fileIndex: number,
   *   path: string,
   *   fileSize: number,
   *   fileSha256: string,
   *   chunkIndex: number,
   *   offset: number,
   *   size: number,
   * }>} */
  const plan = [];
  for (let fileIndex = 0; fileIndex < entries.length; fileIndex += 1) {
    const entry = entries[fileIndex];
    const fileSize = entry.size;
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      throw requestInvalidError();
    }
    if (fileSize === 0) {
      // 0-byte files: never emit a chunk.
      continue;
    }
    const totalChunks = Math.ceil(fileSize / CLIENT_UPLOAD_CHUNK_SIZE);
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const offset = chunkIndex * CLIENT_UPLOAD_CHUNK_SIZE;
      const size = chunkIndex < totalChunks - 1
        ? CLIENT_UPLOAD_CHUNK_SIZE
        : fileSize - offset;
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw requestInvalidError();
      }
      plan.push({
        fileIndex,
        path: entry.path,
        fileSize,
        fileSha256: entry.sha256,
        chunkIndex,
        offset,
        size,
      });
    }
  }
  return plan;
}

/**
 * Whether a thrown value should burn resume budget and retry after status realign.
 * @param {unknown} error
 * @returns {boolean}
 */
function isUploadResumeRetryable(error) {
  if (!(error instanceof LinkeError)) return false;
  if (error.code === ERROR_CODES.DEVICE_RATE_LIMITED) return true;
  if (error.code === ERROR_CODES.UPLOAD_BACKPRESSURE) return true;
  if (error.code === ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER) return true;
  // Transport settle uses device-request-invalid with default status 500.
  // Server-mapped client errors carry 4xx and must not auto-resume.
  if (error.code === ERROR_CODES.DEVICE_REQUEST_INVALID) {
    const sc = error.statusCode;
    if (Number.isInteger(sc) && sc >= 400 && sc < 500) return false;
    return true;
  }
  return false;
}

/**
 * Bounded delay helper; never throws system text outward.
 * @param {number} ms
 * @param {(ms: number) => Promise<void>} delayFn
 * @param {AbortSignal | undefined} signal
 */
async function boundedDelay(ms, delayFn, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const safeMs = Math.min(RETRY_AFTER_MAX_SEC * 1000, Math.max(0, Math.ceil(ms)));
  if (signal?.aborted) throw localRequestInvalidError();
  try {
    await delayFn(safeMs);
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    throw localRequestInvalidError();
  }
  if (signal?.aborted) throw localRequestInvalidError();
}

/**
 * Default delay using setTimeout (tests inject a no-op).
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultDelay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Ensure credentialStore exposes the required methods before Keychain/network use.
 * @param {unknown} credentialStore
 * @param {string[]} methodNames
 */
function assertCredentialStore(credentialStore, methodNames) {
  if (!credentialStore || typeof credentialStore !== 'object') {
    throw requestInvalidError();
  }
  for (const name of methodNames) {
    if (typeof /** @type {Record<string, unknown>} */ (credentialStore)[name] !== 'function') {
      throw requestInvalidError();
    }
  }
}

/**
 * Keychain-backed endpoint token store; item names contain no host or token material.
 * Account/item id is `device-token.` + SHA-256(agentUrl + NUL + deviceId) hex prefix (32).
 */
export class DeviceCredentialStore {
  /**
   * @param {{ keychain: { get: Function, set: Function, delete?: Function } }} options
   */
  constructor({ keychain }) {
    if (!keychain) throw new Error('keychain is required');
    this.keychain = keychain;
  }

  /**
   * Derive the Keychain item id for an endpoint token.
   * @param {string} agentUrl
   * @param {string} deviceId
   * @returns {string}
   */
  itemId(agentUrl, deviceId) {
    const id = createHash('sha256')
      .update(`${agentUrl}\0${deviceId}`)
      .digest('hex')
      .slice(0, 32);
    return `device-token.${id}`;
  }

  /**
   * Read the stored device token for agentUrl + deviceId.
   * @param {string} agentUrl
   * @param {string} deviceId
   * @returns {Promise<string>}
   */
  getToken(agentUrl, deviceId) {
    return this.keychain.get(this.itemId(agentUrl, deviceId));
  }

  /**
   * Upsert the device token for agentUrl + deviceId.
   * @param {string} agentUrl
   * @param {string} deviceId
   * @param {string} token
   * @returns {Promise<void>}
   */
  setToken(agentUrl, deviceId, token) {
    return this.keychain.set(this.itemId(agentUrl, deviceId), token);
  }
}

/**
 * POST JSON only after the peer certificate exactly matches the approved SHA-256 pin.
 * `rejectUnauthorized: false` is paired with mandatory certificate pinning; the request
 * body is never written until the pin succeeds on `secureConnect`.
 * @param {{
 *   agentUrl: string,
 *   path: string,
 *   tlsFingerprint: string,
 *   body: unknown,
 *   token?: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<unknown>}
 */
export function requestPinnedJson({
  agentUrl,
  path,
  tlsFingerprint,
  body,
  token,
  timeoutMs = 10_000,
}) {
  // Validate URL, fingerprint, body, and timeout before opening any socket.
  const url = parseAgentUrl(agentUrl);
  const expected = Buffer.from(normalizeFingerprint(tlsFingerprint), 'hex');
  const serialized = serializeRequestBody(body);
  const safeTimeoutMs = normalizeTimeoutMs(timeoutMs);
  return new Promise((resolve, reject) => {
    let pinned = false;
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const failClosed = (error) => {
      settle(() => reject(error instanceof LinkeError ? error : requestInvalidError()));
    };

    let req;
    try {
      req = httpsRequest({
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path,
        method: 'POST',
        agent: false,
        rejectUnauthorized: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(serialized),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }, (res) => {
        const chunks = [];
        let totalBytes = 0;
        let oversized = false;
        res.on('data', (chunk) => {
          if (oversized) return;
          const buffer = Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > MAX_PINNED_JSON_RESPONSE_BYTES) {
            oversized = true;
            chunks.length = 0;
            res.destroy();
            failClosed(requestInvalidError());
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => {
          if (oversized) return;
          if (!pinned) {
            failClosed(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
            return;
          }
          let response;
          try {
            response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            failClosed(requestInvalidError());
            return;
          }
          if (!isSuccessStatus(res.statusCode)) {
            failClosed(errorFromHttpResponse(res.statusCode, response));
            return;
          }
          settle(() => resolve(response));
        });
        res.on('error', () => failClosed(requestInvalidError()));
      });
    } catch {
      failClosed(requestInvalidError());
      return;
    }

    // Install error listener before setTimeout/socket so any subsequent emit is handled.
    req.once('error', (error) => failClosed(error));
    try {
      req.setTimeout(safeTimeoutMs, () => {
        req.destroy(requestInvalidError());
      });
      req.once('socket', (socket) => {
        socket.once('secureConnect', () => {
          try {
            const raw = socket.getPeerCertificate(true)?.raw;
            const actual = raw ? createHash('sha256').update(raw).digest() : Buffer.alloc(0);
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
              req.destroy(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
              return;
            }
            pinned = true;
            req.end(serialized);
          } catch {
            req.destroy(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
          }
        });
      });
    } catch {
      try {
        req.destroy(requestInvalidError());
      } catch {
        // ignore destroy failures; failClosed still settles the promise
      }
      failClosed(requestInvalidError());
    }
  });
}

/**
 * Enroll a device over a certificate-pinned Agent URL.
 * Writes the returned token to Keychain only after full response validation.
 * The return value never includes enrollment codes or device tokens.
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   enrollmentCode: string,
 *   credentialStore: { setToken: Function },
 * }} options
 * @returns {Promise<{ deviceId: string, enrolled: true, protocolVersion: number }>}
 */
export async function enrollDevice({
  agentUrl,
  tlsFingerprint,
  deviceId,
  enrollmentCode,
  credentialStore,
}) {
  assertCredentialStore(credentialStore, ['setToken']);
  const response = await requestPinnedJson({
    agentUrl,
    path: '/agent/enroll',
    tlsFingerprint,
    body: {
      deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      enrollmentCode,
    },
  });
  if (!isPlainResponseObject(response)
    || response.deviceId !== deviceId
    || response.protocolVersion !== DEVICE_PROTOCOL_VERSION
    || typeof response.deviceToken !== 'string'
    || response.deviceToken.length < 32) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  await credentialStore.setToken(agentUrl, deviceId, response.deviceToken);
  return {
    deviceId,
    enrolled: true,
    protocolVersion: /** @type {number} */ (response.protocolVersion),
  };
}

/**
 * Send an authenticated device heartbeat using the Keychain-stored token.
 * Missing or empty tokens fail closed before any network write.
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   hostname?: string,
 *   credentialStore: { getToken: Function },
 * }} options
 * @returns {Promise<{ deviceId: string, accepted: true }>}
 */
export async function heartbeatDevice({
  agentUrl,
  tlsFingerprint,
  deviceId,
  hostname,
  credentialStore,
}) {
  assertCredentialStore(credentialStore, ['getToken']);
  const token = await credentialStore.getToken(agentUrl, deviceId);
  if (typeof token !== 'string' || token.length === 0) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  const response = await requestPinnedJson({
    agentUrl,
    path: '/agent/heartbeat',
    tlsFingerprint,
    token,
    body: {
      deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      hostname,
    },
  });
  if (!isPlainResponseObject(response)
    || response.deviceId !== deviceId
    || response.accepted !== true) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  return { deviceId, accepted: true };
}

/**
 * Strictly validate a token-rotation confirm response shape.
 * @param {unknown} confirmed
 * @param {string} deviceId
 */
function assertRotationConfirmed(confirmed, deviceId) {
  if (!isPlainResponseObject(confirmed)
    || confirmed.deviceId !== deviceId
    || confirmed.rotated !== true) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
}

/**
 * Confirm rotation using a candidate token (pending or just-issued pending).
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   token: string,
 * }} options
 * @returns {Promise<{ deviceId: string, rotated: true }>}
 */
async function confirmDeviceTokenRotation({
  agentUrl,
  tlsFingerprint,
  deviceId,
  token,
}) {
  const confirmed = await requestPinnedJson({
    agentUrl,
    path: '/agent/token/rotate/confirm',
    tlsFingerprint,
    token,
    body: {
      deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
    },
  });
  assertRotationConfirmed(confirmed, deviceId);
  return { deviceId, rotated: true };
}

/**
 * Rotate a device token: begin with current token, store pending, confirm with pending.
 * Begin failure keeps the old token; Keychain write failure never confirms;
 * confirm failure retains the pending token for the server retry window.
 * If begin returns device-token-invalid, treat the Keychain token as a possible
 * prior pending and retry confirm once (recovery path).
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   credentialStore: { getToken: Function, setToken: Function },
 * }} options
 * @returns {Promise<{ deviceId: string, rotated: true }>}
 */
export async function rotateDeviceToken({
  agentUrl,
  tlsFingerprint,
  deviceId,
  credentialStore,
}) {
  assertCredentialStore(credentialStore, ['getToken', 'setToken']);
  const currentToken = await credentialStore.getToken(agentUrl, deviceId);
  if (typeof currentToken !== 'string' || currentToken.length === 0) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }

  let pending;
  try {
    pending = await requestPinnedJson({
      agentUrl,
      path: '/agent/token/rotate',
      tlsFingerprint,
      token: currentToken,
      body: {
        deviceId,
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      },
    });
  } catch (error) {
    // Begin only accepts the current/old token. If Keychain still holds a prior
    // pending token after a failed confirm, begin returns device-token-invalid —
    // recover by confirming with that same Keychain token inside the retry window.
    if (error instanceof LinkeError && error.code === ERROR_CODES.DEVICE_TOKEN_INVALID) {
      return confirmDeviceTokenRotation({
        agentUrl,
        tlsFingerprint,
        deviceId,
        token: currentToken,
      });
    }
    throw error;
  }

  if (!isPlainResponseObject(pending)
    || pending.deviceId !== deviceId
    || typeof pending.deviceToken !== 'string'
    || pending.deviceToken.length < 32) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  await credentialStore.setToken(agentUrl, deviceId, pending.deviceToken);
  return confirmDeviceTokenRotation({
    agentUrl,
    tlsFingerprint,
    deviceId,
    token: /** @type {string} */ (pending.deviceToken),
  });
}

/**
 * Certificate-pinned HTTPS request with mandatory upload auth triad headers.
 * Supports GET (no body) and POST with binary Buffer or JSON body.
 * Never writes the request body until the peer certificate pin succeeds.
 * Response JSON is bounded; the promise single-settles; AbortSignal aborts
 * without leaking raw system / AbortError text.
 *
 * Mandatory headers (exact-one, client-set once):
 * - Authorization: Bearer &lt;token&gt;
 * - X-Linke-Device-Id
 * - X-Linke-Protocol-Version
 *
 * @param {{
 *   agentUrl: string,
 *   path: string,
 *   tlsFingerprint: string,
 *   method?: 'GET' | 'POST',
 *   token: string,
 *   deviceId: string,
 *   protocolVersion?: number,
 *   body?: unknown,
 *   bodyMode?: 'buffer' | 'json' | 'none',
 *   contentType?: string,
 *   extraHeaders?: Record<string, string>,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   maxResponseBytes?: number,
 * }} options
 * @returns {Promise<unknown>}
 */
export function requestPinnedBinary({
  agentUrl,
  path,
  tlsFingerprint,
  method = 'POST',
  token,
  deviceId,
  protocolVersion = DEVICE_PROTOCOL_VERSION,
  body = null,
  bodyMode = 'none',
  contentType,
  extraHeaders,
  timeoutMs = 10_000,
  signal,
  maxResponseBytes = MAX_PINNED_JSON_RESPONSE_BYTES,
}) {
  const url = parseAgentUrl(agentUrl);
  const expected = Buffer.from(normalizeFingerprint(tlsFingerprint), 'hex');
  const safeTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const safeProtocol = normalizeProtocolVersionHeader(protocolVersion);
  assertAuthTriadInputs(deviceId, token);

  if (method !== 'GET' && method !== 'POST') {
    throw requestInvalidError();
  }
  if (bodyMode !== 'buffer' && bodyMode !== 'json' && bodyMode !== 'none') {
    throw requestInvalidError();
  }
  if (typeof path !== 'string' || path.length === 0 || !path.startsWith('/')) {
    throw requestInvalidError();
  }
  if (
    !Number.isInteger(maxResponseBytes)
    || maxResponseBytes < 1
    || maxResponseBytes > MAX_PINNED_JSON_RESPONSE_BYTES * 16
  ) {
    throw requestInvalidError();
  }

  const bodyBuf = method === 'GET'
    ? null
    : serializePinnedBody(body, bodyMode === 'none' && body != null ? 'json' : bodyMode);

  const abortSignal = normalizeAbortSignal(signal);

  /** @type {Record<string, string>} */
  const headers = {
    authorization: `Bearer ${token}`,
    'x-linke-device-id': deviceId,
    'x-linke-protocol-version': String(safeProtocol),
  };

  if (extraHeaders !== undefined && extraHeaders !== null) {
    if (typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)) {
      throw requestInvalidError();
    }
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (typeof key !== 'string' || typeof value !== 'string') {
        throw requestInvalidError();
      }
      const lower = key.toLowerCase();
      if (
        lower === 'authorization'
        || lower === 'x-linke-device-id'
        || lower === 'x-linke-protocol-version'
        || lower === 'content-length'
      ) {
        // Never allow override of mandatory triad or computed content-length.
        throw requestInvalidError();
      }
      headers[lower] = value;
    }
  }

  if (bodyBuf) {
    headers['content-length'] = String(bodyBuf.length);
    if (typeof contentType === 'string' && contentType.length > 0) {
      headers['content-type'] = contentType;
    } else if (bodyMode === 'json') {
      headers['content-type'] = 'application/json';
    } else {
      headers['content-type'] = 'application/octet-stream';
    }
  }

  return new Promise((resolve, reject) => {
    let pinned = false;
    let settled = false;
    /** @type {(() => void) | null} */
    let removeAbortListener = null;

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (removeAbortListener) {
        try {
          removeAbortListener();
        } catch {
          // ignore
        }
        removeAbortListener = null;
      }
      fn();
    };
    const failClosed = (error) => {
      settle(() => reject(error instanceof LinkeError ? error : requestInvalidError()));
    };

    /** @type {import('node:http').ClientRequest | undefined} */
    let req;
    try {
      req = httpsRequest({
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path,
        method,
        agent: false,
        rejectUnauthorized: false,
        headers,
      }, (res) => {
        const chunks = [];
        let totalBytes = 0;
        let oversized = false;
        res.on('data', (chunk) => {
          if (oversized || settled) return;
          const buffer = Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > maxResponseBytes) {
            oversized = true;
            chunks.length = 0;
            res.destroy();
            // Wire-shape (oversized) is non-retryable protocol invalid.
            failClosed(localRequestInvalidError());
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => {
          if (oversized || settled) return;
          if (!pinned) {
            failClosed(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
            return;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let response;
          try {
            if (text.length === 0) {
              // Empty body on 2xx is wire-shape invalid (upload routes always return JSON).
              if (isSuccessStatus(res.statusCode)) {
                failClosed(localRequestInvalidError());
                return;
              }
              // Empty non-2xx → treat as empty object for error mapper (still fail-closed).
              response = {};
            } else {
              response = JSON.parse(text);
            }
          } catch {
            // Malformed JSON: 2xx wire-shape invalid; non-2xx also non-retry shape fault.
            failClosed(localRequestInvalidError());
            return;
          }
          if (!isSuccessStatus(res.statusCode)) {
            failClosed(errorFromPinnedHttpResponse(
              /** @type {number} */ (res.statusCode),
              response,
              res.headers,
            ));
            return;
          }
          // 2xx must be plain JSON objects (array/scalar → non-retry wire-shape).
          if (!isPlainResponseObject(response)) {
            failClosed(localRequestInvalidError());
            return;
          }
          settle(() => resolve(response));
        });
        // Response stream socket errors are transport-class.
        res.on('error', () => failClosed(transportInvalidError()));
      });
    } catch {
      failClosed(transportInvalidError());
      return;
    }

    // Preserve LinkeError from pin/timeout destroy; never leak raw system text.
    // Non-LinkeError request errors (ECONNRESET etc.) are transport-retryable.
    req.once('error', (error) => {
      failClosed(error instanceof LinkeError ? error : transportInvalidError());
    });

    if (abortSignal) {
      const onAbort = () => {
        try {
          req.destroy(localRequestInvalidError());
        } catch {
          // ignore
        }
        // Caller AbortSignal is not a transport resume case.
        failClosed(localRequestInvalidError());
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => {
        try {
          abortSignal.removeEventListener('abort', onAbort);
        } catch {
          // ignore
        }
      };
    }

    try {
      req.setTimeout(safeTimeoutMs, () => {
        // Request timeout is transport-class (resume may retry).
        req.destroy(transportInvalidError());
      });
      req.once('socket', (socket) => {
        socket.once('secureConnect', () => {
          try {
            const raw = socket.getPeerCertificate(true)?.raw;
            const actual = raw ? createHash('sha256').update(raw).digest() : Buffer.alloc(0);
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
              req.destroy(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
              return;
            }
            pinned = true;
            // Body is written only after pin success.
            if (bodyBuf) {
              req.end(bodyBuf);
            } else {
              req.end();
            }
          } catch {
            req.destroy(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
          }
        });
      });
    } catch {
      try {
        req.destroy(transportInvalidError());
      } catch {
        // ignore
      }
      failClosed(transportInvalidError());
    }
  });
}

/** Default total timeout for pinned streaming download (ms). */
const DOWNLOAD_DEFAULT_TIMEOUT_MS = 120_000;
/** Default idle timeout for pinned streaming download (ms); reset only on nonempty data. */
const DOWNLOAD_DEFAULT_IDLE_TIMEOUT_MS = 15_000;
/** Header name for chunk digest (lowercase). */
const CHUNK_SHA_HEADER = 'x-linke-chunk-sha256';
const SHA256_HEX64_RE = /^[a-f0-9]{64}$/;

/**
 * Restore-integrity fail-close (known-length short/over/mismatch). Non-retry, HTTP 422.
 * @returns {LinkeError}
 */
function restoreIntegrityError() {
  return new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED, {
    statusCode: 422,
    retryable: false,
  });
}

/**
 * Transient download interrupt (disconnect / idle / total timeout before integrity gate).
 * @returns {LinkeError}
 */
function restoreInterruptedError() {
  return new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
    statusCode: null,
    retryable: true,
  });
}

/**
 * Map non-2xx JSON error body for pinned download (429 dual codes include restore-backpressure).
 * Never attaches body/token/path text to the error.
 * @param {number} statusCode
 * @param {unknown} response
 * @param {unknown} [headers]
 * @returns {LinkeError}
 */
function errorFromDownloadHttpResponse(statusCode, response, headers) {
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
    return localRequestInvalidError();
  }

  if (statusCode === 507) {
    if (
      isPlainResponseObject(response)
      && response.error === ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT
    ) {
      return new LinkeError(ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT, {
        statusCode: 507,
        retryable: false,
      });
    }
    return localRequestInvalidError();
  }

  if (statusCode === 429) {
    if (!isPlainResponseObject(response) || typeof response.error !== 'string') {
      return localRequestInvalidError();
    }
    if (
      response.error === ERROR_CODES.DEVICE_RATE_LIMITED
      || response.error === ERROR_CODES.RESTORE_BACKPRESSURE
    ) {
      const err = new LinkeError(/** @type {string} */ (response.error), {
        statusCode: 429,
        retryable: true,
      });
      const retryAfterSec = parseBoundedRetryAfterSec(headers);
      if (retryAfterSec !== null) {
        err.retryAfterSec = retryAfterSec;
      }
      return err;
    }
    return localRequestInvalidError();
  }

  if (!isPlainResponseObject(response) || typeof response.error !== 'string') {
    return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode });
  }

  let publicCode = ERROR_CODES.DEVICE_REQUEST_INVALID;
  try {
    publicCode = assertRegisteredErrorCode(response.error);
  } catch {
    publicCode = ERROR_CODES.DEVICE_REQUEST_INVALID;
  }
  return new LinkeError(publicCode, { statusCode });
}

/**
 * Count case-insensitive header name occurrences in Node rawHeaders.
 * @param {string[] | undefined} rawHeaders
 * @param {string} nameLower
 * @returns {number}
 */
function countRawHeaderName(rawHeaders, nameLower) {
  if (!Array.isArray(rawHeaders)) return 0;
  let n = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === nameLower) n += 1;
  }
  return n;
}

/**
 * Read first matching header value from rawHeaders (case-insensitive name).
 * @param {string[] | undefined} rawHeaders
 * @param {string} nameLower
 * @returns {string | null}
 */
function firstRawHeaderValue(rawHeaders, nameLower) {
  if (!Array.isArray(rawHeaders)) return null;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === nameLower) {
      return String(rawHeaders[i + 1] ?? '');
    }
  }
  return null;
}

/**
 * Normalize idle timeout: positive integer within hard upper bound.
 * @param {unknown} idleTimeoutMs
 * @returns {number}
 */
function normalizeIdleTimeoutMs(idleTimeoutMs) {
  if (!Number.isInteger(idleTimeoutMs)
    || idleTimeoutMs < 1
    || idleTimeoutMs > MAX_PINNED_REQUEST_TIMEOUT_MS) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  return idleTimeoutMs;
}

/**
 * Certificate-pinned HTTPS GET streaming download for G0c restore chunks.
 * Pin succeeds before any body is accepted or onChunk is called.
 * Does not replace {@link requestPinnedBinary} (bounded JSON helper).
 *
 * C7 contract clarification (files[] frozen shape has whole-file sha only, no
 * per-chunk digest): `expectedSha256` is optional.
 * - undefined: multi-chunk without a priori per-chunk digest; still requires
 *   exact-one `X-Linke-Chunk-Sha256` (lower hex64) and body SHA === header.
 * - provided string: header === expectedSha256 AND body SHA === header (four-way
 *   with expectedLength/Content-Length for single-chunk whole-file sha).
 * - null / bad format: fail-close before socket (DEVICE_REQUEST_INVALID).
 * Returned `sha256` is always the verified header/body digest.
 *
 * @param {{
 *   agentUrl: string,
 *   path: string,
 *   tlsFingerprint: string,
 *   token: string,
 *   deviceId: string,
 *   protocolVersion?: number,
 *   expectedLength: number,
 *   expectedSha256?: string,
 *   onChunk: (chunk: Buffer) => void | Promise<void>,
 *   timeoutMs?: number,
 *   idleTimeoutMs?: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ bytesReceived: number, sha256: string }>}
 */
export function requestPinnedDownload({
  agentUrl,
  path,
  tlsFingerprint,
  token,
  deviceId,
  protocolVersion = DEVICE_PROTOCOL_VERSION,
  expectedLength,
  expectedSha256,
  onChunk,
  timeoutMs = DOWNLOAD_DEFAULT_TIMEOUT_MS,
  idleTimeoutMs = DOWNLOAD_DEFAULT_IDLE_TIMEOUT_MS,
  signal,
}) {
  // ---- fail-close before any socket ----
  const url = parseAgentUrl(agentUrl);
  const expectedPin = Buffer.from(normalizeFingerprint(tlsFingerprint), 'hex');
  const safeTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const safeIdleMs = normalizeIdleTimeoutMs(idleTimeoutMs);
  const safeProtocol = normalizeProtocolVersionHeader(protocolVersion);
  assertAuthTriadInputs(deviceId, token);

  if (typeof path !== 'string' || path.length === 0 || !path.startsWith('/')) {
    throw requestInvalidError();
  }
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
    throw requestInvalidError();
  }
  // expectedSha256 optional (C7 multi-chunk). null/non-hex still fail before socket.
  const hasExpectedSha = expectedSha256 !== undefined;
  if (hasExpectedSha) {
    if (typeof expectedSha256 !== 'string' || !SHA256_HEX64_RE.test(expectedSha256)) {
      throw requestInvalidError();
    }
  }
  if (typeof onChunk !== 'function') {
    throw requestInvalidError();
  }

  const abortSignal = normalizeAbortSignal(signal);

  /** @type {Record<string, string>} */
  const headers = {
    authorization: `Bearer ${token}`,
    'x-linke-device-id': deviceId,
    'x-linke-protocol-version': String(safeProtocol),
  };

  return new Promise((resolve, reject) => {
    let pinned = false;
    let settled = false;
    /** @type {(() => void) | null} */
    let removeAbortListener = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let totalTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let idleTimer = null;
    /** @type {import('node:http').ClientRequest | undefined} */
    let req;
    /** @type {import('node:http').IncomingMessage | undefined} */
    let activeRes;
    let bytesReceived = 0;
    const hash = createHash('sha256');
    let headersAccepted = false;
    let knownLengthIntegrity = false;
    /** Verified exact-one X-Linke-Chunk-Sha256 after header accept (lower hex64). */
    let headerSha256 = /** @type {string | null} */ (null);
    let delivering = false;
    let deliveryFailed = false;
    /** @type {Buffer[]} */
    const pendingChunks = [];
    let endSeen = false;

    const clearTimers = () => {
      if (totalTimer !== null) {
        clearTimeout(totalTimer);
        totalTimer = null;
      }
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (removeAbortListener) {
        try {
          removeAbortListener();
        } catch {
          // ignore
        }
        removeAbortListener = null;
      }
      fn();
    };

    const failClosed = (error) => {
      settle(() => {
        try {
          if (activeRes) {
            activeRes.removeAllListeners('data');
            activeRes.removeAllListeners('end');
            activeRes.removeAllListeners('error');
            activeRes.removeAllListeners('aborted');
            activeRes.removeAllListeners('close');
            try {
              activeRes.destroy();
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
        try {
          if (req) req.destroy();
        } catch {
          // ignore
        }
        reject(error instanceof LinkeError ? error : requestInvalidError());
      });
    };

    const resetIdleTimer = () => {
      if (settled) return;
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      // Idle / total timeouts are always RESTORE_INTERRUPTED (design §13.4).
      // Known-length short body on connection end → integrity (separate paths).
      idleTimer = setTimeout(() => {
        failClosed(restoreInterruptedError());
      }, safeIdleMs);
    };

    /**
     * Serial onChunk backpressure: pause socket while awaiting async onChunk.
     * @returns {Promise<void>}
     */
    const pumpDeliveries = async () => {
      if (delivering || settled || deliveryFailed) return;
      delivering = true;
      try {
        while (pendingChunks.length > 0 && !settled && !deliveryFailed) {
          const chunk = /** @type {Buffer} */ (pendingChunks.shift());
          try {
            await onChunk(chunk);
          } catch {
            deliveryFailed = true;
            failClosed(localRequestInvalidError());
            return;
          }
        }
        if (settled || deliveryFailed) return;
        if (endSeen && pendingChunks.length === 0) {
          if (bytesReceived !== expectedLength) {
            failClosed(restoreIntegrityError());
            return;
          }
          if (typeof headerSha256 !== 'string' || !SHA256_HEX64_RE.test(headerSha256)) {
            failClosed(restoreIntegrityError());
            return;
          }
          const actualSha = hash.digest('hex');
          // Body must equal exact-one header digest (always).
          if (actualSha !== headerSha256) {
            failClosed(restoreIntegrityError());
            return;
          }
          // When a priori expectedSha256 provided, also require header/body === expected.
          if (hasExpectedSha && actualSha !== expectedSha256) {
            failClosed(restoreIntegrityError());
            return;
          }
          settle(() => resolve({ bytesReceived, sha256: actualSha }));
          return;
        }
        try {
          if (activeRes && typeof activeRes.resume === 'function') {
            activeRes.resume();
          }
        } catch {
          // ignore
        }
      } finally {
        delivering = false;
        if (!settled && !deliveryFailed && pendingChunks.length > 0) {
          void pumpDeliveries();
        }
      }
    };

    try {
      req = httpsRequest({
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path,
        method: 'GET',
        agent: false,
        rejectUnauthorized: false,
        headers,
      }, (res) => {
        if (settled) return;
        activeRes = res;

        if (!pinned) {
          failClosed(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
          return;
        }

        const status = res.statusCode;
        const raw = res.rawHeaders;

        if (!isSuccessStatus(status)) {
          const errChunks = [];
          let errBytes = 0;
          let oversized = false;
          res.on('data', (chunk) => {
            if (settled || oversized) return;
            const buf = Buffer.from(chunk);
            errBytes += buf.length;
            if (errBytes > MAX_PINNED_JSON_RESPONSE_BYTES) {
              oversized = true;
              errChunks.length = 0;
              res.destroy();
              failClosed(localRequestInvalidError());
              return;
            }
            errChunks.push(buf);
          });
          res.on('end', () => {
            if (settled || oversized) return;
            let response = {};
            if (errChunks.length > 0) {
              try {
                response = JSON.parse(Buffer.concat(errChunks).toString('utf8'));
              } catch {
                failClosed(localRequestInvalidError());
                return;
              }
            }
            failClosed(errorFromDownloadHttpResponse(
              /** @type {number} */ (status),
              response,
              res.headers,
            ));
          });
          res.on('error', () => {
            if (!settled) failClosed(restoreInterruptedError());
          });
          return;
        }

        if (countRawHeaderName(raw, 'content-length') !== 1) {
          failClosed(restoreIntegrityError());
          return;
        }
        if (countRawHeaderName(raw, CHUNK_SHA_HEADER) !== 1) {
          failClosed(restoreIntegrityError());
          return;
        }
        const clRaw = firstRawHeaderValue(raw, 'content-length');
        const shaRaw = firstRawHeaderValue(raw, CHUNK_SHA_HEADER);
        if (clRaw === null || shaRaw === null) {
          failClosed(restoreIntegrityError());
          return;
        }
        const clNum = Number(clRaw);
        if (!Number.isSafeInteger(clNum) || clNum !== expectedLength) {
          failClosed(restoreIntegrityError());
          return;
        }
        if (typeof shaRaw !== 'string' || !SHA256_HEX64_RE.test(shaRaw)) {
          failClosed(restoreIntegrityError());
          return;
        }
        // When provided, expectedSha256 must equal the exact-one header (required-when-provided).
        if (hasExpectedSha && shaRaw !== expectedSha256) {
          failClosed(restoreIntegrityError());
          return;
        }

        headerSha256 = shaRaw;
        headersAccepted = true;
        knownLengthIntegrity = true;
        resetIdleTimer();

        res.on('data', (chunk) => {
          if (settled || deliveryFailed) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (buf.length === 0) return;

          resetIdleTimer();

          if (bytesReceived + buf.length > expectedLength) {
            failClosed(restoreIntegrityError());
            return;
          }

          bytesReceived += buf.length;
          try {
            hash.update(buf);
          } catch {
            failClosed(restoreIntegrityError());
            return;
          }
          pendingChunks.push(buf);
          try {
            if (typeof res.pause === 'function') res.pause();
          } catch {
            // ignore
          }
          void pumpDeliveries();
        });

        res.on('end', () => {
          if (settled || deliveryFailed) return;
          endSeen = true;
          if (bytesReceived !== expectedLength) {
            failClosed(restoreIntegrityError());
            return;
          }
          void pumpDeliveries();
        });

        const onPrematureClose = () => {
          if (settled || deliveryFailed || endSeen) return;
          if (headersAccepted && knownLengthIntegrity) {
            failClosed(restoreIntegrityError());
          } else {
            failClosed(restoreInterruptedError());
          }
        };
        res.on('aborted', onPrematureClose);
        res.on('close', () => {
          if (settled || deliveryFailed || endSeen) return;
          if (headersAccepted && knownLengthIntegrity && bytesReceived < expectedLength) {
            failClosed(restoreIntegrityError());
          }
        });
        res.on('error', (err) => {
          if (settled || deliveryFailed) return;
          const code = err && typeof err === 'object'
            ? /** @type {{ code?: string }} */ (err).code
            : undefined;
          if (
            headersAccepted
            && knownLengthIntegrity
            && (
              code === 'HPE_CLOSED_CONNECTION'
              || code === 'HPE_INVALID_CONSTANT'
              || code === 'ERR_STREAM_PREMATURE_CLOSE'
              || bytesReceived !== expectedLength
            )
          ) {
            failClosed(restoreIntegrityError());
            return;
          }
          failClosed(restoreInterruptedError());
        });
      });
    } catch {
      failClosed(restoreInterruptedError());
      return;
    }

    req.once('error', (error) => {
      if (settled) return;
      if (error instanceof LinkeError) {
        failClosed(error);
        return;
      }
      // After response headers with known expected length, any transport cut is
      // known-length integrity (under-read / aborted / HPE_*), not interrupt.
      if (headersAccepted && knownLengthIntegrity) {
        failClosed(restoreIntegrityError());
        return;
      }
      failClosed(restoreInterruptedError());
    });

    if (abortSignal) {
      const onAbort = () => {
        try {
          req.destroy(localRequestInvalidError());
        } catch {
          // ignore
        }
        failClosed(localRequestInvalidError());
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => {
        try {
          abortSignal.removeEventListener('abort', onAbort);
        } catch {
          // ignore
        }
      };
    }

    totalTimer = setTimeout(() => {
      if (settled) return;
      try {
        req.destroy();
      } catch {
        // ignore
      }
      failClosed(restoreInterruptedError());
    }, safeTimeoutMs);

    try {
      req.once('socket', (socket) => {
        socket.once('secureConnect', () => {
          try {
            const rawCert = socket.getPeerCertificate(true)?.raw;
            const actual = rawCert
              ? createHash('sha256').update(rawCert).digest()
              : Buffer.alloc(0);
            if (
              actual.length !== expectedPin.length
              || !timingSafeEqual(actual, expectedPin)
            ) {
              req.destroy(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
              return;
            }
            pinned = true;
            req.end();
          } catch {
            req.destroy(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
          }
        });
      });
    } catch {
      try {
        req.destroy(restoreInterruptedError());
      } catch {
        // ignore
      }
      failClosed(restoreInterruptedError());
    }
  });
}

/**
 * Explicit abort of an in-progress upload session (same mandatory auth triad).
 * Idempotent on the server; client does not auto-preempt other sessions.
 *
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   uploadId: string,
 *   credentialStore: { getToken: Function },
 *   protocolVersion?: number,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<unknown>}
 */
export async function abortUploadSession({
  agentUrl,
  tlsFingerprint,
  deviceId,
  uploadId,
  credentialStore,
  protocolVersion = DEVICE_PROTOCOL_VERSION,
  timeoutMs = CLIENT_ABORT_TIMEOUT_MS,
  signal,
}) {
  assertCredentialStore(credentialStore, ['getToken']);
  if (typeof uploadId !== 'string' || uploadId.length === 0 || !isServerUploadId(uploadId)) {
    throw localRequestInvalidError();
  }
  const token = await credentialStore.getToken(agentUrl, deviceId);
  if (typeof token !== 'string' || token.length === 0) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  const response = await requestPinnedBinary({
    agentUrl,
    path: `/agent/upload/sessions/${encodeURIComponent(uploadId)}/abort`,
    tlsFingerprint,
    method: 'POST',
    token,
    deviceId,
    protocolVersion,
    bodyMode: 'none',
    timeoutMs,
    signal,
  });
  return assertAbortSuccess(response, { uploadId, deviceId });
}

/**
 * GET upload session status for resume realignment (mandatory auth triad).
 *
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   uploadId: string,
 *   token: string,
 *   protocolVersion?: number,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<unknown>}
 */
async function getUploadSessionStatus({
  agentUrl,
  tlsFingerprint,
  deviceId,
  uploadId,
  token,
  protocolVersion = DEVICE_PROTOCOL_VERSION,
  timeoutMs = CLIENT_STATUS_TIMEOUT_MS,
  signal,
}) {
  return requestPinnedBinary({
    agentUrl,
    path: `/agent/upload/sessions/${encodeURIComponent(uploadId)}`,
    tlsFingerprint,
    method: 'GET',
    token,
    deviceId,
    protocolVersion,
    bodyMode: 'none',
    timeoutMs,
    signal,
  });
}

/**
 * PUT one contiguous chunk with critical identity headers + auth triad.
 *
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   token: string,
 *   uploadId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 *   fileIndex: number,
 *   chunkIndex: number,
 *   offset: number,
 *   chunkBody: Buffer,
 *   protocolVersion?: number,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<unknown>}
 */
async function putUploadChunk({
  agentUrl,
  tlsFingerprint,
  deviceId,
  token,
  uploadId,
  snapshotId,
  manifestDigest,
  fileIndex,
  chunkIndex,
  offset,
  chunkBody,
  protocolVersion = DEVICE_PROTOCOL_VERSION,
  timeoutMs = CLIENT_CHUNK_TIMEOUT_MS,
  signal,
}) {
  if (!Buffer.isBuffer(chunkBody) || chunkBody.length === 0) {
    throw localRequestInvalidError();
  }
  const size = chunkBody.length;
  const sha256 = createHash('sha256').update(chunkBody).digest('hex');
  const response = await requestPinnedBinary({
    agentUrl,
    path: `/agent/upload/sessions/${encodeURIComponent(uploadId)}/chunks`,
    tlsFingerprint,
    method: 'POST',
    token,
    deviceId,
    protocolVersion,
    body: chunkBody,
    bodyMode: 'buffer',
    contentType: 'application/octet-stream',
    extraHeaders: {
      'x-linke-upload-id': uploadId,
      'x-linke-snapshot-id': snapshotId,
      'x-linke-manifest-digest': manifestDigest,
      'x-linke-file-index': String(fileIndex),
      'x-linke-chunk-index': String(chunkIndex),
      'x-linke-chunk-offset': String(offset),
      'x-linke-chunk-size': String(size),
      'x-linke-chunk-sha256': sha256,
    },
    timeoutMs,
    signal,
  });
  assertChunkAckSuccess(response, {
    uploadId,
    deviceId,
    snapshotId,
    manifestDigest,
  });
  return response;
}

/**
 * Resumable snapshot upload: create → contiguous 8 MiB chunks (skip 0-byte files)
 * → finalize. Network / retryable errors realign via status; budget exhaustion throws
 * local {@link ERROR_CODES.UPLOAD_RESUME_EXHAUSTED} with statusCode null.
 * Does **not** auto-abort or preempt a different-snapshot active session.
 *
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   credentialStore: { getToken: Function },
 *   snapshotRoot: string,
 *   manifest: unknown,
 *   manifestDigest?: string,
 *   maxResumeAttempts?: number,
 *   protocolVersion?: number,
 *   signal?: AbortSignal,
 *   delayMs?: (ms: number) => Promise<void>,
 * }} options
 * @returns {Promise<{
 *   uploadId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 *   status: string,
 *   deviceId: string,
 * }>}
 */
export async function uploadSnapshotResumable({
  agentUrl,
  tlsFingerprint,
  deviceId,
  credentialStore,
  snapshotRoot,
  manifest,
  manifestDigest: claimedDigest,
  maxResumeAttempts = DEFAULT_UPLOAD_MAX_RESUME_ATTEMPTS,
  protocolVersion = DEVICE_PROTOCOL_VERSION,
  signal,
  delayMs = defaultDelay,
}) {
  assertCredentialStore(credentialStore, ['getToken']);
  if (
    !Number.isInteger(maxResumeAttempts)
    || maxResumeAttempts < 0
    || maxResumeAttempts > 10_000
  ) {
    throw requestInvalidError();
  }
  if (typeof delayMs !== 'function') {
    throw requestInvalidError();
  }

  const rootAbs = normalizeSnapshotRoot(snapshotRoot);
  const abortSignal = normalizeAbortSignal(signal);

  let projected;
  try {
    projected = projectCanonicalUploadManifest(manifest, {
      authenticatedDeviceId: deviceId,
      ...(typeof claimedDigest === 'string' ? { claimedManifestDigest: claimedDigest } : {}),
    });
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
  }

  const projectedManifest = projected.manifest;
  const manifestDigest = projected.manifestDigest;
  const snapshotId = projectedManifest.snapshotId;
  const entries = projectedManifest.integrity.entries;
  if (!Array.isArray(entries)) {
    throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
  }

  const plan = buildChunkPlan(entries);
  const token = await credentialStore.getToken(agentUrl, deviceId);
  if (typeof token !== 'string' || token.length === 0) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }

  // create — never auto-abort on conflict
  let createResult;
  try {
    createResult = await requestPinnedBinary({
      agentUrl,
      path: '/agent/upload/sessions',
      tlsFingerprint,
      method: 'POST',
      token,
      deviceId,
      protocolVersion,
      body: {
        manifest: projectedManifest,
        manifestDigest,
      },
      bodyMode: 'json',
      timeoutMs: CLIENT_CREATE_TIMEOUT_MS,
      signal: abortSignal,
    });
  } catch (error) {
    // Session conflict (different snapshot active) fail-closes; caller may explicit abort.
    throw error instanceof LinkeError ? error : requestInvalidError();
  }

  const created = assertCreateSuccess(createResult, {
    deviceId,
    snapshotId,
    manifestDigest,
  });
  const uploadId = created.uploadId;

  /** @type {Set<string>} */
  const confirmed = new Set();
  // Prefer server missingSummary for resume cursor (create may be fresh or idempotent).
  // Hostile progress → non-retry fail-close (no silent ignore).
  applyMissingSummaryProgress(confirmed, plan, created.missingSummary);

  let resumeBudget = maxResumeAttempts;

  /**
   * @param {unknown} error
   * @returns {Promise<void>}
   */
  async function consumeResumeBudget(error) {
    if (resumeBudget <= 0) {
      throw resumeExhaustedError();
    }
    resumeBudget -= 1;
    if (error instanceof LinkeError) {
      const sec = typeof error.retryAfterSec === 'number' ? error.retryAfterSec : null;
      if (sec !== null) {
        await boundedDelay(sec * 1000, delayMs, abortSignal);
      }
    }
    // Realign via status: identity + optional missingSummary must pass strict gates.
    // Shape/identity mismatch is non-retry and must not silently ignore.
    try {
      const status = await getUploadSessionStatus({
        agentUrl,
        tlsFingerprint,
        deviceId,
        uploadId,
        token,
        protocolVersion,
        signal: abortSignal,
      });
      assertStatusSuccess(
        status,
        { uploadId, deviceId, snapshotId, manifestDigest },
        plan,
        confirmed,
      );
    } catch (statusError) {
      if (
        statusError instanceof LinkeError
        && !isUploadResumeRetryable(statusError)
      ) {
        throw statusError;
      }
      // Transport status failure: keep client cursor and allow retry path.
    }
  }

  // Upload remaining chunks contiguously by plan order.
  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    const key = `${step.fileIndex}:${step.chunkIndex}`;
    if (confirmed.has(key)) continue;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Status realign may advance confirmed past this step — do not re-send.
      if (confirmed.has(key)) break;
      if (abortSignal?.aborted) throw localRequestInvalidError();
      try {
        const chunkBody = await readRootRelativeSlice(
          rootAbs,
          step.path,
          step.offset,
          step.size,
        );
        await putUploadChunk({
          agentUrl,
          tlsFingerprint,
          deviceId,
          token,
          uploadId,
          snapshotId,
          manifestDigest,
          fileIndex: step.fileIndex,
          chunkIndex: step.chunkIndex,
          offset: step.offset,
          chunkBody,
          protocolVersion,
          signal: abortSignal,
        });
        confirmed.add(key);
        break;
      } catch (error) {
        if (!(error instanceof LinkeError)) {
          throw localRequestInvalidError();
        }
        // Non-retryable protocol / wire-shape failures must not status-retry.
        if (!isUploadResumeRetryable(error)) {
          throw error;
        }
        if (resumeBudget <= 0) {
          throw resumeExhaustedError();
        }
        await consumeResumeBudget(error);
        // loop: re-check confirmed after status realign
      }
    }
  }

  // finalize with resume on retryable transport/backpressure
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (abortSignal?.aborted) throw localRequestInvalidError();
    try {
      const finalized = await requestPinnedBinary({
        agentUrl,
        path: `/agent/upload/sessions/${encodeURIComponent(uploadId)}/finalize`,
        tlsFingerprint,
        method: 'POST',
        token,
        deviceId,
        protocolVersion,
        bodyMode: 'none',
        timeoutMs: CLIENT_FINALIZE_TIMEOUT_MS,
        signal: abortSignal,
      });
      return assertFinalizeSuccess(finalized, {
        uploadId,
        deviceId,
        snapshotId,
        manifestDigest,
      });
    } catch (error) {
      if (!(error instanceof LinkeError)) {
        throw localRequestInvalidError();
      }
      // Hostile finalize shape/identity is non-retry — never GET status after it.
      if (!isUploadResumeRetryable(error)) {
        throw error;
      }
      if (resumeBudget <= 0) {
        throw resumeExhaustedError();
      }
      await consumeResumeBudget(error);
    }
  }
}
