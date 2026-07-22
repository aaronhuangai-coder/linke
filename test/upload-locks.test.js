/**
 * C5 RED — Upload locks / backpressure (no public routes).
 * Targets public API of src/upload-locks.js (not yet implemented).
 * Authority: design §4.3 / §10 + plan C5.
 *
 * Frozen public surface (minimal, C6-reusable):
 *   createUploadLocks({ maxGlobalTransfers = 4 }) → frozen object:
 *     - maxGlobalTransfers: number (readonly snapshot of effective cap)
 *     - runTransfer(task): Promise  — global active-transfer semaphore
 *         * acquires slot immediately; full → unique LinkeError
 *           upload-backpressure (429, retryable=true); NEVER queues
 *         * task sync throw / async reject / success all release in finally
 *     - runDevice(deviceId, task): Promise — per-device keyed FIFO queue
 *     - runSession(deviceId, uploadId, task): Promise — per-session FIFO
 *     - runSnapshot(deviceId, snapshotId, task): Promise — per-snapshot FIFO
 *   Keyed runners: same key serial, different keys concurrent; prior reject
 *   never stalls queue; empty tail deletes Map entry; MUST NOT queue behind
 *   global transfer full (global is separate and fail-fast).
 *   MUST NOT expose mutable internal Map / counter fields.
 *
 * Config: effective maxGlobalTransfers only 1..16 (default 4). Outside that
 * range OR non-integer / non-number / hostile → constructor fail-closed with
 * fixed sanitized Error (NOT runtime upload-backpressure 429). No silent clamp.
 *
 * Expected RED: ERR_MODULE_NOT_FOUND for upload-locks.js until GREEN.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { createUploadLocks } from '../src/upload-locks.js';

/** Fixed constructor fail-closed message (must not echo invalid values). */
const INVALID_MAX_GLOBAL = 'invalid maxGlobalTransfers';

/**
 * @param {unknown} error
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
function assertLinkeCode(error, code, opts = {}) {
  assert.ok(error instanceof LinkeError, 'must be LinkeError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  if (opts.statusCode !== undefined) assert.equal(error.statusCode, opts.statusCode);
  if (opts.retryable !== undefined) assert.equal(error.retryable, opts.retryable);
  const ownText = [
    error.code,
    error.message,
    error.name,
    String(error.statusCode),
    String(error.retryable),
    error.details ? JSON.stringify(error.details) : '',
  ].join('\0');
  for (const token of opts.leakTokens ?? []) {
    if (!token || token.length < 2) continue;
    assert.ok(!ownText.includes(token), `must not leak ${token}`);
  }
}

function deferred() {
  /** @type {(v?: unknown) => void} */
  let resolve = () => {};
  /** @type {(e?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Yield a bounded number of microtasks so concurrent schedulers can progress.
 * No wall-clock sleep / setTimeout / probability loops.
 * @param {number} [n=8]
 */
