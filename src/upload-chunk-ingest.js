/**
 * G0b C3 — Bounded chunk ingest + contiguous resume helpers.
 * Pure header/body/order primitives; no HTTP routes or C4+ commit publish.
 */

import { ERROR_CODES, LinkeError } from './error-codes.js';
import { UPLOAD_CHUNK_SIZE } from './upload-session-store.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
/** Strict non-negative decimal integer string (no sign, no leading zeros except "0"). */
const NONNEG_DEC_RE = /^(0|[1-9][0-9]*)$/;
/** Strict positive decimal integer string. */
const POS_DEC_RE = /^[1-9][0-9]*$/;

/** Critical + auth headers: rawHeaders exact-one (case-insensitive). */
const REQUIRED_HEADERS = Object.freeze([
  'authorization',
  'x-linke-device-id',
  'x-linke-protocol-version',
  'content-length',
  'x-linke-upload-id',
  'x-linke-snapshot-id',
  'x-linke-manifest-digest',
  'x-linke-file-index',
  'x-linke-chunk-index',
  'x-linke-chunk-offset',
  'x-linke-chunk-size',
  'x-linke-chunk-sha256',
]);

/**
 * @returns {never}
 */
function failChunkInvalid() {
  throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID);
}

/**
 * @returns {never}
 */
function failOutOfOrder() {
  throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER);
}

/**
 * @returns {never}
 */
function failIntegrity() {
  throw new LinkeError(ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
}

/**
 * @returns {never}
 */
function failIo() {
  throw new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR);
}

/**
 * Collect exact-one header values from Node rawHeaders (case-insensitive names).
 * @param {string[]} rawHeaders
 * @returns {Map<string, string>}
 */
function collectExactOneHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) failChunkInvalid();
  /** @type {Map<string, string>} */
  const found = new Map();
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (typeof name !== 'string' || typeof value !== 'string') failChunkInvalid();
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    // Keep first value; duplicates detected via counts.
    if (!found.has(key)) found.set(key, value);
  }
  for (const req of REQUIRED_HEADERS) {
    const n = counts.get(req) ?? 0;
    if (n !== 1) failChunkInvalid();
  }
  return found;
}

/**
 * @param {string} raw
 * @param {{ min: number, max: number }} bounds
 * @returns {number}
 */
function parseStrictPositiveInt(raw, bounds) {
  if (typeof raw !== 'string' || !POS_DEC_RE.test(raw)) failChunkInvalid();
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < bounds.min || n > bounds.max) failChunkInvalid();
  // Reject numeric forms that stringified differently (defense; regex already strict).
  if (String(n) !== raw) failChunkInvalid();
  return n;
}

/**
 * @param {string} raw
 * @returns {number}
 */
function parseStrictNonNegInt(raw) {
  if (typeof raw !== 'string' || !NONNEG_DEC_RE.test(raw)) failChunkInvalid();
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) failChunkInvalid();
  if (String(n) !== raw) failChunkInvalid();
  return n;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function parseUuid(raw) {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) failChunkInvalid();
  return raw;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function parseSha256(raw) {
  if (typeof raw !== 'string' || !SHA256_HEX_RE.test(raw)) failChunkInvalid();
  return raw;
}

/**
 * Extract uploadId from chunk route URL when present.
 * @param {string} url
 * @returns {string | null}
 */
function uploadIdFromUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  // Match .../sessions/<uploadId>/chunks with optional query.
  const m = /\/sessions\/([^/?#]+)\/chunks(?:[/?#]|$)/.exec(url);
  if (!m) return null;
  return m[1];
}

/**
 * Parse and validate chunk critical + auth headers (exact-one, strict syntax).
 * Does not read or attach body stream listeners.
 *
 * Input forms:
 * - Bare `rawHeaders` string[] — **header-only** validation. Cannot check URL
 *   uploadId consistency (no URL available).
 * - Request-like `{ rawHeaders, url? }` — C6 public routes MUST pass this shape
 *   so URL path uploadId can be checked against `X-Linke-Upload-Id`.
 *
 * @param {string[] | { rawHeaders?: string[], url?: string }} rawHeadersOrReq
 * @returns {{
 *   uploadId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 *   deviceId: string,
 *   fileIndex: number,
 *   chunkIndex: number,
 *   offset: number,
 *   size: number,
 *   sha256: string,
 * }}
 */
export function parseChunkHeaders(rawHeadersOrReq) {
  /** @type {string[] | undefined} */
  let raw;
  /** @type {string | undefined} */
  let url;
  if (Array.isArray(rawHeadersOrReq)) {
    raw = rawHeadersOrReq;
  } else if (rawHeadersOrReq && typeof rawHeadersOrReq === 'object') {
    raw = rawHeadersOrReq.rawHeaders;
    if (typeof rawHeadersOrReq.url === 'string') url = rawHeadersOrReq.url;
  } else {
    failChunkInvalid();
  }
  if (!Array.isArray(raw)) failChunkInvalid();

  const headers = collectExactOneHeaders(raw);

  const contentLength = parseStrictPositiveInt(/** @type {string} */ (headers.get('content-length')), {
    min: 1,
    max: UPLOAD_CHUNK_SIZE,
  });
  const size = parseStrictPositiveInt(/** @type {string} */ (headers.get('x-linke-chunk-size')), {
    min: 1,
    max: UPLOAD_CHUNK_SIZE,
  });
  if (contentLength !== size) failChunkInvalid();

  const uploadId = parseUuid(/** @type {string} */ (headers.get('x-linke-upload-id')));
  const snapshotId = parseUuid(/** @type {string} */ (headers.get('x-linke-snapshot-id')));
  const manifestDigest = parseSha256(/** @type {string} */ (headers.get('x-linke-manifest-digest')));
  const sha256 = parseSha256(/** @type {string} */ (headers.get('x-linke-chunk-sha256')));
  const fileIndex = parseStrictNonNegInt(/** @type {string} */ (headers.get('x-linke-file-index')));
  const chunkIndex = parseStrictNonNegInt(/** @type {string} */ (headers.get('x-linke-chunk-index')));
  const offset = parseStrictNonNegInt(/** @type {string} */ (headers.get('x-linke-chunk-offset')));
  const deviceId = /** @type {string} */ (headers.get('x-linke-device-id'));
  if (typeof deviceId !== 'string' || deviceId.length === 0) failChunkInvalid();
  // Authorization presence already enforced exact-one; value shape is C6 auth concern.

  if (url !== undefined) {
    const urlUploadId = uploadIdFromUrl(url);
    if (urlUploadId === null || urlUploadId !== uploadId) failChunkInvalid();
  }

  return {
    uploadId,
    snapshotId,
    manifestDigest,
    deviceId,
    fileIndex,
    chunkIndex,
    offset,
    size,
    sha256,
  };
}

/**
 * Canonical byte length of chunkIndex for a positive file size, or null if OOB.
 * @param {number} fileSize
 * @param {number} chunkIndex
 * @returns {number | null}
 */
function canonicalChunkBytes(fileSize, chunkIndex) {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return null;
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) return null;
  const totalChunks = Math.ceil(fileSize / UPLOAD_CHUNK_SIZE);
  if (chunkIndex >= totalChunks) return null;
  if (chunkIndex < totalChunks - 1) return UPLOAD_CHUNK_SIZE;
  const last = fileSize - chunkIndex * UPLOAD_CHUNK_SIZE;
  return last > 0 ? last : null;
}

/**
 * @param {{ size: number, confirmedBytes: number, complete: boolean }} file
 * @returns {{ chunkIndex: number, chunkBytes: number, offset: number } | null}
 */
function expectedNextChunk(file) {
  if (file.complete || file.size === 0) return null;
  const chunkIndex = Math.floor(file.confirmedBytes / UPLOAD_CHUNK_SIZE);
  const remaining = file.size - file.confirmedBytes;
  const chunkBytes = Math.min(UPLOAD_CHUNK_SIZE, remaining);
  return { chunkIndex, chunkBytes, offset: file.confirmedBytes };
}

/**
 * Pure contiguous-order decision for one fileIndex (design §6.3).
 * Does not mutate session. Returns { kind: 'expected' | 'duplicate' } or throws
 * a unique LinkeError code (no alternates).
 *
 * @param {{
 *   files?: Array<{
 *     fileIndex: number,
 *     size: number,
 *     confirmedBytes: number,
 *     confirmedChunks: number,
 *     complete: boolean,
 *   }>,
 * }} session
 * @param {{
 *   fileIndex: number,
 *   chunkIndex: number,
 *   offset: number,
 *   size: number,
 * }} identity
 * @returns {{ kind: 'expected' } | { kind: 'duplicate' }}
 */
