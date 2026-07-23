/**
 * C5 RED — Restore service orchestration (pure domain; no HTTP routes).
 * Targets public API of src/restore-service.js (not yet implemented).
 * Authority: design §12 / plan C5 + 附录 D.
 *
 * Frozen public surface:
 *   createRestoreService({
 *     taskStore, locks, storageReader, now?, findActiveUpload,
 *   }) → no HTTP
 *     claim / getTask / getChunk / updateProgress / acceptReceipt /
 *     acceptCleanup / createTask / cancelTask / getStatus / hasActiveRestore
 *
 * Slot ownership:
 *   getChunk alone uses locks.runTransfer; maps ONLY LinkeError(UPLOAD_BACKPRESSURE)
 *     → LinkeError(RESTORE_BACKPRESSURE); all other errors rethrow exact same object.
 *   claim/getTask/updateProgress/acceptReceipt/acceptCleanup/createTask/
 *     cancelTask/getStatus/hasActiveRestore do NOT call runTransfer.
 *
 * Admission:
 *   claim: ONE locks.runDevice; inside: findActiveUpload → conflict; else
 *     taskStore.claimNext({ deviceId, hasActiveUpload: false }).
 *   createTask: MUST NOT call findActiveUpload (pending restore may coexist
 *     with active upload).
 *
 * No public restore route in C5: createAgentListener without restoreService
 * → POST /agent/restore/tasks/claim remains 404 (this file only).
 *
 * Expected RED: ERR_MODULE_NOT_FOUND for restore-service.js until GREEN.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { createUploadLocks } from '../src/upload-locks.js';
import { createRestoreService } from '../src/restore-service.js';
import { createAgentListener } from '../src/agent-listener.js';
import { DeviceRegistry } from '../src/device-registry.js';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../src/tls-identity-store.js';

const DEVICE_A = 'device-alpha-001';
const DEVICE_B = 'device-beta-002';
const TASK_A = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const SNAPSHOT_A = '550e8400-e29b-41d4-a716-446655440010';
const T0 = '2026-07-23T12:00:00.000Z';
const TOKEN = 'test-device-token-not-a-secret-fixture';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const SERVICE_METHODS = Object.freeze([
  'acceptCleanup',
  'acceptReceipt',
  'cancelTask',
  'claim',
  'createTask',
  'getChunk',
  'getStatus',
  'getTask',
  'hasActiveRestore',
  'updateProgress',
]);

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

/**
 * Minimal taskStore mock with exact methods restore-service must delegate.
 */
function makeTaskStore(overrides = {}) {
  /** @type {Record<string, unknown>} */
  const calls = {
    claimNext: [],
    get: [],
    updateProgress: [],
    acceptReceipt: [],
    acceptCleanup: [],
    create: [],
    cancel: [],
    hasActiveRestore: [],
    buildTaskFilesPayload: [],
  };

  const store = {
    claimNext: async (input) => {
      calls.claimNext.push(input);
      if (overrides.claimNext) return overrides.claimNext(input);
      return { task: null };
    },
    get: async (input) => {
      calls.get.push(input);
      if (overrides.get) return overrides.get(input);
      return {
        taskId: input.taskId,
        deviceId: input.deviceId,
        status: 'active',
        cancelRequested: false,
        cleanupAuthorized: false,
      };
    },
    updateProgress: async (input) => {
      calls.updateProgress.push(input);
      if (overrides.updateProgress) return overrides.updateProgress(input);
      return { ok: true, cancelRequested: false };
    },
    acceptReceipt: async (input) => {
      calls.acceptReceipt.push(input);
      if (overrides.acceptReceipt) return overrides.acceptReceipt(input);
      return {
        ok: true,
        taskId: input.taskId,
        status: 'completed',
        cleanupAuthorized: true,
        receiptId: '550e8400-e29b-41d4-a716-446655440021',
      };
    },
    acceptCleanup: async (input) => {
      calls.acceptCleanup.push(input);
      if (overrides.acceptCleanup) return overrides.acceptCleanup(input);
      return {
        ok: true,
        taskId: input.taskId,
        status: 'cleaned',
        cleanupId: '550e8400-e29b-41d4-a716-446655440031',
        cleanupAckAt: T0,
      };
    },
    create: async (input) => {
      calls.create.push(input);
      if (overrides.create) return overrides.create(input);
      return {
        httpHint: 201,
        taskSummary: {
          taskId: TASK_A,
          deviceId: input.deviceId,
          snapshotId: input.snapshotId,
          relativeTarget: input.relativeTarget,
          status: 'pending',
        },
      };
    },
    cancel: async (input) => {
      calls.cancel.push(input);
      if (overrides.cancel) return overrides.cancel(input);
      return { httpHint: 200, status: 'cancelled', cancelRequested: true };
    },
    hasActiveRestore: async (deviceId) => {
      calls.hasActiveRestore.push(deviceId);
      if (overrides.hasActiveRestore) return overrides.hasActiveRestore(deviceId);
      return false;
    },
    buildTaskFilesPayload: async (deviceId, taskId) => {
      calls.buildTaskFilesPayload.push({ deviceId, taskId });
      if (overrides.buildTaskFilesPayload) {
        return overrides.buildTaskFilesPayload(deviceId, taskId);
      }
      return {
        files: [
          {
            fileIndex: 0,
            path: 'a.txt',
            size: 0,
            sha256: ZERO_SHA,
            chunkCount: 0,
          },
        ],
      };
    },
  };
  return { store, calls };
}

