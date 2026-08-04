/**
 * Conservative public-address classifier for audit-integrity alert pin checks.
 *
 * Pure function: any input yields a primitive boolean and never throws.
 * Family must be integer 4 or 6; address must be a primitive string whose
 * isIP family matches. IPv4 uses an unsigned 32-bit deny prefix table.
 * IPv6 uses an exact 8-hextet / 128-bit parser, allows only 2000::/3, then
 * applies a small deny prefix table. No IO and no external packages.
 */

import { isIP } from 'node:net';

const FAMILY_V4 = 4;
const FAMILY_V6 = 6;
const IPV4_ALL_ONES = 0xffffffff;
const HEXTET_MASK = 0xffff;
const U128_WIDTH = 128;
const U128_MASK = (1n << 128n) - 1n;

/** IPv4 special-purpose / private / multicast / reserved deny table. */
const IPV4_DENY_TABLE = Object.freeze([
  Object.freeze({ prefix: 0x00000000, bits: 8 }),
  Object.freeze({ prefix: 0x0a000000, bits: 8 }),
  Object.freeze({ prefix: 0x64400000, bits: 10 }),
  Object.freeze({ prefix: 0x7f000000, bits: 8 }),
  Object.freeze({ prefix: 0xa9fe0000, bits: 16 }),
  Object.freeze({ prefix: 0xac100000, bits: 12 }),
  Object.freeze({ prefix: 0xc0000000, bits: 24 }),
  Object.freeze({ prefix: 0xc0000200, bits: 24 }),
  Object.freeze({ prefix: 0xc01fc400, bits: 24 }),
  Object.freeze({ prefix: 0xc034c100, bits: 24 }),
  Object.freeze({ prefix: 0xc0586300, bits: 24 }),
  Object.freeze({ prefix: 0xc0a80000, bits: 16 }),
  Object.freeze({ prefix: 0xc0af3000, bits: 24 }),
  Object.freeze({ prefix: 0xc6120000, bits: 15 }),
  Object.freeze({ prefix: 0xc6336400, bits: 24 }),
  Object.freeze({ prefix: 0xcb007100, bits: 24 }),
  Object.freeze({ prefix: 0xe0000000, bits: 4 }),
  Object.freeze({ prefix: 0xf0000000, bits: 4 }),
]);

/** Global unicast shell: 2000::/3 (top three bits 001). */
const IPV6_ALLOW_PREFIX = 0x20000000000000000000000000000000n;
const IPV6_ALLOW_BITS = 3;

/** Deny prefixes inside the 2000::/3 shell. */
const IPV6_DENY_TABLE = Object.freeze([
  Object.freeze({ prefix: 0x20010000000000000000000000000000n, bits: 23 }),
  Object.freeze({ prefix: 0x20010db8000000000000000000000000n, bits: 32 }),
  Object.freeze({ prefix: 0x20020000000000000000000000000000n, bits: 16 }),
  Object.freeze({ prefix: 0x3fff0000000000000000000000000000n, bits: 20 }),
]);

const HEXTET_RE = /^[0-9a-fA-F]{1,4}$/;

/**
 * @param {unknown} address
 * @param {unknown} family
 * @returns {boolean}
 */
export function isPublicAuditIntegrityAlertAddress(address, family) {
  try {
    // typeof first: never touch Proxy / revoked Proxy with property access.
    if (typeof address !== 'string' || typeof family !== 'number') {
      return false;
    }
    if (!Number.isInteger(family) || (family !== FAMILY_V4 && family !== FAMILY_V6)) {
      return false;
    }
    if (isIP(address) !== family) {
      return false;
    }
    if (family === FAMILY_V4) {
      return isPublicIpv4(address);
    }
    return isPublicIpv6(address);
  } catch {
    return false;
  }
}

/**
 * Unsigned 32-bit network mask; safe for /0 and /32.
 * @param {number} bits
 * @returns {number}
 */
