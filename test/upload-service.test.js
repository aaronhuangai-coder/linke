/**
 * C5 — Upload service orchestration (pure domain; no HTTP routes).
 * Authority: design §12 / plan C5 P1-1 + P1-2 + 附录 D.
 *
 * Frozen public surface:
 *   createUploadService({
 *     dataDir, store, locks, ingest, commit, now, // now required
 *     findActiveRestore?, // optional; default async () => false (C5 compat)
 *   })
 *     → frozen object with EXACTLY five methods:
 *       create / status / putChunk / finalize / abort
 *
 * Live-binary slot ownership (P1-1 — shared with restore getChunk):
 *   create   → locks.runDevice only; NO runTransfer
 *   status   → no runTransfer
 *   putChunk → runTransfer then runSession (ONLY upload binary slot holder)
 *   finalize → runSession then runSnapshot; NO runTransfer
 *   abort    → runSession only; NO runTransfer
 * When all 4 global slots held: create/status/finalize/abort must NOT fail with
 * upload-backpressure; putChunk MUST.
 *
 * Bidirectional admission (P1-2):
 *   create enters ONE locks.runDevice(deviceId, cb); inside that same callback
 *   await findActiveRestore; if true → LinkeError(UPLOAD_SESSION_CONFLICT);
 *   else existing active-upload check + createSession in same critical section.
 *
 * Production exposure (C5): default createAgentListener still 404 on all
 * /agent/upload/* typical paths (behavior test; no source string scan).
 * No public restore routes in C5.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';
import {
  createUploadSessionStore,
  UPLOAD_CHUNK_SIZE,
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
import { safeDevicePath } from '../src/storage.js';
import {
  createAgentListener,
} from '../src/agent-listener.js';
import { DeviceRegistry } from '../src/device-registry.js';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../src/tls-identity-store.js';
import https from 'node:https';

const DEVICE_A = 'device-alpha-001';
const DEVICE_B = 'device-beta-002';
const SNAPSHOT_A = '550e8400-e29b-41d4-a716-446655440000';
const SNAPSHOT_B = '550e8400-e29b-41d4-a716-446655440001';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const T0 = '2026-07-22T12:00:00.000Z';
const TOKEN = 'test-device-token-not-a-secret-fixture';
const MI64 = 64 * 1024 * 1024;

/** Fixed constructor fail-closed message for service deps. */
const INVALID_SERVICE_OPTIONS = 'invalid createUploadService options';

const SERVICE_METHODS = Object.freeze([
  'abort',
  'create',
  'finalize',
  'putChunk',
  'status',
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

async function yieldTurns(n = 8) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/**
 * Wait until predicate. Must interleave setImmediate so FS I/O / macrotasks
 * (e.g. store.getSession) can progress — pure microtask spinning starves disk
 * and false-reports "barrier timeout: … entered" before inject hooks run.
 * @param {() => boolean} predicate
 * @param {string} label
 * @param {{ pending?: Promise<unknown>, maxTurns?: number }} [opts]
 */
async function waitUntil(predicate, label, opts = {}) {
  const maxTurns = opts.maxTurns ?? 5_000;
  const pending = opts.pending;
  /** @type {{ settled: boolean, error: unknown, ok: boolean }} */
  const track = { settled: false, error: undefined, ok: false };
  if (pending != null && typeof pending.then === 'function') {
    Promise.resolve(pending).then(
      () => {
        track.settled = true;
        track.ok = true;
      },
      (err) => {
        track.settled = true;
        track.error = err;
      },
    );
  }
  for (let i = 0; i < maxTurns; i += 1) {
    if (predicate()) return;
    if (track.settled) {
      if (track.error !== undefined) throw track.error;
      assert.fail(`${label}: operation settled before target stage entered`);
    }
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }
  if (track.settled && track.error !== undefined) throw track.error;
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

/**
 * @param {{
 *   deviceId?: string,
 *   snapshotId?: string,
 *   files?: { path: string, size: number, content?: string | Buffer }[],
 *   hostname?: string,
 *   sourcePath?: string,
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
  /** @type {Record<string, unknown>} */
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
  if (opts.hostname !== undefined) input.hostname = opts.hostname;
  if (opts.sourcePath !== undefined) input.sourcePath = opts.sourcePath;
  const { manifest, manifestDigest } = projectCanonicalUploadManifest(input, {
    authenticatedDeviceId: deviceId,
  });
  return { manifest, manifestDigest, entries, totalBytes, deviceId, snapshotId };
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
 * Real ingest/commit wiring for integration paths.
 * Capacity preflight injects always-passing statfs unless overridden.
 */
function realIngest() {
  return { parseChunkHeaders, ingestChunkBody, commitChunk };
}

function realCommit(statfs = mockStatfsPlenty()) {
  return {
    preflightCapacity: (dir, totalBytes, options = {}) =>
      preflightCapacity(dir, totalBytes, {
        ...options,
        deps: { ...(options.deps || {}), statfs: options.deps?.statfs ?? statfs },
      }),
    verifyAndCommitSession,
  };
}

function makeStore() {
  return createUploadSessionStore({
    dataDir,
    now: () => clock.now(),
    randomUUID: () => uuidSeq.next(),
  });
}

function makeService(overrides = {}) {
  const store = overrides.store ?? makeStore();
  const locks = overrides.locks ?? createUploadLocks({ maxGlobalTransfers: overrides.maxGlobalTransfers ?? 4 });
  const ingest = overrides.ingest ?? realIngest();
  const commit = overrides.commit ?? realCommit(overrides.statfs);
  const now = overrides.now ?? (() => clock.now());
  /** @type {Record<string, unknown>} */
  const opts = {
    dataDir: overrides.dataDir ?? dataDir,
    store,
    locks,
    ingest,
    commit,
    now,
  };
  // Optional C5 P1-2 probe: only forward when caller supplies it (default lives in production).
  if (Object.prototype.hasOwnProperty.call(overrides, 'findActiveRestore')) {
    opts.findActiveRestore = overrides.findActiveRestore;
  }
  const service = createUploadService(/** @type {any} */ (opts));
  return { service, store, locks, ingest, commit };
}

/**
 * Wrap real locks with transfer/device call counters for P1-1 / P1-2 spies.
 * @param {ReturnType<typeof createUploadLocks>} base
 */
function spyLocks(base) {
  /** @type {{ transfer: number, device: number, session: number, snapshot: number }} */
  const counts = { transfer: 0, device: 0, session: 0, snapshot: 0 };
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
    runSession: async (d, u, fn) => {
      counts.session += 1;
      order.push('session');
      return base.runSession(d, u, fn);
    },
    runSnapshot: async (d, s, fn) => {
      counts.snapshot += 1;
      order.push('snapshot');
      return base.runSnapshot(d, s, fn);
    },
  };
  return { locks, counts, order };
}

/**
 * Hold N global transfer slots open until release() is called.
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
  await waitUntil(() => started === n, `${n} global slots held`);
  return {
    release: async () => {
      for (const g of gates) g.resolve();
      await Promise.all(held);
    },
  };
}

function sessionDirAbs(deviceId, uploadId) {
  const { deviceRel } = safeDevicePath(dataDir, deviceId);
  return join(dataDir, deviceRel, 'upload-sessions', uploadId);
}

function stagingChunkAbs(deviceId, uploadId, fileIndex, chunkIndex) {
  return join(
    sessionDirAbs(deviceId, uploadId),
    '.staging',
    'files',
    String(fileIndex),
    `chunk-${chunkIndex}.part`,
  );
}

function stagingRootAbs(deviceId, uploadId) {
  return join(sessionDirAbs(deviceId, uploadId), '.staging');
}

function finalCompletedAbs(deviceId, snapshotId) {
  const { deviceRel } = safeDevicePath(dataDir, deviceId);
  return join(dataDir, deviceRel, 'snapshots', snapshotId, 'COMPLETED.json');
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build request-like object for putChunk (C6 shape).
 * @param {object} opts
 */
function makeChunkRequest(opts) {
  const uploadId = opts.uploadId;
  const content = opts.content;
  const size = content.length;
  const sha256 = createHash('sha256').update(content).digest('hex');
  const pairs = [
    ['Authorization', opts.authorization ?? `Bearer ${TOKEN}`],
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
    sha256,
    size,
  };
}

function assertSafeSummary(summary, leakTokens = []) {
  assert.ok(summary && typeof summary === 'object');
  const forbidden = [
    'path',
    'paths',
    'host',
    'hostname',
    'sourcePath',
    'token',
    'authorization',
    'ip',
    'ipAddress',
    'dataDir',
    'stagingPath',
    'absolutePath',
  ];
  for (const k of forbidden) {
    assert.equal(summary[k], undefined, `summary must not include ${k}`);
  }
  const text = JSON.stringify(summary);
  for (const t of leakTokens) {
    if (!t || t.length < 2) continue;
    assert.ok(!text.includes(t), `summary must not leak ${t}`);
  }
  // Required safe identity fields when present.
  if (summary.uploadId !== undefined) assert.equal(typeof summary.uploadId, 'string');
  if (summary.status !== undefined) assert.equal(typeof summary.status, 'string');
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'linke-c5-svc-'));
  clock = createClock(T0);
  uuidSeq = createUuidSeq();
});

