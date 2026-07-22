/**
 * G0b C2 — Persistent upload session store (TTL / terminal / reconcile).
 * Layout: dataDir/repo/devices/<slug>/upload-sessions/<server-uuid>/
 * All lookups are scoped by authenticated deviceId. No global uploadId search.
 */

import { randomUUID as defaultRandomUUID } from 'node:crypto';
import { readdir as defaultReaddir } from 'node:fs/promises';
import {
  SafeDataFileError,
  assertSafeExistingRelativeDir,
  ensureSafeRelativeDir,
  safeAtomicWriteText,
  safeCreateExclusiveText,
  safeHashFileSha256,
  safeReadText,
} from './safe-data-files.js';
import { safeDevicePath } from './storage.js';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { projectCanonicalUploadManifest } from './upload-manifest.js';

/** Fixed 24h wall-clock TTL from createdAt (design §4.3). */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Fixed chunk size (design §6.1). */
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

/** @type {ReadonlyArray<'initialized' | 'receiving' | 'verifying'>} */
export const ACTIVE_NONTERMINAL_STATUSES = Object.freeze([
  'initialized',
  'receiving',
  'verifying',
]);

/** @type {ReadonlyArray<'committed' | 'aborted'>} */
export const TERMINAL_STATUSES = Object.freeze(['committed', 'aborted']);

/** @type {ReadonlyArray<string>} */
export const SESSION_STATUSES = Object.freeze([
  ...ACTIVE_NONTERMINAL_STATUSES,
  ...TERMINAL_STATUSES,
]);

const SESSION_SCHEMA_VERSION = 1;
const MAX_SESSION_DIRS = 4096;
/**
 * Session record hard cap. Aligned with C1: up to 100_000 files and ≤8 MiB
 * canonical manifest. 1 MiB is insufficient (~10k boundaries); 16 MiB leaves
 * headroom for worst-case boundary fields while remaining bounded (safeReadText
 * maxBytes always explicit — never unbounded).
 */
const MAX_SESSION_JSON_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_JSON_BYTES = 8 * 1024 * 1024;
const MAX_BOUNDARIES = 100_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
/** Stored session timestamps: exact millisecond UTC ISO (calendar-canonical). */
const CANONICAL_ISO_MS_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

const SESSION_KEYS = Object.freeze([
  'schemaVersion',
  'uploadId',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'status',
  'createdAt',
  'expiresAt',
  'updatedAt',
  'fileCount',
  'totalBytes',
  'boundaries',
]);
const BOUNDARY_KEYS = Object.freeze([
  'fileIndex',
  'size',
  'confirmedBytes',
  'confirmedChunks',
  'complete',
]);

const ACTIVE_SET = new Set(ACTIVE_NONTERMINAL_STATUSES);
const TERMINAL_SET = new Set(TERMINAL_STATUSES);
const STATUS_SET = new Set(SESSION_STATUSES);

/**
 * @param {unknown} session
 * @param {Date | number} [now]
 * @returns {boolean}
 */
export function isExpiredSession(session, now = Date.now()) {
  if (!session || typeof session !== 'object') return true;
  const createdAt = /** @type {{ createdAt?: unknown }} */ (session).createdAt;
  if (typeof createdAt !== 'string') return true;
  const createdMs = Date.parse(createdAt);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) return true;
  if (nowMs < createdMs) return true;
  return nowMs >= createdMs + UPLOAD_SESSION_TTL_MS;
}

/**
 * Active nonterminal = status ∈ {initialized,receiving,verifying} AND not expired.
 * @param {unknown} session
 * @param {Date | number} [now]
 * @returns {boolean}
 */
export function isActiveNonterminal(session, now = Date.now()) {
  if (!session || typeof session !== 'object') return false;
  const status = /** @type {{ status?: unknown }} */ (session).status;
  if (typeof status !== 'string' || !ACTIVE_SET.has(status)) return false;
  return !isExpiredSession(session, now);
}

/**
 * @returns {never}
 */
function failIo() {
  throw new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR);
}

/**
 * @returns {never}
 */
function failNotFound() {
  throw new LinkeError(ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
}

/**
 * @returns {never}
 */
function failExpired() {
  throw new LinkeError(ERROR_CODES.UPLOAD_SESSION_EXPIRED);
}

/**
 * @returns {never}
 */
function failCommitConflict() {
  throw new LinkeError(ERROR_CODES.UPLOAD_COMMIT_CONFLICT);
}

/**
 * @returns {never}
 */
function failChunkInvalid() {
  throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID);
}

/**
 * @returns {never}
 */
function failChunkOutOfOrder() {
  throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER);
}

/**
 * @param {{
 *   uploadId: string,
 *   status: string,
 *   snapshotId: string,
 *   manifestDigest: string,
 * }} active
 * @returns {never}
 */
