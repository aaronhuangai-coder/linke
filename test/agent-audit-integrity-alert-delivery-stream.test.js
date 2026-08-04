/**
 * Agent CLI: audit-integrity-alert-delivery-stream-ensure
 * Explicit local stream identity provisioning only — no network delivery.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH } from '../src/audit-integrity-alert-delivery-stream.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const AGENT_SRC = join(REPO_ROOT, 'src', 'agent.js');
const SERVER_SRC = join(REPO_ROOT, 'src', 'server.js');
const COMMAND = 'audit-integrity-alert-delivery-stream-ensure';
const INVALID = `Error: ${COMMAND} arguments are invalid\n`;
const REFUSED = `Error: ${COMMAND} refused\n`;
const STREAM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT_KEYS = Object.freeze(['schemaVersion', 'status', 'streamId']);

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
  const root = await mkdtemp(join(tmpdir(), `linke-aids-cli-${label}-`));
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

function assertCreatedOrExisting(receipt, status) {
  assert.deepEqual(Object.keys(receipt), [...RECEIPT_KEYS]);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, status);
  assert.match(receipt.streamId, STREAM_ID_RE);
}

describe('Agent audit-integrity-alert-delivery-stream-ensure CLI', () => {
  it('first ensure prints exact created receipt at exit 0 without path leakage', async () => {
    await withTempRoot('create', async (root) => {
      const result = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const receipt = parseSingleJsonLine(result.stdout);
      assertCreatedOrExisting(receipt, 'created');
      assert.equal(result.stdout.includes(root), false);
      assert.equal(result.stdout.includes(AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH), false);
    });
  });

  it('repeated ensure returns same streamId as existing without rewriting state bytes', async () => {
    await withTempRoot('existing', async (root) => {
      const first = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(first.code, 0);
      const created = parseSingleJsonLine(first.stdout);
      assertCreatedOrExisting(created, 'created');

      const abs = join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH);
      const before = await readFile(abs);

      const second = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(second.code, 0);
      assert.equal(second.stderr, '');
      const existing = parseSingleJsonLine(second.stdout);
      assertCreatedOrExisting(existing, 'existing');
      assert.equal(existing.streamId, created.streamId);
      assert.equal(second.stdout.includes(root), false);
      assert.deepEqual(await readFile(abs), before);
    });
  });

  it('rejects invalid exact raw argv matrix with fixed invalid exit 1 and creates no root', async () => {
    await withTempRoot('argv', async (parent) => {
      const missingRoot = join(parent, 'must-remain-absent');
      const samples = [
        [COMMAND],
        [COMMAND, '--data-dir'],
        [COMMAND, '--data-dir', ''],
        [COMMAND, '--data-dir', '   '],
        [COMMAND, '--data-dir', '--token'],
        [COMMAND, missingRoot, '--data-dir'],
        [COMMAND, '--data-dir', missingRoot, '--data-dir', missingRoot],
        [COMMAND, '--data-dir', missingRoot, 'extra'],
        [COMMAND, '--data-dir', missingRoot, '--token', 'sentinel-secret'],
        [COMMAND, '--unknown', missingRoot],
        [COMMAND, '--help'],
      ];
      for (const argv of samples) {
        const result = await runAgent(argv);
        assert.equal(result.code, 1, argv.join(' '));
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, INVALID);
        assert.equal(result.stderr.includes(missingRoot), false);
        assert.equal(result.stderr.includes(parent), false);
        assert.equal(result.stderr.includes('sentinel-secret'), false);
      }
      await assert.rejects(() => access(missingRoot), { code: 'ENOENT' });
    });
  });

  it('maps missing root and corrupt state to fixed refused exit 2 without rewriting corrupt bytes', async () => {
    const missing = join(
      tmpdir(),
      `linke-aids-cli-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const missingResult = await runAgent([COMMAND, '--data-dir', missing]);
    assert.equal(missingResult.code, 2);
    assert.equal(missingResult.stdout, '');
    assert.equal(missingResult.stderr, REFUSED);
    assert.equal(missingResult.stderr.includes(missing), false);
    await assert.rejects(() => access(missing), { code: 'ENOENT' });

    await withTempRoot('corrupt', async (root) => {
      const abs = join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH);
      await mkdir(dirname(abs), { recursive: true });
      const corrupt = Buffer.from('{"broken":true}\n');
      await writeFile(abs, corrupt, { mode: 0o600 });

      const result = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, REFUSED);
      assert.equal(result.stderr.includes(root), false);
      assert.deepEqual(await readFile(abs), corrupt);
    });
  });

  it('refuses symlink leaf with fixed message and leaves target bytes unchanged', async () => {
    await withTempRoot('symlink', async (root) => {
      const outside = join(root, 'outside-probe');
      await writeFile(outside, 'keep\n', { mode: 0o600 });
      await mkdir(join(root, 'audit'));
      await symlink(outside, join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH));

      const result = await runAgent([COMMAND, '--data-dir', root]);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, REFUSED);
      assert.equal(result.stderr.includes(root), false);
      assert.equal(await readFile(outside, 'utf8'), 'keep\n');
    });
  });

  it('lists the command in help, keeps one Agent switch/import, and adds no server wiring', async () => {
    const help = await runAgent(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /audit-integrity-alert-delivery-stream-ensure/);
    assert.doesNotMatch(help.stdout, /remote delivered|production ready/i);

    const [agent, server] = await Promise.all([
      readFile(AGENT_SRC, 'utf8'),
      readFile(SERVER_SRC, 'utf8'),
    ]);
    assert.equal(
      (agent.match(/case 'audit-integrity-alert-delivery-stream-ensure':/g) ?? []).length,
      1,
    );
    assert.equal(
      (agent.match(/ensureAuditIntegrityAlertDeliveryStream/g) ?? []).length,
      2,
    );
    assert.match(agent, /from '\.\/audit-integrity-alert-delivery-stream\.js'/);
    assert.equal(server.includes(COMMAND), false);
    assert.equal(server.includes('ensureAuditIntegrityAlertDeliveryStream'), false);
    assert.equal(server.includes('audit-integrity-alert-delivery-stream'), false);
  });
});
