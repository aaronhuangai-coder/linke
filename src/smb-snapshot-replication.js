import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream, constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { getSnapshotManifest, safeDevicePath } from './storage.js';
import { LINKE_RELEASE_VERSION } from './version.js';

const execFileDefault = promisify(execFileCallback);

const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_ID_PATTERN = /^[a-z0-9._-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROGRESS_TIMEOUT_MS = 120_000;
const MOUNT_RECHECK_FILE_INTERVAL = 50;
const MOUNT_RECHECK_BYTE_INTERVAL = 100 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_LOCK_MS = 30 * 60 * 1000;
const RETRYABLE_IO_CODES = new Set([
  'EIO',
  'EHOSTDOWN',
  'ENETDOWN',
  'ENETUNREACH',
  'ECONNRESET',
  'ETIMEDOUT',
]);
const LOCK_SCHEMA_KEYS = Object.freeze([
  'schemaVersion',
  'attemptId',
  'ownerToken',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'createdAt',
  'heartbeatAt',
]);
const COMPLETED_MARKER_KEYS = Object.freeze([
  'schemaVersion',
  'state',
  'snapshotId',
  'deviceId',
  'manifestDigest',
  'algorithm',
  'fileCount',
  'totalBytes',
  'completedAt',
  'linkeVersion',
]);

function canRetryBeforePublish(error, retryCount, published) {
  return !published && retryCount < 1 && RETRYABLE_IO_CODES.has(error?.code);
}

export const SMB_REPLICATION_CODES = Object.freeze({
  EXECUTION_BLOCKED: 'smb-execution-blocked',
  MOUNT_REQUIRED: 'smb-mount-required',
  SPACE_INSUFFICIENT: 'smb-space-insufficient',
  V2_REQUIRED: 'snapshot-integrity-v2-required',
  SNAPSHOT_INTEGRITY_FAILED: 'snapshot-integrity-failed',
  LOCK_HELD: 'replication-lock-held',
  RECOVERY_REQUIRED: 'recovery_required',
  REMOTE_CONFLICT: 'remote-snapshot-conflict',
  REMOTE_INTEGRITY_FAILED: 'remote-snapshot-integrity-failed',
  COPY_FAILED: 'replication-copy-failed',
});

/** 表示 mounted SMB 复制流程中可安全映射为固定 code 的 fail-closed 错误。 */
export class SmbReplicationError extends Error {
  constructor(code, exitCode = 1) {
    super(code);
    this.name = 'SmbReplicationError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function failIntegrity() {
  throw new SmbReplicationError(SMB_REPLICATION_CODES.SNAPSHOT_INTEGRITY_FAILED, 2);
}

function failMount() {
  throw new SmbReplicationError(SMB_REPLICATION_CODES.MOUNT_REQUIRED, 2);
}

function failCopy() {
  throw new SmbReplicationError(SMB_REPLICATION_CODES.COPY_FAILED, 1);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeDeviceId(value) {
  return typeof value === 'string'
    && DEVICE_ID_PATTERN.test(value)
    && value !== '.'
    && value !== '..';
}

function isUuidLike(value) {
  return typeof value === 'string' && UUID_LIKE_PATTERN.test(value);
}

function isSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isSafeManifestPath(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || isAbsolute(value)
    || /[\x00-\x1f\x7f\\]/.test(value)) {
    return false;
  }
  return !value.split('/').some((part) => !part || part === '.' || part === '..');
}

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 从本地 manifest v2 重建并返回固定字段顺序的远端最小 manifest；任何不一致均 fail-closed。
 */
export function buildRemoteSnapshotManifest(localManifest) {
  if (!isRecord(localManifest)
    || localManifest.schemaVersion !== 2
    || !isUuidLike(localManifest.snapshotId)
    || !isSafeDeviceId(localManifest.deviceId)
    || !isCanonicalIsoTimestamp(localManifest.createdAt)
    || !Array.isArray(localManifest.files)
    || !isRecord(localManifest.integrity)
    || localManifest.integrity.algorithm !== 'sha256'
    || !isNonNegativeSafeInteger(localManifest.integrity.totalBytes)
    || !Array.isArray(localManifest.integrity.entries)
    || localManifest.files.length !== localManifest.integrity.entries.length) {
    failIntegrity();
  }

  const files = [];
  const entries = [];
  let totalBytes = 0;
  let previousPath = null;

  for (let index = 0; index < localManifest.files.length; index++) {
    const path = localManifest.files[index];
    const entry = localManifest.integrity.entries[index];
    if (!isSafeManifestPath(path)
      || !isRecord(entry)
      || entry.path !== path
      || !isNonNegativeSafeInteger(entry.size)
      || !isSha256(entry.sha256)
      || (previousPath !== null && compareUtf8Bytes(previousPath, path) >= 0)) {
      failIntegrity();
    }

    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes)) failIntegrity();
    files.push(path);
    entries.push({
      path,
      size: entry.size,
      sha256: entry.sha256,
    });
    previousPath = path;
  }

  if (totalBytes !== localManifest.integrity.totalBytes) failIntegrity();

  return {
    schemaVersion: 2,
    snapshotId: localManifest.snapshotId,
    deviceId: localManifest.deviceId,
    createdAt: localManifest.createdAt,
    files,
    integrity: {
      algorithm: 'sha256',
      totalBytes,
      entries,
    },
  };
}

/**
 * 校验并序列化受限远端 manifest，返回无空白、无结尾换行的 canonical JSON 字符串。
 */
export function serializeCanonicalRemoteManifest(remoteManifest) {
  return JSON.stringify(buildRemoteSnapshotManifest(remoteManifest));
}

/** 校验远端 manifest 并返回 canonical JSON 的小写 SHA-256 十六进制摘要。 */
export function digestRemoteSnapshotManifest(remoteManifest) {
  return createHash('sha256')
    .update(serializeCanonicalRemoteManifest(remoteManifest), 'utf8')
    .digest('hex');
}

/**
 * 仅读取本地 snapshot 并返回脱敏复制计划；不会检查或访问 mounted SMB 路径。
 */
