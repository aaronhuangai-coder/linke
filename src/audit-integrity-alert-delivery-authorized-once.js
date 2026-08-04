/**
 * Authorize-before-deliver gate for one-shot audit integrity alert delivery.
 *
 * Compiles a destination allowlist policy and only invokes the one-shot
 * coordinator after a successful, bit-identical primitive-string authorize.
 * Deny / throw / malformed authorize output never reach the one-shot path
 * (hence zero claim, DNS, or HTTPS). All public failures collapse to a fresh
 * path-free audit-delivery-unavailable LinkeError.
 *
 * No env, filesystem, DNS, network, timers, host surfaces, or external wiring.
 */

import { types as utilTypes } from 'node:util';

import { createAuditIntegrityAlertDestinationPolicy } from './audit-integrity-alert-destination-policy.js';
import { deliverAuditIntegrityAlertOnce } from './audit-integrity-alert-delivery-once.js';
import { ERROR_CODES, LinkeError } from './error-codes.js';

/** Exact ordered test-factory dependency keys. */
const DEPS_KEYS = Object.freeze(['authorizeDestination', 'deliverOnce']);

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
 * utilTypes.isProxy first so hostile traps never fire.
 *
 * @param {unknown} value
 * @returns {object}
 */
function assertPlainDataObject(value) {
  if (!isPlainObject(value)) fail();
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
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
 * Exact dependency object for the test factory. Reads functions only via own
 * data descriptors so accessors never run. Snapshots both function references.
 *
 * @param {unknown} deps
 * @returns {{
 *   authorizeDestination: Function,
 *   deliverOnce: Function,
 * }}
 */
function bindDeps(deps) {
  assertPlainDataObject(deps);
  assertExactKeyOrder(deps, DEPS_KEYS);

  const authorizeDesc = Object.getOwnPropertyDescriptor(deps, 'authorizeDestination');
  const deliverDesc = Object.getOwnPropertyDescriptor(deps, 'deliverOnce');
  if (!authorizeDesc || !deliverDesc) fail();
  if (typeof authorizeDesc.value !== 'function') fail();
  if (typeof deliverDesc.value !== 'function') fail();

  return {
    authorizeDestination: /** @type {Function} */ (authorizeDesc.value),
    deliverOnce: /** @type {Function} */ (deliverDesc.value),
  };
}

/**
 * Bind authorize-before-deliver once the two functions are already snapshotted.
 *
 * Call order is strict:
 *   authorized = authorizeDestination(endpoint)
 *   return await deliverOnce(dataDir, authorized, now)
 *
 * authorize success accepts only a primitive string that is === to the original
 * endpoint primitive. No String()/await/Promise.resolve conversion of authorized.
 * deliverOnce is awaited so rejected Promises and hostile thenables converge;
 * fulfilled Promise values (including frozen receipt identity) pass through.
 *
 * @param {Function} authorizeDestination
 * @param {Function} deliverOnce
 * @returns {(dataDir: unknown, endpoint: unknown, now: unknown) => Promise<unknown>}
 */
function createDeliver(authorizeDestination, deliverOnce) {
  return async function authorizedDeliver(dataDir, endpoint, now) {
    try {
      const authorized = authorizeDestination(endpoint);
      // Primitive string only; bit-identical to the caller endpoint. Do not
      // coerce, await, or wrap — any conversion could run caller code.
      if (typeof authorized !== 'string') fail();
      if (authorized !== endpoint) fail();
      return await deliverOnce(dataDir, authorized, now);
    } catch {
      // Collapse every failure (including already-fixed LinkeError) to a fresh
      // path-free unavailable error so raw causes never escape the boundary.
      throw unavailableError();
    }
  };
}

/**
 * Production factory: compile a real destination policy and bind the real
 * one-shot coordinator behind the authorize-before-deliver gate.
 *
 * missing / null / exact empty policy become deny-all capabilities (delivery
 * calls fail closed without entering claim). Malformed policy compile errors
 * converge to fixed audit-delivery-unavailable at factory time.
 *
 * @param {unknown} policy
 * @returns {(dataDir: unknown, endpoint: unknown, now: unknown) => Promise<unknown>}
 */
export function createAuthorizedAuditIntegrityAlertDeliveryOnce(policy) {
  try {
    const capability = createAuditIntegrityAlertDestinationPolicy(policy);
    const authorizeDestination = capability.authorize;
    const deliverOnce = deliverAuditIntegrityAlertOnce;
    if (typeof authorizeDestination !== 'function') fail();
    if (typeof deliverOnce !== 'function') fail();
    return createDeliver(authorizeDestination, deliverOnce);
  } catch {
    throw unavailableError();
  }
}

/**
 * Test-only factory. deps must be a plain non-Proxy data object with exact
 * ordered keys authorizeDestination, deliverOnce (both functions). Snapshots
 * the two functions; later mutation of deps cannot rebind the returned deliver.
 *
 * @param {unknown} deps
 * @returns {(dataDir: unknown, endpoint: unknown, now: unknown) => Promise<unknown>}
 */
export function createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting(deps) {
  try {
    const bound = bindDeps(deps);
    return createDeliver(bound.authorizeDestination, bound.deliverOnce);
  } catch {
    throw unavailableError();
  }
}
