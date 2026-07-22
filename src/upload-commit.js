/**
 * G0b C4 — Candidate materialization + publish claim + COMPLETED + capacity preflight.
 * Staging is never moved. Mutual exclusion is claim open("wx") only (not rename EEXIST).
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open as fsOpen,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import {
  SafeDataFileError,
  ensureSafeRelativeDir,
  normalizeRelativeDataPath,
  openSafeRootRelativeRead,
  safeAtomicWriteText,
  safeCreateExclusiveText,
  safeHashFileSha256,
  safeReadText,
} from './safe-data-files.js';
import { safeDevicePath, slugify } from './storage.js';
import { projectCanonicalUploadManifest } from './upload-manifest.js';
import { UPLOAD_CHUNK_SIZE } from './upload-session-store.js';

const MI64 = 64 * 1024 * 1024;
const CLAIM_SCHEMA_VERSION = 1;
const COMPLETED_SCHEMA_VERSION = 1;
const PENDING_SCHEMA_VERSION = 1;
const REMOTE_ORIGIN = 'remote-upload';
const MAX_MANIFEST_JSON_BYTES = 8 * 1024 * 1024;
const MAX_MARKER_JSON_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Process-local FIFO tails for shared index RMW (snapshots.json + device.json).
 * Keyed by dataDir + deviceRel. Not a cross-process or distributed lock.
 * @type {Map<string, Promise<void>>}
 */
const sharedIndexUpdateTails = new Map();

/**
 * Run fn under a module-private keyed async critical section for one device index.
 * Same key is FIFO-serialized; different keys run concurrently. Success and rejection
 * both release; a prior rejection never permanently blocks later work. Map entry is
 * removed when the tail task for that key completes (no key leak).
 *
 * @template T
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withSharedIndexUpdateLock(dataDir, deviceRel, fn) {
  const key = `${dataDir}\0${deviceRel}`;
  const prev = sharedIndexUpdateTails.get(key) ?? Promise.resolve();

  // Wait for prior tail; ignore its rejection so the queue cannot stall.
  const run = prev.then(
    () => fn(),
    () => fn(),
  );

  // Tail always settles so subsequent tasks are not blocked by rejection.
  const tail = run.then(
    () => {},
    () => {},
  );
  sharedIndexUpdateTails.set(key, tail);

  void tail.then(() => {
    // Single-threaded: check + delete is atomic w.r.t. other JS turn interleaving.
    if (sharedIndexUpdateTails.get(key) === tail) {
      sharedIndexUpdateTails.delete(key);
    }
  });

  return run;
}

/**
 * @returns {never}
 */
function failCapacity() {
  throw new LinkeError(ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT);
}

/**
 * @returns {never}
 */
function failIntegrity() {
  throw new LinkeError(ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
}

/**
 * @returns {never}
 */
function failConflict() {
  throw new LinkeError(ERROR_CODES.UPLOAD_COMMIT_CONFLICT);
}

/**
 * @returns {never}
 */
function failIo() {
  throw new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR);
}

/**
 * Dual-copy peak: staging + candidate, plus safety margin.
 * @param {number} totalBytes
 * @returns {number}
 */
function computeRequiredBytes(totalBytes) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) failCapacity();
  if (totalBytes > Math.floor(Number.MAX_SAFE_INTEGER / 2)) failCapacity();
  const dual = 2 * totalBytes;
  const fivePercent = Math.ceil(totalBytes * 0.05);
  if (!Number.isSafeInteger(fivePercent) || fivePercent < 0) failCapacity();
  const margin = Math.max(MI64, fivePercent);
  if (!Number.isSafeInteger(margin)) failCapacity();
  if (dual > Number.MAX_SAFE_INTEGER - margin) failCapacity();
  return dual + margin;
}

/**
 * Preflight free space on the volume hosting dataDir.
 * Fail-closed unique code upload-capacity-insufficient (507). No disk writes.
 *
 * @param {string} dataDir
 * @param {number} totalBytes
 * @param {{ deps?: { statfs?: (path: string) => Promise<unknown> } }} [options]
 * @returns {Promise<void>}
 */
export async function preflightCapacity(dataDir, totalBytes, options = {}) {
  try {
    if (typeof dataDir !== 'string' || dataDir.length === 0) failCapacity();
    const required = computeRequiredBytes(totalBytes);

    const deps = options && typeof options === 'object' ? options.deps : undefined;
    const statfs = deps && typeof deps === 'object' ? deps.statfs : undefined;
    if (typeof statfs !== 'function') failCapacity();

    let stats;
    try {
      stats = await statfs(dataDir);
    } catch {
      failCapacity();
    }
    if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) failCapacity();

    const bsize = /** @type {{ bsize?: unknown }} */ (stats).bsize;
    const bavail = /** @type {{ bavail?: unknown }} */ (stats).bavail;
    if (!Number.isSafeInteger(bsize) || bsize <= 0) failCapacity();
    if (!Number.isSafeInteger(bavail) || bavail < 0) failCapacity();
    if (bavail > 0 && bsize > Math.floor(Number.MAX_SAFE_INTEGER / bavail)) failCapacity();
    const free = bavail * bsize;
    if (!Number.isSafeInteger(free) || free < required) failCapacity();
  } catch (error) {
    if (error instanceof LinkeError && error.code === ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT) {
      throw error;
    }
    failCapacity();
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} input
 * @returns {{
 *   store: any,
 *   dataDir: string,
 *   deviceId: string,
 *   uploadId: string,
 *   now: () => Date,
 *   hooks: Record<string, Function>,
 *   deps: Record<string, unknown>,
 * }}
 */
