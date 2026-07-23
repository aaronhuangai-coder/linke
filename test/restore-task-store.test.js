/**
 * RED tests for G0c C2 restore task store (Controller TASK/STATUS state machine).
 * Authority: plan C2 interfaces + design §§6.1, 7.2–7.5, 8.4–8.9, 9.1–9.4.
 *
 * Production module intentionally absent at RED → ERR_MODULE_NOT_FOUND.
 * Independent fixtures / temp dataDir; no production algorithm copy; no skips.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import {
  MAX_RESTORE_TASK_JSON_BYTES,
  RESTORE_CHUNK_SIZE,
  projectTaskJson,
  projectStatusJson,
} from '../src/restore-schemas.js';
import { safeDevicePath, slugify } from '../src/storage.js';
import { createRestoreTaskStore } from '../src/restore-task-store.js';

const DEVICE_A = 'device-alpha-001';
const DEVICE_B = 'device-beta-002';
const SNAPSHOT_A = '550e8400-e29b-41d4-a716-446655440010';
const SNAPSHOT_B = '550e8400-e29b-41d4-a716-446655440011';
const DIGEST_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DIGEST_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_C = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const CONTENT_SHA = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const STRUCTURE_FP = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const RECEIPT_ID = '550e8400-e29b-41d4-a716-446655440021';
const RECEIPT_ID_2 = '550e8400-e29b-41d4-a716-446655440022';
const CLEANUP_ID = '550e8400-e29b-41d4-a716-446655440031';
const CLEANUP_ID_2 = '550e8400-e29b-41d4-a716-446655440032';
const T0 = '2026-07-23T12:00:00.000Z';
const TARGET_A = 'docs/restore-target';
const TARGET_B = 'docs/other-target';
const CHUNK = 8_388_608;

const STORE_SURFACE = Object.freeze([
  'acceptCleanup',
  'acceptReceipt',
  'buildTaskFilesPayload',
  'cancel',
  'claimNext',
  'create',
  'get',
  'hasActiveRestore',
  'listAdmissionNonterminal',
  'readTaskImmutable',
  'updateProgress',
]);

const TASK_DISK_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'relativeTarget',
  'createdAt',
  'fileCount',
  'totalBytes',
  'chunkSize',
]);

const STATUS_DISK_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'status',
  'updatedAt',
  'claimedAt',
  'completedAt',
  'receipt',
  'receiptAckAt',
  'cleanupAuthorized',
  'cleanupReceipt',
  'cleanupAckAt',
  'cancelRequestedAt',
  'lastProgress',
]);

const FILE_ENTRY_KEYS = Object.freeze([
  'fileIndex',
  'path',
  'size',
  'sha256',
  'chunkCount',
]);

/** @type {string | undefined} */
let dataDir;
/** @type {ReturnType<typeof createClock>} */
let clock;
/** @type {ReturnType<typeof createUuidSeq>} */
let uuidSeq;

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

function createUuidSeq(prefix = 'aaaaaaaa-bbbb-4ccc-8ddd') {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return `${prefix}-${String(n).padStart(12, '0')}`;
    },
    peek: (i) => `${prefix}-${String(i).padStart(12, '0')}`,
  };
}

/**
 * Independent readable fixture (not production algorithm).
 * @param {{
 *   manifestDigest?: string,
 *   files?: { path: string, size: number, sha256?: string }[],
 * }} [opts]
 */
function makeReadable(opts = {}) {
  const filesIn = opts.files ?? [
    { path: 'a.txt', size: 0, sha256: ZERO_SHA },
    { path: 'b.bin', size: CHUNK + 1, sha256: SHA_B },
  ];
  const files = filesIn.map((f, i) => {
    const size = f.size;
    return {
      fileIndex: i,
      path: f.path,
      size,
      sha256: f.sha256 ?? (size === 0 ? ZERO_SHA : SHA_B),
      chunkCount: size === 0 ? 0 : Math.ceil(size / CHUNK),
    };
  });
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  return Object.freeze({
    manifestDigest: opts.manifestDigest ?? DIGEST_A,
    fileCount: files.length,
    totalBytes,
    files: Object.freeze(files.map((f) => Object.freeze({ ...f }))),
  });
}

/**
 * @param {ReturnType<typeof makeReadable> | (() => ReturnType<typeof makeReadable> | Promise<ReturnType<typeof makeReadable>>)} readableOrFn
 * @param {{ throwError?: unknown }} [opts]
 */
function makeStorageReader(readableOrFn, opts = {}) {
  /** @type {{ deviceId: string, snapshotId: string }[]} */
  const calls = [];
  return {
    calls,
    get callCount() {
      return calls.length;
    },
    assertSnapshotReadable: async (deviceId, snapshotId) => {
      calls.push({ deviceId, snapshotId });
      if (opts.throwError !== undefined) {
        throw opts.throwError;
      }
      const value =
        typeof readableOrFn === 'function' ? await readableOrFn() : readableOrFn;
      // Return a deep clone so store cannot rely on frozen identity.
      return JSON.parse(JSON.stringify(value));
    },
  };
}

/**
 * @param {{
 *   dataDir: string,
 *   storageReader: { assertSnapshotReadable: Function },
 *   now?: () => Date,
 *   randomUUID?: () => string,
 * }} opts
 */
function openStore(opts) {
  return createRestoreTaskStore({
    dataDir: opts.dataDir,
    storageReader: opts.storageReader,
    now: opts.now ?? (() => clock.now()),
    randomUUID: opts.randomUUID ?? (() => uuidSeq.next()),
  });
}

