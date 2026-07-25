/**
 * Linke V1.43 Task 3 RED — P1-P5 rotation coordinator contracts.
 * Dynamic namespace import only; effective RED from absent exports/behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import {
  stringifyStrictCanonicalSanitizedEvent,
} from '../src/audit-event-schema.js';

const ROTATION_MODULE_SPEC = '../src/audit-integrity-rotation.js';
const DUAL_WRITE_MODULE_SPEC = '../src/audit-integrity-dual-write.js';
const DUAL_WRITE_STATE_MODULE_SPEC = '../src/audit-integrity-dual-write-state.js';
const ROTATION_STATE_MODULE_SPEC = '../src/audit-integrity-rotation-state.js';
const JOURNAL_MODULE_SPEC = '../src/audit-integrity-journal.js';
const CROSS_STORE_MODULE_SPEC = '../src/audit-integrity-cross-store.js';

const CODE_PRECONDITION = 'audit-integrity-rotation-precondition-failed';
const CODE_RECOVERY_REQUIRED = 'audit-integrity-rotation-recovery-required';
const CODE_BOUNDS = 'audit-integrity-rotation-bounds-exceeded';
const CODE_DUAL_STATE_INVALID = 'audit-integrity-dual-write-state-invalid';

const CRASH_AFTER_MANIFEST = 'TEST_CRASH_AFTER_MANIFEST';

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

const EVENTS_MAX_BYTES = 16_777_216;
const EVENTS_MAX_LINES = 8192;
const EVENTS_MAX_LINE_BYTES = 16050;

const EVENT_A = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-19T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
  outcome: 'success',
});

const CRASH_AFTER_PREPARED = 'TEST_CRASH_AFTER_PREPARED';

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
  if (rootHint) {
    assert.ok(!error.message.includes(rootHint));
    assert.ok(!String(error.stack || '').split('\n')[0].includes(rootHint));
  }
  return true;
}

function assertDualWriteError(error, code, rootHint) {
  assert.equal(error.name, 'AuditIntegrityDualWriteError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.message, error.code);
  if (rootHint) {
    assert.ok(!error.message.includes(rootHint));
  }
  assert.ok(!error.message.includes('ENOENT'));
  assert.ok(!error.message.includes('/tmp/'));
  assert.ok(!error.message.includes('Users/'));
  return true;
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
  const root = await mkdtemp(join(tmpdir(), `linke-rot-p-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withLease(root, fn) {
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { enqueueAuditIntegrityWriteTask } = await import(
    '../src/audit-integrity-write-queue.js'
  );
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => (
    fn(resolvedRoot, lease)
  ));
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
  if (rootHint) {
    assert.ok(!text.includes(rootHint));
  }
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

/**
 * Derive post journal/events expectations from parsed WAL + production builders.
 * @param {object} wal
 * @param {Buffer|null} sealedEventsBytes pre sealed events (null when absent)
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
  assert.equal(v2.recordCount, wal.journal.next.recordCount);
  assert.equal(v2.recordCount, 2);

  const sealed = sealedEventsBytes == null ? Buffer.alloc(0) : sealedEventsBytes;
  const postEvents = Buffer.concat([
    sealed,
    Buffer.from(wal.rotationEvent.eventLineUtf8, 'utf8'),
  ]);
  assert.equal(postEvents.length, wal.events.post.rawByteLength);
  assert.equal(sha256Hex(postEvents), wal.events.post.rawSha256);
  assert.equal(wal.events.post.present, true);
  assert.equal(
    wal.events.post.strictRecordCount,
    wal.events.sealed.strictRecordCount + 1,
  );

  return {
    journalText: v2.rawText,
    journalBytes: Buffer.from(v2.rawText, 'utf8'),
    eventsBytes: postEvents,
    headDigest: v2.headDigest,
  };
}

/**
 * Assert Task 4 completed facts + exact receipt surface.
 * @param {string} root
 * @param {object} opts
 */
