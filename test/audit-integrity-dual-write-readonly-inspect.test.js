/**
 * V1.38 C1: public read-only dual-write inspector
 * inspectAuditIntegrityDualWriteReadOnly(dataDir, options?)
 *
 * Observation fields only (no dualWriteState / no monitor report).
 * Tests use mkdtemp(tmpdir()) only — never write into the repo.
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
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, assertRegisteredErrorCode } from '../src/error-codes.js';
import { stringifyStrictCanonicalSanitizedEvent } from '../src/audit-event-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const DUAL_WRITE_SRC = join(REPO_ROOT, 'src/audit-integrity-dual-write.js');

const GENERATION_ID = '0123456789abcdef0123456789abcdef';

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

const OBS_KEYS = Object.freeze([
  'statePresence',
  'stateStatus',
  'storesEmpty',
  'cursorMatch',
  'journalOutcome',
  'crossStoreOutcome',
  'relationship',
  'reasonCode',
  'errorLayer',
]);

const STATE_PRESENCE = new Set(['absent', 'idle', 'prepared', 'invalid', 'io-error']);
const JOURNAL_OUT = new Set(['missing', 'verified', 'typed-error', 'skipped']);
const ALLOWED_HEALTHY_REL = new Set([
  'equal',
  'events-suffix-of-journal',
  'journal-suffix-of-events',
]);

async function mkdtempSafe(prefix) {
  return mkdtemp(join(tmpdir(), `linke-adw-c1-${prefix}-`));
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

function eventLine(event) {
  return `${stringifyStrictCanonicalSanitizedEvent(event)}\n`;
}

async function loadCoordinator() {
  return import('../src/audit-integrity-dual-write.js');
}

async function loadState() {
  return import('../src/audit-integrity-dual-write-state.js');
}

async function loadJournal() {
  return import('../src/audit-integrity-journal.js');
}

async function withLease(root, fn) {
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

function assertObservationShape(obs) {
  assert.equal(typeof obs, 'object');
  assert.ok(obs !== null);
  assert.deepEqual(Object.keys(obs), [...OBS_KEYS]);
  assert.equal(Object.prototype.hasOwnProperty.call(obs, 'dualWriteState'), false);
  assert.ok(STATE_PRESENCE.has(obs.statePresence), `bad statePresence=${obs.statePresence}`);
  assert.notEqual(obs.statePresence, 'unsafe');
  assert.ok(JOURNAL_OUT.has(obs.journalOutcome), `bad journalOutcome=${obs.journalOutcome}`);
  if (obs.reasonCode !== null) {
    assert.equal(typeof obs.reasonCode, 'string');
    assertRegisteredErrorCode(obs.reasonCode);
  }
  assert.ok(Object.isFrozen(obs));
  return true;
}

function assertPathFreeObservation(obs, rootHint) {
  const json = JSON.stringify(obs);
  assert.ok(!json.includes(rootHint));
  assert.ok(!json.includes('/tmp/'));
  assert.ok(!json.includes('/private/'));
  assert.ok(!json.includes('Users/'));
  assert.ok(!json.includes('integrity-journal.jsonl'));
  assert.ok(!json.includes('events.jsonl'));
  assert.ok(!json.includes('integrity-dual-write-state.json'));
  return true;
}

function assertSioFull(obs) {
  assertObservationShape(obs);
  assert.equal(obs.statePresence, 'io-error');
  assert.equal(obs.stateStatus, null);
  assert.equal(obs.storesEmpty, false);
  assert.equal(obs.cursorMatch, 'skipped');
  assert.equal(obs.journalOutcome, 'skipped');
  assert.equal(obs.crossStoreOutcome, 'skipped');
  assert.equal(obs.relationship, null);
  assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
  assert.equal(obs.errorLayer, 'state');
}

function assertRootFailFull(obs) {
  assertObservationShape(obs);
  assert.equal(obs.statePresence, 'io-error');
  assert.equal(obs.stateStatus, null);
  assert.equal(obs.storesEmpty, false);
  assert.equal(obs.cursorMatch, 'skipped');
  assert.equal(obs.journalOutcome, 'skipped');
  assert.equal(obs.crossStoreOutcome, 'skipped');
  assert.equal(obs.relationship, null);
  assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
  assert.equal(obs.errorLayer, 'root');
}

async function snapshotTriple(root) {
  const snap = { state: null, journal: null, events: null };
  try {
    snap.state = await readFile(stateAbs(root));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    snap.journal = await readFile(journalAbs(root));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    snap.events = await readFile(eventsAbs(root));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return snap;
}

function assertSnapEqual(a, b) {
  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.journal, b.journal);
  assert.deepEqual(a.events, b.events);
}

async function ensureHealthyIdle(root) {
  const { appendAuditEventWithIntegrityDualWrite } = await loadCoordinator();
  await appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A });
}

function maskJsNonCode(source) {
  let out = '';
  let i = 0;
  const s = String(source);
  while (i < s.length) {
    if (s[i] === '/' && s[i + 1] === '/') {
      out += '  ';
      i += 2;
      while (i < s.length && s[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        out += s[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < s.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (s[i] === "'" || s[i] === '"' || s[i] === '`') {
      const q = s[i];
      out += ' ';
      i += 1;
      while (i < s.length) {
        if (s[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (s[i] === q) {
          out += ' ';
          i += 1;
          break;
        }
        out += s[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

function hasCallSite(source, name) {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
  return re.test(maskJsNonCode(source));
}

function extractFunctionBody(source, name) {
  const text = String(source);
  const masked = maskJsNonCode(text);
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(masked);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  let parenDepth = 0;
  for (; i < masked.length; i += 1) {
    if (masked[i] === '(') parenDepth += 1;
    else if (masked[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        i += 1;
        break;
      }
    }
  }
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  if (masked[i] !== '{') return null;
  const start = i;
  let brace = 0;
  for (; i < masked.length; i += 1) {
    if (masked[i] === '{') brace += 1;
    else if (masked[i] === '}') {
      brace -= 1;
      if (brace === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ── 1. export ──────────────────────────────────────────────────────────

describe('C1 read-only dual-write inspector', () => {
  it('1. export inspectAuditIntegrityDualWriteReadOnly is async function', async () => {
    const mod = await loadCoordinator();
    assert.equal(typeof mod.inspectAuditIntegrityDualWriteReadOnly, 'function');
    assert.equal(mod.inspectAuditIntegrityDualWriteReadOnly.constructor.name, 'AsyncFunction');
  });

  // V1.40 C2: inspect enqueues and briefly holds process-lock; audit stores stay absent.
  // Permanent canonical lock artifact audit/integrity-write.lock may exist (not an audit store).
  it('2. cold empty root → absent + storesEmpty true + relationship null (no audit store files)', async () => {
    await withTempRoot('cold-empty', async (root) => {
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'absent');
      assert.equal(obs.stateStatus, null);
      assert.equal(obs.storesEmpty, true);
      assert.equal(obs.relationship, null);
      assert.equal(obs.reasonCode, null);
      assertPathFreeObservation(obs, root);
      // Zero write for audit stores only — not a claim that the lock protocol file is absent.
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(journalAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(eventsAbs(root)), { code: 'ENOENT' });
    });
  });

  // V1.40 C2: sole cold-root FS artifact after successful queued inspect is the process-lock file.
  it('3. cold empty zero audit-store writes (only process-lock protocol artifact under audit/)', async () => {
    await withTempRoot('cold-zw', async (root) => {
      const before = await readdir(root);
      assert.deepEqual(before, []);
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      await inspectAuditIntegrityDualWriteReadOnly(root);
      const after = await readdir(root);
      assert.deepEqual(after.slice().sort(), ['audit']);
      const auditEntries = await readdir(join(root, 'audit'));
      assert.deepEqual(auditEntries.slice().sort(), ['integrity-write.lock']);
      const lockAbs = join(root, 'audit', 'integrity-write.lock');
      const st = await lstat(lockAbs);
      assert.equal(st.isFile(), true);
      assert.equal(typeof st.isSymbolicLink === 'function' ? st.isSymbolicLink() : false, false);
      assert.equal(st.nlink, 1);
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(st.size, 0);
      // Audit/business stores remain absent (inspector zero-write for those paths).
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(journalAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(eventsAbs(root)), { code: 'ENOENT' });
    });
  });

  it('4. #2a state missing + stores nonempty + receipt ok → relationship exact enum; reasonCode null', async () => {
    await withTempRoot('s-missing-ok', async (root) => {
      const { initializeAuditIntegrityJournal, appendAuditIntegrityEvent } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(eventsAbs(root), eventLine(EVENT_A), { mode: 0o600 });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });

      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const before = await snapshotTriple(root);
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'absent');
      assert.equal(obs.storesEmpty, false);
      assert.equal(obs.relationship, 'equal');
      assert.equal(obs.reasonCode, null);
      assert.equal(obs.crossStoreOutcome, 'ok');
      assertSnapEqual(await snapshotTriple(root), before);
    });
  });

  it('5. legal idle via production append → idle/verified + relationship in allowed set', async () => {
    await withTempRoot('idle-healthy', async (root) => {
      await ensureHealthyIdle(root);
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.stateStatus, 'idle');
      assert.equal(obs.cursorMatch, 'match');
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'ok');
      assert.ok(ALLOWED_HEALTHY_REL.has(obs.relationship), `rel=${obs.relationship}`);
      assert.equal(obs.reasonCode, null);
      assert.equal(obs.errorLayer, 'none');
    });
  });

  it('6. idle raw fingerprint mismatch → cursor-mismatch; relationship null; stores unchanged', async () => {
    await withTempRoot('idle-fp-mm', async (root) => {
      await ensureHealthyIdle(root);
      const before = await snapshotTriple(root);
      await writeFile(eventsAbs(root), eventLine(EVENT_B), { mode: 0o600 });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.cursorMatch, 'mismatch');
      // raw fp mismatch: journal verified; cross-store not executed
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'skipped');
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(obs.relationship, null);
      assert.equal(obs.errorLayer, 'cursor');
      assert.equal(obs.storesEmpty, false);
      assert.deepEqual(await readFile(stateAbs(root)), before.state);
      assert.deepEqual(await readFile(journalAbs(root)), before.journal);
      assert.equal(await readFile(eventsAbs(root), 'utf8'), eventLine(EVENT_B));
    });
  });

  it('7. valid prepared fixture → prepared; relationship null; not recovered; bytes stable', async () => {
    await withTempRoot('prep-short', async (root) => {
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_CRASH_HOOK,
        inspectAuditIntegrityDualWriteReadOnly,
      } = await loadCoordinator();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        }),
      );
      const before = await snapshotTriple(root);
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'prepared');
      assert.equal(obs.stateStatus, 'prepared');
      assert.equal(obs.relationship, null);
      assert.equal(obs.reasonCode, null);
      assert.equal(obs.cursorMatch, 'skipped');
      assert.equal(obs.journalOutcome, 'skipped');
      assert.equal(obs.crossStoreOutcome, 'skipped');
      assertSnapEqual(await snapshotTriple(root), before);
      const stateText = await readFile(stateAbs(root), 'utf8');
      assert.ok(stateText.includes('"status":"prepared"') || stateText.includes('"status": "prepared"'));
    });
  });

  it('8. prepared second inspect stable; relationship remains null', async () => {
    await withTempRoot('prep-2x', async (root) => {
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_CRASH_HOOK,
        inspectAuditIntegrityDualWriteReadOnly,
      } = await loadCoordinator();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        }),
      );
      const a = await inspectAuditIntegrityDualWriteReadOnly(root);
      const b = await inspectAuditIntegrityDualWriteReadOnly(root);
      assert.equal(a.statePresence, 'prepared');
      assert.equal(b.statePresence, 'prepared');
      assert.equal(a.relationship, null);
      assert.equal(b.relationship, null);
      assert.deepEqual(a, b);
    });
  });

  it('9. invalid state JSON → invalid; reason state-invalid; relationship null; bytes unchanged', async () => {
    await withTempRoot('state-bad-json', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), '{not-json\n', { mode: 0o600 });
      const before = await readFile(stateAbs(root));
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'invalid');
      assert.equal(obs.stateStatus, null);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
      assert.equal(obs.relationship, null);
      assert.equal(obs.errorLayer, 'state');
      assert.deepEqual(await readFile(stateAbs(root)), before);
    });
  });

  it('10. #7 Sio full fields — state symlink', async () => {
    await withTempRoot('sio-symlink', async (root) => {
      const outside = await mkdtempSafe('sio-sym-out');
      try {
        const target = join(outside, 'target.json');
        await writeFile(target, '{"x":1}\n', { mode: 0o600 });
        await mkdir(join(root, 'audit'), { recursive: true });
        await symlink(target, stateAbs(root));
        const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
        const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
        assertSioFull(obs);
        assertPathFreeObservation(obs, root);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('11. #7 Sio full fields — state directory', async () => {
    await withTempRoot('sio-dir', async (root) => {
      await mkdir(stateAbs(root), { recursive: true });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertSioFull(obs);
    });
  });

  it('12. #7 Sio full fields — state oversize', async () => {
    await withTempRoot('sio-oversize', async (root) => {
      const { AUDIT_DUAL_WRITE_STATE_MAX_BYTES } = await loadState();
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), 'x'.repeat(AUDIT_DUAL_WRITE_STATE_MAX_BYTES + 8), {
        mode: 0o600,
      });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertSioFull(obs);
    });
  });

  it('13. journal chain-broken fixture → journalOutcome typed-error; reason ≠ cursor-mismatch; relationship null', async () => {
    await withTempRoot('j-chain', async (root) => {
      await ensureHealthyIdle(root);
      const raw = await readFile(journalAbs(root), 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      assert.ok(lines.length >= 1);
      const obj = JSON.parse(lines[0]);
      const flipped = obj.linkDigest.replace(/[0-9a-f]/, (c) => (c === 'a' ? 'b' : 'a'));
      obj.linkDigest = flipped;
      lines[0] = JSON.stringify(obj);
      await writeFile(journalAbs(root), `${lines.join('\n')}\n`, { mode: 0o600 });

      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.journalOutcome, 'typed-error');
      assert.equal(obs.relationship, null);
      assert.notEqual(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_CHAIN_BROKEN);
      assert.equal(obs.errorLayer, 'journal');
    });
  });

  it('14. cross-store broken → crossStoreOutcome typed-error; reason cross-store-broken; ≠ cursor-mismatch', async () => {
    await withTempRoot('cs-broken', async (root) => {
      await ensureHealthyIdle(root);
      // Keep raw events fingerprint matching state by republishing idle after swap?
      // For pure broken with idle: swap events to EVENT_B and fix state events fp so raw matches,
      // then cross-store digests break — covered also by canary 31. Here: after healthy,
      // replace events without updating state → may be cursor-mismatch first.
      // Construct via journal+events mismatched digests with matching state cursor:
      const stateMod = await loadState();
      const journalBefore = await readFile(journalAbs(root));
      const eventsText = eventLine(EVENT_B);
      await writeFile(eventsAbs(root), eventsText, { mode: 0o600 });
      const idleRaw = JSON.parse(await readFile(stateAbs(root), 'utf8'));
      const eventsFp = {
        present: true,
        byteLength: Buffer.byteLength(eventsText, 'utf8'),
        sha256: createHash('sha256').update(eventsText).digest('hex'),
        strictRecordCount: 1,
      };
      const fixed = {
        schemaVersion: 1,
        status: 'idle',
        generationId: idleRaw.generationId,
        journal: { ...idleRaw.journal },
        events: eventsFp,
        lastTransactionId: null,
        lastPayloadDigest: null,
        lastSequence: null,
      };
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, fixed);
      });
      // journal still EVENT_A link; events EVENT_B → broken if digests differ
      assert.deepEqual(await readFile(journalAbs(root)), journalBefore);

      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'typed-error');
      assert.equal(obs.cursorMatch, 'skipped');
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
      assert.notEqual(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(obs.relationship, null);
      assert.equal(obs.errorLayer, 'cross-store');
    });
  });

  it('15. inspect path source has no recover/bootstrap/publish call sites inside inspector', async () => {
    const src = await readFile(DUAL_WRITE_SRC, 'utf8');
    // Explicit inspector read-only call-graph region (not public body alone).
    const regionNames = [
      'inspectAuditIntegrityDualWriteReadOnly',
      'observeAuditIntegrityDualWriteReadOnlyUnlocked',
      'observeStateAbsentReadOnly',
      'observeStateIdleReadOnly',
      'measureIdleCursorAgainstStoresGranularUnlocked',
      'freezeReadOnlyObservation',
      'freezeIoObservation',
      'observationFromJournalTypedError',
    ];
    let region = '';
    for (const name of regionNames) {
      const body = extractFunctionBody(src, name);
      if (body) region += `\n${body}`;
    }
    assert.ok(region.length > 0, 'inspector call-graph region must be non-empty');
    const forbidden = [
      'recoverPreparedUnlocked',
      'bootstrapDualWriteIdleUnlocked',
      'publishDualWriteStateUnlocked',
      'recoverAuditIntegrityDualWrite',
      'planAuditIntegrityEventLinkUnlocked',
      'publishPlannedAuditIntegrityEventLinkAtomicUnlocked',
      'safeAtomicWriteBytes',
      'safeAppendText',
      'safeCreateExclusive',
      'validateIdleCursorAgainstStoresUnlocked',
    ];
    for (const name of forbidden) {
      assert.equal(hasCallSite(region, name), false, `inspect path must not call ${name}`);
    }
    // Hostile canary: comment/string must not create false positives; real call-site must detect.
    const hostile = [
      '// publishDualWriteStateUnlocked(root, lease, state)',
      'const s = "recoverAuditIntegrityDualWrite(root)";',
      '/* safeAtomicWriteBytes(x) */',
      '  bootstrapDualWriteIdleUnlocked(resolvedRoot, lease);',
    ].join('\n');
    assert.equal(hasCallSite(hostile, 'publishDualWriteStateUnlocked'), false, 'comment false-positive');
    assert.equal(hasCallSite(hostile, 'recoverAuditIntegrityDualWrite'), false, 'string false-positive');
    assert.equal(hasCallSite(hostile, 'safeAtomicWriteBytes'), false, 'block-comment false-positive');
    assert.equal(hasCallSite(hostile, 'bootstrapDualWriteIdleUnlocked'), true, 'real call-site must match');
  });

  it('16. active writer: inspect waits and observes stable post', async () => {
    await withTempRoot('active-writer', async (root) => {
      await ensureHealthyIdle(root);
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const resolved = await assertSafeDataRoot(root);

      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      let writerEntered = false;
      const writer = enqueueAuditIntegrityWriteTask(resolved, async () => {
        writerEntered = true;
        await gate;
      });

      // Wait until writer holds the queue
      while (!writerEntered) {
        await new Promise((r) => setTimeout(r, 5));
      }

      let inspectDone = false;
      const inspectP = inspectAuditIntegrityDualWriteReadOnly(root).then((obs) => {
        inspectDone = true;
        return obs;
      });

      await new Promise((r) => setTimeout(r, 30));
      assert.equal(inspectDone, false, 'inspect must wait behind active writer');
      release();
      await writer;
      const obs = await inspectP;
      assert.equal(obs.statePresence, 'idle');
      assert.ok(ALLOWED_HEALTHY_REL.has(obs.relationship));
    });
  });

  it('17. inspect does not nested-enqueue (same-root nested rejected if attempted)', async () => {
    await withTempRoot('no-nested', async (root) => {
      await ensureHealthyIdle(root);
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const resolved = await assertSafeDataRoot(root);

      // Holding outer lease, call inspect — must not deadlock via nested enqueue.
      // Contract: nested enqueue fails closed; inspect itself only enqueues at top level.
      await assert.rejects(
        () => enqueueAuditIntegrityWriteTask(resolved, async () => {
          await inspectAuditIntegrityDualWriteReadOnly(root);
        }),
      );
      // Top-level inspect still works after failed nested attempt
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assert.equal(obs.statePresence, 'idle');
    });
  });

  it('18. hostile options Proxy: get/getOwnPropertyDescriptor/ownKeys traps never run', async () => {
    await withTempRoot('hostile-opts', async (root) => {
      await ensureHealthyIdle(root);
      const traps = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0, has: 0, set: 0 };
      const options = new Proxy({}, {
        get(_t, p) {
          traps.get += 1;
          throw new Error(`get trap fired: ${String(p)}`);
        },
        getOwnPropertyDescriptor() {
          traps.getOwnPropertyDescriptor += 1;
          throw new Error('gopd trap');
        },
        ownKeys() {
          traps.ownKeys += 1;
          throw new Error('ownKeys trap');
        },
        has() {
          traps.has += 1;
          throw new Error('has trap');
        },
        set() {
          traps.set += 1;
          throw new Error('set trap');
        },
      });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root, options);
      assert.equal(obs.statePresence, 'idle');
      assert.deepEqual(traps, { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0, has: 0, set: 0 });
    });
  });

  it('19. observation is deep frozen', async () => {
    await withTempRoot('frozen', async (root) => {
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assert.ok(Object.isFrozen(obs));
      assert.throws(() => {
        obs.statePresence = 'idle';
      });
      assert.throws(() => {
        obs.extra = 1;
      });
    });
  });

  // V1.40: registry pin 61→62 (unique +1 process-lock); membership SoT unchanged.
  it('20. reasonCode membership SoT: non-null codes are registered; ERROR_CODES closed-set 62', async () => {
    assert.equal(Object.keys(ERROR_CODES).length, 62);
    await withTempRoot('reason-member', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), '{bad\n', { mode: 0o600 });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assert.notEqual(obs.reasonCode, null);
      assertRegisteredErrorCode(obs.reasonCode);
      assert.ok(Object.values(ERROR_CODES).includes(obs.reasonCode));
    });
  });

  it('21. different roots parallel inspect without crosstalk', async () => {
    await withTempRoot('p-a', async (rootA) => {
      await withTempRoot('p-b', async (rootB) => {
        await ensureHealthyIdle(rootA);
        // rootB cold empty
        const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
        const [a, b] = await Promise.all([
          inspectAuditIntegrityDualWriteReadOnly(rootA),
          inspectAuditIntegrityDualWriteReadOnly(rootB),
        ]);
        assert.equal(a.statePresence, 'idle');
        assert.ok(ALLOWED_HEALTHY_REL.has(a.relationship));
        assert.equal(b.statePresence, 'absent');
        assert.equal(b.storesEmpty, true);
        assert.equal(b.relationship, null);
      });
    });
  });

  it('22. path-free observation; no absolute path fields', async () => {
    await withTempRoot('path-free', async (root) => {
      await ensureHealthyIdle(root);
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertPathFreeObservation(obs, root);
    });
  });

  it('23. #11 idle + journal missing/NOT_INITIALIZED → not-initialized; relationship null; not cold uninit', async () => {
    await withTempRoot('idle-j-missing', async (root) => {
      await ensureHealthyIdle(root);
      await rm(journalAbs(root), { force: true });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.stateStatus, 'idle');
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED);
      assert.equal(obs.relationship, null);
      assert.equal(obs.journalOutcome, 'missing');
      assert.notEqual(obs.statePresence, 'absent');
    });
  });

  it('24. #12 idle + empty relationship → fail-closed; storesEmpty false (not cold empty); reasonCode null', async () => {
    await withTempRoot('idle-empty', async (root) => {
      const { recoverAuditIntegrityDualWrite, inspectAuditIntegrityDualWriteReadOnly } =
        await loadCoordinator();
      await recoverAuditIntegrityDualWrite(root);
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.stateStatus, 'idle');
      assert.equal(obs.cursorMatch, 'match');
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'ok');
      assert.equal(obs.relationship, 'empty');
      assert.equal(obs.reasonCode, null);
      // SoT: storesEmpty only for journal missing/not-init ∧ events empty.
      // #12 is relationship-empty attention with initialized+verified journal → false.
      assert.equal(obs.storesEmpty, false);
      assert.ok(!ALLOWED_HEALTHY_REL.has(obs.relationship));

      // Canary vs cold #1: cold absent empty → storesEmpty true; initialized idle empty → false.
      await withTempRoot('idle-empty-vs-cold', async (coldRoot) => {
        const cold = await inspectAuditIntegrityDualWriteReadOnly(coldRoot);
        assert.equal(cold.statePresence, 'absent');
        assert.equal(cold.storesEmpty, true);
        assert.equal(cold.relationship, null);
        assert.notEqual(cold.storesEmpty, obs.storesEmpty);
      });
    });
  });

  it('25. #13 idle + uncovered-events → fail-closed; reasonCode null fixed (≠ broken)', async () => {
    await withTempRoot('idle-uncovered', async (root) => {
      const { recoverAuditIntegrityDualWrite, inspectAuditIntegrityDualWriteReadOnly } =
        await loadCoordinator();
      await recoverAuditIntegrityDualWrite(root);
      const stateMod = await loadState();
      const idleRaw = JSON.parse(await readFile(stateAbs(root), 'utf8'));
      const eventsText = eventLine(EVENT_A);
      await writeFile(eventsAbs(root), eventsText, { mode: 0o600 });
      const eventsFp = {
        present: true,
        byteLength: Buffer.byteLength(eventsText, 'utf8'),
        sha256: createHash('sha256').update(eventsText).digest('hex'),
        strictRecordCount: 1,
      };
      const fixed = {
        schemaVersion: 1,
        status: 'idle',
        generationId: idleRaw.generationId,
        journal: { ...idleRaw.journal },
        events: eventsFp,
        lastTransactionId: null,
        lastPayloadDigest: null,
        lastSequence: null,
      };
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, fixed);
      });

      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.relationship, 'uncovered-events');
      assert.equal(obs.reasonCode, null);
      assert.notEqual(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
      assert.equal(obs.cursorMatch, 'match');
      assert.equal(obs.crossStoreOutcome, 'ok');
    });
  });

  it('26. #7b RootFail full fields — nonexistent / invalid dataDir; no root create; zero enqueue writes', async () => {
    const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
    // nonexistent
    const missing = join(tmpdir(), `linke-adw-c1-missing-${Date.now()}-${Math.random()}`);
    const obs1 = await inspectAuditIntegrityDualWriteReadOnly(missing);
    assertRootFailFull(obs1);
    await assert.rejects(() => access(missing), { code: 'ENOENT' });

    // invalid type
    const obs2 = await inspectAuditIntegrityDualWriteReadOnly(/** @type {any} */ (null));
    assertRootFailFull(obs2);

    // non-directory
    await withTempRoot('root-file', async (root) => {
      const filePath = join(root, 'not-a-dir');
      await writeFile(filePath, 'x', { mode: 0o600 });
      const obs3 = await inspectAuditIntegrityDualWriteReadOnly(filePath);
      assertRootFailFull(obs3);
      const st = await lstat(filePath);
      assert.ok(st.isFile());
    });
  });

  it('27. journal typed IO exact fields → journalOutcome typed-error; cross/cursor skipped; errorLayer journal', async () => {
    await withTempRoot('typed-io-journal', async (root) => {
      await ensureHealthyIdle(root);
      // journal leaf as directory → journal IO before any cross-store probe
      await rm(journalAbs(root), { force: true });
      await mkdir(journalAbs(root));
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.stateStatus, 'idle');
      assert.equal(obs.storesEmpty, false);
      assert.equal(obs.cursorMatch, 'skipped');
      assert.equal(obs.journalOutcome, 'typed-error');
      assert.equal(obs.crossStoreOutcome, 'skipped');
      assert.equal(obs.relationship, null);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
      assert.equal(obs.errorLayer, 'journal');
      assert.notEqual(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
    });
  });

  it('28. #7 Sio full fields — other safe-read failure (FIFO non-regular)', async () => {
    await withTempRoot('sio-fifo', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('mkfifo', [stateAbs(root)], { encoding: 'utf8' });
      if (r.status !== 0) {
        // Fallback: directory already covered; use oversize-like non-file via mkdir again
        await mkdir(stateAbs(root), { recursive: true });
      }
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertSioFull(obs);
      // cleanup fifo so withTempRoot rm works
      await rm(stateAbs(root), { force: true, recursive: true });
    });
  });

  it('29. enqueue canary — valid resolved root: inspect completes under queue; zero writes on healthy', async () => {
    await withTempRoot('enq-once', async (root) => {
      await ensureHealthyIdle(root);
      const before = await snapshotTriple(root);
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assert.equal(obs.statePresence, 'idle');
      assertSnapEqual(await snapshotTriple(root), before);

      const src = await readFile(DUAL_WRITE_SRC, 'utf8');
      const body = extractFunctionBody(src, 'inspectAuditIntegrityDualWriteReadOnly');
      assert.ok(body);
      // exactly one enqueue call site in public inspector
      const re = /\benqueueAuditIntegrityWriteTask\s*\(/g;
      const matches = maskJsNonCode(body).match(re) || [];
      assert.equal(matches.length, 1);
    });
  });

  it('30. enqueue canary — RootFail: no root create; zero writes; #7b full fields', async () => {
    const missing = join(tmpdir(), `linke-adw-c1-rf-${Date.now()}-${Math.random()}`);
    const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
    const obs = await inspectAuditIntegrityDualWriteReadOnly(missing);
    assertRootFailFull(obs);
    await assert.rejects(() => access(missing), { code: 'ENOENT' });
  });

  it('31. canary P2-1: raw fp match + cross-store semantic broken → typed cross-store; never cursor-mismatch', async () => {
    await withTempRoot('canary-cs-typed', async (root) => {
      await ensureHealthyIdle(root);
      const stateMod = await loadState();
      const idleRaw = JSON.parse(await readFile(stateAbs(root), 'utf8'));
      const eventsText = eventLine(EVENT_B);
      await writeFile(eventsAbs(root), eventsText, { mode: 0o600 });
      const eventsFp = {
        present: true,
        byteLength: Buffer.byteLength(eventsText, 'utf8'),
        sha256: createHash('sha256').update(eventsText).digest('hex'),
        strictRecordCount: 1,
      };
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, {
          schemaVersion: 1,
          status: 'idle',
          generationId: idleRaw.generationId,
          journal: { ...idleRaw.journal },
          events: eventsFp,
          lastTransactionId: null,
          lastPayloadDigest: null,
          lastSequence: null,
        });
      });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
      assert.notEqual(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(obs.relationship, null);
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'typed-error');
      assert.equal(obs.cursorMatch, 'skipped');
      assert.equal(obs.errorLayer, 'cross-store');
    });
  });

  it('32. canary P2-1: true raw fingerprint field mismatch → cursor-mismatch; relationship null', async () => {
    await withTempRoot('canary-raw-fp', async (root) => {
      await ensureHealthyIdle(root);
      await writeFile(eventsAbs(root), eventLine(EVENT_B), { mode: 0o600 });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(obs.cursorMatch, 'mismatch');
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'skipped');
      assert.equal(obs.relationship, null);
      assert.equal(obs.errorLayer, 'cursor');
    });
  });

  it('33. #2b state-missing + typed error → relationship null; typed priority (not state-missing shape only)', async () => {
    await withTempRoot('s-miss-typed', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(journalAbs(root), '{broken-not-json\n', { mode: 0o600 });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'absent');
      assert.equal(obs.storesEmpty, false);
      assert.equal(obs.relationship, null);
      assert.notEqual(obs.reasonCode, null);
      assertRegisteredErrorCode(obs.reasonCode);
      // typed journal integrity, not a synthetic state-missing code
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_CHAIN_BROKEN);
      assert.equal(obs.journalOutcome, 'typed-error');
    });
  });

  it('34. production remapping preservation: validateIdleCursor still remaps cross-store to cursor-mismatch', async () => {
    await withTempRoot('prod-remap', async (root) => {
      await ensureHealthyIdle(root);
      const stateMod = await loadState();
      const idleRaw = JSON.parse(await readFile(stateAbs(root), 'utf8'));
      const eventsText = eventLine(EVENT_B);
      await writeFile(eventsAbs(root), eventsText, { mode: 0o600 });
      const eventsFp = {
        present: true,
        byteLength: Buffer.byteLength(eventsText, 'utf8'),
        sha256: createHash('sha256').update(eventsText).digest('hex'),
        strictRecordCount: 1,
      };
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, {
          schemaVersion: 1,
          status: 'idle',
          generationId: idleRaw.generationId,
          journal: { ...idleRaw.journal },
          events: eventsFp,
          lastTransactionId: null,
          lastPayloadDigest: null,
          lastSequence: null,
        });
      });
      // production recover path must still remap to cursor-mismatch (V1.37)
      const { recoverAuditIntegrityDualWrite } = await loadCoordinator();
      await assert.rejects(
        () => recoverAuditIntegrityDualWrite(root),
        (e) => {
          assert.equal(e.code, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
          return true;
        },
      );
      // inspector path remains precise typed
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
    });
  });

  it('35. prepared zero probe: prepared branch must not call granular/journal/cross-store/absent/idle probe', async () => {
    const src = await readFile(DUAL_WRITE_SRC, 'utf8');
    const observeBody = extractFunctionBody(src, 'observeAuditIntegrityDualWriteReadOnlyUnlocked');
    assert.ok(observeBody, 'observe helper body must exist');

    // Isolate prepared short-circuit return block via status === 'prepared' arm.
    const preparedIdx = observeBody.search(/status\s*===\s*['"]prepared['"]/);
    assert.ok(preparedIdx >= 0, 'prepared status check must exist in observe helper');
    // From prepared check to next top-level status/null branch (or end): must not probe.
    const afterPrepared = observeBody.slice(preparedIdx);
    const nextBranch = afterPrepared.search(
      /\n\s*if\s*\(\s*state\s*===\s*null|\n\s*if\s*\(\s*state\.status\s*===\s*['"]idle['"]/,
    );
    const preparedRegion = nextBranch >= 0 ? afterPrepared.slice(0, nextBranch) : afterPrepared;

    for (const name of [
      'measureIdleCursorAgainstStoresGranularUnlocked',
      'observeStateAbsentReadOnly',
      'observeStateIdleReadOnly',
      'inspectAuditIntegrityJournalFile',
      'verifyAuditIntegrityAgainstEventStore',
      'verifyCrossStoreBaseline',
      'measureJournalFingerprint',
      'readEventsBytes',
    ]) {
      assert.equal(
        hasCallSite(preparedRegion, name),
        false,
        `prepared short-circuit must not call ${name}`,
      );
    }

    // Runtime proof: prepared inspect does not change bytes; outcomes skipped.
    await withTempRoot('prep-zero-probe', async (root) => {
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_CRASH_HOOK,
        inspectAuditIntegrityDualWriteReadOnly,
      } = await loadCoordinator();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        }),
      );
      const before = await snapshotTriple(root);
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assert.equal(obs.statePresence, 'prepared');
      assert.equal(obs.relationship, null);
      assert.equal(obs.crossStoreOutcome, 'skipped');
      assert.equal(obs.journalOutcome, 'skipped');
      assert.equal(obs.cursorMatch, 'skipped');
      assertSnapEqual(await snapshotTriple(root), before);
    });
  });

  it('36. cursor-mismatch relationship lock: strictCount mismatch path → relationship null', async () => {
    await withTempRoot('strict-count-mm', async (root) => {
      await ensureHealthyIdle(root);
      const stateMod = await loadState();
      const idleRaw = JSON.parse(await readFile(stateAbs(root), 'utf8'));
      // Keep raw events fp fields equal but wrong strictRecordCount
      const bad = {
        schemaVersion: 1,
        status: 'idle',
        generationId: idleRaw.generationId,
        journal: { ...idleRaw.journal },
        events: {
          present: idleRaw.events.present,
          byteLength: idleRaw.events.byteLength,
          sha256: idleRaw.events.sha256,
          strictRecordCount: idleRaw.events.strictRecordCount + 5,
        },
        lastTransactionId: null,
        lastPayloadDigest: null,
        lastSequence: null,
      };
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, bad);
      });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(obs.cursorMatch, 'mismatch');
      // strict-count mismatch after receipt: journal verified + cross-store ok
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'ok');
      assert.equal(obs.relationship, null);
      assert.equal(obs.errorLayer, 'cursor');
    });
  });

  it('37. observation shape lock: no dualWriteState; statePresence enum; journalOutcome enum', async () => {
    await withTempRoot('shape-lock', async (root) => {
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const samples = [];
      samples.push(await inspectAuditIntegrityDualWriteReadOnly(root));
      await ensureHealthyIdle(root);
      samples.push(await inspectAuditIntegrityDualWriteReadOnly(root));
      for (const obs of samples) {
        assertObservationShape(obs);
        assert.equal('dualWriteState' in obs, false);
        assert.ok(STATE_PRESENCE.has(obs.statePresence));
        assert.ok(JOURNAL_OUT.has(obs.journalOutcome));
      }
    });
  });

  it('38. Sio vs RootFail errorLayer split: state vs root; remaining fields isomorphic', async () => {
    await withTempRoot('layer-split', async (root) => {
      await mkdir(stateAbs(root), { recursive: true });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const sio = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertSioFull(sio);

      const missing = join(tmpdir(), `linke-adw-c1-layer-${Date.now()}`);
      const rf = await inspectAuditIntegrityDualWriteReadOnly(missing);
      assertRootFailFull(rf);

      assert.equal(sio.errorLayer, 'state');
      assert.equal(rf.errorLayer, 'root');
      for (const k of OBS_KEYS) {
        if (k === 'errorLayer') continue;
        assert.equal(sio[k], rf[k], `field ${k} should match between Sio and RootFail`);
      }
    });
  });

  it('39. 50 concurrent inspects same root complete consistently', async () => {
    await withTempRoot('x50', async (root) => {
      await ensureHealthyIdle(root);
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const results = await Promise.all(
        Array.from({ length: 50 }, () => inspectAuditIntegrityDualWriteReadOnly(root)),
      );
      assert.equal(results.length, 50);
      for (const obs of results) {
        assert.equal(obs.statePresence, 'idle');
        assert.ok(ALLOWED_HEALTHY_REL.has(obs.relationship));
        assert.equal(obs.reasonCode, null);
      }
    });
  });

  // V1.40: registry 61→62 (unique +1 process-lock); cold path still does not init.
  it('40. cold uninitialized does not init; ERROR_CODES count remains 62', async () => {
    assert.equal(Object.keys(ERROR_CODES).length, 62);
    await withTempRoot('no-init', async (root) => {
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      await inspectAuditIntegrityDualWriteReadOnly(root);
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(journalAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(eventsAbs(root)), { code: 'ENOENT' });
    });
  });

  it('41. idle events-layer dual-write IO after journal verified → verified/skipped/skipped; errorLayer events', async () => {
    await withTempRoot('idle-events-io', async (root) => {
      await ensureHealthyIdle(root);
      // Replace events file with a directory → readEventsBytes dual-write IO after journal verified.
      await rm(eventsAbs(root), { force: true });
      await mkdir(eventsAbs(root));
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.stateStatus, 'idle');
      assert.equal(obs.storesEmpty, false);
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'skipped');
      assert.equal(obs.cursorMatch, 'skipped');
      assert.equal(obs.relationship, null);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
      assert.equal(obs.errorLayer, 'events');
      assert.notEqual(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
    });
  });

  it('42. idle cross-store typed after raw fp match → journal verified; cross typed-error; cursor skipped', async () => {
    await withTempRoot('idle-cs-cursor-skipped', async (root) => {
      await ensureHealthyIdle(root);
      const stateMod = await loadState();
      const idleRaw = JSON.parse(await readFile(stateAbs(root), 'utf8'));
      const eventsText = eventLine(EVENT_B);
      await writeFile(eventsAbs(root), eventsText, { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, {
          schemaVersion: 1,
          status: 'idle',
          generationId: idleRaw.generationId,
          journal: { ...idleRaw.journal },
          events: {
            present: true,
            byteLength: Buffer.byteLength(eventsText, 'utf8'),
            sha256: createHash('sha256').update(eventsText).digest('hex'),
            strictRecordCount: 1,
          },
          lastTransactionId: null,
          lastPayloadDigest: null,
          lastSequence: null,
        });
      });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'typed-error');
      assert.equal(obs.cursorMatch, 'skipped');
      assert.equal(obs.relationship, null);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
      assert.equal(obs.errorLayer, 'cross-store');
    });
  });

  it('43. state-absent journal verified + cross-store typed → keep journalOutcome; cursor n/a', async () => {
    await withTempRoot('absent-cs-typed', async (root) => {
      const { initializeAuditIntegrityJournal, appendAuditIntegrityEvent } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      // Events content digests will not match journal → cross-store broken; journal already verified.
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(eventsAbs(root), eventLine(EVENT_B), { mode: 0o600 });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });

      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'absent');
      assert.equal(obs.stateStatus, null);
      assert.equal(obs.storesEmpty, false);
      assert.equal(obs.cursorMatch, 'n/a');
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'typed-error');
      assert.equal(obs.relationship, null);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
      assert.equal(obs.errorLayer, 'cross-store');
    });
  });

  it('44. state-absent journal typed error → journal typed-error; cross skipped; cursor n/a', async () => {
    await withTempRoot('absent-j-typed', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(journalAbs(root), '{broken-not-json\n', { mode: 0o600 });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'absent');
      assert.equal(obs.storesEmpty, false);
      assert.equal(obs.cursorMatch, 'n/a');
      assert.equal(obs.journalOutcome, 'typed-error');
      assert.equal(obs.crossStoreOutcome, 'skipped');
      assert.equal(obs.relationship, null);
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_CHAIN_BROKEN);
      assert.equal(obs.errorLayer, 'journal');
    });
  });

  it('45. storesEmpty canary: cold absent true vs initialized idle empty false', async () => {
    const { recoverAuditIntegrityDualWrite, inspectAuditIntegrityDualWriteReadOnly } =
      await loadCoordinator();
    await withTempRoot('se-cold', async (coldRoot) => {
      const cold = await inspectAuditIntegrityDualWriteReadOnly(coldRoot);
      assert.equal(cold.statePresence, 'absent');
      assert.equal(cold.storesEmpty, true);
      assert.equal(cold.journalOutcome, 'missing');
      assert.equal(cold.relationship, null);

      await withTempRoot('se-idle-empty', async (idleRoot) => {
        await recoverAuditIntegrityDualWrite(idleRoot);
        const idle = await inspectAuditIntegrityDualWriteReadOnly(idleRoot);
        assert.equal(idle.statePresence, 'idle');
        assert.equal(idle.relationship, 'empty');
        assert.equal(idle.journalOutcome, 'verified');
        assert.equal(idle.storesEmpty, false);
        assert.notEqual(idle.storesEmpty, cold.storesEmpty);
      });
    });
  });

  it('46. raw fp mismatch vs strict-count mismatch stage canary (crossStoreOutcome skipped vs ok)', async () => {
    await withTempRoot('stage-raw', async (rawRoot) => {
      await ensureHealthyIdle(rawRoot);
      await writeFile(eventsAbs(rawRoot), eventLine(EVENT_B), { mode: 0o600 });
      const { inspectAuditIntegrityDualWriteReadOnly } = await loadCoordinator();
      const rawObs = await inspectAuditIntegrityDualWriteReadOnly(rawRoot);
      assert.equal(rawObs.cursorMatch, 'mismatch');
      assert.equal(rawObs.journalOutcome, 'verified');
      assert.equal(rawObs.crossStoreOutcome, 'skipped');
      assert.equal(rawObs.relationship, null);

      await withTempRoot('stage-strict', async (strictRoot) => {
        await ensureHealthyIdle(strictRoot);
        const stateMod = await loadState();
        const idleRaw = JSON.parse(await readFile(stateAbs(strictRoot), 'utf8'));
        await withLease(strictRoot, async (resolvedRoot, lease) => {
          await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, {
            schemaVersion: 1,
            status: 'idle',
            generationId: idleRaw.generationId,
            journal: { ...idleRaw.journal },
            events: {
              present: idleRaw.events.present,
              byteLength: idleRaw.events.byteLength,
              sha256: idleRaw.events.sha256,
              strictRecordCount: idleRaw.events.strictRecordCount + 3,
            },
            lastTransactionId: null,
            lastPayloadDigest: null,
            lastSequence: null,
          });
        });
        const strictObs = await inspectAuditIntegrityDualWriteReadOnly(strictRoot);
        assert.equal(strictObs.cursorMatch, 'mismatch');
        assert.equal(strictObs.journalOutcome, 'verified');
        assert.equal(strictObs.crossStoreOutcome, 'ok');
        assert.equal(strictObs.relationship, null);
        assert.notEqual(rawObs.crossStoreOutcome, strictObs.crossStoreOutcome);
      });
    });
  });

  it('47. source lock: granular wraps only UTF-8+verifyCrossStore in IdleCursorCrossStoreProbeError', async () => {
    const src = await readFile(DUAL_WRITE_SRC, 'utf8');
    // Sentinel class is module-private (not exported).
    assert.match(src, /class\s+IdleCursorCrossStoreProbeError\s+extends\s+Error/);
    assert.equal(
      /export\s+(?:class|\{[^}]*IdleCursorCrossStoreProbeError)/.test(src),
      false,
      'IdleCursorCrossStoreProbeError must not be exported',
    );

    const granular = extractFunctionBody(src, 'measureIdleCursorAgainstStoresGranularUnlocked');
    assert.ok(granular, 'granular helper body must exist');
    const masked = maskJsNonCode(granular);

    // First journal measure is a direct await — not inside the cross-store-stage wrap try.
    const measureIdx = masked.search(
      /await\s+measureJournalFingerprint\s*\(\s*resolvedRoot\s*\)/,
    );
    assert.ok(measureIdx >= 0, 'first measureJournalFingerprint call must exist');

    // Cross-store stage try must contain both assertEventsUtf8Baseline and verifyCrossStoreBaseline.
    const wrapThrowIdx = masked.search(
      /throw\s+new\s+IdleCursorCrossStoreProbeError\s*\(/,
    );
    assert.ok(wrapThrowIdx >= 0, 'must wrap stage errors as IdleCursorCrossStoreProbeError');

    // Find the try that owns the wrap throw: walk backward to nearest "try {".
    const beforeWrap = masked.slice(0, wrapThrowIdx);
    const tryIdx = beforeWrap.lastIndexOf('try');
    assert.ok(tryIdx >= 0, 'wrap throw must sit inside a try/catch');
    // measureJournalFingerprint must appear BEFORE that try (unwrapped first probe).
    assert.ok(
      measureIdx < tryIdx,
      'first measureJournalFingerprint must be outside cross-store-stage try',
    );

    const stageTryRegion = masked.slice(tryIdx, wrapThrowIdx + 80);
    assert.equal(
      hasCallSite(stageTryRegion, 'assertEventsUtf8Baseline'),
      true,
      'stage try must call assertEventsUtf8Baseline',
    );
    assert.equal(
      hasCallSite(stageTryRegion, 'verifyCrossStoreBaseline'),
      true,
      'stage try must call verifyCrossStoreBaseline',
    );
    // readEventsBytes stays outside the wrap (dual-write IO unwrapped).
    assert.equal(
      hasCallSite(stageTryRegion, 'readEventsBytes'),
      false,
      'readEventsBytes must not be inside cross-store-stage wrap',
    );
    assert.equal(
      hasCallSite(stageTryRegion, 'measureJournalFingerprint'),
      false,
      'first measureJournalFingerprint must not be inside cross-store-stage wrap',
    );
  });

  it('48. source lock: production catch-all remaps IdleCursorCrossStoreProbeError → cursor-mismatch', async () => {
    const src = await readFile(DUAL_WRITE_SRC, 'utf8');
    const prod = extractFunctionBody(src, 'validateIdleCursorAgainstStoresUnlocked');
    assert.ok(prod, 'production validateIdleCursor body must exist');
    const masked = maskJsNonCode(prod);

    // Catch-all on the stage wrapper only — no underlying-type guessing.
    assert.match(
      masked,
      /error\s+instanceof\s+IdleCursorCrossStoreProbeError/,
      'production must catch IdleCursorCrossStoreProbeError',
    );
    assert.equal(
      hasCallSite(masked, 'throwCursorMismatch'),
      true,
      'production must call throwCursorMismatch',
    );

    // After wrapper match, must throwCursorMismatch — not rethrow underlying typed errors.
    const wrapperIdx = masked.search(/instanceof\s+IdleCursorCrossStoreProbeError/);
    assert.ok(wrapperIdx >= 0);
    const afterWrapper = masked.slice(wrapperIdx, wrapperIdx + 220);
    assert.match(afterWrapper, /throwCursorMismatch\s*\(\s*\)/, 'wrapper arm must remap');
    // Must not leave-through JournalError / CrossStoreError inside the wrapper arm.
    assert.equal(
      /instanceof\s+AuditIntegrityJournalError/.test(afterWrapper),
      false,
      'wrapper arm must not branch on JournalError',
    );
    assert.equal(
      /instanceof\s+AuditIntegrityCrossStoreError/.test(afterWrapper),
      false,
      'wrapper arm must not re-classify CrossStoreError',
    );

    // Production must NOT selectively remap only CrossStoreError (old regression).
    // Cross-store stage JournalError must ride the wrapper catch-all.
    const catchAllOnly = !/instanceof\s+AuditIntegrityCrossStoreError/.test(masked)
      || /IdleCursorCrossStoreProbeError/.test(masked);
    // Stronger: production catch body remaps solely via wrapper.
    assert.equal(
      /instanceof\s+AuditIntegrityCrossStoreError/.test(masked),
      false,
      'production must not selectively catch CrossStoreError (use wrapper catch-all)',
    );
    assert.equal(
      /AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT/.test(masked),
      false,
      'production must not selectively catch recovery-conflict (wrapper covers it)',
    );
    assert.ok(catchAllOnly);
  });

  it('49. source lock: inspector unwraps wrapper JournalError to precise journal reason', async () => {
    const src = await readFile(DUAL_WRITE_SRC, 'utf8');
    // Use raw body for string-literal field checks (maskJsNonCode blanks quotes).
    const idleObs = extractFunctionBody(src, 'observeStateIdleReadOnly');
    assert.ok(idleObs, 'observeStateIdleReadOnly body must exist');
    // Code-token checks still use masked source to avoid comment/string false positives.
    const masked = maskJsNonCode(idleObs);
    assert.match(masked, /instanceof\s+IdleCursorCrossStoreProbeError/);
    assert.match(masked, /\.underlying\b/);

    const wrapperIdx = idleObs.search(/instanceof\s+IdleCursorCrossStoreProbeError/);
    assert.ok(wrapperIdx >= 0);
    const unwrapRegion = idleObs.slice(wrapperIdx, wrapperIdx + 1800);

    // Underlying JournalError → journal layer + typed-error/missing (not cursor-mismatch).
    assert.match(
      unwrapRegion,
      /underlying\s+instanceof\s+AuditIntegrityJournalError/,
      'unwrap must classify underlying JournalError',
    );
    assert.match(unwrapRegion, /errorLayer:\s*['"]journal['"]/);
    assert.match(unwrapRegion, /crossStoreOutcome:\s*['"]skipped['"]/);
    assert.match(unwrapRegion, /cursorMatch:\s*['"]skipped['"]/);
    // Must not set reasonCode to cursor-mismatch inside journal unwrap arm.
    const journalArmIdx = unwrapRegion.search(/underlying\s+instanceof\s+AuditIntegrityJournalError/);
    assert.ok(journalArmIdx >= 0);
    const journalArmEndRel = unwrapRegion.slice(journalArmIdx + 1).search(
      /\n\s*if\s*\(\s*underlying\s+instanceof/,
    );
    const journalArm = journalArmEndRel >= 0
      ? unwrapRegion.slice(journalArmIdx, journalArmIdx + 1 + journalArmEndRel)
      : unwrapRegion.slice(journalArmIdx, journalArmIdx + 900);
    assert.equal(
      /CURSOR_MISMATCH/.test(journalArm),
      false,
      'journal unwrap arm must not use cursor-mismatch reason',
    );
    assert.match(journalArm, /errorLayer:\s*['"]journal['"]/);

    // Underlying CrossStoreError → cross-store typed-error.
    assert.match(
      unwrapRegion,
      /underlying\s+instanceof\s+AuditIntegrityCrossStoreError/,
    );
    assert.match(unwrapRegion, /errorLayer:\s*['"]cross-store['"]/);
    assert.match(unwrapRegion, /crossStoreOutcome:\s*['"]typed-error['"]/);

    // recovery-conflict underlying → layer cross-store, cross skipped.
    assert.match(unwrapRegion, /AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT/);
  });

  it('50. runtime canary: production remaps cross-store stage → cursor-mismatch; inspector keeps precise typed', async () => {
    // Same fixture: raw fp match + semantic cross-store broken.
    // Production recover → cursor-mismatch (V1.37 catch-all via wrapper).
    // Inspector → precise CROSS_STORE_BROKEN (unwrap), never cursor-mismatch.
    await withTempRoot('cs-stage-prod-insp', async (root) => {
      await ensureHealthyIdle(root);
      const stateMod = await loadState();
      const idleRaw = JSON.parse(await readFile(stateAbs(root), 'utf8'));
      const eventsText = eventLine(EVENT_B);
      await writeFile(eventsAbs(root), eventsText, { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, {
          schemaVersion: 1,
          status: 'idle',
          generationId: idleRaw.generationId,
          journal: { ...idleRaw.journal },
          events: {
            present: true,
            byteLength: Buffer.byteLength(eventsText, 'utf8'),
            sha256: createHash('sha256').update(eventsText).digest('hex'),
            strictRecordCount: 1,
          },
          lastTransactionId: null,
          lastPayloadDigest: null,
          lastSequence: null,
        });
      });

      const {
        recoverAuditIntegrityDualWrite,
        inspectAuditIntegrityDualWriteReadOnly,
      } = await loadCoordinator();

      await assert.rejects(
        () => recoverAuditIntegrityDualWrite(root),
        (e) => {
          assert.equal(e.name, 'AuditIntegrityDualWriteError');
          assert.equal(e.code, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
          return true;
        },
      );

      const obs = await inspectAuditIntegrityDualWriteReadOnly(root);
      assertObservationShape(obs);
      assert.equal(obs.statePresence, 'idle');
      assert.equal(obs.journalOutcome, 'verified');
      assert.equal(obs.crossStoreOutcome, 'typed-error');
      assert.equal(obs.cursorMatch, 'skipped');
      assert.equal(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
      assert.equal(obs.errorLayer, 'cross-store');
      assert.notEqual(obs.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assertPathFreeObservation(obs, root);
    });
  });

  it('51. source lock: cross-store-stage JournalError rides wrapper catch-all (prod) + journal unwrap (insp)', async () => {
    // Cannot stably manufacture mid-call journal race without a production hook.
    // Lock the contract structurally: any error from verifyCrossStoreBaseline (which
    // rethrows AuditIntegrityJournalError on second inspect) is wrapped; production
    // remaps the whole wrapper; inspector unwraps JournalError to journal layer.
    const src = await readFile(DUAL_WRITE_SRC, 'utf8');

    const granular = extractFunctionBody(src, 'measureIdleCursorAgainstStoresGranularUnlocked');
    assert.ok(granular);
    const gMasked = maskJsNonCode(granular);
    // Catch arm of stage try must construct IdleCursorCrossStoreProbeError unconditionally
    // (no filter that lets JournalError escape unwrapped).
    assert.match(
      gMasked,
      /catch\s*\(\s*\w+\s*\)\s*\{[^}]*new\s+IdleCursorCrossStoreProbeError/,
    );
    // No rethrow of unwrapped JournalError inside that catch before wrap.
    const catchIdx = gMasked.search(/catch\s*\(\s*\w+\s*\)\s*\{/);
    assert.ok(catchIdx >= 0);
    // Use last catch near IdleCursorCrossStoreProbeError construction.
    const wrapCatchIdx = gMasked.search(
      /catch\s*\([^)]*\)\s*\{[\s\S]*?IdleCursorCrossStoreProbeError/,
    );
    assert.ok(wrapCatchIdx >= 0, 'stage catch must wrap as IdleCursorCrossStoreProbeError');
    const stageCatch = gMasked.slice(wrapCatchIdx, wrapCatchIdx + 280);
    // May rethrow if already wrapper; must not `throw error` for JournalError without wrap.
    assert.match(stageCatch, /new\s+IdleCursorCrossStoreProbeError\s*\(/);
    assert.equal(
      /instanceof\s+AuditIntegrityJournalError[\s\S]{0,80}throw\s+\w+/.test(stageCatch),
      false,
      'stage catch must not leave-through JournalError unwrapped',
    );

    const prod = extractFunctionBody(src, 'validateIdleCursorAgainstStoresUnlocked');
    assert.ok(prod);
    const pMasked = maskJsNonCode(prod);
    // Production: wrapper → cursor-mismatch only (covers underlying JournalError).
    assert.match(
      pMasked,
      /instanceof\s+IdleCursorCrossStoreProbeError[\s\S]{0,120}throwCursorMismatch\s*\(\s*\)/,
    );

    const idleObs = extractFunctionBody(src, 'observeStateIdleReadOnly');
    assert.ok(idleObs);
    // Explicit journal unwrap arm (second probe race): precise journal reason, not cursor-mismatch.
    const jIdx = idleObs.search(/underlying\s+instanceof\s+AuditIntegrityJournalError/);
    assert.ok(jIdx >= 0, 'inspector must unwrap underlying JournalError');
    // Arm ends at next sibling branch or closing of wrapper block.
    const jArmEndRel = idleObs.slice(jIdx + 1).search(
      /\n\s*if\s*\(\s*underlying\s+instanceof|\n\s*\/\/ Unexpected under cross-store/,
    );
    const jArm = jArmEndRel >= 0
      ? idleObs.slice(jIdx, jIdx + 1 + jArmEndRel)
      : idleObs.slice(jIdx, jIdx + 900);
    assert.match(jArm, /errorLayer:\s*['"]journal['"]/);
    assert.match(jArm, /reasonCode:\s*underlying\.code/);
    assert.match(jArm, /crossStoreOutcome:\s*['"]skipped['"]/);
    assert.match(jArm, /cursorMatch:\s*['"]skipped['"]/);
    assert.equal(/CURSOR_MISMATCH/.test(jArm), false);
  });

  it('52. source lock: state-absent cross-store JournalError maps to journal typed (not dual-write IO/state)', async () => {
    const src = await readFile(DUAL_WRITE_SRC, 'utf8');
    const absent = extractFunctionBody(src, 'observeStateAbsentReadOnly');
    assert.ok(absent, 'observeStateAbsentReadOnly body must exist');
    const masked = maskJsNonCode(absent);

    // The verifyAuditIntegrityAgainstEventStore catch must handle JournalError
    // before the generic dual-write IO / errorLayer state fallback.
    const verifyIdx = masked.search(/verifyAuditIntegrityAgainstEventStore/);
    assert.ok(verifyIdx >= 0, 'absent path must call verifyAuditIntegrityAgainstEventStore');
    const afterVerify = masked.slice(verifyIdx);

    const journalErrIdx = afterVerify.search(/instanceof\s+AuditIntegrityJournalError/);
    assert.ok(
      journalErrIdx >= 0,
      'absent cross-store catch must handle AuditIntegrityJournalError',
    );
    const crossErrIdx = afterVerify.search(/instanceof\s+AuditIntegrityCrossStoreError/);
    assert.ok(crossErrIdx >= 0, 'absent cross-store catch must handle CrossStoreError');
    assert.ok(
      journalErrIdx < crossErrIdx,
      'JournalError branch must precede CrossStoreError branch',
    );

    // JournalError arm must set errorLayer journal (via helper or inline) — not state.
    const journalArm = afterVerify.slice(journalErrIdx, journalErrIdx + 350);
    const usesHelper = /observationFromJournalTypedError\s*\(/.test(journalArm);
    const inlineJournal = /errorLayer:\s*['"]journal['"]/.test(journalArm);
    assert.ok(
      usesHelper || inlineJournal,
      'JournalError arm must map to journal layer (helper or inline)',
    );
    assert.equal(
      /errorLayer:\s*['"]state['"]/.test(journalArm),
      false,
      'JournalError arm must not use errorLayer state',
    );
    assert.equal(
      /DUAL_WRITE_IO_ERROR/.test(journalArm),
      false,
      'JournalError arm must not fall through to dual-write IO reason',
    );
  });
});
