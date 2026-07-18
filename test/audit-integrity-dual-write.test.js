/**
 * V1.37 C3: dual-write bootstrap / idle validation / prepared recovery-not-yet-exposed gate.
 * Public contract: recoverAndValidateAuditIntegrityDualWrite(root).
 * Runtime file + API behavior tests (not source-string substitutes for critical paths).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES } from '../src/error-codes.js';
import {
  computeAuditIntegrityEventPayloadDigest,
  stringifyStrictCanonicalSanitizedEvent,
} from '../src/audit-event-schema.js';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const GENERATION_ID = '0123456789abcdef0123456789abcdef';
const GENERATION_ID_ALT = 'fedcba9876543210fedcba9876543210';
const DOMAIN_GENERATION_OPEN = 'linke.audit-integrity-journal.v1.generation-open\u0000';

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

const TX_ID = '11111111-1111-4111-8111-111111111111';

async function mkdtempSafe(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), `linke-adw-c3-${prefix}-`));
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtempSafe(prefix);
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function stateAbs(root) {
  return join(root, 'audit', 'integrity-dual-write-state.json');
}

function journalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}

function eventsAbs(root) {
  return join(root, 'audit', 'events.jsonl');
}

async function loadCoordinator() {
  return import('../src/audit-integrity-dual-write.js');
}

async function loadJournal() {
  return import('../src/audit-integrity-journal.js');
}

async function loadState() {
  return import('../src/audit-integrity-dual-write-state.js');
}

async function loadCrossStore() {
  return import('../src/audit-integrity-cross-store.js');
}

async function withLease(root, fn) {
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

function assertDualWriteError(error, code, rootHint) {
  assert.equal(error.name, 'AuditIntegrityDualWriteError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.message, error.code);
  if (rootHint) {
    assert.ok(!error.message.includes(rootHint));
    assert.ok(!String(error.stack || '').split('\n')[0].includes(rootHint));
  }
  assert.ok(!error.message.includes('ENOENT'));
  assert.ok(!error.message.includes('/var/'));
  assert.ok(!error.message.includes('/private/'));
  assert.ok(!error.message.includes('/tmp/'));
  assert.ok(!error.message.includes('Users/'));
  assert.ok(!error.message.includes('integrity-journal'));
  assert.ok(!error.message.includes('events.jsonl'));
  return true;
}

function assertPathFreeError(error, rootHint) {
  assert.equal(error.message, error.code);
  if (rootHint) {
    assert.ok(!error.message.includes(rootHint));
  }
  assert.ok(!error.message.includes('ENOENT'));
  assert.ok(!error.message.includes('/tmp/'));
  assert.ok(!error.message.includes('Users/'));
  return true;
}

function independentOpenLinkDigest(generationId) {
  return createHash('sha256')
    .update(DOMAIN_GENERATION_OPEN + generationId + '\u0000' + '0' + '\u0000' + 'null' + '\u0000' + 'null')
    .digest('hex');
}

function eventLine(event) {
  return `${stringifyStrictCanonicalSanitizedEvent(event)}\n`;
}

async function writeEvents(root, text) {
  await mkdir(join(root, 'audit'), { recursive: true });
  await writeFile(eventsAbs(root), text, { mode: 0o600 });
}

function buildPreparedFixture(generationId = GENERATION_ID) {
  const event = { ...EVENT_A };
  const eventLineUtf8 = eventLine(event);
  const payloadDigest = computeAuditIntegrityEventPayloadDigest(event);
  const preHead = independentOpenLinkDigest(generationId);
  const postHead = 'c'.repeat(64);
  return {
    schemaVersion: 1,
    status: 'prepared',
    transactionId: TX_ID,
    generationId,
    retention: null,
    event,
    payloadDigest,
    eventLineUtf8,
    journal: {
      pre: {
        recordCount: 1,
        headDigest: preHead,
        rawByteLength: 240,
        rawSha256: 'b'.repeat(64),
      },
      post: {
        recordCount: 2,
        headDigest: postHead,
        rawByteLength: 480,
        rawSha256: 'd'.repeat(64),
        sequence: 1,
        linkDigest: postHead,
        previousLinkDigest: preHead,
      },
    },
    events: {
      pre: {
        present: true,
        byteLength: 10,
        sha256: 'e'.repeat(64),
        strictRecordCount: 1,
      },
      post: {
        present: true,
        byteLength: 80,
        sha256: 'f'.repeat(64),
        strictRecordCount: 2,
      },
    },
  };
}

function assertIdleReceiptShape(receipt) {
  assert.equal(receipt.status, 'idle');
  assert.match(receipt.generationId, /^[0-9a-f]{32}$/);
  assert.equal(typeof receipt.journal.recordCount, 'number');
  assert.match(receipt.journal.headDigest, /^[0-9a-f]{64}$/);
  assert.equal(typeof receipt.journal.rawByteLength, 'number');
  assert.match(receipt.journal.rawSha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof receipt.events.present, 'boolean');
  assert.equal(typeof receipt.events.byteLength, 'number');
  assert.match(receipt.events.sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof receipt.events.strictRecordCount, 'number');
  assert.equal(receipt.lastTransactionId, null);
  assert.equal(receipt.lastPayloadDigest, null);
  assert.equal(receipt.lastSequence, null);
  // path-free / no raw event body
  const json = JSON.stringify(receipt);
  assert.ok(!json.includes('integrity-journal.jsonl'));
  assert.ok(!json.includes('events.jsonl'));
  assert.ok(!json.includes('/tmp/'));
  assert.ok(!json.includes('Users/'));
}

// ── exports ────────────────────────────────────────────────────────────

describe('C3 dual-write coordinator exports', () => {
  it('0. exports public recover wrapper and unlocked ensure idle helper', async () => {
    const mod = await loadCoordinator();
    assert.equal(typeof mod.recoverAndValidateAuditIntegrityDualWrite, 'function');
    assert.equal(typeof mod.ensureAuditIntegrityDualWriteIdleUnlocked, 'function');
  });
});

// ── A. state missing bootstrap ─────────────────────────────────────────

describe('C3 bootstrap: state missing', () => {
  it('1. S∅+J∅+E∅ → init journal + canonical idle', async () => {
    await withTempRoot('s0-j0-e0', async (root) => {
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const receipt = await recoverAndValidateAuditIntegrityDualWrite(root);
      assertIdleReceiptShape(receipt);
      assert.equal(receipt.journal.recordCount, 1);
      assert.equal(receipt.events.present, false);
      assert.equal(receipt.events.byteLength, 0);
      assert.equal(receipt.events.sha256, EMPTY_SHA256);
      assert.equal(receipt.events.strictRecordCount, 0);

      const journalRaw = await readFile(journalAbs(root), 'utf8');
      assert.ok(journalRaw.length > 0);
      assert.equal(
        receipt.journal.rawSha256,
        createHash('sha256').update(journalRaw).digest('hex'),
      );
      assert.equal(receipt.journal.rawByteLength, Buffer.byteLength(journalRaw, 'utf8'));
      assert.equal(receipt.journal.headDigest, independentOpenLinkDigest(receipt.generationId));

      const stateRaw = await readFile(stateAbs(root), 'utf8');
      const stateMod = await loadState();
      const loaded = stateMod.parseAuditIntegrityDualWriteStateText(stateRaw);
      assert.equal(loaded.status, 'idle');
      assert.deepEqual(loaded.journal, receipt.journal);
      assert.deepEqual(loaded.events, receipt.events);
    });
  });

  it('1b. S∅+J∅+Eempty → idle; events present:true byteLength:0 sha256 empty strictRecordCount:0', async () => {
    await withTempRoot('s0-j0-eempty', async (root) => {
      await writeEvents(root, '');
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const receipt = await recoverAndValidateAuditIntegrityDualWrite(root);
      assertIdleReceiptShape(receipt);
      assert.equal(receipt.events.present, true);
      assert.equal(receipt.events.byteLength, 0);
      assert.equal(receipt.events.sha256, EMPTY_SHA256);
      assert.equal(receipt.events.strictRecordCount, 0);
      assert.equal(receipt.journal.recordCount, 1);
    });
  });

  it('2. S∅+J∅+Elegacy → init + idle; cross-store partial uncovered honest', async () => {
    await withTempRoot('s0-j0-elegacy', async (root) => {
      await writeEvents(root, eventLine(EVENT_A));
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const receipt = await recoverAndValidateAuditIntegrityDualWrite(root);
      assertIdleReceiptShape(receipt);
      assert.equal(receipt.events.present, true);
      assert.equal(receipt.events.strictRecordCount, 1);
      assert.equal(receipt.journal.recordCount, 1);

      const cross = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross.state, 'partial');
      assert.equal(cross.relationship, 'uncovered-events');
      assert.equal(cross.uncoveredEventCount, 1);
      assert.equal(cross.journalEventCount, 0);
    });
  });

  it('3. S∅+J∅+Ebad → fail-closed before any journal/state write', async () => {
    await withTempRoot('s0-j0-ebad', async (root) => {
      await writeEvents(root, 'not-json\n');
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => {
          assert.equal(e.name, 'AuditIntegrityCrossStoreError');
          assert.equal(e.code, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID);
          assertPathFreeError(e, root);
          return true;
        },
      );
      await assert.rejects(() => access(journalAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      assert.equal(await readFile(eventsAbs(root), 'utf8'), 'not-json\n');
    });
  });

  it('4. S∅+Jopen+E∅ → idle from open; journal bytes unchanged', async () => {
    await withTempRoot('s0-jopen-e0', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const beforeJournal = await readFile(journalAbs(root));
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const receipt = await recoverAndValidateAuditIntegrityDualWrite(root);
      assertIdleReceiptShape(receipt);
      assert.equal(receipt.generationId, GENERATION_ID);
      assert.equal(receipt.journal.recordCount, 1);
      assert.equal(receipt.events.present, false);
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      assert.equal(
        receipt.journal.rawSha256,
        createHash('sha256').update(beforeJournal).digest('hex'),
      );
    });
  });

  it('5. S∅+Jevt+E equal → idle bootstrap', async () => {
    await withTempRoot('s0-jevt-eq', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await writeEvents(root, eventLine(EVENT_A));
      const beforeJournal = await readFile(journalAbs(root));
      const beforeEvents = await readFile(eventsAbs(root));

      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const receipt = await recoverAndValidateAuditIntegrityDualWrite(root);
      assertIdleReceiptShape(receipt);
      assert.equal(receipt.generationId, GENERATION_ID);
      assert.equal(receipt.journal.recordCount, 2);
      assert.equal(receipt.events.strictRecordCount, 1);
      assert.equal(receipt.events.present, true);

      const cross = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross.state, 'verified');
      assert.equal(cross.relationship, 'equal');
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      assert.deepEqual(await readFile(eventsAbs(root)), beforeEvents);
    });
  });

  it('6. S∅+Jevt+E partial/uncovered → allow bootstrap idle (partial is not failure)', async () => {
    await withTempRoot('s0-partial', async (root) => {
      // Jopen only + Elegacy → partial/uncovered-events after bootstrap from existing J
      const { initializeAuditIntegrityJournal } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await writeEvents(root, eventLine(EVENT_A) + eventLine(EVENT_B));
      const beforeJournal = await readFile(journalAbs(root));

      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const receipt = await recoverAndValidateAuditIntegrityDualWrite(root);
      assertIdleReceiptShape(receipt);
      assert.equal(receipt.events.strictRecordCount, 2);

      const cross = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross.state, 'partial');
      assert.ok(
        cross.relationship === 'uncovered-events'
          || cross.relationship === 'journal-suffix-of-events',
      );
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
    });
  });

  it('6b. S∅+Jevt+E journal-suffix-of-events (partial) → allow bootstrap idle', async () => {
    await withTempRoot('s0-jsuffix', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      // E = [A, B], J = [B] → journal-suffix-of-events
      await writeEvents(root, eventLine(EVENT_A) + eventLine(EVENT_B));
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_B } });

      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
      const receipt = await recoverAndValidateAuditIntegrityDualWrite(root);
      assertIdleReceiptShape(receipt);
      const cross = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross.state, 'partial');
      assert.equal(cross.relationship, 'journal-suffix-of-events');
    });
  });

  it('7. S∅+Jbad → propagate journal typed; no auto-repair/unlink/init', async () => {
    await withTempRoot('s0-jbad', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(journalAbs(root), '{broken\n', { mode: 0o600 });
      const before = await readFile(journalAbs(root));
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => {
          assert.equal(e.name, 'AuditIntegrityJournalError');
          assert.equal(e.code, ERROR_CODES.AUDIT_CHAIN_BROKEN);
          assertPathFreeError(e, root);
          return true;
        },
      );
      assert.deepEqual(await readFile(journalAbs(root)), before);
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('8. journal non-NOT_INITIALIZED error is never swallowed as missing', async () => {
    await withTempRoot('s0-j-io-shape', async (root) => {
      // Directory at journal leaf → IO (or typed), not treated as missing init.
      await mkdir(join(root, 'audit'), { recursive: true });
      await mkdir(journalAbs(root));
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => {
          assert.notEqual(e.code, ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED);
          // Must not bootstrap past this by init (would fail ALREADY or create sibling).
          assert.ok(
            e.name === 'AuditIntegrityJournalError'
              || e.name === 'AuditIntegrityCrossStoreError'
              || e.name === 'AuditIntegrityDualWriteError',
          );
          assertPathFreeError(e, root);
          return true;
        },
      );
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('16. broken J↔E must not write idle', async () => {
    await withTempRoot('s0-broken', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      // E has unrelated event B → broken
      await writeEvents(root, eventLine(EVENT_B));
      const beforeJournal = await readFile(journalAbs(root));
      const beforeEvents = await readFile(eventsAbs(root));

      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => {
          assert.equal(e.name, 'AuditIntegrityCrossStoreError');
          assert.equal(e.code, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
          assertPathFreeError(e, root);
          return true;
        },
      );
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      assert.deepEqual(await readFile(eventsAbs(root)), beforeEvents);
    });
  });

  it('17. only ENOENT = state missing; S∅+verified/partial is bootstrap not cursor-mismatch', async () => {
    await withTempRoot('s0-not-mismatch', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      // First call: bootstrap (state missing), NOT cursor-mismatch
      const receipt = await recoverAndValidateAuditIntegrityDualWrite(root);
      assert.equal(receipt.status, 'idle');
      assert.notEqual(receipt, null);
    });
  });

  it('18. init O_EXCL residual zero/partial journal → Jbad fail-closed (no init mask)', async () => {
    await withTempRoot('s0-jzero', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(journalAbs(root), '', { mode: 0o600 });
      const before = await readFile(journalAbs(root));
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => {
          assert.equal(e.name, 'AuditIntegrityJournalError');
          assert.equal(e.code, ERROR_CODES.AUDIT_CHAIN_BROKEN);
          return true;
        },
      );
      assert.deepEqual(await readFile(journalAbs(root)), before);
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
    });
  });

  it('14. bootstrap publish → state mode 0600, atomic-readable, last* all null', async () => {
    await withTempRoot('s0-mode', async (root) => {
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const receipt = await recoverAndValidateAuditIntegrityDualWrite(root);
      assert.equal(receipt.lastTransactionId, null);
      assert.equal(receipt.lastPayloadDigest, null);
      assert.equal(receipt.lastSequence, null);

      const st = await lstat(stateAbs(root));
      assert.equal(st.isFile(), true);
      assert.equal(st.mode & 0o777, 0o600);

      const stateMod = await loadState();
      await withLease(root, async (resolvedRoot, lease) => {
        const loaded = await stateMod.loadDualWriteStateUnlocked(resolvedRoot, lease);
        assert.equal(loaded.status, 'idle');
        assert.deepEqual(loaded.journal, receipt.journal);
        assert.deepEqual(loaded.events, receipt.events);
      });
    });
  });
});

// ── B. existing idle exact validation ──────────────────────────────────

describe('C3 idle exact validation', () => {
  it('9. exact stores match idle → ok; three files bytes unchanged', async () => {
    await withTempRoot('idle-ok', async (root) => {
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      await recoverAndValidateAuditIntegrityDualWrite(root);
      const beforeState = await readFile(stateAbs(root));
      const beforeJournal = await readFile(journalAbs(root));
      // events absent

      const receipt = await recoverAndValidateAuditIntegrityDualWrite(root);
      assert.equal(receipt.status, 'idle');
      assert.deepEqual(await readFile(stateAbs(root)), beforeState);
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      await assert.rejects(() => access(eventsAbs(root)), { code: 'ENOENT' });
    });
  });

  it('10. idle + events drift → cursor-mismatch; stores not repaired', async () => {
    await withTempRoot('idle-evt-drift', async (root) => {
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      await recoverAndValidateAuditIntegrityDualWrite(root);
      const beforeState = await readFile(stateAbs(root));
      const beforeJournal = await readFile(journalAbs(root));
      await writeEvents(root, eventLine(EVENT_A));

      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => assertDualWriteError(
          e,
          ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH,
          root,
        ),
      );
      assert.deepEqual(await readFile(stateAbs(root)), beforeState);
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      assert.equal(await readFile(eventsAbs(root), 'utf8'), eventLine(EVENT_A));
    });
  });

  it('11. idle + journal head/raw drift → cursor-mismatch', async () => {
    await withTempRoot('idle-j-drift', async (root) => {
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const first = await recoverAndValidateAuditIntegrityDualWrite(root);
      const beforeJournal = await readFile(journalAbs(root));
      const beforeState = await readFile(stateAbs(root));

      // Mutate idle cursor journal.headDigest only (via republish) so stores ≠ cursor.
      const stateMod = await loadState();
      const badIdle = {
        schemaVersion: 1,
        status: 'idle',
        generationId: first.generationId,
        journal: {
          recordCount: first.journal.recordCount,
          headDigest: 'a'.repeat(64),
          rawByteLength: first.journal.rawByteLength,
          rawSha256: first.journal.rawSha256,
        },
        events: { ...first.events },
        lastTransactionId: null,
        lastPayloadDigest: null,
        lastSequence: null,
      };
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, badIdle);
      });

      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => assertDualWriteError(
          e,
          ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH,
          root,
        ),
      );
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      // state remains the bad idle we published (not auto-rebased)
      const afterState = await readFile(stateAbs(root), 'utf8');
      assert.ok(afterState.includes('"a"'.slice(0, 0) + 'a'.repeat(64)) || afterState.includes('a'.repeat(64)));
      assert.notDeepEqual(await readFile(stateAbs(root)), beforeState);
    });
  });

  it('12. journal generationId ≠ idle.generationId → cursor-mismatch', async () => {
    await withTempRoot('idle-gen-mismatch', async (root) => {
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const first = await recoverAndValidateAuditIntegrityDualWrite(root);
      assert.notEqual(first.generationId, GENERATION_ID_ALT);

      const stateMod = await loadState();
      const badIdle = {
        schemaVersion: 1,
        status: 'idle',
        generationId: GENERATION_ID_ALT,
        journal: { ...first.journal },
        events: { ...first.events },
        lastTransactionId: null,
        lastPayloadDigest: null,
        lastSequence: null,
      };
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, badIdle);
      });
      const beforeJournal = await readFile(journalAbs(root));
      const beforeState = await readFile(stateAbs(root));

      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => assertDualWriteError(
          e,
          ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH,
          root,
        ),
      );
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      assert.deepEqual(await readFile(stateAbs(root)), beforeState);
    });
  });
});

// ── C. prepared C3 boundary ────────────────────────────────────────────

describe('C3 prepared recovery-not-yet-exposed gate', () => {
  it('13. valid prepared fixture → RECOVERY_CONFLICT; not idle; not no-op', async () => {
    await withTempRoot('prep-gate', async (root) => {
      const { initializeAuditIntegrityJournal } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      const stateMod = await loadState();
      const prepared = buildPreparedFixture(GENERATION_ID);
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, prepared);
      });
      const beforeState = await readFile(stateAbs(root));
      const beforeJournal = await readFile(journalAbs(root));

      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => assertDualWriteError(
          e,
          ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT,
          root,
        ),
      );
      // recovery-not-yet-exposed: must not clear prepared / must not rewrite as idle
      assert.deepEqual(await readFile(stateAbs(root)), beforeState);
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      const parsed = stateMod.parseAuditIntegrityDualWriteStateText(
        await readFile(stateAbs(root), 'utf8'),
      );
      assert.equal(parsed.status, 'prepared');
    });
  });

  it('13b. prepared: journal/events/state bytes all unchanged', async () => {
    await withTempRoot('prep-bytes', async (root) => {
      const {
        initializeAuditIntegrityJournal,
        appendAuditIntegrityEvent,
      } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await writeEvents(root, eventLine(EVENT_A));

      const stateMod = await loadState();
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(
          resolvedRoot,
          lease,
          buildPreparedFixture(GENERATION_ID),
        );
      });
      const beforeState = await readFile(stateAbs(root));
      const beforeJournal = await readFile(journalAbs(root));
      const beforeEvents = await readFile(eventsAbs(root));

      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => assertDualWriteError(
          e,
          ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT,
          root,
        ),
      );
      assert.deepEqual(await readFile(stateAbs(root)), beforeState);
      assert.deepEqual(await readFile(journalAbs(root)), beforeJournal);
      assert.deepEqual(await readFile(eventsAbs(root)), beforeEvents);
    });
  });
});

// ── D. concurrency canary (true shared-queue enqueue race) ─────────────

/** Drain macrotasks so public API can finish assertSafeDataRoot + enqueue behind hold. */
async function yieldForPublicEnqueue(turns = 8) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * Hold same-root write queue, then start two public calls in explicit order without
 * awaiting either. Both must be active (not settled) before hold release so they
 * compete by real enqueue order rather than .then / await-first sequencing.
 */
