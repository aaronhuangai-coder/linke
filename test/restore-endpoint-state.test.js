/**
 * RED tests for G0c C3 endpoint restore STATE machine (design §§6.2, 7.8, 10.1–10.5, P2-5).
 *
 * Production module intentionally absent at RED → ERR_MODULE_NOT_FOUND.
 * Real temp dirs; independent fixtures; strong behavioral asserts; no skips; no production algo copy.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
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
import { createHash } from 'node:crypto';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { RESTORE_CHUNK_SIZE } from '../src/restore-schemas.js';
import {
  ENDPOINT_PHASES,
  createEndpointRestoreStateStore,
} from '../src/restore-endpoint-state.js';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440001';
const TASK_ID_B = '550e8400-e29b-41d4-a716-446655440099';
const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-446655440002';
const SNAPSHOT_B = '550e8400-e29b-41d4-a716-446655440012';
const RECEIPT_ID = '550e8400-e29b-41d4-a716-446655440021';
const CLEANUP_ID = '550e8400-e29b-41d4-a716-446655440031';
const DEVICE_A = 'device-alpha-001';
const DEVICE_B = 'device-beta-002';
const DIGEST_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DIGEST_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const STRUCTURE_FP = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const CONTENT_SHA = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const TARGET_A = 'docs/restore-target';
const TARGET_B = 'docs/other-target';
const T0 = '2026-07-23T12:00:00.000Z';
const T1 = '2026-07-23T12:00:01.000Z';
const T2 = '2026-07-23T12:00:02.000Z';

const STATE_INVALID = ERROR_CODES.RESTORE_STATE_INVALID;
const INTEGRITY_FAILED = ERROR_CODES.RESTORE_INTEGRITY_FAILED;

/** Design §10.3 exact closed set — no aliases. */
const EXPECTED_PHASES = Object.freeze([
  'planned',
  'receiving',
  'staging-verified',
  'anchor-intent',
  'anchored',
  'publish-intent',
  'published',
  'completed-awaiting-ack',
  'rollback-intent',
  'failed-target-quarantined',
  'anchor-restored',
  'old-fingerprint-verified',
  'rolled-back-awaiting-ack',
  'cancelled-local',
  'cleanup-intent',
  'cleanup-completed-awaiting-ack',
  'cleaned',
]);

const STORE_SURFACE = Object.freeze([
  'openOrCreateState',
  'readState',
  'writeState',
  'writeReceipt',
  'writeCleanupReceipt',
  'readTombstone',
  'transitionPhase',
  'recordDurableProgress',
  'recoverReceiving',
]);

const STATE_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'relativeTarget',
  'phase',
  'updatedAt',
  'receivedBytes',
  'confirmedFiles',
  'fileCount',
  'totalBytes',
  'chunkSize',
  'oldStructureFingerprint',
  'oldContentSha256',
  'originalTargetExisted',
  'receiptId',
  'cleanupId',
  'cleanupAuthorized',
  'lastErrorCode',
]);

const FORBIDDEN_STATE_KEYS = Object.freeze([
  'targetPathAbs',
  'parentPathAbs',
  'stagingPathAbs',
  'anchorPathAbs',
  'quarantinePathAbs',
  'restoreRoot',
  'dataDir',
  'endpointDataDir',
  'absolutePath',
  'targetAbs',
  'stagingAbs',
  'anchorAbs',
  'quarantineAbs',
  'stagingRoot',
  'absPath',
]);

/**
 * Legal edges from design §§10.1, 10.2, 10.5 (truth table for transitionPhase).
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const LEGAL_EDGES = Object.freeze([
  ['planned', 'receiving'],
  ['planned', 'cancelled-local'],
  ['receiving', 'staging-verified'],
  ['receiving', 'cancelled-local'],
  ['staging-verified', 'anchor-intent'],
  ['staging-verified', 'cancelled-local'],
  ['anchor-intent', 'anchored'],
  ['anchored', 'publish-intent'],
  ['publish-intent', 'published'],
  ['published', 'completed-awaiting-ack'],
  ['published', 'rollback-intent'],
  ['completed-awaiting-ack', 'cleanup-intent'],
  ['rollback-intent', 'failed-target-quarantined'],
  ['failed-target-quarantined', 'anchor-restored'],
  ['anchor-restored', 'old-fingerprint-verified'],
  ['old-fingerprint-verified', 'rolled-back-awaiting-ack'],
  ['rolled-back-awaiting-ack', 'cleanup-intent'],
  ['cancelled-local', 'cleanup-completed-awaiting-ack'],
  ['cleanup-intent', 'cleanup-completed-awaiting-ack'],
  ['cleanup-completed-awaiting-ack', 'cleaned'],
]);

/** Representative illegal jumps that must reject with RESTORE_STATE_INVALID. */
const ILLEGAL_EDGES = Object.freeze([
  ['planned', 'published'],
  ['planned', 'anchor-intent'],
  ['planned', 'cleaned'],
  ['receiving', 'cleaned'],
  ['receiving', 'published'],
  ['staging-verified', 'published'],
  ['anchor-intent', 'cancelled-local'],
  ['anchored', 'cancelled-local'],
  ['publish-intent', 'cancelled-local'],
  ['published', 'planned'],
  ['completed-awaiting-ack', 'cancelled-local'],
  ['cleaned', 'planned'],
  ['cleaned', 'receiving'],
  ['rollback-intent', 'completed-awaiting-ack'],
  ['failed-target-quarantined', 'published'],
  ['receiving', 'planned'],
  ['staging-verified', 'receiving'],
]);

/** @type {string | undefined} */
let endpointDataDir;
/** @type {ReturnType<typeof createClock>} */
let clock;

function createClock(startIso = T0) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    set: (iso) => {
      ms = Date.parse(iso);
    },
    advanceMs: (delta) => {
      ms += delta;
    },
    iso: () => new Date(ms).toISOString(),
  };
}

function openStore(opts = {}) {
  return createEndpointRestoreStateStore({
    endpointDataDir: opts.endpointDataDir ?? /** @type {string} */ (endpointDataDir),
    now: opts.now ?? (() => clock.now()),
  });
}

