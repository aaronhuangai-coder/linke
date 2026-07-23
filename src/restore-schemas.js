/**
 * Pure exact-key projectors for G0c restore wire schemas (design §§7.1–7.5).
 * No I/O. Fail-closed LinkeError(RESTORE_TASK_INVALID) only. Descriptor-based.
 */

import { types as utilTypes } from 'node:util';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertStrictRelativeTarget } from './restore-path.js';

/** Fixed restore chunk size: 8 MiB. */
export const RESTORE_CHUNK_SIZE = 8_388_608;

/** Hard cap for GET task JSON body bytes. */
export const MAX_RESTORE_TASK_JSON_BYTES = 1_048_576;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
/** Exact millisecond UTC ISO; calendar validated via Date round-trip. */
const ISO_MS_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const MAX_DEVICE_ID_UTF8_BYTES = 256;
const MAX_FILE_COUNT = 100_000;

const TASK_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'relativeTarget',
  'createdAt',
  'fileCount',
  'totalBytes',
  'chunkSize',
]);

const STATUS_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'status',
  'updatedAt',
  'claimedAt',
  'completedAt',
  'receipt',
  'receiptAckAt',
  'cleanupAuthorized',
  'cleanupReceipt',
  'cleanupAckAt',
  'cancelRequestedAt',
  'lastProgress',
]);

const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'outcome',
  'relativeTarget',
  'totalBytes',
  'fileCount',
  'contentSha256',
  'structureFingerprint',
  'publishedVerifiedAt',
  'rolledBackAt',
  'anchorPresentBeforePublish',
  'receiptId',
]);

const CLEANUP_KEYS = Object.freeze([
  'schemaVersion',
  'cleanupId',
  'taskId',
  'deviceId',
  'outcome',
  'receiptId',
  'cleanedAt',
]);

const PROGRESS_KEYS = Object.freeze(['fileIndex', 'chunkIndex', 'receivedBytes']);

const LAST_PROGRESS_KEYS = Object.freeze([
  'fileIndex',
  'chunkIndex',
  'receivedBytes',
  'updatedAt',
]);

const STATUS_ENUM = new Set([
  'pending',
  'active',
  'completed',
  'rolled-back',
  'cancelled',
  'cleaned',
]);

const RECEIPT_OUTCOMES = new Set(['completed', 'rolled-back']);
const CLEANUP_OUTCOMES = new Set(['completed', 'rolled-back', 'cancelled']);

/**
 * @returns {never}
 */
function failTaskInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  // Reject Proxy bags (throwing/revoked traps) before any property access.
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
 * Exact own enumerable string data properties only (no symbols/getters/setters).
 * Early-stop when ownKeys.length > maxKeys (before descriptor loop).
 *
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
      if (typeof key === 'symbol') return null;
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
 * Require exact key set (order-independent presence) then project in key order.
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
 * @param {unknown} value
 * @returns {string}
 */
