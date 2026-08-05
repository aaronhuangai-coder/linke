/**
 * Task 2 RED — audit integrity alert delivery lifecycle WAL contract.
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md §6
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-durable-retry-plan.md Task 2
 *
 * Production (must remain absent on this RED HEAD):
 *   src/audit-integrity-alert-delivery-lifecycle.js
 *
 * Real temp fixtures + real enqueueAuditIntegrityWriteTask leases.
 * No mocks for core state / read / write / lease behavior.
 * Old-HEAD RED is behavior-specific: "lifecycle state implementation missing".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-lifecycle.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);
const PRODUCTION_MODULE_MARKER = 'audit-integrity-alert-delivery-lifecycle';

const MISSING_MSG = 'lifecycle state implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

const RELATIVE_PATH = 'audit/integrity-alert-delivery-lifecycle.json';
const EXPECTED_MAX_BYTES = 16_384;

const TOP_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'lastObservedAt',
  'streamId',
  'sequence',
  'idempotencyKey',
  'attemptId',
  'attemptCount',
  'firstAttemptAt',
  'lastAttemptAt',
  'nextAttemptAt',
  'claimId',
  'claimExpiresAt',
  'outcome',
  'deadLetter',
]);

const OUTCOME_KEYS = Object.freeze(['kind', 'detail']);
const DEAD_LETTER_KEYS = Object.freeze([
  'deadLetterId',
  'reason',
  'sourceAlert',
  'claim',
  'deadLetterPre',
  'deadLetterPost',
  'outboxPre',
  'outboxPost',
  'preparedAt',
]);
const SOURCE_ALERT_KEYS = Object.freeze([
  'sequence',
  'checkedAt',
  'code',
  'recoveryRequired',
  'nextAction',
  'reasonCode',
]);
const CLAIM_NESTED_KEYS = Object.freeze(['claimId', 'streamId', 'sequence']);
const FINGERPRINT_KEYS = Object.freeze([
  'sha256',
  'byteLength',
  'entryCount',
  'nextSequence',
]);

const STREAM_ID = 'b2222222-c222-4222-9222-f22222222222';
const CLAIM_ID = 'a1111111-b111-4111-8111-e11111111111';
const ATTEMPT_ID = 'c3333333-d333-4333-a333-033333333333';
const DEAD_LETTER_ID = 'd4444444-e444-4444-b444-144444444444';
const SEQUENCE = 7;
const IDEMPOTENCY_KEY = `audit-integrity-alert:${STREAM_ID}:${SEQUENCE}`;

const OBSERVED_AT = '2026-08-05T12:00:00.000Z';
const FIRST_ATTEMPT_AT = '2026-08-05T12:00:00.000Z';
const LAST_ATTEMPT_AT = '2026-08-05T12:00:30.000Z';
const NEXT_ATTEMPT_AT = '2026-08-05T12:02:30.000Z';
const CLAIM_EXPIRES_AT = '2026-08-05T12:02:00.000Z';
const PREPARED_AT = '2026-08-05T12:05:00.000Z';
const SOURCE_CHECKED_AT = '2026-08-05T11:59:00.000Z';
const WATERMARK_OLDER = '2026-08-05T11:00:00.000Z';
const WATERMARK_NEWER = '2026-08-05T13:00:00.000Z';

const SHA_EMPTY_DLQ =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_DLQ_POST =
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_OUTBOX_PRE =
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const SHA_OUTBOX_POST =
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const PRIVACY_CANARIES = Object.freeze({
  endpoint: 'https://alerts.evil.example:8443/hooks/audit',
  token: 'Bearer secret-token-xyz-999',
  headers: { Authorization: 'Bearer secret-token-xyz-999' },
  IP: '203.0.113.77',
  path: '/Users/ah/secret/lifecycle.json',
  statusCode: 503,
  rawError: 'Error: ECONNREFUSED 203.0.113.77:8443',
});

/**
 * @typedef {{
 *   AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH: string,
 *   AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES: number,
 *   loadAuditIntegrityAlertDeliveryLifecycle: Function,
 *   publishAuditIntegrityAlertDeliveryLifecycleUnderLease: Function,
 *   assertAuditIntegrityAlertDeliveryLifecycleIdle: Function,
 *   createIdleAuditIntegrityAlertDeliveryLifecycle: Function,
 * }} LifecycleApi
 */

/** @type {null | LifecycleApi} */
let lifecycleApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.loadAuditIntegrityAlertDeliveryLifecycle === 'function'
    && typeof mod.publishAuditIntegrityAlertDeliveryLifecycleUnderLease === 'function'
    && typeof mod.assertAuditIntegrityAlertDeliveryLifecycleIdle === 'function'
    && typeof mod.createIdleAuditIntegrityAlertDeliveryLifecycle === 'function'
    && typeof mod.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH === 'string'
    && typeof mod.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES === 'number'
  ) {
    lifecycleApi = {
      AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH:
        mod.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH,
      AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES:
        mod.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES,
      loadAuditIntegrityAlertDeliveryLifecycle:
        mod.loadAuditIntegrityAlertDeliveryLifecycle,
      publishAuditIntegrityAlertDeliveryLifecycleUnderLease:
        mod.publishAuditIntegrityAlertDeliveryLifecycleUnderLease,
      assertAuditIntegrityAlertDeliveryLifecycleIdle:
        mod.assertAuditIntegrityAlertDeliveryLifecycleIdle,
      createIdleAuditIntegrityAlertDeliveryLifecycle:
        mod.createIdleAuditIntegrityAlertDeliveryLifecycle,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  const message = String(
    error && typeof error === 'object' && 'message' in error
      ? /** @type {{ message?: unknown }} */ (error).message
      : error,
  );
  const url = String(
    error && typeof error === 'object' && 'url' in error
      ? /** @type {{ url?: unknown }} */ (error).url
      : '',
  );
  const targetsTargetModule = message.includes(PRODUCTION_MODULE_MARKER)
    || url.includes(PRODUCTION_MODULE_MARKER)
    || message.includes(PRODUCTION_MODULE_PATH)
    || url.includes(PRODUCTION_MODULE_PATH);
  if (!targetsTargetModule) {
    throw error;
  }
  implementationMissing = true;
  lifecycleApi = null;
}

/**
 * @returns {LifecycleApi}
 */
function requireApi() {
  if (implementationMissing || lifecycleApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {LifecycleApi} */ (lifecycleApi);
}

/**
 * @param {string} prefix
 * @param {(root: string) => Promise<unknown>} fn
 */
async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-lifecycle-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 * @param {(resolvedRoot: string, lease: object) => Promise<unknown>} fn
 */
async function withLease(root, fn) {
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { enqueueAuditIntegrityWriteTask } = await import(
    '../src/audit-integrity-write-queue.js'
  );
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

/**
 * @param {string} root
 */
function lifecycleAbs(root) {
  return join(root, RELATIVE_PATH);
}

/**
 * @param {object} obj
 * @param {readonly string[]} order
 */
function reorderKeys(obj, order) {
  const out = {};
  for (const k of order) out[k] = obj[k];
  return out;
}

/**
 * @param {unknown} value
 * @param {string} [path]
 */
function assertDeeplyFrozen(value, path = 'root') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), `expected frozen at ${path}`);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const key of Object.keys(value)) {
    assertDeeplyFrozen(
      /** @type {Record<string, unknown>} */ (value)[key],
      `${path}.${key}`,
    );
  }
}

/**
 * All public-boundary failures use path-free audit-delivery-unavailable.
 * @param {unknown} error
 * @param {string[]} [leakTokens]
 */
function assertUnavailable(error, leakTokens = []) {
  assert.equal(error && /** @type {{ name?: string }} */ (error).name, 'LinkeError');
  assert.equal(
    error && /** @type {{ code?: string }} */ (error).code,
    CODE_UNAVAILABLE,
  );
  assert.equal(
    error && /** @type {{ message?: string }} */ (error).message,
    CODE_UNAVAILABLE,
  );
  assert.equal(
    /** @type {{ message: string }} */ (error).message,
    /** @type {{ code: string }} */ (error).code,
  );
  assert.equal(/** @type {{ cause?: unknown }} */ (error).cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(error, 'cause'));

  const publicParts = [
    /** @type {{ name: string }} */ (error).name,
    /** @type {{ code: string }} */ (error).code,
    /** @type {{ message: string }} */ (error).message,
    ...Object.keys(/** @type {object} */ (error))
      .filter((key) => key !== 'stack')
      .map((key) => String(/** @type {Record<string, unknown>} */ (error)[key])),
  ].join('\0');

  for (const token of [
    'ENOENT',
    'EACCES',
    'EPERM',
    'ELOOP',
    'errno',
    '/var/',
    '/private/',
    '/tmp/',
    'Users/',
    'SECRET',
    'integrity-alert-delivery-lifecycle',
    PRIVACY_CANARIES.endpoint,
    PRIVACY_CANARIES.token,
    PRIVACY_CANARIES.IP,
    PRIVACY_CANARIES.path,
    ...leakTokens,
  ]) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `must not leak ${token}`);
  }
  return true;
}

