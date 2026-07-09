import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleApplyReadiness,
  buildSupervisorLifecycleApprovalPersistencePreview,
  buildSupervisorLifecycleGuardedRunnerExecutionGate,
  buildSupervisorLifecycleGuardedRunnerExecutionPreview,
  buildSupervisorLifecycleGuardedRunnerRegistryReadiness,
  buildSupervisorLifecycleGuardedRunnerReadiness,
  buildSupervisorLifecycleGuardedRunnerWiringContract,
  validateSupervisorLifecycleExecutorManifest,
} from '../src/supervisor-lifecycle.js';
import { buildSupervisorLifecycleApprovalRecord } from '../src/approval-store.js';

const NOW = new Date('2026-07-09T08:00:00.000Z');
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'gate-macbook-alpha',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});
const EXPECTED_EXECUTION_PREVIEW_SAFETY = Object.freeze({
  dryRun: true,
  hostMutation: false,
  launchctlCalled: false,
  filesystemWritten: false,
  metadataWritten: false,
  rollbackAnchorWritten: false,
  auditEventWritten: false,
  approvalPersisted: false,
  sensitiveValuesReturned: false,
  readOnly: true,
  processListRead: false,
  lifecycleApplied: false,
  nasConnected: false,
  backupTriggered: false,
  restoreTriggered: false,
  remoteCommandExecuted: false,
});
const EXPECTED_WIRING_CONTRACTS = Object.freeze([
  ['runner-registry', 'runner-registry-missing'],
  ['host-mutation-adapter', 'host-mutation-adapter-missing'],
  ['rollback-anchor', 'rollback-anchor-missing'],
  ['attempt-audit', 'attempt-audit-missing'],
  ['operator-recovery', 'operator-recovery-missing'],
]);
const EXPECTED_RUNNER_REGISTRY_ENTRIES = Object.freeze([
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

function validApprovalFor(plan) {
  return {
    operation: plan.operation,
    configHash: plan.configHash,
    planHash: plan.planHash,
    approved: true,
    schemaVersion: 1,
    approvedBy: 'gate-operator@example.invalid',
    reason: 'gate approval reason must not leak',
    acknowledgements: ['gate acknowledgement must not leak'],
    approvedAt: '2026-07-09T07:45:00.000Z',
    expiresAt: '2026-07-09T08:45:00.000Z',
  };
}

function getInstallPlan() {
  const dryRunPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });
  const approval = validApprovalFor(dryRunPlan);
  return buildSupervisorLifecycleApplyPlan(BASE_CONFIG, {
    operation: 'install',
    apply: true,
    envGateEnabled: true,
    approval,
    now: NOW,
  });
}

function getPersistedApprovalRecordFor(plan) {
  const approval = validApprovalFor(plan);
  const preview = buildSupervisorLifecycleApprovalPersistencePreview(plan, approval, { now: NOW });
  const record = buildSupervisorLifecycleApprovalRecord(preview, approval, {
    id: `${plan.operation}-gate-approval-record`,
    now: NOW,
  });
  return {
    ...record,
    state: 'persisted',
    safety: {
      ...record.safety,
      approvalPersisted: true,
      filesystemWritten: true,
    },
  };
}

function getValidManifest() {
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

function getValidRunnerBinding() {
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

function getReadyInputs() {
  const plan = getInstallPlan();
  const applyReadiness = buildSupervisorLifecycleApplyReadiness(plan, [
    getPersistedApprovalRecordFor(plan),
  ]);
  const manifestReadiness = validateSupervisorLifecycleExecutorManifest(plan, getValidManifest());
  const guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
    manifestReadiness,
    getValidRunnerBinding(),
  );
  const executionPreview = buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, guardedRunnerReadiness);

  return {
    plan,
    applyReadiness,
    manifestReadiness,
    guardedRunnerReadiness,
    executionPreview,
  };
}

function buildGate(inputs = getReadyInputs(), options = {}) {
  return buildSupervisorLifecycleGuardedRunnerExecutionGate(
    inputs.plan,
    inputs.applyReadiness,
    inputs.manifestReadiness,
    inputs.guardedRunnerReadiness,
    inputs.executionPreview,
    options,
  );
}

