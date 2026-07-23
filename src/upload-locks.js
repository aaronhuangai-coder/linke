/**
 * G0b/G0c C5 — Process-local live-binary transfer locks / backpressure.
 * Global active-transfer semaphore (fail-fast, never queues) + keyed FIFO runners.
 * runTransfer is live binary only: G0b putChunk + G0c restore getChunk.
 * Pure domain; no HTTP routes.
 */

import { ERROR_CODES, LinkeError } from './error-codes.js';

const DEFAULT_MAX_GLOBAL = 4;
const MIN_MAX_GLOBAL = 1;
const MAX_MAX_GLOBAL = 16;
const INVALID_MAX_GLOBAL = 'invalid maxGlobalTransfers';

/**
 * @returns {never}
 */
function failMaxGlobal() {
  throw new Error(INVALID_MAX_GLOBAL);
}

/**
 * Fail-closed for hostile / non-string keys. Fixed safe LinkeError only.
 * @returns {never}
 */
function failKey() {
  throw new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function requireSafeKey(value) {
  if (typeof value !== 'string' || value.length === 0) failKey();
  return value;
}

/**
 * @param {unknown} task
 * @returns {asserts task is Function}
 */
function requireTask(task) {
  if (typeof task !== 'function') {
    throw new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR);
  }
}

/**
 * Create a keyed FIFO async runner. Same key serial; different keys concurrent.
 * Prior reject never stalls; empty tail deletes Map entry.
 *
 * @template {string | { a: string, b: string }} K
 * @param {(raw: unknown) => K} normalizeKey
 * @param {(key: K) => string} serializeKey
 * @returns {(keyParts: unknown, taskOrSecond?: unknown, maybeTask?: unknown) => Promise<unknown>}
 */
function createKeyedRunner(normalizeKey, serializeKey) {
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();

  /**
   * @param {unknown} keyInput
   * @param {() => unknown | Promise<unknown>} task
   * @returns {Promise<unknown>}
   */
  function enqueue(keyInput, task) {
    // Validate before Map touch; always return a Promise (never sync throw).
    let key;
    try {
      requireTask(task);
      key = normalizeKey(keyInput);
    } catch (error) {
      if (error instanceof LinkeError) {
        return Promise.reject(error);
      }
      return Promise.reject(new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR));
    }
    const mapKey = serializeKey(key);
    const prev = tails.get(mapKey) ?? Promise.resolve();

    // Wait for prior; ignore its rejection so the queue cannot stall.
    const run = prev.then(
      () => task(),
      () => task(),
    );

    // Tail always settles so subsequent tasks are not blocked by rejection.
    const tail = run.then(
      () => {},
      () => {},
    );
    tails.set(mapKey, tail);

    void tail.then(() => {
      // Single-threaded: check + delete is atomic w.r.t. other JS turns.
      if (tails.get(mapKey) === tail) {
        tails.delete(mapKey);
      }
    });

    return run;
  }

  return enqueue;
}

/**
 * Process-local live-binary transfer lock factory.
 * Global semaphore (runTransfer) covers only live binary: putChunk + restore getChunk.
 * Default maxGlobalTransfers=4; valid range 1..16; fail-fast (no queue) when full.
 *
 * @param {{ maxGlobalTransfers?: number }} [options]
 * @returns {Readonly<{
 *   maxGlobalTransfers: number,
 *   runTransfer: (task: () => unknown) => Promise<unknown>,
 *   runDevice: (deviceId: string, task: () => unknown) => Promise<unknown>,
 *   runSession: (deviceId: string, uploadId: string, task: () => unknown) => Promise<unknown>,
 *   runSnapshot: (deviceId: string, snapshotId: string, task: () => unknown) => Promise<unknown>,
 * }>}
 */
