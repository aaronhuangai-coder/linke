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

const EXPECTED_RUNNER_REGISTRY_ENTRIES = Object.freeze([
  {
    registryKind: 'code-owned-runner-registry',
    runnerKind: 'guarded-runner-stub',
    state: 'ready',
    codeOwnedResolverWired: true,
    realHostRunnerReady: false,
    realImplementationReady: false,
    supportsHostMutation: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    blockerCode: null,
    evidenceCode: 'runner-registry-ready',
  },
]);

const EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES = Object.freeze([
  {
    adapterKind: 'code-owned-host-mutation-adapter',
    state: 'ready',
    codeOwnedResolverWired: true,
    realHostMutationImplementationReady: false,
    realImplementationReady: false,
    wouldMutateHost: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    launchctlAllowed: false,
    filesystemWriteAllowed: false,
    processListReadAllowed: false,
    metadataWriteAllowed: false,
    auditWriteAllowed: false,
    rollbackAnchorWriteAllowed: false,
    blockerCode: null,
    evidenceCode: 'host-mutation-adapter-ready',
  },
]);

const EXPECTED_ROLLBACK_ANCHOR_ENTRIES = Object.freeze([
  {
    anchorKind: 'code-owned-rollback-anchor',
    state: 'ready',
    codeOwnedResolverWired: true,
    realRollbackAnchorImplementationReady: false,
    wouldWriteAnchor: false,
    wouldRestore: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    filesystemWriteAllowed: false,
    metadataWriteAllowed: false,
    rollbackAnchorWriteAllowed: false,
    rollbackRestoreAllowed: false,
    blockerCode: null,
    evidenceCode: 'rollback-anchor-ready',
  },
]);

