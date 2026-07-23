/**
 * G0c C5.5 — Bounded real snapshot chunk reader for restore.
 * resolveChunkRead (task store) → assertSnapshotReadable recheck → no-follow open
 * → dual fstat on same fd → exact range read → close. No HTTP. No path/errno leak.
 * Does not full-file hash per chunk.
 */

import { types as utilTypes } from 'node:util';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { openSafeRootRelativeRead } from './safe-data-files.js';
import { safeDevicePath } from './storage.js';

/** Fixed restore chunk size: 8 MiB (design §C5.5 / RESTORE_CHUNK_SIZE). */
const RESTORE_CHUNK_SIZE = 8_388_608;

/** Only these codes pass through exactly from resolveChunkRead. */
const RESOLVE_PASSTHROUGH_CODES = new Set([
  ERROR_CODES.RESTORE_TASK_INVALID,
  ERROR_CODES.RESTORE_TASK_NOT_FOUND,
  ERROR_CODES.RESTORE_TASK_CONFLICT,
]);

/**
 * @returns {never}
 */
function failIntegrity() {
  throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED);
}

/**
 * Plain data bag only. isProxy first so hostile traps never fire; getPrototypeOf
 * is try/caught so trap throw becomes false rather than a raw leak.
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
 * Post-resolve / I/O boundary: preserve only existing integrity LinkeError;
 * never pass task/path/state or raw errors. Always throws a new integrity
 * LinkeError for everything else.
 * @param {unknown} error
 * @returns {never}
 */
function mapToIntegrity(error) {
  if (
    error instanceof LinkeError
    && error.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
  ) {
    throw error;
  }
  failIntegrity();
}

/**
 * resolveChunkRead boundary: exact pass-through only for the three task-domain
 * codes; PATH_INVALID / STATE_INVALID / other LinkeError / any error → new integrity.
 * @param {unknown} error
 * @returns {never}
 */
function mapResolveError(error) {
  if (
    error instanceof LinkeError
    && RESOLVE_PASSTHROUGH_CODES.has(error.code)
  ) {
    throw error;
  }
  failIntegrity();
}

/**
 * Production restore chunk reader factory.
 * @param {{
 *   dataDir: string,
 *   taskStore: { resolveChunkRead: Function },
 *   snapshotReader: { assertSnapshotReadable: Function },
 *   openSafeRootRelativeReadFn?: typeof openSafeRootRelativeRead,
 *   safeDevicePathFn?: typeof safeDevicePath,
 * }} options
 * @returns {Readonly<{ readChunk: Function }>}
 */
