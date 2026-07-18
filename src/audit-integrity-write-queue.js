/**
 * Shared same-resolved-root serial write queue + module-generated lease capability
 * for audit integrity (V1.37 C1).
 *
 * Sole Map SoT for per-root write serialization across journal / future dual-write.
 * Lease settle is ONLY performed by queue infrastructure in finally of await task(lease, observer).
 * Task has NO settle API and cannot expire lease early.
 *
 * Nested enqueue (same-root AND cross-root) is forbidden while any active audit lease
 * is in the current async context — prevents self-deadlock and AB/BA lock-order.
 *
 * Queue tail observation is NOT a free public export. Each running task receives a
 * frozen, mutation-free observer capability (peekTail only) bound to that task's
 * active lease and resolvedRoot. After lease settle, peekTail fail-closes.
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
 * Module-generated, frozen, mutation-free observer for one active task lease.
 * peekTail observes only this observer's resolvedRoot current cleanup identity;
 * succeeds only while the bound lease remains in activeAuditIntegrityWriteLeases.
 * Does not require ALS at the call site (saved observer may be used outside the
 * task body), but lease identity must still be active. No schedule/cancel/
 * reorder/settle/grant APIs.
 *
 * @param {string} root
 * @param {object} lease
 * @returns {{ peekTail: () => Promise<unknown> | null }}
 */
function createAuditIntegrityWriteQueueObserver(root, lease) {
  return Object.freeze({
    /**
     * @returns {Promise<unknown> | null}
     */
    peekTail() {
      const meta = activeAuditIntegrityWriteLeases.get(lease);
      if (meta === undefined) failClosed();
      if (meta.resolvedRoot !== root) failClosed();
      return auditIntegrityWriteQueues.get(root) ?? null;
    },
  });
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
 * ONLY queue infrastructure expires/deletes lease in finally of await task(lease, observer).
 * Task has NO settle API and cannot expire lease early.
 * Task Promise settle DEFINES lease lifecycle end.
 *
 * Observer is issued only by this infrastructure with the lease for the running task.
 * Callers cannot mint an observer without an active enqueued task. Existing callbacks
 * that accept only (lease) remain compatible (extra observer arg is ignored).
 *
 * Nested enqueue: if current async context already holds ANY active audit
 * write lease, reject ALL nested enqueue (same-root AND cross-root).
 *
 * Timing: run/cleanup are created and Map.set(root, cleanup) complete synchronously
 * before the task body microtask runs, so the first observer.peekTail() inside an
 * active hold task returns that hold's cleanup identity.
 *
 * @param {unknown} resolvedRoot absolute normalized resolved root
 * @param {(lease: object, observer: { peekTail: () => Promise<unknown> | null }) => unknown | Promise<unknown>} task
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
    // Observer capability is issued only with an active lease; frozen, no mutation API.
    const observer = createAuditIntegrityWriteQueueObserver(root, lease);
    try {
      return await auditIntegrityWriteLeaseAls.run(
        lease,
        async () => await task(lease, observer),
      );
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
