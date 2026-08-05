/**
 * Bounded audit-integrity alert HTTPS transport with public-DNS pin.
 *
 * Owns one programmatic request/response settlement for a frozen delivery
 * descriptor. Pins every attempt through a custom lookup that validates all
 * DNS answers as public addresses. Public results are deep-frozen
 * accepted/rejected; detailed results are deep-frozen {schemaVersion, kind}.
 * Uncertain paths throw the fixed path-free audit-delivery-unavailable error.
 * No claim/outbox coordination, environment reads, proxy surface, credentials,
 * filesystem, or scheduling.
 */

import { Buffer } from 'node:buffer';
import dns from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { types as utilTypes } from 'node:util';

import { isPublicAuditIntegrityAlertAddress } from './audit-integrity-alert-public-address.js';
import { classifyAuditIntegrityAlertHttpStatusDetailedOutcome } from './audit-integrity-alert-https-transport-outcome.js';
import { ERROR_CODES, LinkeError } from './error-codes.js';

/** Total wall deadline for one transport attempt (milliseconds). */
export const AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS = 10_000;

/** Maximum response body size counted as streamed bytes. */
export const AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES = 4_096;

/** DNS sub-deadline inside the total attempt budget (milliseconds). */
export const AUDIT_INTEGRITY_ALERT_HTTPS_DNS_TIMEOUT_MS = 4_000;

/** Maximum request body size counted as UTF-8 bytes. */
export const AUDIT_INTEGRITY_ALERT_HTTPS_MAX_REQUEST_BODY_BYTES = 8_192;

/** Maximum DNS answer records accepted for one pin check. */
export const AUDIT_INTEGRITY_ALERT_HTTPS_MAX_DNS_ANSWERS = 16;

const REQUEST_KEYS = Object.freeze(['schemaVersion', 'url', 'method', 'headers', 'body']);
const HEADER_KEYS = Object.freeze(['content-type', 'idempotency-key']);
const DEPS_KEYS = Object.freeze(['request', 'lookupAll', 'setTimer', 'clearTimer']);
const ANSWER_KEYS = Object.freeze(['address', 'family']);

const MAX_ENDPOINT_UTF8_BYTES = 2048;
const CONTENT_TYPE_JSON = 'application/json';
const FAMILY_V4 = 4;
const FAMILY_V6 = 6;

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
 * Opaque internal lookup failure. Never carries resolver/host/IP details.
 * Request error handlers map this path to a fresh public LinkeError.
 * @returns {Error}
 */
function internalLookupError() {
  return new Error(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
}

/**
 * Plain data object: not null/array/Proxy; prototype Object.prototype or null.
 * utilTypes.isProxy runs BEFORE Array.isArray / getPrototypeOf so traps never fire.
 *
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (utilTypes.isProxy(value)) return false;
  if (Array.isArray(value)) return false;
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
 * Safe data-descriptor snapshot of an own property without invoking getters.
 *
 * @param {object} obj
 * @param {string} key
 * @returns {unknown}
 */
function ownDataValue(obj, key) {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) fail();
  if (desc.get !== undefined || desc.set !== undefined) fail();
  if (!Object.prototype.hasOwnProperty.call(desc, 'value')) fail();
  return desc.value;
}

