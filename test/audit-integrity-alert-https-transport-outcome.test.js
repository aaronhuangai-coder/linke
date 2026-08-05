/**
 * Task 4 RED — pure detailed HTTP status outcome classifier.
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md (§9.2)
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-durable-retry-plan.md (Task 4)
 *   .superpowers/sdd/2026-08-05-audit-integrity-alert-durable-retry-plan/task-4-brief.md
 *
 * Production (absent on old HEAD):
 *   src/audit-integrity-alert-https-transport-outcome.js
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   test name + assert message = `transport detailed outcome implementation missing`
 * Full matrix registers only when the pure classifier export exists.
 *
 * Pure helper only: statusCode → frozen {schemaVersion, kind}.
 * No network, timers, filesystem, credentials, or transport wiring.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES } from '../src/error-codes.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-https-transport-outcome.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);
const PRODUCTION_MODULE_MARKER = 'audit-integrity-alert-https-transport-outcome';

const MISSING_MSG = 'transport detailed outcome implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

const RESULT_KEYS = Object.freeze(['schemaVersion', 'kind']);

const KIND_ACCEPTED = 'accepted';
const KIND_RETRYABLE = 'retryable-rejected';
const KIND_TERMINAL = 'terminal-rejected';

/**
 * Independently derived literal expectations (design §9.2):
 *   200..299 → accepted
 *   {408,425,429} or 500..599 → retryable-rejected
 *   every other safe integer → terminal-rejected
 * @type {readonly [number, 'accepted' | 'retryable-rejected' | 'terminal-rejected'][]}
 */
const STATUS_KIND_TABLE = Object.freeze([
  // Success-band neighbors and interiors
  [199, KIND_TERMINAL],
  [200, KIND_ACCEPTED],
  [299, KIND_ACCEPTED],
  [300, KIND_TERMINAL],
  // Explicit retryable set
  [408, KIND_RETRYABLE],
  [425, KIND_RETRYABLE],
  [429, KIND_RETRYABLE],
  // 5xx band boundaries
  [500, KIND_RETRYABLE],
  [599, KIND_RETRYABLE],
  // Terminal client/server examples
  [400, KIND_TERMINAL],
  [401, KIND_TERMINAL],
  [403, KIND_TERMINAL],
  [404, KIND_TERMINAL],
  [418, KIND_TERMINAL],
  [422, KIND_TERMINAL],
  [451, KIND_TERMINAL],
  [301, KIND_TERMINAL],
  // Edge neighbors around retryable islands
  [407, KIND_TERMINAL],
  [424, KIND_TERMINAL],
  [426, KIND_TERMINAL],
  [428, KIND_TERMINAL],
  [430, KIND_TERMINAL],
  [499, KIND_TERMINAL],
  [501, KIND_RETRYABLE],
  [598, KIND_RETRYABLE],
  [600, KIND_TERMINAL],
  // Safe integers outside HTTP range → terminal
  [-1, KIND_TERMINAL],
  [0, KIND_TERMINAL],
  [999, KIND_TERMINAL],
  [Number.MAX_SAFE_INTEGER, KIND_TERMINAL],
]);

/**
 * @typedef {{
 *   classifyAuditIntegrityAlertHttpStatusDetailedOutcome: Function,
 * }} OutcomeApi
 */

/** Empty frozen module surface while production is absent. */
/** @type {Readonly<Record<string, never>> | OutcomeApi} */
let outcomeApi = Object.freeze(Object.create(null));
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (typeof mod.classifyAuditIntegrityAlertHttpStatusDetailedOutcome === 'function') {
    outcomeApi = Object.freeze({
      classifyAuditIntegrityAlertHttpStatusDetailedOutcome:
        mod.classifyAuditIntegrityAlertHttpStatusDetailedOutcome,
    });
    implementationMissing = false;
  } else {
    // Module present but required export missing — keep empty frozen surface.
    outcomeApi = Object.freeze(Object.create(null));
    implementationMissing = true;
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
  outcomeApi = Object.freeze(Object.create(null));
}

/**
 * @returns {OutcomeApi}
 */
function requireApi() {
  if (
    implementationMissing
    || typeof /** @type {OutcomeApi} */ (outcomeApi)
      .classifyAuditIntegrityAlertHttpStatusDetailedOutcome !== 'function'
  ) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {OutcomeApi} */ (outcomeApi);
}

/**
 * Public-boundary failures are only the registered fixed LinkeError.
 * @param {unknown} error
 */
function assertUnavailable(error) {
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
  // Registered LinkeError own metadata (not the input response code): leave intact.
  return true;
}

/**
 * @param {() => unknown} fn
 */
function expectUnavailable(fn) {
  assert.throws(fn, (error) => {
    assertUnavailable(error);
    return true;
  });
}

/**
 * @param {unknown} obj
 * @param {readonly string[]} expected
 * @param {string} [label]
 */
function assertExactKeys(obj, expected, label = 'value') {
  assert.deepEqual(
    Object.keys(/** @type {object} */ (obj)),
    [...expected],
    `${label} must have exact key order ${expected.join(',')}`,
  );
}

/**
 * @param {unknown} value
 * @param {string} [path]
 */