/**
 * @param {unknown} error
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
function assertLinkeCode(error, code, opts = {}) {
  assert.ok(error instanceof LinkeError, `expected LinkeError, got ${error}`);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  if (opts.statusCode !== undefined) assert.equal(error.statusCode, opts.statusCode);
  if (opts.retryable !== undefined) assert.equal(error.retryable, opts.retryable);
  const publicParts = [
    error.code,
    error.message,
    error.name,
    String(error.statusCode),
    String(error.retryable),
    ...Object.keys(/** @type {object} */ (error)).map((k) =>
      String(/** @type {Record<string, unknown>} */ (error)[k]),
    ),
  ].join('\0');
  const denylist = [
    ...(opts.leakTokens ?? []),
    dataDir ?? '',
    '/Users/',
    'secret-token',
    'ENOENT',
    'EACCES',
    'PROXY_SENTINEL',
    'GETTER_SENTINEL',
  ].filter(Boolean);
  for (const token of denylist) {
    if (String(token).length < 2) continue;
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

function taskDirAbs(deviceId, taskId) {
  const { deviceRel } = safeDevicePath(/** @type {string} */ (dataDir), deviceId);
  return join(/** @type {string} */ (dataDir), deviceRel, 'restore-tasks', taskId);
}

function taskJsonAbs(deviceId, taskId) {
  return join(taskDirAbs(deviceId, taskId), 'TASK.json');
}

function statusJsonAbs(deviceId, taskId) {
  return join(taskDirAbs(deviceId, taskId), 'STATUS.json');
}

async function readJson(abs) {
  return JSON.parse(await readFile(abs, 'utf8'));
}

async function writeJson(abs, value) {
  await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * @param {string} deviceId
 * @param {string} taskId
 */
async function assertLayoutAndModes(deviceId, taskId) {
  const dir = taskDirAbs(deviceId, taskId);
  const dirStat = await lstat(dir);
  assert.ok(dirStat.isDirectory());
  assert.equal(dirStat.mode & 0o777, 0o700);

  const taskAbs = taskJsonAbs(deviceId, taskId);
  const statusAbs = statusJsonAbs(deviceId, taskId);
  const taskStat = await lstat(taskAbs);
  const statusStat = await lstat(statusAbs);
  assert.ok(taskStat.isFile());
  assert.ok(statusStat.isFile());
  assert.equal(taskStat.mode & 0o777, 0o600);
  assert.equal(statusStat.mode & 0o777, 0o600);

  // Layout under dataDir/repo/devices/<slug>/restore-tasks/<taskId>/
  const slug = slugify(deviceId);
  assert.ok(dir.includes(join('repo', 'devices', slug, 'restore-tasks', taskId)));
}

/**
 * @param {object} receiptOverrides
 */
function completedReceipt(base, overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: base.taskId,
    deviceId: base.deviceId,
    snapshotId: base.snapshotId,
    manifestDigest: base.manifestDigest,
    outcome: 'completed',
    relativeTarget: base.relativeTarget,
    totalBytes: base.totalBytes,
    fileCount: base.fileCount,
    contentSha256: CONTENT_SHA,
    structureFingerprint: STRUCTURE_FP,
    publishedVerifiedAt: clock.iso(),
    rolledBackAt: null,
    anchorPresentBeforePublish: false,
    receiptId: RECEIPT_ID,
    ...overrides,
  };
}

function rolledBackReceipt(base, overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: base.taskId,
    deviceId: base.deviceId,
    snapshotId: base.snapshotId,
    manifestDigest: base.manifestDigest,
    outcome: 'rolled-back',
    relativeTarget: base.relativeTarget,
    totalBytes: base.totalBytes,
    fileCount: base.fileCount,
    contentSha256: CONTENT_SHA,
    structureFingerprint: STRUCTURE_FP,
    publishedVerifiedAt: null,
    rolledBackAt: clock.iso(),
    anchorPresentBeforePublish: true,
    receiptId: RECEIPT_ID,
    ...overrides,
  };
}

function cleanupCompleted(base, overrides = {}) {
  return {
    schemaVersion: 1,
    cleanupId: CLEANUP_ID,
    taskId: base.taskId,
    deviceId: base.deviceId,
    outcome: 'completed',
    receiptId: RECEIPT_ID,
    cleanedAt: clock.iso(),
    ...overrides,
  };
}

function cleanupCancelled(base, overrides = {}) {
  return {
    schemaVersion: 1,
    cleanupId: CLEANUP_ID,
    taskId: base.taskId,
    deviceId: base.deviceId,
    outcome: 'cancelled',
    receiptId: null,
    cleanedAt: clock.iso(),
    ...overrides,
  };
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
function assertNoSensitiveLeak(value, label = 'payload') {
  const blob = JSON.stringify(value);
  assert.ok(!blob.includes(/** @type {string} */ (dataDir)), `${label} must not include dataDir`);
  assert.ok(!blob.includes('/Users/'), `${label} must not include /Users/`);
  assert.ok(!blob.includes('restoreRoot'), `${label} must not include restoreRoot`);
  assert.ok(!blob.includes('secret-token'), `${label} must not include token`);
  assert.ok(!Object.prototype.hasOwnProperty.call(/** @type {object} */ (value), 'dataDir'));
  assert.ok(!Object.prototype.hasOwnProperty.call(/** @type {object} */ (value), 'restoreRoot'));
  assert.ok(!Object.prototype.hasOwnProperty.call(/** @type {object} */ (value), 'absolutePath'));
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'linke-rts-'));
  clock = createClock(T0);
  uuidSeq = createUuidSeq();
});

afterEach(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

// ── 1. factory / surface ───────────────────────────────────────────

describe('createRestoreTaskStore factory and public surface', () => {
  it('returns frozen exact method surface; no HTTP symbols', () => {
    const reader = makeStorageReader(makeReadable());
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: reader,
    });
    assert.ok(Object.isFrozen(store));
    assert.deepEqual(Object.keys(store).sort(), [...STORE_SURFACE]);
    for (const key of STORE_SURFACE) {
      assert.equal(typeof /** @type {Record<string, unknown>} */ (store)[key], 'function');
    }
    // No HTTP surface
    for (const banned of [
      'handle',
      'router',
      'listen',
      'app',
      'routes',
      'httpHintFromRequest',
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(store, banned), false);
    }
    assert.throws(() => {
      /** @type {Record<string, unknown>} */ (store).extra = 1;
    }, TypeError);
  });

  it('rejects missing/invalid options without executing hostile getters', async () => {
    let getterHits = 0;
    const hostile = new Proxy(
      {},
      {
        get(_t, prop) {
          getterHits += 1;
          if (prop === 'dataDir') return dataDir;
          throw new Error('GETTER_SENTINEL');
        },
        ownKeys() {
          return ['dataDir', 'storageReader', 'now', 'randomUUID', 'evil'];
        },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true };
        },
      },
    );
    assert.throws(() => createRestoreTaskStore(/** @type {any} */ (hostile)));
    assert.equal(getterHits, 0);

    assert.throws(() => createRestoreTaskStore(/** @type {any} */ (null)));
    assert.throws(() => createRestoreTaskStore(/** @type {any} */ ([])));
    assert.throws(() =>
      createRestoreTaskStore(/** @type {any} */ ({ dataDir: '', storageReader: { assertSnapshotReadable: async () => {} } })),
    );
    assert.throws(() =>
      createRestoreTaskStore(
        /** @type {any} */ ({
          dataDir,
          storageReader: {},
        }),
      ),
    );
  });

  it('injects now and randomUUID; invalid/throwing clocks map fail-closed', async () => {
    const reader = makeStorageReader(makeReadable());
    const badNowStore = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: reader,
      now: () => {
        throw new Error(`clock boom ${dataDir} secret-token`);
      },
    });
    await expectCode(
      () =>
        badNowStore.create({
          deviceId: DEVICE_A,
          snapshotId: SNAPSHOT_A,
          relativeTarget: TARGET_A,
        }),
      ERROR_CODES.RESTORE_STATE_INVALID,
      {
        statusCode: 500,
        leakTokens: [/** @type {string} */ (dataDir), 'secret-token', 'clock boom'],
      },
    );

    const badUuidStore = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
      randomUUID: () => 'not-a-uuid',
    });
    await expectCode(
      () =>
        badUuidStore.create({
          deviceId: DEVICE_A,
          snapshotId: SNAPSHOT_A,
          relativeTarget: TARGET_A,
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );
  });
});

