/**
 * C7 RED — Endpoint restore engine (runEndpointRestore) + requestJson/download 分流.
 * Authority: design §§9.4, 10, 13, 16.6 + plan C7 RED Steps 1–10b / P2-5 e2e.
 *
 * Production module: src/restore-endpoint-engine.js (fixed independent file).
 * Dynamic import only — never static top-level import of missing module.
 * Do NOT assume requestPinnedBinary is replaced by streaming download.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  lstat,
  writeFile,
  rename as fsRename,
  symlink,
  statfs,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { RESTORE_CHUNK_SIZE } from '../src/restore-schemas.js';
import { createEndpointRestoreStateStore } from '../src/restore-endpoint-state.js';
import {
  deriveSiblingNames,
  preflightTarget,
  materializeChunkToStaging,
  verifyStagingTree,
  assertCapacity,
} from '../src/restore-staging.js';
import {
  publishFromStagingVerified,
  rollbackPublished,
  recoverFromCrash,
  recoverCancelledLocal,
} from '../src/restore-publish.js';
import {
  computeStructureFingerprint,
  computeContentSha256,
} from '../src/restore-fingerprint.js';
import { requestPinnedBinary, requestPinnedDownload } from '../src/device-client.js';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../src/tls-identity-store.js';

/** Production requestJson timeout pin (plan C7 / design JSON control-plane). */
const JSON_TIMEOUT_MS = 15_000;
const TLS_FP_A = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Fixed constants (no random UUID substrings; no wall-clock jitter dependence)
// ---------------------------------------------------------------------------

const TASK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0101';
const TASK_ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0102';
const TASK_ID_OTHER = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeee0202';
const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-4466554400aa';
const SNAPSHOT_ID_DRIFT = '550e8400-e29b-41d4-a716-4466554400bb';
const DIGEST = 'c'.repeat(64);
const DIGEST_DRIFT = 'd'.repeat(64);
const DEVICE = 'device-c7-restore-engine';
const DEVICE_OTHER = 'device-c7-other-device-identity';
const DEVICE_DRIFT = 'device-c7-identity-drift-other';
const TOKEN = 'c7-restore-engine-token-32chars!!!';
const REL_TARGET = 'apps/demo';
const REL_TARGET_DRIFT = 'apps/other-demo';
const T0 = '2026-07-23T12:00:00.000Z';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const CHUNK_SIZE = RESTORE_CHUNK_SIZE;
const DEFAULT_RETRY = 8;
/** Discovery readdir hard bound (must match production MAX_RESTORE_TASK_DIR_ENTRIES). */
const DISCOVERY_DIR_ENTRY_BOUND = 10_000;

const openServers = new Set();
/** @type {string[]} */
const tempDirs = [];

after(async () => {
  for (const server of [...openServers]) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  openServers.clear();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

/**
 * @returns {Promise<(input: object) => Promise<{ outcome: string }>>}
 */
async function loadRunEndpointRestore() {
  let mod;
  try {
    mod = await import('../src/restore-endpoint-engine.js');
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code;
    assert.fail(
      `C7 restore-endpoint-engine missing or unloadable (${code || error}): `
        + 'src/restore-endpoint-engine.js must export runEndpointRestore',
    );
  }
  assert.equal(
    typeof mod.runEndpointRestore,
    'function',
    'C7 runEndpointRestore must be exported from src/restore-endpoint-engine.js',
  );
  // Must remain a separate module — never merged into device-client.
  const dc = await import('../src/device-client.js');
  assert.equal(
    'runEndpointRestore' in dc,
    false,
    'C7 engine must not be merged into device-client',
  );
  return mod.runEndpointRestore;
}

/**
 * @param {unknown} error
 */
function publicErrorText(error) {
  if (!error || typeof error !== 'object') return String(error);
  const err = /** @type {Error & { code?: string, statusCode?: unknown, retryable?: unknown }} */ (error);
  const own = Object.keys(err)
    .filter((k) => k !== 'stack')
    .map((k) => String(/** @type {Record<string, unknown>} */ (err)[k]));
  return [err.name, err.message, err.code, err.statusCode, err.retryable, ...own].join('\n');
}

/**
 * @param {Buffer | string} content
 */
function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * @param {{ path: string, content: Buffer | string }[]} files
 */
function buildFilesTable(files) {
  return files.map((f, fileIndex) => {
    const buf = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    const size = buf.length;
    return {
      fileIndex,
      path: f.path,
      size,
      sha256: size === 0 ? ZERO_SHA : sha256Hex(buf),
      chunkCount: size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE),
      content: buf,
    };
  });
}

async function makeTemp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startHttpsFixture(handler) {
  const { keyPem } = generateControllerPrivateKey();
  const certPem = await createOpenSslCertificate({ keyPem, san: 'IP:127.0.0.1' });
  const certificate = new X509Certificate(certPem);
  const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  const server = https.createServer({ key: keyPem, cert: certPem }, handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.add(server);
  const { port } = server.address();
  return {
    url: `https://127.0.0.1:${port}`,
    fingerprint,
    server,
    close: () => new Promise((resolve, reject) => {
      openServers.delete(server);
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/**
 * Assert production requestPinnedBinary-compatible requestJson call shape (P2-7).
 * @param {object} opts
 * @param {'GET' | 'POST'} method
 */
function assertRequestJsonShape(opts, method) {
  assert.equal(typeof opts.agentUrl, 'string');
  assert.ok(String(opts.agentUrl).startsWith('https://'), 'agentUrl must be https');
  assert.equal(typeof opts.tlsFingerprint, 'string');
  assert.match(String(opts.tlsFingerprint), /^[a-f0-9]{64}$/);
  assert.equal(opts.token, TOKEN);
  assert.equal(opts.deviceId, DEVICE);
  assert.equal(opts.protocolVersion, 2);
  assert.equal(String(opts.method || 'POST').toUpperCase(), method);
  assert.equal(opts.timeoutMs, JSON_TIMEOUT_MS);
  if (method === 'GET') {
    assert.equal(opts.bodyMode, 'none');
  } else {
    assert.equal(opts.bodyMode, 'json');
  }
}

/**
 * Counting requestJson / download injectables for分流 pin.
 * Captures full production requestJson field set (P2-7).
 */
function createNetworkSpies(handlers = {}) {
  /** @type {object[]} */
  const jsonCalls = [];
  /** @type {{ path: string, expectedLength?: number, expectedSha256?: string }[]} */
  const downloadCalls = [];

  async function requestJson(opts) {
    const method = String(opts.method || 'POST').toUpperCase();
    jsonCalls.push({
      kind: 'json',
      method,
      path: opts.path,
      body: opts.body,
      bodyMode: opts.bodyMode,
      timeoutMs: opts.timeoutMs,
      deviceId: opts.deviceId,
      token: opts.token,
      protocolVersion: opts.protocolVersion,
      agentUrl: opts.agentUrl,
      tlsFingerprint: opts.tlsFingerprint,
    });
    assertRequestJsonShape(opts, method === 'GET' ? 'GET' : 'POST');
    if (handlers.requestJson) return handlers.requestJson(opts, jsonCalls.length);
    throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND, { statusCode: 404 });
  }

  async function download(opts) {
    downloadCalls.push({
      path: opts.path,
      expectedLength: opts.expectedLength,
      expectedSha256: opts.expectedSha256,
    });
    if (handlers.download) return handlers.download(opts, downloadCalls.length);
    throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED, { statusCode: 422 });
  }

  return { requestJson, download, jsonCalls, downloadCalls };
}

/**
 * Default mock controller responses for a single-task happy path.
 * @param {ReturnType<typeof buildFilesTable>} files
 * @param {{
 *   cancelBeforeAnchor?: boolean,
 *   cancelFromStart?: boolean,
 *   corruptChunk?: boolean,
 *   disconnectBudget?: number,
 *   cleanupTransientFirst?: boolean,
 * }} [opts]
 */
function createControllerMock(files, opts = {}) {
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  let claimed = false;
  // cancelFromStart: cancelRequested=true on first claim/GET (post-anchor recovery proof).
  let cancelRequested = opts.cancelBeforeAnchor === true || opts.cancelFromStart === true;
  /** @type {string[]} */
  const events = [];
  /** @type {boolean[]} */
  const cancelObservations = [];
  let disconnectsLeft = opts.disconnectBudget ?? 0;
  let progressPosts = 0;
  let receiptPosts = 0;
  let cleanupPosts = 0;
  /** @type {object[]} */
  const cleanupBodies = [];
  /** @type {object | null} */
  let lastCleanupBody = null;
  /** @type {object | null} */
  let lastReceiptBody = null;

  const taskSummary = {
    taskId: TASK_ID,
    snapshotId: SNAPSHOT_ID,
    manifestDigest: DIGEST,
    relativeTarget: REL_TARGET,
    status: 'active',
    fileCount: files.length,
    totalBytes,
    chunkSize: CHUNK_SIZE,
    createdAt: T0,
    claimedAt: T0,
    cancelRequested: false,
  };

  /**
   * @param {object} optsIn
   */
  async function requestJson(optsIn) {
    const path = String(optsIn.path || '');
    const method = String(optsIn.method || 'POST').toUpperCase();
    events.push(`${method} ${path}`);

    // Production requestPinnedBinary-compatible shape (P2-7) — always assert.
    assertRequestJsonShape(optsIn, method === 'GET' ? 'GET' : 'POST');
    // File path must never appear in URL
    assert.ok(!path.includes('nested/'), 'file path must not enter URL');
    assert.ok(!path.includes(REL_TARGET), 'relativeTarget must not enter JSON URL');

    if (method === 'POST' && path === '/agent/restore/tasks/claim') {
      if (claimed) {
        return { task: null };
      }
      claimed = true;
      cancelObservations.push(cancelRequested);
      return { task: { ...taskSummary, cancelRequested } };
    }

    if (method === 'GET' && path === `/agent/restore/tasks/${TASK_ID}`) {
      cancelObservations.push(cancelRequested);
      return {
        taskId: TASK_ID,
        snapshotId: SNAPSHOT_ID,
        manifestDigest: DIGEST,
        relativeTarget: REL_TARGET,
        status: 'active',
        cancelRequested,
        cleanupAuthorized: false,
        fileCount: files.length,
        totalBytes,
        chunkSize: CHUNK_SIZE,
        files: files.map(({ fileIndex, path: p, size, sha256, chunkCount }) => ({
          fileIndex,
          path: p,
          size,
          sha256,
          chunkCount,
        })),
      };
    }

    if (method === 'POST' && path === `/agent/restore/tasks/${TASK_ID}/progress`) {
      progressPosts += 1;
      const body = optsIn.body || {};
      assert.equal(typeof body.fileIndex, 'number');
      assert.equal(typeof body.chunkIndex, 'number');
      assert.equal(typeof body.receivedBytes, 'number');
      cancelObservations.push(cancelRequested);
      return { ok: true, cancelRequested };
    }

    if (method === 'POST' && path === `/agent/restore/tasks/${TASK_ID}/receipts`) {
      receiptPosts += 1;
      lastReceiptBody = optsIn.body;
      return {
        ok: true,
        cleanupAuthorized: true,
        status: lastReceiptBody?.outcome === 'rolled-back' ? 'rolled-back' : 'completed',
      };
    }

    if (method === 'POST' && path === `/agent/restore/tasks/${TASK_ID}/cleanup`) {
      cleanupPosts += 1;
      // Deep-freeze a plain clone so body identity cannot drift across replays.
      const bodyClone = JSON.parse(JSON.stringify(optsIn.body || {}));
      cleanupBodies.push(bodyClone);
      lastCleanupBody = bodyClone;
      // P2-8: first cleanup returns legitimate transient retry; second ACK.
      if (opts.cleanupTransientFirst === true && cleanupPosts === 1) {
        throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
          statusCode: null,
          retryable: true,
        });
      }
      return { ok: true, status: lastCleanupBody?.outcome === 'cancelled' ? 'cancelled' : 'cleaned' };
    }

    throw new LinkeError(ERROR_CODES.DEVICE_ROUTE_NOT_FOUND, { statusCode: 404 });
  }

  /**
   * @param {object} optsIn
   */
  async function download(optsIn) {
    const path = String(optsIn.path || '');
    events.push(`DOWNLOAD ${path}`);
    assert.ok(!path.includes('nested/'), 'file path must not enter download URL');
    assert.match(
      path,
      /^\/agent\/restore\/tasks\/[0-9a-f-]+\/files\/\d+\/chunks\/\d+$/,
    );

    if (disconnectsLeft > 0) {
      disconnectsLeft -= 1;
      throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
        statusCode: null,
        retryable: true,
      });
    }

    const m = path.match(/\/files\/(\d+)\/chunks\/(\d+)$/);
    assert.ok(m);
    const fileIndex = Number(m[1]);
    const chunkIndex = Number(m[2]);
    const file = files.find((f) => f.fileIndex === fileIndex);
    assert.ok(file, 'fileIndex in bounds');
    assert.ok(file.size > 0, 'empty files must not download');
    const offset = chunkIndex * CHUNK_SIZE;
    const end = Math.min(file.size, offset + CHUNK_SIZE);
    let bytes = file.content.subarray(offset, end);
    if (opts.corruptChunk) {
      bytes = Buffer.from('CORRUPT-CHUNK-PAYLOAD!!');
    }
    const sha = sha256Hex(bytes);
    // Deliver via onChunk if present (streaming shape)
    if (typeof optsIn.onChunk === 'function') {
      await optsIn.onChunk(bytes);
    }
    // Integrity self-check against expected headers contract
    if (
      optsIn.expectedLength !== undefined
      && optsIn.expectedLength !== bytes.length
      && !opts.corruptChunk
    ) {
      throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED, { statusCode: 422 });
    }
    if (
      optsIn.expectedSha256 !== undefined
      && optsIn.expectedSha256 !== sha
      && !opts.corruptChunk
    ) {
      throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED, { statusCode: 422 });
    }
    if (opts.corruptChunk) {
      throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED, { statusCode: 422 });
    }
    return { bytesReceived: bytes.length, sha256: sha };
  }

  return {
    requestJson,
    download,
    events,
    cancelObservations,
    stats: () => ({
      claimed,
      progressPosts,
      receiptPosts,
      cleanupPosts,
      cleanupBodies: cleanupBodies.slice(),
      lastCleanupBody,
      lastReceiptBody,
      cancelRequested,
      cancelObservations: cancelObservations.slice(),
    }),
    setCancelRequested(v) {
      cancelRequested = v;
    },
  };
}

