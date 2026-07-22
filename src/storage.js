import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, copyFile, lstat, realpath, open } from 'node:fs/promises';
import { join, resolve, basename, relative, dirname, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import {
  SafeDataFileError,
  assertSafeExistingRelativeDir,
  collectSafeRelativeFiles,
  ensureSafeRelativeDir,
  openSafeRootRelativeRead,
  safeAtomicWriteText,
  safeCopyFileFromAbsoluteSource,
  safeHashFileSha256,
  safeReadText,
} from './safe-data-files.js';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import {
  projectCanonicalUploadManifest,
  UPLOAD_MANIFEST_LIMITS,
} from './upload-manifest.js';

/** Remote-upload origin token forced on G0b commit index rows. */
const REMOTE_UPLOAD_ORIGIN = 'remote-upload';
const REMOTE_DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_REMOTE_MARKER_BYTES = 64 * 1024;
const MAX_REMOTE_MANIFEST_BYTES = UPLOAD_MANIFEST_LIMITS.MAX_MANIFEST_JSON_UTF8_BYTES;

// ── Slug & Safety ──────────────────────────────────────────────────

export function slugify(id) {
  const raw = String(id)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_');
  // Guard: purely-dots or empty would resolve as path traversal (./../..)
  if (!raw || /^\.+$/.test(raw)) return '_';
  return raw;
}

export function safeDevicePath(dataDir, deviceId) {
  const slug = slugify(deviceId);
  const full = resolve(join(dataDir, 'repo', 'devices', slug));
  const devicesBase = resolve(join(dataDir, 'repo', 'devices'));
  if (!full.startsWith(devicesBase + '/')) {
    throw new Error(`Invalid deviceId: ${deviceId}`);
  }
  return {
    slug,
    deviceDir: full,
    deviceRel: `repo/devices/${slug}`,
  };
}

function storageIoError() {
  return new SafeDataFileError();
}

// ── Atomic helpers ─────────────────────────────────────────────────

/**
 * Atomically write JSON. Two-arg form remains path-based for public/test compatibility.
 * Prefer { root, relativePath } for dataDir-relative no-follow writes.
 * @param {string} filePath
 * @param {unknown} data
 * @param {{ root?: string, relativePath?: string }} [options]
 */
export async function atomicWriteJSON(filePath, data, options = {}) {
  const payload = JSON.stringify(data, null, 2);
  if (options && options.root != null && options.relativePath != null) {
    try {
      await safeAtomicWriteText(options.root, options.relativePath, payload, { mode: 0o600 });
    } catch (error) {
      if (error instanceof SafeDataFileError) throw error;
      throw storageIoError();
    }
    return;
  }
  const dir = resolve(filePath, '..');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  await writeFile(tmp, payload, 'utf-8');
  await rename(tmp, filePath);
}

/**
 * Read JSON. Two-arg form remains path-based for public/test compatibility.
 * Prefer { root, relativePath } for dataDir-relative no-follow reads.
 * @param {string} filePath
 * @param {{ root?: string, relativePath?: string }} [options]
 */
export async function readJSON(filePath, options = {}) {
  try {
    let raw;
    if (options && options.root != null && options.relativePath != null) {
      try {
        raw = await safeReadText(options.root, options.relativePath);
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        if (error instanceof SafeDataFileError) throw error;
        throw storageIoError();
      }
    } else {
      raw = await readFile(filePath, 'utf-8');
    }
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    if (err instanceof SafeDataFileError) throw err;
    if (options && options.root != null) throw storageIoError();
    throw err;
  }
}

async function atomicWriteJSONUnderRoot(root, relativePath, data) {
  await atomicWriteJSON(join(root, relativePath), data, { root, relativePath });
}

async function readJSONUnderRoot(root, relativePath) {
  return readJSON(join(root, relativePath), { root, relativePath });
}

// ── Directory helpers ──────────────────────────────────────────────

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function ensureRepoDir(dataDir, relativeDir) {
  try {
    return await ensureSafeRelativeDir(dataDir, relativeDir);
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    throw storageIoError();
  }
}

export class RestoreTargetError extends Error {
  constructor() {
    super('Restore target path is not allowed');
    this.statusCode = 400;
  }
}

function isPathInsideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

async function ensureDirInsideRestoreRoot(dir, restoreRoot) {
  const root = resolve(restoreRoot);
  const targetDir = resolve(dir);
  if (!isPathInsideRoot(root, targetDir)) throw new RestoreTargetError();

  const rel = relative(root, targetDir);
  let current = root;
  for (const part of rel ? rel.split('/') : []) {
    if (!part) continue;
    current = join(current, part);
    let entry;
    try {
      entry = await lstat(current);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      try {
        await mkdir(current);
      } catch (mkdirErr) {
        if (mkdirErr.code !== 'EEXIST') throw mkdirErr;
      }
      try {
        entry = await lstat(current);
      } catch (lstatErr) {
        if (lstatErr.code === 'ENOENT') throw new RestoreTargetError();
        throw lstatErr;
      }
    }

    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new RestoreTargetError();
    const realCurrent = await realpath(current);
    if (!isPathInsideRoot(root, realCurrent)) throw new RestoreTargetError();
  }
}

async function copyFileNoFollow(src, dest) {
  let sourceHandle;
  let targetHandle;
  try {
    // Destination restore path: never follow leaf symlinks (O_NOFOLLOW).
    // Source may be absolute restore-root-local or caller-validated; open read-only.
    sourceHandle = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new RestoreTargetError();
    targetHandle = await open(
      dest,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o666,
    );
    const destStat = await targetHandle.stat();
    if (!destStat.isFile() || destStat.isSymbolicLink()) throw new RestoreTargetError();
    await pipeline(sourceHandle.createReadStream(), targetHandle.createWriteStream());
  } catch (err) {
    if (err instanceof RestoreTargetError) throw err;
    if (err && (err.code === 'ELOOP' || err.code === 'EISDIR')) throw new RestoreTargetError();
    if (err instanceof SafeDataFileError) throw err;
    throw err;
  } finally {
    await Promise.allSettled([
      sourceHandle?.close(),
      targetHandle?.close(),
    ]);
  }
}

/**
 * Copy one root-relative snapshot file into a restore destination with no-follow on both ends.
 * @param {string} dataDir
 * @param {string} relativeSource
 * @param {string} dest
 * @param {{ restoreRoot?: string }} [options]
 */
async function copyRootRelativeFileToDest(dataDir, relativeSource, dest, options = {}) {
  if (options.restoreRoot) {
    await ensureDirInsideRestoreRoot(dirname(dest), options.restoreRoot);
  } else {
    await ensureDir(dirname(dest));
  }
  try {
    const entry = await lstat(dest);
    if (entry.isSymbolicLink() || entry.isDirectory()) throw new RestoreTargetError();
  } catch (err) {
    if (err instanceof RestoreTargetError) throw err;
    if (!err || err.code !== 'ENOENT') throw err;
  }

  let source;
  let targetHandle;
  try {
    source = await openSafeRootRelativeRead(dataDir, relativeSource);
    targetHandle = await open(
      dest,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o666,
    );
    const destStat = await targetHandle.stat();
    if (!destStat.isFile() || destStat.isSymbolicLink()) throw new RestoreTargetError();

    const chunkSize = 1024 * 1024;
    let offset = 0;
    const size = source.size;
    while (offset < size) {
      const toRead = Math.min(chunkSize, size - offset);
      const buf = Buffer.alloc(toRead);
      let filled = 0;
      while (filled < toRead) {
        const { bytesRead } = await source.handle.read(buf, filled, toRead - filled, offset + filled);
        if (bytesRead === 0) throw storageIoError();
        filled += bytesRead;
      }
      await targetHandle.write(buf, 0, toRead, offset);
      offset += toRead;
    }
  } catch (err) {
    if (err instanceof RestoreTargetError || err instanceof SafeDataFileError) throw err;
    if (err && (err.code === 'ELOOP' || err.code === 'EISDIR')) throw new RestoreTargetError();
    throw storageIoError();
  } finally {
    await Promise.allSettled([
      source?.handle?.close(),
      targetHandle?.close(),
    ]);
  }
}

async function copyFileSafe(src, dest, options = {}) {
  const restoreRoot = options.restoreRoot;
  if (options.dataRoot && options.relativeDest) {
    try {
      await safeCopyFileFromAbsoluteSource(options.dataRoot, options.relativeDest, src);
    } catch (error) {
      if (error instanceof SafeDataFileError) throw error;
      throw storageIoError();
    }
    return;
  }
  if (!restoreRoot) {
    await ensureDir(resolve(dest, '..'));
    await copyFile(src, dest);
    return;
  }

  await ensureDirInsideRestoreRoot(dirname(dest), restoreRoot);
  try {
    const entry = await lstat(dest);
    if (entry.isSymbolicLink() || entry.isDirectory()) throw new RestoreTargetError();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await copyFileNoFollow(src, dest);
}

/**
 * Check whether a file/directory name matches any exclude pattern.
 * Patterns with '*' are treated as globs; otherwise exact match.
 */
export function shouldExclude(name, excludePatterns) {
  if (!excludePatterns || excludePatterns.length === 0) return false;
  for (const pattern of excludePatterns) {
    if (pattern.includes('*')) {
      const regexStr =
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      if (new RegExp(regexStr).test(name)) return true;
    } else {
      if (name === pattern) return true;
    }
  }
  return false;
}

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Build snapshot integrity by walking filesRel under dataDir with no-follow fd hashing.
 * @param {string} dataDir
 * @param {string} filesRel
 */
async function buildSnapshotIntegrityUnderRoot(dataDir, filesRel) {
  let relativeFiles;
  try {
    relativeFiles = await collectSafeRelativeFiles(dataDir, filesRel);
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    throw storageIoError();
  }
  const entries = [];
  for (const path of relativeFiles) {
    let hashed;
    try {
      hashed = await safeHashFileSha256(dataDir, `${filesRel}/${path}`);
    } catch (error) {
      if (error instanceof SafeDataFileError) throw error;
      throw storageIoError();
    }
    entries.push({ path, size: hashed.size, sha256: hashed.sha256 });
  }
  entries.sort((a, b) => compareUtf8Bytes(a.path, b.path));
  return {
    files: entries.map((entry) => entry.path),
    integrity: {
      algorithm: 'sha256',
      totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
      entries,
    },
  };
}

async function copyDirRecursive(src, dest, excludePatterns = [], options = {}) {
  if (options.restoreRoot) {
    await ensureDirInsideRestoreRoot(dest, options.restoreRoot);
  } else if (options.dataRoot && options.relativeDest) {
    await ensureRepoDir(options.dataRoot, options.relativeDest);
  } else {
    await ensureDir(dest);
  }
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name, excludePatterns)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    // Reject symlink / unsupported source entries before any open/follow.
    let srcStat;
    try {
      srcStat = await lstat(srcPath);
    } catch {
      throw new Error('unsupported backup file type');
    }
    if (srcStat.isSymbolicLink()) {
      throw new Error('unsupported backup file type');
    }
    if (srcStat.isDirectory()) {
      const childOptions = options.dataRoot && options.relativeDest
        ? {
          ...options,
          relativeDest: `${options.relativeDest}/${entry.name}`,
        }
        : options;
      await copyDirRecursive(srcPath, destPath, excludePatterns, childOptions);
    } else if (srcStat.isFile()) {
      if (options.dataRoot && options.relativeDest) {
        await copyFileSafe(srcPath, destPath, {
          dataRoot: options.dataRoot,
          relativeDest: `${options.relativeDest}/${entry.name}`,
        });
      } else {
        await copyFileSafe(srcPath, destPath, options);
      }
    } else {
      throw new Error('unsupported backup file type');
    }
  }
}