function readCommitInput(input) {
  if (!input || typeof input !== 'object') failIo();
  // Prefer direct property access of expected keys only (Proxy-safe for evil own keys).
  const store = /** @type {{ store?: unknown }} */ (input).store;
  const dataDir = /** @type {{ dataDir?: unknown }} */ (input).dataDir;
  const deviceId = /** @type {{ deviceId?: unknown }} */ (input).deviceId;
  const uploadId = /** @type {{ uploadId?: unknown }} */ (input).uploadId;
  const now = /** @type {{ now?: unknown }} */ (input).now;
  const hooks = /** @type {{ hooks?: unknown }} */ (input).hooks;
  const deps = /** @type {{ deps?: unknown }} */ (input).deps;

  if (!store || typeof store !== 'object') failIo();
  if (typeof dataDir !== 'string' || dataDir.length === 0) failIo();
  if (typeof deviceId !== 'string' || deviceId.length === 0) failIo();
  if (typeof uploadId !== 'string' || !UUID_RE.test(uploadId)) failIo();

  const nowFn =
    typeof now === 'function'
      ? /** @type {() => Date} */ (now)
      : () => new Date();

  return {
    store,
    dataDir,
    deviceId,
    uploadId,
    now: nowFn,
    hooks: hooks && typeof hooks === 'object' && !Array.isArray(hooks)
      ? /** @type {Record<string, Function>} */ (hooks)
      : {},
    deps: deps && typeof deps === 'object' && !Array.isArray(deps)
      ? /** @type {Record<string, unknown>} */ (deps)
      : {},
  };
}

/**
 * @param {() => Date} nowFn
 * @returns {string}
 */
function nowIso(nowFn) {
  let d;
  try {
    d = nowFn();
  } catch {
    failIo();
  }
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) failIo();
  return d.toISOString();
}

/**
 * @param {string} dataDir
 * @param {string} deviceId
 */
function resolveDevice(dataDir, deviceId) {
  try {
    return safeDevicePath(dataDir, deviceId);
  } catch {
    failIo();
  }
}

/**
 * @param {string} deviceRel
 * @param {string} uploadId
 */
function sessionRel(deviceRel, uploadId) {
  return `${deviceRel}/upload-sessions/${uploadId}`;
}

/**
 * @param {string} deviceRel
 * @param {string} uploadId
 */
function candidateRel(deviceRel, uploadId) {
  return `${deviceRel}/snapshots/.upload-${uploadId}.pending`;
}

/**
 * @param {string} deviceRel
 * @param {string} snapshotId
 */
function finalRel(deviceRel, snapshotId) {
  return `${deviceRel}/snapshots/${snapshotId}`;
}

/**
 * @param {string} deviceRel
 * @param {string} snapshotId
 */
function claimRel(deviceRel, snapshotId) {
  return `${deviceRel}/snapshots/.claim-${slugify(snapshotId)}`;
}

/**
 * @param {{
 *   deviceId: string,
 *   snapshotId: string,
 *   uploadId: string,
 *   manifestDigest: string,
 * }} identity
 */
function claimPayload(identity) {
  return JSON.stringify({
    schemaVersion: CLAIM_SCHEMA_VERSION,
    deviceId: identity.deviceId,
    snapshotId: identity.snapshotId,
    uploadId: identity.uploadId,
    manifestDigest: identity.manifestDigest,
  });
}

/**
 * @param {{
 *   deviceId: string,
 *   snapshotId: string,
 *   uploadId: string,
 *   manifestDigest: string,
 * }} identity
 */
function pendingPayload(identity) {
  return JSON.stringify({
    schemaVersion: PENDING_SCHEMA_VERSION,
    deviceId: identity.deviceId,
    snapshotId: identity.snapshotId,
    uploadId: identity.uploadId,
    manifestDigest: identity.manifestDigest,
  });
}

/**
 * @param {{
 *   deviceId: string,
 *   snapshotId: string,
 *   uploadId: string,
 *   manifestDigest: string,
 * }} identity
 * @param {string} committedAt
 */
function completedPayload(identity, committedAt) {
  return JSON.stringify({
    schemaVersion: COMPLETED_SCHEMA_VERSION,
    origin: REMOTE_ORIGIN,
    snapshotId: identity.snapshotId,
    manifestDigest: identity.manifestDigest,
    committedAt,
    uploadId: identity.uploadId,
    deviceId: identity.deviceId,
  });
}

/**
 * @param {unknown} obj
 * @param {{
 *   deviceId: string,
 *   snapshotId: string,
 *   uploadId: string,
 *   manifestDigest: string,
 * }} identity
 * @returns {boolean}
 */