/**
 * Seed durable STATE + staging to legal phase via 3-arg transitionPhase edges.
 * @param {{
 *   stateStore: ReturnType<typeof createEndpointRestoreStateStore>,
 *   restoreRoot: string,
 *   files: ReturnType<typeof buildFilesTable>,
 *   targetPhase: 'receiving' | 'staging-verified' | 'anchor-intent',
 * }} input
 */
async function seedDurableRestoreState(input) {
  const { stateStore, restoreRoot, files, targetPhase } = input;
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  await stateStore.openOrCreateState({
    taskId: TASK_ID,
    deviceId: DEVICE,
    snapshotId: SNAPSHOT_ID,
    manifestDigest: DIGEST,
    relativeTarget: REL_TARGET,
    fileCount: files.length,
    totalBytes,
    chunkSize: CHUNK_SIZE,
    originalTargetExisted: false,
    oldStructureFingerprint: null,
    oldContentSha256: null,
  });
  // Legal edge: planned → receiving
  await stateStore.transitionPhase(TASK_ID, 'planned', 'receiving');

  const paths = await preflightTarget({
    restoreRoot,
    relativeTarget: REL_TARGET,
    taskId: TASK_ID,
  });
  await mkdir(paths.stagingPathAbs, { recursive: true });

  let receivedBytes = 0;
  for (const file of files) {
    if (file.size === 0) {
      // Empty files: materialize zero-length content as empty buffer at path.
      await materializeChunkToStaging({
        stagingRoot: paths.stagingPathAbs,
        filePath: file.path,
        chunkIndex: 0,
        chunkSize: CHUNK_SIZE,
        bytes: Buffer.alloc(0),
        expectedSha256: ZERO_SHA,
      });
      continue;
    }
    const chunkCount = file.chunkCount;
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const offset = chunkIndex * CHUNK_SIZE;
      const end = Math.min(file.size, offset + CHUNK_SIZE);
      const bytes = file.content.subarray(offset, end);
      await materializeChunkToStaging({
        stagingRoot: paths.stagingPathAbs,
        filePath: file.path,
        chunkIndex,
        chunkSize: CHUNK_SIZE,
        bytes,
        expectedSha256: sha256Hex(bytes),
      });
    }
    receivedBytes += file.size;
    await stateStore.recordDurableProgress(TASK_ID, {
      fileIndex: file.fileIndex,
      chunkIndex: Math.max(0, file.chunkCount - 1),
      receivedBytes,
    });
  }

  // Production verify of materialized staging tree (fixture-contract).
  await verifyStagingTree({
    stagingRoot: paths.stagingPathAbs,
    files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  });

  if (targetPhase === 'receiving') {
    return { paths, phase: 'receiving' };
  }
  await stateStore.transitionPhase(TASK_ID, 'receiving', 'staging-verified');
  if (targetPhase === 'staging-verified') {
    return { paths, phase: 'staging-verified' };
  }
  await stateStore.transitionPhase(TASK_ID, 'staging-verified', 'anchor-intent');
  const state = await stateStore.readState(TASK_ID);
  assert.equal(state.phase, 'anchor-intent');
  return { paths, phase: 'anchor-intent' };
}

/**
 * Ensure restoreRoot parent chain for relativeTarget exists (preflight requires it).
 * @param {string} restoreRoot
 * @param {string} relativeTarget
 */
async function ensureRestoreParent(restoreRoot, relativeTarget = REL_TARGET) {
  const segments = relativeTarget.split('/');
  const parentSegments = segments.slice(0, -1);
  let current = restoreRoot;
  for (const seg of parentSegments) {
    current = join(current, seg);
    await mkdir(current, { recursive: true });
  }
}

/**
 * Build engine input with real C3/C4 stores + injected network.
 */
async function buildEngineInput(network, overrides = {}) {
  const endpointDataDir = await makeTemp('linke-c7-ep-state-');
  const restoreRoot = await makeTemp('linke-c7-restore-root-');
  await ensureRestoreParent(restoreRoot);
  const stateStore = createEndpointRestoreStateStore({
    endpointDataDir,
    now: () => new Date(T0),
  });

  return {
    agentUrl: overrides.agentUrl ?? 'https://127.0.0.1:1',
    tlsFingerprint: overrides.tlsFingerprint ?? TLS_FP_A,
    token: TOKEN,
    deviceId: DEVICE,
    protocolVersion: 2,
    restoreRoot,
    endpointDataDir,
    retryBudget: overrides.retryBudget ?? DEFAULT_RETRY,
    stateStore,
    publish: {
      publishFromStagingVerified,
      rollbackPublished,
      recoverFromCrash,
      recoverCancelledLocal,
    },
    requestJson: network.requestJson,
    download: network.download,
    now: () => new Date(T0),
    ...overrides.extra,
    // expose for assertions
    __fixture: { endpointDataDir, restoreRoot, stateStore },
  };
}

/**
 * Thin facade over real C3 store: returns plain (mutable) STATE clones so
 * resume identity-oracle cases can prove assertStateMatchesTask fail-close
 * for fields that cannot legally diverge via openOrCreate + valid GET alone
 * (deviceId vs engine input; chunkSize locked to RESTORE_CHUNK_SIZE).
 * Does not monkeypatch production client.
 * @param {ReturnType<typeof createEndpointRestoreStateStore>} real
 */
function wrapStateStoreMutableView(real) {
  /** @type {Record<string, unknown> | null} */
  let lastPlainState = null;
  return {
    openOrCreateState: (init) => real.openOrCreateState(init),
    readState: async (id) => {
      const frozen = await real.readState(id);
      const plain = { ...frozen };
      lastPlainState = plain;
      return plain;
    },
    writeState: (id, patch, opts) => real.writeState(id, patch, opts),
    transitionPhase: (id, from, to) => real.transitionPhase(id, from, to),
    recordDurableProgress: (id, p) => real.recordDurableProgress(id, p),
    recoverReceiving: (id, root, files) => real.recoverReceiving(id, root, files),
    writeReceipt: (id, r) => real.writeReceipt(id, r),
    writeCleanupReceipt: (id, r) => real.writeCleanupReceipt(id, r),
    readTombstone: (id) => real.readTombstone(id),
    /** @returns {Record<string, unknown> | null} */
    getLastPlainState() {
      return lastPlainState;
    },
  };
}

/**
 * Seed local nonterminal receiving STATE (identity baseline) on real store.
 * @param {{
 *   stateStore: { openOrCreateState: Function, transitionPhase: Function },
 *   files: ReturnType<typeof buildFilesTable>,
 *   taskId?: string,
 *   deviceId?: string,
 * }} input
 */
async function seedLocalReceivingState(input) {
  const taskId = input.taskId ?? TASK_ID;
  const deviceId = input.deviceId ?? DEVICE;
  const files = input.files;
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  await input.stateStore.openOrCreateState({
    taskId,
    deviceId,
    snapshotId: SNAPSHOT_ID,
    manifestDigest: DIGEST,
    relativeTarget: REL_TARGET,
    fileCount: files.length,
    totalBytes,
    chunkSize: CHUNK_SIZE,
    originalTargetExisted: false,
    oldStructureFingerprint: null,
    oldContentSha256: null,
  });
  await input.stateStore.transitionPhase(taskId, 'planned', 'receiving');
  return { taskId, totalBytes };
}

/**
 * Build GET task body matching files (optionally drifted identity fields).
 * @param {ReturnType<typeof buildFilesTable>} files
 * @param {Record<string, unknown>} [drift]
 */
function buildGetTaskBody(files, drift = {}) {
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  return {
    taskId: TASK_ID,
    snapshotId: SNAPSHOT_ID,
    manifestDigest: DIGEST,
    relativeTarget: REL_TARGET,
    status: 'active',
    cancelRequested: false,
    cleanupAuthorized: false,
    fileCount: files.length,
    totalBytes,
    chunkSize: CHUNK_SIZE,
    files: files.map(({ fileIndex, path: p, size, sha256, chunkCount }) => ({
      fileIndex,
      path: p,
      size,
      sha256,
      chunkCount,
    })),
    ...drift,
  };
}

/**
 * Assert resume fail-close has zero dangerous remote side effects.
 * @param {{
 *   jsonCalls: object[],
 *   downloadCalls: unknown[],
 * }} spies
 * @param {{ stats: () => { receiptPosts: number, cleanupPosts: number, claimed: boolean } }} [controller]
 */
function assertNoDangerousRemoteSideEffects(spies, controller) {
  const claims = spies.jsonCalls.filter(
    (c) => c.method === 'POST' && String(c.path) === '/agent/restore/tasks/claim',
  );
  assert.equal(claims.length, 0, 'resume fail-close must issue zero claim');
  assert.equal(spies.downloadCalls.length, 0, 'resume fail-close must issue zero download');
  if (controller) {
    const st = controller.stats();
    assert.equal(st.receiptPosts, 0, 'resume fail-close must issue zero receipt');
    assert.equal(st.cleanupPosts, 0, 'resume fail-close must issue zero cleanup');
    assert.equal(st.claimed, false, 'controller claim flag must stay false');
  } else {
    const receipts = spies.jsonCalls.filter(
      (c) => c.method === 'POST' && String(c.path).endsWith('/receipts'),
    );
    const cleanups = spies.jsonCalls.filter(
      (c) => c.method === 'POST' && String(c.path).endsWith('/cleanup'),
    );
    assert.equal(receipts.length, 0, 'resume fail-close must issue zero receipt');
    assert.equal(cleanups.length, 0, 'resume fail-close must issue zero cleanup');
  }
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('C7 fixture-contract (no engine; production STATE/staging signatures)', () => {
  it('C7 fixture-contract: 3-arg transitionPhase + staging materialize/verify reach anchor-intent', async () => {
    // PASS without runEndpointRestore — proves fixture signatures cannot be hidden by missing engine.
    const files = buildFilesTable([{ path: 'p.txt', content: 'post-anchor' }]);
    const endpointDataDir = await makeTemp('linke-c7-fixture-state-');
    const restoreRoot = await makeTemp('linke-c7-fixture-root-');
    await ensureRestoreParent(restoreRoot);
    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });

    const seeded = await seedDurableRestoreState({
      stateStore,
      restoreRoot,
      files,
      targetPhase: 'anchor-intent',
    });
    assert.equal(seeded.phase, 'anchor-intent');

    const state = await stateStore.readState(TASK_ID);
    assert.equal(state.phase, 'anchor-intent');
    assert.equal(state.receivedBytes, files[0].size);
    assert.notEqual(state.phase, 'cancelled-local');

    // Illegal 2-arg / wrong edge must fail closed (production signature).
    await assert.rejects(
      () => /** @type {any} */ (stateStore).transitionPhase(TASK_ID, 'anchor-intent'),
      (e) => e instanceof LinkeError && e.code === ERROR_CODES.RESTORE_STATE_INVALID,
    );
    await assert.rejects(
      () => stateStore.transitionPhase(TASK_ID, 'anchor-intent', 'cancelled-local'),
      (e) => e instanceof LinkeError && e.code === ERROR_CODES.RESTORE_STATE_INVALID,
    );

    // Staging material remains verifyable.
    await verifyStagingTree({
      stagingRoot: seeded.paths.stagingPathAbs,
      files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    });
  });
});

describe('C7 restore-endpoint-engine module surface', () => {
  it('C7 runEndpointRestore is exported only from restore-endpoint-engine (not device-client)', async () => {
    const run = await loadRunEndpointRestore();
    assert.equal(typeof run, 'function');
  });
});

describe('C7 requestJson vs download 分流 pin', () => {
  it('C7 claim/getTask/progress/receipt/cleanup only requestJson; chunks only download', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const content = Buffer.from('hello-c7-split');
    const files = buildFilesTable([{ path: 'a.txt', content }]);
    const controller = createControllerMock(files);
    const spies = createNetworkSpies({
      requestJson: (opts) => controller.requestJson(opts),
      download: (opts) => controller.download(opts),
    });
    const input = await buildEngineInput(spies);
    // strip fixture helper
    const { __fixture, ...engineInput } = input;

    const result = await runEndpointRestore(engineInput);
    assert.equal(result.outcome, 'completed');

    const jsonPaths = spies.jsonCalls.map((c) => `${c.method || 'POST'} ${c.path}`);
    const dlPaths = spies.downloadCalls.map((c) => c.path);

    assert.ok(jsonPaths.some((p) => p.includes('/agent/restore/tasks/claim')));
    assert.ok(jsonPaths.some((p) => p.includes(`/agent/restore/tasks/${TASK_ID}`) && !p.includes('/files/')));
    assert.ok(jsonPaths.some((p) => p.includes('/progress')));
    assert.ok(jsonPaths.some((p) => p.includes('/receipts')));
    assert.ok(jsonPaths.some((p) => p.includes('/cleanup')));

    // JSON must never hit chunk URLs
    for (const p of jsonPaths) {
      assert.ok(!p.includes('/chunks/'), `JSON must not call chunk path: ${p}`);
    }
    // download only chunks
    assert.ok(dlPaths.length >= 1);
    for (const p of dlPaths) {
      assert.match(p, /\/files\/\d+\/chunks\/\d+$/);
    }

    // P2-7: every JSON call carries full production requestPinnedBinary shape.
    for (const c of spies.jsonCalls) {
      assert.equal(c.timeoutMs, JSON_TIMEOUT_MS);
      assert.equal(c.deviceId, DEVICE);
      assert.equal(c.token, TOKEN);
      assert.equal(c.protocolVersion, 2);
      assert.equal(typeof c.agentUrl, 'string');
      assert.match(String(c.tlsFingerprint), /^[a-f0-9]{64}$/);
      if (c.method === 'GET') assert.equal(c.bodyMode, 'none');
      else assert.equal(c.bodyMode, 'json');
    }

    // file path only for staging layout — never URL
    for (const p of [...jsonPaths, ...dlPaths]) {
      assert.ok(!p.includes('a.txt'));
      assert.ok(!p.includes(REL_TARGET));
    }
  });
});

