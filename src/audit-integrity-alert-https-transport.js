/**
 * Bounded audit-integrity alert HTTPS transport.
 *
 * Owns one programmatic request/response settlement for a frozen delivery
 * descriptor. Returns only deep-frozen accepted/rejected results, or the fixed
 * path-free audit-delivery-unavailable error. No claim/outbox coordination,
 * environment reads, proxy surface, credentials, filesystem, or scheduling.
 */

import { Buffer } from 'node:buffer';
import https from 'node:https';
import tls from 'node:tls';
import { types as utilTypes } from 'node:util';

import { ERROR_CODES, LinkeError } from './error-codes.js';

/** Total wall deadline for one transport attempt (milliseconds). */
export const AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS = 10_000;

/** Maximum response body size counted as streamed bytes. */
export const AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES = 4_096;

const REQUEST_KEYS = Object.freeze(['schemaVersion', 'url', 'method', 'headers', 'body']);
const HEADER_KEYS = Object.freeze(['content-type', 'idempotency-key']);
const DEPS_KEYS = Object.freeze(['request', 'setTimer', 'clearTimer']);

const MAX_ENDPOINT_UTF8_BYTES = 2048;
const CONTENT_TYPE_JSON = 'application/json';

/**
 * @returns {LinkeError}
 */
function unavailableError() {
  return new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
}

function fail() {
  throw unavailableError();
}

/**
 * Plain data object: not null/array/Proxy; prototype Object.prototype or null.
 * utilTypes.isProxy runs BEFORE getPrototypeOf / ownKeys so traps never fire.
 *
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (utilTypes.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject Proxy / non-plain / symbol / non-enumerable / accessor own keys.
 *
 * @param {unknown} value
 * @returns {object}
 */
function assertPlainDataObject(value) {
  if (!isPlainObject(value)) fail();
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== 'string') fail();
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc) fail();
    if (!desc.enumerable) fail();
    if (desc.get !== undefined || desc.set !== undefined) fail();
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) fail();
  }
  return value;
}

/**
 * @param {object} obj
 * @param {readonly string[]} expected
 */
function assertExactKeyOrder(obj, expected) {
  const keys = Reflect.ownKeys(obj);
  if (keys.length !== expected.length) fail();
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== expected[i]) fail();
  }
}

/**
 * Canonical HTTPS URL: https only, no credentials/query/fragment, href-stable,
 * 1..2048 UTF-8 bytes.
 *
 * @param {unknown} endpoint
 * @returns {string}
 */
function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== 'string') fail();
  const byteLength = Buffer.byteLength(endpoint, 'utf8');
  if (byteLength < 1 || byteLength > MAX_ENDPOINT_UTF8_BYTES) fail();

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail();
  }

  if (parsed.href !== endpoint) fail();
  if (parsed.protocol !== 'https:') fail();
  if (parsed.username !== '' || parsed.password !== '') fail();
  if (parsed.search !== '' || parsed.hash !== '') fail();
  return endpoint;
}

/**
 * Snapshot a frozen plain request descriptor before any timer or request I/O.
 *
 * @param {unknown} descriptor
 * @returns {{
 *   url: string,
 *   body: string,
 *   contentType: string,
 *   idempotencyKey: string,
 * }}
 */
function validateAndSnapshotDescriptor(descriptor) {
  assertPlainDataObject(descriptor);
  assertExactKeyOrder(descriptor, REQUEST_KEYS);

  const record = /** @type {Record<string, unknown>} */ (descriptor);
  if (record.schemaVersion !== 1) fail();
  if (record.method !== 'POST') fail();
  if (typeof record.body !== 'string') fail();

  const url = normalizeEndpoint(record.url);
  const body = record.body;

  assertPlainDataObject(record.headers);
  assertExactKeyOrder(/** @type {object} */ (record.headers), HEADER_KEYS);
  const headers = /** @type {Record<string, unknown>} */ (record.headers);
  if (headers['content-type'] !== CONTENT_TYPE_JSON) fail();
  if (typeof headers['idempotency-key'] !== 'string') fail();

  // Primitive snapshot — caller mutation after this cannot affect the wire path.
  return {
    url,
    body,
    contentType: CONTENT_TYPE_JSON,
    idempotencyKey: /** @type {string} */ (headers['idempotency-key']),
  };
}

