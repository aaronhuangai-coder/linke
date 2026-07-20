import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from '../src/error-codes.js';

/**
 * Closed-set pin of the entire public ERROR_CODES registry.
 * Count: 61 = existing 60 (V1.38) + 1 new V1.39 audit write-admission code.
 *
 * - AUDIT_CHAIN_BROKEN already existed in the 45-set (structure/JSON/seq/prev/link);
 *   it is NOT counted as a new registration in this bump.
 * - AUDIT_INTEGRITY_BOUNDS_EXCEEDED is lines/per-line only (NOT chain corruption;
 *   NOT file size / maxBytes — size overlimit maps to AUDIT_INTEGRITY_IO_ERROR).
 * - AUDIT_INTEGRITY_IO_ERROR covers root/read/write/permission/size maxBytes /
 *   other SafeDataFileError mappings.
 * - Cross-store size overlimit → AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR (≠ bounds).
 * - Cross-store relationship failure → AUDIT_INTEGRITY_CROSS_STORE_BROKEN
 *   (≠ AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID for newline/JSON/canonical).
 * - Dual-write size overlimit on *read* → AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR;
 *   publish preflight serialize >65536 → AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID
 *   (size≠bounds analogy preserved; dual-write has no bounds code).
 * - V1.39: AUDIT_DELIVERY_UNAVAILABLE only (write-admission fail-closed).
 */
const EXPECTED_ERROR_CODES = {
  // --- existing 17 (regression pin) ---
  AUTH_ADMIN_REQUIRED: 'auth-admin-required',
  DEVICE_ENROLLMENT_INVALID: 'device-enrollment-invalid',
  DEVICE_INTERNAL_ERROR: 'device-internal-error',
  DEVICE_NOT_FOUND: 'device-not-found',
  DEVICE_PROTOCOL_UNSUPPORTED: 'device-protocol-unsupported',
  DEVICE_RATE_LIMITED: 'device-rate-limited',
  DEVICE_REVOKED: 'device-revoked',
  DEVICE_ROUTE_NOT_FOUND: 'device-route-not-found',
  DEVICE_REQUEST_INVALID: 'device-request-invalid',
  DEVICE_SCOPE_MISMATCH: 'device-scope-mismatch',
  DEVICE_TOKEN_INVALID: 'device-token-invalid',
  DEVICE_TLS_BIND_INVALID: 'device-tls-bind-invalid',
  DEVICE_TLS_FINGERPRINT_MISMATCH: 'device-tls-fingerprint-mismatch',
  DEVICE_TLS_IDENTITY_INCOMPLETE: 'device-tls-identity-incomplete',
  DEVICE_TLS_SAN_MISMATCH: 'device-tls-san-mismatch',
  KEYCHAIN_ITEM_MISSING: 'keychain-item-missing',
  KEYCHAIN_UNAVAILABLE: 'keychain-unavailable',
  // --- prior 28 (T1.1 minus 2 overlaps) ---
  DEVICE_REPLAY_DETECTED: 'device-replay-detected',
  DEVICE_CLOCK_SKEW: 'device-clock-skew',
  DEVICE_COUNTER_ROLLBACK: 'device-counter-rollback',
  DEVICE_SESSION_LIMIT: 'device-session-limit',
  DEVICE_CLONE_SUSPECTED: 'device-clone-suspected',
  HANDSHAKE_IDENTITY_FAILED: 'handshake-identity-failed',
  PROTOCOL_DOWNGRADE_ATTEMPT: 'protocol-downgrade-attempt',
  E2EE_REQUIRED: 'e2ee-required',
  ENROLLMENT_RATE_LIMITED: 'enrollment-rate-limited',
  ENROLLMENT_CODE_UNKNOWN_OR_EXPIRED: 'enrollment-code-unknown-or-expired',
  ENROLLMENT_SECRET_UNAVAILABLE: 'enrollment-secret-unavailable',
  CONTROL_QUEUE_OVERFLOW: 'control-queue-overflow',
  STALE_EPOCH_REJECTED: 'stale-epoch-rejected',
  RELAY_CONNECT_FAILED: 'relay-connect-failed',
  PROXY_AUTH_FAILED: 'proxy-auth-failed',
  PROXY_CONNECT_FAILED: 'proxy-connect-failed',
  RELAY_TLS_PIN_MISMATCH: 'relay-tls-pin-mismatch',
  PROXY_TLS_INTERCEPTED: 'proxy-tls-intercepted',
  PROXY_UNSUPPORTED_AUTH: 'proxy-unsupported-auth',
  PROXY_PAC_UNSUPPORTED: 'proxy-pac-unsupported',
  PROXY_CHAIN_UNSUPPORTED: 'proxy-chain-unsupported',
  DATA_RESUME_EXHAUSTED: 'data-resume-exhausted',
  // Existing structure-chain code (already in 45; not a new integrity-journal code)
  AUDIT_CHAIN_BROKEN: 'audit-chain-broken',
  CONTROLLER_STATE_UNTRUSTED: 'controller-state-untrusted',
  REVOKE_PROPAGATION_DEGRADED: 'revoke-propagation-degraded',
  SESSION_KEEPALIVE_TIMEOUT: 'session-keepalive-timeout',
  EVIDENCE_ARTIFACT_MISSING: 'evidence-artifact-missing',
  EVIDENCE_ARTIFACT_DIGEST_MISMATCH: 'evidence-artifact-digest-mismatch',
  // --- new 6 (V1.35 audit integrity journal; chain-broken already above) ---
  // bounds: lines / per-line UTF-8 only — NEVER file size / maxBytes (that is io-error)
  AUDIT_INTEGRITY_BOUNDS_EXCEEDED: 'audit-integrity-bounds-exceeded',
  AUDIT_INTEGRITY_NOT_INITIALIZED: 'audit-integrity-not-initialized',
  AUDIT_INTEGRITY_ALREADY_INITIALIZED: 'audit-integrity-already-initialized',
  // io: size maxBytes overlimit + SafeDataFileError/root/read/write/permission
  AUDIT_INTEGRITY_IO_ERROR: 'audit-integrity-io-error',
  AUDIT_INTEGRITY_EVENT_INVALID: 'audit-integrity-event-invalid',
  AUDIT_INTEGRITY_GENERATION_ID_INVALID: 'audit-integrity-generation-id-invalid',
  // --- new 4 (V1.36 cross-store verifier; only these four are new in this bump) ---
  // broken: relationship 6/7 only — NOT event-invalid (newline/JSON/canonical)
  AUDIT_INTEGRITY_CROSS_STORE_BROKEN: 'audit-integrity-cross-store-broken',
  // io: events size maxBytes / root / permission / SafeDataFileError — NEVER bounds
  AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR: 'audit-integrity-cross-store-io-error',
  // bounds: events lines / per-line UTF-8 only — NEVER file size / maxBytes
  AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED: 'audit-integrity-cross-store-bounds-exceeded',
  // event-invalid: newline / interior blank / JSON / strict / raw canonical mismatch
  AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID: 'audit-integrity-cross-store-event-invalid',
  // --- new 5 (V1.37 dual-write state / coordinator; only these five are new in this bump) ---
  // state-invalid: schema/key order/types/regex/relationship; publish-preflight serialize >65536
  AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID: 'audit-integrity-dual-write-state-invalid',
  // io: state read size overlimit / SafeDataFileError / root / permission — NEVER state-invalid
  AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR: 'audit-integrity-dual-write-io-error',
  // recovery: prepared store other / irrepar partial / post-check mismatch
  AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT: 'audit-integrity-dual-write-recovery-conflict',
  // cursor: idle exists but stores ≠ cursor preimage (external mutation)
  AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH: 'audit-integrity-dual-write-cursor-mismatch',
  // gate: state path occupied → public journal-only init/append blocked
  AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED: 'audit-integrity-dual-write-direct-mutation-blocked',
  // --- new 1 (V1.39 write-admission fail-closed; only this code is new in this bump) ---
  AUDIT_DELIVERY_UNAVAILABLE: 'audit-delivery-unavailable',
};

