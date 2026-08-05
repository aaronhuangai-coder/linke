/**
 * Task 2 RED — authorize-before-claim one-shot delivery gate.
 * Task 5 — authorized delivery integration (real policy/claim/one-shot/HTTPS factory).
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-destination-allowlist-design.md
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-destination-allowlist-plan.md
 *   (Task 2 + Task 5)
 *
 * Production:
 *   src/audit-integrity-alert-delivery-authorized-once.js
 *   (+ real destination policy, one-shot, claim, HTTPS transport factory)
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   test name + assert message = `authorized one-shot delivery implementation missing`
 * Full matrix registers only when both public factory exports exist.
 *
 * Task 2: pure injected authorize/deliverOnce branch matrix + production factory binding.
 * Task 5: layered ForTesting assembly — real policy + real authorized gate + real
 * one-shot coordinator + real claim/outbox/stream + real HTTPS transport factory;
 * only lookupAll / request / timers are faked. No real DNS, socket, TLS handshake,
 * fetch, or external I/O. Temp roots via mkdtemp only.
 * Does not claim Gold / remote delivery readiness.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuditIntegrityAlertDestinationPolicy } from '../src/audit-integrity-alert-destination-policy.js';
import {
  claimAuditIntegrityAlertDelivery,
  completeAuditIntegrityAlertDelivery,
  releaseAuditIntegrityAlertDelivery,
} from '../src/audit-integrity-alert-delivery-claim.js';
import {
  AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH,
  loadAuditIntegrityAlertDeliveryClaimState,
  publishAuditIntegrityAlertDeliveryClaimState,
} from '../src/audit-integrity-alert-delivery-claim-state.js';
import { createAuditIntegrityAlertDeliveryOnceForTesting } from '../src/audit-integrity-alert-delivery-once.js';
import { AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH } from '../src/audit-integrity-alert-delivery-stream.js';
import {
  AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
  readAuditIntegrityAlertOutbox,
} from '../src/audit-integrity-alert-outbox.js';
import {
  AUDIT_INTEGRITY_ALERT_HTTPS_DNS_TIMEOUT_MS,
  createAuditIntegrityAlertHttpsExecutorForTesting,
} from '../src/audit-integrity-alert-https-transport.js';
import { enqueueAuditIntegrityWriteTask } from '../src/audit-integrity-write-queue.js';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { assertSafeDataRoot } from '../src/safe-data-files.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-authorized-once.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);

const MISSING_MSG = 'authorized one-shot delivery implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

/** Exact ordered deps keys for the test factory (string enumerable own keys). */
const DEPS_KEYS = Object.freeze(['authorizeDestination', 'deliverOnce']);

/** Valid allowlisted-style destinations (not reserved .example/.invalid suffixes). */
const ENDPOINT_A = 'https://alerts.acme.com/hooks/audit-integrity';
const ENDPOINT_B = 'https://hooks.ops.acme.com/v1/alerts';
const DATA_DIR = '/safe/secret-data-dir-authorized-once';
const DATA_DIR_OBJ = Object.freeze({ path: DATA_DIR, marker: 'data-dir-identity' });
const FIXED_NOW = '2026-08-04T12:00:00.000Z';
const FIXED_NOW_OBJ = Object.freeze({ iso: FIXED_NOW, marker: 'now-identity' });

const SECRET_TOKEN = 'Bearer secret-token-xyz';
const SECRET_PATH = '/Users/ah/secret/audit-authorized-once.json';
const SECRET_HOST = 'evil-cert.acme.com';
const SECRET_CLAIM = 'a1111111-b111-4111-8111-e11111111111';
const SECRET_BODY = '{"body-secret":"do-not-leak"}';
const SECRET_HEADER = 'authorization: Bearer leak-token';

const EMPTY_RECEIPT_KEYS = Object.freeze(['schemaVersion', 'status', 'delivered']);
const BUSY_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'delivered',
  'streamId',
  'sequence',
  'expiresAt',
]);
const DELIVERED_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'delivered',
  'streamId',
  'sequence',
  'pendingCount',
  'completionStatus',
]);

/** Task 5 integration fixtures (policy-valid hostnames; not reserved suffixes). */
const ENDPOINT_HOSTNAME = 'alerts.acme.com';
const FIXED_CHECKED_AT = '2026-08-04T12:00:00.000Z';
const FIXED_STREAM_ID = 'b2222222-c222-4222-9222-f22222222222';
const FIXED_EXPIRES_AT = '2026-08-04T12:02:00.000Z';
const PUBLIC_V4 = '8.8.8.8';
const PUBLIC_V6 = '2606:4700:4700::1111';
const PRIVATE_V4 = '10.0.0.1';
const LOOPBACK_V4 = '127.0.0.1';
const DNS_TIMEOUT_MS = AUDIT_INTEGRITY_ALERT_HTTPS_DNS_TIMEOUT_MS;

/** Exact ordered deps for one-shot / HTTPS test factories. */
const ONCE_DEPS_KEYS = Object.freeze([
  'claimDelivery',
  'executeRequest',
  'completeDelivery',
  'releaseDelivery',
]);
const TRANSPORT_DEPS_KEYS = Object.freeze([
  'request',
  'lookupAll',
  'setTimer',
  'clearTimer',
]);

const CANONICAL_IDLE_CLAIM_BYTES =
  '{"schemaVersion":1,"status":"idle","claimId":null,"streamId":null,"sequence":null,"ownerPid":null,"bootSessionIdentity":null,"processStartIdentity":null,"claimedAt":null,"expiresAt":null}\n';

/** @type {null | {
 *   createAuthorizedAuditIntegrityAlertDeliveryOnce: Function,
 *   createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting: Function,
 * }} */
let authorizedApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.createAuthorizedAuditIntegrityAlertDeliveryOnce === 'function'
    && typeof mod.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting === 'function'
  ) {
    authorizedApi = {
      createAuthorizedAuditIntegrityAlertDeliveryOnce:
        mod.createAuthorizedAuditIntegrityAlertDeliveryOnce,
      createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting:
        mod.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    authorizedApi = null;
  } else {
    // Syntax/load errors in an existing production module must surface as themselves.
    throw error;
  }
}