function baseInit(overrides = {}) {
  return {
    taskId: TASK_ID,
    deviceId: DEVICE_A,
    snapshotId: SNAPSHOT_ID,
    manifestDigest: DIGEST_A,
    relativeTarget: TARGET_A,
    fileCount: 2,
    totalBytes: 100,
    chunkSize: RESTORE_CHUNK_SIZE,
    originalTargetExisted: false,
    oldStructureFingerprint: null,
    oldContentSha256: null,
    ...overrides,
  };
}

function taskDir(taskId = TASK_ID) {
  return join(/** @type {string} */ (endpointDataDir), 'restore-tasks', taskId);
}

function stateAbs(taskId = TASK_ID) {
  return join(taskDir(taskId), 'STATE.json');
}

function receiptAbs(taskId = TASK_ID) {
  return join(taskDir(taskId), 'RECEIPT.json');
}

function cleanupReceiptAbs(taskId = TASK_ID) {
  return join(taskDir(taskId), 'CLEANUP-RECEIPT.json');
}

async function readJson(abs) {
  return JSON.parse(await readFile(abs, 'utf8'));
}

async function writeJson(abs, value) {
  await writeFile(abs, `${JSON.stringify(value)}\n`, 'utf8');
}

/**
 * @param {unknown} error
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
function assertLinkeCode(error, code, opts = {}) {
  assert.ok(error instanceof LinkeError, `expected LinkeError for ${code}, got ${error}`);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  if (opts.statusCode !== undefined) assert.equal(error.statusCode, opts.statusCode);
  if (opts.retryable !== undefined) assert.equal(error.retryable, opts.retryable);

  // Public surface only: message/code/name/status/retryable + own enumerable fields.
  // Do NOT scan err.stack — Node debug stacks naturally contain workspace paths under
  // /Users/.../src|test; design non-leak is wire/log/public fields, not V8 stack frames.
  const ownPublic = Object.keys(/** @type {object} */ (error))
    .filter((k) => k !== 'stack')
    .map((k) => String(/** @type {Record<string, unknown>} */ (error)[k]));
  const publicParts = [
    error.code,
    error.message,
    error.name,
    String(error.statusCode),
    String(error.retryable),
    ...ownPublic,
  ].join('\0');

  const denylist = [
    ...(opts.leakTokens ?? []),
    endpointDataDir ?? '',
    '/Users/',
    'secret-token',
    'ENOENT',
    'EACCES',
    'EPERM',
    'errno',
    'GETTER_SENTINEL',
    'PROXY_SENTINEL',
    'stack boom',
  ].filter(Boolean);

  for (const token of denylist) {
    if (String(token).length < 2) continue;
    // Do not flag tokens that are substrings of the registered kebab code itself.
    if (code.includes(String(token))) continue;
    assert.ok(!publicParts.includes(String(token)), `must not leak ${token}`);
  }
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
async function expectCode(fn, code, opts = {}) {
  await assert.rejects(fn, (error) => {
    assertLinkeCode(error, code, opts);
    return true;
  });
}

/**
 * @param {object} value
 */
function assertDeepFrozen(value) {
  assert.ok(Object.isFrozen(value));
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') assertDeepFrozen(item);
    }
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const child = /** @type {Record<string, unknown>} */ (value)[key];
      if (child && typeof child === 'object') assertDeepFrozen(child);
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} [label]
 */
function assertNoAbsLeakInValue(value, label = 'payload') {
  const blob = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!blob.includes(/** @type {string} */ (endpointDataDir)), `${label}: no endpointDataDir`);
  assert.ok(!blob.includes('/Users/'), `${label}: no /Users/`);
  assert.ok(!blob.includes('secret-token'), `${label}: no token`);
  for (const key of FORBIDDEN_STATE_KEYS) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(value, key),
        false,
        `${label} must not have key ${key}`,
      );
    }
    // Values must not embed absolute staging/anchor/restoreRoot path fragments as free strings.
    if (key === 'restoreRoot' || key === 'dataDir' || key === 'endpointDataDir') {
      assert.ok(!blob.includes(`"${key}"`), `${label} must not serialize ${key}`);
    }
  }
}

function completedReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    deviceId: DEVICE_A,
    snapshotId: SNAPSHOT_ID,
    manifestDigest: DIGEST_A,
    outcome: 'completed',
    relativeTarget: TARGET_A,
    totalBytes: 100,
    fileCount: 2,
    contentSha256: CONTENT_SHA,
    structureFingerprint: STRUCTURE_FP,
    publishedVerifiedAt: clock.iso(),
    rolledBackAt: null,
    anchorPresentBeforePublish: false,
    receiptId: RECEIPT_ID,
    ...overrides,
  };
}

function cleanupReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    cleanupId: CLEANUP_ID,
    taskId: TASK_ID,
    deviceId: DEVICE_A,
    outcome: 'completed',
    receiptId: RECEIPT_ID,
    cleanedAt: clock.iso(),
    ...overrides,
  };
}

/**
 * Independent fixture writer for staging bytes under a real temp staging root.
 * Not a production algorithm copy — plain mkdir/write for recoverReceiving inputs.
 * @param {string} stagingRoot
 * @param {{ path: string, content: Buffer | string }[]} files
 */
async function materializeFixtureTree(stagingRoot, files) {
  for (const f of files) {
    const abs = join(stagingRoot, f.path);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, f.content);
  }
}

