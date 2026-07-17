/**
 * Honesty scope (Gold ADR §6.5): T1.13 M1 contract slices (a+b+c).
 * Covers code policy / digest-record / canonical validator /
 * timingSafeEqual / tombstone FSM / secret lifecycle pure contract /
 * delivery pure contract (display plan / clipboard plan / QR shape).
 * T1.0 Noise library gate = BLOCKED (not M1 crypto PASS).
 * T1.13 M1 contract coverage = COMPLETE (contract task only).
 * T1.13 runtime delivery / Keychain / CSPRNG / HMAC = NOT IMPLEMENTED.
 * A25 runtime = NOT READY.
 * Pure contract only — does NOT prove real UI/CLI/clipboard/QR I/O,
 * Keychain, CSPRNG, HMAC, or durable storage.
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

// ---------------------------------------------------------------------------
// T1.13c — delivery pure contract (display / clipboard / QR shape only)
// ---------------------------------------------------------------------------

/** Independent literal pin of delivery policy (14 keys; object literal is authoritative). */
const EXPECTED_DELIVERY_POLICY = {
  displayTransportBindings: ['verified-loopback', 'same-process-cli'],
  intendedMaximumPlaintextDisplays: 1,
  atomicConsumeEnforcement: 'deferred-to-M3-single-writer-state',
  plaintextPersistenceAllowed: false,
  forbiddenPlaintextDestinations: [
    'dataDir',
    'logs',
    'audit',
    'crash-report',
    'evidence',
    'remote-management',
    'non-loopback-interface',
  ],
  automaticClipboardCopyAllowed: false,
  clipboardRequiresExplicitUserAction: true,
  clipboardRiskWarningRequired: true,
  clipboardClearingPromise: 'advisory-only',
  qrSchemaIdentifier: 'enrollmentQr/v1',
  qrEccPolicy: 'implementation-selected',
  qrEccValidationStage: 'not-in-M1',
  implementationStage: 'contract-only-no-delivery-io',
  a25RuntimeStatus: 'not-ready',
};

const EXPECTED_DISPLAY_TRANSITIONS = {
  undelivered: {
    'verified-loopback': 'delivered',
    'same-process-cli': 'delivered',
  },
  delivered: {},
};

const DISPLAY_RESULT_KEYS = [
  'status',
  'reasonCode',
  'displayReceiptState',
  'nextDisplayState',
  'plaintextPersistenceAllowed',
  'automaticClipboardWriteAllowed',
  'enforcementNote',
];

const CLIPBOARD_RESULT_KEYS = [
  'status',
  'reasonCode',
  'clipboardWriteAllowed',
  'automaticCopyAllowed',
  'clearingAdvisoryOnly',
  'implementationStage',
];

const EXPECTED_QR_SCHEMA = {
  identifier: 'enrollmentQr/v1',
  topLevelFields: [
    'schema',
    'codeId',
    'code',
    'expiry',
    'controllerPublicMetadata',
    'relayPublicMetadata',
  ],
  topLevelFieldNamesStatus: 'implementation-stable-not-spec-frozen',
  nestedWireSchemaStatus: 'deferred-to-M2',
  valueProvenanceValidationStage: 'deferred-to-M3-A25-runtime',
  eccValidationStage: 'not-in-M1',
  shapeMatcherLimit: 'does-not-detect-secrets-embedded-in-public-string-values',
};

/** Canonical 16B zero code for QR fixtures (not a real secret). */
const CANONICAL_CODE = 'AAAAAAAAAAAAAAAAAAAAAA';

const FORBIDDEN_SECRET_OUTPUT_FIELDS = [
  'code',
  'plaintext',
  'secret',
  'secretBytes',
  'hmac',
  'enrollmentHmacSecret',
  'privateKey',
  'deviceToken',
  'proxyAuthorizationSecret',
  'sessionKey',
];

/**
 * @param {object} result
 */
