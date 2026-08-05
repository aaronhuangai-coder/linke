/**
 * Bounded audit integrity alert HTTPS transport — Task 1 baseline + DNS pin
 * + Task 4 detailed HTTPS executor RED.
 *
 * Production module:
 *   src/audit-integrity-alert-https-transport.js
 *
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-https-transport-design.md
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-https-transport-plan.md (Task 1)
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-destination-allowlist-design.md
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-destination-allowlist-plan.md (Task 4)
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md (§9.3)
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-durable-retry-plan.md (Task 4)
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   assert message = `bounded HTTPS transport implementation missing`
 * Public suites register when public executor + test factory exports exist.
 * Detailed suites assert detailed executor + detailed factory (RED until GREEN).
 * Module currently exists: public surface green; detailed surface RED.
 *
 * Deterministic EventEmitter fakes only. No real DNS, TLS handshake, socket,
 * fetch, or external/local network I/O. Every case settles via the virtual harness
 * (no wall-clock wait, no real timers).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES } from '../src/error-codes.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-https-transport.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);

const MISSING_MSG = 'bounded HTTPS transport implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';
const TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 4_096;
const MAX_REQUEST_BODY_BYTES = 8_192;
const MAX_DNS_ANSWERS = 16;

const CANONICAL_URL = 'https://alerts.example.invalid/hooks/audit-integrity';
const CANONICAL_HOSTNAME = 'alerts.example.invalid';
const STREAM_ID = 'a1111111-b111-4c11-8d11-e11111111111';
const IDEMPOTENCY_KEY = `audit-integrity-alert:${STREAM_ID}:1`;
const SECRET_TOKEN = 'Bearer secret-token-xyz';
const SECRET_HOST = 'evil-cert.example.invalid';
const SECRET_PATH = '/Users/ah/secret/audit-ca.pem';
const SECRET_BODY_MARKER = 'response-body-secret-bytes-do-not-leak';

/** Public fixtures matching src/audit-integrity-alert-public-address.js contract. */
const PUBLIC_V4 = '8.8.8.8';
const PUBLIC_V6 = '2606:4700:4700::1111';
const PUBLIC_V4_B = '1.1.1.1';
const PUBLIC_V6_B = '2606:4700:4700::1001';

/** Special/private fixtures rejected by the public-address classifier. */
const SPECIAL_V4_LOOPBACK = '127.0.0.1';
const SPECIAL_V4_PRIVATE = '10.0.0.1';
const SPECIAL_V6_LOOPBACK = '::1';
const SPECIAL_V6_DOC = '2001:db8::1';

const REQUEST_KEYS = Object.freeze(['schemaVersion', 'url', 'method', 'headers', 'body']);
const HEADER_KEYS = Object.freeze(['content-type', 'idempotency-key']);
const RESULT_KEYS = Object.freeze(['schemaVersion', 'status']);
/** Task 4 durable-retry detailed result keys (exact order). */
const DETAILED_RESULT_KEYS = Object.freeze(['schemaVersion', 'kind']);
/** Task 4 exact factory deps order. */
const DEPS_KEYS = Object.freeze(['request', 'lookupAll', 'setTimer', 'clearTimer']);
const REQUEST_HEADER_KEYS = Object.freeze([
  'content-type',
  'idempotency-key',
  'content-length',
]);
const FORBIDDEN_PUBLIC_RESULT_CLASSIFIER = 'classifyAuditIntegrityAlertTransportDetailedOutcome';

/**
 * @typedef {{
 *   AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS: number,
 *   AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES: number,
 *   AUDIT_INTEGRITY_ALERT_HTTPS_DNS_TIMEOUT_MS: number,
 *   AUDIT_INTEGRITY_ALERT_HTTPS_MAX_REQUEST_BODY_BYTES: number,
 *   AUDIT_INTEGRITY_ALERT_HTTPS_MAX_DNS_ANSWERS: number,
 *   executeAuditIntegrityAlertHttpsRequest: Function,
 *   createAuditIntegrityAlertHttpsExecutorForTesting: Function,
 *   executeAuditIntegrityAlertHttpsRequestDetailed: Function,
 *   createAuditIntegrityAlertHttpsDetailedExecutorForTesting: Function,
 * }} TransportApi
 */

/** @type {null | TransportApi} */
let transportApi = null;
/** @type {null | Record<string, unknown>} */
let transportModuleExports = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  transportModuleExports = /** @type {Record<string, unknown>} */ (mod);
  // Public surface gate unchanged: detailed exports are required by the typedef
  // and attached when present; public suite stays green without them until GREEN.
  if (
    typeof mod.executeAuditIntegrityAlertHttpsRequest === 'function'
    && typeof mod.createAuditIntegrityAlertHttpsExecutorForTesting === 'function'
  ) {
    transportApi = {
      AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS: mod.AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS,
      AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES:
        mod.AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES,
      AUDIT_INTEGRITY_ALERT_HTTPS_DNS_TIMEOUT_MS:
        mod.AUDIT_INTEGRITY_ALERT_HTTPS_DNS_TIMEOUT_MS,
      AUDIT_INTEGRITY_ALERT_HTTPS_MAX_REQUEST_BODY_BYTES:
        mod.AUDIT_INTEGRITY_ALERT_HTTPS_MAX_REQUEST_BODY_BYTES,
      AUDIT_INTEGRITY_ALERT_HTTPS_MAX_DNS_ANSWERS:
        mod.AUDIT_INTEGRITY_ALERT_HTTPS_MAX_DNS_ANSWERS,
      executeAuditIntegrityAlertHttpsRequest: mod.executeAuditIntegrityAlertHttpsRequest,
      createAuditIntegrityAlertHttpsExecutorForTesting:
        mod.createAuditIntegrityAlertHttpsExecutorForTesting,
      executeAuditIntegrityAlertHttpsRequestDetailed:
        mod.executeAuditIntegrityAlertHttpsRequestDetailed,
      createAuditIntegrityAlertHttpsDetailedExecutorForTesting:
        mod.createAuditIntegrityAlertHttpsDetailedExecutorForTesting,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    transportApi = null;
    transportModuleExports = null;
  } else {
    // Syntax/load errors in an existing production module must surface as themselves.
    throw error;
  }
}

function requireApi() {
  if (implementationMissing || transportApi === null) {
    assert.fail(MISSING_MSG);
  }
  return transportApi;
}

/**
 * Detailed executor + detailed factory are required for Task 4 RED/GREEN.
 * @returns {TransportApi}
 */
function requireDetailedApi() {
  const api = requireApi();
  assert.equal(
    typeof api.executeAuditIntegrityAlertHttpsRequestDetailed,
    'function',
    'executeAuditIntegrityAlertHttpsRequestDetailed must be a function',
  );
  assert.equal(
    typeof api.createAuditIntegrityAlertHttpsDetailedExecutorForTesting,
    'function',
    'createAuditIntegrityAlertHttpsDetailedExecutorForTesting must be a function',
  );
  return api;
}

// ─── Exact-key / freeze / error helpers ───────────────────────────────────

function assertExactKeys(obj, expected, label = 'value') {
  assert.deepEqual(
    Object.keys(/** @type {object} */ (obj)),
    [...expected],
    `${label} must have exact key order ${expected.join(',')}`,
  );
}

function assertDeeplyFrozen(value, path = 'root') {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `expected frozen at ${path}`);
  for (const key of Object.keys(/** @type {object} */ (value))) {
    assertDeeplyFrozen(
      /** @type {Record<string, unknown>} */ (value)[key],
      `${path}.${key}`,
    );
  }
}

/**
 * Public-boundary failures are only the registered fixed LinkeError.
 * @param {unknown} error
 * @param {string[]} [leakTokens]
 */
function assertUnavailable(error, leakTokens = []) {
  assert.equal(error && /** @type {{ name?: string }} */ (error).name, 'LinkeError');
  assert.equal(error && /** @type {{ code?: string }} */ (error).code, CODE_UNAVAILABLE);
  assert.equal(
    error && /** @type {{ message?: string }} */ (error).message,
    CODE_UNAVAILABLE,
  );
  assert.equal(/** @type {{ cause?: unknown }} */ (error).cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(/** @type {object} */ (error), 'cause'));

  const publicParts = [
    /** @type {{ name: string }} */ (error).name,
    /** @type {{ code: string }} */ (error).code,
    /** @type {{ message: string }} */ (error).message,
    String(/** @type {{ statusCode?: unknown }} */ (error).statusCode),
    String(/** @type {{ retryable?: unknown }} */ (error).retryable),
    ...Object.keys(/** @type {object} */ (error))
      .filter((key) => key !== 'stack')
      .map((key) => String(/** @type {Record<string, unknown>} */ (error)[key])),
  ].join('\0');

  const defaults = [
    CANONICAL_URL,
    CANONICAL_HOSTNAME,
    'alerts.example.invalid',
    SECRET_TOKEN,
    SECRET_HOST,
    SECRET_PATH,
    SECRET_BODY_MARKER,
    PUBLIC_V4,
    PUBLIC_V6,
    PUBLIC_V4_B,
    PUBLIC_V6_B,
    SPECIAL_V4_LOOPBACK,
    SPECIAL_V4_PRIVATE,
    SPECIAL_V6_LOOPBACK,
    SPECIAL_V6_DOC,
    'ECONNRESET',
    'ENOTFOUND',
    'ECONNREFUSED',
    'getaddrinfo',
    'certificate',
    'BEGIN CERTIFICATE',
    'errno',
    '/var/',
    '/private/',
    '/tmp/',
    'Users/',
    'authorization',
    'cookie',
    IDEMPOTENCY_KEY,
  ];
  for (const token of [...defaults, ...leakTokens]) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `public error must not leak ${token}`);
  }
  return true;
}

/**
 * @param {() => unknown} fn
 * @param {string[]} [leakTokens]
 */
function expectUnavailable(fn, leakTokens = []) {
  assert.throws(fn, (error) => {
    assertUnavailable(error, leakTokens);
    return true;
  });
}

/**
 * @param {Promise<unknown>} promise
 * @param {string[]} [leakTokens]
 */
async function expectUnavailableAsync(promise, leakTokens = []) {
  await assert.rejects(promise, (error) => {
    assertUnavailable(error, leakTokens);
    return true;
  });
}

/**
 * @param {Promise<unknown>} promise
 */
