import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  areSupervisorLifecycleGuardedRunnerActionCandidatesReady,
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleApplyReadiness,
  buildSupervisorLifecycleApprovalPersistencePreview,
  buildSupervisorLifecycleGuardedRunnerExecutionGate,
  buildSupervisorLifecycleGuardedRunnerExecutionPreview,
  buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness,
  buildSupervisorLifecycleGuardedRunnerRegistryReadiness,
  buildSupervisorLifecycleGuardedRunnerReadiness,
  buildSupervisorLifecycleGuardedRunnerWiringContract,
  buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness,
  buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness,
  buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness,
  buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness,
  evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy,
  resolveSupervisorLifecycleGuardedRunnerRegistry,
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
  ['execution-policy', null, 'ready', 'execution-policy-ready'],
  ['runner-registry', null, 'ready', 'runner-registry-ready'],
  ['host-mutation-adapter', 'host-mutation-adapter-missing', 'blocked', 'host-mutation-adapter-missing'],
  ['rollback-anchor', 'rollback-anchor-missing', 'blocked', 'rollback-anchor-missing'],
  ['attempt-audit', 'attempt-audit-missing', 'blocked', 'attempt-audit-missing'],
  ['operator-recovery', 'operator-recovery-missing', 'blocked', 'operator-recovery-missing'],
]);
const EXPECTED_EXECUTION_POLICY_ENTRIES = Object.freeze([
  {
    policyKind: 'fail-closed-execution-policy',
    state: 'ready',
    realImplementationReady: true,
    approvalPolicyDefined: true,
    approvalPolicyEnforced: true,
    allowLifecycleApply: false,
    allowHostMutation: false,
    allowLaunchctl: false,
    allowFilesystemWrite: false,
    allowMetadataWrite: false,
    allowAuditWrite: false,
    allowRollbackAnchorWrite: false,
    allowNasConnection: false,
    allowBackupRestore: false,
    allowRemoteCommand: false,
    wouldAuthorizeExecution: false,
    wouldRun: false,
    wouldWrite: false,
    sensitiveValuesReturned: false,
    blockerCode: null,
    evidenceCode: 'execution-policy-ready',
  },
]);
const POLICY_FACT_KEYS = Object.freeze([
  'lifecyclePlanValid',
  'approvalRecordReady',
  'manifestReady',
  'runnerBindingsReady',
  'executionPreviewVerified',
  'executeRequested',
  'actionCandidatesReady',
  'runnerRegistryReady',
  'hostMutationAdapterReady',
  'rollbackAnchorReady',
  'attemptAuditReady',
  'operatorRecoveryReady',
]);
const POLICY_FACT_BLOCKERS = Object.freeze({
  lifecyclePlanValid: 'lifecycle-plan-not-ready',
  approvalRecordReady: 'approval-record-gate-not-ready',
  manifestReady: 'executor-manifest-not-ready',
  runnerBindingsReady: 'guarded-runner-readiness-not-ready',
  executionPreviewVerified: 'execution-preview-not-verified',
  executeRequested: 'execute-request-missing',
  actionCandidatesReady: 'action-candidates-not-ready',
  runnerRegistryReady: 'runner-registry-not-ready',
  hostMutationAdapterReady: 'host-mutation-adapter-not-ready',
  rollbackAnchorReady: 'rollback-anchor-not-ready',
  attemptAuditReady: 'attempt-audit-not-ready',
  operatorRecoveryReady: 'operator-recovery-not-ready',
});
// Opaque synthetic strings only — no path/host/email/hash/command/credential shapes.
const UNSAFE_SECRET_MATERIAL = 'UNSAFE_SECRET_MATERIAL';
const OPAQUE_UNSAFE_FIELD = 'OPAQUE_UNSAFE_FIELD';
const OPERATION_EXPECTED_ACTION_IDS = Object.freeze({
  install: Object.freeze([
    'render-launch-agent-plist',
    'write-launch-agent-plist',
    'load-launch-agent',
  ]),
  uninstall: Object.freeze([
    'unload-launch-agent',
    'remove-launch-agent-plist',
    'remove-supervisor-metadata',
  ]),
  rollback: Object.freeze([
    'capture-current-state',
    'restore-previous-plist',
    'restart-previous-supervisor',
  ]),
  recover: Object.freeze([
    'start-recovery-supervisor',
  ]),
});
const CODE_OWNED_REGISTRY_MAPPINGS = Object.freeze({
  'render-launch-agent-plist': 'render-plist-impl',
  'write-launch-agent-plist': 'write-plist-impl',
  'load-launch-agent': 'load-agent-impl',
  'unload-launch-agent': 'unload-agent-impl',
  'remove-launch-agent-plist': 'remove-plist-impl',
  'remove-supervisor-metadata': 'remove-metadata-impl',
  'capture-current-state': 'capture-state-impl',
  'restore-previous-plist': 'restore-plist-impl',
  'restart-previous-supervisor': 'restart-supervisor-impl',
  'start-recovery-supervisor': 'recovery-supervisor-impl',
});

function buildAllTruePolicyContext(operation = 'install') {
  return {
    operation,
    lifecyclePlanValid: true,
    approvalRecordReady: true,
    manifestReady: true,
    runnerBindingsReady: true,
    executionPreviewVerified: true,
    executeRequested: true,
    actionCandidatesReady: true,
    runnerRegistryReady: true,
    hostMutationAdapterReady: true,
    rollbackAnchorReady: true,
    attemptAuditReady: true,
    operatorRecoveryReady: true,
  };
}

