/**
 * V1.40 C3 multi-process worker fixture (test-only).
 *
 * Real independent Node process; IPC protocol matches
 * test/audit-integrity-multiprocess-lock.test.js.
 * No path/secret printing. Minimal env is provided by parent fork().
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const KIND = Object.freeze({
  HELLO: 'HELLO',
  READY: 'READY',
  BARRIER_READY: 'BARRIER_READY',
  ENTERED: 'ENTERED',
  LOCKF_EXITED: 'LOCKF_EXITED',
  DONE: 'DONE',
  ERROR: 'ERROR',
});

const ROLE = Object.freeze({
  HOLD_QUEUE: 'HOLD_QUEUE',
  CONTEND_ENTER: 'CONTEND_ENTER',
  APPEND_BARRIER: 'APPEND_BARRIER',
  TIMEOUT_CONTEND: 'TIMEOUT_CONTEND',
  WAITER_QUEUE: 'WAITER_QUEUE',
  PREPARE_CRASH: 'PREPARE_CRASH',
  APPEND_ONCE: 'APPEND_ONCE',
});

const LOCK_CODE = 'audit-integrity-process-lock-unavailable';

/** @type {{ resolve: () => void, promise: Promise<void> } | null} */
let releaseGate = null;

function newReleaseGate() {
  /** @type {() => void} */
  let resolveFn = () => {};
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  releaseGate = { resolve: resolveFn, promise };
  return releaseGate;
}

/**
 * Sanitized IPC send — fixed enums/fields only.
 * @param {Record<string, unknown>} msg
 */
function send(msg) {
  if (typeof process.send === 'function') {
    process.send(msg);
  }
}

/**
 * @param {unknown} error
 * @returns {{ name: string, code: string }}
 */
function sanitizeError(error) {
  const name =
    error && typeof error === 'object' && typeof /** @type {{ name?: unknown }} */ (error).name === 'string'
      ? /** @type {{ name: string }} */ (error).name
      : 'Error';
  const code =
    error && typeof error === 'object' && typeof /** @type {{ code?: unknown }} */ (error).code === 'string'
      ? /** @type {{ code: string }} */ (error).code
      : name === 'AuditIntegrityProcessLockError'
        ? LOCK_CODE
        : 'worker-error';
  // Never embed message paths; fixed code only for process-lock.
  if (code === LOCK_CODE || name === 'AuditIntegrityProcessLockError') {
    return { name: 'AuditIntegrityProcessLockError', code: LOCK_CODE };
  }
  return { name, code };
}

/**
 * Wait for parent op with deadline.
 * @param {string} op
 * @param {number} ms
 */
function waitOp(op, ms = 120_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      process.off('message', onMessage);
    };
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    timer = setTimeout(() => {
      settle(() => reject(new Error(`waitOp ${op} timeout`)));
    }, ms);
    /** @param {unknown} msg */
    const onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const m = /** @type {{ op?: string }} */ (msg);
      if (m.op === op) settle(() => resolve(m));
      if (m.op === 'RELEASE' && releaseGate) {
        releaseGate.resolve();
      }
    };
    process.on('message', onMessage);
  });
}

// RELEASE may arrive while holding; keep a permanent listener.
process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (/** @type {{ op?: string }} */ (msg).op === 'RELEASE' && releaseGate) {
    releaseGate.resolve();
  }
});

/**
 * @param {string} root
 * @param {string} workerId
 * @param {string} role
 */
async function runHoldQueue(root, workerId, role) {
  const { enqueueAuditIntegrityWriteTask } = await import(
    join(REPO_ROOT, 'src/audit-integrity-write-queue.js')
  );
  const gate = newReleaseGate();
  await enqueueAuditIntegrityWriteTask(root, async () => {
    // Task body runs only after process-lock acquire completed (lockf child exit 0).
    send({
      kind: KIND.READY,
      role,
      workerId,
      lockfChildExited: true,
      pid: process.pid,
    });
    await gate.promise;
  });
  send({ kind: KIND.DONE, role, workerId, ok: true });
}