/**
 * Independent sha256 helper for fixture construction only (not structure fingerprint algo).
 * @param {Buffer | string} bytes
 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

beforeEach(async () => {
  endpointDataDir = await mkdtemp(join(tmpdir(), 'linke-ep-state-'));
  clock = createClock(T0);
});

afterEach(async () => {
  if (endpointDataDir) {
    await rm(endpointDataDir, { recursive: true, force: true });
    endpointDataDir = undefined;
  }
});

// ── 1. ENDPOINT_PHASES closed set ──────────────────────────────────

describe('ENDPOINT_PHASES closed set (design §10.3)', () => {
  it('exports exactly 17 frozen phase strings with no aliases', () => {
    assert.ok(Array.isArray(ENDPOINT_PHASES));
    assert.ok(Object.isFrozen(ENDPOINT_PHASES));
    assert.equal(ENDPOINT_PHASES.length, 17);
    assert.deepEqual([...ENDPOINT_PHASES], [...EXPECTED_PHASES]);
    assert.deepEqual(new Set(ENDPOINT_PHASES).size, 17);

    // No aliases / alternate spellings present.
    const bannedAliases = [
      'plan',
      'receive',
      'staging_verified',
      'stagingVerified',
      'anchor_intent',
      'complete',
      'done',
      'error',
      'failed',
      'cancel',
      'cleanup',
      'pending',
      'active',
    ];
    for (const alias of bannedAliases) {
      assert.equal(ENDPOINT_PHASES.includes(alias), false, `alias ${alias} must not appear`);
    }

    assert.throws(() => {
      /** @type {string[]} */ (ENDPOINT_PHASES).push('extra');
    }, TypeError);
  });
});

// ── 2. factory surface ─────────────────────────────────────────────

describe('createEndpointRestoreStateStore factory surface', () => {
  it('returns frozen exact method surface', () => {
    const store = openStore();
    assert.ok(Object.isFrozen(store));
    assert.deepEqual(Object.keys(store).sort(), [...STORE_SURFACE].sort());
    for (const key of STORE_SURFACE) {
      assert.equal(typeof /** @type {Record<string, unknown>} */ (store)[key], 'function');
    }
    for (const banned of ['handle', 'router', 'listen', 'app', 'routes', 'httpHintFromRequest']) {
      assert.equal(Object.prototype.hasOwnProperty.call(store, banned), false);
    }
    assert.throws(() => {
      /** @type {Record<string, unknown>} */ (store).extra = 1;
    }, TypeError);
  });

  it('rejects missing/invalid options without executing hostile getters', () => {
    let getterHits = 0;
    const hostile = new Proxy(
      {},
      {
        get(_t, prop) {
          getterHits += 1;
          if (prop === 'endpointDataDir') return endpointDataDir;
          throw new Error('GETTER_SENTINEL');
        },
        ownKeys() {
          return ['endpointDataDir', 'now', 'evil'];
        },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true };
        },
      },
    );
    assert.throws(() => createEndpointRestoreStateStore(/** @type {any} */ (hostile)));
    assert.equal(getterHits, 0);

    assert.throws(() => createEndpointRestoreStateStore(/** @type {any} */ (null)));
    assert.throws(() => createEndpointRestoreStateStore(/** @type {any} */ ([])));
    assert.throws(() =>
      createEndpointRestoreStateStore(/** @type {any} */ ({ endpointDataDir: '' })),
    );
    assert.throws(() =>
      createEndpointRestoreStateStore(/** @type {any} */ ({ endpointDataDir: 12 })),
    );
  });
});

// ── 3. openOrCreate identity + schema + modes ──────────────────────

describe('openOrCreateState — schema, modes, identity, no abs serialization', () => {
  it('creates STATE with exact schema, 0600 file / 0700 dirs, deep-frozen, no abs fields', async () => {
    const store = openStore();
    const state = await store.openOrCreateState(baseInit());

    assert.deepEqual(Object.keys(state).sort(), [...STATE_KEYS].sort());
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.taskId, TASK_ID);
    assert.equal(state.deviceId, DEVICE_A);
    assert.equal(state.snapshotId, SNAPSHOT_ID);
    assert.equal(state.manifestDigest, DIGEST_A);
    assert.equal(state.relativeTarget, TARGET_A);
    assert.equal(state.phase, 'planned');
    assert.equal(state.receivedBytes, 0);
    assert.equal(state.confirmedFiles, 0);
    assert.equal(state.fileCount, 2);
    assert.equal(state.totalBytes, 100);
    assert.equal(state.chunkSize, RESTORE_CHUNK_SIZE);
    assert.equal(state.oldStructureFingerprint, null);
    assert.equal(state.oldContentSha256, null);
    assert.equal(state.originalTargetExisted, false);
    assert.equal(state.receiptId, null);
    assert.equal(state.cleanupId, null);
    assert.equal(state.cleanupAuthorized, false);
    assert.equal(state.lastErrorCode, null);
    assert.equal(state.updatedAt, T0);
    assertDeepFrozen(state);
    assertNoAbsLeakInValue(state);

    const dir = taskDir();
    const dirStat = await lstat(dir);
    assert.ok(dirStat.isDirectory());
    assert.equal(dirStat.mode & 0o777, 0o700);

    const st = await lstat(stateAbs());
    assert.ok(st.isFile());
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.mode & 0o777, 0o600);

    const onDisk = await readJson(stateAbs());
    assert.deepEqual(Object.keys(onDisk).sort(), [...STATE_KEYS].sort());
    assertNoAbsLeakInValue(onDisk, 'STATE.json');
    for (const forbidden of FORBIDDEN_STATE_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(onDisk, forbidden), false);
    }
    // Absolute path substrings must not appear as field values.
    const diskText = await readFile(stateAbs(), 'utf8');
    assert.ok(!diskText.includes(/** @type {string} */ (endpointDataDir)));
    assert.ok(!diskText.includes('/Users/'));
    assert.ok(!diskText.includes('linke-restore-staging'));
    assert.ok(!diskText.includes('linke-restore-anchor'));
    assert.ok(!diskText.includes('linke-restore-quarantine'));
  });

  it('is idempotent for same identity and fails closed on identity mismatch', async () => {
    const store = openStore();
    const first = await store.openOrCreateState(baseInit());
    clock.advanceMs(1000);
    const second = await store.openOrCreateState(baseInit());
    assert.equal(second.taskId, first.taskId);
    assert.equal(second.phase, 'planned');
    assert.equal(second.receivedBytes, first.receivedBytes);
    // updatedAt must not drift on pure re-open of identical identity.
    assert.equal(second.updatedAt, first.updatedAt);

    await expectCode(
      () => store.openOrCreateState(baseInit({ deviceId: DEVICE_B })),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [DEVICE_B, DEVICE_A] },
    );
    await expectCode(
      () => store.openOrCreateState(baseInit({ snapshotId: SNAPSHOT_B })),
      STATE_INVALID,
      { statusCode: 500 },
    );
    await expectCode(
      () => store.openOrCreateState(baseInit({ manifestDigest: DIGEST_B })),
      STATE_INVALID,
      { statusCode: 500 },
    );
    await expectCode(
      () => store.openOrCreateState(baseInit({ relativeTarget: TARGET_B })),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [TARGET_B] },
    );

    // Original STATE must remain intact after mismatch attempts.
    const disk = await readJson(stateAbs());
    assert.equal(disk.deviceId, DEVICE_A);
    assert.equal(disk.snapshotId, SNAPSHOT_ID);
    assert.equal(disk.manifestDigest, DIGEST_A);
    assert.equal(disk.relativeTarget, TARGET_A);
  });

  it('rejects invalid phase / illegal init fields with RESTORE_STATE_INVALID and no path leak', async () => {
    const store = openStore();
    await expectCode(
      () => store.openOrCreateState(baseInit({ phase: 'pending' })),
      STATE_INVALID,
      { statusCode: 500, leakTokens: ['pending'] },
    );
    await expectCode(
      () => store.openOrCreateState(baseInit({ phase: 'active' })),
      STATE_INVALID,
      { statusCode: 500 },
    );
    await expectCode(
      () => store.openOrCreateState(baseInit({ taskId: 'NOT-A-UUID' })),
      STATE_INVALID,
      { statusCode: 500, leakTokens: ['NOT-A-UUID'] },
    );
    await expectCode(
      () =>
        store.openOrCreateState(
          baseInit({
            targetPathAbs: '/tmp/evil',
            restoreRoot: '/tmp/root',
          }),
        ),
      STATE_INVALID,
      {
        statusCode: 500,
        leakTokens: ['/tmp/evil', '/tmp/root', /** @type {string} */ (endpointDataDir)],
      },
    );
  });
});