function assertPolicyDecisionInvariants(decision) {
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-execution-policy');
  assert.strictEqual(decision.policyKind, 'fail-closed-execution-policy');
  assert.strictEqual(decision.realImplementationReady, true);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.allowLifecycleApply, false);
  assert.strictEqual(decision.allowHostMutation, false);
  assert.strictEqual(decision.allowLaunchctl, false);
  assert.strictEqual(decision.allowFilesystemWrite, false);
  assert.strictEqual(decision.allowMetadataWrite, false);
  assert.strictEqual(decision.allowAuditWrite, false);
  assert.strictEqual(decision.allowRollbackAnchorWrite, false);
  assert.strictEqual(decision.allowNasConnection, false);
  assert.strictEqual(decision.allowBackupRestore, false);
  assert.strictEqual(decision.allowRemoteCommand, false);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  const authorized = decision.state === 'authorized';
  assert.strictEqual(decision.authorized, authorized);
  assert.strictEqual(decision.wouldAuthorizeExecution, authorized);
  if (authorized) {
    assert.deepStrictEqual(decision.blockers, []);
    assert.strictEqual(decision.primaryBlocker, null);
    assert.deepStrictEqual(decision.nextBlockers, []);
  } else {
    assert.ok(decision.blockers.length >= 1);
    assert.strictEqual(decision.primaryBlocker, decision.blockers[0]);
    assert.deepStrictEqual(decision.nextBlockers, [decision.primaryBlocker]);
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
    adapterKind: 'disabled-host-mutation-adapter-stub',
    state: 'blocked',
    realImplementationReady: false,
    wouldMutateHost: false,
    wouldRun: false,
    wouldWrite: false,
    launchctlAllowed: false,
    filesystemWriteAllowed: false,
    processListReadAllowed: false,
    metadataWriteAllowed: false,
    auditWriteAllowed: false,
    rollbackAnchorWriteAllowed: false,
    blockerCode: 'host-mutation-adapter-real-implementation-missing',
  },
]);
const EXPECTED_ROLLBACK_ANCHOR_ENTRIES = Object.freeze([
  {
    anchorKind: 'disabled-rollback-anchor-stub',
    state: 'blocked',
    realImplementationReady: false,
    wouldWriteAnchor: false,
    wouldRun: false,
    wouldWrite: false,
    filesystemWriteAllowed: false,
    metadataWriteAllowed: false,
    rollbackAnchorWriteAllowed: false,
    rollbackRestoreAllowed: false,
    sensitiveValuesReturned: false,
    blockerCode: 'rollback-anchor-real-implementation-missing',
  },
]);
const EXPECTED_ATTEMPT_AUDIT_ENTRIES = Object.freeze([
  {
    auditKind: 'disabled-attempt-audit-stub',
    state: 'blocked',
    realImplementationReady: false,
    wouldWriteAudit: false,
    wouldRun: false,
    wouldWrite: false,
    auditWriteAllowed: false,
    metadataWriteAllowed: false,
    filesystemWriteAllowed: false,
    immutableAuditReady: false,
    sensitiveValuesReturned: false,
    blockerCode: 'attempt-audit-real-implementation-missing',
  },
]);
const EXPECTED_OPERATOR_RECOVERY_ENTRIES = Object.freeze([
  {
    recoveryKind: 'disabled-operator-recovery-stub',
    state: 'blocked',
    realImplementationReady: false,
    failureRecoveryReady: false,
    retryLimitReady: false,
    operatorRunbookReady: false,
    wouldRecover: false,
    wouldRetry: false,
    wouldNotifyOperator: false,
    wouldRun: false,
    wouldWrite: false,
    metadataWriteAllowed: false,
    filesystemWriteAllowed: false,
    remoteCommandAllowed: false,
    operatorNotificationAllowed: false,
    sensitiveValuesReturned: false,
    blockerCode: 'operator-recovery-real-implementation-missing',
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

function assertAlwaysBlockedGate(result, { runnerRegistryReady = false } = {}) {
  assert.strictEqual(result.command, 'supervisor-lifecycle-guarded-runner-execution-gate');
  assert.strictEqual(result.operation, 'install');
  assert.strictEqual(result.state, 'blocked');
  assert.strictEqual(result.executionGateState, 'blocked');
  assert.strictEqual(result.executionEligible, false);
  assert.strictEqual(result.wouldExecute, false);
  assert.ok(result.blockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.deepStrictEqual(result.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.strictEqual(result.gates.realRunnerWiringReady, false);
  assert.strictEqual(result.gates.runnerWiringContractReady, false);
  assert.strictEqual(result.gates.executionPolicyReady, true);
  assert.strictEqual(result.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(result.gates.hostMutationAdapterReady, false);
  assert.strictEqual(result.gates.rollbackAnchorReady, false);
  assert.strictEqual(result.gates.attemptAuditReady, false);
  assert.strictEqual(result.gates.operatorRecoveryReady, false);
  assert.strictEqual(result.realRunnerWiringReady, false);
  assert.strictEqual(result.executorReady, false);
  assert.ok(result.policyDecision && typeof result.policyDecision === 'object');
  assert.strictEqual(result.policyDecision.state, 'denied');
  assert.strictEqual(result.policyDecision.authorized, false);
  assert.strictEqual(result.policyDecision.wouldAuthorizeExecution, false);
  assert.strictEqual(result.policyDecision.wouldRun, false);
  assert.strictEqual(result.policyDecision.wouldWrite, false);
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

function assertWiringContract(contract) {
  assert.strictEqual(contract.command, 'supervisor-lifecycle-guarded-runner-wiring-contract');
  assert.strictEqual(contract.state, 'blocked');
  assert.strictEqual(contract.realRunnerWiringReady, false);
  // V1.25 aggregate：2 ready / 4 blocked（历史 1/5 已废止）
  assert.strictEqual(contract.readyCount, 2);
  assert.strictEqual(contract.blockedCount, 4);
  assert.deepStrictEqual(contract.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.ok(contract.blockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.deepStrictEqual(contract.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  assert.strictEqual(contract.requiredContracts.length, 6);
  assert.deepStrictEqual(
    contract.requiredContracts.map((entry) => [
      entry.id,
      entry.blockerCode,
      entry.status,
      entry.evidenceCode,
    ]),
    EXPECTED_WIRING_CONTRACTS,
  );
  const policyContract = contract.requiredContracts[0];
  assert.strictEqual(policyContract.id, 'execution-policy');
  assert.strictEqual(policyContract.status, 'ready');
  assert.strictEqual(policyContract.blockerCode, null);
  assert.strictEqual(policyContract.evidenceCode, 'execution-policy-ready');
  const registryContract = contract.requiredContracts[1];
  assert.strictEqual(registryContract.id, 'runner-registry');
  assert.strictEqual(registryContract.status, 'ready');
  assert.strictEqual(registryContract.blockerCode, null);
  assert.strictEqual(registryContract.evidenceCode, 'runner-registry-ready');
  // 后四：仅 slice(2) blocked — 绝不得 slice(1)
  assert.ok(contract.requiredContracts.slice(2).every((entry) =>
    entry.status === 'blocked' &&
      entry.requiredForExecution === true &&
      typeof entry.blockerCode === 'string' &&
      entry.blockerCode.length > 0));
  assert.deepStrictEqual(
    contract.executionPolicyReadiness,
    buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(),
  );
  assert.deepStrictEqual(
    contract.runnerRegistryReadiness,
    buildSupervisorLifecycleGuardedRunnerRegistryReadiness(),
  );
  assert.strictEqual(contract.runnerRegistryReadiness.state, 'ready');
  assert.strictEqual(contract.runnerRegistryReadiness.runnerRegistryReady, true);
  assert.strictEqual(contract.runnerRegistryReadiness.codeOwnedRegistryResolverReady, true);
  assert.strictEqual(contract.runnerRegistryReadiness.realRunnerImplementationsReady, false);
  assert.deepStrictEqual(
    contract.hostMutationAdapterReadiness,
    buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(),
  );
  assert.deepStrictEqual(
    contract.rollbackAnchorReadiness,
    buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(),
  );
  assert.deepStrictEqual(
    contract.attemptAuditReadiness,
    buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness(),
  );
  assert.deepStrictEqual(
    contract.operatorRecoveryReadiness,
    buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(),
  );
}

function validRegistryCandidate(actionId, maxAttempts = 1) {
  return {
    actionId,
    implementationId: CODE_OWNED_REGISTRY_MAPPINGS[actionId],
    runnerKind: 'guarded-runner-stub',
    mode: 'guarded-host-action',
    status: 'blocked',
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    maxAttempts,
  };
}

function validRegistryCandidatesFor(operation) {
  return OPERATION_EXPECTED_ACTION_IDS[operation].map((id) => validRegistryCandidate(id, 1));
}

/**
 * assertUnresolvedExact：第三参 operation 必传，禁止默认 'unknown'。
 */
function assertUnresolvedExact(decision, primaryBlocker, operation) {
  assert.strictEqual(typeof operation, 'string');
  assert.strictEqual(typeof primaryBlocker, 'string');
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-registry');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'unresolved');
  assert.strictEqual(decision.registryReady, false);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realHostRunnerReady, false);
  assert.strictEqual(decision.supportsHostMutation, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.resolvedCount, 0);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.deepStrictEqual(decision.mappings, []);
  assert.deepStrictEqual(decision.blockers, [primaryBlocker]);
  assert.strictEqual(decision.primaryBlocker, primaryBlocker);
  assert.deepStrictEqual(decision.nextBlockers, [primaryBlocker]);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  assert.ok(!Object.values(decision).some((v) => typeof v === 'function'));
}

function assertResolved(decision, operation, inputCandidates) {
  const expected = OPERATION_EXPECTED_ACTION_IDS[operation];
  assert.ok(Array.isArray(inputCandidates));
  assert.strictEqual(inputCandidates.length, expected.length);
  const maxAttemptsByActionId = new Map(
    inputCandidates.map((c) => [c.actionId, c.maxAttempts]),
  );
  for (const actionId of expected) {
    const maxAttempts = maxAttemptsByActionId.get(actionId);
    assert.strictEqual(typeof maxAttempts, 'number');
    assert.ok(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 3);
  }

  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-registry');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'resolved');
  assert.strictEqual(decision.registryReady, true);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realHostRunnerReady, false);
  assert.strictEqual(decision.supportsHostMutation, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.resolvedCount, expected.length);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.strictEqual(decision.mappings.length, expected.length);
  assert.deepStrictEqual(decision.blockers, []);
  assert.strictEqual(decision.primaryBlocker, null);
  assert.deepStrictEqual(decision.nextBlockers, []);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  for (let i = 0; i < expected.length; i++) {
    const actionId = expected[i];
    const row = decision.mappings[i];
    const expectedMaxAttempts = maxAttemptsByActionId.get(actionId);
    assert.strictEqual(row.actionId, actionId);
    assert.strictEqual(row.implementationId, CODE_OWNED_REGISTRY_MAPPINGS[actionId]);
    assert.strictEqual(row.runnerKind, 'guarded-runner-stub');
    assert.strictEqual(row.mode, 'guarded-host-action');
    assert.strictEqual(row.maxAttempts, expectedMaxAttempts);
    assert.strictEqual(typeof row.maxAttempts, 'number');
    assert.ok(Number.isInteger(row.maxAttempts) && row.maxAttempts >= 1 && row.maxAttempts <= 3);
    assert.strictEqual(row.mappingReady, true);
    assert.strictEqual(row.realHostRunnerReady, false);
    assert.strictEqual(row.supportsHostMutation, false);
    assert.strictEqual(row.wouldExecute, false);
    assert.strictEqual(row.wouldRun, false);
    assert.strictEqual(row.wouldWrite, false);
    assert.strictEqual(row.blockerCode, null);
    assert.strictEqual(row.evidenceCode, 'runner-registry-mapping-ready');
    assert.strictEqual(Object.hasOwn(row, 'codeOwnedResolverWired'), false);
  }
}

describe('buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness', () => {
  it('returns fixed real ready fail-closed execution policy evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness();
    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-execution-policy-readiness');
    assert.strictEqual(readiness.state, 'ready');
    assert.strictEqual(readiness.executionPolicyDefined, true);
    assert.strictEqual(readiness.executionPolicyReady, true);
    assert.strictEqual(readiness.realExecutionPolicyReady, true);
    assert.strictEqual(readiness.readyCount, 1);
    assert.strictEqual(readiness.blockedCount, 0);
    assert.deepStrictEqual(readiness.blockers, []);
    assert.deepStrictEqual(readiness.nextBlockers, []);
    assert.deepStrictEqual(readiness.policyEntries, EXPECTED_EXECUTION_POLICY_ENTRIES);
    assert.strictEqual(readiness.policyEntries[0].blockerCode, null);
    assert.strictEqual(readiness.policyEntries[0].evidenceCode, 'execution-policy-ready');
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });

  it('ignores runtime-looking inputs and never leaks opaque unsafe material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness();
    const maliciousInput = {
      executionPolicyReady: false,
      policyEntries: [{
        policyKind: UNSAFE_SECRET_MATERIAL,
        wouldAuthorizeExecution: true,
        allowLifecycleApply: true,
        OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
      }],
      OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
    };
    assert.strictEqual(buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness.length, 0);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(null), baseline);
    assert.doesNotMatch(JSON.stringify(baseline), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /disabled-execution-policy-stub|execution-policy-real-implementation-missing/i,
    );
  });
});

describe('buildSupervisorLifecycleGuardedRunnerRegistryReadiness', () => {
  it('returns fixed ready code-owned registry readiness evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerRegistryReadiness();
    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-registry-readiness');
    assert.strictEqual(readiness.state, 'ready');
    assert.strictEqual(readiness.runnerRegistryDefined, true);
    assert.strictEqual(readiness.runnerRegistryReady, true);
    assert.strictEqual(readiness.codeOwnedRegistryResolverReady, true);
    assert.strictEqual(readiness.realRunnerImplementationsReady, false);
    assert.strictEqual(readiness.readyCount, 1);
    assert.strictEqual(readiness.blockedCount, 0);
    assert.deepStrictEqual(readiness.blockers, []);
    assert.deepStrictEqual(readiness.nextBlockers, []);
    assert.deepStrictEqual(readiness.registryEntries, EXPECTED_RUNNER_REGISTRY_ENTRIES);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
    assert.doesNotMatch(
      JSON.stringify(readiness),
      /runner-registry-real-implementation-missing|runner-registry-missing/i,
    );
  });

  it('ignores all runtime-looking inputs and never leaks malicious registry material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerRegistryReadiness();
    const maliciousInput = {
      runnerRegistryReady: false,
      realRunnerImplementationsReady: true,
      registryEntries: [
        {
          runnerKind: UNSAFE_SECRET_MATERIAL,
          wouldExecute: true,
          wouldRun: true,
          wouldWrite: true,
        },
      ],
      OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
    };
    assert.deepStrictEqual(
      buildSupervisorLifecycleGuardedRunnerRegistryReadiness(maliciousInput),
      baseline,
    );
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRegistryReadiness(null), baseline);
    assert.doesNotMatch(JSON.stringify(baseline), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });
});

describe('resolveSupervisorLifecycleGuardedRunnerRegistry', () => {
  it('R1–R4: resolves all four operations against code-owned mappings', () => {
    for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
      const candidates = validRegistryCandidatesFor(operation);
      assertResolved(
        resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, operation),
        operation,
        candidates,
      );
    }
  });

  it('R5: unknown actionId is runner-registry-action-unknown (not candidates-invalid)', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[2] = validRegistryCandidate('start-recovery-supervisor', 1);
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-action-unknown',
      'install',
    );
  });

  it('R6: length < |E| with subset actionIds is missing (not candidates-invalid)', () => {
    const candidates = validRegistryCandidatesFor('install').slice(0, 2);
    assert.strictEqual(candidates.length, 2);
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-action-missing',
      'install',
    );
  });

  it('R7: duplicate actionId is runner-registry-action-duplicate', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[1] = validRegistryCandidate('render-launch-agent-plist', 1);
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-action-duplicate',
      'install',
    );
  });

  it('R8: legal-format non-catalog implementationId is unresolved', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], implementationId: 'other-plist-impl' };
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-implementation-mismatch',
      'install',
    );
  });

  it('R9: wrong runnerKind is runner-kind-mismatch', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], runnerKind: 'other-stub' };
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-runner-kind-mismatch',
      'install',
    );
  });

  it('R10: wrong mode is mode-mismatch', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], mode: 'unguarded' };
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-mode-mismatch',
      'install',
    );
  });

  for (const maxAttempts of [0, 4, 1.5, '1']) {
    it(`R11: maxAttempts=${String(maxAttempts)} is max-attempts-invalid`, () => {
      const candidates = validRegistryCandidatesFor('install');
      candidates[0] = { ...candidates[0], maxAttempts };
      assertUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
        'runner-registry-max-attempts-invalid',
        'install',
      );
    });
  }

  it('R12: layered fail-closed — helper accepts [redacted], resolver rejects', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], maxAttempts: '[redacted]' };
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, 'install'),
      true,
    );
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-max-attempts-invalid',
      'install',
    );
  });

  it('R13: accessor own props is candidates-invalid', () => {
    const base = validRegistryCandidate('render-launch-agent-plist', 1);
    const poisoned = {};
    for (const key of Object.keys(base)) {
      Object.defineProperty(poisoned, key, {
        enumerable: true,
        configurable: true,
        get() {
          return base[key];
        },
      });
    }
    const candidates = [poisoned, ...validRegistryCandidatesFor('install').slice(1)];
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-candidates-invalid',
      'install',
    );
  });

  it('R14: trap throw is candidates-invalid without secret leak', () => {
    const base = validRegistryCandidate('render-launch-agent-plist', 1);
    const trapped = new Proxy(base, {
      getOwnPropertyDescriptor() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });
    const candidates = [trapped, ...validRegistryCandidatesFor('install').slice(1)];
    const decision = resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install');
    assertUnresolvedExact(decision, 'runner-registry-candidates-invalid', 'install');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });

  for (const candidates of [null, 'not-array', 42, { length: 1 }]) {
    it(`R15: type-confusion ${String(candidates)} is candidates-invalid`, () => {
      assertUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
        'runner-registry-candidates-invalid',
        'install',
      );
    });
  }

  it('R16: sensitive-like unknown keys is candidates-invalid without leak', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL };
    const decision = resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install');
    assertUnresolvedExact(decision, 'runner-registry-candidates-invalid', 'install');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });

  it('R17: invalid operation is operation-invalid with decision.operation unknown', () => {
    const candidates = validRegistryCandidatesFor('install');
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'apply-all'),
      'runner-registry-operation-invalid',
      'unknown',
    );
  });

  it('R18a: wouldRun true is side-effect-flag-invalid', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldRun: true };
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-side-effect-flag-invalid',
      'install',
    );
  });

  it('R18b: status ready is side-effect-flag-invalid', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], status: 'ready' };
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-side-effect-flag-invalid',
      'install',
    );
  });

  it('R19: input/output immutability — returned decision and subsequent resolve are isolated', () => {
    const candidates = validRegistryCandidatesFor('install');
    const first = resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install');
    assertResolved(first, 'install', candidates);
    candidates[0] = { ...candidates[0], actionId: 'start-recovery-supervisor' };
    first.operation = 'unknown';
    const second = resolveSupervisorLifecycleGuardedRunnerRegistry(
      validRegistryCandidatesFor('install'),
      'install',
    );
    assertResolved(second, 'install', validRegistryCandidatesFor('install'));
    const third = resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install');
    assertUnresolvedExact(third, 'runner-registry-action-unknown', 'install');
  });

  it('R20: install fixture implementationIds and maxAttempts 2/1/3 remain compatible', () => {
    const candidates = [
      validRegistryCandidate('render-launch-agent-plist', 2),
      validRegistryCandidate('write-launch-agent-plist', 1),
      validRegistryCandidate('load-launch-agent', 3),
    ];
    assertResolved(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'install',
      candidates,
    );
  });

  it('R21: array Proxy container trap is candidates-invalid without secret leak', () => {
    const raw = validRegistryCandidatesFor('install');
    const candidates = new Proxy([...raw], {
      get(t, p, r) {
        if (p === 'length' || (typeof p === 'string' && /^\d+$/.test(p))) {
          throw new Error(UNSAFE_SECRET_MATERIAL);
        }
        return Reflect.get(t, p, r);
      },
    });
    const decision = resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install');
    assertUnresolvedExact(decision, 'runner-registry-candidates-invalid', 'install');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });

  for (const { label, actionId } of [
    { label: 'empty-string', actionId: '' },
    { label: 'number', actionId: 1 },
  ]) {
    it(`R22: ${label} actionId is candidates-invalid before set checks`, () => {
      const candidates = validRegistryCandidatesFor('install');
      candidates[0] = { ...candidates[0], actionId };
      assertUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
        'runner-registry-candidates-invalid',
        'install',
      );
    });
  }

  it('R23: length > |E| with foreign actionId is unknown (not candidates-invalid)', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates.push(validRegistryCandidate('start-recovery-supervisor', 1));
    assert.strictEqual(candidates.length, 4);
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-action-unknown',
      'install',
    );
  });

  it('R24: length > |E| with duplicate install actionId is duplicate (not candidates-invalid)', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates.push(validRegistryCandidate('render-launch-agent-plist', 1));
    assert.strictEqual(candidates.length, 4);
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-action-duplicate',
      'install',
    );
  });
});