afterEach(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

// ── A. Constructor strict deps ──────────────────────────────────────

describe('A createUploadService constructor', () => {
  it('returns frozen object with exactly five methods; no extra surface', () => {
    const { service } = makeService();
    assert.ok(Object.isFrozen(service));
    const keys = Object.keys(service).sort();
    assert.deepEqual(keys, [...SERVICE_METHODS].sort());
    for (const m of SERVICE_METHODS) {
      assert.equal(typeof service[m], 'function');
    }
    // Must not expose raw deps / paths on the service object.
    for (const bad of ['dataDir', 'store', 'locks', 'ingest', 'commit', 'now', '_store']) {
      assert.equal(Object.prototype.hasOwnProperty.call(service, bad), false);
    }
  });

  it('rejects illegal dataDir / store / locks / ingest / commit / now shapes fail-closed', () => {
    const base = {
      dataDir,
      store: makeStore(),
      locks: createUploadLocks({ maxGlobalTransfers: 2 }),
      ingest: realIngest(),
      commit: realCommit(),
      now: () => clock.now(),
    };

    const cases = [
      { label: 'missing all', opts: null },
      { label: 'array', opts: [] },
      { label: 'string', opts: 'x' },
      { label: 'empty dataDir', opts: { ...base, dataDir: '' } },
      { label: 'non-string dataDir', opts: { ...base, dataDir: 12 } },
      { label: 'null dataDir', opts: { ...base, dataDir: null } },
      { label: 'missing store', opts: { ...base, store: undefined } },
      { label: 'store not object', opts: { ...base, store: 's' } },
      { label: 'store missing createSession', opts: { ...base, store: { getSession() {} } } },
      { label: 'missing locks', opts: { ...base, locks: null } },
      { label: 'locks missing runTransfer', opts: { ...base, locks: { runDevice() {}, runSession() {}, runSnapshot() {}, maxGlobalTransfers: 4 } } },
      { label: 'ingest not object', opts: { ...base, ingest: null } },
      { label: 'ingest missing parseChunkHeaders', opts: { ...base, ingest: { ingestChunkBody, commitChunk } } },
      { label: 'commit missing preflightCapacity', opts: { ...base, commit: { verifyAndCommitSession } } },
      { label: 'commit missing verifyAndCommitSession', opts: { ...base, commit: { preflightCapacity } } },
      { label: 'now not function', opts: { ...base, now: 'now' } },
      { label: 'now null', opts: { ...base, now: null } },
    ];

    for (const c of cases) {
      let threw = false;
      try {
        createUploadService(/** @type {any} */ (c.opts));
      } catch (err) {
        threw = true;
        assert.ok(err instanceof Error, c.label);
        // Fixed sanitized message; never runtime backpressure for config.
        if (err instanceof LinkeError) {
          assert.notEqual(err.code, ERROR_CODES.UPLOAD_BACKPRESSURE, c.label);
        }
        assert.equal(
          /** @type {Error} */ (err).message,
          INVALID_SERVICE_OPTIONS,
          c.label,
        );
        // Must not echo process paths / dataDir / secrets in message.
        const msg = /** @type {Error} */ (err).message;
        assert.ok(!msg.includes(String(dataDir)));
        assert.ok(!msg.includes(TOKEN));
      }
      assert.ok(threw, `must fail-closed: ${c.label}`);
    }
  });

  it('does not read global process paths / cwd for dataDir; only explicit dep', async () => {
    // Construct with explicit temp dataDir; service must not invent process.cwd() trees.
    const { service } = makeService();
    const proj = makeProjection({ files: [{ path: 'x.txt', size: 0 }] });
    await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    // Sessions land under provided dataDir only.
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const sessions = join(dataDir, deviceRel, 'upload-sessions');
    assert.equal(await pathExists(sessions), true);
    // Must not have created sibling under cwd named like dataDir default.
    // (Presence under our temp is enough; no process.env / HOME inspection.)
    assert.ok(dataDir.startsWith(tmpdir()) || dataDir.includes('linke-c5-svc-'));
  });
});

// ── B. create ───────────────────────────────────────────────────────

describe('B create', () => {
  it('projects canonical manifest, preflightCapacity then createSession; returns safe summary', async () => {
    /** @type {string[]} */
    const order = [];
    const store = makeStore();
    const realCreate = store.createSession.bind(store);
    store.createSession = async (input) => {
      order.push('createSession');
      return realCreate(input);
    };
    const commit = {
      preflightCapacity: async (dir, totalBytes) => {
        order.push('preflight');
        assert.equal(dir, dataDir);
        assert.equal(typeof totalBytes, 'number');
        assert.ok(Number.isSafeInteger(totalBytes));
      },
      verifyAndCommitSession: async () => {
        throw new Error('unexpected finalize');
      },
    };
    const { service } = makeService({ store, commit });
    const proj = makeProjection({
      files: [{ path: 'hello.txt', size: 5, content: 'hello' }],
    });
    const summary = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    assert.deepEqual(order, ['preflight', 'createSession']);
    assert.equal(summary.status, 'initialized');
    assert.equal(summary.snapshotId, SNAPSHOT_A);
    assert.equal(summary.manifestDigest, proj.manifestDigest);
    assert.equal(typeof summary.uploadId, 'string');
    assertSafeSummary(summary, [dataDir, 'hello.txt', TOKEN, 'sourcePath']);
  });

  it('capacity failure does not create session or upload-sessions tree', async () => {
    const commit = {
      preflightCapacity: async () => {
        throw new LinkeError(ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT);
      },
      verifyAndCommitSession: async () => {},
    };
    const store = makeStore();
    let createCalls = 0;
    const realCreate = store.createSession.bind(store);
    store.createSession = async (input) => {
      createCalls += 1;
      return realCreate(input);
    };
    const { service } = makeService({ store, commit });
    const proj = makeProjection();
    await assert.rejects(
      () =>
        service.create({
          authenticatedDeviceId: DEVICE_A,
          manifest: proj.manifest,
          claimedManifestDigest: proj.manifestDigest,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT, {
          statusCode: 507,
          retryable: false,
          leakTokens: [dataDir, 'statfs', 'ENOSPC'],
        });
        return true;
      },
    );
    assert.equal(createCalls, 0);
    // No device tree required; if present must have zero sessions.
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const sessionsRoot = join(dataDir, deviceRel, 'upload-sessions');
    if (await pathExists(sessionsRoot)) {
      assert.deepEqual(await readdir(sessionsRoot), []);
    }
  });

  it('same device second active → upload-session-conflict + safe locator; abort then create ok', async () => {
    const { service } = makeService();
    const proj1 = makeProjection({ snapshotId: SNAPSHOT_A, files: [{ path: 'a.txt', size: 0 }] });
    const first = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj1.manifest,
      claimedManifestDigest: proj1.manifestDigest,
    });

    const proj2 = makeProjection({ snapshotId: SNAPSHOT_B, files: [{ path: 'b.txt', size: 0 }] });
    await assert.rejects(
      () =>
        service.create({
          authenticatedDeviceId: DEVICE_A,
          manifest: proj2.manifest,
          claimedManifestDigest: proj2.manifestDigest,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_SESSION_CONFLICT, {
          statusCode: 409,
          retryable: false,
          leakTokens: [dataDir, 'repo/devices', TOKEN, '/secret'],
        });
        assert.ok(err.details && err.details.active);
        assert.deepEqual(err.details.active, {
          uploadId: first.uploadId,
          status: 'initialized',
          snapshotId: SNAPSHOT_A,
          manifestDigest: proj1.manifestDigest,
        });
        // Locator only those four fields.
        assert.deepEqual(Object.keys(err.details.active).sort(), [
          'manifestDigest',
          'snapshotId',
          'status',
          'uploadId',
        ]);
        return true;
      },
    );

    const aborted = await service.abort({
      authenticatedDeviceId: DEVICE_A,
      uploadId: first.uploadId,
    });
    assert.equal(aborted.status, 'aborted');

    const second = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj2.manifest,
      claimedManifestDigest: proj2.manifestDigest,
    });
    assert.equal(second.status, 'initialized');
    assert.notEqual(second.uploadId, first.uploadId);
    assert.equal(second.snapshotId, SNAPSHOT_B);
  });

  it('manifest deviceId mismatch → upload-manifest-invalid (unique); no session', async () => {
    const { service, store } = makeService();
    const proj = makeProjection({ deviceId: DEVICE_A });
    // Claim authenticated as B while manifest pins A.
    await assert.rejects(
      () =>
        service.create({
          authenticatedDeviceId: DEVICE_B,
          manifest: proj.manifest,
          claimedManifestDigest: proj.manifestDigest,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_MANIFEST_INVALID, {
          statusCode: 400,
          retryable: false,
          leakTokens: [dataDir, DEVICE_A, DEVICE_B],
        });
        return true;
      },
    );
    assert.equal(await store.findActiveSession(DEVICE_B), null);
    assert.equal(await store.findActiveSession(DEVICE_A), null);
  });

  it('claimed digest mismatch → upload-manifest-invalid; no session', async () => {
    const { service } = makeService();
    const proj = makeProjection();
    const wrong = 'a'.repeat(64);
    assert.notEqual(wrong, proj.manifestDigest);
    await assert.rejects(
      () =>
        service.create({
          authenticatedDeviceId: DEVICE_A,
          manifest: proj.manifest,
          claimedManifestDigest: wrong,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_MANIFEST_INVALID, {
          statusCode: 400,
          leakTokens: [wrong, proj.manifestDigest, dataDir],
        });
        return true;
      },
    );
  });

  it('P1-1: create does NOT take global transfer slot; works while slots full', async () => {
    // C5: create is runDevice-only (admission + createSession). Global full must
    // never yield upload-backpressure on create.
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    const held = await holdGlobalSlots(locks, 1);

    let createCalls = 0;
    let preflightCalls = 0;
    const store = makeStore();
    const realCreate = store.createSession.bind(store);
    store.createSession = async (input) => {
      createCalls += 1;
      return realCreate(input);
    };
    const commit = {
      preflightCapacity: async () => {
        preflightCalls += 1;
      },
      verifyAndCommitSession: async () => {},
    };
    const { service } = makeService({ store, locks, commit });
    const proj = makeProjection();
    const summary = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    assert.equal(summary.status, 'initialized');
    assert.equal(createCalls, 1);
    assert.equal(preflightCalls, 1);
    assert.equal(typeof summary.uploadId, 'string');

    await held.release();
  });
});

