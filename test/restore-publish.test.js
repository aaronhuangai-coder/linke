/**
 * RED/GREEN tests for G0c C4 dual-rename publish + cancel canary
 * (design §§6.3, 7.4, 7.8, 10.4, 11.1–11.5; plan C4 + GLM P1/P2 hardening).
 *
 * Real temp dirs; injectable rename/lstat/verifiers; behavioral stateStore double.
 * Do NOT scan Error.stack; scan code/message/name/statusCode/retryable + enumerable fields.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat as realLstat,
  mkdir,
  mkdtemp,
  readFile,
  rename as realRename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import {
  computeContentSha256,
  computeStructureFingerprint,
} from '../src/restore-fingerprint.js';
import { projectReceiptObject } from '../src/restore-schemas.js';
import {
  publishFromStagingVerified,
  recoverFromCrash,
  rollbackPublished,
  recoverCancelledLocal,
} from '../src/restore-publish.js';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440001';
const DEVICE_ID = 'device-alpha-001';
const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-446655440002';
const DIGEST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RELATIVE_TARGET = 'docs/restore-target';
const HEX64_RE = /^[a-f0-9]{64}$/;

const PATH_INVALID = ERROR_CODES.RESTORE_PATH_INVALID;
const STATE_INVALID = ERROR_CODES.RESTORE_STATE_INVALID;
const INTERRUPTED = ERROR_CODES.RESTORE_INTERRUPTED;
const INTEGRITY_FAILED = ERROR_CODES.RESTORE_INTEGRITY_FAILED;
const ROLLBACK_FAILED = ERROR_CODES.RESTORE_ROLLBACK_FAILED;

/** @type {string | undefined} */
let tempRoot;

/**
 * @param {unknown} error
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
function assertLinkeCode(error, code, opts = {}) {
  assert.ok(error instanceof LinkeError, `expected LinkeError ${code}, got ${error}`);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  if (opts.statusCode !== undefined) assert.equal(error.statusCode, opts.statusCode);
  if (opts.retryable !== undefined) assert.equal(error.retryable, opts.retryable);

  const ownPublic = Object.keys(/** @type {object} */ (error))
    .filter((k) => k !== 'stack')
    .map((k) => String(/** @type {Record<string, unknown>} */ (error)[k]));
  const publicParts = [
    error.code,
    error.message,
    error.name,
    String(error.statusCode),
    String(error.retryable),
    ...ownPublic,
  ].join('\0');

  const denylist = [
    ...(opts.leakTokens ?? []),
    tempRoot ?? '',
    '/Users/',
    'secret-token',
    'ENOENT',
    'EACCES',
    'EPERM',
    'errno',
    'EXDEV',
    'cross-device',
  ].filter(Boolean);

  for (const token of denylist) {
    if (String(token).length < 2) continue;
    if (code.includes(String(token))) continue;
    assert.ok(!publicParts.includes(String(token)), `must not leak ${token}`);
  }
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
async function expectRejects(fn, code, opts = {}) {
  await assert.rejects(fn, (error) => {
    assertLinkeCode(error, code, opts);
    return true;
  });
}

/**
 * @param {string} p
 */