export function createRestoreChunkReader(options) {
  // Factory input defense: hostile Proxy / getPrototypeOf must become fixed TypeError.
  let optionsOk = false;
  try {
    optionsOk = isPlainRecord(options);
  } catch {
    optionsOk = false;
  }
  if (!optionsOk) {
    throw new TypeError('createRestoreChunkReader options required');
  }

  const dataDir = /** @type {{ dataDir?: unknown }} */ (options).dataDir;
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('dataDir required');
  }

  const taskStore = /** @type {{ taskStore?: unknown }} */ (options).taskStore;
  let taskStoreOk = false;
  try {
    taskStoreOk = isPlainRecord(taskStore);
  } catch {
    taskStoreOk = false;
  }
  if (!taskStoreOk) {
    throw new TypeError('taskStore required');
  }
  let resolveChunkRead;
  try {
    const desc = Object.getOwnPropertyDescriptor(taskStore, 'resolveChunkRead');
    if (!desc || desc.get !== undefined || desc.set !== undefined) {
      throw new TypeError('taskStore.resolveChunkRead required');
    }
    if (typeof desc.value !== 'function') {
      throw new TypeError('taskStore.resolveChunkRead required');
    }
    resolveChunkRead = desc.value.bind(taskStore);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('taskStore.resolveChunkRead required');
  }

  const snapshotReader = /** @type {{ snapshotReader?: unknown }} */ (options)
    .snapshotReader;
  let snapshotReaderOk = false;
  try {
    snapshotReaderOk = isPlainRecord(snapshotReader);
  } catch {
    snapshotReaderOk = false;
  }
  if (!snapshotReaderOk) {
    throw new TypeError('snapshotReader required');
  }
  let assertSnapshotReadable;
  try {
    const desc = Object.getOwnPropertyDescriptor(
      snapshotReader,
      'assertSnapshotReadable',
    );
    if (!desc || desc.get !== undefined || desc.set !== undefined) {
      throw new TypeError('snapshotReader.assertSnapshotReadable required');
    }
    if (typeof desc.value !== 'function') {
      throw new TypeError('snapshotReader.assertSnapshotReadable required');
    }
    assertSnapshotReadable = desc.value.bind(snapshotReader);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('snapshotReader.assertSnapshotReadable required');
  }

  const openRaw = /** @type {{ openSafeRootRelativeReadFn?: unknown }} */ (options)
    .openSafeRootRelativeReadFn;
  const openFn =
    openRaw === undefined ? openSafeRootRelativeRead : openRaw;
  if (typeof openFn !== 'function') {
    throw new TypeError('openSafeRootRelativeReadFn must be a function');
  }

  const safePathRaw = /** @type {{ safeDevicePathFn?: unknown }} */ (options)
    .safeDevicePathFn;
  const safeDevicePathFn =
    safePathRaw === undefined ? safeDevicePath : safePathRaw;
  if (typeof safeDevicePathFn !== 'function') {
    throw new TypeError('safeDevicePathFn must be a function');
  }

  /**
   * Extract + validate resolveChunkRead descriptor under a single protected boundary.
   * Hostile Proxy traps → integrity; never open.
   * @param {unknown} descriptor
   * @returns {{
   *   deviceId: string,
   *   snapshotId: string,
   *   manifestDigest: string,
   *   fileIndex: number,
   *   path: string,
   *   fileSize: number,
   *   fileSha256: string,
   *   chunkCount: number,
   *   chunkOffset: number,
   *   chunkSize: number,
   * }}
   */
  function extractDescriptor(descriptor) {
    try {
      if (!isPlainRecord(descriptor)) failIntegrity();
      const d = /** @type {Record<string, unknown>} */ (descriptor);

      const deviceId = d.deviceId;
      const snapshotId = d.snapshotId;
      const manifestDigest = d.manifestDigest;
      const fileIndex = d.fileIndex;
      const path = d.path;
      const fileSize = d.fileSize;
      const fileSha256 = d.fileSha256;
      const chunkCount = d.chunkCount;
      const chunkOffset = d.chunkOffset;
      const chunkSize = d.chunkSize;

      if (typeof deviceId !== 'string' || deviceId.length === 0) failIntegrity();
      if (typeof snapshotId !== 'string' || snapshotId.length === 0) failIntegrity();
      if (typeof manifestDigest !== 'string' || manifestDigest.length === 0) {
        failIntegrity();
      }
      if (
        typeof fileIndex !== 'number'
        || !Number.isSafeInteger(fileIndex)
        || fileIndex < 0
      ) {
        failIntegrity();
      }
      if (typeof path !== 'string' || path.length === 0) failIntegrity();
      if (
        typeof fileSize !== 'number'
        || !Number.isSafeInteger(fileSize)
        || fileSize < 0
      ) {
        failIntegrity();
      }
      if (typeof fileSha256 !== 'string' || fileSha256.length === 0) failIntegrity();
      if (
        typeof chunkCount !== 'number'
        || !Number.isSafeInteger(chunkCount)
        || chunkCount < 0
      ) {
        failIntegrity();
      }
      if (
        typeof chunkOffset !== 'number'
        || !Number.isSafeInteger(chunkOffset)
        || chunkOffset < 0
      ) {
        failIntegrity();
      }
      if (
        typeof chunkSize !== 'number'
        || !Number.isSafeInteger(chunkSize)
        || chunkSize < 1
        || chunkSize > RESTORE_CHUNK_SIZE
      ) {
        failIntegrity();
      }

      return {
        deviceId: /** @type {string} */ (deviceId),
        snapshotId: /** @type {string} */ (snapshotId),
        manifestDigest: /** @type {string} */ (manifestDigest),
        fileIndex: /** @type {number} */ (fileIndex),
        path: /** @type {string} */ (path),
        fileSize: /** @type {number} */ (fileSize),
        fileSha256: /** @type {string} */ (fileSha256),
        chunkCount: /** @type {number} */ (chunkCount),
        chunkOffset: /** @type {number} */ (chunkOffset),
        chunkSize: /** @type {number} */ (chunkSize),
      };
    } catch (error) {
      mapToIntegrity(error);
    }
  }

  /**
   * Authoritative readable + entry recheck under a single protected boundary.
   * Hostile Proxy on readable/files/entry → integrity; never open.
   * @param {unknown} readable
   * @param {{
   *   manifestDigest: string,
   *   fileIndex: number,
   *   path: string,
   *   fileSize: number,
   *   fileSha256: string,
   *   chunkCount: number,
   * }} expected
   */
  function recheckReadable(readable, expected) {
    try {
      if (!isPlainRecord(readable)) failIntegrity();
      const r = /** @type {Record<string, unknown>} */ (readable);
      if (r.manifestDigest !== expected.manifestDigest) failIntegrity();

      const filesRaw = r.files;
      // Array target Proxy would pass Array.isArray; reject Proxy before index/get.
      let filesIsProxy = false;
      try {
        filesIsProxy = utilTypes.isProxy(filesRaw);
      } catch {
        failIntegrity();
      }
      if (filesIsProxy || !Array.isArray(filesRaw)) failIntegrity();
      const files = /** @type {unknown[]} */ (filesRaw);
      if (expected.fileIndex >= files.length) failIntegrity();

      const entry = files[expected.fileIndex];
      if (!isPlainRecord(entry)) failIntegrity();
      const e = /** @type {Record<string, unknown>} */ (entry);
      if (e.fileIndex !== expected.fileIndex) failIntegrity();
      if (e.path !== expected.path) failIntegrity();
      if (e.size !== expected.fileSize) failIntegrity();
      if (e.sha256 !== expected.fileSha256) failIntegrity();
      if (e.chunkCount !== expected.chunkCount) failIntegrity();
    } catch (error) {
      mapToIntegrity(error);
    }
  }

  /**
   * @param {unknown} input
   * @returns {Promise<{ body: Buffer, chunkOffset: number, chunkSize: number }>}
   */
  async function readChunk(input) {
    // 1) Task-store descriptor: only TASK_INVALID / NOT_FOUND / CONFLICT exact pass-through.
    let descriptor;
    try {
      descriptor = await resolveChunkRead(input);
    } catch (error) {
      mapResolveError(error);
    }

    const d = extractDescriptor(descriptor);

    // 2–3) Authoritative manifest recheck; drift / traps → integrity-failed, never open.
    let readable;
    try {
      readable = await assertSnapshotReadable(d.deviceId, d.snapshotId);
    } catch (error) {
      // After resolve: never pass task/path/state; only existing integrity may stay.
      mapToIntegrity(error);
    }
    recheckReadable(readable, d);

    // 4) Controller-internal relative path (never in response/errors/logs).
    let relativePath;
    try {
      const scope = safeDevicePathFn(dataDir, d.deviceId);
      if (!isPlainRecord(scope) || typeof scope.deviceRel !== 'string') {
        failIntegrity();
      }
      relativePath = `${scope.deviceRel}/snapshots/${d.snapshotId}/files/${d.path}`;
    } catch (error) {
      mapToIntegrity(error);
    }

    // 5–9) Open → dual fstat → exact range read → close on all paths.
    /** @type {{ handle: import('node:fs/promises').FileHandle, size?: number } | null} */
    let opened = null;
    try {
      try {
        opened = await openFn(dataDir, relativePath);
      } catch (error) {
        // Including bare ENOENT from openSafeRootRelativeRead — never rethrow raw.
        mapToIntegrity(error);
      }

      if (!opened || !opened.handle || typeof opened.handle.stat !== 'function') {
        failIntegrity();
      }
      const handle = opened.handle;

      // First fstat on same fd: regular file, size ≡ manifest fileSize; capture identity.
      let firstStat;
      try {
        firstStat = await handle.stat();
      } catch (error) {
        mapToIntegrity(error);
      }

      if (
        !firstStat
        || typeof firstStat.isFile !== 'function'
        || !firstStat.isFile()
      ) {
        failIntegrity();
      }
      if (
        typeof firstStat.isSymbolicLink === 'function'
        && firstStat.isSymbolicLink()
      ) {
        failIntegrity();
      }
      if (firstStat.size !== d.fileSize) failIntegrity();

      const identity = {
        dev: firstStat.dev,
        ino: firstStat.ino,
        size: firstStat.size,
        mode: firstStat.mode,
      };
      if (
        typeof identity.dev !== 'number'
        || typeof identity.ino !== 'number'
        || typeof identity.size !== 'number'
        || typeof identity.mode !== 'number'
      ) {
        failIntegrity();
      }

      // Allocate only the exact requested chunk (≤ 8 MiB). No full-file buffer.
      const body = Buffer.alloc(d.chunkSize);
      let filled = 0;
      while (filled < d.chunkSize) {
        const need = d.chunkSize - filled;
        let bytesRead;
        try {
          const result = await handle.read(
            body,
            filled,
            need,
            d.chunkOffset + filled,
          );
          bytesRead = result && result.bytesRead;
        } catch (error) {
          mapToIntegrity(error);
        }
        if (
          typeof bytesRead !== 'number'
          || !Number.isSafeInteger(bytesRead)
          || bytesRead <= 0
        ) {
          // Early EOF / zero read before complete.
          failIntegrity();
        }
        if (bytesRead > need) {
          // Over-read: more bytes than remaining request window.
          failIntegrity();
        }
        filled += bytesRead;
      }

      // Second fstat: type/dev/ino/size/mode must be unchanged.
      let secondStat;
      try {
        secondStat = await handle.stat();
      } catch (error) {
        mapToIntegrity(error);
      }
      if (
        !secondStat
        || typeof secondStat.isFile !== 'function'
        || !secondStat.isFile()
      ) {
        failIntegrity();
      }
      if (
        typeof secondStat.isSymbolicLink === 'function'
        && secondStat.isSymbolicLink()
      ) {
        failIntegrity();
      }
      if (
        secondStat.dev !== identity.dev
        || secondStat.ino !== identity.ino
        || secondStat.size !== identity.size
        || secondStat.mode !== identity.mode
      ) {
        failIntegrity();
      }

      return Object.freeze({
        body,
        chunkOffset: d.chunkOffset,
        chunkSize: d.chunkSize,
      });
    } catch (error) {
      mapToIntegrity(error);
    } finally {
      if (opened && opened.handle && typeof opened.handle.close === 'function') {
        try {
          await opened.handle.close();
        } catch {
          // Close failures must not leak or mask the primary outcome.
        }
      }
    }
  }

  return Object.freeze({
    readChunk,
  });
}
