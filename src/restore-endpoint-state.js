/**
 * G0c C3 — Endpoint restore STATE machine (design §§6.2, 7.8, 10.1–10.5, P2-5).
 * Private dataDir layout: endpointDataDir/restore-tasks/<taskId>/{STATE,RECEIPT,CLEANUP-RECEIPT}.json
 * No HTTP / staging publish / fingerprint modules. Fail-closed LinkeError; no path/token leaks.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open as fsOpen } from 'node:fs/promises';
import { join } from 'node:path';
import { types as utilTypes } from 'node:util';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertStrictRelativeTarget, assertSnapshotRootRelativeFilePath } from './restore-path.js';
import {
  RESTORE_CHUNK_SIZE,
  projectCleanupReceipt,
  projectReceiptObject,
} from './restore-schemas.js';
import {
  SafeDataFileError,
  ensureSafeDataRoot,
  ensureSafeRelativeDir,
  safeAtomicWriteText,
  safeCreateExclusiveText,
  safeReadText,
} from './safe-data-files.js';

/** Design §10.3 exact closed set — 17 phases, no aliases. */
export const ENDPOINT_PHASES = Object.freeze([
  'planned',
  'receiving',
  'staging-verified',
  'anchor-intent',
  'anchored',
  'publish-intent',
  'published',
  'completed-awaiting-ack',
  'rollback-intent',
  'failed-target-quarantined',
  'anchor-restored',
  'old-fingerprint-verified',
  'rolled-back-awaiting-ack',
  'cancelled-local',
  'cleanup-intent',
  'cleanup-completed-awaiting-ack',
  'cleaned',
]);

const PHASE_SET = new Set(ENDPOINT_PHASES);

/** @type {ReadonlySet<string>} */
const LEGAL_EDGE_SET = new Set([
  'planned→receiving',
  'planned→cancelled-local',
  'receiving→staging-verified',
  'receiving→cancelled-local',
  'staging-verified→anchor-intent',
  'staging-verified→cancelled-local',
  'anchor-intent→anchored',
  'anchored→publish-intent',
  'publish-intent→published',
  'published→completed-awaiting-ack',
  'published→rollback-intent',
  'completed-awaiting-ack→cleanup-intent',
  'rollback-intent→failed-target-quarantined',
  'failed-target-quarantined→anchor-restored',
  'anchor-restored→old-fingerprint-verified',
  'old-fingerprint-verified→rolled-back-awaiting-ack',
  'rolled-back-awaiting-ack→cleanup-intent',
  'cancelled-local→cleanup-completed-awaiting-ack',
  'cleanup-intent→cleanup-completed-awaiting-ack',
  'cleanup-completed-awaiting-ack→cleaned',
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const ISO_MS_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const MAX_DEVICE_ID_UTF8_BYTES = 256;
const MAX_FILE_COUNT = 100_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_STAGING_FILE_BYTES = 512 * 1024 * 1024;

const STATE_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'relativeTarget',
  'phase',
  'updatedAt',
  'receivedBytes',
  'confirmedFiles',
  'fileCount',
  'totalBytes',
  'chunkSize',
  'oldStructureFingerprint',
  'oldContentSha256',
  'originalTargetExisted',
  'receiptId',
  'cleanupId',
  'cleanupAuthorized',
  'lastErrorCode',
]);

const FORBIDDEN_STATE_KEYS = new Set([
  'targetPathAbs',
  'parentPathAbs',
  'stagingPathAbs',
  'anchorPathAbs',
  'quarantinePathAbs',
  'restoreRoot',
  'dataDir',
  'endpointDataDir',
  'absolutePath',
  'targetAbs',
  'stagingAbs',
  'anchorAbs',
  'quarantineAbs',
  'stagingRoot',
  'absPath',
]);

const INIT_KEYS = Object.freeze([
  'taskId',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'relativeTarget',
  'fileCount',
  'totalBytes',
  'chunkSize',
  'originalTargetExisted',
  'oldStructureFingerprint',
  'oldContentSha256',
]);

const INIT_OPTIONAL_KEYS = Object.freeze(['phase']);

const WRITE_PATCH_ALLOWED = new Set([
  'phase',
  'updatedAt',
  'receivedBytes',
  'confirmedFiles',
  'oldStructureFingerprint',
  'oldContentSha256',
  'originalTargetExisted',
  'receiptId',
  'cleanupId',
  'cleanupAuthorized',
  'lastErrorCode',
]);

const IDENTITY_KEYS = Object.freeze([
  'taskId',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'relativeTarget',
]);

const REGISTERED_ERROR_CODES = new Set(Object.values(ERROR_CODES));

/**
 * @returns {never}
 */
function failStateInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
}

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
 * Exact own enumerable string data properties (no getters/setters/symbols).
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
 * @param {Record<string, unknown>} fields
 * @param {ReadonlyArray<string>} exactKeys
 * @returns {boolean}
 */
function hasExactKeys(fields, exactKeys) {
  const keys = Object.keys(fields);
  if (keys.length !== exactKeys.length) return false;
  for (const key of exactKeys) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return false;
  }
  for (const key of keys) {
    if (!exactKeys.includes(key)) return false;
  }
  return true;
}

/**
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
 * @param {unknown} error
 * @returns {never}
 */