function failConflict(active) {
  const err = new LinkeError(ERROR_CODES.UPLOAD_SESSION_CONFLICT);
  err.details = Object.freeze({
    active: Object.freeze({
      uploadId: active.uploadId,
      status: active.status,
      snapshotId: active.snapshotId,
      manifestDigest: active.manifestDigest,
    }),
  });
  throw err;
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
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {unknown[] | null}
 */
function readDenseArray(value, maxLength) {
  try {
    if (!Array.isArray(value)) return null;
    if (typeof maxLength !== 'number' || !Number.isSafeInteger(maxLength) || maxLength < 0) {
      return null;
    }
    const lengthDesc = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDesc || lengthDesc.get !== undefined || lengthDesc.set !== undefined) return null;
    const length = lengthDesc.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;
    if (length > maxLength) return null;
    const keys = Reflect.ownKeys(value);
    /** @type {string[]} */
    const expected = [];
    for (let i = 0; i < length; i += 1) expected.push(String(i));
    expected.push('length');
    if (keys.length !== expected.length) return null;
    for (let i = 0; i < expected.length; i += 1) {
      if (keys[i] !== expected[i]) return null;
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
 * @param {unknown} value
 * @returns {boolean}
 */
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSha256Hex(value) {
  return typeof value === 'string' && SHA256_HEX_RE.test(value);
}

/**
 * Calendar-canonical UTC ISO with exact 3 fractional digits.
 * Rejects rolled dates (e.g. 2026-02-30) via Date.toISOString round-trip.
 * @param {unknown} value
 * @returns {boolean}
 */
function isCanonicalIsoUtcMs(value) {
  if (typeof value !== 'string' || !CANONICAL_ISO_MS_RE.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString() === value;
}

/**
 * @param {Date} date
 * @returns {string}
 */
function toCanonicalIso(date) {
  try {
    return date.toISOString();
  } catch {
    // RangeError (Invalid time value) etc. — never leak engine messages.
    failIo();
  }
}

/**
 * @param {unknown} value
 * @param {{ min?: number, max?: number }} [range]
 * @returns {number | null}
 */
function asSafeInt(value, range = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (range.min !== undefined && value < range.min) return null;
  if (range.max !== undefined && value > range.max) return null;
  return value;
}

/**
 * Deep-freeze plain object graphs (arrays + records).
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
    for (const key of Reflect.ownKeys(value)) {
      // @ts-expect-error index
      deepFreeze(value[key]);
    }
  }
  return value;
}

/**
 * Canonical chunk byte length for file size at chunkIndex, or null if OOB.
 * @param {number} fileSize
 * @param {number} chunkIndex
 * @returns {number | null}
 */
function canonicalChunkBytes(fileSize, chunkIndex) {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return null;
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) return null;
  const totalChunks = Math.ceil(fileSize / UPLOAD_CHUNK_SIZE);
  if (chunkIndex >= totalChunks) return null;
  if (chunkIndex < totalChunks - 1) return UPLOAD_CHUNK_SIZE;
  const last = fileSize - chunkIndex * UPLOAD_CHUNK_SIZE;
  return last > 0 ? last : null;
}

/**
 * @param {unknown} raw
 */
function parseSessionRecord(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failIo();
  }
  const top = readOwnStringDataFields(parsed, SESSION_KEYS.length);
  if (!top) failIo();
  const keys = Object.keys(top);
  if (keys.length !== SESSION_KEYS.length) failIo();
  for (const key of SESSION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(top, key)) failIo();
  }
  for (const key of keys) {
    if (!SESSION_KEYS.includes(key)) failIo();
  }

  if (top.schemaVersion !== SESSION_SCHEMA_VERSION) failIo();
  if (!isUuid(top.uploadId)) failIo();
  if (typeof top.deviceId !== 'string' || top.deviceId.length === 0 || top.deviceId.length > 512) {
    failIo();
  }
  if (!isUuid(top.snapshotId)) failIo();
  if (!isSha256Hex(top.manifestDigest)) failIo();
  if (typeof top.status !== 'string' || !STATUS_SET.has(top.status)) failIo();
  if (!isCanonicalIsoUtcMs(top.createdAt)) failIo();
  if (!isCanonicalIsoUtcMs(top.expiresAt)) failIo();
  if (!isCanonicalIsoUtcMs(top.updatedAt)) failIo();

  const fileCount = asSafeInt(top.fileCount, { min: 0, max: MAX_BOUNDARIES });
  const totalBytes = asSafeInt(top.totalBytes, { min: 0 });
  if (fileCount === null || totalBytes === null) failIo();

  const boundariesRaw = readDenseArray(top.boundaries, MAX_BOUNDARIES);
  if (!boundariesRaw || boundariesRaw.length !== fileCount) failIo();

  /** @type {Array<{
   *   fileIndex: number,
   *   size: number,
   *   confirmedBytes: number,
   *   confirmedChunks: number,
   *   complete: boolean,
   * }>} */
  const boundaries = [];
  let sumSizes = 0;
  for (let i = 0; i < boundariesRaw.length; i += 1) {
    const b = readOwnStringDataFields(boundariesRaw[i], BOUNDARY_KEYS.length);
    if (!b) failIo();
    const bKeys = Object.keys(b);
    if (bKeys.length !== BOUNDARY_KEYS.length) failIo();
    for (const key of BOUNDARY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) failIo();
    }
    for (const key of bKeys) {
      if (!BOUNDARY_KEYS.includes(key)) failIo();
    }
    const fileIndex = asSafeInt(b.fileIndex, { min: 0, max: MAX_BOUNDARIES - 1 });
    const size = asSafeInt(b.size, { min: 0 });
    const confirmedBytes = asSafeInt(b.confirmedBytes, { min: 0 });
    const confirmedChunks = asSafeInt(b.confirmedChunks, { min: 0 });
    if (
      fileIndex === null
      || size === null
      || confirmedBytes === null
      || confirmedChunks === null
      || typeof b.complete !== 'boolean'
    ) {
      failIo();
    }
    if (fileIndex !== i) failIo();
    if (confirmedBytes > size) failIo();
    if (size === 0) {
      if (confirmedBytes !== 0 || confirmedChunks !== 0 || b.complete !== true) failIo();
    } else if (confirmedBytes > 0) {
      const fullChunks = Math.floor(confirmedBytes / UPLOAD_CHUNK_SIZE);
      const rem = confirmedBytes % UPLOAD_CHUNK_SIZE;
      const expectChunks = rem === 0 ? fullChunks : fullChunks + 1;
      if (confirmedChunks !== expectChunks) failIo();
      if (rem !== 0 && confirmedBytes !== size) failIo();
      if (b.complete !== (confirmedBytes === size)) failIo();
    } else if (confirmedChunks !== 0) {
      failIo();
    } else if (b.complete !== false) {
      failIo();
    }
    sumSizes += size;
    if (!Number.isSafeInteger(sumSizes)) failIo();
    boundaries.push({
      fileIndex,
      size,
      confirmedBytes,
      confirmedChunks,
      complete: b.complete,
    });
  }
  if (sumSizes !== totalBytes) failIo();

  const createdMs = Date.parse(/** @type {string} */ (top.createdAt));
  const expiresMs = Date.parse(/** @type {string} */ (top.expiresAt));
  const updatedMs = Date.parse(/** @type {string} */ (top.updatedAt));
  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs) || !Number.isFinite(updatedMs)) {
    failIo();
  }
  if (expiresMs !== createdMs + UPLOAD_SESSION_TTL_MS) failIo();
  // expiresAt must itself be calendar-canonical (already checked) and match arithmetic.
  if (toCanonicalIso(new Date(createdMs + UPLOAD_SESSION_TTL_MS)) !== top.expiresAt) failIo();
  // On-disk time invariants (millisecond compare; store mutations use one captured now).
  if (updatedMs < createdMs) failIo();
  if (updatedMs > expiresMs) failIo();

  // Status ↔ boundaries semantic consistency (exact schema already validated above).
  const status = /** @type {string} */ (top.status);
  let anyConfirmedBytes = false;
  let allComplete = true;
  for (const b of boundaries) {
    if (b.confirmedBytes > 0) anyConfirmedBytes = true;
    if (!b.complete) allComplete = false;
  }
  if (status === 'initialized') {
    // No confirmed progress on non-zero files; zero-size files stay complete.
    for (const b of boundaries) {
      if (b.size === 0) {
        if (b.confirmedBytes !== 0 || b.confirmedChunks !== 0 || b.complete !== true) failIo();
      } else if (b.confirmedBytes !== 0 || b.confirmedChunks !== 0 || b.complete !== false) {
        failIo();
      }
    }
  } else if (status === 'receiving') {
    // Must reflect real progress on at least one file.
    if (!anyConfirmedBytes) failIo();
  } else if (status === 'verifying' || status === 'committed') {
    if (!allComplete) failIo();
  }
  // aborted: any contiguously-legal boundary state is allowed at terminal.

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    uploadId: /** @type {string} */ (top.uploadId),
    deviceId: /** @type {string} */ (top.deviceId),
    snapshotId: /** @type {string} */ (top.snapshotId),
    manifestDigest: /** @type {string} */ (top.manifestDigest),
    status,
    createdAt: /** @type {string} */ (top.createdAt),
    expiresAt: /** @type {string} */ (top.expiresAt),
    updatedAt: /** @type {string} */ (top.updatedAt),
    fileCount,
    totalBytes,
    boundaries,
  };
}

