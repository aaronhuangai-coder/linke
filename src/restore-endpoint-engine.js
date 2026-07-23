/**
 * G0c C7 — Endpoint restore engine (endpoint-pull).
 * Authority: design §§9.4, 10, 12.5, 13, 16.6–16.7; plan C7 GREEN.
 *
 * Fixed independent module: export runEndpointRestore only.
 * Must NOT be re-exported from device-client.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  rename as fsRename,
  rm as fsRm,
  lstat as fsLstat,
  readdir,
  statfs,
} from 'node:fs/promises';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { RESTORE_CHUNK_SIZE } from './restore-schemas.js';
import {
  assertStrictRelativeTarget,
  assertSnapshotRootRelativeFilePath,
} from './restore-path.js';
import {
  preflightTarget,
  materializeChunkToStaging,
  verifyStagingTree,
  assertCapacity,
} from './restore-staging.js';
import {
  computeStructureFingerprint,
  computeContentSha256,
} from './restore-fingerprint.js';
import {
  ensureSafeDataRoot,
  ensureSafeRelativeDir,
} from './safe-data-files.js';

const JSON_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_BUDGET = 8;
/** Bounded scan of private restore-tasks entries (fail state-invalid if exceeded). */
const MAX_RESTORE_TASK_DIR_ENTRIES = 10_000;
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const CHUNK_PATH_RE =
  /^\/agent\/restore\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/files\/\d+\/chunks\/\d+$/;

/** @returns {never} */
function failTaskInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID, {
    statusCode: 400,
    retryable: false,
  });
}

/** @returns {never} */
function failStateInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID, {
    statusCode: 500,
    retryable: false,
  });
}

/** @returns {never} */
function failPathInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_PATH_INVALID, {
    statusCode: 400,
    retryable: false,
  });
}

/** @returns {never} */
function failCapacity() {
  throw new LinkeError(ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT, {
    statusCode: 507,
    retryable: false,
  });
}

/** @returns {never} */
function failResumeExhausted() {
  throw new LinkeError(ERROR_CODES.RESTORE_RESUME_EXHAUSTED, {
    statusCode: null,
    retryable: false,
  });
}

/** @returns {never} */
function failIntegrity() {
  throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED, {
    statusCode: 422,
    retryable: false,
  });
}

/** @returns {never} */
function failTaskConflict() {
  throw new LinkeError(ERROR_CODES.RESTORE_TASK_CONFLICT, {
    statusCode: 409,
    retryable: false,
  });
}

/**
 * @param {unknown} error
 * @returns {never}
 */
function rethrowSanitized(error) {
  if (error instanceof LinkeError) throw error;
  throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, {
    statusCode: 400,
    retryable: false,
  });
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNetworkRetryable(error) {
  if (!(error instanceof LinkeError)) return false;
  if (error.code === ERROR_CODES.RESTORE_INTERRUPTED && error.retryable !== false) {
    return true;
  }
  if (error.code === ERROR_CODES.DEVICE_RATE_LIMITED) return true;
  if (error.code === ERROR_CODES.RESTORE_BACKPRESSURE) return true;
  return false;
}

/**
 * @param {unknown} signal
 */
function throwIfAborted(signal) {
  if (
    signal
    && typeof signal === 'object'
    && /** @type {{ aborted?: unknown }} */ (signal).aborted === true
  ) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, {
      statusCode: 400,
      retryable: false,
    });
  }
}

/**
 * Task-bound adapter so C4 publish may call readState(undefined) safely.
 * @param {object} store
 * @param {string} taskId
 */
function bindStateStore(store, taskId) {
  /**
   * @param {unknown} id
   * @returns {string}
   */
  const resolveId = (id) => {
    if (typeof id === 'string' && id.length > 0) return id;
    return taskId;
  };
  return {
    openOrCreateState: (init) => store.openOrCreateState(init),
    readState: (id) => store.readState(resolveId(id)),
    writeState: (id, patch, opts) => store.writeState(resolveId(id), patch, opts),
    transitionPhase: (id, from, to) => store.transitionPhase(resolveId(id), from, to),
    recordDurableProgress: (id, p) => store.recordDurableProgress(resolveId(id), p),
    recoverReceiving: (id, root, files) => store.recoverReceiving(resolveId(id), root, files),
    writeReceipt: (id, r) => store.writeReceipt(resolveId(id), r),
    writeCleanupReceipt: (id, r) => store.writeCleanupReceipt(resolveId(id), r),
    readTombstone: (id) => store.readTombstone(resolveId(id)),
  };
}

/**
 * P2 assertDownloadShape — fixed production fields + chunk path only.
 * @param {object} opts
 * @param {string} agentUrl
 * @param {string} tlsFingerprint
 * @param {string} token
 * @param {string} deviceId
 * @param {number} protocolVersion
 * @param {AbortSignal | undefined} signal
 */
