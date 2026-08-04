/**
 * Bounded real-process lock-contender helper (Linke V1.46 Task 6B.0 Task 4 + 6B.2 Task 5).
 *
 * Modes (exact argv, parent never supplies claimId):
 *   owner-crash  <metadataRoot> <transactionId> <txNonce> <mirNonce>
 *   contend      <metadataRoot> <transactionId> <ownerNonce> <expectedTxRefBase64> <mirRefBase64>
 *   claim-crash  <metadataRoot> <transactionId> <ownerNonce> <expectedTxRefBase64> <mirRefBase64>
 *   manual-repair-crash-owner <fixturePath> <crashImagePath>
 *   manual-repair-recover     <crashImagePath> <resultPath>
 *
 * Existing three modes: exactly one UTF-8 JSON result line on fd 1; never writes stderr or paths.
 * Task 5 owner emits exactly one READY_TO_KILL line then hangs; recovery writes result file only.
 * Uses real production process-identity reader and metadata-store recovery primitives.
 */

// Clear color-env conflict before any dependency import (Node may warn on stderr otherwise).
delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, writeSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

// Heavy modules loaded after env sanitize via dynamic import (see loadDeps).
// Module-level bindings assigned once before any mode runs.
/** @type {typeof import('../../src/launchagent-lifecycle/contracts.js').LaunchAgentLifecycleError} */
let LaunchAgentLifecycleError;
/** @type {typeof import('../../src/launchagent-lifecycle/contracts.js').LAUNCHAGENT_LIFECYCLE_CODES} */
let LAUNCHAGENT_LIFECYCLE_CODES;
/** @type {typeof import('../../src/launchagent-lifecycle/contracts.js').validateLaunchAgentAcceptanceRequest} */
let validateLaunchAgentAcceptanceRequest;
/** @type {typeof import('../../src/launchagent-lifecycle/contracts.js').validateLaunchAgentConfirmationRecord} */
let validateLaunchAgentConfirmationRecord;
/** @type {typeof import('../../src/launchagent-lifecycle/contracts.js').validateLaunchAgentConsumedConfirmation} */
let validateLaunchAgentConsumedConfirmation;
/** @type {typeof import('../../src/launchagent-lifecycle/contracts.js').validateLaunchAgentJournal} */
let validateLaunchAgentJournal;
/** @type {typeof import('../../src/launchagent-lifecycle/contracts.js').validateLaunchAgentReceipt} */
let validateLaunchAgentReceipt;
/** @type {typeof import('../../src/launchagent-lifecycle/acceptance-gate.js').consumeAndAuthorizeManualRepair} */
let consumeAndAuthorizeManualRepair;
/** @type {typeof import('../../src/launchagent-lifecycle/metadata-store.js').createLaunchAgentMetadataStore} */
let createLaunchAgentMetadataStore;
/** @type {typeof import('../../src/launchagent-lifecycle/metadata-store.js').createLaunchAgentMetadataStoreForTest} */
let createLaunchAgentMetadataStoreForTest;
/** @type {typeof import('../../src/launchagent-lifecycle/process-identity.js').createLaunchAgentProcessIdentityReader} */
let createLaunchAgentProcessIdentityReader;
/** @type {typeof import('../../src/launchagent-lifecycle/transaction-coordinator.js').createLaunchAgentLifecycleCoordinator} */
let createLaunchAgentLifecycleCoordinator;
/** @type {typeof import('./launchagent-lifecycle-harness.js').createLaunchAgentLifecycleHarness} */
let createLaunchAgentLifecycleHarness;
/** @type {typeof import('./launchagent-lifecycle-harness.js').serializeLaunchAgentLifecycleCrashImageForTest} */
let serializeLaunchAgentLifecycleCrashImageForTest;
/** @type {typeof import('./launchagent-lifecycle-harness.js').reviveLaunchAgentLifecycleCrashImageForTest} */
let reviveLaunchAgentLifecycleCrashImageForTest;
let depsLoaded = false;

