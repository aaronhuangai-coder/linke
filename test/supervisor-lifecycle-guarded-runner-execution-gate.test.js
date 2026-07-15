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
  buildSupervisorLifecycleGuardedRunnerRealWiringPlan,
  buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal,
  buildSupervisorLifecycleGuardedRunnerRealWiringOrchestratorReadiness,
  evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy,
  resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter,
  resolveSupervisorLifecycleGuardedRunnerRegistry,
  resolveSupervisorLifecycleGuardedRunnerRollbackAnchor,
  resolveSupervisorLifecycleGuardedRunnerAttemptAudit,
  resolveSupervisorLifecycleGuardedRunnerOperatorRecovery,
  sanitizeHostMutationAdapterDecision,
  sanitizeRollbackAnchorDecision,
  sanitizeAttemptAuditDecision,
  sanitizeOperatorRecoveryDecision,
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
  ['host-mutation-adapter', null, 'ready', 'host-mutation-adapter-ready'],
  ['rollback-anchor', null, 'ready', 'rollback-anchor-ready'],
  ['attempt-audit', null, 'ready', 'attempt-audit-ready'],
  ['operator-recovery', null, 'ready', 'operator-recovery-ready'],
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
const CODE_OWNED_ACTION_MUTATION_MAP = Object.freeze({
  'render-launch-agent-plist': 'render-plist-mutation',
  'write-launch-agent-plist': 'write-plist-mutation',
  'load-launch-agent': 'load-agent-mutation',
  'unload-launch-agent': 'unload-agent-mutation',
  'remove-launch-agent-plist': 'remove-plist-mutation',
  'remove-supervisor-metadata': 'remove-metadata-mutation',
  'capture-current-state': 'capture-state-mutation',
  'restore-previous-plist': 'restore-plist-mutation',
  'restart-previous-supervisor': 'restart-supervisor-mutation',
  'start-recovery-supervisor': 'recovery-supervisor-mutation',
});
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
const CODE_OWNED_ACTION_ANCHOR_MAP = Object.freeze({
  'render-launch-agent-plist': 'render-plist-anchor',
  'write-launch-agent-plist': 'write-plist-anchor',
  'load-launch-agent': 'load-agent-anchor',
  'unload-launch-agent': 'unload-agent-anchor',
  'remove-launch-agent-plist': 'remove-plist-anchor',
  'remove-supervisor-metadata': 'remove-metadata-anchor',
  'capture-current-state': 'capture-state-anchor',
  'restore-previous-plist': 'restore-plist-anchor',
  'restart-previous-supervisor': 'restart-supervisor-anchor',
  'start-recovery-supervisor': 'recovery-supervisor-anchor',
});
const EXPECTED_ATTEMPT_AUDIT_ENTRIES = Object.freeze([
  {
    auditKind: 'code-owned-attempt-audit',
    state: 'ready',
    codeOwnedResolverWired: true,
    realAttemptAuditImplementationReady: false,
    wouldPersistAudit: false,
    wouldWriteLog: false,
    wouldWriteAudit: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    auditWriteAllowed: false,
    metadataWriteAllowed: false,
    filesystemWriteAllowed: false,
    immutableAuditReady: false,
    blockerCode: null,
    evidenceCode: 'attempt-audit-ready',
  },
]);
const CODE_OWNED_ACTION_AUDIT_MAP = Object.freeze({
  'render-launch-agent-plist': 'render-plist-attempt-audit',
  'write-launch-agent-plist': 'write-plist-attempt-audit',
  'load-launch-agent': 'load-agent-attempt-audit',
  'unload-launch-agent': 'unload-agent-attempt-audit',
  'remove-launch-agent-plist': 'remove-plist-attempt-audit',
  'remove-supervisor-metadata': 'remove-metadata-attempt-audit',
  'capture-current-state': 'capture-state-attempt-audit',
  'restore-previous-plist': 'restore-plist-attempt-audit',
  'restart-previous-supervisor': 'restart-supervisor-attempt-audit',
  'start-recovery-supervisor': 'recovery-supervisor-attempt-audit',
});
const EXPECTED_OPERATOR_RECOVERY_ENTRIES = Object.freeze([
  {
    recoveryKind: 'code-owned-operator-recovery',
    state: 'ready',
    codeOwnedResolverWired: true,
    realOperatorRecoveryImplementationReady: false,
    wouldRecover: false,
    wouldRetry: false,
    wouldNotifyOperator: false,
    wouldRestartService: false,
    wouldRestoreState: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    metadataWriteAllowed: false,
    filesystemWriteAllowed: false,
    remoteCommandAllowed: false,
    operatorNotificationAllowed: false,
    blockerCode: null,
    evidenceCode: 'operator-recovery-ready',
  },
]);
const CODE_OWNED_ACTION_RECOVERY_MAP = Object.freeze({
  'render-launch-agent-plist': 'render-plist-operator-recovery',
  'write-launch-agent-plist': 'write-plist-operator-recovery',
  'load-launch-agent': 'load-agent-operator-recovery',
  'unload-launch-agent': 'unload-agent-operator-recovery',
  'remove-launch-agent-plist': 'remove-plist-operator-recovery',
  'remove-supervisor-metadata': 'remove-metadata-operator-recovery',
  'capture-current-state': 'capture-state-operator-recovery',
  'restore-previous-plist': 'restore-plist-operator-recovery',
  'restart-previous-supervisor': 'restart-supervisor-operator-recovery',
  'start-recovery-supervisor': 'recovery-supervisor-operator-recovery',
});

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

function assertAlwaysBlockedGate(result, {
  runnerRegistryReady,
  hostMutationAdapterReady,
  rollbackAnchorReady,
  attemptAuditReady,
  operatorRecoveryReady,
}) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');
  assert.strictEqual(typeof hostMutationAdapterReady, 'boolean');
  assert.strictEqual(typeof rollbackAnchorReady, 'boolean');
  assert.strictEqual(typeof attemptAuditReady, 'boolean');
  assert.strictEqual(typeof operatorRecoveryReady, 'boolean');
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
  assert.strictEqual(result.gates.hostMutationAdapterReady, hostMutationAdapterReady);
  assert.strictEqual(result.gates.rollbackAnchorReady, rollbackAnchorReady);
  assert.strictEqual(result.gates.attemptAuditReady, attemptAuditReady);
  assert.strictEqual(result.gates.operatorRecoveryReady, operatorRecoveryReady);
  assert.strictEqual(result.realRunnerWiringReady, false);
  assert.strictEqual(result.executorReady, false);
  assert.strictEqual(result.runnerWiringContract.readyCount, 6);
  assert.strictEqual(result.runnerWiringContract.blockedCount, 0);
  assert.strictEqual(result.runnerWiringContract.state, 'blocked');
  assert.strictEqual(result.runnerWiringContract.realRunnerWiringReady, false);
  assert.ok(result.runnerWiringContract.blockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.ok(result.adapterDecision && typeof result.adapterDecision === 'object');
  assert.strictEqual(result.adapterDecision.wouldMutateHost, false);
  assert.strictEqual(result.adapterDecision.wouldExecute, false);
  assert.strictEqual(result.adapterDecision.wouldRun, false);
  assert.strictEqual(result.adapterDecision.wouldWrite, false);
  assert.strictEqual(result.adapterDecision.launchctlAllowed, false);
  assert.strictEqual(result.adapterDecision.filesystemWriteAllowed, false);
  assert.strictEqual(result.adapterDecision.processListReadAllowed, false);
  assert.strictEqual(result.adapterDecision.metadataWriteAllowed, false);
  assert.strictEqual(result.adapterDecision.auditWriteAllowed, false);
  assert.strictEqual(result.adapterDecision.rollbackAnchorWriteAllowed, false);
  assert.strictEqual(result.adapterDecision.realHostMutationImplementationReady, false);
  assert.strictEqual(result.adapterDecision.codeOwnedResolverWired, true);
  assert.ok(result.anchorDecision && typeof result.anchorDecision === 'object');
  assert.strictEqual(result.anchorDecision.codeOwnedResolverWired, true);
  assert.strictEqual(result.anchorDecision.realRollbackAnchorImplementationReady, false);
  assert.strictEqual(result.anchorDecision.wouldWriteAnchor, false);
  assert.strictEqual(result.anchorDecision.wouldRestore, false);
  assert.strictEqual(result.anchorDecision.wouldExecute, false);
  assert.strictEqual(result.anchorDecision.wouldRun, false);
  assert.strictEqual(result.anchorDecision.wouldWrite, false);
  assert.strictEqual(result.anchorDecision.filesystemWriteAllowed, false);
  assert.strictEqual(result.anchorDecision.metadataWriteAllowed, false);
  assert.strictEqual(result.anchorDecision.rollbackAnchorWriteAllowed, false);
  assert.strictEqual(result.anchorDecision.rollbackRestoreAllowed, false);
  assert.ok(result.auditDecision && typeof result.auditDecision === 'object');
  assert.strictEqual(result.auditDecision.codeOwnedResolverWired, true);
  assert.strictEqual(result.auditDecision.realAttemptAuditImplementationReady, false);
  assert.strictEqual(result.auditDecision.wouldPersistAudit, false);
  assert.strictEqual(result.auditDecision.wouldWriteLog, false);
  assert.strictEqual(result.auditDecision.wouldWriteAudit, false);
  assert.strictEqual(result.auditDecision.wouldExecute, false);
  assert.strictEqual(result.auditDecision.wouldRun, false);
  assert.strictEqual(result.auditDecision.wouldWrite, false);
  assert.strictEqual(result.auditDecision.auditWriteAllowed, false);
  assert.strictEqual(result.auditDecision.metadataWriteAllowed, false);
  assert.strictEqual(result.auditDecision.filesystemWriteAllowed, false);
  assert.strictEqual(result.auditDecision.immutableAuditReady, false);
  assert.ok(result.recoveryDecision && typeof result.recoveryDecision === 'object');
  assert.strictEqual(result.recoveryDecision.codeOwnedResolverWired, true);
  assert.strictEqual(result.recoveryDecision.realOperatorRecoveryImplementationReady, false);
  assert.strictEqual(result.recoveryDecision.wouldRecover, false);
  assert.strictEqual(result.recoveryDecision.wouldRetry, false);
  assert.strictEqual(result.recoveryDecision.wouldNotifyOperator, false);
  assert.strictEqual(result.recoveryDecision.wouldRestartService, false);
  assert.strictEqual(result.recoveryDecision.wouldRestoreState, false);
  assert.strictEqual(result.recoveryDecision.wouldExecute, false);
  assert.strictEqual(result.recoveryDecision.wouldRun, false);
  assert.strictEqual(result.recoveryDecision.wouldWrite, false);
  assert.strictEqual(result.recoveryDecision.metadataWriteAllowed, false);
  assert.strictEqual(result.recoveryDecision.filesystemWriteAllowed, false);
  assert.strictEqual(result.recoveryDecision.remoteCommandAllowed, false);
  assert.strictEqual(result.recoveryDecision.operatorNotificationAllowed, false);
  assert.ok(result.policyDecision && typeof result.policyDecision === 'object');
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
  const readiness = result.runnerWiringContract.hostMutationAdapterReadiness;
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.hostMutationAdapterReady, true);
  assert.strictEqual(readiness.codeOwnedAdapterResolverReady, true);
  assert.strictEqual(readiness.realHostMutationImplementationReady, false);
  assert.deepStrictEqual(readiness.adapterEntries, EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES);
  const anchorReadiness = result.runnerWiringContract.rollbackAnchorReadiness;
  assert.strictEqual(anchorReadiness.state, 'ready');
  assert.strictEqual(anchorReadiness.rollbackAnchorReady, true);
  assert.strictEqual(anchorReadiness.codeOwnedAnchorResolverReady, true);
  assert.strictEqual(anchorReadiness.realRollbackAnchorImplementationReady, false);
  assert.deepStrictEqual(anchorReadiness.anchorEntries, EXPECTED_ROLLBACK_ANCHOR_ENTRIES);
}

function assertWiringContract(contract) {
  assert.strictEqual(contract.command, 'supervisor-lifecycle-guarded-runner-wiring-contract');
  assert.strictEqual(contract.state, 'blocked');
  assert.strictEqual(contract.realRunnerWiringReady, false);
  // V1.29 aggregate：6 ready / 0 blocked；aggregate 仍 blocked（真实 wiring 缺失）
  assert.strictEqual(contract.readyCount, 6);
  assert.strictEqual(contract.blockedCount, 0);
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
  const adapterContract = contract.requiredContracts[2];
  assert.strictEqual(adapterContract.id, 'host-mutation-adapter');
  assert.strictEqual(adapterContract.status, 'ready');
  assert.strictEqual(adapterContract.blockerCode, null);
  assert.strictEqual(adapterContract.evidenceCode, 'host-mutation-adapter-ready');
  const anchorContract = contract.requiredContracts[3];
  assert.strictEqual(anchorContract.id, 'rollback-anchor');
  assert.strictEqual(anchorContract.status, 'ready');
  assert.strictEqual(anchorContract.blockerCode, null);
  assert.strictEqual(anchorContract.evidenceCode, 'rollback-anchor-ready');
  const auditContract = contract.requiredContracts[4];
  assert.strictEqual(auditContract.id, 'attempt-audit');
  assert.strictEqual(auditContract.status, 'ready');
  assert.strictEqual(auditContract.blockerCode, null);
  assert.strictEqual(auditContract.evidenceCode, 'attempt-audit-ready');
  const recoveryContract = contract.requiredContracts[5];
  assert.strictEqual(recoveryContract.id, 'operator-recovery');
  assert.strictEqual(recoveryContract.status, 'ready');
  assert.strictEqual(recoveryContract.blockerCode, null);
  assert.strictEqual(recoveryContract.evidenceCode, 'operator-recovery-ready');
  assert.ok(contract.requiredContracts.every((entry) =>
    entry.status === 'ready' &&
      entry.requiredForExecution === true &&
      entry.blockerCode === null));
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
  assert.strictEqual(contract.hostMutationAdapterReadiness.state, 'ready');
  assert.strictEqual(contract.hostMutationAdapterReadiness.hostMutationAdapterReady, true);
  assert.strictEqual(contract.hostMutationAdapterReadiness.codeOwnedAdapterResolverReady, true);
  assert.strictEqual(contract.hostMutationAdapterReadiness.realHostMutationImplementationReady, false);
  assert.deepStrictEqual(
    contract.hostMutationAdapterReadiness.adapterEntries,
    EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES,
  );
  assert.deepStrictEqual(
    contract.rollbackAnchorReadiness,
    buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(),
  );
  assert.strictEqual(contract.rollbackAnchorReadiness.state, 'ready');
  assert.strictEqual(contract.rollbackAnchorReadiness.rollbackAnchorReady, true);
  assert.strictEqual(contract.rollbackAnchorReadiness.codeOwnedAnchorResolverReady, true);
  assert.strictEqual(contract.rollbackAnchorReadiness.realRollbackAnchorImplementationReady, false);
  assert.deepStrictEqual(
    contract.rollbackAnchorReadiness.anchorEntries,
    EXPECTED_ROLLBACK_ANCHOR_ENTRIES,
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

function validAdapterCandidate(actionId, maxAttempts = 1) {
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

function validAdapterCandidatesFor(operation) {
  return OPERATION_EXPECTED_ACTION_IDS[operation].map((id) => validAdapterCandidate(id, 1));
}

/**
 * assertAdapterUnresolvedExact：第三参 operation **必传**，禁止默认 `'unknown'`。
 * - typeof operation === 'string' 且 decision.operation === operation（严格全等）
 * - 合法 install/uninstall/rollback/recover 输入上的 **任意** unresolved：第三参传对应合法 operation
 * - **仅** invalid operation（H17：非 allowlisted string + 非 string 含 undefined/null/number/boolean）传 expected output `'unknown'`
 */
function assertAdapterUnresolvedExact(decision, primaryBlocker, operation) {
  assert.strictEqual(typeof operation, 'string');
  assert.strictEqual(typeof primaryBlocker, 'string');
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-host-mutation-adapter');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'unresolved');
  assert.strictEqual(decision.adapterReady, false);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realHostMutationImplementationReady, false);
  assert.strictEqual(decision.wouldMutateHost, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.launchctlAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.processListReadAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.auditWriteAllowed, false);
  assert.strictEqual(decision.rollbackAnchorWriteAllowed, false);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.resolvedCount, 0);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.deepStrictEqual(decision.mutations, []);
  assert.deepStrictEqual(decision.blockers, [primaryBlocker]);
  assert.strictEqual(decision.primaryBlocker, primaryBlocker);
  assert.deepStrictEqual(decision.nextBlockers, [primaryBlocker]);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  assert.ok(!Object.values(decision).some((v) => typeof v === 'function'));
}

/**
 * assertAdapterResolved：与 design §1.5 mutations 行 schema 全字段一致。
 * - 第二参 operation 决定 expected action 序
 * - mutation row **不含** codeOwnedResolverWired
 */
function assertAdapterResolved(decision, operation) {
  const expected = OPERATION_EXPECTED_ACTION_IDS[operation];
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-host-mutation-adapter');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'resolved');
  assert.strictEqual(decision.adapterReady, true);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realHostMutationImplementationReady, false);
  assert.strictEqual(decision.wouldMutateHost, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.launchctlAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.processListReadAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.auditWriteAllowed, false);
  assert.strictEqual(decision.rollbackAnchorWriteAllowed, false);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.resolvedCount, expected.length);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.strictEqual(decision.mutations.length, expected.length);
  assert.deepStrictEqual(decision.blockers, []);
  assert.strictEqual(decision.primaryBlocker, null);
  assert.deepStrictEqual(decision.nextBlockers, []);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  for (let i = 0; i < expected.length; i++) {
    const actionId = expected[i];
    const row = decision.mutations[i];
    assert.strictEqual(row.actionId, actionId);
    assert.strictEqual(row.mutationKind, CODE_OWNED_ACTION_MUTATION_MAP[actionId]);
    assert.strictEqual(row.mutationReady, true);
    assert.strictEqual(row.realHostMutationImplementationReady, false);
    assert.strictEqual(row.wouldMutateHost, false);
    assert.strictEqual(row.wouldExecute, false);
    assert.strictEqual(row.wouldRun, false);
    assert.strictEqual(row.wouldWrite, false);
    assert.strictEqual(row.launchctlAllowed, false);
    assert.strictEqual(row.filesystemWriteAllowed, false);
    assert.strictEqual(row.processListReadAllowed, false);
    assert.strictEqual(row.metadataWriteAllowed, false);
    assert.strictEqual(row.auditWriteAllowed, false);
    assert.strictEqual(row.rollbackAnchorWriteAllowed, false);
    assert.strictEqual(row.blockerCode, null);
    assert.strictEqual(row.evidenceCode, 'host-mutation-adapter-mutation-ready');
    assert.strictEqual(Object.hasOwn(row, 'codeOwnedResolverWired'), false);
  }
}

