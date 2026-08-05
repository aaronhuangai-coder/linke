/**
 * Task 1 RED — pure audit-integrity alert retry policy.
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-durable-retry-plan.md (Task 1)
 *
 * Production (absent on old HEAD):
 *   src/audit-integrity-alert-retry-policy.js
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   test name + assert message = `pure retry policy implementation missing`
 * Full matrix registers only when the pure policy exports exist.
 *
 * Pure helpers only: frozen max/backoff constants, due math, decision classify.
 * No filesystem, network, timers, Date.now policy reads, credentials, or host wiring.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES } from '../src/error-codes.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-retry-policy.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);
const PRODUCTION_MODULE_MARKER = 'audit-integrity-alert-retry-policy';

const MISSING_MSG = 'pure retry policy implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

const LAST_ATTEMPT_AT = '2026-08-05T00:00:00.000Z';

/** Exact frozen backoff table from design §8.3 (attemptCountAfterFailure 1..7). */
const EXPECTED_BACKOFF_MS = Object.freeze([
  30_000,
  120_000,
  600_000,
  1_800_000,
  7_200_000,
  28_800_000,
  86_400_000,
]);

/** Exact nextAttemptAt for LAST_ATTEMPT_AT + each backoff delay. */
const EXPECTED_RETRY_DUE_BY_ATTEMPT = Object.freeze({
  1: '2026-08-05T00:00:30.000Z',
  2: '2026-08-05T00:02:00.000Z',
  3: '2026-08-05T00:10:00.000Z',
  4: '2026-08-05T00:30:00.000Z',
  5: '2026-08-05T02:00:00.000Z',
  6: '2026-08-05T08:00:00.000Z',
  7: '2026-08-06T00:00:00.000Z',
});

const DECISION_ACCEPTED = 'accept-complete';
const DECISION_RETRY_WAIT = 'retry-wait';
const DECISION_UNCERTAIN_HOLD = 'uncertain-hold';
const DECISION_DEAD_LETTER_TERMINAL = 'dead-letter-terminal-http';
const DECISION_DEAD_LETTER_EXHAUSTED_RETRYABLE = 'dead-letter-attempts-exhausted-retryable';
const DECISION_DEAD_LETTER_EXHAUSTED_UNCERTAIN = 'dead-letter-attempts-exhausted-uncertain';

const CLOSED_DECISIONS = Object.freeze([
  DECISION_ACCEPTED,
  DECISION_RETRY_WAIT,
  DECISION_UNCERTAIN_HOLD,
  DECISION_DEAD_LETTER_TERMINAL,
  DECISION_DEAD_LETTER_EXHAUSTED_RETRYABLE,
  DECISION_DEAD_LETTER_EXHAUSTED_UNCERTAIN,
  'fail-closed',
]);

const CLOSED_OUTCOME_KINDS = Object.freeze([
  'accepted',
  'retryable-rejected',
  'terminal-rejected',
  'uncertain',
]);

const SECRET_TOKEN = 'Bearer secret-token-xyz';
const SECRET_PATH = '/Users/ah/secret/retry-policy.json';
const SECRET_HOST = 'evil-retry.acme.com';

/**
 * @typedef {{
 *   AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS: number,
 *   AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS: readonly number[],
 *   computeAuditIntegrityAlertRetryDueAt: Function,
 *   computeAuditIntegrityAlertUncertainDueAt: Function,
 *   classifyAuditIntegrityAlertRetryDecision: Function,
 * }} RetryPolicyApi
 */

