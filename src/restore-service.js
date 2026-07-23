/**
 * G0c C5 — Restore service orchestration (pure domain; no HTTP routes).
 * Shares live-binary slots with upload putChunk via locks.runTransfer (getChunk only).
 * Bidirectional admission: claim probes findActiveUpload inside the same runDevice critical section.
 */

import { createHash } from 'node:crypto';
import { ERROR_CODES, LinkeError } from './error-codes.js';

const INVALID_SERVICE_OPTIONS = 'invalid createRestoreService options';

/**
 * Fixed sanitized constructor failure (never echo inputs).
 * @returns {never}
 */
function failInvalidOptions() {
  throw new TypeError(INVALID_SERVICE_OPTIONS);
}

/**
 * Sanitize claim dependency failures (findActiveUpload / claimNext).
 * LinkeError: rethrow the exact same object. All other errors: NEW RESTORE_STATE_INVALID
 * (never include raw message/path/code/details).
 *
 * @param {unknown} error
 * @returns {never}
 */
function sanitizeClaimDependencyError(error) {
  if (error instanceof LinkeError) throw error;
  throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isNonNullObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFunction(value) {
  return typeof value === 'function';
}

/**
 * Shallow-copy own enumerable string keys into a null-prototype object.
 * Does not mutate the source.
 * @param {unknown} source
 * @returns {Record<string, unknown>}
 */
function cleanShallowCopy(source) {
  /** @type {Record<string, unknown>} */
  const out = Object.create(null);
  if (!isNonNullObject(source)) return out;
  let keys;
  try {
    keys = Object.keys(source);
  } catch {
    return out;
  }
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    try {
      out[key] = /** @type {Record<string, unknown>} */ (source)[key];
    } catch {
      // skip hostile getters
    }
  }
  return out;
}

/**
 * Create pure-domain restore service. Does not listen on ports or register routes.
 *
 * @param {{
 *   taskStore: {
 *     claimNext: Function,
 *     get: Function,
 *     updateProgress: Function,
 *     acceptReceipt: Function,
 *     acceptCleanup: Function,
 *     create: Function,
 *     cancel: Function,
 *     hasActiveRestore: Function,
 *     buildTaskFilesPayload: Function,
 *   },
 *   locks: {
 *     runTransfer: Function,
 *     runDevice: Function,
 *   },
 *   storageReader: {
 *     readChunk: Function,
 *   },
 *   findActiveUpload: (deviceId: string) => boolean | Promise<boolean>,
 *   now?: () => Date,
 * }} options
 * @returns {Readonly<{
 *   acceptCleanup: Function,
 *   acceptReceipt: Function,
 *   cancelTask: Function,
 *   claim: Function,
 *   createTask: Function,
 *   getChunk: Function,
 *   getStatus: Function,
 *   getTask: Function,
 *   hasActiveRestore: Function,
 *   updateProgress: Function,
 * }>}
 */
