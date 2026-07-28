import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

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

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

// Raw values that must never reach stdout/stderr, whatever the CLI case.
function assertNoSensitiveValues(label, output, values) {
  for (const value of values) {
    assert.ok(!output.includes(value), `${label} must not leak ${JSON.stringify(value)}`);
  }
}

// Serialized-key patterns (`"key":`) so compatibility fields such as
// credentialRefConfigured and schema-path diagnostics such as
// "nasTargets[].mountedShare.mountPath ..." do not false-positive.
function assertNoSensitiveKeys(label, output) {
  for (const key of ['"mountPath":', '"relativeRoot":', '"credentialRef":']) {
    assert.ok(!output.includes(key), `${label} must not expose key ${key}`);
  }
}

// The temp root must gain nothing beyond the input config, and the missing
// mount path must never be created by the dry-run.
async function assertOnlyConfigArtifact(rootDir, missingMountPath) {
  assert.deepStrictEqual(await readdir(rootDir), ['linke.nas.json']);
  await assert.rejects(access(missingMountPath), { code: 'ENOENT' });
}

async function writeRawNasConfig(rootDir, config) {
  const configPath = join(rootDir, 'linke.nas.json');
  await writeFile(configPath, JSON.stringify(config));
  return configPath;
}

async function writeNasConfig(rootDir) {
  return writeRawNasConfig(rootDir, {
    serverUrl: 'http://localhost:3000',
    deviceId: 'agent-nas-summary-device',
    // Injection attempt: validateConfig ignores unknown top-level keys, so the
    // fake gate value must never reach any output.
    executionGate: {
      executionAuthorized: true,
      blockingReason: 'do-not-leak-gate-value',
    },
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
  });
}

// One enabled Synology target, no credentialRef, mountedShare enabled, and a
// mountPath that intentionally does not exist; endpoint is the local sentinel.
async function writeReadyNasConfig(rootDir, endpoint) {
  return writeRawNasConfig(rootDir, {
    serverUrl: 'http://localhost:3000',
    deviceId: 'agent-nas-ready-device',
    executionGate: {
      executionAuthorized: true,
      blockingReason: 'do-not-leak-gate-value',
    },
    nasTargets: [
      {
        name: 'ready-synology',
        provider: 'synology',
        endpoint,
        shareName: 'backup',
        remotePath: '/volume1/linke',
        enabled: true,
        mountedShare: {
          enabled: true,
          mountPath: join(rootDir, 'missing-mounted-share'),
          relativeRoot: 'linke/v145',
        },
      },
    ],
    backupJobs: [
      { name: 'documents', sourcePath: '/Users/example/Documents' },
    ],
  });
}