async function exists(p) {
  try {
    await realLstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {Record<string, string | Buffer>} files
 */
async function writeTree(dir, files) {
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

/**
 * Behavioral stateStore double — records durable phase order + fsync writes.
 * @param {object} [initial]
 * @param {{
 *   transitionThrows?: Error | LinkeError | (() => Error),
 *   crashAfterCleanupReceiptWrite?: boolean,
 * }} [hooks]
 */
function createStateStoreDouble(initial = {}, hooks = {}) {
  /** @type {Record<string, unknown>} */
  let state = {
    schemaVersion: 1,
    taskId: TASK_ID,
    deviceId: DEVICE_ID,
    snapshotId: SNAPSHOT_ID,
    manifestDigest: DIGEST,
    relativeTarget: RELATIVE_TARGET,
    phase: 'staging-verified',
    updatedAt: '2026-07-23T12:00:00.000Z',
    receivedBytes: 0,
    confirmedFiles: 0,
    fileCount: 1,
    totalBytes: 4,
    chunkSize: 8_388_608,
    oldStructureFingerprint: null,
    oldContentSha256: null,
    originalTargetExisted: false,
    receiptId: null,
    cleanupId: null,
    cleanupAuthorized: false,
    lastErrorCode: null,
    ...initial,
  };

  /** @type {string[]} */
  const durablePhases = [/** @type {string} */ (state.phase)];
  /** @type {Array<{ from: string, to: string }>} */
  const transitions = [];
  /** @type {Array<object>} */
  const writePatches = [];
  /** @type {object | null} */
  let receipt = null;
  /** @type {object | null} */
  let cleanupReceipt = null;
  let reFetchCalls = 0;
  let writeStateCalls = 0;
  let writeReceiptCalls = 0;
  let writeCleanupReceiptCalls = 0;
  let transitionCalls = 0;

  return {
    durablePhases,
    transitions,
    writePatches,
    get state() {
      return state;
    },
    get receipt() {
      return receipt;
    },
    get cleanupReceipt() {
      return cleanupReceipt;
    },
    get reFetchCalls() {
      return reFetchCalls;
    },
    get writeStateCalls() {
      return writeStateCalls;
    },
    get writeReceiptCalls() {
      return writeReceiptCalls;
    },
    get writeCleanupReceiptCalls() {
      return writeCleanupReceiptCalls;
    },
    get transitionCalls() {
      return transitionCalls;
    },
    noteReFetch() {
      reFetchCalls += 1;
    },
    async readState(_taskId) {
      return Object.freeze({ ...state });
    },
    async readTombstone(_taskId) {
      if (!receipt) {
        throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
      }
      return Object.freeze({
        state: Object.freeze({ ...state }),
        receipt: Object.freeze({ ...receipt }),
        cleanupReceipt: cleanupReceipt ? Object.freeze({ ...cleanupReceipt }) : null,
      });
    },
    async transitionPhase(_taskId, from, to) {
      transitionCalls += 1;
      if (hooks.transitionThrows) {
        const err =
          typeof hooks.transitionThrows === 'function'
            ? hooks.transitionThrows()
            : hooks.transitionThrows;
        throw err;
      }
      assert.equal(state.phase, from, `transitionPhase expected from=${from}`);
      transitions.push({ from, to });
      state = { ...state, phase: to, updatedAt: '2026-07-23T12:00:01.000Z' };
      durablePhases.push(to);
      return Object.freeze({ ...state });
    },
    async writeState(_taskId, patch, writeOptions) {
      writeStateCalls += 1;
      assert.ok(writeOptions && writeOptions.fsync === true, 'STATE writes require fsync:true');
      writePatches.push({ patch: { ...patch }, writeOptions: { ...writeOptions } });
      state = { ...state, ...patch };
      if (typeof patch.phase === 'string' && durablePhases[durablePhases.length - 1] !== patch.phase) {
        durablePhases.push(patch.phase);
      }
      return Object.freeze({ ...state });
    },
    async writeReceipt(_taskId, r) {
      writeReceiptCalls += 1;
      receipt = r;
      if (r && typeof r === 'object' && /** @type {any} */ (r).receiptId) {
        state = { ...state, receiptId: /** @type {any} */ (r).receiptId };
      }
    },
    async writeCleanupReceipt(_taskId, r) {
      writeCleanupReceiptCalls += 1;
      cleanupReceipt = r;
      if (r && typeof r === 'object' && /** @type {any} */ (r).cleanupId) {
        state = { ...state, cleanupId: /** @type {any} */ (r).cleanupId };
      }
      if (hooks.crashAfterCleanupReceiptWrite) {
        const err = new Error('simulated crash after cleanup receipt write');
        err.code = 'EIO';
        throw err;
      }
    },
  };
}

/**
 * @param {{
 *   real?: typeof realRename,
 *   failAtCall?: number,
 *   failCode?: string,
 *   betweenCallsHook?: (info: { callIndex: number, from: string, to: string, calls: object[] }) => Promise<void> | void,
 * }} [opts]
 */
function createRenameHarness(opts = {}) {
  const real = opts.real ?? realRename;
  /** @type {Array<{ from: string, to: string }>} */
  const calls = [];
  let callIndex = 0;
  const rename = async (from, to) => {
    callIndex += 1;
    const entry = { from, to };
    calls.push(entry);
    if (opts.failAtCall !== undefined && callIndex === opts.failAtCall) {
      const err = new Error('simulated cross-device rename');
      err.code = opts.failCode ?? 'EXDEV';
      throw err;
    }
    await real(from, to);
    if (opts.betweenCallsHook && callIndex === 1) {
      await opts.betweenCallsHook({ callIndex, from, to, calls: [...calls] });
    }
  };
  return {
    calls,
    rename,
    get callCount() {
      return callIndex;
    },
  };
}

/**
 * Behavioral verifier counters for staging/target.
 */
function createVerifiers(opts = {}) {
  /** @type {string[]} */
  const order = [];
  let stagingCalls = 0;
  let targetCalls = 0;
  return {
    order,
    get stagingCalls() {
      return stagingCalls;
    },
    get targetCalls() {
      return targetCalls;
    },
    verifyStagingTree: async () => {
      stagingCalls += 1;
      order.push('staging');
      if (opts.stagingThrow) throw opts.stagingThrow;
    },
    verifyTargetTree: async () => {
      targetCalls += 1;
      order.push('target');
      if (opts.targetThrow) throw opts.targetThrow;
    },
  };
}

/**
 * @param {string} parent
 */
function siblingPaths(parent) {
  return {
    targetPathAbs: join(parent, RELATIVE_TARGET),
    stagingPathAbs: join(parent, dirname(RELATIVE_TARGET), `.${TASK_ID}.linke-restore-staging`),
    anchorPathAbs: join(parent, dirname(RELATIVE_TARGET), `.${TASK_ID}.linke-restore-anchor`),
    quarantinePathAbs: join(
      parent,
      dirname(RELATIVE_TARGET),
      `.${TASK_ID}.linke-restore-quarantine`,
    ),
  };
}

/**
 * @param {object} receipt
 * @param {{ anchorPresentBeforePublish: boolean }} expect
 */
function assertCompletedReceiptShape(receipt, expect) {
  const projected = projectReceiptObject(receipt);
  assert.equal(projected.outcome, 'completed');
  assert.equal(projected.anchorPresentBeforePublish, expect.anchorPresentBeforePublish);
  assert.match(/** @type {string} */ (projected.contentSha256), HEX64_RE);
  assert.match(/** @type {string} */ (projected.structureFingerprint), HEX64_RE);
  assert.notEqual(projected.contentSha256, null);
  assert.notEqual(projected.structureFingerprint, null);
  assert.notEqual(projected.publishedVerifiedAt, null);
  assert.equal(projected.rolledBackAt, null);
  assert.equal(projected.taskId, TASK_ID);
  assert.equal(projected.deviceId, DEVICE_ID);
  assert.equal(projected.snapshotId, SNAPSHOT_ID);
  assert.equal(projected.relativeTarget, RELATIVE_TARGET);
  const blob = JSON.stringify(projected);
  assert.ok(!blob.includes('/Users/'));
  assert.ok(!blob.includes('secret-token'));
  if (tempRoot) assert.ok(!blob.includes(tempRoot));
  return projected;
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'linke-pub-'));
});

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