function assertUuid(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failTaskInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertSha256Hex(value) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) failTaskInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertIsoMsZ(value) {
  if (typeof value !== 'string' || !ISO_MS_Z_RE.test(value)) failTaskInvalid();
  try {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) failTaskInvalid();
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) failTaskInvalid();
    if (date.toISOString() !== value) failTaskInvalid();
    return value;
  } catch {
    failTaskInvalid();
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function assertIsoMsZOrNull(value) {
  if (value === null) return null;
  return assertIsoMsZ(value);
}

/**
 * @param {unknown} value
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
function assertSafeIntegerInRange(value, bounds = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) failTaskInvalid();
  if (bounds.min !== undefined && value < bounds.min) failTaskInvalid();
  if (bounds.max !== undefined && value > bounds.max) failTaskInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertDeviceId(value) {
  if (typeof value !== 'string' || value.length === 0) failTaskInvalid();
  if (Buffer.byteLength(value, 'utf8') > MAX_DEVICE_ID_UTF8_BYTES) failTaskInvalid();
  return value;
}

/**
 * Schema-layer relativeTarget: path rules via restore-path, mapped to task-invalid.
 * @param {unknown} value
 * @returns {string}
 */
function assertRelativeTargetSchema(value) {
  try {
    return assertStrictRelativeTarget(value);
  } catch (error) {
    if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_PATH_INVALID) {
      failTaskInvalid();
    }
    throw error;
  }
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
 * @param {unknown} options
 * @returns {string}
 */
function readExpectedTaskId(options) {
  const fields = readOwnStringDataFields(options, 1);
  if (!fields) failTaskInvalid();
  if (!hasExactKeys(fields, ['expectedTaskId'])) failTaskInvalid();
  return assertUuid(fields.expectedTaskId);
}

/**
 * Unique fingerprint nullability table (design §7.4).
 * @param {Readonly<{
 *   outcome: unknown,
 *   anchorPresentBeforePublish: unknown,
 *   contentSha256: unknown,
 *   structureFingerprint: unknown,
 * }>} receipt
 * @returns {void}
 */
export function assertFingerprintNullability(receipt) {
  try {
    if (!isPlainRecord(receipt) && !(receipt !== null && typeof receipt === 'object')) {
      failTaskInvalid();
    }
    // Read only needed fields via descriptors on a plain bag; reject getters.
    const fields = readOwnStringDataFields(receipt, 64);
    if (!fields) failTaskInvalid();
    const outcome = fields.outcome;
    const anchor = fields.anchorPresentBeforePublish;
    const content = fields.contentSha256;
    const structure = fields.structureFingerprint;
    if (outcome !== 'completed' && outcome !== 'rolled-back') failTaskInvalid();
    if (anchor !== true && anchor !== false) failTaskInvalid();

    if (outcome === 'completed') {
      assertSha256Hex(content);
      assertSha256Hex(structure);
      return;
    }
    // rolled-back
    if (anchor === true) {
      assertSha256Hex(content);
      assertSha256Hex(structure);
      return;
    }
    // rolled-back + anchor false => both null
    if (content !== null || structure !== null) failTaskInvalid();
  } catch (error) {
    if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_TASK_INVALID) {
      throw error;
    }
    failTaskInvalid();
  }
}

/**
 * @param {unknown} input
 * @returns {Readonly<object>}
 */
export function projectProgressBody(input) {
  const fields = readOwnStringDataFields(input, PROGRESS_KEYS.length);
  if (!fields || !hasExactKeys(fields, PROGRESS_KEYS)) failTaskInvalid();
  const projected = Object.freeze({
    fileIndex: assertSafeIntegerInRange(fields.fileIndex, { min: 0 }),
    chunkIndex: assertSafeIntegerInRange(fields.chunkIndex, { min: 0 }),
    receivedBytes: assertSafeIntegerInRange(fields.receivedBytes, { min: 0 }),
  });
  return projected;
}

/**
 * @param {unknown} input
 * @returns {Readonly<object>}
 */
function projectLastProgress(input) {
  const fields = readOwnStringDataFields(input, LAST_PROGRESS_KEYS.length);
  if (!fields || !hasExactKeys(fields, LAST_PROGRESS_KEYS)) failTaskInvalid();
  return Object.freeze({
    fileIndex: assertSafeIntegerInRange(fields.fileIndex, { min: 0 }),
    chunkIndex: assertSafeIntegerInRange(fields.chunkIndex, { min: 0 }),
    receivedBytes: assertSafeIntegerInRange(fields.receivedBytes, { min: 0 }),
    updatedAt: assertIsoMsZ(fields.updatedAt),
  });
}

/**
 * @param {unknown} input
 * @returns {Readonly<object>}
 */
