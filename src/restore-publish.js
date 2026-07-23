/**
 * G0c C4 — dual-rename publish, rollback, and crash recovery (design §§6.3, 7.4, 11.x).
 * Injected rename/lstat/verifiers only; no copy fallback; no HTTP; no re-fetch.
 * Absolute paths stay in-process ctx; durable STATE never stores abs paths.
 */

import { randomUUID } from 'node:crypto';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import {
  computeContentSha256,
  computeStructureFingerprint,
} from './restore-fingerprint.js';
import { projectCleanupReceipt, projectReceiptObject } from './restore-schemas.js';

/**
 * @returns {never}
 */
function pathInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_PATH_INVALID);
}

/**
 * @returns {never}
 */
function stateInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
}

/**
 * @returns {never}
 */
function publishConflict() {
  throw new LinkeError(ERROR_CODES.RESTORE_PUBLISH_CONFLICT);
}

/**
 * @returns {never}
 */
function rollbackFailed() {
  throw new LinkeError(ERROR_CODES.RESTORE_ROLLBACK_FAILED);
}

/**
 * @returns {string}
 */
function isoNow() {
  return new Date().toISOString();
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isExdev(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    /** @type {{ code?: unknown }} */ (error).code === 'EXDEV'
  );
}

/**
 * Integrity / verification failures that must trigger rollback (not completed).
 * @param {unknown} error
 * @returns {boolean}
 */
function isRollbackTrigger(error) {
  if (!(error instanceof LinkeError)) return false;
  return (
    error.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED ||
    error.code === ERROR_CODES.RESTORE_ROLLBACK_REQUIRED
  );
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {object} store
 * @param {string | undefined} taskId
 * @returns {Promise<Record<string, unknown>>}
 */
async function readState(store, taskId) {
  if (typeof store.readState !== 'function') stateInvalid();
  const state = await store.readState(taskId);
  if (!isPlainObject(state)) stateInvalid();
  return /** @type {Record<string, unknown>} */ (state);
}

/**
 * Durable phase via transitionPhase when present; any throw propagates as-is.
 * writeState fsync fallback ONLY when transitionPhase is absent entirely.
 * @param {object} store
 * @param {string} taskId
 * @param {string} nextPhase
 * @returns {Promise<Record<string, unknown>>}
 */
async function durablePhase(store, taskId, nextPhase) {
  const cur = await readState(store, taskId);
  const from = cur.phase;
  if (typeof from !== 'string') stateInvalid();

  if (typeof store.transitionPhase === 'function') {
    // Any error from transitionPhase propagates — no writeState fallback.
    const next = await store.transitionPhase(taskId, from, nextPhase);
    if (!isPlainObject(next)) stateInvalid();
    return /** @type {Record<string, unknown>} */ (next);
  }

  if (typeof store.writeState !== 'function') stateInvalid();
  const next = await store.writeState(
    taskId,
    { phase: nextPhase, updatedAt: isoNow() },
    { fsync: true },
  );
  if (!isPlainObject(next)) stateInvalid();
  return /** @type {Record<string, unknown>} */ (next);
}

/**
 * Explicit fsync STATE write for pre-publish rolled-back convergence (P2-4).
 * The frozen 17-phase graph has no anchor-intent→rolled-back edge; we must NOT
 * call transitionPhase (would invent illegal edges or forge anchored/published).
 * This recovery writer only sets terminal rolled-back-awaiting-ack after a
 * design-defined early abort that never published.
 * @param {object} store
 * @param {string} taskId
 * @param {object} patch
 * @returns {Promise<Record<string, unknown>>}
 */
async function recoveryWriteState(store, taskId, patch) {
  if (typeof store.writeState !== 'function') stateInvalid();
  const next = await store.writeState(
    taskId,
    { ...patch, updatedAt: isoNow() },
    { fsync: true },
  );
  if (!isPlainObject(next)) stateInvalid();
  return /** @type {Record<string, unknown>} */ (next);
}

/**
 * @param {unknown} lstat
 * @param {string} absPath
 * @returns {Promise<'absent' | 'dir' | 'file' | 'symlink'>}
 */
async function classifyPath(lstat, absPath) {
  if (typeof lstat !== 'function') stateInvalid();
  try {
    const st = await lstat(absPath);
    if (st == null || typeof st !== 'object') stateInvalid();
    if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) return 'symlink';
    if (typeof st.isDirectory === 'function' && st.isDirectory()) return 'dir';
    return 'file';
  } catch {
    return 'absent';
  }
}

/**
 * @param {'absent' | 'dir' | 'file' | 'symlink'} kind
 * @returns {boolean}
 */
function isPresent(kind) {
  return kind !== 'absent';
}

/**
 * @param {'absent' | 'dir' | 'file' | 'symlink'} kind
 * @returns {boolean}
 */
function isIllegalType(kind) {
  return kind === 'symlink' || kind === 'file';
}

/**
 * Directory present (exact dir); illegal types fail-closed.
 * @param {'absent' | 'dir' | 'file' | 'symlink'} kind
 * @returns {boolean}
 */
function isDir(kind) {
  if (isIllegalType(kind)) stateInvalid();
  return kind === 'dir';
}

/**
 * @param {unknown} rename
 * @param {string} from
 * @param {string} to
 * @param {'pre-publish' | 'rollback'} mode
 */