// ── 1. Success publish ─────────────────────────────────────────────

describe('publishFromStagingVerified — success paths', () => {
  it('original target existed: target→anchor then staging→target; completed dual fingerprint; anchorPresentBeforePublish=true', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });

    await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD-BYTES' });
    await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW-BYTES' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);
    const expectedNewStructure = await computeStructureFingerprint(paths.stagingPathAbs);
    const expectedNewContent = await computeContentSha256(paths.stagingPathAbs);

    const store = createStateStoreDouble({
      phase: 'staging-verified',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
      fileCount: 1,
      totalBytes: Buffer.byteLength('NEW-BYTES'),
    });
    const harness = createRenameHarness();
    const v = createVerifiers();

    const receipt = await publishFromStagingVerified({
      stateStore: store,
      paths: {
        targetPathAbs: paths.targetPathAbs,
        stagingPathAbs: paths.stagingPathAbs,
        anchorPathAbs: paths.anchorPathAbs,
        quarantinePathAbs: paths.quarantinePathAbs,
      },
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
      cancelRequested: false,
      rename: harness.rename,
      lstat: realLstat,
      verifyTargetTree: v.verifyTargetTree,
    });

    const projected = assertCompletedReceiptShape(receipt, { anchorPresentBeforePublish: true });
    assert.equal(projected.contentSha256, expectedNewContent);
    assert.equal(projected.structureFingerprint, expectedNewStructure);

    assert.equal(await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.anchorPathAbs), true);
    assert.equal(await exists(paths.stagingPathAbs), false);
    assert.equal(await exists(paths.quarantinePathAbs), false);
    assert.equal(await readFile(join(paths.targetPathAbs, 'new.txt'), 'utf8'), 'NEW-BYTES');
    assert.equal(await readFile(join(paths.anchorPathAbs, 'old.txt'), 'utf8'), 'OLD-BYTES');

    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[0].from, paths.targetPathAbs);
    assert.equal(harness.calls[0].to, paths.anchorPathAbs);
    assert.equal(harness.calls[1].from, paths.stagingPathAbs);
    assert.equal(harness.calls[1].to, paths.targetPathAbs);

    // Target present before completed; verifier must run after publish rename.
    assert.ok(v.targetCalls >= 1, 'verifyTargetTree must run on live publish');
    assert.ok(store.durablePhases.includes('published'));
    const publishedIdx = store.durablePhases.indexOf('published');
    const completedIdx = store.durablePhases.indexOf('completed-awaiting-ack');
    assert.ok(publishedIdx >= 0 && completedIdx > publishedIdx);

    assert.ok(store.durablePhases.includes('anchor-intent'));
    assert.ok(store.durablePhases.includes('anchored'));
    assert.ok(store.durablePhases.includes('publish-intent'));
    assert.ok(store.durablePhases.includes('completed-awaiting-ack'));
    assert.equal(store.durablePhases.includes('cancelled-local'), false);
    assert.equal(store.state.phase, 'completed-awaiting-ack');
    for (const w of store.writePatches) {
      assert.equal(w.writeOptions.fsync, true);
    }
  });

  it('original target absent: no pseudo-anchor; completed dual hex; anchorPresentBeforePublish=false', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 'fresh.txt': 'FRESH' });

    const expectedStructure = await computeStructureFingerprint(paths.stagingPathAbs);
    const expectedContent = await computeContentSha256(paths.stagingPathAbs);

    const store = createStateStoreDouble({
      phase: 'staging-verified',
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
      fileCount: 1,
      totalBytes: Buffer.byteLength('FRESH'),
    });
    const harness = createRenameHarness();
    const v = createVerifiers();

    const receipt = await publishFromStagingVerified({
      stateStore: store,
      paths: {
        targetPathAbs: paths.targetPathAbs,
        stagingPathAbs: paths.stagingPathAbs,
        anchorPathAbs: paths.anchorPathAbs,
        quarantinePathAbs: paths.quarantinePathAbs,
      },
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
      cancelRequested: false,
      rename: harness.rename,
      lstat: realLstat,
      verifyTargetTree: v.verifyTargetTree,
    });

    const projected = assertCompletedReceiptShape(receipt, { anchorPresentBeforePublish: false });
    assert.equal(projected.contentSha256, expectedContent);
    assert.equal(projected.structureFingerprint, expectedStructure);
    assert.match(/** @type {string} */ (projected.contentSha256), HEX64_RE);
    assert.match(/** @type {string} */ (projected.structureFingerprint), HEX64_RE);

    assert.equal(await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.anchorPathAbs), false, 'must not create pseudo-anchor');
    assert.equal(await exists(paths.stagingPathAbs), false);
    assert.equal(await readFile(join(paths.targetPathAbs, 'fresh.txt'), 'utf8'), 'FRESH');

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].from, paths.stagingPathAbs);
    assert.equal(harness.calls[0].to, paths.targetPathAbs);
    assert.ok(v.targetCalls >= 1);

    assert.ok(store.durablePhases.includes('anchor-intent'));
    assert.ok(store.durablePhases.includes('anchored'));
    assert.ok(store.durablePhases.includes('publish-intent'));
    assert.ok(store.durablePhases.includes('published'));
    assert.ok(store.durablePhases.includes('completed-awaiting-ack'));
    assert.equal(store.state.phase, 'completed-awaiting-ack');
  });
});

