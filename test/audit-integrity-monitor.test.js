/**
 * V1.38 C2: audit integrity run-once monitor report contract
 * runAuditIntegrityMonitor / exit / format
 *
 * Tests use mkdtemp(tmpdir()) only — never write into the repo.
 * Public surface only; no observation-injection Symbol; no package-lock edits.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
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
import { ERROR_CODES } from '../src/error-codes.js';
import { stringifyStrictCanonicalSanitizedEvent } from '../src/audit-event-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const MONITOR_SRC = join(REPO_ROOT, 'src/audit-integrity-monitor.js');

const GENERATION_ID = '0123456789abcdef0123456789abcdef';
const FIXED_CHECKED_AT = '2026-07-19T12:34:56.789Z';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

const REPORT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'code',
  'checkedAt',
  'dualWriteState',
  'relationship',
  'recoveryRequired',
  'alertRequired',
  'nextAction',
  'reasonCode',
]);

const CONDITION_CODES = Object.freeze([
  'healthy',
  'uninitialized',
  'state-missing',
  'recovery-required',
  'integrity-alert',
  'io-alert',
]);

const DUAL_WRITE_STATES = new Set(['idle', 'prepared', 'missing', 'invalid', 'unknown']);
const STATUSES = new Set(['healthy', 'alert']);
const NEXT_ACTIONS = new Set([
  'none',
  'initialize-via-production-write',
  'run-explicit-recovery',
  'investigate-integrity',
]);
const RELATIONSHIPS = new Set([
  'empty',
  'equal',
  'events-suffix-of-journal',
  'journal-suffix-of-events',
  'uncovered-events',
  null,
]);
const HEALTHY_RELS = new Set([
  'equal',
  'events-suffix-of-journal',
  'journal-suffix-of-events',
]);

const FORBIDDEN_EXPORTS = Object.freeze([
  'mapObservationToReport',
  'mapObservation',
  'isValidObservation',
  'isValidFrozenObservation',
  'readValidFrozenObservationValues',
  'observationHasSemanticConsistency',
  'isValidReport',
  'readValidFrozenReportValues',
  'resolveCheckedAt',
  'classifyTypedConditionCode',
  'AUDIT_INTEGRITY_MONITOR_TEST_OBSERVATION',
  'AUDIT_INTEGRITY_MONITOR_INJECT_OBSERVATION',
]);

async function mkdtempSafe(prefix) {
  return mkdtemp(join(tmpdir(), `linke-aim-c2-${prefix}-`));
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

async function loadMonitor() {
  return import('../src/audit-integrity-monitor.js');
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

async function runWithFixedClock(root, fixed = FIXED_CHECKED_AT) {
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

function assertReportShape(report) {
  assert.equal(typeof report, 'object');
  assert.ok(report !== null);
  assert.ok(Object.isFrozen(report));
  assert.deepEqual(Object.keys(report), [...REPORT_KEYS]);
  assert.equal(report.schemaVersion, 1);
  assert.ok(STATUSES.has(report.status), `status=${report.status}`);
  assert.ok(CONDITION_CODES.includes(report.code), `code=${report.code}`);
  assert.ok(ISO_RE.test(report.checkedAt), `checkedAt=${report.checkedAt}`);
  assert.ok(DUAL_WRITE_STATES.has(report.dualWriteState), `dual=${report.dualWriteState}`);
  assert.ok(RELATIONSHIPS.has(report.relationship), `rel=${report.relationship}`);
  assert.equal(typeof report.recoveryRequired, 'boolean');
  assert.equal(typeof report.alertRequired, 'boolean');
  assert.equal(report.alertRequired, report.status === 'alert');
  assert.ok(NEXT_ACTIONS.has(report.nextAction), `next=${report.nextAction}`);
  assert.ok(report.reasonCode === null || typeof report.reasonCode === 'string');
  // observation-only fields must never appear on report
  for (const k of [
    'statePresence',
    'stateStatus',
    'storesEmpty',
    'cursorMatch',
    'journalOutcome',
    'crossStoreOutcome',
    'errorLayer',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(report, k), false, `leak field ${k}`);
  }
  return true;
}

function assertPathFreeReport(report, rootHint) {
  const json = JSON.stringify(report);
  assert.ok(!json.includes(rootHint));
  assert.ok(!json.includes('/tmp/'));
  assert.ok(!json.includes('/private/'));
  assert.ok(!json.includes('Users/'));
  assert.ok(!json.includes('integrity-journal.jsonl'));
  assert.ok(!json.includes('events.jsonl'));
  assert.ok(!json.includes('integrity-dual-write-state.json'));
  assert.ok(!json.includes('Bearer '));
  assert.ok(!json.includes('token'));
  return true;
}

function stripCheckedAt(report) {
  const copy = { ...report };
  delete copy.checkedAt;
  return copy;
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

function extractImportBlock(source) {
  const lines = String(source).split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*import\s/.test(line) || (out.length && !/^\s*(export|const|function|async|class|\/\*|\/\/)/.test(line) && out[out.length - 1].includes('from'))) {
      out.push(line);
      if (line.includes(';')) break;
    } else if (out.length && line.includes('from') && line.includes(';')) {
      out.push(line);
      break;
    } else if (/^\s*import\s/.test(line)) {
      out.push(line);
      if (line.includes(';')) break;
    }
  }
  // collect all top-level imports
  const all = [];
  let buf = '';
  for (const line of lines) {
    if (/^\s*import\b/.test(line) || buf) {
      buf += `${line}\n`;
      if (line.includes(';')) {
        all.push(buf);
        buf = '';
      }
    }
  }
  return all.join('');
}

/**
 * Brace-aware function body extraction (masked comments/strings for braces).
 * Used to lock fail-closed try/catch around Object.isFrozen reflection.
 * @param {string} source
 * @param {string} name
 * @returns {string|null}
 */
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

/**
 * True iff `needle` appears lexically inside some try { ... } region of body.
 * Brace-aware on masked source (comments/strings blanked).
 * @param {string} body
 * @param {RegExp|string} needle
 * @returns {boolean}
 */
function appearsInsideTryBlock(body, needle) {
  const text = String(body);
  const masked = maskJsNonCode(text);
  const needleRe = typeof needle === 'string'
    ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    : needle;
  let i = 0;
  while (i < masked.length) {
    const tryIdx = masked.indexOf('try', i);
    if (tryIdx < 0) return false;
    // word boundary for try
    const before = tryIdx === 0 ? ' ' : masked[tryIdx - 1];
    const after = masked[tryIdx + 3] ?? ' ';
    if (!/\w/.test(before) && !/\w/.test(after)) {
      let j = tryIdx + 3;
      while (j < masked.length && /\s/.test(masked[j])) j += 1;
      if (masked[j] === '{') {
        const start = j;
        let brace = 0;
        for (; j < masked.length; j += 1) {
          if (masked[j] === '{') brace += 1;
          else if (masked[j] === '}') {
            brace -= 1;
            if (brace === 0) {
              const region = text.slice(start, j + 1);
              if (needleRe.test(region)) return true;
              i = j + 1;
              break;
            }
          }
        }
        if (j >= masked.length) return false;
        continue;
      }
    }
    i = tryIdx + 3;
  }
  return false;
}

/**
 * Build a hostile Proxy whose target is non-extensible/frozen so that
 * Object.isFrozen / isExtensible / ownKeys / gopd / get traps can fire.
 * @param {{ hits: { n: number }, secret: string }} ctl
 * @returns {object}
 */
function makeHostileFrozenProxy(ctl) {
  const secret = ctl.secret;
  const target = Object.freeze(Object.preventExtensions(Object.create(null)));
  return new Proxy(target, {
    isExtensible() {
      ctl.hits.n += 1;
      throw new Error(`HOSTILE_ISEXT_${secret}`);
    },
    ownKeys() {
      ctl.hits.n += 1;
      throw new Error(`HOSTILE_OWNKEYS_${secret}`);
    },
    getOwnPropertyDescriptor() {
      ctl.hits.n += 1;
      throw new Error(`HOSTILE_GOPD_${secret}`);
    },
    get(_t, p) {
      ctl.hits.n += 1;
      throw new Error(`HOSTILE_GET_${String(p)}_${secret}`);
    },
  });
}

/**
 * External forged exact-shape frozen report (10 keys, types legal) — not issued.
 * @param {Partial<object>} overrides
 * @returns {Readonly<object>}
 */
function forgeFrozenExactReport(overrides = {}) {
  const report = {
    schemaVersion: 1,
    status: 'alert',
    code: 'integrity-alert',
    checkedAt: FIXED_CHECKED_AT,
    dualWriteState: 'idle',
    relationship: null,
    recoveryRequired: false,
    alertRequired: true,
    nextAction: 'investigate-integrity',
    reasonCode: '/tmp/secret-token-body-digest',
    ...overrides,
  };
  // rebuild in exact key order
  const ordered = {
    schemaVersion: report.schemaVersion,
    status: report.status,
    code: report.code,
    checkedAt: report.checkedAt,
    dualWriteState: report.dualWriteState,
    relationship: report.relationship,
    recoveryRequired: report.recoveryRequired,
    alertRequired: report.alertRequired,
    nextAction: report.nextAction,
    reasonCode: report.reasonCode,
  };
  return Object.freeze(ordered);
}

