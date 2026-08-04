/**
 * Task 2 RED — one-shot claim-to-HTTPS delivery coordinator.
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-https-transport-design.md
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-https-transport-plan.md (Task 2)
 *
 * Production (absent on old HEAD / Task 1 archive):
 *   src/audit-integrity-alert-delivery-once.js
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   test name + assert message = `one-shot HTTPS delivery implementation missing`
 * Full matrix registers only when both public exports exist.
 *
 * Pure injected branch matrix + real claim/outbox integration with fake transport only.
 * No real network, DNS, TLS, listener, fetch, or external I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { buildAuditIntegrityAlertDeliveryRequest } from '../src/audit-integrity-alert-delivery.js';
import {
  AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH,
  loadAuditIntegrityAlertDeliveryClaimState,
  publishAuditIntegrityAlertDeliveryClaimState,
} from '../src/audit-integrity-alert-delivery-claim-state.js';
import {
  claimAuditIntegrityAlertDelivery,
  completeAuditIntegrityAlertDelivery,
  releaseAuditIntegrityAlertDelivery,
} from '../src/audit-integrity-alert-delivery-claim.js';
import { AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH } from '../src/audit-integrity-alert-delivery-stream.js';
import {
  AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
  readAuditIntegrityAlertOutbox,
} from '../src/audit-integrity-alert-outbox.js';
import { executeAuditIntegrityAlertHttpsRequest } from '../src/audit-integrity-alert-https-transport.js';
import { enqueueAuditIntegrityWriteTask } from '../src/audit-integrity-write-queue.js';
import { ERROR_CODES } from '../src/error-codes.js';
import { assertSafeDataRoot } from '../src/safe-data-files.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-once.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);

const MISSING_MSG = 'one-shot HTTPS delivery implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

const CANONICAL_ENDPOINT = 'https://alerts.example.invalid/hooks/audit-integrity';
const FIXED_CHECKED_AT = '2026-08-04T12:00:00.000Z';
const FIXED_NOW = '2026-08-04T12:00:00.000Z';
const FIXED_STREAM_ID = 'b2222222-c222-4222-9222-f22222222222';
const CLAIM_ID_A = 'a1111111-b111-4111-8111-e11111111111';
const SECRET_TOKEN = 'Bearer secret-token-xyz';
const SECRET_PATH = '/Users/ah/secret/audit-ca.pem';
const SECRET_HOST = 'evil-cert.example.invalid';
const IDEMPOTENCY_KEY = `audit-integrity-alert:${FIXED_STREAM_ID}:1`;

const DEPS_KEYS = Object.freeze([
  'claimDelivery',
  'executeRequest',
  'completeDelivery',
  'releaseDelivery',
]);
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
const CLAIM_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'claimId',
  'streamId',
  'sequence',
  'expiresAt',
  'request',
]);
const COMPLETE_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'completed',
  'streamId',
  'sequence',
  'pendingCount',
]);
const CAPABILITY_KEYS = Object.freeze(['claimId', 'streamId', 'sequence']);
const REQUEST_KEYS = Object.freeze(['schemaVersion', 'url', 'method', 'headers', 'body']);
const TRANSPORT_RESULT_KEYS = Object.freeze(['schemaVersion', 'status']);

const CANONICAL_IDLE_CLAIM_BYTES =
  '{"schemaVersion":1,"status":"idle","claimId":null,"streamId":null,"sequence":null,"ownerPid":null,"bootSessionIdentity":null,"processStartIdentity":null,"claimedAt":null,"expiresAt":null}\n';

/** @type {null | {
 *   deliverAuditIntegrityAlertOnce: Function,
 *   createAuditIntegrityAlertDeliveryOnceForTesting: Function,
 * }} */
let onceApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.deliverAuditIntegrityAlertOnce === 'function'
    && typeof mod.createAuditIntegrityAlertDeliveryOnceForTesting === 'function'
  ) {
    onceApi = {
      deliverAuditIntegrityAlertOnce: mod.deliverAuditIntegrityAlertOnce,
      createAuditIntegrityAlertDeliveryOnceForTesting:
        mod.createAuditIntegrityAlertDeliveryOnceForTesting,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    onceApi = null;
  } else {
    // Syntax/load errors in an existing production module must surface as themselves.
    throw error;
  }
}

function requireApi() {
  if (implementationMissing || onceApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {NonNullable<typeof onceApi>} */ (onceApi);
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
 * Receipts must never expose claim capability, request wire data, endpoint,
 * response, errno, token, or path-like content.
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
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'response'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'error'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'errno'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'token'), false);

  const text = JSON.stringify(receipt);
  for (const token of [
    'claimId',
    '"request"',
    CANONICAL_ENDPOINT,
    'alerts.example.invalid',
    SECRET_TOKEN,
    SECRET_PATH,
    SECRET_HOST,
    IDEMPOTENCY_KEY,
    'authorization',
    'content-type',
    'ENOENT',
    'EACCES',
    'errno',
    '/var/',
    '/private/',
    '/tmp/',
    'Users/',
    'integrity-alert-delivery-claim',
    'integrity-alert-outbox',
    ...extraLeakTokens,
  ]) {
    if (!token || token.length < 2) continue;
    assert.equal(text.includes(token), false, `receipt must not contain ${token}`);
  }
}

/**
 * All public-boundary failures use path-free audit-delivery-unavailable.
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
    ...Object.keys(/** @type {object} */ (error))
      .filter((key) => key !== 'stack')
      .map((key) => String(/** @type {Record<string, unknown>} */ (error)[key])),
  ].join('\0');

  for (const token of [
    CANONICAL_ENDPOINT,
    'alerts.example.invalid',
    SECRET_TOKEN,
    SECRET_PATH,
    SECRET_HOST,
    IDEMPOTENCY_KEY,
    CLAIM_ID_A,
    'ENOENT',
    'EACCES',
    'EPERM',
    'ECONNRESET',
    'ENOTFOUND',
    'errno',
    '/var/',
    '/private/',
    '/tmp/',
    'Users/',
    'authorization',
    'cookie',
    'integrity-alert-delivery-claim',
    'integrity-alert-outbox',
    ...leakTokens,
  ]) {
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

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (!Object.isFrozen(value)) Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
  }
  return value;
}

// ─── Canonical claim / transport fixtures ─────────────────────────────────

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