describe('buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness', () => {
  it('returns fixed blocked disabled host mutation adapter readiness evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness();

    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-host-mutation-adapter-readiness');
    assert.strictEqual(readiness.state, 'blocked');
    assert.strictEqual(readiness.hostMutationAdapterDefined, true);
    assert.strictEqual(readiness.hostMutationAdapterReady, false);
    assert.strictEqual(readiness.realHostMutationAdapterReady, false);
    assert.strictEqual(readiness.readyCount, 0);
    assert.strictEqual(readiness.blockedCount, 1);
    assert.ok(readiness.blockers.includes('host-mutation-adapter-real-implementation-missing'));
    assert.ok(readiness.blockers.includes('real-guarded-runner-execution-wiring-missing'));
    assert.deepStrictEqual(readiness.nextBlockers, ['host-mutation-adapter-real-implementation-missing']);
    assert.deepStrictEqual(readiness.adapterEntries, EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });

  it('ignores all runtime-looking inputs and never leaks malicious material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness();
    const maliciousInput = {
      hostMutationAdapterReady: true,
      adapterEntries: [
        {
          adapterKind: 'launchctl /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
          wouldMutateHost: true,
          wouldRun: true,
          wouldWrite: true,
        },
      ],
      config: { token: 'SECRET_XYZ' },
      approval: { approvedBy: 'operator@example.invalid', reason: 'do not leak' },
      hash: 'sha256:abc',
      path: '/Users/ah/private',
    };

    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(null), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(), baseline);
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /\/Users\/ah|SECRET_XYZ|operator@example|do not leak|sha256:|launchctl load|node /i,
    );
  });
});