// ── 2. create writes reader authority + initial STATUS ─────────────

describe('create — reader authority, TASK/STATUS init, httpHint 201', () => {
  it('calls assertSnapshotReadable exactly once and persists digest/files metadata', async () => {
    const readable = makeReadable({
      manifestDigest: DIGEST_A,
      files: [
        { path: 'docs/readme.txt', size: 12, sha256: SHA_C },
        { path: 'empty.bin', size: 0, sha256: ZERO_SHA },
      ],
    });
    const reader = makeStorageReader(readable);
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: reader,
    });

    const created = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });

    assert.equal(reader.callCount, 1);
    assert.deepEqual(reader.calls[0], { deviceId: DEVICE_A, snapshotId: SNAPSHOT_A });
    assert.equal(created.httpHint, 201);
    assert.ok(created.taskSummary);
    assert.equal(created.taskSummary.taskId, uuidSeq.peek(1));
    assert.equal(created.taskSummary.deviceId, DEVICE_A);
    assert.equal(created.taskSummary.snapshotId, SNAPSHOT_A);
    assert.equal(created.taskSummary.manifestDigest, DIGEST_A);
    assert.equal(created.taskSummary.relativeTarget, TARGET_A);
    assert.equal(created.taskSummary.status, 'pending');
    assert.equal(created.taskSummary.fileCount, readable.fileCount);
    assert.equal(created.taskSummary.totalBytes, readable.totalBytes);
    assert.equal(created.taskSummary.createdAt, T0);
    assertNoSensitiveLeak(created);

    const taskId = created.taskSummary.taskId;
    await assertLayoutAndModes(DEVICE_A, taskId);

    const taskDisk = await readJson(taskJsonAbs(DEVICE_A, taskId));
    assert.deepEqual(Object.keys(taskDisk).sort(), [...TASK_DISK_KEYS].sort());
    const projectedTask = projectTaskJson(taskDisk, { expectedTaskId: taskId });
    assert.equal(projectedTask.manifestDigest, DIGEST_A);
    assert.equal(projectedTask.fileCount, readable.fileCount);
    assert.equal(projectedTask.totalBytes, readable.totalBytes);
    assert.equal(projectedTask.chunkSize, RESTORE_CHUNK_SIZE);
    assert.equal(projectedTask.deviceId, DEVICE_A);
    assert.equal(projectedTask.snapshotId, SNAPSHOT_A);
    assert.equal(projectedTask.relativeTarget, TARGET_A);

    const statusDisk = await readJson(statusJsonAbs(DEVICE_A, taskId));
    assert.deepEqual(Object.keys(statusDisk).sort(), [...STATUS_DISK_KEYS].sort());
    const projectedStatus = projectStatusJson(statusDisk, { expectedTaskId: taskId });
    assert.equal(projectedStatus.status, 'pending');
    assert.equal(projectedStatus.cleanupAuthorized, false);
    assert.equal(projectedStatus.receipt, null);
    assert.equal(projectedStatus.receiptAckAt, null);
    assert.equal(projectedStatus.cleanupReceipt, null);
    assert.equal(projectedStatus.cleanupAckAt, null);
    assert.equal(projectedStatus.cancelRequestedAt, null);
    assert.equal(projectedStatus.lastProgress, null);
    assert.equal(projectedStatus.claimedAt, null);
    assert.equal(projectedStatus.completedAt, null);

    const filesPayload = await store.buildTaskFilesPayload(DEVICE_A, taskId);
    assert.ok(Array.isArray(filesPayload.files) || Array.isArray(filesPayload));
    const files = Array.isArray(filesPayload.files) ? filesPayload.files : filesPayload;
    assert.equal(files.length, readable.files.length);
    for (let i = 0; i < files.length; i += 1) {
      assert.deepEqual(Object.keys(files[i]).sort(), [...FILE_ENTRY_KEYS].sort());
      assert.equal(files[i].fileIndex, i);
      assert.equal(files[i].path, readable.files[i].path);
      assert.equal(files[i].size, readable.files[i].size);
      assert.equal(files[i].sha256, readable.files[i].sha256);
      assert.equal(files[i].chunkCount, readable.files[i].chunkCount);
    }
    assertDeepFrozen(filesPayload);
    assertNoSensitiveLeak(filesPayload);
  });
});

// ── 3. idempotency + one-active admission ──────────────────────────

describe('create — idempotency key + one-active admission', () => {
  it('same identity + same digest nonterminal → httpHint 200 same taskId', async () => {
    const reader = makeStorageReader(makeReadable({ manifestDigest: DIGEST_A }));
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: reader,
    });
    const first = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    assert.equal(first.httpHint, 201);
    const second = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    assert.equal(second.httpHint, 200);
    assert.equal(second.taskSummary.taskId, first.taskSummary.taskId);
    assert.equal(second.taskSummary.manifestDigest, DIGEST_A);
    // Idempotent create may re-read snapshot for digest compare; identity result stable.
    assert.ok(reader.callCount >= 1);
  });

  it('same identity but digest changed → restore-task-conflict', async () => {
    let digest = DIGEST_A;
    const reader = makeStorageReader(() => makeReadable({ manifestDigest: digest }));
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: reader,
    });
    await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    digest = DIGEST_B;
    await expectCode(
      () =>
        store.create({
          deviceId: DEVICE_A,
          snapshotId: SNAPSHOT_A,
          relativeTarget: TARGET_A,
        }),
      ERROR_CODES.RESTORE_TASK_CONFLICT,
      { statusCode: 409 },
    );
  });

  it('second different identity while nonterminal → restore-task-conflict', async () => {
    const reader = makeStorageReader(makeReadable());
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: reader,
    });
    await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    await expectCode(
      () =>
        store.create({
          deviceId: DEVICE_A,
          snapshotId: SNAPSHOT_B,
          relativeTarget: TARGET_B,
        }),
      ERROR_CODES.RESTORE_TASK_CONFLICT,
      { statusCode: 409 },
    );
  });

  it('after terminal, new create allowed with new taskId', async () => {
    const reader = makeStorageReader(makeReadable());
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: reader,
    });
    const first = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    const cancelRes = await store.cancel({
      deviceId: DEVICE_A,
      taskId: first.taskSummary.taskId,
    });
    assert.equal(cancelRes.httpHint, 200);
    assert.equal(cancelRes.status, 'cancelled');

    const second = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    assert.equal(second.httpHint, 201);
    assert.notEqual(second.taskSummary.taskId, first.taskSummary.taskId);
  });
});

// ── 4. TASK immutability ───────────────────────────────────────────

