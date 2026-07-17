/**
 * Cross-LAN enrollment contract — code representation/policy, digest-record
 * field allowlist, fixed-length constant-time digest compare, tombstone FSM
 * (T1.13a), enrollment-secret lifecycle pure contract (T1.13b / §6.3.x), and
 * code-delivery pure contract (T1.13c: display plan / clipboard plan / QR shape).
 *
 * --- honesty (Gold ADR §6.5) ---
 * [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * [scope] T1.13 M1 contract slices (a+b+c) —
 *   code policy constants,
 *   digest-record field allowlist,
 *   canonical code-shape validator,
 *   timingSafeEqual digest compare,
 *   tombstone FSM,
 *   secret policy constants,
 *   secret bootstrap decision pure contract,
 *   secret rotation authorize/commit pure contract,
 *   delivery policy constants,
 *   display FSM + display plan pure contract,
 *   clipboard plan pure contract,
 *   QR schema identifier + payload shape matcher
 * [coverage] T1.13 M1 contract coverage = COMPLETE (contract task only)
 * [not ready] T1.13 runtime delivery / Keychain / CSPRNG / HMAC = NOT IMPLEMENTED
 *   A25 runtime = NOT READY
 *   Pure planners only — NOT Keychain I/O, CSPRNG generation, HMAC issue/verify,
 *   durable version advance, real UI/CLI, clipboard write, QR image render,
 *   dataDir/log/audit fixtures, or atomic single-writer consume
 *
 * This module does **not** generate codes/salts/secrets, compute HMAC, read
 * secrets, write storage/Keychain, or deliver codes (clipboard/QR/UI).
 * It does **not** accept or return code plaintext on plan paths.
 * Policy numeric constants and plans do **not** prove CSPRNG quality,
 * HMAC correctness, Keychain durability, or that a secret/code was delivered.
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

// ---------------------------------------------------------------------------
// T1.13c — delivery pure contract (display / clipboard / QR shape; no I/O)
// ---------------------------------------------------------------------------

/**
 * Frozen enrollment-code delivery policy (contract-only).
 *
 * Pins intended transport bindings, single-display intent, forbidden
 * plaintext destinations, clipboard/QR honesty stages. Does **not** prove
 * real UI/CLI, clipboard, QR I/O, atomic consume, or A25 runtime readiness.
 *
 * M1 does **not** claim atomic one-shot consumption
 * (`atomicConsumeEnforcement` defers to M3 single-writer state).
 * `verified-loopback` / `same-process-cli` are adapter **claims** only —
 * real socket/process binding is M3.
 *
 * @type {Readonly<{
 *   displayTransportBindings: ReadonlyArray<string>,
 *   intendedMaximumPlaintextDisplays: number,
 *   atomicConsumeEnforcement: string,
 *   plaintextPersistenceAllowed: boolean,
 *   forbiddenPlaintextDestinations: ReadonlyArray<string>,
 *   automaticClipboardCopyAllowed: boolean,
 *   clipboardRequiresExplicitUserAction: boolean,
 *   clipboardRiskWarningRequired: boolean,
 *   clipboardClearingPromise: string,
 *   qrSchemaIdentifier: string,
 *   qrEccPolicy: string,
 *   qrEccValidationStage: string,
 *   implementationStage: string,
 *   a25RuntimeStatus: string,
 * }>}
 */
export const CROSS_LAN_ENROLLMENT_DELIVERY_POLICY = Object.freeze({
  displayTransportBindings: Object.freeze(['verified-loopback', 'same-process-cli']),
  intendedMaximumPlaintextDisplays: 1,
  atomicConsumeEnforcement: 'deferred-to-M3-single-writer-state',
  plaintextPersistenceAllowed: false,
  forbiddenPlaintextDestinations: Object.freeze([
    'dataDir',
    'logs',
    'audit',
    'crash-report',
    'evidence',
    'remote-management',
    'non-loopback-interface',
  ]),
  automaticClipboardCopyAllowed: false,
  clipboardRequiresExplicitUserAction: true,
  clipboardRiskWarningRequired: true,
  clipboardClearingPromise: 'advisory-only',
  qrSchemaIdentifier: 'enrollmentQr/v1',
  qrEccPolicy: 'implementation-selected',
  qrEccValidationStage: 'not-in-M1',
  implementationStage: 'contract-only-no-delivery-io',
  a25RuntimeStatus: 'not-ready',
});

