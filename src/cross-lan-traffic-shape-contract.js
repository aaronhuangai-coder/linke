/**
 * Cross-LAN size-leak / traffic-shape honesty pure contract (T1.20 M1 only).
 *
 * --- honesty ---
 * [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * [scope] T1.20 M1 frozen residual traffic-shape risk policy + disclosure
 *   classifier only (spec §6.7.1 F-P1-SIZE-LEAK / §6.10 / P1-24)
 * [coverage] contract-only-not-runtime-proof
 * [not ready] M4 fixed-bucket padding runtime / data plane / evidence write /
 *   config toggle = NOT IMPLEMENTED
 * [flag] padding.runtimeStatus = 'not-ready'; padding.m1RuntimeEnabled = false
 *
 * Residual risk (accepted): relay / path observers may observe ciphertext /
 * chunk length sequences, timing, and approximate change magnitude
 * (histograms / sending cadence). Gold V2.0 does not hide traffic shape and
 * never authorizes anonymity, traffic-analysis resistance, traffic-analysis
 * immunity, or untraceability claims. Optional fixed-bucket padding is an M4
 * candidate mitigation only (candidates pending M4 selection); enabling it
 * never changes forbidden-claim booleans. Caller claims are not proof.
 * No runtime padding, network, data plane, config, or evidence write in M1.
 */

// ---------------------------------------------------------------------------
// Named M4 padding bucket candidates (not selected / not default / not enabled)
// ---------------------------------------------------------------------------

/**
 * Optional M4 fixed-bucket padding candidate sizes in bytes.
 * Named candidates only: 64 KiB, 256 KiB, 1 MiB.
 * Not a selected set; final selection requires M4 tests + possible contract
 * revision. Identity-reused by policy.padding.candidates.
 *
 * @type {ReadonlyArray<number>}
 */
export const CROSS_LAN_PADDING_BUCKET_CANDIDATES_BYTES = Object.freeze([
  65_536,
  262_144,
  1_048_576,
]);

/** @type {ReadonlySet<number>} */
const CANDIDATE_SET = Object.freeze(
  new Set(CROSS_LAN_PADDING_BUCKET_CANDIDATES_BYTES),
);

// ---------------------------------------------------------------------------
// Frozen policy
// ---------------------------------------------------------------------------

/**
 * Frozen traffic-shape residual-risk + padding honesty policy (T1.20).
 *
 * Declares accepted residual observability, explicit false guarantees, M4
 * optional padding candidates (pending, not ready), and M1 honesty bounds.
 * Does **not** pad, configure runtime, write evidence, or authorize marketing
 * claims.
 *
 * @type {Readonly<{
 *   residualRisk: Readonly<Record<string, unknown>>,
 *   falseGuarantees: Readonly<Record<string, false>>,
 *   padding: Readonly<Record<string, unknown>>,
 *   honesty: Readonly<Record<string, unknown>>,
 * }>}
 */
export const CROSS_LAN_TRAFFIC_SHAPE_POLICY = Object.freeze({
  residualRisk: Object.freeze({
    status: 'accepted',
    observableMetadataCategories: Object.freeze([
      'ciphertext-chunk-length-sequence',
      'timing',
      'approximate-change-magnitude',
    ]),
  }),
  falseGuarantees: Object.freeze({
    hidesTrafficShape: false,
    anonymity: false,
    trafficAnalysisResistant: false,
    trafficAnalysisImmune: false,
    untraceable: false,
  }),
  padding: Object.freeze({
    optionalMitigation: true,
    goldRequired: false,
    candidates: CROSS_LAN_PADDING_BUCKET_CANDIDATES_BYTES,
    selectedBucketSet: null,
    selectionStatus: 'pending-m4',
    runtimeStatus: 'not-ready',
    m1RuntimeEnabled: false,
    evidenceConfigDisclosureRequired: true,
    enablingChangesForbiddenClaimBooleans: false,
  }),
  honesty: Object.freeze({
    callerClaimsAreRuntimeProof: false,
    m1PerformsRuntimePadding: false,
    m1PerformsNetwork: false,
    m1PerformsDataPlane: false,
    m1WritesConfig: false,
    m1WritesEvidence: false,
    implementationStage: 'T1.20-M1-contract-only',
  }),
});

// ---------------------------------------------------------------------------
// Classifier input keys + closed labels
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<string>} */
const DISCLOSURE_INPUT_KEYS = Object.freeze([
  'relayObservesCiphertextChunkLengthSequence',
  'relayObservesTiming',
  'relayObservesApproximateChangeMagnitude',
  'claimsTrafficShapeHidden',
  'claimsAnonymous',
  'claimsTrafficAnalysisResistant',
  'claimsTrafficAnalysisImmune',
  'claimsUntraceable',
  'paddingEnabled',
  'paddingBucketBytes',
  'm4SelectionVerified',
  'evidenceDisclosesPaddingStatus',
]);

