/**
 * C7 RED — Restore concurrency / admission / live-transfer / IP limiter isolation.
 * Authority: design §§12, 16.7 + plan C7 RED Steps 6–8.
 *
 * Uses real C5/C6 primitives (createUploadLocks, createRestoreService, createAgentListener,
 * createFixedWindowRateLimiter). Does not copy production lock logic into tests.
 * Engine module loaded dynamically when needed.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import https from 'node:https';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { createUploadLocks } from '../src/upload-locks.js';
import { createRestoreService } from '../src/restore-service.js';
import { createUploadService } from '../src/upload-service.js';
import { createUploadSessionStore } from '../src/upload-session-store.js';
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';
import {
  parseChunkHeaders,
  ingestChunkBody,
  commitChunk,
} from '../src/upload-chunk-ingest.js';
import {
  preflightCapacity,
  verifyAndCommitSession,
} from '../src/upload-commit.js';
import { createAgentListener } from '../src/agent-listener.js';
import { DeviceRegistry } from '../src/device-registry.js';
import { createFixedWindowRateLimiter } from '../src/rate-limit.js';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../src/tls-identity-store.js';
import { createEndpointRestoreStateStore } from '../src/restore-endpoint-state.js';
import { RESTORE_CHUNK_SIZE } from '../src/restore-schemas.js';

const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const DEVICE_A = 'device-c7-conc-a';
const DEVICE_B = 'device-c7-conc-b';
const TASK_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0a01';
const TASK_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const TASK_A2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0a02';
const SNAP_A = '550e8400-e29b-41d4-a716-4466554400aa';
const SNAP_B = '550e8400-e29b-41d4-a716-4466554400bb';
const DIGEST = 'd'.repeat(64);
const T0 = '2026-07-23T12:00:00.000Z';
const CHUNK_SIZE = RESTORE_CHUNK_SIZE;
const REL_A = 'apps/target-a';
const REL_B = 'apps/target-b';

const LEGACY_MAX = 60;
const UPLOAD_MAX = 1200;
const RESTORE_MAX = 1200;

/** @type {import('node:https').Server[]} */
const openServers = [];
/** @type {string[]} */
const tempDirs = [];

