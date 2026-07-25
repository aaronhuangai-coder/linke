/**
 * Linke V1.43 Task 5 — concurrency + real process-lock proof C1–C6.
 *
 * Exactly six top-level `it` cases. No skip/todo/only on cases.
 * Same-process FIFO races use lease-scoped observer.peekTail() (no production seam).
 * C4–C5 use real independent Node children + /usr/bin/lockf on Darwin.
 * Non-Darwin hosts may skip the whole suite via describe.skip.
 *
 * Child helper: test/helpers/audit-integrity-rotation-child.js
 * Authorization: local defensive integrity / concurrency / crash-recovery tests only;
 * only mkdtemp-isolated roots; no credentials, production paths, or external systems.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ERROR_CODES } from '../src/error-codes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD_PATH = join(__dirname, 'helpers', 'audit-integrity-rotation-child.js');
const REPO_ROOT = join(__dirname, '..');

const ROTATION_MODULE_SPEC = '../src/audit-integrity-rotation.js';
const ROTATION_STATE_MODULE_SPEC = '../src/audit-integrity-rotation-state.js';
const DUAL_WRITE_MODULE_SPEC = '../src/audit-integrity-dual-write.js';
const DUAL_WRITE_STATE_MODULE_SPEC = '../src/audit-integrity-dual-write-state.js';
const JOURNAL_MODULE_SPEC = '../src/audit-integrity-journal.js';
const CROSS_STORE_MODULE_SPEC = '../src/audit-integrity-cross-store.js';
const MONITOR_MODULE_SPEC = '../src/audit-integrity-monitor.js';
const QUEUE_MODULE_SPEC = '../src/audit-integrity-write-queue.js';
const SAFE_ROOT_MODULE_SPEC = '../src/safe-data-files.js';

const CODE_PRECONDITION = ERROR_CODES.AUDIT_INTEGRITY_ROTATION_PRECONDITION_FAILED;
const CODE_RECOVERY_REQUIRED = ERROR_CODES.AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED;
const CODE_PROCESS_LOCK = ERROR_CODES.AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE;

const CRASH_AFTER_PREPARED = 'TEST_CRASH_AFTER_PREPARED';

const LOCK_REL = 'audit/integrity-write.lock';
/** Non-business barrier leaf (must never live under audit/**). */
const BARRIER_LEAF = '.linke-rotation-child-go';

const EVENT_A = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-19T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
  outcome: 'success',
});

const EVENT_B = Object.freeze({
  id: '22222222-2222-4222-8222-222222222222',
  createdAt: '2026-07-19T00:00:01.000Z',
  type: 'api.test',
  method: 'GET',
  path: '/api/other',
  outcome: 'success',
});

/** Must match helper fixed append event. */
const CHILD_APPEND_EVENT = Object.freeze({
  id: '33333333-3333-4333-8333-333333333333',
  createdAt: '2026-07-20T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/rotation-child-append',
  outcome: 'success',
});

const DARWIN = process.platform === 'darwin';
const LOCKF_OK = DARWIN && existsSync('/usr/bin/lockf');
const SUITE_REASON = 'C1–C6 real process-lock proof requires macOS + /usr/bin/lockf';
const suite = LOCKF_OK ? describe : describe.skip;

const CHILD_READY_MS = 30_000;
const CHILD_DONE_MS = 60_000;
const CHILD_POLL_MS = 20;
const MULTIPROCESS_REPEATS = 2;

// ── loaders ────────────────────────────────────────────────────────────

async function loadRotation() {
  return import(ROTATION_MODULE_SPEC);
}

async function loadRotationState() {
  return import(ROTATION_STATE_MODULE_SPEC);
}

async function loadDualWrite() {
  return import(DUAL_WRITE_MODULE_SPEC);
}

async function loadDualWriteState() {
  return import(DUAL_WRITE_STATE_MODULE_SPEC);
}

async function loadJournal() {
  return import(JOURNAL_MODULE_SPEC);
}

async function loadCrossStore() {
  return import(CROSS_STORE_MODULE_SPEC);
}

async function loadMonitor() {
  return import(MONITOR_MODULE_SPEC);
}

async function loadQueue() {
  return import(QUEUE_MODULE_SPEC);
}

async function loadSafeRoot() {
  return import(SAFE_ROOT_MODULE_SPEC);
}

// ── paths ──────────────────────────────────────────────────────────────

function journalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}

function eventsAbs(root) {
  return join(root, 'audit', 'events.jsonl');
}

function dualStateAbs(root) {
  return join(root, 'audit', 'integrity-dual-write-state.json');
}

function rotationStateAbs(root) {
  return join(root, 'audit', 'integrity-rotation-state.json');
}

function archiveRootAbs(root) {
  return join(root, 'audit', 'archive');
}

function archiveDirAbs(root, generationId) {
  return join(root, 'audit', 'archive', generationId);
}

function archiveJournalAbs(root, generationId) {
  return join(archiveDirAbs(root, generationId), 'integrity-journal.jsonl');
}

function archiveEventsAbs(root, generationId) {
  return join(archiveDirAbs(root, generationId), 'events.jsonl');
}

function archiveManifestAbs(root, generationId) {
  return join(archiveDirAbs(root, generationId), 'manifest.json');
}

function lockAbs(root) {
  return join(root, LOCK_REL);
}

function barrierAbs(root) {
  return join(root, BARRIER_LEAF);
}

// ── fixtures / wait ────────────────────────────────────────────────────

/**
 * @param {string} prefix
 * @param {(root: string) => Promise<unknown>} fn
 */