async function yieldTurns(n = 8) {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Wait until predicate via microtask barrier only.
 * @param {() => boolean} predicate
 * @param {string} label
 */
async function waitUntil(predicate, label) {
  for (let i = 0; i < 20_000; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(`barrier timeout: ${label}`);
}

/**
 * Assert constructor fail-closed: fixed sanitized message, never 429 backpressure,
 * never echoes hostile tokens, never silent-clamps to a working locks object.
 * @param {() => unknown} fn
 * @param {string[]} leakTokens
 */
function assertConfigFailClosed(fn, leakTokens = []) {
  let threw = false;
  /** @type {unknown} */
  let err;
  try {
    fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  assert.ok(threw, 'constructor must fail-closed (no silent clamp)');
  assert.ok(err instanceof Error, 'must throw Error');
  // Config validity is NOT expressed via runtime transfer backpressure.
  if (err instanceof LinkeError) {
    assert.notEqual(err.code, ERROR_CODES.UPLOAD_BACKPRESSURE);
    assert.notEqual(err.statusCode, 429);
  }
  assert.equal(
    /** @type {Error} */ (err).message,
    INVALID_MAX_GLOBAL,
    'fixed desensitized constructor message only',
  );
  const text = [
    /** @type {Error} */ (err).message,
    /** @type {Error} */ (err).name,
    /** @type {{ code?: unknown }} */ (err).code != null
      ? String(/** @type {{ code?: unknown }} */ (err).code)
      : '',
  ].join('\0');
  for (const token of leakTokens) {
    if (!token || token.length < 2) continue;
    assert.ok(!text.includes(token), `constructor error must not echo ${token}`);
  }
}

/**
 * Assert object does not expose mutable internal maps/counters.
 * @param {object} locks
 */
function assertNoInternalExposure(locks) {
  const forbidden = [
    'active',
    'activeCount',
    'counter',
    'count',
    'pending',
    'queue',
    'queues',
    'map',
    'maps',
    'deviceQueues',
    'sessionQueues',
    'snapshotQueues',
    'globalActive',
    'slots',
    '_active',
    '_queues',
    '_map',
  ];
  for (const key of forbidden) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(locks, key),
      false,
      `must not expose internal field ${key}`,
    );
  }
  // maxGlobalTransfers is the only allowed capacity field and must be a frozen number.
  assert.equal(typeof locks.maxGlobalTransfers, 'number');
  assert.ok(Number.isInteger(locks.maxGlobalTransfers));
}

// ── Surface / default ───────────────────────────────────────────────

describe('createUploadLocks surface', () => {
  it('default maxGlobalTransfers is 4; returns frozen five-field surface only', () => {
    const locks = createUploadLocks();
    assert.equal(locks.maxGlobalTransfers, 4);
    assert.equal(typeof locks.runTransfer, 'function');
    assert.equal(typeof locks.runDevice, 'function');
    assert.equal(typeof locks.runSession, 'function');
    assert.equal(typeof locks.runSnapshot, 'function');
    assertNoInternalExposure(locks);

    const keys = Object.keys(locks).sort();
    assert.deepEqual(keys, [
      'maxGlobalTransfers',
      'runDevice',
      'runSession',
      'runSnapshot',
      'runTransfer',
    ].sort());

    // Returned API object is frozen (no caller mutation of surface).
    assert.ok(Object.isFrozen(locks));
    assert.throws(() => {
      /** @type {{ maxGlobalTransfers: number }} */ (locks).maxGlobalTransfers = 99;
    });
    assert.equal(locks.maxGlobalTransfers, 4);
  });

  it('explicit maxGlobalTransfers=4 matches default; legal 1 and 16 accepted', () => {
    assert.equal(createUploadLocks({ maxGlobalTransfers: 4 }).maxGlobalTransfers, 4);
    assert.equal(createUploadLocks({ maxGlobalTransfers: 1 }).maxGlobalTransfers, 1);
    assert.equal(createUploadLocks({ maxGlobalTransfers: 16 }).maxGlobalTransfers, 16);
  });
});

// ── Global transfer semaphore ───────────────────────────────────────

describe('runTransfer global semaphore', () => {
  it('default 4: 4 held actives succeed; 5th immediate backpressure; release reuses; no pending queue', async () => {
    const locks = createUploadLocks();
    assert.equal(locks.maxGlobalTransfers, 4);

    /** @type {ReturnType<typeof deferred>[]} */
    const gates = [];
    /** @type {Promise<unknown>[]} */
    const held = [];
    /** @type {number[]} */
    const started = [];

    for (let i = 0; i < 4; i += 1) {
      const g = deferred();
      gates.push(g);
      const idx = i;
      held.push(
        locks.runTransfer(async () => {
          started.push(idx);
          await g.promise;
          return idx;
        }),
      );
    }
    await waitUntil(() => started.length === 4, '4 transfers started');
    assert.deepEqual(started.slice().sort((a, b) => a - b), [0, 1, 2, 3]);

    // 5th while full: immediate upload-backpressure; never enters task body.
    let fifthEntered = false;
    await assert.rejects(
      () =>
        locks.runTransfer(async () => {
          fifthEntered = true;
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
        });
        return true;
      },
    );
    assert.equal(fifthEntered, false);

    // 6th also immediate backpressure — proves no pending queue accepted the 5th.
    let sixthEntered = false;
    await assert.rejects(
      () =>
        locks.runTransfer(async () => {
          sixthEntered = true;
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
        });
        return true;
      },
    );
    assert.equal(sixthEntered, false);

    // Release one slot → brand-new transfer may acquire (reuse), not a queued ghost.
    gates[0].resolve();
    await held[0];
    await yieldTurns();

    let seventhEntered = false;
    const seventhDone = deferred();
    const seventh = locks.runTransfer(async () => {
      seventhEntered = true;
      await seventhDone.promise;
      return 'ok';
    });
    await waitUntil(() => seventhEntered === true, '7th transfer after release');
    seventhDone.resolve();
    assert.equal(await seventh, 'ok');

    for (let i = 1; i < 4; i += 1) gates[i].resolve();
    await Promise.all(held.slice(1));
  });

  it('maxGlobalTransfers=2: 3rd active immediately backpressure', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 2 });
    assert.equal(locks.maxGlobalTransfers, 2);
    const g1 = deferred();
    const g2 = deferred();
    let n = 0;
    const p1 = locks.runTransfer(async () => {
      n += 1;
      await g1.promise;
    });
    const p2 = locks.runTransfer(async () => {
      n += 1;
      await g2.promise;
    });
    await waitUntil(() => n === 2, 'two held');

    await assert.rejects(
      () => locks.runTransfer(async () => {}),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
        });
        return true;
      },
    );

    g1.resolve();
    g2.resolve();
    await Promise.all([p1, p2]);
  });

  it('maxGlobalTransfers=1 legal; concurrent never exceeds 1', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    let concurrent = 0;
    let peak = 0;
    const g = deferred();
    const p1 = locks.runTransfer(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await g.promise;
      concurrent -= 1;
    });
    await waitUntil(() => concurrent === 1, 'one active');
    await assert.rejects(
      () => locks.runTransfer(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        concurrent -= 1;
      }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_BACKPRESSURE, { statusCode: 429, retryable: true });
        return true;
      },
    );
    g.resolve();
    await p1;
    assert.equal(peak, 1);
    // After release, may re-acquire.
    await locks.runTransfer(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      concurrent -= 1;
    });
    assert.equal(peak, 1);
  });

  it('maxGlobalTransfers=16: 16 held ok; 17th backpressure; concurrent never >16', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 16 });
    assert.equal(locks.maxGlobalTransfers, 16);
    let concurrent = 0;
    let peak = 0;
    /** @type {ReturnType<typeof deferred>[]} */
    const gates = [];
    /** @type {Promise<unknown>[]} */
    const held = [];
    for (let i = 0; i < 16; i += 1) {
      const g = deferred();
      gates.push(g);
      held.push(
        locks.runTransfer(async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await g.promise;
          concurrent -= 1;
        }),
      );
    }
    await waitUntil(() => concurrent === 16, '16 held');
    assert.equal(peak, 16);

    await assert.rejects(
      () => locks.runTransfer(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        concurrent -= 1;
      }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_BACKPRESSURE, { statusCode: 429, retryable: true });
        return true;
      },
    );
    assert.equal(peak, 16);
    assert.ok(peak <= 16);

    for (const g of gates) g.resolve();
    await Promise.all(held);
    assert.equal(concurrent, 0);
  });

  it('sync throw releases slot so next transfer can acquire', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    await assert.rejects(
      () =>
        locks.runTransfer(() => {
          throw new Error('boom-sync');
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'boom-sync');
        return true;
      },
    );
    // Slot free — next transfer succeeds.
    const v = await locks.runTransfer(async () => 'reused');
    assert.equal(v, 'reused');
  });

  it('async reject releases slot so next transfer can acquire', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    await assert.rejects(
      () =>
        locks.runTransfer(async () => {
          throw new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR);
        }),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
    const v = await locks.runTransfer(async () => 42);
    assert.equal(v, 42);
  });

  it('thenable / hostile task result does not leak internal maps or pin the slot forever', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    // Non-thenable primitive result.
    assert.equal(await locks.runTransfer(() => 7), 7);

    // Real thenable that resolves.
    const v = await locks.runTransfer(() => ({
      then(onFulfilled) {
        onFulfilled('from-thenable');
      },
    }));
    assert.equal(v, 'from-thenable');

    // Hostile thenable that rejects once.
    await assert.rejects(
      () =>
        locks.runTransfer(() => ({
          then(_ok, fail) {
            fail(new Error('hostile-thenable'));
          },
        })),
      (err) => {
        assert.equal(/** @type {Error} */ (err).message, 'hostile-thenable');
        return true;
      },
    );

    // Slot must be free after hostile thenable.
    assert.equal(await locks.runTransfer(async () => 'after-hostile'), 'after-hostile');
    assertNoInternalExposure(locks);
  });

  it('backpressure error has message===code and no path/host/token leaks', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    const g = deferred();
    const held = locks.runTransfer(async () => {
      await g.promise;
    });
    await yieldTurns(4);
    await assert.rejects(
      () => locks.runTransfer(async () => {}),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
          leakTokens: [
            '/Users',
            'repo/devices',
            '127.0.0.1',
            'localhost',
            'Bearer ',
            'token',
            'ENOSPC',
          ],
        });
        return true;
      },
    );
    g.resolve();
    await held;
  });
});