/**
 * @param {{
 *   body: string,
 *   contentType: string,
 *   idempotencyKey: string,
 * }} snapshot
 */
function buildRequestOptions(snapshot) {
  const contentLength = String(Buffer.byteLength(snapshot.body, 'utf8'));
  return {
    method: 'POST',
    headers: {
      'content-type': snapshot.contentType,
      'idempotency-key': snapshot.idempotencyKey,
      'content-length': contentLength,
    },
    agent: false,
    rejectUnauthorized: true,
    checkServerIdentity: tls.checkServerIdentity,
    ca: tls.rootCertificates,
    minVersion: 'TLSv1.2',
  };
}

/**
 * @param {unknown} chunk
 * @returns {number | null}
 */
function chunkByteLength(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return null;
}

/**
 * @param {unknown} statusCode
 * @returns {statusCode is number}
 */
function isFinalIntegerStatus(statusCode) {
  return typeof statusCode === 'number' && Number.isInteger(statusCode);
}

/**
 * @param {{
 *   request: Function,
 *   setTimer: Function,
 *   clearTimer: Function,
 * }} deps
 * @returns {(descriptor: unknown) => Promise<Readonly<{ schemaVersion: 1, status: 'accepted' | 'rejected' }>>}
 */
function createExecutor(deps) {
  return function executeWithDeps(descriptor) {
    return new Promise((resolve, reject) => {
      /** @type {{ url: string, body: string, contentType: string, idempotencyKey: string }} */
      let snapshot;
      try {
        snapshot = validateAndSnapshotDescriptor(descriptor);
      } catch {
        reject(unavailableError());
        return;
      }

      let settled = false;
      /** @type {unknown} */
      let timerId = null;
      let timerCleared = false;
      /** @type {null | { destroy?: Function, on?: Function, end?: Function }} */
      let req = null;
      /** @type {null | { destroy?: Function, on?: Function, statusCode?: unknown }} */
      let activeRes = null;
      let responseEnded = false;
      let byteCount = 0;

      const clearTimerOnce = () => {
        if (timerCleared) return;
        timerCleared = true;
        if (timerId !== null && timerId !== undefined) {
          try {
            deps.clearTimer(timerId);
          } catch {
            // Timer clear failures must not surface raw errors.
          }
          timerId = null;
        }
      };

      const destroyTransport = () => {
        if (req && typeof req.destroy === 'function') {
          try {
            req.destroy();
          } catch {
            // ignore
          }
        }
        if (activeRes && typeof activeRes.destroy === 'function') {
          try {
            activeRes.destroy();
          } catch {
            // ignore
          }
        }
      };

      const settleReject = () => {
        if (settled) return;
        settled = true;
        clearTimerOnce();
        destroyTransport();
        reject(unavailableError());
      };

      /**
       * @param {'accepted' | 'rejected'} status
       */
      const settleResolve = (status) => {
        if (settled) return;
        settled = true;
        clearTimerOnce();
        resolve(Object.freeze({ schemaVersion: 1, status }));
      };

      // Total deadline starts before request construction.
      // setTimer may invoke the callback synchronously before returning a handle.
      try {
        timerId = deps.setTimer(() => {
          settleReject();
        }, AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS);
      } catch {
        reject(unavailableError());
        return;
      }

      // Synchronous deadline: promise already rejected; do not open a request.
      // clearTimerOnce may have run before timerId was assigned — drop the handle now.
      if (settled) {
        if (timerId !== null && timerId !== undefined) {
          try {
            deps.clearTimer(timerId);
          } catch {
            // ignore
          }
        }
        return;
      }

      const options = buildRequestOptions(snapshot);

      /**
       * @param {unknown} res
       */
      const onResponse = (res) => {
        if (settled) {
          if (
            res !== null
            && typeof res === 'object'
            && typeof /** @type {{ destroy?: Function }} */ (res).destroy === 'function'
          ) {
            try {
              /** @type {{ destroy: Function }} */ (res).destroy();
            } catch {
              // ignore
            }
          }
          return;
        }

        // Keep the object gate strict: only real response objects attach listeners.
        if (res === null || typeof res !== 'object') {
          settleReject();
          return;
        }

        activeRes = /** @type {{ destroy?: Function, on?: Function, statusCode?: unknown }} */ (res);

        const onData = (chunk) => {
          if (settled) return;
          const len = chunkByteLength(chunk);
          if (len === null) {
            settleReject();
            return;
          }
          byteCount += len;
          if (byteCount > AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES) {
            // Bound exceeded: fail closed and destroy; do not retain payload bytes.
            settleReject();
          }
        };

        const onEnd = () => {
          if (settled) return;
          responseEnded = true;
          const code = activeRes && activeRes.statusCode;
          if (!isFinalIntegerStatus(code)) {
            settleReject();
            return;
          }
          if (code >= 200 && code <= 299) {
            settleResolve('accepted');
          } else {
            settleResolve('rejected');
          }
        };

        const onFail = () => {
          settleReject();
        };

        const onClose = () => {
          if (settled) return;
          // Premature close without a complete end is uncertain.
          if (!responseEnded) {
            settleReject();
          }
        };

        if (typeof activeRes.on === 'function') {
          activeRes.on('data', onData);
          activeRes.on('end', onEnd);
          activeRes.on('error', onFail);
          activeRes.on('aborted', onFail);
          activeRes.on('close', onClose);
        } else {
          settleReject();
        }
      };

      try {
        req = deps.request(snapshot.url, options, onResponse);
      } catch {
        settleReject();
        return;
      }

      // Request factory must not race a concurrent settle (e.g. late sync timer).
      if (settled) {
        destroyTransport();
        return;
      }

      if (req === null || typeof req !== 'object') {
        settleReject();
        return;
      }

      if (typeof req.on === 'function') {
        req.on('error', () => {
          settleReject();
        });
        // Informational (1xx) events never settle the attempt.
        req.on('information', () => {});
      }

      try {
        if (typeof req.end !== 'function') {
          settleReject();
          return;
        }
        req.end(snapshot.body);
      } catch {
        settleReject();
      }
    });
  };
}