function assertDeeplyFrozen(value, path = 'root') {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `expected frozen at ${path}`);
  for (const key of Object.keys(/** @type {object} */ (value))) {
    assertDeeplyFrozen(
      /** @type {Record<string, unknown>} */ (value)[key],
      `${path}.${key}`,
    );
  }
}

/**
 * Successful classifier result contract.
 * @param {unknown} result
 * @param {'accepted' | 'retryable-rejected' | 'terminal-rejected'} expectedKind
 * @param {string} [label]
 */
function assertDetailedOutcome(result, expectedKind, label = 'outcome') {
  assertExactKeys(result, RESULT_KEYS, label);
  assert.deepEqual(result, { schemaVersion: 1, kind: expectedKind });
  assertDeeplyFrozen(result, label);
  assert.equal(
    Object.prototype.hasOwnProperty.call(/** @type {object} */ (result), 'statusCode'),
    false,
    `${label} must not expose statusCode`,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(/** @type {object} */ (result), 'status'),
    false,
    `${label} must not expose public status field`,
  );
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('audit integrity alert HTTPS transport detailed outcome (Task 4 RED)', () => {
  // Old HEAD: exactly one dedicated RED. Full matrix only when export exists.
  if (implementationMissing) {
    it('transport detailed outcome implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  describe('1 export and fixed unavailable contract', () => {
    it('exports classifyAuditIntegrityAlertHttpStatusDetailedOutcome as a function', () => {
      const api = requireApi();
      assert.equal(
        typeof api.classifyAuditIntegrityAlertHttpStatusDetailedOutcome,
        'function',
      );
      assert.equal(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, CODE_UNAVAILABLE);
    });
  });

  describe('2 pure statusCode → detailed kind tables', () => {
    for (const [statusCode, expectedKind] of STATUS_KIND_TABLE) {
      it(`statusCode ${String(statusCode)} → ${expectedKind}`, () => {
        const api = requireApi();
        const result = api.classifyAuditIntegrityAlertHttpStatusDetailedOutcome(statusCode);
        assertDetailedOutcome(result, expectedKind, `status ${String(statusCode)}`);
      });
    }
  });

  describe('3 invalid / non-safe inputs fail closed (not terminal)', () => {
    // Explicit literal labels only — never coerce hostile fixtures (e.g. Object.create(null)).
    /** @type {readonly [string, unknown][]} */
    const invalidInputs = Object.freeze([
      ['undefined', undefined],
      ['null', null],
      ['string-200', '200'],
      ['200.5', 200.5],
      ['NaN', Number.NaN],
      ['true', true],
      ['false', false],
      ['Symbol(200)', Symbol('200')],
      ['200n', 200n],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      // Non-safe integers (outside Number.isSafeInteger)
      ['MAX_SAFE_INTEGER+1', Number.MAX_SAFE_INTEGER + 1],
      ['MIN_SAFE_INTEGER-1', Number.MIN_SAFE_INTEGER - 1],
      ['1.1', 1.1],
      ['-0.5', -0.5],
      ['plain-object', {}],
      ['array', []],
      ['null-prototype-object', Object.create(null)],
    ]);

    for (const [label, value] of invalidInputs) {
      it(`rejects invalid statusCode ${label} with fixed unavailable`, () => {
        const api = requireApi();
        expectUnavailable(() => {
          api.classifyAuditIntegrityAlertHttpStatusDetailedOutcome(value);
        });
      });
    }

    it('missing argument fails closed with fixed unavailable', () => {
      const api = requireApi();
      expectUnavailable(() => {
        api.classifyAuditIntegrityAlertHttpStatusDetailedOutcome();
      });
    });

    it('fail-closed path never returns a terminal kind object', () => {
      const api = requireApi();
      for (const value of [undefined, null, '200', 200.5, Number.NaN, true, 200n]) {
        let threw = false;
        try {
          const result = api.classifyAuditIntegrityAlertHttpStatusDetailedOutcome(value);
          // Must not soft-map invalid inputs into terminal-rejected.
          assert.notEqual(
            result && /** @type {{ kind?: unknown }} */ (result).kind,
            KIND_TERMINAL,
            'invalid input must not classify as terminal-rejected',
          );
          assert.fail('expected fixed unavailable throw for invalid statusCode');
        } catch (error) {
          threw = true;
          assertUnavailable(error);
        }
        assert.equal(threw, true);
      }
    });
  });

  describe('4 result shape is exact frozen keys only', () => {
    it('accepted result has exact own keys schemaVersion, kind in order', () => {
      const api = requireApi();
      const result = api.classifyAuditIntegrityAlertHttpStatusDetailedOutcome(204);
      assertDetailedOutcome(result, KIND_ACCEPTED);
      assert.deepEqual(Object.keys(/** @type {object} */ (result)), ['schemaVersion', 'kind']);
    });

    it('retryable and terminal results share the same exact frozen shape', () => {
      const api = requireApi();
      assertDetailedOutcome(
        api.classifyAuditIntegrityAlertHttpStatusDetailedOutcome(429),
        KIND_RETRYABLE,
      );
      assertDetailedOutcome(
        api.classifyAuditIntegrityAlertHttpStatusDetailedOutcome(404),
        KIND_TERMINAL,
      );
    });
  });
});
