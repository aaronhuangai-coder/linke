/**
 * Cross-LAN Controller Noise static lifecycle pure contract (T1.18 M1 only).
 *
 * --- honesty ---
 * [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * [scope] T1.18 M1 frozen Case A / Case B policy + semantic update matcher +
 *   preserve-old predicate + trust-recovery classifier only
 * [coverage] contract-only-not-runtime-proof
 * [not ready] A27–A29 real signature / E2EE / time window / persistence /
 *   ack / grace timer / fleet re-enroll runtime = NOT IMPLEMENTED
 * [flag] a27A29RuntimeStatus = 'not-ready'
 *
 * Case A: online X25519 static rotation while Ed25519 identity remains
 * trusted and proven (authenticated E2EE only). Case B: Ed25519 identity
 * compromised or controller trust state unproven → fleet replace/reenroll;
 * no online self-proof with the old identity. Caller claims are not
 * runtime proof. Outputs are booleans / closed labels only — never echo
 * pubkey or signature material.
 */

import {
  CONTROL_PLANE_MESSAGE_SCHEMAS,
  shouldRejectCrossLanTrustEpoch,
} from './cross-lan-protocol.js';
import { ERROR_CODES } from './error-codes.js';

// ---------------------------------------------------------------------------
// T1.2 required-field array refs (must be identity-equal, not copies)
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<string>} */
const UPDATE_REQUIRED_FIELDS =
  CONTROL_PLANE_MESSAGE_SCHEMAS['controller-noise-key-update'].requiredFields;

/** @type {ReadonlyArray<string>} */
const ACK_REQUIRED_FIELDS =
  CONTROL_PLANE_MESSAGE_SCHEMAS['controller-noise-key-ack'].requiredFields;

/** Nonempty string fields of controller-noise-key-update (excludes epoch). */
const UPDATE_NONEMPTY_STRING_FIELDS = Object.freeze([
  'oldNoiseStaticPub',
  'newNoiseStaticPub',
  'notBefore',
  'graceUntil',
  'updateId',
  'signature',
]);

/** Wrapper fields for preserve-old-static predicate (exact shape). */
const PRESERVE_WRAPPER_FIELDS = Object.freeze([
  'message',
  'lastAcceptedTrustEpoch',
  'authenticatedE2eeEstablished',
  'ed25519IdentityCompromised',
  'controllerTrustStateProven',
  'signatureVerified',
  'timeWindowValidated',
  'oldStaticMatchesActiveSet',
  'updateIdUnseen',
  'persistenceSucceeded',
]);

/** Boolean claim fields that must be strictly `=== true` for apply path. */
const PRESERVE_TRUE_CLAIM_FIELDS = Object.freeze([
  'authenticatedE2eeEstablished',
  'signatureVerified',
  'timeWindowValidated',
  'oldStaticMatchesActiveSet',
  'updateIdUnseen',
  'persistenceSucceeded',
]);

/** Trust-recovery classifier exact fields. */
const TRUST_RECOVERY_FIELDS = Object.freeze([
  'ed25519IdentityCompromised',
  'controllerTrustStateProven',
  'authenticatedE2eeEstablished',
]);

const UINT64_MAX = (1n << 64n) - 1n;

// ---------------------------------------------------------------------------
// Frozen policy (exact top-level 8 keys; nested deep-frozen)
// ---------------------------------------------------------------------------

/**
 * Frozen Controller Noise static lifecycle policy (T1.18 / §6.7.8 A27–A29
 * contract-level).
 *
 * Declares message types, required field lists (shared with T1.2 frozen
 * arrays), Case A online-rotate rules, Case B fleet-reenroll rules, trustEpoch
 * scope/rule, and M1 honesty (no sig/persist/ack/timer). Does **not** execute
 * rotation, verify signatures, parse clocks, emit ack, or run grace timers.
 *
 * @type {Readonly<{
 *   updateMessageType: string,
 *   ackMessageType: string,
 *   requiredUpdateFields: ReadonlyArray<string>,
 *   requiredAckFields: ReadonlyArray<string>,
 *   caseA: Readonly<Record<string, unknown>>,
 *   caseB: Readonly<Record<string, unknown>>,
 *   trustEpoch: Readonly<Record<string, unknown>>,
 *   honesty: Readonly<Record<string, unknown>>,
 * }>}
 */
