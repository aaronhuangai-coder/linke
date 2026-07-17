import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from '../src/error-codes.js';

/**
 * Closed-set pin of the entire public ERROR_CODES registry.
 * Count: 45 = 17 existing + 28 new T1.1 codes
 * (T1.1 lists 30 values; device-rate-limited and device-revoked already exist).
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
  // --- new 28 (T1.1 minus 2 overlaps) ---
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
  AUDIT_CHAIN_BROKEN: 'audit-chain-broken',
  CONTROLLER_STATE_UNTRUSTED: 'controller-state-untrusted',
  REVOKE_PROPAGATION_DEGRADED: 'revoke-propagation-degraded',
  SESSION_KEEPALIVE_TIMEOUT: 'session-keepalive-timeout',
  EVIDENCE_ARTIFACT_MISSING: 'evidence-artifact-missing',
  EVIDENCE_ARTIFACT_DIGEST_MISMATCH: 'evidence-artifact-digest-mismatch',
};

const ERROR_CODE_PREFIX_PATTERN =
  /^(auth|device|upload|snapshot|smb|restore|retention|scheduler|lifecycle|keychain|audit|upgrade|handshake|protocol|e2ee|enrollment|control|stale|relay|proxy|data|controller|revoke|session|evidence)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('Gold error-code registry', () => {
  it('matches the exact closed-set ERROR_CODES registry (45 entries)', () => {
    assert.strictEqual(Object.keys(EXPECTED_ERROR_CODES).length, 45);
    assert.strictEqual(Object.keys(ERROR_CODES).length, 45);
    assert.deepStrictEqual(ERROR_CODES, EXPECTED_ERROR_CODES);
  });

  it('contains unique registered kebab-case codes', () => {
    assert.ok(Object.isFrozen(ERROR_CODES));
    const values = Object.values(ERROR_CODES);
    assert.strictEqual(new Set(values).size, values.length);
    for (const code of values) {
      assert.match(code, ERROR_CODE_PREFIX_PATTERN);
      assert.strictEqual(assertRegisteredErrorCode(code), code);
    }
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
});
