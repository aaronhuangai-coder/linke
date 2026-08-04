import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH } from '../src/audit-integrity-alert-outbox.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const AGENT_SRC = join(REPO_ROOT, 'src', 'agent.js');
const SERVER_SRC = join(REPO_ROOT, 'src', 'server.js');
const READ_COMMAND = 'audit-integrity-alert-outbox-read';
const ACK_COMMAND = 'audit-integrity-alert-outbox-ack';

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
  const root = await mkdtemp(join(tmpdir(), `linke-aio-cli-${label}-`));
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

describe('Agent audit-integrity alert outbox read/ack CLI', () => {
  it('reads an absent outbox as canonical empty without creating it', async () => {
    await withTempRoot('empty-read', async (root) => {
      const result = await runAgent([READ_COMMAND, '--data-dir', root]);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.deepEqual(parseSingleJsonLine(result.stdout), {
        schemaVersion: 1,
        nextSequence: 1,
        entries: [],
      });
      await assert.rejects(
        () => access(join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH)),
        { code: 'ENOENT' },
      );
    });
  });

  it('reads a populated sanitized occurrence after explicit capture', async () => {
    await withTempRoot('populated-read', async (root) => {
      const captured = await runAgent([
        'audit-integrity-alert-capture', '--data-dir', root,
      ]);
      assert.equal(captured.code, 2);
      const result = await runAgent([READ_COMMAND, '--data-dir', root]);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const state = parseSingleJsonLine(result.stdout);
      assert.equal(state.nextSequence, 2);
      assert.equal(state.entries.length, 1);
      assert.deepEqual(Object.keys(state.entries[0]), [
        'sequence', 'checkedAt', 'code', 'recoveryRequired', 'nextAction', 'reasonCode',
      ]);
      assert.equal(state.entries[0].sequence, 1);
      assert.equal(state.entries[0].code, 'uninitialized');
      assert.equal(result.stdout.includes(root), false);
    });
  });

  it('acknowledges exactly the FIFO head and exposes the empty state', async () => {
    await withTempRoot('ack-head', async (root) => {
      await runAgent(['audit-integrity-alert-capture', '--data-dir', root]);
      const ack = await runAgent([
        ACK_COMMAND, '--data-dir', root, '--sequence', '1',
      ]);
      assert.equal(ack.code, 0);
      assert.equal(ack.stderr, '');
      assert.deepEqual(parseSingleJsonLine(ack.stdout), {
        schemaVersion: 1,
        status: 'acknowledged',
        acknowledged: true,
        sequence: 1,
        pendingCount: 0,
      });
      const state = parseSingleJsonLine((await runAgent([
        READ_COMMAND, '--data-dir', root,
      ])).stdout);
      assert.equal(state.nextSequence, 2);
      assert.deepEqual(state.entries, []);
    });
  });

  it('returns an empty acknowledgement without creating absent state', async () => {
    await withTempRoot('empty-ack', async (root) => {
      const result = await runAgent([
        ACK_COMMAND, '--data-dir', root, '--sequence', '1',
      ]);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.deepEqual(parseSingleJsonLine(result.stdout), {
        schemaVersion: 1,
        status: 'empty',
        acknowledged: false,
        sequence: null,
        pendingCount: 0,
      });
      await assert.rejects(
        () => access(join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH)),
        { code: 'ENOENT' },
      );
    });
  });

  it('refuses a non-head sequence without rewriting state', async () => {
    await withTempRoot('wrong-head', async (root) => {
      await runAgent(['audit-integrity-alert-capture', '--data-dir', root]);
      await runAgent(['audit-integrity-alert-capture', '--data-dir', root]);
      const outbox = join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH);
      const before = await readFile(outbox);
      const result = await runAgent([
        ACK_COMMAND, '--data-dir', root, '--sequence', '2',
      ]);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `Error: ${ACK_COMMAND} refused\n`);
      assert.deepEqual(await readFile(outbox), before);
    });
  });

  it('refuses corrupt state for both read and ack without rewriting it', async () => {
    await withTempRoot('corrupt', async (root) => {
      await runAgent(['audit-integrity-alert-capture', '--data-dir', root]);
      const outbox = join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH);
      const corrupt = Buffer.from('{"broken":true}\n');
      await writeFile(outbox, corrupt, { mode: 0o600 });
      for (const argv of [
        [READ_COMMAND, '--data-dir', root],
        [ACK_COMMAND, '--data-dir', root, '--sequence', '1'],
      ]) {
        const result = await runAgent(argv);
        assert.equal(result.code, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `Error: ${argv[0]} refused\n`);
        assert.deepEqual(await readFile(outbox), corrupt);
      }
    });
  });

  it('rejects non-canonical read and ack argv with fixed messages', async () => {
    await withTempRoot('argv', async (root) => {
      const samples = [
        [READ_COMMAND],
        [READ_COMMAND, '--data-dir', root, 'extra'],
        [ACK_COMMAND, '--data-dir', root],
        [ACK_COMMAND, '--data-dir', root, '--sequence', '0'],
        [ACK_COMMAND, '--data-dir', root, '--sequence', '01'],
        [ACK_COMMAND, '--data-dir', root, '--sequence', '1.0'],
        [ACK_COMMAND, '--sequence', '1', '--data-dir', root],
      ];
      for (const argv of samples) {
        const result = await runAgent(argv);
        assert.equal(result.code, 1, argv.join(' '));
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `Error: ${argv[0]} arguments are invalid\n`);
        assert.equal(result.stderr.includes(root), false);
      }
    });
  });

  it('lists both local commands in help and adds no server wiring', async () => {
    const help = await runAgent(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /audit-integrity-alert-outbox-read/);
    assert.match(help.stdout, /audit-integrity-alert-outbox-ack/);
    assert.doesNotMatch(help.stdout, /remote alert delivered|production monitoring ready/i);

    const [agent, server] = await Promise.all([
      readFile(AGENT_SRC, 'utf8'),
      readFile(SERVER_SRC, 'utf8'),
    ]);
    assert.equal((agent.match(/case 'audit-integrity-alert-outbox-read':/g) ?? []).length, 1);
    assert.equal((agent.match(/case 'audit-integrity-alert-outbox-ack':/g) ?? []).length, 1);
    assert.equal(server.includes(READ_COMMAND), false);
    assert.equal(server.includes(ACK_COMMAND), false);
  });
});
