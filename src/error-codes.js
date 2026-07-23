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
  // V1.36 cross-store verifier (+4). size overlimit → CROSS_STORE_IO_ERROR (≠ bounds).
  // broken = relationship only; event-invalid = newline/JSON/strict/canonical only.
  AUDIT_INTEGRITY_CROSS_STORE_BROKEN: 'audit-integrity-cross-store-broken',
  AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR: 'audit-integrity-cross-store-io-error',
  AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED: 'audit-integrity-cross-store-bounds-exceeded',
  AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID: 'audit-integrity-cross-store-event-invalid',
  // V1.37 dual-write state / coordinator (+5).
  // state-invalid: schema/relationship; publish-preflight serialize >65536.
  // io-error: state read size overlimit / SafeDataFileError (≠ state-invalid).
  AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID: 'audit-integrity-dual-write-state-invalid',
  AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR: 'audit-integrity-dual-write-io-error',
  AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT: 'audit-integrity-dual-write-recovery-conflict',
  AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH: 'audit-integrity-dual-write-cursor-mismatch',
  AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED: 'audit-integrity-dual-write-direct-mutation-blocked',
  // V1.39 write-admission fail-closed (+1). Required pre-side-effect admission only.
  AUDIT_DELIVERY_UNAVAILABLE: 'audit-delivery-unavailable',
  // V1.40 local multi-process audit integrity write exclusive lock (+1).
  AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE: 'audit-integrity-process-lock-unavailable',
  // V1.41 G0b resumable snapshot upload (+12). String-only kebab values; no domain metadata.
  UPLOAD_MANIFEST_INVALID: 'upload-manifest-invalid',
  UPLOAD_SESSION_CONFLICT: 'upload-session-conflict',
  UPLOAD_SESSION_NOT_FOUND: 'upload-session-not-found',
  UPLOAD_SESSION_EXPIRED: 'upload-session-expired',
  UPLOAD_CHUNK_INVALID: 'upload-chunk-invalid',
  UPLOAD_CHUNK_OUT_OF_ORDER: 'upload-chunk-out-of-order',
  UPLOAD_INTEGRITY_FAILED: 'upload-integrity-failed',
  UPLOAD_CAPACITY_INSUFFICIENT: 'upload-capacity-insufficient',
  UPLOAD_BACKPRESSURE: 'upload-backpressure',
  UPLOAD_COMMIT_CONFLICT: 'upload-commit-conflict',
  UPLOAD_IO_ERROR: 'upload-io-error',
  // Client-local only (HTTP N/A). Distinct from DATA_RESUME_EXHAUSTED.
  UPLOAD_RESUME_EXHAUSTED: 'upload-resume-exhausted',
  // V1.42 G0c endpoint-pull restore (+14). String-only kebab values; no domain metadata.
  // 74 + 14 restore = 88.
  RESTORE_TASK_INVALID: 'restore-task-invalid',
  RESTORE_TASK_NOT_FOUND: 'restore-task-not-found',
  RESTORE_TASK_CONFLICT: 'restore-task-conflict',
  RESTORE_STATE_INVALID: 'restore-state-invalid',
  RESTORE_PATH_INVALID: 'restore-path-invalid',
  RESTORE_INTEGRITY_FAILED: 'restore-integrity-failed',
  RESTORE_CAPACITY_INSUFFICIENT: 'restore-capacity-insufficient',
  RESTORE_BACKPRESSURE: 'restore-backpressure',
  RESTORE_INTERRUPTED: 'restore-interrupted',
  RESTORE_PUBLISH_CONFLICT: 'restore-publish-conflict',
  RESTORE_ROLLBACK_REQUIRED: 'restore-rollback-required',
  RESTORE_ROLLBACK_FAILED: 'restore-rollback-failed',
  RESTORE_CLEANUP_FAILED: 'restore-cleanup-failed',
  // Client-local only (HTTP N/A). Distinct from DATA_RESUME_EXHAUSTED / UPLOAD_RESUME_EXHAUSTED.
  RESTORE_RESUME_EXHAUSTED: 'restore-resume-exhausted',
});

