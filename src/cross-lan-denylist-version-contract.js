/**
 * Cross-LAN denylistVersion uint64 boundary pure contract (T1.19 M1 / A30).
 *
 * --- honesty ---
 * [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * [scope] T1.19 M1 frozen denylistVersion allocation planner + trust-recovery
 *   classifier only (spec §4.6.1–§4.6.2 / §6.11 / §7.1 A30)
 * [coverage] contract-only-not-runtime-proof
 * [not ready] A30 runtime denylist publish / ack / persistence / migration /
 *   fleet replace/re-enroll / controller trust-state transition = NOT IMPLEMENTED
 * [flag] a30RuntimeStatus = 'not-ready'
 *
 * Strict BigInt uint64 semantic representation (no Number/string coercion).
 * UINT64_MAX is reserved never-published; wrap is forbidden. Caller claims
 * are not runtime proof. No network / persistence / ack / migration I/O.
 */

import { CONTROL_PLANE_MESSAGE_SCHEMAS } from './cross-lan-protocol.js';
import { ERROR_CODES } from './error-codes.js';

// ---------------------------------------------------------------------------
// T1.2 required-field array refs (must be identity-equal, not copies)
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<string>} */
const UPDATE_REQUIRED_FIELDS =
  CONTROL_PLANE_MESSAGE_SCHEMAS['denylist-update'].requiredFields;

/** @type {ReadonlyArray<string>} */
const ACK_REQUIRED_FIELDS =
  CONTROL_PLANE_MESSAGE_SCHEMAS['denylist-ack'].requiredFields;

/** Semantic uint64 max; reserved never-published exhaustion ceiling. */
const UINT64_MAX = (1n << 64n) - 1n;

/** Last safe published denylistVersion (MAX-1). */
const LAST_SAFE_PUBLISHED = UINT64_MAX - 1n;

/** Current published version whose only safe next is LAST_SAFE_PUBLISHED. */
const FINAL_SAFE_CURRENT = UINT64_MAX - 2n;

/** Highest current that still allows ordinary safe +1 allocation. */
const ORDINARY_MAX_CURRENT = UINT64_MAX - 3n;

const PLAN_INPUT_KEYS = Object.freeze(['currentDenylistVersion']);

const DECISION = Object.freeze({
  ordinary: 'ordinary-safe-allocation',
  finalSafe: 'final-safe-allocation-requires-trust-transition',
  exhausted: 'exhausted-fail-closed',
  invalid: 'invalid-unverifiable-input',
});

const RECOVERY = Object.freeze({
  none: 'no-recovery-required',
  full: 'full-fleet-recovery-required',
  invalid: 'invalid-input',
});

const DECISION_KEYS = Object.freeze([
  'decision',
  'currentDenylistVersion',
  'nextDenylistVersion',
  'errorCode',
  'requiresControllerTrustStateTransition',
  'stopAuthoritativeControllerService',
  'requiresFullFleetReplaceReenroll',
  'requiresNewGlobalEpoch',
  'invalidateOldTrustMaterialCategories',
  'l1AcceptanceAuthorizesL2',
]);

/** Fixed category labels only — never secret/path/key material values. */
const INVALIDATED_TRUST_MATERIAL_CATEGORIES = Object.freeze([
  'bindings',
  'identity',
  'statics',
  'enrollment',
  'material',
]);

const EMPTY_CATEGORIES = Object.freeze(/** @type {string[]} */ ([]));

// ---------------------------------------------------------------------------
// Frozen policy
// ---------------------------------------------------------------------------

/**
 * Frozen denylistVersion boundary policy (T1.19 / §4.6.2 A30 contract-level).
 *
 * Declares update/ack message types with direct T1.2 requiredFields identity
 * refs, strict BigInt uint64 semantics, reserved unpublished MAX, last safe
 * published version, no-wrap rule, final-safe transition rule, L1 non-authority
 * / L2 sole authority, full fleet recovery categories, and M1 honesty.
 * Does **not** publish denylist, emit ack, persist, migrate, or re-enroll.
 *
 * @type {Readonly<{
 *   updateMessageType: string,
 *   ackMessageType: string,
 *   requiredUpdateFields: ReadonlyArray<string>,
 *   requiredAckFields: ReadonlyArray<string>,
 *   versionRepresentation: string,
 *   uint64Max: bigint,
 *   maxIsReservedUnpublished: true,
 *   lastSafePublishedVersion: bigint,
 *   wrapAllowed: false,
 *   finalSafeCurrentVersion: bigint,
 *   finalSafeAllocationRule: string,
 *   exhaustionErrorCode: string,
 *   authority: Readonly<Record<string, boolean>>,
 *   recovery: Readonly<Record<string, unknown>>,
 *   honesty: Readonly<Record<string, unknown>>,
 * }>}
 */
