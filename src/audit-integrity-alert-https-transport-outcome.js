/**
 * Pure detailed HTTP status outcome classifier for audit-integrity alert delivery.
 *
 * Maps a final response statusCode to a frozen {schemaVersion, kind} without
 * network, timers, filesystem, header/body parsing, or Retry-After handling.
 *
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md (§9.2)
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-durable-retry-plan.md (Task 4)
 */

import { ERROR_CODES, LinkeError } from './error-codes.js';

/**
 * @returns {LinkeError}
 */
function unavailableError() {
  return new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
}

/**
 * Classify a final HTTP status code into a detailed delivery outcome kind.
 *
 * Accepts only primitive Number safe integers (no coercion). Every other value
 * fails closed with a fresh fixed audit-delivery-unavailable error.
 *
 * @param {unknown} statusCode
 * @returns {Readonly<{
 *   schemaVersion: 1,
 *   kind: 'accepted' | 'retryable-rejected' | 'terminal-rejected',
 * }>}
 */
export function classifyAuditIntegrityAlertHttpStatusDetailedOutcome(statusCode) {
  // Primitive Number safe integers only — never coerce strings/bools/BigInt.
  if (typeof statusCode !== 'number' || !Number.isSafeInteger(statusCode)) {
    throw unavailableError();
  }

  /** @type {'accepted' | 'retryable-rejected' | 'terminal-rejected'} */
  let kind;
  if (statusCode >= 200 && statusCode <= 299) {
    kind = 'accepted';
  } else if (
    statusCode === 408
    || statusCode === 425
    || statusCode === 429
    || (statusCode >= 500 && statusCode <= 599)
  ) {
    kind = 'retryable-rejected';
  } else {
    // Every other safe integer is terminal (including negative / out of range).
    kind = 'terminal-rejected';
  }

  // Exact own key order: schemaVersion, kind. No statusCode field.
  return Object.freeze({ schemaVersion: 1, kind });
}