/**
 * Display delivery FSM: typed transport-binding claims only.
 *
 * One-way: undelivered → delivered via verified-loopback or same-process-cli.
 * No path returns to undelivered. M1 does not enforce atomic consume.
 *
 * @type {Readonly<{
 *   undelivered: Readonly<Record<string, string>>,
 *   delivered: Readonly<Record<string, never>>,
 * }>}
 */
export const CROSS_LAN_ENROLLMENT_DISPLAY_TRANSITIONS = Object.freeze({
  undelivered: Object.freeze({
    'verified-loopback': 'delivered',
    'same-process-cli': 'delivered',
  }),
  delivered: Object.freeze({}),
});

const DISPLAY_INPUT_KEYS = Object.freeze(['transportBinding', 'priorDisplayState']);

/**
 * @param {{
 *   status: 'allow-display-plan' | 'blocked',
 *   reasonCode: null | 'invalid-input' | 'transport-not-verified' | 'already-delivered',
 *   displayReceiptState: 'display-authorized' | 'not-authorized',
 *   nextDisplayState: 'delivered' | null,
 * }} fields
 */
function freezeDisplayPlan(fields) {
  return Object.freeze({
    status: fields.status,
    reasonCode: fields.reasonCode,
    displayReceiptState: fields.displayReceiptState,
    nextDisplayState: fields.nextDisplayState,
    plaintextPersistenceAllowed: false,
    automaticClipboardWriteAllowed: false,
    enforcementNote: 'atomic-consume-deferred-to-M3',
  });
}

/**
 * Fail-closed display plan denial (no plaintext, no throw).
 * @param {'invalid-input' | 'transport-not-verified' | 'already-delivered'} reasonCode
 */
function blockDisplayPlan(reasonCode) {
  return freezeDisplayPlan({
    status: 'blocked',
    reasonCode,
    displayReceiptState: 'not-authorized',
    nextDisplayState: null,
  });
}

/**
 * Pure display planner: typed binding claim + one-way FSM.
 *
 * Returns a structural plan only — not an unforgeable receipt, not real UI/CLI
 * I/O, and not atomic single-writer consume (deferred to M3).
 * Never accepts or returns code plaintext.
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   status: 'allow-display-plan' | 'blocked',
 *   reasonCode: null | 'invalid-input' | 'transport-not-verified' | 'already-delivered',
 *   displayReceiptState: 'display-authorized' | 'not-authorized',
 *   nextDisplayState: 'delivered' | null,
 *   plaintextPersistenceAllowed: false,
 *   automaticClipboardWriteAllowed: false,
 *   enforcementNote: 'atomic-consume-deferred-to-M3',
 * }>}
 */
export function decideCrossLanEnrollmentDisplayPlan(input) {
  try {
    const record = readExactPlainRecord(input, DISPLAY_INPUT_KEYS);
    if (record === null) return blockDisplayPlan('invalid-input');

    const binding = record.transportBinding;
    const prior = record.priorDisplayState;

    // Exact allowed enums only (null is a typed value for binding; state null = invalid).
    const bindingOk =
      binding === null || binding === 'verified-loopback' || binding === 'same-process-cli';
    const stateOk = prior === 'undelivered' || prior === 'delivered';
    if (!bindingOk || !stateOk) return blockDisplayPlan('invalid-input');

    // already-delivered has priority over transport-not-verified.
    if (prior === 'delivered') return blockDisplayPlan('already-delivered');
    if (binding === null) return blockDisplayPlan('transport-not-verified');

    // undelivered + allowed binding claim → allow plan (adapter claim only).
    return freezeDisplayPlan({
      status: 'allow-display-plan',
      reasonCode: null,
      displayReceiptState: 'display-authorized',
      nextDisplayState: 'delivered',
    });
  } catch {
    return blockDisplayPlan('invalid-input');
  }
}

const CLIPBOARD_INPUT_KEYS = Object.freeze([
  'displayPlan',
  'riskWarningDisplayed',
  'userInitiatedAction',
]);

const DISPLAY_PLAN_KEYS = Object.freeze([
  'status',
  'reasonCode',
  'displayReceiptState',
  'nextDisplayState',
  'plaintextPersistenceAllowed',
  'automaticClipboardWriteAllowed',
  'enforcementNote',
]);