describe('TASK immutability — state-invalid on tamper', () => {
  async function createPending() {
    const readable = makeReadable();
    const reader = makeStorageReader(readable);
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: reader,
    });
    const created = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    return { store, taskId: created.taskSummary.taskId, readable };
  }

  it('missing key / unknown key / field change fail closed without repair', async () => {
    const { store, taskId } = await createPending();
    const abs = taskJsonAbs(DEVICE_A, taskId);
    const original = await readJson(abs);
    const originalText = await readFile(abs, 'utf8');

    // Field change
    await writeJson(abs, { ...original, totalBytes: original.totalBytes + 1 });
    await expectCode(
      () => store.get({ deviceId: DEVICE_A, taskId }),
      ERROR_CODES.RESTORE_STATE_INVALID,
      { statusCode: 500, leakTokens: [abs] },
    );
    // Must not have been "repaired" to original
    const afterGet = await readFile(abs, 'utf8');
    assert.notEqual(afterGet, originalText);

    // Restore then missing key
    await writeFile(abs, originalText, 'utf8');
    const missing = { ...original };
    delete missing.manifestDigest;
    await writeJson(abs, missing);
    await expectCode(
      () => store.readTaskImmutable(DEVICE_A, taskId),
      ERROR_CODES.RESTORE_STATE_INVALID,
      { statusCode: 500 },
    );

    // Unknown key
    await writeJson(abs, { ...original, evil: true });
    await expectCode(
      () => store.buildTaskFilesPayload(DEVICE_A, taskId),
      ERROR_CODES.RESTORE_STATE_INVALID,
      { statusCode: 500 },
    );
  });

  it('file metadata change / replace / symlink / type swap → restore-state-invalid', async () => {
    const { store, taskId, readable } = await createPending();
    const abs = taskJsonAbs(DEVICE_A, taskId);
    const original = await readJson(abs);

    // fileCount / totalBytes / manifestDigest metadata change
    await writeJson(abs, {
      ...original,
      fileCount: readable.fileCount + 1,
    });
    await expectCode(
      () => store.get({ deviceId: DEVICE_A, taskId }),
      ERROR_CODES.RESTORE_STATE_INVALID,
      { statusCode: 500 },
    );

    // Replace TASK with non-json
    await writeFile(abs, '{broken', 'utf8');
    await expectCode(
      () => store.get({ deviceId: DEVICE_A, taskId }),
      ERROR_CODES.RESTORE_STATE_INVALID,
      { statusCode: 500, leakTokens: [abs, '{broken'] },
    );

    // Symlink swap
    await rm(abs, { force: true });
    const outside = join(/** @type {string} */ (dataDir), 'outside-task.json');
    await writeFile(outside, JSON.stringify(original), 'utf8');
    await symlink(outside, abs);
    await expectCode(
      () => store.get({ deviceId: DEVICE_A, taskId }),
      ERROR_CODES.RESTORE_STATE_INVALID,
      { statusCode: 500, leakTokens: [outside, abs] },
    );

    // Type swap: directory where file expected
    await rm(abs, { force: true });
    await mkdir(abs);
    await expectCode(
      () => store.get({ deviceId: DEVICE_A, taskId }),
      ERROR_CODES.RESTORE_STATE_INVALID,
      { statusCode: 500 },
    );
  });
});

// ── 5. get / readTaskImmutable / buildTaskFilesPayload ─────────────

describe('get / readTaskImmutable / buildTaskFilesPayload', () => {
  it('cross-device and unknown task → restore-task-not-found; strict frozen projection', async () => {
    const readable = makeReadable();
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(readable),
    });
    const created = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    const taskId = created.taskSummary.taskId;

    await expectCode(
      () => store.get({ deviceId: DEVICE_B, taskId }),
      ERROR_CODES.RESTORE_TASK_NOT_FOUND,
      { statusCode: 404, leakTokens: [DEVICE_A, taskId] },
    );
    await expectCode(
      () => store.readTaskImmutable(DEVICE_B, taskId),
      ERROR_CODES.RESTORE_TASK_NOT_FOUND,
      { statusCode: 404 },
    );
    await expectCode(
      () => store.buildTaskFilesPayload(DEVICE_B, taskId),
      ERROR_CODES.RESTORE_TASK_NOT_FOUND,
      { statusCode: 404 },
    );
    await expectCode(
      () =>
        store.get({
          deviceId: DEVICE_A,
          taskId: '550e8400-e29b-41d4-a716-446655449999',
        }),
      ERROR_CODES.RESTORE_TASK_NOT_FOUND,
      { statusCode: 404 },
    );

    const got = await store.get({ deviceId: DEVICE_A, taskId });
    assert.equal(got.taskId, taskId);
    assert.equal(got.deviceId, DEVICE_A);
    assert.equal(got.snapshotId, SNAPSHOT_A);
    assert.equal(got.manifestDigest, DIGEST_A);
    assert.equal(got.relativeTarget, TARGET_A);
    assert.equal(got.status, 'pending');
    assert.equal(got.cancelRequested, false);
    assert.equal(got.cleanupAuthorized, false);
    assert.equal(got.fileCount, readable.fileCount);
    assert.equal(got.totalBytes, readable.totalBytes);
    assertDeepFrozen(got);
    assertNoSensitiveLeak(got);

    const immutable = await store.readTaskImmutable(DEVICE_A, taskId);
    assert.equal(immutable.taskId, taskId);
    assert.equal(immutable.manifestDigest, DIGEST_A);
    assert.equal(immutable.chunkSize, RESTORE_CHUNK_SIZE);
    assert.deepEqual(Object.keys(immutable).sort(), [...TASK_DISK_KEYS].sort());
    assertDeepFrozen(immutable);
    assertNoSensitiveLeak(immutable);

    const filesPayload = await store.buildTaskFilesPayload(DEVICE_A, taskId);
    const files = Array.isArray(filesPayload.files) ? filesPayload.files : filesPayload;
    assert.equal(files.length, readable.files.length);
    for (let i = 0; i < files.length; i += 1) {
      assert.equal(files[i].fileIndex, i);
      assert.deepEqual(Object.keys(files[i]).sort(), [...FILE_ENTRY_KEYS].sort());
    }
    assertDeepFrozen(filesPayload);
  });
});

// ── 6. claimNext ───────────────────────────────────────────────────

