/**
 * Local multi-process audit integrity write exclusive lock (V1.40 C1).
 *
 * Protocol: macOS /usr/bin/lockf file-descriptor form (BSD flock on shared OFD).
 * Canonical path existence is NOT a held lock; release closes the parent FileHandle only.
 * Never unlink/rename/truncate/chmod the lock file as lock protocol.
 *
 * Network FS / cross-host locks are OUT OF CONTRACT (not detected, not auto-rejected).
 * Queue embedding is C2 — this module is acquire/release only.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access as defaultAccess,
  lstat as defaultLstat,
  open as defaultOpen,
} from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { ERROR_CODES, assertRegisteredErrorCode } from './error-codes.js';
import { ensureSafeRelativeDir as defaultEnsureSafeRelativeDir } from './safe-data-files.js';

/** Root-relative permanent regular lock file (existence ≠ held lock). */
export const AUDIT_INTEGRITY_PROCESS_LOCK_REL = 'audit/integrity-write.lock';

/** Production lockf wait timeout seconds (`-t 5`). */
export const AUDIT_INTEGRITY_PROCESS_LOCK_TIMEOUT_SECONDS = 5;

const LOCKF_BINARY = '/usr/bin/lockf';
const LOCKF_ARGV = Object.freeze(['-s', '-t', '5', '3']);
const OPEN_FLAGS = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
const OPEN_MODE = 0o600;
/** Basename under the audited `audit/` directory (paired with REL export). */
const LOCK_BASENAME = 'integrity-write.lock';
/** Relative dir segment ensured before open. */
const AUDIT_REL_DIR = 'audit';

/**
 * Active module-issued handles → private metadata (root + FileHandle).
 * Disk holds no token/owner JSON; capability is in-process only.
 * @type {WeakMap<object, { resolvedRoot: string, fileHandle: import('node:fs/promises').FileHandle }>}
 */
const activeProcessLockHandles = new WeakMap();

/**
 * Active handle identities (fast membership for release gating).
 * @type {WeakSet<object>}
 */
const activeProcessLockHandleSet = new WeakSet();

/**
 * Path-free process-lock error: fixed name/code/message; registry only.
 * Never embeds path, errno text, raw spawn output, or secrets.
 */
export class AuditIntegrityProcessLockError extends Error {
  constructor() {
    const registered = assertRegisteredErrorCode(
      ERROR_CODES.AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE,
    );
    super(registered);
    this.name = 'AuditIntegrityProcessLockError';
    this.code = registered;
  }
}

/**
 * @returns {never}
 */
function throwUnavailable() {
  throw new AuditIntegrityProcessLockError();
}

/**
 * @returns {AuditIntegrityProcessLockError}
 */
function unavailableError() {
  return new AuditIntegrityProcessLockError();
}

/**
 * Root MUST be non-empty absolute normalized resolved string (caller responsibility:
 * typically assertSafeDataRoot / queue root result). Path-free reject otherwise.
 * Aligned with audit-integrity-write-queue assertQueueResolvedRoot; maps to
 * AuditIntegrityProcessLockError (never echoes input).
 * @param {unknown} resolvedRoot
 * @returns {string}
 */
function assertResolvedRoot(resolvedRoot) {
  if (typeof resolvedRoot !== 'string' || resolvedRoot.length === 0) throwUnavailable();
  if (resolvedRoot.includes('\0')) throwUnavailable();
  if (!isAbsolute(resolvedRoot)) throwUnavailable();
  if (normalize(resolvedRoot) !== resolvedRoot) throwUnavailable();
  return resolvedRoot;
}

/**
 * Best-effort FileHandle close; never surfaces close failures.
 * @param {import('node:fs/promises').FileHandle | null | undefined} fileHandle
 * @returns {Promise<void>}
 */
async function bestEffortClose(fileHandle) {
  if (!fileHandle || typeof fileHandle.close !== 'function') return;
  try {
    await fileHandle.close();
  } catch {
    // ignore
  }
}

