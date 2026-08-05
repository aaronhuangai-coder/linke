/**
 * Pure audit-integrity alert retry policy.
 *
 * Frozen attempt ceiling, fixed backoff delays, pure due math, and closed
 * decision classification. No filesystem, network, timers, Date.now policy
 * reads, scheduler, or host wiring.
 *
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md (§5.3, §8)
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-durable-retry-plan.md (Task 1)
 */

import { types as utilTypes } from 'node:util';

import { ERROR_CODES, LinkeError } from './error-codes.js';

export const AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS = 8;

export const AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS = Object.freeze([
  30_000,
  120_000,
  600_000,
  1_800_000,
  7_200_000,
  28_800_000,
  86_400_000,
]);

const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CLOSED_OUTCOME_KINDS = new Set([
  'accepted',
  'retryable-rejected',
  'terminal-rejected',
  'uncertain',
]);

/**
 * @returns {LinkeError}
 */
function unavailableError() {
  return new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
}

/**
 * @returns {never}
 */
function fail() {
  throw unavailableError();
}

/**
 * Primitive canonical millisecond UTC ISO string only.
 * Rejects Proxy/object/boxed/non-matching forms without coercion.
 *
 * @param {unknown} value
 * @returns {string}
 */
function requireCanonicalIso(value) {
  if (utilTypes.isProxy(value)) fail();
  if (typeof value !== 'string') fail();
  if (!CANONICAL_ISO_RE.test(value)) fail();
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    fail();
  }
  if (canonical !== value) fail();
  return value;
}

/**
 * Primitive safe integer in inclusive [min, max]. No boxing/coercion.
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function requireIntegerInRange(value, min, max) {
  if (utilTypes.isProxy(value)) fail();
  if (typeof value !== 'number') fail();
  if (!Number.isInteger(value)) fail();
  if (value < min || value > max) fail();
  return value;
}

/**
 * Closed policy input kind string only.
 *
 * @param {unknown} value
 * @returns {'accepted' | 'retryable-rejected' | 'terminal-rejected' | 'uncertain'}
 */
function requireClosedOutcomeKind(value) {
  if (utilTypes.isProxy(value)) fail();
  if (typeof value !== 'string') fail();
  if (!CLOSED_OUTCOME_KINDS.has(value)) fail();
  return /** @type {'accepted' | 'retryable-rejected' | 'terminal-rejected' | 'uncertain'} */ (
    value
  );
}

/**
 * nextAttemptAt = canonicalIso(Date.parse(lastAttemptAt) + backoff[attempt-1])
 * attemptCountAfterFailure must be 1..7.
 *
 * @param {unknown} lastAttemptAtIso
 * @param {unknown} attemptCountAfterFailure
 * @returns {string}
 */
export function computeAuditIntegrityAlertRetryDueAt(
  lastAttemptAtIso,
  attemptCountAfterFailure,
) {
  const lastAttemptAt = requireCanonicalIso(lastAttemptAtIso);
  const attempt = requireIntegerInRange(attemptCountAfterFailure, 1, 7);
  const delayMs = AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS[attempt - 1];
  const due = new Date(Date.parse(lastAttemptAt) + delayMs).toISOString();
  // Defensive: produced value must remain canonical (pure conversion of inputs).
  if (due !== new Date(due).toISOString() || !CANONICAL_ISO_RE.test(due)) fail();
  return due;
}

/**
 * effectiveDue = max(backoffDue, claimExpiresAt) over canonical ISO forms.
 *
 * @param {unknown} lastAttemptAtIso
 * @param {unknown} attemptCountAfterFailure
 * @param {unknown} claimExpiresAtIso
 * @returns {string}
 */
export function computeAuditIntegrityAlertUncertainDueAt(
  lastAttemptAtIso,
  attemptCountAfterFailure,
  claimExpiresAtIso,
) {
  const backoffDue = computeAuditIntegrityAlertRetryDueAt(
    lastAttemptAtIso,
    attemptCountAfterFailure,
  );
  const claimDue = requireCanonicalIso(claimExpiresAtIso);
  // Canonical millisecond UTC ISO is lexicographically ordered by instant.
  return backoffDue >= claimDue ? backoffDue : claimDue;
}

/**
 * Closed decision among accept-complete / retry-wait / uncertain-hold /
 * dead-letter-* for attemptCount 1..8 and closed detailed outcome kinds.
 *
 * @param {unknown} attemptCount
 * @param {unknown} detailedOutcomeKind
 * @returns {string}
 */
export function classifyAuditIntegrityAlertRetryDecision(
  attemptCount,
  detailedOutcomeKind,
) {
  const attempt = requireIntegerInRange(
    attemptCount,
    1,
    AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS,
  );
  const kind = requireClosedOutcomeKind(detailedOutcomeKind);

  if (kind === 'accepted') {
    return 'accept-complete';
  }
  if (kind === 'terminal-rejected') {
    return 'dead-letter-terminal-http';
  }
  if (kind === 'retryable-rejected') {
    if (attempt >= AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS) {
      return 'dead-letter-attempts-exhausted-retryable';
    }
    return 'retry-wait';
  }
  // kind === 'uncertain'
  if (attempt >= AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS) {
    return 'dead-letter-attempts-exhausted-uncertain';
  }
  return 'uncertain-hold';
}