async function assertTask4CompletedFacts(root, opts) {
  const {
    receipt,
    expectedState,
    preJournal,
    preEvents,
    archiveBefore = null,
    rootHint = root,
  } = opts;

  assert.deepEqual(Object.keys(receipt), [...RECEIPT_KEYS]);
  assertDeeplyFrozen(receipt);
  assert.equal(receipt.state, expectedState);
  assert.equal(receipt.newRecordCount, 2);
  assert.equal(receipt.relationship, 'journal-suffix-of-events');
  assertPathFreeSurface(receipt, rootHint);
  assert.equal(typeof receipt.rotationId, 'string');
  assert.equal(typeof receipt.previousGenerationId, 'string');
  assert.equal(typeof receipt.generationId, 'string');
  assert.equal(typeof receipt.archiveRelativePath, 'string');
  assert.equal(typeof receipt.archiveManifestDigest, 'string');
  assert.equal(typeof receipt.previousRecordCount, 'number');
  assert.ok(!receipt.archiveRelativePath.startsWith('/'));
  assert.ok(!receipt.archiveRelativePath.includes(rootHint));

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
  const manifest = stateMod.parseAuditIntegrityArchiveManifestText(
    archManifest.toString('utf8'),
  );
  assert.equal(manifest.previousGenerationId, gen);
  assert.equal(manifest.journal.rawByteLength, preJournal.length);
  assert.equal(manifest.journal.rawSha256, sha256Hex(preJournal));
  assert.equal(manifest.events.present, true);
  assert.equal(manifest.events.rawByteLength, preEvents.length);
  assert.equal(manifest.events.rawSha256, sha256Hex(preEvents));
  assert.equal(sha256Hex(archManifest), wal.archiveManifestDigest);
  assert.equal(sha256Hex(archManifest), receipt.archiveManifestDigest);

  if (archiveBefore) {
    assert.deepEqual(archJournal, archiveBefore.journal);
    assert.deepEqual(archEvents, archiveBefore.events);
    assert.deepEqual(archManifest, archiveBefore.manifest);
  }

  const post = await derivePostFromWal(wal, preEvents);
  const liveJournal = await assertRegular0600(journalAbs(root), post.journalBytes);
  const liveEvents = await assertRegular0600(eventsAbs(root), post.eventsBytes);
  const liveDual = await assertRegular0600(dualStateAbs(root));

  const journalMod = await loadJournal();
  const verified = journalMod.verifyAuditIntegrityJournalText(
    liveJournal.toString('utf8'),
  );
  assert.equal(verified.schemaVersion, 2);
  assert.equal(verified.recordCount, 2);
  assert.equal(verified.generationId, wal.nextGenerationId);
  assert.equal(verified.headDigest, wal.journal.next.headDigest);
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

  const dualMod = await loadDualWriteState();
  const idle = dualMod.parseAuditIntegrityDualWriteStateText(
    liveDual.toString('utf8'),
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

  const cross = await loadCrossStore();
  const rel = await cross.verifyAuditIntegrityAgainstEventStore(root);
  assert.equal(rel.relationship, 'journal-suffix-of-events');

  return { wal, idle, liveJournal, liveEvents, archJournal, archEvents, archManifest };
}

async function snapshotStoresSafe(root) {
  let archivePresent = false;
  try {
    await access(archiveRootAbs(root));
    archivePresent = true;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  return {
    journal: await readOptionalBytes(journalAbs(root)),
    events: await readOptionalBytes(eventsAbs(root)),
    dual: await readOptionalBytes(dualStateAbs(root)),
    rotation: await readOptionalBytes(rotationStateAbs(root)),
    archivePresent,
  };
}

function assertSnapEqual(a, b) {
  assert.deepEqual(a.journal, b.journal);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.dual, b.dual);
  assert.deepEqual(a.rotation, b.rotation);
  assert.equal(a.archivePresent, b.archivePresent);
}

async function createHealthyIdle(root, { withEvent = true } = {}) {
  const {
    recoverAuditIntegrityDualWrite,
    appendAuditEventWithIntegrityDualWrite,
  } = await loadDualWrite();
  const idle = await recoverAuditIntegrityDualWrite(root);
  if (withEvent) {
    await appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A });
  }
  const stateMod = await loadDualWriteState();
  const parsed = stateMod.parseAuditIntegrityDualWriteStateText(
    await readFile(dualStateAbs(root), 'utf8'),
  );
  return {
    idle: parsed,
    expectedGenerationId: parsed.generationId,
    expectedHeadDigest: parsed.journal.headDigest,
  };
}