/**
 * @typedef {{
 *   platform?: string,
 *   spawn?: typeof defaultSpawn,
 *   open?: typeof defaultOpen,
 *   lstat?: typeof defaultLstat,
 *   access?: typeof defaultAccess,
 *   geteuid?: (() => number) | null | undefined,
 *   ensureSafeRelativeDir?: typeof defaultEnsureSafeRelativeDir,
 * }} AuditIntegrityProcessLockDeps
 */

/**
 * @param {AuditIntegrityProcessLockDeps} [deps]
 * @param {{ platform?: string }} [options]
 */
function resolveRuntime(deps = {}, options = {}) {
  const platform =
    typeof options.platform === 'string'
      ? options.platform
      : typeof deps.platform === 'string'
        ? deps.platform
        : process.platform;
  const geteuid =
    deps.geteuid !== undefined
      ? deps.geteuid
      : typeof process.geteuid === 'function'
        ? () => process.geteuid()
        : null;
  return {
    platform,
    spawn: deps.spawn || defaultSpawn,
    open: deps.open || defaultOpen,
    lstat: deps.lstat || defaultLstat,
    access: deps.access || defaultAccess,
    geteuid,
    ensureSafeRelativeDir: deps.ensureSafeRelativeDir || defaultEnsureSafeRelativeDir,
  };
}

/**
 * Mandatory attribute gate: FileHandle.stat + lstat(canonical) must match.
 * regular; same dev+ino; nlink===1; mode exact 0o600; uid===euid when geteuid available.
 * @param {import('node:fs/promises').FileHandle} fileHandle
 * @param {string} canonicalAbs
 * @param {{ lstat: typeof defaultLstat, geteuid: (() => number) | null | undefined }} runtime
 * @returns {Promise<void>}
 */
async function assertLockFileAttributes(fileHandle, canonicalAbs, runtime) {
  let fdStat;
  let pathStat;
  try {
    fdStat = await fileHandle.stat();
    pathStat = await runtime.lstat(canonicalAbs);
  } catch {
    throwUnavailable();
  }

  if (!fdStat || !pathStat) throwUnavailable();
  if (typeof pathStat.isSymbolicLink === 'function' && pathStat.isSymbolicLink()) {
    throwUnavailable();
  }
  if (typeof fdStat.isFile !== 'function' || !fdStat.isFile()) throwUnavailable();
  if (typeof pathStat.isFile !== 'function' || !pathStat.isFile()) throwUnavailable();
  if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) throwUnavailable();
  if (fdStat.nlink !== 1 || pathStat.nlink !== 1) throwUnavailable();
  if ((fdStat.mode & 0o777) !== 0o600 || (pathStat.mode & 0o777) !== 0o600) {
    throwUnavailable();
  }
  if (typeof runtime.geteuid !== 'function') throwUnavailable();
  let euid;
  try {
    euid = runtime.geteuid();
  } catch {
    throwUnavailable();
  }
  if (fdStat.uid !== euid || pathStat.uid !== euid) throwUnavailable();
}

/**
 * Async lockf waiter: single-settle on error|exit; never double resolve/reject.
 * Success only when exit code is 0 and signal is null.
 * @param {typeof defaultSpawn} spawnImpl
 * @param {number} fd
 * @returns {Promise<void>}
 */
function waitForLockf(spawnImpl, fd) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const fail = () => settle(() => reject(unavailableError()));

    let child;
    try {
      child = spawnImpl(LOCKF_BINARY, [...LOCKF_ARGV], {
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore', fd],
        env: Object.create(null),
      });
    } catch {
      fail();
      return;
    }

    child.on('error', () => {
      fail();
    });
    child.on('exit', (code, signal) => {
      if (code === 0 && (signal === null || signal === undefined)) {
        settle(() => resolve());
        return;
      }
      fail();
    });
  });
}