// ── C. status ───────────────────────────────────────────────────────

describe('C status', () => {
  it('calls store.getSession with only authenticatedDeviceId+uploadId; returns safe summary', async () => {
    const { service, store } = makeService();
    const proj = makeProjection({
      files: [{ path: 's.txt', size: 0 }],
      hostname: 'must-not-leak-host.example',
      sourcePath: '/secret/source/path',
    });
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    /** @type {unknown[]} */
    const getArgs = [];
    const realGet = store.getSession.bind(store);
    store.getSession = async (input) => {
      getArgs.push(input);
      return realGet(input);
    };

    const summary = await service.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(getArgs.length, 1);
    assert.deepEqual(Object.keys(/** @type {object} */ (getArgs[0])).sort(), [
      'authenticatedDeviceId',
      'uploadId',
    ]);
    assert.deepEqual(getArgs[0], {
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(summary.uploadId, created.uploadId);
    assert.equal(summary.status, 'initialized');
    assertSafeSummary(summary, [
      dataDir,
      'must-not-leak-host.example',
      '/secret/source/path',
      TOKEN,
    ]);
  });

  it('cross-device / missing → upload-session-not-found pass-through', async () => {
    const { service } = makeService();
    const proj = makeProjection();
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    await assert.rejects(
      () =>
        service.status({
          authenticatedDeviceId: DEVICE_B,
          uploadId: created.uploadId,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_SESSION_NOT_FOUND, {
          statusCode: 404,
          leakTokens: [dataDir, DEVICE_A, created.uploadId],
        });
        return true;
      },
    );

    await assert.rejects(
      () =>
        service.status({
          authenticatedDeviceId: DEVICE_A,
          uploadId: 'bbbbbbbb-bbbb-4ccc-8ddd-000000000099',
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_SESSION_NOT_FOUND, { statusCode: 404 });
        return true;
      },
    );
  });

  it('status does NOT occupy global transfer slot (works while global full)', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    const gate = deferred();
    const started = deferred();
    const held = locks.runTransfer(async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;

    // Create needs global — do it before filling... so create first then fill.
    // Re-test: create session with free locks, then fill global, status still works.
    gate.resolve();
    await held;

    const { service } = makeService({ locks });
    const proj = makeProjection();
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    const gate2 = deferred();
    const started2 = deferred();
    const held2 = locks.runTransfer(async () => {
      started2.resolve();
      await gate2.promise;
    });
    await started2.promise;

    const summary = await service.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(summary.uploadId, created.uploadId);
    assert.equal(summary.status, 'initialized');

    gate2.resolve();
    await held2;
  });
});

// ── D. putChunk ─────────────────────────────────────────────────────

describe('D putChunk', () => {
  it('success path: parse → getSession → ingest body → hash → commitChunk; staging path fixed', async () => {
    const { service } = makeService();
    const content = Buffer.from('chunk-bytes-ok');
    const proj = makeProjection({
      files: [{ path: 'file.bin', size: content.length, content }],
    });
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    const { request, stream } = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content,
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
    });

    const result = await service.putChunk({
      authenticatedDeviceId: DEVICE_A,
      request,
      stream,
    });
    assert.ok(result);
    assertSafeSummary(result, [dataDir, 'file.bin', TOKEN, '/Users']);

    const part = stagingChunkAbs(DEVICE_A, created.uploadId, 0, 0);
    assert.equal(await pathExists(part), true);
    const onDisk = await readFile(part);
    assert.deepEqual(onDisk, content);

    // Relative layout under dataDir only (slug from safeDevicePath).
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const expectedRel = join(
      deviceRel,
      'upload-sessions',
      created.uploadId,
      '.staging',
      'files',
      '0',
      'chunk-0.part',
    );
    assert.equal(join(dataDir, expectedRel), part);
    // Must not create client-path-named dirs.
    assert.equal(await pathExists(join(sessionDirAbs(DEVICE_A, created.uploadId), 'file.bin')), false);
  });

  it('global full → immediate backpressure; does not read stream or lookup session', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    // First create a real session with free capacity.
    const { service: bootstrap } = makeService({ locks: createUploadLocks({ maxGlobalTransfers: 4 }) });
    const content = Buffer.from('xx');
    const proj = makeProjection({
      files: [{ path: 'p.bin', size: 2, content }],
    });
    const created = await bootstrap.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    // Wire service with saturated locks + instrumented store/ingest.
    const store = makeStore();
    // Ensure getSession would work if called (session exists on disk from bootstrap).
    let getCalls = 0;
    const realGet = store.getSession.bind(store);
    store.getSession = async (input) => {
      getCalls += 1;
      return realGet(input);
    };

    let parseCalls = 0;
    let ingestCalls = 0;
    const ingest = {
      parseChunkHeaders: (req) => {
        parseCalls += 1;
        return parseChunkHeaders(req);
      },
      ingestChunkBody: (stream, options) => {
        ingestCalls += 1;
        return ingestChunkBody(stream, options);
      },
      commitChunk,
    };

    const gate = deferred();
    const started = deferred();
    const held = locks.runTransfer(async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;

    const { service } = makeService({ store, locks, ingest });
    let streamRead = false;
    const { request } = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content,
    });
    const stream = new Readable({
      read() {
        streamRead = true;
        this.push(content);
        this.push(null);
      },
    });

    await assert.rejects(
      () =>
        service.putChunk({
          authenticatedDeviceId: DEVICE_A,
          request,
          stream,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
        });
        return true;
      },
    );
    assert.equal(getCalls, 0, 'no session lookup when global full');
    assert.equal(parseCalls, 0, 'no header parse when global full');
    assert.equal(ingestCalls, 0, 'no body ingest when global full');
    assert.equal(streamRead, false, 'must not read stream when global full');

    gate.resolve();
    await held;
  });

  it('failure releases global slot (sync path after acquire)', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    const { service } = makeService({ locks });
    const content = Buffer.from('ab');
    const proj = makeProjection({
      files: [{ path: 'z.bin', size: 2, content }],
    });
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    // Invalid headers → fail after acquiring transfer; slot must free.
    const badRequest = {
      rawHeaders: ['Content-Length', '2'], // missing critical headers
      url: `/agent/upload/sessions/${created.uploadId}/chunks`,
    };
    await assert.rejects(
      () =>
        service.putChunk({
          authenticatedDeviceId: DEVICE_A,
          request: badRequest,
          stream: Readable.from([content]),
        }),
      (err) => {
        assert.ok(err instanceof LinkeError);
        assert.equal(err.message, err.code);
        return true;
      },
    );

    // Global free again → create-equivalent transfer (status is free; use putChunk retry with valid).
    const { request, stream } = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content,
    });
    const ok = await service.putChunk({
      authenticatedDeviceId: DEVICE_A,
      request,
      stream,
    });
    assert.ok(ok);
  });

  it('never composes disk path from client path header/body fields', async () => {
    const { service } = makeService();
    const content = Buffer.from('data!!');
    // Manifest path is nested; staging must still use fileIndex only.
    const proj = makeProjection({
      files: [{ path: 'nested/deep/secret.bin', size: content.length, content }],
    });
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    const { request, stream } = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content,
    });
    await service.putChunk({
      authenticatedDeviceId: DEVICE_A,
      request,
      stream,
    });
    const part = stagingChunkAbs(DEVICE_A, created.uploadId, 0, 0);
    assert.equal(await pathExists(part), true);
    assert.equal(
      await pathExists(join(sessionDirAbs(DEVICE_A, created.uploadId), 'nested')),
      false,
    );
    assert.equal(
      await pathExists(join(stagingRootAbs(DEVICE_A, created.uploadId), 'nested')),
      false,
    );
  });

  it('rejects unsafe identity.fileIndex/chunkIndex before store/body/commit/I/O (ingest inject boundary)', async () => {
    const content = Buffer.from('idx-guard-chunk');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const baseIdentity = Object.freeze({
      uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000099',
      snapshotId: SNAPSHOT_A,
      manifestDigest: ZERO_SHA,
      deviceId: DEVICE_A,
      fileIndex: 0,
      chunkIndex: 0,
      offset: 0,
      size: content.length,
      sha256,
    });

    const invalidValues = Object.freeze([
      '../../snapshots/x',
      -1,
      0.5,
      undefined,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]);
    /** @type {{ field: 'fileIndex' | 'chunkIndex', value: unknown, label: string }[]} */
    const cases = [];
    for (const field of /** @type {const} */ (['fileIndex', 'chunkIndex'])) {
      for (const value of invalidValues) {
        let shown;
        if (value === undefined) shown = 'undefined';
        else if (typeof value === 'number' && Number.isNaN(value)) shown = 'NaN';
        else if (value === Infinity) shown = 'Infinity';
        else shown = JSON.stringify(value);
        cases.push({ field, value, label: `${field}=${shown}` });
      }
    }

    const store = makeStore();
    let getCalls = 0;
    const realGet = store.getSession.bind(store);
    store.getSession = async (input) => {
      getCalls += 1;
      return realGet(input);
    };

    /** @type {Record<string, unknown>} */
    let identityForParse = { ...baseIdentity };
    let ingestCalls = 0;
    let commitCalls = 0;
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    const ingest = {
      parseChunkHeaders: () => identityForParse,
      ingestChunkBody: (stream, options) => {
        ingestCalls += 1;
        return ingestChunkBody(stream, options);
      },
      commitChunk: async (args) => {
        commitCalls += 1;
        return commitChunk(args);
      },
    };
    const { service } = makeService({ store, locks, ingest });

    for (const c of cases) {
      getCalls = 0;
      ingestCalls = 0;
      commitCalls = 0;
      identityForParse = { ...baseIdentity, [c.field]: c.value };

      let streamRead = false;
      const stream = new Readable({
        read() {
          streamRead = true;
          this.push(content);
          this.push(null);
        },
      });

      await assert.rejects(
        () =>
          service.putChunk({
            authenticatedDeviceId: DEVICE_A,
            request: { rawHeaders: [] },
            stream,
          }),
        (err) => {
          assertLinkeCode(err, ERROR_CODES.UPLOAD_CHUNK_INVALID, {
            leakTokens: [dataDir, String(c.value), TOKEN, '../../snapshots'],
          });
          return true;
        },
      );

      assert.equal(getCalls, 0, `${c.label}: no store.getSession`);
      assert.equal(ingestCalls, 0, `${c.label}: no ingestChunkBody`);
      assert.equal(commitCalls, 0, `${c.label}: no commitChunk`);
      assert.equal(streamRead, false, `${c.label}: stream must not be read`);
    }

    // Fail-fast: no upload-sessions / staging tree from invalid identity indices.
    const top = await readdir(dataDir);
    assert.deepEqual(top, [], 'dataDir must stay empty before any store/I/O');
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const sessionsRoot = join(dataDir, deviceRel, 'upload-sessions');
    assert.equal(await pathExists(sessionsRoot), false);
    assert.equal(await pathExists(join(dataDir, 'repo')), false);

    // Global transfer slot released → healthy create + putChunk still runs.
    const healthy = makeService({ store, locks });
    const proj = makeProjection({
      files: [{ path: 'ok.bin', size: content.length, content }],
    });
    const created = await healthy.service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    const { request, stream: okStream } = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content,
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
    });
    const ok = await healthy.service.putChunk({
      authenticatedDeviceId: DEVICE_A,
      request,
      stream: okStream,
    });
    assert.ok(ok);
    assert.equal(await pathExists(stagingChunkAbs(DEVICE_A, created.uploadId, 0, 0)), true);
  });
});