describe('C7 runEndpointRestore happy path completed', () => {
  it('C7 claim→task→chunk(s)→progress→verify→publish→receipt→cleanup → completed', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([
      { path: 'alpha.txt', content: 'alpha-payload' },
      { path: 'nested/beta.txt', content: 'beta-nested' },
      { path: 'empty.dat', content: Buffer.alloc(0) },
    ]);
    const controller = createControllerMock(files);
    const spies = createNetworkSpies({
      requestJson: (o) => controller.requestJson(o),
      download: (o) => controller.download(o),
    });
    const input = await buildEngineInput(spies);
    const { __fixture, ...engineInput } = input;

    const result = await runEndpointRestore(engineInput);
    assert.equal(result.outcome, 'completed');

    const st = controller.stats();
    assert.ok(st.progressPosts >= 1);
    assert.equal(st.receiptPosts, 1);
    assert.equal(st.cleanupPosts, 1);
    assert.equal(st.lastReceiptBody?.outcome, 'completed');
    assert.ok(st.lastCleanupBody?.cleanupId);
    assert.equal(st.lastCleanupBody?.outcome, 'completed');
    assert.ok(st.lastCleanupBody?.receiptId);

    // empty file never downloaded
    for (const p of spies.downloadCalls.map((c) => c.path)) {
      // empty.dat is fileIndex 2 with chunkCount 0 — no /files/2/chunks/
      assert.ok(!p.includes('/files/2/chunks/'));
    }

    // published target tree exists under restoreRoot
    const targetDir = join(__fixture.restoreRoot, REL_TARGET);
    const alpha = await readFile(join(targetDir, 'alpha.txt'), 'utf8');
    assert.equal(alpha, 'alpha-payload');
    const beta = await readFile(join(targetDir, 'nested/beta.txt'), 'utf8');
    assert.equal(beta, 'beta-nested');
    // empty materializes as zero-byte file
    const emptyStat = await lstat(join(targetDir, 'empty.dat'));
    assert.equal(emptyStat.size, 0);

    // staging sibling gone after cleanup path (or at least not published leftover name required)
    const names = deriveSiblingNames(TASK_ID);
    const parent = join(__fixture.restoreRoot, 'apps');
    // After successful cleanup, staging should not remain as published artifact
    try {
      const stagingStat = await lstat(join(parent, names.stagingName));
      // if present, must not be required for success; prefer absent
      assert.ok(stagingStat);
    } catch (error) {
      assert.equal(/** @type {{ code?: string }} */ (error).code, 'ENOENT');
    }

    const state = await __fixture.stateStore.readState(TASK_ID).catch(() => null);
    // cleaned phase or tombstone removed — either is acceptable terminal; not cancelled-local
    if (state) {
      assert.notEqual(state.phase, 'cancelled-local');
      assert.ok(state.receivedBytes === files.reduce((s, f) => s + f.size, 0)
        || state.phase === 'cleaned'
        || state.phase === 'cleanup-completed-awaiting-ack'
        || state.phase === 'completed-awaiting-ack');
    }
  });
});

describe('C7 resume P2-5 no progress rewind', () => {
  it('C7 resume only from durable STATE; no re-download of durable chunks; no smaller receivedBytes', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const part1 = Buffer.from('DURABLE-CHUNK-PART-1-BYTES');
    const part2 = Buffer.from('TAIL-CHUNK-PART-2-BYTES!!');
    // Single file two logical chunks via small content still one chunk under 8MiB —
    // use two files so resume coordinate is multi-file.
    const files = buildFilesTable([
      { path: 'f0.bin', content: part1 },
      { path: 'f1.bin', content: part2 },
    ]);
    const totalBytes = part1.length + part2.length;

    // Pre-seed durable STATE + staging for file 0 only
    const endpointDataDir = await makeTemp('linke-c7-resume-state-');
    const restoreRoot = await makeTemp('linke-c7-resume-root-');
    await ensureRestoreParent(restoreRoot);
    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });
    await stateStore.openOrCreateState({
      taskId: TASK_ID,
      deviceId: DEVICE,
      snapshotId: SNAPSHOT_ID,
      manifestDigest: DIGEST,
      relativeTarget: REL_TARGET,
      fileCount: 2,
      totalBytes,
      chunkSize: CHUNK_SIZE,
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
    });
    // Production signature: transitionPhase(taskId, from, to)
    await stateStore.transitionPhase(TASK_ID, 'planned', 'receiving');
    await stateStore.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: part1.length,
    });

    const paths = await preflightTarget({
      restoreRoot,
      relativeTarget: REL_TARGET,
      taskId: TASK_ID,
    });
    await mkdir(paths.stagingPathAbs, { recursive: true });
    await materializeChunkToStaging({
      stagingRoot: paths.stagingPathAbs,
      filePath: 'f0.bin',
      chunkIndex: 0,
      chunkSize: CHUNK_SIZE,
      bytes: part1,
      expectedSha256: sha256Hex(part1),
    });

    let downloadCount = 0;
    /** @type {string[]} */
    const downloaded = [];
    const controller = createControllerMock(files);
    // Force already claimed-like: first claim returns task (engine may still claim)
    const spies = createNetworkSpies({
      requestJson: (o) => controller.requestJson(o),
      download: async (o) => {
        downloadCount += 1;
        downloaded.push(o.path);
        // Must only request remaining file1 chunk, never re-fetch file0 if durable
        return controller.download(o);
      },
    });

    const result = await runEndpointRestore({
      agentUrl: 'https://127.0.0.1:1',
      tlsFingerprint: TLS_FP_A,
      token: TOKEN,
      deviceId: DEVICE,
      protocolVersion: 2,
      restoreRoot,
      endpointDataDir,
      retryBudget: DEFAULT_RETRY,
      stateStore,
      publish: {
        publishFromStagingVerified,
        rollbackPublished,
        recoverFromCrash,
        recoverCancelledLocal,
      },
      requestJson: spies.requestJson,
      download: spies.download,
      now: () => new Date(T0),
    });

    assert.equal(result.outcome, 'completed');
    // Durable file0 must not be re-downloaded (or if engine verifies via recoverReceiving, downloads ≤1 for f1)
    assert.ok(
      downloaded.every((p) => !p.includes('/files/0/chunks/')),
      `must not re-download durable file0 chunks: ${downloaded.join(',')}`,
    );
    assert.ok(downloadCount >= 1);
    assert.ok(downloadCount <= 2);

    const stateAfter = await stateStore.readState(TASK_ID).catch(() => null);
    if (stateAfter && typeof stateAfter.receivedBytes === 'number') {
      assert.ok(
        stateAfter.receivedBytes >= part1.length,
        'P2-5: receivedBytes must never rewind below durable floor',
      );
    }
  });

  it('C7 staging/STATE mismatch or missing staging → integrity/state fail-close; no smaller receivedBytes write', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'only.txt', content: 'need-staging' }]);
    const endpointDataDir = await makeTemp('linke-c7-mismatch-state-');
    const restoreRoot = await makeTemp('linke-c7-mismatch-root-');
    await ensureRestoreParent(restoreRoot);
    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });
    await stateStore.openOrCreateState({
      taskId: TASK_ID,
      deviceId: DEVICE,
      snapshotId: SNAPSHOT_ID,
      manifestDigest: DIGEST,
      relativeTarget: REL_TARGET,
      fileCount: 1,
      totalBytes: files[0].size,
      chunkSize: CHUNK_SIZE,
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
    });
    await stateStore.transitionPhase(TASK_ID, 'planned', 'receiving');
    // Claim durable bytes without staging materialization → mismatch
    await stateStore.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: files[0].size,
    });
    const before = await stateStore.readState(TASK_ID);
    assert.equal(before.receivedBytes, files[0].size);

    const controller = createControllerMock(files);
    const spies = createNetworkSpies({
      requestJson: (o) => controller.requestJson(o),
      download: async (o) => controller.download(o),
    });

    await assert.rejects(
      runEndpointRestore({
        agentUrl: 'https://127.0.0.1:1',
        tlsFingerprint: TLS_FP_A,
        token: TOKEN,
        deviceId: DEVICE,
        protocolVersion: 2,
        restoreRoot,
        endpointDataDir,
        retryBudget: DEFAULT_RETRY,
        stateStore,
        publish: {
          publishFromStagingVerified,
          rollbackPublished,
          recoverFromCrash,
          recoverCancelledLocal,
        },
        requestJson: spies.requestJson,
        download: spies.download,
        now: () => new Date(T0),
      }),
      (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
        || e.code === ERROR_CODES.RESTORE_STATE_INVALID,
    );

    const after = await stateStore.readState(TASK_ID);
    assert.ok(
      after.receivedBytes >= before.receivedBytes,
      'P2-5 e2e: must not write back smaller receivedBytes',
    );
    assert.equal(after.receivedBytes, before.receivedBytes);
  });
});

describe('C7 network retry budget', () => {
  it('C7 default budget 8: disconnect consumes; success does not reset; exhaust → restore-resume-exhausted', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    // Budget semantics (design §13 / plan C7): retryBudget=8 counts cumulative network
    // failures for the whole task. Oracle: the 8th RESTORE_INTERRUPTED fails closed as
    // RESTORE_RESUME_EXHAUSTED (statusCode=null, retryable=false). Success does NOT reset.
    // Counter is failures, not attempts-after-success.

    // Exhaust: every download disconnects → exactly 8 failure deliveries, no 9th.
    {
      let networkFailures = 0;
      const files = buildFilesTable([{ path: 'x.bin', content: 'retry-me' }]);
      const controller = createControllerMock(files);
      const spies = createNetworkSpies({
        requestJson: (o) => controller.requestJson(o),
        download: async () => {
          networkFailures += 1;
          throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
            statusCode: null,
            retryable: true,
          });
        },
      });
      const input = await buildEngineInput(spies, { retryBudget: 8 });
      const { __fixture, ...engineInput } = input;
      await assert.rejects(
        runEndpointRestore(engineInput),
        (e) => e instanceof LinkeError
          && e.code === ERROR_CODES.RESTORE_RESUME_EXHAUSTED
          && e.statusCode === null
          && e.retryable === false,
      );
      assert.equal(
        networkFailures,
        8,
        `budget=8 oracle: exactly 8 network failures before RESUME_EXHAUSTED, got ${networkFailures}`,
      );
    }

    // Partial consume then success within budget (3 fails + 1 ok).
    {
      let downloads = 0;
      let networkFailures = 0;
      const files = buildFilesTable([{ path: 'x.bin', content: 'retry-me' }]);
      const controller = createControllerMock(files);
      const spies = createNetworkSpies({
        requestJson: (o) => controller.requestJson(o),
        download: async (o) => {
          downloads += 1;
          if (networkFailures < 3) {
            networkFailures += 1;
            throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
              statusCode: null,
              retryable: true,
            });
          }
          return controller.download(o);
        },
      });
      const input = await buildEngineInput(spies, { retryBudget: 8 });
      const { __fixture, ...engineInput } = input;
      const result = await runEndpointRestore(engineInput);
      assert.equal(result.outcome, 'completed');
      assert.equal(networkFailures, 3);
      assert.equal(downloads, 4);
    }

    // P2-5: cross mid-task success cumulative budget — multi-file task.
    // Failures 1..3 on file0, then file0 succeeds; failures 4..8 on file1 → exhaust on 8th fail.
    // If budget wrongly resets after file0 success, engine would attempt failure #9+ and this fails.
    {
      const files = buildFilesTable([
        { path: 'f0.bin', content: 'FILE0-PAYLOAD-OK' },
        { path: 'f1.bin', content: 'FILE1-NEVER-OK' },
      ]);
      let networkFailures = 0;
      let successDownloads = 0;
      /** @type {string[]} */
      const failPaths = [];
      const controller = createControllerMock(files);
      const spies = createNetworkSpies({
        requestJson: (o) => controller.requestJson(o),
        download: async (o) => {
          const p = String(o.path);
          // First file: fail 3 times then succeed once.
          if (p.includes('/files/0/chunks/')) {
            if (networkFailures < 3) {
              networkFailures += 1;
              failPaths.push(p);
              throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
                statusCode: null,
                retryable: true,
              });
            }
            successDownloads += 1;
            return controller.download(o);
          }
          // Second file: every attempt is a network failure until budget exhausts.
          networkFailures += 1;
          failPaths.push(p);
          throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
            statusCode: null,
            retryable: true,
          });
        },
      });
      const input = await buildEngineInput(spies, { retryBudget: 8 });
      const { __fixture, ...engineInput } = input;
      await assert.rejects(
        runEndpointRestore(engineInput),
        (e) => e instanceof LinkeError
          && e.code === ERROR_CODES.RESTORE_RESUME_EXHAUSTED
          && e.statusCode === null
          && e.retryable === false,
      );
      assert.equal(
        networkFailures,
        8,
        `cross-success cumulative: 8th network failure must exhaust (got ${networkFailures})`,
      );
      assert.equal(successDownloads, 1, 'exactly one mid-task success must not reset budget');
      assert.ok(
        failPaths.some((p) => p.includes('/files/1/chunks/')),
        'failures after mid-task success must continue on subsequent chunk',
      );
      // If reset-on-success: would need 3+1+8=12 failure deliveries for second file alone.
      assert.ok(networkFailures < 9, 'must not observe 9th+ network failure after exhaust');
    }

    // integrity is non-retry
    {
      const files = buildFilesTable([{ path: 'x.bin', content: 'retry-me' }]);
      const controller = createControllerMock(files, { corruptChunk: true });
      let downloads = 0;
      const spies = createNetworkSpies({
        requestJson: (o) => controller.requestJson(o),
        download: async (o) => {
          downloads += 1;
          return controller.download(o);
        },
      });
      const input = await buildEngineInput(spies);
      const { __fixture, ...engineInput } = input;
      await assert.rejects(
        runEndpointRestore(engineInput),
        (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED && e.retryable === false,
      );
      assert.equal(downloads, 1);
      assert.equal(controller.stats().receiptPosts, 0);
      assert.equal(controller.stats().cleanupPosts, 0);
    }
  });

  it('C7 path/capacity/state/publish/rollback errors do not consume retry as network success-reset', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'x.bin', content: 'z' }]);
    const nonRetryCodes = [
      ERROR_CODES.RESTORE_PATH_INVALID,
      ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT,
      ERROR_CODES.RESTORE_STATE_INVALID,
      ERROR_CODES.RESTORE_PUBLISH_CONFLICT,
      ERROR_CODES.RESTORE_ROLLBACK_FAILED,
    ];
    for (const code of nonRetryCodes) {
      let downloads = 0;
      const spies = createNetworkSpies({
        requestJson: async (o) => {
          if (String(o.path).endsWith('/claim')) {
            return {
              task: {
                taskId: TASK_ID,
                snapshotId: SNAPSHOT_ID,
                manifestDigest: DIGEST,
                relativeTarget: REL_TARGET,
                status: 'active',
                fileCount: 1,
                totalBytes: 1,
                chunkSize: CHUNK_SIZE,
                createdAt: T0,
                claimedAt: T0,
                cancelRequested: false,
              },
            };
          }
          if (String(o.method).toUpperCase() === 'GET') {
            return {
              taskId: TASK_ID,
              snapshotId: SNAPSHOT_ID,
              manifestDigest: DIGEST,
              relativeTarget: REL_TARGET,
              status: 'active',
              cancelRequested: false,
              cleanupAuthorized: false,
              fileCount: 1,
              totalBytes: 1,
              chunkSize: CHUNK_SIZE,
              files: files.map(({ fileIndex, path, size, sha256, chunkCount }) => ({
                fileIndex, path, size, sha256, chunkCount,
              })),
            };
          }
          throw new LinkeError(code, {
            statusCode: code === ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT ? 507 : 400,
          });
        },
        download: async () => {
          downloads += 1;
          throw new LinkeError(code, { statusCode: 400, retryable: false });
        },
      });
      const input = await buildEngineInput(spies, { retryBudget: 8 });
      const { __fixture, ...engineInput } = input;
      await assert.rejects(
        runEndpointRestore(engineInput),
        (e) => e.code === code || e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
          || e.code === ERROR_CODES.RESTORE_PATH_INVALID
          || e.code === ERROR_CODES.RESTORE_STATE_INVALID
          || e.code === ERROR_CODES.RESTORE_TASK_INVALID
          || e.code === ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT
          || e.code === ERROR_CODES.RESTORE_PUBLISH_CONFLICT
          || e.code === ERROR_CODES.RESTORE_ROLLBACK_FAILED,
      );
      // Non-retry: must not hammer download 8 times for same hard error at download site
      assert.ok(downloads <= 1, `${code} must not network-retry, downloads=${downloads}`);
    }
  });
});

