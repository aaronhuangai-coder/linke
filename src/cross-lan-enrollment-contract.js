/**
 * Cross-LAN enrollment contract — code representation/policy, digest-record
 * field allowlist, fixed-length constant-time digest compare, and tombstone FSM
 * (T1.13a / §6.3.1–§6.3.3).
 *
 * --- honesty (Gold ADR §6.5) ---
 * [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * [scope] T1.13a only —
 *   code policy constants,
 *   digest-record field allowlist,
 *   canonical code-shape validator,
 *   timingSafeEqual digest compare,
 *   tombstone FSM
 * [not ready] T1.13 complete = NOT COMPLETE; A25 = NOT READY
 *   T1.13b (secret bootstrap / Keychain / rotate) = NOT COMPLETE
 *   T1.13c (code delivery: clipboard / QR / UI) = NOT COMPLETE
 *
 * This module does **not** generate codes/salts, compute HMAC, read secrets,
 * write storage/Keychain, bootstrap/rotate secrets, or deliver codes
 * (clipboard/QR/UI). Policy numeric constants do **not** prove CSPRNG quality,
 * HMAC correctness, or durable storage.
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
 * `initialSecretVersion` is intentionally absent (owned by T1.13b).
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
