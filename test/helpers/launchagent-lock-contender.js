/**
 * Bounded real-process lock-contender helper (Linke V1.46 Task 6B.0 Task 4).
 *
 * Modes (exact argv, parent never supplies claimId):
 *   owner-crash  <metadataRoot> <transactionId> <txNonce> <mirNonce>
 *   contend      <metadataRoot> <transactionId> <ownerNonce> <expectedTxRefBase64> <mirRefBase64>
 *   claim-crash  <metadataRoot> <transactionId> <ownerNonce> <expectedTxRefBase64> <mirRefBase64>
 *
 * Emits exactly one UTF-8 JSON result line on fd 1; never writes stderr or paths.
 * Uses real production process-identity reader and metadata-store recovery primitives.
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants, writeSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  LaunchAgentLifecycleError,
  LAUNCHAGENT_LIFECYCLE_CODES,
} from '../../src/launchagent-lifecycle/contracts.js';
import {
  createLaunchAgentMetadataStore,
  createLaunchAgentMetadataStoreForTest,
} from '../../src/launchagent-lifecycle/metadata-store.js';
import { createLaunchAgentProcessIdentityReader } from '../../src/launchagent-lifecycle/process-identity.js';

const TX_LEAF = 'transaction.lock';
const ROOT_PREFIX = 'linke-la-realproc-';
const DIR_MODE = 0o700;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const FRESH_TX_OPEN_FLAGS =
  fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_WRONLY
  | fsConstants.O_NOFOLLOW;

/** @type {boolean} */
let settled = false;

function failClosedSilent() {
  try {
    if (typeof process.disconnect === 'function' && process.connected) {
      process.disconnect();
    }
  } catch {
    // ignore disconnect races
  }
  process.exit(1);
}

/**
 * Exactly one flush-safe JSON result line; then disconnect IPC and exit 0.
 * @param {{
 *   status: string,
 *   claimId: string | null,
 *   transactionLockRef: object | null,
 *   manualInterventionLockRef: object | null,
 *   observationStatuses: string[],
 *   transactionMutationCount: number,
 * }} payload
 */
function emitResult(payload) {
  if (settled) {
    process.exit(0);
    return;
  }
  settled = true;
  const line = JSON.stringify({
    status: payload.status,
    claimId: payload.claimId,
    transactionLockRef: payload.transactionLockRef,
    manualInterventionLockRef: payload.manualInterventionLockRef,
    observationStatuses: payload.observationStatuses,
    transactionMutationCount: payload.transactionMutationCount,
  });
  writeSync(1, `${line}\n`);
  try {
    if (typeof process.disconnect === 'function' && process.connected) {
      process.disconnect();
    }
  } catch {
    // ignore disconnect races
  }
  process.exit(0);
}

function requireUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function requireSha256(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function lockRefsEqual(left, right) {
  return (
    left !== null
    && right !== null
    && typeof left === 'object'
    && typeof right === 'object'
    && left.kind === right.kind
    && left.transactionId === right.transactionId
    && left.ownerNonce === right.ownerNonce
    && left.sha256 === right.sha256
  );
}

/**
 * Decode canonical base64 JSON lock ref: exact keys kind,transactionId,ownerNonce,sha256.
 * @param {string} encoded
 * @param {string} expectedKind
 * @returns {object | null}
 */
function decodeLockRefBase64(encoded, expectedKind) {
  if (typeof encoded !== 'string' || encoded.length === 0) return null;
  let parsed;
  try {
    const text = Buffer.from(encoded, 'base64').toString('utf8');
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  if (Object.getPrototypeOf(parsed) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(parsed).filter((k) => typeof k === 'string');
  if (
    keys.length !== 4
    || keys[0] !== 'kind'
    || keys[1] !== 'transactionId'
    || keys[2] !== 'ownerNonce'
    || keys[3] !== 'sha256'
  ) {
    return null;
  }
  if (parsed.kind !== expectedKind) return null;
  if (!requireUuid(parsed.transactionId)) return null;
  if (!requireUuid(parsed.ownerNonce)) return null;
  if (parsed.transactionId === parsed.ownerNonce) return null;
  if (!requireSha256(parsed.sha256)) return null;
  return {
    kind: parsed.kind,
    transactionId: parsed.transactionId,
    ownerNonce: parsed.ownerNonce,
    sha256: parsed.sha256,
  };
}

function isReadOnlyOpenFlags(flags) {
  if (typeof flags !== 'number') {
    return flags === 'r' || flags === 'rs' || flags === 'sr';
  }
  const creat = fsConstants.O_CREAT;
  const wronly = fsConstants.O_WRONLY;
  const rdwr = fsConstants.O_RDWR;
  const append = fsConstants.O_APPEND;
  const trunc = fsConstants.O_TRUNC;
  if ((flags & creat) === creat) return false;
  if ((flags & wronly) === wronly) return false;
  if ((flags & rdwr) === rdwr) return false;
  if ((flags & append) === append) return false;
  if ((flags & trunc) === trunc) return false;
  return true;
}

function isExactFreshTxOpenFlags(flags) {
  return typeof flags === 'number' && flags === FRESH_TX_OPEN_FLAGS;
}

/**
 * Reject roots outside the parent-created temporary contract (no path in errors).
 * @param {string} metadataRoot
 */
async function assertRootBoundary(metadataRoot) {
  if (typeof metadataRoot !== 'string' || metadataRoot.length === 0) {
    failClosedSilent();
  }
  if (!isAbsolute(metadataRoot)) failClosedSilent();
  if (resolve(metadataRoot) !== metadataRoot) failClosedSilent();
  if (basename(metadataRoot) !== 'metadata') failClosedSilent();

  const parent = dirname(metadataRoot);
  if (!basename(parent).startsWith(ROOT_PREFIX)) failClosedSilent();

  let parentStat;
  try {
    parentStat = await fsPromises.lstat(parent);
  } catch {
    failClosedSilent();
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) failClosedSilent();
  if ((parentStat.mode & 0o777) !== DIR_MODE) failClosedSilent();
  if (parentStat.uid !== process.getuid()) failClosedSilent();

  let realTmp;
  let realParent;
  try {
    realTmp = await fsPromises.realpath(tmpdir());
    realParent = await fsPromises.realpath(parent);
  } catch {
    failClosedSilent();
  }
  if (dirname(realParent) !== realTmp) failClosedSilent();

  let metaStat;
  try {
    metaStat = await fsPromises.lstat(metadataRoot);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    failClosedSilent();
  }
  if (metaStat.isSymbolicLink() || !metaStat.isDirectory()) failClosedSilent();
  if ((metaStat.mode & 0o777) !== DIR_MODE) failClosedSilent();
  if (metaStat.uid !== process.getuid()) failClosedSilent();

  let realMeta;
  try {
    realMeta = await fsPromises.realpath(metadataRoot);
  } catch {
    failClosedSilent();
  }
  if (realMeta !== join(realParent, 'metadata')) failClosedSilent();
}

/**
 * Child-local fs wrapper: instrument only exact metadataRoot/transaction.lock path.
 * @param {string} metadataRoot
 * @param {{
 *   claimVerified: boolean,
 *   claimDurablyOwned: boolean,
 *   transactionMutationCount: number,
 *   resumePromise: Promise<void>,
 *   resumeWaitStarted: boolean,
 * }} state
 */
function createInstrumentedFs(metadataRoot, state) {
  const txPath = join(metadataRoot, TX_LEAF);

  function isTxPath(pathLike) {
    return typeof pathLike === 'string' && pathLike === txPath;
  }

  function failClosedMutation() {
    throw new LaunchAgentLifecycleError(LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
  }

  async function pauseBeforeFirstPostClaimOpen() {
    if (!state.claimVerified) return;
    if (state.resumeWaitStarted) return;
    state.resumeWaitStarted = true;
    await state.resumePromise;
  }

  /**
   * @param {string} prop
   * @returns {(pathLike: unknown, ...rest: unknown[]) => Promise<unknown>}
   */
  function blockedTxMutation(prop) {
    return async (pathLike, ...rest) => {
      if (isTxPath(pathLike)) failClosedMutation();
      // @ts-expect-error dynamic real fs method
      return fsPromises[prop](pathLike, ...rest);
    };
  }

  return new Proxy(fsPromises, {
    get(target, property, receiver) {
      if (property === 'open') {
        return async (pathLike, flags, mode) => {
          if (isTxPath(pathLike)) {
            await pauseBeforeFirstPostClaimOpen();
            if (isReadOnlyOpenFlags(flags)) {
              return target.open(pathLike, flags, mode);
            }
            if (isExactFreshTxOpenFlags(flags)) {
              if (!state.claimVerified) failClosedMutation();
              state.transactionMutationCount += 1;
              return target.open(pathLike, flags, mode);
            }
            failClosedMutation();
          }
          return target.open(pathLike, flags, mode);
        };
      }
      if (property === 'unlink') {
        return async (pathLike) => {
          if (isTxPath(pathLike)) {
            if (!state.claimVerified) failClosedMutation();
            state.transactionMutationCount += 1;
            return target.unlink(pathLike);
          }
          return target.unlink(pathLike);
        };
      }
      if (
        property === 'rename'
        || property === 'writeFile'
        || property === 'appendFile'
        || property === 'truncate'
        || property === 'copyFile'
        || property === 'rm'
      ) {
        if (property === 'rename' || property === 'copyFile') {
          return async (src, dest, ...rest) => {
            if (isTxPath(src) || isTxPath(dest)) failClosedMutation();
            return target[property](src, dest, ...rest);
          };
        }
        return blockedTxMutation(String(property));
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
  });
}

/**
 * @param {object} identity
 * @returns {{ available: true, value: string } | null}
 */
function projectAvailableIdentity(identity) {
  if (
    identity === null
    || typeof identity !== 'object'
    || identity.available !== true
    || typeof identity.value !== 'string'
    || identity.value.length === 0
  ) {
    return null;
  }
  return { available: true, value: identity.value };
}

async function runOwnerCrash(metadataRoot, transactionId, txNonce, mirNonce) {
  const reader = createLaunchAgentProcessIdentityReader();
  const current = await reader.current();
  const boot = projectAvailableIdentity(current.bootSessionIdentity);
  const proc = projectAvailableIdentity(current.processStartIdentity);
  if (boot === null || proc === null) {
    emitResult({
      status: 'unavailable',
      claimId: null,
      transactionLockRef: null,
      manualInterventionLockRef: null,
      observationStatuses: [],
      transactionMutationCount: 0,
    });
    return;
  }

  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const lockBase = {
    schemaVersion: 1,
    transactionId,
    ownerPid: process.pid,
    bootSessionIdentity: boot,
    processStartIdentity: proc,
  };

  const transactionLockRef = await store.acquireTransactionLock({
    ...lockBase,
    ownerNonce: txNonce,
  });
  const manualInterventionLockRef = await store.acquireManualInterventionLock({
    ...lockBase,
    ownerNonce: mirNonce,
  });

  emitResult({
    status: 'owner-crashed',
    claimId: null,
    transactionLockRef,
    manualInterventionLockRef,
    observationStatuses: [],
    transactionMutationCount: 0,
  });
}

/**
 * @param {'contend' | 'claim-crash'} mode
 * @param {string} metadataRoot
 * @param {string} transactionId
 * @param {string} ownerNonce
 * @param {object} expectedTxRef
 * @param {object} mirRef
 */
async function runRecoveryMode(mode, metadataRoot, transactionId, ownerNonce, expectedTxRef, mirRef) {
  /** @type {{ resolve: (() => void) | null, reject: ((err: Error) => void) | null }} */
  const resumeControl = { resolve: null, reject: null };
  const resumePromise = new Promise((resolveResume, rejectResume) => {
    resumeControl.resolve = resolveResume;
    resumeControl.reject = rejectResume;
  });

  const state = {
    claimVerified: false,
    claimDurablyOwned: false,
    transactionMutationCount: 0,
    resumePromise,
    resumeWaitStarted: false,
    claimHeldSent: false,
    resumeReceived: false,
    generatedClaimId: /** @type {string | null} */ (null),
  };

  if (mode === 'contend') {
    process.on('message', (message) => {
      if (settled) return;
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        failClosedSilent();
        return;
      }
      const keys = Reflect.ownKeys(message).filter((k) => typeof k === 'string');
      if (
        keys.length !== 1
        || keys[0] !== 'command'
        || /** @type {{ command?: unknown }} */ (message).command !== 'resume'
      ) {
        failClosedSilent();
        return;
      }
      if (!state.claimHeldSent || state.resumeReceived) {
        failClosedSilent();
        return;
      }
      state.resumeReceived = true;
      if (typeof resumeControl.resolve === 'function') {
        resumeControl.resolve();
      }
    });
  } else {
    process.on('message', () => {
      if (!settled) failClosedSilent();
    });
  }

  const instrumentedFs = createInstrumentedFs(metadataRoot, state);

  /**
   * @param {object} event
   */
  function onDurabilityEvent(event) {
    if (settled) return;
    if (
      event === null
      || typeof event !== 'object'
      || event.kind !== 'verify'
      || event.artifact !== 'recovery-claim-lock'
    ) {
      return;
    }

    state.claimVerified = true;
    state.claimDurablyOwned = true;

    if (mode === 'claim-crash') {
      emitResult({
        status: 'claim-durable-crash',
        claimId: state.generatedClaimId,
        transactionLockRef: expectedTxRef,
        manualInterventionLockRef: mirRef,
        observationStatuses: ['dead', 'dead'],
        transactionMutationCount: 0,
      });
      return;
    }

    // contend winner only: exact claim-held IPC once; pause is on first post-claim tx open.
    if (!state.claimHeldSent) {
      state.claimHeldSent = true;
      try {
        if (typeof process.send === 'function') {
          process.send({ event: 'claim-held' });
        } else {
          failClosedSilent();
        }
      } catch {
        failClosedSilent();
      }
    }
  }

  const store = createLaunchAgentMetadataStoreForTest({
    metadataRoot,
    fs: instrumentedFs,
    onDurabilityEvent,
  });
  await store.initialize();

  const reader = createLaunchAgentProcessIdentityReader();

  let txObs;
  try {
    txObs = await store.readTransactionLockObservation();
  } catch (error) {
    const status =
      error instanceof LaunchAgentLifecycleError
        ? error.code
        : LAUNCHAGENT_LIFECYCLE_CODES.INVALID;
    emitResult({
      status,
      claimId: null,
      transactionLockRef: expectedTxRef,
      manualInterventionLockRef: mirRef,
      observationStatuses: [],
      transactionMutationCount: state.transactionMutationCount,
    });
    return;
  }

  if (txObs === null || !lockRefsEqual(txObs.ref, expectedTxRef)) {
    emitResult({
      status: LAUNCHAGENT_LIFECYCLE_CODES.INVALID,
      claimId: null,
      transactionLockRef: expectedTxRef,
      manualInterventionLockRef: mirRef,
      observationStatuses: [],
      transactionMutationCount: 0,
    });
    return;
  }

  /** @type {string[]} */
  const observationStatuses = [];
  const first = await reader.observe(txObs.record);
  observationStatuses.push(first.status);
  if (first.status !== 'dead') {
    emitResult({
      status: first.status,
      claimId: null,
      transactionLockRef: expectedTxRef,
      manualInterventionLockRef: mirRef,
      observationStatuses,
      transactionMutationCount: 0,
    });
    return;
  }

  const second = await reader.observe(txObs.record);
  observationStatuses.push(second.status);
  if (second.status !== 'dead') {
    emitResult({
      status: second.status,
      claimId: null,
      transactionLockRef: expectedTxRef,
      manualInterventionLockRef: mirRef,
      observationStatuses,
      transactionMutationCount: 0,
    });
    return;
  }

  const current = await reader.current();
  const boot = projectAvailableIdentity(current.bootSessionIdentity);
  const proc = projectAvailableIdentity(current.processStartIdentity);
  if (boot === null || proc === null) {
    emitResult({
      status: 'unavailable',
      claimId: null,
      transactionLockRef: expectedTxRef,
      manualInterventionLockRef: mirRef,
      observationStatuses,
      transactionMutationCount: 0,
    });
    return;
  }

  const claimId = randomUUID();
  state.generatedClaimId = claimId;
  if (claimId === transactionId || claimId === ownerNonce) {
    emitResult({
      status: LAUNCHAGENT_LIFECYCLE_CODES.INVALID,
      claimId: null,
      transactionLockRef: expectedTxRef,
      manualInterventionLockRef: mirRef,
      observationStatuses,
      transactionMutationCount: 0,
    });
    return;
  }

  const freshRecord = {
    schemaVersion: 1,
    transactionId,
    ownerPid: process.pid,
    ownerNonce,
    bootSessionIdentity: boot,
    processStartIdentity: proc,
  };

  try {
    const freshTxRef = await store.acquireRecoveryLockForManualRepair({
      record: freshRecord,
      claimId,
      expectedTransactionLockRef: expectedTxRef,
      manualInterventionLockRef: mirRef,
    });

    // Normal contend winner success: claim released; claimId null.
    emitResult({
      status: 'acquired',
      claimId: null,
      transactionLockRef: freshTxRef,
      manualInterventionLockRef: mirRef,
      observationStatuses,
      transactionMutationCount: state.transactionMutationCount,
    });
  } catch (error) {
    if (settled) {
      process.exit(0);
      return;
    }

    const code =
      error instanceof LaunchAgentLifecycleError
        ? error.code
        : LAUNCHAGENT_LIFECYCLE_CODES.INVALID;

    if (state.claimDurablyOwned) {
      // Post-claim failure: preserve generated claimId; zero child mutations expected on drift.
      let currentTxRef = null;
      try {
        const latest = await store.readTransactionLockObservation();
        if (latest !== null && latest.ref) {
          currentTxRef = latest.ref;
        }
      } catch {
        currentTxRef = null;
      }
      emitResult({
        status: code,
        claimId,
        transactionLockRef: currentTxRef,
        manualInterventionLockRef: mirRef,
        observationStatuses,
        transactionMutationCount: state.transactionMutationCount,
      });
      return;
    }

    // Pre-claim closed errors (O_EXCL loser, invalid, etc.): claimId null.
    emitResult({
      status: code,
      claimId: null,
      transactionLockRef: expectedTxRef,
      manualInterventionLockRef: mirRef,
      observationStatuses,
      transactionMutationCount: state.transactionMutationCount,
    });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) failClosedSilent();

  const mode = argv[0];
  if (mode === 'owner-crash') {
    if (argv.length !== 5) failClosedSilent();
    const metadataRoot = argv[1];
    const transactionId = argv[2];
    const txNonce = argv[3];
    const mirNonce = argv[4];
    if (!requireUuid(transactionId) || !requireUuid(txNonce) || !requireUuid(mirNonce)) {
      failClosedSilent();
    }
    if (transactionId === txNonce || transactionId === mirNonce || txNonce === mirNonce) {
      failClosedSilent();
    }
    await assertRootBoundary(metadataRoot);
    try {
      await runOwnerCrash(metadataRoot, transactionId, txNonce, mirNonce);
    } catch (error) {
      if (settled) process.exit(0);
      const status =
        error instanceof LaunchAgentLifecycleError
          ? error.code
          : LAUNCHAGENT_LIFECYCLE_CODES.INVALID;
      emitResult({
        status,
        claimId: null,
        transactionLockRef: null,
        manualInterventionLockRef: null,
        observationStatuses: [],
        transactionMutationCount: 0,
      });
    }
    return;
  }

  if (mode === 'contend' || mode === 'claim-crash') {
    if (argv.length !== 6) failClosedSilent();
    const metadataRoot = argv[1];
    const transactionId = argv[2];
    const ownerNonce = argv[3];
    const expectedTxRef = decodeLockRefBase64(argv[4], 'transaction-lock');
    const mirRef = decodeLockRefBase64(argv[5], 'manual-intervention-lock');
    if (!requireUuid(transactionId) || !requireUuid(ownerNonce)) failClosedSilent();
    if (transactionId === ownerNonce) failClosedSilent();
    if (expectedTxRef === null || mirRef === null) failClosedSilent();
    if (expectedTxRef.transactionId !== transactionId) failClosedSilent();
    if (mirRef.transactionId !== transactionId) failClosedSilent();
    await assertRootBoundary(metadataRoot);
    try {
      await runRecoveryMode(
        mode,
        metadataRoot,
        transactionId,
        ownerNonce,
        expectedTxRef,
        mirRef,
      );
    } catch (error) {
      if (settled) process.exit(0);
      const status =
        error instanceof LaunchAgentLifecycleError
          ? error.code
          : LAUNCHAGENT_LIFECYCLE_CODES.INVALID;
      emitResult({
        status,
        claimId: null,
        transactionLockRef: expectedTxRef,
        manualInterventionLockRef: mirRef,
        observationStatuses: [],
        transactionMutationCount: 0,
      });
    }
    return;
  }

  failClosedSilent();
}

main().catch(() => {
  if (!settled) failClosedSilent();
});