function assertBlockedGate(report, { runnerRegistryReady, hostMutationAdapterReady, rollbackAnchorReady, attemptAuditReady, operatorRecoveryReady }) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');
  assert.strictEqual(typeof hostMutationAdapterReady, 'boolean');
  assert.strictEqual(typeof rollbackAnchorReady, 'boolean');
  assert.strictEqual(typeof attemptAuditReady, 'boolean');
  assert.strictEqual(typeof operatorRecoveryReady, 'boolean');

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
  assert.strictEqual(report.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(report.gates.hostMutationAdapterReady, hostMutationAdapterReady);
  assert.strictEqual(report.gates.rollbackAnchorReady, rollbackAnchorReady);
  assert.strictEqual(report.gates.attemptAuditReady, attemptAuditReady);
  assert.strictEqual(report.gates.operatorRecoveryReady, operatorRecoveryReady);
  assert.strictEqual(typeof report.gates.pureWiringOrchestratorPlanReady, 'boolean');
  assert.strictEqual(report.realRunnerWiringReady, false);
  assert.deepStrictEqual(report.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.ok(report.blockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.ok(report.wiringPlan && typeof report.wiringPlan === 'object');
  assert.ok(report.wiringPlan.state === 'planned' || report.wiringPlan.state === 'unplanned');
  assert.strictEqual(report.wiringPlan.realRunnerWiringReady, false);
  assert.strictEqual(report.wiringPlan.runnerWiringContractReady, false);
  assert.strictEqual(report.wiringPlan.executionEligible, false);
  assert.ok(report.wiringPlanSeal && typeof report.wiringPlanSeal === 'object');
  assert.ok(report.wiringPlanSeal.state === 'seal-ready' || report.wiringPlanSeal.state === 'seal-blocked');
  assert.strictEqual(report.wiringPlanSeal.realRunnerWiringReady, false);
  assert.strictEqual(report.wiringPlanSeal.wouldPersistAudit, false);
  assert.strictEqual(report.runnerWiringContract.command, 'supervisor-lifecycle-guarded-runner-wiring-contract');
  assert.strictEqual(report.runnerWiringContract.state, 'blocked');
  assert.strictEqual(report.runnerWiringContract.realRunnerWiringReady, false);
  assert.strictEqual(report.runnerWiringContract.readyCount, 6);
  assert.strictEqual(report.runnerWiringContract.blockedCount, 0);
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
  assert.strictEqual(report.runnerWiringContract.requiredContracts[1].id, 'runner-registry');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[1].status, 'ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[1].blockerCode, null);
  assert.strictEqual(report.runnerWiringContract.requiredContracts[1].evidenceCode, 'runner-registry-ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[2].id, 'host-mutation-adapter');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[2].status, 'ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[2].blockerCode, null);
  assert.strictEqual(report.runnerWiringContract.requiredContracts[2].evidenceCode, 'host-mutation-adapter-ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[3].id, 'rollback-anchor');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[3].status, 'ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[3].blockerCode, null);
  assert.strictEqual(report.runnerWiringContract.requiredContracts[3].evidenceCode, 'rollback-anchor-ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[4].id, 'attempt-audit');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[4].status, 'ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[4].blockerCode, null);
  assert.strictEqual(report.runnerWiringContract.requiredContracts[4].evidenceCode, 'attempt-audit-ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[5].id, 'operator-recovery');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[5].status, 'ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[5].blockerCode, null);
  assert.strictEqual(report.runnerWiringContract.requiredContracts[5].evidenceCode, 'operator-recovery-ready');
  assert.ok(report.runnerWiringContract.requiredContracts.every((entry) =>
    entry.status === 'ready' && entry.requiredForExecution === true));
  assert.strictEqual(report.policyDecision.wouldRun, false);
  assert.strictEqual(report.policyDecision.wouldWrite, false);
  assert.ok(report.recoveryDecision && typeof report.recoveryDecision === 'object');
  assert.strictEqual(report.recoveryDecision.codeOwnedResolverWired, true);
  assert.strictEqual(report.recoveryDecision.realOperatorRecoveryImplementationReady, false);
  assert.strictEqual(report.recoveryDecision.wouldRecover, false);
  assert.strictEqual(report.recoveryDecision.wouldRestartService, false);
  assert.strictEqual(report.recoveryDecision.wouldRestoreState, false);
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.state, 'ready');
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.hostMutationAdapterReady, true);
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.codeOwnedAdapterResolverReady, true);
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.realHostMutationImplementationReady, false);
  assert.deepStrictEqual(
    report.runnerWiringContract.hostMutationAdapterReadiness.adapterEntries,
    EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES,
  );
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.adapterEntries[0].wouldMutateHost, false);
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.adapterEntries[0].wouldRun, false);
  assert.strictEqual(report.runnerWiringContract.hostMutationAdapterReadiness.adapterEntries[0].wouldWrite, false);
  if (report.adapterDecision) {
    assert.strictEqual(report.adapterDecision.wouldMutateHost, false);
    assert.strictEqual(report.adapterDecision.wouldExecute, false);
    assert.strictEqual(report.adapterDecision.wouldRun, false);
    assert.strictEqual(report.adapterDecision.wouldWrite, false);
    assert.strictEqual(report.adapterDecision.launchctlAllowed, false);
    assert.strictEqual(report.adapterDecision.filesystemWriteAllowed, false);
    assert.strictEqual(report.adapterDecision.processListReadAllowed, false);
    assert.strictEqual(report.adapterDecision.metadataWriteAllowed, false);
    assert.strictEqual(report.adapterDecision.auditWriteAllowed, false);
    assert.strictEqual(report.adapterDecision.rollbackAnchorWriteAllowed, false);
    assert.strictEqual(report.adapterDecision.realHostMutationImplementationReady, false);
  }
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.state, 'ready');
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.rollbackAnchorReady, true);
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.codeOwnedAnchorResolverReady, true);
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.realRollbackAnchorImplementationReady, false);
  assert.deepStrictEqual(
    report.runnerWiringContract.rollbackAnchorReadiness.anchorEntries,
    EXPECTED_ROLLBACK_ANCHOR_ENTRIES,
  );
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.anchorEntries[0].wouldWriteAnchor, false);
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.anchorEntries[0].wouldRestore, false);
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.anchorEntries[0].wouldRun, false);
  assert.strictEqual(report.runnerWiringContract.rollbackAnchorReadiness.anchorEntries[0].wouldWrite, false);
  assert.ok(report.anchorDecision && typeof report.anchorDecision === 'object');
  assert.strictEqual(report.anchorDecision.codeOwnedResolverWired, true);
  assert.strictEqual(report.anchorDecision.realRollbackAnchorImplementationReady, false);
  assert.strictEqual(report.anchorDecision.wouldWriteAnchor, false);
  assert.strictEqual(report.anchorDecision.wouldRestore, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.state, 'ready');
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.attemptAuditReady, true);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.codeOwnedAuditResolverReady, true);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.realAttemptAuditImplementationReady, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].auditKind, 'code-owned-attempt-audit');
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].state, 'ready');
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].codeOwnedResolverWired, true);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].realAttemptAuditImplementationReady, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].wouldPersistAudit, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].wouldWriteLog, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].wouldWriteAudit, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].wouldRun, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].wouldWrite, false);
  assert.strictEqual(report.runnerWiringContract.attemptAuditReadiness.auditEntries[0].immutableAuditReady, false);
  assert.ok(report.auditDecision && typeof report.auditDecision === 'object');
  assert.strictEqual(report.auditDecision.codeOwnedResolverWired, true);
  assert.strictEqual(report.auditDecision.realAttemptAuditImplementationReady, false);
  assert.strictEqual(report.auditDecision.wouldPersistAudit, false);
  assert.strictEqual(report.auditDecision.wouldWriteLog, false);
  assert.strictEqual(report.auditDecision.wouldWriteAudit, false);
  assert.strictEqual(report.auditDecision.immutableAuditReady, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.state, 'ready');
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.operatorRecoveryReady, true);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.codeOwnedRecoveryResolverReady, true);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.realOperatorRecoveryImplementationReady, false);
  assert.strictEqual(Object.hasOwn(report.runnerWiringContract.operatorRecoveryReadiness, 'realOperatorRecoveryReady'), false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].recoveryKind, 'code-owned-operator-recovery');
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].state, 'ready');
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].codeOwnedResolverWired, true);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].realOperatorRecoveryImplementationReady, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRecover, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRetry, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRestartService, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRestoreState, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRun, false);
  assert.strictEqual(report.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldWrite, false);
  const readiness = report.runnerWiringContract.runnerRegistryReadiness;
  assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-registry-readiness');
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.runnerRegistryReady, true);
  assert.strictEqual(readiness.codeOwnedRegistryResolverReady, true);
  assert.strictEqual(readiness.realRunnerImplementationsReady, false);
  assert.deepStrictEqual(readiness.registryEntries, EXPECTED_RUNNER_REGISTRY_ENTRIES);
  assert.deepStrictEqual(
    report.runnerWiringContract.requiredContracts.map((entry) => entry.id),
    ['execution-policy', 'runner-registry', 'host-mutation-adapter', 'rollback-anchor', 'attempt-audit', 'operator-recovery'],
  );
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

      assertBlockedGate(report, { runnerRegistryReady: true, hostMutationAdapterReady: true, rollbackAnchorReady: true, attemptAuditReady: true, operatorRecoveryReady: true });
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

      assertBlockedGate(report, { runnerRegistryReady: true, hostMutationAdapterReady: true, rollbackAnchorReady: true, attemptAuditReady: true, operatorRecoveryReady: true });
      assert.ok(!report.blockers.includes('execute-request-missing'));
      assert.deepStrictEqual(report.blockers, ['real-guarded-runner-execution-wiring-missing']);
      assert.strictEqual(report.gates.executeRequested, true);
      assert.strictEqual(report.registryDecision.state, 'resolved');
      assert.strictEqual(report.registryDecision.registryReady, true);
      assert.strictEqual(report.policyDecision.state, 'authorized');
      assert.strictEqual(report.policyDecision.authorized, true);
      assert.strictEqual(report.policyDecision.primaryBlocker, null);
      assert.deepStrictEqual(report.policyDecision.blockers, []);
      assert.ok(!report.policyDecision.blockers.includes('operator-recovery-not-ready'));
      assert.ok(!report.policyDecision.blockers.includes('host-mutation-adapter-not-ready'));
      assert.strictEqual(report.recoveryDecision.state, 'resolved');
      assert.strictEqual(report.recoveryDecision.recoveryReady, true);
      assert.strictEqual(report.adapterDecision.state, 'resolved');
      assert.strictEqual(report.adapterDecision.adapterReady, true);
      assert.strictEqual(report.executionEligible, false);
      assert.strictEqual(report.wouldExecute, false);
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

      assertBlockedGate(report, { runnerRegistryReady: true, hostMutationAdapterReady: true, rollbackAnchorReady: true, attemptAuditReady: true, operatorRecoveryReady: true });
      assert.ok(report.blockers.includes('execute-request-missing'));
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
