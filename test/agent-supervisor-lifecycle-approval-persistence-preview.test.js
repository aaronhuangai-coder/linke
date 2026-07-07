import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function writeApprovalForDryRun(dir, configPath, operation = 'install', overrides = {}) {
  const dryRun = await runAgent(['supervisor-lifecycle-apply', '--config', configPath, '--operation', operation]);
  const dryRunReport = JSON.parse(dryRun.stdout);
  const now = Date.now();
  const approvalPath = join(dir, 'approval.json');
  await writeFile(approvalPath, JSON.stringify({
    operation,
    configHash: dryRunReport.configHash,
    planHash: dryRunReport.planHash,
    approved: true,
    schemaVersion: 1,
    approvedBy: 'operator@example.invalid',
    reason: 'V0.91 CLI preview approval should not leak',
    acknowledgements: ['operator accepts preview-only approval persistence'],
    approvedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    ...overrides,
  }));
  return approvalPath;
}

describe('agent supervisor-lifecycle-approval-persistence-preview', () => {
  it('prints sanitized blocked preview for a valid approval and exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-approval-preview-cli-'));
    try {
      const configPath = await writeTempConfig(dir);
      const approvalPath = await writeApprovalForDryRun(dir, configPath);

      const { stdout } = await runAgent([
        'supervisor-lifecycle-approval-persistence-preview',
        '--config', configPath,
        '--operation', 'install',
        '--approval', approvalPath,
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(report.command, 'supervisor-lifecycle-approval-persistence-preview');
      assert.strictEqual(report.operation, 'install');
      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.approvalValid, true);
      assert.deepStrictEqual(report.blockers, ['approval-persistence-store-missing']);
      assert.strictEqual(report.persistence.previewOnly, true);
      assert.strictEqual(report.persistence.wouldPersist, false);
      assert.strictEqual(report.persistence.validation.acknowledgementCount, 1);
      assert.strictEqual(report.safety.approvalPersisted, false);
      assert.doesNotMatch(stdout, /operator@example|CLI preview approval|operator accepts|sha256:|localhost|Documents|token|secret|\.ssh|\/Users\/ah/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--fail-on-blocked exits 2 after printing the blocked preview', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-approval-preview-cli-'));
    try {
      const configPath = await writeTempConfig(dir);
      const approvalPath = await writeApprovalForDryRun(dir, configPath);

      const error = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persistence-preview',
        '--config', configPath,
        '--operation', 'install',
        '--approval', approvalPath,
        '--fail-on-blocked',
      ], 2);
      const report = JSON.parse(error.stdout);

      assert.strictEqual(report.state, 'blocked');
      assert.ok(report.blockers.includes('approval-persistence-store-missing'));
      assert.doesNotMatch(error.stderr, /operator@example|secret|token/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints safe validation blockers when approval is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-approval-preview-cli-'));
    try {
      const configPath = await writeTempConfig(dir);

      const { stdout } = await runAgent([
        'supervisor-lifecycle-approval-persistence-preview',
        '--config', configPath,
        '--operation', 'rollback',
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(report.approvalValid, false);
      assert.ok(report.blockers.includes('approval-missing-required-fields'));
      assert.ok(report.blockers.includes('approval-persistence-store-missing'));
      assert.strictEqual(report.persistence.validation.acknowledgementCount, 0);
      assert.doesNotMatch(stdout, /operator@example|secret|token|Documents|localhost|\/Users\/ah/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed arguments with sanitized errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-approval-preview-cli-'));
    try {
      const configPath = await writeTempConfig(dir);
      const applyError = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persistence-preview',
        '--config', configPath,
        '--operation', 'install',
        '--apply',
      ], 1);
      assert.match(applyError.stderr, /--apply is not supported/);

      const operationError = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persistence-preview',
        '--config', configPath,
        '--operation', 'restart',
      ], 1);
      assert.match(operationError.stderr, /operation must be one of: install, uninstall, rollback, recover/);
      assert.doesNotMatch(operationError.stderr, /Documents|token|secret|password/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes config and approval parse errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-approval-preview-cli-'));
    try {
      const badConfigPath = join(dir, 'bad-config.json');
      await writeFile(badConfigPath, '{"token":"should-not-leak"}');
      const configError = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persistence-preview',
        '--config', badConfigPath,
        '--operation', 'install',
      ], 1);
      assert.match(configError.stderr, /supervisor-lifecycle-approval-persistence-preview failed; verify --config points to a readable valid Linke config/);
      assert.doesNotMatch(`${configError.stdout}${configError.stderr}`, /should-not-leak|bad-config|token/);

      const configPath = await writeTempConfig(dir);
      const badApprovalPath = join(dir, 'approval.json');
      await writeFile(badApprovalPath, 'not-json-should-not-leak');
      const approvalError = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persistence-preview',
        '--config', configPath,
        '--operation', 'install',
        '--approval', badApprovalPath,
      ], 1);
      assert.match(approvalError.stderr, /failed to read or parse approval file/);
      assert.doesNotMatch(`${approvalError.stdout}${approvalError.stderr}`, /not-json-should-not-leak|approval\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects forbidden approval paths before reading secret-like files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-approval-preview-cli-'));
    try {
      const configPath = await writeTempConfig(dir);
      const forbiddenApprovalPath = join(dir, '.env');
      await writeFile(forbiddenApprovalPath, '{"approvedBy":"should-not-leak","token":"secret-value"}');

      const error = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persistence-preview',
        '--config', configPath,
        '--operation', 'install',
        '--approval', forbiddenApprovalPath,
      ], 1);

      assert.match(error.stderr, /approval path is not allowed/);
      assert.doesNotMatch(`${error.stdout}${error.stderr}`, /should-not-leak|secret-value|token/);

      const sshDir = join(dir, '.ssh');
      await mkdir(sshDir);
      const sshApprovalPath = join(sshDir, 'id_rsa');
      await writeFile(sshApprovalPath, '{"approvedBy":"ssh-secret"}');
      const sshError = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persistence-preview',
        '--config', configPath,
        '--operation', 'install',
        '--approval', sshApprovalPath,
      ], 1);
      assert.match(sshError.stderr, /approval path is not allowed/);
      assert.doesNotMatch(`${sshError.stdout}${sshError.stderr}`, /ssh-secret|id_rsa/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('help documents supervisor lifecycle approval persistence preview', async () => {
    const { stdout } = await runAgent(['--help']);
    assert.match(stdout, /supervisor-lifecycle-approval-persistence-preview/);
    assert.match(stdout, /--approval <path>/);
  });
});