describe('C7 corrupt chunk fail-close', () => {
  it('C7 corrupt chunk → restore-integrity-failed; download 1; publish/receipt/cleanup 0', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'c.bin', content: 'good' }]);
    const controller = createControllerMock(files, { corruptChunk: true });
    const spies = createNetworkSpies({
      requestJson: (o) => controller.requestJson(o),
      download: (o) => controller.download(o),
    });
    const input = await buildEngineInput(spies);
    const { __fixture, ...engineInput } = input;

    await assert.rejects(
      runEndpointRestore(engineInput),
      (e) => e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED && e.retryable === false,
    );
    assert.equal(spies.downloadCalls.length, 1);
    assert.equal(controller.stats().receiptPosts, 0);
    assert.equal(controller.stats().cleanupPosts, 0);
    // No publish: target must not exist as restored tree
    await assert.rejects(lstat(join(__fixture.restoreRoot, REL_TARGET, 'c.bin')));
  });
});

describe('C7 cancel gates', () => {
  it('C7 pre-anchor cancel → cancelled-local; delete unpublished staging; stable CleanupReceipt cancelled; no anchor/receipt', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'c.txt', content: 'cancel-me' }]);
    // P2-8: first cleanup is legitimate transient RESTORE_INTERRUPTED; second ACK.
    const controller = createControllerMock(files, {
      cancelBeforeAnchor: true,
      cleanupTransientFirst: true,
    });
    const spies = createNetworkSpies({
      requestJson: (o) => controller.requestJson(o),
      download: (o) => controller.download(o),
    });
    const input = await buildEngineInput(spies);
    const { __fixture, ...engineInput } = input;

    const result = await runEndpointRestore(engineInput);
    assert.equal(result.outcome, 'cancelled');

    const st = controller.stats();
    // P2-8 unconditional: >=2 cleanup posts; all cleanupId equal; full bodies identical.
    assert.ok(st.cleanupPosts >= 2, `cleanup replay requires >=2 posts, got ${st.cleanupPosts}`);
    assert.equal(st.cleanupBodies.length, st.cleanupPosts);
    const firstBody = st.cleanupBodies[0];
    assert.equal(firstBody?.outcome, 'cancelled');
    assert.equal(firstBody?.receiptId, null);
    assert.equal(typeof firstBody?.cleanupId, 'string');
    assert.ok(firstBody.cleanupId.length > 0);
    for (let i = 0; i < st.cleanupBodies.length; i += 1) {
      assert.deepEqual(
        st.cleanupBodies[i],
        firstBody,
        `cleanup body[${i}] must equal first body (stable cleanupId replay)`,
      );
      assert.equal(st.cleanupBodies[i].cleanupId, firstBody.cleanupId);
    }
    assert.equal(st.receiptPosts, 0, 'cancelled path must not create business receipt');

    // staging deleted; no anchor
    const names = deriveSiblingNames(TASK_ID);
    const parent = join(__fixture.restoreRoot, 'apps');
    await assert.rejects(lstat(join(parent, names.stagingName)));
    await assert.rejects(lstat(join(parent, names.anchorName)));
  });

  it('C7 post-anchor-intent cancelRequested never cancelled-local; must completed or rolled-back with receipt/cleanup', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'p.txt', content: 'post-anchor' }]);
    // cancelRequested=true from first claim/GET — not vacuous progress/second-GET flip.
    const controller = createControllerMock(files, { cancelFromStart: true });
    const spies = createNetworkSpies({
      requestJson: (o) => controller.requestJson(o),
      download: (o) => controller.download(o),
    });
    const input = await buildEngineInput(spies);
    const { __fixture, ...engineInput } = input;

    // Legal durable recovery fixture: STATE + staging + progress → anchor-intent.
    const seeded = await seedDurableRestoreState({
      stateStore: __fixture.stateStore,
      restoreRoot: __fixture.restoreRoot,
      files,
      targetPhase: 'anchor-intent',
    });
    assert.equal(seeded.phase, 'anchor-intent');
    const pre = await __fixture.stateStore.readState(TASK_ID);
    assert.equal(pre.phase, 'anchor-intent');
    assert.notEqual(pre.phase, 'cancelled-local');

    const result = await runEndpointRestore(engineInput);
    assert.ok(
      result.outcome === 'completed' || result.outcome === 'rolled-back',
      `post-anchor must not cancel; got ${result.outcome}`,
    );
    assert.notEqual(result.outcome, 'cancelled');

    const st = controller.stats();
    // Prove engine observed cancelRequested=true (not a vacuous never-delivered flag).
    assert.ok(
      st.cancelObservations.length >= 1,
      'engine must call claim/GET/progress that returns cancelRequested',
    );
    assert.ok(
      st.cancelObservations.some((v) => v === true),
      'engine must observe cancelRequested===true at least once',
    );
    assert.equal(st.cancelRequested, true);

    assert.ok(st.receiptPosts >= 1, 'must post ReceiptObject');
    assert.ok(st.cleanupPosts >= 1, 'must post CleanupReceipt');
    assert.ok(
      st.lastReceiptBody?.outcome === 'completed' || st.lastReceiptBody?.outcome === 'rolled-back',
    );
    assert.notEqual(st.lastCleanupBody?.outcome, 'cancelled');

    const state = await __fixture.stateStore.readState(TASK_ID);
    assert.notEqual(state.phase, 'cancelled-local');
  });
});

describe('C7 empty files + path layout + validator fail-close', () => {
  it('C7 empty files skip GET chunk; multi-layer paths rebuilt; hostile paths fail-close', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();

    // multi-layer happy
    {
      const files = buildFilesTable([
        { path: 'empty.dat', content: Buffer.alloc(0) },
        { path: 'dir/sub/file.txt', content: 'deep' },
      ]);
      const controller = createControllerMock(files);
      const spies = createNetworkSpies({
        requestJson: (o) => controller.requestJson(o),
        download: (o) => controller.download(o),
      });
      const input = await buildEngineInput(spies);
      const { __fixture, ...engineInput } = input;
      const result = await runEndpointRestore(engineInput);
      assert.equal(result.outcome, 'completed');
      assert.ok(spies.downloadCalls.every((c) => !c.path.includes('/files/0/chunks/')),
        'empty fileIndex 0 must not download');
      assert.ok(spies.downloadCalls.some((c) => c.path.includes('/files/1/chunks/0')));
      const deep = await readFile(join(__fixture.restoreRoot, REL_TARGET, 'dir/sub/file.txt'), 'utf8');
      assert.equal(deep, 'deep');
    }

    // hostile paths from GET task must fail-close (absolute / .. / cross)
    {
      const hostilePaths = ['/abs/path', '../escape', 'a/../../b', 'x\\y', ''];
      for (const badPath of hostilePaths) {
        const spies = createNetworkSpies({
          requestJson: async (o) => {
            if (String(o.path).endsWith('/claim')) {
              return {
                task: {
                  taskId: TASK_ID,
                  snapshotId: SNAPSHOT_ID,
                  manifestDigest: DIGEST,
                  relativeTarget: REL_TARGET,
                  status: 'active',
                  fileCount: 1,
                  totalBytes: 1,
                  chunkSize: CHUNK_SIZE,
                  createdAt: T0,
                  claimedAt: T0,
                  cancelRequested: false,
                },
              };
            }
            if (String(o.method).toUpperCase() === 'GET') {
              return {
                taskId: TASK_ID,
                snapshotId: SNAPSHOT_ID,
                manifestDigest: DIGEST,
                relativeTarget: REL_TARGET,
                status: 'active',
                cancelRequested: false,
                cleanupAuthorized: false,
                fileCount: 1,
                totalBytes: 1,
                chunkSize: CHUNK_SIZE,
                files: [{
                  fileIndex: 0,
                  path: badPath,
                  size: 1,
                  sha256: sha256Hex(Buffer.from('x')),
                  chunkCount: 1,
                }],
              };
            }
            throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID, { statusCode: 400 });
          },
          download: async () => {
            throw new Error('download must not run for invalid path');
          },
        });
        const input = await buildEngineInput(spies);
        const { __fixture, ...engineInput } = input;
        await assert.rejects(
          runEndpointRestore(engineInput),
          (e) => e.code === ERROR_CODES.RESTORE_PATH_INVALID
            || e.code === ERROR_CODES.RESTORE_TASK_INVALID
            || e.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED,
          `hostile path ${badPath}`,
        );
        assert.equal(spies.downloadCalls.length, 0, `no download for ${badPath}`);
      }
    }
  });
});