after(async () => {
  for (const s of openServers.splice(0)) {
    await new Promise((resolve) => s.close(() => resolve()));
  }
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function makeTemp(prefix) {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

async function loadRunEndpointRestore() {
  let mod;
  try {
    mod = await import('../src/restore-endpoint-engine.js');
  } catch (error) {
    assert.fail(
      `C7 restore-endpoint-engine missing (${/** @type {{ code?: string }} */ (error)?.code || error})`,
    );
  }
  assert.equal(typeof mod.runEndpointRestore, 'function');
  return mod.runEndpointRestore;
}

/**
 * Hold N global live-transfer slots via real locks.runTransfer.
 * @param {ReturnType<typeof createUploadLocks>} locks
 * @param {number} n
 */
async function holdGlobalSlots(locks, n) {
  /** @type {Array<() => void>} */
  const releases = [];
  /** @type {Promise<unknown>[]} */
  const held = [];
  let started = 0;
  for (let i = 0; i < n; i += 1) {
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    releases.push(release);
    held.push(
      locks.runTransfer(async () => {
        started += 1;
        await gate;
        return 'held';
      }),
    );
  }
  for (let turn = 0; turn < 64 && started < n; turn += 1) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(started, n, `expected ${n} held slots, got ${started}`);
  return {
    async release() {
      for (const r of releases) r();
      await Promise.all(held);
    },
  };
}

/**
 * Minimal task store for createRestoreService claim/getTask/getChunk admission tests.
 */
function createMemoryTaskStore(options = {}) {
  /** @type {Map<string, { taskId: string, deviceId: string, status: string, relativeTarget: string, snapshotId: string }>} */
  const tasks = new Map();
  /** @type {Map<string, boolean>} */
  const activeByDevice = new Map();

  for (const t of options.seed || []) {
    tasks.set(t.taskId, { ...t });
    if (t.status === 'active' || t.status === 'pending') {
      if (t.status === 'active') activeByDevice.set(t.deviceId, true);
    }
  }

  return {
    async claimNext({ deviceId }) {
      // Find pending for device
      for (const t of tasks.values()) {
        if (t.deviceId === deviceId && t.status === 'pending') {
          if (activeByDevice.get(deviceId)) {
            throw new LinkeError(ERROR_CODES.RESTORE_TASK_CONFLICT, { statusCode: 409 });
          }
          t.status = 'active';
          activeByDevice.set(deviceId, true);
          return {
            task: {
              taskId: t.taskId,
              snapshotId: t.snapshotId,
              manifestDigest: DIGEST,
              relativeTarget: t.relativeTarget,
              status: 'active',
              fileCount: 1,
              totalBytes: 4,
              chunkSize: CHUNK_SIZE,
              createdAt: T0,
              claimedAt: T0,
              cancelRequested: false,
            },
          };
        }
      }
      // already active nonterminal conflict for second claim
      if (activeByDevice.get(deviceId)) {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_CONFLICT, { statusCode: 409 });
      }
      return { task: null };
    },
    async get({ deviceId, taskId }) {
      const t = tasks.get(taskId);
      if (!t || t.deviceId !== deviceId) {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND, { statusCode: 404 });
      }
      return {
        taskId: t.taskId,
        deviceId: t.deviceId,
        snapshotId: t.snapshotId,
        relativeTarget: t.relativeTarget,
        status: t.status,
        cancelRequested: false,
        cleanupAuthorized: false,
        fileCount: 1,
        totalBytes: 4,
        chunkSize: CHUNK_SIZE,
      };
    },
    async updateProgress() {
      return { ok: true, cancelRequested: false };
    },
    async acceptReceipt(input) {
      return {
        ok: true,
        taskId: input?.taskId,
        cleanupAuthorized: true,
        status: 'completed',
        receiptId: '550e8400-e29b-41d4-a716-446655440021',
      };
    },
    async acceptCleanup(input) {
      return {
        ok: true,
        taskId: input?.taskId,
        status: 'cleaned',
        cleanupId: '550e8400-e29b-41d4-a716-446655440031',
        cleanupAckAt: T0,
      };
    },
    async create() {
      throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID, { statusCode: 400 });
    },
    async cancel() {
      return { status: 'active', cancelRequested: true };
    },
    async hasActiveRestore(deviceId) {
      return activeByDevice.get(deviceId) === true;
    },
    async buildTaskFilesPayload() {
      return {
        files: [{
          fileIndex: 0,
          path: 'a.txt',
          size: 4,
          sha256: createHash('sha256').update('data').digest('hex'),
          chunkCount: 1,
        }],
      };
    },
    // test helpers
    _tasks: tasks,
    _activeByDevice: activeByDevice,
    seed(t) {
      tasks.set(t.taskId, { ...t });
      if (t.status === 'active') activeByDevice.set(t.deviceId, true);
    },
  };
}

function createMockStorageReader() {
  return {
    async readChunk() {
      const body = Buffer.from('data');
      return {
        body,
        chunkOffset: 0,
        chunkSize: body.length,
        chunkSha256: createHash('sha256').update(body).digest('hex'),
      };
    },
  };
}

/**
 * Real createRestoreService over memory store + real locks.
 */
function makeRestoreService(options = {}) {
  const locks = options.locks || createUploadLocks({
    maxGlobalTransfers: options.maxGlobalTransfers ?? 4,
  });
  const taskStore = options.taskStore || createMemoryTaskStore({ seed: options.seed });
  const findActiveUpload = options.findActiveUpload
    || (async () => false);
  const service = createRestoreService({
    taskStore,
    locks,
    storageReader: options.storageReader || createMockStorageReader(),
    findActiveUpload,
    now: () => new Date(T0),
  });
  return {
    service,
    locks,
    taskStore,
  };
}

/**
 * Production-compatible upload projection (same shape as restore-upload-admission).
 * @param {{ deviceId?: string, snapshotId?: string, files?: { path: string, size: number }[] }} [opts]
 */
function makeUploadProjection(opts = {}) {
  const deviceId = opts.deviceId ?? DEVICE_A;
  const snapshotId = opts.snapshotId ?? SNAP_A;
  const files = opts.files ?? [{ path: 'a.txt', size: 0 }];
  const entries = files.map((f) => ({
    path: f.path,
    size: f.size,
    sha256: f.size === 0 ? ZERO_SHA : createHash('sha256').update(Buffer.alloc(f.size, 0x61)).digest('hex'),
  }));
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
  return { manifest, manifestDigest, deviceId, snapshotId };
}

/**
 * Real createUploadService + session store (production create path; no admission rewrite).
 * @param {{
 *   dataDir: string,
 *   locks?: ReturnType<typeof createUploadLocks>,
 *   findActiveRestore?: (deviceId: string) => boolean | Promise<boolean>,
 * }} opts
 */
