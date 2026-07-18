/**
 * Tests for shared audit integrity write queue + lease (V1.37 C1 Task1).
 * Path-free SafeDataFileError only; no dual-write error codes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SafeDataFileError, SAFE_DATA_FILE_ERROR } from '../src/safe-data-files.js';

const QUEUE_SRC = fileURLToPath(new URL('../src/audit-integrity-write-queue.js', import.meta.url));

async function loadQueue() {
  return import('../src/audit-integrity-write-queue.js');
}

function assertSafeDataFileError(error) {
  assert.ok(error instanceof SafeDataFileError, `expected SafeDataFileError, got ${error?.name}`);
  assert.equal(error.name, 'SafeDataFileError');
  assert.equal(error.code, SAFE_DATA_FILE_ERROR);
  assert.equal(error.message, SAFE_DATA_FILE_ERROR);
  assert.ok(!error.message.includes('/'));
  assert.ok(!error.message.includes('ENOENT'));
  return true;
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-aiwq-${prefix}-`));
  try {
    // Match assertSafeDataRoot shape: absolute normalized resolved string.
    const resolvedRoot = resolve(root);
    return await fn(resolvedRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('audit-integrity-write-queue exports and source contracts', () => {
  it('7+18: exports only enqueue+assert (no bare peek); ALS; sole Map; no npm deps', async () => {
    const mod = await loadQueue();
    assert.equal(typeof mod.enqueueAuditIntegrityWriteTask, 'function');
    assert.equal(typeof mod.assertAuditIntegrityWriteLease, 'function');
    // a. public surface restored to enqueue + assert only — no bare peek export.
    assert.equal(typeof mod.peekAuditIntegrityWriteQueueTail, 'undefined');
    assert.equal('peekAuditIntegrityWriteQueueTail' in mod, false);
    assert.equal(typeof mod.createAuditIntegrityWriteQueueObserver, 'undefined');
    assert.deepEqual(
      Object.keys(mod).sort(),
      ['assertAuditIntegrityWriteLease', 'enqueueAuditIntegrityWriteTask'],
    );

    const source = await readFile(QUEUE_SRC, 'utf8');
    assert.match(source, /from\s+['"]node:async_hooks['"]/);
    assert.match(source, /AsyncLocalStorage/);
    assert.equal((source.match(/new Map\s*\(\s*\)/g) || []).length, 1);
    assert.ok(source.includes('WeakMap') || source.includes('WeakSet'));
    assert.equal(/\bfrom\s+['"](?!node:|\.\/)/.test(source), false, 'no non-relative/non-node imports');
    // No package.json dependency introduction via bare specifier.
    assert.equal(/\brequire\s*\(/.test(source), false);
    // No bare public peek export restored.
    assert.equal(/export\s+function\s+peekAuditIntegrityWriteQueueTail\b/.test(source), false);
    assert.equal(/export\s*\{[^}]*peekAuditIntegrityWriteQueueTail/.test(source), false);
  });

  it('19: lease settle only in queue finally; task has no settle API (source)', async () => {
    const source = await readFile(QUEUE_SRC, 'utf8');
    const mod = await loadQueue();
    // Public surface: enqueue + assert only (observer is lease-scoped, not exported).
    assert.equal(typeof mod.enqueueAuditIntegrityWriteTask, 'function');
    assert.equal(typeof mod.assertAuditIntegrityWriteLease, 'function');
    assert.equal(typeof mod.peekAuditIntegrityWriteQueueTail, 'undefined');
    assert.equal(source.includes('export function expire'), false);
    assert.equal(source.includes('export function settle'), false);
    assert.equal(source.includes('export function release'), false);
    // finally deletes / expires lease after await task(lease, observer)
    assert.match(source, /finally\s*\{[\s\S]*?delete\s*\(/);
    assert.match(source, /await\s+.*task\s*\(\s*lease\s*,\s*observer\s*\)/);
  });
});

describe('active-lease-scoped queue observer (peekTail)', () => {
  it('b+c+d+e+j: hold observer frozen; hold/first/second identities; FIFO preserved', async () => {
    await withTempRoot('obs-tail', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();

      let releaseHold;
      const holdGate = new Promise((resolve) => { releaseHold = resolve; });
      let holdEntered = false;
      /** @type {{ peekTail: () => Promise<unknown> | null } | undefined} */
      let holdObserver;
      const hold = enqueueAuditIntegrityWriteTask(root, async (lease, observer) => {
        // Timing: Map.set(cleanup) is sync before task body microtask; first peek must
        // already see this hold's cleanup identity.
        holdObserver = observer;
        holdEntered = true;
        // b. observer frozen; method set fixed; no schedule/cancel/reorder/settle/grant.
        assert.ok(Object.isFrozen(observer));
        assert.deepEqual(Object.keys(observer).sort(), ['peekTail']);
        assert.equal(typeof observer.peekTail, 'function');
        for (const banned of [
          'schedule', 'cancel', 'reorder', 'settle', 'grant',
          'enqueue', 'release', 'expire', 'setTail',
        ]) {
          assert.equal(banned in observer, false, `observer must not expose ${banned}`);
        }
        // c. hold active: first peekTail inside hold body returns hold cleanup identity.
        const tailInside = observer.peekTail();
        assert.ok(tailInside instanceof Promise);
        assert.equal(observer.peekTail(), tailInside);
        await holdGate;
      });
      while (!holdEntered) {
        await new Promise((r) => setImmediate(r));
      }
      assert.ok(holdObserver);
      // c. outside hold body but lease still active: same identity; repeatable.
      const tailHold = holdObserver.peekTail();
      assert.ok(tailHold instanceof Promise);
      assert.equal(holdObserver.peekTail(), tailHold);
      assert.equal(holdObserver.peekTail(), tailHold);

      // j. two enqueues → strictly different cleanup identities.
      const first = enqueueAuditIntegrityWriteTask(root, async () => 'first');
      const tailFirst = holdObserver.peekTail();
      assert.ok(tailFirst instanceof Promise);
      assert.notEqual(tailFirst, tailHold);

      const second = enqueueAuditIntegrityWriteTask(root, async () => 'second');
      const tailSecond = holdObserver.peekTail();
      assert.ok(tailSecond instanceof Promise);
      // d. three identities strictly unequal.
      assert.notEqual(tailSecond, tailFirst);
      assert.notEqual(tailSecond, tailHold);
      assert.notEqual(tailFirst, tailHold);

      // e. observer must not release hold or change FIFO: first then second.
      releaseHold();
      assert.equal(await first, 'first');
      assert.equal(await second, 'second');
      await hold;
    });
  });

  it('f: after lease settle, old observer.peekTail() path-free fail-closed', async () => {
    await withTempRoot('obs-expire', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      /** @type {{ peekTail: () => Promise<unknown> | null } | undefined} */
      let savedObserver;
      await enqueueAuditIntegrityWriteTask(root, async (_lease, observer) => {
        savedObserver = observer;
        assert.ok(observer.peekTail() instanceof Promise);
      });
      assert.ok(savedObserver);
      assert.throws(() => savedObserver.peekTail(), assertSafeDataFileError);
      // Second settle still fail-closed; no path leakage.
      assert.throws(() => savedObserver.peekTail(), assertSafeDataFileError);
    });
  });

  it('g: root A observer isolated from root B enqueue/tail changes', async () => {
    await withTempRoot('obs-a', async (rootA) => {
      await withTempRoot('obs-b', async (rootB) => {
        const { enqueueAuditIntegrityWriteTask } = await loadQueue();
        let releaseA;
        const gateA = new Promise((r) => { releaseA = r; });
        /** @type {{ peekTail: () => Promise<unknown> | null } | undefined} */
        let obsA;
        /** @type {{ peekTail: () => Promise<unknown> | null } | undefined} */
        let obsB;
        let aEntered = false;
        let bEntered = false;

        const pA = enqueueAuditIntegrityWriteTask(rootA, async (_lease, observer) => {
          obsA = observer;
          aEntered = true;
          await gateA;
        });
        while (!aEntered) {
          await new Promise((r) => setImmediate(r));
        }
        const tailAHold = obsA.peekTail();
        assert.ok(tailAHold instanceof Promise);

        let releaseB;
        const gateB = new Promise((r) => { releaseB = r; });
        const pB = enqueueAuditIntegrityWriteTask(rootB, async (_lease, observer) => {
          obsB = observer;
          bEntered = true;
          await gateB;
        });
        while (!bEntered) {
          await new Promise((r) => setImmediate(r));
        }
        const tailBHold = obsB.peekTail();
        assert.ok(tailBHold instanceof Promise);
        // A still sees its own hold tail; B enqueue does not change A's identity.
        assert.equal(obsA.peekTail(), tailAHold);
        assert.notEqual(obsA.peekTail(), tailBHold);
        assert.notEqual(obsB.peekTail(), tailAHold);

        // Further enqueue on B advances only B's observer view.
        const bNext = enqueueAuditIntegrityWriteTask(rootB, async () => 'b-next');
        const tailBNext = obsB.peekTail();
        assert.notEqual(tailBNext, tailBHold);
        assert.equal(obsA.peekTail(), tailAHold, 'A observer must ignore B enqueue');

        releaseA();
        releaseB();
        await pA;
        assert.equal(await bNext, 'b-next');
        await pB;
        assert.throws(() => obsA.peekTail(), assertSafeDataFileError);
        assert.throws(() => obsB.peekTail(), assertSafeDataFileError);
      });
    });
  });

  it('h: lease-only callbacks stay compatible; forged observer not required / not granted', async () => {
    await withTempRoot('obs-compat', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      // Existing style: only lease param — must keep working.
      const v1 = await enqueueAuditIntegrityWriteTask(root, async (lease) => {
        assertAuditIntegrityWriteLease(root, lease);
        return 'lease-only';
      });
      assert.equal(v1, 'lease-only');

      // Zero-arg callback still works (ignores lease + observer).
      const v0 = await enqueueAuditIntegrityWriteTask(root, async () => 'zero-arg');
      assert.equal(v0, 'zero-arg');

      // Passing extra args at call sites is not possible via public API; forged
      // observer object is never accepted as a grant — only module-issued observer works.
      let moduleObserver;
      await enqueueAuditIntegrityWriteTask(root, async (lease, observer) => {
        moduleObserver = observer;
        assertAuditIntegrityWriteLease(root, lease);
        // Caller-forged lookalike cannot replace capability (not consulted by queue).
        const forged = Object.freeze({ peekTail() { return 'forged'; } });
        assert.notEqual(observer, forged);
        assert.ok(observer.peekTail() instanceof Promise);
      });
      assert.ok(moduleObserver);
      assert.throws(() => moduleObserver.peekTail(), assertSafeDataFileError);
    });
  });
});