describe('C7 AbortSignal boundaries', () => {
  it('C7 AbortSignal pre-anchor cancels safely; post-anchor does not leave pseudo-terminal cancelled', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'a.txt', content: 'signal' }]);

    // pre-anchor abort during download — allowed: LinkeError device-request-invalid / interrupted
    {
      const ac = new AbortController();
      let downloads = 0;
      const controller = createControllerMock(files);
      const spies = createNetworkSpies({
        requestJson: (o) => controller.requestJson(o),
        download: async () => {
          downloads += 1;
          ac.abort();
          throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
        },
      });
      const input = await buildEngineInput(spies);
      const { __fixture, ...engineInput } = input;
      await assert.rejects(
        runEndpointRestore({ ...engineInput, signal: ac.signal }),
        (e) => e instanceof LinkeError
          && (
            e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
            || e.code === ERROR_CODES.RESTORE_INTERRUPTED
            || e.code === ERROR_CODES.RESTORE_TASK_INVALID
          ),
      );
      assert.ok(downloads <= 2);
      const state = await __fixture.stateStore.readState(TASK_ID).catch(() => null);
      if (state) {
        assert.notEqual(state.phase, 'cleaned', 'abort must not fake cleaned');
        assert.notEqual(state.phase, 'cancelled-local');
      }
    }

    // post-anchor abort: seed anchor-intent; abort during receipts; must not cancelled-local.
    // Tight oracle: only abort-signal / interrupt codes as non-terminal; never treat
    // STATE_INVALID / TASK_INVALID / publish-conflict / rollback-failed as success.
    {
      const ac = new AbortController();
      const controller = createControllerMock(files);
      let receiptSeen = false;
      const spies = createNetworkSpies({
        requestJson: async (o) => {
          const res = await controller.requestJson(o);
          if (String(o.path).includes('/receipts')) {
            receiptSeen = true;
            ac.abort();
          }
          return res;
        },
        download: (o) => controller.download(o),
      });
      const input = await buildEngineInput(spies);
      const { __fixture, ...engineInput } = input;
      await seedDurableRestoreState({
        stateStore: __fixture.stateStore,
        restoreRoot: __fixture.restoreRoot,
        files,
        targetPhase: 'anchor-intent',
      });

      /** @type {{ outcome?: string } | null} */
      let result = null;
      /** @type {unknown} */
      let caught = null;
      try {
        result = await runEndpointRestore({ ...engineInput, signal: ac.signal });
      } catch (error) {
        caught = error;
      }

      const state = await __fixture.stateStore.readState(TASK_ID);
      assert.notEqual(state.phase, 'cancelled-local', 'post-anchor abort must never write cancelled-local');
      // Phase must remain a legal post-anchor / terminal-awaiting set (replayable receipt/cleanup).
      const legalPostAnchor = new Set([
        'anchor-intent',
        'anchored',
        'publish-intent',
        'published',
        'completed-awaiting-ack',
        'rolled-back-awaiting-ack',
        'cleanup-intent',
        'cleanup-completed-awaiting-ack',
        'cleaned',
        'rollback-intent',
        'failed-target-quarantined',
        'anchor-restored',
        'old-fingerprint-verified',
      ]);
      assert.ok(
        legalPostAnchor.has(state.phase),
        `post-anchor abort phase must stay legal post-anchor/awaiting, got ${state.phase}`,
      );

      if (result) {
        assert.ok(
          result.outcome === 'completed' || result.outcome === 'rolled-back',
          `allowed outcomes after post-anchor abort: completed|rolled-back, got ${result.outcome}`,
        );
        assert.notEqual(result.outcome, 'cancelled');
      } else {
        assert.ok(caught instanceof LinkeError, 'post-anchor abort must not throw bare Error');
        const code = /** @type {LinkeError} */ (caught).code;
        // Abort during receipts: only signal/interrupt — not STATE/TASK/publish dump codes.
        assert.ok(
          code === ERROR_CODES.DEVICE_REQUEST_INVALID
            || code === ERROR_CODES.RESTORE_INTERRUPTED,
          `post-anchor abort non-terminal error must be signal/interrupt only, got ${code}`,
        );
        assert.notEqual(code, ERROR_CODES.RESTORE_STATE_INVALID);
        assert.notEqual(code, ERROR_CODES.RESTORE_TASK_INVALID);
        assert.notEqual(code, ERROR_CODES.RESTORE_PUBLISH_CONFLICT);
        assert.notEqual(code, ERROR_CODES.RESTORE_ROLLBACK_FAILED);
        assert.notEqual(code, ERROR_CODES.RESTORE_RESUME_EXHAUSTED);
        // Receipt/cleanup must be replayable from durable STATE (no cancelled-local).
        assert.ok(
          receiptSeen
            || state.phase === 'completed-awaiting-ack'
            || state.phase === 'rolled-back-awaiting-ack'
            || legalPostAnchor.has(state.phase),
          'abort path must leave receipt/cleanup replayable durable phase',
        );
      }
    }
  });
});

describe('C7 multi-chunk real requestPinnedDownload (P0-1 wire-compatible)', () => {
  it('C7 two-chunk file via real HTTPS download: no DEVICE_REQUEST_INVALID; publish completes', async () => {
    // files[] frozen shape has whole-file sha only — multi-chunk omits expectedSha256.
    // Prove production requestPinnedDownload accepts omit + header/body gate + engine e2e.
    assert.equal(typeof requestPinnedDownload, 'function');
    const runEndpointRestore = await loadRunEndpointRestore();

    // Controllable size: 8 MiB + small tail (exactly 2 chunks). No string-oracle / monkeypatch.
    const tail = 17;
    const content = Buffer.alloc(CHUNK_SIZE + tail, 0x5a);
    content[0] = 0x11;
    content[CHUNK_SIZE] = 0x22;
    content[content.length - 1] = 0x33;
    const files = buildFilesTable([{ path: 'big.bin', content }]);
    assert.equal(files[0].chunkCount, 2);
    assert.equal(files[0].size, CHUNK_SIZE + tail);

    const controller = createControllerMock(files);
    /** @type {string[]} */
    const chunkUrls = [];
    const server = await startHttpsFixture((req, res) => {
      void (async () => {
        try {
          const urlPath = String(req.url || '');
          chunkUrls.push(urlPath);
          const m = urlPath.match(/\/files\/(\d+)\/chunks\/(\d+)$/);
          if (!m || req.method !== 'GET') {
            const data = JSON.stringify({ error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
            res.writeHead(404, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(data),
            });
            res.end(data);
            return;
          }
          const fileIndex = Number(m[1]);
          const chunkIndex = Number(m[2]);
          const file = files.find((f) => f.fileIndex === fileIndex);
          assert.ok(file);
          const offset = chunkIndex * CHUNK_SIZE;
          const end = Math.min(file.size, offset + CHUNK_SIZE);
          const slice = file.content.subarray(offset, end);
          const sha = sha256Hex(slice);
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': slice.length,
            'cache-control': 'no-store',
            'x-linke-chunk-sha256': sha,
          });
          res.end(slice);
        } catch {
          res.writeHead(500);
          res.end();
        }
      })();
    });

    try {
      /** @type {object[]} */
      const downloadOpts = [];
      async function download(opts) {
        downloadOpts.push({
          path: opts.path,
          expectedLength: opts.expectedLength,
          expectedSha256: opts.expectedSha256,
          hasExpectedSha256: Object.prototype.hasOwnProperty.call(opts, 'expectedSha256'),
        });
        // Real production client — no monkeypatch of hash/string APIs.
        return requestPinnedDownload(opts);
      }

      const input = await buildEngineInput(
        {
          requestJson: (o) => controller.requestJson(o),
          download,
        },
        { agentUrl: server.url, tlsFingerprint: server.fingerprint },
      );
      const { __fixture, ...engineInput } = input;
      const result = await runEndpointRestore(engineInput);
      assert.equal(result.outcome, 'completed');

      // Two chunk GETs; multi-chunk must not pass a priori expectedSha256 (frozen files[]).
      assert.equal(downloadOpts.length, 2);
      for (const d of downloadOpts) {
        assert.equal(
          d.hasExpectedSha256,
          false,
          'multi-chunk must omit expectedSha256 (no per-chunk digest in files[])',
        );
        assert.equal(d.expectedSha256, undefined);
      }
      assert.ok(chunkUrls.some((u) => u.endsWith('/files/0/chunks/0')));
      assert.ok(chunkUrls.some((u) => u.endsWith('/files/0/chunks/1')));

      const published = await readFile(join(__fixture.restoreRoot, REL_TARGET, 'big.bin'));
      assert.equal(published.length, content.length);
      assert.equal(sha256Hex(published), files[0].sha256);
      assert.deepEqual(published, content);

      const st = controller.stats();
      assert.ok(st.receiptPosts >= 1);
      assert.ok(st.cleanupPosts >= 1);
      assert.equal(st.lastReceiptBody?.outcome, 'completed');
    } finally {
      await server.close();
    }
  });
});

describe('C7 retry attempt isolation (P1-1)', () => {
  it('C7 network retry: attempt1 onChunk(partial)+RESTORE_INTERRUPTED; attempt2 full; no partial concat / no false integrity', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const content = Buffer.from('RETRY-ATTEMPT-ISOLATION-FULL-BODY-C7!!');
    const files = buildFilesTable([{ path: 'r.bin', content }]);
    const fullSha = files[0].sha256;
    const controller = createControllerMock(files);
    let attempts = 0;
    const spies = createNetworkSpies({
      requestJson: (o) => controller.requestJson(o),
      download: async (o) => {
        attempts += 1;
        if (attempts === 1) {
          // Deliver a partial that must NOT be retained across the retry.
          await o.onChunk(Buffer.from('PARTIAL-ONLY'));
          throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
            statusCode: null,
            retryable: true,
          });
        }
        // attempt2: full success
        await o.onChunk(content);
        return { bytesReceived: content.length, sha256: fullSha };
      },
    });
    const input = await buildEngineInput(spies);
    const { __fixture, ...engineInput } = input;
    const result = await runEndpointRestore(engineInput);
    assert.equal(result.outcome, 'completed');
    assert.equal(attempts, 2, 'exactly two download attempts');
    assert.equal(spies.downloadCalls.length, 2);

    const published = await readFile(join(__fixture.restoreRoot, REL_TARGET, 'r.bin'));
    assert.deepEqual(published, content);
    assert.equal(sha256Hex(published), fullSha);
    // Must not contain partial prefix concatenated with full body
    assert.equal(published.length, content.length);
    assert.ok(!published.includes(Buffer.from('PARTIAL-ONLY')));
  });
});

describe('C7 local restart resume without claim (P0-2 / P1-2)', () => {
  it('C7 receiving STATE present: 0 claim; GET active task; only remaining chunk; completed', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const part1 = Buffer.from('ALREADY-DURABLE-FILE-0-CONTENT!!');
    const part2 = Buffer.from('REMAINING-FILE-1-CONTENT-ONLY!!');
    const files = buildFilesTable([
      { path: 'f0.bin', content: part1 },
      { path: 'f1.bin', content: part2 },
    ]);
    const totalBytes = part1.length + part2.length;

    const endpointDataDir = await makeTemp('linke-c7-restart-state-');
    const restoreRoot = await makeTemp('linke-c7-restart-root-');
    await ensureRestoreParent(restoreRoot);
    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });
    await stateStore.openOrCreateState({
      taskId: TASK_ID,
      deviceId: DEVICE,
      snapshotId: SNAPSHOT_ID,
      manifestDigest: DIGEST,
      relativeTarget: REL_TARGET,
      fileCount: 2,
      totalBytes,
      chunkSize: CHUNK_SIZE,
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
    });
    await stateStore.transitionPhase(TASK_ID, 'planned', 'receiving');
    await stateStore.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: part1.length,
    });
    const paths = await preflightTarget({
      restoreRoot,
      relativeTarget: REL_TARGET,
      taskId: TASK_ID,
    });
    await mkdir(paths.stagingPathAbs, { recursive: true });
    await materializeChunkToStaging({
      stagingRoot: paths.stagingPathAbs,
      filePath: 'f0.bin',
      chunkIndex: 0,
      chunkSize: CHUNK_SIZE,
      bytes: part1,
      expectedSha256: sha256Hex(part1),
    });

    let claimCount = 0;
    /** @type {string[]} */
    const downloaded = [];
    const controller = createControllerMock(files);
    const spies = createNetworkSpies({
      requestJson: async (o) => {
        if (String(o.path) === '/agent/restore/tasks/claim') {
          claimCount += 1;
          // Controller task already active — claim would conflict. Resume must never claim.
          assert.fail('engine must not claim when local nonterminal STATE exists');
        }
        return controller.requestJson(o);
      },
      download: async (o) => {
        downloaded.push(String(o.path));
        return controller.download(o);
      },
    });

    const result = await runEndpointRestore({
      agentUrl: 'https://127.0.0.1:1',
      tlsFingerprint: TLS_FP_A,
      token: TOKEN,
      deviceId: DEVICE,
      protocolVersion: 2,
      restoreRoot,
      endpointDataDir,
      retryBudget: DEFAULT_RETRY,
      stateStore,
      publish: {
        publishFromStagingVerified,
        rollbackPublished,
        recoverFromCrash,
        recoverCancelledLocal,
      },
      requestJson: spies.requestJson,
      download: spies.download,
      now: () => new Date(T0),
    });

    assert.equal(result.outcome, 'completed');
    assert.equal(claimCount, 0, 'local resume must issue zero claim calls');
    assert.ok(
      spies.jsonCalls.some(
        (c) => c.method === 'GET' && String(c.path) === `/agent/restore/tasks/${TASK_ID}`,
      ),
      'must GET already-active task',
    );
    assert.equal(downloaded.length, 1, 'only remaining file chunk');
    assert.ok(downloaded[0].endsWith('/files/1/chunks/0'));
    assert.ok(!downloaded.some((p) => p.includes('/files/0/')));

    const f0 = await readFile(join(restoreRoot, REL_TARGET, 'f0.bin'));
    const f1 = await readFile(join(restoreRoot, REL_TARGET, 'f1.bin'));
    assert.deepEqual(f0, part1);
    assert.deepEqual(f1, part2);
  });
});