function makeRealUploadService(opts) {
  const locks = opts.locks || createUploadLocks({ maxGlobalTransfers: 4 });
  const store = createUploadSessionStore({
    dataDir: opts.dataDir,
    now: () => new Date(T0),
    randomUUID: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;
      };
    })(),
  });
  const uploadOpts = {
    dataDir: opts.dataDir,
    store,
    locks,
    ingest: { parseChunkHeaders, ingestChunkBody, commitChunk },
    commit: {
      preflightCapacity: (dir, totalBytes, options = {}) =>
        preflightCapacity(dir, totalBytes, {
          ...options,
          deps: {
            ...(options.deps || {}),
            statfs: options.deps?.statfs ?? (async () => ({
              type: 0,
              bsize: 4096,
              blocks: 1e12,
              bfree: 1e12,
              bavail: 1e12,
              files: 0,
              ffree: 0,
            })),
          },
        }),
      verifyAndCommitSession,
    },
    now: () => new Date(T0),
  };
  if (opts.findActiveRestore) {
    uploadOpts.findActiveRestore = opts.findActiveRestore;
  }
  const upload = createUploadService(/** @type {any} */ (uploadOpts));
  /**
   * Production-compatible active-upload probe (controller-runtime freezes on
   * uploadStore.findActiveSession — not a rewritten admission algorithm).
   * @param {string} deviceId
   */
  async function hasActiveUpload(deviceId) {
    const active = await store.findActiveSession(deviceId);
    return active != null;
  }
  return { upload, store, locks, hasActiveUpload };
}

async function buildIdentity() {
  const { keyPem } = generateControllerPrivateKey();
  const certPem = await createOpenSslCertificate({ keyPem, san: 'IP:127.0.0.1' });
  return { keyPem, certPem };
}

async function enroll(registry, deviceId) {
  const issued = await registry.issueEnrollment({ deviceId });
  const result = await registry.consumeEnrollment({
    deviceId,
    code: issued.code,
    protocolVersion: 2,
  });
  return { deviceId, token: result.token, protocolVersion: 2 };
}

function authHeaders(device) {
  return {
    authorization: `Bearer ${device.token}`,
    'x-linke-device-id': device.deviceId,
    'x-linke-protocol-version': '2',
  };
}

/**
 * Agent listener fixture with real restore rate limiter + mock/real service.
 */
