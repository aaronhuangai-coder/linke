/**
 * Honesty scope (Gold ADR §6.5): tests cover T1.13a + T1.13b only
 * (code policy / digest-record fields / canonical validator /
 * timingSafeEqual digest compare / tombstone FSM /
 * secret policy + bootstrap/rotate pure contract).
 * T1.0 Noise library gate = BLOCKED (not M1 crypto PASS).
 * T1.13 complete = NOT COMPLETE; A25 = NOT READY.
 * T1.13b pure contract only — does NOT prove Keychain I/O, CSPRNG,
 * HMAC, or code issue/verify. T1.13c (delivery) = NOT COMPLETE.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as enrollment from '../src/cross-lan-enrollment-contract.js';

/** Independent literal pin of §6.3.1 code policy (12 keys). */
const EXPECTED_CODE_POLICY = {
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
  unknownOrExpiredErrorCode: 'enrollment-code-unknown-or-expired',
};

/** Independent literal pin of digest-record field allowlist (10 names). */
const EXPECTED_DIGEST_RECORD_FIELDS = [
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
];

/** Forbidden plaintext/secret field names — must never appear on the allowlist. */
const FORBIDDEN_DIGEST_RECORD_FIELDS = [
  'code',
  'plaintext',
  'secret',
  'secretId',
  'rawCode',
  'raw',
  'rawDigest',
];

/** Independent literal pin of tombstone FSM table. */
const EXPECTED_TOMBSTONE_TRANSITIONS = {
  active: { expire: 'tombstone', consume: 'tombstone' },
  tombstone: { 'retention-elapsed': 'purged' },
  purged: {},
};