/**
 * Independent frozen HTTP/retryable contract for G0b upload error codes (design §7).
 * Not part of ERROR_CODES (which remains string-only). statusCode null = client-local N/A.
 * @type {Readonly<Record<string, Readonly<{ statusCode: number | null, retryable: boolean }>>>}
 */
export const UPLOAD_ERROR_HTTP_CONTRACT = Object.freeze({
  [ERROR_CODES.UPLOAD_MANIFEST_INVALID]: Object.freeze({ statusCode: 400, retryable: false }),
  [ERROR_CODES.UPLOAD_SESSION_CONFLICT]: Object.freeze({ statusCode: 409, retryable: false }),
  [ERROR_CODES.UPLOAD_SESSION_NOT_FOUND]: Object.freeze({ statusCode: 404, retryable: false }),
  [ERROR_CODES.UPLOAD_SESSION_EXPIRED]: Object.freeze({ statusCode: 410, retryable: false }),
  [ERROR_CODES.UPLOAD_CHUNK_INVALID]: Object.freeze({ statusCode: 400, retryable: false }),
  [ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER]: Object.freeze({ statusCode: 409, retryable: true }),
  [ERROR_CODES.UPLOAD_INTEGRITY_FAILED]: Object.freeze({ statusCode: 409, retryable: false }),
  [ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT]: Object.freeze({ statusCode: 507, retryable: false }),
  [ERROR_CODES.UPLOAD_BACKPRESSURE]: Object.freeze({ statusCode: 429, retryable: true }),
  [ERROR_CODES.UPLOAD_COMMIT_CONFLICT]: Object.freeze({ statusCode: 409, retryable: false }),
  [ERROR_CODES.UPLOAD_IO_ERROR]: Object.freeze({ statusCode: 500, retryable: false }),
  [ERROR_CODES.UPLOAD_RESUME_EXHAUSTED]: Object.freeze({ statusCode: null, retryable: false }),
});

/**
 * Independent frozen HTTP/retryable contract for G0c restore error codes.
 * Not part of ERROR_CODES (which remains string-only). statusCode null = client-local N/A.
 * @type {Readonly<Record<string, Readonly<{ statusCode: number | null, retryable: boolean }>>>}
 */
