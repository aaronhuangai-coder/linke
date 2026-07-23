/**
 * RED/GREEN tests for G0c C4 crash truth tables (P2-1..P2-4; design §§11.3–11.8)
 * + GLM-hardened matrices / verifiers / cleanup / tombstone replay.
 *
 * Independent file — must not merge into restore-publish.test.js.
 * Table-driven matrices with independent per-row asserts.
 * Do NOT scan Error.stack; scan public LinkeError wire fields only.
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
  symlink,
  writeFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import {
  computeContentSha256,
  computeStructureFingerprint,
} from '../src/restore-fingerprint.js';
import { projectCleanupReceipt, projectReceiptObject } from '../src/restore-schemas.js';
import {
  recoverFromCrash,
  rollbackPublished,
  recoverCancelledLocal,
  publishFromStagingVerified,
} from '../src/restore-publish.js';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440001';
const DEVICE_ID = 'device-alpha-001';
const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-446655440002';
const DIGEST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RELATIVE_TARGET = 'docs/restore-target';
const CLEANUP_ID = '550e8400-e29b-41d4-a716-446655440031';
const RECEIPT_ID = '550e8400-e29b-41d4-a716-446655440021';
const HEX64_RE = /^[a-f0-9]{64}$/;

const STATE_INVALID = ERROR_CODES.RESTORE_STATE_INVALID;
const PUBLISH_CONFLICT = ERROR_CODES.RESTORE_PUBLISH_CONFLICT;
const ROLLBACK_FAILED = ERROR_CODES.RESTORE_ROLLBACK_FAILED;
const INTEGRITY_FAILED = ERROR_CODES.RESTORE_INTEGRITY_FAILED;

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
 * @param {object} [initial]
 * @param {{
 *   transitionThrows?: Error | LinkeError | (() => Error),
 *   crashAfterCleanupReceiptWrite?: boolean,
 *   crashAfterTerminalPhaseWithoutReceipt?: boolean,
 *   omitWriteState?: boolean,
 * }} [hooks]
 * hooks.crashAfterTerminalPhaseWithoutReceipt: crash after fsynced terminal phase write when receipt absent (P1).
 * hooks.omitWriteState: transitionPhase-only durability shape (no writeState).
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
    phase: 'anchored',
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
  /** @type {Array<{ kind: string, phase?: string | null }>} */
  const eventLog = [];
  /** @type {object | null} */
  let receipt = null;
  /** @type {object | null} */
  let cleanupReceipt = null;
  let reFetchCalls = 0;
  let writeStateCalls = 0;
  let writeReceiptCalls = 0;
  let writeCleanupReceiptCalls = 0;
  let rmCalls = 0;
  let transitionCalls = 0;

  /** @type {Record<string, unknown>} */
  const store = {
    durablePhases,
    transitions,
    writePatches,
    eventLog,
    get state() {
      return state;
    },
    set phase(p) {
      state = { ...state, phase: p };
      durablePhases.push(p);
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
    get rmCalls() {
      return rmCalls;
    },
    get transitionCalls() {
      return transitionCalls;
    },
    noteReFetch() {
      reFetchCalls += 1;
    },
    noteRm() {
      rmCalls += 1;
    },
    async readState() {
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
      eventLog.push({ kind: 'transitionPhase', phase: to });
      if (hooks.transitionThrows) {
        const err =
          typeof hooks.transitionThrows === 'function'
            ? hooks.transitionThrows()
            : hooks.transitionThrows;
        throw err;
      }
      assert.equal(state.phase, from, `transitionPhase expected from=${from} got ${state.phase}`);
      transitions.push({ from, to });
      state = { ...state, phase: to, updatedAt: '2026-07-23T12:00:01.000Z' };
      durablePhases.push(to);
      return Object.freeze({ ...state });
    },
    async writeReceipt(_taskId, r) {
      writeReceiptCalls += 1;
      eventLog.push({ kind: 'writeReceipt', phase: /** @type {string} */ (state.phase) });
      receipt = r;
      if (r && typeof r === 'object' && /** @type {any} */ (r).receiptId) {
        state = { ...state, receiptId: /** @type {any} */ (r).receiptId };
      }
    },
    async writeCleanupReceipt(_taskId, r) {
      writeCleanupReceiptCalls += 1;
      eventLog.push({ kind: 'writeCleanupReceipt', phase: /** @type {string} */ (state.phase) });
      cleanupReceipt = r;
      if (r && typeof r === 'object' && /** @type {any} */ (r).cleanupId) {
        state = { ...state, cleanupId: /** @type {any} */ (r).cleanupId };
      }
      if (hooks.crashAfterCleanupReceiptWrite) {
        const err = new Error('simulated crash after cleanup receipt');
        err.code = 'EIO';
        throw err;
      }
    },
  };

  if (!hooks.omitWriteState) {
    store.writeState = async (_taskId, patch, writeOptions) => {
      writeStateCalls += 1;
      assert.ok(writeOptions && writeOptions.fsync === true, 'STATE writes require fsync:true');
      writePatches.push({ patch: { ...patch }, writeOptions: { ...writeOptions } });
      state = { ...state, ...patch };
      if (typeof patch.phase === 'string' && durablePhases[durablePhases.length - 1] !== patch.phase) {
        durablePhases.push(patch.phase);
      }
      eventLog.push({
        kind: 'writeState',
        phase: typeof patch.phase === 'string' ? patch.phase : null,
      });
      // P1 fault inject: terminal phase durable while receipt still absent.
      if (
        hooks.crashAfterTerminalPhaseWithoutReceipt &&
        patch &&
        patch.phase === 'rolled-back-awaiting-ack' &&
        receipt === null
      ) {
        const err = new Error('simulated crash after terminal phase before receipt');
        err.code = 'EIO';
        throw err;
      }
      return Object.freeze({ ...state });
    };
  }

  return store;
}

/**
 * @param {{
 *   real?: typeof realRename,
 *   failAtCall?: number,
 *   failCode?: string,
 *   failMessage?: string,
 * }} [opts]
 */
function createRenameHarness(opts = {}) {
  const real = opts.real ?? realRename;
  /** @type {Array<{ from: string, to: string }>} */
  const calls = [];
  let callIndex = 0;
  const rename = async (from, to) => {
    callIndex += 1;
    calls.push({ from, to });
    if (opts.failAtCall !== undefined && callIndex === opts.failAtCall) {
      const err = new Error(opts.failMessage ?? 'simulated rename failure');
      err.code = opts.failCode ?? 'EIO';
      throw err;
    }
    await real(from, to);
  };
  return {
    calls,
    rename,
    get callCount() {
      return callIndex;
    },
  };
}

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
 * @param {string} abs
 * @param {'dir' | 'file' | 'symlink' | 'absent'} kind
 * @param {string} [marker]
 */