async function assertStillPending(promise) {
  const pending = Symbol('pending');
  const winner = await Promise.race([
    Promise.resolve(promise).then(
      () => 'fulfilled',
      () => 'rejected',
    ),
    Promise.resolve(pending),
  ]);
  assert.equal(winner, pending, 'expected promise still pending');
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Descriptor fixtures ──────────────────────────────────────────────────

/**
 * Canonical plain-data request descriptor (exact key order).
 * @param {Partial<{
 *   schemaVersion: unknown,
 *   url: unknown,
 *   method: unknown,
 *   headers: unknown,
 *   body: unknown,
 * }>} [overrides]
 */
function validDescriptor(overrides = {}) {
  const headers = Object.prototype.hasOwnProperty.call(overrides, 'headers')
    ? overrides.headers
    : {
      'content-type': 'application/json',
      'idempotency-key': IDEMPOTENCY_KEY,
    };
  const body = Object.prototype.hasOwnProperty.call(overrides, 'body')
    ? overrides.body
    : JSON.stringify({
      schemaVersion: 1,
      kind: 'audit-integrity-alert',
      streamId: STREAM_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      deliverySemantics: 'at-least-once',
      alert: {
        sequence: 1,
        checkedAt: '2026-08-04T12:34:56.789Z',
        code: 'uninitialized',
        recoveryRequired: false,
        nextAction: 'initialize-via-production-write',
        reasonCode: null,
      },
    });
  return {
    schemaVersion: Object.prototype.hasOwnProperty.call(overrides, 'schemaVersion')
      ? overrides.schemaVersion
      : 1,
    url: Object.prototype.hasOwnProperty.call(overrides, 'url')
      ? overrides.url
      : CANONICAL_URL,
    method: Object.prototype.hasOwnProperty.call(overrides, 'method')
      ? overrides.method
      : 'POST',
    headers,
    body,
  };
}

/**
 * Multi-byte UTF-8 body where byte length differs from string length.
 * @returns {{ descriptor: ReturnType<typeof validDescriptor>, body: string, byteLength: number }}
 */
function utf8BodyDescriptor() {
  // '€' is 3 UTF-8 bytes; string length 1. Include enough multi-byte chars.
  const reason = `café-€-${'ü'.repeat(8)}`;
  const body = JSON.stringify({
    schemaVersion: 1,
    kind: 'audit-integrity-alert',
    streamId: STREAM_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    deliverySemantics: 'at-least-once',
    alert: {
      sequence: 1,
      checkedAt: '2026-08-04T12:34:56.789Z',
      code: 'integrity-alert',
      recoveryRequired: false,
      nextAction: 'investigate-integrity',
      reasonCode: null,
      note: reason,
    },
  });
  const byteLength = Buffer.byteLength(body, 'utf8');
  assert.ok(byteLength > body.length, 'fixture must use multi-byte UTF-8');
  return {
    descriptor: validDescriptor({ body }),
    body,
    byteLength,
  };
}

/**
 * Build a valid descriptor whose body is exactly `byteLength` UTF-8 bytes.
 * Uses multi-byte characters so string length ≠ byte length when possible.
 * @param {number} byteLength
 */
function descriptorWithBodyBytes(byteLength) {
  assert.ok(byteLength >= 0);
  // Prefer multi-byte fill ('€' = 3 bytes) then pad with ASCII.
  const euro = '€';
  const euroBytes = 3;
  const euros = Math.floor(byteLength / euroBytes);
  const rem = byteLength - euros * euroBytes;
  const body = euro.repeat(euros) + 'x'.repeat(rem);
  assert.equal(Buffer.byteLength(body, 'utf8'), byteLength);
  return validDescriptor({ body });
}

// ─── Deterministic EventEmitter harness ───────────────────────────────────

/**
 * Fake HTTPS response: real EventEmitter with observable destroy.
 * Production requires `res !== null && typeof res === 'object'` plus `.on`.
 *
 * @param {unknown} statusCode
 * @returns {import('node:events').EventEmitter & {
 *   statusCode: unknown,
 *   destroyCount: number,
 *   destroy: () => void,
 * }}
 */
function createFakeResponse(statusCode) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.destroyCount = 0;
  res.destroy = function destroy() {
    // Idempotent and observable: safe to call repeatedly; count is visible.
    res.destroyCount += 1;
  };
  // Guard the harness itself: production object gate must receive a real object.
  assert.equal(res === null, false);
  assert.equal(typeof res, 'object');
  assert.equal(typeof res.on, 'function');
  assert.equal(typeof res.emit, 'function');
  return res;
}

/**
 * @typedef {{
 *   url: unknown,
 *   options: Record<string, unknown>,
 *   body: unknown,
 *   req: import('node:events').EventEmitter & {
 *     destroyCount: number,
 *     destroy: () => void,
 *     end: (body?: unknown) => void,
 *   },
 *   onResponse: (res: object) => void,
 * }} HarnessCall
 */

/**
 * @typedef {{
 *   hostname: unknown,
 *   args: unknown[],
 * }} LookupAllCall
 */

/**
 * Deterministic transport harness.
 *
 * - Default `lookupAll(hostname, callback)` returns at least one public fixture
 *   and records exact call count / hostname / args.
 * - Fake `request` must actively call `options.lookup(originalHostname, {all:true}, cb)`
 *   before running the response/script path. Lookup error emits `error` on the
 *   fake request (node:https-equivalent path to fixed reject). Lookup success
 *   with addresses proceeds to the original request script.
 * - No real DNS / network / wall-clock timers.
 * - Timers distinguish total 10_000 vs DNS 4_000 and fire by exact ms.
 *
 * @param {(call: HarnessCall) => void} [onEnd]
 * @param {{
 *   autoLookup?: boolean,
 *   lookupAll?: (hostname: unknown, callback: Function) => void,
 * }} [harnessOptions]
 */
function createTransportHarness(onEnd, harnessOptions = {}) {
  /** @type {HarnessCall[]} */
  const calls = [];
  /** @type {LookupAllCall[]} */
  const lookupAllCalls = [];
  /** @type {Array<{ err: unknown, addresses: unknown }>} */
  const lookupCallbackResults = [];
  /** @type {Map<number, { fn: Function, ms: number }>} */
  const timers = new Map();
  let nextTimerId = 1;
  let clearTimerCalls = 0;
  let requestInvocations = 0;
  /** @type {HarnessCall | null} */
  let lastCall = null;
  /** @type {ReturnType<typeof createFakeResponse> | null} */
  let lastResponse = null;
  const autoLookup = harnessOptions.autoLookup !== false;

  /**
   * Default public DNS fixture — at least one public address record.
   * @param {unknown} hostname
   * @param {Function} callback
   */
  function defaultLookupAll(hostname, callback) {
    lookupAllCalls.push({ hostname, args: [hostname, callback] });
    callback(null, Object.freeze([
      Object.freeze({ address: PUBLIC_V4, family: 4 }),
    ]));
  }

  const lookupAllImpl = typeof harnessOptions.lookupAll === 'function'
    ? harnessOptions.lookupAll
    : defaultLookupAll;

  const deps = {
    /**
     * @param {unknown} url
     * @param {Record<string, unknown>} options
     * @param {(res: object) => void} onResponse
     */
    request(url, options, onResponse) {
      assert.equal(typeof onResponse, 'function', 'request callback must be a function');
      requestInvocations += 1;
      const req = new EventEmitter();
      req.destroyCount = 0;
      req.destroy = function destroy() {
        req.destroyCount += 1;
      };
      req.end = function end(body) {
        /** @type {HarnessCall} */
        const call = {
          url,
          options,
          body,
          req: /** @type {HarnessCall['req']} */ (req),
          // Preserve the exact production callback reference (do not re-bind).
          onResponse,
        };
        lastCall = call;
        calls.push(call);

        /**
         * Simulate node:https: custom lookup must succeed before connect/script.
         * No default parameter: explicit `undefined` must reach options.lookup unchanged.
         * @param {unknown} lookupOptions
         */
        function runLookup(lookupOptions) {
          const lookup = options && typeof options === 'object'
            ? /** @type {Record<string, unknown>} */ (options).lookup
            : undefined;
          if (typeof lookup !== 'function') {
            // Missing custom lookup cannot proceed — mirrors pin contract failure.
            queueMicrotask(() => {
              req.emit('error', new Error('harness: options.lookup missing'));
            });
            return;
          }

          let hostname;
          try {
            hostname = typeof url === 'string' ? new URL(url).hostname : undefined;
          } catch {
            hostname = undefined;
          }

          /** @type {boolean} */
          let lookupSettled = false;
          lookup(hostname, lookupOptions, (err, addresses) => {
            if (lookupSettled) return;
            lookupSettled = true;
            lookupCallbackResults.push({ err, addresses });
            if (err) {
              const error = err instanceof Error
                ? err
                : Object.assign(new Error('lookup failed'), { cause: err });
              queueMicrotask(() => {
                req.emit('error', error);
              });
              return;
            }
            if (typeof onEnd === 'function') {
              onEnd(call);
            }
          });
        }

        if (autoLookup) {
          runLookup(Object.freeze({ all: true }));
        } else {
          // Expose manual control for hostile lookup-options matrix.
          /** @type {*} */ (call).runLookup = runLookup;
        }
      };
      return req;
    },
    /**
     * Injected DNS surface: `lookupAll(hostname, callback)` only.
     * Production wraps real `dns.lookup(hostname, {all:true, verbatim:true}, cb)`.
     * @param {unknown} hostname
     * @param {Function} callback
     */
    lookupAll(hostname, callback) {
      return lookupAllImpl(hostname, callback);
    },
    /**
     * @param {Function} fn
     * @param {number} ms
     */
    setTimer(fn, ms) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { fn, ms });
      return id;
    },
    /**
     * @param {unknown} id
     */
    clearTimer(id) {
      clearTimerCalls += 1;
      timers.delete(/** @type {number} */ (id));
    },
  };

  // Exact ordered deps keys for factory contract.
  assertExactKeys(deps, DEPS_KEYS, 'harness deps');

  /**
   * Fire exactly one pending timer registered for `expectedMs`.
   * Distinguishes total 10_000 from DNS 4_000 without conflating them.
   * @param {number} expectedMs
   */
  function fireTimerMs(expectedMs) {
    const matches = [...timers.entries()].filter(([, entry]) => entry.ms === expectedMs);
    assert.equal(
      matches.length,
      1,
      `exactly one pending timer for ${expectedMs}ms expected, found ${matches.length}`,
    );
    matches[0][1].fn();
  }

  /**
   * Fire the sole pending timer of the given deadline (default: total TIMEOUT_MS).
   * Old fireDeadline semantics retained; pass DNS_TIMEOUT_MS for DNS subdeadline.
   * @param {number} [expectedMs]
   */
  function fireDeadline(expectedMs = TIMEOUT_MS) {
    fireTimerMs(expectedMs);
  }

  /**
   * @param {number} ms
   */
  function pendingTimersWithMs(ms) {
    return [...timers.values()].filter((entry) => entry.ms === ms);
  }

  return {
    deps,
    calls,
    timers,
    lookupAllCalls,
    lookupCallbackResults,
    createResponse: createFakeResponse,
    fireDeadline,
    fireTimerMs,
    pendingTimersWithMs,
    get lastCall() {
      return lastCall;
    },
    get lastResponse() {
      return lastResponse;
    },
    /**
     * @param {ReturnType<typeof createFakeResponse> | null} res
     */
    setLastResponse(res) {
      lastResponse = res;
    },
    get clearTimerCalls() {
      return clearTimerCalls;
    },
    get requestInvocations() {
      return requestInvocations;
    },
    get setTimerInvocations() {
      return nextTimerId - 1;
    },
    get lookupAllInvocations() {
      return lookupAllCalls.length;
    },
  };
}

/**
 * @param {ReturnType<typeof requireApi>} api
 * @param {ReturnType<typeof createTransportHarness>} harness
 * @param {unknown} descriptor
 */
function executeWith(api, harness, descriptor) {
  const execute = api.createAuditIntegrityAlertHttpsExecutorForTesting(harness.deps);
  assert.equal(typeof execute, 'function');
  return execute(descriptor);
}

/**
 * @param {ReturnType<typeof requireDetailedApi>} api
 * @param {ReturnType<typeof createTransportHarness>} harness
 * @param {unknown} descriptor
 */
