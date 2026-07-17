/**
 * Honesty scope (Gold ADR §6.5): tests cover T1.13a only
 * (code policy / digest-record fields / canonical validator /
 * timingSafeEqual digest compare / tombstone FSM).
 * T1.0 Noise library gate = BLOCKED (not M1 crypto PASS).
 * T1.13 complete = NOT COMPLETE; A25 = NOT READY.
 * T1.13b (secret bootstrap/Keychain/rotate) and T1.13c (delivery)
 * are out of scope and not covered here.
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