export function createRestoreService(options) {
  /** @type {any} */
  let taskStore;
  /** @type {any} */
  let locks;
  /** @type {any} */
  let storageReader;
  /** @type {(deviceId: string) => boolean | Promise<boolean>} */
  let findActiveUpload;

  try {
    if (!isNonNullObject(options)) failInvalidOptions();

    const storeRaw = /** @type {{ taskStore?: unknown }} */ (options).taskStore;
    if (!isNonNullObject(storeRaw)) failInvalidOptions();
    if (
      !isFunction(/** @type {{ claimNext?: unknown }} */ (storeRaw).claimNext)
      || !isFunction(/** @type {{ get?: unknown }} */ (storeRaw).get)
      || !isFunction(/** @type {{ updateProgress?: unknown }} */ (storeRaw).updateProgress)
      || !isFunction(/** @type {{ acceptReceipt?: unknown }} */ (storeRaw).acceptReceipt)
      || !isFunction(/** @type {{ acceptCleanup?: unknown }} */ (storeRaw).acceptCleanup)
      || !isFunction(/** @type {{ create?: unknown }} */ (storeRaw).create)
      || !isFunction(/** @type {{ cancel?: unknown }} */ (storeRaw).cancel)
      || !isFunction(/** @type {{ hasActiveRestore?: unknown }} */ (storeRaw).hasActiveRestore)
      || !isFunction(
        /** @type {{ buildTaskFilesPayload?: unknown }} */ (storeRaw).buildTaskFilesPayload,
      )
    ) {
      failInvalidOptions();
    }
    taskStore = storeRaw;

    const locksRaw = /** @type {{ locks?: unknown }} */ (options).locks;
    if (!isNonNullObject(locksRaw)) failInvalidOptions();
    if (
      !isFunction(/** @type {{ runTransfer?: unknown }} */ (locksRaw).runTransfer)
      || !isFunction(/** @type {{ runDevice?: unknown }} */ (locksRaw).runDevice)
    ) {
      failInvalidOptions();
    }
    locks = locksRaw;

    const readerRaw = /** @type {{ storageReader?: unknown }} */ (options).storageReader;
    if (!isNonNullObject(readerRaw)) failInvalidOptions();
    if (!isFunction(/** @type {{ readChunk?: unknown }} */ (readerRaw).readChunk)) {
      failInvalidOptions();
    }
    storageReader = readerRaw;

    const findRaw = /** @type {{ findActiveUpload?: unknown }} */ (options).findActiveUpload;
    if (!isFunction(findRaw)) failInvalidOptions();
    findActiveUpload = /** @type {(deviceId: string) => boolean | Promise<boolean>} */ (findRaw);

    // now is optional; if present must be a function. Do not invent time behavior.
    let hasNow = false;
    try {
      hasNow = Object.prototype.hasOwnProperty.call(options, 'now');
    } catch {
      failInvalidOptions();
    }
    if (hasNow) {
      const nowRaw = /** @type {{ now?: unknown }} */ (options).now;
      if (!isFunction(nowRaw)) failInvalidOptions();
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === INVALID_SERVICE_OPTIONS) throw error;
    failInvalidOptions();
  }

  /**
   * Claim next pending restore task for a device.
   * Probe + claimNext share one runDevice critical section (no runTransfer).
   * Invalid deviceId rejected before any lock/dependency call.
   * Non-LinkeError from findActiveUpload/claimNext → RESTORE_STATE_INVALID.
   *
   * @param {{ deviceId: string }} input
   */
  async function claim(input) {
    const deviceId = input?.deviceId;
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
    }
    return locks.runDevice(deviceId, async () => {
      let active;
      try {
        active = await findActiveUpload(deviceId);
      } catch (error) {
        sanitizeClaimDependencyError(error);
      }
      if (active === true) {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_CONFLICT);
      }
      try {
        return await taskStore.claimNext({ deviceId, hasActiveUpload: false });
      } catch (error) {
        sanitizeClaimDependencyError(error);
      }
    });
  }

  /**
   * Safe task summary + files[] (with path). Does not mutate store results.
   *
   * @param {{ deviceId: string, taskId: string }} input
   */
  async function getTask(input) {
    const deviceId = input?.deviceId;
    const taskId = input?.taskId;
    const task = await taskStore.get({ deviceId, taskId });
    const filesPayload = await taskStore.buildTaskFilesPayload(deviceId, taskId);
    const out = cleanShallowCopy(task);
    let files;
    try {
      files = isNonNullObject(filesPayload)
        ? /** @type {{ files?: unknown }} */ (filesPayload).files
        : undefined;
    } catch {
      files = undefined;
    }
    if (Array.isArray(files)) {
      out.files = files.map((entry) => {
        if (!isNonNullObject(entry)) return entry;
        return Object.freeze(cleanShallowCopy(entry));
      });
      Object.freeze(out.files);
    } else {
      out.files = Object.freeze([]);
    }
    return Object.freeze(out);
  }

  /**
   * Status-only view via taskStore.get.
   *
   * @param {{ deviceId: string, taskId: string }} input
   */
  async function getStatus(input) {
    return taskStore.get({
      deviceId: input?.deviceId,
      taskId: input?.taskId,
    });
  }

  /**
   * Exact delegation: updateProgress.
   * @param {unknown} input
   */
  async function updateProgress(input) {
    return taskStore.updateProgress(input);
  }

  /**
   * Exact delegation: acceptReceipt.
   * @param {unknown} input
   */
  async function acceptReceipt(input) {
    return taskStore.acceptReceipt(input);
  }

  /**
   * Exact delegation: acceptCleanup.
   * @param {unknown} input
   */
  async function acceptCleanup(input) {
    return taskStore.acceptCleanup(input);
  }

  /**
   * Exact delegation: create (MUST NOT call findActiveUpload).
   * Pending restore may coexist with active upload.
   * @param {unknown} input
   */
  async function createTask(input) {
    return taskStore.create(input);
  }

  /**
   * Exact delegation: cancel.
   * @param {unknown} input
   */
  async function cancelTask(input) {
    return taskStore.cancel(input);
  }

  /**
   * Exact delegation: hasActiveRestore(deviceId).
   * @param {string} deviceId
   */
  async function hasActiveRestore(deviceId) {
    return taskStore.hasActiveRestore(deviceId);
  }

  /**
   * Live-binary chunk read: sole restore caller of locks.runTransfer.
   * Maps ONLY LinkeError(UPLOAD_BACKPRESSURE) → LinkeError(RESTORE_BACKPRESSURE).
   *
   * @param {{
   *   deviceId: string,
   *   taskId: string,
   *   fileIndex: number,
   *   chunkIndex: number,
   * }} input
   */
  async function getChunk(input) {
    const deviceId = input?.deviceId;
    const taskId = input?.taskId;
    const fileIndex = input?.fileIndex;
    const chunkIndex = input?.chunkIndex;

    try {
      return await locks.runTransfer(async () => {
        const raw = await storageReader.readChunk({
          deviceId,
          taskId,
          fileIndex,
          chunkIndex,
        });

        let body;
        let chunkOffset;
        let chunkSize;
        try {
          body = /** @type {{ body?: unknown }} */ (raw)?.body;
          chunkOffset = /** @type {{ chunkOffset?: unknown }} */ (raw)?.chunkOffset;
          chunkSize = /** @type {{ chunkSize?: unknown }} */ (raw)?.chunkSize;
        } catch {
          throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
        }

        if (!Buffer.isBuffer(body)) {
          throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
        }
        if (!Number.isSafeInteger(chunkOffset) || /** @type {number} */ (chunkOffset) < 0) {
          throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
        }
        if (!Number.isSafeInteger(chunkSize) || /** @type {number} */ (chunkSize) < 0) {
          throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
        }
        const contentLength = body.length;
        if (/** @type {number} */ (chunkSize) !== contentLength) {
          throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
        }

        // Trust body only: recompute SHA-256 (never raw error/path leakage).
        const chunkSha256 = createHash('sha256').update(body).digest('hex');

        return {
          body,
          headers: Object.freeze({
            contentType: 'application/octet-stream',
            contentLength,
            taskId,
            fileIndex,
            chunkIndex,
            chunkOffset,
            chunkSize,
            chunkSha256,
          }),
        };
      });
    } catch (err) {
      if (err instanceof LinkeError && err.code === ERROR_CODES.UPLOAD_BACKPRESSURE) {
        throw new LinkeError(ERROR_CODES.RESTORE_BACKPRESSURE);
      }
      throw err;
    }
  }

  return Object.freeze({
    acceptCleanup,
    acceptReceipt,
    cancelTask,
    claim,
    createTask,
    getChunk,
    getStatus,
    getTask,
    hasActiveRestore,
    updateProgress,
  });
}
