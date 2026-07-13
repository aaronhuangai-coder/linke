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