// ── Heartbeat ──────────────────────────────────────────────────────

export async function recordHeartbeat(dataDir, deviceId, hostname, ipAddress) {
  const { slug, deviceRel } = safeDevicePath(dataDir, deviceId);
  await ensureRepoDir(dataDir, deviceRel);

  const infoRel = `${deviceRel}/device.json`;
  const existing = (await readJSONUnderRoot(dataDir, infoRel)) || {};

  const info = {
    deviceId: slug,
    hostname: hostname || existing.hostname || 'unknown',
    ipAddress: ipAddress || existing.ipAddress || 'unknown',
    lastHeartbeatAt: new Date().toISOString(),
    snapshotCount: existing.snapshotCount || 0,
    lastBackupAt: existing.lastBackupAt || null,
    status: 'online',
  };

  await atomicWriteJSONUnderRoot(dataDir, infoRel, info);
  return info;
}

// ── List devices ───────────────────────────────────────────────────

export async function listDevices(dataDir) {
  const devicesRel = 'repo/devices';
  const devicesDir = await ensureRepoDir(dataDir, devicesRel);

  const dirs = await readdir(devicesDir, { withFileTypes: true });
  const devices = [];

  for (const entry of dirs) {
    if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
    // Skip symlink directory entries when Dirent supports it; also lstat leaf path.
    try {
      const info = await readJSONUnderRoot(dataDir, `${devicesRel}/${entry.name}/device.json`);
      if (info) devices.push(info);
    } catch (error) {
      if (error instanceof SafeDataFileError) continue;
      throw error;
    }
  }

  return devices;
}

