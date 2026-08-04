/**
 * Stable local UUIDv4 namespace for audit-integrity alert delivery stream identity.
 * Create/persist only — no network delivery, outbox, secrets, or scheduling.
 */

import { randomUUID } from 'node:crypto';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import {
  assertAuditIntegrityWriteLease,
  enqueueAuditIntegrityWriteTask,
} from './audit-integrity-write-queue.js';
import {
  assertSafeDataRoot,
  safeAtomicWriteText,
  safeReadText,
} from './safe-data-files.js';

export const AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH =
  'audit/integrity-alert-delivery-stream.json';

const STATE_MAX_BYTES = 128;
const STATE_KEYS = Object.freeze(['schemaVersion', 'streamId']);
const RECEIPT_KEYS = Object.freeze(['schemaVersion', 'status', 'streamId']);
const STREAM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function unavailableError() {
  return new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
}

function fail() {
  throw unavailableError();
}

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  return keys.every((key, index) => actual[index] === key);
}

function serializeState(streamId) {
  return `${JSON.stringify({ schemaVersion: 1, streamId })}\n`;
}

function parseState(raw) {
  if (typeof raw !== 'string') fail();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail();
  }
  if (!hasExactKeys(parsed, STATE_KEYS)) fail();
  if (parsed.schemaVersion !== 1) fail();
  if (typeof parsed.streamId !== 'string' || !STREAM_ID_RE.test(parsed.streamId)) fail();
  if (serializeState(parsed.streamId) !== raw) fail();
  return { schemaVersion: 1, streamId: parsed.streamId };
}

function freezeReceipt(status, streamId) {
  const receipt = {
    schemaVersion: 1,
    status,
    streamId,
  };
  if (!hasExactKeys(receipt, RECEIPT_KEYS)) fail();
  return Object.freeze(receipt);
}

/**
 * Load exact canonical state. Missing leaf → null. Any other failure → unavailable.
 * @param {string} resolvedRoot
 * @returns {Promise<{ schemaVersion: 1, streamId: string } | null>}
 */
async function loadStateOrMissing(resolvedRoot) {
  let raw;
  try {
    raw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH,
      { maxBytes: STATE_MAX_BYTES },
    );
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail();
  }
  return parseState(raw);
}

/**
 * Publish a newly generated stream identity under an active audit write lease.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @returns {Promise<Readonly<{ schemaVersion: 1, status: 'created', streamId: string }>>}
 */
async function createState(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);
  let streamId;
  try {
    streamId = randomUUID();
  } catch {
    fail();
  }
  if (typeof streamId !== 'string' || !STREAM_ID_RE.test(streamId)) fail();
  const text = serializeState(streamId);
  try {
    await safeAtomicWriteText(
      resolvedRoot,
      AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH,
      text,
      { mode: 0o600 },
    );
  } catch {
    fail();
  }
  return freezeReceipt('created', streamId);
}

/**
 * Ensure one stable, non-secret canonical UUIDv4 stream identity for dataDir.
 * First ensure creates under the shared audit write queue/process lock; later
 * ensures return the same ID without rewriting exact canonical bytes.
 *
 * @param {unknown} dataDir
 * @returns {Promise<Readonly<{
 *   schemaVersion: 1,
 *   status: 'created' | 'existing',
 *   streamId: string,
 * }>>}
 */
export async function ensureAuditIntegrityAlertDeliveryStream(dataDir) {
  try {
    const resolvedRoot = await assertSafeDataRoot(dataDir);
    const existing = await loadStateOrMissing(resolvedRoot);
    if (existing !== null) {
      return freezeReceipt('existing', existing.streamId);
    }

    return await enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
      assertAuditIntegrityWriteLease(resolvedRoot, lease);
      const raced = await loadStateOrMissing(resolvedRoot);
      if (raced !== null) {
        return freezeReceipt('existing', raced.streamId);
      }
      return createState(resolvedRoot, lease);
    });
  } catch {
    throw unavailableError();
  }
}

/**
 * Read the existing canonical stream identity under an active same-root audit write lease.
 * Missing leaf → null (does not create). Corrupt / unsafe / forged / wrong / expired lease
 * → path-free audit-delivery-unavailable. Never enqueues, creates, or repairs.
 *
 * @param {unknown} resolvedRoot
 * @param {unknown} lease
 * @returns {Promise<Readonly<{ schemaVersion: 1, streamId: string }> | null>}
 */
export async function readAuditIntegrityAlertDeliveryStreamUnderLease(
  resolvedRoot,
  lease,
) {
  try {
    assertAuditIntegrityWriteLease(resolvedRoot, lease);
    const state = await loadStateOrMissing(resolvedRoot);
    if (state === null) return null;
    return Object.freeze({
      schemaVersion: 1,
      streamId: state.streamId,
    });
  } catch {
    throw unavailableError();
  }
}
