/**
 * C5 RED — Shared live-binary slots + bidirectional upload/restore admission.
 * Table-driven scenarios A–H (plan C5 Step 5 / design 附录 D).
 *
 * A slots full: upload create/status/finalize/abort never upload-backpressure
 * B slots full: upload putChunk → upload-backpressure
 * C slots full: restore claim/task/progress/receipt/cleanup never restore-backpressure
 * D slots full: restore getChunk → restore-backpressure
 * E same device active restore: upload create → upload-session-conflict
 * F same device active upload: restore claim → restore-task-conflict
 * G same device concurrent upload create vs restore claim under shared runDevice:
 *     exactly one succeeds, other conflict; no TOCTOU
 * H different devices: upload create + restore claim both succeed; global slots
 *     only govern binary calls
 *
 * No public restore route in C5. Pure domain fixtures.
 * Expected RED: missing restore-service; upload create/finalize still consume
 * runTransfer; missing findActiveRestore.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';
import {
  createUploadSessionStore,
} from '../src/upload-session-store.js';
import {
  parseChunkHeaders,
  ingestChunkBody,
  commitChunk,
} from '../src/upload-chunk-ingest.js';
import {
  preflightCapacity,
  verifyAndCommitSession,
} from '../src/upload-commit.js';
import { createUploadLocks } from '../src/upload-locks.js';
import { createUploadService } from '../src/upload-service.js';
import { createRestoreService } from '../src/restore-service.js';

const DEVICE_A = 'device-alpha-001';
const DEVICE_B = 'device-beta-002';
const SNAPSHOT_A = '550e8400-e29b-41d4-a716-446655440000';
const SNAPSHOT_B = '550e8400-e29b-41d4-a716-446655440001';
const TASK_A = 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000aa';
const T0 = '2026-07-23T12:00:00.000Z';
const TOKEN = 'test-device-token-not-a-secret-fixture';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
  };
}

function deferred() {
  /** @type {(v?: unknown) => void} */
  let resolve = () => {};
  /** @type {(e?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, label, maxTurns = 20_000) {
  for (let i = 0; i < maxTurns; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
  }
  assert.fail(`barrier timeout: ${label}`);
}

/**
 * @param {unknown} error
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
function assertLinkeCode(error, code, opts = {}) {
  assert.ok(error instanceof LinkeError, 'must be LinkeError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  if (opts.statusCode !== undefined) assert.equal(error.statusCode, opts.statusCode);
  if (opts.retryable !== undefined) assert.equal(error.retryable, opts.retryable);
  const ownText = [
    error.code,
    error.message,
    error.name,
    String(error.statusCode),
    String(error.retryable),
    error.details ? JSON.stringify(error.details) : '',
  ].join('\0');
  for (const token of opts.leakTokens ?? []) {
    if (!token || token.length < 2) continue;
    assert.ok(!ownText.includes(token), `must not leak ${token}`);
  }
}

function mockStatfsPlenty() {
  return async () => ({
    type: 0,
    bsize: 4096,
    blocks: 1e12,
    bfree: 1e12,
    bavail: 1e12,
    files: 0,
    ffree: 0,
  });
}

/**
 * @param {{
 *   deviceId?: string,
 *   snapshotId?: string,
 *   files?: { path: string, size: number, content?: string | Buffer }[],
 * }} [opts]
 */
function makeProjection(opts = {}) {
  const deviceId = opts.deviceId ?? DEVICE_A;
  const snapshotId = opts.snapshotId ?? SNAPSHOT_A;
  const files = opts.files ?? [{ path: 'a.txt', size: 0 }];
  const entries = files.map((f) => {
    let content;
    if (f.content !== undefined) {
      content = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    } else if (f.size === 0) {
      content = Buffer.alloc(0);
    } else {
      content = Buffer.alloc(f.size, 0x61);
    }
    assert.equal(content.length, f.size);
    const sha256 =
      f.size === 0 ? ZERO_SHA : createHash('sha256').update(content).digest('hex');
    return { path: f.path, size: f.size, sha256, content };
  });
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  const input = {
    schemaVersion: 2,
    snapshotId,
    deviceId,
    createdAt: T0,
    files: entries.map((e) => e.path),
    integrity: {
      algorithm: 'sha256',
      totalBytes,
      entries: entries.map((e) => ({ path: e.path, size: e.size, sha256: e.sha256 })),
    },
  };
  const { manifest, manifestDigest } = projectCanonicalUploadManifest(input, {
    authenticatedDeviceId: deviceId,
  });
  return { manifest, manifestDigest, entries, totalBytes, deviceId, snapshotId };
}