describe('claimNext', () => {
  it('requires strict boolean hasActiveUpload; true → conflict; false claims pending', async () => {
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
    });
    const created = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    const taskId = created.taskSummary.taskId;

    for (const bad of [1, 0, 'true', 'false', null, undefined, {}, []]) {
      await expectCode(
        () =>
          store.claimNext({
            deviceId: DEVICE_A,
            hasActiveUpload: /** @type {any} */ (bad),
          }),
        ERROR_CODES.RESTORE_TASK_INVALID,
        { statusCode: 400 },
      );
    }

    await expectCode(
      () => store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: true }),
      ERROR_CODES.RESTORE_TASK_CONFLICT,
      { statusCode: 409 },
    );

    // Still pending after rejected claim
    const statusBefore = await readJson(statusJsonAbs(DEVICE_A, taskId));
    assert.equal(statusBefore.status, 'pending');

    clock.advanceMs(1000);
    const claimed = await store.claimNext({
      deviceId: DEVICE_A,
      hasActiveUpload: false,
    });
    assert.ok(claimed.task);
    assert.equal(claimed.task.taskId, taskId);
    assert.equal(claimed.task.status, 'active');
    assert.equal(claimed.task.claimedAt, clock.iso());
    assert.equal(claimed.task.cancelRequested, false);
    assert.equal(claimed.task.chunkSize, RESTORE_CHUNK_SIZE);
    assertDeepFrozen(claimed);
    assertNoSensitiveLeak(claimed);

    const statusAfter = await readJson(statusJsonAbs(DEVICE_A, taskId));
    assert.equal(statusAfter.status, 'active');
    assert.equal(statusAfter.claimedAt, clock.iso());
    assert.equal(statusAfter.cleanupAuthorized, false);

    // Already active → no re-claim of same task as pending→active
    await expectCode(
      () => store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false }),
      ERROR_CODES.RESTORE_TASK_CONFLICT,
      { statusCode: 409 },
    );
  });

  it('cross-device isolation; empty device returns task null; does not inspect upload beyond flag', async () => {
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
    });
    await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });

    const empty = await store.claimNext({
      deviceId: DEVICE_B,
      hasActiveUpload: false,
    });
    assert.deepEqual(empty, { task: null });
    assertDeepFrozen(empty);

    // Device A still pending (B claim must not steal)
    const listA = await store.listAdmissionNonterminal(DEVICE_A);
    assert.equal(listA.length, 1);
    const got = await store.get({ deviceId: DEVICE_A, taskId: listA[0] });
    assert.equal(got.status, 'pending');
  });
});

// ── 7. cancel table ────────────────────────────────────────────────

describe('cancel table', () => {
  it('pending→200 cancelled; active→202 still active cancelRequested; terminal conflict/idempotent', async () => {
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
    });

    // pending cancel
    const p = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    clock.advanceMs(500);
    const c1 = await store.cancel({ deviceId: DEVICE_A, taskId: p.taskSummary.taskId });
    assert.equal(c1.httpHint, 200);
    assert.equal(c1.status, 'cancelled');
    assert.equal(c1.cancelRequested, true);
    const statusP = await readJson(statusJsonAbs(DEVICE_A, p.taskSummary.taskId));
    assert.equal(statusP.status, 'cancelled');
    assert.notEqual(statusP.cancelRequestedAt, null);

    // cancelled idempotent
    const c1b = await store.cancel({ deviceId: DEVICE_A, taskId: p.taskSummary.taskId });
    assert.equal(c1b.httpHint, 200);
    assert.equal(c1b.status, 'cancelled');
    assert.equal(c1b.cancelRequested, true);

    // active cancel — must NOT flip to cancelled
    const p2 = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_B,
      relativeTarget: TARGET_B,
    });
    await store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });
    clock.advanceMs(500);
    const c2 = await store.cancel({ deviceId: DEVICE_A, taskId: p2.taskSummary.taskId });
    assert.equal(c2.httpHint, 202);
    assert.equal(c2.status, 'active');
    assert.equal(c2.cancelRequested, true);
    const statusA = await readJson(statusJsonAbs(DEVICE_A, p2.taskSummary.taskId));
    assert.equal(statusA.status, 'active');
    assert.notEqual(statusA.cancelRequestedAt, null);
    assert.equal(statusA.cleanupAuthorized, false);

    // complete the active task via receipt then cancel → conflict
    clock.advanceMs(500);
    const taskImm = await store.readTaskImmutable(DEVICE_A, p2.taskSummary.taskId);
    await store.acceptReceipt({
      deviceId: DEVICE_A,
      taskId: p2.taskSummary.taskId,
      receipt: completedReceipt({
        taskId: p2.taskSummary.taskId,
        deviceId: DEVICE_A,
        snapshotId: taskImm.snapshotId,
        manifestDigest: taskImm.manifestDigest,
        relativeTarget: taskImm.relativeTarget,
        totalBytes: taskImm.totalBytes,
        fileCount: taskImm.fileCount,
      }),
    });
    await expectCode(
      () => store.cancel({ deviceId: DEVICE_A, taskId: p2.taskSummary.taskId }),
      ERROR_CODES.RESTORE_TASK_CONFLICT,
      { statusCode: 409 },
    );

    // cleaned → conflict
    await store.acceptCleanup({
      deviceId: DEVICE_A,
      taskId: p2.taskSummary.taskId,
      cleanupReceipt: cleanupCompleted({
        taskId: p2.taskSummary.taskId,
        deviceId: DEVICE_A,
      }),
    });
    await expectCode(
      () => store.cancel({ deviceId: DEVICE_A, taskId: p2.taskSummary.taskId }),
      ERROR_CODES.RESTORE_TASK_CONFLICT,
      { statusCode: 409 },
    );
  });
});

// ── 8. acceptReceipt ───────────────────────────────────────────────