export const RESTORE_ERROR_HTTP_CONTRACT = Object.freeze({
  [ERROR_CODES.RESTORE_TASK_INVALID]: Object.freeze({ statusCode: 400, retryable: false }),
  [ERROR_CODES.RESTORE_TASK_NOT_FOUND]: Object.freeze({ statusCode: 404, retryable: false }),
  [ERROR_CODES.RESTORE_TASK_CONFLICT]: Object.freeze({ statusCode: 409, retryable: false }),
  [ERROR_CODES.RESTORE_STATE_INVALID]: Object.freeze({ statusCode: 500, retryable: false }),
  [ERROR_CODES.RESTORE_PATH_INVALID]: Object.freeze({ statusCode: 400, retryable: false }),
  [ERROR_CODES.RESTORE_INTEGRITY_FAILED]: Object.freeze({ statusCode: 422, retryable: false }),
  [ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT]: Object.freeze({ statusCode: 507, retryable: false }),
  [ERROR_CODES.RESTORE_BACKPRESSURE]: Object.freeze({ statusCode: 429, retryable: true }),
  [ERROR_CODES.RESTORE_INTERRUPTED]: Object.freeze({ statusCode: null, retryable: true }),
  [ERROR_CODES.RESTORE_PUBLISH_CONFLICT]: Object.freeze({ statusCode: 409, retryable: false }),
  [ERROR_CODES.RESTORE_ROLLBACK_REQUIRED]: Object.freeze({ statusCode: 409, retryable: false }),
  [ERROR_CODES.RESTORE_ROLLBACK_FAILED]: Object.freeze({ statusCode: 500, retryable: false }),
  [ERROR_CODES.RESTORE_CLEANUP_FAILED]: Object.freeze({ statusCode: 500, retryable: false }),
  [ERROR_CODES.RESTORE_RESUME_EXHAUSTED]: Object.freeze({ statusCode: null, retryable: false }),
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
 *
 * Codes present in {@link UPLOAD_ERROR_HTTP_CONTRACT} or
 * {@link RESTORE_ERROR_HTTP_CONTRACT} use the matching contract as base defaults
 * for both omitted options and `{}` / partial options. Only **own** properties
 * with value **!== undefined** override individual fields (prototype inheritance
 * does not count; own `undefined` matches old destructuring defaults).
 * Codes without a contract keep 500/false base defaults. Explicit `null` is a real
 * status value; `retryable: null|false` becomes Boolean false.
 *
 * Client-local resume-exhausted codes (`upload-resume-exhausted`,
 * `restore-resume-exhausted`) are stronger: final statusCode is always null.
 * Explicit non-null statusCode fails closed with a fixed internal Error
 * (never a serializable LinkeError, never echoes inputs). Own `statusCode: undefined`
 * falls back to contract null. `restore-interrupted` uses contract null/true defaults
 * but is not force-null-locked.
 *
 * @param {string} code - Must be a registered ERROR_CODES value.
 * @param {{ statusCode?: number | null, retryable?: boolean }} [options]
 */
export class LinkeError extends Error {
  /**
   * @param {string} code
   * @param {{ statusCode?: number | null, retryable?: boolean }} [options]
   */
  constructor(code, options) {
    const registeredCode = assertRegisteredErrorCode(code);
    super(registeredCode);
    this.name = 'LinkeError';
    this.code = registeredCode;

    const contract =
      UPLOAD_ERROR_HTTP_CONTRACT[registeredCode]
      ?? RESTORE_ERROR_HTTP_CONTRACT[registeredCode];
    const hasContract = contract !== undefined;

    /** @type {number | null} */
    const baseStatus = hasContract ? contract.statusCode : 500;
    /** @type {boolean} */
    const baseRetryable = hasContract ? Boolean(contract.retryable) : false;

    /** @type {number | null} */
    let statusCode = baseStatus;
    /** @type {boolean} */
    let retryable = baseRetryable;

    // Own-property-only overrides when options is a non-null non-array object.
    // Own key present with value === undefined is treated as missing (JS default
    // semantics: `{ statusCode = 500 } = { statusCode: undefined }` → 500).
    if (options !== undefined && options !== null && typeof options === 'object' && !Array.isArray(options)) {
      if (
        Object.prototype.hasOwnProperty.call(options, 'statusCode')
        && /** @type {{ statusCode?: number | null }} */ (options).statusCode !== undefined
      ) {
        statusCode = /** @type {{ statusCode?: number | null }} */ (options).statusCode;
      }
      if (
        Object.prototype.hasOwnProperty.call(options, 'retryable')
        && /** @type {{ retryable?: boolean }} */ (options).retryable !== undefined
      ) {
        // Explicit null/false → false; true stays true.
        retryable = Boolean(/** @type {{ retryable?: boolean }} */ (options).retryable);
      }
    }

    // Client-local resume-exhausted only: must never become a serializable non-null HTTP status.
    if (
      registeredCode === ERROR_CODES.UPLOAD_RESUME_EXHAUSTED
      || registeredCode === ERROR_CODES.RESTORE_RESUME_EXHAUSTED
    ) {
      if (statusCode !== null) {
        // Fixed internal error — not LinkeError; do not echo options/status values.
        throw new Error('invalid LinkeError options');
      }
      statusCode = null;
    }

    this.statusCode = statusCode;
    this.retryable = Boolean(retryable);
  }
}