/**
 * @param {string} root
 * @param {string} workerId
 * @param {string} role
 */
async function runContendEnter(root, workerId, role) {
  const { enqueueAuditIntegrityWriteTask } = await import(
    join(REPO_ROOT, 'src/audit-integrity-write-queue.js')
  );
  const gate = newReleaseGate();
  await enqueueAuditIntegrityWriteTask(root, async () => {
    send({
      kind: KIND.ENTERED,
      role,
      workerId,
      lockfChildExited: true,
      pid: process.pid,
    });
    await gate.promise;
  });
  send({ kind: KIND.DONE, role, workerId, ok: true });
}

/**
 * @param {string} root
 * @param {string} workerId
 * @param {string} role
 * @param {object} event
 */
async function runAppendBarrier(root, workerId, role, event) {
  send({ kind: KIND.BARRIER_READY, role, workerId, pid: process.pid });
  await waitOp('GO');
  const { appendAuditEventWithIntegrityDualWrite } = await import(
    join(REPO_ROOT, 'src/audit-integrity-dual-write.js')
  );
  await appendAuditEventWithIntegrityDualWrite(root, event);
  send({ kind: KIND.DONE, role, workerId, ok: true });
}

/**
 * @param {string} root
 * @param {string} workerId
 * @param {string} role
 */
async function runTimeoutContend(root, workerId, role) {
  const { enqueueAuditIntegrityWriteTask } = await import(
    join(REPO_ROOT, 'src/audit-integrity-write-queue.js')
  );
  let taskEntered = false;
  try {
    await enqueueAuditIntegrityWriteTask(root, async () => {
      taskEntered = true;
      // Must not run while holder holds through -t 5.
      await delay(10);
    });
    send({
      kind: KIND.ERROR,
      role,
      workerId,
      name: 'Error',
      code: 'unexpected-success',
      taskEntered,
    });
    process.exitCode = 1;
    return;
  } catch (error) {
    const sanitized = sanitizeError(error);
    send({
      kind: KIND.ERROR,
      role,
      workerId,
      name: sanitized.name,
      code: sanitized.code,
      taskEntered,
    });
    // Exit 0 so parent can treat mapped timeout as expected protocol outcome.
    process.exitCode = 0;
  }
}

/**
 * Contender that would enter task body and write a marker. Used for SIGKILL-during-wait:
 * if parent is killed before acquire, marker must never appear.
 *
 * @param {string} root
 * @param {string} workerId
 * @param {string} role
 * @param {string} markerPath
 */
async function runWaiterQueue(root, workerId, role, markerPath) {
  const { enqueueAuditIntegrityWriteTask } = await import(
    join(REPO_ROOT, 'src/audit-integrity-write-queue.js')
  );
  const gate = newReleaseGate();
  try {
    await enqueueAuditIntegrityWriteTask(root, async () => {
      // Lease-backed task body marker (outside audit/).
      await writeFile(markerPath, `entered:${process.pid}\n`, { flag: 'wx' });
      send({
        kind: KIND.ENTERED,
        role,
        workerId,
        lockfChildExited: true,
        pid: process.pid,
      });
      await gate.promise;
    });
    send({ kind: KIND.DONE, role, workerId, ok: true });
  } catch (error) {
    const sanitized = sanitizeError(error);
    send({
      kind: KIND.ERROR,
      role,
      workerId,
      name: sanitized.name,
      code: sanitized.code,
      taskEntered: false,
    });
    process.exitCode = sanitized.code === LOCK_CODE ? 0 : 1;
  }
}

/**
 * @param {string} root
 * @param {string} workerId
 * @param {string} role
 * @param {object} event
 */