function makeChunkRequest(opts) {
  const uploadId = opts.uploadId;
  const content = opts.content;
  const size = content.length;
  const sha256 = createHash('sha256').update(content).digest('hex');
  const pairs = [
    ['Authorization', `Bearer ${TOKEN}`],
    ['X-Linke-Device-Id', opts.deviceId ?? DEVICE_A],
    ['X-Linke-Protocol-Version', '2'],
    ['Content-Length', String(size)],
    ['X-Linke-Upload-Id', uploadId],
    ['X-Linke-Snapshot-Id', opts.snapshotId ?? SNAPSHOT_A],
    ['X-Linke-Manifest-Digest', opts.manifestDigest],
    ['X-Linke-File-Index', String(opts.fileIndex ?? 0)],
    ['X-Linke-Chunk-Index', String(opts.chunkIndex ?? 0)],
    ['X-Linke-Chunk-Offset', String(opts.offset ?? 0)],
    ['X-Linke-Chunk-Size', String(size)],
    ['X-Linke-Chunk-Sha256', opts.sha256 ?? sha256],
  ];
  /** @type {string[]} */
  const rawHeaders = [];
  for (const [k, v] of pairs) rawHeaders.push(k, v);
  return {
    request: {
      rawHeaders,
      url: `/agent/upload/sessions/${uploadId}/chunks`,
      method: 'POST',
    },
    stream: Readable.from([content]),
  };
}

/**
 * Hold N global transfer slots until release().
 * @param {ReturnType<typeof createUploadLocks>} locks
 * @param {number} n
 */
async function holdGlobalSlots(locks, n) {
  /** @type {ReturnType<typeof deferred>[]} */
  const gates = [];
  /** @type {Promise<unknown>[]} */
  const held = [];
  let started = 0;
  for (let i = 0; i < n; i += 1) {
    const g = deferred();
    gates.push(g);
    held.push(
      locks.runTransfer(async () => {
        started += 1;
        await g.promise;
      }),
    );
  }
  await waitUntil(() => started === n, `${n} slots held`);
  return {
    release: async () => {
      for (const g of gates) g.resolve();
      await Promise.all(held);
    },
  };
}

function isBackpressure(err, code) {
  return (
    err instanceof LinkeError
    && err.code === code
    && err.statusCode === 429
    && err.retryable === true
  );
}

/**
 * Shared fixture: real upload service + mock restore service deps, shared locks.
 */