async function runHeldPublicRace(resolvedRoot, firstStart, secondStart) {
  const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');

  let releaseHold;
  const holdP = new Promise((resolve) => { releaseHold = resolve; });
  let holdEntered = false;
  const hold = enqueueAuditIntegrityWriteTask(resolvedRoot, async () => {
    holdEntered = true;
    await holdP;
  });
  await yieldForPublicEnqueue(4);
  assert.equal(holdEntered, true, 'hold task must own the shared root queue');

  let firstSettled = false;
  let secondSettled = false;
  // Attach finally before any await so rejection cannot become unhandled.
  const firstP = firstStart().finally(() => { firstSettled = true; });
  await yieldForPublicEnqueue();
  assert.equal(firstSettled, false, 'first public call must still be waiting on hold');

  const secondP = secondStart().finally(() => { secondSettled = true; });
  await yieldForPublicEnqueue();

  // Both public Promises active under hold — true concurrent queue contention.
  assert.equal(firstSettled, false, 'first must remain unsettled before hold release');
  assert.equal(secondSettled, false, 'second must remain unsettled before hold release');
  assert.equal(holdEntered, true);

  // Critical evidence: both public calls started and still unsettled while hold owns the queue.
  releaseHold();
  await hold;

  return {
    firstP,
    secondP,
    get firstSettled() { return firstSettled; },
    get secondSettled() { return secondSettled; },
  };
}