function assertNoSecretFields(result) {
  for (const name of FORBIDDEN_SECRET_OUTPUT_FIELDS) {
    assert.strictEqual(Object.hasOwn(result, name), false, `must not expose ${name}`);
  }
}

/**
 * Structurally valid allow-display-plan (fresh plain object).
 * @returns {object}
 */
function makeAllowDisplayPlan() {
  return {
    status: 'allow-display-plan',
    reasonCode: null,
    displayReceiptState: 'display-authorized',
    nextDisplayState: 'delivered',
    plaintextPersistenceAllowed: false,
    automaticClipboardWriteAllowed: false,
    enforcementNote: 'atomic-consume-deferred-to-M3',
  };
}

/**
 * Minimal valid QR payload fixture.
 * @param {Partial<object>} [overrides]
 */
function makeValidQrPayload(overrides = {}) {
  return {
    schema: 'enrollmentQr/v1',
    codeId: 'code-id-1',
    code: CANONICAL_CODE,
    expiry: '2026-01-01T00:00:00.000Z',
    controllerPublicMetadata: { identityDigest: 'public-digest' },
    relayPublicMetadata: {},
    ...overrides,
  };
}

describe('cross-lan enrollment contract (T1.13c: delivery pure contract)', () => {
  it('DELIVERY_POLICY exact 14 + deep freeze; DISPLAY_TRANSITIONS exact/deep freeze/no back edge', () => {
    const policy = enrollment.CROSS_LAN_ENROLLMENT_DELIVERY_POLICY;
    assert.deepStrictEqual(policy, EXPECTED_DELIVERY_POLICY);
    assert.strictEqual(Object.keys(policy).length, 14);
    assert.deepStrictEqual(Object.keys(policy).sort(), Object.keys(EXPECTED_DELIVERY_POLICY).sort());
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.displayTransportBindings));
    assert.ok(Object.isFrozen(policy.forbiddenPlaintextDestinations));
    assert.strictEqual(policy.implementationStage, 'contract-only-no-delivery-io');
    assert.strictEqual(policy.a25RuntimeStatus, 'not-ready');
    assert.strictEqual(policy.plaintextPersistenceAllowed, false);
    assert.strictEqual(policy.automaticClipboardCopyAllowed, false);
    assert.strictEqual(policy.clipboardClearingPromise, 'advisory-only');

    const fsm = enrollment.CROSS_LAN_ENROLLMENT_DISPLAY_TRANSITIONS;
    assert.deepStrictEqual(fsm, EXPECTED_DISPLAY_TRANSITIONS);
    assert.ok(Object.isFrozen(fsm));
    assert.ok(Object.isFrozen(fsm.undelivered));
    assert.ok(Object.isFrozen(fsm.delivered));
    assert.deepStrictEqual(Object.keys(fsm.delivered), []);
    for (const state of Object.keys(fsm)) {
      for (const binding of Object.keys(fsm[state])) {
        assert.notStrictEqual(
          fsm[state][binding],
          'undelivered',
          `no path back to undelivered: ${state}/${binding}`,
        );
      }
    }
  });

  it('display plan: two bindings allow; delivered/null/legacy/invalid blocked; exact frozen no secrets', () => {
    const decide = enrollment.decideCrossLanEnrollmentDisplayPlan;

    for (const binding of ['verified-loopback', 'same-process-cli']) {
      const allow = decide({
        transportBinding: binding,
        priorDisplayState: 'undelivered',
      });
      assertExactFrozenKeys(allow, DISPLAY_RESULT_KEYS);
      assert.strictEqual(allow.status, 'allow-display-plan');
      assert.strictEqual(allow.reasonCode, null);
      assert.strictEqual(allow.displayReceiptState, 'display-authorized');
      assert.strictEqual(allow.nextDisplayState, 'delivered');
      assert.strictEqual(allow.plaintextPersistenceAllowed, false);
      assert.strictEqual(allow.automaticClipboardWriteAllowed, false);
      assert.strictEqual(allow.enforcementNote, 'atomic-consume-deferred-to-M3');
      assertNoSecretFields(allow);
    }

    /** @param {unknown} input @param {string} code */
    function assertBlocked(input, code) {
      assert.doesNotThrow(() => {
        const r = decide(input);
        assertExactFrozenKeys(r, DISPLAY_RESULT_KEYS);
        assert.strictEqual(r.status, 'blocked');
        assert.strictEqual(r.reasonCode, code);
        assert.strictEqual(r.displayReceiptState, 'not-authorized');
        assert.strictEqual(r.nextDisplayState, null);
        assert.strictEqual(r.plaintextPersistenceAllowed, false);
        assert.strictEqual(r.automaticClipboardWriteAllowed, false);
        assert.strictEqual(r.enforcementNote, 'atomic-consume-deferred-to-M3');
        assertNoSecretFields(r);
      });
    }

    // already-delivered wins over binding null.
    assertBlocked(
      { transportBinding: null, priorDisplayState: 'delivered' },
      'already-delivered',
    );
    assertBlocked(
      { transportBinding: 'verified-loopback', priorDisplayState: 'delivered' },
      'already-delivered',
    );
    assertBlocked(
      { transportBinding: null, priorDisplayState: 'undelivered' },
      'transport-not-verified',
    );

    // null state / unknown enum / exact-schema violations → invalid-input.
    assertBlocked(
      { transportBinding: 'verified-loopback', priorDisplayState: null },
      'invalid-input',
    );
    assertBlocked(
      { transportBinding: 'other', priorDisplayState: 'undelivered' },
      'invalid-input',
    );
    assertBlocked(
      { transportBinding: 'verified-loopback', priorDisplayState: 'pending' },
      'invalid-input',
    );
    // Legacy fields must fail exact schema (not channel/loopbackVerified/priorDisplayCount).
    assertBlocked(
      { channel: 'cli', priorDisplayState: 'undelivered' },
      'invalid-input',
    );
    assertBlocked(
      {
        transportBinding: 'verified-loopback',
        priorDisplayState: 'undelivered',
        loopbackVerified: true,
      },
      'invalid-input',
    );
    assertBlocked(
      {
        transportBinding: 'verified-loopback',
        priorDisplayState: 'undelivered',
        priorDisplayCount: 0,
      },
      'invalid-input',
    );
    assertBlocked(
      {
        transportBinding: 'verified-loopback',
        priorDisplayState: 'undelivered',
        code: CANONICAL_CODE,
      },
      'invalid-input',
    );
    assertBlocked(null, 'invalid-input');
    assertBlocked(undefined, 'invalid-input');
    assertBlocked([], 'invalid-input');
    class DisplayCls {
      constructor() {
        this.transportBinding = 'verified-loopback';
        this.priorDisplayState = 'undelivered';
      }
    }
    assertBlocked(new DisplayCls(), 'invalid-input');

    const withAccessor = {};
    Object.defineProperty(withAccessor, 'transportBinding', {
      enumerable: true,
      get: () => 'verified-loopback',
    });
    Object.defineProperty(withAccessor, 'priorDisplayState', {
      enumerable: true,
      value: 'undelivered',
      writable: true,
      configurable: true,
    });
    assertBlocked(withAccessor, 'invalid-input');

    const withSymbol = {
      transportBinding: 'verified-loopback',
      priorDisplayState: 'undelivered',
      [Symbol('x')]: 1,
    };
    assertBlocked(withSymbol, 'invalid-input');

    const proxy = new Proxy(
      {
        transportBinding: 'verified-loopback',
        priorDisplayState: 'undelivered',
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
    assertBlocked(proxy, 'invalid-input');

    const target = {
      transportBinding: 'verified-loopback',
      priorDisplayState: 'undelivered',
    };
    const revoked = Proxy.revocable(target, {});
    revoked.revoke();
    assertBlocked(revoked.proxy, 'invalid-input');

    // null-prototype exact record still allowed when valid.
    const fromNull = decide(
      Object.assign(Object.create(null), {
        transportBinding: 'same-process-cli',
        priorDisplayState: 'undelivered',
      }),
    );
    assert.strictEqual(fromNull.status, 'allow-display-plan');
  });

  it('clipboard plan: structured allow display + warning + user action only; no plaintext', () => {
    const decide = enrollment.decideCrossLanEnrollmentClipboardPlan;

    const allow = decide({
      displayPlan: makeAllowDisplayPlan(),
      riskWarningDisplayed: true,
      userInitiatedAction: true,
    });
    assertExactFrozenKeys(allow, CLIPBOARD_RESULT_KEYS);
    assert.strictEqual(allow.status, 'allow-manual-clipboard-write');
    assert.strictEqual(allow.reasonCode, null);
    assert.strictEqual(allow.clipboardWriteAllowed, true);
    assert.strictEqual(allow.automaticCopyAllowed, false);
    assert.strictEqual(allow.clearingAdvisoryOnly, true);
    assert.strictEqual(allow.implementationStage, 'contract-only-no-clipboard-io');
    assertNoSecretFields(allow);

    // Real decide() output accepted structurally.
    const displayPlan = enrollment.decideCrossLanEnrollmentDisplayPlan({
      transportBinding: 'verified-loopback',
      priorDisplayState: 'undelivered',
    });
    const allow2 = decide({
      displayPlan,
      riskWarningDisplayed: true,
      userInitiatedAction: true,
    });
    assert.strictEqual(allow2.status, 'allow-manual-clipboard-write');

    /** @param {unknown} input @param {string} code */
    function assertClipBlocked(input, code) {
      assert.doesNotThrow(() => {
        const r = decide(input);
        assertExactFrozenKeys(r, CLIPBOARD_RESULT_KEYS);
        assert.strictEqual(r.status, 'blocked');
        assert.strictEqual(r.reasonCode, code);
        assert.strictEqual(r.clipboardWriteAllowed, false);
        assert.strictEqual(r.automaticCopyAllowed, false);
        assert.strictEqual(r.clearingAdvisoryOnly, true);
        assert.strictEqual(r.implementationStage, 'contract-only-no-clipboard-io');
        assertNoSecretFields(r);
      });
    }

    assertClipBlocked(
      {
        displayPlan: {
          ...makeAllowDisplayPlan(),
          status: 'blocked',
          reasonCode: 'already-delivered',
          displayReceiptState: 'not-authorized',
          nextDisplayState: null,
        },
        riskWarningDisplayed: true,
        userInitiatedAction: true,
      },
      'no-authorized-display',
    );
    // Forged invariants (boolean flag only, wrong enforcement).
    assertClipBlocked(
      {
        displayPlan: {
          ...makeAllowDisplayPlan(),
          plaintextPersistenceAllowed: true,
        },
        riskWarningDisplayed: true,
        userInitiatedAction: true,
      },
      'no-authorized-display',
    );
    assertClipBlocked(
      {
        displayPlan: {
          displayAuthorized: true,
        },
        riskWarningDisplayed: true,
        userInitiatedAction: true,
      },
      'no-authorized-display',
    );
    assertClipBlocked(
      {
        displayPlan: makeAllowDisplayPlan(),
        riskWarningDisplayed: false,
        userInitiatedAction: true,
      },
      'risk-warning-not-displayed',
    );
    assertClipBlocked(
      {
        displayPlan: makeAllowDisplayPlan(),
        riskWarningDisplayed: true,
        userInitiatedAction: false,
      },
      'not-user-initiated',
    );
    // Non-boolean → invalid-input (not risk/user reason codes).
    assertClipBlocked(
      {
        displayPlan: makeAllowDisplayPlan(),
        riskWarningDisplayed: 'true',
        userInitiatedAction: true,
      },
      'invalid-input',
    );
    assertClipBlocked(
      {
        displayPlan: makeAllowDisplayPlan(),
        riskWarningDisplayed: true,
        userInitiatedAction: 1,
      },
      'invalid-input',
    );
    assertClipBlocked(null, 'invalid-input');
    assertClipBlocked(
      {
        displayPlan: makeAllowDisplayPlan(),
        riskWarningDisplayed: true,
        userInitiatedAction: true,
        code: CANONICAL_CODE,
      },
      'invalid-input',
    );
    const clipProxy = new Proxy(
      {
        displayPlan: makeAllowDisplayPlan(),
        riskWarningDisplayed: true,
        userInitiatedAction: true,
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
    assertClipBlocked(clipProxy, 'invalid-input');
  });

  it('CROSS_LAN_ENROLLMENT_QR_SCHEMA: exact 7 keys deep-frozen', () => {
    const schema = enrollment.CROSS_LAN_ENROLLMENT_QR_SCHEMA;
    assert.deepStrictEqual(schema, EXPECTED_QR_SCHEMA);
    assert.strictEqual(Object.keys(schema).length, 7);
    assert.ok(Object.isFrozen(schema));
    assert.ok(Object.isFrozen(schema.topLevelFields));
    assert.strictEqual(schema.identifier, 'enrollmentQr/v1');
    assert.strictEqual(schema.eccValidationStage, 'not-in-M1');
    assert.strictEqual(
      schema.shapeMatcherLimit,
      'does-not-detect-secrets-embedded-in-public-string-values',
    );
  });

  it('matchesCrossLanEnrollmentQrPayloadShape: valid synthetic fixtures (string/int expiry, empty relay)', () => {
    const match = enrollment.matchesCrossLanEnrollmentQrPayloadShape;
    assert.strictEqual(match(makeValidQrPayload()), true);
    assert.strictEqual(
      match(
        makeValidQrPayload({
          expiry: 1_700_000_000_000,
          relayPublicMetadata: { relayEndpoints: [], relayPinDigests: [] },
        }),
      ),
      true,
    );
    assert.strictEqual(
      match(
        Object.assign(Object.create(null), {
          schema: 'enrollmentQr/v1',
          codeId: 'id-2',
          code: '_____________________w',
          expiry: 0,
          controllerPublicMetadata: Object.assign(Object.create(null), {
            identityDigest: 'public-digest',
          }),
          relayPublicMetadata: Object.assign(Object.create(null), {}),
        }),
      ),
      true,
    );
    assert.strictEqual(
      match(
        makeValidQrPayload({
          controllerPublicMetadata: {
            nested: { a: true, b: null, c: [1, 'x', false] },
          },
        }),
      ),
      true,
    );
    assert.doesNotThrow(() => match(null));
  });

  it('matchesCrossLanEnrollmentQrPayloadShape: wrong schema/code/extra/forbidden/sparse/cycle/depth/proxy false', () => {
    const match = enrollment.matchesCrossLanEnrollmentQrPayloadShape;

    /** @param {unknown} payload */
    function assertFalse(payload) {
      assert.doesNotThrow(() => {
        assert.strictEqual(match(payload), false);
      });
    }

    assertFalse(makeValidQrPayload({ schema: 'enrollmentQr/v0' }));
    assertFalse(makeValidQrPayload({ code: 'AAAAAAAAAAAAAAAAAAAAAB' })); // non-canonical
    assertFalse(makeValidQrPayload({ code: 'short' }));
    assertFalse({
      ...makeValidQrPayload(),
      extra: true,
    });
    assertFalse(makeValidQrPayload({ expiry: -1 }));
    assertFalse(makeValidQrPayload({ expiry: 1.5 }));
    assertFalse(makeValidQrPayload({ expiry: '' }));
    assertFalse(makeValidQrPayload({ codeId: '' }));
    assertFalse(makeValidQrPayload({ controllerPublicMetadata: {} })); // empty forbidden
    assertFalse(
      makeValidQrPayload({
        controllerPublicMetadata: { enrollmentHmacSecret: 'x' },
      }),
    );
    assertFalse(
      makeValidQrPayload({
        relayPublicMetadata: { privateKey: 'x' },
      }),
    );
    assertFalse(
      makeValidQrPayload({
        controllerPublicMetadata: { nested: { deviceToken: 'x' } },
      }),
    );
    assertFalse(
      makeValidQrPayload({
        controllerPublicMetadata: { sessionKey: 'x' },
      }),
    );
    assertFalse(
      makeValidQrPayload({
        relayPublicMetadata: { proxyAuthorizationSecret: 'x' },
      }),
    );

    const withAccessor = makeValidQrPayload();
    Object.defineProperty(withAccessor, 'codeId', {
      enumerable: true,
      get: () => 'code-id-1',
    });
    assertFalse(withAccessor);

    const withSymbol = {
      ...makeValidQrPayload(),
      [Symbol('x')]: 1,
    };
    assertFalse(withSymbol);

    // Sparse array in nested metadata.
    const sparse = [];
    sparse[1] = 'x';
    assertFalse(
      makeValidQrPayload({
        controllerPublicMetadata: { identityDigest: 'd', holes: sparse },
      }),
    );

    // Cycle.
    const cycleMeta = { identityDigest: 'd' };
    cycleMeta.self = cycleMeta;
    assertFalse(makeValidQrPayload({ controllerPublicMetadata: cycleMeta }));

    // Too deep (max depth 4).
    assertFalse(
      makeValidQrPayload({
        controllerPublicMetadata: {
          a: { b: { c: { d: { e: 'too-deep' } } } },
        },
      }),
    );

    const qrProxy = new Proxy(makeValidQrPayload(), {
      get() {
        throw new Error('trap');
      },
      ownKeys() {
        throw new Error('trap');
      },
    });
    assertFalse(qrProxy);

    const rev = Proxy.revocable(makeValidQrPayload(), {});
    rev.revoke();
    assertFalse(rev.proxy);

    assertFalse(null);
    assertFalse(undefined);
    assertFalse([]);
    assertFalse('enrollmentQr/v1');
  });

  it('T1.13c honesty: M1 contract coverage complete; runtime delivery/A25 NOT READY', () => {
    assert.strictEqual(typeof enrollment.decideCrossLanEnrollmentDisplayPlan, 'function');
    assert.strictEqual(typeof enrollment.decideCrossLanEnrollmentClipboardPlan, 'function');
    assert.strictEqual(typeof enrollment.matchesCrossLanEnrollmentQrPayloadShape, 'function');
    assert.strictEqual(
      enrollment.CROSS_LAN_ENROLLMENT_DELIVERY_POLICY.implementationStage,
      'contract-only-no-delivery-io',
    );
    assert.strictEqual(
      enrollment.CROSS_LAN_ENROLLMENT_DELIVERY_POLICY.a25RuntimeStatus,
      'not-ready',
    );
    assert.strictEqual(
      enrollment.CROSS_LAN_ENROLLMENT_DELIVERY_POLICY.atomicConsumeEnforcement,
      'deferred-to-M3-single-writer-state',
    );
    // Plans never carry plaintext code fields.
    const d = enrollment.decideCrossLanEnrollmentDisplayPlan({
      transportBinding: 'verified-loopback',
      priorDisplayState: 'undelivered',
    });
    assertNoSecretFields(d);
    const c = enrollment.decideCrossLanEnrollmentClipboardPlan({
      displayPlan: d,
      riskWarningDisplayed: true,
      userInitiatedAction: true,
    });
    assertNoSecretFields(c);
    // Shape matcher only — does not generate QR images / I/O.
    assert.strictEqual(
      enrollment.CROSS_LAN_ENROLLMENT_QR_SCHEMA.eccValidationStage,
      'not-in-M1',
    );
  });
});
