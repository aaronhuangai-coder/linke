import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runAgent(args) {
  return exec(process.execPath, [agentPath, ...args]);
}

async function runAgentExpectExit(args, expectedCode) {
  try {
    const result = await runAgent(args);
    assert.fail(`expected exit ${expectedCode}, got success with stdout ${result.stdout}`);
  } catch (error) {
    assert.strictEqual(error.code, expectedCode);
    return error;
  }
}

async function writeTempConfig(dir) {
  const configPath = join(dir, 'linke-config.json');
  await writeFile(configPath, JSON.stringify({
    serverUrl: 'http://localhost:3000',
    deviceId: 'macbook-alpha',
    backupJobs: [{ name: 'Documents', sourcePath: join(dir, 'Documents') }],
  }));
  return configPath;
}

async function writeManifest(dir, manifest) {
  const manifestPath = join(dir, 'executor-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

function validInstallManifest() {
  return {
    kind: 'supervisor-lifecycle-executor-manifest',
    schemaVersion: 1,
    actions: [
      {
        actionId: 'render-launch-agent-plist',
        implementationId: 'render-plist-impl',
        mode: 'guarded-host-action',
        requiresApprovalRecord: true,
        maxAttempts: 2,
      },
      {
        actionId: 'write-launch-agent-plist',
        implementationId: 'write-plist-impl',
        mode: 'guarded-host-action',
        requiresApprovalRecord: true,
        maxAttempts: 1,
      },
      {
        actionId: 'load-launch-agent',
        implementationId: 'load-agent-impl',
        mode: 'guarded-host-action',
        requiresApprovalRecord: true,
        maxAttempts: 3,
      },
    ],
  };
}

function assertNoSensitiveOutput(output, ...paths) {
  for (const disallowed of [
    'localhost',
    'Documents',
    'token=',
    'password=',
    'Authorization',
    'linke-config.json',
    'executor-manifest.json',
    'bad-executor-manifest',
    'SECRET_XYZ',
    '/usr/bin',
    '/Users/ah',
  ]) {
    assert.ok(!output.includes(disallowed), `output leaked ${disallowed}`);
  }
  assert.doesNotMatch(output, /\beval\b/i);
  assert.doesNotMatch(output, /EEXIST|ENOTDIR|EACCES|ENOENT|SyntaxError/i);
  for (const path of paths) {
    assert.doesNotMatch(output, new RegExp(escapeRegExp(path)));
  }
}

describe('agent supervisor-lifecycle-executor-manifest-readiness', () => {
  it('prints blocked manifest readiness for a valid manifest without writing local state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-cli-valid-'));
    try {
      const configPath = await writeTempConfig(dir);
      const manifestPath = await writeManifest(dir, validInstallManifest());

      const { stdout } = await runAgent([
        'supervisor-lifecycle-executor-manifest-readiness',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', manifestPath,
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(report.command, 'supervisor-lifecycle-executor-manifest-readiness');
      assert.strictEqual(report.operation, 'install');
      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.manifestState, 'ready');
      assert.strictEqual(report.manifestReady, true);
      assert.strictEqual(report.executorReady, false);
      assert.deepStrictEqual(report.manifestBlockers, []);
      assert.deepStrictEqual(report.blockers, ['guarded-executor-runner-missing']);
      assert.deepStrictEqual(report.nextBlockers, ['guarded-executor-runner-missing']);
      assert.strictEqual(report.actionManifests.length, 3);
      assert.ok(report.actionManifests.every((entry) => entry.wouldRun === false && entry.wouldWrite === false));
      assert.strictEqual(report.safety.readOnly, true);
      assert.strictEqual(report.safety.lifecycleApplied, false);
      assert.strictEqual(report.safety.launchctlCalled, false);
      assert.strictEqual(report.safety.filesystemWritten, false);
      await assert.rejects(() => readdir(join(dir, 'store')), /ENOENT/);
      assertNoSensitiveOutput(stdout, configPath, manifestPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--fail-on-blocked exits 2 after printing blocked manifest readiness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-cli-fail-'));
    try {
      const configPath = await writeTempConfig(dir);
      const manifestPath = await writeManifest(dir, validInstallManifest());

      const error = await runAgentExpectExit([
        'supervisor-lifecycle-executor-manifest-readiness',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', manifestPath,
        '--fail-on-blocked',
      ], 2);
      const report = JSON.parse(error.stdout);

      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.manifestReady, true);
      assert.strictEqual(report.executorReady, false);
      assert.deepStrictEqual(report.blockers, ['guarded-executor-runner-missing']);
      assertNoSensitiveOutput(`${error.stdout}${error.stderr}`, configPath, manifestPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redacts unsafe manifest values from blocked output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-cli-unsafe-'));
    try {
      const configPath = await writeTempConfig(dir);
      const unsafeManifest = validInstallManifest();
      unsafeManifest.actions[0].secretValue = 'token=SECRET_XYZ';
      unsafeManifest.actions[1].implementationId = '/usr/bin/eval';
      const manifestPath = await writeManifest(dir, unsafeManifest);

      const { stdout } = await runAgent([
        'supervisor-lifecycle-executor-manifest-readiness',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', manifestPath,
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.manifestReady, false);
      assert.ok(report.manifestBlockers.includes('secret-reference'));
      assert.strictEqual(report.actionManifests[1].implementationId, '[redacted]');
      assertNoSensitiveOutput(stdout, configPath, manifestPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes config and manifest read or parse failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-cli-errors-'));
    try {
      const badConfigPath = join(dir, 'bad-config.json');
      await writeFile(badConfigPath, '{"token":"SECRET_XYZ"}');
      const manifestPath = await writeManifest(dir, validInstallManifest());
      const configError = await runAgentExpectExit([
        'supervisor-lifecycle-executor-manifest-readiness',
        '--config', badConfigPath,
        '--operation', 'install',
        '--manifest', manifestPath,
      ], 1);
      assert.match(configError.stderr, /supervisor-lifecycle-executor-manifest-readiness failed; verify --config points to a readable valid Linke config/);
      assertNoSensitiveOutput(`${configError.stdout}${configError.stderr}`, badConfigPath, manifestPath, dir);

      const configPath = await writeTempConfig(dir);
      const badManifestPath = join(dir, 'bad-executor-manifest.json');
      await writeFile(badManifestPath, '{"token":"SECRET_XYZ"');
      const manifestError = await runAgentExpectExit([
        'supervisor-lifecycle-executor-manifest-readiness',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', badManifestPath,
      ], 1);
      assert.match(manifestError.stderr, /supervisor-lifecycle-executor-manifest-readiness failed; verify --manifest points to a readable valid executor manifest JSON/);
      assertNoSensitiveOutput(`${manifestError.stdout}${manifestError.stderr}`, configPath, badManifestPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported write-like inputs with sanitized errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-cli-args-'));
    try {
      const configPath = await writeTempConfig(dir);
      const manifestPath = await writeManifest(dir, validInstallManifest());

      const missingManifest = await runAgentExpectExit([
        'supervisor-lifecycle-executor-manifest-readiness',
        '--config', configPath,
        '--operation', 'install',
      ], 1);
      assert.match(missingManifest.stderr, /--manifest is required/);
      assertNoSensitiveOutput(`${missingManifest.stdout}${missingManifest.stderr}`, configPath, dir);

      for (const forbiddenFlag of ['--apply', '--approval', '--data-dir', '--output']) {
        const error = await runAgentExpectExit([
          'supervisor-lifecycle-executor-manifest-readiness',
          '--config', configPath,
          '--operation', 'install',
          '--manifest', manifestPath,
          forbiddenFlag,
          forbiddenFlag === '--apply' ? undefined : join(dir, 'unsafe-value'),
        ].filter(Boolean), 1);
        assert.match(error.stderr, /not supported/);
        assertNoSensitiveOutput(`${error.stdout}${error.stderr}`, configPath, manifestPath, dir);
      }

      const failFlagError = await runAgentExpectExit([
        'supervisor-lifecycle-executor-manifest-readiness',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', manifestPath,
        '--fail-on-blocked', 'yes',
      ], 1);
      assert.match(failFlagError.stderr, /--fail-on-blocked does not accept a value/);
      assertNoSensitiveOutput(`${failFlagError.stdout}${failFlagError.stderr}`, configPath, manifestPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('help documents supervisor lifecycle executor manifest readiness automation', async () => {
    const { stdout } = await runAgent(['--help']);
    assert.match(stdout, /supervisor-lifecycle-executor-manifest-readiness/);
    assert.match(stdout, /--manifest <path>/);
    assert.match(stdout, /--fail-on-blocked/);
  });
});