function requireApi() {
  if (implementationMissing || authorizedApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {NonNullable<typeof authorizedApi>} */ (authorizedApi);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Exact key order using Object.keys (string enumerable own keys only).
 * @param {unknown} obj
 * @param {readonly string[]} expected
 * @param {string} [label]
 */
function assertExactKeys(obj, expected, label = 'value') {
  assert.deepEqual(
    Object.keys(/** @type {object} */ (obj)),
    [...expected],
    `${label} must have exact key order ${expected.join(',')}`,
  );
}

/**
 * Business secrets / caller input tokens that must never appear on the public
 * error surface (fields or stack). Local source paths in stack frames are not
 * treated as product leaks (no /private|/tmp environment-fragile checks).
 * @param {string[]} [extra]
 * @returns {string[]}
 */
function businessLeakTokens(extra = []) {
  return [
    ENDPOINT_A,
    ENDPOINT_B,
    DATA_DIR,
    FIXED_NOW,
    SECRET_TOKEN,
    SECRET_PATH,
    SECRET_HOST,
    SECRET_CLAIM,
    SECRET_BODY,
    SECRET_HEADER,
    'alerts.acme.com',
    'hooks.ops.acme.com',
    'authorization',
    'Bearer',
    'claimId',
    'idempotency',
    ...extra,
  ];
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
  assert.equal(
    /** @type {{ message: string }} */ (error).message,
    /** @type {{ code: string }} */ (error).code,
  );
  assert.equal(/** @type {{ cause?: unknown }} */ (error).cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(/** @type {object} */ (error), 'cause'));

  const tokens = businessLeakTokens(leakTokens);

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

  for (const token of tokens) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `public error must not leak ${token}`);
  }

  // Stack may legally include local source paths; only ban business secrets/inputs.
  const stack = /** @type {{ stack?: unknown }} */ (error).stack;
  if (typeof stack === 'string') {
    for (const token of tokens) {
      if (!token || token.length < 2) continue;
      assert.equal(stack.includes(token), false, `stack must not leak ${token}`);
    }
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
 * Canonical empty one-shot public receipt (identity fixture for pass-through).
 * @returns {Readonly<{ schemaVersion: number, status: string, delivered: boolean }>}
 */
function emptyReceipt() {
  return Object.freeze({
    schemaVersion: 1,
    status: 'empty',
    delivered: false,
  });
}

/**
 * Counting authorize/deliverOnce harness.
 * Captures full rest-args arrays so arity regressions are visible.
 * @param {{
 *   authorize?: (...args: unknown[]) => unknown,
 *   deliver?: (...args: unknown[]) => unknown,
 * }} [script]
 */
function createHarness(script = {}) {
  /** @type {unknown[][]} */
  const authorizeArgs = [];
  /** @type {unknown[][]} */
  const deliverArgs = [];
  /** @type {string[]} */
  const order = [];

  const deps = {
    authorizeDestination(...args) {
      order.push('authorize');
      authorizeArgs.push(args);
      if (typeof script.authorize === 'function') {
        return script.authorize(...args);
      }
      // Default: echo the endpoint primitive (bit-identical success path).
      return args[0];
    },
    async deliverOnce(...args) {
      order.push('deliver');
      deliverArgs.push(args);
      if (typeof script.deliver === 'function') {
        return script.deliver(...args);
      }
      return emptyReceipt();
    },
  };

  assertExactKeys(deps, DEPS_KEYS, 'harness deps');

  return {
    deps,
    authorizeArgs,
    deliverArgs,
    order,
    counts() {
      return {
        authorize: authorizeArgs.length,
        deliver: deliverArgs.length,
      };
    },
  };
}

/**
 * Existing empty dataDir for production seam tests (deny vs empty-receipt falsifiable).
 * @param {(root: string) => Promise<unknown>} fn
 */
async function withEmptyDataDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'linke-authorized-once-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} root
 */
async function assertDataDirEmpty(root) {
  const entries = await readdir(root);
  assert.deepEqual(
    entries,
    [],
    'dataDir must remain empty (no claim/outbox/stream artifacts)',
  );
}

/**
 * @param {ReturnType<typeof requireApi>} api
 * @param {ReturnType<typeof createHarness>} harness
 */
function deliverWith(api, harness) {
  return api.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting(harness.deps);
}

/**
 * Hostile conversion surface that must never be probed.
 * @param {string} secret
 */
function makeConversionTrap(secret) {
  let hits = 0;
  const value = {
    [Symbol.toPrimitive]() {
      hits += 1;
      throw new Error(`toPrimitive:${secret}`);
    },
    valueOf() {
      hits += 1;
      throw new Error(`valueOf:${secret}`);
    },
    toString() {
      hits += 1;
      throw new Error(`toString:${secret}`);
    },
  };
  return {
    value,
    get hits() {
      return hits;
    },
  };
}

// ─── Task 5 integration helpers (real claim/outbox + fake transport) ──────

/**
 * Drain a few microtask turns without wall-clock sleep.
 * @returns {Promise<void>}
 */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Deep freeze walk; functions are terminal leaves.
 * @param {unknown} value
 * @param {string} [path]
 */
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
 * Public receipts must never expose claim/request/endpoint/wire material.
 * @param {unknown} receipt
 * @param {string[]} [extraLeakTokens]
 */
function assertReceiptSanitized(receipt, extraLeakTokens = []) {
  assert.equal(typeof receipt, 'object');
  assert.notEqual(receipt, null);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'claimId'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'request'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'endpoint'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'headers'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'body'), false);

  const text = JSON.stringify(receipt);
  for (const token of [
    ENDPOINT_A,
    ENDPOINT_B,
    ENDPOINT_HOSTNAME,
    SECRET_TOKEN,
    SECRET_PATH,
    SECRET_HOST,
    SECRET_CLAIM,
    SECRET_BODY,
    PUBLIC_V4,
    PUBLIC_V6,
    PRIVATE_V4,
    LOOPBACK_V4,
    'authorization',
    'idempotency',
    'claimId',
    '"request"',
    ...extraLeakTokens,
  ]) {
    if (!token || token.length < 2) continue;
    assert.equal(text.includes(token), false, `receipt must not contain ${token}`);
  }
}

/**
 * @param {unknown} receipt
 */
function assertEmptyReceipt(receipt) {
  assertExactKeys(receipt, EMPTY_RECEIPT_KEYS, 'empty receipt');
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    status: 'empty',
    delivered: false,
  });
  assertDeeplyFrozen(receipt);
  assertReceiptSanitized(receipt);
}

/**
 * @param {unknown} receipt
 * @param {{ streamId: string, sequence: number, expiresAt: string }} expected
 */
function assertBusyReceipt(receipt, expected) {
  assertExactKeys(receipt, BUSY_RECEIPT_KEYS, 'busy receipt');
  assert.equal(/** @type {{ schemaVersion: number }} */ (receipt).schemaVersion, 1);
  assert.equal(/** @type {{ status: string }} */ (receipt).status, 'busy');
  assert.equal(/** @type {{ delivered: boolean }} */ (receipt).delivered, false);
  assert.equal(/** @type {{ streamId: string }} */ (receipt).streamId, expected.streamId);
  assert.equal(/** @type {{ sequence: number }} */ (receipt).sequence, expected.sequence);
  assert.equal(/** @type {{ expiresAt: string }} */ (receipt).expiresAt, expected.expiresAt);
  assertDeeplyFrozen(receipt);
  assertReceiptSanitized(receipt);
}

/**
 * @param {unknown} receipt
 * @param {{
 *   streamId: string,
 *   sequence: number,
 *   pendingCount: number,
 *   completionStatus: string,
 * }} expected
 */
function assertDeliveredReceipt(receipt, expected) {
  assertExactKeys(receipt, DELIVERED_RECEIPT_KEYS, 'delivered receipt');
  assert.equal(/** @type {{ schemaVersion: number }} */ (receipt).schemaVersion, 1);
  assert.equal(/** @type {{ status: string }} */ (receipt).status, 'delivered');
  assert.equal(/** @type {{ delivered: boolean }} */ (receipt).delivered, true);
  assert.equal(/** @type {{ streamId: string }} */ (receipt).streamId, expected.streamId);
  assert.equal(/** @type {{ sequence: number }} */ (receipt).sequence, expected.sequence);
  assert.equal(
    /** @type {{ pendingCount: number }} */ (receipt).pendingCount,
    expected.pendingCount,
  );
  assert.equal(
    /** @type {{ completionStatus: string }} */ (receipt).completionStatus,
    expected.completionStatus,
  );
  assertDeeplyFrozen(receipt);
  assertReceiptSanitized(receipt);
}

/**
 * @param {string} prefix
 * @param {(root: string) => Promise<unknown>} fn
 */
async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-authorized-int-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} root
 * @param {(resolvedRoot: string, lease: unknown) => Promise<unknown>} fn
 */
async function withLease(root, fn) {
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

/** @param {string} root */
function claimAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH);
}
/** @param {string} root */
function outboxAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH);
}
/** @param {string} root */
function streamAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH);
}

/**
 * @param {number} [sequence]
 * @param {object} [overrides]
 */
function headEntry(sequence = 1, overrides = {}) {
  return {
    sequence,
    checkedAt: FIXED_CHECKED_AT,
    code: 'uninitialized',
    recoveryRequired: false,
    nextAction: 'initialize-via-production-write',
    reasonCode: null,
    ...overrides,
  };
}

/**
 * @param {number} nextSequence
 * @param {object[]} entries
 */
function canonicalOutbox(nextSequence, entries) {
  return `${JSON.stringify({ schemaVersion: 1, nextSequence, entries })}\n`;
}

/** @param {string} streamId */
function canonicalStream(streamId) {
  return `${JSON.stringify({ schemaVersion: 1, streamId })}\n`;
}

/**
 * @param {string} root
 * @param {number} nextSequence
 * @param {object[]} entries
 */
async function writeOutbox(root, nextSequence, entries) {
  const abs = outboxAbs(root);
  await mkdir(dirname(abs), { recursive: true });
  const raw = canonicalOutbox(nextSequence, entries);
  await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
  return raw;
}

/**
 * @param {string} root
 * @param {string} streamId
 */
async function writeStream(root, streamId) {
  const abs = streamAbs(root);
  await mkdir(dirname(abs), { recursive: true });
  const raw = canonicalStream(streamId);
  await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
  return raw;
}

/**
 * Seed a non-empty outbox FIFO head + stable stream under a temp root.
 * @param {string} root
 * @param {{
 *   sequence?: number,
 *   nextSequence?: number,
 *   streamId?: string,
 *   entries?: object[],
 * }} [opts]
 */
async function seedQueuedHead(root, {
  sequence = 1,
  nextSequence = sequence + 1,
  streamId = FIXED_STREAM_ID,
  entries,
} = {}) {
  const list = entries ?? [headEntry(sequence)];
  const outboxRaw = await writeOutbox(root, nextSequence, list);
  const streamRaw = await writeStream(root, streamId);
  return { outboxRaw, streamRaw, head: list[0], streamId };
}

/**
 * @param {string} root
 */
async function loadClaim(root) {
  return withLease(root, async (resolvedRoot, lease) => {
    return loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease);
  });
}

