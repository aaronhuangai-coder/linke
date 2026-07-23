/**
 * G0c C2 — Snapshot reader adapter for restore task store.
 * storage.getSnapshotManifest → assertSnapshotReadable (TASK metadata).
 * No direct I/O beyond injected/default getSnapshotManifestFn.
 * Fail-closed: adapter boundary → LinkeError(RESTORE_INTEGRITY_FAILED) only.
 */

import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertSnapshotRootRelativeFilePath } from './restore-path.js';
import { getSnapshotManifest } from './storage.js';
import { projectCanonicalUploadManifest } from './upload-manifest.js';

/** Fixed restore chunk size: 8 MiB (design §7.2 / §8.5). */
export const RESTORE_CHUNK_SIZE_BYTES = 8_388_608;

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const ENTRY_KEYS = Object.freeze(['path', 'size', 'sha256']);

/**
 * @returns {never}
 */
function failIntegrity() {
  throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED);
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Dense array via own data descriptors; holes/getters rejected.
 * @param {unknown} value
 * @returns {unknown[] | null}
 */
function readDenseArrayDescriptorValues(value) {
  try {
    if (!Array.isArray(value)) return null;
    const lengthDesc = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDesc || lengthDesc.get !== undefined || lengthDesc.set !== undefined) {
      return null;
    }
    const length = lengthDesc.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      return null;
    }
    /** @type {unknown[]} */
    const out = [];
    for (let i = 0; i < length; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(value, String(i));
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out.push(desc.value);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Deep-freeze plain object / array trees.
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
 * @param {unknown} entryRaw
 * @returns {{ path: string, size: number, sha256: string }}
 */
function readExactEntry(entryRaw) {
  if (!isPlainRecord(entryRaw)) failIntegrity();
  const record = /** @type {Record<string, unknown>} */ (entryRaw);
  const keys = Object.keys(record);
  if (keys.length !== ENTRY_KEYS.length) failIntegrity();
  for (const key of ENTRY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) failIntegrity();
  }
  for (const key of keys) {
    if (!ENTRY_KEYS.includes(key)) failIntegrity();
  }

  const pathRaw = record.path;
  let path;
  try {
    path = assertSnapshotRootRelativeFilePath(pathRaw);
  } catch {
    failIntegrity();
  }

  const size = record.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    failIntegrity();
  }

  const sha256 = record.sha256;
  if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256)) {
    failIntegrity();
  }

  return { path, size, sha256 };
}

/**
 * Pre-validate raw manifest shape shared by remote-upload canonical and local schemaVersion 2.
 * @param {unknown} raw
 * @param {string} snapshotId
 * @returns {{
 *   createdAt: unknown,
 *   files: string[],
 *   totalBytes: number,
 *   entries: { path: string, size: number, sha256: string }[],
 *   hostname?: string,
 *   sourcePath?: string,
 * }}
 */
function extractValidatedShape(raw, snapshotId) {
  if (!isPlainRecord(raw)) failIntegrity();
  const record = /** @type {Record<string, unknown>} */ (raw);

  if (record.snapshotId !== snapshotId) failIntegrity();

  const filesRaw = readDenseArrayDescriptorValues(record.files);
  if (!filesRaw) failIntegrity();
  /** @type {string[]} */
  const files = [];
  for (let i = 0; i < filesRaw.length; i += 1) {
    if (typeof filesRaw[i] !== 'string') failIntegrity();
    files.push(/** @type {string} */ (filesRaw[i]));
  }

  if (!isPlainRecord(record.integrity)) failIntegrity();
  const integrity = /** @type {Record<string, unknown>} */ (record.integrity);
  if (integrity.algorithm !== 'sha256') failIntegrity();

  const totalBytes = integrity.totalBytes;
  if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes)) {
    failIntegrity();
  }

  const entriesRaw = readDenseArrayDescriptorValues(integrity.entries);
  if (!entriesRaw) failIntegrity();
  if (entriesRaw.length !== files.length) failIntegrity();

  /** @type {{ path: string, size: number, sha256: string }[]} */
  const entries = [];
  let sizeSum = 0;
  for (let i = 0; i < entriesRaw.length; i += 1) {
    const entry = readExactEntry(entriesRaw[i]);
    const next = sizeSum + entry.size;
    if (!Number.isSafeInteger(next)) failIntegrity();
    sizeSum = next;
    entries.push(entry);
  }
  if (totalBytes !== sizeSum) failIntegrity();

  /** @type {{
   *   createdAt: unknown,
   *   files: string[],
   *   totalBytes: number,
   *   entries: { path: string, size: number, sha256: string }[],
   *   hostname?: string,
   *   sourcePath?: string,
   * }} */
  const out = {
    createdAt: record.createdAt,
    files,
    totalBytes,
    entries,
  };

  if (
    Object.prototype.hasOwnProperty.call(record, 'hostname')
    && typeof record.hostname === 'string'
  ) {
    out.hostname = record.hostname;
  }
  if (
    Object.prototype.hasOwnProperty.call(record, 'sourcePath')
    && typeof record.sourcePath === 'string'
  ) {
    out.sourcePath = record.sourcePath;
  }

  return out;
}

/**
 * Build exact clean projector input (plan C2 step 4). Never copies ipAddress / slug / unknown keys.
 * @param {ReturnType<typeof extractValidatedShape>} shape
 * @param {string} deviceId
 * @param {string} snapshotId
 * @returns {Record<string, unknown>}
 */