// ── 4. writeState fsync + atomic + schema ──────────────────────────

describe('writeState — fsync required, atomic, schema strict', () => {
  it('requires writeOptions { fsync: true }; missing or false fail-close', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit());

    await expectCode(
      () => store.writeState(TASK_ID, { lastErrorCode: null }, /** @type {any} */ (undefined)),
      STATE_INVALID,
      { statusCode: 500 },
    );
    await expectCode(
      () => store.writeState(TASK_ID, { lastErrorCode: null }, /** @type {any} */ ({})),
      STATE_INVALID,
      { statusCode: 500 },
    );
    await expectCode(
      () => store.writeState(TASK_ID, { lastErrorCode: null }, { fsync: false }),
      STATE_INVALID,
      { statusCode: 500 },
    );
    await expectCode(
      () => store.writeState(TASK_ID, { lastErrorCode: null }, /** @type {any} */ ({ fsync: 1 })),
      STATE_INVALID,
      { statusCode: 500 },
    );
    await expectCode(
      () =>
        store.writeState(TASK_ID, { lastErrorCode: null }, /** @type {any} */ ({ fsync: 'true' })),
      STATE_INVALID,
      { statusCode: 500 },
    );

    // Valid fsync path updates and keeps modes.
    clock.set(T1);
    const next = await store.writeState(
      TASK_ID,
      { lastErrorCode: ERROR_CODES.RESTORE_INTERRUPTED },
      { fsync: true },
    );
    assert.equal(next.lastErrorCode, ERROR_CODES.RESTORE_INTERRUPTED);
    assert.equal(next.updatedAt, T1);
    assertDeepFrozen(next);
    const st = await lstat(stateAbs());
    assert.equal(st.mode & 0o777, 0o600);
  });

  it('rejects absolute path fields in patch and never serializes them', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit());
    const before = await readFile(stateAbs());

    for (const key of [
      'targetPathAbs',
      'stagingPathAbs',
      'anchorPathAbs',
      'quarantinePathAbs',
      'restoreRoot',
      'dataDir',
      'endpointDataDir',
    ]) {
      await expectCode(
        () =>
          store.writeState(
            TASK_ID,
            { [key]: join(/** @type {string} */ (endpointDataDir), 'evil') },
            { fsync: true },
          ),
        STATE_INVALID,
        {
          statusCode: 500,
          leakTokens: [/** @type {string} */ (endpointDataDir), 'evil'],
        },
      );
    }

    const after = await readFile(stateAbs());
    assert.deepEqual(after, before);
    assert.ok(!after.toString('utf8').includes(/** @type {string} */ (endpointDataDir)));
  });

  it('atomic replace / no-follow: refuses symlink STATE without following', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit());
    const abs = stateAbs();
    const original = await readFile(abs);
    const outside = join(/** @type {string} */ (endpointDataDir), 'outside-state.json');
    await writeFile(outside, original);
    await rm(abs, { force: true });
    await symlink(outside, abs);

    await expectCode(
      () => store.writeState(TASK_ID, { lastErrorCode: null }, { fsync: true }),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [outside, abs] },
    );
    // Outside target must not be mutated by failed write.
    assert.deepEqual(await readFile(outside), original);
  });
});

// ── 5. read / corrupt / unknown keys / type swap ───────────────────