/**
 * Acquire exclusive multi-process write lock for audit integrity under resolvedRoot.
 *
 * macOS only (default process.platform === 'darwin'; inject via options/deps for tests).
 * Opens permanent canonical file, PRE attribute gate, async lockf on fd 3, then
 * MANDATORY post-exit-0 attribute gate. Success returns a module-issued frozen
 * opaque handle; acquire does not close the FileHandle.
 *
 * @param {unknown} resolvedRoot absolute dataDir root (assertSafeDataRoot shape)
 * @param {{
 *   platform?: string,
 *   deps?: AuditIntegrityProcessLockDeps,
 * }} [options]
 * @returns {Promise<object>} frozen opaque handle
 */
export async function acquireAuditIntegrityProcessLock(resolvedRoot, options = {}) {
  const deps = options && typeof options === 'object' ? options.deps || {} : {};
  const runtime = resolveRuntime(deps, options || {});

  if (runtime.platform !== 'darwin') throwUnavailable();

  // Path-free root gate before any access/ensure/open/spawn (queue-aligned).
  const root = assertResolvedRoot(resolvedRoot);

  try {
    await runtime.access(LOCKF_BINARY, constants.X_OK);
  } catch {
    throwUnavailable();
  }

  let canonicalAbs;
  try {
    const auditDir = await runtime.ensureSafeRelativeDir(root, AUDIT_REL_DIR);
    // Consume audited absolute directory return; reject helper drift / inject mismatch.
    if (typeof auditDir !== 'string' || auditDir.length === 0) throwUnavailable();
    if (auditDir.includes('\0')) throwUnavailable();
    const expectedAuditDir = join(root, AUDIT_REL_DIR);
    if (auditDir !== expectedAuditDir) throwUnavailable();
    canonicalAbs = join(auditDir, LOCK_BASENAME);
    // Fixed public REL remains audit/integrity-write.lock under validated root.
    if (canonicalAbs !== join(root, AUDIT_INTEGRITY_PROCESS_LOCK_REL)) throwUnavailable();
  } catch (error) {
    if (error instanceof AuditIntegrityProcessLockError) throw error;
    throwUnavailable();
  }

  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let fileHandle;
  try {
    fileHandle = await runtime.open(canonicalAbs, OPEN_FLAGS, OPEN_MODE);
  } catch (error) {
    if (error instanceof AuditIntegrityProcessLockError) throw error;
    throwUnavailable();
  }

  try {
    // PRE-lockf attribute gate.
    await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);

    // Async lockf fd form only — must not block the service event loop.
    await waitForLockf(runtime.spawn, fileHandle.fd);

    // MANDATORY post-exit-0 revalidation on same open handle + path.
    await assertLockFileAttributes(fileHandle, canonicalAbs, runtime);
  } catch (error) {
    await bestEffortClose(fileHandle);
    if (error instanceof AuditIntegrityProcessLockError) throw error;
    throwUnavailable();
  }

  const handle = Object.freeze(Object.create(null));
  activeProcessLockHandles.set(handle, {
    resolvedRoot: root,
    fileHandle,
  });
  activeProcessLockHandleSet.add(handle);
  return handle;
}

/**
 * Release a module-issued active process lock handle by closing its FileHandle.
 *
 * Kernel drops BSD flock when last OFD reference closes. Never unlinks/renames/
 * truncates/chmods the lock file. Double/forged handles fail closed. Close failure
 * still throws the fixed registered error (failure wins) after terminating identity.
 *
 * @param {unknown} handle module-issued opaque handle from acquire
 * @returns {Promise<void>}
 */
export async function releaseAuditIntegrityProcessLock(handle) {
  if (handle === null || handle === undefined) throwUnavailable();
  if (typeof handle !== 'object' && typeof handle !== 'function') throwUnavailable();

  const obj = /** @type {object} */ (handle);
  if (!activeProcessLockHandleSet.has(obj)) throwUnavailable();
  const meta = activeProcessLockHandles.get(obj);
  if (meta === undefined) throwUnavailable();

  // Terminate identity first so double-release cannot close twice.
  activeProcessLockHandleSet.delete(obj);
  activeProcessLockHandles.delete(obj);

  try {
    await meta.fileHandle.close();
  } catch {
    throwUnavailable();
  }
}