describe('C7 originalTargetExisted=true crash recovery (P0-2 E)', () => {
  /**
   * Seed durable STATE with real old fingerprints + staging; apply real FS renames
   * to reach crash quadrant (not intent-only).
   * @param {{
   *   stateStore: ReturnType<typeof createEndpointRestoreStateStore>,
   *   restoreRoot: string,
   *   files: ReturnType<typeof buildFilesTable>,
   *   crashPhase: 'anchor-intent' | 'publish-intent',
   * }} input
   */
  async function seedOldTargetCrashQuadrant(input) {
    const { stateStore, restoreRoot, files, crashPhase } = input;
    await ensureRestoreParent(restoreRoot);
    const targetAbs = join(restoreRoot, REL_TARGET);
    await mkdir(targetAbs, { recursive: true });
    // Real old target content for fingerprints
    await writeFile(join(targetAbs, 'old-keep.txt'), Buffer.from('OLD-TARGET-BYTES-C7'));
    const oldStructureFingerprint = await computeStructureFingerprint(targetAbs);
    const oldContentSha256 = await computeContentSha256(targetAbs);
    assert.match(oldStructureFingerprint, /^[a-f0-9]{64}$/);
    assert.match(oldContentSha256, /^[a-f0-9]{64}$/);

    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    await stateStore.openOrCreateState({
      taskId: TASK_ID,
      deviceId: DEVICE,
      snapshotId: SNAPSHOT_ID,
      manifestDigest: DIGEST,
      relativeTarget: REL_TARGET,
      fileCount: files.length,
      totalBytes,
      chunkSize: CHUNK_SIZE,
      originalTargetExisted: true,
      oldStructureFingerprint,
      oldContentSha256,
    });
    await stateStore.transitionPhase(TASK_ID, 'planned', 'receiving');

    const paths = await preflightTarget({
      restoreRoot,
      relativeTarget: REL_TARGET,
      taskId: TASK_ID,
    });
    await mkdir(paths.stagingPathAbs, { recursive: true });
    let receivedBytes = 0;
    for (const file of files) {
      if (file.size === 0) {
        await materializeChunkToStaging({
          stagingRoot: paths.stagingPathAbs,
          filePath: file.path,
          chunkIndex: 0,
          chunkSize: CHUNK_SIZE,
          bytes: Buffer.alloc(0),
          expectedSha256: ZERO_SHA,
        });
        continue;
      }
      for (let chunkIndex = 0; chunkIndex < file.chunkCount; chunkIndex += 1) {
        const offset = chunkIndex * CHUNK_SIZE;
        const end = Math.min(file.size, offset + CHUNK_SIZE);
        const bytes = file.content.subarray(offset, end);
        await materializeChunkToStaging({
          stagingRoot: paths.stagingPathAbs,
          filePath: file.path,
          chunkIndex,
          chunkSize: CHUNK_SIZE,
          bytes,
          expectedSha256: sha256Hex(bytes),
        });
      }
      receivedBytes += file.size;
      await stateStore.recordDurableProgress(TASK_ID, {
        fileIndex: file.fileIndex,
        chunkIndex: Math.max(0, file.chunkCount - 1),
        receivedBytes,
      });
    }
    await verifyStagingTree({
      stagingRoot: paths.stagingPathAbs,
      files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    });
    await stateStore.transitionPhase(TASK_ID, 'receiving', 'staging-verified');
    await stateStore.transitionPhase(TASK_ID, 'staging-verified', 'anchor-intent');

    // Real rename: old target → anchor (crash window after anchor rename)
    await fsRename(paths.targetPathAbs, paths.anchorPathAbs);
    await assert.rejects(lstat(paths.targetPathAbs));
    const anchorStat = await lstat(paths.anchorPathAbs);
    assert.equal(anchorStat.isDirectory(), true);
    // Staging still present
    const stagingStat = await lstat(paths.stagingPathAbs);
    assert.equal(stagingStat.isDirectory(), true);

    if (crashPhase === 'anchor-intent') {
      const st = await stateStore.readState(TASK_ID);
      assert.equal(st.phase, 'anchor-intent');
      assert.equal(st.originalTargetExisted, true);
      assert.equal(st.oldStructureFingerprint, oldStructureFingerprint);
      assert.equal(st.oldContentSha256, oldContentSha256);
      return { paths, oldStructureFingerprint, oldContentSha256, phase: 'anchor-intent' };
    }

    // Advance durable phase through anchored → publish-intent, then real staging→target
    await stateStore.transitionPhase(TASK_ID, 'anchor-intent', 'anchored');
    await stateStore.transitionPhase(TASK_ID, 'anchored', 'publish-intent');
    await fsRename(paths.stagingPathAbs, paths.targetPathAbs);
    await assert.rejects(lstat(paths.stagingPathAbs));
    const tStat = await lstat(paths.targetPathAbs);
    assert.equal(tStat.isDirectory(), true);
    const aStat = await lstat(paths.anchorPathAbs);
    assert.equal(aStat.isDirectory(), true);

    const st = await stateStore.readState(TASK_ID);
    assert.equal(st.phase, 'publish-intent');
    assert.equal(st.originalTargetExisted, true);
    return { paths, oldStructureFingerprint, oldContentSha256, phase: 'publish-intent' };
  }

  it('C7 E1: durable anchor-intent + target→anchor rename; re-entry recoverFromCrash → completed (not STATE_INVALID)', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'new.txt', content: 'NEW-PUBLISH-BODY' }]);
    const controller = createControllerMock(files);
    let claimCount = 0;
    const spies = createNetworkSpies({
      requestJson: async (o) => {
        if (String(o.path) === '/agent/restore/tasks/claim') {
          claimCount += 1;
          assert.fail('post-anchor crash resume must not claim');
        }
        return controller.requestJson(o);
      },
      download: (o) => controller.download(o),
    });
    const input = await buildEngineInput(spies);
    const { __fixture, ...engineInput } = input;

    const seeded = await seedOldTargetCrashQuadrant({
      stateStore: __fixture.stateStore,
      restoreRoot: __fixture.restoreRoot,
      files,
      crashPhase: 'anchor-intent',
    });
    assert.equal(seeded.phase, 'anchor-intent');

    const result = await runEndpointRestore(engineInput);
    assert.equal(result.outcome, 'completed');
    assert.notEqual(result.outcome, 'cancelled');
    assert.equal(claimCount, 0);

    const st = controller.stats();
    assert.ok(st.receiptPosts >= 1, 'must post business receipt');
    assert.ok(st.cleanupPosts >= 1, 'must post cleanup');
    assert.equal(st.lastReceiptBody?.outcome, 'completed');

    const state = await __fixture.stateStore.readState(TASK_ID);
    assert.notEqual(state.phase, 'cancelled-local');
    assert.notEqual(state.phase, 'anchor-intent', 'must advance past crash intent');
  });

  it('C7 E2: durable publish-intent + staging→target already done; re-entry verifies real target → completed', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'new.txt', content: 'NEW-AFTER-PUBLISH-INTENT' }]);
    const controller = createControllerMock(files);
    let claimCount = 0;
    const spies = createNetworkSpies({
      requestJson: async (o) => {
        if (String(o.path) === '/agent/restore/tasks/claim') {
          claimCount += 1;
          assert.fail('publish-intent crash resume must not claim');
        }
        return controller.requestJson(o);
      },
      download: async () => {
        throw new Error('download must not run on publish-intent recovery');
      },
    });
    const input = await buildEngineInput(spies);
    const { __fixture, ...engineInput } = input;

    const seeded = await seedOldTargetCrashQuadrant({
      stateStore: __fixture.stateStore,
      restoreRoot: __fixture.restoreRoot,
      files,
      crashPhase: 'publish-intent',
    });
    assert.equal(seeded.phase, 'publish-intent');

    // Real target already holds new tree; anchor holds old
    const newAtTarget = await readFile(
      join(seeded.paths.targetPathAbs, 'new.txt'),
      'utf8',
    );
    assert.equal(newAtTarget, 'NEW-AFTER-PUBLISH-INTENT');
    const oldAtAnchor = await readFile(
      join(seeded.paths.anchorPathAbs, 'old-keep.txt'),
      'utf8',
    );
    assert.equal(oldAtAnchor, 'OLD-TARGET-BYTES-C7');

    const result = await runEndpointRestore(engineInput);
    assert.equal(result.outcome, 'completed');
    assert.notEqual(result.outcome, 'cancelled');
    assert.equal(claimCount, 0);
    assert.equal(spies.downloadCalls.length, 0);

    const st = controller.stats();
    assert.ok(st.receiptPosts >= 1);
    assert.ok(st.cleanupPosts >= 1);
    assert.equal(st.lastReceiptBody?.outcome, 'completed');

    if (result.outcome === 'completed') {
      const published = await readFile(
        join(__fixture.restoreRoot, REL_TARGET, 'new.txt'),
        'utf8',
      );
      assert.equal(published, 'NEW-AFTER-PUBLISH-INTENT');
    }
  });
});