export async function buildSmbSnapshotReplicationPlan(options, dependencies = {}) {
  if (!isRecord(options)
    || !isRecord(options.config)
    || !Array.isArray(options.config.nasTargets)
    || typeof options.targetName !== 'string') {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.MOUNT_REQUIRED, 2);
  }

  const target = options.config.nasTargets.find((item) => item?.name === options.targetName);
  if (!isRecord(target)
    || !['synology', 'ugreen'].includes(target.provider)
    || !isRecord(target.mountedShare)) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.MOUNT_REQUIRED, 2);
  }
  if (!isSafeDeviceId(options.deviceId) || !isUuidLike(options.snapshotId)) {
    failIntegrity();
  }

  const readSnapshotManifest = dependencies.readSnapshotManifest || getSnapshotManifest;
  const localManifest = await readSnapshotManifest(
    options.dataDir,
    options.deviceId,
    options.snapshotId,
  );
  if (!isRecord(localManifest)) failIntegrity();
  if (localManifest.schemaVersion === undefined || localManifest.schemaVersion === 1) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.V2_REQUIRED, 2);
  }

  const remoteManifest = buildRemoteSnapshotManifest(localManifest);
  if (remoteManifest.deviceId !== options.deviceId
    || remoteManifest.snapshotId !== options.snapshotId) {
    failIntegrity();
  }
  const manifestDigest = digestRemoteSnapshotManifest(remoteManifest);

  return {
    command: 'nas-snapshot-replicate',
    mode: 'plan',
    state: 'planned',
    provider: target.provider,
    targetName: target.name,
    deviceId: remoteManifest.deviceId,
    snapshotId: remoteManifest.snapshotId,
    manifestDigest,
    fileCount: remoteManifest.files.length,
    totalBytes: remoteManifest.integrity.totalBytes,
    wouldWrite: false,
    executionRequired: true,
  };
}

/**
 * 使用固定 `/usr/bin/stat` 参数与 statfs 检查挂载类型和可用空间；禁止 shell。
 */
export async function inspectMountedSmb(mountPath, deps = {}) {
  const exec = deps.execFile || execFileDefault;
  const getStatfs = deps.statfs || statfs;
  const { stdout } = await exec('/usr/bin/stat', ['-f', '%T', mountPath]);
  const fsType = String(stdout).trim();
  const stats = await getStatfs(mountPath);
  return {
    fsType,
    availableBytes: Number(stats.bavail) * Number(stats.bsize),
  };
}

function defaultNow() {
  return new Date();
}

function isInsideMount(mountRoot, candidateRealPath) {
  const rel = relative(mountRoot, candidateRealPath);
  if (rel === '') return true;
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

async function assertPathInsideMount(mountRoot, candidatePath) {
  let real;
  try {
    real = await realpath(candidatePath);
  } catch {
    failMount();
  }
  if (!isInsideMount(mountRoot, real)) failMount();
  return real;
}

async function lstatExisting(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    failCopy();
  }
}

/** 校验路径为既有真实目录（非符号链接），并位于 mount 根内。 */
async function assertExistingSafeDir(mountRoot, dirPath) {
  const st = await lstatExisting(dirPath);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isDirectory()) failMount();
  await assertPathInsideMount(mountRoot, dirPath);
  return st;
}

/**
 * 逐级确保目录存在：创建前后均 lstat，拒绝符号链接/非目录，并用 realpath+relative 校验边界。
 */
async function ensureSafeDirectory(mountRoot, dirPath) {
  const resolved = resolve(dirPath);
  const relFromMount = relative(mountRoot, resolved);
  if (relFromMount === '') {
    await assertExistingSafeDir(mountRoot, mountRoot);
    return mountRoot;
  }
  if (relFromMount.startsWith(`..${sep}`) || relFromMount === '..' || isAbsolute(relFromMount)) {
    failMount();
  }

  const parts = relFromMount.split(sep).filter(Boolean);
  let current = mountRoot;
  await assertExistingSafeDir(mountRoot, current);

  for (const part of parts) {
    if (!part || part === '.' || part === '..') failMount();
    current = join(current, part);
    const existing = await lstatExisting(current);
    if (!existing) {
      try {
        await mkdir(current, { recursive: false });
      } catch (error) {
        if (!error || error.code !== 'EEXIST') failCopy();
      }
    }
    const st = await lstatExisting(current);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) failMount();
    await assertPathInsideMount(mountRoot, current);
  }
  return current;
}

async function hashRegularFile(filePath) {
  const st = await lstat(filePath);
  if (st.isSymbolicLink() || !st.isFile()) failIntegrity();
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return { size: st.size, sha256: hash.digest('hex') };
}

/**
 * 在 hashing 前逐级 lstat 校验相对路径的每个祖先与最终文件：
 * 拒绝符号链接/非目录祖先/非普通文件，并用 realpath+relative 验证仍在边界内。
 */
async function assertSafeFileUnderRoot(root, relativePath, {
  boundaryRoot = null,
  fail = failIntegrity,
} = {}) {
  if (!isSafeManifestPath(relativePath)) fail();

  const rootStat = await lstatExisting(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail();

  let rootReal;
  try {
    rootReal = await realpath(root);
  } catch {
    fail();
  }

  let boundReal = rootReal;
  if (boundaryRoot) {
    try {
      boundReal = await realpath(boundaryRoot);
    } catch {
      fail();
    }
    if (!isInsideMount(boundReal, rootReal)) fail();
  }

  const parts = relativePath.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let st;
    try {
      st = await lstat(current);
    } catch {
      fail();
    }

    const isLast = i === parts.length - 1;
    if (isLast) {
      if (st.isSymbolicLink() || !st.isFile()) fail();
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      fail();
    }

    let real;
    try {
      real = await realpath(current);
    } catch {
      fail();
    }
    if (!isInsideMount(rootReal, real) || !isInsideMount(boundReal, real)) fail();
  }

  return current;
}

async function hashSafeFileUnderRoot(root, relativePath, options) {
  const filePath = await assertSafeFileUnderRoot(root, relativePath, options);
  return hashRegularFile(filePath);
}

