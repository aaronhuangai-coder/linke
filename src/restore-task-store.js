/**
 * G0c C2 — Controller restore task store (immutable TASK + mutable STATUS).
 * Layout: dataDir/repo/devices/<slug>/restore-tasks/<taskId>/{TASK.json,STATUS.json,FILES.json}
 * No HTTP. Fail-closed LinkeError; never leak path/token/errno/stack.
 */

import { randomUUID as defaultRandomUUID } from 'node:crypto';
import { chmod, readdir as defaultReaddir } from 'node:fs/promises';
import { types as utilTypes } from 'node:util';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertStrictRelativeTarget } from './restore-path.js';
import {
  MAX_RESTORE_TASK_JSON_BYTES,
  RESTORE_CHUNK_SIZE,
  projectCleanupReceipt,
  projectReceiptObject,
  projectStatusJson,
  projectTaskJson,
} from './restore-schemas.js';
import {
  SafeDataFileError,
  assertSafeExistingRelativeDir,
  ensureSafeRelativeDir,
  safeAtomicWriteText,
  safeCreateExclusiveText,
  safeReadText,
} from './safe-data-files.js';
import { safeDevicePath } from './storage.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const MAX_DEVICE_ID_UTF8_BYTES = 256;
const MAX_TASK_DIRS = 4096;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const FILE_ENTRY_KEYS = Object.freeze([
  'fileIndex',
  'path',
  'size',
  'sha256',
  'chunkCount',
]);
const CREATE_KEYS = Object.freeze(['deviceId', 'snapshotId', 'relativeTarget']);
const NONTERMINAL = new Set(['pending', 'active']);

/**
 * @returns {never}
 */
function failStateInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
}

/**
 * @returns {never}
 */
function failTaskInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
}

/**
 * @returns {never}
 */
function failNotFound() {
  throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND);
}

/**
 * @returns {never}
 */
function failConflict() {
  throw new LinkeError(ERROR_CODES.RESTORE_TASK_CONFLICT);
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  try {
    if (utilTypes.isProxy(value)) return false;
  } catch {
    return false;
  }
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return proto === Object.prototype || proto === null;
}

/**
 * Exact own enumerable string data properties (no getters/setters/symbols).
 * @param {unknown} value
 * @param {number} maxKeys
 * @returns {Record<string, unknown> | null}
 */
function readOwnStringDataFields(value, maxKeys) {
  try {
    if (!isPlainRecord(value)) return null;
    if (typeof maxKeys !== 'number' || !Number.isSafeInteger(maxKeys) || maxKeys < 0) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > maxKeys) return null;
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);
    for (const key of ownKeys) {
      if (typeof key !== 'string') return null;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out[key] = desc.value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} fields
 * @param {ReadonlyArray<string>} exactKeys
 * @returns {boolean}
 */