/**
 * Canonical HTTPS URL: https only, no credentials/query/fragment, href-stable,
 * 1..2048 UTF-8 bytes. Returns primitive url + hostname snapshot fields.
 *
 * Rejects every IP-literal host (public and special) before any timer/DNS/request.
 * Node skips custom lookup when the host is an IP literal; this preflight keeps
 * the pin path hostname-only. Node v24 keeps IPv6 brackets on URL.hostname, so
 * bracketed forms are unwrapped only for isIP classification.
 *
 * @param {unknown} endpoint
 * @returns {{ url: string, hostname: string }}
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
  if (typeof parsed.hostname !== 'string' || parsed.hostname.length < 1) fail();

  // IP-literal preflight (before timer/DNS/request). Classify with isIP only.
  let ipCandidate = parsed.hostname;
  if (ipCandidate.startsWith('[')) {
    if (!ipCandidate.endsWith(']')) fail();
    ipCandidate = ipCandidate.slice(1, -1);
  } else if (ipCandidate.endsWith(']')) {
    fail();
  }
  if (isIP(ipCandidate) !== 0) fail();

  return {
    url: endpoint,
    // DNS hostnames keep the original parsed form (no brackets on normal hosts).
    hostname: parsed.hostname,
  };
}

/**
 * Snapshot a frozen plain request descriptor before any timer, DNS, or request I/O.
 *
 * @param {unknown} descriptor
 * @returns {{
 *   url: string,
 *   hostname: string,
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

  const body = record.body;
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > AUDIT_INTEGRITY_ALERT_HTTPS_MAX_REQUEST_BODY_BYTES) fail();

  const { url, hostname } = normalizeEndpoint(record.url);

  assertPlainDataObject(record.headers);
  assertExactKeyOrder(/** @type {object} */ (record.headers), HEADER_KEYS);
  const headers = /** @type {Record<string, unknown>} */ (record.headers);
  if (headers['content-type'] !== CONTENT_TYPE_JSON) fail();
  if (typeof headers['idempotency-key'] !== 'string') fail();

  // Primitive snapshot — caller mutation after this cannot affect the wire path.
  return {
    url,
    hostname,
    body,
    contentType: CONTENT_TYPE_JSON,
    idempotencyKey: /** @type {string} */ (headers['idempotency-key']),
  };
}

/**
 * Node-style lookup options: plain data object with own data all===true.
 * Extra data keys (e.g. hints) are allowed. Proxy/accessor/symbol rejected
 * without executing caller getters or traps.
 *
 * @param {unknown} options
 */
function assertLookupOptions(options) {
  if (options === null || typeof options !== 'object') fail();
  // isProxy before Array.isArray / getPrototypeOf / ownKeys.
  if (utilTypes.isProxy(options)) fail();
  if (Array.isArray(options)) fail();
  const proto = Object.getPrototypeOf(options);
  if (proto !== Object.prototype && proto !== null) fail();

  const ownKeys = Reflect.ownKeys(options);
  for (const key of ownKeys) {
    if (typeof key !== 'string') fail();
    const desc = Object.getOwnPropertyDescriptor(options, key);
    if (!desc) fail();
    if (!desc.enumerable) fail();
    if (desc.get !== undefined || desc.set !== undefined) fail();
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) fail();
  }

  const allDesc = Object.getOwnPropertyDescriptor(options, 'all');
  if (!allDesc) fail();
  if (allDesc.get !== undefined || allDesc.set !== undefined) fail();
  if (allDesc.value !== true) fail();
}

/**
 * Validate DNS answers: vanilla non-Proxy Array, 1..16 plain address records,
 * every entry public, no duplicates. Returns a defensive copy preserving order.
 *
 * @param {unknown} answers
 * @returns {{ address: string, family: number }[]}
 */
function validateAndCopyDnsAnswers(answers) {
  if (answers === null || typeof answers !== 'object') fail();
  if (utilTypes.isProxy(answers)) fail();
  if (!Array.isArray(answers)) fail();
  if (Object.getPrototypeOf(answers) !== Array.prototype) fail();

  const lengthDesc = Object.getOwnPropertyDescriptor(answers, 'length');
  if (!lengthDesc) fail();
  if (lengthDesc.get !== undefined || lengthDesc.set !== undefined) fail();
  if (!Object.prototype.hasOwnProperty.call(lengthDesc, 'value')) fail();
  const len = lengthDesc.value;
  if (typeof len !== 'number' || !Number.isInteger(len)) fail();
  if (len < 1 || len > AUDIT_INTEGRITY_ALERT_HTTPS_MAX_DNS_ANSWERS) fail();

  const ownKeys = Reflect.ownKeys(answers);
  /** @type {Set<string | symbol>} */
  const expectedKeys = new Set(['length']);
  for (let i = 0; i < len; i += 1) {
    expectedKeys.add(String(i));
  }
  if (ownKeys.length !== expectedKeys.size) fail();
  for (const key of ownKeys) {
    if (!expectedKeys.has(key)) fail();
  }

  /** @type {{ address: string, family: number }[]} */
  const validated = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (let i = 0; i < len; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(answers, i)) fail();
    const indexDesc = Object.getOwnPropertyDescriptor(answers, i);
    if (!indexDesc) fail();
    if (!indexDesc.enumerable) fail();
    if (indexDesc.get !== undefined || indexDesc.set !== undefined) fail();
    if (!Object.prototype.hasOwnProperty.call(indexDesc, 'value')) fail();

    const entry = indexDesc.value;
    assertPlainDataObject(entry);
    assertExactKeyOrder(/** @type {object} */ (entry), ANSWER_KEYS);

    const address = ownDataValue(/** @type {object} */ (entry), 'address');
    const family = ownDataValue(/** @type {object} */ (entry), 'family');

    if (typeof address !== 'string') fail();
    if (typeof family !== 'number' || !Number.isInteger(family)) fail();
    if (family !== FAMILY_V4 && family !== FAMILY_V6) fail();
    if (!isPublicAuditIntegrityAlertAddress(address, family)) fail();

    const dedupeKey = `${family}\0${address}`;
    if (seen.has(dedupeKey)) fail();
    seen.add(dedupeKey);

    validated.push({ address, family });
  }

  return validated;
}