async function runCoordinatorFirstCanary(root) {
  const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
  const {
    initializeAuditIntegrityJournal,
    appendAuditIntegrityEvent,
  } = await loadJournal();
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const resolvedRoot = await assertSafeDataRoot(root);

  // Pre-init BEFORE hold: open journal, state still absent, events absent (legal bootstrap).
  await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
  await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
  const journalBeforeRace = await readFile(journalAbs(root));

  const race = await runHeldPublicRace(
    resolvedRoot,
    () => recoverAndValidateAuditIntegrityDualWrite(root),
    () => appendAuditIntegrityEvent(root, {
      generationId: GENERATION_ID,
      event: { ...EVENT_A },
    }),
  );

  const receipt = await race.firstP;
  assert.equal(receipt.status, 'idle');
  assert.equal(receipt.generationId, GENERATION_ID);
  assert.equal(receipt.journal.recordCount, 1);
  assertIdleReceiptShape(receipt);
  const journalAfterBoot = await readFile(journalAbs(root));
  // Bootstrap from open journal must not rewrite journal bytes.
  assert.deepEqual(journalAfterBoot, journalBeforeRace);

  await assert.rejects(
    race.secondP,
    (e) => assertDualWriteError(
      e,
      ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
      root,
    ),
  );
  // After state exists: no journal-only write (bytes frozen at bootstrap).
  assert.deepEqual(await readFile(journalAbs(root)), journalAfterBoot);
  assert.ok(await access(stateAbs(root)).then(() => true));
  assert.equal(race.firstSettled, true);
  assert.equal(race.secondSettled, true);
}