describe('acceptReceipt', () => {
  async function createActive() {
    const readable = makeReadable();
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(readable),
    });
    const created = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    await store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });
    const taskId = created.taskSummary.taskId;
    const task = await store.readTaskImmutable(DEVICE_A, taskId);
    return { store, taskId, task, readable };
  }

  it('accepts completed/rolled-back on active; sets cleanupAuthorized; never cleaned; idempotent', async () => {
    const { store, taskId, task } = await createActive();
    clock.advanceMs(1000);
    const receipt = completedReceipt({
      taskId,
      deviceId: DEVICE_A,
      snapshotId: task.snapshotId,
      manifestDigest: task.manifestDigest,
      relativeTarget: task.relativeTarget,
      totalBytes: task.totalBytes,
      fileCount: task.fileCount,
    });

    const ack = await store.acceptReceipt({
      deviceId: DEVICE_A,
      taskId,
      receipt,
    });
    assert.deepEqual(Object.keys(ack).sort(), [
      'cleanupAuthorized',
      'ok',
      'receiptId',
      'status',
      'taskId',
    ].sort());
    assert.equal(ack.ok, true);
    assert.equal(ack.taskId, taskId);
    assert.equal(ack.status, 'completed');
    assert.equal(ack.cleanupAuthorized, true);
    assert.equal(ack.receiptId, RECEIPT_ID);
    assert.notEqual(ack.status, 'cleaned');

    const statusDisk = await readJson(statusJsonAbs(DEVICE_A, taskId));
    assert.equal(statusDisk.status, 'completed');
    assert.equal(statusDisk.cleanupAuthorized, true);
    assert.notEqual(statusDisk.completedAt, null);
    assert.notEqual(statusDisk.receiptAckAt, null);
    assert.ok(statusDisk.receipt);
    assert.equal(statusDisk.receipt.receiptId, RECEIPT_ID);
    assert.equal(statusDisk.cleanupReceipt, null);
    assert.equal(statusDisk.cleanupAckAt, null);

    // Idempotent same receipt
    const ack2 = await store.acceptReceipt({
      deviceId: DEVICE_A,
      taskId,
      receipt: structuredClone(receipt),
    });
    assert.equal(ack2.ok, true);
    assert.equal(ack2.status, 'completed');
    assert.equal(ack2.cleanupAuthorized, true);
    assert.equal(ack2.receiptId, RECEIPT_ID);

    // Conflicting receipt
    await expectCode(
      () =>
        store.acceptReceipt({
          deviceId: DEVICE_A,
          taskId,
          receipt: { ...receipt, receiptId: RECEIPT_ID_2 },
        }),
      ERROR_CODES.RESTORE_TASK_CONFLICT,
      { statusCode: 409 },
    );

    // Cross device
    await expectCode(
      () =>
        store.acceptReceipt({
          deviceId: DEVICE_B,
          taskId,
          receipt: { ...receipt, deviceId: DEVICE_B },
        }),
      ERROR_CODES.RESTORE_TASK_NOT_FOUND,
      { statusCode: 404 },
    );
  });

  it('accepts rolled-back outcome; invalid schema/fingerprint fail-close', async () => {
    const { store, taskId, task } = await createActive();
    clock.advanceMs(1000);
    const receipt = rolledBackReceipt({
      taskId,
      deviceId: DEVICE_A,
      snapshotId: task.snapshotId,
      manifestDigest: task.manifestDigest,
      relativeTarget: task.relativeTarget,
      totalBytes: task.totalBytes,
      fileCount: task.fileCount,
    });
    const ack = await store.acceptReceipt({ deviceId: DEVICE_A, taskId, receipt });
    assert.equal(ack.status, 'rolled-back');
    assert.equal(ack.cleanupAuthorized, true);
    const statusDisk = await readJson(statusJsonAbs(DEVICE_A, taskId));
    assert.equal(statusDisk.status, 'rolled-back');
    assert.notEqual(statusDisk.status, 'cleaned');

    // New active for invalid cases
    const store2 = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable({ manifestDigest: DIGEST_B })),
    });
    // First finish previous rolled-back with cleanup so admission frees
    await store.acceptCleanup({
      deviceId: DEVICE_A,
      taskId,
      cleanupReceipt: {
        schemaVersion: 1,
        cleanupId: CLEANUP_ID,
        taskId,
        deviceId: DEVICE_A,
        outcome: 'rolled-back',
        receiptId: RECEIPT_ID,
        cleanedAt: clock.iso(),
      },
    });

    const c2 = await store2.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_B,
      relativeTarget: TARGET_B,
    });
    await store2.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });
    const t2 = await store2.readTaskImmutable(DEVICE_A, c2.taskSummary.taskId);
    await expectCode(
      () =>
        store2.acceptReceipt({
          deviceId: DEVICE_A,
          taskId: c2.taskSummary.taskId,
          receipt: completedReceipt(
            {
              taskId: c2.taskSummary.taskId,
              deviceId: DEVICE_A,
              snapshotId: t2.snapshotId,
              manifestDigest: t2.manifestDigest,
              relativeTarget: t2.relativeTarget,
              totalBytes: t2.totalBytes,
              fileCount: t2.fileCount,
            },
            { contentSha256: null, structureFingerprint: null },
          ),
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );
  });
});

// ── 9. acceptCleanup ───────────────────────────────────────────────

describe('acceptCleanup', () => {
  it('completed path → cleaned keeps receipt; cancel path → cancelled never cleaned', async () => {
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
    });
    const created = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    const taskId = created.taskSummary.taskId;
    await store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });
    const task = await store.readTaskImmutable(DEVICE_A, taskId);
    await store.acceptReceipt({
      deviceId: DEVICE_A,
      taskId,
      receipt: completedReceipt({
        taskId,
        deviceId: DEVICE_A,
        snapshotId: task.snapshotId,
        manifestDigest: task.manifestDigest,
        relativeTarget: task.relativeTarget,
        totalBytes: task.totalBytes,
        fileCount: task.fileCount,
      }),
    });
    const receiptBefore = (await readJson(statusJsonAbs(DEVICE_A, taskId))).receipt;

    clock.advanceMs(1000);
    const cleanupAck = await store.acceptCleanup({
      deviceId: DEVICE_A,
      taskId,
      cleanupReceipt: cleanupCompleted({ taskId, deviceId: DEVICE_A }),
    });
    assert.equal(cleanupAck.ok, true);
    assert.equal(cleanupAck.taskId, taskId);
    assert.equal(cleanupAck.status, 'cleaned');
    assert.equal(cleanupAck.cleanupId, CLEANUP_ID);
    assert.equal(cleanupAck.cleanupAckAt, clock.iso());
    const statusCleaned = await readJson(statusJsonAbs(DEVICE_A, taskId));
    assert.equal(statusCleaned.status, 'cleaned');
    assert.deepEqual(statusCleaned.receipt, receiptBefore);
    assert.ok(statusCleaned.cleanupReceipt);

    // Idempotent same cleanup
    const cleanupAck2 = await store.acceptCleanup({
      deviceId: DEVICE_A,
      taskId,
      cleanupReceipt: cleanupCompleted({ taskId, deviceId: DEVICE_A }),
    });
    assert.equal(cleanupAck2.status, 'cleaned');
    assert.equal(cleanupAck2.cleanupId, CLEANUP_ID);

    // Conflict different cleanupId
    await expectCode(
      () =>
        store.acceptCleanup({
          deviceId: DEVICE_A,
          taskId,
          cleanupReceipt: cleanupCompleted(
            {
              taskId,
              deviceId: DEVICE_A,
            },
            { cleanupId: CLEANUP_ID_2 },
          ),
        }),
      ERROR_CODES.RESTORE_TASK_CONFLICT,
      { statusCode: 409 },
    );

    // Cancel path: active + cancelRequested + cancelled cleanup
    const c2 = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_B,
      relativeTarget: TARGET_B,
    });
    const taskId2 = c2.taskSummary.taskId;
    await store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });
    await store.cancel({ deviceId: DEVICE_A, taskId: taskId2 });
    clock.advanceMs(500);
    const cancelCleanup = await store.acceptCleanup({
      deviceId: DEVICE_A,
      taskId: taskId2,
      cleanupReceipt: cleanupCancelled({ taskId: taskId2, deviceId: DEVICE_A }),
    });
    assert.equal(cancelCleanup.status, 'cancelled');
    assert.notEqual(cancelCleanup.status, 'cleaned');
    assert.notEqual(cancelCleanup.cleanupAckAt, null);
    const statusCancel = await readJson(statusJsonAbs(DEVICE_A, taskId2));
    assert.equal(statusCancel.status, 'cancelled');
    assert.equal(statusCancel.receipt, null);
    assert.notEqual(statusCancel.cleanupAckAt, null);

    // Illegal: cancelled cleanup without cancelRequested
    const c3 = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: 'docs/third-target',
    });
    await store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });
    await expectCode(
      () =>
        store.acceptCleanup({
          deviceId: DEVICE_A,
          taskId: c3.taskSummary.taskId,
          cleanupReceipt: cleanupCancelled({
            taskId: c3.taskSummary.taskId,
            deviceId: DEVICE_A,
          }),
        }),
      ERROR_CODES.RESTORE_TASK_CONFLICT,
      { statusCode: 409 },
    );

    // Illegal outcome/receiptId pairing
    await expectCode(
      () =>
        store.acceptCleanup({
          deviceId: DEVICE_A,
          taskId: c3.taskSummary.taskId,
          cleanupReceipt: cleanupCancelled(
            {
              taskId: c3.taskSummary.taskId,
              deviceId: DEVICE_A,
            },
            { receiptId: RECEIPT_ID },
          ),
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );
  });
});