export function assertContiguousOrder(session, identity) {
  // Server/store invariant: malformed session shape is I/O, not client chunk-invalid.
  if (!session || typeof session !== 'object' || !Array.isArray(session.files)) {
    failIo();
  }
  if (!identity || typeof identity !== 'object') failChunkInvalid();

  const fileIndex = identity.fileIndex;
  const chunkIndex = identity.chunkIndex;
  const offset = identity.offset;
  const size = identity.size;

  // Syntax-illegal coordinates (§6.3 step 6) — unique chunk-invalid, not out-of-order.
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) failChunkInvalid();
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) failChunkInvalid();
  if (!Number.isSafeInteger(offset) || offset < 0) failChunkInvalid();
  if (!Number.isSafeInteger(size) || size <= 0 || size > UPLOAD_CHUNK_SIZE) {
    failChunkInvalid();
  }

  const files = session.files;
  // Exact fileIndex match only — never fall back to array position (sparse/gap safe).
  const file = files.find((f) => f && f.fileIndex === fileIndex);
  if (!file || typeof file !== 'object') failOutOfOrder();

  // Zero-byte files never accept chunks (design §6.1).
  if (file.size === 0) failChunkInvalid();

  const next = expectedNextChunk(file);

  if (next === null) {
    // File complete: confirmed coordinates with canonical size → duplicate;
    // same offset + wrong size → integrity; offset mismatch → out-of-order (§6.3 rule 4).
    const canon = canonicalChunkBytes(file.size, chunkIndex);
    const lastIdx = Math.ceil(file.size / UPLOAD_CHUNK_SIZE) - 1;
    const expectedOffset = chunkIndex * UPLOAD_CHUNK_SIZE;
    if (
      canon !== null
      && size === canon
      && chunkIndex <= lastIdx
      && offset === expectedOffset
    ) {
      return { kind: 'duplicate' };
    }
    if (
      canon !== null
      && size !== canon
      && chunkIndex <= lastIdx
      && offset === expectedOffset
    ) {
      failIntegrity();
    }
    failOutOfOrder();
  }

  // Exact expected next at confirmed boundary.
  if (
    chunkIndex === next.chunkIndex
    && size === next.chunkBytes
    && offset === next.offset
  ) {
    return { kind: 'expected' };
  }

  // Prior confirmed coordinate.
  if (chunkIndex < next.chunkIndex) {
    const canon = canonicalChunkBytes(file.size, chunkIndex);
    const expectedOffset = chunkIndex * UPLOAD_CHUNK_SIZE;
    if (canon !== null && size === canon && offset === expectedOffset) {
      return { kind: 'duplicate' };
    }
    // Integrity only when offset matches confirmed coordinate; else out-of-order.
    if (canon !== null && size !== canon && offset === expectedOffset) {
      failIntegrity();
    }
    failOutOfOrder();
  }

  // Same expected index, wrong size → invalid; wrong offset → out-of-order.
  if (chunkIndex === next.chunkIndex) {
    if (offset !== next.offset) failOutOfOrder();
    if (size !== next.chunkBytes) failChunkInvalid();
  }

  // Future / gap.
  failOutOfOrder();
}

/**
 * Bounded binary body reader with single-settle semantics.
 * Resolves with a Buffer (or { body }) of exactly expectedSize; rejects
 * under-size / over-size / early EOF with upload-chunk-invalid.
 *
 * @param {NodeJS.ReadableStream | import('node:stream').Readable} stream
 * @param {{
 *   maxBytes: number,
 *   expectedSize: number,
 *   onOversize?: () => void,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<Buffer | { body: Buffer }>}
 */
