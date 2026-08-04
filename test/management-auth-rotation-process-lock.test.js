/**
 * V1.40 C1 unit tests: audit integrity multi-process write lock (lockf fd form).
 *
 * Injection / unit only. Real multi-process exclusion is C3 — not proven here.
 * Optional real-lockf smoke is marked C1 feasibility only (not multi-process proof).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import {
  chmod,
  lstat as realLstat,
  mkdir,
  mkdtemp,
  open as realOpen,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK_SRC = fileURLToPath(
  new URL('../src/management-auth-rotation-process-lock.js', import.meta.url),
);
const LOCK_CODE = 'management-auth-rotation-process-lock-unavailable';
const LOCK_REL = 'auth/management-rotation.lock';
const FIXED_EUID = 501;
const CONTENDER_HELPER = fileURLToPath(
  new URL('./helpers/management-auth-rotation-lock-contender.js', import.meta.url),
);

/**
 * @param {unknown} error
 * @param {string[]} [forbiddenFragments]
 */
function assertLockError(error, forbiddenFragments = []) {
  assert.equal(error?.name, 'ManagementAuthRotationProcessLockError');
  assert.equal(error?.code, LOCK_CODE);
  assert.equal(error?.message, LOCK_CODE);
  for (const fragment of forbiddenFragments) {
    if (!fragment) continue;
    assert.equal(String(error?.message).includes(fragment), false);
    assert.equal(String(error?.code).includes(fragment), false);
  }
  return true;
}

/**
 * @param {string} prefix
 * @param {(root: string) => Promise<unknown>} fn
 */