function assertAlwaysBlockedGate(result) {
  assert.strictEqual(result.command, 'supervisor-lifecycle-guarded-runner-execution-gate');
  assert.strictEqual(result.operation, 'install');
  assert.strictEqual(result.state, 'blocked');
  assert.strictEqual(result.executionGateState, 'blocked');
  assert.strictEqual(result.executionEligible, false);
  assert.strictEqual(result.executorReady, false);
  assert.strictEqual(result.wouldExecute, false);
  assert.ok(result.blockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.deepStrictEqual(result.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.strictEqual(result.gates.realRunnerWiringReady, false);
  assert.strictEqual(result.gates.runnerWiringContractReady, false);
  assert.strictEqual(result.gates.runnerRegistryReady, false);
  assert.strictEqual(result.realRunnerWiringReady, false);
  assert.strictEqual(result.safety.readOnly, true);
  assert.strictEqual(result.safety.dryRun, true);
  assert.strictEqual(result.safety.hostMutation, false);
  assert.strictEqual(result.safety.launchctlCalled, false);
  assert.strictEqual(result.safety.processListRead, false);
  assert.strictEqual(result.safety.filesystemWritten, false);
  assert.strictEqual(result.safety.metadataWritten, false);
  assert.strictEqual(result.safety.rollbackAnchorWritten, false);
  assert.strictEqual(result.safety.auditEventWritten, false);
  assert.strictEqual(result.safety.approvalPersisted, false);
  assert.strictEqual(result.safety.lifecycleApplied, false);
  assert.strictEqual(result.safety.nasConnected, false);
  assert.strictEqual(result.safety.backupTriggered, false);
  assert.strictEqual(result.safety.restoreTriggered, false);
  assert.strictEqual(result.safety.remoteCommandExecuted, false);
  assert.strictEqual(result.safety.sensitiveValuesReturned, false);
}

function assertBlockedWiringContract(contract) {
  assert.strictEqual(contract.command, 'supervisor-lifecycle-guarded-runner-wiring-contract');
  assert.strictEqual(contract.state, 'blocked');
  assert.strictEqual(contract.realRunnerWiringReady, false);
  assert.strictEqual(contract.readyCount, 0);
  assert.strictEqual(contract.blockedCount, EXPECTED_WIRING_CONTRACTS.length);
  assert.deepStrictEqual(contract.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.ok(contract.blockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.deepStrictEqual(contract.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  assert.strictEqual(contract.requiredContracts.length, EXPECTED_WIRING_CONTRACTS.length);
  assert.deepStrictEqual(
    contract.requiredContracts.map((entry) => [entry.id, entry.blockerCode]),
    EXPECTED_WIRING_CONTRACTS,
  );
  assert.deepStrictEqual(contract.runnerRegistryReadiness, buildSupervisorLifecycleGuardedRunnerRegistryReadiness());
  assert.ok(contract.requiredContracts.every((entry) =>
    entry.status === 'blocked' &&
      entry.requiredForExecution === true &&
      typeof entry.evidence === 'string' &&
      entry.evidence.length > 0));
}

describe('buildSupervisorLifecycleGuardedRunnerRegistryReadiness', () => {
  it('returns fixed blocked disabled runner registry readiness evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerRegistryReadiness();

    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-registry-readiness');
    assert.strictEqual(readiness.state, 'blocked');
    assert.strictEqual(readiness.runnerRegistryDefined, true);
    assert.strictEqual(readiness.runnerRegistryReady, false);
    assert.strictEqual(readiness.realRunnerImplementationsReady, false);
    assert.strictEqual(readiness.readyCount, 0);
    assert.strictEqual(readiness.blockedCount, 1);
    assert.ok(readiness.blockers.includes('runner-registry-real-implementation-missing'));
    assert.ok(readiness.blockers.includes('real-guarded-runner-execution-wiring-missing'));
    assert.deepStrictEqual(readiness.nextBlockers, ['runner-registry-real-implementation-missing']);
    assert.deepStrictEqual(readiness.registryEntries, EXPECTED_RUNNER_REGISTRY_ENTRIES);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });

  it('ignores all runtime-looking inputs and never leaks malicious registry material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerRegistryReadiness();
    const maliciousInput = {
      runnerRegistryReady: true,
      registryEntries: [
        {
          runnerKind: 'node /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
          command: 'launchctl load /Users/ah/Library/LaunchAgents/linke.plist',
          wouldExecute: true,
          wouldRun: true,
          wouldWrite: true,
        },
      ],
      config: { token: 'SECRET_XYZ' },
      approval: { approvedBy: 'operator@example.invalid', reason: 'do not leak' },
      hash: 'sha256:abc',
      path: '/Users/ah/private',
    };

    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRegistryReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRegistryReadiness(null), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRegistryReadiness(), baseline);
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /\/Users\/ah|SECRET_XYZ|operator@example|do not leak|sha256:|launchctl load|node /i,
    );
  });
});

describe('buildSupervisorLifecycleGuardedRunnerWiringContract', () => {
  it('returns the fixed blocked real runner wiring contract with complete safety evidence', () => {
    const contract = buildSupervisorLifecycleGuardedRunnerWiringContract(getReadyInputs().executionPreview);

    assertBlockedWiringContract(contract);
  });

  it('ignores execution preview input completely and never leaks malicious fields', () => {
    const normalPreview = getReadyInputs().executionPreview;
    const baseline = buildSupervisorLifecycleGuardedRunnerWiringContract();
    const samples = [
      undefined,
      null,
      normalPreview,
      { ...normalPreview, wouldExecute: true },
      {
        command: 'launchctl load /Users/ah/Library/LaunchAgents/linke.plist',
        path: '/Users/ah/secret-path',
        token: 'SECRET_XYZ',
        secret: 'sk-abc123def456',
        hostname: 'unsafe.example',
        hash: 'sha256:abc',
        approval: {
          approvedBy: 'operator@example.invalid',
          reason: 'do not leak',
          acknowledgements: ['do not leak acknowledgement'],
        },
      },
    ];

    for (const sample of samples) {
      assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerWiringContract(sample), baseline);
    }
    const serialized = JSON.stringify(baseline);
    assert.doesNotMatch(serialized, /\/Users\/ah|SECRET_XYZ|sk-abc|unsafe\.example|sha256:|operator@example|do not leak|launchctl load/i);
  });
});