export function ingestChunkBody(stream, options) {
  return new Promise((resolve, reject) => {
    if (!stream || typeof stream.on !== 'function') {
      reject(new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID));
      return;
    }
    const maxBytes = options?.maxBytes;
    const expectedSize = options?.expectedSize;
    const onOversize = options?.onOversize;
    const signal = options?.signal;

    // Already-aborted: reject immediately without attaching body listeners.
    try {
      if (signal && typeof signal === 'object' && signal.aborted === true) {
        reject(new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID));
        return;
      }
    } catch {
      reject(new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR));
      return;
    }

    if (
      !Number.isSafeInteger(maxBytes)
      || maxBytes <= 0
      || maxBytes > UPLOAD_CHUNK_SIZE
      || !Number.isSafeInteger(expectedSize)
      || expectedSize <= 0
      || expectedSize > maxBytes
    ) {
      reject(new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID));
      return;
    }

    let settled = false;
    let oversizeCalled = false;
    let total = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    /** @type {(() => void) | null} */
    let detachAbort = null;

    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      if (typeof stream.off === 'function') {
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('error', onError);
        stream.off('close', onClose);
      }
      if (detachAbort) {
        try {
          detachAbort();
        } catch {
          // ignore
        }
        detachAbort = null;
      }
    };

    /**
     * @param {null | Error | LinkeError} err
     * @param {Buffer | undefined} [buf]
     */
    const settle = (err, buf) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Keep a no-op error listener so late emit('error') does not become unhandled.
      try {
        stream.on('error', () => {});
      } catch {
        // ignore
      }
      if (err) {
        reject(err instanceof LinkeError ? err : new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID));
        return;
      }
      resolve(/** @type {Buffer} */ (buf));
    };

    const safeDestroyInput = () => {
      try {
        if (typeof stream.destroy === 'function' && !/** @type {{ destroyed?: boolean }} */ (stream).destroyed) {
          stream.destroy();
        } else if (typeof stream.pause === 'function') {
          stream.pause();
        }
      } catch {
        // ignore
      }
    };

    const triggerOversize = () => {
      if (!oversizeCalled) {
        oversizeCalled = true;
        if (typeof onOversize === 'function') {
          try {
            onOversize();
          } catch {
            // Callback errors must not escape or double-settle with raw throws.
          }
        }
      }
      try {
        if (typeof stream.destroy === 'function' && !/** @type {{ destroyed?: boolean }} */ (stream).destroyed) {
          stream.destroy();
        } else if (typeof stream.resume === 'function') {
          // Drain residual if destroy unavailable.
          stream.resume();
        }
      } catch {
        // Ignore destroy/drain failures; still settle once.
      }
      settle(new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID));
    };

    /**
     * @param {Buffer | string} chunk
     */
    function onData(chunk) {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length === 0) return;
      total += buf.length;
      if (total > expectedSize || total > maxBytes) {
        triggerOversize();
        return;
      }
      chunks.push(buf);
    }

    function onEnd() {
      if (settled) return;
      if (total !== expectedSize) {
        settle(new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID));
        return;
      }
      settle(null, Buffer.concat(chunks, total));
    }

    /**
     * @param {Error} _err
     */
    function onError(_err) {
      if (settled) return;
      // Never echo raw stream errors.
      settle(new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID));
    }

    /**
     * Client abort / transport drop may emit close without end/error.
     * Fail-closed with unique upload-chunk-invalid (single-settle).
     */
    function onClose() {
      if (settled) return;
      settle(new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID));
    }

    function onAbort() {
      if (settled) return;
      safeDestroyInput();
      // Public code only — never raw AbortError / reason.
      settle(new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR));
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);

    if (signal && typeof signal === 'object') {
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            // ignore
          }
        };
      } else if (typeof signal.on === 'function') {
        signal.on('abort', onAbort);
        detachAbort = () => {
          try {
            if (typeof signal.off === 'function') signal.off('abort', onAbort);
            else if (typeof signal.removeListener === 'function') signal.removeListener('abort', onAbort);
          } catch {
            // ignore
          }
        };
      }
      // Re-check after attach (TOCTOU).
      try {
        if (signal.aborted === true) {
          onAbort();
          return;
        }
      } catch {
        onAbort();
        return;
      }
    }

    // Ensure flowing mode for mock/push streams that start paused.
    if (typeof stream.resume === 'function') {
      try {
        stream.resume();
      } catch {
        // ignore
      }
    }
  });
}

/**
 * @param {{ deviceId?: string, uploadId?: string }} session
 * @param {{
 *   abortSession?: (input: { authenticatedDeviceId: string, uploadId: string }) => Promise<unknown>,
 * }} store
 */
async function abortQuiet(store, session) {
  if (typeof store?.abortSession !== 'function') return;
  const deviceId = session?.deviceId;
  const uploadId = session?.uploadId;
  if (typeof deviceId !== 'string' || typeof uploadId !== 'string') return;
  try {
    await store.abortSession({
      authenticatedDeviceId: deviceId,
      uploadId,
    });
  } catch {
    // Abort best-effort; original error path still owns the response code.
  }
}