function uuidFromIndex(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

/**
 * Independent test formula: build a strict-canonical event line body of exact
 * UTF-8 byte length using only public stringify (no production private helpers).
 * Fills string fields to the 200-char sanitize/strict ceiling, then shrinks by
 * single characters so every intermediate size remains reachable.
 */
function buildExactBodyLine(id, bodyBytes) {
  const padFields = [
    'message',
    'path',
    'method',
    'outcome',
    'requestId',
    'deviceId',
    'snapshotId',
    'operation',
    'targetName',
    'attemptId',
    'errorCode',
  ];
  /** @type {Record<string, string>} */
  const event = {
    id,
    createdAt: '2026-07-24T00:00:00.000Z',
    type: 'pad',
  };
  for (const field of padFields) {
    event[field] = 'x'.repeat(200);
  }

  let line = stringifyStrictCanonicalSanitizedEvent(event);
  let n = Buffer.byteLength(line, 'utf8');
  assert.ok(
    n >= bodyBytes,
    `max padded line ${n} < target body ${bodyBytes}`,
  );

  // Shrink one ASCII byte at a time; fields stay present so sizes are continuous.
  for (const field of padFields) {
    while (n > bodyBytes && event[field].length > 1) {
      event[field] = event[field].slice(0, -1);
      line = stringifyStrictCanonicalSanitizedEvent(event);
      n = Buffer.byteLength(line, 'utf8');
    }
    if (n === bodyBytes) return line;
  }

  assert.equal(
    n,
    bodyBytes,
    `unable to build exact body line of ${bodyBytes} bytes (got ${n})`,
  );
  return line;
}

function buildUniformPrefixRaw(lineCount, bodyBytes) {
  const baseId = uuidFromIndex(0);
  const baseBody = buildExactBodyLine(baseId, bodyBytes);
  assert.equal(Buffer.byteLength(baseBody, 'utf8'), bodyBytes);
  const parts = [];
  for (let i = 0; i < lineCount; i += 1) {
    const id = uuidFromIndex(i + 1);
    const body = baseBody.replace(baseId, id);
    assert.equal(Buffer.byteLength(body, 'utf8'), bodyBytes);
    parts.push(body);
  }
  return parts.length === 0 ? '' : `${parts.join('\n')}\n`;
}

/**
 * Independent proof of the fixed rotation event schema line size (public fields only).
 * Production generates its own id/createdAt; size class is schema-bound.
 */
function independentFixedRotationEventLine() {
  const event = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    createdAt: '2026-07-24T12:00:00.000Z',
    type: 'audit-integrity-rotation',
    outcome: 'committed',
    operation: 'generation-transition',
    message: 'audit integrity generation rotation committed',
  };
  const body = stringifyStrictCanonicalSanitizedEvent(event);
  const bodyLen = Buffer.byteLength(body, 'utf8');
  assert.ok(bodyLen <= EVENTS_MAX_LINE_BYTES);
  assert.ok(bodyLen > 0);
  return `${body}\n`;
}

async function republishIdleEventsFingerprint(root, eventsText, strictRecordCount) {
  const stateMod = await loadDualWriteState();
  const idle = stateMod.parseAuditIntegrityDualWriteStateText(
    await readFile(dualStateAbs(root), 'utf8'),
  );
  const eventsBytes = Buffer.from(eventsText, 'utf8');
  await writeFile(eventsAbs(root), eventsBytes, { mode: 0o600 });
  const nextIdle = {
    schemaVersion: 1,
    status: 'idle',
    generationId: idle.generationId,
    journal: {
      recordCount: idle.journal.recordCount,
      headDigest: idle.journal.headDigest,
      rawByteLength: idle.journal.rawByteLength,
      rawSha256: idle.journal.rawSha256,
    },
    events: {
      present: true,
      byteLength: eventsBytes.length,
      sha256: sha256Hex(eventsBytes),
      strictRecordCount,
    },
    lastTransactionId: idle.lastTransactionId,
    lastPayloadDigest: idle.lastPayloadDigest,
    lastSequence: idle.lastSequence,
  };
  await withLease(root, async (resolvedRoot, lease) => {
    await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, nextIdle);
  });
  return {
    expectedGenerationId: nextIdle.generationId,
    expectedHeadDigest: nextIdle.journal.headDigest,
    eventsBytes,
    journalBytes: await readFile(journalAbs(root)),
    dualBytes: await readFile(dualStateAbs(root)),
  };
}

/**
 * Build healthy idle with sealed strict event count exactly 8192.
 * Journal remains a legal open+tail suffix of events (journal-suffix-of-events).
 */