export function projectCleanupReceipt(input) {
  const fields = readOwnStringDataFields(input, CLEANUP_KEYS.length);
  if (!fields || !hasExactKeys(fields, CLEANUP_KEYS)) failTaskInvalid();

  const schemaVersion = assertSafeIntegerInRange(fields.schemaVersion);
  if (schemaVersion !== 1) failTaskInvalid();
  const cleanupId = assertUuid(fields.cleanupId);
  const taskId = assertUuid(fields.taskId);
  const deviceId = assertDeviceId(fields.deviceId);
  const outcome = fields.outcome;
  if (typeof outcome !== 'string' || !CLEANUP_OUTCOMES.has(outcome)) failTaskInvalid();
  const cleanedAt = assertIsoMsZ(fields.cleanedAt);

  /** @type {string | null} */
  let receiptId;
  if (outcome === 'cancelled') {
    if (fields.receiptId !== null) failTaskInvalid();
    receiptId = null;
  } else {
    receiptId = assertUuid(fields.receiptId);
  }

  return Object.freeze({
    schemaVersion: 1,
    cleanupId,
    taskId,
    deviceId,
    outcome,
    receiptId,
    cleanedAt,
  });
}

/**
 * @param {unknown} input
 * @returns {Readonly<object>}
 */
export function projectReceiptObject(input) {
  const fields = readOwnStringDataFields(input, RECEIPT_KEYS.length);
  if (!fields || !hasExactKeys(fields, RECEIPT_KEYS)) failTaskInvalid();

  const schemaVersion = assertSafeIntegerInRange(fields.schemaVersion);
  if (schemaVersion !== 1) failTaskInvalid();
  const taskId = assertUuid(fields.taskId);
  const deviceId = assertDeviceId(fields.deviceId);
  const snapshotId = assertUuid(fields.snapshotId);
  const manifestDigest = assertSha256Hex(fields.manifestDigest);
  const outcome = fields.outcome;
  if (typeof outcome !== 'string' || !RECEIPT_OUTCOMES.has(outcome)) failTaskInvalid();
  const relativeTarget = assertRelativeTargetSchema(fields.relativeTarget);
  const totalBytes = assertSafeIntegerInRange(fields.totalBytes, { min: 0 });
  const fileCount = assertSafeIntegerInRange(fields.fileCount, {
    min: 0,
    max: MAX_FILE_COUNT,
  });
  const contentSha256 = assertSha256HexOrNull(fields.contentSha256);
  const structureFingerprint = assertSha256HexOrNull(fields.structureFingerprint);
  const publishedVerifiedAt = assertIsoMsZOrNull(fields.publishedVerifiedAt);
  const rolledBackAt = assertIsoMsZOrNull(fields.rolledBackAt);
  const anchorPresentBeforePublish = fields.anchorPresentBeforePublish;
  if (anchorPresentBeforePublish !== true && anchorPresentBeforePublish !== false) {
    failTaskInvalid();
  }
  const receiptId = assertUuid(fields.receiptId);

  // Time/outcome coupling.
  if (outcome === 'completed') {
    if (publishedVerifiedAt === null || rolledBackAt !== null) failTaskInvalid();
  } else {
    // rolled-back
    if (rolledBackAt === null || publishedVerifiedAt !== null) failTaskInvalid();
  }

  const projected = Object.freeze({
    schemaVersion: 1,
    taskId,
    deviceId,
    snapshotId,
    manifestDigest,
    outcome,
    relativeTarget,
    totalBytes,
    fileCount,
    contentSha256,
    structureFingerprint,
    publishedVerifiedAt,
    rolledBackAt,
    anchorPresentBeforePublish,
    receiptId,
  });
  assertFingerprintNullability(projected);
  return projected;
}

/**
 * Project immutable Controller TASK.json.
 * @param {unknown} input
 * @param {unknown} options
 * @returns {Readonly<object>}
 */