async function doRename(rename, from, to, mode) {
  if (typeof rename !== 'function') stateInvalid();
  try {
    await rename(from, to);
  } catch (error) {
    if (mode === 'pre-publish' && isExdev(error)) pathInvalid();
    if (mode === 'rollback') rollbackFailed();
    if (mode === 'pre-publish') pathInvalid();
    rollbackFailed();
  }
}

/**
 * @param {Record<string, unknown>} state
 * @param {{
 *   contentSha256: string | null,
 *   structureFingerprint: string | null,
 *   anchorPresentBeforePublish: boolean,
 *   outcome: 'completed' | 'rolled-back',
 * }} fields
 */
function buildReceipt(state, fields) {
  const receipt = {
    schemaVersion: 1,
    taskId: state.taskId,
    deviceId: state.deviceId,
    snapshotId: state.snapshotId,
    manifestDigest: state.manifestDigest,
    outcome: fields.outcome,
    relativeTarget: state.relativeTarget,
    totalBytes: state.totalBytes,
    fileCount: state.fileCount,
    contentSha256: fields.contentSha256,
    structureFingerprint: fields.structureFingerprint,
    publishedVerifiedAt: fields.outcome === 'completed' ? isoNow() : null,
    rolledBackAt: fields.outcome === 'rolled-back' ? isoNow() : null,
    anchorPresentBeforePublish: fields.anchorPresentBeforePublish,
    receiptId: randomUUID(),
  };
  return projectReceiptObject(receipt);
}

/**
 * @param {object} store
 * @param {string} taskId
 * @param {object} receipt
 */
async function persistReceipt(store, taskId, receipt) {
  if (typeof store.writeReceipt === 'function') {
    await store.writeReceipt(taskId, receipt);
  }
  if (typeof store.writeState === 'function') {
    await store.writeState(
      taskId,
      { receiptId: receipt.receiptId, updatedAt: isoNow() },
      { fsync: true },
    );
  }
}

/**
 * Require a function field on ctx (verifier contract).
 * @param {object} ctx
 * @param {string} name
 * @returns {() => Promise<void>}
 */
function requireVerifier(ctx, name) {
  const fn = /** @type {any} */ (ctx)[name];
  if (typeof fn !== 'function') stateInvalid();
  return fn;
}

/**
 * @param {unknown} ctx
 * @returns {{
 *   stateStore: object,
 *   paths: {
 *     targetPathAbs: string,
 *     stagingPathAbs: string,
 *     anchorPathAbs: string,
 *     quarantinePathAbs: string,
 *   },
 *   originalTargetExisted: boolean,
 *   oldStructureFingerprint: string | null,
 *   oldContentSha256: string | null,
 *   rename: Function,
 *   lstat: Function,
 * }}
 */
function readPathsCtx(ctx) {
  if (!isPlainObject(ctx)) stateInvalid();
  const stateStore = /** @type {any} */ (ctx).stateStore;
  const paths = /** @type {any} */ (ctx).paths;
  if (!isPlainObject(stateStore) || !isPlainObject(paths)) stateInvalid();
  const targetPathAbs = paths.targetPathAbs;
  const stagingPathAbs = paths.stagingPathAbs;
  const anchorPathAbs = paths.anchorPathAbs;
  const quarantinePathAbs = paths.quarantinePathAbs;
  if (
    typeof targetPathAbs !== 'string' ||
    typeof stagingPathAbs !== 'string' ||
    typeof anchorPathAbs !== 'string' ||
    typeof quarantinePathAbs !== 'string'
  ) {
    stateInvalid();
  }
  const originalTargetExisted = /** @type {any} */ (ctx).originalTargetExisted;
  if (originalTargetExisted !== true && originalTargetExisted !== false) stateInvalid();
  const rename = /** @type {any} */ (ctx).rename;
  const lstat = /** @type {any} */ (ctx).lstat;
  if (typeof rename !== 'function' || typeof lstat !== 'function') stateInvalid();

  /** @type {string | null} */
  let oldStructureFingerprint = null;
  /** @type {string | null} */
  let oldContentSha256 = null;
  const osf = /** @type {any} */ (ctx).oldStructureFingerprint;
  const ocs = /** @type {any} */ (ctx).oldContentSha256;
  if (osf !== null && osf !== undefined) {
    if (typeof osf !== 'string') stateInvalid();
    oldStructureFingerprint = osf;
  }
  if (ocs !== null && ocs !== undefined) {
    if (typeof ocs !== 'string') stateInvalid();
    oldContentSha256 = ocs;
  }

  return {
    stateStore,
    paths: { targetPathAbs, stagingPathAbs, anchorPathAbs, quarantinePathAbs },
    originalTargetExisted,
    oldStructureFingerprint,
    oldContentSha256,
    rename,
    lstat,
  };
}

/**
 * After published: verifyTargetTree → fingerprints → completed receipt.
 * @param {object} store
 * @param {Record<string, unknown>} state
 * @param {string} targetPathAbs
 * @param {boolean} anchorPresentBeforePublish
 * @param {() => Promise<void>} verifyTargetTree
 */