function validAnchorCandidate(actionId, maxAttempts = 1) {
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

function validAnchorCandidatesFor(operation) {
  return OPERATION_EXPECTED_ACTION_IDS[operation].map((id) => validAnchorCandidate(id, 1));
}

/**
 * assertAnchorUnresolvedExact：第三参 operation **必传**，禁止默认 `'unknown'`。
 * - typeof operation === 'string' 且 decision.operation === operation（严格全等）
 * - 合法 install/uninstall/rollback/recover 输入上的 **任意** unresolved：第三参传对应合法 operation
 * - **仅** invalid operation 传 expected output `'unknown'`
 */
function assertAnchorUnresolvedExact(decision, primaryBlocker, operation) {
  assert.strictEqual(typeof operation, 'string');
  assert.strictEqual(typeof primaryBlocker, 'string');
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-rollback-anchor');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'unresolved');
  assert.strictEqual(decision.anchorReady, false);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realRollbackAnchorImplementationReady, false);
  assert.strictEqual(decision.wouldWriteAnchor, false);
  assert.strictEqual(decision.wouldRestore, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.rollbackAnchorWriteAllowed, false);
  assert.strictEqual(decision.rollbackRestoreAllowed, false);
  assert.strictEqual(decision.resolvedCount, 0);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.deepStrictEqual(decision.anchors, []);
  assert.deepStrictEqual(decision.blockers, [primaryBlocker]);
  assert.strictEqual(decision.primaryBlocker, primaryBlocker);
  assert.deepStrictEqual(decision.nextBlockers, [primaryBlocker]);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  assert.ok(!Object.values(decision).some((v) => typeof v === 'function'));
}

function assertAnchorResolved(decision, operation) {
  const expected = OPERATION_EXPECTED_ACTION_IDS[operation];
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-rollback-anchor');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'resolved');
  assert.strictEqual(decision.anchorReady, true);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realRollbackAnchorImplementationReady, false);
  assert.strictEqual(decision.wouldWriteAnchor, false);
  assert.strictEqual(decision.wouldRestore, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.rollbackAnchorWriteAllowed, false);
  assert.strictEqual(decision.rollbackRestoreAllowed, false);
  assert.strictEqual(decision.resolvedCount, expected.length);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.strictEqual(decision.primaryBlocker, null);
  assert.deepStrictEqual(decision.blockers, []);
  assert.deepStrictEqual(decision.nextBlockers, []);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.anchors.length, expected.length);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  for (let i = 0; i < expected.length; i += 1) {
    const row = decision.anchors[i];
    assert.strictEqual(row.actionId, expected[i]);
    assert.strictEqual(row.anchorKind, CODE_OWNED_ACTION_ANCHOR_MAP[expected[i]]);
    assert.strictEqual(row.anchorReady, true);
    assert.strictEqual(row.realRollbackAnchorImplementationReady, false);
    assert.strictEqual(row.wouldWriteAnchor, false);
    assert.strictEqual(row.wouldRestore, false);
    assert.strictEqual(row.wouldExecute, false);
    assert.strictEqual(row.wouldRun, false);
    assert.strictEqual(row.wouldWrite, false);
    assert.strictEqual(row.filesystemWriteAllowed, false);
    assert.strictEqual(row.metadataWriteAllowed, false);
    assert.strictEqual(row.rollbackAnchorWriteAllowed, false);
    assert.strictEqual(row.rollbackRestoreAllowed, false);
    assert.strictEqual(row.blockerCode, null);
    assert.strictEqual(row.evidenceCode, 'rollback-anchor-plan-ready');
    assert.strictEqual(Object.hasOwn(row, 'codeOwnedResolverWired'), false);
  }
}

function validAuditCandidate(actionId, maxAttempts = 1) {
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

function validAuditCandidatesFor(operation) {
  return OPERATION_EXPECTED_ACTION_IDS[operation].map((id) => validAuditCandidate(id, 1));
}

/**
 * assertAuditUnresolvedExact：第三参 operation **必传**，禁止默认 `'unknown'`。
 * - typeof operation === 'string' 且 decision.operation === operation（严格全等）
 * - 合法 install/uninstall/rollback/recover 输入上的 **任意** unresolved：第三参传对应合法 operation
 * - **仅** invalid operation 传 expected output `'unknown'`
 */
function assertAuditUnresolvedExact(decision, primaryBlocker, operation) {
  assert.strictEqual(typeof operation, 'string');
  assert.strictEqual(typeof primaryBlocker, 'string');
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-attempt-audit');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'unresolved');
  assert.strictEqual(decision.auditReady, false);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realAttemptAuditImplementationReady, false);
  assert.strictEqual(decision.wouldPersistAudit, false);
  assert.strictEqual(decision.wouldWriteLog, false);
  assert.strictEqual(decision.wouldWriteAudit, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.auditWriteAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.immutableAuditReady, false);
  assert.strictEqual(decision.resolvedCount, 0);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.deepStrictEqual(decision.audits, []);
  assert.deepStrictEqual(decision.blockers, [primaryBlocker]);
  assert.strictEqual(decision.primaryBlocker, primaryBlocker);
  assert.deepStrictEqual(decision.nextBlockers, [primaryBlocker]);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
}

function assertAuditResolved(decision, operation) {
  const expected = OPERATION_EXPECTED_ACTION_IDS[operation];
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-attempt-audit');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'resolved');
  assert.strictEqual(decision.auditReady, true);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realAttemptAuditImplementationReady, false);
  assert.strictEqual(decision.wouldPersistAudit, false);
  assert.strictEqual(decision.wouldWriteLog, false);
  assert.strictEqual(decision.wouldWriteAudit, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.auditWriteAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.immutableAuditReady, false);
  assert.strictEqual(decision.resolvedCount, expected.length);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.strictEqual(decision.primaryBlocker, null);
  assert.deepStrictEqual(decision.blockers, []);
  assert.deepStrictEqual(decision.nextBlockers, []);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.audits.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const row = decision.audits[i];
    assert.strictEqual(row.actionId, expected[i]);
    assert.strictEqual(row.auditKind, CODE_OWNED_ACTION_AUDIT_MAP[expected[i]]);
    assert.strictEqual(row.auditReady, true);
    assert.strictEqual(row.realAttemptAuditImplementationReady, false);
    assert.strictEqual(row.wouldPersistAudit, false);
    assert.strictEqual(row.wouldWriteLog, false);
    assert.strictEqual(row.wouldWriteAudit, false);
    assert.strictEqual(row.wouldExecute, false);
    assert.strictEqual(row.wouldRun, false);
    assert.strictEqual(row.wouldWrite, false);
    assert.strictEqual(row.auditWriteAllowed, false);
    assert.strictEqual(row.metadataWriteAllowed, false);
    assert.strictEqual(row.filesystemWriteAllowed, false);
    assert.strictEqual(row.immutableAuditReady, false);
    assert.strictEqual(row.blockerCode, null);
    assert.strictEqual(row.evidenceCode, 'attempt-audit-plan-ready');
  }
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

function validRecoveryCandidate(actionId, maxAttempts = 1) {
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

function validRecoveryCandidatesFor(operation) {
  return OPERATION_EXPECTED_ACTION_IDS[operation].map((id) => validRecoveryCandidate(id, 1));
}

/**
 * assertRecoveryUnresolvedExact：第三参 operation **必传**，禁止默认 `'unknown'`。
 */
function assertRecoveryUnresolvedExact(decision, primaryBlocker, operation) {
  assert.strictEqual(typeof operation, 'string');
  assert.strictEqual(typeof primaryBlocker, 'string');
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-operator-recovery');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'unresolved');
  assert.strictEqual(decision.recoveryReady, false);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realOperatorRecoveryImplementationReady, false);
  assert.strictEqual(decision.wouldRecover, false);
  assert.strictEqual(decision.wouldRetry, false);
  assert.strictEqual(decision.wouldNotifyOperator, false);
  assert.strictEqual(decision.wouldRestartService, false);
  assert.strictEqual(decision.wouldRestoreState, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.remoteCommandAllowed, false);
  assert.strictEqual(decision.operatorNotificationAllowed, false);
  assert.strictEqual(decision.resolvedCount, 0);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.deepStrictEqual(decision.recoveries, []);
  assert.deepStrictEqual(decision.blockers, [primaryBlocker]);
  assert.strictEqual(decision.primaryBlocker, primaryBlocker);
  assert.deepStrictEqual(decision.nextBlockers, [primaryBlocker]);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
}

function assertRecoveryResolved(decision, operation) {
  const expected = OPERATION_EXPECTED_ACTION_IDS[operation];
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-operator-recovery');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'resolved');
  assert.strictEqual(decision.recoveryReady, true);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realOperatorRecoveryImplementationReady, false);
  assert.strictEqual(decision.wouldRecover, false);
  assert.strictEqual(decision.wouldRetry, false);
  assert.strictEqual(decision.wouldNotifyOperator, false);
  assert.strictEqual(decision.wouldRestartService, false);
  assert.strictEqual(decision.wouldRestoreState, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.remoteCommandAllowed, false);
  assert.strictEqual(decision.operatorNotificationAllowed, false);
  assert.strictEqual(decision.resolvedCount, expected.length);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.strictEqual(decision.primaryBlocker, null);
  assert.deepStrictEqual(decision.blockers, []);
  assert.deepStrictEqual(decision.nextBlockers, []);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.recoveries.length, expected.length);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  for (let i = 0; i < expected.length; i += 1) {
    const row = decision.recoveries[i];
    assert.strictEqual(row.actionId, expected[i]);
    assert.strictEqual(row.recoveryKind, CODE_OWNED_ACTION_RECOVERY_MAP[expected[i]]);
    assert.strictEqual(row.recoveryReady, true);
    assert.strictEqual(row.realOperatorRecoveryImplementationReady, false);
    assert.strictEqual(row.wouldRecover, false);
    assert.strictEqual(row.wouldRetry, false);
    assert.strictEqual(row.wouldNotifyOperator, false);
    assert.strictEqual(row.wouldRestartService, false);
    assert.strictEqual(row.wouldRestoreState, false);
    assert.strictEqual(row.wouldExecute, false);
    assert.strictEqual(row.wouldRun, false);
    assert.strictEqual(row.wouldWrite, false);
    assert.strictEqual(row.metadataWriteAllowed, false);
    assert.strictEqual(row.filesystemWriteAllowed, false);
    assert.strictEqual(row.remoteCommandAllowed, false);
    assert.strictEqual(row.operatorNotificationAllowed, false);
    assert.strictEqual(row.blockerCode, null);
    assert.strictEqual(row.evidenceCode, 'operator-recovery-plan-ready');
    assert.strictEqual(Object.hasOwn(row, 'codeOwnedResolverWired'), false);
  }
}

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
  it('buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness returns fixed ready contract', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness();
    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-host-mutation-adapter-readiness');
    assert.strictEqual(readiness.state, 'ready');
    assert.strictEqual(readiness.hostMutationAdapterDefined, true);
    assert.strictEqual(readiness.hostMutationAdapterReady, true);
    assert.strictEqual(readiness.codeOwnedAdapterResolverReady, true);
    assert.strictEqual(readiness.realHostMutationImplementationReady, false);
    assert.strictEqual(readiness.readyCount, 1);
    assert.strictEqual(readiness.blockedCount, 0);
    assert.deepStrictEqual(readiness.adapterEntries, EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES);
    assert.deepStrictEqual(readiness.blockers, []);
    assert.deepStrictEqual(readiness.nextBlockers, []);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });

  it('ignores all runtime-looking inputs and never leaks malicious material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness();
    const maliciousInput = {
      hostMutationAdapterReady: false,
      realHostMutationImplementationReady: true,
      adapterEntries: [
        {
          adapterKind: OPAQUE_UNSAFE_FIELD,
          wouldMutateHost: true,
          wouldRun: true,
          wouldWrite: true,
          OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
        },
      ],
      OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
    };

    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(null), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(), baseline);
    assert.doesNotMatch(JSON.stringify(baseline), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /disabled-host-mutation-adapter-stub|host-mutation-adapter-real-implementation-missing|host-mutation-adapter-missing/i,
    );
  });
});