describe('buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness', () => {
  it('returns fixed blocked disabled rollback anchor readiness evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness();

    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-rollback-anchor-readiness');
    assert.strictEqual(readiness.state, 'blocked');
    assert.strictEqual(readiness.rollbackAnchorDefined, true);
    assert.strictEqual(readiness.rollbackAnchorReady, false);
    assert.strictEqual(readiness.realRollbackAnchorReady, false);
    assert.strictEqual(readiness.readyCount, 0);
    assert.strictEqual(readiness.blockedCount, 1);
    assert.ok(readiness.blockers.includes('rollback-anchor-real-implementation-missing'));
    assert.ok(readiness.blockers.includes('real-guarded-runner-execution-wiring-missing'));
    assert.deepStrictEqual(readiness.nextBlockers, ['rollback-anchor-real-implementation-missing']);
    assert.deepStrictEqual(readiness.anchorEntries, EXPECTED_ROLLBACK_ANCHOR_ENTRIES);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });

  it('ignores all runtime-looking inputs and never leaks malicious material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness();
    const maliciousInput = {
      rollbackAnchorReady: true,
      anchorEntries: [
        {
          anchorKind: 'launchctl /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
          wouldWriteAnchor: true,
          wouldRun: true,
          wouldWrite: true,
        },
      ],
      config: { token: 'SECRET_XYZ' },
      approval: { approvedBy: 'operator@example.invalid', reason: 'do not leak' },
      hash: 'sha256:abc',
      path: '/Users/ah/private',
    };

    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(null), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(), baseline);
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /\/Users\/ah|SECRET_XYZ|operator@example|do not leak|sha256:|launchctl load|node |curl/i,
    );
  });
});