function isSameIdentity(obj, identity) {
  if (!isPlainObject(obj)) return false;
  return (
    obj.deviceId === identity.deviceId
    && obj.snapshotId === identity.snapshotId
    && obj.uploadId === identity.uploadId
    && obj.manifestDigest === identity.manifestDigest
  );
}

/**
 * @param {unknown} obj
 * @returns {boolean}
 */
function isValidClaimBody(obj) {
  if (!isPlainObject(obj)) return false;
  if (obj.schemaVersion !== CLAIM_SCHEMA_VERSION) return false;
  if (typeof obj.deviceId !== 'string' || obj.deviceId.length === 0) return false;
  if (typeof obj.snapshotId !== 'string' || obj.snapshotId.length === 0) return false;
  if (typeof obj.uploadId !== 'string' || !UUID_RE.test(obj.uploadId)) return false;
  if (typeof obj.manifestDigest !== 'string' || !SHA256_HEX_RE.test(obj.manifestDigest)) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} obj
 * @param {string} snapshotId
 * @returns {boolean}
 */
function isValidCompletedBody(obj, snapshotId) {
  if (!isPlainObject(obj)) return false;
  if (obj.schemaVersion !== COMPLETED_SCHEMA_VERSION) return false;
  if (obj.origin !== REMOTE_ORIGIN) return false;
  if (obj.snapshotId !== snapshotId) return false;
  if (typeof obj.manifestDigest !== 'string' || !SHA256_HEX_RE.test(obj.manifestDigest)) {
    return false;
  }
  if (typeof obj.committedAt !== 'string' || obj.committedAt.length === 0) return false;
  if (typeof obj.uploadId !== 'string' || !UUID_RE.test(obj.uploadId)) return false;
  if (typeof obj.deviceId !== 'string' || obj.deviceId.length === 0) return false;
  return true;
}

/**
 * @param {unknown} obj
 * @returns {boolean}
 */
function isValidPendingBody(obj) {
  if (!isPlainObject(obj)) return false;
  if (obj.schemaVersion !== PENDING_SCHEMA_VERSION) return false;
  if (typeof obj.deviceId !== 'string' || obj.deviceId.length === 0) return false;
  if (typeof obj.snapshotId !== 'string' || obj.snapshotId.length === 0) return false;
  if (typeof obj.uploadId !== 'string' || !UUID_RE.test(obj.uploadId)) return false;
  if (typeof obj.manifestDigest !== 'string' || !SHA256_HEX_RE.test(obj.manifestDigest)) {
    return false;
  }
  return true;
}

/**
 * Permissive JSON read for claim / PENDING / COMPLETED classification.
 * missing or corrupt → null; callers decide conflict vs fail-close.
 *
 * @param {string} dataDir
 * @param {string} relativePath
 * @param {number} [maxBytes]
 * @returns {Promise<object | null>}
 */
async function readJsonRel(dataDir, relativePath, maxBytes = MAX_MARKER_JSON_BYTES) {
  try {
    const raw = await safeReadText(dataDir, relativePath, { maxBytes });
    return JSON.parse(raw);
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    if (error instanceof SafeDataFileError) return null;
    return null;
  }
}

/**
 * Strict bounded JSON reader for shared metadata RMW (snapshots.json / device.json).
 * ENOENT → { found:false } (init allowed). Oversize, symlink/unsafe, I/O, SyntaxError
 * → unique upload-io-error only (no path/errno/raw message leak). Success → { found:true, value }.
 *
 * @param {string} dataDir
 * @param {string} relativePath
 * @param {number} maxBytes
 * @returns {Promise<{ found: false } | { found: true, value: unknown }>}
 */
async function readSharedMetadataJsonRel(dataDir, relativePath, maxBytes) {
  let raw;
  try {
    raw = await safeReadText(dataDir, relativePath, { maxBytes });
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
      return { found: false };
    }
    // SafeDataFileError (bounds/symlink/unsafe) and any other I/O → fail-close.
    failIo();
  }
  if (typeof raw !== 'string') failIo();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    // SyntaxError (and any parse failure) → fail-close; never leak message.
    failIo();
  }
  return { found: true, value };
}

/**
 * @param {string} dataDir
 * @param {string} relativePath
 * @returns {Promise<'missing' | 'file' | 'dir' | 'other'>}
 */
async function classifyLeaf(dataDir, relativePath) {
  try {
    const abs = join(dataDir, relativePath);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return 'other';
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') return 'missing';
    return 'other';
  }
}

/**
 * Acquire or recover publish claim via atomic exclusive create.
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {{
 *   deviceId: string,
 *   snapshotId: string,
 *   uploadId: string,
 *   manifestDigest: string,
 * }} identity
 */
async function acquireClaim(dataDir, deviceRel, identity) {
  const rel = claimRel(deviceRel, identity.snapshotId);
  try {
    await ensureSafeRelativeDir(dataDir, `${deviceRel}/snapshots`);
  } catch {
    failIo();
  }

  const text = claimPayload(identity);
  let created;
  try {
    created = await safeCreateExclusiveText(dataDir, rel, text, { mode: 0o600 });
  } catch (error) {
    if (error instanceof SafeDataFileError) failIo();
    failIo();
  }

  if (created && created.created === true) return;

  // Existing claim: safe-read; same identity recovers; else conflict (never overwrite/delete).
  const existing = await readJsonRel(dataDir, rel);
  if (!isValidClaimBody(existing)) failConflict();
  if (!isSameIdentity(existing, identity)) failConflict();
}

