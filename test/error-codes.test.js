import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ERROR_CODES,
  LinkeError,
  assertRegisteredErrorCode,
  UPLOAD_ERROR_HTTP_CONTRACT,
  RESTORE_ERROR_HTTP_CONTRACT,
} from '../src/error-codes.js';

/**
 * Closed-set pin of the entire public ERROR_CODES registry.
 * Count: 94 = 88 (V1.42 G0c) + 6 new V1.43 rotation-* codes.
 *
 * Historical: 74 = existing 62 (V1.40) + 12 new V1.41 G0b upload-* codes.
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
 * - V1.40: AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE only (local multi-process write lock).
 * - V1.43: +6 audit-integrity-rotation-* codes directly after process-lock.
 * - V1.41 G0b: +12 upload-* string-only codes (no domain/object metadata on ERROR_CODES).
 * - UPLOAD_RESUME_EXHAUSTED is client-local only; ≠ DATA_RESUME_EXHAUSTED; HTTP N/A.
 * - V1.42 G0c: +14 restore-* string-only codes + RESTORE_ERROR_HTTP_CONTRACT.
 * - RESTORE_RESUME_EXHAUSTED is client-local only; ≠ DATA_RESUME_EXHAUSTED;
 *   ≠ UPLOAD_RESUME_EXHAUSTED; HTTP N/A.
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
  // --- new 1 (V1.39 write-admission fail-closed) ---
  AUDIT_DELIVERY_UNAVAILABLE: 'audit-delivery-unavailable',
  // --- new 1 (V1.40 local multi-process process-lock; only this code is new in this bump) ---
  AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE: 'audit-integrity-process-lock-unavailable',
  // --- new 6 (V1.43 audit integrity rotation state/manifest; after process-lock) ---
  AUDIT_INTEGRITY_ROTATION_STATE_INVALID: 'audit-integrity-rotation-state-invalid',
  AUDIT_INTEGRITY_ROTATION_IO_ERROR: 'audit-integrity-rotation-io-error',
  AUDIT_INTEGRITY_ROTATION_PRECONDITION_FAILED: 'audit-integrity-rotation-precondition-failed',
  AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED: 'audit-integrity-rotation-recovery-required',
  AUDIT_INTEGRITY_ROTATION_CONFLICT: 'audit-integrity-rotation-conflict',
  AUDIT_INTEGRITY_ROTATION_BOUNDS_EXCEEDED: 'audit-integrity-rotation-bounds-exceeded',
  // --- new 12 (V1.41 G0b resumable snapshot upload; string-only upload-* values) ---
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
  UPLOAD_RESUME_EXHAUSTED: 'upload-resume-exhausted',
  // --- new 14 (V1.42 G0c endpoint-pull restore; string-only restore-* values) ---
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
  RESTORE_RESUME_EXHAUSTED: 'restore-resume-exhausted',
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

const NEW_UPLOAD_CODES = [
  ERROR_CODES.UPLOAD_MANIFEST_INVALID,
  ERROR_CODES.UPLOAD_SESSION_CONFLICT,
  ERROR_CODES.UPLOAD_SESSION_NOT_FOUND,
  ERROR_CODES.UPLOAD_SESSION_EXPIRED,
  ERROR_CODES.UPLOAD_CHUNK_INVALID,
  ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER,
  ERROR_CODES.UPLOAD_INTEGRITY_FAILED,
  ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT,
  ERROR_CODES.UPLOAD_BACKPRESSURE,
  ERROR_CODES.UPLOAD_COMMIT_CONFLICT,
  ERROR_CODES.UPLOAD_IO_ERROR,
  ERROR_CODES.UPLOAD_RESUME_EXHAUSTED,
];

const NEW_RESTORE_CODES = [
  ERROR_CODES.RESTORE_TASK_INVALID,
  ERROR_CODES.RESTORE_TASK_NOT_FOUND,
  ERROR_CODES.RESTORE_TASK_CONFLICT,
  ERROR_CODES.RESTORE_STATE_INVALID,
  ERROR_CODES.RESTORE_PATH_INVALID,
  ERROR_CODES.RESTORE_INTEGRITY_FAILED,
  ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT,
  ERROR_CODES.RESTORE_BACKPRESSURE,
  ERROR_CODES.RESTORE_INTERRUPTED,
  ERROR_CODES.RESTORE_PUBLISH_CONFLICT,
  ERROR_CODES.RESTORE_ROLLBACK_REQUIRED,
  ERROR_CODES.RESTORE_ROLLBACK_FAILED,
  ERROR_CODES.RESTORE_CLEANUP_FAILED,
  ERROR_CODES.RESTORE_RESUME_EXHAUSTED,
];

/** design §7 HTTP/retryable contract — independent of string-only ERROR_CODES. */
const EXPECTED_UPLOAD_HTTP_CONTRACT = Object.freeze({
  'upload-manifest-invalid': Object.freeze({ statusCode: 400, retryable: false }),
  'upload-session-conflict': Object.freeze({ statusCode: 409, retryable: false }),
  'upload-session-not-found': Object.freeze({ statusCode: 404, retryable: false }),
  'upload-session-expired': Object.freeze({ statusCode: 410, retryable: false }),
  'upload-chunk-invalid': Object.freeze({ statusCode: 400, retryable: false }),
  'upload-chunk-out-of-order': Object.freeze({ statusCode: 409, retryable: true }),
  'upload-integrity-failed': Object.freeze({ statusCode: 409, retryable: false }),
  'upload-capacity-insufficient': Object.freeze({ statusCode: 507, retryable: false }),
  'upload-backpressure': Object.freeze({ statusCode: 429, retryable: true }),
  'upload-commit-conflict': Object.freeze({ statusCode: 409, retryable: false }),
  'upload-io-error': Object.freeze({ statusCode: 500, retryable: false }),
  'upload-resume-exhausted': Object.freeze({ statusCode: null, retryable: false }),
});