/**
 * @param {unknown} deps
 * @returns {{ request: Function, setTimer: Function, clearTimer: Function }}
 */
function bindDeps(deps) {
  assertPlainDataObject(deps);
  assertExactKeyOrder(deps, DEPS_KEYS);
  const record = /** @type {Record<string, unknown>} */ (deps);
  if (typeof record.request !== 'function') fail();
  if (typeof record.setTimer !== 'function') fail();
  if (typeof record.clearTimer !== 'function') fail();
  return {
    request: /** @type {Function} */ (record.request),
    setTimer: /** @type {Function} */ (record.setTimer),
    clearTimer: /** @type {Function} */ (record.clearTimer),
  };
}

const PRODUCTION_DEPS = {
  /**
   * @param {string} url
   * @param {object} options
   * @param {(res: object) => void} onResponse
   */
  request(url, options, onResponse) {
    return https.request(url, options, onResponse);
  },
  /**
   * @param {(...args: unknown[]) => void} fn
   * @param {number} ms
   */
  setTimer(fn, ms) {
    return setTimeout(fn, ms);
  },
  /**
   * @param {unknown} id
   */
  clearTimer(id) {
    clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (id));
  },
};

/**
 * Production executor: one frozen request descriptor, real built-in HTTPS + timers.
 *
 * @param {unknown} requestDescriptor
 * @returns {Promise<Readonly<{ schemaVersion: 1, status: 'accepted' | 'rejected' }>>}
 */
export function executeAuditIntegrityAlertHttpsRequest(requestDescriptor) {
  return createExecutor(PRODUCTION_DEPS)(requestDescriptor);
}

/**
 * Test-only factory. deps must be a plain object with exact ordered keys
 * request, setTimer, clearTimer (all functions).
 *
 * @param {unknown} deps
 * @returns {(descriptor: unknown) => Promise<Readonly<{ schemaVersion: 1, status: 'accepted' | 'rejected' }>>}
 */
export function createAuditIntegrityAlertHttpsExecutorForTesting(deps) {
  try {
    return createExecutor(bindDeps(deps));
  } catch {
    throw unavailableError();
  }
}