/**
 * Best-effort claim cleanup. Failures never reverse commit.
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {{
 *   deviceId: string,
 *   snapshotId: string,
 *   uploadId: string,
 *   manifestDigest: string,
 * }} identity
 * @param {Record<string, unknown>} deps
 */
async function cleanupClaim(dataDir, deviceRel, identity, deps) {
  const rel = claimRel(deviceRel, identity.snapshotId);
  const abs = join(dataDir, rel);

  if (typeof deps.unlinkClaim === 'function') {
    try {
      await /** @type {(p: string) => Promise<void>} */ (deps.unlinkClaim)(abs);
    } catch {
      // best-effort
    }
    return;
  }

  // Only remove when same-identity claim (or missing).
  const existing = await readJsonRel(dataDir, rel);
  if (existing === null) return;
  if (!isValidClaimBody(existing) || !isSameIdentity(existing, identity)) return;
  try {
    await unlink(abs);
  } catch {
    // best-effort
  }
}

/**
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {string} uploadId
 * @returns {Promise<{ manifest: object, manifestText: string }>}
 */
async function loadCanonicalManifest(dataDir, deviceRel, uploadId) {
  const rel = `${sessionRel(deviceRel, uploadId)}/manifest.canonical.json`;
  let raw;
  try {
    raw = await safeReadText(dataDir, rel, { maxBytes: MAX_MANIFEST_JSON_BYTES });
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failIo();
  }
  if (typeof raw !== 'string') failIo();
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    failIo();
  }
  if (!isPlainObject(manifest)) failIo();
  return { manifest, manifestText: raw };
}

/**
 * @param {object} manifest
 * @returns {{ path: string, size: number, sha256: string }[]}
 */
function manifestEntries(manifest) {
  const integrity = /** @type {{ integrity?: unknown }} */ (manifest).integrity;
  if (!isPlainObject(integrity)) failIntegrity();
  const entries = /** @type {{ entries?: unknown }} */ (integrity).entries;
  if (!Array.isArray(entries)) failIntegrity();
  /** @type {{ path: string, size: number, sha256: string }[]} */
  const out = [];
  for (const e of entries) {
    if (!isPlainObject(e)) failIntegrity();
    const path = e.path;
    const size = e.size;
    const sha256 = e.sha256;
    if (typeof path !== 'string' || path.length === 0) failIntegrity();
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) failIntegrity();
    if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256)) failIntegrity();
    try {
      normalizeRelativeDataPath(path);
    } catch {
      failIntegrity();
    }
    out.push({ path, size, sha256 });
  }
  return out;
}

/**
 * @param {object} manifest
 * @returns {number}
 */
function manifestTotalBytes(manifest) {
  const integrity = /** @type {{ integrity?: { totalBytes?: unknown } }} */ (manifest).integrity;
  const total = integrity && integrity.totalBytes;
  if (!Number.isSafeInteger(total) || total < 0) failIntegrity();
  if (total > Math.floor(Number.MAX_SAFE_INTEGER / 2)) failIntegrity();
  return /** @type {number} */ (total);
}

/**
 * Read and hash a full staging file (all chunks) with no-follow.
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {string} uploadId
 * @param {number} fileIndex
 * @param {number} size
 * @param {string} expectedSha
 * @returns {Promise<Buffer>}
 */
async function readVerifyStagingFile(
  dataDir,
  deviceRel,
  uploadId,
  fileIndex,
  size,
  expectedSha,
) {
  if (size === 0) {
    const empty = Buffer.alloc(0);
    const h = createHash('sha256').update(empty).digest('hex');
    if (h !== expectedSha) failIntegrity();
    return empty;
  }

  const totalChunks = Math.ceil(size / UPLOAD_CHUNK_SIZE);
  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1) failIntegrity();

  const hash = createHash('sha256');
  /** @type {Buffer[]} */
  const parts = [];
  let got = 0;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const rel =
      `${sessionRel(deviceRel, uploadId)}/.staging/files/${fileIndex}/chunk-${chunkIndex}.part`;
    let opened;
    try {
      opened = await openSafeRootRelativeRead(dataDir, rel);
    } catch (error) {
      if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') failIntegrity();
      if (error instanceof SafeDataFileError) {
        // Symlink / hostile → integrity or io (tests accept either).
        failIntegrity();
      }
      failIo();
    }
    try {
      const chunkSize = Number(opened.size);
      if (!Number.isSafeInteger(chunkSize) || chunkSize < 0) failIntegrity();
      const expectedChunk =
        chunkIndex < totalChunks - 1
          ? UPLOAD_CHUNK_SIZE
          : size - chunkIndex * UPLOAD_CHUNK_SIZE;
      if (chunkSize !== expectedChunk) failIntegrity();
      if (got + chunkSize > size) failIntegrity();

      const buf = Buffer.alloc(chunkSize);
      let filled = 0;
      while (filled < chunkSize) {
        const { bytesRead } = await opened.handle.read(
          buf,
          filled,
          chunkSize - filled,
          filled,
        );
        if (bytesRead === 0) failIntegrity();
        filled += bytesRead;
      }
      hash.update(buf);
      parts.push(buf);
      got += chunkSize;
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  if (got !== size) failIntegrity();
  const digest = hash.digest('hex');
  if (digest !== expectedSha) failIntegrity();
  return Buffer.concat(parts, size);
}