function makePair(overrides = {}) {
  const locks = overrides.locks ?? createUploadLocks({ maxGlobalTransfers: 4 });
  const uploadStore = createUploadSessionStore({
    dataDir,
    now: () => clock.now(),
    randomUUID: () => uuidSeq.next(),
  });
  const commit = {
    preflightCapacity: (dir, totalBytes, options = {}) =>
      preflightCapacity(dir, totalBytes, {
        ...options,
        deps: { ...(options.deps || {}), statfs: options.deps?.statfs ?? mockStatfsPlenty() },
      }),
    verifyAndCommitSession: async (input) => {
      // Mark committed for finalize success without full byte verify when empty files.
      const session = await uploadStore.getSession({
        authenticatedDeviceId: input.deviceId,
        uploadId: input.uploadId,
      });
      if (session.status !== 'committed') {
        await uploadStore.markVerifying({
          authenticatedDeviceId: input.deviceId,
          uploadId: input.uploadId,
        });
        await uploadStore.markCommitted({
          authenticatedDeviceId: input.deviceId,
          uploadId: input.uploadId,
        });
      }
    },
  };

  /** @type {boolean} */
  let activeRestore = overrides.activeRestore ?? false;
  /** @type {boolean} */
  let activeUploadProbe = overrides.activeUpload ?? false;

  /** @type {Record<string, unknown>} */
  const uploadOpts = {
    dataDir,
    store: uploadStore,
    locks,
    ingest: { parseChunkHeaders, ingestChunkBody, commitChunk },
    commit,
    now: () => clock.now(),
  };
  if (Object.prototype.hasOwnProperty.call(overrides, 'findActiveRestore')) {
    uploadOpts.findActiveRestore = overrides.findActiveRestore;
  } else {
    uploadOpts.findActiveRestore = async () => activeRestore;
  }

  const upload = createUploadService(/** @type {any} */ (uploadOpts));

  /** @type {object | null} */
  let pendingTask = overrides.pendingTask ?? {
    taskId: TASK_A,
    snapshotId: SNAPSHOT_A,
    status: 'pending',
  };
  /** @type {object | null} */
  let claimedTask = null;

  const taskStore = {
    claimNext: async (input) => {
      assert.equal(input.hasActiveUpload, false);
      if (pendingTask == null) return { task: null };
      claimedTask = {
        ...pendingTask,
        status: 'active',
        claimedAt: T0,
        deviceId: input.deviceId,
      };
      pendingTask = null;
      return { task: claimedTask };
    },
    get: async (input) => ({
      taskId: input.taskId,
      deviceId: input.deviceId,
      status: claimedTask?.status ?? 'active',
      cancelRequested: false,
      cleanupAuthorized: false,
      files: [{ fileIndex: 0, path: 'a.txt', size: 0, sha256: ZERO_SHA, chunkCount: 0 }],
    }),
    updateProgress: async () => ({ ok: true, cancelRequested: false }),
    acceptReceipt: async (input) => ({
      ok: true,
      taskId: input.taskId,
      status: 'completed',
      cleanupAuthorized: true,
      receiptId: '550e8400-e29b-41d4-a716-446655440021',
    }),
    acceptCleanup: async (input) => ({
      ok: true,
      taskId: input.taskId,
      status: 'cleaned',
      cleanupId: '550e8400-e29b-41d4-a716-446655440031',
      cleanupAckAt: T0,
    }),
    create: async (input) => ({
      httpHint: 201,
      taskSummary: {
        taskId: TASK_A,
        deviceId: input.deviceId,
        snapshotId: input.snapshotId,
        relativeTarget: input.relativeTarget,
        status: 'pending',
      },
    }),
    cancel: async () => ({ httpHint: 200, status: 'cancelled', cancelRequested: true }),
    hasActiveRestore: async () => activeRestore || claimedTask != null || pendingTask != null,
    buildTaskFilesPayload: async () => ({
      files: [{ fileIndex: 0, path: 'a.txt', size: 0, sha256: ZERO_SHA, chunkCount: 0 }],
    }),
  };

  const storageReader = {
    readChunk: async () => {
      const body = Buffer.from('bin');
      return {
        body,
        chunkOffset: 0,
        chunkSize: body.length,
        chunkSha256: createHash('sha256').update(body).digest('hex'),
      };
    },
  };

  const findActiveUpload =
    overrides.findActiveUpload
    ?? (async (deviceId) => {
      if (activeUploadProbe) return true;
      const active = await uploadStore.findActiveSession(deviceId);
      return active != null;
    });

  const restore = createRestoreService({
    taskStore,
    locks,
    storageReader,
    now: () => clock.now(),
    findActiveUpload,
  });

  return {
    locks,
    upload,
    restore,
    uploadStore,
    setActiveRestore: (v) => {
      activeRestore = v;
    },
    setActiveUploadProbe: (v) => {
      activeUploadProbe = v;
    },
    setPendingTask: (t) => {
      pendingTask = t;
    },
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'linke-c5-admission-'));
  clock = createClock(T0);
  uuidSeq = createUuidSeq();
});

