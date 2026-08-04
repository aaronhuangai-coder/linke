/**
 * Canonical claim state for audit integrity alert delivery (Task 1).
 *
 * Owns parse / serialize / load / publish / assert-no under an active same-root
 * audit write lease. Missing leaf is logical idle without creating the file.
 * All public failures collapse to path-free audit-delivery-unavailable.
 *
 * Does NOT import clocks, process identity, outbox, stream, request, transport,
 * agent, server, or network modules. Does NOT perform claim/complete/release.
 *
 * Hostile object contract: utilTypes.isProxy first (no traps), then plain
 * prototype + Reflect.ownKeys exact order + own enumerable data descriptors
 * only. Never JSON.stringify(hostile) before validating descriptors.
 * Full-file raw identity: compact JSON + exactly one trailing newline.
 */

import { types as utilTypes } from 'node:util';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertAuditIntegrityWriteLease } from './audit-integrity-write-queue.js';
import {
  safeAtomicWriteText,
  safeReadText,
} from './safe-data-files.js';

/** Relative path under data root for the single-slot delivery claim state. */
export const AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH =
  'audit/integrity-alert-delivery-claim.json';

/**
 * safeReadText / publish maxBytes bound. Fixed positive safe integer large enough
 * for the canonical idle/claimed fixtures and small path-free identity digests.
 */
export const AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES = 4096;

const SCHEMA_VERSION = 1;

const TOP_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'claimId',
  'streamId',
  'sequence',
  'ownerPid',
  'bootSessionIdentity',
  'processStartIdentity',
  'claimedAt',
  'expiresAt',
]);

const IDENTITY_KEYS = Object.freeze(['available', 'value']);

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * @returns {LinkeError}
 */
function unavailableError() {
  return new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
}

/**
 * @returns {never}
 */
function fail() {
  throw unavailableError();
}

/**
 * Plain data object: not null/array/Proxy; prototype Object.prototype or null.
 * utilTypes.isProxy runs BEFORE getPrototypeOf / ownKeys so traps never fire.
 *
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (utilTypes.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject Proxy / non-plain / symbol / non-enumerable / accessor own keys.
 * isProxy first — do not call Proxy traps then decide.
 *
 * @param {unknown} value
 * @returns {object}
 */
function assertPlainDataObject(value) {
  if (!isPlainObject(value)) fail();
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key === 'symbol') fail();
    if (typeof key !== 'string') fail();
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc) fail();
    if (!desc.enumerable) fail();
    if (desc.get !== undefined || desc.set !== undefined) fail();
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) fail();
  }
  return value;
}

/**
 * Exact Reflect.ownKeys order (call only after assertPlainDataObject so every
 * own key is already an enumerable string data property).
 *
 * @param {object} obj
 * @param {readonly string[]} expected
 */
function assertExactKeyOrder(obj, expected) {
  const keys = Reflect.ownKeys(obj);
  if (keys.length !== expected.length) fail();
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== expected[i]) fail();
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function assertPositiveSafeInteger(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail();
  }
  return value;
}

/**
 * Canonical lowercase UUIDv4.
 * @param {unknown} value
 * @returns {string}
 */
function assertUuidV4(value) {
  if (typeof value !== 'string' || !UUID_V4_RE.test(value)) fail();
  return value;
}

/**
 * Canonical millisecond UTC ISO string (Date#toISOString identity).
 * @param {unknown} value
 * @returns {string}
 */
function assertMsUtc(value) {
  if (typeof value !== 'string' || !MS_UTC_RE.test(value)) fail();
  let iso;
  try {
    iso = new Date(value).toISOString();
  } catch {
    fail();
  }
  if (iso !== value) fail();
  return value;
}

/**
 * Nonempty path-free identity digest string.
 * @param {unknown} value
 * @returns {string}
 */
function assertPathFreeIdentityValue(value) {
  if (typeof value !== 'string' || value.length === 0) fail();
  if (
    value.includes('/')
    || value.includes('\\')
    || value.includes('\n')
    || value.includes('\r')
    || value.includes('\0')
  ) {
    fail();
  }
  return value;
}

/**
 * Exact nested identity: {available:true,value:<path-free nonempty string>}.
 * @param {unknown} value
 * @returns {{ available: true, value: string }}
 */
function parseIdentity(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, IDENTITY_KEYS);
  if (obj.available !== true) fail();
  return {
    available: true,
    value: assertPathFreeIdentityValue(obj.value),
  };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (!Object.isFrozen(value)) Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
  }
  return value;
}

/**
 * Fresh canonical idle object (unfrozen).
 * @returns {object}
 */
function buildIdleCanonical() {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'idle',
    claimId: null,
    streamId: null,
    sequence: null,
    ownerPid: null,
    bootSessionIdentity: null,
    processStartIdentity: null,
    claimedAt: null,
    expiresAt: null,
  };
}

/**
 * Shared object-schema entry for caller objects and JSON.parse output.
 * Asserts plain data on the original value first (Proxy/class rejected before
 * any nested field walk / stringify whitewash).
 *
 * @param {unknown} value
 * @returns {object} unfrozen canonical state (defensive snapshot)
 */