async function loadDeps() {
  if (depsLoaded) return;
  const contracts = await import('../../src/launchagent-lifecycle/contracts.js');
  const acceptance = await import('../../src/launchagent-lifecycle/acceptance-gate.js');
  const metadata = await import('../../src/launchagent-lifecycle/metadata-store.js');
  const processIdentity = await import('../../src/launchagent-lifecycle/process-identity.js');
  const coordinator = await import('../../src/launchagent-lifecycle/transaction-coordinator.js');
  const harness = await import('./launchagent-lifecycle-harness.js');
  LaunchAgentLifecycleError = contracts.LaunchAgentLifecycleError;
  LAUNCHAGENT_LIFECYCLE_CODES = contracts.LAUNCHAGENT_LIFECYCLE_CODES;
  validateLaunchAgentAcceptanceRequest = contracts.validateLaunchAgentAcceptanceRequest;
  validateLaunchAgentConfirmationRecord = contracts.validateLaunchAgentConfirmationRecord;
  validateLaunchAgentConsumedConfirmation = contracts.validateLaunchAgentConsumedConfirmation;
  validateLaunchAgentJournal = contracts.validateLaunchAgentJournal;
  validateLaunchAgentReceipt = contracts.validateLaunchAgentReceipt;
  consumeAndAuthorizeManualRepair = acceptance.consumeAndAuthorizeManualRepair;
  createLaunchAgentMetadataStore = metadata.createLaunchAgentMetadataStore;
  createLaunchAgentMetadataStoreForTest = metadata.createLaunchAgentMetadataStoreForTest;
  createLaunchAgentProcessIdentityReader = processIdentity.createLaunchAgentProcessIdentityReader;
  createLaunchAgentLifecycleCoordinator = coordinator.createLaunchAgentLifecycleCoordinator;
  createLaunchAgentLifecycleHarness = harness.createLaunchAgentLifecycleHarness;
  serializeLaunchAgentLifecycleCrashImageForTest =
    harness.serializeLaunchAgentLifecycleCrashImageForTest;
  reviveLaunchAgentLifecycleCrashImageForTest =
    harness.reviveLaunchAgentLifecycleCrashImageForTest;
  depsLoaded = true;
}
const TX_LEAF = 'transaction.lock';
const ROOT_PREFIX = 'linke-la-realproc-';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_FIXTURE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_CRASH_IMAGE_BYTES = 4 * 1024 * 1024;
const TS_FROZEN_MIR = '2026-08-02T13:00:00.000Z';
const TS_PREPARED = '2026-08-02T10:00:00.000Z';
const TS_CONFIRMED = '2026-08-02T10:05:00.000Z';
// Must be <= harness CLOCK_BASE (2026-07-30) so attestedAt >= authorizedAt.
const TS_CAPABILITY_AUTHORIZED = '2026-07-29T12:00:00.000Z';
const SHA_REPAIR = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const SHA_CONSUMED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const FROZEN_PLAN_ACTION_ORDER = Object.freeze({
  install: Object.freeze([
    'stop-scheduler',
    'stop-controller',
    'remove-manifest',
    'remove-scheduler',
    'remove-controller',
  ]),
  'managed-upgrade': Object.freeze([
    'stop-scheduler',
    'stop-controller',
    'restore-manifest',
    'restore-scheduler',
    'restore-controller',
    'load-controller',
    'load-scheduler',
  ]),
});

const FIXTURE_KEYS = Object.freeze([
  'schemaVersion',
  'operation',
  'action',
  'position',
  'sourceCommit',
  'scheduleSeconds',
  'claimId',
  'freshOwnerNonce',
  'confirmationId',
  'requestId',
  'mirNonce',
]);

const RESULT_KEYS = Object.freeze([
  'status',
  'transactionId',
  'terminalJournalState',
  'receiptCount',
  'receiptValid',
  'transactionLockPresent',
  'manualInterventionLockPresent',
  'recoveryClaimPresent',
  'selectedFakeHostActionCount',
  'ownerObservationStatuses',
]);

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