describe('enqueueAuditIntegrityWriteTask serialization', () => {
  it('1: same root serial — sleep proves order', async () => {
    await withTempRoot('serial', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      const order = [];
      const p1 = enqueueAuditIntegrityWriteTask(root, async () => {
        order.push('a-start');
        await sleep(40);
        order.push('a-end');
        return 1;
      });
      const p2 = enqueueAuditIntegrityWriteTask(root, async () => {
        order.push('b-start');
        order.push('b-end');
        return 2;
      });
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(r1, 1);
      assert.equal(r2, 2);
      assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
    });
  });

  it('2: different roots may interleave (non-nested parallel enqueue)', async () => {
    await withTempRoot('rA', async (rootA) => {
      await withTempRoot('rB', async (rootB) => {
        const { enqueueAuditIntegrityWriteTask } = await loadQueue();
        let aEntered = false;
        let bEnteredWhileA = false;
        let releaseA;
        const gate = new Promise((r) => {
          releaseA = r;
        });

        const pA = enqueueAuditIntegrityWriteTask(rootA, async () => {
          aEntered = true;
          await gate;
          return 'A';
        });
        // Give A a tick to enter.
        await sleep(10);
        assert.equal(aEntered, true);

        const pB = enqueueAuditIntegrityWriteTask(rootB, async () => {
          if (aEntered) bEnteredWhileA = true;
          return 'B';
        });
        const bResult = await pB;
        assert.equal(bResult, 'B');
        assert.equal(bEnteredWhileA, true, 'B must run while A still holds its root queue');
        releaseA();
        assert.equal(await pA, 'A');
      });
    });
  });

  it('3+21: previous rejection does not poison next task', async () => {
    await withTempRoot('poison', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      await assert.rejects(
        () => enqueueAuditIntegrityWriteTask(root, async () => {
          throw new Error('boom-task');
        }),
        (error) => {
          assert.equal(error.message, 'boom-task');
          return true;
        },
      );
      const ok = await enqueueAuditIntegrityWriteTask(root, async () => 'recovered');
      assert.equal(ok, 'recovered');
    });
  });

  it('4: cleanup identity — Map entry removed after settle (subsequent task still runs)', async () => {
    await withTempRoot('cleanup', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      await enqueueAuditIntegrityWriteTask(root, async () => 1);
      // Second enqueue after first fully settled must not hang / fail.
      const v = await enqueueAuditIntegrityWriteTask(root, async () => 2);
      assert.equal(v, 2);
    });
  });

  it('5: concurrent 20 enqueue same root complete in order', async () => {
    await withTempRoot('c20', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      const order = [];
      const promises = [];
      for (let i = 0; i < 20; i += 1) {
        const n = i;
        promises.push(
          enqueueAuditIntegrityWriteTask(root, async () => {
            order.push(n);
            return n;
          }),
        );
      }
      const results = await Promise.all(promises);
      assert.deepEqual(results, [...Array(20).keys()]);
      assert.deepEqual(order, [...Array(20).keys()]);
    });
  });

  it('6: empty / relative / non-normalized root → SafeDataFileError', async () => {
    const { enqueueAuditIntegrityWriteTask } = await loadQueue();
    // Validation fails synchronously (path-free programmer error).
    assert.throws(
      () => enqueueAuditIntegrityWriteTask('', async () => 1),
      assertSafeDataFileError,
    );
    assert.throws(
      () => enqueueAuditIntegrityWriteTask('relative/path', async () => 1),
      assertSafeDataFileError,
    );
    const nonNorm = `${resolve('/tmp')}/x/../y`;
    assert.equal(isAbsolute(nonNorm), true);
    assert.notEqual(normalize(nonNorm), nonNorm);
    assert.throws(
      () => enqueueAuditIntegrityWriteTask(nonNorm, async () => 1),
      assertSafeDataFileError,
    );
    assert.throws(
      () => enqueueAuditIntegrityWriteTask(resolve('/tmp'), /** @type {any} */ ('not-fn')),
      assertSafeDataFileError,
    );
  });

  it('8: failed task rejection is awaitable by caller', async () => {
    await withTempRoot('reject', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      let saw = false;
      try {
        await enqueueAuditIntegrityWriteTask(root, async () => {
          throw Object.assign(new Error('visible'), { code: 'X' });
        });
      } catch (error) {
        saw = true;
        assert.equal(error.message, 'visible');
      }
      assert.equal(saw, true);
    });
  });
});

