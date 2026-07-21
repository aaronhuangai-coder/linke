/**
 * V1.40 C3: real multi-process proof for audit integrity process lock + queue.
 *
 * Independent Node children only (fork + IPC). Same-process Promises do not count.
 * Production sources are not modified; no process-lock injection seams.
 *
 * Worker fixture: test/fixtures/audit-integrity-multiprocess-worker.mjs
 *
 * Child lifecycle: each fork gets a persistent mailbox attached before spawnWorker
 * returns (IPC messages, spawn error, exit). waitIpc/waitExit/assertNoIpc consume
 * that mailbox — never rely on temporary EventEmitter listeners alone, and never
 * assume the IPC pipe buffers messages for late EventEmitter listeners.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile as execFileCb, fork } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'fixtures', 'audit-integrity-multiprocess-worker.mjs');

const LOCK_REL = 'audit/integrity-write.lock';
const STATE_REL = 'audit/integrity-dual-write-state.json';
const EVENTS_REL = 'audit/events.jsonl';
const JOURNAL_REL = 'audit/integrity-journal.jsonl';
const LOCK_CODE = 'audit-integrity-process-lock-unavailable';

/** Fixed IPC protocol kinds (must match worker). */
const KIND = Object.freeze({
  HELLO: 'HELLO',
  READY: 'READY',
  BARRIER_READY: 'BARRIER_READY',
  ENTERED: 'ENTERED',
  LOCKF_EXITED: 'LOCKF_EXITED',
  DONE: 'DONE',
  ERROR: 'ERROR',
});

/** Fixed worker roles (must match worker). */
const ROLE = Object.freeze({
  HOLD_QUEUE: 'HOLD_QUEUE',
  CONTEND_ENTER: 'CONTEND_ENTER',
  APPEND_BARRIER: 'APPEND_BARRIER',
  TIMEOUT_CONTEND: 'TIMEOUT_CONTEND',
  WAITER_QUEUE: 'WAITER_QUEUE',
  PREPARE_CRASH: 'PREPARE_CRASH',
  APPEND_ONCE: 'APPEND_ONCE',
});

const DARWIN = process.platform === 'darwin';
const SKIP_REASON = 'C3 real multi-process lock proof requires macOS + /usr/bin/lockf';

const DEFAULT_IPC_MS = 15_000;
const HOLD_NON_ENTRY_MS = 800;
const LOCKF_RESIDUAL_MS = 7_000;
const TIMEOUT_ELAPSED_MIN_MS = 4_000;
const TIMEOUT_ELAPSED_MAX_MS = 12_000;
const CLEANUP_KILL_MS = 3_000;
const PGREP_POLL_MS = 50;
const PGREP_FIND_MS = 5_000;

/**
 * @param {string} prefix
 * @param {(root: string) => Promise<unknown>} fn
 */
async function withTempRoot(prefix, fn) {
  const root = resolve(await mkdtemp(join(tmpdir(), `linke-c3-mpl-${prefix}-`)));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Bounded wait with deadline; clears timer on settle.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} diagnostic
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, diagnostic) {
  let timer;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => {
      settle(() => reject(new Error(diagnostic)));
    }, ms);
    Promise.resolve(promise).then(
      (value) => settle(() => resolvePromise(value)),
      (err) => settle(() => reject(err)),
    );
  });
}

/**
 * Bounded polling helper with deadline + diagnostic. Never unbounded while.
 * @template T
 * @param {() => T | Promise<T>} probe
 * @param {(value: T) => boolean} pred
 * @param {number} deadlineMs
 * @param {string} diagnostic
 * @param {number} [intervalMs]
 * @returns {Promise<T>}
 */
async function pollUntil(probe, pred, deadlineMs, diagnostic, intervalMs = PGREP_POLL_MS) {
  const start = Date.now();
  let last;
  while (Date.now() - start < deadlineMs) {
    last = await probe();
    if (pred(last)) return last;
    const remaining = deadlineMs - (Date.now() - start);
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  }
  throw new Error(`${diagnostic} (last=${JSON.stringify(last)})`);
}

/**
 * Minimal env for child: no parent credential/secret inheritance beyond PATH.
 * @returns {NodeJS.ProcessEnv}
 */
function minimalChildEnv() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: process.env.TMPDIR || tmpdir(),
  };
}

// ── Persistent child lifecycle mailbox ─────────────────────────────────

/**
 * @typedef {{
 *   kind: string,
 *   settled: boolean,
 *   timer: NodeJS.Timeout | undefined,
 *   resolve: (value: object) => void,
 *   reject: (err: Error) => void,
 * }} IpcWaiter
 *
 * @typedef {{
 *   settled: boolean,
 *   timer: NodeJS.Timeout | undefined,
 *   resolve: (value: { code: number | null, signal: string | null }) => void,
 *   reject: (err: Error) => void,
 * }} ExitWaiter
 *
 * @typedef {{
 *   kind: string,
 *   seen: object | null,
 * }} KindObserver
 *
 * @typedef {{
 *   child: import('node:events').EventEmitter & {
 *     pid?: number,
 *     exitCode?: number | null,
 *     signalCode?: string | null,
 *     kill?: (signal?: string) => boolean,
 *     send?: (msg: unknown) => boolean,
 *   },
 *   inbox: object[],
 *   spawnError: Error | null,
 *   exit: { code: number | null, signal: string | null } | null,
 *   ipcWaiters: Set<IpcWaiter>,
 *   exitWaiters: Set<ExitWaiter>,
 *   observers: Set<KindObserver>,
 *   detach: () => void,
 * }} ChildLifecycle
 */