/**
 * storageReader mock for getChunk read+hash path.
 */
function makeStorageReader(overrides = {}) {
  /** @type {unknown[]} */
  const readCalls = [];
  const reader = {
    readChunk: async (input) => {
      readCalls.push(input);
      if (overrides.readChunk) return overrides.readChunk(input);
      const body = Buffer.from('chunk-body');
      return {
        body,
        chunkOffset: 0,
        chunkSize: body.length,
        chunkSha256: createHash('sha256').update(body).digest('hex'),
      };
    },
  };
  return { reader, readCalls };
}

/**
 * @param {ReturnType<typeof createUploadLocks>} base
 */
function spyLocks(base) {
  /** @type {{ transfer: number, device: number }} */
  const counts = { transfer: 0, device: 0 };
  /** @type {string[]} */
  const order = [];
  const locks = {
    maxGlobalTransfers: base.maxGlobalTransfers,
    runTransfer: async (fn) => {
      counts.transfer += 1;
      order.push('transfer');
      return base.runTransfer(fn);
    },
    runDevice: async (id, fn) => {
      counts.device += 1;
      order.push('device');
      return base.runDevice(id, async () => {
        order.push('device-critical');
        return fn();
      });
    },
    runSession: (d, u, fn) => base.runSession(d, u, fn),
    runSnapshot: (d, s, fn) => base.runSnapshot(d, s, fn),
  };
  return { locks, counts, order };
}

// ── A. Surface ──────────────────────────────────────────────────────

describe('A createRestoreService surface', () => {
  it('returns frozen object with exact restore methods; no HTTP surface', () => {
    const service = createRestoreService({
      taskStore: makeTaskStore().store,
      locks: createUploadLocks({ maxGlobalTransfers: 4 }),
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => false,
    });
    assert.ok(Object.isFrozen(service));
    const keys = Object.keys(service).sort();
    assert.deepEqual(keys, [...SERVICE_METHODS].sort());
    for (const m of SERVICE_METHODS) {
      assert.equal(typeof service[m], 'function');
    }
    for (const bad of ['listen', 'handle', 'router', 'taskStore', 'locks', '_store']) {
      assert.equal(Object.prototype.hasOwnProperty.call(service, bad), false);
    }
  });
});
// ── B. claim ────────────────────────────────────────────────────────