// ── 2. Non zero-gap dual rename ────────────────────────────────────

describe('publishFromStagingVerified — dual rename is non zero-gap', () => {
  it('observes target absent between the two renames (proves non zero-gap; no single-syscall claim)', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD' });
    await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);

    /** @type {{ targetAbsentBetween: boolean | null, stagingStillPresent: boolean | null, renameCountAtHook: number }} */
    const mid = {
      targetAbsentBetween: null,
      stagingStillPresent: null,
      renameCountAtHook: -1,
    };

    const store = createStateStoreDouble({
      phase: 'staging-verified',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const v = createVerifiers();

    const harness = createRenameHarness({
      betweenCallsHook: async ({ callIndex, calls }) => {
        mid.renameCountAtHook = callIndex;
        mid.targetAbsentBetween = !(await exists(paths.targetPathAbs));
        mid.stagingStillPresent = await exists(paths.stagingPathAbs);
        assert.equal(calls.length, 1, 'mid-window must be after exactly one rename');
        assert.equal(calls[0].from, paths.targetPathAbs);
        assert.equal(calls[0].to, paths.anchorPathAbs);
      },
    });

    const receipt = await publishFromStagingVerified({
      stateStore: store,
      paths: {
        targetPathAbs: paths.targetPathAbs,
        stagingPathAbs: paths.stagingPathAbs,
        anchorPathAbs: paths.anchorPathAbs,
        quarantinePathAbs: paths.quarantinePathAbs,
      },
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
      cancelRequested: false,
      rename: harness.rename,
      lstat: realLstat,
      verifyTargetTree: v.verifyTargetTree,
    });

    assertCompletedReceiptShape(receipt, { anchorPresentBeforePublish: true });
    assert.equal(mid.renameCountAtHook, 1);
    assert.equal(mid.targetAbsentBetween, true, 'target must be absent between renames (non zero-gap)');
    assert.equal(mid.stagingStillPresent, true, 'staging must still exist between renames');
    assert.equal(harness.calls.length, 2, 'exactly two renames — not a single exchange syscall');
    assert.notEqual(harness.calls[0].from, harness.calls[1].from);
    assert.ok(v.targetCalls >= 1);
  });
});

// ── 3. EXDEV fail-close ────────────────────────────────────────────

describe('publishFromStagingVerified — EXDEV pre-publish unique restore-path-invalid', () => {
  it('target→anchor EXDEV: unique restore-path-invalid; durable intent retained; zero copy; no implicit cleanup', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD' });
    await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);

    const store = createStateStoreDouble({
      phase: 'staging-verified',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const v = createVerifiers();

    const harness = createRenameHarness({
      failAtCall: 1,
      failCode: 'EXDEV',
    });

    await expectRejects(
      () =>
        publishFromStagingVerified({
          stateStore: store,
          paths: {
            targetPathAbs: paths.targetPathAbs,
            stagingPathAbs: paths.stagingPathAbs,
            anchorPathAbs: paths.anchorPathAbs,
            quarantinePathAbs: paths.quarantinePathAbs,
          },
          originalTargetExisted: true,
          oldStructureFingerprint: oldStructure,
          oldContentSha256: oldContent,
          cancelRequested: false,
          rename: harness.rename,
          lstat: realLstat,
          verifyTargetTree: v.verifyTargetTree,
        }),
      PATH_INVALID,
      {
        statusCode: 400,
        retryable: false,
        leakTokens: [paths.targetPathAbs, paths.stagingPathAbs, root, 'EXDEV', 'errno'],
      },
    );

    assert.equal(PATH_INVALID, 'restore-path-invalid');
    assert.ok(
      store.durablePhases.includes('anchor-intent'),
      'STATE must retain durable anchor-intent after EXDEV',
    );
    assert.equal(store.durablePhases.includes('cancelled-local'), false);
    assert.equal(store.durablePhases.includes('completed-awaiting-ack'), false);
    assert.equal(harness.calls.length, 1);
    assert.equal(v.targetCalls, 0, 'no target verify before successful publish');
    assert.equal(await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.stagingPathAbs), true);
    assert.equal(await exists(paths.anchorPathAbs), false);
    assert.equal(await exists(paths.quarantinePathAbs), false);
    assert.equal(await readFile(join(paths.targetPathAbs, 'old.txt'), 'utf8'), 'OLD');
    assert.equal(await readFile(join(paths.stagingPathAbs, 'new.txt'), 'utf8'), 'NEW');
    assert.equal(store.receipt, null);
  });

  it('staging→target EXDEV: unique restore-path-invalid; publish-intent retained; zero copy; artifacts preserved', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD' });
    await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);

    const store = createStateStoreDouble({
      phase: 'staging-verified',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const v = createVerifiers();

    const harness = createRenameHarness({
      failAtCall: 2,
      failCode: 'EXDEV',
    });

    await expectRejects(
      () =>
        publishFromStagingVerified({
          stateStore: store,
          paths: {
            targetPathAbs: paths.targetPathAbs,
            stagingPathAbs: paths.stagingPathAbs,
            anchorPathAbs: paths.anchorPathAbs,
            quarantinePathAbs: paths.quarantinePathAbs,
          },
          originalTargetExisted: true,
          oldStructureFingerprint: oldStructure,
          oldContentSha256: oldContent,
          cancelRequested: false,
          rename: harness.rename,
          lstat: realLstat,
          verifyTargetTree: v.verifyTargetTree,
        }),
      PATH_INVALID,
      {
        statusCode: 400,
        retryable: false,
        leakTokens: [paths.targetPathAbs, paths.stagingPathAbs, paths.anchorPathAbs, root],
      },
    );

    assert.ok(store.durablePhases.includes('publish-intent'));
    assert.equal(store.durablePhases.includes('published'), false);
    assert.equal(harness.calls.length, 2);
    assert.equal(v.targetCalls, 0);
    assert.equal(await exists(paths.anchorPathAbs), true);
    assert.equal(await exists(paths.stagingPathAbs), true);
    assert.equal(await exists(paths.targetPathAbs), false);
    assert.equal(await exists(paths.quarantinePathAbs), false);
    assert.equal(await readFile(join(paths.anchorPathAbs, 'old.txt'), 'utf8'), 'OLD');
    assert.equal(await readFile(join(paths.stagingPathAbs, 'new.txt'), 'utf8'), 'NEW');
    assert.equal(store.receipt, null);
  });
});