describe('C7 requestPinnedBinary remains valid requestJson shape', () => {
  it('C7 real HTTPS requestPinnedBinary is the requestJson control-plane path (not mock-only)', async () => {
    // P2-7: real requestPinnedBinary against real HTTPS fixture as engine requestJson.
    // Minimal pre-anchor cancel path — proves engine forwards full field set and real
    // requestPinnedBinary successfully parses controller JSON (no mock self-certification).
    assert.equal(typeof requestPinnedBinary, 'function');
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'z.txt', content: 'z' }]);
    const controller = createControllerMock(files, { cancelBeforeAnchor: true });

    /** @type {object[]} */
    const realJsonCalls = [];
    const server = await startHttpsFixture((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          let body = null;
          if (chunks.length > 0) {
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              body = null;
            }
          }
          try {
            const result = await controller.requestJson({
              agentUrl: `https://127.0.0.1`,
              tlsFingerprint: TLS_FP_A,
              method: req.method,
              path: req.url,
              token: TOKEN,
              deviceId: DEVICE,
              protocolVersion: 2,
              body,
              bodyMode: req.method === 'GET' ? 'none' : 'json',
              timeoutMs: JSON_TIMEOUT_MS,
            });
            const data = JSON.stringify(result);
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(data),
            });
            res.end(data);
          } catch (error) {
            const code = error instanceof LinkeError ? error.code : ERROR_CODES.DEVICE_REQUEST_INVALID;
            const status = error instanceof LinkeError && error.statusCode != null
              ? Number(error.statusCode)
              : 400;
            const data = JSON.stringify({ error: code });
            res.writeHead(status, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(data),
            });
            res.end(data);
          }
        })().catch(() => {
          res.writeHead(500);
          res.end('{}');
        });
      });
    });

    try {
      async function requestJson(opts) {
        realJsonCalls.push({
          agentUrl: opts.agentUrl,
          tlsFingerprint: opts.tlsFingerprint,
          token: opts.token,
          deviceId: opts.deviceId,
          protocolVersion: opts.protocolVersion,
          method: opts.method,
          bodyMode: opts.bodyMode,
          timeoutMs: opts.timeoutMs,
          path: opts.path,
        });
        assertRequestJsonShape(opts, String(opts.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST');
        // Real production helper — resolves parsed JSON object on 2xx; throws LinkeError otherwise.
        return requestPinnedBinary({
          agentUrl: opts.agentUrl,
          path: opts.path,
          tlsFingerprint: opts.tlsFingerprint,
          method: opts.method,
          token: opts.token,
          deviceId: opts.deviceId,
          protocolVersion: opts.protocolVersion,
          body: opts.body ?? null,
          bodyMode: opts.bodyMode,
          timeoutMs: opts.timeoutMs,
        });
      }

      const input = await buildEngineInput(
        {
          requestJson,
          download: async () => {
            throw new Error('download must not run on pre-anchor cancel-only path');
          },
        },
        { agentUrl: server.url, tlsFingerprint: server.fingerprint },
      );
      const { __fixture, ...engineInput } = input;
      const result = await runEndpointRestore(engineInput);
      assert.equal(result.outcome, 'cancelled');
      assert.ok(realJsonCalls.length >= 1, 'engine must invoke real requestPinnedBinary path');
      for (const c of realJsonCalls) {
        assert.equal(c.agentUrl, server.url);
        assert.equal(c.tlsFingerprint, server.fingerprint);
        assert.equal(c.token, TOKEN);
        assert.equal(c.deviceId, DEVICE);
        assert.equal(c.protocolVersion, 2);
        assert.equal(c.timeoutMs, JSON_TIMEOUT_MS);
        if (String(c.method).toUpperCase() === 'GET') assert.equal(c.bodyMode, 'none');
        else assert.equal(c.bodyMode, 'json');
      }
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Closure safety negative oracles (identity + discovery + capacity/bound)
// ---------------------------------------------------------------------------

describe('C7 resume identity drift fail-close matrix', () => {
  /**
   * Table-driven: local nonterminal STATE + GET task identity mismatch → unique
   * restore-state-invalid; claim/download/receipt/cleanup = 0; target untouched.
   */
  const driftCases = [
    {
      field: 'taskId',
      mode: 'get',
      applyGet: (body) => ({ ...body, taskId: TASK_ID_B }),
    },
    {
      field: 'deviceId',
      mode: 'mutate-state',
      mutateState: (state) => {
        state.deviceId = DEVICE_DRIFT;
      },
    },
    {
      field: 'snapshotId',
      mode: 'get',
      applyGet: (body) => ({ ...body, snapshotId: SNAPSHOT_ID_DRIFT }),
    },
    {
      field: 'manifestDigest',
      mode: 'get',
      applyGet: (body) => ({ ...body, manifestDigest: DIGEST_DRIFT }),
    },
    {
      field: 'relativeTarget',
      mode: 'get',
      applyGet: (body) => ({ ...body, relativeTarget: REL_TARGET_DRIFT }),
    },
    {
      field: 'fileCount',
      mode: 'get',
      // STATE seeded with 1 file; GET advertises 2 files (valid projection shape).
      applyGet: (_body, baseFiles) => {
        const two = buildFilesTable([
          { path: baseFiles[0].path, content: baseFiles[0].content },
          { path: 'extra-drift.txt', content: 'EXTRA' },
        ]);
        return buildGetTaskBody(two, { fileCount: 2 });
      },
    },
    {
      field: 'totalBytes',
      mode: 'get',
      applyGet: (_body, baseFiles) => {
        // Different payload size → different totalBytes; files[] sum consistent.
        const drifted = buildFilesTable([
          {
            path: baseFiles[0].path,
            content: `${baseFiles[0].content.toString('utf8')}-X`,
          },
        ]);
        assert.notEqual(
          drifted[0].size,
          baseFiles[0].size,
          'totalBytes drift fixture must change size',
        );
        return buildGetTaskBody(drifted);
      },
    },
    {
      field: 'chunkSize',
      mode: 'mutate-state',
      mutateState: (state) => {
        // Valid GET always projects RESTORE_CHUNK_SIZE; drift STATE side only.
        state.chunkSize = 4096;
      },
    },
  ];

  for (const driftCase of driftCases) {
    it(
      `C7 resume identity drift on ${driftCase.field} → unique restore-state-invalid; claim/download/receipt/cleanup=0`,
      async () => {
        const runEndpointRestore = await loadRunEndpointRestore();
        const baseFiles = buildFilesTable([
          { path: 'id-drift.txt', content: 'IDENTITY-DRIFT-BASE' },
        ]);
        const endpointDataDir = await makeTemp(`linke-c7-id-drift-${driftCase.field}-`);
        const restoreRoot = await makeTemp(`linke-c7-id-drift-root-${driftCase.field}-`);
        await ensureRestoreParent(restoreRoot);
        // Pre-existing marker outside relativeTarget — must not be polluted.
        await writeFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'PRE-EXISTING-KEEP');
        // Optional pre-existing target tree content.
        await mkdir(join(restoreRoot, REL_TARGET), { recursive: true });
        await writeFile(
          join(restoreRoot, REL_TARGET, 'old-target.txt'),
          'OLD-TARGET-MUST-STAY',
        );

        const realStore = createEndpointRestoreStateStore({
          endpointDataDir,
          now: () => new Date(T0),
        });
        const stateStore = wrapStateStoreMutableView(realStore);
        await seedLocalReceivingState({ stateStore: realStore, files: baseFiles });

        let claimCount = 0;
        let downloadCount = 0;
        let receiptCount = 0;
        let cleanupCount = 0;
        /** @type {object[]} */
        const jsonCalls = [];

        async function requestJson(opts) {
          const method = String(opts.method || 'POST').toUpperCase();
          const path = String(opts.path || '');
          assertRequestJsonShape(opts, method === 'GET' ? 'GET' : 'POST');
          jsonCalls.push({ method, path, body: opts.body });

          if (method === 'POST' && path === '/agent/restore/tasks/claim') {
            claimCount += 1;
            assert.fail('identity drift resume must never claim');
          }
          if (method === 'POST' && path === `/agent/restore/tasks/${TASK_ID}/receipts`) {
            receiptCount += 1;
            assert.fail('identity drift must never publish receipt');
          }
          if (method === 'POST' && path === `/agent/restore/tasks/${TASK_ID}/cleanup`) {
            cleanupCount += 1;
            assert.fail('identity drift must never cleanup');
          }
          if (method === 'GET' && path === `/agent/restore/tasks/${TASK_ID}`) {
            // Mutate durable-view fields that cannot legally diverge via valid GET.
            if (driftCase.mode === 'mutate-state') {
              const plain = stateStore.getLastPlainState();
              assert.ok(plain, 'discovery must have loaded local STATE before GET');
              driftCase.mutateState(plain);
            }
            const baseBody = buildGetTaskBody(baseFiles);
            if (typeof driftCase.applyGet === 'function') {
              return driftCase.applyGet(baseBody, baseFiles);
            }
            return baseBody;
          }
          throw new LinkeError(ERROR_CODES.DEVICE_ROUTE_NOT_FOUND, { statusCode: 404 });
        }

        async function download() {
          downloadCount += 1;
          assert.fail('identity drift must never download');
        }

        await assert.rejects(
          runEndpointRestore({
            agentUrl: 'https://127.0.0.1:1',
            tlsFingerprint: TLS_FP_A,
            token: TOKEN,
            deviceId: DEVICE,
            protocolVersion: 2,
            restoreRoot,
            endpointDataDir,
            retryBudget: DEFAULT_RETRY,
            stateStore,
            publish: {
              publishFromStagingVerified,
              rollbackPublished,
              recoverFromCrash,
              recoverCancelledLocal,
            },
            requestJson,
            download,
            now: () => new Date(T0),
          }),
          (e) => e instanceof LinkeError
            && e.code === ERROR_CODES.RESTORE_STATE_INVALID
            && e.code !== ERROR_CODES.RESTORE_TASK_INVALID
            && e.code !== ERROR_CODES.RESTORE_TASK_CONFLICT
            && e.code !== ERROR_CODES.RESTORE_INTEGRITY_FAILED
            && e.code !== ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT,
        );

        assert.equal(claimCount, 0);
        assert.equal(downloadCount, 0);
        assert.equal(receiptCount, 0);
        assert.equal(cleanupCount, 0);
        assertNoDangerousRemoteSideEffects(
          { jsonCalls, downloadCalls: [] },
          null,
        );

        // Target content must remain pre-existing (no publish pollution).
        const kept = await readFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'utf8');
        assert.equal(kept, 'PRE-EXISTING-KEEP');
        const oldTarget = await readFile(
          join(restoreRoot, REL_TARGET, 'old-target.txt'),
          'utf8',
        );
        assert.equal(oldTarget, 'OLD-TARGET-MUST-STAY');
        await assert.rejects(
          lstat(join(restoreRoot, REL_TARGET, 'id-drift.txt')),
          'must not publish drifted restore payload into target',
        );
      },
    );
  }
});

describe('C7 local discovery fail-close oracle', () => {
  it('C7 UUID-named symlink under restore-tasks → unique restore-state-invalid; claim/download/receipt/cleanup=0', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const endpointDataDir = await makeTemp('linke-c7-disc-symlink-');
    const restoreRoot = await makeTemp('linke-c7-disc-symlink-root-');
    await ensureRestoreParent(restoreRoot);
    await writeFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'PRE-EXISTING-KEEP');

    const tasksDir = join(endpointDataDir, 'restore-tasks');
    await mkdir(tasksDir, { recursive: true, mode: 0o700 });
    const symlinkTarget = await makeTemp('linke-c7-disc-symlink-tgt-');
    await symlink(symlinkTarget, join(tasksDir, TASK_ID));

    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });
    let claimCount = 0;
    let downloadCount = 0;
    const spies = createNetworkSpies({
      requestJson: async (o) => {
        if (String(o.path) === '/agent/restore/tasks/claim') {
          claimCount += 1;
          assert.fail('UUID symlink discovery must fail before claim');
        }
        throw new LinkeError(ERROR_CODES.DEVICE_ROUTE_NOT_FOUND, { statusCode: 404 });
      },
      download: async () => {
        downloadCount += 1;
        assert.fail('UUID symlink discovery must not download');
      },
    });

    await assert.rejects(
      runEndpointRestore({
        agentUrl: 'https://127.0.0.1:1',
        tlsFingerprint: TLS_FP_A,
        token: TOKEN,
        deviceId: DEVICE,
        protocolVersion: 2,
        restoreRoot,
        endpointDataDir,
        retryBudget: DEFAULT_RETRY,
        stateStore,
        publish: {
          publishFromStagingVerified,
          rollbackPublished,
          recoverFromCrash,
          recoverCancelledLocal,
        },
        requestJson: spies.requestJson,
        download: spies.download,
        now: () => new Date(T0),
      }),
      (e) => e instanceof LinkeError && e.code === ERROR_CODES.RESTORE_STATE_INVALID,
    );
    assert.equal(claimCount, 0);
    assert.equal(downloadCount, 0);
    assertNoDangerousRemoteSideEffects(spies, null);
    assert.equal(
      await readFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'utf8'),
      'PRE-EXISTING-KEEP',
    );
  });

  it('C7 UUID-named regular file (non-directory) → unique restore-state-invalid; claim/download/receipt/cleanup=0', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const endpointDataDir = await makeTemp('linke-c7-disc-file-');
    const restoreRoot = await makeTemp('linke-c7-disc-file-root-');
    await ensureRestoreParent(restoreRoot);
    await writeFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'PRE-EXISTING-KEEP');

    const tasksDir = join(endpointDataDir, 'restore-tasks');
    await mkdir(tasksDir, { recursive: true, mode: 0o700 });
    await writeFile(join(tasksDir, TASK_ID), 'not-a-directory');

    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });
    let claimCount = 0;
    let downloadCount = 0;
    const spies = createNetworkSpies({
      requestJson: async (o) => {
        if (String(o.path) === '/agent/restore/tasks/claim') {
          claimCount += 1;
          assert.fail('UUID file discovery must fail before claim');
        }
        throw new LinkeError(ERROR_CODES.DEVICE_ROUTE_NOT_FOUND, { statusCode: 404 });
      },
      download: async () => {
        downloadCount += 1;
        assert.fail('UUID file discovery must not download');
      },
    });

    await assert.rejects(
      runEndpointRestore({
        agentUrl: 'https://127.0.0.1:1',
        tlsFingerprint: TLS_FP_A,
        token: TOKEN,
        deviceId: DEVICE,
        protocolVersion: 2,
        restoreRoot,
        endpointDataDir,
        retryBudget: DEFAULT_RETRY,
        stateStore,
        publish: {
          publishFromStagingVerified,
          rollbackPublished,
          recoverFromCrash,
          recoverCancelledLocal,
        },
        requestJson: spies.requestJson,
        download: spies.download,
        now: () => new Date(T0),
      }),
      (e) => e instanceof LinkeError && e.code === ERROR_CODES.RESTORE_STATE_INVALID,
    );
    assert.equal(claimCount, 0);
    assert.equal(downloadCount, 0);
    assertNoDangerousRemoteSideEffects(spies, null);
    assert.equal(
      await readFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'utf8'),
      'PRE-EXISTING-KEEP',
    );
  });

  it('C7 UUID directory with corrupt STATE → unique restore-state-invalid; claim/download/receipt/cleanup=0', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const endpointDataDir = await makeTemp('linke-c7-disc-badstate-');
    const restoreRoot = await makeTemp('linke-c7-disc-badstate-root-');
    await ensureRestoreParent(restoreRoot);
    await writeFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'PRE-EXISTING-KEEP');

    const taskDir = join(endpointDataDir, 'restore-tasks', TASK_ID);
    await mkdir(taskDir, { recursive: true, mode: 0o700 });
    await writeFile(join(taskDir, 'STATE.json'), '{not-valid-json', { mode: 0o600 });

    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });
    let claimCount = 0;
    let downloadCount = 0;
    const spies = createNetworkSpies({
      requestJson: async (o) => {
        if (String(o.path) === '/agent/restore/tasks/claim') {
          claimCount += 1;
          assert.fail('corrupt STATE discovery must fail before claim');
        }
        throw new LinkeError(ERROR_CODES.DEVICE_ROUTE_NOT_FOUND, { statusCode: 404 });
      },
      download: async () => {
        downloadCount += 1;
        assert.fail('corrupt STATE discovery must not download');
      },
    });

    await assert.rejects(
      runEndpointRestore({
        agentUrl: 'https://127.0.0.1:1',
        tlsFingerprint: TLS_FP_A,
        token: TOKEN,
        deviceId: DEVICE,
        protocolVersion: 2,
        restoreRoot,
        endpointDataDir,
        retryBudget: DEFAULT_RETRY,
        stateStore,
        publish: {
          publishFromStagingVerified,
          rollbackPublished,
          recoverFromCrash,
          recoverCancelledLocal,
        },
        requestJson: spies.requestJson,
        download: spies.download,
        now: () => new Date(T0),
      }),
      (e) => e instanceof LinkeError && e.code === ERROR_CODES.RESTORE_STATE_INVALID,
    );
    assert.equal(claimCount, 0);
    assert.equal(downloadCount, 0);
    assertNoDangerousRemoteSideEffects(spies, null);
    assert.equal(
      await readFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'utf8'),
      'PRE-EXISTING-KEEP',
    );
  });

  it('C7 two same-device nonterminal STATE → unique restore-task-conflict; claim/download/receipt/cleanup=0', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'c.txt', content: 'conflict-pair' }]);
    const endpointDataDir = await makeTemp('linke-c7-disc-conflict-');
    const restoreRoot = await makeTemp('linke-c7-disc-conflict-root-');
    await ensureRestoreParent(restoreRoot);
    await writeFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'PRE-EXISTING-KEEP');

    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });
    await seedLocalReceivingState({ stateStore, files, taskId: TASK_ID });
    await seedLocalReceivingState({ stateStore, files, taskId: TASK_ID_B });

    let claimCount = 0;
    let downloadCount = 0;
    const spies = createNetworkSpies({
      requestJson: async (o) => {
        if (String(o.path) === '/agent/restore/tasks/claim') {
          claimCount += 1;
          assert.fail('same-device dual nonterminal must conflict before claim');
        }
        throw new LinkeError(ERROR_CODES.DEVICE_ROUTE_NOT_FOUND, { statusCode: 404 });
      },
      download: async () => {
        downloadCount += 1;
        assert.fail('same-device dual nonterminal must not download');
      },
    });

    await assert.rejects(
      runEndpointRestore({
        agentUrl: 'https://127.0.0.1:1',
        tlsFingerprint: TLS_FP_A,
        token: TOKEN,
        deviceId: DEVICE,
        protocolVersion: 2,
        restoreRoot,
        endpointDataDir,
        retryBudget: DEFAULT_RETRY,
        stateStore,
        publish: {
          publishFromStagingVerified,
          rollbackPublished,
          recoverFromCrash,
          recoverCancelledLocal,
        },
        requestJson: spies.requestJson,
        download: spies.download,
        now: () => new Date(T0),
      }),
      (e) => e instanceof LinkeError
        && e.code === ERROR_CODES.RESTORE_TASK_CONFLICT
        && e.code !== ERROR_CODES.RESTORE_STATE_INVALID,
    );
    assert.equal(claimCount, 0);
    assert.equal(downloadCount, 0);
    assertNoDangerousRemoteSideEffects(spies, null);
    assert.equal(
      await readFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'utf8'),
      'PRE-EXISTING-KEEP',
    );
  });

  it('C7 other-device nonterminal STATE is ignored; this device still claims new task path', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const files = buildFilesTable([{ path: 'fresh.txt', content: 'FRESH-CLAIM-AFTER-IGNORE' }]);
    const endpointDataDir = await makeTemp('linke-c7-disc-otherdev-');
    const restoreRoot = await makeTemp('linke-c7-disc-otherdev-root-');
    await ensureRestoreParent(restoreRoot);

    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });
    // Other device nonterminal — must not be treated as conflict or resume object.
    await seedLocalReceivingState({
      stateStore,
      files,
      taskId: TASK_ID_OTHER,
      deviceId: DEVICE_OTHER,
    });

    const controller = createControllerMock(files);
    let claimCount = 0;
    const spies = createNetworkSpies({
      requestJson: async (o) => {
        if (String(o.path) === '/agent/restore/tasks/claim') {
          claimCount += 1;
        }
        // Never GET the other device's task id on resume — must be fresh claim path.
        if (
          String(o.method || 'POST').toUpperCase() === 'GET'
          && String(o.path) === `/agent/restore/tasks/${TASK_ID_OTHER}`
        ) {
          assert.fail('must not resume other-device task');
        }
        return controller.requestJson(o);
      },
      download: (o) => controller.download(o),
    });

    const result = await runEndpointRestore({
      agentUrl: 'https://127.0.0.1:1',
      tlsFingerprint: TLS_FP_A,
      token: TOKEN,
      deviceId: DEVICE,
      protocolVersion: 2,
      restoreRoot,
      endpointDataDir,
      retryBudget: DEFAULT_RETRY,
      stateStore,
      publish: {
        publishFromStagingVerified,
        rollbackPublished,
        recoverFromCrash,
        recoverCancelledLocal,
      },
      requestJson: spies.requestJson,
      download: spies.download,
      now: () => new Date(T0),
    });

    assert.equal(result.outcome, 'completed');
    assert.equal(claimCount, 1, 'no local STATE for this device → must claim');
    assert.ok(
      spies.jsonCalls.some(
        (c) => c.method === 'GET' && String(c.path) === `/agent/restore/tasks/${TASK_ID}`,
      ),
      'fresh path GETs claimed task id',
    );
    assert.ok(
      !spies.jsonCalls.some(
        (c) => String(c.path) === `/agent/restore/tasks/${TASK_ID_OTHER}`,
      ),
      'must never touch other-device task id',
    );
    const published = await readFile(join(restoreRoot, REL_TARGET, 'fresh.txt'), 'utf8');
    assert.equal(published, 'FRESH-CLAIM-AFTER-IGNORE');
    // Other device STATE remains nonterminal / untouched.
    const other = await stateStore.readState(TASK_ID_OTHER);
    assert.equal(other.deviceId, DEVICE_OTHER);
    assert.equal(other.phase, 'receiving');
  });
});