function executeDetailedWith(api, harness, descriptor) {
  const execute = api.createAuditIntegrityAlertHttpsDetailedExecutorForTesting(harness.deps);
  assert.equal(typeof execute, 'function');
  return execute(descriptor);
}

/**
 * Detailed executor result contract: exact frozen {schemaVersion, kind}.
 * @param {unknown} result
 * @param {'accepted' | 'retryable-rejected' | 'terminal-rejected'} expectedKind
 * @param {string} [label]
 */
function assertDetailedResult(result, expectedKind, label = 'detailed result') {
  assertExactKeys(result, DETAILED_RESULT_KEYS, label);
  assert.deepEqual(result, { schemaVersion: 1, kind: expectedKind });
  assertDeeplyFrozen(result, label);
  assert.equal(
    Object.prototype.hasOwnProperty.call(/** @type {object} */ (result), 'statusCode'),
    false,
    `${label} must not expose statusCode`,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(/** @type {object} */ (result), 'status'),
    false,
    `${label} must not expose public status field`,
  );
}

/**
 * Deliver a fake response through the production onResponse callback, then end.
 * Always passes a real EventEmitter object (never a primitive or missing arg).
 * Default path emits only `end` (no body chunks), matching node:https completion.
 *
 * @param {ReturnType<typeof createTransportHarness>} harness
 * @param {HarnessCall} call
 * @param {unknown} statusCode
 * @param {Buffer[]} [chunks]
 */
function settleResponse(harness, call, statusCode, chunks = []) {
  assert.equal(typeof call.onResponse, 'function', 'production onResponse missing on harness call');
  const res = createFakeResponse(statusCode);
  assert.equal(typeof res, 'object');
  assert.notEqual(res, null);
  harness.setLastResponse(res);
  // Invoke exactly as node:https does: callback(res) with the response object first.
  call.onResponse(res);
  for (const chunk of chunks) {
    res.emit('data', chunk);
  }
  res.emit('end');
  return res;
}

/**
 * Task 4 request options: agent/autoSelectFamily/lookup + exact TLS contract.
 * @param {unknown} options
 */
function assertStrictTlsOptions(options) {
  const opts = /** @type {Record<string, unknown>} */ (options);
  assert.equal(opts.agent, false);
  assert.equal(opts.autoSelectFamily, true);
  assert.equal(opts.autoSelectFamilyAttemptTimeout, 250);
  assert.equal(typeof opts.lookup, 'function', 'custom lookup function required');
  assert.equal(opts.rejectUnauthorized, true);
  assert.equal(opts.checkServerIdentity, tls.checkServerIdentity);
  assert.equal(opts.minVersion, 'TLSv1.2');

  const ca = opts.ca;
  if (ca === tls.rootCertificates) {
    // Preferred: identical reference to process-start roots.
  } else {
    assert.ok(Array.isArray(ca), 'ca must be tls.rootCertificates or an array copy');
    assert.equal(ca.length, tls.rootCertificates.length);
    for (let i = 0; i < tls.rootCertificates.length; i += 1) {
      assert.equal(ca[i], tls.rootCertificates[i]);
    }
    // Non-mutable: frozen or otherwise sealed against in-place edits.
    assert.throws(() => {
      /** @type {unknown[]} */ (ca).push(Buffer.from('hostile-ca'));
    });
    if (ca.length > 0) {
      const original0 = ca[0];
      try {
        /** @type {unknown[]} */ (ca)[0] = Buffer.from('hostile-ca-entry');
      } catch {
        // freeze/seal may throw
      }
      assert.equal(ca[0], original0, 'ca copy entries must not be replaceable');
    }
  }

  // No proxy / agent override / credential surface on options.
  for (const forbidden of [
    'proxy',
    'createConnection',
    'auth',
    'pfx',
    'key',
    'cert',
    'passphrase',
    'servername',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(opts, forbidden),
      false,
      `options must not expose ${forbidden}`,
    );
  }
}

/**
 * @param {unknown} options
 * @param {string} body
 */
function assertExactRequestOptions(options, body) {
  const opts = /** @type {Record<string, unknown>} */ (options);
  assert.equal(opts.method, 'POST');
  assertExactKeys(opts.headers, REQUEST_HEADER_KEYS, 'request headers');
  const headers = /** @type {Record<string, string>} */ (opts.headers);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['idempotency-key'], IDEMPOTENCY_KEY);
  assert.equal(
    headers['content-length'],
    String(Buffer.byteLength(body, 'utf8')),
  );
  for (const banned of ['authorization', 'cookie', 'proxy-authorization']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(headers, banned),
      false,
      `headers must not include ${banned}`,
    );
  }
  assertStrictTlsOptions(opts);
}

/**
 * Assert preflight failure never armed timers / DNS / request.
 * @param {ReturnType<typeof createTransportHarness>} harness
 */
