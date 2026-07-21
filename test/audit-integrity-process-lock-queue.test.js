/**
 * V1.40 C2: queue ↔ process-lock integration (real acquire/release; no injection seam).
 *
 * Release-order / release-failure cases temporarily wrap FileHandle.prototype.close
 * after the task has entered (serial; restore in finally; original close always runs first).
 * Tests may repair fixture lock attributes; production never repairs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../src/error-codes.js';
import { SafeDataFileError, SAFE_DATA_FILE_ERROR } from '../src/safe-data-files.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const QUEUE_SRC = join(REPO_ROOT, 'src/audit-integrity-write-queue.js');
const LOCK_SRC = join(REPO_ROOT, 'src/audit-integrity-process-lock.js');
const LOCK_REL = 'audit/integrity-write.lock';
const LOCK_CODE = 'audit-integrity-process-lock-unavailable';

/**
 * @param {unknown} error
 * @param {string[]} [forbiddenFragments]
 */
function assertProcessLockError(error, forbiddenFragments = []) {
  assert.equal(error?.name, 'AuditIntegrityProcessLockError');
  assert.equal(error?.code, LOCK_CODE);
  assert.equal(error?.message, LOCK_CODE);
  assert.equal(error?.code, ERROR_CODES.AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE);
  for (const fragment of forbiddenFragments) {
    if (!fragment) continue;
    assert.equal(String(error?.message).includes(fragment), false);
    assert.equal(String(error?.code).includes(fragment), false);
  }
  return true;
}

/**
 * @param {unknown} error
 */
function assertSafeDataFileError(error) {
  assert.ok(error instanceof SafeDataFileError, `expected SafeDataFileError, got ${error?.name}`);
  assert.equal(error.name, 'SafeDataFileError');
  assert.equal(error.code, SAFE_DATA_FILE_ERROR);
  assert.equal(error.message, SAFE_DATA_FILE_ERROR);
  return true;
}

/**
 * @param {string} prefix
 * @param {(root: string) => Promise<unknown>} fn
 */
async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-aiplq-${prefix}-`));
  try {
    return await fn(resolve(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const TASK_ENTRY_BOUND_MS = 5000;

/**
 * Bounded task-body entry barrier for concurrency tests.
 * Call signal() at the start of the task body; await wait(taskPromise).
 * Resolves on signal; rejects within boundMs with fixed diagnostic; rejects
 * immediately if taskPromise rejects before entry. Clears timeout on settle
 * so successful tests do not retain a 5s open handle. Never polls unboundedly.
 *
 * @param {string} diagnostic
 * @param {number} [boundMs]
 * @returns {{ signal: () => void, wait: (taskPromise?: Promise<unknown>) => Promise<void> }}
 */
function createTaskEntryBarrier(diagnostic, boundMs = TASK_ENTRY_BOUND_MS) {
  let signalResolve;
  const signaled = new Promise((resolve) => {
    signalResolve = resolve;
  });
  return {
    signal() {
      signalResolve();
    },
    /**
     * @param {Promise<unknown>} [taskPromise]
     */
    async wait(taskPromise) {
      let timer;
      let finished = false;
      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      try {
        await new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            if (finished) return;
            finished = true;
            reject(new Error(diagnostic));
          }, boundMs);

          signaled.then(() => {
            if (finished) return;
            finished = true;
            cleanup();
            resolve();
          });

          if (taskPromise) {
            Promise.resolve(taskPromise).then(
              () => {},
              (err) => {
                if (finished) return;
                finished = true;
                cleanup();
                reject(err);
              },
            );
          }
        });
      } finally {
        cleanup();
      }
    },
  };
}

/**
 * Canonical hostile lock attribute fixture: existing regular file mode 0644.
 * Production never repairs; tests may chmod/unlink during cleanup/recovery only.
 * @param {string} root
 */
async function plantHostileLockMode0644(root) {
  await mkdir(join(root, 'audit'), { recursive: true });
  const lockAbs = join(root, LOCK_REL);
  await writeFile(lockAbs, '', { mode: 0o644 });
  await chmod(lockAbs, 0o644);
  const st = await lstat(lockAbs);
  assert.equal(st.mode & 0o777, 0o644);
  return lockAbs;
}

/**
 * Test-only fixture repair (not production). Restores 0600 so next acquire can succeed.
 * @param {string} lockAbs
 */
async function repairLockMode0600(lockAbs) {
  await chmod(lockAbs, 0o600);
  const st = await lstat(lockAbs);
  assert.equal(st.mode & 0o777, 0o600);
}

/**
 * Capture the *binding* FileHandle close method used by fs/promises FileHandle.
 *
 * On current Node, `fs.promises.FileHandle#close` is an own property (not prototype),
 * so prototype wrap on the public handle does not intercept release. The internal
 * binding handle (Symbol kHandle) still has close on its prototype — wrapping that
 * is the permissible test-only hook: call original close first (no fd leak), then
 * observe/throw. Restore in finally. Keep such tests serial.
 *
 * @returns {Promise<{ proto: object, originalClose: Function }>}
 */