async function verifyLocalSnapshotFiles(dataDir, deviceId, remoteManifest) {
  const { deviceDir } = safeDevicePath(dataDir, deviceId);
  const filesRoot = join(deviceDir, 'snapshots', remoteManifest.snapshotId, 'files');
  const filesRootStat = await lstatExisting(filesRoot);
  if (!filesRootStat || filesRootStat.isSymbolicLink() || !filesRootStat.isDirectory()) {
    failIntegrity();
  }

  for (const entry of remoteManifest.integrity.entries) {
    const hashed = await hashSafeFileUnderRoot(filesRoot, entry.path, {
      fail: failIntegrity,
    });
    if (hashed.size !== entry.size || hashed.sha256 !== entry.sha256) failIntegrity();
  }
  return filesRoot;
}

function validateMountedShareConfig(mountedShare) {
  if (!isRecord(mountedShare)
    || mountedShare.enabled === false
    || typeof mountedShare.mountPath !== 'string'
    || !isAbsolute(mountedShare.mountPath)
    || typeof mountedShare.relativeRoot !== 'string'
    || !isSafeManifestPath(mountedShare.relativeRoot)) {
    failMount();
  }
  return {
    mountPath: mountedShare.mountPath,
    relativeRoot: mountedShare.relativeRoot,
  };
}

async function resolveMountRoot(mountPath) {
  const st = await lstatExisting(mountPath);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) failMount();
  let mountRoot;
  try {
    mountRoot = await realpath(mountPath);
  } catch {
    failMount();
  }
  const rootStat = await lstat(mountRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) failMount();
  return mountRoot;
}

async function preflightMount(inspectMount, mountPath, totalBytes) {
  let inspection;
  try {
    inspection = await inspectMount(mountPath);
  } catch {
    failMount();
  }
  if (!isRecord(inspection) || inspection.fsType !== 'smbfs') failMount();
  const availableBytes = inspection.availableBytes;
  const safetyMargin = Math.max(64 * 1024 * 1024, Math.ceil(totalBytes * 0.05));
  if (!Number.isSafeInteger(availableBytes) || availableBytes < totalBytes + safetyMargin) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.SPACE_INSUFFICIENT, 2);
  }
  return inspection;
}

async function recheckMount(inspectMount, mountPath) {
  let inspection;
  try {
    inspection = await inspectMount(mountPath);
  } catch {
    failCopy();
  }
  if (!isRecord(inspection) || inspection.fsType !== 'smbfs') failCopy();
  return inspection;
}

/**
 * 流式复制单个文件。
 * 先 await exclusive open（wx/O_EXCL）；系统 errno 原样抛出供 pre-publish 重试判定，
 * 再 pipeline 传播读/写/进度错误；支持 backpressure 与 await 的 onBytes 复检。
 */
async function streamCopyFile(src, dest, deps = {}) {
  const now = deps.now || defaultNow;
  const openRead = deps.createReadStream || createReadStream;
  const openFile = deps.openFile || open;
  let lastProgressAt = now().getTime();
  const readOptions = {};
  if (Number.isSafeInteger(deps.streamHighWaterMark) && deps.streamHighWaterMark > 0) {
    readOptions.highWaterMark = deps.streamHighWaterMark;
  }

  let handle;
  try {
    // awaitable exclusive create：避免 createWriteStream('wx') 无 listener 时 unhandled error。
    handle = await openFile(
      dest,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    );
  } catch (error) {
    if (error instanceof SmbReplicationError) throw error;
    throw error;
  }

  const read = openRead(src, readOptions);
  const write = handle.createWriteStream();
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      lastProgressAt = now().getTime();
      const run = async () => {
        if (typeof deps.onBytes === 'function') {
          await deps.onBytes(chunk.length);
        }
        callback(null, chunk);
      };
      run().catch((error) => {
        callback(error instanceof Error ? error : new Error(String(error)));
      });
    },
  });

  const timer = setInterval(() => {
    if (now().getTime() - lastProgressAt > PROGRESS_TIMEOUT_MS) {
      const timeoutError = new SmbReplicationError(SMB_REPLICATION_CODES.COPY_FAILED, 1);
      read.destroy(timeoutError);
      progress.destroy(timeoutError);
      write.destroy(timeoutError);
    }
  }, 1000);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    await pipeline(read, progress, write);
  } catch (error) {
    if (error instanceof SmbReplicationError) throw error;
    throw error;
  } finally {
    clearInterval(timer);
  }
}

function failRemoteIntegrity() {
  throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_INTEGRITY_FAILED, 1);
}

async function verifyTreeFiles(filesRoot, remoteManifest, boundaryRoot = null) {
  for (const entry of remoteManifest.integrity.entries) {
    let hashed;
    try {
      hashed = await hashSafeFileUnderRoot(filesRoot, entry.path, {
        boundaryRoot,
        fail: failRemoteIntegrity,
      });
    } catch (error) {
      if (error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.REMOTE_INTEGRITY_FAILED) {
        throw error;
      }
      if (error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.SNAPSHOT_INTEGRITY_FAILED) {
        failRemoteIntegrity();
      }
      failRemoteIntegrity();
    }
    if (hashed.size !== entry.size || hashed.sha256 !== entry.sha256) {
      failRemoteIntegrity();
    }
  }
}

async function readJsonIfExists(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return undefined;
  }
}

async function verifyFinalSnapshot(finalDir, expectedRemote, expectedDigest, boundaryRoot = null) {
  const completed = await readJsonIfExists(join(finalDir, 'COMPLETED.json'));
  const remoteRaw = await readJsonIfExists(join(finalDir, 'manifest.json'));
  if (remoteRaw === undefined || completed === undefined) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_INTEGRITY_FAILED, 1);
  }
  if (remoteRaw === null) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }
  if (completed === null) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.RECOVERY_REQUIRED, 3);
  }

  let remoteManifest;
  try {
    remoteManifest = buildRemoteSnapshotManifest(remoteRaw);
  } catch {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_INTEGRITY_FAILED, 1);
  }

  const digest = digestRemoteSnapshotManifest(remoteManifest);
  if (digest !== expectedDigest
    || remoteManifest.snapshotId !== expectedRemote.snapshotId
    || remoteManifest.deviceId !== expectedRemote.deviceId
    || remoteManifest.integrity.totalBytes !== expectedRemote.integrity.totalBytes
    || remoteManifest.files.length !== expectedRemote.files.length) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_INTEGRITY_FAILED, 1);
  }

  for (let i = 0; i < expectedRemote.files.length; i++) {
    const expected = expectedRemote.integrity.entries[i];
    const actual = remoteManifest.integrity.entries[i];
    if (!actual
      || actual.path !== expected.path
      || actual.size !== expected.size
      || actual.sha256 !== expected.sha256) {
      throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_INTEGRITY_FAILED, 1);
    }
  }

  assertValidCompletedMarker(completed, expectedRemote, expectedDigest);
  await verifyTreeFiles(join(finalDir, 'files'), expectedRemote, boundaryRoot);
  return true;
}