describe('resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter', () => {
  it('H1: install happy path resolves restricted mutations without host side effects', () => {
    assertAdapterResolved(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(
        validAdapterCandidatesFor('install'),
        'install',
      ),
      'install',
    );
  });

  it('H2: uninstall happy path resolves restricted mutations', () => {
    assertAdapterResolved(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(
        validAdapterCandidatesFor('uninstall'),
        'uninstall',
      ),
      'uninstall',
    );
  });

  it('H3: rollback happy path resolves restricted mutations', () => {
    assertAdapterResolved(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(
        validAdapterCandidatesFor('rollback'),
        'rollback',
      ),
      'rollback',
    );
  });

  it('H4: recover happy path resolves recovery-supervisor-mutation only', () => {
    const decision = resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(
      validAdapterCandidatesFor('recover'),
      'recover',
    );
    assertAdapterResolved(decision, 'recover');
    assert.strictEqual(decision.mutations[0].mutationKind, 'recovery-supervisor-mutation');
  });

  it('H5: unknown action is host-mutation-adapter-action-unknown', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates[2] = validAdapterCandidate('start-recovery-supervisor', 1);
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-action-unknown',
      'install',
    );
  });

  it('H6: length < |E| with subset actionIds is missing (not candidates-invalid)', () => {
    const candidates = validAdapterCandidatesFor('install').slice(0, 2);
    assert.strictEqual(candidates.length, 2);
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-action-missing',
      'install',
    );
  });

  it('H7: duplicate actionId is host-mutation-adapter-action-duplicate', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates[1] = validAdapterCandidate('render-launch-agent-plist', 1);
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-action-duplicate',
      'install',
    );
  });

  it('H8: non-catalog implementationId still resolves (adapter ignores implementationId)', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates[0] = { ...candidates[0], implementationId: 'other-plist-impl' };
    assertAdapterResolved(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'install',
    );
  });

  it('H9: redacted maxAttempts still resolves (adapter ignores maxAttempts)', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates[0] = { ...candidates[0], maxAttempts: '[redacted]' };
    assertAdapterResolved(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'install',
    );
  });

  it('H10: wouldExecute true is host-mutation-adapter-unsafe-mutation', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldExecute: true };
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-unsafe-mutation',
      'install',
    );
  });

  it('H11: wouldRun true is host-mutation-adapter-unsafe-mutation', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldRun: true };
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-unsafe-mutation',
      'install',
    );
  });

  it('H12: wouldWrite true is host-mutation-adapter-unsafe-mutation', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldWrite: true };
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-unsafe-mutation',
      'install',
    );
  });

  it('H13: status not blocked is host-mutation-adapter-unsafe-mutation', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates[0] = { ...candidates[0], status: 'ready' };
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-unsafe-mutation',
      'install',
    );
  });

  it('H14: non-array candidates is host-mutation-adapter-candidates-invalid', () => {
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(null, 'install'),
      'host-mutation-adapter-candidates-invalid',
      'install',
    );
  });

  it('H15: empty candidates is host-mutation-adapter-candidates-invalid', () => {
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter([], 'install'),
      'host-mutation-adapter-candidates-invalid',
      'install',
    );
  });

  it('H16: missing exact key is host-mutation-adapter-candidates-invalid', () => {
    const candidates = validAdapterCandidatesFor('install');
    const { mode: _mode, ...rest } = candidates[0];
    candidates[0] = rest;
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-candidates-invalid',
      'install',
    );
  });

  for (const operation of ['nope', undefined, null, 0, 1, false, true]) {
    it(`H17: invalid operation ${String(operation)} is operation-invalid with decision.operation unknown`, () => {
      assertAdapterUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(
          validAdapterCandidatesFor('install'),
          operation,
        ),
        'host-mutation-adapter-operation-invalid',
        'unknown',
      );
    });
  }

  it('H18: getter trap on element is host-mutation-adapter-candidates-invalid', () => {
    const base = validAdapterCandidate('render-launch-agent-plist', 1);
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
    const candidates = [poisoned, ...validAdapterCandidatesFor('install').slice(1)];
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-candidates-invalid',
      'install',
    );
  });

  it('H19: Proxy element trap is host-mutation-adapter-candidates-invalid without secret leak', () => {
    const base = validAdapterCandidate('render-launch-agent-plist', 1);
    const trapped = new Proxy(base, {
      getOwnPropertyDescriptor() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });
    const candidates = [trapped, ...validAdapterCandidatesFor('install').slice(1)];
    const decision = resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install');
    assertAdapterUnresolvedExact(decision, 'host-mutation-adapter-candidates-invalid', 'install');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });

  it('H20: deep-copy isolation — input/output mutations do not affect subsequent resolve', () => {
    const candidates = validAdapterCandidatesFor('install');
    const first = resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install');
    assertAdapterResolved(first, 'install');
    candidates[0] = { ...candidates[0], actionId: 'start-recovery-supervisor' };
    first.operation = 'unknown';
    first.mutations.push({ actionId: OPAQUE_UNSAFE_FIELD });
    const second = resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(
      validAdapterCandidatesFor('install'),
      'install',
    );
    assertAdapterResolved(second, 'install');
    const third = resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install');
    assertAdapterUnresolvedExact(third, 'host-mutation-adapter-action-unknown', 'install');
  });

  it('H21: extra key is host-mutation-adapter-candidates-invalid', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates[0] = { ...candidates[0], mutationKind: 'render-plist-mutation' };
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-candidates-invalid',
      'install',
    );
  });

  for (const { label, actionId } of [
    { label: 'empty-string', actionId: '' },
    { label: 'number', actionId: 1 },
  ]) {
    it(`H22: ${label} actionId is candidates-invalid before set checks`, () => {
      const candidates = validAdapterCandidatesFor('install');
      candidates[0] = { ...candidates[0], actionId };
      assertAdapterUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
        'host-mutation-adapter-candidates-invalid',
        'install',
      );
    });
  }

  it('H23: length > |E| with foreign actionId is unknown (not candidates-invalid)', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates.push(validAdapterCandidate('start-recovery-supervisor', 1));
    assert.strictEqual(candidates.length, 4);
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-action-unknown',
      'install',
    );
  });

  it('H24: length > |E| with duplicate install actionId is duplicate (not candidates-invalid)', () => {
    const candidates = validAdapterCandidatesFor('install');
    candidates.push(validAdapterCandidate('render-launch-agent-plist', 1));
    assert.strictEqual(candidates.length, 4);
    assertAdapterUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'host-mutation-adapter-action-duplicate',
      'install',
    );
  });

  it('H25: sanitize remaps mutationKind mismatch to code-owned mapping (never passthrough)', () => {
    const FOREIGN_MUTATION_KIND = 'attacker-forced-mutation-kind';
    const resolved = resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(
      validAdapterCandidatesFor('install'),
      'install',
    );
    assertAdapterResolved(resolved, 'install');

    // Defense-in-depth: craft a resolved decision with wrong mutationKind strings.
    const poisoned = {
      ...resolved,
      mutations: resolved.mutations.map((row) => ({
        ...row,
        mutationKind: FOREIGN_MUTATION_KIND,
      })),
    };
    const sanitized = sanitizeHostMutationAdapterDecision(poisoned);
    assertAdapterResolved(sanitized, 'install');
    for (const row of sanitized.mutations) {
      assert.strictEqual(row.mutationKind, CODE_OWNED_ACTION_MUTATION_MAP[row.actionId]);
      assert.notStrictEqual(row.mutationKind, FOREIGN_MUTATION_KIND);
    }
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(FOREIGN_MUTATION_KIND, 'i'));

    // Unmapped actionId → safe unknown (still no passthrough of foreign kind).
    const unknownAction = sanitizeHostMutationAdapterDecision({
      ...resolved,
      mutations: [{
        actionId: 'not-a-catalog-action',
        mutationKind: FOREIGN_MUTATION_KIND,
        mutationReady: true,
        realHostMutationImplementationReady: false,
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
        evidenceCode: 'host-mutation-adapter-mutation-ready',
      }],
    });
    assert.strictEqual(unknownAction.state, 'resolved');
    assert.strictEqual(unknownAction.mutations[0].actionId, 'not-a-catalog-action');
    assert.strictEqual(unknownAction.mutations[0].mutationKind, 'unknown');
    assert.doesNotMatch(JSON.stringify(unknownAction), new RegExp(FOREIGN_MUTATION_KIND, 'i'));

    // Resolver happy-path output is unchanged through sanitize (identity of kinds).
    const resanitized = sanitizeHostMutationAdapterDecision(resolved);
    assertAdapterResolved(resanitized, 'install');
    assert.deepStrictEqual(
      resanitized.mutations.map((row) => row.mutationKind),
      resolved.mutations.map((row) => row.mutationKind),
    );
  });
});

describe('buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness', () => {
  it('OPERATION_EXPECTED_ACTION_IDS matches buildLifecycleActions via apply plan actions', () => {
    for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
      assert.deepStrictEqual(
        OPERATION_EXPECTED_ACTION_IDS[operation],
        buildSupervisorLifecycleApplyPlan({}, { operation }).actions.map((a) => a.id),
      );
    }
  });

  it('returns fixed ready pure data evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness();
    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-rollback-anchor-readiness');
    assert.strictEqual(readiness.state, 'ready');
    assert.strictEqual(readiness.rollbackAnchorDefined, true);
    assert.strictEqual(readiness.rollbackAnchorReady, true);
    assert.strictEqual(readiness.codeOwnedAnchorResolverReady, true);
    assert.strictEqual(readiness.realRollbackAnchorImplementationReady, false);
    assert.strictEqual(readiness.readyCount, 1);
    assert.strictEqual(readiness.blockedCount, 0);
    assert.deepStrictEqual(readiness.anchorEntries, EXPECTED_ROLLBACK_ANCHOR_ENTRIES);
    assert.deepStrictEqual(readiness.blockers, []);
    assert.deepStrictEqual(readiness.nextBlockers, []);
    assert.strictEqual(readiness.safety.sensitiveValuesReturned, false);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
    assert.strictEqual(Object.hasOwn(readiness, 'realRollbackAnchorReady'), false);
    assert.strictEqual(Object.hasOwn(readiness, 'realImplementationReady'), false);
    assert.strictEqual(Object.hasOwn(readiness, 'sensitiveValuesReturned'), false);
    const entry = readiness.anchorEntries[0];
    assert.strictEqual(Object.hasOwn(entry, 'realImplementationReady'), false);
    assert.strictEqual(Object.hasOwn(entry, 'sensitiveValuesReturned'), false);
    assert.strictEqual(Object.hasOwn(entry, 'realRollbackAnchorReady'), false);
    assert.strictEqual(entry.realRollbackAnchorImplementationReady, false);
  });

  it('ignores all runtime-looking inputs and never leaks malicious material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness();
    const maliciousInput = {
      rollbackAnchorReady: false,
      realRollbackAnchorImplementationReady: true,
      anchorEntries: [
        {
          anchorKind: UNSAFE_SECRET_MATERIAL,
          wouldWriteAnchor: true,
          wouldRestore: true,
          wouldRun: true,
          wouldWrite: true,
          OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
        },
      ],
      OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
    };
    assert.strictEqual(buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness.length, 0);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(null), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(), baseline);
    assert.doesNotMatch(JSON.stringify(baseline), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /disabled-rollback-anchor-stub|rollback-anchor-real-implementation-missing/i,
    );
  });
});


describe('resolveSupervisorLifecycleGuardedRunnerRollbackAnchor', () => {
  it('A1: install happy path resolves restricted anchors without write/restore side effects', () => {
    assertAnchorResolved(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(
        validAnchorCandidatesFor('install'),
        'install',
      ),
      'install',
    );
  });

  it('A2: uninstall happy path resolves restricted anchors', () => {
    assertAnchorResolved(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(
        validAnchorCandidatesFor('uninstall'),
        'uninstall',
      ),
      'uninstall',
    );
  });

  it('A3: rollback happy path resolves restricted anchors', () => {
    assertAnchorResolved(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(
        validAnchorCandidatesFor('rollback'),
        'rollback',
      ),
      'rollback',
    );
  });

  it('A4: recover happy path resolves recovery-supervisor-anchor only', () => {
    const decision = resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(
      validAnchorCandidatesFor('recover'),
      'recover',
    );
    assertAnchorResolved(decision, 'recover');
    assert.strictEqual(decision.anchors[0].anchorKind, 'recovery-supervisor-anchor');
  });

  it('A5: non-array / null candidates is rollback-anchor-candidates-invalid', () => {
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(null, 'install'),
      'rollback-anchor-candidates-invalid',
      'install',
    );
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor({ length: 1 }, 'install'),
      'rollback-anchor-candidates-invalid',
      'install',
    );
  });

  it('A6: install subset len=2 (valid shape) is rollback-anchor-action-missing', () => {
    const candidates = validAnchorCandidatesFor('install').slice(0, 2);
    assert.strictEqual(candidates.length, 2);
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-action-missing',
      'install',
    );
  });

  it('A7: empty array is rollback-anchor-candidates-invalid', () => {
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor([], 'install'),
      'rollback-anchor-candidates-invalid',
      'install',
    );
  });

  it('A8: extra own key on element is rollback-anchor-candidates-invalid', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates[0] = { ...candidates[0], anchorKind: 'render-plist-anchor' };
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-candidates-invalid',
      'install',
    );
  });

  it('A9: missing own key on element is rollback-anchor-candidates-invalid', () => {
    const candidates = validAnchorCandidatesFor('install');
    const { mode: _mode, ...rest } = candidates[0];
    candidates[0] = rest;
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-candidates-invalid',
      'install',
    );
  });

  it('A10: getter / accessor property is rollback-anchor-candidates-invalid', () => {
    const base = validAnchorCandidate('render-launch-agent-plist', 1);
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
    const candidates = [poisoned, ...validAnchorCandidatesFor('install').slice(1)];
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-candidates-invalid',
      'install',
    );
  });

  it('A11: Proxy trap throw on ownKeys is rollback-anchor-candidates-invalid without secret leak', () => {
    const base = validAnchorCandidate('render-launch-agent-plist', 1);
    const trapped = new Proxy(base, {
      ownKeys() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });
    const candidates = [trapped, ...validAnchorCandidatesFor('install').slice(1)];
    const decision = resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install');
    assertAnchorUnresolvedExact(decision, 'rollback-anchor-candidates-invalid', 'install');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });

  it('A12: wouldExecute true is rollback-anchor-unsafe-anchor', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldExecute: true };
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-unsafe-anchor',
      'install',
    );
  });

  it('A13: wouldRun true is rollback-anchor-unsafe-anchor', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldRun: true };
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-unsafe-anchor',
      'install',
    );
  });

  it('A14: wouldWrite true is rollback-anchor-unsafe-anchor', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldWrite: true };
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-unsafe-anchor',
      'install',
    );
  });

  it('A15: status !== blocked is rollback-anchor-unsafe-anchor', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates[0] = { ...candidates[0], status: 'ready' };
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-unsafe-anchor',
      'install',
    );
  });

  it('A16: non-empty string actionId unknown after shape ok is rollback-anchor-action-unknown', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates[2] = validAnchorCandidate('start-recovery-supervisor', 1);
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-action-unknown',
      'install',
    );
  });

  for (const operation of ['nope', undefined, null, 0, 1, false, true]) {
    it(`A17: invalid operation ${String(operation)} is operation-invalid with decision.operation unknown`, () => {
      assertAnchorUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(
          validAnchorCandidatesFor('install'),
          operation,
        ),
        'rollback-anchor-operation-invalid',
        'unknown',
      );
    });
  }

  it('A18: duplicate actionId is rollback-anchor-action-duplicate', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates[1] = validAnchorCandidate('render-launch-agent-plist', 1);
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-action-duplicate',
      'install',
    );
  });

  it('A19: non-catalog implementationId still resolved (anchor ignores implementationId)', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates[0] = { ...candidates[0], implementationId: 'other-plist-impl' };
    assertAnchorResolved(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'install',
    );
  });

  it('A20: maxAttempts [redacted] still resolved (anchor ignores maxAttempts)', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates[0] = { ...candidates[0], maxAttempts: '[redacted]' };
    assertAnchorResolved(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'install',
    );
  });

  it('A21: post-call input mutation does not change decision', () => {
    const candidates = validAnchorCandidatesFor('install');
    const first = resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install');
    assertAnchorResolved(first, 'install');
    const snapshot = JSON.stringify(first);
    candidates[0] = { ...candidates[0], actionId: 'start-recovery-supervisor' };
    assert.strictEqual(JSON.stringify(first), snapshot);
  });

  it('A22: returned decision mutation does not pollute next call', () => {
    const first = resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(
      validAnchorCandidatesFor('install'),
      'install',
    );
    assertAnchorResolved(first, 'install');
    first.operation = 'unknown';
    first.anchors.push({ actionId: OPAQUE_UNSAFE_FIELD });
    first.wouldWriteAnchor = true;
    const second = resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(
      validAnchorCandidatesFor('install'),
      'install',
    );
    assertAnchorResolved(second, 'install');
    assert.strictEqual(second.wouldWriteAnchor, false);
  });

  it('A23: len>|E| + unknown action (no dup) is rollback-anchor-action-unknown', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates.push(validAnchorCandidate('start-recovery-supervisor', 1));
    assert.strictEqual(candidates.length, 4);
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-action-unknown',
      'install',
    );
  });

  it('A24: len>|E| + duplicate is rollback-anchor-action-duplicate', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates.push(validAnchorCandidate('render-launch-agent-plist', 1));
    assert.strictEqual(candidates.length, 4);
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-action-duplicate',
      'install',
    );
  });

  for (const { label, actionId } of [
    { label: 'empty-string', actionId: '' },
    { label: 'number', actionId: 1 },
    { label: 'null', actionId: null },
  ]) {
    it(`A25: snapshot actionId ${label} is candidates-invalid only`, () => {
      const candidates = validAnchorCandidatesFor('install');
      candidates[0] = { ...candidates[0], actionId };
      assertAnchorUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
        'rollback-anchor-candidates-invalid',
        'install',
      );
    });
  }

  it('A26: primary priority — duplicate before unknown when both present', () => {
    const candidates = validAnchorCandidatesFor('install');
    candidates[1] = validAnchorCandidate('render-launch-agent-plist', 1);
    candidates.push(validAnchorCandidate('start-recovery-supervisor', 1));
    assertAnchorUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'rollback-anchor-action-duplicate',
      'install',
    );
  });

  it('A27: non-catalog + redacted — anchor resolved AND adapter resolved AND registry unresolved', () => {
    const candidates = validAnchorCandidatesFor('install').map((c, i) => (
      i === 0
        ? { ...c, implementationId: 'other-plist-impl', maxAttempts: '[redacted]' }
        : c
    ));
    assertAnchorResolved(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'install',
    );
    assertAdapterResolved(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'install',
    );
    assert.strictEqual(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install').state,
      'unresolved',
    );
  });

  it('sanitize remaps anchorKind mismatch to code-owned mapping (never passthrough)', () => {
    const FOREIGN_ANCHOR_KIND = 'attacker-forced-anchor-kind';
    const resolved = resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(
      validAnchorCandidatesFor('install'),
      'install',
    );
    assertAnchorResolved(resolved, 'install');
    const poisoned = {
      ...resolved,
      anchors: resolved.anchors.map((row) => ({
        ...row,
        anchorKind: FOREIGN_ANCHOR_KIND,
      })),
    };
    const sanitized = sanitizeRollbackAnchorDecision(poisoned);
    assertAnchorResolved(sanitized, 'install');
    for (const row of sanitized.anchors) {
      assert.strictEqual(row.anchorKind, CODE_OWNED_ACTION_ANCHOR_MAP[row.actionId]);
      assert.notStrictEqual(row.anchorKind, FOREIGN_ANCHOR_KIND);
    }
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(FOREIGN_ANCHOR_KIND, 'i'));
  });
});