export function createUploadLocks(options) {
  let maxGlobalTransfers = DEFAULT_MAX_GLOBAL;

  if (options === undefined) {
    // Default options path.
  } else if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    // Non-object options: fail-closed (not silent default).
    failMaxGlobal();
  } else {
    // Own-key path only; missing key uses default. Own undefined is invalid.
    let hasOwn = false;
    try {
      hasOwn = Object.prototype.hasOwnProperty.call(options, 'maxGlobalTransfers');
    } catch {
      failMaxGlobal();
    }
    if (hasOwn) {
      /** @type {unknown} */
      let raw;
      try {
        raw = /** @type {{ maxGlobalTransfers?: unknown }} */ (options).maxGlobalTransfers;
      } catch {
        failMaxGlobal();
      }
      if (
        typeof raw !== 'number'
        || !Number.isInteger(raw)
        || raw < MIN_MAX_GLOBAL
        || raw > MAX_MAX_GLOBAL
      ) {
        failMaxGlobal();
      }
      maxGlobalTransfers = raw;
    }
  }

  let activeTransfers = 0;

  /**
   * Global live-binary transfer semaphore (G0b putChunk + G0c getChunk only).
   * Acquires immediately or rejects with upload-backpressure (never queues).
   * Releases in finally for all outcomes (success / sync throw / async reject).
   * Non-binary paths (create/status/finalize/abort/claim/progress/receipt) must not call this.
   *
   * @param {() => unknown} task
   * @returns {Promise<unknown>}
   */
  async function runTransfer(task) {
    requireTask(task);
    if (activeTransfers >= maxGlobalTransfers) {
      throw new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE);
    }
    activeTransfers += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeTransfers -= 1;
    };
    try {
      // await coerces thenables; finally always runs once.
      return await task();
    } finally {
      release();
    }
  }

  const deviceRunner = createKeyedRunner(
    (deviceId) => requireSafeKey(deviceId),
    (k) => k,
  );

  /**
   * Collision-safe tuple key (never naive string concat of parts).
   * @param {string} a
   * @param {string} b
   */
  function tupleSerialize(a, b) {
    // Length-prefixed + JSON string forms — no 'a'+'bc' vs 'ab'+'c' collision.
    return `${a.length}:${JSON.stringify(a)}\0${b.length}:${JSON.stringify(b)}`;
  }

  const sessionRunner = createKeyedRunner(
    (parts) => {
      const deviceId = requireSafeKey(/** @type {{ deviceId?: unknown }} */ (parts).deviceId);
      const uploadId = requireSafeKey(/** @type {{ uploadId?: unknown }} */ (parts).uploadId);
      return { a: deviceId, b: uploadId };
    },
    (k) => tupleSerialize(k.a, k.b),
  );

  const snapshotRunner = createKeyedRunner(
    (parts) => {
      const deviceId = requireSafeKey(/** @type {{ deviceId?: unknown }} */ (parts).deviceId);
      const snapshotId = requireSafeKey(/** @type {{ snapshotId?: unknown }} */ (parts).snapshotId);
      return { a: deviceId, b: snapshotId };
    },
    (k) => tupleSerialize(k.a, k.b),
  );

  /**
   * @param {string} deviceId
   * @param {() => unknown} task
   */
  function runDevice(deviceId, task) {
    return deviceRunner(deviceId, task);
  }

  /**
   * @param {string} deviceId
   * @param {string} uploadId
   * @param {() => unknown} task
   */
  function runSession(deviceId, uploadId, task) {
    // Key validation lives in runner.enqueue (Promise-reject, Map-untouched).
    return sessionRunner({ deviceId, uploadId }, task);
  }

  /**
   * @param {string} deviceId
   * @param {string} snapshotId
   * @param {() => unknown} task
   */
  function runSnapshot(deviceId, snapshotId, task) {
    return snapshotRunner({ deviceId, snapshotId }, task);
  }

  return Object.freeze({
    maxGlobalTransfers,
    runTransfer,
    runDevice,
    runSession,
    runSnapshot,
  });
}