/** @type {WeakMap<object, ChildLifecycle>} */
const childLifecycles = new WeakMap();

/**
 * @param {Error} error
 * @returns {Error}
 */
function makeSpawnLifecycleError(error) {
  const code =
    error && typeof error === 'object' && typeof /** @type {{ code?: unknown }} */ (error).code === 'string'
      ? /** @type {{ code: string }} */ (error).code
      : '';
  const wrapped = new Error(
    code
      ? `child spawn/lifecycle error code=${code}`
      : `child spawn/lifecycle error: ${error && error.message ? error.message : 'unknown'}`,
  );
  /** @type {{ cause?: unknown, code?: string }} */ (wrapped).cause = error;
  if (code) /** @type {{ code?: string }} */ (wrapped).code = code;
  return wrapped;
}

/**
 * @param {ChildLifecycle} life
 * @param {IpcWaiter} waiter
 * @param {{ ok: true, value: object } | { ok: false, error: Error }} result
 */
function settleIpcWaiter(life, waiter, result) {
  if (waiter.settled) return;
  waiter.settled = true;
  if (waiter.timer !== undefined) {
    clearTimeout(waiter.timer);
    waiter.timer = undefined;
  }
  life.ipcWaiters.delete(waiter);
  if (result.ok) waiter.resolve(result.value);
  else waiter.reject(result.error);
}

/**
 * @param {ChildLifecycle} life
 * @param {ExitWaiter} waiter
 * @param {{ ok: true, value: { code: number | null, signal: string | null } } | { ok: false, error: Error }} result
 */
function settleExitWaiter(life, waiter, result) {
  if (waiter.settled) return;
  waiter.settled = true;
  if (waiter.timer !== undefined) {
    clearTimeout(waiter.timer);
    waiter.timer = undefined;
  }
  life.exitWaiters.delete(waiter);
  if (result.ok) waiter.resolve(result.value);
  else waiter.reject(result.error);
}

/**
 * @param {ChildLifecycle} life
 * @param {Error} error
 */
function failAllWaiters(life, error) {
  for (const waiter of [...life.ipcWaiters]) {
    settleIpcWaiter(life, waiter, { ok: false, error });
  }
  for (const waiter of [...life.exitWaiters]) {
    settleExitWaiter(life, waiter, { ok: false, error });
  }
}

/**
 * Deliver one IPC message to a single waiter if it matches.
 * @param {ChildLifecycle} life
 * @param {IpcWaiter} waiter
 * @param {object} msg
 * @returns {boolean} true if consumed by waiter
 */
function deliverToIpcWaiter(life, waiter, msg) {
  if (waiter.settled) return false;
  const kind = /** @type {{ kind?: unknown }} */ (msg).kind;
  if (kind === KIND.ERROR && waiter.kind !== KIND.ERROR) {
    const code = /** @type {{ code?: unknown }} */ (msg).code;
    settleIpcWaiter(life, waiter, {
      ok: false,
      error: new Error(
        `worker ERROR while waiting ${waiter.kind}: ${typeof code === 'string' ? code : 'unknown'}`,
      ),
    });
    return true;
  }
  if (kind === waiter.kind) {
    settleIpcWaiter(life, waiter, { ok: true, value: msg });
    return true;
  }
  return false;
}

/**
 * Pop matching inbox entry. Business ERROR is distinct from spawn error.
 * @param {ChildLifecycle} life
 * @param {string} kind
 * @returns {{ type: 'match' | 'error-ipc', msg: object } | null}
 */
function takeFromInbox(life, kind) {
  if (kind !== KIND.ERROR) {
    const errIdx = life.inbox.findIndex((m) => m && /** @type {{ kind?: unknown }} */ (m).kind === KIND.ERROR);
    if (errIdx >= 0) {
      const msg = life.inbox.splice(errIdx, 1)[0];
      return { type: 'error-ipc', msg };
    }
  }
  const idx = life.inbox.findIndex((m) => m && /** @type {{ kind?: unknown }} */ (m).kind === kind);
  if (idx >= 0) {
    const msg = life.inbox.splice(idx, 1)[0];
    return { type: 'match', msg };
  }
  return null;
}

/**
 * Attach persistent mailbox before any wait. Safe to call once per child.
 * @param {ChildLifecycle['child']} child
 * @returns {ChildLifecycle['child']}
 */
