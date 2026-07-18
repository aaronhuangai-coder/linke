/**
 * Honesty scope: T1.18 M1 pure Controller Noise static lifecycle contract only.
 * T1.0 Noise library gate = BLOCKED (not M1 crypto PASS).
 * Case A (X25519 static online rotate while Ed25519 identity trusted) is
 * strictly separated from Case B (Ed25519 identity compromised / trust
 * unproven → fleet re-enroll). No crypto / network / persistence / ack /
 * time / timer runtime. Caller claims are not runtime proof.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CONTROL_PLANE_MESSAGE_SCHEMAS,
} from '../src/cross-lan-protocol.js';
import { ERROR_CODES } from '../src/error-codes.js';
import * as noise from '../src/cross-lan-controller-noise-contract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/cross-lan-controller-noise-contract.js');

const UINT64_MAX = (1n << 64n) - 1n;

/** Fixed dummy sentinels — never real X25519 / Ed25519 material. */
const DUMMY_OLD = 'dummy-old-noise-static-pub';
const DUMMY_NEW = 'dummy-new-noise-static-pub';
const DUMMY_SIG = 'dummy-ed25519-signature';
const DUMMY_UPDATE_ID = 'dummy-update-id-1';
const DUMMY_NOT_BEFORE = '2026-07-17T00:00:00.000Z';
const DUMMY_GRACE = '2026-07-17T01:00:00.000Z';
const SENTINEL_SECRET = 'must-never-echo-secret-material';

const EXPORTS = Object.freeze([
  'CROSS_LAN_CONTROLLER_NOISE_STATIC_POLICY',
  'matchesCrossLanControllerNoiseKeyUpdateContract',
  'shouldPreserveOldCrossLanControllerNoiseStaticsAfterUpdateAttempt',
  'classifyCrossLanControllerNoiseTrustRecovery',
]);

const POLICY_TOP_KEYS = Object.freeze([
  'updateMessageType',
  'ackMessageType',
  'requiredUpdateFields',
  'requiredAckFields',
  'caseA',
  'caseB',
  'trustEpoch',
  'honesty',
]);

const CASE_A_KEYS = Object.freeze([
  'deliveryChannel',
  'signatureAuthority',
  'signatureCoversAllRequiredUpdateFields',
  'oldMustDifferFromNew',
  'persistBeforeAckRequired',
  'atomicPersistenceClaim',
  'updateIdDedupRequired',
  'oldAndNewAcceptedDuringInclusiveOverlap',
  'oldRejectedAfterGrace',
  'oldRejectedAfterGraceErrorCode',
  'emergencyRevokeEncoding',
  'preserveOldSetOnAnyFailure',
  'skipSignatureVerificationAllowed',
  'caseAMessageCanRotateIdentity',
]);

const CASE_B_KEYS = Object.freeze([
  'triggers',
  'action',
  'newEd25519IdentityRequired',
  'newNoiseStaticRequired',
  'newTrustEpochRequired',
  'revokeOldBindings',
  'onlineSelfProofAllowed',
  'caseAMessageAcceptedForIdentityRotation',
  'requiresOutOfBandCleanBootstrap',
  'errorCode',
]);

const TRUST_EPOCH_KEYS = Object.freeze([
  'scope',
  'rule',
  'staleErrorCode',
  'orthogonalFields',
  'growthAloneRequiresFleetReenroll',
]);

const HONESTY_KEYS = Object.freeze([
  'callerClaimsAreRuntimeProof',
  'm1PerformsSignatureVerification',
  'm1PerformsPersistence',
  'm1EmitsAck',
  'm1RunsGraceTimer',
  'a27A29RuntimeStatus',
  'implementationStage',
]);

const MESSAGE_KEYS = Object.freeze([
  'oldNoiseStaticPub',
  'newNoiseStaticPub',
  'notBefore',
  'graceUntil',
  'trustEpoch',
  'updateId',
  'signature',
]);

