/**
 * Honesty scope: T1.19 M1 pure denylistVersion uint64 boundary contract only
 * (A30 / §4.6.2 / §6.11). Strict BigInt semantic representation; reserved
 * unpublished MAX; no wrap; fail-closed controller-state-untrusted; full fleet
 * replace/re-enroll path as closed claim only. No network / persistence /
 * ack / migration / A30 runtime.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONTROL_PLANE_MESSAGE_SCHEMAS } from '../src/cross-lan-protocol.js';
import { ERROR_CODES } from '../src/error-codes.js';
import * as denylist from '../src/cross-lan-denylist-version-contract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/cross-lan-denylist-version-contract.js');

const UINT64_MAX = (1n << 64n) - 1n;
const LAST_SAFE = UINT64_MAX - 1n;
const FINAL_SAFE_CURRENT = UINT64_MAX - 2n;
const ORDINARY_MAX_CURRENT = UINT64_MAX - 3n;

const SENTINEL_SECRET = 'must-never-echo-secret-material';

const EXPORTS = Object.freeze([
  'CROSS_LAN_DENYLIST_VERSION_POLICY',
  'planNextCrossLanDenylistVersionAllocation',
  'classifyCrossLanDenylistVersionTrustRecovery',
]);

const POLICY_TOP_KEYS = Object.freeze([
  'updateMessageType',
  'ackMessageType',
  'requiredUpdateFields',
  'requiredAckFields',
  'versionRepresentation',
  'uint64Max',
  'maxIsReservedUnpublished',
  'lastSafePublishedVersion',
  'wrapAllowed',
  'finalSafeCurrentVersion',
  'finalSafeAllocationRule',
  'exhaustionErrorCode',
  'authority',
  'recovery',
  'honesty',
]);

const AUTHORITY_KEYS = Object.freeze([
  'l1RelayDenylistIsAuthoritative',
  'l2ControllerIsSoleAuthority',
  'l1AcceptanceAuthorizesL2',
]);

const RECOVERY_POLICY_KEYS = Object.freeze([
  'action',
  'requiresControllerTrustStateTransition',
  'stopAuthoritativeControllerService',
  'requiresNewGlobalEpoch',
  'invalidateOldTrustMaterialCategories',
]);

const HONESTY_KEYS = Object.freeze([
  'callerClaimsAreRuntimeProof',
  'm1PerformsNetwork',
  'm1PerformsPersistence',
  'm1EmitsAck',
  'm1PerformsMigration',
  'a30RuntimeStatus',
  'implementationStage',
]);

const INVALIDATED_CATEGORIES = Object.freeze([
  'bindings',
  'identity',
  'statics',
  'enrollment',
  'material',
]);

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

const RECOVERY_RESULT_KEYS = Object.freeze([
  'recovery',
  'controllerState',
  'stopAuthoritativeControllerService',
  'requiresControllerTrustStateTransition',
  'requiresFullFleetReplaceReenroll',
  'requiresNewGlobalEpoch',
  'invalidateOldTrustMaterialCategories',
  'l1AcceptanceAuthorizesL2',
  'errorCode',
]);

const DECISIONS = Object.freeze({
  ordinary: 'ordinary-safe-allocation',
  finalSafe: 'final-safe-allocation-requires-trust-transition',
  exhausted: 'exhausted-fail-closed',
  invalid: 'invalid-unverifiable-input',
});

const RECOVERIES = Object.freeze({
  none: 'no-recovery-required',
  full: 'full-fleet-recovery-required',
  invalid: 'invalid-input',
});

/** @param {bigint} current */
function planInput(current) {
  return { currentDenylistVersion: current };
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
 * @param {object} target
 * @returns {{ proxy: object, descCounts: Record<string, number>, ownKeysCount: () => number, getCounts: Record<string, number> }}
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
          value:
            mode === 'get-valid-desc-invalid' ? invalidValue : validValue,
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
        throw new Error(SENTINEL_SECRET);
      },
      get() {
        throw new Error(SENTINEL_SECRET);
      },
      getOwnPropertyDescriptor() {
        throw new Error(SENTINEL_SECRET);
      },
      getPrototypeOf() {
        throw new Error(SENTINEL_SECRET);
      },
    },
  );
}