describe('readState / corrupt / hostile disk shapes', () => {
  it('returns deep-frozen exact schema STATE', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit());
    const state = await store.readState(TASK_ID);
    assert.deepEqual(Object.keys(state).sort(), [...STATE_KEYS].sort());
    assertDeepFrozen(state);
    assertNoAbsLeakInValue(state);
  });

  it('symlink / nonregular / corrupt JSON / unknown keys / type swap → STATE_INVALID', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit());
    const abs = stateAbs();
    const good = await readJson(abs);
    const goodText = await readFile(abs, 'utf8');

    // Corrupt JSON
    await writeFile(abs, '{not-json', 'utf8');
    await expectCode(() => store.readState(TASK_ID), STATE_INVALID, {
      statusCode: 500,
      leakTokens: [abs, '{not-json'],
    });

    // Unknown key
    await writeJson(abs, { ...good, evilExtra: true });
    await expectCode(() => store.readState(TASK_ID), STATE_INVALID, {
      statusCode: 500,
      leakTokens: ['evilExtra'],
    });

    // Type swap: receivedBytes as string
    await writeJson(abs, { ...good, receivedBytes: '0' });
    await expectCode(() => store.readState(TASK_ID), STATE_INVALID, { statusCode: 500 });

    // Type swap: phase number
    await writeJson(abs, { ...good, phase: 1 });
    await expectCode(() => store.readState(TASK_ID), STATE_INVALID, { statusCode: 500 });

    // Missing required key
    const missing = { ...good };
    delete missing.manifestDigest;
    await writeJson(abs, missing);
    await expectCode(() => store.readState(TASK_ID), STATE_INVALID, { statusCode: 500 });

    // Nonregular: directory where file expected
    await rm(abs, { force: true });
    await mkdir(abs);
    await expectCode(() => store.readState(TASK_ID), STATE_INVALID, {
      statusCode: 500,
      leakTokens: [abs],
    });

    // Symlink
    await rm(abs, { recursive: true, force: true });
    await writeFile(join(/** @type {string} */ (endpointDataDir), 'out.json'), goodText);
    await symlink(join(/** @type {string} */ (endpointDataDir), 'out.json'), abs);
    await expectCode(() => store.readState(TASK_ID), STATE_INVALID, {
      statusCode: 500,
      leakTokens: [/** @type {string} */ (endpointDataDir)],
    });
  });
});

// ── 6. transitionPhase legal / illegal edges ───────────────────────

describe('transitionPhase — 17-phase legal edges and illegal jumps', () => {
  /**
   * Drive state to a target phase via legal edges only.
   * @param {ReturnType<typeof openStore>} store
   * @param {string} targetPhase
   */
  async function driveTo(store, targetPhase) {
    await store.openOrCreateState(baseInit());
    if (targetPhase === 'planned') return;

    // BFS over legal edges from planned.
    /** @type {Map<string, string[]>} */
    const adj = new Map();
    for (const [from, to] of LEGAL_EDGES) {
      if (!adj.has(from)) adj.set(from, []);
      /** @type {string[]} */ (adj.get(from)).push(to);
    }
    /** @type {Map<string, string | null>} */
    const prev = new Map([['planned', null]]);
    const q = ['planned'];
    while (q.length > 0) {
      const cur = /** @type {string} */ (q.shift());
      if (cur === targetPhase) break;
      for (const nxt of adj.get(cur) ?? []) {
        if (!prev.has(nxt)) {
          prev.set(nxt, cur);
          q.push(nxt);
        }
      }
    }
    assert.ok(prev.has(targetPhase), `no legal path to ${targetPhase}`);

    const path = [];
    for (let p = targetPhase; p != null; p = prev.get(p) ?? null) {
      path.push(p);
    }
    path.reverse();
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i];
      const to = path[i + 1];
      clock.advanceMs(1);
      const next = await store.transitionPhase(TASK_ID, from, to);
      assert.equal(next.phase, to);
      assertDeepFrozen(next);
    }
  }

  it('accepts every design-table legal edge exactly once along a path', async () => {
    // Verify each legal edge in isolation by driving to `from` then stepping to `to`.
    for (const [from, to] of LEGAL_EDGES) {
      // Fresh dir per edge to avoid cross-edge pollution.
      if (endpointDataDir) {
        await rm(endpointDataDir, { recursive: true, force: true });
      }
      endpointDataDir = await mkdtemp(join(tmpdir(), 'linke-ep-edge-'));
      clock = createClock(T0);
      const store = openStore();
      await driveTo(store, from);
      clock.advanceMs(5);
      const next = await store.transitionPhase(TASK_ID, from, to);
      assert.equal(next.phase, to, `legal edge ${from}→${to}`);
      const disk = await readJson(stateAbs());
      assert.equal(disk.phase, to);
    }
  });

  it('rejects illegal jumps and unknown/alias phases with RESTORE_STATE_INVALID', async () => {
    for (const [from, to] of ILLEGAL_EDGES) {
      if (endpointDataDir) {
        await rm(endpointDataDir, { recursive: true, force: true });
      }
      endpointDataDir = await mkdtemp(join(tmpdir(), 'linke-ep-ill-'));
      clock = createClock(T0);
      const store = openStore();
      await driveTo(store, from);
      const before = await readFile(stateAbs());
      await expectCode(() => store.transitionPhase(TASK_ID, from, to), STATE_INVALID, {
        statusCode: 500,
        leakTokens: [from, to, /** @type {string} */ (endpointDataDir)],
      });
      assert.deepEqual(await readFile(stateAbs()), before, `illegal ${from}→${to} must not mutate`);
    }

    const store = openStore();
    await store.openOrCreateState(baseInit());
    await expectCode(
      () => store.transitionPhase(TASK_ID, 'planned', 'pending'),
      STATE_INVALID,
      { statusCode: 500, leakTokens: ['pending'] },
    );
    await expectCode(
      () => store.transitionPhase(TASK_ID, 'plan', 'receiving'),
      STATE_INVALID,
      { statusCode: 500, leakTokens: ['plan'] },
    );
    await expectCode(
      () => store.transitionPhase(TASK_ID, 'receiving', 'staging_verified'),
      STATE_INVALID,
      { statusCode: 500 },
    );
  });

  it('rejects transition when declared from mismatches durable phase', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit());
    // Durable is planned; claiming from receiving must fail.
    await expectCode(
      () => store.transitionPhase(TASK_ID, 'receiving', 'staging-verified'),
      STATE_INVALID,
      { statusCode: 500 },
    );
  });
});

// ── 7. recordDurableProgress (P2-5) ────────────────────────────────