/**
 * Reset durable claim to logical idle without touching outbox FIFO.
 * Missing leaf is also idle; publishing the exact idle bytes keeps a leaf present.
 * @param {string} root
 */
async function resetClaimIdle(root) {
  await withLease(root, async (resolvedRoot, lease) => {
    await publishAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease, {
      schemaVersion: 1,
      status: 'idle',
      claimId: null,
      streamId: null,
      sequence: null,
      ownerPid: null,
      bootSessionIdentity: null,
      processStartIdentity: null,
      claimedAt: null,
      expiresAt: null,
    });
  });
}

/**
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Fake HTTPS response object for the production onResponse path.
 * @param {unknown} statusCode
 */
function createFakeResponse(statusCode) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.destroyCount = 0;
  res.destroy = function destroy() {
    res.destroyCount += 1;
  };
  return res;
}

/**
 * Deterministic HTTPS transport harness: fake request + lookupAll + timers.
 * Mirrors node:https by invoking options.lookup before the response script.
 * No real DNS, socket, or wall-clock timers.
 *
 * @param {(call: {
 *   url: unknown,
 *   options: Record<string, unknown>,
 *   body: unknown,
 *   req: import('node:events').EventEmitter & { destroy: () => void, end: (body?: unknown) => void },
 *   onResponse: (res: object) => void,
 * }) => void} [onEnd]
 * @param {{
 *   lookupAll?: (hostname: unknown, callback: Function) => void,
 *   autoLookup?: boolean,
 * }} [harnessOptions]
 */
