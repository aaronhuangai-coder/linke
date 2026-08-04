/**
 * Exact audit-integrity alert destination allowlist policy.
 *
 * Compiles a caller-supplied plain-data policy into a deep-frozen capability
 * whose authorize() performs exact string membership only. Missing/null/empty
 * policies become deny-all. Malformed or hostile inputs fail closed with the
 * fixed audit-delivery-unavailable error and never echo endpoint material.
 *
 * No env, IO, network, DNS, timers, or secrets. Not a delivery/wiring surface.
 */

import { Buffer } from 'node:buffer';
import { types as utilTypes } from 'node:util';

import { ERROR_CODES, LinkeError } from './error-codes.js';

const SCHEMA_VERSION = 1;
const MAX_ENDPOINTS = 16;
const MAX_ENDPOINT_UTF8_BYTES = 2048;
const MAX_HOSTNAME_CHARS = 253;
const MIN_HOSTNAME_CHARS = 2;
const MAX_LABEL_CHARS = 63;
const MIN_TLD_CHARS = 2;
const MAX_PATH_CHARS = 1024;

const POLICY_KEYS = Object.freeze(['schemaVersion', 'endpoints']);

/** Reserved final DNS labels (suffix deny list). */
const RESERVED_SUFFIXES = new Set([
  'localhost',
  'local',
  'internal',
  'corp',
  'home',
  'lan',
  'test',
  'example',
  'invalid',
]);

const LABEL_BODY_RE = /^[a-z0-9-]+$/;
const TLD_RE = /^[a-z]+$/;
const PATH_ALLOWED_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/;

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
 * Plain data object: not null/array/Proxy; prototype Object.prototype or null.
 * utilTypes.isProxy runs BEFORE Array.isArray / getPrototypeOf / ownKeys so
 * revoked Proxies fail closed without native TypeError escape.
 *
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (utilTypes.isProxy(value)) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject Proxy / non-plain / symbol / non-enumerable / accessor own keys.
 *
 * @param {unknown} value
 * @returns {object}
 */
function assertPlainDataObject(value) {
  if (!isPlainObject(value)) fail();
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key === 'symbol') fail();
    if (typeof key !== 'string') fail();
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc) fail();
    if (!desc.enumerable) fail();
    if (desc.get !== undefined || desc.set !== undefined) fail();
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) fail();
  }
  return value;
}

/**
 * Exact Reflect.ownKeys order (call only after assertPlainDataObject).
 *
 * @param {object} obj
 * @param {readonly string[]} expected
 */
function assertExactKeyOrder(obj, expected) {
  const keys = Reflect.ownKeys(obj);
  if (keys.length !== expected.length) fail();
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== expected[i]) fail();
  }
}

/**
 * Plain Array.prototype array of primitive strings (no Proxy / subclass).
 * Dense own-key surface only: continuous indices + length; no holes/extra/symbol.
 * Index values read via enumerable own data descriptors only (never value[i]).
 * Defensive copy of items; never retains the caller array reference.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function assertPlainStringArray(value) {
  if (utilTypes.isProxy(value)) fail();
  if (!Array.isArray(value)) fail();
  if (Object.getPrototypeOf(value) !== Array.prototype) fail();

  const lengthDesc = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDesc) fail();
  if (lengthDesc.get !== undefined || lengthDesc.set !== undefined) fail();
  if (!Object.prototype.hasOwnProperty.call(lengthDesc, 'value')) fail();
  const length = lengthDesc.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    fail();
  }
  if (length > MAX_ENDPOINTS) fail();

  const keys = Reflect.ownKeys(value);
  /** @type {string[]} */
  const expected = [];
  for (let i = 0; i < length; i += 1) expected.push(String(i));
  expected.push('length');
  if (keys.length !== expected.length) fail();
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== expected[i]) fail();
  }

  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, String(i));
    if (!desc) fail();
    if (!desc.enumerable) fail();
    if (desc.get !== undefined || desc.set !== undefined) fail();
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) fail();
    const item = desc.value;
    if (typeof item !== 'string') fail();
    out.push(item);
  }
  return out;
}

/**
 * Hostname closed DNS shape: lowercase ASCII, ≥2 labels, label/TLD bounds,
 * no punycode prefix, no reserved final label.
 *
 * @param {string} hostname
 */
function assertHostname(hostname) {
  if (typeof hostname !== 'string') fail();
  if (hostname.length < MIN_HOSTNAME_CHARS || hostname.length > MAX_HOSTNAME_CHARS) {
    fail();
  }
  if (hostname.endsWith('.')) fail();
  if (hostname.includes(':')) fail();

  const labels = hostname.split('.');
  if (labels.length < 2) fail();

  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (label.length < 1 || label.length > MAX_LABEL_CHARS) fail();
    if (label.startsWith('-') || label.endsWith('-')) fail();
    if (label.startsWith('xn--')) fail();

    const isLast = i === labels.length - 1;
    if (isLast) {
      if (label.length < MIN_TLD_CHARS || label.length > MAX_LABEL_CHARS) fail();
      if (!TLD_RE.test(label)) fail();
    } else if (!LABEL_BODY_RE.test(label)) {
      fail();
    }
  }

  const finalLabel = labels[labels.length - 1];
  if (RESERVED_SUFFIXES.has(finalLabel)) fail();
}