/** already_verified 仅接受 Task 4 brief 中精确十个字段的完成标记。 */
function assertValidCompletedMarker(completed, expectedRemote, expectedDigest) {
  if (!isRecord(completed)) failRemoteIntegrity();

  const keys = Object.keys(completed);
  if (keys.length !== COMPLETED_MARKER_KEYS.length) failRemoteIntegrity();
  for (const key of COMPLETED_MARKER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(completed, key)) failRemoteIntegrity();
  }
  for (const key of keys) {
    if (!COMPLETED_MARKER_KEYS.includes(key)) failRemoteIntegrity();
  }

  if (completed.schemaVersion !== 1
    || completed.state !== 'completed'
    || completed.snapshotId !== expectedRemote.snapshotId
    || completed.deviceId !== expectedRemote.deviceId
    || completed.manifestDigest !== expectedDigest
    || completed.algorithm !== 'sha256'
    || completed.fileCount !== expectedRemote.files.length
    || completed.totalBytes !== expectedRemote.integrity.totalBytes
    || completed.linkeVersion !== LINKE_RELEASE_VERSION
    || !isCanonicalIsoTimestamp(completed.completedAt)) {
    failRemoteIntegrity();
  }
}

/**
 * 将已校验 staging 内容迁入已 exclusive claim 的空 final。
 * 不使用 rename(staging, final)，避免 macOS 覆盖空目标目录。
 */
async function moveStagingIntoClaimedFinal(stagingDir, finalDir, mountRoot) {
  const names = await readdir(stagingDir);
  for (const name of names) {
    const from = join(stagingDir, name);
    if (name === 'attempt.json') {
      await rm(from, { force: true });
      continue;
    }
    const to = join(finalDir, name);
    if (await lstatExisting(to)) {
      throw new SmbReplicationError(SMB_REPLICATION_CODES.RECOVERY_REQUIRED, 3);
    }
    await assertPathInsideMount(mountRoot, from);
    try {
      await rename(from, to);
    } catch {
      throw new SmbReplicationError(SMB_REPLICATION_CODES.RECOVERY_REQUIRED, 3);
    }
    await assertPathInsideMount(mountRoot, to);
  }
  await rm(stagingDir, { recursive: true, force: true });
}

async function handleExistingFinal(finalDir, mountRoot, remoteManifest, manifestDigest, target) {
  const finalStat = await lstatExisting(finalDir);
  if (!finalStat) return null;
  if (finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }
  await assertPathInsideMount(mountRoot, finalDir);
  await verifyFinalSnapshot(finalDir, remoteManifest, manifestDigest, mountRoot);
  return sanitizedResult({
    state: 'already_verified',
    provider: target.provider,
    targetName: target.name,
    deviceId: remoteManifest.deviceId,
    snapshotId: remoteManifest.snapshotId,
    manifestDigest,
    fileCount: remoteManifest.files.length,
    totalBytes: remoteManifest.integrity.totalBytes,
    verifiedFileCount: remoteManifest.files.length,
  });
}

async function atomicWriteCompleted(finalDir, completed, deps) {
  const uuid = deps.randomUUID || randomUUID;
  const target = join(finalDir, 'COMPLETED.json');
  const tmp = join(finalDir, `.tmp-completed-${uuid()}`);
  await writeFile(tmp, JSON.stringify(completed), { flag: 'wx' });
  await rename(tmp, target);
}

/** stale 判定只看 heartbeatAt：now - heartbeatAt >= 30 分钟（含精确边界）。 */
function isLockStale(lockBody, nowFn) {
  if (!isRecord(lockBody) || typeof lockBody.heartbeatAt !== 'string') return false;
  const heartbeatMs = Date.parse(lockBody.heartbeatAt);
  if (Number.isNaN(heartbeatMs)) return false;
  return nowFn().getTime() - heartbeatMs >= STALE_LOCK_MS;
}

function parseLockBody(raw) {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return null;
  const keys = Object.keys(raw);
  if (keys.length !== LOCK_SCHEMA_KEYS.length) return null;
  for (const key of LOCK_SCHEMA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return null;
  }
  if (!isUuidLike(raw.attemptId)
    || typeof raw.ownerToken !== 'string'
    || raw.ownerToken.length === 0
    || !isSafeDeviceId(raw.deviceId)
    || !isUuidLike(raw.snapshotId)
    || !isSha256(raw.manifestDigest)
    || !isCanonicalIsoTimestamp(raw.createdAt)
    || !isCanonicalIsoTimestamp(raw.heartbeatAt)) {
    return null;
  }
  return {
    schemaVersion: 1,
    attemptId: raw.attemptId,
    ownerToken: raw.ownerToken,
    deviceId: raw.deviceId,
    snapshotId: raw.snapshotId,
    manifestDigest: raw.manifestDigest,
    createdAt: raw.createdAt,
    heartbeatAt: raw.heartbeatAt,
  };
}

async function exclusiveCreateLock(lockPath, lockBody, deps = {}) {
  const nowFn = deps.now || defaultNow;
  let handle;
  try {
    handle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const existingRaw = await readJsonIfExists(lockPath);
      const existing = existingRaw ? parseLockBody(existingRaw) : null;
      if (existing && isLockStale(existing, nowFn)) {
        throw new SmbReplicationError(SMB_REPLICATION_CODES.RECOVERY_REQUIRED, 3);
      }
      throw new SmbReplicationError(SMB_REPLICATION_CODES.LOCK_HELD, 1);
    }
    failCopy();
  }
  try {
    await handle.writeFile(JSON.stringify(lockBody), 'utf8');
  } finally {
    await handle.close();
  }
}