describe('recordDurableProgress — receiving-only, monotone, fsync-durable (P2-5)', () => {
  it('only accepts receiving phase and safe-int nonnegative monotone progress', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit({ totalBytes: 1000, fileCount: 3 }));

    // Not yet receiving
    await expectCode(
      () =>
        store.recordDurableProgress(TASK_ID, {
          fileIndex: 0,
          chunkIndex: 0,
          receivedBytes: 10,
        }),
      STATE_INVALID,
      { statusCode: 500 },
    );

    await store.transitionPhase(TASK_ID, 'planned', 'receiving');

    const p1 = await store.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 100,
    });
    assert.equal(p1.phase, 'receiving');
    assert.equal(p1.receivedBytes, 100);
    assertDeepFrozen(p1);
    assert.equal((await readJson(stateAbs())).receivedBytes, 100);

    const p2 = await store.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: 1,
      receivedBytes: 200,
    });
    assert.equal(p2.receivedBytes, 200);

    // receivedBytes rollback
    await expectCode(
      () =>
        store.recordDurableProgress(TASK_ID, {
          fileIndex: 0,
          chunkIndex: 1,
          receivedBytes: 199,
        }),
      STATE_INVALID,
      { statusCode: 500 },
    );
    assert.equal((await readJson(stateAbs())).receivedBytes, 200);

    // fileIndex rollback
    await expectCode(
      () =>
        store.recordDurableProgress(TASK_ID, {
          fileIndex: -1,
          chunkIndex: 0,
          receivedBytes: 250,
        }),
      STATE_INVALID,
      { statusCode: 500 },
    );

    // chunkIndex rollback while fileIndex same
    await expectCode(
      () =>
        store.recordDurableProgress(TASK_ID, {
          fileIndex: 0,
          chunkIndex: 0,
          receivedBytes: 250,
        }),
      STATE_INVALID,
      { statusCode: 500 },
    );

    // Non safe-int / negative / float
    for (const bad of [
      { fileIndex: 0, chunkIndex: 2, receivedBytes: -1 },
      { fileIndex: 0, chunkIndex: 2, receivedBytes: 1.5 },
      { fileIndex: 0, chunkIndex: 2, receivedBytes: Number.NaN },
      { fileIndex: 0, chunkIndex: 2, receivedBytes: Number.POSITIVE_INFINITY },
      { fileIndex: 0, chunkIndex: 2, receivedBytes: '200' },
      { fileIndex: 0.5, chunkIndex: 2, receivedBytes: 300 },
      { fileIndex: 0, chunkIndex: -1, receivedBytes: 300 },
      { fileIndex: 0, chunkIndex: 2, receivedBytes: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expectCode(
        () => store.recordDurableProgress(TASK_ID, /** @type {any} */ (bad)),
        STATE_INVALID,
        { statusCode: 500 },
      );
    }
    assert.equal((await readJson(stateAbs())).receivedBytes, 200);
  });

  it('persists only after fsync; crash mid-write leaves durable old receivedBytes', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit({ totalBytes: 500, fileCount: 1 }));
    await store.transitionPhase(TASK_ID, 'planned', 'receiving');
    await store.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 50,
    });

    const durableBytes = await readFile(stateAbs());
    const durable = JSON.parse(durableBytes.toString('utf8'));
    assert.equal(durable.receivedBytes, 50);

    // Simulate crash after writing a larger value only into a non-atomic temp sibling:
    // production must use atomic replace+fsync; unreclaimed temp must not become durable.
    const tmpSibling = `${stateAbs()}.tmp-crash`;
    const inflated = {
      ...durable,
      receivedBytes: 400,
      updatedAt: T2,
    };
    await writeFile(tmpSibling, `${JSON.stringify(inflated)}\n`, 'utf8');

    // Re-open store — must read durable 50, not the unreclaimed temp 400.
    const store2 = openStore();
    const reopened = await store2.readState(TASK_ID);
    assert.equal(reopened.receivedBytes, 50);

    // Direct STATE overwrite without going through store fsync path is hostile;
    // recover path must still refuse to *shrink* after a good larger durable write.
    await store2.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: 1,
      receivedBytes: 100,
    });
    assert.equal((await readJson(stateAbs())).receivedBytes, 100);

    // Manual disk shrink attempt must not be accepted as durable progress on next record.
    const current = await readJson(stateAbs());
    await writeJson(stateAbs(), { ...current, receivedBytes: 1000 });
    // If disk says 1000 but we try to write 900, reject; disk stays ≥1000 (implementation may re-validate).
    await expectCode(
      () =>
        store2.recordDurableProgress(TASK_ID, {
          fileIndex: 0,
          chunkIndex: 2,
          receivedBytes: 900,
        }),
      STATE_INVALID,
      { statusCode: 500 },
    );
    const afterReject = await readJson(stateAbs());
    assert.ok(afterReject.receivedBytes >= 1000 || afterReject.receivedBytes === 1000);
    // Never silently write a smaller value than the rejected call attempted relative to durable floor.
    assert.notEqual(afterReject.receivedBytes, 900);
  });
});

// ── 8. recoverReceiving (P2-5) ─────────────────────────────────────