async function withTempRoot(prefix, fn) {
  const root = resolve(await mkdtemp(join(tmpdir(), `linke-rot-c1c6-${prefix}-`)));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Condition-driven macrotask wait. maxTurns is hang safety only.
 * @param {() => boolean} predicate
 * @param {{ maxTurns?: number }} [opts]
 */
async function waitUntil(predicate, { maxTurns = 10000 } = {}) {
  for (let i = 0; i < maxTurns; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitUntil: condition not met within macrotask budget');
}

/**
 * Bounded poll with deadline. Short polls only for child/barrier readiness.
 * @template T
 * @param {() => T | Promise<T>} probe
 * @param {(value: T) => boolean} pred
 * @param {number} deadlineMs
 * @param {string} diagnostic
 * @param {number} [intervalMs]
 * @returns {Promise<T>}
 */
async function pollUntil(probe, pred, deadlineMs, diagnostic, intervalMs = CHILD_POLL_MS) {
  const start = Date.now();
  let last;
  while (Date.now() - start < deadlineMs) {
    last = await probe();
    if (pred(last)) return last;
    const remaining = deadlineMs - (Date.now() - start);
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  }
  throw new Error(`${diagnostic}`);
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isTestCrash(error, code) {
  return Boolean(error && (error.code === code || error.message === code));
}

// ── typed error assertions (path/raw free) ─────────────────────────────

/**
 * @param {unknown} error
 * @param {string} code
 * @param {string} [rootHint]
 */
function assertRotationError(error, code, rootHint) {
  assert.ok(error && typeof error === 'object');
  const err = /** @type {{ name?: string, code?: string, message?: string, cause?: unknown, stack?: string }} */ (
    error
  );
  assert.equal(err.name, 'AuditIntegrityRotationError');
  assert.equal(err.code, code);
  assert.equal(err.message, code);
  assert.equal(err.message, err.code);
  assert.equal(err.cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(err, 'cause'));
  assertPathFreeText(err.message, rootHint);
  assert.ok(!String(err.stack || '').includes('ENOENT'));
  if (rootHint) {
    assert.ok(!String(err.stack || '').split('\n')[0].includes(rootHint));
  }
  return true;
}

/**
 * @param {unknown} error
 * @param {string} [rootHint]
 * @param {string[]} [forbiddenFragments]
 */
function assertProcessLockError(error, rootHint, forbiddenFragments = []) {
  assert.ok(error && typeof error === 'object');
  const err = /** @type {{ name?: string, code?: string, message?: string, cause?: unknown }} */ (
    error
  );
  assert.equal(err.name, 'AuditIntegrityProcessLockError');
  assert.equal(err.code, CODE_PROCESS_LOCK);
  assert.equal(err.message, CODE_PROCESS_LOCK);
  assert.equal(err.message, err.code);
  assert.equal(err.cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(err, 'cause'));
  assertPathFreeText(err.message, rootHint);
  for (const fragment of forbiddenFragments) {
    if (!fragment) continue;
    assert.ok(!String(err.message).includes(fragment));
    assert.ok(!String(err.code).includes(fragment));
  }
  return true;
}

/**
 * @param {string} text
 * @param {string} [rootHint]
 */
function assertPathFreeText(text, rootHint) {
  assert.ok(!text.includes('ENOENT'));
  assert.ok(!text.includes('/var/'));
  assert.ok(!text.includes('/private/'));
  assert.ok(!text.includes('/tmp/'));
  assert.ok(!text.includes('Users/'));
  assert.ok(!text.includes('errno'));
  assert.ok(!text.includes('EISDIR'));
  assert.ok(!text.includes('integrity-write.lock'));
  assert.ok(!text.includes('integrity-journal'));
  assert.ok(!text.includes('events.jsonl'));
  if (rootHint) {
    assert.ok(!text.includes(rootHint));
  }
}

/**
 * @param {unknown} value
 * @param {string} [rootHint]
 */
function assertPathFreeSurface(value, rootHint) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assertPathFreeText(text, rootHint);
  assert.ok(!text.includes('SECRET'));
}

// ── store helpers ──────────────────────────────────────────────────────

async function readOptionalBytes(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertRegular0600(path, expectedBytes) {
  const st = await lstat(path);
  assert.equal(st.isFile(), true);
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.mode & 0o777, 0o600);
  const bytes = await readFile(path);
  if (expectedBytes !== undefined) {
    assert.deepEqual(
      bytes,
      Buffer.isBuffer(expectedBytes) ? expectedBytes : Buffer.from(expectedBytes),
    );
  }
  return bytes;
}

/**
 * Snapshot known audit business leaves. Excludes barrier / lock / test files.
 * @param {string} root
 * @param {string|null} [previousGenerationId]
 */
async function snapshotBusinessStores(root, previousGenerationId = null) {
  const snap = {
    journal: await readOptionalBytes(journalAbs(root)),
    events: await readOptionalBytes(eventsAbs(root)),
    dual: await readOptionalBytes(dualStateAbs(root)),
    rotation: await readOptionalBytes(rotationStateAbs(root)),
    archJournal: null,
    archEvents: null,
    archManifest: null,
  };
  if (previousGenerationId) {
    snap.archJournal = await readOptionalBytes(
      archiveJournalAbs(root, previousGenerationId),
    );
    snap.archEvents = await readOptionalBytes(
      archiveEventsAbs(root, previousGenerationId),
    );
    snap.archManifest = await readOptionalBytes(
      archiveManifestAbs(root, previousGenerationId),
    );
  }
  return snap;
}

function assertSnapEqual(a, b, label = 'snapshot') {
  assert.deepEqual(a.journal, b.journal, `${label}: journal`);
  assert.deepEqual(a.events, b.events, `${label}: events`);
  assert.deepEqual(a.dual, b.dual, `${label}: dual`);
  assert.deepEqual(a.rotation, b.rotation, `${label}: rotation`);
  assert.deepEqual(a.archJournal, b.archJournal, `${label}: archJournal`);
  assert.deepEqual(a.archEvents, b.archEvents, `${label}: archEvents`);
  assert.deepEqual(a.archManifest, b.archManifest, `${label}: archManifest`);
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listArchiveGenerationDirs(root) {
  try {
    const entries = await readdir(archiveRootAbs(root), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function countJournalPayloadDigest(journalText, payloadDigest) {
  const lines = journalText.trimEnd().split('\n').filter((line) => line.length > 0);
  let count = 0;
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.recordKind === 'event-link' && rec.payloadDigest === payloadDigest) {
      count += 1;
    }
  }
  return count;
}

function countEventsRotationLines(eventsText, rotationId) {
  const lines = eventsText.trimEnd().split('\n').filter((line) => line.length > 0);
  let count = 0;
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.id === rotationId || event.type === 'audit-integrity-rotation') {
      count += 1;
    }
  }
  return count;
}

function countBusinessEventsByPath(eventsText, path) {
  const lines = eventsText.trimEnd().split('\n').filter((line) => line.length > 0);
  let count = 0;
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.path === path && event.type !== 'audit-integrity-rotation') {
      count += 1;
    }
  }
  return count;
}