function attachChildLifecycle(child) {
  if (childLifecycles.has(child)) return child;

  /** @type {ChildLifecycle} */
  const life = {
    child,
    inbox: [],
    spawnError: null,
    exit: null,
    ipcWaiters: new Set(),
    exitWaiters: new Set(),
    observers: new Set(),
    detach: () => {},
  };

  /** @param {unknown} msg */
  const onMessage = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const m = /** @type {object} */ (msg);
    for (const obs of life.observers) {
      if (/** @type {{ kind?: unknown }} */ (m).kind === obs.kind) {
        obs.seen = m;
      }
    }
    for (const waiter of life.ipcWaiters) {
      if (deliverToIpcWaiter(life, waiter, m)) return;
    }
    life.inbox.push(m);
  };

  /** @param {Error} err */
  const onError = (err) => {
    if (life.spawnError) return;
    const error = err instanceof Error ? err : new Error(String(err));
    life.spawnError = error;
    failAllWaiters(life, makeSpawnLifecycleError(error));
  };

  /** @param {number | null} code @param {string | null} signal */
  const onExit = (code, signal) => {
    if (life.exit) return;
    life.exit = {
      code: code === undefined ? null : code,
      signal: signal === undefined ? null : signal,
    };
    for (const waiter of [...life.exitWaiters]) {
      settleExitWaiter(life, waiter, { ok: true, value: life.exit });
    }
    // IPC waiters that still need a message fail on terminal exit (inbox already scanned on register).
    for (const waiter of [...life.ipcWaiters]) {
      settleIpcWaiter(life, waiter, {
        ok: false,
        error: new Error(
          `worker exited before ${waiter.kind} (code=${life.exit.code} signal=${life.exit.signal})`,
        ),
      });
    }
  };

  child.on('message', onMessage);
  child.on('error', onError);
  child.on('exit', onExit);

  // Capture already-terminal state (synthetic fixtures / rare races).
  if (child.exitCode !== null && child.exitCode !== undefined) {
    onExit(child.exitCode, child.signalCode ?? null);
  } else if (child.signalCode) {
    onExit(child.exitCode ?? null, child.signalCode);
  }

  life.detach = () => {
    child.off('message', onMessage);
    child.off('error', onError);
    child.off('exit', onExit);
    for (const waiter of [...life.ipcWaiters]) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    }
    for (const waiter of [...life.exitWaiters]) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    }
    life.ipcWaiters.clear();
    life.exitWaiters.clear();
    life.observers.clear();
  };

  childLifecycles.set(child, life);
  return child;
}

/**
 * @param {object} child
 * @returns {ChildLifecycle}
 */
function getLifecycle(child) {
  const life = childLifecycles.get(child);
  if (!life) {
    throw new Error('child has no lifecycle mailbox; spawn via spawnWorker/attachChildLifecycle');
  }
  return life;
}

/**
 * Track children for always-cleanup + lifecycle detach.
 * @returns {{
 *   track: (child: import('node:child_process').ChildProcess) => import('node:child_process').ChildProcess,
 *   killAll: () => Promise<void>,
 *   list: () => import('node:child_process').ChildProcess[],
 * }}
 */
function createChildRegistry() {
  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];
  return {
    track(child) {
      children.push(child);
      return child;
    },
    list() {
      return children.slice();
    },
    async killAll() {
      for (const child of children) {
        const life = childLifecycles.get(child);
        if (life && (life.exit || life.spawnError)) continue;
        if (child.exitCode !== null || child.signalCode) continue;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      await Promise.all(
        children.map(async (child) => {
          try {
            const life = childLifecycles.get(child);
            if (life && (life.exit || life.spawnError)) return;
            if (child.exitCode !== null || child.signalCode) return;
            await waitExit(child, CLEANUP_KILL_MS, `child pid=${child.pid} did not exit after SIGKILL`);
          } catch {
            // best-effort cleanup
          }
        }),
      );
      for (const child of children) {
        const life = childLifecycles.get(child);
        if (life) life.detach();
      }
    },
  };
}

/**
 * Wait for IPC kind using persistent mailbox (cache-first, then bounded waiter).
 * Business ERROR IPC is not confused with spawn error.
 * @param {object} child
 * @param {string} kind
 * @param {number} [ms]
 * @returns {Promise<object>}
 */