async function materialize(abs, kind, marker = 'x') {
  if (kind === 'absent') return;
  if (kind === 'dir') {
    await mkdir(abs, { recursive: true });
    await writeFile(join(abs, '.marker'), marker);
    return;
  }
  if (kind === 'file') {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, marker);
    return;
  }
  if (kind === 'symlink') {
    await mkdir(dirname(abs), { recursive: true });
    const target = join(
      dirname(abs),
      `.symlink-target-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(target, { recursive: true });
    await symlink(target, abs);
  }
}

/** Build exact 32-row anchored matrix. */
function buildAnchoredRows() {
  /** @type {Array<'absent' | 'dir' | 'file' | 'symlink'>} */
  const kinds = ['absent', 'dir', 'file', 'symlink'];
  /** @type {Array<{ name: string, original: boolean, target: string, anchor: string, legal: boolean }>} */
  const rows = [];
  for (const original of [true, false]) {
    for (const target of kinds) {
      for (const anchor of kinds) {
        const legal = original
          ? target === 'absent' && anchor === 'dir'
          : target === 'absent' && anchor === 'absent';
        rows.push({
          name: `orig${original ? 'T' : 'F'} t=${target} a=${anchor}`,
          original,
          target,
          anchor,
          legal,
        });
      }
    }
  }
  return Object.freeze(rows);
}

/** Build exact 16-row binary T×A×Q × original matrix (staging always false). */
function buildRollbackBinaryRows() {
  /** @type {Array<{ name: string, original: boolean, target: boolean, anchor: boolean, quarantine: boolean, staging: boolean, expect: 'progress' | 'state-invalid' }>} */
  const rows = [];
  for (const original of [true, false]) {
    for (const t of [false, true]) {
      for (const a of [false, true]) {
        for (const q of [false, true]) {
          let expect = 'state-invalid';
          if (original) {
            if ((t && a && !q) || (!t && a && q)) expect = 'progress';
          } else if ((t && !a && !q) || (!t && !a && q)) {
            expect = 'progress';
          }
          rows.push({
            name: `ri orig${original ? 'T' : 'F'} T${t ? 1 : 0} A${a ? 1 : 0} Q${q ? 1 : 0} S0`,
            original,
            target: t,
            anchor: a,
            quarantine: q,
            staging: false,
            expect,
          });
        }
      }
    }
  }
  return Object.freeze(rows);
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'linke-crash-'));
});

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

// ── P2-2: anchored existence full matrix (exact 32) ────────────────

describe('P2-2 anchored existence matrix — exact 32 rows', () => {
  const ANCHORED_ROWS = buildAnchoredRows();

  it('matrix size is exactly 32 with only two legal rows', () => {
    assert.equal(ANCHORED_ROWS.length, 32);
    assert.equal(ANCHORED_ROWS.filter((r) => r.legal).length, 2);
    assert.ok(ANCHORED_ROWS.some((r) => r.original && r.target === 'absent' && r.anchor === 'dir' && r.legal));
    assert.ok(ANCHORED_ROWS.some((r) => !r.original && r.target === 'absent' && r.anchor === 'absent' && r.legal));
  });

  for (const row of ANCHORED_ROWS) {
    it(`anchored row [${row.name}] legal=${row.legal}`, async () => {
      const root = /** @type {string} */ (tempRoot);
      const paths = siblingPaths(root);
      await mkdir(dirname(paths.targetPathAbs), { recursive: true });

      await materialize(paths.targetPathAbs, /** @type {any} */ (row.target), 'tgt');
      await materialize(paths.anchorPathAbs, /** @type {any} */ (row.anchor), 'anc');
      await writeTree(paths.stagingPathAbs, { 'staged.txt': 'STAGED' });

      let oldStructure = null;
      let oldContent = null;
      if (row.original && row.anchor === 'dir') {
        oldStructure = await computeStructureFingerprint(paths.anchorPathAbs);
        oldContent = await computeContentSha256(paths.anchorPathAbs);
      }

      const store = createStateStoreDouble({
        phase: 'anchored',
        originalTargetExisted: row.original,
        oldStructureFingerprint: oldStructure,
        oldContentSha256: oldContent,
      });
      const harness = createRenameHarness();
      const v = createVerifiers();

      const ctx = {
        stateStore: store,
        paths: {
          targetPathAbs: paths.targetPathAbs,
          stagingPathAbs: paths.stagingPathAbs,
          anchorPathAbs: paths.anchorPathAbs,
          quarantinePathAbs: paths.quarantinePathAbs,
        },
        originalTargetExisted: row.original,
        oldStructureFingerprint: oldStructure,
        oldContentSha256: oldContent,
        cancelRequested: false,
        rename: harness.rename,
        lstat: realLstat,
        verifyStagingTree: v.verifyStagingTree,
        verifyTargetTree: v.verifyTargetTree,
        reFetchForbidden: /** @type {const} */ (true),
      };

      if (!row.legal) {
        await expectRejects(() => recoverFromCrash(ctx), STATE_INVALID, {
          statusCode: 500,
          retryable: false,
          leakTokens: [paths.targetPathAbs, paths.anchorPathAbs, root],
        });
        assert.equal(store.state.phase, 'anchored', `row ${row.name}: must not advance phase on illegal`);
        assert.equal(harness.calls.length, 0, `row ${row.name}: zero rename`);
        assert.equal(store.durablePhases.includes('cancelled-local'), false);
        // no deletion of artifacts
        if (row.target !== 'absent') assert.equal(await exists(paths.targetPathAbs), true);
        if (row.anchor !== 'absent') assert.equal(await exists(paths.anchorPathAbs), true);
        assert.equal(await exists(paths.stagingPathAbs), true);
        return;
      }

      const result = await recoverFromCrash(ctx);
      assert.notEqual(store.state.phase, 'anchored', `row ${row.name}: legal must leave anchored`);
      assert.ok(
        store.durablePhases.includes('publish-intent') ||
          store.durablePhases.includes('published') ||
          store.durablePhases.includes('completed-awaiting-ack') ||
          (result && result.phase && result.phase !== 'anchored'),
        `row ${row.name}: legal must progress (phase=${store.state.phase})`,
      );
      assert.equal(store.durablePhases.includes('cancelled-local'), false);
      assert.equal(store.reFetchCalls, 0);
    });
  }
});

// ── P2-1: rollback binary 16 + type canaries ───────────────────────

describe('P2-1 rollback target/anchor/quarantine binary matrix (exact 16)', () => {
  const ROLLBACK_INTENT_ROWS = buildRollbackBinaryRows();

  it('binary matrix size is exactly 16 including origF T1 A1 Q1 S0', () => {
    assert.equal(ROLLBACK_INTENT_ROWS.length, 16);
    const tripleYes = ROLLBACK_INTENT_ROWS.find(
      (r) => !r.original && r.target && r.anchor && r.quarantine && !r.staging,
    );
    assert.ok(tripleYes, 'must include origF T1 A1 Q1 S0');
    assert.equal(tripleYes.expect, 'state-invalid');
  });

  for (const row of ROLLBACK_INTENT_ROWS) {
    it(`rollback-intent [${row.name}] → ${row.expect}`, async () => {
      const root = /** @type {string} */ (tempRoot);
      const paths = siblingPaths(root);
      await mkdir(dirname(paths.targetPathAbs), { recursive: true });

      if (row.target) await writeTree(paths.targetPathAbs, { 'pub.txt': 'PUBLISHED' });
      if (row.anchor) await writeTree(paths.anchorPathAbs, { 'old.txt': 'OLD-ANCHOR' });
      if (row.quarantine) await writeTree(paths.quarantinePathAbs, { 'q.txt': 'Q' });
      if (row.staging) await writeTree(paths.stagingPathAbs, { 's.txt': 'S' });

      let oldStructure = null;
      let oldContent = null;
      if (row.original && row.anchor) {
        oldStructure = await computeStructureFingerprint(paths.anchorPathAbs);
        oldContent = await computeContentSha256(paths.anchorPathAbs);
      }

      const store = createStateStoreDouble({
        phase: 'rollback-intent',
        originalTargetExisted: row.original,
        oldStructureFingerprint: oldStructure,
        oldContentSha256: oldContent,
      });
      const harness = createRenameHarness();
      const v = createVerifiers();

      const ctx = {
        stateStore: store,
        paths: {
          targetPathAbs: paths.targetPathAbs,
          stagingPathAbs: paths.stagingPathAbs,
          anchorPathAbs: paths.anchorPathAbs,
          quarantinePathAbs: paths.quarantinePathAbs,
        },
        originalTargetExisted: row.original,
        oldStructureFingerprint: oldStructure,
        oldContentSha256: oldContent,
        cancelRequested: false,
        rename: harness.rename,
        lstat: realLstat,
        verifyStagingTree: v.verifyStagingTree,
        verifyTargetTree: v.verifyTargetTree,
        reFetchForbidden: /** @type {const} */ (true),
      };

      if (row.expect === 'state-invalid') {
        await expectRejects(() => recoverFromCrash(ctx), STATE_INVALID, {
          statusCode: 500,
          retryable: false,
          leakTokens: [
            paths.targetPathAbs,
            paths.anchorPathAbs,
            paths.quarantinePathAbs,
            paths.stagingPathAbs,
            root,
          ],
        });
        if (row.target) assert.equal(await exists(paths.targetPathAbs), true, row.name);
        if (row.anchor) assert.equal(await exists(paths.anchorPathAbs), true, row.name);
        if (row.quarantine) assert.equal(await exists(paths.quarantinePathAbs), true, row.name);
        if (row.staging) assert.equal(await exists(paths.stagingPathAbs), true, row.name);
        return;
      }

      const result = await recoverFromCrash(ctx);
      assert.ok(
        store.state.phase === 'rolled-back-awaiting-ack' ||
          store.state.phase === 'failed-target-quarantined' ||
          store.state.phase === 'anchor-restored' ||
          store.state.phase === 'old-fingerprint-verified' ||
          (result && result.receipt && result.receipt.outcome === 'rolled-back'),
        `row ${row.name}: expected rollback progress, got phase=${store.state.phase}`,
      );
      assert.equal(store.reFetchCalls, 0);
    });
  }

  // Staging-present canaries (not part of binary 16)
  for (const original of [true, false]) {
    it(`staging-present canary orig${original ? 'T' : 'F'} legal-base+S1 → state-invalid zero delete`, async () => {
      const root = /** @type {string} */ (tempRoot);
      const paths = siblingPaths(root);
      await mkdir(dirname(paths.targetPathAbs), { recursive: true });
      if (original) {
        await writeTree(paths.targetPathAbs, { 'pub.txt': 'P' });
        await writeTree(paths.anchorPathAbs, { 'old.txt': 'O' });
      } else {
        await writeTree(paths.targetPathAbs, { 'pub.txt': 'P' });
      }
      await writeTree(paths.stagingPathAbs, { 's.txt': 'S' });

      const store = createStateStoreDouble({
        phase: 'rollback-intent',
        originalTargetExisted: original,
      });
      const harness = createRenameHarness();
      const v = createVerifiers();

      await expectRejects(
        () =>
          recoverFromCrash({
            stateStore: store,
            paths: {
              targetPathAbs: paths.targetPathAbs,
              stagingPathAbs: paths.stagingPathAbs,
              anchorPathAbs: paths.anchorPathAbs,
              quarantinePathAbs: paths.quarantinePathAbs,
            },
            originalTargetExisted: original,
            oldStructureFingerprint: null,
            oldContentSha256: null,
            cancelRequested: false,
            rename: harness.rename,
            lstat: realLstat,
            verifyStagingTree: v.verifyStagingTree,
            verifyTargetTree: v.verifyTargetTree,
            reFetchForbidden: true,
          }),
        STATE_INVALID,
        { statusCode: 500, leakTokens: [paths.stagingPathAbs, root] },
      );
      assert.equal(await exists(paths.stagingPathAbs), true);
      assert.equal(await exists(paths.targetPathAbs), true);
      assert.equal(harness.calls.length, 0);
    });
  }

  // Type canaries: file + symlink for target/anchor/quarantine/staging (≥8 rows)
  /** @type {ReadonlyArray<{ label: string, which: 'target'|'anchor'|'quarantine'|'staging', kind: 'file'|'symlink', original: boolean }>} */
  const TYPE_CANARIES = Object.freeze([
    { label: 'target-file', which: 'target', kind: 'file', original: true },
    { label: 'target-symlink', which: 'target', kind: 'symlink', original: true },
    { label: 'anchor-file', which: 'anchor', kind: 'file', original: true },
    { label: 'anchor-symlink', which: 'anchor', kind: 'symlink', original: true },
    { label: 'quarantine-file', which: 'quarantine', kind: 'file', original: true },
    { label: 'quarantine-symlink', which: 'quarantine', kind: 'symlink', original: true },
    { label: 'staging-file', which: 'staging', kind: 'file', original: false },
    { label: 'staging-symlink', which: 'staging', kind: 'symlink', original: false },
  ]);

  for (const row of TYPE_CANARIES) {
    it(`type canary [${row.label}] → unique state-invalid; zero delete`, async () => {
      const root = /** @type {string} */ (tempRoot);
      const paths = siblingPaths(root);
      await mkdir(dirname(paths.targetPathAbs), { recursive: true });

      // Base legal-ish dirs then corrupt one path type
      if (row.original) {
        await writeTree(paths.targetPathAbs, { 'pub.txt': 'P' });
        await writeTree(paths.anchorPathAbs, { 'old.txt': 'O' });
      } else {
        await writeTree(paths.targetPathAbs, { 'pub.txt': 'P' });
      }

      const map = {
        target: paths.targetPathAbs,
        anchor: paths.anchorPathAbs,
        quarantine: paths.quarantinePathAbs,
        staging: paths.stagingPathAbs,
      };
      // Replace the selected path with illegal type
      await rm(map[row.which], { recursive: true, force: true });
      await materialize(map[row.which], row.kind, 'bad');

      const store = createStateStoreDouble({
        phase: 'rollback-intent',
        originalTargetExisted: row.original,
      });
      const harness = createRenameHarness();
      const v = createVerifiers();

      await expectRejects(
        () =>
          recoverFromCrash({
            stateStore: store,
            paths: {
              targetPathAbs: paths.targetPathAbs,
              stagingPathAbs: paths.stagingPathAbs,
              anchorPathAbs: paths.anchorPathAbs,
              quarantinePathAbs: paths.quarantinePathAbs,
            },
            originalTargetExisted: row.original,
            oldStructureFingerprint: null,
            oldContentSha256: null,
            cancelRequested: false,
            rename: harness.rename,
            lstat: realLstat,
            verifyStagingTree: v.verifyStagingTree,
            verifyTargetTree: v.verifyTargetTree,
            reFetchForbidden: true,
          }),
        STATE_INVALID,
        { statusCode: 500, leakTokens: [map[row.which], root] },
      );
      assert.equal(await exists(map[row.which]), true, 'must not delete illegal artifact');
      assert.equal(harness.calls.length, 0);
    });
  }

  it('rollback rename throw → unique restore-rollback-failed; no auto-delete of any artifact', async () => {
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
      failMessage: 'simulated rollback rename failure',
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
        leakTokens: [paths.targetPathAbs, paths.anchorPathAbs, root, 'EIO', 'errno'],
      },
    );

    assert.equal(await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.anchorPathAbs), true);
    assert.equal(await exists(paths.stagingPathAbs), false);
    assert.equal(await exists(paths.quarantinePathAbs), false);
    assert.equal(await readFile(join(paths.targetPathAbs, 'pub.txt'), 'utf8'), 'PUB');
    assert.equal(await readFile(join(paths.anchorPathAbs, 'old.txt'), 'utf8'), 'OLD');
  });

  it('fingerprint mismatch after restore → unique restore-rollback-failed; artifacts retained', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'pub.txt': 'PUB-BAD' });
    await writeTree(paths.anchorPathAbs, { 'old.txt': 'OLD-CONTENT' });

    const wrongStructure = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const wrongContent = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

    const store = createStateStoreDouble({
      phase: 'published',
      originalTargetExisted: true,
      oldStructureFingerprint: wrongStructure,
      oldContentSha256: wrongContent,
    });
    const harness = createRenameHarness();

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
          oldStructureFingerprint: wrongStructure,
          oldContentSha256: wrongContent,
          rename: harness.rename,
          lstat: realLstat,
        }),
      ROLLBACK_FAILED,
      {
        statusCode: 500,
        retryable: false,
        leakTokens: [paths.targetPathAbs, paths.anchorPathAbs, paths.quarantinePathAbs, root],
      },
    );

    assert.equal(await exists(paths.quarantinePathAbs) || await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.anchorPathAbs) || await exists(paths.targetPathAbs), true);
  });
});

// ── publish-intent four quadrants + verifyTargetTree ───────────────

describe('publish-intent four quadrants (targetExists × stagingExists)', () => {
  it('(N,Y) retry rename staging→target; verifyTargetTree after target appears before completed', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW' });

    const store = createStateStoreDouble({
      phase: 'publish-intent',
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
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
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
      cancelRequested: false,
      rename: harness.rename,
      lstat: realLstat,
      verifyStagingTree: v.verifyStagingTree,
      verifyTargetTree: v.verifyTargetTree,
      reFetchForbidden: true,
    });

    assert.ok(harness.calls.some((c) => c.from === paths.stagingPathAbs && c.to === paths.targetPathAbs));
    assert.equal(await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.stagingPathAbs), false);
    assert.ok(v.targetCalls >= 1, 'verifyTargetTree required after target appears');
    assert.ok(
      store.state.phase === 'published' ||
        store.state.phase === 'completed-awaiting-ack' ||
        result?.phase === 'published' ||
        result?.receipt?.outcome === 'completed',
    );
    assert.equal(store.reFetchCalls, 0);
  });

  it('(Y,N) enter published then full re-verify via verifyTargetTree', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'new.txt': 'NEW' });

    const store = createStateStoreDouble({
      phase: 'publish-intent',
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
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
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
      cancelRequested: false,
      rename: harness.rename,
      lstat: realLstat,
      verifyStagingTree: v.verifyStagingTree,
      verifyTargetTree: v.verifyTargetTree,
      reFetchForbidden: true,
    });

    assert.equal(harness.calls.filter((c) => c.from === paths.stagingPathAbs).length, 0);
    assert.ok(v.targetCalls >= 1, 'must not complete from fingerprints alone');
    assert.ok(
      store.durablePhases.includes('published') ||
        store.state.phase === 'published' ||
        store.state.phase === 'completed-awaiting-ack' ||
        store.state.phase === 'rollback-intent' ||
        result?.receipt,
    );
    assert.equal(store.reFetchCalls, 0);
  });

  it('(Y,N) corrupt target: verifyTargetTree throws → rollback not completed', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'new.txt': 'CORRUPT' });
    await writeTree(paths.anchorPathAbs, { 'old.txt': 'OLD' });

    const oldStructure = await computeStructureFingerprint(paths.anchorPathAbs);
    const oldContent = await computeContentSha256(paths.anchorPathAbs);

    const store = createStateStoreDouble({
      phase: 'publish-intent',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const harness = createRenameHarness();
    const v = createVerifiers({
      targetThrow: new LinkeError(INTEGRITY_FAILED),
    });

    let result = null;
    try {
      result = await recoverFromCrash({
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
        verifyStagingTree: v.verifyStagingTree,
        verifyTargetTree: v.verifyTargetTree,
        reFetchForbidden: true,
      });
    } catch (error) {
      assert.ok(error instanceof LinkeError);
      assertLinkeCode(error, error.code, {
        leakTokens: [paths.targetPathAbs, root],
      });
    }

    assert.ok(v.targetCalls >= 1);
    assert.equal(store.durablePhases.includes('completed-awaiting-ack'), false);
    if (result?.receipt) {
      assert.notEqual(result.receipt.outcome, 'completed');
    }
  });

  it('(Y,Y) unique restore-publish-conflict', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 't.txt': 'T' });
    await writeTree(paths.stagingPathAbs, { 's.txt': 'S' });

    const store = createStateStoreDouble({
      phase: 'publish-intent',
      originalTargetExisted: false,
    });
    const harness = createRenameHarness();
    const v = createVerifiers();

    await expectRejects(
      () =>
        recoverFromCrash({
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
          verifyStagingTree: v.verifyStagingTree,
          verifyTargetTree: v.verifyTargetTree,
          reFetchForbidden: true,
        }),
      PUBLISH_CONFLICT,
      {
        statusCode: 409,
        retryable: false,
        leakTokens: [paths.targetPathAbs, paths.stagingPathAbs, root],
      },
    );
    assert.equal(harness.calls.length, 0);
    assert.equal(await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.stagingPathAbs), true);
  });

  it('(N,N) unique restore-state-invalid', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });

    const store = createStateStoreDouble({
      phase: 'publish-intent',
      originalTargetExisted: false,
    });
    const harness = createRenameHarness();
    const v = createVerifiers();

    await expectRejects(
      () =>
        recoverFromCrash({
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
          verifyStagingTree: v.verifyStagingTree,
          verifyTargetTree: v.verifyTargetTree,
          reFetchForbidden: true,
        }),
      STATE_INVALID,
      {
        statusCode: 500,
        retryable: false,
        leakTokens: [paths.targetPathAbs, paths.stagingPathAbs, root],
      },
    );
    assert.equal(harness.calls.length, 0);
  });

  it('missing verifyTargetTree on recoverFromCrash → state-invalid; no completed receipt', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 's.txt': 'S' });

    const store = createStateStoreDouble({
      phase: 'publish-intent',
      originalTargetExisted: false,
    });
    const harness = createRenameHarness();

    await expectRejects(
      () =>
        recoverFromCrash({
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
          verifyStagingTree: async () => {},
          // omit verifyTargetTree
          reFetchForbidden: true,
        }),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [root] },
    );
    assert.equal(store.writeReceiptCalls, 0);
    assert.equal(store.durablePhases.includes('completed-awaiting-ack'), false);
  });
});

// ── missing verifyStagingTree at anchor-intent ─────────────────────

describe('verifyStagingTree required at anchor-intent', () => {
  it('missing verifyStagingTree → state-invalid; zero rename; zero phase advance', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD' });
    await writeTree(paths.stagingPathAbs, { 'new.txt': 'NEW' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);

    const store = createStateStoreDouble({
      phase: 'anchor-intent',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const harness = createRenameHarness();
    const v = createVerifiers();

    await expectRejects(
      () =>
        recoverFromCrash({
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
          // omit verifyStagingTree
          verifyTargetTree: v.verifyTargetTree,
          reFetchForbidden: true,
        }),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [paths.stagingPathAbs, root] },
    );

    assert.equal(store.state.phase, 'anchor-intent');
    assert.equal(harness.calls.length, 0);
    assert.equal(store.durablePhases.length, 1);
  });
});

// ── P2-4: anchor-intent staging re-verify failure ──────────────────

describe('P2-4 anchor-intent staging re-verify failure', () => {
  it('re-verify fail + provable original (T present A absent) → rolled-back; no re-fetch/publish/delete', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'old.txt': 'ORIGINAL' });
    await writeTree(paths.stagingPathAbs, { 'bad.txt': 'CORRUPT' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);

    const store = createStateStoreDouble({
      phase: 'anchor-intent',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const harness = createRenameHarness();
    let reFetch = 0;
    const v = createVerifiers({
      stagingThrow: new LinkeError(INTEGRITY_FAILED),
    });

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
      cancelRequested: false,
      rename: harness.rename,
      lstat: realLstat,
      verifyStagingTree: v.verifyStagingTree,
      verifyTargetTree: v.verifyTargetTree,
      reFetchForbidden: true,
      reFetch: async () => {
        reFetch += 1;
      },
    });

    assert.equal(reFetch, 0, 'must not re-fetch');
    assert.equal(store.reFetchCalls, 0);
    assert.equal(harness.calls.length, 0, 'must not publish/rename');
    assert.equal(await exists(paths.targetPathAbs), true, 'must not delete target');
    assert.equal(await exists(paths.stagingPathAbs), true, 'must not delete staging');
    assert.equal(await exists(paths.anchorPathAbs), false, 'must not create anchor');

    const receipt = result?.receipt ?? store.receipt;
    assert.ok(receipt, 'must produce rolled-back receipt when original is provable');
    const projected = projectReceiptObject(receipt);
    assert.equal(projected.outcome, 'rolled-back');
    assert.equal(projected.anchorPresentBeforePublish, true);
    assert.equal(projected.contentSha256, oldContent);
    assert.equal(projected.structureFingerprint, oldStructure);
    assert.equal(store.durablePhases.includes('cancelled-local'), false);
    // Must not forge publish phases
    assert.equal(store.durablePhases.includes('publish-intent'), false);
    assert.equal(store.durablePhases.includes('published'), false);
  });

  it('re-verify fail + T absent + A dir: verify anchor fp then rename anchor→target → rolled-back', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    // Rename already happened: target absent, anchor has original
    await writeTree(paths.anchorPathAbs, { 'old.txt': 'ORIGINAL' });
    await writeTree(paths.stagingPathAbs, { 'bad.txt': 'CORRUPT' });

    const oldStructure = await computeStructureFingerprint(paths.anchorPathAbs);
    const oldContent = await computeContentSha256(paths.anchorPathAbs);

    const store = createStateStoreDouble({
      phase: 'anchor-intent',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const harness = createRenameHarness();
    const v = createVerifiers({
      stagingThrow: new LinkeError(INTEGRITY_FAILED),
    });

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
      cancelRequested: false,
      rename: harness.rename,
      lstat: realLstat,
      verifyStagingTree: v.verifyStagingTree,
      verifyTargetTree: v.verifyTargetTree,
      reFetchForbidden: true,
    });

    // Must restore via anchor→target rename (not publish, not delete staging)
    assert.ok(
      harness.calls.some((c) => c.from === paths.anchorPathAbs && c.to === paths.targetPathAbs),
      'must rename anchor→target to restore original',
    );
    assert.equal(
      harness.calls.some((c) => c.from === paths.stagingPathAbs),
      false,
      'must not publish staging',
    );
    assert.equal(await exists(paths.stagingPathAbs), true, 'must not delete staging');
    assert.equal(await exists(paths.quarantinePathAbs), false);
    assert.equal(await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.anchorPathAbs), false);

    const receipt = result?.receipt ?? store.receipt;
    assert.ok(receipt);
    const projected = projectReceiptObject(receipt);
    assert.equal(projected.outcome, 'rolled-back');
    assert.equal(projected.contentSha256, oldContent);
    assert.equal(projected.structureFingerprint, oldStructure);
    assert.equal(store.durablePhases.includes('publish-intent'), false);
  });

  it('re-verify fail + T absent + A dir + fingerprint mismatch → state-invalid or rollback-failed', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.anchorPathAbs, { 'old.txt': 'DIFFERENT' });
    await writeTree(paths.stagingPathAbs, { 'bad.txt': 'CORRUPT' });

    const store = createStateStoreDouble({
      phase: 'anchor-intent',
      originalTargetExisted: true,
      oldStructureFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      oldContentSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    });
    const harness = createRenameHarness();
    const v = createVerifiers({
      stagingThrow: new LinkeError(INTEGRITY_FAILED),
    });

    await assert.rejects(
      () =>
        recoverFromCrash({
          stateStore: store,
          paths: {
            targetPathAbs: paths.targetPathAbs,
            stagingPathAbs: paths.stagingPathAbs,
            anchorPathAbs: paths.anchorPathAbs,
            quarantinePathAbs: paths.quarantinePathAbs,
          },
          originalTargetExisted: true,
          oldStructureFingerprint: store.state.oldStructureFingerprint,
          oldContentSha256: store.state.oldContentSha256,
          cancelRequested: false,
          rename: harness.rename,
          lstat: realLstat,
          verifyStagingTree: v.verifyStagingTree,
          verifyTargetTree: v.verifyTargetTree,
          reFetchForbidden: true,
        }),
      (error) => {
        assert.ok(error instanceof LinkeError);
        assert.ok(error.code === STATE_INVALID || error.code === ROLLBACK_FAILED);
        assertLinkeCode(error, error.code, {
          leakTokens: [paths.anchorPathAbs, paths.stagingPathAbs, root],
        });
        return true;
      },
    );
    assert.equal(await exists(paths.stagingPathAbs), true);
    assert.equal(await exists(paths.anchorPathAbs), true);
  });

  it('re-verify fail + ambiguous dirs → unique restore-state-invalid; no delete', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'old.txt': 'ORIGINAL' });
    await writeTree(paths.anchorPathAbs, { 'a.txt': 'A' });
    await writeTree(paths.stagingPathAbs, { 'bad.txt': 'CORRUPT' });

    const store = createStateStoreDouble({
      phase: 'anchor-intent',
      originalTargetExisted: true,
      oldStructureFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      oldContentSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    });
    const harness = createRenameHarness();
    const v = createVerifiers({
      stagingThrow: new LinkeError(INTEGRITY_FAILED),
    });

    await expectRejects(
      () =>
        recoverFromCrash({
          stateStore: store,
          paths: {
            targetPathAbs: paths.targetPathAbs,
            stagingPathAbs: paths.stagingPathAbs,
            anchorPathAbs: paths.anchorPathAbs,
            quarantinePathAbs: paths.quarantinePathAbs,
          },
          originalTargetExisted: true,
          oldStructureFingerprint: store.state.oldStructureFingerprint,
          oldContentSha256: store.state.oldContentSha256,
          cancelRequested: false,
          rename: harness.rename,
          lstat: realLstat,
          verifyStagingTree: v.verifyStagingTree,
          verifyTargetTree: v.verifyTargetTree,
          reFetchForbidden: true,
        }),
      STATE_INVALID,
      {
        statusCode: 500,
        retryable: false,
        leakTokens: [paths.targetPathAbs, paths.anchorPathAbs, paths.stagingPathAbs, root],
      },
    );

    assert.equal(harness.calls.length, 0);
    assert.equal(await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.anchorPathAbs), true);
    assert.equal(await exists(paths.stagingPathAbs), true);
  });
});

// ── P2-3: cancelled-local crash recovery ───────────────────────────

describe('P2-3 cancelled-local crash recovery + cleanupId stable replay', () => {
  it('multi-file half-deleted staging: remaining deleted; cleanupId stable', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, {
      'a.txt': 'A',
      'nested/b.txt': 'B',
      'nested/deep/c.txt': 'C',
      'keep-until-rm.txt': 'K',
    });
    // Pre-delete partial tree (simulate half-deleted crash)
    await rm(join(paths.stagingPathAbs, 'nested', 'deep'), { recursive: true, force: true });
    await rm(join(paths.stagingPathAbs, 'a.txt'), { force: true });

    const remainingBefore = await readdir(paths.stagingPathAbs, { recursive: true });
    assert.ok(remainingBefore.length > 0, 'fixture must leave remaining files');

    const store = createStateStoreDouble({
      phase: 'cancelled-local',
      originalTargetExisted: false,
      cleanupId: null,
    });

    /** @type {string[]} */
    const rmCalls = [];
    const rmInjected = async (p, opts) => {
      rmCalls.push(p);
      store.noteRm();
      assert.equal(opts.recursive, true);
      assert.equal(opts.force, true);
      await rm(p, opts);
    };

    const first = await recoverCancelledLocal({
      stateStore: store,
      stagingPathAbs: paths.stagingPathAbs,
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      cleanupId: null,
      rm: rmInjected,
    });

    const projected1 = projectCleanupReceipt(first);
    assert.equal(projected1.outcome, 'cancelled');
    assert.equal(projected1.receiptId, null);
    assert.match(
      projected1.cleanupId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(await exists(paths.stagingPathAbs), false);

    const stableId = projected1.cleanupId;

    await store.writeState(
      TASK_ID,
      { phase: 'cleanup-completed-awaiting-ack', cleanupId: stableId },
      { fsync: true },
    );

    const second = await recoverCancelledLocal({
      stateStore: store,
      stagingPathAbs: paths.stagingPathAbs,
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      cleanupId: stableId,
      rm: rmInjected,
    });
    const projected2 = projectCleanupReceipt(second);
    assert.equal(projected2.cleanupId, stableId, 'cleanupId must be stable across replay');
    assert.equal(projected2.outcome, 'cancelled');
  });

  it('cleanupId fsync STATE before CleanupReceipt; crash after receipt keeps STATE id for replay', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 'left.txt': 'LEFT' });

    const store = createStateStoreDouble(
      { phase: 'cancelled-local', cleanupId: null },
      { crashAfterCleanupReceiptWrite: true },
    );

    const rmInjected = async (p, opts) => {
      await rm(p, opts);
    };

    await assert.rejects(
      () =>
        recoverCancelledLocal({
          stateStore: store,
          stagingPathAbs: paths.stagingPathAbs,
          taskId: TASK_ID,
          deviceId: DEVICE_ID,
          cleanupId: null,
          rm: rmInjected,
        }),
      (error) => {
        assert.equal(/** @type {any} */ (error).code, 'EIO');
        return true;
      },
    );

    // Before/at crash, STATE must already have fsynced cleanupId
    const idWrites = store.writePatches.filter(
      (w) => w.patch && typeof w.patch.cleanupId === 'string' && w.writeOptions.fsync === true,
    );
    assert.ok(idWrites.length >= 1, 'must fsync cleanupId into STATE before CleanupReceipt');
    const durableId = idWrites[0].patch.cleanupId;
    assert.equal(typeof durableId, 'string');
    assert.equal(store.state.cleanupId, durableId);

    // Restart: omit explicit cleanupId; recover from STATE
    const store2 = createStateStoreDouble({
      phase: 'cancelled-local',
      cleanupId: durableId,
    });
    // Force state.cleanupId
    await store2.writeState(TASK_ID, { cleanupId: durableId, phase: 'cancelled-local' }, { fsync: true });

    const out = await recoverCancelledLocal({
      stateStore: store2,
      stagingPathAbs: paths.stagingPathAbs,
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      cleanupId: null, // omit — must load from STATE
      rm: rmInjected,
    });
    const projected = projectCleanupReceipt(out);
    assert.equal(projected.cleanupId, durableId, 'must not generate a new cleanupId');
  });

  it('cleanupId omitted + STATE already has ID → reuse without generating new', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });

    const store = createStateStoreDouble({
      phase: 'cleanup-completed-awaiting-ack',
      cleanupId: CLEANUP_ID,
    });

    const out = await recoverCancelledLocal({
      stateStore: store,
      stagingPathAbs: paths.stagingPathAbs,
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      cleanupId: null,
      rm: async (p, opts) => {
        await rm(p, opts);
      },
    });
    const projected = projectCleanupReceipt(out);
    assert.equal(projected.cleanupId, CLEANUP_ID);
    assert.equal(projected.outcome, 'cancelled');
  });

  it('cleanup receipt written but not ACKed: replay same cleanupId without new id', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });

    const store = createStateStoreDouble({
      phase: 'cleanup-completed-awaiting-ack',
      cleanupId: CLEANUP_ID,
    });
    await store.writeCleanupReceipt(TASK_ID, {
      schemaVersion: 1,
      cleanupId: CLEANUP_ID,
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      outcome: 'cancelled',
      receiptId: null,
      cleanedAt: '2026-07-23T12:00:00.000Z',
    });

    const out = await recoverCancelledLocal({
      stateStore: store,
      stagingPathAbs: paths.stagingPathAbs,
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      cleanupId: CLEANUP_ID,
      rm: async (p, opts) => {
        await rm(p, opts);
      },
    });

    const projected = projectCleanupReceipt(out);
    assert.equal(projected.cleanupId, CLEANUP_ID);
    assert.equal(projected.outcome, 'cancelled');
  });

  it('illegal phase publish-intent for recoverCancelledLocal → state-invalid; rm/write receipt = 0', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 's.txt': 'S' });

    const store = createStateStoreDouble({
      phase: 'publish-intent',
      cleanupId: null,
    });
    let rmCalls = 0;

    await expectRejects(
      () =>
        recoverCancelledLocal({
          stateStore: store,
          stagingPathAbs: paths.stagingPathAbs,
          taskId: TASK_ID,
          deviceId: DEVICE_ID,
          cleanupId: null,
          rm: async (p, opts) => {
            rmCalls += 1;
            await rm(p, opts);
          },
        }),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [paths.stagingPathAbs, root] },
    );
    assert.equal(rmCalls, 0);
    assert.equal(store.writeCleanupReceiptCalls, 0);
    assert.equal(await exists(paths.stagingPathAbs), true);
  });

  it('forbidden: recoverFromCrash from anchor-intent+ must never become cancelled-local', async () => {
    for (const phase of ['anchor-intent', 'anchored', 'publish-intent', 'published']) {
      const work = await mkdtemp(join(tmpdir(), 'linke-crash-row-'));
      try {
        const paths2 = siblingPaths(work);
        await mkdir(dirname(paths2.targetPathAbs), { recursive: true });

        if (phase === 'anchor-intent') {
          await writeTree(paths2.targetPathAbs, { 'old.txt': 'OLD' });
          await writeTree(paths2.stagingPathAbs, { 'new.txt': 'NEW' });
        } else if (phase === 'anchored') {
          await writeTree(paths2.anchorPathAbs, { 'old.txt': 'OLD' });
          await writeTree(paths2.stagingPathAbs, { 'new.txt': 'NEW' });
        } else if (phase === 'publish-intent') {
          await writeTree(paths2.anchorPathAbs, { 'old.txt': 'OLD' });
          await writeTree(paths2.stagingPathAbs, { 'new.txt': 'NEW' });
        } else {
          await writeTree(paths2.anchorPathAbs, { 'old.txt': 'OLD' });
          await writeTree(paths2.targetPathAbs, { 'new.txt': 'NEW' });
        }

        const fpRoot = (await exists(paths2.anchorPathAbs))
          ? paths2.anchorPathAbs
          : paths2.targetPathAbs;
        const oldStructure = await computeStructureFingerprint(fpRoot);
        const oldContent = await computeContentSha256(fpRoot);

        const store = createStateStoreDouble({
          phase,
          originalTargetExisted: true,
          oldStructureFingerprint: oldStructure,
          oldContentSha256: oldContent,
        });
        const harness = createRenameHarness();
        const v = createVerifiers();

        try {
          await recoverFromCrash({
            stateStore: store,
            paths: {
              targetPathAbs: paths2.targetPathAbs,
              stagingPathAbs: paths2.stagingPathAbs,
              anchorPathAbs: paths2.anchorPathAbs,
              quarantinePathAbs: paths2.quarantinePathAbs,
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
        } catch {
          // fail-closed codes ok; cancelled-local is not
        }
        assert.notEqual(
          store.state.phase,
          'cancelled-local',
          `phase=${phase} must never recover into cancelled-local`,
        );
        assert.equal(
          store.durablePhases.includes('cancelled-local'),
          false,
          `phase=${phase} must never durable-write cancelled-local`,
        );
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
  });
});

// ── tombstone replay for awaiting-ack ──────────────────────────────

describe('awaiting-ack tombstone replay via readTombstone', () => {
  it('completed-awaiting-ack replays exact ReceiptObject from tombstone', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });

    const storedReceipt = projectReceiptObject({
      schemaVersion: 1,
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      manifestDigest: DIGEST,
      outcome: 'completed',
      relativeTarget: RELATIVE_TARGET,
      totalBytes: 4,
      fileCount: 1,
      contentSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      structureFingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      publishedVerifiedAt: '2026-07-23T12:00:00.000Z',
      rolledBackAt: null,
      anchorPresentBeforePublish: false,
      receiptId: RECEIPT_ID,
    });

    const store = createStateStoreDouble({
      phase: 'completed-awaiting-ack',
      receiptId: RECEIPT_ID,
    });
    await store.writeReceipt(TASK_ID, storedReceipt);

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
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
      cancelRequested: false,
      rename: harness.rename,
      lstat: realLstat,
      verifyStagingTree: v.verifyStagingTree,
      verifyTargetTree: v.verifyTargetTree,
      reFetchForbidden: true,
    });

    assert.ok(result.receipt);
    assert.deepEqual(result.receipt, storedReceipt);
    assert.equal(result.phase, 'completed-awaiting-ack');
    assert.equal(harness.calls.length, 0);
  });

  it('rolled-back-awaiting-ack replays exact ReceiptObject from tombstone', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });

    const storedReceipt = projectReceiptObject({
      schemaVersion: 1,
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      manifestDigest: DIGEST,
      outcome: 'rolled-back',
      relativeTarget: RELATIVE_TARGET,
      totalBytes: 4,
      fileCount: 1,
      contentSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      structureFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      publishedVerifiedAt: null,
      rolledBackAt: '2026-07-23T12:00:00.000Z',
      anchorPresentBeforePublish: true,
      receiptId: RECEIPT_ID,
    });

    const store = createStateStoreDouble({
      phase: 'rolled-back-awaiting-ack',
      receiptId: RECEIPT_ID,
    });
    await store.writeReceipt(TASK_ID, storedReceipt);

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
      oldStructureFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      oldContentSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      cancelRequested: false,
      rename: harness.rename,
      lstat: realLstat,
      verifyStagingTree: v.verifyStagingTree,
      verifyTargetTree: v.verifyTargetTree,
      reFetchForbidden: true,
    });

    assert.ok(result.receipt);
    assert.deepEqual(result.receipt, storedReceipt);
    assert.equal(result.phase, 'rolled-back-awaiting-ack');
  });

  it('awaiting-ack missing tombstone → state-invalid', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });

    const store = createStateStoreDouble({
      phase: 'completed-awaiting-ack',
      // no receipt written
    });
    const harness = createRenameHarness();
    const v = createVerifiers();

    await expectRejects(
      () =>
        recoverFromCrash({
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
          verifyStagingTree: v.verifyStagingTree,
          verifyTargetTree: v.verifyTargetTree,
          reFetchForbidden: true,
        }),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [root] },
    );
  });
});

// ── reFetchForbidden exact true ────────────────────────────────────

describe('recoverFromCrash reFetchForbidden must be exact true; no re-fetch on any path', () => {
  it('rejects when reFetchForbidden is not exact true', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 's.txt': 'S' });

    const store = createStateStoreDouble({ phase: 'anchored', originalTargetExisted: false });
    const harness = createRenameHarness();
    const v = createVerifiers();

    for (const bad of [false, undefined, null, 1, 'true', {}, []]) {
      await assert.rejects(
        () =>
          recoverFromCrash({
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
            verifyStagingTree: v.verifyStagingTree,
            verifyTargetTree: v.verifyTargetTree,
            reFetchForbidden: /** @type {any} */ (bad),
          }),
        (error) => {
          if (error instanceof LinkeError) {
            assertLinkeCode(error, error.code, {
              leakTokens: [paths.stagingPathAbs, root, 'secret-token'],
            });
            return true;
          }
          assert.ok(error instanceof Error);
          return true;
        },
      );
    }
  });

  it('with reFetchForbidden:true never invokes re-fetch on recovery paths', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 's.txt': 'S' });

    const store = createStateStoreDouble({
      phase: 'anchored',
      originalTargetExisted: false,
    });
    const harness = createRenameHarness();
    const v = createVerifiers();
    let reFetch = 0;

    try {
      await recoverFromCrash({
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
        verifyStagingTree: v.verifyStagingTree,
        verifyTargetTree: v.verifyTargetTree,
        reFetchForbidden: true,
        reFetch: async () => {
          reFetch += 1;
        },
      });
    } catch {
      // may complete or fail for other reasons
    }
    assert.equal(reFetch, 0);
    assert.equal(store.reFetchCalls, 0);
  });
});

// ── transitionPhase guard on recovery path ─────────────────────────

describe('recoverFromCrash transitionPhase guard — no writeState fallback', () => {
  it('LinkeError from transitionPhase is rethrown; writeStateCalls unchanged', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 's.txt': 'S' });

    const store = createStateStoreDouble(
      { phase: 'anchored', originalTargetExisted: false },
      { transitionThrows: new LinkeError(STATE_INVALID) },
    );
    const harness = createRenameHarness();
    const v = createVerifiers();
    const before = store.writeStateCalls;

    await expectRejects(
      () =>
        recoverFromCrash({
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
          verifyStagingTree: v.verifyStagingTree,
          verifyTargetTree: v.verifyTargetTree,
          reFetchForbidden: true,
        }),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [root] },
    );
    assert.ok(store.transitionCalls >= 1);
    assert.equal(store.writeStateCalls, before);
  });
});

// ── plain Error from verifyTargetTree on crash published path ──────

describe('verifyTargetTree plain Error on crash published must not complete', () => {
  it('recoverFromCrash phase=published: plain Error from verifyTargetTree → rollback|rollback-failed; no completed; no leak', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.targetPathAbs, { 'new.txt': 'NEW' });
    await writeTree(paths.anchorPathAbs, { 'old.txt': 'OLD' });

    const oldStructure = await computeStructureFingerprint(paths.anchorPathAbs);
    const oldContent = await computeContentSha256(paths.anchorPathAbs);

    const store = createStateStoreDouble({
      phase: 'published',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
    });
    const harness = createRenameHarness();
    let targetCalls = 0;
    const leakMsg = `crash-plain-verifier ${paths.targetPathAbs} secret-token`;

    let result = null;
    try {
      result = await recoverFromCrash({
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
        verifyStagingTree: async () => {},
        verifyTargetTree: async () => {
          targetCalls += 1;
          throw new Error(leakMsg);
        },
        reFetchForbidden: true,
      });
    } catch (error) {
      assert.ok(error instanceof LinkeError, 'must not surface raw Error');
      assert.ok(
        error.code === ROLLBACK_FAILED ||
          error.code === INTEGRITY_FAILED ||
          error.code === ERROR_CODES.RESTORE_ROLLBACK_REQUIRED ||
          error.code === STATE_INVALID,
      );
      assertLinkeCode(error, error.code, {
        leakTokens: [paths.targetPathAbs, root, 'secret-token', 'crash-plain-verifier', leakMsg],
      });
    }

    assert.ok(targetCalls >= 1);
    assert.equal(store.durablePhases.includes('completed-awaiting-ack'), false);
    if (result?.receipt) {
      assert.notEqual(result.receipt.outcome, 'completed');
    }
    assert.notEqual(store.state.phase, 'completed-awaiting-ack');
  });
});

// ── recoverCancelledLocal must transitionPhase to terminal ─────────

describe('recoverCancelledLocal terminal phase via transitionPhase only', () => {
  it('cancelled-local → cleanup-completed-awaiting-ack uses transitionPhase; cleanupId fsync first; no writeState phase patch', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 'left.txt': 'LEFT' });

    const store = createStateStoreDouble({
      phase: 'cancelled-local',
      cleanupId: null,
    });

    const out = await recoverCancelledLocal({
      stateStore: store,
      stagingPathAbs: paths.stagingPathAbs,
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      cleanupId: null,
      rm: async (p, opts) => {
        await rm(p, opts);
      },
    });

    projectCleanupReceipt(out);

    // cleanupId fsync before receipt still required
    const idWrites = store.writePatches.filter(
      (w) =>
        w.patch &&
        typeof w.patch.cleanupId === 'string' &&
        w.writeOptions.fsync === true &&
        w.patch.phase === undefined,
    );
    assert.ok(idWrites.length >= 1, 'must fsync cleanupId without terminal phase in same early patch');

    // Terminal phase must go through transitionPhase legal edge
    assert.ok(
      store.transitions.some(
        (t) => t.from === 'cancelled-local' && t.to === 'cleanup-completed-awaiting-ack',
      ),
      'must call transitionPhase(cancelled-local → cleanup-completed-awaiting-ack)',
    );

    // Must not write terminal phase via writeState
    const phaseViaWrite = store.writePatches.filter(
      (w) => w.patch && w.patch.phase === 'cleanup-completed-awaiting-ack',
    );
    assert.equal(
      phaseViaWrite.length,
      0,
      'must not writeState terminal phase; use transitionPhase only',
    );
    assert.equal(store.state.phase, 'cleanup-completed-awaiting-ack');
  });

  it('transitionPhase throw on terminal edge propagates; no writeState phase fallback', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 'left.txt': 'LEFT' });

    const store = createStateStoreDouble(
      { phase: 'cancelled-local', cleanupId: null },
      { transitionThrows: new LinkeError(STATE_INVALID) },
    );
    const writesBefore = store.writeStateCalls;

    // Allow cleanupId fsync writes; count phase-bearing writeState after throw
    await expectRejects(
      () =>
        recoverCancelledLocal({
          stateStore: store,
          stagingPathAbs: paths.stagingPathAbs,
          taskId: TASK_ID,
          deviceId: DEVICE_ID,
          cleanupId: null,
          rm: async (p, opts) => {
            await rm(p, opts);
          },
        }),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [paths.stagingPathAbs, root] },
    );

    assert.ok(store.transitionCalls >= 1);
    const phaseViaWrite = store.writePatches.filter(
      (w) => w.patch && w.patch.phase === 'cleanup-completed-awaiting-ack',
    );
    assert.equal(phaseViaWrite.length, 0, 'no writeState fallback for terminal phase');
    // writeState may have been used for cleanupId only
    const phaseWritesAfter = store.writePatches.filter(
      (w) => w.patch && typeof w.patch.phase === 'string',
    );
    assert.equal(phaseWritesAfter.length, 0);
    void writesBefore;
  });
});

// ── P2-4 original=false staging verify fail ────────────────────────

describe('P2-4 original=false staging verifier fail → state-invalid', () => {
  it('origF T=absent A=absent + staging verifier throws → unique state-invalid; zero rename/refetch/delete/receipt', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    // no target, no anchor
    await writeTree(paths.stagingPathAbs, { 'bad.txt': 'CORRUPT' });

    const store = createStateStoreDouble({
      phase: 'anchor-intent',
      originalTargetExisted: false,
      oldStructureFingerprint: null,
      oldContentSha256: null,
    });
    const harness = createRenameHarness();
    let reFetch = 0;
    const v = createVerifiers({
      stagingThrow: new LinkeError(INTEGRITY_FAILED),
    });

    await expectRejects(
      () =>
        recoverFromCrash({
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
          verifyStagingTree: v.verifyStagingTree,
          verifyTargetTree: v.verifyTargetTree,
          reFetchForbidden: true,
          reFetch: async () => {
            reFetch += 1;
          },
        }),
      STATE_INVALID,
      { statusCode: 500, leakTokens: [paths.stagingPathAbs, root] },
    );

    assert.equal(reFetch, 0);
    assert.equal(harness.calls.length, 0);
    assert.equal(store.writeReceiptCalls, 0);
    assert.equal(store.receipt, null);
    assert.equal(await exists(paths.stagingPathAbs), true);
    assert.equal(await exists(paths.targetPathAbs), false);
    assert.equal(await exists(paths.anchorPathAbs), false);
    assert.equal(store.state.phase, 'anchor-intent');
  });
});

// ── anchored legal shape + illegal staging canaries ────────────────

describe('anchored legal base + illegal staging type/absent canaries', () => {
  /** @type {ReadonlyArray<{ label: string, staging: 'absent' | 'file' | 'symlink', original: boolean }>} */
  const STAGING_CANARIES = Object.freeze([
    { label: 'origT staging-absent', staging: 'absent', original: true },
    { label: 'origT staging-file', staging: 'file', original: true },
    { label: 'origT staging-symlink', staging: 'symlink', original: true },
    { label: 'origF staging-absent', staging: 'absent', original: false },
    { label: 'origF staging-file', staging: 'file', original: false },
    { label: 'origF staging-symlink', staging: 'symlink', original: false },
  ]);

  for (const row of STAGING_CANARIES) {
    it(`anchored legal T/A + ${row.label} → unique state-invalid; zero publish/delete`, async () => {
      const root = /** @type {string} */ (tempRoot);
      const paths = siblingPaths(root);
      await mkdir(dirname(paths.targetPathAbs), { recursive: true });

      // Legal anchored shape
      if (row.original) {
        await writeTree(paths.anchorPathAbs, { 'old.txt': 'OLD' });
        // target absent
      }
      // else both target and anchor absent

      if (row.staging === 'absent') {
        // leave staging missing
      } else {
        await materialize(paths.stagingPathAbs, row.staging, 'stg');
      }

      let oldStructure = null;
      let oldContent = null;
      if (row.original) {
        oldStructure = await computeStructureFingerprint(paths.anchorPathAbs);
        oldContent = await computeContentSha256(paths.anchorPathAbs);
      }

      const store = createStateStoreDouble({
        phase: 'anchored',
        originalTargetExisted: row.original,
        oldStructureFingerprint: oldStructure,
        oldContentSha256: oldContent,
      });
      const harness = createRenameHarness();
      const v = createVerifiers();

      await expectRejects(
        () =>
          recoverFromCrash({
            stateStore: store,
            paths: {
              targetPathAbs: paths.targetPathAbs,
              stagingPathAbs: paths.stagingPathAbs,
              anchorPathAbs: paths.anchorPathAbs,
              quarantinePathAbs: paths.quarantinePathAbs,
            },
            originalTargetExisted: row.original,
            oldStructureFingerprint: oldStructure,
            oldContentSha256: oldContent,
            cancelRequested: false,
            rename: harness.rename,
            lstat: realLstat,
            verifyStagingTree: v.verifyStagingTree,
            verifyTargetTree: v.verifyTargetTree,
            reFetchForbidden: true,
          }),
        STATE_INVALID,
        {
          statusCode: 500,
          leakTokens: [paths.stagingPathAbs, paths.anchorPathAbs, root],
        },
      );

      assert.equal(store.state.phase, 'anchored');
      assert.equal(harness.calls.length, 0, 'zero publish rename');
      assert.equal(store.durablePhases.includes('publish-intent'), false);
      assert.equal(store.durablePhases.includes('published'), false);
      if (row.original) assert.equal(await exists(paths.anchorPathAbs), true);
      if (row.staging !== 'absent') assert.equal(await exists(paths.stagingPathAbs), true);
    });
  }
});

// ── Kimi P1/P2 fault-injection RED canaries ────────────────────────

describe('Kimi P1 — finishPrePublishRolledBack receipt-before-terminal order', () => {
  it('P2-4 early rollback: receipt must be durable before terminal phase; crash mid-order remains recoverable', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    // P2-4: original at target, staging corrupt verifier fails
    await writeTree(paths.targetPathAbs, { 'old.txt': 'ORIGINAL' });
    await writeTree(paths.stagingPathAbs, { 'bad.txt': 'CORRUPT' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);

    const store = createStateStoreDouble(
      {
        phase: 'anchor-intent',
        originalTargetExisted: true,
        oldStructureFingerprint: oldStructure,
        oldContentSha256: oldContent,
      },
      { crashAfterTerminalPhaseWithoutReceipt: true },
    );
    const harness = createRenameHarness();
    const v = createVerifiers({
      stagingThrow: new LinkeError(INTEGRITY_FAILED),
    });

    let firstErr = null;
    try {
      await recoverFromCrash({
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
        verifyStagingTree: v.verifyStagingTree,
        verifyTargetTree: v.verifyTargetTree,
        reFetchForbidden: true,
      });
    } catch (error) {
      firstErr = error;
    }

    // Desired ordering contract (PASS only after fix):
    // receipt write must precede any durable terminal phase write.
    // Current code writes phase first → crash fires with receipt still null → RED.
    const firstReceiptIdx = store.eventLog.findIndex((e) => e.kind === 'writeReceipt');
    const firstTerminalIdx = store.eventLog.findIndex(
      (e) => e.kind === 'writeState' && e.phase === 'rolled-back-awaiting-ack',
    );
    assert.ok(
      firstReceiptIdx >= 0,
      'receipt must be durably written (writeReceipt) on P2-4 early rollback',
    );
    assert.ok(
      firstTerminalIdx < 0 || firstReceiptIdx < firstTerminalIdx,
      'receipt must be durable before first fsynced rolled-back-awaiting-ack phase write',
    );

    // Desired crash-at-boundary contract (after fix: crash only possible after receipt):
    // If a crash was injected at terminal-without-receipt, the fixed implementation never
    // reaches that boundary. After recovery without the crash hook, tombstone must replay.
    // Disable crash and converge if needed.
    const store2 = createStateStoreDouble({
      phase: store.state.phase,
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
      receiptId: store.state.receiptId,
    });
    // Transfer durable receipt if any (fixed path has it; buggy path does not)
    if (store.receipt) {
      await store2.writeReceipt(TASK_ID, store.receipt);
    }
    // Mirror disk + phase for recovery
    if (store.state.phase === 'rolled-back-awaiting-ack' && !store.receipt) {
      // RED witness of current bug: terminal without tombstone is unreplayable.
      // Desired: this state must never occur — recovery must still not invent completed.
      await assert.rejects(
        () =>
          recoverFromCrash({
            stateStore: store2,
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
            verifyStagingTree: async () => {},
            verifyTargetTree: async () => {},
            reFetchForbidden: true,
          }),
        (error) => error instanceof LinkeError && error.code === STATE_INVALID,
      );
      // Force desired post-fix assertion to fail current code:
      // terminal-without-receipt is forbidden; require successful tombstone replay path instead.
      assert.fail(
        'current code left rolled-back-awaiting-ack without receipt tombstone; ' +
          'receipt must be durable before terminal phase so crash recovery can replay',
      );
    }

    // Fixed path: no terminal-without-receipt; receipt exists and is replayable.
    if (store.receipt || store2.receipt) {
      const tomb = await (store.receipt ? store : store2).readTombstone(TASK_ID);
      const projected = projectReceiptObject(tomb.receipt);
      assert.equal(projected.outcome, 'rolled-back');
      assert.equal(projected.contentSha256, oldContent);
      assert.equal(projected.structureFingerprint, oldStructure);
    }

    // If first attempt completed without crash (fixed order: receipt before phase write),
    // phase is terminal with receipt.
    if (!firstErr && store.state.phase === 'rolled-back-awaiting-ack') {
      assert.ok(store.receipt, 'terminal phase requires durable receipt');
    }
  });
});

describe('Kimi P2 — failed-target-quarantined post-rename mid-window', () => {
  it('failed-target-quarantined T=dir(old) A=absent Q=dir S=absent → fingerprint verify → rolled-back-awaiting-ack', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });

    // Exact post anchor→target rename, pre durablePhase(anchor-restored):
    // target holds original tree; anchor gone; quarantine holds failed publish; staging absent.
    await writeTree(paths.targetPathAbs, { 'old.txt': 'OLD-ORIGINAL' });
    await writeTree(paths.quarantinePathAbs, { 'pub.txt': 'FAILED-PUBLISH' });

    const oldStructure = await computeStructureFingerprint(paths.targetPathAbs);
    const oldContent = await computeContentSha256(paths.targetPathAbs);

    const store = createStateStoreDouble({
      phase: 'failed-target-quarantined',
      originalTargetExisted: true,
      oldStructureFingerprint: oldStructure,
      oldContentSha256: oldContent,
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
      cancelRequested: false,
      rename: harness.rename,
      lstat: realLstat,
      verifyStagingTree: v.verifyStagingTree,
      verifyTargetTree: v.verifyTargetTree,
      reFetchForbidden: true,
    });

    // Current code treats this as illegal (T=dir A=absent) → state-invalid RED.
    // Desired: fingerprint-verify target and converge rolled-back with receipt.
    assert.equal(store.state.phase, 'rolled-back-awaiting-ack');
    const receipt = result?.receipt ?? store.receipt;
    assert.ok(receipt, 'must produce rolled-back receipt');
    const projected = projectReceiptObject(receipt);
    assert.equal(projected.outcome, 'rolled-back');
    assert.equal(projected.anchorPresentBeforePublish, true);
    assert.equal(projected.contentSha256, oldContent);
    assert.equal(projected.structureFingerprint, oldStructure);
    // No further rename required (already restored on disk)
    assert.equal(
      harness.calls.filter((c) => c.from === paths.anchorPathAbs).length,
      0,
      'anchor already absent — no second restore rename required',
    );
    assert.equal(await exists(paths.targetPathAbs), true);
    assert.equal(await exists(paths.quarantinePathAbs), true);
    assert.equal(await exists(paths.anchorPathAbs), false);
  });
});

describe('Kimi P2 — cleanupId durability requires writeState', () => {
  it('transitionPhase-only store (no writeState): fail-closed state-invalid before rm and cleanup receipt', async () => {
    const root = /** @type {string} */ (tempRoot);
    const paths = siblingPaths(root);
    await mkdir(dirname(paths.targetPathAbs), { recursive: true });
    await writeTree(paths.stagingPathAbs, { 'left.txt': 'LEFT' });

    const store = createStateStoreDouble(
      { phase: 'cancelled-local', cleanupId: null },
      { omitWriteState: true },
    );
    assert.equal(typeof store.writeState, 'undefined', 'fixture must omit writeState');

    let rmCalls = 0;
    await expectRejects(
      () =>
        recoverCancelledLocal({
          stateStore: store,
          stagingPathAbs: paths.stagingPathAbs,
          taskId: TASK_ID,
          deviceId: DEVICE_ID,
          cleanupId: null,
          rm: async (p, opts) => {
            rmCalls += 1;
            store.noteRm();
            await rm(p, opts);
          },
        }),
      STATE_INVALID,
      {
        statusCode: 500,
        retryable: false,
        leakTokens: [paths.stagingPathAbs, root, 'secret-token'],
      },
    );

    assert.equal(rmCalls, 0, 'must not rm before durable cleanupId');
    assert.equal(store.rmCalls, 0);
    assert.equal(store.writeCleanupReceiptCalls, 0, 'must not write CleanupReceipt without durable cleanupId');
    assert.equal(await exists(paths.stagingPathAbs), true, 'staging preserved on fail-closed');
  });
});

describe('crash tables import surface', () => {
  it('binds four C4 entrypoints for module graph completeness', () => {
    assert.equal(typeof publishFromStagingVerified, 'function');
    assert.equal(typeof recoverFromCrash, 'function');
    assert.equal(typeof rollbackPublished, 'function');
    assert.equal(typeof recoverCancelledLocal, 'function');
  });
});
