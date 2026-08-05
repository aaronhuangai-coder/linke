/**
 * Task 7 RED — authorized integration / concurrency / privacy / open in-flight recovery.
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-durable-retry-plan.md (Task 7)
 *
 * Production (Task-6 HEAD may lack Task-7 wiring asserted here):
 *   src/audit-integrity-alert-delivery-retry.js
 *   src/audit-integrity-alert-outbox.js (manual-ack gate covered in outbox test)
 *
 * Real modules + temp data roots. Closed dependency injection only for the
 * detailed HTTPS executor (no real DNS/TLS/socket). Assert public behavior only;
 * never assert mock identity. No scheduler, Agent/API/Web, requeue/drop, or Gold.
 *
 * Captured production defects (test names name the gap):
 *   - deny policy still advances claim/lifecycle/detailed request
 *   - allow policy does not pass bit-identical authorized endpoint into claim
 *   - overlapping ticks can double-fire executeRequestDetailed
 *   - receipts/lifecycle/DLQ leak endpoint/headers/IP/body material
 *   - open in-flight crash conversion double-counts attemptCount
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createAuditIntegrityAlertDestinationPolicy } from '../src/audit-integrity-alert-destination-policy.js';
import {
  claimAuditIntegrityAlertDelivery,
  completeAuditIntegrityAlertDelivery,
  releaseAuditIntegrityAlertDelivery,
} from '../src/audit-integrity-alert-delivery-claim.js';
import {
  AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH,
  loadAuditIntegrityAlertDeliveryClaimState,
} from '../src/audit-integrity-alert-delivery-claim-state.js';
import {
  AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH,
  loadAuditIntegrityAlertDeliveryLifecycle,
  publishAuditIntegrityAlertDeliveryLifecycleUnderLease,
} from '../src/audit-integrity-alert-delivery-lifecycle.js';
import { AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH } from '../src/audit-integrity-alert-delivery-stream.js';
import {
  AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH,
  appendAuditIntegrityAlertDeadLetterUnderLease,
  readAuditIntegrityAlertDeadLetter,
} from '../src/audit-integrity-alert-dead-letter.js';
import {
  AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
  readAuditIntegrityAlertOutbox,
} from '../src/audit-integrity-alert-outbox.js';
import {
  computeAuditIntegrityAlertRetryDueAt,
  computeAuditIntegrityAlertUncertainDueAt,
  classifyAuditIntegrityAlertRetryDecision,
} from '../src/audit-integrity-alert-retry-policy.js';
import { enqueueAuditIntegrityWriteTask } from '../src/audit-integrity-write-queue.js';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { assertSafeDataRoot } from '../src/safe-data-files.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-retry.js',
  import.meta.url,
);

const MISSING_MSG = 'durable retry tick implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

/** Exact §5.5 ordered deps keys for createAuditIntegrityAlertDeliveryRetryForTesting. */
const DEPS_KEYS = Object.freeze([
  'authorizeDestination',
  'claimDelivery',
  'completeDelivery',
  'releaseDelivery',
  'loadLifecycle',
  'publishLifecycle',
  'readOutbox',
  'loadClaimState',
  'readDeadLetter',
  'appendDeadLetter',
  'executeRequestDetailed',
  'computeRetryDue',
  'computeUncertainDue',
  'classifyRetryDecision',
]);

const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'streamId',
  'sequence',
  'attemptCount',
  'nextAttemptAt',
  'pendingCount',
  'detail',
]);

/** Policy-valid host (not reserved .example / .invalid suffixes). */
const ENDPOINT = 'https://alerts.acme.com/hooks/audit-integrity';
const ENDPOINT_HOST = 'alerts.acme.com';
const ENDPOINT_PATH = '/hooks/audit-integrity';
const FIXED_NOW = '2026-08-05T12:00:00.000Z';
const FIXED_CHECKED_AT = '2026-08-05T12:00:00.000Z';
const FIXED_STREAM_ID = 'b2222222-c222-4222-9222-f22222222222';
const FIXED_CLAIM_ID = 'a1111111-b111-4111-8111-e11111111111';
const FIXED_ATTEMPT_ID = 'c3333333-d333-4333-a333-033333333333';
const CLAIM_EXPIRES_AT = '2026-08-05T12:02:00.000Z';
/** Hand-checked: attemptCount=1 lastAttemptAt=FIXED_NOW → backoff 12:00:30; max with claim exp. */
const UNCERTAIN_DUE_ATTEMPT_1 = CLAIM_EXPIRES_AT;
const DUE_NOW = UNCERTAIN_DUE_ATTEMPT_1;

