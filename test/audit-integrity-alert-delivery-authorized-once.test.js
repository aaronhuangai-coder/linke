/**
 * Task 2 RED — authorize-before-claim one-shot delivery gate.
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-destination-allowlist-design.md
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-destination-allowlist-plan.md (Task 2)
 *
 * Production (absent on old HEAD):
 *   src/audit-integrity-alert-delivery-authorized-once.js
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   test name + assert message = `authorized one-shot delivery implementation missing`
 * Full matrix registers only when both public factory exports exist.
 *
 * Pure injected authorize/deliverOnce branch matrix + production factory binding.
 * Production seam uses existing empty mkdtemp dataDir so deny-all cannot be
 * confused with real one-shot empty-receipt success. No real network, DNS,
 * TLS, HTTPS request, fetch, or external I/O.
 * Does not claim Gold / remote delivery readiness.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES, LinkeError } from '../src/error-codes.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-authorized-once.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);

const MISSING_MSG = 'authorized one-shot delivery implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

/** Exact ordered deps keys for the test factory (string enumerable own keys). */
const DEPS_KEYS = Object.freeze(['authorizeDestination', 'deliverOnce']);

/** Valid allowlisted-style destinations (not reserved .example/.invalid suffixes). */
const ENDPOINT_A = 'https://alerts.acme.com/hooks/audit-integrity';
const ENDPOINT_B = 'https://hooks.ops.acme.com/v1/alerts';
const DATA_DIR = '/safe/secret-data-dir-authorized-once';
const DATA_DIR_OBJ = Object.freeze({ path: DATA_DIR, marker: 'data-dir-identity' });
const FIXED_NOW = '2026-08-04T12:00:00.000Z';
const FIXED_NOW_OBJ = Object.freeze({ iso: FIXED_NOW, marker: 'now-identity' });

const SECRET_TOKEN = 'Bearer secret-token-xyz';
const SECRET_PATH = '/Users/ah/secret/audit-authorized-once.json';
const SECRET_HOST = 'evil-cert.acme.com';
const SECRET_CLAIM = 'a1111111-b111-4111-8111-e11111111111';
const SECRET_BODY = '{"body-secret":"do-not-leak"}';
const SECRET_HEADER = 'authorization: Bearer leak-token';

const EMPTY_RECEIPT_KEYS = Object.freeze(['schemaVersion', 'status', 'delivered']);

/** @type {null | {
 *   createAuthorizedAuditIntegrityAlertDeliveryOnce: Function,
 *   createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting: Function,
 * }} */
let authorizedApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.createAuthorizedAuditIntegrityAlertDeliveryOnce === 'function'
    && typeof mod.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting === 'function'
  ) {
    authorizedApi = {
      createAuthorizedAuditIntegrityAlertDeliveryOnce:
        mod.createAuthorizedAuditIntegrityAlertDeliveryOnce,
      createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting:
        mod.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    authorizedApi = null;
  } else {
    // Syntax/load errors in an existing production module must surface as themselves.
    throw error;
  }
}

