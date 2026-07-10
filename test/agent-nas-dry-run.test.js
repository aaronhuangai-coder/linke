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
          mountedShare: {
            enabled: true,
            mountPath: '/Volumes/LinkeBackup',
            relativeRoot: 'linke/main',
          },
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
      assert.strictEqual(plan.targets[0].mountedShareConfigured, true);
      assert.strictEqual(plan.targets[0].mountedShareEnabled, true);
      assert.ok(!stdout.includes('home-backup'), 'full plan must not echo raw credentialRef');
      assert.ok(!stdout.includes('/Volumes/LinkeBackup'), 'full plan must not echo mountedShare mountPath');
      assert.ok(!stdout.includes('linke/main'), 'full plan must not echo mountedShare relativeRoot');
      assert.ok(!stdout.includes('mountPath'), 'full plan must not expose mountPath key');
      assert.ok(!stdout.includes('relativeRoot'), 'full plan must not expose relativeRoot key');
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
      assert.deepStrictEqual(Object.keys(summary).sort(), [
        'blockedTargets',
        'blockers',
        'credentialRefConfiguredTargets',
        'disabledTargets',
        'enabledCredentialRefMissingTargets',
        'enabledTargets',
        'mode',
        'remoteExecutionBlocked',
        'state',
        'totalTargets',
      ].sort());

      assert.ok(!Object.hasOwn(summary, 'targets'), 'summary output must not include targets');
      assert.ok(!Object.hasOwn(summary, 'jobs'), 'summary output must not include jobs');
      assert.ok(!stdout.includes('primary-synology'), 'summary must not echo target name');
      assert.ok(!stdout.includes('disabled-ugreen'), 'summary must not echo target name');
      assert.ok(!stdout.includes('backup'), 'summary must not echo shareName');
      assert.ok(!stdout.includes('archive'), 'summary must not echo shareName');
      assert.ok(!stdout.includes('documents'), 'summary must not echo job name');
      assert.ok(!stdout.includes('home-backup'), 'summary must not echo raw credentialRef');
      assert.ok(!stdout.includes('192.168.50.10'), 'summary must not echo endpoint');
      assert.ok(!stdout.includes('/volume1/linke'), 'summary must not echo remotePath');
      assert.ok(!stdout.includes('/Users/example/Documents'), 'summary must not echo sourcePath');
      assert.ok(!stdout.includes('/Volumes/LinkeBackup'), 'summary must not echo mountedShare mountPath');
      assert.ok(!stdout.includes('linke/main'), 'summary must not echo mountedShare relativeRoot');
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

  it('exits 2 after printing the full plan when --fail-on-blocked sees blocked readiness', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-fail-blocked-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const err = await rejectAgent(['nas-dry-run', '--config', configPath, '--fail-on-blocked'], 2);
      const plan = JSON.parse(err.stdout);

      assert.strictEqual(err.stderr, '');
      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldConnect, false);
      assert.strictEqual(plan.wouldWrite, false);
      assert.strictEqual(plan.readinessSummary.state, 'blocked');
      assert.strictEqual(plan.readinessSummary.remoteExecutionBlocked, true);
      assert.ok(Array.isArray(plan.targets), 'full plan must still include targets');
      assert.ok(!err.stdout.includes('home-backup'), 'full plan must not echo raw credentialRef');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('exits 2 with summary-only JSON when --readiness-summary and --fail-on-blocked are combined', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-summary-fail-blocked-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const err = await rejectAgent([
        'nas-dry-run',
        '--config',
        configPath,
        '--readiness-summary',
        '--fail-on-blocked',
      ], 2);
      const summary = JSON.parse(err.stdout);

      assert.strictEqual(err.stderr, '');
      assert.strictEqual(summary.mode, 'dry-run');
      assert.strictEqual(summary.state, 'blocked');
      assert.strictEqual(summary.remoteExecutionBlocked, true);
      assert.ok(!Object.hasOwn(summary, 'targets'), 'summary output must not include targets');
      assert.ok(!Object.hasOwn(summary, 'jobs'), 'summary output must not include jobs');
      assert.ok(!err.stdout.includes('home-backup'), 'summary must not echo raw credentialRef');
      assert.ok(!err.stdout.includes('192.168.50.10'), 'summary must not echo endpoint');
      assert.ok(!err.stdout.includes('/volume1/linke'), 'summary must not echo remotePath');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('rejects a value after --fail-on-blocked', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-fail-blocked-value-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const err = await rejectAgent([
        'nas-dry-run',
        '--config',
        configPath,
        '--fail-on-blocked',
        'true',
      ], 1);

      assert.match(err.stderr, /--fail-on-blocked does not accept a value/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