describe('recoverReceiving — reconcile STATE vs staging (P2-5)', () => {
  it('accepts STATE receivedBytes when staging files fully match claimed durable bytes', async () => {
    const store = openStore();
    const content0 = Buffer.from('hello-world-0');
    const content1 = Buffer.from('hello-world-1-extra');
    const files = [
      {
        path: 'a.txt',
        size: content0.length,
        sha256: sha256Hex(content0),
        fileIndex: 0,
      },
      {
        path: 'nested/b.bin',
        size: content1.length,
        sha256: sha256Hex(content1),
        fileIndex: 1,
      },
    ];
    const totalBytes = content0.length + content1.length;

    await store.openOrCreateState(
      baseInit({ fileCount: 2, totalBytes }),
    );
    await store.transitionPhase(TASK_ID, 'planned', 'receiving');
    await store.recordDurableProgress(TASK_ID, {
      fileIndex: 1,
      chunkIndex: 0,
      receivedBytes: totalBytes,
    });

    const stagingRoot = await mkdtemp(join(tmpdir(), 'linke-ep-stg-ok-'));
    try {
      await materializeFixtureTree(stagingRoot, [
        { path: 'a.txt', content: content0 },
        { path: 'nested/b.bin', content: content1 },
      ]);
      const recovered = await store.recoverReceiving(TASK_ID, stagingRoot, files);
      assert.equal(recovered.receivedBytes, totalBytes);
      assert.equal(recovered.phase, 'receiving');
      assertDeepFrozen(recovered);
      assert.equal((await readJson(stateAbs())).receivedBytes, totalBytes);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  });

  it('missing file / short read / content corruption → INTEGRITY_FAILED; STATE not shrunk', async () => {
    const store = openStore();
    const content0 = Buffer.alloc(64, 0xab);
    const content1 = Buffer.alloc(32, 0xcd);
    const files = [
      { path: 'a.bin', size: 64, sha256: sha256Hex(content0), fileIndex: 0 },
      { path: 'b.bin', size: 32, sha256: sha256Hex(content1), fileIndex: 1 },
    ];
    const claimed = 96;

    await store.openOrCreateState(baseInit({ fileCount: 2, totalBytes: claimed }));
    await store.transitionPhase(TASK_ID, 'planned', 'receiving');
    await store.recordDurableProgress(TASK_ID, {
      fileIndex: 1,
      chunkIndex: 0,
      receivedBytes: claimed,
    });

    const beforeBytes = await readFile(stateAbs());
    const beforeJson = JSON.parse(beforeBytes.toString('utf8'));
    assert.equal(beforeJson.receivedBytes, claimed);

    // Missing second file
    const stagingMissing = await mkdtemp(join(tmpdir(), 'linke-ep-stg-miss-'));
    try {
      await materializeFixtureTree(stagingMissing, [{ path: 'a.bin', content: content0 }]);
      await expectCode(
        () => store.recoverReceiving(TASK_ID, stagingMissing, files),
        INTEGRITY_FAILED,
        {
          statusCode: 422,
          leakTokens: [stagingMissing, /** @type {string} */ (endpointDataDir), 'a.bin'],
        },
      );
      const afterMissing = await readFile(stateAbs());
      assert.deepEqual(afterMissing, beforeBytes);
      assert.equal(JSON.parse(afterMissing.toString('utf8')).receivedBytes, claimed);
    } finally {
      await rm(stagingMissing, { recursive: true, force: true });
    }

    // Short file
    const stagingShort = await mkdtemp(join(tmpdir(), 'linke-ep-stg-short-'));
    try {
      await materializeFixtureTree(stagingShort, [
        { path: 'a.bin', content: content0 },
        { path: 'b.bin', content: content1.subarray(0, 10) },
      ]);
      await expectCode(
        () => store.recoverReceiving(TASK_ID, stagingShort, files),
        INTEGRITY_FAILED,
        { statusCode: 422, leakTokens: [stagingShort] },
      );
      assert.deepEqual(await readFile(stateAbs()), beforeBytes);
    } finally {
      await rm(stagingShort, { recursive: true, force: true });
    }

    // Content corruption (same length, wrong bytes)
    const stagingCorrupt = await mkdtemp(join(tmpdir(), 'linke-ep-stg-bad-'));
    try {
      const wrong = Buffer.alloc(32, 0xee);
      await materializeFixtureTree(stagingCorrupt, [
        { path: 'a.bin', content: content0 },
        { path: 'b.bin', content: wrong },
      ]);
      await expectCode(
        () => store.recoverReceiving(TASK_ID, stagingCorrupt, files),
        INTEGRITY_FAILED,
        { statusCode: 422, leakTokens: [stagingCorrupt] },
      );
      const afterCorrupt = await readFile(stateAbs());
      assert.deepEqual(afterCorrupt, beforeBytes);
      assert.equal(JSON.parse(afterCorrupt.toString('utf8')).receivedBytes, claimed);
    } finally {
      await rm(stagingCorrupt, { recursive: true, force: true });
    }
  });

  it('STATE JSON/schema damage → STATE_INVALID; never shrinks receivedBytes', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit({ totalBytes: 10, fileCount: 1 }));
    await store.transitionPhase(TASK_ID, 'planned', 'receiving');
    await store.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 10,
    });
    const before = await readFile(stateAbs());
    await writeFile(stateAbs(), '{broken-state', 'utf8');

    const stagingRoot = await mkdtemp(join(tmpdir(), 'linke-ep-stg-state-'));
    try {
      await materializeFixtureTree(stagingRoot, [
        { path: 'a.txt', content: Buffer.alloc(10, 1) },
      ]);
      await expectCode(
        () =>
          store.recoverReceiving(TASK_ID, stagingRoot, [
            {
              path: 'a.txt',
              size: 10,
              sha256: sha256Hex(Buffer.alloc(10, 1)),
              fileIndex: 0,
            },
          ]),
        STATE_INVALID,
        { statusCode: 500, leakTokens: [stagingRoot, '{broken-state'] },
      );
      // Must not rewrite a "repaired" smaller STATE over the broken bytes in a way that
      // claims progress success — broken JSON either stays broken or fails without shrink semantics.
      const after = await readFile(stateAbs(), 'utf8');
      assert.ok(after === '{broken-state' || !after.includes('"receivedBytes":0'));
      assert.ok(!after.includes('"receivedBytes": 0'));
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }

    // Restore good STATE and ensure integrity failure path also does not shrink.
    await writeFile(stateAbs(), before);
    const stagingEmpty = await mkdtemp(join(tmpdir(), 'linke-ep-stg-empty-'));
    try {
      await expectCode(
        () =>
          store.recoverReceiving(TASK_ID, stagingEmpty, [
            {
              path: 'a.txt',
              size: 10,
              sha256: sha256Hex(Buffer.alloc(10, 1)),
              fileIndex: 0,
            },
          ]),
        INTEGRITY_FAILED,
        { statusCode: 422 },
      );
      assert.deepEqual(await readFile(stateAbs()), before);
    } finally {
      await rm(stagingEmpty, { recursive: true, force: true });
    }
  });

  it('stagingRoot symlink → INTEGRITY_FAILED; STATE bytes unchanged', async () => {
    const store = openStore();
    const content = Buffer.from('root-symlink-payload');
    const files = [
      {
        path: 'a.txt',
        size: content.length,
        sha256: sha256Hex(content),
        fileIndex: 0,
      },
    ];
    await store.openOrCreateState(
      baseInit({ fileCount: 1, totalBytes: content.length }),
    );
    await store.transitionPhase(TASK_ID, 'planned', 'receiving');
    await store.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: content.length,
    });
    const beforeBytes = await readFile(stateAbs());

    // Real staging tree with matching bytes; expose it only via a dir symlink root.
    const realStaging = await mkdtemp(join(tmpdir(), 'linke-ep-stg-real-'));
    const linkParent = await mkdtemp(join(tmpdir(), 'linke-ep-stg-linkp-'));
    const stagingRootLink = join(linkParent, 'staging-as-link');
    try {
      await materializeFixtureTree(realStaging, [{ path: 'a.txt', content }]);
      await symlink(realStaging, stagingRootLink, 'dir');

      await expectCode(
        () => store.recoverReceiving(TASK_ID, stagingRootLink, files),
        INTEGRITY_FAILED,
        {
          statusCode: 422,
          leakTokens: [
            stagingRootLink,
            realStaging,
            /** @type {string} */ (endpointDataDir),
            'a.txt',
          ],
        },
      );
      assert.deepEqual(await readFile(stateAbs()), beforeBytes);
      assert.equal(
        JSON.parse((await readFile(stateAbs())).toString('utf8')).receivedBytes,
        content.length,
      );
    } finally {
      await rm(linkParent, { recursive: true, force: true });
      await rm(realStaging, { recursive: true, force: true });
    }
  });

  it('claimed full-file leaf symlink (same size+sha target) → INTEGRITY_FAILED; STATE unchanged', async () => {
    const store = openStore();
    const content = Buffer.from('identical-leaf-payload-bytes');
    const files = [
      {
        path: 'claimed.bin',
        size: content.length,
        sha256: sha256Hex(content),
        fileIndex: 0,
      },
    ];
    await store.openOrCreateState(
      baseInit({ fileCount: 1, totalBytes: content.length }),
    );
    await store.transitionPhase(TASK_ID, 'planned', 'receiving');
    await store.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: content.length,
    });
    const beforeBytes = await readFile(stateAbs());

    const stagingRoot = await mkdtemp(join(tmpdir(), 'linke-ep-stg-leaf-'));
    const outside = await mkdtemp(join(tmpdir(), 'linke-ep-stg-twin-'));
    try {
      // Twin has identical size + SHA; claimed leaf is a symlink to it.
      // Following would match content — no-follow must still reject.
      const twin = join(outside, 'twin-identical.bin');
      await writeFile(twin, content);
      await symlink(twin, join(stagingRoot, 'claimed.bin'));

      await expectCode(
        () => store.recoverReceiving(TASK_ID, stagingRoot, files),
        INTEGRITY_FAILED,
        {
          statusCode: 422,
          leakTokens: [
            stagingRoot,
            outside,
            twin,
            /** @type {string} */ (endpointDataDir),
            'claimed.bin',
          ],
        },
      );
      assert.deepEqual(await readFile(stateAbs()), beforeBytes);
      assert.equal(
        JSON.parse((await readFile(stateAbs())).toString('utf8')).receivedBytes,
        content.length,
      );
      // Twin must remain untouched (no follow-through mutation).
      assert.deepEqual(await readFile(twin), content);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// ── 9. receipts / cleanup / tombstone ──────────────────────────────

describe('writeReceipt / writeCleanupReceipt / readTombstone', () => {
  it('persists receipt and cleanup receipt with 0600; tombstone deep-frozen exact schema', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit());
    // Drive to a business-terminal-ish local phase for receipt write.
    for (const [from, to] of [
      ['planned', 'receiving'],
      ['receiving', 'staging-verified'],
      ['staging-verified', 'anchor-intent'],
      ['anchor-intent', 'anchored'],
      ['anchored', 'publish-intent'],
      ['publish-intent', 'published'],
      ['published', 'completed-awaiting-ack'],
    ]) {
      clock.advanceMs(1);
      await store.transitionPhase(TASK_ID, from, to);
    }

    const receipt = completedReceipt();
    await store.writeReceipt(TASK_ID, receipt);
    const rStat = await lstat(receiptAbs());
    assert.ok(rStat.isFile());
    assert.equal(rStat.mode & 0o777, 0o600);
    const onDiskReceipt = await readJson(receiptAbs());
    assert.equal(onDiskReceipt.receiptId, RECEIPT_ID);
    assertNoAbsLeakInValue(onDiskReceipt, 'RECEIPT.json');

    await store.transitionPhase(TASK_ID, 'completed-awaiting-ack', 'cleanup-intent');
    const cleanup = cleanupReceipt();
    await store.writeCleanupReceipt(TASK_ID, cleanup);
    await store.transitionPhase(TASK_ID, 'cleanup-intent', 'cleanup-completed-awaiting-ack');

    const cStat = await lstat(cleanupReceiptAbs());
    assert.equal(cStat.mode & 0o777, 0o600);

    const tomb = await store.readTombstone(TASK_ID);
    assertDeepFrozen(tomb);
    assert.ok(tomb.state);
    assert.equal(tomb.state.phase, 'cleanup-completed-awaiting-ack');
    assert.ok(tomb.cleanupReceipt);
    assert.equal(tomb.cleanupReceipt.cleanupId, CLEANUP_ID);
    assertNoAbsLeakInValue(tomb, 'tombstone');
    assertNoAbsLeakInValue(tomb.state, 'tombstone.state');
  });

  it('rejects invalid receipt schema without leaking paths', async () => {
    const store = openStore();
    await store.openOrCreateState(baseInit());
    await expectCode(
      () =>
        store.writeReceipt(TASK_ID, {
          ...completedReceipt(),
          targetPathAbs: join(/** @type {string} */ (endpointDataDir), 'x'),
        }),
      STATE_INVALID,
      {
        statusCode: 500,
        leakTokens: [/** @type {string} */ (endpointDataDir)],
      },
    );
    await expectCode(
      () =>
        store.writeCleanupReceipt(TASK_ID, {
          ...cleanupReceipt(),
          evil: true,
        }),
      STATE_INVALID,
      { statusCode: 500 },
    );
  });
});