afterEach(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

// ── Table A–H ───────────────────────────────────────────────────────

describe('restore-upload admission table A–H', () => {
  it('A: slots full → upload create/status/finalize/abort never upload-backpressure', async () => {
    const { locks, upload } = makePair();
    const proj = makeProjection({
      files: [{ path: 'a.bin', size: 0 }],
    });
    // Bootstrap session for status/finalize/abort while free.
    const created = await upload.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    const held = await holdGlobalSlots(locks, 4);

    // create on other device while full
    const projB = makeProjection({
      deviceId: DEVICE_B,
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'b.txt', size: 0 }],
    });
    const createdB = await upload.create({
      authenticatedDeviceId: DEVICE_B,
      manifest: projB.manifest,
      claimedManifestDigest: projB.manifestDigest,
    });
    assert.equal(createdB.status, 'initialized');

    const st = await upload.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(st.uploadId, created.uploadId);

    const fin = await upload.finalize({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(fin.status, 'committed');

    const ab = await upload.abort({
      authenticatedDeviceId: DEVICE_B,
      uploadId: createdB.uploadId,
    });
    assert.equal(ab.status, 'aborted');

    await held.release();
  });

  it('B: slots full → upload putChunk → upload-backpressure', async () => {
    const { locks, upload } = makePair();
    const content = Buffer.from('bb');
    const proj = makeProjection({
      files: [{ path: 'b.bin', size: content.length, content }],
    });
    const created = await upload.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    const held = await holdGlobalSlots(locks, 4);
    const chunk = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content,
    });
    await assert.rejects(
      () =>
        upload.putChunk({
          authenticatedDeviceId: DEVICE_A,
          request: chunk.request,
          stream: chunk.stream,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
          leakTokens: [dataDir, TOKEN],
        });
        return true;
      },
    );
    await held.release();
  });

  it('C: slots full → restore claim/task/progress/receipt/cleanup never restore-backpressure', async () => {
    const { locks, restore } = makePair();
    const held = await holdGlobalSlots(locks, 4);

    const claimed = await restore.claim({ deviceId: DEVICE_A });
    assert.ok(claimed.task);
    assert.equal(claimed.task.taskId, TASK_A);

    const task = await restore.getTask({ deviceId: DEVICE_A, taskId: TASK_A });
    assert.equal(task.taskId, TASK_A);

    const prog = await restore.updateProgress({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 0,
    });
    assert.equal(prog.ok, true);

    const receipt = await restore.acceptReceipt({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      receipt: { schemaVersion: 1 },
    });
    assert.equal(receipt.ok, true);

    const cleanup = await restore.acceptCleanup({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      cleanupReceipt: { schemaVersion: 1 },
    });
    assert.equal(cleanup.ok, true);

    // None of the above may surface restore-backpressure.
    for (const result of [claimed, task, prog, receipt, cleanup]) {
      assert.ok(result);
      assert.notEqual(result?.code, ERROR_CODES.RESTORE_BACKPRESSURE);
    }

    await held.release();
  });

  it('D: slots full → restore getChunk → restore-backpressure', async () => {
    const { locks, restore } = makePair();
    const held = await holdGlobalSlots(locks, 4);
    await assert.rejects(
      () =>
        restore.getChunk({
          deviceId: DEVICE_A,
          taskId: TASK_A,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.RESTORE_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
          leakTokens: [dataDir, TOKEN, 'upload-backpressure'],
        });
        return true;
      },
    );
    await held.release();
  });

  it('E: same device active restore → upload create → upload-session-conflict', async () => {
    const { upload } = makePair({ activeRestore: true });
    const proj = makeProjection({ files: [{ path: 'e.txt', size: 0 }] });
    await assert.rejects(
      () =>
        upload.create({
          authenticatedDeviceId: DEVICE_A,
          manifest: proj.manifest,
          claimedManifestDigest: proj.manifestDigest,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_SESSION_CONFLICT, {
          statusCode: 409,
          retryable: false,
          leakTokens: [dataDir, TOKEN],
        });
        return true;
      },
    );
  });

  it('F: same device active upload → restore claim → restore-task-conflict', async () => {
    const { upload, restore } = makePair();
    const proj = makeProjection({ files: [{ path: 'f.txt', size: 0 }] });
    await upload.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    await assert.rejects(
      () => restore.claim({ deviceId: DEVICE_A }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.RESTORE_TASK_CONFLICT, {
          statusCode: 409,
          retryable: false,
          leakTokens: [dataDir, TOKEN],
        });
        return true;
      },
    );
  });

  it('G: same device concurrent upload create vs restore claim — exactly one wins; no TOCTOU', async () => {
    // Shared runDevice: hold the device critical section mid-flight so both
    // operations serialize; exactly one admission succeeds.
    const baseLocks = createUploadLocks({ maxGlobalTransfers: 4 });
    const deviceGate = deferred();
    const firstEntered = deferred();
    let deviceEntries = 0;
    /** @type {string[]} */
    const order = [];

    const locks = {
      maxGlobalTransfers: baseLocks.maxGlobalTransfers,
      runTransfer: (fn) => baseLocks.runTransfer(fn),
      runDevice: async (id, fn) => {
        return baseLocks.runDevice(id, async () => {
          deviceEntries += 1;
          const entry = deviceEntries;
          order.push(`enter-${entry}`);
          if (entry === 1) {
            firstEntered.resolve();
            await deviceGate.promise;
          }
          try {
            const result = await fn();
            order.push(`ok-${entry}`);
            return result;
          } catch (err) {
            order.push(`err-${entry}`);
            throw err;
          }
        });
      },
      runSession: (d, u, fn) => baseLocks.runSession(d, u, fn),
      runSnapshot: (d, s, fn) => baseLocks.runSnapshot(d, s, fn),
    };

    // findActiveRestore / findActiveUpload share mutable peer state observed
    // only inside the critical section (production TOCTOU-safe pattern).
    let uploadActive = false;
    let restoreActive = false;

    const pair = makePair({
      locks,
      findActiveRestore: async () => restoreActive,
      findActiveUpload: async () => uploadActive,
    });

    // Wire post-success side effects inside real service is GREEN's job;
    // for RED admission race we use probes that flip only after the critical
    // section work would have mutated — approximate with store observation +
    // probe that re-reads peer flags set by the first winner via hooks below.
    //
    // Instrument: first to pass probe claims the device flag.
    let restoreProbeCount = 0;
    let uploadProbeCount = 0;
    const upload = createUploadService({
      dataDir,
      store: pair.uploadStore,
      locks,
      ingest: { parseChunkHeaders, ingestChunkBody, commitChunk },
      commit: {
        preflightCapacity: (dir, totalBytes, options = {}) =>
          preflightCapacity(dir, totalBytes, {
            ...options,
            deps: { ...(options.deps || {}), statfs: mockStatfsPlenty() },
          }),
        verifyAndCommitSession,
      },
      now: () => clock.now(),
      findActiveRestore: async () => {
        uploadProbeCount += 1;
        if (restoreActive) return true;
        // Admit and mark upload active before createSession (same critical section).
        uploadActive = true;
        return false;
      },
    });

    // Re-create restore with same shared flags.
    const restore = createRestoreService({
      taskStore: {
        claimNext: async (input) => {
          assert.equal(input.hasActiveUpload, false);
          restoreActive = true;
          return {
            task: {
              taskId: TASK_A,
              status: 'active',
              deviceId: input.deviceId,
              claimedAt: T0,
            },
          };
        },
        get: async () => ({ taskId: TASK_A, status: 'active' }),
        updateProgress: async () => ({ ok: true, cancelRequested: false }),
        acceptReceipt: async () => ({
          ok: true,
          taskId: TASK_A,
          status: 'completed',
          cleanupAuthorized: true,
          receiptId: 'r',
        }),
        acceptCleanup: async () => ({
          ok: true,
          taskId: TASK_A,
          status: 'cleaned',
          cleanupId: 'c',
          cleanupAckAt: T0,
        }),
        create: async () => ({ httpHint: 201, taskSummary: { taskId: TASK_A } }),
        cancel: async () => ({ httpHint: 200, status: 'cancelled', cancelRequested: true }),
        hasActiveRestore: async () => restoreActive,
        buildTaskFilesPayload: async () => ({ files: [] }),
      },
      locks,
      storageReader: {
        readChunk: async () => ({
          body: Buffer.alloc(0),
          chunkOffset: 0,
          chunkSize: 0,
          chunkSha256: ZERO_SHA,
        }),
      },
      findActiveUpload: async () => {
        restoreProbeCount += 1;
        return uploadActive;
      },
    });

    const proj = makeProjection({ files: [{ path: 'race.txt', size: 0 }] });

    const uploadP = upload.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    await firstEntered.promise;

    const restoreP = restore.claim({ deviceId: DEVICE_A });
    // Ensure second is queued on same device key before releasing first.
    await waitUntil(() => true, 'yield for queue');
    await new Promise((r) => setImmediate(r));

    deviceGate.resolve();
    const results = await Promise.allSettled([uploadP, restoreP]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one admission succeeds');
    assert.equal(rejected.length, 1, 'exactly one admission conflicts');

    const err = /** @type {PromiseRejectedResult} */ (rejected[0]).reason;
    assert.ok(err instanceof LinkeError);
    assert.ok(
      err.code === ERROR_CODES.UPLOAD_SESSION_CONFLICT
        || err.code === ERROR_CODES.RESTORE_TASK_CONFLICT,
      `conflict code must be unique admission conflict, got ${err.code}`,
    );
    assert.equal(err.message, err.code);
    assert.equal(err.statusCode, 409);
    assert.equal(err.retryable, false);

    // Both probes ran inside serialized runDevice entries (no parallel admit).
    assert.equal(deviceEntries, 2);
    assert.ok(uploadProbeCount + restoreProbeCount >= 2);
    assert.ok(order.includes('enter-1') && order.includes('enter-2'));
  });

  it('H: different devices — upload create + restore claim both succeed; slots only for binary', async () => {
    const { locks, upload, restore } = makePair();
    const proj = makeProjection({
      deviceId: DEVICE_A,
      files: [{ path: 'h.txt', size: 0 }],
    });

    const [created, claimed] = await Promise.all([
      upload.create({
        authenticatedDeviceId: DEVICE_A,
        manifest: proj.manifest,
        claimedManifestDigest: proj.manifestDigest,
      }),
      restore.claim({ deviceId: DEVICE_B }),
    ]);
    assert.equal(created.status, 'initialized');
    assert.ok(claimed.task);
    assert.equal(claimed.task.deviceId ?? DEVICE_B, DEVICE_B);

    // Binary still governed by global slots.
    const held = await holdGlobalSlots(locks, 4);
    const content = Buffer.from('hh');
    // Need a session with bytes on DEVICE_A for putChunk.
    await upload.abort({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    const proj2 = makeProjection({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'h2.bin', size: content.length, content }],
    });
    const c2 = await upload.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj2.manifest,
      claimedManifestDigest: proj2.manifestDigest,
    });
    const chunk = makeChunkRequest({
      uploadId: c2.uploadId,
      manifestDigest: proj2.manifestDigest,
      content,
      snapshotId: SNAPSHOT_B,
    });
    await assert.rejects(
      () =>
        upload.putChunk({
          authenticatedDeviceId: DEVICE_A,
          request: chunk.request,
          stream: chunk.stream,
        }),
      (err) => isBackpressure(err, ERROR_CODES.UPLOAD_BACKPRESSURE),
    );
    await assert.rejects(
      () =>
        restore.getChunk({
          deviceId: DEVICE_B,
          taskId: TASK_A,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      (err) => isBackpressure(err, ERROR_CODES.RESTORE_BACKPRESSURE),
    );
    await held.release();
  });
});