/**
 * Pathname closed set: 1..1024, leading slash, allowed ASCII only; reject
 * percent, backslash, double-slash, and dot-segment forms.
 *
 * @param {string} pathname
 */
function assertPathname(pathname) {
  if (typeof pathname !== 'string') fail();
  if (pathname.length < 1 || pathname.length > MAX_PATH_CHARS) fail();
  if (!pathname.startsWith('/')) fail();
  if (!PATH_ALLOWED_RE.test(pathname)) fail();
  if (pathname.includes('//')) fail();
  if (pathname.includes('/./')) fail();
  if (pathname.includes('/../')) fail();
  if (pathname.endsWith('/.') || pathname.endsWith('/..')) fail();
  if (pathname === '/.' || pathname === '/..') fail();
}

/**
 * Validate one allowlisted endpoint to the conservative HTTPS destination
 * contract. Returns the same primitive string on success (canonical identity).
 *
 * @param {unknown} endpoint
 * @returns {string}
 */
function assertCanonicalEndpoint(endpoint) {
  if (typeof endpoint !== 'string') fail();
  const byteLength = Buffer.byteLength(endpoint, 'utf8');
  if (byteLength < 1 || byteLength > MAX_ENDPOINT_UTF8_BYTES) fail();

  // Reject query/fragment markers even when URL search/hash normalize empty.
  if (endpoint.includes('?') || endpoint.includes('#')) fail();

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail();
  }

  if (parsed.href !== endpoint) fail();
  if (parsed.protocol !== 'https:') fail();
  if (parsed.username !== '' || parsed.password !== '') fail();
  if (parsed.search !== '' || parsed.hash !== '') fail();
  // Default HTTPS port only: any explicit port is non-canonical or illegal.
  if (parsed.port !== '') fail();

  assertHostname(parsed.hostname);
  assertPathname(parsed.pathname);

  return endpoint;
}

/**
 * Build the exact-key deep-frozen capability. Closes over a private Set and
 * never exposes allowlist contents on the public object surface.
 *
 * @param {'deny-all' | 'configured'} status
 * @param {number} endpointCount
 * @param {ReadonlySet<string>} allowed
 */
function makeCapability(status, endpointCount, allowed) {
  /**
   * Exact string membership gate. Success returns the authorized primitive;
   * any non-member or non-string fails closed without echoing inputs.
   *
   * @param {unknown} endpoint
   * @returns {string}
   */
  function authorize(endpoint) {
    if (typeof endpoint !== 'string') fail();
    if (!allowed.has(endpoint)) fail();
    return endpoint;
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    status,
    endpointCount,
    authorize,
  });
}

/**
 * Compile a raw destination policy into a deep-frozen authorize capability.
 *
 * - `undefined` / `null` → deny-all (endpointCount 0)
 * - exact `{ schemaVersion: 1, endpoints: [] }` → deny-all
 * - 1..16 distinct canonical HTTPS endpoints → configured
 * - any malformed or hostile structure → fixed audit-delivery-unavailable
 *
 * Does not read env, touch the filesystem, resolve DNS, open sockets, or
 * retain caller object/array references.
 *
 * @param {unknown} rawPolicy
 * @returns {{
 *   schemaVersion: 1,
 *   status: 'deny-all' | 'configured',
 *   endpointCount: number,
 *   authorize: (endpoint: unknown) => string,
 * }}
 */
export function createAuditIntegrityAlertDestinationPolicy(rawPolicy) {
  if (rawPolicy === undefined || rawPolicy === null) {
    return makeCapability('deny-all', 0, new Set());
  }

  const policy = assertPlainDataObject(rawPolicy);
  assertExactKeyOrder(policy, POLICY_KEYS);

  const schemaVersion = /** @type {{ schemaVersion: unknown }} */ (policy).schemaVersion;
  if (typeof schemaVersion !== 'number' || schemaVersion !== SCHEMA_VERSION) {
    fail();
  }

  const endpoints = assertPlainStringArray(
    /** @type {{ endpoints: unknown }} */ (policy).endpoints,
  );

  /** @type {Set<string>} */
  const allowed = new Set();
  for (const item of endpoints) {
    const canonical = assertCanonicalEndpoint(item);
    if (allowed.has(canonical)) fail();
    allowed.add(canonical);
  }

  if (allowed.size === 0) {
    return makeCapability('deny-all', 0, allowed);
  }
  return makeCapability('configured', allowed.size, allowed);
}