describe('resolveSupervisorLifecycleGuardedRunnerAttemptAudit', () => {
  it('T1: install happy path resolves restricted audits without persist/log side effects', () => {
    assertAuditResolved(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(
        validAuditCandidatesFor('install'),
        'install',
      ),
      'install',
    );
  });

  it('T2: uninstall happy path resolves restricted audits', () => {
    assertAuditResolved(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(
        validAuditCandidatesFor('uninstall'),
        'uninstall',
      ),
      'uninstall',
    );
  });

  it('T3: rollback happy path resolves restricted audits', () => {
    assertAuditResolved(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(
        validAuditCandidatesFor('rollback'),
        'rollback',
      ),
      'rollback',
    );
  });

  it('T4: recover happy path resolves recovery-supervisor-attempt-audit only', () => {
    const decision = resolveSupervisorLifecycleGuardedRunnerAttemptAudit(
      validAuditCandidatesFor('recover'),
      'recover',
    );
    assertAuditResolved(decision, 'recover');
    assert.strictEqual(decision.audits[0].auditKind, 'recovery-supervisor-attempt-audit');
  });

  it('T5: non-array / null candidates is attempt-audit-candidates-invalid', () => {
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(null, 'install'),
      'attempt-audit-candidates-invalid',
      'install',
    );
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit({ length: 1 }, 'install'),
      'attempt-audit-candidates-invalid',
      'install',
    );
  });

  it('T6: install subset len=2 (valid shape) is attempt-audit-action-missing', () => {
    const candidates = validAuditCandidatesFor('install').slice(0, 2);
    assert.strictEqual(candidates.length, 2);
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-action-missing',
      'install',
    );
  });

  it('T7: empty array is attempt-audit-candidates-invalid', () => {
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit([], 'install'),
      'attempt-audit-candidates-invalid',
      'install',
    );
  });

  it('T8: extra own key on element is attempt-audit-candidates-invalid', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[0] = { ...candidates[0], auditKind: 'render-plist-attempt-audit' };
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-candidates-invalid',
      'install',
    );
  });

  it('T9: missing own key on element is attempt-audit-candidates-invalid', () => {
    const candidates = validAuditCandidatesFor('install');
    const { mode: _mode, ...rest } = candidates[0];
    candidates[0] = rest;
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-candidates-invalid',
      'install',
    );
  });

  it('T10: getter / accessor property is attempt-audit-candidates-invalid', () => {
    const base = validAuditCandidate('render-launch-agent-plist', 1);
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
    const candidates = [poisoned, ...validAuditCandidatesFor('install').slice(1)];
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-candidates-invalid',
      'install',
    );
  });

  it('T11: Proxy trap throw on ownKeys is attempt-audit-candidates-invalid without secret leak', () => {
    const base = validAuditCandidate('render-launch-agent-plist', 1);
    const trapped = new Proxy(base, {
      ownKeys() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });
    const candidates = [trapped, ...validAuditCandidatesFor('install').slice(1)];
    const decision = resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install');
    assertAuditUnresolvedExact(decision, 'attempt-audit-candidates-invalid', 'install');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });

  it('T12: wouldExecute true is attempt-audit-unsafe-audit', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldExecute: true };
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-unsafe-audit',
      'install',
    );
  });

  it('T13: wouldRun true is attempt-audit-unsafe-audit', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldRun: true };
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-unsafe-audit',
      'install',
    );
  });

  it('T14: wouldWrite true is attempt-audit-unsafe-audit', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldWrite: true };
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-unsafe-audit',
      'install',
    );
  });

  it('T15: status !== blocked is attempt-audit-unsafe-audit', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[0] = { ...candidates[0], status: 'ready' };
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-unsafe-audit',
      'install',
    );
  });

  it('T16: non-empty string actionId unknown after shape ok is attempt-audit-action-unknown', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[2] = validAuditCandidate('start-recovery-supervisor', 1);
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-action-unknown',
      'install',
    );
  });

  for (const operation of ['nope', undefined, null, 0, 1, false, true]) {
    it(`T17: invalid operation ${String(operation)} is operation-invalid with decision.operation unknown`, () => {
      assertAuditUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerAttemptAudit(
          validAuditCandidatesFor('install'),
          operation,
        ),
        'attempt-audit-operation-invalid',
        'unknown',
      );
    });
  }

  it('T18: duplicate actionId is attempt-audit-action-duplicate', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[1] = validAuditCandidate('render-launch-agent-plist', 1);
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-action-duplicate',
      'install',
    );
  });

  it('T19: non-catalog implementationId still resolved (audit ignores implementationId)', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[0] = { ...candidates[0], implementationId: 'other-plist-impl' };
    assertAuditResolved(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'install',
    );
  });

  it('T20: maxAttempts [redacted] still resolved (audit ignores maxAttempts)', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[0] = { ...candidates[0], maxAttempts: '[redacted]' };
    assertAuditResolved(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'install',
    );
  });

  it('T21: post-call input mutation does not change decision', () => {
    const candidates = validAuditCandidatesFor('install');
    const first = resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install');
    assertAuditResolved(first, 'install');
    const snapshot = JSON.stringify(first);
    candidates[0] = { ...candidates[0], actionId: 'start-recovery-supervisor' };
    assert.strictEqual(JSON.stringify(first), snapshot);
  });

  it('T22: returned decision mutation does not pollute next call', () => {
    const first = resolveSupervisorLifecycleGuardedRunnerAttemptAudit(
      validAuditCandidatesFor('install'),
      'install',
    );
    assertAuditResolved(first, 'install');
    first.operation = 'unknown';
    first.audits.push({ actionId: OPAQUE_UNSAFE_FIELD });
    first.wouldPersistAudit = true;
    const second = resolveSupervisorLifecycleGuardedRunnerAttemptAudit(
      validAuditCandidatesFor('install'),
      'install',
    );
    assertAuditResolved(second, 'install');
    assert.strictEqual(second.wouldPersistAudit, false);
  });

  it('T23: len>|E| + unknown action (no dup) is attempt-audit-action-unknown', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates.push(validAuditCandidate('start-recovery-supervisor', 1));
    assert.strictEqual(candidates.length, 4);
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-action-unknown',
      'install',
    );
  });

  it('T24: len>|E| + duplicate is attempt-audit-action-duplicate', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates.push(validAuditCandidate('render-launch-agent-plist', 1));
    assert.strictEqual(candidates.length, 4);
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-action-duplicate',
      'install',
    );
  });

  for (const { label, actionId } of [
    { label: 'empty-string', actionId: '' },
    { label: 'number', actionId: 1 },
    { label: 'null', actionId: null },
  ]) {
    it(`T25: snapshot actionId ${label} is candidates-invalid only`, () => {
      const candidates = validAuditCandidatesFor('install');
      candidates[0] = { ...candidates[0], actionId };
      assertAuditUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
        'attempt-audit-candidates-invalid',
        'install',
      );
    });
  }

  it('T26: primary priority — duplicate before unknown when both present', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[1] = validAuditCandidate('render-launch-agent-plist', 1);
    candidates.push(validAuditCandidate('start-recovery-supervisor', 1));
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-action-duplicate',
      'install',
    );
  });

  it('T27: non-catalog + redacted — audit resolved AND anchor resolved AND adapter resolved AND registry unresolved', () => {
    const candidates = validAuditCandidatesFor('install').map((c, i) => (
      i === 0
        ? { ...c, implementationId: 'other-plist-impl', maxAttempts: '[redacted]' }
        : c
    ));
    assertAuditResolved(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'install',
    );
    assertAnchorResolved(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'install',
    );
    assertAdapterResolved(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'install',
    );
    assert.strictEqual(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install').state,
      'unresolved',
    );
  });

  it('T28: duplicate actionId AND unsafe wouldExecute:true — primary is duplicate only', () => {
    const candidates = validAuditCandidatesFor('install');
    candidates[1] = validAuditCandidate('render-launch-agent-plist', 1);
    candidates[0] = { ...candidates[0], wouldExecute: true };
    assertAuditUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'attempt-audit-action-duplicate',
      'install',
    );
  });

  it('sanitize remaps auditKind mismatch to code-owned mapping (never passthrough)', () => {
    const FOREIGN_AUDIT_KIND = 'attacker-forced-audit-kind';
    const resolved = resolveSupervisorLifecycleGuardedRunnerAttemptAudit(
      validAuditCandidatesFor('install'),
      'install',
    );
    assertAuditResolved(resolved, 'install');
    const poisoned = {
      ...resolved,
      audits: resolved.audits.map((row) => ({
        ...row,
        auditKind: FOREIGN_AUDIT_KIND,
      })),
    };
    const sanitized = sanitizeAttemptAuditDecision(poisoned);
    assertAuditResolved(sanitized, 'install');
    for (const row of sanitized.audits) {
      assert.strictEqual(row.auditKind, CODE_OWNED_ACTION_AUDIT_MAP[row.actionId]);
      assert.notStrictEqual(row.auditKind, FOREIGN_AUDIT_KIND);
    }
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(FOREIGN_AUDIT_KIND, 'i'));
  });
});