function createRevokedProxy(target) {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

class ExampleClass {
  constructor(v = 1n) {
    this.currentDenylistVersion = v;
  }
}

/**
 * @param {ReturnType<typeof denylist.planNextCrossLanDenylistVersionAllocation>} d
 */
function assertNoUsableNext(d) {
  assert.strictEqual(d.nextDenylistVersion, null);
  assert.strictEqual(d.errorCode, ERROR_CODES.CONTROLLER_STATE_UNTRUSTED);
  assert.strictEqual(d.requiresControllerTrustStateTransition, true);
  assert.strictEqual(d.stopAuthoritativeControllerService, true);
  assert.strictEqual(d.requiresFullFleetReplaceReenroll, true);
  assert.strictEqual(d.requiresNewGlobalEpoch, true);
  assert.deepStrictEqual(
    [...d.invalidateOldTrustMaterialCategories],
    [...INVALIDATED_CATEGORIES],
  );
  assert.strictEqual(d.l1AcceptanceAuthorizesL2, false);
}

/**
 * @param {ReturnType<typeof denylist.planNextCrossLanDenylistVersionAllocation>} d
 * @param {bigint} current
 * @param {bigint} next
 */
function assertOrdinary(d, current, next) {
  assertExactFrozenKeys(d, DECISION_KEYS);
  assert.strictEqual(d.decision, DECISIONS.ordinary);
  assert.strictEqual(d.currentDenylistVersion, current);
  assert.strictEqual(d.nextDenylistVersion, next);
  assert.strictEqual(d.errorCode, null);
  assert.strictEqual(d.requiresControllerTrustStateTransition, false);
  assert.strictEqual(d.stopAuthoritativeControllerService, false);
  assert.strictEqual(d.requiresFullFleetReplaceReenroll, false);
  assert.strictEqual(d.requiresNewGlobalEpoch, false);
  assert.deepStrictEqual([...d.invalidateOldTrustMaterialCategories], []);
  assert.ok(Object.isFrozen(d.invalidateOldTrustMaterialCategories));
  assert.strictEqual(d.l1AcceptanceAuthorizesL2, false);
  assert.ok(next > current);
  assert.notStrictEqual(next, 0n);
  assert.notStrictEqual(next, UINT64_MAX);
  assert.ok(next < UINT64_MAX);
}

/**
 * @param {ReturnType<typeof denylist.classifyCrossLanDenylistVersionTrustRecovery>} r
 */
function assertFullRecovery(r) {
  assertExactFrozenKeys(r, RECOVERY_RESULT_KEYS);
  assert.strictEqual(r.recovery, RECOVERIES.full);
  assert.strictEqual(r.controllerState, 'untrusted');
  assert.strictEqual(r.stopAuthoritativeControllerService, true);
  assert.strictEqual(r.requiresControllerTrustStateTransition, true);
  assert.strictEqual(r.requiresFullFleetReplaceReenroll, true);
  assert.strictEqual(r.requiresNewGlobalEpoch, true);
  assert.deepStrictEqual(
    [...r.invalidateOldTrustMaterialCategories],
    [...INVALIDATED_CATEGORIES],
  );
  assert.ok(Object.isFrozen(r.invalidateOldTrustMaterialCategories));
  assert.strictEqual(r.l1AcceptanceAuthorizesL2, false);
  assert.strictEqual(r.errorCode, ERROR_CODES.CONTROLLER_STATE_UNTRUSTED);
}

/**
 * @param {ReturnType<typeof denylist.classifyCrossLanDenylistVersionTrustRecovery>} r
 */
function assertNoRecovery(r) {
  assertExactFrozenKeys(r, RECOVERY_RESULT_KEYS);
  assert.strictEqual(r.recovery, RECOVERIES.none);
  assert.strictEqual(r.controllerState, 'trusted');
  assert.strictEqual(r.stopAuthoritativeControllerService, false);
  assert.strictEqual(r.requiresControllerTrustStateTransition, false);
  assert.strictEqual(r.requiresFullFleetReplaceReenroll, false);
  assert.strictEqual(r.requiresNewGlobalEpoch, false);
  assert.deepStrictEqual([...r.invalidateOldTrustMaterialCategories], []);
  assert.strictEqual(r.l1AcceptanceAuthorizesL2, false);
  assert.strictEqual(r.errorCode, null);
}

describe('cross-lan denylist version contract (T1.19 M1 pure contract / A30)', () => {
  it('1) export surface exactly 3; policy exact/deep-frozen; T1.2 array identity; registry error code', () => {
    assert.deepStrictEqual(Object.keys(denylist).sort(), [...EXPORTS].sort());

    const p = denylist.CROSS_LAN_DENYLIST_VERSION_POLICY;
    assert.notStrictEqual(p, undefined, 'policy export must exist (T1.19 RED)');
    assert.ok(Object.isFrozen(p));
    assert.strictEqual(Object.keys(p).length, POLICY_TOP_KEYS.length);
    assert.deepStrictEqual(Object.keys(p).sort(), [...POLICY_TOP_KEYS].sort());

    assert.strictEqual(p.updateMessageType, 'denylist-update');
    assert.strictEqual(p.ackMessageType, 'denylist-ack');
    assert.strictEqual(
      p.requiredUpdateFields,
      CONTROL_PLANE_MESSAGE_SCHEMAS['denylist-update'].requiredFields,
      'requiredUpdateFields must reuse T1.2 frozen requiredFields array identity',
    );
    assert.strictEqual(
      p.requiredAckFields,
      CONTROL_PLANE_MESSAGE_SCHEMAS['denylist-ack'].requiredFields,
      'requiredAckFields must reuse T1.2 frozen requiredFields array identity',
    );
    assert.deepStrictEqual(p.requiredUpdateFields, [
      'denylistVersion',
      'entries',
    ]);
    assert.deepStrictEqual(p.requiredAckFields, ['denylistVersion']);
    assert.ok(Object.isFrozen(p.requiredUpdateFields));
    assert.ok(Object.isFrozen(p.requiredAckFields));

    assert.strictEqual(p.versionRepresentation, 'strict-bigint-uint64');
    assert.strictEqual(p.uint64Max, UINT64_MAX);
    assert.strictEqual(p.maxIsReservedUnpublished, true);
    assert.strictEqual(p.lastSafePublishedVersion, LAST_SAFE);
    assert.strictEqual(p.wrapAllowed, false);
    assert.strictEqual(p.finalSafeCurrentVersion, FINAL_SAFE_CURRENT);
    assert.strictEqual(
      p.finalSafeAllocationRule,
      'allocate-last-safe-then-mandatory-trust-transition',
    );
    assert.strictEqual(
      p.exhaustionErrorCode,
      ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
    );

    assert.ok(Object.isFrozen(p.authority));
    assert.deepStrictEqual(
      Object.keys(p.authority).sort(),
      [...AUTHORITY_KEYS].sort(),
    );
    assert.strictEqual(p.authority.l1RelayDenylistIsAuthoritative, false);
    assert.strictEqual(p.authority.l2ControllerIsSoleAuthority, true);
    assert.strictEqual(p.authority.l1AcceptanceAuthorizesL2, false);

    assert.ok(Object.isFrozen(p.recovery));
    assert.deepStrictEqual(
      Object.keys(p.recovery).sort(),
      [...RECOVERY_POLICY_KEYS].sort(),
    );
    assert.strictEqual(p.recovery.action, 'full-fleet-replace-reenroll');
    assert.strictEqual(p.recovery.requiresControllerTrustStateTransition, true);
    assert.strictEqual(p.recovery.stopAuthoritativeControllerService, true);
    assert.strictEqual(p.recovery.requiresNewGlobalEpoch, true);
    assert.deepStrictEqual(
      [...p.recovery.invalidateOldTrustMaterialCategories],
      [...INVALIDATED_CATEGORIES],
    );
    assert.ok(Object.isFrozen(p.recovery.invalidateOldTrustMaterialCategories));

    assert.ok(Object.isFrozen(p.honesty));
    assert.deepStrictEqual(
      Object.keys(p.honesty).sort(),
      [...HONESTY_KEYS].sort(),
    );
    assert.strictEqual(p.honesty.callerClaimsAreRuntimeProof, false);
    assert.strictEqual(p.honesty.m1PerformsNetwork, false);
    assert.strictEqual(p.honesty.m1PerformsPersistence, false);
    assert.strictEqual(p.honesty.m1EmitsAck, false);
    assert.strictEqual(p.honesty.m1PerformsMigration, false);
    assert.strictEqual(p.honesty.a30RuntimeStatus, 'not-ready');
    assert.strictEqual(
      p.honesty.implementationStage,
      'T1.19-M1-contract-only',
    );

    assert.throws(() => {
      // @ts-expect-error intentional freeze probe
      p.wrapAllowed = true;
    }, TypeError);
    assert.throws(() => {
      p.recovery.invalidateOldTrustMaterialCategories.push('extra');
    }, TypeError);
    assert.throws(() => {
      p.requiredUpdateFields.push('extra');
    }, TypeError);
  });

  it('2) ordinary safe allocation: 0, 1, MAX-3; strictly increasing; never 0/MAX next', () => {
    const plan = denylist.planNextCrossLanDenylistVersionAllocation;
    assert.strictEqual(typeof plan, 'function', 'export must exist (T1.19 RED)');

    const d0 = plan(planInput(0n));
    assertOrdinary(d0, 0n, 1n);

    const d1 = plan(planInput(1n));
    assertOrdinary(d1, 1n, 2n);

    const dNear = plan(planInput(ORDINARY_MAX_CURRENT));
    assertOrdinary(dNear, ORDINARY_MAX_CURRENT, FINAL_SAFE_CURRENT);

    // null-prototype + frozen input accepted
    assertOrdinary(
      plan(Object.assign(Object.create(null), planInput(5n))),
      5n,
      6n,
    );
    assertOrdinary(plan(Object.freeze(planInput(9n))), 9n, 10n);

    // every ordinary next is usable and never MAX / never 0
    for (const cur of [0n, 1n, 2n, 100n, ORDINARY_MAX_CURRENT]) {
      const d = plan(planInput(cur));
      assert.strictEqual(d.decision, DECISIONS.ordinary);
      assert.ok(typeof d.nextDenylistVersion === 'bigint');
      assert.ok(d.nextDenylistVersion > cur);
      assert.notStrictEqual(d.nextDenylistVersion, 0n);
      assert.notStrictEqual(d.nextDenylistVersion, UINT64_MAX);
    }
  });

  it('3) final-safe MAX-2 → MAX-1 requires mandatory trust transition; maps to full recovery', () => {
    const plan = denylist.planNextCrossLanDenylistVersionAllocation;
    const classify = denylist.classifyCrossLanDenylistVersionTrustRecovery;

    const d = plan(planInput(FINAL_SAFE_CURRENT));
    assertExactFrozenKeys(d, DECISION_KEYS);
    assert.strictEqual(d.decision, DECISIONS.finalSafe);
    assert.strictEqual(d.currentDenylistVersion, FINAL_SAFE_CURRENT);
    assert.strictEqual(d.nextDenylistVersion, LAST_SAFE);
    assert.notStrictEqual(d.nextDenylistVersion, UINT64_MAX);
    assert.strictEqual(d.errorCode, ERROR_CODES.CONTROLLER_STATE_UNTRUSTED);
    assert.strictEqual(d.requiresControllerTrustStateTransition, true);
    assert.strictEqual(d.stopAuthoritativeControllerService, true);
    assert.strictEqual(d.requiresFullFleetReplaceReenroll, true);
    assert.strictEqual(d.requiresNewGlobalEpoch, true);
    assert.deepStrictEqual(
      [...d.invalidateOldTrustMaterialCategories],
      [...INVALIDATED_CATEGORIES],
    );
    assert.strictEqual(d.l1AcceptanceAuthorizesL2, false);
    // Must not imply continued authoritative service after this last safe alloc.
    assert.notStrictEqual(d.stopAuthoritativeControllerService, false);

    assertFullRecovery(classify(d));
  });

  it('4) MAX-1 / MAX / MAX+1 / negative fail closed; no usable next; map to full recovery', () => {
    const plan = denylist.planNextCrossLanDenylistVersionAllocation;
    const classify = denylist.classifyCrossLanDenylistVersionTrustRecovery;

    for (const cur of [LAST_SAFE, UINT64_MAX, UINT64_MAX + 1n]) {
      const d = plan(planInput(cur));
      assertExactFrozenKeys(d, DECISION_KEYS);
      assert.strictEqual(d.decision, DECISIONS.exhausted);
      assert.strictEqual(d.currentDenylistVersion, cur);
      assertNoUsableNext(d);
      assert.notStrictEqual(d.nextDenylistVersion, UINT64_MAX);
      assertFullRecovery(classify(d));
    }

    const neg = plan(planInput(-1n));
    assertExactFrozenKeys(neg, DECISION_KEYS);
    assert.strictEqual(neg.decision, DECISIONS.invalid);
    assert.strictEqual(neg.currentDenylistVersion, null);
    assertNoUsableNext(neg);
    assertFullRecovery(classify(neg));
  });

  it('5) invalid/unverifiable inputs: Number/string/null/undefined/array/class/Date/extra/missing/symbol/accessor/proxy', () => {
    const plan = denylist.planNextCrossLanDenylistVersionAllocation;
    const classify = denylist.classifyCrossLanDenylistVersionTrustRecovery;

    const hostiles = [
      null,
      undefined,
      0,
      1,
      Number.MAX_SAFE_INTEGER,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '1',
      '0n',
      true,
      false,
      [],
      [1n],
      new Date(),
      new ExampleClass(1n),
      planInput(/** @type {any} */ (1)),
      planInput(/** @type {any} */ ('1')),
      planInput(/** @type {any} */ (null)),
      planInput(/** @type {any} */ (undefined)),
      planInput(/** @type {any} */ ([1n])),
      { currentDenylistVersion: 1n, extra: true },
      {},
      { other: 1n },
      Object.assign(Object.create(null), {
        currentDenylistVersion: 1n,
        [Symbol('x')]: 1n,
      }),
      (() => {
        const o = {};
        Object.defineProperty(o, 'currentDenylistVersion', {
          get() {
            return 1n;
          },
          enumerable: true,
        });
        return o;
      })(),
      (() => {
        const o = { currentDenylistVersion: 1n };
        Object.defineProperty(o, 'hidden', {
          value: true,
          enumerable: false,
        });
        return o;
      })(),
      createThrowingProxy(),
      createRevokedProxy(planInput(1n)),
    ];

    for (let i = 0; i < hostiles.length; i += 1) {
      const input = hostiles[i];
      let d;
      assert.doesNotThrow(() => {
        d = plan(input);
      });
      assertExactFrozenKeys(d, DECISION_KEYS);
      assert.strictEqual(
        d.decision,
        DECISIONS.invalid,
        `expected invalid for hostile index ${i}`,
      );
      assert.strictEqual(d.currentDenylistVersion, null);
      assertNoUsableNext(d);
      assertFullRecovery(classify(d));
    }

    // symbol own key with exact string field also present → reject (extra key)
    {
      const o = { currentDenylistVersion: 1n };
      o[Symbol('s')] = true;
      const d = plan(o);
      assert.strictEqual(d.decision, DECISIONS.invalid);
      assertNoUsableNext(d);
    }
  });

  it('6) recovery classifier: ordinary→none; final/exhausted/invalid→full; forged/inconsistent rejected; aggregate flag cannot bypass', () => {
    const plan = denylist.planNextCrossLanDenylistVersionAllocation;
    const classify = denylist.classifyCrossLanDenylistVersionTrustRecovery;
    assert.strictEqual(
      typeof classify,
      'function',
      'export must exist (T1.19 RED)',
    );

    assertNoRecovery(classify(plan(planInput(0n))));
    assertNoRecovery(classify(plan(planInput(ORDINARY_MAX_CURRENT))));
    assertFullRecovery(classify(plan(planInput(FINAL_SAFE_CURRENT))));
    assertFullRecovery(classify(plan(planInput(LAST_SAFE))));
    assertFullRecovery(classify(plan(planInput(UINT64_MAX))));
    assertFullRecovery(classify(plan(planInput(-1n))));
    assertFullRecovery(classify(plan(null)));

    // forged: ordinary label with full-fleet aggregate flag
    {
      const good = plan(planInput(1n));
      const forged = {
        ...good,
        requiresFullFleetReplaceReenroll: true,
      };
      const r = classify(forged);
      assertExactFrozenKeys(r, RECOVERY_RESULT_KEYS);
      assert.strictEqual(r.recovery, RECOVERIES.invalid);
      // fail-closed defaults — no open path via forged aggregate
      assert.strictEqual(r.stopAuthoritativeControllerService, true);
      assert.strictEqual(r.requiresFullFleetReplaceReenroll, true);
      assert.strictEqual(r.l1AcceptanceAuthorizesL2, false);
      assert.strictEqual(r.errorCode, ERROR_CODES.CONTROLLER_STATE_UNTRUSTED);
    }

    // forged: exhausted label but usable next MAX (wrap/bypass attempt)
    {
      const forged = {
        decision: DECISIONS.exhausted,
        currentDenylistVersion: LAST_SAFE,
        nextDenylistVersion: UINT64_MAX,
        errorCode: ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
        requiresControllerTrustStateTransition: true,
        stopAuthoritativeControllerService: true,
        requiresFullFleetReplaceReenroll: true,
        requiresNewGlobalEpoch: true,
        invalidateOldTrustMaterialCategories: [...INVALIDATED_CATEGORIES],
        l1AcceptanceAuthorizesL2: false,
      };
      assert.strictEqual(classify(forged).recovery, RECOVERIES.invalid);
    }

    // forged: full-fleet aggregate true but other fail-closed fields false
    {
      const forged = {
        decision: DECISIONS.exhausted,
        currentDenylistVersion: LAST_SAFE,
        nextDenylistVersion: null,
        errorCode: ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
        requiresControllerTrustStateTransition: false,
        stopAuthoritativeControllerService: false,
        requiresFullFleetReplaceReenroll: true,
        requiresNewGlobalEpoch: false,
        invalidateOldTrustMaterialCategories: [...INVALIDATED_CATEGORIES],
        l1AcceptanceAuthorizesL2: false,
      };
      assert.strictEqual(classify(forged).recovery, RECOVERIES.invalid);
    }

    // forged: L1 authorizes L2 claim
    {
      const good = plan(planInput(LAST_SAFE));
      const forged = { ...good, l1AcceptanceAuthorizesL2: true };
      assert.strictEqual(classify(forged).recovery, RECOVERIES.invalid);
    }

    // forged: ordinary with wrong next (wrap to 0)
    {
      const forged = {
        decision: DECISIONS.ordinary,
        currentDenylistVersion: UINT64_MAX,
        nextDenylistVersion: 0n,
        errorCode: null,
        requiresControllerTrustStateTransition: false,
        stopAuthoritativeControllerService: false,
        requiresFullFleetReplaceReenroll: false,
        requiresNewGlobalEpoch: false,
        invalidateOldTrustMaterialCategories: [],
        l1AcceptanceAuthorizesL2: false,
      };
      assert.strictEqual(classify(forged).recovery, RECOVERIES.invalid);
    }

    // extra field / missing field / wrong type
    assert.strictEqual(
      classify({ ...plan(planInput(1n)), extra: true }).recovery,
      RECOVERIES.invalid,
    );
    {
      const missing = { ...plan(planInput(1n)) };
      delete missing.errorCode;
      assert.strictEqual(classify(missing).recovery, RECOVERIES.invalid);
    }
    assert.strictEqual(classify(null).recovery, RECOVERIES.invalid);
    assert.strictEqual(classify(undefined).recovery, RECOVERIES.invalid);
    assert.strictEqual(classify([]).recovery, RECOVERIES.invalid);
    assert.strictEqual(classify(new Date()).recovery, RECOVERIES.invalid);
    assert.doesNotThrow(() => {
      assert.strictEqual(
        classify(createThrowingProxy()).recovery,
        RECOVERIES.invalid,
      );
      assert.strictEqual(
        classify(createRevokedProxy(plan(planInput(1n)))).recovery,
        RECOVERIES.invalid,
      );
    });
  });

  it('7) single descriptor snapshot / flip-on-second-read; no ordinary getters; both input layers', () => {
    const plan = denylist.planNextCrossLanDenylistVersionAllocation;
    const classify = denylist.classifyCrossLanDenylistVersionTrustRecovery;

    // plan layer: ownKeys once; each key descriptor once; no ordinary get
    {
      const base = planInput(1n);
      const { proxy, descCounts, getCounts, ownKeysCount } =
        countingDescriptorProxy(base);
      const d = plan(proxy);
      assert.strictEqual(d.decision, DECISIONS.ordinary);
      assert.strictEqual(ownKeysCount(), 1);
      assert.strictEqual(descCounts.currentDenylistVersion, 1);
      assert.strictEqual(
        getCounts.currentDenylistVersion || 0,
        0,
        'plan must not ordinary-get currentDenylistVersion',
      );
    }

    // classify layer: ownKeys once; each decision key desc once; no ordinary get
    {
      const base = plan(planInput(1n));
      // re-materialize as plain data record (frozen decision is fine as target)
      const plain = {};
      for (const k of DECISION_KEYS) plain[k] = base[k];
      const { proxy, descCounts, getCounts, ownKeysCount } =
        countingDescriptorProxy(plain);
      const r = classify(proxy);
      assert.strictEqual(r.recovery, RECOVERIES.none);
      assert.strictEqual(ownKeysCount(), 1);
      for (const key of DECISION_KEYS) {
        assert.strictEqual(
          descCounts[key],
          1,
          `classify key ${key} desc exactly once`,
        );
        assert.strictEqual(
          getCounts[key] || 0,
          0,
          `classify must not ordinary-get ${key}`,
        );
      }
    }

    // get-valid / desc-invalid: plan uses desc only → invalid
    {
      const input = getVsDescProxy(
        planInput(1n),
        'currentDenylistVersion',
        'get-valid-desc-invalid',
        1n,
        '1',
      );
      assert.strictEqual(plan(input).decision, DECISIONS.invalid);
    }

    // get-invalid / desc-valid: plan uses desc only → ordinary
    {
      const input = getVsDescProxy(
        planInput(1n),
        'currentDenylistVersion',
        'get-invalid-desc-valid',
        1n,
        '1',
      );
      assert.strictEqual(plan(input).decision, DECISIONS.ordinary);
      assert.strictEqual(plan(input).nextDenylistVersion, 2n);
    }

    // flip first invalid, second would be valid → fail-closed; second never observed
    {
      const { proxy, hits } = flipDescriptorProxy(
        planInput(1n),
        'currentDenylistVersion',
        '1',
        1n,
      );
      assert.strictEqual(plan(proxy).decision, DECISIONS.invalid);
      assert.strictEqual(hits(), 1);
    }

    // flip first exhausted-boundary value, second ordinary → exhausted; once
    {
      const { proxy, hits } = flipDescriptorProxy(
        planInput(LAST_SAFE),
        'currentDenylistVersion',
        LAST_SAFE,
        1n,
      );
      assert.strictEqual(plan(proxy).decision, DECISIONS.exhausted);
      assert.strictEqual(hits(), 1);
    }

    // classify flip: first forged flag true, second false → invalid; once
    {
      const good = plan(planInput(1n));
      const plain = {};
      for (const k of DECISION_KEYS) plain[k] = good[k];
      const { proxy, hits } = flipDescriptorProxy(
        plain,
        'requiresFullFleetReplaceReenroll',
        true,
        false,
      );
      assert.strictEqual(classify(proxy).recovery, RECOVERIES.invalid);
      assert.strictEqual(hits(), 1);
    }

    // classify get-vs-desc: desc says L1 authorizes → invalid; get would say false
    {
      const good = plan(planInput(LAST_SAFE));
      const plain = {};
      for (const k of DECISION_KEYS) plain[k] = good[k];
      const input = getVsDescProxy(
        plain,
        'l1AcceptanceAuthorizesL2',
        'get-valid-desc-invalid',
        false,
        true,
      );
      assert.strictEqual(classify(input).recovery, RECOVERIES.invalid);
    }

    assert.doesNotThrow(() => {
      const throwDesc = new Proxy(planInput(1n), {
        getOwnPropertyDescriptor() {
          throw new Error('desc-trap');
        },
      });
      assert.strictEqual(plan(throwDesc).decision, DECISIONS.invalid);
      assert.strictEqual(classify(throwDesc).recovery, RECOVERIES.invalid);
    });
  });

  it('8) frozen accessor-free exact outputs; no input mutation; never publish MAX as next', () => {
    const plan = denylist.planNextCrossLanDenylistVersionAllocation;
    const classify = denylist.classifyCrossLanDenylistVersionTrustRecovery;

    const input = planInput(3n);
    Object.defineProperty(input, 'currentDenylistVersion', {
      value: 3n,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const before = input.currentDenylistVersion;
    const d = plan(input);
    assert.strictEqual(input.currentDenylistVersion, before);
    assertExactFrozenKeys(d, DECISION_KEYS);
    assert.throws(() => {
      // @ts-expect-error freeze probe
      d.decision = 'x';
    }, TypeError);
    assert.throws(() => {
      d.invalidateOldTrustMaterialCategories.push('x');
    }, TypeError);

    const r = classify(d);
    assertExactFrozenKeys(r, RECOVERY_RESULT_KEYS);
    assert.throws(() => {
      // @ts-expect-error freeze probe
      r.recovery = 'x';
    }, TypeError);

    // exhaustive scan of edge currents: never next === MAX
    const samples = [
      0n,
      1n,
      ORDINARY_MAX_CURRENT,
      FINAL_SAFE_CURRENT,
      LAST_SAFE,
      UINT64_MAX,
      UINT64_MAX + 1n,
      -1n,
    ];
    for (const cur of samples) {
      const out = plan(planInput(cur));
      assert.notStrictEqual(out.nextDenylistVersion, UINT64_MAX);
      if (out.nextDenylistVersion !== null) {
        assert.ok(out.nextDenylistVersion > cur);
        assert.notStrictEqual(out.nextDenylistVersion, 0n);
      }
    }
  });

  it('9) honesty/static import boundary; no runtime side effects; A30 not-ready', () => {
    const src = readFileSync(SRC, 'utf8');

    const importFroms = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    assert.deepStrictEqual(
      [...importFroms].sort(),
      ['./cross-lan-protocol.js', './error-codes.js'].sort(),
      'ESM imports must be exactly the two allowed modules',
    );
    assert.ok(
      src.includes('CONTROL_PLANE_MESSAGE_SCHEMAS'),
      'must import CONTROL_PLANE_MESSAGE_SCHEMAS',
    );
    assert.ok(src.includes('ERROR_CODES'), 'must import ERROR_CODES');
    // Must not redefine wire schemas; reuse T1.2 requiredFields by identity.
    assert.ok(
      src.includes("CONTROL_PLANE_MESSAGE_SCHEMAS['denylist-update']") ||
        src.includes('CONTROL_PLANE_MESSAGE_SCHEMAS["denylist-update"]') ||
        src.includes("['denylist-update']"),
    );
    assert.ok(
      src.includes("CONTROL_PLANE_MESSAGE_SCHEMAS['denylist-ack']") ||
        src.includes('CONTROL_PLANE_MESSAGE_SCHEMAS["denylist-ack"]') ||
        src.includes("['denylist-ack']"),
    );

    const forbidden = [
      'node:crypto',
      'node:fs',
      'node:net',
      'node:tls',
      'node:http',
      'node:https',
      'node:dgram',
      "from 'crypto'",
      "from 'fs'",
      "from 'net'",
      "from 'tls'",
      "from 'http'",
      "from 'https'",
      'from "crypto"',
      'from "fs"',
      'Keychain',
      'fetch(',
      'setTimeout',
      'setInterval',
      'writeFile',
      'readFileSync',
      'createServer',
      'connect(',
      'process.env',
      'Date.now',
      'new Date',
      'Promise',
      'setImmediate',
    ];
    for (const token of forbidden) {
      assert.ok(
        !src.includes(token),
        `forbidden runtime/side-effect token: ${token}`,
      );
    }

    const honesty = denylist.CROSS_LAN_DENYLIST_VERSION_POLICY.honesty;
    assert.strictEqual(honesty.a30RuntimeStatus, 'not-ready');
    assert.strictEqual(honesty.callerClaimsAreRuntimeProof, false);
    assert.strictEqual(honesty.m1PerformsNetwork, false);
    assert.strictEqual(honesty.m1PerformsPersistence, false);
    assert.strictEqual(honesty.m1EmitsAck, false);
    assert.strictEqual(honesty.m1PerformsMigration, false);
    assert.strictEqual(honesty.implementationStage, 'T1.19-M1-contract-only');

    // Closed outputs only — never echo secrets / paths / keys
    const d = denylist.planNextCrossLanDenylistVersionAllocation(planInput(1n));
    const serialized = JSON.stringify(d, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    assert.ok(!serialized.includes(SENTINEL_SECRET));
    assert.ok(!serialized.includes('/Users/'));
    assert.ok(!serialized.includes('BEGIN '));
  });

  it('10) nested invalidateOldTrustMaterialCategories: exact frozen dense plain Array only; hostile fail-closed; planner still passes', () => {
    const plan = denylist.planNextCrossLanDenylistVersionAllocation;
    const classify = denylist.classifyCrossLanDenylistVersionTrustRecovery;

    /**
     * @param {unknown} categories
     * @param {'ordinary' | 'exhausted'} kind
     */
    function decisionWithCategories(categories, kind = 'ordinary') {
      if (kind === 'ordinary') {
        return {
          decision: DECISIONS.ordinary,
          currentDenylistVersion: 1n,
          nextDenylistVersion: 2n,
          errorCode: null,
          requiresControllerTrustStateTransition: false,
          stopAuthoritativeControllerService: false,
          requiresFullFleetReplaceReenroll: false,
          requiresNewGlobalEpoch: false,
          invalidateOldTrustMaterialCategories: categories,
          l1AcceptanceAuthorizesL2: false,
        };
      }
      return {
        decision: DECISIONS.exhausted,
        currentDenylistVersion: LAST_SAFE,
        nextDenylistVersion: null,
        errorCode: ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
        requiresControllerTrustStateTransition: true,
        stopAuthoritativeControllerService: true,
        requiresFullFleetReplaceReenroll: true,
        requiresNewGlobalEpoch: true,
        invalidateOldTrustMaterialCategories: categories,
        l1AcceptanceAuthorizesL2: false,
      };
    }

    // Direct planner outputs still classify correctly (frozen dense plain arrays).
    assertNoRecovery(classify(plan(planInput(0n))));
    assertNoRecovery(classify(plan(planInput(1n))));
    assertNoRecovery(classify(plan(planInput(ORDINARY_MAX_CURRENT))));
    assertFullRecovery(classify(plan(planInput(FINAL_SAFE_CURRENT))));
    assertFullRecovery(classify(plan(planInput(LAST_SAFE))));
    assertFullRecovery(classify(plan(planInput(UINT64_MAX))));
    assertFullRecovery(classify(plan(planInput(-1n))));
    assertFullRecovery(classify(plan(null)));

    // Mutable (non-frozen) nested arrays fail closed.
    assert.strictEqual(
      classify(decisionWithCategories([])).recovery,
      RECOVERIES.invalid,
    );
    assert.strictEqual(
      classify(decisionWithCategories([...INVALIDATED_CATEGORIES], 'exhausted'))
        .recovery,
      RECOVERIES.invalid,
    );
    assert.strictEqual(
      classify(
        decisionWithCategories(Object.seal([...INVALIDATED_CATEGORIES]), 'exhausted'),
      ).recovery,
      RECOVERIES.invalid,
    );

    // Index accessor: reject without invoking getter.
    {
      let getterHits = 0;
      const cats = [...INVALIDATED_CATEGORIES];
      Object.defineProperty(cats, '0', {
        get() {
          getterHits += 1;
          return 'bindings';
        },
        enumerable: true,
        configurable: true,
      });
      assert.strictEqual(
        classify(decisionWithCategories(cats, 'exhausted')).recovery,
        RECOVERIES.invalid,
      );
      assert.strictEqual(
        getterHits,
        0,
        'getter-only index must be rejected without invoking getter',
      );
    }

    // Non-enumerable index.
    {
      const cats = [...INVALIDATED_CATEGORIES];
      Object.defineProperty(cats, '0', {
        value: 'bindings',
        writable: true,
        enumerable: false,
        configurable: true,
      });
      assert.strictEqual(
        classify(decisionWithCategories(cats, 'exhausted')).recovery,
        RECOVERIES.invalid,
      );
    }

    // Sparse (holes).
    {
      const sparse = new Array(INVALIDATED_CATEGORIES.length);
      for (let i = 1; i < INVALIDATED_CATEGORIES.length; i += 1) {
        sparse[i] = INVALIDATED_CATEGORIES[i];
      }
      // index 0 missing (hole); length matches.
      assert.strictEqual(
        classify(decisionWithCategories(sparse, 'exhausted')).recovery,
        RECOVERIES.invalid,
      );
    }

    // Array subclass.
    {
      class CategoryArray extends Array {}
      const subEmpty = new CategoryArray();
      Object.freeze(subEmpty);
      assert.strictEqual(
        classify(decisionWithCategories(subEmpty)).recovery,
        RECOVERIES.invalid,
      );
      const subFull = CategoryArray.from(INVALIDATED_CATEGORIES);
      Object.freeze(subFull);
      assert.strictEqual(
        classify(decisionWithCategories(subFull, 'exhausted')).recovery,
        RECOVERIES.invalid,
      );
    }

    // Extra string own key.
    {
      const cats = [...INVALIDATED_CATEGORIES];
      // @ts-expect-error intentional extra key
      cats.extra = 'nope';
      Object.freeze(cats);
      assert.strictEqual(
        classify(decisionWithCategories(cats, 'exhausted')).recovery,
        RECOVERIES.invalid,
      );
    }

    // Extra symbol own key.
    {
      const cats = [...INVALIDATED_CATEGORIES];
      cats[Symbol('x')] = true;
      Object.freeze(cats);
      assert.strictEqual(
        classify(decisionWithCategories(cats, 'exhausted')).recovery,
        RECOVERIES.invalid,
      );
    }

    // Prototype-pollution-backed (inherited index values; no own indices).
    {
      const protoKey = '0';
      const prior = Object.getOwnPropertyDescriptor(Array.prototype, protoKey);
      Object.defineProperty(Array.prototype, protoKey, {
        value: 'bindings',
        writable: true,
        enumerable: false,
        configurable: true,
      });
      try {
        const polluted = new Array(INVALIDATED_CATEGORIES.length);
        for (let i = 1; i < INVALIDATED_CATEGORIES.length; i += 1) {
          polluted[i] = INVALIDATED_CATEGORIES[i];
        }
        // index 0 only via prototype; not an own data key.
        assert.strictEqual(
          classify(decisionWithCategories(polluted, 'exhausted')).recovery,
          RECOVERIES.invalid,
        );
      } finally {
        if (prior === undefined) {
          // @ts-expect-error cleanup
          delete Array.prototype[protoKey];
        } else {
          Object.defineProperty(Array.prototype, protoKey, prior);
        }
      }
    }

    // Throwing nested proxy.
    assert.doesNotThrow(() => {
      assert.strictEqual(
        classify(decisionWithCategories(createThrowingProxy(), 'exhausted'))
          .recovery,
        RECOVERIES.invalid,
      );
      assert.strictEqual(
        classify(decisionWithCategories(createThrowingProxy())).recovery,
        RECOVERIES.invalid,
      );
    });

    // Flip nested proxy: preventExtensions target so isExtensible is false;
    // trap reports frozen-looking descriptors and flips index-0 on re-read.
    // Classifier uses one desc read → first wrong value → invalid-input.
    {
      const frozenGood = Object.freeze([...INVALIDATED_CATEGORIES]);
      const target = [...INVALIDATED_CATEGORIES];
      Object.preventExtensions(target);
      let hits = 0;
      const flipNested = new Proxy(target, {
        ownKeys(t) {
          return Reflect.ownKeys(t);
        },
        getOwnPropertyDescriptor(t, prop) {
          if (prop === 'length') {
            return {
              value: INVALIDATED_CATEGORIES.length,
              writable: false,
              enumerable: false,
              configurable: false,
            };
          }
          if (prop === '0') {
            hits += 1;
            return {
              value: hits === 1 ? 'forged' : 'bindings',
              writable: false,
              enumerable: true,
              configurable: false,
            };
          }
          if (typeof prop === 'string' && /^(0|[1-9][0-9]*)$/.test(prop)) {
            const idx = Number(prop);
            return {
              value: INVALIDATED_CATEGORIES[idx],
              writable: false,
              enumerable: true,
              configurable: false,
            };
          }
          return Reflect.getOwnPropertyDescriptor(t, prop);
        },
        get() {
          throw new Error('ordinary get must not be used on nested categories');
        },
      });
      assert.strictEqual(
        classify(decisionWithCategories(flipNested, 'exhausted')).recovery,
        RECOVERIES.invalid,
      );
      assert.strictEqual(hits, 1);
      // Sanity: real frozen good still accepted when other fields consistent.
      assertFullRecovery(
        classify(decisionWithCategories(frozenGood, 'exhausted')),
      );
    }

    // Flip empty nested length: first reports length 1 (would need index keys),
    // second would report 0. Single read fails closed.
    {
      const emptyTarget = /** @type {string[]} */ ([]);
      Object.preventExtensions(emptyTarget);
      let hits = 0;
      const flipLen = new Proxy(emptyTarget, {
        ownKeys(t) {
          return Reflect.ownKeys(t);
        },
        getOwnPropertyDescriptor(t, prop) {
          if (prop === 'length') {
            hits += 1;
            return {
              value: hits === 1 ? 1 : 0,
              writable: false,
              enumerable: false,
              configurable: false,
            };
          }
          return Reflect.getOwnPropertyDescriptor(t, prop);
        },
        get() {
          throw new Error('ordinary get must not be used on nested categories');
        },
      });
      assert.strictEqual(
        classify(decisionWithCategories(flipLen)).recovery,
        RECOVERIES.invalid,
      );
      assert.strictEqual(hits, 1);
    }

    // Non-array objects fail closed (null-proto / ordinary record with length).
    {
      const notArray = Object.freeze({ length: 0 });
      assert.strictEqual(
        classify(decisionWithCategories(notArray)).recovery,
        RECOVERIES.invalid,
      );
      assert.strictEqual(
        classify(
          decisionWithCategories(
            Object.freeze(Object.assign(Object.create(null), { length: 0 })),
          ),
        ).recovery,
        RECOVERIES.invalid,
      );
    }

    // Hand-built exact frozen dense plain arrays (same shape as planner) accepted.
    {
      const empty = Object.freeze(/** @type {string[]} */ ([]));
      assertNoRecovery(classify(decisionWithCategories(empty)));
      const full = Object.freeze([...INVALIDATED_CATEGORIES]);
      assertFullRecovery(classify(decisionWithCategories(full, 'exhausted')));
    }
  });
});
