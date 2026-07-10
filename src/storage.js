import { constants, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, stat, copyFile, lstat, realpath, open } from 'node:fs/promises';
import { join, resolve, normalize, basename, relative, dirname, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

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
  return { slug, deviceDir: full };
}

// ── Atomic helpers ─────────────────────────────────────────────────

export async function atomicWriteJSON(filePath, data) {
  const dir = resolve(filePath, '..');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmp, filePath);
}

export async function readJSON(filePath) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// ── Directory helpers ──────────────────────────────────────────────

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
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
    sourceHandle = await open(src, 'r');
    targetHandle = await open(
      dest,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o666,
    );
    await pipeline(sourceHandle.createReadStream(), targetHandle.createWriteStream());
  } catch (err) {
    if (err.code === 'ELOOP') throw new RestoreTargetError();
    throw err;
  } finally {
    await Promise.allSettled([
      sourceHandle?.close(),
      targetHandle?.close(),
    ]);
  }
}

async function copyFileSafe(src, dest, options = {}) {
  const restoreRoot = options.restoreRoot;
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

async function hashFileSha256(filePath) {
  const entry = await lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('unsupported backup file type');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { size: entry.size, sha256: hash.digest('hex') };
}

async function buildSnapshotIntegrity(filesDir, allFiles) {
  const entries = [];
  for (const filePath of allFiles) {
    const path = relative(filesDir, filePath);
    const { size, sha256 } = await hashFileSha256(filePath);
    entries.push({ path, size, sha256 });
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
  } else {
    await ensureDir(dest);
  }
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name, excludePatterns)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, excludePatterns, options);
    } else if (entry.isFile()) {
      await copyFileSafe(srcPath, destPath, options);
    } else {
      throw new Error('unsupported backup file type');
    }
  }
}

async function collectFilesRecursive(dir, base = dir) {
  const result = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectFilesRecursive(full, base);
      result.push(...sub);
    } else {
      // Use full path (dir/name) so the relative path from base is preserved
      result.push(full);
    }
  }
  return result;
}

// ── Heartbeat ──────────────────────────────────────────────────────

export async function recordHeartbeat(dataDir, deviceId, hostname, ipAddress) {
  const { slug, deviceDir } = safeDevicePath(dataDir, deviceId);
  await ensureDir(deviceDir);

  const infoPath = join(deviceDir, 'device.json');
  const existing = (await readJSON(infoPath)) || {};

  const info = {
    deviceId: slug,
    hostname: hostname || existing.hostname || 'unknown',
    ipAddress: ipAddress || existing.ipAddress || 'unknown',
    lastHeartbeatAt: new Date().toISOString(),
    snapshotCount: existing.snapshotCount || 0,
    lastBackupAt: existing.lastBackupAt || null,
    status: 'online',
  };

  await atomicWriteJSON(infoPath, info);
  return info;
}

// ── List devices ───────────────────────────────────────────────────

export async function listDevices(dataDir) {
  const devicesDir = join(dataDir, 'repo', 'devices');
  await ensureDir(devicesDir);

  const dirs = await readdir(devicesDir, { withFileTypes: true });
  const devices = [];

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const info = await readJSON(join(devicesDir, entry.name, 'device.json'));
    if (info) devices.push(info);
  }

  return devices;
}

// ── Get device info ────────────────────────────────────────────────

export async function getDevice(dataDir, deviceId) {
  const { slug, deviceDir } = safeDevicePath(dataDir, deviceId);
  const info = await readJSON(join(deviceDir, 'device.json'));
  return info;
}

// ── Create backup ──────────────────────────────────────────────────

export async function createBackup(dataDir, { deviceId, hostname, ipAddress, sourcePath, excludePatterns, jobName }, hooks) {
  const { slug, deviceDir } = safeDevicePath(dataDir, deviceId);
  await ensureDir(deviceDir);

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
  const snapshotDir = join(deviceDir, 'snapshots', snapshotId);
  const filesDir = join(snapshotDir, 'files');
  await ensureDir(filesDir);

  // Hook: after dir setup (for concurrency testing)
  if (hooks?.afterDirSetup) await hooks.afterDirSetup(snapshotId);

  // Copy source → files/ (respecting excludePatterns)
  const ep = excludePatterns || [];
  if (sourceStat.isDirectory()) {
    await copyDirRecursive(sourcePath, filesDir, ep);
  } else {
    const fileName = basename(sourcePath);
    if (!shouldExclude(fileName, ep)) {
      await copyFileSafe(sourcePath, join(filesDir, fileName));
    }
  }

  // Hook: after file copy (for concurrency overlap verification)
  if (hooks?.afterCopy) await hooks.afterCopy(snapshotId);

  // Build manifest
  const allFiles = await collectFilesRecursive(filesDir);
  const snapshotIntegrity = await buildSnapshotIntegrity(filesDir, allFiles);
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
  await atomicWriteJSON(join(snapshotDir, 'manifest.json'), manifest);

  // Update snapshots.json
  const snapshotsPath = join(deviceDir, 'snapshots.json');
  const snapshotsList = (await readJSON(snapshotsPath)) || [];
  const snapshotRecord = {
    snapshotId,
    createdAt: manifest.createdAt,
    hostname: manifest.hostname,
    sourcePath,
    fileCount: manifest.files.length,
  };
  if (jobName) snapshotRecord.jobName = jobName;
  snapshotsList.push(snapshotRecord);
  await atomicWriteJSON(snapshotsPath, snapshotsList);

  // Update device.json
  const deviceInfoPath = join(deviceDir, 'device.json');
  const deviceInfo = (await readJSON(deviceInfoPath)) || {
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
  await atomicWriteJSON(deviceInfoPath, deviceInfo);

  return snapshotRecord;
}

// ── List snapshots ─────────────────────────────────────────────────

export async function listSnapshots(dataDir, deviceId) {
  const { deviceDir } = safeDevicePath(dataDir, deviceId);
  const snapshots = await readJSON(join(deviceDir, 'snapshots.json'));
  return snapshots || [];
}

// ── Read snapshot manifest ─────────────────────────────────────────

export async function getSnapshotManifest(dataDir, deviceId, snapshotId) {
  const { deviceDir } = safeDevicePath(dataDir, deviceId);
  if (!/^[a-f0-9-]+$/i.test(snapshotId)) {
    throw new Error(`Invalid snapshotId: ${snapshotId}`);
  }

  return readJSON(join(deviceDir, 'snapshots', snapshotId, 'manifest.json'));
}

// ── Restore ────────────────────────────────────────────────────────

export async function restoreSnapshot(dataDir, { deviceId, snapshotId, targetPath, restoreRoot }) {
  const { deviceDir } = safeDevicePath(dataDir, deviceId);

  // Validate snapshotId format (UUID-like, no traversal)
  if (!/^[a-f0-9-]+$/i.test(snapshotId)) {
    throw new Error(`Invalid snapshotId: ${snapshotId}`);
  }

  const snapshotDir = join(deviceDir, 'snapshots', snapshotId);
  const filesDir = join(snapshotDir, 'files');

  // Verify snapshot exists
  try {
    await stat(filesDir);
  } catch {
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  if (restoreRoot) {
    await ensureDirInsideRestoreRoot(targetPath, restoreRoot);
  } else {
    await ensureDir(targetPath);
  }
  await copyDirRecursive(filesDir, targetPath, [], { restoreRoot });

  return { restored: true, snapshotId, targetPath };
}
