/**
 * Task 3 RED — public audit-integrity alert address classifier.
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-destination-allowlist-design.md
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-destination-allowlist-plan.md (Task 3)
 *
 * Production (absent on old HEAD):
 *   src/audit-integrity-alert-public-address.js
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   test name + assert message = `public audit alert address classifier implementation missing`
 * Full matrix registers only when isPublicAuditIntegrityAlertAddress exists.
 *
 * Frozen export:
 *   isPublicAuditIntegrityAlertAddress(address, family) → primitive strict boolean
 * Never throws, never echoes inputs. Pure classifier only.
 * Tests perform no network / external IO; production source may be read for structure scan.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-public-address.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);

const MISSING_MSG = 'public audit alert address classifier implementation missing';

/** @type {null | { isPublicAuditIntegrityAlertAddress: Function }} */
let addressApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (typeof mod.isPublicAuditIntegrityAlertAddress === 'function') {
    addressApi = {
      isPublicAuditIntegrityAlertAddress: mod.isPublicAuditIntegrityAlertAddress,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    addressApi = null;
  } else {
    // Syntax/load errors in an existing production module must surface as themselves.
    throw error;
  }
}

function requireApi() {
  if (implementationMissing || addressApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {NonNullable<typeof addressApi>} */ (addressApi);
}

// ─── Spec oracles (frozen deny tables; independent of production) ──────────

/** @type {readonly { name: string, prefix: number, bits: number }[]} */
const IPV4_DENY_PREFIXES = Object.freeze([
  { name: '0.0.0.0/8', prefix: 0x00000000, bits: 8 },
  { name: '10.0.0.0/8', prefix: 0x0a000000, bits: 8 },
  { name: '100.64.0.0/10', prefix: 0x64400000, bits: 10 },
  { name: '127.0.0.0/8', prefix: 0x7f000000, bits: 8 },
  { name: '169.254.0.0/16', prefix: 0xa9fe0000, bits: 16 },
  { name: '172.16.0.0/12', prefix: 0xac100000, bits: 12 },
  { name: '192.0.0.0/24', prefix: 0xc0000000, bits: 24 },
  { name: '192.0.2.0/24', prefix: 0xc0000200, bits: 24 },
  { name: '192.31.196.0/24', prefix: 0xc01fc400, bits: 24 },
  { name: '192.52.193.0/24', prefix: 0xc034c100, bits: 24 },
  { name: '192.88.99.0/24', prefix: 0xc0586300, bits: 24 },
  { name: '192.168.0.0/16', prefix: 0xc0a80000, bits: 16 },
  { name: '192.175.48.0/24', prefix: 0xc0af3000, bits: 24 },
  { name: '198.18.0.0/15', prefix: 0xc6120000, bits: 15 },
  { name: '198.51.100.0/24', prefix: 0xc6336400, bits: 24 },
  { name: '203.0.113.0/24', prefix: 0xcb007100, bits: 24 },
  { name: '224.0.0.0/4', prefix: 0xe0000000, bits: 4 },
  { name: '240.0.0.0/4', prefix: 0xf0000000, bits: 4 },
]);

/**
 * @param {number} bits
 * @returns {number} unsigned 32-bit network mask
 */
function ipv4Mask(bits) {
  if (bits <= 0) return 0;
  if (bits >= 32) return 0xffffffff;
  return (0xffffffff << (32 - bits)) >>> 0;
}

/**
 * @param {number} prefix
 * @param {number} bits
 * @returns {{ first: number, last: number }}
 */
function ipv4Range(prefix, bits) {
  const mask = ipv4Mask(bits);
  const first = (prefix & mask) >>> 0;
  const last = (first | (~mask >>> 0)) >>> 0;
  return { first, last };
}

/**
 * @param {number} n unsigned 32-bit
 * @returns {string}
 */
function u32ToIpv4(n) {
  const u = n >>> 0;
  return `${(u >>> 24) & 0xff}.${(u >>> 16) & 0xff}.${(u >>> 8) & 0xff}.${u & 0xff}`;
}

/**
 * @param {string} address
 * @returns {number}
 */
function ipv4ToU32(address) {
  const parts = address.split('.');
  assert.equal(parts.length, 4, `oracle ipv4 parse: ${address}`);
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    assert.equal(Number.isInteger(o) && o >= 0 && o <= 255, true, `oracle octet: ${address}`);
    n = ((n << 8) + o) >>> 0;
  }
  return n;
}

/**
 * Spec oracle: valid dotted IPv4 is public iff not in any deny prefix.
 * @param {number} u unsigned 32-bit
 * @returns {boolean}
 */