describe('buildSupervisorLifecycleGuardedRunnerExecutionGate', () => {
  it('keeps ready inputs blocked when executeRequested is false', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: false });

    assertAlwaysBlockedGate(result);
    assert.ok(result.blockers.includes('execute-request-missing'));
    assert.deepStrictEqual(result.gates, {
      lifecyclePlanValid: true,
      approvalRecordReady: true,
      manifestReady: true,
      runnerBindingsReady: true,
      executionPreviewVerified: true,
      executeRequested: false,
      runnerRegistryReady: false,
      realRunnerWiringReady: false,
      runnerWiringContractReady: false,
    });
    assertBlockedWiringContract(result.runnerWiringContract);
    assert.deepStrictEqual(result.actionCandidates, [
      {
        actionId: 'render-launch-agent-plist',
        implementationId: 'render-plist-impl',
        runnerKind: 'guarded-runner-stub',
        mode: 'guarded-host-action',
        status: 'blocked',
        wouldExecute: false,
        wouldRun: false,
        wouldWrite: false,
        maxAttempts: 2,
      },
      {
        actionId: 'write-launch-agent-plist',
        implementationId: 'write-plist-impl',
        runnerKind: 'guarded-runner-stub',
        mode: 'guarded-host-action',
        status: 'blocked',
        wouldExecute: false,
        wouldRun: false,
        wouldWrite: false,
        maxAttempts: 1,
      },
      {
        actionId: 'load-launch-agent',
        implementationId: 'load-agent-impl',
        runnerKind: 'guarded-runner-stub',
        mode: 'guarded-host-action',
        status: 'blocked',
        wouldExecute: false,
        wouldRun: false,
        wouldWrite: false,
        maxAttempts: 3,
      },
    ]);
  });

  it('honors executeRequested gate but remains blocked without real runner wiring', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });

    assertAlwaysBlockedGate(result);
    assert.ok(!result.blockers.includes('execute-request-missing'));
    assert.deepStrictEqual(result.blockers, ['real-guarded-runner-execution-wiring-missing']);
    assert.strictEqual(result.gates.executeRequested, true);
    assert.strictEqual(result.gates.runnerRegistryReady, false);
    assert.strictEqual(result.gates.realRunnerWiringReady, false);
    assert.strictEqual(result.gates.runnerWiringContractReady, false);
    assertBlockedWiringContract(result.runnerWiringContract);
    assert.ok(result.actionCandidates.every((entry) =>
      entry.status === 'blocked' &&
        entry.wouldExecute === false &&
        entry.wouldRun === false &&
        entry.wouldWrite === false));
  });

  it('blocks approval readiness that is not ready without leaking approval material', () => {
    const inputs = getReadyInputs();
    inputs.applyReadiness = {
      ...inputs.applyReadiness,
      approvalRecordReady: false,
      approvalRecordState: 'blocked',
      blockers: ['approval-record-validation-incomplete', 'sha256:abc', '/Users/ah/approval.json'],
      approvalRecords: {
        readOnly: true,
        approvedBy: 'gate-operator@example.invalid',
        reason: 'gate approval reason must not leak',
        url: 'http://localhost:3000/approval?token=secret',
      },
    };

    const result = buildGate(inputs, { executeRequested: true });
    const serialized = JSON.stringify(result);

    assertAlwaysBlockedGate(result);
    assert.ok(result.blockers.includes('approval-record-gate-not-ready'));
    assert.doesNotMatch(serialized, /gate-operator|approval reason|acknowledgement|sha256:|\/Users\/ah|localhost|token|secret/i);
  });

  it('uses stable blockers for invalid or mismatched manifest, runner, and preview inputs', () => {
    const invalidManifest = {
      ...getReadyInputs(),
      manifestReadiness: null,
    };
    const invalidManifestResult = buildGate(invalidManifest, { executeRequested: true });

    assertAlwaysBlockedGate(invalidManifestResult);
    assert.ok(invalidManifestResult.blockers.includes('executor-manifest-readiness-invalid'));
    assert.strictEqual(invalidManifestResult.gates.manifestReady, false);

    const runnerNotReady = getReadyInputs();
    runnerNotReady.guardedRunnerReadiness = {
      ...runnerNotReady.guardedRunnerReadiness,
      runnerBindingsReady: false,
      runnerBindingState: 'blocked',
      blockers: ['guarded-runner-binding-missing-for-action:load-launch-agent'],
    };
    const runnerResult = buildGate(runnerNotReady, { executeRequested: true });

    assertAlwaysBlockedGate(runnerResult);
    assert.ok(runnerResult.blockers.includes('guarded-runner-readiness-not-ready'));
    assert.strictEqual(runnerResult.gates.runnerBindingsReady, false);

    const previewMismatch = getReadyInputs();
    previewMismatch.executionPreview = {
      ...previewMismatch.executionPreview,
      operation: 'rollback',
    };
    const previewResult = buildGate(previewMismatch, { executeRequested: true });

    assertAlwaysBlockedGate(previewResult);
    assert.ok(previewResult.blockers.includes('execution-preview-operation-mismatch'));
    assert.strictEqual(previewResult.gates.executionPreviewVerified, false);

    const invalidPreview = buildGate({ ...getReadyInputs(), executionPreview: null }, { executeRequested: true });

    assertAlwaysBlockedGate(invalidPreview);
    assert.ok(invalidPreview.blockers.includes('execution-preview-invalid'));
    assert.strictEqual(invalidPreview.gates.executionPreviewVerified, false);

    const notVerifiedInputs = getReadyInputs();
    notVerifiedInputs.executionPreview = {
      ...notVerifiedInputs.executionPreview,
      actionPreviews: notVerifiedInputs.executionPreview.actionPreviews.map((entry, index) => (
        index === 0 ? { ...entry, wouldExecute: true } : entry
      )),
    };
    const notVerifiedResult = buildGate(notVerifiedInputs, { executeRequested: true });

    assertAlwaysBlockedGate(notVerifiedResult);
    assert.ok(notVerifiedResult.blockers.includes('execution-preview-not-verified'));
    assert.strictEqual(notVerifiedResult.gates.executionPreviewVerified, false);
    assert.deepStrictEqual(notVerifiedResult.actionCandidates, []);
  });

  it('redacts unsafe metadata from action candidates', () => {
    const inputs = getReadyInputs();
    inputs.executionPreview = {
      ...inputs.executionPreview,
      actionPreviews: [
        {
          actionId: 'render-launch-agent-plist',
          implementationId: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          runnerKind: 'launchctl curl http://localhost:3000?token=secret sk-abc ghp_ab xoxb-abc',
          mode: '/Users/ah/.ssh/id_rsa Authorization: Bearer secret',
          status: 'blocked',
          wouldExecute: false,
          wouldRun: false,
          wouldWrite: false,
          maxAttempts: 99,
        },
      ],
    };

    const result = buildGate(inputs, { executeRequested: true });
    const serialized = JSON.stringify(result.actionCandidates);

    assertAlwaysBlockedGate(result);
    assert.deepStrictEqual(result.actionCandidates, [
      {
        actionId: 'render-launch-agent-plist',
        implementationId: '[redacted]',
        runnerKind: '[redacted]',
        mode: '[redacted]',
        status: 'blocked',
        wouldExecute: false,
        wouldRun: false,
        wouldWrite: false,
        maxAttempts: '[redacted]',
      },
    ]);
    assert.doesNotMatch(serialized, /\/Users\/ah|localhost|token|secret|launchctl|curl|sk-abc|ghp_ab|xoxb-abc|Authorization|sha256:/i);
  });
});