/**
 * Structural validation of an allow-display-plan (shape + invariants).
 * Structural data only — not object-identity branding / capability.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isAuthorizedDisplayPlan(value) {
  const record = readExactPlainRecord(value, DISPLAY_PLAN_KEYS);
  if (record === null) return false;
  return (
    record.status === 'allow-display-plan' &&
    record.reasonCode === null &&
    record.displayReceiptState === 'display-authorized' &&
    record.nextDisplayState === 'delivered' &&
    record.plaintextPersistenceAllowed === false &&
    record.automaticClipboardWriteAllowed === false &&
    record.enforcementNote === 'atomic-consume-deferred-to-M3'
  );
}

/**
 * @param {{
 *   status: 'allow-manual-clipboard-write' | 'blocked',
 *   reasonCode: null | 'invalid-input' | 'no-authorized-display' | 'risk-warning-not-displayed' | 'not-user-initiated',
 *   clipboardWriteAllowed: boolean,
 * }} fields
 */
function freezeClipboardPlan(fields) {
  return Object.freeze({
    status: fields.status,
    reasonCode: fields.reasonCode,
    clipboardWriteAllowed: fields.clipboardWriteAllowed,
    automaticCopyAllowed: false,
    clearingAdvisoryOnly: true,
    implementationStage: 'contract-only-no-clipboard-io',
  });
}

/**
 * Fail-closed clipboard plan denial.
 * @param {'invalid-input' | 'no-authorized-display' | 'risk-warning-not-displayed' | 'not-user-initiated'} reasonCode
 */
function blockClipboardPlan(reasonCode) {
  return freezeClipboardPlan({
    status: 'blocked',
    reasonCode,
    clipboardWriteAllowed: false,
  });
}

/**
 * Pure clipboard planner: requires structured allow-display-plan + risk warning
 * displayed + explicit user action. Plan only — does not write clipboard and
 * never carries code plaintext. `riskWarningDisplayed` means displayed, not
 * acknowledged. Clearing remains advisory-only.
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   status: 'allow-manual-clipboard-write' | 'blocked',
 *   reasonCode: null | 'invalid-input' | 'no-authorized-display' | 'risk-warning-not-displayed' | 'not-user-initiated',
 *   clipboardWriteAllowed: boolean,
 *   automaticCopyAllowed: false,
 *   clearingAdvisoryOnly: true,
 *   implementationStage: 'contract-only-no-clipboard-io',
 * }>}
 */
export function decideCrossLanEnrollmentClipboardPlan(input) {
  try {
    const record = readExactPlainRecord(input, CLIPBOARD_INPUT_KEYS);
    if (record === null) return blockClipboardPlan('invalid-input');

    const risk = record.riskWarningDisplayed;
    const user = record.userInitiatedAction;
    if (typeof risk !== 'boolean' || typeof user !== 'boolean') {
      return blockClipboardPlan('invalid-input');
    }

    if (!isAuthorizedDisplayPlan(record.displayPlan)) {
      return blockClipboardPlan('no-authorized-display');
    }
    if (risk !== true) return blockClipboardPlan('risk-warning-not-displayed');
    if (user !== true) return blockClipboardPlan('not-user-initiated');

    return freezeClipboardPlan({
      status: 'allow-manual-clipboard-write',
      reasonCode: null,
      clipboardWriteAllowed: true,
    });
  } catch {
    return blockClipboardPlan('invalid-input');
  }
}

/**
 * QR payload schema freeze (identifier + top-level field allowlist only).
 *
 * Nested wire schema, ECC, and value provenance are deferred.
 * `shapeMatcherLimit` honestly states this matcher does not detect secrets
 * embedded inside legitimate public string values or renamed fields.
 *
 * @type {Readonly<{
 *   identifier: string,
 *   topLevelFields: ReadonlyArray<string>,
 *   topLevelFieldNamesStatus: string,
 *   nestedWireSchemaStatus: string,
 *   valueProvenanceValidationStage: string,
 *   eccValidationStage: string,
 *   shapeMatcherLimit: string,
 * }>}
 */
export const CROSS_LAN_ENROLLMENT_QR_SCHEMA = Object.freeze({
  identifier: 'enrollmentQr/v1',
  topLevelFields: Object.freeze([
    'schema',
    'codeId',
    'code',
    'expiry',
    'controllerPublicMetadata',
    'relayPublicMetadata',
  ]),
  topLevelFieldNamesStatus: 'implementation-stable-not-spec-frozen',
  nestedWireSchemaStatus: 'deferred-to-M2',
  valueProvenanceValidationStage: 'deferred-to-M3-A25-runtime',
  eccValidationStage: 'not-in-M1',
  shapeMatcherLimit: 'does-not-detect-secrets-embedded-in-public-string-values',
});

const QR_TOP_LEVEL_KEYS = CROSS_LAN_ENROLLMENT_QR_SCHEMA.topLevelFields;

