import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { getSnapshotManifest } from './storage.js';

const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_ID_PATTERN = /^[a-z0-9._-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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