// ── Constructor fail-closed (no clamp, no runtime 429 for config) ───

describe('createUploadLocks maxGlobalTransfers fail-closed', () => {
  it('rejects 0, negative, 17, oversized, NaN, Infinity, float, string, null without clamp', () => {
    const cases = [
      { value: 0, leak: ['0'] },
      { value: -1, leak: ['-1'] },
      { value: -99, leak: ['-99'] },
      { value: 17, leak: ['17'] },
      { value: 18, leak: ['18'] },
      { value: 100, leak: ['100'] },
      { value: 1_000_000, leak: ['1000000', '1e6'] },
      { value: Number.NaN, leak: ['NaN'] },
      { value: Number.POSITIVE_INFINITY, leak: ['Infinity'] },
      { value: Number.NEGATIVE_INFINITY, leak: ['Infinity'] },
      { value: 1.5, leak: ['1.5'] },
      { value: 3.14, leak: ['3.14'] },
      { value: '4', leak: ['"4"', '\'4\''] },
      { value: '16', leak: ['16'] },
      { value: null, leak: [] },
      { value: undefined, leak: [] }, // explicit undefined on own key — still invalid if provided as non-default path via object
    ];

    for (const c of cases) {
      // When maxGlobalTransfers own-key is present with invalid value → fail-closed.
      // Note: omitting the key uses default 4; own undefined must not silently default
      // if implementation reads own property as present — pin fail-closed for all listed.
      if (c.value === undefined) {
        // Own key undefined: must fail-closed (no silent default via missing-key path).
        assertConfigFailClosed(
          () => createUploadLocks({ maxGlobalTransfers: undefined }),
          c.leak,
        );
        continue;
      }
      assertConfigFailClosed(
        () => createUploadLocks({ maxGlobalTransfers: /** @type {any} */ (c.value) }),
        c.leak,
      );
    }
  });

  it('hostile getter / proxy on options fail-closed without leak or clamp', () => {
    const secret = 'super-secret-token-xyz';
    assertConfigFailClosed(
      () =>
        createUploadLocks(
          /** @type {any} */ ({
            get maxGlobalTransfers() {
              throw new Error(`boom ${secret} /tmp/evil path`);
            },
          }),
        ),
      [secret, '/tmp/evil', 'boom'],
    );

    const proxy = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'maxGlobalTransfers') return 99;
          return undefined;
        },
        has() {
          return true;
        },
        ownKeys() {
          return ['maxGlobalTransfers'];
        },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true, value: 99 };
        },
      },
    );
    assertConfigFailClosed(() => createUploadLocks(/** @type {any} */ (proxy)), ['99']);
  });

  it('non-object options fail-closed (null / array / string / number)', () => {
    for (const bad of [null, undefined, [], 'x', 4, true]) {
      // undefined alone may mean default options — only assert for clearly hostile.
      if (bad === undefined) {
        // createUploadLocks() and createUploadLocks(undefined) both default.
        const locks = createUploadLocks(undefined);
        assert.equal(locks.maxGlobalTransfers, 4);
        continue;
      }
      let threw = false;
      try {
        createUploadLocks(/** @type {any} */ (bad));
      } catch (err) {
        threw = true;
        assert.ok(err instanceof Error);
        if (err instanceof LinkeError) {
          assert.notEqual(err.code, ERROR_CODES.UPLOAD_BACKPRESSURE);
        }
      }
      assert.ok(threw, `must reject non-object options: ${String(bad)}`);
    }
  });

  it('never silent-clamps 17→16 or 0→1: construction fails, no usable locks object', () => {
    for (const value of [0, 17, 32, -3]) {
      let locks = null;
      try {
        locks = createUploadLocks({ maxGlobalTransfers: value });
      } catch (err) {
        assert.equal(/** @type {Error} */ (err).message, INVALID_MAX_GLOBAL);
        locks = null;
      }
      assert.equal(locks, null, `value ${value} must not produce locks`);
    }
  });
});