export function projectTaskJson(input, options) {
  const expectedTaskId = readExpectedTaskId(options);
  const fields = readOwnStringDataFields(input, TASK_KEYS.length);
  if (!fields || !hasExactKeys(fields, TASK_KEYS)) failTaskInvalid();

  const schemaVersion = assertSafeIntegerInRange(fields.schemaVersion);
  if (schemaVersion !== 1) failTaskInvalid();
  const taskId = assertUuid(fields.taskId);
  if (taskId !== expectedTaskId) failTaskInvalid();
  const deviceId = assertDeviceId(fields.deviceId);
  const snapshotId = assertUuid(fields.snapshotId);
  const manifestDigest = assertSha256Hex(fields.manifestDigest);
  const relativeTarget = assertRelativeTargetSchema(fields.relativeTarget);
  const createdAt = assertIsoMsZ(fields.createdAt);
  const fileCount = assertSafeIntegerInRange(fields.fileCount, {
    min: 0,
    max: MAX_FILE_COUNT,
  });
  const totalBytes = assertSafeIntegerInRange(fields.totalBytes, { min: 0 });
  const chunkSize = assertSafeIntegerInRange(fields.chunkSize);
  if (chunkSize !== RESTORE_CHUNK_SIZE) failTaskInvalid();

  return Object.freeze({
    schemaVersion: 1,
    taskId,
    deviceId,
    snapshotId,
    manifestDigest,
    relativeTarget,
    createdAt,
    fileCount,
    totalBytes,
    chunkSize: RESTORE_CHUNK_SIZE,
  });
}

/**
 * Project immutable Controller STATUS.json with §7.3 cross-field checks.
 * @param {unknown} input
 * @param {unknown} options
 * @returns {Readonly<object>}
 */
