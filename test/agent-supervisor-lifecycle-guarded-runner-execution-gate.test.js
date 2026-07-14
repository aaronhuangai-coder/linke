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
    reason: 'V1.14 execution gate approval reason must not leak',
    acknowledgements: ['operator accepts guarded runner execution gate'],
    approvedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    ...overrides,
  }));
  return approvalPath;
}

async function persistApproval(dir, configPath, operation = 'install') {
  const storeDir = join(dir, 'store');
  const approvalPath = await writeApprovalForDryRun(dir, configPath, operation);
  const persisted = await runAgent([
    'supervisor-lifecycle-approval-persist',
    '--config', configPath,
    '--operation', operation,
    '--approval', approvalPath,
    '--data-dir', storeDir,
  ]);
  return {
    approvalPath,
    storeDir,
    persistedRecord: JSON.parse(persisted.stdout),
  };
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
    'serverUrl',
    'sourcePath',
    'Documents',
    'operator@example',
    'execution gate approval',
    'operator accepts',
    'token',
    'secret',
    'Authorization',
    'sha256:',
    'linke-config.json',
    'executor-manifest.json',
    'runner-binding.json',
    'approval.json',
    'bad-executor-manifest',
    'bad-runner-binding',
    'SECRET_XYZ',
    '/usr/bin',
    '/Users/ah',
    'launchctl load',
  ]) {
    assert.ok(!output.includes(disallowed), `output leaked ${disallowed}`);
  }
  assert.doesNotMatch(output, /\beval\b/i);
  assert.doesNotMatch(output, /EEXIST|ENOTDIR|EACCES|ENOENT|SyntaxError/i);
  for (const path of paths) {
    assert.doesNotMatch(output, new RegExp(escapeRegExp(path)));
  }
}

function assertBlockedGate(report) {
  assert.strictEqual(report.command, 'supervisor-lifecycle-guarded-runner-execution-gate');
  assert.strictEqual(report.operation, 'install');
  assert.strictEqual(report.state, 'blocked');
  assert.strictEqual(report.executionGateState, 'blocked');
  assert.strictEqual(report.executionEligible, false);
  assert.strictEqual(report.executorReady, false);
  assert.strictEqual(report.wouldExecute, false);
  assert.strictEqual(report.gates.executionPolicyReady, true);
  assert.strictEqual(report.gates.realRunnerWiringReady, false);
  assert.strictEqual(report.gates.runnerWiringContractReady, false);
  assert.strictEqual(report.gates.runnerRegistryReady, false);
  assert.strictEqual(report.gates.hostMutationAdapterReady, false);
  assert.strictEqual(report.gates.rollbackAnchorReady, false);
  assert.strictEqual(report.gates.attemptAuditReady, false);
  assert.strictEqual(report.gates.operatorRecoveryReady, false);
  assert.strictEqual(report.realRunnerWiringReady, false);
  assert.deepStrictEqual(report.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.ok(report.blockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.strictEqual(report.runnerWiringContract.command, 'supervisor-lifecycle-guarded-runner-wiring-contract');
  assert.strictEqual(report.runnerWiringContract.state, 'blocked');
  assert.strictEqual(report.runnerWiringContract.realRunnerWiringReady, false);
  assert.strictEqual(report.runnerWiringContract.readyCount, 1);
  assert.strictEqual(report.runnerWiringContract.blockedCount, 5);
  assert.deepStrictEqual(report.runnerWiringContract.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.state, 'ready');
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.executionPolicyReady, true);
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.realExecutionPolicyReady, true);
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.policyEntries[0].policyKind, 'fail-closed-execution-policy');
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.policyEntries[0].wouldAuthorizeExecution, false);
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.policyEntries[0].blockerCode, null);
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.policyEntries[0].evidenceCode, 'execution-policy-ready');
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.policyEntries[0].allowLifecycleApply, false);
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.policyEntries[0].allowRemoteCommand, false);
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.policyEntries[0].wouldRun, false);
  assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.policyEntries[0].wouldWrite, false);
  assert.strictEqual(report.runnerWiringContract.requiredContracts[0].status, 'ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[0].blockerCode, null);
  assert.strictEqual(report.runnerWiringContract.requiredContracts[0].evidenceCode, 'execution-policy-ready');
  assert.strictEqual(report.policyDecision.state, 'denied');
  assert.strictEqual(report.policyDecision.authorized, false);
  assert.strictEqual(report.policyDecision.wouldAuthorizeExecution, false);
  assert.strictEqual(report.policyDecision.wouldRun, false);
  assert.strictEqual(report.policyDecision.wouldWrite, false);
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.state, 'blocked');
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.hostMutationAdapterReady, false);
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.adapterEntries[0].wouldMutateHost, false);
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.adapterEntries[0].wouldRun, false);
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.adapterEntries[0].wouldWrite, false);
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.state, 'blocked');
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.rollbackAnchorReady, false);
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.anchorEntries[0].wouldWriteAnchor, false);
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.anchorEntries[0].wouldRun, false);
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.anchorEntries[0].wouldWrite, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.state, 'blocked');
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.attemptAuditReady, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].wouldWriteAudit, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].wouldRun, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].wouldWrite, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.state, 'blocked');
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.operatorRecoveryReady, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRecover, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRetry, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRun, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldWrite, false);
  assert.strictEqual(report.runnerWiringContract.runnerRegistryReadiness.command, 'supervisor-lifecycle-guarded-runner-registry-readiness');
  assert.strictEqual(report.runnerWiringContract.runnerRegistryReadiness.state, 'blocked');
  assert.strictEqual(report.runnerWiringContract.runnerRegistryReadiness.runnerRegistryReady, false);
  assert.strictEqual(report.runnerWiringContract.runnerRegistryReadiness.realRunnerImplementationsReady, false);
  assert.deepStrictEqual(report.runnerWiringContract.runnerRegistryReadiness.registryEntries, [
    {
      runnerKind: 'guarded-runner-stub',
      state: 'blocked',
      realImplementationReady: false,
      supportsHostMutation: false,
      wouldExecute: false,
      wouldRun: false,
      wouldWrite: false,
      blockerCode: 'runner-registry-real-implementation-missing',
    },
  ]);
  assert.deepStrictEqual(
    report.runnerWiringContract.requiredContracts.map((entry) => entry.id),
    ['execution-policy', 'runner-registry', 'host-mutation-adapter', 'rollback-anchor', 'attempt-audit', 'operator-recovery'],
  );
  assert.strictEqual(report.runnerWiringContract.requiredContracts[0].status, 'ready');
  assert.ok(report.runnerWiringContract.requiredContracts.slice(1).every((entry) =>
    entry.status === 'blocked' && entry.requiredForExecution === true));
  assert.strictEqual(report.actionCandidates.length, 3);
  assert.ok(report.actionCandidates.every((entry) =>
    entry.status === 'blocked' &&
      entry.wouldExecute === false &&
      entry.wouldRun === false &&
      entry.wouldWrite === false));
  assert.strictEqual(report.safety.readOnly, true);
  assert.strictEqual(report.safety.dryRun, true);
  assert.strictEqual(report.safety.lifecycleApplied, false);
  assert.strictEqual(report.safety.filesystemWritten, false);
  assert.strictEqual(report.safety.launchctlCalled, false);
  assert.strictEqual(report.safety.processListRead, false);
  assert.strictEqual(report.safety.auditEventWritten, false);
  assert.strictEqual(report.safety.metadataWritten, false);
}