function buildOutcome(kind, detail) {
  return { kind, detail };
}

function buildFingerprint(sha256, byteLength, entryCount, nextSequence) {
  return { sha256, byteLength, entryCount, nextSequence };
}

function buildSourceAlert(overrides = {}) {
  return {
    sequence: SEQUENCE,
    checkedAt: SOURCE_CHECKED_AT,
    code: 'audit-integrity-cross-store-broken',
    recoveryRequired: true,
    nextAction: 'run-explicit-recovery',
    reasonCode: null,
    ...overrides,
  };
}

function buildNestedClaim(overrides = {}) {
  return {
    claimId: CLAIM_ID,
    streamId: STREAM_ID,
    sequence: SEQUENCE,
    ...overrides,
  };
}

function buildDeadLetter(overrides = {}) {
  return {
    deadLetterId: DEAD_LETTER_ID,
    reason: 'terminal-http',
    sourceAlert: buildSourceAlert(),
    claim: buildNestedClaim(),
    deadLetterPre: buildFingerprint(SHA_EMPTY_DLQ, 48, 0, 1),
    deadLetterPost: buildFingerprint(SHA_DLQ_POST, 512, 1, 2),
    outboxPre: buildFingerprint(SHA_OUTBOX_PRE, 256, 1, 8),
    outboxPost: buildFingerprint(SHA_OUTBOX_POST, 48, 0, 8),
    preparedAt: PREPARED_AT,
    ...overrides,
  };
}

function buildIdleObject(lastObservedAt = null) {
  return {
    schemaVersion: 1,
    status: 'idle',
    lastObservedAt,
    streamId: null,
    sequence: null,
    idempotencyKey: null,
    attemptId: null,
    attemptCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    claimId: null,
    claimExpiresAt: null,
    outcome: null,
    deadLetter: null,
  };
}

/**
 * Bound (non-idle) fixture base with every TOP_KEYS entry exactly once in
 * frozen insertion order. overrides only replace existing keys so order holds.
 * @param {string} status
 * @param {object} [overrides]
 */
function buildBoundBase(status, overrides = {}) {
  return {
    schemaVersion: 1,
    status,
    lastObservedAt: OBSERVED_AT,
    streamId: STREAM_ID,
    sequence: SEQUENCE,
    idempotencyKey: IDEMPOTENCY_KEY,
    attemptId: ATTEMPT_ID,
    attemptCount: 1,
    firstAttemptAt: FIRST_ATTEMPT_AT,
    lastAttemptAt: LAST_ATTEMPT_AT,
    nextAttemptAt: null,
    claimId: CLAIM_ID,
    claimExpiresAt: CLAIM_EXPIRES_AT,
    outcome: null,
    deadLetter: null,
    ...overrides,
  };
}

function buildInFlightObject(overrides = {}) {
  return buildBoundBase('in-flight', overrides);
}

function buildRetryWaitUnknownNullDetail(overrides = {}) {
  return buildBoundBase('retry-wait', {
    attemptCount: 1,
    nextAttemptAt: NEXT_ATTEMPT_AT,
    outcome: buildOutcome('unknown', null),
    ...overrides,
  });
}

function buildRetryWaitUnknownNetwork(overrides = {}) {
  return buildBoundBase('retry-wait', {
    attemptCount: 2,
    nextAttemptAt: NEXT_ATTEMPT_AT,
    outcome: buildOutcome('unknown', 'uncertain-network'),
    ...overrides,
  });
}

function buildRetryWaitRetryableClaimV(overrides = {}) {
  return buildBoundBase('retry-wait', {
    attemptCount: 3,
    nextAttemptAt: NEXT_ATTEMPT_AT,
    outcome: buildOutcome('retryable-rejected', 'retryable-http'),
    ...overrides,
  });
}

function buildRetryWaitRetryableClaimN(overrides = {}) {
  return buildBoundBase('retry-wait', {
    attemptCount: 3,
    nextAttemptAt: NEXT_ATTEMPT_AT,
    claimId: null,
    claimExpiresAt: null,
    outcome: buildOutcome('retryable-rejected', 'retryable-http'),
    ...overrides,
  });
}

function buildAcceptedPending(overrides = {}) {
  return buildBoundBase('accepted-pending-completion', {
    attemptCount: 1,
    nextAttemptAt: null,
    outcome: buildOutcome('accepted', null),
    ...overrides,
  });
}

function buildDeadLetterPrepared(overrides = {}) {
  return buildBoundBase('dead-letter-prepared', {
    attemptCount: 8,
    nextAttemptAt: null,
    outcome: buildOutcome('terminal-rejected', 'terminal-http'),
    deadLetter: buildDeadLetter(),
    ...overrides,
  });
}

function buildBlockedDeadLetterFull(overrides = {}) {
  return buildBoundBase('blocked', {
    attemptCount: 8,
    nextAttemptAt: null,
    outcome: buildOutcome('blocked', 'dead-letter-full'),
    deadLetter: null,
    ...overrides,
  });
}

/** Exact literal canonical idle null watermark (compact + one trailing newline). */
const CANONICAL_IDLE_NULL_BYTES =
  '{"schemaVersion":1,"status":"idle","lastObservedAt":null,"streamId":null,"sequence":null,"idempotencyKey":null,"attemptId":null,"attemptCount":0,"firstAttemptAt":null,"lastAttemptAt":null,"nextAttemptAt":null,"claimId":null,"claimExpiresAt":null,"outcome":null,"deadLetter":null}\n';

/** Exact literal canonical idle retained watermark. */
const CANONICAL_IDLE_RETAINED_BYTES =
  '{"schemaVersion":1,"status":"idle","lastObservedAt":"2026-08-05T12:00:00.000Z","streamId":null,"sequence":null,"idempotencyKey":null,"attemptId":null,"attemptCount":0,"firstAttemptAt":null,"lastAttemptAt":null,"nextAttemptAt":null,"claimId":null,"claimExpiresAt":null,"outcome":null,"deadLetter":null}\n';

const CANONICAL_IN_FLIGHT_BYTES =
  `${JSON.stringify(buildInFlightObject())}\n`;

const CANONICAL_RETRY_WAIT_UNKNOWN_NULL_BYTES =
  `${JSON.stringify(buildRetryWaitUnknownNullDetail())}\n`;

const CANONICAL_RETRY_WAIT_UNKNOWN_NETWORK_BYTES =
  `${JSON.stringify(buildRetryWaitUnknownNetwork())}\n`;

const CANONICAL_RETRY_WAIT_RETRYABLE_CLAIM_V_BYTES =
  `${JSON.stringify(buildRetryWaitRetryableClaimV())}\n`;

const CANONICAL_RETRY_WAIT_RETRYABLE_CLAIM_N_BYTES =
  `${JSON.stringify(buildRetryWaitRetryableClaimN())}\n`;

const CANONICAL_ACCEPTED_PENDING_BYTES =
  `${JSON.stringify(buildAcceptedPending())}\n`;

const CANONICAL_DEAD_LETTER_PREPARED_BYTES =
  `${JSON.stringify(buildDeadLetterPrepared())}\n`;

const CANONICAL_BLOCKED_BYTES =
  `${JSON.stringify(buildBlockedDeadLetterFull())}\n`;

// Anchor hand-derived literals so fixtures cannot drift silently.
assert.equal(CANONICAL_IDLE_NULL_BYTES, `${JSON.stringify(buildIdleObject(null))}\n`);
assert.equal(
  CANONICAL_IDLE_RETAINED_BYTES,
  `${JSON.stringify(buildIdleObject(OBSERVED_AT))}\n`,
);
assert.match(STREAM_ID, UUID_V4_RE);
assert.match(CLAIM_ID, UUID_V4_RE);
assert.match(ATTEMPT_ID, UUID_V4_RE);
assert.match(DEAD_LETTER_ID, UUID_V4_RE);
assert.match(OBSERVED_AT, MS_UTC_RE);
assert.match(SHA_EMPTY_DLQ, SHA256_HEX_RE);
assert.equal(IDEMPOTENCY_KEY, `audit-integrity-alert:${STREAM_ID}:${SEQUENCE}`);
assert.equal(new Date(OBSERVED_AT).toISOString(), OBSERVED_AT);
assert.equal(new Date(NEXT_ATTEMPT_AT).toISOString(), NEXT_ATTEMPT_AT);
assert.ok(Buffer.byteLength(CANONICAL_IDLE_NULL_BYTES, 'utf8') <= EXPECTED_MAX_BYTES);
assert.ok(
  Buffer.byteLength(CANONICAL_DEAD_LETTER_PREPARED_BYTES, 'utf8') <= EXPECTED_MAX_BYTES,
);