function assertDownloadShape(
  opts,
  agentUrl,
  tlsFingerprint,
  token,
  deviceId,
  protocolVersion,
  signal,
) {
  if (!isPlainObject(opts)) failTaskInvalid();
  if (opts.agentUrl !== agentUrl) failTaskInvalid();
  if (opts.tlsFingerprint !== tlsFingerprint) failTaskInvalid();
  if (opts.token !== token) failTaskInvalid();
  if (opts.deviceId !== deviceId) failTaskInvalid();
  if (opts.protocolVersion !== protocolVersion) failTaskInvalid();
  if (opts.timeoutMs !== DOWNLOAD_TIMEOUT_MS) failTaskInvalid();
  if (opts.idleTimeoutMs !== DOWNLOAD_IDLE_TIMEOUT_MS) failTaskInvalid();
  if (signal !== undefined && opts.signal !== signal) failTaskInvalid();
  if (typeof opts.onChunk !== 'function') failTaskInvalid();
  if (typeof opts.path !== 'string' || !CHUNK_PATH_RE.test(opts.path)) failTaskInvalid();
}

/**
 * @param {string} dirAbs
 * @returns {Promise<number>}
 */
async function readFreeBytes(dirAbs) {
  let stats;
  try {
    stats = await statfs(dirAbs);
  } catch {
    failCapacity();
  }
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) failCapacity();
  const bsize = /** @type {{ bsize?: unknown }} */ (stats).bsize;
  const bavail = /** @type {{ bavail?: unknown }} */ (stats).bavail;
  if (!Number.isSafeInteger(bsize) || /** @type {number} */ (bsize) <= 0) failCapacity();
  if (!Number.isSafeInteger(bavail) || /** @type {number} */ (bavail) < 0) failCapacity();
  const bs = /** @type {number} */ (bsize);
  const ba = /** @type {number} */ (bavail);
  if (ba > 0 && bs > Math.floor(Number.MAX_SAFE_INTEGER / ba)) failCapacity();
  const free = ba * bs;
  if (!Number.isSafeInteger(free) || free < 0) failCapacity();
  return free;
}

/**
 * Safe local discovery of this device's nonterminal STATE under
 * endpointDataDir/restore-tasks (design §10.4 resume path).
 * Does not change C3 stateStore frozen surface.
 *
 * @param {object} stateStore
 * @param {string} endpointDataDir
 * @param {string} deviceId
 * @returns {Promise<object | null>}
 */
async function discoverLocalNonterminalState(stateStore, endpointDataDir, deviceId) {
  if (typeof endpointDataDir !== 'string' || endpointDataDir.length === 0) {
    failStateInvalid();
  }
  if (typeof deviceId !== 'string' || deviceId.length === 0) failTaskInvalid();

  let rootAbs;
  try {
    rootAbs = await ensureSafeDataRoot(endpointDataDir);
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failStateInvalid();
  }

  let tasksDirAbs;
  try {
    tasksDirAbs = await ensureSafeRelativeDir(rootAbs, 'restore-tasks');
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failStateInvalid();
  }

  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(tasksDirAbs, { withFileTypes: true });
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failStateInvalid();
  }

  if (!Array.isArray(entries)) failStateInvalid();
  if (entries.length > MAX_RESTORE_TASK_DIR_ENTRIES) failStateInvalid();

  // Deterministic scan order.
  const sorted = entries.slice().sort((a, b) => {
    const an = typeof a?.name === 'string' ? a.name : '';
    const bn = typeof b?.name === 'string' ? b.name : '';
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });

  /** @type {object[]} */
  const found = [];
  for (const ent of sorted) {
    if (!ent || typeof ent.name !== 'string') failStateInvalid();
    const name = ent.name;
    // Only UUID task dirs are in-scope; skip unrelated names.
    if (!UUID_RE.test(name)) continue;

    // UUID symlink / non-directory → structure damage.
    if (typeof ent.isSymbolicLink === 'function' && ent.isSymbolicLink()) {
      failStateInvalid();
    }
    if (typeof ent.isDirectory !== 'function' || !ent.isDirectory()) {
      failStateInvalid();
    }

    let state;
    try {
      state = await stateStore.readState(name);
    } catch (error) {
      // Bad / missing STATE under UUID dir → restore-state-invalid.
      if (error instanceof LinkeError) throw error;
      failStateInvalid();
    }
    if (!isPlainObject(state)) failStateInvalid();
    if (state.deviceId !== deviceId) continue;
    // Local terminal: cleaned (tombstone may still exist briefly).
    if (state.phase === 'cleaned') continue;
    found.push(state);
  }

  if (found.length === 0) return null;
  if (found.length > 1) failTaskConflict();
  return found[0];
}

/**
 * Durable STATE must equal GET task identity fields (fail-close on drift).
 * @param {object} state
 * @param {object} task
 * @param {string} deviceId
 */
function assertStateMatchesTask(state, task, deviceId) {
  if (!isPlainObject(state) || !isPlainObject(task)) failStateInvalid();
  if (state.taskId !== task.taskId) failStateInvalid();
  if (state.deviceId !== deviceId) failStateInvalid();
  if (state.snapshotId !== task.snapshotId) failStateInvalid();
  if (state.manifestDigest !== task.manifestDigest) failStateInvalid();
  if (state.relativeTarget !== task.relativeTarget) failStateInvalid();
  if (state.fileCount !== task.fileCount) failStateInvalid();
  if (state.totalBytes !== task.totalBytes) failStateInvalid();
  if (state.chunkSize !== task.chunkSize) failStateInvalid();
}