/** @type {null | RetryPolicyApi} */
let policyApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.computeAuditIntegrityAlertRetryDueAt === 'function'
    && typeof mod.computeAuditIntegrityAlertUncertainDueAt === 'function'
    && typeof mod.classifyAuditIntegrityAlertRetryDecision === 'function'
  ) {
    policyApi = {
      AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS:
        mod.AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS,
      AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS:
        mod.AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS,
      computeAuditIntegrityAlertRetryDueAt: mod.computeAuditIntegrityAlertRetryDueAt,
      computeAuditIntegrityAlertUncertainDueAt:
        mod.computeAuditIntegrityAlertUncertainDueAt,
      classifyAuditIntegrityAlertRetryDecision:
        mod.classifyAuditIntegrityAlertRetryDecision,
    };
    implementationMissing = false;
  }
} catch (error) {
  // Swallow only target-module not-found. Never hide assertion, syntax, or other runtime errors.
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  const message = String(
    error && typeof error === 'object' && 'message' in error
      ? /** @type {{ message?: unknown }} */ (error).message
      : error,
  );
  const url = String(
    error && typeof error === 'object' && 'url' in error
      ? /** @type {{ url?: unknown }} */ (error).url
      : '',
  );
  const targetsTargetModule = message.includes(PRODUCTION_MODULE_MARKER)
    || url.includes(PRODUCTION_MODULE_MARKER)
    || message.includes(PRODUCTION_MODULE_PATH)
    || url.includes(PRODUCTION_MODULE_PATH);
  if (!targetsTargetModule) {
    throw error;
  }
  implementationMissing = true;
  policyApi = null;
}

/**
 * @returns {RetryPolicyApi}
 */
function requireApi() {
  if (implementationMissing || policyApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {RetryPolicyApi} */ (policyApi);
}

/**
 * Public-boundary failures are only the registered fixed LinkeError.
 * @param {unknown} error
 * @param {string[]} [leakTokens]
 */
function assertUnavailable(error, leakTokens = []) {
  assert.equal(error && /** @type {{ name?: string }} */ (error).name, 'LinkeError');
  assert.equal(error && /** @type {{ code?: string }} */ (error).code, CODE_UNAVAILABLE);
  assert.equal(
    error && /** @type {{ message?: string }} */ (error).message,
    CODE_UNAVAILABLE,
  );
  assert.equal(
    /** @type {{ message: string }} */ (error).message,
    /** @type {{ code: string }} */ (error).code,
  );
  assert.equal(/** @type {{ cause?: unknown }} */ (error).cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(/** @type {object} */ (error), 'cause'));

  const publicParts = [
    /** @type {{ name: string }} */ (error).name,
    /** @type {{ code: string }} */ (error).code,
    /** @type {{ message: string }} */ (error).message,
    String(/** @type {{ statusCode?: unknown }} */ (error).statusCode),
    String(/** @type {{ retryable?: unknown }} */ (error).retryable),
    ...Object.keys(/** @type {object} */ (error))
      .filter((key) => key !== 'stack')
      .map((key) => String(/** @type {Record<string, unknown>} */ (error)[key])),
  ].join('\0');

  const defaults = [
    LAST_ATTEMPT_AT,
    SECRET_TOKEN,
    SECRET_HOST,
    SECRET_PATH,
    'authorization',
    'Bearer',
    '/Users/',
    '/var/',
    '/private/',
    '/tmp/',
    'retry-policy',
    'token',
  ];
  for (const token of [...defaults, ...leakTokens]) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `public error must not leak ${token}`);
  }
  return true;
}

/**
 * @param {() => unknown} fn
 * @param {string[]} [leakTokens]
 */
function expectUnavailable(fn, leakTokens = []) {
  assert.throws(fn, (error) => {
    assertUnavailable(error, leakTokens);
    return true;
  });
}

/**
 * @param {string} iso
 * @returns {boolean}
 */
function isCanonicalIso(iso) {
  return typeof iso === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)
    && new Date(iso).toISOString() === iso;
}

/**
 * Independent oracle for design §8.3 due math.
 * @param {string} lastAttemptAtIso
 * @param {number} attemptCountAfterFailure
 * @returns {string}
 */