function lockIdentityMatches(parsed, identity) {
  return Boolean(parsed)
    && parsed.ownerToken === identity.ownerToken
    && parsed.attemptId === identity.attemptId
    && parsed.deviceId === identity.deviceId
    && parsed.snapshotId === identity.snapshotId
    && parsed.manifestDigest === identity.manifestDigest;
}

/** 仅在 ownerToken+attemptId 等 identity 全匹配时，用 temp+rename 刷新 heartbeatAt。 */
async function updateLockHeartbeat(lockPath, identity, nowFn) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!lockIdentityMatches(parsed, identity)) return false;

  const next = {
    schemaVersion: 1,
    attemptId: parsed.attemptId,
    ownerToken: parsed.ownerToken,
    deviceId: parsed.deviceId,
    snapshotId: parsed.snapshotId,
    manifestDigest: parsed.manifestDigest,
    createdAt: parsed.createdAt,
    heartbeatAt: nowFn().toISOString(),
  };
  const tmp = `${lockPath}.${identity.attemptId}.hb-tmp`;
  try {
    await writeFile(tmp, JSON.stringify(next), { flag: 'wx' });
    await rename(tmp, lockPath);
    return true;
  } catch {
    try {
      await rm(tmp, { force: true });
    } catch {
      // ignore
    }
    return false;
  }
}

/**
 * compare-and-delete：重新读取 lock，仅删除 identity 全匹配的 owner 锁。
 * 清理失败向上抛出由调用方吞掉，避免覆盖原始 sanitized 错误。
 */
async function releaseOwnedLock(lockPath, identity, deps = {}) {
  const remove = deps.rm || rm;
  const raw = await readFile(lockPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!lockIdentityMatches(parsed, identity)) return;
  await remove(lockPath, { force: true });
}

/**
 * 仅删除 attempt metadata 与 owner identity 全匹配的 staging；否则保留。
 */
async function cleanupOwnedStaging(stagingDir, identity, deps = {}) {
  if (!stagingDir) return;
  const remove = deps.rm || rm;
  const meta = await readJsonIfExists(join(stagingDir, 'attempt.json'));
  if (meta === null || meta === undefined) return;
  if (!lockIdentityMatches({
    ownerToken: meta.ownerToken,
    attemptId: meta.attemptId,
    deviceId: meta.deviceId,
    snapshotId: meta.snapshotId,
    manifestDigest: meta.manifestDigest,
  }, identity)) {
    return;
  }
  await remove(stagingDir, { recursive: true, force: true });
}

async function resetStagingForRetry(stagingDir, mountRoot) {
  const filesRoot = join(stagingDir, 'files');
  await rm(filesRoot, { recursive: true, force: true });
  await ensureSafeDirectory(mountRoot, filesRoot);
  try {
    await rm(join(stagingDir, 'manifest.json'), { force: true });
  } catch {
    // ignore
  }
}

function mapPrePublishFailure(error) {
  if (error instanceof SmbReplicationError) throw error;
  throw new SmbReplicationError(SMB_REPLICATION_CODES.COPY_FAILED, 1);
}

function sanitizedResult({
  state,
  provider,
  targetName,
  deviceId,
  snapshotId,
  manifestDigest,
  fileCount,
  totalBytes,
  verifiedFileCount,
  attemptId,
}) {
  const result = {
    command: 'nas-snapshot-replicate',
    mode: 'execute',
    state,
    provider,
    targetName,
    deviceId,
    snapshotId,
    manifestDigest,
    fileCount,
    totalBytes,
    verifiedFileCount,
  };
  if (attemptId) result.attemptId = attemptId;
  return result;
}

/**
 * 在双重执行门与 preflight 通过后，把本地 snapshot 发布到 mounted SMB。
 * 首次成功返回 state:'replicated'；已完整验证的重复运行返回 state:'already_verified'。
 */