function hasExactKeys(fields, exactKeys) {
  const keys = Object.keys(fields);
  if (keys.length !== exactKeys.length) return false;
  for (const key of exactKeys) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return false;
  }
  for (const key of keys) {
    if (!exactKeys.includes(key)) return false;
  }
  return true;
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(/** @type {object} */ (value))) {
      deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
    }
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertUuid(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failTaskInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertDeviceId(value) {
  if (typeof value !== 'string' || value.length === 0) failTaskInvalid();
  if (Buffer.byteLength(value, 'utf8') > MAX_DEVICE_ID_UTF8_BYTES) failTaskInvalid();
  return value;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isIntegrityFailed(error) {
  return (
    error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
  );
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isPathInvalid(error) {
  return error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_PATH_INVALID;
}

/**
 * Map SafeDataFileError / unexpected I/O → state-invalid; rethrow LinkeError as-is.
 * @param {unknown} error
 * @returns {never}
 */
function mapIo(error) {
  if (error instanceof LinkeError) throw error;
  if (error instanceof SafeDataFileError) failStateInvalid();
  failStateInvalid();
}

/**
 * Production restore task store factory.
 * @param {{
 *   dataDir: string,
 *   storageReader: { assertSnapshotReadable: Function },
 *   now?: () => Date,
 *   randomUUID?: () => string,
 * }} options
 */
export function createRestoreTaskStore(options) {
  if (!isPlainRecord(options)) {
    throw new TypeError('createRestoreTaskStore options required');
  }

  const optFields = readOwnStringDataFields(options, 8);
  if (!optFields) {
    throw new TypeError('createRestoreTaskStore options required');
  }

  const dataDir = optFields.dataDir;
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('dataDir required');
  }

  const storageReader = optFields.storageReader;
  if (!isPlainRecord(storageReader)) {
    throw new TypeError('storageReader required');
  }
  // Only require assertSnapshotReadable as own data method — do not scan
  // sibling getters (test mocks may expose callCount accessors).
  let assertSnapshotReadable;
  try {
    const arDesc = Object.getOwnPropertyDescriptor(
      storageReader,
      'assertSnapshotReadable',
    );
    if (!arDesc || arDesc.get !== undefined || arDesc.set !== undefined) {
      throw new TypeError('storageReader.assertSnapshotReadable required');
    }
    if (typeof arDesc.value !== 'function') {
      throw new TypeError('storageReader.assertSnapshotReadable required');
    }
    assertSnapshotReadable = arDesc.value;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('storageReader.assertSnapshotReadable required');
  }

  const nowFn =
    optFields.now === undefined
      ? () => new Date()
      : typeof optFields.now === 'function'
        ? /** @type {() => Date} */ (optFields.now)
        : null;
  if (nowFn === null) {
    throw new TypeError('now must be a function');
  }

  const uuidFn =
    optFields.randomUUID === undefined
      ? defaultRandomUUID
      : typeof optFields.randomUUID === 'function'
        ? /** @type {() => string} */ (optFields.randomUUID)
        : null;
  if (uuidFn === null) {
    throw new TypeError('randomUUID must be a function');
  }

  /** @type {Map<string, Promise<unknown>>} */
  const deviceQueues = new Map();

  /**
   * Serialize per deviceId.
   * @template T
   * @param {string} deviceId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withDeviceLock(deviceId, fn) {
    const prev = deviceQueues.get(deviceId) || Promise.resolve();
    const run = prev.then(
      () => fn(),
      () => fn(),
    );
    /** @type {Promise<unknown>} */
    const tail = run.then(
      (value) => {
        if (deviceQueues.get(deviceId) === tail) deviceQueues.delete(deviceId);
        return value;
      },
      (err) => {
        if (deviceQueues.get(deviceId) === tail) deviceQueues.delete(deviceId);
        throw err;
      },
    );
    deviceQueues.set(deviceId, tail);
    return /** @type {Promise<T>} */ (tail);
  }

  /**
   * @returns {string}
   */
  function currentIso() {
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
   * @returns {string}
   */
  function nextTaskId() {
    let id;
    try {
      id = uuidFn();
    } catch {
      failStateInvalid();
    }
    if (typeof id !== 'string' || !UUID_RE.test(id)) failTaskInvalid();
    return id;
  }

  /**
   * @param {string} deviceId
   * @returns {{ deviceRel: string }}
   */
  function deviceScope(deviceId) {
    try {
      return safeDevicePath(dataDir, deviceId);
    } catch {
      failTaskInvalid();
    }
  }

  /**
   * @param {string} deviceRel
   * @param {string} taskId
   */
  function taskDirRel(deviceRel, taskId) {
    return `${deviceRel}/restore-tasks/${taskId}`;
  }

  /**
   * @param {string} deviceRel
   * @param {string} taskId
   */
  function taskJsonRel(deviceRel, taskId) {
    return `${taskDirRel(deviceRel, taskId)}/TASK.json`;
  }

  /**
   * @param {string} deviceRel
   * @param {string} taskId
   */
  function statusJsonRel(deviceRel, taskId) {
    return `${taskDirRel(deviceRel, taskId)}/STATUS.json`;
  }

  /**
   * @param {string} deviceRel
   * @param {string} taskId
   */
  function filesJsonRel(deviceRel, taskId) {
    return `${taskDirRel(deviceRel, taskId)}/FILES.json`;
  }

  /**
   * @param {string} rel
   * @param {{ missing: 'not-found' | 'state' }} mode
   * @returns {Promise<string>}
   */
  async function readText(rel, mode) {
    try {
      return await safeReadText(dataDir, rel, { maxBytes: MAX_JSON_BYTES });
    } catch (error) {
      if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
        if (mode.missing === 'not-found') failNotFound();
        failStateInvalid();
      }
      mapIo(error);
    }
  }

  /**
   * Corrupt / non-JSON body is always state-invalid once the leaf was readable.
   * @param {string} text
   * @returns {unknown}
   */
  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      failStateInvalid();
    }
  }

  /**
   * @param {unknown} raw
   * @returns {{
   *   fileIndex: number,
   *   path: string,
   *   size: number,
   *   sha256: string,
   *   chunkCount: number,
   * }[]}
   */
  function projectFilesArray(raw) {
    if (!Array.isArray(raw)) failStateInvalid();
    /** @type {{
     *   fileIndex: number,
     *   path: string,
     *   size: number,
     *   sha256: string,
     *   chunkCount: number,
     * }[]} */
    const out = [];
    for (let i = 0; i < raw.length; i += 1) {
      const fields = readOwnStringDataFields(raw[i], FILE_ENTRY_KEYS.length);
      if (!fields || !hasExactKeys(fields, FILE_ENTRY_KEYS)) failStateInvalid();
      const fileIndex = fields.fileIndex;
      const path = fields.path;
      const size = fields.size;
      const sha256 = fields.sha256;
      const chunkCount = fields.chunkCount;
      if (fileIndex !== i) failStateInvalid();
      if (typeof path !== 'string' || path.length === 0) failStateInvalid();
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
        failStateInvalid();
      }
      if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256)) failStateInvalid();
      if (typeof chunkCount !== 'number' || !Number.isSafeInteger(chunkCount) || chunkCount < 0) {
        failStateInvalid();
      }
      const expectedChunks = size === 0 ? 0 : Math.ceil(size / RESTORE_CHUNK_SIZE);
      if (chunkCount !== expectedChunks) failStateInvalid();
      out.push({ fileIndex: i, path, size, sha256, chunkCount });
    }
    return out;
  }

  /**
   * @param {unknown} raw
   * @param {string} taskId
   * @param {Readonly<object>} task
   */
  function projectFilesMeta(raw, taskId, task) {
    const fields = readOwnStringDataFields(raw, 8);
    if (!fields) failStateInvalid();
    if (fields.schemaVersion !== 1) failStateInvalid();
    if (fields.taskId !== taskId) failStateInvalid();
    if (fields.manifestDigest !== task.manifestDigest) failStateInvalid();
    if (fields.fileCount !== task.fileCount) failStateInvalid();
    if (fields.totalBytes !== task.totalBytes) failStateInvalid();
    const files = projectFilesArray(fields.files);
    if (files.length !== task.fileCount) failStateInvalid();
    let sum = 0;
    for (const f of files) {
      const next = sum + f.size;
      if (!Number.isSafeInteger(next)) failStateInvalid();
      sum = next;
    }
    if (sum !== task.totalBytes) failStateInvalid();
    return files;
  }

  /**
   * @param {string} deviceId
   * @param {string} taskId
   * @param {{ missing: 'not-found' | 'state' }} mode
   */
  async function loadTaskBundle(deviceId, taskId, mode) {
    if (!UUID_RE.test(taskId)) {
      if (mode.missing === 'not-found') failNotFound();
      failStateInvalid();
    }
    const { deviceRel } = deviceScope(deviceId);
    const taskText = await readText(taskJsonRel(deviceRel, taskId), mode);
    const statusText = await readText(statusJsonRel(deviceRel, taskId), mode);
    const filesText = await readText(filesJsonRel(deviceRel, taskId), mode);

    const taskRaw = parseJson(taskText);
    const statusRaw = parseJson(statusText);
    const filesRaw = parseJson(filesText);

    let task;
    try {
      task = projectTaskJson(taskRaw, { expectedTaskId: taskId });
    } catch (error) {
      if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_TASK_INVALID) {
        failStateInvalid();
      }
      mapIo(error);
    }
    if (task.deviceId !== deviceId) {
      if (mode.missing === 'not-found') failNotFound();
      failStateInvalid();
    }

    let status;
    try {
      status = projectStatusJson(statusRaw, { expectedTaskId: taskId });
    } catch (error) {
      if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_TASK_INVALID) {
        failStateInvalid();
      }
      mapIo(error);
    }

    const files = projectFilesMeta(filesRaw, taskId, task);
    return { task, status, files, deviceRel };
  }

  /**
   * @param {string} deviceId
   * @returns {Promise<string[]>}
   */
  async function listTaskIds(deviceId) {
    const { deviceRel } = deviceScope(deviceId);
    const tasksRel = `${deviceRel}/restore-tasks`;
    let abs;
    try {
      abs = await assertSafeExistingRelativeDir(dataDir, tasksRel);
    } catch (error) {
      if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
        return [];
      }
      mapIo(error);
    }

    let entries;
    try {
      entries = await defaultReaddir(abs, { withFileTypes: true });
    } catch {
      failStateInvalid();
    }
    if (!Array.isArray(entries)) failStateInvalid();
    if (entries.length > MAX_TASK_DIRS) failStateInvalid();

    /** @type {string[]} */
    const ids = [];
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string') failStateInvalid();
      const name = entry.name;
      if (!name || name.includes('\0') || name === '.' || name === '..') failStateInvalid();
      if (name.includes('/') || name.includes('\\')) failStateInvalid();
      if (typeof entry.isSymbolicLink !== 'function' || typeof entry.isDirectory !== 'function') {
        failStateInvalid();
      }
      if (entry.isSymbolicLink()) failStateInvalid();
      if (!entry.isDirectory()) failStateInvalid();
      if (!UUID_RE.test(name)) failStateInvalid();
      ids.push(name);
    }
    ids.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    return ids;
  }

  /**
   * @param {string} deviceId
   */
  async function loadNonterminalBundles(deviceId) {
    const ids = await listTaskIds(deviceId);
    /** @type {Awaited<ReturnType<typeof loadTaskBundle>>[]} */
    const out = [];
    for (const taskId of ids) {
      // Missing/corrupt task under UUID dir is state-invalid (not silent skip).
      const bundle = await loadTaskBundle(deviceId, taskId, { missing: 'state' });
      if (NONTERMINAL.has(bundle.status.status)) {
        out.push(bundle);
      }
    }
    out.sort((a, b) => {
      const ca = a.task.createdAt;
      const cb = b.task.createdAt;
      if (ca < cb) return -1;
      if (ca > cb) return 1;
      return Buffer.compare(Buffer.from(a.task.taskId, 'utf8'), Buffer.from(b.task.taskId, 'utf8'));
    });
    return out;
  }

  /**
   * @param {unknown} raw
   */
  function projectReadableResult(raw) {
    const fields = readOwnStringDataFields(raw, 8);
    if (!fields) failStateInvalid();
    if (typeof fields.manifestDigest !== 'string' || !SHA256_HEX_RE.test(fields.manifestDigest)) {
      failStateInvalid();
    }
    if (typeof fields.fileCount !== 'number' || !Number.isSafeInteger(fields.fileCount)) {
      failStateInvalid();
    }
    if (typeof fields.totalBytes !== 'number' || !Number.isSafeInteger(fields.totalBytes)) {
      failStateInvalid();
    }
    if (fields.fileCount < 0 || fields.fileCount > 100_000) failStateInvalid();
    if (fields.totalBytes < 0) failStateInvalid();
    const files = projectFilesArray(fields.files);
    if (files.length !== fields.fileCount) failStateInvalid();
    let sum = 0;
    for (const f of files) {
      const next = sum + f.size;
      if (!Number.isSafeInteger(next)) failStateInvalid();
      sum = next;
    }
    if (sum !== fields.totalBytes) failStateInvalid();
    return {
      manifestDigest: fields.manifestDigest,
      fileCount: fields.fileCount,
      totalBytes: fields.totalBytes,
      files,
    };
  }

  /**
   * @param {object} taskLike
   * @param {ReadonlyArray<object>} files
   */
  function estimateGetTaskJsonBytes(taskLike, files) {
    const sample = {
      taskId: taskLike.taskId,
      snapshotId: taskLike.snapshotId,
      manifestDigest: taskLike.manifestDigest,
      relativeTarget: taskLike.relativeTarget,
      status: 'active',
      cancelRequested: false,
      cleanupAuthorized: false,
      fileCount: taskLike.fileCount,
      totalBytes: taskLike.totalBytes,
      chunkSize: RESTORE_CHUNK_SIZE,
      createdAt: taskLike.createdAt,
      claimedAt: taskLike.createdAt,
      files,
    };
    return Buffer.byteLength(JSON.stringify(sample), 'utf8');
  }

  /**
   * @param {string} deviceRel
   * @param {string} taskId
   * @param {object} taskObj
   * @param {object} statusObj
   * @param {object} filesObj
   */
  async function writeNewTask(deviceRel, taskId, taskObj, statusObj, filesObj) {
    const dirRel = taskDirRel(deviceRel, taskId);
    let dirAbs;
    try {
      dirAbs = await ensureSafeRelativeDir(dataDir, dirRel);
      await chmod(dirAbs, 0o700);
    } catch (error) {
      mapIo(error);
    }

    const taskText = JSON.stringify(taskObj);
    const statusText = JSON.stringify(statusObj);
    const filesText = JSON.stringify(filesObj);
    if (Buffer.byteLength(taskText, 'utf8') > MAX_JSON_BYTES) failTaskInvalid();
    if (Buffer.byteLength(statusText, 'utf8') > MAX_JSON_BYTES) failTaskInvalid();
    if (Buffer.byteLength(filesText, 'utf8') > MAX_JSON_BYTES) failTaskInvalid();

    let taskCreated;
    try {
      taskCreated = await safeCreateExclusiveText(
        dataDir,
        taskJsonRel(deviceRel, taskId),
        taskText,
        { mode: 0o600 },
      );
    } catch (error) {
      mapIo(error);
    }
    if (!taskCreated.created) failStateInvalid();

    let filesCreated;
    try {
      filesCreated = await safeCreateExclusiveText(
        dataDir,
        filesJsonRel(deviceRel, taskId),
        filesText,
        { mode: 0o600 },
      );
    } catch (error) {
      mapIo(error);
    }
    if (!filesCreated.created) failStateInvalid();

    try {
      await safeAtomicWriteText(dataDir, statusJsonRel(deviceRel, taskId), statusText, {
        mode: 0o600,
      });
    } catch (error) {
      mapIo(error);
    }
  }

  /**
   * @param {string} deviceRel
   * @param {string} taskId
   * @param {object} statusObj
   */
  async function writeStatus(deviceRel, taskId, statusObj) {
    const text = JSON.stringify(statusObj);
    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) failStateInvalid();
    try {
      // Validate before write.
      projectStatusJson(statusObj, { expectedTaskId: taskId });
      await safeAtomicWriteText(dataDir, statusJsonRel(deviceRel, taskId), text, {
        mode: 0o600,
      });
    } catch (error) {
      if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_TASK_INVALID) {
        failStateInvalid();
      }
      mapIo(error);
    }
  }

  /**
   * @param {Readonly<object>} task
   * @param {Readonly<object>} status
   */
  function taskSummaryFrom(task, status) {
    return deepFreeze({
      taskId: task.taskId,
      deviceId: task.deviceId,
      snapshotId: task.snapshotId,
      manifestDigest: task.manifestDigest,
      relativeTarget: task.relativeTarget,
      status: status.status,
      fileCount: task.fileCount,
      totalBytes: task.totalBytes,
      createdAt: task.createdAt,
    });
  }

  /**
   * @param {Readonly<object>} task
   * @param {Readonly<object>} status
   */
  function getView(task, status) {
    return deepFreeze({
      taskId: task.taskId,
      deviceId: task.deviceId,
      snapshotId: task.snapshotId,
      manifestDigest: task.manifestDigest,
      relativeTarget: task.relativeTarget,
      status: status.status,
      updatedAt: status.updatedAt,
      cancelRequested: status.cancelRequestedAt != null,
      cleanupAuthorized: status.cleanupAuthorized,
      fileCount: task.fileCount,
      totalBytes: task.totalBytes,
      createdAt: task.createdAt,
      claimedAt: status.claimedAt,
      completedAt: status.completedAt,
      lastProgress: status.lastProgress,
      receipt: status.receipt,
      cleanupReceipt: status.cleanupReceipt,
    });
  }

  /**
   * @param {Readonly<object>} task
   * @param {Readonly<object>} status
   */
  function claimView(task, status) {
    return deepFreeze({
      taskId: task.taskId,
      snapshotId: task.snapshotId,
      manifestDigest: task.manifestDigest,
      relativeTarget: task.relativeTarget,
      status: status.status,
      fileCount: task.fileCount,
      totalBytes: task.totalBytes,
      chunkSize: RESTORE_CHUNK_SIZE,
      createdAt: task.createdAt,
      claimedAt: status.claimedAt,
      cancelRequested: status.cancelRequestedAt != null,
    });
  }

  /**
   * @param {unknown} input
   */
  function parseCreateInput(input) {
    const fields = readOwnStringDataFields(input, CREATE_KEYS.length);
    if (!fields || !hasExactKeys(fields, CREATE_KEYS)) failTaskInvalid();
    const deviceId = assertDeviceId(fields.deviceId);
    const snapshotId = assertUuid(fields.snapshotId);
    let relativeTarget;
    try {
      relativeTarget = assertStrictRelativeTarget(fields.relativeTarget);
    } catch (error) {
      if (isPathInvalid(error)) throw error;
      failTaskInvalid();
    }
    return { deviceId, snapshotId, relativeTarget };
  }

  /**
   * @param {{ deviceId: string, snapshotId: string, relativeTarget: string }} input
   */
  async function createImpl(input) {
    const { deviceId, snapshotId, relativeTarget } = input;
    const { deviceRel } = deviceScope(deviceId);

    const nonterminal = await loadNonterminalBundles(deviceId);

    // Call reader once per create attempt for digest authority.
    let readableRaw;
    try {
      readableRaw = await assertSnapshotReadable(deviceId, snapshotId);
    } catch (error) {
      if (isIntegrityFailed(error)) throw error;
      if (error instanceof LinkeError) throw error;
      failStateInvalid();
    }
    const readable = projectReadableResult(readableRaw);

    if (nonterminal.length > 0) {
      // One-active: only one nonterminal expected; use the first for identity checks.
      const existing = nonterminal[0];
      const sameIdentity =
        existing.task.snapshotId === snapshotId
        && existing.task.relativeTarget === relativeTarget;
      if (sameIdentity) {
        if (existing.task.manifestDigest === readable.manifestDigest) {
          return deepFreeze({
            httpHint: 200,
            taskSummary: taskSummaryFrom(existing.task, existing.status),
          });
        }
        failConflict();
      }
      failConflict();
    }

    if (estimateGetTaskJsonBytes({
      taskId: '00000000-0000-4000-8000-000000000000',
      snapshotId,
      manifestDigest: readable.manifestDigest,
      relativeTarget,
      fileCount: readable.fileCount,
      totalBytes: readable.totalBytes,
      createdAt: '2026-01-01T00:00:00.000Z',
    }, readable.files) > MAX_RESTORE_TASK_JSON_BYTES) {
      failTaskInvalid();
    }

    const taskId = nextTaskId();
    const createdAt = currentIso();
    const taskObj = {
      schemaVersion: 1,
      taskId,
      deviceId,
      snapshotId,
      manifestDigest: readable.manifestDigest,
      relativeTarget,
      createdAt,
      fileCount: readable.fileCount,
      totalBytes: readable.totalBytes,
      chunkSize: RESTORE_CHUNK_SIZE,
    };
    // Validate shape before write.
    try {
      projectTaskJson(taskObj, { expectedTaskId: taskId });
    } catch (error) {
      if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_TASK_INVALID) {
        failTaskInvalid();
      }
      throw error;
    }

    const statusObj = {
      schemaVersion: 1,
      taskId,
      status: 'pending',
      updatedAt: createdAt,
      claimedAt: null,
      completedAt: null,
      receipt: null,
      receiptAckAt: null,
      cleanupAuthorized: false,
      cleanupReceipt: null,
      cleanupAckAt: null,
      cancelRequestedAt: null,
      lastProgress: null,
    };
    try {
      projectStatusJson(statusObj, { expectedTaskId: taskId });
    } catch {
      failStateInvalid();
    }

    const filesObj = {
      schemaVersion: 1,
      taskId,
      manifestDigest: readable.manifestDigest,
      fileCount: readable.fileCount,
      totalBytes: readable.totalBytes,
      files: readable.files.map((f) => ({
        fileIndex: f.fileIndex,
        path: f.path,
        size: f.size,
        sha256: f.sha256,
        chunkCount: f.chunkCount,
      })),
    };

    await writeNewTask(deviceRel, taskId, taskObj, statusObj, filesObj);

    // Verify re-read
    const bundle = await loadTaskBundle(deviceId, taskId, { missing: 'state' });
    if (bundle.task.manifestDigest !== readable.manifestDigest) failStateInvalid();
    if (bundle.status.status !== 'pending') failStateInvalid();

    return deepFreeze({
      httpHint: 201,
      taskSummary: taskSummaryFrom(bundle.task, bundle.status),
    });
  }

  /**
   * @param {unknown} input
   */
  async function create(input) {
    const parsed = parseCreateInput(input);
    return withDeviceLock(parsed.deviceId, () => createImpl(parsed));
  }

  /**
   * @param {unknown} input
   */
  async function get(input) {
    const fields = readOwnStringDataFields(input, 2);
    if (!fields || !hasExactKeys(fields, ['deviceId', 'taskId'])) failTaskInvalid();
    const deviceId = assertDeviceId(fields.deviceId);
    const taskId = assertUuid(fields.taskId);
    return withDeviceLock(deviceId, async () => {
      const bundle = await loadTaskBundle(deviceId, taskId, { missing: 'not-found' });
      return getView(bundle.task, bundle.status);
    });
  }

  /**
   * @param {string} deviceId
   * @param {string} taskId
   */
  async function readTaskImmutable(deviceId, taskId) {
    const d = assertDeviceId(deviceId);
    const t = assertUuid(taskId);
    return withDeviceLock(d, async () => {
      const bundle = await loadTaskBundle(d, t, { missing: 'not-found' });
      return deepFreeze({ ...bundle.task });
    });
  }

  /**
   * @param {string} deviceId
   * @param {string} taskId
   */
  async function buildTaskFilesPayload(deviceId, taskId) {
    const d = assertDeviceId(deviceId);
    const t = assertUuid(taskId);
    return withDeviceLock(d, async () => {
      const bundle = await loadTaskBundle(d, t, { missing: 'not-found' });
      return deepFreeze({
        files: bundle.files.map((f) => ({
          fileIndex: f.fileIndex,
          path: f.path,
          size: f.size,
          sha256: f.sha256,
          chunkCount: f.chunkCount,
        })),
      });
    });
  }

  /**
   * @param {unknown} input
   */
  async function claimNext(input) {
    const fields = readOwnStringDataFields(input, 2);
    if (!fields || !hasExactKeys(fields, ['deviceId', 'hasActiveUpload'])) {
      failTaskInvalid();
    }
    const deviceId = assertDeviceId(fields.deviceId);
    if (fields.hasActiveUpload !== true && fields.hasActiveUpload !== false) {
      failTaskInvalid();
    }
    const hasActiveUpload = fields.hasActiveUpload;

    return withDeviceLock(deviceId, async () => {
      if (hasActiveUpload === true) failConflict();

      const nonterminal = await loadNonterminalBundles(deviceId);
      const active = nonterminal.filter((b) => b.status.status === 'active');
      if (active.length > 0) failConflict();

      const pending = nonterminal.filter((b) => b.status.status === 'pending');
      if (pending.length === 0) {
        return deepFreeze({ task: null });
      }
      const chosen = pending[0];
      const claimedAt = currentIso();
      const nextStatus = {
        schemaVersion: 1,
        taskId: chosen.task.taskId,
        status: 'active',
        updatedAt: claimedAt,
        claimedAt,
        completedAt: null,
        receipt: null,
        receiptAckAt: null,
        cleanupAuthorized: false,
        cleanupReceipt: null,
        cleanupAckAt: null,
        cancelRequestedAt: null,
        lastProgress: null,
      };
      await writeStatus(chosen.deviceRel, chosen.task.taskId, nextStatus);
      const reloaded = await loadTaskBundle(deviceId, chosen.task.taskId, {
        missing: 'state',
      });
      return deepFreeze({ task: claimView(reloaded.task, reloaded.status) });
    });
  }

  /**
   * @param {unknown} input
   */
  async function cancel(input) {
    const fields = readOwnStringDataFields(input, 2);
    if (!fields || !hasExactKeys(fields, ['deviceId', 'taskId'])) failTaskInvalid();
    const deviceId = assertDeviceId(fields.deviceId);
    const taskId = assertUuid(fields.taskId);

    return withDeviceLock(deviceId, async () => {
      const bundle = await loadTaskBundle(deviceId, taskId, { missing: 'not-found' });
      const { task, status, deviceRel } = bundle;
      const st = status.status;

      if (st === 'cancelled') {
        return deepFreeze({
          httpHint: 200,
          status: 'cancelled',
          cancelRequested: true,
        });
      }
      if (st === 'completed' || st === 'rolled-back' || st === 'cleaned') {
        failConflict();
      }
      if (st === 'pending') {
        const now = currentIso();
        const nextStatus = {
          schemaVersion: 1,
          taskId,
          status: 'cancelled',
          updatedAt: now,
          claimedAt: null,
          completedAt: null,
          receipt: null,
          receiptAckAt: null,
          cleanupAuthorized: false,
          cleanupReceipt: null,
          cleanupAckAt: null,
          cancelRequestedAt: now,
          lastProgress: null,
        };
        await writeStatus(deviceRel, taskId, nextStatus);
        return deepFreeze({
          httpHint: 200,
          status: 'cancelled',
          cancelRequested: true,
        });
      }
      if (st === 'active') {
        const now = currentIso();
        const nextStatus = {
          schemaVersion: 1,
          taskId,
          status: 'active',
          updatedAt: now,
          claimedAt: status.claimedAt,
          completedAt: null,
          receipt: null,
          receiptAckAt: null,
          cleanupAuthorized: false,
          cleanupReceipt: null,
          cleanupAckAt: null,
          cancelRequestedAt: status.cancelRequestedAt ?? now,
          lastProgress: status.lastProgress,
        };
        await writeStatus(deviceRel, taskId, nextStatus);
        return deepFreeze({
          httpHint: 202,
          status: 'active',
          cancelRequested: true,
        });
      }
      failConflict();
    });
  }

  /**
   * @param {unknown} input
   */
  async function acceptReceipt(input) {
    const fields = readOwnStringDataFields(input, 3);
    if (!fields || !hasExactKeys(fields, ['deviceId', 'taskId', 'receipt'])) {
      failTaskInvalid();
    }
    const deviceId = assertDeviceId(fields.deviceId);
    const taskId = assertUuid(fields.taskId);

    let receipt;
    try {
      receipt = projectReceiptObject(fields.receipt);
    } catch (error) {
      if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_TASK_INVALID) {
        throw error;
      }
      failTaskInvalid();
    }

    return withDeviceLock(deviceId, async () => {
      const bundle = await loadTaskBundle(deviceId, taskId, { missing: 'not-found' });
      const { task, status, deviceRel } = bundle;

      // Idempotent: already completed/rolled-back with same receipt
      if (status.status === 'completed' || status.status === 'rolled-back') {
        if (!status.receipt) failStateInvalid();
        if (JSON.stringify(status.receipt) === JSON.stringify(receipt)) {
          return deepFreeze({
            ok: true,
            taskId,
            status: status.status,
            cleanupAuthorized: true,
            receiptId: receipt.receiptId,
          });
        }
        failConflict();
      }

      if (status.status !== 'active') failConflict();

      if (receipt.taskId !== taskId) failConflict();
      if (receipt.deviceId !== deviceId) failNotFound();
      if (receipt.snapshotId !== task.snapshotId) failConflict();
      if (receipt.manifestDigest !== task.manifestDigest) failConflict();
      if (receipt.relativeTarget !== task.relativeTarget) failConflict();
      if (receipt.fileCount !== task.fileCount) failConflict();
      if (receipt.totalBytes !== task.totalBytes) failConflict();
      if (receipt.outcome !== 'completed' && receipt.outcome !== 'rolled-back') {
        failTaskInvalid();
      }

      const now = currentIso();
      const nextStatus = {
        schemaVersion: 1,
        taskId,
        status: receipt.outcome,
        updatedAt: now,
        claimedAt: status.claimedAt,
        completedAt: now,
        receipt: {
          schemaVersion: receipt.schemaVersion,
          taskId: receipt.taskId,
          deviceId: receipt.deviceId,
          snapshotId: receipt.snapshotId,
          manifestDigest: receipt.manifestDigest,
          outcome: receipt.outcome,
          relativeTarget: receipt.relativeTarget,
          totalBytes: receipt.totalBytes,
          fileCount: receipt.fileCount,
          contentSha256: receipt.contentSha256,
          structureFingerprint: receipt.structureFingerprint,
          publishedVerifiedAt: receipt.publishedVerifiedAt,
          rolledBackAt: receipt.rolledBackAt,
          anchorPresentBeforePublish: receipt.anchorPresentBeforePublish,
          receiptId: receipt.receiptId,
        },
        receiptAckAt: now,
        cleanupAuthorized: true,
        cleanupReceipt: null,
        cleanupAckAt: null,
        cancelRequestedAt: status.cancelRequestedAt,
        lastProgress: status.lastProgress,
      };
      await writeStatus(deviceRel, taskId, nextStatus);
      return deepFreeze({
        ok: true,
        taskId,
        status: receipt.outcome,
        cleanupAuthorized: true,
        receiptId: receipt.receiptId,
      });
    });
  }

  /**
   * @param {unknown} input
   */
  async function acceptCleanup(input) {
    const fields = readOwnStringDataFields(input, 3);
    if (!fields || !hasExactKeys(fields, ['deviceId', 'taskId', 'cleanupReceipt'])) {
      failTaskInvalid();
    }
    const deviceId = assertDeviceId(fields.deviceId);
    const taskId = assertUuid(fields.taskId);

    let cleanupReceipt;
    try {
      cleanupReceipt = projectCleanupReceipt(fields.cleanupReceipt);
    } catch (error) {
      if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_TASK_INVALID) {
        throw error;
      }
      failTaskInvalid();
    }

    return withDeviceLock(deviceId, async () => {
      const bundle = await loadTaskBundle(deviceId, taskId, { missing: 'not-found' });
      const { status, deviceRel } = bundle;

      // Idempotent cleaned
      if (status.status === 'cleaned') {
        if (
          status.cleanupReceipt
          && JSON.stringify(status.cleanupReceipt) === JSON.stringify(cleanupReceipt)
        ) {
          return deepFreeze({
            ok: true,
            taskId,
            status: 'cleaned',
            cleanupId: cleanupReceipt.cleanupId,
            cleanupAckAt: status.cleanupAckAt,
          });
        }
        failConflict();
      }

      // Idempotent cancelled final
      if (status.status === 'cancelled' && status.cleanupAckAt != null) {
        if (
          status.cleanupReceipt
          && JSON.stringify(status.cleanupReceipt) === JSON.stringify(cleanupReceipt)
        ) {
          return deepFreeze({
            ok: true,
            taskId,
            status: 'cancelled',
            cleanupId: cleanupReceipt.cleanupId,
            cleanupAckAt: status.cleanupAckAt,
          });
        }
        failConflict();
      }

      if (cleanupReceipt.taskId !== taskId) failConflict();
      if (cleanupReceipt.deviceId !== deviceId) failNotFound();

      const cleanupPlain = {
        schemaVersion: cleanupReceipt.schemaVersion,
        cleanupId: cleanupReceipt.cleanupId,
        taskId: cleanupReceipt.taskId,
        deviceId: cleanupReceipt.deviceId,
        outcome: cleanupReceipt.outcome,
        receiptId: cleanupReceipt.receiptId,
        cleanedAt: cleanupReceipt.cleanedAt,
      };

      if (
        cleanupReceipt.outcome === 'completed'
        || cleanupReceipt.outcome === 'rolled-back'
      ) {
        if (status.status !== cleanupReceipt.outcome) failConflict();
        if (status.cleanupAuthorized !== true) failConflict();
        if (!status.receipt) failConflict();
        if (status.receipt.receiptId !== cleanupReceipt.receiptId) failConflict();
        if (status.receipt.outcome !== cleanupReceipt.outcome) failConflict();

        const now = currentIso();
        const nextStatus = {
          schemaVersion: 1,
          taskId,
          status: 'cleaned',
          updatedAt: now,
          claimedAt: status.claimedAt,
          completedAt: status.completedAt,
          receipt: status.receipt,
          receiptAckAt: status.receiptAckAt,
          cleanupAuthorized: true,
          cleanupReceipt: cleanupPlain,
          cleanupAckAt: now,
          cancelRequestedAt: status.cancelRequestedAt,
          lastProgress: status.lastProgress,
        };
        await writeStatus(deviceRel, taskId, nextStatus);
        return deepFreeze({
          ok: true,
          taskId,
          status: 'cleaned',
          cleanupId: cleanupReceipt.cleanupId,
          cleanupAckAt: now,
        });
      }

      if (cleanupReceipt.outcome === 'cancelled') {
        if (status.status !== 'active') failConflict();
        if (status.cancelRequestedAt == null) failConflict();
        if (cleanupReceipt.receiptId !== null) failTaskInvalid();
        if (status.receipt !== null) failConflict();

        const now = currentIso();
        const nextStatus = {
          schemaVersion: 1,
          taskId,
          status: 'cancelled',
          updatedAt: now,
          claimedAt: status.claimedAt,
          completedAt: null,
          receipt: null,
          receiptAckAt: null,
          cleanupAuthorized: false,
          cleanupReceipt: cleanupPlain,
          cleanupAckAt: now,
          cancelRequestedAt: status.cancelRequestedAt,
          lastProgress: status.lastProgress,
        };
        await writeStatus(deviceRel, taskId, nextStatus);
        return deepFreeze({
          ok: true,
          taskId,
          status: 'cancelled',
          cleanupId: cleanupReceipt.cleanupId,
          cleanupAckAt: now,
        });
      }

      failTaskInvalid();
    });
  }

  /**
   * @param {unknown} input
   */
  async function updateProgress(input) {
    const fields = readOwnStringDataFields(input, 5);
    if (
      !fields
      || !hasExactKeys(fields, [
        'deviceId',
        'taskId',
        'fileIndex',
        'chunkIndex',
        'receivedBytes',
      ])
    ) {
      failTaskInvalid();
    }
    const deviceId = assertDeviceId(fields.deviceId);
    const taskId = assertUuid(fields.taskId);
    const fileIndex = fields.fileIndex;
    const chunkIndex = fields.chunkIndex;
    const receivedBytes = fields.receivedBytes;
    if (typeof fileIndex !== 'number' || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
      failTaskInvalid();
    }
    if (typeof chunkIndex !== 'number' || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
      failTaskInvalid();
    }
    if (
      typeof receivedBytes !== 'number'
      || !Number.isSafeInteger(receivedBytes)
      || receivedBytes < 0
    ) {
      failTaskInvalid();
    }

    return withDeviceLock(deviceId, async () => {
      const bundle = await loadTaskBundle(deviceId, taskId, { missing: 'not-found' });
      const { task, status, files, deviceRel } = bundle;
      if (status.status !== 'active') failTaskInvalid();

      if (fileIndex >= files.length) failTaskInvalid();
      const file = files[fileIndex];
      if (file.chunkCount === 0) failTaskInvalid();
      if (chunkIndex >= file.chunkCount) failTaskInvalid();
      if (receivedBytes > task.totalBytes) failTaskInvalid();

      const prev = status.lastProgress;
      if (prev) {
        // Strict non-decreasing (fileIndex, chunkIndex, receivedBytes)
        if (fileIndex < prev.fileIndex) failTaskInvalid();
        if (fileIndex === prev.fileIndex && chunkIndex < prev.chunkIndex) {
          failTaskInvalid();
        }
        if (
          fileIndex === prev.fileIndex
          && chunkIndex === prev.chunkIndex
          && receivedBytes < prev.receivedBytes
        ) {
          failTaskInvalid();
        }
      }

      const now = currentIso();
      const nextStatus = {
        schemaVersion: 1,
        taskId,
        status: 'active',
        updatedAt: now,
        claimedAt: status.claimedAt,
        completedAt: null,
        receipt: null,
        receiptAckAt: null,
        cleanupAuthorized: false,
        cleanupReceipt: null,
        cleanupAckAt: null,
        cancelRequestedAt: status.cancelRequestedAt,
        lastProgress: {
          fileIndex,
          chunkIndex,
          receivedBytes,
          updatedAt: now,
        },
      };
      await writeStatus(deviceRel, taskId, nextStatus);
      return deepFreeze({
        ok: true,
        cancelRequested: status.cancelRequestedAt != null,
      });
    });
  }

  /**
   * @param {string} deviceId
   */
  async function listAdmissionNonterminal(deviceId) {
    const d = assertDeviceId(deviceId);
    return withDeviceLock(d, async () => {
      const bundles = await loadNonterminalBundles(d);
      return deepFreeze(bundles.map((b) => b.task.taskId));
    });
  }

  /**
   * @param {string} deviceId
   */
  async function hasActiveRestore(deviceId) {
    const d = assertDeviceId(deviceId);
    return withDeviceLock(d, async () => {
      const bundles = await loadNonterminalBundles(d);
      return bundles.length > 0;
    });
  }

  return Object.freeze({
    create,
    get,
    cancel,
    claimNext,
    acceptReceipt,
    acceptCleanup,
    updateProgress,
    listAdmissionNonterminal,
    readTaskImmutable,
    buildTaskFilesPayload,
    hasActiveRestore,
  });
}