async function startAgentFixture(options = {}) {
  const dataDir = await makeTemp('linke-c7-conc-agent-');
  const registry = options.registry || new DeviceRegistry({ dataDir });
  const identity = options.identity || await buildIdentity();
  const nowMs = { t: 1_000_000 };
  const restoreLimiter = options.restoreRateLimit
    || createFixedWindowRateLimiter({
      maxRequests: options.restoreMax ?? RESTORE_MAX,
      windowMs: 60_000,
      now: () => nowMs.t,
    });
  const uploadLimiter = options.uploadRateLimit
    || createFixedWindowRateLimiter({
      maxRequests: options.uploadMax ?? UPLOAD_MAX,
      windowMs: 60_000,
      now: () => nowMs.t,
    });
  const legacyLimiter = options.rateLimit
    || createFixedWindowRateLimiter({
      maxRequests: options.legacyMax ?? LEGACY_MAX,
      windowMs: 60_000,
      now: () => nowMs.t,
    });

  const server = createAgentListener({
    identity,
    registry,
    onHeartbeat: async () => {},
    rateLimit: legacyLimiter,
    uploadRateLimit: uploadLimiter,
    restoreRateLimit: restoreLimiter,
    restoreService: options.restoreService,
    uploadService: options.uploadService,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const { port } = server.address();

  function requestAgent(method, path, opts = {}) {
    return new Promise((resolve, reject) => {
      /** @type {Record<string, string>} */
      const headers = { ...(opts.headers || {}) };
      let body = opts.body;
      if (body !== undefined && headers['content-length'] === undefined) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        headers['content-length'] = String(buf.length);
        body = buf;
      }
      const req = https.request({
        host: '127.0.0.1',
        port,
        path,
        method,
        headers,
        rejectUnauthorized: false,
        agent: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = raw.length === 0 ? null : JSON.parse(raw);
          } catch {
            parsed = { __unparsed: raw };
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.end(body);
      else req.end();
    });
  }

  return {
    server,
    port,
    registry,
    dataDir,
    nowMs,
    requestAgent,
    async cleanup() {
      const idx = openServers.indexOf(server);
      if (idx >= 0) openServers.splice(idx, 1);
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('C7 two-device parallel + cross-device isolation', () => {
  it('C7 two different devices can claim/run in parallel; never cross-read task or staging', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();

    const filesA = [{
      fileIndex: 0,
      path: 'a.txt',
      size: 5,
      sha256: createHash('sha256').update('AAAAA').digest('hex'),
      chunkCount: 1,
      content: Buffer.from('AAAAA'),
    }];
    const filesB = [{
      fileIndex: 0,
      path: 'b.txt',
      size: 5,
      sha256: createHash('sha256').update('BBBBB').digest('hex'),
      chunkCount: 1,
      content: Buffer.from('BBBBB'),
    }];

    /**
     * @param {string} deviceId
     * @param {string} token
     * @param {string} taskId
     * @param {string} relativeTarget
     * @param {typeof filesA} files
     */
    function makeNet(deviceId, token, taskId, relativeTarget, files) {
      /** @type {string[]} */
      const paths = [];
      return {
        paths,
        async requestJson(opts) {
          assert.equal(opts.deviceId, deviceId, 'device identity must stick');
          assert.equal(opts.token, token);
          paths.push(`${opts.method || 'POST'} ${opts.path}`);
          const p = String(opts.path);
          if (p.endsWith('/claim')) {
            return {
              task: {
                taskId,
                snapshotId: deviceId === DEVICE_A ? SNAP_A : SNAP_B,
                manifestDigest: DIGEST,
                relativeTarget,
                status: 'active',
                fileCount: 1,
                totalBytes: files[0].size,
                chunkSize: CHUNK_SIZE,
                createdAt: T0,
                claimedAt: T0,
                cancelRequested: false,
              },
            };
          }
          if (p.includes(taskId) && !p.includes('/files/') && (opts.method === 'GET' || !opts.method)) {
            return {
              taskId,
              snapshotId: deviceId === DEVICE_A ? SNAP_A : SNAP_B,
              manifestDigest: DIGEST,
              relativeTarget,
              status: 'active',
              cancelRequested: false,
              cleanupAuthorized: false,
              fileCount: 1,
              totalBytes: files[0].size,
              chunkSize: CHUNK_SIZE,
              files: files.map(({ fileIndex, path, size, sha256, chunkCount }) => ({
                fileIndex, path, size, sha256, chunkCount,
              })),
            };
          }
          if (p.includes('/progress')) return { ok: true, cancelRequested: false };
          if (p.includes('/receipts')) {
            // ensure receipt taskId matches device task
            assert.equal(opts.body?.taskId, taskId);
            return { ok: true, cleanupAuthorized: true, status: 'completed' };
          }
          if (p.includes('/cleanup')) {
            assert.equal(opts.body?.taskId, taskId);
            assert.equal(opts.body?.deviceId, deviceId);
            return { ok: true, status: 'cleaned' };
          }
          // Cross-device task id must not be served as success
          if (p.includes(TASK_A) && deviceId === DEVICE_B) {
            throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND, { statusCode: 404 });
          }
          if (p.includes(TASK_B) && deviceId === DEVICE_A) {
            throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND, { statusCode: 404 });
          }
          throw new LinkeError(ERROR_CODES.DEVICE_ROUTE_NOT_FOUND, { statusCode: 404 });
        },
        async download(opts) {
          paths.push(`DOWNLOAD ${opts.path}`);
          assert.ok(String(opts.path).includes(taskId), 'download taskId scoped');
          assert.ok(!String(opts.path).includes(deviceId === DEVICE_A ? TASK_B : TASK_A));
          const bytes = files[0].content;
          if (typeof opts.onChunk === 'function') await opts.onChunk(bytes);
          return {
            bytesReceived: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
        },
      };
    }

    const tokenA = 'token-a-c7-concurrency-32chars!!!';
    const tokenB = 'token-b-c7-concurrency-32chars!!!';
    const netA = makeNet(DEVICE_A, tokenA, TASK_A, REL_A, filesA);
    const netB = makeNet(DEVICE_B, tokenB, TASK_B, REL_B, filesB);

    async function runFor(deviceId, token, net, rel, taskId) {
      const endpointDataDir = await makeTemp(`linke-c7-conc-${deviceId}-`);
      const restoreRoot = await makeTemp(`linke-c7-root-${deviceId}-`);
      await mkdir(join(restoreRoot, 'apps'), { recursive: true });
      const stateStore = createEndpointRestoreStateStore({
        endpointDataDir,
        now: () => new Date(T0),
      });
      const { publishFromStagingVerified, rollbackPublished, recoverFromCrash, recoverCancelledLocal } =
        await import('../src/restore-publish.js');
      return runEndpointRestore({
        agentUrl: 'https://127.0.0.1:1',
        tlsFingerprint: 'a'.repeat(64),
        token,
        deviceId,
        protocolVersion: 2,
        restoreRoot,
        endpointDataDir,
        retryBudget: 8,
        stateStore,
        publish: {
          publishFromStagingVerified,
          rollbackPublished,
          recoverFromCrash,
          recoverCancelledLocal,
        },
        requestJson: net.requestJson,
        download: net.download,
        now: () => new Date(T0),
        __probe: { restoreRoot, taskId },
      }).then((result) => ({ result, restoreRoot, taskId, deviceId }));
    }

    const [outA, outB] = await Promise.all([
      runFor(DEVICE_A, tokenA, netA, REL_A, TASK_A),
      runFor(DEVICE_B, tokenB, netB, REL_B, TASK_B),
    ]);

    assert.equal(outA.result.outcome, 'completed');
    assert.equal(outB.result.outcome, 'completed');

    // No cross-device paths in call logs
    for (const p of netA.paths) {
      assert.ok(!p.includes(TASK_B), `device A must not touch task B: ${p}`);
    }
    for (const p of netB.paths) {
      assert.ok(!p.includes(TASK_A), `device B must not touch task A: ${p}`);
    }
  });

  it('C7 same device second nonterminal task conflicts locally (claim path)', async () => {
    const { service, taskStore } = makeRestoreService({
      seed: [
        {
          taskId: TASK_A,
          deviceId: DEVICE_A,
          status: 'pending',
          relativeTarget: REL_A,
          snapshotId: SNAP_A,
        },
        {
          taskId: TASK_A2,
          deviceId: DEVICE_A,
          status: 'pending',
          relativeTarget: REL_A,
          snapshotId: SNAP_A,
        },
      ],
    });

    const first = await service.claim({ deviceId: DEVICE_A });
    assert.ok(first.task);
    assert.equal(first.task.taskId, TASK_A);

    await assert.rejects(
      () => service.claim({ deviceId: DEVICE_A }),
      (e) => e.code === ERROR_CODES.RESTORE_TASK_CONFLICT && e.statusCode === 409,
    );

    // Cross-device still free
    taskStore.seed({
      taskId: TASK_B,
      deviceId: DEVICE_B,
      status: 'pending',
      relativeTarget: REL_B,
      snapshotId: SNAP_B,
    });
    const other = await service.claim({ deviceId: DEVICE_B });
    assert.ok(other.task);
    assert.equal(other.task.taskId, TASK_B);
  });
});

describe('C7 same-device upload OR restore admission (real C5/C6 path)', () => {
  it('C7 active restore blocks upload create via real service admission (not fake boolean)', async () => {
    // Real production fixtures (see test/restore-upload-admission.test.js):
    // createUploadService create path with findActiveRestore = real restore.hasActiveRestore.
    // No admitUploadCreate rewrite / boolean self-certification.
    const dataDir = await makeTemp('linke-c7-upload-adm-');
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });
    const { service: restore } = makeRestoreService({
      locks,
      seed: [{
        taskId: TASK_A,
        deviceId: DEVICE_A,
        status: 'pending',
        relativeTarget: REL_A,
        snapshotId: SNAP_A,
      }],
    });
    const claimed = await restore.claim({ deviceId: DEVICE_A });
    assert.equal(claimed.task.taskId, TASK_A);
    assert.equal(await restore.hasActiveRestore(DEVICE_A), true);

    const { upload } = makeRealUploadService({
      dataDir,
      locks,
      // Production injects restoreTaskStore.hasActiveRestore (controller-runtime).
      findActiveRestore: (id) => restore.hasActiveRestore(id),
    });
    const proj = makeUploadProjection({
      deviceId: DEVICE_A,
      snapshotId: SNAP_A,
      files: [{ path: 'blocked.txt', size: 0 }],
    });
    await assert.rejects(
      () => upload.create({
        authenticatedDeviceId: DEVICE_A,
        manifest: proj.manifest,
        claimedManifestDigest: proj.manifestDigest,
      }),
      (e) => e instanceof LinkeError
        && e.code === ERROR_CODES.UPLOAD_SESSION_CONFLICT
        && e.statusCode === 409,
    );

    // Inverse: real active upload session → restore claim RESTORE_TASK_CONFLICT.
    // findActiveUpload freezes on real session store (not boolean uploadActive).
    const dataDir2 = await makeTemp('linke-c7-restore-adm-');
    const locks2 = createUploadLocks({ maxGlobalTransfers: 4 });
    const { upload: upload2, hasActiveUpload } = makeRealUploadService({
      dataDir: dataDir2,
      locks: locks2,
      findActiveRestore: async () => false,
    });
    const projB = makeUploadProjection({
      deviceId: DEVICE_B,
      snapshotId: SNAP_B,
      files: [{ path: 'active-upload.txt', size: 0 }],
    });
    const created = await upload2.create({
      authenticatedDeviceId: DEVICE_B,
      manifest: projB.manifest,
      claimedManifestDigest: projB.manifestDigest,
    });
    assert.ok(created);
    assert.equal(await hasActiveUpload(DEVICE_B), true);

    const { service: restore2 } = makeRestoreService({
      locks: locks2,
      seed: [{
        taskId: TASK_B,
        deviceId: DEVICE_B,
        status: 'pending',
        relativeTarget: REL_B,
        snapshotId: SNAP_B,
      }],
      findActiveUpload: hasActiveUpload,
    });
    await assert.rejects(
      () => restore2.claim({ deviceId: DEVICE_B }),
      (e) => e instanceof LinkeError
        && e.code === ERROR_CODES.RESTORE_TASK_CONFLICT
        && e.statusCode === 409,
    );
  });
});

describe('C7 global live-transfer semaphore + backpressure', () => {
  it('C7 maxGlobalTransfers 1/4/16 legal; 0/17 fail-closed; no silent clamp', () => {
    for (const n of [1, 4, 16]) {
      const locks = createUploadLocks({ maxGlobalTransfers: n });
      assert.equal(locks.maxGlobalTransfers, n);
    }
    for (const bad of [0, 17, -1, 1.5, '4', null]) {
      assert.throws(
        () => createUploadLocks({ maxGlobalTransfers: /** @type {any} */ (bad) }),
        /invalid maxGlobalTransfers/,
      );
    }
  });

  it('C7 only chunk getChunk occupies runTransfer; claim/task/progress/receipt/cleanup free under full slots', async () => {
    const { service, locks } = makeRestoreService({
      maxGlobalTransfers: 1,
      seed: [{
        taskId: TASK_A,
        deviceId: DEVICE_A,
        status: 'pending',
        relativeTarget: REL_A,
        snapshotId: SNAP_A,
      }],
    });

    const held = await holdGlobalSlots(locks, 1);

    // Prove full
    await assert.rejects(
      () => locks.runTransfer(async () => 'nope'),
      (e) => e.code === ERROR_CODES.UPLOAD_BACKPRESSURE,
    );

    const claimed = await service.claim({ deviceId: DEVICE_A });
    assert.ok(claimed.task);

    const task = await service.getTask({ deviceId: DEVICE_A, taskId: TASK_A });
    assert.equal(task.taskId, TASK_A);

    const prog = await service.updateProgress({
      deviceId: DEVICE_A,
      taskId: TASK_A,
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 0,
    });
    assert.equal(prog.ok, true);

    // receipt/cleanup may require richer store; if service accepts schema-lite:
    try {
      await service.acceptReceipt({
        deviceId: DEVICE_A,
        taskId: TASK_A,
        receipt: { schemaVersion: 1 },
      });
    } catch (error) {
      // schema may reject — still must not be restore-backpressure
      assert.notEqual(/** @type {{ code?: string }} */ (error).code, ERROR_CODES.RESTORE_BACKPRESSURE);
    }
    try {
      await service.acceptCleanup({
        deviceId: DEVICE_A,
        taskId: TASK_A,
        cleanupReceipt: { schemaVersion: 1 },
      });
    } catch (error) {
      assert.notEqual(/** @type {{ code?: string }} */ (error).code, ERROR_CODES.RESTORE_BACKPRESSURE);
    }

    await assert.rejects(
      () => service.getChunk({
        deviceId: DEVICE_A,
        taskId: TASK_A,
        fileIndex: 0,
        chunkIndex: 0,
      }),
      (e) => e.code === ERROR_CODES.RESTORE_BACKPRESSURE
        && e.statusCode === 429
        && e.retryable === true,
    );

    await held.release();

    // After release, getChunk succeeds (or fails non-backpressure)
    try {
      const chunk = await service.getChunk({
        deviceId: DEVICE_A,
        taskId: TASK_A,
        fileIndex: 0,
        chunkIndex: 0,
      });
      assert.ok(chunk);
    } catch (error) {
      assert.notEqual(/** @type {{ code?: string }} */ (error).code, ERROR_CODES.RESTORE_BACKPRESSURE);
    }
  });

  it('C7 full slots → restore-backpressure; settle/abort/timeout release; no infinite queue', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 2 });
    const held = await holdGlobalSlots(locks, 2);

    /** @type {PromiseSettledResult<unknown>[]} */
    const results = await Promise.allSettled([
      locks.runTransfer(async () => 'a'),
      locks.runTransfer(async () => 'b'),
      locks.runTransfer(async () => 'c'),
    ]);
    // All three fail-fast — never queue
    for (const r of results) {
      assert.equal(r.status, 'rejected');
      assert.equal(/** @type {PromiseRejectedResult} */ (r).reason.code, ERROR_CODES.UPLOAD_BACKPRESSURE);
    }

    await held.release();

    // After release, acquires work again
    const ok = await locks.runTransfer(async () => 'freed');
    assert.equal(ok, 'freed');

    // Abort/timeout release: throw inside transfer still frees
    await assert.rejects(
      () => locks.runTransfer(async () => {
        throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, { statusCode: null });
      }),
      (e) => e.code === ERROR_CODES.RESTORE_INTERRUPTED,
    );
    const ok2 = await locks.runTransfer(async () => 'after-throw');
    assert.equal(ok2, 'after-throw');
  });

  it('C7 agent chunk route maps full semaphore to 429 restore-backpressure + Retry-After 1..30', async () => {
    // Route is sole HTTP surface; createRestoreService.getChunk is sole runTransfer caller
    // (no double runTransfer wrapper; no direct-service fallback substituting route).
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    const held = await holdGlobalSlots(locks, 1);
    const real = makeRestoreService({
      locks,
      seed: [{
        taskId: TASK_A,
        deviceId: DEVICE_A,
        status: 'active',
        relativeTarget: REL_A,
        snapshotId: SNAP_A,
      }],
    });
    real.taskStore._activeByDevice.set(DEVICE_A, true);
    real.taskStore._tasks.set(TASK_A, {
      taskId: TASK_A,
      deviceId: DEVICE_A,
      status: 'active',
      relativeTarget: REL_A,
      snapshotId: SNAP_A,
    });

    // Extra direct-service pin (does not replace route assertion).
    await assert.rejects(
      () => real.service.getChunk({
        deviceId: DEVICE_A,
        taskId: TASK_A,
        fileIndex: 0,
        chunkIndex: 0,
      }),
      (e) => e.code === ERROR_CODES.RESTORE_BACKPRESSURE
        && e.statusCode === 429
        && e.retryable === true,
    );

    const dataDir = await makeTemp('linke-c7-bp-reg-');
    const registry = new DeviceRegistry({ dataDir });
    const device = await enroll(registry, DEVICE_A);
    const fx = await startAgentFixture({
      registry,
      restoreService: real.service,
      restoreMax: RESTORE_MAX,
    });
    try {
      const claim = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.notEqual(claim.body?.error, ERROR_CODES.RESTORE_BACKPRESSURE);

      const chunk = await fx.requestAgent(
        'GET',
        `/agent/restore/tasks/${TASK_A}/files/0/chunks/0`,
        { headers: authHeaders(device) },
      );
      // Unconditional route oracle — no status fallback to direct service.
      assert.equal(chunk.status, 429);
      assert.equal(chunk.body?.error, ERROR_CODES.RESTORE_BACKPRESSURE);
      const ra = chunk.headers['retry-after'];
      assert.ok(ra !== undefined, 'Retry-After required on restore-backpressure');
      const n = Number(ra);
      assert.ok(Number.isInteger(n) && n >= 1 && n <= 30, `Retry-After 1..30, got ${ra}`);
    } finally {
      await held.release();
      await fx.cleanup();
    }
  });
});

