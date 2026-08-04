/**
 * Pure audit-integrity alert delivery envelope builders.
 * Composes request descriptors only — no network, outbox, or side effects.
 */

import { Buffer } from 'node:buffer';
import { ERROR_CODES, LinkeError } from './error-codes.js';

const ENTRY_KEYS = Object.freeze([
  'sequence',
  'checkedAt',
  'code',
  'recoveryRequired',
  'nextAction',
  'reasonCode',
]);

const CHECKED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PATH_FREE_REASON_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ROTATION_RECOVERY_REASON = 'audit-integrity-rotation-recovery-required';

const KIND = 'audit-integrity-alert';
const DELIVERY_SEMANTICS = 'at-least-once';
const MAX_ENDPOINT_UTF8_BYTES = 2048;
const STREAM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function isCanonicalCheckedAt(value) {
  if (typeof value !== 'string' || !CHECKED_AT_RE.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isPathFreeReason(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && PATH_FREE_REASON_RE.test(value);
}

/** Closed outbox entry semantic matrix (code / recovery / nextAction / reason). */
function hasValidEntrySemantics(entry) {
  switch (entry.code) {
    case 'uninitialized':
      return entry.recoveryRequired === false
        && entry.nextAction === 'initialize-via-production-write'
        && entry.reasonCode === null;
    case 'state-missing':
      return entry.recoveryRequired === false
        && entry.nextAction === 'investigate-integrity'
        && entry.reasonCode === null;
    case 'recovery-required':
      return entry.recoveryRequired === true
        && entry.nextAction === 'run-explicit-recovery'
        && entry.reasonCode === null;
    case 'rotation-recovery-required':
      return entry.recoveryRequired === true
        && entry.nextAction === 'run-explicit-recovery'
        && entry.reasonCode === ROTATION_RECOVERY_REASON;
    case 'integrity-alert':
      return entry.recoveryRequired === false
        && entry.nextAction === 'investigate-integrity'
        && (entry.reasonCode === null || isPathFreeReason(entry.reasonCode));
    case 'io-alert':
      return entry.recoveryRequired === false
        && entry.nextAction === 'investigate-integrity'
        && (
          entry.reasonCode === null
          || (isPathFreeReason(entry.reasonCode) && entry.reasonCode.endsWith('-io-error'))
        );
    default:
      return false;
  }
}

/** Normalize one closed outbox-shaped entry into a plain defensive copy. */
function normalizeEntry(value) {
  if (!hasExactKeys(value, ENTRY_KEYS)) fail();
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) fail();
  if (!isCanonicalCheckedAt(value.checkedAt)) fail();
  const entry = {
    sequence: value.sequence,
    checkedAt: value.checkedAt,
    code: value.code,
    recoveryRequired: value.recoveryRequired,
    nextAction: value.nextAction,
    reasonCode: value.reasonCode,
  };
  if (!hasValidEntrySemantics(entry)) fail();
  return entry;
}

/** Accept only a canonical HTTPS URL of 1..2048 UTF-8 bytes. */
function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== 'string') fail();
  const byteLength = Buffer.byteLength(endpoint, 'utf8');
  if (byteLength < 1 || byteLength > MAX_ENDPOINT_UTF8_BYTES) fail();

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail();
  }

  if (parsed.href !== endpoint) fail();
  if (parsed.protocol !== 'https:') fail();
  if (parsed.username !== '' || parsed.password !== '') fail();
  if (parsed.search !== '' || parsed.hash !== '') fail();
  return endpoint;
}

function normalizeStreamId(streamId) {
  if (typeof streamId !== 'string' || !STREAM_ID_RE.test(streamId)) fail();
  return streamId;
}

function freezeEnvelope(streamId, entry) {
  const alert = Object.freeze({
    sequence: entry.sequence,
    checkedAt: entry.checkedAt,
    code: entry.code,
    recoveryRequired: entry.recoveryRequired,
    nextAction: entry.nextAction,
    reasonCode: entry.reasonCode,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: KIND,
    streamId,
    idempotencyKey: `${KIND}:${streamId}:${entry.sequence}`,
    deliverySemantics: DELIVERY_SEMANTICS,
    alert,
  });
}

/**
 * Build a deeply frozen delivery envelope from one closed outbox entry.
 * @param {unknown} streamId
 * @param {unknown} entry
 * @returns {Readonly<{
 *   schemaVersion: 1,
 *   kind: string,
 *   streamId: string,
 *   idempotencyKey: string,
 *   deliverySemantics: string,
 *   alert: Readonly<{
 *     sequence: number,
 *     checkedAt: string,
 *     code: string,
 *     recoveryRequired: boolean,
 *     nextAction: string,
 *     reasonCode: string | null,
 *   }>,
 * }>}
 */
export function buildAuditIntegrityAlertDeliveryEnvelope(streamId, entry) {
  try {
    return freezeEnvelope(normalizeStreamId(streamId), normalizeEntry(entry));
  } catch {
    throw unavailableError();
  }
}

/**
 * Build a deeply frozen HTTPS POST request descriptor (no I/O).
 * @param {unknown} endpoint
 * @param {unknown} streamId
 * @param {unknown} entry
 * @returns {Readonly<{
 *   schemaVersion: 1,
 *   url: string,
 *   method: 'POST',
 *   headers: Readonly<{ 'content-type': string, 'idempotency-key': string }>,
 *   body: string,
 * }>}
 */
export function buildAuditIntegrityAlertDeliveryRequest(endpoint, streamId, entry) {
  try {
    const url = normalizeEndpoint(endpoint);
    const envelope = freezeEnvelope(normalizeStreamId(streamId), normalizeEntry(entry));
    const body = JSON.stringify({
      schemaVersion: envelope.schemaVersion,
      kind: envelope.kind,
      streamId: envelope.streamId,
      idempotencyKey: envelope.idempotencyKey,
      deliverySemantics: envelope.deliverySemantics,
      alert: {
        sequence: envelope.alert.sequence,
        checkedAt: envelope.alert.checkedAt,
        code: envelope.alert.code,
        recoveryRequired: envelope.alert.recoveryRequired,
        nextAction: envelope.alert.nextAction,
        reasonCode: envelope.alert.reasonCode,
      },
    });
    return Object.freeze({
      schemaVersion: 1,
      url,
      method: 'POST',
      headers: Object.freeze({
        'content-type': 'application/json',
        'idempotency-key': envelope.idempotencyKey,
      }),
      body,
    });
  } catch {
    throw unavailableError();
  }
}