// ── Get device info ────────────────────────────────────────────────

export async function getDevice(dataDir, deviceId) {
  const { deviceRel } = safeDevicePath(dataDir, deviceId);
  const info = await readJSONUnderRoot(dataDir, `${deviceRel}/device.json`);
  return info;
}

// ── Create backup ──────────────────────────────────────────────────

export async function createBackup(dataDir, { deviceId, hostname, ipAddress, sourcePath, excludePatterns, jobName }, hooks) {
  const { slug, deviceRel } = safeDevicePath(dataDir, deviceId);
  await ensureRepoDir(dataDir, deviceRel);

  // Validate source exists
  let sourceStat;
  try {
    sourceStat = await lstat(sourcePath);
  } catch {
    throw new Error(`Source path does not exist: ${sourcePath}`);
  }
  if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
    throw new Error('unsupported backup file type');
  }

  const snapshotId = randomUUID();
  const snapshotRel = `${deviceRel}/snapshots/${snapshotId}`;
  const filesRel = `${snapshotRel}/files`;
  const filesDir = await ensureRepoDir(dataDir, filesRel);

  // Hook: after dir setup (for concurrency testing)
  if (hooks?.afterDirSetup) await hooks.afterDirSetup(snapshotId);

  // Copy source → files/ (respecting excludePatterns)
  const ep = excludePatterns || [];
  if (sourceStat.isDirectory()) {
    await copyDirRecursive(sourcePath, filesDir, ep, {
      dataRoot: dataDir,
      relativeDest: filesRel,
    });
  } else {
    const fileName = basename(sourcePath);
    if (!shouldExclude(fileName, ep)) {
      await copyFileSafe(sourcePath, join(filesDir, fileName), {
        dataRoot: dataDir,
        relativeDest: `${filesRel}/${fileName}`,
      });
    }
  }

  // Hook: after file copy (for concurrency overlap verification)
  if (hooks?.afterCopy) await hooks.afterCopy(snapshotId);

  // Post-copy integrity: re-walk filesRel with root-relative no-follow + fd hash.
  // If files/ was swapped to a symlink after copy, this fails closed and does not publish.
  let snapshotIntegrity;
  try {
    snapshotIntegrity = await buildSnapshotIntegrityUnderRoot(dataDir, filesRel);
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    throw storageIoError();
  }
  const manifest = {
    schemaVersion: 2,
    snapshotId,
    deviceId: slug,
    createdAt: new Date().toISOString(),
    hostname: hostname || 'unknown',
    ipAddress: ipAddress || 'unknown',
    sourcePath,
    files: snapshotIntegrity.files,
    integrity: snapshotIntegrity.integrity,
  };
  await atomicWriteJSONUnderRoot(dataDir, `${snapshotRel}/manifest.json`, manifest);

  // Update snapshots.json
  const snapshotsRel = `${deviceRel}/snapshots.json`;
  const snapshotsList = (await readJSONUnderRoot(dataDir, snapshotsRel)) || [];
  const snapshotRecord = {
    snapshotId,
    createdAt: manifest.createdAt,
    hostname: manifest.hostname,
    sourcePath,
    fileCount: manifest.files.length,
  };
  if (jobName) snapshotRecord.jobName = jobName;
  snapshotsList.push(snapshotRecord);
  await atomicWriteJSONUnderRoot(dataDir, snapshotsRel, snapshotsList);

  // Update device.json
  const deviceInfoRel = `${deviceRel}/device.json`;
  const deviceInfo = (await readJSONUnderRoot(dataDir, deviceInfoRel)) || {
    deviceId: slug,
    hostname: hostname || 'unknown',
    ipAddress: ipAddress || 'unknown',
    snapshotCount: 0,
    lastBackupAt: null,
    status: 'unknown',
    lastHeartbeatAt: null,
  };
  deviceInfo.snapshotCount = snapshotsList.length;
  deviceInfo.lastBackupAt = manifest.createdAt;
  if (hostname) deviceInfo.hostname = hostname;
  if (ipAddress) deviceInfo.ipAddress = ipAddress;
  await atomicWriteJSONUnderRoot(dataDir, deviceInfoRel, deviceInfo);

  return snapshotRecord;
}