describe('B claim', () => {
  it('no pending → { task: null }; wraps findActiveUpload + claimNext in ONE runDevice', async () => {
    /** @type {string[]} */
    const order = [];
    const base = createUploadLocks({ maxGlobalTransfers: 4 });
    const locks = {
      maxGlobalTransfers: base.maxGlobalTransfers,
      runTransfer: async (fn) => {
        order.push('transfer');
        return base.runTransfer(fn);
      },
      runDevice: async (id, fn) => {
        order.push('device-enter');
        try {
          return await base.runDevice(id, async () => {
            order.push('device-in');
            return fn();
          });
        } finally {
          order.push('device-exit');
        }
      },
      runSession: (d, u, fn) => base.runSession(d, u, fn),
      runSnapshot: (d, s, fn) => base.runSnapshot(d, s, fn),
    };

    const { store, calls } = makeTaskStore({
      claimNext: async (input) => {
        order.push('claimNext');
        assert.deepEqual(input, { deviceId: DEVICE_A, hasActiveUpload: false });
        return { task: null };
      },
    });

    let findCalls = 0;
    const service = createRestoreService({
      taskStore: store,
      locks,
      storageReader: makeStorageReader().reader,
      findActiveUpload: async (deviceId) => {
        findCalls += 1;
        order.push('findActiveUpload');
        assert.equal(deviceId, DEVICE_A);
        assert.ok(order.includes('device-in'));
        assert.equal(order.includes('device-exit'), false);
        return false;
      },
    });

    const result = await service.claim({ deviceId: DEVICE_A });
    assert.deepEqual(result, { task: null });
    assert.equal(findCalls, 1);
    assert.equal(order.includes('transfer'), false);
    assert.equal(calls.claimNext.length, 1);

    const inIdx = order.indexOf('device-in');
    const findIdx = order.indexOf('findActiveUpload');
    const claimIdx = order.indexOf('claimNext');
    const exitIdx = order.indexOf('device-exit');
    assert.ok(findIdx > inIdx);
    assert.ok(claimIdx > findIdx);
    assert.ok(exitIdx > claimIdx);
  });

  it('findActiveUpload true → unique restore-task-conflict; no claimNext mutation path', async () => {
    let claimCalls = 0;
    const { store } = makeTaskStore({
      claimNext: async () => {
        claimCalls += 1;
        return { task: { taskId: TASK_A } };
      },
    });
    const service = createRestoreService({
      taskStore: store,
      locks: createUploadLocks({ maxGlobalTransfers: 4 }),
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => true,
    });
    await assert.rejects(
      () => service.claim({ deviceId: DEVICE_A }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.RESTORE_TASK_CONFLICT, {
          statusCode: 409,
          retryable: false,
          leakTokens: [TOKEN, '/Users', 'repo/devices'],
        });
        return true;
      },
    );
    // After active-upload probe, claimNext must not be called with hasActiveUpload:false
    // that would mutate; if called at all it must not create a claimed task.
    // Frozen: active upload → conflict before/without successful claim mutation.
    assert.equal(claimCalls, 0, 'must not claimNext when upload active');
  });

  it('claim success path returns task from claimNext', async () => {
    const task = Object.freeze({
      taskId: TASK_A,
      snapshotId: SNAPSHOT_A,
      status: 'active',
      claimedAt: T0,
    });
    const { store } = makeTaskStore({
      claimNext: async () => ({ task }),
    });
    const service = createRestoreService({
      taskStore: store,
      locks: createUploadLocks({ maxGlobalTransfers: 4 }),
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => false,
    });
    const result = await service.claim({ deviceId: DEVICE_A });
    assert.equal(result.task, task);
  });
});

// ── C. Delegation methods (no runTransfer) ──────────────────────────