/**
 * @param {unknown} task
 * @returns {{
 *   taskId: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 *   relativeTarget: string,
 *   fileCount: number,
 *   totalBytes: number,
 *   chunkSize: number,
 *   files: Array<{
 *     fileIndex: number,
 *     path: string,
 *     size: number,
 *     sha256: string,
 *     chunkCount: number,
 *   }>,
 *   cancelRequested: boolean,
 * }}
 */
function projectTaskFromGet(task) {
  if (!isPlainObject(task)) failTaskInvalid();
  const taskId = task.taskId;
  const snapshotId = task.snapshotId;
  const manifestDigest = task.manifestDigest;
  if (typeof taskId !== 'string' || !UUID_RE.test(taskId)) failTaskInvalid();
  if (typeof snapshotId !== 'string' || !UUID_RE.test(snapshotId)) failTaskInvalid();
  if (typeof manifestDigest !== 'string' || !SHA256_HEX_RE.test(manifestDigest)) {
    failTaskInvalid();
  }
  let rel;
  try {
    rel = assertStrictRelativeTarget(task.relativeTarget);
  } catch {
    failPathInvalid();
  }
  const fileCount = task.fileCount;
  const totalBytes = task.totalBytes;
  const chunkSize = task.chunkSize;
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) failTaskInvalid();
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) failTaskInvalid();
  if (chunkSize !== RESTORE_CHUNK_SIZE) failTaskInvalid();
  if (!Array.isArray(task.files) || task.files.length !== fileCount) failTaskInvalid();

  /** @type {Array<{ fileIndex: number, path: string, size: number, sha256: string, chunkCount: number }>} */
  const files = [];
  let sum = 0;
  for (let i = 0; i < task.files.length; i += 1) {
    const f = task.files[i];
    if (!isPlainObject(f) || f.fileIndex !== i) failTaskInvalid();
    let fpath;
    try {
      fpath = assertSnapshotRootRelativeFilePath(f.path);
    } catch (error) {
      if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_PATH_INVALID) {
        failPathInvalid();
      }
      failTaskInvalid();
    }
    const size = f.size;
    const sha256 = f.sha256;
    const chunkCount = f.chunkCount;
    if (!Number.isSafeInteger(size) || size < 0) failTaskInvalid();
    if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256)) failTaskInvalid();
    const expectedChunks = size === 0 ? 0 : Math.ceil(size / RESTORE_CHUNK_SIZE);
    if (!Number.isSafeInteger(chunkCount) || chunkCount !== expectedChunks) failTaskInvalid();
    if (size === 0 && sha256 !== ZERO_SHA) failTaskInvalid();
    sum += size;
    if (!Number.isSafeInteger(sum)) failTaskInvalid();
    files.push({ fileIndex: i, path: fpath, size, sha256, chunkCount });
  }
  if (sum !== totalBytes) failTaskInvalid();

  return {
    taskId,
    snapshotId,
    manifestDigest,
    relativeTarget: rel,
    fileCount,
    totalBytes,
    chunkSize: RESTORE_CHUNK_SIZE,
    files,
    cancelRequested: task.cancelRequested === true,
  };
}

/**
 * Endpoint restore orchestrator.
 *
 * @param {object} input
 * @returns {Promise<{ outcome: 'completed' | 'rolled-back' | 'cancelled' }>}
 */