describe('agent supervisor-lifecycle-guarded-runner-execution-gate', () => {
  it('prints sanitized blocked execution gate for valid inputs without extra local writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-valid-'));
    try {
      const configPath = await writeTempConfig(dir);
      const { approvalPath, storeDir, persistedRecord } = await persistApproval(dir, configPath);
      const manifestPath = await writeJson(dir, 'executor-manifest.json', validInstallManifest());
      const bindingPath = await writeJson(dir, 'runner-binding.json', validRunnerBinding());

      const { stdout } = await runAgent([
        'supervisor-lifecycle-guarded-runner-execution-gate',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', storeDir,
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
      ]);
      const report = JSON.parse(stdout);

      assertBlockedGate(report);
      assert.ok(report.blockers.includes('execute-request-missing'));
      assert.strictEqual(report.gates.executeRequested, false);
      assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(storeDir), [persistedRecord]);
      assert.deepStrictEqual(await readdir(join(storeDir, 'approvals')), ['supervisor-lifecycle-approvals.jsonl']);
      assertNoSensitiveOutput(stdout, configPath, approvalPath, storeDir, manifestPath, bindingPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts execute-requested as intent only and remains blocked without execution flags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-execute-'));
    try {
      const configPath = await writeTempConfig(dir);
      const { approvalPath, storeDir } = await persistApproval(dir, configPath);
      const manifestPath = await writeJson(dir, 'executor-manifest.json', validInstallManifest());
      const bindingPath = await writeJson(dir, 'runner-binding.json', validRunnerBinding());

      const { stdout } = await runAgent([
        'supervisor-lifecycle-guarded-runner-execution-gate',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', storeDir,
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
        '--execute-requested',
      ]);
      const report = JSON.parse(stdout);

      assertBlockedGate(report);
      assert.ok(!report.blockers.includes('execute-request-missing'));
      assert.deepStrictEqual(report.blockers, ['real-guarded-runner-execution-wiring-missing']);
      assert.strictEqual(report.gates.executeRequested, true);
      assertNoSensitiveOutput(stdout, configPath, approvalPath, storeDir, manifestPath, bindingPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--fail-on-blocked exits 2 after printing parseable blocked JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-fail-'));
    try {
      const configPath = await writeTempConfig(dir);
      const { approvalPath, storeDir } = await persistApproval(dir, configPath);
      const manifestPath = await writeJson(dir, 'executor-manifest.json', validInstallManifest());
      const bindingPath = await writeJson(dir, 'runner-binding.json', validRunnerBinding());

      const error = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-gate',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', storeDir,
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
        '--fail-on-blocked',
      ], 2);
      const report = JSON.parse(error.stdout);

      assertBlockedGate(report);
      assertNoSensitiveOutput(`${error.stdout}${error.stderr}`, configPath, approvalPath, storeDir, manifestPath, bindingPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported write-like inputs and boolean values with sanitized errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-args-'));
    try {
      const configPath = await writeTempConfig(dir);
      const { storeDir } = await persistApproval(dir, configPath);
      const manifestPath = await writeJson(dir, 'executor-manifest.json', validInstallManifest());
      const bindingPath = await writeJson(dir, 'runner-binding.json', validRunnerBinding());
      const baseArgs = [
        'supervisor-lifecycle-guarded-runner-execution-gate',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', storeDir,
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
      ];
      const cases = [
        [['--apply'], /--apply is not supported/],
        [['--approval', join(dir, 'approval.json')], /--approval is not supported/],
        [['--output', join(dir, 'report.json')], /--output is not supported/],
        [['--execute-requested', 'yes'], /--execute-requested does not accept a value/],
        [['--fail-on-blocked', 'yes'], /--fail-on-blocked does not accept a value/],
      ];

      for (const [extraArgs, expectedError] of cases) {
        const error = await runAgentExpectExit([...baseArgs, ...extraArgs], 1);
        assert.match(error.stderr, expectedError);
        assertNoSensitiveOutput(`${error.stdout}${error.stderr}`, configPath, storeDir, manifestPath, bindingPath, dir);
      }

      const dataDirValueError = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-gate',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir',
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
      ], 1);
      assert.match(dataDirValueError.stderr, /--data-dir requires a path value/);
      assertNoSensitiveOutput(`${dataDirValueError.stdout}${dataDirValueError.stderr}`, configPath, manifestPath, bindingPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes config, approval store, manifest, and runner binding failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-errors-'));
    try {
      const badConfigPath = join(dir, 'bad-config.json');
      await writeFile(badConfigPath, '{"token":"SECRET_XYZ"}');
      const storeDir = join(dir, 'store');
      const manifestPath = await writeJson(dir, 'executor-manifest.json', validInstallManifest());
      const bindingPath = await writeJson(dir, 'runner-binding.json', validRunnerBinding());

      const configError = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-gate',
        '--config', badConfigPath,
        '--operation', 'install',
        '--data-dir', storeDir,
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
      ], 1);
      assert.match(configError.stderr, /supervisor-lifecycle-guarded-runner-execution-gate failed; verify --config points to a readable valid Linke config/);
      assertNoSensitiveOutput(`${configError.stdout}${configError.stderr}`, badConfigPath, storeDir, manifestPath, bindingPath, dir);

      const configPath = await writeTempConfig(dir);
      const storeFilePath = join(dir, 'store-file');
      await writeFile(storeFilePath, 'not a directory');
      const storeError = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-gate',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', storeFilePath,
        '--manifest', manifestPath,
        '--runner-binding', bindingPath,
      ], 1);
      assert.match(storeError.stderr, /failed to read supervisor lifecycle approval records/);
      assertNoSensitiveOutput(`${storeError.stdout}${storeError.stderr}`, configPath, storeFilePath, manifestPath, bindingPath, dir);

      const badManifestPath = join(dir, 'bad-executor-manifest.json');
      await writeFile(badManifestPath, '{"token":"SECRET_XYZ"');
      const manifestError = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-gate',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', storeDir,
        '--manifest', badManifestPath,
        '--runner-binding', bindingPath,
      ], 1);
      assert.match(manifestError.stderr, /supervisor-lifecycle-guarded-runner-execution-gate failed; verify --manifest points to a readable valid executor manifest JSON/);
      assertNoSensitiveOutput(`${manifestError.stdout}${manifestError.stderr}`, configPath, storeDir, badManifestPath, bindingPath, dir);

      const badBindingPath = join(dir, 'bad-runner-binding.json');
      await writeFile(badBindingPath, '{"token":"SECRET_XYZ"');
      const bindingError = await runAgentExpectExit([
        'supervisor-lifecycle-guarded-runner-execution-gate',
        '--config', configPath,
        '--operation', 'install',
        '--data-dir', storeDir,
        '--manifest', manifestPath,
        '--runner-binding', badBindingPath,
      ], 1);
      assert.match(bindingError.stderr, /supervisor-lifecycle-guarded-runner-execution-gate failed; verify --runner-binding points to a readable valid guarded runner binding JSON/);
      assertNoSensitiveOutput(`${bindingError.stdout}${bindingError.stderr}`, configPath, storeDir, manifestPath, badBindingPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('help documents supervisor lifecycle guarded runner execution gate automation', async () => {
    const { stdout } = await runAgent(['--help']);
    assert.match(stdout, /supervisor-lifecycle-guarded-runner-execution-gate/);
    assert.match(stdout, /--data-dir <path>/);
    assert.match(stdout, /--manifest <path>/);
    assert.match(stdout, /--runner-binding <path>/);
    assert.match(stdout, /--execute-requested/);
    assert.match(stdout, /--fail-on-blocked/);
  });
});