describe('resolveSupervisorLifecycleGuardedRunnerOperatorRecovery', () => {
  it('T1: install happy path resolves restricted recoveries without side effects', () => {
    assertRecoveryResolved(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
        validRecoveryCandidatesFor('install'),
        'install',
      ),
      'install',
    );
  });

  it('T2: uninstall / rollback / recover happy paths resolve restricted recoveries', () => {
    for (const operation of ['uninstall', 'rollback', 'recover']) {
      assertRecoveryResolved(
        resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
          validRecoveryCandidatesFor(operation),
          operation,
        ),
        operation,
      );
    }
  });

  it('T3: OPERATION_EXPECTED_ACTION_IDS matches buildLifecycleActions via apply plan actions', () => {
    for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
      assert.deepStrictEqual(
        OPERATION_EXPECTED_ACTION_IDS[operation],
        buildSupervisorLifecycleApplyPlan({}, { operation }).actions.map((a) => a.id),
      );
    }
  });

  for (const operation of ['nope', undefined, null, 0, 1, false, true]) {
    it(`T4: invalid operation ${String(operation)} is operation-invalid with decision.operation unknown`, () => {
      assertRecoveryUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
          validRecoveryCandidatesFor('install'),
          operation,
        ),
        'operator-recovery-operation-invalid',
        'unknown',
      );
    });
  }

  it('T5: non-array / null candidates is operator-recovery-candidates-invalid', () => {
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(null, 'install'),
      'operator-recovery-candidates-invalid',
      'install',
    );
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery({ length: 1 }, 'install'),
      'operator-recovery-candidates-invalid',
      'install',
    );
  });

  it('T6: empty array is operator-recovery-candidates-invalid', () => {
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery([], 'install'),
      'operator-recovery-candidates-invalid',
      'install',
    );
  });

  it('T7: install subset len=2 (valid shape) is operator-recovery-action-missing', () => {
    const candidates = validRecoveryCandidatesFor('install').slice(0, 2);
    assert.strictEqual(candidates.length, 2);
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
      'operator-recovery-action-missing',
      'install',
    );
  });

  it('T8: install + foreign start-recovery-supervisor (len 4 no dup) is action-unknown', () => {
    const candidates = validRecoveryCandidatesFor('install');
    candidates.push(validRecoveryCandidate('start-recovery-supervisor', 1));
    assert.strictEqual(candidates.length, 4);
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
      'operator-recovery-action-unknown',
      'install',
    );
  });

  it('T9: install + duplicate render (len 4) is action-duplicate', () => {
    const candidates = validRecoveryCandidatesFor('install');
    candidates.push(validRecoveryCandidate('render-launch-agent-plist', 1));
    assert.strictEqual(candidates.length, 4);
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
      'operator-recovery-action-duplicate',
      'install',
    );
  });

  for (const { label, actionId } of [
    { label: 'empty-string', actionId: '' },
    { label: 'number', actionId: 1 },
    { label: 'object', actionId: {} },
  ]) {
    it(`T10: snapshot actionId ${label} is candidates-invalid only`, () => {
      const candidates = validRecoveryCandidatesFor('install');
      candidates[0] = { ...candidates[0], actionId };
      assertRecoveryUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
        'operator-recovery-candidates-invalid',
        'install',
      );
    });
  }

  it('T11: extra key / missing key / prototype pollution key is candidates-invalid', () => {
    const extra = validRecoveryCandidatesFor('install');
    extra[0] = { ...extra[0], recoveryKind: 'render-plist-operator-recovery' };
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(extra, 'install'),
      'operator-recovery-candidates-invalid',
      'install',
    );
    const missing = validRecoveryCandidatesFor('install');
    const { mode: _mode, ...rest } = missing[0];
    missing[0] = rest;
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(missing, 'install'),
      'operator-recovery-candidates-invalid',
      'install',
    );
    const polluted = validRecoveryCandidatesFor('install');
    polluted[0] = { ...polluted[0], __proto__: { polluted: true } };
    // exact-key snapshot rejects extra enumerable own keys if present; also plain assign may not add __proto__ own key
    const withProtoKey = validRecoveryCandidatesFor('install');
    withProtoKey[0] = Object.assign(Object.create(null), withProtoKey[0], { ['__proto__']: { x: 1 } });
    // if Object.assign with __proto__ string key creates own key, reject; otherwise skip soft
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
        (() => {
          const c = validRecoveryCandidatesFor('install');
          c[0] = { ...c[0], constructor: Object };
          return c;
        })(),
        'install',
      ),
      'operator-recovery-candidates-invalid',
      'install',
    );
  });

  it('T12: getter / accessor property is candidates-invalid', () => {
    const base = validRecoveryCandidate('render-launch-agent-plist', 1);
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
    const candidates = [poisoned, ...validRecoveryCandidatesFor('install').slice(1)];
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
      'operator-recovery-candidates-invalid',
      'install',
    );
  });

  it('T13: Proxy trap throw on ownKeys is candidates-invalid without secret leak', () => {
    const base = validRecoveryCandidate('render-launch-agent-plist', 1);
    const trapped = new Proxy(base, {
      ownKeys() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });
    const candidates = [trapped, ...validRecoveryCandidatesFor('install').slice(1)];
    const decision = resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install');
    assertRecoveryUnresolvedExact(decision, 'operator-recovery-candidates-invalid', 'install');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });

  it('T14: status !== blocked is operator-recovery-unsafe-recovery', () => {
    const candidates = validRecoveryCandidatesFor('install');
    candidates[0] = { ...candidates[0], status: 'ready' };
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
      'operator-recovery-unsafe-recovery',
      'install',
    );
  });

  it('T15: wouldExecute/wouldRun/wouldWrite true is unsafe-recovery', () => {
    for (const flag of ['wouldExecute', 'wouldRun', 'wouldWrite']) {
      const candidates = validRecoveryCandidatesFor('install');
      candidates[0] = { ...candidates[0], [flag]: true };
      assertRecoveryUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
        'operator-recovery-unsafe-recovery',
        'install',
      );
    }
  });

  it('T16: non-catalog implementationId still resolved (recovery ignores implementationId)', () => {
    const candidates = validRecoveryCandidatesFor('install');
    candidates[0] = { ...candidates[0], implementationId: 'other-plist-impl' };
    assertRecoveryResolved(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
      'install',
    );
  });

  it('T17: maxAttempts [redacted] still resolved (recovery ignores maxAttempts)', () => {
    const candidates = validRecoveryCandidatesFor('install');
    candidates[0] = { ...candidates[0], maxAttempts: '[redacted]' };
    assertRecoveryResolved(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
      'install',
    );
  });

  it('T18: duplicate before unsafe when both present', () => {
    const candidates = validRecoveryCandidatesFor('install');
    candidates[1] = validRecoveryCandidate('render-launch-agent-plist', 1);
    candidates[0] = { ...candidates[0], wouldExecute: true };
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
      'operator-recovery-action-duplicate',
      'install',
    );
  });

  it('T19: post-call input mutation does not change decision', () => {
    const candidates = validRecoveryCandidatesFor('install');
    const first = resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install');
    assertRecoveryResolved(first, 'install');
    const snapshot = JSON.stringify(first);
    candidates[0] = { ...candidates[0], actionId: 'start-recovery-supervisor' };
    assert.strictEqual(JSON.stringify(first), snapshot);
  });

  it('T20: returned decision mutation does not pollute next call', () => {
    const first = resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
      validRecoveryCandidatesFor('install'),
      'install',
    );
    assertRecoveryResolved(first, 'install');
    first.operation = 'unknown';
    first.recoveries.push({ actionId: OPAQUE_UNSAFE_FIELD });
    first.wouldRecover = true;
    const second = resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
      validRecoveryCandidatesFor('install'),
      'install',
    );
    assertRecoveryResolved(second, 'install');
    assert.strictEqual(second.wouldRecover, false);
  });

  it('T21/T22: readiness builder fixed ready + ignores args covered in readiness describe', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness();
    assert.strictEqual(readiness.state, 'ready');
    assert.deepStrictEqual(readiness.recoveryEntries, EXPECTED_OPERATOR_RECOVERY_ENTRIES);
  });

  it('T23: old keys absent on readiness and entry', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness();
    assert.strictEqual(Object.hasOwn(readiness, 'realOperatorRecoveryReady'), false);
    assert.strictEqual(Object.hasOwn(readiness.recoveryEntries[0], 'realImplementationReady'), false);
    assert.strictEqual(Object.hasOwn(readiness.recoveryEntries[0], 'sensitiveValuesReturned'), false);
    assert.strictEqual(Object.hasOwn(readiness.recoveryEntries[0], 'failureRecoveryReady'), false);
    assert.strictEqual(Object.hasOwn(readiness.recoveryEntries[0], 'retryLimitReady'), false);
    assert.strictEqual(Object.hasOwn(readiness.recoveryEntries[0], 'operatorRunbookReady'), false);
  });

  it('T24/T25: wiring contract fixture 6/0 ready contracts with aggregate still blocked', () => {
    const contract = buildSupervisorLifecycleGuardedRunnerWiringContract();
    assertWiringContract(contract);
    assert.strictEqual(contract.operatorRecoveryReadiness.state, 'ready');
    assert.strictEqual(contract.operatorRecoveryReadiness.realOperatorRecoveryImplementationReady, false);
  });

  it('T26: recoveryKind outputs are allowlisted; input recoveryKind key invalidates candidates', () => {
    const OPERATOR_RECOVERY_KIND_ALLOWLIST = Object.freeze([
      'render-plist-operator-recovery',
      'write-plist-operator-recovery',
      'load-agent-operator-recovery',
      'unload-agent-operator-recovery',
      'remove-plist-operator-recovery',
      'remove-metadata-operator-recovery',
      'capture-state-operator-recovery',
      'restore-plist-operator-recovery',
      'restart-supervisor-operator-recovery',
      'recovery-supervisor-operator-recovery',
    ]);
    const decision = resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
      validRecoveryCandidatesFor('install'),
      'install',
    );
    assertRecoveryResolved(decision, 'install');
    for (const row of decision.recoveries) {
      assert.ok(Object.values(CODE_OWNED_ACTION_RECOVERY_MAP).includes(row.recoveryKind));
      assert.ok(
        OPERATOR_RECOVERY_KIND_ALLOWLIST.includes(row.recoveryKind),
        `recoveryKind ${row.recoveryKind} must be ∈ OPERATOR_RECOVERY_KIND_ALLOWLIST`,
      );
    }
    // Map values must be an exact set-equal subset of the allowlist (code-owned consistency).
    const mapValues = [...new Set(Object.values(CODE_OWNED_ACTION_RECOVERY_MAP))].sort();
    const allowlistSorted = [...OPERATOR_RECOVERY_KIND_ALLOWLIST].sort();
    assert.deepStrictEqual(mapValues, allowlistSorted);
    const candidates = validRecoveryCandidatesFor('install');
    candidates[0] = { ...candidates[0], recoveryKind: 'render-plist-operator-recovery' };
    assertRecoveryUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
      'operator-recovery-candidates-invalid',
      'install',
    );
  });

  it('T27: layered — valid candidates resolve registry/adapter/anchor/audit/recovery independently', () => {
    const candidates = validRecoveryCandidatesFor('install');
    assertRecoveryResolved(
      resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, 'install'),
      'install',
    );
    assertAuditResolved(
      resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, 'install'),
      'install',
    );
    assertAnchorResolved(
      resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, 'install'),
      'install',
    );
    assertAdapterResolved(
      resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, 'install'),
      'install',
    );
    assert.strictEqual(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install').state,
      'resolved',
    );
  });

  it('T28: safety deepStrictEqual executionPreviewSafety shape', () => {
    const decision = resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
      validRecoveryCandidatesFor('install'),
      'install',
    );
    assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });

  it('sanitize remaps recoveryKind mismatch to code-owned mapping (never passthrough)', () => {
    const FOREIGN_RECOVERY_KIND = 'attacker-forced-recovery-kind';
    const resolved = resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
      validRecoveryCandidatesFor('install'),
      'install',
    );
    assertRecoveryResolved(resolved, 'install');
    const poisoned = {
      ...resolved,
      recoveries: resolved.recoveries.map((row) => ({
        ...row,
        recoveryKind: FOREIGN_RECOVERY_KIND,
      })),
    };
    const sanitized = sanitizeOperatorRecoveryDecision(poisoned);
    assertRecoveryResolved(sanitized, 'install');
    for (const row of sanitized.recoveries) {
      assert.strictEqual(row.recoveryKind, CODE_OWNED_ACTION_RECOVERY_MAP[row.actionId]);
      assert.notStrictEqual(row.recoveryKind, FOREIGN_RECOVERY_KIND);
    }
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(FOREIGN_RECOVERY_KIND, 'i'));
  });

  it('sanitize fail-closes when recovery row actionId has no allowlisted code-owned mapping', () => {
    const resolved = resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
      validRecoveryCandidatesFor('install'),
      'install',
    );
    assertRecoveryResolved(resolved, 'install');
    const unmapped = {
      ...resolved,
      recoveries: [
        {
          ...resolved.recoveries[0],
          actionId: 'not-a-lifecycle-action',
          recoveryKind: 'render-plist-operator-recovery',
        },
      ],
    };
    const sanitized = sanitizeOperatorRecoveryDecision(unmapped);
    assert.strictEqual(sanitized.state, 'unresolved');
    assert.strictEqual(sanitized.recoveryReady, false);
    assert.strictEqual(sanitized.primaryBlocker, 'operator-recovery-candidates-invalid');
    assert.deepStrictEqual(sanitized.recoveries, []);
    assert.doesNotMatch(JSON.stringify(sanitized), /not-a-lifecycle-action/);
  });
});

describe('buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness', () => {
  it('OPERATION_EXPECTED_ACTION_IDS matches buildLifecycleActions via apply plan actions', () => {
    for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
      assert.deepStrictEqual(
        OPERATION_EXPECTED_ACTION_IDS[operation],
        buildSupervisorLifecycleApplyPlan({}, { operation }).actions.map((a) => a.id),
      );
    }
  });

  it('returns fixed ready pure data evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness();
    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-attempt-audit-readiness');
    assert.strictEqual(readiness.state, 'ready');
    assert.strictEqual(readiness.attemptAuditDefined, true);
    assert.strictEqual(readiness.attemptAuditReady, true);
    assert.strictEqual(readiness.codeOwnedAuditResolverReady, true);
    assert.strictEqual(readiness.realAttemptAuditImplementationReady, false);
    assert.strictEqual(readiness.readyCount, 1);
    assert.strictEqual(readiness.blockedCount, 0);
    assert.deepStrictEqual(readiness.auditEntries, EXPECTED_ATTEMPT_AUDIT_ENTRIES);
    assert.deepStrictEqual(readiness.blockers, []);
    assert.deepStrictEqual(readiness.nextBlockers, []);
    assert.strictEqual(readiness.safety.sensitiveValuesReturned, false);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
    assert.strictEqual(Object.hasOwn(readiness, 'realAttemptAuditReady'), false);
    assert.strictEqual(Object.hasOwn(readiness, 'realImplementationReady'), false);
    assert.strictEqual(Object.hasOwn(readiness, 'sensitiveValuesReturned'), false);
    const entry = readiness.auditEntries[0];
    assert.strictEqual(Object.hasOwn(entry, 'realImplementationReady'), false);
    assert.strictEqual(Object.hasOwn(entry, 'sensitiveValuesReturned'), false);
    assert.strictEqual(Object.hasOwn(entry, 'realAttemptAuditReady'), false);
    assert.strictEqual(entry.realAttemptAuditImplementationReady, false);
    assert.strictEqual(entry.wouldPersistAudit, false);
    assert.strictEqual(entry.wouldWriteLog, false);
    assert.strictEqual(entry.immutableAuditReady, false);
  });

  it('ignores all runtime-looking inputs and never leaks malicious material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness();
    const maliciousInput = {
      attemptAuditReady: false,
      realAttemptAuditImplementationReady: true,
      auditEntries: [
        {
          auditKind: UNSAFE_SECRET_MATERIAL,
          wouldPersistAudit: true,
          wouldWriteLog: true,
          wouldWriteAudit: true,
          wouldRun: true,
          wouldWrite: true,
          OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
        },
      ],
      OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
    };
    assert.strictEqual(buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness.length, 0);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness(null), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness(), baseline);
    assert.doesNotMatch(JSON.stringify(baseline), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /disabled-attempt-audit-stub|attempt-audit-real-implementation-missing/i,
    );
  });
});

