/**
 * Linke V1.43 Task 6 RED — ordinary append + monitor gates G1–G7.
 * Dynamic namespace import only. Exactly seven top-level `it` cases (G1–G7).
 * No skip/todo/only. No production src edits. No real child processes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES } from '../src/error-codes.js';
import {
  computeAuditIntegrityEventPayloadDigest,
  stringifyStrictCanonicalSanitizedEvent,
} from '../src/audit-event-schema.js';

const ROTATION_MODULE_SPEC = '../src/audit-integrity-rotation.js';
const ROTATION_STATE_MODULE_SPEC = '../src/audit-integrity-rotation-state.js';
const DUAL_WRITE_MODULE_SPEC = '../src/audit-integrity-dual-write.js';
const DUAL_WRITE_STATE_MODULE_SPEC = '../src/audit-integrity-dual-write-state.js';
const JOURNAL_MODULE_SPEC = '../src/audit-integrity-journal.js';
const CROSS_STORE_MODULE_SPEC = '../src/audit-integrity-cross-store.js';
const MONITOR_MODULE_SPEC = '../src/audit-integrity-monitor.js';

const CODE_RECOVERY_REQUIRED = ERROR_CODES.AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED;
const CODE_STATE_INVALID = ERROR_CODES.AUDIT_INTEGRITY_ROTATION_STATE_INVALID;
const CODE_IO_ERROR = ERROR_CODES.AUDIT_INTEGRITY_ROTATION_IO_ERROR;
const CODE_CONFLICT = ERROR_CODES.AUDIT_INTEGRITY_ROTATION_CONFLICT;

const CRASH_AFTER_PREPARED = 'TEST_CRASH_AFTER_PREPARED';
const CRASH_AFTER_NEW_JOURNAL = 'TEST_CRASH_AFTER_NEW_JOURNAL';
const CRASH_AFTER_EVENTS_POST = 'TEST_CRASH_AFTER_EVENTS_POST';
const CRASH_AFTER_NEW_IDLE = 'TEST_CRASH_AFTER_NEW_IDLE';

const FIXED_CHECKED_AT = '2026-07-25T12:00:00.000Z';
const FOREIGN_MANIFEST = 'foreign\n';

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

/** Nonterminal rotation statuses via real crash hooks (CP0/CP4/CP5/CP6). */
const NONTERMINAL_CASES = Object.freeze([
  Object.freeze({
    status: 'prepared',
    hook: 'after-prepared',
    crashCode: CRASH_AFTER_PREPARED,
    cp: 'CP0',
  }),
  Object.freeze({
    status: 'archive-committed',
    hook: 'after-new-journal',
    crashCode: CRASH_AFTER_NEW_JOURNAL,
    cp: 'CP4',
  }),
  Object.freeze({
    status: 'journal-published',
    hook: 'after-events-post',
    crashCode: CRASH_AFTER_EVENTS_POST,
    cp: 'CP5',
  }),
  Object.freeze({
    status: 'events-published',
    hook: 'after-new-idle',
    crashCode: CRASH_AFTER_NEW_IDLE,
    cp: 'CP6',
  }),
]);

function isTestCrash(error, code) {
  return Boolean(error && (error.code === code || error.message === code));
}

function assertRotationError(error, code, rootHint) {
  assert.equal(error.name, 'AuditIntegrityRotationError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.message, error.code);
  assert.equal(error.cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(error, 'cause'));
  assert.ok(!error.message.includes('ENOENT'));
  assert.ok(!error.message.includes('/var/'));
  assert.ok(!error.message.includes('/private/'));
  assert.ok(!error.message.includes('/tmp/'));
  assert.ok(!error.message.includes('Users/'));
  assert.ok(!error.message.includes('errno'));
  assert.ok(!error.message.includes('foreign'));
  if (rootHint) {
    assert.ok(!error.message.includes(rootHint));
    assert.ok(!String(error.stack || '').split('\n')[0].includes(rootHint));
  }
  return true;
}

function assertDeeplyFrozen(value, path = 'root') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), `expected frozen at ${path}`);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const key of Object.keys(value)) {
    assertDeeplyFrozen(value[key], `${path}.${key}`);
  }
}

function assertPathFreeSurface(value, rootHint) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes('ENOENT'));
  assert.ok(!text.includes('/var/'));
  assert.ok(!text.includes('/private/'));
  assert.ok(!text.includes('/tmp/'));
  assert.ok(!text.includes('Users/'));
  assert.ok(!text.includes('errno'));
  assert.ok(!text.includes('SECRET'));
  assert.ok(!text.includes(FOREIGN_MANIFEST.trim()));
  if (rootHint) {
    assert.ok(!text.includes(rootHint));
  }
}

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

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-rot-g-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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