async function finishCompleted(
  store,
  state,
  targetPathAbs,
  anchorPresentBeforePublish,
  verifyTargetTree,
) {
  const taskId = /** @type {string} */ (state.taskId);
  if (typeof verifyTargetTree !== 'function') stateInvalid();

  // Authority: real target tree must pass injected verifier before receipt.
  // Any throw (plain Error/TypeError/LinkeError) is sanitized to a fixed
  // rollback trigger — never propagate raw message/path tokens.
  try {
    await verifyTargetTree();
  } catch {
    throw new LinkeError(ERROR_CODES.RESTORE_ROLLBACK_REQUIRED);
  }

  let contentSha256;
  let structureFingerprint;
  try {
    contentSha256 = await computeContentSha256(targetPathAbs);
    structureFingerprint = await computeStructureFingerprint(targetPathAbs);
  } catch (error) {
    if (isRollbackTrigger(error)) throw error;
    if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED) {
      throw new LinkeError(ERROR_CODES.RESTORE_ROLLBACK_REQUIRED);
    }
    throw new LinkeError(ERROR_CODES.RESTORE_ROLLBACK_REQUIRED);
  }

  const receipt = buildReceipt(state, {
    outcome: 'completed',
    contentSha256,
    structureFingerprint,
    anchorPresentBeforePublish,
  });
  await persistReceipt(store, taskId, receipt);
  await durablePhase(store, taskId, 'completed-awaiting-ack');
  return receipt;
}

/**
 * Full rollback algorithm from published / rollback-intent.
 * @param {ReturnType<typeof readPathsCtx>} base
 * @param {Record<string, unknown>} state
 * @param {{ fromPhase?: string }} [opts]
 */
async function runRollback(base, state, opts = {}) {
  const {
    stateStore,
    paths,
    originalTargetExisted,
    oldStructureFingerprint,
    oldContentSha256,
    rename,
    lstat,
  } = base;
  const taskId = /** @type {string} */ (state.taskId);

  let phase = opts.fromPhase ?? /** @type {string} */ (state.phase);

  if (phase === 'published' || phase === 'rollback-intent') {
    if (phase !== 'rollback-intent') {
      await durablePhase(stateStore, taskId, 'rollback-intent');
      phase = 'rollback-intent';
    }

    const t = await classifyPath(lstat, paths.targetPathAbs);
    const a = await classifyPath(lstat, paths.anchorPathAbs);
    const q = await classifyPath(lstat, paths.quarantinePathAbs);
    const s = await classifyPath(lstat, paths.stagingPathAbs);

    if (isPresent(s)) stateInvalid();
    if (isIllegalType(t) || isIllegalType(a) || isIllegalType(q) || isIllegalType(s)) {
      stateInvalid();
    }

    const tY = t === 'dir';
    const aY = a === 'dir';
    const qY = q === 'dir';

    if (originalTargetExisted) {
      if (tY && aY && !qY) {
        await doRename(rename, paths.targetPathAbs, paths.quarantinePathAbs, 'rollback');
        const qAfter = await classifyPath(lstat, paths.quarantinePathAbs);
        if (!isDir(qAfter)) rollbackFailed();
        await durablePhase(stateStore, taskId, 'failed-target-quarantined');
      } else if (!tY && aY && qY) {
        await durablePhase(stateStore, taskId, 'failed-target-quarantined');
      } else {
        stateInvalid();
      }

      await doRename(rename, paths.anchorPathAbs, paths.targetPathAbs, 'rollback');
      const tRestored = await classifyPath(lstat, paths.targetPathAbs);
      if (!isDir(tRestored)) rollbackFailed();
      await durablePhase(stateStore, taskId, 'anchor-restored');

      let structure;
      let content;
      try {
        structure = await computeStructureFingerprint(paths.targetPathAbs);
        content = await computeContentSha256(paths.targetPathAbs);
      } catch {
        rollbackFailed();
      }
      if (structure !== oldStructureFingerprint || content !== oldContentSha256) {
        rollbackFailed();
      }
      await durablePhase(stateStore, taskId, 'old-fingerprint-verified');

      const nextState = await readState(stateStore, taskId);
      const receipt = buildReceipt(nextState, {
        outcome: 'rolled-back',
        contentSha256: /** @type {string} */ (oldContentSha256),
        structureFingerprint: /** @type {string} */ (oldStructureFingerprint),
        anchorPresentBeforePublish: true,
      });
      await persistReceipt(stateStore, taskId, receipt);
      await durablePhase(stateStore, taskId, 'rolled-back-awaiting-ack');
      return { action: 'rolled-back', phase: 'rolled-back-awaiting-ack', receipt };
    }

    // original absent
    if (tY && !aY && !qY) {
      await doRename(rename, paths.targetPathAbs, paths.quarantinePathAbs, 'rollback');
      const qAfter = await classifyPath(lstat, paths.quarantinePathAbs);
      if (!isDir(qAfter)) rollbackFailed();
      await durablePhase(stateStore, taskId, 'failed-target-quarantined');
    } else if (!tY && !aY && qY) {
      await durablePhase(stateStore, taskId, 'failed-target-quarantined');
    } else {
      stateInvalid();
    }

    const tFinal = await classifyPath(lstat, paths.targetPathAbs);
    if (tFinal !== 'absent') stateInvalid();
    const aFinal = await classifyPath(lstat, paths.anchorPathAbs);
    if (aFinal !== 'absent') stateInvalid();

    await durablePhase(stateStore, taskId, 'anchor-restored');
    await durablePhase(stateStore, taskId, 'old-fingerprint-verified');

    const nextState = await readState(stateStore, taskId);
    const receipt = buildReceipt(nextState, {
      outcome: 'rolled-back',
      contentSha256: null,
      structureFingerprint: null,
      anchorPresentBeforePublish: false,
    });
    await persistReceipt(stateStore, taskId, receipt);
    await durablePhase(stateStore, taskId, 'rolled-back-awaiting-ack');
    return { action: 'rolled-back', phase: 'rolled-back-awaiting-ack', receipt };
  }

  stateInvalid();
}