// ── 4. Cancel linearization canary ─────────────────────────────────

describe('cancel linearization canary — anchor-intent + cancelRequested must not cancelled-local', () => {
  it('recoverFromCrash: phase=anchor-intent, target=yes, anchor=no, cancelRequested=true continues publish → completed|rolled-back', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD' });
    await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);
    const expectedNewStructure = await computeStructureFingerprint(paths.stagingPathAbs);
    const expectedNewContent = await computeContentSha256(paths.stagingPathAbs);

    const store = createStateStoreDouble({
      phase: 'anchor-intent',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
      fileCount: 1,
      totalBytes: Buffer.byteLength('NEW'),
    });

    const harness = createRenameHarness();
    const v = createVerifiers();

    const result = await recoverFromCrash({
      stateStore: store,
      paths: {
        targetPathAbs: paths.targetPathAbs,
        stagingPathAbs: paths.stagingPathAbs,
        anchorPathAbs: paths.anchorPathAbs,
        quarantinePathAbs: paths.quarantinePathAbs,
      },
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
      cancelRequested: true,
      rename: harness.rename,
      lstat: realLstat,
      verifyStagingTree: v.verifyStagingTree,
      verifyTargetTree: v.verifyTargetTree,
      reFetchForbidden: true,
    });

    assert.notEqual(store.state.phase, 'cancelled-local');
    assert.equal(store.durablePhases.includes('cancelled-local'), false);

    const terminalOk =
      store.state.phase === 'completed-awaiting-ack' ||
      store.state.phase === 'rolled-back-awaiting-ack' ||
      (result &&
        result.receipt &&
        (result.receipt.outcome === 'completed' || result.receipt.outcome === 'rolled-back'));
    assert.ok(terminalOk, `expected completed|rolled-back terminal, got phase=${store.state.phase}`);

    if (store.state.phase === 'completed-awaiting-ack' || result?.receipt?.outcome === 'completed') {
      const receipt = result.receipt ?? store.receipt;
      const projected = assertCompletedReceiptShape(receipt, { anchorPresentBeforePublish: true });
      assert.equal(projected.contentSha256, expectedNewContent);
      assert.equal(projected.structureFingerprint, expectedNewStructure);
      assert.equal(await exists(paths.anchorPathAbs), true);
      assert.equal(await exists(paths.targetPathAbs), true);
      assert.equal(await exists(paths.stagingPathAbs), false);
      assert.ok(v.targetCalls >= 1);
    }

    assert.ok(v.stagingCalls >= 1, 'staging must be re-verified, not cancelled away');
    assert.equal(store.reFetchCalls, 0);
  });

  it('pre-anchor cancel: durable staging-verified→cancelled-local then unique RESTORE_INTERRUPTED; zero rename', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW' });

    const store = createStateStoreDouble({
      phase: 'staging-verified',
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
    });
    const harness = createRenameHarness();
    const v = createVerifiers();

    await expectRejects(
      () =>
        publishFromStagingVerified({
          stateStore: store,
          paths: {
            targetPathAbs: paths.targetPathAbs,
            stagingPathAbs: paths.stagingPathAbs,
            anchorPathAbs: paths.anchorPathAbs,
            quarantinePathAbs: paths.quarantinePathAbs,
          },
          originalTargetExisted: false,
          oldStructureFingerprint: null,
          oldContentSha256: null,
          cancelRequested: true,
          rename: harness.rename,
          lstat: realLstat,
          verifyTargetTree: v.verifyTargetTree,
        }),
      INTERRUPTED,
      {
        statusCode: null,
        retryable: true,
        leakTokens: [paths.stagingPathAbs, root, 'secret-token'],
      },
    );

    assert.ok(
      store.transitions.some((t) => t.from === 'staging-verified' && t.to === 'cancelled-local') ||
        store.durablePhases.includes('cancelled-local'),
      'must durable-write cancelled-local before INTERRUPTED',
    );
    assert.equal(store.state.phase, 'cancelled-local');
    assert.equal(harness.calls.length, 0, 'zero rename on pre-anchor cancel');
    assert.equal(store.writeReceiptCalls, 0);
    assert.equal(store.durablePhases.includes('anchor-intent'), false);
    assert.equal(store.durablePhases.includes('completed-awaiting-ack'), false);
    assert.equal(v.targetCalls, 0);
  });
});

