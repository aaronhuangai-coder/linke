/**
 * Bounded audit integrity alert HTTPS transport (Task 1) — corrected RED/GREEN.
 *
 * Production module (absent on old HEAD):
 *   src/audit-integrity-alert-https-transport.js
 *
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-https-transport-design.md
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-https-transport-plan.md (Task 1)
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   assert message = `bounded HTTPS transport implementation missing`
 * Detailed suites register only when executor + test factory exports exist.
 *
 * Deterministic EventEmitter fakes only. No listener, DNS, TLS handshake, socket,
 * fetch, or external/local network I/O. Every case settles via the virtual harness
 * (no wall-clock 10s wait, no real timers).
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
const MAX_RESPONSE_BYTES = 4_096;

const CANONICAL_URL = 'https://alerts.example.invalid/hooks/audit-integrity';
const STREAM_ID = 'a1111111-b111-4c11-8d11-e11111111111';
const IDEMPOTENCY_KEY = `audit-integrity-alert:${STREAM_ID}:1`;
const SECRET_TOKEN = 'Bearer secret-token-xyz';
const SECRET_HOST = 'evil-cert.example.invalid';
const SECRET_PATH = '/Users/ah/secret/audit-ca.pem';
const SECRET_BODY_MARKER = 'response-body-secret-bytes-do-not-leak';

const REQUEST_KEYS = Object.freeze(['schemaVersion', 'url', 'method', 'headers', 'body']);
const HEADER_KEYS = Object.freeze(['content-type', 'idempotency-key']);
const RESULT_KEYS = Object.freeze(['schemaVersion', 'status']);
const DEPS_KEYS = Object.freeze(['request', 'setTimer', 'clearTimer']);
const REQUEST_HEADER_KEYS = Object.freeze([
  'content-type',
  'idempotency-key',
  'content-length',
]);

/** @type {null | {
 *   AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS: number,
 *   AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES: number,
 *   executeAuditIntegrityAlertHttpsRequest: Function,
 *   createAuditIntegrityAlertHttpsExecutorForTesting: Function,
 * }} */
let transportApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.executeAuditIntegrityAlertHttpsRequest === 'function'
    && typeof mod.createAuditIntegrityAlertHttpsExecutorForTesting === 'function'
  ) {
    transportApi = {
      AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS: mod.AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS,
      AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES:
        mod.AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES,
      executeAuditIntegrityAlertHttpsRequest: mod.executeAuditIntegrityAlertHttpsRequest,
      createAuditIntegrityAlertHttpsExecutorForTesting:
        mod.createAuditIntegrityAlertHttpsExecutorForTesting,
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
    'alerts.example.invalid',
    SECRET_TOKEN,
    SECRET_HOST,
    SECRET_PATH,
    SECRET_BODY_MARKER,
    'ECONNRESET',
    'ENOTFOUND',
    'ECONNREFUSED',
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
 * @param {(call: HarnessCall) => void} [onEnd]
 */
function createTransportHarness(onEnd) {
  /** @type {HarnessCall[]} */
  const calls = [];
  /** @type {Map<number, { fn: Function, ms: number }>} */
  const timers = new Map();
  let nextTimerId = 1;
  let clearTimerCalls = 0;
  let requestInvocations = 0;
  /** @type {HarnessCall | null} */
  let lastCall = null;
  /** @type {ReturnType<typeof createFakeResponse> | null} */
  let lastResponse = null;

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
        if (typeof onEnd === 'function') {
          onEnd(call);
        }
      };
      return req;
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
   * Fire the sole pending timer (must be exactly TIMEOUT_MS by default).
   * @param {number} [expectedMs]
   */
  function fireDeadline(expectedMs = TIMEOUT_MS) {
    assert.equal(timers.size, 1, 'exactly one pending timer expected');
    const [[, entry]] = [...timers.entries()];
    assert.equal(entry.ms, expectedMs, `timer must be registered for ${expectedMs}ms`);
    entry.fn();
  }

  return {
    deps,
    calls,
    timers,
    createResponse: createFakeResponse,
    fireDeadline,
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
 * @param {unknown} options
 */
function assertStrictTlsOptions(options) {
  const opts = /** @type {Record<string, unknown>} */ (options);
  assert.equal(opts.agent, false);
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
    'lookup',
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

// ─── Suite ────────────────────────────────────────────────────────────────

describe('audit integrity alert HTTPS transport (Task 1 RED)', () => {
  // Old HEAD: exactly one dedicated RED. Full matrix only when exports exist.
  if (implementationMissing || transportApi === null) {
    it('bounded HTTPS transport implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── 1. Constants, exports, frozen results, registered fixed error ───────

  describe('1 exports, constants, frozen results, registered fixed error', () => {
    it('exports exact constants and both executor surfaces', () => {
      const api = requireApi();
      assert.equal(api.AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS, TIMEOUT_MS);
      assert.equal(api.AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
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
        { setTimer: good.deps.setTimer, clearTimer: good.deps.clearTimer },
        {
          request: good.deps.request,
          setTimer: good.deps.setTimer,
          clearTimer: good.deps.clearTimer,
          extra: () => {},
        },
        {
          setTimer: good.deps.setTimer,
          request: good.deps.request,
          clearTimer: good.deps.clearTimer,
        },
        {
          request: 'not-fn',
          setTimer: good.deps.setTimer,
          clearTimer: good.deps.clearTimer,
        },
        {
          request: good.deps.request,
          setTimer: 1,
          clearTimer: good.deps.clearTimer,
        },
        {
          request: good.deps.request,
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

  // ── 2. Exact descriptor validation ──────────────────────────────────────

  describe('2 exact descriptor validation before request', () => {
    it('rejects missing/extra/reordered keys and never calls request', async () => {
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
        assert.equal(harness.requestInvocations, 0, 'request must not be invoked');
        assert.equal(harness.calls.length, 0);
      }
    });

    it('rejects Proxy/accessor/symbol/non-enumerable/class descriptor objects', async () => {
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
        assert.equal(harness.requestInvocations, 0);
      }
    });

    it('rejects wrong schema/method/headers/body/url and hostile header order', async () => {
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
        assert.equal(harness.requestInvocations, 0, 'invalid descriptor must not call request');
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

  // ── 3–4. Internally constructed request options + UTF-8 content-length ──

  describe('3–4 internally constructed request options and UTF-8 content-length', () => {
    it('constructs POST options with exact headers, content-length, agent:false, TLS 1.2 roots', async () => {
      const api = requireApi();
      const { descriptor, body, byteLength } = utf8BodyDescriptor();
      const harness = createTransportHarness((call) => {
        assert.equal(call.url, CANONICAL_URL);
        assert.equal(call.body, body);
        assert.equal(Buffer.byteLength(/** @type {string} */ (call.body), 'utf8'), byteLength);
        assert.notEqual(byteLength, /** @type {string} */ (call.body).length);
        assertExactRequestOptions(call.options, body);
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

  // ── 9. Deadline 10_000 ms ───────────────────────────────────────────────

  describe('9 total deadline 10_000 ms', () => {
    it('remains pending just before deadline and fails exactly when callback fires', async () => {
      const api = requireApi();
      const harness = createTransportHarness((_call) => {
        // Hold open: no response, no error.
      });
      const promise = executeWith(api, harness, validDescriptor());
      await flushMicrotasks();
      assert.equal(harness.timers.size, 1);
      const [[, timer]] = [...harness.timers.entries()];
      assert.equal(timer.ms, TIMEOUT_MS);
      await assertStillPending(promise);

      // Observe clear + single settlement on fire.
      const clearsBefore = harness.clearTimerCalls;
      harness.fireDeadline(TIMEOUT_MS);
      await expectUnavailableAsync(promise, [CANONICAL_URL, 'alerts.example.invalid']);
      assert.equal(harness.clearTimerCalls > clearsBefore, true, 'timer cleared on timeout');
      assert.ok(harness.calls[0].req.destroyCount >= 1, 'request destroyed on timeout');

      // Late end after timeout cannot accept.
      const late = createFakeResponse(200);
      harness.calls[0].onResponse(late);
      late.emit('end');
      await flushMicrotasks();
      // Already settled rejected — no throw from late events expected.
    });

    it('synchronous setTimer deadline rejects once and issues no request', async () => {
      // F4: injected setTimer fires the deadline callback before returning its handle.
      const api = requireApi();
      let requestInvocations = 0;
      let timerReturns = 0;
      /** @type {Function | null} */
      let deadlineFn = null;
      const deps = {
        request() {
          requestInvocations += 1;
          assert.fail('request must not run after synchronous deadline');
        },
        setTimer(fn, ms) {
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
        [CANONICAL_URL, 'alerts.example.invalid'],
      );
      assert.equal(typeof deadlineFn, 'function');
      assert.equal(timerReturns, 1);
      assert.equal(requestInvocations, 0, 'no request after synchronous timeout');

      // Single settlement: a second deadline fire must not throw or open a path.
      assert.doesNotThrow(() => {
        /** @type {Function} */ (deadlineFn)();
      });
      assert.equal(requestInvocations, 0);
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

  // ── 11. No secret leakage on every public failure ───────────────────────

  describe('11 public failures contain only fixed code/message', () => {
    it('maps representative failures without endpoint/body/header/cert/errno/path', async () => {
      const api = requireApi();
      const leak = [
        CANONICAL_URL,
        'alerts.example.invalid',
        SECRET_TOKEN,
        SECRET_HOST,
        SECRET_PATH,
        SECRET_BODY_MARKER,
        IDEMPOTENCY_KEY,
        'BEGIN CERTIFICATE',
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
          assert.equal(harness.requestInvocations, 0);
        },
      ];

      for (const run of cases) {
        await run();
      }
    });
  });

  // ── 12. Structural source scan (module exists) ──────────────────────────

  describe('12 structural source scan', () => {
    it('permits only node:buffer/https/tls/util and ./error-codes.js; forbids forbidden surfaces', async () => {
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
        './error-codes.js',
      ]);
      for (const imp of imports) {
        assert.equal(allowed.has(imp), true, `unexpected import: ${imp}`);
      }
      for (const required of ['node:https', 'node:tls', './error-codes.js']) {
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
        'node:net',
        'node:dns',
        'node:dgram',
        'createServer',
        'keychain',
        'readFileSync',
        'writeFileSync',
        'https.Agent',
        'new Agent',
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `production source must not include ${forbidden}`,
        );
      }

      // Built-in surfaces that must appear for the TLS/options contract.
      assert.equal(source.includes('rootCertificates'), true);
      assert.equal(source.includes('checkServerIdentity'), true);
      assert.equal(source.includes('TLSv1.2'), true);
      assert.equal(source.includes('rejectUnauthorized'), true);
      assert.equal(source.includes("agent: false") || source.includes('agent:false'), true);
    });
  });
});