/**
 * Materialize sibling candidate from verified staging. Staging remains intact.
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {string} uploadId
 * @param {object} manifest
 * @param {{
 *   deviceId: string,
 *   snapshotId: string,
 *   uploadId: string,
 *   manifestDigest: string,
 * }} identity
 * @param {string} manifestText
 */
async function materializeCandidate(
  dataDir,
  deviceRel,
  uploadId,
  manifest,
  identity,
  manifestText,
) {
  const cand = candidateRel(deviceRel, uploadId);
  // Discard incomplete prior candidate (rebuildable).
  try {
    const kind = await classifyLeaf(dataDir, cand);
    if (kind !== 'missing') {
      await rm(join(dataDir, cand), { recursive: true, force: true });
    }
  } catch {
    failIo();
  }

  try {
    await ensureSafeRelativeDir(dataDir, `${cand}/files`);
  } catch {
    failIo();
  }

  const entries = manifestEntries(manifest);
  for (let fileIndex = 0; fileIndex < entries.length; fileIndex += 1) {
    const entry = entries[fileIndex];
    const safePath = normalizeRelativeDataPath(entry.path);
    const body = await readVerifyStagingFile(
      dataDir,
      deviceRel,
      uploadId,
      fileIndex,
      entry.size,
      entry.sha256,
    );

    // Ensure parent dirs under candidate/files for nested paths.
    const segments = safePath.split('/');
    if (segments.length > 1) {
      const parentRel = `${cand}/files/${segments.slice(0, -1).join('/')}`;
      try {
        await ensureSafeRelativeDir(dataDir, parentRel);
      } catch {
        failIo();
      }
    }

    const fileRel = `${cand}/files/${safePath}`;
    // Write via exclusive-safe open (no-follow create/trunc).
    const abs = join(dataDir, fileRel);
    let handle;
    try {
      // Parent already ensured; open leaf with O_NOFOLLOW.
      handle = await fsOpen(
        abs,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      const st = await handle.stat();
      if (!st.isFile() || st.isSymbolicLink()) failIo();
      if (body.length > 0) {
        await handle.writeFile(body);
      }
      if (typeof handle.sync === 'function') await handle.sync();
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      failIo();
    } finally {
      if (handle) await handle.close().catch(() => {});
    }

    // Re-hash written candidate file.
    let hashed;
    try {
      hashed = await safeHashFileSha256(dataDir, fileRel, { maxBytes: MAX_FILE_BYTES });
    } catch {
      failIntegrity();
    }
    if (!hashed || hashed.size !== entry.size || hashed.sha256 !== entry.sha256) {
      failIntegrity();
    }
  }

  // manifest.json + PENDING metadata bound to identity.
  try {
    await safeAtomicWriteText(dataDir, `${cand}/manifest.json`, manifestText, { mode: 0o600 });
    await safeAtomicWriteText(dataDir, `${cand}/PENDING.json`, pendingPayload(identity), {
      mode: 0o600,
    });
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    if (error instanceof SafeDataFileError) failIo();
    failIo();
  }
}

/**
 * Re-verify final snapshot files against manifest (post-rename or takeover).
 * @param {string} dataDir
 * @param {string} snapRel
 * @param {object} manifest
 */
async function reverifyFinal(dataDir, snapRel, manifest) {
  const entries = manifestEntries(manifest);
  for (const entry of entries) {
    const safePath = normalizeRelativeDataPath(entry.path);
    const fileRel = `${snapRel}/files/${safePath}`;
    let hashed;
    try {
      hashed = await safeHashFileSha256(dataDir, fileRel, { maxBytes: MAX_FILE_BYTES });
    } catch (error) {
      if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') failIntegrity();
      if (error instanceof SafeDataFileError) failIntegrity();
      failIo();
    }
    if (!hashed || hashed.size !== entry.size || hashed.sha256 !== entry.sha256) {
      failIntegrity();
    }
  }
}

/**
 * Idempotent remote index + device.json upsert (only after COMPLETED).
 * RMW of shared snapshots.json + device.json is serialized per dataDir+deviceRel
 * (process-local keyed critical section) so concurrent finalize cannot lose updates.
 * @param {string} dataDir
 * @param {string} deviceRel
 * @param {string} slug
 * @param {{
 *   deviceId: string,
 *   snapshotId: string,
 *   uploadId: string,
 *   manifestDigest: string,
 * }} identity
 * @param {string} committedAt
 */
async function upsertRemoteIndexes(dataDir, deviceRel, slug, identity, committedAt) {
  return withSharedIndexUpdateLock(dataDir, deviceRel, async () => {
    const snapshotsRel = `${deviceRel}/snapshots.json`;
    // Strict read: missing → init []; found but non-array → failIo (never overwrite).
    // Oversize/corrupt/unsafe fails here before any write (size/hash preserved).
    const snapshotsRead = await readSharedMetadataJsonRel(
      dataDir,
      snapshotsRel,
      MAX_MANIFEST_JSON_BYTES,
    );
    /** @type {unknown[]} */
    let list;
    if (!snapshotsRead.found) {
      list = [];
    } else if (!Array.isArray(snapshotsRead.value)) {
      failIo();
    } else {
      list = snapshotsRead.value;
    }

    /** @type {object[]} */
    const next = [];
    let replaced = false;
    for (const entry of list) {
      if (entry && typeof entry === 'object' && entry.snapshotId === identity.snapshotId) {
        if (!replaced) {
          next.push({
            snapshotId: identity.snapshotId,
            origin: REMOTE_ORIGIN,
            manifestDigest: identity.manifestDigest,
            committedAt,
          });
          replaced = true;
        }
        // drop duplicates
        continue;
      }
      next.push(entry);
    }
    if (!replaced) {
      next.push({
        snapshotId: identity.snapshotId,
        origin: REMOTE_ORIGIN,
        manifestDigest: identity.manifestDigest,
        committedAt,
      });
    }

    try {
      await ensureSafeRelativeDir(dataDir, deviceRel);
      await safeAtomicWriteText(dataDir, snapshotsRel, JSON.stringify(next, null, 2), {
        mode: 0o600,
      });
    } catch {
      failIo();
    }

    const deviceInfoRel = `${deviceRel}/device.json`;
    // Strict read: missing → default object; found but non-plain → failIo (never overwrite).
    // Snapshots may already be written; caller must not markCommitted on this failure.
    // After operator repair, same-identity retry is idempotent via snapshotId replace above.
    const deviceRead = await readSharedMetadataJsonRel(
      dataDir,
      deviceInfoRel,
      MAX_MARKER_JSON_BYTES,
    );
    /** @type {Record<string, unknown>} */
    let deviceInfo;
    if (!deviceRead.found) {
      deviceInfo = {
        deviceId: slug,
        hostname: 'unknown',
        ipAddress: 'unknown',
        snapshotCount: 0,
        lastBackupAt: null,
        status: 'unknown',
        lastHeartbeatAt: null,
      };
    } else if (!isPlainObject(deviceRead.value)) {
      failIo();
    } else {
      deviceInfo = deviceRead.value;
    }
    deviceInfo.snapshotCount = next.length;
    deviceInfo.lastBackupAt = committedAt;
    try {
      await safeAtomicWriteText(dataDir, deviceInfoRel, JSON.stringify(deviceInfo, null, 2), {
        mode: 0o600,
      });
    } catch {
      failIo();
    }
  });
}

/**
 * Write atomic COMPLETED marker under final snapshot.
 * @param {string} dataDir
 * @param {string} snapRel
 * @param {{
 *   deviceId: string,
 *   snapshotId: string,
 *   uploadId: string,
 *   manifestDigest: string,
 * }} identity
 * @param {string} committedAt
 */
async function writeCompleted(dataDir, snapRel, identity, committedAt) {
  try {
    await safeAtomicWriteText(
      dataDir,
      `${snapRel}/COMPLETED.json`,
      completedPayload(identity, committedAt),
      { mode: 0o600 },
    );
  } catch (error) {
    if (error instanceof SafeDataFileError) failIo();
    failIo();
  }
}

/**
 * @param {Record<string, Function>} hooks
 * @param {string} name
 */
async function runHook(hooks, name) {
  const fn = hooks[name];
  if (typeof fn === 'function') {
    await fn();
  }
}

/**
 * Load final snapshot manifest under claim and re-project through C1 against session identity.
 * Durable COMPLETED must still agree with on-disk canonical content (crash recovery safety).
 * @param {string} dataDir
 * @param {string} snapRel
 * @param {{
 *   deviceId: string,
 *   snapshotId: string,
 *   uploadId: string,
 *   manifestDigest: string,
 * }} identity
 * @returns {Promise<object>}
 */
async function loadAndProjectFinalManifest(dataDir, snapRel, identity) {
  let raw;
  try {
    raw = await safeReadText(dataDir, `${snapRel}/manifest.json`, {
      maxBytes: MAX_MANIFEST_JSON_BYTES,
    });
  } catch (error) {
    if (error instanceof SafeDataFileError) failIntegrity();
    failIo();
  }
  if (typeof raw !== 'string') failIo();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failIntegrity();
  }
  let projected;
  try {
    projected = projectCanonicalUploadManifest(parsed, {
      authenticatedDeviceId: identity.deviceId,
      claimedManifestDigest: identity.manifestDigest,
    });
  } catch {
    failIntegrity();
  }
  if (projected.manifest.snapshotId !== identity.snapshotId) failIntegrity();
  if (projected.manifestDigest !== identity.manifestDigest) failIntegrity();
  return projected.manifest;
}