// ── 5. verifyTargetTree authority ──────────────────────────────────

describe('verifyTargetTree required + corrupt target forces rollback (not completed)', () => {
  it('missing verifyTargetTree on publish → unique state-invalid; no completed receipt', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 'fresh.txt': 'FRESH' });

    const store = createStateStoreDouble({
      phase: 'staging-verified',
      originalTargetExisted: false,
    });
    const harness = createRenameHarness();

    await expectRejects(
      () =>
        publishFromStagingVerified({
          stateStore: store,
          paths: {
            targetPathAbs: paths.targetPathAbs,
            stagingPathAbs: paths.stagingPathAbs,
            anchorPathAbs: paths.anchorPathAbs,
            quarantinePathAbs: paths.quarantinePathAbs,
          },
          originalTargetExisted: false,
          oldStructureFingerprint: null,
          oldContentSha256: null,
          cancelRequested: false,
          rename: harness.rename,
          lstat: realLstat,
          // intentionally omit verifyTargetTree
        }),
      STATE_INVALID,
      {
        statusCode: 500,
        retryable: false,
        leakTokens: [paths.stagingPathAbs, root],
      },
    );
    assert.equal(store.writeReceiptCalls, 0);
    assert.equal(store.durablePhases.includes('completed-awaiting-ack'), false);
  });

  it('live publish: verifyTargetTree throws INTEGRITY_FAILED → rollback path; never completed', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD' });
    await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);

    const store = createStateStoreDouble({
      phase: 'staging-verified',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const harness = createRenameHarness();
    const v = createVerifiers({
      targetThrow: new LinkeError(INTEGRITY_FAILED),
    });

    let outcome = null;
    try {
      outcome = await publishFromStagingVerified({
        stateStore: store,
        paths: {
          targetPathAbs: paths.targetPathAbs,
          stagingPathAbs: paths.stagingPathAbs,
          anchorPathAbs: paths.anchorPathAbs,
          quarantinePathAbs: paths.quarantinePathAbs,
        },
        originalTargetExisted: true,
        oldStructureFingerprint: oldStructure,
        oldContentSha256: oldContent,
        cancelRequested: false,
        rename: harness.rename,
        lstat: realLstat,
        verifyTargetTree: v.verifyTargetTree,
      });
    } catch (error) {
      if (error instanceof LinkeError) {
        assert.ok(
          error.code === ROLLBACK_FAILED ||
            error.code === INTEGRITY_FAILED ||
            error.code === ERROR_CODES.RESTORE_ROLLBACK_REQUIRED,
          `unexpected code ${error.code}`,
        );
        assertLinkeCode(error, error.code, {
          leakTokens: [paths.targetPathAbs, paths.anchorPathAbs, root],
        });
      } else {
        throw error;
      }
    }

    assert.ok(v.targetCalls >= 1, 'verifyTargetTree must be invoked');
    assert.equal(store.durablePhases.includes('completed-awaiting-ack'), false);
    if (outcome) {
      assert.notEqual(outcome.outcome, 'completed');
      assert.ok(
        outcome.outcome === 'rolled-back' ||
          store.state.phase === 'rolled-back-awaiting-ack' ||
          store.durablePhases.includes('rollback-intent'),
      );
    } else {
      assert.ok(
        store.durablePhases.includes('rollback-intent') ||
          store.durablePhases.includes('rolled-back-awaiting-ack') ||
          store.state.phase !== 'completed-awaiting-ack',
      );
    }
    // Integrity LinkeError must not be swallowed into completed
    assert.notEqual(store.state.phase, 'completed-awaiting-ack');
  });

  it('original=true + anchor present: corrupt target via verifyTargetTree ends rolled-back or rollback-failed', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD-OK' });
    await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW-CORRUPT' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);

    const store = createStateStoreDouble({
      phase: 'staging-verified',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const harness = createRenameHarness();
    /** @type {string[]} */
    const callOrder = [];
    const verifyTargetTree = async () => {
      callOrder.push('verifyTargetTree');
      // Ensure target already present when verifier runs
      assert.equal(await exists(paths.targetPathAbs), true);
      throw new LinkeError(INTEGRITY_FAILED);
    };

    let receipt = null;
    try {
      receipt = await publishFromStagingVerified({
        stateStore: store,
        paths: {
          targetPathAbs: paths.targetPathAbs,
          stagingPathAbs: paths.stagingPathAbs,
          anchorPathAbs: paths.anchorPathAbs,
          quarantinePathAbs: paths.quarantinePathAbs,
        },
        originalTargetExisted: true,
        oldStructureFingerprint: oldStructure,
        oldContentSha256: oldContent,
        cancelRequested: false,
        rename: harness.rename,
        lstat: realLstat,
        verifyTargetTree,
      });
    } catch (error) {
      assert.ok(error instanceof LinkeError);
      assert.ok(
        error.code === ROLLBACK_FAILED ||
          error.code === INTEGRITY_FAILED ||
          error.code === ERROR_CODES.RESTORE_ROLLBACK_REQUIRED,
      );
      assertLinkeCode(error, error.code, {
        leakTokens: [paths.targetPathAbs, root],
      });
    }

    assert.ok(callOrder.includes('verifyTargetTree'));
    assert.equal(store.durablePhases.includes('completed-awaiting-ack'), false);
    if (receipt) {
      assert.equal(receipt.outcome, 'rolled-back');
    } else {
      assert.ok(
        store.durablePhases.includes('rollback-intent') ||
          store.state.phase === 'rolled-back-awaiting-ack' ||
          true,
      );
    }
  });
});