export async function runEndpointRestore(input) {
  if (!isPlainObject(input)) failTaskInvalid();

  const agentUrl = input.agentUrl;
  const tlsFingerprint = input.tlsFingerprint;
  const token = input.token;
  const deviceId = input.deviceId;
  const protocolVersion = input.protocolVersion;
  const restoreRoot = input.restoreRoot;
  const endpointDataDir = input.endpointDataDir;
  const retryBudget = input.retryBudget === undefined
    ? DEFAULT_RETRY_BUDGET
    : input.retryBudget;
  const stateStore = input.stateStore;
  const publish = input.publish;
  const requestJson = input.requestJson;
  const download = input.download;
  const nowFn = typeof input.now === 'function' ? input.now : () => new Date();
  const signal = input.signal;

  if (typeof agentUrl !== 'string' || !agentUrl.startsWith('https://')) failTaskInvalid();
  if (typeof tlsFingerprint !== 'string' || !SHA256_HEX_RE.test(tlsFingerprint)) {
    failTaskInvalid();
  }
  if (typeof token !== 'string' || token.length === 0) failTaskInvalid();
  if (typeof deviceId !== 'string' || deviceId.length === 0) failTaskInvalid();
  if (!Number.isInteger(protocolVersion)) failTaskInvalid();
  if (typeof restoreRoot !== 'string' || restoreRoot.length === 0) failPathInvalid();
  if (typeof endpointDataDir !== 'string' || endpointDataDir.length === 0) failStateInvalid();
  if (!Number.isInteger(retryBudget) || retryBudget < 1) failTaskInvalid();
  if (!isPlainObject(stateStore)) failStateInvalid();
  if (!isPlainObject(publish)) failStateInvalid();
  if (typeof requestJson !== 'function' || typeof download !== 'function') failTaskInvalid();
  if (typeof publish.publishFromStagingVerified !== 'function') failStateInvalid();
  if (typeof publish.recoverFromCrash !== 'function') failStateInvalid();
  if (typeof publish.recoverCancelledLocal !== 'function') failStateInvalid();

  let networkFailures = 0;

  /**
   * @returns {string}
   */
  function isoNow() {
    let d;
    try {
      d = nowFn();
    } catch {
      failStateInvalid();
    }
    if (!(d instanceof Date) || !Number.isFinite(d.getTime())) failStateInvalid();
    try {
      return d.toISOString();
    } catch {
      failStateInvalid();
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withNetworkRetry(fn) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      throwIfAborted(signal);
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof LinkeError)) rethrowSanitized(error);
        if (!isNetworkRetryable(error)) throw error;
        networkFailures += 1;
        if (networkFailures >= retryBudget) failResumeExhausted();
      }
    }
  }

  /**
   * @param {'GET' | 'POST'} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function callJson(method, path, body) {
    throwIfAborted(signal);
    return withNetworkRetry(async () => requestJson({
      agentUrl,
      path,
      tlsFingerprint,
      method,
      token,
      deviceId,
      protocolVersion,
      timeoutMs: JSON_TIMEOUT_MS,
      bodyMode: method === 'GET' ? 'none' : 'json',
      body: method === 'GET' ? null : (body ?? {}),
      signal,
    }));
  }

  /**
   * Stream one chunk. `expectedSha256` optional (omit multi-chunk without per-chunk digest).
   * Parts are re-created on every network attempt (P1-1 isolation).
   *
   * @param {string} chunkPath
   * @param {number} expectedLength
   * @param {string | undefined} [expectedSha256]
   * @returns {Promise<{ bytes: Buffer, sha256: string }>}
   */
  async function callDownload(chunkPath, expectedLength, expectedSha256) {
    throwIfAborted(signal);
    return withNetworkRetry(async () => {
      // Fresh parts buffer per attempt — never concatenate across RESTORE_INTERRUPTED.
      /** @type {Buffer[]} */
      const parts = [];
      /** @type {Record<string, unknown>} */
      const opts = {
        agentUrl,
        path: chunkPath,
        tlsFingerprint,
        token,
        deviceId,
        protocolVersion,
        expectedLength,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
        signal,
        onChunk: async (buf) => {
          parts.push(Buffer.from(buf));
        },
      };
      if (expectedSha256 !== undefined) {
        opts.expectedSha256 = expectedSha256;
      }
      assertDownloadShape(
        opts,
        agentUrl,
        tlsFingerprint,
        token,
        deviceId,
        protocolVersion,
        signal,
      );
      const result = await download(opts);
      const bytes = Buffer.concat(parts);
      if (
        !isPlainObject(result)
        || result.bytesReceived !== expectedLength
        || typeof result.sha256 !== 'string'
        || !SHA256_HEX_RE.test(result.sha256)
        || bytes.length !== expectedLength
      ) {
        failIntegrity();
      }
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== result.sha256) failIntegrity();
      if (expectedSha256 !== undefined && actual !== expectedSha256) failIntegrity();
      return { bytes, sha256: actual };
    });
  }

  // ---- Plan: resume local nonterminal STATE OR claim new task (design §10.4) ----
  const localState = await discoverLocalNonterminalState(
    stateStore,
    endpointDataDir,
    deviceId,
  );

  /** @type {string} */
  let taskId;
  /** @type {ReturnType<typeof projectTaskFromGet>} */
  let task;
  let cancelRequested = false;
  /** Durable publish identity — never overwrite from live FS on resume. */
  let originalTargetExisted = false;
  /** @type {string | null} */
  let oldStructureFingerprint = null;
  /** @type {string | null} */
  let oldContentSha256 = null;
  /** @type {object} */
  let state;
  /** @type {Awaited<ReturnType<typeof preflightTarget>>} */
  let paths;

  if (localState !== null) {
    // Resume path: zero claim; GET active task; keep durable fingerprints.
    if (typeof localState.taskId !== 'string' || !UUID_RE.test(localState.taskId)) {
      failStateInvalid();
    }
    taskId = localState.taskId;
    const taskRaw = await callJson('GET', `/agent/restore/tasks/${taskId}`);
    task = projectTaskFromGet(taskRaw);
    taskId = task.taskId;
    cancelRequested = task.cancelRequested;
    assertStateMatchesTask(localState, task, deviceId);

    paths = await preflightTarget({
      restoreRoot,
      relativeTarget: task.relativeTarget,
      taskId,
    });

    // Preflight still computes path/ancestor/dev safety, but originalTargetExisted
    // and old fingerprints MUST come from durable STATE (post-anchor FS may differ).
    originalTargetExisted = localState.originalTargetExisted === true;
    oldStructureFingerprint =
      typeof localState.oldStructureFingerprint === 'string'
        ? localState.oldStructureFingerprint
        : null;
    oldContentSha256 =
      typeof localState.oldContentSha256 === 'string'
        ? localState.oldContentSha256
        : null;
    if (originalTargetExisted) {
      if (
        typeof oldStructureFingerprint !== 'string'
        || !SHA256_HEX_RE.test(oldStructureFingerprint)
        || typeof oldContentSha256 !== 'string'
        || !SHA256_HEX_RE.test(oldContentSha256)
      ) {
        failStateInvalid();
      }
    } else if (oldStructureFingerprint !== null || oldContentSha256 !== null) {
      failStateInvalid();
    }

    // No openOrCreate — STATE already durable.
    state = localState;
  } else {
    // Fresh path: claim → GET → preflight → fingerprint current FS → openOrCreate.
    const claimResp = await callJson('POST', '/agent/restore/tasks/claim', {});
    if (!isPlainObject(claimResp)) failTaskInvalid();
    /** @type {string | null} */
    let claimedId = null;
    if (isPlainObject(claimResp.task) && typeof claimResp.task.taskId === 'string') {
      if (UUID_RE.test(claimResp.task.taskId)) claimedId = claimResp.task.taskId;
    }
    if (claimedId === null) failTaskInvalid();
    taskId = claimedId;

    const taskRaw = await callJson('GET', `/agent/restore/tasks/${taskId}`);
    task = projectTaskFromGet(taskRaw);
    taskId = task.taskId;
    cancelRequested = task.cancelRequested;

    paths = await preflightTarget({
      restoreRoot,
      relativeTarget: task.relativeTarget,
      taskId,
    });

    oldStructureFingerprint = null;
    oldContentSha256 = null;
    if (paths.originalTargetExisted) {
      try {
        oldStructureFingerprint = await computeStructureFingerprint(paths.targetPathAbs);
        oldContentSha256 = await computeContentSha256(paths.targetPathAbs);
      } catch (error) {
        if (error instanceof LinkeError) throw error;
        failIntegrity();
      }
    }
    originalTargetExisted = paths.originalTargetExisted === true;

    state = await stateStore.openOrCreateState({
      taskId,
      deviceId,
      snapshotId: task.snapshotId,
      manifestDigest: task.manifestDigest,
      relativeTarget: task.relativeTarget,
      fileCount: task.fileCount,
      totalBytes: task.totalBytes,
      chunkSize: task.chunkSize,
      originalTargetExisted,
      oldStructureFingerprint,
      oldContentSha256,
    });
  }

  const boundStore = bindStateStore(stateStore, taskId);

  /**
   * Capacity gate only when actually receiving / new download work is needed.
   * Post-anchor crash recovery must not be blocked by unrelated staging capacity.
   * @param {number} receivedBytes
   * @param {number} freeBytes
   */
  function gateCapacity(receivedBytes, freeBytes) {
    const remaining = task.totalBytes - receivedBytes;
    if (!Number.isSafeInteger(remaining) || remaining < 0) failTaskInvalid();
    assertCapacity({
      remainingStagingBytes: remaining,
      totalBytes: task.totalBytes,
      freeBytes,
    });
  }

  const phaseForCapacity = /** @type {string} */ (state.phase);
  if (phaseForCapacity === 'planned' || phaseForCapacity === 'receiving') {
    const freeBytes = await readFreeBytes(paths.parentPathAbs);
    gateCapacity(/** @type {number} */ (state.receivedBytes) || 0, freeBytes);
  }

  async function ensureStaging() {
    try {
      await mkdir(paths.stagingPathAbs, { recursive: true, mode: 0o700 });
    } catch {
      try {
        const st = await fsLstat(paths.stagingPathAbs);
        if (st.isSymbolicLink() || !st.isDirectory()) failPathInvalid();
      } catch (error) {
        if (error instanceof LinkeError) throw error;
        failPathInvalid();
      }
    }
  }

  /**
   * @param {object} cleanupReceipt
   */
  async function postCleanupUntilAck(cleanupReceipt) {
    await withNetworkRetry(async () => {
      const resp = await requestJson({
        agentUrl,
        path: `/agent/restore/tasks/${taskId}/cleanup`,
        tlsFingerprint,
        method: 'POST',
        token,
        deviceId,
        protocolVersion,
        timeoutMs: JSON_TIMEOUT_MS,
        bodyMode: 'json',
        body: cleanupReceipt,
        signal,
      });
      if (!isPlainObject(resp) || resp.ok !== true) {
        throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
          statusCode: null,
          retryable: true,
        });
      }
      return resp;
    });
  }

  /**
   * @param {object} receipt
   */
  async function postReceiptUntilAck(receipt) {
    const resp = await withNetworkRetry(async () => {
      const r = await requestJson({
        agentUrl,
        path: `/agent/restore/tasks/${taskId}/receipts`,
        tlsFingerprint,
        method: 'POST',
        token,
        deviceId,
        protocolVersion,
        timeoutMs: JSON_TIMEOUT_MS,
        bodyMode: 'json',
        body: receipt,
        signal,
      });
      if (!isPlainObject(r)) {
        throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
          statusCode: null,
          retryable: true,
        });
      }
      return r;
    });
    if (resp.cleanupAuthorized !== true) failStateInvalid();
    await stateStore.writeState(
      taskId,
      { cleanupAuthorized: true, updatedAt: isoNow() },
      { fsync: true },
    );
    return resp;
  }

  /**
   * @returns {Promise<{ outcome: 'cancelled' }>}
   */
  async function runCancelledLocalPath() {
    state = await stateStore.readState(taskId);
    const phase = state.phase;
    if (phase !== 'cancelled-local') {
      if (
        phase === 'planned'
        || phase === 'receiving'
        || phase === 'staging-verified'
      ) {
        await stateStore.transitionPhase(taskId, phase, 'cancelled-local');
      } else {
        failStateInvalid();
      }
    }

    const cleanupReceipt = await publish.recoverCancelledLocal({
      stateStore: boundStore,
      taskId,
      deviceId,
      stagingPathAbs: paths.stagingPathAbs,
      rm: fsRm,
    });

    await postCleanupUntilAck(cleanupReceipt);
    try {
      state = await stateStore.readState(taskId);
      if (state.phase === 'cleanup-completed-awaiting-ack') {
        await stateStore.transitionPhase(
          taskId,
          'cleanup-completed-awaiting-ack',
          'cleaned',
        );
      }
    } catch {
      // ok
    }
    return { outcome: 'cancelled' };
  }

  /**
   * @param {'completed' | 'rolled-back'} outcome
   * @param {string} receiptId
   */
  async function runBusinessCleanup(outcome, receiptId) {
    state = await stateStore.readState(taskId);
    if (
      state.phase === 'completed-awaiting-ack'
      || state.phase === 'rolled-back-awaiting-ack'
    ) {
      await stateStore.transitionPhase(taskId, state.phase, 'cleanup-intent');
    }

    state = await stateStore.readState(taskId);
    if (state.phase === 'cleanup-intent') {
      for (const p of [
        paths.stagingPathAbs,
        paths.anchorPathAbs,
        paths.quarantinePathAbs,
      ]) {
        try {
          await fsRm(p, { recursive: true, force: true });
        } catch {
          throw new LinkeError(ERROR_CODES.RESTORE_CLEANUP_FAILED, {
            statusCode: 500,
            retryable: false,
          });
        }
      }

      const cleanupId =
        typeof state.cleanupId === 'string' && state.cleanupId.length > 0
          ? state.cleanupId
          : randomUUID();
      await stateStore.writeState(
        taskId,
        { cleanupId, updatedAt: isoNow() },
        { fsync: true },
      );

      const cleanupReceipt = {
        schemaVersion: 1,
        cleanupId,
        taskId,
        deviceId,
        outcome,
        receiptId,
        cleanedAt: isoNow(),
      };
      await stateStore.writeCleanupReceipt(taskId, cleanupReceipt);
      await stateStore.transitionPhase(
        taskId,
        'cleanup-intent',
        'cleanup-completed-awaiting-ack',
      );
      await postCleanupUntilAck(cleanupReceipt);
    } else if (state.phase === 'cleanup-completed-awaiting-ack') {
      const tomb = await stateStore.readTombstone(taskId);
      if (!isPlainObject(tomb) || tomb.cleanupReceipt == null) failStateInvalid();
      await postCleanupUntilAck(/** @type {object} */ (tomb.cleanupReceipt));
    }

    try {
      state = await stateStore.readState(taskId);
      if (state.phase === 'cleanup-completed-awaiting-ack') {
        await stateStore.transitionPhase(
          taskId,
          'cleanup-completed-awaiting-ack',
          'cleaned',
        );
      }
    } catch {
      // ok
    }
  }

  /**
   * @returns {Promise<{ outcome: 'completed' | 'rolled-back' }>}
   */
  async function runPublishPath() {
    const latest = await callJson('GET', `/agent/restore/tasks/${taskId}`);
    const latestTask = projectTaskFromGet(latest);
    cancelRequested = latestTask.cancelRequested;

    state = await stateStore.readState(taskId);
    if (
      cancelRequested
      && (state.phase === 'planned'
        || state.phase === 'receiving'
        || state.phase === 'staging-verified')
    ) {
      return runCancelledLocalPath();
    }

    const filesForVerify = task.files.map(({ path, size, sha256 }) => ({
      path,
      size,
      sha256,
    }));

    const verifyTargetTree = async () => {
      await verifyStagingTree({
        stagingRoot: paths.targetPathAbs,
        files: filesForVerify,
      });
    };
    const verifyStagingTreeFn = async () => {
      await verifyStagingTree({
        stagingRoot: paths.stagingPathAbs,
        files: filesForVerify,
      });
    };

    // Publish ctx MUST use durable STATE originalTargetExisted + old fingerprints
    // (not live paths.originalTargetExisted after target→anchor rename).
    const durableExisted = state.originalTargetExisted === true
      ? true
      : state.originalTargetExisted === false
        ? false
        : originalTargetExisted;
    const durableOldStruct =
      typeof state.oldStructureFingerprint === 'string'
        ? state.oldStructureFingerprint
        : oldStructureFingerprint;
    const durableOldContent =
      typeof state.oldContentSha256 === 'string'
        ? state.oldContentSha256
        : oldContentSha256;

    const pubCtx = {
      stateStore: boundStore,
      paths: {
        targetPathAbs: paths.targetPathAbs,
        stagingPathAbs: paths.stagingPathAbs,
        anchorPathAbs: paths.anchorPathAbs,
        quarantinePathAbs: paths.quarantinePathAbs,
      },
      originalTargetExisted: durableExisted,
      oldStructureFingerprint: durableOldStruct,
      oldContentSha256: durableOldContent,
      rename: fsRename,
      lstat: fsLstat,
      verifyTargetTree,
      verifyStagingTree: verifyStagingTreeFn,
      cancelRequested: false,
      reFetchForbidden: true,
    };

    /** @type {object | null} */
    let receipt = null;

    if (state.phase === 'staging-verified') {
      receipt = await publish.publishFromStagingVerified(pubCtx);
    } else {
      const recovered = await publish.recoverFromCrash(pubCtx);
      if (isPlainObject(recovered) && isPlainObject(recovered.receipt)) {
        receipt = /** @type {object} */ (recovered.receipt);
      } else if (
        isPlainObject(recovered)
        && typeof recovered.outcome === 'string'
        && typeof recovered.receiptId === 'string'
      ) {
        receipt = recovered;
      } else {
        state = await stateStore.readState(taskId);
        if (
          state.phase === 'completed-awaiting-ack'
          || state.phase === 'rolled-back-awaiting-ack'
        ) {
          const tomb = await stateStore.readTombstone(taskId);
          if (!isPlainObject(tomb) || tomb.receipt == null) failStateInvalid();
          receipt = /** @type {object} */ (tomb.receipt);
        } else if (state.phase === 'staging-verified') {
          receipt = await publish.publishFromStagingVerified(pubCtx);
        } else {
          failStateInvalid();
        }
      }
    }

    if (!isPlainObject(receipt) || typeof receipt.outcome !== 'string') {
      failStateInvalid();
    }
    const outcome = receipt.outcome === 'rolled-back' ? 'rolled-back' : 'completed';
    if (typeof receipt.receiptId !== 'string' || !UUID_RE.test(receipt.receiptId)) {
      failStateInvalid();
    }

    await postReceiptUntilAck(receipt);
    await runBusinessCleanup(outcome, receipt.receiptId);
    return { outcome };
  }

  /**
   * @returns {Promise<{ outcome: 'cancelled' } | null>}
   */
  async function runReceiving() {
    await ensureStaging();
    state = await stateStore.readState(taskId);

    if (state.phase === 'planned') {
      if (cancelRequested) return runCancelledLocalPath();
      await stateStore.transitionPhase(taskId, 'planned', 'receiving');
      state = await stateStore.readState(taskId);
    }

    if (state.phase === 'receiving') {
      await stateStore.recoverReceiving(
        taskId,
        paths.stagingPathAbs,
        task.files.map(({ fileIndex, path, size, sha256 }) => ({
          fileIndex,
          path,
          size,
          sha256,
        })),
      );
      state = await stateStore.readState(taskId);
    }

    let durableBytes = /** @type {number} */ (state.receivedBytes);
    if (!Number.isSafeInteger(durableBytes) || durableBytes < 0) failStateInvalid();

    let cursorBytes = 0;
    for (const file of task.files) {
      throwIfAborted(signal);
      if (cancelRequested) return runCancelledLocalPath();

      if (file.size === 0) {
        await materializeChunkToStaging({
          stagingRoot: paths.stagingPathAbs,
          filePath: file.path,
          chunkIndex: 0,
          chunkSize: RESTORE_CHUNK_SIZE,
          bytes: Buffer.alloc(0),
          expectedSha256: ZERO_SHA,
        });
        continue;
      }

      for (let chunkIndex = 0; chunkIndex < file.chunkCount; chunkIndex += 1) {
        throwIfAborted(signal);
        if (cancelRequested) return runCancelledLocalPath();

        const offset = chunkIndex * RESTORE_CHUNK_SIZE;
        const end = Math.min(file.size, offset + RESTORE_CHUNK_SIZE);
        const chunkLen = end - offset;
        const chunkAbsoluteEnd = cursorBytes + end;

        if (chunkAbsoluteEnd <= durableBytes) continue;

        const chunkPath =
          `/agent/restore/tasks/${taskId}/files/${file.fileIndex}/chunks/${chunkIndex}`;

        // Single-chunk: file.sha256 === chunk digest (four-way with expectedSha256).
        // Multi-chunk: files[] frozen shape has no per-chunk digest — omit
        // expectedSha256; requestPinnedDownload still exact-one header/body;
        // returned digest writes staging; verifyStagingTree is whole-file e2e gate.
        const got = file.chunkCount === 1
          ? await callDownload(chunkPath, chunkLen, file.sha256)
          : await callDownload(chunkPath, chunkLen);
        const bytes = got.bytes;
        const sha = got.sha256;

        await materializeChunkToStaging({
          stagingRoot: paths.stagingPathAbs,
          filePath: file.path,
          chunkIndex,
          chunkSize: RESTORE_CHUNK_SIZE,
          bytes,
          expectedSha256: sha,
        });

        const newReceived = cursorBytes + end;
        await stateStore.recordDurableProgress(taskId, {
          fileIndex: file.fileIndex,
          chunkIndex,
          receivedBytes: newReceived,
        });
        durableBytes = newReceived;

        const progressResp = await callJson(
          'POST',
          `/agent/restore/tasks/${taskId}/progress`,
          {
            fileIndex: file.fileIndex,
            chunkIndex,
            receivedBytes: newReceived,
          },
        );
        if (isPlainObject(progressResp) && progressResp.cancelRequested === true) {
          cancelRequested = true;
        }
      }
      cursorBytes += file.size;
    }

    await verifyStagingTree({
      stagingRoot: paths.stagingPathAbs,
      files: task.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    });
    state = await stateStore.readState(taskId);
    if (state.phase === 'receiving') {
      await stateStore.transitionPhase(taskId, 'receiving', 'staging-verified');
    }
    return null;
  }

  // ---- main ----
  try {
    throwIfAborted(signal);
    state = await stateStore.readState(taskId);
    let phase = /** @type {string} */ (state.phase);

    if (phase === 'cleaned') {
      const tomb = await stateStore.readTombstone(taskId).catch(() => null);
      if (isPlainObject(tomb) && isPlainObject(tomb.cleanupReceipt)) {
        const o = tomb.cleanupReceipt.outcome;
        if (o === 'cancelled' || o === 'completed' || o === 'rolled-back') {
          return { outcome: o };
        }
      }
      return { outcome: 'completed' };
    }

    if (
      cancelRequested
      && (phase === 'planned' || phase === 'receiving' || phase === 'staging-verified')
    ) {
      return await runCancelledLocalPath();
    }

    if (phase === 'cancelled-local') {
      return await runCancelledLocalPath();
    }

    if (phase === 'cleanup-completed-awaiting-ack') {
      const tomb = await stateStore.readTombstone(taskId);
      if (!isPlainObject(tomb) || tomb.cleanupReceipt == null) failStateInvalid();
      const cr = /** @type {object} */ (tomb.cleanupReceipt);
      await postCleanupUntilAck(cr);
      try {
        await stateStore.transitionPhase(
          taskId,
          'cleanup-completed-awaiting-ack',
          'cleaned',
        );
      } catch {
        // ok
      }
      const o = cr.outcome;
      if (o === 'cancelled') return { outcome: 'cancelled' };
      return { outcome: o === 'rolled-back' ? 'rolled-back' : 'completed' };
    }

    if (
      phase === 'anchor-intent'
      || phase === 'anchored'
      || phase === 'publish-intent'
      || phase === 'published'
      || phase === 'rollback-intent'
      || phase === 'failed-target-quarantined'
      || phase === 'anchor-restored'
      || phase === 'old-fingerprint-verified'
      || phase === 'completed-awaiting-ack'
      || phase === 'rolled-back-awaiting-ack'
      || phase === 'cleanup-intent'
    ) {
      if (phase === 'completed-awaiting-ack' || phase === 'rolled-back-awaiting-ack') {
        const tomb = await stateStore.readTombstone(taskId);
        if (!isPlainObject(tomb) || tomb.receipt == null) failStateInvalid();
        const receipt = /** @type {object} */ (tomb.receipt);
        await postReceiptUntilAck(receipt);
        const outcome = receipt.outcome === 'rolled-back' ? 'rolled-back' : 'completed';
        await runBusinessCleanup(outcome, receipt.receiptId);
        return { outcome };
      }
      if (phase === 'cleanup-intent') {
        const tomb = await stateStore.readTombstone(taskId);
        if (!isPlainObject(tomb) || tomb.receipt == null) failStateInvalid();
        const receipt = /** @type {object} */ (tomb.receipt);
        const outcome = receipt.outcome === 'rolled-back' ? 'rolled-back' : 'completed';
        await runBusinessCleanup(outcome, receipt.receiptId);
        return { outcome };
      }
      return await runPublishPath();
    }

    if (phase === 'planned' || phase === 'receiving') {
      const early = await runReceiving();
      if (early) return early;
    }

    state = await stateStore.readState(taskId);
    phase = /** @type {string} */ (state.phase);

    if (phase === 'staging-verified') {
      if (cancelRequested) return await runCancelledLocalPath();
      return await runPublishPath();
    }

    failStateInvalid();
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    rethrowSanitized(error);
  }
}
