import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');

async function writeTempConfig(dir) {
  const configPath = join(dir, 'linke-config.json');
  await writeFile(configPath, JSON.stringify({
    serverUrl: 'http://localhost:3000',
    deviceId: 'macbook-alpha',
    backupJobs: [{ name: 'Documents', sourcePath: join(dir, 'Documents') }],
  }));
  return configPath;
}

async function runAgent(args, options = {}) {
  return exec(process.execPath, [agentPath, ...args], {
    env: { ...process.env, ...options.env },
  });
}

async function runAgentExpectExit(args, expectedCode, options = {}) {
  try {
    const result = await runAgent(args, options);
    assert.fail(`expected exit ${expectedCode}, got success with stdout ${result.stdout}`);
  } catch (error) {
    assert.strictEqual(error.code, expectedCode);
    return error;
  }
}

it('prints blocked dry-run plan without --apply and exits 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const { stdout } = await runAgent(['supervisor-lifecycle-apply', '--config', configPath, '--operation', 'install']);
    const report = JSON.parse(stdout);
    assert.strictEqual(report.command, 'supervisor-lifecycle-apply');
    assert.strictEqual(report.mode, 'dry-run-only');
    assert.strictEqual(report.operation, 'install');
    assert.strictEqual(report.applyRequested, false);
    assert.strictEqual(report.state, 'blocked');
    assert.ok(report.blockers.includes('apply-flag-required'));
    assert.strictEqual(report.safety.launchctlCalled, false);
    assert.strictEqual(report.safety.filesystemWritten, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('--apply without env gate prints blocked report and exits 2 without writing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  const launchdDir = join(dir, 'LaunchAgents');
  try {
    const configPath = await writeTempConfig(dir);
    const error = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'install',
      '--apply',
      '--launchd-dir', launchdDir,
    ], 2);
    const report = JSON.parse(error.stdout);
    assert.ok(report.blockers.includes('env-gate-disabled'));
    assert.ok(report.blockers.includes('executor-implementation-missing'));
    assert.strictEqual(report.safety.launchctlCalled, false);
    assert.strictEqual(report.safety.filesystemWritten, false);
    await assert.rejects(readdir(launchdDir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('--apply with missing approval prints blocked report and exits 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const error = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'rollback',
      '--apply',
    ], 2, { env: { LINKE_SUPERVISOR_LIFECYCLE_APPLY: 'enabled' } });
    const report = JSON.parse(error.stdout);
    assert.ok(report.blockers.includes('approval-missing'));
    assert.strictEqual(report.safety.metadataWritten, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('--apply with valid approval still exits 2 with executor blocker only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const dryRun = await runAgent(['supervisor-lifecycle-apply', '--config', configPath, '--operation', 'install']);
    const dryRunReport = JSON.parse(dryRun.stdout);
    const approvalPath = join(dir, 'approval.json');
    const now = Date.now();
    await writeFile(approvalPath, JSON.stringify({
      operation: 'install',
      configHash: dryRunReport.configHash,
      planHash: dryRunReport.planHash,
      approved: true,
      schemaVersion: 1,
      approvedBy: 'operator@example.invalid',
      reason: 'V0.87 valid approval still has no executor',
      acknowledgements: ['no-real-host-mutation-in-v0.87'],
      approvedAt: new Date(now - 5 * 60 * 1000).toISOString(),
      expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    }));

    const error = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'install',
      '--approval', approvalPath,
      '--apply',
    ], 2, { env: { LINKE_SUPERVISOR_LIFECYCLE_APPLY: 'enabled' } });
    const report = JSON.parse(error.stdout);

    assert.deepStrictEqual(report.blockers, ['executor-implementation-missing']);
    assert.strictEqual(report.safety.hostMutation, false);
    assert.strictEqual(report.safety.launchctlCalled, false);
    assert.strictEqual(report.safety.filesystemWritten, false);
    assert.doesNotMatch(error.stdout, /operator@example|valid approval still has no executor|acknowledgements/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('prints blocked dry-run plans for uninstall and rollback operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    for (const operation of ['uninstall', 'rollback']) {
      const { stdout } = await runAgent(['supervisor-lifecycle-apply', '--config', configPath, '--operation', operation]);
      const report = JSON.parse(stdout);
      assert.strictEqual(report.operation, operation);
      assert.strictEqual(report.mode, 'dry-run-only');
      assert.strictEqual(report.state, 'blocked');
      assert.ok(report.blockers.includes('apply-flag-required'));
      assert.ok(report.blockers.includes('executor-implementation-missing'));
      assert.ok(report.actions.length > 0);
      assert.ok(report.actions.every((action) => action.wouldRun === false && action.wouldWrite === false));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('invalid operation exits 1 with sanitized error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const error = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'restart',
    ], 1);
    assert.match(error.stderr, /operation must be one of: install, uninstall, rollback, recover/);
    assert.doesNotMatch(error.stderr, /Documents|token|secret|password/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects malformed CLI arguments with sanitized errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const applyValueError = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'install',
      '--apply', 'yes',
    ], 1);
    assert.match(applyValueError.stderr, /--apply does not accept a value/);

    const approvalValueError = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'install',
      '--approval',
      '--apply',
    ], 1);
    assert.match(approvalValueError.stderr, /--approval requires a path value/);

    const configValueError = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config',
      '--operation', 'install',
    ], 1);
    assert.match(configValueError.stderr, /--config requires a path value/);

    const operationValueError = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation',
    ], 1);
    assert.match(operationValueError.stderr, /--operation requires a value/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('sanitizes config and approval parse errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const badConfigPath = join(dir, 'bad-config.json');
    await writeFile(badConfigPath, '{"token":"should-not-leak"}');
    const configError = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', badConfigPath,
      '--operation', 'install',
    ], 1);
    assert.match(configError.stderr, /supervisor-lifecycle-apply failed; verify --config points to a readable valid Linke config/);
    assert.doesNotMatch(`${configError.stdout}${configError.stderr}`, /should-not-leak|bad-config|token/);

    const configPath = await writeTempConfig(dir);
    const badApprovalPath = join(dir, 'approval.json');
    await writeFile(badApprovalPath, 'not-json-should-not-leak');
    const approvalError = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'install',
      '--approval', badApprovalPath,
      '--apply',
    ], 1, { env: { LINKE_SUPERVISOR_LIFECYCLE_APPLY: 'enabled' } });
    assert.match(approvalError.stderr, /failed to read or parse approval file/);
    assert.doesNotMatch(`${approvalError.stdout}${approvalError.stderr}`, /not-json-should-not-leak|approval\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('recover remains blocked even with apply flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const dryRun = await runAgent(['supervisor-lifecycle-apply', '--config', configPath, '--operation', 'recover']);
    const dryRunReport = JSON.parse(dryRun.stdout);
    const approvalPath = join(dir, 'approval.json');
    await writeFile(approvalPath, JSON.stringify({
      operation: 'recover',
      configHash: dryRunReport.configHash,
      planHash: dryRunReport.planHash,
      approved: true,
      schemaVersion: 1,
      approvedBy: 'operator@example.invalid',
      reason: 'V0.87 recover must remain blocked',
      acknowledgements: ['no-real-host-mutation-in-v0.87'],
      approvedAt: '2026-07-07T04:30:00.000Z',
      expiresAt: '2026-07-07T05:30:00.000Z',
    }));
    const error = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'recover',
      '--approval', approvalPath,
      '--apply',
    ], 2, { env: { LINKE_SUPERVISOR_LIFECYCLE_APPLY: 'enabled' } });
    const report = JSON.parse(error.stdout);
    assert.ok(report.blockers.includes('recovery-supervisor-design-missing'));
    assert.strictEqual(report.safety.hostMutation, false);
    assert.doesNotMatch(error.stdout, /operator@example|recover must remain blocked|acknowledgements/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects forbidden approval paths without reading secret-like files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const forbiddenApprovalPath = join(dir, '.env');
    await writeFile(forbiddenApprovalPath, '{"approvedBy":"should-not-leak","token":"secret-value"}');
    const error = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'install',
      '--approval', forbiddenApprovalPath,
      '--apply',
    ], 1, { env: { LINKE_SUPERVISOR_LIFECYCLE_APPLY: 'enabled' } });

    assert.match(error.stderr, /approval path is not allowed/);
    assert.doesNotMatch(`${error.stdout}${error.stderr}`, /should-not-leak|secret-value|token/);

    const sshDir = join(dir, '.ssh');
    await mkdir(sshDir);
    const sshApprovalPath = join(sshDir, 'id_rsa');
    await writeFile(sshApprovalPath, '{"approvedBy":"ssh-secret"}');
    const sshError = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'install',
      '--approval', sshApprovalPath,
      '--apply',
    ], 1, { env: { LINKE_SUPERVISOR_LIFECYCLE_APPLY: 'enabled' } });
    assert.match(sshError.stderr, /approval path is not allowed/);
    assert.doesNotMatch(`${sshError.stdout}${sshError.stderr}`, /ssh-secret|id_rsa/);

    const secretsDir = join(dir, 'secrets');
    await mkdir(secretsDir);
    const secretsApprovalPath = join(secretsDir, 'approval.json');
    await writeFile(secretsApprovalPath, '{"approvedBy":"secrets-content"}');
    const secretsError = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'install',
      '--approval', secretsApprovalPath,
      '--apply',
    ], 1, { env: { LINKE_SUPERVISOR_LIFECYCLE_APPLY: 'enabled' } });
    assert.match(secretsError.stderr, /approval path is not allowed/);
    assert.doesNotMatch(`${secretsError.stdout}${secretsError.stderr}`, /secrets-content|approval\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('help documents supervisor-lifecycle-apply and safety gates', async () => {
  const { stdout } = await runAgent(['--help']);
  assert.match(stdout, /supervisor-lifecycle-apply/);
  assert.match(stdout, /LINKE_SUPERVISOR_LIFECYCLE_APPLY=enabled/);
  assert.match(stdout, /--approval <path>/);
});