/**
 * @param {object} state
 * @param {object} expected
 */
function assertExactSnapshot(state, expected) {
  assert.deepEqual(Object.keys(state), [...TOP_KEYS]);
  assert.deepEqual(state, expected);
  assertDeeplyFrozen(state);
  assert.throws(() => {
    /** @type {{ status: string }} */ (state).status = 'idle';
  }, TypeError);
}

describe('audit integrity alert delivery lifecycle WAL (Task 2 RED)', () => {
  // Old-HEAD: exactly one dedicated RED. Full behavioral matrix registers only when exports exist.
  if (implementationMissing || lifecycleApi === null) {
    it('lifecycle state implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── A. Constants / API and createIdle ──────────────────────────────────

  it('exports relative path, max bytes 16384, and all four public lifecycle helpers', () => {
    // Break: missing/wrong path or max-bytes would misplace lifecycle leaf or accept oversize WAL.
    const api = requireApi();
    assert.equal(
      api.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH,
      RELATIVE_PATH,
    );
    assert.equal(
      api.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES,
      EXPECTED_MAX_BYTES,
    );
    assert.equal(typeof api.loadAuditIntegrityAlertDeliveryLifecycle, 'function');
    assert.equal(
      typeof api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease,
      'function',
    );
    assert.equal(
      typeof api.assertAuditIntegrityAlertDeliveryLifecycleIdle,
      'function',
    );
    assert.equal(
      typeof api.createIdleAuditIntegrityAlertDeliveryLifecycle,
      'function',
    );
    assert.ok(
      Buffer.byteLength(CANONICAL_IDLE_NULL_BYTES, 'utf8')
        <= api.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES,
    );
    assert.ok(
      Buffer.byteLength(CANONICAL_DEAD_LETTER_PREPARED_BYTES, 'utf8')
        <= api.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES,
    );
  });

  it('createIdle with null watermark returns exact frozen idle-null grammar', () => {
    // Break: inventing a non-null watermark on first idle would fake clock history.
    const api = requireApi();
    const idle = api.createIdleAuditIntegrityAlertDeliveryLifecycle(null);
    assertExactSnapshot(idle, buildIdleObject(null));
    assert.equal(JSON.stringify(idle) + '\n', CANONICAL_IDLE_NULL_BYTES);
    assert.notEqual(idle, buildIdleObject(null));
  });

  it('createIdle with retained watermark returns exact frozen idle-retained grammar', () => {
    // Break: clearing lastObservedAt on idle would allow watermark rewind on next observation.
    const api = requireApi();
    const idle = api.createIdleAuditIntegrityAlertDeliveryLifecycle(OBSERVED_AT);
    assertExactSnapshot(idle, buildIdleObject(OBSERVED_AT));
    assert.equal(JSON.stringify(idle) + '\n', CANONICAL_IDLE_RETAINED_BYTES);
  });

  it('createIdle rejects non-canonical watermark and hostile shapes with fixed unavailable', () => {
    // Break: accepting non-ISO or Proxy watermark would poison durable clock fencing.
    const api = requireApi();
    const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
    const proxy = new Proxy(Object(OBSERVED_AT), {
      get(...args) {
        traps.get += 1;
        return Reflect.get(...args);
      },
      ownKeys(...args) {
        traps.ownKeys += 1;
        return Reflect.ownKeys(...args);
      },
      getOwnPropertyDescriptor(...args) {
        traps.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(...args);
      },
      getPrototypeOf(...args) {
        traps.getPrototypeOf += 1;
        return Reflect.getPrototypeOf(...args);
      },
    });
    for (const bad of [
      undefined,
      '',
      '2026-08-05T12:00:00Z',
      '2026-08-05T12:00:00.000+00:00',
      '2026-08-05 12:00:00.000Z',
      '2026-08-05T12:00:00.000z',
      '2026-08-05T12:00:00.000',
      0,
      1,
      true,
      false,
      [],
      {},
      new String(OBSERVED_AT),
      () => OBSERVED_AT,
      proxy,
      Symbol(OBSERVED_AT),
    ]) {
      // Generic invalid values (booleans, numbers, empty string, containers,
      // boxed strings, functions, Proxy, Symbol, undefined) must still be
      // rejected, but their String() form is not privacy material and must not
      // be treated as a leak token (e.g. retryable:false legitimately exposes
      // "false"). High-signal privacy canaries remain in assertUnavailable.
      assert.throws(
        () => api.createIdleAuditIntegrityAlertDeliveryLifecycle(bad),
        (error) => assertUnavailable(error),
      );
    }
    assert.deepEqual(traps, {
      get: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
    });
  });

  // ── B. Missing leaf load ───────────────────────────────────────────────

  it('load missing leaf returns frozen canonical idle-null and creates nothing', async () => {
    // Break: treating missing as error or auto-creating the WAL would invent durable history.
    const api = requireApi();
    await withTempRoot('load-missing', async (root) => {
      const loaded = await api.loadAuditIntegrityAlertDeliveryLifecycle(root);
      assertExactSnapshot(loaded, buildIdleObject(null));
      assert.equal(JSON.stringify(loaded) + '\n', CANONICAL_IDLE_NULL_BYTES);
      await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(join(root, 'audit')), { code: 'ENOENT' });
    });
  });

  // ── C. Literal compact JSON matrix ─────────────────────────────────────

  const MATRIX_ROWS = Object.freeze([
    {
      name: 'idle-null',
      raw: CANONICAL_IDLE_NULL_BYTES,
      expected: buildIdleObject(null),
    },
    {
      name: 'idle-retained',
      raw: CANONICAL_IDLE_RETAINED_BYTES,
      expected: buildIdleObject(OBSERVED_AT),
    },
    {
      name: 'in-flight',
      raw: CANONICAL_IN_FLIGHT_BYTES,
      expected: buildInFlightObject(),
    },
    {
      name: 'retry-wait-unknown-null-detail',
      raw: CANONICAL_RETRY_WAIT_UNKNOWN_NULL_BYTES,
      expected: buildRetryWaitUnknownNullDetail(),
    },
    {
      name: 'retry-wait-unknown-uncertain-network',
      raw: CANONICAL_RETRY_WAIT_UNKNOWN_NETWORK_BYTES,
      expected: buildRetryWaitUnknownNetwork(),
    },
    {
      name: 'retry-wait-retryable-claim-V',
      raw: CANONICAL_RETRY_WAIT_RETRYABLE_CLAIM_V_BYTES,
      expected: buildRetryWaitRetryableClaimV(),
    },
    {
      name: 'retry-wait-retryable-claim-N',
      raw: CANONICAL_RETRY_WAIT_RETRYABLE_CLAIM_N_BYTES,
      expected: buildRetryWaitRetryableClaimN(),
    },
    {
      name: 'accepted-pending-completion',
      raw: CANONICAL_ACCEPTED_PENDING_BYTES,
      expected: buildAcceptedPending(),
    },
    {
      name: 'dead-letter-prepared',
      raw: CANONICAL_DEAD_LETTER_PREPARED_BYTES,
      expected: buildDeadLetterPrepared(),
    },
    {
      name: 'blocked-dead-letter-full',
      raw: CANONICAL_BLOCKED_BYTES,
      expected: buildBlockedDeadLetterFull(),
    },
  ]);

  for (const row of MATRIX_ROWS) {
    it(`load exact compact fixture ${row.name} returns deep-frozen snapshot and leaves bytes identical`, async () => {
      // Break: accepting non-canonical serialization or mutating disk on read would corrupt WAL truth.
      const api = requireApi();
      await withTempRoot(`matrix-${row.name}`, async (root) => {
        await mkdir(join(root, 'audit'), { recursive: true });
        await writeFile(lifecycleAbs(root), row.raw, { mode: 0o600 });
        const before = await readFile(lifecycleAbs(root));
        const loaded = await api.loadAuditIntegrityAlertDeliveryLifecycle(root);
        assertExactSnapshot(loaded, row.expected);
        assert.deepEqual(Object.keys(loaded), [...TOP_KEYS]);
        if (loaded.outcome !== null) {
          assert.deepEqual(Object.keys(loaded.outcome), [...OUTCOME_KEYS]);
          assertDeeplyFrozen(loaded.outcome);
        }
        if (loaded.deadLetter !== null) {
          assert.deepEqual(Object.keys(loaded.deadLetter), [...DEAD_LETTER_KEYS]);
          assert.deepEqual(
            Object.keys(loaded.deadLetter.sourceAlert),
            [...SOURCE_ALERT_KEYS],
          );
          assert.deepEqual(
            Object.keys(loaded.deadLetter.claim),
            [...CLAIM_NESTED_KEYS],
          );
          for (const fp of [
            'deadLetterPre',
            'deadLetterPost',
            'outboxPre',
            'outboxPost',
          ]) {
            assert.deepEqual(
              Object.keys(loaded.deadLetter[fp]),
              [...FINGERPRINT_KEYS],
            );
          }
          assertDeeplyFrozen(loaded.deadLetter);
        }
        assert.deepEqual(await readFile(lifecycleAbs(root)), before);
        assert.equal(await readFile(lifecycleAbs(root), 'utf8'), row.raw);
        const again = await api.loadAuditIntegrityAlertDeliveryLifecycle(root);
        assert.deepEqual(again, loaded);
        assert.notEqual(again, loaded);
      });
    });
  }

  // ── D. Reject mutations / illegal schema ───────────────────────────────

  it('rejects wrong top and nested key order, extra keys, and missing keys on load and publish', async () => {
    // Break: last-wins JSON or reordered keys would allow dual interpretation of the same WAL.
    const api = requireApi();

    const reorderedTop = reorderKeys(buildIdleObject(OBSERVED_AT), [
      'status',
      'schemaVersion',
      'lastObservedAt',
      'streamId',
      'sequence',
      'idempotencyKey',
      'attemptId',
      'attemptCount',
      'firstAttemptAt',
      'lastAttemptAt',
      'nextAttemptAt',
      'claimId',
      'claimExpiresAt',
      'outcome',
      'deadLetter',
    ]);
    const missingTop = (() => {
      const o = buildIdleObject(OBSERVED_AT);
      delete o.deadLetter;
      return o;
    })();
    const extraTop = { ...buildIdleObject(OBSERVED_AT), extra: true };
    const reorderedOutcome = buildRetryWaitUnknownNetwork({
      outcome: { detail: 'uncertain-network', kind: 'unknown' },
    });
    const extraOutcome = buildRetryWaitUnknownNetwork({
      outcome: { kind: 'unknown', detail: 'uncertain-network', statusCode: 503 },
    });
    const missingOutcomeKey = buildRetryWaitUnknownNetwork({
      outcome: { kind: 'unknown' },
    });
    const reorderedDeadLetter = buildDeadLetterPrepared({
      deadLetter: reorderKeys(buildDeadLetter(), [
        'reason',
        'deadLetterId',
        'sourceAlert',
        'claim',
        'deadLetterPre',
        'deadLetterPost',
        'outboxPre',
        'outboxPost',
        'preparedAt',
      ]),
    });
    const reorderedSourceAlert = buildDeadLetterPrepared({
      deadLetter: buildDeadLetter({
        sourceAlert: {
          checkedAt: SOURCE_CHECKED_AT,
          sequence: SEQUENCE,
          code: 'audit-integrity-cross-store-broken',
          recoveryRequired: true,
          nextAction: 'run-explicit-recovery',
          reasonCode: null,
        },
      }),
    });
    const reorderedFingerprint = buildDeadLetterPrepared({
      deadLetter: buildDeadLetter({
        deadLetterPre: {
          byteLength: 48,
          sha256: SHA_EMPTY_DLQ,
          entryCount: 0,
          nextSequence: 1,
        },
      }),
    });
    const reorderedNestedClaim = buildDeadLetterPrepared({
      deadLetter: buildDeadLetter({
        claim: { streamId: STREAM_ID, claimId: CLAIM_ID, sequence: SEQUENCE },
      }),
    });
    const extraDeadLetterKey = buildDeadLetterPrepared({
      deadLetter: { ...buildDeadLetter(), endpoint: PRIVACY_CANARIES.endpoint },
    });
    const missingDeadLetterKey = (() => {
      const dl = buildDeadLetter();
      delete dl.preparedAt;
      return buildDeadLetterPrepared({ deadLetter: dl });
    })();

    const cases = [
      reorderedTop,
      missingTop,
      extraTop,
      reorderedOutcome,
      extraOutcome,
      missingOutcomeKey,
      reorderedDeadLetter,
      reorderedSourceAlert,
      reorderedFingerprint,
      reorderedNestedClaim,
      extraDeadLetterKey,
      missingDeadLetterKey,
    ];

    for (const [index, state] of cases.entries()) {
      await withTempRoot(`key-order-${index}`, async (root) => {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
              resolvedRoot,
              lease,
              state,
            ),
            (error) => assertUnavailable(error, [
              root,
              PRIVACY_CANARIES.endpoint,
              String(PRIVACY_CANARIES.statusCode),
            ]),
          );
        });
        await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });

        const raw = `${JSON.stringify(state)}\n`;
        if (
          Buffer.byteLength(raw, 'utf8')
            <= api.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES
        ) {
          await mkdir(join(root, 'audit'), { recursive: true });
          await writeFile(lifecycleAbs(root), raw, { mode: 0o600 });
          const before = await readFile(lifecycleAbs(root));
          await assert.rejects(
            () => api.loadAuditIntegrityAlertDeliveryLifecycle(root),
            (error) => assertUnavailable(error, [root, lifecycleAbs(root)]),
          );
          assert.deepEqual(await readFile(lifecycleAbs(root)), before);
        }
      });
    }
  });

  it('rejects invalid schemaVersion, status, types, noncanonical ISO/UUID/idempotency, and attemptCount 9', async () => {
    // Break: loose types or attemptCount 9 would allow illegal recovery and over-attempt delivery.
    const api = requireApi();
    const states = [
      buildInFlightObject({ schemaVersion: 2 }),
      buildInFlightObject({ schemaVersion: '1' }),
      buildInFlightObject({ schemaVersion: 1.5 }),
      buildInFlightObject({ status: 'busy' }),
      buildInFlightObject({ status: 'IN-FLIGHT' }),
      buildInFlightObject({ status: 'retry_wait' }),
      buildInFlightObject({ streamId: STREAM_ID.toUpperCase() }),
      buildInFlightObject({ streamId: 'not-a-uuid' }),
      buildInFlightObject({ streamId: '11111111-1111-1111-8111-111111111111' }),
      buildInFlightObject({ claimId: CLAIM_ID.toUpperCase() }),
      buildInFlightObject({ attemptId: 'c3333333-d333-5333-a333-033333333333' }),
      buildInFlightObject({ sequence: 0 }),
      buildInFlightObject({ sequence: -1 }),
      buildInFlightObject({ sequence: 1.5 }),
      buildInFlightObject({ sequence: Number.NaN }),
      buildInFlightObject({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
      buildInFlightObject({ sequence: '7' }),
      buildInFlightObject({ attemptCount: 9 }),
      buildInFlightObject({ attemptCount: -1 }),
      buildInFlightObject({ attemptCount: 1.5 }),
      buildInFlightObject({ attemptCount: '1' }),
      buildInFlightObject({ attemptCount: Number.NaN }),
      buildInFlightObject({ lastObservedAt: '2026-08-05T12:00:00Z' }),
      buildInFlightObject({ lastObservedAt: '2026-08-05T12:00:00.000+00:00' }),
      buildInFlightObject({ firstAttemptAt: '2026-08-05 12:00:00.000Z' }),
      buildInFlightObject({ lastAttemptAt: '2026-08-05T12:00:30.000' }),
      buildInFlightObject({ claimExpiresAt: '2026-08-05T12:02:00.000z' }),
      buildInFlightObject({
        idempotencyKey: `audit-integrity-alert:${STREAM_ID}:8`,
      }),
      buildInFlightObject({
        idempotencyKey: `AUDIT-INTEGRITY-ALERT:${STREAM_ID}:${SEQUENCE}`,
      }),
      buildInFlightObject({
        idempotencyKey: `audit-integrity-alert:${STREAM_ID}`,
      }),
      buildInFlightObject({ idempotencyKey: IDEMPOTENCY_KEY.toUpperCase() }),
      {
        ...buildIdleObject(OBSERVED_AT),
        attemptCount: 1,
      },
      {
        ...buildIdleObject(OBSERVED_AT),
        streamId: STREAM_ID,
      },
      {
        ...buildIdleObject(OBSERVED_AT),
        sequence: SEQUENCE,
      },
      {
        ...buildIdleObject(null),
        claimId: CLAIM_ID,
      },
      buildRetryWaitUnknownNetwork({ attemptCount: 8 }),
      buildRetryWaitUnknownNetwork({ attemptCount: 0 }),
      buildRetryWaitRetryableClaimV({ attemptCount: 9 }),
      buildAcceptedPending({ attemptCount: 0 }),
      buildBlockedDeadLetterFull({ attemptCount: 0 }),
      buildInFlightObject({ attemptCount: 0 }),
    ];

    for (const [index, state] of states.entries()) {
      await withTempRoot(`invalid-type-${index}`, async (root) => {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
              resolvedRoot,
              lease,
              state,
            ),
            (error) => assertUnavailable(error, [root, CLAIM_ID, STREAM_ID]),
          );
        });
        await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });

        const raw = `${JSON.stringify(state)}\n`;
        if (
          Buffer.byteLength(raw, 'utf8')
            <= api.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES
        ) {
          await mkdir(join(root, 'audit'), { recursive: true });
          await writeFile(lifecycleAbs(root), raw, { mode: 0o600 });
          const before = await readFile(lifecycleAbs(root));
          await assert.rejects(
            () => api.loadAuditIntegrityAlertDeliveryLifecycle(root),
            (error) => assertUnavailable(error, [root, lifecycleAbs(root)]),
          );
          assert.deepEqual(await readFile(lifecycleAbs(root)), before);
        }
      });
    }
  });

  it('rejects every illegal null/status binding including in-flight non-null outcome/next and blocked missing fields', async () => {
    // Break: wrong null grammar would allow network on settled rows or blocked without binding.
    const api = requireApi();
    const illegal = [
      buildInFlightObject({ outcome: buildOutcome('unknown', null) }),
      buildInFlightObject({ outcome: buildOutcome('accepted', null) }),
      buildInFlightObject({ nextAttemptAt: NEXT_ATTEMPT_AT }),
      buildInFlightObject({ claimId: null }),
      buildInFlightObject({ claimExpiresAt: null }),
      buildInFlightObject({ claimId: null, claimExpiresAt: null }),
      buildInFlightObject({ lastObservedAt: null }),
      buildInFlightObject({ streamId: null }),
      buildInFlightObject({ deadLetter: buildDeadLetter() }),
      buildRetryWaitUnknownNullDetail({ nextAttemptAt: null }),
      buildRetryWaitUnknownNetwork({ nextAttemptAt: null }),
      buildRetryWaitRetryableClaimV({ nextAttemptAt: null }),
      buildRetryWaitRetryableClaimN({ nextAttemptAt: null }),
      buildRetryWaitUnknownNullDetail({ claimId: null }),
      buildRetryWaitUnknownNullDetail({ claimExpiresAt: null }),
      buildRetryWaitUnknownNetwork({ claimId: null, claimExpiresAt: null }),
      buildRetryWaitRetryableClaimV({ claimId: null }),
      buildRetryWaitRetryableClaimN({ claimId: CLAIM_ID }),
      buildRetryWaitRetryableClaimN({ claimExpiresAt: CLAIM_EXPIRES_AT }),
      buildRetryWaitRetryableClaimV({
        outcome: buildOutcome('retryable-rejected', null),
      }),
      buildRetryWaitRetryableClaimV({
        outcome: buildOutcome('retryable-rejected', 'terminal-http'),
      }),
      buildAcceptedPending({ nextAttemptAt: NEXT_ATTEMPT_AT }),
      buildAcceptedPending({ outcome: null }),
      buildAcceptedPending({ claimId: null }),
      buildAcceptedPending({
        outcome: buildOutcome('accepted', 'retryable-http'),
      }),
      buildAcceptedPending({ deadLetter: buildDeadLetter() }),
      buildDeadLetterPrepared({ deadLetter: null }),
      buildDeadLetterPrepared({ claimId: null }),
      buildDeadLetterPrepared({ claimExpiresAt: null }),
      buildDeadLetterPrepared({ nextAttemptAt: NEXT_ATTEMPT_AT }),
      buildDeadLetterPrepared({ outcome: null }),
      buildBlockedDeadLetterFull({ streamId: null }),
      buildBlockedDeadLetterFull({ sequence: null }),
      buildBlockedDeadLetterFull({ claimId: null }),
      buildBlockedDeadLetterFull({ claimExpiresAt: null }),
      buildBlockedDeadLetterFull({ outcome: null }),
      buildBlockedDeadLetterFull({
        outcome: buildOutcome('blocked', 'dead-letter-corrupt'),
      }),
      buildBlockedDeadLetterFull({
        outcome: buildOutcome('blocked', 'lifecycle-recovery'),
      }),
      buildBlockedDeadLetterFull({ nextAttemptAt: NEXT_ATTEMPT_AT }),
      buildBlockedDeadLetterFull({ deadLetter: buildDeadLetter() }),
      buildBlockedDeadLetterFull({ lastObservedAt: null }),
      buildBlockedDeadLetterFull({ attemptId: null }),
      {
        ...buildIdleObject(OBSERVED_AT),
        status: 'blocked',
        outcome: buildOutcome('blocked', 'dead-letter-full'),
      },
      buildRetryWaitUnknownNullDetail({
        outcome: buildOutcome('uncertain', null),
      }),
      buildRetryWaitUnknownNullDetail({
        outcome: buildOutcome('uncertain', 'uncertain-network'),
      }),
      buildInFlightObject({
        outcome: buildOutcome('terminal-rejected', 'terminal-http'),
      }),
      buildDeadLetterPrepared({
        outcome: buildOutcome('blocked', 'dead-letter-full'),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          claim: buildNestedClaim({ sequence: SEQUENCE + 1 }),
        }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          sourceAlert: buildSourceAlert({ sequence: SEQUENCE + 1 }),
        }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          claim: buildNestedClaim({ streamId: 'e5555555-f555-4555-a555-255555555555' }),
        }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          deadLetterPost: buildFingerprint(SHA_DLQ_POST, 512, 0, 2),
        }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          deadLetterPost: buildFingerprint(SHA_DLQ_POST, 512, 1, 1),
        }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({ reason: 'dead-letter-corrupt' }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({ reason: 'lifecycle-recovery' }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          deadLetterPre: buildFingerprint('NOT-HEX', 48, 0, 1),
        }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          deadLetterPre: buildFingerprint(SHA_EMPTY_DLQ.toUpperCase(), 48, 0, 1),
        }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          sourceAlert: buildSourceAlert({
            endpoint: PRIVACY_CANARIES.endpoint,
          }),
        }),
      }),
    ];

    for (const [index, state] of illegal.entries()) {
      if (!state || typeof state !== 'object') continue;
      let rawForDisk = null;
      try {
        rawForDisk = `${JSON.stringify(state)}\n`;
      } catch {
        rawForDisk = null;
      }
      await withTempRoot(`illegal-bind-${index}`, async (root) => {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
              resolvedRoot,
              lease,
              state,
            ),
            (error) => assertUnavailable(error, [
              root,
              PRIVACY_CANARIES.endpoint,
              'dead-letter-corrupt',
              'lifecycle-recovery',
            ]),
          );
        });
        await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });

        if (
          rawForDisk !== null
          && Buffer.byteLength(rawForDisk, 'utf8')
            <= api.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES
        ) {
          await mkdir(join(root, 'audit'), { recursive: true });
          await writeFile(lifecycleAbs(root), rawForDisk, { mode: 0o600 });
          const before = await readFile(lifecycleAbs(root));
          await assert.rejects(
            () => api.loadAuditIntegrityAlertDeliveryLifecycle(root),
            (error) => assertUnavailable(error, [root, lifecycleAbs(root)]),
          );
          assert.deepEqual(await readFile(lifecycleAbs(root)), before);
        }
      });
    }
  });

  it('rejects forbidden outcome kind/detail pairs and mismatched deadLetter terminal family', async () => {
    // Break: storing policy token uncertain or fake blockers would reintroduce revoked semantics.
    const api = requireApi();
    const forbidden = [
      buildRetryWaitUnknownNetwork({
        outcome: buildOutcome('uncertain', 'uncertain-network'),
      }),
      buildRetryWaitUnknownNullDetail({
        outcome: buildOutcome('fail-closed', null),
      }),
      buildAcceptedPending({
        outcome: buildOutcome('accept-complete', null),
      }),
      buildBlockedDeadLetterFull({
        outcome: buildOutcome('blocked', null),
      }),
      buildBlockedDeadLetterFull({
        outcome: buildOutcome('blocked', 'attempts-exhausted-retryable'),
      }),
      buildDeadLetterPrepared({
        outcome: buildOutcome('terminal-rejected', 'retryable-http'),
      }),
      buildDeadLetterPrepared({
        outcome: buildOutcome('attempts-exhausted', 'terminal-http'),
      }),
      buildDeadLetterPrepared({
        outcome: buildOutcome('terminal-rejected', 'terminal-http'),
        deadLetter: buildDeadLetter({ reason: 'attempts-exhausted-retryable' }),
      }),
      buildDeadLetterPrepared({
        outcome: buildOutcome('attempts-exhausted', 'attempts-exhausted-retryable'),
        deadLetter: buildDeadLetter({ reason: 'terminal-http' }),
      }),
      buildRetryWaitRetryableClaimV({
        outcome: buildOutcome('retryable-rejected', 'uncertain-network'),
      }),
      buildInFlightObject({
        outcome: buildOutcome('blocked', 'dead-letter-full'),
      }),
    ];

    for (const [index, state] of forbidden.entries()) {
      await withTempRoot(`forbidden-outcome-${index}`, async (root) => {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
              resolvedRoot,
              lease,
              state,
            ),
            (error) => assertUnavailable(error, [root]),
          );
        });
        await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });
      });
    }
  });

  // ── E. Hostile values ──────────────────────────────────────────────────

  it('rejects Proxy/accessor/symbol/boxed/array/function shapes without invoking traps', async () => {
    // Break: JSON.stringify whitewash or trap execution would accept forged WAL or leak secrets.
    const api = requireApi();

    await withTempRoot('proxy-top', async (root) => {
      const target = buildInFlightObject();
      const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
      const proxy = new Proxy(target, {
        get(...args) {
          traps.get += 1;
          return Reflect.get(...args);
        },
        ownKeys(...args) {
          traps.ownKeys += 1;
          return Reflect.ownKeys(...args);
        },
        getOwnPropertyDescriptor(...args) {
          traps.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(...args);
        },
        getPrototypeOf(...args) {
          traps.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(...args);
        },
      });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            proxy,
          ),
          (error) => assertUnavailable(error, [root, 'SECRET']),
        );
      });
      assert.deepEqual(traps, {
        get: 0,
        ownKeys: 0,
        getOwnPropertyDescriptor: 0,
        getPrototypeOf: 0,
      });
      await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });
      assert.throws(
        () => api.assertAuditIntegrityAlertDeliveryLifecycleIdle(proxy),
        (error) => assertUnavailable(error, [root, 'SECRET']),
      );
      assert.deepEqual(traps, {
        get: 0,
        ownKeys: 0,
        getOwnPropertyDescriptor: 0,
        getPrototypeOf: 0,
      });
    });

    await withTempRoot('proxy-nested-outcome', async (root) => {
      const state = buildRetryWaitUnknownNetwork();
      state.outcome = new Proxy(
        { kind: 'unknown', detail: 'uncertain-network' },
        {
          get() {
            throw new Error(`SECRET ${PRIVACY_CANARIES.path}`);
          },
        },
      );
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            state,
          ),
          (error) => assertUnavailable(error, [
            root,
            'SECRET',
            PRIVACY_CANARIES.path,
          ]),
        );
      });
      await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('accessor-outcome', async (root) => {
      let getterHits = 0;
      const withAccessor = {};
      Object.defineProperty(withAccessor, 'kind', {
        enumerable: true,
        configurable: true,
        get() {
          getterHits += 1;
          return 'unknown';
        },
      });
      Object.defineProperty(withAccessor, 'detail', {
        enumerable: true,
        configurable: true,
        get() {
          getterHits += 1;
          return 'uncertain-network';
        },
      });
      const state = buildRetryWaitUnknownNetwork({ outcome: withAccessor });
      assert.deepEqual(JSON.parse(JSON.stringify(state)).outcome, {
        kind: 'unknown',
        detail: 'uncertain-network',
      });
      assert.equal(getterHits, 2);
      getterHits = 0;
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            state,
          ),
          (error) => assertUnavailable(error, [root]),
        );
      });
      assert.equal(getterHits, 0, 'accessor getters must not run');
      await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('symbol-nonenum-shapes', async (root) => {
      const secretSym = Symbol('secret-path-/tmp/leak');
      const withSymbol = buildInFlightObject();
      withSymbol[secretSym] = PRIVACY_CANARIES.path;
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            withSymbol,
          ),
          (error) => assertUnavailable(error, [root, 'secret', '/tmp', PRIVACY_CANARIES.path]),
        );
      });

      const nonEnum = buildInFlightObject();
      Object.defineProperty(nonEnum, 'secret', {
        value: `SECRET_NONENUM ${PRIVACY_CANARIES.path}`,
        enumerable: false,
      });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            nonEnum,
          ),
          (error) => assertUnavailable(error, [root, 'SECRET_NONENUM', PRIVACY_CANARIES.path]),
        );
      });

      for (const shape of [
        null,
        undefined,
        'idle',
        1,
        true,
        false,
        [],
        [buildIdleObject(null)],
        () => buildIdleObject(null),
        new String('idle'),
        Object.create(null),
        Object.create({ status: 'idle' }),
      ]) {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
              resolvedRoot,
              lease,
              shape,
            ),
            (error) => assertUnavailable(error, [root]),
          );
        });
        assert.throws(
          () => api.assertAuditIntegrityAlertDeliveryLifecycleIdle(shape),
          (error) => assertUnavailable(error, [root]),
        );
      }
      await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('class-tojson', async (root) => {
      class HostileOutcome {
        toJSON() {
          return { kind: 'unknown', detail: 'uncertain-network' };
        }
      }
      const state = buildRetryWaitUnknownNetwork();
      state.outcome = new HostileOutcome();
      assert.deepEqual(JSON.parse(JSON.stringify(state)).outcome, {
        kind: 'unknown',
        detail: 'uncertain-network',
      });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            state,
          ),
          (error) => assertUnavailable(error, [root]),
        );
      });
      await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });
    });
  });

  // ── F. Raw file rejects ────────────────────────────────────────────────

  it('rejects BOM, missing/double newline, pretty JSON, trailing space, oversize, invalid UTF-8, symlink, and directory leaf without mutation', async () => {
    // Break: loose file grammar or following symlink would dual-read or clobber outside data.
    const api = requireApi();
    const maxBytes = api.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES;
    assert.equal(maxBytes, EXPECTED_MAX_BYTES);
    const oversizeRaw = 'x'.repeat(maxBytes + 1);
    assert.equal(Buffer.byteLength(oversizeRaw, 'utf8'), maxBytes + 1);

    const textCases = [
      { name: 'bom', raw: `\uFEFF${CANONICAL_IDLE_NULL_BYTES}` },
      { name: 'missing-newline', raw: CANONICAL_IDLE_NULL_BYTES.slice(0, -1) },
      { name: 'double-newline', raw: `${CANONICAL_IDLE_NULL_BYTES}\n` },
      {
        name: 'pretty-json',
        raw: `${JSON.stringify(buildIdleObject(null), null, 2)}\n`,
      },
      {
        name: 'trailing-space',
        raw: `${CANONICAL_IDLE_NULL_BYTES.slice(0, -1)} \n`,
      },
      {
        name: 'space-after-colon',
        raw: CANONICAL_IDLE_NULL_BYTES.replace(':', ': '),
      },
      {
        name: 'tab-after-comma',
        raw: CANONICAL_IDLE_NULL_BYTES.replace(',', ',\t'),
      },
      {
        name: 'unicode-escape-status',
        raw: CANONICAL_IDLE_NULL_BYTES.replace(
          '"status":"idle"',
          '"status":"\\u0069dle"',
        ),
      },
      {
        name: 'duplicate-status-key',
        raw: CANONICAL_IDLE_NULL_BYTES.replace(
          '"status":"idle"',
          '"status":"blocked","status":"idle"',
        ),
      },
      { name: 'trailing-garbage', raw: `${CANONICAL_IDLE_NULL_BYTES.slice(0, -1)} trailing\n` },
      { name: 'invalid-json', raw: '{not-json\n' },
      { name: 'empty', raw: '' },
      { name: 'oversize', raw: oversizeRaw },
    ];

    for (const { name, raw } of textCases) {
      await withTempRoot(`raw-${name}`, async (root) => {
        await mkdir(join(root, 'audit'), { recursive: true });
        await writeFile(lifecycleAbs(root), raw, { mode: 0o600 });
        const before = await readFile(lifecycleAbs(root));
        await assert.rejects(
          () => api.loadAuditIntegrityAlertDeliveryLifecycle(root),
          (error) => assertUnavailable(error, [
            root,
            lifecycleAbs(root),
            raw.slice(0, 48),
            'not-json',
            'trailing',
          ]),
        );
        assert.deepEqual(await readFile(lifecycleAbs(root)), before);
      });
    }

    await withTempRoot('invalid-utf8', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const invalidUtf8 = Buffer.concat([
        Buffer.from(CANONICAL_IDLE_NULL_BYTES.slice(0, -1), 'utf8'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('\n', 'utf8'),
      ]);
      await writeFile(lifecycleAbs(root), invalidUtf8, { mode: 0o600 });
      const before = await readFile(lifecycleAbs(root));
      await assert.rejects(
        () => api.loadAuditIntegrityAlertDeliveryLifecycle(root),
        (error) => assertUnavailable(error, [root, lifecycleAbs(root)]),
      );
      assert.deepEqual(await readFile(lifecycleAbs(root)), before);
    });

    await withTempRoot('dir-leaf', async (root) => {
      await mkdir(lifecycleAbs(root), { recursive: true });
      await assert.rejects(
        () => api.loadAuditIntegrityAlertDeliveryLifecycle(root),
        (error) => assertUnavailable(error, [root, lifecycleAbs(root)]),
      );
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            buildIdleObject(null),
          ),
          (error) => assertUnavailable(error, [root, lifecycleAbs(root)]),
        );
      });
      const st = await lstat(lifecycleAbs(root));
      assert.equal(st.isDirectory(), true);
    });

    await withTempRoot('symlink-leaf', async (root) => {
      const outside = await mkdtemp(join(tmpdir(), 'linke-lifecycle-sym-out-'));
      try {
        const target = join(outside, 'target.json');
        await writeFile(target, CANONICAL_IN_FLIGHT_BYTES, { mode: 0o600 });
        await mkdir(join(root, 'audit'), { recursive: true });
        await symlink(target, lifecycleAbs(root));
        const before = await readFile(target);

        await assert.rejects(
          () => api.loadAuditIntegrityAlertDeliveryLifecycle(root),
          (error) => assertUnavailable(error, [
            root,
            lifecycleAbs(root),
            target,
            outside,
            CLAIM_ID,
          ]),
        );
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
              resolvedRoot,
              lease,
              buildIdleObject(OBSERVED_AT),
            ),
            (error) => assertUnavailable(error, [root, target, outside]),
          );
        });

        assert.deepEqual(await readFile(target), before);
        assert.equal(await readFile(target, 'utf8'), CANONICAL_IN_FLIGHT_BYTES);
        const st = await lstat(lifecycleAbs(root));
        assert.equal(st.isSymbolicLink(), true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  // ── G. assertIdle ──────────────────────────────────────────────────────

  it('assertIdle accepts both exact idle variants and rejects every non-idle and hostile state', async () => {
    // Break: treating non-idle as idle would open manual-ack bypass under outbox gate.
    const api = requireApi();

    assert.equal(
      api.assertAuditIntegrityAlertDeliveryLifecycleIdle(buildIdleObject(null)),
      undefined,
    );
    assert.equal(
      api.assertAuditIntegrityAlertDeliveryLifecycleIdle(buildIdleObject(OBSERVED_AT)),
      undefined,
    );

    const createdNull = api.createIdleAuditIntegrityAlertDeliveryLifecycle(null);
    const createdRetained = api.createIdleAuditIntegrityAlertDeliveryLifecycle(OBSERVED_AT);
    assert.equal(api.assertAuditIntegrityAlertDeliveryLifecycleIdle(createdNull), undefined);
    assert.equal(
      api.assertAuditIntegrityAlertDeliveryLifecycleIdle(createdRetained),
      undefined,
    );

    const nonIdle = [
      buildInFlightObject(),
      buildRetryWaitUnknownNullDetail(),
      buildRetryWaitUnknownNetwork(),
      buildRetryWaitRetryableClaimV(),
      buildRetryWaitRetryableClaimN(),
      buildAcceptedPending(),
      buildDeadLetterPrepared(),
      buildBlockedDeadLetterFull(),
      {
        ...buildIdleObject(OBSERVED_AT),
        attemptCount: 1,
      },
      {
        ...buildIdleObject(OBSERVED_AT),
        streamId: STREAM_ID,
      },
      {
        ...buildIdleObject(null),
        status: 'in-flight',
      },
    ];
    for (const state of nonIdle) {
      assert.throws(
        () => api.assertAuditIntegrityAlertDeliveryLifecycleIdle(state),
        (error) => assertUnavailable(error, [CLAIM_ID, STREAM_ID, PRIVACY_CANARIES.endpoint]),
      );
    }

    await withTempRoot('assert-idle-loaded', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(lifecycleAbs(root), CANONICAL_IDLE_RETAINED_BYTES, { mode: 0o600 });
      const idle = await api.loadAuditIntegrityAlertDeliveryLifecycle(root);
      assert.equal(api.assertAuditIntegrityAlertDeliveryLifecycleIdle(idle), undefined);

      await writeFile(lifecycleAbs(root), CANONICAL_IN_FLIGHT_BYTES, { mode: 0o600 });
      const inFlight = await api.loadAuditIntegrityAlertDeliveryLifecycle(root);
      assert.throws(
        () => api.assertAuditIntegrityAlertDeliveryLifecycleIdle(inFlight),
        (error) => assertUnavailable(error, [root, CLAIM_ID]),
      );
      assert.equal(await readFile(lifecycleAbs(root), 'utf8'), CANONICAL_IN_FLIGHT_BYTES);
    });
  });

  // ── H. publishUnderLease ───────────────────────────────────────────────

  it('invalid missing expired and wrong-root leases perform zero write on publish', async () => {
    // Break: accepting a non-active lease would allow out-of-queue lifecycle mutation.
    const api = requireApi();

    await withTempRoot('lease-missing-forged', async (root) => {
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);
      for (const lease of [null, undefined, Object.freeze({}), Object.freeze({ forged: true })]) {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            buildIdleObject(null),
          ),
          (error) => assertUnavailable(error, [root, 'forged']),
        );
      }
      await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('lease-wrong-root-a', async (rootA) => {
      await withTempRoot('lease-wrong-root-b', async (rootB) => {
        const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
        const resolvedB = await assertSafeDataRoot(rootB);
        await withLease(rootA, async (_resolvedA, lease) => {
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
              resolvedB,
              lease,
              buildIdleObject(OBSERVED_AT),
            ),
            (error) => assertUnavailable(error, [rootA, rootB]),
          );
        });
        await assert.rejects(() => access(lifecycleAbs(rootA)), { code: 'ENOENT' });
        await assert.rejects(() => access(lifecycleAbs(rootB)), { code: 'ENOENT' });
      });
    });

    await withTempRoot('lease-expired', async (root) => {
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);
      let expiredLease = null;
      await withLease(root, async (_resolved, lease) => {
        expiredLease = lease;
      });
      assert.notEqual(expiredLease, null);
      await assert.rejects(
        () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          resolvedRoot,
          expiredLease,
          buildIdleObject(null),
        ),
        (error) => assertUnavailable(error, [root]),
      );
      await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });
    });
  });

  it('valid same-root lease publishes canonical raw bytes mode 0600 and round-trips frozen snapshots', async () => {
    // Break: non-canonical serialization, wrong mode, or mutable return would corrupt durable fencing.
    const api = requireApi();
    await withTempRoot('publish-roundtrip', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        const publishedIdle = await api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          resolvedRoot,
          lease,
          buildIdleObject(null),
        );
        assertExactSnapshot(publishedIdle, buildIdleObject(null));
        assert.equal(await readFile(lifecycleAbs(root), 'utf8'), CANONICAL_IDLE_NULL_BYTES);
        let st = await lstat(lifecycleAbs(root));
        assert.equal(st.isSymbolicLink(), false);
        assert.equal(st.isFile(), true);
        assert.equal(st.mode & 0o777, 0o600);

        const publishedRetained = await api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          resolvedRoot,
          lease,
          buildIdleObject(OBSERVED_AT),
        );
        assertExactSnapshot(publishedRetained, buildIdleObject(OBSERVED_AT));
        assert.equal(
          await readFile(lifecycleAbs(root), 'utf8'),
          CANONICAL_IDLE_RETAINED_BYTES,
        );

        const input = buildInFlightObject();
        const publishedInFlight = await api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          resolvedRoot,
          lease,
          input,
        );
        assertExactSnapshot(publishedInFlight, buildInFlightObject());
        assert.notEqual(publishedInFlight, input);
        input.streamId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
        assert.equal(publishedInFlight.streamId, STREAM_ID);
        assert.equal(await readFile(lifecycleAbs(root), 'utf8'), CANONICAL_IN_FLIGHT_BYTES);
        st = await lstat(lifecycleAbs(root));
        assert.equal(st.mode & 0o777, 0o600);

        const loaded = await api.loadAuditIntegrityAlertDeliveryLifecycle(resolvedRoot);
        assertExactSnapshot(loaded, buildInFlightObject());
        assert.deepEqual(loaded, publishedInFlight);
        assert.notEqual(loaded, publishedInFlight);

        const publishedDl = await api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          resolvedRoot,
          lease,
          buildDeadLetterPrepared(),
        );
        assertExactSnapshot(publishedDl, buildDeadLetterPrepared());
        assert.equal(
          await readFile(lifecycleAbs(root), 'utf8'),
          CANONICAL_DEAD_LETTER_PREPARED_BYTES,
        );
        st = await lstat(lifecycleAbs(root));
        assert.equal(st.mode & 0o777, 0o600);

        const reloaded = await api.loadAuditIntegrityAlertDeliveryLifecycle(resolvedRoot);
        assert.deepEqual(reloaded, publishedDl);
        assert.notEqual(reloaded, publishedDl);
        assertDeeplyFrozen(reloaded.deadLetter);
      });
    });
  });

  it('publisher rejects older lastObservedAt watermark under same lease and leaves bytes identical', async () => {
    // Break: allowing watermark rewind would hide clock rollback and break L3 durable fencing.
    const api = requireApi();
    await withTempRoot('watermark-rewind', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        const first = await api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          resolvedRoot,
          lease,
          buildIdleObject(OBSERVED_AT),
        );
        assertExactSnapshot(first, buildIdleObject(OBSERVED_AT));
        const before = await readFile(lifecycleAbs(root));
        assert.equal(before.toString('utf8'), CANONICAL_IDLE_RETAINED_BYTES);

        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            buildIdleObject(WATERMARK_OLDER),
          ),
          (error) => assertUnavailable(error, [root, WATERMARK_OLDER]),
        );
        assert.deepEqual(await readFile(lifecycleAbs(root)), before);

        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            buildInFlightObject({ lastObservedAt: WATERMARK_OLDER }),
          ),
          (error) => assertUnavailable(error, [root, WATERMARK_OLDER]),
        );
        assert.deepEqual(await readFile(lifecycleAbs(root)), before);

        const equal = await api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          resolvedRoot,
          lease,
          buildIdleObject(OBSERVED_AT),
        );
        assertExactSnapshot(equal, buildIdleObject(OBSERVED_AT));
        assert.equal(
          await readFile(lifecycleAbs(root), 'utf8'),
          CANONICAL_IDLE_RETAINED_BYTES,
        );

        const newer = await api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          resolvedRoot,
          lease,
          buildIdleObject(WATERMARK_NEWER),
        );
        assertExactSnapshot(newer, buildIdleObject(WATERMARK_NEWER));
        assert.equal(
          await readFile(lifecycleAbs(root), 'utf8'),
          `${JSON.stringify(buildIdleObject(WATERMARK_NEWER))}\n`,
        );
        const st = await lstat(lifecycleAbs(root));
        assert.equal(st.mode & 0o777, 0o600);

        const newerInFlight = await api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
          resolvedRoot,
          lease,
          buildInFlightObject({ lastObservedAt: WATERMARK_NEWER }),
        );
        assertExactSnapshot(
          newerInFlight,
          buildInFlightObject({ lastObservedAt: WATERMARK_NEWER }),
        );
      });
    });
  });

  // ── I. Public error conventions ────────────────────────────────────────

  it('public errors are fixed path-free audit-delivery-unavailable without temp root errno or secrets', async () => {
    // Break: leaking paths/errno/raw Error would violate privacy ceiling and operator fail-closed.
    const api = requireApi();
    await withTempRoot('error-surface', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(lifecycleAbs(root), '{not-json\n', { mode: 0o600 });
      await assert.rejects(
        () => api.loadAuditIntegrityAlertDeliveryLifecycle(root),
        (error) => {
          assertUnavailable(error, [
            root,
            lifecycleAbs(root),
            tmpdir(),
            'not-json',
            PRIVACY_CANARIES.endpoint,
            PRIVACY_CANARIES.token,
            PRIVACY_CANARIES.IP,
            PRIVACY_CANARIES.path,
            String(PRIVACY_CANARIES.statusCode),
          ]);
          assert.equal(
            /** @type {{ code: string }} */ (error).code,
            CODE_UNAVAILABLE,
          );
          assert.equal(
            /** @type {{ message: string }} */ (error).message,
            CODE_UNAVAILABLE,
          );
          return true;
        },
      );

      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
            resolvedRoot,
            lease,
            buildInFlightObject({ attemptCount: 9 }),
          ),
          (error) => assertUnavailable(error, [
            root,
            resolvedRoot,
            lifecycleAbs(root),
            'attemptCount',
          ]),
        );
      });
    });
  });

  // ── J. Privacy fixture canaries ────────────────────────────────────────

  it('privacy canaries reject endpoint token headers IP path statusCode and raw Error extras anywhere', async () => {
    // Break: accepting transport/privacy fields in WAL would store secrets and remote metadata.
    const api = requireApi();
    const polluted = [
      { ...buildInFlightObject(), endpoint: PRIVACY_CANARIES.endpoint },
      { ...buildInFlightObject(), token: PRIVACY_CANARIES.token },
      { ...buildInFlightObject(), headers: PRIVACY_CANARIES.headers },
      { ...buildInFlightObject(), IP: PRIVACY_CANARIES.IP },
      { ...buildInFlightObject(), path: PRIVACY_CANARIES.path },
      { ...buildInFlightObject(), statusCode: PRIVACY_CANARIES.statusCode },
      { ...buildInFlightObject(), error: PRIVACY_CANARIES.rawError },
      { ...buildInFlightObject(), message: PRIVACY_CANARIES.rawError },
      { ...buildInFlightObject(), stack: PRIVACY_CANARIES.rawError },
      { ...buildInFlightObject(), errno: -61 },
      { ...buildInFlightObject(), code: 'ECONNREFUSED' },
      buildRetryWaitUnknownNetwork({
        outcome: {
          kind: 'unknown',
          detail: 'uncertain-network',
          statusCode: PRIVACY_CANARIES.statusCode,
        },
      }),
      buildRetryWaitUnknownNetwork({
        outcome: {
          kind: 'unknown',
          detail: 'uncertain-network',
          endpoint: PRIVACY_CANARIES.endpoint,
        },
      }),
      buildDeadLetterPrepared({
        deadLetter: {
          ...buildDeadLetter(),
          endpoint: PRIVACY_CANARIES.endpoint,
        },
      }),
      buildDeadLetterPrepared({
        deadLetter: {
          ...buildDeadLetter(),
          token: PRIVACY_CANARIES.token,
        },
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          sourceAlert: {
            ...buildSourceAlert(),
            path: PRIVACY_CANARIES.path,
          },
        }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          sourceAlert: {
            ...buildSourceAlert(),
            statusCode: PRIVACY_CANARIES.statusCode,
          },
        }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          claim: {
            ...buildNestedClaim(),
            IP: PRIVACY_CANARIES.IP,
          },
        }),
      }),
      buildDeadLetterPrepared({
        deadLetter: buildDeadLetter({
          deadLetterPre: {
            ...buildFingerprint(SHA_EMPTY_DLQ, 48, 0, 1),
            headers: PRIVACY_CANARIES.headers,
          },
        }),
      }),
    ];

    for (const [index, state] of polluted.entries()) {
      let rawForDisk = null;
      try {
        rawForDisk = `${JSON.stringify(state)}\n`;
      } catch {
        rawForDisk = null;
      }
      await withTempRoot(`privacy-${index}`, async (root) => {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.publishAuditIntegrityAlertDeliveryLifecycleUnderLease(
              resolvedRoot,
              lease,
              state,
            ),
            (error) => assertUnavailable(error, [
              root,
              PRIVACY_CANARIES.endpoint,
              PRIVACY_CANARIES.token,
              PRIVACY_CANARIES.IP,
              PRIVACY_CANARIES.path,
              String(PRIVACY_CANARIES.statusCode),
              'ECONNREFUSED',
            ]),
          );
        });
        await assert.rejects(() => access(lifecycleAbs(root)), { code: 'ENOENT' });

        if (
          rawForDisk !== null
          && Buffer.byteLength(rawForDisk, 'utf8')
            <= api.AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES
        ) {
          await mkdir(join(root, 'audit'), { recursive: true });
          await writeFile(lifecycleAbs(root), rawForDisk, { mode: 0o600 });
          const before = await readFile(lifecycleAbs(root));
          await assert.rejects(
            () => api.loadAuditIntegrityAlertDeliveryLifecycle(root),
            (error) => assertUnavailable(error, [
              root,
              PRIVACY_CANARIES.endpoint,
              PRIVACY_CANARIES.token,
              PRIVACY_CANARIES.IP,
            ]),
          );
          assert.deepEqual(await readFile(lifecycleAbs(root)), before);
        }
      });
    }
  });
});
