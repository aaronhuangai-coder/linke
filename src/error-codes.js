/**
 * Frozen registry of all public Linke error codes (kebab-case values only).
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_CODES = Object.freeze({
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
  // V1.35 audit integrity journal (+6). AUDIT_CHAIN_BROKEN above is pre-existing (not new).
  // bounds-exceeded: lines / per-line UTF-8 only — size/maxBytes overlimit uses io-error.
  AUDIT_INTEGRITY_BOUNDS_EXCEEDED: 'audit-integrity-bounds-exceeded',
  AUDIT_INTEGRITY_NOT_INITIALIZED: 'audit-integrity-not-initialized',
  AUDIT_INTEGRITY_ALREADY_INITIALIZED: 'audit-integrity-already-initialized',
  AUDIT_INTEGRITY_IO_ERROR: 'audit-integrity-io-error',
  AUDIT_INTEGRITY_EVENT_INVALID: 'audit-integrity-event-invalid',
  AUDIT_INTEGRITY_GENERATION_ID_INVALID: 'audit-integrity-generation-id-invalid',
});

const REGISTERED_ERROR_CODES = new Set(Object.values(ERROR_CODES));

/**
 * Return a registered public error code or throw without echoing its value.
 * @param {string} code
 * @returns {string}
 */
export function assertRegisteredErrorCode(code) {
  if (!REGISTERED_ERROR_CODES.has(code)) throw new Error('unregistered Linke error code');
  return code;
}

/**
 * Error whose public message is always a registered, sanitized code.
 * Unregistered code or message inputs are rejected without echoing raw text.
 * @param {string} code - Must be a registered ERROR_CODES value.
 * @param {{ statusCode?: number, retryable?: boolean }} [options]
 */
export class LinkeError extends Error {
  constructor(code, { statusCode = 500, retryable = false } = {}) {
    const registeredCode = assertRegisteredErrorCode(code);
    super(registeredCode);
    this.name = 'LinkeError';
    this.code = registeredCode;
    this.statusCode = statusCode;
    this.retryable = Boolean(retryable);
  }
}