export const CROSS_LAN_CONTROLLER_NOISE_STATIC_POLICY = Object.freeze({
  updateMessageType: 'controller-noise-key-update',
  ackMessageType: 'controller-noise-key-ack',
  requiredUpdateFields: UPDATE_REQUIRED_FIELDS,
  requiredAckFields: ACK_REQUIRED_FIELDS,
  caseA: Object.freeze({
    deliveryChannel: 'authenticated-e2ee-established-only',
    signatureAuthority: 'trusted-controller-ed25519-canonical-tbs',
    signatureCoversAllRequiredUpdateFields: true,
    oldMustDifferFromNew: true,
    persistBeforeAckRequired: true,
    atomicPersistenceClaim:
      'overlap-plus-lastAcceptedTrustEpoch-plus-updateId-dedup',
    updateIdDedupRequired: true,
    oldAndNewAcceptedDuringInclusiveOverlap: true,
    oldRejectedAfterGrace: true,
    oldRejectedAfterGraceErrorCode: ERROR_CODES.HANDSHAKE_IDENTITY_FAILED,
    emergencyRevokeEncoding: 'graceUntil-equals-notBefore',
    preserveOldSetOnAnyFailure: true,
    skipSignatureVerificationAllowed: false,
    caseAMessageCanRotateIdentity: false,
  }),
  caseB: Object.freeze({
    triggers: Object.freeze([
      'ed25519-identity-compromised',
      'controller-trust-state-unproven',
    ]),
    action: 'fleet-replace-reenroll',
    newEd25519IdentityRequired: true,
    newNoiseStaticRequired: true,
    newTrustEpochRequired: true,
    revokeOldBindings: Object.freeze([
      'ed25519-identity',
      'noise-static',
      'enrollment-binding',
    ]),
    onlineSelfProofAllowed: false,
    caseAMessageAcceptedForIdentityRotation: false,
    requiresOutOfBandCleanBootstrap: true,
    errorCode: ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
  }),
  trustEpoch: Object.freeze({
    scope: 'controller-global',
    rule: 'positive-uint64-strictly-greater-than-last-accepted',
    staleErrorCode: ERROR_CODES.STALE_EPOCH_REJECTED,
    orthogonalFields: Object.freeze([
      'enrollmentEpoch',
      'revokeGeneration',
    ]),
    growthAloneRequiresFleetReenroll: false,
  }),
  honesty: Object.freeze({
    callerClaimsAreRuntimeProof: false,
    m1PerformsSignatureVerification: false,
    m1PerformsPersistence: false,
    m1EmitsAck: false,
    m1RunsGraceTimer: false,
    a27A29RuntimeStatus: 'not-ready',
    implementationStage: 'T1.18-M1-contract-only',
  }),
});

// ---------------------------------------------------------------------------
// Descriptor snapshot helpers — ownKeys once; getOwnPropertyDescriptor once
// per key; same descriptor validates + captures; no ordinary field get.
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isOrdinaryOrNullPrototypeRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Snapshot exact ordinary/null-prototype record fields from descriptors only.
 * Reflect.ownKeys once; each key getOwnPropertyDescriptor exactly once.
 * Rejects symbols, non-enumerable, accessors, wrong key sets.
 *
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @returns {Record<string, unknown> | null}
 */