function canonicalRequest(sequence = 1, streamId = FIXED_STREAM_ID) {
  return buildAuditIntegrityAlertDeliveryRequest(
    CANONICAL_ENDPOINT,
    streamId,
    headEntry(sequence),
  );
}

/**
 * Exact-key frozen claim receipt matching claimAuditIntegrityAlertDelivery.
 * @param {'empty' | 'busy' | 'claimed'} status
 * @param {object} [fields]
 */
function claimFixture(status, fields = {}) {
  if (status === 'empty') {
    return deepFreeze({
      schemaVersion: 1,
      status: 'empty',
      claimId: null,
      streamId: null,
      sequence: null,
      expiresAt: null,
      request: null,
    });
  }
  if (status === 'busy') {
    return deepFreeze({
      schemaVersion: 1,
      status: 'busy',
      claimId: null,
      streamId: fields.streamId ?? FIXED_STREAM_ID,
      sequence: fields.sequence ?? 1,
      expiresAt: fields.expiresAt ?? '2026-08-04T12:02:00.000Z',
      request: null,
    });
  }
  const streamId = fields.streamId ?? FIXED_STREAM_ID;
  const sequence = fields.sequence ?? 1;
  const request = fields.request ?? canonicalRequest(sequence, streamId);
  return deepFreeze({
    schemaVersion: 1,
    status: 'claimed',
    claimId: fields.claimId ?? CLAIM_ID_A,
    streamId,
    sequence,
    expiresAt: fields.expiresAt ?? '2026-08-04T12:02:00.000Z',
    request,
  });
}

function acceptedResult() {
  return deepFreeze({ schemaVersion: 1, status: 'accepted' });
}

function rejectedResult() {
  return deepFreeze({ schemaVersion: 1, status: 'rejected' });
}

/**
 * Exact complete receipt matching completeAuditIntegrityAlertDelivery.
 * @param {'completed' | 'already-completed'} status
 * @param {object} [fields]
 */
function completeFixture(status, fields = {}) {
  return deepFreeze({
    schemaVersion: 1,
    status,
    completed: true,
    streamId: fields.streamId ?? FIXED_STREAM_ID,
    sequence: fields.sequence ?? 1,
    pendingCount: fields.pendingCount ?? 0,
  });
}

/**
 * Counting dep harness for pure branch matrix.
 * @param {{
 *   claim?: object | (() => object | Promise<object>),
 *   execute?: object | Error | (() => object | Promise<object>),
 *   complete?: object | Error | (() => object | Promise<object>),
 *   release?: object | Error | (() => object | Promise<object>),
 * }} [script]
 */
function createInjectedHarness(script = {}) {
  /** @type {unknown[]} */
  const claimArgs = [];
  /** @type {unknown[]} */
  const executeArgs = [];
  /** @type {unknown[]} */
  const completeArgs = [];
  /** @type {unknown[]} */
  const releaseArgs = [];

  /**
   * @param {unknown} value
   * @param {string} label
   */
  async function resolveScript(value, label) {
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value();
    if (value === undefined) {
      throw new Error(`test harness missing script for ${label}`);
    }
    return value;
  }

  const deps = {
    async claimDelivery(...args) {
      claimArgs.push(args);
      return resolveScript(
        Object.prototype.hasOwnProperty.call(script, 'claim')
          ? script.claim
          : claimFixture('empty'),
        'claim',
      );
    },
    async executeRequest(...args) {
      executeArgs.push(args);
      return resolveScript(
        Object.prototype.hasOwnProperty.call(script, 'execute')
          ? script.execute
          : acceptedResult(),
        'execute',
      );
    },
    async completeDelivery(...args) {
      completeArgs.push(args);
      return resolveScript(
        Object.prototype.hasOwnProperty.call(script, 'complete')
          ? script.complete
          : completeFixture('completed'),
        'complete',
      );
    },
    async releaseDelivery(...args) {
      releaseArgs.push(args);
      return resolveScript(
        Object.prototype.hasOwnProperty.call(script, 'release')
          ? script.release
          : deepFreeze({
            schemaVersion: 1,
            status: 'released',
            released: true,
            streamId: FIXED_STREAM_ID,
            sequence: 1,
          }),
        'release',
      );
    },
  };

  assertExactKeys(deps, DEPS_KEYS, 'harness deps');

  return {
    deps,
    claimArgs,
    executeArgs,
    completeArgs,
    releaseArgs,
    counts() {
      return {
        claim: claimArgs.length,
        execute: executeArgs.length,
        complete: completeArgs.length,
        release: releaseArgs.length,
      };
    },
  };
}

/**
 * @param {ReturnType<typeof requireApi>} api
 * @param {ReturnType<typeof createInjectedHarness>} harness
 */
function deliverWith(api, harness) {
  return api.createAuditIntegrityAlertDeliveryOnceForTesting(harness.deps);
}

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

function assertBusyReceipt(receipt, { streamId, sequence, expiresAt }) {
  assertExactKeys(receipt, BUSY_RECEIPT_KEYS, 'busy receipt');
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, 'busy');
  assert.equal(receipt.delivered, false);
  assert.equal(receipt.streamId, streamId);
  assert.equal(receipt.sequence, sequence);
  assert.equal(receipt.expiresAt, expiresAt);
  assertDeeplyFrozen(receipt);
  assertReceiptSanitized(receipt);
}

function assertDeliveredReceipt(receipt, {
  streamId,
  sequence,
  pendingCount,
  completionStatus,
}) {
  assertExactKeys(receipt, DELIVERED_RECEIPT_KEYS, 'delivered receipt');
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, 'delivered');
  assert.equal(receipt.delivered, true);
  assert.equal(receipt.streamId, streamId);
  assert.equal(receipt.sequence, sequence);
  assert.equal(receipt.pendingCount, pendingCount);
  assert.equal(receipt.completionStatus, completionStatus);
  assertDeeplyFrozen(receipt);
  assertReceiptSanitized(receipt);
}

function expectedCapability(claimId = CLAIM_ID_A, streamId = FIXED_STREAM_ID, sequence = 1) {
  return {
    claimId,
    streamId,
    sequence,
  };
}

// ─── Real root / outbox helpers (integration only) ────────────────────────

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-delivery-once-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function withLease(root, fn) {
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

function claimAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH);
}
function outboxAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH);
}
function streamAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH);
}

function canonicalOutbox(nextSequence, entries) {
  return `${JSON.stringify({ schemaVersion: 1, nextSequence, entries })}\n`;
}