/**
 * Healthy v1 root: dual bootstrap + one business event. No rotation WAL/archive.
 * expectedGenerationId / expectedHeadDigest from canonical dual idle.
 * @param {string} root
 */
async function createHealthyBaseline(root) {
  const {
    recoverAuditIntegrityDualWrite,
    appendAuditEventWithIntegrityDualWrite,
  } = await loadDualWrite();
  await recoverAuditIntegrityDualWrite(root);
  await appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A });

  const dualMod = await loadDualWriteState();
  const idle = dualMod.parseAuditIntegrityDualWriteStateText(
    await readFile(dualStateAbs(root), 'utf8'),
  );
  assert.equal(idle.status, 'idle');
  assert.match(idle.generationId, /^[0-9a-f]{32}$/);
  assert.match(idle.journal.headDigest, /^[0-9a-f]{64}$/);
  assert.equal(idle.events.present, true);
  assert.equal(idle.events.strictRecordCount, 1);

  await assert.rejects(() => access(rotationStateAbs(root)), { code: 'ENOENT' });
  assert.deepEqual(await listArchiveGenerationDirs(root), []);

  const journalBytes = await readFile(journalAbs(root));
  const eventsBytes = await readFile(eventsAbs(root));
  const dualBytes = await readFile(dualStateAbs(root));

  return {
    idle,
    expectedGenerationId: idle.generationId,
    expectedHeadDigest: idle.journal.headDigest,
    journalBytes,
    eventsBytes,
    dualBytes,
  };
}

/**
 * Drive rotate to CP0 (after-prepared). Leaves prepared WAL; live business bytes = CP0.
 * @param {string} root
 */
async function crashToPreparedCp0(root) {
  const fx = await createHealthyBaseline(root);
  const preJournal = fx.journalBytes;
  const preEvents = fx.eventsBytes;
  const preDual = fx.dualBytes;
  const rot = await loadRotation();

  await assert.rejects(
    () => rot.rotateAuditIntegrityGeneration(root, {
      expectedGenerationId: fx.expectedGenerationId,
      expectedHeadDigest: fx.expectedHeadDigest,
      [rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: 'after-prepared',
    }),
    (e) => isTestCrash(e, CRASH_AFTER_PREPARED),
  );

  const stateMod = await loadRotationState();
  const wal = stateMod.parseAuditIntegrityRotationStateText(
    await readFile(rotationStateAbs(root), 'utf8'),
  );
  assert.equal(wal.status, 'prepared');
  assert.equal(wal.previousGenerationId, fx.expectedGenerationId);
  assert.equal(wal.previousHeadDigest, fx.expectedHeadDigest);

  // CP0: live business bytes unchanged; no archive.
  assert.deepEqual(await readFile(journalAbs(root)), preJournal);
  assert.deepEqual(await readFile(eventsAbs(root)), preEvents);
  assert.deepEqual(await readFile(dualStateAbs(root)), preDual);
  assert.deepEqual(await listArchiveGenerationDirs(root), []);

  return {
    fx,
    wal,
    preJournal,
    preEvents,
    preDual,
    previousGenerationId: wal.previousGenerationId,
  };
}

/**
 * Assert completed rotation facts from canonical WAL/dual/journal/archive/monitor.
 * @param {string} root
 * @param {object} opts
 */
async function assertCompletedRotationHealthy(root, opts = {}) {
  const {
    previousGenerationId = null,
    preJournal = null,
    preEvents = null,
    expectBusinessAppendPath = null,
    expectBusinessAppendCount = 0,
    expectOnlyRotationEvent = false,
    rootHint = root,
  } = opts;

  const stateMod = await loadRotationState();
  const walRaw = await assertRegular0600(rotationStateAbs(root));
  const wal = stateMod.parseAuditIntegrityRotationStateText(walRaw.toString('utf8'));
  assert.equal(wal.status, 'completed');
  assert.notEqual(wal.status, 'prepared');
  assert.notEqual(wal.status, 'archive-committed');

  const gens = await listArchiveGenerationDirs(root);
  assert.equal(gens.length, 1, 'exactly one archive generation directory');
  assert.equal(gens[0], wal.previousGenerationId);
  if (previousGenerationId) {
    assert.equal(wal.previousGenerationId, previousGenerationId);
  }

  if (preJournal) {
    await assertRegular0600(archiveJournalAbs(root, wal.previousGenerationId), preJournal);
  } else {
    await assertRegular0600(archiveJournalAbs(root, wal.previousGenerationId));
  }
  if (preEvents) {
    await assertRegular0600(archiveEventsAbs(root, wal.previousGenerationId), preEvents);
  } else {
    await assertRegular0600(archiveEventsAbs(root, wal.previousGenerationId));
  }
  const archManifest = await assertRegular0600(
    archiveManifestAbs(root, wal.previousGenerationId),
  );
  assert.equal(archManifest.includes(0x0a), false);
  assert.equal(sha256Hex(archManifest), wal.archiveManifestDigest);

  const liveJournal = await assertRegular0600(journalAbs(root));
  const liveEvents = await assertRegular0600(eventsAbs(root));
  const liveDual = await assertRegular0600(dualStateAbs(root));

  const journalMod = await loadJournal();
  const verified = journalMod.verifyAuditIntegrityJournalText(
    liveJournal.toString('utf8'),
  );
  assert.equal(verified.schemaVersion, 2);
  assert.equal(verified.generationId, wal.nextGenerationId);
  assert.equal(
    verified.generationBinding.previousGenerationId,
    wal.previousGenerationId,
  );
  assert.equal(
    verified.generationBinding.previousHeadDigest,
    wal.previousHeadDigest,
  );
  assert.equal(
    verified.generationBinding.archiveManifestDigest,
    wal.archiveManifestDigest,
  );

  assert.equal(
    countJournalPayloadDigest(
      liveJournal.toString('utf8'),
      wal.rotationEvent.payloadDigest,
    ),
    1,
    'rotation payloadDigest exactly once in journal',
  );
  assert.equal(
    countEventsRotationLines(liveEvents.toString('utf8'), wal.rotationId),
    1,
    'rotation business event exactly once in events',
  );

  if (expectOnlyRotationEvent) {
    // Live events should be sealed archive events + exactly one rotation line (no failed append).
    const sealedCount = wal.events.sealed.strictRecordCount;
    const lines = liveEvents.toString('utf8').trimEnd().split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, sealedCount + 1);
    assert.equal(verified.recordCount, 2);
  }

  if (expectBusinessAppendPath) {
    assert.equal(
      countBusinessEventsByPath(liveEvents.toString('utf8'), expectBusinessAppendPath),
      expectBusinessAppendCount,
    );
  }

  const dualMod = await loadDualWriteState();
  const idle = dualMod.parseAuditIntegrityDualWriteStateText(
    liveDual.toString('utf8'),
  );
  assert.equal(idle.status, 'idle');
  assert.equal(idle.generationId, wal.nextGenerationId);

  const cross = await loadCrossStore();
  const rel = await cross.verifyAuditIntegrityAgainstEventStore(root);
  // Cross-store SoT: relationship allowlist first; state follows relationship.
  // journal-suffix-of-events (retained sealed events longer than v2 journal) is
  // state:'partial' with uncoveredEventCount>0 — not broken; monitor stays healthy.
  assert.ok(
    rel.relationship === 'equal'
    || rel.relationship === 'events-suffix-of-journal'
    || rel.relationship === 'journal-suffix-of-events',
    `unexpected relationship ${rel.relationship}`,
  );
  if (
    rel.relationship === 'equal'
    || rel.relationship === 'events-suffix-of-journal'
  ) {
    assert.equal(rel.state, 'verified');
  } else {
    assert.equal(rel.relationship, 'journal-suffix-of-events');
    assert.equal(rel.state, 'partial');
    assert.ok(
      typeof rel.uncoveredEventCount === 'number' && rel.uncoveredEventCount > 0,
      'journal-suffix-of-events must report uncoveredEventCount > 0',
    );
  }

  const report = await runMonitorOnce(root);
  assert.equal(report.status, 'healthy');
  assert.equal(report.code, 'healthy');
  assert.equal(report.recoveryRequired, false);
  assert.equal(report.alertRequired, false);
  assert.equal(report.nextAction, 'none');
  assert.equal(report.reasonCode, null);
  assertPathFreeSurface(report, rootHint);

  return { wal, idle, liveJournal, liveEvents, rel, report };
}

