import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
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
import {
  AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
  readAuditIntegrityAlertOutbox,
} from '../src/audit-integrity-alert-outbox.js';
import { appendAuditEventWithIntegrityDualWrite } from '../src/audit-integrity-dual-write.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const AGENT_SRC = join(REPO_ROOT, 'src', 'agent.js');
const SERVER_SRC = join(REPO_ROOT, 'src', 'server.js');
const COMMAND = 'audit-integrity-alert-capture';
const INVALID = `Error: ${COMMAND} arguments are invalid\n`;
const REFUSED = `Error: ${COMMAND} refused\n`;

function cleanEnv() {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

async function runAgent(argv) {
  try {
    const result = await execFileAsync('node', [AGENT_SRC, ...argv], {
      env: cleanEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    if (typeof error.code === 'number') {
      return {
        code: error.code,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      };
    }
    throw error;
  }
}

async function withTempRoot(label, callback) {
  const root = await mkdtemp(join(tmpdir(), `linke-aic-${label}-`));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseSingleJsonLine(stdout) {
  assert.ok(stdout.endsWith('\n'));
  assert.equal(stdout.slice(0, -1).includes('\n'), false);
  return JSON.parse(stdout);
}

async function snapshotAuditFiles(root) {
  const auditDir = join(root, 'audit');
  const names = (await readdir(auditDir)).sort();
  const files = {};
  for (const name of names) {
    files[name] = (await readFile(join(auditDir, name))).toString('hex');
  }
  return { names, files };
}

describe('Agent audit-integrity-alert-capture CLI', () => {
  it('queues a cold-root alert once, prints a compact receipt, and exits 2', async () => {
    await withTempRoot('cold', async (root) => {
      const result = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(result.code, 2);
      assert.equal(result.stderr, '');
      assert.deepEqual(parseSingleJsonLine(result.stdout), {
        schemaVersion: 1,
        status: 'queued',
        queued: true,
        sequence: 1,
        pendingCount: 1,
      });
      assert.equal(result.stdout.includes(root), false);

      const state = await readAuditIntegrityAlertOutbox(root);
      assert.equal(state.nextSequence, 2);
      assert.equal(state.entries.length, 1);
      assert.equal(state.entries[0].code, 'uninitialized');
      assert.deepEqual((await readdir(join(root, 'audit'))).sort(), [
        'integrity-alert-outbox.json',
        'integrity-write.lock',
      ]);
    });
  });

  it('preserves repeated explicit capture occurrences', async () => {
    await withTempRoot('repeat', async (root) => {
      const first = await runAgent([COMMAND, '--data-dir', root]);
      const second = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(first.code, 2);
      assert.equal(second.code, 2);
      assert.equal(parseSingleJsonLine(first.stdout).sequence, 1);
      assert.equal(parseSingleJsonLine(second.stdout).sequence, 2);
      const state = await readAuditIntegrityAlertOutbox(root);
      assert.deepEqual(state.entries.map((entry) => entry.sequence), [1, 2]);
    });
  });

  it('returns ignored-healthy at exit 0 without creating the outbox', async () => {
    await withTempRoot('healthy', async (root) => {
      await appendAuditEventWithIntegrityDualWrite(root, {
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-08-04T12:00:00.000Z',
        type: 'api.test',
        method: 'GET',
        path: '/api/test',
        outcome: 'success',
      });
      const before = await snapshotAuditFiles(root);
      const result = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.deepEqual(parseSingleJsonLine(result.stdout), {
        schemaVersion: 1,
        status: 'ignored-healthy',
        queued: false,
        sequence: null,
        pendingCount: null,
      });
      await assert.rejects(
        () => access(join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH)),
        { code: 'ENOENT' },
      );
      assert.deepEqual(await snapshotAuditFiles(root), before);
    });
  });

  it('keeps the original monitor command read-only', async () => {
    await withTempRoot('monitor', async (root) => {
      const result = await runAgent(['audit-integrity-monitor', '--data-dir', root]);
      assert.equal(result.code, 2);
      assert.equal(result.stderr, '');
      await assert.rejects(
        () => access(join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH)),
        { code: 'ENOENT' },
      );
    });
  });

  it('rejects invalid argv early with one fixed path-free message', async () => {
    await withTempRoot('argv', async (root) => {
      const samples = [
        [COMMAND],
        [COMMAND, '--data-dir'],
        [COMMAND, '--data-dir', ''],
        [COMMAND, '--data-dir', '--token'],
        [COMMAND, '--data-dir', root, '--token', 'sentinel-secret'],
        [COMMAND, '--data-dir', root, 'extra'],
      ];
      for (const argv of samples) {
        const result = await runAgent(argv);
        assert.equal(result.code, 1, argv.join(' '));
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, INVALID);
        assert.equal(result.stderr.includes(root), false);
        assert.equal(result.stderr.includes('sentinel-secret'), false);
      }
    });
  });

  it('maps an unsafe outbox leaf to a fixed refusal without touching its target', async () => {
    await withTempRoot('symlink', async (root) => {
      const outside = join(root, 'outside-probe');
      await writeFile(outside, 'keep\n', { mode: 0o600 });
      await mkdir(join(root, 'audit'));
      await symlink(outside, join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH));

      const result = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, REFUSED);
      assert.equal(result.stderr.includes(root), false);
      assert.equal(await readFile(outside, 'utf8'), 'keep\n');
    });
  });

  it('does not create a missing data root when capture cannot persist the IO alert', async () => {
    const missing = join(
      tmpdir(),
      `linke-aic-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const result = await runAgent([COMMAND, '--data-dir', missing]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, REFUSED);
    assert.equal(result.stderr.includes(missing), false);
    await assert.rejects(() => access(missing), { code: 'ENOENT' });
  });

  it('maps corrupt outbox state to the fixed refusal without rewriting it', async () => {
    await withTempRoot('corrupt', async (root) => {
      const first = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(first.code, 2);
      const outbox = join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH);
      const corrupt = Buffer.from('{"broken":true}\n');
      await writeFile(outbox, corrupt, { mode: 0o600 });

      const result = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, REFUSED);
      assert.deepEqual(await readFile(outbox), corrupt);
    });
  });

  it('documents the explicit local command and its non-delivery ceiling in help', async () => {
    const result = await runAgent(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /audit-integrity-alert-capture/);
    assert.match(result.stdout, /no network|local/i);
    assert.doesNotMatch(result.stdout, /remote alert delivered|production monitoring ready/i);
  });

  it('has one Agent switch case and no server wiring', async () => {
    const [agent, server] = await Promise.all([
      readFile(AGENT_SRC, 'utf8'),
      readFile(SERVER_SRC, 'utf8'),
    ]);
    const caseMatches = agent.match(/case 'audit-integrity-alert-capture':/g) ?? [];
    assert.equal(caseMatches.length, 1);
    assert.match(agent, /enqueueAuditIntegrityAlertOutbox/);
    const caseStart = agent.indexOf("case 'audit-integrity-alert-capture':");
    const caseEnd = agent.indexOf("case 'audit-integrity-monitor':", caseStart);
    const body = agent.slice(caseStart, caseEnd);
    assert.ok(body.indexOf('await runAuditIntegrityMonitor(') >= 0);
    assert.ok(body.indexOf('await enqueueAuditIntegrityAlertOutbox(') >= 0);
    assert.ok(
      body.indexOf('await runAuditIntegrityMonitor(')
        < body.indexOf('await enqueueAuditIntegrityAlertOutbox('),
    );
    assert.equal(server.includes('audit-integrity-alert-capture'), false);
    assert.equal(server.includes('enqueueAuditIntegrityAlertOutbox'), false);
  });
});
