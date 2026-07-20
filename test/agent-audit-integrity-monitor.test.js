/**
 * V1.38 C3: agent CLI wiring for audit-integrity-monitor
 *
 * Real subprocess spawn of `node src/agent.js` only.
 * Tests use mkdtemp(tmpdir()) — never write into the repo.
 * No production test-injection; no package-lock edits.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ERROR_CODES } from '../src/error-codes.js';
import { stringifyStrictCanonicalSanitizedEvent } from '../src/audit-event-schema.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const AGENT_SRC = join(REPO_ROOT, 'src', 'agent.js');
const SERVER_SRC = join(REPO_ROOT, 'src', 'server.js');
const CMD = 'audit-integrity-monitor';

const GENERATION_ID = '0123456789abcdef0123456789abcdef';
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

const HEALTHY_RELS = new Set([
  'equal',
  'events-suffix-of-journal',
  'journal-suffix-of-events',
]);

const INVALID_ARGS_STDERR = 'Error: audit-integrity-monitor arguments are invalid\n';
const EXECUTION_FAILED_STDERR = 'Error: audit-integrity-monitor failed\n';

function cleanEnv() {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

async function runAgent(argv) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [AGENT_SRC, ...argv], {
      env: cleanEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    if (typeof err.code === 'number') {
      return {
        code: err.code,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      };
    }
    throw err;
  }
}

async function mkdtempSafe(prefix) {
  return mkdtemp(join(tmpdir(), `linke-aim-c3-${prefix}-`));
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

async function loadJournal() {
  return import('../src/audit-integrity-journal.js');
}

async function ensureHealthyIdle(root) {
  const { appendAuditEventWithIntegrityDualWrite } = await loadCoordinator();
  await appendAuditEventWithIntegrityDualWrite(root, { ...EVENT_A });
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

function assertSingleLineJson(stdout) {
  assert.equal(typeof stdout, 'string');
  assert.ok(stdout.endsWith('\n'));
  assert.equal(stdout.indexOf('\n'), stdout.length - 1);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), [...REPORT_KEYS]);
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(ISO_RE.test(parsed.checkedAt));
  assert.equal(new Date(parsed.checkedAt).toISOString(), parsed.checkedAt);
  return parsed;
}

function assertNoLeak(text, extraNeedles = []) {
  const s = String(text);
  assert.ok(!s.includes('/tmp/'));
  assert.ok(!s.includes('/private/'));
  assert.ok(!s.includes('Users/'));
  assert.ok(!s.includes('Bearer'));
  assert.ok(!/stack/i.test(s) || !s.includes('at '));
  assert.ok(!s.includes('ENOENT'));
  assert.ok(!s.includes('EACCES'));
  assert.ok(!s.includes('errno'));
  for (const n of extraNeedles) {
    assert.ok(!s.includes(n), `must not leak ${n}`);
  }
}

function assertInvalidArgs(result, extraNeedles = []) {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, INVALID_ARGS_STDERR);
  assertNoLeak(result.stderr, extraNeedles);
}

/**
 * Mask JS comments/strings so static locks cannot pass on string/comment decoys.
 * @param {string} source
 * @returns {string}
 */
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

/**
 * Strip // and /* *\/ comments only — keep string literals so case labels remain visible.
 * Prevents comment decoys from counting as real switch cases.
 * @param {string} source
 * @returns {string}
 */