describe('buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness', () => {
  it('returns fixed blocked disabled attempt audit readiness evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness();

    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-attempt-audit-readiness');
    assert.strictEqual(readiness.state, 'blocked');
    assert.strictEqual(readiness.attemptAuditDefined, true);
    assert.strictEqual(readiness.attemptAuditReady, false);
    assert.strictEqual(readiness.realAttemptAuditReady, false);
    assert.strictEqual(readiness.readyCount, 0);
    assert.strictEqual(readiness.blockedCount, 1);
    assert.ok(readiness.blockers.includes('attempt-audit-real-implementation-missing'));
    assert.ok(readiness.blockers.includes('real-guarded-runner-execution-wiring-missing'));
    assert.deepStrictEqual(readiness.nextBlockers, ['attempt-audit-real-implementation-missing']);
    assert.deepStrictEqual(readiness.auditEntries, EXPECTED_ATTEMPT_AUDIT_ENTRIES);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });

  it('ignores all runtime-looking inputs and never leaks malicious material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness();
    const maliciousInput = {
      attemptAuditReady: true,
      auditEntries: [
        {
          auditKind: 'launchctl /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
          wouldWriteAudit: true,
          wouldRun: true,
          wouldWrite: true,
        },
      ],
      config: { token: 'SECRET_XYZ' },
      approval: { approvedBy: 'operator@example.invalid', reason: 'do not leak' },
      hash: 'sha256:abc',
      path: '/Users/ah/private',
    };

    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness(null), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness(), baseline);
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /\/Users\/ah|localhost|SECRET_XYZ|\btoken\b|\bsecret\b|Authorization|operator@example|do not leak|sha256:|launchctl \/|launchctl load|node |curl/i,
    );
  });
});

describe('buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness', () => {
  it('returns fixed blocked disabled operator recovery readiness evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness();

    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-operator-recovery-readiness');
    assert.strictEqual(readiness.state, 'blocked');
    assert.strictEqual(readiness.operatorRecoveryDefined, true);
    assert.strictEqual(readiness.operatorRecoveryReady, false);
    assert.strictEqual(readiness.realOperatorRecoveryReady, false);
    assert.strictEqual(readiness.readyCount, 0);
    assert.strictEqual(readiness.blockedCount, 1);
    assert.ok(readiness.blockers.includes('operator-recovery-real-implementation-missing'));
    assert.ok(readiness.blockers.includes('real-guarded-runner-execution-wiring-missing'));
    assert.deepStrictEqual(readiness.nextBlockers, ['operator-recovery-real-implementation-missing']);
    assert.deepStrictEqual(readiness.recoveryEntries, EXPECTED_OPERATOR_RECOVERY_ENTRIES);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });

  it('ignores all runtime-looking inputs and never leaks malicious recovery material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness();
    const maliciousInput = {
      operatorRecoveryReady: true,
      recoveryEntries: [
        {
          recoveryKind: 'launchctl /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
          wouldRecover: true,
          wouldRetry: true,
          wouldRun: true,
          wouldWrite: true,
        },
      ],
      config: { token: 'SECRET_XYZ' },
      approval: { approvedBy: 'operator@example.invalid', reason: 'do not leak' },
      hash: 'sha256:abc',
      path: '/Users/ah/private',
    };

    assert.strictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness.length, 0);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(null), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(), baseline);
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /\/Users\/ah|localhost|SECRET_XYZ|\btoken\b|\bsecret\b|Authorization|operator@example|do not leak|sha256:|launchctl \/|launchctl load|node |curl/i,
    );
  });
});

describe('buildSupervisorLifecycleGuardedRunnerWiringContract', () => {
  it('returns the fixed blocked real runner wiring contract with complete safety evidence', () => {
    const contract = buildSupervisorLifecycleGuardedRunnerWiringContract(getReadyInputs().executionPreview);

    assertWiringContract(contract);
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
        command: 'opaque-command-material',
        path: 'opaque-path-material',
        token: UNSAFE_SECRET_MATERIAL,
        secret: UNSAFE_SECRET_MATERIAL,
        hostname: 'opaque-host-material',
        hash: 'opaque-hash-material',
        approval: {
          approvedBy: 'opaque-operator',
          reason: 'opaque-reason',
          acknowledgements: ['opaque-acknowledgement'],
        },
      },
    ];

    for (const sample of samples) {
      assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerWiringContract(sample), baseline);
    }
    const serialized = JSON.stringify(baseline);
    assert.doesNotMatch(serialized, new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
    assert.doesNotMatch(serialized, /disabled-execution-policy-stub|execution-policy-real-implementation-missing/i);
  });
});