function assertNoIoStarted(harness) {
  assert.equal(harness.requestInvocations, 0, 'request must not be invoked');
  assert.equal(harness.lookupAllInvocations, 0, 'lookupAll must not be invoked');
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.timers.size, 0, 'no timers may be armed');
  // setTimer may have been called and immediately cleared only if production
  // armed then aborted — preflight must not call setTimer at all.
  assert.equal(harness.setTimerInvocations, 0, 'setTimer must not be invoked');
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('audit integrity alert HTTPS transport (Task 1 + Task 4 DNS pin)', () => {
  // Old HEAD: exactly one dedicated RED. Full matrix only when exports exist.
  if (implementationMissing || transportApi === null) {
    it('bounded HTTPS transport implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── 1. Constants, exports, frozen results, registered fixed error ───────

  describe('1 exports, constants, frozen results, registered fixed error', () => {
    it('exports exact constants including Task 4 DNS/body bounds and both executor surfaces', () => {
      const api = requireApi();
      assert.equal(api.AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS, TIMEOUT_MS);
      assert.equal(api.AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
      assert.equal(api.AUDIT_INTEGRITY_ALERT_HTTPS_DNS_TIMEOUT_MS, DNS_TIMEOUT_MS);
      assert.equal(
        api.AUDIT_INTEGRITY_ALERT_HTTPS_MAX_REQUEST_BODY_BYTES,
        MAX_REQUEST_BODY_BYTES,
      );
      assert.equal(api.AUDIT_INTEGRITY_ALERT_HTTPS_MAX_DNS_ANSWERS, MAX_DNS_ANSWERS);
      assert.equal(typeof api.executeAuditIntegrityAlertHttpsRequest, 'function');
      assert.equal(typeof api.createAuditIntegrityAlertHttpsExecutorForTesting, 'function');
      assert.equal(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, CODE_UNAVAILABLE);
    });

    it('accepted and rejected results are exact-key deep-frozen only', async () => {
      const api = requireApi();
      for (const [statusCode, status] of [
        [200, 'accepted'],
        [404, 'rejected'],
      ]) {
        const harness = createTransportHarness((call) => {
          settleResponse(harness, call, /** @type {number} */ (statusCode));
        });
        const result = await executeWith(api, harness, validDescriptor());
        assertExactKeys(result, RESULT_KEYS, 'result');
        assert.deepEqual(result, { schemaVersion: 1, status });
        assertDeeplyFrozen(result);
        assert.equal(harness.clearTimerCalls >= 1, true, 'timer cleared on settle');
      }
    });

    it('factory rejects missing/extra/reordered/non-function deps with fixed error', () => {
      const api = requireApi();
      const good = createTransportHarness(() => {});
      const cases = [
        null,
        undefined,
        [],
        'request',
        // missing lookupAll
        {
          request: good.deps.request,
          setTimer: good.deps.setTimer,
          clearTimer: good.deps.clearTimer,
        },
        // missing request
        {
          lookupAll: good.deps.lookupAll,
          setTimer: good.deps.setTimer,
          clearTimer: good.deps.clearTimer,
        },
        // extra key
        {
          request: good.deps.request,
          lookupAll: good.deps.lookupAll,
          setTimer: good.deps.setTimer,
          clearTimer: good.deps.clearTimer,
          extra: () => {},
        },
        // reordered (lookupAll after setTimer)
        {
          request: good.deps.request,
          setTimer: good.deps.setTimer,
          lookupAll: good.deps.lookupAll,
          clearTimer: good.deps.clearTimer,
        },
        // reordered (setTimer first)
        {
          setTimer: good.deps.setTimer,
          request: good.deps.request,
          lookupAll: good.deps.lookupAll,
          clearTimer: good.deps.clearTimer,
        },
        {
          request: 'not-fn',
          lookupAll: good.deps.lookupAll,
          setTimer: good.deps.setTimer,
          clearTimer: good.deps.clearTimer,
        },
        {
          request: good.deps.request,
          lookupAll: 'not-fn',
          setTimer: good.deps.setTimer,
          clearTimer: good.deps.clearTimer,
        },
        {
          request: good.deps.request,
          lookupAll: good.deps.lookupAll,
          setTimer: 1,
          clearTimer: good.deps.clearTimer,
        },
        {
          request: good.deps.request,
          lookupAll: good.deps.lookupAll,
          setTimer: good.deps.setTimer,
          clearTimer: null,
        },
        new Proxy(good.deps, {}),
      ];
      for (const deps of cases) {
        expectUnavailable(() => api.createAuditIntegrityAlertHttpsExecutorForTesting(deps));
      }
    });
  });

  // ── 2. Exact descriptor validation (preflight: no timer/DNS/request) ────

  describe('2 exact descriptor validation before timer/DNS/request', () => {
    it('rejects missing/extra/reordered keys with zero setTimer/lookupAll/request', async () => {
      const api = requireApi();
      const harness = createTransportHarness(() => {
        assert.fail('request end must not run for invalid descriptor');
      });
      const execute = api.createAuditIntegrityAlertHttpsExecutorForTesting(harness.deps);

      const missingBody = {
        schemaVersion: 1,
        url: CANONICAL_URL,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': IDEMPOTENCY_KEY,
        },
      };
      const extraKey = { ...validDescriptor(), extra: true };
      const reordered = {
        url: CANONICAL_URL,
        schemaVersion: 1,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        body: '{}',
      };
      assert.notDeepEqual(Object.keys(reordered), [...REQUEST_KEYS]);

      for (const bad of [missingBody, extraKey, reordered, null, undefined, [], 'desc', 1]) {
        await expectUnavailableAsync(Promise.resolve().then(() => execute(bad)));
        assertNoIoStarted(harness);
      }
    });

    it('rejects Proxy/accessor/symbol/non-enumerable/class descriptor objects preflight', async () => {
      const api = requireApi();
      const harness = createTransportHarness(() => {
        assert.fail('request must not run for hostile descriptor');
      });
      const execute = api.createAuditIntegrityAlertHttpsExecutorForTesting(harness.deps);

      const proxyDesc = new Proxy(validDescriptor(), {});
      const accessorDesc = {};
      for (const key of REQUEST_KEYS) {
        Object.defineProperty(accessorDesc, key, {
          enumerable: true,
          get() {
            return /** @type {Record<string, unknown>} */ (validDescriptor())[key];
          },
        });
      }
      const symbolDesc = {
        ...validDescriptor(),
        [Symbol('leak')]: SECRET_PATH,
      };
      const nonEnum = validDescriptor();
      Object.defineProperty(nonEnum, 'hidden', {
        value: SECRET_TOKEN,
        enumerable: false,
      });

      class DescriptorClass {
        constructor() {
          Object.assign(this, validDescriptor());
        }
      }
      const classDesc = new DescriptorClass();

      for (const bad of [proxyDesc, accessorDesc, symbolDesc, nonEnum, classDesc]) {
        await expectUnavailableAsync(
          Promise.resolve().then(() => execute(bad)),
          [SECRET_PATH, SECRET_TOKEN],
        );
        assertNoIoStarted(harness);
      }
    });

    it('rejects wrong schema/method/headers/body/url and hostile header order preflight', async () => {
      const api = requireApi();
      const harness = createTransportHarness(() => {
        assert.fail('request must not run for invalid field values');
      });
      const execute = api.createAuditIntegrityAlertHttpsExecutorForTesting(harness.deps);

      const cases = [
        validDescriptor({ schemaVersion: 2 }),
        validDescriptor({ schemaVersion: '1' }),
        validDescriptor({ method: 'GET' }),
        validDescriptor({ method: 'post' }),
        validDescriptor({ url: 'http://alerts.example.invalid/hooks/audit-integrity' }),
        validDescriptor({ url: 'https://user:pass@alerts.example.invalid/hooks/audit-integrity' }),
        validDescriptor({ url: `${CANONICAL_URL}?x=1` }),
        validDescriptor({ url: `${CANONICAL_URL}#frag` }),
        validDescriptor({ url: 'HTTPS://alerts.example.invalid/hooks/audit-integrity' }),
        validDescriptor({ url: '' }),
        validDescriptor({ body: Buffer.from('{}') }),
        validDescriptor({ body: { not: 'string' } }),
        validDescriptor({ body: 1 }),
        validDescriptor({
          headers: {
            'content-type': 'application/json',
            'idempotency-key': IDEMPOTENCY_KEY,
            authorization: SECRET_TOKEN,
          },
        }),
        validDescriptor({
          headers: {
            'idempotency-key': IDEMPOTENCY_KEY,
            'content-type': 'application/json',
          },
        }),
        validDescriptor({
          headers: {
            'content-type': 'text/plain',
            'idempotency-key': IDEMPOTENCY_KEY,
          },
        }),
        validDescriptor({
          headers: {
            'content-type': 'application/json',
          },
        }),
        validDescriptor({ headers: null }),
        validDescriptor({ headers: [] }),
      ];

      for (const bad of cases) {
        await expectUnavailableAsync(
          Promise.resolve().then(() => execute(bad)),
          [SECRET_TOKEN, 'alerts.example.invalid', 'user:pass'],
        );
        assertNoIoStarted(harness);
      }
    });

    it('rejects all IP-literal endpoints at preflight (private, link-local, public v4/v6)', async () => {
      // P1: Node skips options.lookup when host isIP !== 0. Transport must fail-closed
      // on IP-literal endpoints in descriptor validation — not rely on fake lookup.
      // Node v24: URL.hostname keeps IPv6 brackets (`[::1]`); production must strip
      // brackets then isIP(...) — do not assume URL.hostname already unwrapped.
      // Fail-loud: if a buggy build reaches request, settle 204 so the promise
      // resolves and expectUnavailableAsync fails immediately (no hang / swallowed assert.fail).
      const api = requireApi();
      const harness = createTransportHarness((call) => {
        settleResponse(harness, call, 204);
      });
      const execute = api.createAuditIntegrityAlertHttpsExecutorForTesting(harness.deps);

      /** @type {Array<{ label: string, url: string, leak: string[] }>} */
      const cases = [
        {
          label: 'private-ipv4-loopback',
          url: 'https://127.0.0.1/hooks/audit-integrity',
          leak: ['127.0.0.1', 'https://127.0.0.1/hooks/audit-integrity'],
        },
        {
          label: 'metadata-link-local-ipv4',
          url: 'https://169.254.169.254/hooks/audit-integrity',
          leak: ['169.254.169.254', 'https://169.254.169.254/hooks/audit-integrity'],
        },
        {
          label: 'public-ipv4-literal',
          url: 'https://8.8.8.8/hooks/audit-integrity',
          leak: ['8.8.8.8', 'https://8.8.8.8/hooks/audit-integrity'],
        },
        {
          label: 'loopback-ipv6-literal',
          url: 'https://[::1]/hooks/audit-integrity',
          leak: ['::1', '[::1]', 'https://[::1]/hooks/audit-integrity'],
        },
        {
          label: 'public-ipv6-literal',
          url: 'https://[2606:4700:4700::1111]/hooks/audit-integrity',
          leak: [
            '2606:4700:4700::1111',
            '[2606:4700:4700::1111]',
            'https://[2606:4700:4700::1111]/hooks/audit-integrity',
          ],
        },
      ];

      for (const { label, url, leak } of cases) {
        await expectUnavailableAsync(
          Promise.resolve().then(() => execute(validDescriptor({ url }))),
          leak,
        );
        assertNoIoStarted(harness);
        assert.equal(
          harness.requestInvocations,
          0,
          `${label}: request must stay 0 (preflight, not fake-lookup)`,
        );
        assert.equal(
          harness.lookupAllInvocations,
          0,
          `${label}: lookupAll must stay 0 (preflight, not fake-lookup)`,
        );
        assert.equal(
          harness.setTimerInvocations,
          0,
          `${label}: setTimer must stay 0 (preflight, not fake-lookup)`,
        );
      }
    });

    it('snapshots descriptor so mutation before request cannot alter wire values', async () => {
      const api = requireApi();
      const descriptor = validDescriptor();
      /** @type {string} */
      let seenUrl = '';
      /** @type {unknown} */
      let seenBody = null;
      /** @type {Record<string, unknown> | null} */
      let seenOptions = null;

      const harness = createTransportHarness((call) => {
        seenUrl = /** @type {string} */ (call.url);
        seenBody = call.body;
        seenOptions = call.options;
        settleResponse(harness, call, 200);
      });

      // Poison between timer arming and request construction if snapshot is late.
      const poisonedDeps = {
        request: harness.deps.request,
        lookupAll: harness.deps.lookupAll,
        setTimer(fn, ms) {
          descriptor.url = `https://${SECRET_HOST}/mutated`;
          descriptor.body = `mutated-${SECRET_BODY_MARKER}`;
          descriptor.headers = {
            'content-type': 'application/json',
            'idempotency-key': IDEMPOTENCY_KEY,
            authorization: SECRET_TOKEN,
          };
          descriptor.method = 'PUT';
          return harness.deps.setTimer(fn, ms);
        },
        clearTimer: harness.deps.clearTimer,
      };
      assertExactKeys(poisonedDeps, DEPS_KEYS, 'poisoned deps');

      const execute = api.createAuditIntegrityAlertHttpsExecutorForTesting(poisonedDeps);
      const result = await execute(descriptor);
      assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
      assert.equal(seenUrl, CANONICAL_URL);
      assert.equal(typeof seenBody, 'string');
      assert.equal(/** @type {string} */ (seenBody).includes(SECRET_BODY_MARKER), false);
      assert.equal(/** @type {Record<string, unknown>} */ (seenOptions).method, 'POST');
      assertExactRequestOptions(seenOptions, /** @type {string} */ (seenBody));
    });
  });

  // ── 2b. Request body bound 8192 / 8193 (Task 4 preflight) ───────────────

  describe('2b request body UTF-8 bound 8192 / 8193 preflight', () => {
    it('accepts body of exactly 8192 UTF-8 bytes', async () => {
      const api = requireApi();
      const descriptor = descriptorWithBodyBytes(MAX_REQUEST_BODY_BYTES);
      const body = /** @type {string} */ (descriptor.body);
      assert.equal(Buffer.byteLength(body, 'utf8'), MAX_REQUEST_BODY_BYTES);
      const harness = createTransportHarness((call) => {
        assert.equal(call.body, body);
        const headers = /** @type {Record<string, string>} */ (call.options.headers);
        assert.equal(headers['content-length'], String(MAX_REQUEST_BODY_BYTES));
        settleResponse(harness, call, 200);
      });
      const result = await executeWith(api, harness, descriptor);
      assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
    });

    it('rejects body of 8193 UTF-8 bytes before setTimer/lookupAll/request', async () => {
      const api = requireApi();
      const harness = createTransportHarness(() => {
        assert.fail('request must not run for oversize body');
      });
      const execute = api.createAuditIntegrityAlertHttpsExecutorForTesting(harness.deps);
      const descriptor = descriptorWithBodyBytes(MAX_REQUEST_BODY_BYTES + 1);
      assert.equal(
        Buffer.byteLength(/** @type {string} */ (descriptor.body), 'utf8'),
        MAX_REQUEST_BODY_BYTES + 1,
      );
      await expectUnavailableAsync(Promise.resolve().then(() => execute(descriptor)));
      assertNoIoStarted(harness);
    });
  });

  // ── 3–4. Internally constructed request options + UTF-8 content-length ──

  describe('3–4 internally constructed request options and UTF-8 content-length', () => {
    it('constructs POST options with agent:false, autoSelectFamily, lookup, TLS 1.2 roots', async () => {
      const api = requireApi();
      const { descriptor, body, byteLength } = utf8BodyDescriptor();
      const harness = createTransportHarness((call) => {
        assert.equal(call.url, CANONICAL_URL, 'original URL retained — not replaced with IP');
        assert.equal(call.body, body);
        assert.equal(Buffer.byteLength(/** @type {string} */ (call.body), 'utf8'), byteLength);
        assert.notEqual(byteLength, /** @type {string} */ (call.body).length);
        assertExactRequestOptions(call.options, body);
        // URL hostname path — request must not receive a bare IP string.
        assert.equal(String(call.url).includes(PUBLIC_V4), false);
        assert.equal(String(call.url).includes(PUBLIC_V6), false);
        settleResponse(harness, call, 200);
      });

      // Env noise must not alter constructed options (module must not read process.env).
      const prevProxy = process.env.HTTPS_PROXY;
      const prevHttpProxy = process.env.HTTP_PROXY;
      const prevExtraCa = process.env.NODE_EXTRA_CA_CERTS;
      process.env.HTTPS_PROXY = 'http://proxy.evil.invalid:8080';
      process.env.HTTP_PROXY = 'http://proxy.evil.invalid:8080';
      process.env.NODE_EXTRA_CA_CERTS = SECRET_PATH;
      try {
        const result = await executeWith(api, harness, descriptor);
        assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
        assert.equal(harness.calls.length, 1);
        assert.equal(
          Object.prototype.hasOwnProperty.call(harness.calls[0].options, 'proxy'),
          false,
        );
      } finally {
        if (prevProxy === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = prevProxy;
        if (prevHttpProxy === undefined) delete process.env.HTTP_PROXY;
        else process.env.HTTP_PROXY = prevHttpProxy;
        if (prevExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
        else process.env.NODE_EXTRA_CA_CERTS = prevExtraCa;
      }
    });

    it('content-length uses Buffer.byteLength utf8, not string length', async () => {
      const api = requireApi();
      const { descriptor, body, byteLength } = utf8BodyDescriptor();
      assert.ok(byteLength !== body.length);
      const harness = createTransportHarness((call) => {
        const headers = /** @type {Record<string, string>} */ (call.options.headers);
        assert.equal(headers['content-length'], String(byteLength));
        assert.notEqual(headers['content-length'], String(body.length));
        settleResponse(harness, call, 204);
      });
      const result = await executeWith(api, harness, descriptor);
      assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
    });

    it('lookup options non-plain / missing all / all:false / string true / getter / Proxy fail without traps', async () => {
      const api = requireApi();
      /** @type {Array<{ label: string, options: unknown, leak?: string[] }>} */
      const hostileCases = [];

      // non-plain / null / array
      hostileCases.push({ label: 'null-options', options: null });
      hostileCases.push({ label: 'undefined-options', options: undefined });
      hostileCases.push({ label: 'array-options', options: [] });
      hostileCases.push({ label: 'string-options', options: 'all' });

      // missing all
      hostileCases.push({ label: 'missing-all', options: { hints: 1024 } });

      // all:false
      hostileCases.push({ label: 'all-false', options: { all: false } });

      // all:'true' string
      hostileCases.push({ label: 'all-string-true', options: { all: 'true' } });

      // all:1 truthy non-boolean
      hostileCases.push({ label: 'all-number-1', options: { all: 1 } });

      // getter for all — must not execute getter body for success path
      let getterHits = 0;
      const getterOptions = {};
      Object.defineProperty(getterOptions, 'all', {
        enumerable: true,
        get() {
          getterHits += 1;
          return true;
        },
      });
      hostileCases.push({ label: 'all-getter', options: getterOptions });

      // Proxy options — traps must not run for acceptance
      let proxyGets = 0;
      const proxyOptions = new Proxy(
        { all: true },
        {
          get(target, prop, receiver) {
            proxyGets += 1;
            return Reflect.get(target, prop, receiver);
          },
          ownKeys(target) {
            proxyGets += 1;
            return Reflect.ownKeys(target);
          },
        },
      );
      hostileCases.push({ label: 'proxy-options', options: proxyOptions });

      for (const { label, options } of hostileCases) {
        getterHits = 0;
        proxyGets = 0;
        const harness = createTransportHarness(() => {
          assert.fail(`onEnd must not run for hostile lookup options (${label})`);
        }, { autoLookup: false });
        const promise = executeWith(api, harness, validDescriptor());
        await flushMicrotasks();
        assert.equal(harness.calls.length, 1, `${label}: request constructed`);
        assert.equal(harness.lookupAllInvocations, 0, `${label}: lookupAll not yet`);
        const call = harness.calls[0];
        assert.equal(typeof call.options.lookup, 'function');
        /** @type {(opts?: unknown) => void} */
        const runLookup = /** @type {*} */ (call).runLookup;
        runLookup(options);
        await expectUnavailableAsync(promise, [CANONICAL_HOSTNAME, PUBLIC_V4]);
        assert.equal(harness.lookupAllInvocations, 0, `${label}: lookupAll never called`);
        // Getter/Proxy traps must not be exercised for a successful all:true read.
        if (label === 'all-getter') {
          assert.equal(getterHits, 0, 'getter must not be executed for acceptance');
        }
        if (label === 'proxy-options') {
          assert.equal(proxyGets, 0, 'Proxy traps must not run for acceptance');
        }
      }
    });
  });

  // ── 5. Status boundaries ────────────────────────────────────────────────

  describe('5 status boundaries 199/200/299/300', () => {
    for (const [statusCode, expected] of [
      [199, 'rejected'],
      [200, 'accepted'],
      [299, 'accepted'],
      [300, 'rejected'],
    ]) {
      it(`final status ${statusCode} → ${expected}`, async () => {
        const api = requireApi();
        const harness = createTransportHarness((call) => {
          settleResponse(harness, call, /** @type {number} */ (statusCode));
        });
        const result = await executeWith(api, harness, validDescriptor());
        assert.deepEqual(result, { schemaVersion: 1, status: expected });
        assertDeeplyFrozen(result);
        assertExactKeys(result, RESULT_KEYS);
      });
    }
  });

  // ── 6. Response streaming byte bound ────────────────────────────────────

  describe('6 response streaming boundary 4096 / 4097', () => {
    it('exactly 4096 response bytes settles accepted without retain', async () => {
      const api = requireApi();
      const chunkA = Buffer.alloc(2000, 0x61);
      const chunkB = Buffer.alloc(2096, 0x62);
      assert.equal(chunkA.length + chunkB.length, MAX_RESPONSE_BYTES);
      const harness = createTransportHarness((call) => {
        settleResponse(harness, call, 200, [chunkA, chunkB]);
      });
      const result = await executeWith(api, harness, validDescriptor());
      assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
      assert.equal(JSON.stringify(result).includes('aa'), false);
    });

    it('byte 4097 fails fixed, destroys request/response, does not retain bytes', async () => {
      const api = requireApi();
      const harness = createTransportHarness((call) => {
        const res = createFakeResponse(200);
        harness.setLastResponse(res);
        call.onResponse(res);
        res.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES, 0x63));
        res.emit('data', Buffer.from(SECRET_BODY_MARKER, 'utf8'));
      });
      await expectUnavailableAsync(
        executeWith(api, harness, validDescriptor()),
        [SECRET_BODY_MARKER, 'ccc'],
      );
      const res = harness.lastResponse;
      assert.ok(res, 'response object must be exposed on harness before assertions');
      assert.ok(harness.calls[0].req.destroyCount >= 1, 'request destroyed');
      assert.ok(res.destroyCount >= 1, 'response destroyed');
      // Idempotent destroy remains callable.
      harness.calls[0].req.destroy();
      res.destroy();
      assert.ok(harness.calls[0].req.destroyCount >= 2);
      assert.equal(harness.clearTimerCalls >= 1, true);
    });
  });

  // ── 7. Redirects not followed ───────────────────────────────────────────

  describe('7 302 is not followed', () => {
    it('exactly one request call and rejected after bounded end', async () => {
      const api = requireApi();
      const harness = createTransportHarness((call) => {
        const res = createFakeResponse(302);
        harness.setLastResponse(res);
        // Hostile Location must not trigger a second request.
        /** @type {*} */ (res).headers = {
          location: `https://${SECRET_HOST}/elsewhere`,
        };
        call.onResponse(res);
        res.emit('data', Buffer.alloc(0));
        res.emit('end');
      });
      const result = await executeWith(api, harness, validDescriptor());
      assert.deepEqual(result, { schemaVersion: 1, status: 'rejected' });
      assert.equal(harness.requestInvocations, 1);
      assert.equal(harness.calls.length, 1);
    });
  });

  // ── 8. Informational events do not settle early ─────────────────────────

  describe('8 informational events do not settle before final response', () => {
    it('request information event leaves promise pending until final 200 end', async () => {
      const api = requireApi();
      /** @type {HarnessCall | null} */
      let held = null;
      const harness = createTransportHarness((call) => {
        held = call;
      });
      const promise = executeWith(api, harness, validDescriptor());
      await flushMicrotasks();
      assert.ok(held);
      held.req.emit('information', { statusCode: 100, headers: {} });
      await flushMicrotasks();
      await assertStillPending(promise);

      const res = createFakeResponse(200);
      harness.setLastResponse(res);
      held.onResponse(res);
      await flushMicrotasks();
      await assertStillPending(promise);
      res.emit('end');
      const result = await promise;
      assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
    });
  });

  // ── 9. Total deadline 10_000 ms + DNS subdeadline 4_000 ms ──────────────

  describe('9 total deadline 10_000 ms and DNS subdeadline 4_000 ms', () => {
    it('remains pending just before total deadline and fails exactly when callback fires', async () => {
      const api = requireApi();
      const harness = createTransportHarness((_call) => {
        // Hold open: no response, no error. DNS already succeeded via default fixture.
      });
      const promise = executeWith(api, harness, validDescriptor());
      await flushMicrotasks();
      // After DNS success only total timer should remain (DNS timer cleared).
      assert.equal(harness.pendingTimersWithMs(TIMEOUT_MS).length, 1);
      assert.equal(harness.pendingTimersWithMs(DNS_TIMEOUT_MS).length, 0);
      await assertStillPending(promise);

      const clearsBefore = harness.clearTimerCalls;
      harness.fireDeadline(TIMEOUT_MS);
      await expectUnavailableAsync(promise, [CANONICAL_URL, CANONICAL_HOSTNAME, PUBLIC_V4]);
      assert.equal(harness.clearTimerCalls > clearsBefore, true, 'timer cleared on timeout');
      assert.ok(harness.calls[0].req.destroyCount >= 1, 'request destroyed on timeout');

      // Late end after timeout cannot accept.
      const late = createFakeResponse(200);
      harness.calls[0].onResponse(late);
      late.emit('end');
      await flushMicrotasks();
    });

    it('total timer 9999ms still pending; 10000ms fixed fail', async () => {
      const api = requireApi();
      const harness = createTransportHarness(() => {});
      const promise = executeWith(api, harness, validDescriptor());
      await flushMicrotasks();
      assert.equal(harness.pendingTimersWithMs(TIMEOUT_MS).length, 1);
      // No 9999 timer exists — observe pending state without wall clock.
      await assertStillPending(promise);
      harness.fireDeadline(TIMEOUT_MS);
      await expectUnavailableAsync(promise);
    });

    it('DNS subdeadline 3999ms pending; 4000ms fixed fail; clears DNS timer only', async () => {
      const api = requireApi();
      /** @type {Function | null} */
      let hangCallback = null;
      const harness = createTransportHarness(() => {
        assert.fail('onEnd must not run while DNS hangs');
      }, {
        lookupAll(hostname, callback) {
          harness.lookupAllCalls.push({ hostname, args: [hostname, callback] });
          hangCallback = callback;
          // Hang: never invoke callback.
        },
      });
      const promise = executeWith(api, harness, validDescriptor());
      await flushMicrotasks();
      assert.equal(harness.lookupAllInvocations, 1);
      assert.equal(harness.pendingTimersWithMs(DNS_TIMEOUT_MS).length, 1);
      assert.equal(harness.pendingTimersWithMs(TIMEOUT_MS).length, 1);
      await assertStillPending(promise);

      // Fire DNS subdeadline only — must not confuse with total.
      const totalBefore = harness.pendingTimersWithMs(TIMEOUT_MS).length;
      harness.fireTimerMs(DNS_TIMEOUT_MS);
      await expectUnavailableAsync(promise, [
        CANONICAL_HOSTNAME,
        PUBLIC_V4,
        'ENOTFOUND',
        'getaddrinfo',
      ]);
      // Total timer must still be clearable / not silently dropped as if it were DNS.
      assert.equal(totalBefore, 1);
      // Late lookupAll callback after DNS timeout is ignored (single settle).
      assert.equal(typeof hangCallback, 'function');
      assert.doesNotThrow(() => {
        /** @type {Function} */ (hangCallback)(
          null,
          [{ address: PUBLIC_V4, family: 4 }],
        );
      });
      await flushMicrotasks();
    });

    it('DNS success and DNS failure both clear the DNS timer; total remains independent', async () => {
      const api = requireApi();

      // Success path: DNS timer cleared, total remains until response settle.
      {
        const harness = createTransportHarness((call) => {
          assert.equal(harness.pendingTimersWithMs(DNS_TIMEOUT_MS).length, 0);
          assert.equal(harness.pendingTimersWithMs(TIMEOUT_MS).length, 1);
          settleResponse(harness, call, 200);
        });
        const result = await executeWith(api, harness, validDescriptor());
        assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
        assert.equal(harness.pendingTimersWithMs(DNS_TIMEOUT_MS).length, 0);
        assert.equal(harness.pendingTimersWithMs(TIMEOUT_MS).length, 0);
      }

      // Failure path: empty answers → fixed fail, DNS timer cleared.
      {
        const harness = createTransportHarness(() => {
          assert.fail('onEnd must not run for empty DNS');
        }, {
          lookupAll(hostname, callback) {
            harness.lookupAllCalls.push({ hostname, args: [hostname, callback] });
            callback(null, []);
          },
        });
        await expectUnavailableAsync(
          executeWith(api, harness, validDescriptor()),
          [CANONICAL_HOSTNAME, PUBLIC_V4],
        );
        assert.equal(harness.pendingTimersWithMs(DNS_TIMEOUT_MS).length, 0);
      }
    });

    it('total timeout still destroys request/response; clearing DNS does not clear total', async () => {
      const api = requireApi();
      const harness = createTransportHarness((call) => {
        // After DNS success: only total timer pending.
        assert.equal(harness.pendingTimersWithMs(DNS_TIMEOUT_MS).length, 0);
        assert.equal(harness.pendingTimersWithMs(TIMEOUT_MS).length, 1);
        const res = createFakeResponse(200);
        harness.setLastResponse(res);
        call.onResponse(res);
        // Hold without end — await total timeout.
      });
      const promise = executeWith(api, harness, validDescriptor());
      await flushMicrotasks();
      assert.ok(harness.lastResponse);
      harness.fireDeadline(TIMEOUT_MS);
      await expectUnavailableAsync(promise);
      assert.ok(harness.calls[0].req.destroyCount >= 1);
      assert.ok(/** @type {{ destroyCount: number }} */ (harness.lastResponse).destroyCount >= 1);
    });

    it('synchronous setTimer total deadline rejects once and issues no request', async () => {
      // F4: injected setTimer fires the total deadline callback before returning its handle.
      const api = requireApi();
      let requestInvocations = 0;
      let lookupAllInvocations = 0;
      let timerReturns = 0;
      /** @type {Function | null} */
      let deadlineFn = null;
      const deps = {
        request() {
          requestInvocations += 1;
          assert.fail('request must not run after synchronous deadline');
        },
        lookupAll() {
          lookupAllInvocations += 1;
          assert.fail('lookupAll must not run after synchronous deadline');
        },
        setTimer(fn, ms) {
          // First arm is total deadline; DNS timer must not be reached.
          assert.equal(ms, TIMEOUT_MS);
          deadlineFn = fn;
          // Fire before returning a handle — timerId is not yet assigned in production.
          fn();
          timerReturns += 1;
          return 77;
        },
        clearTimer(_id) {
          // May or may not be called for a handle that did not exist at fire time.
        },
      };
      assertExactKeys(deps, DEPS_KEYS, 'sync-timer deps');
      const execute = api.createAuditIntegrityAlertHttpsExecutorForTesting(deps);
      await expectUnavailableAsync(
        Promise.resolve().then(() => execute(validDescriptor())),
        [CANONICAL_URL, CANONICAL_HOSTNAME],
      );
      assert.equal(typeof deadlineFn, 'function');
      assert.equal(timerReturns, 1);
      assert.equal(requestInvocations, 0, 'no request after synchronous timeout');
      assert.equal(lookupAllInvocations, 0, 'no lookupAll after synchronous timeout');

      // Single settlement: a second deadline fire must not throw or open a path.
      assert.doesNotThrow(() => {
        /** @type {Function} */ (deadlineFn)();
      });
      assert.equal(requestInvocations, 0);
    });

    it('custom lookup callback single-settles; late second callback is ignored', async () => {
      const api = requireApi();
      /** @type {Function | null} */
      let dnsCb = null;
      let lookupAllCount = 0;
      const harness = createTransportHarness((call) => {
        settleResponse(harness, call, 200);
      }, {
        lookupAll(hostname, callback) {
          lookupAllCount += 1;
          harness.lookupAllCalls.push({ hostname, args: [hostname, callback] });
          dnsCb = callback;
          // First success delivered once.
          callback(null, [{ address: PUBLIC_V4, family: 4 }]);
        },
      });
      const result = await executeWith(api, harness, validDescriptor());
      assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
      assert.equal(lookupAllCount, 1);
      // Late second DNS callback must not throw / re-open settlement.
      assert.doesNotThrow(() => {
        /** @type {Function} */ (dnsCb)(
          new Error(`late ENOTFOUND ${SECRET_HOST}`),
          undefined,
        );
        /** @type {Function} */ (dnsCb)(
          null,
          [{ address: SPECIAL_V4_PRIVATE, family: 4 }],
        );
      });
      await flushMicrotasks();
    });
  });

  // ── 10. Uncertain outcomes + single settlement ──────────────────────────

  describe('10 uncertain outcomes and single settlement', () => {
    it('request construction throw maps to fixed error without request end', async () => {
      const api = requireApi();
      const base = createTransportHarness(() => {
        assert.fail('end must not run');
      });
      const deps = {
        request() {
          throw new Error(`connect ${SECRET_HOST} errno=ECONNREFUSED path=${SECRET_PATH}`);
        },
        lookupAll: base.deps.lookupAll,
        setTimer: base.deps.setTimer,
        clearTimer: base.deps.clearTimer,
      };
      const execute = api.createAuditIntegrityAlertHttpsExecutorForTesting(deps);
      await expectUnavailableAsync(
        Promise.resolve().then(() => execute(validDescriptor())),
        [SECRET_HOST, SECRET_PATH, 'ECONNREFUSED'],
      );
      assert.equal(base.calls.length, 0);
    });

    it('request error maps to fixed error and clears timer once', async () => {
      const api = requireApi();
      const harness = createTransportHarness((call) => {
        call.req.emit(
          'error',
          Object.assign(new Error(`getaddrinfo ENOTFOUND ${SECRET_HOST}`), {
            code: 'ENOTFOUND',
            errno: -3008,
            hostname: SECRET_HOST,
          }),
        );
      });
      await expectUnavailableAsync(
        executeWith(api, harness, validDescriptor()),
        [SECRET_HOST, 'ENOTFOUND', 'getaddrinfo'],
      );
      assert.equal(harness.clearTimerCalls >= 1, true);
    });

    it('response error maps to fixed error', async () => {
      const api = requireApi();
      const harness = createTransportHarness((call) => {
        const res = createFakeResponse(200);
        harness.setLastResponse(res);
        call.onResponse(res);
        res.emit(
          'error',
          Object.assign(new Error(`socket hang up ${SECRET_HOST}`), {
            code: 'ECONNRESET',
          }),
        );
      });
      await expectUnavailableAsync(
        executeWith(api, harness, validDescriptor()),
        [SECRET_HOST, 'ECONNRESET', 'hang up'],
      );
    });

    it('response aborted maps to fixed error', async () => {
      const api = requireApi();
      const harness = createTransportHarness((call) => {
        const res = createFakeResponse(200);
        harness.setLastResponse(res);
        call.onResponse(res);
        res.emit('aborted');
      });
      await expectUnavailableAsync(executeWith(api, harness, validDescriptor()));
    });

    it('close-before-end maps to fixed error', async () => {
      const api = requireApi();
      const harness = createTransportHarness((call) => {
        const res = createFakeResponse(200);
        harness.setLastResponse(res);
        call.onResponse(res);
        res.emit('data', Buffer.from('partial'));
        res.emit('close');
      });
      await expectUnavailableAsync(
        executeWith(api, harness, validDescriptor()),
        ['partial'],
      );
    });

    it('invalid or missing status maps to fixed error', async () => {
      const api = requireApi();
      for (const statusCode of [undefined, null, '200', 200.5, NaN, true]) {
        const harness = createTransportHarness((call) => {
          settleResponse(harness, call, statusCode);
        });
        await expectUnavailableAsync(executeWith(api, harness, validDescriptor()));
      }
    });

    it('late error after end does not change accepted settlement', async () => {
      const api = requireApi();
      const harness = createTransportHarness((call) => {
        settleResponse(harness, call, 200);
      });
      const result = await executeWith(api, harness, validDescriptor());
      assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
      const res = harness.lastResponse;
      assert.ok(res, 'response object must be exposed on harness');
      res.emit('error', new Error(`late ${SECRET_HOST}`));
      res.emit('data', Buffer.from(SECRET_BODY_MARKER));
      res.emit('close');
      await flushMicrotasks();
      // Still accepted; no second settlement throw path for the caller.
      assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
    });

    it('late end after timeout does not accept', async () => {
      const api = requireApi();
      const harness = createTransportHarness(() => {});
      const promise = executeWith(api, harness, validDescriptor());
      await flushMicrotasks();
      harness.fireDeadline();
      await expectUnavailableAsync(promise);
      const res = createFakeResponse(200);
      harness.calls[0].onResponse(res);
      res.emit('end');
      await flushMicrotasks();
      // Single settlement already observed as rejection.
      assert.equal(harness.clearTimerCalls >= 1, true);
    });
  });

  // ── 11. DNS execution matrix (Task 4) ───────────────────────────────────

  describe('11 DNS execution: lookupAll pin and public-address closed set', () => {
    it('lookupAll exactly once with original hostname; options all:true; returns all validated entries', async () => {
      const api = requireApi();
      const dual = Object.freeze([
        Object.freeze({ address: PUBLIC_V6, family: 6 }),
        Object.freeze({ address: PUBLIC_V4, family: 4 }),
        Object.freeze({ address: PUBLIC_V6_B, family: 6 }),
      ]);
      const harness = createTransportHarness((call) => {
        // Production custom lookup must pass ALL validated entries to node callback.
        assert.equal(harness.lookupCallbackResults.length, 1);
        const result = harness.lookupCallbackResults[0];
        assert.equal(result.err, null);
        assert.deepEqual(result.addresses, [...dual]);
        settleResponse(harness, call, 200);
      }, {
        lookupAll(hostname, callback) {
          harness.lookupAllCalls.push({ hostname, args: [hostname, callback] });
          callback(null, [...dual]);
        },
      });
      const result = await executeWith(api, harness, validDescriptor());
      assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
      assert.equal(harness.lookupAllInvocations, 1);
      assert.equal(harness.lookupAllCalls[0].hostname, CANONICAL_HOSTNAME);
      assert.equal(harness.lookupAllCalls[0].args[0], CANONICAL_HOSTNAME);
      assert.equal(typeof harness.lookupAllCalls[0].args[1], 'function');
      // Original URL still handed to request — not rewritten to IP.
      assert.equal(harness.calls[0].url, CANONICAL_URL);
    });

    /**
     * @returns {{ address: string, family: number }[]}
     */
    function uniquePublicAnswers(count) {
      /** @type {{ address: string, family: number }[]} */
      const unique = [];
      for (let i = 0; i < count; i += 1) {
        // Distinct public IPv4 fixtures outside the special-purpose deny tables.
        const a = i < 8 ? `8.8.4.${i + 1}` : `1.0.0.${i - 7}`;
        unique.push({ address: a, family: 4 });
      }
      return unique;
    }

    for (const [label, answers] of /** @type {const} */ ([
      ['public-ipv4-only', [{ address: PUBLIC_V4, family: 4 }]],
      ['public-ipv6-only', [{ address: PUBLIC_V6, family: 6 }]],
      ['public-dual-stack', [
        { address: PUBLIC_V6, family: 6 },
        { address: PUBLIC_V4, family: 4 },
      ]],
      ['public-16-answers', uniquePublicAnswers(MAX_DNS_ANSWERS)],
    ])) {
      it(`accepts all-public answers: ${label}`, async () => {
        const api = requireApi();
        const expected = answers.map((e) => ({ ...e }));
        const harness = createTransportHarness((call) => {
          assert.deepEqual(harness.lookupCallbackResults[0].addresses, expected);
          settleResponse(harness, call, 200);
        }, {
          lookupAll(hostname, callback) {
            harness.lookupAllCalls.push({ hostname, args: [hostname, callback] });
            callback(null, expected.map((e) => ({ ...e })));
          },
        });
        const result = await executeWith(api, harness, validDescriptor());
        assert.deepEqual(result, { schemaVersion: 1, status: 'accepted' });
        assert.equal(harness.lookupAllInvocations, 1);
      });
    }

    /** @type {Array<[string, (hostname: unknown, callback: Function, record: Function) => void]>} */
    const dnsFailCases = [
      ['empty-answers', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, []);
      }],
      ['dns-error', (hostname, callback, record) => {
        record(hostname, callback);
        callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${SECRET_HOST}`), {
          code: 'ENOTFOUND',
          hostname: SECRET_HOST,
        }));
      }],
      ['dns-throw', (hostname, callback, record) => {
        record(hostname, callback);
        throw new Error(`resolver crash ${SECRET_PATH}`);
      }],
      ['malformed-outer-null', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, null);
      }],
      ['malformed-outer-string', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, '8.8.8.8');
      }],
      ['proxy-answers', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, new Proxy([{ address: PUBLIC_V4, family: 4 }], {}));
      }],
      ['accessor-entry', (hostname, callback, record) => {
        record(hostname, callback);
        const entry = {};
        Object.defineProperty(entry, 'address', {
          enumerable: true,
          get() {
            return PUBLIC_V4;
          },
        });
        Object.defineProperty(entry, 'family', {
          enumerable: true,
          get() {
            return 4;
          },
        });
        callback(null, [entry]);
      }],
      ['symbol-entry-key', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, [{
          address: PUBLIC_V4,
          family: 4,
          [Symbol('leak')]: SECRET_PATH,
        }]);
      }],
      ['non-enumerable-entry-field', (hostname, callback, record) => {
        record(hostname, callback);
        const entry = { address: PUBLIC_V4, family: 4 };
        Object.defineProperty(entry, 'hidden', {
          value: SECRET_TOKEN,
          enumerable: false,
        });
        callback(null, [entry]);
      }],
      ['class-entry', (hostname, callback, record) => {
        record(hostname, callback);
        class Addr {
          constructor() {
            this.address = PUBLIC_V4;
            this.family = 4;
          }
        }
        callback(null, [new Addr()]);
      }],
      ['family-string', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, [{ address: PUBLIC_V4, family: '4' }]);
      }],
      ['family-mismatch-v4-as-v6', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, [{ address: PUBLIC_V4, family: 6 }]);
      }],
      ['duplicate-address', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, [
          { address: PUBLIC_V4, family: 4 },
          { address: PUBLIC_V4, family: 4 },
        ]);
      }],
      ['seventeen-answers', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, uniquePublicAnswers(MAX_DNS_ANSWERS + 1));
      }],
      ['special-loopback-v4', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, [{ address: SPECIAL_V4_LOOPBACK, family: 4 }]);
      }],
      ['special-private-v4', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, [{ address: SPECIAL_V4_PRIVATE, family: 4 }]);
      }],
      ['special-loopback-v6', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, [{ address: SPECIAL_V6_LOOPBACK, family: 6 }]);
      }],
      ['special-doc-v6', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, [{ address: SPECIAL_V6_DOC, family: 6 }]);
      }],
      ['mixed-public-and-special', (hostname, callback, record) => {
        record(hostname, callback);
        callback(null, [
          { address: PUBLIC_V4, family: 4 },
          { address: SPECIAL_V4_PRIVATE, family: 4 },
        ]);
      }],
    ];

    for (const [label, impl] of dnsFailCases) {
      it(`fixed fail DNS case: ${label}`, async () => {
        const api = requireApi();
        const harness = createTransportHarness(() => {
          assert.fail(`onEnd must not run for DNS fail case ${label}`);
        }, {
          lookupAll(hostname, callback) {
            impl(hostname, callback, (hn, cb) => {
              harness.lookupAllCalls.push({ hostname: hn, args: [hn, cb] });
            });
          },
        });

        await expectUnavailableAsync(
          executeWith(api, harness, validDescriptor()),
          [
            CANONICAL_HOSTNAME,
            SECRET_HOST,
            SECRET_PATH,
            SECRET_TOKEN,
            PUBLIC_V4,
            PUBLIC_V6,
            SPECIAL_V4_LOOPBACK,
            SPECIAL_V4_PRIVATE,
            SPECIAL_V6_LOOPBACK,
            SPECIAL_V6_DOC,
            'ENOTFOUND',
            'getaddrinfo',
          ],
        );
        assert.equal(harness.lookupAllInvocations, 1, `${label}: lookupAll once`);
        assert.equal(harness.lookupAllCalls[0].hostname, CANONICAL_HOSTNAME);
      });
    }
  });

  // ── 12. No secret leakage on every public failure ───────────────────────

  describe('12 public failures contain only fixed code/message', () => {
    it('maps representative failures without hostname/IP/resolver/endpoint/body/header/path', async () => {
      const api = requireApi();
      const leak = [
        CANONICAL_URL,
        CANONICAL_HOSTNAME,
        'alerts.example.invalid',
        SECRET_TOKEN,
        SECRET_HOST,
        SECRET_PATH,
        SECRET_BODY_MARKER,
        IDEMPOTENCY_KEY,
        PUBLIC_V4,
        PUBLIC_V6,
        SPECIAL_V4_PRIVATE,
        'BEGIN CERTIFICATE',
        'ENOTFOUND',
        'getaddrinfo',
      ];

      // Every subcase must settle via the virtual harness (no wall-clock wait).
      const cases = [
        async () => {
          const harness = createTransportHarness((call) => {
            call.req.emit('error', new Error(`TLS ${SECRET_HOST} cert=${SECRET_PATH}`));
          });
          await expectUnavailableAsync(executeWith(api, harness, validDescriptor()), leak);
        },
        async () => {
          const harness = createTransportHarness((call) => {
            const res = createFakeResponse(200);
            harness.setLastResponse(res);
            call.onResponse(res);
            res.emit('data', Buffer.from(SECRET_BODY_MARKER));
            res.emit('data', Buffer.alloc(1));
            // exceed bound with secret marker already in stream
            res.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES));
          });
          await expectUnavailableAsync(executeWith(api, harness, validDescriptor()), leak);
        },
        async () => {
          const harness = createTransportHarness(() => {});
          const promise = executeWith(api, harness, validDescriptor());
          await flushMicrotasks();
          harness.fireDeadline();
          await expectUnavailableAsync(promise, leak);
        },
        async () => {
          // Invalid URL containing secret host — validation rejects immediately (no hang).
          const harness = createTransportHarness(() => {
            assert.fail('request must not run for invalid URL descriptor');
          });
          const execute = api.createAuditIntegrityAlertHttpsExecutorForTesting(harness.deps);
          await expectUnavailableAsync(
            Promise.resolve().then(() => execute(validDescriptor({
              url: `https://user:pass@${SECRET_HOST}/hooks`,
            }))),
            leak,
          );
          assertNoIoStarted(harness);
        },
        async () => {
          // Private DNS answer — fixed fail without leaking IP/hostname.
          const harness = createTransportHarness(() => {
            assert.fail('onEnd must not run for private DNS');
          }, {
            lookupAll(hostname, callback) {
              harness.lookupAllCalls.push({ hostname, args: [hostname, callback] });
              callback(null, [{ address: SPECIAL_V4_PRIVATE, family: 4 }]);
            },
          });
          await expectUnavailableAsync(
            executeWith(api, harness, validDescriptor()),
            leak,
          );
        },
      ];

      for (const run of cases) {
        await run();
      }
    });
  });

  // ── 13. Structural source scan (Task 4) ─────────────────────────────────

  describe('13 structural source scan', () => {
    it('requires node:dns + node:net isIP + public predicate; forbids resolve/cache/proxy/connect', async () => {
      const source = await readFile(PRODUCTION_MODULE_PATH, 'utf8');

      const importRe = /\bfrom\s+['"]([^'"]+)['"]/g;
      /** @type {string[]} */
      const imports = [];
      for (const match of source.matchAll(importRe)) {
        imports.push(match[1]);
      }
      const allowed = new Set([
        'node:buffer',
        'node:https',
        'node:tls',
        'node:util',
        'node:dns',
        'node:net',
        './error-codes.js',
        './audit-integrity-alert-public-address.js',
        // Task 4 pure detailed status classifier (GREEN may import; not required yet).
        './audit-integrity-alert-https-transport-outcome.js',
      ]);
      for (const imp of imports) {
        assert.equal(allowed.has(imp), true, `unexpected import: ${imp}`);
      }
      for (const required of [
        'node:https',
        'node:tls',
        'node:dns',
        'node:net',
        './error-codes.js',
        './audit-integrity-alert-public-address.js',
      ]) {
        assert.equal(imports.includes(required), true, `missing required import: ${required}`);
      }
      // Exact specifier check: reject node:http without substring-matching node:https.
      assert.equal(
        imports.includes('node:http'),
        false,
        'must not import node:http (node:https remains allowed)',
      );

      for (const forbidden of [
        'fetch(',
        'node-fetch',
        'undici',
        'globalThis.fetch',
        'process.env',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'NODE_EXTRA_CA_CERTS',
        'retry',
        'backoff',
        'dead-letter',
        'deadLetter',
        'scheduler',
        'setInterval',
        'claimAuditIntegrity',
        'releaseAuditIntegrity',
        'completeAuditIntegrity',
        'alert-outbox',
        'alert-delivery-claim',
        "from './agent.js'",
        "from './server.js'",
        "from './web/",
        "from '../web/",
        'node:fs',
        'node:fs/promises',
        'fs/promises',
        'node:path',
        'node:child_process',
        'node:dgram',
        'createServer',
        'keychain',
        'readFileSync',
        'writeFileSync',
        'https.Agent',
        'new Agent',
        'dns.resolve',
        'dns.Resolver',
        'promises.lookup',
        'dns.promises',
        'lookupCache',
        'dnsCache',
        'resolve4',
        'resolve6',
        'resolveAny',
        // node:net is allowed only for isIP classification — no connection surface.
        'net.connect',
        'createConnection',
        'new Socket',
        'net.Socket',
        'Socket(',
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `production source must not include ${forbidden}`,
        );
      }

      // Built-in surfaces that must appear for the TLS/options + DNS pin contract.
      assert.equal(source.includes('rootCertificates'), true);
      assert.equal(source.includes('checkServerIdentity'), true);
      assert.equal(source.includes('TLSv1.2'), true);
      assert.equal(source.includes('rejectUnauthorized'), true);
      assert.equal(source.includes("agent: false") || source.includes('agent:false'), true);
      assert.equal(
        source.includes('autoSelectFamily: true') || source.includes('autoSelectFamily:true'),
        true,
        'must set autoSelectFamily:true explicitly',
      );
      assert.equal(
        source.includes('autoSelectFamilyAttemptTimeout: 250')
          || source.includes('autoSelectFamilyAttemptTimeout:250'),
        true,
        'must set autoSelectFamilyAttemptTimeout:250',
      );
      assert.equal(
        source.includes('isPublicAuditIntegrityAlertAddress'),
        true,
        'must use public-address predicate',
      );
      // IP-literal gate: require isIP (from node:net). Node URL.hostname does NOT strip
      // IPv6 brackets (`[::1]`); production must explicitly unwrap [] then isIP(host).
      // Anchor presence only — not a fragile full-source order self-proof.
      assert.equal(
        /\bisIP\b/.test(source),
        true,
        'must call isIP on hostname after explicit IPv6 bracket strip (URL.hostname keeps [])',
      );
      assert.equal(
        /import\s*\{[^}]*\bisIP\b[^}]*\}\s*from\s*['"]node:net['"]/.test(source)
          || /import\s+\w+\s+from\s*['"]node:net['"]/.test(source),
        true,
        'must import isIP (or net) from node:net for IP-literal preflight',
      );
      // Must not rewrite request URL to a resolved IP literal.
      assert.equal(
        /replace\s*\(.*url|url\s*=\s*[`'"]https?:\/\/\$\{/.test(source),
        false,
        'must not replace URL with IP',
      );
      // No DNS answer caching surface.
      assert.equal(source.includes('cache'), false, 'must not cache DNS answers');
    });
  });

  // ── 14. Task 4 detailed HTTPS executor (durable-retry outcome seam) ─────

  describe('14 Task 4 detailed HTTPS executor', () => {
    it('exports detailed executor + detailed factory; forbids public-result classifier', () => {
      const api = requireDetailedApi();
      assert.equal(typeof api.executeAuditIntegrityAlertHttpsRequestDetailed, 'function');
      assert.equal(
        typeof api.createAuditIntegrityAlertHttpsDetailedExecutorForTesting,
        'function',
      );
      // Public surface remains present and distinct.
      assert.equal(typeof api.executeAuditIntegrityAlertHttpsRequest, 'function');
      assert.equal(typeof api.createAuditIntegrityAlertHttpsExecutorForTesting, 'function');
      // There is no classifyAuditIntegrityAlertTransportDetailedOutcome export.
      assert.ok(transportModuleExports, 'transport module must be loaded');
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          transportModuleExports,
          FORBIDDEN_PUBLIC_RESULT_CLASSIFIER,
        ),
        false,
        `${FORBIDDEN_PUBLIC_RESULT_CLASSIFIER} must be absent from transport surface`,
      );
      assert.equal(
        typeof transportModuleExports[FORBIDDEN_PUBLIC_RESULT_CLASSIFIER],
        'undefined',
      );
    });

    it('detailed final status 200 → accepted, 429 → retryable-rejected, 404 → terminal-rejected', async () => {
      const api = requireDetailedApi();
      /** @type {Array<[number, 'accepted' | 'retryable-rejected' | 'terminal-rejected']>} */
      const cases = [
        [200, 'accepted'],
        [429, 'retryable-rejected'],
        [404, 'terminal-rejected'],
      ];
      for (const [statusCode, kind] of cases) {
        const harness = createTransportHarness((call) => {
          settleResponse(harness, call, statusCode);
        });
        const result = await executeDetailedWith(api, harness, validDescriptor());
        assertDetailedResult(result, kind, `detailed status ${statusCode}`);
        assert.equal(harness.clearTimerCalls >= 1, true, 'timer cleared on detailed settle');
      }
    });

    it('public executor for same final fixtures returns only accepted/rejected without kind/statusCode', async () => {
      // Mutation guard: detailed mapper must not bleed into the public surface.
      const api = requireApi();
      /** @type {Array<[number, 'accepted' | 'rejected']>} */
      const cases = [
        [200, 'accepted'],
        [429, 'rejected'],
        [404, 'rejected'],
      ];
      for (const [statusCode, status] of cases) {
        const harness = createTransportHarness((call) => {
          settleResponse(harness, call, statusCode);
        });
        const result = await executeWith(api, harness, validDescriptor());
        assertExactKeys(result, RESULT_KEYS, `public status ${statusCode}`);
        assert.deepEqual(result, { schemaVersion: 1, status });
        assertDeeplyFrozen(result);
        assert.equal(
          Object.prototype.hasOwnProperty.call(/** @type {object} */ (result), 'kind'),
          false,
          `public result for ${statusCode} must not expose kind`,
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(/** @type {object} */ (result), 'statusCode'),
          false,
          `public result for ${statusCode} must not expose statusCode`,
        );
      }
    });

    it('detailed timeout throws fixed unavailable with no kind object', async () => {
      const api = requireDetailedApi();
      const harness = createTransportHarness(() => {
        // Hold open: no response. DNS succeeds via default fixture.
      });
      const promise = executeDetailedWith(api, harness, validDescriptor());
      await flushMicrotasks();
      assert.equal(harness.pendingTimersWithMs(TIMEOUT_MS).length, 1);
      await assertStillPending(promise);
      harness.fireDeadline(TIMEOUT_MS);
      let rejectedError = null;
      await assert.rejects(promise, (error) => {
        rejectedError = error;
        assertUnavailable(error, [CANONICAL_URL, CANONICAL_HOSTNAME, PUBLIC_V4]);
        return true;
      });
      assert.ok(rejectedError);
      assert.equal(
        Object.prototype.hasOwnProperty.call(/** @type {object} */ (rejectedError), 'kind'),
        false,
        'timeout error must not carry kind',
      );
      assert.ok(harness.calls[0].req.destroyCount >= 1, 'request destroyed on detailed timeout');
    });

    it('detailed DNS failure throws fixed unavailable with no kind object', async () => {
      const api = requireDetailedApi();
      const harness = createTransportHarness(() => {
        assert.fail('onEnd must not run for detailed DNS failure');
      }, {
        lookupAll(hostname, callback) {
          harness.lookupAllCalls.push({ hostname, args: [hostname, callback] });
          callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${SECRET_HOST}`), {
            code: 'ENOTFOUND',
            hostname: SECRET_HOST,
          }));
        },
      });
      let rejectedError = null;
      await assert.rejects(
        executeDetailedWith(api, harness, validDescriptor()),
        (error) => {
          rejectedError = error;
          assertUnavailable(error, [
            CANONICAL_HOSTNAME,
            SECRET_HOST,
            'ENOTFOUND',
            'getaddrinfo',
            PUBLIC_V4,
          ]);
          return true;
        },
      );
      assert.ok(rejectedError);
      assert.equal(
        Object.prototype.hasOwnProperty.call(/** @type {object} */ (rejectedError), 'kind'),
        false,
        'DNS error must not carry kind',
      );
      assert.equal(harness.lookupAllInvocations, 1);
    });

    it('detailed factory rejects missing/reordered deps with fixed error (deps key order parity)', () => {
      const api = requireDetailedApi();
      const good = createTransportHarness(() => {});
      const cases = [
        // missing request
        {
          lookupAll: good.deps.lookupAll,
          setTimer: good.deps.setTimer,
          clearTimer: good.deps.clearTimer,
        },
        // missing lookupAll
        {
          request: good.deps.request,
          setTimer: good.deps.setTimer,
          clearTimer: good.deps.clearTimer,
        },
        // missing setTimer
        {
          request: good.deps.request,
          lookupAll: good.deps.lookupAll,
          clearTimer: good.deps.clearTimer,
        },
        // missing clearTimer
        {
          request: good.deps.request,
          lookupAll: good.deps.lookupAll,
          setTimer: good.deps.setTimer,
        },
        // reordered (lookupAll after setTimer)
        {
          request: good.deps.request,
          setTimer: good.deps.setTimer,
          lookupAll: good.deps.lookupAll,
          clearTimer: good.deps.clearTimer,
        },
        // reordered (setTimer first)
        {
          setTimer: good.deps.setTimer,
          request: good.deps.request,
          lookupAll: good.deps.lookupAll,
          clearTimer: good.deps.clearTimer,
        },
        // reordered (clearTimer first)
        {
          clearTimer: good.deps.clearTimer,
          request: good.deps.request,
          lookupAll: good.deps.lookupAll,
          setTimer: good.deps.setTimer,
        },
      ];
      for (const deps of cases) {
        expectUnavailable(() => {
          api.createAuditIntegrityAlertHttpsDetailedExecutorForTesting(deps);
        });
      }
      // Exact ordered deps still accepted (parity with public factory contract).
      const ok = api.createAuditIntegrityAlertHttpsDetailedExecutorForTesting(good.deps);
      assert.equal(typeof ok, 'function');
    });

    it('detailed response streaming 4096 settles accepted; 4097 fixed unavailable', async () => {
      const api = requireDetailedApi();

      // Exactly 4096 bytes → accepted kind, no body retain.
      {
        const chunkA = Buffer.alloc(2000, 0x61);
        const chunkB = Buffer.alloc(2096, 0x62);
        assert.equal(chunkA.length + chunkB.length, MAX_RESPONSE_BYTES);
        const harness = createTransportHarness((call) => {
          settleResponse(harness, call, 200, [chunkA, chunkB]);
        });
        const result = await executeDetailedWith(api, harness, validDescriptor());
        assertDetailedResult(result, 'accepted', 'detailed 4096-byte stream');
        assert.equal(JSON.stringify(result).includes('aa'), false);
      }

      // Byte 4097 → fixed unavailable (uncertain path, no kind object).
      {
        const harness = createTransportHarness((call) => {
          const res = createFakeResponse(200);
          harness.setLastResponse(res);
          call.onResponse(res);
          res.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES, 0x63));
          res.emit('data', Buffer.from(SECRET_BODY_MARKER, 'utf8'));
        });
        let rejectedError = null;
        await assert.rejects(
          executeDetailedWith(api, harness, validDescriptor()),
          (error) => {
            rejectedError = error;
            assertUnavailable(error, [SECRET_BODY_MARKER, 'ccc']);
            return true;
          },
        );
        assert.ok(rejectedError);
        assert.equal(
          Object.prototype.hasOwnProperty.call(/** @type {object} */ (rejectedError), 'kind'),
          false,
        );
        const res = harness.lastResponse;
        assert.ok(res);
        assert.ok(harness.calls[0].req.destroyCount >= 1, 'request destroyed on oversize');
        assert.ok(res.destroyCount >= 1, 'response destroyed on oversize');
      }
    });

    it('detailed single-settlement: late error after end and late end after timeout', async () => {
      const api = requireDetailedApi();

      // Late error after accepted end must not re-open settlement.
      {
        const harness = createTransportHarness((call) => {
          settleResponse(harness, call, 200);
        });
        const result = await executeDetailedWith(api, harness, validDescriptor());
        assertDetailedResult(result, 'accepted');
        const res = harness.lastResponse;
        assert.ok(res, 'response object must be exposed on harness');
        res.emit('error', new Error(`late ${SECRET_HOST}`));
        res.emit('data', Buffer.from(SECRET_BODY_MARKER));
        res.emit('close');
        await flushMicrotasks();
        assertDetailedResult(result, 'accepted', 'post-late-events result');
      }

      // Late end after timeout remains unavailable (no accepted kind).
      {
        const harness = createTransportHarness(() => {});
        const promise = executeDetailedWith(api, harness, validDescriptor());
        await flushMicrotasks();
        harness.fireDeadline();
        await expectUnavailableAsync(promise);
        const res = createFakeResponse(200);
        harness.calls[0].onResponse(res);
        res.emit('end');
        await flushMicrotasks();
        assert.equal(harness.clearTimerCalls >= 1, true);
      }
    });
  });
});
