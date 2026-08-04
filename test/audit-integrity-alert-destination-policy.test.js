/**
 * Task 1 RED — exact audit-integrity alert destination allowlist policy.
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-destination-allowlist-design.md
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-destination-allowlist-plan.md (Task 1)
 *
 * Production (absent on old HEAD):
 *   src/audit-integrity-alert-destination-policy.js
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   test name + assert message = `destination policy implementation missing`
 * Full matrix registers only when createAuditIntegrityAlertDestinationPolicy exists.
 *
 * Pure policy compile + authorize only. No env, fs, DNS, network, timers, or credentials.
 * Does not claim Gold / remote delivery readiness.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES } from '../src/error-codes.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-destination-policy.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);

const MISSING_MSG = 'destination policy implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

const CAPABILITY_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'endpointCount',
  'authorize',
]);
const POLICY_KEYS = Object.freeze(['schemaVersion', 'endpoints']);

/** Valid allowlisted destinations (must NOT use reserved suffixes .example/.invalid/...). */
const ENDPOINT_A = 'https://alerts.acme.com/hooks/audit-integrity';
const ENDPOINT_B = 'https://hooks.ops.acme.com/v1/alerts';
const ENDPOINT_C = 'https://a.co/x';
const SECRET_TOKEN = 'Bearer secret-token-xyz';
const SECRET_PATH = '/Users/ah/secret/audit-policy.json';
const SECRET_HOST = 'evil-cert.acme.com';

/** @type {null | { createAuditIntegrityAlertDestinationPolicy: Function }} */
let policyApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (typeof mod.createAuditIntegrityAlertDestinationPolicy === 'function') {
    policyApi = {
      createAuditIntegrityAlertDestinationPolicy:
        mod.createAuditIntegrityAlertDestinationPolicy,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    policyApi = null;
  } else {
    // Syntax/load errors in an existing production module must surface as themselves.
    throw error;
  }
}

function requireApi() {
  if (implementationMissing || policyApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {NonNullable<typeof policyApi>} */ (policyApi);
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
 * Deep freeze walk; functions are terminal leaves.
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
    ENDPOINT_A,
    ENDPOINT_B,
    ENDPOINT_C,
    'alerts.acme.com',
    'hooks.ops.acme.com',
    SECRET_TOKEN,
    SECRET_HOST,
    SECRET_PATH,
    'authorization',
    'Bearer',
    'schemaVersion',
    'endpoints',
    '/Users/',
    '/var/',
    '/private/',
    '/tmp/',
    'policy',
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
 * Canonical plain-data policy with exact key order schemaVersion → endpoints.
 * @param {unknown[]} [endpoints]
 * @param {Partial<{ schemaVersion: unknown, endpoints: unknown }>} [overrides]
 */
function validPolicy(endpoints = [ENDPOINT_A], overrides = {}) {
  const schemaVersion = Object.prototype.hasOwnProperty.call(overrides, 'schemaVersion')
    ? overrides.schemaVersion
    : 1;
  const eps = Object.prototype.hasOwnProperty.call(overrides, 'endpoints')
    ? overrides.endpoints
    : endpoints;
  return {
    schemaVersion,
    endpoints: eps,
  };
}

/**
 * @param {unknown} capability
 * @param {'deny-all' | 'configured'} status
 * @param {number} endpointCount
 */
function assertCapabilityShape(capability, status, endpointCount) {
  assert.equal(typeof capability, 'object');
  assert.notEqual(capability, null);
  assertExactKeys(capability, CAPABILITY_KEYS, 'capability');
  assert.equal(/** @type {{ schemaVersion: unknown }} */ (capability).schemaVersion, 1);
  assert.equal(/** @type {{ status: unknown }} */ (capability).status, status);
  assert.equal(
    /** @type {{ endpointCount: unknown }} */ (capability).endpointCount,
    endpointCount,
  );
  assert.equal(
    typeof /** @type {{ authorize: unknown }} */ (capability).authorize,
    'function',
  );
  assertDeeplyFrozen(capability);
  // Capability surface must not export allowlist contents or path-like fields.
  assert.equal(
    Object.prototype.hasOwnProperty.call(/** @type {object} */ (capability), 'endpoints'),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(/** @type {object} */ (capability), 'policy'),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(/** @type {object} */ (capability), 'endpoint'),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(/** @type {object} */ (capability), 'token'),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(/** @type {object} */ (capability), 'path'),
    false,
  );
}

/**
 * Capability string walk must not embed allowlist/secret material (authorize not invoked).
 * @param {unknown} capability
 * @param {string[]} leakTokens
 */
function assertCapabilitySanitized(capability, leakTokens) {
  const parts = [
    ...Object.keys(/** @type {object} */ (capability)),
    String(/** @type {{ schemaVersion: unknown }} */ (capability).schemaVersion),
    String(/** @type {{ status: unknown }} */ (capability).status),
    String(/** @type {{ endpointCount: unknown }} */ (capability).endpointCount),
  ].join('\0');
  for (const token of leakTokens) {
    if (!token || token.length < 2) continue;
    assert.equal(
      parts.includes(token),
      false,
      `capability surface must not embed ${token}`,
    );
  }
}

/**
 * Build N distinct valid HTTPS endpoints under acme.com.
 * @param {number} n
 * @returns {string[]}
 */
function nEndpoints(n) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const label = `e${String(i).padStart(2, '0')}`;
    out.push(`https://${label}.acme.com/hooks/h${i}`);
  }
  return out;
}

