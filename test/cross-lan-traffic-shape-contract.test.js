/**
 * Honesty scope: T1.20 M1 pure size-leak / traffic-shape disclosure contract only
 * (F-P1-SIZE-LEAK / P1-24 / §6.7.1 / §6.10). Relay may observe length sequences,
 * timing, and approximate change magnitude — accepted residual risk. No padding
 * implementation, data plane, runtime config, evidence write, network, or I/O.
 * Caller claims are not runtime/evidence proof. No anonymity / traffic-analysis
 * resistance claims authorized.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as shape from '../src/cross-lan-traffic-shape-contract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/cross-lan-traffic-shape-contract.js');

const EXPORTS = Object.freeze([
  'CROSS_LAN_PADDING_BUCKET_CANDIDATES_BYTES',
  'CROSS_LAN_TRAFFIC_SHAPE_POLICY',
  'classifyCrossLanTrafficShapeDisclosure',
]);

const CANDIDATES = Object.freeze([65_536, 262_144, 1_048_576]);

const LABELS = Object.freeze({
  honest: 'honest-m1-unpadded-disclosure',
  overclaim: 'forbidden-traffic-analysis-overclaim',
  premature: 'premature-m4-padding-claim',
  invalid: 'invalid-input',
});

const CLOSED_LABELS = Object.freeze([
  LABELS.honest,
  LABELS.overclaim,
  LABELS.premature,
  LABELS.invalid,
]);

const RESULT_KEYS = Object.freeze([
  'label',
  'honestDisclosure',
  'claimsAuthorized',
  'paddingReady',
]);

const INPUT_KEYS = Object.freeze([
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

const OBSERVATION_KEYS = Object.freeze([
  'relayObservesCiphertextChunkLengthSequence',
  'relayObservesTiming',
  'relayObservesApproximateChangeMagnitude',
]);

const FORBIDDEN_CLAIM_KEYS = Object.freeze([
  'claimsTrafficShapeHidden',
  'claimsAnonymous',
  'claimsTrafficAnalysisResistant',
  'claimsTrafficAnalysisImmune',
  'claimsUntraceable',
]);

const BOOLEAN_KEYS = Object.freeze([
  ...OBSERVATION_KEYS,
  ...FORBIDDEN_CLAIM_KEYS,
  'paddingEnabled',
  'm4SelectionVerified',
  'evidenceDisclosesPaddingStatus',
]);

const POLICY_TOP_KEYS = Object.freeze([
  'residualRisk',
  'falseGuarantees',
  'padding',
  'honesty',
]);

const RESIDUAL_RISK_KEYS = Object.freeze([
  'status',
  'observableMetadataCategories',
]);

const OBSERVABLE_CATEGORIES = Object.freeze([
  'ciphertext-chunk-length-sequence',
  'timing',
  'approximate-change-magnitude',
]);

const FALSE_GUARANTEE_KEYS = Object.freeze([
  'hidesTrafficShape',
  'anonymity',
  'trafficAnalysisResistant',
  'trafficAnalysisImmune',
  'untraceable',
]);

const PADDING_POLICY_KEYS = Object.freeze([
  'optionalMitigation',
  'goldRequired',
  'candidates',
  'selectedBucketSet',
  'selectionStatus',
  'runtimeStatus',
  'm1RuntimeEnabled',
  'evidenceConfigDisclosureRequired',
  'enablingChangesForbiddenClaimBooleans',
]);

const HONESTY_KEYS = Object.freeze([
  'callerClaimsAreRuntimeProof',
  'm1PerformsRuntimePadding',
  'm1PerformsNetwork',
  'm1PerformsDataPlane',
  'm1WritesConfig',
  'm1WritesEvidence',
  'implementationStage',
]);

const SENTINEL = 'must-never-echo-marketing-or-secret-xyz';

/** @param {Record<string, unknown>} [overrides] */
function honestInput(overrides = {}) {
  return {
    relayObservesCiphertextChunkLengthSequence: true,
    relayObservesTiming: true,
    relayObservesApproximateChangeMagnitude: true,
    claimsTrafficShapeHidden: false,
    claimsAnonymous: false,
    claimsTrafficAnalysisResistant: false,
    claimsTrafficAnalysisImmune: false,
    claimsUntraceable: false,
    paddingEnabled: false,
    paddingBucketBytes: null,
    m4SelectionVerified: false,
    evidenceDisclosesPaddingStatus: true,
    ...overrides,
  };
}

