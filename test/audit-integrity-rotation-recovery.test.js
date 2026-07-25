/**
 * Linke V1.43 Task 4 RED — R1-R9 recovery / cutover contracts.
 * Dynamic namespace import only; effective RED from absent cutover/hooks/completed recovery.
 * Exactly nine top-level `it` cases (R1-R9). No skip/todo/only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROTATION_MODULE_SPEC = '../src/audit-integrity-rotation.js';
const DUAL_WRITE_MODULE_SPEC = '../src/audit-integrity-dual-write.js';
const DUAL_WRITE_STATE_MODULE_SPEC = '../src/audit-integrity-dual-write-state.js';
const ROTATION_STATE_MODULE_SPEC = '../src/audit-integrity-rotation-state.js';
const JOURNAL_MODULE_SPEC = '../src/audit-integrity-journal.js';
const CROSS_STORE_MODULE_SPEC = '../src/audit-integrity-cross-store.js';

const CODE_CONFLICT = 'audit-integrity-rotation-conflict';

/** Plan completed-not-proof canary (exact foreign live-journal text). */
const PLAN_CANARY_FOREIGN = 'foreign\n';

const RECEIPT_KEYS = Object.freeze([
  'state',
  'rotationId',
  'previousGenerationId',
  'generationId',
  'archiveRelativePath',
  'archiveManifestDigest',
  'previousRecordCount',
  'newRecordCount',
  'relationship',
]);

const CRASH_AFTER_PREPARED = 'TEST_CRASH_AFTER_PREPARED';
const CRASH_AFTER_ARCHIVE_JOURNAL = 'TEST_CRASH_AFTER_ARCHIVE_JOURNAL';
const CRASH_AFTER_ARCHIVE_EVENTS = 'TEST_CRASH_AFTER_ARCHIVE_EVENTS';
const CRASH_AFTER_MANIFEST = 'TEST_CRASH_AFTER_MANIFEST';
const CRASH_AFTER_NEW_JOURNAL = 'TEST_CRASH_AFTER_NEW_JOURNAL';
const CRASH_AFTER_EVENTS_POST = 'TEST_CRASH_AFTER_EVENTS_POST';
const CRASH_AFTER_NEW_IDLE = 'TEST_CRASH_AFTER_NEW_IDLE';

const EVENT_A = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-19T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
  outcome: 'success',
});

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

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
  assert.ok(!error.message.includes(PLAN_CANARY_FOREIGN.trim()));
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
  assert.ok(!text.includes(PLAN_CANARY_FOREIGN.trim()));
  if (rootHint) {
    assert.ok(!text.includes(rootHint));
  }
}

async function loadRotation() {
  return import(ROTATION_MODULE_SPEC);
}

async function loadDualWrite() {
  return import(DUAL_WRITE_MODULE_SPEC);
}

async function loadDualWriteState() {
  return import(DUAL_WRITE_STATE_MODULE_SPEC);
}

async function loadRotationState() {
  return import(ROTATION_STATE_MODULE_SPEC);
}

async function loadJournal() {
  return import(JOURNAL_MODULE_SPEC);
}