async function buildSealedEventCount8192(root) {
  const { expectedGenerationId, expectedHeadDigest } = await createHealthyIdle(root, {
    withEvent: true,
  });
  const tailRaw = await readFile(eventsAbs(root), 'utf8');
  const prefixCount = EVENTS_MAX_LINES - 1;
  // Short deterministic lines (~80B) keep total bytes far below 16 MiB.
  const prefixParts = [];
  for (let i = 0; i < prefixCount; i += 1) {
    const body = stringifyStrictCanonicalSanitizedEvent({
      id: uuidFromIndex(i + 1),
      createdAt: '2026-07-24T00:00:00.000Z',
      type: 'pad',
    });
    prefixParts.push(body);
  }
  const eventsText = `${prefixParts.join('\n')}\n${tailRaw}`;
  const strictCount = eventsText.trimEnd().split('\n').length;
  assert.equal(strictCount, EVENTS_MAX_LINES);
  assert.ok(Buffer.byteLength(eventsText, 'utf8') < EVENTS_MAX_BYTES);
  const fx = await republishIdleEventsFingerprint(root, eventsText, strictCount);
  return {
    ...fx,
    expectedGenerationId,
    expectedHeadDigest: fx.expectedHeadDigest,
  };
}

/**
 * Build healthy idle with sealed events raw exactly 16 MiB.
 * 8192 lines × 2048 bytes (incl. newline) = 16_777_216.
 * Body 2047 stays within the 200-char string-field fixture budget.
 * Journal remains a legal suffix of the sealed events image.
 */
async function buildSealedEventsExact16MiB(root) {
  const LINE_TOTAL = 2048; // includes trailing '\n'
  const BODY = LINE_TOTAL - 1;
  const LINE_COUNT = EVENTS_MAX_LINES;
  assert.equal(LINE_COUNT * LINE_TOTAL, EVENTS_MAX_BYTES);

  // Design tail event to exact BODY so dual-write append yields known line size.
  const tailId = '11111111-1111-4111-8111-111111111111';
  const tailBody = buildExactBodyLine(tailId, BODY);
  assert.equal(Buffer.byteLength(tailBody, 'utf8'), BODY);
  const tailEvent = JSON.parse(tailBody);

  const {
    recoverAuditIntegrityDualWrite,
    appendAuditEventWithIntegrityDualWrite,
  } = await loadDualWrite();
  await recoverAuditIntegrityDualWrite(root);
  await appendAuditEventWithIntegrityDualWrite(root, tailEvent);

  const tailRaw = await readFile(eventsAbs(root), 'utf8');
  assert.equal(Buffer.byteLength(tailRaw, 'utf8'), LINE_TOTAL);
  assert.equal(tailRaw, `${tailBody}\n`);

  const prefixRaw = buildUniformPrefixRaw(LINE_COUNT - 1, BODY);
  assert.equal(Buffer.byteLength(prefixRaw, 'utf8'), (LINE_COUNT - 1) * LINE_TOTAL);
  const eventsText = `${prefixRaw}${tailRaw}`;
  assert.equal(Buffer.byteLength(eventsText, 'utf8'), EVENTS_MAX_BYTES);
  assert.equal(eventsText.trimEnd().split('\n').length, LINE_COUNT);

  const fx = await republishIdleEventsFingerprint(root, eventsText, LINE_COUNT);
  return fx;
}