function buildCleanProjectorInput(shape, deviceId, snapshotId) {
  /** @type {Record<string, unknown>} */
  const clean = {
    schemaVersion: 2,
    snapshotId,
    deviceId,
    createdAt: shape.createdAt,
    files: shape.files,
    integrity: {
      algorithm: 'sha256',
      totalBytes: shape.totalBytes,
      entries: shape.entries.map((e) => ({
        path: e.path,
        size: e.size,
        sha256: e.sha256,
      })),
    },
  };
  if (shape.hostname !== undefined) clean.hostname = shape.hostname;
  if (shape.sourcePath !== undefined) clean.sourcePath = shape.sourcePath;
  return clean;
}

/**
 * Production adapter: storage.getSnapshotManifest → task-store storageReader.
 * @param {{
 *   dataDir: string,
 *   getSnapshotManifestFn?: typeof getSnapshotManifest,
 *   projectCanonicalUploadManifestFn?: typeof projectCanonicalUploadManifest,
 * }} options
 * @returns {Readonly<{
 *   assertSnapshotReadable: (deviceId: string, snapshotId: string) => Promise<{
 *     manifestDigest: string,
 *     fileCount: number,
 *     totalBytes: number,
 *     files: ReadonlyArray<{
 *       fileIndex: number,
 *       path: string,
 *       size: number,
 *       sha256: string,
 *       chunkCount: number,
 *     }>,
 *   }>,
 * }>}
 */
export function createRestoreSnapshotReader(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createRestoreSnapshotReader options required');
  }

  const dataDir = /** @type {{ dataDir?: unknown }} */ (options).dataDir;
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('dataDir required');
  }

  const getRaw = /** @type {{ getSnapshotManifestFn?: unknown }} */ (options)
    .getSnapshotManifestFn;
  const getSnapshotManifestFn =
    getRaw === undefined ? getSnapshotManifest : getRaw;
  if (typeof getSnapshotManifestFn !== 'function') {
    throw new TypeError('getSnapshotManifestFn must be a function');
  }

  const projectRaw = /** @type {{ projectCanonicalUploadManifestFn?: unknown }} */ (
    options
  ).projectCanonicalUploadManifestFn;
  const projectCanonicalUploadManifestFn =
    projectRaw === undefined ? projectCanonicalUploadManifest : projectRaw;
  if (typeof projectCanonicalUploadManifestFn !== 'function') {
    throw new TypeError('projectCanonicalUploadManifestFn must be a function');
  }

  /**
   * @param {string} deviceId
   * @param {string} snapshotId
   */
  async function assertSnapshotReadable(deviceId, snapshotId) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) failIntegrity();
    if (typeof snapshotId !== 'string' || snapshotId.length === 0) failIntegrity();

    let raw;
    try {
      raw = await getSnapshotManifestFn(dataDir, deviceId, snapshotId);
    } catch {
      failIntegrity();
    }

    let shape;
    try {
      shape = extractValidatedShape(raw, snapshotId);
    } catch (error) {
      if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED) {
        throw error;
      }
      failIntegrity();
    }

    const clean = buildCleanProjectorInput(shape, deviceId, snapshotId);

    let projected;
    try {
      projected = projectCanonicalUploadManifestFn(clean, {
        authenticatedDeviceId: deviceId,
      });
    } catch {
      failIntegrity();
    }

    if (
      !projected
      || typeof projected !== 'object'
      || Array.isArray(projected)
      || typeof projected.manifestDigest !== 'string'
      || !projected.manifest
      || typeof projected.manifest !== 'object'
    ) {
      failIntegrity();
    }

    const manifest = /** @type {Record<string, unknown>} */ (projected.manifest);
    const integrity = manifest.integrity;
    if (!isPlainRecord(integrity)) failIntegrity();
    const integrityRec = /** @type {Record<string, unknown>} */ (integrity);
    const projectedEntries = integrityRec.entries;
    if (!Array.isArray(projectedEntries)) failIntegrity();

    const totalBytes = integrityRec.totalBytes;
    if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes)) {
      failIntegrity();
    }

    /** @type {{ fileIndex: number, path: string, size: number, sha256: string, chunkCount: number }[]} */
    const files = [];
    for (let i = 0; i < projectedEntries.length; i += 1) {
      const entry = projectedEntries[i];
      if (!isPlainRecord(entry)) failIntegrity();
      const e = /** @type {Record<string, unknown>} */ (entry);
      if (typeof e.path !== 'string') failIntegrity();
      if (typeof e.size !== 'number' || !Number.isSafeInteger(e.size) || e.size < 0) {
        failIntegrity();
      }
      if (typeof e.sha256 !== 'string' || !SHA256_HEX_RE.test(e.sha256)) {
        failIntegrity();
      }
      const size = /** @type {number} */ (e.size);
      files.push({
        fileIndex: i,
        path: /** @type {string} */ (e.path),
        size,
        sha256: /** @type {string} */ (e.sha256),
        chunkCount: size === 0 ? 0 : Math.ceil(size / RESTORE_CHUNK_SIZE_BYTES),
      });
    }

    const result = {
      manifestDigest: /** @type {string} */ (projected.manifestDigest),
      fileCount: files.length,
      totalBytes,
      files,
    };
    return deepFreeze(result);
  }

  return Object.freeze({
    assertSnapshotReadable,
  });
}