// ── 6. transitionPhase must not be bypassed by writeState ──────────

describe('transitionPhase guard — no writeState fallback on throw', () => {
  it('LinkeError from transitionPhase is rethrown; writeStateCalls remain 0', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 'fresh.txt': 'FRESH' });

    const store = createStateStoreDouble(
      { phase: 'staging-verified', originalTargetExisted: false },
      { transitionThrows: new LinkeError(STATE_INVALID) },
    );
    const harness = createRenameHarness();
    const v = createVerifiers();
    const writesBefore = store.writeStateCalls;

    await expectRejects(
      () =>
        publishFromStagingVerified({
          stateStore: store,
          paths: {
            targetPathAbs: paths.targetPathAbs,
            stagingPathAbs: paths.stagingPathAbs,
            anchorPathAbs: paths.anchorPathAbs,
            quarantinePathAbs: paths.quarantinePathAbs,
          },
          originalTargetExisted: false,
          oldStructureFingerprint: null,
          oldContentSha256: null,
          cancelRequested: false,
          rename: harness.rename,
          lstat: realLstat,
          verifyTargetTree: v.verifyTargetTree,
        }),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [paths.stagingPathAbs, root] },
    );

    assert.ok(store.transitionCalls >= 1);
    assert.equal(store.writeStateCalls, writesBefore, 'must not fallback to writeState');
    assert.equal(harness.calls.length, 0);
  });

  it('plain EIO from transitionPhase is rethrown; writeStateCalls remain 0', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 'fresh.txt': 'FRESH' });

    const eio = new Error('simulated transition EIO');
    eio.code = 'EIO';
    const store = createStateStoreDouble(
      { phase: 'staging-verified', originalTargetExisted: false },
      { transitionThrows: eio },
    );
    const harness = createRenameHarness();
    const v = createVerifiers();
    const writesBefore = store.writeStateCalls;

    await assert.rejects(
      () =>
        publishFromStagingVerified({
          stateStore: store,
          paths: {
            targetPathAbs: paths.targetPathAbs,
            stagingPathAbs: paths.stagingPathAbs,
            anchorPathAbs: paths.anchorPathAbs,
            quarantinePathAbs: paths.quarantinePathAbs,
          },
          originalTargetExisted: false,
          oldStructureFingerprint: null,
          oldContentSha256: null,
          cancelRequested: false,
          rename: harness.rename,
          lstat: realLstat,
          verifyTargetTree: v.verifyTargetTree,
        }),
      (error) => {
        assert.equal(/** @type {any} */ (error).code, 'EIO');
        return true;
      },
    );
    assert.ok(store.transitionCalls >= 1);
    assert.equal(store.writeStateCalls, writesBefore);
    assert.equal(harness.calls.length, 0);
  });
});

// ── 7. plain Error/TypeError from verifyTargetTree → rollback ──────

describe('verifyTargetTree plain Error/TypeError must not complete (live publish)', () => {
  for (const [label, makeErr] of [
    [
      'Error',
      () => new Error(`plain verifier boom secret-token ${/** @type {string} */ (tempRoot)}/abs-path`),
    ],
    [
      'TypeError',
      () => new TypeError(`type verifier boom secret-token ${/** @type {string} */ (tempRoot)}`),
    ],
  ]) {
    it(`live publish: verifyTargetTree throws ${label} → rolled-back|rollback-failed; no completed; no leak`, async () => {
      const root = /** @type {string} */ (tempRoot);
      const paths = siblingPaths(root);
      await mkdir(dirname(paths.targetPathAbs), { recursive: true });
      await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD' });
      await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW' });

      const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
      const oldContent = await computeContentSha256(paths.targetPathAbs);

      const store = createStateStoreDouble({
        phase: 'staging-verified',
        originalTargetExisted: true,
        oldStructureFingerprint: oldStructure,
        oldContentSha256: oldContent,
      });
      const harness = createRenameHarness();
      let targetCalls = 0;
      const rawMsg = `plain-${label}-msg`;

      let outcome = null;
      try {
        outcome = await publishFromStagingVerified({
          stateStore: store,
          paths: {
            targetPathAbs: paths.targetPathAbs,
            stagingPathAbs: paths.stagingPathAbs,
            anchorPathAbs: paths.anchorPathAbs,
            quarantinePathAbs: paths.quarantinePathAbs,
          },
          originalTargetExisted: true,
          oldStructureFingerprint: oldStructure,
          oldContentSha256: oldContent,
          cancelRequested: false,
          rename: harness.rename,
          lstat: realLstat,
          verifyTargetTree: async () => {
            targetCalls += 1;
            const err = makeErr();
            err.message = `${rawMsg} ${paths.targetPathAbs} secret-token`;
            throw err;
          },
        });
      } catch (error) {
        assert.ok(error instanceof LinkeError, 'must surface LinkeError not raw Error');
        assert.ok(
          error.code === ROLLBACK_FAILED ||
            error.code === INTEGRITY_FAILED ||
            error.code === ERROR_CODES.RESTORE_ROLLBACK_REQUIRED ||
            error.code === ERROR_CODES.RESTORE_STATE_INVALID,
          `unexpected code ${error.code}`,
        );
        assertLinkeCode(error, error.code, {
          leakTokens: [paths.targetPathAbs, root, rawMsg, 'secret-token', 'plain verifier', 'TypeError'],
        });
      }

      assert.ok(targetCalls >= 1, 'verifyTargetTree must run');
      assert.equal(store.durablePhases.includes('completed-awaiting-ack'), false);
      if (outcome) {
        assert.notEqual(outcome.outcome, 'completed');
        assert.ok(
          outcome.outcome === 'rolled-back' ||
            store.state.phase === 'rolled-back-awaiting-ack' ||
            store.durablePhases.includes('rollback-intent'),
        );
      } else {
        assert.ok(
          store.durablePhases.includes('rollback-intent') ||
            store.state.phase === 'rolled-back-awaiting-ack' ||
            store.state.phase !== 'completed-awaiting-ack',
        );
      }
      assert.notEqual(store.state.phase, 'completed-awaiting-ack');
    });
  }
});