/** design G0c RESTORE_ERROR_HTTP_CONTRACT — independent of string-only ERROR_CODES. */
const EXPECTED_RESTORE_HTTP_CONTRACT = Object.freeze({
  'restore-task-invalid': Object.freeze({ statusCode: 400, retryable: false }),
  'restore-task-not-found': Object.freeze({ statusCode: 404, retryable: false }),
  'restore-task-conflict': Object.freeze({ statusCode: 409, retryable: false }),
  'restore-state-invalid': Object.freeze({ statusCode: 500, retryable: false }),
  'restore-path-invalid': Object.freeze({ statusCode: 400, retryable: false }),
  'restore-integrity-failed': Object.freeze({ statusCode: 422, retryable: false }),
  'restore-capacity-insufficient': Object.freeze({ statusCode: 507, retryable: false }),
  'restore-backpressure': Object.freeze({ statusCode: 429, retryable: true }),
  'restore-interrupted': Object.freeze({ statusCode: null, retryable: true }),
  'restore-publish-conflict': Object.freeze({ statusCode: 409, retryable: false }),
  'restore-rollback-required': Object.freeze({ statusCode: 409, retryable: false }),
  'restore-rollback-failed': Object.freeze({ statusCode: 500, retryable: false }),
  'restore-cleanup-failed': Object.freeze({ statusCode: 500, retryable: false }),
  'restore-resume-exhausted': Object.freeze({ statusCode: null, retryable: false }),
});