function createTransportHarness(onEnd, harnessOptions = {}) {
  /** @type {Array<object>} */
  const calls = [];
  /** @type {Array<{ hostname: unknown }>} */
  const lookupAllCalls = [];
  /** @type {Map<number, { fn: Function, ms: number }>} */
  const timers = new Map();
  let nextTimerId = 1;
  let clearTimerCalls = 0;
  let requestInvocations = 0;
  /** @type {object | null} */
  let lastCall = null;
  const autoLookup = harnessOptions.autoLookup !== false;

  /**
   * Default public DNS answers — at least one public A record.
   * @param {unknown} hostname
   * @param {Function} callback
   */
  function defaultLookupAll(hostname, callback) {
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
      assert.equal(typeof onResponse, 'function');
      requestInvocations += 1;
      const req = new EventEmitter();
      req.destroyCount = 0;
      req.destroy = function destroy() {
        req.destroyCount += 1;
      };
      req.end = function end(body) {
        const call = {
          url,
          options,
          body,
          req,
          onResponse,
        };
        lastCall = call;
        calls.push(call);

        /**
         * @param {unknown} lookupOptions
         */
        function runLookup(lookupOptions) {
          const lookup = options && typeof options === 'object'
            ? /** @type {Record<string, unknown>} */ (options).lookup
            : undefined;
          if (typeof lookup !== 'function') {
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

          let lookupSettled = false;
          lookup(hostname, lookupOptions, (err, _addresses) => {
            if (lookupSettled) return;
            lookupSettled = true;
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
        }
      };
      return req;
    },
    /**
     * Always record invocations so custom lookupAll scripts stay countable.
     * @param {unknown} hostname
     * @param {Function} callback
     */
    lookupAll(hostname, callback) {
      lookupAllCalls.push({ hostname });
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

  assertExactKeys(deps, TRANSPORT_DEPS_KEYS, 'transport harness deps');

  /**
   * Fire exactly one pending timer registered for `expectedMs`.
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
    fireTimerMs,
    pendingTimersWithMs,
    get lastCall() {
      return lastCall;
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
 * Deliver a fake response through production onResponse, then end.
 * @param {ReturnType<typeof createTransportHarness>} harness
 * @param {object} call
 * @param {unknown} statusCode
 */
function settleResponse(harness, call, statusCode) {
  const res = createFakeResponse(statusCode);
  /** @type {{ onResponse: (res: object) => void }} */ (call).onResponse(res);
  res.emit('end');
  return res;
}

/**
 * Layered Task 5 stack via existing ForTesting factories.
 * Real: destination policy authorize, authorized gate, one-shot coordinator,
 * claim/complete/release, HTTPS transport factory.
 * Fake: only the transport deps (request / lookupAll / setTimer / clearTimer).
 *
 * @param {ReturnType<typeof requireApi>} api
 * @param {{
 *   endpoint?: string,
 *   policy?: unknown,
 *   onEnd?: (call: object) => void,
 *   lookupAll?: (hostname: unknown, callback: Function) => void,
 *   completeDelivery?: Function,
 *   releaseDelivery?: Function,
 * }} [options]
 */
function createAuthorizedIntegration(api, options = {}) {
  const endpoint = options.endpoint ?? ENDPOINT_A;
  const policy = Object.prototype.hasOwnProperty.call(options, 'policy')
    ? options.policy
    : { schemaVersion: 1, endpoints: [endpoint] };

  const capability = createAuditIntegrityAlertDestinationPolicy(policy);

  /** @type {string[]} */
  const order = [];
  /** @type {number} */
  let claimHits = 0;
  /** @type {number} */
  let executeHits = 0;
  /** @type {number} */
  let completeHits = 0;
  /** @type {number} */
  let releaseHits = 0;
  /** @type {number} */
  let authorizeHits = 0;

  const transport = createTransportHarness(options.onEnd, {
    lookupAll: options.lookupAll,
  });

  // Snapshot-friendly deps: wrap counters before the HTTPS factory binds them.
  const transportDeps = {
    request(...args) {
      order.push('request');
      return transport.deps.request(...args);
    },
    lookupAll(...args) {
      order.push('lookupAll');
      return transport.deps.lookupAll(...args);
    },
    setTimer(...args) {
      return transport.deps.setTimer(...args);
    },
    clearTimer(...args) {
      return transport.deps.clearTimer(...args);
    },
  };
  assertExactKeys(transportDeps, TRANSPORT_DEPS_KEYS, 'transport deps');

  const executeRequest = createAuditIntegrityAlertHttpsExecutorForTesting(transportDeps);

  const completeDelivery = typeof options.completeDelivery === 'function'
    ? options.completeDelivery
    : async (...args) => {
      order.push('complete');
      completeHits += 1;
      return completeAuditIntegrityAlertDelivery(...args);
    };

  const releaseDelivery = typeof options.releaseDelivery === 'function'
    ? options.releaseDelivery
    : async (...args) => {
      order.push('release');
      releaseHits += 1;
      return releaseAuditIntegrityAlertDelivery(...args);
    };

  const onceDeps = {
    async claimDelivery(...args) {
      order.push('claim');
      claimHits += 1;
      return claimAuditIntegrityAlertDelivery(...args);
    },
    async executeRequest(...args) {
      order.push('execute');
      executeHits += 1;
      return executeRequest(...args);
    },
    completeDelivery: async (...args) => completeDelivery(...args),
    releaseDelivery: async (...args) => releaseDelivery(...args),
  };
  assertExactKeys(onceDeps, ONCE_DEPS_KEYS, 'once deps');

  const deliverOnce = createAuditIntegrityAlertDeliveryOnceForTesting(onceDeps);

  const authDeps = {
    authorizeDestination(ep) {
      order.push('authorize');
      authorizeHits += 1;
      return capability.authorize(ep);
    },
    deliverOnce,
  };
  assertExactKeys(authDeps, DEPS_KEYS, 'authorized deps');

  const deliver = api.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting(authDeps);

  return {
    deliver,
    capability,
    transport,
    order,
    counts() {
      return {
        authorize: authorizeHits,
        claim: claimHits,
        execute: executeHits,
        complete: completeHits,
        release: releaseHits,
        lookupAll: transport.lookupAllInvocations,
        request: transport.requestInvocations,
      };
    },
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('audit integrity alert delivery authorized once (Task 2 RED)', () => {
  // Old HEAD: exactly one dedicated RED. Full matrix only when both exports exist.
  if (implementationMissing || authorizedApi === null) {
    it('authorized one-shot delivery implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── 1. Exports + test-factory deps contract ─────────────────────────────

  describe('1 exports and test-factory deps contract', () => {
    it('exports production and test factories; registered fixed error code', () => {
      const api = requireApi();
      assert.equal(typeof api.createAuthorizedAuditIntegrityAlertDeliveryOnce, 'function');
      assert.equal(
        typeof api.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting,
        'function',
      );
      assert.equal(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, CODE_UNAVAILABLE);
    });

    it('test factory returns an async delivery function', async () => {
      const api = requireApi();
      const harness = createHarness();
      const deliver = deliverWith(api, harness);
      assert.equal(typeof deliver, 'function');
      const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
      assertExactKeys(receipt, EMPTY_RECEIPT_KEYS, 'empty receipt');
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'empty',
        delivered: false,
      });
    });

    it('factory rejects missing/extra/reordered/non-function/hostile deps without traps', () => {
      const api = requireApi();
      const good = createHarness();
      let trapHits = 0;
      const trapProxy = new Proxy(good.deps, {
        get(_t, prop) {
          trapHits += 1;
          throw new Error(`trap-get:${String(prop)}:${SECRET_PATH}`);
        },
        ownKeys() {
          trapHits += 1;
          throw new Error(`trap-ownKeys:${SECRET_TOKEN}`);
        },
        getOwnPropertyDescriptor() {
          trapHits += 1;
          throw new Error(`trap-desc:${SECRET_HOST}`);
        },
        getPrototypeOf() {
          trapHits += 1;
          throw new Error(`trap-proto:${SECRET_CLAIM}`);
        },
        has() {
          trapHits += 1;
          throw new Error(`trap-has:${SECRET_BODY}`);
        },
      });

      const { proxy: revokedProxy, revoke } = Proxy.revocable(
        {
          authorizeDestination: good.deps.authorizeDestination,
          deliverOnce: good.deps.deliverOnce,
        },
        {},
      );
      revoke();

      const accessorDeps = {};
      Object.defineProperty(accessorDeps, 'authorizeDestination', {
        enumerable: true,
        get() {
          trapHits += 1;
          throw new Error(`accessor-auth:${SECRET_PATH}`);
        },
      });
      Object.defineProperty(accessorDeps, 'deliverOnce', {
        enumerable: true,
        get() {
          trapHits += 1;
          throw new Error(`accessor-deliver:${SECRET_TOKEN}`);
        },
      });

      const nonEnum = {
        authorizeDestination: good.deps.authorizeDestination,
        deliverOnce: good.deps.deliverOnce,
      };
      Object.defineProperty(nonEnum, 'hidden', {
        value: SECRET_TOKEN,
        enumerable: false,
      });

      const withSymbol = {
        authorizeDestination: good.deps.authorizeDestination,
        deliverOnce: good.deps.deliverOnce,
        [Symbol('leak')]: SECRET_PATH,
      };

      class DepsClass {
        constructor() {
          this.authorizeDestination = good.deps.authorizeDestination;
          this.deliverOnce = good.deps.deliverOnce;
        }
      }

      const cases = [
        null,
        undefined,
        [],
        'deps',
        1,
        true,
        { deliverOnce: good.deps.deliverOnce },
        { authorizeDestination: good.deps.authorizeDestination },
        {
          authorizeDestination: good.deps.authorizeDestination,
          deliverOnce: good.deps.deliverOnce,
          extra: () => {},
        },
        {
          deliverOnce: good.deps.deliverOnce,
          authorizeDestination: good.deps.authorizeDestination,
        },
        {
          authorizeDestination: 'not-fn',
          deliverOnce: good.deps.deliverOnce,
        },
        {
          authorizeDestination: good.deps.authorizeDestination,
          deliverOnce: null,
        },
        {
          authorizeDestination: good.deps.authorizeDestination,
          deliverOnce: 1,
        },
        new Proxy(good.deps, {}),
        trapProxy,
        revokedProxy,
        accessorDeps,
        nonEnum,
        withSymbol,
        new DepsClass(),
      ];

      for (const deps of cases) {
        expectUnavailable(
          () => api.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting(deps),
          [SECRET_PATH, SECRET_TOKEN, SECRET_HOST, SECRET_CLAIM, SECRET_BODY],
        );
      }
      assert.equal(trapHits, 0, 'hostile Proxy/accessor traps must never fire');
    });

    it('factory snapshots function refs; later deps mutation does not rebind', async () => {
      const api = requireApi();
      const harness = createHarness({
        deliver: () => emptyReceipt(),
      });
      const deliver = deliverWith(api, harness);

      harness.deps.authorizeDestination = () => {
        assert.fail('mutated authorizeDestination must not run');
      };
      harness.deps.deliverOnce = async () => {
        assert.fail('mutated deliverOnce must not run');
      };

      const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'empty',
        delivered: false,
      });
      assert.deepEqual(harness.counts(), { authorize: 1, deliver: 1 });
      assert.deepEqual(harness.order, ['authorize', 'deliver']);
    });
  });

  // ── 2. Call order, identity, authorize output contract ──────────────────

  describe('2 authorize-before-deliver order, identity, authorized output', () => {
    it('calls authorize then deliverOnce exactly once with original identities', async () => {
      const api = requireApi();
      const dataDir = DATA_DIR_OBJ;
      const endpoint = ENDPOINT_A;
      const now = FIXED_NOW_OBJ;

      const harness = createHarness({
        authorize: (...args) => {
          assert.equal(args.length, 1, 'authorizeDestination arity must be 1');
          assert.equal(args[0], endpoint);
          assert.equal(typeof args[0], 'string');
          return args[0];
        },
        deliver: (...args) => {
          assert.equal(args.length, 3, 'deliverOnce arity must be 3');
          assert.equal(args[0], dataDir);
          assert.equal(args[1], endpoint);
          assert.equal(args[2], now);
          return emptyReceipt();
        },
      });

      const deliver = deliverWith(api, harness);
      await deliver(dataDir, endpoint, now);

      assert.deepEqual(harness.order, ['authorize', 'deliver']);
      assert.deepEqual(harness.counts(), { authorize: 1, deliver: 1 });
      // rest-args capture: full call arity, no extra parameters.
      assert.equal(harness.authorizeArgs.length, 1);
      assert.equal(harness.authorizeArgs[0].length, 1);
      assert.equal(harness.authorizeArgs[0][0], endpoint);
      assert.equal(harness.deliverArgs.length, 1);
      assert.equal(harness.deliverArgs[0].length, 3);
      assert.deepEqual(harness.deliverArgs[0], [dataDir, endpoint, now]);
      // authorize 只收到 endpoint；deliverOnce 只收到三元组，精确一次。
      assert.equal(harness.authorizeArgs[0][0] === endpoint, true);
      assert.equal(harness.deliverArgs[0][0] === dataDir, true);
      assert.equal(harness.deliverArgs[0][2] === now, true);
    });

    it('authorize deny/throw/malformed output yields zero deliverOnce', async () => {
      const api = requireApi();

      {
        const harness = createHarness({
          authorize: () => {
            throw new Error(`deny ${ENDPOINT_A} token=${SECRET_TOKEN} path=${SECRET_PATH}`);
          },
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [ENDPOINT_A, DATA_DIR, SECRET_TOKEN, SECRET_PATH, 'deny'],
        );
        assert.deepEqual(harness.counts(), { authorize: 1, deliver: 0 });
        assert.deepEqual(harness.order, ['authorize']);
      }

      {
        // Fixed LinkeError deny must still converge to a *fresh* path-free error.
        const original = new LinkeError(CODE_UNAVAILABLE);
        const harness = createHarness({
          authorize: () => {
            throw original;
          },
        });
        const deliver = deliverWith(api, harness);
        await assert.rejects(deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW), (error) => {
          assertUnavailable(error, [ENDPOINT_A, DATA_DIR]);
          assert.notEqual(error, original, 'must rethrow fresh LinkeError, not original');
          return true;
        });
        assert.equal(harness.counts().deliver, 0);
      }

      const conversion = makeConversionTrap(SECRET_PATH);
      const malformedOutputs = [
        null,
        undefined,
        0,
        1,
        true,
        false,
        ENDPOINT_B, // different primitive string
        new String(ENDPOINT_A),
        Buffer.from(ENDPOINT_A),
        new URL(ENDPOINT_A),
        { endpoint: ENDPOINT_A },
        new Proxy({ value: ENDPOINT_A }, {}),
        Promise.resolve(ENDPOINT_A),
        { then: (r) => r(ENDPOINT_A) },
        conversion.value,
        Object(ENDPOINT_A),
      ];

      for (const bad of malformedOutputs) {
        const harness = createHarness({
          authorize: () => bad,
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [ENDPOINT_A, ENDPOINT_B, DATA_DIR, SECRET_PATH, SECRET_TOKEN],
        );
        assert.equal(harness.counts().deliver, 0, 'malformed authorize must not call deliverOnce');
      }
      assert.equal(conversion.hits, 0, 'must not trigger conversion traps on authorize output');
    });

    it('authorize success requires primitive string bit-identical to endpoint', async () => {
      const api = requireApi();

      // Same content, different string instance is still bit-identical via === for interned
      // literals, so use endpoint.slice(0) which is equal by value and by === for primitives
      // when content matches — string primitives compare by content. Use a *different* content
      // for reject, and same content for accept.
      {
        const harness = createHarness({
          authorize: (ep) => {
            assert.equal(typeof ep, 'string');
            // Return a new primitive with identical content (=== holds for string primitives).
            return `${ep}`;
          },
        });
        const deliver = deliverWith(api, harness);
        const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
        assert.deepEqual(receipt, {
          schemaVersion: 1,
          status: 'empty',
          delivered: false,
        });
        assert.equal(harness.deliverArgs[0].length, 3);
        assert.equal(harness.deliverArgs[0][1], ENDPOINT_A);
      }

      // Whitespace / case / trailing slash differences are not bit-identical.
      const nearMisses = [
        `${ENDPOINT_A} `,
        ` ${ENDPOINT_A}`,
        ENDPOINT_A.toUpperCase(),
        `${ENDPOINT_A}/`,
        ENDPOINT_B,
      ];
      for (const near of nearMisses) {
        const harness = createHarness({
          authorize: () => near,
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [ENDPOINT_A, near, DATA_DIR],
        );
        assert.equal(harness.counts().deliver, 0);
      }
    });

    it('passes through async deliverOnce result identity including frozen receipt', async () => {
      const api = requireApi();
      const frozen = emptyReceipt();
      assert.equal(Object.isFrozen(frozen), true);

      const harness = createHarness({
        deliver: async () => frozen,
      });
      const deliver = deliverWith(api, harness);
      const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
      assert.equal(receipt, frozen, 'frozen receipt identity must pass through');
      assertExactKeys(receipt, EMPTY_RECEIPT_KEYS, 'receipt');
    });
  });

  // ── 3. Hostile settle / failure convergence ─────────────────────────────

  describe('3 hostile settle and public failure convergence', () => {
    it('deliverOnce throw/reject converges to fresh path-free unavailable', async () => {
      const api = requireApi();

      {
        const harness = createHarness({
          deliver: () => {
            throw new Error(
              `deliver fail endpoint=${ENDPOINT_A} dir=${DATA_DIR} claim=${SECRET_CLAIM} `
              + `token=${SECRET_TOKEN} body=${SECRET_BODY} header=${SECRET_HEADER}`,
            );
          },
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [
            ENDPOINT_A,
            DATA_DIR,
            SECRET_CLAIM,
            SECRET_TOKEN,
            SECRET_BODY,
            SECRET_HEADER,
            'deliver fail',
          ],
        );
        assert.deepEqual(harness.counts(), { authorize: 1, deliver: 1 });
      }

      {
        const harness = createHarness({
          deliver: async () => {
            throw new Error(`async reject ${SECRET_PATH} ${SECRET_HOST}`);
          },
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [SECRET_PATH, SECRET_HOST, DATA_DIR, ENDPOINT_A],
        );
      }

      {
        const original = new LinkeError(CODE_UNAVAILABLE);
        const harness = createHarness({
          deliver: async () => {
            throw original;
          },
        });
        const deliver = deliverWith(api, harness);
        await assert.rejects(deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW), (error) => {
          assertUnavailable(error);
          assert.notEqual(error, original);
          return true;
        });
      }
    });

    it('hostile thenable from deliverOnce converges; normal Promise is not hostile', async () => {
      const api = requireApi();

      // Normal Promise — must succeed and pass value through.
      {
        const frozen = emptyReceipt();
        const harness = createHarness({
          deliver: () => Promise.resolve(frozen),
        });
        const deliver = deliverWith(api, harness);
        const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
        assert.equal(receipt, frozen);
        assert.deepEqual(harness.counts(), { authorize: 1, deliver: 1 });
      }

      // Async function return (real Promise) — not hostile.
      {
        const harness = createHarness({
          deliver: async () => emptyReceipt(),
        });
        const deliver = deliverWith(api, harness);
        const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
        assert.deepEqual(receipt, {
          schemaVersion: 1,
          status: 'empty',
          delivered: false,
        });
      }

      // Hostile thenable: getter on `then` throws with secret material.
      {
        let thenHits = 0;
        const harness = createHarness({
          deliver: () => ({
            get then() {
              thenHits += 1;
              throw new Error(`hostile-thenable:${SECRET_TOKEN}:${SECRET_PATH}`);
            },
          }),
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [SECRET_TOKEN, SECRET_PATH, ENDPOINT_A, DATA_DIR, 'hostile-thenable'],
        );
        assert.equal(harness.counts().deliver, 1);
        // then may be probed by await; public error still must not leak.
        assert.ok(thenHits >= 0);
      }

      // Thenable that rejects with secret.
      {
        const harness = createHarness({
          deliver: () => ({
            then(_resolve, reject) {
              reject(new Error(`thenable-reject:${SECRET_HOST}:${SECRET_CLAIM}`));
            },
          }),
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [SECRET_HOST, SECRET_CLAIM, ENDPOINT_A, DATA_DIR],
        );
      }
    });

    it('public errors omit endpoint/dataDir/claim/body/header/token/path/cause', async () => {
      const api = requireApi();
      const leak = [
        ENDPOINT_A,
        ENDPOINT_B,
        DATA_DIR,
        SECRET_TOKEN,
        SECRET_PATH,
        SECRET_HOST,
        SECRET_CLAIM,
        SECRET_BODY,
        SECRET_HEADER,
        'authorization',
        'claimId',
      ];

      const cases = [
        async () => {
          const harness = createHarness({
            authorize: () => {
              throw new Error(`auth ${ENDPOINT_A} ${SECRET_TOKEN}`);
            },
          });
          await expectUnavailableAsync(
            deliverWith(api, harness)(DATA_DIR, ENDPOINT_A, FIXED_NOW),
            leak,
          );
        },
        async () => {
          const harness = createHarness({
            authorize: () => ENDPOINT_B,
          });
          await expectUnavailableAsync(
            deliverWith(api, harness)(DATA_DIR, ENDPOINT_A, FIXED_NOW),
            leak,
          );
        },
        async () => {
          const harness = createHarness({
            deliver: () => {
              throw new Error(`wire ${SECRET_BODY} ${SECRET_HEADER}`);
            },
          });
          await expectUnavailableAsync(
            deliverWith(api, harness)(DATA_DIR, ENDPOINT_A, FIXED_NOW),
            leak,
          );
        },
      ];

      for (const run of cases) {
        await run();
      }
    });
  });

  // ── 4. Production factory binding ───────────────────────────────────────

  describe('4 production factory binding (no real network)', () => {
    it('missing/null/exact empty policy deny-all without entering real one-shot/claim', async () => {
      const api = requireApi();
      // 存在且为空的 dataDir：若错误进入 real one-shot，空 outbox 会返回 empty receipt
      // 而非 fixed unavailable，从而本用例必须失败（可证伪 deny 与误入 one-shot）。
      await withEmptyDataDir(async (root) => {
        for (const policy of [undefined, null, { schemaVersion: 1, endpoints: [] }]) {
          const deliver = api.createAuthorizedAuditIntegrityAlertDeliveryOnce(policy);
          assert.equal(typeof deliver, 'function');
          await expectUnavailableAsync(
            deliver(root, ENDPOINT_A, FIXED_NOW),
            [ENDPOINT_A, root, SECRET_TOKEN],
          );
          await assertDataDirEmpty(root);
        }
      });
    });

    it('configured policy allows exact endpoint identity into real one-shot boundary', async () => {
      const api = requireApi();
      // 存在空 dataDir：non-member 必须在 authorize 拒绝且无 artifact；
      // member 进入真实 one-shot 并返回 exact empty receipt（仍无 DNS/HTTPS）。
      await withEmptyDataDir(async (root) => {
        const deliver = api.createAuthorizedAuditIntegrityAlertDeliveryOnce({
          schemaVersion: 1,
          endpoints: [ENDPOINT_A],
        });
        assert.equal(typeof deliver, 'function');

        // Non-member: deny before claim/one-shot (path-free unavailable, no artifacts).
        await expectUnavailableAsync(
          deliver(root, ENDPOINT_B, FIXED_NOW),
          [ENDPOINT_A, ENDPOINT_B, root],
        );
        await assertDataDirEmpty(root);

        // Member: authorize passes → real one-shot → exact empty receipt (empty outbox).
        const receipt = await deliver(root, ENDPOINT_A, FIXED_NOW);
        assertExactKeys(receipt, EMPTY_RECEIPT_KEYS, 'real empty receipt');
        assert.deepEqual(receipt, {
          schemaVersion: 1,
          status: 'empty',
          delivered: false,
        });
        await assertDataDirEmpty(root);
      });
    });

    it('production factory policy compile failure converges to fixed unavailable', () => {
      const api = requireApi();
      const badPolicies = [
        { schemaVersion: 2, endpoints: [ENDPOINT_A] },
        { endpoints: [ENDPOINT_A] },
        { schemaVersion: 1 },
        { schemaVersion: 1, endpoints: [ENDPOINT_A], extra: true },
        { schemaVersion: 1, endpoints: 'not-array' },
        { schemaVersion: 1, endpoints: [ENDPOINT_A, ENDPOINT_A] },
        [],
        'policy',
        1,
        true,
        new Proxy({ schemaVersion: 1, endpoints: [ENDPOINT_A] }, {}),
      ];

      for (const policy of badPolicies) {
        // 编译失败必须在 factory 同步 throw fixed unavailable（不允许延迟到 delivery）。
        expectUnavailable(
          () => api.createAuthorizedAuditIntegrityAlertDeliveryOnce(policy),
          [ENDPOINT_A, SECRET_TOKEN, SECRET_PATH],
        );
      }
    });
  });

  // ── 5. Structural source scan ───────────────────────────────────────────

  describe('5 structural source scan', () => {
    it('imports only util/policy/one-shot/error-codes; authorize-before-deliver gate; no DNS/request/timer/fs/env/Agent/API/Web/scheduler', async () => {
      const source = await readFile(PRODUCTION_MODULE_PATH, 'utf8');

      const importRe = /\bfrom\s+['"]([^'"]+)['"]/g;
      /** @type {string[]} */
      const imports = [];
      for (const match of source.matchAll(importRe)) {
        imports.push(match[1]);
      }

      const allowed = new Set([
        'node:util',
        './audit-integrity-alert-destination-policy.js',
        './audit-integrity-alert-delivery-once.js',
        './error-codes.js',
      ]);
      for (const imp of imports) {
        assert.equal(allowed.has(imp), true, `unexpected import: ${imp}`);
      }
      for (const required of [
        'node:util',
        './audit-integrity-alert-destination-policy.js',
        './audit-integrity-alert-delivery-once.js',
        './error-codes.js',
      ]) {
        assert.equal(imports.includes(required), true, `missing required import: ${required}`);
      }

      // Positive surface anchors (including production policy → capability.authorize binding).
      for (const required of [
        'createAuthorizedAuditIntegrityAlertDeliveryOnce',
        'createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting',
        'createAuditIntegrityAlertDestinationPolicy',
        'deliverAuditIntegrityAlertOnce',
        'AUDIT_DELIVERY_UNAVAILABLE',
        'authorizeDestination',
        'deliverOnce',
        'capability.authorize',
      ]) {
        assert.equal(
          source.includes(required),
          true,
          `expected production surface: ${required}`,
        );
      }

      // Single bounded runtime gate: real code form only (not JSDoc / DEPS_KEYS).
      // Starts at `const authorized = authorizeDestination(endpoint);`, ends at
      // `return await deliverOnce(dataDir, authorized, now);`, with a small span for
      // the two typeof/identity checks + comments.
      const runtimeGateRe =
        /const\s+authorized\s*=\s*authorizeDestination\s*\(\s*endpoint\s*\)\s*;[\s\S]{0,500}?return\s+await\s+deliverOnce\s*\(\s*dataDir\s*,\s*authorized\s*,\s*now\s*\)\s*;/;
      assert.ok(
        runtimeGateRe.test(source),
        'source must contain runtime gate: const authorized = authorizeDestination(endpoint); … return await deliverOnce(dataDir, authorized, now);',
      );

      // Production policy + one-shot binding names present.
      assert.ok(source.includes('createAuditIntegrityAlertDestinationPolicy'));
      assert.ok(source.includes('deliverAuditIntegrityAlertOnce'));
      // claim gate proof: no direct claim import; only via deliverOnce binding.
      assert.equal(
        source.includes('claimAuditIntegrityAlertDelivery'),
        false,
        'authorized-once must not import/call claim directly; gate via deliverOnce only',
      );

      for (const forbidden of [
        'node:https',
        'node:http',
        'node:net',
        'node:tls',
        'node:dns',
        'node:dgram',
        'node:fs',
        'node:fs/promises',
        'fs/promises',
        'node:path',
        'node:child_process',
        'fetch(',
        'globalThis.fetch',
        'node-fetch',
        'undici',
        'process.env',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'NODE_EXTRA_CA_CERTS',
        'Date.now',
        'setTimeout(',
        'setInterval(',
        'setImmediate(',
        'retry',
        'backoff',
        'dead-letter',
        'deadLetter',
        'scheduler',
        'createServer',
        'https.Agent',
        'http.Agent',
        'new Agent',
        'dns.lookup',
        'dns.resolve',
        'lookupAll',
        'readFileSync',
        'writeFileSync',
        'keychain',
        'credential',
        "from './agent.js'",
        "from './server.js'",
        "from './web/",
        "from '../web/",
        'audit-integrity-alert-https-transport',
        'audit-integrity-alert-delivery-claim',
        'audit-integrity-alert-outbox',
        'audit-integrity-alert-delivery-stream',
        'gold-readiness',
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `forbidden production surface: ${forbidden}`,
        );
      }
    });
  });

  // ── 6. Task 5 authorized delivery integration ───────────────────────────
  // Real destination policy + authorized gate + one-shot + claim/outbox/stream
  // + HTTPS transport factory. Only lookupAll/request/timers are faked.

  describe('6 Task 5 authorized delivery integration (real policy/claim/transport, fake network)', () => {
    it('1 policy deny: zero outbox/claim mutation, zero lookupAll/request', async () => {
      const api = requireApi();
      await withTempRoot('deny', async (root) => {
        const entry = headEntry(3);
        const seeded = await seedQueuedHead(root, {
          sequence: 3,
          nextSequence: 4,
          entries: [entry],
        });
        const claimBefore = await readOptional(claimAbs(root));

        // Deny-all policy (exact empty endpoints) and non-member endpoint.
        for (const { policy, endpoint } of [
          { policy: { schemaVersion: 1, endpoints: [] }, endpoint: ENDPOINT_A },
          {
            policy: { schemaVersion: 1, endpoints: [ENDPOINT_A] },
            endpoint: ENDPOINT_B,
          },
        ]) {
          const stack = createAuthorizedIntegration(api, {
            policy,
            endpoint: ENDPOINT_A,
            onEnd: () => {
              assert.fail('transport onEnd must not run on policy deny');
            },
          });

          await expectUnavailableAsync(
            stack.deliver(root, endpoint, FIXED_NOW),
            [
              ENDPOINT_A,
              ENDPOINT_B,
              ENDPOINT_HOSTNAME,
              root,
              PUBLIC_V4,
              SECRET_TOKEN,
              SECRET_PATH,
            ],
          );

          assert.deepEqual(stack.counts(), {
            authorize: 1,
            claim: 0,
            execute: 0,
            complete: 0,
            release: 0,
            lookupAll: 0,
            request: 0,
          });
          assert.deepEqual(stack.order, ['authorize']);
          assert.equal(await readFile(outboxAbs(root), 'utf8'), seeded.outboxRaw);
          assert.equal(await readFile(streamAbs(root), 'utf8'), seeded.streamRaw);
          assert.equal(await readOptional(claimAbs(root)), claimBefore);
        }
      });
    });

    it('2 allow + empty or busy: zero lookupAll/request', async () => {
      const api = requireApi();

      // Empty outbox → exact empty receipt; authorize + claim only.
      await withTempRoot('empty', async (root) => {
        const stack = createAuthorizedIntegration(api, {
          onEnd: () => {
            assert.fail('transport must not run on empty outbox');
          },
        });
        const receipt = await stack.deliver(root, ENDPOINT_A, FIXED_NOW);
        assertEmptyReceipt(receipt);
        assert.deepEqual(stack.counts(), {
          authorize: 1,
          claim: 1,
          execute: 0,
          complete: 0,
          release: 0,
          lookupAll: 0,
          request: 0,
        });
        assert.deepEqual(stack.order, ['authorize', 'claim']);
        assert.equal(await readOptional(claimAbs(root)), null);
        const outbox = await readAuditIntegrityAlertOutbox(root);
        assert.equal(outbox.entries.length, 0);
      });

      // Live claimed head → busy; still zero DNS/request.
      await withTempRoot('busy', async (root) => {
        await seedQueuedHead(root, { sequence: 5, nextSequence: 6 });
        const firstClaim = await claimAuditIntegrityAlertDelivery(
          root,
          ENDPOINT_A,
          FIXED_NOW,
        );
        assert.equal(firstClaim.status, 'claimed');
        assert.equal(firstClaim.sequence, 5);
        const claimRawBefore = await readFile(claimAbs(root), 'utf8');
        const outboxBefore = await readFile(outboxAbs(root), 'utf8');

        const stack = createAuthorizedIntegration(api, {
          onEnd: () => {
            assert.fail('transport must not run on busy claim');
          },
        });
        const receipt = await stack.deliver(root, ENDPOINT_A, FIXED_NOW);
        assertBusyReceipt(receipt, {
          streamId: FIXED_STREAM_ID,
          sequence: 5,
          expiresAt: FIXED_EXPIRES_AT,
        });
        assert.deepEqual(stack.counts(), {
          authorize: 1,
          claim: 1,
          execute: 0,
          complete: 0,
          release: 0,
          lookupAll: 0,
          request: 0,
        });
        assert.equal(await readFile(claimAbs(root), 'utf8'), claimRawBefore);
        assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
      });
    });

    it('3 allow + public DNS + 2xx: FIFO head complete, delivered receipt', async () => {
      const api = requireApi();
      await withTempRoot('accepted', async (root) => {
        const e1 = headEntry(10);
        const e2 = headEntry(11);
        await seedQueuedHead(root, {
          sequence: 10,
          nextSequence: 12,
          entries: [e1, e2],
        });

        const stack = createAuthorizedIntegration(api, {
          onEnd: (call) => {
            assert.equal(call.url, ENDPOINT_A);
            assert.equal(
              /** @type {{ options: { lookup?: unknown } }} */ (call).options
                && typeof /** @type {{ options: { lookup?: unknown } }} */ (call)
                  .options.lookup,
              'function',
            );
            settleResponse(stack.transport, call, 200);
          },
        });

        const receipt = await stack.deliver(root, ENDPOINT_A, FIXED_NOW);
        assertDeliveredReceipt(receipt, {
          streamId: FIXED_STREAM_ID,
          sequence: 10,
          pendingCount: 1,
          completionStatus: 'completed',
        });

        assert.equal(stack.counts().authorize, 1);
        assert.equal(stack.counts().claim, 1);
        assert.equal(stack.counts().execute, 1);
        assert.equal(stack.counts().complete, 1);
        assert.equal(stack.counts().release, 0);
        assert.equal(stack.counts().lookupAll, 1);
        assert.equal(stack.counts().request, 1);
        assert.deepEqual(stack.order, [
          'authorize',
          'claim',
          'execute',
          'request',
          'lookupAll',
          'complete',
        ]);
        assert.equal(stack.transport.lookupAllCalls[0].hostname, ENDPOINT_HOSTNAME);

        const outbox = await readAuditIntegrityAlertOutbox(root);
        assert.deepEqual(outbox.entries.map((e) => e.sequence), [11]);
        assert.equal(outbox.nextSequence, 12);
        assert.deepEqual(outbox.entries[0], e2);
        assert.equal(await readFile(outboxAbs(root), 'utf8'), canonicalOutbox(12, [e2]));
        assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
      });
    });

    it('4 allow + public DNS + bounded non-2xx: release, head unchanged', async () => {
      const api = requireApi();
      await withTempRoot('rejected', async (root) => {
        const entry = headEntry(4);
        const seeded = await seedQueuedHead(root, {
          sequence: 4,
          nextSequence: 5,
          entries: [entry],
        });

        const stack = createAuthorizedIntegration(api, {
          onEnd: (call) => {
            settleResponse(stack.transport, call, 503);
          },
        });

        await expectUnavailableAsync(
          stack.deliver(root, ENDPOINT_A, FIXED_NOW),
          [ENDPOINT_A, ENDPOINT_HOSTNAME, root, PUBLIC_V4, SECRET_TOKEN],
        );

        assert.equal(stack.counts().authorize, 1);
        assert.equal(stack.counts().claim, 1);
        assert.equal(stack.counts().execute, 1);
        assert.equal(stack.counts().complete, 0);
        assert.equal(stack.counts().release, 1);
        assert.equal(stack.counts().lookupAll, 1);
        assert.equal(stack.counts().request, 1);
        assert.ok(stack.order.includes('release'));
        assert.equal(stack.order.includes('complete'), false);

        assert.equal(await readFile(outboxAbs(root), 'utf8'), seeded.outboxRaw);
        assert.equal(await readFile(streamAbs(root), 'utf8'), seeded.streamRaw);
        assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
        const outbox = await readAuditIntegrityAlertOutbox(root);
        assert.deepEqual(outbox.entries.map((e) => e.sequence), [4]);
        assert.deepEqual(outbox.entries[0], entry);
      });
    });

    it('5 allow + mixed/private DNS: fixed failure and durable claim remains', async () => {
      const api = requireApi();
      await withTempRoot('private-dns', async (root) => {
        const entry = headEntry(7);
        const seeded = await seedQueuedHead(root, {
          sequence: 7,
          nextSequence: 8,
          entries: [entry],
        });

        /** @type {Array<{ answers: unknown }>} */
        const dnsScripts = [
          {
            // mixed public + private
            answers: [
              { address: PUBLIC_V4, family: 4 },
              { address: PRIVATE_V4, family: 4 },
            ],
          },
          {
            // all-private / special
            answers: [
              { address: LOOPBACK_V4, family: 4 },
            ],
          },
        ];

        for (const script of dnsScripts) {
          // Reset durable state between matrix rows.
          await writeOutbox(root, 8, [entry]);
          await writeStream(root, FIXED_STREAM_ID);
          await resetClaimIdle(root);

          let releaseHits = 0;
          let completeHits = 0;
          const stack = createAuthorizedIntegration(api, {
            lookupAll(_hostname, callback) {
              callback(null, script.answers);
            },
            completeDelivery: async (...args) => {
              completeHits += 1;
              return completeAuditIntegrityAlertDelivery(...args);
            },
            releaseDelivery: async (...args) => {
              releaseHits += 1;
              return releaseAuditIntegrityAlertDelivery(...args);
            },
          });

          await expectUnavailableAsync(
            stack.deliver(root, ENDPOINT_A, FIXED_NOW),
            [
              ENDPOINT_A,
              ENDPOINT_HOSTNAME,
              root,
              PUBLIC_V4,
              PRIVATE_V4,
              LOOPBACK_V4,
              SECRET_TOKEN,
              SECRET_PATH,
            ],
          );

          assert.equal(stack.counts().lookupAll, 1);
          assert.equal(stack.counts().request, 1);
          assert.equal(completeHits, 0, 'private/mixed DNS must never complete');
          assert.equal(releaseHits, 0, 'private/mixed DNS must never release');

          const claim = await loadClaim(root);
          assert.equal(claim.status, 'claimed');
          assert.equal(claim.streamId, FIXED_STREAM_ID);
          assert.equal(claim.sequence, 7);
          assert.match(String(claim.claimId), /^[0-9a-f-]{36}$/);
          assert.equal(await readFile(outboxAbs(root), 'utf8'), seeded.outboxRaw);

          // Live owner + same now → busy (claim preserved).
          const busy = await claimAuditIntegrityAlertDelivery(
            root,
            ENDPOINT_A,
            FIXED_NOW,
          );
          assert.equal(busy.status, 'busy');
          assert.equal(busy.sequence, 7);
          assert.equal(busy.claimId, null);
          assert.equal(busy.request, null);
        }
      });
    });

    it('6 DNS timeout: durable claim remains', async () => {
      const api = requireApi();
      await withTempRoot('dns-timeout', async (root) => {
        await seedQueuedHead(root, { sequence: 2, nextSequence: 3 });
        const outboxBefore = await readFile(outboxAbs(root), 'utf8');

        /** @type {(() => void) | null} */
        let releaseEntered = null;
        const entered = new Promise((resolve) => {
          releaseEntered = resolve;
        });

        let completeHits = 0;
        let releaseHits = 0;
        const stack = createAuthorizedIntegration(api, {
          lookupAll(_hostname, _callback) {
            // Hang: never invoke callback. DNS sub-deadline must settle the attempt.
            assert.equal(typeof releaseEntered, 'function');
            /** @type {() => void} */ (releaseEntered)();
          },
          completeDelivery: async (...args) => {
            completeHits += 1;
            return completeAuditIntegrityAlertDelivery(...args);
          },
          releaseDelivery: async (...args) => {
            releaseHits += 1;
            return releaseAuditIntegrityAlertDelivery(...args);
          },
        });

        const pending = stack.deliver(root, ENDPOINT_A, FIXED_NOW);
        await entered;
        await flushMicrotasks();

        assert.equal(stack.counts().lookupAll, 1);
        assert.equal(stack.counts().request, 1);
        assert.equal(
          stack.transport.pendingTimersWithMs(DNS_TIMEOUT_MS).length,
          1,
          'DNS sub-deadline must be armed',
        );

        stack.transport.fireTimerMs(DNS_TIMEOUT_MS);

        await expectUnavailableAsync(pending, [
          ENDPOINT_A,
          ENDPOINT_HOSTNAME,
          root,
          PUBLIC_V4,
          SECRET_TOKEN,
        ]);
        assert.equal(completeHits, 0);
        assert.equal(releaseHits, 0);

        const claim = await loadClaim(root);
        assert.equal(claim.status, 'claimed');
        assert.equal(claim.sequence, 2);
        assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
      });
    });

    it('7 accepted then complete failure: never release, durable claim remains', async () => {
      const api = requireApi();
      await withTempRoot('complete-fail', async (root) => {
        const entry = headEntry(8);
        await seedQueuedHead(root, {
          sequence: 8,
          nextSequence: 9,
          entries: [entry],
        });
        const outboxBefore = await readFile(outboxAbs(root), 'utf8');

        let completeHits = 0;
        let releaseHits = 0;
        const stack = createAuthorizedIntegration(api, {
          onEnd: (call) => {
            settleResponse(stack.transport, call, 200);
          },
          completeDelivery: async () => {
            completeHits += 1;
            throw new Error(
              `injected complete fail path=${SECRET_PATH} token=${SECRET_TOKEN} `
              + `endpoint=${ENDPOINT_A} body=${SECRET_BODY}`,
            );
          },
          releaseDelivery: async (...args) => {
            releaseHits += 1;
            return releaseAuditIntegrityAlertDelivery(...args);
          },
        });

        await expectUnavailableAsync(
          stack.deliver(root, ENDPOINT_A, FIXED_NOW),
          [
            ENDPOINT_A,
            ENDPOINT_HOSTNAME,
            root,
            SECRET_PATH,
            SECRET_TOKEN,
            SECRET_BODY,
            PUBLIC_V4,
            'injected complete',
          ],
        );

        assert.equal(stack.counts().lookupAll, 1);
        assert.equal(stack.counts().request, 1);
        assert.equal(completeHits, 1);
        assert.equal(releaseHits, 0, 'accepted+complete-fail must never release');

        const claim = await loadClaim(root);
        assert.equal(claim.status, 'claimed');
        assert.equal(claim.sequence, 8);
        assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);

        // Recoverable via real complete with durable capability.
        const recovered = await completeAuditIntegrityAlertDelivery(root, {
          claimId: claim.claimId,
          streamId: claim.streamId,
          sequence: claim.sequence,
        });
        assert.equal(recovered.status, 'completed');
        assert.equal(recovered.completed, true);
        assert.equal(recovered.sequence, 8);
        assert.equal(recovered.pendingCount, 0);
        assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
        const outbox = await readAuditIntegrityAlertOutbox(root);
        assert.equal(outbox.entries.length, 0);
        assert.equal(outbox.nextSequence, 9);
      });
    });

    it('8 concurrent authorized calls: one claim/one request, other busy', async () => {
      const api = requireApi();
      await withTempRoot('concurrent', async (root) => {
        await seedQueuedHead(root, { sequence: 1, nextSequence: 2 });

        /** @type {object | null} */
        let heldCall = null;
        /** @type {(() => void) | null} */
        let releaseEntered = null;
        const entered = new Promise((resolve) => {
          releaseEntered = resolve;
        });

        const stack = createAuthorizedIntegration(api, {
          onEnd: (call) => {
            // Hold the transport open: first call owns the claim + request.
            heldCall = call;
            assert.equal(typeof releaseEntered, 'function');
            /** @type {() => void} */ (releaseEntered)();
          },
        });

        const firstPromise = stack.deliver(root, ENDPOINT_A, FIXED_NOW);
        await entered;
        await flushMicrotasks();

        assert.equal(stack.counts().claim, 1);
        assert.equal(stack.counts().request, 1);
        assert.equal(stack.counts().lookupAll, 1);
        assert.notEqual(heldCall, null);

        const second = await stack.deliver(root, ENDPOINT_A, FIXED_NOW);
        assertBusyReceipt(second, {
          streamId: FIXED_STREAM_ID,
          sequence: 1,
          expiresAt: FIXED_EXPIRES_AT,
        });
        // Second call authorizes + claims (busy) only — no second DNS/request.
        assert.equal(stack.counts().authorize, 2);
        assert.equal(stack.counts().claim, 2);
        assert.equal(stack.counts().request, 1, 'only one HTTPS request');
        assert.equal(stack.counts().lookupAll, 1, 'only one DNS lookup');
        assert.equal(stack.counts().execute, 1);

        settleResponse(stack.transport, /** @type {object} */ (heldCall), 200);
        const first = await firstPromise;
        assertDeliveredReceipt(first, {
          streamId: FIXED_STREAM_ID,
          sequence: 1,
          pendingCount: 0,
          completionStatus: 'completed',
        });
        assert.equal(stack.counts().request, 1);
        assert.equal(stack.counts().complete, 1);
        assert.equal(stack.counts().release, 0);
        assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
      });
    });

    it('9 public errors never leak endpoint/IP/dataDir/body/token/path/cause', async () => {
      const api = requireApi();
      await withTempRoot('no-leak', async (root) => {
        await seedQueuedHead(root, { sequence: 1, nextSequence: 2 });

        const leak = [
          ENDPOINT_A,
          ENDPOINT_B,
          ENDPOINT_HOSTNAME,
          root,
          PUBLIC_V4,
          PUBLIC_V6,
          PRIVATE_V4,
          LOOPBACK_V4,
          SECRET_TOKEN,
          SECRET_PATH,
          SECRET_HOST,
          SECRET_BODY,
          SECRET_CLAIM,
          'authorization',
          'cause',
        ];

        // Deny path.
        {
          const stack = createAuthorizedIntegration(api, {
            policy: { schemaVersion: 1, endpoints: [ENDPOINT_A] },
          });
          await expectUnavailableAsync(
            stack.deliver(root, ENDPOINT_B, FIXED_NOW),
            leak,
          );
        }

        // Private DNS path (fresh claim each time via idle after prior deny zero-state).
        {
          const stack = createAuthorizedIntegration(api, {
            lookupAll(_hostname, callback) {
              callback(null, [{ address: PRIVATE_V4, family: 4 }]);
            },
          });
          await expectUnavailableAsync(
            stack.deliver(root, ENDPOINT_A, FIXED_NOW),
            leak,
          );
        }

        // Rejected non-2xx path after clearing any durable claim first.
        {
          await resetClaimIdle(root);
          await writeOutbox(root, 2, [headEntry(1)]);

          const stack = createAuthorizedIntegration(api, {
            onEnd: (call) => {
              settleResponse(stack.transport, call, 500);
            },
          });
          await expectUnavailableAsync(
            stack.deliver(root, ENDPOINT_A, FIXED_NOW),
            leak,
          );
        }
      });
    });

    it('10 full stack uses only injectable fakes for DNS/request (no real socket)', async () => {
      const api = requireApi();
      await withTempRoot('no-real-io', async (root) => {
        await seedQueuedHead(root, { sequence: 1, nextSequence: 2 });

        let lookupImplHits = 0;
        let requestSeen = 0;
        const stack = createAuthorizedIntegration(api, {
          lookupAll(hostname, callback) {
            lookupImplHits += 1;
            assert.equal(hostname, ENDPOINT_HOSTNAME);
            // Prove this is the only DNS surface: return public fixture only.
            callback(null, [{ address: PUBLIC_V4, family: 4 }]);
          },
          onEnd: (call) => {
            requestSeen += 1;
            // Fake request object only — no socket fields / real handles.
            assert.equal(typeof call.req.on, 'function');
            assert.equal(typeof call.req.end, 'function');
            assert.equal(
              Object.prototype.hasOwnProperty.call(call.req, 'socket'),
              false,
            );
            settleResponse(stack.transport, call, 204);
          },
        });

        const receipt = await stack.deliver(root, ENDPOINT_A, FIXED_NOW);
        assertDeliveredReceipt(receipt, {
          streamId: FIXED_STREAM_ID,
          sequence: 1,
          pendingCount: 0,
          completionStatus: 'completed',
        });

        assert.equal(lookupImplHits, 1);
        assert.equal(requestSeen, 1);
        assert.equal(stack.counts().lookupAll, 1);
        assert.equal(stack.counts().request, 1);
        // Real modules are bound: policy capability, claim coordinator, HTTPS factory.
        assert.equal(typeof stack.capability.authorize, 'function');
        assert.equal(stack.capability.status, 'configured');
        assert.equal(typeof claimAuditIntegrityAlertDelivery, 'function');
        assert.equal(typeof createAuditIntegrityAlertHttpsExecutorForTesting, 'function');
        assert.equal(typeof createAuditIntegrityAlertDeliveryOnceForTesting, 'function');
        // Timer surface is the harness map only (no wall-clock sleep).
        assert.equal(stack.transport.timers.size, 0);
        assert.ok(stack.transport.clearTimerCalls >= 1);
      });
    });
  });
});
