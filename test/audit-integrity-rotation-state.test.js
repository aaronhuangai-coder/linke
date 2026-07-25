/**
 * Linke V1.43 Task 2 RED — S1-S7 rotation WAL state contracts.
 * Dynamic namespace import only; effective RED from absent exports/behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE_SPEC = '../src/audit-integrity-rotation-state.js';

const CODE_STATE_INVALID = 'audit-integrity-rotation-state-invalid';
const CODE_IO_ERROR = 'audit-integrity-rotation-io-error';
const CODE_BOUNDS = 'audit-integrity-rotation-bounds-exceeded';

const PREV_GEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEXT_GEN = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ROTATION_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-07-24T12:00:00.000Z';
const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);
const HEX64_C = 'c'.repeat(64);
const HEX64_D = 'd'.repeat(64);
const HEX64_E = 'e'.repeat(64);
const HEX64_F = 'f'.repeat(64);
const HEX64_1 = '1'.repeat(64);

const STATUSES = Object.freeze([
  'prepared',
  'archive-committed',
  'journal-published',
  'events-published',
  'completed',
]);

const TOP_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'rotationId',
  'createdAt',
  'previousGenerationId',
  'previousHeadDigest',
  'nextGenerationId',
  'archiveRelativePath',
  'archiveManifestDigest',
  'rotationEvent',
  'journal',
  'events',
]);

const PAYLOAD_DOMAIN = 'linke.audit-integrity-journal.v1.event-payload\u0000';

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function independentPayloadDigest(canonicalEventJson) {
  return sha256Hex(`${PAYLOAD_DOMAIN}${canonicalEventJson}`);
}

function buildRotationEvent() {
  const event = {
    id: ROTATION_ID,
    createdAt: CREATED_AT,
    type: 'audit-integrity-rotation',
    outcome: 'committed',
    operation: 'generation-transition',
    message: 'audit integrity generation rotation committed',
  };
  const eventJson = JSON.stringify(event);
  const eventLineUtf8 = `${eventJson}\n`;
  return {
    event,
    eventLineUtf8,
    payloadDigest: independentPayloadDigest(eventJson),
  };
}

function buildJournal() {
  return {
    previous: {
      schemaVersion: 1,
      recordCount: 3,
      headDigest: HEX64_A,
      rawByteLength: 120,
      rawSha256: HEX64_B,
    },
    next: {
      schemaVersion: 2,
      recordCount: 2,
      headDigest: HEX64_C,
      rawByteLength: 80,
      rawSha256: HEX64_D,
    },
  };
}

function buildEvents(eventLineUtf8) {
  const sealed = {
    present: true,
    strictRecordCount: 4,
    rawByteLength: 200,
    rawSha256: HEX64_E,
  };
  return {
    sealed,
    post: {
      present: true,
      strictRecordCount: sealed.strictRecordCount + 1,
      rawByteLength: sealed.rawByteLength + Buffer.byteLength(eventLineUtf8, 'utf8'),
      rawSha256: HEX64_F,
    },
  };
}

function buildPreparedState(overrides = {}) {
  const rotationEvent = buildRotationEvent();
  const base = {
    schemaVersion: 1,
    status: 'prepared',
    rotationId: ROTATION_ID,
    createdAt: CREATED_AT,
    previousGenerationId: PREV_GEN,
    previousHeadDigest: HEX64_A,
    nextGenerationId: NEXT_GEN,
    archiveRelativePath: `audit/archive/${PREV_GEN}`,
    archiveManifestDigest: HEX64_1,
    rotationEvent,
    journal: buildJournal(),
    events: buildEvents(rotationEvent.eventLineUtf8),
  };
  return { ...base, ...overrides };
}

function reorderKeys(obj, order) {
  const out = {};
  for (const k of order) out[k] = obj[k];
  return out;
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

async function loadMod() {
  return import(MODULE_SPEC);
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-rot-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function stateAbs(root) {
  return join(root, 'audit', 'integrity-rotation-state.json');
}

async function withLease(root, fn) {
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

function assertDeeplyFrozen(value, path = 'root') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), `expected frozen at ${path}`);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const key of Object.keys(value)) {
    assertDeeplyFrozen(value[key], `${path}.${key}`);
  }
}

describe('audit integrity rotation state (Task 2 RED S1-S7)', () => {
  it('S1 canonical prepared state, constants/exports, exact raw identity and deep freeze', async () => {
    const mod = await loadMod();
    assert.equal(
      mod.AUDIT_INTEGRITY_ROTATION_STATE_RELATIVE_PATH,
      'audit/integrity-rotation-state.json',
    );
    assert.equal(mod.AUDIT_INTEGRITY_ROTATION_STATE_MAX_BYTES, 131072);
    assert.equal(mod.AUDIT_INTEGRITY_ARCHIVE_MANIFEST_MAX_BYTES, 16384);
    assert.equal(typeof mod.AuditIntegrityRotationError, 'function');
    assert.equal(typeof mod.parseAuditIntegrityRotationStateText, 'function');
    assert.equal(typeof mod.parseAuditIntegrityArchiveManifestText, 'function');
    assert.equal(typeof mod.buildAuditIntegrityArchiveManifest, 'function');
    assert.equal(typeof mod.loadAuditIntegrityRotationStateUnlocked, 'function');
    assert.equal(typeof mod.publishAuditIntegrityRotationStateUnlocked, 'function');

    const prepared = buildPreparedState();
    const raw = JSON.stringify(prepared);
    assert.equal(raw.includes('\n'), false);
    const parsed = mod.parseAuditIntegrityRotationStateText(raw);
    assert.deepEqual(Object.keys(parsed), [...TOP_KEYS]);
    assert.deepEqual(Object.keys(parsed.rotationEvent), [
      'event',
      'eventLineUtf8',
      'payloadDigest',
    ]);
    assert.deepEqual(Object.keys(parsed.rotationEvent.event), [
      'id',
      'createdAt',
      'type',
      'outcome',
      'operation',
      'message',
    ]);
    assert.deepEqual(Object.keys(parsed.journal), ['previous', 'next']);
    assert.deepEqual(Object.keys(parsed.journal.previous), [
      'schemaVersion',
      'recordCount',
      'headDigest',
      'rawByteLength',
      'rawSha256',
    ]);
    assert.deepEqual(Object.keys(parsed.journal.next), [
      'schemaVersion',
      'recordCount',
      'headDigest',
      'rawByteLength',
      'rawSha256',
    ]);
    assert.deepEqual(Object.keys(parsed.events), ['sealed', 'post']);
    assert.deepEqual(Object.keys(parsed.events.sealed), [
      'present',
      'strictRecordCount',
      'rawByteLength',
      'rawSha256',
    ]);
    assert.deepEqual(Object.keys(parsed.events.post), [
      'present',
      'strictRecordCount',
      'rawByteLength',
      'rawSha256',
    ]);
    assert.equal(JSON.stringify(parsed), raw);
    assertDeeplyFrozen(parsed);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.status, 'prepared');
    assert.equal(parsed.rotationId, parsed.rotationEvent.event.id);
    assert.equal(parsed.createdAt, parsed.rotationEvent.event.createdAt);
    assert.equal(parsed.archiveRelativePath, `audit/archive/${parsed.previousGenerationId}`);
    assert.equal(parsed.journal.previous.headDigest, parsed.previousHeadDigest);
  });

  it('S2 all five statuses parse/round-trip independently', async () => {
    const mod = await loadMod();
    for (const status of STATUSES) {
      const state = buildPreparedState({ status });
      const raw = JSON.stringify(state);
      const parsed = mod.parseAuditIntegrityRotationStateText(raw);
      assert.equal(parsed.status, status);
      assert.equal(JSON.stringify(parsed), raw);
      assertDeeplyFrozen(parsed);
    }
  });

  it('S3 wrong key order, extra string key and symbol key reject path-free', async () => {
    const mod = await loadMod();
    const prepared = buildPreparedState();
    const wrongOrder = reorderKeys(prepared, [
      'status',
      'schemaVersion',
      'rotationId',
      'createdAt',
      'previousGenerationId',
      'previousHeadDigest',
      'nextGenerationId',
      'archiveRelativePath',
      'archiveManifestDigest',
      'rotationEvent',
      'journal',
      'events',
    ]);
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(wrongOrder)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    const withExtra = { ...prepared, extra: 'nope' };
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(withExtra)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    // Symbol keys are dropped by JSON.stringify; publish must still reject symbol own keys path-free.
    await withTempRoot('s3-symbol', async (root) => {
      const withSymbol = { ...buildPreparedState() };
      const secretSym = Symbol('secret-path-/tmp/leak');
      withSymbol[secretSym] = '/tmp/secret-rotation-path';
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.publishAuditIntegrityRotationStateUnlocked(resolvedRoot, lease, withSymbol),
          (e) => {
            assertRotationError(e, CODE_STATE_INVALID, root);
            assert.ok(!e.message.includes('secret'));
            assert.ok(!e.message.includes('/tmp'));
            return true;
          },
        );
      });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('S4 Proxy and accessor inputs reject without executing getters/traps beyond the minimum safe host detection; publish preflight must reject before writes', async () => {
    await withTempRoot('s4-proxy', async (root) => {
      const mod = await loadMod();
      const target = buildPreparedState();
      const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
      const proxy = new Proxy(target, {
        get(...args) {
          traps.get += 1;
          return Reflect.get(...args);
        },
        ownKeys(...args) {
          traps.ownKeys += 1;
          return Reflect.ownKeys(...args);
        },
        getOwnPropertyDescriptor(...args) {
          traps.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(...args);
        },
        getPrototypeOf(...args) {
          traps.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(...args);
        },
      });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.publishAuditIntegrityRotationStateUnlocked(resolvedRoot, lease, proxy),
          (e) => assertRotationError(e, CODE_STATE_INVALID, root),
        );
      });
      // Allow at most minimum host detection (prototype/ownKeys), never data get traps.
      assert.equal(traps.get, 0);
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });

      const baseJournal = buildJournal().previous;
      const withAccessor = {};
      for (const [k, v] of Object.entries(baseJournal)) {
        Object.defineProperty(withAccessor, k, {
          enumerable: true,
          configurable: true,
          get() {
            traps.get += 1;
            return v;
          },
        });
      }
      const accessorState = buildPreparedState();
      accessorState.journal = {
        previous: withAccessor,
        next: buildJournal().next,
      };
      // Prove stringify would whitewash accessors.
      assert.deepEqual(
        JSON.parse(JSON.stringify(accessorState)).journal.previous,
        baseJournal,
      );
      const getBefore = traps.get;
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.publishAuditIntegrityRotationStateUnlocked(resolvedRoot, lease, accessorState),
          (e) => assertRotationError(e, CODE_STATE_INVALID, root),
        );
      });
      assert.equal(traps.get, getBefore, 'accessor getters must not run');
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('S5 invalid UUID/digest/strict ISO/cross-field relationships reject', async () => {
    const mod = await loadMod();

    const badUuid = buildPreparedState({ rotationId: 'NOT-A-UUID' });
    badUuid.rotationEvent = {
      ...badUuid.rotationEvent,
      event: { ...badUuid.rotationEvent.event, id: 'NOT-A-UUID' },
    };
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(badUuid)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    const badDigest = buildPreparedState({ previousHeadDigest: 'zzzz' });
    badDigest.journal.previous.headDigest = 'zzzz';
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(badDigest)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    const badIso = buildPreparedState({ createdAt: '2026-07-24 12:00:00' });
    badIso.rotationEvent = {
      ...badIso.rotationEvent,
      event: { ...badIso.rotationEvent.event, createdAt: '2026-07-24 12:00:00' },
    };
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(badIso)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    const sameGen = buildPreparedState({
      previousGenerationId: PREV_GEN,
      nextGenerationId: PREV_GEN,
      archiveRelativePath: `audit/archive/${PREV_GEN}`,
    });
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(sameGen)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    const idMismatch = buildPreparedState();
    idMismatch.rotationEvent = {
      ...idMismatch.rotationEvent,
      event: {
        ...idMismatch.rotationEvent.event,
        id: '22222222-2222-4222-8222-222222222222',
      },
    };
    // Fix line/digest to isolate cross-field id equality only.
    const eventJson = JSON.stringify(idMismatch.rotationEvent.event);
    idMismatch.rotationEvent.eventLineUtf8 = `${eventJson}\n`;
    idMismatch.rotationEvent.payloadDigest = independentPayloadDigest(eventJson);
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(idMismatch)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    const headMismatch = buildPreparedState({ previousHeadDigest: HEX64_1 });
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(headMismatch)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    const badArchivePath = buildPreparedState({
      archiveRelativePath: 'audit/archive/not-matching',
    });
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(badArchivePath)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );
  });

  it('S6 nested fingerprint ordering, fixed rotation event, payload digest and events post relationships; forbidden raw body keys reject', async () => {
    const mod = await loadMod();
    const prepared = buildPreparedState();
    const parsed = mod.parseAuditIntegrityRotationStateText(JSON.stringify(prepared));
    assert.equal(parsed.rotationEvent.event.type, 'audit-integrity-rotation');
    assert.equal(parsed.rotationEvent.event.outcome, 'committed');
    assert.equal(parsed.rotationEvent.event.operation, 'generation-transition');
    assert.equal(
      parsed.rotationEvent.event.message,
      'audit integrity generation rotation committed',
    );
    assert.equal(parsed.rotationEvent.eventLineUtf8.endsWith('\n'), true);
    assert.equal(parsed.rotationEvent.eventLineUtf8.indexOf('\n'), parsed.rotationEvent.eventLineUtf8.length - 1);
    assert.equal(
      parsed.rotationEvent.payloadDigest,
      independentPayloadDigest(JSON.stringify(parsed.rotationEvent.event)),
    );
    assert.equal(parsed.journal.next.schemaVersion, 2);
    assert.equal(parsed.journal.next.recordCount, 2);
    assert.equal(parsed.events.post.present, true);
    assert.equal(
      parsed.events.post.strictRecordCount,
      parsed.events.sealed.strictRecordCount + 1,
    );
    assert.equal(
      parsed.events.post.rawByteLength,
      parsed.events.sealed.rawByteLength
        + Buffer.byteLength(parsed.rotationEvent.eventLineUtf8, 'utf8'),
    );

    const wrongNestedOrder = buildPreparedState();
    wrongNestedOrder.journal = {
      next: wrongNestedOrder.journal.next,
      previous: wrongNestedOrder.journal.previous,
    };
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(wrongNestedOrder)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    const badPayload = buildPreparedState();
    badPayload.rotationEvent = {
      ...badPayload.rotationEvent,
      payloadDigest: HEX64_1,
    };
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(badPayload)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    const badPostCount = buildPreparedState();
    badPostCount.events.post.strictRecordCount = badPostCount.events.sealed.strictRecordCount + 2;
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(badPostCount)),
      (e) => assertRotationError(e, CODE_STATE_INVALID),
    );

    for (const forbidden of ['rawJournal', 'rawEvents', 'rawManifest', 'journalRaw', 'eventsRaw']) {
      const hostile = buildPreparedState();
      hostile[forbidden] = 'LARGE_BODY_' + 'x'.repeat(64);
      assert.throws(
        () => mod.parseAuditIntegrityRotationStateText(JSON.stringify(hostile)),
        (e) => {
          assertRotationError(e, CODE_STATE_INVALID);
          assert.ok(!e.message.includes('LARGE_BODY_'));
          return true;
        },
      );
    }
  });

  it('S7 128 KiB boundary plus load missing/null, oversize/SafeData IO mapping, publish bounds, active-lease requirement and exact post-read identity', async () => {
    const mod = await loadMod();
    assert.equal(mod.AUDIT_INTEGRITY_ROTATION_STATE_MAX_BYTES, 131072);

    await withTempRoot('s7-missing', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        const loaded = await mod.loadAuditIntegrityRotationStateUnlocked(resolvedRoot, lease);
        assert.equal(loaded, null);
      });
    });

    await withTempRoot('s7-roundtrip', async (root) => {
      const prepared = buildPreparedState();
      const raw = JSON.stringify(prepared);
      await withLease(root, async (resolvedRoot, lease) => {
        const published = await mod.publishAuditIntegrityRotationStateUnlocked(
          resolvedRoot,
          lease,
          prepared,
        );
        assert.equal(JSON.stringify(published), raw);
        assertDeeplyFrozen(published);
        const loaded = await mod.loadAuditIntegrityRotationStateUnlocked(resolvedRoot, lease);
        assert.equal(JSON.stringify(loaded), raw);
        assert.deepEqual(loaded, published);
      });
      const onDisk = await readFile(stateAbs(root), 'utf8');
      assert.equal(onDisk, raw);
      assert.equal(onDisk.endsWith('\n'), false);
    });

    await withTempRoot('s7-oversize-load', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const huge = `${'x'.repeat(131073)}`;
      await writeFile(stateAbs(root), huge, { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => mod.loadAuditIntegrityRotationStateUnlocked(resolvedRoot, lease),
          (e) => assertRotationError(e, CODE_IO_ERROR, root),
        );
      });
    });

    // Parse over-limit boundary: maxBytes exclusive of oversize → exact bounds code.
    const oversizeRaw = `${'y'.repeat(131073)}`;
    assert.throws(
      () => mod.parseAuditIntegrityRotationStateText(oversizeRaw),
      (e) => assertRotationError(e, CODE_BOUNDS),
    );

    await withTempRoot('s7-publish-bounds', async (root) => {
      const orig = Buffer.byteLength.bind(Buffer);
      let forced = false;
      Buffer.byteLength = (value, encoding) => {
        const real = orig(value, encoding);
        if (
          typeof value === 'string'
          && value.includes('"status":"prepared"')
          && value.includes('schemaVersion')
        ) {
          forced = true;
          return 131073;
        }
        return real;
      };
      try {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => mod.publishAuditIntegrityRotationStateUnlocked(
              resolvedRoot,
              lease,
              buildPreparedState(),
            ),
            (e) => assertRotationError(e, CODE_BOUNDS, root),
          );
        });
        assert.equal(forced, true);
        await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      } finally {
        Buffer.byteLength = orig;
      }
    });

    await withTempRoot('s7-lease', async (root) => {
      const { assertSafeDataRoot, SafeDataFileError } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);
      await assert.rejects(
        () => mod.publishAuditIntegrityRotationStateUnlocked(
          resolvedRoot,
          Object.freeze({}),
          buildPreparedState(),
        ),
        (e) => e instanceof SafeDataFileError,
      );
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      await assert.rejects(
        () => mod.loadAuditIntegrityRotationStateUnlocked(resolvedRoot, Object.freeze({})),
        (e) => e instanceof SafeDataFileError,
      );
    });
  });
});