function assertFixedMisuseTypeError(fn, leakNeedles = []) {
  assert.throws(fn, (e) => {
    assert.equal(e instanceof TypeError, true);
    const msg = String(e && e.message);
    assert.ok(!msg.includes('/tmp/'));
    assert.ok(!msg.includes('secret'));
    assert.ok(!msg.includes('token'));
    assert.ok(!msg.includes('HOSTILE_'));
    assert.ok(!msg.includes('FORMAT_'));
    assert.ok(!msg.includes('EXIT_'));
    for (const n of leakNeedles) {
      assert.ok(!msg.includes(n), `must not leak ${n}`);
    }
    return true;
  });
}

// ── Suite ──────────────────────────────────────────────────────────────

describe('C2 audit integrity run-once monitor', () => {
  it('1. cold empty → code uninitialized; nextAction initialize-via-production-write; relationship null; exit 2', async () => {
    await withTempRoot('cold', async (root) => {
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'uninitialized');
      assert.equal(report.dualWriteState, 'missing');
      assert.equal(report.relationship, null);
      assert.equal(report.recoveryRequired, false);
      assert.equal(report.alertRequired, true);
      assert.equal(report.nextAction, 'initialize-via-production-write');
      assert.equal(report.reasonCode, null);
      assert.equal(report.checkedAt, FIXED_CHECKED_AT);
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      assert.equal(auditIntegrityMonitorExitCode(report), 2);
      assertPathFreeReport(report, root);
    });
  });

  // V1.40 C2: monitor → inspect is queue-backed; sole cold FS artifact may be
  // audit/integrity-write.lock (protocol, not audit store / business mutation).
  it('2. cold empty zero audit-store writes (only process-lock protocol artifact)', async () => {
    await withTempRoot('cold-zw', async (root) => {
      const before = await readdir(root);
      assert.deepEqual(before, []);
      await runWithFixedClock(root);
      const after = await readdir(root);
      assert.deepEqual(after.slice().sort(), ['audit']);
      const auditEntries = await readdir(join(root, 'audit'));
      assert.deepEqual(auditEntries.slice().sort(), ['integrity-write.lock']);
      const lockAbs = join(root, 'audit', 'integrity-write.lock');
      const st = await lstat(lockAbs);
      assert.equal(st.isFile(), true);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.nlink, 1);
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(st.size, 0);
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(journalAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(eventsAbs(root)), { code: 'ENOENT' });
    });
  });

  it('3. #2a state missing + non-empty stores + receipt ok → state-missing; exact relationship; reason null; exit 2', async () => {
    await withTempRoot('s-miss-ok', async (root) => {
      const { initializeAuditIntegrityJournal, appendAuditIntegrityEvent } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(eventsAbs(root), eventLine(EVENT_A), { mode: 0o600 });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });

      const before = await snapshotTriple(root);
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'state-missing');
      assert.equal(report.dualWriteState, 'missing');
      assert.equal(report.relationship, 'equal');
      assert.equal(report.reasonCode, null);
      assert.equal(report.recoveryRequired, false);
      assert.equal(report.nextAction, 'investigate-integrity');
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      assert.equal(auditIntegrityMonitorExitCode(report), 2);
      assertSnapEqual(await snapshotTriple(root), before);
    });
  });

  it('4. healthy idle equal (or allowed suffix) → healthy; nextAction none; exit 0', async () => {
    await withTempRoot('healthy', async (root) => {
      await ensureHealthyIdle(root);
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'healthy');
      assert.equal(report.code, 'healthy');
      assert.equal(report.dualWriteState, 'idle');
      assert.ok(HEALTHY_RELS.has(report.relationship), `rel=${report.relationship}`);
      assert.equal(report.recoveryRequired, false);
      assert.equal(report.alertRequired, false);
      assert.equal(report.nextAction, 'none');
      assert.equal(report.reasonCode, null);
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      assert.equal(auditIntegrityMonitorExitCode(report), 0);
    });
  });

  it('5. prepared → recovery-required; recoveryRequired true; nextAction run-explicit-recovery; relationship null; bytes unchanged', async () => {
    await withTempRoot('prep', async (root) => {
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_CRASH_HOOK,
      } = await loadCoordinator();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        }),
      );
      const before = await snapshotTriple(root);
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'recovery-required');
      assert.equal(report.dualWriteState, 'prepared');
      assert.equal(report.relationship, null);
      assert.equal(report.recoveryRequired, true);
      assert.equal(report.alertRequired, true);
      assert.equal(report.nextAction, 'run-explicit-recovery');
      assert.equal(report.reasonCode, null);
      assertSnapEqual(await snapshotTriple(root), before);
      const stateText = await readFile(stateAbs(root), 'utf8');
      assert.ok(stateText.includes('"status":"prepared"') || stateText.includes('"status": "prepared"'));
    });
  });

  it('6. cursor mismatch → integrity-alert; reason cursor-mismatch; relationship null', async () => {
    await withTempRoot('cursor-mm', async (root) => {
      await ensureHealthyIdle(root);
      await writeFile(eventsAbs(root), eventLine(EVENT_B), { mode: 0o600 });
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.dualWriteState, 'idle');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(report.nextAction, 'investigate-integrity');
    });
  });

  it('7. invalid state JSON/schema → integrity-alert; dualWriteState invalid; reason state-invalid; relationship null', async () => {
    await withTempRoot('state-bad', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), '{not-json\n', { mode: 0o600 });
      const before = await readFile(stateAbs(root));
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.dualWriteState, 'invalid');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
      assert.deepEqual(await readFile(stateAbs(root)), before);
    });
  });

  it('8. #7 Sio report — state symlink → io-alert; dualWriteState unknown; relationship null; dual-write-io-error', async () => {
    await withTempRoot('sio-sym', async (root) => {
      const outside = await mkdtempSafe('sio-out');
      try {
        const target = join(outside, 'target.json');
        await writeFile(target, '{"x":1}\n', { mode: 0o600 });
        await mkdir(join(root, 'audit'), { recursive: true });
        await symlink(target, stateAbs(root));
        const report = await runWithFixedClock(root);
        assertReportShape(report);
        assert.equal(report.status, 'alert');
        assert.equal(report.code, 'io-alert');
        assert.equal(report.dualWriteState, 'unknown');
        assert.equal(report.relationship, null);
        assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
        assert.equal(report.recoveryRequired, false);
        assert.equal(report.nextAction, 'investigate-integrity');
        assertPathFreeReport(report, root);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('9. state oversize / directory / permission → same io-alert + dualWriteState unknown', async () => {
    // oversize
    await withTempRoot('sio-over', async (root) => {
      const { AUDIT_DUAL_WRITE_STATE_MAX_BYTES } = await loadState();
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), 'x'.repeat(AUDIT_DUAL_WRITE_STATE_MAX_BYTES + 8), {
        mode: 0o600,
      });
      const report = await runWithFixedClock(root);
      assert.equal(report.code, 'io-alert');
      assert.equal(report.dualWriteState, 'unknown');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
    });
    // directory
    await withTempRoot('sio-dir', async (root) => {
      await mkdir(stateAbs(root), { recursive: true });
      const report = await runWithFixedClock(root);
      assert.equal(report.code, 'io-alert');
      assert.equal(report.dualWriteState, 'unknown');
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
    });
    // permission
    await withTempRoot('sio-perm', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), '{"schemaVersion":1}\n', { mode: 0o000 });
      try {
        const report = await runWithFixedClock(root);
        assert.equal(report.code, 'io-alert');
        assert.equal(report.dualWriteState, 'unknown');
        assert.equal(report.relationship, null);
        assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
      } finally {
        await chmod(stateAbs(root), 0o600);
      }
    });
  });

  it('10. journal broken → integrity-alert + journal reason; relationship null; reason ≠ cursor-mismatch', async () => {
    await withTempRoot('j-chain', async (root) => {
      await ensureHealthyIdle(root);
      const raw = await readFile(journalAbs(root), 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      const obj = JSON.parse(lines[0]);
      const flipped = obj.linkDigest.replace(/[0-9a-f]/, (c) => (c === 'a' ? 'b' : 'a'));
      obj.linkDigest = flipped;
      lines[0] = JSON.stringify(obj);
      await writeFile(journalAbs(root), `${lines.join('\n')}\n`, { mode: 0o600 });

      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.dualWriteState, 'idle');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_CHAIN_BROKEN);
      assert.notEqual(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
    });
  });

  it('11. cross-store broken → integrity-alert; reason cross-store-broken; relationship null; ≠ cursor-mismatch', async () => {
    await withTempRoot('cs-broken', async (root) => {
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
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.dualWriteState, 'idle');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
      assert.notEqual(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
    });
  });

  it('12. journal typed IO → io-alert + *-io-error; dualWriteState idle retained; relationship null; ≠ cursor-mismatch', async () => {
    await withTempRoot('j-io', async (root) => {
      await ensureHealthyIdle(root);
      await rm(journalAbs(root), { force: true });
      await mkdir(journalAbs(root));
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'io-alert');
      assert.equal(report.dualWriteState, 'idle');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_IO_ERROR);
      assert.ok(String(report.reasonCode).endsWith('-io-error'));
      assert.notEqual(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
    });
  });

  it('13. report exact key order (Object.keys bit-for-bit)', async () => {
    await withTempRoot('keys', async (root) => {
      await ensureHealthyIdle(root);
      const report = await runWithFixedClock(root);
      assert.deepEqual(Object.keys(report), [...REPORT_KEYS]);
    });
  });

  it('14. report Object.isFrozen + mutation rejected', async () => {
    await withTempRoot('freeze', async (root) => {
      const report = await runWithFixedClock(root);
      assert.ok(Object.isFrozen(report));
      assert.throws(() => {
        report.status = 'healthy';
      });
      assert.throws(() => {
        report.extra = 1;
      });
    });
  });

  it('15. schemaVersion === 1', async () => {
    await withTempRoot('schema', async (root) => {
      const report = await runWithFixedClock(root);
      assert.equal(report.schemaVersion, 1);
    });
  });

  it('16. format JSON parse roundtrip field-equal; trailing newline; compact single line', async () => {
    await withTempRoot('fmt', async (root) => {
      await ensureHealthyIdle(root);
      const report = await runWithFixedClock(root);
      const { formatAuditIntegrityMonitorReportJson } = await loadMonitor();
      const text = formatAuditIntegrityMonitorReportJson(report);
      assert.equal(typeof text, 'string');
      assert.ok(text.endsWith('\n'));
      assert.equal(text.indexOf('\n'), text.length - 1);
      const parsed = JSON.parse(text);
      assert.deepEqual(parsed, { ...report });
      assert.deepEqual(Object.keys(parsed), [...REPORT_KEYS]);
    });
  });

  it('17. format has no path/body/digest/token substrings canary', async () => {
    await withTempRoot('fmt-safe', async (root) => {
      await ensureHealthyIdle(root);
      const report = await runWithFixedClock(root);
      const { formatAuditIntegrityMonitorReportJson } = await loadMonitor();
      const text = formatAuditIntegrityMonitorReportJson(report);
      assert.ok(!text.includes(root));
      assert.ok(!text.includes('/tmp/'));
      assert.ok(!text.includes('integrity-dual-write-state.json'));
      assert.ok(!text.includes('payloadDigest'));
      assert.ok(!text.includes('linkDigest'));
      assert.ok(!text.includes('sha256'));
      assert.ok(!text.includes('Bearer'));
      assert.ok(!text.includes('token'));
      assert.ok(!text.includes('transactionId'));
    });
  });

  it('18. test Symbol plain own data property fixes checkedAt; two runs equal except checkedAt when free clock', async () => {
    await withTempRoot('clock-fixed', async (root) => {
      await ensureHealthyIdle(root);
      const a = await runWithFixedClock(root, '2026-07-19T01:02:03.004Z');
      const b = await runWithFixedClock(root, '2026-07-19T01:02:03.004Z');
      assert.equal(a.checkedAt, '2026-07-19T01:02:03.004Z');
      assert.equal(b.checkedAt, '2026-07-19T01:02:03.004Z');
      assert.deepEqual(a, b);

      const { runAuditIntegrityMonitor } = await loadMonitor();
      const r1 = await runAuditIntegrityMonitor(root);
      const r2 = await runAuditIntegrityMonitor(root);
      assert.deepEqual(stripCheckedAt(r1), stripCheckedAt(r2));
      assert.ok(ISO_RE.test(r1.checkedAt));
      assert.ok(ISO_RE.test(r2.checkedAt));
    });
  });

  it('19. missing Symbol / absent descriptor → checkedAt matches strict ISO (real clock)', async () => {
    await withTempRoot('clock-real', async (root) => {
      const { runAuditIntegrityMonitor } = await loadMonitor();
      const report = await runAuditIntegrityMonitor(root, {});
      assert.ok(ISO_RE.test(report.checkedAt));
      assert.equal(new Date(report.checkedAt).toISOString(), report.checkedAt);
    });
  });

  it('20. module does not read process.argv; no CLI clock flag contract in source', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    const masked = maskJsNonCode(src);
    assert.equal(/\bprocess\.argv\b/.test(masked), false);
    assert.equal(/\b--checked-at\b/.test(src), false);
    assert.equal(/\b--checkedAt\b/.test(src), false);
  });

  it('21. hostile options: accessor getter not executed; Proxy trap throw/illegal → real clock; no leak', async () => {
    await withTempRoot('hostile-opts', async (root) => {
      await ensureHealthyIdle(root);
      const {
        runAuditIntegrityMonitor,
        AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT,
        formatAuditIntegrityMonitorReportJson,
      } = await loadMonitor();

      // accessor getter must not run
      let getterHits = 0;
      const accessorOpts = Object.create(null);
      Object.defineProperty(accessorOpts, AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT, {
        get() {
          getterHits += 1;
          throw new Error('SECRET_GETTER_PATH_/tmp/leak-token-body');
        },
        enumerable: false,
        configurable: true,
      });
      const rAcc = await runAuditIntegrityMonitor(root, accessorOpts);
      assert.equal(getterHits, 0);
      assert.ok(ISO_RE.test(rAcc.checkedAt));
      assert.notEqual(rAcc.checkedAt, FIXED_CHECKED_AT);
      const jsonAcc = formatAuditIntegrityMonitorReportJson(rAcc);
      assert.ok(!jsonAcc.includes('SECRET_GETTER'));
      assert.ok(!jsonAcc.includes('leak-token'));
      assert.ok(!jsonAcc.includes('/tmp/'));

      // Proxy getOwnPropertyDescriptor trap throws
      const throwProxy = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('TRAP_THROW_/private/secret-path/token-digest-body');
          },
          get() {
            throw new Error('GET_MUST_NOT_RUN');
          },
        },
      );
      const rThrow = await runAuditIntegrityMonitor(root, throwProxy);
      assert.ok(ISO_RE.test(rThrow.checkedAt));
      const jsonThrow = formatAuditIntegrityMonitorReportJson(rThrow);
      assert.ok(!jsonThrow.includes('TRAP_THROW'));
      assert.ok(!jsonThrow.includes('secret-path'));
      assert.ok(!jsonThrow.includes('token-digest'));
      assert.ok(!jsonThrow.includes('GET_MUST_NOT_RUN'));

      // Proxy trap returns illegal descriptor
      const illegalProxy = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            return { get: () => '2026-07-19T00:00:00.000Z', configurable: true, enumerable: false };
          },
        },
      );
      const rIllegal = await runAuditIntegrityMonitor(root, illegalProxy);
      assert.ok(ISO_RE.test(rIllegal.checkedAt));
      // invalid ISO string via data descriptor
      const badIso = Object.create(null);
      Object.defineProperty(badIso, AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT, {
        value: 'not-an-iso',
        writable: true,
        enumerable: false,
        configurable: true,
      });
      const rBad = await runAuditIntegrityMonitor(root, badIso);
      assert.ok(ISO_RE.test(rBad.checkedAt));
      assert.notEqual(rBad.checkedAt, 'not-an-iso');
    });
  });

  it('22. exit helper: healthy→0; any alert code→2; never returns 1', async () => {
    await withTempRoot('exit', async (root) => {
      await ensureHealthyIdle(root);
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      const healthy = await runWithFixedClock(root);
      assert.equal(auditIntegrityMonitorExitCode(healthy), 0);

      const coldRoot = await mkdtempSafe('exit-cold');
      try {
        const alert = await runWithFixedClock(coldRoot);
        assert.equal(auditIntegrityMonitorExitCode(alert), 2);
        assert.notEqual(auditIntegrityMonitorExitCode(alert), 1);
      } finally {
        await rm(coldRoot, { recursive: true, force: true });
      }
    });
  });

  it('23. reasonCode direct map from observation; no ERROR_CODES import/whitelist; fail-closed shape locked in source', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    const imports = extractImportBlock(src);
    assert.equal(/error-codes/.test(imports), false);
    assert.equal(/assertRegisteredErrorCode/.test(src), false);
    assert.equal(/ERROR_CODES/.test(maskJsNonCode(src)), false);
    // fail-closed integrity-alert + reasonCode null for bad observation shape
    assert.ok(/integrity-alert/.test(src));
    assert.ok(/reasonCode/.test(src));
    // private shape guard must exist (frozen + exact keys) without public inject Symbol
    assert.ok(/Object\.isFrozen/.test(src));
    assert.ok(/statePresence/.test(src));
    for (const name of FORBIDDEN_EXPORTS) {
      assert.equal(
        new RegExp(`export\\s+(?:const|function|async\\s+function|let|var)\\s+${name}\\b`).test(src),
        false,
        `must not export ${name}`,
      );
    }
    // runtime: direct map of real typed reason
    await withTempRoot('reason-map', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(stateAbs(root), '{bad\n', { mode: 0o600 });
      const report = await runWithFixedClock(root);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
      assert.equal(report.code, 'integrity-alert');
    });
  });

  it('24. relationship only allowed enum or null; prepared/cursor typed force null', async () => {
    await withTempRoot('rel-enum', async (root) => {
      await ensureHealthyIdle(root);
      const report = await runWithFixedClock(root);
      assert.ok(RELATIONSHIPS.has(report.relationship));
    });
  });

  it('25. dualWriteState only five values; report has no observation-only fields', async () => {
    await withTempRoot('dual-enum', async (root) => {
      const report = await runWithFixedClock(root);
      assert.ok(DUAL_WRITE_STATES.has(report.dualWriteState));
      assertReportShape(report);
    });
  });

  it('26. source: only import public inspector from dual-write; no forbidden imports', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    const imports = extractImportBlock(src);
    assert.ok(/inspectAuditIntegrityDualWriteReadOnly/.test(imports));
    assert.ok(/audit-integrity-dual-write\.js/.test(imports));
    // exactly one from dual-write
    const fromDual = [...imports.matchAll(/from\s+['"][^'"]*audit-integrity-dual-write\.js['"]/g)];
    assert.equal(fromDual.length, 1);
    // only that named import
    assert.ok(
      /import\s*\{\s*inspectAuditIntegrityDualWriteReadOnly\s*\}\s*from\s*['"][^'"]*audit-integrity-dual-write\.js['"]/.test(
        imports.replace(/\s+/g, ' '),
      ),
    );
    for (const bad of [
      'error-codes',
      'audit-integrity-dual-write-state',
      'audit-integrity-journal',
      'audit-integrity-cross-store',
      'audit-integrity-write-queue',
      'audit-log',
      'safe-data-files',
      'server.js',
      'agent.js',
    ]) {
      assert.equal(imports.includes(bad), false, `forbidden import ${bad}`);
    }
  });

  it('27. source: no setInterval/setTimeout/setImmediate scheduler', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    const masked = maskJsNonCode(src);
    assert.equal(/\bsetInterval\b/.test(masked), false);
    assert.equal(/\bsetTimeout\b/.test(masked), false);
    assert.equal(/\bsetImmediate\b/.test(masked), false);
  });

  // V1.42: registry 74→88 (G0c +14 restore = 88); monitor boundary still does not change registry.
  // Historical: V1.41 was 74 = V1.40 62 + 12 upload.
  it('28. ERROR_CODES length remains 88 (this boundary does not change registry)', async () => {
    assert.equal(Object.keys(ERROR_CODES).length, 88);
  });

  it('29. #11 idle + journal missing/NOT_INITIALIZED → integrity-alert; dual idle; relationship null; not-initialized; exit 2', async () => {
    await withTempRoot('not-init', async (root) => {
      await ensureHealthyIdle(root);
      await rm(journalAbs(root), { force: true });
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.dualWriteState, 'idle');
      assert.equal(report.relationship, null);
      assert.equal(report.recoveryRequired, false);
      assert.equal(report.nextAction, 'investigate-integrity');
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_NOT_INITIALIZED);
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      assert.equal(auditIntegrityMonitorExitCode(report), 2);
    });
  });

  it('30. #12 idle + relationship empty → integrity-alert; relationship empty; reason null; never healthy; exit 2', async () => {
    await withTempRoot('idle-empty', async (root) => {
      const { recoverAuditIntegrityDualWrite } = await loadCoordinator();
      await recoverAuditIntegrityDualWrite(root);
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'alert');
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.dualWriteState, 'idle');
      assert.equal(report.relationship, 'empty');
      assert.equal(report.reasonCode, null);
      assert.equal(report.nextAction, 'investigate-integrity');
      assert.notEqual(report.code, 'healthy');
      assert.notEqual(report.status, 'healthy');
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      assert.equal(auditIntegrityMonitorExitCode(report), 2);
    });
  });

  it('31. #13 uncovered-events → integrity-alert; relationship uncovered-events; reasonCode null fixed; exit 2', async () => {
    await withTempRoot('uncovered', async (root) => {
      const { recoverAuditIntegrityDualWrite } = await loadCoordinator();
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
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.dualWriteState, 'idle');
      assert.equal(report.relationship, 'uncovered-events');
      assert.equal(report.reasonCode, null);
      assert.notEqual(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      assert.equal(auditIntegrityMonitorExitCode(report), 2);
    });
  });

  it('32. #7b RootFail report → io-alert; dualWriteState unknown; relationship null; dual-write-io-error; no root create; exit 2', async () => {
    const missing = join(tmpdir(), `linke-aim-c2-missing-${Date.now()}-${Math.random()}`);
    const report = await runWithFixedClock(missing);
    assertReportShape(report);
    assert.equal(report.status, 'alert');
    assert.equal(report.code, 'io-alert');
    assert.equal(report.dualWriteState, 'unknown');
    assert.equal(report.relationship, null);
    assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
    await assert.rejects(() => access(missing), { code: 'ENOENT' });
    const { auditIntegrityMonitorExitCode } = await loadMonitor();
    assert.equal(auditIntegrityMonitorExitCode(report), 2);

    // non-directory
    await withTempRoot('root-file', async (root) => {
      const filePath = join(root, 'not-a-dir');
      await writeFile(filePath, 'x', { mode: 0o600 });
      const r2 = await runWithFixedClock(filePath);
      assert.equal(r2.code, 'io-alert');
      assert.equal(r2.dualWriteState, 'unknown');
      const st = await lstat(filePath);
      assert.ok(st.isFile());
    });
  });

  it('33. empty must not be claimed as damage evidence; only fail-closed attention (honesty canary)', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    // implementation comments/code must not claim empty is corruption proof
    assert.equal(/empty\s+is\s+corruption/i.test(src), false);
    assert.equal(/损坏证据/.test(src), false);
    await withTempRoot('empty-honesty', async (root) => {
      const { recoverAuditIntegrityDualWrite } = await loadCoordinator();
      await recoverAuditIntegrityDualWrite(root);
      const report = await runWithFixedClock(root);
      assert.equal(report.relationship, 'empty');
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.reasonCode, null);
    });
  });

  it('34. healthy only allows relationship ∈ {equal, events-suffix-of-journal, journal-suffix-of-events}', async () => {
    await withTempRoot('healthy-rel', async (root) => {
      await ensureHealthyIdle(root);
      const report = await runWithFixedClock(root);
      if (report.status === 'healthy') {
        assert.ok(HEALTHY_RELS.has(report.relationship));
        assert.notEqual(report.relationship, 'empty');
        assert.notEqual(report.relationship, 'uncovered-events');
        assert.notEqual(report.relationship, null);
      }
    });
  });

  it('35. #2b state-missing + typed error → relationship null; code/reason typed priority (not state-missing); exit 2', async () => {
    await withTempRoot('s-miss-typed', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(journalAbs(root), '{broken-not-json\n', { mode: 0o600 });
      const report = await runWithFixedClock(root);
      assertReportShape(report);
      assert.equal(report.status, 'alert');
      assert.notEqual(report.code, 'state-missing');
      assert.equal(report.dualWriteState, 'missing');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_CHAIN_BROKEN);
      assert.equal(report.code, 'integrity-alert');
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      assert.equal(auditIntegrityMonitorExitCode(report), 2);
    });
  });

  it('36. prepared relationship lock: valid prepared → relationship null', async () => {
    await withTempRoot('prep-rel', async (root) => {
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_CRASH_HOOK,
      } = await loadCoordinator();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        }),
      );
      const report = await runWithFixedClock(root);
      assert.equal(report.code, 'recovery-required');
      assert.equal(report.relationship, null);
    });
  });

  it('37. cursor-mismatch relationship lock: #5 → relationship null', async () => {
    await withTempRoot('cur-rel', async (root) => {
      await ensureHealthyIdle(root);
      await writeFile(eventsAbs(root), eventLine(EVENT_B), { mode: 0o600 });
      const report = await runWithFixedClock(root);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(report.relationship, null);
    });
  });

  it('38. canary mapping: raw fp match + cross-store semantic broken → cross-store typed; not cursor-mismatch; relationship null; exit 2', async () => {
    await withTempRoot('canary-cs', async (root) => {
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
      const report = await runWithFixedClock(root);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BROKEN);
      assert.notEqual(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(report.relationship, null);
      assert.equal(report.code, 'integrity-alert');
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      assert.equal(auditIntegrityMonitorExitCode(report), 2);
    });
  });

  it('39. canary mapping: true raw fingerprint mismatch → cursor-mismatch; relationship null; exit 2', async () => {
    await withTempRoot('canary-fp', async (root) => {
      await ensureHealthyIdle(root);
      await writeFile(eventsAbs(root), eventLine(EVENT_B), { mode: 0o600 });
      const report = await runWithFixedClock(root);
      assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(report.relationship, null);
      assert.equal(report.code, 'integrity-alert');
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      assert.equal(auditIntegrityMonitorExitCode(report), 2);
    });
  });

  it('40. obs→report dualWriteState mapping lock: statePresence io-error (Sio/RootFail) → report dualWriteState unknown only', async () => {
    await withTempRoot('map-unknown', async (root) => {
      await mkdir(stateAbs(root), { recursive: true });
      const report = await runWithFixedClock(root);
      assert.equal(report.dualWriteState, 'unknown');
      assert.notEqual(report.dualWriteState, 'invalid');
      assert.notEqual(report.dualWriteState, 'missing');
      assert.notEqual(report.dualWriteState, 'idle');
      assert.equal(report.code, 'io-alert');
    });
  });

  it('41. CONDITION_CODES frozen exact order; public exports surface only five names', async () => {
    const mod = await loadMonitor();
    assert.ok(Object.isFrozen(mod.AUDIT_INTEGRITY_MONITOR_CONDITION_CODES));
    assert.deepEqual([...mod.AUDIT_INTEGRITY_MONITOR_CONDITION_CODES], [...CONDITION_CODES]);
    assert.equal(typeof mod.AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT, 'symbol');
    assert.equal(typeof mod.runAuditIntegrityMonitor, 'function');
    assert.equal(mod.runAuditIntegrityMonitor.constructor.name, 'AsyncFunction');
    assert.equal(typeof mod.auditIntegrityMonitorExitCode, 'function');
    assert.equal(typeof mod.formatAuditIntegrityMonitorReportJson, 'function');
    const publicNames = Object.keys(mod).sort();
    assert.deepEqual(publicNames, [
      'AUDIT_INTEGRITY_MONITOR_CONDITION_CODES',
      'AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT',
      'auditIntegrityMonitorExitCode',
      'formatAuditIntegrityMonitorReportJson',
      'runAuditIntegrityMonitor',
    ].sort());
  });

  it('42. format hostile misuse: fixed TypeError; provenance rejects before traps (hits=0); no leak', async () => {
    const {
      formatAuditIntegrityMonitorReportJson,
      auditIntegrityMonitorExitCode,
    } = await loadMonitor();
    const secret = '/tmp/secret-token-body';
    const ctl = { hits: { n: 0 }, secret };
    const hostile = makeHostileFrozenProxy(ctl);

    assertFixedMisuseTypeError(
      () => formatAuditIntegrityMonitorReportJson(/** @type {any} */ (hostile)),
      [secret, 'HOSTILE_', 'path-token'],
    );
    assert.equal(ctl.hits.n, 0, 'format must reject unissued hostile before any reflection traps');

    ctl.hits.n = 0;
    assertFixedMisuseTypeError(
      () => auditIntegrityMonitorExitCode(/** @type {any} */ (hostile)),
      [secret, 'HOSTILE_'],
    );
    assert.equal(ctl.hits.n, 0, 'exit must reject unissued hostile before any reflection traps');

    // unfrozen plain object (exact shape still unissued)
    assert.throws(() => formatAuditIntegrityMonitorReportJson({
      schemaVersion: 1,
      status: 'healthy',
      code: 'healthy',
      checkedAt: FIXED_CHECKED_AT,
      dualWriteState: 'idle',
      relationship: 'equal',
      recoveryRequired: false,
      alertRequired: false,
      nextAction: 'none',
      reasonCode: null,
    }), TypeError);
    // null / non-object
    assert.throws(() => formatAuditIntegrityMonitorReportJson(null), TypeError);
    assert.throws(() => formatAuditIntegrityMonitorReportJson('x'), TypeError);
  });

  it('43. exit helper hostile misuse: fixed path-free TypeError; hits=0; never returns 1', async () => {
    const { auditIntegrityMonitorExitCode } = await loadMonitor();
    const ctl = { hits: { n: 0 }, secret: '/tmp/token-exit-hostile' };
    const hostile = makeHostileFrozenProxy(ctl);
    const cases = [
      null,
      undefined,
      'healthy',
      0,
      { status: 'healthy' },
      hostile,
      new Proxy({}, {
        get() {
          ctl.hits.n += 1;
          throw new Error('EXIT_GET_/tmp/token');
        },
      }),
    ];
    for (const c of cases) {
      try {
        const code = auditIntegrityMonitorExitCode(/** @type {any} */ (c));
        assert.fail(`expected TypeError, got ${code}`);
      } catch (e) {
        assert.equal(e instanceof TypeError, true);
        assert.notEqual(/** @type {any} */ (e).exitCode, 1);
        assert.ok(!String(e.message).includes('/tmp/'));
        assert.ok(!String(e.message).includes('token'));
        assert.ok(!String(e.message).includes('HOSTILE_'));
        assert.ok(!String(e.message).includes('EXIT_'));
      }
    }
    assert.equal(ctl.hits.n, 0, 'exit must not fire hostile traps on unissued inputs');
  });

  it('44. checkedAt: invalid date matching regex shape rejected; Proxy illegal value; no ordinary options[SYMBOL] read path in source', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    // forbid ordinary property read of the Symbol (would run getters)
    // allow only getOwnPropertyDescriptor path
    assert.ok(/getOwnPropertyDescriptor/.test(src));
    // no Reflect.get on options for the symbol
    assert.equal(/Reflect\.get\s*\(\s*options/.test(maskJsNonCode(src)), false);

    await withTempRoot('clock-invalid', async (root) => {
      const {
        runAuditIntegrityMonitor,
        AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT,
      } = await loadMonitor();
      // regex-shaped but invalid calendar date should fall back (Date round-trip fails)
      const opts = Object.create(null);
      Object.defineProperty(opts, AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT, {
        value: '2026-99-99T00:00:00.000Z',
        writable: true,
        enumerable: false,
        configurable: true,
      });
      const report = await runAuditIntegrityMonitor(root, opts);
      assert.ok(ISO_RE.test(report.checkedAt));
      assert.notEqual(report.checkedAt, '2026-99-99T00:00:00.000Z');
    });
  });

  it('45. prepared remains prepared across two monitor runs (zero write + no recover)', async () => {
    await withTempRoot('prep-stable', async (root) => {
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_CRASH_HOOK,
      } = await loadCoordinator();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        }),
      );
      const before = await snapshotTriple(root);
      const a = await runWithFixedClock(root);
      const b = await runWithFixedClock(root);
      assert.equal(a.code, 'recovery-required');
      assert.equal(b.code, 'recovery-required');
      assert.equal(a.dualWriteState, 'prepared');
      assert.equal(b.dualWriteState, 'prepared');
      assertSnapEqual(await snapshotTriple(root), before);
    });
  });

  it('46. source: no write APIs / recover / bootstrap / publish call sites', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    for (const name of [
      'safeAtomicWriteBytes',
      'safeAppendText',
      'safeCreateExclusive',
      'publishDualWriteStateUnlocked',
      'bootstrapDualWriteIdleUnlocked',
      'recoverAuditIntegrityDualWrite',
      'recoverPreparedUnlocked',
      'appendAuditEventWithIntegrityDualWrite',
      'writeFile',
      'appendFile',
    ]) {
      assert.equal(hasCallSite(src, name), false, `must not call ${name}`);
    }
  });

  it('47. condition code io-alert vs integrity-alert suffix rule: known *-io-error → io-alert without registry list copy', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    // suffix classification, not ERROR_CODES membership list
    assert.ok(/-io-error/.test(src) || /endsWith\s*\(\s*['"]-io-error['"]\s*\)/.test(src));
    assert.equal(/audit-integrity-bounds-exceeded/.test(src), false);
    assert.equal(/audit-integrity-cross-store-event-invalid/.test(src), false);
    assert.equal(/Object\.values\s*\(\s*ERROR_CODES\s*\)/.test(src), false);
  });

  it('48. fail-closed malformed observation: Object.isFrozen reflection inside try/catch (body extraction; no inject hook)', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    const obsBody = extractFunctionBody(src, 'readValidFrozenObservationValues');
    assert.ok(obsBody, 'readValidFrozenObservationValues body must exist');
    // Object.isFrozen must appear inside a try block (not bare, which can throw trap errors)
    assert.ok(
      appearsInsideTryBlock(obsBody, /Object\.isFrozen\s*\(/),
      'Object.isFrozen must be inside try in readValidFrozenObservationValues',
    );
    // ownKeys / gopd style reflection also under try path
    assert.ok(
      appearsInsideTryBlock(obsBody, /Object\.keys\s*\(/)
        || appearsInsideTryBlock(obsBody, /getOwnPropertyDescriptor/),
      'keys/descriptor reflection must be inside try',
    );
    // catch must fail-closed return null (not rethrow / not boolean false)
    assert.ok(/catch\s*(?:\([^)]*\))?\s*\{\s*return\s+null\s*;?\s*\}/.test(obsBody.replace(/\s+/g, ' ')));
    // returns values map (Object.create(null)), not bare boolean
    assert.ok(/Object\.create\s*\(\s*null\s*\)/.test(obsBody));
    assert.ok(/\breturn\s+values\b/.test(obsBody));
    // no ordinary property get on obs inside validator
    const obsMasked = maskJsNonCode(obsBody);
    assert.equal(/\bobs\s*\./.test(obsMasked), false, 'validator must not ordinary-get obs.field');
    assert.equal(/\bobs\s*\[/.test(obsMasked), false, 'validator must not ordinary-get obs[key]');
    assert.equal(/Reflect\.get\s*\(\s*obs\b/.test(obsMasked), false);

    // report validator likewise wraps reflection after provenance
    const reportBody = extractFunctionBody(src, 'readValidFrozenReportValues');
    assert.ok(reportBody, 'readValidFrozenReportValues body must exist');
    assert.ok(/WeakSet/.test(src) || /ISSUED_MONITOR_REPORTS/.test(src));
    assert.ok(
      appearsInsideTryBlock(reportBody, /Object\.isFrozen\s*\(/),
      'Object.isFrozen must be inside try in readValidFrozenReportValues',
    );

    // fail-closed fixed fields present; no public observation injection
    assert.ok(/statePresence/.test(src));
    assert.ok(/storesEmpty/.test(src));
    assert.ok(/dualWriteState/.test(src));
    assert.ok(/unknown/.test(src));
    assert.equal(/test-observation/.test(src), false);
    assert.equal(/injectObservation/.test(src), false);
    assert.equal(/TEST_OBSERVATION/.test(src), false);
    assert.equal(/export\s+.*ISSUED_MONITOR_REPORTS/.test(src), false);
    assert.equal(/export\s+.*readValidFrozenObservationValues/.test(src), false);
    assert.equal(/export\s+.*isValidFrozenObservation/.test(src), false);
  });

  it('49. external forged frozen exact 10-key report rejected by format/exit; secret reason not serialized', async () => {
    const {
      formatAuditIntegrityMonitorReportJson,
      auditIntegrityMonitorExitCode,
    } = await loadMonitor();
    const secret = '/tmp/secret-token-body-digest';
    const forged = forgeFrozenExactReport({ reasonCode: secret });
    assert.ok(Object.isFrozen(forged));
    assert.deepEqual(Object.keys(forged), [...REPORT_KEYS]);
    assert.equal(typeof forged.reasonCode, 'string');
    assert.equal(forged.schemaVersion, 1);

    assertFixedMisuseTypeError(
      () => formatAuditIntegrityMonitorReportJson(/** @type {any} */ (forged)),
      [secret, 'secret-token-body-digest'],
    );
    assertFixedMisuseTypeError(
      () => auditIntegrityMonitorExitCode(/** @type {any} */ (forged)),
      [secret, 'secret-token-body-digest'],
    );

    // healthy-looking forged also rejected (types/order fully legal, unissued)
    const forgedHealthy = forgeFrozenExactReport({
      status: 'healthy',
      code: 'healthy',
      dualWriteState: 'idle',
      relationship: 'equal',
      recoveryRequired: false,
      alertRequired: false,
      nextAction: 'none',
      reasonCode: null,
    });
    assert.throws(
      () => formatAuditIntegrityMonitorReportJson(/** @type {any} */ (forgedHealthy)),
      TypeError,
    );
    assert.throws(
      () => auditIntegrityMonitorExitCode(/** @type {any} */ (forgedHealthy)),
      TypeError,
    );
  });

  it('50. JSON.parse(format(realReport)) clone loses provenance → format/exit TypeError', async () => {
    await withTempRoot('json-clone', async (root) => {
      await ensureHealthyIdle(root);
      const {
        formatAuditIntegrityMonitorReportJson,
        auditIntegrityMonitorExitCode,
      } = await loadMonitor();
      const real = await runWithFixedClock(root);
      const text = formatAuditIntegrityMonitorReportJson(real);
      const clone = JSON.parse(text);
      assert.deepEqual(clone, { ...real });
      assert.deepEqual(Object.keys(clone), [...REPORT_KEYS]);
      // plain parse result is not frozen and not issued
      assert.throws(
        () => formatAuditIntegrityMonitorReportJson(/** @type {any} */ (clone)),
        TypeError,
      );
      assert.throws(
        () => auditIntegrityMonitorExitCode(/** @type {any} */ (clone)),
        TypeError,
      );
      // even if attacker freezes the clone with exact keys
      const frozenClone = Object.freeze({ ...clone });
      assert.ok(Object.isFrozen(frozenClone));
      assert.deepEqual(Object.keys(frozenClone), [...REPORT_KEYS]);
      assert.throws(
        () => formatAuditIntegrityMonitorReportJson(/** @type {any} */ (frozenClone)),
        TypeError,
      );
      assert.throws(
        () => auditIntegrityMonitorExitCode(/** @type {any} */ (frozenClone)),
        TypeError,
      );
    });
  });

  it('51. cross-field forged contradictions rejected; real issued reports still format/exit; provenance stable across runs', async () => {
    const {
      formatAuditIntegrityMonitorReportJson,
      auditIntegrityMonitorExitCode,
    } = await loadMonitor();

    // Unissued forgeries with cross-field contradictions (healthy + io-alert, etc.)
    const contradictions = [
      forgeFrozenExactReport({
        status: 'healthy',
        code: 'io-alert',
        alertRequired: false,
        dualWriteState: 'idle',
        relationship: 'equal',
        recoveryRequired: false,
        nextAction: 'none',
        reasonCode: null,
      }),
      forgeFrozenExactReport({
        status: 'healthy',
        code: 'healthy',
        alertRequired: true, // contradicts status
        dualWriteState: 'idle',
        relationship: 'equal',
        recoveryRequired: false,
        nextAction: 'none',
        reasonCode: null,
      }),
      forgeFrozenExactReport({
        status: 'alert',
        code: 'healthy',
        alertRequired: true,
        dualWriteState: 'idle',
        relationship: 'equal',
        recoveryRequired: false,
        nextAction: 'none',
        reasonCode: null,
      }),
      forgeFrozenExactReport({
        status: 'alert',
        code: 'recovery-required',
        dualWriteState: 'idle', // should be prepared
        relationship: 'equal', // should be null
        recoveryRequired: false, // should be true
        alertRequired: true,
        nextAction: 'investigate-integrity',
        reasonCode: 'x',
      }),
    ];
    for (const bad of contradictions) {
      assert.throws(
        () => formatAuditIntegrityMonitorReportJson(/** @type {any} */ (bad)),
        TypeError,
      );
      assert.throws(
        () => auditIntegrityMonitorExitCode(/** @type {any} */ (bad)),
        TypeError,
      );
    }

    // Source-level: semantic consistency helper exists (no issuance bypass export)
    const src = await readFile(MONITOR_SRC, 'utf8');
    const semBody = extractFunctionBody(src, 'reportHasSemanticConsistency');
    assert.ok(semBody, 'reportHasSemanticConsistency must exist (private)');
    assert.ok(/healthy/.test(semBody));
    assert.ok(/recovery-required/.test(semBody));
    assert.ok(/uninitialized/.test(semBody));
    assert.ok(/state-missing/.test(semBody));
    assert.ok(/integrity-alert/.test(semBody));
    assert.ok(/io-alert/.test(semBody));
    assert.equal(/export\s+.*reportHasSemanticConsistency/.test(src), false);
    assert.equal(/export\s+.*ISSUED_MONITOR_REPORTS/.test(src), false);
    assert.equal(/export\s+.*freezeReport/.test(src), false);

    // Real issued reports from run still format + exit
    await withTempRoot('issued-ok', async (root) => {
      await ensureHealthyIdle(root);
      const healthy = await runWithFixedClock(root);
      assert.equal(healthy.status, 'healthy');
      const hText = formatAuditIntegrityMonitorReportJson(healthy);
      assert.ok(hText.endsWith('\n'));
      assert.deepEqual(JSON.parse(hText), { ...healthy });
      assert.equal(auditIntegrityMonitorExitCode(healthy), 0);

      // second run: independent issued object, same shape/keys
      const healthy2 = await runWithFixedClock(root);
      assert.deepEqual(Object.keys(healthy2), [...REPORT_KEYS]);
      assert.equal(formatAuditIntegrityMonitorReportJson(healthy2), hText);
      assert.equal(auditIntegrityMonitorExitCode(healthy2), 0);
      assert.ok(Object.isFrozen(healthy));
      assert.ok(Object.isFrozen(healthy2));
      // both remain independently formattable (WeakSet per object)
      assert.equal(auditIntegrityMonitorExitCode(healthy), 0);
      assert.equal(auditIntegrityMonitorExitCode(healthy2), 0);
    });

    await withTempRoot('issued-alert', async (root) => {
      const alert = await runWithFixedClock(root);
      assert.equal(alert.status, 'alert');
      assert.equal(alert.code, 'uninitialized');
      const aText = formatAuditIntegrityMonitorReportJson(alert);
      assert.ok(!aText.includes('/tmp/'));
      assert.deepEqual(JSON.parse(aText), { ...alert });
      assert.equal(auditIntegrityMonitorExitCode(alert), 2);
    });

    await withTempRoot('issued-recovery', async (root) => {
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_CRASH_HOOK,
      } = await loadCoordinator();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        }),
      );
      const prep = await runWithFixedClock(root);
      assert.equal(prep.code, 'recovery-required');
      assert.equal(formatAuditIntegrityMonitorReportJson(prep).endsWith('\n'), true);
      assert.equal(auditIntegrityMonitorExitCode(prep), 2);
    });
  });

  it('52. checkedAt Date round-trip also enforced on report validator path (regex-shaped invalid calendar rejected at issue time via clock; forge rejected by provenance)', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    const reportBody = extractFunctionBody(src, 'readValidFrozenReportValues');
    assert.ok(reportBody);
    // validator must Date round-trip checkedAt, not only regex
    assert.ok(/toISOString\s*\(/.test(reportBody));
    assert.ok(/CHECKED_AT_RE|checkedAt/.test(reportBody));

    const {
      formatAuditIntegrityMonitorReportJson,
      auditIntegrityMonitorExitCode,
    } = await loadMonitor();
    // forged with regex-shaped invalid calendar still unissued → TypeError
    const badClock = forgeFrozenExactReport({
      status: 'healthy',
      code: 'healthy',
      checkedAt: '2026-99-99T00:00:00.000Z',
      dualWriteState: 'idle',
      relationship: 'equal',
      recoveryRequired: false,
      alertRequired: false,
      nextAction: 'none',
      reasonCode: null,
    });
    assert.throws(
      () => formatAuditIntegrityMonitorReportJson(/** @type {any} */ (badClock)),
      TypeError,
    );
    assert.throws(
      () => auditIntegrityMonitorExitCode(/** @type {any} */ (badClock)),
      TypeError,
    );
  });

  it('53. mapObservationToReport: after values map, no secondary ordinary obs get (brace-aware body; mask comments/strings)', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    const mapBody = extractFunctionBody(src, 'mapObservationToReport');
    assert.ok(mapBody, 'mapObservationToReport body must exist');

    // must call values-returning validator (not boolean isValid*)
    assert.ok(
      /readValidFrozenObservationValues\s*\(/.test(mapBody),
      'map must call readValidFrozenObservationValues',
    );
    assert.equal(
      /isValidFrozenObservation\s*\(/.test(mapBody),
      false,
      'boolean isValidFrozenObservation must be gone',
    );
    // values map local only; fail-closed on null
    assert.ok(/\bconst\s+values\b/.test(mapBody) || /\blet\s+values\b/.test(mapBody));
    assert.ok(/values\s*==\s*null|values\s*===\s*null|!values\b/.test(mapBody));
    assert.ok(/failClosedMalformedReport/.test(mapBody));

    // Brace-aware body scan after mask — not whole-file fragile includes.
    // Secondary ordinary get would let a frozen hostile-get Proxy escape post-validation.
    const masked = maskJsNonCode(mapBody);
    assert.equal(
      /\bobs\s*\./.test(masked),
      false,
      'map body must not re-read obs.<field> after validation',
    );
    assert.equal(
      /\bobs\s*\[/.test(masked),
      false,
      'map body must not re-read obs[key] after validation',
    );
    assert.equal(
      /Reflect\.get\s*\(\s*obs\b/.test(masked),
      false,
      'map body must not Reflect.get(obs, ...) after validation',
    );
    // field reads must come from values map
    assert.ok(/values\.statePresence/.test(masked));
    assert.ok(/values\.reasonCode/.test(masked));
    assert.ok(/values\.relationship/.test(masked));

    // Static helper hostile canary: comment/string "obs.x" must not create false green/red.
    // maskJsNonCode blanks non-code; a body that ONLY has comment/string obs. must scan clean.
    const commentOnlyHostile = [
      'function mapObservationToReport(obs, checkedAt) {',
      '  const values = readValidFrozenObservationValues(obs);',
      '  // decoy: obs.statePresence / obs["reasonCode"] / Reflect.get(obs, "x")',
      '  const decoy = "obs.storesEmpty and obs[0] and Reflect.get(obs, k)";',
      '  if (values == null) return failClosedMalformedReport(checkedAt);',
      '  return values.statePresence;',
      '}',
    ].join('\n');
    const decoyBody = extractFunctionBody(commentOnlyHostile, 'mapObservationToReport');
    assert.ok(decoyBody);
    const decoyMasked = maskJsNonCode(decoyBody);
    assert.equal(
      /\bobs\s*\./.test(decoyMasked),
      false,
      'mask must blank comment/string obs. so canary is not false-red',
    );
    assert.equal(/\bobs\s*\[/.test(decoyMasked), false);
    assert.equal(/Reflect\.get\s*\(\s*obs\b/.test(decoyMasked), false);
    // real code access remains visible after mask
    const realLeak = 'function mapObservationToReport(obs, c) { return obs.statePresence; }';
    const leakBody = extractFunctionBody(realLeak, 'mapObservationToReport');
    assert.ok(leakBody);
    assert.equal(
      /\bobs\s*\./.test(maskJsNonCode(leakBody)),
      true,
      'real ordinary get must still be detected after mask',
    );
  });

  it('54. observation semantic validator: map-called; healthy locks stateStatus/storesEmpty/errorLayer; private; no inject hook', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    const mapBody = extractFunctionBody(src, 'mapObservationToReport');
    const semBody = extractFunctionBody(src, 'observationHasSemanticConsistency');
    assert.ok(mapBody, 'mapObservationToReport body must exist');
    assert.ok(semBody, 'observationHasSemanticConsistency must exist (private)');

    // map calls semantic validator after shape values, fail-closed on false
    // (mask blanks string literals; identifiers/calls survive)
    const mapMasked = maskJsNonCode(mapBody);
    assert.ok(
      /observationHasSemanticConsistency\s*\(\s*values\s*\)/.test(mapMasked),
      'map must call observationHasSemanticConsistency(values)',
    );
    assert.ok(
      /!observationHasSemanticConsistency\s*\(\s*values\s*\)/.test(mapMasked),
      'map must branch on semantic false',
    );
    assert.ok(/failClosedMalformedReport/.test(mapMasked));
    assert.equal(/export\s+.*observationHasSemanticConsistency/.test(src), false);
    assert.equal(/TEST_OBSERVATION|injectObservation|test-observation/.test(src), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(await loadMonitor(), 'observationHasSemanticConsistency'),
      false,
    );

    // healthy belt-and-suspenders: previously ignored fields must be code (not comments).
    // mask blanks string literals → compare identifiers + non-string RHS (false/null).
    assert.ok(/stateStatus\s*===/.test(mapMasked), 'healthy must compare stateStatus');
    assert.ok(/storesEmpty\s*===\s*false/.test(mapMasked), 'healthy must require storesEmpty===false');
    assert.ok(/errorLayer\s*===/.test(mapMasked), 'healthy must compare errorLayer');
    assert.ok(/cursorMatch\s*===/.test(mapMasked));
    assert.ok(/journalOutcome\s*===/.test(mapMasked));
    assert.ok(/crossStoreOutcome\s*===/.test(mapMasked));
    assert.ok(/reasonCode\s*===\s*null/.test(mapMasked));
    assert.ok(/HEALTHY_RELATIONSHIP/.test(mapMasked));
    // unmasked exact enum locks for healthy candidate (string values blanked by mask)
    assert.ok(/stateStatus\s*===\s*['"]idle['"]/.test(mapBody));
    assert.ok(/errorLayer\s*===\s*['"]none['"]/.test(mapBody));
    assert.ok(/cursorMatch\s*===\s*['"]match['"]/.test(mapBody));
    assert.ok(/journalOutcome\s*===\s*['"]verified['"]/.test(mapBody));
    assert.ok(/crossStoreOutcome\s*===\s*['"]ok['"]/.test(mapBody));

    // semantic matrix core locks (private structure; no ERROR_CODES list copy)
    const semMasked = maskJsNonCode(semBody);
    assert.ok(/statePresence/.test(semMasked));
    assert.ok(/stateStatus/.test(semMasked));
    assert.ok(/storesEmpty/.test(semMasked));
    assert.ok(/errorLayer/.test(semMasked));
    assert.ok(/endsWith\s*\(/.test(semMasked));
    // unmasked family tokens + structural -io-error suffix
    assert.ok(/['"]io-error['"]/.test(semBody));
    assert.ok(/['"]invalid['"]/.test(semBody));
    assert.ok(/['"]prepared['"]/.test(semBody));
    assert.ok(/['"]absent['"]/.test(semBody));
    assert.ok(/['"]idle['"]/.test(semBody));
    assert.ok(/-io-error/.test(semBody));
    assert.ok(/['"]uncovered-events['"]/.test(semBody));
    assert.ok(/['"]empty['"]/.test(semBody));
    assert.equal(/ERROR_CODES/.test(semBody), false);
    assert.equal(/audit-integrity-dual-write-state-invalid/.test(semBody), false);
  });

  it('55. hostile canary: comment/string-only stateStatus/storesEmpty/errorLayer cannot green the semantic/healthy scans', async () => {
    // Decoy: critical field names only in comments/strings — mask must blank them.
    const decoy = [
      'function mapObservationToReport(obs, checkedAt) {',
      '  const values = readValidFrozenObservationValues(obs);',
      '  // decoy: stateStatus storesEmpty errorLayer healthy idle none',
      '  const s = "stateStatus===\\"idle\\" && storesEmpty===false && errorLayer===\\"none\\"";',
      '  if (values == null) return failClosedMalformedReport(checkedAt);',
      '  // no real observationHasSemanticConsistency call',
      '  if (values.cursorMatch === "match") {',
      '    return freezeReport({ status: "healthy", code: "healthy" });',
      '  }',
      '  return failClosedMalformedReport(checkedAt);',
      '}',
      'function observationHasSemanticConsistency(values) {',
      '  // decoy matrix: io-error invalid prepared absent idle storesEmpty',
      '  const t = "stateStatus idle storesEmpty false errorLayer none";',
      '  return true;',
      '}',
    ].join('\n');

    const decoyMap = extractFunctionBody(decoy, 'mapObservationToReport');
    const decoySem = extractFunctionBody(decoy, 'observationHasSemanticConsistency');
    assert.ok(decoyMap);
    assert.ok(decoySem);
    const decoyMapMasked = maskJsNonCode(decoyMap);
    const decoySemMasked = maskJsNonCode(decoySem);

    // Production robust canaries (test 54) must FAIL on this decoy — not false-green
    assert.equal(
      /observationHasSemanticConsistency\s*\(\s*values\s*\)/.test(decoyMapMasked),
      false,
      'decoy map must not contain real semantic call after mask',
    );
    assert.equal(
      /stateStatus\s*===/.test(decoyMapMasked),
      false,
      'string/comment-only stateStatus must not pass healthy canary after mask',
    );
    assert.equal(
      /storesEmpty\s*===\s*false/.test(decoyMapMasked),
      false,
      'string-only storesEmpty===false must not pass healthy canary after mask',
    );
    assert.equal(
      /errorLayer\s*===/.test(decoyMapMasked),
      false,
      'string/comment-only errorLayer must not pass healthy canary after mask',
    );
    assert.equal(/storesEmpty/.test(decoySemMasked), false);
    assert.equal(/errorLayer/.test(decoySemMasked), false);

    // Same predicates pass on real production bodies
    const src = await readFile(MONITOR_SRC, 'utf8');
    const mapBody = extractFunctionBody(src, 'mapObservationToReport');
    const mapMasked = maskJsNonCode(mapBody);
    assert.ok(/observationHasSemanticConsistency\s*\(\s*values\s*\)/.test(mapMasked));
    assert.ok(/stateStatus\s*===/.test(mapMasked));
    assert.ok(/storesEmpty\s*===\s*false/.test(mapMasked));
    assert.ok(/errorLayer\s*===/.test(mapMasked));
    const semBody = extractFunctionBody(src, 'observationHasSemanticConsistency');
    const semMasked = maskJsNonCode(semBody);
    assert.ok(/storesEmpty/.test(semMasked));
    assert.ok(/errorLayer/.test(semMasked));
  });

  it('56. semantic matrix private structure locks malformed legal-enum combos fail-closed; real families still pass', async () => {
    const src = await readFile(MONITOR_SRC, 'utf8');
    const semBody = extractFunctionBody(src, 'observationHasSemanticConsistency');
    const mapBody = extractFunctionBody(src, 'mapObservationToReport');
    assert.ok(semBody);
    assert.ok(mapBody);
    const semMasked = maskJsNonCode(semBody);

    // presence/status / storesEmpty coherence as real code (mask-safe identifiers)
    assert.ok(/statePresence/.test(semMasked));
    assert.ok(/stateStatus/.test(semMasked));
    assert.ok(/storesEmpty\s*===\s*true/.test(semMasked));
    assert.ok(/storesEmpty\s*===\s*false|storesEmpty\s*!==\s*false/.test(semMasked));
    assert.ok(/cursorMatch\s*===/.test(semMasked));
    assert.ok(/journalOutcome\s*===/.test(semMasked));
    assert.ok(/crossStoreOutcome\s*===/.test(semMasked));
    assert.ok(/endsWith\s*\(/.test(semMasked));
    assert.ok(/errorLayer\s*===/.test(semMasked));
    assert.ok(/reasonCode\s*!==\s*null/.test(semMasked));
    assert.ok(/reasonCode\s*===\s*null/.test(semMasked));
    // unmasked exact family tokens (malformed legal-enum combos closed by these rules)
    assert.ok(/statePresence\s*===\s*['"]idle['"]/.test(semBody));
    assert.ok(/statePresence\s*===\s*['"]prepared['"]/.test(semBody));
    assert.ok(/statePresence\s*===\s*['"]io-error['"]/.test(semBody));
    assert.ok(/statePresence\s*===\s*['"]invalid['"]/.test(semBody));
    assert.ok(/statePresence\s*===\s*['"]absent['"]/.test(semBody));
    assert.ok(/statePresence\s*!==\s*['"]absent['"]/.test(semBody));
    assert.ok(/cursorMatch\s*===\s*['"]skipped['"]/.test(semBody));
    assert.ok(/cursorMatch\s*===\s*['"]match['"]/.test(semBody));
    assert.ok(/journalOutcome\s*===\s*['"]verified['"]/.test(semBody));
    assert.ok(/crossStoreOutcome\s*===\s*['"]ok['"]/.test(semBody));
    assert.ok(/endsWith\s*\(\s*['"]-io-error['"]\s*\)/.test(semBody));
    assert.ok(/errorLayer\s*===\s*['"]state['"]/.test(semBody));
    assert.ok(/errorLayer\s*===\s*['"]root['"]/.test(semBody));
    assert.ok(/errorLayer\s*===\s*['"]none['"]/.test(semBody));
    assert.ok(/['"]uncovered-events['"]/.test(semBody));
    assert.ok(/['"]empty['"]/.test(semBody));
    // idle typed: forbids match+verified+ok while reason non-null (false-healthy close)
    assert.ok(
      /reasonCode\s*!==\s*null[\s\S]*cursorMatch\s*===\s*['"]match['"][\s\S]*journalOutcome\s*===\s*['"]verified['"][\s\S]*crossStoreOutcome\s*===\s*['"]ok['"]/.test(
        semBody,
      )
        || /cursorMatch\s*===\s*['"]match['"][\s\S]*journalOutcome\s*===\s*['"]verified['"][\s\S]*crossStoreOutcome\s*===\s*['"]ok['"][\s\S]*return\s+false/.test(
          semBody,
        ),
      'typed idle must reject full healthy probes',
    );

    // map: semantic gate precedes healthy emission
    const mapMasked = maskJsNonCode(mapBody);
    const semCallIdx = mapMasked.search(/observationHasSemanticConsistency\s*\(\s*values\s*\)/);
    // status:'healthy' string is blanked by mask — search unmasked for construction order
    const semCallIdxRaw = mapBody.search(/observationHasSemanticConsistency\s*\(\s*values\s*\)/);
    const healthyIdxRaw = mapBody.search(/status:\s*['"]healthy['"]/);
    assert.ok(semCallIdx >= 0, 'semantic call present after mask');
    assert.ok(semCallIdxRaw >= 0 && healthyIdxRaw >= 0);
    assert.ok(
      semCallIdxRaw < healthyIdxRaw,
      'semantic gate must precede any healthy report construction',
    );

    // Real reachable families still green (integration; no observation inject)
    await withTempRoot('sem-healthy', async (root) => {
      await ensureHealthyIdle(root);
      const report = await runWithFixedClock(root);
      assert.equal(report.status, 'healthy');
      assert.equal(report.code, 'healthy');
      assert.equal(report.reasonCode, null);
      const { auditIntegrityMonitorExitCode } = await loadMonitor();
      assert.equal(auditIntegrityMonitorExitCode(report), 0);
    });

    await withTempRoot('sem-empty', async (root) => {
      const { recoverAuditIntegrityDualWrite } = await loadCoordinator();
      await recoverAuditIntegrityDualWrite(root);
      const report = await runWithFixedClock(root);
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.relationship, 'empty');
      assert.equal(report.reasonCode, null);
    });

    await withTempRoot('sem-uncovered', async (root) => {
      const { recoverAuditIntegrityDualWrite } = await loadCoordinator();
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
      const report = await runWithFixedClock(root);
      assert.equal(report.code, 'integrity-alert');
      assert.equal(report.relationship, 'uncovered-events');
    });

    await withTempRoot('sem-prepared', async (root) => {
      const {
        appendAuditEventWithIntegrityDualWrite,
        DUAL_WRITE_TEST_CRASH_HOOK,
      } = await loadCoordinator();
      await assert.rejects(
        () => appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A }, {
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        }),
      );
      const report = await runWithFixedClock(root);
      assert.equal(report.code, 'recovery-required');
      assert.equal(report.dualWriteState, 'prepared');
      assert.equal(report.relationship, null);
    });

    await withTempRoot('sem-io', async (root) => {
      const outside = await mkdtempSafe('sem-io-out');
      try {
        const target = join(outside, 'target.json');
        await writeFile(target, '{"x":1}\n', { mode: 0o600 });
        await mkdir(join(root, 'audit'), { recursive: true });
        await symlink(target, stateAbs(root));
        const report = await runWithFixedClock(root);
        assert.equal(report.code, 'io-alert');
        assert.equal(report.dualWriteState, 'unknown');
        assert.equal(report.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    await withTempRoot('sem-absent-typed', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      // journal present but broken (typed) while state absent → #2b
      await writeFile(journalAbs(root), '{not-json\n', { mode: 0o600 });
      await writeFile(eventsAbs(root), eventLine(EVENT_A), { mode: 0o600 });
      const report = await runWithFixedClock(root);
      assert.equal(report.status, 'alert');
      assert.notEqual(report.code, 'state-missing');
      assert.notEqual(report.code, 'healthy');
      assert.equal(report.dualWriteState, 'missing');
      assert.equal(report.relationship, null);
      assert.ok(report.reasonCode !== null);
    });

    await withTempRoot('sem-cold', async (root) => {
      const report = await runWithFixedClock(root);
      assert.equal(report.code, 'uninitialized');
      assert.equal(report.relationship, null);
      assert.equal(report.reasonCode, null);
    });
  });
});