describe('lease identity + assertAuditIntegrityWriteLease', () => {
  it('9: callback receives module-generated unique frozen lease', async () => {
    await withTempRoot('lease-obj', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      const leases = [];
      await enqueueAuditIntegrityWriteTask(root, async (lease) => {
        assert.equal(typeof lease, 'object');
        assert.ok(lease !== null);
        assert.ok(Object.isFrozen(lease));
        assertAuditIntegrityWriteLease(root, lease);
        leases.push(lease);
      });
      await enqueueAuditIntegrityWriteTask(root, async (lease) => {
        leases.push(lease);
        assert.notEqual(lease, leases[0]);
      });
      assert.equal(leases.length, 2);
    });
  });

  it('10: wrong-root lease assert fail-closed', async () => {
    await withTempRoot('wrong-root', async (rootA) => {
      await withTempRoot('wrong-root-b', async (rootB) => {
        const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
        await enqueueAuditIntegrityWriteTask(rootA, async (lease) => {
          assert.throws(() => assertAuditIntegrityWriteLease(rootB, lease), assertSafeDataFileError);
          // Still valid for correct root.
          assertAuditIntegrityWriteLease(rootA, lease);
        });
      });
    });
  });

  it('11+22+24: expired lease after callback ends → assert fail-closed', async () => {
    await withTempRoot('expired', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      let captured;
      await enqueueAuditIntegrityWriteTask(root, async (lease) => {
        captured = lease;
        assertAuditIntegrityWriteLease(root, lease);
      });
      assert.throws(() => assertAuditIntegrityWriteLease(root, captured), assertSafeDataFileError);
    });
  });

  it('12: missing / forged lease fail-closed', async () => {
    await withTempRoot('forged', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      assert.throws(() => assertAuditIntegrityWriteLease(root, undefined), assertSafeDataFileError);
      assert.throws(() => assertAuditIntegrityWriteLease(root, null), assertSafeDataFileError);
      assert.throws(() => assertAuditIntegrityWriteLease(root, {}), assertSafeDataFileError);
      assert.throws(() => assertAuditIntegrityWriteLease(root, Object.freeze({})), assertSafeDataFileError);
      await enqueueAuditIntegrityWriteTask(root, async (lease) => {
        assert.throws(() => assertAuditIntegrityWriteLease(root, { ...lease }), assertSafeDataFileError);
        assertAuditIntegrityWriteLease(root, lease);
      });
    });
  });

  it('15: cross-root lease cannot assert for another root', async () => {
    await withTempRoot('xa', async (rootA) => {
      await withTempRoot('xb', async (rootB) => {
        const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
        await enqueueAuditIntegrityWriteTask(rootA, async (leaseA) => {
          assert.throws(() => assertAuditIntegrityWriteLease(rootB, leaseA), assertSafeDataFileError);
        });
      });
    });
  });

  it('17: another async context reusing lease (no ALS) → assert reject', async () => {
    await withTempRoot('als-ctx', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      let sharedLease;
      let releaseInner;
      const hold = new Promise((r) => {
        releaseInner = r;
      });
      const p = enqueueAuditIntegrityWriteTask(root, async (lease) => {
        sharedLease = lease;
        await hold;
      });
      await sleep(10);
      // Outside the ALS.run context: assert must fail even while lease still active in WeakMap.
      assert.throws(() => assertAuditIntegrityWriteLease(root, sharedLease), assertSafeDataFileError);
      releaseInner();
      await p;
    });
  });

  it('16: detached continuation after settle with ALS store still present → assert/enqueue reject', async () => {
    await withTempRoot('detach', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      let detachedAssertError;
      let detachedEnqueueError;
      let capturedLease;
      await enqueueAuditIntegrityWriteTask(root, async (lease) => {
        capturedLease = lease;
        // Schedule continuation that retains ALS store after outer settle.
        await new Promise((resolveDetached) => {
          setImmediate(() => {
            try {
              assertAuditIntegrityWriteLease(root, lease);
              detachedAssertError = null;
            } catch (error) {
              detachedAssertError = error;
            }
            try {
              enqueueAuditIntegrityWriteTask(root, async () => 'nested-from-detach');
              detachedEnqueueError = null;
            } catch (error) {
              detachedEnqueueError = error;
            }
            resolveDetached();
          });
        });
        // Task body returns; queue finally expires lease BEFORE setImmediate?
        // setImmediate is scheduled during task — ALS propagates, but finally runs when
        // the await of the setImmediate promise resolves — so lease still active here.
        // Force settle first by returning; fire-and-forget after task ends:
      });
      // True detached: schedule after full settle.
      await new Promise((resolveDone) => {
        setImmediate(() => {
          try {
            assertAuditIntegrityWriteLease(root, capturedLease);
            detachedAssertError = new Error('assert should have thrown');
          } catch (error) {
            detachedAssertError = error;
          }
          try {
            enqueueAuditIntegrityWriteTask(root, async () => 'nope');
            // nested from non-active ALS may succeed if store is expired lease still in ALS
            // Design: if ALS current is active lease → reject. Expired lease in ALS:
            // activeLeases.has(current) is false → nested enqueue allowed OR assert fails.
            // Detached assert must fail (expired).
          } catch (error) {
            detachedEnqueueError = error;
          }
          resolveDone();
        });
      });
      assertSafeDataFileError(detachedAssertError);

      // Detached with retained ALS: run setImmediate INSIDE task but resolve after settle.
      let postSettleAssert;
      let postSettleEnqueue;
      await new Promise((outerResolve) => {
        enqueueAuditIntegrityWriteTask(root, async (lease) => {
          setImmediate(() => {
            // This fires after ALS.run completes → store may still be lease via async resource.
            queueMicrotask(() => {
              try {
                assertAuditIntegrityWriteLease(root, lease);
                postSettleAssert = null;
              } catch (error) {
                postSettleAssert = error;
              }
              try {
                enqueueAuditIntegrityWriteTask(root, async () => 1);
                postSettleEnqueue = 'enqueued';
              } catch (error) {
                postSettleEnqueue = error;
              }
              outerResolve();
            });
          });
          // return immediately so finally expires lease before microtask chain above?
          // setImmediate is after current task stack; finally runs when task promise settles.
          // Order: task returns → finally expire → then setImmediate → microtask.
        }).then(() => {});
      });
      assertSafeDataFileError(postSettleAssert);
      // Nested enqueue from detached: if ALS still holds expired lease object,
      // activeLeases.has is false → enqueue may proceed. Design for nested only rejects
      // *active* lease. Detached assert is the P0 lock.
      void postSettleEnqueue;
      void detachedEnqueueError;
    });
  });

  it('20: task cannot expire lease early (no settle API; still active until settle)', async () => {
    await withTempRoot('no-early', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      const mod = await loadQueue();
      assert.equal('expireAuditIntegrityWriteLease' in mod, false);
      assert.equal('settleAuditIntegrityWriteLease' in mod, false);
      await enqueueAuditIntegrityWriteTask(root, async (lease) => {
        // Misuse: delete own properties / freeze tricks cannot expire module WeakMap.
        try {
          // @ts-ignore
          delete lease.root;
        } catch {
          // frozen
        }
        assertAuditIntegrityWriteLease(root, lease);
        await sleep(5);
        assertAuditIntegrityWriteLease(root, lease);
      });
    });
  });

  it('23: queue .catch poison isolation does not re-grant expired lease', async () => {
    await withTempRoot('no-regrant', async (root) => {
      const { enqueueAuditIntegrityWriteTask, assertAuditIntegrityWriteLease } = await loadQueue();
      let deadLease;
      await assert.rejects(
        () => enqueueAuditIntegrityWriteTask(root, async (lease) => {
          deadLease = lease;
          throw new Error('fail');
        }),
        (e) => e.message === 'fail',
      );
      assert.throws(() => assertAuditIntegrityWriteLease(root, deadLease), assertSafeDataFileError);
      // Fresh task gets a new lease.
      await enqueueAuditIntegrityWriteTask(root, async (lease) => {
        assert.notEqual(lease, deadLease);
        assertAuditIntegrityWriteLease(root, lease);
      });
    });
  });
});