export async function replicateSnapshotToMountedSmb(options, deps = {}) {
  if (!isRecord(options)
    || options.execute !== true
    || options.executionGate !== 'enabled'
    || !isRecord(options.config)
    || !Array.isArray(options.config.nasTargets)
    || typeof options.targetName !== 'string') {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.EXECUTION_BLOCKED, 2);
  }

  const target = options.config.nasTargets.find((item) => item?.name === options.targetName);
  if (!isRecord(target)
    || target.enabled === false
    || !['synology', 'ugreen'].includes(target.provider)
    || !isRecord(target.mountedShare)
    || target.mountedShare.enabled === false) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.EXECUTION_BLOCKED, 2);
  }
  if (!isSafeDeviceId(options.deviceId) || !isUuidLike(options.snapshotId)) {
    failIntegrity();
  }

  const { mountPath, relativeRoot } = validateMountedShareConfig(target.mountedShare);
  const inspectMount = deps.inspectMount || ((path) => inspectMountedSmb(path, deps));
  const now = deps.now || defaultNow;
  const uuid = deps.randomUUID || randomUUID;

  const readSnapshotManifest = deps.readSnapshotManifest || getSnapshotManifest;
  const localManifest = await readSnapshotManifest(
    options.dataDir,
    options.deviceId,
    options.snapshotId,
  );
  if (!isRecord(localManifest)) failIntegrity();
  if (localManifest.schemaVersion === undefined || localManifest.schemaVersion === 1) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.V2_REQUIRED, 2);
  }

  const remoteManifest = buildRemoteSnapshotManifest(localManifest);
  if (remoteManifest.deviceId !== options.deviceId
    || remoteManifest.snapshotId !== options.snapshotId) {
    failIntegrity();
  }
  const manifestDigest = digestRemoteSnapshotManifest(remoteManifest);
  const localFilesRoot = await verifyLocalSnapshotFiles(
    options.dataDir,
    options.deviceId,
    remoteManifest,
  );

  const mountRoot = await resolveMountRoot(mountPath);
  await preflightMount(inspectMount, mountPath, remoteManifest.integrity.totalBytes);

  const relativeRootPath = join(mountRoot, ...relativeRoot.split('/'));
  await ensureSafeDirectory(mountRoot, relativeRootPath);

  const controlRoot = await ensureSafeDirectory(mountRoot, join(relativeRootPath, '.linke-control'));
  const locksDir = await ensureSafeDirectory(
    mountRoot,
    join(controlRoot, 'locks', remoteManifest.deviceId),
  );
  const stagingParent = await ensureSafeDirectory(
    mountRoot,
    join(controlRoot, 'staging', remoteManifest.deviceId, remoteManifest.snapshotId),
  );
  const devicesParent = await ensureSafeDirectory(
    mountRoot,
    join(relativeRootPath, 'devices', remoteManifest.deviceId, 'snapshots'),
  );

  const finalDir = join(devicesParent, remoteManifest.snapshotId);
  const lockPath = join(locksDir, `${remoteManifest.snapshotId}.json`);
  const attemptId = uuid();
  const ownerToken = uuid();
  const createdAt = now().toISOString();
  const lockIdentity = {
    ownerToken,
    attemptId,
    deviceId: remoteManifest.deviceId,
    snapshotId: remoteManifest.snapshotId,
    manifestDigest,
  };

  await exclusiveCreateLock(lockPath, {
    schemaVersion: 1,
    attemptId,
    ownerToken,
    deviceId: remoteManifest.deviceId,
    snapshotId: remoteManifest.snapshotId,
    manifestDigest,
    createdAt,
    heartbeatAt: createdAt,
  }, { now });

  let stagingDir = null;
  let finalClaimed = false;
  let retryCount = 0;
  let heartbeatTimer = null;
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;
  const heartbeatIntervalMs = Number.isSafeInteger(deps.heartbeatIntervalMs)
    && deps.heartbeatIntervalMs > 0
    ? deps.heartbeatIntervalMs
    : HEARTBEAT_INTERVAL_MS;

  try {
    heartbeatTimer = setIntervalFn(
      () => updateLockHeartbeat(lockPath, lockIdentity, now).catch(() => false),
      heartbeatIntervalMs,
    );
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }

    const existing = await handleExistingFinal(
      finalDir,
      mountRoot,
      remoteManifest,
      manifestDigest,
      target,
    );
    if (existing) return existing;

    stagingDir = join(stagingParent, attemptId);
    await ensureSafeDirectory(mountRoot, stagingDir);
    await ensureSafeDirectory(mountRoot, join(stagingDir, 'files'));

    await writeFile(
      join(stagingDir, 'attempt.json'),
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        ownerToken,
        deviceId: remoteManifest.deviceId,
        snapshotId: remoteManifest.snapshotId,
        manifestDigest,
        createdAt,
      }),
      { flag: 'wx' },
    );

    if (typeof deps.beforeCopy === 'function') {
      await deps.beforeCopy();
    }

    const byteRecheckInterval = Number.isSafeInteger(deps.mountRecheckByteInterval)
      && deps.mountRecheckByteInterval > 0
      ? deps.mountRecheckByteInterval
      : MOUNT_RECHECK_BYTE_INTERVAL;

    // Pre-publish copy with at most one retry for fixed retryable I/O codes.
    while (true) {
      try {
        const stagingFilesRoot = join(stagingDir, 'files');
        let filesSinceRecheck = 0;
        let bytesSinceRecheck = 0;

        for (const entry of remoteManifest.integrity.entries) {
          const src = await assertSafeFileUnderRoot(localFilesRoot, entry.path, {
            fail: failIntegrity,
          });
          const dest = join(stagingFilesRoot, entry.path);
          const destParent = dirname(dest);
          if (destParent !== stagingFilesRoot) {
            await ensureSafeDirectory(mountRoot, destParent);
          }

          await streamCopyFile(src, dest, {
            now,
            createReadStream: deps.createReadStream,
            streamHighWaterMark: deps.streamHighWaterMark,
            openFile: deps.openFile,
            onBytes: async (byteCount) => {
              bytesSinceRecheck += byteCount;
              while (bytesSinceRecheck >= byteRecheckInterval) {
                bytesSinceRecheck -= byteRecheckInterval;
                await recheckMount(inspectMount, mountPath);
              }
            },
          });

          const hashed = await hashSafeFileUnderRoot(stagingFilesRoot, entry.path, {
            boundaryRoot: mountRoot,
            fail: failCopy,
          });
          if (hashed.size !== entry.size || hashed.sha256 !== entry.sha256) failCopy();

          filesSinceRecheck += 1;
          if (filesSinceRecheck >= MOUNT_RECHECK_FILE_INTERVAL) {
            await recheckMount(inspectMount, mountPath);
            filesSinceRecheck = 0;
          }
        }

        await verifyTreeFiles(stagingFilesRoot, remoteManifest, mountRoot);
        await writeFile(
          join(stagingDir, 'manifest.json'),
          serializeCanonicalRemoteManifest(remoteManifest),
          { flag: 'wx' },
        );
        await recheckMount(inspectMount, mountPath);
        break;
      } catch (error) {
        if (canRetryBeforePublish(error, retryCount, finalClaimed)) {
          retryCount += 1;
          await resetStagingForRetry(stagingDir, mountRoot);
          continue;
        }
        mapPrePublishFailure(error);
      }
    }

    if (typeof deps.beforePublish === 'function') {
      await deps.beforePublish();
    }

    // Exclusive claim: mkdir 失败表示 final 已被占用，永不 rename 覆盖。
    try {
      await mkdir(finalDir, { recursive: false });
      finalClaimed = true;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        const verified = await handleExistingFinal(
          finalDir,
          mountRoot,
          remoteManifest,
          manifestDigest,
          target,
        );
        if (verified) return verified;
        throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
      }
      // 发布阶段不确定/失败：保留 staging 与可能的 final，进入 recovery。
      throw new SmbReplicationError(SMB_REPLICATION_CODES.RECOVERY_REQUIRED, 3);
    }

    try {
      await moveStagingIntoClaimedFinal(stagingDir, finalDir, mountRoot);
      stagingDir = null;
    } catch (error) {
      if (error instanceof SmbReplicationError) throw error;
      throw new SmbReplicationError(SMB_REPLICATION_CODES.RECOVERY_REQUIRED, 3);
    }

    await assertPathInsideMount(mountRoot, finalDir);
    await verifyTreeFiles(join(finalDir, 'files'), remoteManifest, mountRoot);

    const completed = {
      schemaVersion: 1,
      state: 'completed',
      snapshotId: remoteManifest.snapshotId,
      deviceId: remoteManifest.deviceId,
      manifestDigest,
      algorithm: 'sha256',
      fileCount: remoteManifest.files.length,
      totalBytes: remoteManifest.integrity.totalBytes,
      completedAt: now().toISOString(),
      linkeVersion: LINKE_RELEASE_VERSION,
    };
    await atomicWriteCompleted(finalDir, completed, { randomUUID: uuid });
    await verifyFinalSnapshot(finalDir, remoteManifest, manifestDigest, mountRoot);

    const result = sanitizedResult({
      state: 'replicated',
      provider: target.provider,
      targetName: target.name,
      deviceId: remoteManifest.deviceId,
      snapshotId: remoteManifest.snapshotId,
      manifestDigest,
      fileCount: remoteManifest.files.length,
      totalBytes: remoteManifest.integrity.totalBytes,
      verifiedFileCount: remoteManifest.files.length,
      attemptId,
    });
    if (retryCount > 0) result.retryCount = retryCount;
    return result;
  } catch (error) {
    // 已 exclusive claim 的 final 即使不完整也不得删除，留给显式恢复。
    // 普通 pre-publish failure：仅清理 owner 匹配的 staging（失败则保留残留）。
    if (!finalClaimed && stagingDir) {
      try {
        await cleanupOwnedStaging(stagingDir, lockIdentity, deps);
      } catch {
        // 清理失败不得覆盖原始 sanitized code；保留 residual。
      }
    }
    throw error;
  } finally {
    if (heartbeatTimer != null) {
      try {
        clearIntervalFn(heartbeatTimer);
      } catch {
        // ignore
      }
    }
    try {
      await releaseOwnedLock(lockPath, lockIdentity, deps);
    } catch {
      // 清理失败不得覆盖主结果；锁残留留给 Task 6 显式恢复。
    }
  }
}