function oracleIpv4Public(u) {
  const x = u >>> 0;
  for (const { prefix, bits } of IPV4_DENY_PREFIXES) {
    const mask = ipv4Mask(bits);
    if (((x & mask) >>> 0) === ((prefix & mask) >>> 0)) return false;
  }
  return true;
}

/** 2000::/3 — top three bits 001. */
const IPV6_ALLOW_PREFIX = 0x20000000000000000000000000000000n;
const IPV6_ALLOW_BITS = 3;

/** @type {readonly { name: string, prefix: bigint, bits: number }[]} */
const IPV6_DENY_PREFIXES = Object.freeze([
  { name: '2001::/23', prefix: 0x20010000000000000000000000000000n, bits: 23 },
  { name: '2001:db8::/32', prefix: 0x20010db8000000000000000000000000n, bits: 32 },
  { name: '2002::/16', prefix: 0x20020000000000000000000000000000n, bits: 16 },
  { name: '3fff::/20', prefix: 0x3fff0000000000000000000000000000n, bits: 20 },
]);

const U128_MASK = (1n << 128n) - 1n;

/**
 * @param {bigint} prefix
 * @param {number} bits
 * @returns {{ first: bigint, last: bigint }}
 */
function ipv6Range(prefix, bits) {
  const b = BigInt(bits);
  const mask = b === 0n ? 0n : (U128_MASK << (128n - b)) & U128_MASK;
  const first = prefix & mask;
  const last = first | (U128_MASK ^ mask);
  return { first, last };
}

/**
 * @param {bigint} n
 * @returns {number[]}
 */
function u128ToHextets(n) {
  const parts = [];
  for (let i = 7; i >= 0; i -= 1) {
    parts.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  }
  return parts;
}

/**
 * Expanded lowercase hextet form (no compression, no IPv4 tail).
 * Accepted by net.isIP as family 6.
 * @param {bigint} n
 * @returns {string}
 */
function u128ToIpv6Expanded(n) {
  return u128ToHextets(n)
    .map((h) => h.toString(16))
    .join(':');
}

/**
 * Longest-run `::` compression, lowercase (also net.isIP-accepted).
 * @param {bigint} n
 * @returns {string}
 */
function u128ToIpv6Compressed(n) {
  const parts = u128ToHextets(n).map((h) => h.toString(16));
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (parts[i] !== '0') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && parts[j] === '0') j += 1;
    const len = j - i;
    if (len > bestLen) {
      bestStart = i;
      bestLen = len;
    }
    i = j;
  }
  if (bestLen < 2) return parts.join(':');
  const head = parts.slice(0, bestStart).join(':');
  const tail = parts.slice(bestStart + bestLen).join(':');
  if (bestStart === 0 && bestStart + bestLen === 8) return '::';
  if (bestStart === 0) return `::${tail}`;
  if (bestStart + bestLen === 8) return `${head}::`;
  return `${head}::${tail}`;
}

/**
 * @param {bigint} n
 * @param {bigint} prefix
 * @param {number} bits
 * @returns {boolean}
 */
function ipv6InPrefix(n, prefix, bits) {
  const b = BigInt(bits);
  if (b === 0n) return true;
  const shift = 128n - b;
  return (n >> shift) === (prefix >> shift);
}

/**
 * Spec oracle for a parsed 128-bit address (valid pure hextet IPv6).
 * @param {bigint} n
 * @returns {boolean}
 */
function oracleIpv6Public(n) {
  if (!ipv6InPrefix(n, IPV6_ALLOW_PREFIX, IPV6_ALLOW_BITS)) {
    return false;
  }
  for (const { prefix, bits } of IPV6_DENY_PREFIXES) {
    if (ipv6InPrefix(n, prefix, bits)) return false;
  }
  return true;
}

// ─── Assertion helpers ────────────────────────────────────────────────────

/**
 * @param {unknown} actual
 * @param {boolean} expected
 * @param {string} label
 */
function assertStrictBool(actual, expected, label) {
  assert.equal(typeof actual, 'boolean', `${label}: must be primitive boolean typeof`);
  assert.equal(
    actual === true || actual === false,
    true,
    `${label}: must be strict primitive true/false (no Boolean object)`,
  );
  assert.equal(actual, expected, `${label}: expected ${expected}`);
  assert.equal(Object.is(actual, expected), true, `${label}: Object.is(${expected})`);
  // Never echo inputs: return value must not be a string/object payload.
  assert.equal(typeof actual === 'string', false, `${label}: must not echo string`);
}

/**
 * @param {Function} fn
 * @param {unknown} address
 * @param {unknown} family
 * @param {boolean} expected
 * @param {string} label
 */
function expectClassify(fn, address, family, expected, label) {
  let actual;
  assert.doesNotThrow(() => {
    actual = fn(address, family);
  }, `${label}: must not throw`);
  assertStrictBool(actual, expected, label);
}