describe('cross-lan enrollment contract (T1.13a: code/digest/tombstone)', () => {
  it('CROSS_LAN_ENROLLMENT_CODE_POLICY: exact 12 keys, frozen, errorCode; no initialSecretVersion', () => {
    const policy = enrollment.CROSS_LAN_ENROLLMENT_CODE_POLICY;
    assert.deepStrictEqual(policy, EXPECTED_CODE_POLICY);
    assert.deepStrictEqual(Object.keys(policy).sort(), Object.keys(EXPECTED_CODE_POLICY).sort());
    assert.strictEqual(Object.keys(policy).length, 12);
    assert.ok(Object.isFrozen(policy));
    assert.strictEqual(
      policy.unknownOrExpiredErrorCode,
      'enrollment-code-unknown-or-expired',
    );
    assert.strictEqual(Object.hasOwn(policy, 'initialSecretVersion'), false);
    assert.strictEqual(policy.initialSecretVersion, undefined);
  });

  it('CROSS_LAN_ENROLLMENT_DIGEST_RECORD_FIELDS: exact frozen 10; no plaintext/secret/raw fields', () => {
    const fields = enrollment.CROSS_LAN_ENROLLMENT_DIGEST_RECORD_FIELDS;
    assert.deepStrictEqual(fields, EXPECTED_DIGEST_RECORD_FIELDS);
    assert.strictEqual(fields.length, 10);
    assert.ok(Object.isFrozen(fields));
    for (const name of FORBIDDEN_DIGEST_RECORD_FIELDS) {
      assert.strictEqual(
        fields.includes(name),
        false,
        `forbidden field must be absent: ${name}`,
      );
    }
  });

  it('isCanonicalCrossLanEnrollmentCode: 16-byte canonical base64url-no-padding only', () => {
    const isCanon = enrollment.isCanonicalCrossLanEnrollmentCode;
    // Three independent 22-char canonical encodings of exact 16 bytes.
    assert.strictEqual(isCanon('AAAAAAAAAAAAAAAAAAAAAA'), true); // 16×0x00
    assert.strictEqual(isCanon('_____________________w'), true); // 16×0xff
    assert.strictEqual(isCanon('AQIDBAUGBwgJCgsMDQ4PEA'), true); // 0x01..0x10
    // Same decoded bytes, non-canonical unused pad bits → false.
    assert.strictEqual(isCanon('AAAAAAAAAAAAAAAAAAAAAB'), false);
    assert.strictEqual(isCanon('_____________________x'), false);
    // Length / charset / padding / type gates.
    assert.strictEqual(isCanon('AAAAAAAAAAAAAAAAAAAAA'), false); // 21
    assert.strictEqual(isCanon('AAAAAAAAAAAAAAAAAAAAAAA'), false); // 23
    assert.strictEqual(isCanon('AAAAAAAAAAAAAAAAAAAAA='), false); // padding
    assert.strictEqual(isCanon('AAAAAAAAAAAAAAAAAAAA+/'), false); // +/
    assert.strictEqual(isCanon('AAAAAAAAAAAAAAAAAAAAA\u00e9'), false);
    assert.strictEqual(isCanon('AAAAAAAAAAAAAAAAAAAA A'), false);
    assert.strictEqual(isCanon('AAAAAAAAAAAAAAAAAAAA\nA'), false);
    assert.strictEqual(isCanon(null), false);
    assert.strictEqual(isCanon(undefined), false);
    assert.strictEqual(isCanon(22), false);
    assert.strictEqual(isCanon({}), false);
    assert.strictEqual(isCanon(['AAAAAAAAAAAAAAAAAAAAAA']), false);
    assert.doesNotThrow(() => isCanon(null));
  });

  it('areCrossLanEnrollmentDigestsEqual: same content / same ref / Buffer vs Uint8Array', () => {
    const eq = enrollment.areCrossLanEnrollmentDigestsEqual;
    const a = new Uint8Array(32);
    a[0] = 0xab;
    a[31] = 0xcd;
    const b = new Uint8Array(a); // different ref, same content
    assert.strictEqual(eq(a, b), true);
    assert.strictEqual(eq(a, a), true); // same ref
    const c = new Uint8Array(a);
    c[15] = 0x01; // one-byte difference
    assert.strictEqual(eq(a, c), false);
    const buf = Buffer.from(a);
    assert.strictEqual(eq(buf, a), true);
    assert.strictEqual(eq(a, buf), true);
  });

  it('areCrossLanEnrollmentDigestsEqual: wrong length/type → false, no throw', () => {
    const eq = enrollment.areCrossLanEnrollmentDigestsEqual;
    const ok = new Uint8Array(32);
    assert.doesNotThrow(() => {
      assert.strictEqual(eq(new Uint8Array(31), ok), false);
      assert.strictEqual(eq(ok, new Uint8Array(33)), false);
      assert.strictEqual(eq(new Uint8Array(0), ok), false);
      assert.strictEqual(eq('x'.repeat(32), ok), false);
      assert.strictEqual(eq(null, ok), false);
      assert.strictEqual(eq(ok, null), false);
      assert.strictEqual(eq(new DataView(new ArrayBuffer(32)), ok), false);
      assert.strictEqual(eq(new Int8Array(32), ok), false);
      assert.strictEqual(eq({ length: 32 }, ok), false);
      assert.strictEqual(eq(undefined, undefined), false);
    });
  });

  it('CROSS_LAN_ENROLLMENT_TOMBSTONE_TRANSITIONS: exact/deep-frozen; three forward edges', () => {
    const table = enrollment.CROSS_LAN_ENROLLMENT_TOMBSTONE_TRANSITIONS;
    assert.deepStrictEqual(table, EXPECTED_TOMBSTONE_TRANSITIONS);
    assert.ok(Object.isFrozen(table));
    assert.ok(Object.isFrozen(table.active));
    assert.ok(Object.isFrozen(table.tombstone));
    assert.ok(Object.isFrozen(table.purged));
    const next = enrollment.getNextCrossLanEnrollmentTombstoneState;
    assert.strictEqual(next('active', 'expire'), 'tombstone');
    assert.strictEqual(next('active', 'consume'), 'tombstone');
    assert.strictEqual(next('tombstone', 'retention-elapsed'), 'purged');
  });

  it('tombstone FSM: terminals/invalid/prototype/no path back to active', () => {
    const next = enrollment.getNextCrossLanEnrollmentTombstoneState;
    const table = enrollment.CROSS_LAN_ENROLLMENT_TOMBSTONE_TRANSITIONS;
    // tombstone cannot expire/consume; purged is terminal.
    assert.strictEqual(next('tombstone', 'expire'), null);
    assert.strictEqual(next('tombstone', 'consume'), null);
    assert.strictEqual(next('purged', 'expire'), null);
    assert.strictEqual(next('purged', 'consume'), null);
    assert.strictEqual(next('purged', 'retention-elapsed'), null);
    // Prototype / non-string → null.
    assert.doesNotThrow(() => {
      assert.strictEqual(next('toString', 'expire'), null);
      assert.strictEqual(next('constructor', 'expire'), null);
      assert.strictEqual(next('__proto__', 'expire'), null);
      assert.strictEqual(next('hasOwnProperty', 'expire'), null);
      assert.strictEqual(next('active', 'toString'), null);
      assert.strictEqual(next('active', 'constructor'), null);
      assert.strictEqual(next(null, 'expire'), null);
      assert.strictEqual(next('active', null), null);
      assert.strictEqual(next(undefined, 'expire'), null);
      assert.strictEqual(next(1, 'expire'), null);
      assert.strictEqual(next('active', 1), null);
    });
    // Enumerate table: no transition target is 'active'.
    for (const state of Object.keys(table)) {
      for (const event of Object.keys(table[state])) {
        assert.notStrictEqual(
          table[state][event],
          'active',
          `no path back to active: ${state}/${event}`,
        );
      }
    }
  });
});

