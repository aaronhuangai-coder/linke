import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

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

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('Agent supervisor-install-dry-run CLI', () => {
  it('buildSupervisorInstallDryRunPlan returns a sanitized dry-run plan without sensitive config values', async () => {
    const app = await import('../src/agent.js');
    const buildSupervisorInstallDryRunPlan = app.buildSupervisorInstallDryRunPlan;
    if (!buildSupervisorInstallDryRunPlan) {
      throw new Error('buildSupervisorInstallDryRunPlan is not defined in src/agent.js');
    }

    const sourcePath = '/Users/ah/private/source';
    const endpoint = 'https://nas.local:5001';
    const credentialRef = 'nas-secret-ref';
    const plan = buildSupervisorInstallDryRunPlan({
      serverUrl: 'http://127.0.0.1:3000',
      deviceId: 'mac-main',
      launchdLabel: 'com.linke.agent.mac-main',
      scheduleSeconds: 1800,
      backupJobs: [
        { name: 'docs', sourcePath },
        { name: 'photos', sourcePath: '/Users/ah/Pictures/private' },
      ],
      excludePatterns: ['*.tmp', '.DS_Store'],
      nasTargets: [
        {
          name: 'synology-a',
          provider: 'synology',
          endpoint,
          shareName: 'backup',
          remotePath: '/private/remote',
          credentialRef,
          enabled: true,
        },
      ],
    });

    assert.strictEqual(plan.status, 'partial');
    assert.strictEqual(plan.service, 'linke');
    assert.strictEqual(plan.version, LINKE_RELEASE_VERSION);
    assert.strictEqual(plan.command, 'supervisor-install-dry-run');
    assert.deepStrictEqual(plan.supervisor, {
      state: 'not_configured',
      installPlan: 'dry_run_only',
      label: 'com.linke.agent.mac-main',
      scheduleSeconds: 1800,
      target: 'user-launch-agent',
      program: 'node src/agent.js run-once --config [redacted]',
      wouldInstall: false,
      wouldStart: false,
      wouldCallLaunchctl: false,
      wouldWriteLaunchAgent: false,
      wouldWriteMetadata: false,
    });
    assert.deepStrictEqual(plan.configSummary, {
      deviceId: 'mac-main',
      backupJobCount: 2,
      nasTargetCount: 1,
      excludePatternCount: 2,
    });
    assert.deepStrictEqual(plan.safety, {
      dryRun: true,
      configPathReturned: false,
      sourcePathsReturned: false,
      serverUrlReturned: false,
      nasEndpointsReturned: false,
      credentialRefsReturned: false,
      tokenValuesReturned: false,
      launchctlCalled: false,
      processListRead: false,
      supervisorInstalled: false,
      launchdFileWritten: false,
      metadataWritten: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
    });
    assert.ok(Array.isArray(plan.nextSteps));
    assert.ok(plan.nextSteps.some((step) => /launchd-dry-run/.test(step)));

    const text = JSON.stringify(plan);
    assert.doesNotMatch(text, /\/Users\/ah\/private\/source|\/Users\/ah\/Pictures\/private/);
    assert.doesNotMatch(text, /127\.0\.0\.1|3000|nas\.local|5001|nas-secret-ref|private\/remote/);
    assert.doesNotMatch(text, /Authorization|Bearer/i);
  });

  it('prints sanitized JSON and does not write files next to the config', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-dry-run-'));
    const sourceDir = join(dataDir, 'private-source');
    const configPath = join(dataDir, 'config.json');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'a.txt'), 'aaa');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://127.0.0.1:3000',
        deviceId: 'agent-install-dry-run',
        launchdLabel: 'com.linke.agent.install-dry-run',
        scheduleSeconds: 900,
        backupJobs: [{ name: 'private-job', sourcePath: sourceDir }],
        nasTargets: [
          {
            name: 'ugreen-a',
            provider: 'ugreen',
            endpoint: 'https://ugreen.local',
            shareName: 'backup',
            remotePath: '/private/remote',
            credentialRef: 'ugreen-ref',
          },
        ],
      }),
    );

    try {
      const { stdout, stderr } = await runAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
        '--token',
        'unused-local-token',
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.strictEqual(body.status, 'partial');
      assert.strictEqual(body.command, 'supervisor-install-dry-run');
      assert.strictEqual(body.supervisor.state, 'not_configured');
      assert.strictEqual(body.supervisor.wouldInstall, false);
      assert.strictEqual(body.supervisor.wouldCallLaunchctl, false);
      assert.strictEqual(body.safety.launchctlCalled, false);
      assert.strictEqual(body.safety.processListRead, false);
      assert.strictEqual(body.safety.launchdFileWritten, false);
      assert.strictEqual(body.safety.nasConnected, false);
      assert.strictEqual(body.configSummary.backupJobCount, 1);
      assert.strictEqual(body.configSummary.nasTargetCount, 1);

      assert.doesNotMatch(stdout, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(stdout, /private-source|config\.json|127\.0\.0\.1|3000|ugreen\.local|ugreen-ref|unused-local-token|Bearer/i);
      assert.deepStrictEqual((await readdir(dataDir)).sort(), ['config.json', 'private-source']);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('sanitizes config read errors without echoing the config path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-missing-'));
    const missingConfigPath = join(dataDir, 'private-config.json');

    try {
      const err = await rejectAgent([
        'supervisor-install-dry-run',
        '--config',
        missingConfigPath,
      ], 1);

      assert.match(err.stderr, /supervisor-install-dry-run failed; verify --config points to a readable valid Linke config/);
      assert.strictEqual(err.stdout, '');
      assert.doesNotMatch(err.stderr, new RegExp(escapeRegExp(dataDir)));
      assert.doesNotMatch(err.stderr, /private-config\.json/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('sanitizes validation errors without echoing sensitive config values', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-invalid-'));
    const sourceDir = join(dataDir, 'private-source');
    const configPath = join(dataDir, 'config.json');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'ftp://private-server.local',
        deviceId: 'private-device',
        backupJobs: [{ name: 'private-job', sourcePath: sourceDir }],
        nasTargets: [
          {
            name: 'private-nas',
            provider: 'synology',
            endpoint: 'https://private-nas.local',
            shareName: 'backup',
            remotePath: '/private/remote',
            credentialRef: 'private-ref',
          },
        ],
      }),
    );

    try {
      const err = await rejectAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
      ], 1);

      assert.match(err.stderr, /supervisor-install-dry-run failed; verify --config points to a readable valid Linke config/);
      assert.strictEqual(err.stdout, '');
      assert.doesNotMatch(err.stderr, new RegExp(escapeRegExp(dataDir)));
      assert.doesNotMatch(err.stderr, /private-server|private-source|private-device|private-nas|private\/remote|private-ref/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects --output and does not create a plist file', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-install-output-'));
    const sourceDir = join(dataDir, 'src');
    const configPath = join(dataDir, 'config.json');
    const outputPath = join(dataDir, 'planned.plist');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://127.0.0.1:3000',
        deviceId: 'agent-install-output',
        backupJobs: [{ name: 'docs', sourcePath: sourceDir }],
      }),
    );

    try {
      const err = await rejectAgent([
        'supervisor-install-dry-run',
        '--config',
        configPath,
        '--output',
        outputPath,
      ], 1);

      assert.match(err.stderr, /--output is not supported by supervisor-install-dry-run/);
      assert.strictEqual(err.stdout, '');
      assert.strictEqual(await pathExists(outputPath), false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