const WRAPPER_KEYS = Object.freeze([
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

const CLASSIFIER_KEYS = Object.freeze([
  'ed25519IdentityCompromised',
  'controllerTrustStateProven',
  'authenticatedE2eeEstablished',
]);

const NONEMPTY_STRING_FIELDS = Object.freeze([
  'oldNoiseStaticPub',
  'newNoiseStaticPub',
  'notBefore',
  'graceUntil',
  'updateId',
  'signature',
]);

const PRESERVE_TRUE_CLAIMS = Object.freeze([
  'authenticatedE2eeEstablished',
  'signatureVerified',
  'timeWindowValidated',
  'oldStaticMatchesActiveSet',
  'updateIdUnseen',
  'persistenceSucceeded',
]);

/** @param {Record<string, unknown>} [overrides] */
function validUpdateMessage(overrides = {}) {
  return {
    oldNoiseStaticPub: DUMMY_OLD,
    newNoiseStaticPub: DUMMY_NEW,
    notBefore: DUMMY_NOT_BEFORE,
    graceUntil: DUMMY_GRACE,
    trustEpoch: 2n,
    updateId: DUMMY_UPDATE_ID,
    signature: DUMMY_SIG,
    ...overrides,
  };
}

/** Emergency encoding shape only: graceUntil === notBefore (no clock parse). */
function validEmergencyMessage(overrides = {}) {
  return validUpdateMessage({
    notBefore: '2026-07-17T12:00:00.000Z',
    graceUntil: '2026-07-17T12:00:00.000Z',
    trustEpoch: 3n,
    ...overrides,
  });
}

/** @param {Record<string, unknown>} [overrides] */
function happyPreserveWrapper(overrides = {}) {
  return {
    message: validUpdateMessage(),
    lastAcceptedTrustEpoch: 1n,
    authenticatedE2eeEstablished: true,
    ed25519IdentityCompromised: false,
    controllerTrustStateProven: true,
    signatureVerified: true,
    timeWindowValidated: true,
    oldStaticMatchesActiveSet: true,
    updateIdUnseen: true,
    persistenceSucceeded: true,
    ...overrides,
  };
}

/** @param {Record<string, unknown>} [overrides] */
function validClassifierInput(overrides = {}) {
  return {
    ed25519IdentityCompromised: false,
    controllerTrustStateProven: true,
    authenticatedE2eeEstablished: true,
    ...overrides,
  };
}

class ExampleClass {
  constructor() {
    this.oldNoiseStaticPub = DUMMY_OLD;
    this.newNoiseStaticPub = DUMMY_NEW;
    this.notBefore = DUMMY_NOT_BEFORE;
    this.graceUntil = DUMMY_GRACE;
    this.trustEpoch = 2n;
    this.updateId = DUMMY_UPDATE_ID;
    this.signature = DUMMY_SIG;
  }
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

/**
 * @param {object} target
 * @returns {{ proxy: object, descCounts: Record<string, number>, ownKeysCount: () => number }}
 */
function countingDescriptorProxy(target) {
  /** @type {Record<string, number>} */
  const descCounts = Object.create(null);
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
  });
  return { proxy: p, descCounts, ownKeysCount: () => ownKeysCount };
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
 * get trap returns valid; descriptor returns invalid (or reverse).
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

describe('cross-lan controller noise static contract (T1.18 M1 pure contract)', () => {
  it('1) export surface exactly 4; policy top8/caseA14/caseB10/trust5/honesty7 exact + deep freeze + T1.2 refs + registry codes', () => {
    assert.deepStrictEqual(Object.keys(noise).sort(), [...EXPORTS].sort());

    const p = noise.CROSS_LAN_CONTROLLER_NOISE_STATIC_POLICY;
    assert.notStrictEqual(p, undefined, 'policy export must exist (T1.18 RED)');
    assert.ok(Object.isFrozen(p));
    assert.strictEqual(Object.keys(p).length, 8);
    assert.deepStrictEqual(Object.keys(p).sort(), [...POLICY_TOP_KEYS].sort());

    assert.strictEqual(p.updateMessageType, 'controller-noise-key-update');
    assert.strictEqual(p.ackMessageType, 'controller-noise-key-ack');
    assert.strictEqual(
      p.requiredUpdateFields,
      CONTROL_PLANE_MESSAGE_SCHEMAS['controller-noise-key-update'].requiredFields,
      'requiredUpdateFields must reuse T1.2 frozen requiredFields array',
    );
    assert.strictEqual(
      p.requiredAckFields,
      CONTROL_PLANE_MESSAGE_SCHEMAS['controller-noise-key-ack'].requiredFields,
      'requiredAckFields must reuse T1.2 frozen ack requiredFields array',
    );
    assert.deepStrictEqual(p.requiredUpdateFields, [...MESSAGE_KEYS]);
    assert.deepStrictEqual(p.requiredAckFields, ['updateId']);
    assert.ok(Object.isFrozen(p.requiredUpdateFields));
    assert.ok(Object.isFrozen(p.requiredAckFields));

    // caseA exact 14
    assert.ok(Object.isFrozen(p.caseA));
    assert.strictEqual(Object.keys(p.caseA).length, 14);
    assert.deepStrictEqual(Object.keys(p.caseA).sort(), [...CASE_A_KEYS].sort());
    assert.strictEqual(
      p.caseA.deliveryChannel,
      'authenticated-e2ee-established-only',
    );
    assert.strictEqual(
      p.caseA.signatureAuthority,
      'trusted-controller-ed25519-canonical-tbs',
    );
    assert.strictEqual(p.caseA.signatureCoversAllRequiredUpdateFields, true);
    assert.strictEqual(p.caseA.oldMustDifferFromNew, true);
    assert.strictEqual(p.caseA.persistBeforeAckRequired, true);
    assert.strictEqual(
      p.caseA.atomicPersistenceClaim,
      'overlap-plus-lastAcceptedTrustEpoch-plus-updateId-dedup',
    );
    assert.strictEqual(p.caseA.updateIdDedupRequired, true);
    assert.strictEqual(p.caseA.oldAndNewAcceptedDuringInclusiveOverlap, true);
    assert.strictEqual(p.caseA.oldRejectedAfterGrace, true);
    assert.strictEqual(
      p.caseA.oldRejectedAfterGraceErrorCode,
      ERROR_CODES.HANDSHAKE_IDENTITY_FAILED,
    );
    assert.strictEqual(
      p.caseA.emergencyRevokeEncoding,
      'graceUntil-equals-notBefore',
    );
    assert.strictEqual(p.caseA.preserveOldSetOnAnyFailure, true);
    assert.strictEqual(p.caseA.skipSignatureVerificationAllowed, false);
    assert.strictEqual(p.caseA.caseAMessageCanRotateIdentity, false);

    // caseB exact 10
    assert.ok(Object.isFrozen(p.caseB));
    assert.strictEqual(Object.keys(p.caseB).length, 10);
    assert.deepStrictEqual(Object.keys(p.caseB).sort(), [...CASE_B_KEYS].sort());
    assert.deepStrictEqual([...p.caseB.triggers], [
      'ed25519-identity-compromised',
      'controller-trust-state-unproven',
    ]);
    assert.ok(Object.isFrozen(p.caseB.triggers));
    assert.strictEqual(p.caseB.action, 'fleet-replace-reenroll');
    assert.strictEqual(p.caseB.newEd25519IdentityRequired, true);
    assert.strictEqual(p.caseB.newNoiseStaticRequired, true);
    assert.strictEqual(p.caseB.newTrustEpochRequired, true);
    assert.deepStrictEqual([...p.caseB.revokeOldBindings], [
      'ed25519-identity',
      'noise-static',
      'enrollment-binding',
    ]);
    assert.ok(Object.isFrozen(p.caseB.revokeOldBindings));
    assert.strictEqual(p.caseB.onlineSelfProofAllowed, false);
    assert.strictEqual(p.caseB.caseAMessageAcceptedForIdentityRotation, false);
    assert.strictEqual(p.caseB.requiresOutOfBandCleanBootstrap, true);
    assert.strictEqual(
      p.caseB.errorCode,
      ERROR_CODES.CONTROLLER_STATE_UNTRUSTED,
    );

    // trustEpoch exact 5
    assert.ok(Object.isFrozen(p.trustEpoch));
    assert.strictEqual(Object.keys(p.trustEpoch).length, 5);
    assert.deepStrictEqual(
      Object.keys(p.trustEpoch).sort(),
      [...TRUST_EPOCH_KEYS].sort(),
    );
    assert.strictEqual(p.trustEpoch.scope, 'controller-global');
    assert.strictEqual(
      p.trustEpoch.rule,
      'positive-uint64-strictly-greater-than-last-accepted',
    );
    assert.strictEqual(
      p.trustEpoch.staleErrorCode,
      ERROR_CODES.STALE_EPOCH_REJECTED,
    );
    assert.deepStrictEqual([...p.trustEpoch.orthogonalFields], [
      'enrollmentEpoch',
      'revokeGeneration',
    ]);
    assert.ok(Object.isFrozen(p.trustEpoch.orthogonalFields));
    assert.strictEqual(p.trustEpoch.growthAloneRequiresFleetReenroll, false);

    // honesty exact 7
    assert.ok(Object.isFrozen(p.honesty));
    assert.strictEqual(Object.keys(p.honesty).length, 7);
    assert.deepStrictEqual(
      Object.keys(p.honesty).sort(),
      [...HONESTY_KEYS].sort(),
    );
    assert.strictEqual(p.honesty.callerClaimsAreRuntimeProof, false);
    assert.strictEqual(p.honesty.m1PerformsSignatureVerification, false);
    assert.strictEqual(p.honesty.m1PerformsPersistence, false);
    assert.strictEqual(p.honesty.m1EmitsAck, false);
    assert.strictEqual(p.honesty.m1RunsGraceTimer, false);
    assert.strictEqual(p.honesty.a27A29RuntimeStatus, 'not-ready');
    assert.strictEqual(
      p.honesty.implementationStage,
      'T1.18-M1-contract-only',
    );

    assert.throws(() => {
      p.caseA.preserveOldSetOnAnyFailure = false;
    }, TypeError);
    assert.throws(() => {
      p.caseB.triggers.push('extra');
    }, TypeError);
    assert.throws(() => {
      p.requiredUpdateFields.push('extra');
    }, TypeError);
  });

  it('2) matchesCrossLanControllerNoiseKeyUpdateContract: happy overlap/emergency/null-proto/frozen/bounds/distinct', () => {
    const fn = noise.matchesCrossLanControllerNoiseKeyUpdateContract;
    assert.strictEqual(typeof fn, 'function', 'export must exist (T1.18 RED)');

    assert.strictEqual(fn(validUpdateMessage()), true);
    assert.strictEqual(fn(validEmergencyMessage()), true);

    const nullProto = Object.assign(Object.create(null), validUpdateMessage());
    assert.strictEqual(fn(nullProto), true);
    assert.strictEqual(fn(Object.freeze(validUpdateMessage())), true);

    assert.strictEqual(fn(validUpdateMessage({ trustEpoch: 1n })), true);
    assert.strictEqual(fn(validUpdateMessage({ trustEpoch: UINT64_MAX })), true);

    // string-level distinct old/new (no X25519 encoding validation)
    assert.strictEqual(
      fn(
        validUpdateMessage({
          oldNoiseStaticPub: 'a',
          newNoiseStaticPub: 'b',
        }),
      ),
      true,
    );
  });

  it('3) matcher invalid: equal old/new, epoch, empty/type, missing/extra orthogonal, hostile', () => {
    const fn = noise.matchesCrossLanControllerNoiseKeyUpdateContract;
    assert.strictEqual(typeof fn, 'function', 'export must exist (T1.18 RED)');

    // equal old/new at string level
    assert.strictEqual(
      fn(
        validUpdateMessage({
          oldNoiseStaticPub: 'same-key',
          newNoiseStaticPub: 'same-key',
        }),
      ),
      false,
      'old===new must reject',
    );

    // trustEpoch invalid
    assert.strictEqual(fn(validUpdateMessage({ trustEpoch: 2 })), false);
    assert.strictEqual(fn(validUpdateMessage({ trustEpoch: 0n })), false);
    assert.strictEqual(fn(validUpdateMessage({ trustEpoch: -1n })), false);
    assert.strictEqual(
      fn(validUpdateMessage({ trustEpoch: UINT64_MAX + 1n })),
      false,
    );
    assert.strictEqual(fn(validUpdateMessage({ trustEpoch: '2' })), false);

    // empty / non-string required strings (no trim)
    for (const field of NONEMPTY_STRING_FIELDS) {
      assert.strictEqual(
        fn(validUpdateMessage({ [field]: '' })),
        false,
        `empty ${field}`,
      );
      assert.strictEqual(
        fn(validUpdateMessage({ [field]: 1 })),
        false,
        `non-string ${field}`,
      );
      assert.strictEqual(
        fn(validUpdateMessage({ [field]: '  ' })),
        true,
        `whitespace-only ${field} is nonempty string (no trim)`,
      );
    }

    // missing field
    const missing = validUpdateMessage();
    delete missing.signature;
    assert.strictEqual(fn(missing), false);

    // extra orthogonal / emergency flag fields
    for (const extra of [
      'enrollmentEpoch',
      'revokeGeneration',
      'revokeOldImmediately',
    ]) {
      assert.strictEqual(
        fn(validUpdateMessage({ [extra]: 1n })),
        false,
        `extra ${extra}`,
      );
    }

    // symbol / non-enum / accessor / class / array / Date / null
    const withSymbol = validUpdateMessage();
    Object.defineProperty(withSymbol, Symbol('x'), {
      value: 1,
      enumerable: true,
    });
    assert.strictEqual(fn(withSymbol), false);

    const nonEnum = validUpdateMessage();
    Object.defineProperty(nonEnum, 'hidden', {
      value: 1,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    assert.strictEqual(fn(nonEnum), false);

    const withAccessor = validUpdateMessage();
    Object.defineProperty(withAccessor, 'updateId', {
      get() {
        return DUMMY_UPDATE_ID;
      },
      enumerable: true,
      configurable: true,
    });
    assert.strictEqual(fn(withAccessor), false);

    assert.strictEqual(fn(new ExampleClass()), false);
    assert.strictEqual(fn([]), false);
    assert.strictEqual(fn(null), false);
    assert.strictEqual(fn(undefined), false);
    assert.strictEqual(fn(new Date()), false);

    assert.doesNotThrow(() => {
      assert.strictEqual(fn(createThrowingProxy()), false);
      assert.strictEqual(fn(createRevokedProxy(validUpdateMessage())), false);
    });
  });

  it('4) shouldPreserveOld… happy first/max → false (apply-path eligible; not immediate old delete)', () => {
    const fn =
      noise.shouldPreserveOldCrossLanControllerNoiseStaticsAfterUpdateAttempt;
    assert.strictEqual(typeof fn, 'function', 'export must exist (T1.18 RED)');

    assert.strictEqual(fn(happyPreserveWrapper()), false);

    assert.strictEqual(
      fn(
        happyPreserveWrapper({
          message: validUpdateMessage({ trustEpoch: 1n }),
          lastAcceptedTrustEpoch: 0n,
        }),
      ),
      false,
      'first accept 1n > 0n',
    );

    assert.strictEqual(
      fn(
        happyPreserveWrapper({
          message: validUpdateMessage({ trustEpoch: UINT64_MAX }),
          lastAcceptedTrustEpoch: UINT64_MAX - 1n,
        }),
      ),
      false,
      'max boundary',
    );

    assert.strictEqual(
      fn(
        happyPreserveWrapper({
          message: validEmergencyMessage({ trustEpoch: 5n }),
          lastAcceptedTrustEpoch: 4n,
        }),
      ),
      false,
      'emergency shape with claims',
    );
  });

  it('5) preserve predicate: each gate independent fail + P0 compromised/unproven + stale + replay + persistence', () => {
    const fn =
      noise.shouldPreserveOldCrossLanControllerNoiseStaticsAfterUpdateAttempt;
    assert.strictEqual(typeof fn, 'function', 'export must exist (T1.18 RED)');

    // bad message
    assert.strictEqual(
      fn(
        happyPreserveWrapper({
          message: validUpdateMessage({ trustEpoch: 0n }),
        }),
      ),
      true,
    );
    assert.strictEqual(
      fn(
        happyPreserveWrapper({
          message: validUpdateMessage({
            oldNoiseStaticPub: DUMMY_OLD,
            newNoiseStaticPub: DUMMY_OLD,
          }),
        }),
      ),
      true,
      'equal old/new message must preserve',
    );

    // stale / equal / invalid last epoch
    assert.strictEqual(
      fn(
        happyPreserveWrapper({
          message: validUpdateMessage({ trustEpoch: 1n }),
          lastAcceptedTrustEpoch: 1n,
        }),
      ),
      true,
      'equal epoch stale',
    );
    assert.strictEqual(
      fn(
        happyPreserveWrapper({
          message: validUpdateMessage({ trustEpoch: 1n }),
          lastAcceptedTrustEpoch: 2n,
        }),
      ),
      true,
      'stale epoch',
    );
    assert.strictEqual(
      fn(happyPreserveWrapper({ lastAcceptedTrustEpoch: -1n })),
      true,
    );
    assert.strictEqual(
      fn(happyPreserveWrapper({ lastAcceptedTrustEpoch: 1 })),
      true,
    );

    // each true-claim independently false / non-boolean → preserve
    for (const claim of PRESERVE_TRUE_CLAIMS) {
      assert.strictEqual(
        fn(happyPreserveWrapper({ [claim]: false })),
        true,
        `${claim}=false must preserve`,
      );
      assert.strictEqual(
        fn(happyPreserveWrapper({ [claim]: 'true' })),
        true,
        `${claim} string must preserve`,
      );
      assert.strictEqual(
        fn(happyPreserveWrapper({ [claim]: 1 })),
        true,
        `${claim} number must preserve`,
      );
    }

    // P0: identity compromised + all other true → preserve (math sig cannot substitute)
    assert.strictEqual(
      fn(
        happyPreserveWrapper({
          ed25519IdentityCompromised: true,
          authenticatedE2eeEstablished: true,
          controllerTrustStateProven: true,
          signatureVerified: true,
          timeWindowValidated: true,
          oldStaticMatchesActiveSet: true,
          updateIdUnseen: true,
          persistenceSucceeded: true,
        }),
      ),
      true,
      'P0 compromised identity must preserve even with E2EE+sig+persist true',
    );

    // trust state unproven + signature true → preserve
    assert.strictEqual(
      fn(
        happyPreserveWrapper({
          controllerTrustStateProven: false,
          signatureVerified: true,
          authenticatedE2eeEstablished: true,
          persistenceSucceeded: true,
        }),
      ),
      true,
      'unproven trust state must preserve despite signature claim',
    );

    // updateId replay claim
    assert.strictEqual(
      fn(happyPreserveWrapper({ updateIdUnseen: false })),
      true,
      'updateId replay → preserve',
    );

    // persistence fail
    assert.strictEqual(
      fn(happyPreserveWrapper({ persistenceSucceeded: false })),
      true,
      'persistence false → preserve (no ack path)',
    );

    // exact wrapper orthogonality
    assert.strictEqual(
      fn(happyPreserveWrapper({ extra: true })),
      true,
      'extra wrapper field',
    );
    assert.strictEqual(
      fn(happyPreserveWrapper({ enrollmentEpoch: 1n })),
      true,
      'orthogonal enrollmentEpoch on wrapper',
    );
    assert.strictEqual(fn(null), true);
    assert.strictEqual(fn(undefined), true);
    assert.strictEqual(fn([]), true);
    assert.strictEqual(fn(new ExampleClass()), true);

    const missingMsg = happyPreserveWrapper();
    delete missingMsg.message;
    assert.strictEqual(fn(missingMsg), true);

    assert.doesNotThrow(() => {
      assert.strictEqual(fn(createThrowingProxy()), true);
      assert.strictEqual(fn(createRevokedProxy(happyPreserveWrapper())), true);
    });
  });

  it('6) classifyCrossLanControllerNoiseTrustRecovery: all 8 boolean combos + invalid/extra + Case B priority', () => {
    const fn = noise.classifyCrossLanControllerNoiseTrustRecovery;
    assert.strictEqual(typeof fn, 'function', 'export must exist (T1.18 RED)');

    // trusted + E2EE true
    assert.strictEqual(
      fn(validClassifierInput()),
      'case-a-online-update-eligible',
    );

    // trusted + E2EE false
    assert.strictEqual(
      fn(validClassifierInput({ authenticatedE2eeEstablished: false })),
      'case-a-blocked-no-authenticated-e2ee',
    );

    // Case B priority over E2EE: compromised true regardless of E2EE
    assert.strictEqual(
      fn(
        validClassifierInput({
          ed25519IdentityCompromised: true,
          authenticatedE2eeEstablished: true,
        }),
      ),
      'case-b-fleet-reenroll-required',
    );
    assert.strictEqual(
      fn(
        validClassifierInput({
          ed25519IdentityCompromised: true,
          authenticatedE2eeEstablished: false,
        }),
      ),
      'case-b-fleet-reenroll-required',
    );

    // Case B: trust unproven regardless of E2EE
    assert.strictEqual(
      fn(
        validClassifierInput({
          controllerTrustStateProven: false,
          authenticatedE2eeEstablished: true,
        }),
      ),
      'case-b-fleet-reenroll-required',
    );
    assert.strictEqual(
      fn(
        validClassifierInput({
          controllerTrustStateProven: false,
          authenticatedE2eeEstablished: false,
        }),
      ),
      'case-b-fleet-reenroll-required',
    );

    // both Case B triggers
    assert.strictEqual(
      fn(
        validClassifierInput({
          ed25519IdentityCompromised: true,
          controllerTrustStateProven: false,
          authenticatedE2eeEstablished: true,
        }),
      ),
      'case-b-fleet-reenroll-required',
    );
    assert.strictEqual(
      fn(
        validClassifierInput({
          ed25519IdentityCompromised: true,
          controllerTrustStateProven: false,
          authenticatedE2eeEstablished: false,
        }),
      ),
      'case-b-fleet-reenroll-required',
    );

    // invalid shape
    assert.strictEqual(fn(null), 'invalid-input');
    assert.strictEqual(fn(undefined), 'invalid-input');
    assert.strictEqual(fn([]), 'invalid-input');
    assert.strictEqual(fn(new Date()), 'invalid-input');
    assert.strictEqual(
      fn(validClassifierInput({ ed25519IdentityCompromised: 'false' })),
      'invalid-input',
    );
    assert.strictEqual(
      fn(validClassifierInput({ controllerTrustStateProven: 1 })),
      'invalid-input',
    );

    // extra signatureVerified / enrollmentEpoch cannot bypass Case B
    assert.strictEqual(
      fn(validClassifierInput({ signatureVerified: true })),
      'invalid-input',
      'extra signatureVerified invalid (Case B cannot be bypassed by sig field)',
    );
    assert.strictEqual(
      fn(validClassifierInput({ enrollmentEpoch: 1n })),
      'invalid-input',
    );
    assert.strictEqual(
      fn(validClassifierInput({ revokeGeneration: 1n })),
      'invalid-input',
    );

    // missing field
    const missing = validClassifierInput();
    delete missing.authenticatedE2eeEstablished;
    assert.strictEqual(fn(missing), 'invalid-input');

    assert.doesNotThrow(() => {
      assert.strictEqual(fn(createThrowingProxy()), 'invalid-input');
      assert.strictEqual(
        fn(createRevokedProxy(validClassifierInput())),
        'invalid-input',
      );
    });
  });

  it('7) descriptor: count-once + get-vs-desc both ways + flip (message/wrapper/classifier)', () => {
    const match = noise.matchesCrossLanControllerNoiseKeyUpdateContract;
    const preserve =
      noise.shouldPreserveOldCrossLanControllerNoiseStaticsAfterUpdateAttempt;
    const classify = noise.classifyCrossLanControllerNoiseTrustRecovery;
    assert.strictEqual(typeof match, 'function');
    assert.strictEqual(typeof preserve, 'function');
    assert.strictEqual(typeof classify, 'function');

    // matcher: each of 7 keys descriptor exactly once; ownKeys once
    {
      const base = validUpdateMessage();
      const { proxy, descCounts, ownKeysCount } = countingDescriptorProxy(base);
      assert.strictEqual(match(proxy), true);
      assert.strictEqual(ownKeysCount(), 1);
      for (const key of MESSAGE_KEYS) {
        assert.strictEqual(
          descCounts[key],
          1,
          `matcher key ${key} desc exactly once (got ${descCounts[key]})`,
        );
      }
    }

    // preserve: wrapper 10 + nested message 7 each exactly once
    {
      const msgBase = validUpdateMessage();
      const msgCounted = countingDescriptorProxy(msgBase);
      const wrapperTarget = happyPreserveWrapper({ message: msgCounted.proxy });
      const wrapperCounted = countingDescriptorProxy(wrapperTarget);
      assert.strictEqual(preserve(wrapperCounted.proxy), false);
      assert.strictEqual(wrapperCounted.ownKeysCount(), 1);
      assert.strictEqual(msgCounted.ownKeysCount(), 1);
      for (const key of WRAPPER_KEYS) {
        assert.strictEqual(
          wrapperCounted.descCounts[key],
          1,
          `preserve wrapper key ${key} desc exactly once`,
        );
      }
      for (const key of MESSAGE_KEYS) {
        assert.strictEqual(
          msgCounted.descCounts[key],
          1,
          `preserve nested message key ${key} desc exactly once`,
        );
      }
    }

    // classifier: 3 keys once
    {
      const base = validClassifierInput();
      const { proxy, descCounts, ownKeysCount } = countingDescriptorProxy(base);
      assert.strictEqual(classify(proxy), 'case-a-online-update-eligible');
      assert.strictEqual(ownKeysCount(), 1);
      for (const key of CLASSIFIER_KEYS) {
        assert.strictEqual(descCounts[key], 1, `classifier ${key} once`);
      }
    }

    // get-vs-desc: message trustEpoch desc bad / get good → reject
    {
      const msg = getVsDescProxy(
        validUpdateMessage(),
        'trustEpoch',
        'get-valid-desc-invalid',
        2n,
        0n,
      );
      assert.strictEqual(match(msg), false);
      assert.strictEqual(
        preserve(happyPreserveWrapper({ message: msg })),
        true,
      );
    }

    // get-vs-desc: message trustEpoch desc good / get bad → accept
    {
      const msg = getVsDescProxy(
        validUpdateMessage({ trustEpoch: 2n }),
        'trustEpoch',
        'get-invalid-desc-valid',
        2n,
        0n,
      );
      assert.strictEqual(match(msg), true);
      assert.strictEqual(
        preserve(
          happyPreserveWrapper({
            message: msg,
            lastAcceptedTrustEpoch: 1n,
          }),
        ),
        false,
      );
    }

    // get-vs-desc: wrapper compromised desc true / get false → preserve
    {
      const wrapper = getVsDescProxy(
        happyPreserveWrapper(),
        'ed25519IdentityCompromised',
        'get-valid-desc-invalid',
        false,
        true,
      );
      assert.strictEqual(preserve(wrapper), true);
    }

    // get-vs-desc: wrapper compromised desc false / get true → apply path
    {
      const wrapper = getVsDescProxy(
        happyPreserveWrapper(),
        'ed25519IdentityCompromised',
        'get-invalid-desc-valid',
        false,
        true,
      );
      assert.strictEqual(preserve(wrapper), false);
    }

    // get-vs-desc: persistence desc false / get true → preserve
    {
      const wrapper = getVsDescProxy(
        happyPreserveWrapper(),
        'persistenceSucceeded',
        'get-valid-desc-invalid',
        true,
        false,
      );
      assert.strictEqual(preserve(wrapper), true);
    }

    // get-vs-desc: classifier compromised desc true / get false → case B
    {
      const input = getVsDescProxy(
        validClassifierInput(),
        'ed25519IdentityCompromised',
        'get-valid-desc-invalid',
        false,
        true,
      );
      assert.strictEqual(classify(input), 'case-b-fleet-reenroll-required');
    }

    // get-vs-desc: classifier compromised desc false / get true → eligible
    {
      const input = getVsDescProxy(
        validClassifierInput(),
        'ed25519IdentityCompromised',
        'get-invalid-desc-valid',
        false,
        true,
      );
      assert.strictEqual(classify(input), 'case-a-online-update-eligible');
    }

    // flip: first invalid / second would be valid → fail-closed; second never observed
    {
      const cases = [
        {
          name: 'matcher trustEpoch 0n→2n',
          run: () => {
            const { proxy, hits } = flipDescriptorProxy(
              validUpdateMessage({ trustEpoch: 2n }),
              'trustEpoch',
              0n,
              2n,
            );
            assert.strictEqual(match(proxy), false);
            assert.strictEqual(hits(), 1);
          },
        },
        {
          name: 'preserve nested trustEpoch 0n→2n',
          run: () => {
            const { proxy, hits } = flipDescriptorProxy(
              validUpdateMessage({ trustEpoch: 2n }),
              'trustEpoch',
              0n,
              2n,
            );
            assert.strictEqual(
              preserve(happyPreserveWrapper({ message: proxy })),
              true,
            );
            assert.strictEqual(hits(), 1);
          },
        },
        {
          name: 'preserve compromised false←true flip (first true)',
          run: () => {
            const { proxy, hits } = flipDescriptorProxy(
              happyPreserveWrapper(),
              'ed25519IdentityCompromised',
              true,
              false,
            );
            assert.strictEqual(preserve(proxy), true);
            assert.strictEqual(hits(), 1);
          },
        },
        {
          name: 'preserve persistenceSucceeded false→true',
          run: () => {
            const { proxy, hits } = flipDescriptorProxy(
              happyPreserveWrapper(),
              'persistenceSucceeded',
              false,
              true,
            );
            assert.strictEqual(preserve(proxy), true);
            assert.strictEqual(hits(), 1);
          },
        },
        {
          name: 'preserve message ref null→valid',
          run: () => {
            const goodMsg = validUpdateMessage();
            const { proxy, hits } = flipDescriptorProxy(
              happyPreserveWrapper({ message: goodMsg }),
              'message',
              null,
              goodMsg,
            );
            assert.strictEqual(preserve(proxy), true);
            assert.strictEqual(hits(), 1);
          },
        },
        {
          name: 'classifier compromised true→false',
          run: () => {
            const { proxy, hits } = flipDescriptorProxy(
              validClassifierInput(),
              'ed25519IdentityCompromised',
              true,
              false,
            );
            assert.strictEqual(
              classify(proxy),
              'case-b-fleet-reenroll-required',
            );
            assert.strictEqual(hits(), 1);
          },
        },
      ];
      for (const c of cases) c.run();
    }

    // throwing descriptor traps total no-throw
    assert.doesNotThrow(() => {
      const throwDesc = new Proxy(validUpdateMessage(), {
        getOwnPropertyDescriptor() {
          throw new Error('desc-trap');
        },
      });
      assert.strictEqual(match(throwDesc), false);
      assert.strictEqual(
        preserve(happyPreserveWrapper({ message: throwDesc })),
        true,
      );
      assert.strictEqual(classify(throwDesc), 'invalid-input');
    });
  });

  it('8) honesty/static boundary: only two allowed imports; no crypto/fs/net/tls/runtime side effects; A27–A29 not-ready', () => {
    const src = readFileSync(SRC, 'utf8');

    // Exactly the two allowed import module sources (multiline-safe)
    const importFroms = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    assert.deepStrictEqual(
      [...importFroms].sort(),
      ['./cross-lan-protocol.js', './error-codes.js'].sort(),
      'ESM imports must be exactly the two allowed modules',
    );
    assert.ok(
      src.includes('CONTROL_PLANE_MESSAGE_SCHEMAS') &&
        src.includes('shouldRejectCrossLanTrustEpoch'),
      'must import CONTROL_PLANE_MESSAGE_SCHEMAS + shouldRejectCrossLanTrustEpoch',
    );
    assert.ok(src.includes('ERROR_CODES'), 'must import ERROR_CODES');

    // No runtime / crypto / network / persistence side-effect modules
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
      'createWriteStream',
      'Date.now',
      'new Date',
      'performance.now',
    ];
    for (const token of forbidden) {
      assert.ok(
        !src.includes(token),
        `source must not contain forbidden token: ${token}`,
      );
    }

    // Honesty flags pin A27–A29 runtime not-ready
    const honesty = noise.CROSS_LAN_CONTROLLER_NOISE_STATIC_POLICY.honesty;
    assert.strictEqual(honesty.a27A29RuntimeStatus, 'not-ready');
    assert.strictEqual(honesty.m1PerformsSignatureVerification, false);
    assert.strictEqual(honesty.m1PerformsPersistence, false);
    assert.strictEqual(honesty.m1EmitsAck, false);
    assert.strictEqual(honesty.m1RunsGraceTimer, false);
    assert.strictEqual(honesty.callerClaimsAreRuntimeProof, false);
    assert.strictEqual(
      honesty.implementationStage,
      'T1.18-M1-contract-only',
    );

    // Case A cannot rotate identity; Case B forbids online self-proof
    const policy = noise.CROSS_LAN_CONTROLLER_NOISE_STATIC_POLICY;
    assert.strictEqual(policy.caseA.caseAMessageCanRotateIdentity, false);
    assert.strictEqual(policy.caseB.onlineSelfProofAllowed, false);
    assert.strictEqual(
      policy.caseB.caseAMessageAcceptedForIdentityRotation,
      false,
    );

    // No export echo of dummy secrets from API results
    assert.strictEqual(typeof matchSafe(noise), 'object');
    function matchSafe(mod) {
      const r1 = mod.matchesCrossLanControllerNoiseKeyUpdateContract(
        validUpdateMessage(),
      );
      const r2 =
        mod.shouldPreserveOldCrossLanControllerNoiseStaticsAfterUpdateAttempt(
          happyPreserveWrapper(),
        );
      const r3 = mod.classifyCrossLanControllerNoiseTrustRecovery(
        validClassifierInput(),
      );
      assert.strictEqual(typeof r1, 'boolean');
      assert.strictEqual(typeof r2, 'boolean');
      assert.strictEqual(typeof r3, 'string');
      // boolean/string closed outputs only — never echo key material
      assert.ok(r1 === true || r1 === false);
      assert.ok(r2 === true || r2 === false);
      assert.ok(
        [
          'invalid-input',
          'case-b-fleet-reenroll-required',
          'case-a-blocked-no-authenticated-e2ee',
          'case-a-online-update-eligible',
        ].includes(r3),
      );
      return { r1, r2, r3 };
    }
  });
});
