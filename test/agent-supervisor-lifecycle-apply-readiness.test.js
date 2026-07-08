import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readSupervisorLifecycleApprovalRecords } from '../src/approval-store.js';

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
    reason: 'V0.97 readiness CLI approval reason must not leak',
    acknowledgements: ['operator accepts readiness CLI gate'],
    approvedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    ...overrides,
  }));
  return approvalPath;
}

function assertNoSensitiveOutput(output, ...paths) {
  assert.doesNotMatch(output, /operator@example|readiness CLI approval|operator accepts|sha256:|localhost|Documents|token|secret|password|approval\.json|linke-config|\/Users\/ah/i);
  assert.doesNotMatch(output, /EEXIST|ENOTDIR|EACCES|ENOENT/i);
  for (const path of paths) {
    assert.doesNotMatch(output, new RegExp(escapeRegExp(path)));
  }
}

describe('agent supervisor-lifecycle-apply-readiness', () => {
  it('prints blocked readiness without records and does not create approval storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-apply-readiness-cli-empty-'));
    const storeDir = join(dir, 'store');
    try {
      const configPath = await writeTempConfig(dir);

      const { stdout } = await runAgent([
        'supervisor-lifecycle-apply-readiness',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', storeDir,
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(report.command, 'supervisor-lifecycle-apply-readiness');
      assert.strictEqual(report.operation, 'install');
      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.approvalRecordState, 'blocked');
      assert.strictEqual(report.approvalRecordReady, false);
      assert.deepStrictEqual(report.blockers, ['approval-record-missing']);
      assert.deepStrictEqual(report.nextBlockers, ['executor-implementation-missing']);
      assert.deepStrictEqual(report.approvalRecords, {
        readOnly: true,
        count: 0,
        operationMatchCount: 0,
        persistedMatchCount: 0,
      });
      assert.strictEqual(report.safety.readOnly, true);
      assert.strictEqual(report.safety.lifecycleApplied, false);
      assert.strictEqual(report.safety.launchctlCalled, false);
      assert.strictEqual(report.safety.filesystemWritten, false);
      assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(storeDir), []);
      await assert.rejects(() => readdir(join(storeDir, 'approvals')), /ENOENT/);
      assertNoSensitiveOutput(stdout, configPath, storeDir, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks only the approval record gate ready from a persisted sanitized record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-apply-readiness-cli-ready-'));
    const storeDir = join(dir, 'store');
    try {
      const configPath = await writeTempConfig(dir);
      const approvalPath = await writeApprovalForDryRun(dir, configPath, 'rollback');
      const persisted = await runAgent([
        'supervisor-lifecycle-approval-persist',
        '--config', configPath,
        '--operation', 'rollback',
        '--approval', approvalPath,
        '--data-dir', storeDir,
      ]);
      const persistedRecord = JSON.parse(persisted.stdout);

      const { stdout } = await runAgent([
        'supervisor-lifecycle-apply-readiness',
        '--config', configPath,
        '--operation', 'rollback',
        '--data-dir', storeDir,
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.approvalRecordState, 'ready');
      assert.strictEqual(report.approvalRecordReady, true);
      assert.deepStrictEqual(report.blockers, []);
      assert.deepStrictEqual(report.nextBlockers, ['executor-implementation-missing']);
      assert.strictEqual(report.approvalRecords.count, 1);
      assert.strictEqual(report.approvalRecords.operationMatchCount, 1);
      assert.strictEqual(report.approvalRecords.persistedMatchCount, 1);
      assert.strictEqual(report.gates.approvalRecordPersisted, true);
      assert.strictEqual(report.gates.approvalRecordValid, true);
      assert.strictEqual(report.gates.executorImplemented, false);
      assert.strictEqual(report.safety.lifecycleApplied, false);
      assert.strictEqual(report.safety.launchctlCalled, false);
      assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(storeDir), [persistedRecord]);
      assertNoSensitiveOutput(stdout, configPath, approvalPath, storeDir, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--fail-on-blocked exits 2 because the top-level lifecycle apply remains blocked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-apply-readiness-cli-fail-'));
    const storeDir = join(dir, 'store');
    try {
      const configPath = await writeTempConfig(dir);
      const approvalPath = await writeApprovalForDryRun(dir, configPath, 'install');
      await runAgent([
        'supervisor-lifecycle-approval-persist',
        '--config', configPath,
        '--operation', 'install',
        '--approval', approvalPath,
        '--data-dir', storeDir,
      ]);

      const error = await runAgentExpectExit([
        'supervisor-lifecycle-apply-readiness',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', storeDir,
        '--fail-on-blocked',
      ], 2);
      const report = JSON.parse(error.stdout);

      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.approvalRecordReady, true);
      assert.deepStrictEqual(report.nextBlockers, ['executor-implementation-missing']);
      assertNoSensitiveOutput(`${error.stdout}${error.stderr}`, configPath, approvalPath, storeDir, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported write-like inputs with sanitized errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-apply-readiness-cli-args-'));
    try {
      const configPath = await writeTempConfig(dir);

      const missingDataDir = await runAgentExpectExit([
        'supervisor-lifecycle-apply-readiness',
        '--config', configPath,
        '--operation', 'install',
      ], 1);
      assert.match(missingDataDir.stderr, /--data-dir is required/);
      assertNoSensitiveOutput(`${missingDataDir.stdout}${missingDataDir.stderr}`, configPath, dir);

      const applyError = await runAgentExpectExit([
        'supervisor-lifecycle-apply-readiness',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', join(dir, 'store'),
        '--apply',
      ], 1);
      assert.match(applyError.stderr, /--apply is not supported/);
      assertNoSensitiveOutput(`${applyError.stdout}${applyError.stderr}`, configPath, dir);

      const approvalError = await runAgentExpectExit([
        'supervisor-lifecycle-apply-readiness',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', join(dir, 'store'),
        '--approval', join(dir, 'approval.json'),
      ], 1);
      assert.match(approvalError.stderr, /--approval is not supported/);
      assertNoSensitiveOutput(`${approvalError.stdout}${approvalError.stderr}`, configPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes config and approval store read failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-apply-readiness-cli-errors-'));
    try {
      const badConfigPath = join(dir, 'bad-config.json');
      await writeFile(badConfigPath, '{"token":"should-not-leak"}');
      const configError = await runAgentExpectExit([
        'supervisor-lifecycle-apply-readiness',
        '--config', badConfigPath,
        '--operation', 'install',
        '--data-dir', join(dir, 'store'),
      ], 1);
      assert.match(configError.stderr, /supervisor-lifecycle-apply-readiness failed; verify --config points to a readable valid Linke config/);
      assertNoSensitiveOutput(`${configError.stdout}${configError.stderr}`, badConfigPath, dir);

      const configPath = await writeTempConfig(dir);
      const storeFilePath = join(dir, 'store-file');
      await writeFile(storeFilePath, 'not a directory');
      const storeError = await runAgentExpectExit([
        'supervisor-lifecycle-apply-readiness',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', storeFilePath,
      ], 1);
      assert.match(storeError.stderr, /failed to read supervisor lifecycle approval records/);
      assertNoSensitiveOutput(`${storeError.stdout}${storeError.stderr}`, configPath, storeFilePath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('help documents supervisor lifecycle apply readiness automation', async () => {
    const { stdout } = await runAgent(['--help']);
    assert.match(stdout, /supervisor-lifecycle-apply-readiness/);
    assert.match(stdout, /--data-dir <path>/);
    assert.match(stdout, /--fail-on-blocked/);
  });
});