describe('buildSupervisorLifecycleGuardedRunnerExecutionGate', () => {
  it('ready install + executeRequested:false still resolves registryReady true', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: false });

    assertAlwaysBlockedGate(result, { runnerRegistryReady: true });
    assert.ok(result.blockers.includes('execute-request-missing'));
    assert.deepStrictEqual(result.gates, {
      lifecyclePlanValid: true,
      approvalRecordReady: true,
      manifestReady: true,
      runnerBindingsReady: true,
      executionPreviewVerified: true,
      executeRequested: false,
      actionCandidatesReady: true,
      executionPolicyReady: true,
      runnerRegistryReady: true,
      realRunnerWiringReady: false,
      runnerWiringContractReady: false,
      hostMutationAdapterReady: false,
      rollbackAnchorReady: false,
      attemptAuditReady: false,
      operatorRecoveryReady: false,
    });
    assert.strictEqual(result.registryDecision.state, 'resolved');
    assertWiringContract(result.runnerWiringContract);
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

  it('production ready inputs resolve registry but still deny via remaining wiring facts', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });

    assertAlwaysBlockedGate(result, { runnerRegistryReady: true });
    assert.ok(!result.blockers.includes('execute-request-missing'));
    assert.deepStrictEqual(result.blockers, ['real-guarded-runner-execution-wiring-missing']);
    assert.strictEqual(result.gates.executeRequested, true);
    assert.strictEqual(result.gates.actionCandidatesReady, true);
    assert.strictEqual(result.gates.executionPolicyReady, true);
    assert.strictEqual(result.gates.runnerRegistryReady, true);
    assert.strictEqual(result.registryDecision.state, 'resolved');
    assert.strictEqual(result.registryDecision.registryReady, true);
    assert.strictEqual(result.registryDecision.codeOwnedResolverWired, true);
    assert.strictEqual(result.registryDecision.realHostRunnerReady, false);
    assert.strictEqual(result.registryDecision.wouldExecute, false);
    assert.strictEqual(result.registryDecision.wouldRun, false);
    assert.strictEqual(result.registryDecision.wouldWrite, false);
    assert.strictEqual(result.gates.realRunnerWiringReady, false);
    assert.strictEqual(result.gates.runnerWiringContractReady, false);
    assert.strictEqual(result.policyDecision.state, 'denied');
    assert.strictEqual(result.policyDecision.primaryBlocker, 'host-mutation-adapter-not-ready');
    assert.strictEqual(result.policyDecision.wouldRun, false);
    assert.strictEqual(result.policyDecision.wouldWrite, false);
    for (const code of [
      'host-mutation-adapter-not-ready',
      'rollback-anchor-not-ready',
      'attempt-audit-not-ready',
      'operator-recovery-not-ready',
    ]) {
      assert.ok(result.policyDecision.blockers.includes(code));
    }
    assert.ok(!result.policyDecision.blockers.includes('runner-registry-not-ready'));
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    for (const c of result.actionCandidates) {
      assert.strictEqual(c.wouldExecute, false);
      assert.strictEqual(c.wouldRun, false);
      assert.strictEqual(c.wouldWrite, false);
    }
    assertWiringContract(result.runnerWiringContract);
    assert.strictEqual(result.runnerWiringContract.readyCount, 2);
    assert.strictEqual(result.runnerWiringContract.blockedCount, 4);
  });

  it('G4: empty candidates path keeps registry not ready', () => {
    const notVerifiedInputs = getReadyInputs();
    notVerifiedInputs.executionPreview = {
      ...notVerifiedInputs.executionPreview,
      actionPreviews: notVerifiedInputs.executionPreview.actionPreviews.map((entry, index) => (
        index === 0 ? { ...entry, wouldExecute: true } : entry
      )),
    };
    const result = buildGate(notVerifiedInputs, { executeRequested: true });
    assertAlwaysBlockedGate(result, { runnerRegistryReady: false });
    assert.deepStrictEqual(result.actionCandidates, []);
    assert.strictEqual(result.registryDecision.state, 'unresolved');
    assert.strictEqual(result.registryDecision.primaryBlocker, 'runner-registry-candidates-invalid');
    assert.ok(result.policyDecision.blockers.includes('runner-registry-not-ready'));
  });

  it('G5: ignores forged registry overrides on options', () => {
    const result = buildGate(getReadyInputs(), {
      executeRequested: true,
      registryDecision: {
        state: 'unresolved',
        registryReady: false,
        primaryBlocker: 'runner-registry-candidates-invalid',
      },
      runnerRegistryReady: false,
      registryContext: { runnerRegistryReady: false },
      policyContext: buildAllTruePolicyContext(),
      policyDecision: {
        state: 'authorized',
        authorized: true,
        wouldAuthorizeExecution: true,
        wouldRun: true,
      },
    });
    assertAlwaysBlockedGate(result, { runnerRegistryReady: true });
    assert.strictEqual(result.registryDecision.state, 'resolved');
    assert.strictEqual(result.policyDecision.authorized, false);
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    assert.doesNotMatch(JSON.stringify(result), /forged|wouldRun":true/i);
  });

  it('G7: gate registryDecision is consistent with pure resolver over actionCandidates', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });
    const pure = resolveSupervisorLifecycleGuardedRunnerRegistry(result.actionCandidates, 'install');
    assert.strictEqual(result.registryDecision.state, pure.state);
    assert.strictEqual(result.registryDecision.registryReady, pure.registryReady);
    assert.deepStrictEqual(
      result.registryDecision.mappings.map((row) => row.actionId),
      pure.mappings.map((row) => row.actionId),
    );
  });

  it('G8: non-catalog implementationId keeps registry not ready and fail-closed', () => {
    const base = getReadyInputs();
    const inputs = {
      ...base,
      executionPreview: {
        ...base.executionPreview,
        actionPreviews: base.executionPreview.actionPreviews.map((entry, index) =>
          index === 0
            ? { ...entry, implementationId: 'other-plist-impl' }
            : { ...entry },
        ),
      },
    };
    const result = buildGate(inputs, { executeRequested: true });
    assertAlwaysBlockedGate(result, { runnerRegistryReady: false });
    assert.strictEqual(result.gates.actionCandidatesReady, true);
    assert.strictEqual(result.registryDecision.state, 'unresolved');
    assert.strictEqual(
      result.registryDecision.primaryBlocker,
      'runner-registry-implementation-mismatch',
    );
    assert.strictEqual(result.gates.runnerRegistryReady, false);
    assert.ok(result.policyDecision.blockers.includes('runner-registry-not-ready'));
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    assert.strictEqual(result.policyDecision.wouldRun, false);
    assert.strictEqual(result.policyDecision.wouldWrite, false);
    assert.strictEqual(result.registryDecision.wouldExecute, false);
    assert.strictEqual(result.registryDecision.wouldRun, false);
    assert.strictEqual(result.registryDecision.wouldWrite, false);
    for (const c of result.actionCandidates) {
      assert.strictEqual(c.wouldExecute, false);
      assert.strictEqual(c.wouldRun, false);
      assert.strictEqual(c.wouldWrite, false);
    }
    const readiness = result.runnerWiringContract.runnerRegistryReadiness;
    assert.strictEqual(readiness.state, 'ready');
    assert.strictEqual(readiness.runnerRegistryReady, true);
    assert.strictEqual(readiness.codeOwnedRegistryResolverReady, true);
    assert.strictEqual(readiness.realRunnerImplementationsReady, false);
    for (const entry of readiness.registryEntries) {
      assert.strictEqual(entry.wouldExecute, false);
      assert.strictEqual(entry.wouldRun, false);
      assert.strictEqual(entry.wouldWrite, false);
    }
  });

  it('G9: redacted maxAttempts layered production gate fail-closed', () => {
    const base = getReadyInputs();
    const inputs = {
      ...base,
      executionPreview: {
        ...base.executionPreview,
        actionPreviews: base.executionPreview.actionPreviews.map((entry, index) =>
          index === 0
            ? { ...entry, maxAttempts: 99 }
            : { ...entry },
        ),
      },
    };
    const result = buildGate(inputs, { executeRequested: true });
    assertAlwaysBlockedGate(result, { runnerRegistryReady: false });
    assert.strictEqual(result.gates.actionCandidatesReady, true);
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(result.actionCandidates, 'install'),
      true,
    );
    assert.strictEqual(result.actionCandidates[0].maxAttempts, '[redacted]');
    assert.strictEqual(result.registryDecision.state, 'unresolved');
    assert.strictEqual(
      result.registryDecision.primaryBlocker,
      'runner-registry-max-attempts-invalid',
    );
    assert.strictEqual(result.gates.runnerRegistryReady, false);
    assert.ok(result.policyDecision.blockers.includes('runner-registry-not-ready'));
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    assert.strictEqual(result.policyDecision.wouldRun, false);
    assert.strictEqual(result.policyDecision.wouldWrite, false);
    assert.strictEqual(result.registryDecision.wouldExecute, false);
    assert.strictEqual(result.registryDecision.wouldRun, false);
    assert.strictEqual(result.registryDecision.wouldWrite, false);
    for (const c of result.actionCandidates) {
      assert.strictEqual(c.wouldExecute, false);
      assert.strictEqual(c.wouldRun, false);
      assert.strictEqual(c.wouldWrite, false);
    }
    const readiness = result.runnerWiringContract.runnerRegistryReadiness;
    assert.strictEqual(readiness.state, 'ready');
    assert.strictEqual(readiness.runnerRegistryReady, true);
    assert.strictEqual(readiness.realRunnerImplementationsReady, false);
    for (const entry of readiness.registryEntries) {
      assert.strictEqual(entry.wouldExecute, false);
      assert.strictEqual(entry.wouldRun, false);
      assert.strictEqual(entry.wouldWrite, false);
    }
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

    // production-derived candidates still resolve; approval readiness is independent
    assertAlwaysBlockedGate(result, { runnerRegistryReady: true });
    assert.ok(result.blockers.includes('approval-record-gate-not-ready'));
    assert.doesNotMatch(serialized, /gate-operator|approval reason|acknowledgement|sha256:|\/Users\/ah|localhost|token|secret/i);
  });

  it('uses stable blockers for invalid or mismatched manifest, runner, and preview inputs', () => {
    const invalidManifest = {
      ...getReadyInputs(),
      manifestReadiness: null,
    };
    const invalidManifestResult = buildGate(invalidManifest, { executeRequested: true });

    // plan+preview still valid → candidates resolve; manifest fact is independent
    assertAlwaysBlockedGate(invalidManifestResult, { runnerRegistryReady: true });
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

    // plan+preview still valid → candidates resolve; binding readiness is independent
    assertAlwaysBlockedGate(runnerResult, { runnerRegistryReady: true });
    assert.ok(runnerResult.blockers.includes('guarded-runner-readiness-not-ready'));
    assert.strictEqual(runnerResult.gates.runnerBindingsReady, false);

    const previewMismatch = getReadyInputs();
    previewMismatch.executionPreview = {
      ...previewMismatch.executionPreview,
      operation: 'rollback',
    };
    const previewResult = buildGate(previewMismatch, { executeRequested: true });

    assertAlwaysBlockedGate(previewResult, { runnerRegistryReady: false });
    assert.ok(previewResult.blockers.includes('execution-preview-operation-mismatch'));
    assert.strictEqual(previewResult.gates.executionPreviewVerified, false);

    const invalidPreview = buildGate({ ...getReadyInputs(), executionPreview: null }, { executeRequested: true });

    assertAlwaysBlockedGate(invalidPreview, { runnerRegistryReady: false });
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

    assertAlwaysBlockedGate(notVerifiedResult, { runnerRegistryReady: false });
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

describe('evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy', () => {
  it('authorizes only the pure synthetic all-true exact-key contract', () => {
    for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
      const context = buildAllTruePolicyContext(operation);
      const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
      assertPolicyDecisionInvariants(decision);
      assert.strictEqual(decision.operation, operation);
      assert.strictEqual(decision.state, 'authorized');
      assert.strictEqual(decision.authorized, true);
      assert.strictEqual(decision.wouldAuthorizeExecution, true);
      assert.strictEqual(decision.wouldRun, false);
      assert.strictEqual(decision.wouldWrite, false);
    }
  });

  for (const fact of POLICY_FACT_KEYS) {
    it(`denies when ${fact} is false with registered blocker`, () => {
      const context = buildAllTruePolicyContext('install');
      context[fact] = false;
      const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
      assertPolicyDecisionInvariants(decision);
      assert.strictEqual(decision.state, 'denied');
      assert.strictEqual(decision.authorized, false);
      assert.strictEqual(decision.wouldAuthorizeExecution, false);
      assert.ok(decision.blockers.includes(POLICY_FACT_BLOCKERS[fact]));
      assert.strictEqual(decision.primaryBlocker, decision.blockers[0]);
    });
  }

  it('primaryBlocker follows fixed fact scan order when multiple facts are false', () => {
    const context = buildAllTruePolicyContext('install');
    context.runnerRegistryReady = false;
    context.hostMutationAdapterReady = false;
    context.attemptAuditReady = false;
    const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
    assert.deepStrictEqual(decision.blockers, [
      'runner-registry-not-ready',
      'host-mutation-adapter-not-ready',
      'attempt-audit-not-ready',
    ]);
    assert.strictEqual(decision.primaryBlocker, 'runner-registry-not-ready');
    assert.deepStrictEqual(decision.nextBlockers, ['runner-registry-not-ready']);
  });

  it('denies unknown keys, missing keys, type-confused values, arrays, null, and non-objects', () => {
    const baselineAllTrue = buildAllTruePolicyContext();
    const samples = [
      null,
      undefined,
      [],
      'install',
      1,
      true,
      { ...baselineAllTrue, extra: true },
      (() => {
        const c = { ...baselineAllTrue };
        delete c.executeRequested;
        return c;
      })(),
      { ...baselineAllTrue, lifecyclePlanValid: 'true' },
      { ...baselineAllTrue, lifecyclePlanValid: 1 },
      { ...baselineAllTrue, executeRequested: null },
      Object.assign(Object.create({ polluted: true }), baselineAllTrue),
    ];
    for (const sample of samples) {
      const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(sample);
      assertPolicyDecisionInvariants(decision);
      assert.strictEqual(decision.state, 'denied');
      assert.ok(decision.blockers.includes('execution-policy-context-invalid'));
    }
  });

  it('denies invalid operation as cross-operation / operation-invalid', () => {
    const context = buildAllTruePolicyContext();
    context.operation = 'apply-all';
    const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
    assertPolicyDecisionInvariants(decision);
    assert.strictEqual(decision.state, 'denied');
    assert.ok(decision.blockers.includes('execution-policy-operation-invalid'));
  });

  it('denies empty-actions via actionCandidatesReady false', () => {
    const context = buildAllTruePolicyContext();
    context.actionCandidatesReady = false;
    const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
    assertPolicyDecisionInvariants(decision);
    assert.ok(decision.blockers.includes('action-candidates-not-ready'));
  });

  it('best-effort rejects observable accessor contexts and maps trap throw to fixed invalid', () => {
    const withGetter = {};
    for (const [k, v] of Object.entries(buildAllTruePolicyContext())) {
      Object.defineProperty(withGetter, k, {
        enumerable: true,
        configurable: true,
        get() {
          return v;
        },
      });
    }

    const throwingDescriptorTarget = buildAllTruePolicyContext();
    const throwingProxy = new Proxy(throwingDescriptorTarget, {
      getOwnPropertyDescriptor() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });

    const opaqueLeakProbe = new Proxy(buildAllTruePolicyContext(), {
      get(obj, prop) {
        if (prop === 'OPAQUE_UNSAFE_FIELD') return UNSAFE_SECRET_MATERIAL;
        return obj[prop];
      },
      ownKeys() {
        return [...Object.keys(buildAllTruePolicyContext()), 'OPAQUE_UNSAFE_FIELD'];
      },
      getOwnPropertyDescriptor(obj, prop) {
        if (prop === 'OPAQUE_UNSAFE_FIELD') {
          return { configurable: true, enumerable: true, value: UNSAFE_SECRET_MATERIAL };
        }
        return Object.getOwnPropertyDescriptor(obj, prop);
      },
    });

    for (const sample of [withGetter, throwingProxy, opaqueLeakProbe]) {
      const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(sample);
      assertPolicyDecisionInvariants(decision);
      assert.strictEqual(decision.state, 'denied');
      assert.ok(decision.blockers.includes('execution-policy-context-invalid'));
      assert.strictEqual(decision.primaryBlocker, 'execution-policy-context-invalid');
      assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
    }
  });

  it('input mutation does not change an already-returned decision; output mutation does not affect later calls', () => {
    const context = buildAllTruePolicyContext();
    const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
    const snapshot = JSON.stringify(decision);

    context.runnerRegistryReady = false;
    context.operation = 'hacked';
    context.lifecyclePlanValid = false;
    assert.strictEqual(JSON.stringify(decision), snapshot);
    assert.strictEqual(decision.state, 'authorized');
    assert.strictEqual(decision.authorized, true);
    assert.strictEqual(decision.wouldAuthorizeExecution, true);
    assert.strictEqual(decision.wouldRun, false);

    decision.authorized = false;
    decision.wouldAuthorizeExecution = false;
    decision.state = 'denied';
    decision.blockers.push('forged-blocker');
    decision.wouldRun = true;
    decision.primaryBlocker = 'forged-blocker';

    const again = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(buildAllTruePolicyContext());
    assert.strictEqual(again.state, 'authorized');
    assert.strictEqual(again.authorized, true);
    assert.strictEqual(again.wouldAuthorizeExecution, true);
    assert.strictEqual(again.wouldRun, false);
    assert.strictEqual(again.wouldWrite, false);
    assert.deepStrictEqual(again.blockers, []);
    assert.strictEqual(again.primaryBlocker, null);
    assert.ok(!JSON.stringify(again).includes('forged-blocker'));
    assert.notStrictEqual(again, decision);
  });

  it('never echoes opaque unsafe material from malicious context bag', () => {
    const context = buildAllTruePolicyContext();
    const malicious = {
      ...context,
      OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
      nestedOpaque: { material: UNSAFE_SECRET_MATERIAL },
    };
    const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(malicious);
    assert.strictEqual(decision.state, 'denied');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });
});

describe('areSupervisorLifecycleGuardedRunnerActionCandidatesReady', () => {
  function validCandidate(actionId) {
    return {
      actionId,
      implementationId: 'impl-synthetic',
      runnerKind: 'guarded-host-action',
      mode: 'guarded-host-action',
      status: 'blocked',
      wouldExecute: false,
      wouldRun: false,
      wouldWrite: false,
      maxAttempts: 1,
    };
  }

  function validCandidatesFor(operation) {
    const expectedIds = OPERATION_EXPECTED_ACTION_IDS[operation];
    return expectedIds.map((id) => validCandidate(id));
  }

  it('A1: nonempty + exact schema + unique actionId + full expected-set match + sensitive-field-free => true', () => {
    for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
      assert.strictEqual(
        areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
          validCandidatesFor(operation),
          operation,
        ),
        true,
      );
    }
  });

  it('A2: empty array => false', () => {
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady([], 'install'),
      false,
    );
  });

  it('A3: missing required schema field or unknown key => false', () => {
    const base = validCandidatesFor('install');
    const missingField = base.map((c, i) => (i === 0
      ? {
          actionId: c.actionId,
        }
      : c));
    const unknownKey = base.map((c, i) => (i === 0
      ? { ...c, OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL }
      : c));
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(missingField, 'install'),
      false,
    );
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(unknownKey, 'install'),
      false,
    );
  });

  it('A4: duplicate actionId => false', () => {
    const base = validCandidatesFor('install');
    const duped = [...base, { ...base[0] }];
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(duped, 'install'),
      false,
    );
  });

  it('A5: candidates set does not fully match operation expected set => false', () => {
    const base = validCandidatesFor('install');
    const missingOne = base.slice(0, Math.max(0, base.length - 1));
    const extraOne = [...base, validCandidate('synthetic-extra-action-id')];
    const wrongOpSet = validCandidatesFor('uninstall');
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(missingOne, 'install'),
      false,
    );
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(extraOne, 'install'),
      false,
    );
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(wrongOpSet, 'install'),
      false,
    );
  });

  it('A6: trap / getter / non-array / null / invalid operation / type-confused => false', () => {
    const base = validCandidatesFor('install');
    const withGetterElement = [...base];
    const trapped = {};
    for (const [k, v] of Object.entries(base[0])) {
      Object.defineProperty(trapped, k, {
        enumerable: true,
        configurable: true,
        get() {
          return v;
        },
      });
    }
    withGetterElement[0] = trapped;

    const throwingProxy = new Proxy(base, {
      get() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });

    const samples = [
      null,
      undefined,
      'install',
      1,
      true,
      { not: 'array' },
      withGetterElement,
      throwingProxy,
    ];
    for (const sample of samples) {
      assert.strictEqual(
        areSupervisorLifecycleGuardedRunnerActionCandidatesReady(sample, 'install'),
        false,
      );
    }
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(base, 'apply-all'),
      false,
    );
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(base, null),
      false,
    );
  });

  it('A7: sensitive-field-free failure + boolean-only / not authorize-or-wouldRun boundary', () => {
    const base = validCandidatesFor('install');
    const withSensitive = base.map((c, i) => (i === 0
      ? { ...c, OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL }
      : c));
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(withSensitive, 'install'),
      false,
    );
    const ready = areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
      validCandidatesFor('install'),
      'install',
    );
    assert.strictEqual(typeof ready, 'boolean');
    assert.strictEqual(ready, true);
  });

  it('A8: maxAttempts accepts 1..3 and [redacted], rejects 4 and 99', () => {
    for (const ok of [1, 2, 3, '[redacted]']) {
      const candidates = validCandidatesFor('install').map((c, i) => (
        i === 0 ? { ...c, maxAttempts: ok } : c
      ));
      assert.strictEqual(
        areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, 'install'),
        true,
        `maxAttempts=${String(ok)} must be accepted`,
      );
    }
    for (const bad of [4, 99]) {
      const candidates = validCandidatesFor('install').map((c, i) => (
        i === 0 ? { ...c, maxAttempts: bad } : c
      ));
      assert.strictEqual(
        areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, 'install'),
        false,
        `maxAttempts=${bad} must be rejected`,
      );
    }
  });
});