/**
 * Shared temp-root boundary for Task 5 file paths (absolute, under realproc prefix).
 * @param {string} absPath
 * @returns {Promise<string>} real parent temp root
 */
async function assertTempRootFilePath(absPath) {
  if (typeof absPath !== 'string' || absPath.length === 0) failClosedSilent();
  if (!isAbsolute(absPath)) failClosedSilent();
  const normalized = resolve(absPath);
  if (normalized !== absPath) failClosedSilent();
  if (absPath.includes('\0')) failClosedSilent();

  const parent = dirname(normalized);
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

  const leaf = basename(normalized);
  if (leaf.length === 0 || leaf === '.' || leaf === '..') failClosedSilent();
  if (leaf.includes('/') || leaf.includes('\\')) failClosedSilent();
  return realParent;
}

async function atomicWriteBounded(targetPath, bytes, maxBytes) {
  if (!Buffer.isBuffer(bytes)) failClosedSilent();
  if (bytes.length === 0 || bytes.length > maxBytes) failClosedSilent();
  const parent = dirname(targetPath);
  const tmpName = `.${basename(targetPath)}.${process.pid}.tmp`;
  const tmpPath = join(parent, tmpName);
  let handle;
  try {
    handle = await fsPromises.open(
      tmpPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      FILE_MODE,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(tmpPath, targetPath);
    await fsPromises.chmod(targetPath, FILE_MODE);
  } catch {
    try {
      if (handle) await handle.close();
    } catch {
      // ignore
    }
    try {
      await fsPromises.unlink(tmpPath);
    } catch {
      // ignore
    }
    failClosedSilent();
  }
}

/**
 * Read bounded file; reject symlinks and oversize.
 * @param {string} absPath
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBoundedFile(absPath, maxBytes) {
  let stat;
  try {
    stat = await fsPromises.lstat(absPath);
  } catch {
    failClosedSilent();
  }
  if (stat.isSymbolicLink() || !stat.isFile()) failClosedSilent();
  if (stat.size <= 0 || stat.size > maxBytes) failClosedSilent();
  if ((stat.mode & 0o777) !== FILE_MODE && (stat.mode & 0o777) !== 0o600) {
    // Accept 0600 only (private).
    if ((stat.mode & 0o077) !== 0) failClosedSilent();
  }
  let bytes;
  try {
    bytes = await fsPromises.readFile(absPath);
  } catch {
    failClosedSilent();
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== stat.size) failClosedSilent();
  if (bytes.length > maxBytes) failClosedSilent();
  return bytes;
}

function readExactPlainObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((k) => typeof k !== 'string')) {
    return null;
  }
  for (let i = 0; i < expectedKeys.length; i += 1) {
    if (ownKeys[i] !== expectedKeys[i]) return null;
  }
  const fields = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function frozenJournalEntrySha256(entry) {
  return createHash('sha256').update(Buffer.from(JSON.stringify({
    schemaVersion: entry.schemaVersion,
    transactionId: entry.transactionId,
    sequence: entry.sequence,
    previousEntrySha256: entry.previousEntrySha256,
    operation: entry.operation,
    state: entry.state,
    at: entry.at,
    payload: entry.payload,
  }), 'utf8')).digest('hex');
}

function parseFixtureEnvelope(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    return null;
  }
  const fields = readExactPlainObject(parsed, FIXTURE_KEYS);
  if (fields === null) return null;
  if (fields.schemaVersion !== 1) return null;
  if (fields.operation !== 'install' && fields.operation !== 'managed-upgrade') return null;
  if (typeof fields.action !== 'string' || fields.action.length === 0) return null;
  if (fields.position !== 'after-intent-pre') return null;
  if (typeof fields.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(fields.sourceCommit)) {
    return null;
  }
  if (!Number.isSafeInteger(fields.scheduleSeconds) || fields.scheduleSeconds <= 0) return null;
  for (const key of ['claimId', 'freshOwnerNonce', 'confirmationId', 'requestId', 'mirNonce']) {
    if (!requireUuid(fields[key])) return null;
  }
  const ids = [
    fields.claimId,
    fields.freshOwnerNonce,
    fields.confirmationId,
    fields.requestId,
    fields.mirNonce,
  ];
  if (new Set(ids).size !== ids.length) return null;
  const planOrder = FROZEN_PLAN_ACTION_ORDER[fields.operation];
  if (!planOrder || !planOrder.includes(fields.action)) return null;
  // Final remaining action only — recovery has no further host mutations.
  if (fields.action !== planOrder[planOrder.length - 1]) return null;
  return {
    schemaVersion: 1,
    operation: fields.operation,
    action: fields.action,
    position: fields.position,
    sourceCommit: fields.sourceCommit,
    scheduleSeconds: fields.scheduleSeconds,
    claimId: fields.claimId,
    freshOwnerNonce: fields.freshOwnerNonce,
    confirmationId: fields.confirmationId,
    requestId: fields.requestId,
    mirNonce: fields.mirNonce,
  };
}

async function mintLocalManualRepairCapability(facts) {
  const request = validateLaunchAgentAcceptanceRequest({
    schemaVersion: 1,
    kind: 'manual-repair-request',
    manualRepairRequestId: facts.requestId,
    mirTransactionId: facts.mirTransactionId,
    mirLockIdentitySha256: facts.mirLockRef.sha256,
    anchorId: facts.anchorId,
    repairDeclarationSha256: SHA_REPAIR,
    executeRequested: false,
    manualRepairConfirmed: false,
    preparedAt: TS_PREPARED,
  });
  const confirmation = validateLaunchAgentConfirmationRecord({
    schemaVersion: 1,
    kind: 'manual-repair-confirmation',
    confirmationId: facts.confirmationId,
    manualRepairRequestId: facts.requestId,
    confirmed: true,
    confirmedAt: TS_CONFIRMED,
  });
  const durable = new Map();
  const store = Object.freeze({
    async consumeConfirmation(record) {
      const projection = validateLaunchAgentConsumedConfirmation(record);
      if (durable.has(projection.confirmationId)) {
        throw new LaunchAgentLifecycleError(LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED);
      }
      durable.set(projection.confirmationId, Object.freeze({ ...projection }));
      return Object.freeze({
        kind: 'consumed-confirmation',
        confirmationId: projection.confirmationId,
        sha256: SHA_CONSUMED,
      });
    },
    async readConsumedConfirmation(id) {
      const stored = durable.get(id);
      if (stored === undefined) throw new LaunchAgentLifecycleError();
      return validateLaunchAgentConsumedConfirmation({ ...stored });
    },
  });
  const clock = Object.freeze({ now() { return TS_CAPABILITY_AUTHORIZED; } });
  function readCurrentFacts() {
    return {
      mirTransactionId: facts.mirTransactionId,
      mirLockRef: {
        kind: facts.mirLockRef.kind,
        transactionId: facts.mirLockRef.transactionId,
        ownerNonce: facts.mirLockRef.ownerNonce,
        sha256: facts.mirLockRef.sha256,
      },
      transactionLockRef: facts.transactionLockRef === null
        ? null
        : {
          kind: facts.transactionLockRef.kind,
          transactionId: facts.transactionLockRef.transactionId,
          ownerNonce: facts.transactionLockRef.ownerNonce,
          sha256: facts.transactionLockRef.sha256,
        },
      anchorId: facts.anchorId,
      repairDeclarationSha256: SHA_REPAIR,
    };
  }
  return consumeAndAuthorizeManualRepair({
    request,
    confirmation,
    metadataStore: store,
    readCurrentFacts,
    clock,
  });
}

/**
 * Exact frozen {current,observe} wrapper over the real production identity reader.
 * Delegates unchanged; records each observe() closed result.status into a private array.
 * No generic callbacks; recovery child requires the recorded sequence exact ['dead','dead'].
 * @returns {{ reader: { current: Function, observe: Function }, observedStatuses: string[] }}
 */
function createRecordingRealProcessIdentityReader() {
  const real = createLaunchAgentProcessIdentityReader();
  /** @type {string[]} */
  const observedStatuses = [];
  const reader = Object.freeze({
    current(...args) {
      return real.current(...args);
    },
    async observe(...args) {
      const result = await real.observe(...args);
      // Record actual closed status; never mutate or replace the result returned to coordinator.
      if (
        result !== null
        && typeof result === 'object'
        && !Array.isArray(result)
        && Object.getPrototypeOf(result) === Object.prototype
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(result, 'status');
        if (
          descriptor
          && descriptor.enumerable
          && Object.hasOwn(descriptor, 'value')
          && typeof descriptor.value === 'string'
        ) {
          observedStatuses.push(descriptor.value);
        }
      }
      return result;
    },
  });
  return Object.freeze({ reader, observedStatuses });
}

/**
 * @param {ReturnType<typeof createLaunchAgentLifecycleHarness>} harness
 * @returns {{
 *   coordinator: ReturnType<typeof createLaunchAgentLifecycleCoordinator>,
 *   observedStatuses: string[],
 * }}
 */
function buildCoordinatorWithRealIdentity(harness) {
  const full = harness.dependencies();
  const { reader, observedStatuses } = createRecordingRealProcessIdentityReader();
  const coordinator = createLaunchAgentLifecycleCoordinator(Object.freeze({
    metadataStore: full.metadataStore,
    hostInspector: full.hostInspector,
    profileRenderer: full.profileRenderer,
    plistValidator: full.plistValidator,
    atomicPublisher: full.atomicPublisher,
    launchctlRunner: full.launchctlRunner,
    healthChecker: full.healthChecker,
    clock: full.clock,
    processIdentityReader: reader,
  }));
  return Object.freeze({ coordinator, observedStatuses });
}

/**
 * Build MIR frozen-compensation fixture at after-intent-pre of final plan action.
 * Mirrors test buildFrozenCompensationFixture closed path (no capability mint yet).
 */
async function buildPreparedMirFrozenFixture(fixture) {
  const planOrder = FROZEN_PLAN_ACTION_ORDER[fixture.operation];
  const planIndex = planOrder.indexOf(fixture.action);
  if (planIndex < 0) failClosedSilent();

  const runHarness = createLaunchAgentLifecycleHarness();
  if (fixture.operation === 'managed-upgrade') {
    runHarness.seedInstalled({
      sourceCommit: 'a'.repeat(40),
      loaded: { controller: true, scheduler: true },
    });
    runHarness.resetObservations();
  }
  runHarness.failNextRevalidation('before-commit');
  runHarness.armCrashCapture({
    kind: 'journal-state',
    state: `compensate-${fixture.action}-intent`,
    occurrence: 1,
  });
  const runCoordinator = createLaunchAgentLifecycleCoordinator(runHarness.dependencies());
  const runReceipt = validateLaunchAgentReceipt(
    fixture.operation === 'managed-upgrade'
      ? await runCoordinator.managedUpgrade({
        sourceCommit: fixture.sourceCommit,
        scheduleSeconds: fixture.scheduleSeconds,
        controllerEnvironment: { PORT: '9090' },
      })
      : await runCoordinator.install({
        sourceCommit: fixture.sourceCommit,
        scheduleSeconds: fixture.scheduleSeconds,
        controllerEnvironment: {},
      }),
  );
  if (runReceipt.state !== 'recovered') failClosedSilent();
  const transactionId = runReceipt.transactionId;
  const image = runHarness.takeCrashImage();

  const harness = createLaunchAgentLifecycleHarness({ crashImage: image });
  const crashEntries = harness.journalEntries(transactionId);
  const crashHead = crashEntries.at(-1);
  if (crashHead.state !== `compensate-${fixture.action}-intent`) failClosedSilent();

  const imageTxLockRef = {
    kind: 'transaction-lock',
    transactionId: image.transactionLock.transactionId,
    ownerNonce: image.transactionLock.ownerNonce,
    sha256: harness.sha256(Buffer.from(JSON.stringify(image.transactionLock), 'utf8')),
  };
  const mirEntry = {
    schemaVersion: 1,
    transactionId,
    sequence: crashHead.sequence + 1,
    previousEntrySha256: crashHead.entrySha256,
    operation: fixture.operation,
    state: 'manual-intervention-required',
    at: TS_FROZEN_MIR,
    payload: {
      hostMutationCount: crashHead.payload.hostMutationCount,
    },
  };
  mirEntry.entrySha256 = frozenJournalEntrySha256(mirEntry);
  validateLaunchAgentJournal(mirEntry);
  await harness.dependencies().metadataStore.appendJournal({
    entry: mirEntry,
    expectedPrior: {
      transactionId,
      sequence: crashHead.sequence,
      entrySha256: crashHead.entrySha256,
    },
    writerLockRef: imageTxLockRef,
  });

  const mirRef = harness.seedManualInterventionLock({
    schemaVersion: 1,
    transactionId,
    ownerPid: 1,
    ownerNonce: fixture.mirNonce,
    bootSessionIdentity: { available: true, value: 'fake-boot-session-v1' },
    processStartIdentity: { available: true, value: 'fake-process-start-v1' },
  });
  await harness.dependencies().metadataStore.releaseTransactionLock(imageTxLockRef, {
    manualInterventionLockRef: mirRef,
  });

  const anchor = harness.anchorsWritten().find((candidate) => (
    candidate.transactionId === transactionId
  ));
  if (!anchor) failClosedSilent();

  return {
    harness,
    transactionId,
    mirRef,
    anchorId: anchor.anchorId,
    action: fixture.action,
  };
}

/**
 * Owner child: prepare MIR fixture, arm evidence at final action, run recovery until
 * post-mutation crash image, durable-write image, READY_TO_KILL, hang.
 */
async function runManualRepairCrashOwner(fixturePath, crashImagePath) {
  await assertTempRootFilePath(fixturePath);
  await assertTempRootFilePath(crashImagePath);

  const fixtureBytes = await readBoundedFile(fixturePath, MAX_FIXTURE_BYTES);
  const fixture = parseFixtureEnvelope(fixtureBytes);
  if (fixture === null) failClosedSilent();

  const prepared = await buildPreparedMirFrozenFixture(fixture);
  const { harness, transactionId, mirRef, anchorId, action } = prepared;

  const capability = await mintLocalManualRepairCapability({
    mirTransactionId: transactionId,
    mirLockRef: mirRef,
    transactionLockRef: null,
    anchorId,
    confirmationId: fixture.confirmationId,
    requestId: fixture.requestId,
  });

  // Arm AFTER MIR fixture exists so setup actions are not counted.
  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  harness.queueClockIds([fixture.claimId, fixture.freshOwnerNonce]);
  const evidenceReady = harness.armSelectedFakeHostActionEvidenceForTest({ action });
  harness.armCrashCapture({
    kind: 'host-mutation',
    action,
    occurrence: 1,
  });

  const { coordinator } = buildCoordinatorWithRealIdentity(harness);
  // Do not await: hang after selected mutation before completed journal.
  // Owner mode need not report observations; recording wrapper still used for identity.
  const recoveryPromise = coordinator.recoverAfterManualRepair(capability);
  recoveryPromise.catch(() => {
    // Owner is intentionally killed mid-flight; swallow rejection noise.
  });

  await evidenceReady;
  const crashImage = harness.takeCrashImage();
  const evidence = harness.selectedFakeHostActionEvidenceForTest();
  if (
    evidence === null
    || evidence.action !== action
    || evidence.count !== 1
  ) {
    failClosedSilent();
  }
  // Post-action: selected completed must still be absent.
  const states = harness.journalStates(transactionId);
  if (states.includes(`compensate-${action}-completed`)) failClosedSilent();
  if (harness.lockState().manualInterventionLock !== true) failClosedSilent();
  if (harness.transactionLockRefForTest() === null) failClosedSilent();
  if (harness.hasRecoveryClaim()) failClosedSilent();

  const bytes = serializeLaunchAgentLifecycleCrashImageForTest(crashImage);
  if (bytes.length > MAX_CRASH_IMAGE_BYTES) failClosedSilent();
  await atomicWriteBounded(crashImagePath, bytes, MAX_CRASH_IMAGE_BYTES);

  // Exactly one READY_TO_KILL line, then block without successful result.
  writeSync(1, 'READY_TO_KILL\n');
  // A pending Promise alone is not a referenced Node event-loop handle; the child
  // can exit 0 before the parent delivers SIGKILL. Keep a referenced test-only
  // interval (no unref, no I/O/output) until external SIGKILL; parent remains
  // the authoritative watchdog/cleanup.
  setInterval(() => {}, 60_000);
  await new Promise(() => {
    // intentional hang until parent SIGKILL
  });
}

/**
 * Recovery child: revive image, fresh capability, real identity, claim-fenced resume.
 */
async function runManualRepairRecover(crashImagePath, resultPath) {
  await assertTempRootFilePath(crashImagePath);
  await assertTempRootFilePath(resultPath);

  const imageBytes = await readBoundedFile(crashImagePath, MAX_CRASH_IMAGE_BYTES);
  const image = reviveLaunchAgentLifecycleCrashImageForTest(imageBytes);
  const harness = createLaunchAgentLifecycleHarness({ crashImage: image });

  const evidence = harness.selectedFakeHostActionEvidenceForTest();
  if (evidence === null || evidence.count !== 1) failClosedSilent();
  const selectedAction = evidence.action;

  // Locate MIR transaction from durable lock.
  const mirLock = image.manualInterventionLock;
  if (mirLock === null) failClosedSilent();
  const transactionId = mirLock.transactionId;
  const mirRef = harness.manualInterventionLockRefForTest();
  if (mirRef === null) failClosedSilent();
  const txRef = harness.transactionLockRefForTest();
  if (txRef === null) failClosedSilent();

  const anchor = harness.anchorsWritten().find((candidate) => (
    candidate.transactionId === transactionId
  ));
  if (!anchor) failClosedSilent();

  // Fresh confirmation ids — never reuse owner fixture confirmation.
  const confirmationId = randomUUID();
  const requestId = randomUUID();
  if (!requireUuid(confirmationId) || !requireUuid(requestId)) failClosedSilent();
  if (confirmationId === requestId) failClosedSilent();

  const capability = await mintLocalManualRepairCapability({
    mirTransactionId: transactionId,
    mirLockRef: mirRef,
    // Bind residual stale recovery tx from crash image for owner-dead proof.
    transactionLockRef: txRef,
    anchorId: anchor.anchorId,
    confirmationId,
    requestId,
  });

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  // Fresh claim/owner nonces for this recovery child only.
  const claimId = randomUUID();
  const freshOwnerNonce = randomUUID();
  if (!requireUuid(claimId) || !requireUuid(freshOwnerNonce)) failClosedSilent();
  if (
    claimId === freshOwnerNonce
    || claimId === transactionId
    || freshOwnerNonce === transactionId
  ) {
    failClosedSilent();
  }
  harness.queueClockIds([claimId, freshOwnerNonce]);

  const { coordinator, observedStatuses } = buildCoordinatorWithRealIdentity(harness);
  const receipt = validateLaunchAgentReceipt(
    await coordinator.recoverAfterManualRepair(capability),
  );
  if (receipt.state !== 'recovered') failClosedSilent();
  if (receipt.transactionId !== transactionId) failClosedSilent();

  // Selected action must not have been replayed (evidence still 1; host event once total).
  const postEvidence = harness.selectedFakeHostActionEvidenceForTest();
  if (postEvidence === null || postEvidence.count !== 1) failClosedSilent();
  if (postEvidence.action !== selectedAction) failClosedSilent();

  const states = harness.journalStates(transactionId);
  if (states.at(-1) !== 'recovered') failClosedSilent();
  if (!states.includes(`compensate-${selectedAction}-completed`)) failClosedSilent();
  // Exactly one selected completed after resume.
  if (states.filter((s) => s === `compensate-${selectedAction}-completed`).length !== 1) {
    failClosedSilent();
  }

  const locks = harness.lockState();
  if (locks.transactionLock !== false || locks.manualInterventionLock !== false) {
    failClosedSilent();
  }
  if (harness.hasRecoveryClaim()) failClosedSilent();

  const persisted = harness.receiptFor(transactionId);
  if (persisted === null) failClosedSilent();
  let receiptValid = false;
  try {
    validateLaunchAgentReceipt(persisted);
    receiptValid = true;
  } catch {
    receiptValid = false;
  }
  if (!receiptValid) failClosedSilent();

  // Evidence: actual recorded observe() statuses from the real identity reader.
  // Residual stale tx requires exact dual-dead; any other count/status fails closed.
  if (
    observedStatuses.length !== 2
    || observedStatuses[0] !== 'dead'
    || observedStatuses[1] !== 'dead'
  ) {
    failClosedSilent();
  }
  const ownerObservationStatuses = Object.freeze([
    observedStatuses[0],
    observedStatuses[1],
  ]);

  const result = {
    status: 'recovered',
    transactionId,
    terminalJournalState: 'recovered',
    receiptCount: 1,
    receiptValid: true,
    transactionLockPresent: false,
    manualInterventionLockPresent: false,
    recoveryClaimPresent: false,
    selectedFakeHostActionCount: postEvidence.count,
    ownerObservationStatuses: [...ownerObservationStatuses],
  };
  // Exact key order for canonical JSON.
  const ordered = {
    status: result.status,
    transactionId: result.transactionId,
    terminalJournalState: result.terminalJournalState,
    receiptCount: result.receiptCount,
    receiptValid: result.receiptValid,
    transactionLockPresent: result.transactionLockPresent,
    manualInterventionLockPresent: result.manualInterventionLockPresent,
    recoveryClaimPresent: result.recoveryClaimPresent,
    selectedFakeHostActionCount: result.selectedFakeHostActionCount,
    ownerObservationStatuses: result.ownerObservationStatuses,
  };
  const keys = Reflect.ownKeys(ordered).filter((k) => typeof k === 'string');
  if (keys.length !== RESULT_KEYS.length) failClosedSilent();
  for (let i = 0; i < RESULT_KEYS.length; i += 1) {
    if (keys[i] !== RESULT_KEYS[i]) failClosedSilent();
  }
  const resultBytes = Buffer.from(`${JSON.stringify(ordered)}\n`, 'utf8');
  if (resultBytes.length > MAX_RESULT_BYTES) failClosedSilent();
  await atomicWriteBounded(resultPath, resultBytes, MAX_RESULT_BYTES);
  // Exit 0 with empty stdout (result is file-only).
  settled = true;
  try {
    if (typeof process.disconnect === 'function' && process.connected) {
      process.disconnect();
    }
  } catch {
    // ignore
  }
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) failClosedSilent();
  await loadDeps();

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

  if (mode === 'manual-repair-crash-owner') {
    if (argv.length !== 3) failClosedSilent();
    try {
      await runManualRepairCrashOwner(argv[1], argv[2]);
    } catch {
      if (!settled) failClosedSilent();
    }
    return;
  }

  if (mode === 'manual-repair-recover') {
    if (argv.length !== 3) failClosedSilent();
    try {
      await runManualRepairRecover(argv[1], argv[2]);
    } catch {
      if (!settled) failClosedSilent();
    }
    return;
  }

  failClosedSilent();
}

main().catch(() => {
  if (!settled) failClosedSilent();
});