describe('C non-binary methods do not call runTransfer', () => {
  it('getTask/updateProgress/acceptReceipt/acceptCleanup/createTask/cancelTask/getStatus/hasActiveRestore/claim transfer count 0', async () => {
    const base = createUploadLocks({ maxGlobalTransfers: 4 });
    const { locks, counts } = spyLocks(base);
    const { store } = makeTaskStore();
    let findCalls = 0;
    const service = createRestoreService({
      taskStore: store,
      locks,
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => {
        findCalls += 1;
        return false;
      },
    });

    counts.transfer = 0;
    await service.claim({ deviceId: DEVICE_A });
    await service.getTask({ deviceId: DEVICE_A, taskId: TASK_A });
    await service.updateProgress({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 0,
    });
    await service.acceptReceipt({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      receipt: { schemaVersion: 1 },
    });
    await service.acceptCleanup({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      cleanupReceipt: { schemaVersion: 1 },
    });
    await service.createTask({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: 'docs/target',
    });
    await service.cancelTask({ deviceId: DEVICE_A, taskId: TASK_A });
    await service.getStatus({ deviceId: DEVICE_A, taskId: TASK_A });
    await service.hasActiveRestore(DEVICE_A);

    assert.equal(counts.transfer, 0, 'non-binary restore methods must not call runTransfer');
    assert.ok(findCalls >= 1, 'claim probes findActiveUpload');
  });

  it('createTask MUST NOT call findActiveUpload; pending may coexist with active upload', async () => {
    let findCalls = 0;
    let createCalls = 0;
    const { store } = makeTaskStore({
      create: async (input) => {
        createCalls += 1;
        return {
          httpHint: 201,
          taskSummary: {
            taskId: TASK_A,
            deviceId: input.deviceId,
            status: 'pending',
          },
        };
      },
    });
    const service = createRestoreService({
      taskStore: store,
      locks: createUploadLocks({ maxGlobalTransfers: 4 }),
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => {
        findCalls += 1;
        return true; // active upload present
      },
    });
    const out = await service.createTask({
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      relativeTarget: 'docs/target',
    });
    assert.equal(out.httpHint, 201);
    assert.equal(createCalls, 1);
    assert.equal(findCalls, 0, 'createTask must not call findActiveUpload');
  });

  it('delegates exact data needed by restore-task-store for get/progress/receipt/cleanup/cancel/status', async () => {
    const { store, calls } = makeTaskStore();
    const service = createRestoreService({
      taskStore: store,
      locks: createUploadLocks({ maxGlobalTransfers: 4 }),
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => false,
    });

    await service.getTask({ deviceId: DEVICE_A, taskId: TASK_A });
    assert.deepEqual(calls.get[0], { deviceId: DEVICE_A, taskId: TASK_A });

    await service.updateProgress({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      fileIndex: 1,
      chunkIndex: 2,
      receivedBytes: 99,
    });
    assert.deepEqual(calls.updateProgress[0], {
      deviceId: DEVICE_A,
      taskId: TASK_A,
      fileIndex: 1,
      chunkIndex: 2,
      receivedBytes: 99,
    });

    const receipt = Object.freeze({ schemaVersion: 1, receiptId: 'r1' });
    await service.acceptReceipt({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      receipt,
    });
    assert.deepEqual(calls.acceptReceipt[0], {
      deviceId: DEVICE_A,
      taskId: TASK_A,
      receipt,
    });

    const cleanupReceipt = Object.freeze({ schemaVersion: 1, cleanupId: 'c1' });
    await service.acceptCleanup({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      cleanupReceipt,
    });
    assert.deepEqual(calls.acceptCleanup[0], {
      deviceId: DEVICE_A,
      taskId: TASK_A,
      cleanupReceipt,
    });

    await service.cancelTask({ deviceId: DEVICE_A, taskId: TASK_A });
    assert.deepEqual(calls.cancel[0], { deviceId: DEVICE_A, taskId: TASK_A });

    await service.getStatus({ deviceId: DEVICE_A, taskId: TASK_A });
    // getStatus may use store.get with same identity keys.
    assert.ok(calls.get.length >= 2);

    await service.hasActiveRestore(DEVICE_A);
    assert.equal(calls.hasActiveRestore[0], DEVICE_A);

    await service.createTask({
      deviceId: DEVICE_B,
      snapshotId: SNAPSHOT_A,
      relativeTarget: 'docs/other',
    });
    assert.deepEqual(calls.create[0], {
      deviceId: DEVICE_B,
      snapshotId: SNAPSHOT_A,
      relativeTarget: 'docs/other',
    });
  });
});

// ── D. getChunk ─────────────────────────────────────────────────────