/**
 * @param {{
 *   body: string,
 *   contentType: string,
 *   idempotencyKey: string,
 * }} snapshot
 * @param {(
 *   hostname: unknown,
 *   options: unknown,
 *   callback: (err: Error | null, addresses?: { address: string, family: number }[]) => void
 * ) => void} customLookup
 */
function buildRequestOptions(snapshot, customLookup) {
  const contentLength = String(Buffer.byteLength(snapshot.body, 'utf8'));
  return {
    method: 'POST',
    headers: {
      'content-type': snapshot.contentType,
      'idempotency-key': snapshot.idempotencyKey,
      'content-length': contentLength,
    },
    agent: false,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    lookup: customLookup,
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
 * Public final-status mapper (legacy): primitive Number.isInteger only.
 * Never delegates to the detailed safe-integer classifier.
 *
 * @param {unknown} statusCode
 * @returns {Readonly<{ schemaVersion: 1, status: 'accepted' | 'rejected' }>}
 */
function mapPublicFinalStatus(statusCode) {
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) {
    fail();
  }
  if (statusCode >= 200 && statusCode <= 299) {
    return Object.freeze({ schemaVersion: 1, status: 'accepted' });
  }
  return Object.freeze({ schemaVersion: 1, status: 'rejected' });
}

/**
 * Detailed final-status mapper: pure classifier while statusCode is in hand.
 * Classifier throws fixed unavailable for non-safe / invalid values.
 *
 * @param {unknown} statusCode
 * @returns {Readonly<{ schemaVersion: 1, kind: string }>}
 */
function mapDetailedFinalStatus(statusCode) {
  return classifyAuditIntegrityAlertHttpStatusDetailedOutcome(statusCode);
}

/**
 * Shared network core parameterized by an internal final-status settlement mapper.
 *
 * @param {{
 *   request: Function,
 *   lookupAll: Function,
 *   setTimer: Function,
 *   clearTimer: Function,
 * }} deps
 * @param {(statusCode: unknown) => Readonly<object>} mapFinalStatus
 * @returns {(descriptor: unknown) => Promise<Readonly<object>>}
 */
function createExecutor(deps, mapFinalStatus) {
  return function executeWithDeps(descriptor) {
    return new Promise((resolve, reject) => {
      /** @type {{
       *   url: string,
       *   hostname: string,
       *   body: string,
       *   contentType: string,
       *   idempotencyKey: string,
       * }} */
      let snapshot;
      try {
        snapshot = validateAndSnapshotDescriptor(descriptor);
      } catch {
        reject(unavailableError());
        return;
      }

      let settled = false;
      /** @type {unknown} */
      let totalTimerId = null;
      let totalTimerCleared = false;
      /** @type {unknown} */
      let dnsTimerId = null;
      let dnsTimerCleared = false;
      let lookupInvoked = false;
      /** @type {null | { destroy?: Function, on?: Function, end?: Function }} */
      let req = null;
      /** @type {null | { destroy?: Function, on?: Function, statusCode?: unknown }} */
      let activeRes = null;
      let responseEnded = false;
      let byteCount = 0;

      const clearTotalTimer = () => {
        if (totalTimerCleared) return;
        totalTimerCleared = true;
        if (totalTimerId !== null && totalTimerId !== undefined) {
          try {
            deps.clearTimer(totalTimerId);
          } catch {
            // clearTimer failures must not surface.
          }
          totalTimerId = null;
        }
      };

      const clearDnsTimer = () => {
        if (dnsTimerCleared) return;
        dnsTimerCleared = true;
        if (dnsTimerId !== null && dnsTimerId !== undefined) {
          try {
            deps.clearTimer(dnsTimerId);
          } catch {
            // clearTimer failures must not surface.
          }
          dnsTimerId = null;
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
        clearTotalTimer();
        clearDnsTimer();
        destroyTransport();
        reject(unavailableError());
      };

      /**
       * Resolve with the mapper's exact frozen result (public status or detailed kind).
       * @param {Readonly<object>} result
       */
      const settleResolveResult = (result) => {
        if (settled) return;
        settled = true;
        clearTotalTimer();
        clearDnsTimer();
        resolve(result);
      };

      /**
       * Custom lookup for one attempt: single invoke, DNS sub-deadline, full-answer pin.
       *
       * @param {unknown} hostname
       * @param {unknown} options
       * @param {unknown} callback
       */
      const customLookup = (hostname, options, callback) => {
        if (typeof callback !== 'function') {
          return;
        }

        /** @type {(err: Error | null, addresses?: { address: string, family: number }[]) => void} */
        const nodeCallback = /** @type {*} */ (callback);

        if (lookupInvoked) {
          try {
            nodeCallback(internalLookupError());
          } catch {
            // ignore
          }
          return;
        }
        lookupInvoked = true;

        let lookupSettled = false;

        /**
         * Single-settle DNS completion: clears only the DNS timer.
         * @param {Error | null} err
         * @param {{ address: string, family: number }[]} [addresses]
         */
        const finishLookup = (err, addresses) => {
          if (lookupSettled) return;
          lookupSettled = true;
          clearDnsTimer();
          try {
            if (err) {
              nodeCallback(err);
            } else {
              nodeCallback(null, addresses);
            }
          } catch {
            // Caller callback failures must not escape.
          }
        };

        try {
          if (typeof hostname !== 'string' || hostname !== snapshot.hostname) {
            finishLookup(internalLookupError());
            return;
          }
          assertLookupOptions(options);
        } catch {
          finishLookup(internalLookupError());
          return;
        }

        // DNS sub-deadline starts before lookupAll. setTimer may fire synchronously.
        dnsTimerCleared = false;
        try {
          dnsTimerId = deps.setTimer(() => {
            finishLookup(internalLookupError());
          }, AUDIT_INTEGRITY_ALERT_HTTPS_DNS_TIMEOUT_MS);
        } catch {
          finishLookup(internalLookupError());
          return;
        }

        // Synchronous DNS deadline: drop the late handle if finishLookup ran early.
        if (lookupSettled) {
          if (dnsTimerId !== null && dnsTimerId !== undefined) {
            try {
              deps.clearTimer(dnsTimerId);
            } catch {
              // ignore
            }
            dnsTimerId = null;
          }
          return;
        }

        try {
          deps.lookupAll(hostname, (resolverErr, resolverAnswers) => {
            if (lookupSettled) return;
            if (resolverErr) {
              finishLookup(internalLookupError());
              return;
            }
            try {
              const validated = validateAndCopyDnsAnswers(resolverAnswers);
              finishLookup(null, validated);
            } catch {
              finishLookup(internalLookupError());
            }
          });
        } catch {
          finishLookup(internalLookupError());
        }
      };

      // Total deadline starts before request construction.
      // setTimer may invoke the callback synchronously before returning a handle.
      try {
        totalTimerId = deps.setTimer(() => {
          settleReject();
        }, AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS);
      } catch {
        reject(unavailableError());
        return;
      }

      // Synchronous total deadline: promise already rejected; do not open a request.
      if (settled) {
        if (totalTimerId !== null && totalTimerId !== undefined) {
          try {
            deps.clearTimer(totalTimerId);
          } catch {
            // ignore
          }
        }
        return;
      }

      const options = buildRequestOptions(snapshot, customLookup);

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
          // Mapper failures (invalid / non-safe status) convert to fixed unavailable.
          // Never let a synchronous throw escape the EventEmitter callback.
          try {
            const result = mapFinalStatus(code);
            settleResolveResult(result);
          } catch {
            settleReject();
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
        // Original descriptor URL is passed unchanged — never rewritten to an IP.
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
 * Snapshot factory deps from own data descriptors (no getter / Proxy execution).
 *
 * @param {unknown} deps
 * @returns {{
 *   request: Function,
 *   lookupAll: Function,
 *   setTimer: Function,
 *   clearTimer: Function,
 * }}
 */
function bindDeps(deps) {
  assertPlainDataObject(deps);
  assertExactKeyOrder(deps, DEPS_KEYS);

  const request = ownDataValue(/** @type {object} */ (deps), 'request');
  const lookupAll = ownDataValue(/** @type {object} */ (deps), 'lookupAll');
  const setTimer = ownDataValue(/** @type {object} */ (deps), 'setTimer');
  const clearTimer = ownDataValue(/** @type {object} */ (deps), 'clearTimer');

  if (typeof request !== 'function') fail();
  if (typeof lookupAll !== 'function') fail();
  if (typeof setTimer !== 'function') fail();
  if (typeof clearTimer !== 'function') fail();

  return {
    request: /** @type {Function} */ (request),
    lookupAll: /** @type {Function} */ (lookupAll),
    setTimer: /** @type {Function} */ (setTimer),
    clearTimer: /** @type {Function} */ (clearTimer),
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
   * Production DNS surface: exact wrapper around dns.lookup with all+verbatim.
   * @param {string} hostname
   * @param {(
   *   err: NodeJS.ErrnoException | null,
   *   addresses: Array<{ address: string, family: number }>
   * ) => void} callback
   */
  lookupAll(hostname, callback) {
    dns.lookup(hostname, { all: true, verbatim: true }, callback);
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
 * Production public executor: one frozen request descriptor, real built-in HTTPS + timers + DNS.
 * Resolves only to deep-frozen {schemaVersion:1, status:'accepted'|'rejected'}.
 *
 * @param {unknown} requestDescriptor
 * @returns {Promise<Readonly<{ schemaVersion: 1, status: 'accepted' | 'rejected' }>>}
 */
export function executeAuditIntegrityAlertHttpsRequest(requestDescriptor) {
  return createExecutor(PRODUCTION_DEPS, mapPublicFinalStatus)(requestDescriptor);
}

/**
 * Test-only public factory. deps must be a plain object with exact ordered keys
 * request, lookupAll, setTimer, clearTimer (all functions).
 *
 * @param {unknown} deps
 * @returns {(descriptor: unknown) => Promise<Readonly<{ schemaVersion: 1, status: 'accepted' | 'rejected' }>>}
 */
export function createAuditIntegrityAlertHttpsExecutorForTesting(deps) {
  try {
    return createExecutor(bindDeps(deps), mapPublicFinalStatus);
  } catch {
    throw unavailableError();
  }
}

/**
 * Production detailed executor: same bounds/DNS/TLS/single-settlement as public,
 * but settles final status through the pure detailed kind classifier.
 * Resolves to deep-frozen {schemaVersion:1, kind} or rejects fixed unavailable.
 *
 * @param {unknown} requestDescriptor
 * @returns {Promise<Readonly<{ schemaVersion: 1, kind: string }>>}
 */
export function executeAuditIntegrityAlertHttpsRequestDetailed(requestDescriptor) {
  return createExecutor(PRODUCTION_DEPS, mapDetailedFinalStatus)(requestDescriptor);
}

/**
 * Test-only detailed factory. Same exact ordered deps binder as the public factory.
 *
 * @param {unknown} deps
 * @returns {(descriptor: unknown) => Promise<Readonly<{ schemaVersion: 1, kind: string }>>}
 */
export function createAuditIntegrityAlertHttpsDetailedExecutorForTesting(deps) {
  try {
    return createExecutor(bindDeps(deps), mapDetailedFinalStatus);
  } catch {
    throw unavailableError();
  }
}