describe('gates.actionCandidatesReady gate integration (empty/valid only)', () => {
  it('G1: production valid candidates => actionCandidatesReady true but policy denied via four remaining downstream', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });
    assert.strictEqual(result.gates.actionCandidatesReady, true);
    assert.strictEqual(result.gates.runnerRegistryReady, true);
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
        result.actionCandidates,
        result.operation,
      ),
      true,
    );
    assert.strictEqual(result.policyDecision.state, 'denied');
    assert.strictEqual(result.policyDecision.authorized, false);
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    for (const code of [
      'host-mutation-adapter-not-ready',
      'rollback-anchor-not-ready',
      'attempt-audit-not-ready',
      'operator-recovery-not-ready',
    ]) {
      assert.ok(result.policyDecision.blockers.includes(code));
    }
    assert.ok(!result.policyDecision.blockers.includes('runner-registry-not-ready'));
  });

  it('G2: empty sanitized candidates => actionCandidatesReady false + action-candidates-not-ready', () => {
    const emptyPathInputs = getReadyInputs();
    emptyPathInputs.executionPreview = {
      ...emptyPathInputs.executionPreview,
      actionPreviews: emptyPathInputs.executionPreview.actionPreviews.map((entry, index) => (
        index === 0 ? { ...entry, wouldExecute: true } : entry
      )),
    };
    const result = buildGate(emptyPathInputs, { executeRequested: true });
    assert.deepStrictEqual(result.actionCandidates, []);
    assert.strictEqual(result.gates.actionCandidatesReady, false);
    assert.ok(result.policyDecision.blockers.includes('action-candidates-not-ready'));
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(result.actionCandidates, result.operation),
      false,
    );
  });
});