/**
 * No rotation WAL / no archive branch.
 * @param {string} root
 */
async function assertNoRotationArtifacts(root) {
  await assert.rejects(() => access(rotationStateAbs(root)), { code: 'ENOENT' });
  assert.deepEqual(await listArchiveGenerationDirs(root), []);
}

/**
 * Healthy v1 after business append, no rotation.
 * @param {string} root
 * @param {object} opts
 */
async function assertHealthyV1NoRotation(root, opts = {}) {
  const {
    expectedBusinessPath = EVENT_B.path,
    expectedBusinessCount = 1,
    rootHint = root,
  } = opts;

  await assertNoRotationArtifacts(root);

  const dualMod = await loadDualWriteState();
  const idle = dualMod.parseAuditIntegrityDualWriteStateText(
    await readFile(dualStateAbs(root), 'utf8'),
  );
  assert.equal(idle.status, 'idle');
  assert.equal(idle.events.present, true);

  const journalMod = await loadJournal();
  const verified = journalMod.verifyAuditIntegrityJournalText(
    await readFile(journalAbs(root), 'utf8'),
  );
  assert.equal(verified.schemaVersion, 1);
  assert.equal(verified.generationId, idle.generationId);

  const eventsText = await readFile(eventsAbs(root), 'utf8');
  assert.equal(
    countBusinessEventsByPath(eventsText, expectedBusinessPath),
    expectedBusinessCount,
  );
  assert.equal(countEventsRotationLines(eventsText, ''), 0);

  const cross = await loadCrossStore();
  const rel = await cross.verifyAuditIntegrityAgainstEventStore(root);
  assert.equal(rel.state, 'verified');

  const report = await runMonitorOnce(root);
  assert.equal(report.status, 'healthy');
  assert.equal(report.code, 'healthy');
  assert.equal(report.recoveryRequired, false);
  assert.equal(report.reasonCode, null);
  assertPathFreeSurface(report, rootHint);

  return { idle, verified, rel, report };
}

async function runMonitorOnce(root) {
  const { runAuditIntegrityMonitor } = await loadMonitor();
  return runAuditIntegrityMonitor(root);
}

// ── same-process held FIFO race ────────────────────────────────────────

/**
 * Hold same-root write queue, start first then second public call without
 * awaiting either. Tail identity proves real enqueue before release.
 * Matches dual-write runHeldPublicRace pattern (no production export).
 *
 * @param {string} resolvedRoot
 * @param {() => Promise<unknown>} firstStart
 * @param {() => Promise<unknown>} secondStart
 */
