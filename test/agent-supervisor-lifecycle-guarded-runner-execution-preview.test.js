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

async function writeJson(dir, filename, value) {
  const filePath = join(dir, filename);
  await writeFile(filePath, JSON.stringify(value));
  return filePath;
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

function validRunnerBinding() {
  return {
    kind: 'supervisor-lifecycle-guarded-runner-binding',
    schemaVersion: 1,
    bindings: [
      {
        actionId: 'render-launch-agent-plist',
        implementationId: 'render-plist-impl',
        mode: 'guarded-host-action',
        runnerKind: 'guarded-runner-stub',
        requiresApprovalRecord: true,
        maxAttempts: 2,
      },
      {
        actionId: 'write-launch-agent-plist',
        implementationId: 'write-plist-impl',
        mode: 'guarded-host-action',
        runnerKind: 'guarded-runner-stub',
        requiresApprovalRecord: true,
        maxAttempts: 1,
      },
      {
        actionId: 'load-launch-agent',
        implementationId: 'load-agent-impl',
        mode: 'guarded-host-action',
        runnerKind: 'guarded-runner-stub',
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
    'runner-binding.json',
    'bad-executor-manifest',
    'bad-runner-binding',
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

describe('agent supervisor-lifecycle-guarded-runner-execution-preview', () => {
  it('prints blocked guarded runner execution preview for valid inputs without writing local state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-valid-'));
    try {
      const configPath = await writeTempConfig(dir);
      const manifestPath = await writeJson(dir, 'executor-manifest.json', validInstallManifest());
      const bindingPath = await writeJson(dir, 'runner-binding.json', validRunnerBinding());

      const { stdout } = await runAgent([
        'supervisor-lifecycle-guarded-runner-execution-preview',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(report.command, 'supervisor-lifecycle-guarded-runner-execution-preview');
      assert.strictEqual(report.operation, 'install');
      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.executionReady, false);
      assert.strictEqual(report.executorReady, false);
      assert.strictEqual(report.wouldExecute, false);
      assert.strictEqual(report.runnerBindingsReady, true);
      assert.deepStrictEqual(report.blockers, ['guarded-runner-execution-preview-only']);
      assert.deepStrictEqual(report.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
      assert.strictEqual(report.actionPreviews.length, 3);
      assert.ok(report.actionPreviews.every((entry) =>
        entry.status === 'blocked' &&
        entry.wouldExecute === false &&
        entry.wouldRun === false &&
        entry.wouldWrite === false));
      assert.strictEqual(report.safety.readOnly, true);
      assert.strictEqual(report.safety.launchctlCalled, false);
      assert.strictEqual(report.safety.filesystemWritten, false);
      assert.strictEqual(report.safety.processListRead, false);
      assert.strictEqual(report.safety.lifecycleApplied, false);
      await assert.rejects(() => readdir(join(dir, 'store')), /ENOENT/);
      assertNoSensitiveOutput(stdout, configPath, manifestPath, bindingPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--fail-on-blocked exits 2 after printing blocked execution preview', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-fail-'));
    try {
      const configPath = await writeTempConfig(dir);
      const manifestPath = await writeJson(dir, 'executor-manifest.json', validInstallManifest());
      const bindingPath = await writeJson(dir, 'runner-binding.json', validRunnerBinding());

      const error = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-preview',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
        '--fail-on-blocked',
      ], 2);
      const report = JSON.parse(error.stdout);

      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.executionReady, false);
      assert.strictEqual(report.executorReady, false);
      assertNoSensitiveOutput(`${error.stdout}${error.stderr}`, configPath, manifestPath, bindingPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redacts unsafe runner binding metadata from action previews', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-unsafe-'));
    try {
      const configPath = await writeTempConfig(dir);
      const manifestPath = await writeJson(dir, 'executor-manifest.json', validInstallManifest());
      const binding = validRunnerBinding();
      binding.bindings[0].implementationId =
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      binding.bindings[0].runnerKind = 'node /Users/ah/.ssh/id_rsa token=SECRET_XYZ';
      binding.bindings[0].mode = 'curl http://unsafe.example password=super-secret';
      const bindingPath = await writeJson(dir, 'runner-binding.json', binding);

      const { stdout } = await runAgent([
        'supervisor-lifecycle-guarded-runner-execution-preview',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.runnerBindingsReady, false);
      assert.strictEqual(report.actionPreviews[0].implementationId, '[redacted]');
      assert.strictEqual(report.actionPreviews[0].runnerKind, '[redacted]');
      assert.strictEqual(report.actionPreviews[0].mode, '[redacted]');
      assertNoSensitiveOutput(stdout, configPath, manifestPath, bindingPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes config, manifest, and runner binding read or parse failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-errors-'));
    try {
      const badConfigPath = join(dir, 'bad-config.json');
      await writeFile(badConfigPath, '{"token":"SECRET_XYZ"}');
      const manifestPath = await writeJson(dir, 'executor-manifest.json', validInstallManifest());
      const bindingPath = await writeJson(dir, 'runner-binding.json', validRunnerBinding());
      const configError = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-preview',
        '--config', badConfigPath,
        '--operation', 'install',
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
      ], 1);
      assert.match(configError.stderr, /supervisor-lifecycle-guarded-runner-execution-preview failed; verify --config points to a readable valid Linke config/);
      assertNoSensitiveOutput(`${configError.stdout}${configError.stderr}`, badConfigPath, manifestPath, bindingPath, dir);

      const configPath = await writeTempConfig(dir);
      const badManifestPath = join(dir, 'bad-executor-manifest.json');
      await writeFile(badManifestPath, '{"token":"SECRET_XYZ"');
      const manifestError = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-preview',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', badManifestPath,
        '--runner-binding', bindingPath,
      ], 1);
      assert.match(manifestError.stderr, /supervisor-lifecycle-guarded-runner-execution-preview failed; verify --manifest points to a readable valid executor manifest JSON/);
      assertNoSensitiveOutput(`${manifestError.stdout}${manifestError.stderr}`, configPath, badManifestPath, bindingPath, dir);

      const badBindingPath = join(dir, 'bad-runner-binding.json');
      await writeFile(badBindingPath, '{"token":"SECRET_XYZ"');
      const bindingError = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-preview',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', manifestPath,
        '--runner-binding', badBindingPath,
      ], 1);
      assert.match(bindingError.stderr, /supervisor-lifecycle-guarded-runner-execution-preview failed; verify --runner-binding points to a readable valid guarded runner binding JSON/);
      assertNoSensitiveOutput(`${bindingError.stdout}${bindingError.stderr}`, configPath, manifestPath, badBindingPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported write-like inputs with sanitized errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-args-'));
    try {
      const configPath = await writeTempConfig(dir);
      const manifestPath = await writeJson(dir, 'executor-manifest.json', validInstallManifest());
      const bindingPath = await writeJson(dir, 'runner-binding.json', validRunnerBinding());

      const missingBinding = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-preview',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', manifestPath,
      ], 1);
      assert.match(missingBinding.stderr, /--runner-binding is required/);
      assertNoSensitiveOutput(`${missingBinding.stdout}${missingBinding.stderr}`, configPath, manifestPath, dir);

      for (const forbiddenFlag of ['--apply', '--approval', '--data-dir', '--output']) {
        const error = await runAgentExpectExit([
          'supervisor-lifecycle-guarded-runner-execution-preview',
          '--config', configPath,
          '--operation', 'install',
          '--manifest', manifestPath,
          '--runner-binding', bindingPath,
          forbiddenFlag,
          forbiddenFlag === '--apply' ? undefined : join(dir, 'unsafe-value'),
        ].filter(Boolean), 1);
        assert.match(error.stderr, /not supported/);
        assertNoSensitiveOutput(`${error.stdout}${error.stderr}`, configPath, manifestPath, bindingPath, dir);
      }

      const failFlagError = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-preview',
        '--config', configPath,
        '--operation', 'install',
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
        '--fail-on-blocked', 'yes',
      ], 1);
      assert.match(failFlagError.stderr, /--fail-on-blocked does not accept a value/);
      assertNoSensitiveOutput(`${failFlagError.stdout}${failFlagError.stderr}`, configPath, manifestPath, bindingPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('help documents supervisor lifecycle guarded runner execution preview automation', async () => {
    const { stdout } = await runAgent(['--help']);
    assert.match(stdout, /supervisor-lifecycle-guarded-runner-execution-preview/);
    assert.match(stdout, /--operation <operation>/);
    assert.match(stdout, /--runner-binding <path>/);
    assert.match(stdout, /--manifest <path>/);
    assert.match(stdout, /--fail-on-blocked/);
  });
});