/** Independent literal pin of § secret policy (11 keys). */
const EXPECTED_SECRET_POLICY = {
  secretByteLength: 32,
  initialSecretVersion: 1,
  bootstrapGeneration: 'automatic-csprng',
  storageClass: 'dedicated-keychain-item',
  manualBootstrapAllowed: false,
  plaintextExportAllowed: false,
  existingFleetDependsOnSecret: false,
  allowedUses: ['enrollment-code-hmac-digest'],
  forbiddenUses: [
    'device-authentication',
    'e2ee-session-key',
    'device-token-validation',
  ],
  forbiddenDestinations: [
    'logs',
    'audit',
    'cli-output',
    'crash-report',
    'evidence',
    'plaintext-transport',
  ],
  implementationStage: 'contract-only-no-keychain-io',
};

const BOOTSTRAP_RESULT_KEYS = [
  'status',
  'errorCode',
  'bootstrapRequired',
  'generateSecretByteLength',
  'writeDedicatedKeychainItem',
  'setSecretVersion',
  'issueNewCodes',
  'verifyNewCodes',
  'existingFleetCanContinue',
  'manualRegenerateRequired',
  'requiresFleetReenrollment',
];

const AUTH_RESULT_KEYS = [
  'authorized',
  'reasonCode',
  'reason',
  'currentSecretVersion',
  'nextSecretVersionIfCommitted',
  'generateSecretByteLength',
  'writeKeychainBeforeVersionAdvance',
  'versionAdvanced',
];

const COMMIT_RESULT_KEYS = [
  'committed',
  'reasonCode',
  'nextSecretVersion',
  'versionAdvanced',
  'invalidatePriorUnconsumedCodes',
  'invalidatePriorTombstoneNamespace',
  'oldCodeErrorCode',
  'existingFleetCanContinue',
  'requiresFleetReenrollment',
];

/**
 * @param {object} result
 * @param {string[]} keys
 */
function assertExactFrozenKeys(result, keys) {
  assert.ok(Object.isFrozen(result));
  assert.deepStrictEqual(Object.keys(result).sort(), [...keys].sort());
  assert.strictEqual(Object.keys(result).length, keys.length);
}