// ── Keyed runners: device / session / snapshot ──────────────────────

describe('keyed async runners (device / session / snapshot)', () => {
  it('runDevice same-key is strict FIFO; second waits for first', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });
    /** @type {string[]} */
    const order = [];
    const gate = deferred();
    const firstStarted = deferred();

    const p1 = locks.runDevice('device-a', async () => {
      firstStarted.resolve();
      order.push('1s');
      await gate.promise;
      order.push('1e');
      return 1;
    });
    await firstStarted.promise;

    let secondStarted = false;
    const p2 = locks.runDevice('device-a', async () => {
      secondStarted = true;
      order.push('2');
      return 2;
    });

    await yieldTurns(16);
    assert.equal(secondStarted, false, 'same-key must not start while prior holds');
    assert.deepEqual(order, ['1s']);

    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, 1);
    assert.equal(r2, 2);
    assert.equal(secondStarted, true);
    assert.deepEqual(order, ['1s', '1e', '2']);
  });

  it('runDevice different keys run concurrently (barrier, no sleep)', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });
    const aStarted = deferred();
    const bStarted = deferred();
    const aGate = deferred();
    const bGate = deferred();

    const pA = locks.runDevice('dev-a', async () => {
      aStarted.resolve();
      await aGate.promise;
      return 'a';
    });
    const pB = locks.runDevice('dev-b', async () => {
      bStarted.resolve();
      await bGate.promise;
      return 'b';
    });

    // Both must be inside critical sections simultaneously.
    await Promise.all([aStarted.promise, bStarted.promise]);
    aGate.resolve();
    bGate.resolve();
    assert.deepEqual(await Promise.all([pA, pB]), ['a', 'b']);
  });

  it('runSession same-key FIFO; different (deviceId,uploadId) concurrent', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });
    const gate = deferred();
    const firstStarted = deferred();
    /** @type {number[]} */
    const order = [];

    const p1 = locks.runSession('dev', 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', async () => {
      firstStarted.resolve();
      order.push(1);
      await gate.promise;
      order.push(2);
    });
    await firstStarted.promise;

    let p2Started = false;
    const p2 = locks.runSession('dev', 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', async () => {
      p2Started = true;
      order.push(3);
    });
    await yieldTurns(16);
    assert.equal(p2Started, false);

    // Different uploadId concurrent with held same-device session? Session key is
    // (deviceId, uploadId) — different uploadId may run in parallel.
    const otherStarted = deferred();
    const otherGate = deferred();
    const pOther = locks.runSession('dev', 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002', async () => {
      otherStarted.resolve();
      await otherGate.promise;
    });
    await otherStarted.promise; // must start while p1 still holds different session key

    gate.resolve();
    otherGate.resolve();
    await Promise.all([p1, p2, pOther]);
    assert.equal(p2Started, true);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('runSnapshot same-key FIFO; different snapshot keys concurrent', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });
    const gate = deferred();
    const firstStarted = deferred();
    const p1 = locks.runSnapshot('dev', '550e8400-e29b-41d4-a716-446655440000', async () => {
      firstStarted.resolve();
      await gate.promise;
    });
    await firstStarted.promise;

    let sameStarted = false;
    const pSame = locks.runSnapshot('dev', '550e8400-e29b-41d4-a716-446655440000', async () => {
      sameStarted = true;
    });
    await yieldTurns(16);
    assert.equal(sameStarted, false);

    const otherStarted = deferred();
    const pOther = locks.runSnapshot('dev', '550e8400-e29b-41d4-a716-446655440001', async () => {
      otherStarted.resolve();
    });
    await otherStarted.promise;

    gate.resolve();
    await Promise.all([p1, pSame, pOther]);
    assert.equal(sameStarted, true);
  });

  it('prior task reject does not stall same-key queue; tail clears Map (no leak)', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });

    await assert.rejects(
      () =>
        locks.runDevice('stall-probe', async () => {
          throw new Error('first-fails');
        }),
      (err) => {
        assert.equal(/** @type {Error} */ (err).message, 'first-fails');
        return true;
      },
    );

    // Second task on same key must still run (queue not permanently stalled).
    const v = await locks.runDevice('stall-probe', async () => 'recovered');
    assert.equal(v, 'recovered');

    // After idle, no internal map exposure; another independent key works.
    assertNoInternalExposure(locks);
    assert.equal(await locks.runDevice('other', async () => 'ok'), 'ok');
  });

  it('key normalization avoids concat collisions (a+bc vs ab+c)', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });
    // Naive `${deviceId}${uploadId}` collides for ('a','bc') vs ('ab','c').
    const aStarted = deferred();
    const bStarted = deferred();
    const aGate = deferred();
    const bGate = deferred();

    const p1 = locks.runSession('a', 'bc', async () => {
      aStarted.resolve();
      await aGate.promise;
      return 1;
    });
    const p2 = locks.runSession('ab', 'c', async () => {
      bStarted.resolve();
      await bGate.promise;
      return 2;
    });

    // If keys collided, one would wait for the other and bothStarted would hang
    // until aGate/bGate — but we require simultaneous entry.
    await Promise.all([aStarted.promise, bStarted.promise]);
    aGate.resolve();
    bGate.resolve();
    assert.deepEqual(await Promise.all([p1, p2]), [1, 2]);

    // Same for snapshot keys.
    const s1 = deferred();
    const s2 = deferred();
    const g1 = deferred();
    const g2 = deferred();
    const q1 = locks.runSnapshot('a', 'bc', async () => {
      s1.resolve();
      await g1.promise;
    });
    const q2 = locks.runSnapshot('ab', 'c', async () => {
      s2.resolve();
      await g2.promise;
    });
    await Promise.all([s1.promise, s2.promise]);
    g1.resolve();
    g2.resolve();
    await Promise.all([q1, q2]);
  });

  it('hostile keys fail-closed without leak; do not poison other keys', async () => {
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });
    const secret = 'leak-me-token-path-/tmp/x';

    const hostile = [
      null,
      undefined,
      '',
      0,
      12,
      true,
      { toString: () => secret },
      {
        get value() {
          throw new Error(secret);
        },
      },
    ];

    for (const bad of hostile) {
      await assert.rejects(
        () => locks.runDevice(/** @type {any} */ (bad), async () => 'nope'),
        (err) => {
          assert.ok(err instanceof Error);
          // Prefer LinkeError upload-io-error or fixed Error — never backpressure for key shape.
          if (err instanceof LinkeError) {
            assert.notEqual(err.code, ERROR_CODES.UPLOAD_BACKPRESSURE);
            assert.equal(err.message, err.code);
            assertLinkeCode(err, err.code, { leakTokens: [secret, '/tmp/x'] });
          } else {
            const msg = /** @type {Error} */ (err).message;
            assert.ok(!msg.includes(secret), 'must not leak hostile key material');
            assert.ok(!msg.includes('/tmp/x'));
          }
          return true;
        },
      );

      await assert.rejects(
        () => locks.runSession(/** @type {any} */ (bad), 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', async () => {}),
        (err) => {
          assert.ok(err instanceof Error);
          if (err instanceof LinkeError) assert.equal(err.message, err.code);
          return true;
        },
      );

      await assert.rejects(
        () =>
          locks.runSession('dev', /** @type {any} */ (bad), async () => {}),
        (err) => {
          assert.ok(err instanceof Error);
          if (err instanceof LinkeError) assert.equal(err.message, err.code);
          return true;
        },
      );

      await assert.rejects(
        () =>
          locks.runSnapshot('dev', /** @type {any} */ (bad), async () => {}),
        (err) => {
          assert.ok(err instanceof Error);
          if (err instanceof LinkeError) assert.equal(err.message, err.code);
          return true;
        },
      );
    }

    // Healthy keys still work after hostile probes.
    assert.equal(await locks.runDevice('healthy', async () => 'ok'), 'ok');
    assert.equal(
      await locks.runSession('healthy', 'aaaaaaaa-bbbb-4ccc-8ddd-000000000099', async () => 'ok'),
      'ok',
    );
    assert.equal(
      await locks.runSnapshot('healthy', '550e8400-e29b-41d4-a716-446655440099', async () => 'ok'),
      'ok',
    );
  });

  it('global full does not queue keyed runners behind transfer; keyed still schedules independently', async () => {
    // Global is fail-fast; keyed FIFO is separate. Holding all global slots must
    // NOT prevent runDevice from starting (they do not share the transfer counter).
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    const transferGate = deferred();
    const transferStarted = deferred();
    const t = locks.runTransfer(async () => {
      transferStarted.resolve();
      await transferGate.promise;
    });
    await transferStarted.promise;

    // Global full → transfer backpressure.
    await assert.rejects(
      () => locks.runTransfer(async () => {}),
      (err) => {
        assertLinkeCode(err, ERROR_CODES.UPLOAD_BACKPRESSURE, { statusCode: 429, retryable: true });
        return true;
      },
    );

    // Keyed runner must still run immediately (not queued behind global).
    const deviceStarted = deferred();
    const d = locks.runDevice('while-global-full', async () => {
      deviceStarted.resolve();
      return 'device-ok';
    });
    await deviceStarted.promise;
    assert.equal(await d, 'device-ok');

    transferGate.resolve();
    await t;
  });
});