async function loadCrossStore() {
  return import(CROSS_STORE_MODULE_SPEC);
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-rot-r-${prefix}-`));
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

function byteFp(buf) {
  if (buf == null) {
    return { present: false, length: 0, sha256: null };
  }
  return {
    present: true,
    length: buf.length,
    sha256: sha256Hex(buf),
  };
}

/**
 * Classify actual store bytes against exact pre/post fingerprints.
 * @returns {'pre'|'post'|'other'}
 */
function classifyBytes(actual, pre, post) {
  const a = byteFp(actual);
  const p = byteFp(pre);
  const q = byteFp(post);
  if (
    a.present === p.present
    && a.length === p.length
    && a.sha256 === p.sha256
  ) {
    return 'pre';
  }
  if (
    a.present === q.present
    && a.length === q.length
    && a.sha256 === q.sha256
  ) {
    return 'post';
  }
  return 'other';
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

function countEventsRotationLines(eventsText, rotationId) {
  const lines = eventsText.trimEnd().split('\n').filter((line) => line.length > 0);
  let count = 0;
  for (const line of lines) {
    const event = JSON.parse(line);
    if (
      event.id === rotationId
      || event.type === 'audit-integrity-rotation'
    ) {
      count += 1;
    }
  }
  return count;
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
 * Derive post journal/events from parsed WAL + shared production builders.
 * @param {object} wal
 * @param {Buffer} sealedEventsBytes
 */
async function derivePostFromWal(wal, sealedEventsBytes) {
  const journalMod = await loadJournal();
  const v2 = journalMod.buildAuditIntegrityV2GenerationImage({
    generationId: wal.nextGenerationId,
    previousGenerationId: wal.previousGenerationId,
    previousHeadDigest: wal.previousHeadDigest,
    archiveManifestDigest: wal.archiveManifestDigest,
    rotationEvent: {
      id: wal.rotationEvent.event.id,
      createdAt: wal.rotationEvent.event.createdAt,
      type: wal.rotationEvent.event.type,
      outcome: wal.rotationEvent.event.outcome,
      operation: wal.rotationEvent.event.operation,
      message: wal.rotationEvent.event.message,
    },
  });
  assert.equal(v2.rawByteLength, wal.journal.next.rawByteLength);
  assert.equal(v2.rawSha256, wal.journal.next.rawSha256);
  assert.equal(v2.headDigest, wal.journal.next.headDigest);
  assert.equal(v2.recordCount, 2);

  const postEvents = Buffer.concat([
    sealedEventsBytes,
    Buffer.from(wal.rotationEvent.eventLineUtf8, 'utf8'),
  ]);
  assert.equal(postEvents.length, wal.events.post.rawByteLength);
  assert.equal(sha256Hex(postEvents), wal.events.post.rawSha256);
  assert.equal(wal.events.post.present, true);

  return {
    journalBytes: Buffer.from(v2.rawText, 'utf8'),
    eventsBytes: postEvents,
    headDigest: v2.headDigest,
  };
}

/**
 * Expected post dual-idle field checks (not a fabricated publish).
 * Classification uses journal/events post fingerprints from WAL.
 */
async function assertPostIdleMatchesWal(root, wal, liveJournal, liveEvents) {
  const dualMod = await loadDualWriteState();
  const idle = dualMod.parseAuditIntegrityDualWriteStateText(
    await readFile(dualStateAbs(root), 'utf8'),
  );
  assert.equal(idle.status, 'idle');
  assert.equal(idle.generationId, wal.nextGenerationId);
  assert.equal(idle.journal.recordCount, 2);
  assert.equal(idle.journal.headDigest, wal.journal.next.headDigest);
  assert.equal(idle.journal.rawByteLength, liveJournal.length);
  assert.equal(idle.journal.rawSha256, sha256Hex(liveJournal));
  assert.equal(idle.events.present, true);
  assert.equal(idle.events.byteLength, liveEvents.length);
  assert.equal(idle.events.sha256, sha256Hex(liveEvents));
  assert.equal(idle.events.strictRecordCount, wal.events.post.strictRecordCount);
  assert.equal(idle.lastTransactionId, wal.rotationId);
  assert.equal(idle.lastPayloadDigest, wal.rotationEvent.payloadDigest);
  assert.equal(idle.lastSequence, 1);
  return idle;
}

async function assertCompletedFacts(root, {
  receipt,
  expectedState,
  preJournal,
  preEvents,
  archiveBefore = null,
  rootHint = root,
}) {
  assert.deepEqual(Object.keys(receipt), [...RECEIPT_KEYS]);
  assertDeeplyFrozen(receipt);
  assert.equal(receipt.state, expectedState);
  assert.equal(receipt.newRecordCount, 2);
  assert.equal(receipt.relationship, 'journal-suffix-of-events');
  assertPathFreeSurface(receipt, rootHint);

  const stateMod = await loadRotationState();
  const walRaw = await assertRegular0600(rotationStateAbs(root));
  const wal = stateMod.parseAuditIntegrityRotationStateText(walRaw.toString('utf8'));
  assert.equal(wal.status, 'completed');
  assert.equal(receipt.rotationId, wal.rotationId);
  assert.equal(receipt.previousGenerationId, wal.previousGenerationId);
  assert.equal(receipt.generationId, wal.nextGenerationId);
  assert.equal(receipt.archiveRelativePath, wal.archiveRelativePath);
  assert.equal(receipt.archiveManifestDigest, wal.archiveManifestDigest);
  assert.equal(receipt.previousRecordCount, wal.journal.previous.recordCount);
  assert.notEqual(wal.status, 'archive-committed');

  const gen = wal.previousGenerationId;
  const archJournal = await assertRegular0600(archiveJournalAbs(root, gen), preJournal);
  const archEvents = await assertRegular0600(archiveEventsAbs(root, gen), preEvents);
  const archManifest = await assertRegular0600(archiveManifestAbs(root, gen));
  assert.equal(archManifest.includes(0x0a), false);
  assert.equal(sha256Hex(archManifest), wal.archiveManifestDigest);

  if (archiveBefore) {
    if (archiveBefore.journal) {
      assert.deepEqual(archJournal, archiveBefore.journal);
    }
    if (archiveBefore.events) {
      assert.deepEqual(archEvents, archiveBefore.events);
    }
    if (archiveBefore.manifest) {
      assert.deepEqual(archManifest, archiveBefore.manifest);
    }
  }

  const post = await derivePostFromWal(wal, preEvents);
  const liveJournal = await assertRegular0600(journalAbs(root), post.journalBytes);
  const liveEvents = await assertRegular0600(eventsAbs(root), post.eventsBytes);
  await assertRegular0600(dualStateAbs(root));

  const journalMod = await loadJournal();
  const verified = journalMod.verifyAuditIntegrityJournalText(
    liveJournal.toString('utf8'),
  );
  assert.equal(verified.schemaVersion, 2);
  assert.equal(verified.recordCount, 2);
  assert.equal(verified.generationId, wal.nextGenerationId);
  assert.equal(
    verified.generationBinding.archiveManifestDigest,
    wal.archiveManifestDigest,
  );

  assert.equal(
    countJournalRotationEvents(
      liveJournal.toString('utf8'),
      wal.rotationEvent.payloadDigest,
    ),
    1,
  );
  assert.equal(
    countEventsRotationLines(liveEvents.toString('utf8'), wal.rotationId),
    1,
  );

  await assertPostIdleMatchesWal(root, wal, liveJournal, liveEvents);

  const cross = await loadCrossStore();
  const rel = await cross.verifyAuditIntegrityAgainstEventStore(root);
  assert.equal(rel.relationship, 'journal-suffix-of-events');

  return { wal, liveJournal, liveEvents, archJournal, archEvents, archManifest };
}

async function snapshotArchiveBundle(root, generationId) {
  return {
    journal: await readOptionalBytes(archiveJournalAbs(root, generationId)),
    events: await readOptionalBytes(archiveEventsAbs(root, generationId)),
    manifest: await readOptionalBytes(archiveManifestAbs(root, generationId)),
  };
}

/**
 * Drive rotate to a crash CP, assert CP table facts, then recover to completed.
 */
async function runCrashRecoverCase(root, {
  hook,
  crashCode,
  expectedWalStatus,
  expectArchive,
  liveJournalClass,
  liveEventsClass,
  dualClass,
}) {
  const fx = await createHealthyOneEventRoot(root);
  const preJournal = fx.journalBytes;
  const preEvents = fx.eventsBytes;
  const preDual = fx.dualBytes;
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
  // Hook value must never leak into WAL.
  const walText = JSON.stringify(wal);
  assert.ok(!walText.includes(hook));
  assert.ok(!walText.includes(crashCode));
  assert.ok(!walText.includes('TEST_CRASH'));

  const post = await derivePostFromWal(wal, preEvents);

  // Archive facts
  if (expectArchive === 'none') {
    await assert.rejects(
      () => access(archiveJournalAbs(root, fx.expectedGenerationId)),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      () => access(archiveEventsAbs(root, fx.expectedGenerationId)),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      () => access(archiveManifestAbs(root, fx.expectedGenerationId)),
      { code: 'ENOENT' },
    );
  } else if (expectArchive === 'journal') {
    await assertRegular0600(
      archiveJournalAbs(root, fx.expectedGenerationId),
      preJournal,
    );
    await assert.rejects(
      () => access(archiveEventsAbs(root, fx.expectedGenerationId)),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      () => access(archiveManifestAbs(root, fx.expectedGenerationId)),
      { code: 'ENOENT' },
    );
  } else if (expectArchive === 'journal+events') {
    await assertRegular0600(
      archiveJournalAbs(root, fx.expectedGenerationId),
      preJournal,
    );
    await assertRegular0600(
      archiveEventsAbs(root, fx.expectedGenerationId),
      preEvents,
    );
    await assert.rejects(
      () => access(archiveManifestAbs(root, fx.expectedGenerationId)),
      { code: 'ENOENT' },
    );
  } else if (expectArchive === 'full') {
    await assertRegular0600(
      archiveJournalAbs(root, fx.expectedGenerationId),
      preJournal,
    );
    await assertRegular0600(
      archiveEventsAbs(root, fx.expectedGenerationId),
      preEvents,
    );
    const man = await assertRegular0600(
      archiveManifestAbs(root, fx.expectedGenerationId),
    );
    assert.equal(man.includes(0x0a), false);
    assert.equal(sha256Hex(man), wal.archiveManifestDigest);
    stateMod.parseAuditIntegrityArchiveManifestText(man.toString('utf8'));
  } else {
    assert.fail(`unknown expectArchive ${expectArchive}`);
  }

  const liveJournalBytes = await readFile(journalAbs(root));
  const liveEventsBytes = await readOptionalBytes(eventsAbs(root));
  const liveDualBytes = await readFile(dualStateAbs(root));

  assert.equal(
    classifyBytes(liveJournalBytes, preJournal, post.journalBytes),
    liveJournalClass,
    `live journal class for ${hook}`,
  );
  assert.equal(
    classifyBytes(liveEventsBytes, preEvents, post.eventsBytes),
    liveEventsClass,
    `live events class for ${hook}`,
  );

  // Dual: pre = original idle bytes; post = new idle matching WAL next gen fingerprints.
  // Classify dual by generation/fields when post, or exact pre bytes.
  if (dualClass === 'pre') {
    assert.deepEqual(liveDualBytes, preDual);
  } else if (dualClass === 'post') {
    await assertPostIdleMatchesWal(root, wal, liveJournalBytes, liveEventsBytes);
  } else {
    assert.fail(`unexpected dualClass ${dualClass}`);
  }

  // CP0-CP2 special: old live journal/events/idle byte-identical before recovery.
  if (
    liveJournalClass === 'pre'
    && liveEventsClass === 'pre'
    && dualClass === 'pre'
  ) {
    assert.deepEqual(liveJournalBytes, preJournal);
    assert.deepEqual(liveEventsBytes, preEvents);
    assert.deepEqual(liveDualBytes, preDual);
  }

  const archiveBefore = await snapshotArchiveBundle(root, fx.expectedGenerationId);

  const receipt = await rot.recoverAuditIntegrityRotation(root);
  assert.equal(receipt.state, 'rotated');
  assertPathFreeSurface(receipt, root);

  const facts = await assertCompletedFacts(root, {
    receipt,
    expectedState: 'rotated',
    preJournal,
    preEvents,
    archiveBefore: {
      journal: archiveBefore.journal,
      events: archiveBefore.events,
      manifest: archiveBefore.manifest,
    },
    rootHint: root,
  });

  // Live convergence: exactly one rotation occurrence (no duplicate from recovery).
  assert.equal(
    countJournalRotationEvents(
      facts.liveJournal.toString('utf8'),
      facts.wal.rotationEvent.payloadDigest,
    ),
    1,
  );
  assert.equal(
    countEventsRotationLines(
      facts.liveEvents.toString('utf8'),
      facts.wal.rotationId,
    ),
    1,
  );

  return { fx, preJournal, preEvents, wal, receipt, facts };
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
  const facts = await assertCompletedFacts(root, {
    receipt,
    expectedState: 'rotated',
    preJournal,
    preEvents,
    rootHint: root,
  });
  return { fx, preJournal, preEvents, receipt, facts, rot };
}

async function snapshotAllRotationBytes(root, previousGenerationId) {
  return {
    journal: await readFile(journalAbs(root)),
    events: await readFile(eventsAbs(root)),
    dual: await readFile(dualStateAbs(root)),
    rotation: await readFile(rotationStateAbs(root)),
    archJournal: await readFile(archiveJournalAbs(root, previousGenerationId)),
    archEvents: await readFile(archiveEventsAbs(root, previousGenerationId)),
    archManifest: await readFile(archiveManifestAbs(root, previousGenerationId)),
  };
}

function assertSnapAllEqual(a, b) {
  assert.deepEqual(a.journal, b.journal);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.dual, b.dual);
  assert.deepEqual(a.rotation, b.rotation);
  assert.deepEqual(a.archJournal, b.archJournal);
  assert.deepEqual(a.archEvents, b.archEvents);
  assert.deepEqual(a.archManifest, b.archManifest);
}

describe('audit integrity rotation recovery (Task 4 RED R1-R9)', () => {
  it('R1 CP0 after-prepared: WAL prepared, no archive, live pre; recover → rotated completed', async () => {
    await withTempRoot('r1-cp0', async (root) => {
      await runCrashRecoverCase(root, {
        hook: 'after-prepared',
        crashCode: CRASH_AFTER_PREPARED,
        expectedWalStatus: 'prepared',
        expectArchive: 'none',
        liveJournalClass: 'pre',
        liveEventsClass: 'pre',
        dualClass: 'pre',
      });
    });
  });

  it('R2 CP1 after-archive-journal: WAL prepared, archive journal only, live pre; recover → rotated', async () => {
    await withTempRoot('r2-cp1', async (root) => {
      await runCrashRecoverCase(root, {
        hook: 'after-archive-journal',
        crashCode: CRASH_AFTER_ARCHIVE_JOURNAL,
        expectedWalStatus: 'prepared',
        expectArchive: 'journal',
        liveJournalClass: 'pre',
        liveEventsClass: 'pre',
        dualClass: 'pre',
      });
    });
  });

  it('R3 CP2 after-archive-events: WAL prepared, journal+events archive, live pre; recover → rotated', async () => {
    await withTempRoot('r3-cp2', async (root) => {
      await runCrashRecoverCase(root, {
        hook: 'after-archive-events',
        crashCode: CRASH_AFTER_ARCHIVE_EVENTS,
        expectedWalStatus: 'prepared',
        expectArchive: 'journal+events',
        liveJournalClass: 'pre',
        liveEventsClass: 'pre',
        dualClass: 'pre',
      });
    });
  });

  it('R4 CP3 after-manifest: WAL prepared, full archive authority, live pre; recover → rotated', async () => {
    await withTempRoot('r4-cp3', async (root) => {
      await runCrashRecoverCase(root, {
        hook: 'after-manifest',
        crashCode: CRASH_AFTER_MANIFEST,
        expectedWalStatus: 'prepared',
        expectArchive: 'full',
        liveJournalClass: 'pre',
        liveEventsClass: 'pre',
        dualClass: 'pre',
      });
    });
  });

  it('R5 CP4 after-new-journal: WAL archive-committed, journal post / events+dual pre; recover skips post journal', async () => {
    await withTempRoot('r5-cp4', async (root) => {
      await runCrashRecoverCase(root, {
        hook: 'after-new-journal',
        crashCode: CRASH_AFTER_NEW_JOURNAL,
        expectedWalStatus: 'archive-committed',
        expectArchive: 'full',
        liveJournalClass: 'post',
        liveEventsClass: 'pre',
        dualClass: 'pre',
      });
    });
  });

  it('R6 CP5 after-events-post: WAL journal-published, journal+events post / dual pre; recover skips post stores', async () => {
    await withTempRoot('r6-cp5', async (root) => {
      await runCrashRecoverCase(root, {
        hook: 'after-events-post',
        crashCode: CRASH_AFTER_EVENTS_POST,
        expectedWalStatus: 'journal-published',
        expectArchive: 'full',
        liveJournalClass: 'post',
        liveEventsClass: 'post',
        dualClass: 'pre',
      });
    });
  });

  it('R7 CP6 after-new-idle: WAL events-published, all live post; recover publishes completed only', async () => {
    await withTempRoot('r7-cp6', async (root) => {
      await runCrashRecoverCase(root, {
        hook: 'after-new-idle',
        crashCode: CRASH_AFTER_NEW_IDLE,
        expectedWalStatus: 'events-published',
        expectArchive: 'full',
        liveJournalClass: 'post',
        liveEventsClass: 'post',
        dualClass: 'post',
      });
    });
  });

  it('R8 completed status is never self-proving: each fact corruption → path-free CONFLICT; WAL stays completed', async () => {
    const cases = [
      {
        name: 'live-journal',
        async corrupt(root, ctx) {
          await writeFile(journalAbs(root), PLAN_CANARY_FOREIGN, { mode: 0o600 });
          return {
            path: journalAbs(root),
            foreign: Buffer.from(PLAN_CANARY_FOREIGN, 'utf8'),
          };
        },
      },
      {
        name: 'live-events',
        async corrupt(root) {
          const foreign = Buffer.from('{"id":"foreign-events-line"}\n', 'utf8');
          await writeFile(eventsAbs(root), foreign, { mode: 0o600 });
          return { path: eventsAbs(root), foreign };
        },
      },
      {
        name: 'dual-idle',
        async corrupt(root) {
          const foreign = Buffer.from(
            `${JSON.stringify({ status: 'idle', foreign: true })}\n`,
            'utf8',
          );
          await writeFile(dualStateAbs(root), foreign, { mode: 0o600 });
          return { path: dualStateAbs(root), foreign };
        },
      },
      {
        name: 'archived-journal',
        async corrupt(root, ctx) {
          const foreign = Buffer.from('FOREIGN_ARCHIVED_JOURNAL\n', 'utf8');
          await writeFile(
            archiveJournalAbs(root, ctx.previousGenerationId),
            foreign,
            { mode: 0o600 },
          );
          return {
            path: archiveJournalAbs(root, ctx.previousGenerationId),
            foreign,
          };
        },
      },
      {
        name: 'archived-events',
        async corrupt(root, ctx) {
          const foreign = Buffer.from('FOREIGN_ARCHIVED_EVENTS\n', 'utf8');
          await writeFile(
            archiveEventsAbs(root, ctx.previousGenerationId),
            foreign,
            { mode: 0o600 },
          );
          return {
            path: archiveEventsAbs(root, ctx.previousGenerationId),
            foreign,
          };
        },
      },
      {
        name: 'archived-manifest',
        async corrupt(root, ctx) {
          const foreign = Buffer.from('{"foreign":"manifest"}', 'utf8');
          await writeFile(
            archiveManifestAbs(root, ctx.previousGenerationId),
            foreign,
            { mode: 0o600 },
          );
          return {
            path: archiveManifestAbs(root, ctx.previousGenerationId),
            foreign,
          };
        },
      },
    ];

    for (const c of cases) {
      await withTempRoot(`r8-${c.name}`, async (root) => {
        const created = await createRealCompletedRotation(root);
        const previousGenerationId = created.facts.wal.previousGenerationId;
        const walBefore = await readFile(rotationStateAbs(root));
        const snapBefore = await snapshotAllRotationBytes(root, previousGenerationId);

        const { path: corruptedPath, foreign } = await c.corrupt(root, {
          previousGenerationId,
        });
        const foreignAfterWrite = await readFile(corruptedPath);
        assert.deepEqual(foreignAfterWrite, foreign);

        const stateMod = await loadRotationState();
        assert.equal(
          stateMod.parseAuditIntegrityRotationStateText(
            walBefore.toString('utf8'),
          ).status,
          'completed',
        );

        await assert.rejects(
          () => created.rot.recoverAuditIntegrityRotation(root),
          (e) => {
            assertRotationError(e, CODE_CONFLICT, root);
            if (c.name === 'live-journal') {
              assert.ok(!e.message.includes(PLAN_CANARY_FOREIGN));
              assert.ok(!e.message.includes('foreign'));
              assert.ok(!String(e.stack || '').includes(PLAN_CANARY_FOREIGN));
            }
            return true;
          },
        );

        // WAL remains exact completed bytes; foreign leaf untouched; no repair.
        assert.deepEqual(await readFile(rotationStateAbs(root)), walBefore);
        assert.equal(
          stateMod.parseAuditIntegrityRotationStateText(
            (await readFile(rotationStateAbs(root))).toString('utf8'),
          ).status,
          'completed',
        );
        assert.deepEqual(await readFile(corruptedPath), foreign);

        // Uncorrupted siblings stay byte-identical (no rebaseline / new archive).
        const snapAfter = await snapshotAllRotationBytes(root, previousGenerationId);
        assert.deepEqual(snapAfter.rotation, snapBefore.rotation);
        if (c.name !== 'live-journal') {
          assert.deepEqual(snapAfter.journal, snapBefore.journal);
        } else {
          assert.deepEqual(snapAfter.journal, foreign);
        }
        if (c.name !== 'live-events') {
          assert.deepEqual(snapAfter.events, snapBefore.events);
        } else {
          assert.deepEqual(snapAfter.events, foreign);
        }
        if (c.name !== 'dual-idle') {
          assert.deepEqual(snapAfter.dual, snapBefore.dual);
        } else {
          assert.deepEqual(snapAfter.dual, foreign);
        }
        if (c.name !== 'archived-journal') {
          assert.deepEqual(snapAfter.archJournal, snapBefore.archJournal);
        } else {
          assert.deepEqual(snapAfter.archJournal, foreign);
        }
        if (c.name !== 'archived-events') {
          assert.deepEqual(snapAfter.archEvents, snapBefore.archEvents);
        } else {
          assert.deepEqual(snapAfter.archEvents, foreign);
        }
        if (c.name !== 'archived-manifest') {
          assert.deepEqual(snapAfter.archManifest, snapBefore.archManifest);
        } else {
          assert.deepEqual(snapAfter.archManifest, foreign);
        }
      });
    }
  });

  it('R9 completed recovery is idempotent and recomputed: already-completed twice; bytes immutable', async () => {
    await withTempRoot('r9-idempotent', async (root) => {
      const created = await createRealCompletedRotation(root);
      const previousGenerationId = created.facts.wal.previousGenerationId;
      const snap0 = await snapshotAllRotationBytes(root, previousGenerationId);
      const rot = created.rot;

      const r1 = await rot.recoverAuditIntegrityRotation(root);
      assert.equal(r1.state, 'already-completed');
      assert.deepEqual(Object.keys(r1), [...RECEIPT_KEYS]);
      assertDeeplyFrozen(r1);
      assertPathFreeSurface(r1, root);
      assert.equal(r1.rotationId, created.receipt.rotationId);
      assert.equal(r1.previousGenerationId, created.receipt.previousGenerationId);
      assert.equal(r1.generationId, created.receipt.generationId);
      assert.equal(r1.archiveRelativePath, created.receipt.archiveRelativePath);
      assert.equal(r1.archiveManifestDigest, created.receipt.archiveManifestDigest);
      assert.equal(r1.previousRecordCount, created.receipt.previousRecordCount);
      assert.equal(r1.newRecordCount, 2);
      assert.equal(r1.relationship, 'journal-suffix-of-events');

      const snap1 = await snapshotAllRotationBytes(root, previousGenerationId);
      assertSnapAllEqual(snap1, snap0);

      // Mutating a returned receipt must not affect the next receipt.
      const poison = { ...r1, state: 'mutated-by-test' };
      assert.equal(poison.state, 'mutated-by-test');
      try {
        /** @type {{ state?: string }} */ (r1).state = 'mutated-in-place';
      } catch {
        // deep-freeze may throw; either way next recover is independent.
      }

      const r2 = await rot.recoverAuditIntegrityRotation(root);
      assert.equal(r2.state, 'already-completed');
      assert.deepEqual(r2, r1);
      assertDeeplyFrozen(r2);
      assert.notEqual(r2.state, 'mutated-by-test');
      assert.notEqual(r2.state, 'mutated-in-place');

      const snap2 = await snapshotAllRotationBytes(root, previousGenerationId);
      assertSnapAllEqual(snap2, snap0);

      const stateMod = await loadRotationState();
      const wal = stateMod.parseAuditIntegrityRotationStateText(
        snap2.rotation.toString('utf8'),
      );
      assert.equal(wal.status, 'completed');
      assert.equal(
        countJournalRotationEvents(
          snap2.journal.toString('utf8'),
          wal.rotationEvent.payloadDigest,
        ),
        1,
      );
      assert.equal(
        countEventsRotationLines(snap2.events.toString('utf8'), wal.rotationId),
        1,
      );

      // Recomputed from actual files: receipt still binds live archive digest.
      assert.equal(r2.archiveManifestDigest, sha256Hex(snap2.archManifest));
      assert.equal(r2.archiveManifestDigest, wal.archiveManifestDigest);
    });
  });
});