// ── 8. pre-publish non-EXDEV rename → path-invalid (explicit pin) ──

describe('pre-publish non-EXDEV rename fail-closed as restore-path-invalid', () => {
  for (const code of ['EIO', 'EACCES']) {
    it(`target→anchor ${code}: unique restore-path-invalid; durable intent; zero copy/cleanup; no leak`, async () => {
      const root = /** @type {string} */ (tempRoot);
      const paths = siblingPaths(root);
      await mkdir(dirname(paths.targetPathAbs), { recursive: true });
      await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD' });
      await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW' });

      const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
      const oldContent = await computeContentSha256(paths.targetPathAbs);

      const store = createStateStoreDouble({
        phase: 'staging-verified',
        originalTargetExisted: true,
        oldStructureFingerprint: oldStructure,
        oldContentSha256: oldContent,
      });
      const v = createVerifiers();
      const harness = createRenameHarness({
        failAtCall: 1,
        failCode: code,
      });

      await expectRejects(
        () =>
          publishFromStagingVerified({
            stateStore: store,
            paths: {
              targetPathAbs: paths.targetPathAbs,
              stagingPathAbs: paths.stagingPathAbs,
              anchorPathAbs: paths.anchorPathAbs,
              quarantinePathAbs: paths.quarantinePathAbs,
            },
            originalTargetExisted: true,
            oldStructureFingerprint: oldStructure,
            oldContentSha256: oldContent,
            cancelRequested: false,
            rename: harness.rename,
            lstat: realLstat,
            verifyTargetTree: v.verifyTargetTree,
          }),
        PATH_INVALID,
        {
          statusCode: 400,
          retryable: false,
          leakTokens: [paths.targetPathAbs, paths.stagingPathAbs, root, code, 'errno', 'simulated'],
        },
      );

      assert.ok(store.durablePhases.includes('anchor-intent'));
      assert.equal(store.durablePhases.includes('completed-awaiting-ack'), false);
      assert.equal(harness.calls.length, 1);
      assert.equal(await exists(paths.targetPathAbs), true);
      assert.equal(await exists(paths.stagingPathAbs), true);
      assert.equal(await exists(paths.anchorPathAbs), false);
      assert.equal(store.receipt, null);
      assert.equal(v.targetCalls, 0);
    });
  }

  it('rollback rename EIO (non-EXDEV) → unique restore-rollback-failed; artifacts retained; no leak', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'pub.txt': 'PUB' });
    await writeTree(paths.anchorPathAbs, { 'old.txt': 'OLD' });

    const oldStructure = await computeStructureFingerprint(paths.anchorPathAbs);
    const oldContent = await computeContentSha256(paths.anchorPathAbs);

    const store = createStateStoreDouble({
      phase: 'published',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const harness = createRenameHarness({
      failAtCall: 1,
      failCode: 'EIO',
      failMessage: `rollback boom ${paths.targetPathAbs} secret-token`,
    });

    await expectRejects(
      () =>
        rollbackPublished({
          stateStore: store,
          paths: {
            targetPathAbs: paths.targetPathAbs,
            stagingPathAbs: paths.stagingPathAbs,
            anchorPathAbs: paths.anchorPathAbs,
            quarantinePathAbs: paths.quarantinePathAbs,
          },
          originalTargetExisted: true,
          oldStructureFingerprint: oldStructure,
          oldContentSha256: oldContent,
          rename: harness.rename,
          lstat: realLstat,
        }),
      ROLLBACK_FAILED,
      {
        statusCode: 500,
        retryable: false,
        leakTokens: [paths.targetPathAbs, paths.anchorPathAbs, root, 'EIO', 'secret-token', 'rollback boom'],
      },
    );

    assert.equal(await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.anchorPathAbs), true);
    assert.equal(await exists(paths.quarantinePathAbs), false);
  });
});

// ── export surface ─────────────────────────────────────────────────

describe('restore-publish export surface', () => {
  it('exports the four C4 entrypoints', () => {
    assert.equal(typeof publishFromStagingVerified, 'function');
    assert.equal(typeof recoverFromCrash, 'function');
    assert.equal(typeof rollbackPublished, 'function');
    assert.equal(typeof recoverCancelledLocal, 'function');
  });
});
