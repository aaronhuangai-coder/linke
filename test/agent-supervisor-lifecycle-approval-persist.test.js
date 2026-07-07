import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
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
  const sourceDir = join(dir, 'Documents');
  const configPath = join(dir, 'linke-config.json');
  await writeFile(configPath, JSON.stringify({
    serverUrl: 'http://localhost:3000',
    deviceId: 'macbook-alpha',
    backupJobs: [{ name: 'Documents', sourcePath: sourceDir }],
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
    reason: 'V0.94 persist approval should not leak',
    acknowledgements: ['operator accepts local approval persistence'],
    approvedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    ...overrides,
  }));
  return approvalPath;
}

describe('agent supervisor-lifecycle-approval-persist', () => {
  it('persists a sanitized approval record for a valid approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-cli-'));
    const storeDir = join(dir, 'store');
    try {
      const configPath = await writeTempConfig(dir);
      const approvalPath = await writeApprovalForDryRun(dir, configPath, 'install');

      const { stdout } = await runAgent([
        'supervisor-lifecycle-approval-persist',
        '--config', configPath,
        '--operation', 'install',
        '--approval', approvalPath,
        '--data-dir', storeDir,
      ]);
      const record = JSON.parse(stdout);
      const records = await readSupervisorLifecycleApprovalRecords(storeDir);

      assert.strictEqual(record.command, 'supervisor-lifecycle-approval-record');
      assert.strictEqual(record.operation, 'install');
      assert.strictEqual(record.state, 'persisted');
      assert.strictEqual(record.approvalValid, true);
      assert.deepStrictEqual(record.blockersResolved, ['approval-persistence-store-missing']);
      assert.strictEqual(record.safety.approvalPersisted, true);
      assert.strictEqual(record.safety.filesystemWritten, true);
      assert.strictEqual(record.safety.hostMutation, false);
      assert.strictEqual(record.safety.launchctlCalled, false);
      assert.deepStrictEqual(records, [record]);
      assert.doesNotMatch(stdout, /operator@example|persist approval|operator accepts/i);
      assert.doesNotMatch(stdout, /sha256:|localhost|Documents|approval\.json|linke-config|token|secret|\/Users\/ah/i);
      assert.doesNotMatch(stdout, new RegExp(escapeRegExp(configPath)));
      assert.doesNotMatch(stdout, new RegExp(escapeRegExp(approvalPath)));
      assert.doesNotMatch(stdout, new RegExp(escapeRegExp(storeDir)));
      assert.doesNotMatch(stdout, new RegExp(escapeRegExp(dir)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints a sanitized blocked preview and does not persist invalid approvals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-cli-'));
    const storeDir = join(dir, 'store');
    try {
      const configPath = await writeTempConfig(dir);
      const approvalPath = await writeApprovalForDryRun(dir, configPath, 'install', {
        planHash: 'sha256:wrong-plan-secret',
      });

      const error = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persist',
        '--config', configPath,
        '--operation', 'install',
        '--approval', approvalPath,
        '--data-dir', storeDir,
      ], 2);
      const report = JSON.parse(error.stdout);

      assert.strictEqual(report.command, 'supervisor-lifecycle-approval-persistence-preview');
      assert.strictEqual(report.state, 'blocked');
      assert.strictEqual(report.approvalValid, false);
      assert.ok(report.blockers.includes('approval-plan-hash-mismatch'));
      assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(storeDir), []);
      await assert.rejects(() => readdir(join(storeDir, 'approvals')), /ENOENT/);
      const output = `${error.stdout}${error.stderr}`;
      assert.doesNotMatch(output, /wrong-plan-secret|operator@example|persist approval|operator accepts|approval\.json|linke-config|token|secret/i);
      assert.doesNotMatch(output, new RegExp(escapeRegExp(configPath)));
      assert.doesNotMatch(output, new RegExp(escapeRegExp(approvalPath)));
      assert.doesNotMatch(output, new RegExp(escapeRegExp(storeDir)));
      assert.doesNotMatch(output, new RegExp(escapeRegExp(dir)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('requires explicit data-dir and rejects apply without leaking paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-cli-'));
    try {
      const configPath = await writeTempConfig(dir);
      const approvalPath = await writeApprovalForDryRun(dir, configPath, 'install');

      const missingDataDir = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persist',
        '--config', configPath,
        '--operation', 'install',
        '--approval', approvalPath,
      ], 1);
      assert.match(missingDataDir.stderr, /--data-dir is required/);
      assert.doesNotMatch(`${missingDataDir.stdout}${missingDataDir.stderr}`, /linke-config|approval\.json|Documents|localhost|operator@example|token|secret/i);

      const applyError = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persist',
        '--config', configPath,
        '--operation', 'install',
        '--approval', approvalPath,
        '--data-dir', join(dir, 'store'),
        '--apply',
      ], 1);
      assert.match(applyError.stderr, /--apply is not supported/);
      assert.doesNotMatch(`${applyError.stdout}${applyError.stderr}`, /linke-config|approval\.json|Documents|localhost|operator@example|token|secret/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes filesystem write failures without leaking data-dir paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-cli-'));
    try {
      const configPath = await writeTempConfig(dir);
      const approvalPath = await writeApprovalForDryRun(dir, configPath, 'install');
      const storeFilePath = join(dir, 'store-file');
      await writeFile(storeFilePath, 'not a directory');

      const error = await runAgentExpectExit([
        'supervisor-lifecycle-approval-persist',
        '--config', configPath,
        '--operation', 'install',
        '--approval', approvalPath,
        '--data-dir', storeFilePath,
      ], 1);
      const output = `${error.stdout}${error.stderr}`;

      assert.match(error.stderr, /failed to persist approval record/);
      assert.doesNotMatch(output, /ENOTDIR|EACCES|store-file|approval\.json|linke-config|Documents|localhost|operator@example|token|secret/i);
      assert.doesNotMatch(output, new RegExp(escapeRegExp(configPath)));
      assert.doesNotMatch(output, new RegExp(escapeRegExp(approvalPath)));
      assert.doesNotMatch(output, new RegExp(escapeRegExp(storeFilePath)));
      assert.doesNotMatch(output, new RegExp(escapeRegExp(dir)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