// ── Remote-upload direct-reader gate (C4) ──────────────────────────

/**
 * Fail-close for remote-upload direct readers. Public message is code-only.
 * @returns {never}
 */
function remoteReaderFailClose() {
  throw new LinkeError(ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
}

/**
 * Complete remote index schema required before any remote reader success.
 * @param {unknown} entry
 * @returns {boolean}
 */
function isCompleteRemoteIndexEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const e = /** @type {Record<string, unknown>} */ (entry);
  if (e.origin !== REMOTE_UPLOAD_ORIGIN) return false;
  if (typeof e.snapshotId !== 'string' || e.snapshotId.length === 0) return false;
  if (typeof e.manifestDigest !== 'string' || !REMOTE_DIGEST_RE.test(e.manifestDigest)) {
    return false;
  }
  if (typeof e.committedAt !== 'string' || e.committedAt.length === 0) return false;
  return true;
}

/**
 * Read and validate final COMPLETED.json for remote-upload.
 * Missing/corrupt/hostile → null (caller fail-closes).
 * deviceId is returned only for internal re-projection; never surface in public results.
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {string} snapshotId
 * @returns {Promise<null | { manifestDigest: string, snapshotId: string, deviceId: string }>}
 */
async function readValidRemoteCompleted(dataDir, deviceRel, snapshotId) {
  const rel = `${deviceRel}/snapshots/${snapshotId}/COMPLETED.json`;
  let raw;
  try {
    raw = await safeReadText(dataDir, rel, { maxBytes: MAX_REMOTE_MARKER_BYTES });
  } catch {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const m = /** @type {Record<string, unknown>} */ (obj);
  if (m.schemaVersion !== 1) return null;
  if (m.origin !== REMOTE_UPLOAD_ORIGIN) return null;
  if (m.snapshotId !== snapshotId) return null;
  if (typeof m.manifestDigest !== 'string' || !REMOTE_DIGEST_RE.test(m.manifestDigest)) {
    return null;
  }
  if (typeof m.committedAt !== 'string' || m.committedAt.length === 0) return null;
  if (typeof m.uploadId !== 'string' || m.uploadId.length === 0) return null;
  if (typeof m.deviceId !== 'string' || m.deviceId.length === 0) return null;
  return {
    manifestDigest: m.manifestDigest,
    snapshotId: /** @type {string} */ (m.snapshotId),
    deviceId: m.deviceId,
  };
}

/**
 * Design §8.4 three-party digest: COMPLETED ↔ index ↔ re-projected canonical manifest.
 * Bounded no-follow read + C1 projector in one pass; failures → null (no detail leak).
 * On success returns the frozen projected canonical manifest for get/restore reuse.
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {string} snapshotId
 * @param {string} authenticatedDeviceId
 * @param {string} claimedManifestDigest
 * @returns {Promise<object | null>}
 */
async function remoteCanonicalManifestAgrees(
  dataDir,
  deviceRel,
  snapshotId,
  authenticatedDeviceId,
  claimedManifestDigest,
) {
  const rel = `${deviceRel}/snapshots/${snapshotId}/manifest.json`;
  let raw;
  try {
    raw = await safeReadText(dataDir, rel, { maxBytes: MAX_REMOTE_MANIFEST_BYTES });
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    const projected = projectCanonicalUploadManifest(parsed, {
      authenticatedDeviceId,
      claimedManifestDigest,
    });
    if (projected.manifest.snapshotId !== snapshotId) return null;
    if (projected.manifestDigest !== claimedManifestDigest) return null;
    return projected.manifest;
  } catch {
    // Missing/corrupt/hostile/non-canonical schema/digest mismatch — fail-close, no projector leak.
    return null;
  }
}

/**
 * Bounded no-follow occupancy check for final PENDING.json.
 * Only explicit ENOENT means unoccupied; any present/unreadable/symlink/corrupt path is occupied.
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {string} snapshotId
 * @returns {Promise<boolean>}
 */
async function remotePendingOccupiesFinal(dataDir, deviceRel, snapshotId) {
  const rel = `${deviceRel}/snapshots/${snapshotId}/PENDING.json`;
  try {
    await safeReadText(dataDir, rel, { maxBytes: MAX_REMOTE_MARKER_BYTES });
    // Any successful read (valid JSON, corrupt body, unknown schema) occupies the path.
    return true;
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') return false;
    // Symlink / unsafe / hostile / other I/O: treat as occupied (fail-close, no local bypass).
    return true;
  }
}

/**
 * Shared classification for list / get / restore (and any equivalent direct reader).
 * - remote-upload index rows require complete schema + valid COMPLETED + digest match + safe files/
 * - local rows (no origin / origin !== remote-upload) keep legacy behavior unless PENDING occupies
 * - orphan remote COMPLETED without matching remote index is fail-close
 * - PENDING path occupancy without valid COMPLETED is fail-close (no local bypass)
 *
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {string} snapshotId
 * @param {unknown} indexEntry
 * @returns {Promise<
 *   | { access: 'fail-close' }
 *   | { access: 'local' }
 *   | { access: 'readable', canonicalManifest: object }
 * >}
 */
async function classifyDirectSnapshotAccess(dataDir, deviceRel, snapshotId, indexEntry) {
  const entry = indexEntry && typeof indexEntry === 'object' && !Array.isArray(indexEntry)
    ? /** @type {Record<string, unknown>} */ (indexEntry)
    : null;

  if (entry && entry.origin === REMOTE_UPLOAD_ORIGIN) {
    if (!isCompleteRemoteIndexEntry(entry)) return { access: 'fail-close' };
    if (entry.snapshotId !== snapshotId) return { access: 'fail-close' };
    const marker = await readValidRemoteCompleted(dataDir, deviceRel, snapshotId);
    if (!marker) return { access: 'fail-close' };
    if (marker.manifestDigest !== entry.manifestDigest) return { access: 'fail-close' };
    // Reject symlink / missing files/ before any manifest or restore success.
    try {
      await assertSafeExistingRelativeDir(
        dataDir,
        `${deviceRel}/snapshots/${snapshotId}/files`,
      );
    } catch {
      return { access: 'fail-close' };
    }
    // Marker/index agree: still require re-projected canonical digest (design §8.4).
    const claimedDigest = /** @type {string} */ (entry.manifestDigest);
    const canonicalManifest = await remoteCanonicalManifestAgrees(
      dataDir,
      deviceRel,
      snapshotId,
      marker.deviceId,
      claimedDigest,
    );
    if (!canonicalManifest) return { access: 'fail-close' };
    return { access: 'readable', canonicalManifest };
  }

  // No remote index origin (missing index / no origin / origin !== remote-upload):
  // local compatibility only when no valid COMPLETED and PENDING path is clearly absent.
  const orphanMarker = await readValidRemoteCompleted(dataDir, deviceRel, snapshotId);
  if (orphanMarker) {
    // Marker alone is not a commit point without matching remote index entry.
    return { access: 'fail-close' };
  }
  // Without a valid COMPLETED, any PENDING.json occupancy blocks local bypass.
  if (await remotePendingOccupiesFinal(dataDir, deviceRel, snapshotId)) {
    return { access: 'fail-close' };
  }
  return { access: 'local' };
}

/**
 * Verify remote final files/ against exact canonical integrity allowlist before any target write.
 * Disk relative set must equal canonical files/entries; size + SHA-256 must match.
 * @param {string} dataDir
 * @param {string} filesRel
 * @param {object} canonicalManifest
 * @returns {Promise<{ path: string, size: number, sha256: string }[]>}
 */
async function verifyRemoteFinalFilesAgainstCanonical(dataDir, filesRel, canonicalManifest) {
  const integrity = /** @type {{ integrity?: unknown }} */ (canonicalManifest).integrity;
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) {
    remoteReaderFailClose();
  }
  const entriesRaw = /** @type {{ entries?: unknown }} */ (integrity).entries;
  if (!Array.isArray(entriesRaw)) remoteReaderFailClose();

  /** @type {{ path: string, size: number, sha256: string }[]} */
  const entries = [];
  for (const e of entriesRaw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) remoteReaderFailClose();
    const path = /** @type {{ path?: unknown }} */ (e).path;
    const size = /** @type {{ size?: unknown }} */ (e).size;
    const sha256 = /** @type {{ sha256?: unknown }} */ (e).sha256;
    if (typeof path !== 'string' || path.length === 0) remoteReaderFailClose();
    if (!Number.isSafeInteger(size) || size < 0) remoteReaderFailClose();
    if (typeof sha256 !== 'string' || !REMOTE_DIGEST_RE.test(sha256)) remoteReaderFailClose();
    entries.push({ path, size, sha256 });
  }

  const filesList = /** @type {{ files?: unknown }} */ (canonicalManifest).files;
  if (!Array.isArray(filesList) || filesList.length !== entries.length) remoteReaderFailClose();
  for (let i = 0; i < entries.length; i += 1) {
    if (filesList[i] !== entries[i].path) remoteReaderFailClose();
  }

  let relativeFiles;
  try {
    relativeFiles = await collectSafeRelativeFiles(dataDir, filesRel);
  } catch {
    remoteReaderFailClose();
  }
  // Exact set equality: no rogue, no missing (order may differ from walk).
  if (relativeFiles.length !== entries.length) remoteReaderFailClose();
  const diskSet = new Set(relativeFiles);
  if (diskSet.size !== entries.length) remoteReaderFailClose();
  for (const entry of entries) {
    if (!diskSet.has(entry.path)) remoteReaderFailClose();
  }

  for (const entry of entries) {
    let hashed;
    try {
      hashed = await safeHashFileSha256(dataDir, `${filesRel}/${entry.path}`);
    } catch {
      remoteReaderFailClose();
    }
    if (!hashed || hashed.size !== entry.size || hashed.sha256 !== entry.sha256) {
      remoteReaderFailClose();
    }
  }

  return entries;
}