function requireApi() {
  if (implementationMissing || authorizedApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {NonNullable<typeof authorizedApi>} */ (authorizedApi);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Exact key order using Object.keys (string enumerable own keys only).
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
 * Business secrets / caller input tokens that must never appear on the public
 * error surface (fields or stack). Local source paths in stack frames are not
 * treated as product leaks (no /private|/tmp environment-fragile checks).
 * @param {string[]} [extra]
 * @returns {string[]}
 */
function businessLeakTokens(extra = []) {
  return [
    ENDPOINT_A,
    ENDPOINT_B,
    DATA_DIR,
    FIXED_NOW,
    SECRET_TOKEN,
    SECRET_PATH,
    SECRET_HOST,
    SECRET_CLAIM,
    SECRET_BODY,
    SECRET_HEADER,
    'alerts.acme.com',
    'hooks.ops.acme.com',
    'authorization',
    'Bearer',
    'claimId',
    'idempotency',
    ...extra,
  ];
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

  const tokens = businessLeakTokens(leakTokens);

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

  for (const token of tokens) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `public error must not leak ${token}`);
  }

  // Stack may legally include local source paths; only ban business secrets/inputs.
  const stack = /** @type {{ stack?: unknown }} */ (error).stack;
  if (typeof stack === 'string') {
    for (const token of tokens) {
      if (!token || token.length < 2) continue;
      assert.equal(stack.includes(token), false, `stack must not leak ${token}`);
    }
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
 * @param {Promise<unknown>} promise
 * @param {string[]} [leakTokens]
 */
async function expectUnavailableAsync(promise, leakTokens = []) {
  await assert.rejects(promise, (error) => {
    assertUnavailable(error, leakTokens);
    return true;
  });
}

/**
 * Canonical empty one-shot public receipt (identity fixture for pass-through).
 * @returns {Readonly<{ schemaVersion: number, status: string, delivered: boolean }>}
 */
function emptyReceipt() {
  return Object.freeze({
    schemaVersion: 1,
    status: 'empty',
    delivered: false,
  });
}

/**
 * Counting authorize/deliverOnce harness.
 * Captures full rest-args arrays so arity regressions are visible.
 * @param {{
 *   authorize?: (...args: unknown[]) => unknown,
 *   deliver?: (...args: unknown[]) => unknown,
 * }} [script]
 */
function createHarness(script = {}) {
  /** @type {unknown[][]} */
  const authorizeArgs = [];
  /** @type {unknown[][]} */
  const deliverArgs = [];
  /** @type {string[]} */
  const order = [];

  const deps = {
    authorizeDestination(...args) {
      order.push('authorize');
      authorizeArgs.push(args);
      if (typeof script.authorize === 'function') {
        return script.authorize(...args);
      }
      // Default: echo the endpoint primitive (bit-identical success path).
      return args[0];
    },
    async deliverOnce(...args) {
      order.push('deliver');
      deliverArgs.push(args);
      if (typeof script.deliver === 'function') {
        return script.deliver(...args);
      }
      return emptyReceipt();
    },
  };

  assertExactKeys(deps, DEPS_KEYS, 'harness deps');

  return {
    deps,
    authorizeArgs,
    deliverArgs,
    order,
    counts() {
      return {
        authorize: authorizeArgs.length,
        deliver: deliverArgs.length,
      };
    },
  };
}

/**
 * Existing empty dataDir for production seam tests (deny vs empty-receipt falsifiable).
 * @param {(root: string) => Promise<unknown>} fn
 */
async function withEmptyDataDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'linke-authorized-once-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} root
 */
async function assertDataDirEmpty(root) {
  const entries = await readdir(root);
  assert.deepEqual(
    entries,
    [],
    'dataDir must remain empty (no claim/outbox/stream artifacts)',
  );
}

/**
 * @param {ReturnType<typeof requireApi>} api
 * @param {ReturnType<typeof createHarness>} harness
 */
function deliverWith(api, harness) {
  return api.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting(harness.deps);
}

/**
 * Hostile conversion surface that must never be probed.
 * @param {string} secret
 */
function makeConversionTrap(secret) {
  let hits = 0;
  const value = {
    [Symbol.toPrimitive]() {
      hits += 1;
      throw new Error(`toPrimitive:${secret}`);
    },
    valueOf() {
      hits += 1;
      throw new Error(`valueOf:${secret}`);
    },
    toString() {
      hits += 1;
      throw new Error(`toString:${secret}`);
    },
  };
  return {
    value,
    get hits() {
      return hits;
    },
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('audit integrity alert delivery authorized once (Task 2 RED)', () => {
  // Old HEAD: exactly one dedicated RED. Full matrix only when both exports exist.
  if (implementationMissing || authorizedApi === null) {
    it('authorized one-shot delivery implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── 1. Exports + test-factory deps contract ─────────────────────────────

  describe('1 exports and test-factory deps contract', () => {
    it('exports production and test factories; registered fixed error code', () => {
      const api = requireApi();
      assert.equal(typeof api.createAuthorizedAuditIntegrityAlertDeliveryOnce, 'function');
      assert.equal(
        typeof api.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting,
        'function',
      );
      assert.equal(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, CODE_UNAVAILABLE);
    });

    it('test factory returns an async delivery function', async () => {
      const api = requireApi();
      const harness = createHarness();
      const deliver = deliverWith(api, harness);
      assert.equal(typeof deliver, 'function');
      const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
      assertExactKeys(receipt, EMPTY_RECEIPT_KEYS, 'empty receipt');
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'empty',
        delivered: false,
      });
    });

    it('factory rejects missing/extra/reordered/non-function/hostile deps without traps', () => {
      const api = requireApi();
      const good = createHarness();
      let trapHits = 0;
      const trapProxy = new Proxy(good.deps, {
        get(_t, prop) {
          trapHits += 1;
          throw new Error(`trap-get:${String(prop)}:${SECRET_PATH}`);
        },
        ownKeys() {
          trapHits += 1;
          throw new Error(`trap-ownKeys:${SECRET_TOKEN}`);
        },
        getOwnPropertyDescriptor() {
          trapHits += 1;
          throw new Error(`trap-desc:${SECRET_HOST}`);
        },
        getPrototypeOf() {
          trapHits += 1;
          throw new Error(`trap-proto:${SECRET_CLAIM}`);
        },
        has() {
          trapHits += 1;
          throw new Error(`trap-has:${SECRET_BODY}`);
        },
      });

      const { proxy: revokedProxy, revoke } = Proxy.revocable(
        {
          authorizeDestination: good.deps.authorizeDestination,
          deliverOnce: good.deps.deliverOnce,
        },
        {},
      );
      revoke();

      const accessorDeps = {};
      Object.defineProperty(accessorDeps, 'authorizeDestination', {
        enumerable: true,
        get() {
          trapHits += 1;
          throw new Error(`accessor-auth:${SECRET_PATH}`);
        },
      });
      Object.defineProperty(accessorDeps, 'deliverOnce', {
        enumerable: true,
        get() {
          trapHits += 1;
          throw new Error(`accessor-deliver:${SECRET_TOKEN}`);
        },
      });

      const nonEnum = {
        authorizeDestination: good.deps.authorizeDestination,
        deliverOnce: good.deps.deliverOnce,
      };
      Object.defineProperty(nonEnum, 'hidden', {
        value: SECRET_TOKEN,
        enumerable: false,
      });

      const withSymbol = {
        authorizeDestination: good.deps.authorizeDestination,
        deliverOnce: good.deps.deliverOnce,
        [Symbol('leak')]: SECRET_PATH,
      };

      class DepsClass {
        constructor() {
          this.authorizeDestination = good.deps.authorizeDestination;
          this.deliverOnce = good.deps.deliverOnce;
        }
      }

      const cases = [
        null,
        undefined,
        [],
        'deps',
        1,
        true,
        { deliverOnce: good.deps.deliverOnce },
        { authorizeDestination: good.deps.authorizeDestination },
        {
          authorizeDestination: good.deps.authorizeDestination,
          deliverOnce: good.deps.deliverOnce,
          extra: () => {},
        },
        {
          deliverOnce: good.deps.deliverOnce,
          authorizeDestination: good.deps.authorizeDestination,
        },
        {
          authorizeDestination: 'not-fn',
          deliverOnce: good.deps.deliverOnce,
        },
        {
          authorizeDestination: good.deps.authorizeDestination,
          deliverOnce: null,
        },
        {
          authorizeDestination: good.deps.authorizeDestination,
          deliverOnce: 1,
        },
        new Proxy(good.deps, {}),
        trapProxy,
        revokedProxy,
        accessorDeps,
        nonEnum,
        withSymbol,
        new DepsClass(),
      ];

      for (const deps of cases) {
        expectUnavailable(
          () => api.createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting(deps),
          [SECRET_PATH, SECRET_TOKEN, SECRET_HOST, SECRET_CLAIM, SECRET_BODY],
        );
      }
      assert.equal(trapHits, 0, 'hostile Proxy/accessor traps must never fire');
    });

    it('factory snapshots function refs; later deps mutation does not rebind', async () => {
      const api = requireApi();
      const harness = createHarness({
        deliver: () => emptyReceipt(),
      });
      const deliver = deliverWith(api, harness);

      harness.deps.authorizeDestination = () => {
        assert.fail('mutated authorizeDestination must not run');
      };
      harness.deps.deliverOnce = async () => {
        assert.fail('mutated deliverOnce must not run');
      };

      const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
      assert.deepEqual(receipt, {
        schemaVersion: 1,
        status: 'empty',
        delivered: false,
      });
      assert.deepEqual(harness.counts(), { authorize: 1, deliver: 1 });
      assert.deepEqual(harness.order, ['authorize', 'deliver']);
    });
  });

  // ── 2. Call order, identity, authorize output contract ──────────────────

  describe('2 authorize-before-deliver order, identity, authorized output', () => {
    it('calls authorize then deliverOnce exactly once with original identities', async () => {
      const api = requireApi();
      const dataDir = DATA_DIR_OBJ;
      const endpoint = ENDPOINT_A;
      const now = FIXED_NOW_OBJ;

      const harness = createHarness({
        authorize: (...args) => {
          assert.equal(args.length, 1, 'authorizeDestination arity must be 1');
          assert.equal(args[0], endpoint);
          assert.equal(typeof args[0], 'string');
          return args[0];
        },
        deliver: (...args) => {
          assert.equal(args.length, 3, 'deliverOnce arity must be 3');
          assert.equal(args[0], dataDir);
          assert.equal(args[1], endpoint);
          assert.equal(args[2], now);
          return emptyReceipt();
        },
      });

      const deliver = deliverWith(api, harness);
      await deliver(dataDir, endpoint, now);

      assert.deepEqual(harness.order, ['authorize', 'deliver']);
      assert.deepEqual(harness.counts(), { authorize: 1, deliver: 1 });
      // rest-args capture: full call arity, no extra parameters.
      assert.equal(harness.authorizeArgs.length, 1);
      assert.equal(harness.authorizeArgs[0].length, 1);
      assert.equal(harness.authorizeArgs[0][0], endpoint);
      assert.equal(harness.deliverArgs.length, 1);
      assert.equal(harness.deliverArgs[0].length, 3);
      assert.deepEqual(harness.deliverArgs[0], [dataDir, endpoint, now]);
      // authorize 只收到 endpoint；deliverOnce 只收到三元组，精确一次。
      assert.equal(harness.authorizeArgs[0][0] === endpoint, true);
      assert.equal(harness.deliverArgs[0][0] === dataDir, true);
      assert.equal(harness.deliverArgs[0][2] === now, true);
    });

    it('authorize deny/throw/malformed output yields zero deliverOnce', async () => {
      const api = requireApi();

      {
        const harness = createHarness({
          authorize: () => {
            throw new Error(`deny ${ENDPOINT_A} token=${SECRET_TOKEN} path=${SECRET_PATH}`);
          },
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [ENDPOINT_A, DATA_DIR, SECRET_TOKEN, SECRET_PATH, 'deny'],
        );
        assert.deepEqual(harness.counts(), { authorize: 1, deliver: 0 });
        assert.deepEqual(harness.order, ['authorize']);
      }

      {
        // Fixed LinkeError deny must still converge to a *fresh* path-free error.
        const original = new LinkeError(CODE_UNAVAILABLE);
        const harness = createHarness({
          authorize: () => {
            throw original;
          },
        });
        const deliver = deliverWith(api, harness);
        await assert.rejects(deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW), (error) => {
          assertUnavailable(error, [ENDPOINT_A, DATA_DIR]);
          assert.notEqual(error, original, 'must rethrow fresh LinkeError, not original');
          return true;
        });
        assert.equal(harness.counts().deliver, 0);
      }

      const conversion = makeConversionTrap(SECRET_PATH);
      const malformedOutputs = [
        null,
        undefined,
        0,
        1,
        true,
        false,
        ENDPOINT_B, // different primitive string
        new String(ENDPOINT_A),
        Buffer.from(ENDPOINT_A),
        new URL(ENDPOINT_A),
        { endpoint: ENDPOINT_A },
        new Proxy({ value: ENDPOINT_A }, {}),
        Promise.resolve(ENDPOINT_A),
        { then: (r) => r(ENDPOINT_A) },
        conversion.value,
        Object(ENDPOINT_A),
      ];

      for (const bad of malformedOutputs) {
        const harness = createHarness({
          authorize: () => bad,
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [ENDPOINT_A, ENDPOINT_B, DATA_DIR, SECRET_PATH, SECRET_TOKEN],
        );
        assert.equal(harness.counts().deliver, 0, 'malformed authorize must not call deliverOnce');
      }
      assert.equal(conversion.hits, 0, 'must not trigger conversion traps on authorize output');
    });

    it('authorize success requires primitive string bit-identical to endpoint', async () => {
      const api = requireApi();

      // Same content, different string instance is still bit-identical via === for interned
      // literals, so use endpoint.slice(0) which is equal by value and by === for primitives
      // when content matches — string primitives compare by content. Use a *different* content
      // for reject, and same content for accept.
      {
        const harness = createHarness({
          authorize: (ep) => {
            assert.equal(typeof ep, 'string');
            // Return a new primitive with identical content (=== holds for string primitives).
            return `${ep}`;
          },
        });
        const deliver = deliverWith(api, harness);
        const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
        assert.deepEqual(receipt, {
          schemaVersion: 1,
          status: 'empty',
          delivered: false,
        });
        assert.equal(harness.deliverArgs[0].length, 3);
        assert.equal(harness.deliverArgs[0][1], ENDPOINT_A);
      }

      // Whitespace / case / trailing slash differences are not bit-identical.
      const nearMisses = [
        `${ENDPOINT_A} `,
        ` ${ENDPOINT_A}`,
        ENDPOINT_A.toUpperCase(),
        `${ENDPOINT_A}/`,
        ENDPOINT_B,
      ];
      for (const near of nearMisses) {
        const harness = createHarness({
          authorize: () => near,
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [ENDPOINT_A, near, DATA_DIR],
        );
        assert.equal(harness.counts().deliver, 0);
      }
    });

    it('passes through async deliverOnce result identity including frozen receipt', async () => {
      const api = requireApi();
      const frozen = emptyReceipt();
      assert.equal(Object.isFrozen(frozen), true);

      const harness = createHarness({
        deliver: async () => frozen,
      });
      const deliver = deliverWith(api, harness);
      const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
      assert.equal(receipt, frozen, 'frozen receipt identity must pass through');
      assertExactKeys(receipt, EMPTY_RECEIPT_KEYS, 'receipt');
    });
  });

  // ── 3. Hostile settle / failure convergence ─────────────────────────────

  describe('3 hostile settle and public failure convergence', () => {
    it('deliverOnce throw/reject converges to fresh path-free unavailable', async () => {
      const api = requireApi();

      {
        const harness = createHarness({
          deliver: () => {
            throw new Error(
              `deliver fail endpoint=${ENDPOINT_A} dir=${DATA_DIR} claim=${SECRET_CLAIM} `
              + `token=${SECRET_TOKEN} body=${SECRET_BODY} header=${SECRET_HEADER}`,
            );
          },
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [
            ENDPOINT_A,
            DATA_DIR,
            SECRET_CLAIM,
            SECRET_TOKEN,
            SECRET_BODY,
            SECRET_HEADER,
            'deliver fail',
          ],
        );
        assert.deepEqual(harness.counts(), { authorize: 1, deliver: 1 });
      }

      {
        const harness = createHarness({
          deliver: async () => {
            throw new Error(`async reject ${SECRET_PATH} ${SECRET_HOST}`);
          },
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [SECRET_PATH, SECRET_HOST, DATA_DIR, ENDPOINT_A],
        );
      }

      {
        const original = new LinkeError(CODE_UNAVAILABLE);
        const harness = createHarness({
          deliver: async () => {
            throw original;
          },
        });
        const deliver = deliverWith(api, harness);
        await assert.rejects(deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW), (error) => {
          assertUnavailable(error);
          assert.notEqual(error, original);
          return true;
        });
      }
    });

    it('hostile thenable from deliverOnce converges; normal Promise is not hostile', async () => {
      const api = requireApi();

      // Normal Promise — must succeed and pass value through.
      {
        const frozen = emptyReceipt();
        const harness = createHarness({
          deliver: () => Promise.resolve(frozen),
        });
        const deliver = deliverWith(api, harness);
        const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
        assert.equal(receipt, frozen);
        assert.deepEqual(harness.counts(), { authorize: 1, deliver: 1 });
      }

      // Async function return (real Promise) — not hostile.
      {
        const harness = createHarness({
          deliver: async () => emptyReceipt(),
        });
        const deliver = deliverWith(api, harness);
        const receipt = await deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW);
        assert.deepEqual(receipt, {
          schemaVersion: 1,
          status: 'empty',
          delivered: false,
        });
      }

      // Hostile thenable: getter on `then` throws with secret material.
      {
        let thenHits = 0;
        const harness = createHarness({
          deliver: () => ({
            get then() {
              thenHits += 1;
              throw new Error(`hostile-thenable:${SECRET_TOKEN}:${SECRET_PATH}`);
            },
          }),
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [SECRET_TOKEN, SECRET_PATH, ENDPOINT_A, DATA_DIR, 'hostile-thenable'],
        );
        assert.equal(harness.counts().deliver, 1);
        // then may be probed by await; public error still must not leak.
        assert.ok(thenHits >= 0);
      }

      // Thenable that rejects with secret.
      {
        const harness = createHarness({
          deliver: () => ({
            then(_resolve, reject) {
              reject(new Error(`thenable-reject:${SECRET_HOST}:${SECRET_CLAIM}`));
            },
          }),
        });
        const deliver = deliverWith(api, harness);
        await expectUnavailableAsync(
          deliver(DATA_DIR, ENDPOINT_A, FIXED_NOW),
          [SECRET_HOST, SECRET_CLAIM, ENDPOINT_A, DATA_DIR],
        );
      }
    });

    it('public errors omit endpoint/dataDir/claim/body/header/token/path/cause', async () => {
      const api = requireApi();
      const leak = [
        ENDPOINT_A,
        ENDPOINT_B,
        DATA_DIR,
        SECRET_TOKEN,
        SECRET_PATH,
        SECRET_HOST,
        SECRET_CLAIM,
        SECRET_BODY,
        SECRET_HEADER,
        'authorization',
        'claimId',
      ];

      const cases = [
        async () => {
          const harness = createHarness({
            authorize: () => {
              throw new Error(`auth ${ENDPOINT_A} ${SECRET_TOKEN}`);
            },
          });
          await expectUnavailableAsync(
            deliverWith(api, harness)(DATA_DIR, ENDPOINT_A, FIXED_NOW),
            leak,
          );
        },
        async () => {
          const harness = createHarness({
            authorize: () => ENDPOINT_B,
          });
          await expectUnavailableAsync(
            deliverWith(api, harness)(DATA_DIR, ENDPOINT_A, FIXED_NOW),
            leak,
          );
        },
        async () => {
          const harness = createHarness({
            deliver: () => {
              throw new Error(`wire ${SECRET_BODY} ${SECRET_HEADER}`);
            },
          });
          await expectUnavailableAsync(
            deliverWith(api, harness)(DATA_DIR, ENDPOINT_A, FIXED_NOW),
            leak,
          );
        },
      ];

      for (const run of cases) {
        await run();
      }
    });
  });

  // ── 4. Production factory binding ───────────────────────────────────────

  describe('4 production factory binding (no real network)', () => {
    it('missing/null/exact empty policy deny-all without entering real one-shot/claim', async () => {
      const api = requireApi();
      // 存在且为空的 dataDir：若错误进入 real one-shot，空 outbox 会返回 empty receipt
      // 而非 fixed unavailable，从而本用例必须失败（可证伪 deny 与误入 one-shot）。
      await withEmptyDataDir(async (root) => {
        for (const policy of [undefined, null, { schemaVersion: 1, endpoints: [] }]) {
          const deliver = api.createAuthorizedAuditIntegrityAlertDeliveryOnce(policy);
          assert.equal(typeof deliver, 'function');
          await expectUnavailableAsync(
            deliver(root, ENDPOINT_A, FIXED_NOW),
            [ENDPOINT_A, root, SECRET_TOKEN],
          );
          await assertDataDirEmpty(root);
        }
      });
    });

    it('configured policy allows exact endpoint identity into real one-shot boundary', async () => {
      const api = requireApi();
      // 存在空 dataDir：non-member 必须在 authorize 拒绝且无 artifact；
      // member 进入真实 one-shot 并返回 exact empty receipt（仍无 DNS/HTTPS）。
      await withEmptyDataDir(async (root) => {
        const deliver = api.createAuthorizedAuditIntegrityAlertDeliveryOnce({
          schemaVersion: 1,
          endpoints: [ENDPOINT_A],
        });
        assert.equal(typeof deliver, 'function');

        // Non-member: deny before claim/one-shot (path-free unavailable, no artifacts).
        await expectUnavailableAsync(
          deliver(root, ENDPOINT_B, FIXED_NOW),
          [ENDPOINT_A, ENDPOINT_B, root],
        );
        await assertDataDirEmpty(root);

        // Member: authorize passes → real one-shot → exact empty receipt (empty outbox).
        const receipt = await deliver(root, ENDPOINT_A, FIXED_NOW);
        assertExactKeys(receipt, EMPTY_RECEIPT_KEYS, 'real empty receipt');
        assert.deepEqual(receipt, {
          schemaVersion: 1,
          status: 'empty',
          delivered: false,
        });
        await assertDataDirEmpty(root);
      });
    });

    it('production factory policy compile failure converges to fixed unavailable', () => {
      const api = requireApi();
      const badPolicies = [
        { schemaVersion: 2, endpoints: [ENDPOINT_A] },
        { endpoints: [ENDPOINT_A] },
        { schemaVersion: 1 },
        { schemaVersion: 1, endpoints: [ENDPOINT_A], extra: true },
        { schemaVersion: 1, endpoints: 'not-array' },
        { schemaVersion: 1, endpoints: [ENDPOINT_A, ENDPOINT_A] },
        [],
        'policy',
        1,
        true,
        new Proxy({ schemaVersion: 1, endpoints: [ENDPOINT_A] }, {}),
      ];

      for (const policy of badPolicies) {
        // 编译失败必须在 factory 同步 throw fixed unavailable（不允许延迟到 delivery）。
        expectUnavailable(
          () => api.createAuthorizedAuditIntegrityAlertDeliveryOnce(policy),
          [ENDPOINT_A, SECRET_TOKEN, SECRET_PATH],
        );
      }
    });
  });

  // ── 5. Structural source scan ───────────────────────────────────────────

  describe('5 structural source scan', () => {
    it('imports only util/policy/one-shot/error-codes; authorize-before-deliver gate; no DNS/request/timer/fs/env/Agent/API/Web/scheduler', async () => {
      const source = await readFile(PRODUCTION_MODULE_PATH, 'utf8');

      const importRe = /\bfrom\s+['"]([^'"]+)['"]/g;
      /** @type {string[]} */
      const imports = [];
      for (const match of source.matchAll(importRe)) {
        imports.push(match[1]);
      }

      const allowed = new Set([
        'node:util',
        './audit-integrity-alert-destination-policy.js',
        './audit-integrity-alert-delivery-once.js',
        './error-codes.js',
      ]);
      for (const imp of imports) {
        assert.equal(allowed.has(imp), true, `unexpected import: ${imp}`);
      }
      for (const required of [
        'node:util',
        './audit-integrity-alert-destination-policy.js',
        './audit-integrity-alert-delivery-once.js',
        './error-codes.js',
      ]) {
        assert.equal(imports.includes(required), true, `missing required import: ${required}`);
      }

      // Positive surface anchors (including production policy → capability.authorize binding).
      for (const required of [
        'createAuthorizedAuditIntegrityAlertDeliveryOnce',
        'createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting',
        'createAuditIntegrityAlertDestinationPolicy',
        'deliverAuditIntegrityAlertOnce',
        'AUDIT_DELIVERY_UNAVAILABLE',
        'authorizeDestination',
        'deliverOnce',
        'capability.authorize',
      ]) {
        assert.equal(
          source.includes(required),
          true,
          `expected production surface: ${required}`,
        );
      }

      // Single bounded runtime gate: real code form only (not JSDoc / DEPS_KEYS).
      // Starts at `const authorized = authorizeDestination(endpoint);`, ends at
      // `return await deliverOnce(dataDir, authorized, now);`, with a small span for
      // the two typeof/identity checks + comments.
      const runtimeGateRe =
        /const\s+authorized\s*=\s*authorizeDestination\s*\(\s*endpoint\s*\)\s*;[\s\S]{0,500}?return\s+await\s+deliverOnce\s*\(\s*dataDir\s*,\s*authorized\s*,\s*now\s*\)\s*;/;
      assert.ok(
        runtimeGateRe.test(source),
        'source must contain runtime gate: const authorized = authorizeDestination(endpoint); … return await deliverOnce(dataDir, authorized, now);',
      );

      // Production policy + one-shot binding names present.
      assert.ok(source.includes('createAuditIntegrityAlertDestinationPolicy'));
      assert.ok(source.includes('deliverAuditIntegrityAlertOnce'));
      // claim gate proof: no direct claim import; only via deliverOnce binding.
      assert.equal(
        source.includes('claimAuditIntegrityAlertDelivery'),
        false,
        'authorized-once must not import/call claim directly; gate via deliverOnce only',
      );

      for (const forbidden of [
        'node:https',
        'node:http',
        'node:net',
        'node:tls',
        'node:dns',
        'node:dgram',
        'node:fs',
        'node:fs/promises',
        'fs/promises',
        'node:path',
        'node:child_process',
        'fetch(',
        'globalThis.fetch',
        'node-fetch',
        'undici',
        'process.env',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'NODE_EXTRA_CA_CERTS',
        'Date.now',
        'setTimeout(',
        'setInterval(',
        'setImmediate(',
        'retry',
        'backoff',
        'dead-letter',
        'deadLetter',
        'scheduler',
        'createServer',
        'https.Agent',
        'http.Agent',
        'new Agent',
        'dns.lookup',
        'dns.resolve',
        'lookupAll',
        'readFileSync',
        'writeFileSync',
        'keychain',
        'credential',
        "from './agent.js'",
        "from './server.js'",
        "from './web/",
        "from '../web/",
        'audit-integrity-alert-https-transport',
        'audit-integrity-alert-delivery-claim',
        'audit-integrity-alert-outbox',
        'audit-integrity-alert-delivery-stream',
        'gold-readiness',
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `forbidden production surface: ${forbidden}`,
        );
      }
    });
  });
});