describe('C7 post-anchor capacity gate exclusion oracle', () => {
  it('C7 completed-awaiting-ack with real-free-insufficient totalBytes must not capacity-gate; receipt/cleanup replay completes', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const endpointDataDir = await makeTemp('linke-c7-cap-postanchor-');
    const restoreRoot = await makeTemp('linke-c7-cap-postanchor-root-');
    await ensureRestoreParent(restoreRoot);
    const parentPathAbs = join(restoreRoot, 'apps');
    await mkdir(parentPathAbs, { recursive: true });

    // Real freeBytes from the same volume the engine's preflight parent uses.
    const fsStats = await statfs(parentPathAbs);
    const bsize = Number(fsStats.bsize);
    const bavail = Number(fsStats.bavail);
    assert.ok(Number.isSafeInteger(bsize) && bsize > 0);
    assert.ok(Number.isSafeInteger(bavail) && bavail >= 0);
    const realFree = bavail * bsize;
    assert.ok(Number.isSafeInteger(realFree) && realFree >= 0);

    // Capacity formula (production assertCapacity):
    //   remaining = totalBytes - receivedBytes  (here 0 when progress is full)
    //   required  = remaining + max(64MiB, ceil(totalBytes * 0.05))
    // Choose totalBytes so required > realFree even with remaining=0, so any wrong
    // post-anchor capacity gate that reads real freeBytes must fail-close.
    const MI_64 = 64 * 1024 * 1024;
    /** @type {number} */
    let totalBytes;
    if (Number.isSafeInteger(realFree * 20 + 20)) {
      totalBytes = realFree * 20 + 20;
    } else {
      // Extremely large free: force remaining = realFree + 1 with partial progress
      // is not needed here; still prefer safe full-progress path if possible.
      totalBytes = Number.MAX_SAFE_INTEGER;
    }
    // Grow until the real-free formula is provably insufficient (no freeBytes:0 cheat).
    for (let i = 0; i < 64; i += 1) {
      const fivePercent = Math.ceil(totalBytes * 0.05);
      const reserve = fivePercent > MI_64 ? fivePercent : MI_64;
      const required = reserve; // remaining = 0
      if (
        Number.isSafeInteger(totalBytes)
        && Number.isSafeInteger(fivePercent)
        && Number.isSafeInteger(required)
        && required > realFree
      ) {
        break;
      }
      const step = Math.max(CHUNK_SIZE, Math.floor(totalBytes * 0.05) || 1);
      const next = totalBytes + step;
      assert.ok(Number.isSafeInteger(next), 'totalBytes must remain safe integer');
      totalBytes = next;
    }

    const fivePercentFinal = Math.ceil(totalBytes * 0.05);
    const reserveFinal = fivePercentFinal > MI_64 ? fivePercentFinal : MI_64;
    const remainingStagingBytes = 0;
    const requiredFinal = remainingStagingBytes + reserveFinal;
    assert.ok(
      requiredFinal > realFree,
      `capacity oracle must be free-insufficient: required=${requiredFinal} realFree=${realFree} totalBytes=${totalBytes}`,
    );
    // Same numbers the engine would feed assertCapacity if it wrongly gated this phase.
    assert.throws(
      () => assertCapacity({
        remainingStagingBytes,
        totalBytes,
        freeBytes: realFree,
      }),
      (e) => e instanceof LinkeError
        && e.code === ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT,
    );

    const fileSize = totalBytes;
    const chunkCount = fileSize === 0 ? 0 : Math.ceil(fileSize / CHUNK_SIZE);
    assert.ok(Number.isSafeInteger(chunkCount));
    const fileSha = DIGEST; // metadata-only; completed-awaiting-ack never materializes body
    const hugeFilesMeta = [
      {
        fileIndex: 0,
        path: 'huge-meta-only.bin',
        size: fileSize,
        sha256: fileSha,
        chunkCount,
      },
    ];

    const RECEIPT_ID_CAP = 'cccccccc-dddd-4eee-8fff-eeeeeeee0404';
    const structureFp = 'a'.repeat(64);
    const contentFp = 'b'.repeat(64);
    const receipt = {
      schemaVersion: 1,
      taskId: TASK_ID,
      deviceId: DEVICE,
      snapshotId: SNAPSHOT_ID,
      manifestDigest: DIGEST,
      outcome: 'completed',
      relativeTarget: REL_TARGET,
      totalBytes,
      fileCount: 1,
      contentSha256: contentFp,
      structureFingerprint: structureFp,
      publishedVerifiedAt: T0,
      rolledBackAt: null,
      anchorPresentBeforePublish: false,
      receiptId: RECEIPT_ID_CAP,
    };

    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });
    await stateStore.openOrCreateState({
      taskId: TASK_ID,
      deviceId: DEVICE,
      snapshotId: SNAPSHOT_ID,
      manifestDigest: DIGEST,
      relativeTarget: REL_TARGET,
      fileCount: 1,
      totalBytes,
      chunkSize: CHUNK_SIZE,
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
    });
    await stateStore.transitionPhase(TASK_ID, 'planned', 'receiving');
    // Full durable progress without materializing the huge body.
    await stateStore.recordDurableProgress(TASK_ID, {
      fileIndex: 0,
      chunkIndex: Math.max(0, chunkCount - 1),
      receivedBytes: totalBytes,
    });
    for (const [from, to] of [
      ['receiving', 'staging-verified'],
      ['staging-verified', 'anchor-intent'],
      ['anchor-intent', 'anchored'],
      ['anchored', 'publish-intent'],
      ['publish-intent', 'published'],
      ['published', 'completed-awaiting-ack'],
    ]) {
      await stateStore.transitionPhase(TASK_ID, from, to);
    }
    await stateStore.writeReceipt(TASK_ID, receipt);

    const durable = await stateStore.readState(TASK_ID);
    assert.equal(durable.phase, 'completed-awaiting-ack');
    assert.equal(durable.receivedBytes, totalBytes);
    assert.equal(durable.totalBytes, totalBytes);
    assert.notEqual(durable.phase, 'planned');
    assert.notEqual(durable.phase, 'receiving');

    let claimCount = 0;
    let downloadCount = 0;
    let receiptPosts = 0;
    let cleanupPosts = 0;
    /** @type {object | null} */
    let lastReceiptBody = null;
    /** @type {object | null} */
    let lastCleanupBody = null;

    async function requestJson(opts) {
      const method = String(opts.method || 'POST').toUpperCase();
      const path = String(opts.path || '');
      assertRequestJsonShape(opts, method === 'GET' ? 'GET' : 'POST');

      if (method === 'POST' && path === '/agent/restore/tasks/claim') {
        claimCount += 1;
        assert.fail('completed-awaiting-ack resume must never claim');
      }
      if (method === 'GET' && path === `/agent/restore/tasks/${TASK_ID}`) {
        return {
          taskId: TASK_ID,
          snapshotId: SNAPSHOT_ID,
          manifestDigest: DIGEST,
          relativeTarget: REL_TARGET,
          status: 'active',
          cancelRequested: false,
          cleanupAuthorized: false,
          fileCount: 1,
          totalBytes,
          chunkSize: CHUNK_SIZE,
          files: hugeFilesMeta,
        };
      }
      if (method === 'POST' && path === `/agent/restore/tasks/${TASK_ID}/receipts`) {
        receiptPosts += 1;
        lastReceiptBody = opts.body;
        assert.equal(lastReceiptBody?.receiptId, RECEIPT_ID_CAP);
        assert.equal(lastReceiptBody?.outcome, 'completed');
        assert.equal(lastReceiptBody?.totalBytes, totalBytes);
        return {
          ok: true,
          cleanupAuthorized: true,
          status: 'completed',
        };
      }
      if (method === 'POST' && path === `/agent/restore/tasks/${TASK_ID}/cleanup`) {
        cleanupPosts += 1;
        lastCleanupBody = opts.body;
        assert.equal(lastCleanupBody?.receiptId, RECEIPT_ID_CAP);
        assert.equal(lastCleanupBody?.outcome, 'completed');
        return { ok: true, status: 'cleaned' };
      }
      throw new LinkeError(ERROR_CODES.DEVICE_ROUTE_NOT_FOUND, { statusCode: 404 });
    }

    async function download() {
      downloadCount += 1;
      assert.fail('completed-awaiting-ack resume must never download');
    }

    const result = await runEndpointRestore({
      agentUrl: 'https://127.0.0.1:1',
      tlsFingerprint: TLS_FP_A,
      token: TOKEN,
      deviceId: DEVICE,
      protocolVersion: 2,
      restoreRoot,
      endpointDataDir,
      retryBudget: DEFAULT_RETRY,
      stateStore,
      publish: {
        publishFromStagingVerified,
        rollbackPublished,
        recoverFromCrash,
        recoverCancelledLocal,
      },
      requestJson,
      download,
      now: () => new Date(T0),
    });

    // GREEN only if capacity gate is phase-scoped away from post-anchor.
    // Regression "gate every phase with real freeBytes" → RESTORE_CAPACITY_INSUFFICIENT (RED).
    assert.equal(result.outcome, 'completed');
    assert.equal(claimCount, 0);
    assert.equal(downloadCount, 0);
    assert.equal(receiptPosts, 1, 'must replay exact durable receipt once');
    assert.equal(cleanupPosts, 1, 'must post cleanup after receipt ACK');
    assert.equal(lastReceiptBody?.receiptId, RECEIPT_ID_CAP);
    assert.equal(lastCleanupBody?.receiptId, RECEIPT_ID_CAP);

    // Numerical relationship evidence (no paths): realFree < required under remaining=0.
    assert.ok(
      realFree < requiredFinal,
      `realFree=${realFree} must be < required=${requiredFinal} (totalBytes=${totalBytes}, remaining=0, reserve=${reserveFinal})`,
    );
  });
});

describe('C7 discovery root entry bound fail-close oracle', () => {
  it('C7 restore-tasks readdir entries > 10000 → unique restore-state-invalid (real dirs)', async () => {
    const runEndpointRestore = await loadRunEndpointRestore();
    const endpointDataDir = await makeTemp('linke-c7-disc-bound-');
    const restoreRoot = await makeTemp('linke-c7-disc-bound-root-');
    await ensureRestoreParent(restoreRoot);
    await writeFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'PRE-EXISTING-KEEP');

    const tasksDir = join(endpointDataDir, 'restore-tasks');
    await mkdir(tasksDir, { recursive: true, mode: 0o700 });

    // Real FS: DISCOVERY_DIR_ENTRY_BOUND + 1 non-UUID pad dirs (counted by readdir).
    const overflow = DISCOVERY_DIR_ENTRY_BOUND + 1;
    const batchSize = 256;
    for (let start = 0; start < overflow; start += batchSize) {
      const n = Math.min(batchSize, overflow - start);
      await Promise.all(
        Array.from({ length: n }, (_, i) => {
          const idx = start + i;
          // zero-pad for stable names; non-UUID so discovery skips content checks.
          return mkdir(join(tasksDir, `pad-${String(idx).padStart(5, '0')}`));
        }),
      );
    }

    const stateStore = createEndpointRestoreStateStore({
      endpointDataDir,
      now: () => new Date(T0),
    });
    let claimCount = 0;
    let downloadCount = 0;
    const spies = createNetworkSpies({
      requestJson: async (o) => {
        if (String(o.path) === '/agent/restore/tasks/claim') {
          claimCount += 1;
          assert.fail('discovery bound must fail-close before claim');
        }
        throw new LinkeError(ERROR_CODES.DEVICE_ROUTE_NOT_FOUND, { statusCode: 404 });
      },
      download: async () => {
        downloadCount += 1;
        assert.fail('discovery bound must not download');
      },
    });

    await assert.rejects(
      runEndpointRestore({
        agentUrl: 'https://127.0.0.1:1',
        tlsFingerprint: TLS_FP_A,
        token: TOKEN,
        deviceId: DEVICE,
        protocolVersion: 2,
        restoreRoot,
        endpointDataDir,
        retryBudget: DEFAULT_RETRY,
        stateStore,
        publish: {
          publishFromStagingVerified,
          rollbackPublished,
          recoverFromCrash,
          recoverCancelledLocal,
        },
        requestJson: spies.requestJson,
        download: spies.download,
        now: () => new Date(T0),
      }),
      (e) => e instanceof LinkeError && e.code === ERROR_CODES.RESTORE_STATE_INVALID,
    );
    assert.equal(claimCount, 0);
    assert.equal(downloadCount, 0);
    assertNoDangerousRemoteSideEffects(spies, null);
    assert.equal(
      await readFile(join(restoreRoot, 'apps', 'keep-pre.txt'), 'utf8'),
      'PRE-EXISTING-KEEP',
    );
  });
});