/**
 * Load snapshots.json array (empty if missing).
 * @param {string} dataDir
 * @param {string} deviceRel
 * @returns {Promise<unknown[]>}
 */
async function loadSnapshotsIndex(dataDir, deviceRel) {
  const snapshots = await readJSONUnderRoot(dataDir, `${deviceRel}/snapshots.json`);
  if (!Array.isArray(snapshots)) return [];
  return snapshots;
}

/**
 * Find index entry by snapshotId (first match).
 * @param {unknown[]} list
 * @param {string} snapshotId
 * @returns {unknown | null}
 */
function findIndexEntry(list, snapshotId) {
  for (const entry of list) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)
      && /** @type {{ snapshotId?: unknown }} */ (entry).snapshotId === snapshotId) {
      return entry;
    }
  }
  return null;
}

// ── List snapshots ─────────────────────────────────────────────────

export async function listSnapshots(dataDir, deviceId) {
  const { deviceRel } = safeDevicePath(dataDir, deviceId);
  const snapshots = await loadSnapshotsIndex(dataDir, deviceRel);
  /** @type {unknown[]} */
  const visible = [];
  for (const entry of snapshots) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = /** @type {Record<string, unknown>} */ (entry);
    // Every identifiable snapshotId goes through shared classifier (remote + local).
    if (typeof e.snapshotId === 'string' && e.snapshotId.length > 0) {
      const cls = await classifyDirectSnapshotAccess(dataDir, deviceRel, e.snapshotId, entry);
      if (cls.access === 'fail-close') continue;
      visible.push(entry);
      continue;
    }
    // Unidentifiable remote-upload rows stay hidden; other legacy rows keep prior visibility.
    if (e.origin === REMOTE_UPLOAD_ORIGIN) continue;
    visible.push(entry);
  }
  return visible;
}