function mapIo(error) {
  if (error instanceof LinkeError) throw error;
  if (error instanceof SafeDataFileError) failStateInvalid();
  failStateInvalid();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertUuid(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failStateInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertDeviceId(value) {
  if (typeof value !== 'string' || value.length === 0) failStateInvalid();
  if (Buffer.byteLength(value, 'utf8') > MAX_DEVICE_ID_UTF8_BYTES) failStateInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertSha256Hex(value) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) failStateInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function assertSha256HexOrNull(value) {
  if (value === null) return null;
  return assertSha256Hex(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertIsoMsZ(value) {
  if (typeof value !== 'string' || !ISO_MS_Z_RE.test(value)) failStateInvalid();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) failStateInvalid();
  if (new Date(ms).toISOString() !== value) failStateInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
function assertSafeNonnegInt(value, bounds = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) failStateInvalid();
  const min = bounds.min === undefined ? 0 : bounds.min;
  const max = bounds.max === undefined ? Number.MAX_SAFE_INTEGER : bounds.max;
  if (value < min || value > max) failStateInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertPhase(value) {
  if (typeof value !== 'string' || !PHASE_SET.has(value)) failStateInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function assertLastErrorCode(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !REGISTERED_ERROR_CODES.has(value)) failStateInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertRelativeTarget(value) {
  try {
    return assertStrictRelativeTarget(value);
  } catch (error) {
    if (error instanceof LinkeError) failStateInvalid();
    failStateInvalid();
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertFileRelPath(value) {
  try {
    return assertSnapshotRootRelativeFilePath(value);
  } catch (error) {
    if (error instanceof LinkeError) {
      // Path invalid for staging file paths maps to integrity fail at recover,
      // but schema-level bad files[] → state invalid for recover args.
      failStateInvalid();
    }
    failStateInvalid();
  }
}

/**
 * Project and validate a full STATE object (exact keys).
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
function projectState(input) {
  const fields = readOwnStringDataFields(input, STATE_KEYS.length);
  if (!fields || !hasExactKeys(fields, STATE_KEYS)) failStateInvalid();

  for (const key of Object.keys(fields)) {
    if (FORBIDDEN_STATE_KEYS.has(key)) failStateInvalid();
  }

  const schemaVersion = assertSafeNonnegInt(fields.schemaVersion);
  if (schemaVersion !== 1) failStateInvalid();

  const taskId = assertUuid(fields.taskId);
  const deviceId = assertDeviceId(fields.deviceId);
  const snapshotId = assertUuid(fields.snapshotId);
  const manifestDigest = assertSha256Hex(fields.manifestDigest);
  const relativeTarget = assertRelativeTarget(fields.relativeTarget);
  const phase = assertPhase(fields.phase);
  const updatedAt = assertIsoMsZ(fields.updatedAt);
  const receivedBytes = assertSafeNonnegInt(fields.receivedBytes);
  const confirmedFiles = assertSafeNonnegInt(fields.confirmedFiles);
  const fileCount = assertSafeNonnegInt(fields.fileCount, { max: MAX_FILE_COUNT });
  const totalBytes = assertSafeNonnegInt(fields.totalBytes);
  const chunkSize = assertSafeNonnegInt(fields.chunkSize);
  if (chunkSize !== RESTORE_CHUNK_SIZE) failStateInvalid();
  if (receivedBytes > totalBytes) failStateInvalid();
  if (confirmedFiles > fileCount) failStateInvalid();

  const oldStructureFingerprint = assertSha256HexOrNull(fields.oldStructureFingerprint);
  const oldContentSha256 = assertSha256HexOrNull(fields.oldContentSha256);
  const originalTargetExisted = fields.originalTargetExisted;
  if (originalTargetExisted !== true && originalTargetExisted !== false) failStateInvalid();

  if (originalTargetExisted === false) {
    if (oldStructureFingerprint !== null || oldContentSha256 !== null) failStateInvalid();
  } else if (originalTargetExisted === true) {
    // Both may still be null until preflight fingerprints are recorded; allow null pair.
    if (
      (oldStructureFingerprint === null) !== (oldContentSha256 === null)
    ) {
      failStateInvalid();
    }
  }

  /** @type {string | null} */
  let receiptId = null;
  if (fields.receiptId !== null) receiptId = assertUuid(fields.receiptId);
  /** @type {string | null} */
  let cleanupId = null;
  if (fields.cleanupId !== null) cleanupId = assertUuid(fields.cleanupId);

  const cleanupAuthorized = fields.cleanupAuthorized;
  if (cleanupAuthorized !== true && cleanupAuthorized !== false) failStateInvalid();
  const lastErrorCode = assertLastErrorCode(fields.lastErrorCode);

  return {
    schemaVersion: 1,
    taskId,
    deviceId,
    snapshotId,
    manifestDigest,
    relativeTarget,
    phase,
    updatedAt,
    receivedBytes,
    confirmedFiles,
    fileCount,
    totalBytes,
    chunkSize,
    oldStructureFingerprint,
    oldContentSha256,
    originalTargetExisted,
    receiptId,
    cleanupId,
    cleanupAuthorized,
    lastErrorCode,
  };
}

/**
 * @param {Record<string, unknown>} state
 * @returns {string}
 */
function serializeState(state) {
  // Stable key order matching STATE_KEYS for deterministic on-disk shape.
  /** @type {Record<string, unknown>} */
  const ordered = {};
  for (const key of STATE_KEYS) {
    ordered[key] = state[key];
  }
  const text = `${JSON.stringify(ordered)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) failStateInvalid();
  // Defense: never serialize absolute path fragments under forbidden keys.
  for (const key of FORBIDDEN_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ordered, key)) failStateInvalid();
  }
  return text;
}

/**
 * @param {string} taskId
 * @returns {string}
 */
function taskDirRel(taskId) {
  return `restore-tasks/${taskId}`;
}

/**
 * @param {string} taskId
 * @returns {string}
 */
function stateRel(taskId) {
  return `restore-tasks/${taskId}/STATE.json`;
}

/**
 * @param {string} taskId
 * @returns {string}
 */
function receiptRel(taskId) {
  return `restore-tasks/${taskId}/RECEIPT.json`;
}

/**
 * @param {string} taskId
 * @returns {string}
 */
function cleanupRel(taskId) {
  return `restore-tasks/${taskId}/CLEANUP-RECEIPT.json`;
}

/**
 * Production endpoint restore STATE store factory.
 * @param {{ endpointDataDir: string, now?: () => Date }} options
 */
export function createEndpointRestoreStateStore(options) {
  if (!isPlainRecord(options)) {
    throw new TypeError('createEndpointRestoreStateStore options required');
  }

  const optFields = readOwnStringDataFields(options, 4);
  if (!optFields) {
    throw new TypeError('createEndpointRestoreStateStore options required');
  }

  // Exact surface: only endpointDataDir (+ optional now). Reject unknown keys.
  const optKeys = Object.keys(optFields);
  for (const key of optKeys) {
    if (key !== 'endpointDataDir' && key !== 'now') {
      throw new TypeError('createEndpointRestoreStateStore options required');
    }
  }
  if (!Object.prototype.hasOwnProperty.call(optFields, 'endpointDataDir')) {
    throw new TypeError('endpointDataDir required');
  }

  const endpointDataDir = optFields.endpointDataDir;
  if (typeof endpointDataDir !== 'string' || endpointDataDir.length === 0) {
    throw new TypeError('endpointDataDir required');
  }
  if (endpointDataDir.includes('\0')) {
    throw new TypeError('endpointDataDir required');
  }

  const nowFn =
    optFields.now === undefined
      ? () => new Date()
      : typeof optFields.now === 'function'
        ? /** @type {() => Date} */ (optFields.now)
        : null;
  if (nowFn === null) {
    throw new TypeError('now must be a function');
  }

  /** @type {string | null} */
  let resolvedRoot = null;

  /**
   * In-process last durable progress coordinates (not serialized in STATE).
   * @type {Map<string, { fileIndex: number, chunkIndex: number, receivedBytes: number }>}
   */
  const lastProgress = new Map();

  /** @type {Map<string, Promise<unknown>>} */
  const taskQueues = new Map();

  /**
   * @template T
   * @param {string} taskId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withTaskLock(taskId, fn) {
    const prev = taskQueues.get(taskId) || Promise.resolve();
    const run = prev.then(
      () => fn(),
      () => fn(),
    );
    /** @type {Promise<unknown>} */
    const tail = run.then(
      (value) => {
        if (taskQueues.get(taskId) === tail) taskQueues.delete(taskId);
        return value;
      },
      (err) => {
        if (taskQueues.get(taskId) === tail) taskQueues.delete(taskId);
        throw err;
      },
    );
    taskQueues.set(taskId, tail);
    return /** @type {Promise<T>} */ (tail);
  }

  /**
   * @returns {string}
   */
  function currentIso() {
    let d;
    try {
      d = nowFn();
    } catch {
      failStateInvalid();
    }
    if (!(d instanceof Date) || !Number.isFinite(d.getTime())) failStateInvalid();
    try {
      return d.toISOString();
    } catch {
      failStateInvalid();
    }
  }

  /**
   * @returns {Promise<string>}
   */
  async function ensureRoot() {
    if (resolvedRoot !== null) return resolvedRoot;
    try {
      resolvedRoot = await ensureSafeDataRoot(endpointDataDir);
      await chmod(resolvedRoot, 0o700);
      return resolvedRoot;
    } catch (error) {
      mapIo(error);
    }
  }

  /**
   * @param {string} taskId
   * @returns {Promise<void>}
   */
  async function ensureTaskDir(taskId) {
    const root = await ensureRoot();
    try {
      const dirAbs = await ensureSafeRelativeDir(root, taskDirRel(taskId));
      await chmod(dirAbs, 0o700);
    } catch (error) {
      mapIo(error);
    }
  }

  /**
   * @param {string} taskId
   * @returns {Promise<Record<string, unknown>>}
   */
  async function readStateInternal(taskId) {
    const root = await ensureRoot();
    let text;
    try {
      text = await safeReadText(root, stateRel(taskId), { maxBytes: MAX_JSON_BYTES });
    } catch (error) {
      if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
        failStateInvalid();
      }
      mapIo(error);
    }
    let parsed;
    try {
      parsed = JSON.parse(/** @type {string} */ (text));
    } catch {
      failStateInvalid();
    }
    return projectState(parsed);
  }

  /**
   * @param {string} taskId
   * @param {Record<string, unknown>} state
   * @returns {Promise<void>}
   */
  async function writeStateInternal(taskId, state) {
    const root = await ensureRoot();
    const projected = projectState(state);
    const text = serializeState(projected);
    try {
      // Preflight: if STATE exists it must be a regular non-symlink file.
      // safeAtomicWriteText already enforces this; map all I/O failures.
      await safeAtomicWriteText(root, stateRel(taskId), text, { mode: 0o600 });
    } catch (error) {
      mapIo(error);
    }
  }

  /**
   * Parse openOrCreate init bag (exact required keys; optional phase only if planned).
   * @param {unknown} init
   */
  function parseInit(init) {
    const fields = readOwnStringDataFields(init, INIT_KEYS.length + INIT_OPTIONAL_KEYS.length + 8);
    if (!fields) failStateInvalid();

    // Reject forbidden absolute-path keys and any unknown keys outside allowed set.
    const allowed = new Set([...INIT_KEYS, ...INIT_OPTIONAL_KEYS]);
    for (const key of Object.keys(fields)) {
      if (FORBIDDEN_STATE_KEYS.has(key)) failStateInvalid();
      if (!allowed.has(key)) failStateInvalid();
    }
    for (const key of INIT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) failStateInvalid();
    }

    // phase if present must be exact 'planned' only on create path (validated later).
    if (Object.prototype.hasOwnProperty.call(fields, 'phase')) {
      if (fields.phase !== 'planned') failStateInvalid();
    }

    const taskId = assertUuid(fields.taskId);
    const deviceId = assertDeviceId(fields.deviceId);
    const snapshotId = assertUuid(fields.snapshotId);
    const manifestDigest = assertSha256Hex(fields.manifestDigest);
    const relativeTarget = assertRelativeTarget(fields.relativeTarget);
    const fileCount = assertSafeNonnegInt(fields.fileCount, { max: MAX_FILE_COUNT });
    const totalBytes = assertSafeNonnegInt(fields.totalBytes);
    const chunkSize = assertSafeNonnegInt(fields.chunkSize);
    if (chunkSize !== RESTORE_CHUNK_SIZE) failStateInvalid();
    const originalTargetExisted = fields.originalTargetExisted;
    if (originalTargetExisted !== true && originalTargetExisted !== false) failStateInvalid();
    const oldStructureFingerprint = assertSha256HexOrNull(fields.oldStructureFingerprint);
    const oldContentSha256 = assertSha256HexOrNull(fields.oldContentSha256);
    if (originalTargetExisted === false) {
      if (oldStructureFingerprint !== null || oldContentSha256 !== null) failStateInvalid();
    } else if ((oldStructureFingerprint === null) !== (oldContentSha256 === null)) {
      failStateInvalid();
    }

    return {
      taskId,
      deviceId,
      snapshotId,
      manifestDigest,
      relativeTarget,
      fileCount,
      totalBytes,
      chunkSize,
      originalTargetExisted,
      oldStructureFingerprint,
      oldContentSha256,
    };
  }

  /**
   * @param {unknown} init
   * @returns {Promise<object>}
   */
  async function openOrCreateState(init) {
    const parsed = parseInit(init);
    const { taskId } = parsed;

    return withTaskLock(taskId, async () => {
      await ensureTaskDir(taskId);
      const root = await ensureRoot();

      // Try exclusive create first.
      const createdState = {
        schemaVersion: 1,
        taskId: parsed.taskId,
        deviceId: parsed.deviceId,
        snapshotId: parsed.snapshotId,
        manifestDigest: parsed.manifestDigest,
        relativeTarget: parsed.relativeTarget,
        phase: 'planned',
        updatedAt: currentIso(),
        receivedBytes: 0,
        confirmedFiles: 0,
        fileCount: parsed.fileCount,
        totalBytes: parsed.totalBytes,
        chunkSize: parsed.chunkSize,
        oldStructureFingerprint: parsed.oldStructureFingerprint,
        oldContentSha256: parsed.oldContentSha256,
        originalTargetExisted: parsed.originalTargetExisted,
        receiptId: null,
        cleanupId: null,
        cleanupAuthorized: false,
        lastErrorCode: null,
      };
      const text = serializeState(createdState);

      let created;
      try {
        created = await safeCreateExclusiveText(root, stateRel(taskId), text, { mode: 0o600 });
      } catch (error) {
        mapIo(error);
      }

      if (created.created) {
        lastProgress.set(taskId, { fileIndex: 0, chunkIndex: 0, receivedBytes: 0 });
        return deepFreeze({ ...createdState });
      }

      // Existing — identity must match; no timestamp drift.
      const existing = await readStateInternal(taskId);
      for (const key of IDENTITY_KEYS) {
        if (existing[key] !== parsed[key]) failStateInvalid();
      }
      // Also freeze counts identity (same task identity implies same plan numbers).
      if (
        existing.fileCount !== parsed.fileCount
        || existing.totalBytes !== parsed.totalBytes
        || existing.chunkSize !== parsed.chunkSize
        || existing.originalTargetExisted !== parsed.originalTargetExisted
        || existing.oldStructureFingerprint !== parsed.oldStructureFingerprint
        || existing.oldContentSha256 !== parsed.oldContentSha256
      ) {
        failStateInvalid();
      }

      return deepFreeze({ ...existing });
    });
  }

  /**
   * @param {unknown} taskIdRaw
   * @returns {Promise<object>}
   */
  async function readState(taskIdRaw) {
    const taskId = assertUuid(taskIdRaw);
    return withTaskLock(taskId, async () => {
      const state = await readStateInternal(taskId);
      return deepFreeze({ ...state });
    });
  }

  /**
   * @param {unknown} taskIdRaw
   * @param {unknown} patchRaw
   * @param {unknown} writeOptions
   * @returns {Promise<object>}
   */
  async function writeState(taskIdRaw, patchRaw, writeOptions) {
    const taskId = assertUuid(taskIdRaw);

    // writeOptions must be exact { fsync: true } (boolean true only).
    const wo = readOwnStringDataFields(writeOptions, 4);
    if (!wo || !hasExactKeys(wo, ['fsync']) || wo.fsync !== true) failStateInvalid();

    const patch = readOwnStringDataFields(patchRaw, 32);
    if (!patch) failStateInvalid();
    for (const key of Object.keys(patch)) {
      if (FORBIDDEN_STATE_KEYS.has(key)) failStateInvalid();
      if (!WRITE_PATCH_ALLOWED.has(key)) failStateInvalid();
    }
    // Identity fields never patchable via writeState.
    for (const key of IDENTITY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) failStateInvalid();
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'schemaVersion')) failStateInvalid();
    if (Object.prototype.hasOwnProperty.call(patch, 'fileCount')) failStateInvalid();
    if (Object.prototype.hasOwnProperty.call(patch, 'totalBytes')) failStateInvalid();
    if (Object.prototype.hasOwnProperty.call(patch, 'chunkSize')) failStateInvalid();

    return withTaskLock(taskId, async () => {
      const current = await readStateInternal(taskId);
      /** @type {Record<string, unknown>} */
      const next = { ...current };

      if (Object.prototype.hasOwnProperty.call(patch, 'phase')) {
        next.phase = assertPhase(patch.phase);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'receivedBytes')) {
        next.receivedBytes = assertSafeNonnegInt(patch.receivedBytes);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'confirmedFiles')) {
        next.confirmedFiles = assertSafeNonnegInt(patch.confirmedFiles);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'oldStructureFingerprint')) {
        next.oldStructureFingerprint = assertSha256HexOrNull(patch.oldStructureFingerprint);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'oldContentSha256')) {
        next.oldContentSha256 = assertSha256HexOrNull(patch.oldContentSha256);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'originalTargetExisted')) {
        if (patch.originalTargetExisted !== true && patch.originalTargetExisted !== false) {
          failStateInvalid();
        }
        next.originalTargetExisted = patch.originalTargetExisted;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'receiptId')) {
        next.receiptId = patch.receiptId === null ? null : assertUuid(patch.receiptId);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'cleanupId')) {
        next.cleanupId = patch.cleanupId === null ? null : assertUuid(patch.cleanupId);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'cleanupAuthorized')) {
        if (patch.cleanupAuthorized !== true && patch.cleanupAuthorized !== false) {
          failStateInvalid();
        }
        next.cleanupAuthorized = patch.cleanupAuthorized;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'lastErrorCode')) {
        next.lastErrorCode = assertLastErrorCode(patch.lastErrorCode);
      }

      // updatedAt: always bump unless caller supplies valid ISO (and only if own key).
      if (Object.prototype.hasOwnProperty.call(patch, 'updatedAt')) {
        next.updatedAt = assertIsoMsZ(patch.updatedAt);
      } else {
        next.updatedAt = currentIso();
      }

      // Fingerprint nullability with originalTargetExisted.
      if (next.originalTargetExisted === false) {
        if (next.oldStructureFingerprint !== null || next.oldContentSha256 !== null) {
          failStateInvalid();
        }
      } else if (
        (next.oldStructureFingerprint === null) !== (next.oldContentSha256 === null)
      ) {
        failStateInvalid();
      }

      if (
        /** @type {number} */ (next.receivedBytes) > /** @type {number} */ (next.totalBytes)
      ) {
        failStateInvalid();
      }
      if (
        /** @type {number} */ (next.confirmedFiles) > /** @type {number} */ (next.fileCount)
      ) {
        failStateInvalid();
      }

      const projected = projectState(next);
      await writeStateInternal(taskId, projected);
      return deepFreeze({ ...projected });
    });
  }

  /**
   * @param {unknown} taskIdRaw
   * @param {unknown} fromRaw
   * @param {unknown} toRaw
   * @returns {Promise<object>}
   */
  async function transitionPhase(taskIdRaw, fromRaw, toRaw) {
    const taskId = assertUuid(taskIdRaw);
    // Validate phase strings without leaking aliases into messages (LinkeError is code-only).
    if (typeof fromRaw !== 'string' || typeof toRaw !== 'string') failStateInvalid();
    if (!PHASE_SET.has(fromRaw) || !PHASE_SET.has(toRaw)) failStateInvalid();
    const from = /** @type {string} */ (fromRaw);
    const to = /** @type {string} */ (toRaw);
    if (!LEGAL_EDGE_SET.has(`${from}→${to}`)) failStateInvalid();

    return withTaskLock(taskId, async () => {
      const current = await readStateInternal(taskId);
      if (current.phase !== from) failStateInvalid();
      current.phase = to;
      current.updatedAt = currentIso();
      const projected = projectState(current);
      await writeStateInternal(taskId, projected);
      return deepFreeze({ ...projected });
    });
  }

  /**
   * @param {unknown} taskIdRaw
   * @param {unknown} progressRaw
   * @returns {Promise<object>}
   */
  async function recordDurableProgress(taskIdRaw, progressRaw) {
    const taskId = assertUuid(taskIdRaw);
    const prog = readOwnStringDataFields(progressRaw, 8);
    if (!prog || !hasExactKeys(prog, ['fileIndex', 'chunkIndex', 'receivedBytes'])) {
      failStateInvalid();
    }
    const fileIndex = assertSafeNonnegInt(prog.fileIndex);
    const chunkIndex = assertSafeNonnegInt(prog.chunkIndex);
    const receivedBytes = assertSafeNonnegInt(prog.receivedBytes);

    return withTaskLock(taskId, async () => {
      const current = await readStateInternal(taskId);
      if (current.phase !== 'receiving') failStateInvalid();
      if (receivedBytes > /** @type {number} */ (current.totalBytes)) failStateInvalid();
      if (/** @type {number} */ (current.fileCount) > 0) {
        if (fileIndex >= /** @type {number} */ (current.fileCount)) failStateInvalid();
      } else if (fileIndex !== 0 || chunkIndex !== 0 || receivedBytes !== 0) {
        failStateInvalid();
      }

      // Monotone vs durable STATE receivedBytes (P2-5).
      if (receivedBytes < /** @type {number} */ (current.receivedBytes)) failStateInvalid();

      // Monotone vs last in-process progress coordinates (and bootstrap from STATE).
      const prev = lastProgress.get(taskId) || {
        fileIndex: 0,
        chunkIndex: 0,
        receivedBytes: /** @type {number} */ (current.receivedBytes),
      };
      // If STATE was externally advanced, floor coordinates against STATE receivedBytes.
      const floorBytes = Math.max(prev.receivedBytes, /** @type {number} */ (current.receivedBytes));
      if (receivedBytes < floorBytes) failStateInvalid();

      if (fileIndex < prev.fileIndex) failStateInvalid();
      if (fileIndex === prev.fileIndex && chunkIndex < prev.chunkIndex) failStateInvalid();
      // When advancing from a STATE-only floor (no memory), allow any nonnegative indices
      // as long as receivedBytes is non-decreasing — except when prev was recorded this process.
      if (lastProgress.has(taskId)) {
        if (fileIndex < prev.fileIndex) failStateInvalid();
        if (fileIndex === prev.fileIndex && chunkIndex < prev.chunkIndex) failStateInvalid();
      }

      current.receivedBytes = receivedBytes;
      // confirmedFiles tracks completed files floor (fileIndex of current in-progress file).
      if (fileIndex > /** @type {number} */ (current.confirmedFiles)) {
        current.confirmedFiles = fileIndex;
      }
      current.updatedAt = currentIso();
      const projected = projectState(current);
      // Durable atomic+fsync BEFORE return / memory update.
      await writeStateInternal(taskId, projected);
      lastProgress.set(taskId, { fileIndex, chunkIndex, receivedBytes });
      return deepFreeze({ ...projected });
    });
  }

  /**
   * Read absolute staging file with no-follow; size/sha checks.
   * @param {string} stagingRoot
   * @param {string} relPath
   * @param {number} expectedSize
   * @param {string} expectedSha
   * @returns {Promise<void>}
   */
  async function verifyStagingFile(stagingRoot, relPath, expectedSize, expectedSha) {
    // Resolve under stagingRoot without following final symlink.
    // Use open O_NOFOLLOW on the absolute path after lexical join + segment walk.
    if (typeof stagingRoot !== 'string' || stagingRoot.length === 0) failStateInvalid();
    if (stagingRoot.includes('\0')) failStateInvalid();

    let filePath;
    try {
      assertFileRelPath(relPath);
      // Walk each segment with open/stat style: join under root, refuse abs escape.
      const segments = relPath.split('/');
      let cursor = stagingRoot;
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        cursor = join(cursor, seg);
        const isLast = i === segments.length - 1;
        // eslint-disable-next-line no-await-in-loop
        const handle = await fsOpen(
          cursor,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const st = await handle.stat();
          if (isLast) {
            if (!st.isFile()) failIntegrity();
            const size = Number(st.size);
            if (!Number.isSafeInteger(size) || size !== expectedSize) failIntegrity();
            if (size > MAX_STAGING_FILE_BYTES) failIntegrity();
            const buf = Buffer.alloc(size);
            let offset = 0;
            while (offset < size) {
              // eslint-disable-next-line no-await-in-loop
              const { bytesRead } = await handle.read(buf, offset, size - offset, offset);
              if (bytesRead === 0) failIntegrity();
              offset += bytesRead;
            }
            const hex = createHash('sha256').update(buf).digest('hex');
            if (hex !== expectedSha) failIntegrity();
          } else if (!st.isDirectory()) {
            failIntegrity();
          }
        } finally {
          await handle.close().catch(() => {});
        }
      }
      filePath = cursor;
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      // Missing / short / type / symlink → integrity failed (not state invalid).
      failIntegrity();
    }
    void filePath;
  }

  /**
   * Reconcile durable STATE progress with staging tree. Never mutates STATE on failure.
   * @param {unknown} taskIdRaw
   * @param {unknown} stagingRootRaw
   * @param {unknown} filesRaw
   * @returns {Promise<object>}
   */
  async function recoverReceiving(taskIdRaw, stagingRootRaw, filesRaw) {
    const taskId = assertUuid(taskIdRaw);
    if (typeof stagingRootRaw !== 'string' || stagingRootRaw.length === 0) failStateInvalid();
    if (stagingRootRaw.includes('\0')) failStateInvalid();
    // staging absolute path stays process-local — never serialize.

    if (!Array.isArray(filesRaw)) failStateInvalid();
    /** @type {Array<{ fileIndex: number, path: string, size: number, sha256: string }>} */
    const files = [];
    for (let i = 0; i < filesRaw.length; i += 1) {
      const entry = readOwnStringDataFields(filesRaw[i], 8);
      if (!entry) failStateInvalid();
      // Accept exact keys used by tests: path, size, sha256, fileIndex
      const need = ['path', 'size', 'sha256', 'fileIndex'];
      for (const k of need) {
        if (!Object.prototype.hasOwnProperty.call(entry, k)) failStateInvalid();
      }
      for (const k of Object.keys(entry)) {
        if (!need.includes(k) && k !== 'chunkCount') failStateInvalid();
      }
      const fileIndex = assertSafeNonnegInt(entry.fileIndex);
      const path = assertFileRelPath(entry.path);
      const size = assertSafeNonnegInt(entry.size, { max: MAX_STAGING_FILE_BYTES });
      const sha256 = assertSha256Hex(entry.sha256);
      files.push({ fileIndex, path, size, sha256 });
    }
    files.sort((a, b) => a.fileIndex - b.fileIndex);
    for (let i = 0; i < files.length; i += 1) {
      if (files[i].fileIndex !== i) failStateInvalid();
    }

    return withTaskLock(taskId, async () => {
      // STATE damage → STATE_INVALID; do not rewrite.
      const state = await readStateInternal(taskId);
      if (state.phase !== 'receiving') failStateInvalid();

      const claimed = /** @type {number} */ (state.receivedBytes);
      if (claimed > /** @type {number} */ (state.totalBytes)) failStateInvalid();

      // Sum file sizes must match totalBytes when full table provided.
      let sumSizes = 0;
      for (const f of files) {
        sumSizes += f.size;
        if (!Number.isSafeInteger(sumSizes)) failStateInvalid();
      }
      if (
        files.length === /** @type {number} */ (state.fileCount)
        && sumSizes !== /** @type {number} */ (state.totalBytes)
      ) {
        // Inconsistent plan vs files table.
        failStateInvalid();
      }

      // stagingRoot must be a real non-symlink directory; never follow root links.
      try {
        const rootStat = await lstat(/** @type {string} */ (stagingRootRaw));
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) failIntegrity();
      } catch (error) {
        if (error instanceof LinkeError) throw error;
        failIntegrity();
      }

      // Verify staging covers all claimed durable bytes in fileIndex order.
      let remaining = claimed;
      for (const f of files) {
        if (remaining <= 0) break;
        if (remaining >= f.size) {
          // Full file must match size + sha.
          // eslint-disable-next-line no-await-in-loop
          await verifyStagingFile(
            /** @type {string} */ (stagingRootRaw),
            f.path,
            f.size,
            f.sha256,
          );
          remaining -= f.size;
        } else {
          // Partial last file: require at least `remaining` bytes readable (prefix).
          // For integrity of partial progress, verify size >= remaining and hash of
          // full expected only when remaining === size. Partial: check readable length.
          try {
            const abs = join(/** @type {string} */ (stagingRootRaw), f.path);
            const handle = await fsOpen(
              abs,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const st = await handle.stat();
              if (!st.isFile()) failIntegrity();
              const size = Number(st.size);
              if (!Number.isSafeInteger(size) || size < remaining) failIntegrity();
              // Read claimed prefix and ensure no short read.
              const buf = Buffer.alloc(remaining);
              let offset = 0;
              while (offset < remaining) {
                // eslint-disable-next-line no-await-in-loop
                const { bytesRead } = await handle.read(buf, offset, remaining - offset, offset);
                if (bytesRead === 0) failIntegrity();
                offset += bytesRead;
              }
            } finally {
              await handle.close().catch(() => {});
            }
          } catch (error) {
            if (error instanceof LinkeError) throw error;
            failIntegrity();
          }
          remaining = 0;
        }
      }
      if (remaining > 0) {
        // Claimed more bytes than files table can account for.
        failIntegrity();
      }

      // Success: return deep-frozen STATE unchanged (no shrink, no rewrite required).
      return deepFreeze({ ...state });
    });
  }

  /**
   * @param {unknown} taskIdRaw
   * @param {unknown} receiptRaw
   * @returns {Promise<void>}
   */
  async function writeReceipt(taskIdRaw, receiptRaw) {
    const taskId = assertUuid(taskIdRaw);
    // Map schema projection errors to STATE_INVALID (endpoint-local).
    let receipt;
    try {
      receipt = projectReceiptObject(receiptRaw);
    } catch (error) {
      if (error instanceof LinkeError) failStateInvalid();
      failStateInvalid();
    }
    if (receipt.taskId !== taskId) failStateInvalid();

    return withTaskLock(taskId, async () => {
      const state = await readStateInternal(taskId);
      if (receipt.deviceId !== state.deviceId) failStateInvalid();
      if (receipt.snapshotId !== state.snapshotId) failStateInvalid();
      if (receipt.manifestDigest !== state.manifestDigest) failStateInvalid();
      if (receipt.relativeTarget !== state.relativeTarget) failStateInvalid();

      const root = await ensureRoot();
      await ensureTaskDir(taskId);
      const text = `${JSON.stringify(receipt)}\n`;
      if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) failStateInvalid();

      // Atomic create-or-replace with idempotent same-bytes accept.
      let existingText = null;
      try {
        existingText = await safeReadText(root, receiptRel(taskId), { maxBytes: MAX_JSON_BYTES });
      } catch (error) {
        if (!(error && /** @type {{ code?: string }} */ (error).code === 'ENOENT')) {
          mapIo(error);
        }
      }
      if (existingText !== null) {
        let existing;
        try {
          existing = projectReceiptObject(JSON.parse(existingText));
        } catch {
          failStateInvalid();
        }
        // Idempotent: exact field match OK; conflict → invalid.
        if (JSON.stringify(existing) !== JSON.stringify(receipt)) failStateInvalid();
        return;
      }

      try {
        const result = await safeCreateExclusiveText(root, receiptRel(taskId), text, {
          mode: 0o600,
        });
        if (!result.created) {
          // Race: re-read and require equal.
          const again = await safeReadText(root, receiptRel(taskId), { maxBytes: MAX_JSON_BYTES });
          const existing = projectReceiptObject(JSON.parse(again));
          if (JSON.stringify(existing) !== JSON.stringify(receipt)) failStateInvalid();
        }
      } catch (error) {
        if (error instanceof LinkeError) throw error;
        mapIo(error);
      }

      // Persist receiptId into STATE without wiping other business evidence.
      if (state.receiptId !== receipt.receiptId) {
        state.receiptId = receipt.receiptId;
        state.updatedAt = currentIso();
        await writeStateInternal(taskId, projectState(state));
      }
    });
  }

  /**
   * @param {unknown} taskIdRaw
   * @param {unknown} cleanupRaw
   * @returns {Promise<void>}
   */
  async function writeCleanupReceipt(taskIdRaw, cleanupRaw) {
    const taskId = assertUuid(taskIdRaw);
    let cleanup;
    try {
      cleanup = projectCleanupReceipt(cleanupRaw);
    } catch (error) {
      if (error instanceof LinkeError) failStateInvalid();
      failStateInvalid();
    }
    if (cleanup.taskId !== taskId) failStateInvalid();

    return withTaskLock(taskId, async () => {
      const state = await readStateInternal(taskId);
      if (cleanup.deviceId !== state.deviceId) failStateInvalid();

      const root = await ensureRoot();
      await ensureTaskDir(taskId);
      const text = `${JSON.stringify(cleanup)}\n`;
      if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) failStateInvalid();

      let existingText = null;
      try {
        existingText = await safeReadText(root, cleanupRel(taskId), {
          maxBytes: MAX_JSON_BYTES,
        });
      } catch (error) {
        if (!(error && /** @type {{ code?: string }} */ (error).code === 'ENOENT')) {
          mapIo(error);
        }
      }
      if (existingText !== null) {
        let existing;
        try {
          existing = projectCleanupReceipt(JSON.parse(existingText));
        } catch {
          failStateInvalid();
        }
        if (JSON.stringify(existing) !== JSON.stringify(cleanup)) failStateInvalid();
        return;
      }

      try {
        const result = await safeCreateExclusiveText(root, cleanupRel(taskId), text, {
          mode: 0o600,
        });
        if (!result.created) {
          const again = await safeReadText(root, cleanupRel(taskId), {
            maxBytes: MAX_JSON_BYTES,
          });
          const existing = projectCleanupReceipt(JSON.parse(again));
          if (JSON.stringify(existing) !== JSON.stringify(cleanup)) failStateInvalid();
        }
      } catch (error) {
        if (error instanceof LinkeError) throw error;
        mapIo(error);
      }

      if (state.cleanupId !== cleanup.cleanupId) {
        state.cleanupId = cleanup.cleanupId;
        state.updatedAt = currentIso();
        await writeStateInternal(taskId, projectState(state));
      }
    });
  }

  /**
   * @param {unknown} taskIdRaw
   * @returns {Promise<object>}
   */
  async function readTombstone(taskIdRaw) {
    const taskId = assertUuid(taskIdRaw);
    return withTaskLock(taskId, async () => {
      const state = await readStateInternal(taskId);
      const root = await ensureRoot();

      /** @type {object | null} */
      let receipt = null;
      try {
        const text = await safeReadText(root, receiptRel(taskId), { maxBytes: MAX_JSON_BYTES });
        try {
          receipt = projectReceiptObject(JSON.parse(text));
        } catch {
          failStateInvalid();
        }
      } catch (error) {
        if (!(error && /** @type {{ code?: string }} */ (error).code === 'ENOENT')) {
          mapIo(error);
        }
      }

      /** @type {object | null} */
      let cleanupReceipt = null;
      try {
        const text = await safeReadText(root, cleanupRel(taskId), { maxBytes: MAX_JSON_BYTES });
        try {
          cleanupReceipt = projectCleanupReceipt(JSON.parse(text));
        } catch {
          failStateInvalid();
        }
      } catch (error) {
        if (!(error && /** @type {{ code?: string }} */ (error).code === 'ENOENT')) {
          mapIo(error);
        }
      }

      return deepFreeze({
        state: { ...state },
        receipt,
        cleanupReceipt,
      });
    });
  }

  return Object.freeze({
    openOrCreateState,
    readState,
    writeState,
    writeReceipt,
    writeCleanupReceipt,
    readTombstone,
    transitionPhase,
    recordDurableProgress,
    recoverReceiving,
  });
}