describe('D getChunk live-binary slot + backpressure mapping', () => {
  it('calls runTransfer around storageReader read; returns body + headers; settle releases slot', async () => {
    const base = createUploadLocks({ maxGlobalTransfers: 1 });
    const { locks, counts } = spyLocks(base);
    const body = Buffer.from('restore-chunk-bytes');
    const sha = createHash('sha256').update(body).digest('hex');
    /** @type {unknown[]} */
    const readCalls = [];
    const storageReader = {
      readChunk: async (input) => {
        readCalls.push(input);
        return {
          body,
          chunkOffset: 0,
          chunkSize: body.length,
          chunkSha256: sha,
        };
      },
    };
    const { store } = makeTaskStore();
    const service = createRestoreService({
      taskStore: store,
      locks,
      storageReader,
      findActiveUpload: async () => false,
    });

    counts.transfer = 0;
    const result = await service.getChunk({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      fileIndex: 0,
      chunkIndex: 0,
    });
    assert.ok(counts.transfer >= 1, 'getChunk must call runTransfer');
    assert.ok(readCalls.length >= 1, 'must read via storageReader inside transfer');
    assert.ok(Buffer.isBuffer(result.body));
    assert.deepEqual(result.body, body);
    assert.equal(result.headers.contentType, 'application/octet-stream');
    assert.equal(result.headers.contentLength, body.length);
    assert.equal(result.headers.taskId, TASK_A);
    assert.equal(result.headers.fileIndex, 0);
    assert.equal(result.headers.chunkIndex, 0);
    assert.equal(result.headers.chunkOffset, 0);
    assert.equal(result.headers.chunkSize, body.length);
    assert.equal(result.headers.chunkSha256, sha);

    // Slot released: a subsequent runTransfer succeeds under max=1.
    const v = await base.runTransfer(async () => 'free-again');
    assert.equal(v, 'free-again');
  });

  it('maps ONLY LinkeError(UPLOAD_BACKPRESSURE) → RESTORE_BACKPRESSURE (unique)', async () => {
    const locks = {
      maxGlobalTransfers: 4,
      runTransfer: async () => {
        throw new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE);
      },
      runDevice: async (_id, fn) => fn(),
      runSession: async (_d, _u, fn) => fn(),
      runSnapshot: async (_d, _s, fn) => fn(),
    };
    const service = createRestoreService({
      taskStore: makeTaskStore().store,
      locks,
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => false,
    });
    await assert.rejects(
      () =>
        service.getChunk({
          deviceId: DEVICE_A,
          taskId: TASK_A,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.RESTORE_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
          leakTokens: [TOKEN, '/Users', 'upload-backpressure'],
        });
        // Must be a NEW error object with restore code — not the upload code.
        assert.notEqual(err.code, ERROR_CODES.UPLOAD_BACKPRESSURE);
        return true;
      },
    );
  });

  it('other LinkeError is the exact same object (no remap)', async () => {
    const original = new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED);
    const locks = {
      maxGlobalTransfers: 4,
      runTransfer: async () => {
        throw original;
      },
      runDevice: async (_id, fn) => fn(),
      runSession: async (_d, _u, fn) => fn(),
      runSnapshot: async (_d, _s, fn) => fn(),
    };
    const service = createRestoreService({
      taskStore: makeTaskStore().store,
      locks,
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => false,
    });
    await assert.rejects(
      () =>
        service.getChunk({
          deviceId: DEVICE_A,
          taskId: TASK_A,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      (err) => {
        assert.equal(err, original, 'must rethrow exact same LinkeError object');
        assert.equal(err.code, ERROR_CODES.RESTORE_INTEGRITY_FAILED);
        return true;
      },
    );
  });

  it('non-LinkeError is the exact same object (no remap)', async () => {
    const original = new Error('disk-io-boom');
    const locks = {
      maxGlobalTransfers: 4,
      runTransfer: async () => {
        throw original;
      },
      runDevice: async (_id, fn) => fn(),
      runSession: async (_d, _u, fn) => fn(),
      runSnapshot: async (_d, _s, fn) => fn(),
    };
    const service = createRestoreService({
      taskStore: makeTaskStore().store,
      locks,
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => false,
    });
    await assert.rejects(
      () =>
        service.getChunk({
          deviceId: DEVICE_A,
          taskId: TASK_A,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      (err) => {
        assert.equal(err, original, 'must rethrow exact same non-LinkeError object');
        assert.equal(/** @type {Error} */ (err).message, 'disk-io-boom');
        return true;
      },
    );
  });

  it('global slots full → restore-backpressure via real locks', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    const gate = deferred();
    const started = deferred();
    const held = locks.runTransfer(async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;

    const service = createRestoreService({
      taskStore: makeTaskStore().store,
      locks,
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => false,
    });
    await assert.rejects(
      () =>
        service.getChunk({
          deviceId: DEVICE_A,
          taskId: TASK_A,
          fileIndex: 0,
          chunkIndex: 0,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.RESTORE_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
        });
        return true;
      },
    );

    gate.resolve();
    await held;
  });
});