function stripJsCommentsKeepStrings(source) {
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
      out += s[i];
      i += 1;
      while (i < s.length) {
        out += s[i];
        if (s[i] === '\\') {
          i += 1;
          if (i < s.length) {
            out += s[i];
            i += 1;
          }
          continue;
        }
        if (s[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

function countCaseOccurrences(source, commandName) {
  // Case labels are string literals; strip comments only so decoy // case 'x': cannot fake.
  const code = stripJsCommentsKeepStrings(source);
  const re = new RegExp(
    `case\\s+['"]${commandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*:`,
    'g',
  );
  return (code.match(re) || []).length;
}

// ── Suite ──────────────────────────────────────────────────────────────

describe('C3 agent audit-integrity-monitor CLI', () => {
  it('1. healthy fixture → exit0, exact 10-key JSON, status/code healthy, stderr empty, single line+newline', async () => {
    await withTempRoot('healthy', async (root) => {
      await ensureHealthyIdle(root);
      const result = await runAgent([CMD, '--data-dir', root]);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const body = assertSingleLineJson(result.stdout);
      assert.equal(body.status, 'healthy');
      assert.equal(body.code, 'healthy');
      assert.equal(body.dualWriteState, 'idle');
      assert.ok(HEALTHY_RELS.has(body.relationship), `rel=${body.relationship}`);
      assert.equal(body.recoveryRequired, false);
      assert.equal(body.alertRequired, false);
      assert.equal(body.nextAction, 'none');
      assert.equal(body.reasonCode, null);
      assert.ok(!result.stdout.includes(root));
    });
  });

  it('2. cold empty → exit2, uninitialized, relationship null', async () => {
    await withTempRoot('cold', async (root) => {
      const result = await runAgent([CMD, '--data-dir', root]);
      assert.equal(result.code, 2);
      assert.equal(result.stderr, '');
      const body = assertSingleLineJson(result.stdout);
      assert.equal(body.status, 'alert');
      assert.equal(body.code, 'uninitialized');
      assert.equal(body.dualWriteState, 'missing');
      assert.equal(body.relationship, null);
      assert.equal(body.recoveryRequired, false);
      assert.equal(body.alertRequired, true);
      assert.equal(body.nextAction, 'initialize-via-production-write');
      assert.equal(body.reasonCode, null);
      assert.ok(!result.stdout.includes(root));
    });
  });

  it('3. prepared fixture → exit2 recovery-required; prepared bytes/dir snapshot unchanged', async () => {
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
      const beforeEntries = await readdir(root, { recursive: true });
      const result = await runAgent([CMD, '--data-dir', root]);
      assert.equal(result.code, 2);
      assert.equal(result.stderr, '');
      const body = assertSingleLineJson(result.stdout);
      assert.equal(body.status, 'alert');
      assert.equal(body.code, 'recovery-required');
      assert.equal(body.dualWriteState, 'prepared');
      assert.equal(body.relationship, null);
      assert.equal(body.recoveryRequired, true);
      assert.equal(body.alertRequired, true);
      assert.equal(body.nextAction, 'run-explicit-recovery');
      assert.equal(body.reasonCode, null);
      assertSnapEqual(await snapshotTriple(root), before);
      assert.deepEqual(await readdir(root, { recursive: true }), beforeEntries);
      assert.ok(!result.stdout.includes(root));
    });
  });

  it('4. state-missing fixture → exit2', async () => {
    await withTempRoot('s-miss', async (root) => {
      const { initializeAuditIntegrityJournal, appendAuditIntegrityEvent } = await loadJournal();
      await initializeAuditIntegrityJournal(root, { generationId: GENERATION_ID });
      await appendAuditIntegrityEvent(root, { generationId: GENERATION_ID, event: { ...EVENT_A } });
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(eventsAbs(root), eventLine(EVENT_A), { mode: 0o600 });
      await assert.rejects(() => access(stateAbs(root)), { code: 'ENOENT' });

      const result = await runAgent([CMD, '--data-dir', root]);
      assert.equal(result.code, 2);
      assert.equal(result.stderr, '');
      const body = assertSingleLineJson(result.stdout);
      assert.equal(body.status, 'alert');
      assert.equal(body.code, 'state-missing');
      assert.equal(body.dualWriteState, 'missing');
      assert.ok(!result.stdout.includes(root));
    });
  });

  it('5. integrity fixture (cursor mismatch) → exit2 integrity-alert', async () => {
    await withTempRoot('cursor-mm', async (root) => {
      await ensureHealthyIdle(root);
      await writeFile(eventsAbs(root), eventLine(EVENT_B), { mode: 0o600 });
      const result = await runAgent([CMD, '--data-dir', root]);
      assert.equal(result.code, 2);
      assert.equal(result.stderr, '');
      const body = assertSingleLineJson(result.stdout);
      assert.equal(body.status, 'alert');
      assert.equal(body.code, 'integrity-alert');
      assert.equal(body.dualWriteState, 'idle');
      assert.equal(body.relationship, null);
      assert.equal(body.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
      assert.equal(body.nextAction, 'investigate-integrity');
      assert.ok(!result.stdout.includes(root));
    });
  });

  it('6. missing --data-dir → exit1 fixed stderr/stdout empty', async () => {
    const result = await runAgent([CMD]);
    assertInvalidArgs(result);
  });

  it('7. --data-dir without value → exit1', async () => {
    const result = await runAgent([CMD, '--data-dir']);
    assertInvalidArgs(result);
  });

  it('8. duplicate --data-dir a --data-dir b → exit1', async () => {
    await withTempRoot('dup', async (root) => {
      const other = join(root, 'other');
      await mkdir(other);
      const result = await runAgent([CMD, '--data-dir', root, '--data-dir', other]);
      assertInvalidArgs(result, [root, other]);
    });
  });

  it('9. extra positional before/after → exit1', async () => {
    await withTempRoot('pos', async (root) => {
      // Leading positional makes args._[0] a different command → unknown-command path.
      // Still exit 1 and must not emit a monitor JSON report or echo dataDir.
      const before = await runAgent(['extra', CMD, '--data-dir', root]);
      assert.equal(before.code, 1);
      assert.equal(before.stdout.includes('"schemaVersion"'), false);
      assert.equal(before.stdout.includes('"status"'), false);
      assert.ok(!before.stdout.includes(root));
      assert.ok(!before.stderr.includes(root));

      // Trailing positional keeps command = audit-integrity-monitor → local validator.
      const after = await runAgent([CMD, '--data-dir', root, 'extra']);
      assertInvalidArgs(after, [root, 'extra']);
    });
  });

  it('10. --recover → exit1', async () => {
    await withTempRoot('recover', async (root) => {
      const result = await runAgent([CMD, '--data-dir', root, '--recover']);
      assertInvalidArgs(result, [root]);
    });
  });

  it('11. --token x and bare --token → exit1, token not leaked', async () => {
    await withTempRoot('token', async (root) => {
      const secret = 'super-secret-token-value-c3';
      const withValue = await runAgent([CMD, '--data-dir', root, '--token', secret]);
      assertInvalidArgs(withValue, [root, secret]);
      const bare = await runAgent([CMD, '--data-dir', root, '--token']);
      assertInvalidArgs(bare, [root, '--token requires a value']);
    });
  });

  it('12. --fail-on-blocked → exit1', async () => {
    await withTempRoot('fob', async (root) => {
      const result = await runAgent([CMD, '--data-dir', root, '--fail-on-blocked']);
      assertInvalidArgs(result, [root]);
    });
  });

  it('13. --server x → exit1', async () => {
    await withTempRoot('server', async (root) => {
      const result = await runAgent([
        CMD,
        '--data-dir',
        root,
        '--server',
        'http://127.0.0.1:9',
      ]);
      assertInvalidArgs(result, [root, 'http://127.0.0.1:9']);
    });
  });

  it('14. --output x → exit1', async () => {
    await withTempRoot('output', async (root) => {
      const out = join(root, 'out.json');
      const result = await runAgent([CMD, '--data-dir', root, '--output', out]);
      assertInvalidArgs(result, [root, out]);
    });
  });

  it('15. --help / --h mixed with command → exit1 (not early help bypass)', async () => {
    await withTempRoot('help-mix', async (root) => {
      const help = await runAgent([CMD, '--data-dir', root, '--help']);
      assertInvalidArgs(help, [root]);
      assert.ok(!help.stdout.includes('Linke Agent CLI'));
      const h = await runAgent([CMD, '--h', '--data-dir', root]);
      assertInvalidArgs(h, [root]);
      assert.ok(!h.stdout.includes('Linke Agent CLI'));
    });
  });

  it('16. arbitrary unknown flag (with/without value) → exit1', async () => {
    await withTempRoot('unk', async (root) => {
      const withVal = await runAgent([CMD, '--data-dir', root, '--weird-flag', 'x']);
      assertInvalidArgs(withVal, [root, 'weird-flag', 'x']);
      const bare = await runAgent([CMD, '--data-dir', root, '--weird-flag']);
      assertInvalidArgs(bare, [root, 'weird-flag']);
    });
  });

  it('17. --data-dir empty string and pure whitespace → exit1', async () => {
    const empty = await runAgent([CMD, '--data-dir', '']);
    assertInvalidArgs(empty);
    const ws = await runAgent([CMD, '--data-dir', '   \t  ']);
    assertInvalidArgs(ws);
  });

  it('18. stdout alert/healthy never contain absolute dataDir; stderr invalid never path/token/stack/errno', async () => {
    await withTempRoot('noleak', async (root) => {
      await ensureHealthyIdle(root);
      const healthy = await runAgent([CMD, '--data-dir', root]);
      assert.equal(healthy.code, 0);
      assert.ok(!healthy.stdout.includes(root));
      assertNoLeak(healthy.stdout, [root]);

      const alert = await runAgent([CMD, '--data-dir', root, '--token', 'leak-me-token']);
      assertInvalidArgs(alert, [root, 'leak-me-token']);
    });
  });

  it('19. bare --help (no command) → exit0, help contains command; no remote/scheduler delivered claim', async () => {
    const result = await runAgent(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /audit-integrity-monitor/);
    assert.match(result.stdout, /--data-dir/);
    assert.equal(/remote\s+alert/i.test(result.stdout), false);
    assert.equal(/scheduler/i.test(result.stdout), false);
    assert.equal(/production\s+monitoring\s+ready/i.test(result.stdout), false);
    assert.equal(/T6d\s+complete/i.test(result.stdout), false);
    assert.equal(/Gold\s+complete/i.test(result.stdout), false);
  });

  it('20. cold dir before/after still empty (zero write)', async () => {
    await withTempRoot('zw', async (root) => {
      const before = await readdir(root);
      assert.deepEqual(before, []);
      const result = await runAgent([CMD, '--data-dir', root]);
      assert.equal(result.code, 2);
      const after = await readdir(root);
      assert.deepEqual(after, []);
      await assert.rejects(() => access(join(root, 'audit')), { code: 'ENOENT' });
    });
  });

  it('21. exact-one switch case; agent imports only 3 public monitor APIs; server zero wiring (anti comment/string fake-green)', async () => {
    const agentSrc = await readFile(AGENT_SRC, 'utf8');
    const serverSrc = await readFile(SERVER_SRC, 'utf8');
    const agentMasked = maskJsNonCode(agentSrc);
    const serverMasked = maskJsNonCode(serverSrc);

    assert.equal(countCaseOccurrences(agentSrc, CMD), 1);

    const importRe =
      /import\s*\{([^}]+)\}\s*from\s*['"]\.\/audit-integrity-monitor\.js['"]/;
    const importMatch = agentSrc.match(importRe);
    assert.ok(importMatch, 'must import from ./audit-integrity-monitor.js');
    const names = importMatch[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    assert.deepEqual(
      names.sort(),
      [
        'auditIntegrityMonitorExitCode',
        'formatAuditIntegrityMonitorReportJson',
        'runAuditIntegrityMonitor',
      ].sort(),
    );
    assert.equal(names.length, 3);

    // code-path call sites (not string/comment decoys)
    assert.ok(/\brunAuditIntegrityMonitor\s*\(/.test(agentMasked));
    assert.ok(/\bauditIntegrityMonitorExitCode\s*\(/.test(agentMasked));
    assert.ok(/\bformatAuditIntegrityMonitorReportJson\s*\(/.test(agentMasked));

    // server must not wire monitor (masked ignores comment/string decoys)
    assert.equal(/\baudit-integrity-monitor\b/.test(serverSrc), false);
    assert.equal(/\brunAuditIntegrityMonitor\b/.test(serverMasked), false);
    assert.equal(/\bauditIntegrityMonitorExitCode\b/.test(serverMasked), false);
    assert.equal(/\bformatAuditIntegrityMonitorReportJson\b/.test(serverMasked), false);
    assert.equal(/audit-integrity-monitor\.js/.test(serverSrc), false);
  });

  it('22. valid argv + nonexistent path → exit2 io-alert/unknown/dual-write-io-error; stdout no path; no root create', async () => {
    const missing = join(
      tmpdir(),
      `linke-aim-c3-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const result = await runAgent([CMD, '--data-dir', missing]);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, '');
    const body = assertSingleLineJson(result.stdout);
    assert.equal(body.status, 'alert');
    assert.equal(body.code, 'io-alert');
    assert.equal(body.dualWriteState, 'unknown');
    assert.equal(body.relationship, null);
    assert.equal(body.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
    assert.ok(!result.stdout.includes(missing));
    await assert.rejects(() => access(missing), { code: 'ENOENT' });
  });

  it('23. valid argv + existing regular file (non-directory RootFail) → exit2 io-alert; file unmodified', async () => {
    await withTempRoot('root-file', async (root) => {
      const filePath = join(root, 'not-a-dir');
      const payload = 'keep-me-unmodified\n';
      await writeFile(filePath, payload, { mode: 0o600 });
      const before = await readFile(filePath);
      const result = await runAgent([CMD, '--data-dir', filePath]);
      assert.equal(result.code, 2);
      assert.equal(result.stderr, '');
      const body = assertSingleLineJson(result.stdout);
      assert.equal(body.status, 'alert');
      assert.equal(body.code, 'io-alert');
      assert.equal(body.dualWriteState, 'unknown');
      assert.equal(body.reasonCode, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR);
      assert.ok(!result.stdout.includes(filePath));
      assert.deepEqual(await readFile(filePath), before);
      const st = await lstat(filePath);
      assert.ok(st.isFile());
    });
  });

  it('24. --data-dir value starting with -- becomes boolean + unknown flag → exit1', async () => {
    const result = await runAgent([CMD, '--data-dir', '--sneaky-path']);
    assertInvalidArgs(result, ['--sneaky-path']);
  });

  it('25. ERROR_CODES count remains 60', () => {
    assert.equal(Object.keys(ERROR_CODES).length, 60);
  });

  it('26. regression: bare --h exit0; health still accepts --token value semantics elsewhere', async () => {
    const helpH = await runAgent(['--h']);
    assert.equal(helpH.code, 0);
    assert.match(helpH.stdout, /audit-integrity-monitor/);

    // other commands still get the global token-requires-value error, not our fixed phrase
    const tokenBare = await runAgent(['health', '--token']);
    assert.equal(tokenBare.code, 1);
    assert.match(tokenBare.stderr, /--token requires a value/);
    assert.notEqual(tokenBare.stderr, INVALID_ARGS_STDERR);
  });

  it('27. --__proto__ unknown flag must not bypass allowlist (exit1 fixed; no root create; no leak)', async () => {
    const missing = join(
      tmpdir(),
      `linke-aim-c3-proto-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const injected = 'injected';

    // Standalone P1 canary: parseArgs legacy __proto__ setter swallows Object.keys visibility.
    const withValue = await runAgent([CMD, '--data-dir', missing, '--__proto__', injected]);
    assertInvalidArgs(withValue, [missing, injected, '__proto__']);
    await assert.rejects(() => access(missing), { code: 'ENOENT' });

    // bare --__proto__ (boolean form) also fixed exit1
    const bareProto = await runAgent([CMD, '--data-dir', missing, '--__proto__']);
    assertInvalidArgs(bareProto, [missing, '__proto__']);
    await assert.rejects(() => access(missing), { code: 'ENOENT' });

    // related prototype-adjacent flag names still exit1 (unknown / not exact 3-token form)
    await withTempRoot('proto-adj', async (root) => {
      const ctor = await runAgent([CMD, '--data-dir', root, '--constructor', 'x']);
      assertInvalidArgs(ctor, [root, 'constructor']);
      const toStr = await runAgent([CMD, '--data-dir', root, '--toString']);
      assertInvalidArgs(toStr, [root, 'toString']);
    });
  });

  it('28. post-validation unexpected throw → fixed desensitized exit1 (no raw err.message leak)', async () => {
    await withTempRoot('post-val', async (root) => {
      // Independent harness: import main, legal 3-token argv, then force stdout.write throw
      // after validator + monitor produce a report (cold root → alert JSON path).
      const agentUrl = pathToFileURL(AGENT_SRC).href;
      const script = `
import { main } from ${JSON.stringify(agentUrl)};
const root = process.argv[1];
const secret = 'secret-post-validation ' + root + ' token-value';
process.argv = [
  process.argv[0],
  ${JSON.stringify(AGENT_SRC)},
  ${JSON.stringify(CMD)},
  '--data-dir',
  root,
];
process.stdout.write = function stdoutWriteTrap() {
  throw new Error(secret);
};
await main();
`;
      let result;
      try {
        const { stdout, stderr } = await execFileAsync(
          'node',
          ['--input-type=module', '-e', script, root],
          {
            env: cleanEnv(),
            maxBuffer: 4 * 1024 * 1024,
            cwd: REPO_ROOT,
          },
        );
        result = { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
      } catch (err) {
        if (typeof err.code !== 'number') throw err;
        result = {
          code: err.code,
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
        };
      }

      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, EXECUTION_FAILED_STDERR);
      assert.ok(!result.stderr.includes(root));
      assert.ok(!result.stderr.includes('secret-post-validation'));
      assert.ok(!result.stderr.includes('token-value'));
      assert.ok(!result.stderr.includes('/tmp/'));
      assert.ok(!result.stderr.includes('/private/'));
      assert.ok(!result.stderr.includes('ENOENT'));
      assert.ok(!result.stderr.includes('errno'));
      assert.ok(!/at\s+\S+/.test(result.stderr));
      // must not forge alert JSON / arguments-invalid phrase
      assert.ok(!result.stdout.includes('schemaVersion'));
      assert.notEqual(result.stderr, INVALID_ARGS_STDERR);
    });
  });
});