function ipv4BitMask(bits) {
  if (bits <= 0) return 0;
  if (bits >= 32) return IPV4_ALL_ONES;
  return (IPV4_ALL_ONES << (32 - bits)) >>> 0;
}

/**
 * Parse dotted-decimal IPv4 (already isIP-gated) to unsigned 32-bit.
 * @param {string} address
 * @returns {number | null}
 */
function parseIpv4Unsigned(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    // Reject textual leading zeros even if a future isIP variant loosens.
    if (part.length > 1 && part.charCodeAt(0) === 48) return null;
    value = ((value << 8) + octet) >>> 0;
  }
  return value;
}

/**
 * @param {string} address
 * @returns {boolean}
 */
function isPublicIpv4(address) {
  const value = parseIpv4Unsigned(address);
  if (value === null) return false;
  for (const entry of IPV4_DENY_TABLE) {
    const mask = ipv4BitMask(entry.bits);
    if (((value & mask) >>> 0) === ((entry.prefix & mask) >>> 0)) {
      return false;
    }
  }
  return true;
}

/**
 * True when `value` shares the high `bits` of `prefix` (128-bit).
 * @param {bigint} value
 * @param {bigint} prefix
 * @param {number} bits
 * @returns {boolean}
 */
function ipv6InPrefix(value, prefix, bits) {
  const width = BigInt(bits);
  if (width <= 0n) return true;
  if (width >= BigInt(U128_WIDTH)) {
    return (value & U128_MASK) === (prefix & U128_MASK);
  }
  const shift = BigInt(U128_WIDTH) - width;
  return (value >> shift) === ((prefix & U128_MASK) >> shift);
}

/**
 * Expand pure hextet IPv6 (optional single `::`) to 128-bit BigInt.
 * Rejects malformed forms; caller already barred `%` and `.`.
 * @param {string} address
 * @returns {bigint | null}
 */
function parseIpv6ToU128(address) {
  if (address.length === 0) return null;

  const compressAt = address.indexOf('::');
  let headParts;
  let tailParts;
  if (compressAt === -1) {
    headParts = address.split(':');
    tailParts = null;
  } else {
    if (address.indexOf('::', compressAt + 2) !== -1) return null;
    const headStr = address.slice(0, compressAt);
    const tailStr = address.slice(compressAt + 2);
    headParts = headStr === '' ? [] : headStr.split(':');
    tailParts = tailStr === '' ? [] : tailStr.split(':');
  }

  /** @type {number[]} */
  const hextets = [];
  for (const part of headParts) {
    if (!HEXTET_RE.test(part)) return null;
    hextets.push(parseInt(part, 16) & HEXTET_MASK);
  }

  if (tailParts === null) {
    if (hextets.length !== 8) return null;
  } else {
    /** @type {number[]} */
    const tailHextets = [];
    for (const part of tailParts) {
      if (!HEXTET_RE.test(part)) return null;
      tailHextets.push(parseInt(part, 16) & HEXTET_MASK);
    }
    const filled = hextets.length + tailHextets.length;
    if (filled > 7) return null;
    const missing = 8 - filled;
    for (let i = 0; i < missing; i += 1) hextets.push(0);
    for (const h of tailHextets) hextets.push(h);
    if (hextets.length !== 8) return null;
  }

  let value = 0n;
  for (const h of hextets) {
    value = (value << 16n) + BigInt(h);
  }
  return value;
}

/**
 * @param {string} address
 * @returns {boolean}
 */
function isPublicIpv6(address) {
  // Zone id and IPv4-tail / mapped dotted forms are never accepted.
  if (address.includes('%') || address.includes('.')) {
    return false;
  }
  const value = parseIpv6ToU128(address);
  if (value === null) return false;
  if (!ipv6InPrefix(value, IPV6_ALLOW_PREFIX, IPV6_ALLOW_BITS)) {
    return false;
  }
  for (const entry of IPV6_DENY_TABLE) {
    if (ipv6InPrefix(value, entry.prefix, entry.bits)) {
      return false;
    }
  }
  return true;
}