// ── E. No public restore route (C5) ─────────────────────────────────

describe('E production exposure — agent-listener restore claim still 404', () => {
  it('createAgentListener without restoreService: POST /agent/restore/tasks/claim → 404', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'linke-c5-restore-404-'));
    const registry = new DeviceRegistry({ dataDir: tmp });
    const { keyPem } = generateControllerPrivateKey();
    const certPem = await createOpenSslCertificate({
      keyPem,
      san: 'IP:127.0.0.1',
    });
    // Intentionally omit restoreService — C5 has no public restore wiring.
    const server = createAgentListener({
      identity: { keyPem, certPem },
      registry,
      onHeartbeat: async () => {},
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    function request(method, path, body) {
      return new Promise((resolve, reject) => {
        const headers = {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'x-linke-device-id': DEVICE_A,
          'x-linke-protocol-version': '2',
        };
        if (body !== undefined) {
          headers['content-length'] = String(Buffer.byteLength(body));
        }
        const req = https.request(
          {
            host: '127.0.0.1',
            port,
            path,
            method,
            headers,
            rejectUnauthorized: false,
            agent: false,
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              let parsed;
              try {
                parsed = raw ? JSON.parse(raw) : null;
              } catch {
                parsed = { __unparsed: raw };
              }
              resolve({ status: res.statusCode, body: parsed, raw });
            });
          },
        );
        req.on('error', reject);
        if (body !== undefined) req.end(body);
        else req.end();
      });
    }

    try {
      const res = await request('POST', '/agent/restore/tasks/claim', '{}');
      assert.equal(res.status, 404);
      assert.equal(
        res.body && res.body.error,
        ERROR_CODES.DEVICE_ROUTE_NOT_FOUND,
      );
      // Must not leak restore service internals / paths.
      assert.ok(!res.raw.includes(tmp));
      assert.ok(!res.raw.includes('restore-service'));
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── F. claim raw error sanitization (GLM F1 P1) ─────────────────────
// Plain Error/TypeError from findActiveUpload / claimNext must never surface.
// Public mapping: NEW LinkeError(RESTORE_STATE_INVALID) only (500/false; message === code).
// Registered LinkeError from either dependency rethrows exact same object (no remap).

describe('F claim raw error sanitization (GLM F1 P1)', () => {
  const SECRET_TOKEN = 'sk-live-secret-token-glm-f1-claim';
  const ABS_PATH = '/Users/ah/secret-repo/devices/device-alpha-001/TASK.json';
  const RAW_MSG = `ENOENT open ${ABS_PATH} token=${SECRET_TOKEN}`;

  it('plain Error from findActiveUpload → RESTORE_STATE_INVALID; no claimNext; no path/token leak', async () => {
    let claimCalls = 0;
    const { store } = makeTaskStore({
      claimNext: async () => {
        claimCalls += 1;
        return { task: null };
      },
    });
    const service = createRestoreService({
      taskStore: store,
      locks: createUploadLocks({ maxGlobalTransfers: 4 }),
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => {
        throw new Error(RAW_MSG);
      },
    });

    await assert.rejects(
      () => service.claim({ deviceId: DEVICE_A }),
      (err) => {
        assert.ok(err instanceof LinkeError, 'must surface LinkeError not raw Error');
        assert.notEqual(err, RAW_MSG);
        assertLinkeCode(err, ERROR_CODES.RESTORE_STATE_INVALID, {
          statusCode: 500,
          retryable: false,
          leakTokens: [
            SECRET_TOKEN,
            ABS_PATH,
            '/Users/ah',
            'secret-repo',
            'ENOENT',
            'TASK.json',
            RAW_MSG,
          ],
        });
        // Must be a fresh public error — not rethrow of raw Error / raw code strings.
        assert.notEqual(/** @type {Error} */ (err).message, RAW_MSG);
        assert.notEqual(err.code, ERROR_CODES.UPLOAD_IO_ERROR);
        return true;
      },
    );
    assert.equal(claimCalls, 0, 'must not claimNext when findActiveUpload throws');
  });

  it('plain TypeError from findActiveUpload → RESTORE_STATE_INVALID; no claimNext; no path/token leak', async () => {
    let claimCalls = 0;
    const { store } = makeTaskStore({
      claimNext: async () => {
        claimCalls += 1;
        return { task: { taskId: TASK_A } };
      },
    });
    const typeMsg = `TypeError: cannot read props of null at ${ABS_PATH} token=${SECRET_TOKEN}`;
    const service = createRestoreService({
      taskStore: store,
      locks: createUploadLocks({ maxGlobalTransfers: 4 }),
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => {
        throw new TypeError(typeMsg);
      },
    });

    await assert.rejects(
      () => service.claim({ deviceId: DEVICE_A }),
      (err) => {
        assert.ok(err instanceof LinkeError, 'must surface LinkeError not raw TypeError');
        assertLinkeCode(err, ERROR_CODES.RESTORE_STATE_INVALID, {
          statusCode: 500,
          retryable: false,
          leakTokens: [
            SECRET_TOKEN,
            ABS_PATH,
            '/Users/ah',
            'secret-repo',
            'cannot read props',
            typeMsg,
            'TypeError',
          ],
        });
        assert.notEqual(err.code, ERROR_CODES.UPLOAD_IO_ERROR);
        return true;
      },
    );
    assert.equal(claimCalls, 0, 'must not claimNext when findActiveUpload throws');
  });

  it('plain Error from claimNext → RESTORE_STATE_INVALID; no path/token leak', async () => {
    const claimMsg = `claimNext boom path=${ABS_PATH} token=${SECRET_TOKEN}`;
    const { store } = makeTaskStore({
      claimNext: async () => {
        throw new Error(claimMsg);
      },
    });
    const service = createRestoreService({
      taskStore: store,
      locks: createUploadLocks({ maxGlobalTransfers: 4 }),
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => false,
    });

    await assert.rejects(
      () => service.claim({ deviceId: DEVICE_A }),
      (err) => {
        assert.ok(err instanceof LinkeError, 'must surface LinkeError not raw Error');
        assertLinkeCode(err, ERROR_CODES.RESTORE_STATE_INVALID, {
          statusCode: 500,
          retryable: false,
          leakTokens: [
            SECRET_TOKEN,
            ABS_PATH,
            '/Users/ah',
            'secret-repo',
            'claimNext boom',
            claimMsg,
          ],
        });
        assert.notEqual(err.code, ERROR_CODES.UPLOAD_IO_ERROR);
        return true;
      },
    );
  });

  it('LinkeError from findActiveUpload is the exact same object (no remap canary)', async () => {
    const original = new LinkeError(ERROR_CODES.RESTORE_TASK_CONFLICT);
    let claimCalls = 0;
    const { store } = makeTaskStore({
      claimNext: async () => {
        claimCalls += 1;
        return { task: null };
      },
    });
    const service = createRestoreService({
      taskStore: store,
      locks: createUploadLocks({ maxGlobalTransfers: 4 }),
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => {
        throw original;
      },
    });

    await assert.rejects(
      () => service.claim({ deviceId: DEVICE_A }),
      (err) => {
        assert.equal(err, original, 'must rethrow exact same LinkeError object');
        assert.equal(err.code, ERROR_CODES.RESTORE_TASK_CONFLICT);
        // Must not remap registered domain errors into RESTORE_STATE_INVALID.
        assert.notEqual(err.code, ERROR_CODES.RESTORE_STATE_INVALID);
        return true;
      },
    );
    assert.equal(claimCalls, 0, 'must not claimNext when probe throws LinkeError');
  });

  it('LinkeError from claimNext is the exact same object (no remap canary)', async () => {
    const original = new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND);
    const { store } = makeTaskStore({
      claimNext: async () => {
        throw original;
      },
    });
    const service = createRestoreService({
      taskStore: store,
      locks: createUploadLocks({ maxGlobalTransfers: 4 }),
      storageReader: makeStorageReader().reader,
      findActiveUpload: async () => false,
    });

    await assert.rejects(
      () => service.claim({ deviceId: DEVICE_A }),
      (err) => {
        assert.equal(err, original, 'must rethrow exact same LinkeError object');
        assert.equal(err.code, ERROR_CODES.RESTORE_TASK_NOT_FOUND);
        assert.notEqual(err.code, ERROR_CODES.RESTORE_STATE_INVALID);
        return true;
      },
    );
  });
});

// ── G. claim deviceId input validation (GLM F2 P2) ──────────────────
// Fail-closed BEFORE locks.runDevice / findActiveUpload / claimNext.
// Public: LinkeError(RESTORE_TASK_INVALID) 400/false; never UPLOAD_IO_ERROR; no value leak.

describe('G claim deviceId input validation (GLM F2 P2)', () => {
  const INVALID_DEVICE_IDS = Object.freeze([
    { label: 'undefined', value: undefined, leak: ['undefined'] },
    { label: 'null', value: null, leak: ['null'] },
    { label: 'empty string', value: '', leak: [] },
    { label: 'number', value: 42, leak: ['42'] },
    {
      label: 'object',
      value: { id: 'hostile-device', path: '/tmp/evil-restore' },
      leak: ['hostile-device', '/tmp/evil-restore', 'evil-restore'],
    },
  ]);

  for (const c of INVALID_DEVICE_IDS) {
    it(`claim rejects invalid deviceId (${c.label}) with RESTORE_TASK_INVALID; deps stay 0`, async () => {
      const base = createUploadLocks({ maxGlobalTransfers: 4 });
      const { locks, counts } = spyLocks(base);
      let findCalls = 0;
      let claimCalls = 0;
      const { store } = makeTaskStore({
        claimNext: async () => {
          claimCalls += 1;
          return { task: null };
        },
      });
      const service = createRestoreService({
        taskStore: store,
        locks,
        storageReader: makeStorageReader().reader,
        findActiveUpload: async () => {
          findCalls += 1;
          return false;
        },
      });

      counts.device = 0;
      await assert.rejects(
        () => service.claim({ deviceId: /** @type {any} */ (c.value) }),
        (err) => {
          assert.ok(err instanceof LinkeError, 'must be LinkeError');
          assertLinkeCode(err, ERROR_CODES.RESTORE_TASK_INVALID, {
            statusCode: 400,
            retryable: false,
            leakTokens: [
              ...c.leak,
              TOKEN,
              '/tmp/evil',
              '/Users',
              'hostile-device',
            ],
          });
          // Must not fall through to locks key fail-closed (UPLOAD_IO_ERROR).
          assert.notEqual(err.code, ERROR_CODES.UPLOAD_IO_ERROR);
          assert.notEqual(err.code, ERROR_CODES.RESTORE_STATE_INVALID);
          return true;
        },
      );

      assert.equal(counts.device, 0, 'must not call locks.runDevice for invalid deviceId');
      assert.equal(findCalls, 0, 'must not call findActiveUpload for invalid deviceId');
      assert.equal(claimCalls, 0, 'must not call claimNext for invalid deviceId');
    });
  }
});
