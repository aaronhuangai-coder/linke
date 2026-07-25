/**
 * Linke V1.43 Task 2/3 RED — A1-A7 archive manifest contracts.
 * Dynamic namespace import only; effective RED from absent exports/behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watch, readFileSync, writeFileSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_MODULE_SPEC = '../src/audit-integrity-rotation-state.js';
const ROTATION_MODULE_SPEC = '../src/audit-integrity-rotation.js';
const DUAL_WRITE_MODULE_SPEC = '../src/audit-integrity-dual-write.js';

const CODE_STATE_INVALID = 'audit-integrity-rotation-state-invalid';
const CODE_BOUNDS = 'audit-integrity-rotation-bounds-exceeded';
const CODE_CONFLICT = 'audit-integrity-rotation-conflict';

const PREV_GEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEXT_GEN = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ROTATION_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-07-24T12:00:00.000Z';
const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);
const HEX64_C = 'c'.repeat(64);
const HEX64_D = 'd'.repeat(64);
const HEX64_E = 'e'.repeat(64);

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

const MANIFEST_KEYS = Object.freeze([
  'schemaVersion',
  'recordKind',
  'rotationId',
  'createdAt',
  'previousGenerationId',
  'previousJournalSchemaVersion',
  'previousHeadDigest',
  'journal',
  'events',
  'nextGenerationId',
  'rotationEventId',
  'rotationEventPayloadDigest',
]);

const EVENT_A = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-19T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
  outcome: 'success',
});

const CRASH_AFTER_ARCHIVE_JOURNAL = 'TEST_CRASH_AFTER_ARCHIVE_JOURNAL';
const CRASH_AFTER_ARCHIVE_EVENTS = 'TEST_CRASH_AFTER_ARCHIVE_EVENTS';
const CRASH_AFTER_MANIFEST = 'TEST_CRASH_AFTER_MANIFEST';

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function buildManifestFields(overrides = {}) {
  return {
    schemaVersion: 1,
    recordKind: 'audit-integrity-rotation-manifest',
    rotationId: ROTATION_ID,
    createdAt: CREATED_AT,
    previousGenerationId: PREV_GEN,
    previousJournalSchemaVersion: 1,
    previousHeadDigest: HEX64_A,
    journal: {
      rawByteLength: 120,
      rawSha256: HEX64_B,
      recordCount: 3,
    },
    events: {
      present: true,
      rawByteLength: 200,
      rawSha256: HEX64_C,
      strictRecordCount: 4,
    },
    nextGenerationId: NEXT_GEN,
    rotationEventId: ROTATION_ID,
    rotationEventPayloadDigest: HEX64_D,
    ...overrides,
  };
}

function reorderKeys(obj, order) {
  const out = {};
  for (const k of order) out[k] = obj[k];
  return out;
}

function assertRotationError(error, code) {
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
  return true;
}

function assertPathFreeRotationError(error, code, rootHint) {
  assertRotationError(error, code);
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

function isTestCrash(error, code) {
  return Boolean(error && (error.code === code || error.message === code));
}

async function loadStateMod() {
  return import(STATE_MODULE_SPEC);
}

async function loadRotationMod() {
  return import(ROTATION_MODULE_SPEC);
}

async function loadDualWrite() {
  return import(DUAL_WRITE_MODULE_SPEC);
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-rot-a-${prefix}-`));
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

async function snapshotLive(root) {
  return {
    journal: await readOptionalBytes(journalAbs(root)),
    events: await readOptionalBytes(eventsAbs(root)),
    dual: await readOptionalBytes(dualStateAbs(root)),
    rotation: await readOptionalBytes(rotationStateAbs(root)),
  };
}

function assertLiveEqual(a, b) {
  assert.deepEqual(a.journal, b.journal);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.dual, b.dual);
}

async function describePath(path) {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      const target = await readlink(path);
      let targetBytes = null;
      try {
        targetBytes = await readFile(target);
      } catch {
        targetBytes = null;
      }
      return {
        kind: 'symlink',
        mode: st.mode & 0o777,
        target,
        targetBytes,
      };
    }
    if (st.isDirectory()) {
      return { kind: 'directory', mode: st.mode & 0o777 };
    }
    if (st.isFile()) {
      return {
        kind: 'file',
        mode: st.mode & 0o777,
        bytes: await readFile(path),
      };
    }
    return { kind: 'other', mode: st.mode & 0o777 };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'absent' };
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
    assert.deepEqual(bytes, Buffer.isBuffer(expectedBytes)
      ? expectedBytes
      : Buffer.from(expectedBytes));
  }
  return bytes;
}

async function createHealthyPresentEventsRoot(root) {
  const {
    recoverAuditIntegrityDualWrite,
    appendAuditEventWithIntegrityDualWrite,
  } = await loadDualWrite();
  await recoverAuditIntegrityDualWrite(root);
  await appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A });
  const idleRaw = await readFile(dualStateAbs(root), 'utf8');
  const stateMod = await import('../src/audit-integrity-dual-write-state.js');
  const idle = stateMod.parseAuditIntegrityDualWriteStateText(idleRaw);
  const journalBytes = await readFile(journalAbs(root));
  const eventsBytes = await readFile(eventsAbs(root));
  return {
    idle,
    generationId: idle.generationId,
    expectedGenerationId: idle.generationId,
    expectedHeadDigest: idle.journal.headDigest,
    journalBytes,
    eventsBytes,
    dualBytes: await readFile(dualStateAbs(root)),
  };
}

async function createHealthyAbsentEventsRoot(root) {
  const { recoverAuditIntegrityDualWrite } = await loadDualWrite();
  const idle = await recoverAuditIntegrityDualWrite(root);
  assert.equal(idle.events.present, false);
  await assert.rejects(() => access(eventsAbs(root)), { code: 'ENOENT' });
  return {
    idle,
    generationId: idle.generationId,
    expectedGenerationId: idle.generationId,
    expectedHeadDigest: idle.journal.headDigest,
    journalBytes: await readFile(journalAbs(root)),
    dualBytes: await readFile(dualStateAbs(root)),
  };
}

async function precreateArchiveLeaf(root, generationId, leafName, content) {
  const dir = archiveDirAbs(root, generationId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const abs = join(dir, leafName);
  await writeFile(abs, content, { mode: 0o600 });
  return abs;
}

describe('audit integrity rotation archive manifest (Task 2/3 RED A1-A7)', () => {
  it('A1 canonical manifest builder/parser, exact raw/digest, no newline, <=16 KiB, exact keys and deep freeze', async () => {
    const mod = await loadStateMod();
    assert.equal(mod.AUDIT_INTEGRITY_ARCHIVE_MANIFEST_MAX_BYTES, 16384);
    assert.equal(typeof mod.buildAuditIntegrityArchiveManifest, 'function');
    assert.equal(typeof mod.parseAuditIntegrityArchiveManifestText, 'function');

    const fields = buildManifestFields();
    const built = mod.buildAuditIntegrityArchiveManifest(fields);
    assert.deepEqual(Object.keys(built), ['manifest', 'rawText', 'digest']);
    assertDeeplyFrozen(built);
    assertDeeplyFrozen(built.manifest);

    const expectedRaw = JSON.stringify(fields);
    assert.equal(expectedRaw.includes('\n'), false);
    assert.equal(built.rawText, expectedRaw);
    assert.equal(built.rawText.endsWith('\n'), false);
    assert.ok(Buffer.byteLength(built.rawText, 'utf8') <= 16384);
    assert.equal(built.digest, sha256Hex(built.rawText));
    assert.equal(built.digest, sha256Hex(expectedRaw));
    assert.deepEqual(Object.keys(built.manifest), [...MANIFEST_KEYS]);
    assert.deepEqual(Object.keys(built.manifest.journal), [
      'rawByteLength',
      'rawSha256',
      'recordCount',
    ]);
    assert.deepEqual(Object.keys(built.manifest.events), [
      'present',
      'rawByteLength',
      'rawSha256',
      'strictRecordCount',
    ]);
    assert.equal(Object.prototype.hasOwnProperty.call(built.manifest, 'digest'), false);
    assert.equal('digest' in built.manifest, false);

    const parsed = mod.parseAuditIntegrityArchiveManifestText(built.rawText);
    assert.deepEqual(parsed, built.manifest);
    assert.equal(JSON.stringify(parsed), built.rawText);
    assertDeeplyFrozen(parsed);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.recordKind, 'audit-integrity-rotation-manifest');
    assert.equal(parsed.rotationId, parsed.rotationEventId);
    assert.notEqual(parsed.previousGenerationId, parsed.nextGenerationId);
  });

  it('A2 manifest hostile/schema/cross-field/canonical raw/16384-byte rejection, including path-free typed errors', async () => {
    const mod = await loadStateMod();
    const fields = buildManifestFields();
    const raw = JSON.stringify(fields);

    // Wrong top-level key order.
    const wrongOrder = reorderKeys(fields, [
      'recordKind',
      'schemaVersion',
      'rotationId',
      'createdAt',
      'previousGenerationId',
      'previousJournalSchemaVersion',
      'previousHeadDigest',
      'journal',
      'events',
      'nextGenerationId',
      'rotationEventId',
      'rotationEventPayloadDigest',
    ]);
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(JSON.stringify(wrongOrder)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    // Extra key / missing key.
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(JSON.stringify({ ...fields, extra: true })),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
    const missing = { ...fields };
    delete missing.rotationEventPayloadDigest;
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(JSON.stringify(missing)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    // Schema / kind.
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(
        JSON.stringify(buildManifestFields({ schemaVersion: 2 })),
      ),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(
        JSON.stringify(buildManifestFields({ recordKind: 'other' })),
      ),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    // Cross-field: rotationId ≠ rotationEventId; same generation ids.
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(
        JSON.stringify(buildManifestFields({
          rotationEventId: '22222222-2222-4222-8222-222222222222',
        })),
      ),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(
        JSON.stringify(buildManifestFields({
          previousGenerationId: PREV_GEN,
          nextGenerationId: PREV_GEN,
        })),
      ),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    // Invalid digest / ISO / journal schema.
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(
        JSON.stringify(buildManifestFields({ previousHeadDigest: 'not-hex' })),
      ),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(
        JSON.stringify(buildManifestFields({ createdAt: '2026/07/24' })),
      ),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(
        JSON.stringify(buildManifestFields({ previousJournalSchemaVersion: 3 })),
      ),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    // Canonical raw identity: trailing newline / whitespace / non-string.
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(`${raw}\n`),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(raw.replace(':', ': ')),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(null),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(Buffer.from(raw)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText('{not-json'),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    // Manifest must not embed its own digest field.
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(
        JSON.stringify({ ...fields, digest: HEX64_E }),
      ),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    // Proxy / accessor / symbol reject path-free without whitewash.
    const proxy = new Proxy(fields, {
      get() {
        throw new Error('SECRET /tmp/manifest-path');
      },
    });
    assert.throws(
      () => mod.buildAuditIntegrityArchiveManifest(proxy),
      (e) => {
        assertRotationError(e, CODE_STATE_INVALID);
        assert.ok(!e.message.includes('SECRET'));
        assert.ok(!e.message.includes('/tmp'));
        return true;
      },
    );

    // Own symbol key → STATE_INVALID, path-free.
    const withSymbol = { ...fields };
    const secretSym = Symbol('secret-path-/tmp/manifest-leak');
    withSymbol[secretSym] = '/tmp/secret-manifest-path';
    assert.throws(
      () => mod.buildAuditIntegrityArchiveManifest(withSymbol),
      (e) => {
        assertRotationError(e, CODE_STATE_INVALID);
        assert.ok(!e.message.includes('secret'));
        assert.ok(!e.message.includes('/tmp'));
        return true;
      },
    );

    // Enumerable accessor property: getter must not execute; STATE_INVALID path-free.
    let accessorGets = 0;
    const withAccessor = {};
    for (const [k, v] of Object.entries(fields)) {
      Object.defineProperty(withAccessor, k, {
        enumerable: true,
        configurable: true,
        get() {
          accessorGets += 1;
          return v;
        },
      });
    }
    // Prove stringify would whitewash accessors into plain data.
    assert.deepEqual(JSON.parse(JSON.stringify(withAccessor)), fields);
    // Reset after deliberate whitewash proof so only builder calls are counted.
    accessorGets = 0;
    assert.throws(
      () => mod.buildAuditIntegrityArchiveManifest(withAccessor),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
    assert.equal(accessorGets, 0, 'manifest accessor getters must not run');

    // 16384-byte rejection (over limit) → exact bounds code.
    const oversize = 'z'.repeat(16385);
    assert.throws(
      () => mod.parseAuditIntegrityArchiveManifestText(oversize),
      (e) => assertRotationError(e, CODE_BOUNDS),
    );

    // Builder path-free typed reject on hostile nested key order.
    const hostileNested = buildManifestFields({
      journal: {
        recordCount: 3,
        rawByteLength: 120,
        rawSha256: HEX64_B,
      },
    });
    assert.throws(
      () => mod.buildAuditIntegrityArchiveManifest(hostileNested),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
  });

  it('A3 exclusive exact idempotency for pre-created archive journal/events; recover preserves bytes', async () => {
    await withTempRoot('a3-idem', async (root) => {
      const fx = await createHealthyPresentEventsRoot(root);
      const rot = await loadRotationMod();
      assert.equal(typeof rot.rotateAuditIntegrityGeneration, 'function');
      assert.equal(typeof rot.recoverAuditIntegrityRotation, 'function');
      assert.equal(typeof rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK, 'symbol');

      await precreateArchiveLeaf(
        root,
        fx.generationId,
        'integrity-journal.jsonl',
        fx.journalBytes,
      );
      await precreateArchiveLeaf(
        root,
        fx.generationId,
        'events.jsonl',
        fx.eventsBytes,
      );
      const preJournal = await assertRegular0600(
        archiveJournalAbs(root, fx.generationId),
        fx.journalBytes,
      );
      const preEvents = await assertRegular0600(
        archiveEventsAbs(root, fx.generationId),
        fx.eventsBytes,
      );
      await assert.rejects(
        () => access(archiveManifestAbs(root, fx.generationId)),
        { code: 'ENOENT' },
      );

      const liveBefore = await snapshotLive(root);
      await assert.rejects(
        () => rot.rotateAuditIntegrityGeneration(root, {
          expectedGenerationId: fx.expectedGenerationId,
          expectedHeadDigest: fx.expectedHeadDigest,
          [rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: 'after-manifest',
        }),
        (e) => isTestCrash(e, CRASH_AFTER_MANIFEST),
      );

      const postJournal = await assertRegular0600(
        archiveJournalAbs(root, fx.generationId),
        preJournal,
      );
      const postEvents = await assertRegular0600(
        archiveEventsAbs(root, fx.generationId),
        preEvents,
      );
      const manifestBytes = await assertRegular0600(
        archiveManifestAbs(root, fx.generationId),
      );
      assert.equal(manifestBytes.includes(0x0a), false, 'manifest has no trailing newline');
      const stateMod = await loadStateMod();
      const parsedManifest = stateMod.parseAuditIntegrityArchiveManifestText(
        manifestBytes.toString('utf8'),
      );
      assert.equal(parsedManifest.previousGenerationId, fx.generationId);
      assert.equal(parsedManifest.journal.rawByteLength, fx.journalBytes.length);
      assert.equal(parsedManifest.journal.rawSha256, sha256Buf(fx.journalBytes));
      assert.equal(parsedManifest.events.present, true);
      assert.equal(parsedManifest.events.rawByteLength, fx.eventsBytes.length);
      assert.equal(parsedManifest.events.rawSha256, sha256Buf(fx.eventsBytes));

      // Live stores unchanged through archive-only commit point.
      const liveAfterCrash = await snapshotLive(root);
      assertLiveEqual(liveAfterCrash, liveBefore);

      // Explicit recover; do not pin interim return (Task 4 may extend cutover).
      await rot.recoverAuditIntegrityRotation(root);
      assert.deepEqual(
        await readFile(archiveJournalAbs(root, fx.generationId)),
        postJournal,
      );
      assert.deepEqual(
        await readFile(archiveEventsAbs(root, fx.generationId)),
        postEvents,
      );
      assert.deepEqual(
        await readFile(archiveManifestAbs(root, fx.generationId)),
        manifestBytes,
      );
    });
  });

  it('A4 existing archive mismatch conflicts for wrong journal/events leaves', async () => {
    const cases = [
      {
        name: 'wrong-archived-journal',
        leaf: 'integrity-journal.jsonl',
        content: Buffer.from('wrong-journal-bytes-not-a-match\n', 'utf8'),
      },
      {
        name: 'wrong-archived-events',
        leaf: 'events.jsonl',
        content: Buffer.from('{"id":"nope"}\n', 'utf8'),
      },
    ];

    for (const c of cases) {
      await withTempRoot(`a4-${c.name}`, async (root) => {
        const fx = await createHealthyPresentEventsRoot(root);
        const rot = await loadRotationMod();
        const occupiedAbs = await precreateArchiveLeaf(
          root,
          fx.generationId,
          c.leaf,
          c.content,
        );
        const occupiedBefore = await describePath(occupiedAbs);
        assert.equal(occupiedBefore.kind, 'file');
        const liveBefore = await snapshotLive(root);

        await assert.rejects(
          () => rot.rotateAuditIntegrityGeneration(root, {
            expectedGenerationId: fx.expectedGenerationId,
            expectedHeadDigest: fx.expectedHeadDigest,
          }),
          (e) => assertPathFreeRotationError(e, CODE_CONFLICT, root),
        );

        const occupiedAfter = await describePath(occupiedAbs);
        assert.equal(occupiedAfter.kind, 'file');
        assert.deepEqual(occupiedAfter.bytes, occupiedBefore.bytes);
        assert.equal(occupiedAfter.mode, occupiedBefore.mode);

        await assert.rejects(
          () => access(archiveManifestAbs(root, fx.generationId)),
          { code: 'ENOENT' },
        );
        const liveAfter = await snapshotLive(root);
        // Live journal/events/dual idle remain byte-identical; prepared WAL is expected
        // because start protocol publishes prepared before archive exclusive-create.
        assertLiveEqual(liveAfter, liveBefore);
        assert.ok(liveAfter.rotation, 'A4 archive-stage conflict must leave prepared WAL');
        const stateMod = await loadStateMod();
        const wal = stateMod.parseAuditIntegrityRotationStateText(
          liveAfter.rotation.toString('utf8'),
        );
        assert.equal(wal.status, 'prepared');
        assert.equal(wal.previousGenerationId, fx.expectedGenerationId);
        assert.equal(wal.previousHeadDigest, fx.expectedHeadDigest);
      });
    }
  });

  it('A5 originally absent events snapshot archives empty events with present:false fact', async () => {
    await withTempRoot('a5-absent', async (root) => {
      const fx = await createHealthyAbsentEventsRoot(root);
      const rot = await loadRotationMod();
      const liveBefore = await snapshotLive(root);

      await assert.rejects(
        () => rot.rotateAuditIntegrityGeneration(root, {
          expectedGenerationId: fx.expectedGenerationId,
          expectedHeadDigest: fx.expectedHeadDigest,
          [rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: 'after-manifest',
        }),
        (e) => isTestCrash(e, CRASH_AFTER_MANIFEST),
      );

      // Live unchanged.
      assertLiveEqual(await snapshotLive(root), liveBefore);

      const archivedJournal = await assertRegular0600(
        archiveJournalAbs(root, fx.generationId),
        fx.journalBytes,
      );
      const archivedEvents = await assertRegular0600(
        archiveEventsAbs(root, fx.generationId),
        Buffer.alloc(0),
      );
      assert.equal(archivedEvents.length, 0);
      const manifestBytes = await assertRegular0600(
        archiveManifestAbs(root, fx.generationId),
      );
      assert.equal(manifestBytes.includes(0x0a), false);

      const stateMod = await loadStateMod();
      const manifest = stateMod.parseAuditIntegrityArchiveManifestText(
        manifestBytes.toString('utf8'),
      );
      assert.equal(manifest.events.present, false);
      assert.equal(manifest.events.rawByteLength, 0);
      assert.equal(manifest.events.rawSha256, EMPTY_SHA256);
      assert.equal(manifest.events.strictRecordCount, 0);
      assert.equal(manifest.journal.rawByteLength, archivedJournal.length);
      assert.equal(manifest.journal.rawSha256, sha256Buf(archivedJournal));

      const walRaw = await readFile(rotationStateAbs(root), 'utf8');
      const wal = stateMod.parseAuditIntegrityRotationStateText(walRaw);
      assert.equal(wal.status, 'prepared');
      assert.equal(wal.events.sealed.present, false);
      assert.equal(wal.events.sealed.rawByteLength, 0);
      assert.equal(wal.events.sealed.rawSha256, EMPTY_SHA256);
      assert.equal(wal.events.sealed.strictRecordCount, 0);
    });
  });

  it('A6 manifest is last and actual commit point across crash hooks', async () => {
    const cases = [
      {
        hook: 'after-archive-journal',
        crash: CRASH_AFTER_ARCHIVE_JOURNAL,
        expectJournal: true,
        expectEvents: false,
        expectManifest: false,
        walPrepared: true,
      },
      {
        hook: 'after-archive-events',
        crash: CRASH_AFTER_ARCHIVE_EVENTS,
        expectJournal: true,
        expectEvents: true,
        expectManifest: false,
        walPrepared: true,
      },
      {
        hook: 'after-manifest',
        crash: CRASH_AFTER_MANIFEST,
        expectJournal: true,
        expectEvents: true,
        expectManifest: true,
        walPrepared: true,
      },
    ];

    for (const c of cases) {
      await withTempRoot(`a6-${c.hook}`, async (root) => {
        const fx = await createHealthyPresentEventsRoot(root);
        const rot = await loadRotationMod();
        const liveBefore = await snapshotLive(root);

        await assert.rejects(
          () => rot.rotateAuditIntegrityGeneration(root, {
            expectedGenerationId: fx.expectedGenerationId,
            expectedHeadDigest: fx.expectedHeadDigest,
            [rot.AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK]: c.hook,
          }),
          (e) => isTestCrash(e, c.crash),
        );

        assertLiveEqual(await snapshotLive(root), liveBefore);

        if (c.expectJournal) {
          await assertRegular0600(
            archiveJournalAbs(root, fx.generationId),
            fx.journalBytes,
          );
        } else {
          await assert.rejects(
            () => access(archiveJournalAbs(root, fx.generationId)),
            { code: 'ENOENT' },
          );
        }

        if (c.expectEvents) {
          await assertRegular0600(
            archiveEventsAbs(root, fx.generationId),
            fx.eventsBytes,
          );
        } else {
          await assert.rejects(
            () => access(archiveEventsAbs(root, fx.generationId)),
            { code: 'ENOENT' },
          );
        }

        /** @type {string|null} */
        let manifestRawText = null;
        if (c.expectManifest) {
          const manifestBytes = await assertRegular0600(
            archiveManifestAbs(root, fx.generationId),
          );
          assert.equal(manifestBytes.includes(0x0a), false);
          manifestRawText = manifestBytes.toString('utf8');
          const stateMod = await loadStateMod();
          const manifest = stateMod.parseAuditIntegrityArchiveManifestText(
            manifestRawText,
          );
          assert.equal(manifest.journal.rawSha256, sha256Buf(fx.journalBytes));
          assert.equal(manifest.events.rawSha256, sha256Buf(fx.eventsBytes));
          assert.equal(
            sha256Hex(manifestRawText),
            stateMod.buildAuditIntegrityArchiveManifest(manifest).digest,
          );
        } else {
          await assert.rejects(
            () => access(archiveManifestAbs(root, fx.generationId)),
            { code: 'ENOENT' },
          );
        }

        if (c.walPrepared) {
          const stateMod = await loadStateMod();
          const wal = stateMod.parseAuditIntegrityRotationStateText(
            await readFile(rotationStateAbs(root), 'utf8'),
          );
          assert.equal(wal.status, 'prepared');
          if (c.expectManifest) {
            // Actual verified manifest is the commit point even while WAL is prepared.
            // Bind WAL digest to exact on-disk manifest raw bytes (not regex-only).
            assert.equal(
              wal.archiveManifestDigest,
              sha256Hex(manifestRawText),
            );
          }
        }
      });
    }

    // R2: external same-process archive-journal swap after manifest.json appears
    // must not publish archive-committed (re-verify all three leaves at commit).
    await withTempRoot('a6-archive-journal-swap', async (root) => {
      const fx = await createHealthyPresentEventsRoot(root);
      const rot = await loadRotationMod();
      const liveBefore = await snapshotLive(root);

      const archDir = archiveDirAbs(root, fx.generationId);
      await mkdir(archDir, { recursive: true, mode: 0o700 });

      const foreignBytes = 'FOREIGN_ARCHIVE_JOURNAL_SWAP_BYTES\n';
      const journalArchAbs = archiveJournalAbs(root, fx.generationId);
      const manifestAbsPath = archiveManifestAbs(root, fx.generationId);

      let injected = false;
      const tryInjectAfterManifest = () => {
        if (injected) return;
        try {
          // Inject only when manifest.json exists and is readable.
          readFileSync(manifestAbsPath);
          writeFileSync(journalArchAbs, foreignBytes);
          injected = true;
        } catch {
          // Manifest not yet durable, or journal mid-create — keep polling.
        }
      };

      const watcher = watch(archDir, (eventType, filename) => {
        void eventType;
        const name = filename == null ? '' : String(filename);
        if (name && name !== 'manifest.json' && !name.endsWith('manifest.json')) {
          return;
        }
        tryInjectAfterManifest();
      });

      const pollerStop = { stop: false };
      const poller = (async () => {
        const deadline = Date.now() + 5000;
        while (!pollerStop.stop && !injected && Date.now() < deadline) {
          tryInjectAfterManifest();
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();

      try {
        await assert.rejects(
          () => rot.rotateAuditIntegrityGeneration(root, {
            expectedGenerationId: fx.expectedGenerationId,
            expectedHeadDigest: fx.expectedHeadDigest,
          }),
          (e) => assertPathFreeRotationError(e, CODE_CONFLICT, root),
        );
      } finally {
        pollerStop.stop = true;
        watcher.close();
        await Promise.race([
          poller,
          new Promise((resolve) => setTimeout(resolve, 50)),
        ]);
      }

      assert.equal(injected, true, 'archive-journal swap injection must have fired');
      assertLiveEqual(await snapshotLive(root), liveBefore);
      assert.deepEqual(
        await readFile(journalArchAbs),
        Buffer.from(foreignBytes),
      );
      await access(manifestAbsPath);
      const stateMod = await loadStateMod();
      const wal = stateMod.parseAuditIntegrityRotationStateText(
        await readFile(rotationStateAbs(root), 'utf8'),
      );
      assert.equal(wal.status, 'prepared');
      assert.notEqual(wal.status, 'archive-committed');
    });
  });

  it('A7 occupied archive leaf fail-closed for wrong file/dir/symlink', async () => {
    const leaves = [
      'integrity-journal.jsonl',
      'events.jsonl',
      'manifest.json',
    ];
    const kinds = ['wrong-file', 'directory', 'symlink'];

    for (const leaf of leaves) {
      for (const kind of kinds) {
        await withTempRoot(`a7-${leaf}-${kind}`, async (root) => {
          const fx = await createHealthyPresentEventsRoot(root);
          const rot = await loadRotationMod();
          const dir = archiveDirAbs(root, fx.generationId);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const leafAbs = join(dir, leaf);

          // Optional exact prefix leaves before a later occupied leaf.
          if (leaf === 'events.jsonl' || leaf === 'manifest.json') {
            await writeFile(
              archiveJournalAbs(root, fx.generationId),
              fx.journalBytes,
              { mode: 0o600 },
            );
          }
          if (leaf === 'manifest.json') {
            await writeFile(
              archiveEventsAbs(root, fx.generationId),
              fx.eventsBytes,
              { mode: 0o600 },
            );
          }

          let externalTarget = null;
          let externalBefore = null;
          if (kind === 'wrong-file') {
            await writeFile(leafAbs, Buffer.from('hostile-occupied-leaf\n'), {
              mode: 0o600,
            });
          } else if (kind === 'directory') {
            await mkdir(leafAbs, { recursive: true, mode: 0o700 });
          } else {
            externalTarget = join(root, `ext-target-${leaf}-${kind}.bin`);
            await writeFile(externalTarget, Buffer.from('external-symlink-target-v1'), {
              mode: 0o600,
            });
            externalBefore = await readFile(externalTarget);
            await symlink(externalTarget, leafAbs);
          }

          const occupiedBefore = await describePath(leafAbs);
          const liveBefore = await snapshotLive(root);
          const prefixJournalBefore = leaf === 'integrity-journal.jsonl'
            ? null
            : await describePath(archiveJournalAbs(root, fx.generationId));
          const prefixEventsBefore = leaf === 'manifest.json'
            ? await describePath(archiveEventsAbs(root, fx.generationId))
            : null;

          await assert.rejects(
            () => rot.rotateAuditIntegrityGeneration(root, {
              expectedGenerationId: fx.expectedGenerationId,
              expectedHeadDigest: fx.expectedHeadDigest,
            }),
            (e) => assertPathFreeRotationError(e, CODE_CONFLICT, root),
          );

          const occupiedAfter = await describePath(leafAbs);
          assert.equal(occupiedAfter.kind, occupiedBefore.kind);
          if (occupiedBefore.kind === 'file') {
            assert.deepEqual(occupiedAfter.bytes, occupiedBefore.bytes);
          }
          if (occupiedBefore.kind === 'symlink') {
            assert.equal(occupiedAfter.target, occupiedBefore.target);
            assert.deepEqual(occupiedAfter.targetBytes, externalBefore);
            assert.deepEqual(await readFile(externalTarget), externalBefore);
          }
          if (occupiedBefore.kind === 'directory') {
            assert.equal(occupiedAfter.kind, 'directory');
          }

          // Never falsely claim a manifest commit for non-manifest occupations;
          // when manifest itself is occupied, it remains the hostile object.
          if (leaf !== 'manifest.json') {
            await assert.rejects(
              () => access(archiveManifestAbs(root, fx.generationId)),
              { code: 'ENOENT' },
            );
          } else {
            const m = await describePath(archiveManifestAbs(root, fx.generationId));
            assert.equal(m.kind, occupiedBefore.kind);
            if (m.kind === 'file') {
              assert.deepEqual(m.bytes, occupiedBefore.bytes);
            }
          }

          // Permitted prefix exact leaves may remain; no overwrite.
          if (prefixJournalBefore && prefixJournalBefore.kind === 'file') {
            const j = await describePath(archiveJournalAbs(root, fx.generationId));
            assert.equal(j.kind, 'file');
            assert.deepEqual(j.bytes, prefixJournalBefore.bytes);
          }
          if (prefixEventsBefore && prefixEventsBefore.kind === 'file') {
            const e = await describePath(archiveEventsAbs(root, fx.generationId));
            assert.equal(e.kind, 'file');
            assert.deepEqual(e.bytes, prefixEventsBefore.bytes);
          }

          assertLiveEqual(await snapshotLive(root), liveBefore);
        });
      }
    }
  });
});