/**
 * 校验 final 的 remote manifest 与文件内容是否与期望一致（不要求 COMPLETED 已存在）。
 */
async function verifyFinalDataAgainstExpected(finalDir, expectedRemote, expectedDigest, boundaryRoot) {
  const remoteRaw = await readJsonIfExists(join(finalDir, 'manifest.json'));
  if (remoteRaw === undefined) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_INTEGRITY_FAILED, 1);
  }
  if (remoteRaw === null) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }

  let remoteManifest;
  try {
    remoteManifest = buildRemoteSnapshotManifest(remoteRaw);
  } catch {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }

  const digest = digestRemoteSnapshotManifest(remoteManifest);
  if (digest !== expectedDigest
    || remoteManifest.snapshotId !== expectedRemote.snapshotId
    || remoteManifest.deviceId !== expectedRemote.deviceId
    || remoteManifest.integrity.totalBytes !== expectedRemote.integrity.totalBytes
    || remoteManifest.files.length !== expectedRemote.files.length) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }

  for (let i = 0; i < expectedRemote.files.length; i++) {
    const expected = expectedRemote.integrity.entries[i];
    const actual = remoteManifest.integrity.entries[i];
    if (!actual
      || actual.path !== expected.path
      || actual.size !== expected.size
      || actual.sha256 !== expected.sha256) {
      throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
    }
  }

  try {
    await verifyTreeFiles(join(finalDir, 'files'), expectedRemote, boundaryRoot);
  } catch (error) {
    if (error instanceof SmbReplicationError) {
      throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
    }
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }
}

async function readAndParseLock(lockPath) {
  const raw = await readJsonIfExists(lockPath);
  if (raw === null) return null;
  if (raw === undefined) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }
  const parsed = parseLockBody(raw);
  if (!parsed) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }
  return parsed;
}

/**
 * 显式恢复 stale lock/staging，或在 final 完整时补写缺失的 COMPLETED.json。
 * 仅在 execute 双门 + recover:true 时运行；永不删除 final。
 */