export function projectStatusJson(input, options) {
  const expectedTaskId = readExpectedTaskId(options);
  const fields = readOwnStringDataFields(input, STATUS_KEYS.length);
  if (!fields || !hasExactKeys(fields, STATUS_KEYS)) failTaskInvalid();

  const schemaVersion = assertSafeIntegerInRange(fields.schemaVersion);
  if (schemaVersion !== 1) failTaskInvalid();
  const taskId = assertUuid(fields.taskId);
  if (taskId !== expectedTaskId) failTaskInvalid();
  const status = fields.status;
  if (typeof status !== 'string' || !STATUS_ENUM.has(status)) failTaskInvalid();
  const updatedAt = assertIsoMsZ(fields.updatedAt);
  const claimedAt = assertIsoMsZOrNull(fields.claimedAt);
  const completedAt = assertIsoMsZOrNull(fields.completedAt);
  const receiptAckAt = assertIsoMsZOrNull(fields.receiptAckAt);
  const cleanupAuthorized = fields.cleanupAuthorized;
  if (cleanupAuthorized !== true && cleanupAuthorized !== false) failTaskInvalid();
  const cleanupAckAt = assertIsoMsZOrNull(fields.cleanupAckAt);
  const cancelRequestedAt = assertIsoMsZOrNull(fields.cancelRequestedAt);

  /** @type {Readonly<object> | null} */
  let receipt = null;
  if (fields.receipt !== null) {
    receipt = projectReceiptObject(fields.receipt);
  }

  /** @type {Readonly<object> | null} */
  let cleanupReceipt = null;
  if (fields.cleanupReceipt !== null) {
    cleanupReceipt = projectCleanupReceipt(fields.cleanupReceipt);
  }

  /** @type {Readonly<object> | null} */
  let lastProgress = null;
  if (fields.lastProgress !== null) {
    lastProgress = projectLastProgress(fields.lastProgress);
  }

  // §7.3 cross-field consistency (schema layer; within-record only).
  if (status === 'pending') {
    if (claimedAt !== null) failTaskInvalid();
    if (completedAt !== null) failTaskInvalid();
    if (receipt !== null) failTaskInvalid();
    if (receiptAckAt !== null) failTaskInvalid();
    if (cleanupReceipt !== null) failTaskInvalid();
    if (cleanupAckAt !== null) failTaskInvalid();
    if (cancelRequestedAt !== null) failTaskInvalid();
    if (lastProgress !== null) failTaskInvalid();
    if (cleanupAuthorized !== false) failTaskInvalid();
  } else if (status === 'active') {
    if (claimedAt === null) failTaskInvalid();
    if (completedAt !== null) failTaskInvalid();
    if (receipt !== null) failTaskInvalid();
    if (receiptAckAt !== null) failTaskInvalid();
    if (cleanupReceipt !== null) failTaskInvalid();
    if (cleanupAckAt !== null) failTaskInvalid();
    if (cleanupAuthorized !== false) failTaskInvalid();
    // cancelRequestedAt / lastProgress optional (null or already-validated value).
  } else if (status === 'completed' || status === 'rolled-back') {
    if (claimedAt === null) failTaskInvalid();
    if (completedAt === null) failTaskInvalid();
    if (receipt === null) failTaskInvalid();
    if (receiptAckAt === null) failTaskInvalid();
    if (cleanupAuthorized !== true) failTaskInvalid();
    if (receipt.outcome !== status) failTaskInvalid();
    if (receipt.taskId !== taskId) failTaskInvalid();
    if (cleanupReceipt !== null) failTaskInvalid();
    if (cleanupAckAt !== null) failTaskInvalid();
    // cancelRequestedAt / lastProgress optional.
  } else if (status === 'cleaned') {
    if (claimedAt === null) failTaskInvalid();
    if (completedAt === null) failTaskInvalid();
    if (receipt === null) failTaskInvalid();
    if (receiptAckAt === null) failTaskInvalid();
    if (cleanupReceipt === null) failTaskInvalid();
    if (cleanupAckAt === null) failTaskInvalid();
    if (cleanupAuthorized !== true) failTaskInvalid();
    if (receipt.taskId !== taskId) failTaskInvalid();
    if (cleanupReceipt.taskId !== taskId) failTaskInvalid();
    if (receipt.outcome !== 'completed' && receipt.outcome !== 'rolled-back') {
      failTaskInvalid();
    }
    if (cleanupReceipt.outcome !== receipt.outcome) failTaskInvalid();
    if (cleanupReceipt.receiptId !== receipt.receiptId) failTaskInvalid();
    if (cleanupReceipt.deviceId !== receipt.deviceId) failTaskInvalid();
    // cancelRequestedAt optional; lastProgress uses existing field validation.
  } else if (status === 'cancelled') {
    // Common cancelled constraints.
    if (completedAt !== null) failTaskInvalid();
    if (receipt !== null) failTaskInvalid();
    if (receiptAckAt !== null) failTaskInvalid();
    if (cleanupAuthorized !== false) failTaskInvalid();
    if (cancelRequestedAt === null) failTaskInvalid();
    if (claimedAt === null) {
      // Pending-direct cancel: never claimed; no cleanup artifacts.
      if (cleanupReceipt !== null) failTaskInvalid();
      if (cleanupAckAt !== null) failTaskInvalid();
      if (lastProgress !== null) failTaskInvalid();
    } else {
      // Active-cancel after claim: cancelled CleanupReceipt + cleanupAckAt required.
      if (cleanupReceipt === null) failTaskInvalid();
      if (cleanupAckAt === null) failTaskInvalid();
      if (cleanupReceipt.outcome !== 'cancelled') failTaskInvalid();
      if (cleanupReceipt.taskId !== taskId) failTaskInvalid();
      // lastProgress optional.
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    taskId,
    status,
    updatedAt,
    claimedAt,
    completedAt,
    receipt,
    receiptAckAt,
    cleanupAuthorized,
    cleanupReceipt,
    cleanupAckAt,
    cancelRequestedAt,
    lastProgress,
  });
}