describe('cross-lan enrollment contract (T1.13b: secret lifecycle pure contract)', () => {
  it('CROSS_LAN_ENROLLMENT_SECRET_POLICY: exact 11 keys, deep-frozen, uses/destinations', () => {
    const policy = enrollment.CROSS_LAN_ENROLLMENT_SECRET_POLICY;
    assert.deepStrictEqual(policy, EXPECTED_SECRET_POLICY);
    assert.strictEqual(Object.keys(policy).length, 11);
    assert.deepStrictEqual(Object.keys(policy).sort(), Object.keys(EXPECTED_SECRET_POLICY).sort());
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.allowedUses));
    assert.ok(Object.isFrozen(policy.forbiddenUses));
    assert.ok(Object.isFrozen(policy.forbiddenDestinations));
    assert.deepStrictEqual(policy.allowedUses, ['enrollment-code-hmac-digest']);
    assert.ok(policy.forbiddenUses.includes('device-authentication'));
    assert.ok(policy.forbiddenDestinations.includes('logs'));
    assert.ok(policy.forbiddenDestinations.includes('plaintext-transport'));
    assert.strictEqual(policy.implementationStage, 'contract-only-no-keychain-io');
    assert.strictEqual(policy.manualBootstrapAllowed, false);
    assert.strictEqual(policy.plaintextExportAllowed, false);
  });

  it('decideCrossLanEnrollmentSecretBootstrap: six valid combinations; initialized+missing never bootstraps', () => {
    const decide = enrollment.decideCrossLanEnrollmentSecretBootstrap;

    const boot = decide({
      controllerInitializationState: 'authoritatively-uninitialized',
      keychainItemState: 'missing',
    });
    assertExactFrozenKeys(boot, BOOTSTRAP_RESULT_KEYS);
    assert.strictEqual(boot.status, 'bootstrap-required');
    assert.strictEqual(boot.errorCode, null);
    assert.strictEqual(boot.bootstrapRequired, true);
    assert.strictEqual(boot.generateSecretByteLength, 32);
    assert.strictEqual(boot.writeDedicatedKeychainItem, true);
    assert.strictEqual(boot.setSecretVersion, 1);
    assert.strictEqual(boot.issueNewCodes, false);
    assert.strictEqual(boot.verifyNewCodes, false);
    assert.strictEqual(boot.existingFleetCanContinue, false);
    assert.strictEqual(boot.manualRegenerateRequired, false);
    assert.strictEqual(boot.requiresFleetReenrollment, false);

    const ready = decide({
      controllerInitializationState: 'initialized',
      keychainItemState: 'readable',
    });
    assertExactFrozenKeys(ready, BOOTSTRAP_RESULT_KEYS);
    assert.strictEqual(ready.status, 'ready');
    assert.strictEqual(ready.errorCode, null);
    assert.strictEqual(ready.bootstrapRequired, false);
    assert.strictEqual(ready.generateSecretByteLength, null);
    assert.strictEqual(ready.writeDedicatedKeychainItem, false);
    assert.strictEqual(ready.setSecretVersion, null);
    assert.strictEqual(ready.issueNewCodes, true);
    assert.strictEqual(ready.verifyNewCodes, true);
    assert.strictEqual(ready.existingFleetCanContinue, true);
    assert.strictEqual(ready.manualRegenerateRequired, false);
    assert.strictEqual(ready.requiresFleetReenrollment, false);

    for (const keyState of ['missing', 'unreadable']) {
      const unavail = decide({
        controllerInitializationState: 'initialized',
        keychainItemState: keyState,
      });
      assertExactFrozenKeys(unavail, BOOTSTRAP_RESULT_KEYS);
      assert.strictEqual(unavail.status, 'unavailable');
      assert.strictEqual(unavail.errorCode, 'enrollment-secret-unavailable');
      assert.strictEqual(unavail.bootstrapRequired, false);
      assert.strictEqual(unavail.generateSecretByteLength, null);
      assert.strictEqual(unavail.writeDedicatedKeychainItem, false);
      assert.strictEqual(unavail.setSecretVersion, null);
      assert.strictEqual(unavail.issueNewCodes, false);
      assert.strictEqual(unavail.verifyNewCodes, false);
      assert.strictEqual(unavail.existingFleetCanContinue, true);
      assert.strictEqual(unavail.manualRegenerateRequired, true);
      assert.strictEqual(unavail.requiresFleetReenrollment, false);
      // Critical: never silent bootstrap when already initialized.
      assert.notStrictEqual(unavail.status, 'bootstrap-required');
    }

    for (const keyState of ['readable', 'unreadable']) {
      const illegal = decide({
        controllerInitializationState: 'authoritatively-uninitialized',
        keychainItemState: keyState,
      });
      assertExactFrozenKeys(illegal, BOOTSTRAP_RESULT_KEYS);
      assert.strictEqual(illegal.status, 'unavailable');
      assert.strictEqual(illegal.errorCode, 'enrollment-secret-unavailable');
      assert.strictEqual(illegal.bootstrapRequired, false);
      assert.strictEqual(illegal.writeDedicatedKeychainItem, false);
      assert.strictEqual(illegal.issueNewCodes, false);
      assert.strictEqual(illegal.verifyNewCodes, false);
      assert.strictEqual(illegal.existingFleetCanContinue, false);
      assert.strictEqual(illegal.manualRegenerateRequired, false);
      assert.strictEqual(illegal.requiresFleetReenrollment, false);
    }

    // Ordinary object and null-prototype accepted when exact.
    const fromNullProto = decide(
      Object.assign(Object.create(null), {
        controllerInitializationState: 'initialized',
        keychainItemState: 'readable',
      }),
    );
    assert.strictEqual(fromNullProto.status, 'ready');
    const frozenIn = Object.freeze({
      controllerInitializationState: 'initialized',
      keychainItemState: 'readable',
    });
    assert.strictEqual(decide(frozenIn).status, 'ready');
  });

  it('decideCrossLanEnrollmentSecretBootstrap: invalid shape/accessor/proxy/null/class → unavailable, no throw', () => {
    const decide = enrollment.decideCrossLanEnrollmentSecretBootstrap;

    /** @param {unknown} input */
    function assertUnavailableClosed(input) {
      assert.doesNotThrow(() => {
        const r = decide(input);
        assertExactFrozenKeys(r, BOOTSTRAP_RESULT_KEYS);
        assert.strictEqual(r.status, 'unavailable');
        assert.strictEqual(r.errorCode, 'enrollment-secret-unavailable');
        assert.strictEqual(r.bootstrapRequired, false);
        assert.strictEqual(r.generateSecretByteLength, null);
        assert.strictEqual(r.writeDedicatedKeychainItem, false);
        assert.strictEqual(r.setSecretVersion, null);
        assert.strictEqual(r.issueNewCodes, false);
        assert.strictEqual(r.verifyNewCodes, false);
        assert.strictEqual(r.existingFleetCanContinue, false);
        assert.strictEqual(r.manualRegenerateRequired, false);
        assert.strictEqual(r.requiresFleetReenrollment, false);
      });
    }

    assertUnavailableClosed(null);
    assertUnavailableClosed(undefined);
    assertUnavailableClosed('authoritatively-uninitialized');
    assertUnavailableClosed([]);
    assertUnavailableClosed(new Date());
    class BootCls {
      constructor() {
        this.controllerInitializationState = 'authoritatively-uninitialized';
        this.keychainItemState = 'missing';
      }
    }
    assertUnavailableClosed(new BootCls());
    // first-start is not authoritative — must not bootstrap.
    assertUnavailableClosed({
      controllerInitializationState: 'first-start',
      keychainItemState: 'missing',
    });
    assertUnavailableClosed({
      controllerInitializationState: 'authoritatively-uninitialized',
      keychainItemState: 'missing',
      extra: true,
    });
    assertUnavailableClosed({
      controllerInitializationState: 'authoritatively-uninitialized',
    });
    const withAccessor = {};
    Object.defineProperty(withAccessor, 'controllerInitializationState', {
      enumerable: true,
      get: () => 'authoritatively-uninitialized',
    });
    Object.defineProperty(withAccessor, 'keychainItemState', {
      enumerable: true,
      value: 'missing',
      writable: true,
      configurable: true,
    });
    assertUnavailableClosed(withAccessor);
    const withNonEnum = {
      controllerInitializationState: 'authoritatively-uninitialized',
      keychainItemState: 'missing',
    };
    Object.defineProperty(withNonEnum, 'hidden', {
      enumerable: false,
      value: 1,
    });
    assertUnavailableClosed(withNonEnum);
    const withSymbol = {
      controllerInitializationState: 'authoritatively-uninitialized',
      keychainItemState: 'missing',
      [Symbol('x')]: 1,
    };
    assertUnavailableClosed(withSymbol);
    const proxy = new Proxy(
      {
        controllerInitializationState: 'authoritatively-uninitialized',
        keychainItemState: 'missing',
      },
      {
        get() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    assertUnavailableClosed(proxy);
    // Ordinary first-start string must never unlock bootstrap.
    const notAuth = decide({
      controllerInitializationState: 'first-start',
      keychainItemState: 'missing',
    });
    assert.notStrictEqual(notAuth.status, 'bootstrap-required');
  });

  it('authorizeCrossLanEnrollmentSecretRotation: success + fail-closed paths; frozen', () => {
    const authorize = enrollment.authorizeCrossLanEnrollmentSecretRotation;

    for (const reason of ['rotation', 'loss']) {
      const ok = authorize({
        explicitAdminRequested: true,
        currentSecretVersion: 3,
        reason,
      });
      assertExactFrozenKeys(ok, AUTH_RESULT_KEYS);
      assert.strictEqual(ok.authorized, true);
      assert.strictEqual(ok.reasonCode, null);
      assert.strictEqual(ok.reason, reason);
      assert.strictEqual(ok.currentSecretVersion, 3);
      assert.strictEqual(ok.nextSecretVersionIfCommitted, 4);
      assert.strictEqual(ok.generateSecretByteLength, 32);
      assert.strictEqual(ok.writeKeychainBeforeVersionAdvance, true);
      assert.strictEqual(ok.versionAdvanced, false);
    }

    /** @param {unknown} input @param {string} code */
    function assertDenied(input, code) {
      assert.doesNotThrow(() => {
        const r = authorize(input);
        assertExactFrozenKeys(r, AUTH_RESULT_KEYS);
        assert.strictEqual(r.authorized, false);
        assert.strictEqual(r.reasonCode, code);
        assert.strictEqual(r.nextSecretVersionIfCommitted, null);
        assert.strictEqual(r.generateSecretByteLength, null);
        assert.strictEqual(r.writeKeychainBeforeVersionAdvance, false);
        assert.strictEqual(r.versionAdvanced, false);
      });
    }

    assertDenied(
      {
        explicitAdminRequested: false,
        currentSecretVersion: 1,
        reason: 'rotation',
      },
      'not-explicit',
    );
    // loss still requires explicit admin.
    assertDenied(
      {
        explicitAdminRequested: false,
        currentSecretVersion: 1,
        reason: 'loss',
      },
      'not-explicit',
    );
    assertDenied(
      {
        explicitAdminRequested: true,
        currentSecretVersion: 0,
        reason: 'rotation',
      },
      'invalid-version',
    );
    assertDenied(
      {
        explicitAdminRequested: true,
        currentSecretVersion: 1.5,
        reason: 'rotation',
      },
      'invalid-version',
    );
    assertDenied(
      {
        explicitAdminRequested: true,
        currentSecretVersion: Number.MAX_SAFE_INTEGER + 1,
        reason: 'rotation',
      },
      'invalid-version',
    );
    assertDenied(
      {
        explicitAdminRequested: true,
        currentSecretVersion: -1,
        reason: 'rotation',
      },
      'invalid-version',
    );
    assertDenied(
      {
        explicitAdminRequested: true,
        currentSecretVersion: Number.MAX_SAFE_INTEGER,
        reason: 'rotation',
      },
      'version-exhausted',
    );
    assertDenied(null, 'invalid-input');
    assertDenied(
      {
        explicitAdminRequested: true,
        currentSecretVersion: 1,
        reason: 'other',
      },
      'invalid-input',
    );
    assertDenied(
      {
        explicitAdminRequested: true,
        currentSecretVersion: 1,
        reason: 'rotation',
        extra: 1,
      },
      'invalid-input',
    );
    assertDenied(
      {
        explicitAdminRequested: 'true',
        currentSecretVersion: 1,
        reason: 'rotation',
      },
      'invalid-input',
    );
  });

  it('commitCrossLanEnrollmentSecretRotation: success exact semantics; no fleet re-enroll', () => {
    const authorize = enrollment.authorizeCrossLanEnrollmentSecretRotation;
    const commit = enrollment.commitCrossLanEnrollmentSecretRotation;

    for (const reason of ['rotation', 'loss']) {
      const auth = authorize({
        explicitAdminRequested: true,
        currentSecretVersion: 7,
        reason,
      });
      // Structural plan only — not a capability object.
      const plan = {
        authorized: true,
        reasonCode: null,
        reason,
        currentSecretVersion: 7,
        nextSecretVersionIfCommitted: 8,
        generateSecretByteLength: 32,
        writeKeychainBeforeVersionAdvance: true,
        versionAdvanced: false,
      };
      const ok = commit({
        authorization: plan,
        keychainWriteSucceeded: true,
        observedCurrentSecretVersion: 7,
      });
      assertExactFrozenKeys(ok, COMMIT_RESULT_KEYS);
      assert.strictEqual(ok.committed, true);
      assert.strictEqual(ok.reasonCode, null);
      assert.strictEqual(ok.nextSecretVersion, 8);
      assert.strictEqual(ok.versionAdvanced, true);
      assert.strictEqual(ok.invalidatePriorUnconsumedCodes, true);
      assert.strictEqual(ok.invalidatePriorTombstoneNamespace, true);
      assert.strictEqual(ok.oldCodeErrorCode, 'enrollment-code-unknown-or-expired');
      assert.strictEqual(ok.existingFleetCanContinue, true);
      assert.strictEqual(ok.requiresFleetReenrollment, false);
      // Original authorize output also accepted structurally (same shape).
      const ok2 = commit({
        authorization: auth,
        keychainWriteSucceeded: true,
        observedCurrentSecretVersion: 7,
      });
      assert.strictEqual(ok2.committed, true);
      assert.strictEqual(ok2.requiresFleetReenrollment, false);
    }
  });

  it('commitCrossLanEnrollmentSecretRotation: write fail / mismatch / no auth / forged / invalid → no advance', () => {
    const commit = enrollment.commitCrossLanEnrollmentSecretRotation;
    const goodAuth = {
      authorized: true,
      reasonCode: null,
      reason: 'rotation',
      currentSecretVersion: 2,
      nextSecretVersionIfCommitted: 3,
      generateSecretByteLength: 32,
      writeKeychainBeforeVersionAdvance: true,
      versionAdvanced: false,
    };

    /** @param {unknown} input @param {string} code @param {{ fleet?: boolean }} [opts] */
    function assertNotCommitted(input, code, opts = {}) {
      assert.doesNotThrow(() => {
        const r = commit(input);
        assertExactFrozenKeys(r, COMMIT_RESULT_KEYS);
        assert.strictEqual(r.committed, false);
        assert.strictEqual(r.reasonCode, code);
        assert.strictEqual(r.nextSecretVersion, null);
        assert.strictEqual(r.versionAdvanced, false);
        assert.strictEqual(r.invalidatePriorUnconsumedCodes, false);
        assert.strictEqual(r.invalidatePriorTombstoneNamespace, false);
        assert.strictEqual(r.oldCodeErrorCode, null);
        assert.strictEqual(r.requiresFleetReenrollment, false);
        if (opts.fleet === true) {
          assert.strictEqual(r.existingFleetCanContinue, true);
        } else if (opts.fleet === false) {
          assert.strictEqual(r.existingFleetCanContinue, false);
        }
      });
    }

    assertNotCommitted(
      {
        authorization: goodAuth,
        keychainWriteSucceeded: false,
        observedCurrentSecretVersion: 2,
      },
      'write-failed',
      { fleet: true },
    );
    assertNotCommitted(
      {
        authorization: goodAuth,
        keychainWriteSucceeded: true,
        observedCurrentSecretVersion: 1,
      },
      'version-mismatch',
      { fleet: true },
    );
    assertNotCommitted(
      {
        authorization: {
          ...goodAuth,
          authorized: false,
          reasonCode: 'not-explicit',
          nextSecretVersionIfCommitted: null,
          generateSecretByteLength: null,
          writeKeychainBeforeVersionAdvance: false,
        },
        keychainWriteSucceeded: true,
        observedCurrentSecretVersion: 2,
      },
      'no-authorization',
      { fleet: false },
    );
    // Forged invariants (wrong next, generate, versionAdvanced).
    assertNotCommitted(
      {
        authorization: { ...goodAuth, nextSecretVersionIfCommitted: 99 },
        keychainWriteSucceeded: true,
        observedCurrentSecretVersion: 2,
      },
      'no-authorization',
      { fleet: false },
    );
    assertNotCommitted(
      {
        authorization: { ...goodAuth, generateSecretByteLength: 16 },
        keychainWriteSucceeded: true,
        observedCurrentSecretVersion: 2,
      },
      'no-authorization',
      { fleet: false },
    );
    assertNotCommitted(
      {
        authorization: { ...goodAuth, versionAdvanced: true },
        keychainWriteSucceeded: true,
        observedCurrentSecretVersion: 2,
      },
      'no-authorization',
      { fleet: false },
    );
    assertNotCommitted(
      {
        authorization: { ...goodAuth, writeKeychainBeforeVersionAdvance: false },
        keychainWriteSucceeded: true,
        observedCurrentSecretVersion: 2,
      },
      'no-authorization',
      { fleet: false },
    );
    assertNotCommitted(null, 'invalid-input', { fleet: false });
    assertNotCommitted(
      {
        authorization: goodAuth,
        keychainWriteSucceeded: true,
        observedCurrentSecretVersion: 2,
        extra: 1,
      },
      'invalid-input',
      { fleet: false },
    );
    assertNotCommitted(
      {
        authorization: goodAuth,
        keychainWriteSucceeded: 'yes',
        observedCurrentSecretVersion: 2,
      },
      'invalid-input',
      { fleet: false },
    );
    // Observed version must be a positive safe integer; not version-mismatch.
    for (const badObserved of [
      NaN,
      Infinity,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assertNotCommitted(
        {
          authorization: goodAuth,
          keychainWriteSucceeded: true,
          observedCurrentSecretVersion: badObserved,
        },
        'invalid-input',
        { fleet: false },
      );
    }
    const accessorAuth = {};
    for (const [k, v] of Object.entries(goodAuth)) {
      Object.defineProperty(accessorAuth, k, {
        enumerable: true,
        get: () => v,
      });
    }
    assertNotCommitted(
      {
        authorization: accessorAuth,
        keychainWriteSucceeded: true,
        observedCurrentSecretVersion: 2,
      },
      'no-authorization',
      { fleet: false },
    );
  });

  it('T1.13b honesty: pure contract only — no Keychain/CSPRNG/HMAC runtime claims', () => {
    // Exports exist as pure planners; module must not imply runtime I/O.
    assert.strictEqual(typeof enrollment.decideCrossLanEnrollmentSecretBootstrap, 'function');
    assert.strictEqual(typeof enrollment.authorizeCrossLanEnrollmentSecretRotation, 'function');
    assert.strictEqual(typeof enrollment.commitCrossLanEnrollmentSecretRotation, 'function');
    assert.strictEqual(
      enrollment.CROSS_LAN_ENROLLMENT_SECRET_POLICY.implementationStage,
      'contract-only-no-keychain-io',
    );
    // No secret bytes generated by authorize/commit plan path.
    const auth = enrollment.authorizeCrossLanEnrollmentSecretRotation({
      explicitAdminRequested: true,
      currentSecretVersion: 1,
      reason: 'rotation',
    });
    assert.strictEqual(auth.versionAdvanced, false);
    assert.strictEqual(Object.hasOwn(auth, 'secretBytes'), false);
    const committed = enrollment.commitCrossLanEnrollmentSecretRotation({
      authorization: auth,
      keychainWriteSucceeded: true,
      observedCurrentSecretVersion: 1,
    });
    assert.strictEqual(Object.hasOwn(committed, 'secretBytes'), false);
    assert.strictEqual(Object.hasOwn(committed, 'hmac'), false);
  });
});