async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-marpl-${prefix}-`));
  try {
    return await fn(resolve(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 启动真实多进程 helper；子进程不继承父进程凭据环境。 */
function spawnContender(args) {
  const child = spawnProcess(process.execPath, [CONTENDER_HELPER, ...args], {
    env: Object.create(null),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    exitPromise,
  };
}

async function waitForStdoutLine(run, expected, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.stdout.split(/\r?\n/).includes(expected)) return;
    if (run.child.exitCode !== null || run.child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`helper did not emit fixed stdout word ${expected}`);
}

async function waitForExit(run, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      run.exitPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('helper exit timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a Stats-like object for injection tests.
 * @param {Partial<{
 *   isFile: boolean,
 *   isSymbolicLink: boolean,
 *   isDirectory: boolean,
 *   dev: number,
 *   ino: number,
 *   nlink: number,
 *   mode: number,
 *   uid: number,
 * }>} [overrides]
 */
function makeStat(overrides = {}) {
  const isFile = overrides.isFile !== false;
  const isSymbolicLink = overrides.isSymbolicLink === true;
  const isDirectory = overrides.isDirectory === true;
  return {
    dev: overrides.dev ?? 1,
    ino: overrides.ino ?? 100,
    nlink: overrides.nlink ?? 1,
    mode: overrides.mode ?? 0o100600,
    uid: overrides.uid ?? FIXED_EUID,
    isFile: () => isFile && !isSymbolicLink && !isDirectory,
    isSymbolicLink: () => isSymbolicLink,
    isDirectory: () => isDirectory,
  };
}

/**
 * @param {{
 *   exitCode?: number | null,
 *   signal?: string | null,
 *   spawnThrow?: Error,
 *   spawnError?: Error,
 *   emitOrder?: Array<'error' | 'exit'>,
 *   track?: object[],
 * }} [scenario]
 */
function createFakeSpawn(scenario = {}) {
  const track = scenario.track || [];
  const spawnImpl = (binary, args, options) => {
    const call = { binary, args, options };
    track.push(call);
    if (scenario.spawnThrow) {
      throw scenario.spawnThrow;
    }
    const child = new EventEmitter();
    queueMicrotask(() => {
      const order = scenario.emitOrder || (
        scenario.spawnError
          ? ['error', 'exit']
          : ['exit']
      );
      for (const event of order) {
        if (event === 'error') {
          child.emit('error', scenario.spawnError || new Error('spawn-failed'));
        } else if (event === 'exit') {
          child.emit(
            'exit',
            scenario.exitCode === undefined ? 0 : scenario.exitCode,
            scenario.signal === undefined ? null : scenario.signal,
          );
        }
      }
    });
    return child;
  };
  return { spawnImpl, track };
}

/**
 * @param {{
 *   preStat?: ReturnType<typeof makeStat>,
 *   postStat?: ReturnType<typeof makeStat>,
 *   preLstat?: ReturnType<typeof makeStat>,
 *   postLstat?: ReturnType<typeof makeStat>,
 *   closeThrow?: Error,
 *   openThrow?: Error,
 *   lstatThrow?: Error,
 *   lstatThrowOnCall?: number,
 *   pathOps?: { unlink?: number, rename?: number, chmod?: number, write?: number, truncate?: number },
 *   fd?: number,
 * }} [opts]
 */
function createInjectedFs(opts = {}) {
  let statCalls = 0;
  let lstatCalls = 0;
  let closeCalls = 0;
  const pathOps = opts.pathOps || {
    unlink: 0,
    rename: 0,
    chmod: 0,
    write: 0,
    truncate: 0,
  };
  const fd = opts.fd ?? 42;
  /** @type {{ close: () => Promise<void>, stat: () => Promise<unknown>, fd: number, write?: Function, truncate?: Function, chmod?: Function } | null} */
  let handle = null;

  const open = async () => {
    if (opts.openThrow) throw opts.openThrow;
    handle = {
      fd,
      async stat() {
        statCalls += 1;
        if (statCalls === 1) return opts.preStat || makeStat();
        return opts.postStat || opts.preStat || makeStat();
      },
      async close() {
        closeCalls += 1;
        if (opts.closeThrow) throw opts.closeThrow;
      },
      async write() {
        pathOps.write += 1;
        throw new Error('write-should-not-be-called');
      },
      async truncate() {
        pathOps.truncate += 1;
        throw new Error('truncate-should-not-be-called');
      },
      async chmod() {
        pathOps.chmod += 1;
        throw new Error('chmod-should-not-be-called');
      },
    };
    return handle;
  };

  const lstat = async () => {
    lstatCalls += 1;
    if (opts.lstatThrow && (opts.lstatThrowOnCall === undefined || opts.lstatThrowOnCall === lstatCalls)) {
      throw opts.lstatThrow;
    }
    if (lstatCalls === 1) return opts.preLstat || opts.preStat || makeStat();
    return opts.postLstat || opts.postStat || opts.preLstat || opts.preStat || makeStat();
  };

  return {
    open,
    lstat,
    pathOps,
    get closeCalls() {
      return closeCalls;
    },
    get statCalls() {
      return statCalls;
    },
    get lstatCalls() {
      return lstatCalls;
    },
    get handle() {
      return handle;
    },
  };
}

/**
 * @param {object} extra
 */
function baseOptions(extra = {}) {
  const fs = createInjectedFs(extra.fsOpts || {});
  const spawn = createFakeSpawn(extra.spawnScenario || {});
  /** @type {{ root: unknown, relativeDir: unknown }[]} */
  const ensureCalls = [];
  /** @type {unknown[]} */
  const accessCalls = [];
  /** @type {Array<{ path: unknown, flags: unknown, mode: unknown }>} */
  const openCalls = [];
  const defaultEnsure = async (root, relativeDir) => {
    ensureCalls.push({ root, relativeDir });
    return join(String(root), 'auth');
  };
  const ensureImpl =
    extra.deps && Object.prototype.hasOwnProperty.call(extra.deps, 'ensureSafeRelativeDir')
      ? async (root, relativeDir) => {
          ensureCalls.push({ root, relativeDir });
          return extra.deps.ensureSafeRelativeDir(root, relativeDir);
        }
      : defaultEnsure;
  const openImpl = async (path, flags, mode) => {
    openCalls.push({ path, flags, mode });
    return fs.open(path, flags, mode);
  };
  const accessImpl = async (...args) => {
    accessCalls.push(args);
    if (extra.deps && typeof extra.deps.access === 'function') {
      return extra.deps.access(...args);
    }
    return undefined;
  };
  // Strip ensure/access/open from extra.deps so wrappers win; remaining deps override.
  const {
    ensureSafeRelativeDir: _ignoredEnsure,
    access: _ignoredAccess,
    open: _ignoredOpen,
    ...restDeps
  } = extra.deps || {};
  return {
    fs,
    spawn,
    ensureCalls,
    accessCalls,
    openCalls,
    options: {
      platform: 'darwin',
      deps: {
        platform: 'darwin',
        spawn: spawn.spawnImpl,
        open: openImpl,
        lstat: fs.lstat,
        geteuid: () => FIXED_EUID,
        access: accessImpl,
        ensureSafeRelativeDir: ensureImpl,
        ...restDeps,
      },
      ...(extra.options || {}),
    },
  };
}

describe('management-auth-rotation-process-lock exports and production source contracts', () => {
  it('exports frozen contract surface and production uses async lockf (not spawnSync)', async () => {
    const mod = await import('../src/management-auth-rotation-process-lock.js');
    assert.equal(mod.MANAGEMENT_AUTH_ROTATION_PROCESS_LOCK_RELATIVE_PATH, LOCK_REL);
    assert.equal(mod.MANAGEMENT_AUTH_ROTATION_PROCESS_LOCK_TIMEOUT_SECONDS, 5);
    assert.equal(typeof mod.acquireManagementAuthRotationProcessLock, 'function');
    assert.equal(typeof mod.releaseManagementAuthRotationProcessLock, 'function');
    assert.equal(typeof mod.ManagementAuthRotationProcessLockError, 'function');

    const source = await readFile(LOCK_SRC, 'utf8');
    assert.match(source, /\/usr\/bin\/lockf/);
    assert.match(source, /\['-s',\s*'-t',\s*'5',\s*'3'\]/);
    assert.match(source, /Object\.create\(null\)/);
    assert.match(source, /shell:\s*false/);
    assert.equal(/\bspawnSync\b/.test(source), false, 'production must not use spawnSync');
    // Protocol must not mutate lock path as reclaim/repair.
    assert.equal(/\bunlink\s*\(/.test(source), false);
    assert.equal(/\brename\s*\(/.test(source), false);
    // No write/truncate/chmod on lock protocol path (import presence of names elsewhere is ok;
    // production acquire must not call these ops — covered by injection spies below).
    assert.equal(/\bhard.?link\b/i.test(source), false);
    assert.equal(/ORPHAN_GRACE/.test(source), false);
    assert.equal(/owner\.json/.test(source), false);
  });
});

describe('acquireManagementAuthRotationProcessLock happy path (injected)', () => {
  it('spawns absolute lockf with exact argv/shell/stdio[3]/empty env; keeps fd open', async () => {
    const { acquireManagementAuthRotationProcessLock, releaseManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, spawn, options } = baseOptions();
    const root = '/tmp/linke-fake-root-happy';

    const handle = await acquireManagementAuthRotationProcessLock(root, options);
    assert.equal(typeof handle, 'object');
    assert.ok(handle);
    assert.equal(Object.isFrozen(handle), true);
    assert.equal(fs.closeCalls, 0, 'acquire must not close FileHandle on success');

    assert.equal(spawn.track.length, 1);
    const call = spawn.track[0];
    assert.equal(call.binary, '/usr/bin/lockf');
    assert.deepEqual(call.args, ['-s', '-t', '5', '3']);
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio.slice(0, 3), ['ignore', 'ignore', 'ignore']);
    assert.equal(call.options.stdio[3], 42);
    assert.equal(Object.getPrototypeOf(call.options.env), null);
    assert.deepEqual(Object.keys(call.options.env), []);
    assert.equal(call.options.env.PATH, undefined);
    assert.equal(call.options.env.HOME, undefined);

    await releaseManagementAuthRotationProcessLock(handle);
    assert.equal(fs.closeCalls, 1);
  });

  it('runs mandatory post-exit-0 attribute gate (stat+lstat again)', async () => {
    const { acquireManagementAuthRotationProcessLock, releaseManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions();
    const handle = await acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-post', options);
    // PRE: exactly 1 stat + 1 lstat; POST: exactly 1 stat + 1 lstat (total 2 each).
    assert.equal(fs.statCalls, 2, `expected PRE+POST stat exactly twice, got ${fs.statCalls}`);
    assert.equal(fs.lstatCalls, 2, `expected PRE+POST lstat exactly twice, got ${fs.lstatCalls}`);
    await releaseManagementAuthRotationProcessLock(handle);
  });

  it('canonical open path is join(ensureSafeRelativeDir return, management-rotation.lock)', async () => {
    const { acquireManagementAuthRotationProcessLock, releaseManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const root = '/tmp/linke-fake-root-audit-return';
    const auditedAuditDir = join(root, 'auth');
    /** @type {{ root: unknown, relativeDir: unknown }[]} */
    const ensureCalls = [];
    /** @type {unknown[]} */
    const openPaths = [];
    const good = makeStat();
    let closeCalls = 0;
    const handleObj = {
      fd: 9,
      async stat() {
        return good;
      },
      async close() {
        closeCalls += 1;
      },
    };
    const options = {
      platform: 'darwin',
      deps: {
        platform: 'darwin',
        spawn: createFakeSpawn().spawnImpl,
        geteuid: () => FIXED_EUID,
        access: async () => undefined,
        lstat: async () => good,
        ensureSafeRelativeDir: async (r, relativeDir) => {
          ensureCalls.push({ root: r, relativeDir });
          assert.equal(r, root);
          assert.equal(relativeDir, 'auth');
          return auditedAuditDir;
        },
        open: async (path) => {
          openPaths.push(path);
          return handleObj;
        },
      },
    };
    const handle = await acquireManagementAuthRotationProcessLock(root, options);
    assert.equal(ensureCalls.length, 1);
    assert.equal(openPaths.length, 1);
    assert.equal(openPaths[0], join(auditedAuditDir, 'management-rotation.lock'));
    assert.equal(openPaths[0], join(root, LOCK_REL));
    // Must NOT open by joining raw full REL only without consuming ensure return
    // (contract: open path === join(ensureReturn, basename)).
    assert.equal(String(openPaths[0]).startsWith(auditedAuditDir + '/'), true);
    await releaseManagementAuthRotationProcessLock(handle);
    assert.equal(closeCalls, 1);
  });
});

describe('resolvedRoot contract (path-free assertResolvedRoot)', () => {
  /**
   * @param {unknown} badRoot
   * @param {string[]} fragments
   */
  async function expectRootRejectedBeforeIo(badRoot, fragments) {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    let accessCalls = 0;
    let ensureCalls = 0;
    let openCalls = 0;
    let spawnCalls = 0;
    const options = {
      platform: 'darwin',
      deps: {
        platform: 'darwin',
        geteuid: () => FIXED_EUID,
        access: async () => {
          accessCalls += 1;
        },
        ensureSafeRelativeDir: async () => {
          ensureCalls += 1;
          return '/tmp/should-not-run/audit';
        },
        open: async () => {
          openCalls += 1;
          throw new Error('open-should-not-run');
        },
        spawn: () => {
          spawnCalls += 1;
          throw new Error('spawn-should-not-run');
        },
        lstat: async () => makeStat(),
      },
    };
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock(badRoot, options),
      (error) => assertLockError(error, fragments),
    );
    // Prefer fail before access/ensure/open/spawn; at minimum zero open/spawn.
    assert.equal(openCalls, 0, 'invalid root must not open');
    assert.equal(spawnCalls, 0, 'invalid root must not spawn');
    assert.equal(ensureCalls, 0, 'invalid root must not call ensureSafeRelativeDir');
    assert.equal(accessCalls, 0, 'invalid root must not access lockf before root assert');
  }

  it('rejects relative root with fixed error; zero access/ensure/open/spawn; no leak', async () => {
    await expectRootRejectedBeforeIo('foo', ['foo']);
  });

  it('rejects non-normalized absolute root with fixed error; zero IO; no leak', async () => {
    const bad = '/tmp/linke-a/../linke-b';
    await expectRootRejectedBeforeIo(bad, ['/tmp/linke-a', '../', 'linke-b', bad]);
  });

  it('rejects NUL-containing root with fixed error; zero IO; no leak', async () => {
    const bad = '/tmp/linke\0secret';
    await expectRootRejectedBeforeIo(bad, ['\0', '/tmp/linke', 'secret']);
  });

  it('rejects empty / non-string roots path-free', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { options, openCalls, spawn, ensureCalls } = baseOptions();
    for (const bad of ['', null, undefined, 12, {}]) {
      await assert.rejects(
        () => acquireManagementAuthRotationProcessLock(bad, options),
        (error) => assertLockError(error),
      );
    }
    assert.equal(openCalls.length, 0);
    assert.equal(spawn.track.length, 0);
    assert.equal(ensureCalls.length, 0);
  });
});

describe('ensureSafeRelativeDir contract + geteuid unavailable', () => {
  it('ensure throw with /secret/path/errno/raw → fixed error, zero open, no leak', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    let openCalls = 0;
    let spawnCalls = 0;
    const secret = '/secret/path/errno=EACCES raw=boom';
    const options = {
      platform: 'darwin',
      deps: {
        platform: 'darwin',
        geteuid: () => FIXED_EUID,
        access: async () => undefined,
        ensureSafeRelativeDir: async () => {
          const err = new Error(`ENOENT ${secret}`);
          err.code = 'ENOENT';
          throw err;
        },
        open: async () => {
          openCalls += 1;
          throw new Error('open-should-not-run');
        },
        spawn: () => {
          spawnCalls += 1;
          throw new Error('spawn-should-not-run');
        },
        lstat: async () => makeStat(),
      },
    };
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-ensure-throw', options),
      (error) => assertLockError(error, [
        '/secret/path',
        'ENOENT',
        'EACCES',
        'raw=boom',
        secret,
      ]),
    );
    assert.equal(openCalls, 0);
    assert.equal(spawnCalls, 0);
  });

  it('ensure returns mismatched auditDir → fixed fail, zero open, no leak', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const root = '/tmp/linke-fake-root-mismatch-audit';
    let openCalls = 0;
    let spawnCalls = 0;
    const options = {
      platform: 'darwin',
      deps: {
        platform: 'darwin',
        geteuid: () => FIXED_EUID,
        access: async () => undefined,
        ensureSafeRelativeDir: async () => '/tmp/other-place/audit',
        open: async () => {
          openCalls += 1;
          throw new Error('open-should-not-run');
        },
        spawn: () => {
          spawnCalls += 1;
          throw new Error('spawn-should-not-run');
        },
        lstat: async () => makeStat(),
      },
    };
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock(root, options),
      (error) => assertLockError(error, [
        root,
        '/tmp/other-place',
        'other-place',
      ]),
    );
    assert.equal(openCalls, 0);
    assert.equal(spawnCalls, 0);
  });

  it('ensure returns non-string / empty → fixed fail, zero open', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    for (const bad of [null, undefined, '', 42, {}]) {
      let openCalls = 0;
      const options = {
        platform: 'darwin',
        deps: {
          platform: 'darwin',
          geteuid: () => FIXED_EUID,
          access: async () => undefined,
          ensureSafeRelativeDir: async () => bad,
          open: async () => {
            openCalls += 1;
            throw new Error('open-should-not-run');
          },
          spawn: () => {
            throw new Error('spawn-should-not-run');
          },
          lstat: async () => makeStat(),
        },
      };
      await assert.rejects(
        () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-ensure-bad', options),
        (error) => assertLockError(error),
      );
      assert.equal(openCalls, 0);
    }
  });

  it('deps.geteuid=null → pre gate fixed error, close exactly once, no leak', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options, spawn } = baseOptions({
      deps: { geteuid: null },
    });
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-no-geteuid', options),
      (error) => assertLockError(error, [
        '/tmp/linke-fake-root-no-geteuid',
        'geteuid',
        'euid',
        'null',
      ]),
    );
    // Opened for PRE gate, then closed; lockf must not succeed path (spawn may or may not
    // have run only after PRE — geteuid is PRE so spawn must be zero).
    assert.equal(fs.closeCalls, 1);
    assert.equal(spawn.track.length, 0, 'geteuid fail is PRE; must not spawn lockf');
  });
});

describe('acquire lockf child failure paths (single-settle + close once)', () => {
  it('exit 75 → unavailable + close exactly once', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions({ spawnScenario: { exitCode: 75 } });
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-75', options),
      (error) => assertLockError(error, ['/tmp', '75', 'ENOENT', 'errno']),
    );
    assert.equal(fs.closeCalls, 1);
  });

  it('other exit code → unavailable + close once', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions({ spawnScenario: { exitCode: 1 } });
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-exit1', options),
      (error) => assertLockError(error),
    );
    assert.equal(fs.closeCalls, 1);
  });

  it('signal terminate → unavailable + close once', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions({
      spawnScenario: { exitCode: null, signal: 'SIGTERM' },
    });
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-sig', options),
      (error) => assertLockError(error, ['SIGTERM']),
    );
    assert.equal(fs.closeCalls, 1);
  });

  it('spawn sync throw → unavailable + close once', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions({
      spawnScenario: { spawnThrow: new Error('EACCES /usr/bin/lockf') },
    });
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-throw', options),
      (error) => assertLockError(error, ['EACCES', '/usr/bin/lockf']),
    );
    assert.equal(fs.closeCalls, 1);
  });

  it('spawn error then exit single-settles to one rejection + one close', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions({
      spawnScenario: {
        spawnError: new Error('spawn ENOENT'),
        exitCode: 1,
        emitOrder: ['error', 'exit'],
      },
    });
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-err-exit', options),
      (error) => assertLockError(error, ['ENOENT', 'spawn']),
    );
    assert.equal(fs.closeCalls, 1);
  });

  it('spawn exit then error reverse order still single-settles + one close', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions({
      spawnScenario: {
        spawnError: new Error('late error'),
        exitCode: 127,
        emitOrder: ['exit', 'error'],
      },
    });
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-exit-err', options),
      (error) => assertLockError(error, ['127', 'late error']),
    );
    assert.equal(fs.closeCalls, 1);
  });
});

describe('platform / lockf availability gates', () => {
  it('non-darwin platform → unavailable (no success handle)', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions({
      deps: { platform: 'linux' },
      options: { platform: 'linux' },
    });
    // Force platform via top-level and deps.
    options.platform = 'linux';
    options.deps.platform = 'linux';
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-linux', options),
      (error) => assertLockError(error, ['linux']),
    );
    assert.equal(fs.closeCalls, 0);
  });

  it('missing / unspawnable lockf → unavailable', async () => {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions({
      deps: {
        access: async () => {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        },
      },
    });
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-nolockf', options),
      (error) => assertLockError(error, ['ENOENT', '/usr/bin/lockf']),
    );
    assert.equal(fs.closeCalls, 0);
  });
});

describe('attribute gates pre/post (fail-closed, no path repair)', () => {
  /**
   * @param {string} label
   * @param {object} fsOpts
   * @param {'pre' | 'post'} phase
   */
  async function expectAttrFail(label, fsOpts, phase) {
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions({ fsOpts });
    await assert.rejects(
      () => acquireManagementAuthRotationProcessLock(`/tmp/linke-fake-root-${label}`, options),
      (error) => assertLockError(error, [
        '/tmp',
        'management-rotation.lock',
        'EPERM',
        'errno',
        String(FIXED_EUID),
      ]),
      label,
    );
    if (phase === 'pre') {
      assert.equal(fs.closeCalls, 1, `${label}: pre-fail must close`);
    } else {
      assert.equal(fs.closeCalls, 1, `${label}: post-fail must close`);
    }
    assert.equal(fs.pathOps.unlink, 0);
    assert.equal(fs.pathOps.rename, 0);
    assert.equal(fs.pathOps.chmod, 0);
    assert.equal(fs.pathOps.write, 0);
    assert.equal(fs.pathOps.truncate, 0);
  }

  it('pre: symlink → error + close; no unlink/rename/chmod', async () => {
    await expectAttrFail(
      'pre-symlink',
      {
        preStat: makeStat({ isFile: false, isSymbolicLink: true }),
        preLstat: makeStat({ isFile: false, isSymbolicLink: true }),
      },
      'pre',
    );
  });

  it('pre: non-regular directory → error', async () => {
    await expectAttrFail(
      'pre-dir',
      {
        preStat: makeStat({ isFile: false, isDirectory: true }),
        preLstat: makeStat({ isFile: false, isDirectory: true }),
      },
      'pre',
    );
  });

  it('pre: dev/ino mismatch → error', async () => {
    await expectAttrFail(
      'pre-ino',
      {
        preStat: makeStat({ dev: 1, ino: 10 }),
        preLstat: makeStat({ dev: 1, ino: 99 }),
      },
      'pre',
    );
  });

  it('pre: nlink !== 1 → error', async () => {
    await expectAttrFail(
      'pre-nlink',
      {
        preStat: makeStat({ nlink: 2 }),
        preLstat: makeStat({ nlink: 2 }),
      },
      'pre',
    );
  });

  it('pre: mode !== 0o600 → error (no chmod repair)', async () => {
    await expectAttrFail(
      'pre-mode',
      {
        preStat: makeStat({ mode: 0o100644 }),
        preLstat: makeStat({ mode: 0o100644 }),
      },
      'pre',
    );
  });

  it('pre: wrong uid → error', async () => {
    await expectAttrFail(
      'pre-uid',
      {
        preStat: makeStat({ uid: FIXED_EUID + 1 }),
        preLstat: makeStat({ uid: FIXED_EUID + 1 }),
      },
      'pre',
    );
  });

  it('post-exit-0: attr fail → close + error; zero success handle', async () => {
    await expectAttrFail(
      'post-mode',
      {
        preStat: makeStat({ mode: 0o100600 }),
        preLstat: makeStat({ mode: 0o100600 }),
        postStat: makeStat({ mode: 0o100644 }),
        postLstat: makeStat({ mode: 0o100644 }),
      },
      'post',
    );
  });

  it('post-exit-0: ino mismatch → close + error', async () => {
    await expectAttrFail(
      'post-ino',
      {
        preStat: makeStat({ ino: 10 }),
        preLstat: makeStat({ ino: 10 }),
        postStat: makeStat({ ino: 10 }),
        postLstat: makeStat({ ino: 11 }),
      },
      'post',
    );
  });

  it('post-exit-0: nlink/symlink/uid fail → close + error', async () => {
    await expectAttrFail(
      'post-nlink',
      {
        postStat: makeStat({ nlink: 3 }),
        postLstat: makeStat({ nlink: 3 }),
      },
      'post',
    );
    await expectAttrFail(
      'post-symlink',
      {
        postStat: makeStat({ isFile: true }),
        postLstat: makeStat({ isFile: false, isSymbolicLink: true }),
      },
      'post',
    );
    await expectAttrFail(
      'post-uid',
      {
        postStat: makeStat({ uid: FIXED_EUID + 7 }),
        postLstat: makeStat({ uid: FIXED_EUID + 7 }),
      },
      'post',
    );
  });
});

describe('releaseManagementAuthRotationProcessLock', () => {
  it('happy path closes FileHandle exactly once', async () => {
    const { acquireManagementAuthRotationProcessLock, releaseManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions();
    const handle = await acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-rel', options);
    await releaseManagementAuthRotationProcessLock(handle);
    assert.equal(fs.closeCalls, 1);
  });

  it('double release fail-closed', async () => {
    const { acquireManagementAuthRotationProcessLock, releaseManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { options } = baseOptions();
    const handle = await acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-dbl', options);
    await releaseManagementAuthRotationProcessLock(handle);
    await assert.rejects(
      () => releaseManagementAuthRotationProcessLock(handle),
      (error) => assertLockError(error),
    );
  });

  it('forged / mismatch handle fail-closed', async () => {
    const { releaseManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    await assert.rejects(
      () => releaseManagementAuthRotationProcessLock(Object.freeze(Object.create(null))),
      (error) => assertLockError(error),
    );
    await assert.rejects(
      () => releaseManagementAuthRotationProcessLock(null),
      (error) => assertLockError(error),
    );
    await assert.rejects(
      () => releaseManagementAuthRotationProcessLock(undefined),
      (error) => assertLockError(error),
    );
    await assert.rejects(
      () => releaseManagementAuthRotationProcessLock({ forged: true }),
      (error) => assertLockError(error),
    );
  });

  it('close throw still fixed registered error (failure wins)', async () => {
    const { acquireManagementAuthRotationProcessLock, releaseManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { options } = baseOptions({
      fsOpts: { closeThrow: new Error('EIO close /secret/path errno=5') },
    });
    const handle = await acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-close', options);
    await assert.rejects(
      () => releaseManagementAuthRotationProcessLock(handle),
      (error) => assertLockError(error, ['EIO', '/secret', 'errno', '5']),
    );
    // Double release after failed close still fail-closed (handle terminated).
    await assert.rejects(
      () => releaseManagementAuthRotationProcessLock(handle),
      (error) => assertLockError(error),
    );
  });
});

describe('createManagementAuthRotationExclusiveLock task/release 语义', () => {
  it('task 与 release 成功时返回 task 原结果同一引用', async () => {
    const { createManagementAuthRotationExclusiveLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions();
    const result = Object.freeze({ marker: 'synthetic-result' });
    const withExclusiveLock = createManagementAuthRotationExclusiveLock(
      '/tmp/linke-fake-root-factory-success',
      options,
    );

    assert.equal(await withExclusiveLock(async () => result), result);
    assert.equal(fs.closeCalls, 1);
  });

  it('task 失败但 release 成功时原样重抛 task error 引用', async () => {
    const { createManagementAuthRotationExclusiveLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    const { fs, options } = baseOptions();
    const taskError = new Error('synthetic task failure');
    const withExclusiveLock = createManagementAuthRotationExclusiveLock(
      '/tmp/linke-fake-root-factory-task-fail',
      options,
    );

    await assert.rejects(
      withExclusiveLock(async () => { throw taskError; }),
      (error) => error === taskError,
    );
    assert.equal(fs.closeCalls, 1);
  });

  it('task 成败均以 release 失败优先，返回固定 process-lock error', async () => {
    const { createManagementAuthRotationExclusiveLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    for (const taskFails of [false, true]) {
      const { options } = baseOptions({
        fsOpts: { closeThrow: new Error('synthetic close failure') },
      });
      const taskError = new Error('synthetic task failure');
      const withExclusiveLock = createManagementAuthRotationExclusiveLock(
        `/tmp/linke-fake-root-factory-release-fail-${taskFails}`,
        options,
      );
      await assert.rejects(
        withExclusiveLock(async () => {
          if (taskFails) throw taskError;
          return Object.freeze({ ok: true });
        }),
        (error) => {
          assert.notEqual(error, taskError);
          return assertLockError(error, [taskError.message, 'synthetic close failure']);
        },
      );
    }
  });
});

describe('error messages are path/token/errno free', () => {
  it('ManagementAuthRotationProcessLockError has fixed name/code/message', async () => {
    const { ManagementAuthRotationProcessLockError } =
      await import('../src/management-auth-rotation-process-lock.js');
    const error = new ManagementAuthRotationProcessLockError();
    assert.equal(error.name, 'ManagementAuthRotationProcessLockError');
    assert.equal(error.code, LOCK_CODE);
    assert.equal(error.message, LOCK_CODE);
    assert.equal(error.message.includes('/'), false);
    assert.equal(error.message.includes('ENOENT'), false);
  });
});

describe('production ops scan + injection spies (no path mutation protocol)', () => {
  it('injection spies: open flags create+rdwr+nofollow 0600; no write/truncate/chmod on handle', async () => {
    const { acquireManagementAuthRotationProcessLock, releaseManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');
    /** @type {Array<{ path: unknown, flags: unknown, mode: unknown }>} */
    const openCalls = [];
    const good = makeStat();
    let closeCalls = 0;
    const handle = {
      fd: 7,
      async stat() {
        return good;
      },
      async close() {
        closeCalls += 1;
      },
      async write() {
        throw new Error('write-forbidden');
      },
      async truncate() {
        throw new Error('truncate-forbidden');
      },
      async chmod() {
        throw new Error('chmod-forbidden');
      },
    };
    const options = {
      platform: 'darwin',
      deps: {
        platform: 'darwin',
        spawn: createFakeSpawn().spawnImpl,
        open: async (path, flags, mode) => {
          openCalls.push({ path, flags, mode });
          return handle;
        },
        lstat: async () => good,
        geteuid: () => FIXED_EUID,
        access: async () => undefined,
        ensureSafeRelativeDir: async (root) => join(String(root), 'auth'),
      },
    };
    const h = await acquireManagementAuthRotationProcessLock('/tmp/linke-fake-root-flags', options);
    assert.equal(openCalls.length, 1);
    const expectedFlags =
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
    assert.equal(openCalls[0].flags, expectedFlags);
    assert.equal(openCalls[0].mode, 0o600);
    // Path argument must be under auth/management-rotation.lock (shape only; still not echoed in errors).
    assert.equal(String(openCalls[0].path).endsWith(LOCK_REL), true);
    await releaseManagementAuthRotationProcessLock(h);
    assert.equal(closeCalls, 1);
  });
});

describe('C1 feasibility smoke (real lockf; NOT C3 multi-process proof)', () => {
  it('real local acquire+release keeps lock file; unit/feasibility only', async () => {
    if (process.platform !== 'darwin') {
      return;
    }
    const { access } = await import('node:fs/promises');
    try {
      await access('/usr/bin/lockf', constants.X_OK);
    } catch {
      return; // environment without lockf — skip feasibility smoke
    }

    const {
      acquireManagementAuthRotationProcessLock,
      releaseManagementAuthRotationProcessLock,
      MANAGEMENT_AUTH_ROTATION_PROCESS_LOCK_RELATIVE_PATH,
    } = await import('../src/management-auth-rotation-process-lock.js');

    await withTempRoot('smoke', async (root) => {
      const handle = await acquireManagementAuthRotationProcessLock(root);
      assert.ok(handle);
      const lockAbs = join(root, MANAGEMENT_AUTH_ROTATION_PROCESS_LOCK_RELATIVE_PATH);
      const stHeld = await realLstat(lockAbs);
      assert.equal(stHeld.isFile(), true);
      assert.equal(stHeld.nlink, 1);
      assert.equal(stHeld.mode & 0o777, 0o600);

      await releaseManagementAuthRotationProcessLock(handle);

      // File remains after release (existence is not the lock).
      const stAfter = await realLstat(lockAbs);
      assert.equal(stAfter.isFile(), true);
      assert.equal(stAfter.nlink, 1);

      // Re-acquire after release works (kernel released OFD flock).
      const handle2 = await acquireManagementAuthRotationProcessLock(root);
      await releaseManagementAuthRotationProcessLock(handle2);
      const stFinal = await realLstat(lockAbs);
      assert.equal(stFinal.isFile(), true);
    });
  });

  it('real pre-gate: hostile mode 0644 is rejected without chmod repair', async () => {
    if (process.platform !== 'darwin') {
      return;
    }
    const { access } = await import('node:fs/promises');
    try {
      await access('/usr/bin/lockf', constants.X_OK);
    } catch {
      return;
    }
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');

    await withTempRoot('hostile-mode', async (root) => {
      await mkdir(join(root, 'auth'), { recursive: true });
      const lockAbs = join(root, LOCK_REL);
      await writeFile(lockAbs, '', { mode: 0o644 });
      await chmod(lockAbs, 0o644);
      await assert.rejects(
        () => acquireManagementAuthRotationProcessLock(root),
        (error) => assertLockError(error, [root, lockAbs, 'EACCES', 'chmod']),
      );
      const st = await realLstat(lockAbs);
      assert.equal(st.mode & 0o777, 0o644, 'must not chmod-repair hostile mode');
    });
  });

  it('real pre-gate: symlink at canonical path is rejected (no follow/unlink)', async () => {
    if (process.platform !== 'darwin') {
      return;
    }
    const { acquireManagementAuthRotationProcessLock } =
      await import('../src/management-auth-rotation-process-lock.js');

    await withTempRoot('hostile-symlink', async (root) => {
      await mkdir(join(root, 'auth'), { recursive: true });
      const target = join(root, 'auth', 'elsewhere');
      await writeFile(target, 'x', { mode: 0o600 });
      const lockAbs = join(root, LOCK_REL);
      await symlink(target, lockAbs);
      await assert.rejects(
        () => acquireManagementAuthRotationProcessLock(root),
        (error) => assertLockError(error, [root, lockAbs, target]),
      );
      // Symlink still present — no unlink repair.
      const st = await realLstat(lockAbs);
      assert.equal(st.isSymbolicLink(), true);
    });
  });
});

const describeDarwinMultiprocess = process.platform === 'darwin' ? describe : describe.skip;

describeDarwinMultiprocess('管理认证轮换锁真实多进程证据（macOS lockf）', () => {
  it('两个短任务均成功且临界区不重叠', async () => {
    await withTempRoot('multiprocess-serialize', async (root) => {
      const witness = join(root, 'witness.log');
      const first = spawnContender(['task', root, 'A', witness]);
      const second = spawnContender(['task', root, 'B', witness]);
      const [firstExit, secondExit] = await Promise.all([
        waitForExit(first),
        waitForExit(second),
      ]);

      assert.deepEqual(firstExit, { code: 0, signal: null });
      assert.deepEqual(secondExit, { code: 0, signal: null });
      assert.equal(first.stdout, 'DONE\n');
      assert.equal(second.stdout, 'DONE\n');
      assert.equal(first.stderr, '');
      assert.equal(second.stderr, '');

      const lines = (await readFile(witness, 'utf8')).trim().split('\n');
      assert.equal(lines.length, 4);
      assert.match(lines[0], /^BEGIN [AB]$/);
      const firstId = lines[0].slice(-1);
      assert.equal(lines[1], `END ${firstId}`);
      const secondId = firstId === 'A' ? 'B' : 'A';
      assert.equal(lines[2], `BEGIN ${secondId}`);
      assert.equal(lines[3], `END ${secondId}`);
    });
  });

  it('预持锁超过 5 秒时 contender 固定 exit 2 且不进入 task', async () => {
    await withTempRoot('multiprocess-timeout', async (root) => {
      const witness = join(root, 'witness.log');
      const holder = spawnContender(['hold', root, '15000']);
      try {
        await waitForStdoutLine(holder, 'HOLDING');
        const startedAt = Date.now();
        const contender = spawnContender(['task', root, 'C', witness]);
        const contenderExit = await waitForExit(contender, 12_000);
        assert.deepEqual(contenderExit, { code: 2, signal: null });
        assert.ok(Date.now() - startedAt >= 4_000, 'lockf contender must wait for timeout');
        assert.equal(contender.stdout, '');
        assert.equal(contender.stderr, 'LOCK_UNAVAILABLE\n');
        await assert.rejects(readFile(witness, 'utf8'), (error) => error?.code === 'ENOENT');
      } finally {
        if (holder.child.exitCode === null && holder.child.signalCode === null) {
          holder.child.kill('SIGKILL');
        }
        await waitForExit(holder, 5_000);
      }
    });
  });

  it('holder 被 SIGTERM 后下一进程可立即获取锁', async () => {
    await withTempRoot('multiprocess-sigterm', async (root) => {
      const witness = join(root, 'witness.log');
      const holder = spawnContender(['hold', root, '15000']);
      await waitForStdoutLine(holder, 'HOLDING');
      holder.child.kill('SIGTERM');
      const holderExit = await waitForExit(holder, 5_000);
      assert.equal(holderExit.signal, 'SIGTERM');

      const contender = spawnContender(['task', root, 'D', witness]);
      const contenderExit = await waitForExit(contender, 10_000);
      assert.deepEqual(contenderExit, { code: 0, signal: null });
      assert.equal(contender.stdout, 'DONE\n');
      assert.equal(contender.stderr, '');
      assert.equal(await readFile(witness, 'utf8'), 'BEGIN D\nEND D\n');
    });
  });
});