/** Nested key names rejected exactly (no substring scan). */
const QR_FORBIDDEN_NESTED_KEYS = Object.freeze([
  'enrollmentHmacSecret',
  'privateKey',
  'deviceToken',
  'proxyAuthorizationSecret',
  'sessionKey',
]);

const QR_METADATA_MAX_DEPTH = 4;

/**
 * Dense array: own keys must be exactly `0..length-1` + `length`.
 * @param {unknown} value
 * @returns {boolean}
 */
function isDenseArray(value) {
  try {
    if (!Array.isArray(value)) return false;
    const keys = Reflect.ownKeys(value);
    const expected = [];
    for (let i = 0; i < value.length; i += 1) expected.push(String(i));
    expected.push('length');
    if (keys.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i += 1) {
      if (keys[i] !== expected[i]) return false;
    }
    for (let i = 0; i < value.length; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(value, String(i));
      if (!desc || desc.enumerable !== true) return false;
      if (desc.get !== undefined || desc.set !== undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON-like public metadata leaf/container validator (limited depth).
 * Allows string/boolean/null/non-negative safe integer, dense arrays,
 * plain/null-prototype records. Rejects accessor/symbol/non-enumerable,
 * sparse arrays, Proxy/revoked, cycles, over-depth, and exact forbidden keys.
 *
 * Does **not** scan string values for embedded secrets
 * (see CROSS_LAN_ENROLLMENT_QR_SCHEMA.shapeMatcherLimit).
 *
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @param {boolean} allowEmptyRecord
 * @returns {boolean}
 */
function isJsonLikePublicData(value, depth, seen, allowEmptyRecord) {
  try {
    if (depth > QR_METADATA_MAX_DEPTH) return false;

    if (value === null) return true;
    if (typeof value === 'boolean') return true;
    if (typeof value === 'string') return true;
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0;
    }

    if (Array.isArray(value)) {
      if (!isDenseArray(value)) return false;
      if (seen.has(value)) return false;
      seen.add(value);
      for (let i = 0; i < value.length; i += 1) {
        if (!isJsonLikePublicData(value[i], depth + 1, seen, true)) return false;
      }
      return true;
    }

    if (!isPlainRecord(value)) return false;
    if (seen.has(value)) return false;
    seen.add(value);

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length === 0) return allowEmptyRecord === true;

    for (const key of ownKeys) {
      if (typeof key === 'symbol') return false;
      if (QR_FORBIDDEN_NESTED_KEYS.includes(key)) return false;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.enumerable !== true) return false;
      if (desc.get !== undefined || desc.set !== undefined) return false;
      if (!isJsonLikePublicData(desc.value, depth + 1, seen, true)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Shape-only QR payload matcher. Never throws; never generates QR images.
 *
 * Top-level exact six fields; `code` reuses canonical 16B/22-char validator.
 * Nested metadata is limited-depth JSON-like public data only.
 * Does **not** detect secrets embedded in public string values or renamed
 * fields (honest limit in CROSS_LAN_ENROLLMENT_QR_SCHEMA.shapeMatcherLimit).
 *
 * @param {unknown} payload
 * @returns {boolean}
 */
export function matchesCrossLanEnrollmentQrPayloadShape(payload) {
  try {
    const record = readExactPlainRecord(payload, QR_TOP_LEVEL_KEYS);
    if (record === null) return false;

    if (record.schema !== CROSS_LAN_ENROLLMENT_QR_SCHEMA.identifier) return false;

    if (typeof record.codeId !== 'string' || record.codeId.length === 0) return false;
    if (!isCanonicalCrossLanEnrollmentCode(record.code)) return false;

    const expiry = record.expiry;
    if (typeof expiry === 'string') {
      if (expiry.length === 0) return false;
    } else if (typeof expiry === 'number') {
      if (!Number.isSafeInteger(expiry) || expiry < 0) return false;
    } else {
      return false;
    }

    // controller: non-empty plain/null-prototype data record
    if (!isPlainRecord(record.controllerPublicMetadata)) return false;
    if (Reflect.ownKeys(record.controllerPublicMetadata).length === 0) return false;
    if (
      !isJsonLikePublicData(
        record.controllerPublicMetadata,
        0,
        new WeakSet(),
        false,
      )
    ) {
      return false;
    }

    // relay: plain/null-prototype data record; empty allowed (direct/LAN-only)
    if (!isPlainRecord(record.relayPublicMetadata)) return false;
    if (
      !isJsonLikePublicData(record.relayPublicMetadata, 0, new WeakSet(), true)
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