async function runDirectFirstCanary(root) {
  const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
  const {
    initializeAuditIntegrityJournal,
    appendAuditIntegrityEvent,
  } = await loadJournal();
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { verifyAuditIntegrityAgainstEventStore } = await loadCrossStore();
  const resolvedRoot = await assertSafeDataRoot(root);

  // Pre-init BEFORE hold: open journal + events=EVENT_A so direct append yields equal cross-store.
  // Must not fold init into the racing queue task (would fake append∥coordinator competition).
  await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
  await writeEvents(root, eventLine(EVENT_A));
  await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });

  const race = await runHeldPublicRace(
    resolvedRoot,
    () => appendAuditIntegrityEvent(root, {
      generationId: GENERATION_ID,
      event: { ...EVENT_A },
    }),
    () => recoverAndValidateAuditIntegrityDualWrite(root),
  );

  const appendReceipt = await race.firstP;
  assert.equal(appendReceipt.state, 'appended');
  assert.equal(appendReceipt.generationId, GENERATION_ID);
  assert.equal(appendReceipt.recordCount, 2);

  const coordReceipt = await race.secondP;
  assert.equal(coordReceipt.status, 'idle');
  assert.equal(coordReceipt.generationId, GENERATION_ID);
  assert.equal(coordReceipt.journal.recordCount, 2);
  assert.equal(coordReceipt.events.strictRecordCount, 1);
  assert.equal(coordReceipt.events.present, true);
  assertIdleReceiptShape(coordReceipt);

  const cross = await verifyAuditIntegrityAgainstEventStore(root);
  assert.equal(cross.state, 'verified');
  assert.equal(cross.relationship, 'equal');

  // After state exists, further journal-only direct append must be blocked; bytes frozen.
  const frozenJournal = await readFile(journalAbs(root));
  const frozenEvents = await readFile(eventsAbs(root));
  const frozenState = await readFile(stateAbs(root));
  await assert.rejects(
    () => appendAuditIntegrityEvent(root, {
      generationId: GENERATION_ID,
      event: { ...EVENT_B },
    }),
    (e) => assertDualWriteError(
      e,
      ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED,
      root,
    ),
  );
  assert.deepEqual(await readFile(journalAbs(root)), frozenJournal);
  assert.deepEqual(await readFile(eventsAbs(root)), frozenEvents);
  assert.deepEqual(await readFile(stateAbs(root)), frozenState);
  assert.equal(race.firstSettled, true);
  assert.equal(race.secondSettled, true);
}