/**
 * Hostile Proxy with trap counters. Implementation must not invoke traps
 * (typeof-only rejection path).
 * @returns {{ proxy: object, traps: Record<string, number>, sum: () => number }}
 */
function makeHostileProxy(tag = 'hostile') {
  /** @type {Record<string, number>} */
  const traps = {
    get: 0,
    set: 0,
    has: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
    getPrototypeOf: 0,
    apply: 0,
    construct: 0,
  };
  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        traps.get += 1;
        throw new Error(`trap-get:${String(prop)}:${tag}`);
      },
      set() {
        traps.set += 1;
        throw new Error(`trap-set:${tag}`);
      },
      has() {
        traps.has += 1;
        throw new Error(`trap-has:${tag}`);
      },
      ownKeys() {
        traps.ownKeys += 1;
        throw new Error(`trap-ownKeys:${tag}`);
      },
      getOwnPropertyDescriptor() {
        traps.getOwnPropertyDescriptor += 1;
        throw new Error(`trap-desc:${tag}`);
      },
      getPrototypeOf() {
        traps.getPrototypeOf += 1;
        throw new Error(`trap-proto:${tag}`);
      },
      apply() {
        traps.apply += 1;
        throw new Error(`trap-apply:${tag}`);
      },
      construct() {
        traps.construct += 1;
        throw new Error(`trap-construct:${tag}`);
      },
    },
  );
  return {
    proxy,
    traps,
    sum: () => Object.values(traps).reduce((a, b) => a + b, 0),
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('audit integrity alert public address classifier (Task 3 RED)', () => {
  // Old HEAD: exactly one dedicated RED. Full matrix only when export exists.
  if (implementationMissing || addressApi === null) {
    it('public audit alert address classifier implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── 1. Export + total function contract ─────────────────────────────────

  describe('1 export and total boolean contract', () => {
    it('exports isPublicAuditIntegrityAlertAddress as a function', () => {
      const api = requireApi();
      assert.equal(typeof api.isPublicAuditIntegrityAlertAddress, 'function');
    });

    it('never throws and always returns primitive boolean for mixed garbage inputs', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();
      const garbage = [
        [undefined, undefined],
        [null, null],
        ['', 4],
        ['8.8.8.8', undefined],
        [undefined, 4],
        [{}, 4],
        [[], 6],
        [8.8, 4],
        [true, 4],
        [false, 6],
        [Symbol('ip'), 4],
        [() => '8.8.8.8', 4],
        [new Date(), 4],
      ];
      for (const [address, family] of garbage) {
        expectClassify(
          fn,
          address,
          family,
          false,
          `garbage address=${String(address)} family=${String(family)}`,
        );
      }
    });
  });

  // ── 2. Family gate ──────────────────────────────────────────────────────

  describe('2 family must be number integer 4 or 6 only', () => {
    it('accepts integer family 4 and 6 with matching public addresses', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();
      expectClassify(fn, '8.8.8.8', 4, true, 'family=4 integer with public v4');
      expectClassify(fn, '1.1.1.1', 4, true, 'family=4 integer 1.1.1.1');
      expectClassify(fn, '2606:4700:4700::1111', 6, true, 'family=6 integer with public v6');
      // 4.0 is Number.isInteger-true and === 4
      expectClassify(fn, '8.8.8.8', 4.0, true, 'family=4.0 still integer 4');
    });

    it('rejects string/bigint/NaN/float/object/Proxy family without throw or trap', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();
      const rejectedFamilies = [
        ['4', "string '4'"],
        ['6', "string '6'"],
        [4n, 'bigint 4n'],
        [6n, 'bigint 6n'],
        [NaN, 'NaN'],
        [4.5, 'float 4.5'],
        [3.999, 'float 3.999'],
        [0, '0'],
        [1, '1'],
        [5, '5'],
        [7, '7'],
        [-4, '-4'],
        [Infinity, 'Infinity'],
        [-Infinity, '-Infinity'],
        [null, 'null'],
        [undefined, 'undefined'],
        [true, 'true'],
        [false, 'false'],
        [Object(4), 'Object(4)'],
        [[4], 'array [4]'],
        [{ valueOf: () => 4 }, 'valueOf→4 object'],
      ];
      for (const [family, label] of rejectedFamilies) {
        expectClassify(fn, '8.8.8.8', family, false, `reject family ${label} with 8.8.8.8`);
        expectClassify(
          fn,
          '2606:4700:4700::1111',
          family,
          false,
          `reject family ${label} with public v6`,
        );
      }

      const { proxy, sum } = makeHostileProxy('family');
      expectClassify(fn, '8.8.8.8', proxy, false, 'reject Proxy family');
      assert.equal(sum(), 0, 'Proxy family must not trip caller traps');
    });
  });

  // ── 3. Address shape gate ───────────────────────────────────────────────

  describe('3 address must be primitive string; net.isIP must match family', () => {
    it('rejects non-string address forms with zero coercion/traps', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();

      const stringWrapper = new String('8.8.8.8');
      let valueOfCalls = 0;
      let toStringCalls = 0;
      Object.defineProperty(stringWrapper, 'valueOf', {
        configurable: true,
        value() {
          valueOfCalls += 1;
          return '8.8.8.8';
        },
      });
      Object.defineProperty(stringWrapper, 'toString', {
        configurable: true,
        value() {
          toStringCalls += 1;
          return '8.8.8.8';
        },
      });
      expectClassify(fn, stringWrapper, 4, false, 'String wrapper 8.8.8.8');
      assert.equal(valueOfCalls, 0, 'String wrapper valueOf must not run');
      assert.equal(toStringCalls, 0, 'String wrapper toString must not run');

      const buf = Buffer.from('8.8.8.8');
      expectClassify(fn, buf, 4, false, 'Buffer address');

      const url = new URL('https://8.8.8.8/');
      expectClassify(fn, url, 4, false, 'URL object address');

      expectClassify(fn, { toString: () => '8.8.8.8' }, 4, false, 'toString object');
      expectClassify(fn, ['8.8.8.8'], 4, false, 'array address');
      expectClassify(fn, 0x08080808, 4, false, 'number address');
      expectClassify(fn, 8n, 4, false, 'bigint address');

      const { proxy, sum } = makeHostileProxy('address');
      expectClassify(fn, proxy, 4, false, 'Proxy address');
      assert.equal(sum(), 0, 'Proxy address must not trip caller traps');

      const revocable = Proxy.revocable({ ip: '8.8.8.8' }, {});
      revocable.revoke();
      expectClassify(fn, revocable.proxy, 4, false, 'revoked Proxy address');
      expectClassify(fn, revocable.proxy, 6, false, 'revoked Proxy address family 6');
    });

    it('rejects whitespace, CIDR, zone id, hostname, empty, leading-zero IPv4', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();
      /** @type {Array<[string, number, string]>} */
      const cases = [
        ['', 4, 'empty string v4 family'],
        ['', 6, 'empty string v6 family'],
        [' ', 4, 'single space'],
        ['8.8.8.8 ', 4, 'trailing space v4'],
        [' 8.8.8.8', 4, 'leading space v4'],
        ['\t8.8.8.8', 4, 'tab prefix v4'],
        ['8.8.8.8\n', 4, 'newline suffix v4'],
        ['8.8.8.8/32', 4, 'IPv4 CIDR'],
        ['8.8.8.8/0', 4, 'IPv4 CIDR /0'],
        ['2001:4860:4860::8888/128', 6, 'IPv6 CIDR'],
        ['2001:4860:4860::8888/64', 6, 'IPv6 CIDR /64'],
        ['fe80::1%lo0', 6, 'zone id lo0'],
        ['fe80::1%eth0', 6, 'zone id eth0'],
        ['fe80::1%1', 6, 'zone id numeric'],
        ['example.com', 4, 'hostname family 4'],
        ['example.com', 6, 'hostname family 6'],
        ['localhost', 4, 'localhost'],
        ['alerts.acme.com', 6, 'dns name'],
        ['01.2.3.4', 4, 'leading-zero IPv4 first octet'],
        ['1.02.3.4', 4, 'leading-zero IPv4 second octet'],
        ['1.2.03.4', 4, 'leading-zero IPv4 third octet'],
        ['1.2.3.04', 4, 'leading-zero IPv4 fourth octet'],
        ['192.168.001.001', 4, 'leading-zero private IPv4'],
        ['08.8.8.8', 4, 'leading-zero public-looking'],
        ['::', 4, 'unspecified with family 4'],
        ['8.8.8.8', 6, 'v4 literal family mismatch 6'],
        ['2606:4700:4700::1111', 4, 'v6 literal family mismatch 4'],
        ['::ffff:8.8.8.8', 4, 'v4-mapped with family 4'],
      ];
      for (const [address, family, label] of cases) {
        // Document net.isIP gate: many of these are already non-matching.
        expectClassify(fn, address, family, false, label);
      }
    });

    it('rejects IPv4-mapped IPv6, IPv4 tail forms, and scope-bearing strings', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();
      /** @type {string[]} */
      const mappedAndTail = [
        '::ffff:192.0.2.1',
        '::ffff:c000:201',
        '0:0:0:0:0:ffff:192.0.2.1',
        '0:0:0:0:0:ffff:c000:201',
        '::ffff:8.8.8.8',
        '::ffff:0808:0808',
        '2001:db8::192.0.2.1',
        '2001:db8:0:0:0:0:192.0.2.1',
        '64:ff9b::192.0.2.1',
        '2606:4700:4700::192.0.2.1',
      ];
      for (const address of mappedAndTail) {
        expectClassify(fn, address, 6, false, `reject IPv4-mapped/tail ${address}`);
        // If net.isIP accepts as 6, classifier must still deny (exact parser rule).
        if (net.isIP(address) === 6) {
          expectClassify(
            fn,
            address,
            6,
            false,
            `net.isIP=6 but IPv4 tail/mapped still denied: ${address}`,
          );
        }
      }
    });
  });

  // ── 4. IPv4 public positives + family mismatch ──────────────────────────

  describe('4 IPv4 public positives and family mismatch', () => {
    it('accepts multiple clear public IPv4 addresses with family 4', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();
      const publics = [
        '1.0.0.1',
        '1.1.1.1',
        '8.8.4.4',
        '8.8.8.8',
        '9.9.9.9',
        '13.32.0.1',
        '104.16.1.1',
        '142.250.190.14',
        '208.67.222.222',
        '223.255.255.255', // last address before 224/4 multicast
        '126.255.255.255', // last before 127/8
        '128.0.0.0', // first after 127/8; also signed-int32 sign bit
        '172.15.255.255', // last before 172.16/12
        '172.32.0.0', // first after 172.16/12
        '100.63.255.255', // last before CGNAT 100.64/10
        '100.128.0.0', // first after CGNAT
      ];
      for (const address of publics) {
        assert.equal(net.isIP(address), 4, `fixture must be net.isIP=4: ${address}`);
        assert.equal(
          oracleIpv4Public(ipv4ToU32(address)),
          true,
          `oracle must mark public: ${address}`,
        );
        expectClassify(fn, address, 4, true, `public IPv4 ${address}`);
        expectClassify(fn, address, 6, false, `family mismatch v4→6 ${address}`);
      }
    });

    it('denies classic private/special IPv4 samples', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();
      const denied = [
        '0.0.0.0',
        '0.1.2.3',
        '10.0.0.1',
        '10.255.255.255',
        '100.64.0.1',
        '100.127.255.254',
        '127.0.0.1',
        '127.255.255.255',
        '169.254.0.1',
        '172.16.0.1',
        '172.31.255.255',
        '192.0.0.1',
        '192.0.2.1',
        '192.168.0.1',
        '192.168.255.255',
        '198.18.0.1',
        '198.51.100.1',
        '203.0.113.1',
        '224.0.0.1',
        '239.255.255.255',
        '240.0.0.1',
        '255.255.255.255',
      ];
      for (const address of denied) {
        assert.equal(net.isIP(address), 4, `fixture must be net.isIP=4: ${address}`);
        expectClassify(fn, address, 4, false, `deny IPv4 sample ${address}`);
      }
    });
  });

  // ── 5. IPv4 deny-prefix boundary matrix ──────────────────────────────────

  describe('5 IPv4 deny prefix boundaries (before/first/last/after)', () => {
    it('covers every deny prefix with representable neighbors against full table', async (t) => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();

      for (const { name, prefix, bits } of IPV4_DENY_PREFIXES) {
        const { first, last } = ipv4Range(prefix, bits);
        assert.equal(first <= last, true, `${name}: first<=last`);

        /** @type {Array<{ boundary: string, u: number | null, address: string | null }>} */
        const points = [
          {
            boundary: 'first',
            u: first,
            address: u32ToIpv4(first),
          },
          {
            boundary: 'last',
            u: last,
            address: u32ToIpv4(last),
          },
          {
            boundary: 'before',
            u: first === 0 ? null : (first - 1) >>> 0,
            address: first === 0 ? null : u32ToIpv4((first - 1) >>> 0),
          },
          {
            boundary: 'after',
            u: last === 0xffffffff ? null : (last + 1) >>> 0,
            address: last === 0xffffffff ? null : u32ToIpv4((last + 1) >>> 0),
          },
        ];

        for (const point of points) {
          const testName = `IPv4 ${name} ${point.boundary}`
            + (point.address ? ` ${point.address}` : ' (none)');
          // Nested subtests keep off-by-one failures addressable.
          await t.test(testName, () => {
            if (point.address === null || point.u === null) {
              // 0/8 has no before; 240/4 has no after.
              assert.ok(
                (name === '0.0.0.0/8' && point.boundary === 'before')
                  || (name === '240.0.0.0/4' && point.boundary === 'after'),
                `${testName}: unexpected missing neighbor`,
              );
              return;
            }

            assert.equal(
              net.isIP(point.address),
              4,
              `${testName}: generated address must pass net.isIP=4`,
            );

            const expected = oracleIpv4Public(point.u);
            if (point.boundary === 'first' || point.boundary === 'last') {
              assert.equal(
                expected,
                false,
                `${testName}: first/last of deny prefix must be denied by oracle`,
              );
            }

            expectClassify(
              fn,
              point.address,
              4,
              expected,
              `${testName} expected=${expected}`,
            );

            // Neighbor that lands in another deny prefix must still be false
            // (e.g. after 224/4 → 240.0.0.0 still denied by 240/4).
            if (!expected) {
              expectClassify(
                fn,
                point.address,
                4,
                false,
                `${testName}: full deny-table still rejects`,
              );
            }
          });
        }
      }
    });

    it('catches signed-32 and off-by-one traps around high-bit IPv4', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();
      /** @type {Array<[string, boolean, string]>} */
      const cases = [
        ['127.255.255.255', false, 'last of 127/8'],
        ['128.0.0.0', true, 'first after 127/8 (sign bit)'],
        ['223.255.255.255', true, 'last before 224/4'],
        ['224.0.0.0', false, 'first of multicast 224/4'],
        ['239.255.255.255', false, 'last of 224/4'],
        ['240.0.0.0', false, 'first of 240/4 (after 224/4 overlap)'],
        ['255.255.255.255', false, 'last of 240/4 / limited broadcast'],
        ['9.255.255.255', true, 'before 10/8'],
        ['10.0.0.0', false, 'first 10/8'],
        ['10.255.255.255', false, 'last 10/8'],
        ['11.0.0.0', true, 'after 10/8'],
        ['172.16.0.0', false, 'first 172.16/12'],
        ['172.31.255.255', false, 'last 172.16/12'],
        ['192.168.0.0', false, 'first 192.168/16'],
        ['192.168.255.255', false, 'last 192.168/16'],
        ['198.18.0.0', false, 'first 198.18/15'],
        ['198.19.255.255', false, 'last 198.18/15'],
        ['198.20.0.0', true, 'after 198.18/15'],
      ];
      for (const [address, expected, label] of cases) {
        assert.equal(oracleIpv4Public(ipv4ToU32(address)), expected, `oracle ${label}`);
        expectClassify(fn, address, 4, expected, label);
      }
    });
  });

  // ── 6. IPv6 allow/deny boundaries ───────────────────────────────────────

  describe('6 IPv6 2000::/3 allow and four deny prefix boundaries', () => {
    it('covers 2000::/3 allow boundaries and four deny prefixes before/first/last/after', async (t) => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();

      /** @type {Array<{ name: string, first: bigint, last: bigint, isAllowShell?: boolean }>} */
      const ranges = [
        {
          name: '2000::/3',
          ...ipv6Range(IPV6_ALLOW_PREFIX, IPV6_ALLOW_BITS),
          isAllowShell: true,
        },
        {
          name: '2001::/23',
          ...ipv6Range(IPV6_DENY_PREFIXES[0].prefix, IPV6_DENY_PREFIXES[0].bits),
        },
        {
          name: '2001:db8::/32',
          ...ipv6Range(IPV6_DENY_PREFIXES[1].prefix, IPV6_DENY_PREFIXES[1].bits),
        },
        {
          name: '2002::/16',
          ...ipv6Range(IPV6_DENY_PREFIXES[2].prefix, IPV6_DENY_PREFIXES[2].bits),
        },
        {
          name: '3fff::/20',
          ...ipv6Range(IPV6_DENY_PREFIXES[3].prefix, IPV6_DENY_PREFIXES[3].bits),
        },
      ];

      for (const range of ranges) {
        const points = [
          { boundary: 'first', n: range.first },
          { boundary: 'last', n: range.last },
          {
            boundary: 'before',
            n: range.first === 0n ? null : range.first - 1n,
          },
          {
            boundary: 'after',
            n: range.last === U128_MASK ? null : range.last + 1n,
          },
        ];

        for (const point of points) {
          const address = point.n === null ? null : u128ToIpv6Expanded(point.n);
          const compressed = point.n === null ? null : u128ToIpv6Compressed(point.n);
          const testName = `IPv6 ${range.name} ${point.boundary}`
            + (address ? ` ${address}` : ' (none)');

          await t.test(testName, () => {
            if (point.n === null || address === null || compressed === null) {
              assert.fail(`${testName}: unexpected missing neighbor for IPv6 range`);
              return;
            }

            assert.equal(net.isIP(address), 6, `${testName}: expanded must be isIP=6`);
            assert.equal(net.isIP(compressed), 6, `${testName}: compressed must be isIP=6`);

            const expected = oracleIpv6Public(point.n);

            // Deny-prefix first/last must be false.
            if (!range.isAllowShell && (point.boundary === 'first' || point.boundary === 'last')) {
              assert.equal(expected, false, `${testName}: deny first/last oracle false`);
            }

            // Allow-shell first/last are public only if not covered by an inner deny.
            // 2000:: first is public; 3fff:ffff:... last is public (outside 3fff::/20).
            expectClassify(fn, address, 6, expected, `${testName} expanded expected=${expected}`);
            expectClassify(
              fn,
              compressed,
              6,
              expected,
              `${testName} compressed expected=${expected}`,
            );
            expectClassify(fn, address, 4, false, `${testName} family mismatch →4`);
          });
        }
      }
    });

    it('explicitly rejects unspecified, loopback, mapped, NAT64, tunnels, ULA, link/site-local, multicast, 4000::', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();
      /** @type {string[]} */
      const rejected = [
        '::',
        '::1',
        '0:0:0:0:0:0:0:0',
        '0:0:0:0:0:0:0:1',
        '::ffff:0:0',
        '::ffff:192.0.2.1',
        '::ffff:c000:201',
        // NAT64 well-known prefixes
        '64:ff9b::',
        '64:ff9b::1',
        '64:ff9b::c000:201',
        '64:ff9b:1::',
        '64:ff9b:1::1',
        '64:ff9b:1:ffff:ffff:ffff:ffff:ffff',
        // Teredo / IETF protocol assignments inside 2001::/23
        '2001::',
        '2001:0:0:0:0:0:0:1',
        '2001:1::1',
        '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
        // 6to4
        '2002::',
        '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        // documentation
        '2001:db8::',
        '2001:db8::1',
        '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
        // ULA fc00::/7
        'fc00::',
        'fc00::1',
        'fd12:3456:789a::1',
        'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        // link-local fe80::/10
        'fe80::',
        'fe80::1',
        'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        // site-local fec0::/10 (deprecated)
        'fec0::',
        'fec0::1',
        'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        // multicast ff00::/8
        'ff00::',
        'ff02::1',
        'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        // outside 2000::/3
        '4000::',
        '4000::1',
        '1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        '1000::',
        '::2',
        '100::',
        '200::',
        // discard/dummy prefix 100::/64 (outside allow)
        '100::1',
      ];
      for (const address of rejected) {
        // Some forms may fail net.isIP (e.g. with IPv4 tail); still must return false.
        expectClassify(fn, address, 6, false, `reject special IPv6 ${address}`);
      }
    });

    it('accepts multiple clear public IPv6 addresses in compressed/expanded/case variants', () => {
      const { isPublicAuditIntegrityAlertAddress: fn } = requireApi();
      /** @type {Array<[string, string]>} */
      const publics = [
        ['2606:4700:4700::1111', 'Cloudflare DNS compressed'],
        ['2606:4700:4700:0:0:0:0:1111', 'Cloudflare expanded zeros'],
        ['2606:4700:4700:0000:0000:0000:0000:1111', 'Cloudflare full hextets'],
        ['2a00:1450:4009:80b::200e', 'Google compressed'],
        ['2A00:1450:4009:80B::200E', 'Google uppercase hex'],
        ['2a00:1450:4009:80B::200e', 'Google mixed-case hex'],
        ['2a00:1450:4009:80b:0:0:0:200e', 'Google expanded'],
        ['2001:4860:4860::8888', 'Google DNS (outside 2001::/23)'],
        ['2001:4860:4860:0:0:0:0:8844', 'Google DNS secondary'],
        ['2000::', 'first of 2000::/3 allow shell'],
        ['2000::1', 'near first of allow shell'],
        ['2001:200::', 'after 2001::/23 deny'],
        ['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', 'before 2001:db8::/32'],
        ['2001:db9::', 'after 2001:db8::/32'],
        ['2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'before 2002::/16'],
        ['2003::', 'after 2002::/16'],
        ['3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'before 3fff::/20'],
        ['3fff:1000::', 'after 3fff::/20 still in 2000::/3'],
        ['3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'last of 2000::/3'],
      ];
      for (const [address, label] of publics) {
        assert.equal(net.isIP(address), 6, `fixture isIP=6: ${label} ${address}`);
        // Independent pure-hextet parse oracle (no IPv4 tail / zone in these fixtures).
        const expected = oracleIpv6Public(parsePureIpv6ToU128(address));
        assert.equal(expected, true, `oracle public: ${label} ${address}`);
        expectClassify(fn, address, 6, true, `public IPv6 ${label}: ${address}`);
        expectClassify(fn, address, 4, false, `family mismatch v6→4 ${label}`);
      }
    });
  });

  // ── 7. Structural source scan ───────────────────────────────────────────

  describe('7 structural source scan', () => {
    it('allows only node:net (or no imports); forbids sockets DNS HTTP FS env timers fetch Agent Web scheduler', async () => {
      const source = await readFile(PRODUCTION_MODULE_PATH, 'utf8');

      const importRe = /\bfrom\s+['"]([^'"]+)['"]/g;
      /** @type {string[]} */
      const imports = [];
      for (const match of source.matchAll(importRe)) {
        imports.push(match[1]);
      }
      // Also catch require() if someone sneaks CJS interop.
      const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (const match of source.matchAll(requireRe)) {
        imports.push(match[1]);
      }

      const allowed = new Set(['node:net']);
      for (const imp of imports) {
        assert.equal(allowed.has(imp), true, `unexpected import/require: ${imp}`);
      }

      assert.equal(
        source.includes('isPublicAuditIntegrityAlertAddress'),
        true,
        'must export isPublicAuditIntegrityAlertAddress',
      );
      assert.equal(
        source.includes('isIP'),
        true,
        'must use net.isIP (isIP identifier present)',
      );

      for (const forbidden of [
        'node:dns',
        'node:http',
        'node:https',
        'node:fs',
        'node:fs/promises',
        'fs/promises',
        'node:path',
        'node:child_process',
        'node:dgram',
        'node:tls',
        'node:worker_threads',
        'node:os',
        'process.env',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'NODE_EXTRA_CA_CERTS',
        'fetch(',
        'globalThis.fetch',
        'node-fetch',
        'undici',
        'setTimeout(',
        'setInterval(',
        'setImmediate(',
        'clearTimeout(',
        'clearInterval(',
        'scheduler',
        'readFileSync',
        'writeFileSync',
        'createServer',
        'createConnection',
        'Socket',
        '.connect(',
        'net.connect',
        'net.createConnection',
        'new net.Socket',
        'dns.lookup',
        'dns.resolve',
        'lookupAll',
        'https.Agent',
        'http.Agent',
        'new Agent',
        'Agent(',
        'keychain',
        'credential',
        'retry',
        'backoff',
        'dead-letter',
        'deadLetter',
        "from './agent.js'",
        "from './server.js'",
        "from './web/",
        "from '../web/",
        'audit-integrity-alert-https-transport',
        'audit-integrity-alert-delivery',
        'audit-integrity-alert-destination-policy',
        'gold-readiness',
        'ipaddr',
        'ip-address',
        'cidr-regex',
        'netmask',
        'from \'ip\'',
        'from "ip"',
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `forbidden production surface: ${forbidden}`,
        );
      }

      // Independent IPv4 unsigned/prefix table + IPv6 8-hextet/128-bit parser anchors.
      // These are contract requirements for GREEN, not algorithm dictation beyond presence.
      assert.match(
        source,
        /(>>> 0|>>>0|Uint32|0xffffffff|0xFFFFFFFF)/,
        'must include IPv4 unsigned 32-bit arithmetic markers',
      );
      assert.match(
        source,
        /(hextet|128|0xffff|0xFFFF|BigInt|1n\s*<<\s*128|<<\s*16)/,
        'must include IPv6 128-bit / hextet parser markers',
      );
    });
  });
});