function snapshotExactRecord(value, expectedKeys) {
  try {
    if (!isOrdinaryOrNullPrototypeRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length) return null;

    /** @type {Set<string>} */
    const expected = new Set(expectedKeys);
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);

    for (const key of ownKeys) {
      if (typeof key !== 'string') return null;
      if (!expected.has(key)) return null;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out[key] = desc.value;
    }

    for (const k of expectedKeys) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Positive uint64 BigInt check (≥ 1, ≤ 2^64-1) — no coercion.
 * @param {unknown} value
 * @returns {value is bigint}
 */
function isPositiveUint64BigInt(value) {
  return (
    typeof value === 'bigint' && value >= 1n && value <= UINT64_MAX
  );
}

/**
 * Validate a descriptor-value snapshot of a controller-noise-key-update
 * record. Consumes only the provided snapshot object — does not re-read the
 * original message via ordinary property get.
 *
 * @param {Record<string, unknown>} rec
 * @returns {boolean}
 */
function isValidControllerNoiseKeyUpdateRecordSnapshot(rec) {
  for (const field of UPDATE_NONEMPTY_STRING_FIELDS) {
    if (!isNonemptyString(rec[field])) return false;
  }
  // string-level distinct; no X25519 encoding validation
  if (rec.oldNoiseStaticPub === rec.newNoiseStaticPub) return false;
  if (!isPositiveUint64BigInt(rec.trustEpoch)) return false;
  return true;
}

/**
 * Semantic matcher for raw `controller-noise-key-update` messages (T1.18).
 *
 * Accepts an unknown message. Requires an exact ordinary / null-prototype
 * record with exactly the T1.2 seven own enumerable string data fields.
 * Values are taken from property descriptors so get traps cannot
 * false-accept. Six string fields must be nonempty (no trim/normalize/
 * regex/Date.parse). `oldNoiseStaticPub` must differ from
 * `newNoiseStaticPub` at string level. `trustEpoch` must be a positive
 * uint64 BigInt. Total / no-throw. NOT a signature, time-window, or wire
 * validator.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function matchesCrossLanControllerNoiseKeyUpdateContract(input) {
  try {
    const rec = snapshotExactRecord(input, UPDATE_REQUIRED_FIELDS);
    if (rec === null) return false;
    return isValidControllerNoiseKeyUpdateRecordSnapshot(rec);
  } catch {
    return false;
  }
}

/**
 * Fail-closed preserve-old-static predicate after a Case A update attempt
 * (T1.18).
 *
 * Exact wrapper record with fields:
 *   `message`, `lastAcceptedTrustEpoch`, `authenticatedE2eeEstablished`,
 *   `ed25519IdentityCompromised`, `controllerTrustStateProven`,
 *   `signatureVerified`, `timeWindowValidated`, `oldStaticMatchesActiveSet`,
 *   `updateIdUnseen`, `persistenceSucceeded`.
 *
 * Wrapper and nested message are snapshotted once via property descriptors
 * in a single call; decisions consume only that snapshot (no public
 * matcher-then-re-read of the live message; no ordinary `message.field`
 * decisions). Any invalid shape / type / accessor / symbol / Proxy throw /
 * revoked → `true` (preserve old static set = leave existing persisted set
 * unchanged).
 *
 * Returns `false` only when every gate passes: message is semantically valid,
 * candidate epoch is strictly greater via `shouldRejectCrossLanTrustEpoch`,
 * `authenticatedE2eeEstablished === true`, `ed25519IdentityCompromised ===
 * false`, `controllerTrustStateProven === true`, and the five remaining
 * claim flags are strictly `=== true`. Identity compromised or trust state
 * unproven always preserves even when E2EE / signature / persistence claims
 * are true — math-valid signature cannot substitute identity trust.
 *
 * `persistenceSucceeded` claim semantics are solely
 * `policy.caseA.atomicPersistenceClaim` (overlap + new lastAcceptedTrustEpoch
 * + updateId dedup atomic persist all succeeded). It is a caller claim, not
 * M1 proof.
 *
 * `false` only allows the caller to enter subsequent apply/ack runtime
 * (which may include inclusive old/new dual-key overlap); it does **not**
 * mean immediately delete old statics. This function never verifies
 * signatures, E2EE, clocks, set membership, or persistence, and never emits
 * ack / keys / alerts / timers.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function shouldPreserveOldCrossLanControllerNoiseStaticsAfterUpdateAttempt(
  input,
) {
  try {
    const wrapper = snapshotExactRecord(input, PRESERVE_WRAPPER_FIELDS);
    if (wrapper === null) return true;

    // Single message descriptor snapshot for this call — never re-read live.
    const messageSnap = snapshotExactRecord(
      wrapper.message,
      UPDATE_REQUIRED_FIELDS,
    );
    if (messageSnap === null) return true;
    if (!isValidControllerNoiseKeyUpdateRecordSnapshot(messageSnap)) {
      return true;
    }

    // Fresh epoch via existing T1.14 predicate on descriptor-snapshotted values.
    if (
      shouldRejectCrossLanTrustEpoch({
        trustEpoch: messageSnap.trustEpoch,
        lastAcceptedTrustEpoch: wrapper.lastAcceptedTrustEpoch,
      })
    ) {
      return true;
    }

    // Case A hard gates: identity must not be compromised; trust must be proven.
    if (wrapper.ed25519IdentityCompromised !== false) return true;
    if (wrapper.controllerTrustStateProven !== true) return true;

    for (const claim of PRESERVE_TRUE_CLAIM_FIELDS) {
      if (wrapper[claim] !== true) return true;
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Pure Case A / Case B trust-recovery classifier (T1.18).
 *
 * Exact record of three strict booleans:
 *   `ed25519IdentityCompromised`, `controllerTrustStateProven`,
 *   `authenticatedE2eeEstablished`.
 *
 * Closed output priority:
 * 1. invalid shape/type/extra/Proxy → `invalid-input`
 * 2. compromised === true OR proven === false →
 *    `case-b-fleet-reenroll-required` (priority over E2EE; old identity
 *    cannot online self-prove)
 * 3. trusted but E2EE false → `case-a-blocked-no-authenticated-e2ee`
 * 4. trusted + E2EE true → `case-a-online-update-eligible`
 *
 * Extra fields such as `signatureVerified` / `enrollmentEpoch` /
 * `revokeGeneration` are rejected (Case B cannot be bypassed by a signature
 * claim field). Total / no-throw. Not runtime proof.
 *
 * @param {unknown} input
 * @returns {
 *   'invalid-input' |
 *   'case-b-fleet-reenroll-required' |
 *   'case-a-blocked-no-authenticated-e2ee' |
 *   'case-a-online-update-eligible'
 * }
 */
export function classifyCrossLanControllerNoiseTrustRecovery(input) {
  try {
    const rec = snapshotExactRecord(input, TRUST_RECOVERY_FIELDS);
    if (rec === null) return 'invalid-input';

    const compromised = rec.ed25519IdentityCompromised;
    const proven = rec.controllerTrustStateProven;
    const e2ee = rec.authenticatedE2eeEstablished;

    if (compromised !== true && compromised !== false) return 'invalid-input';
    if (proven !== true && proven !== false) return 'invalid-input';
    if (e2ee !== true && e2ee !== false) return 'invalid-input';

    // Case B priority: identity compromised OR trust unproven.
    if (compromised === true || proven === false) {
      return 'case-b-fleet-reenroll-required';
    }

    // Trusted identity path: still requires authenticated E2EE for Case A.
    if (e2ee === false) {
      return 'case-a-blocked-no-authenticated-e2ee';
    }

    return 'case-a-online-update-eligible';
  } catch {
    return 'invalid-input';
  }
}