/**
 * Classify tempPublish result's existingSha256 without echoing values.
 * Tri-state:
 * - absent: null/undefined/non-object, or no own data property `existingSha256`
 * - valid: own data property whose value is exactly 64 lower-hex
 * - invalid: own property present but accessor/getter/setter, descriptor read throw,
 *   Proxy hostility, non-string / uppercase / short / other malformed value
 *
 * @param {unknown} published
 * @returns {{ kind: 'absent' } | { kind: 'valid', value: string } | { kind: 'invalid' }}
 */
function classifyExistingSha256(published) {
  if (published === null || published === undefined || typeof published !== 'object') {
    return { kind: 'absent' };
  }
  /** @type {PropertyDescriptor | undefined} */
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(published, 'existingSha256');
  } catch {
    return { kind: 'invalid' };
  }
  if (desc === undefined) {
    // No own property (e.g. { ok: true }) — treat as absent, not invalid.
    return { kind: 'absent' };
  }
  // Accessor descriptors (get/set) are never a trusted data digest field.
  if (typeof desc.get === 'function' || typeof desc.set === 'function') {
    return { kind: 'invalid' };
  }
  /** @type {unknown} */
  let raw;
  try {
    raw = desc.value;
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof raw !== 'string' || !SHA256_HEX_RE.test(raw)) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', value: raw };
}

/**
 * Optional signal check: already-aborted → sanitized io (no raw AbortError).
 * Does not run during abortQuiet integrity paths that must preserve original semantics.
 * @param {unknown} signal
 */
function throwIfSignalAborted(signal) {
  if (signal == null) return;
  try {
    if (typeof signal === 'object' && /** @type {{ aborted?: unknown }} */ (signal).aborted === true) {
      failIo();
    }
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failIo();
  }
}

/**
 * Commit one ingested chunk: identity check → order → publish/rehash → atomic advance.
 * Exact duplicates ACK without rewrite/advance after verify-existing rehash.
 * Failures never false-ACK and never leak path/raw errors into LinkeError public fields.
 *
 * @param {{
 *   store: {
 *     advanceBoundary: (input: {
 *       authenticatedDeviceId: string,
 *       uploadId: string,
 *       fileIndex: number,
 *       chunkIndex: number,
 *       chunkBytes: number,
 *       signal?: AbortSignal,
 *     }) => Promise<object>,
 *     abortSession: (input: {
 *       authenticatedDeviceId: string,
 *       uploadId: string,
 *     }) => Promise<unknown>,
 *     getSession?: (input: {
 *       authenticatedDeviceId: string,
 *       uploadId: string,
 *     }) => Promise<object> | object,
 *   },
 *   session: {
 *     uploadId: string,
 *     deviceId: string,
 *     snapshotId: string,
 *     manifestDigest: string,
 *     files: Array<object>,
 *     [k: string]: unknown,
 *   },
 *   identity: {
 *     uploadId: string,
 *     snapshotId: string,
 *     manifestDigest: string,
 *     deviceId: string,
 *     fileIndex: number,
 *     chunkIndex: number,
 *     offset: number,
 *     size: number,
 *     sha256: string,
 *   },
 *   bodyHash: string,
 *   tempPublish: (context: Readonly<{ mode: 'publish-new' | 'verify-existing' }>) => Promise<unknown>,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<object>}
 *
 * tempPublish contract (frozen C3):
 * - Invoked once with frozen context `{ mode }` only (no path/token/raw secrets).
 * - **publish-new** (`mode: 'publish-new'`): callback MUST atomically/exclusively
 *   publish the exact body bytes already verified by `bodyHash`/`identity.sha256`.
 *   C2 `advanceBoundary` does **not** rehash disk — this callback is the hard
 *   dependency for content correctness. Result:
 *   - absent (`null` / `undefined` / object without own data `existingSha256`,
 *     e.g. `{ ok: true }`) = new publish succeeded; advance may proceed.
 *   - valid own `existingSha256` (64 lower-hex) = exclusive collision / crash-retry
 *     rehash; must equal identity.sha256 and bodyHash or integrity+abort.
 *   - present but invalid (uppercase/short/non-string/accessor/getter throw) =
 *     internal schema violation → unique upload-io-error (no abort, no advance).
 * - **verify-existing** (`mode: 'verify-existing'`): read-only rehash of already
 *   confirmed staging; MUST return valid own `existingSha256` matching claim;
 *   MUST NOT rewrite. absent/invalid → upload-io-error; valid mismatch → integrity+abort.
 */