describe('buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness', () => {
  it('returns fixed ready pure data operator-recovery evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness();

    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-operator-recovery-readiness');
    assert.strictEqual(readiness.state, 'ready');
    assert.strictEqual(readiness.operatorRecoveryDefined, true);
    assert.strictEqual(readiness.operatorRecoveryReady, true);
    assert.strictEqual(readiness.codeOwnedRecoveryResolverReady, true);
    assert.strictEqual(readiness.realOperatorRecoveryImplementationReady, false);
    assert.strictEqual(readiness.readyCount, 1);
    assert.strictEqual(readiness.blockedCount, 0);
    assert.deepStrictEqual(readiness.blockers, []);
    assert.deepStrictEqual(readiness.nextBlockers, []);
    assert.deepStrictEqual(readiness.recoveryEntries, EXPECTED_OPERATOR_RECOVERY_ENTRIES);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
    assert.strictEqual(Object.hasOwn(readiness, 'realOperatorRecoveryReady'), false);
    assert.strictEqual(Object.hasOwn(readiness, 'realImplementationReady'), false);
    assert.strictEqual(Object.hasOwn(readiness, 'sensitiveValuesReturned'), false);
    assert.strictEqual(Object.hasOwn(readiness, 'failureRecoveryReady'), false);
    assert.strictEqual(Object.hasOwn(readiness, 'retryLimitReady'), false);
    assert.strictEqual(Object.hasOwn(readiness, 'operatorRunbookReady'), false);
    const entry = readiness.recoveryEntries[0];
    assert.strictEqual(Object.hasOwn(entry, 'realImplementationReady'), false);
    assert.strictEqual(Object.hasOwn(entry, 'sensitiveValuesReturned'), false);
    assert.strictEqual(Object.hasOwn(entry, 'failureRecoveryReady'), false);
    assert.strictEqual(Object.hasOwn(entry, 'retryLimitReady'), false);
    assert.strictEqual(Object.hasOwn(entry, 'operatorRunbookReady'), false);
    assert.strictEqual(entry.realOperatorRecoveryImplementationReady, false);
    assert.strictEqual(entry.wouldRecover, false);
    assert.strictEqual(entry.wouldRestartService, false);
    assert.strictEqual(entry.wouldRestoreState, false);
  });

  it('ignores all runtime-looking inputs and never leaks malicious recovery material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness();
    const maliciousInput = {
      operatorRecoveryReady: false,
      realOperatorRecoveryImplementationReady: true,
      recoveryEntries: [
        {
          recoveryKind: UNSAFE_SECRET_MATERIAL,
          wouldRecover: true,
          wouldRetry: true,
          wouldRestartService: true,
          wouldRestoreState: true,
          wouldRun: true,
          wouldWrite: true,
          OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
        },
      ],
      OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
    };

    assert.strictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness.length, 0);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(null), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(), baseline);
    assert.doesNotMatch(JSON.stringify(baseline), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /disabled-operator-recovery-stub|operator-recovery-real-implementation-missing/i,
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
  it('G2: ready install + executeRequested:false still resolves registry and adapter facts true', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: false });

    assertAlwaysBlockedGate(result, {
      runnerRegistryReady: true,
      hostMutationAdapterReady: true,
      rollbackAnchorReady: true,
      attemptAuditReady: true,
    operatorRecoveryReady: true,
    });
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
      hostMutationAdapterReady: true,
      rollbackAnchorReady: true,
      attemptAuditReady: true,
      operatorRecoveryReady: true,
      pureWiringOrchestratorPlanReady: false,
    });
    assert.strictEqual(result.registryDecision.state, 'resolved');
    assert.strictEqual(result.adapterDecision.state, 'resolved');
    assert.strictEqual(result.adapterDecision.adapterReady, true);
    assert.strictEqual(result.anchorDecision.state, 'resolved');
    assert.strictEqual(result.anchorDecision.anchorReady, true);
    assert.strictEqual(result.auditDecision.state, 'resolved');
    assert.strictEqual(result.auditDecision.auditReady, true);
    assert.strictEqual(result.recoveryDecision.state, 'resolved');
    assert.strictEqual(result.recoveryDecision.recoveryReady, true);
    assert.ok(result.policyDecision.blockers.includes('execute-request-missing'));
    assert.ok(!result.policyDecision.blockers.includes('operator-recovery-not-ready'));
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

  it('G1/G6/G7: production ready inputs resolve all pure contracts; policy authorized; execution still blocked by real wiring', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });

    assertAlwaysBlockedGate(result, {
      runnerRegistryReady: true,
      hostMutationAdapterReady: true,
      rollbackAnchorReady: true,
      attemptAuditReady: true,
      operatorRecoveryReady: true,
    });
    assert.ok(!result.blockers.includes('execute-request-missing'));
    assert.deepStrictEqual(result.blockers, ['real-guarded-runner-execution-wiring-missing']);
    assert.strictEqual(result.gates.executeRequested, true);
    assert.strictEqual(result.gates.actionCandidatesReady, true);
    assert.strictEqual(result.gates.executionPolicyReady, true);
    assert.strictEqual(result.gates.runnerRegistryReady, true);
    assert.strictEqual(result.gates.hostMutationAdapterReady, true);
    assert.strictEqual(result.gates.rollbackAnchorReady, true);
    assert.strictEqual(result.gates.attemptAuditReady, true);
    assert.strictEqual(result.gates.operatorRecoveryReady, true);
    assert.strictEqual(result.registryDecision.state, 'resolved');
    assert.strictEqual(result.registryDecision.registryReady, true);
    assert.strictEqual(result.registryDecision.codeOwnedResolverWired, true);
    assert.strictEqual(result.registryDecision.realHostRunnerReady, false);
    assert.strictEqual(result.registryDecision.wouldExecute, false);
    assert.strictEqual(result.registryDecision.wouldRun, false);
    assert.strictEqual(result.registryDecision.wouldWrite, false);
    assert.strictEqual(result.adapterDecision.state, 'resolved');
    assert.strictEqual(result.adapterDecision.adapterReady, true);
    assert.strictEqual(result.adapterDecision.codeOwnedResolverWired, true);
    assert.strictEqual(result.adapterDecision.realHostMutationImplementationReady, false);
    assert.strictEqual(result.adapterDecision.wouldMutateHost, false);
    assert.strictEqual(result.adapterDecision.wouldExecute, false);
    assert.strictEqual(result.adapterDecision.wouldRun, false);
    assert.strictEqual(result.adapterDecision.wouldWrite, false);
    assert.strictEqual(result.adapterDecision.launchctlAllowed, false);
    assert.strictEqual(result.adapterDecision.filesystemWriteAllowed, false);
    assert.strictEqual(result.adapterDecision.processListReadAllowed, false);
    assert.strictEqual(result.adapterDecision.metadataWriteAllowed, false);
    assert.strictEqual(result.adapterDecision.auditWriteAllowed, false);
    assert.strictEqual(result.adapterDecision.rollbackAnchorWriteAllowed, false);
    assert.strictEqual(result.anchorDecision.state, 'resolved');
    assert.strictEqual(result.anchorDecision.anchorReady, true);
    assert.strictEqual(result.anchorDecision.codeOwnedResolverWired, true);
    assert.strictEqual(result.anchorDecision.realRollbackAnchorImplementationReady, false);
    assert.strictEqual(result.anchorDecision.wouldWriteAnchor, false);
    assert.strictEqual(result.anchorDecision.wouldRestore, false);
    assert.strictEqual(result.auditDecision.state, 'resolved');
    assert.strictEqual(result.auditDecision.auditReady, true);
    assert.strictEqual(result.auditDecision.codeOwnedResolverWired, true);
    assert.strictEqual(result.auditDecision.realAttemptAuditImplementationReady, false);
    assert.strictEqual(result.auditDecision.wouldPersistAudit, false);
    assert.strictEqual(result.auditDecision.wouldWriteLog, false);
    assert.strictEqual(result.auditDecision.wouldWriteAudit, false);
    assert.strictEqual(result.recoveryDecision.state, 'resolved');
    assert.strictEqual(result.recoveryDecision.recoveryReady, true);
    assert.strictEqual(result.recoveryDecision.codeOwnedResolverWired, true);
    assert.strictEqual(result.recoveryDecision.realOperatorRecoveryImplementationReady, false);
    assert.strictEqual(result.recoveryDecision.wouldRecover, false);
    assert.strictEqual(result.recoveryDecision.wouldRestartService, false);
    assert.strictEqual(result.recoveryDecision.wouldRestoreState, false);
    assert.strictEqual(result.gates.realRunnerWiringReady, false);
    assert.strictEqual(result.gates.runnerWiringContractReady, false);
    assert.strictEqual(result.policyDecision.state, 'authorized');
    assert.strictEqual(result.policyDecision.authorized, true);
    assert.strictEqual(result.policyDecision.wouldAuthorizeExecution, true);
    assert.strictEqual(result.policyDecision.primaryBlocker, null);
    assert.deepStrictEqual(result.policyDecision.blockers, []);
    assert.strictEqual(result.policyDecision.wouldRun, false);
    assert.strictEqual(result.policyDecision.wouldWrite, false);
    assert.ok(!result.policyDecision.blockers.includes('operator-recovery-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('attempt-audit-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('rollback-anchor-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('host-mutation-adapter-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('runner-registry-not-ready'));
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    for (const c of result.actionCandidates) {
      assert.strictEqual(c.wouldExecute, false);
      assert.strictEqual(c.wouldRun, false);
      assert.strictEqual(c.wouldWrite, false);
    }
    assertWiringContract(result.runnerWiringContract);
    assert.strictEqual(result.runnerWiringContract.readyCount, 6);
    assert.strictEqual(result.runnerWiringContract.blockedCount, 0);

    const pureRegistry = resolveSupervisorLifecycleGuardedRunnerRegistry(result.actionCandidates, 'install');
    assert.strictEqual(result.registryDecision.state, pureRegistry.state);
    const pureAdapter = resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(
      result.actionCandidates,
      'install',
    );
    assert.strictEqual(result.adapterDecision.state, pureAdapter.state);
    assert.strictEqual(result.adapterDecision.adapterReady, pureAdapter.adapterReady);
    assert.deepStrictEqual(
      result.adapterDecision.mutations.map((row) => row.actionId),
      pureAdapter.mutations.map((row) => row.actionId),
    );
    const pureAnchor = resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(
      result.actionCandidates,
      'install',
    );
    assert.strictEqual(result.anchorDecision.state, pureAnchor.state);
    assert.strictEqual(result.anchorDecision.anchorReady, pureAnchor.anchorReady);
    assert.deepStrictEqual(
      result.anchorDecision.anchors.map((row) => row.actionId),
      pureAnchor.anchors.map((row) => row.actionId),
    );
    const pureAudit = resolveSupervisorLifecycleGuardedRunnerAttemptAudit(
      result.actionCandidates,
      'install',
    );
    assert.strictEqual(result.auditDecision.state, pureAudit.state);
    assert.strictEqual(result.auditDecision.auditReady, pureAudit.auditReady);
    assert.deepStrictEqual(
      result.auditDecision.audits.map((row) => row.actionId),
      pureAudit.audits.map((row) => row.actionId),
    );
    const pureRecovery = resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(
      result.actionCandidates,
      'install',
    );
    assert.strictEqual(result.recoveryDecision.state, pureRecovery.state);
    assert.strictEqual(result.recoveryDecision.recoveryReady, pureRecovery.recoveryReady);
    assert.deepStrictEqual(
      result.recoveryDecision.recoveries.map((row) => row.actionId),
      pureRecovery.recoveries.map((row) => row.actionId),
    );
  });

  it('G3: empty candidates path keeps registry/adapter/anchor/audit/recovery not ready', () => {
    const notVerifiedInputs = getReadyInputs();
    notVerifiedInputs.executionPreview = {
      ...notVerifiedInputs.executionPreview,
      actionPreviews: notVerifiedInputs.executionPreview.actionPreviews.map((entry, index) => (
        index === 0 ? { ...entry, wouldExecute: true } : entry
      )),
    };
    const result = buildGate(notVerifiedInputs, { executeRequested: true });
    assertAlwaysBlockedGate(result, {
      runnerRegistryReady: false,
      hostMutationAdapterReady: false,
      rollbackAnchorReady: false,
      attemptAuditReady: false,
    operatorRecoveryReady: false,
    });
    assert.deepStrictEqual(result.actionCandidates, []);
    assert.strictEqual(result.registryDecision.state, 'unresolved');
    assert.strictEqual(result.registryDecision.primaryBlocker, 'runner-registry-candidates-invalid');
    assert.strictEqual(result.adapterDecision.state, 'unresolved');
    assert.strictEqual(result.adapterDecision.primaryBlocker, 'host-mutation-adapter-candidates-invalid');
    assert.strictEqual(result.anchorDecision.state, 'unresolved');
    assert.strictEqual(result.anchorDecision.primaryBlocker, 'rollback-anchor-candidates-invalid');
    assert.strictEqual(result.auditDecision.state, 'unresolved');
    assert.strictEqual(result.auditDecision.primaryBlocker, 'attempt-audit-candidates-invalid');
    assert.strictEqual(result.recoveryDecision.state, 'unresolved');
    assert.strictEqual(result.recoveryDecision.primaryBlocker, 'operator-recovery-candidates-invalid');
    assert.ok(result.policyDecision.blockers.includes('runner-registry-not-ready'));
    assert.ok(result.policyDecision.blockers.includes('host-mutation-adapter-not-ready'));
    assert.ok(result.policyDecision.blockers.includes('rollback-anchor-not-ready'));
    assert.ok(result.policyDecision.blockers.includes('attempt-audit-not-ready'));
    assert.ok(result.policyDecision.blockers.includes('operator-recovery-not-ready'));
  });

  it('G6/G8: ignores forged registry/adapter/anchor/audit/recovery overrides on options', () => {
    const result = buildGate(getReadyInputs(), {
      executeRequested: true,
      registryDecision: {
        state: 'unresolved',
        registryReady: false,
        primaryBlocker: 'runner-registry-candidates-invalid',
      },
      runnerRegistryReady: false,
      registryContext: { runnerRegistryReady: false },
      adapterDecision: {
        state: 'unresolved',
        adapterReady: false,
        wouldMutateHost: true,
        launchctlAllowed: true,
      },
      hostMutationAdapterReady: false,
      adapterContext: { hostMutationAdapterReady: true },
      anchorDecision: {
        state: 'unresolved',
        anchorReady: false,
        wouldWriteAnchor: true,
        wouldRestore: true,
      },
      rollbackAnchorReady: false,
      anchorContext: { rollbackAnchorReady: true },
      auditDecision: {
        state: 'unresolved',
        auditReady: false,
        wouldPersistAudit: true,
        wouldWriteLog: true,
      },
      attemptAuditReady: false,
      auditContext: { attemptAuditReady: true },
      recoveryDecision: {
        state: 'unresolved',
        recoveryReady: false,
        wouldRecover: true,
        wouldRestartService: true,
      },
      operatorRecoveryReady: false,
      recoveryContext: { operatorRecoveryReady: true },
      policyContext: buildAllTruePolicyContext(),
      policyDecision: {
        state: 'authorized',
        authorized: true,
        wouldAuthorizeExecution: true,
        wouldRun: true,
      },
    });
    assertAlwaysBlockedGate(result, {
      runnerRegistryReady: true,
      hostMutationAdapterReady: true,
      rollbackAnchorReady: true,
      attemptAuditReady: true,
      operatorRecoveryReady: true,
    });
    assert.strictEqual(result.registryDecision.state, 'resolved');
    assert.strictEqual(result.adapterDecision.state, 'resolved');
    assert.strictEqual(result.adapterDecision.wouldMutateHost, false);
    assert.strictEqual(result.adapterDecision.launchctlAllowed, false);
    assert.strictEqual(result.anchorDecision.state, 'resolved');
    assert.strictEqual(result.anchorDecision.wouldWriteAnchor, false);
    assert.strictEqual(result.anchorDecision.wouldRestore, false);
    assert.strictEqual(result.auditDecision.state, 'resolved');
    assert.strictEqual(result.auditDecision.wouldPersistAudit, false);
    assert.strictEqual(result.auditDecision.wouldWriteLog, false);
    assert.strictEqual(result.recoveryDecision.state, 'resolved');
    assert.strictEqual(result.recoveryDecision.wouldRecover, false);
    assert.strictEqual(result.recoveryDecision.wouldRestartService, false);
    assert.strictEqual(result.policyDecision.authorized, true);
    assert.strictEqual(result.policyDecision.primaryBlocker, null);
    assert.ok(!result.policyDecision.blockers.includes('operator-recovery-not-ready'));
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    assert.doesNotMatch(JSON.stringify(result), /forged|wouldRun":true/i);
  });

  it('G4: non-catalog implementationId keeps registry false and adapter/anchor/audit/recovery true', () => {
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
    assertAlwaysBlockedGate(result, {
      runnerRegistryReady: false,
      hostMutationAdapterReady: true,
      rollbackAnchorReady: true,
      attemptAuditReady: true,
    operatorRecoveryReady: true,
    });
    assert.strictEqual(result.gates.actionCandidatesReady, true);
    assert.strictEqual(result.registryDecision.state, 'unresolved');
    assert.strictEqual(
      result.registryDecision.primaryBlocker,
      'runner-registry-implementation-mismatch',
    );
    assert.strictEqual(result.gates.runnerRegistryReady, false);
    assert.strictEqual(result.adapterDecision.state, 'resolved');
    assert.strictEqual(result.adapterDecision.adapterReady, true);
    assert.strictEqual(result.gates.hostMutationAdapterReady, true);
    assert.strictEqual(result.anchorDecision.state, 'resolved');
    assert.strictEqual(result.anchorDecision.anchorReady, true);
    assert.strictEqual(result.gates.rollbackAnchorReady, true);
    assert.strictEqual(result.auditDecision.state, 'resolved');
    assert.strictEqual(result.auditDecision.auditReady, true);
    assert.strictEqual(result.gates.attemptAuditReady, true);
    assert.strictEqual(result.recoveryDecision.state, 'resolved');
    assert.strictEqual(result.recoveryDecision.recoveryReady, true);
    assert.strictEqual(result.gates.operatorRecoveryReady, true);
    assert.ok(result.policyDecision.blockers.includes('runner-registry-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('host-mutation-adapter-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('rollback-anchor-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('attempt-audit-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('operator-recovery-not-ready'));
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    assert.strictEqual(result.policyDecision.wouldRun, false);
    assert.strictEqual(result.policyDecision.wouldWrite, false);
    assert.strictEqual(result.registryDecision.wouldExecute, false);
    assert.strictEqual(result.registryDecision.wouldRun, false);
    assert.strictEqual(result.registryDecision.wouldWrite, false);
    assert.strictEqual(result.adapterDecision.wouldMutateHost, false);
    assert.strictEqual(result.anchorDecision.wouldWriteAnchor, false);
    assert.strictEqual(result.auditDecision.wouldPersistAudit, false);
    assert.strictEqual(result.recoveryDecision.wouldRecover, false);
    for (const c of result.actionCandidates) {
      assert.strictEqual(c.wouldExecute, false);
      assert.strictEqual(c.wouldRun, false);
      assert.strictEqual(c.wouldWrite, false);
    }
  });

  it('G5: redacted maxAttempts keeps registry false and adapter/anchor/audit/recovery true', () => {
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
    assertAlwaysBlockedGate(result, {
      runnerRegistryReady: false,
      hostMutationAdapterReady: true,
      rollbackAnchorReady: true,
      attemptAuditReady: true,
    operatorRecoveryReady: true,
    });
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
    assert.strictEqual(result.adapterDecision.state, 'resolved');
    assert.strictEqual(result.adapterDecision.adapterReady, true);
    assert.strictEqual(result.gates.hostMutationAdapterReady, true);
    assert.strictEqual(result.anchorDecision.state, 'resolved');
    assert.strictEqual(result.gates.rollbackAnchorReady, true);
    assert.strictEqual(result.auditDecision.state, 'resolved');
    assert.strictEqual(result.auditDecision.auditReady, true);
    assert.strictEqual(result.gates.attemptAuditReady, true);
    assert.strictEqual(result.recoveryDecision.state, 'resolved');
    assert.strictEqual(result.recoveryDecision.recoveryReady, true);
    assert.strictEqual(result.gates.operatorRecoveryReady, true);
    assert.ok(result.policyDecision.blockers.includes('runner-registry-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('host-mutation-adapter-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('rollback-anchor-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('attempt-audit-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('operator-recovery-not-ready'));
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    assert.strictEqual(result.policyDecision.wouldRun, false);
    assert.strictEqual(result.policyDecision.wouldWrite, false);
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

    assertAlwaysBlockedGate(result, {
      runnerRegistryReady: true,
      hostMutationAdapterReady: true,
      rollbackAnchorReady: true,
      attemptAuditReady: true,
    operatorRecoveryReady: true,
    });
    assert.ok(result.blockers.includes('approval-record-gate-not-ready'));
    assert.doesNotMatch(serialized, /gate-operator|approval reason|acknowledgement|sha256:|\/Users\/ah|localhost|token|secret/i);
  });

  it('uses stable blockers for invalid or mismatched manifest, runner, and preview inputs', () => {
    const invalidManifest = {
      ...getReadyInputs(),
      manifestReadiness: null,
    };
    const invalidManifestResult = buildGate(invalidManifest, { executeRequested: true });

    assertAlwaysBlockedGate(invalidManifestResult, {
      runnerRegistryReady: true,
      hostMutationAdapterReady: true,
      rollbackAnchorReady: true,
      attemptAuditReady: true,
    operatorRecoveryReady: true,
    });
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

    assertAlwaysBlockedGate(runnerResult, {
      runnerRegistryReady: true,
      hostMutationAdapterReady: true,
      rollbackAnchorReady: true,
      attemptAuditReady: true,
    operatorRecoveryReady: true,
    });
    assert.ok(runnerResult.blockers.includes('guarded-runner-readiness-not-ready'));
    assert.strictEqual(runnerResult.gates.runnerBindingsReady, false);

    const previewMismatch = getReadyInputs();
    previewMismatch.executionPreview = {
      ...previewMismatch.executionPreview,
      operation: 'rollback',
    };
    const previewResult = buildGate(previewMismatch, { executeRequested: true });

    assertAlwaysBlockedGate(previewResult, {
      runnerRegistryReady: false,
      hostMutationAdapterReady: false,
      rollbackAnchorReady: false,
      attemptAuditReady: false,
    operatorRecoveryReady: false,
    });
    assert.ok(previewResult.blockers.includes('execution-preview-operation-mismatch'));
    assert.strictEqual(previewResult.gates.executionPreviewVerified, false);

    const invalidPreview = buildGate({ ...getReadyInputs(), executionPreview: null }, { executeRequested: true });

    assertAlwaysBlockedGate(invalidPreview, {
      runnerRegistryReady: false,
      hostMutationAdapterReady: false,
      rollbackAnchorReady: false,
      attemptAuditReady: false,
    operatorRecoveryReady: false,
    });
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

    assertAlwaysBlockedGate(notVerifiedResult, {
      runnerRegistryReady: false,
      hostMutationAdapterReady: false,
      rollbackAnchorReady: false,
      attemptAuditReady: false,
    operatorRecoveryReady: false,
    });
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

    assertAlwaysBlockedGate(result, {
      runnerRegistryReady: false,
      hostMutationAdapterReady: false,
      rollbackAnchorReady: false,
      attemptAuditReady: false,
    operatorRecoveryReady: false,
    });
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
  it('G1: production valid candidates => actionCandidatesReady true and policy authorized; execution still blocked', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });
    assert.strictEqual(result.gates.actionCandidatesReady, true);
    assert.strictEqual(result.gates.runnerRegistryReady, true);
    assert.strictEqual(result.gates.hostMutationAdapterReady, true);
    assert.strictEqual(result.gates.rollbackAnchorReady, true);
    assert.strictEqual(result.gates.attemptAuditReady, true);
    assert.strictEqual(result.gates.operatorRecoveryReady, true);
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
        result.actionCandidates,
        result.operation,
      ),
      true,
    );
    assert.strictEqual(result.policyDecision.state, 'authorized');
    assert.strictEqual(result.policyDecision.authorized, true);
    assert.strictEqual(result.policyDecision.primaryBlocker, null);
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    assert.ok(!result.policyDecision.blockers.includes('operator-recovery-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('attempt-audit-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('runner-registry-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('host-mutation-adapter-not-ready'));
    assert.ok(!result.policyDecision.blockers.includes('rollback-anchor-not-ready'));
    assert.deepStrictEqual(result.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
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

const REAL_WIRING_MISSING = 'real-guarded-runner-execution-wiring-missing';
const EXPECTED_ORCHESTRATOR_ENTRY = Object.freeze({
  orchestratorKind: 'code-owned-real-wiring-orchestrator',
  state: 'ready',
  codeOwnedResolverWired: true,
  realRunnerWiringReady: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  networkAllowed: false,
  blockerCode: null,
  evidenceCode: 'real-wiring-orchestrator-plan-ready',
});

function buildValidWiringPlanInputFromGate(options = { executeRequested: true }) {
  const result = buildGate(getReadyInputs(), options);
  return {
    operation: result.operation,
    actionCandidates: result.actionCandidates.map((c) => ({ ...c })),
    policyDecision: { ...result.policyDecision, blockers: [...result.policyDecision.blockers], nextBlockers: [...result.policyDecision.nextBlockers] },
    registryDecision: { ...result.registryDecision },
    adapterDecision: { ...result.adapterDecision },
    anchorDecision: { ...result.anchorDecision },
    auditDecision: { ...result.auditDecision },
    recoveryDecision: { ...result.recoveryDecision },
    lifecyclePlanValid: result.gates.lifecyclePlanValid === true,
    approvalRecordReady: result.gates.approvalRecordReady === true,
    manifestReady: result.gates.manifestReady === true,
    runnerBindingsReady: result.gates.runnerBindingsReady === true,
    executionPreviewVerified: result.gates.executionPreviewVerified === true,
    executeRequested: result.gates.executeRequested === true,
    actionCandidatesReady: result.gates.actionCandidatesReady === true,
    executionPolicyReady: result.gates.executionPolicyReady === true,
    runnerRegistryReady: result.gates.runnerRegistryReady === true,
    hostMutationAdapterReady: result.gates.hostMutationAdapterReady === true,
    rollbackAnchorReady: result.gates.rollbackAnchorReady === true,
    attemptAuditReady: result.gates.attemptAuditReady === true,
    operatorRecoveryReady: result.gates.operatorRecoveryReady === true,
  };
}

function assertPlanSideEffectFalse(plan) {
  assert.strictEqual(plan.realRunnerWiringReady, false);
  assert.strictEqual(plan.runnerWiringContractReady, false);
  assert.strictEqual(plan.executionEligible, false);
  assert.strictEqual(plan.mode, 'plan-only');
  assert.strictEqual(plan.wouldExecute, false);
  assert.strictEqual(plan.wouldRun, false);
  assert.strictEqual(plan.wouldWrite, false);
  assert.strictEqual(plan.launchctlAllowed, false);
  assert.strictEqual(plan.filesystemWriteAllowed, false);
  assert.strictEqual(plan.processListReadAllowed, false);
  assert.strictEqual(plan.networkAllowed, false);
  assert.deepStrictEqual(plan.nextBlockers, [REAL_WIRING_MISSING]);
  assert.deepStrictEqual(plan.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
}

function assertSealSideEffectFalse(seal) {
  assert.strictEqual(seal.realRunnerWiringReady, false);
  assert.strictEqual(seal.runnerWiringContractReady, false);
  assert.strictEqual(seal.executionEligible, false);
  assert.strictEqual(seal.wouldPersistAudit, false);
  assert.strictEqual(seal.wouldWriteLog, false);
  assert.strictEqual(seal.wouldExecute, false);
  assert.strictEqual(seal.wouldRun, false);
  assert.strictEqual(seal.wouldWrite, false);
  assert.deepStrictEqual(seal.nextBlockers, [REAL_WIRING_MISSING]);
  assert.deepStrictEqual(seal.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
}

describe('buildSupervisorLifecycleGuardedRunnerRealWiringOrchestratorReadiness', () => {
  it('T7: fixed ready orchestrator readiness is pure plan fact only', () => {
    const r = buildSupervisorLifecycleGuardedRunnerRealWiringOrchestratorReadiness();
    assert.strictEqual(r.command, 'supervisor-lifecycle-guarded-runner-real-wiring-orchestrator-readiness');
    assert.strictEqual(r.state, 'ready');
    assert.strictEqual(r.realWiringOrchestratorDefined, true);
    assert.strictEqual(r.pureWiringOrchestratorPlanReady, true);
    assert.strictEqual(r.codeOwnedWiringOrchestratorReady, true);
    assert.strictEqual(r.realRunnerWiringReady, false);
    assert.strictEqual(r.readyCount, 1);
    assert.strictEqual(r.blockedCount, 0);
    assert.deepStrictEqual(r.blockers, []);
    assert.deepStrictEqual(r.nextBlockers, [REAL_WIRING_MISSING]);
    assert.deepStrictEqual(r.entries, [EXPECTED_ORCHESTRATOR_ENTRY]);
    assert.strictEqual(r.entries[0].realRunnerWiringReady, false);
    assert.strictEqual(r.entries[0].wouldExecute, false);
    assert.strictEqual(r.entries[0].wouldRun, false);
    assert.strictEqual(r.entries[0].wouldWrite, false);
    assert.strictEqual(r.entries[0].launchctlAllowed, false);
    assert.strictEqual(r.entries[0].filesystemWriteAllowed, false);
    assert.strictEqual(r.entries[0].processListReadAllowed, false);
    assert.strictEqual(r.entries[0].networkAllowed, false);
    assert.strictEqual(r.entries[0].evidenceCode, 'real-wiring-orchestrator-plan-ready');
    assert.deepStrictEqual(r.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });
});

describe('buildSupervisorLifecycleGuardedRunnerRealWiringPlan', () => {
  it('T1: production-shaped input plans without elevating real wiring', () => {
    const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(buildValidWiringPlanInputFromGate());
    assert.strictEqual(plan.command, 'supervisor-lifecycle-guarded-runner-real-wiring-plan');
    assert.strictEqual(plan.state, 'planned');
    assert.strictEqual(plan.planReady, true);
    assert.strictEqual(plan.pureWiringOrchestratorPlanReady, true);
    assert.strictEqual(plan.operation, 'install');
    assert.strictEqual(plan.evidenceCode, 'real-wiring-orchestrator-plan-ready');
    assert.strictEqual(plan.primaryBlocker, null);
    assert.deepStrictEqual(plan.blockers, []);
    assertPlanSideEffectFalse(plan);
    assert.ok(Array.isArray(plan.steps) && plan.steps.length > 0);
    for (const step of plan.steps) {
      assert.strictEqual(step.wouldExecute, false);
      assert.strictEqual(step.wouldRun, false);
      assert.strictEqual(step.wouldWrite, false);
      assert.equal(typeof step.actionId, 'string');
      assert.equal(typeof step.implementationId, 'string');
      assert.strictEqual(step.registryRef, 'registry-mapping-ready');
      assert.strictEqual(step.mutationRef, 'host-mutation-adapter-mutation-ready');
      assert.strictEqual(step.anchorRef, 'rollback-anchor-plan-ready');
      assert.strictEqual(step.auditRef, 'attempt-audit-plan-ready');
      assert.strictEqual(step.recoveryRef, 'operator-recovery-plan-ready');
      assert.strictEqual(step.command, undefined);
      assert.strictEqual(step.path, undefined);
      assert.strictEqual(step.url, undefined);
    }
  });

  it('T2a: incomplete structure facts is structure-facts-incomplete', () => {
    const input = buildValidWiringPlanInputFromGate();
    input.executeRequested = false;
    const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input);
    assert.strictEqual(plan.state, 'unplanned');
    assert.strictEqual(plan.planReady, false);
    assert.strictEqual(plan.pureWiringOrchestratorPlanReady, false);
    assert.strictEqual(plan.primaryBlocker, 'real-wiring-plan-structure-facts-incomplete');
    assert.deepStrictEqual(plan.blockers, ['real-wiring-plan-structure-facts-incomplete']);
    assert.deepStrictEqual(plan.steps, []);
    assertPlanSideEffectFalse(plan);
  });

  it('T2b: empty candidates is candidates-not-ready', () => {
    const input = buildValidWiringPlanInputFromGate();
    input.actionCandidates = [];
    input.actionCandidatesReady = true;
    const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input);
    assert.strictEqual(plan.state, 'unplanned');
    assert.strictEqual(plan.primaryBlocker, 'real-wiring-plan-candidates-not-ready');
  });

  it('T2c: unauthorized policy is policy-not-authorized', () => {
    const input = buildValidWiringPlanInputFromGate();
    input.policyDecision = {
      ...input.policyDecision,
      state: 'denied',
      authorized: false,
      wouldAuthorizeExecution: false,
      primaryBlocker: 'execute-request-missing',
      blockers: ['execute-request-missing'],
      nextBlockers: ['execute-request-missing'],
    };
    const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input);
    assert.strictEqual(plan.state, 'unplanned');
    assert.strictEqual(plan.primaryBlocker, 'real-wiring-plan-policy-not-authorized');
  });

  it('T2d: unresolved registry is registry-not-resolved', () => {
    const input = buildValidWiringPlanInputFromGate();
    input.registryDecision = {
      ...input.registryDecision,
      state: 'unresolved',
      registryReady: false,
      primaryBlocker: 'runner-registry-candidates-invalid',
      blockers: ['runner-registry-candidates-invalid'],
      nextBlockers: ['runner-registry-candidates-invalid'],
      mappings: [],
    };
    const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input);
    assert.strictEqual(plan.primaryBlocker, 'real-wiring-plan-registry-not-resolved');
  });

  it('T2e: unresolved adapter/anchor/audit/recovery map to corresponding blockers', () => {
    const cases = [
      ['adapterDecision', 'adapterReady', 'real-wiring-plan-adapter-not-resolved'],
      ['anchorDecision', 'anchorReady', 'real-wiring-plan-anchor-not-resolved'],
      ['auditDecision', 'auditReady', 'real-wiring-plan-audit-not-resolved'],
      ['recoveryDecision', 'recoveryReady', 'real-wiring-plan-recovery-not-resolved'],
    ];
    for (const [key, readyKey, blocker] of cases) {
      const input = buildValidWiringPlanInputFromGate();
      input[key] = {
        ...input[key],
        state: 'unresolved',
        [readyKey]: false,
        primaryBlocker: 'x',
        blockers: ['x'],
      };
      const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input);
      assert.strictEqual(plan.primaryBlocker, blocker, key);
    }
  });

  it('T3: side-effect flag true on decision is side-effect-flag-invalid', () => {
    const flags = [
      ['adapterDecision', 'wouldMutateHost'],
      ['adapterDecision', 'launchctlAllowed'],
      ['anchorDecision', 'wouldWriteAnchor'],
      ['auditDecision', 'wouldPersistAudit'],
      ['recoveryDecision', 'wouldRecover'],
      ['policyDecision', 'wouldRun'],
      ['registryDecision', 'wouldExecute'],
    ];
    for (const [decisionKey, flag] of flags) {
      const input = buildValidWiringPlanInputFromGate();
      input[decisionKey] = { ...input[decisionKey], [flag]: true };
      const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input);
      assert.strictEqual(plan.state, 'unplanned', `${decisionKey}.${flag}`);
      assert.strictEqual(plan.primaryBlocker, 'real-wiring-plan-side-effect-flag-invalid', `${decisionKey}.${flag}`);
    }
  });

  it('T4a: extra key is input-invalid', () => {
    const input = buildValidWiringPlanInputFromGate();
    input.extra = true;
    const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input);
    assert.strictEqual(plan.primaryBlocker, 'real-wiring-plan-input-invalid');
  });

  it('T4b: invalid operation is operation-invalid', () => {
    const input = buildValidWiringPlanInputFromGate();
    input.operation = 'nope';
    const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input);
    assert.strictEqual(plan.primaryBlocker, 'real-wiring-plan-operation-invalid');
    assert.strictEqual(plan.operation, 'unknown');
  });

  it('T4c: Proxy / getter input is input-invalid without secret leak', () => {
    const base = buildValidWiringPlanInputFromGate();
    const trapped = new Proxy(base, {
      ownKeys() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });
    const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(trapped);
    assert.strictEqual(plan.primaryBlocker, 'real-wiring-plan-input-invalid');
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));

    const withGetter = {};
    for (const key of Object.keys(base)) {
      Object.defineProperty(withGetter, key, {
        enumerable: true,
        configurable: true,
        get() {
          return base[key];
        },
      });
    }
    const getterPlan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(withGetter);
    assert.strictEqual(getterPlan.primaryBlocker, 'real-wiring-plan-input-invalid');
  });
});

describe('buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal', () => {
  it('T5: planned plan seals as plan-only seal-ready without elevating real wiring', () => {
    const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(buildValidWiringPlanInputFromGate());
    const seal = buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal(plan);
    assert.strictEqual(seal.command, 'supervisor-lifecycle-guarded-runner-real-wiring-plan-seal');
    assert.strictEqual(seal.state, 'seal-ready');
    assert.strictEqual(seal.sealReady, true);
    assert.strictEqual(seal.pureWiringOrchestratorPlanReady, true);
    assert.strictEqual(seal.evidenceCode, 'real-wiring-orchestrator-plan-seal-ready');
    assert.strictEqual(seal.primaryBlocker, null);
    assert.deepStrictEqual(seal.blockers, []);
    assert.strictEqual(seal.stepCount, plan.steps.length);
    assertSealSideEffectFalse(seal);
  });

  it('T6: unplanned plan is seal-blocked', () => {
    const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan({
      ...buildValidWiringPlanInputFromGate(),
      executeRequested: false,
    });
    assert.strictEqual(plan.state, 'unplanned');
    const seal = buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal(plan);
    assert.strictEqual(seal.state, 'seal-blocked');
    assert.strictEqual(seal.sealReady, false);
    assert.strictEqual(seal.pureWiringOrchestratorPlanReady, false);
    assert.strictEqual(seal.primaryBlocker, 'real-wiring-plan-seal-plan-invalid');
    assertSealSideEffectFalse(seal);
  });

  it('T6b: nextBlockers drift is seal-blocked (exact wiring-missing required)', () => {
    const planned = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(buildValidWiringPlanInputFromGate());
    assert.strictEqual(planned.state, 'planned');
    const cases = [
      [],
      ['execute-request-missing'],
      [REAL_WIRING_MISSING, 'extra-blocker'],
      [REAL_WIRING_MISSING, REAL_WIRING_MISSING],
      null,
      undefined,
      REAL_WIRING_MISSING,
    ];
    for (const nextBlockers of cases) {
      const seal = buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal({
        ...planned,
        steps: planned.steps.map((s) => ({ ...s })),
        blockers: [...planned.blockers],
        nextBlockers,
        safety: { ...planned.safety },
      });
      assert.strictEqual(seal.state, 'seal-blocked', `nextBlockers=${JSON.stringify(nextBlockers)}`);
      assert.strictEqual(seal.sealReady, false, `nextBlockers=${JSON.stringify(nextBlockers)}`);
      assert.strictEqual(seal.primaryBlocker, 'real-wiring-plan-seal-plan-invalid', `nextBlockers=${JSON.stringify(nextBlockers)}`);
      assertSealSideEffectFalse(seal);
    }
    // Honest exact nextBlockers still seals ready.
    const honest = buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal({
      ...planned,
      steps: planned.steps.map((s) => ({ ...s })),
      blockers: [...planned.blockers],
      nextBlockers: [REAL_WIRING_MISSING],
      safety: { ...planned.safety },
    });
    assert.strictEqual(honest.state, 'seal-ready');
    assert.strictEqual(honest.sealReady, true);
  });

  it('T6c: safety drift is seal-blocked (exact executionPreviewSafety schema required)', () => {
    const planned = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(buildValidWiringPlanInputFromGate());
    assert.strictEqual(planned.state, 'planned');
    const baseSafety = { ...planned.safety };
    const cases = [
      { ...baseSafety, hostMutation: true },
      { ...baseSafety, launchctlCalled: true },
      { ...baseSafety, filesystemWritten: true },
      { ...baseSafety, processListRead: true },
      { ...baseSafety, remoteCommandExecuted: true },
      { ...baseSafety, dryRun: false },
      { ...baseSafety, readOnly: false },
      { ...baseSafety, extraFlag: false },
      (() => {
        const missing = { ...baseSafety };
        delete missing.hostMutation;
        return missing;
      })(),
      null,
      undefined,
      [],
      'not-an-object',
    ];
    for (let i = 0; i < cases.length; i++) {
      const safety = cases[i];
      const seal = buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal({
        ...planned,
        steps: planned.steps.map((s) => ({ ...s })),
        blockers: [...planned.blockers],
        nextBlockers: [REAL_WIRING_MISSING],
        safety,
      });
      assert.strictEqual(seal.state, 'seal-blocked', `safety case #${i}`);
      assert.strictEqual(seal.sealReady, false, `safety case #${i}`);
      assert.strictEqual(seal.primaryBlocker, 'real-wiring-plan-seal-plan-invalid', `safety case #${i}`);
      assertSealSideEffectFalse(seal);
    }
    // Honest exact safety still seals ready.
    const honest = buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal({
      ...planned,
      steps: planned.steps.map((s) => ({ ...s })),
      blockers: [...planned.blockers],
      nextBlockers: [REAL_WIRING_MISSING],
      safety: { ...baseSafety },
    });
    assert.strictEqual(honest.state, 'seal-ready');
    assert.strictEqual(honest.sealReady, true);
    assert.deepStrictEqual(honest.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });
});

describe('buildSupervisorLifecycleGuardedRunnerExecutionGate V1.30 wiring plan/seal', () => {
  it('T8: production ready + executeRequested attaches planned seal and pure plan fact true', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });
    assert.strictEqual(result.gates.pureWiringOrchestratorPlanReady, true);
    assert.strictEqual(result.wiringPlan.state, 'planned');
    assert.strictEqual(result.wiringPlan.planReady, true);
    assert.strictEqual(result.wiringPlan.pureWiringOrchestratorPlanReady, true);
    assert.strictEqual(result.wiringPlan.mode, 'plan-only');
    assert.strictEqual(result.wiringPlan.evidenceCode, 'real-wiring-orchestrator-plan-ready');
    assert.strictEqual(result.wiringPlan.realRunnerWiringReady, false);
    assert.strictEqual(result.wiringPlan.runnerWiringContractReady, false);
    assert.strictEqual(result.wiringPlan.executionEligible, false);
    assert.strictEqual(result.wiringPlan.wouldExecute, false);
    assert.strictEqual(result.wiringPlan.wouldRun, false);
    assert.strictEqual(result.wiringPlan.wouldWrite, false);
    assert.strictEqual(result.wiringPlan.launchctlAllowed, false);
    assert.strictEqual(result.wiringPlan.filesystemWriteAllowed, false);
    assert.strictEqual(result.wiringPlan.processListReadAllowed, false);
    assert.strictEqual(result.wiringPlan.networkAllowed, false);
    assert.strictEqual(result.wiringPlanSeal.state, 'seal-ready');
    assert.strictEqual(result.wiringPlanSeal.sealReady, true);
    assert.strictEqual(result.wiringPlanSeal.pureWiringOrchestratorPlanReady, true);
    assert.strictEqual(result.wiringPlanSeal.evidenceCode, 'real-wiring-orchestrator-plan-seal-ready');
    assert.strictEqual(result.wiringPlanSeal.realRunnerWiringReady, false);
    assert.strictEqual(result.wiringPlanSeal.runnerWiringContractReady, false);
    assert.strictEqual(result.wiringPlanSeal.executionEligible, false);
    assert.strictEqual(result.wiringPlanSeal.wouldPersistAudit, false);
    assert.strictEqual(result.wiringPlanSeal.wouldWriteLog, false);
    assert.strictEqual(result.wiringPlanSeal.wouldExecute, false);
    assert.strictEqual(result.wiringPlanSeal.wouldRun, false);
    assert.strictEqual(result.wiringPlanSeal.wouldWrite, false);
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    assert.strictEqual(result.realRunnerWiringReady, false);
    assert.strictEqual(result.gates.realRunnerWiringReady, false);
    assert.strictEqual(result.gates.runnerWiringContractReady, false);
    assert.deepStrictEqual(result.nextBlockers, [REAL_WIRING_MISSING]);
    assert.ok(result.blockers.includes(REAL_WIRING_MISSING));
    assert.strictEqual(result.policyDecision.state, 'authorized');
    assert.strictEqual(result.policyDecision.primaryBlocker, null);
    assert.strictEqual(Object.hasOwn(result.policyDecision, 'pureWiringOrchestratorPlanReady'), false);
    assert.strictEqual(result.adapterDecision.realHostMutationImplementationReady, false);
    assert.strictEqual(result.anchorDecision.realRollbackAnchorImplementationReady, false);
    assert.strictEqual(result.auditDecision.realAttemptAuditImplementationReady, false);
    assert.strictEqual(result.recoveryDecision.realOperatorRecoveryImplementationReady, false);
    assert.strictEqual(result.runnerWiringContract.readyCount, 6);
    assert.strictEqual(result.runnerWiringContract.blockedCount, 0);
    assert.strictEqual(result.runnerWiringContract.state, 'blocked');
    assert.strictEqual(result.runnerWiringContract.realRunnerWiringReady, false);
    assert.ok(result.runnerWiringContract.realWiringOrchestratorReadiness);
    assert.strictEqual(result.runnerWiringContract.realWiringOrchestratorReadiness.pureWiringOrchestratorPlanReady, true);
    assert.strictEqual(result.runnerWiringContract.realWiringOrchestratorReadiness.realRunnerWiringReady, false);
  });

  it('T9: executeRequested false keeps pure plan fact false and policy execute-request-missing', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: false });
    assert.strictEqual(result.gates.pureWiringOrchestratorPlanReady, false);
    assert.strictEqual(result.wiringPlan.state, 'unplanned');
    assert.strictEqual(result.wiringPlanSeal.state, 'seal-blocked');
    assert.strictEqual(result.executionEligible, false);
    assert.ok(
      result.policyDecision.blockers.includes('execute-request-missing') ||
      result.policyDecision.primaryBlocker === 'execute-request-missing',
    );
    assert.deepStrictEqual(result.nextBlockers, [REAL_WIRING_MISSING]);
  });

  it('T10: options override for wiringPlan/seal/ready facts is ignored', () => {
    const poisoned = buildGate(getReadyInputs(), {
      executeRequested: true,
      wiringPlan: { state: 'planned', planReady: true, realRunnerWiringReady: true },
      wiringPlanSeal: { state: 'seal-ready', sealReady: true, realRunnerWiringReady: true },
      pureWiringOrchestratorPlanReady: true,
      realRunnerWiringReady: true,
      runnerWiringContractReady: true,
      executionEligible: true,
    });
    assert.strictEqual(poisoned.realRunnerWiringReady, false);
    assert.strictEqual(poisoned.executionEligible, false);
    assert.strictEqual(poisoned.gates.runnerWiringContractReady, false);
    assert.strictEqual(poisoned.gates.realRunnerWiringReady, false);
    assert.strictEqual(poisoned.wiringPlan.realRunnerWiringReady, false);
    assert.strictEqual(poisoned.wiringPlanSeal.realRunnerWiringReady, false);
    assert.notStrictEqual(poisoned.wiringPlan, poisoned.options?.wiringPlan);
    assert.deepStrictEqual(poisoned.nextBlockers, [REAL_WIRING_MISSING]);
    assert.strictEqual(poisoned.gates.pureWiringOrchestratorPlanReady, true);
    assert.strictEqual(poisoned.wiringPlan.state, 'planned');
    assert.strictEqual(poisoned.wiringPlanSeal.state, 'seal-ready');
  });

  it('T11: wiring aggregate remains 6/0 blocked with wiring-missing', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });
    assert.strictEqual(result.runnerWiringContract.readyCount, 6);
    assert.strictEqual(result.runnerWiringContract.blockedCount, 0);
    assert.strictEqual(result.runnerWiringContract.state, 'blocked');
    assert.ok(result.runnerWiringContract.blockers.includes(REAL_WIRING_MISSING));
    assert.deepStrictEqual(result.runnerWiringContract.nextBlockers, [REAL_WIRING_MISSING]);
  });
});
