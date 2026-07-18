/**
 * Shared same-resolved-root serial write queue + module-generated lease capability
 * for audit integrity (V1.37 C1).
 *
 * Sole Map SoT for per-root write serialization across journal / future dual-write.
 * Lease settle is ONLY performed by queue infrastructure in finally of await task(lease).
 * Task has NO settle API and cannot expire lease early.
 *
 * Nested enqueue (same-root AND cross-root) is forbidden while any active audit lease
 * is in the current async context — prevents self-deadlock and AB/BA lock-order.
 *
 * Not a malicious same-process import sandbox. C1 errors: path-free SafeDataFileError only.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, normalize } from 'node:path';
import { SafeDataFileError } from './safe-data-files.js';

/**
 * Sole per-resolved-root write queue.
 * key = assertSafeDataRoot result (absolute normalized resolved root)
 * value = cleanup Promise (identity pattern; rejection does not poison next)
 * @type {Map<string, Promise<unknown>>}
 */
const auditIntegrityWriteQueues = new Map();

/** @type {AsyncLocalStorage<object>} */
const auditIntegrityWriteLeaseAls = new AsyncLocalStorage();

/**
 * Active leases bound to root. Presence = not expired.
 * @type {WeakMap<object, { resolvedRoot: string }>}
 */
const activeAuditIntegrityWriteLeases = new WeakMap();

/**
 * @returns {never}
 */
function failClosed() {
  throw new SafeDataFileError();
}

/**
 * Root MUST be non-empty absolute normalized resolved string (caller responsibility:
 * typically assertSafeDataRoot result). Path-free reject otherwise.
 * @param {unknown} resolvedRoot
 * @returns {string}
 */
function assertQueueResolvedRoot(resolvedRoot) {
  if (typeof resolvedRoot !== 'string' || resolvedRoot.length === 0) failClosed();
  if (resolvedRoot.includes('\0')) failClosed();
  if (!isAbsolute(resolvedRoot)) failClosed();
  if (normalize(resolvedRoot) !== resolvedRoot) failClosed();
  return resolvedRoot;
}

/**
 * Fail-closed unless:
 *   - lease object identity is active
 *   - lease bound root === resolvedRoot
 *   - ALS current store === lease (object identity)
 * Rejects: wrong-root / missing / expired / forged / outside-context / detached-expired.
 *
 * @param {unknown} resolvedRoot
 * @param {unknown} lease
 * @returns {void}
 */
export function assertAuditIntegrityWriteLease(resolvedRoot, lease) {
  const root = assertQueueResolvedRoot(resolvedRoot);
  if (lease === null || (typeof lease !== 'object' && typeof lease !== 'function')) {
    failClosed();
  }
  const meta = activeAuditIntegrityWriteLeases.get(/** @type {object} */ (lease));
  if (meta === undefined) failClosed();
  if (meta.resolvedRoot !== root) failClosed();
  if (auditIntegrityWriteLeaseAls.getStore() !== lease) failClosed();
}

/**
 * Sole same-resolved-root serial write queue for audit integrity + dual-write.
 * Creates a module-generated lease bound to (resolvedRoot, current task);
 * runs task under AsyncLocalStorage.run(lease, ...);
 * ONLY queue infrastructure expires/deletes lease in finally of await task(lease).
 * Task has NO settle API and cannot expire lease early.
 * Task Promise settle DEFINES lease lifecycle end.
 *
 * Nested enqueue: if current async context already holds ANY active audit
 * write lease, reject ALL nested enqueue (same-root AND cross-root).
 *
 * @param {unknown} resolvedRoot absolute normalized resolved root
 * @param {(lease: object) => unknown | Promise<unknown>} task
 * @returns {Promise<unknown>}
 */
export function enqueueAuditIntegrityWriteTask(resolvedRoot, task) {
  const root = assertQueueResolvedRoot(resolvedRoot);
  if (typeof task !== 'function') failClosed();

  // Nested enqueue guard: any active audit lease in current ALS context → reject.
  const currentStore = auditIntegrityWriteLeaseAls.getStore();
  if (currentStore !== undefined && activeAuditIntegrityWriteLeases.has(currentStore)) {
    failClosed();
  }

  const previous = auditIntegrityWriteQueues.get(root) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    // Module-generated unique frozen lease; identity is the capability token.
    const lease = Object.freeze(Object.create(null));
    activeAuditIntegrityWriteLeases.set(lease, { resolvedRoot: root });
    try {
      return await auditIntegrityWriteLeaseAls.run(lease, async () => await task(lease));
    } finally {
      // ONLY queue infrastructure may settle/expire lease here.
      activeAuditIntegrityWriteLeases.delete(lease);
    }
  });

  const cleanup = run.finally(() => {
    if (auditIntegrityWriteQueues.get(root) === cleanup) {
      auditIntegrityWriteQueues.delete(root);
    }
  });
  // Isolate poison ONLY — NEVER re-grant / reuse expired lease.
  cleanup.catch(() => {});
  auditIntegrityWriteQueues.set(root, cleanup);
  return run;
}