// ── 10. updateProgress ─────────────────────────────────────────────

describe('updateProgress', () => {
  it('only active; validates ranges; monotonic; persists lastProgress; returns cancelRequested', async () => {
    const readable = makeReadable({
      files: [
        { path: 'a.txt', size: 0, sha256: ZERO_SHA },
        { path: 'b.bin', size: CHUNK + 1, sha256: SHA_B },
      ],
    });
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(readable),
    });
    const created = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    const taskId = created.taskSummary.taskId;

    // pending → invalid
    await expectCode(
      () =>
        store.updateProgress({
          deviceId: DEVICE_A,
          taskId,
          fileIndex: 1,
          chunkIndex: 0,
          receivedBytes: 1,
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );

    await store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });

    // empty file (chunkCount 0) rejects any chunk
    await expectCode(
      () =>
        store.updateProgress({
          deviceId: DEVICE_A,
          taskId,
          fileIndex: 0,
          chunkIndex: 0,
          receivedBytes: 0,
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );

    // valid first progress on fileIndex 1
    clock.advanceMs(100);
    const p1 = await store.updateProgress({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 1,
      chunkIndex: 0,
      receivedBytes: 100,
    });
    assert.equal(p1.ok, true);
    assert.equal(p1.cancelRequested, false);

    let status = await readJson(statusJsonAbs(DEVICE_A, taskId));
    assert.ok(status.lastProgress);
    assert.equal(status.lastProgress.fileIndex, 1);
    assert.equal(status.lastProgress.chunkIndex, 0);
    assert.equal(status.lastProgress.receivedBytes, 100);

    // advance chunk
    clock.advanceMs(100);
    await store.updateProgress({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 1,
      chunkIndex: 1,
      receivedBytes: CHUNK + 1,
    });

    // receivedBytes regression
    await expectCode(
      () =>
        store.updateProgress({
          deviceId: DEVICE_A,
          taskId,
          fileIndex: 1,
          chunkIndex: 1,
          receivedBytes: CHUNK,
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );

    // file/chunk regression
    await expectCode(
      () =>
        store.updateProgress({
          deviceId: DEVICE_A,
          taskId,
          fileIndex: 1,
          chunkIndex: 0,
          receivedBytes: CHUNK + 1,
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );

    // cancelRequested reflected
    await store.cancel({ deviceId: DEVICE_A, taskId });
    const pCancel = await store.updateProgress({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 1,
      chunkIndex: 1,
      receivedBytes: CHUNK + 1,
    });
    assert.equal(pCancel.ok, true);
    assert.equal(pCancel.cancelRequested, true);

    // out of range fileIndex
    await expectCode(
      () =>
        store.updateProgress({
          deviceId: DEVICE_A,
          taskId,
          fileIndex: 99,
          chunkIndex: 0,
          receivedBytes: CHUNK + 2,
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );

    // non safe-int
    await expectCode(
      () =>
        store.updateProgress({
          deviceId: DEVICE_A,
          taskId,
          fileIndex: 1.5,
          chunkIndex: 0,
          receivedBytes: 0,
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );
  });
});

// ── 11. listAdmissionNonterminal + hasActiveRestore ────────────────

describe('listAdmissionNonterminal + hasActiveRestore', () => {
  it('only pending/active; stable frozen order; cross-device isolation', async () => {
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
    });

    assert.equal(await store.hasActiveRestore(DEVICE_A), false);
    assert.deepEqual(await store.listAdmissionNonterminal(DEVICE_A), []);

    const c1 = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    assert.equal(await store.hasActiveRestore(DEVICE_A), true);
    const list1 = await store.listAdmissionNonterminal(DEVICE_A);
    assert.deepEqual(list1, [c1.taskSummary.taskId]);
    assertDeepFrozen(list1);

    await store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });
    assert.equal(await store.hasActiveRestore(DEVICE_A), true);
    assert.deepEqual(await store.listAdmissionNonterminal(DEVICE_A), [
      c1.taskSummary.taskId,
    ]);

    // Device B isolated
    assert.equal(await store.hasActiveRestore(DEVICE_B), false);
    assert.deepEqual(await store.listAdmissionNonterminal(DEVICE_B), []);

    // Terminal excludes
    await store.cancel({ deviceId: DEVICE_A, taskId: c1.taskSummary.taskId });
    // active+cancel still nonterminal until cleanup cancelled
    assert.equal(await store.hasActiveRestore(DEVICE_A), true);
    await store.acceptCleanup({
      deviceId: DEVICE_A,
      taskId: c1.taskSummary.taskId,
      cleanupReceipt: cleanupCancelled({
        taskId: c1.taskSummary.taskId,
        deviceId: DEVICE_A,
      }),
    });
    assert.equal(await store.hasActiveRestore(DEVICE_A), false);
    assert.deepEqual(await store.listAdmissionNonterminal(DEVICE_A), []);
  });
});

// ── 12. create error mapping ───────────────────────────────────────

describe('create error mapping', () => {
  it('maps reader integrity-failed, path-invalid, oversized task JSON, schema-invalid', async () => {
    const integrityStore = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable(), {
        throwError: new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED),
      }),
    });
    await expectCode(
      () =>
        integrityStore.create({
          deviceId: DEVICE_A,
          snapshotId: SNAPSHOT_A,
          relativeTarget: TARGET_A,
        }),
      ERROR_CODES.RESTORE_INTEGRITY_FAILED,
      { statusCode: 422 },
    );

    const pathStore = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
    });
    await expectCode(
      () =>
        pathStore.create({
          deviceId: DEVICE_A,
          snapshotId: SNAPSHOT_A,
          relativeTarget: '../escape',
        }),
      ERROR_CODES.RESTORE_PATH_INVALID,
      { statusCode: 400, leakTokens: ['../escape'] },
    );
    await expectCode(
      () =>
        pathStore.create({
          deviceId: DEVICE_A,
          snapshotId: SNAPSHOT_A,
          relativeTarget: '/abs/path',
        }),
      ERROR_CODES.RESTORE_PATH_INVALID,
      { statusCode: 400, leakTokens: ['/abs/path'] },
    );

    // Oversized estimated GET task JSON (> 1 MiB) including files[].path
    const longPath = `p/${'x'.repeat(900)}.txt`;
    const manyFiles = [];
    // Enough entries that path-bearing payload exceeds cap.
    // Denominator matches pre-assert so n is guaranteed large enough.
    const n = Math.ceil((MAX_RESTORE_TASK_JSON_BYTES + 64_000) / (longPath.length + 20));
    for (let i = 0; i < n; i += 1) {
      manyFiles.push({
        path: `${longPath}.${i}`,
        size: 1,
        sha256: SHA_B,
      });
    }
    assert.ok(n * (longPath.length + 20) > MAX_RESTORE_TASK_JSON_BYTES);
    const hugeStore = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(
        makeReadable({
          manifestDigest: DIGEST_B,
          files: manyFiles,
        }),
      ),
    });
    await expectCode(
      () =>
        hugeStore.create({
          deviceId: DEVICE_A,
          snapshotId: SNAPSHOT_A,
          relativeTarget: TARGET_A,
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );

    // Illegal create input (store-direct interface)
    await expectCode(
      () =>
        pathStore.create({
          deviceId: DEVICE_A,
          snapshotId: 'not-uuid',
          relativeTarget: TARGET_A,
        }),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );
    await expectCode(
      () =>
        pathStore.create(
          /** @type {any} */ ({
            deviceId: DEVICE_A,
            snapshotId: SNAPSHOT_A,
            relativeTarget: TARGET_A,
            extra: true,
          }),
        ),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );
  });
});