/**
 * @param {object} value
 * @param {readonly string[]} keys
 */
function assertExactFrozenKeys(value, keys) {
  assert.ok(Object.isFrozen(value), 'result must be frozen');
  assert.deepStrictEqual(Object.keys(value).sort(), [...keys].sort());
  assert.strictEqual(Object.keys(value).length, keys.length);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(desc, `missing key ${key}`);
    assert.strictEqual(desc.get, undefined, `accessor get forbidden: ${key}`);
    assert.strictEqual(desc.set, undefined, `accessor set forbidden: ${key}`);
    assert.strictEqual(desc.enumerable, true);
  }
}

/**
 * @param {ReturnType<typeof shape.classifyCrossLanTrafficShapeDisclosure>} out
 * @param {string} label
 * @param {{ honestDisclosure?: boolean }} [opts]
 */
function assertResult(out, label, opts = {}) {
  const honestDisclosure = opts.honestDisclosure === true;
  assertExactFrozenKeys(out, RESULT_KEYS);
  assert.strictEqual(out.label, label);
  assert.strictEqual(out.honestDisclosure, honestDisclosure);
  assert.strictEqual(out.claimsAuthorized, false);
  assert.strictEqual(out.paddingReady, false);
  assert.ok(CLOSED_LABELS.includes(out.label));
  assert.throws(() => {
    // @ts-expect-error freeze probe
    out.label = 'x';
  }, TypeError);
}

/**
 * @param {object} target
 * @returns {{
 *   proxy: object,
 *   descCounts: Record<string, number>,
 *   getCounts: Record<string, number>,
 *   ownKeysCount: () => number,
 * }}
 */