/** @type {ReadonlyArray<string>} */
const OBSERVATION_KEYS = Object.freeze([
  'relayObservesCiphertextChunkLengthSequence',
  'relayObservesTiming',
  'relayObservesApproximateChangeMagnitude',
]);

/** @type {ReadonlyArray<string>} */
const FORBIDDEN_CLAIM_KEYS = Object.freeze([
  'claimsTrafficShapeHidden',
  'claimsAnonymous',
  'claimsTrafficAnalysisResistant',
  'claimsTrafficAnalysisImmune',
  'claimsUntraceable',
]);

/** @type {ReadonlyArray<string>} */
const STRICT_BOOLEAN_KEYS = Object.freeze([
  ...OBSERVATION_KEYS,
  ...FORBIDDEN_CLAIM_KEYS,
  'paddingEnabled',
  'm4SelectionVerified',
  'evidenceDisclosesPaddingStatus',
]);

const LABEL = Object.freeze({
  honest: 'honest-m1-unpadded-disclosure',
  overclaim: 'forbidden-traffic-analysis-overclaim',
  premature: 'premature-m4-padding-claim',
  invalid: 'invalid-input',
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
 * @returns {boolean}
 */
function isStrictBoolean(value) {
  return value === true || value === false;
}

/**
 * paddingBucketBytes: null or one exact named candidate integer.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidPaddingBucketBytes(value) {
  if (value === null) return true;
  if (typeof value !== 'number') return false;
  if (!Number.isInteger(value)) return false;
  return CANDIDATE_SET.has(value);
}

/**
 * Uniform closed disclosure descriptor. Always non-authorizing for product
 * claims; padding never ready under T1.20. Only the honest label sets
 * honestDisclosure:true.
 *
 * @param {string} label
 * @param {boolean} honestDisclosure
 */
function freezeDisclosureResult(label, honestDisclosure) {
  return Object.freeze({
    label,
    honestDisclosure,
    claimsAuthorized: false,
    paddingReady: false,
  });
}

function invalidResult() {
  return freezeDisclosureResult(LABEL.invalid, false);
}

function overclaimResult() {
  return freezeDisclosureResult(LABEL.overclaim, false);
}

function prematureResult() {
  return freezeDisclosureResult(LABEL.premature, false);
}

function honestResult() {
  return freezeDisclosureResult(LABEL.honest, true);
}

/**
 * Pure traffic-shape disclosure classifier (T1.20 M1).
 *
 * Exact ordinary / null-prototype record of 12 own enumerable data fields.
 * Values are taken from property descriptors once (no ordinary get; no
 * second-read flip acceptance). Closed labels only:
 *
 * 1. malformed shape/type/accessor/symbol/extra/proxy → `invalid-input`
 * 2. any required relay observability not true, or any forbidden claim true
 *    → `forbidden-traffic-analysis-overclaim` (priority over every padding state)
 * 3. paddingEnabled / non-null paddingBucketBytes / m4SelectionVerified
 *    → `premature-m4-padding-claim` (M1 never accepts M4 proof)
 * 4. evidenceDisclosesPaddingStatus not true → `invalid-input`
 * 5. exact honest unpadded residual disclosure → `honest-m1-unpadded-disclosure`
 *
 * Total / no-throw. Not runtime or evidence proof. Never authorizes padding
 * readiness or prohibited marketing claims.
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   label: string,
 *   honestDisclosure: boolean,
 *   claimsAuthorized: false,
 *   paddingReady: false,
 * }>}
 */
export function classifyCrossLanTrafficShapeDisclosure(input) {
  try {
    const rec = snapshotExactRecord(input, DISCLOSURE_INPUT_KEYS);
    if (rec === null) return invalidResult();

    for (const key of STRICT_BOOLEAN_KEYS) {
      if (!isStrictBoolean(rec[key])) return invalidResult();
    }
    if (!isValidPaddingBucketBytes(rec.paddingBucketBytes)) {
      return invalidResult();
    }

    // Priority 2: residual observability must be honestly admitted; no
    // prohibited traffic-analysis / anonymity claims.
    for (const key of OBSERVATION_KEYS) {
      if (rec[key] !== true) return overclaimResult();
    }
    for (const key of FORBIDDEN_CLAIM_KEYS) {
      if (rec[key] === true) return overclaimResult();
    }

    // Priority 3: M1 classifier never accepts M4 padding selection / runtime.
    if (
      rec.paddingEnabled === true ||
      rec.paddingBucketBytes !== null ||
      rec.m4SelectionVerified === true
    ) {
      return prematureResult();
    }

    // Priority 4: incomplete evidence/config disclosure is non-approving.
    if (rec.evidenceDisclosesPaddingStatus !== true) {
      return invalidResult();
    }

    // Priority 5: exact honest M1 unpadded residual disclosure.
    return honestResult();
  } catch {
    return invalidResult();
  }
}