async function readOptionalBytes(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
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
 * Snapshot only known audit leaves + current-generation archive bundle.
 * Never scans outside the temp data root.
 * @param {string} root
 * @param {string|null} previousGenerationId
 */
async function snapshotKnownAuditBytes(root, previousGenerationId = null) {
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

function countJournalRotationEvents(journalText, payloadDigest) {
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

function countEventsLines(eventsText) {
  if (!eventsText || eventsText.length === 0) return 0;
  return eventsText.trimEnd().split('\n').filter((line) => line.length > 0).length;
}

async function createHealthyOneEventRoot(root) {
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
  const journalBytes = await readFile(journalAbs(root));
  const eventsBytes = await readFile(eventsAbs(root));
  const dualBytes = await readFile(dualStateAbs(root));
  assert.equal(idle.events.present, true);
  assert.ok(eventsBytes.length > 0);
  // G1 baseline: rotation WAL must be absent on healthy v1 idle.
  await assert.rejects(() => access(rotationStateAbs(root)), { code: 'ENOENT' });
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
 * Drive rotate to a nonterminal crash CP; leave state unrecovered.
 * @returns {{ fx, wal, previousGenerationId }}
 */
async function crashToNonterminal(root, { hook, crashCode, expectedWalStatus }) {
  const fx = await createHealthyOneEventRoot(root);
  const rot = await loadRotation();
  await assert.rejects(
    () => rot.rotateAuditIntegrityGeneration(root, {
      expectedGenerationId: fx.expectedGenerationId,
      expectedHeadDigest: fx.expectedHeadDigest,
      [rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: hook,
    }),
    (e) => isTestCrash(e, crashCode),
  );
  const stateMod = await loadRotationState();
  const wal = stateMod.parseAuditIntegrityRotationStateText(
    await readFile(rotationStateAbs(root), 'utf8'),
  );
  assert.equal(wal.status, expectedWalStatus);
  const walText = JSON.stringify(wal);
  assert.ok(!walText.includes(hook));
  assert.ok(!walText.includes(crashCode));
  assert.ok(!walText.includes('TEST_CRASH'));
  return {
    fx,
    wal,
    previousGenerationId: wal.previousGenerationId,
  };
}

async function createRealCompletedRotation(root) {
  const fx = await createHealthyOneEventRoot(root);
  const preJournal = fx.journalBytes;
  const preEvents = fx.eventsBytes;
  const rot = await loadRotation();
  const receipt = await rot.rotateAuditIntegrityGeneration(root, {
    expectedGenerationId: fx.expectedGenerationId,
    expectedHeadDigest: fx.expectedHeadDigest,
  });
  assert.equal(receipt.state, 'rotated');
  const stateMod = await loadRotationState();
  const wal = stateMod.parseAuditIntegrityRotationStateText(
    await readFile(rotationStateAbs(root), 'utf8'),
  );
  assert.equal(wal.status, 'completed');
  assert.equal(receipt.generationId, wal.nextGenerationId);
  await assertRegular0600(journalAbs(root));
  await assertRegular0600(eventsAbs(root));
  await assertRegular0600(dualStateAbs(root));
  await assertRegular0600(rotationStateAbs(root));
  await assertRegular0600(archiveJournalAbs(root, wal.previousGenerationId), preJournal);
  await assertRegular0600(archiveEventsAbs(root, wal.previousGenerationId), preEvents);
  await assertRegular0600(archiveManifestAbs(root, wal.previousGenerationId));
  return { fx, preJournal, preEvents, receipt, wal, rot };
}

/**
 * Rebuild canonical completed WAL with a different nextGenerationId.
 * Remaining fields stay identical so the rotation-state parser still accepts it.
 */
function rebuildCompletedWalWithNextGeneration(wal, nextGenerationId) {
  return {
    schemaVersion: wal.schemaVersion,
    status: wal.status,
    rotationId: wal.rotationId,
    createdAt: wal.createdAt,
    previousGenerationId: wal.previousGenerationId,
    previousHeadDigest: wal.previousHeadDigest,
    nextGenerationId,
    archiveRelativePath: wal.archiveRelativePath,
    archiveManifestDigest: wal.archiveManifestDigest,
    rotationEvent: {
      event: {
        id: wal.rotationEvent.event.id,
        createdAt: wal.rotationEvent.event.createdAt,
        type: wal.rotationEvent.event.type,
        outcome: wal.rotationEvent.event.outcome,
        operation: wal.rotationEvent.event.operation,
        message: wal.rotationEvent.event.message,
      },
      eventLineUtf8: wal.rotationEvent.eventLineUtf8,
      payloadDigest: wal.rotationEvent.payloadDigest,
    },
    journal: {
      previous: {
        schemaVersion: wal.journal.previous.schemaVersion,
        recordCount: wal.journal.previous.recordCount,
        headDigest: wal.journal.previous.headDigest,
        rawByteLength: wal.journal.previous.rawByteLength,
        rawSha256: wal.journal.previous.rawSha256,
      },
      next: {
        schemaVersion: wal.journal.next.schemaVersion,
        recordCount: wal.journal.next.recordCount,
        headDigest: wal.journal.next.headDigest,
        rawByteLength: wal.journal.next.rawByteLength,
        rawSha256: wal.journal.next.rawSha256,
      },
    },
    events: {
      sealed: {
        present: wal.events.sealed.present,
        strictRecordCount: wal.events.sealed.strictRecordCount,
        rawByteLength: wal.events.sealed.rawByteLength,
        rawSha256: wal.events.sealed.rawSha256,
      },
      post: {
        present: wal.events.post.present,
        strictRecordCount: wal.events.post.strictRecordCount,
        rawByteLength: wal.events.post.rawByteLength,
        rawSha256: wal.events.post.rawSha256,
      },
    },
  };
}

function differentGenerationId(previousGenerationId, nextGenerationId) {
  const candidates = [
    'ffffffffffffffffffffffffffffffff',
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    '0123456789abcdef0123456789abcdef',
  ];
  for (const c of candidates) {
    if (c !== previousGenerationId && c !== nextGenerationId) return c;
  }
  return 'dddddddddddddddddddddddddddddddd';
}

async function runMonitorOnce(root, fixed = FIXED_CHECKED_AT) {
  const {
    runAuditIntegrityMonitor,
    AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT,
  } = await loadMonitor();
  const options = Object.create(null);
  Object.defineProperty(options, AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT, {
    value: fixed,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return runAuditIntegrityMonitor(root, options);
}

describe('audit integrity rotation gates (Task 6 RED G1-G7)', () => {
  it('G1 missing rotation WAL allows existing v1 dual-write append; required gate/inspect exports are functions', async () => {
    await withTempRoot('g1-missing', async (root) => {
      await createHealthyOneEventRoot(root);
      const beforeRotation = await readOptionalBytes(rotationStateAbs(root));
      assert.equal(beforeRotation, null);

      const dualMod = await loadDualWriteState();
      const idleBefore = dualMod.parseAuditIntegrityDualWriteStateText(
        await readFile(dualStateAbs(root), 'utf8'),
      );
      const journalBefore = await readFile(journalAbs(root));
      const eventsBefore = await readFile(eventsAbs(root));
      const journalMod = await loadJournal();
      const verifiedBefore = journalMod.verifyAuditIntegrityJournalText(
        journalBefore.toString('utf8'),
      );

      const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();
      // Public return is the sanitized event (sanitizer may invent id/createdAt).
      const sanitized = await appendAuditEventWithIntegrityDualWrite(root, {
        type: EVENT_B.type,
        method: EVENT_B.method,
        path: EVENT_B.path,
        outcome: EVENT_B.outcome,
      });
      assert.equal(typeof sanitized, 'object');
      assert.ok(sanitized !== null);
      assert.equal(typeof sanitized.id, 'string');
      assert.ok(sanitized.id.length > 0);
      assert.equal(typeof sanitized.createdAt, 'string');
      assert.ok(sanitized.createdAt.length > 0);
      assert.equal(sanitized.type, EVENT_B.type);
      assert.equal(sanitized.method, EVENT_B.method);
      assert.equal(sanitized.path, EVENT_B.path);
      assert.equal(sanitized.outcome, EVENT_B.outcome);
      // Digest SoT is over the returned sanitized event, not the call-site input.
      const expectedPayloadDigest = computeAuditIntegrityEventPayloadDigest(sanitized);
      const expectedEventLine = `${stringifyStrictCanonicalSanitizedEvent(sanitized)}\n`;

      // rotation WAL remains exact-missing
      await assert.rejects(() => access(rotationStateAbs(root)), { code: 'ENOENT' });

      const journalAfter = await readFile(journalAbs(root));
      const eventsAfter = await readFile(eventsAbs(root));
      const idleAfter = dualMod.parseAuditIntegrityDualWriteStateText(
        await readFile(dualStateAbs(root), 'utf8'),
      );

      // Events: sole added line is the public strict-canonical form of the return value.
      assert.equal(
        eventsAfter.toString('utf8'),
        eventsBefore.toString('utf8') + expectedEventLine,
      );
      const lastEvent = JSON.parse(
        eventsAfter.toString('utf8').trimEnd().split('\n').at(-1),
      );
      assert.equal(lastEvent.id, sanitized.id);
      assert.equal(lastEvent.createdAt, sanitized.createdAt);
      assert.equal(lastEvent.type, sanitized.type);
      assert.equal(lastEvent.method, sanitized.method);
      assert.equal(lastEvent.path, sanitized.path);
      assert.equal(lastEvent.outcome, sanitized.outcome);

      // Journal + dual idle advance under existing public contracts.
      assert.ok(journalAfter.length > journalBefore.length);
      const verifiedAfter = journalMod.verifyAuditIntegrityJournalText(
        journalAfter.toString('utf8'),
      );
      assert.equal(verifiedAfter.recordCount, verifiedBefore.recordCount + 1);
      assert.equal(verifiedAfter.generationId, verifiedBefore.generationId);
      const inspected = await journalMod.inspectAuditIntegrityJournalFile(root);
      assert.equal(inspected.recordCount, verifiedAfter.recordCount);
      assert.equal(inspected.generationId, verifiedAfter.generationId);
      assert.equal(inspected.headDigest, verifiedAfter.headDigest);
      assert.ok(inspected.payloadDigests.includes(expectedPayloadDigest));

      assert.equal(idleAfter.status, 'idle');
      assert.equal(idleAfter.generationId, idleBefore.generationId);
      // lastTransactionId is dual-write prepared.transactionId (random UUID), not event.id.
      assert.equal(typeof idleAfter.lastTransactionId, 'string');
      assert.ok(idleAfter.lastTransactionId.length > 0);
      assert.notEqual(idleAfter.lastTransactionId, idleBefore.lastTransactionId);
      assert.notEqual(idleAfter.lastTransactionId, sanitized.id);
      assert.equal(idleAfter.lastPayloadDigest, expectedPayloadDigest);
      assert.equal(idleAfter.journal.recordCount, idleBefore.journal.recordCount + 1);
      assert.equal(
        idleAfter.events.strictRecordCount,
        idleBefore.events.strictRecordCount + 1,
      );
      assert.equal(idleAfter.lastSequence, idleBefore.lastSequence + 1);

      const cross = await loadCrossStore();
      const rel = await cross.verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(rel.state, 'verified');
      assert.ok(
        rel.relationship === 'equal'
        || rel.relationship === 'events-suffix-of-journal'
        || rel.relationship === 'journal-suffix-of-events',
        `unexpected relationship ${rel.relationship}`,
      );

      // Fixed contracts: gate lives on rotation-state; inspect on rotation coordinator.
      // Effective RED for G1 is export absence only — v1 append path above must hold.
      const stateMod = await loadRotationState();
      assert.equal(
        typeof stateMod.assertAuditIntegrityRotationAllowsAppendUnlocked,
        'function',
      );
      const rot = await loadRotation();
      assert.equal(typeof rot.inspectAuditIntegrityRotationReadOnly, 'function');
    });
  });

  it('G2 every nonterminal status blocks ordinary append without auto-recovery (CP0/CP4/CP5/CP6)', async () => {
    for (const c of NONTERMINAL_CASES) {
      await withTempRoot(`g2-${c.status}`, async (root) => {
        const { previousGenerationId } = await crashToNonterminal(root, {
          hook: c.hook,
          crashCode: c.crashCode,
          expectedWalStatus: c.status,
        });
        const before = await snapshotKnownAuditBytes(root, previousGenerationId);

        const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();
        await assert.rejects(
          () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_B }),
          (error) => assertRotationError(error, CODE_RECOVERY_REQUIRED, root),
        );

        const after = await snapshotKnownAuditBytes(root, previousGenerationId);
        assertSnapEqual(before, after, `G2 ${c.cp} ${c.status}`);

        // Must not have recovered to completed or advanced business events.
        const stateMod = await loadRotationState();
        const wal = stateMod.parseAuditIntegrityRotationStateText(
          after.rotation.toString('utf8'),
        );
        assert.equal(wal.status, c.status);
        assert.notEqual(wal.status, 'completed');
      });
    }
  });

  it('G3 invalid/io rotation state preserves typed errors on append and monitor mapping', async () => {
    // --- invalid canonical/state raw ---
    await withTempRoot('g3-invalid', async (root) => {
      await createHealthyOneEventRoot(root);
      await writeFile(
        rotationStateAbs(root),
        '{"status":"not-a-rotation-state"}',
        { mode: 0o600 },
      );
      const before = await snapshotKnownAuditBytes(root, null);

      const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_B }),
        (error) => assertRotationError(error, CODE_STATE_INVALID, root),
      );
      const afterAppend = await snapshotKnownAuditBytes(root, null);
      assertSnapEqual(before, afterAppend, 'G3 invalid append');

      const report = await runMonitorOnce(root);
      assertDeeplyFrozen(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.reasonCode, CODE_STATE_INVALID);
      assertPathFreeSurface(report, root);

      const afterMonitor = await snapshotKnownAuditBytes(root, null);
      assertSnapEqual(before, afterMonitor, 'G3 invalid monitor');
    });

    // --- rotation-state leaf is a directory (safe I/O failure) ---
    await withTempRoot('g3-io-dir', async (root) => {
      await createHealthyOneEventRoot(root);
      await rm(rotationStateAbs(root), { force: true });
      await mkdir(rotationStateAbs(root), { recursive: true });

      const before = {
        journal: await readFile(journalAbs(root)),
        events: await readFile(eventsAbs(root)),
        dual: await readFile(dualStateAbs(root)),
      };

      const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_B }),
        (error) => assertRotationError(error, CODE_IO_ERROR, root),
      );

      assert.deepEqual(await readFile(journalAbs(root)), before.journal);
      assert.deepEqual(await readFile(eventsAbs(root)), before.events);
      assert.deepEqual(await readFile(dualStateAbs(root)), before.dual);

      const report = await runMonitorOnce(root);
      assertDeeplyFrozen(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'io-alert');
      assert.equal(report.reasonCode, CODE_IO_ERROR);
      assertPathFreeSurface(report, root);

      assert.deepEqual(await readFile(journalAbs(root)), before.journal);
      assert.deepEqual(await readFile(eventsAbs(root)), before.events);
      assert.deepEqual(await readFile(dualStateAbs(root)), before.dual);
      const st = await lstat(rotationStateAbs(root));
      assert.equal(st.isDirectory(), true);
    });
  });

  it('G4 completed exact match allows normal v2 dual-write append; WAL/archive immutable', async () => {
    await withTempRoot('g4-completed-append', async (root) => {
      const { wal } = await createRealCompletedRotation(root);
      const previousGenerationId = wal.previousGenerationId;
      const walBefore = await readFile(rotationStateAbs(root));
      const archiveBefore = {
        journal: await readFile(archiveJournalAbs(root, previousGenerationId)),
        events: await readFile(archiveEventsAbs(root, previousGenerationId)),
        manifest: await readFile(archiveManifestAbs(root, previousGenerationId)),
      };
      const journalBefore = await readFile(journalAbs(root));
      const eventsBefore = await readFile(eventsAbs(root));
      const dualBefore = await readFile(dualStateAbs(root));

      const dualMod = await loadDualWriteState();
      const idleBefore = dualMod.parseAuditIntegrityDualWriteStateText(
        dualBefore.toString('utf8'),
      );
      assert.equal(idleBefore.generationId, wal.nextGenerationId);
      assert.equal(idleBefore.lastSequence, 1);

      const journalMod = await loadJournal();
      const verifiedBefore = journalMod.verifyAuditIntegrityJournalText(
        journalBefore.toString('utf8'),
      );
      assert.equal(verifiedBefore.schemaVersion, 2);
      assert.equal(verifiedBefore.generationId, wal.nextGenerationId);
      assert.equal(verifiedBefore.recordCount, 2);

      const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();
      // Must succeed. Return is sanitized event (id/createdAt may be invented).
      const written = await appendAuditEventWithIntegrityDualWrite(root, {
        type: EVENT_B.type,
        method: EVENT_B.method,
        path: EVENT_B.path,
        outcome: EVENT_B.outcome,
      });
      assert.equal(typeof written, 'object');
      assert.ok(written !== null);
      assert.equal(typeof written.id, 'string');
      assert.ok(written.id.length > 0);
      assert.equal(typeof written.createdAt, 'string');
      assert.ok(written.createdAt.length > 0);
      assert.equal(written.type, EVENT_B.type);
      assert.equal(written.method, EVENT_B.method);
      assert.equal(written.path, EVENT_B.path);
      assert.equal(written.outcome, EVENT_B.outcome);
      const expectedDigest = computeAuditIntegrityEventPayloadDigest(written);
      const expectedEventLine = `${stringifyStrictCanonicalSanitizedEvent(written)}\n`;

      const journalAfter = await readFile(journalAbs(root));
      const eventsAfter = await readFile(eventsAbs(root));
      const dualAfterBytes = await readFile(dualStateAbs(root));
      const idleAfter = dualMod.parseAuditIntegrityDualWriteStateText(
        dualAfterBytes.toString('utf8'),
      );

      const verifiedAfter = journalMod.verifyAuditIntegrityJournalText(
        journalAfter.toString('utf8'),
      );
      assert.equal(verifiedAfter.schemaVersion, 2);
      assert.equal(verifiedAfter.generationId, wal.nextGenerationId);
      assert.equal(verifiedAfter.recordCount, verifiedBefore.recordCount + 1);
      assert.equal(
        verifiedAfter.generationBinding.archiveManifestDigest,
        wal.archiveManifestDigest,
      );

      // Events sole added line matches public strict-canonical form of written.
      assert.equal(
        eventsAfter.toString('utf8'),
        eventsBefore.toString('utf8') + expectedEventLine,
      );
      const lastEvent = JSON.parse(
        eventsAfter.toString('utf8').trimEnd().split('\n').at(-1),
      );
      assert.equal(lastEvent.id, written.id);
      assert.equal(lastEvent.createdAt, written.createdAt);
      assert.equal(lastEvent.type, written.type);
      assert.equal(lastEvent.method, written.method);
      assert.equal(lastEvent.path, written.path);
      assert.equal(lastEvent.outcome, written.outcome);

      assert.equal(idleAfter.status, 'idle');
      assert.equal(idleAfter.generationId, wal.nextGenerationId);
      // lastTransactionId is prepared.transactionId (random UUID), not event.id.
      assert.equal(typeof idleAfter.lastTransactionId, 'string');
      assert.ok(idleAfter.lastTransactionId.length > 0);
      assert.notEqual(idleAfter.lastTransactionId, idleBefore.lastTransactionId);
      assert.notEqual(idleAfter.lastTransactionId, written.id);
      assert.equal(idleAfter.lastPayloadDigest, expectedDigest);
      assert.equal(idleAfter.lastSequence, idleBefore.lastSequence + 1);
      assert.equal(
        idleAfter.journal.recordCount,
        idleBefore.journal.recordCount + 1,
      );
      assert.equal(
        idleAfter.events.strictRecordCount,
        idleBefore.events.strictRecordCount + 1,
      );
      assert.ok(journalAfter.length > journalBefore.length);
      assert.ok(eventsAfter.length > eventsBefore.length);

      const cross = await loadCrossStore();
      const rel = await cross.verifyAuditIntegrityAgainstEventStore(root);
      assert.ok(
        rel.relationship === 'equal'
        || rel.relationship === 'events-suffix-of-journal'
        || rel.relationship === 'journal-suffix-of-events',
        `unexpected relationship ${rel.relationship}`,
      );

      // completed WAL + archive bundle fully unchanged
      assert.deepEqual(await readFile(rotationStateAbs(root)), walBefore);
      assert.deepEqual(
        await readFile(archiveJournalAbs(root, previousGenerationId)),
        archiveBefore.journal,
      );
      assert.deepEqual(
        await readFile(archiveEventsAbs(root, previousGenerationId)),
        archiveBefore.events,
      );
      assert.deepEqual(
        await readFile(archiveManifestAbs(root, previousGenerationId)),
        archiveBefore.manifest,
      );

      // Public inspect path for v2 domain (inspect surface: generationId/recordCount/headDigest)
      const inspected = await journalMod.inspectAuditIntegrityJournalFile(root);
      assert.equal(inspected.generationId, wal.nextGenerationId);
      assert.equal(inspected.recordCount, verifiedAfter.recordCount);
      assert.equal(inspected.headDigest, verifiedAfter.headDigest);
    });
  });

  it('G5 completed WAL generation mismatch blocks before mutation with ROTATION_CONFLICT', async () => {
    await withTempRoot('g5-gen-mismatch', async (root) => {
      const { wal } = await createRealCompletedRotation(root);
      const previousGenerationId = wal.previousGenerationId;
      const mismatchedNext = differentGenerationId(
        wal.previousGenerationId,
        wal.nextGenerationId,
      );
      assert.notEqual(mismatchedNext, wal.nextGenerationId);

      const stateMod = await loadRotationState();
      const rebuilt = rebuildCompletedWalWithNextGeneration(wal, mismatchedNext);
      const raw = JSON.stringify(rebuilt);
      // Parser must still accept the adversarial but schema-valid completed WAL.
      const reparsed = stateMod.parseAuditIntegrityRotationStateText(raw);
      assert.equal(reparsed.status, 'completed');
      assert.equal(reparsed.nextGenerationId, mismatchedNext);
      assert.equal(reparsed.previousGenerationId, wal.previousGenerationId);
      await writeFile(rotationStateAbs(root), raw, { mode: 0o600 });

      const before = await snapshotKnownAuditBytes(root, previousGenerationId);

      const dualMod = await loadDualWriteState();
      const idle = dualMod.parseAuditIntegrityDualWriteStateText(
        before.dual.toString('utf8'),
      );
      // Idle still bound to the real next generation — mismatch vs WAL next.
      assert.equal(idle.generationId, wal.nextGenerationId);
      assert.notEqual(idle.generationId, mismatchedNext);

      const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_B }),
        (error) => {
          assertRotationError(error, CODE_CONFLICT, root);
          // Must be rotation conflict, not generic journal chain/cursor errors.
          assert.notEqual(error.code, ERROR_CODES.AUDIT_CHAIN_BROKEN);
          assert.notEqual(
            error.code,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH,
          );
          assert.notEqual(
            error.code,
            ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID,
          );
          return true;
        },
      );

      const after = await snapshotKnownAuditBytes(root, previousGenerationId);
      assertSnapEqual(before, after, 'G5 mismatch');
    });
  });

  it('G6 monitor reports every nonterminal as rotation-recovery-required and is read-only', async () => {
    for (const c of NONTERMINAL_CASES) {
      await withTempRoot(`g6-${c.status}`, async (root) => {
        const { previousGenerationId } = await crashToNonterminal(root, {
          hook: c.hook,
          crashCode: c.crashCode,
          expectedWalStatus: c.status,
        });
        const before = await snapshotKnownAuditBytes(root, previousGenerationId);

        const report = await runMonitorOnce(root);
        assertDeeplyFrozen(report);
        assert.equal(report.schemaVersion, 1);
        assert.equal(report.status, 'alert');
        assert.equal(report.code, 'rotation-recovery-required');
        assert.equal(report.recoveryRequired, true);
        assert.equal(report.alertRequired, true);
        assert.equal(report.nextAction, 'run-explicit-recovery');
        assert.equal(report.relationship, null);
        assert.equal(report.reasonCode, CODE_RECOVERY_REQUIRED);
        assert.equal(report.checkedAt, FIXED_CHECKED_AT);
        assertPathFreeSurface(report, root);

        const after = await snapshotKnownAuditBytes(root, previousGenerationId);
        assertSnapEqual(before, after, `G6 ${c.cp} ${c.status}`);

        // WAL must remain nonterminal — no implicit rotate/recover/publish.
        const stateMod = await loadRotationState();
        const wal = stateMod.parseAuditIntegrityRotationStateText(
          after.rotation.toString('utf8'),
        );
        assert.equal(wal.status, c.status);
      });
    }
  });

  it('G7 completed latest-archive deep-check + retention removes rotation event from events', async () => {
    // Phase 1: archive deep-check only (independent root; no post-rotation append required).
    await withTempRoot('g7-archive-tamper', async (root) => {
      const { wal } = await createRealCompletedRotation(root);
      const previousGenerationId = wal.previousGenerationId;
      assert.equal(
        wal.archiveRelativePath,
        `audit/archive/${previousGenerationId}`,
      );

      const beforeTamper = await snapshotKnownAuditBytes(root, previousGenerationId);
      const foreign = Buffer.from(FOREIGN_MANIFEST, 'utf8');
      await writeFile(
        archiveManifestAbs(root, previousGenerationId),
        foreign,
        { mode: 0o600 },
      );
      const foreignAfterWrite = await readFile(
        archiveManifestAbs(root, previousGenerationId),
      );
      assert.deepEqual(foreignAfterWrite, foreign);

      const beforeMonitor = await snapshotKnownAuditBytes(root, previousGenerationId);
      const report = await runMonitorOnce(root);
      assertDeeplyFrozen(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'integrity-alert');
      assert.ok(
        report.reasonCode === CODE_CONFLICT
        || report.reasonCode === CODE_STATE_INVALID,
        `unexpected reasonCode ${report.reasonCode}`,
      );
      assertPathFreeSurface(report, root);

      const afterMonitor = await snapshotKnownAuditBytes(root, previousGenerationId);
      // Foreign bytes retained; live/dual/WAL + other archive leaves unchanged vs pre-monitor.
      assert.deepEqual(afterMonitor.archManifest, foreign);
      assert.deepEqual(afterMonitor.journal, beforeMonitor.journal);
      assert.deepEqual(afterMonitor.events, beforeMonitor.events);
      assert.deepEqual(afterMonitor.dual, beforeMonitor.dual);
      assert.deepEqual(afterMonitor.rotation, beforeMonitor.rotation);
      assert.deepEqual(afterMonitor.archJournal, beforeMonitor.archJournal);
      assert.deepEqual(afterMonitor.archEvents, beforeMonitor.archEvents);
      // Live + WAL + non-manifest archive still match pre-tamper baseline except manifest.
      assert.deepEqual(afterMonitor.journal, beforeTamper.journal);
      assert.deepEqual(afterMonitor.events, beforeTamper.events);
      assert.deepEqual(afterMonitor.dual, beforeTamper.dual);
      assert.deepEqual(afterMonitor.rotation, beforeTamper.rotation);
      assert.deepEqual(afterMonitor.archJournal, beforeTamper.archJournal);
      assert.deepEqual(afterMonitor.archEvents, beforeTamper.archEvents);
    });

    // Phase 2: completed + ordinary append with retention maxEvents:1 → healthy monitor.
    await withTempRoot('g7-retention-healthy', async (root) => {
      const { wal } = await createRealCompletedRotation(root);
      const previousGenerationId = wal.previousGenerationId;
      const rotationPayloadDigest = wal.rotationEvent.payloadDigest;

      const dualMod = await loadDualWriteState();
      const idleBefore = dualMod.parseAuditIntegrityDualWriteStateText(
        await readFile(dualStateAbs(root), 'utf8'),
      );
      assert.equal(idleBefore.status, 'idle');
      assert.equal(idleBefore.generationId, wal.nextGenerationId);

      const { appendAuditEventWithIntegrityDualWrite } = await loadDualWrite();
      // Return is sanitized event (id/createdAt may be invented).
      const written = await appendAuditEventWithIntegrityDualWrite(root, {
        type: EVENT_B.type,
        method: EVENT_B.method,
        path: EVENT_B.path,
        outcome: EVENT_B.outcome,
      }, {
        retention: { maxEvents: 1 },
      });
      assert.equal(typeof written, 'object');
      assert.ok(written !== null);
      assert.equal(typeof written.id, 'string');
      assert.ok(written.id.length > 0);
      assert.equal(typeof written.createdAt, 'string');
      assert.ok(written.createdAt.length > 0);
      assert.equal(written.type, EVENT_B.type);
      const expectedDigest = computeAuditIntegrityEventPayloadDigest(written);
      const expectedEventLine = `${stringifyStrictCanonicalSanitizedEvent(written)}\n`;

      const journalText = await readFile(journalAbs(root), 'utf8');
      const eventsText = await readFile(eventsAbs(root), 'utf8');

      // journal v2 still contains exactly-one rotation payloadDigest + latest business event
      assert.equal(
        countJournalRotationEvents(journalText, rotationPayloadDigest),
        1,
      );
      const journalMod = await loadJournal();
      const verified = journalMod.verifyAuditIntegrityJournalText(journalText);
      assert.equal(verified.schemaVersion, 2);
      assert.equal(verified.generationId, wal.nextGenerationId);
      assert.equal(verified.recordCount, 3);

      // events retains only the latest business event (rotation line pruned by retention)
      assert.equal(countEventsLines(eventsText), 1);
      assert.equal(eventsText, expectedEventLine);
      const onlyEvent = JSON.parse(eventsText.trimEnd());
      assert.equal(onlyEvent.id, written.id);
      assert.equal(onlyEvent.createdAt, written.createdAt);
      assert.equal(onlyEvent.type, written.type);
      assert.equal(onlyEvent.method, written.method);
      assert.equal(onlyEvent.path, written.path);
      assert.equal(onlyEvent.outcome, written.outcome);
      assert.notEqual(onlyEvent.id, wal.rotationId);
      assert.notEqual(onlyEvent.type, 'audit-integrity-rotation');

      const idle = dualMod.parseAuditIntegrityDualWriteStateText(
        await readFile(dualStateAbs(root), 'utf8'),
      );
      assert.equal(idle.status, 'idle');
      assert.equal(idle.generationId, wal.nextGenerationId);
      // lastTransactionId is prepared.transactionId (random UUID), not event.id.
      assert.equal(typeof idle.lastTransactionId, 'string');
      assert.ok(idle.lastTransactionId.length > 0);
      assert.notEqual(idle.lastTransactionId, idleBefore.lastTransactionId);
      assert.notEqual(idle.lastTransactionId, written.id);
      assert.equal(idle.lastPayloadDigest, expectedDigest);
      assert.equal(idle.events.strictRecordCount, 1);

      const cross = await loadCrossStore();
      const rel = await cross.verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(rel.relationship, 'events-suffix-of-journal');

      const before = await snapshotKnownAuditBytes(root, previousGenerationId);
      const report = await runMonitorOnce(root);
      assertDeeplyFrozen(report);
      assert.equal(report.status, 'healthy');
      assert.equal(report.code, 'healthy');
      assert.equal(report.relationship, 'events-suffix-of-journal');
      assert.equal(report.recoveryRequired, false);
      assert.equal(report.alertRequired, false);
      assert.equal(report.nextAction, 'none');
      assert.equal(report.reasonCode, null);
      assertPathFreeSurface(report, root);

      const after = await snapshotKnownAuditBytes(root, previousGenerationId);
      assertSnapEqual(before, after, 'G7 retention monitor');
    });
  });
});