/**
 * Pure hextet IPv6 parser for test oracle fixtures (rejects IPv4 tails / zones).
 * Accepts compressed `::` and mixed-case hex; no dotted IPv4 tail.
 * @param {string} address
 * @returns {bigint}
 */
function parsePureIpv6ToU128(address) {
  assert.equal(typeof address, 'string');
  assert.equal(address.includes('%'), false, `zone not allowed in oracle parse: ${address}`);
  assert.equal(address.includes('.'), false, `IPv4 tail not allowed in oracle parse: ${address}`);
  const lower = address.toLowerCase();
  let head;
  let tail;
  if (lower.includes('::')) {
    const parts = lower.split('::');
    assert.equal(parts.length, 2, `bad :: in ${address}`);
    head = parts[0] === '' ? [] : parts[0].split(':');
    tail = parts[1] === '' ? [] : parts[1].split(':');
  } else {
    head = lower.split(':');
    tail = [];
  }
  const missing = 8 - (head.length + tail.length);
  assert.equal(missing >= 0, true, `too many hextets: ${address}`);
  if (!lower.includes('::')) {
    assert.equal(head.length, 8, `need 8 hextets: ${address}`);
  } else {
    assert.equal(missing >= 1 || (head.length + tail.length) <= 8, true);
  }
  const hextets = [
    ...head,
    ...Array.from({ length: lower.includes('::') ? missing : 0 }, () => '0'),
    ...tail,
  ];
  assert.equal(hextets.length, 8, `expanded length: ${address}`);
  let n = 0n;
  for (const h of hextets) {
    assert.equal(/^[0-9a-f]{1,4}$/.test(h), true, `bad hextet ${h} in ${address}`);
    n = (n << 16n) + BigInt(parseInt(h, 16));
  }
  return n;
}