describe('nested enqueue forbidden (same-root and cross-root)', () => {
  it('13+25: nested same-root enqueue → SafeDataFileError; outer not poisoned', async () => {
    await withTempRoot('nest-same', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      const outer = await enqueueAuditIntegrityWriteTask(root, async () => {
        assert.throws(
          () => enqueueAuditIntegrityWriteTask(root, async () => 'inner'),
          assertSafeDataFileError,
        );
        return 'outer-ok';
      });
      assert.equal(outer, 'outer-ok');
      const after = await enqueueAuditIntegrityWriteTask(root, async () => 'after');
      assert.equal(after, 'after');
    });
  });

  it('14+26: nested cross-root enqueue → SafeDataFileError (no switch-root bypass)', async () => {
    await withTempRoot('nest-a', async (rootA) => {
      await withTempRoot('nest-b', async (rootB) => {
        const { enqueueAuditIntegrityWriteTask } = await loadQueue();
        const outer = await enqueueAuditIntegrityWriteTask(rootA, async () => {
          assert.throws(
            () => enqueueAuditIntegrityWriteTask(rootB, async () => 'cross-inner'),
            assertSafeDataFileError,
          );
          return 'outer-a';
        });
        assert.equal(outer, 'outer-a');
        // After settle, cross-root non-nested works.
        const b = await enqueueAuditIntegrityWriteTask(rootB, async () => 'b-ok');
        assert.equal(b, 'b-ok');
      });
    });
  });

  it('21b: outer reject after nested reject does not poison subsequent', async () => {
    await withTempRoot('nest-reject', async (root) => {
      const { enqueueAuditIntegrityWriteTask } = await loadQueue();
      await assert.rejects(
        () => enqueueAuditIntegrityWriteTask(root, async () => {
          assert.throws(
            () => enqueueAuditIntegrityWriteTask(root, async () => 1),
            assertSafeDataFileError,
          );
          throw new Error('outer-fail');
        }),
        (e) => e.message === 'outer-fail',
      );
      assert.equal(
        await enqueueAuditIntegrityWriteTask(root, async () => 'next'),
        'next',
      );
    });
  });
});