describe('Agent nas-dry-run CLI', () => {
  it('prints the full sanitized NAS dry-run plan by default', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const { stdout, stderr } = await runAgent(['nas-dry-run', '--config', configPath]);
      const plan = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.strictEqual(plan.schemaVersion, 2);
      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldConnect, false);
      assert.strictEqual(plan.wouldWrite, false);
      assert.ok(plan.readinessSummary);
      assert.strictEqual(plan.readinessSummary.state, 'blocked');
      assert.deepStrictEqual(plan.readinessSummary.blockers, ['target-disabled']);
      assert.strictEqual(plan.targets.length, 2);
      assert.strictEqual(plan.targets[0].credentialRefConfigured, true);
      assert.strictEqual(plan.targets[0].mountedShareConfigured, true);
      assert.strictEqual(plan.targets[0].mountedShareEnabled, true);
      assert.strictEqual(plan.targets[0].executionReadiness.state, 'ready');
      assert.strictEqual(plan.targets[0].executionReadiness.runtimeVerificationRequired, true);
      assert.deepStrictEqual(plan.targets[1].executionReadiness.blockers, ['target-disabled']);
      assert.strictEqual(plan.targets[1].executionReadiness.runtimeVerificationRequired, false);
      assert.ok(!stdout.includes('remote-execution-blocked'), 'V2 plan must not emit the legacy remote blocker');
      assert.ok(!stdout.includes('credential-ref-missing'), 'V2 plan must not emit the legacy credential blocker');
      assert.ok(!stdout.includes('home-backup'), 'full plan must not echo raw credentialRef');
      assert.ok(!stdout.includes('/Volumes/LinkeBackup'), 'full plan must not echo mountedShare mountPath');
      assert.ok(!stdout.includes('linke/main'), 'full plan must not echo mountedShare relativeRoot');
      assert.ok(!stdout.includes('do-not-leak-gate-value'), 'full plan must not echo injected gate values');
      assert.ok(!stdout.includes(agentPath), 'full plan must not echo the agent path');
      assertNoSensitiveKeys('full plan stdout', stdout);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('prints only readinessSummary when --readiness-summary is set', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-summary-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const beforeFiles = await readdir(rootDir);
      const { stdout, stderr } = await runAgent(['nas-dry-run', '--config', configPath, '--readiness-summary']);
      const summary = JSON.parse(stdout);
      const afterFiles = await readdir(rootDir);

      assert.strictEqual(stderr, '');
      assert.deepStrictEqual(afterFiles.sort(), beforeFiles.sort());
      assert.strictEqual(summary.schemaVersion, 2);
      assert.strictEqual(summary.mode, 'dry-run');
      assert.strictEqual(summary.scope, 'configuration-only');
      assert.strictEqual(summary.state, 'blocked');
      assert.strictEqual(summary.totalTargets, 2);
      assert.strictEqual(summary.enabledTargets, 1);
      assert.strictEqual(summary.disabledTargets, 1);
      assert.strictEqual(summary.credentialRefConfiguredTargets, 1);
      assert.strictEqual(summary.enabledCredentialRefMissingTargets, 0);
      assert.strictEqual(summary.mountedShareConfiguredTargets, 1);
      assert.strictEqual(summary.mountedShareEnabledTargets, 1);
      assert.strictEqual(summary.configurationReadyTargets, 1);
      assert.strictEqual(summary.runtimeVerificationPendingTargets, 1);
      assert.strictEqual(summary.blockedTargets, 1);
      assert.strictEqual(summary.executionAuthorized, false);
      assert.strictEqual(summary.remoteExecutionBlocked, true);
      assert.deepStrictEqual(summary.blockers, ['target-disabled']);
      assert.deepStrictEqual(Object.keys(summary).sort(), [
        'blockedTargets',
        'blockers',
        'configurationReadyTargets',
        'credentialRefConfiguredTargets',
        'disabledTargets',
        'enabledCredentialRefMissingTargets',
        'enabledTargets',
        'executionAuthorized',
        'mode',
        'mountedShareConfiguredTargets',
        'mountedShareEnabledTargets',
        'remoteExecutionBlocked',
        'runtimeVerificationPendingTargets',
        'schemaVersion',
        'scope',
        'state',
        'totalTargets',
      ].sort());

      assert.ok(!Object.hasOwn(summary, 'targets'), 'summary output must not include targets');
      assert.ok(!Object.hasOwn(summary, 'jobs'), 'summary output must not include jobs');
      assert.ok(!stdout.includes('remote-execution-blocked'), 'summary must not emit the legacy remote blocker');
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
      assert.ok(!stdout.includes('do-not-leak-gate-value'), 'summary must not echo injected gate values');
      assert.ok(!stdout.includes(agentPath), 'summary must not echo the agent path');
      assertNoSensitiveKeys('summary stdout', stdout);
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
      assert.strictEqual(plan.schemaVersion, 2);
      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldConnect, false);
      assert.strictEqual(plan.wouldWrite, false);
      assert.strictEqual(plan.readinessSummary.state, 'blocked');
      assert.strictEqual(plan.readinessSummary.remoteExecutionBlocked, true);
      assert.strictEqual(plan.readinessSummary.executionAuthorized, false);
      assert.deepStrictEqual(plan.readinessSummary.blockers, ['target-disabled']);
      assert.ok(Array.isArray(plan.targets), 'full plan must still include targets');
      assert.ok(!err.stdout.includes('remote-execution-blocked'), 'V2 plan must not emit the legacy remote blocker');
      assert.ok(!err.stdout.includes('home-backup'), 'full plan must not echo raw credentialRef');
      assert.ok(!err.stdout.includes('do-not-leak-gate-value'), 'full plan must not echo injected gate values');
      assert.ok(!err.stdout.includes(agentPath), 'full plan must not echo the agent path');
      assertNoSensitiveKeys('fail-on-blocked stdout', err.stdout);
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
      assert.strictEqual(summary.schemaVersion, 2);
      assert.strictEqual(summary.mode, 'dry-run');
      assert.strictEqual(summary.scope, 'configuration-only');
      assert.strictEqual(summary.state, 'blocked');
      assert.strictEqual(summary.remoteExecutionBlocked, true);
      assert.strictEqual(summary.executionAuthorized, false);
      assert.deepStrictEqual(summary.blockers, ['target-disabled']);
      assert.ok(!Object.hasOwn(summary, 'targets'), 'summary output must not include targets');
      assert.ok(!Object.hasOwn(summary, 'jobs'), 'summary output must not include jobs');
      assert.ok(!err.stdout.includes('remote-execution-blocked'), 'summary must not emit the legacy remote blocker');
      assert.ok(!err.stdout.includes('home-backup'), 'summary must not echo raw credentialRef');
      assert.ok(!err.stdout.includes('192.168.50.10'), 'summary must not echo endpoint');
      assert.ok(!err.stdout.includes('/volume1/linke'), 'summary must not echo remotePath');
      assert.ok(!err.stdout.includes('do-not-leak-gate-value'), 'summary must not echo injected gate values');
      assert.ok(!err.stdout.includes(agentPath), 'summary must not echo the agent path');
      assertNoSensitiveKeys('fail-on-blocked summary stdout', err.stdout);
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

  it('exits 0 for a ready configuration and never connects to the configured endpoint', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-ready-'));
    let connectionCount = 0;
    const sentinel = createServer((socket) => {
      connectionCount += 1;
      socket.destroy();
    });

    try {
      const port = await listen(sentinel);
      const endpoint = `http://127.0.0.1:${port}`;
      const configPath = await writeReadyNasConfig(rootDir, endpoint);
      const missingMountPath = join(rootDir, 'missing-mounted-share');

      // execFile resolves only on exit 0, so reaching here proves exit code 0.
      const { stdout, stderr } = await runAgent([
        'nas-dry-run', '--config', configPath, '--fail-on-blocked',
      ]);
      const plan = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.strictEqual(plan.schemaVersion, 2);
      assert.strictEqual(plan.readinessSummary.state, 'ready');
      assert.strictEqual(plan.readinessSummary.runtimeVerificationPendingTargets, 1);
      assert.deepStrictEqual(plan.executionGate, {
        schemaVersion: 2,
        adapterAvailable: true,
        executionAuthorized: false,
        remoteExecutionAllowed: false,
        blockingReason: 'dry-run does not authorize execution',
        requiredGates: [
          { type: 'cli-flag', name: '--execute' },
          { type: 'env-var', name: 'LINKE_NAS_SMB_EXECUTION' },
        ],
      });
      assert.strictEqual(plan.wouldConnect, false);
      assert.strictEqual(plan.wouldWrite, false);
      assert.deepStrictEqual(plan.targets[0].executionReadiness, {
        schemaVersion: 2,
        state: 'ready',
        basis: 'configuration-only',
        blockers: [],
        runtimeVerificationPerformed: false,
        runtimeVerificationRequired: true,
      });
      assert.strictEqual(connectionCount, 0, 'dry-run must not connect to the configured endpoint');

      const banned = [missingMountPath, 'linke/v145', agentPath, 'do-not-leak-gate-value'];
      assertNoSensitiveValues('ready full stdout', stdout, banned);
      assertNoSensitiveValues('ready full stderr', stderr, banned);
      assertNoSensitiveKeys('ready full stdout', stdout);
      assertNoSensitiveKeys('ready full stderr', stderr);

      await assertOnlyConfigArtifact(rootDir, missingMountPath);
    } finally {
      await close(sentinel);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('exits 0 with summary-only JSON for a ready configuration and still never connects', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-ready-summary-'));
    let connectionCount = 0;
    const sentinel = createServer((socket) => {
      connectionCount += 1;
      socket.destroy();
    });

    try {
      const port = await listen(sentinel);
      const endpoint = `http://127.0.0.1:${port}`;
      const configPath = await writeReadyNasConfig(rootDir, endpoint);
      const missingMountPath = join(rootDir, 'missing-mounted-share');

      const { stdout, stderr } = await runAgent([
        'nas-dry-run', '--config', configPath, '--readiness-summary', '--fail-on-blocked',
      ]);
      const summary = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.deepStrictEqual(summary, {
        schemaVersion: 2,
        mode: 'dry-run',
        scope: 'configuration-only',
        state: 'ready',
        totalTargets: 1,
        enabledTargets: 1,
        disabledTargets: 0,
        credentialRefConfiguredTargets: 0,
        enabledCredentialRefMissingTargets: 1,
        mountedShareConfiguredTargets: 1,
        mountedShareEnabledTargets: 1,
        configurationReadyTargets: 1,
        runtimeVerificationPendingTargets: 1,
        blockedTargets: 0,
        executionAuthorized: false,
        remoteExecutionBlocked: true,
        blockers: [],
      });
      assert.ok(!Object.hasOwn(summary, 'targets'), 'summary output must not include targets');
      assert.ok(!Object.hasOwn(summary, 'jobs'), 'summary output must not include jobs');
      assert.strictEqual(connectionCount, 0, 'dry-run must not connect to the configured endpoint');

      const banned = [missingMountPath, 'linke/v145', agentPath, 'do-not-leak-gate-value'];
      assertNoSensitiveValues('ready summary stdout', stdout, banned);
      assertNoSensitiveValues('ready summary stderr', stderr, banned);
      assertNoSensitiveKeys('ready summary stdout', stdout);
      assertNoSensitiveKeys('ready summary stderr', stderr);

      await assertOnlyConfigArtifact(rootDir, missingMountPath);
    } finally {
      await close(sentinel);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('exits 1 with sanitized stderr for an invalid provider', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-invalid-provider-'));

    try {
      const missingMountPath = join(rootDir, 'missing-mounted-share');
      const configPath = await writeRawNasConfig(rootDir, {
        serverUrl: 'http://localhost:3000',
        deviceId: 'agent-nas-invalid-provider',
        nasTargets: [
          {
            name: 'invalid-provider',
            provider: 'acme',
            endpoint: 'http://192.168.50.30:5000',
            shareName: 'backup',
            remotePath: '/volume1/linke',
            enabled: true,
            credentialRef: 'leak-check-ref',
            mountedShare: {
              enabled: true,
              mountPath: missingMountPath,
              relativeRoot: 'linke/v145',
            },
          },
        ],
        backupJobs: [
          { name: 'documents', sourcePath: '/Users/example/Documents' },
        ],
      });

      const err = await rejectAgent(['nas-dry-run', '--config', configPath, '--fail-on-blocked'], 1);

      assert.strictEqual(err.stdout, '');
      assert.strictEqual(
        err.stderr,
        'Error: nasTargets[].provider must be one of: synology, ugreen (got "acme")\n',
      );
      const banned = [missingMountPath, 'linke/v145', 'leak-check-ref', agentPath, 'do-not-leak-gate-value'];
      assertNoSensitiveValues('invalid-provider stdout', err.stdout, banned);
      assertNoSensitiveValues('invalid-provider stderr', err.stderr, banned);
      assertNoSensitiveKeys('invalid-provider stdout', err.stdout);
      assertNoSensitiveKeys('invalid-provider stderr', err.stderr);
      await assertOnlyConfigArtifact(rootDir, missingMountPath);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('exits 1 with sanitized stderr for a relative mountPath', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-relative-mount-'));

    try {
      const missingMountPath = join(rootDir, 'missing-mounted-share');
      const configPath = await writeRawNasConfig(rootDir, {
        serverUrl: 'http://localhost:3000',
        deviceId: 'agent-nas-relative-mount',
        nasTargets: [
          {
            name: 'relative-mount',
            provider: 'synology',
            endpoint: 'http://192.168.50.40:5000',
            shareName: 'backup',
            remotePath: '/volume1/linke',
            enabled: true,
            credentialRef: 'leak-check-ref',
            mountedShare: {
              enabled: true,
              mountPath: 'relative/mount/path',
              relativeRoot: 'linke/v145',
            },
          },
        ],
        backupJobs: [
          { name: 'documents', sourcePath: '/Users/example/Documents' },
        ],
      });

      const err = await rejectAgent(['nas-dry-run', '--config', configPath, '--fail-on-blocked'], 1);

      assert.strictEqual(err.stdout, '');
      // stderr is pinned byte-for-byte: the diagnostic names the schema field
      // path but echoes no user-supplied value.
      assert.strictEqual(
        err.stderr,
        'Error: nasTargets[].mountedShare.mountPath must be an absolute safe path\n',
      );
      const banned = [missingMountPath, 'relative/mount/path', 'linke/v145', 'leak-check-ref', agentPath, 'do-not-leak-gate-value'];
      assertNoSensitiveValues('relative-mount stdout', err.stdout, banned);
      assertNoSensitiveValues('relative-mount stderr', err.stderr, banned);
      assertNoSensitiveKeys('relative-mount stdout', err.stdout);
      assertNoSensitiveKeys('relative-mount stderr', err.stderr);
      await assertOnlyConfigArtifact(rootDir, missingMountPath);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('exits 1 with sanitized stderr for an unsupported mountedShare key', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-unsupported-key-'));

    try {
      const missingMountPath = join(rootDir, 'missing-mounted-share');
      const configPath = await writeRawNasConfig(rootDir, {
        serverUrl: 'http://localhost:3000',
        deviceId: 'agent-nas-unsupported-key',
        nasTargets: [
          {
            name: 'unsupported-key',
            provider: 'synology',
            endpoint: 'http://192.168.50.50:5000',
            shareName: 'backup',
            remotePath: '/volume1/linke',
            enabled: true,
            credentialRef: 'leak-check-ref',
            mountedShare: {
              enabled: true,
              mountPath: missingMountPath,
              relativeRoot: 'linke/v145',
              unexpectedKey: 'do-not-leak-gate-value',
            },
          },
        ],
        backupJobs: [
          { name: 'documents', sourcePath: '/Users/example/Documents' },
        ],
      });

      const err = await rejectAgent(['nas-dry-run', '--config', configPath, '--fail-on-blocked'], 1);

      assert.strictEqual(err.stdout, '');
      assert.strictEqual(
        err.stderr,
        'Error: nasTargets[].mountedShare contains unsupported field "unexpectedKey"\n',
      );
      const banned = [missingMountPath, 'linke/v145', 'leak-check-ref', agentPath, 'do-not-leak-gate-value'];
      assertNoSensitiveValues('unsupported-key stdout', err.stdout, banned);
      assertNoSensitiveValues('unsupported-key stderr', err.stderr, banned);
      assertNoSensitiveKeys('unsupported-key stdout', err.stdout);
      assertNoSensitiveKeys('unsupported-key stderr', err.stderr);
      await assertOnlyConfigArtifact(rootDir, missingMountPath);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