function waitIpc(child, kind, ms = DEFAULT_IPC_MS) {
  const life = getLifecycle(child);

  if (life.spawnError) {
    return Promise.reject(makeSpawnLifecycleError(life.spawnError));
  }

  const hit = takeFromInbox(life, kind);
  if (hit) {
    if (hit.type === 'error-ipc') {
      const code = /** @type {{ code?: unknown }} */ (hit.msg).code;
      return Promise.reject(
        new Error(
          `worker ERROR while waiting ${kind}: ${typeof code === 'string' ? code : 'unknown'}`,
        ),
      );
    }
    return Promise.resolve(hit.msg);
  }

  if (life.exit) {
    return Promise.reject(
      new Error(
        `worker exited before ${kind} (code=${life.exit.code} signal=${life.exit.signal})`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    /** @type {IpcWaiter} */
    const waiter = {
      kind,
      settled: false,
      timer: undefined,
      resolve,
      reject,
    };
    waiter.timer = setTimeout(() => {
      settleIpcWaiter(life, waiter, {
        ok: false,
        error: new Error(`IPC wait for ${kind} exceeded ${ms}ms (pid=${child.pid})`),
      });
    }, ms);
    life.ipcWaiters.add(waiter);
  });
}

/**
 * Wait for child terminal exit; spawn error fails fast; pre-recorded exit resolves.
 * @param {object} child
 * @param {number} [ms]
 * @param {string} [diagnostic]
 * @returns {Promise<{ code: number | null, signal: string | null }>}
 */
function waitExit(child, ms = DEFAULT_IPC_MS, diagnostic) {
  const life = getLifecycle(child);
  const label = diagnostic || `child exit pid=${child.pid}`;

  if (life.spawnError) {
    return Promise.reject(makeSpawnLifecycleError(life.spawnError));
  }
  if (life.exit) {
    return Promise.resolve(life.exit);
  }
  if (child.exitCode !== null && child.exitCode !== undefined) {
    life.exit = { code: child.exitCode, signal: child.signalCode ?? null };
    return Promise.resolve(life.exit);
  }
  if (child.signalCode) {
    life.exit = { code: child.exitCode ?? null, signal: child.signalCode };
    return Promise.resolve(life.exit);
  }

  return new Promise((resolve, reject) => {
    /** @type {ExitWaiter} */
    const waiter = {
      settled: false,
      timer: undefined,
      resolve,
      reject,
    };
    waiter.timer = setTimeout(() => {
      settleExitWaiter(life, waiter, { ok: false, error: new Error(label) });
    }, ms);
    life.exitWaiters.add(waiter);
  });
}

/**
 * Assert no message of kind is cached or arrives within windowMs.
 * @param {object} child
 * @param {string} kind
 * @param {number} windowMs
 */
async function assertNoIpc(child, kind, windowMs) {
  const life = getLifecycle(child);
  const cached = life.inbox.find((m) => m && /** @type {{ kind?: unknown }} */ (m).kind === kind);
  assert.equal(
    cached,
    undefined,
    `unexpected cached IPC ${kind} before observation window`,
  );

  /** @type {KindObserver} */
  const obs = { kind, seen: null };
  life.observers.add(obs);
  try {
    await delay(windowMs);
  } finally {
    life.observers.delete(obs);
  }

  assert.equal(obs.seen, null, `unexpected IPC ${kind} within ${windowMs}ms`);
  const after = life.inbox.find((m) => m && /** @type {{ kind?: unknown }} */ (m).kind === kind);
  assert.equal(after, undefined, `unexpected cached IPC ${kind} after observation window`);
}

/**
 * @param {object} init
 * @param {ReturnType<typeof createChildRegistry>} registry
 */
function spawnWorker(init, registry) {
  assert.equal(existsSync(WORKER_PATH), true, `worker fixture missing: ${WORKER_PATH}`);
  // Empty execArgv: do not inherit parent --test / inspect-port / isolation flags.
  const child = fork(WORKER_PATH, [], {
    execArgv: [],
    env: minimalChildEnv(),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'json',
  });
  // Mailbox MUST be attached before spawnWorker returns (and before INIT send races).
  attachChildLifecycle(child);
  registry.track(child);
  child.send({ op: 'INIT', ...init });
  return child;
}

/**
 * Async pgrep -P parent for lockf children (absolute binary; no shell; non-blocking).
 * @param {number} parentPid
 * @returns {Promise<number[]>}
 */
async function listLockfChildren(parentPid) {
  let out = '';
  try {
    const result = await execFileAsync('/usr/bin/pgrep', ['-P', String(parentPid)], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    out = typeof result.stdout === 'string' ? result.stdout : String(result.stdout || '');
  } catch (error) {
    // pgrep exits 1 when no matches (promisify surfaces as error with code/status).
    const status = /** @type {{ status?: number, code?: number | string }} */ (error);
    if (status.status === 1 || status.code === 1 || status.code === '1') return [];
    return [];
  }
  const pids = out
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  /** @type {number[]} */
  const lockfPids = [];
  for (const pid of pids) {
    try {
      const result = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      });
      const comm = (typeof result.stdout === 'string' ? result.stdout : String(result.stdout || '')).trim();
      if (comm === 'lockf' || comm.endsWith('/lockf')) lockfPids.push(pid);
    } catch {
      // process raced out
    }
  }
  return lockfPids;
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} pid
 * @param {number} deadlineMs
 * @param {string} diagnostic
 */
async function waitPidGone(pid, deadlineMs, diagnostic) {
  await pollUntil(
    () => !pidAlive(pid),
    (gone) => gone === true,
    deadlineMs,
    diagnostic,
    50,
  );
}

/**
 * @param {string} root
 * @param {{ dev?: number, ino?: number } | null} [expect]
 */
async function assertLockFileAttrs(root, expect = null) {
  const lockAbs = join(root, LOCK_REL);
  await access(lockAbs, constants.F_OK);
  const st = await lstat(lockAbs);
  assert.equal(st.isSymbolicLink(), false, 'lock must not be symlink');
  assert.equal(st.isFile(), true, 'lock must be regular file');
  assert.equal(st.nlink, 1, 'lock nlink must be 1');
  assert.equal(st.mode & 0o777, 0o600, 'lock mode must be 0600');
  assert.equal(st.size, 0, 'lock size must be 0');
  if (expect && typeof expect.dev === 'number' && typeof expect.ino === 'number') {
    assert.equal(st.dev, expect.dev, 'lock dev must remain stable');
    assert.equal(st.ino, expect.ino, 'lock ino must remain stable');
  }
  return { dev: st.dev, ino: st.ino, mode: st.mode, nlink: st.nlink, size: st.size };
}

/**
 * @param {string} root
 */
async function readStateJson(root) {
  const raw = await readFile(join(root, STATE_REL), 'utf8');
  return JSON.parse(raw);
}

/**
 * @param {string} root
 */