describe('C7 IP limiter isolation G0c 1200 vs G0a 60 vs G0b 1200', () => {
  it('C7 restore 1200/min independent of legacy 60 and upload 1200 (real listener + real limiters)', async () => {
    const now = { t: 5_000_000 };
    const legacy = createFixedWindowRateLimiter({
      maxRequests: LEGACY_MAX,
      windowMs: 60_000,
      now: () => now.t,
    });
    const upload = createFixedWindowRateLimiter({
      maxRequests: UPLOAD_MAX,
      windowMs: 60_000,
      now: () => now.t,
    });
    const restore = createFixedWindowRateLimiter({
      maxRequests: RESTORE_MAX,
      windowMs: 60_000,
      now: () => now.t,
    });

    // Exhaust legacy 60
    for (let i = 0; i < LEGACY_MAX; i += 1) {
      assert.equal(legacy.check('127.0.0.1').allowed, true);
    }
    assert.equal(legacy.check('127.0.0.1').allowed, false);

    // Restore still fully available
    for (let i = 0; i < 100; i += 1) {
      assert.equal(restore.check('127.0.0.1').allowed, true, `restore ${i}`);
    }

    // Exhaust upload independently
    for (let i = 0; i < UPLOAD_MAX; i += 1) {
      assert.equal(upload.check('127.0.0.1').allowed, true);
    }
    assert.equal(upload.check('127.0.0.1').allowed, false);
    // Restore not affected by upload exhaustion
    assert.equal(restore.check('127.0.0.1').allowed, true);

    // Wire real listener: 128 restore claims not killed by legacy 60
    const dataDir = await makeTemp('linke-c7-ip-iso-');
    const registry = new DeviceRegistry({ dataDir });
    const device = await enroll(registry, 'device-c7-ip');
    let restoreCount = 0;
    let legacyCount = 0;
    let uploadCount = 0;
    const mockService = {
      async claim() {
        return { task: null };
      },
      async getTask() {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND, { statusCode: 404 });
      },
      async getChunk() {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND, { statusCode: 404 });
      },
      async updateProgress() {
        return { ok: true, cancelRequested: false };
      },
      async acceptReceipt() {
        return { ok: true, cleanupAuthorized: true, status: 'completed' };
      },
      async acceptCleanup() {
        return { ok: true, status: 'cleaned' };
      },
    };

    const fx = await startAgentFixture({
      registry,
      restoreService: mockService,
      rateLimit: {
        check: (k) => {
          legacyCount += 1;
          return legacy.check(k);
        },
      },
      uploadRateLimit: {
        check: (k) => {
          uploadCount += 1;
          return upload.check(k);
        },
      },
      restoreRateLimit: {
        check: (k) => {
          restoreCount += 1;
          return restore.check(k);
        },
      },
    });

    try {
      for (let i = 0; i < 128; i += 1) {
        const res = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
          body: '{}',
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assert.notEqual(
          res.status === 429 && res.body?.error === ERROR_CODES.DEVICE_RATE_LIMITED,
          true,
          `claim ${i + 1} must not hit legacy/upload limiter`,
        );
        assert.equal(legacyCount, 0, 'legacy limiter must not run on restore routes');
        assert.equal(uploadCount, 0, 'upload limiter must not run on restore routes');
      }
      assert.equal(restoreCount, 128);
    } finally {
      await fx.cleanup();
    }
  });

  it('C7 1201st restore request is device-rate-limited with bounded Retry-After', async () => {
    const now = { t: 9_000_000 };
    const restoreLimiter = createFixedWindowRateLimiter({
      maxRequests: RESTORE_MAX,
      windowMs: 60_000,
      now: () => now.t,
    });
    const dataDir = await makeTemp('linke-c7-ip-1201-');
    const registry = new DeviceRegistry({ dataDir });
    const device = await enroll(registry, 'device-c7-1201');
    let calls = 0;
    const mockService = {
      async claim() {
        calls += 1;
        return { task: null };
      },
      async getTask() {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND, { statusCode: 404 });
      },
      async getChunk() {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND, { statusCode: 404 });
      },
      async updateProgress() {
        return { ok: true, cancelRequested: false };
      },
      async acceptReceipt() {
        return { ok: true, cleanupAuthorized: true, status: 'completed' };
      },
      async acceptCleanup() {
        return { ok: true, status: 'cleaned' };
      },
    };
    const fx = await startAgentFixture({
      registry,
      restoreService: mockService,
      restoreRateLimit: restoreLimiter,
      rateLimit: createFixedWindowRateLimiter({
        maxRequests: LEGACY_MAX,
        windowMs: 60_000,
        now: () => now.t,
      }),
      uploadRateLimit: createFixedWindowRateLimiter({
        maxRequests: UPLOAD_MAX,
        windowMs: 60_000,
        now: () => now.t,
      }),
    });
    try {
      for (let i = 0; i < RESTORE_MAX; i += 1) {
        const res = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
          body: '{}',
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assert.notEqual(res.body?.error, ERROR_CODES.DEVICE_RATE_LIMITED);
      }
      const denied = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(denied.status, 429);
      assert.equal(denied.body?.error, ERROR_CODES.DEVICE_RATE_LIMITED);
      const ra = denied.headers['retry-after'];
      assert.ok(ra !== undefined);
      const n = Number(ra);
      assert.ok(Number.isInteger(n) && n >= 1 && n <= 30);
      // pre-auth deny: service not called for the denied request
      assert.equal(calls, RESTORE_MAX);
    } finally {
      await fx.cleanup();
    }
  });
});
