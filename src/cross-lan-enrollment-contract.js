/**
 * Cross-LAN enrollment contract — code representation/policy, digest-record
 * field allowlist, fixed-length constant-time digest compare, tombstone FSM
 * (T1.13a), and enrollment-secret lifecycle pure contract (T1.13b / §6.3.x).
 *
 * --- honesty (Gold ADR §6.5) ---
 * [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * [scope] T1.13a + T1.13b only —
 *   code policy constants,
 *   digest-record field allowlist,
 *   canonical code-shape validator,
 *   timingSafeEqual digest compare,
 *   tombstone FSM,
 *   secret policy constants,
 *   secret bootstrap decision pure contract,
 *   secret rotation authorize/commit pure contract
 * [not ready] T1.13 complete = NOT COMPLETE; A25 = NOT READY
 *   T1.13b proves pure planning only — NOT Keychain I/O, CSPRNG generation,
 *   HMAC issue/verify, or durable version advance
 *   T1.13c (code delivery: clipboard / QR / UI) = NOT COMPLETE
 *
 * This module does **not** generate codes/salts/secrets, compute HMAC, read
 * secrets, write storage/Keychain, or deliver codes (clipboard/QR/UI).
 * Policy numeric constants and rotation plans do **not** prove CSPRNG quality,
 * HMAC correctness, Keychain durability, or that a secret was issued/rotated.
 */

import { timingSafeEqual } from 'node:crypto';
import { ERROR_CODES } from './error-codes.js';

/**
 * Frozen enrollment-code representation and retention policy constants.
 *
 * Values pin intended entropy width, encoding, TTL, single-use, digest
 * algorithm, and tombstone retention. They do **not** prove that CSPRNG
 * generation, HMAC-SHA256, or storage backends are implemented.
 *
 * `initialSecretVersion` is intentionally absent (owned by T1.13b secret policy).
 *
 * @type {Readonly<{
 *   plaintextEntropyBits: number,
 *   plaintextByteLength: number,
 *   plaintextEncoding: string,
 *   encodedLength: number,
 *   ttlSeconds: number,
 *   singleUse: boolean,
 *   minimumSaltByteLength: number,
 *   digestAlgorithm: string,
 *   digestVersion: number,
 *   digestByteLength: number,
 *   tombstoneMinimumRetentionSeconds: number,
 *   unknownOrExpiredErrorCode: string,
 * }>}
 */
export const CROSS_LAN_ENROLLMENT_CODE_POLICY = Object.freeze({
  plaintextEntropyBits: 128,
  plaintextByteLength: 16,
  plaintextEncoding: 'base64url-no-padding',
  encodedLength: 22,
  ttlSeconds: 600,
  singleUse: true,
  minimumSaltByteLength: 16,
  digestAlgorithm: 'HMAC-SHA256',
  digestVersion: 1,
  digestByteLength: 32,
  tombstoneMinimumRetentionSeconds: 86_400,
  unknownOrExpiredErrorCode: ERROR_CODES.ENROLLMENT_CODE_UNKNOWN_OR_EXPIRED,
});

/**
 * Digest-record field allowlist only (not a value schema).
 * `consumedAt` may be null on an active record.
 * Never includes plaintext `code`, secret, or raw fields.
 *
 * @type {ReadonlyArray<string>}
 */
export const CROSS_LAN_ENROLLMENT_DIGEST_RECORD_FIELDS = Object.freeze([
  'codeId',
  'digest',
  'salt',
  'version',
  'secretVersion',
  'expiry',
  'consumed',
  'tombstone',
  'issuedAt',
  'consumedAt',
]);