describe('audit integrity rotation coordinator (Task 3 RED P1-P5)', () => {
  it('P1 hostile options snapshot before I/O; only crash Symbol accepted; mutation cannot alter expected', async () => {
    const rot = await loadRotation();
    assert.equal(typeof rot.rotateAuditIntegrityGeneration, 'function');
    assert.equal(typeof rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK, 'symbol');

    const missingRoot = join(
      tmpdir(),
      `linke-rot-p1-missing-${process.pid}-${Date.now().toString(16)}`,
    );
    await assert.rejects(() => access(missingRoot), { code: 'ENOENT' });

    const expectedGenerationId = '0123456789abcdef0123456789abcdef';
    const expectedHeadDigest = 'a'.repeat(64);

    // Proxy: traps must not execute; path-free precondition; root stays missing.
    let proxyGets = 0;
    const proxy = new Proxy(
      { expectedGenerationId, expectedHeadDigest },
      {
        get(target, prop, receiver) {
          proxyGets += 1;
          throw new Error('SECRET /tmp/proxy-rotation-trap');
        },
        ownKeys() {
          proxyGets += 1;
          return Reflect.ownKeys({ expectedGenerationId, expectedHeadDigest });
        },
        getOwnPropertyDescriptor(target, prop) {
          proxyGets += 1;
          return Reflect.getOwnPropertyDescriptor(
            { expectedGenerationId, expectedHeadDigest },
            prop,
          );
        },
      },
    );
    await assert.rejects(
      () => rot.rotateAuditIntegrityGeneration(missingRoot, proxy),
      (e) => assertRotationError(e, CODE_PRECONDITION, missingRoot),
    );
    assert.equal(proxyGets, 0, 'proxy traps must not execute');
    await assert.rejects(() => access(missingRoot), { code: 'ENOENT' });

    // Revoked Proxy: must stay typed path-free PRECONDITION_FAILED (isProxy before
    // Array.isArray / any reflection). Never inspect the revoked proxy after revoke.
    {
      const validOpts = { expectedGenerationId, expectedHeadDigest };
      const { proxy: revokedProxy, revoke } = Proxy.revocable(validOpts, {});
      revoke();
      await assert.rejects(
        () => rot.rotateAuditIntegrityGeneration(missingRoot, revokedProxy),
        (e) => assertRotationError(e, CODE_PRECONDITION, missingRoot),
      );
      await assert.rejects(() => access(missingRoot), { code: 'ENOENT' });
    }

    // Accessor getters must not execute.
    let accessorGets = 0;
    const withAccessor = {};
    Object.defineProperty(withAccessor, 'expectedGenerationId', {
      enumerable: true,
      configurable: true,
      get() {
        accessorGets += 1;
        return expectedGenerationId;
      },
    });
    Object.defineProperty(withAccessor, 'expectedHeadDigest', {
      enumerable: true,
      configurable: true,
      get() {
        accessorGets += 1;
        return expectedHeadDigest;
      },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(withAccessor)), {
      expectedGenerationId,
      expectedHeadDigest,
    });
    accessorGets = 0;
    await assert.rejects(
      () => rot.rotateAuditIntegrityGeneration(missingRoot, withAccessor),
      (e) => assertRotationError(e, CODE_PRECONDITION, missingRoot),
    );
    assert.equal(accessorGets, 0, 'accessor getters must not run');
    await assert.rejects(() => access(missingRoot), { code: 'ENOENT' });

    // Extra string key.
    await assert.rejects(
      () => rot.rotateAuditIntegrityGeneration(missingRoot, {
        expectedGenerationId,
        expectedHeadDigest,
        extra: true,
      }),
      (e) => assertRotationError(e, CODE_PRECONDITION, missingRoot),
    );
    await assert.rejects(() => access(missingRoot), { code: 'ENOENT' });

    // Unknown symbol key (not the exported crash Symbol).
    const unknownSym = Symbol('hostile-rotation-option');
    await assert.rejects(
      () => rot.rotateAuditIntegrityGeneration(missingRoot, {
        expectedGenerationId,
        expectedHeadDigest,
        [unknownSym]: 'after-prepared',
      }),
      (e) => assertRotationError(e, CODE_PRECONDITION, missingRoot),
    );
    await assert.rejects(() => access(missingRoot), { code: 'ENOENT' });

    // Inputs snapshotted before first await: mutation after call cannot alter expected.
    await withTempRoot('p1-snap', async (root) => {
      const fx = await createHealthyIdle(root, { withEvent: true });
      const options = {
        expectedGenerationId: fx.expectedGenerationId,
        expectedHeadDigest: fx.expectedHeadDigest,
        [rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: 'after-prepared',
      };
      const pending = rot.rotateAuditIntegrityGeneration(root, options);
      options.expectedGenerationId = 'ffffffffffffffffffffffffffffffff';
      options.expectedHeadDigest = 'f'.repeat(64);
      options[rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK] = 'after-manifest';
      await assert.rejects(
        () => pending,
        (e) => isTestCrash(e, CRASH_AFTER_PREPARED),
      );
      // Crash after prepared proves snapshotted matching expected values were used
      // (wrong mutated values would fail precondition before prepared).
      const wal = await readFile(rotationStateAbs(root), 'utf8');
      const stateMod = await loadRotationState();
      const parsed = stateMod.parseAuditIntegrityRotationStateText(wal);
      assert.equal(parsed.status, 'prepared');
      assert.equal(parsed.previousGenerationId, fx.expectedGenerationId);
      assert.equal(parsed.previousHeadDigest, fx.expectedHeadDigest);
    });
  });

  it('P2 rotation WAL gate wins: prepared rotation blocks ordinary rotate without auto-recover', async () => {
    await withTempRoot('p2-wal-gate', async (root) => {
      const fx = await createHealthyIdle(root, { withEvent: true });
      const rot = await loadRotation();

      await assert.rejects(
        () => rot.rotateAuditIntegrityGeneration(root, {
          expectedGenerationId: fx.expectedGenerationId,
          expectedHeadDigest: fx.expectedHeadDigest,
          [rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: 'after-prepared',
        }),
        (e) => isTestCrash(e, CRASH_AFTER_PREPARED),
      );

      const afterPrepared = await snapshotStoresSafe(root);
      assert.ok(afterPrepared.rotation);
      assert.equal(afterPrepared.archivePresent, false);
      const stateMod = await loadRotationState();
      assert.equal(
        stateMod.parseAuditIntegrityRotationStateText(
          afterPrepared.rotation.toString('utf8'),
        ).status,
        'prepared',
      );

      await assert.rejects(
        () => rot.rotateAuditIntegrityGeneration(root, {
          expectedGenerationId: fx.expectedGenerationId,
          expectedHeadDigest: fx.expectedHeadDigest,
        }),
        (e) => assertRotationError(e, CODE_RECOVERY_REQUIRED, root),
      );

      const afterSecond = await snapshotStoresSafe(root);
      assertSnapEqual(afterSecond, afterPrepared);
      assert.equal(afterSecond.archivePresent, false);
    });
  });

  it('P3 dual-write state must already be exact idle (missing and prepared)', async () => {
    // Direct export gate: effective RED independently requires the new dual-write
    // idle validator, not only the absent rotation coordinator surface.
    const dualMod = await loadDualWrite();
    assert.equal(
      typeof dualMod.validateAuditIntegrityDualWriteIdleUnlocked,
      'function',
    );

    const cases = [
      {
        name: 'missing-dual-write-state',
        async setup(root) {
          // Root exists; no audit journal/state/events bootstrap.
          return {
            expectedGenerationId: '0123456789abcdef0123456789abcdef',
            expectedHeadDigest: 'b'.repeat(64),
          };
        },
        async assertUnchanged(root, before) {
          assertSnapEqual(await snapshotStoresSafe(root), before);
          await assert.rejects(() => access(journalAbs(root)), { code: 'ENOENT' });
          await assert.rejects(() => access(dualStateAbs(root)), { code: 'ENOENT' });
          await assert.rejects(() => access(eventsAbs(root)), { code: 'ENOENT' });
        },
      },
      {
        name: 'prepared-dual-write-state',
        async setup(root) {
          const {
            appendAuditEventWithIntegrityDualWrite,
            DUAL_WRITE_TEST_CRASH_HOOK,
          } = await loadDualWrite();
          // First establish open journal+idle via crash+... actually after-prepared on empty
          // root bootstraps then leaves prepared.
          await assert.rejects(
            () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
              [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
            }),
            (e) => isTestCrash(e, 'TEST_CRASH_AFTER_PREPARED'),
          );
          const stateMod = await loadDualWriteState();
          const prepared = stateMod.parseAuditIntegrityDualWriteStateText(
            await readFile(dualStateAbs(root), 'utf8'),
          );
          assert.equal(prepared.status, 'prepared');
          return {
            expectedGenerationId: prepared.generationId,
            expectedHeadDigest: prepared.journal.pre.headDigest,
          };
        },
        async assertUnchanged(root, before) {
          assertSnapEqual(await snapshotStoresSafe(root), before);
          const stateMod = await loadDualWriteState();
          const prepared = stateMod.parseAuditIntegrityDualWriteStateText(
            (await readFile(dualStateAbs(root))).toString('utf8'),
          );
          assert.equal(prepared.status, 'prepared');
        },
      },
    ];

    for (const c of cases) {
      await withTempRoot(`p3-${c.name}`, async (root) => {
        const expected = await c.setup(root);
        const before = await snapshotStoresSafe(root);
        const rot = await loadRotation();

        await assert.rejects(
          () => rot.rotateAuditIntegrityGeneration(root, {
            expectedGenerationId: expected.expectedGenerationId,
            expectedHeadDigest: expected.expectedHeadDigest,
          }),
          (e) => assertDualWriteError(e, CODE_DUAL_STATE_INVALID, root),
        );

        await c.assertUnchanged(root, before);
        assert.equal((await snapshotStoresSafe(root)).rotation, null);
        assert.equal((await snapshotStoresSafe(root)).archivePresent, false);
      });
    }
  });

  it('P4 expected generation/head mismatch rejects without WAL/archive/live mutation', async () => {
    const cases = [
      {
        name: 'wrong-generation',
        mutate(fx) {
          return {
            expectedGenerationId: 'ffffffffffffffffffffffffffffffff',
            expectedHeadDigest: fx.expectedHeadDigest,
          };
        },
      },
      {
        name: 'wrong-head',
        mutate(fx) {
          return {
            expectedGenerationId: fx.expectedGenerationId,
            expectedHeadDigest: 'f'.repeat(64),
          };
        },
      },
    ];

    for (const c of cases) {
      await withTempRoot(`p4-${c.name}`, async (root) => {
        const fx = await createHealthyIdle(root, { withEvent: true });
        // Matching values derived from actual idle/journal, not hard-coded authority.
        assert.match(fx.expectedGenerationId, /^[0-9a-f]{32}$/);
        assert.match(fx.expectedHeadDigest, /^[0-9a-f]{64}$/);
        const opts = c.mutate(fx);
        assert.notDeepEqual(opts, {
          expectedGenerationId: fx.expectedGenerationId,
          expectedHeadDigest: fx.expectedHeadDigest,
        });

        const before = await snapshotStoresSafe(root);
        const rot = await loadRotation();
        await assert.rejects(
          () => rot.rotateAuditIntegrityGeneration(root, opts),
          (e) => assertRotationError(e, CODE_PRECONDITION, root),
        );
        assertSnapEqual(await snapshotStoresSafe(root), before);
        assert.equal(before.rotation, null);
        assert.equal(before.archivePresent, false);
      });
    }
  });

  it('P5 bounds before prepared: sealed 8192 count and exact 16 MiB reject without WAL/archive', async () => {
    // Independent verification: fixed rotation event line is within per-line limit.
    const rotationLine = independentFixedRotationEventLine();
    assert.ok(
      Buffer.byteLength(rotationLine.replace(/\n$/, ''), 'utf8') <= EVENTS_MAX_LINE_BYTES,
    );

    const cases = [
      {
        name: 'sealed-count-8192',
        build: buildSealedEventCount8192,
      },
      {
        name: 'sealed-raw-16mib',
        build: buildSealedEventsExact16MiB,
      },
    ];

    for (const c of cases) {
      await withTempRoot(`p5-${c.name}`, async (root) => {
        const fx = await c.build(root);

        // Existing-production health proof: fixture must already be a legal idle
        // cursor/cross-store image. recover must succeed and write nothing.
        const healthBefore = await snapshotStoresSafe(root);
        assert.ok(healthBefore.journal);
        assert.ok(healthBefore.events);
        assert.ok(healthBefore.dual);
        assert.equal(healthBefore.rotation, null);
        assert.equal(healthBefore.archivePresent, false);

        if (c.name === 'sealed-count-8192') {
          const text = healthBefore.events.toString('utf8');
          assert.equal(text.trimEnd().split('\n').length, EVENTS_MAX_LINES);
        } else {
          assert.equal(healthBefore.events.length, EVENTS_MAX_BYTES);
        }

        const { recoverAuditIntegrityDualWrite } = await loadDualWrite();
        const idle = await recoverAuditIntegrityDualWrite(root);
        assert.equal(idle.status, 'idle');
        assert.equal(idle.generationId, fx.expectedGenerationId);
        assert.equal(idle.journal.headDigest, fx.expectedHeadDigest);
        assertSnapEqual(await snapshotStoresSafe(root), healthBefore);

        const before = await snapshotStoresSafe(root);
        const rot = await loadRotation();
        await assert.rejects(
          () => rot.rotateAuditIntegrityGeneration(root, {
            expectedGenerationId: fx.expectedGenerationId,
            expectedHeadDigest: fx.expectedHeadDigest,
          }),
          (e) => assertRotationError(e, CODE_BOUNDS, root),
        );

        const after = await snapshotStoresSafe(root);
        assertSnapEqual(after, before);
        assert.equal(after.rotation, null);
        assert.equal(after.archivePresent, false);
      });
    }
  });

  it('P6 manifest authority beats stale prepared WAL; recovery rolls forward to completed rotated receipt', async () => {
    await withTempRoot('p6-manifest-auth', async (root) => {
      const fx = await createHealthyIdle(root, { withEvent: true });
      const preJournal = await readFile(journalAbs(root));
      const preEvents = await readFile(eventsAbs(root));
      const preDual = await readFile(dualStateAbs(root));
      const rot = await loadRotation();

      await assert.rejects(
        () => rot.rotateAuditIntegrityGeneration(root, {
          expectedGenerationId: fx.expectedGenerationId,
          expectedHeadDigest: fx.expectedHeadDigest,
          [rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: 'after-manifest',
        }),
        (e) => isTestCrash(e, CRASH_AFTER_MANIFEST),
      );

      const stateMod = await loadRotationState();
      const walAfterCrash = stateMod.parseAuditIntegrityRotationStateText(
        await readFile(rotationStateAbs(root), 'utf8'),
      );
      assert.equal(walAfterCrash.status, 'prepared');
      assert.equal(walAfterCrash.previousGenerationId, fx.expectedGenerationId);
      assert.equal(walAfterCrash.previousHeadDigest, fx.expectedHeadDigest);

      // Full verified archive bundle exists while WAL is still prepared.
      const archJournal = await assertRegular0600(
        archiveJournalAbs(root, fx.expectedGenerationId),
        preJournal,
      );
      const archEvents = await assertRegular0600(
        archiveEventsAbs(root, fx.expectedGenerationId),
        preEvents,
      );
      const archManifest = await assertRegular0600(
        archiveManifestAbs(root, fx.expectedGenerationId),
      );
      assert.equal(archManifest.includes(0x0a), false);
      assert.equal(
        sha256Hex(archManifest),
        walAfterCrash.archiveManifestDigest,
      );
      stateMod.parseAuditIntegrityArchiveManifestText(
        archManifest.toString('utf8'),
      );

      // Live journal/events/dual remain exact pre bytes (pre-cutover).
      assert.deepEqual(await readFile(journalAbs(root)), preJournal);
      assert.deepEqual(await readFile(eventsAbs(root)), preEvents);
      assert.deepEqual(await readFile(dualStateAbs(root)), preDual);

      const archiveBefore = {
        journal: archJournal,
        events: archEvents,
        manifest: archManifest,
      };

      const receipt = await rot.recoverAuditIntegrityRotation(root);
      assert.equal(receipt.state, 'rotated');
      assert.notEqual(receipt.state, 'archive-committed');
      assert.notEqual(receipt.state, 'already-completed');

      await assertTask4CompletedFacts(root, {
        receipt,
        expectedState: 'rotated',
        preJournal,
        preEvents,
        archiveBefore,
        rootHint: root,
      });

      // Archive never rebuilt from new live content / never overwritten.
      assert.deepEqual(
        await readFile(archiveJournalAbs(root, fx.expectedGenerationId)),
        preJournal,
      );
      assert.deepEqual(
        await readFile(archiveEventsAbs(root, fx.expectedGenerationId)),
        preEvents,
      );
      assert.deepEqual(
        await readFile(archiveManifestAbs(root, fx.expectedGenerationId)),
        archManifest,
      );
    });
  });

  it('P7 ordered successful cutover and exact frozen rotated receipt (not interim archive-committed)', async () => {
    await withTempRoot('p7-success', async (root) => {
      const fx = await createHealthyIdle(root, { withEvent: true });
      const preJournal = await readFile(journalAbs(root));
      const preEvents = await readFile(eventsAbs(root));
      const rot = await loadRotation();

      const receipt = await rot.rotateAuditIntegrityGeneration(root, {
        expectedGenerationId: fx.expectedGenerationId,
        expectedHeadDigest: fx.expectedHeadDigest,
      });

      assert.equal(receipt.state, 'rotated');
      assert.notEqual(receipt.state, 'archive-committed');
      assert.notEqual(receipt.state, 'already-completed');

      const facts = await assertTask4CompletedFacts(root, {
        receipt,
        expectedState: 'rotated',
        preJournal,
        preEvents,
        rootHint: root,
      });

      assert.equal(facts.wal.previousGenerationId, fx.expectedGenerationId);
      assert.equal(facts.wal.previousHeadDigest, fx.expectedHeadDigest);
      assert.equal(
        facts.wal.journal.previous.recordCount,
        receipt.previousRecordCount,
      );
      assert.equal(receipt.newRecordCount, 2);
      assert.equal(receipt.relationship, 'journal-suffix-of-events');

      // Three live leaves + WAL are regular mode 0600 (asserted in helper).
      await assertRegular0600(journalAbs(root));
      await assertRegular0600(eventsAbs(root));
      await assertRegular0600(dualStateAbs(root));
      await assertRegular0600(rotationStateAbs(root));
    });
  });
});