const PUBLIC_V4 = '8.8.8.8';
const PUBLIC_V6 = '2606:4700:4700::1111';
const PRIVATE_V4 = '10.0.0.1';
const LOOPBACK_V4 = '127.0.0.1';
const SECRET_AUTH = 'Bearer task7-secret-auth-token-xyz';
const SECRET_BODY = '{"task7-response-body-secret":true}';
const SECRET_HEADER_LINE = 'authorization: Bearer task7-secret-auth-token-xyz';

/** @type {null | {
 *   tickAuditIntegrityAlertDelivery: Function,
 *   createAuditIntegrityAlertDeliveryRetryForTesting: Function,
 * }} */
let retryApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.tickAuditIntegrityAlertDelivery === 'function'
    && typeof mod.createAuditIntegrityAlertDeliveryRetryForTesting === 'function'
  ) {
    retryApi = {
      tickAuditIntegrityAlertDelivery: mod.tickAuditIntegrityAlertDelivery,
      createAuditIntegrityAlertDeliveryRetryForTesting:
        mod.createAuditIntegrityAlertDeliveryRetryForTesting,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    retryApi = null;
  } else {
    throw error;
  }
}

function requireApi() {
  if (implementationMissing || retryApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {NonNullable<typeof retryApi>} */ (retryApi);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
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
 * @param {unknown} error
 */
function assertUnavailable(error) {
  return error instanceof LinkeError
    && error.name === 'LinkeError'
    && error.code === CODE_UNAVAILABLE
    && error.message === CODE_UNAVAILABLE
    && error.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE;
}

/**
 * @param {string} prefix
 * @param {(root: string) => Promise<unknown>} fn
 */
async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-retry-int-${prefix}-`));
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
function outboxAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH);
}
/** @param {string} root */
function claimAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH);
}
/** @param {string} root */
function lifecycleAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH);
}
/** @param {string} root */
function streamAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH);
}
/** @param {string} root */
function deadLetterAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH);
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
 * @param {string} root
 * @param {number} nextSequence
 * @param {object[]} entries
 */
async function writeOutbox(root, nextSequence, entries) {
  const abs = outboxAbs(root);
  await mkdir(dirname(abs), { recursive: true });
  const raw = `${JSON.stringify({ schemaVersion: 1, nextSequence, entries })}\n`;
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
  const raw = `${JSON.stringify({ schemaVersion: 1, streamId })}\n`;
  await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
  return raw;
}

/**
 * Seed non-empty outbox head + stable stream under a temp root.
 * @param {string} root
 * @param {{ sequence?: number, streamId?: string }} [opts]
 */
async function seedQueuedHead(root, {
  sequence = 1,
  streamId = FIXED_STREAM_ID,
} = {}) {
  await writeOutbox(root, sequence + 1, [headEntry(sequence)]);
  await writeStream(root, streamId);
  return { sequence, streamId };
}

/**
 * Open in-flight lifecycle row (outcome null, nextAttemptAt null, claim V).
 * @param {object} [fields]
 */
function buildOpenInFlight(fields = {}) {
  const streamId = fields.streamId ?? FIXED_STREAM_ID;
  const sequence = fields.sequence ?? 1;
  const attemptCount = fields.attemptCount ?? 1;
  return {
    schemaVersion: 1,
    status: 'in-flight',
    lastObservedAt: fields.lastObservedAt ?? FIXED_NOW,
    streamId,
    sequence,
    idempotencyKey: fields.idempotencyKey
      ?? `audit-integrity-alert:${streamId}:${sequence}`,
    attemptId: fields.attemptId ?? FIXED_ATTEMPT_ID,
    attemptCount,
    firstAttemptAt: fields.firstAttemptAt ?? FIXED_NOW,
    lastAttemptAt: fields.lastAttemptAt ?? FIXED_NOW,
    nextAttemptAt: null,
    claimId: fields.claimId ?? FIXED_CLAIM_ID,
    claimExpiresAt: fields.claimExpiresAt ?? CLAIM_EXPIRES_AT,
    outcome: null,
    deadLetter: null,
  };
}

/**
 * @param {string} root
 * @param {object} state
 */
async function publishLifecycle(root, state) {
  return withLease(root, async (resolvedRoot, lease) => {
    return publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
      resolvedRoot,
      lease,
      state,
    );
  });
}

/**
 * Real production adapters + injected authorize + detailed executor only.
 * @param {{
 *   authorizeDestination: (endpoint: unknown) => string,
 *   executeRequestDetailed: (request: unknown) => Promise<object> | object,
 *   claimDelivery?: Function,
 * }} options
 */
function buildRealDeps(options) {
  const claimDelivery = typeof options.claimDelivery === 'function'
    ? options.claimDelivery
    : claimAuditIntegrityAlertDelivery;

  const deps = {
    authorizeDestination: options.authorizeDestination,
    claimDelivery,
    completeDelivery: completeAuditIntegrityAlertDelivery,
    releaseDelivery: releaseAuditIntegrityAlertDelivery,
    loadLifecycle: loadAuditIntegrityAlertDeliveryLifecycle,
    async publishLifecycle(dataDir, state) {
      const resolvedRoot = await assertSafeDataRoot(dataDir);
      return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) =>
        publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          dataDir,
          lease,
          state,
        ),
      );
    },
    readOutbox: readAuditIntegrityAlertOutbox,
    async loadClaimState(dataDir) {
      const resolvedRoot = await assertSafeDataRoot(dataDir);
      return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) =>
        loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease),
      );
    },
    readDeadLetter: readAuditIntegrityAlertDeadLetter,
    async appendDeadLetter(dataDir, entry) {
      const resolvedRoot = await assertSafeDataRoot(dataDir);
      return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) =>
        appendAuditIntegrityAlertDeadLetterUnderLease(dataDir, lease, entry),
      );
    },
    executeRequestDetailed: options.executeRequestDetailed,
    computeRetryDue: computeAuditIntegrityAlertRetryDueAt,
    computeUncertainDue: computeAuditIntegrityAlertUncertainDueAt,
    classifyRetryDecision: classifyAuditIntegrityAlertRetryDecision,
  };
  assertExactKeys(deps, DEPS_KEYS, 'integration real deps');
  return deps;
}

/**
 * Privacy ceiling tokens that must never appear on durable files / receipts / errors.
 * @param {string[]} [extra]
 */
function privacyLeakTokens(extra = []) {
  return [
    ENDPOINT,
    ENDPOINT_HOST,
    ENDPOINT_PATH,
    SECRET_AUTH,
    SECRET_BODY,
    SECRET_HEADER_LINE,
    PUBLIC_V4,
    PUBLIC_V6,
    PRIVATE_V4,
    LOOPBACK_V4,
    'Authorization',
    'authorization',
    ...extra,
  ];
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {string[]} [extra]
 */
function assertNoPrivacyLeaks(value, label, extra = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const token of privacyLeakTokens(extra)) {
    if (!token || token.length < 2) continue;
    assert.equal(
      text.includes(token),
      false,
      `${label} must not contain privacy token ${token}`,
    );
  }
}

/**
 * @param {string} root
 * @param {string} label
 * @param {string[]} [extra]
 */
async function assertDurablePrivacy(root, label, extra = []) {
  const paths = [
    outboxAbs(root),
    claimAbs(root),
    lifecycleAbs(root),
    streamAbs(root),
    deadLetterAbs(root),
  ];
  for (const path of paths) {
    const raw = await readOptional(path);
    if (raw === null) continue;
    assertNoPrivacyLeaks(raw, `${label}:${path}`, extra);
  }
}

/**
 * @param {unknown} receipt
 */
function assertReceiptShape(receipt) {
  assert.equal(typeof receipt, 'object');
  assert.notEqual(receipt, null);
  assertExactKeys(receipt, RECEIPT_KEYS, 'public receipt');
  assert.equal(/** @type {{ schemaVersion: number }} */ (receipt).schemaVersion, 1);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'claimId'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'attemptId'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'endpoint'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'headers'), false);
  assert.equal(Object.hasOwn(/** @type {object} */ (receipt), 'body'), false);
  assertNoPrivacyLeaks(receipt, 'receipt');
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('audit integrity alert delivery retry integration (Task 7 RED)', () => {
  if (implementationMissing || retryApi === null) {
    it('durable retry tick implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── Step 1: authorize-before-claim ────────────────────────────────────

  describe('1 authorize-before-claim (deny zero side effects / allow bit-identical claim path)', () => {
    it(
      'deny policy yields fixed unavailable with zero claim, zero lifecycle attempt, '
        + 'zero detailed request (Task 7 authorize-before-claim gap)',
      async () => {
        // Break: claim/lifecycle/network before authorize, or deny treated as empty success.
        const api = requireApi();
        const denyPolicy = createAuditIntegrityAlertDestinationPolicy(null);
        assert.equal(denyPolicy.status, 'deny-all');

        let detailedCount = 0;
        const tickInjected = api.createAuditIntegrityAlertDeliveryRetryForTesting(
          buildRealDeps({
            authorizeDestination: (endpoint) => denyPolicy.authorize(endpoint),
            executeRequestDetailed: async () => {
              detailedCount += 1;
              return { schemaVersion: 1, kind: 'accepted' };
            },
          }),
        );

        await withTempRoot('t7-auth-deny', async (root) => {
          await seedQueuedHead(root);

          await assert.rejects(
            () => tickInjected(root, ENDPOINT, FIXED_NOW),
            assertUnavailable,
          );
          await assert.rejects(
            () => api.tickAuditIntegrityAlertDelivery(
              root,
              ENDPOINT,
              FIXED_NOW,
              denyPolicy,
            ),
            assertUnavailable,
          );

          assert.equal(detailedCount, 0, 'deny must never reach detailed executor');

          const lifecycle = await loadAuditIntegrityAlertDeliveryLifecycle(root);
          assert.equal(lifecycle.status, 'idle');
          assert.equal(lifecycle.attemptCount, 0);

          const claim = await withLease(root, async (resolvedRoot, lease) =>
            loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease),
          );
          assert.equal(claim.status, 'idle');

          const outbox = await readAuditIntegrityAlertOutbox(root);
          assert.equal(outbox.entries.length, 1);
          assert.equal(outbox.entries[0].sequence, 1);

          await assertDurablePrivacy(root, 'deny-policy');
        });
      },
    );

    it(
      'allow policy passes bit-identical authorized endpoint into real claim/tick path '
        + '(Task 7 authorize-before-claim identity gap)',
      async () => {
        // Break: authorize rewrite, claim with different string, or skip authorize.
        const api = requireApi();
        const allowPolicy = createAuditIntegrityAlertDestinationPolicy({
          schemaVersion: 1,
          endpoints: [ENDPOINT],
        });
        assert.equal(allowPolicy.status, 'configured');

        /** @type {unknown[][]} */
        const authorizeArgs = [];
        /** @type {unknown[][]} */
        const claimArgs = [];
        /** @type {unknown[]} */
        const detailedRequests = [];

        const tick = api.createAuditIntegrityAlertDeliveryRetryForTesting(
          buildRealDeps({
            authorizeDestination: (endpoint) => {
              authorizeArgs.push([endpoint]);
              const authorized = allowPolicy.authorize(endpoint);
              assert.equal(authorized, endpoint);
              assert.equal(authorized, ENDPOINT);
              return authorized;
            },
            claimDelivery: async (dataDir, endpoint, now) => {
              claimArgs.push([dataDir, endpoint, now]);
              return claimAuditIntegrityAlertDelivery(dataDir, endpoint, now);
            },
            executeRequestDetailed: async (request) => {
              detailedRequests.push(request);
              return { schemaVersion: 1, kind: 'accepted' };
            },
          }),
        );

        await withTempRoot('t7-auth-allow', async (root) => {
          await seedQueuedHead(root);

          const receipt = await tick(root, ENDPOINT, FIXED_NOW);
          assertReceiptShape(receipt);
          assert.equal(
            /** @type {{ status: string }} */ (receipt).status,
            'delivered',
          );

          assert.equal(authorizeArgs.length, 1);
          assert.equal(authorizeArgs[0][0], ENDPOINT);
          assert.equal(claimArgs.length, 1);
          assert.equal(
            claimArgs[0][1],
            ENDPOINT,
            'claim must receive bit-identical authorized endpoint primitive',
          );
          assert.equal(claimArgs[0][2], FIXED_NOW);
          assert.equal(detailedRequests.length, 1);

          const lifecycle = await loadAuditIntegrityAlertDeliveryLifecycle(root);
          assert.equal(lifecycle.status, 'idle');
          assert.equal(typeof lifecycle.lastObservedAt, 'string');

          await assertDurablePrivacy(root, 'allow-policy');
        });
      },
    );
  });

  // ── Step 2: concurrency ───────────────────────────────────────────────

  describe('2 overlapping ticks single detailed request (concurrency)', () => {
    it(
      'two overlapping ticks on one temp root with barrier detailed transport: '
        + 'exactly one executeRequestDetailed and peer not-due (Task 7 single-flight)',
      async () => {
        // Break: concurrent ticks double-settle the same head / double network.
        // Design §12.7/§15: after open in-flight is durable, peer may be
        // busy | not-due | blocked. Controlled now is earlier than effective
        // due, so peer recovers open in-flight → retry-wait and returns not-due
        // with zero network (not a hard "must busy" claim).
        const api = requireApi();
        const allowPolicy = createAuditIntegrityAlertDestinationPolicy({
          schemaVersion: 1,
          endpoints: [ENDPOINT],
        });

        let detailedCount = 0;
        /** @type {(() => void) | null} */
        let releaseBarrier = null;
        const barrier = new Promise((resolve) => {
          releaseBarrier = resolve;
        });
        /** @type {(() => void) | null} */
        let signalEntered = null;
        const entered = new Promise((resolve) => {
          signalEntered = resolve;
        });

        const tick = api.createAuditIntegrityAlertDeliveryRetryForTesting(
          buildRealDeps({
            authorizeDestination: (endpoint) => allowPolicy.authorize(endpoint),
            executeRequestDetailed: async () => {
              detailedCount += 1;
              if (detailedCount === 1) {
                /** @type {() => void} */ (signalEntered)();
                await barrier;
              }
              return { schemaVersion: 1, kind: 'accepted' };
            },
          }),
        );

        await withTempRoot('t7-concurrency', async (root) => {
          await seedQueuedHead(root);

          const firstPromise = tick(root, ENDPOINT, FIXED_NOW);
          await entered;
          assert.equal(detailedCount, 1, 'first tick must hold the single detailed slot');

          const secondReceipt = await tick(root, ENDPOINT, FIXED_NOW);
          assertReceiptShape(secondReceipt);
          assert.equal(
            /** @type {{ status: string }} */ (secondReceipt).status,
            'not-due',
            'peer tick must observe not-due without a second request',
          );
          assert.equal(
            detailedCount,
            1,
            'not-due peer must not invoke executeRequestDetailed a second time',
          );

          // Peer open in-flight recovery: retry-wait, unknown outcome, attempt unchanged.
          const peerLifecycle = await loadAuditIntegrityAlertDeliveryLifecycle(root);
          assert.equal(peerLifecycle.status, 'retry-wait');
          assert.equal(peerLifecycle.attemptCount, 1);
          assert.deepEqual(peerLifecycle.outcome, { kind: 'unknown', detail: null });

          /** @type {() => void} */ (releaseBarrier)();
          const firstReceipt = await firstPromise;
          assertReceiptShape(firstReceipt);
          assert.equal(
            /** @type {{ status: string }} */ (firstReceipt).status,
            'delivered',
          );
          assert.equal(
            detailedCount,
            1,
            'after barrier release still exactly one detailed request',
          );

          const outbox = await readAuditIntegrityAlertOutbox(root);
          assert.equal(outbox.entries.length, 0);
          await assertDurablePrivacy(root, 'concurrency');
        });
      },
    );
  });

  // ── Step 4: privacy ───────────────────────────────────────────────────

  describe('4 privacy ceiling on lifecycle / DLQ / receipts / errors', () => {
    it(
      'lifecycle, DLQ, receipts, and errors never contain fixture endpoint, raw headers, '
        + 'Authorization, IP literals, or response body (Task 7 privacy ceiling gap)',
      async () => {
        // Break: durable WAL or public error surface retains destination/wire material.
        const api = requireApi();
        const allowPolicy = createAuditIntegrityAlertDestinationPolicy({
          schemaVersion: 1,
          endpoints: [ENDPOINT],
        });

        const tick = api.createAuditIntegrityAlertDeliveryRetryForTesting(
          buildRealDeps({
            authorizeDestination: (endpoint) => allowPolicy.authorize(endpoint),
            executeRequestDetailed: async () => ({
              schemaVersion: 1,
              kind: 'retryable-rejected',
            }),
          }),
        );

        await withTempRoot('t7-privacy', async (root) => {
          await seedQueuedHead(root);

          const receipt = await tick(root, ENDPOINT, FIXED_NOW);
          assertReceiptShape(receipt);
          assert.equal(
            /** @type {{ status: string }} */ (receipt).status,
            'retry-scheduled',
          );
          assertNoPrivacyLeaks(receipt, 'retry-scheduled receipt');

          const lifecycle = await loadAuditIntegrityAlertDeliveryLifecycle(root);
          assertNoPrivacyLeaks(lifecycle, 'lifecycle object');
          const lifecycleRaw = await readFile(lifecycleAbs(root), 'utf8');
          assertNoPrivacyLeaks(lifecycleRaw, 'lifecycle file');

          const dlq = await readAuditIntegrityAlertDeadLetter(root);
          assertNoPrivacyLeaks(dlq, 'dlq snapshot');

          // Deny path error surface must stay fixed and path-free.
          const denyPolicy = createAuditIntegrityAlertDestinationPolicy(null);
          try {
            await api.tickAuditIntegrityAlertDelivery(
              root,
              ENDPOINT,
              FIXED_NOW,
              denyPolicy,
            );
            assert.fail('deny policy must throw fixed unavailable');
          } catch (error) {
            assert.equal(assertUnavailable(error), true);
            assertNoPrivacyLeaks(
              {
                name: /** @type {Error} */ (error).name,
                code: /** @type {LinkeError} */ (error).code,
                message: /** @type {Error} */ (error).message,
                stack: /** @type {Error} */ (error).stack,
              },
              'deny error surface',
            );
          }

          // Canary tokens used only in this suite must not have been persisted.
          assertNoPrivacyLeaks(
            {
              receipt,
              lifecycle,
              dlq,
              lifecycleRaw,
            },
            'combined privacy surface',
            [SECRET_AUTH, SECRET_BODY, SECRET_HEADER_LINE],
          );

          await assertDurablePrivacy(root, 'privacy-suite');
        });
      },
    );

    it(
      'secret-rich transport failure from executeRequestDetailed is not persisted or echoed '
        + 'on lifecycle / DLQ / outbox / claim / stream / receipt / error surfaces '
        + '(Task 7 privacy ceiling gap: hostile transport material leak)',
      async () => {
        // Break: production rethrows or durable-persists raw Authorization / response
        // body / IP literals / endpoint fragments from a secret-rich transport Error.
        // Canaries must enter via the real executeRequestDetailed failure path only.
        const api = requireApi();
        const allowPolicy = createAuditIntegrityAlertDestinationPolicy({
          schemaVersion: 1,
          endpoints: [ENDPOINT],
        });

        const hostileTransportErrorMessage = [
          'hostile HTTPS transport failure',
          `Authorization: ${SECRET_AUTH}`,
          SECRET_HEADER_LINE,
          `response-body=${SECRET_BODY}`,
          `peer-public-v4=${PUBLIC_V4}`,
          `peer-public-v6=${PUBLIC_V6}`,
          `peer-private-v4=${PRIVATE_V4}`,
          `peer-loopback-v4=${LOOPBACK_V4}`,
          `endpoint=${ENDPOINT}`,
          `host=${ENDPOINT_HOST}`,
          `path=${ENDPOINT_PATH}`,
        ].join(' | ');

        let detailedInvocations = 0;
        /** @type {unknown} */
        let detailedRequestSeen = undefined;

        const tick = api.createAuditIntegrityAlertDeliveryRetryForTesting(
          buildRealDeps({
            authorizeDestination: (endpoint) => allowPolicy.authorize(endpoint),
            executeRequestDetailed: async (request) => {
              detailedInvocations += 1;
              detailedRequestSeen = request;
              throw new Error(hostileTransportErrorMessage);
            },
          }),
        );

        await withTempRoot('t7-privacy-hostile-transport', async (root) => {
          await seedQueuedHead(root);

          /** @type {unknown} */
          let receipt;
          /** @type {unknown} */
          let thrown = null;
          try {
            receipt = await tick(root, ENDPOINT, FIXED_NOW);
          } catch (error) {
            thrown = error;
          }

          // Production must consume the hostile throw via the uncertain path — never
          // rethrow the secret-rich Error as-is. Frozen contract: sanitized
          // retry-scheduled / uncertain-network receipt (not raw transport text).
          assert.equal(detailedInvocations, 1, 'detailed executor must run once');
          assert.notEqual(
            detailedRequestSeen,
            undefined,
            'detailed executor must receive claim.request before failing',
          );

          if (thrown !== null) {
            // Fail-closed unavailable is acceptable only if fixed and path-free;
            // raw hostile Error must never escape the public boundary.
            assert.equal(
              assertUnavailable(thrown),
              true,
              'transport failure must not rethrow hostile Error; only fixed unavailable allowed',
            );
            assertNoPrivacyLeaks(
              {
                name: /** @type {Error} */ (thrown).name,
                code: /** @type {LinkeError} */ (thrown).code,
                message: /** @type {Error} */ (thrown).message,
                stack: /** @type {Error} */ (thrown).stack,
              },
              'hostile-transport error surface',
            );
          } else {
            assertReceiptShape(receipt);
            assert.equal(
              /** @type {{ status: string }} */ (receipt).status,
              'retry-scheduled',
            );
            assert.equal(
              /** @type {{ detail: string | null }} */ (receipt).detail,
              'uncertain-network',
            );
            assert.equal(
              /** @type {{ attemptCount: number }} */ (receipt).attemptCount,
              1,
            );
            assertNoPrivacyLeaks(receipt, 'uncertain retry receipt after hostile throw');
          }

          const lifecycle = await loadAuditIntegrityAlertDeliveryLifecycle(root);
          assertNoPrivacyLeaks(lifecycle, 'lifecycle object after hostile throw');
          if (thrown === null) {
            assert.equal(
              /** @type {{ status: string }} */ (lifecycle).status,
              'retry-wait',
            );
            assert.deepEqual(
              /** @type {{ outcome: object }} */ (lifecycle).outcome,
              { kind: 'unknown', detail: 'uncertain-network' },
            );
          }

          const lifecycleRaw = await readFile(lifecycleAbs(root), 'utf8');
          assertNoPrivacyLeaks(lifecycleRaw, 'lifecycle file after hostile throw');

          const claimRaw = await readOptional(claimAbs(root));
          if (claimRaw !== null) {
            assertNoPrivacyLeaks(claimRaw, 'claim file after hostile throw');
          }
          const streamRaw = await readOptional(streamAbs(root));
          if (streamRaw !== null) {
            assertNoPrivacyLeaks(streamRaw, 'stream file after hostile throw');
          }
          const outboxRaw = await readOptional(outboxAbs(root));
          if (outboxRaw !== null) {
            assertNoPrivacyLeaks(outboxRaw, 'outbox file after hostile throw');
          }

          const dlq = await readAuditIntegrityAlertDeadLetter(root);
          assertNoPrivacyLeaks(dlq, 'dlq snapshot after hostile throw');

          assertNoPrivacyLeaks(
            {
              receipt: receipt ?? null,
              thrown: thrown === null
                ? null
                : {
                  name: /** @type {Error} */ (thrown).name,
                  code: /** @type {LinkeError} */ (thrown).code,
                  message: /** @type {Error} */ (thrown).message,
                },
              lifecycle,
              lifecycleRaw,
              claimRaw,
              streamRaw,
              outboxRaw,
              dlq,
            },
            'combined surface after secret-rich transport failure',
          );

          await assertDurablePrivacy(root, 'privacy-hostile-transport');
        });
      },
    );
  });

  // ── Step 5: open in-flight recovery attempt accounting ────────────────

  describe('5 open in-flight recovery does not double-count attempt', () => {
    it(
      'crash after open in-flight: conversion to retry-wait keeps attemptCount; '
        + 'only due re-entry increments once (Task 7 open in-flight attempt double-count)',
      async () => {
        // Break: conversion re-requests or increments attemptCount; due re-entry double-fires.
        const api = requireApi();
        const allowPolicy = createAuditIntegrityAlertDestinationPolicy({
          schemaVersion: 1,
          endpoints: [ENDPOINT],
        });

        let detailedCount = 0;
        /** @type {number[]} */
        const inflightAttemptCounts = [];

        const tick = api.createAuditIntegrityAlertDeliveryRetryForTesting(
          buildRealDeps({
            authorizeDestination: (endpoint) => allowPolicy.authorize(endpoint),
            executeRequestDetailed: async () => {
              detailedCount += 1;
              return { schemaVersion: 1, kind: 'accepted' };
            },
          }),
        );

        await withTempRoot('t7-inflight-recovery', async (root) => {
          await seedQueuedHead(root, { sequence: 1, streamId: FIXED_STREAM_ID });
          // Durable open in-flight after publish-before-request crash; claim file idle
          // (conversion does not touch claim). Lifecycle retains claim fields V.
          await publishLifecycle(root, buildOpenInFlight({
            attemptCount: 1,
            streamId: FIXED_STREAM_ID,
            sequence: 1,
            lastAttemptAt: FIXED_NOW,
            firstAttemptAt: FIXED_NOW,
            claimExpiresAt: CLAIM_EXPIRES_AT,
          }));

          // Conversion tick: now < effectiveDue → not-due; zero network; attempt unchanged.
          const convertReceipt = await tick(root, ENDPOINT, FIXED_NOW);
          assertReceiptShape(convertReceipt);
          assert.equal(
            /** @type {{ status: string }} */ (convertReceipt).status,
            'not-due',
          );
          assert.equal(
            /** @type {{ attemptCount: number }} */ (convertReceipt).attemptCount,
            1,
            'conversion receipt must not increment attemptCount',
          );
          assert.equal(
            detailedCount,
            0,
            'open in-flight conversion must not call executeRequestDetailed',
          );

          const afterConvert = await loadAuditIntegrityAlertDeliveryLifecycle(root);
          assert.equal(afterConvert.status, 'retry-wait');
          assert.equal(afterConvert.attemptCount, 1);
          assert.deepEqual(afterConvert.outcome, { kind: 'unknown', detail: null });
          assert.equal(afterConvert.nextAttemptAt, UNCERTAIN_DUE_ATTEMPT_1);
          assert.equal(afterConvert.claimId, FIXED_CLAIM_ID);
          assert.equal(afterConvert.claimExpiresAt, CLAIM_EXPIRES_AT);

          // Still not due: zero network, attempt still 1.
          const notDueAgain = await tick(root, ENDPOINT, FIXED_NOW);
          assert.equal(
            /** @type {{ status: string }} */ (notDueAgain).status,
            'not-due',
          );
          assert.equal(detailedCount, 0);
          const stillWait = await loadAuditIntegrityAlertDeliveryLifecycle(root);
          assert.equal(stillWait.attemptCount, 1);

          // Due: exactly one new open in-flight (attemptCount 2) and one detailed request.
          const wrapPublish = buildRealDeps({
            authorizeDestination: (endpoint) => allowPolicy.authorize(endpoint),
            executeRequestDetailed: async () => {
              detailedCount += 1;
              return { schemaVersion: 1, kind: 'accepted' };
            },
          });
          // Instrument publishLifecycle to observe new open in-flight attemptCount.
          const basePublish = wrapPublish.publishLifecycle;
          wrapPublish.publishLifecycle = async (dataDir, state) => {
            if (
              state
              && typeof state === 'object'
              && /** @type {{ status?: unknown }} */ (state).status === 'in-flight'
            ) {
              inflightAttemptCounts.push(
                /** @type {{ attemptCount: number }} */ (state).attemptCount,
              );
            }
            return basePublish(dataDir, state);
          };
          assertExactKeys(wrapPublish, DEPS_KEYS, 'due-path deps');
          const dueTick = api.createAuditIntegrityAlertDeliveryRetryForTesting(wrapPublish);

          const dueReceipt = await dueTick(root, ENDPOINT, DUE_NOW);
          assertReceiptShape(dueReceipt);
          assert.equal(
            /** @type {{ status: string }} */ (dueReceipt).status,
            'delivered',
          );
          assert.equal(
            /** @type {{ attemptCount: number }} */ (dueReceipt).attemptCount,
            2,
            'first due re-entry must be attemptCount 2 (prior 1 + one open in-flight)',
          );
          assert.equal(
            detailedCount,
            1,
            'only the due re-entry may perform exactly one detailed request',
          );
          assert.deepEqual(
            inflightAttemptCounts,
            [2],
            'exactly one new open in-flight publish with attemptCount 2',
          );

          await assertDurablePrivacy(root, 'inflight-recovery');
        });
      },
    );
  });
});