async function runPrepareCrash(root, workerId, role, event) {
  const {
    appendAuditEventWithIntegrityDualWrite,
    DUAL_WRITE_TEST_CRASH_HOOK,
  } = await import(join(REPO_ROOT, 'src/audit-integrity-dual-write.js'));
  try {
    await appendAuditEventWithIntegrityDualWrite(root, event, {
      [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
    });
    send({
      kind: KIND.ERROR,
      role,
      workerId,
      name: 'Error',
      code: 'expected-crash-missing',
    });
    process.exitCode = 1;
    return;
  } catch (error) {
    const code =
      error && typeof error === 'object' && typeof /** @type {{ code?: unknown }} */ (error).code === 'string'
        ? /** @type {{ code: string }} */ (error).code
        : '';
    // Expected test crash after durable prepared publish.
    if (code === 'TEST_CRASH_AFTER_PREPARED') {
      send({ kind: KIND.DONE, role, workerId, ok: true, prepared: true });
      process.exitCode = 0;
      return;
    }
    const sanitized = sanitizeError(error);
    send({
      kind: KIND.ERROR,
      role,
      workerId,
      name: sanitized.name,
      code: sanitized.code,
    });
    process.exitCode = 1;
  }
}

/**
 * Normal queue-backed dual-write append (also drives prepared recovery via ensure-idle).
 * @param {string} root
 * @param {string} workerId
 * @param {string} role
 * @param {object} event
 */
async function runAppendOnce(root, workerId, role, event) {
  const { appendAuditEventWithIntegrityDualWrite } = await import(
    join(REPO_ROOT, 'src/audit-integrity-dual-write.js')
  );
  await appendAuditEventWithIntegrityDualWrite(root, event);
  send({ kind: KIND.DONE, role, workerId, ok: true });
}

/**
 * @param {Record<string, unknown>} init
 */
async function dispatch(init) {
  const role = String(init.role || '');
  const root = String(init.root || '');
  const workerId = String(init.workerId || 'W');
  if (!root || !role) {
    send({ kind: KIND.ERROR, role, workerId, name: 'Error', code: 'bad-init' });
    process.exitCode = 1;
    return;
  }

  send({ kind: KIND.HELLO, role, workerId, pid: process.pid });

  switch (role) {
    case ROLE.HOLD_QUEUE:
      await runHoldQueue(root, workerId, role);
      break;
    case ROLE.CONTEND_ENTER:
      await runContendEnter(root, workerId, role);
      break;
    case ROLE.APPEND_BARRIER:
      await runAppendBarrier(root, workerId, role, /** @type {object} */ (init.event));
      break;
    case ROLE.TIMEOUT_CONTEND:
      await runTimeoutContend(root, workerId, role);
      break;
    case ROLE.WAITER_QUEUE:
      await runWaiterQueue(root, workerId, role, String(init.markerPath || ''));
      break;
    case ROLE.PREPARE_CRASH:
      await runPrepareCrash(root, workerId, role, /** @type {object} */ (init.event));
      break;
    case ROLE.APPEND_ONCE:
      await runAppendOnce(root, workerId, role, /** @type {object} */ (init.event));
      break;
    default:
      send({ kind: KIND.ERROR, role, workerId, name: 'Error', code: 'unknown-role' });
      process.exitCode = 1;
  }
}

process.once('message', (msg) => {
  if (!msg || typeof msg !== 'object') {
    process.exit(2);
    return;
  }
  const m = /** @type {Record<string, unknown>} */ (msg);
  if (m.op !== 'INIT') {
    process.exit(2);
    return;
  }
  dispatch(m)
    .then(() => {
      // Allow IPC flush then exit.
      setTimeout(() => process.exit(process.exitCode ?? 0), 20);
    })
    .catch((error) => {
      const sanitized = sanitizeError(error);
      send({
        kind: KIND.ERROR,
        role: String(m.role || ''),
        workerId: String(m.workerId || ''),
        name: sanitized.name,
        code: sanitized.code,
      });
      setTimeout(() => process.exit(1), 20);
    });
});