function oracleRetryDueAt(lastAttemptAtIso, attemptCountAfterFailure) {
  assert.equal(isCanonicalIso(lastAttemptAtIso), true);
  assert.equal(
    Number.isInteger(attemptCountAfterFailure)
      && attemptCountAfterFailure >= 1
      && attemptCountAfterFailure <= 7,
    true,
  );
  const delayMs = EXPECTED_BACKOFF_MS[attemptCountAfterFailure - 1];
  const due = new Date(Date.parse(lastAttemptAtIso) + delayMs).toISOString();
  assert.equal(isCanonicalIso(due), true);
  return due;
}

/**
 * Independent oracle for design §8.4.1 max(backoff, claimExpiresAt).
 * @param {string} lastAttemptAtIso
 * @param {number} attemptCountAfterFailure
 * @param {string} claimExpiresAtIso
 * @returns {string}
 */
function oracleUncertainDueAt(lastAttemptAtIso, attemptCountAfterFailure, claimExpiresAtIso) {
  const backoffDue = oracleRetryDueAt(lastAttemptAtIso, attemptCountAfterFailure);
  assert.equal(isCanonicalIso(claimExpiresAtIso), true);
  return backoffDue >= claimExpiresAtIso ? backoffDue : claimExpiresAtIso;
}

/**
 * @returns {{ traps: Record<string, number>, proxy: object }}
 */
function makeTrapProxy(target = Object.freeze(Object.create(null))) {
  const traps = {
    get: 0,
    set: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
    getPrototypeOf: 0,
    has: 0,
  };
  const proxy = new Proxy(target, {
    get(_t, prop) {
      traps.get += 1;
      throw new Error(`trap-get:${String(prop)}:${SECRET_PATH}`);
    },
    set() {
      traps.set += 1;
      throw new Error(`trap-set:${SECRET_TOKEN}`);
    },
    ownKeys() {
      traps.ownKeys += 1;
      throw new Error(`trap-ownKeys:${SECRET_HOST}`);
    },
    getOwnPropertyDescriptor() {
      traps.getOwnPropertyDescriptor += 1;
      throw new Error(`trap-desc:${SECRET_PATH}`);
    },
    getPrototypeOf() {
      traps.getPrototypeOf += 1;
      throw new Error(`trap-proto:${SECRET_TOKEN}`);
    },
    has() {
      traps.has += 1;
      throw new Error(`trap-has:${SECRET_HOST}`);
    },
  });
  return { traps, proxy };
}

/**
 * @param {Record<string, number>} traps
 * @returns {number}
 */
function sumTraps(traps) {
  return Object.values(traps).reduce((a, b) => a + b, 0);
}

/**
 * @param {unknown} decision
 * @param {string} expected
 * @param {string} [label]
 */