/**
 * P2-4 early abort from anchor-intent without publish: write rolled-back receipt
 * via recoveryWriteState (no illegal transitionPhase edges).
 * @param {object} store
 * @param {Record<string, unknown>} state
 * @param {{
 *   contentSha256: string | null,
 *   structureFingerprint: string | null,
 *   anchorPresentBeforePublish: boolean,
 * }} fp
 */
async function finishPrePublishRolledBack(store, state, fp) {
  const taskId = /** @type {string} */ (state.taskId);
  // Receipt-before-terminal durability: crash after receipt leaves anchor-intent +
  // durable tombstone; terminal phase must never exist without receipt.
  // recoveryWriteState is used for terminal only (no illegal transitionPhase edge).
  const receipt = buildReceipt(state, {
    outcome: 'rolled-back',
    contentSha256: fp.contentSha256,
    structureFingerprint: fp.structureFingerprint,
    anchorPresentBeforePublish: fp.anchorPresentBeforePublish,
  });
  await persistReceipt(store, taskId, receipt);
  await recoveryWriteState(store, taskId, { phase: 'rolled-back-awaiting-ack' });
  return {
    action: 'rolled-back',
    phase: 'rolled-back-awaiting-ack',
    receipt,
  };
}

/**
 * From anchored: require staging dir (+ optional re-verify), then publish-intent →
 * rename staging→target → published → verify → completed.
 * Staging must be exact dir BEFORE any phase advance.
 * @param {ReturnType<typeof readPathsCtx>} base
 * @param {Record<string, unknown>} state
 * @param {() => Promise<void>} verifyTargetTree
 * @param {(() => Promise<void>) | null} [verifyStagingTree]
 */
async function continueFromAnchored(base, state, verifyTargetTree, verifyStagingTree = null) {
  const { stateStore, paths, originalTargetExisted, rename, lstat } = base;
  const taskId = /** @type {string} */ (state.taskId);

  // Pre-flight staging before durable publish-intent (zero phase advance on fail).
  const stagingKind = await classifyPath(lstat, paths.stagingPathAbs);
  if (stagingKind !== 'dir') stateInvalid();
  if (typeof verifyStagingTree === 'function') {
    try {
      await verifyStagingTree();
    } catch {
      stateInvalid();
    }
  }

  const cur = await readState(stateStore, taskId);
  if (cur.phase !== 'publish-intent') {
    await durablePhase(stateStore, taskId, 'publish-intent');
  }

  await doRename(rename, paths.stagingPathAbs, paths.targetPathAbs, 'pre-publish');
  const targetKind = await classifyPath(lstat, paths.targetPathAbs);
  if (!isDir(targetKind)) stateInvalid();
  const stagingAfter = await classifyPath(lstat, paths.stagingPathAbs);
  if (stagingAfter !== 'absent') stateInvalid();

  await durablePhase(stateStore, taskId, 'published');
  const nextState = await readState(stateStore, taskId);
  return finishCompleted(
    stateStore,
    nextState,
    paths.targetPathAbs,
    originalTargetExisted,
    verifyTargetTree,
  );
}

/**
 * Publish from staging-verified: dual rename + completed receipt.
 * @param {unknown} ctx
 * @returns {Promise<object>}
 */
export async function publishFromStagingVerified(ctx) {
  if (!isPlainObject(ctx)) stateInvalid();

  // verifyTargetTree required before any destructive action / receipt.
  const verifyTargetTree = requireVerifier(ctx, 'verifyTargetTree');

  const base = readPathsCtx(ctx);
  const { stateStore, paths, originalTargetExisted, rename, lstat } = base;

  // Read real task state first (needed for cancel durable transition).
  let state = await readState(stateStore, undefined);
  const taskId = /** @type {string} */ (state.taskId);
  if (typeof taskId !== 'string') stateInvalid();

  // Pre-anchor cancel gate: durable cancelled-local then unique INTERRUPTED.
  if (/** @type {any} */ (ctx).cancelRequested === true) {
    const phase = state.phase;
    if (phase === 'staging-verified' || phase === 'planned' || phase === 'receiving') {
      await durablePhase(stateStore, taskId, 'cancelled-local');
    }
    throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED);
  }

  // Require staging present as directory
  const stagingKind = await classifyPath(lstat, paths.stagingPathAbs);
  if (!isDir(stagingKind)) stateInvalid();

  // Durable intent before first rename
  await durablePhase(stateStore, taskId, 'anchor-intent');

  if (originalTargetExisted) {
    await doRename(rename, paths.targetPathAbs, paths.anchorPathAbs, 'pre-publish');
    const anchorKind = await classifyPath(lstat, paths.anchorPathAbs);
    if (!isDir(anchorKind)) stateInvalid();
    const targetKind = await classifyPath(lstat, paths.targetPathAbs);
    if (targetKind !== 'absent') stateInvalid();
  } else {
    const anchorKind = await classifyPath(lstat, paths.anchorPathAbs);
    const targetKind = await classifyPath(lstat, paths.targetPathAbs);
    if (anchorKind !== 'absent' || targetKind !== 'absent') stateInvalid();
  }

  await durablePhase(stateStore, taskId, 'anchored');
  await durablePhase(stateStore, taskId, 'publish-intent');

  await doRename(rename, paths.stagingPathAbs, paths.targetPathAbs, 'pre-publish');
  const targetAfter = await classifyPath(lstat, paths.targetPathAbs);
  if (!isDir(targetAfter)) stateInvalid();
  const stagingAfter = await classifyPath(lstat, paths.stagingPathAbs);
  if (stagingAfter !== 'absent') stateInvalid();

  await durablePhase(stateStore, taskId, 'published');
  state = await readState(stateStore, taskId);

  try {
    return await finishCompleted(
      stateStore,
      state,
      paths.targetPathAbs,
      originalTargetExisted,
      verifyTargetTree,
    );
  } catch (error) {
    if (isRollbackTrigger(error)) {
      const rb = await runRollback(base, await readState(stateStore, taskId), {
        fromPhase: 'published',
      });
      return rb.receipt;
    }
    throw error;
  }
}