/**
 * @param {ReturnType<typeof parseSessionRecord>} record
 */
function toPublicSummary(record) {
  const summary = {
    uploadId: record.uploadId,
    deviceId: record.deviceId,
    snapshotId: record.snapshotId,
    manifestDigest: record.manifestDigest,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    updatedAt: record.updatedAt,
    files: record.boundaries.map((b) => ({
      fileIndex: b.fileIndex,
      size: b.size,
      confirmedBytes: b.confirmedBytes,
      confirmedChunks: b.confirmedChunks,
      complete: b.complete,
    })),
  };
  return deepFreeze(summary);
}

/**
 * Build initial boundaries from C1 projected frozen manifest only.
 * Defense-in-depth: entries.length bound is checked before any boundary
 * allocation or per-entry property access loop (C1 already caps file count).
 * @param {object} projectedManifest
 */
function boundariesFromProjectedManifest(projectedManifest) {
  const top = projectedManifest;
  if (!top || typeof top !== 'object') failIo();
  const integrity = /** @type {{ entries?: unknown, totalBytes?: unknown }} */ (top).integrity;
  if (!integrity || typeof integrity !== 'object') failIo();
  const entries = /** @type {{ entries: Array<{ size: number }> }} */ (integrity).entries;
  if (!Array.isArray(entries)) failIo();
  const totalBytes = /** @type {{ totalBytes: number }} */ (integrity).totalBytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) failIo();

  // Early length bound — before boundaries array allocation and index loops.
  const entryCount = entries.length;
  if (
    typeof entryCount !== 'number'
    || !Number.isSafeInteger(entryCount)
    || entryCount < 0
    || entryCount > MAX_BOUNDARIES
  ) {
    failIo();
  }

  /** @type {Array<{
   *   fileIndex: number,
   *   size: number,
   *   confirmedBytes: number,
   *   confirmedChunks: number,
   *   complete: boolean,
   * }>} */
  const boundaries = [];
  let sum = 0;
  for (let i = 0; i < entryCount; i += 1) {
    const size = entries[i]?.size;
    if (!Number.isSafeInteger(size) || size < 0) failIo();
    sum += size;
    if (!Number.isSafeInteger(sum)) failIo();
    boundaries.push({
      fileIndex: i,
      size,
      confirmedBytes: 0,
      confirmedChunks: 0,
      complete: size === 0,
    });
  }
  if (sum !== totalBytes) failIo();
  return { boundaries, totalBytes, fileCount: boundaries.length };
}

