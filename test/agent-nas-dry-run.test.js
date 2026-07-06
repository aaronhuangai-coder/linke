import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');

async function runAgent(args) {
  return exec('node', [agentPath, ...args]);
}

async function rejectAgent(args, expectedCode) {
  try {
    await runAgent(args);
  } catch (err) {
    assert.strictEqual(err.code, expectedCode);
    return err;
  }
  assert.fail(`Expected agent command to exit ${expectedCode}`);
}

async function writeNasConfig(rootDir) {
  const configPath = join(rootDir, 'linke.nas.json');
  await writeFile(
    configPath,
    JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'agent-nas-summary-device',
      nasTargets: [
        {
          name: 'primary-synology',
          provider: 'synology',
          endpoint: 'http://192.168.50.10:5000',
          shareName: 'backup',
          remotePath: '/volume1/linke',
          enabled: true,
          credentialRef: 'home-backup',
        },
        {
          name: 'disabled-ugreen',
          provider: 'ugreen',
          endpoint: 'https://192.168.50.20',
          shareName: 'archive',
          remotePath: '/shares/archive',
          enabled: false,
        },
      ],
      backupJobs: [
        { name: 'documents', sourcePath: '/Users/example/Documents' },
      ],
    }),
  );
  return configPath;
}

describe('Agent nas-dry-run CLI', () => {
  it('prints the full sanitized NAS dry-run plan by default', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const { stdout } = await runAgent(['nas-dry-run', '--config', configPath]);
      const plan = JSON.parse(stdout);

      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldConnect, false);
      assert.strictEqual(plan.wouldWrite, false);
      assert.ok(plan.readinessSummary);
      assert.strictEqual(plan.targets.length, 2);
      assert.strictEqual(plan.targets[0].credentialRefConfigured, true);
      assert.ok(!stdout.includes('home-backup'), 'full plan must not echo raw credentialRef');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('prints only readinessSummary when --readiness-summary is set', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-summary-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const beforeFiles = await readdir(rootDir);
      const { stdout } = await runAgent(['nas-dry-run', '--config', configPath, '--readiness-summary']);
      const summary = JSON.parse(stdout);
      const afterFiles = await readdir(rootDir);

      assert.deepStrictEqual(afterFiles.sort(), beforeFiles.sort());
      assert.strictEqual(summary.mode, 'dry-run');
      assert.strictEqual(summary.state, 'blocked');
      assert.strictEqual(summary.totalTargets, 2);
      assert.strictEqual(summary.enabledTargets, 1);
      assert.strictEqual(summary.disabledTargets, 1);
      assert.strictEqual(summary.credentialRefConfiguredTargets, 1);
      assert.strictEqual(summary.enabledCredentialRefMissingTargets, 0);
      assert.strictEqual(summary.blockedTargets, 2);
      assert.strictEqual(summary.remoteExecutionBlocked, true);
      assert.deepStrictEqual(
        summary.blockers.sort(),
        ['remote-execution-blocked', 'target-disabled'].sort(),
      );

      assert.ok(!Object.hasOwn(summary, 'targets'), 'summary output must not include targets');
      assert.ok(!Object.hasOwn(summary, 'jobs'), 'summary output must not include jobs');
      assert.ok(!stdout.includes('home-backup'), 'summary must not echo raw credentialRef');
      assert.ok(!stdout.includes('192.168.50.10'), 'summary must not echo endpoint');
      assert.ok(!stdout.includes('/volume1/linke'), 'summary must not echo remotePath');
      assert.ok(!stdout.includes('/Users/example/Documents'), 'summary must not echo sourcePath');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('rejects a value after --readiness-summary', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-summary-value-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const err = await rejectAgent([
        'nas-dry-run',
        '--config',
        configPath,
        '--readiness-summary',
        'json',
      ], 1);

      assert.match(err.stderr, /--readiness-summary does not accept a value/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