/**
 * Pad a path under a fixed host to an exact pathname length (including leading /).
 * @param {number} pathLen
 * @param {string} [host]
 */
function endpointWithPathLength(pathLen, host = 'a.co') {
  assert.ok(pathLen >= 1);
  const path = `/${'p'.repeat(pathLen - 1)}`;
  assert.equal(path.length, pathLen);
  return `https://${host}${path}`;
}

/**
 * Build an endpoint string of exact UTF-8 byte length by padding the path.
 * Used for oversize reject fixtures only: lengths above the independent
 * pathname cap (1024) are intentionally illegal overall, not "valid-at-2048".
 * @param {number} byteLength
 */
function endpointWithByteLength(byteLength) {
  const prefix = 'https://a.co/';
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  assert.ok(byteLength >= prefixBytes + 0);
  const pad = 'x'.repeat(byteLength - prefixBytes);
  const url = `${prefix}${pad}`;
  assert.equal(Buffer.byteLength(url, 'utf8'), byteLength);
  return url;
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

function sumTraps(traps) {
  return Object.values(traps).reduce((a, b) => a + b, 0);
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('audit integrity alert destination policy (Task 1 RED)', () => {
  // Old HEAD: exactly one dedicated RED. Full matrix only when export exists.
  if (implementationMissing || policyApi === null) {
    it('destination policy implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── 1. Export + deny-all defaults ───────────────────────────────────────

  describe('1 export and deny-all defaults', () => {
    it('exports createAuditIntegrityAlertDestinationPolicy and fixed error code', () => {
      const api = requireApi();
      assert.equal(typeof api.createAuditIntegrityAlertDestinationPolicy, 'function');
      assert.equal(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, CODE_UNAVAILABLE);
    });

    it('missing/null/exact empty policy compile to deny-all capability', () => {
      const api = requireApi();
      const cases = [
        undefined,
        null,
        validPolicy([]),
      ];
      for (const raw of cases) {
        const cap = api.createAuditIntegrityAlertDestinationPolicy(raw);
        assertCapabilityShape(cap, 'deny-all', 0);
        assertCapabilitySanitized(cap, [
          ENDPOINT_A,
          ENDPOINT_B,
          SECRET_TOKEN,
          SECRET_PATH,
          SECRET_HOST,
        ]);
      }
    });

    it('deny-all authorize rejects any input with fixed error and never leaks', () => {
      const api = requireApi();
      const cap = api.createAuditIntegrityAlertDestinationPolicy(null);
      assertCapabilityShape(cap, 'deny-all', 0);

      const inputs = [
        ENDPOINT_A,
        ENDPOINT_B,
        ENDPOINT_C,
        'https://a.co/',
        '',
        '   ',
        null,
        undefined,
        0,
        false,
        true,
        {},
        [],
        SECRET_TOKEN,
        SECRET_PATH,
        new String(ENDPOINT_A),
        Buffer.from(ENDPOINT_A),
        new Uint8Array(Buffer.from(ENDPOINT_A)),
      ];
      for (const input of inputs) {
        const leak = typeof input === 'string' && input.length >= 2
          ? [input, SECRET_TOKEN, SECRET_PATH]
          : [SECRET_TOKEN, SECRET_PATH, ENDPOINT_A];
        expectUnavailable(() => cap.authorize(input), leak);
      }
    });
  });

  // ── 2. Count bounds: 1 / 16 configured; 17 / duplicate / malformed ───────

  describe('2 endpoint count bounds and duplicates', () => {
    it('1 endpoint compiles to configured capability and authorizes exact member', () => {
      const api = requireApi();
      const cap = api.createAuditIntegrityAlertDestinationPolicy(validPolicy([ENDPOINT_A]));
      assertCapabilityShape(cap, 'configured', 1);
      assert.equal(cap.authorize(ENDPOINT_A), ENDPOINT_A);
      expectUnavailable(() => cap.authorize(ENDPOINT_B), [ENDPOINT_B]);
    });

    it('16 distinct endpoints compile to configured; 17th rejects at compile', () => {
      const api = requireApi();
      const sixteen = nEndpoints(16);
      const cap = api.createAuditIntegrityAlertDestinationPolicy(validPolicy(sixteen));
      assertCapabilityShape(cap, 'configured', 16);
      for (const ep of sixteen) {
        assert.equal(cap.authorize(ep), ep);
      }
      // Not a member of the 16.
      expectUnavailable(() => cap.authorize(ENDPOINT_A), [ENDPOINT_A]);

      const seventeen = nEndpoints(17);
      expectUnavailable(
        () => api.createAuditIntegrityAlertDestinationPolicy(validPolicy(seventeen)),
        seventeen.slice(0, 3),
      );
    });

    it('duplicate endpoints reject at compile with fixed error', () => {
      const api = requireApi();
      const cases = [
        [ENDPOINT_A, ENDPOINT_A],
        [ENDPOINT_A, ENDPOINT_B, ENDPOINT_A],
        [ENDPOINT_C, ENDPOINT_C, ENDPOINT_C],
      ];
      for (const endpoints of cases) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(validPolicy(endpoints)),
          endpoints,
        );
      }
    });

    it('malformed policy types/shapes reject at compile', () => {
      const api = requireApi();
      const cases = [
        validPolicy([ENDPOINT_A], { schemaVersion: 0 }),
        validPolicy([ENDPOINT_A], { schemaVersion: 2 }),
        validPolicy([ENDPOINT_A], { schemaVersion: '1' }),
        validPolicy([ENDPOINT_A], { schemaVersion: 1.5 }),
        validPolicy([ENDPOINT_A], { schemaVersion: true }),
        { schemaVersion: 1 }, // missing endpoints
        { endpoints: [ENDPOINT_A] }, // missing schemaVersion
        { schemaVersion: 1, endpoints: [ENDPOINT_A], extra: true },
        { endpoints: [ENDPOINT_A], schemaVersion: 1 }, // reordered
        validPolicy([ENDPOINT_A, 1]),
        validPolicy([ENDPOINT_A, null]),
        validPolicy([ENDPOINT_A, undefined]),
        validPolicy([ENDPOINT_A, {}]),
        validPolicy('https://a.co/x'),
        validPolicy({ 0: ENDPOINT_A, length: 1 }),
        { schemaVersion: 1, endpoints: null },
        { schemaVersion: 1, endpoints: undefined },
        'policy',
        1,
        true,
        false,
        [],
      ];
      for (const raw of cases) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(raw),
          [ENDPOINT_A, 'extra', SECRET_PATH],
        );
      }
    });
  });

  // ── 3. Raw policy exact keys / schema / type / prototype / descriptors ──

  describe('3 raw policy exact key order schema type prototype data descriptors', () => {
    it('accepts only exact schemaVersion/endpoints order with plain data descriptors', () => {
      const api = requireApi();
      const good = validPolicy([ENDPOINT_A, ENDPOINT_B]);
      assertExactKeys(good, POLICY_KEYS, 'fixture policy');
      const cap = api.createAuditIntegrityAlertDestinationPolicy(good);
      assertCapabilityShape(cap, 'configured', 2);
      assert.equal(cap.authorize(ENDPOINT_A), ENDPOINT_A);
      assert.equal(cap.authorize(ENDPOINT_B), ENDPOINT_B);
    });

    it('rejects reordered/extra/missing/symbol/non-enumerable/accessor policy keys', () => {
      const api = requireApi();

      const reordered = {
        endpoints: [ENDPOINT_A],
        schemaVersion: 1,
      };
      assert.notDeepEqual(Object.keys(reordered), [...POLICY_KEYS]);

      const withSymbol = validPolicy([ENDPOINT_A]);
      withSymbol[Symbol('leak')] = SECRET_PATH;

      const nonEnum = validPolicy([ENDPOINT_A]);
      Object.defineProperty(nonEnum, 'hidden', {
        value: SECRET_TOKEN,
        enumerable: false,
      });

      const accessorPolicy = {};
      Object.defineProperty(accessorPolicy, 'schemaVersion', {
        enumerable: true,
        get() {
          return 1;
        },
      });
      Object.defineProperty(accessorPolicy, 'endpoints', {
        enumerable: true,
        get() {
          return [ENDPOINT_A];
        },
      });

      const mixedAccessor = validPolicy([ENDPOINT_A]);
      Object.defineProperty(mixedAccessor, 'schemaVersion', {
        enumerable: true,
        get() {
          return 1;
        },
      });

      for (const raw of [reordered, withSymbol, nonEnum, accessorPolicy, mixedAccessor]) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(raw),
          [SECRET_PATH, SECRET_TOKEN, ENDPOINT_A],
        );
      }
    });

    it('rejects polluted prototype and class instances for policy', () => {
      const api = requireApi();

      const polluted = Object.assign(
        Object.create({ polluted: true }),
        validPolicy([ENDPOINT_A]),
      );

      class PolicyClass {
        constructor() {
          this.schemaVersion = 1;
          this.endpoints = [ENDPOINT_A];
        }
      }

      for (const raw of [polluted, new PolicyClass()]) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(raw),
          [ENDPOINT_A, 'polluted'],
        );
      }
    });
  });

  // ── 4. Endpoint URL contract: length, HTTPS, canonical, port, creds ────

  describe('4 endpoint URL length HTTPS canonical port credentials query fragment', () => {
    it('accepts short and pathname-max (1024) canonical https endpoints with default 443 only', () => {
      const api = requireApi();
      // Shortest practical valid: https://a.co/ → 13 bytes.
      const short = 'https://a.co/';
      assert.equal(short, new URL(short).href);
      assert.ok(Buffer.byteLength(short, 'utf8') >= 1);
      assert.ok(Buffer.byteLength(short, 'utf8') <= 2048);

      // Independent pathname upper bound (1024 chars), still well under the
      // separate 2048-byte whole-endpoint cap (host+scheme leave headroom).
      const maxPath = endpointWithPathLength(1024);
      assert.equal(new URL(maxPath).pathname.length, 1024);
      assert.equal(maxPath, new URL(maxPath).href);
      assert.ok(Buffer.byteLength(maxPath, 'utf8') <= 2048);
      assert.ok(Buffer.byteLength(maxPath, 'utf8') < 2048);

      const cap = api.createAuditIntegrityAlertDestinationPolicy(
        validPolicy([short, maxPath]),
      );
      assertCapabilityShape(cap, 'configured', 2);
      assert.equal(cap.authorize(short), short);
      assert.equal(cap.authorize(maxPath), maxPath);
    });

    it('rejects oversize, empty, non-https, credentials, query, fragment, explicit port', () => {
      const api = requireApi();
      // 2049 UTF-8 bytes is fail-closed. Such a string necessarily also exceeds
      // independent path/host bounds when path-padded; do not attribute the
      // reject solely to the whole-endpoint 2048 constant.
      const over = endpointWithByteLength(2048).replace(/x$/, 'xy');
      assert.equal(Buffer.byteLength(over, 'utf8'), 2049);

      const rejected = [
        '',
        'https://a.co', // no path → URL href adds trailing /
        over,
        'http://a.co/x',
        'HTTPS://a.co/x',
        'https://user:pass@a.co/x',
        'https://user@a.co/x',
        'https://:pass@a.co/x',
        'https://a.co/x?q=1',
        'https://a.co/x#frag',
        'https://a.co:443/x',
        'https://a.co:8443/x',
        'https://a.co:80/x',
        'ftp://a.co/x',
        'https://a.co/x?',
        'https://a.co/x#',
        // non-canonical href drift (uppercase host)
        'https://A.CO/x',
      ];

      for (const ep of rejected) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(validPolicy([ep])),
          [ep.slice(0, 64), 'user', 'pass', 'q=1', 'frag', SECRET_TOKEN],
        );
      }

      // Prove :443 is non-canonical under URL href contract.
      const withPort = 'https://a.co:443/x';
      assert.notEqual(withPort, new URL(withPort).href);
    });

    it('requires input bit-identical to new URL(input).href', () => {
      const api = requireApi();
      const nonCanonical = [
        'https://a.co',
        'https://a.co:443/',
        'https://a.co/./x',
        'https://a.co/foo/../x',
      ];
      for (const ep of nonCanonical) {
        let href;
        try {
          href = new URL(ep).href;
        } catch {
          href = null;
        }
        if (href === ep) continue; // skip if environment treats as canonical
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(validPolicy([ep])),
          [ep],
        );
      }
    });
  });

  // ── 5. Hostname DNS shape ───────────────────────────────────────────────

  describe('5 hostname lowercase ASCII DNS labels and TLD bounds', () => {
    it('accepts lowercase multi-label hosts within label and TLD bounds', () => {
      const api = requireApi();
      const label63 = `${'a'.repeat(63)}.co`;
      assert.equal(label63.split('.')[0].length, 63);
      const positives = [
        'https://a.co/',
        'https://ab.cd/',
        'https://alerts.acme.com/hooks/x',
        'https://hooks.ops.acme.com/v1',
        `https://${label63}/x`,
        'https://a1-b2.acme.com/x',
        'https://xnnotpuny.acme.com/x', // "xn" without "--" is ordinary label
      ];
      for (const ep of positives) {
        assert.equal(ep, new URL(ep).href);
        const cap = api.createAuditIntegrityAlertDestinationPolicy(validPolicy([ep]));
        assertCapabilityShape(cap, 'configured', 1);
        assert.equal(cap.authorize(ep), ep);
      }
    });

    it('rejects single-label, empty labels, label/TLD oversize, leading/trailing hyphen', () => {
      const api = requireApi();
      const label64 = `${'a'.repeat(64)}.com`;
      const tld1 = 'https://a.x/y'; // TLD length 1
      const tldWithDigit = 'https://a.c0m/x';
      const rejected = [
        'https://localhost/x', // single label (+ reserved)
        'https://acme/x',
        'https://.acme.com/x',
        'https://acme..com/x',
        'https://-acme.com/x',
        'https://acme-.com/x',
        'https://acme.-com/x',
        'https://acme.com-/x',
        `https://${label64}/x`,
        tld1,
        tldWithDigit,
        'https://a.COM/x',
        'https://Alerts.Acme.Com/x',
      ];
      for (const ep of rejected) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(validPolicy([ep])),
          [ep.slice(0, 80)],
        );
      }
    });
  });

  // ── 6. Reserved suffixes / IP / wildcard / underscore / punycode ───────

  describe('6 reserved suffixes IP wildcard underscore trailing-dot punycode non-ASCII', () => {
    it('rejects reserved/private suffixes and bare reserved names', () => {
      const api = requireApi();
      const suffixes = [
        'localhost',
        'local',
        'internal',
        'corp',
        'home',
        'lan',
        'test',
        'example',
        'invalid',
      ];
      /** @type {string[]} */
      const rejected = [];
      for (const s of suffixes) {
        rejected.push(`https://hooks.${s}/x`);
        rejected.push(`https://a.b.${s}/x`);
      }
      // Bare reserved single-labels already illegal as DNS shape; include multi-label forms.
      rejected.push('https://app.localhost/hooks');
      rejected.push('https://svc.local/hooks');
      rejected.push('https://api.internal/hooks');
      rejected.push('https://ci.test/hooks');
      rejected.push('https://docs.example/hooks');
      rejected.push('https://not.invalid/hooks');

      for (const ep of rejected) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(validPolicy([ep])),
          [ep, 'localhost', 'invalid', 'example'],
        );
      }
    });

    it('rejects IP literals, wildcard, underscore, trailing dot, punycode, non-ASCII', () => {
      const api = requireApi();
      const rejected = [
        'https://127.0.0.1/x',
        'https://192.168.1.1/hooks',
        'https://0.0.0.0/x',
        'https://[::1]/x',
        'https://[2001:db8::1]/x',
        'https://*.acme.com/x',
        'https://foo_bar.acme.com/x',
        'https://_acme.com/x',
        'https://acme.com./x',
        'https://acme.com./hooks',
        'https://xn--nxasmq6b.com/x',
        'https://foo.xn--fiqs8s/x',
        'https://münchen.de/x',
        'https://acme.\u4e2d\u56fd/x',
        'https://alert\u0000s.acme.com/x',
      ];
      for (const ep of rejected) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(validPolicy([ep])),
          [ep.slice(0, 48), '127.0.0.1', 'xn--', SECRET_PATH],
        );
      }
    });
  });

  // ── 7. Path contract ────────────────────────────────────────────────────

  describe('7 path length and allowed ASCII set; percent backslash slash dot reject', () => {
    it('accepts path length 1..1024 with allowed ASCII characters', () => {
      const api = requireApi();
      const path1 = 'https://a.co/';
      const path1024 = endpointWithPathLength(1024);
      assert.equal(new URL(path1024).pathname.length, 1024);
      const rich =
        "https://a.co/Hooks._~!$&'()*+,;=:@-Az09";
      assert.equal(rich, new URL(rich).href);

      const cap = api.createAuditIntegrityAlertDestinationPolicy(
        validPolicy([path1, path1024, rich]),
      );
      assertCapabilityShape(cap, 'configured', 3);
      assert.equal(cap.authorize(path1), path1);
      assert.equal(cap.authorize(path1024), path1024);
      assert.equal(cap.authorize(rich), rich);
    });

    it('rejects path oversize, percent-encoding, backslash, double-slash, dot segments', () => {
      const api = requireApi();
      const path1025 = endpointWithPathLength(1025);
      const rejected = [
        path1025,
        'https://a.co/x%20y',
        'https://a.co/%2e%2e',
        'https://a.co/x%2f',
        'https://a.co/x\\y',
        'https://a.co//x',
        'https://a.co/x//y',
        'https://a.co/./x',
        'https://a.co/x/./y',
        'https://a.co/../x',
        'https://a.co/x/../y',
        'https://a.co/x/.',
        'https://a.co/x/..',
        'https://a.co/.',
        'https://a.co/..',
        'https://a.co/x?', // also query
        'https://a.co/x#y',
        'https://a.co/x y',
        'https://a.co/x\ny',
        'https://a.co/x\t',
      ];
      for (const ep of rejected) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(validPolicy([ep])),
          [ep.slice(0, 64), '%20', '..'],
        );
      }
    });
  });

  // ── 8. Hostile matrix (Proxy / accessor / symbol / wrappers / buffers) ──

  describe('8 hostile Proxy accessor symbol non-enumerable class Array subclass URL String Buffer Uint8Array', () => {
    it('rejects Proxy policy/endpoints without firing traps', () => {
      const api = requireApi();
      const { traps: policyTraps, proxy: policyProxy } = makeTrapProxy(
        validPolicy([ENDPOINT_A]),
      );
      expectUnavailable(
        () => api.createAuditIntegrityAlertDestinationPolicy(policyProxy),
        [SECRET_PATH, SECRET_TOKEN, SECRET_HOST, ENDPOINT_A],
      );
      assert.equal(sumTraps(policyTraps), 0, 'policy Proxy traps must never fire');

      const good = validPolicy([ENDPOINT_A]);
      const { traps: arrTraps, proxy: arrProxy } = makeTrapProxy([ENDPOINT_A]);
      const withProxyEndpoints = {
        schemaVersion: 1,
        endpoints: arrProxy,
      };
      expectUnavailable(
        () => api.createAuditIntegrityAlertDestinationPolicy(withProxyEndpoints),
        [SECRET_PATH, SECRET_TOKEN, SECRET_HOST, ENDPOINT_A],
      );
      assert.equal(sumTraps(arrTraps), 0, 'endpoints Proxy traps must never fire');
      // Ensure good fixture still works (no pollution).
      const cap = api.createAuditIntegrityAlertDestinationPolicy(good);
      assert.equal(cap.authorize(ENDPOINT_A), ENDPOINT_A);
    });

    it('rejects revoked top-level policy Proxy with fixed error not native TypeError', () => {
      const api = requireApi();
      // isProxy must win before Array.isArray/reflection: revoked Proxy otherwise
      // throws native TypeError and escapes audit-delivery-unavailable.
      const { proxy, revoke } = Proxy.revocable(validPolicy([ENDPOINT_A]), {});
      revoke();
      expectUnavailable(
        () => api.createAuditIntegrityAlertDestinationPolicy(proxy),
        [SECRET_PATH, SECRET_TOKEN, SECRET_HOST, ENDPOINT_A],
      );
    });

    it('rejects endpoints array index accessors without invoking getters', () => {
      const api = requireApi();

      // Plain Array with index data-looking accessor: must fail closed and never
      // execute the getter (value[i] would otherwise run caller code).
      let getterHits = 0;
      const accessorEndpoints = [];
      accessorEndpoints.length = 1;
      Object.defineProperty(accessorEndpoints, '0', {
        enumerable: true,
        configurable: true,
        get() {
          getterHits += 1;
          return ENDPOINT_A;
        },
      });
      expectUnavailable(
        () => api.createAuditIntegrityAlertDestinationPolicy(
          validPolicy(accessorEndpoints),
        ),
        [ENDPOINT_A, SECRET_PATH, SECRET_TOKEN],
      );
      assert.equal(getterHits, 0, 'endpoints index getter must never fire');

      // Throwing index getter must not escape as native Error with secret text.
      let throwHits = 0;
      const throwingEndpoints = [];
      throwingEndpoints.length = 1;
      Object.defineProperty(throwingEndpoints, '0', {
        enumerable: true,
        configurable: true,
        get() {
          throwHits += 1;
          throw new Error(`index-get:${SECRET_TOKEN}`);
        },
      });
      expectUnavailable(
        () => api.createAuditIntegrityAlertDestinationPolicy(
          validPolicy(throwingEndpoints),
        ),
        [SECRET_TOKEN, SECRET_PATH, ENDPOINT_A],
      );
      assert.equal(throwHits, 0, 'throwing endpoints index getter must never fire');
    });

    it('rejects class / Array subclass / URL / String wrapper / Buffer / Uint8Array policy surfaces', () => {
      const api = requireApi();

      class PolicyClass {
        constructor() {
          this.schemaVersion = 1;
          this.endpoints = [ENDPOINT_A];
        }
      }

      class EndpointsArray extends Array {}
      const subArr = new EndpointsArray();
      subArr.push(ENDPOINT_A);

      const asUrl = new URL(ENDPOINT_A);
      const stringWrapperPolicy = {
        schemaVersion: 1,
        endpoints: [new String(ENDPOINT_A)],
      };
      const bufferEndpoints = {
        schemaVersion: 1,
        endpoints: [Buffer.from(ENDPOINT_A)],
      };
      const u8Endpoints = {
        schemaVersion: 1,
        endpoints: [new Uint8Array(Buffer.from(ENDPOINT_A))],
      };
      const bufferPolicy = Buffer.from(JSON.stringify(validPolicy([ENDPOINT_A])));
      const u8Policy = new Uint8Array(bufferPolicy);

      const hostiles = [
        new PolicyClass(),
        { schemaVersion: 1, endpoints: subArr },
        asUrl,
        stringWrapperPolicy,
        bufferEndpoints,
        u8Endpoints,
        bufferPolicy,
        u8Policy,
        new String('policy'),
        Object.assign(new String('x'), validPolicy([ENDPOINT_A])),
      ];

      for (const raw of hostiles) {
        expectUnavailable(
          () => api.createAuditIntegrityAlertDestinationPolicy(raw),
          [ENDPOINT_A, SECRET_PATH],
        );
      }
    });

    it('authorize rejects Proxy/accessor/wrapper/Buffer endpoint without traps', () => {
      const api = requireApi();
      const cap = api.createAuditIntegrityAlertDestinationPolicy(
        validPolicy([ENDPOINT_A, ENDPOINT_B]),
      );

      const { traps, proxy } = makeTrapProxy(Object(ENDPOINT_A));
      expectUnavailable(() => cap.authorize(proxy), [SECRET_PATH, SECRET_TOKEN, SECRET_HOST]);
      assert.equal(sumTraps(traps), 0, 'authorize Proxy traps must never fire');

      let getterHits = 0;
      const accessorBox = {};
      Object.defineProperty(accessorBox, 'toString', {
        enumerable: false,
        value() {
          getterHits += 1;
          return ENDPOINT_A;
        },
      });
      Object.defineProperty(accessorBox, 'valueOf', {
        enumerable: false,
        value() {
          getterHits += 1;
          return ENDPOINT_A;
        },
      });

      const hostiles = [
        new String(ENDPOINT_A),
        Buffer.from(ENDPOINT_A),
        new Uint8Array(Buffer.from(ENDPOINT_A)),
        { toString: () => ENDPOINT_A },
        accessorBox,
        Object(ENDPOINT_A),
      ];
      for (const input of hostiles) {
        expectUnavailable(() => cap.authorize(input), [ENDPOINT_A, SECRET_PATH]);
      }
      assert.equal(getterHits, 0, 'authorize must not coerce via accessors');
    });
  });

  // ── 9. Caller mutation isolation ────────────────────────────────────────

  describe('9 caller policy/array mutation does not change capability', () => {
    it('mutating raw policy after compile leaves membership and shape intact', () => {
      const api = requireApi();
      const endpoints = [ENDPOINT_A, ENDPOINT_B];
      const raw = validPolicy(endpoints);
      const cap = api.createAuditIntegrityAlertDestinationPolicy(raw);

      // Mutate caller structures after compile.
      raw.schemaVersion = 99;
      raw.endpoints.push(ENDPOINT_C);
      endpoints[0] = 'https://mutated.acme.com/x';
      endpoints.pop();
      raw.extra = SECRET_TOKEN;

      assertCapabilityShape(cap, 'configured', 2);
      assert.equal(cap.authorize(ENDPOINT_A), ENDPOINT_A);
      assert.equal(cap.authorize(ENDPOINT_B), ENDPOINT_B);
      expectUnavailable(() => cap.authorize(ENDPOINT_C), [ENDPOINT_C]);
      expectUnavailable(
        () => cap.authorize('https://mutated.acme.com/x'),
        ['mutated.acme.com'],
      );
    });

    it('capability object itself is frozen against property mutation', () => {
      const api = requireApi();
      const cap = api.createAuditIntegrityAlertDestinationPolicy(
        validPolicy([ENDPOINT_A]),
      );
      assert.throws(() => {
        /** @type {Record<string, unknown>} */ (cap).status = 'deny-all';
      });
      assert.throws(() => {
        /** @type {Record<string, unknown>} */ (cap).endpointCount = 99;
      });
      assert.throws(() => {
        /** @type {Record<string, unknown>} */ (cap).authorize = () => ENDPOINT_A;
      });
      assert.throws(() => {
        /** @type {Record<string, unknown>} */ (cap).endpoints = [ENDPOINT_B];
      });
      assert.equal(cap.status, 'configured');
      assert.equal(cap.endpointCount, 1);
      assert.equal(cap.authorize(ENDPOINT_A), ENDPOINT_A);
    });
  });

  // ── 10. Exact membership (no prefix/suffix/case/normalization) ──────────

  describe('10 exact membership without prefix suffix case normalization', () => {
    it('authorizes only exact allowlisted strings', () => {
      const api = requireApi();
      const allow = 'https://alerts.acme.com/hooks/audit';
      const cap = api.createAuditIntegrityAlertDestinationPolicy(validPolicy([allow]));
      assert.equal(cap.authorize(allow), allow);

      const nearMisses = [
        `${allow}/`,
        `${allow}/extra`,
        allow.slice(0, -1),
        allow.toUpperCase(),
        'https://alerts.acme.com/hooks/AUDIT',
        'https://alerts.acme.com/hooks/audit/',
        'https://alerts.acme.com/hooks/aud',
        'https://alerts.acme.com/hooks/audit-integrity',
        'https://alerts.acme.com.evil.com/hooks/audit',
        'https://evil.alerts.acme.com/hooks/audit',
        'https://alerts.acme.com/hooks/audit?x=1',
        'https://alerts.acme.com/hooks/audit#x',
        'https://alerts.acme.com:443/hooks/audit',
        'http://alerts.acme.com/hooks/audit',
        ` ${allow}`,
        `${allow} `,
        allow.replace('https://', 'https://www.'),
      ];
      for (const miss of nearMisses) {
        expectUnavailable(() => cap.authorize(miss), [miss.slice(0, 64), allow]);
      }
    });

    it('multi-member policy does not grant prefix or sibling paths', () => {
      const api = requireApi();
      const a = 'https://alerts.acme.com/a';
      const b = 'https://alerts.acme.com/b';
      const cap = api.createAuditIntegrityAlertDestinationPolicy(validPolicy([a, b]));
      assert.equal(cap.authorize(a), a);
      assert.equal(cap.authorize(b), b);
      expectUnavailable(() => cap.authorize('https://alerts.acme.com/'), ['alerts.acme.com']);
      expectUnavailable(() => cap.authorize('https://alerts.acme.com/ab'), ['/ab']);
      expectUnavailable(() => cap.authorize('https://alerts.acme.com/a/'), ['/a/']);
      expectUnavailable(() => cap.authorize('https://alerts.acme.com/c'), ['/c']);
    });
  });

  // ── 11. Fixed error + no endpoint/policy/token/path leakage ─────────────

  describe('11 fixed audit-delivery-unavailable; no endpoint policy token path leaks', () => {
    it('compile and authorize failures always use fixed LinkeError code/message', () => {
      const api = requireApi();
      const secretEp =
        `https://user:${SECRET_TOKEN}@${SECRET_HOST}${SECRET_PATH}?token=leak#frag`;

      expectUnavailable(
        () => api.createAuditIntegrityAlertDestinationPolicy(validPolicy([secretEp])),
        [secretEp, SECRET_TOKEN, SECRET_HOST, SECRET_PATH, 'user:', 'token=leak', 'frag'],
      );

      const cap = api.createAuditIntegrityAlertDestinationPolicy(
        validPolicy([ENDPOINT_A]),
      );
      assertCapabilitySanitized(cap, [
        ENDPOINT_A,
        ENDPOINT_B,
        SECRET_TOKEN,
        SECRET_PATH,
        SECRET_HOST,
      ]);

      expectUnavailable(
        () => cap.authorize(secretEp),
        [secretEp, SECRET_TOKEN, SECRET_HOST, SECRET_PATH, 'user:', 'token=leak'],
      );
      expectUnavailable(
        () => cap.authorize(ENDPOINT_B),
        [ENDPOINT_B, ENDPOINT_A, SECRET_TOKEN],
      );
    });
  });

  // ── 12. Structural source scan ──────────────────────────────────────────

  describe('12 structural source scan', () => {
    it('allows only node:util/buffer and ./error-codes.js; forbids env fs net dns http timers credentials Agent API Web scheduler', async () => {
      const source = await readFile(PRODUCTION_MODULE_PATH, 'utf8');

      const importRe = /\bfrom\s+['"]([^'"]+)['"]/g;
      /** @type {string[]} */
      const imports = [];
      for (const match of source.matchAll(importRe)) {
        imports.push(match[1]);
      }

      const allowed = new Set([
        'node:util',
        'node:buffer',
        './error-codes.js',
      ]);
      for (const imp of imports) {
        assert.equal(allowed.has(imp), true, `unexpected import: ${imp}`);
      }
      assert.equal(
        imports.includes('./error-codes.js'),
        true,
        'must import ./error-codes.js for fixed LinkeError',
      );

      // Exact specifier checks (avoid substring false positives).
      assert.equal(imports.includes('node:http'), false);
      assert.equal(imports.includes('node:https'), false);
      assert.equal(imports.includes('node:net'), false);
      assert.equal(imports.includes('node:dns'), false);
      assert.equal(imports.includes('node:fs'), false);
      assert.equal(imports.includes('node:fs/promises'), false);

      for (const forbidden of [
        'process.env',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'NODE_EXTRA_CA_CERTS',
        'fetch(',
        'globalThis.fetch',
        'node-fetch',
        'undici',
        'node:http',
        'node:https',
        'node:net',
        'node:dns',
        'node:dgram',
        'node:tls',
        'node:fs',
        'node:fs/promises',
        'fs/promises',
        'node:path',
        'node:child_process',
        'child_process',
        'setTimeout(',
        'setInterval(',
        'setImmediate(',
        'Date.now',
        'readFileSync',
        'writeFileSync',
        'createServer',
        'https.Agent',
        'http.Agent',
        'new Agent',
        'keychain',
        'credential',
        'authorization',
        'scheduler',
        'retry',
        'backoff',
        'dead-letter',
        'deadLetter',
        "from './agent.js'",
        "from './server.js'",
        "from './web/",
        "from '../web/",
        'audit-integrity-alert-delivery-once',
        'audit-integrity-alert-https-transport',
        'audit-integrity-alert-delivery-claim',
        'audit-integrity-alert-outbox',
        'gold-readiness',
        'dns.lookup',
        'dns.resolve',
        'lookupAll',
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `forbidden production surface: ${forbidden}`,
        );
      }

      // Positive anchors for the Task 1 export surface.
      assert.equal(
        source.includes('createAuditIntegrityAlertDestinationPolicy'),
        true,
      );
      assert.equal(source.includes('AUDIT_DELIVERY_UNAVAILABLE'), true);

      // Lock independent numeric bounds so whole-endpoint and pathname caps
      // cannot silently drift relative to the design (2048 bytes vs 1024 chars).
      assert.equal(
        source.includes('MAX_ENDPOINT_UTF8_BYTES = 2048'),
        true,
        'production must keep whole-endpoint max at 2048 UTF-8 bytes',
      );
      assert.equal(
        source.includes('MAX_PATH_CHARS = 1024'),
        true,
        'production must keep pathname max at 1024 chars (independent of 2048)',
      );
    });
  });
});