function canonicalStream(streamId) {
  return `${JSON.stringify({ schemaVersion: 1, streamId })}\n`;
}

async function writeOutbox(root, nextSequence, entries) {
  const abs = outboxAbs(root);
  await mkdir(dirname(abs), { recursive: true });
  const raw = canonicalOutbox(nextSequence, entries);
  await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
  return raw;
}

async function writeStream(root, streamId) {
  const abs = streamAbs(root);
  await mkdir(dirname(abs), { recursive: true });
  const raw = canonicalStream(streamId);
  await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
  return raw;
}

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

async function loadClaim(root) {
  return withLease(root, async (resolvedRoot, lease) => {
    return loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease);
  });
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Capture FileHandle.prototype write path via a temporary open (repo test pattern).
 * Used only for scoped idle-claim write fault injection; always restored in finally.
 * @returns {Promise<{
 *   proto: object,
 *   originalWriteFile: Function,
 *   originalWrite: Function,
 * }>}
 */
async function captureFileHandleWritePath() {
  const probeRoot = await mkdtemp(join(tmpdir(), 'linke-delivery-once-fh-'));
  try {
    const probePath = join(probeRoot, 'probe');
    const fh = await open(probePath, constants.O_CREAT | constants.O_RDWR, 0o600);
    try {
      const proto = Object.getPrototypeOf(fh);
      const originalWriteFile = proto.writeFile;
      const originalWrite = proto.write;
      assert.equal(typeof originalWriteFile, 'function');
      assert.equal(typeof originalWrite, 'function');
      return { proto, originalWriteFile, originalWrite };
    } finally {
      await fh.close();
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Normalize FileHandle write / writeFile first-arg into utf8 text when possible.
 * @param {unknown} data
 * @returns {string | null}
 */
function payloadTextOrNull(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  return null;
}

/**
 * Build one-shot with real claim/complete/release and injected fake executor only.
 * @param {ReturnType<typeof requireApi>} api
 * @param {(request: unknown) => Promise<unknown>} executeRequest
 * @param {{
 *   completeDelivery?: Function,
 *   releaseDelivery?: Function,
 * }} [overrides]
 */
function createRealClaimFakeTransport(api, executeRequest, overrides = {}) {
  const deps = {
    claimDelivery: claimAuditIntegrityAlertDelivery,
    executeRequest,
    completeDelivery: overrides.completeDelivery ?? completeAuditIntegrityAlertDelivery,
    releaseDelivery: overrides.releaseDelivery ?? releaseAuditIntegrityAlertDelivery,
  };
  assertExactKeys(deps, DEPS_KEYS, 'real-claim deps');
  return api.createAuditIntegrityAlertDeliveryOnceForTesting(deps);
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe('audit integrity alert delivery once (Task 2 RED)', () => {
  // Old-HEAD / Task-1 archive: exactly one dedicated RED. Full matrix only when exports exist.
  if (implementationMissing || onceApi === null) {
    it('one-shot HTTPS delivery implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── 1. Exports, factory contract, frozen sanitized receipts ────────────

  describe('1 exports, factory contract, frozen sanitized receipts', () => {
    it('exports deliver once and test factory; registered fixed error code', () => {
      const api = requireApi();
      assert.equal(typeof api.deliverAuditIntegrityAlertOnce, 'function');
      assert.equal(typeof api.createAuditIntegrityAlertDeliveryOnceForTesting, 'function');
      assert.equal(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, CODE_UNAVAILABLE);
    });

    it('factory rejects missing/extra/reordered/non-function/proxy/hostile deps without traps', () => {
      const api = requireApi();
      const good = createInjectedHarness();
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
      });

      const cases = [
        null,
        undefined,
        [],
        'deps',
        1,
        {
          executeRequest: good.deps.executeRequest,
          completeDelivery: good.deps.completeDelivery,
          releaseDelivery: good.deps.releaseDelivery,
        },
        {
          claimDelivery: good.deps.claimDelivery,
          executeRequest: good.deps.executeRequest,
          completeDelivery: good.deps.completeDelivery,
          releaseDelivery: good.deps.releaseDelivery,
          extra: () => {},
        },
        {
          executeRequest: good.deps.executeRequest,
          claimDelivery: good.deps.claimDelivery,
          completeDelivery: good.deps.completeDelivery,
          releaseDelivery: good.deps.releaseDelivery,
        },
        {
          claimDelivery: 'not-fn',
          executeRequest: good.deps.executeRequest,
          completeDelivery: good.deps.completeDelivery,
          releaseDelivery: good.deps.releaseDelivery,
        },
        {
          claimDelivery: good.deps.claimDelivery,
          executeRequest: good.deps.executeRequest,
          completeDelivery: good.deps.completeDelivery,
          releaseDelivery: null,
        },
        new Proxy(good.deps, {}),
        trapProxy,
      ];

      for (const deps of cases) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDeliveryOnceForTesting(deps),
          [SECRET_PATH, SECRET_TOKEN, SECRET_HOST],
        );
      }
      assert.equal(trapHits, 0, 'hostile Proxy traps must never fire');
    });

    it('empty/busy/delivered receipts are exact-key deep-frozen and sanitized', async () => {
      const api = requireApi();

      {
        const harness = createInjectedHarness({ claim: claimFixture('empty') });
        const deliver = deliverWith(api, harness);
        const receipt = await deliver('/safe/data', CANONICAL_ENDPOINT, FIXED_NOW);
        assertEmptyReceipt(receipt);
        assert.deepEqual(harness.counts(), {
          claim: 1, execute: 0, complete: 0, release: 0,
        });
      }

      {
        const busy = claimFixture('busy', {
          streamId: FIXED_STREAM_ID,
          sequence: 7,
          expiresAt: '2026-08-04T12:02:00.000Z',
        });
        const harness = createInjectedHarness({ claim: busy });
        const deliver = deliverWith(api, harness);
        const receipt = await deliver('/safe/data', CANONICAL_ENDPOINT, FIXED_NOW);
        assertBusyReceipt(receipt, {
          streamId: FIXED_STREAM_ID,
          sequence: 7,
          expiresAt: '2026-08-04T12:02:00.000Z',
        });
        assert.deepEqual(harness.counts(), {
          claim: 1, execute: 0, complete: 0, release: 0,
        });
      }

      {
        const harness = createInjectedHarness({
          claim: claimFixture('claimed'),
          execute: acceptedResult(),
          complete: completeFixture('completed', { pendingCount: 2 }),
        });
        const deliver = deliverWith(api, harness);
        const receipt = await deliver('/safe/data', CANONICAL_ENDPOINT, FIXED_NOW);
        assertDeliveredReceipt(receipt, {
          streamId: FIXED_STREAM_ID,
          sequence: 1,
          pendingCount: 2,
          completionStatus: 'completed',
        });
      }
    });
  });

  // ── 2. Pure injected branch matrix ─────────────────────────────────────

  describe('2 pure injected branch matrix', () => {
    it('empty: zero execute/complete/release, exact empty receipt', async () => {
      const api = requireApi();
      const harness = createInjectedHarness({ claim: claimFixture('empty') });
      const deliver = deliverWith(api, harness);
      const receipt = await deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW);
      assertEmptyReceipt(receipt);
      assert.deepEqual(harness.counts(), {
        claim: 1, execute: 0, complete: 0, release: 0,
      });
      assert.deepEqual(harness.claimArgs[0], ['data-dir', CANONICAL_ENDPOINT, FIXED_NOW]);
    });

    it('busy: zero execute/complete/release, exact sanitized busy receipt', async () => {
      const api = requireApi();
      const busy = claimFixture('busy', {
        streamId: FIXED_STREAM_ID,
        sequence: 3,
        expiresAt: '2026-08-04T12:02:00.000Z',
      });
      const harness = createInjectedHarness({ claim: busy });
      const deliver = deliverWith(api, harness);
      const receipt = await deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW);
      assertBusyReceipt(receipt, {
        streamId: FIXED_STREAM_ID,
        sequence: 3,
        expiresAt: '2026-08-04T12:02:00.000Z',
      });
      assert.deepEqual(harness.counts(), {
        claim: 1, execute: 0, complete: 0, release: 0,
      });
    });

    it('claimed + exact accepted: execute once, complete once, release zero, delivered', async () => {
      const api = requireApi();
      const claimed = claimFixture('claimed');
      const harness = createInjectedHarness({
        claim: claimed,
        execute: acceptedResult(),
        complete: completeFixture('completed', { pendingCount: 0 }),
      });
      const deliver = deliverWith(api, harness);
      const receipt = await deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW);
      assertDeliveredReceipt(receipt, {
        streamId: FIXED_STREAM_ID,
        sequence: 1,
        pendingCount: 0,
        completionStatus: 'completed',
      });
      assert.deepEqual(harness.counts(), {
        claim: 1, execute: 1, complete: 1, release: 0,
      });
      assert.equal(harness.executeArgs.length, 1);
      assert.deepEqual(harness.executeArgs[0], [claimed.request]);
      assert.equal(harness.completeArgs.length, 1);
      assert.deepEqual(harness.completeArgs[0], [
        'data-dir',
        expectedCapability(),
      ]);
      assertExactKeys(harness.completeArgs[0][1], CAPABILITY_KEYS, 'complete capability');
    });

    it('accepted + completion already-completed: exact delivered receipt with completionStatus', async () => {
      const api = requireApi();
      const harness = createInjectedHarness({
        claim: claimFixture('claimed'),
        execute: acceptedResult(),
        complete: completeFixture('already-completed', { pendingCount: 1 }),
      });
      const deliver = deliverWith(api, harness);
      const receipt = await deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW);
      assertDeliveredReceipt(receipt, {
        streamId: FIXED_STREAM_ID,
        sequence: 1,
        pendingCount: 1,
        completionStatus: 'already-completed',
      });
      assert.deepEqual(harness.counts(), {
        claim: 1, execute: 1, complete: 1, release: 0,
      });
    });

    it('accepted + complete throws: release zero, fixed public error', async () => {
      const api = requireApi();
      const harness = createInjectedHarness({
        claim: claimFixture('claimed'),
        execute: acceptedResult(),
        complete: new Error(`complete boom ${SECRET_PATH} ${CLAIM_ID_A}`),
      });
      const deliver = deliverWith(api, harness);
      await expectUnavailableAsync(
        deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW),
        [SECRET_PATH, CLAIM_ID_A, 'complete boom'],
      );
      assert.deepEqual(harness.counts(), {
        claim: 1, execute: 1, complete: 1, release: 0,
      });
    });

    it('claimed + exact rejected: release once, complete zero, then fixed public error', async () => {
      const api = requireApi();
      const claimed = claimFixture('claimed');
      const harness = createInjectedHarness({
        claim: claimed,
        execute: rejectedResult(),
      });
      const deliver = deliverWith(api, harness);
      await expectUnavailableAsync(deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW));
      assert.deepEqual(harness.counts(), {
        claim: 1, execute: 1, complete: 0, release: 1,
      });
      assert.deepEqual(harness.executeArgs[0], [claimed.request]);
      assert.deepEqual(harness.releaseArgs[0], [
        'data-dir',
        expectedCapability(),
      ]);
      assertExactKeys(harness.releaseArgs[0][1], CAPABILITY_KEYS, 'release capability');
    });

    it('rejected + release throws: complete zero, fixed public error', async () => {
      const api = requireApi();
      const harness = createInjectedHarness({
        claim: claimFixture('claimed'),
        execute: rejectedResult(),
        release: new Error(`release boom ${SECRET_TOKEN}`),
      });
      const deliver = deliverWith(api, harness);
      await expectUnavailableAsync(
        deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW),
        [SECRET_TOKEN, 'release boom'],
      );
      assert.deepEqual(harness.counts(), {
        claim: 1, execute: 1, complete: 0, release: 1,
      });
    });

    it('execute throws: complete/release zero, fixed public error', async () => {
      const api = requireApi();
      const harness = createInjectedHarness({
        claim: claimFixture('claimed'),
        execute: new Error(`TLS ${SECRET_HOST} errno=ECONNRESET path=${SECRET_PATH}`),
      });
      const deliver = deliverWith(api, harness);
      await expectUnavailableAsync(
        deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW),
        [SECRET_HOST, SECRET_PATH, 'ECONNRESET'],
      );
      assert.deepEqual(harness.counts(), {
        claim: 1, execute: 1, complete: 0, release: 0,
      });
    });

    it('malformed execute result: complete/release zero, fixed public error', async () => {
      const api = requireApi();
      const malformed = [
        null,
        undefined,
        'accepted',
        1,
        [],
        { status: 'accepted' },
        { schemaVersion: 1, status: 'accepted', extra: true },
        { status: 'accepted', schemaVersion: 1 },
        { schemaVersion: 2, status: 'accepted' },
        { schemaVersion: 1, status: 'ok' },
        { schemaVersion: 1, status: 'Accepted' },
        deepFreeze({ schemaVersion: 1, status: 'accepted', body: SECRET_TOKEN }),
      ];

      for (const bad of malformed) {
        const harness = createInjectedHarness({
          claim: claimFixture('claimed'),
          execute: bad,
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW),
          [SECRET_TOKEN],
        );
        assert.deepEqual(harness.counts(), {
          claim: 1, execute: 1, complete: 0, release: 0,
        }, `malformed=${JSON.stringify(bad)}`);
      }
    });

    it('malformed/extra/reordered/proxy/accessor/symbol/non-enumerable/class claim/complete fail closed', async () => {
      const api = requireApi();

      // Hostile claim receipts — must not reach execute/complete/release.
      const goodClaim = claimFixture('claimed');
      const claimHostiles = [];

      const extraClaim = { ...goodClaim, extra: true };
      claimHostiles.push(extraClaim);

      const reorderedClaim = {
        status: 'claimed',
        schemaVersion: 1,
        claimId: CLAIM_ID_A,
        streamId: FIXED_STREAM_ID,
        sequence: 1,
        expiresAt: '2026-08-04T12:02:00.000Z',
        request: goodClaim.request,
      };
      assert.notDeepEqual(Object.keys(reorderedClaim), [...CLAIM_RECEIPT_KEYS]);
      claimHostiles.push(reorderedClaim);

      const missingRequest = {
        schemaVersion: 1,
        status: 'claimed',
        claimId: CLAIM_ID_A,
        streamId: FIXED_STREAM_ID,
        sequence: 1,
        expiresAt: '2026-08-04T12:02:00.000Z',
      };
      claimHostiles.push(missingRequest);

      claimHostiles.push(new Proxy(goodClaim, {}));

      const accessorClaim = {};
      for (const key of CLAIM_RECEIPT_KEYS) {
        Object.defineProperty(accessorClaim, key, {
          enumerable: true,
          get() {
            throw new Error(`claim-accessor:${SECRET_PATH}`);
          },
        });
      }
      claimHostiles.push(accessorClaim);

      claimHostiles.push({
        ...goodClaim,
        [Symbol('leak')]: SECRET_TOKEN,
      });

      const nonEnumClaim = { ...goodClaim };
      Object.defineProperty(nonEnumClaim, 'hidden', {
        value: SECRET_TOKEN,
        enumerable: false,
      });
      claimHostiles.push(nonEnumClaim);

      class ClaimClass {
        constructor() {
          Object.assign(this, goodClaim);
        }
      }
      claimHostiles.push(new ClaimClass());

      claimHostiles.push(null, undefined, 'claimed', 42, []);

      for (const bad of claimHostiles) {
        let trapHits = 0;
        const harness = createInjectedHarness({
          claim: async () => bad,
          execute: async () => {
            trapHits += 1;
            assert.fail('execute must not run for hostile claim');
          },
          complete: async () => {
            trapHits += 1;
            assert.fail('complete must not run for hostile claim');
          },
          release: async () => {
            trapHits += 1;
            assert.fail('release must not run for hostile claim');
          },
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW),
          [SECRET_PATH, SECRET_TOKEN, CLAIM_ID_A],
        );
        assert.equal(trapHits, 0);
        assert.deepEqual(harness.counts(), {
          claim: 1, execute: 0, complete: 0, release: 0,
        });
      }

      // Hostile complete receipts after accepted — never release; fixed error.
      const goodComplete = completeFixture('completed');
      const completeHostiles = [];

      completeHostiles.push({ ...goodComplete, extra: true });
      completeHostiles.push({
        status: 'completed',
        schemaVersion: 1,
        completed: true,
        streamId: FIXED_STREAM_ID,
        sequence: 1,
        pendingCount: 0,
      });
      completeHostiles.push({
        schemaVersion: 1,
        status: 'completed',
        completed: true,
        streamId: FIXED_STREAM_ID,
        sequence: 1,
      });
      completeHostiles.push(new Proxy(goodComplete, {}));

      const accessorComplete = {};
      for (const key of COMPLETE_RECEIPT_KEYS) {
        Object.defineProperty(accessorComplete, key, {
          enumerable: true,
          get() {
            throw new Error(`complete-accessor:${SECRET_HOST}`);
          },
        });
      }
      completeHostiles.push(accessorComplete);

      completeHostiles.push({
        ...goodComplete,
        [Symbol('x')]: SECRET_PATH,
      });

      const nonEnumComplete = { ...goodComplete };
      Object.defineProperty(nonEnumComplete, 'hidden', {
        value: SECRET_TOKEN,
        enumerable: false,
      });
      completeHostiles.push(nonEnumComplete);

      class CompleteClass {
        constructor() {
          Object.assign(this, goodComplete);
        }
      }
      completeHostiles.push(new CompleteClass());
      completeHostiles.push(null, 'completed', 1, []);

      for (const bad of completeHostiles) {
        let releaseHits = 0;
        const harness = createInjectedHarness({
          claim: claimFixture('claimed'),
          execute: acceptedResult(),
          complete: async () => bad,
          release: async () => {
            releaseHits += 1;
            assert.fail('release must not run after accepted+hostile complete');
          },
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW),
          [SECRET_PATH, SECRET_TOKEN, SECRET_HOST],
        );
        assert.equal(releaseHits, 0);
        assert.deepEqual(harness.counts(), {
          claim: 1, execute: 1, complete: 1, release: 0,
        });
      }
    });

    it('only exact capability {claimId,streamId,sequence} is passed to complete/release', async () => {
      const api = requireApi();
      // Claim descriptor includes extras that must never be forwarded.
      const request = canonicalRequest(5);
      const claimed = deepFreeze({
        schemaVersion: 1,
        status: 'claimed',
        claimId: CLAIM_ID_A,
        streamId: FIXED_STREAM_ID,
        sequence: 5,
        expiresAt: '2026-08-04T12:02:00.000Z',
        request,
      });

      {
        const harness = createInjectedHarness({
          claim: claimed,
          execute: acceptedResult(),
          complete: completeFixture('completed', { sequence: 5, pendingCount: 0 }),
        });
        const deliver = deliverWith(api, harness);
        await deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW);
        assert.deepEqual(harness.completeArgs[0][1], {
          claimId: CLAIM_ID_A,
          streamId: FIXED_STREAM_ID,
          sequence: 5,
        });
        assertExactKeys(harness.completeArgs[0][1], CAPABILITY_KEYS, 'complete capability');
        assert.equal(Object.hasOwn(harness.completeArgs[0][1], 'request'), false);
        assert.equal(Object.hasOwn(harness.completeArgs[0][1], 'expiresAt'), false);
        assert.equal(Object.hasOwn(harness.completeArgs[0][1], 'status'), false);
        assert.deepEqual(harness.executeArgs[0][0], request);
      }

      {
        const harness = createInjectedHarness({
          claim: claimed,
          execute: rejectedResult(),
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW));
        assert.deepEqual(harness.releaseArgs[0][1], {
          claimId: CLAIM_ID_A,
          streamId: FIXED_STREAM_ID,
          sequence: 5,
        });
        assertExactKeys(harness.releaseArgs[0][1], CAPABILITY_KEYS, 'release capability');
        assert.equal(Object.hasOwn(harness.releaseArgs[0][1], 'request'), false);
        assert.equal(Object.hasOwn(harness.releaseArgs[0][1], 'expiresAt'), false);
      }
    });

    it('claim throws: execute/complete/release zero, fixed public error', async () => {
      const api = requireApi();
      const harness = createInjectedHarness({
        claim: new Error(`claim failed ${SECRET_PATH}`),
      });
      const deliver = deliverWith(api, harness);
      await expectUnavailableAsync(
        deliver('data-dir', CANONICAL_ENDPOINT, FIXED_NOW),
        [SECRET_PATH],
      );
      assert.deepEqual(harness.counts(), {
        claim: 1, execute: 0, complete: 0, release: 0,
      });
    });
  });

  // ── 3. Real local claim integration, fake transport only ───────────────

  describe('3 real local claim integration, fake transport only', () => {
    it('1 accepted fake executor removes exact FIFO head; successor remains; pendingCount exact', async () => {
      const api = requireApi();
      await withTempRoot('accepted-ack', async (root) => {
        const e1 = headEntry(10);
        const e2 = headEntry(11);
        await seedQueuedHead(root, {
          sequence: 10,
          nextSequence: 12,
          entries: [e1, e2],
        });

        /** @type {unknown[]} */
        const executeArgs = [];
        const deliver = createRealClaimFakeTransport(api, async (request) => {
          executeArgs.push(request);
          assertExactKeys(request, REQUEST_KEYS, 'request');
          return acceptedResult();
        });

        const receipt = await deliver(root, CANONICAL_ENDPOINT, FIXED_NOW);
        assertDeliveredReceipt(receipt, {
          streamId: FIXED_STREAM_ID,
          sequence: 10,
          pendingCount: 1,
          completionStatus: 'completed',
        });
        assert.equal(executeArgs.length, 1);

        const outbox = await readAuditIntegrityAlertOutbox(root);
        assert.deepEqual(outbox.entries.map((e) => e.sequence), [11]);
        assert.equal(outbox.nextSequence, 12);
        assert.deepEqual(outbox.entries[0], e2);
        assert.equal(await readFile(outboxAbs(root), 'utf8'), canonicalOutbox(12, [e2]));
        assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
      });
    });

    it('2 rejected fake executor releases claim; FIFO head bytes/sequence unchanged', async () => {
      const api = requireApi();
      await withTempRoot('rejected-release', async (root) => {
        const entry = headEntry(4);
        const seeded = await seedQueuedHead(root, {
          sequence: 4,
          nextSequence: 5,
          entries: [entry],
        });
        const outboxBefore = seeded.outboxRaw;
        const streamBefore = seeded.streamRaw;

        let executeCount = 0;
        const deliver = createRealClaimFakeTransport(api, async () => {
          executeCount += 1;
          return rejectedResult();
        });

        await expectUnavailableAsync(
          deliver(root, CANONICAL_ENDPOINT, FIXED_NOW),
          [root, FIXED_STREAM_ID],
        );
        assert.equal(executeCount, 1);

        assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
        assert.equal(await readFile(streamAbs(root), 'utf8'), streamBefore);
        assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);

        const outbox = await readAuditIntegrityAlertOutbox(root);
        assert.deepEqual(outbox.entries.map((e) => e.sequence), [4]);
        assert.deepEqual(outbox.entries[0], entry);
      });
    });

    it('3 uncertain fake executor failure preserves real claimed state; no complete/release', async () => {
      const api = requireApi();
      await withTempRoot('uncertain-hold', async (root) => {
        await seedQueuedHead(root, { sequence: 1, nextSequence: 2 });
        const outboxBefore = await readFile(outboxAbs(root), 'utf8');

        let completeHits = 0;
        let releaseHits = 0;
        const deliver = createRealClaimFakeTransport(
          api,
          async () => {
            throw new Error(`socket reset ${SECRET_HOST} ${SECRET_PATH}`);
          },
          {
            completeDelivery: async (...args) => {
              completeHits += 1;
              return completeAuditIntegrityAlertDelivery(...args);
            },
            releaseDelivery: async (...args) => {
              releaseHits += 1;
              return releaseAuditIntegrityAlertDelivery(...args);
            },
          },
        );

        await expectUnavailableAsync(
          deliver(root, CANONICAL_ENDPOINT, FIXED_NOW),
          [root, SECRET_HOST, SECRET_PATH],
        );
        assert.equal(completeHits, 0);
        assert.equal(releaseHits, 0);

        const claim = await loadClaim(root);
        assert.equal(claim.status, 'claimed');
        assert.equal(claim.streamId, FIXED_STREAM_ID);
        assert.equal(claim.sequence, 1);
        assert.match(claim.claimId, /^[0-9a-f-]{36}$/);
        assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);

        // Live owner + same now → busy (claim preserved for owner/TTL recovery).
        const busy = await claimAuditIntegrityAlertDelivery(
          root,
          CANONICAL_ENDPOINT,
          FIXED_NOW,
        );
        assert.equal(busy.status, 'busy');
        assert.equal(busy.streamId, FIXED_STREAM_ID);
        assert.equal(busy.sequence, 1);
        assert.equal(busy.claimId, null);
        assert.equal(busy.request, null);
      });
    });

    it('4 two concurrent one-shot calls: only one executor; other returns busy', async () => {
      const api = requireApi();
      await withTempRoot('concurrent-busy', async (root) => {
        await seedQueuedHead(root, { sequence: 1, nextSequence: 2 });

        /** @type {((value?: unknown) => void) | null} */
        let releaseBarrier = null;
        const barrier = new Promise((resolve) => {
          releaseBarrier = resolve;
        });
        let executeCount = 0;
        /** @type {unknown[]} */
        const executeRequests = [];

        const deliver = createRealClaimFakeTransport(api, async (request) => {
          executeCount += 1;
          executeRequests.push(request);
          await barrier;
          return acceptedResult();
        });

        const firstPromise = deliver(root, CANONICAL_ENDPOINT, FIXED_NOW);

        // Wait until the first call holds the claim and has entered execute.
        const start = Date.now();
        while (executeCount < 1 && Date.now() - start < 5_000) {
          await delay(5);
        }
        assert.equal(executeCount, 1, 'first call must reach executor');

        const second = await deliver(root, CANONICAL_ENDPOINT, FIXED_NOW);
        assertBusyReceipt(second, {
          streamId: FIXED_STREAM_ID,
          sequence: 1,
          expiresAt: '2026-08-04T12:02:00.000Z',
        });
        assert.equal(executeCount, 1, 'second call must not execute');

        assert.equal(typeof releaseBarrier, 'function');
        /** @type {(value?: unknown) => void} */ (releaseBarrier)();
        const first = await firstPromise;
        assertDeliveredReceipt(first, {
          streamId: FIXED_STREAM_ID,
          sequence: 1,
          pendingCount: 0,
          completionStatus: 'completed',
        });
        assert.equal(executeCount, 1);
        assert.equal(executeRequests.length, 1);
      });
    });

    it('5 accepted then injected complete failure before ack never releases; claim/head recoverable', async () => {
      const api = requireApi();
      await withTempRoot('complete-before-ack', async (root) => {
        const entry = headEntry(8);
        await seedQueuedHead(root, {
          sequence: 8,
          nextSequence: 9,
          entries: [entry],
        });
        const outboxBefore = await readFile(outboxAbs(root), 'utf8');

        let releaseHits = 0;
        let completeHits = 0;
        const deliver = createRealClaimFakeTransport(
          api,
          async () => acceptedResult(),
          {
            completeDelivery: async () => {
              completeHits += 1;
              throw new Error(`injected complete before ack ${SECRET_PATH}`);
            },
            releaseDelivery: async (...args) => {
              releaseHits += 1;
              return releaseAuditIntegrityAlertDelivery(...args);
            },
          },
        );

        await expectUnavailableAsync(
          deliver(root, CANONICAL_ENDPOINT, FIXED_NOW),
          [root, SECRET_PATH, 'injected complete'],
        );
        assert.equal(completeHits, 1);
        assert.equal(releaseHits, 0);

        const claim = await loadClaim(root);
        assert.equal(claim.status, 'claimed');
        assert.equal(claim.sequence, 8);
        assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);

        // Recoverable via real complete with exact capability from durable claim.
        const recovered = await completeAuditIntegrityAlertDelivery(root, {
          claimId: claim.claimId,
          streamId: claim.streamId,
          sequence: claim.sequence,
        });
        assertExactKeys(recovered, COMPLETE_RECEIPT_KEYS, 'recover complete');
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

    it('6 FileHandle idle fault after real outbox ack; subsequent complete already-completed; successor preserved', async () => {
      const api = requireApi();
      await withTempRoot('post-ack-idle-fault', async (root) => {
        const eA = headEntry(20);
        const eB = headEntry(21);
        await seedQueuedHead(root, {
          sequence: 20,
          nextSequence: 22,
          entries: [eA, eB],
        });

        const deliver = createRealClaimFakeTransport(api, async () => acceptedResult());

        const captured = await captureFileHandleWritePath();
        const { proto, originalWriteFile, originalWrite } = captured;
        const faultError = new Error('test-only idle claim write fault');
        /** @type {NodeJS.ErrnoException} */ (faultError).code = 'TEST_IDLE_CLAIM_WRITE_FAULT';
        let idleFaultHits = 0;

        proto.writeFile = async function patchedWriteFile(data, options) {
          const text = payloadTextOrNull(data);
          if (text === CANONICAL_IDLE_CLAIM_BYTES) {
            idleFaultHits += 1;
            throw faultError;
          }
          return originalWriteFile.apply(this, arguments);
        };
        proto.write = function patchedWrite(data, ...rest) {
          const text = payloadTextOrNull(data);
          if (text === CANONICAL_IDLE_CLAIM_BYTES) {
            idleFaultHits += 1;
            throw faultError;
          }
          return originalWrite.apply(this, [data, ...rest]);
        };

        /** @type {string | null} */
        let residualClaimId = null;
        try {
          await expectUnavailableAsync(
            deliver(root, CANONICAL_ENDPOINT, FIXED_NOW),
            [root, 'TEST_IDLE_CLAIM_WRITE_FAULT', 'test-only idle claim write fault'],
          );
          assert.ok(idleFaultHits >= 1, 'idle claim write path must have been faulted');

          const outboxAfterFault = await readAuditIntegrityAlertOutbox(root);
          assert.deepEqual(outboxAfterFault.entries.map((e) => e.sequence), [21]);
          assert.equal(outboxAfterFault.nextSequence, 22);
          assert.deepEqual(outboxAfterFault.entries[0], eB);
          assert.equal(await readFile(outboxAbs(root), 'utf8'), canonicalOutbox(22, [eB]));

          const claimAfterFault = await loadClaim(root);
          assert.equal(claimAfterFault.status, 'claimed');
          assert.equal(claimAfterFault.streamId, FIXED_STREAM_ID);
          assert.equal(claimAfterFault.sequence, 20);
          residualClaimId = claimAfterFault.claimId;
          assert.equal(typeof residualClaimId, 'string');
          assert.equal(await readFile(streamAbs(root), 'utf8'), canonicalStream(FIXED_STREAM_ID));
        } finally {
          proto.writeFile = originalWriteFile;
          proto.write = originalWrite;
        }

        // Subsequent real completion recovers residual: already-completed; B preserved.
        const second = await completeAuditIntegrityAlertDelivery(root, {
          claimId: residualClaimId,
          streamId: FIXED_STREAM_ID,
          sequence: 20,
        });
        assertExactKeys(second, COMPLETE_RECEIPT_KEYS, 'already-completed');
        assert.equal(second.status, 'already-completed');
        assert.equal(second.completed, true);
        assert.equal(second.streamId, FIXED_STREAM_ID);
        assert.equal(second.sequence, 20);
        assert.equal(second.pendingCount, 1);
        assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
        const outboxFinal = await readAuditIntegrityAlertOutbox(root);
        assert.deepEqual(outboxFinal.entries.map((e) => e.sequence), [21]);
        assert.equal(outboxFinal.nextSequence, 22);
        assert.equal(await readFile(outboxAbs(root), 'utf8'), canonicalOutbox(22, [eB]));
      });
    });
  });

  // ── 4. Security and production binding ─────────────────────────────────

  describe('4 security and production binding', () => {
    it('public errors omit dataDir/endpoint/claimId/idempotency/body/header/response/hostname/errno/token/paths', async () => {
      const api = requireApi();
      const leak = [
        CANONICAL_ENDPOINT,
        'alerts.example.invalid',
        CLAIM_ID_A,
        IDEMPOTENCY_KEY,
        SECRET_TOKEN,
        SECRET_PATH,
        SECRET_HOST,
        '/safe/secret-data-dir',
        'authorization',
        'content-type',
        'ECONNRESET',
        'errno',
      ];

      const cases = [
        async () => {
          const harness = createInjectedHarness({
            claim: claimFixture('claimed'),
            execute: new Error(`fail host=${SECRET_HOST} token=${SECRET_TOKEN} path=${SECRET_PATH}`),
          });
          await expectUnavailableAsync(
            deliverWith(api, harness)('/safe/secret-data-dir', CANONICAL_ENDPOINT, FIXED_NOW),
            leak,
          );
        },
        async () => {
          const harness = createInjectedHarness({
            claim: claimFixture('claimed'),
            execute: rejectedResult(),
            release: new Error(`release ${IDEMPOTENCY_KEY} ${CLAIM_ID_A}`),
          });
          await expectUnavailableAsync(
            deliverWith(api, harness)('/safe/secret-data-dir', CANONICAL_ENDPOINT, FIXED_NOW),
            leak,
          );
        },
        async () => {
          const harness = createInjectedHarness({
            claim: claimFixture('claimed'),
            execute: acceptedResult(),
            complete: new Error(`complete ${CANONICAL_ENDPOINT}`),
          });
          await expectUnavailableAsync(
            deliverWith(api, harness)('/safe/secret-data-dir', CANONICAL_ENDPOINT, FIXED_NOW),
            leak,
          );
        },
      ];

      for (const run of cases) {
        await run();
      }
    });

    it('default production export binds real claim/execute/complete/release; factory cannot mutate binding', async () => {
      const api = requireApi();

      // Factory returns a distinct deliver function from the production export.
      const harness = createInjectedHarness({ claim: claimFixture('empty') });
      const injected = api.createAuditIntegrityAlertDeliveryOnceForTesting(harness.deps);
      assert.equal(typeof injected, 'function');
      assert.notEqual(injected, api.deliverAuditIntegrityAlertOnce);

      // Snapshot production reference; mutating factory deps must not replace it.
      const productionBefore = api.deliverAuditIntegrityAlertOnce;
      const mutatedClaim = async () => {
        assert.fail('mutated factory claim must not become production binding');
      };
      harness.deps.claimDelivery = mutatedClaim;
      harness.deps.executeRequest = async () => {
        assert.fail('mutated factory execute must not become production binding');
      };
      assert.equal(api.deliverAuditIntegrityAlertOnce, productionBefore);
      assert.equal(
        api.deliverAuditIntegrityAlertOnce,
        onceApi && onceApi.deliverAuditIntegrityAlertOnce,
      );

      // Injected function still uses original bound claim (empty) if deps were snapshotted;
      // if deps are live-bound, empty path may now hit mutatedClaim — either way production is intact.
      // Production export identity and real import surfaces remain bound (source + typeof).
      assert.equal(typeof claimAuditIntegrityAlertDelivery, 'function');
      assert.equal(typeof completeAuditIntegrityAlertDelivery, 'function');
      assert.equal(typeof releaseAuditIntegrityAlertDelivery, 'function');
      assert.equal(typeof executeAuditIntegrityAlertHttpsRequest, 'function');

      const source = await readFile(PRODUCTION_MODULE_PATH, 'utf8');
      for (const required of [
        'claimAuditIntegrityAlertDelivery',
        'completeAuditIntegrityAlertDelivery',
        'releaseAuditIntegrityAlertDelivery',
        'executeAuditIntegrityAlertHttpsRequest',
        'deliverAuditIntegrityAlertOnce',
        'createAuditIntegrityAlertDeliveryOnceForTesting',
      ]) {
        assert.equal(source.includes(required), true, `expected production surface: ${required}`);
      }
    });
  });

  // ── 5. Structural source scan (module exists) ──────────────────────────

  describe('5 structural source scan', () => {
    it('allows only error-codes, claim, https-transport (+ node:util); forbids forbidden surfaces', async () => {
      const source = await readFile(PRODUCTION_MODULE_PATH, 'utf8');

      const importRe = /\bfrom\s+['"]([^'"]+)['"]/g;
      /** @type {string[]} */
      const imports = [];
      for (const match of source.matchAll(importRe)) {
        imports.push(match[1]);
      }

      const allowed = new Set([
        './error-codes.js',
        './audit-integrity-alert-delivery-claim.js',
        './audit-integrity-alert-https-transport.js',
        'node:util',
      ]);
      for (const imp of imports) {
        assert.equal(allowed.has(imp), true, `unexpected import: ${imp}`);
      }
      for (const required of [
        './error-codes.js',
        './audit-integrity-alert-delivery-claim.js',
        './audit-integrity-alert-https-transport.js',
      ]) {
        assert.equal(imports.includes(required), true, `missing required import: ${required}`);
      }

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
        'new Agent',
        "from './agent.js'",
        "from './server.js'",
        "from './web/",
        "from '../web/",
        'audit-integrity-alert-outbox',
        'audit-integrity-alert-delivery-stream',
        'audit-integrity-alert-delivery-claim-state',
        'audit-integrity-write-queue',
        'audit-integrity-process-lock',
        'prepareAuditIntegrityAlertDelivery',
        'buildAuditIntegrityAlertDeliveryRequest',
        'runAuditIntegrityMonitor',
        'readFileSync',
        'writeFileSync',
        'keychain',
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `production source must not include ${forbidden}`,
        );
      }
    });
  });
});