export async function recoverMountedSmbSnapshot(options, deps = {}) {
  if (!isRecord(options)
    || options.execute !== true
    || options.executionGate !== 'enabled'
    || options.recover !== true
    || !isRecord(options.config)
    || !Array.isArray(options.config.nasTargets)
    || typeof options.targetName !== 'string') {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.EXECUTION_BLOCKED, 2);
  }

  const target = options.config.nasTargets.find((item) => item?.name === options.targetName);
  if (!isRecord(target)
    || target.enabled === false
    || !['synology', 'ugreen'].includes(target.provider)
    || !isRecord(target.mountedShare)
    || target.mountedShare.enabled === false) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.EXECUTION_BLOCKED, 2);
  }
  if (!isSafeDeviceId(options.deviceId) || !isUuidLike(options.snapshotId)) {
    failIntegrity();
  }

  const { mountPath, relativeRoot } = validateMountedShareConfig(target.mountedShare);
  const inspectMount = deps.inspectMount || ((path) => inspectMountedSmb(path, deps));
  const now = deps.now || defaultNow;
  const uuid = deps.randomUUID || randomUUID;

  const readSnapshotManifest = deps.readSnapshotManifest || getSnapshotManifest;
  const localManifest = await readSnapshotManifest(
    options.dataDir,
    options.deviceId,
    options.snapshotId,
  );
  if (!isRecord(localManifest)) failIntegrity();
  if (localManifest.schemaVersion === undefined || localManifest.schemaVersion === 1) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.V2_REQUIRED, 2);
  }

  const remoteManifest = buildRemoteSnapshotManifest(localManifest);
  if (remoteManifest.deviceId !== options.deviceId
    || remoteManifest.snapshotId !== options.snapshotId) {
    failIntegrity();
  }
  const manifestDigest = digestRemoteSnapshotManifest(remoteManifest);
  await verifyLocalSnapshotFiles(options.dataDir, options.deviceId, remoteManifest);

  const mountRoot = await resolveMountRoot(mountPath);
  await preflightMount(inspectMount, mountPath, remoteManifest.integrity.totalBytes);

  const relativeRootPath = join(mountRoot, ...relativeRoot.split('/'));
  // 恢复只检查既有边界，不主动创建控制树。
  await assertExistingSafeDir(mountRoot, relativeRootPath);
  const controlRoot = join(relativeRootPath, '.linke-control');
  const locksDir = join(controlRoot, 'locks', remoteManifest.deviceId);
  const stagingParent = join(
    controlRoot,
    'staging',
    remoteManifest.deviceId,
    remoteManifest.snapshotId,
  );
  const finalDir = join(
    relativeRootPath,
    'devices',
    remoteManifest.deviceId,
    'snapshots',
    remoteManifest.snapshotId,
  );
  const lockPath = join(locksDir, `${remoteManifest.snapshotId}.json`);

  // 读取 lock，绝不覆盖。
  const lockBody = await readAndParseLock(lockPath);
  if (!lockBody) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.RECOVERY_REQUIRED, 3);
  }

  if (lockBody.deviceId !== remoteManifest.deviceId
    || lockBody.snapshotId !== remoteManifest.snapshotId
    || lockBody.manifestDigest !== manifestDigest) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }

  if (!isLockStale(lockBody, now)) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.RECOVERY_REQUIRED, 3);
  }

  const lockIdentity = {
    ownerToken: lockBody.ownerToken,
    attemptId: lockBody.attemptId,
    deviceId: lockBody.deviceId,
    snapshotId: lockBody.snapshotId,
    manifestDigest: lockBody.manifestDigest,
  };

  const finalStat = await lstatExisting(finalDir);
  if (finalStat) {
    if (finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
      throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
    }
    await assertPathInsideMount(mountRoot, finalDir);

    // 完整校验 final 数据；失败 fail-closed，永不删除 final。
    await verifyFinalDataAgainstExpected(
      finalDir,
      remoteManifest,
      manifestDigest,
      mountRoot,
    );

    const completed = await readJsonIfExists(join(finalDir, 'COMPLETED.json'));
    if (completed === undefined) {
      throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
    }
    if (completed === null) {
      const marker = {
        schemaVersion: 1,
        state: 'completed',
        snapshotId: remoteManifest.snapshotId,
        deviceId: remoteManifest.deviceId,
        manifestDigest,
        algorithm: 'sha256',
        fileCount: remoteManifest.files.length,
        totalBytes: remoteManifest.integrity.totalBytes,
        completedAt: now().toISOString(),
        linkeVersion: LINKE_RELEASE_VERSION,
      };
      await atomicWriteCompleted(finalDir, marker, { randomUUID: uuid });
    } else {
      try {
        assertValidCompletedMarker(completed, remoteManifest, manifestDigest);
      } catch {
        throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
      }
    }

    try {
      await releaseOwnedLock(lockPath, lockIdentity, deps);
    } catch {
      // 清理失败不得掩盖已恢复的 final 标记写入成功路径：仍要求 lock identity 匹配才删除。
      // 若删除失败则 residual lock 保留，但 final 已可用。
    }

    // 恢复后 preflight：确认 mount 仍可用。
    await preflightMount(inspectMount, mountPath, remoteManifest.integrity.totalBytes);

    return sanitizedResult({
      state: 'recovered',
      provider: target.provider,
      targetName: target.name,
      deviceId: remoteManifest.deviceId,
      snapshotId: remoteManifest.snapshotId,
      manifestDigest,
      fileCount: remoteManifest.files.length,
      totalBytes: remoteManifest.integrity.totalBytes,
      verifiedFileCount: remoteManifest.files.length,
      attemptId: lockBody.attemptId,
    });
  }

  // 无 final：仅清理匹配的 stale staging + lock。
  const stagingDir = join(stagingParent, lockBody.attemptId);
  const stagingStat = await lstatExisting(stagingDir);
  if (!stagingStat || stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }

  // verifyStagingMetadata — 删除前必须显式校验。
  const attemptMeta = await readJsonIfExists(join(stagingDir, 'attempt.json'));
  if (!isRecord(attemptMeta)
    || attemptMeta.schemaVersion !== 1
    || attemptMeta.attemptId !== lockIdentity.attemptId
    || attemptMeta.ownerToken !== lockIdentity.ownerToken
    || attemptMeta.deviceId !== lockIdentity.deviceId
    || attemptMeta.snapshotId !== lockIdentity.snapshotId
    || attemptMeta.manifestDigest !== lockIdentity.manifestDigest) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }

  // 删除 staging 前再次确认 lock 未变。
  const lockBeforeRemove = await readAndParseLock(lockPath);
  if (!lockBeforeRemove || !lockIdentityMatches(lockBeforeRemove, lockIdentity)) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }

  try {
    await cleanupOwnedStaging(stagingDir, lockIdentity, deps);
  } catch (error) {
    if (error instanceof SmbReplicationError) throw error;
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }

  // 删除后再次确认 lock identity；变化则 abort，保留 residual lock。
  const lockAfterRemove = await readAndParseLock(lockPath);
  if (!lockAfterRemove || !lockIdentityMatches(lockAfterRemove, lockIdentity)) {
    throw new SmbReplicationError(SMB_REPLICATION_CODES.REMOTE_CONFLICT, 1);
  }

  try {
    await releaseOwnedLock(lockPath, lockIdentity, deps);
  } catch {
    // 清理失败不掩盖主结果；若 lock 仍在则下一轮仍可恢复。
  }

  // 恢复后 preflight，确认系统回到可重试态。
  await preflightMount(inspectMount, mountPath, remoteManifest.integrity.totalBytes);

  return sanitizedResult({
    state: 'recovered',
    provider: target.provider,
    targetName: target.name,
    deviceId: remoteManifest.deviceId,
    snapshotId: remoteManifest.snapshotId,
    manifestDigest,
    fileCount: remoteManifest.files.length,
    totalBytes: remoteManifest.integrity.totalBytes,
    verifiedFileCount: remoteManifest.files.length,
    attemptId: lockBody.attemptId,
  });
}