// ── Read snapshot manifest ─────────────────────────────────────────

export async function getSnapshotManifest(dataDir, deviceId, snapshotId) {
  const { deviceRel } = safeDevicePath(dataDir, deviceId);
  if (!/^[a-f0-9-]+$/i.test(snapshotId)) {
    throw new Error(`Invalid snapshotId: ${snapshotId}`);
  }

  const index = await loadSnapshotsIndex(dataDir, deviceRel);
  const entry = findIndexEntry(index, snapshotId);
  const cls = await classifyDirectSnapshotAccess(dataDir, deviceRel, snapshotId, entry);
  if (cls.access === 'fail-close') remoteReaderFailClose();

  // Remote: return already-validated frozen canonical (never raw disk JSON / extra keys).
  if (cls.access === 'readable') {
    return cls.canonicalManifest;
  }

  // Local compatibility: legacy raw read.
  return readJSONUnderRoot(dataDir, `${deviceRel}/snapshots/${snapshotId}/manifest.json`);
}

// ── Restore ────────────────────────────────────────────────────────

export async function restoreSnapshot(dataDir, { deviceId, snapshotId, targetPath, restoreRoot }) {
  const { deviceRel } = safeDevicePath(dataDir, deviceId);

  // Validate snapshotId format (UUID-like, no traversal)
  if (!/^[a-f0-9-]+$/i.test(snapshotId)) {
    throw new Error(`Invalid snapshotId: ${snapshotId}`);
  }

  // Remote fail-close BEFORE creating/writing target.
  const index = await loadSnapshotsIndex(dataDir, deviceRel);
  const entry = findIndexEntry(index, snapshotId);
  const cls = await classifyDirectSnapshotAccess(dataDir, deviceRel, snapshotId, entry);
  if (cls.access === 'fail-close') remoteReaderFailClose();

  const filesRel = `${deviceRel}/snapshots/${snapshotId}/files`;

  // ── Remote restore: full allowlist + integrity before any target side effect ──
  if (cls.access === 'readable') {
    try {
      await assertSafeExistingRelativeDir(dataDir, filesRel);
    } catch {
      remoteReaderFailClose();
    }

    const allowlist = await verifyRemoteFinalFilesAgainstCanonical(
      dataDir,
      filesRel,
      cls.canonicalManifest,
    );

    // Only after integrity succeeds: create target and copy exact canonical allowlist.
    if (restoreRoot) {
      await ensureDirInsideRestoreRoot(targetPath, restoreRoot);
    } else {
      await ensureDir(targetPath);
    }

    for (const fileEntry of allowlist) {
      const dest = join(targetPath, fileEntry.path);
      await copyRootRelativeFileToDest(
        dataDir,
        `${filesRel}/${fileEntry.path}`,
        dest,
        { restoreRoot },
      );
    }

    return { restored: true, snapshotId, targetPath };
  }

  // ── Local restore: legacy collect + copy (behavior unchanged) ──
  try {
    await assertSafeExistingRelativeDir(dataDir, filesRel);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }
    if (error instanceof SafeDataFileError) throw error;
    throw storageIoError();
  }

  if (restoreRoot) {
    await ensureDirInsideRestoreRoot(targetPath, restoreRoot);
  } else {
    await ensureDir(targetPath);
  }

  // Enumerate and copy each source file with O_RDONLY|O_NOFOLLOW under dataDir.
  let relativeFiles;
  try {
    relativeFiles = await collectSafeRelativeFiles(dataDir, filesRel);
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    throw storageIoError();
  }

  for (const relFile of relativeFiles) {
    const dest = join(targetPath, relFile);
    await copyRootRelativeFileToDest(
      dataDir,
      `${filesRel}/${relFile}`,
      dest,
      { restoreRoot },
    );
  }

  return { restored: true, snapshotId, targetPath };
}