async function runHeldPublicRace(resolvedRoot, firstStart, secondStart) {
  const { enqueueAuditIntegrityWriteTask } = await loadQueue();

  let releaseHold;
  const holdP = new Promise((resolveHold) => {
    releaseHold = resolveHold;
  });
  let holdEntered = false;
  /** @type {{ peekTail: () => unknown } | undefined} */
  let holdObserver;
  const hold = enqueueAuditIntegrityWriteTask(resolvedRoot, async (_lease, observer) => {
    holdObserver = observer;
    holdEntered = true;
    await holdP;
  });
  await waitUntil(() => holdEntered === true);
  assert.equal(holdEntered, true, 'hold task must own the shared root queue');
  assert.ok(holdObserver, 'hold must receive a lease-scoped observer');
  const tailAfterHold = holdObserver.peekTail();
  assert.ok(tailAfterHold, 'hold must install a same-root queue tail');

  let firstSettled = false;
  let secondSettled = false;
  const firstP = firstStart().finally(() => {
    firstSettled = true;
  });
  await waitUntil(() => {
    assert.equal(firstSettled, false, 'first public call must still be waiting on hold');
    return holdObserver.peekTail() !== tailAfterHold;
  });
  assert.equal(firstSettled, false);
  const tailAfterFirst = holdObserver.peekTail();
  assert.ok(tailAfterFirst);
  assert.notEqual(tailAfterFirst, tailAfterHold);

  const secondP = secondStart().finally(() => {
    secondSettled = true;
  });
  await waitUntil(() => {
    assert.equal(firstSettled, false, 'first must remain unsettled before hold release');
    assert.equal(secondSettled, false, 'second must remain unsettled before hold release');
    return holdObserver.peekTail() !== tailAfterFirst;
  });

  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  assert.notEqual(
    holdObserver.peekTail(),
    tailAfterFirst,
    'second public call must have enqueued behind first',
  );

  // Prevent unhandledRejection flakes for expected rejections; still await originals.
  firstP.catch(() => {});
  secondP.catch(() => {});
  releaseHold();
  await hold;
  await Promise.allSettled([firstP, secondP]);

  return {
    firstP,
    secondP,
    get firstSettled() {
      return firstSettled;
    },
    get secondSettled() {
      return secondSettled;
    },
  };
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: unknown }>}
 */
async function settleResult(promise) {
  try {
    const value = await promise;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

// ── real child process mailbox ─────────────────────────────────────────

/**
 * Minimal env: PATH (+ safe TMPDIR). No credential inheritance.
 * @returns {NodeJS.ProcessEnv}
 */
function minimalChildEnv() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: process.env.TMPDIR || tmpdir(),
  };
}

/**
 * @typedef {{
 *   child: import('node:child_process').ChildProcess,
 *   pid: number,
 *   stdout: string,
 *   stderr: string,
 *   exit: { code: number | null, signal: string | null } | null,
 *   exitWaiters: Array<{
 *     settled: boolean,
 *     timer: NodeJS.Timeout | undefined,
 *     resolve: (v: { code: number | null, signal: string | null }) => void,
 *     reject: (e: Error) => void,
 *   }>,
 *   kill: () => void,
 * }} ChildMailbox
 */

/**
 * Spawn child with persistent stdout/stderr/exit mailbox attached before return.
 * @param {string[]} argvArgs args after execPath + child script
 * @returns {ChildMailbox}
 */
function spawnRotationChild(argvArgs) {
  const child = spawn(
    process.execPath,
    [CHILD_PATH, ...argvArgs],
    {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: minimalChildEnv(),
      cwd: REPO_ROOT,
    },
  );

  /** @type {ChildMailbox} */
  const life = {
    child,
    pid: 0,
    stdout: '',
    stderr: '',
    exit: null,
    exitWaiters: [],
    kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    },
  };

  if (typeof child.pid === 'number' && child.pid > 0) {
    life.pid = child.pid;
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    life.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    life.stderr += chunk;
  });
  child.on('error', (err) => {
    if (life.exit) return;
    life.exit = { code: null, signal: null };
    const wrapped = new Error(
      `child spawn error: ${err && err.message ? err.message : 'unknown'}`,
    );
    for (const w of life.exitWaiters) {
      if (w.settled) continue;
      w.settled = true;
      if (w.timer !== undefined) clearTimeout(w.timer);
      w.reject(wrapped);
    }
    life.exitWaiters.length = 0;
  });
  child.on('exit', (code, signal) => {
    if (life.exit) return;
    life.exit = {
      code: code === undefined ? null : code,
      signal: signal === undefined ? null : signal,
    };
    for (const w of life.exitWaiters) {
      if (w.settled) continue;
      w.settled = true;
      if (w.timer !== undefined) clearTimeout(w.timer);
      w.resolve(life.exit);
    }
    life.exitWaiters.length = 0;
  });

  return life;
}

/**
 * @param {ChildMailbox} life
 * @param {number} ms
 */
function waitChildExit(life, ms) {
  if (life.exit) return Promise.resolve(life.exit);
  return new Promise((resolveExit, reject) => {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const waiter = {
      settled: false,
      timer: undefined,
      resolve: resolveExit,
      reject,
    };
    timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      life.exitWaiters = life.exitWaiters.filter((w) => w !== waiter);
      reject(new Error(`child exit deadline exceeded pid=${life.pid || '?'}`));
    }, ms);
    waiter.timer = timer;
    life.exitWaiters.push(waiter);
  });
}

/**
 * Wait until stdout contains a full line equal to needle.
 * @param {ChildMailbox} life
 * @param {string} needle
 * @param {number} deadlineMs
 */
async function waitStdoutLine(life, needle, deadlineMs) {
  await pollUntil(
    () => life.stdout,
    (text) => text.split('\n').includes(needle),
    deadlineMs,
    `child stdout missing line ${needle} (pid=${life.pid || '?'})`,
  );
}

/**
 * Parse fixed RESULT line from child stdout. Path-free protocol only.
 * @param {ChildMailbox} life
 * @returns {string} e.g. OK:rotated | ERROR:audit-integrity-rotation-precondition-failed
 */
function parseChildResult(life) {
  const lines = life.stdout.split('\n').filter((l) => l.length > 0);
  const resultLines = lines.filter((l) => l.startsWith('RESULT:'));
  assert.equal(resultLines.length, 1, 'exactly one RESULT line');
  assert.ok(lines.includes('DONE'), 'DONE line required');
  assert.ok(lines.includes('READY'), 'READY line required');
  const result = resultLines[0].slice('RESULT:'.length);
  assert.match(result, /^(OK:rotated|OK:append|ERROR:[a-z0-9-]+)$/);
  // Never leak paths via child protocol.
  assert.ok(!life.stdout.includes(REPO_ROOT));
  assert.ok(!life.stdout.includes(BARRIER_LEAF));
  assert.ok(!life.stdout.includes('Users/'));
  assert.ok(!life.stderr.includes('Users/'));
  return result;
}