/**
 * @param {string} dataDir
 * @param {string} deviceId
 */
function deviceScope(dataDir, deviceId) {
  if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 512) {
    failNotFound();
  }
  try {
    return safeDevicePath(dataDir, deviceId);
  } catch {
    failNotFound();
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
 * @param {{
 *   dataDir: string,
 *   now?: () => Date,
 *   randomUUID?: () => string,
 *   readdir?: typeof defaultReaddir,
 *   safeDeps?: object,
 * }} options
 */
export function createUploadSessionStore(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createUploadSessionStore options required');
  }
  const dataDir = options.dataDir;
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('dataDir required');
  }
  const nowFn = typeof options.now === 'function' ? options.now : () => new Date();
  const uuidFn =
    typeof options.randomUUID === 'function' ? options.randomUUID : defaultRandomUUID;
  const readdirFn = typeof options.readdir === 'function' ? options.readdir : defaultReaddir;
  const safeDeps = options.safeDeps && typeof options.safeDeps === 'object' ? options.safeDeps : {};

  /** @type {Map<string, Promise<unknown>>} */
  const deviceQueues = new Map();

  /**
   * Serialize per deviceId; delete Map entry only when still the current tail.
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

  function currentNow() {
    const d = nowFn();
    if (!(d instanceof Date) || !Number.isFinite(d.getTime())) failIo();
    return d;
  }

  /**
   * @param {string} deviceId
   * @param {string} uploadId
   * @param {{ missing: 'not-found' | 'io' }} mode
   */
  async function readSessionRecord(deviceId, uploadId, mode) {
    if (!isUuid(uploadId)) {
      if (mode.missing === 'io') failIo();
      failNotFound();
    }
    const { deviceRel } = deviceScope(dataDir, deviceId);
    const rel = `${sessionRel(deviceRel, uploadId)}/session.json`;
    let raw;
    try {
      raw = await safeReadText(dataDir, rel, {
        maxBytes: MAX_SESSION_JSON_BYTES,
        deps: safeDeps,
      });
    } catch (error) {
      if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
        if (mode.missing === 'io') failIo();
        failNotFound();
      }
      if (error instanceof SafeDataFileError) failIo();
      if (error instanceof LinkeError) throw error;
      failIo();
    }
    const record = parseSessionRecord(raw);
    if (record.deviceId !== deviceId || record.uploadId !== uploadId) failIo();
    return record;
  }

  /**
   * @param {string} deviceId
   * @param {ReturnType<typeof parseSessionRecord>} record
   */
  async function writeSessionRecord(deviceId, record) {
    const { deviceRel } = deviceScope(dataDir, deviceId);
    const sRel = sessionRel(deviceRel, record.uploadId);
    try {
      await ensureSafeRelativeDir(dataDir, sRel, safeDeps);
    } catch (error) {
      if (error instanceof SafeDataFileError) failIo();
      if (error instanceof LinkeError) throw error;
      failIo();
    }
    const payload = {
      schemaVersion: record.schemaVersion,
      uploadId: record.uploadId,
      deviceId: record.deviceId,
      snapshotId: record.snapshotId,
      manifestDigest: record.manifestDigest,
      status: record.status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      updatedAt: record.updatedAt,
      fileCount: record.fileCount,
      totalBytes: record.totalBytes,
      boundaries: record.boundaries.map((b) => ({
        fileIndex: b.fileIndex,
        size: b.size,
        confirmedBytes: b.confirmedBytes,
        confirmedChunks: b.confirmedChunks,
        complete: b.complete,
      })),
    };
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text, 'utf8') > MAX_SESSION_JSON_BYTES) failIo();
    try {
      await safeAtomicWriteText(dataDir, `${sRel}/session.json`, text, {
        mode: 0o600,
        deps: safeDeps,
      });
    } catch (error) {
      if (error instanceof SafeDataFileError) failIo();
      if (error instanceof LinkeError) throw error;
      failIo();
    }
  }

  /**
   * Existing-only list of session uploadIds. ENOENT → []. Hostile → IO.
   * @param {string} deviceId
   * @returns {Promise<string[]>}
   */
  async function listSessionUploadIds(deviceId) {
    const { deviceRel } = deviceScope(dataDir, deviceId);
    const sessionsRel = `${deviceRel}/upload-sessions`;
    let abs;
    try {
      abs = await assertSafeExistingRelativeDir(dataDir, sessionsRel, safeDeps);
    } catch (error) {
      if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
        return [];
      }
      if (error instanceof SafeDataFileError) failIo();
      if (error instanceof LinkeError) throw error;
      failIo();
    }

    let entries;
    try {
      entries = await readdirFn(abs, { withFileTypes: true });
    } catch {
      failIo();
    }
    if (!Array.isArray(entries)) failIo();
    if (entries.length > MAX_SESSION_DIRS) failIo();

    /** @type {string[]} */
    const ids = [];
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string') failIo();
      const name = entry.name;
      if (name.length === 0 || name.includes('\0') || name === '.' || name === '..') failIo();
      if (name.includes('/') || name.includes('\\')) failIo();
      // Real Dirent must expose both methods; otherwise fail-close.
      if (typeof entry.isSymbolicLink !== 'function' || typeof entry.isDirectory !== 'function') {
        failIo();
      }
      if (entry.isSymbolicLink()) failIo();
      if (!entry.isDirectory()) failIo();
      if (!isUuid(name)) failIo();
      ids.push(name);
    }
    ids.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    return ids;
  }

  /**
   * Scan all sessions. Missing session.json under UUID dir → IO (not not-found).
   * @param {string} deviceId
   */
  async function loadAllSessions(deviceId) {
    const ids = await listSessionUploadIds(deviceId);
    /** @type {ReturnType<typeof parseSessionRecord>[]} */
    const records = [];
    for (const uploadId of ids) {
      const record = await readSessionRecord(deviceId, uploadId, { missing: 'io' });
      records.push(record);
    }
    return records;
  }

  /**
   * @param {string} deviceId
   * @param {Date} now
   */
  async function findActiveRecord(deviceId, now) {
    const records = await loadAllSessions(deviceId);
    /** @type {ReturnType<typeof parseSessionRecord> | null} */
    let active = null;
    for (const rec of records) {
      if (isActiveNonterminal(rec, now)) {
        if (active) failIo();
        active = rec;
      }
    }
    return active;
  }

  /**
   * @param {ReturnType<typeof parseSessionRecord>} record
   * @param {Date} now
   */
  function assertRecordNotExpired(record, now) {
    if (TERMINAL_SET.has(record.status)) return;
    if (isExpiredSession(record, now)) failExpired();
  }

  /**
   * @param {unknown} session
   * @param {Date} [nowArg]
   */
  function assertNotExpired(session, nowArg) {
    const now = nowArg instanceof Date ? nowArg : currentNow();
    if (!session || typeof session !== 'object') failExpired();
    const status = /** @type {{ status?: unknown }} */ (session).status;
    if (typeof status === 'string' && TERMINAL_SET.has(status)) return;
    if (isExpiredSession(session, now)) failExpired();
  }

  /**
   * @param {{ size: number, confirmedBytes: number, complete: boolean }} b
   */
  function expectedNextChunk(b) {
    if (b.complete || b.size === 0) return null;
    const chunkIndex = Math.floor(b.confirmedBytes / UPLOAD_CHUNK_SIZE);
    const remaining = b.size - b.confirmedBytes;
    const chunkBytes = Math.min(UPLOAD_CHUNK_SIZE, remaining);
    return { chunkIndex, chunkBytes, offset: b.confirmedBytes };
  }

  /**
   * Per-file contiguous advance. No global "prior files complete" requirement.
   * Pure decision + optional in-memory advance only for `kind:'advanced'`.
   * Does NOT throw INTEGRITY_FAILED (caller must persist abort first).
   * Does NOT mutate on duplicate / integrity_failed.
   *
   * @param {ReturnType<typeof parseSessionRecord>} record
   * @param {{ fileIndex: number, chunkIndex: number, chunkBytes: number }} step
   * @returns {{ kind: 'advanced' } | { kind: 'duplicate' } | { kind: 'integrity_failed' }}
   */
  function applyBoundaryAdvance(record, step) {
    if (TERMINAL_SET.has(record.status)) failCommitConflict();
    if (record.status === 'verifying') failChunkInvalid();

    const { fileIndex, chunkIndex, chunkBytes } = step;
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex >= record.boundaries.length) {
      failChunkOutOfOrder();
    }
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) failChunkOutOfOrder();
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > UPLOAD_CHUNK_SIZE) {
      failChunkInvalid();
    }

    const b = record.boundaries[fileIndex];
    const next = expectedNextChunk(b);

    if (next === null) {
      // File complete (or zero-size): confirmed coordinates with canonical size are duplicates.
      if (b.size === 0) failChunkInvalid();
      const canon = canonicalChunkBytes(b.size, chunkIndex);
      const lastIdx = Math.ceil(b.size / UPLOAD_CHUNK_SIZE) - 1;
      if (canon !== null && chunkBytes === canon && chunkIndex <= lastIdx) {
        // Exact duplicate of any confirmed chunk (file complete ⇒ all chunks confirmed).
        return { kind: 'duplicate' };
      }
      // Confirmed coordinate size mismatch → integrity (design §6.3 rule 5).
      if (canon !== null && chunkBytes !== canon && chunkIndex <= lastIdx) {
        return { kind: 'integrity_failed' };
      }
      failChunkOutOfOrder();
    }

    // Exact next → advance (only mutate path).
    if (chunkIndex === next.chunkIndex && chunkBytes === next.chunkBytes) {
      b.confirmedBytes += chunkBytes;
      b.confirmedChunks += 1;
      if (b.confirmedBytes === b.size) b.complete = true;
      if (record.status === 'initialized') record.status = 'receiving';
      return { kind: 'advanced' };
    }

    // Prior confirmed coordinate: exact canonical size → duplicate; wrong size → integrity.
    if (chunkIndex < next.chunkIndex) {
      const canon = canonicalChunkBytes(b.size, chunkIndex);
      if (canon !== null && chunkBytes === canon) {
        return { kind: 'duplicate' };
      }
      if (canon !== null && chunkBytes !== canon) {
        return { kind: 'integrity_failed' };
      }
      failChunkOutOfOrder();
    }

    // Unconfirmed expected index wrong size → CHUNK_INVALID (no abort).
    // Future index → OUT_OF_ORDER.
    if (chunkIndex === next.chunkIndex && chunkBytes !== next.chunkBytes) {
      failChunkInvalid();
    }
    failChunkOutOfOrder();
  }

  /**
   * Ensure manifest.canonical.json matches cached projection text.
   * Present equal → ok. Missing → O_EXCL exclusive create (never overwrite leaf).
   * If exclusive loses the race (EEXIST / created:false), re-read and accept only
   * exact byte match; different content / symlink / dir → UPLOAD_IO_ERROR.
   * @param {string} deviceId
   * @param {string} uploadId
   * @param {string} manifestText
   */
  async function ensureMatchingManifest(deviceId, uploadId, manifestText) {
    const { deviceRel } = deviceScope(dataDir, deviceId);
    const sRel = sessionRel(deviceRel, uploadId);
    const rel = `${sRel}/manifest.canonical.json`;

    /**
     * @returns {Promise<string>}
     */
    async function readManifestOrThrow() {
      try {
        return await safeReadText(dataDir, rel, {
          maxBytes: MAX_MANIFEST_JSON_BYTES,
          deps: safeDeps,
        });
      } catch (error) {
        if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
          throw error;
        }
        // Symlink / non-file / oversize / I/O — never echo path.
        if (error instanceof SafeDataFileError) failIo();
        if (error instanceof LinkeError) throw error;
        failIo();
      }
    }

    try {
      const existing = await readManifestOrThrow();
      if (existing !== manifestText) failIo();
      return;
    } catch (error) {
      if (!(error && /** @type {{ code?: string }} */ (error).code === 'ENOENT')) {
        if (error instanceof LinkeError) throw error;
        failIo();
      }
    }

    // Missing: exclusive create only (no rename-overwrite of final leaf).
    try {
      await ensureSafeRelativeDir(dataDir, sRel, safeDeps);
    } catch (error) {
      if (error instanceof SafeDataFileError) failIo();
      if (error instanceof LinkeError) throw error;
      failIo();
    }

    let created;
    try {
      created = await safeCreateExclusiveText(dataDir, rel, manifestText, {
        mode: 0o600,
        deps: safeDeps,
      });
    } catch (error) {
      if (error instanceof SafeDataFileError) failIo();
      if (error instanceof LinkeError) throw error;
      failIo();
    }

    if (created && created.created === true) return;

    // Race: leaf appeared (created:false / EEXIST). Re-read; accept only exact match.
    let raced;
    try {
      raced = await readManifestOrThrow();
    } catch (error) {
      // Still missing or hostile leaf after EEXIST — fail-close.
      if (error instanceof LinkeError) throw error;
      failIo();
    }
    if (raced !== manifestText) failIo();
  }

  /**
   * @param {{
   *   authenticatedDeviceId: string,
   *   snapshotId: string,
   *   manifestDigest: string,
   *   canonicalManifest: object,
   * }} input
   */
  async function createSession(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) failIo();
    const deviceId = input.authenticatedDeviceId;
    if (typeof deviceId !== 'string' || deviceId.length === 0) failIo();
    const snapshotId = input.snapshotId;
    const manifestDigest = input.manifestDigest;
    const canonicalManifest = input.canonicalManifest;

    // ── C1 projection BEFORE any await (no dirs yet) ───────────────
    let projected;
    try {
      projected = projectCanonicalUploadManifest(canonicalManifest, {
        authenticatedDeviceId: deviceId,
        claimedManifestDigest: manifestDigest,
      });
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      // C1 only throws LinkeError; anything else → fail-close without path.
      throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
    }
    const projectedManifest = projected.manifest;
    const projectedDigest = projected.manifestDigest;
    if (typeof snapshotId !== 'string' || snapshotId !== projectedManifest.snapshotId) {
      throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
    }
    if (projectedDigest !== manifestDigest) {
      // claimedManifestDigest already enforced by C1; belt-and-suspenders.
      throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
    }

    // Single stringify of frozen projection — never re-read caller object.
    let manifestText;
    try {
      manifestText = JSON.stringify(projectedManifest);
    } catch {
      throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
    }
    if (typeof manifestText !== 'string') {
      throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
    }
    if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_JSON_BYTES) {
      throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
    }

    const identity = boundariesFromProjectedManifest(projectedManifest);

    return withDeviceLock(deviceId, async () => {
      const now = currentNow();
      const { deviceRel } = deviceScope(dataDir, deviceId);

      // Read-only scan (does not create upload-sessions).
      const records = await loadAllSessions(deviceId);

      /** @type {ReturnType<typeof parseSessionRecord> | null} */
      let active = null;
      /** @type {ReturnType<typeof parseSessionRecord> | null} */
      let matchingCommitted = null;
      /** @type {ReturnType<typeof parseSessionRecord> | null} */
      let matchingActiveSame = null;

      for (const rec of records) {
        const sameIdentity =
          rec.deviceId === deviceId
          && rec.snapshotId === projectedManifest.snapshotId
          && rec.manifestDigest === projectedDigest;

        if (isActiveNonterminal(rec, now)) {
          if (active && active.uploadId !== rec.uploadId) failIo();
          active = rec;
          if (sameIdentity) matchingActiveSame = rec;
        }
        if (rec.status === 'committed' && sameIdentity) {
          // Dual same-identity committed is an invariant break — never pick-latest.
          if (matchingCommitted) failIo();
          matchingCommitted = rec;
        }
      }

      // Same-identity active → ensure manifest, idempotent return.
      if (matchingActiveSame) {
        await ensureMatchingManifest(deviceId, matchingActiveSame.uploadId, manifestText);
        return toPublicSummary(matchingActiveSame);
      }

      if (active) {
        failConflict({
          uploadId: active.uploadId,
          status: active.status,
          snapshotId: active.snapshotId,
          manifestDigest: active.manifestDigest,
        });
      }

      if (matchingCommitted) {
        await ensureMatchingManifest(deviceId, matchingCommitted.uploadId, manifestText);
        return toPublicSummary(matchingCommitted);
      }

      // New session: session.json is the recoverable commit point, then manifest.
      let uploadId;
      try {
        uploadId = uuidFn();
      } catch {
        failIo();
      }
      if (!isUuid(uploadId)) failIo();
      if (records.some((r) => r.uploadId === uploadId)) failIo();

      const createdMs = now.getTime();
      const createdIso = toCanonicalIso(new Date(createdMs));
      const expiresIso = toCanonicalIso(new Date(createdMs + UPLOAD_SESSION_TTL_MS));
      if (!isCanonicalIsoUtcMs(createdIso) || !isCanonicalIsoUtcMs(expiresIso)) failIo();

      const record = {
        schemaVersion: SESSION_SCHEMA_VERSION,
        uploadId,
        deviceId,
        snapshotId: projectedManifest.snapshotId,
        manifestDigest: projectedDigest,
        status: 'initialized',
        createdAt: createdIso,
        expiresAt: expiresIso,
        updatedAt: createdIso,
        fileCount: identity.fileCount,
        totalBytes: identity.totalBytes,
        boundaries: identity.boundaries.map((b) => ({ ...b })),
      };

      try {
        await ensureSafeRelativeDir(dataDir, `${deviceRel}/upload-sessions`, safeDeps);
        await ensureSafeRelativeDir(dataDir, sessionRel(deviceRel, uploadId), safeDeps);
      } catch (error) {
        if (error instanceof SafeDataFileError) failIo();
        failIo();
      }

      // 1) atomic session.json first (recoverable commit point)
      await writeSessionRecord(deviceId, record);
      // 2) exclusive manifest via same helper (O_EXCL; never overwrite leaf)
      await ensureMatchingManifest(deviceId, uploadId, manifestText);

      return toPublicSummary(record);
    });
  }

  /**
   * @param {{ authenticatedDeviceId: string, uploadId: string }} input
   */
  async function getSession(input) {
    const deviceId = input?.authenticatedDeviceId;
    const uploadId = input?.uploadId;
    if (typeof deviceId !== 'string') failNotFound();
    return withDeviceLock(deviceId, async () => {
      const now = currentNow();
      const record = await readSessionRecord(deviceId, uploadId, { missing: 'not-found' });
      if (!TERMINAL_SET.has(record.status) && isExpiredSession(record, now)) {
        failExpired();
      }
      return toPublicSummary(record);
    });
  }

  /**
   * Read-only active lookup. Missing path → null. Hostile/corrupt → IO.
   * @param {string} deviceId
   */
  async function findActiveSession(deviceId) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) return null;
    return withDeviceLock(deviceId, async () => {
      const now = currentNow();
      // Invalid deviceId for path: not-found scope → null (no leak, no create).
      let deviceRel;
      try {
        ({ deviceRel } = safeDevicePath(dataDir, deviceId));
      } catch {
        return null;
      }

      // Existing-only: do not create repo/devices/<slug> or upload-sessions.
      try {
        await assertSafeExistingRelativeDir(dataDir, `${deviceRel}/upload-sessions`, safeDeps);
      } catch (error) {
        if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
          return null;
        }
        if (error instanceof SafeDataFileError) failIo();
        if (error instanceof LinkeError) throw error;
        failIo();
      }

      const active = await findActiveRecord(deviceId, now);
      return active ? toPublicSummary(active) : null;
    });
  }

  /**
   * @param {{ authenticatedDeviceId: string, uploadId: string }} input
   */
  async function abortSession(input) {
    const deviceId = input?.authenticatedDeviceId;
    const uploadId = input?.uploadId;
    if (typeof deviceId !== 'string') failNotFound();
    return withDeviceLock(deviceId, async () => {
      const now = currentNow();
      const record = await readSessionRecord(deviceId, uploadId, { missing: 'not-found' });
      if (record.status === 'committed') failCommitConflict();
      if (record.status === 'aborted') return toPublicSummary(record);
      if (isExpiredSession(record, now)) failExpired();
      record.status = 'aborted';
      record.updatedAt = toCanonicalIso(now);
      await writeSessionRecord(deviceId, record);
      return toPublicSummary(record);
    });
  }

  /**
   * @param {{ authenticatedDeviceId: string, uploadId: string }} input
   */
  async function markAborted(input) {
    return abortSession(input);
  }

  /**
   * @param {{ authenticatedDeviceId: string, uploadId: string }} input
   */
  async function listConfirmedBoundaries(input) {
    const session = await getSession(input);
    // Return independent frozen copy of files array contents.
    return deepFreeze(session.files.map((f) => ({ ...f })));
  }

  /**
   * @param {{
   *   authenticatedDeviceId: string,
   *   uploadId: string,
   *   fileIndex: number,
   *   chunkIndex: number,
   *   chunkBytes: number,
   * }} input
   */
  async function advanceBoundary(input) {
    const deviceId = input?.authenticatedDeviceId;
    const uploadId = input?.uploadId;
    if (typeof deviceId !== 'string') failNotFound();
    return withDeviceLock(deviceId, async () => {
      const now = currentNow();
      const record = await readSessionRecord(deviceId, uploadId, { missing: 'not-found' });
      assertRecordNotExpired(record, now);
      const result = applyBoundaryAdvance(record, {
        fileIndex: input.fileIndex,
        chunkIndex: input.chunkIndex,
        chunkBytes: input.chunkBytes,
      });
      if (result.kind === 'duplicate') {
        // Exact duplicate: no session write, no updatedAt change.
        return toPublicSummary(record);
      }
      if (result.kind === 'integrity_failed') {
        // Persist abort under same device lock, then throw integrity error.
        record.status = 'aborted';
        record.updatedAt = toCanonicalIso(now);
        await writeSessionRecord(deviceId, record);
        throw new LinkeError(ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
      }
      // advanced
      record.updatedAt = toCanonicalIso(now);
      await writeSessionRecord(deviceId, record);
      return toPublicSummary(record);
    });
  }

  /**
   * @param {{ authenticatedDeviceId: string, uploadId: string }} input
   */
  async function markVerifying(input) {
    const deviceId = input?.authenticatedDeviceId;
    const uploadId = input?.uploadId;
    if (typeof deviceId !== 'string') failNotFound();
    return withDeviceLock(deviceId, async () => {
      const now = currentNow();
      const record = await readSessionRecord(deviceId, uploadId, { missing: 'not-found' });
      assertRecordNotExpired(record, now);
      if (record.status === 'committed' || record.status === 'aborted') failCommitConflict();
      if (record.status === 'verifying') return toPublicSummary(record);
      for (const b of record.boundaries) {
        if (!b.complete) failChunkInvalid();
      }
      if (record.status !== 'initialized' && record.status !== 'receiving') failChunkInvalid();
      record.status = 'verifying';
      record.updatedAt = toCanonicalIso(now);
      await writeSessionRecord(deviceId, record);
      return toPublicSummary(record);
    });
  }

  /**
   * @param {{ authenticatedDeviceId: string, uploadId: string }} input
   */
  async function markCommitted(input) {
    const deviceId = input?.authenticatedDeviceId;
    const uploadId = input?.uploadId;
    if (typeof deviceId !== 'string') failNotFound();
    return withDeviceLock(deviceId, async () => {
      const now = currentNow();
      const record = await readSessionRecord(deviceId, uploadId, { missing: 'not-found' });
      // Already committed: idempotent frozen summary; no rewrite / no updatedAt change.
      if (record.status === 'committed') return toPublicSummary(record);
      if (record.status === 'aborted') failCommitConflict();
      assertRecordNotExpired(record, now);
      if (record.status !== 'verifying') failChunkInvalid();
      record.status = 'committed';
      record.updatedAt = toCanonicalIso(now);
      await writeSessionRecord(deviceId, record);
      return toPublicSummary(record);
    });
  }

  /**
   * Crash-window reconcile for the exact expected next staging chunk only.
   *
   * `expectedSize` / `expectedSha256` MUST be supplied by C3 (or later) from
   * authenticated exact-next chunk metadata already established for this
   * fileIndex/chunkIndex. C2 only re-hashes the staging `.part` and compares
   * those caller-provided values — it MUST NOT substitute the manifest's
   * whole-file sha256 as a chunk digest.
   *
   * @param {{
   *   authenticatedDeviceId: string,
   *   uploadId: string,
   *   fileIndex: number,
   *   chunkIndex: number,
   *   expectedSize: number,
   *   expectedSha256: string,
   * }} input
   */
  async function reconcileStagingChunk(input) {
    const deviceId = input?.authenticatedDeviceId;
    const uploadId = input?.uploadId;
    if (typeof deviceId !== 'string') failNotFound();
    return withDeviceLock(deviceId, async () => {
      const now = currentNow();
      const record = await readSessionRecord(deviceId, uploadId, { missing: 'not-found' });
      assertRecordNotExpired(record, now);
      if (TERMINAL_SET.has(record.status)) failCommitConflict();
      if (record.status === 'verifying') return toPublicSummary(record);

      const fileIndex = input.fileIndex;
      const chunkIndex = input.chunkIndex;
      const expectedSize = input.expectedSize;
      const expectedSha256 = input.expectedSha256;

      if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex >= record.boundaries.length) {
        return toPublicSummary(record);
      }
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
        return toPublicSummary(record);
      }
      if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > UPLOAD_CHUNK_SIZE) {
        return toPublicSummary(record);
      }
      if (!isSha256Hex(expectedSha256)) {
        return toPublicSummary(record);
      }

      const b = record.boundaries[fileIndex];
      const next = expectedNextChunk(b);
      if (!next || next.chunkIndex !== chunkIndex || next.chunkBytes !== expectedSize) {
        return toPublicSummary(record);
      }

      const { deviceRel } = deviceScope(dataDir, deviceId);
      const rel =
        `${sessionRel(deviceRel, uploadId)}/.staging/files/${fileIndex}/chunk-${chunkIndex}.part`;

      let hashResult;
      try {
        hashResult = await safeHashFileSha256(dataDir, rel, {
          maxBytes: UPLOAD_CHUNK_SIZE,
          deps: safeDeps,
        });
      } catch (error) {
        if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
          return toPublicSummary(record);
        }
        if (error instanceof SafeDataFileError) failIo();
        if (error instanceof LinkeError) throw error;
        failIo();
      }

      if (
        !hashResult
        || hashResult.size !== expectedSize
        || hashResult.sha256 !== expectedSha256
      ) {
        return toPublicSummary(record);
      }

      const result = applyBoundaryAdvance(record, {
        fileIndex,
        chunkIndex,
        chunkBytes: expectedSize,
      });
      if (result.kind === 'duplicate') return toPublicSummary(record);
      if (result.kind === 'integrity_failed') {
        record.status = 'aborted';
        record.updatedAt = toCanonicalIso(now);
        await writeSessionRecord(deviceId, record);
        throw new LinkeError(ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
      }
      record.updatedAt = toCanonicalIso(now);
      await writeSessionRecord(deviceId, record);
      return toPublicSummary(record);
    });
  }

  return {
    createSession,
    getSession,
    findActiveSession,
    abortSession,
    listConfirmedBoundaries,
    advanceBoundary,
    markVerifying,
    markCommitted,
    markAborted,
    assertNotExpired,
    reconcileStagingChunk,
  };
}