async function captureFileHandleClose() {
  const probeRoot = await mkdtemp(join(tmpdir(), 'linke-aiplq-fh-'));
  try {
    const probePath = join(probeRoot, 'probe');
    const fh = await open(probePath, constants.O_CREAT | constants.O_RDWR, 0o600);
    try {
      const symbols = Object.getOwnPropertySymbols(fh);
      const kHandle = symbols.find((s) => String(s).includes('kHandle'));
      assert.ok(kHandle, 'expected FileHandle kHandle symbol');
      const binding = fh[kHandle];
      assert.ok(binding, 'expected binding handle');
      const proto = Object.getPrototypeOf(binding);
      const originalClose = proto.close;
      assert.equal(typeof originalClose, 'function');
      return { proto, originalClose };
    } finally {
      await fh.close();
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

/**
 * Resolve the process-lock FileHandle fd via lsof (test-only observation).
 * @param {string} root
 * @returns {number}
 */
function findProcessLockFd(root) {
  const lockAbs = join(root, LOCK_REL);
  const out = execFileSync('lsof', ['-p', String(process.pid), '-F', 'nfd'], {
    encoding: 'utf8',
  });
  let curFd = null;
  let found = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('f') && line.length > 1 && line[1] >= '0' && line[1] <= '9') {
      curFd = Number(line.slice(1));
    } else if (line.startsWith('n') && line.includes(lockAbs)) {
      found = curFd;
    }
  }
  assert.equal(typeof found, 'number', `expected open fd for ${lockAbs}`);
  return /** @type {number} */ (found);
}

/**
 * Install a temporary binding-close wrapper scoped to one lock fd once known.
 * Optional beforeOriginal runs at release begin (before close) for matching fd.
 * Original close always runs next (no fd leak). Optional afterOriginal may throw.
 * `targetFdRef.current` may be set inside the task after acquire (null = ignore hooks).
 *
 * @param {{ proto: object, originalClose: Function }} captured
 * @param {{ current: number | null }} targetFdRef
 * @param {{
 *   beforeOriginal?: (ctx: { fd: unknown }) => unknown | Promise<unknown>,
 *   afterOriginal?: (ctx: { fd: unknown }) => unknown | Promise<unknown>,
 * }} [hooks]
 * @returns {() => void} restore
 */
function installCloseWrapper(captured, targetFdRef, hooks = {}) {
  const { proto, originalClose } = captured;
  const beforeOriginal = hooks.beforeOriginal;
  const afterOriginal = hooks.afterOriginal;
  proto.close = function wrappedClose(...args) {
    const ctx = { fd: this.fd };
    const run = async () => {
      const target = targetFdRef.current;
      const match = target !== null && Number(ctx.fd) === Number(target);
      if (match && typeof beforeOriginal === 'function') {
        await beforeOriginal(ctx);
      }
      const value = await Promise.resolve(originalClose.apply(this, args));
      if (match && typeof afterOriginal === 'function') {
        await afterOriginal(ctx);
      }
      return value;
    };
    return run();
  };
  return () => {
    proto.close = originalClose;
  };
}

async function loadQueue() {
  return import('../src/audit-integrity-write-queue.js');
}

describe('C2 source/import/export/sole-production-import contract', () => {
  it('queue exports only enqueue+assert; sole production importer of process-lock', async () => {
    const mod = await loadQueue();
    assert.deepEqual(
      Object.keys(mod).sort(),
      ['assertAuditIntegrityWriteLease', 'enqueueAuditIntegrityWriteTask'],
    );
    assert.equal(typeof mod.acquireAuditIntegrityProcessLock, 'undefined');
    assert.equal(typeof mod.releaseAuditIntegrityProcessLock, 'undefined');
    assert.equal(typeof mod.AuditIntegrityProcessLockError, 'undefined');

    const queueSource = await readFile(QUEUE_SRC, 'utf8');
    assert.match(queueSource, /from\s*['"]\.\/audit-integrity-process-lock\.js['"]/);
    assert.match(queueSource, /\bacquireAuditIntegrityProcessLock\b/);
    assert.match(queueSource, /\breleaseAuditIntegrityProcessLock\b/);
    assert.equal(/export\s+function\s+acquireAuditIntegrityProcessLock\b/.test(queueSource), false);
    assert.equal(/export\s+function\s+releaseAuditIntegrityProcessLock\b/.test(queueSource), false);
    assert.equal(/\bfrom\s+['"](?!node:|\.\/)/.test(queueSource), false);

    // Lifecycle order in run body: acquire → mint lease → expire lease → release.
    const runBodyStart = queueSource.indexOf('previous.catch');
    assert.ok(runBodyStart > 0);
    const runSlice = queueSource.slice(runBodyStart);
    const acqInRun = runSlice.indexOf('acquireAuditIntegrityProcessLock');
    const leaseSetInRun = runSlice.search(/activeAuditIntegrityWriteLeases\.set\s*\(/);
    const leaseDelInRun = runSlice.search(/activeAuditIntegrityWriteLeases\.delete\s*\(/);
    const relInRun = runSlice.lastIndexOf('releaseAuditIntegrityProcessLock');
    assert.ok(acqInRun >= 0, 'acquire in run body');
    assert.ok(leaseSetInRun > acqInRun, 'mint lease after acquire');
    assert.ok(leaseDelInRun > leaseSetInRun, 'expire lease after mint');
    assert.ok(relInRun > leaseDelInRun, 'release after expire');

    // Sole production importer of process-lock module (self module excluded).
    // Match only ESM import path of the module — not ERROR_CODES string values.
    const srcDir = join(REPO_ROOT, 'src');
    const entries = await readdir(srcDir);
    const productionImporters = [];
    for (const name of entries) {
      if (!name.endsWith('.js')) continue;
      if (name === 'audit-integrity-process-lock.js') continue;
      const text = await readFile(join(srcDir, name), 'utf8');
      if (/from\s*['"]\.\/audit-integrity-process-lock\.js['"]/.test(text)) {
        productionImporters.push(name);
      }
    }
    assert.deepEqual(productionImporters, ['audit-integrity-write-queue.js']);

    const lockSource = await readFile(LOCK_SRC, 'utf8');
    assert.match(lockSource, /export async function acquireAuditIntegrityProcessLock/);
    assert.match(lockSource, /export async function releaseAuditIntegrityProcessLock/);
  });
});

describe('C2 acquire failure (real hostile mode 0644)', () => {
  it('acquire rejects with fixed ProcessLockError; zero task; zero lease observation', async () => {
    await withTempRoot('acq-fail', async (root) => {
      const lockAbs = await plantHostileLockMode0644(root);
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      let taskCalls = 0;
      let observedLease;
      await assert.rejects(
        () => enqueueAuditIntegrityWriteTask(root, async (lease) => {
          taskCalls += 1;
          observedLease = lease;
          assertAuditIntegrityWriteLease(root, lease);
          return 'must-not-run';
        }),
        (error) => assertProcessLockError(error, [root, lockAbs, 'EACCES', 'chmod', '0644']),
      );
      assert.equal(taskCalls, 0);
      assert.equal(observedLease, undefined);
      // Hostile mode unrepaired by production.
      const st = await lstat(lockAbs);
      assert.equal(st.mode & 0o777, 0o644);
    });
  });
});

describe('C2 lock held during task; lease assertion ALS-only', () => {
  it('lock file exists mode 0600 during task; assertLease only inside ALS task', async () => {
    await withTempRoot('held', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      /** @type {object | undefined} */
      let sharedLease;
      let releaseHold;
      const holdGate = new Promise((r) => {
        releaseHold = r;
      });
      let entered = false;
      const entry = createTaskEntryBarrier(
        'task did not enter within 5000ms (lock held / ALS-only assert)',
      );
      const p = enqueueAuditIntegrityWriteTask(root, async (lease) => {
        sharedLease = lease;
        entered = true;
        entry.signal();
        const lockAbs = join(root, LOCK_REL);
        await access(lockAbs, constants.F_OK);
        const st = await lstat(lockAbs);
        assert.equal(st.isFile(), true);
        assert.equal(st.mode & 0o777, 0o600);
        assertAuditIntegrityWriteLease(root, lease);
        await holdGate;
        // Still valid inside ALS after outside probe.
        assertAuditIntegrityWriteLease(root, lease);
      });
      await entry.wait(p);
      assert.equal(entered, true);
      // Outside ALS.run context: fail-closed even while lease WeakMap-active.
      assert.throws(
        () => assertAuditIntegrityWriteLease(root, sharedLease),
        assertSafeDataFileError,
      );
      releaseHold();
      await p;
    });
  });
});

describe('C2 release order / release failure (binding FileHandle.close wrap; serial)', { concurrency: 1 }, () => {
  it('lease is expired before release(close) begins', async () => {
    await withTempRoot('lease-before-rel', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      const captured = await captureFileHandleClose();
      /** @type {{ current: number | null }} */
      const targetFdRef = { current: null };
      /** @type {object | undefined} */
      let capturedLease;
      let sawLeaseExpiredAtClose = false;
      let closeEntered = false;

      const restore = installCloseWrapper(captured, targetFdRef, {
        beforeOriginal: async () => {
          closeEntered = true;
          assert.ok(capturedLease, 'lease must have been minted before release');
          assert.throws(
            () => assertAuditIntegrityWriteLease(root, capturedLease),
            assertSafeDataFileError,
          );
          sawLeaseExpiredAtClose = true;
        },
      });

      try {
        await enqueueAuditIntegrityWriteTask(root, async (lease) => {
          capturedLease = lease;
          assertAuditIntegrityWriteLease(root, lease);
          targetFdRef.current = findProcessLockFd(root);
          return 'ok';
        });
        assert.equal(closeEntered, true);
        assert.equal(sawLeaseExpiredAtClose, true);
      } finally {
        restore();
      }
    });
  });

  it('release occurs after task settlement for success and failure', async () => {
    await withTempRoot('rel-after-settle', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      const captured = await captureFileHandleClose();
      /** @type {{ current: number | null }} */
      const targetFdRef = { current: null };
      const order = [];

      const restore = installCloseWrapper(captured, targetFdRef, {
        beforeOriginal: async () => {
          order.push('release');
        },
      });

      try {
        await enqueueAuditIntegrityWriteTask(root, async () => {
          order.push('task-success');
          targetFdRef.current = findProcessLockFd(root);
          return 1;
        });
        assert.deepEqual(order, ['task-success', 'release']);

        order.length = 0;
        targetFdRef.current = null;
        await assert.rejects(
          () => enqueueAuditIntegrityWriteTask(root, async () => {
            order.push('task-fail');
            targetFdRef.current = findProcessLockFd(root);
            throw new Error('task-visible-fail');
          }),
          (e) => e.message === 'task-visible-fail',
        );
        assert.deepEqual(order, ['task-fail', 'release']);
      } finally {
        restore();
      }
    });
  });

  it('simulated release failure rejects and wins after task success', async () => {
    await withTempRoot('rel-win-success', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      const captured = await captureFileHandleClose();
      /** @type {{ current: number | null }} */
      const targetFdRef = { current: null };
      let taskCompleted = false;

      const restore = installCloseWrapper(captured, targetFdRef, {
        afterOriginal: async () => {
          throw new Error('simulated-close-fail-after-success');
        },
      });

      try {
        await assert.rejects(
          () => enqueueAuditIntegrityWriteTask(root, async () => {
            targetFdRef.current = findProcessLockFd(root);
            taskCompleted = true;
            return 'task-ok';
          }),
          (error) => assertProcessLockError(error, [
            root,
            'simulated-close-fail-after-success',
            'task-ok',
          ]),
        );
        assert.equal(taskCompleted, true, 'task body may complete before release failure wins');
      } finally {
        restore();
      }
    });
  });

  it('simulated release failure also wins over a distinct task failure', async () => {
    await withTempRoot('rel-win-task-fail', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      const captured = await captureFileHandleClose();
      /** @type {{ current: number | null }} */
      const targetFdRef = { current: null };
      let taskThrew = false;

      const restore = installCloseWrapper(captured, targetFdRef, {
        afterOriginal: async () => {
          throw new Error('simulated-close-fail-over-task');
        },
      });

      try {
        await assert.rejects(
          () => enqueueAuditIntegrityWriteTask(root, async () => {
            targetFdRef.current = findProcessLockFd(root);
            taskThrew = true;
            throw new Error('distinct-task-failure');
          }),
          (error) => {
            assertProcessLockError(error, [
              root,
              'distinct-task-failure',
              'simulated-close-fail-over-task',
            ]);
            assert.notEqual(error?.message, 'distinct-task-failure');
            return true;
          },
        );
        assert.equal(taskThrew, true);
      } finally {
        restore();
      }
    });
  });
});

describe('C2 queue recovery after acquire/release rejection (fixture repair only)', () => {
  it('recovers after acquire rejection once fixture mode is repaired', async () => {
    await withTempRoot('rec-acq', async (root) => {
      const lockAbs = await plantHostileLockMode0644(root);
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      let calls = 0;
      await assert.rejects(
        () => enqueueAuditIntegrityWriteTask(root, async () => {
          calls += 1;
          return 'nope';
        }),
        (error) => assertProcessLockError(error, [root, lockAbs]),
      );
      assert.equal(calls, 0);

      // Test fixture repair only — production never chmod/unlinks.
      await repairLockMode0600(lockAbs);

      const v = await enqueueAuditIntegrityWriteTask(root, async (lease) => {
        calls += 1;
        assertAuditIntegrityWriteLease(root, lease);
        return 'recovered-after-acquire';
      });
      assert.equal(v, 'recovered-after-acquire');
      assert.equal(calls, 1);
    });
  });

  it('recovers after release rejection (close already ran; next task acquires)', async () => {
    await withTempRoot('rec-rel', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      const captured = await captureFileHandleClose();
      /** @type {{ current: number | null }} */
      const targetFdRef = { current: null };
      let failCloseOnce = true;

      const restore = installCloseWrapper(captured, targetFdRef, {
        afterOriginal: async () => {
          if (failCloseOnce) {
            failCloseOnce = false;
            throw new Error('simulated-close-fail-once');
          }
        },
      });

      try {
        await assert.rejects(
          () => enqueueAuditIntegrityWriteTask(root, async () => {
            targetFdRef.current = findProcessLockFd(root);
            return 'done';
          }),
          (error) => assertProcessLockError(error, [root, 'simulated-close-fail-once']),
        );

        targetFdRef.current = null;
        const v = await enqueueAuditIntegrityWriteTask(root, async (lease) => {
          assertAuditIntegrityWriteLease(root, lease);
          return 'recovered-after-release';
        });
        assert.equal(v, 'recovered-after-release');
      } finally {
        restore();
      }
    });
  });
});

describe('C2 FIFO / nested / poison regressions remain green', () => {
  it('same-root FIFO no overlap; different-root may interleave', async () => {
    await withTempRoot('fifo-a', async (rootA) => {
      await withTempRoot('fifo-b', async (rootB) => {
        const { enqueueAuditIntegrityWriteTask } = await loadQueue();
        const order = [];
        let releaseA;
        const gateA = new Promise((r) => {
          releaseA = r;
        });
        let aEntered = false;
        let bEnteredWhileA = false;

        const aEntry = createTaskEntryBarrier(
          'A task did not enter within 5000ms (cross-root FIFO interleave)',
        );
        const pA = enqueueAuditIntegrityWriteTask(rootA, async () => {
          aEntered = true;
          aEntry.signal();
          order.push('a-start');
          await gateA;
          order.push('a-end');
          return 'A';
        });
        await aEntry.wait(pA);
        assert.equal(aEntered, true);

        const pB = enqueueAuditIntegrityWriteTask(rootB, async () => {
          if (aEntered) bEnteredWhileA = true;
          order.push('b');
          return 'B';
        });
        assert.equal(await pB, 'B');
        assert.equal(bEnteredWhileA, true);

        // Same-root successor waits for A.
        const orderSame = [];
        let releaseHold;
        const holdGate = new Promise((r) => {
          releaseHold = r;
        });
        let holdEntered = false;
        const holdEntry = createTaskEntryBarrier(
          'hold task did not enter within 5000ms (same-root FIFO)',
        );
        const hold = enqueueAuditIntegrityWriteTask(rootA, async () => {
          holdEntered = true;
          holdEntry.signal();
          orderSame.push('hold-start');
          await holdGate;
          orderSame.push('hold-end');
        });
        // Hold waits for A (same-root FIFO). Release A so hold can enter.
        releaseA();
        await pA;
        await holdEntry.wait(hold);
        assert.equal(holdEntered, true);
        const next = enqueueAuditIntegrityWriteTask(rootA, async () => {
          orderSame.push('next');
          return 'next';
        });
        releaseHold();
        await hold;
        assert.equal(await next, 'next');
        assert.deepEqual(orderSame, ['hold-start', 'hold-end', 'next']);
      });
    });
  });

  it('nested same-root and cross-root fail-closed; poison isolation recovers', async () => {
    await withTempRoot('nest-a', async (rootA) => {
      await withTempRoot('nest-b', async (rootB) => {
        const { enqueueAuditIntegrityWriteTask } = await loadQueue();
        const outer = await enqueueAuditIntegrityWriteTask(rootA, async () => {
          assert.throws(
            () => enqueueAuditIntegrityWriteTask(rootA, async () => 'inner'),
            assertSafeDataFileError,
          );
          assert.throws(
            () => enqueueAuditIntegrityWriteTask(rootB, async () => 'cross'),
            assertSafeDataFileError,
          );
          return 'outer-ok';
        });
        assert.equal(outer, 'outer-ok');

        await assert.rejects(
          () => enqueueAuditIntegrityWriteTask(rootA, async () => {
            throw new Error('poison-boom');
          }),
          (e) => e.message === 'poison-boom',
        );
        assert.equal(
          await enqueueAuditIntegrityWriteTask(rootA, async () => 'after-poison'),
          'after-poison',
        );
      });
    });
  });
});