/**
 * True only when `value` is a primitive string that is the exact 22-character
 * canonical base64url-no-padding encoding of 16 bytes (round-trip safe).
 *
 * Does **not** prove CSPRNG quality, 128-bit actual entropy, freshness,
 * single-use, or non-expiry.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCanonicalCrossLanEnrollmentCode(value) {
  try {
    if (typeof value !== 'string') return false;
    if (value.length !== 22) return false;
    if (!/^[A-Za-z0-9_-]{22}$/.test(value)) return false;
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.byteLength !== 16) return false;
    return decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

/**
 * Fixed-length constant-time compare of two 32-byte digests.
 *
 * Type/length gates are public schema gates; only valid fixed-length
 * `Uint8Array` inputs (Buffer subclass accepted) enter `timingSafeEqual`.
 * Never logs/echoes inputs; never computes HMAC or reads secrets.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 * @returns {boolean}
 */
export function areCrossLanEnrollmentDigestsEqual(actual, expected) {
  try {
    if (!(actual instanceof Uint8Array) || !(expected instanceof Uint8Array)) {
      return false;
    }
    if (actual.byteLength !== 32 || expected.byteLength !== 32) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Tombstone FSM transition table.
 *
 * `purged` is a conceptual terminal marker for post-GC record absence; it is
 * not persisted as a record state field. No path returns to `active`.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const CROSS_LAN_ENROLLMENT_TOMBSTONE_TRANSITIONS = Object.freeze({
  active: Object.freeze({ expire: 'tombstone', consume: 'tombstone' }),
  tombstone: Object.freeze({ 'retention-elapsed': 'purged' }),
  purged: Object.freeze({}),
});

/**
 * Pure tombstone-state reducer: next state for (currentState, event), or null.
 *
 * Own-key only (`Object.hasOwn` two-level); non-string / unknown → null.
 * Does not read clocks. Callers may emit `retention-elapsed` only after the
 * policy 24h retention has elapsed.
 *
 * @param {unknown} currentState
 * @param {unknown} event
 * @returns {string | null}
 */
export function getNextCrossLanEnrollmentTombstoneState(currentState, event) {
  try {
    if (typeof currentState !== 'string' || typeof event !== 'string') {
      return null;
    }
    if (!Object.hasOwn(CROSS_LAN_ENROLLMENT_TOMBSTONE_TRANSITIONS, currentState)) {
      return null;
    }
    const row = CROSS_LAN_ENROLLMENT_TOMBSTONE_TRANSITIONS[currentState];
    if (!Object.hasOwn(row, event)) return null;
    return row[event];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// T1.13b — enrollment secret lifecycle pure contract (no Keychain / CSPRNG I/O)
// ---------------------------------------------------------------------------

/**
 * Frozen enrollment-secret policy constants (contract-only).
 *
 * Pins intended secret width, initial version, generation class, storage class,
 * allowed/forbidden uses and destinations. Does **not** prove Keychain writes,
 * CSPRNG quality, or that any secret exists.
 *
 * @type {Readonly<{
 *   secretByteLength: number,
 *   initialSecretVersion: number,
 *   bootstrapGeneration: string,
 *   storageClass: string,
 *   manualBootstrapAllowed: boolean,
 *   plaintextExportAllowed: boolean,
 *   existingFleetDependsOnSecret: boolean,
 *   allowedUses: ReadonlyArray<string>,
 *   forbiddenUses: ReadonlyArray<string>,
 *   forbiddenDestinations: ReadonlyArray<string>,
 *   implementationStage: string,
 * }>}
 */
export const CROSS_LAN_ENROLLMENT_SECRET_POLICY = Object.freeze({
  secretByteLength: 32,
  initialSecretVersion: 1,
  bootstrapGeneration: 'automatic-csprng',
  storageClass: 'dedicated-keychain-item',
  manualBootstrapAllowed: false,
  plaintextExportAllowed: false,
  existingFleetDependsOnSecret: false,
  allowedUses: Object.freeze(['enrollment-code-hmac-digest']),
  forbiddenUses: Object.freeze([
    'device-authentication',
    'e2ee-session-key',
    'device-token-validation',
  ]),
  forbiddenDestinations: Object.freeze([
    'logs',
    'audit',
    'cli-output',
    'crash-report',
    'evidence',
    'plaintext-transport',
  ]),
  implementationStage: 'contract-only-no-keychain-io',
});

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
 * Exact plain/null-prototype record: only enumerable own string data fields,
 * no symbols, no accessors, no non-enumerable own keys. Rejects class
 * instances, arrays, Date, and extra/missing fields vs `expectedKeys`.
 *
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @returns {Record<string, unknown> | null}
 */
function readExactPlainRecord(value, expectedKeys) {
  try {
    if (!isPlainRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length) return null;
    /** @type {Set<string>} */
    const expected = new Set(expectedKeys);
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);
    for (const key of ownKeys) {
      if (typeof key === 'symbol') return null;
      if (!expected.has(key)) return null;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out[key] = desc.value;
    }
    for (const k of expectedKeys) {
      if (!Object.hasOwn(out, k)) return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   status: 'bootstrap-required' | 'ready' | 'unavailable',
 *   errorCode: string | null,
 *   bootstrapRequired: boolean,
 *   generateSecretByteLength: number | null,
 *   writeDedicatedKeychainItem: boolean,
 *   setSecretVersion: number | null,
 *   issueNewCodes: boolean,
 *   verifyNewCodes: boolean,
 *   existingFleetCanContinue: boolean,
 *   manualRegenerateRequired: boolean,
 * }} fields
 */
function freezeBootstrapDecision(fields) {
  return Object.freeze({
    status: fields.status,
    errorCode: fields.errorCode,
    bootstrapRequired: fields.bootstrapRequired,
    generateSecretByteLength: fields.generateSecretByteLength,
    writeDedicatedKeychainItem: fields.writeDedicatedKeychainItem,
    setSecretVersion: fields.setSecretVersion,
    issueNewCodes: fields.issueNewCodes,
    verifyNewCodes: fields.verifyNewCodes,
    existingFleetCanContinue: fields.existingFleetCanContinue,
    manualRegenerateRequired: fields.manualRegenerateRequired,
    requiresFleetReenrollment: false,
  });
}

/**
 * Fail-closed bootstrap decision (invalid input / illegal combination path).
 * @param {{ existingFleetCanContinue: boolean, manualRegenerateRequired: boolean }} opts
 */
function unavailableBootstrap({ existingFleetCanContinue, manualRegenerateRequired }) {
  return freezeBootstrapDecision({
    status: 'unavailable',
    errorCode: ERROR_CODES.ENROLLMENT_SECRET_UNAVAILABLE,
    bootstrapRequired: false,
    generateSecretByteLength: null,
    writeDedicatedKeychainItem: false,
    setSecretVersion: null,
    issueNewCodes: false,
    verifyNewCodes: false,
    existingFleetCanContinue,
    manualRegenerateRequired,
  });
}

const BOOTSTRAP_INPUT_KEYS = Object.freeze([
  'controllerInitializationState',
  'keychainItemState',
]);

/**
 * Pure bootstrap planner for the enrollment HMAC secret.
 *
 * Returns a plan only — does **not** generate secret bytes, write Keychain,
 * or enable code issue/verify by itself.
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   status: 'bootstrap-required' | 'ready' | 'unavailable',
 *   errorCode: string | null,
 *   bootstrapRequired: boolean,
 *   generateSecretByteLength: number | null,
 *   writeDedicatedKeychainItem: boolean,
 *   setSecretVersion: number | null,
 *   issueNewCodes: boolean,
 *   verifyNewCodes: boolean,
 *   existingFleetCanContinue: boolean,
 *   manualRegenerateRequired: boolean,
 *   requiresFleetReenrollment: false,
 * }>}
 */
export function decideCrossLanEnrollmentSecretBootstrap(input) {
  try {
    const record = readExactPlainRecord(input, BOOTSTRAP_INPUT_KEYS);
    if (record === null) {
      return unavailableBootstrap({
        existingFleetCanContinue: false,
        manualRegenerateRequired: false,
      });
    }

    const initState = record.controllerInitializationState;
    const keyState = record.keychainItemState;

    if (
      (initState !== 'authoritatively-uninitialized' && initState !== 'initialized') ||
      (keyState !== 'missing' && keyState !== 'readable' && keyState !== 'unreadable')
    ) {
      return unavailableBootstrap({
        existingFleetCanContinue: false,
        manualRegenerateRequired: false,
      });
    }

    if (initState === 'authoritatively-uninitialized' && keyState === 'missing') {
      // Plan only — issue/verify remain false until Keychain write succeeds externally.
      return freezeBootstrapDecision({
        status: 'bootstrap-required',
        errorCode: null,
        bootstrapRequired: true,
        generateSecretByteLength: CROSS_LAN_ENROLLMENT_SECRET_POLICY.secretByteLength,
        writeDedicatedKeychainItem: true,
        setSecretVersion: CROSS_LAN_ENROLLMENT_SECRET_POLICY.initialSecretVersion,
        issueNewCodes: false,
        verifyNewCodes: false,
        existingFleetCanContinue: false,
        manualRegenerateRequired: false,
      });
    }

    if (initState === 'initialized' && keyState === 'readable') {
      return freezeBootstrapDecision({
        status: 'ready',
        errorCode: null,
        bootstrapRequired: false,
        generateSecretByteLength: null,
        writeDedicatedKeychainItem: false,
        setSecretVersion: null,
        issueNewCodes: true,
        verifyNewCodes: true,
        existingFleetCanContinue: true,
        manualRegenerateRequired: false,
      });
    }

    if (initState === 'initialized' && (keyState === 'missing' || keyState === 'unreadable')) {
      // Never silent bootstrap after initialization — require manual regenerate path.
      return unavailableBootstrap({
        existingFleetCanContinue: true,
        manualRegenerateRequired: true,
      });
    }

    // authoritatively-uninitialized + readable|unreadable: illegal; no silent resume/overwrite.
    return unavailableBootstrap({
      existingFleetCanContinue: false,
      manualRegenerateRequired: false,
    });
  } catch {
    return unavailableBootstrap({
      existingFleetCanContinue: false,
      manualRegenerateRequired: false,
    });
  }
}

const AUTHORIZE_INPUT_KEYS = Object.freeze([
  'explicitAdminRequested',
  'currentSecretVersion',
  'reason',
]);

const AUTHORIZE_RESULT_KEYS = Object.freeze([
  'authorized',
  'reasonCode',
  'reason',
  'currentSecretVersion',
  'nextSecretVersionIfCommitted',
  'generateSecretByteLength',
  'writeKeychainBeforeVersionAdvance',
  'versionAdvanced',
]);

/**
 * @param {{
 *   authorized: boolean,
 *   reasonCode: null | 'invalid-input' | 'not-explicit' | 'invalid-version' | 'version-exhausted',
 *   reason: null | 'rotation' | 'loss',
 *   currentSecretVersion: number | null,
 *   nextSecretVersionIfCommitted: number | null,
 *   generateSecretByteLength: number | null,
 *   writeKeychainBeforeVersionAdvance: boolean,
 * }} fields
 */
function freezeAuthorizeResult(fields) {
  return Object.freeze({
    authorized: fields.authorized,
    reasonCode: fields.reasonCode,
    reason: fields.reason,
    currentSecretVersion: fields.currentSecretVersion,
    nextSecretVersionIfCommitted: fields.nextSecretVersionIfCommitted,
    generateSecretByteLength: fields.generateSecretByteLength,
    writeKeychainBeforeVersionAdvance: fields.writeKeychainBeforeVersionAdvance,
    versionAdvanced: false,
  });
}

/**
 * Fail-closed authorize denial (no side effects, no version advance).
 * @param {'invalid-input' | 'not-explicit' | 'invalid-version' | 'version-exhausted'} reasonCode
 */
function denyAuthorize(reasonCode) {
  return freezeAuthorizeResult({
    authorized: false,
    reasonCode,
    reason: null,
    currentSecretVersion: null,
    nextSecretVersionIfCommitted: null,
    generateSecretByteLength: null,
    writeKeychainBeforeVersionAdvance: false,
  });
}

/**
 * Phase-1 rotation authorization: pure data plan only.
 *
 * Does **not** generate secret bytes, write Keychain, or advance version.
 * The returned object is a structurally-checkable plan (not a capability).
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   authorized: boolean,
 *   reasonCode: null | 'invalid-input' | 'not-explicit' | 'invalid-version' | 'version-exhausted',
 *   reason: null | 'rotation' | 'loss',
 *   currentSecretVersion: number | null,
 *   nextSecretVersionIfCommitted: number | null,
 *   generateSecretByteLength: number | null,
 *   writeKeychainBeforeVersionAdvance: boolean,
 *   versionAdvanced: false,
 * }>}
 */
export function authorizeCrossLanEnrollmentSecretRotation(input) {
  try {
    const record = readExactPlainRecord(input, AUTHORIZE_INPUT_KEYS);
    if (record === null) return denyAuthorize('invalid-input');

    const explicit = record.explicitAdminRequested;
    const version = record.currentSecretVersion;
    const reason = record.reason;

    if (typeof explicit !== 'boolean') return denyAuthorize('invalid-input');
    if (reason !== 'rotation' && reason !== 'loss') return denyAuthorize('invalid-input');
    if (typeof version !== 'number') return denyAuthorize('invalid-input');

    if (!Number.isSafeInteger(version) || version < 1) {
      return denyAuthorize('invalid-version');
    }
    if (version === Number.MAX_SAFE_INTEGER) {
      return denyAuthorize('version-exhausted');
    }
    if (explicit !== true) {
      return denyAuthorize('not-explicit');
    }

    return freezeAuthorizeResult({
      authorized: true,
      reasonCode: null,
      reason,
      currentSecretVersion: version,
      nextSecretVersionIfCommitted: version + 1,
      generateSecretByteLength: CROSS_LAN_ENROLLMENT_SECRET_POLICY.secretByteLength,
      writeKeychainBeforeVersionAdvance: true,
    });
  } catch {
    return denyAuthorize('invalid-input');
  }
}

const COMMIT_INPUT_KEYS = Object.freeze([
  'authorization',
  'keychainWriteSucceeded',
  'observedCurrentSecretVersion',
]);

/**
 * Structural validation of an authorized rotation plan (shape + invariants).
 * Does not rely on object identity / WeakSet / private symbols.
 *
 * @param {unknown} value
 * @returns {{
 *   currentSecretVersion: number,
 *   nextSecretVersionIfCommitted: number,
 *   reason: 'rotation' | 'loss',
 * } | null}
 */
function readAuthorizedRotationPlan(value) {
  const record = readExactPlainRecord(value, AUTHORIZE_RESULT_KEYS);
  if (record === null) return null;

  if (record.authorized !== true) return null;
  if (record.reasonCode !== null) return null;
  if (record.reason !== 'rotation' && record.reason !== 'loss') return null;
  if (record.versionAdvanced !== false) return null;
  if (record.writeKeychainBeforeVersionAdvance !== true) return null;
  if (record.generateSecretByteLength !== CROSS_LAN_ENROLLMENT_SECRET_POLICY.secretByteLength) {
    return null;
  }

  const current = record.currentSecretVersion;
  const next = record.nextSecretVersionIfCommitted;
  if (typeof current !== 'number' || typeof next !== 'number') return null;
  if (!Number.isSafeInteger(current) || current < 1) return null;
  if (current === Number.MAX_SAFE_INTEGER) return null;
  if (!Number.isSafeInteger(next) || next !== current + 1) return null;

  return {
    currentSecretVersion: current,
    nextSecretVersionIfCommitted: next,
    reason: record.reason,
  };
}

/**
 * @param {{
 *   committed: boolean,
 *   reasonCode: null | 'invalid-input' | 'no-authorization' | 'write-failed' | 'version-mismatch',
 *   nextSecretVersion: number | null,
 *   versionAdvanced: boolean,
 *   invalidatePriorUnconsumedCodes: boolean,
 *   invalidatePriorTombstoneNamespace: boolean,
 *   oldCodeErrorCode: string | null,
 *   existingFleetCanContinue: boolean,
 * }} fields
 */
function freezeCommitResult(fields) {
  return Object.freeze({
    committed: fields.committed,
    reasonCode: fields.reasonCode,
    nextSecretVersion: fields.nextSecretVersion,
    versionAdvanced: fields.versionAdvanced,
    invalidatePriorUnconsumedCodes: fields.invalidatePriorUnconsumedCodes,
    invalidatePriorTombstoneNamespace: fields.invalidatePriorTombstoneNamespace,
    oldCodeErrorCode: fields.oldCodeErrorCode,
    existingFleetCanContinue: fields.existingFleetCanContinue,
    requiresFleetReenrollment: false,
  });
}

/**
 * Fail-closed commit denial (no version advance, no invalidation).
 * @param {'invalid-input' | 'no-authorization' | 'write-failed' | 'version-mismatch'} reasonCode
 * @param {boolean} existingFleetCanContinue
 */
function denyCommit(reasonCode, existingFleetCanContinue) {
  return freezeCommitResult({
    committed: false,
    reasonCode,
    nextSecretVersion: null,
    versionAdvanced: false,
    invalidatePriorUnconsumedCodes: false,
    invalidatePriorTombstoneNamespace: false,
    oldCodeErrorCode: null,
    existingFleetCanContinue,
  });
}

/**
 * Phase-2 rotation commit: pure decision after external Keychain write report.
 *
 * Does **not** write Keychain itself. Only after `keychainWriteSucceeded:true`
 * and version CAS match may version advance and old-code invalidation be declared.
 * Existing fleet identity is retained (no re-enroll required).
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   committed: boolean,
 *   reasonCode: null | 'invalid-input' | 'no-authorization' | 'write-failed' | 'version-mismatch',
 *   nextSecretVersion: number | null,
 *   versionAdvanced: boolean,
 *   invalidatePriorUnconsumedCodes: boolean,
 *   invalidatePriorTombstoneNamespace: boolean,
 *   oldCodeErrorCode: string | null,
 *   existingFleetCanContinue: boolean,
 *   requiresFleetReenrollment: false,
 * }>}
 */
export function commitCrossLanEnrollmentSecretRotation(input) {
  try {
    const record = readExactPlainRecord(input, COMMIT_INPUT_KEYS);
    if (record === null) return denyCommit('invalid-input', false);

    const writeSucceeded = record.keychainWriteSucceeded;
    const observed = record.observedCurrentSecretVersion;
    if (typeof writeSucceeded !== 'boolean') return denyCommit('invalid-input', false);
    // Positive safe integer only — NaN/Infinity/0/negative/float/unsafe → invalid-input.
    if (!Number.isSafeInteger(observed) || observed < 1) {
      return denyCommit('invalid-input', false);
    }

    const plan = readAuthorizedRotationPlan(record.authorization);
    if (plan === null) return denyCommit('no-authorization', false);

    if (writeSucceeded !== true) {
      return denyCommit('write-failed', true);
    }

    if (observed !== plan.currentSecretVersion) {
      return denyCommit('version-mismatch', true);
    }

    return freezeCommitResult({
      committed: true,
      reasonCode: null,
      nextSecretVersion: plan.nextSecretVersionIfCommitted,
      versionAdvanced: true,
      invalidatePriorUnconsumedCodes: true,
      invalidatePriorTombstoneNamespace: true,
      oldCodeErrorCode: ERROR_CODES.ENROLLMENT_CODE_UNKNOWN_OR_EXPIRED,
      existingFleetCanContinue: true,
    });
  } catch {
    return denyCommit('invalid-input', false);
  }
}