function countingDescriptorProxy(target) {
  /** @type {Record<string, number>} */
  const descCounts = Object.create(null);
  /** @type {Record<string, number>} */
  const getCounts = Object.create(null);
  let ownKeysCount = 0;
  const p = new Proxy(target, {
    ownKeys(t) {
      ownKeysCount += 1;
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, prop) {
      if (typeof prop === 'string') {
        descCounts[prop] = (descCounts[prop] || 0) + 1;
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
    get(t, prop, receiver) {
      if (typeof prop === 'string') {
        getCounts[prop] = (getCounts[prop] || 0) + 1;
      }
      return Reflect.get(t, prop, receiver);
    },
  });
  return {
    proxy: p,
    descCounts,
    getCounts,
    ownKeysCount: () => ownKeysCount,
  };
}

/**
 * @param {object} target
 * @param {string} key
 * @param {unknown} firstValue
 * @param {unknown} secondValue
 */
function flipDescriptorProxy(target, key, firstValue, secondValue) {
  let hits = 0;
  const p = new Proxy(target, {
    getOwnPropertyDescriptor(t, prop) {
      if (prop === key) {
        hits += 1;
        return {
          value: hits === 1 ? firstValue : secondValue,
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  });
  return { proxy: p, hits: () => hits };
}

/**
 * @param {object} target
 * @param {string} key
 * @param {'get-valid-desc-invalid' | 'get-invalid-desc-valid'} mode
 * @param {unknown} validValue
 * @param {unknown} invalidValue
 */
function getVsDescProxy(target, key, mode, validValue, invalidValue) {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === key) {
        return mode === 'get-valid-desc-invalid' ? validValue : invalidValue;
      }
      return Reflect.get(t, prop, receiver);
    },
    getOwnPropertyDescriptor(t, prop) {
      if (prop === key) {
        return {
          value: mode === 'get-valid-desc-invalid' ? invalidValue : validValue,
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  });
}

function createThrowingProxy() {
  return new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('ownKeys-trap');
      },
      getOwnPropertyDescriptor() {
        throw new Error('desc-trap');
      },
      get() {
        throw new Error('get-trap');
      },
    },
  );
}

/**
 * @param {object} target
 */
function createRevokedProxy(target) {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

describe('cross-lan traffic shape contract (T1.20 M1 pure contract)', () => {
  it('1) export surface exactly 3; candidates + policy exact/deep-frozen + identity', () => {
    assert.deepStrictEqual(Object.keys(shape).sort(), [...EXPORTS].sort());
    assert.strictEqual(Object.keys(shape).length, 3);

    const candidates = shape.CROSS_LAN_PADDING_BUCKET_CANDIDATES_BYTES;
    assert.ok(Array.isArray(candidates));
    assert.ok(Object.isFrozen(candidates));
    assert.deepStrictEqual([...candidates], [...CANDIDATES]);
    assert.strictEqual(candidates.length, 3);
    assert.throws(() => {
      // @ts-expect-error freeze probe
      candidates.push(999);
    }, TypeError);
    assert.throws(() => {
      candidates[0] = 1;
    }, TypeError);

    const policy = shape.CROSS_LAN_TRAFFIC_SHAPE_POLICY;
    assert.ok(Object.isFrozen(policy));
    assertExactFrozenKeys(policy, POLICY_TOP_KEYS);

    // residual risk: accepted + exact observable categories
    assert.ok(Object.isFrozen(policy.residualRisk));
    assertExactFrozenKeys(policy.residualRisk, RESIDUAL_RISK_KEYS);
    assert.strictEqual(policy.residualRisk.status, 'accepted');
    assert.ok(Object.isFrozen(policy.residualRisk.observableMetadataCategories));
    assert.deepStrictEqual(
      [...policy.residualRisk.observableMetadataCategories],
      [...OBSERVABLE_CATEGORIES],
    );

    // false guarantees: all five prohibited claims are false
    assert.ok(Object.isFrozen(policy.falseGuarantees));
    assertExactFrozenKeys(policy.falseGuarantees, FALSE_GUARANTEE_KEYS);
    for (const key of FALSE_GUARANTEE_KEYS) {
      assert.strictEqual(policy.falseGuarantees[key], false, key);
    }

    // padding: optional M4 candidate only; not Gold-required; not ready
    assert.ok(Object.isFrozen(policy.padding));
    assertExactFrozenKeys(policy.padding, PADDING_POLICY_KEYS);
    assert.strictEqual(policy.padding.optionalMitigation, true);
    assert.strictEqual(policy.padding.goldRequired, false);
    assert.strictEqual(
      policy.padding.candidates,
      shape.CROSS_LAN_PADDING_BUCKET_CANDIDATES_BYTES,
      'policy.candidates must identity-reuse export array',
    );
    assert.strictEqual(policy.padding.selectedBucketSet, null);
    assert.strictEqual(policy.padding.selectionStatus, 'pending-m4');
    assert.strictEqual(policy.padding.runtimeStatus, 'not-ready');
    assert.strictEqual(policy.padding.m1RuntimeEnabled, false);
    assert.strictEqual(policy.padding.evidenceConfigDisclosureRequired, true);
    assert.strictEqual(
      policy.padding.enablingChangesForbiddenClaimBooleans,
      false,
    );

    // honesty: caller claims not proof; no M1 runtime I/O
    assert.ok(Object.isFrozen(policy.honesty));
    assertExactFrozenKeys(policy.honesty, HONESTY_KEYS);
    assert.strictEqual(policy.honesty.callerClaimsAreRuntimeProof, false);
    assert.strictEqual(policy.honesty.m1PerformsRuntimePadding, false);
    assert.strictEqual(policy.honesty.m1PerformsNetwork, false);
    assert.strictEqual(policy.honesty.m1PerformsDataPlane, false);
    assert.strictEqual(policy.honesty.m1WritesConfig, false);
    assert.strictEqual(policy.honesty.m1WritesEvidence, false);
    assert.strictEqual(
      policy.honesty.implementationStage,
      'T1.20-M1-contract-only',
    );
  });

  it('2) honest unpadded disclosure accepted (ordinary / null-proto / frozen)', () => {
    const fn = shape.classifyCrossLanTrafficShapeDisclosure;

    assertResult(fn(honestInput()), LABELS.honest, {
      honestDisclosure: true,
    });

    const nullProto = Object.assign(Object.create(null), honestInput());
    assertResult(fn(nullProto), LABELS.honest, { honestDisclosure: true });

    const frozen = Object.freeze(honestInput());
    assertResult(fn(frozen), LABELS.honest, { honestDisclosure: true });

    // padding false + bucket null proves Gold does not depend on padding
    const out = fn(
      honestInput({ paddingEnabled: false, paddingBucketBytes: null }),
    );
    assertResult(out, LABELS.honest, { honestDisclosure: true });
    assert.strictEqual(out.paddingReady, false);
  });

  it('3) each observation false independently → forbidden overclaim', () => {
    const fn = shape.classifyCrossLanTrafficShapeDisclosure;
    for (const key of OBSERVATION_KEYS) {
      const out = fn(honestInput({ [key]: false }));
      assertResult(out, LABELS.overclaim);
      assert.strictEqual(out.honestDisclosure, false);
    }
  });

  it('4) each of five forbidden claims true independently → overclaim', () => {
    const fn = shape.classifyCrossLanTrafficShapeDisclosure;
    for (const key of FORBIDDEN_CLAIM_KEYS) {
      const out = fn(honestInput({ [key]: true }));
      assertResult(out, LABELS.overclaim);
      assert.strictEqual(out.claimsAuthorized, false);
    }
  });

  it('5) exhaustive padding combos never override prohibited claims', () => {
    const fn = shape.classifyCrossLanTrafficShapeDisclosure;
    const paddingStates = [
      { paddingEnabled: false, paddingBucketBytes: null, m4SelectionVerified: false },
      { paddingEnabled: true, paddingBucketBytes: null, m4SelectionVerified: false },
      { paddingEnabled: false, paddingBucketBytes: 65_536, m4SelectionVerified: false },
      { paddingEnabled: true, paddingBucketBytes: 65_536, m4SelectionVerified: false },
      { paddingEnabled: true, paddingBucketBytes: 262_144, m4SelectionVerified: true },
      { paddingEnabled: false, paddingBucketBytes: null, m4SelectionVerified: true },
      { paddingEnabled: true, paddingBucketBytes: 1_048_576, m4SelectionVerified: true },
    ];

    for (const pad of paddingStates) {
      // each forbidden claim still overclaim
      for (const claim of FORBIDDEN_CLAIM_KEYS) {
        const out = fn(honestInput({ ...pad, [claim]: true }));
        assertResult(out, LABELS.overclaim, {
          honestDisclosure: false,
        });
      }
      // each observation false still overclaim
      for (const obs of OBSERVATION_KEYS) {
        const out = fn(honestInput({ ...pad, [obs]: false }));
        assertResult(out, LABELS.overclaim);
      }
    }
  });

  it('6) padding true / candidate bucket / nonnull-while-disabled / M4 verified → premature or invalid', () => {
    const fn = shape.classifyCrossLanTrafficShapeDisclosure;

    // paddingEnabled true (bucket null) → premature
    assertResult(
      fn(honestInput({ paddingEnabled: true, paddingBucketBytes: null })),
      LABELS.premature,
    );

    // each exact candidate as bucket (enabled or disabled) → premature
    for (const bucket of CANDIDATES) {
      assertResult(
        fn(
          honestInput({
            paddingEnabled: true,
            paddingBucketBytes: bucket,
          }),
        ),
        LABELS.premature,
      );
      // nonnull bucket while padding disabled still premature (not invalid)
      assertResult(
        fn(
          honestInput({
            paddingEnabled: false,
            paddingBucketBytes: bucket,
          }),
        ),
        LABELS.premature,
      );
    }

    // m4SelectionVerified true alone → premature
    assertResult(
      fn(honestInput({ m4SelectionVerified: true })),
      LABELS.premature,
    );

    // non-candidate bucket → invalid-input (malformed type; before premature)
    for (const bad of [0, 1, 64, 65_535, 65_537, 999_999, 2_097_152, -1, 1.5]) {
      assertResult(
        fn(honestInput({ paddingBucketBytes: bad })),
        LABELS.invalid,
      );
      assertResult(
        fn(
          honestInput({
            paddingEnabled: true,
            paddingBucketBytes: bad,
          }),
        ),
        LABELS.invalid,
      );
    }

    // combined M4 flags with honest residual still premature, never honest
    assertResult(
      fn(
        honestInput({
          paddingEnabled: true,
          paddingBucketBytes: 256 * 1024,
          m4SelectionVerified: true,
        }),
      ),
      LABELS.premature,
    );
  });

  it('7) incomplete evidence disclosure → invalid-input (non-approving)', () => {
    const fn = shape.classifyCrossLanTrafficShapeDisclosure;
    // padding off, no premature flags, but evidence disclosure false
    assertResult(
      fn(honestInput({ evidenceDisclosesPaddingStatus: false })),
      LABELS.invalid,
    );
  });

  it('8) malformed types/shapes: number-vs-boolean, missing/extra/symbol/accessor/class/Date/array/proxy/revoked', () => {
    const fn = shape.classifyCrossLanTrafficShapeDisclosure;

    assertResult(fn(null), LABELS.invalid);
    assertResult(fn(undefined), LABELS.invalid);
    assertResult(fn(42), LABELS.invalid);
    assertResult(fn('honest'), LABELS.invalid);
    assertResult(fn(true), LABELS.invalid);
    assertResult(fn([]), LABELS.invalid);
    assertResult(fn(new Date()), LABELS.invalid);
    assertResult(fn(Object.create(Object.create(null))), LABELS.invalid);

    class ClaimRecord {
      constructor() {
        Object.assign(this, honestInput());
      }
    }
    assertResult(fn(new ClaimRecord()), LABELS.invalid);

    // number-vs-boolean drift on every boolean field
    for (const key of BOOLEAN_KEYS) {
      assertResult(fn(honestInput({ [key]: 1 })), LABELS.invalid);
      assertResult(fn(honestInput({ [key]: 0 })), LABELS.invalid);
      assertResult(fn(honestInput({ [key]: 'true' })), LABELS.invalid);
      assertResult(fn(honestInput({ [key]: 'false' })), LABELS.invalid);
      assertResult(fn(honestInput({ [key]: undefined })), LABELS.invalid);
    }

    // paddingBucketBytes type drift
    for (const bad of [
      undefined,
      true,
      false,
      '65536',
      65_536n,
      [65_536],
      { bytes: 65_536 },
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      assertResult(fn(honestInput({ paddingBucketBytes: bad })), LABELS.invalid);
    }

    // missing field
    for (const key of INPUT_KEYS) {
      const o = honestInput();
      delete o[key];
      assertResult(fn(o), LABELS.invalid);
    }

    // extra field
    assertResult(fn(honestInput({ extra: false })), LABELS.invalid);
    assertResult(
      fn(honestInput({ marketingClaim: SENTINEL })),
      LABELS.invalid,
    );

    // symbol own key
    {
      const o = honestInput();
      o[Symbol('x')] = true;
      assertResult(fn(o), LABELS.invalid);
    }

    // non-enumerable data field
    {
      const o = honestInput();
      Object.defineProperty(o, 'claimsAnonymous', {
        value: false,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      assertResult(fn(o), LABELS.invalid);
    }

    // accessor field
    {
      const o = honestInput();
      Object.defineProperty(o, 'paddingEnabled', {
        get() {
          return false;
        },
        enumerable: true,
        configurable: true,
      });
      assertResult(fn(o), LABELS.invalid);
    }

    // throwing / revoked proxy
    assert.doesNotThrow(() => {
      assertResult(fn(createThrowingProxy()), LABELS.invalid);
      assertResult(fn(createRevokedProxy(honestInput())), LABELS.invalid);
    });
  });

  it('9) descriptor count-once / get-vs-desc / flip both directions; no ordinary getter', () => {
    const fn = shape.classifyCrossLanTrafficShapeDisclosure;

    // ownKeys once; each key desc exactly once; no ordinary get
    {
      const base = honestInput();
      const { proxy, descCounts, getCounts, ownKeysCount } =
        countingDescriptorProxy(base);
      assertResult(fn(proxy), LABELS.honest, { honestDisclosure: true });
      assert.strictEqual(ownKeysCount(), 1);
      for (const key of INPUT_KEYS) {
        assert.strictEqual(descCounts[key], 1, `desc once: ${key}`);
        assert.strictEqual(
          getCounts[key] || 0,
          0,
          `no ordinary get: ${key}`,
        );
      }
    }

    // get-valid / desc-invalid → invalid (uses descriptor only)
    {
      const p = getVsDescProxy(
        honestInput(),
        'claimsAnonymous',
        'get-valid-desc-invalid',
        false,
        true,
      );
      // desc says true (forbidden claim) → overclaim, not honest
      assertResult(fn(p), LABELS.overclaim);
    }
    {
      const p = getVsDescProxy(
        honestInput(),
        'claimsAnonymous',
        'get-valid-desc-invalid',
        false,
        'not-bool',
      );
      assertResult(fn(p), LABELS.invalid);
    }

    // get-invalid / desc-valid → accept desc → honest
    {
      const p = getVsDescProxy(
        honestInput(),
        'claimsAnonymous',
        'get-invalid-desc-valid',
        false,
        true,
      );
      assertResult(fn(p), LABELS.honest, { honestDisclosure: true });
    }

    // flip false→true attack: first false (honest path field) second would-be true overclaim
    // For claimsAnonymous first false second true → honest (first read)
    {
      const { proxy, hits } = flipDescriptorProxy(
        honestInput(),
        'claimsAnonymous',
        false,
        true,
      );
      assertResult(fn(proxy), LABELS.honest, { honestDisclosure: true });
      assert.strictEqual(hits(), 1);
    }

    // flip true→false attack: first true (overclaim) second would-be false
    {
      const { proxy, hits } = flipDescriptorProxy(
        honestInput(),
        'claimsAnonymous',
        true,
        false,
      );
      assertResult(fn(proxy), LABELS.overclaim);
      assert.strictEqual(hits(), 1);
    }

    // flip observation true→false
    {
      const { proxy, hits } = flipDescriptorProxy(
        honestInput(),
        'relayObservesTiming',
        true,
        false,
      );
      assertResult(fn(proxy), LABELS.honest, { honestDisclosure: true });
      assert.strictEqual(hits(), 1);
    }
    {
      const { proxy, hits } = flipDescriptorProxy(
        honestInput(),
        'relayObservesTiming',
        false,
        true,
      );
      assertResult(fn(proxy), LABELS.overclaim);
      assert.strictEqual(hits(), 1);
    }

    // flip paddingEnabled false→true would-be premature if re-read
    {
      const { proxy, hits } = flipDescriptorProxy(
        honestInput(),
        'paddingEnabled',
        false,
        true,
      );
      assertResult(fn(proxy), LABELS.honest, { honestDisclosure: true });
      assert.strictEqual(hits(), 1);
    }
    {
      const { proxy, hits } = flipDescriptorProxy(
        honestInput(),
        'paddingEnabled',
        true,
        false,
      );
      assertResult(fn(proxy), LABELS.premature);
      assert.strictEqual(hits(), 1);
    }

    // flip m4SelectionVerified
    {
      const { proxy, hits } = flipDescriptorProxy(
        honestInput(),
        'm4SelectionVerified',
        true,
        false,
      );
      assertResult(fn(proxy), LABELS.premature);
      assert.strictEqual(hits(), 1);
    }

    // flip evidence disclosure true→false
    {
      const { proxy, hits } = flipDescriptorProxy(
        honestInput(),
        'evidenceDisclosesPaddingStatus',
        false,
        true,
      );
      assertResult(fn(proxy), LABELS.invalid);
      assert.strictEqual(hits(), 1);
    }

    assert.doesNotThrow(() => {
      const throwDesc = new Proxy(honestInput(), {
        getOwnPropertyDescriptor() {
          throw new Error('desc-trap');
        },
      });
      assertResult(fn(throwDesc), LABELS.invalid);
    });
  });

  it('10) exact frozen outputs; no input mutation; no content echo', () => {
    const fn = shape.classifyCrossLanTrafficShapeDisclosure;
    const input = honestInput();
    const snapshot = JSON.stringify(input);

    const out = fn(input);
    assert.strictEqual(JSON.stringify(input), snapshot, 'input must not mutate');
    assertResult(out, LABELS.honest, { honestDisclosure: true });

    // all labels share uniform shape
    const samples = [
      [honestInput(), LABELS.honest, true],
      [honestInput({ claimsAnonymous: true }), LABELS.overclaim, false],
      [honestInput({ paddingEnabled: true }), LABELS.premature, false],
      [honestInput({ evidenceDisclosesPaddingStatus: false }), LABELS.invalid, false],
      [null, LABELS.invalid, false],
    ];
    for (const [inp, label, honest] of samples) {
      const r = fn(inp);
      assertResult(r, label, { honestDisclosure: honest });
      // no free-form content echo
      assert.strictEqual(String(r.label).includes(SENTINEL), false);
      assert.strictEqual(JSON.stringify(r).includes(SENTINEL), false);
    }

    // marketing string fields are rejected, not echoed
    const poisoned = honestInput({ slogan: SENTINEL });
    const bad = fn(poisoned);
    assertResult(bad, LABELS.invalid);
    assert.strictEqual(JSON.stringify(bad).includes(SENTINEL), false);
  });

  it('11) static honesty / import / no-runtime boundary', () => {
    const src = readFileSync(SRC, 'utf8');

    // No imports / requires at all
    const importLines = src
      .split('\n')
      .filter(
        (line) => /^\s*import\s/.test(line) || /\brequire\s*\(/.test(line),
      );
    assert.strictEqual(
      importLines.length,
      0,
      'T1.20 contract must have zero imports',
    );
    assert.doesNotMatch(src, /\brequire\s*\(/);
    assert.doesNotMatch(src, /from\s+['"]node:/);
    assert.doesNotMatch(
      src,
      /node:(fs|net|tls|http|https|crypto|child_process|process|timers)\b/,
    );
    assert.doesNotMatch(src, /\bfetch\s*\(/);
    assert.doesNotMatch(src, /\b(writeFile|readFile|createWriteStream)\b/);
    assert.doesNotMatch(src, /\b(console\.(log|info|warn|error)|logger)\b/);
    assert.doesNotMatch(src, /\bnew\s+Date\b/);
    assert.doesNotMatch(src, /\bDate\.(now|parse|UTC)\b/);
    assert.doesNotMatch(src, /\b(setTimeout|setInterval|setImmediate)\b/);
    assert.doesNotMatch(src, /\bPromise\b/);
    assert.doesNotMatch(src, /\bprocess\.env\b/);
    assert.doesNotMatch(src, /\bpadding-runtime\b/i);
    assert.doesNotMatch(src, /\bKeychain\b/);

    // Honesty pins
    const honesty = shape.CROSS_LAN_TRAFFIC_SHAPE_POLICY.honesty;
    assert.strictEqual(honesty.callerClaimsAreRuntimeProof, false);
    assert.strictEqual(honesty.m1PerformsRuntimePadding, false);
    assert.strictEqual(honesty.m1PerformsNetwork, false);
    assert.strictEqual(honesty.m1PerformsDataPlane, false);
    assert.strictEqual(honesty.m1WritesConfig, false);
    assert.strictEqual(honesty.m1WritesEvidence, false);
    assert.strictEqual(honesty.implementationStage, 'T1.20-M1-contract-only');

    assert.strictEqual(
      shape.CROSS_LAN_TRAFFIC_SHAPE_POLICY.padding.m1RuntimeEnabled,
      false,
    );
    assert.strictEqual(
      shape.CROSS_LAN_TRAFFIC_SHAPE_POLICY.padding.runtimeStatus,
      'not-ready',
    );
    assert.strictEqual(
      shape.CROSS_LAN_TRAFFIC_SHAPE_POLICY.padding.goldRequired,
      false,
    );

    // Source must document residual risk / forbid anonymity claims
    assert.match(src, /F-P1-SIZE-LEAK|residual/);
    assert.match(src, /T1\.20-M1-contract-only/);
    assert.match(src, /not-ready|not ready/i);
    assert.doesNotMatch(src, /traffic-analysis resistant/i);
    // must not claim anonymity as a product guarantee in comments either
    assert.doesNotMatch(
      src,
      /promises?\s+(anonymity|untraceability|traffic-analysis)/i,
    );
  });
});