function parseStateObject(value) {
  const obj = assertPlainDataObject(value);
  assertExactKeyOrder(obj, TOP_KEYS);

  if (obj.schemaVersion !== SCHEMA_VERSION) fail();
  if (obj.status !== 'idle' && obj.status !== 'claimed') fail();

  if (obj.status === 'idle') {
    if (obj.claimId !== null) fail();
    if (obj.streamId !== null) fail();
    if (obj.sequence !== null) fail();
    if (obj.ownerPid !== null) fail();
    if (obj.bootSessionIdentity !== null) fail();
    if (obj.processStartIdentity !== null) fail();
    if (obj.claimedAt !== null) fail();
    if (obj.expiresAt !== null) fail();
    return buildIdleCanonical();
  }

  // status === 'claimed'
  const claimId = assertUuidV4(obj.claimId);
  const streamId = assertUuidV4(obj.streamId);
  const sequence = assertPositiveSafeInteger(obj.sequence);
  const ownerPid = assertPositiveSafeInteger(obj.ownerPid);
  const bootSessionIdentity = parseIdentity(obj.bootSessionIdentity);
  const processStartIdentity = parseIdentity(obj.processStartIdentity);
  const claimedAt = assertMsUtc(obj.claimedAt);
  const expiresAt = assertMsUtc(obj.expiresAt);
  if (!(Date.parse(claimedAt) < Date.parse(expiresAt))) fail();

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'claimed',
    claimId,
    streamId,
    sequence,
    ownerPid,
    bootSessionIdentity,
    processStartIdentity,
    claimedAt,
    expiresAt,
  };
}

/**
 * Rebuild canonical JSON text with frozen key order + exactly one trailing newline.
 * @param {object} state already-validated canonical state
 * @returns {string}
 */
function serializeCanonicalState(state) {
  return `${JSON.stringify(state)}\n`;
}

/**
 * Pure strict parser for claim-state text.
 * Requires exactly one trailing newline; rejects BOM, empty, multi-line body,
 * trailing garbage, and non-canonical raw after schema parse.
 *
 * @param {string} raw
 * @returns {Readonly<object>}
 */
function parseClaimStateText(raw) {
  if (typeof raw !== 'string') fail();
  if (Buffer.byteLength(raw, 'utf8') > AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES) {
    fail();
  }
  if (raw.length === 0) fail();
  if (raw.charCodeAt(0) === 0xfeff) fail();
  if (!raw.endsWith('\n')) fail();
  const text = raw.slice(0, -1);
  if (text.length === 0) fail();
  if (text.includes('\n')) fail();
  if (/^\s/.test(text) || /\s$/.test(text)) fail();

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail();
  }

  const canonical = parseStateObject(value);
  if (serializeCanonicalState(canonical) !== raw) fail();
  return deepFreeze(canonical);
}

/**
 * Load claim state under an active same-root audit write lease.
 * Missing leaf → fresh deep-frozen canonical idle without creating the file.
 * Corrupt / oversize / symlink / directory / lease failure → unavailable.
 *
 * @param {unknown} resolvedRoot
 * @param {unknown} lease
 * @returns {Promise<Readonly<object>>}
 */
export async function loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease) {
  try {
    assertAuditIntegrityWriteLease(resolvedRoot, lease);

    let raw;
    try {
      raw = await safeReadText(
        resolvedRoot,
        AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH,
        { maxBytes: AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES },
      );
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return deepFreeze(buildIdleCanonical());
      }
      fail();
    }

    return parseClaimStateText(raw);
  } catch {
    throw unavailableError();
  }
}

/**
 * Atomic publish of claim state under an active same-root audit write lease.
 * Validates and defensively snapshots the caller object before the first await,
 * serializes within the exported max-byte bound, writes mode 0600, reopens with
 * exact raw equality, then returns a new deep-frozen exact-key copy.
 *
 * @param {unknown} resolvedRoot
 * @param {unknown} lease
 * @param {unknown} state
 * @returns {Promise<Readonly<object>>}
 */
export async function publishAuditIntegrityAlertDeliveryClaimState(
  resolvedRoot,
  lease,
  state,
) {
  try {
    assertAuditIntegrityWriteLease(resolvedRoot, lease);

    // Defensive snapshot + bounds before first await (no stringify whitewash).
    const canonical = parseStateObject(state);
    const expectedText = serializeCanonicalState(canonical);
    if (
      Buffer.byteLength(expectedText, 'utf8')
      > AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES
    ) {
      fail();
    }

    try {
      await safeAtomicWriteText(
        resolvedRoot,
        AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH,
        expectedText,
        { mode: 0o600 },
      );
    } catch {
      fail();
    }

    let postRaw;
    try {
      postRaw = await safeReadText(
        resolvedRoot,
        AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH,
        { maxBytes: AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES },
      );
    } catch {
      fail();
    }

    if (postRaw !== expectedText) fail();
    return parseClaimStateText(postRaw);
  } catch {
    throw unavailableError();
  }
}

/**
 * Manual-ack exclusion gate under an active same-root audit write lease.
 * Missing or canonical idle → undefined. Claimed or invalid/unsafe → unavailable.
 * Does not mutate the claim leaf.
 *
 * @param {unknown} resolvedRoot
 * @param {unknown} lease
 * @returns {Promise<void>}
 */
export async function assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease) {
  try {
    const state = await loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease);
    if (state.status === 'idle') return undefined;
    fail();
  } catch {
    throw unavailableError();
  }
}