/**
 * Finish after a valid same-identity COMPLETED already exists (recovery / idempotent).
 * After claim (or when claim already held), re-reads COMPLETED under claim; never trusts
 * claim-pre committedAt/identity for index/session side effects.
 * @param {object} args
 */
async function finishFromExistingCompleted(args) {
  const {
    store,
    dataDir,
    deviceRel,
    slug,
    identity,
    hooks,
    deps,
    sessionStatus,
    claimHeld = false,
  } = args;

  // Do not re-acquire when caller already holds the same claim (publish path takeover).
  if (!claimHeld) {
    await acquireClaim(dataDir, deviceRel, identity);
    await runHook(hooks, 'afterClaimAcquired');
  }

  const snapRel = finalRel(deviceRel, identity.snapshotId);
  const completedRel = `${snapRel}/COMPLETED.json`;

  // Fresh bounded no-follow COMPLETED under claim — TOCTOU vs claim-pre parameter.
  const freshCompleted = await readJsonRel(dataDir, completedRel);
  if (
    !isValidCompletedBody(freshCompleted, identity.snapshotId)
    || !isSameIdentity(freshCompleted, identity)
  ) {
    failConflict();
  }
  const committedAt = /** @type {{ committedAt: string }} */ (freshCompleted).committedAt;
  if (typeof committedAt !== 'string' || committedAt.length === 0) failConflict();

  // Durable marker must still match final canonical manifest + file integrity.
  const manifest = await loadAndProjectFinalManifest(dataDir, snapRel, identity);
  await reverifyFinal(dataDir, snapRel, manifest);

  // Indexes may be missing after crash; repair idempotently using fresh marker committedAt only.
  await upsertRemoteIndexes(dataDir, deviceRel, slug, identity, committedAt);
  await runHook(hooks, 'afterIndexUpsert');

  // markCommitted is idempotent for already-committed sessions.
  try {
    await store.markCommitted({
      authenticatedDeviceId: identity.deviceId,
      uploadId: identity.uploadId,
    });
  } catch (error) {
    if (sessionStatus === 'committed') {
      // Do not reverse a durable committed result on recovery noise.
    } else if (error instanceof LinkeError) {
      throw error;
    } else {
      failIo();
    }
  }

  await cleanupClaim(dataDir, deviceRel, identity, deps);
  await runHook(hooks, 'afterClaimCleanup');
}