function assertDecision(decision, expected, label = 'decision') {
  assert.equal(typeof decision, 'string', `${label} must be a closed decision string`);
  assert.equal(decision, expected, `${label} must equal ${expected}`);
  assert.equal(
    CLOSED_DECISIONS.includes(/** @type {string} */ (decision)),
    true,
    `${label} must be in the closed decision set`,
  );
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('audit integrity alert retry policy (Task 1 RED)', () => {
  // Old HEAD: exactly one dedicated RED. Full matrix only when exports exist.
  if (implementationMissing || policyApi === null) {
    it('pure retry policy implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── 1. Constants ────────────────────────────────────────────────────────

  describe('1 frozen max attempts and exact backoff delays', () => {
    it('exports max attempts = 8 and frozen exact 7-delay backoff table', () => {
      const api = requireApi();
      assert.equal(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, CODE_UNAVAILABLE);
      assert.equal(api.AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS, 8);
      assert.equal(Array.isArray(api.AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS), true);
      assert.equal(api.AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS.length, 7);
      assert.deepEqual([...api.AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS], [...EXPECTED_BACKOFF_MS]);
      assert.equal(Object.isFrozen(api.AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS), true);
      assert.equal(
        Object.isFrozen(EXPECTED_BACKOFF_MS),
        true,
        'test oracle table must itself be frozen',
      );
    });

    it('exports pure due and decision helpers as functions', () => {
      const api = requireApi();
      assert.equal(typeof api.computeAuditIntegrityAlertRetryDueAt, 'function');
      assert.equal(typeof api.computeAuditIntegrityAlertUncertainDueAt, 'function');
      assert.equal(typeof api.classifyAuditIntegrityAlertRetryDecision, 'function');
    });
  });

  // ── 2. Retry due matrix ─────────────────────────────────────────────────

  describe('2 computeAuditIntegrityAlertRetryDueAt exact ISO matrix', () => {
    it('returns exact canonical nextAttemptAt for attemptCountAfterFailure 1..7', () => {
      const api = requireApi();
      for (let attempt = 1; attempt <= 7; attempt += 1) {
        const due = api.computeAuditIntegrityAlertRetryDueAt(LAST_ATTEMPT_AT, attempt);
        const expected = EXPECTED_RETRY_DUE_BY_ATTEMPT[
          /** @type {1|2|3|4|5|6|7} */ (attempt)
        ];
        assert.equal(due, expected, `attempt ${attempt} due must be exact`);
        assert.equal(due, oracleRetryDueAt(LAST_ATTEMPT_AT, attempt));
        assert.equal(isCanonicalIso(due), true);
        assert.equal(new Date(due).toISOString(), due);
      }
    });

    it('rejects attemptCountAfterFailure 0, 8, 9 and non-integers with fixed unavailable', () => {
      const api = requireApi();
      for (const bad of [0, 8, 9, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', true, null, undefined]) {
        expectUnavailable(
          () => api.computeAuditIntegrityAlertRetryDueAt(LAST_ATTEMPT_AT, bad),
          [String(bad), SECRET_TOKEN, SECRET_PATH],
        );
      }
    });

    it('rejects non-canonical lastAttemptAt with fixed unavailable', () => {
      const api = requireApi();
      const nonCanonical = [
        '2026-08-05T00:00:00Z',
        '2026-08-05T00:00:00.000+00:00',
        '2026-08-05 00:00:00.000Z',
        '2026-08-05t00:00:00.000z',
        '2026-08-05T00:00:00.000z',
        '2026/08/05T00:00:00.000Z',
        '',
        'not-a-date',
        0,
        null,
        undefined,
        true,
        false,
        1_725_321_600_000,
        new Date(LAST_ATTEMPT_AT),
        Object(LAST_ATTEMPT_AT),
      ];
      for (const raw of nonCanonical) {
        expectUnavailable(
          () => api.computeAuditIntegrityAlertRetryDueAt(raw, 1),
          [SECRET_TOKEN, SECRET_PATH, SECRET_HOST],
        );
      }
    });
  });

  // ── 3. Uncertain due = max(backoff, claimExpiresAt) ─────────────────────

  describe('3 computeAuditIntegrityAlertUncertainDueAt max(backoff, claim expiry)', () => {
    it('returns backoff when backoff is strictly later than claimExpiresAt', () => {
      const api = requireApi();
      // attempt 1 backoff = 2026-08-05T00:00:30.000Z
      const claimEarlier = '2026-08-05T00:00:10.000Z';
      const due = api.computeAuditIntegrityAlertUncertainDueAt(
        LAST_ATTEMPT_AT,
        1,
        claimEarlier,
      );
      assert.equal(due, '2026-08-05T00:00:30.000Z');
      assert.equal(due, oracleUncertainDueAt(LAST_ATTEMPT_AT, 1, claimEarlier));
      assert.equal(isCanonicalIso(due), true);
    });

    it('returns claimExpiresAt when claim expiry is strictly later than backoff', () => {
      const api = requireApi();
      const claimLater = '2026-08-05T00:01:00.000Z';
      const due = api.computeAuditIntegrityAlertUncertainDueAt(
        LAST_ATTEMPT_AT,
        1,
        claimLater,
      );
      assert.equal(due, claimLater);
      assert.equal(due, oracleUncertainDueAt(LAST_ATTEMPT_AT, 1, claimLater));
      assert.equal(isCanonicalIso(due), true);
    });

    it('returns the shared instant when backoff equals claimExpiresAt', () => {
      const api = requireApi();
      const equalClaim = '2026-08-05T00:00:30.000Z';
      const due = api.computeAuditIntegrityAlertUncertainDueAt(
        LAST_ATTEMPT_AT,
        1,
        equalClaim,
      );
      assert.equal(due, equalClaim);
      assert.equal(due, oracleUncertainDueAt(LAST_ATTEMPT_AT, 1, equalClaim));
    });

    it('proves max on both orderings across multiple attempt delays', () => {
      const api = requireApi();
      const cases = [
        {
          attempt: 2,
          claimEarlier: '2026-08-05T00:01:00.000Z',
          claimLater: '2026-08-05T00:05:00.000Z',
          backoff: '2026-08-05T00:02:00.000Z',
        },
        {
          attempt: 4,
          claimEarlier: '2026-08-05T00:10:00.000Z',
          claimLater: '2026-08-05T01:00:00.000Z',
          backoff: '2026-08-05T00:30:00.000Z',
        },
        {
          attempt: 7,
          claimEarlier: '2026-08-05T12:00:00.000Z',
          claimLater: '2026-08-07T00:00:00.000Z',
          backoff: '2026-08-06T00:00:00.000Z',
        },
      ];
      for (const { attempt, claimEarlier, claimLater, backoff } of cases) {
        const whenBackoffWins = api.computeAuditIntegrityAlertUncertainDueAt(
          LAST_ATTEMPT_AT,
          attempt,
          claimEarlier,
        );
        const whenClaimWins = api.computeAuditIntegrityAlertUncertainDueAt(
          LAST_ATTEMPT_AT,
          attempt,
          claimLater,
        );
        assert.equal(whenBackoffWins, backoff);
        assert.equal(whenClaimWins, claimLater);
        assert.equal(
          whenBackoffWins,
          oracleUncertainDueAt(LAST_ATTEMPT_AT, attempt, claimEarlier),
        );
        assert.equal(
          whenClaimWins,
          oracleUncertainDueAt(LAST_ATTEMPT_AT, attempt, claimLater),
        );
      }
    });

    it('rejects non-canonical claimExpiresAt / lastAttemptAt and bad attempt with fixed unavailable', () => {
      const api = requireApi();
      const claimCanonical = '2026-08-05T00:01:00.000Z';
      for (const badClaim of [
        '2026-08-05T00:01:00Z',
        '2026-08-05T00:01:00.000+00:00',
        '2026-08-05 00:01:00.000Z',
        null,
        undefined,
        0,
        {},
      ]) {
        expectUnavailable(
          () => api.computeAuditIntegrityAlertUncertainDueAt(
            LAST_ATTEMPT_AT,
            1,
            badClaim,
          ),
        );
      }
      for (const badAttempt of [0, 8, 9]) {
        expectUnavailable(
          () => api.computeAuditIntegrityAlertUncertainDueAt(
            LAST_ATTEMPT_AT,
            badAttempt,
            claimCanonical,
          ),
        );
      }
      expectUnavailable(
        () => api.computeAuditIntegrityAlertUncertainDueAt(
          '2026-08-05T00:00:00Z',
          1,
          claimCanonical,
        ),
      );
    });
  });

  // ── 4. Decision matrix ──────────────────────────────────────────────────

  describe('4 classifyAuditIntegrityAlertRetryDecision closed decision table', () => {
    it('maps accepted → accept-complete for attemptCount 1..8', () => {
      const api = requireApi();
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        assertDecision(
          api.classifyAuditIntegrityAlertRetryDecision(attempt, 'accepted'),
          DECISION_ACCEPTED,
          `accepted@${attempt}`,
        );
      }
    });

    it('maps retryable-rejected → retry-wait for attemptCount 1..7 and exhausted at 8', () => {
      const api = requireApi();
      for (let attempt = 1; attempt <= 7; attempt += 1) {
        assertDecision(
          api.classifyAuditIntegrityAlertRetryDecision(attempt, 'retryable-rejected'),
          DECISION_RETRY_WAIT,
          `retryable@${attempt}`,
        );
      }
      assertDecision(
        api.classifyAuditIntegrityAlertRetryDecision(8, 'retryable-rejected'),
        DECISION_DEAD_LETTER_EXHAUSTED_RETRYABLE,
        'retryable@8',
      );
    });

    it('maps terminal-rejected → dead-letter-terminal-http for any attemptCount 1..8', () => {
      const api = requireApi();
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        assertDecision(
          api.classifyAuditIntegrityAlertRetryDecision(attempt, 'terminal-rejected'),
          DECISION_DEAD_LETTER_TERMINAL,
          `terminal@${attempt}`,
        );
      }
    });

    it('maps uncertain → uncertain-hold for attemptCount 1..7 and exhausted at 8', () => {
      const api = requireApi();
      for (let attempt = 1; attempt <= 7; attempt += 1) {
        assertDecision(
          api.classifyAuditIntegrityAlertRetryDecision(attempt, 'uncertain'),
          DECISION_UNCERTAIN_HOLD,
          `uncertain@${attempt}`,
        );
      }
      assertDecision(
        api.classifyAuditIntegrityAlertRetryDecision(8, 'uncertain'),
        DECISION_DEAD_LETTER_EXHAUSTED_UNCERTAIN,
        'uncertain@8',
      );
    });

    it('rejects unsupported detailedOutcomeKind with fixed unavailable', () => {
      const api = requireApi();
      const unsupported = [
        'unknown',
        'rejected',
        'retryable',
        'terminal',
        'fail-closed',
        'accept-complete',
        'retry-wait',
        '',
        'ACCEPTED',
        'retryable_rejected',
        'retryableRejected',
        null,
        undefined,
        0,
        true,
        false,
        {},
        [],
      ];
      for (const kind of unsupported) {
        expectUnavailable(
          () => api.classifyAuditIntegrityAlertRetryDecision(1, kind),
          [SECRET_TOKEN, SECRET_PATH],
        );
      }
      // Closed kinds remain the only legal policy inputs.
      for (const kind of CLOSED_OUTCOME_KINDS) {
        const decision = api.classifyAuditIntegrityAlertRetryDecision(1, kind);
        assert.equal(typeof decision, 'string');
        assert.equal(CLOSED_DECISIONS.includes(decision), true);
      }
    });

    it('rejects out-of-range attemptCount for classify with fixed unavailable', () => {
      const api = requireApi();
      for (const attempt of [0, 9, -1, 1.5, Number.NaN, '1', null, undefined, true]) {
        for (const kind of CLOSED_OUTCOME_KINDS) {
          expectUnavailable(
            () => api.classifyAuditIntegrityAlertRetryDecision(attempt, kind),
          );
        }
      }
    });
  });

  // ── 5. Hostile / Proxy / accessor fail-closed ───────────────────────────

  describe('5 hostile Proxy accessor inputs fail closed', () => {
    it('rejects Proxy lastAttemptAt / claimExpiresAt / kind without invoking traps', () => {
      const api = requireApi();
      const { traps: trapsA, proxy: proxyIso } = makeTrapProxy();
      expectUnavailable(
        () => api.computeAuditIntegrityAlertRetryDueAt(proxyIso, 1),
        [SECRET_TOKEN, SECRET_PATH, SECRET_HOST],
      );
      assert.equal(sumTraps(trapsA), 0, 'retry due must not touch Proxy traps');

      const { traps: trapsB, proxy: proxyClaim } = makeTrapProxy();
      expectUnavailable(
        () => api.computeAuditIntegrityAlertUncertainDueAt(
          LAST_ATTEMPT_AT,
          1,
          proxyClaim,
        ),
        [SECRET_TOKEN, SECRET_PATH, SECRET_HOST],
      );
      assert.equal(sumTraps(trapsB), 0, 'uncertain due must not touch Proxy traps');

      const { traps: trapsC, proxy: proxyKind } = makeTrapProxy();
      expectUnavailable(
        () => api.classifyAuditIntegrityAlertRetryDecision(1, proxyKind),
        [SECRET_TOKEN, SECRET_PATH, SECRET_HOST],
      );
      assert.equal(sumTraps(trapsC), 0, 'classify must not touch Proxy traps');
    });

    it('rejects accessor / boxed / object-shaped attempt and time inputs without getters', () => {
      const api = requireApi();
      let getterHits = 0;
      const accessorAttempt = {};
      Object.defineProperty(accessorAttempt, 'valueOf', {
        enumerable: false,
        configurable: true,
        get() {
          getterHits += 1;
          throw new Error(`trap-valueOf:${SECRET_TOKEN}`);
        },
      });
      Object.defineProperty(accessorAttempt, 'toString', {
        enumerable: false,
        configurable: true,
        get() {
          getterHits += 1;
          throw new Error(`trap-toString:${SECRET_PATH}`);
        },
      });

      expectUnavailable(
        () => api.computeAuditIntegrityAlertRetryDueAt(LAST_ATTEMPT_AT, accessorAttempt),
        [SECRET_TOKEN, SECRET_PATH],
      );
      expectUnavailable(
        () => api.computeAuditIntegrityAlertUncertainDueAt(
          LAST_ATTEMPT_AT,
          accessorAttempt,
          '2026-08-05T00:01:00.000Z',
        ),
        [SECRET_TOKEN, SECRET_PATH],
      );
      expectUnavailable(
        () => api.classifyAuditIntegrityAlertRetryDecision(accessorAttempt, 'accepted'),
        [SECRET_TOKEN, SECRET_PATH],
      );

      const accessorIso = {};
      Object.defineProperty(accessorIso, 'toString', {
        enumerable: true,
        configurable: true,
        get() {
          getterHits += 1;
          return LAST_ATTEMPT_AT;
        },
      });
      Object.defineProperty(accessorIso, 'valueOf', {
        enumerable: true,
        configurable: true,
        get() {
          getterHits += 1;
          return LAST_ATTEMPT_AT;
        },
      });
      expectUnavailable(
        () => api.computeAuditIntegrityAlertRetryDueAt(accessorIso, 1),
        [SECRET_TOKEN, SECRET_PATH],
      );

      expectUnavailable(
        () => api.computeAuditIntegrityAlertRetryDueAt(Object(LAST_ATTEMPT_AT), 1),
      );
      expectUnavailable(
        () => api.computeAuditIntegrityAlertRetryDueAt(LAST_ATTEMPT_AT, Object(1)),
      );
      expectUnavailable(
        () => api.classifyAuditIntegrityAlertRetryDecision(1, Object('accepted')),
      );

      assert.equal(getterHits, 0, 'policy helpers must not coerce via accessors');
    });

    it('rejects symbol / function / array hostile shapes with fixed unavailable', () => {
      const api = requireApi();
      const hostiles = [
        Symbol('iso'),
        () => LAST_ATTEMPT_AT,
        [LAST_ATTEMPT_AT],
        { iso: LAST_ATTEMPT_AT },
        new String(LAST_ATTEMPT_AT),
      ];
      for (const raw of hostiles) {
        expectUnavailable(
          () => api.computeAuditIntegrityAlertRetryDueAt(raw, 1),
          [SECRET_TOKEN, SECRET_PATH, SECRET_HOST],
        );
        expectUnavailable(
          () => api.computeAuditIntegrityAlertUncertainDueAt(
            LAST_ATTEMPT_AT,
            1,
            raw,
          ),
          [SECRET_TOKEN, SECRET_PATH, SECRET_HOST],
        );
      }
      for (const kind of [Symbol('kind'), () => 'accepted', ['accepted'], { kind: 'accepted' }]) {
        expectUnavailable(
          () => api.classifyAuditIntegrityAlertRetryDecision(1, kind),
          [SECRET_TOKEN, SECRET_PATH],
        );
      }
    });
  });
});