export async function commitChunk(args) {
  const store = args?.store;
  const session = args?.session;
  const identity = args?.identity;
  const bodyHash = args?.bodyHash;
  const tempPublish = args?.tempPublish;
  const signal = args?.signal;

  throwIfSignalAborted(signal);

  if (!store || !session || !identity || typeof tempPublish !== 'function') {
    failIo();
  }
  // Server misuse: digests must already be 64 lower-hex (parse/preflight). Do not echo.
  if (typeof bodyHash !== 'string' || !SHA256_HEX_RE.test(bodyHash)) {
    failIo();
  }
  if (typeof identity.sha256 !== 'string' || !SHA256_HEX_RE.test(identity.sha256)) {
    failIo();
  }

  // Identity: URL/header fields vs session / device scope (design §6.0 step 5).
  if (
    identity.uploadId !== session.uploadId
    || identity.snapshotId !== session.snapshotId
    || identity.manifestDigest !== session.manifestDigest
    || identity.deviceId !== session.deviceId
  ) {
    await abortQuiet(store, session);
    failChunkInvalid();
  }

  // Order / resume decision (unique codes; out-of-order does not abort).
  let decision;
  try {
    decision = assertContiguousOrder(session, identity);
  } catch (error) {
    if (error instanceof LinkeError) {
      if (error.code === ERROR_CODES.UPLOAD_INTEGRITY_FAILED) {
        await abortQuiet(store, session);
      }
      throw error;
    }
    await abortQuiet(store, session);
    failIo();
  }

  // bodyHash must match claimed chunk digest before any advance (rehash gate).
  if (bodyHash !== identity.sha256) {
    await abortQuiet(store, session);
    failIntegrity();
  }

  throwIfSignalAborted(signal);

  // Frozen context: mode only; immutable; no path/token/raw material.
  const publishContext = Object.freeze({
    mode: /** @type {'publish-new' | 'verify-existing'} */ (
      decision.kind === 'duplicate' ? 'verify-existing' : 'publish-new'
    ),
  });

  /** @type {unknown} */
  let published;
  try {
    published = await tempPublish(publishContext);
  } catch (error) {
    if (error instanceof LinkeError) {
      if (error.code === ERROR_CODES.UPLOAD_INTEGRITY_FAILED) {
        // Preserve integrity semantics — do not let signal cancel mask this path.
        await abortQuiet(store, session);
      }
      throw error;
    }
    // Never echo path/raw OS errors (ENOSPC, absolute paths, etc.).
    failIo();
  }

  throwIfSignalAborted(signal);

  const existingClass = classifyExistingSha256(published);

  if (decision.kind === 'duplicate') {
    // Verify-existing: only valid digest may ACK; absent/invalid → io (no abort).
    if (existingClass.kind !== 'valid') {
      failIo();
    }
    if (existingClass.value !== identity.sha256 || existingClass.value !== bodyHash) {
      await abortQuiet(store, session);
      failIntegrity();
    }
    return session;
  }

  // Expected (publish-new):
  // - absent → advance (callback already published under bodyHash contract)
  // - valid → match re-check then advance
  // - invalid (present but malformed) → io; never treat as absent
  if (existingClass.kind === 'invalid') {
    failIo();
  }
  if (existingClass.kind === 'valid') {
    if (existingClass.value !== identity.sha256 || existingClass.value !== bodyHash) {
      await abortQuiet(store, session);
      failIntegrity();
    }
  }

  throwIfSignalAborted(signal);

  try {
    const advanced = await store.advanceBoundary({
      authenticatedDeviceId: session.deviceId,
      uploadId: session.uploadId,
      fileIndex: identity.fileIndex,
      chunkIndex: identity.chunkIndex,
      chunkBytes: identity.size,
      signal,
    });
    return advanced;
  } catch (error) {
    if (error instanceof LinkeError) {
      if (error.code === ERROR_CODES.UPLOAD_INTEGRITY_FAILED) {
        await abortQuiet(store, session);
      }
      throw error;
    }
    failIo();
  }
}