const ERROR_CODE_PREFIX_PATTERN =
  /^(auth|device|upload|snapshot|smb|restore|retention|scheduler|lifecycle|keychain|audit|upgrade|handshake|protocol|e2ee|enrollment|control|stale|relay|proxy|data|controller|revoke|session|evidence)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

const NEW_INTEGRITY_JOURNAL_CODES = [
  ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED,
  ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED,
  ERROR_CODES.AUDIT_INTEGRITY_ALREADY_INITIALIZED,
  ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR,
  ERROR_CODES.AUDIT_INTEGRITY_EVENT_INVALID,
  ERROR_CODES.AUDIT_INTEGRITY_GENERATION_ID_INVALID,
];

const NEW_CROSS_STORE_CODES = [
  ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
  ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR,
  ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
  ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
];

const NEW_DUAL_WRITE_CODES = [
  ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
  ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
  ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT,
  ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH,
  ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
];

describe('Gold error-code registry', () => {
  it('matches the exact closed-set ERROR_CODES registry (61 entries = existing 60 + 1)', () => {
    assert.strictEqual(Object.keys(EXPECTED_ERROR_CODES).length, 61);
    assert.strictEqual(Object.keys(ERROR_CODES).length, 61);
    assert.deepStrictEqual(ERROR_CODES, EXPECTED_ERROR_CODES);
    // Existing chain-broken remains; bounds is independent of chain and of size io.
    assert.strictEqual(ERROR_CODES.AUDIT_CHAIN_BROKEN, 'audit-chain-broken');
    assert.notStrictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED,
      ERROR_CODES.AUDIT_CHAIN_BROKEN,
    );
    assert.notStrictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED,
      ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR,
    );
    // Cross-store size≠bounds; broken≠event-invalid (distinct codes and semantics).
    assert.notStrictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR,
    );
    assert.notStrictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN,
      'audit-integrity-cross-store-broken',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR,
      'audit-integrity-cross-store-io-error',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED,
      'audit-integrity-cross-store-bounds-exceeded',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID,
      'audit-integrity-cross-store-event-invalid',
    );
    // Dual-write five codes exact values + size-read≠publish-invalid split.
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
      'audit-integrity-dual-write-state-invalid',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
      'audit-integrity-dual-write-io-error',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT,
      'audit-integrity-dual-write-recovery-conflict',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH,
      'audit-integrity-dual-write-cursor-mismatch',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
      'audit-integrity-dual-write-direct-mutation-blocked',
    );
    assert.notStrictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
      ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR,
    );
    // V1.39 write-admission fail-closed code exact value.
    assert.strictEqual(
      ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE,
      'audit-delivery-unavailable',
    );
  });

  it('contains unique registered kebab-case codes', () => {
    assert.ok(Object.isFrozen(ERROR_CODES));
    const values = Object.values(ERROR_CODES);
    assert.strictEqual(new Set(values).size, values.length);
    assert.strictEqual(values.length, 61);
    for (const code of values) {
      assert.match(code, ERROR_CODE_PREFIX_PATTERN);
      assert.strictEqual(assertRegisteredErrorCode(code), code);
    }
  });

  it('registers the six new integrity-journal codes with LinkeError message===code', () => {
    assert.strictEqual(NEW_INTEGRITY_JOURNAL_CODES.length, 6);
    for (const code of NEW_INTEGRITY_JOURNAL_CODES) {
      assert.strictEqual(assertRegisteredErrorCode(code), code);
      const error = new LinkeError(code);
      assert.strictEqual(error.message, code);
      assert.strictEqual(error.code, code);
      assert.strictEqual(error.name, 'LinkeError');
    }
  });

  it('registers the four new cross-store codes with LinkeError message===code', () => {
    assert.strictEqual(NEW_CROSS_STORE_CODES.length, 4);
    for (const code of NEW_CROSS_STORE_CODES) {
      assert.strictEqual(assertRegisteredErrorCode(code), code);
      const error = new LinkeError(code);
      assert.strictEqual(error.message, code);
      assert.strictEqual(error.code, code);
      assert.strictEqual(error.name, 'LinkeError');
    }
    // size≠bounds and broken≠event-invalid locks (values unique among the four).
    assert.strictEqual(new Set(NEW_CROSS_STORE_CODES).size, 4);
  });

  it('registers the five new dual-write codes with LinkeError message===code', () => {
    assert.strictEqual(NEW_DUAL_WRITE_CODES.length, 5);
    for (const code of NEW_DUAL_WRITE_CODES) {
      assert.strictEqual(assertRegisteredErrorCode(code), code);
      const error = new LinkeError(code);
      assert.strictEqual(error.message, code);
      assert.strictEqual(error.code, code);
      assert.strictEqual(error.name, 'LinkeError');
    }
    assert.strictEqual(new Set(NEW_DUAL_WRITE_CODES).size, 5);
  });

  it('rejects raw or unregistered error text', () => {
    assert.throws(() => assertRegisteredErrorCode('ENOENT /Users/private'), /unregistered Linke error code/);
  });

  it('rejects unregistered raw text in LinkeError without echoing it', () => {
    const raw = 'ENOENT /Users/private/secret';
    assert.throws(
      () => new LinkeError(raw),
      (error) => {
        assert.match(error.message, /unregistered Linke error code/);
        assert.ok(!error.message.includes(raw));
        assert.ok(!error.message.includes('/Users/private'));
        return true;
      },
    );
  });

  it('constructs a sanitized LinkeError', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_REVOKED, { statusCode: 403 });
    assert.strictEqual(error.code, 'device-revoked');
    assert.strictEqual(error.message, 'device-revoked');
    assert.strictEqual(error.statusCode, 403);
    assert.strictEqual(error.retryable, false);
  });

  it('defaults LinkeError statusCode, retryable, and name', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR);
    assert.strictEqual(error.name, 'LinkeError');
    assert.strictEqual(error.statusCode, 500);
    assert.strictEqual(error.retryable, false);
  });

  it('preserves retryable true when explicitly set', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_RATE_LIMITED, { statusCode: 429, retryable: true });
    assert.strictEqual(error.retryable, true);
    assert.strictEqual(error.statusCode, 429);
  });

  it('registers AUDIT_DELIVERY_UNAVAILABLE with LinkeError 503/retryable attributes', () => {
    assert.strictEqual(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, 'audit-delivery-unavailable');
    const error = new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, {
      statusCode: 503,
      retryable: true,
    });
    assert.strictEqual(error.name, 'LinkeError');
    assert.strictEqual(error.code, 'audit-delivery-unavailable');
    assert.strictEqual(error.message, 'audit-delivery-unavailable');
    assert.strictEqual(error.statusCode, 503);
    assert.strictEqual(error.retryable, true);
  });
});