export const CROSS_LAN_DENYLIST_VERSION_POLICY = Object.freeze({
  updateMessageType: 'denylist-update',
  ackMessageType: 'denylist-ack',
  requiredUpdateFields: UPDATE_REQUIRED_FIELDS,
  requiredAckFields: ACK_REQUIRED_FIELDS,
  versionRepresentation: 'strict-bigint-uint64',
  uint64Max: UINT64_MAX,
  maxIsReservedUnpublished: true,
  lastSafePublishedVersion: LAST_SAFE_PUBLISHED,
  wrapAllowed: false,
  finalSafeCurrentVersion: FINAL_SAFE_CURRENT,
  finalSafeAllocationRule:
    'allocate-last-safe-then-mandatory-trust-transition',
  exhaustionErrorCode: ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
  authority: Object.freeze({
    l1RelayDenylistIsAuthoritative: false,
    l2ControllerIsSoleAuthority: true,
    l1AcceptanceAuthorizesL2: false,
  }),
  recovery: Object.freeze({
    action: 'full-fleet-replace-reenroll',
    requiresControllerTrustStateTransition: true,
    stopAuthoritativeControllerService: true,
    requiresNewGlobalEpoch: true,
    invalidateOldTrustMaterialCategories: INVALIDATED_TRUST_MATERIAL_CATEGORIES,
  }),
  honesty: Object.freeze({
    callerClaimsAreRuntimeProof: false,
    m1PerformsNetwork: false,
    m1PerformsPersistence: false,
    m1EmitsAck: false,
    m1PerformsMigration: false,
    a30RuntimeStatus: 'not-ready',
    implementationStage: 'T1.19-M1-contract-only',
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
 * Exact frozen dense plain string-array matcher (descriptor-only).
 *
 * Accepts only a real plain Array (`Object.getPrototypeOf === Array.prototype`)
 * whose own keys are exactly `0..n-1` plus `length`. Captures each own key via
 * a single `getOwnPropertyDescriptor` (no ordinary `value.length` / `value[i]`).
 * Rejects symbols, extras, holes, accessors, non-enumerable indices, inherited
 * / prototype-backed values, Array subclasses, mutable / non-frozen arrays, and
 * hostile traps (fail-closed). Freeze is proven from the same descriptors plus
 * non-extensibility (no second property-value read / no `Object.isFrozen`
 * double-pass).
 *
 * @param {unknown} value
 * @param {readonly string[]} expected
 * @returns {boolean}
 */
function isExactFrozenDenseStringArray(value, expected) {
  try {
    if (value === null || typeof value !== 'object') return false;
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (Object.isExtensible(value)) return false;

    const ownKeys = Reflect.ownKeys(value);
    const n = expected.length;
    // Dense plain array own-key set: indices 0..n-1 + length.
    if (ownKeys.length !== n + 1) return false;

    /** @type {boolean[]} */
    const seenIndex = new Array(n);
    for (let i = 0; i < n; i += 1) seenIndex[i] = false;
    let sawLength = false;

    for (const key of ownKeys) {
      if (typeof key !== 'string') return false;

      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc) return false;
      // Data descriptor only — never invoke getters.
      if (desc.get !== undefined || desc.set !== undefined) return false;
      // Frozen invariant from this same descriptor snapshot.
      if (desc.writable !== false || desc.configurable !== false) return false;

      if (key === 'length') {
        if (sawLength) return false;
        sawLength = true;
        // Real Array `length` is non-enumerable.
        if (desc.enumerable !== false) return false;
        if (typeof desc.value !== 'number') return false;
        if (!Number.isInteger(desc.value) || desc.value !== n) return false;
        continue;
      }

      // Canonical decimal index string only (no "00", "1e1", "1.0", …).
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
      const idx = Number(key);
      if (idx < 0 || idx >= n || seenIndex[idx]) return false;
      if (desc.enumerable !== true) return false;
      if (typeof desc.value !== 'string') return false;
      if (desc.value !== expected[idx]) return false;
      seenIndex[idx] = true;
    }

    if (!sawLength) return false;
    for (let i = 0; i < n; i += 1) {
      if (!seenIndex[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   decision: string,
 *   currentDenylistVersion: bigint | null,
 *   nextDenylistVersion: bigint | null,
 *   errorCode: string | null,
 *   requiresControllerTrustStateTransition: boolean,
 *   stopAuthoritativeControllerService: boolean,
 *   requiresFullFleetReplaceReenroll: boolean,
 *   requiresNewGlobalEpoch: boolean,
 *   invalidateOldTrustMaterialCategories: ReadonlyArray<string>,
 * }} fields
 */
function freezeDecision(fields) {
  return Object.freeze({
    decision: fields.decision,
    currentDenylistVersion: fields.currentDenylistVersion,
    nextDenylistVersion: fields.nextDenylistVersion,
    errorCode: fields.errorCode,
    requiresControllerTrustStateTransition:
      fields.requiresControllerTrustStateTransition,
    stopAuthoritativeControllerService:
      fields.stopAuthoritativeControllerService,
    requiresFullFleetReplaceReenroll: fields.requiresFullFleetReplaceReenroll,
    requiresNewGlobalEpoch: fields.requiresNewGlobalEpoch,
    invalidateOldTrustMaterialCategories: Object.freeze(
      fields.invalidateOldTrustMaterialCategories.slice(),
    ),
    l1AcceptanceAuthorizesL2: false,
  });
}

/**
 * Fail-closed decision: no usable next version.
 * @param {'exhausted-fail-closed' | 'invalid-unverifiable-input'} decision
 * @param {bigint | null} currentDenylistVersion
 */
function failClosedDecision(decision, currentDenylistVersion) {
  return freezeDecision({
    decision,
    currentDenylistVersion,
    nextDenylistVersion: null,
    errorCode: ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
    requiresControllerTrustStateTransition: true,
    stopAuthoritativeControllerService: true,
    requiresFullFleetReplaceReenroll: true,
    requiresNewGlobalEpoch: true,
    invalidateOldTrustMaterialCategories: INVALIDATED_TRUST_MATERIAL_CATEGORIES,
  });
}

/**
 * @param {{
 *   recovery: string,
 *   controllerState: 'trusted' | 'untrusted' | null,
 *   stopAuthoritativeControllerService: boolean,
 *   requiresControllerTrustStateTransition: boolean,
 *   requiresFullFleetReplaceReenroll: boolean,
 *   requiresNewGlobalEpoch: boolean,
 *   invalidateOldTrustMaterialCategories: ReadonlyArray<string>,
 *   errorCode: string | null,
 * }} fields
 */
function freezeRecovery(fields) {
  return Object.freeze({
    recovery: fields.recovery,
    controllerState: fields.controllerState,
    stopAuthoritativeControllerService:
      fields.stopAuthoritativeControllerService,
    requiresControllerTrustStateTransition:
      fields.requiresControllerTrustStateTransition,
    requiresFullFleetReplaceReenroll: fields.requiresFullFleetReplaceReenroll,
    requiresNewGlobalEpoch: fields.requiresNewGlobalEpoch,
    invalidateOldTrustMaterialCategories: Object.freeze(
      fields.invalidateOldTrustMaterialCategories.slice(),
    ),
    l1AcceptanceAuthorizesL2: false,
    errorCode: fields.errorCode,
  });
}

function invalidRecoveryResult() {
  return freezeRecovery({
    recovery: RECOVERY.invalid,
    controllerState: 'untrusted',
    stopAuthoritativeControllerService: true,
    requiresControllerTrustStateTransition: true,
    requiresFullFleetReplaceReenroll: true,
    requiresNewGlobalEpoch: true,
    invalidateOldTrustMaterialCategories: INVALIDATED_TRUST_MATERIAL_CATEGORIES,
    errorCode: ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
  });
}

function fullFleetRecoveryResult() {
  return freezeRecovery({
    recovery: RECOVERY.full,
    controllerState: 'untrusted',
    stopAuthoritativeControllerService: true,
    requiresControllerTrustStateTransition: true,
    requiresFullFleetReplaceReenroll: true,
    requiresNewGlobalEpoch: true,
    invalidateOldTrustMaterialCategories: INVALIDATED_TRUST_MATERIAL_CATEGORIES,
    errorCode: ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
  });
}

function noRecoveryResult() {
  return freezeRecovery({
    recovery: RECOVERY.none,
    controllerState: 'trusted',
    stopAuthoritativeControllerService: false,
    requiresControllerTrustStateTransition: false,
    requiresFullFleetReplaceReenroll: false,
    requiresNewGlobalEpoch: false,
    invalidateOldTrustMaterialCategories: EMPTY_CATEGORIES,
    errorCode: null,
  });
}

/**
 * Plan next denylistVersion allocation under the strict BigInt uint64
 * semantic contract (T1.19 / A30).
 *
 * Exact ordinary / null-prototype record `{ currentDenylistVersion }`.
 * Values are taken from property descriptors once (no ordinary get; no
 * second-read flip acceptance). Total / no-throw. Never returns MAX as
 * next. Never wraps. Does not publish, ack, persist, or migrate.
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   decision: string,
 *   currentDenylistVersion: bigint | null,
 *   nextDenylistVersion: bigint | null,
 *   errorCode: string | null,
 *   requiresControllerTrustStateTransition: boolean,
 *   stopAuthoritativeControllerService: boolean,
 *   requiresFullFleetReplaceReenroll: boolean,
 *   requiresNewGlobalEpoch: boolean,
 *   invalidateOldTrustMaterialCategories: ReadonlyArray<string>,
 *   l1AcceptanceAuthorizesL2: false,
 * }>}
 */
export function planNextCrossLanDenylistVersionAllocation(input) {
  try {
    const rec = snapshotExactRecord(input, PLAN_INPUT_KEYS);
    if (rec === null) {
      return failClosedDecision(DECISION.invalid, null);
    }

    const current = rec.currentDenylistVersion;
    if (typeof current !== 'bigint') {
      return failClosedDecision(DECISION.invalid, null);
    }
    if (current < 0n) {
      return failClosedDecision(DECISION.invalid, null);
    }

    // Ordinary safe range: 0n .. MAX-3n → current + 1n (no recovery yet).
    if (current <= ORDINARY_MAX_CURRENT) {
      const next = current + 1n;
      return freezeDecision({
        decision: DECISION.ordinary,
        currentDenylistVersion: current,
        nextDenylistVersion: next,
        errorCode: null,
        requiresControllerTrustStateTransition: false,
        stopAuthoritativeControllerService: false,
        requiresFullFleetReplaceReenroll: false,
        requiresNewGlobalEpoch: false,
        invalidateOldTrustMaterialCategories: EMPTY_CATEGORIES,
      });
    }

    // Final-safe: MAX-2n → MAX-1n, then mandatory fail-closed trust transition.
    // Does not imply continued authoritative service after this allocation.
    if (current === FINAL_SAFE_CURRENT) {
      return freezeDecision({
        decision: DECISION.finalSafe,
        currentDenylistVersion: current,
        nextDenylistVersion: LAST_SAFE_PUBLISHED,
        errorCode: ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
        requiresControllerTrustStateTransition: true,
        stopAuthoritativeControllerService: true,
        requiresFullFleetReplaceReenroll: true,
        requiresNewGlobalEpoch: true,
        invalidateOldTrustMaterialCategories:
          INVALIDATED_TRUST_MATERIAL_CATEGORIES,
      });
    }

    // At / beyond exhaustion boundary (MAX-1, MAX, MAX+1, …): no next; no wrap.
    return failClosedDecision(DECISION.exhausted, current);
  } catch {
    return failClosedDecision(DECISION.invalid, null);
  }
}

/**
 * @param {Record<string, unknown>} rec
 * @returns {boolean}
 */
function isConsistentOrdinaryDecision(rec) {
  const current = rec.currentDenylistVersion;
  const next = rec.nextDenylistVersion;
  if (typeof current !== 'bigint' || typeof next !== 'bigint') return false;
  if (current < 0n || current > ORDINARY_MAX_CURRENT) return false;
  if (next !== current + 1n) return false;
  if (next === 0n || next === UINT64_MAX || next > LAST_SAFE_PUBLISHED) {
    return false;
  }
  if (rec.errorCode !== null) return false;
  if (rec.requiresControllerTrustStateTransition !== false) return false;
  if (rec.stopAuthoritativeControllerService !== false) return false;
  if (rec.requiresFullFleetReplaceReenroll !== false) return false;
  if (rec.requiresNewGlobalEpoch !== false) return false;
  if (
    !isExactFrozenDenseStringArray(rec.invalidateOldTrustMaterialCategories, [])
  ) {
    return false;
  }
  if (rec.l1AcceptanceAuthorizesL2 !== false) return false;
  return true;
}

/**
 * Shared fail-closed field set required for full-recovery decisions.
 * Aggregate `requiresFullFleetReplaceReenroll` alone cannot bypass.
 *
 * @param {Record<string, unknown>} rec
 * @returns {boolean}
 */
function hasFullFailClosedFields(rec) {
  if (rec.errorCode !== ERROR_CODES.CONTROLLER_STATE_UNTRUSTED) return false;
  if (rec.requiresControllerTrustStateTransition !== true) return false;
  if (rec.stopAuthoritativeControllerService !== true) return false;
  if (rec.requiresFullFleetReplaceReenroll !== true) return false;
  if (rec.requiresNewGlobalEpoch !== true) return false;
  if (
    !isExactFrozenDenseStringArray(
      rec.invalidateOldTrustMaterialCategories,
      INVALIDATED_TRUST_MATERIAL_CATEGORIES,
    )
  ) {
    return false;
  }
  if (rec.l1AcceptanceAuthorizesL2 !== false) return false;
  return true;
}

/**
 * @param {Record<string, unknown>} rec
 * @returns {boolean}
 */
function isConsistentFinalSafeDecision(rec) {
  if (rec.currentDenylistVersion !== FINAL_SAFE_CURRENT) return false;
  if (rec.nextDenylistVersion !== LAST_SAFE_PUBLISHED) return false;
  if (rec.nextDenylistVersion === UINT64_MAX) return false;
  return hasFullFailClosedFields(rec);
}

/**
 * @param {Record<string, unknown>} rec
 * @returns {boolean}
 */
function isConsistentExhaustedDecision(rec) {
  const current = rec.currentDenylistVersion;
  if (typeof current !== 'bigint') return false;
  if (current < LAST_SAFE_PUBLISHED) return false;
  if (rec.nextDenylistVersion !== null) return false;
  return hasFullFailClosedFields(rec);
}

/**
 * @param {Record<string, unknown>} rec
 * @returns {boolean}
 */
function isConsistentInvalidDecision(rec) {
  if (rec.currentDenylistVersion !== null) return false;
  if (rec.nextDenylistVersion !== null) return false;
  return hasFullFailClosedFields(rec);
}

/**
 * Pure trust-recovery classifier for a denylistVersion allocation decision
 * descriptor (or an exact closed claim derived from one).
 *
 * Fail-closed for malformed / forged / inconsistent combinations. Aggregate
 * flags cannot bypass missing fail-closed fields. Distinguishes
 * no-recovery vs full-fleet-recovery. Full recovery states untrusted
 * controller, stop authoritative service, trust-state transition, full fleet
 * replace/re-enroll, new global epoch, invalidated old material categories,
 * and L1 acceptance never authorizes L2. Total / no-throw. Not runtime proof.
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   recovery: string,
 *   controllerState: 'trusted' | 'untrusted' | null,
 *   stopAuthoritativeControllerService: boolean,
 *   requiresControllerTrustStateTransition: boolean,
 *   requiresFullFleetReplaceReenroll: boolean,
 *   requiresNewGlobalEpoch: boolean,
 *   invalidateOldTrustMaterialCategories: ReadonlyArray<string>,
 *   l1AcceptanceAuthorizesL2: false,
 *   errorCode: string | null,
 * }>}
 */
export function classifyCrossLanDenylistVersionTrustRecovery(input) {
  try {
    const rec = snapshotExactRecord(input, DECISION_KEYS);
    if (rec === null) return invalidRecoveryResult();

    const decision = rec.decision;
    if (typeof decision !== 'string') return invalidRecoveryResult();

    if (decision === DECISION.ordinary) {
      if (!isConsistentOrdinaryDecision(rec)) return invalidRecoveryResult();
      return noRecoveryResult();
    }

    if (decision === DECISION.finalSafe) {
      if (!isConsistentFinalSafeDecision(rec)) return invalidRecoveryResult();
      return fullFleetRecoveryResult();
    }

    if (decision === DECISION.exhausted) {
      if (!isConsistentExhaustedDecision(rec)) return invalidRecoveryResult();
      return fullFleetRecoveryResult();
    }

    if (decision === DECISION.invalid) {
      if (!isConsistentInvalidDecision(rec)) return invalidRecoveryResult();
      return fullFleetRecoveryResult();
    }

    return invalidRecoveryResult();
  } catch {
    return invalidRecoveryResult();
  }
}