// ── E. finalize ─────────────────────────────────────────────────────

describe('E finalize', () => {
  it('P1-1: wraps verifyAndCommitSession with session + snapshot only (no runTransfer)', async () => {
    /** @type {string[]} */
    const order = [];
    const baseLocks = createUploadLocks({ maxGlobalTransfers: 4 });
    const locks = {
      maxGlobalTransfers: baseLocks.maxGlobalTransfers,
      runTransfer: async (fn) => {
        order.push('transfer');
        return baseLocks.runTransfer(fn);
      },
      runDevice: async (id, fn) => {
        order.push('device');
        return baseLocks.runDevice(id, fn);
      },
      runSession: async (d, u, fn) => {
        order.push('session');
        return baseLocks.runSession(d, u, fn);
      },
      runSnapshot: async (d, s, fn) => {
        order.push('snapshot');
        return baseLocks.runSnapshot(d, s, fn);
      },
    };

    let commitArgs = null;
    const store = makeStore();
    const commit = {
      preflightCapacity: async () => {},
      verifyAndCommitSession: async (input) => {
        order.push('commit');
        commitArgs = input;
        // Unit lock ordering: advance to committed so post-commit re-read succeeds.
        await store.markVerifying({
          authenticatedDeviceId: DEVICE_A,
          uploadId: created.uploadId,
        });
        await store.markCommitted({
          authenticatedDeviceId: DEVICE_A,
          uploadId: created.uploadId,
        });
      },
    };

    const { service } = makeService({ locks, commit, store });
    const proj = makeProjection({ files: [{ path: 'a.txt', size: 0 }] });
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    order.length = 0;

    const fin = await service.finalize({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(fin.status, 'committed');
    assert.equal(fin.uploadId, created.uploadId);
    assert.ok(fin.missingSummary);
    assert.equal(fin.missingSummary.complete, true);

    // P1-1: finalize is runSession → runSnapshot only; never runTransfer.
    assert.equal(order.includes('transfer'), false, 'finalize must not call runTransfer');
    assert.ok(order.includes('session'));
    assert.ok(order.includes('snapshot'));
    assert.ok(order.includes('commit'));
    assert.ok(order.indexOf('session') < order.indexOf('commit'));
    assert.ok(order.indexOf('snapshot') < order.indexOf('commit'));
    assert.ok(order.indexOf('session') < order.indexOf('snapshot'));

    assert.ok(commitArgs);
    assert.equal(commitArgs.dataDir, dataDir);
    assert.equal(commitArgs.deviceId, DEVICE_A);
    assert.equal(commitArgs.uploadId, created.uploadId);
    assert.ok(commitArgs.store);
    assert.equal(typeof commitArgs.now, 'function');
  });

  it('finalize re-reads session: commit without status=committed fail-closes as upload-io-error', async () => {
    const store = makeStore();
    const commit = {
      preflightCapacity: async () => {},
      verifyAndCommitSession: async () => {
        // Pretend commit succeeded but leave session non-terminal.
      },
    };
    const { service } = makeService({ store, commit });
    const proj = makeProjection({ files: [{ path: 'z.txt', size: 0 }] });
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    await assert.rejects(
      () =>
        service.finalize({
          authenticatedDeviceId: DEVICE_A,
          uploadId: created.uploadId,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          leakTokens: [dataDir, created.uploadId],
        });
        return true;
      },
    );
  });

  it('P1-1: finalize works while global slots full (never upload-backpressure)', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    // Bootstrap session while free (create must not need transfer slot under P1-1).
    const store = makeStore();
    /** @type {string | undefined} */
    let uploadId;
    const commit = {
      preflightCapacity: async () => {},
      verifyAndCommitSession: async () => {
        assert.equal(typeof uploadId, 'string');
        await store.markVerifying({
          authenticatedDeviceId: DEVICE_A,
          uploadId,
        });
        await store.markCommitted({
          authenticatedDeviceId: DEVICE_A,
          uploadId,
        });
        return undefined;
      },
    };
    const { service } = makeService({ store, locks, commit });
    const proj = makeProjection({ files: [{ path: 'z.txt', size: 0 }] });
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    uploadId = created.uploadId;

    const held = await holdGlobalSlots(locks, 1);
    const fin = await service.finalize({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(fin.status, 'committed');
    assert.notEqual(fin?.code, ERROR_CODES.UPLOAD_BACKPRESSURE);

    await held.release();
  });

  it('errors are desensitized LinkeError (message===code); no path leak', async () => {
    const commit = {
      preflightCapacity: async () => {},
      verifyAndCommitSession: async () => {
        throw new LinkeError(ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
      },
    };
    const { service } = makeService({ commit });
    const proj = makeProjection();
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    await assert.rejects(
      () =>
        service.finalize({
          authenticatedDeviceId: DEVICE_A,
          uploadId: created.uploadId,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          leakTokens: [dataDir, created.uploadId, 'repo/devices'],
        });
        return true;
      },
    );
  });
});

// ── F. abort ────────────────────────────────────────────────────────

describe('F abort', () => {
  it('per-session serializes abortSession; aborted idempotent; committed → upload-commit-conflict', async () => {
    const { service } = makeService();
    const proj = makeProjection({ files: [{ path: 'abort-me.txt', size: 0 }] });
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    const a1 = await service.abort({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(a1.status, 'aborted');
    const a2 = await service.abort({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(a2.status, 'aborted');
    assertSafeSummary(a2, [dataDir, TOKEN]);

    // Second session: real chunk+finalize → committed, then abort must conflict.
    const content = Buffer.from('committed-body');
    const proj2 = makeProjection({
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'c.bin', size: content.length, content }],
    });
    const c2 = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj2.manifest,
      claimedManifestDigest: proj2.manifestDigest,
    });
    const { request, stream } = makeChunkRequest({
      uploadId: c2.uploadId,
      manifestDigest: proj2.manifestDigest,
      content,
      snapshotId: SNAPSHOT_B,
    });
    await service.putChunk({
      authenticatedDeviceId: DEVICE_A,
      request,
      stream,
    });
    await service.finalize({
      authenticatedDeviceId: DEVICE_A,
      uploadId: c2.uploadId,
    });
    const committed = await service.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: c2.uploadId,
    });
    assert.equal(committed.status, 'committed');

    await assert.rejects(
      () =>
        service.abort({
          authenticatedDeviceId: DEVICE_A,
          uploadId: c2.uploadId,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, {
          statusCode: 409,
          leakTokens: [dataDir, c2.uploadId],
        });
        return true;
      },
    );
  });

  it('abort does NOT take global transfer slot; works while global full; releases session key', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    const { service } = makeService({ locks });
    const proj = makeProjection();
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    const gate = deferred();
    const started = deferred();
    const held = locks.runTransfer(async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;

    // Abort must succeed without global slot.
    const aborted = await service.abort({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(aborted.status, 'aborted');

    // Session key free: another session op on same key can run after abort.
    // (status is free of global and should return aborted summary)
    const st = await service.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(st.status, 'aborted');

    gate.resolve();
    await held;
  });
});

// ── missingSummary + finalize re-read (C7 production contract) ──────

describe('missingSummary derivation + finalize re-read', () => {
  it('create/status: initial next, partial progress, then complete after all bytes', async () => {
    const content = Buffer.alloc(UPLOAD_CHUNK_SIZE + 10, 0x41);
    const proj = makeProjection({
      files: [
        { path: 'big.bin', size: content.length, content },
        { path: 'empty.txt', size: 0 },
      ],
    });
    const { service } = makeService();
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    assert.ok(created.missingSummary);
    assert.equal(created.missingSummary.complete, false);
    assert.deepEqual(created.missingSummary.next, {
      fileIndex: 0,
      chunkIndex: 0,
      offset: 0,
      size: UPLOAD_CHUNK_SIZE,
      complete: false,
    });
    assert.equal(created.missingSummary.remainingFiles, 1);
    assert.equal(created.missingSummary.remainingBytes, content.length);
    assert.equal(created.missingSummary.remainingChunks, 2);
    assert.ok(created.files, 'domain summary still has files');

    // First full chunk
    const c0 = content.subarray(0, UPLOAD_CHUNK_SIZE);
    const r0 = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content: c0,
      fileIndex: 0,
      chunkIndex: 0,
      offset: 0,
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
    });
    await service.putChunk({
      authenticatedDeviceId: DEVICE_A,
      request: r0.request,
      stream: r0.stream,
    });
    const mid = await service.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(mid.missingSummary.complete, false);
    assert.deepEqual(mid.missingSummary.next, {
      fileIndex: 0,
      chunkIndex: 1,
      offset: UPLOAD_CHUNK_SIZE,
      size: 10,
      complete: false,
    });
    assert.equal(mid.missingSummary.remainingBytes, 10);
    assert.equal(mid.missingSummary.remainingChunks, 1);

    // Last chunk
    const c1 = content.subarray(UPLOAD_CHUNK_SIZE);
    const r1 = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content: c1,
      fileIndex: 0,
      chunkIndex: 1,
      offset: UPLOAD_CHUNK_SIZE,
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
    });
    await service.putChunk({
      authenticatedDeviceId: DEVICE_A,
      request: r1.request,
      stream: r1.stream,
    });
    const done = await service.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(done.missingSummary.complete, true);
    assert.equal(done.missingSummary.next, undefined);
    assert.equal(done.missingSummary.remainingFiles, 0);
    assert.equal(done.missingSummary.remainingBytes, 0);
    assert.equal(done.missingSummary.remainingChunks, 0);
  });

  it('hostile files shape on status path fail-closes (no guessing)', async () => {
    const store = makeStore();
    const realGet = store.getSession.bind(store);
    store.getSession = async (input) => {
      const s = await realGet(input);
      // Hostile: corrupt complete flag / non-integer
      return {
        ...s,
        files: [{ fileIndex: 0, size: 1, confirmedBytes: 0, confirmedChunks: 0, complete: 'nope' }],
      };
    };
    const { service } = makeService({ store });
    const proj = makeProjection({ files: [{ path: 'a.txt', size: 1, content: 'x' }] });
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    // create used real store before override impact on create path — re-override already set.
    // status uses hostile getSession:
    await assert.rejects(
      () =>
        service.status({
          authenticatedDeviceId: DEVICE_A,
          uploadId: created.uploadId,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
  });
});

// ── G. Real temp dataDir success path (C1–C4 + locks) ───────────────

describe('G real temp dataDir create→chunk(s)→finalize', () => {
  it('real modules: create, put chunks, finalize → COMPLETED + session committed; staging intact; no HTTP', async () => {
    // Pure domain stack — no agent-listener, no ports.
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });
    const store = makeStore();
    const ingest = realIngest();
    // Inject always-passing capacity; real preflightCapacity + verifyAndCommitSession.
    const commit = realCommit(mockStatfsPlenty());
    const service = createUploadService({
      dataDir,
      store,
      locks,
      ingest,
      commit,
      now: () => clock.now(),
    });

    const content = Buffer.from('hello-g0b-c5');
    const proj = makeProjection({
      files: [{ path: 'note.txt', size: content.length, content }],
    });

    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    assert.equal(created.status, 'initialized');
    assert.equal(created.totalBytes === undefined || typeof created.totalBytes === 'number', true);

    const { request, stream } = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content,
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
    });
    const afterChunk = await service.putChunk({
      authenticatedDeviceId: DEVICE_A,
      request,
      stream,
    });
    assert.ok(['receiving', 'initialized'].includes(afterChunk.status) || afterChunk.files);
    // Boundary advanced.
    const mid = await service.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(mid.files[0].confirmedBytes, content.length);
    assert.equal(mid.files[0].complete, true);

    const fpBefore = await (async () => {
      const root = stagingRootAbs(DEVICE_A, created.uploadId);
      try {
        const names = await readdir(root, { recursive: true });
        return names.slice().sort().join('|');
      } catch {
        return '';
      }
    })();
    assert.ok(fpBefore.length > 0, 'staging must exist before finalize');

    const fin = await service.finalize({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(fin.status, 'committed');
    assert.equal(fin.uploadId, created.uploadId);
    assert.equal(fin.snapshotId, SNAPSHOT_A);
    assert.equal(fin.manifestDigest, proj.manifestDigest);
    assert.equal(fin.deviceId, DEVICE_A);
    assert.ok(fin.missingSummary);
    assert.equal(fin.missingSummary.complete, true);
    assert.equal(fin.missingSummary.next, undefined);

    const finalStatus = await service.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(finalStatus.status, 'committed');
    assert.equal(finalStatus.missingSummary.complete, true);

    // COMPLETED marker present.
    assert.equal(await pathExists(finalCompletedAbs(DEVICE_A, SNAPSHOT_A)), true);
    const completed = JSON.parse(
      await readFile(finalCompletedAbs(DEVICE_A, SNAPSHOT_A), 'utf8'),
    );
    assert.equal(completed.origin, 'remote-upload');
    assert.equal(completed.snapshotId, SNAPSHOT_A);
    assert.equal(completed.manifestDigest, proj.manifestDigest);

    // Staging not moved/deleted (fingerprint still present).
    const fpAfter = await (async () => {
      const root = stagingRootAbs(DEVICE_A, created.uploadId);
      const names = await readdir(root, { recursive: true });
      return names.slice().sort().join('|');
    })();
    assert.equal(fpAfter, fpBefore);
    assert.equal(await pathExists(stagingChunkAbs(DEVICE_A, created.uploadId, 0, 0)), true);

    // snapshots.json index upserted (device-local).
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const indexPath = join(dataDir, deviceRel, 'snapshots.json');
    assert.equal(await pathExists(indexPath), true);
  });

  it('multi-chunk file under UPLOAD_CHUNK_SIZE splits still finalize cleanly', async () => {
    // Two small sequential chunks on one file via two putChunk calls with
    // contiguous coordinates (file size 20; send as single chunk is enough —
    // multi put for two files).
    const c0 = Buffer.from('AAAAAAAAAA'); // 10
    const c1 = Buffer.from('BBBBBBBBBB'); // 10
    // Single file 20 bytes → one chunk if < 8MiB. Use two files instead.
    const f0 = Buffer.from('file0-body');
    const f1 = Buffer.from('file1-body-xx');
    const proj = makeProjection({
      files: [
        { path: 'f0.txt', size: f0.length, content: f0 },
        { path: 'f1.txt', size: f1.length, content: f1 },
      ],
    });
    const { service } = makeService();
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    // Projected entry order may sort paths — use status files order.
    // Put chunks for fileIndex 0 and 1 based on projected integrity order.
    const entries = proj.manifest.integrity.entries;
    for (let fileIndex = 0; fileIndex < entries.length; fileIndex += 1) {
      const entry = entries[fileIndex];
      const content = entry.path === 'f0.txt' ? f0 : f1;
      const { request, stream } = makeChunkRequest({
        uploadId: created.uploadId,
        manifestDigest: proj.manifestDigest,
        content,
        fileIndex,
        chunkIndex: 0,
        offset: 0,
        snapshotId: SNAPSHOT_A,
      });
      await service.putChunk({
        authenticatedDeviceId: DEVICE_A,
        request,
        stream,
      });
    }

    await service.finalize({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    const st = await service.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(st.status, 'committed');
    assert.equal(await pathExists(finalCompletedAbs(DEVICE_A, SNAPSHOT_A)), true);
    // silence unused
    assert.ok(c0 && c1 && UPLOAD_CHUNK_SIZE > 0);
  });
});

// ── H. Production exposure: default listener still 404 upload paths ─

describe('H production exposure — agent-listener upload paths still 404', () => {
  it('default createAgentListener: all typical /agent/upload/* routes 404 device-route-not-found', async () => {
    // Behavior test only — C5 must not register routes. No source scanning.
    const tmp = await mkdtemp(join(tmpdir(), 'linke-c5-listener-'));
    const registry = new DeviceRegistry({ dataDir: tmp });
    const { keyPem } = generateControllerPrivateKey();
    const certPem = await createOpenSslCertificate({
      keyPem,
      san: 'IP:127.0.0.1',
    });
    const server = createAgentListener({
      identity: { keyPem, certPem },
      registry,
      onHeartbeat: async () => {},
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    /**
     * @param {string} method
     * @param {string} path
     * @param {string} [body]
     */
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

    const uploadId = randomUUID();
    const paths = [
      ['POST', '/agent/upload/sessions', JSON.stringify({ schemaVersion: 2 })],
      ['GET', `/agent/upload/sessions/${uploadId}`],
      ['POST', `/agent/upload/sessions/${uploadId}/chunks`, 'xx'],
      ['POST', `/agent/upload/sessions/${uploadId}/finalize`, '{}'],
      ['POST', `/agent/upload/sessions/${uploadId}/abort`, '{}'],
      ['POST', '/agent/upload'],
      ['GET', '/agent/upload/sessions'],
    ];

    try {
      for (const [method, path, body] of paths) {
        const res = await request(method, path, body);
        assert.equal(res.status, 404, `${method} ${path} must 404`);
        assert.equal(
          res.body && res.body.error,
          ERROR_CODES.DEVICE_ROUTE_NOT_FOUND,
          `${method} ${path} error code`,
        );
      }
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── H. Request AbortSignal propagation + cooperative cancel (P0) ────

describe('H AbortSignal propagation and cooperative cancel (RED)', () => {
  /**
   * @param {unknown} value
   * @param {string} label
   */
  function assertSignal(value, label) {
    assert.ok(value != null && typeof value === 'object', `${label}: signal required`);
    assert.equal(typeof /** @type {AbortSignal} */ (value).aborted, 'boolean', label);
    return /** @type {AbortSignal} */ (value);
  }

  it('create propagates signal to store.createSession; aborted after barrier does not createSession', async () => {
    const ac = new AbortController();
    const gate = deferred();
    let createSessionCalls = 0;
    /** @type {unknown} */
    let createSessionSignal = undefined;
    const base = makeStore();
    const realCreate = base.createSession.bind(base);
    base.createSession = async (input) => {
      createSessionCalls += 1;
      createSessionSignal = input?.signal;
      await gate.promise;
      // Cooperative cancel: any sanitized Error is acceptable; refuse mutation.
      if (input?.signal?.aborted) {
        throw new Error('aborted');
      }
      return realCreate(input);
    };
    const { service } = makeService({ store: base });
    const proj = makeProjection();

    const pending = service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
      signal: ac.signal,
    });
    try {
      await waitUntil(() => createSessionCalls === 1, 'createSession entered', { pending });
      assertSignal(createSessionSignal, 'createSession input.signal');
      assert.equal(/** @type {AbortSignal} */ (createSessionSignal).aborted, false);
      assert.equal(createSessionSignal, ac.signal, 'same signal instance to createSession');

      ac.abort();
      gate.resolve();
      await assert.rejects(() => pending, (err) => err instanceof Error);

      // No session directory / no successful create.
      const sessionsRoot = join(
        dataDir,
        safeDevicePath(dataDir, DEVICE_A).deviceRel,
        'upload-sessions',
      );
      let names = [];
      try {
        names = await readdir(sessionsRoot);
      } catch {
        names = [];
      }
      assert.equal(names.length, 0, 'aborted create must not leave session on disk');
      assert.equal(createSessionCalls, 1);
    } finally {
      ac.abort();
      gate.resolve();
      pending.catch(() => {});
    }
  });

  it('putChunk propagates signal to ingestChunkBody + commitChunk + store advance; abort blocks tempPublish/advance', async () => {
    const ac = new AbortController();
    const content = Buffer.from('abcd');
    const proj = makeProjection({
      files: [{ path: 'a.txt', size: content.length, content }],
    });
    // Use service.create so session layout matches the working putChunk paths
    // (global transfer + capacity preflight + store identity).
    const store = makeStore();
    const { service: bootstrap } = makeService({ store });
    const created = await bootstrap.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    const publishGate = deferred();
    let ingestEntered = false;
    let commitEntered = false;
    /** @type {unknown} */
    let ingestSignal = undefined;
    /** @type {unknown} */
    let commitSignal = undefined;
    let advanceCalls = 0;
    let tempPublishCompleted = false;

    const realAdvance = store.advanceBoundary.bind(store);
    store.advanceBoundary = async (input) => {
      advanceCalls += 1;
      return realAdvance(input);
    };

    const { request, stream } = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content,
      deviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
    });

    const ingest = {
      parseChunkHeaders,
      ingestChunkBody: async (bodyStream, options) => {
        // Record entry/signal first so missing signal is a direct assert, not a hang.
        ingestEntered = true;
        ingestSignal = options?.signal;
        return ingestChunkBody(bodyStream, options);
      },
      commitChunk: async (args) => {
        commitEntered = true;
        commitSignal = args?.signal;
        const wrappedPublish = args.tempPublish;
        return commitChunk({
          ...args,
          tempPublish: async (ctx) => {
            await publishGate.promise;
            // Production must refuse mutation after abort; do not soft-skip here.
            const out = await wrappedPublish(ctx);
            tempPublishCompleted = true;
            return out;
          },
        });
      },
    };

    const { service } = makeService({ store, ingest });
    const pending = service.putChunk({
      authenticatedDeviceId: DEVICE_A,
      request,
      stream,
      signal: ac.signal,
    });

    try {
      await waitUntil(() => ingestEntered, 'ingestChunkBody entered', { pending });
      assertSignal(ingestSignal, 'ingestChunkBody options.signal');
      assert.equal(ingestSignal, ac.signal, 'same signal instance to ingest');

      await waitUntil(() => commitEntered, 'commitChunk entered', { pending });
      assertSignal(commitSignal, 'commitChunk args.signal');
      assert.equal(commitSignal, ac.signal, 'same signal instance to commit');

      ac.abort();
      publishGate.resolve();
      await assert.rejects(() => pending, (err) => err instanceof Error);

      assert.equal(tempPublishCompleted, false, 'aborted putChunk must not finish tempPublish mutation path');
      assert.equal(advanceCalls, 0, 'aborted putChunk must not advanceBoundary');
      const mid = await store.getSession({
        authenticatedDeviceId: DEVICE_A,
        uploadId: created.uploadId,
      });
      assert.equal(mid.files[0].confirmedBytes, 0);
    } finally {
      ac.abort();
      publishGate.resolve();
      pending.catch(() => {});
    }
  });

  it('finalize propagates signal to verifyAndCommitSession; abort after barrier does not commit', async () => {
    const ac = new AbortController();
    const proj = makeProjection({
      files: [{ path: 'a.txt', size: 0 }],
    });
    const store = makeStore();
    const { service: bootstrap } = makeService({ store });
    const created = await bootstrap.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    const commitGate = deferred();
    let verifyEntered = false;
    /** @type {unknown} */
    let verifySignal = undefined;
    let verifyContinued = false;
    const commit = {
      preflightCapacity: (dir, totalBytes, options = {}) =>
        preflightCapacity(dir, totalBytes, {
          ...options,
          deps: { ...(options.deps || {}), statfs: mockStatfsPlenty() },
        }),
      verifyAndCommitSession: async (input) => {
        // Record entry/signal first — missing signal must assert directly.
        verifyEntered = true;
        verifySignal = input?.signal;
        await commitGate.promise;
        // Cooperative cancel: after barrier, aborted signal must not continue commit.
        // (JS cannot cancel arbitrary suspended continuations; mock honors signal.)
        if (input?.signal?.aborted) {
          throw new Error('aborted');
        }
        verifyContinued = true;
        return verifyAndCommitSession(input);
      },
    };

    const { service } = makeService({ store, commit });
    const pending = service.finalize({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
      signal: ac.signal,
    });

    try {
      await waitUntil(() => verifyEntered, 'verifyAndCommitSession entered', { pending });
      assertSignal(verifySignal, 'verifyAndCommitSession input.signal');
      assert.equal(verifySignal, ac.signal, 'same signal instance to verifyAndCommitSession');
      ac.abort();
      commitGate.resolve();
      await assert.rejects(() => pending, (err) => err instanceof Error);
      assert.equal(verifyContinued, false, 'aborted finalize must not continue commit after barrier');
      assert.equal(await pathExists(finalCompletedAbs(DEVICE_A, SNAPSHOT_A)), false);
    } finally {
      ac.abort();
      commitGate.resolve();
      pending.catch(() => {});
    }
  });

  it('abort propagates signal to store.abortSession; already-aborted signal does not write status', async () => {
    const store = makeStore();
    const proj = makeProjection();
    const { service: bootstrap } = makeService({ store });
    const created = await bootstrap.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    const before = await store.getSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(before.status, 'initialized');

    const ac = new AbortController();
    ac.abort();
    let abortSessionCalls = 0;
    /** @type {unknown} */
    let abortSignalSeen = undefined;
    const realAbort = store.abortSession.bind(store);
    store.abortSession = async (input) => {
      abortSessionCalls += 1;
      abortSignalSeen = input?.signal;
      // Do not soft-skip: if service fails to gate, store write would succeed unless signal enforced.
      return realAbort(input);
    };

    const { service } = makeService({ store });
    await assert.rejects(
      () =>
        service.abort({
          authenticatedDeviceId: DEVICE_A,
          uploadId: created.uploadId,
          signal: ac.signal,
        }),
      (err) => err instanceof Error,
    );

    if (abortSessionCalls > 0) {
      assertSignal(abortSignalSeen, 'abortSession input.signal');
      assert.equal(/** @type {AbortSignal} */ (abortSignalSeen).aborted, true);
    }
    const after = await store.getSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(after.status, 'initialized', 'aborted signal must not mark session aborted on disk');
  });
});

// ── I. P1-1 live-binary slot ownership (create/finalize free; putChunk only) ─

describe('I P1-1 live-binary slot ownership', () => {
  it('create/finalize runTransfer call count is 0; putChunk uses runTransfer', async () => {
    const base = createUploadLocks({ maxGlobalTransfers: 4 });
    const { locks, counts } = spyLocks(base);
    const store = makeStore();
    /** @type {string | undefined} */
    let uploadId;
    const commit = {
      preflightCapacity: async () => {},
      verifyAndCommitSession: async () => {
        assert.equal(typeof uploadId, 'string');
        await store.markVerifying({
          authenticatedDeviceId: DEVICE_A,
          uploadId,
        });
        await store.markCommitted({
          authenticatedDeviceId: DEVICE_A,
          uploadId,
        });
      },
    };
    const { service } = makeService({ store, locks, commit });
    const content = Buffer.from('p1-1-bytes');
    const proj = makeProjection({
      files: [{ path: 'p.txt', size: content.length, content }],
    });

    counts.transfer = 0;
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    uploadId = created.uploadId;
    assert.equal(counts.transfer, 0, 'create must not call runTransfer');
    assert.ok(counts.device >= 1, 'create must enter runDevice');

    counts.transfer = 0;
    const { request, stream } = makeChunkRequest({
      uploadId: created.uploadId,
      manifestDigest: proj.manifestDigest,
      content,
    });
    await service.putChunk({
      authenticatedDeviceId: DEVICE_A,
      request,
      stream,
    });
    assert.ok(counts.transfer >= 1, 'putChunk must call runTransfer');

    counts.transfer = 0;
    await service.finalize({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(counts.transfer, 0, 'finalize must not call runTransfer');
  });

  it('all 4 slots held: create/status/finalize/abort never upload-backpressure; putChunk does', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });
    const store = makeStore();
    /** @type {string | undefined} */
    let finalizeUploadId;
    const commit = {
      preflightCapacity: async () => {},
      verifyAndCommitSession: async () => {
        assert.equal(typeof finalizeUploadId, 'string');
        await store.markVerifying({
          authenticatedDeviceId: DEVICE_A,
          uploadId: finalizeUploadId,
        });
        await store.markCommitted({
          authenticatedDeviceId: DEVICE_A,
          uploadId: finalizeUploadId,
        });
      },
    };
    const { service } = makeService({ store, locks, commit });
    const content = Buffer.from('slot-full');
    const proj = makeProjection({
      files: [{ path: 's.bin', size: 0 }],
    });

    // Bootstrap session for status/finalize/abort/putChunk while free.
    const created = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    finalizeUploadId = created.uploadId;

    const held = await holdGlobalSlots(locks, 4);

    // create on a different device must still succeed (no transfer slot).
    const projB = makeProjection({
      deviceId: DEVICE_B,
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'b.txt', size: 0 }],
    });
    const createdB = await service.create({
      authenticatedDeviceId: DEVICE_B,
      manifest: projB.manifest,
      claimedManifestDigest: projB.manifestDigest,
    });
    assert.equal(createdB.status, 'initialized');

    const st = await service.status({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(st.uploadId, created.uploadId);

    const fin = await service.finalize({
      authenticatedDeviceId: DEVICE_A,
      uploadId: created.uploadId,
    });
    assert.equal(fin.status, 'committed');

    // Abort the DEVICE_B session while full — must not be backpressure.
    const ab = await service.abort({
      authenticatedDeviceId: DEVICE_B,
      uploadId: createdB.uploadId,
    });
    assert.equal(ab.status, 'aborted');

    // putChunk on a fresh session: create first while full, then putChunk fails.
    const projC = makeProjection({
      deviceId: DEVICE_A,
      snapshotId: '550e8400-e29b-41d4-a716-446655440099',
      files: [{ path: 'c.bin', size: content.length, content }],
    });
    // DEVICE_A just finalized — free for new create.
    const createdC = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: projC.manifest,
      claimedManifestDigest: projC.manifestDigest,
    });
    const chunk = makeChunkRequest({
      uploadId: createdC.uploadId,
      manifestDigest: projC.manifestDigest,
      content,
      snapshotId: '550e8400-e29b-41d4-a716-446655440099',
    });
    await assert.rejects(
      () =>
        service.putChunk({
          authenticatedDeviceId: DEVICE_A,
          request: chunk.request,
          stream: chunk.stream,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
          leakTokens: [dataDir, createdC.uploadId, TOKEN],
        });
        return true;
      },
    );

    await held.release();
  });
});