/**
 * Atomically create the shared go barrier once (wx exclusive).
 * @param {string} root
 */
async function createGoBarrier(root) {
  await writeFile(barrierAbs(root), 'go\n', { flag: 'wx', mode: 0o600 });
}

/**
 * Spawn two children, wait READY, release barrier once, collect results.
 * @param {string} root
 * @param {string[]} firstArgs
 * @param {string[]} secondArgs
 */
async function runTwoChildBarrierRace(root, firstArgs, secondArgs) {
  const a = spawnRotationChild(firstArgs);
  const b = spawnRotationChild(secondArgs);
  try {
    await waitStdoutLine(a, 'READY', CHILD_READY_MS);
    await waitStdoutLine(b, 'READY', CHILD_READY_MS);

    assert.ok(a.pid > 0, 'child A must have pid');
    assert.ok(b.pid > 0, 'child B must have pid');
    assert.notEqual(a.pid, process.pid);
    assert.notEqual(b.pid, process.pid);
    assert.notEqual(a.pid, b.pid);

    await createGoBarrier(root);

    const [exitA, exitB] = await Promise.all([
      waitChildExit(a, CHILD_DONE_MS),
      waitChildExit(b, CHILD_DONE_MS),
    ]);

    // Drain any trailing buffers after exit.
    await pollUntil(
      () => ({ a: a.stdout, b: b.stdout }),
      (v) => v.a.includes('DONE') && v.b.includes('DONE'),
      5_000,
      'children missing DONE after exit',
    );

    const resultA = parseChildResult(a);
    const resultB = parseChildResult(b);

    // Known typed / OK results must leave stderr empty.
    if (!resultA.startsWith('ERROR:worker-error')) {
      assert.equal(a.stderr, '', 'child A stderr must be empty for typed/OK');
    }
    if (!resultB.startsWith('ERROR:worker-error')) {
      assert.equal(b.stderr, '', 'child B stderr must be empty for typed/OK');
    }

    return {
      a: { pid: a.pid, result: resultA, exit: exitA, stdout: a.stdout, stderr: a.stderr },
      b: { pid: b.pid, result: resultB, exit: exitB, stdout: b.stdout, stderr: b.stderr },
    };
  } finally {
    a.kill();
    b.kill();
  }
}

// ── C1–C6 ──────────────────────────────────────────────────────────────