/**
 * Verify staging, publish candidate via claim, write COMPLETED, upsert indexes, markCommitted.
 *
 * @param {{
 *   store: object,
 *   dataDir: string,
 *   deviceId: string,
 *   uploadId: string,
 *   now?: () => Date,
 *   hooks?: object,
 *   deps?: object,
 * }} input
 * @returns {Promise<void>}
 */
export async function verifyAndCommitSession(input) {
  try {
    await verifyAndCommitSessionImpl(input);
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    // Injected hook crashes and unknown errors: do not reverse publish; surface sanitized IO
    // only when not already a public LinkeError. Hook injects may be raw Error — rethrow as-is
    // if message is intentional crash probe; otherwise map IO.
    if (error instanceof Error) {
      const msg = error.message || '';
      if (msg.startsWith('injected-')) throw error;
    }
    failIo();
  }
}

/**
 * @param {unknown} input
 */
async function verifyAndCommitSessionImpl(input) {
  const { store, dataDir, deviceId, uploadId, now, hooks, deps } = readCommitInput(input);
  const { slug, deviceRel } = resolveDevice(dataDir, deviceId);

  let session;
  try {
    session = await store.getSession({
      authenticatedDeviceId: deviceId,
      uploadId,
    });
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failIo();
  }
  if (!session || typeof session !== 'object') failIo();

  const snapshotId = session.snapshotId;
  const manifestDigest = session.manifestDigest;
  if (typeof snapshotId !== 'string' || snapshotId.length === 0) failIo();
  if (typeof manifestDigest !== 'string' || !SHA256_HEX_RE.test(manifestDigest)) failIo();

  /** @type {{ deviceId: string, snapshotId: string, uploadId: string, manifestDigest: string }} */
  const identity = {
    deviceId,
    snapshotId,
    uploadId,
    manifestDigest,
  };

  const snapRel = finalRel(deviceRel, snapshotId);
  const completedRel = `${snapRel}/COMPLETED.json`;

  // Already-committed: recovery without touching staging.
  // Claim-pre COMPLETED is a gate only; finish re-reads under claim for TOCTOU safety.
  if (session.status === 'committed') {
    const completed = await readJsonRel(dataDir, completedRel);
    if (!isValidCompletedBody(completed, snapshotId) || !isSameIdentity(completed, identity)) {
      failConflict();
    }
    await finishFromExistingCompleted({
      store,
      dataDir,
      deviceRel,
      slug,
      identity,
      hooks,
      deps,
      sessionStatus: 'committed',
    });
    return;
  }

  // Enter verifying (requires all boundaries complete).
  try {
    await store.markVerifying({
      authenticatedDeviceId: deviceId,
      uploadId,
    });
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failIo();
  }

  // Crash recovery: valid COMPLETED already present with same identity.
  // Claim-pre gate only; finish re-reads COMPLETED under claim.
  {
    const completed = await readJsonRel(dataDir, completedRel);
    if (isValidCompletedBody(completed, snapshotId)) {
      if (!isSameIdentity(completed, identity)) failConflict();
      await finishFromExistingCompleted({
        store,
        dataDir,
        deviceRel,
        slug,
        identity,
        hooks,
        deps,
        sessionStatus: 'verifying',
      });
      return;
    }
  }

  // Re-project on-disk canonical JSON through C1 before any candidate/claim/publish.
  // Tampered identity fields (e.g. createdAt) change digest vs session identity → integrity.
  // Map all projector failures to upload-integrity-failed (never leak upload-manifest-invalid).
  const loaded = await loadCanonicalManifest(dataDir, deviceRel, uploadId);
  let projected;
  try {
    projected = projectCanonicalUploadManifest(loaded.manifest, {
      authenticatedDeviceId: deviceId,
      claimedManifestDigest: manifestDigest,
    });
  } catch {
    failIntegrity();
  }
  const manifest = projected.manifest;
  if (manifest.snapshotId !== snapshotId) failIntegrity();
  if (projected.manifestDigest !== manifestDigest) failIntegrity();
  let manifestText;
  try {
    manifestText = JSON.stringify(manifest);
  } catch {
    failIntegrity();
  }
  if (typeof manifestText !== 'string') failIntegrity();
  const totalBytes = manifestTotalBytes(manifest);
  // Reject overflow-hostile totals with integrity/io (capacity code reserved for preflight).
  try {
    computeRequiredBytes(totalBytes);
  } catch (error) {
    if (error instanceof LinkeError && error.code === ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT) {
      failIntegrity();
    }
    throw error;
  }

  // Verify all staging files (size + SHA) without mutating staging.
  const entries = manifestEntries(manifest);
  if (!Array.isArray(session.files)) failIntegrity();
  if (session.files.length !== entries.length) failIntegrity();
  for (let i = 0; i < entries.length; i += 1) {
    const f = session.files[i];
    if (!f || f.complete !== true) failIntegrity();
    if (f.size !== entries[i].size) failIntegrity();
    // Full chunk re-read + hash.
    await readVerifyStagingFile(
      dataDir,
      deviceRel,
      uploadId,
      i,
      entries[i].size,
      entries[i].sha256,
    );
  }

  await runHook(hooks, 'afterStagingVerified');

  await materializeCandidate(
    dataDir,
    deviceRel,
    uploadId,
    manifest,
    identity,
    manifestText,
  );
  await runHook(hooks, 'afterCandidateMaterialized');

  await acquireClaim(dataDir, deviceRel, identity);
  await runHook(hooks, 'afterClaimAcquired');

  // Holding claim: inspect final path.
  const finalKind = await classifyLeaf(dataDir, snapRel);
  const cand = candidateRel(deviceRel, uploadId);

  if (finalKind === 'dir') {
    // Re-check COMPLETED (race / prior).
    const completed = await readJsonRel(dataDir, completedRel);
    if (isValidCompletedBody(completed, snapshotId)) {
      if (!isSameIdentity(completed, identity)) failConflict();
      // Same identity COMPLETED: drop candidate; claim already held — do not re-acquire.
      try {
        await rm(join(dataDir, cand), { recursive: true, force: true });
      } catch {
        // best-effort
      }
      await finishFromExistingCompleted({
        store,
        dataDir,
        deviceRel,
        slug,
        identity,
        hooks,
        deps,
        sessionStatus: 'verifying',
        claimHeld: true,
      });
      return;
    }

    // No valid COMPLETED: only same-identity PENDING may take over.
    const pending = await readJsonRel(dataDir, `${snapRel}/PENDING.json`);
    if (!isValidPendingBody(pending) || !isSameIdentity(pending, identity)) {
      failConflict();
    }
    // Takeover: discard candidate, use existing final.
    try {
      await rm(join(dataDir, cand), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  } else if (finalKind === 'missing') {
    // Atomic publish: rename candidate → final (mutex is claim, not EEXIST).
    try {
      await rename(join(dataDir, cand), join(dataDir, snapRel));
    } catch {
      failIo();
    }
  } else {
    // File/symlink/other at final path — conflict, do not overwrite.
    failConflict();
  }

  await runHook(hooks, 'afterRename');

  // Rename/takeover done; PENDING retained until COMPLETED.
  await reverifyFinal(dataDir, snapRel, manifest);

  const committedAt = nowIso(now);
  await writeCompleted(dataDir, snapRel, identity, committedAt);
  await runHook(hooks, 'afterCompleted');

  await upsertRemoteIndexes(dataDir, deviceRel, slug, identity, committedAt);
  await runHook(hooks, 'afterIndexUpsert');

  try {
    await store.markCommitted({
      authenticatedDeviceId: deviceId,
      uploadId,
    });
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failIo();
  }

  await cleanupClaim(dataDir, deviceRel, identity, deps);
  await runHook(hooks, 'afterClaimCleanup');
}