describe('Gold error-code registry', () => {
  it('matches the exact closed-set ERROR_CODES registry (94 entries = 88 + 6 rotation)', () => {
    assert.strictEqual(Object.keys(EXPECTED_ERROR_CODES).length, 94);
    assert.strictEqual(Object.keys(ERROR_CODES).length, 94);
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
    // V1.40 process-lock code exact value.
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE,
      'audit-integrity-process-lock-unavailable',
    );
    // V1.43 rotation codes exact values (order after process-lock).
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_ROTATION_STATE_INVALID,
      'audit-integrity-rotation-state-invalid',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_ROTATION_IO_ERROR,
      'audit-integrity-rotation-io-error',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_ROTATION_PRECONDITION_FAILED,
      'audit-integrity-rotation-precondition-failed',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED,
      'audit-integrity-rotation-recovery-required',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_ROTATION_CONFLICT,
      'audit-integrity-rotation-conflict',
    );
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_ROTATION_BOUNDS_EXCEEDED,
      'audit-integrity-rotation-bounds-exceeded',
    );
    // V1.41 G0b upload codes exact values + distinct from data-resume-exhausted.
    assert.strictEqual(ERROR_CODES.UPLOAD_MANIFEST_INVALID, 'upload-manifest-invalid');
    assert.strictEqual(ERROR_CODES.UPLOAD_SESSION_CONFLICT, 'upload-session-conflict');
    assert.strictEqual(ERROR_CODES.UPLOAD_SESSION_NOT_FOUND, 'upload-session-not-found');
    assert.strictEqual(ERROR_CODES.UPLOAD_SESSION_EXPIRED, 'upload-session-expired');
    assert.strictEqual(ERROR_CODES.UPLOAD_CHUNK_INVALID, 'upload-chunk-invalid');
    assert.strictEqual(ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER, 'upload-chunk-out-of-order');
    assert.strictEqual(ERROR_CODES.UPLOAD_INTEGRITY_FAILED, 'upload-integrity-failed');
    assert.strictEqual(ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT, 'upload-capacity-insufficient');
    assert.strictEqual(ERROR_CODES.UPLOAD_BACKPRESSURE, 'upload-backpressure');
    assert.strictEqual(ERROR_CODES.UPLOAD_COMMIT_CONFLICT, 'upload-commit-conflict');
    assert.strictEqual(ERROR_CODES.UPLOAD_IO_ERROR, 'upload-io-error');
    assert.strictEqual(ERROR_CODES.UPLOAD_RESUME_EXHAUSTED, 'upload-resume-exhausted');
    assert.notStrictEqual(
      ERROR_CODES.UPLOAD_RESUME_EXHAUSTED,
      ERROR_CODES.DATA_RESUME_EXHAUSTED,
    );
    // V1.42 G0c restore codes exact values.
    assert.strictEqual(ERROR_CODES.RESTORE_TASK_INVALID, 'restore-task-invalid');
    assert.strictEqual(ERROR_CODES.RESTORE_TASK_NOT_FOUND, 'restore-task-not-found');
    assert.strictEqual(ERROR_CODES.RESTORE_TASK_CONFLICT, 'restore-task-conflict');
    assert.strictEqual(ERROR_CODES.RESTORE_STATE_INVALID, 'restore-state-invalid');
    assert.strictEqual(ERROR_CODES.RESTORE_PATH_INVALID, 'restore-path-invalid');
    assert.strictEqual(ERROR_CODES.RESTORE_INTEGRITY_FAILED, 'restore-integrity-failed');
    assert.strictEqual(ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT, 'restore-capacity-insufficient');
    assert.strictEqual(ERROR_CODES.RESTORE_BACKPRESSURE, 'restore-backpressure');
    assert.strictEqual(ERROR_CODES.RESTORE_INTERRUPTED, 'restore-interrupted');
    assert.strictEqual(ERROR_CODES.RESTORE_PUBLISH_CONFLICT, 'restore-publish-conflict');
    assert.strictEqual(ERROR_CODES.RESTORE_ROLLBACK_REQUIRED, 'restore-rollback-required');
    assert.strictEqual(ERROR_CODES.RESTORE_ROLLBACK_FAILED, 'restore-rollback-failed');
    assert.strictEqual(ERROR_CODES.RESTORE_CLEANUP_FAILED, 'restore-cleanup-failed');
    assert.strictEqual(ERROR_CODES.RESTORE_RESUME_EXHAUSTED, 'restore-resume-exhausted');
    // Three resume-exhausted families remain distinct.
    assert.notStrictEqual(
      ERROR_CODES.RESTORE_RESUME_EXHAUSTED,
      ERROR_CODES.DATA_RESUME_EXHAUSTED,
    );
    assert.notStrictEqual(
      ERROR_CODES.RESTORE_RESUME_EXHAUSTED,
      ERROR_CODES.UPLOAD_RESUME_EXHAUSTED,
    );
    assert.notStrictEqual(
      ERROR_CODES.DATA_RESUME_EXHAUSTED,
      ERROR_CODES.UPLOAD_RESUME_EXHAUSTED,
    );
  });

  it('contains unique registered kebab-case codes', () => {
    assert.ok(Object.isFrozen(ERROR_CODES));
    const values = Object.values(ERROR_CODES);
    assert.strictEqual(new Set(values).size, values.length);
    assert.strictEqual(values.length, 94);
    for (const code of values) {
      assert.match(code, ERROR_CODE_PREFIX_PATTERN);
      assert.strictEqual(assertRegisteredErrorCode(code), code);
    }
  });

  it('keeps ERROR_CODES string-only with no domain/object metadata', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      assert.strictEqual(typeof key, 'string');
      assert.strictEqual(typeof value, 'string');
      assert.ok(!Object.prototype.hasOwnProperty.call(ERROR_CODES, 'domain'));
    }
    // Registry values must not be objects/arrays.
    for (const value of Object.values(ERROR_CODES)) {
      assert.strictEqual(typeof value, 'string');
      assert.notStrictEqual(typeof value, 'object');
    }
  });

  it('registers twelve upload-* codes with unified prefix and LinkeError message===code', () => {
    assert.strictEqual(NEW_UPLOAD_CODES.length, 12);
    assert.strictEqual(new Set(NEW_UPLOAD_CODES).size, 12);
    for (const code of NEW_UPLOAD_CODES) {
      assert.match(code, /^upload-[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.strictEqual(assertRegisteredErrorCode(code), code);
      const error = new LinkeError(code);
      assert.strictEqual(error.message, code);
      assert.strictEqual(error.code, code);
      assert.strictEqual(error.name, 'LinkeError');
    }
  });

  it('registers fourteen restore-* codes with unified prefix and LinkeError message===code', () => {
    assert.strictEqual(NEW_RESTORE_CODES.length, 14);
    assert.strictEqual(new Set(NEW_RESTORE_CODES).size, 14);
    for (const code of NEW_RESTORE_CODES) {
      assert.match(code, /^restore-[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(code.startsWith('restore-'));
      assert.strictEqual(assertRegisteredErrorCode(code), code);
      const error = new LinkeError(code);
      assert.strictEqual(error.message, code);
      assert.strictEqual(error.code, code);
      assert.strictEqual(error.name, 'LinkeError');
    }
  });

  it('exports deep-frozen UPLOAD_ERROR_HTTP_CONTRACT covering design §7', () => {
    assert.ok(Object.isFrozen(UPLOAD_ERROR_HTTP_CONTRACT));
    assert.deepStrictEqual(
      Object.keys(UPLOAD_ERROR_HTTP_CONTRACT).sort(),
      Object.keys(EXPECTED_UPLOAD_HTTP_CONTRACT).sort(),
    );
    for (const code of NEW_UPLOAD_CODES) {
      const entry = UPLOAD_ERROR_HTTP_CONTRACT[code];
      assert.ok(entry, `missing contract for ${code}`);
      assert.ok(Object.isFrozen(entry));
      assert.deepStrictEqual(entry, EXPECTED_UPLOAD_HTTP_CONTRACT[code]);
    }
    // retryable only out-of-order + backpressure
    assert.strictEqual(UPLOAD_ERROR_HTTP_CONTRACT['upload-chunk-out-of-order'].retryable, true);
    assert.strictEqual(UPLOAD_ERROR_HTTP_CONTRACT['upload-backpressure'].retryable, true);
    for (const code of NEW_UPLOAD_CODES) {
      if (code === 'upload-chunk-out-of-order' || code === 'upload-backpressure') continue;
      assert.strictEqual(UPLOAD_ERROR_HTTP_CONTRACT[code].retryable, false);
    }
    // resume-exhausted is client-local: HTTP N/A (null), never a server 429
    assert.strictEqual(UPLOAD_ERROR_HTTP_CONTRACT['upload-resume-exhausted'].statusCode, null);
    assert.notStrictEqual(UPLOAD_ERROR_HTTP_CONTRACT['upload-resume-exhausted'].statusCode, 429);
    // capacity uses controlled numeric 507
    assert.strictEqual(UPLOAD_ERROR_HTTP_CONTRACT['upload-capacity-insufficient'].statusCode, 507);
  });

  it('exports deep-frozen RESTORE_ERROR_HTTP_CONTRACT covering design G0c table', () => {
    assert.ok(Object.isFrozen(RESTORE_ERROR_HTTP_CONTRACT));
    assert.deepStrictEqual(RESTORE_ERROR_HTTP_CONTRACT, EXPECTED_RESTORE_HTTP_CONTRACT);
    assert.deepStrictEqual(
      Object.keys(RESTORE_ERROR_HTTP_CONTRACT).sort(),
      Object.keys(EXPECTED_RESTORE_HTTP_CONTRACT).sort(),
    );
    for (const code of NEW_RESTORE_CODES) {
      const entry = RESTORE_ERROR_HTTP_CONTRACT[code];
      assert.ok(entry, `missing restore contract for ${code}`);
      assert.ok(Object.isFrozen(entry));
      assert.deepStrictEqual(entry, EXPECTED_RESTORE_HTTP_CONTRACT[code]);
    }
    // retryable only backpressure + interrupted
    assert.strictEqual(RESTORE_ERROR_HTTP_CONTRACT['restore-backpressure'].retryable, true);
    assert.strictEqual(RESTORE_ERROR_HTTP_CONTRACT['restore-interrupted'].retryable, true);
    for (const code of NEW_RESTORE_CODES) {
      if (code === 'restore-backpressure' || code === 'restore-interrupted') continue;
      assert.strictEqual(RESTORE_ERROR_HTTP_CONTRACT[code].retryable, false);
    }
    // client-local: null status for interrupted + resume-exhausted
    assert.strictEqual(RESTORE_ERROR_HTTP_CONTRACT['restore-interrupted'].statusCode, null);
    assert.strictEqual(RESTORE_ERROR_HTTP_CONTRACT['restore-resume-exhausted'].statusCode, null);
    assert.strictEqual(RESTORE_ERROR_HTTP_CONTRACT['restore-capacity-insufficient'].statusCode, 507);
    assert.strictEqual(RESTORE_ERROR_HTTP_CONTRACT['restore-integrity-failed'].statusCode, 422);
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

  it('defaults LinkeError statusCode, retryable, and name for non-upload codes', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR);
    assert.strictEqual(error.name, 'LinkeError');
    assert.strictEqual(error.statusCode, 500);
    assert.strictEqual(error.retryable, false);
  });

  it('applies UPLOAD_ERROR_HTTP_CONTRACT defaults when LinkeError options omitted', () => {
    // client-local: must not default to misleading HTTP 500
    const resume = new LinkeError(ERROR_CODES.UPLOAD_RESUME_EXHAUSTED);
    assert.strictEqual(resume.statusCode, null);
    assert.strictEqual(resume.retryable, false);
    assert.strictEqual(resume.code, 'upload-resume-exhausted');

    const backpressure = new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE);
    assert.strictEqual(backpressure.statusCode, 429);
    assert.strictEqual(backpressure.retryable, true);

    const outOfOrder = new LinkeError(ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER);
    assert.strictEqual(outOfOrder.statusCode, 409);
    assert.strictEqual(outOfOrder.retryable, true);

    const manifestInvalid = new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
    assert.strictEqual(manifestInvalid.statusCode, 400);
    assert.strictEqual(manifestInvalid.retryable, false);
  });

  it('applies RESTORE_ERROR_HTTP_CONTRACT defaults when LinkeError options omitted', () => {
    const resume = new LinkeError(ERROR_CODES.RESTORE_RESUME_EXHAUSTED);
    assert.strictEqual(resume.statusCode, null);
    assert.strictEqual(resume.retryable, false);
    assert.strictEqual(resume.code, 'restore-resume-exhausted');

    const interrupted = new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED);
    assert.strictEqual(interrupted.statusCode, null);
    assert.strictEqual(interrupted.retryable, true);
    assert.strictEqual(interrupted.code, 'restore-interrupted');

    const backpressure = new LinkeError(ERROR_CODES.RESTORE_BACKPRESSURE);
    assert.strictEqual(backpressure.statusCode, 429);
    assert.strictEqual(backpressure.retryable, true);

    const capacity = new LinkeError(ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT);
    assert.strictEqual(capacity.statusCode, 507);
    assert.strictEqual(capacity.retryable, false);

    const taskInvalid = new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
    assert.strictEqual(taskInvalid.statusCode, 400);
    assert.strictEqual(taskInvalid.retryable, false);
  });

  it('prefers UPLOAD_ERROR_HTTP_CONTRACT for empty/partial options; own props only override', () => {
    // {} must keep contract (not fall back to 500/false)
    const resumeEmpty = new LinkeError(ERROR_CODES.UPLOAD_RESUME_EXHAUSTED, {});
    assert.strictEqual(resumeEmpty.statusCode, null);
    assert.strictEqual(resumeEmpty.retryable, false);

    const bpEmpty = new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE, {});
    assert.strictEqual(bpEmpty.statusCode, 429);
    assert.strictEqual(bpEmpty.retryable, true);

    // Partial own override: missing field remains contract default
    const bpPartialStatus = new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE, {
      statusCode: 503,
    });
    assert.strictEqual(bpPartialStatus.statusCode, 503);
    assert.strictEqual(bpPartialStatus.retryable, true, 'retryable from contract when not own');

    const bpPartialRetry = new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE, {
      retryable: false,
    });
    assert.strictEqual(bpPartialRetry.statusCode, 429);
    assert.strictEqual(bpPartialRetry.retryable, false);

    // Full explicit override for non-client-local upload codes
    const bpFull = new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE, {
      statusCode: 503,
      retryable: false,
    });
    assert.strictEqual(bpFull.statusCode, 503);
    assert.strictEqual(bpFull.retryable, false);

    // Prototype-inherited fake "statusCode" must not count as own override
    const proto = { statusCode: 999, retryable: false };
    const inherited = Object.create(proto);
    // no own props — contract base for out-of-order
    const fromProto = new LinkeError(ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER, inherited);
    assert.strictEqual(fromProto.statusCode, 409);
    assert.strictEqual(fromProto.retryable, true);

    // Non-upload codes: empty options still 500/false
    const deviceEmpty = new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR, {});
    assert.strictEqual(deviceEmpty.statusCode, 500);
    assert.strictEqual(deviceEmpty.retryable, false);
  });

  it('treats own undefined as missing (old destructuring defaults), not as override', () => {
    // Non-upload: own statusCode:undefined → base 500 (not undefined)
    const deviceUndefStatus = new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR, {
      statusCode: undefined,
    });
    assert.strictEqual(deviceUndefStatus.statusCode, 500);
    assert.strictEqual(deviceUndefStatus.retryable, false);

    // Upload: own statusCode:undefined → contract 429 (not undefined)
    const bpUndefStatus = new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE, {
      statusCode: undefined,
    });
    assert.strictEqual(bpUndefStatus.statusCode, 429);
    assert.strictEqual(bpUndefStatus.retryable, true);

    // Upload: own retryable:undefined → contract true (not Boolean(undefined)===false)
    const bpUndefRetry = new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE, {
      retryable: undefined,
    });
    assert.strictEqual(bpUndefRetry.statusCode, 429);
    assert.strictEqual(bpUndefRetry.retryable, true);

    // Client-local: own statusCode:undefined → contract null (not reject)
    const resumeUndefStatus = new LinkeError(ERROR_CODES.UPLOAD_RESUME_EXHAUSTED, {
      statusCode: undefined,
    });
    assert.strictEqual(resumeUndefStatus.statusCode, null);
    assert.strictEqual(resumeUndefStatus.retryable, false);

    // Explicit null/false still override (null is a real status; false/null retryable → false)
    const bpNullRetry = new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE, {
      retryable: null,
    });
    assert.strictEqual(bpNullRetry.statusCode, 429);
    assert.strictEqual(bpNullRetry.retryable, false);
  });

  it('forces client-local UPLOAD_RESUME_EXHAUSTED statusCode null; rejects non-null', () => {
    const okNull = new LinkeError(ERROR_CODES.UPLOAD_RESUME_EXHAUSTED, {
      statusCode: null,
    });
    assert.strictEqual(okNull.statusCode, null);
    assert.strictEqual(okNull.retryable, false);

    const okRetryOnly = new LinkeError(ERROR_CODES.UPLOAD_RESUME_EXHAUSTED, {
      retryable: false,
    });
    assert.strictEqual(okRetryOnly.statusCode, null);

    const raw500 = 'status-500-token';
    assert.throws(
      () =>
        new LinkeError(ERROR_CODES.UPLOAD_RESUME_EXHAUSTED, {
          statusCode: 500,
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof LinkeError), 'must not mint serializable LinkeError');
        assert.ok(!String(error.message).includes(raw500));
        assert.ok(!String(error.message).includes('500'));
        assert.ok(!String(error.message).includes('/Users/'));
        return true;
      },
    );
    assert.throws(
      () =>
        new LinkeError(ERROR_CODES.UPLOAD_RESUME_EXHAUSTED, {
          statusCode: 429,
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof LinkeError));
        assert.ok(!String(error.message).includes('429'));
        return true;
      },
    );
  });

  it('forces client-local RESTORE_RESUME_EXHAUSTED statusCode null; rejects non-null with fixed Error', () => {
    const okNull = new LinkeError(ERROR_CODES.RESTORE_RESUME_EXHAUSTED, {
      statusCode: null,
    });
    assert.strictEqual(okNull.statusCode, null);
    assert.strictEqual(okNull.retryable, false);

    const okOmitted = new LinkeError(ERROR_CODES.RESTORE_RESUME_EXHAUSTED);
    assert.strictEqual(okOmitted.statusCode, null);
    assert.strictEqual(okOmitted.retryable, false);

    assert.throws(
      () =>
        new LinkeError(ERROR_CODES.RESTORE_RESUME_EXHAUSTED, {
          statusCode: 400,
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof LinkeError), 'must not mint serializable LinkeError');
        assert.strictEqual(error.message, 'invalid LinkeError options');
        assert.ok(!String(error.message).includes('400'));
        assert.ok(!String(error.message).includes('/Users/'));
        return true;
      },
    );
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

  it('registers AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE with LinkeError message===code', () => {
    assert.strictEqual(
      ERROR_CODES.AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE,
      'audit-integrity-process-lock-unavailable',
    );
    const error = new LinkeError(ERROR_CODES.AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE);
    assert.strictEqual(error.name, 'LinkeError');
    assert.strictEqual(error.code, 'audit-integrity-process-lock-unavailable');
    assert.strictEqual(error.message, 'audit-integrity-process-lock-unavailable');
  });
});