// ── J. P1-2 findActiveRestore + same runDevice critical section ─────

describe('J P1-2 findActiveRestore bidirectional admission', () => {
  it('findActiveRestore true → unique upload-session-conflict; no createSession', async () => {
    let findCalls = 0;
    let createCalls = 0;
    const store = makeStore();
    const realCreate = store.createSession.bind(store);
    store.createSession = async (input) => {
      createCalls += 1;
      return realCreate(input);
    };
    const { service } = makeService({
      store,
      findActiveRestore: async (deviceId) => {
        findCalls += 1;
        assert.equal(deviceId, DEVICE_A);
        return true;
      },
    });
    const proj = makeProjection();
    await assert.rejects(
      () =>
        service.create({
          authenticatedDeviceId: DEVICE_A,
          manifest: proj.manifest,
          claimedManifestDigest: proj.manifestDigest,
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_SESSION_CONFLICT, {
          statusCode: 409,
          retryable: false,
          leakTokens: [dataDir, TOKEN, 'restore', '/Users'],
        });
        return true;
      },
    );
    assert.ok(findCalls >= 1, 'must probe findActiveRestore');
    assert.equal(createCalls, 0, 'must not createSession when restore active');
  });

  it('omitted findActiveRestore defaults to false; create keeps old success path', async () => {
    // No findActiveRestore in options — production default async () => false.
    const { service } = makeService();
    const proj = makeProjection({ files: [{ path: 'ok.txt', size: 0 }] });
    const summary = await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });
    assert.equal(summary.status, 'initialized');
    assert.equal(typeof summary.uploadId, 'string');
  });

  it('order/critical-section canary: probe + createSession inside one runDevice; runTransfer=0', async () => {
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

    const store = makeStore();
    const realCreate = store.createSession.bind(store);
    store.createSession = async (input) => {
      order.push('createSession');
      return realCreate(input);
    };

    let findCalls = 0;
    const { service } = makeService({
      store,
      locks,
      findActiveRestore: async (deviceId) => {
        findCalls += 1;
        order.push('findActiveRestore');
        assert.equal(deviceId, DEVICE_A);
        // Still inside critical section if device-in already pushed and device-exit not yet.
        assert.ok(order.includes('device-in'));
        assert.equal(order.includes('device-exit'), false);
        return false;
      },
    });

    const proj = makeProjection({ files: [{ path: 'crit.txt', size: 0 }] });
    await service.create({
      authenticatedDeviceId: DEVICE_A,
      manifest: proj.manifest,
      claimedManifestDigest: proj.manifestDigest,
    });

    assert.equal(findCalls, 1);
    assert.equal(order.includes('transfer'), false, 'create must not call runTransfer');
    assert.ok(order.includes('findActiveRestore'));
    assert.ok(order.includes('createSession'));

    const enterIdx = order.indexOf('device-enter');
    const inIdx = order.indexOf('device-in');
    const findIdx = order.indexOf('findActiveRestore');
    const createIdx = order.indexOf('createSession');
    const exitIdx = order.indexOf('device-exit');
    assert.ok(enterIdx >= 0 && inIdx > enterIdx);
    assert.ok(findIdx > inIdx, 'findActiveRestore must run inside runDevice callback');
    assert.ok(createIdx > findIdx, 'createSession after probe in same critical section');
    assert.ok(exitIdx > createIdx, 'device-exit only after createSession');
  });
});