/**
 * Rollback a published tree that failed verification.
 * @param {unknown} ctx
 * @returns {Promise<object>}
 */
export async function rollbackPublished(ctx) {
  const base = readPathsCtx(ctx);
  const state = await readState(base.stateStore, undefined);
  const result = await runRollback(base, state, { fromPhase: 'published' });
  return result.receipt;
}

/**
 * Table-driven crash recovery. reFetchForbidden must be exact true.
 * @param {unknown} ctx
 * @returns {Promise<{ action: string, phase: string, receipt?: object }>}
 */
export async function recoverFromCrash(ctx) {
  if (!isPlainObject(ctx)) stateInvalid();

  // Exact true only — never re-fetch on any path.
  if (/** @type {any} */ (ctx).reFetchForbidden !== true) {
    stateInvalid();
  }
  // Intentionally never call ctx.reFetch even if present.

  // Both verifiers required for recovery contract.
  const verifyStagingTree = requireVerifier(ctx, 'verifyStagingTree');
  const verifyTargetTree = requireVerifier(ctx, 'verifyTargetTree');

  const base = readPathsCtx(ctx);
  const {
    stateStore,
    paths,
    originalTargetExisted,
    oldStructureFingerprint,
    oldContentSha256,
    rename,
    lstat,
  } = base;
  const cancelRequested = /** @type {any} */ (ctx).cancelRequested === true;

  let state = await readState(stateStore, undefined);
  const taskId = /** @type {string} */ (state.taskId);
  if (typeof taskId !== 'string') stateInvalid();
  const phase = state.phase;
  if (typeof phase !== 'string') stateInvalid();

  // Cancel after anchor-intent is audit-only — never cancelled-local.
  void cancelRequested;

  switch (phase) {
    case 'anchor-intent': {
      const t = await classifyPath(lstat, paths.targetPathAbs);
      const a = await classifyPath(lstat, paths.anchorPathAbs);

      if (isIllegalType(t) || isIllegalType(a)) stateInvalid();

      const tY = t === 'dir';
      const aY = a === 'dir';

      // Existence matrix (§11.5) — structural first
      if (tY && aY) stateInvalid();
      if (!tY && !aY && originalTargetExisted) stateInvalid();

      // Staging re-verify (required)
      try {
        await verifyStagingTree();
      } catch {
        // P2-4: staging re-verify failed
        if (tY && aY) stateInvalid();

        // T=dir A=absent: prove original still intact at target
        if (originalTargetExisted && tY && !aY) {
          let structure;
          let content;
          try {
            structure = await computeStructureFingerprint(paths.targetPathAbs);
            content = await computeContentSha256(paths.targetPathAbs);
          } catch {
            stateInvalid();
          }
          if (
            structure === oldStructureFingerprint &&
            content === oldContentSha256
          ) {
            // No rename; rolled-back receipt via recovery writer
            return finishPrePublishRolledBack(stateStore, state, {
              contentSha256: /** @type {string} */ (oldContentSha256),
              structureFingerprint: /** @type {string} */ (oldStructureFingerprint),
              anchorPresentBeforePublish: true,
            });
          }
          stateInvalid();
        }

        // T=absent A=dir: rename already happened; restore anchor→target if fingerprints match
        if (originalTargetExisted && !tY && aY) {
          let structure;
          let content;
          try {
            structure = await computeStructureFingerprint(paths.anchorPathAbs);
            content = await computeContentSha256(paths.anchorPathAbs);
          } catch {
            stateInvalid();
          }
          if (
            structure !== oldStructureFingerprint ||
            content !== oldContentSha256
          ) {
            // mismatch fail-closed
            stateInvalid();
          }

          // Durable rollback intent before destructive restore rename
          // (not a publish edge — dedicated recovery fsync intent marker)
          await recoveryWriteState(stateStore, taskId, {
            phase: 'anchor-intent',
            lastErrorCode: ERROR_CODES.RESTORE_INTEGRITY_FAILED,
          });

          await doRename(rename, paths.anchorPathAbs, paths.targetPathAbs, 'rollback');
          const tRestored = await classifyPath(lstat, paths.targetPathAbs);
          if (!isDir(tRestored)) rollbackFailed();
          const aAfter = await classifyPath(lstat, paths.anchorPathAbs);
          if (aAfter !== 'absent') rollbackFailed();

          // Do not delete staging/quarantine
          return finishPrePublishRolledBack(stateStore, await readState(stateStore, taskId), {
            contentSha256: /** @type {string} */ (oldContentSha256),
            structureFingerprint: /** @type {string} */ (oldStructureFingerprint),
            anchorPresentBeforePublish: true,
          });
        }

        // Ambiguous or original absent with bad staging
        stateInvalid();
      }

      // Staging OK — continue publish recovery
      if (tY && !aY) {
        if (!originalTargetExisted) stateInvalid();
        await doRename(rename, paths.targetPathAbs, paths.anchorPathAbs, 'pre-publish');
        const a2 = await classifyPath(lstat, paths.anchorPathAbs);
        if (!isDir(a2)) stateInvalid();
        const t2 = await classifyPath(lstat, paths.targetPathAbs);
        if (t2 !== 'absent') stateInvalid();
        await durablePhase(stateStore, taskId, 'anchored');
      } else if (!tY && aY) {
        if (!originalTargetExisted) stateInvalid();
        await durablePhase(stateStore, taskId, 'anchored');
      } else if (!tY && !aY && !originalTargetExisted) {
        await durablePhase(stateStore, taskId, 'anchored');
      } else {
        stateInvalid();
      }

      state = await readState(stateStore, taskId);
      try {
        const receipt = await continueFromAnchored(
          base,
          state,
          verifyTargetTree,
          verifyStagingTree,
        );
        return { action: 'completed', phase: 'completed-awaiting-ack', receipt };
      } catch (error) {
        if (isRollbackTrigger(error)) {
          return runRollback(base, await readState(stateStore, taskId), {
            fromPhase: 'published',
          });
        }
        throw error;
      }
    }

    case 'anchored': {
      const t = await classifyPath(lstat, paths.targetPathAbs);
      const a = await classifyPath(lstat, paths.anchorPathAbs);
      if (isIllegalType(t) || isIllegalType(a)) stateInvalid();

      if (originalTargetExisted) {
        if (t !== 'absent' || a !== 'dir') stateInvalid();
      } else if (t !== 'absent' || a !== 'absent') {
        stateInvalid();
      }

      // Staging must be exact dir + re-verified BEFORE publish-intent (zero advance on fail).
      const stagingKind = await classifyPath(lstat, paths.stagingPathAbs);
      if (stagingKind !== 'dir') stateInvalid();
      try {
        await verifyStagingTree();
      } catch {
        stateInvalid();
      }

      try {
        // Staging already checked; pass null to avoid double verifyStaging (still re-classifies).
        const receipt = await continueFromAnchored(base, state, verifyTargetTree, null);
        return { action: 'completed', phase: 'completed-awaiting-ack', receipt };
      } catch (error) {
        if (isRollbackTrigger(error)) {
          return runRollback(base, await readState(stateStore, taskId), {
            fromPhase: 'published',
          });
        }
        throw error;
      }
    }

    case 'publish-intent': {
      const t = await classifyPath(lstat, paths.targetPathAbs);
      const s = await classifyPath(lstat, paths.stagingPathAbs);
      if (isIllegalType(t) || isIllegalType(s)) stateInvalid();

      const tY = t === 'dir';
      const sY = s === 'dir';

      if (!tY && sY) {
        await doRename(rename, paths.stagingPathAbs, paths.targetPathAbs, 'pre-publish');
        const t2 = await classifyPath(lstat, paths.targetPathAbs);
        if (!isDir(t2)) stateInvalid();
        const s2 = await classifyPath(lstat, paths.stagingPathAbs);
        if (s2 !== 'absent') stateInvalid();
        await durablePhase(stateStore, taskId, 'published');
        state = await readState(stateStore, taskId);
        try {
          const receipt = await finishCompleted(
            stateStore,
            state,
            paths.targetPathAbs,
            originalTargetExisted,
            verifyTargetTree,
          );
          return { action: 'completed', phase: 'completed-awaiting-ack', receipt };
        } catch (error) {
          if (isRollbackTrigger(error)) {
            return runRollback(base, await readState(stateStore, taskId), {
              fromPhase: 'published',
            });
          }
          throw error;
        }
      }

      if (tY && !sY) {
        await durablePhase(stateStore, taskId, 'published');
        state = await readState(stateStore, taskId);
        try {
          const receipt = await finishCompleted(
            stateStore,
            state,
            paths.targetPathAbs,
            originalTargetExisted,
            verifyTargetTree,
          );
          return { action: 'completed', phase: 'completed-awaiting-ack', receipt };
        } catch (error) {
          if (isRollbackTrigger(error)) {
            return runRollback(base, await readState(stateStore, taskId), {
              fromPhase: 'published',
            });
          }
          throw error;
        }
      }

      if (tY && sY) publishConflict();
      stateInvalid();
      break;
    }

    case 'published': {
      try {
        const receipt = await finishCompleted(
          stateStore,
          state,
          paths.targetPathAbs,
          originalTargetExisted,
          verifyTargetTree,
        );
        return { action: 'completed', phase: 'completed-awaiting-ack', receipt };
      } catch (error) {
        if (isRollbackTrigger(error)) {
          return runRollback(base, state, { fromPhase: 'published' });
        }
        throw error;
      }
    }

    case 'rollback-intent':
    case 'failed-target-quarantined':
    case 'anchor-restored':
    case 'old-fingerprint-verified': {
      if (phase !== 'rollback-intent') {
        const t = await classifyPath(lstat, paths.targetPathAbs);
        const a = await classifyPath(lstat, paths.anchorPathAbs);
        const q = await classifyPath(lstat, paths.quarantinePathAbs);
        const s = await classifyPath(lstat, paths.stagingPathAbs);
        if (isPresent(s) || isIllegalType(t) || isIllegalType(a) || isIllegalType(q)) {
          stateInvalid();
        }

        if (phase === 'failed-target-quarantined') {
          if (originalTargetExisted) {
            if (t === 'absent' && a === 'dir' && q === 'dir') {
              await doRename(rename, paths.anchorPathAbs, paths.targetPathAbs, 'rollback');
              await durablePhase(stateStore, taskId, 'anchor-restored');
              let structure;
              let content;
              try {
                structure = await computeStructureFingerprint(paths.targetPathAbs);
                content = await computeContentSha256(paths.targetPathAbs);
              } catch {
                rollbackFailed();
              }
              if (
                structure !== oldStructureFingerprint ||
                content !== oldContentSha256
              ) {
                rollbackFailed();
              }
              await durablePhase(stateStore, taskId, 'old-fingerprint-verified');
              const nextState = await readState(stateStore, taskId);
              const receipt = buildReceipt(nextState, {
                outcome: 'rolled-back',
                contentSha256: /** @type {string} */ (oldContentSha256),
                structureFingerprint: /** @type {string} */ (oldStructureFingerprint),
                anchorPresentBeforePublish: true,
              });
              await persistReceipt(stateStore, taskId, receipt);
              await durablePhase(stateStore, taskId, 'rolled-back-awaiting-ack');
              return {
                action: 'rolled-back',
                phase: 'rolled-back-awaiting-ack',
                receipt,
              };
            }
            // Post-rename mid-window: anchor→target already succeeded, phase not durable.
            // T=dir (old tree), A=absent, Q=dir (failed publish retained), S=absent.
            if (t === 'dir' && a === 'absent' && q === 'dir') {
              await durablePhase(stateStore, taskId, 'anchor-restored');
              let structure;
              let content;
              try {
                structure = await computeStructureFingerprint(paths.targetPathAbs);
                content = await computeContentSha256(paths.targetPathAbs);
              } catch {
                rollbackFailed();
              }
              if (
                structure !== oldStructureFingerprint ||
                content !== oldContentSha256
              ) {
                rollbackFailed();
              }
              await durablePhase(stateStore, taskId, 'old-fingerprint-verified');
              const nextState = await readState(stateStore, taskId);
              const receipt = buildReceipt(nextState, {
                outcome: 'rolled-back',
                contentSha256: /** @type {string} */ (oldContentSha256),
                structureFingerprint: /** @type {string} */ (oldStructureFingerprint),
                anchorPresentBeforePublish: true,
              });
              await persistReceipt(stateStore, taskId, receipt);
              await durablePhase(stateStore, taskId, 'rolled-back-awaiting-ack');
              return {
                action: 'rolled-back',
                phase: 'rolled-back-awaiting-ack',
                receipt,
              };
            }
            stateInvalid();
          }
          if (t === 'absent' && a === 'absent' && q === 'dir') {
            await durablePhase(stateStore, taskId, 'anchor-restored');
            await durablePhase(stateStore, taskId, 'old-fingerprint-verified');
            const nextState = await readState(stateStore, taskId);
            const receipt = buildReceipt(nextState, {
              outcome: 'rolled-back',
              contentSha256: null,
              structureFingerprint: null,
              anchorPresentBeforePublish: false,
            });
            await persistReceipt(stateStore, taskId, receipt);
            await durablePhase(stateStore, taskId, 'rolled-back-awaiting-ack');
            return {
              action: 'rolled-back',
              phase: 'rolled-back-awaiting-ack',
              receipt,
            };
          }
          stateInvalid();
        }

        if (phase === 'anchor-restored' || phase === 'old-fingerprint-verified') {
          if (originalTargetExisted) {
            let structure;
            let content;
            try {
              structure = await computeStructureFingerprint(paths.targetPathAbs);
              content = await computeContentSha256(paths.targetPathAbs);
            } catch {
              rollbackFailed();
            }
            if (
              structure !== oldStructureFingerprint ||
              content !== oldContentSha256
            ) {
              rollbackFailed();
            }
            if (phase === 'anchor-restored') {
              await durablePhase(stateStore, taskId, 'old-fingerprint-verified');
            }
            const nextState = await readState(stateStore, taskId);
            const receipt = buildReceipt(nextState, {
              outcome: 'rolled-back',
              contentSha256: /** @type {string} */ (oldContentSha256),
              structureFingerprint: /** @type {string} */ (oldStructureFingerprint),
              anchorPresentBeforePublish: true,
            });
            await persistReceipt(stateStore, taskId, receipt);
            await durablePhase(stateStore, taskId, 'rolled-back-awaiting-ack');
            return {
              action: 'rolled-back',
              phase: 'rolled-back-awaiting-ack',
              receipt,
            };
          }
          const nextState = await readState(stateStore, taskId);
          const receipt = buildReceipt(nextState, {
            outcome: 'rolled-back',
            contentSha256: null,
            structureFingerprint: null,
            anchorPresentBeforePublish: false,
          });
          await persistReceipt(stateStore, taskId, receipt);
          await durablePhase(stateStore, taskId, 'rolled-back-awaiting-ack');
          return {
            action: 'rolled-back',
            phase: 'rolled-back-awaiting-ack',
            receipt,
          };
        }
      }
      return runRollback(base, state, { fromPhase: 'rollback-intent' });
    }

    case 'completed-awaiting-ack':
    case 'rolled-back-awaiting-ack': {
      if (typeof stateStore.readTombstone !== 'function') stateInvalid();
      let tomb;
      try {
        tomb = await stateStore.readTombstone(taskId);
      } catch {
        stateInvalid();
      }
      if (!isPlainObject(tomb) || tomb.receipt == null) stateInvalid();
      let projected;
      try {
        projected = projectReceiptObject(tomb.receipt);
      } catch {
        stateInvalid();
      }
      if (projected.taskId !== taskId) stateInvalid();
      if (projected.deviceId !== state.deviceId) stateInvalid();
      if (phase === 'completed-awaiting-ack' && projected.outcome !== 'completed') {
        stateInvalid();
      }
      if (phase === 'rolled-back-awaiting-ack' && projected.outcome !== 'rolled-back') {
        stateInvalid();
      }
      return { action: 'awaiting-ack', phase, receipt: projected };
    }

    case 'cancelled-local':
    case 'cleanup-intent':
    case 'cleanup-completed-awaiting-ack':
    case 'cleaned':
    case 'planned':
    case 'receiving':
    case 'staging-verified':
    default:
      stateInvalid();
  }
}