describe('C3 concurrency canary: direct append ∥ first coordinator bootstrap', () => {
  it('19a. coordinator-first true race: both enqueued under hold → bootstrap then DIRECT_MUTATION_BLOCKED; journal frozen', async () => {
    await withTempRoot('canary-coord-first', async (root) => {
      await runCoordinatorFirstCanary(root);
    });
  });

  it('19b. direct-first true race: both enqueued under hold → append then legal bootstrap; later append blocked', async () => {
    await withTempRoot('canary-direct-first', async (root) => {
      await runDirectFirstCanary(root);
    });
  });

  it('19c. stress both true enqueue orders (5× each) under shared queue hold', async () => {
    for (let i = 0; i < 5; i += 1) {
      await withTempRoot(`canary-stress-cf-${i}`, async (root) => {
        await runCoordinatorFirstCanary(root);
      });
      await withTempRoot(`canary-stress-df-${i}`, async (root) => {
        await runDirectFirstCanary(root);
      });
    }
  });
});

// ── E. errors / lease / path-free ──────────────────────────────────────

describe('C3 errors, lease, path-free', () => {
  it('15. path-free dual-write errors (message===code; no root/path/raw)', async () => {
    await withTempRoot('path-free', async (root) => {
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      await recoverAndValidateAuditIntegrityDualWrite(root);
      await writeEvents(root, eventLine(EVENT_A));
      await assert.rejects(
        () => recoverAndValidateAuditIntegrityDualWrite(root),
        (e) => assertDualWriteError(
          e,
          ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH,
          root,
        ),
      );
    });
  });

  it('20. unlocked ensure requires active same-root lease (wrong/missing lease fail-closed)', async () => {
    await withTempRoot('lease-gate', async (root) => {
      const { ensureAuditIntegrityDualWriteIdleUnlocked } = await loadCoordinator();
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);
      const forged = Object.freeze(Object.create(null));
      await assert.rejects(
        () => ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, forged),
        (e) => {
          assert.equal(e.name, 'SafeDataFileError');
          return true;
        },
      );
      await assert.rejects(
        () => ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, null),
        (e) => {
          assert.equal(e.name, 'SafeDataFileError');
          return true;
        },
      );
    });
  });

  it('21. public wrapper enqueues once (no nested enqueue; runtime serialize with peer task)', async () => {
    await withTempRoot('enqueue-once', async (root) => {
      const { recoverAndValidateAuditIntegrityDualWrite } = await loadCoordinator();
      const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);
      const order = [];

      let releaseHold;
      const holdP = new Promise((resolve) => { releaseHold = resolve; });
      const hold = enqueueAuditIntegrityWriteTask(resolvedRoot, async () => {
        order.push('hold-start');
        await holdP;
        order.push('hold-end');
      });
      const bootP = recoverAndValidateAuditIntegrityDualWrite(root).then((r) => {
        order.push('boot-done');
        return r;
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      releaseHold();
      await hold;
      const receipt = await bootP;
      assert.equal(receipt.status, 'idle');
      assert.deepEqual(order, ['hold-start', 'hold-end', 'boot-done']);
    });
  });
});