suite('Linke V1.43 Task 5 concurrency + real process-lock proof (C1–C6)', () => {
  it('C1 same-process rotate vs append (rotate-first and append-first sequential subroots)', async () => {
    // --- rotate-first ---
    await withTempRoot('c1-rotate-first', async (root) => {
      const fx = await createHealthyBaseline(root);
      const preJournal = fx.journalBytes;
      const preEvents = fx.eventsBytes;
      const { assertSafeDataRoot } = await loadSafeRoot();
      const resolvedRoot = await assertSafeDataRoot(root);
      const rot = await loadRotation();
      const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();

      const race = await runHeldPublicRace(
        resolvedRoot,
        () => rot.rotateAuditIntegrityGeneration(root, {
          expectedGenerationId: fx.expectedGenerationId,
          expectedHeadDigest: fx.expectedHeadDigest,
        }),
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_B }),
      );

      const first = await settleResult(race.firstP);
      const second = await settleResult(race.secondP);
      assert.equal(first.ok, true, 'rotate-first: rotate must succeed');
      assert.equal(/** @type {{ value: { state: string } }} */ (first).value.state, 'rotated');
      assert.equal(second.ok, true, 'rotate-first: append must succeed after rotate');

      const facts = await assertCompletedRotationHealthy(root, {
        previousGenerationId: fx.expectedGenerationId,
        preJournal,
        preEvents,
        expectBusinessAppendPath: EVENT_B.path,
        expectBusinessAppendCount: 1,
        rootHint: root,
      });
      assert.equal(facts.wal.previousHeadDigest, fx.expectedHeadDigest);
      // Journal v2: open + rotation + business append.
      const journalMod = await loadJournal();
      const verified = journalMod.verifyAuditIntegrityJournalText(
        facts.liveJournal.toString('utf8'),
      );
      assert.equal(verified.recordCount, 3);
    });

    // --- append-first ---
    await withTempRoot('c1-append-first', async (root) => {
      const fx = await createHealthyBaseline(root);
      const before = await snapshotBusinessStores(root);
      const { assertSafeDataRoot } = await loadSafeRoot();
      const resolvedRoot = await assertSafeDataRoot(root);
      const rot = await loadRotation();
      const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();

      // Stale expected captured before race (old v1 head).
      const staleOpts = {
        expectedGenerationId: fx.expectedGenerationId,
        expectedHeadDigest: fx.expectedHeadDigest,
      };

      const race = await runHeldPublicRace(
        resolvedRoot,
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_B }),
        () => rot.rotateAuditIntegrityGeneration(root, staleOpts),
      );

      const first = await settleResult(race.firstP);
      const second = await settleResult(race.secondP);
      assert.equal(first.ok, true, 'append-first: append must succeed');
      assert.equal(second.ok, false, 'append-first: stale rotate must fail');
      assertRotationError(second.error, CODE_PRECONDITION, root);

      await assertNoRotationArtifacts(root);
      // Business append exactly once; dual/cross-store/monitor healthy on v1.
      await assertHealthyV1NoRotation(root, {
        expectedBusinessPath: EVENT_B.path,
        expectedBusinessCount: 1,
        rootHint: root,
      });

      // Rotation did not appear; dual advanced past baseline.
      const after = await snapshotBusinessStores(root);
      assert.equal(after.rotation, null);
      assert.ok(after.events && before.events);
      assert.ok(after.events.length > before.events.length);
    });
  });

  it('C2 same-process rotate vs rotate (second requires recovery)', async () => {
    await withTempRoot('c2-rotate-rotate', async (root) => {
      const fx = await createHealthyBaseline(root);
      const preJournal = fx.journalBytes;
      const preEvents = fx.eventsBytes;
      const { assertSafeDataRoot } = await loadSafeRoot();
      const resolvedRoot = await assertSafeDataRoot(root);
      const rot = await loadRotation();
      const opts = {
        expectedGenerationId: fx.expectedGenerationId,
        expectedHeadDigest: fx.expectedHeadDigest,
      };

      const race = await runHeldPublicRace(
        resolvedRoot,
        () => rot.rotateAuditIntegrityGeneration(root, opts),
        () => rot.rotateAuditIntegrityGeneration(root, opts),
      );

      const first = await settleResult(race.firstP);
      const second = await settleResult(race.secondP);
      assert.equal(first.ok, true);
      assert.equal(/** @type {{ value: { state: string } }} */ (first).value.state, 'rotated');
      assert.equal(second.ok, false);
      assertRotationError(second.error, CODE_RECOVERY_REQUIRED, root);

      const facts = await assertCompletedRotationHealthy(root, {
        previousGenerationId: fx.expectedGenerationId,
        preJournal,
        preEvents,
        expectOnlyRotationEvent: true,
        rootHint: root,
      });
      assert.equal(facts.wal.previousGenerationId, fx.expectedGenerationId);
      assert.notEqual(facts.wal.nextGenerationId, fx.expectedGenerationId);
      // Single generation transition chain.
      const journalMod = await loadJournal();
      const verified = journalMod.verifyAuditIntegrityJournalText(
        facts.liveJournal.toString('utf8'),
      );
      assert.equal(verified.generationBinding.previousGenerationId, fx.expectedGenerationId);
      assert.equal(verified.recordCount, 2);
    });
  });

  it('C3 same-process recover vs append (recover-first and append-first sequential subroots)', async () => {
    // --- recover-first ---
    await withTempRoot('c3-recover-first', async (root) => {
      const crashed = await crashToPreparedCp0(root);
      const beforeRace = await snapshotBusinessStores(root, crashed.previousGenerationId);
      assert.ok(beforeRace.rotation);
      assert.equal(beforeRace.archJournal, null);

      const { assertSafeDataRoot } = await loadSafeRoot();
      const resolvedRoot = await assertSafeDataRoot(root);
      const rot = await loadRotation();
      const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();

      const race = await runHeldPublicRace(
        resolvedRoot,
        () => rot.recoverAuditIntegrityRotation(root),
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_B }),
      );

      const first = await settleResult(race.firstP);
      const second = await settleResult(race.secondP);
      assert.equal(first.ok, true);
      assert.equal(/** @type {{ value: { state: string } }} */ (first).value.state, 'rotated');
      assert.equal(second.ok, true, 'append after recover must succeed on completed v2');

      const facts = await assertCompletedRotationHealthy(root, {
        previousGenerationId: crashed.previousGenerationId,
        preJournal: crashed.preJournal,
        preEvents: crashed.preEvents,
        expectBusinessAppendPath: EVENT_B.path,
        expectBusinessAppendCount: 1,
        rootHint: root,
      });
      assert.equal(facts.wal.rotationId.length > 0, true);
      const journalMod = await loadJournal();
      const verified = journalMod.verifyAuditIntegrityJournalText(
        facts.liveJournal.toString('utf8'),
      );
      assert.equal(verified.recordCount, 3);
    });

    // --- append-first ---
    await withTempRoot('c3-append-first', async (root) => {
      const crashed = await crashToPreparedCp0(root);
      const beforeAppend = await snapshotBusinessStores(root, crashed.previousGenerationId);

      const { assertSafeDataRoot } = await loadSafeRoot();
      const resolvedRoot = await assertSafeDataRoot(root);
      const rot = await loadRotation();
      const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();

      const race = await runHeldPublicRace(
        resolvedRoot,
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_B }),
        () => rot.recoverAuditIntegrityRotation(root),
      );

      const first = await settleResult(race.firstP);
      const second = await settleResult(race.secondP);
      assert.equal(first.ok, false, 'append against prepared must recovery-required');
      assertRotationError(first.error, CODE_RECOVERY_REQUIRED, root);
      assert.equal(second.ok, true);
      assert.equal(/** @type {{ value: { state: string } }} */ (second).value.state, 'rotated');

      // Failed append must not mutate business bytes before recover settles;
      // after recover: completed with only rotation event (no EVENT_B).
      const facts = await assertCompletedRotationHealthy(root, {
        previousGenerationId: crashed.previousGenerationId,
        preJournal: crashed.preJournal,
        preEvents: crashed.preEvents,
        expectBusinessAppendPath: EVENT_B.path,
        expectBusinessAppendCount: 0,
        expectOnlyRotationEvent: true,
        rootHint: root,
      });
      assert.equal(
        countBusinessEventsByPath(facts.liveEvents.toString('utf8'), EVENT_B.path),
        0,
      );
      // Archive three-leaf equals CP0 pre bytes; failed append left no EVENT_B.
      assert.deepEqual(
        await readFile(archiveJournalAbs(root, crashed.previousGenerationId)),
        crashed.preJournal,
      );
      assert.deepEqual(
        await readFile(archiveEventsAbs(root, crashed.previousGenerationId)),
        crashed.preEvents,
      );
      assert.equal(facts.wal.status, 'completed');
      assert.ok(beforeAppend.rotation, 'prepared WAL existed before recover race');
    });
  });

  it('C4 real-process rotate vs append (lockf; allowed linearizations only)', async () => {
    for (let i = 0; i < MULTIPROCESS_REPEATS; i += 1) {
      await withTempRoot(`c4-rep${i}`, async (root) => {
        const fx = await createHealthyBaseline(root);
        const preJournal = fx.journalBytes;
        const preEvents = fx.eventsBytes;

        const rotateArgs = [
          'rotate',
          '--data-dir',
          root,
          '--expected-generation-id',
          fx.expectedGenerationId,
          '--expected-head-digest',
          fx.expectedHeadDigest,
        ];
        const appendArgs = ['append', '--data-dir', root];

        const raced = await runTwoChildBarrierRace(root, rotateArgs, appendArgs);
        // Identify by operation from RESULT token set (not wall-clock order).
        const results = [raced.a.result, raced.b.result].sort();
        const resultSet = new Set([raced.a.result, raced.b.result]);

        const rotateWinner =
          resultSet.has('OK:rotated') && resultSet.has('OK:append');
        const appendWinner =
          resultSet.has('OK:append')
          && resultSet.has(`ERROR:${CODE_PRECONDITION}`);

        assert.ok(
          rotateWinner || appendWinner,
          `C4 illegal linearization results=${results.join(',')}`,
        );
        assert.equal(resultSet.size, 2, 'exactly two distinct outcomes');

        if (rotateWinner) {
          await assertCompletedRotationHealthy(root, {
            previousGenerationId: fx.expectedGenerationId,
            preJournal,
            preEvents,
            expectBusinessAppendPath: CHILD_APPEND_EVENT.path,
            expectBusinessAppendCount: 1,
            rootHint: root,
          });
          const journalMod = await loadJournal();
          const verified = journalMod.verifyAuditIntegrityJournalText(
            await readFile(journalAbs(root), 'utf8'),
          );
          assert.equal(verified.schemaVersion, 2);
          assert.equal(verified.recordCount, 3);
        } else {
          // append winner: no rotation WAL/archive; v1 + child append once.
          await assertNoRotationArtifacts(root);
          await assertHealthyV1NoRotation(root, {
            expectedBusinessPath: CHILD_APPEND_EVENT.path,
            expectedBusinessCount: 1,
            rootHint: root,
          });
          // Baseline EVENT_A still present + child append.
          const eventsText = await readFile(eventsAbs(root), 'utf8');
          assert.equal(
            countBusinessEventsByPath(eventsText, EVENT_A.path),
            1,
          );
          assert.equal(
            countBusinessEventsByPath(eventsText, CHILD_APPEND_EVENT.path),
            1,
          );
          assert.equal(countEventsRotationLines(eventsText, ''), 0);
        }

        // No partial/nonterminal/second archive.
        const gens = await listArchiveGenerationDirs(root);
        assert.ok(gens.length <= 1);
      });
    }
  });

  it('C5 real-process rotate vs rotate (one rotated, one recovery-required)', async () => {
    for (let i = 0; i < MULTIPROCESS_REPEATS; i += 1) {
      await withTempRoot(`c5-rep${i}`, async (root) => {
        const fx = await createHealthyBaseline(root);
        const preJournal = fx.journalBytes;
        const preEvents = fx.eventsBytes;

        const rotateArgs = [
          'rotate',
          '--data-dir',
          root,
          '--expected-generation-id',
          fx.expectedGenerationId,
          '--expected-head-digest',
          fx.expectedHeadDigest,
        ];

        const raced = await runTwoChildBarrierRace(root, rotateArgs, [...rotateArgs]);
        const multiset = [raced.a.result, raced.b.result].sort();
        assert.deepEqual(
          multiset,
          [`ERROR:${CODE_RECOVERY_REQUIRED}`, 'OK:rotated'].sort(),
          `C5 multiset must be exact; got ${multiset.join(',')}`,
        );

        const facts = await assertCompletedRotationHealthy(root, {
          previousGenerationId: fx.expectedGenerationId,
          preJournal,
          preEvents,
          expectOnlyRotationEvent: true,
          rootHint: root,
        });
        assert.equal(facts.wal.previousGenerationId, fx.expectedGenerationId);
        assert.notEqual(facts.wal.nextGenerationId, facts.wal.previousGenerationId);
        assert.equal((await listArchiveGenerationDirs(root)).length, 1);

        const journalMod = await loadJournal();
        const verified = journalMod.verifyAuditIntegrityJournalText(
          facts.liveJournal.toString('utf8'),
        );
        assert.equal(verified.recordCount, 2);
        assert.equal(
          verified.generationBinding.previousGenerationId,
          fx.expectedGenerationId,
        );
      });
    }
  });

  it('C6 process-lock unavailable → zero mutation (directory lock leaf)', async () => {
    await withTempRoot('c6-lock-dir', async (root) => {
      const fx = await createHealthyBaseline(root);
      const before = await snapshotBusinessStores(root);
      assert.equal(before.rotation, null);

      // Prefer atomic replace of lock leaf with a directory (test temp root only).
      const lockPath = lockAbs(root);
      await rm(lockPath, { force: true, recursive: true }).catch(() => {});
      // Ensure parent audit/ exists (baseline already created it).
      await mkdir(join(root, 'audit'), { recursive: true });
      await mkdir(lockPath);
      const lockStBefore = await lstat(lockPath);
      assert.equal(lockStBefore.isDirectory(), true);
      assert.equal(lockStBefore.isFile(), false);
      assert.equal(lockStBefore.isSymbolicLink(), false);

      const rot = await loadRotation();
      // Direct public rotate: process lock is acquired inside enqueue before task body.
      // Typed PROCESS_LOCK_UNAVAILABLE + exact byte equality prove task body never ran.
      await assert.rejects(
        () => rot.rotateAuditIntegrityGeneration(root, {
          expectedGenerationId: fx.expectedGenerationId,
          expectedHeadDigest: fx.expectedHeadDigest,
        }),
        (error) => assertProcessLockError(error, root, [
          root,
          lockPath,
          'EISDIR',
          'EACCES',
          'integrity-write.lock',
          '/usr/bin/lockf',
        ]),
      );

      const after = await snapshotBusinessStores(root);
      assertSnapEqual(before, after, 'C6 zero mutation');
      await assertNoRotationArtifacts(root);
      assert.equal(after.rotation, null);
      assert.deepEqual(after.journal, before.journal);
      assert.deepEqual(after.events, before.events);
      assert.deepEqual(after.dual, before.dual);

      // Lock occupant type preserved (still directory).
      const lockStAfter = await lstat(lockPath);
      assert.equal(lockStAfter.isDirectory(), true);
      assert.equal(lockStAfter.isFile(), false);

      // No prepared/live cutover, no archive.
      assert.deepEqual(await listArchiveGenerationDirs(root), []);
    });
  });
});