async function readEventsLines(root) {
  try {
    const text = await readFile(join(root, EVENTS_REL), 'utf8');
    return text.split('\n').filter((line) => line.length > 0);
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * @param {number} index
 */
function makeEvent(index) {
  const n = String(index).padStart(12, '0');
  return {
    id: `aaaaaaaa-bbbb-4ccc-8ddd-${n}`,
    createdAt: new Date(Date.UTC(2026, 6, 20, 0, 0, index)).toISOString(),
    type: 'api.c3.multiprocess',
    method: 'POST',
    path: `/api/c3/${index}`,
    outcome: 'success',
  };
}

/**
 * Synthetic child for mailbox unit tests (no real fork).
 * @returns {EventEmitter & { pid: number, exitCode: number | null, signalCode: string | null, kill: () => boolean, send: () => boolean }}
 */
function makeSyntheticChild() {
  const ee = new EventEmitter();
  const child = /** @type {any} */ (ee);
  child.pid = 900000 + Math.floor(Math.random() * 10000);
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  child.send = () => true;
  return child;
}

// ── Lifecycle mailbox unit tests (all platforms; prove pre-wait capture) ─

describe('C3 child lifecycle mailbox', { concurrency: 1 }, () => {
  it('RED-doc: temporary EventEmitter listener cannot recover past message', async () => {
    // Documents the old bug class: attach listener AFTER emit → message lost.
    // EventEmitter does not provide a business mailbox.
    const ee = new EventEmitter();
    ee.emit('message', { kind: KIND.READY, workerId: 'early' });
    /** @type {object | null} */
    let seen = null;
    const onMessage = (msg) => {
      if (msg && msg.kind === KIND.READY) seen = msg;
    };
    ee.on('message', onMessage);
    await delay(30);
    ee.off('message', onMessage);
    assert.equal(
      seen,
      null,
      'legacy temporary listener must miss messages emitted before registration',
    );
  });

  it('mailbox delivers IPC cached before waitIpc registration', async () => {
    const child = makeSyntheticChild();
    attachChildLifecycle(child);
    child.emit('message', { kind: KIND.READY, workerId: 'pre-wait', lockfChildExited: true });
    // No temporary listener was registered at emit time; mailbox must still deliver.
    const msg = await waitIpc(child, KIND.READY, 1_000);
    assert.equal(msg.workerId, 'pre-wait');
    assert.equal(msg.lockfChildExited, true);
    getLifecycle(child).detach();
  });

  it('mailbox fails waitIpc and waitExit immediately on spawn error (not timeout)', async () => {
    const child = makeSyntheticChild();
    attachChildLifecycle(child);
    const spawnErr = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    child.emit('error', spawnErr);

    const t0 = Date.now();
    await assert.rejects(
      () => waitIpc(child, KIND.READY, 5_000),
      (err) => {
        assert.match(String(err && err.message), /spawn\/lifecycle error/);
        assert.match(String(err && err.message), /ENOENT/);
        return true;
      },
    );
    await assert.rejects(
      () => waitExit(child, 5_000, 'should-not-timeout'),
      (err) => {
        assert.match(String(err && err.message), /spawn\/lifecycle error/);
        return true;
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `spawn error must fail fast, elapsed=${elapsed}ms`);
    getLifecycle(child).detach();
  });

  it('mailbox waitExit resolves terminal recorded before waitExit call', async () => {
    const child = makeSyntheticChild();
    attachChildLifecycle(child);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    const t0 = Date.now();
    const term = await waitExit(child, 5_000, 'pre-exit');
    const elapsed = Date.now() - t0;
    assert.equal(term.code, 0);
    assert.equal(term.signal, null);
    assert.ok(elapsed < 200, `pre-recorded exit must resolve immediately, elapsed=${elapsed}ms`);
    getLifecycle(child).detach();
  });

  it('assertNoIpc fails on cached target kind (not only window observation)', async () => {
    const child = makeSyntheticChild();
    attachChildLifecycle(child);
    child.emit('message', { kind: KIND.ENTERED, workerId: 'leaked' });
    await assert.rejects(
      () => assertNoIpc(child, KIND.ENTERED, 50),
      (err) => {
        assert.match(String(err && err.message), /cached IPC ENTERED|unexpected/);
        return true;
      },
    );
    getLifecycle(child).detach();
  });

  it('business ERROR IPC is readable and distinct from spawn error', async () => {
    const child = makeSyntheticChild();
    attachChildLifecycle(child);
    child.emit('message', {
      kind: KIND.ERROR,
      name: 'AuditIntegrityProcessLockError',
      code: LOCK_CODE,
      taskEntered: false,
    });
    const errMsg = await waitIpc(child, KIND.ERROR, 1_000);
    assert.equal(errMsg.code, LOCK_CODE);
    assert.equal(errMsg.name, 'AuditIntegrityProcessLockError');
    assert.equal(errMsg.taskEntered, false);
    // No spawnError was recorded — this was pure business IPC.
    assert.equal(getLifecycle(child).spawnError, null);
    getLifecycle(child).detach();
  });

  it('waitIpc rejects on business ERROR when waiting for another kind (from cache)', async () => {
    const child = makeSyntheticChild();
    attachChildLifecycle(child);
    child.emit('message', { kind: KIND.ERROR, code: LOCK_CODE });
    await assert.rejects(
      () => waitIpc(child, KIND.READY, 1_000),
      (err) => {
        assert.match(String(err && err.message), /worker ERROR while waiting READY/);
        assert.match(String(err && err.message), new RegExp(LOCK_CODE));
        return true;
      },
    );
    getLifecycle(child).detach();
  });
});

// ── Real multi-process proof (Darwin) ──────────────────────────────────

const describeC3 = DARWIN ? describe : describe.skip;

describeC3('V1.40 C3 real multi-process audit integrity lock', { concurrency: 1 }, () => {
  it('fixture worker path exists (protocol host)', () => {
    assert.equal(
      existsSync(WORKER_PATH),
      true,
      `required worker fixture absent: ${WORKER_PATH}`,
    );
  });

  it('1. two real Node children: mutual exclusion + fd lifetime after lockf exit', async () => {
    const registry = createChildRegistry();
    await withTempRoot('mx', async (root) => {
      try {
        const a = spawnWorker(
          { role: ROLE.HOLD_QUEUE, root, workerId: 'A' },
          registry,
        );
        const readyA = await waitIpc(a, KIND.READY);
        assert.equal(readyA.role, ROLE.HOLD_QUEUE);
        assert.equal(readyA.workerId, 'A');
        // Task body only runs after acquire returns; acquire returns only after lockf exit 0.
        assert.equal(readyA.lockfChildExited, true);
        const lockfOfA = await listLockfChildren(/** @type {number} */ (a.pid));
        assert.equal(lockfOfA.length, 0, 'lockf child must have exited before READY');
        const inodeHeld = await assertLockFileAttrs(root);

        const b = spawnWorker(
          { role: ROLE.CONTEND_ENTER, root, workerId: 'B' },
          registry,
        );
        // B must not enter while A holds.
        await assertNoIpc(b, KIND.ENTERED, HOLD_NON_ENTRY_MS);
        assert.equal(b.exitCode, null, 'contender still alive while blocked');

        a.send({ op: 'RELEASE' });
        const enteredB = await waitIpc(b, KIND.ENTERED, DEFAULT_IPC_MS);
        assert.equal(enteredB.workerId, 'B');
        const doneA = await waitIpc(a, KIND.DONE, DEFAULT_IPC_MS);
        assert.equal(doneA.workerId, 'A');

        b.send({ op: 'RELEASE' });
        const doneB = await waitIpc(b, KIND.DONE, DEFAULT_IPC_MS);
        assert.equal(doneB.workerId, 'B');

        await Promise.all([waitExit(a), waitExit(b)]);
        assert.equal(a.exitCode, 0);
        assert.equal(b.exitCode, 0);
        await assertLockFileAttrs(root, inodeHeld);
      } finally {
        await registry.killAll();
      }
    });
  });

  it('2. eight-child barrier dual-write append: exact 8 events, idle, inspector verified', async () => {
    const registry = createChildRegistry();
    await withTempRoot('bar8', async (root) => {
      try {
        const N = 8;
        /** @type {import('node:child_process').ChildProcess[]} */
        const workers = [];
        for (let i = 0; i < N; i += 1) {
          workers.push(
            spawnWorker(
              {
                role: ROLE.APPEND_BARRIER,
                root,
                workerId: `W${i}`,
                event: makeEvent(i + 1),
              },
              registry,
            ),
          );
        }

        for (const w of workers) {
          const msg = await waitIpc(w, KIND.BARRIER_READY, DEFAULT_IPC_MS);
          assert.equal(msg.kind, KIND.BARRIER_READY);
        }

        for (const w of workers) {
          w.send({ op: 'GO' });
        }

        // Wait for all DONE concurrently; mailbox holds early DONE before each wait attaches.
        const doneMsgs = await Promise.all(
          workers.map((w) => waitIpc(w, KIND.DONE, 60_000)),
        );
        for (const done of doneMsgs) {
          assert.equal(done.ok, true);
        }

        await Promise.all(
          workers.map((w) => waitExit(w, DEFAULT_IPC_MS, `barrier worker exit pid=${w.pid}`)),
        );
        for (const w of workers) {
          assert.equal(w.exitCode, 0, `worker exit ${w.pid}`);
        }

        const lines = await readEventsLines(root);
        assert.equal(lines.length, N, 'exactly 8 event lines');
        const ids = lines.map((line) => JSON.parse(line).id).sort();
        const expectedIds = Array.from({ length: N }, (_, i) => makeEvent(i + 1).id).sort();
        assert.deepEqual(ids, expectedIds, 'no loss/duplicates of event ids');

        const state = await readStateJson(root);
        assert.equal(state.status, 'idle');

        const journalText = await readFile(join(root, JOURNAL_REL), 'utf8');
        const journalLines = journalText.split('\n').filter((l) => l.length > 0);
        // generation-open + N event records
        assert.equal(journalLines.length, N + 1);

        const {
          inspectAuditIntegrityDualWriteReadOnly,
        } = await import('../src/audit-integrity-dual-write.js');
        const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
        assert.equal(obs.statePresence, 'idle');
        assert.equal(obs.stateStatus, 'idle');
        assert.equal(obs.journalOutcome, 'verified');
        assert.equal(obs.crossStoreOutcome, 'ok');
        assert.ok(
          obs.relationship === 'equal'
            || obs.relationship === 'events-suffix-of-journal'
            || obs.relationship === 'journal-suffix-of-events',
          `unexpected relationship=${obs.relationship}`,
        );
        assert.equal(obs.reasonCode, null);
        await assertLockFileAttrs(root);
      } finally {
        await registry.killAll();
      }
    });
  });

  it('3. holder SIGKILL → contender acquires; lock file permanent attrs', async () => {
    const registry = createChildRegistry();
    await withTempRoot('sigkill-hold', async (root) => {
      try {
        const holder = spawnWorker(
          { role: ROLE.HOLD_QUEUE, root, workerId: 'H' },
          registry,
        );
        await waitIpc(holder, KIND.READY);
        const inode = await assertLockFileAttrs(root);

        const contender = spawnWorker(
          { role: ROLE.CONTEND_ENTER, root, workerId: 'C' },
          registry,
        );
        await assertNoIpc(contender, KIND.ENTERED, HOLD_NON_ENTRY_MS);

        holder.kill('SIGKILL');
        await waitExit(holder, DEFAULT_IPC_MS, 'holder exit after SIGKILL');

        const entered = await waitIpc(contender, KIND.ENTERED, DEFAULT_IPC_MS);
        assert.equal(entered.workerId, 'C');
        // Lock path must still exist — contender did not delete/repair it.
        await assertLockFileAttrs(root, inode);

        contender.send({ op: 'RELEASE' });
        await waitIpc(contender, KIND.DONE);
        await waitExit(contender, DEFAULT_IPC_MS, 'contender exit');
        assert.equal(contender.exitCode, 0);
        await assertLockFileAttrs(root, inode);
      } finally {
        await registry.killAll();
      }
    });
  });

  it('4. parent SIGKILL while lockf child waits: residual exits, zero task, contender ok', async () => {
    const registry = createChildRegistry();
    await withTempRoot('sigkill-lockf-wait', async (root) => {
      const markerPath = join(root, 'c3-waiter-task-marker');
      try {
        // Marker must be absent before any task body.
        assert.equal(existsSync(markerPath), false);

        const holder = spawnWorker(
          { role: ROLE.HOLD_QUEUE, root, workerId: 'H' },
          registry,
        );
        await waitIpc(holder, KIND.READY);

        const waiter = spawnWorker(
          {
            role: ROLE.WAITER_QUEUE,
            root,
            workerId: 'W',
            markerPath,
          },
          registry,
        );

        const waiterPid = /** @type {number} */ (waiter.pid);
        const lockfPids = await pollUntil(
          () => listLockfChildren(waiterPid),
          (pids) => pids.length >= 1,
          PGREP_FIND_MS,
          `lockf child of waiter pid=${waiterPid} not observed`,
        );
        const lockfPid = lockfPids[0];
        assert.ok(Number.isInteger(lockfPid) && lockfPid > 0);
        assert.equal(pidAlive(lockfPid), true, 'lockf child must be live before parent kill');

        // Kill waiter Node parent while lockf still waiting; task body must not run.
        waiter.kill('SIGKILL');
        await waitExit(waiter, DEFAULT_IPC_MS, 'waiter exit after SIGKILL');
        assert.equal(existsSync(markerPath), false, 'zero task body: marker must stay absent');

        // Residual lockf child must exit within -t 5 (+jitter ≤7s); no permanent orphan.
        const residualStart = Date.now();
        await waitPidGone(
          lockfPid,
          LOCKF_RESIDUAL_MS,
          `residual lockf pid=${lockfPid} did not exit within ${LOCKF_RESIDUAL_MS}ms`,
        );
        const residualElapsed = Date.now() - residualStart;
        assert.ok(
          residualElapsed <= LOCKF_RESIDUAL_MS,
          `residual lockf elapsed ${residualElapsed}ms exceeds bound`,
        );

        // Still no task marker (killed path minted zero lease-backed body).
        assert.equal(existsSync(markerPath), false);

        // Release holder; real contender acquires without deleting lock.
        const inode = await assertLockFileAttrs(root);
        holder.send({ op: 'RELEASE' });
        await waitIpc(holder, KIND.DONE);
        await waitExit(holder, DEFAULT_IPC_MS, 'holder exit');

        const contender = spawnWorker(
          { role: ROLE.CONTEND_ENTER, root, workerId: 'C' },
          registry,
        );
        await waitIpc(contender, KIND.ENTERED, DEFAULT_IPC_MS);
        await assertLockFileAttrs(root, inode);
        contender.send({ op: 'RELEASE' });
        await waitIpc(contender, KIND.DONE);
        await waitExit(contender, DEFAULT_IPC_MS, 'contender exit');
        assert.equal(contender.exitCode, 0);
        assert.equal(existsSync(markerPath), false);
        await assertLockFileAttrs(root, inode);
      } finally {
        await registry.killAll();
        // Temp-root cleanup may remove marker path with the root; protocol never unlinks lock.
      }
    });
  });

  it('5. real -t 5 timeout maps to fixed unavailable code; no path/errno; no task entry', async () => {
    const registry = createChildRegistry();
    await withTempRoot('timeout', async (root) => {
      try {
        const holder = spawnWorker(
          { role: ROLE.HOLD_QUEUE, root, workerId: 'H' },
          registry,
        );
        await waitIpc(holder, KIND.READY);
        const inode = await assertLockFileAttrs(root);

        const t0 = Date.now();
        const contender = spawnWorker(
          { role: ROLE.TIMEOUT_CONTEND, root, workerId: 'T' },
          registry,
        );
        const errMsg = await waitIpc(contender, KIND.ERROR, TIMEOUT_ELAPSED_MAX_MS + 2_000);
        const elapsed = Date.now() - t0;

        assert.equal(errMsg.code, LOCK_CODE);
        assert.equal(errMsg.name, 'AuditIntegrityProcessLockError');
        // No raw path / errno fragments in sanitized worker error fields.
        const blob = JSON.stringify(errMsg);
        assert.equal(blob.includes(root), false);
        assert.equal(blob.includes(LOCK_REL), false);
        assert.equal(blob.includes('ENOENT'), false);
        assert.equal(blob.includes('EAGAIN'), false);
        assert.equal(blob.includes('/usr/bin/lockf'), false);
        assert.equal(errMsg.taskEntered, false);

        assert.ok(
          elapsed >= TIMEOUT_ELAPSED_MIN_MS,
          `elapsed ${elapsed}ms too short for real -t 5`,
        );
        assert.ok(
          elapsed <= TIMEOUT_ELAPSED_MAX_MS,
          `elapsed ${elapsed}ms exceeds tolerant upper bound`,
        );

        await waitExit(contender, DEFAULT_IPC_MS, 'timeout contender exit');
        assert.equal(contender.exitCode, 0);

        holder.send({ op: 'RELEASE' });
        await waitIpc(holder, KIND.DONE);
        await waitExit(holder, DEFAULT_IPC_MS, 'holder exit');
        await assertLockFileAttrs(root, inode);
      } finally {
        await registry.killAll();
      }
    });
  });

  it('6. prepared + holder SIGKILL + existing recovery (no state wipe)', async () => {
    const registry = createChildRegistry();
    await withTempRoot('prep-kill', async (root) => {
      try {
        // Stage A: crash-hook leaves durable prepared state (existing dual-write hook).
        const preparer = spawnWorker(
          {
            role: ROLE.PREPARE_CRASH,
            root,
            workerId: 'P',
            event: makeEvent(1),
          },
          registry,
        );
        const prepDone = await waitIpc(preparer, KIND.DONE, DEFAULT_IPC_MS);
        assert.equal(prepDone.prepared, true);
        await waitExit(preparer, DEFAULT_IPC_MS, 'preparer exit');
        assert.equal(preparer.exitCode, 0);

        const preparedBytes = await readFile(join(root, STATE_REL));
        const preparedJson = JSON.parse(preparedBytes.toString('utf8'));
        assert.equal(preparedJson.status, 'prepared');

        // Stage B: independent holder acquires process lock while prepared remains.
        // Honesty: prepared created via DUAL_WRITE_TEST_CRASH_HOOK then re-acquired hold.
        const holder = spawnWorker(
          { role: ROLE.HOLD_QUEUE, root, workerId: 'H' },
          registry,
        );
        await waitIpc(holder, KIND.READY);
        // Prepared bytes still present while lock held.
        assert.deepEqual(await readFile(join(root, STATE_REL)), preparedBytes);
        const inode = await assertLockFileAttrs(root);

        holder.kill('SIGKILL');
        await waitExit(holder, DEFAULT_IPC_MS, 'holder SIGKILL exit');

        // Stage C: queue-backed recovery/append succeeds without deleting prepared manually.
        const recoverer = spawnWorker(
          {
            role: ROLE.APPEND_ONCE,
            root,
            workerId: 'R',
            event: makeEvent(2),
          },
          registry,
        );
        const recovered = await waitIpc(recoverer, KIND.DONE, 60_000);
        assert.equal(recovered.ok, true);
        await waitExit(recoverer, DEFAULT_IPC_MS, 'recoverer exit');
        assert.equal(recoverer.exitCode, 0);

        const afterBytes = await readFile(join(root, STATE_REL));
        assert.notDeepEqual(
          afterBytes,
          preparedBytes,
          'recovery must consume/change prepared bytes (not leave them, not manual delete)',
        );
        const after = JSON.parse(afterBytes.toString('utf8'));
        assert.equal(after.status, 'idle');

        const lines = await readEventsLines(root);
        // Prepared recovery completes event 1; append adds event 2.
        assert.ok(lines.length >= 1, 'at least recovered event present');
        const ids = new Set(lines.map((l) => JSON.parse(l).id));
        assert.equal(ids.has(makeEvent(1).id), true);
        assert.equal(ids.has(makeEvent(2).id), true);

        const {
          inspectAuditIntegrityDualWriteReadOnly,
        } = await import('../src/audit-integrity-dual-write.js');
        const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
        assert.equal(obs.statePresence, 'idle');
        assert.equal(obs.stateStatus, 'idle');
        assert.equal(obs.journalOutcome, 'verified');
        assert.equal(obs.crossStoreOutcome, 'ok');
        await assertLockFileAttrs(root, inode);
      } finally {
        await registry.killAll();
      }
    });
  });

  it('7. inode permanence across release, timeout/SIGKILL, subsequent acquire', async () => {
    const registry = createChildRegistry();
    await withTempRoot('inode', async (root) => {
      try {
        const a = spawnWorker(
          { role: ROLE.HOLD_QUEUE, root, workerId: 'A' },
          registry,
        );
        await waitIpc(a, KIND.READY);
        const inode1 = await assertLockFileAttrs(root);
        a.send({ op: 'RELEASE' });
        await waitIpc(a, KIND.DONE);
        await waitExit(a, DEFAULT_IPC_MS, 'A exit');
        const inode2 = await assertLockFileAttrs(root, inode1);

        // Timeout path: holder + contender timeout, then re-acquire.
        const holder = spawnWorker(
          { role: ROLE.HOLD_QUEUE, root, workerId: 'H' },
          registry,
        );
        await waitIpc(holder, KIND.READY);
        const contender = spawnWorker(
          { role: ROLE.TIMEOUT_CONTEND, root, workerId: 'T' },
          registry,
        );
        await waitIpc(contender, KIND.ERROR, TIMEOUT_ELAPSED_MAX_MS + 2_000);
        await waitExit(contender, DEFAULT_IPC_MS, 'timeout exit');
        await assertLockFileAttrs(root, inode2);

        holder.kill('SIGKILL');
        await waitExit(holder, DEFAULT_IPC_MS, 'holder kill exit');
        await assertLockFileAttrs(root, inode2);

        const again = spawnWorker(
          { role: ROLE.HOLD_QUEUE, root, workerId: 'B' },
          registry,
        );
        await waitIpc(again, KIND.READY);
        await assertLockFileAttrs(root, inode2);
        again.send({ op: 'RELEASE' });
        await waitIpc(again, KIND.DONE);
        await waitExit(again, DEFAULT_IPC_MS, 'B exit');
        await assertLockFileAttrs(root, inode2);
      } finally {
        await registry.killAll();
      }
    });
  });
});

if (!DARWIN) {
  describe('V1.40 C3 real multi-process audit integrity lock (skipped platform)', () => {
    it(`skipped: ${SKIP_REASON}`, { skip: SKIP_REASON }, () => {});
  });
}