/**
 * Recover cancelled-local: phase gate, fsync cleanupId, idempotent staging delete, stable CleanupReceipt.
 * @param {unknown} ctx
 * @returns {Promise<object>}
 */
export async function recoverCancelledLocal(ctx) {
  if (!isPlainObject(ctx)) stateInvalid();
  const stateStore = /** @type {any} */ (ctx).stateStore;
  const stagingPathAbs = /** @type {any} */ (ctx).stagingPathAbs;
  const taskId = /** @type {any} */ (ctx).taskId;
  const deviceId = /** @type {any} */ (ctx).deviceId;
  const cleanupIdIn = /** @type {any} */ (ctx).cleanupId;
  const rm = /** @type {any} */ (ctx).rm;

  if (!isPlainObject(stateStore)) stateInvalid();
  if (typeof stagingPathAbs !== 'string') stateInvalid();
  if (typeof taskId !== 'string') stateInvalid();
  if (typeof deviceId !== 'string') stateInvalid();
  if (typeof rm !== 'function') stateInvalid();

  // Phase gate before any rm/receipt
  const state = await readState(stateStore, taskId);
  const phase = state.phase;
  if (phase !== 'cancelled-local' && phase !== 'cleanup-completed-awaiting-ack') {
    stateInvalid();
  }

  // Resolve stable cleanupId: explicit / STATE / new
  /** @type {string | null} */
  let cleanupId = null;
  if (typeof cleanupIdIn === 'string' && cleanupIdIn.length > 0) {
    cleanupId = cleanupIdIn;
    if (
      typeof state.cleanupId === 'string' &&
      state.cleanupId.length > 0 &&
      state.cleanupId !== cleanupId
    ) {
      stateInvalid();
    }
  } else if (typeof state.cleanupId === 'string' && state.cleanupId.length > 0) {
    cleanupId = state.cleanupId;
  } else if (state.cleanupId === null || state.cleanupId === undefined) {
    cleanupId = randomUUID();
  } else {
    stateInvalid();
  }
  if (cleanupId === null) cleanupId = randomUUID();

  // cleanupId durability requires writeState; transitionPhase-only stores fail closed
  // before rm or CleanupReceipt (no silent skip of fsync).
  if (typeof stateStore.writeState !== 'function') {
    stateInvalid();
  }
  // Fsync cleanupId into STATE BEFORE any CleanupReceipt write (no terminal phase here).
  await stateStore.writeState(
    taskId,
    { cleanupId, updatedAt: isoNow() },
    { fsync: true },
  );

  // Idempotent remove of unpublished staging
  try {
    await rm(stagingPathAbs, { recursive: true, force: true });
  } catch {
    throw new LinkeError(ERROR_CODES.RESTORE_CLEANUP_FAILED);
  }

  const cleanupReceipt = projectCleanupReceipt({
    schemaVersion: 1,
    cleanupId,
    taskId,
    deviceId,
    outcome: 'cancelled',
    receiptId: null,
    cleanedAt: isoNow(),
  });

  if (typeof stateStore.writeCleanupReceipt === 'function') {
    await stateStore.writeCleanupReceipt(taskId, cleanupReceipt);
  }

  // Terminal phase: only from cancelled-local via durablePhase → transitionPhase.
  // Already at cleanup-completed-awaiting-ack = idempotent replay (no same-phase transition).
  // Never writeState terminal phase directly.
  if (phase === 'cancelled-local') {
    await durablePhase(stateStore, taskId, 'cleanup-completed-awaiting-ack');
  }

  return cleanupReceipt;
}