// ── 13. layout + safe modes + symlink fail-close ───────────────────

describe('layout permissions and hostile filesystem', () => {
  it('writes under repo/devices/<slug>/restore-tasks/<taskId> with 0700/0600', async () => {
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
    });
    const created = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    await assertLayoutAndModes(DEVICE_A, created.taskSummary.taskId);

    // Only TASK.json + STATUS.json required siblings (no absolute path fields inside)
    const entries = await readdir(taskDirAbs(DEVICE_A, created.taskSummary.taskId));
    assert.ok(entries.includes('TASK.json'));
    assert.ok(entries.includes('STATUS.json'));
    const taskText = await readFile(
      taskJsonAbs(DEVICE_A, created.taskSummary.taskId),
      'utf8',
    );
    assert.ok(!taskText.includes(/** @type {string} */ (dataDir)));
    assert.ok(!taskText.includes('restoreRoot'));
  });

  it('STATUS symlink / type swap / TASK replace mid-flight → restore-state-invalid', async () => {
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
    });
    const created = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    const taskId = created.taskSummary.taskId;
    const statusAbs = statusJsonAbs(DEVICE_A, taskId);
    const original = await readFile(statusAbs, 'utf8');

    await rm(statusAbs, { force: true });
    const outside = join(/** @type {string} */ (dataDir), 'outside-status.json');
    await writeFile(outside, original, 'utf8');
    await symlink(outside, statusAbs);
    await expectCode(
      () => store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false }),
      ERROR_CODES.RESTORE_STATE_INVALID,
      { statusCode: 500, leakTokens: [outside, statusAbs] },
    );

    await rm(statusAbs, { force: true });
    await mkdir(statusAbs);
    await expectCode(
      () => store.get({ deviceId: DEVICE_A, taskId }),
      ERROR_CODES.RESTORE_STATE_INVALID,
      { statusCode: 500 },
    );
  });
});

// ── 14. hostile inputs + concurrency ───────────────────────────────

describe('hostile inputs and concurrency', () => {
  it('rejects Proxy/class/getter bags without executing getters', async () => {
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
    });

    let hits = 0;
    const proxyInput = new Proxy(
      {
        deviceId: DEVICE_A,
        snapshotId: SNAPSHOT_A,
        relativeTarget: TARGET_A,
      },
      {
        get(target, prop, receiver) {
          hits += 1;
          if (prop === 'PROXY_SENTINEL') return 'x';
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    await expectCode(
      () => store.create(/** @type {any} */ (proxyInput)),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );
    assert.equal(hits, 0);

    class CreateBag {
      constructor() {
        this.deviceId = DEVICE_A;
        this.snapshotId = SNAPSHOT_A;
        this.relativeTarget = TARGET_A;
      }
    }
    await expectCode(
      () => store.create(/** @type {any} */ (new CreateBag())),
      ERROR_CODES.RESTORE_TASK_INVALID,
      { statusCode: 400 },
    );
  });

  it('concurrent same-identity create preserves one-active and single taskId', async () => {
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(makeReadable()),
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.create({
          deviceId: DEVICE_A,
          snapshotId: SNAPSHOT_A,
          relativeTarget: TARGET_A,
        }),
      ),
    );
    const taskIds = new Set(results.map((r) => r.taskSummary.taskId));
    assert.equal(taskIds.size, 1);
    const hints = results.map((r) => r.httpHint).sort();
    assert.ok(hints.includes(201));
    assert.ok(hints.every((h) => h === 200 || h === 201));
    assert.equal(await store.hasActiveRestore(DEVICE_A), true);
    assert.equal((await store.listAdmissionNonterminal(DEVICE_A)).length, 1);
  });

  it('concurrent progress does not allow receivedBytes regression', async () => {
    const store = openStore({
      dataDir: /** @type {string} */ (dataDir),
      storageReader: makeStorageReader(
        makeReadable({
          files: [{ path: 'b.bin', size: CHUNK * 2, sha256: SHA_B }],
        }),
      ),
    });
    const created = await store.create({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: TARGET_A,
    });
    const taskId = created.taskSummary.taskId;
    await store.claimNext({ deviceId: DEVICE_A, hasActiveUpload: false });

    await store.updateProgress({
      deviceId: DEVICE_A,
      taskId,
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 1000,
    });

    const outcomes = await Promise.allSettled(
      [500, 2000, 1500, 3000, 100].map((bytes) =>
        store.updateProgress({
          deviceId: DEVICE_A,
          taskId,
          fileIndex: 0,
          chunkIndex: 0,
          receivedBytes: bytes,
        }),
      ),
    );
    const status = await readJson(statusJsonAbs(DEVICE_A, taskId));
    assert.ok(status.lastProgress);
    assert.ok(status.lastProgress.receivedBytes >= 1000);
    // At least one regression attempt must fail
    assert.ok(outcomes.some((o) => o.status === 'rejected'));
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        assertLinkeCode(o.reason, ERROR_CODES.RESTORE_TASK_INVALID, {
          statusCode: 400,
        });
      }
    }
  });
});
