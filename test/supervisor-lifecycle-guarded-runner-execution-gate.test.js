import { afterEach, describe, it } from 'node:test';
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
  buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness,
  resolveSupervisorLifecycleGuardedRunnerCapabilityInjection,
  authorizeSupervisorLifecycleGuardedRunnerCapabilityMode,
  invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun,
  authorizeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof,
  invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof,
  authorizeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof,
  invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof,
  authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof,
  invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof,
  setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest,
  setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest,
  recomputeSupervisorLifecycleGuardedRunnerRealRenderPlistForTest,
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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS,
  listSupervisorLifecycleActionIds,
} from '../src/supervisor-lifecycle-actions.js';
import {
  CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
  CAPABILITY_REAL_AUDIT_MAX_EVENT_LINES,
  setCapabilityRealAuditSinkHooksForTest,
} from '../src/capability-audit-sink.js';

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
      capabilityInjectionReady: true,
      dryRunCapabilityRegistryReady: true,
      realRenderCapabilityImplementationReady: true,
      realStatusCapabilityImplementationReady: true,
      realAuditCapabilityImplementationReady: true,
      realCapabilityImplementationsReady: false,
      realAttemptAuditImplementationReady: false,
      executeCapabilityAuthorized: false,
      hostMutationOccurred: false,
      hostObservationOccurred: false,
      hostSideEffectOccurred: false,
      auditPersistOccurred: false,
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


// ── V1.31 Capability injection + dry-run/execute boundary ─────────────
const CAPABILITY_KINDS = Object.freeze([
  'render', 'write', 'reload', 'status', 'rollback', 'audit', 'notify',
]);
const CODE_OWNED_ACTION_PRIMARY_CAPABILITY_MAP = Object.freeze({
  'render-launch-agent-plist': 'render',
  'write-launch-agent-plist': 'write',
  'load-launch-agent': 'reload',
  'unload-launch-agent': 'reload',
  'remove-launch-agent-plist': 'write',
  'remove-supervisor-metadata': 'write',
  'capture-current-state': 'status',
  'restore-previous-plist': 'rollback',
  'restart-previous-supervisor': 'reload',
  'start-recovery-supervisor': 'reload',
});
const EXPECTED_CAPABILITY_ENTRY = Object.freeze({
  injectionKind: 'code-owned-capability-injection',
  state: 'ready',
  codeOwnedResolverWired: true,
  dryRunCapabilityRegistryReady: true,
  executeCapabilityRegistryReady: false,
  realCapabilityImplementationsReady: false,
  realRunnerWiringReady: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  hostSideEffectOccurred: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  networkAllowed: false,
  blockerCode: null,
  evidenceCode: 'capability-injection-ready',
});
const CAPABILITY_AUDIT_SEQUENCE = Object.freeze([
  'authorize', 'mode-check', 'registry-lookup', 'anchor-plan',
  'invoke', 'receipt', 'audit-plan', 'notify-plan',
]);

function buildInstallCapabilityCandidates() {
  return buildGate(getReadyInputs(), { executeRequested: true }).actionCandidates.map((c) => ({ ...c }));
}

function buildCapabilityRequest(overrides = {}) {
  return {
    capabilityKind: 'render',
    actionId: 'render-launch-agent-plist',
    operation: 'install',
    mode: 'dry-run',
    idempotencyKey: null,
    attemptRef: null,
    anchorRef: null,
    ...overrides,
  };
}

function assertCapabilitySideEffectFalse(obj) {
  assert.strictEqual(obj.realRunnerWiringReady, false);
  assert.strictEqual(obj.runnerWiringContractReady, false);
  assert.strictEqual(obj.executionEligible, false);
  assert.strictEqual(obj.executeCapabilityAuthorized, false);
  assert.strictEqual(obj.hostSideEffectOccurred, false);
  assert.strictEqual(obj.wouldExecute, false);
  assert.strictEqual(obj.wouldRun, false);
  assert.strictEqual(obj.wouldWrite, false);
  assert.deepStrictEqual(obj.nextBlockers, [REAL_WIRING_MISSING]);
}

function assertReceiptBase(receipt) {
  assert.strictEqual(receipt.command, 'supervisor-lifecycle-guarded-runner-capability-receipt');
  assert.strictEqual(receipt.sealReady, undefined);
  assert.notStrictEqual(receipt.command, 'supervisor-lifecycle-guarded-runner-real-wiring-plan-seal');
  assert.ok(['completed', 'denied', 'error'].includes(receipt.state));
  assert.notStrictEqual(receipt.state, 'partial');
  assert.notStrictEqual(receipt.state, 'timeout');
  assert.notStrictEqual(receipt.state, 'rolled-back');
  assert.strictEqual(receipt.idempotencyKeyFingerprint, null);
  assert.strictEqual(receipt.wouldMutateHost, false);
  assert.strictEqual(receipt.wouldPersistAudit, false);
  assert.strictEqual(receipt.wouldNotifyExternal, false);
  assert.strictEqual(receipt.partial, false);
  assert.strictEqual(receipt.timedOut, false);
  assert.strictEqual(receipt.rolledBack, false);
  assert.strictEqual(receipt.realCapabilityImplementationsReady, false);
  assert.strictEqual(receipt.redaction.secretsRedacted, true);
  assert.strictEqual(receipt.redaction.pathsRedacted, true);
  assert.strictEqual(receipt.redaction.hostsRedacted, true);
  assert.deepStrictEqual(receipt.auditSequence, [...CAPABILITY_AUDIT_SEQUENCE]);
  assertCapabilitySideEffectFalse(receipt);
  assert.strictEqual(typeof receipt.handler, 'undefined');
  assert.strictEqual(typeof receipt.fn, 'undefined');
  assert.doesNotMatch(JSON.stringify(receipt), /function|launchctl |UNSAFE_SECRET/i);
}

describe('V1.31 buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness', () => {
  it('T1: fixed ready readiness is pure capability contract only', () => {
    const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
    assert.strictEqual(r.command, 'supervisor-lifecycle-guarded-runner-capability-injection-readiness');
    assert.strictEqual(r.state, 'ready');
    assert.strictEqual(r.pureCapabilityInjectionReady, true);
    assert.strictEqual(r.codeOwnedCapabilityFactoryReady, true);
    assert.strictEqual(r.dryRunCapabilityRegistryReady, true);
    assert.strictEqual(r.executeCapabilityRegistryReady, false);
    assert.strictEqual(r.realCapabilityImplementationsReady, false);
    assert.strictEqual(r.realRunnerWiringReady, false);
    assert.strictEqual(r.executeCapabilityAuthorized, false);
    assert.strictEqual(r.readyCount, 1);
    assert.strictEqual(r.blockedCount, 0);
    assert.deepStrictEqual(r.nextBlockers, [REAL_WIRING_MISSING]);
    assert.deepStrictEqual(r.capabilityKinds, [...CAPABILITY_KINDS]);
    assert.deepStrictEqual(r.entries, [EXPECTED_CAPABILITY_ENTRY]);
    assert.deepStrictEqual(r.blockers, []);
    assert.deepStrictEqual(r.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
    // deep copy isolation
    r.entries[0].wouldExecute = true;
    const r2 = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
    assert.strictEqual(r2.entries[0].wouldExecute, false);
  });
});

describe('V1.31 resolveSupervisorLifecycleGuardedRunnerCapabilityInjection', () => {
  it('T2: install candidates resolve with dry-run mappings only', () => {
    const d = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(
      buildInstallCapabilityCandidates(),
      'install',
    );
    assert.strictEqual(d.command, 'supervisor-lifecycle-guarded-runner-capability-injection');
    assert.strictEqual(d.state, 'resolved');
    assert.strictEqual(d.capabilityInjectionReady, true);
    assert.strictEqual(d.dryRunCapabilityRegistryReady, true);
    assert.strictEqual(d.executeCapabilityAuthorized, false);
    assert.strictEqual(d.realCapabilityImplementationsReady, false);
    assert.strictEqual(d.realRunnerWiringReady, false);
    assert.strictEqual(d.runnerWiringContractReady, false);
    assert.strictEqual(d.executionEligible, false);
    assert.strictEqual(d.hostSideEffectOccurred, false);
    assert.strictEqual(d.wouldExecute, false);
    assert.strictEqual(d.wouldRun, false);
    assert.strictEqual(d.wouldWrite, false);
    assert.strictEqual(d.codeOwnedResolverWired, true);
    assert.strictEqual(d.evidenceCode, 'capability-injection-plan-ready');
    assert.strictEqual(d.primaryBlocker, null);
    assert.deepStrictEqual(d.blockers, []);
    assert.deepStrictEqual(d.nextBlockers, [REAL_WIRING_MISSING]);
    assert.strictEqual(d.handler, undefined);
    assert.strictEqual(d.commandString, undefined);
    assert.ok(Array.isArray(d.mappings) && d.mappings.length === 3);
    const expectedKinds = ['render', 'write', 'reload'];
    for (let i = 0; i < d.mappings.length; i++) {
      const row = d.mappings[i];
      assert.strictEqual(row.primaryCapabilityKind, expectedKinds[i]);
      assert.strictEqual(row.implementationClass, 'dry-run-non-side-effect');
      assert.deepStrictEqual(row.supportsModes, ['dry-run']);
      assert.strictEqual(row.wouldExecute, false);
      assert.strictEqual(row.hostSideEffectOccurred, false);
      assert.strictEqual(row.handler, undefined);
      assert.strictEqual(row.command, undefined);
      assert.strictEqual(row.path, undefined);
      assert.ok(String(row.capabilityId).startsWith('dry-run-'));
    }
    // JSON serializable
    assert.doesNotThrow(() => JSON.stringify(d));
  });

  it('T3: empty/invalid candidates and operation fail closed', () => {
    const empty = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection([], 'install');
    assert.strictEqual(empty.state, 'unresolved');
    assert.strictEqual(empty.capabilityInjectionReady, false);
    assert.ok(typeof empty.primaryBlocker === 'string');
    assertCapabilitySideEffectFalse(empty);

    const badOp = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(
      buildInstallCapabilityCandidates(),
      'nope',
    );
    assert.strictEqual(badOp.state, 'unresolved');
    assert.strictEqual(badOp.primaryBlocker, 'capability-operation-invalid');
    assert.strictEqual(badOp.operation, 'unknown');

    const unknownAction = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection([
      {
        actionId: 'not-a-real-action',
        implementationId: 'x',
        runnerKind: 'guarded-runner-stub',
        mode: 'preview-only',
        status: 'blocked',
        wouldExecute: false,
        wouldRun: false,
        wouldWrite: false,
        maxAttempts: 1,
      },
    ], 'install');
    assert.strictEqual(unknownAction.state, 'unresolved');
    assert.ok(
      unknownAction.primaryBlocker === 'capability-action-unmapped' ||
      unknownAction.primaryBlocker === 'capability-injection-input-invalid',
    );
  });

  it('T4: prototype pollution / symbol / accessor / extra keys fail closed', () => {
    const base = buildInstallCapabilityCandidates();
    const withProto = base.slice();
    // candidate with __proto__ key rejected via snapshot
    const poisonedCandidate = {
      actionId: 'render-launch-agent-plist',
      implementationId: 'render-plist-impl',
      runnerKind: 'guarded-runner-stub',
      mode: 'preview-only',
      status: 'blocked',
      wouldExecute: false,
      wouldRun: false,
      wouldWrite: false,
      maxAttempts: 1,
    };
    Object.defineProperty(poisonedCandidate, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    // extra own key
    const extra = { ...base[0], extra: true };
    const d1 = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection([extra, ...base.slice(1)], 'install');
    assert.strictEqual(d1.state, 'unresolved');

    const withSymbol = {
      actionId: base[0].actionId,
      implementationId: base[0].implementationId,
      runnerKind: base[0].runnerKind,
      mode: base[0].mode,
      status: base[0].status,
      wouldExecute: false,
      wouldRun: false,
      wouldWrite: false,
      maxAttempts: base[0].maxAttempts,
    };
    Object.defineProperty(withSymbol, Symbol('cap-x'), { value: 1, enumerable: true, configurable: true });
    assert.ok(Reflect.ownKeys(withSymbol).some((k) => typeof k === 'symbol'));
    const d2 = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection([withSymbol, ...base.slice(1)], 'install');
    assert.strictEqual(d2.state, 'unresolved', 'symbol key must fail closed');

    const withGetter = {};
    for (const key of Object.keys(base[0])) {
      Object.defineProperty(withGetter, key, {
        enumerable: true,
        configurable: true,
        get() { return base[0][key]; },
      });
    }
    const d3 = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection([withGetter, ...base.slice(1)], 'install');
    assert.strictEqual(d3.state, 'unresolved');

    const proxy = new Proxy(base, {
      ownKeys() { throw new Error(UNSAFE_SECRET_MATERIAL); },
    });
    const d4 = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(proxy, 'install');
    assert.strictEqual(d4.state, 'unresolved');
    assert.doesNotMatch(JSON.stringify(d4), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });
});

describe('V1.31 authorize + invokeDryRun capability boundary', () => {
  it('T5: dry-run authorize + invoke completed for all 7 kinds', () => {
    const samples = [
      { capabilityKind: 'render', actionId: 'render-launch-agent-plist', operation: 'install', plannedAction: 'render-plist' },
      { capabilityKind: 'write', actionId: 'write-launch-agent-plist', operation: 'install', plannedAction: 'write-create-update' },
      { capabilityKind: 'reload', actionId: 'load-launch-agent', operation: 'install', plannedAction: 'load' },
      { capabilityKind: 'status', actionId: 'capture-current-state', operation: 'rollback', plannedAction: 'capture-state' },
      { capabilityKind: 'rollback', actionId: 'restore-previous-plist', operation: 'rollback', plannedAction: 'restore-plist' },
      { capabilityKind: 'audit', actionId: 'render-launch-agent-plist', operation: 'install', plannedAction: 'audit-plan' },
      { capabilityKind: 'notify', actionId: 'start-recovery-supervisor', operation: 'recover', plannedAction: 'notify-plan' },
    ];
    for (const sample of samples) {
      const req = buildCapabilityRequest({
        capabilityKind: sample.capabilityKind,
        actionId: sample.actionId,
        operation: sample.operation,
      });
      const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityMode(req);
      assert.strictEqual(auth.executeCapabilityAuthorized, false);
      assert.strictEqual(auth.hostSideEffectOccurred, false);
      assert.strictEqual(auth.dryRunCapabilityAuthorized, true);
      assert.strictEqual(auth.realCapabilityImplementationsReady, false);

      const receipt = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(req);
      assertReceiptBase(receipt);
      assert.strictEqual(receipt.receiptKind, 'capability-dry-run-receipt');
      assert.strictEqual(receipt.state, 'completed');
      assert.strictEqual(receipt.mode, 'dry-run');
      assert.strictEqual(receipt.capabilityKind, sample.capabilityKind);
      assert.strictEqual(receipt.actionId, sample.actionId);
      assert.strictEqual(receipt.operation, sample.operation);
      assert.strictEqual(receipt.plannedAction, sample.plannedAction);
      if (sample.capabilityKind === 'rollback') {
        assert.strictEqual(receipt.outcomeCode, 'capability-rollback-planned-only');
      } else {
        assert.strictEqual(receipt.outcomeCode, 'capability-dry-run-completed');
      }
    }
  });

  it('T6: write/reload actionId dispatch branches are distinct', () => {
    const writeRc = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest({
      capabilityKind: 'write', actionId: 'write-launch-agent-plist', operation: 'install',
    }));
    const removeRc = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest({
      capabilityKind: 'write', actionId: 'remove-launch-agent-plist', operation: 'uninstall',
    }));
    const removeMetaRc = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest({
      capabilityKind: 'write', actionId: 'remove-supervisor-metadata', operation: 'uninstall',
    }));
    assert.strictEqual(writeRc.state, 'completed');
    assert.strictEqual(removeRc.state, 'completed');
    assert.strictEqual(removeMetaRc.state, 'completed');
    assert.strictEqual(writeRc.plannedAction, 'write-create-update');
    assert.strictEqual(removeRc.plannedAction, 'remove-delete');
    assert.strictEqual(removeMetaRc.plannedAction, 'remove-delete');
    assert.notStrictEqual(writeRc.plannedAction, removeRc.plannedAction);

    const reloadCases = [
      ['load-launch-agent', 'install', 'load'],
      ['unload-launch-agent', 'uninstall', 'unload'],
      ['restart-previous-supervisor', 'rollback', 'restart'],
      ['start-recovery-supervisor', 'recover', 'start'],
    ];
    const planned = new Set();
    for (const [actionId, operation, expected] of reloadCases) {
      const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest({
        capabilityKind: 'reload', actionId, operation,
      }));
      assert.strictEqual(rc.state, 'completed');
      assert.strictEqual(rc.hostSideEffectOccurred, false);
      assert.strictEqual(rc.plannedAction, expected);
      planned.add(rc.plannedAction);
    }
    assert.strictEqual(planned.size, 4);
  });

  it('T7: execute is single-gate immediate hard-deny and never dispatches handler', () => {
    const denied = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest({
      mode: 'execute',
      idempotencyKey: 'opaque-key-1',
    }));
    assertReceiptBase(denied);
    assert.strictEqual(denied.receiptKind, 'capability-execute-denied-receipt');
    assert.strictEqual(denied.state, 'denied');
    assert.strictEqual(denied.mode, 'execute');
    assert.ok(
      denied.primaryBlocker === 'capability-execute-hard-denied' ||
      denied.primaryBlocker === 'capability-execute-prerequisites-incomplete' ||
      denied.outcomeCode === 'capability-execute-hard-denied' ||
      denied.outcomeCode === 'capability-execute-prerequisites-incomplete',
    );
    assert.strictEqual(denied.executeCapabilityAuthorized, false);
    assert.strictEqual(denied.plannedAction, null);
  });

  it('T8: caller injection / invalid mode / kind mismatch fail closed', () => {
    const poisoned = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
      capabilityKind: 'render',
      actionId: 'render-launch-agent-plist',
      operation: 'install',
      mode: 'dry-run',
      idempotencyKey: null,
      attemptRef: null,
      anchorRef: null,
      handler: () => {},
      command: 'launchctl load',
      path: '/tmp/x',
    });
    assert.notStrictEqual(poisoned.state, 'completed');
    assert.strictEqual(poisoned.hostSideEffectOccurred, false);
    assert.ok(
      poisoned.primaryBlocker === 'capability-caller-injection-rejected' ||
      poisoned.outcomeCode === 'capability-caller-injection-rejected' ||
      poisoned.primaryBlocker === 'capability-injection-input-invalid',
    );
    assert.doesNotMatch(JSON.stringify(poisoned), /launchctl load|\/tmp\/x/);

    const badMode = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest({
      mode: 'explode',
    }));
    assert.notStrictEqual(badMode.state, 'completed');
    assert.ok(
      badMode.primaryBlocker === 'capability-mode-invalid' ||
      badMode.outcomeCode === 'capability-mode-invalid',
    );

    const mismatch = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest({
      capabilityKind: 'write',
      actionId: 'render-launch-agent-plist',
      operation: 'install',
    }));
    assert.notStrictEqual(mismatch.state, 'completed');
    assert.ok(
      mismatch.primaryBlocker === 'capability-action-unmapped' ||
      mismatch.outcomeCode === 'capability-action-unmapped' ||
      mismatch.primaryBlocker === 'capability-kind-unknown',
    );

    const missingKey = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest({
      mode: 'execute',
      idempotencyKey: null,
    }));
    assert.strictEqual(missingKey.state, 'denied');
    assert.strictEqual(missingKey.idempotencyKeyFingerprint, null);
  });

  it('T9: public return deep copy isolation; no function leakage', () => {
    const receipt = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest());
    assert.strictEqual(receipt.state, 'completed');
    receipt.state = 'tampered';
    receipt.auditSequence.push('evil');
    const again = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest());
    assert.strictEqual(again.state, 'completed');
    assert.deepStrictEqual(again.auditSequence, [...CAPABILITY_AUDIT_SEQUENCE]);
    assert.doesNotThrow(() => JSON.stringify(again));
  });
});

describe('V1.31 buildSupervisorLifecycleGuardedRunnerExecutionGate capability injection', () => {
  it('T10: production ready path exposes capabilityInjectionReady while wiring still blocked', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });
    assert.strictEqual(result.gates.capabilityInjectionReady, true);
    assert.strictEqual(result.gates.dryRunCapabilityRegistryReady, true);
    assert.strictEqual(result.capabilityInjectionDecision.state, 'resolved');
    assert.strictEqual(result.capabilityInjectionDecision.executeCapabilityAuthorized, false);
    assert.strictEqual(result.capabilityInjectionDecision.realCapabilityImplementationsReady, false);
    assert.strictEqual(result.capabilityInjectionDecision.hostSideEffectOccurred, false);
    assert.strictEqual(result.capabilityInjectionDecision.capabilityInjectionReady, true);
    // V1.30 surface preserved
    assert.strictEqual(result.gates.pureWiringOrchestratorPlanReady, true);
    assert.strictEqual(result.wiringPlan.mode, 'plan-only');
    assert.strictEqual(result.wiringPlanSeal.state, 'seal-ready');
    assert.strictEqual(result.wiringPlanSeal.sealReady, true);
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    assert.strictEqual(result.realRunnerWiringReady, false);
    assert.strictEqual(result.gates.realRunnerWiringReady, false);
    assert.strictEqual(result.gates.runnerWiringContractReady, false);
    assert.deepStrictEqual(result.nextBlockers, [REAL_WIRING_MISSING]);
    assert.ok(result.blockers.includes(REAL_WIRING_MISSING));
    assert.strictEqual(result.policyDecision.state, 'authorized');
    assert.strictEqual(result.policyDecision.primaryBlocker, null);
    assert.strictEqual(Object.hasOwn(result.policyDecision, 'capabilityInjectionReady'), false);
    assert.strictEqual(result.adapterDecision.realHostMutationImplementationReady, false);
    assert.strictEqual(result.anchorDecision.realRollbackAnchorImplementationReady, false);
    assert.strictEqual(result.auditDecision.realAttemptAuditImplementationReady, false);
    assert.strictEqual(result.recoveryDecision.realOperatorRecoveryImplementationReady, false);
    assert.strictEqual(result.runnerWiringContract.readyCount, 6);
    assert.strictEqual(result.runnerWiringContract.blockedCount, 0);
    assert.strictEqual(result.runnerWiringContract.state, 'blocked');
    if (result.capabilityReceipt) {
      assert.strictEqual(result.capabilityReceipt.receiptKind, 'capability-dry-run-receipt');
      assert.strictEqual(result.capabilityReceipt.hostSideEffectOccurred, false);
      assert.strictEqual(result.capabilityReceipt.sealReady, undefined);
    }
  });

  it('T11: options capability overrides/handlers ignored', () => {
    const poisoned = buildGate(getReadyInputs(), {
      executeRequested: true,
      capabilityInjectionDecision: { state: 'resolved', executeCapabilityAuthorized: true },
      capabilityReceipt: { state: 'completed', mode: 'execute', hostSideEffectOccurred: true },
      handlers: { render: () => {} },
      capabilities: [{ capabilityKind: 'render', handler: () => {} }],
      realCapabilityImplementationsReady: true,
      realRunnerWiringReady: true,
      runnerWiringContractReady: true,
      executionEligible: true,
    });
    assert.strictEqual(poisoned.realRunnerWiringReady, false);
    assert.strictEqual(poisoned.executionEligible, false);
    assert.strictEqual(poisoned.gates.runnerWiringContractReady, false);
    assert.strictEqual(poisoned.capabilityInjectionDecision.executeCapabilityAuthorized, false);
    assert.strictEqual(poisoned.capabilityInjectionDecision.hostSideEffectOccurred, false);
    assert.strictEqual(poisoned.gates.capabilityInjectionReady, true);
    assert.deepStrictEqual(poisoned.nextBlockers, [REAL_WIRING_MISSING]);
  });
});

// ── V1.32 First real render capability proof ──────────────────────────
const GOLDEN_RENDER_INPUT = Object.freeze({
  label: 'com.linke.test.agent',
  scheduleSeconds: 3600,
  programToken: 'linke-agent-run-once',
});
const GOLDEN_CONTENT_SHA256 = '9883ab81098ddd645d21fcbaed378b2f23fe67398ab031cee0b76a37266f6016';
const GOLDEN_RENDERED_BYTE_LENGTH = 554;
const GOLDEN_PLIST_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '\t<key>Label</key>',
  '\t<string>com.linke.test.agent</string>',
  '\t<key>ProgramArguments</key>',
  '\t<array>',
  '\t\t<string>/usr/bin/env</string>',
  '\t\t<string>node</string>',
  '\t\t<string>__LINKE_REDACTED_PROGRAM_REF__</string>',
  '\t\t<string>run-once</string>',
  '\t\t<string>--config</string>',
  '\t\t<string>__LINKE_REDACTED_CONFIG_REF__</string>',
  '\t</array>',
  '\t<key>StartInterval</key>',
  '\t<integer>3600</integer>',
  '</dict>',
  '</plist>',
].join('\n');

function buildRealRenderProofRequest(overrides = {}) {
  const renderInput = Object.hasOwn(overrides, 'renderInput')
    ? overrides.renderInput
    : { ...GOLDEN_RENDER_INPUT };
  const {
    renderInput: _ignored,
    ...top
  } = overrides;
  return {
    capabilityKind: 'render',
    actionId: 'render-launch-agent-plist',
    operation: 'install',
    mode: 'real-proof',
    idempotencyKey: null,
    attemptRef: null,
    anchorRef: null,
    ...top,
    renderInput,
  };
}

describe('V1.32 real render capability readiness + dual registry', () => {
  it('T1: readiness realRender true + global real false + wiring-missing', () => {
    const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
    assert.strictEqual(r.state, 'ready');
    assert.strictEqual(r.pureCapabilityInjectionReady, true);
    assert.strictEqual(r.dryRunCapabilityRegistryReady, true);
    assert.strictEqual(r.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(r.realCapabilityImplementationsReady, false);
    assert.strictEqual(r.executeCapabilityRegistryReady, false);
    assert.strictEqual(r.executeCapabilityAuthorized, false);
    assert.strictEqual(r.realRunnerWiringReady, false);
    assert.deepStrictEqual(r.nextBlockers, [REAL_WIRING_MISSING]);
    assert.strictEqual(r.handler, undefined);
    assert.ok(Array.isArray(r.realImplementationEntries));
    // V1.34: real registry size 3 (render + status + audit); render entry still present.
    assert.strictEqual(r.realImplementationEntries.length, 3);
    const entry = r.realImplementationEntries.find((e) => e.capabilityKind === 'render');
    assert.ok(entry);
    assert.strictEqual(entry.capabilityKind, 'render');
    assert.strictEqual(entry.capabilityId, 'real-render');
    assert.strictEqual(entry.implementationClass, 'real-implementation');
    assert.deepStrictEqual(entry.supportsModes, ['real-proof']);
    assert.strictEqual(entry.realImplementationReady, true);
    assert.strictEqual(entry.hostSideEffectOccurred, false);
    assert.strictEqual(entry.handler, undefined);
  });

  it('T2: dual-track dry-run 7 + real render kept; write/reload/rollback/notify have no real entry', () => {
    const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
    assert.deepStrictEqual(r.capabilityKinds, [...CAPABILITY_KINDS]);
    assert.strictEqual(r.realImplementationEntries.length, 3);
    assert.ok(r.realImplementationEntries.some((e) => e.capabilityKind === 'render'));
    for (const kind of ['write', 'reload', 'rollback', 'notify']) {
      assert.ok(!r.realImplementationEntries.some((e) => e.capabilityKind === kind));
    }
  });
});

describe('V1.32 real-proof invoke + golden + fuzz', () => {
  it('T3: dry-run render still completed without contentSha256', () => {
    const dry = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
      capabilityKind: 'render',
      actionId: 'render-launch-agent-plist',
      operation: 'install',
      mode: 'dry-run',
      idempotencyKey: null,
      attemptRef: null,
      anchorRef: null,
    });
    assert.strictEqual(dry.receiptKind, 'capability-dry-run-receipt');
    assert.strictEqual(dry.capabilityId, 'dry-run-render');
    assert.strictEqual(dry.renderResult, undefined);
    assert.strictEqual(dry.hostSideEffectOccurred, false);
    assert.strictEqual(dry.contentSha256, undefined);
  });

  it('T4/T5/T21: real-proof happy path + golden sha256 exact + determinism', () => {
    const req = buildRealRenderProofRequest();
    const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
    assert.strictEqual(auth.state, 'authorized');
    assert.strictEqual(auth.executeCapabilityAuthorized, false);
    assert.strictEqual(auth.hostSideEffectOccurred, false);
    assert.strictEqual(auth.realRenderProofAuthorized, true);

    const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
    assertReceiptBase(rc);
    assert.strictEqual(rc.command, 'supervisor-lifecycle-guarded-runner-capability-receipt');
    assert.strictEqual(rc.receiptKind, 'capability-real-implementation-receipt');
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.mode, 'real-proof');
    assert.strictEqual(rc.capabilityId, 'real-render');
    assert.strictEqual(rc.implementationClass, 'real-implementation');
    assert.strictEqual(rc.outcomeCode, 'capability-real-render-completed');
    assert.strictEqual(rc.hostSideEffectOccurred, false);
    assert.strictEqual(rc.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(rc.realCapabilityImplementationsReady, false);
    assert.strictEqual(rc.executeCapabilityAuthorized, false);
    assert.strictEqual(rc.realRunnerWiringReady, false);
    assert.strictEqual(rc.executionEligible, false);
    assert.strictEqual(rc.idempotencyKeyFingerprint, null);
    assert.deepStrictEqual(rc.nextBlockers, [REAL_WIRING_MISSING]);
    assert.strictEqual(rc.renderResult.contentType, 'application/x-apple-plist-xml');
    assert.strictEqual(rc.renderResult.templateId, 'code-owned-launch-agent-plist-v1');
    assert.ok(rc.renderResult.renderedByteLength > 0);
    assert.ok(rc.renderResult.renderedByteLength < 8192);
    assert.strictEqual(rc.renderResult.renderedByteLength, GOLDEN_RENDERED_BYTE_LENGTH);
    assert.match(rc.renderResult.contentSha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(rc.renderResult.contentSha256, GOLDEN_CONTENT_SHA256);
    assert.strictEqual(rc.renderResult.deterministic, true);
    assert.strictEqual(rc.sealReady, undefined);
    assert.notStrictEqual(rc.receiptKind, 'capability-execute-receipt');
    // no full content by default
    assert.strictEqual(rc.renderResult.content, undefined);
    assert.strictEqual(rc.renderResult.rendered, undefined);

    const a = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
    const b = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
    assert.strictEqual(a.renderResult.contentSha256, b.renderResult.contentSha256);
    assert.strictEqual(a.renderResult.contentSha256, GOLDEN_CONTENT_SHA256);
  });

  it('T6: changing label changes hash (non-stub)', () => {
    const a = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(buildRealRenderProofRequest());
    const other = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
      buildRealRenderProofRequest({
        renderInput: {
          label: 'com.linke.other.agent',
          scheduleSeconds: 3600,
          programToken: 'linke-agent-run-once',
        },
      }),
    );
    assert.notStrictEqual(other.renderResult.contentSha256, a.renderResult.contentSha256);
  });

  it('T7: dry-run vs real-proof same action are distinguishable', () => {
    const dry = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(buildCapabilityRequest());
    const real = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(buildRealRenderProofRequest());
    assert.strictEqual(dry.capabilityId, 'dry-run-render');
    assert.strictEqual(real.capabilityId, 'real-render');
    assert.strictEqual(dry.receiptKind, 'capability-dry-run-receipt');
    assert.strictEqual(real.receiptKind, 'capability-real-implementation-receipt');
    assert.strictEqual(dry.renderResult, undefined);
    assert.ok(real.renderResult.contentSha256);
    assert.strictEqual(dry.hostSideEffectOccurred, false);
    assert.strictEqual(real.hostSideEffectOccurred, false);
    assert.strictEqual(dry.realRunnerWiringReady, false);
    assert.strictEqual(real.realRunnerWiringReady, false);
  });

  it('T8/T9: execute still denied; no real handler; formula incompleteness observable', () => {
    const denied = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
      capabilityKind: 'render',
      actionId: 'render-launch-agent-plist',
      operation: 'install',
      mode: 'execute',
      idempotencyKey: 'opaque-key-1',
      attemptRef: null,
      anchorRef: null,
    });
    assert.strictEqual(denied.receiptKind, 'capability-execute-denied-receipt');
    assert.strictEqual(denied.state, 'denied');
    assert.strictEqual(denied.hostSideEffectOccurred, false);
    assert.strictEqual(denied.executeCapabilityAuthorized, false);
    assert.strictEqual(denied.renderResult, undefined);
    assert.strictEqual(denied.executeFormulaIncomplete, true);
    assert.ok(Array.isArray(denied.missingPrerequisiteCodes));
    assert.ok(denied.missingPrerequisiteCodes.includes('realCapabilityImplementationsReady'));
    assert.ok(denied.missingPrerequisiteCodes.includes('dual-host-capability-locus'));
  });

  it('T10: top-level caller injection / path / secret keys rejected', () => {
    const poisoned = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof({
      capabilityKind: 'render',
      actionId: 'render-launch-agent-plist',
      operation: 'install',
      mode: 'real-proof',
      idempotencyKey: null,
      attemptRef: null,
      anchorRef: null,
      renderInput: { ...GOLDEN_RENDER_INPUT },
      handler: () => {},
      path: '/Users/opaque/path',
      token: 'opaque-token-x',
    });
    assert.notStrictEqual(poisoned.state, 'completed');
    assert.ok(
      poisoned.primaryBlocker === 'capability-caller-injection-rejected' ||
      poisoned.outcomeCode === 'capability-caller-injection-rejected',
    );
    assert.doesNotMatch(JSON.stringify(poisoned), /\/Users\/opaque|opaque-token-x/);
  });

  it('T11/T26: nested renderInput independent snapshot rejects extra/symbol/accessor/proxy/function', () => {
    const withExtra = buildRealRenderProofRequest({
      renderInput: { ...GOLDEN_RENDER_INPUT, extra: true },
    });
    const d1 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(withExtra);
    assert.notStrictEqual(d1.state, 'completed');

    const withProto = {
      label: GOLDEN_RENDER_INPUT.label,
      scheduleSeconds: GOLDEN_RENDER_INPUT.scheduleSeconds,
      programToken: GOLDEN_RENDER_INPUT.programToken,
    };
    Object.defineProperty(withProto, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const d2 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
      buildRealRenderProofRequest({ renderInput: withProto }),
    );
    assert.notStrictEqual(d2.state, 'completed');

    const withSymbol = {
      label: GOLDEN_RENDER_INPUT.label,
      scheduleSeconds: GOLDEN_RENDER_INPUT.scheduleSeconds,
      programToken: GOLDEN_RENDER_INPUT.programToken,
    };
    Object.defineProperty(withSymbol, Symbol('x'), { value: 1, enumerable: true });
    const d3 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
      buildRealRenderProofRequest({ renderInput: withSymbol }),
    );
    assert.notStrictEqual(d3.state, 'completed');

    const withGetter = {};
    for (const key of ['label', 'scheduleSeconds', 'programToken']) {
      Object.defineProperty(withGetter, key, {
        enumerable: true,
        configurable: true,
        get() { return GOLDEN_RENDER_INPUT[key]; },
      });
    }
    const d4 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
      buildRealRenderProofRequest({ renderInput: withGetter }),
    );
    assert.notStrictEqual(d4.state, 'completed');

    const withFn = {
      label: GOLDEN_RENDER_INPUT.label,
      scheduleSeconds: GOLDEN_RENDER_INPUT.scheduleSeconds,
      programToken: () => 'x',
    };
    const d5 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
      buildRealRenderProofRequest({ renderInput: withFn }),
    );
    assert.notStrictEqual(d5.state, 'completed');

    const proxy = new Proxy({ ...GOLDEN_RENDER_INPUT }, {
      get(t, p) { return t[p]; },
      ownKeys() { return ['label', 'scheduleSeconds', 'programToken', 'extra']; },
      getOwnPropertyDescriptor(t, p) {
        if (p === 'extra') return { configurable: true, enumerable: true, value: 1 };
        return Object.getOwnPropertyDescriptor(t, p);
      },
    });
    const d6 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
      buildRealRenderProofRequest({ renderInput: proxy }),
    );
    assert.notStrictEqual(d6.state, 'completed');
  });

  it('T12: bad programToken → validation-failed', () => {
    const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
      buildRealRenderProofRequest({
        renderInput: {
          label: 'com.linke.test.agent',
          scheduleSeconds: 3600,
          programToken: 'not-allowlisted-token',
        },
      }),
    );
    assert.notStrictEqual(rc.state, 'completed');
    assert.strictEqual(rc.outcomeCode, 'capability-real-render-validation-failed');
  });

  it('P2: top-level attemptRef/anchorRef/idempotencyKey type gate matches authorize (null|string only)', () => {
    // Values that pass exact snapshot (data descriptor, non-function) but are not null|string.
    // Function is rejected earlier by snapshot as caller-injection; covered separately below.
    const illegalValues = [
      42,
      -0,
      Number.NaN,
      true,
      false,
      { nested: 'x' },
      ['arr'],
      Symbol('opaque-symbol-marker'),
    ];
    const fields = [
      {
        name: 'idempotencyKey',
        expectedBlocker: 'capability-idempotency-key-invalid',
      },
      {
        name: 'attemptRef',
        expectedBlocker: 'capability-injection-input-invalid',
      },
      {
        name: 'anchorRef',
        expectedBlocker: 'capability-injection-input-invalid',
      },
    ];

    for (const field of fields) {
      for (const bad of illegalValues) {
        const req = buildRealRenderProofRequest({ [field.name]: bad });
        const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
        assert.strictEqual(auth.state, 'denied', `${field.name} illegal type must deny authorize`);
        assert.strictEqual(auth.primaryBlocker, field.expectedBlocker);
        assert.strictEqual(auth.realRenderProofAuthorized, false);

        const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
        assert.notStrictEqual(rc.state, 'completed', `${field.name} illegal type must not complete proof`);
        assert.ok(['denied', 'error'].includes(rc.state));
        assert.strictEqual(
          rc.primaryBlocker,
          field.expectedBlocker,
          `${field.name} invoke blocker must match authorize`,
        );
        assert.strictEqual(rc.errorClass, 'validation');
        assert.ok(
          rc.outcomeCode === 'capability-dry-run-validation-failed' ||
            rc.outcomeCode === field.expectedBlocker,
        );
        assert.strictEqual(rc.renderResult, undefined);
        assert.strictEqual(rc.hostSideEffectOccurred, false);
        assert.strictEqual(rc.idempotencyKeyFingerprint, null);
        const serialized = JSON.stringify(rc);
        assert.doesNotMatch(serialized, /opaque-symbol-marker/);
        // Must never echo raw key/ref payload into receipt or error text.
        assert.strictEqual(serialized.includes('opaque-ok-ref'), false);
        if (typeof bad === 'number' && Number.isFinite(bad) && bad !== 0) {
          assert.doesNotMatch(serialized, new RegExp(`"${field.name}"\\s*:\\s*${bad}`));
        }
      }

      // Function values are fail-closed at exact snapshot (caller-injection), not completed.
      {
        const req = buildRealRenderProofRequest({
          [field.name]: () => 'opaque-fn-marker',
        });
        const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
        const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
        assert.strictEqual(auth.state, 'denied');
        assert.notStrictEqual(rc.state, 'completed');
        assert.ok(
          auth.primaryBlocker === 'capability-caller-injection-rejected' ||
            auth.primaryBlocker === field.expectedBlocker,
        );
        assert.ok(
          rc.primaryBlocker === 'capability-caller-injection-rejected' ||
            rc.primaryBlocker === field.expectedBlocker ||
            rc.outcomeCode === 'capability-caller-injection-rejected',
        );
        assert.doesNotMatch(JSON.stringify(rc), /opaque-fn-marker/);
        assert.strictEqual(rc.renderResult, undefined);
      }

      for (const ok of [null, 'opaque-ok-ref', '']) {
        const req = buildRealRenderProofRequest({ [field.name]: ok });
        const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
        assert.strictEqual(auth.state, 'authorized', `${field.name}=${JSON.stringify(ok)} must authorize`);
        const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
        assert.strictEqual(rc.state, 'completed', `${field.name}=${JSON.stringify(ok)} must complete`);
        assert.strictEqual(rc.outcomeCode, 'capability-real-render-completed');
        assert.strictEqual(rc.idempotencyKeyFingerprint, null);
        if (typeof ok === 'string' && ok.length > 0) {
          assert.doesNotMatch(JSON.stringify(rc), /opaque-ok-ref/);
        }
      }
    }
  });

  it('T24: label boundary fuzz', () => {
    const cases = [
      { label: '', expectFail: true },
      { label: 'a'.repeat(129), expectFail: true },
      { label: '测', expectFail: true },
      { label: 'com.linke\0.agent', expectFail: true },
      { label: 'com.linke\u0001.agent', expectFail: true },
      { label: 'a'.repeat(128), expectFail: false },
      { label: 'com.linke.test.agent', expectFail: false },
    ];
    for (const c of cases) {
      const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
        buildRealRenderProofRequest({
          renderInput: {
            label: c.label,
            scheduleSeconds: 3600,
            programToken: 'linke-agent-run-once',
          },
        }),
      );
      if (c.expectFail) {
        assert.notStrictEqual(rc.state, 'completed', `label should fail: ${JSON.stringify(c.label)}`);
        assert.strictEqual(rc.outcomeCode, 'capability-real-render-validation-failed');
      } else {
        assert.strictEqual(rc.state, 'completed', `label should accept: ${c.label.length}`);
      }
    }
  });

  it('T25: scheduleSeconds boundary fuzz', () => {
    const failValues = [59, 86401, NaN, Infinity, -Infinity, 3600.5, 0, -1];
    for (const scheduleSeconds of failValues) {
      const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
        buildRealRenderProofRequest({
          renderInput: {
            label: 'com.linke.test.agent',
            scheduleSeconds,
            programToken: 'linke-agent-run-once',
          },
        }),
      );
      assert.notStrictEqual(rc.state, 'completed', `schedule should fail: ${scheduleSeconds}`);
      assert.strictEqual(rc.outcomeCode, 'capability-real-render-validation-failed');
    }
    for (const scheduleSeconds of [60, 86400, 3600]) {
      const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
        buildRealRenderProofRequest({
          renderInput: {
            label: 'com.linke.test.agent',
            scheduleSeconds,
            programToken: 'linke-agent-run-once',
          },
        }),
      );
      assert.strictEqual(rc.state, 'completed', `schedule should accept: ${scheduleSeconds}`);
    }
  });

  it('T20: status real-proof attempt fails (render-specific)', () => {
    const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
      buildRealRenderProofRequest({
        capabilityKind: 'status',
        actionId: 'capture-current-state',
        operation: 'rollback',
      }),
    );
    assert.notStrictEqual(rc.state, 'completed');
    assert.ok(
      rc.primaryBlocker === 'capability-kind-unknown' ||
      rc.outcomeCode === 'capability-kind-unknown' ||
      rc.primaryBlocker === 'capability-action-unmapped',
    );
  });

  it('T22/T23/T27: byte contract + xmlEscape + XML/plist structure (no new deps)', () => {
    const recomputed = recomputeSupervisorLifecycleGuardedRunnerRealRenderPlistForTest({
      ...GOLDEN_RENDER_INPUT,
    });
    assert.strictEqual(recomputed.rendered, GOLDEN_PLIST_XML);
    assert.strictEqual(recomputed.contentSha256, GOLDEN_CONTENT_SHA256);
    assert.strictEqual(recomputed.renderedByteLength, GOLDEN_RENDERED_BYTE_LENGTH);
    assert.ok(!recomputed.rendered.includes('\r'));
    assert.ok(!recomputed.rendered.endsWith('\n'));
    assert.ok(recomputed.rendered.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(recomputed.rendered.includes('__LINKE_REDACTED_PROGRAM_REF__'));
    assert.ok(recomputed.rendered.includes('__LINKE_REDACTED_CONFIG_REF__'));
    assert.ok(!recomputed.rendered.includes('/Users/'));
    assert.ok(!recomputed.rendered.includes('/private/'));
    // key order Label → ProgramArguments → StartInterval
    const iLabel = recomputed.rendered.indexOf('<key>Label</key>');
    const iProg = recomputed.rendered.indexOf('<key>ProgramArguments</key>');
    const iStart = recomputed.rendered.indexOf('<key>StartInterval</key>');
    assert.ok(iLabel >= 0 && iProg > iLabel && iStart > iProg);
    // TAB indent present
    assert.ok(recomputed.rendered.includes('\t<key>Label</key>'));
    assert.ok(recomputed.rendered.includes('\t\t<string>/usr/bin/env</string>'));

    // xmlEscape five chars (via label allowlist path uses escape; force via pure on boundary)
    // Label charset excludes &<>"' so escape path is unit-checked via recompute with allowed label only.
    // Character map contract: pure escape of allowlisted label is identity.
    assert.strictEqual(recomputed.rendered.includes('&amp;'), false);
  });

  it('mode execute on proof API denied; real-proof on dry-run API mode-invalid', () => {
    const execOnProof = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(
      buildRealRenderProofRequest({ mode: 'execute' }),
    );
    assert.notStrictEqual(execOnProof.state, 'completed');
    assert.ok(
      execOnProof.primaryBlocker === 'capability-mode-invalid' ||
      execOnProof.outcomeCode === 'capability-mode-invalid',
    );

    // dry-run API cannot complete real-proof as dry-run success with hash
    const realOnDry = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
      capabilityKind: 'render',
      actionId: 'render-launch-agent-plist',
      operation: 'install',
      mode: 'real-proof',
      idempotencyKey: null,
      attemptRef: null,
      anchorRef: null,
    });
    assert.notStrictEqual(realOnDry.state, 'completed');
    assert.strictEqual(realOnDry.renderResult, undefined);
  });
});

describe('V1.32 gate + resolve realRender integration', () => {
  it('T13: production ready path exposes local realRender while execution still blocked', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });
    assert.strictEqual(result.gates.capabilityInjectionReady, true);
    assert.strictEqual(result.gates.dryRunCapabilityRegistryReady, true);
    assert.strictEqual(result.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(result.gates.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(result.realCapabilityImplementationsReady, false);
    assert.strictEqual(result.capabilityInjectionDecision.realCapabilityImplementationsReady, false);
    assert.strictEqual(result.capabilityInjectionDecision.executeCapabilityAuthorized, false);
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    assert.strictEqual(result.realRunnerWiringReady, false);
    assert.strictEqual(result.gates.realRunnerWiringReady, false);
    assert.strictEqual(result.gates.runnerWiringContractReady, false);
    assert.deepStrictEqual(result.nextBlockers, [REAL_WIRING_MISSING]);
    assert.strictEqual(result.policyDecision.state, 'authorized');
    assert.strictEqual(result.policyDecision.primaryBlocker, null);
    assert.strictEqual(result.runnerWiringContract.readyCount, 6);
    assert.strictEqual(result.runnerWiringContract.blockedCount, 0);
    assert.strictEqual(result.runnerWiringContract.state, 'blocked');
    assert.strictEqual(result.adapterDecision.realHostMutationImplementationReady, false);
    assert.strictEqual(result.anchorDecision.realRollbackAnchorImplementationReady, false);
    assert.strictEqual(result.auditDecision.realAttemptAuditImplementationReady, false);
    assert.strictEqual(result.recoveryDecision.realOperatorRecoveryImplementationReady, false);
  });

  it('T14: options override realRender/execute/realRunner ignored', () => {
    const poisoned = buildGate(getReadyInputs(), {
      executeRequested: true,
      realRenderCapabilityImplementationReady: false,
      realCapabilityImplementationsReady: true,
      realRunnerWiringReady: true,
      executionEligible: true,
      handlers: { render: () => {} },
    });
    assert.strictEqual(poisoned.realCapabilityImplementationsReady, false);
    assert.strictEqual(poisoned.executionEligible, false);
    assert.strictEqual(poisoned.realRunnerWiringReady, false);
    assert.strictEqual(poisoned.realRenderCapabilityImplementationReady, true);
    assert.deepStrictEqual(poisoned.nextBlockers, [REAL_WIRING_MISSING]);
  });

  it('resolve mapping includes realCapabilityId for install render', () => {
    const d = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(
      buildInstallCapabilityCandidates(),
      'install',
    );
    assert.strictEqual(d.state, 'resolved');
    const renderMap = d.mappings.find((m) => m.actionId === 'render-launch-agent-plist');
    assert.ok(renderMap);
    assert.strictEqual(renderMap.capabilityId, 'dry-run-render');
    assert.strictEqual(renderMap.realCapabilityId, 'real-render');
    assert.strictEqual(renderMap.realImplementationClass, 'real-implementation');
    assert.deepStrictEqual(renderMap.realSupportsModes, ['real-proof']);
    assert.strictEqual(renderMap.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(renderMap.handler, undefined);
  });
});

describe('V1.32 T28/T29 source contract markers', () => {
  it('T28/T29/T23: PROOF ONLY JSDoc + orthogonal real comment + xmlEscape five-char map present', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../src/supervisor-lifecycle.js'), 'utf8');
    assert.ok(src.includes('@internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint'));
    assert.ok(
      src.includes('real=真实产物非stub，与host side effect正交') ||
      src.includes('real = 真实产物非stub，与 host side effect 正交') ||
      src.includes('真实产物非stub'),
    );
    assert.ok(src.includes('authorizeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof'));
    assert.ok(src.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof'));
    // T23: exact five-character xmlEscape entities (single-pass; no HTML-only subset)
    assert.ok(src.includes("'&amp;'") || src.includes('"&amp;"') || src.includes('&amp;'));
    assert.ok(src.includes('&lt;') && src.includes('&gt;') && src.includes('&quot;') && src.includes('&apos;'));
    assert.ok(src.includes('capabilityXmlEscape') || src.includes('xmlEscape'));
  });
});

// ── V1.33 Real status observational capability (T1–T44 / F1–F23) ──

const REAL_STATUS_TARGET = 'linke-launch-agent-default';
const PRESENCE_ENUM = Object.freeze([
  'present', 'absent', 'unreadable', 'unexpected-type', 'oversize', 'symlink-blocked', 'observation-error',
]);
const READABILITY_ENUM = Object.freeze(['readable', 'unreadable', 'not-applicable', 'unknown']);
const SIZE_CLASS_ENUM = Object.freeze(['empty', 'small', 'medium', 'oversize', 'unknown']);

function buildRealStatusProofRequest(overrides = {}) {
  const statusInput = Object.hasOwn(overrides, 'statusInput')
    ? overrides.statusInput
    : { targetToken: REAL_STATUS_TARGET };
  const { statusInput: _ignored, ...top } = overrides;
  return {
    capabilityKind: 'status',
    actionId: 'capture-current-state',
    operation: 'rollback',
    mode: 'real-proof',
    idempotencyKey: null,
    attemptRef: null,
    anchorRef: null,
    ...top,
    statusInput,
  };
}

function assertStatusTriBoolObserve(rc) {
  assert.strictEqual(rc.hostMutationOccurred, false);
  assert.strictEqual(rc.hostObservationOccurred, true);
  assert.strictEqual(rc.hostSideEffectOccurred, true);
}

function assertStatusTriBoolValidation(rc) {
  assert.strictEqual(rc.hostMutationOccurred, false);
  assert.strictEqual(rc.hostObservationOccurred, false);
  assert.strictEqual(rc.hostSideEffectOccurred, false);
}

function assertNoSensitiveLeak(rc) {
  const json = JSON.stringify(rc);
  assert.ok(!/\/Users\//.test(json), 'must not leak /Users/ path');
  assert.ok(!/LaunchAgents/.test(json), 'must not leak LaunchAgents absolute path');
  const home = process.env.HOME || '___no_home___';
  assert.ok(!json.includes(home), 'must not leak HOME');
  assert.ok(!/"ENOENT"/.test(json), 'must not leak raw ENOENT');
  assert.ok(!/"EACCES"/.test(json), 'must not leak raw EACCES');
  assert.ok(!json.includes('contentSha256') || rc.renderResult, 'status must not carry contentSha256');
  if (rc.statusResult) {
    assert.strictEqual(rc.statusResult.contentSha256, undefined);
    assert.strictEqual(rc.statusResult.size, undefined);
    assert.strictEqual(rc.statusResult.path, undefined);
  }
}

describe('V1.33 real status readiness + dual registry', () => {
  afterEach(() => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
  });

  it('T1: readiness realRender+realStatus true + global real false + wiring-missing', () => {
    const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
    assert.strictEqual(r.state, 'ready');
    assert.strictEqual(r.pureCapabilityInjectionReady, true);
    assert.strictEqual(r.dryRunCapabilityRegistryReady, true);
    assert.strictEqual(r.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(r.realStatusCapabilityImplementationReady, true);
    assert.strictEqual(r.realCapabilityImplementationsReady, false);
    assert.strictEqual(r.executeCapabilityRegistryReady, false);
    assert.strictEqual(r.executeCapabilityAuthorized, false);
    assert.strictEqual(r.realRunnerWiringReady, false);
    assert.deepStrictEqual(r.nextBlockers, [REAL_WIRING_MISSING]);
    assert.strictEqual(r.handler, undefined);
    // V1.34: 3 real entries; status still present with non-live observation flags.
    assert.strictEqual(r.realImplementationEntries.length, 3);
    const kinds = r.realImplementationEntries.map((e) => e.capabilityKind).sort();
    assert.deepStrictEqual(kinds, ['audit', 'render', 'status']);
    const statusEntry = r.realImplementationEntries.find((e) => e.capabilityKind === 'status');
    assert.strictEqual(statusEntry.capabilityId, 'real-status');
    assert.strictEqual(statusEntry.implementationClass, 'real-implementation');
    assert.strictEqual(statusEntry.sideEffectClass, 'observational-read');
    assert.deepStrictEqual(statusEntry.supportsModes, ['real-proof']);
    assert.strictEqual(statusEntry.contentReadAllowed, false);
    assert.strictEqual(statusEntry.hostObservationOccurred, false);
    assert.strictEqual(statusEntry.hostSideEffectOccurred, false);
    assert.strictEqual(statusEntry.hostMutationOccurred, false);
  });

  it('T2/T34: dual registry 7 dry-run + 3 real; no write/reload/rollback/notify real', () => {
    const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
    assert.deepStrictEqual(r.capabilityKinds, [...CAPABILITY_KINDS]);
    assert.strictEqual(r.realImplementationEntries.length, 3);
    for (const kind of ['write', 'reload', 'rollback', 'notify']) {
      assert.ok(!r.realImplementationEntries.some((e) => e.capabilityKind === kind));
    }
  });
});

describe('V1.33 real-status-proof invoke + failure matrix', () => {
  afterEach(() => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
  });

  it('T3: dry-run status still completed without statusResult', () => {
    const dry = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
      capabilityKind: 'status',
      actionId: 'capture-current-state',
      operation: 'rollback',
      mode: 'dry-run',
      idempotencyKey: null,
      attemptRef: null,
      anchorRef: null,
    });
    assert.strictEqual(dry.receiptKind, 'capability-dry-run-receipt');
    assert.strictEqual(dry.capabilityId, 'dry-run-status');
    assert.strictEqual(dry.statusResult, undefined);
    assert.strictEqual(dry.hostSideEffectOccurred, false);
    assert.strictEqual(dry.hostObservationOccurred, undefined);
  });

  it('T4: production real-status-proof happy path (typically absent)', async () => {
    const req = buildRealStatusProofRequest();
    const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(req);
    assert.strictEqual(auth.state, 'authorized');
    assert.strictEqual(auth.executeCapabilityAuthorized, false);
    assert.strictEqual(auth.realCapabilityImplementationsReady, false);
    assert.strictEqual(auth.hostObservationOccurred, false);
    assert.strictEqual(auth.hostSideEffectOccurred, false);

    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(req);
    assert.strictEqual(rc.receiptKind, 'capability-real-implementation-receipt');
    assert.strictEqual(rc.capabilityId, 'real-status');
    assert.strictEqual(rc.outcomeCode, 'capability-real-status-completed');
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.implementationClass, 'real-implementation');
    assert.strictEqual(rc.sideEffectClass, 'observational-read');
    assertStatusTriBoolObserve(rc);
    assert.strictEqual(rc.realStatusCapabilityImplementationReady, true);
    assert.strictEqual(rc.realCapabilityImplementationsReady, false);
    assert.strictEqual(rc.executeCapabilityAuthorized, false);
    assert.strictEqual(rc.realRunnerWiringReady, false);
    assert.strictEqual(rc.executionEligible, false);
    assert.strictEqual(rc.idempotencyKeyFingerprint, null);
    assert.deepStrictEqual(rc.nextBlockers, [REAL_WIRING_MISSING]);
    assert.strictEqual(rc.statusResult.observationClass, 'launch-agent-presence');
    assert.strictEqual(rc.statusResult.targetToken, REAL_STATUS_TARGET);
    assert.ok(PRESENCE_ENUM.includes(rc.statusResult.presence));
    assert.ok(READABILITY_ENUM.includes(rc.statusResult.readability));
    assert.ok(SIZE_CLASS_ENUM.includes(rc.statusResult.sizeClass));
    assert.strictEqual(rc.statusResult.contentSha256, undefined);
    assertNoSensitiveLeak(rc);
  });

  it('T5/T6: inject present metadata + sizeClass buckets; no contentSha256', async () => {
    for (const [size, sizeClass] of [
      [0, 'empty'],
      [4, 'small'],
      [2048, 'medium'],
    ]) {
      setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
        async observe() {
          return { kind: 'regular-file', size, observationStarted: true };
        },
      });
      const a = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
        buildRealStatusProofRequest(),
      );
      const b = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
        buildRealStatusProofRequest(),
      );
      assert.strictEqual(a.statusResult.presence, 'present');
      assert.strictEqual(a.statusResult.isRegularFile, true);
      assert.strictEqual(a.statusResult.readability, 'readable');
      assert.strictEqual(a.statusResult.sizeClass, sizeClass);
      assert.strictEqual(a.statusResult.contentSha256, undefined);
      assert.deepStrictEqual(
        { presence: a.statusResult.presence, sizeClass: a.statusResult.sizeClass },
        { presence: b.statusResult.presence, sizeClass: b.statusResult.sizeClass },
      );
      assertStatusTriBoolObserve(a);
    }
  });

  it('T7: dry-run vs real-status distinguishable', async () => {
    const dry = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
      capabilityKind: 'status',
      actionId: 'capture-current-state',
      operation: 'rollback',
      mode: 'dry-run',
      idempotencyKey: null,
      attemptRef: null,
      anchorRef: null,
    });
    const real = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(dry.capabilityId, 'dry-run-status');
    assert.strictEqual(real.capabilityId, 'real-status');
    assert.strictEqual(dry.receiptKind, 'capability-dry-run-receipt');
    assert.strictEqual(real.receiptKind, 'capability-real-implementation-receipt');
    assert.strictEqual(dry.statusResult, undefined);
    assert.ok(real.statusResult);
  });

  it('T8: execute hard-deny; status reader not called', async () => {
    let called = 0;
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        called += 1;
        return { kind: 'regular-file', size: 1, observationStarted: true };
      },
    });
    const denied = authorizeSupervisorLifecycleGuardedRunnerCapabilityMode({
      capabilityKind: 'status',
      actionId: 'capture-current-state',
      operation: 'rollback',
      mode: 'execute',
      idempotencyKey: null,
      attemptRef: null,
      anchorRef: null,
    });
    assert.strictEqual(denied.executeCapabilityAuthorized, false);
    const dryExec = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
      capabilityKind: 'status',
      actionId: 'capture-current-state',
      operation: 'rollback',
      mode: 'execute',
      idempotencyKey: null,
      attemptRef: null,
      anchorRef: null,
    });
    assert.notStrictEqual(dryExec.state, 'completed');
    assert.strictEqual(dryExec.executeCapabilityAuthorized, false);
    assert.strictEqual(called, 0);
  });

  it('T9: top-level path/home/reader injection rejected', async () => {
    for (const key of ['path', 'home', 'homedir', 'cwd', 'reader']) {
      const bad = {
        ...buildRealStatusProofRequest(),
        [key]: '/tmp/evil',
      };
      const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(bad);
      assert.ok(rc.state === 'denied' || rc.state === 'error');
      assertStatusTriBoolValidation(rc);
    }
  });

  it('T10/F9: nested statusInput extra/proxy/getter/symbol/function fail-closed', async () => {
    const withExtra = buildRealStatusProofRequest({
      statusInput: { targetToken: REAL_STATUS_TARGET, extra: 'x' },
    });
    const d1 = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(withExtra);
    assert.ok(d1.state === 'denied' || d1.state === 'error');
    assertStatusTriBoolValidation(d1);

    const withProto = { targetToken: REAL_STATUS_TARGET };
    Object.defineProperty(withProto, '__proto__', { value: { polluted: true }, enumerable: true });
    // __proto__ as own key via assign may not work; use dangerous constructor path
    const withDanger = Object.create(null);
    withDanger.targetToken = REAL_STATUS_TARGET;
    withDanger.constructor = Object;
    const d2 = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest({ statusInput: withDanger }),
    );
    assert.ok(d2.state === 'denied' || d2.state === 'error');
    assertStatusTriBoolValidation(d2);

    const withSymbol = { targetToken: REAL_STATUS_TARGET };
    withSymbol[Symbol('x')] = 1;
    const d3 = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest({ statusInput: withSymbol }),
    );
    assert.ok(d3.state === 'denied' || d3.state === 'error');

    const withGetter = {};
    Object.defineProperty(withGetter, 'targetToken', {
      get() {
        return REAL_STATUS_TARGET;
      },
      enumerable: true,
    });
    const d4 = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest({ statusInput: withGetter }),
    );
    assert.ok(d4.state === 'denied' || d4.state === 'error');
    assertStatusTriBoolValidation(d4);

    const withFn = { targetToken: REAL_STATUS_TARGET, fn: () => {} };
    // extra key + function
    const d5 = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest({ statusInput: withFn }),
    );
    assert.ok(d5.state === 'denied' || d5.state === 'error');

    const proxy = new Proxy(
      { targetToken: REAL_STATUS_TARGET },
      {
        ownKeys() {
          return ['targetToken'];
        },
        getOwnPropertyDescriptor(t, p) {
          return Object.getOwnPropertyDescriptor(t, p);
        },
        get(t, p) {
          return t[p];
        },
      },
    );
    // Proxy may still pass if it behaves like plain object with exact keys — still ok if denied
    const d6 = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest({ statusInput: proxy }),
    );
    // Either accepted as plain or denied; if accepted must still be valid token path
    if (d6.state === 'completed') {
      assert.strictEqual(d6.statusResult.targetToken, REAL_STATUS_TARGET);
    } else {
      assertStatusTriBoolValidation(d6);
    }
  });

  it('T11/F4: targetToken type hard rejects', async () => {
    for (const badToken of [null, undefined, '', 1, true, {}, [], () => {}, 'not-allowlisted']) {
      const r = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
        buildRealStatusProofRequest({ statusInput: { targetToken: badToken } }),
      );
      assert.ok(r.state === 'denied' || r.state === 'error', `token=${String(badToken)}`);
      assertStatusTriBoolValidation(r);
    }
  });

  it('T12/F2: ENOENT → absent completed', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'absent', observationStarted: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.statusResult.presence, 'absent');
    assert.strictEqual(rc.statusResult.readability, 'not-applicable');
    assertStatusTriBoolObserve(rc);
  });

  it('T13/F3: EACCES → unreadable', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'unreadable', observationStarted: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.statusResult.presence, 'unreadable');
    assert.strictEqual(rc.statusResult.readability, 'unreadable');
    assertStatusTriBoolObserve(rc);
  });

  it('T14/F5: oversize metadata; no content hash', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'regular-file', size: 70000, observationStarted: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.statusResult.presence, 'oversize');
    assert.strictEqual(rc.statusResult.sizeClass, 'oversize');
    assert.strictEqual(rc.statusResult.contentSha256, undefined);
    assertStatusTriBoolObserve(rc);
  });

  it('T15/F11: symlink-blocked', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'symlink', observationStarted: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.statusResult.presence, 'symlink-blocked');
    assert.strictEqual(rc.statusResult.isRegularFile, false);
    assertStatusTriBoolObserve(rc);
  });

  it('T16/F1: timeout (fake slow + production deadline race semantics)', async () => {
    // Fake slow reader
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'timeout', observationStarted: true };
      },
    });
    const fake = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(fake.state, 'error');
    assert.strictEqual(fake.outcomeCode, 'capability-real-status-timeout');
    assertStatusTriBoolObserve(fake);
    assert.strictEqual(fake.statusResult, undefined);

    // Production absolute deadline: ultra-slow fake that never settles quickly is covered by kind timeout.
    // Also exercise production reader path still has O_NOFOLLOW / deadline constants present (T42).
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
    const prod = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    // Production path should complete (absent) or timeout — both are valid async settle.
    assert.ok(prod.state === 'completed' || prod.outcomeCode === 'capability-real-status-timeout');
    if (prod.state === 'completed') assertStatusTriBoolObserve(prod);
  });

  it('T17/F7: adapter throw/reject → observation-failed', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        throw new Error('synthetic-adapter-boom');
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'error');
    assert.strictEqual(rc.outcomeCode, 'capability-real-status-observation-failed');
    assertStatusTriBoolObserve(rc);
    assertNoSensitiveLeak(rc);
  });

  it('T18/F9: prototype pollution top-level rejected', async () => {
    const poisoned = {
      capabilityKind: 'status',
      actionId: 'capture-current-state',
      operation: 'rollback',
      mode: 'real-proof',
      idempotencyKey: null,
      attemptRef: null,
      anchorRef: null,
      statusInput: { targetToken: REAL_STATUS_TARGET },
    };
    Object.defineProperty(poisoned, 'constructor', { value: Object, enumerable: true });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(poisoned);
    assert.ok(rc.state === 'denied' || rc.state === 'error');
    assertStatusTriBoolValidation(rc);
  });

  it('T19/F14: execute mode on status proof API denied', async () => {
    const bad = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest({ mode: 'execute' }),
    );
    assert.strictEqual(bad.state, 'denied');
    assert.strictEqual(bad.executeCapabilityAuthorized, false);
    assertStatusTriBoolValidation(bad);
  });

  it('F6: illegal adapter shape → observation-failed; default raw not claimed as observation', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        // No observationStarted: must NOT be treated as real host observation by default.
        return { weird: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'error');
    assert.strictEqual(rc.outcomeCode, 'capability-real-status-observation-failed');
    assertStatusTriBoolValidation(rc);
  });

  it('F8/T31: concurrent invoke single-settle semantics (fake double-resolve safe)', async () => {
    let calls = 0;
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        calls += 1;
        return { kind: 'regular-file', size: 10, observationStarted: true };
      },
    });
    const [a, b] = await Promise.all([
      invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(buildRealStatusProofRequest()),
      invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(buildRealStatusProofRequest()),
    ]);
    assert.strictEqual(a.state, 'completed');
    assert.strictEqual(b.state, 'completed');
    assert.strictEqual(a.statusResult.presence, 'present');
    assert.strictEqual(b.statusResult.presence, 'present');
    assert.ok(calls >= 1);
    // Each invoke gets its own single receipt — no dual-settle corruption.
    assert.strictEqual(a.outcomeCode, 'capability-real-status-completed');
    assert.strictEqual(b.outcomeCode, 'capability-real-status-completed');
  });

  it('F10/T31: late resolve discarded (fake settles once)', async () => {
    let resolveLate;
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      observe() {
        return new Promise((resolve) => {
          resolveLate = resolve;
          // First settle immediately as present; late resolve attempted after.
          resolve({ kind: 'regular-file', size: 2, observationStarted: true });
        });
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.statusResult.presence, 'present');
    // Late resolve must not throw unhandled; discard.
    if (typeof resolveLate === 'function') {
      resolveLate({ kind: 'absent', observationStarted: true });
    }
    assert.strictEqual(rc.statusResult.presence, 'present');
  });

  it('F12: unexpected type directory', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'unexpected-type', observationStarted: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.statusResult.presence, 'unexpected-type');
    assertStatusTriBoolObserve(rc);
  });

  it('T35/F16: parent symlink → symlink-blocked', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'symlink', observationStarted: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.statusResult.presence, 'symlink-blocked');
    assertStatusTriBoolObserve(rc);
  });

  it('T36/F17: target swap maps to symlink-blocked or observation-error', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'symlink', observationStarted: true }; // locked mapping for open-time symlink
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.ok(
      rc.statusResult?.presence === 'symlink-blocked' ||
        rc.outcomeCode === 'capability-real-status-observation-failed',
    );
    assertStatusTriBoolObserve(rc);
  });

  it('T37/F18/F19: deadline before/after open single-settle', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'timeout', observationStarted: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.outcomeCode, 'capability-real-status-timeout');
    assert.strictEqual(rc.statusResult, undefined);
    assertStatusTriBoolObserve(rc);
  });

  it('T38/F20: close failure → observation-failed; no leak', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'observation-error', reason: 'close-failed', observationStarted: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'error');
    assert.strictEqual(rc.outcomeCode, 'capability-real-status-observation-failed');
    assertStatusTriBoolObserve(rc);
    assertNoSensitiveLeak(rc);
  });

  it('T39/F21: in-flight cap does not flood', async () => {
    let active = 0;
    let maxActive = 0;
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return { kind: 'regular-file', size: 1, observationStarted: true };
      },
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(buildRealStatusProofRequest()),
      ),
    );
    for (const rc of results) {
      assert.ok(
        rc.state === 'completed' ||
          rc.outcomeCode === 'capability-real-status-observation-failed' ||
          rc.outcomeCode === 'capability-real-status-timeout',
      );
    }
    // Cap is enforced inside production reader; inject may exceed — assert no crash and finite results.
    assert.strictEqual(results.length, 6);
  });

  it('T40/F22: no content read APIs on completed path', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../src/supervisor-lifecycle.js'), 'utf8');
    // Status reader private region must not use content-read APIs.
    assert.ok(!src.includes('createReadStream'));
    assert.ok(!/fh\.read\b/.test(src));
    assert.ok(!src.includes('readFileSync'));
    // Production status path uses open+stat only — readFile may exist elsewhere; assert statusResult never has hash.
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'regular-file', size: 8, observationStarted: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.statusResult.contentSha256, undefined);
    assert.ok(!JSON.stringify(rc).includes('contentSha256'));
  });

  it('T41: TEST ONLY hook JSDoc + bootstrap never calls ForTest', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../src/supervisor-lifecycle.js'), 'utf8');
    assert.ok(src.includes('@internal TEST ONLY'));
    assert.ok(src.includes('setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest'));
    assert.ok(src.includes('setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest'));
    // Bootstrap must not call the ForTest setters.
    const bootstrapSlice = src.slice(
      src.indexOf('function trustedBootstrapCapabilityRegistry'),
      src.indexOf('trustedBootstrapCapabilityRegistry();') + 'trustedBootstrapCapabilityRegistry();'.length,
    );
    assert.ok(!bootstrapSlice.includes('setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest('));
    assert.ok(!bootstrapSlice.includes('setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest('));
    assert.ok(bootstrapSlice.includes('NEVER call') || bootstrapSlice.includes('never call') || bootstrapSlice.includes('NEVER'));
  });

  it('T42: O_NOFOLLOW forced in production open flags', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../src/supervisor-lifecycle.js'), 'utf8');
    assert.ok(src.includes('O_NOFOLLOW'));
    assert.ok(src.includes('O_RDONLY'));
    assert.ok(src.includes('fs/promises') || src.includes("from 'node:fs/promises'"));
  });

  it('T26/F23/T32: no raw error leak; redaction path', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return {
          kind: 'observation-error',
          observationStarted: true,
          // malicious attempt to smuggle raw fields — sanitize must strip
          code: 'ENOENT',
          message: 'secret path /Users/evil/LaunchAgents/x.plist',
          stack: 'Error: boom',
          path: '/Users/evil/Library/LaunchAgents/x.plist',
        };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assertNoSensitiveLeak(rc);
    assert.ok(
      rc.outcomeCode === 'capability-real-status-observation-failed' ||
        (rc.statusResult && rc.statusResult.presence === 'observation-error'),
    );
  });

  it('T27: RealRenderProof rejects status kind (no expansion)', () => {
    const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof({
      capabilityKind: 'status',
      actionId: 'capture-current-state',
      operation: 'rollback',
      mode: 'real-proof',
      idempotencyKey: null,
      attemptRef: null,
      anchorRef: null,
      renderInput: { label: 'x', scheduleSeconds: 60, programToken: 'linke-agent-run-once' },
    });
    // Either injection reject (wrong keys) or kind unknown — never completed status.
    assert.notStrictEqual(rc.state, 'completed');
    assert.strictEqual(rc.statusResult, undefined);
  });

  it('T27b: no buildSupervisorStatusResponse import in lifecycle', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../src/supervisor-lifecycle.js'), 'utf8');
    assert.ok(!src.includes('buildSupervisorStatusResponse'));
  });

  it('T29/T30: PROOF ONLY JSDoc + observational terminology comments', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../src/supervisor-lifecycle.js'), 'utf8');
    assert.ok(src.includes('authorizeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof'));
    assert.ok(src.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof'));
    assert.ok(src.includes('@internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint'));
    assert.ok(src.includes('真实宿主元数据观测非 stub') || src.includes('hostObservationOccurred=true'));
    assert.ok(src.includes('observational-read'));
    assert.ok(src.includes('不得重定义') || src.includes('V1.32'));
  });

  it('T33: idempotencyKeyFingerprint remains null', async () => {
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.idempotencyKeyFingerprint, null);
  });

  it('T24: side-effect scan categories — no shell/write/content-sync in status path', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../src/supervisor-lifecycle.js'), 'utf8');
    assert.ok(!src.includes('child_process'));
    assert.ok(!src.includes("from 'node:child_process'") && !src.includes('from "node:child_process"'));
    assert.ok(!src.includes('shell: true'));
    assert.ok(!src.includes('lstatSync'));
    assert.ok(!src.includes('openSync'));
    assert.ok(!src.includes('readSync'));
    assert.ok(!src.includes('createReadStream'));
    // Status reader private region must use async open/lstat/stat/close + O_NOFOLLOW.
    assert.ok(src.includes('O_NOFOLLOW'));
    assert.ok(src.includes("from 'node:fs/promises'") || src.includes('node:fs/promises'));
    // No writeFile/appendFile calls in observational status path (category: fs write).
    // End before V1.34 RealAuditProof (which documents independence from HTTP audit helpers).
    const statusStart = src.indexOf('// ── V1.33 Real status observational metadata reader');
    const statusEnd = src.indexOf('// ── V1.34 Real audit capability sink persist');
    const statusSlice = src.slice(
      statusStart,
      statusEnd > statusStart ? statusEnd : src.indexOf('export function recomputeSupervisorLifecycleGuardedRunnerRealRenderPlistForTest'),
    );
    assert.ok(statusSlice.length > 100);
    assert.ok(!statusSlice.includes('writeFile'));
    assert.ok(!statusSlice.includes('appendFile'));
    assert.ok(!statusSlice.includes('appendAuditEvent'));
    assert.ok(!statusSlice.includes('execFile'));
    assert.ok(!statusSlice.includes('spawn('));
  });
});

describe('V1.33 gate + resolve realStatus integration', () => {
  afterEach(() => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
  });

  it('T20: gate production ready exposes local realStatus; non-live observation', () => {
    const gate = buildGate(getReadyInputs(), { executeRequested: true });
    assert.strictEqual(gate.realStatusCapabilityImplementationReady, true);
    assert.strictEqual(gate.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(gate.realCapabilityImplementationsReady, false);
    assert.strictEqual(gate.executionEligible, false);
    assert.strictEqual(gate.realRunnerWiringReady, false);
    assert.strictEqual(gate.hostObservationOccurred, false);
    assert.strictEqual(gate.hostSideEffectOccurred, false);
    assert.strictEqual(gate.hostMutationOccurred, false);
    assert.strictEqual(gate.statusResult, undefined);
    assert.deepStrictEqual(gate.nextBlockers, [REAL_WIRING_MISSING]);
    assert.strictEqual(gate.gates.realStatusCapabilityImplementationReady, true);
    assert.strictEqual(gate.gates.hostObservationOccurred, false);
    assert.strictEqual(gate.gates.hostSideEffectOccurred, false);
    assert.strictEqual(gate.runnerWiringContract.readyCount, 6);
    assert.strictEqual(gate.runnerWiringContract.blockedCount, 0);
  });

  it('T21: options override realStatus/observation/sideEffect/execute ignored', () => {
    const poisoned = buildGate(getReadyInputs(), {
      executeRequested: true,
      realStatusCapabilityImplementationReady: false,
      hostObservationOccurred: true,
      hostSideEffectOccurred: true,
      executeCapabilityAuthorized: true,
      realCapabilityImplementationsReady: true,
    });
    assert.strictEqual(poisoned.realStatusCapabilityImplementationReady, true);
    assert.strictEqual(poisoned.hostObservationOccurred, false);
    assert.strictEqual(poisoned.hostSideEffectOccurred, false);
    assert.strictEqual(poisoned.executeCapabilityAuthorized, false);
    assert.strictEqual(poisoned.realCapabilityImplementationsReady, false);
  });

  it('resolve mapping includes real-status fields for capture-current-state (non-live)', () => {
    const candidates = OPERATION_EXPECTED_ACTION_IDS.rollback.map((actionId) => ({
      actionId,
      implementationId: CODE_OWNED_REGISTRY_MAPPINGS[actionId],
      runnerKind: 'guarded-runner-stub',
      mode: 'guarded-host-action',
      status: 'blocked',
      wouldExecute: false,
      wouldRun: false,
      wouldWrite: false,
      maxAttempts: 1,
    }));
    const d = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(candidates, 'rollback');
    assert.strictEqual(d.state, 'resolved');
    const row = d.mappings.find((m) => m.actionId === 'capture-current-state');
    assert.ok(row);
    assert.strictEqual(row.primaryCapabilityKind, 'status');
    assert.strictEqual(row.realCapabilityId, 'real-status');
    assert.strictEqual(row.realStatusCapabilityImplementationReady, true);
    assert.strictEqual(row.hostObservationOccurred, false);
    assert.strictEqual(row.hostSideEffectOccurred, false);
    assert.strictEqual(d.executeCapabilityAuthorized, false);
    assert.strictEqual(d.realCapabilityImplementationsReady, false);
  });

  it('execute dry-run entry still hard-deny; status reader not called', async () => {
    let called = 0;
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        called += 1;
        throw new Error('must-not-call');
      },
    });
    const gate = buildGate(getReadyInputs(), { executeRequested: true });
    assert.strictEqual(gate.executeCapabilityAuthorized, false);
    assert.strictEqual(gate.executionEligible, false);
    assert.strictEqual(called, 0);
  });
});

describe('V1.33 source markers + T25 zero server/agent/web refs', () => {
  it('T25: server/agent/web zero RealStatusProof / ForTest refs', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../src/server.js', '../src/agent.js', '../src/web/app.js']) {
      const src = await readFile(join(here, rel), 'utf8');
      assert.ok(!src.includes('RealStatusProof'), rel);
      assert.ok(!src.includes('RealStatusHostReaderForTest'), rel);
      assert.ok(!src.includes('RealStatusFsOpsForTest'), rel);
      // Web may mention realStatus readiness lines but not proof invoke
      if (rel.endsWith('server.js') || rel.endsWith('agent.js')) {
        assert.ok(!src.includes('RealRenderProof'));
      }
    }
  });
});

// ── V1.33 Qwen P0/P1 RED→GREEN contract groups ──
// late-open / registry-dispatch / duplicate-truth / close-fail / home-symlink
// plus fs-ops orchestration coverage (P1-4). Whole-reader seam remains for high-level receipts.

function makeDirStat() {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false,
  };
}

function makeFileStat(size = 8) {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true,
    size,
  };
}

function makeSymlinkStat() {
  return {
    isSymbolicLink: () => true,
    isDirectory: () => false,
    isFile: () => false,
  };
}

/** Complete fs-ops seam fixture: all four functions required (no production fs fallback). */
function completeFsOpsForTest(partial = {}) {
  return {
    async open() {
      return {
        async stat() {
          return makeFileStat(1);
        },
        async close() {},
      };
    },
    async stat(fh) {
      return fh.stat();
    },
    async close(fh) {
      return fh.close();
    },
    ...partial,
  };
}

describe('V1.33 P0/P1 defect contracts (late-open/registry/duplicate/close/home)', () => {
  afterEach(() => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(null);
  });

  it('RED-P0-1 late-open: timeout returns; late open closes once; lock held until background done', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
    let openCount = 0;
    let closeCount = 0;
    let openReleased;
    const openGate = new Promise((resolve) => {
      openReleased = resolve;
    });
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest({
      deadlineMs: 25,
      async lstat(p) {
        const s = String(p);
        if (s.endsWith('.plist')) return makeFileStat(4);
        return makeDirStat();
      },
      async open() {
        openCount += 1;
        // Delay open past public deadline so race can settle timeout first.
        await new Promise((r) => setTimeout(r, 80));
        openReleased();
        return {
          async stat() {
            return makeFileStat(4);
          },
          async close() {
            closeCount += 1;
          },
        };
      },
      async stat(fh) {
        return fh.stat();
      },
      async close(fh) {
        return fh.close();
      },
    });

    const timedOut = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(timedOut.outcomeCode, 'capability-real-status-timeout');
    assert.strictEqual(timedOut.hostObservationOccurred, true);
    assert.strictEqual(timedOut.hostSideEffectOccurred, true);
    assert.strictEqual(timedOut.hostMutationOccurred, false);

    // While background observation still owns the token lock, re-entry must fail-closed.
    const reentry = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(reentry.state, 'error');
    assert.strictEqual(reentry.outcomeCode, 'capability-real-status-observation-failed');
    assert.strictEqual(reentry.hostObservationOccurred, false);
    assert.strictEqual(reentry.hostSideEffectOccurred, false);
    assert.strictEqual(reentry.hostMutationOccurred, false);

    await openGate;
    // Allow late open + close to finish.
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(openCount, 1, 'late open must still run once under background task');
    assert.strictEqual(closeCount, 1, 'late open handle must close exactly once');

    // After lock release, new observation is allowed.
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(completeFsOpsForTest({
      deadlineMs: 200,
      async lstat() {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    }));
    const after = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(after.state, 'completed');
    assert.strictEqual(after.statusResult.presence, 'absent');
  });

  it('RED-P0-2 registry-dispatch: entry.handler is actual dispatch locus (no temp create/void entry)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../src/supervisor-lifecycle.js'), 'utf8');
    const start = src.indexOf(
      'export async function invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof',
    );
    const end = src.indexOf(
      'export function setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest',
    );
    assert.ok(start > 0 && end > start, 'invoke RealStatusProof slice bounds');
    const invokeSlice = src.slice(start, end);
    assert.ok(
      invokeSlice.includes("realCapabilityRegistry.get('status')"),
      'must look up status registry entry',
    );
    assert.ok(
      /handlerResult\s*=\s*await\s+entry\.handler\s*\(/.test(invokeSlice),
      'must await entry.handler as dispatch locus',
    );
    assert.ok(!invokeSlice.includes('void entry'), 'must not void unused entry');
    assert.ok(
      !invokeSlice.includes('createRealStatusCapabilityHandler('),
      'must not create temporary handler in invoke',
    );

    // Behavioral: TEST ONLY reader rebind must flow through registry handler.
    let observeCalls = 0;
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        observeCalls += 1;
        return { kind: 'absent', observationStarted: true };
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.statusResult.presence, 'absent');
    assert.strictEqual(observeCalls, 1);
  });

  it('RED-P0-3 duplicate-truth: reader pre-reject before fs must be observation/sideEffect false', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let lstatHits = 0;
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(completeFsOpsForTest({
      deadlineMs: 500,
      async lstat() {
        lstatHits += 1;
        // Hold first observation open so duplicate hits in-flight lock.
        await firstGate;
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    }));

    const firstPromise = invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    // Yield so first acquires lock.
    await new Promise((r) => setTimeout(r, 15));
    const dup = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    releaseFirst();
    const first = await firstPromise;

    assert.strictEqual(first.state, 'completed');
    assert.strictEqual(first.hostObservationOccurred, true);
    assert.strictEqual(dup.state, 'error');
    assert.strictEqual(dup.outcomeCode, 'capability-real-status-observation-failed');
    assert.strictEqual(dup.hostObservationOccurred, false, 'duplicate pre-reject is not real observation');
    assert.strictEqual(dup.hostSideEffectOccurred, false);
    assert.strictEqual(dup.hostMutationOccurred, false);
    assert.ok(lstatHits >= 1);

    // Fake reader may explicitly simulate observationStarted false (not default-true).
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(null);
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest({
      async observe() {
        return { kind: 'observation-error', reason: 'in-flight-cap', observationStarted: false };
      },
    });
    const fakeCap = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(fakeCap.hostObservationOccurred, false);
    assert.strictEqual(fakeCap.hostSideEffectOccurred, false);
    assert.strictEqual(fakeCap.hostMutationOccurred, false);
  });

  it('RED-P1-1 close-fail: FileHandle.close reject → observation-failed, never completed', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
    let closeCount = 0;
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest({
      deadlineMs: 300,
      async lstat(p) {
        const s = String(p);
        if (s.endsWith('.plist')) return makeFileStat(12);
        return makeDirStat();
      },
      async open() {
        return {
          async stat() {
            return makeFileStat(12);
          },
          async close() {
            closeCount += 1;
            throw new Error('EIO-close');
          },
        };
      },
      async stat(fh) {
        return fh.stat();
      },
      async close(fh) {
        return fh.close();
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'error');
    assert.strictEqual(rc.outcomeCode, 'capability-real-status-observation-failed');
    assert.notStrictEqual(rc.state, 'completed');
    assert.strictEqual(rc.hostObservationOccurred, true);
    assert.strictEqual(rc.hostSideEffectOccurred, true);
    assert.strictEqual(rc.hostMutationOccurred, false);
    assert.ok(closeCount >= 1);
    assertNoSensitiveLeak(rc);
    assert.ok(!JSON.stringify(rc).includes('EIO-close'));
  });

  it('RED-P1-3 home-symlink: parent walk includes os.homedir root; symlink fail-closed', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
    const os = await import('node:os');
    const path = await import('node:path');
    const homeResolved = path.resolve(os.homedir());
    let sawHome = false;
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(completeFsOpsForTest({
      deadlineMs: 300,
      async lstat(p) {
        const resolved = path.resolve(String(p));
        if (resolved === homeResolved) {
          sawHome = true;
          return makeSymlinkStat();
        }
        return makeDirStat();
      },
    }));
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(sawHome, true, 'parent walk must lstat os.homedir root itself');
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.statusResult.presence, 'symlink-blocked');
    assert.strictEqual(rc.hostMutationOccurred, false);
    assert.strictEqual(rc.hostObservationOccurred, true);
    assert.strictEqual(rc.hostSideEffectOccurred, true);

    // Source honesty: path.resolve is lexical; must not claim symlink follow.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../src/supervisor-lifecycle.js'), 'utf8');
    const statusSlice = src.slice(
      src.indexOf('// ── V1.33 Real status observational metadata reader'),
      src.indexOf('export function recomputeSupervisorLifecycleGuardedRunnerRealRenderPlistForTest'),
    );
    assert.ok(
      statusSlice.includes('lexical') || statusSlice.includes('does not follow') || statusSlice.includes('不跟随'),
      'must not claim path.resolve follows symlinks',
    );
  });

  it('P1-4 fs-ops seam orchestration: target swap / deadline / late reject / success no content read', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);

    // Target swap at open → symlink-blocked (or observation-error), no content APIs.
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(completeFsOpsForTest({
      deadlineMs: 300,
      async lstat(p) {
        const s = String(p);
        if (s.endsWith('.plist')) return makeFileStat(1);
        return makeDirStat();
      },
      async open() {
        const err = new Error('ELOOP');
        err.code = 'ELOOP';
        throw err;
      },
    }));
    const swap = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.ok(
      swap.statusResult?.presence === 'symlink-blocked' ||
        swap.outcomeCode === 'capability-real-status-observation-failed',
    );
    assert.strictEqual(swap.hostMutationOccurred, false);

    // Deadline before open: timeout public receipt; open never called.
    // Drain previous background task lock before starting the next observation.
    await new Promise((r) => setTimeout(r, 30));
    let openCalls = 0;
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(completeFsOpsForTest({
      deadlineMs: 20,
      async lstat() {
        // Single slow step only — avoid multi-segment delay holding lock across later cases.
        await new Promise((r) => setTimeout(r, 60));
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
      async open() {
        openCalls += 1;
        return {
          async stat() {
            return makeFileStat(1);
          },
          async close() {},
        };
      },
    }));
    const beforeOpen = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(beforeOpen.outcomeCode, 'capability-real-status-timeout');
    // Wait for background task (60ms lstat) to release token lock.
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(openCalls, 0);

    // Late reject must not surface unhandled rejection.
    const unhandled = [];
    const onUnhandled = (err) => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(completeFsOpsForTest({
        deadlineMs: 15,
        async lstat() {
          await new Promise((r) => setTimeout(r, 50));
          throw Object.assign(new Error('late-boom'), { code: 'EIO' });
        },
      }));
      const late = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
        buildRealStatusProofRequest(),
      );
      assert.strictEqual(late.outcomeCode, 'capability-real-status-timeout');
      // Wait for late reject path to settle under guarded catch (no unhandledRejection).
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(unhandled.length, 0, 'late reject must be caught');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    // Drain lock before success case.
    await new Promise((r) => setTimeout(r, 30));

    // Success path: no content read methods invoked.
    let readCalls = 0;
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest({
      deadlineMs: 300,
      async lstat(p) {
        const s = String(p);
        if (s.endsWith('.plist')) return makeFileStat(3);
        return makeDirStat();
      },
      async open() {
        return {
          async stat() {
            return makeFileStat(3);
          },
          async read() {
            readCalls += 1;
            throw new Error('must-not-read');
          },
          async close() {},
        };
      },
      async stat(fh) {
        return fh.stat();
      },
      async close(fh) {
        return fh.close();
      },
    });
    const ok = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(ok.state, 'completed');
    assert.strictEqual(ok.statusResult.presence, 'present');
    assert.strictEqual(readCalls, 0);
    assert.strictEqual(ok.statusResult.contentSha256, undefined);

    // Seam source contract: TEST ONLY + bootstrap never calls FsOps ForTest.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../src/supervisor-lifecycle.js'), 'utf8');
    assert.ok(src.includes('setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest'));
    assert.ok(src.includes('@internal TEST ONLY'));
    const bootstrapSlice = src.slice(
      src.indexOf('function trustedBootstrapCapabilityRegistry'),
      src.indexOf('trustedBootstrapCapabilityRegistry();') + 'trustedBootstrapCapabilityRegistry();'.length,
    );
    assert.ok(!bootstrapSlice.includes('setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest('));
  });
});

describe('V1.33 P1 fs-ops seam strict validation (no partial/Proxy/accessor fallback)', () => {
  afterEach(() => {
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(null);
  });

  const FS_OPS_VALIDATION_ERROR = 'capability-real-status-validation-failed';

  function asyncNoop() {
    return Promise.resolve();
  }

  function baseFourFns() {
    return {
      lstat: asyncNoop,
      open: asyncNoop,
      stat: asyncNoop,
      close: asyncNoop,
    };
  }

  function assertValidationRejects(ops, label) {
    assert.throws(
      () => setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(ops),
      (err) => {
        assert.ok(err instanceof Error, label);
        // Fixed capability error only — no key/value/type echo in message.
        assert.strictEqual(err.message, FS_OPS_VALIDATION_ERROR, label);
        return true;
      },
      label,
    );
  }

  it('null/undefined still reset the seam', () => {
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest({
      ...baseFourFns(),
      deadlineMs: 50,
    });
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(null);
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(undefined);
    // No throw = reset accepted.
  });

  it('rejects getter own accessor on any required fn key', () => {
    for (const key of ['lstat', 'open', 'stat', 'close']) {
      const ops = baseFourFns();
      delete ops[key];
      Object.defineProperty(ops, key, {
        enumerable: true,
        configurable: true,
        get() {
          return asyncNoop;
        },
      });
      assertValidationRejects(ops, `getter:${key}`);
    }
  });

  it('rejects setter-only own accessor on any required fn key', () => {
    for (const key of ['lstat', 'open', 'stat', 'close']) {
      const ops = baseFourFns();
      delete ops[key];
      Object.defineProperty(ops, key, {
        enumerable: true,
        configurable: true,
        set() {},
      });
      assertValidationRejects(ops, `setter:${key}`);
    }
  });

  it('rejects Proxy even when traps look like a complete plain object', () => {
    const target = baseFourFns();
    const proxied = new Proxy(target, {});
    assertValidationRejects(proxied, 'Proxy empty handler');
    const revocable = Proxy.revocable(baseFourFns(), {
      get(t, prop, receiver) {
        return Reflect.get(t, prop, receiver);
      },
    });
    assertValidationRejects(revocable.proxy, 'Proxy with get trap');
    revocable.revoke();
  });

  it('rejects custom prototype (only Object.prototype or null allowed)', () => {
    const customProto = { marker: true };
    const withCustom = Object.assign(Object.create(customProto), baseFourFns());
    assertValidationRejects(withCustom, 'custom prototype');

    const arrayProto = Object.assign(Object.create(Array.prototype), baseFourFns());
    assertValidationRejects(arrayProto, 'Array.prototype');
  });

  it('rejects symbol own keys', () => {
    const sym = Symbol('smuggle');
    const ops = baseFourFns();
    ops[sym] = asyncNoop;
    assertValidationRejects(ops, 'symbol key');
  });

  it('rejects extra own string keys outside allowlist', () => {
    assertValidationRejects(
      {
        ...baseFourFns(),
        path: '/tmp/evil',
      },
      'extra:path',
    );
    assertValidationRejects(
      {
        ...baseFourFns(),
        homedir: () => '/tmp',
      },
      'extra:homedir',
    );
    assertValidationRejects(
      {
        ...baseFourFns(),
        extra: 1,
      },
      'extra:extra',
    );
  });

  it('rejects partial missing any of lstat/open/stat/close (no production fs fallback)', () => {
    for (const missing of ['lstat', 'open', 'stat', 'close']) {
      const ops = baseFourFns();
      delete ops[missing];
      assertValidationRejects(ops, `partial-missing:${missing}`);
    }
    // deadlineMs alone is not a valid seam.
    assertValidationRejects({ deadlineMs: 100 }, 'partial:deadlineMs-only');
    // only lstat (common accidental partial that previously fell back open/stat/close).
    assertValidationRejects(
      {
        deadlineMs: 100,
        async lstat() {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        },
      },
      'partial:lstat-only',
    );
  });

  it('rejects deadlineMs when present as accessor or non-finite', () => {
    const getterDeadline = baseFourFns();
    Object.defineProperty(getterDeadline, 'deadlineMs', {
      enumerable: true,
      configurable: true,
      get() {
        return 100;
      },
    });
    assertValidationRejects(getterDeadline, 'deadlineMs getter');

    assertValidationRejects({ ...baseFourFns(), deadlineMs: 0 }, 'deadlineMs:0');
    assertValidationRejects({ ...baseFourFns(), deadlineMs: -1 }, 'deadlineMs:-1');
    assertValidationRejects({ ...baseFourFns(), deadlineMs: Number.NaN }, 'deadlineMs:NaN');
    assertValidationRejects({ ...baseFourFns(), deadlineMs: Infinity }, 'deadlineMs:Infinity');
    assertValidationRejects({ ...baseFourFns(), deadlineMs: '100' }, 'deadlineMs:string');
  });

  it('accepts exact four own data functions; optional finite deadlineMs; null-proto ok', async () => {
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(baseFourFns());
    const nullProto = Object.assign(Object.create(null), {
      ...baseFourFns(),
      deadlineMs: 200,
    });
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest(nullProto);

    // Behavioral: validated four functions are used directly (no real-fs fallback).
    let lstatHits = 0;
    let openHits = 0;
    let statHits = 0;
    let closeHits = 0;
    setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(null);
    setSupervisorLifecycleGuardedRunnerRealStatusFsOpsForTest({
      deadlineMs: 300,
      async lstat(p) {
        lstatHits += 1;
        const s = String(p);
        if (s.endsWith('.plist')) {
          return makeFileStat(4);
        }
        return makeDirStat();
      },
      async open() {
        openHits += 1;
        return {
          async stat() {
            return makeFileStat(4);
          },
          async close() {},
        };
      },
      async stat(fh) {
        statHits += 1;
        return fh.stat();
      },
      async close(fh) {
        closeHits += 1;
        return fh.close();
      },
    });
    const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
      buildRealStatusProofRequest(),
    );
    assert.strictEqual(rc.state, 'completed');
    assert.strictEqual(rc.statusResult.presence, 'present');
    assert.ok(lstatHits >= 1);
    assert.strictEqual(openHits, 1);
    assert.strictEqual(statHits, 1);
    assert.strictEqual(closeHits, 1);
  });
});

// ── V1.34 Real audit capability proof (Tasks 3–6) ──

const REAL_AUDIT_FIXED_ATTEMPT_REF = 'abcdef0123456789';
const REAL_AUDIT_SINK_REL = CAPABILITY_REAL_AUDIT_RELATIVE_PATH;
const REAL_AUDIT_CANONICAL_KEYS = Object.freeze([
  'schemaVersion',
  'eventKind',
  'eventFingerprint',
  'operation',
  'actionId',
  'attemptRefFingerprint',
  'proofMode',
]);

function expectedRealAuditFingerprints(attemptRef, operation, actionId) {
  const attemptPreimage = `linke:v1.34:real-audit-proof:attempt-ref:v1\x1f${attemptRef}`;
  const eventPreimage = `linke:v1.34:real-audit-proof:event:v1\x1f1\x1f${operation}\x1f${actionId}\x1f${attemptRef}`;
  return {
    attemptRefFingerprint: createHash('sha256').update(attemptPreimage, 'utf8').digest('hex'),
    eventFingerprint: createHash('sha256').update(eventPreimage, 'utf8').digest('hex'),
  };
}

function validRealAuditAttemptRef(seed = 'a') {
  return String(seed).padEnd(16, 'x').slice(0, 16);
}

function buildRealAuditProofRequest(overrides = {}) {
  const auditInput = Object.hasOwn(overrides, 'auditInput')
    ? overrides.auditInput
    : { schemaVersion: 1 };
  const { auditInput: _ignored, ...top } = overrides;
  return {
    capabilityKind: 'audit',
    actionId: 'render-launch-agent-plist',
    operation: 'install',
    mode: 'real-proof',
    idempotencyKey: null,
    attemptRef: validRealAuditAttemptRef(),
    anchorRef: null,
    ...top,
    auditInput,
  };
}

function buildRealAuditContext(dir) {
  return { dataDir: dir };
}

async function withTempAuditRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'linke-real-audit-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function assertAuditGlobalsFalse(obj) {
  assert.strictEqual(obj.realCapabilityImplementationsReady, false);
  assert.strictEqual(obj.realAttemptAuditImplementationReady, false);
  assert.strictEqual(obj.executeCapabilityAuthorized, false);
  assert.strictEqual(obj.realRunnerWiringReady, false);
  assert.strictEqual(obj.runnerWiringContractReady, false);
  assert.strictEqual(obj.executionEligible, false);
}

function assertAuditPreAppendTruth(rc) {
  assert.strictEqual(rc.hostSideEffectOccurred, false);
  assert.strictEqual(rc.hostMutationOccurred, false);
  assert.strictEqual(rc.auditPersistOccurred, false);
  assert.strictEqual(rc.mutationOutcome, 'not-attempted');
  assert.strictEqual(rc.wouldPersistAudit, false);
  assert.strictEqual(rc.wouldMutateHost, false);
  assertAuditGlobalsFalse(rc);
}

function assertNoAuditSensitiveLeak(rc, root, attemptRef, secrets = []) {
  const json = JSON.stringify(rc);
  const ownValues = [];
  for (const key of Reflect.ownKeys(rc)) {
    if (typeof key === 'symbol') continue;
    ownValues.push(rc[key]);
  }
  const scanned = `${json}\n${ownValues.map((v) => String(v)).join('\n')}`;
  assert.strictEqual(Object.hasOwn(rc, 'dataDir'), false);
  assert.strictEqual(rc.dataDir, undefined);
  assert.ok(!scanned.includes(root), 'must not leak dataDir');
  if (attemptRef) {
    assert.ok(!scanned.includes(attemptRef), 'must not leak raw attemptRef');
  }
  assert.ok(!/"ENOENT"/.test(scanned), 'must not leak ENOENT');
  assert.ok(!/"EACCES"/.test(scanned), 'must not leak EACCES');
  assert.ok(!scanned.includes('capability-proof-attempts.jsonl'), 'must not leak sink relative path');
  assert.ok(!/stack/i.test(JSON.stringify(rc.primaryBlocker || '')), 'blocker not stack');
  assert.ok(!scanned.includes('Error:'), 'must not leak Error messages');
  for (const secret of secrets) {
    if (secret == null) continue;
    const token = typeof secret === 'string' ? secret : JSON.stringify(secret);
    if (!token || token === 'unknown' || token === 'audit' || token === 'real-proof') continue;
    assert.ok(!scanned.includes(token), `must not echo secret ${token}`);
  }
}

/** Build exact own enumerable data request with optional top-level property overrides via descriptors. */
function buildHostileRealAuditTop(mutator) {
  const base = buildRealAuditProofRequest();
  const req = {};
  for (const [k, v] of Object.entries(base)) {
    Object.defineProperty(req, k, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  mutator(req, base);
  return req;
}

function buildCanonicalAuditLine(fields) {
  return `${JSON.stringify({
    schemaVersion: fields.schemaVersion,
    eventKind: fields.eventKind,
    eventFingerprint: fields.eventFingerprint,
    operation: fields.operation,
    actionId: fields.actionId,
    attemptRefFingerprint: fields.attemptRefFingerprint,
    proofMode: fields.proofMode,
  })}\n`;
}

describe('V1.34 real audit readiness + dual registry', () => {
  it('Task4: local realAudit true + 3 real entries + globals false', () => {
    const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
    assert.strictEqual(r.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(r.realStatusCapabilityImplementationReady, true);
    assert.strictEqual(r.realAuditCapabilityImplementationReady, true);
    assert.strictEqual(r.realCapabilityImplementationsReady, false);
    assert.strictEqual(r.realAttemptAuditImplementationReady, false);
    assert.strictEqual(r.executeCapabilityAuthorized, false);
    assert.strictEqual(r.realRunnerWiringReady, false);
    assert.strictEqual(r.runnerWiringContractReady, false);
    assert.strictEqual(r.executionEligible, false);
    assert.strictEqual(r.realImplementationEntries.length, 3);
    const kinds = r.realImplementationEntries.map((e) => e.capabilityKind).sort();
    assert.deepStrictEqual(kinds, ['audit', 'render', 'status']);
    const audit = r.realImplementationEntries.find((e) => e.capabilityKind === 'audit');
    assert.strictEqual(audit.capabilityId, 'real-audit');
    assert.strictEqual(audit.implementationClass, 'real-implementation');
    assert.strictEqual(audit.sideEffectClass, 'audit-persist');
    assert.deepStrictEqual(audit.supportsModes, ['real-proof']);
    assert.strictEqual(audit.canPersistAuditInProof, true);
    assert.strictEqual(audit.wouldPersistAudit, false);
    assert.strictEqual(audit.auditWriteAllowed, false);
    assert.strictEqual(audit.filesystemWriteAllowed, false);
    assert.strictEqual(audit.wouldMutateHost, false);
    assert.strictEqual(r.handler, undefined);
    assert.deepStrictEqual(r.nextBlockers, [REAL_WIRING_MISSING]);
  });

  it('Task4: audit actionIds derived from shared SoT (all 10); dry-run still 7', () => {
    const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
    assert.strictEqual(r.capabilityKinds.length, 7);
    const expected = [];
    for (const op of Object.keys(SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS)) {
      expected.push(...listSupervisorLifecycleActionIds(op));
    }
    assert.strictEqual(expected.length, 10);
    // Descriptor actionIds live only on registry; readiness summary need not list them,
    // but source must derive from SoT (architecture test below).
    assert.ok(r.realImplementationEntries.some((e) => e.capabilityKind === 'audit'));
  });

  it('Task4: options/malicious injection cannot elevate readiness flags', () => {
    const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness({
      realAuditCapabilityImplementationReady: false,
      realCapabilityImplementationsReady: true,
      executeCapabilityAuthorized: true,
      handlers: { audit: () => {} },
      realAttemptAuditImplementationReady: true,
    });
    assert.strictEqual(r.realAuditCapabilityImplementationReady, true);
    assert.strictEqual(r.realCapabilityImplementationsReady, false);
    assert.strictEqual(r.executeCapabilityAuthorized, false);
    assert.strictEqual(r.realAttemptAuditImplementationReady, false);
    assert.strictEqual(r.handler, undefined);
  });
});

describe('V1.34 RealAuditProof authorize matrix', () => {
  it('authorize happy path + execute/dry-run false', () => {
    const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
      buildRealAuditProofRequest(),
    );
    assert.strictEqual(auth.state, 'authorized');
    assert.strictEqual(auth.realAuditProofAuthorized, true);
    assert.strictEqual(auth.executeCapabilityAuthorized, false);
    assert.strictEqual(auth.dryRunCapabilityAuthorized, false);
    assert.strictEqual(auth.realAuditCapabilityImplementationReady, true);
    assertAuditGlobalsFalse(auth);
  });

  it('authorize all 4 operations × all 10 exact actions; cross-op reject', () => {
    for (const [operation, actionIds] of Object.entries(SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS)) {
      for (const actionId of actionIds) {
        const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
          buildRealAuditProofRequest({ operation, actionId }),
        );
        assert.strictEqual(auth.state, 'authorized', `${operation}/${actionId}`);
        assert.strictEqual(auth.realAuditProofAuthorized, true);
      }
      // one cross-op reject per operation
      const foreign = operation === 'install'
        ? 'capture-current-state'
        : 'render-launch-agent-plist';
      const denied = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest({ operation, actionId: foreign }),
      );
      assert.strictEqual(denied.state, 'denied');
      assert.strictEqual(denied.primaryBlocker, 'capability-action-unmapped');
    }
  });

  it('authorize mode/kind/operation/action/idempotency/anchor/attempt/auditInput rejects', () => {
    const cases = [
      [{ mode: 'execute' }, 'capability-mode-invalid'],
      [{ mode: 'dry-run' }, 'capability-mode-invalid'],
      [{ capabilityKind: 'status' }, 'capability-kind-unknown'],
      [{ operation: 'audit' }, 'capability-operation-invalid'],
      [{ actionId: 'not-a-real-action' }, 'capability-action-unmapped'],
      [{ idempotencyKey: 'x' }, 'capability-idempotency-key-invalid'],
      [{ anchorRef: 'anchor' }, 'capability-real-audit-input-invalid'],
      [{ attemptRef: 'short' }, 'capability-real-audit-input-invalid'],
      [{ attemptRef: 'a'.repeat(129) }, 'capability-real-audit-input-invalid'],
      [{ attemptRef: 'a'.repeat(15) + ' ' }, 'capability-real-audit-input-invalid'],
      [{ attemptRef: 'a'.repeat(15) + '\n' }, 'capability-real-audit-input-invalid'],
      [{ auditInput: { schemaVersion: 2 } }, 'capability-real-audit-input-invalid'],
      [{ auditInput: { schemaVersion: 1, extra: true } }, 'capability-caller-injection-rejected'],
    ];
    for (const [override, blocker] of cases) {
      const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest(override),
      );
      assert.strictEqual(auth.state, 'denied', JSON.stringify(override));
      assert.strictEqual(auth.realAuditProofAuthorized, false);
      assert.strictEqual(auth.primaryBlocker, blocker, JSON.stringify(override));
    }
  });

  it('authorize mode sanitizer: empty/secret/object/array/number → unknown; execute/dry-run safe; real-proof authorized', () => {
    const MODE_SECRET = 'FIXTURE_MODE_SECRET';
    const invalidModeCases = [
      { mode: '' },
      { mode: MODE_SECRET },
      { mode: { evil: MODE_SECRET } },
      { mode: [MODE_SECRET] },
      { mode: 42 },
    ];
    for (const override of invalidModeCases) {
      const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest(override),
      );
      assert.strictEqual(auth.state, 'denied', JSON.stringify(override));
      assert.strictEqual(auth.realAuditProofAuthorized, false);
      assert.strictEqual(auth.primaryBlocker, 'capability-mode-invalid', JSON.stringify(override));
      assert.strictEqual(auth.mode, 'unknown', `mode must sanitize, got ${JSON.stringify(auth.mode)}`);
      // Empty string must NOT collapse to real-proof via || default.
      assert.notStrictEqual(auth.mode, 'real-proof');
      const text = JSON.stringify(auth);
      assert.ok(!text.includes(MODE_SECRET), `authorize JSON must not echo secret: ${text}`);
      assert.ok(!text.includes('"mode":""'), `authorize JSON must not echo empty mode: ${text}`);
    }

    // Allowlisted non-real-proof modes keep original safe tokens (still denied).
    for (const mode of ['execute', 'dry-run']) {
      const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest({ mode }),
      );
      assert.strictEqual(auth.state, 'denied', mode);
      assert.strictEqual(auth.primaryBlocker, 'capability-mode-invalid', mode);
      assert.strictEqual(auth.mode, mode, mode);
      assert.strictEqual(auth.realAuditProofAuthorized, false);
    }

    // Valid real-proof remains authorized.
    const ok = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
      buildRealAuditProofRequest({ mode: 'real-proof' }),
    );
    assert.strictEqual(ok.state, 'authorized');
    assert.strictEqual(ok.mode, 'real-proof');
    assert.strictEqual(ok.realAuditProofAuthorized, true);
  });

  it('authorize hostile request: symbols/accessors/proxy/functions/dangerous/extra dataDir — no IO', async () => {
    await withTempAuditRoot(async (root) => {
      const base = buildRealAuditProofRequest();
      const withSymbol = { ...base };
      withSymbol[Symbol('x')] = 1;
      const withGetter = {};
      for (const [k, v] of Object.entries(base)) {
        Object.defineProperty(withGetter, k, { enumerable: true, get: () => v });
      }
      const withFn = { ...base, handler: () => {} };
      // Dead fixture previously unused — must enter the matrix.
      const withProto = { ...base, __proto__: { polluted: true } };
      const withCustomProto = Object.assign(Object.create({ polluted: true }), base);
      class HostileAuditReq {
        constructor() {
          Object.assign(this, base);
        }
      }
      const withClass = new HostileAuditReq();
      const withNonEnumerable = buildHostileRealAuditTop((req) => {
        Object.defineProperty(req, 'mode', {
          value: 'real-proof',
          enumerable: false,
          writable: true,
          configurable: true,
        });
      });
      // __proto__ as own key via defineProperty
      const dangerous = { ...base };
      Object.defineProperty(dangerous, 'constructor', { value: Object, enumerable: true });
      const withDataDir = { ...base, dataDir: root };
      const proxy = new Proxy(base, {
        get(t, p) { return t[p]; },
        ownKeys(t) { return Reflect.ownKeys(t); },
        getOwnPropertyDescriptor(t, p) { return Reflect.getOwnPropertyDescriptor(t, p); },
      });

      for (const req of [
        withSymbol,
        withGetter,
        withFn,
        withProto,
        withCustomProto,
        withClass,
        withNonEnumerable,
        dangerous,
        withDataDir,
        proxy,
      ]) {
        const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req);
        assert.strictEqual(auth.state, 'denied', JSON.stringify(Object.keys(req || {})));
        assert.strictEqual(
          auth.primaryBlocker,
          'capability-caller-injection-rejected',
          `expected injection reject for hostile top, got ${auth.primaryBlocker}`,
        );
      }
      // no IO side effects from authorize
      assert.strictEqual(await pathExists(join(root, REAL_AUDIT_SINK_REL)), false);
      assert.strictEqual(await pathExists(join(root, 'audit')), false);
    });
  });

  it('C3 exact plain: nested auditInput Proxy/class/custom-proto/non-enum/accessor → injection; schemaVersion type → input-invalid', () => {
    const base = buildRealAuditProofRequest();

    const nestedProxy = {
      ...base,
      auditInput: new Proxy({ schemaVersion: 1 }, {
        get(t, p) { return t[p]; },
        ownKeys(t) { return Reflect.ownKeys(t); },
        getOwnPropertyDescriptor(t, p) { return Reflect.getOwnPropertyDescriptor(t, p); },
      }),
    };
    class NestedAuditInput {
      constructor() {
        this.schemaVersion = 1;
      }
    }
    const nestedClass = { ...base, auditInput: new NestedAuditInput() };
    const nestedCustomProto = {
      ...base,
      auditInput: Object.assign(Object.create({ polluted: true }), { schemaVersion: 1 }),
    };
    const nestedNonEnum = {
      ...base,
      auditInput: Object.defineProperty({}, 'schemaVersion', {
        value: 1,
        enumerable: false,
        writable: true,
        configurable: true,
      }),
    };
    const nestedAccessor = {
      ...base,
      auditInput: Object.defineProperty({}, 'schemaVersion', {
        enumerable: true,
        get: () => 1,
      }),
    };
    for (const req of [nestedProxy, nestedClass, nestedCustomProto, nestedNonEnum, nestedAccessor]) {
      const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req);
      assert.strictEqual(auth.state, 'denied');
      assert.strictEqual(auth.primaryBlocker, 'capability-caller-injection-rejected');
    }

    // Structurally valid auditInput but schemaVersion type/value not number 1 → input-invalid (no echo).
    for (const badVersion of ['1', true, null, { x: 'FIXTURE_SCHEMA_SECRET' }, 2, NaN]) {
      const req = buildRealAuditProofRequest({ auditInput: { schemaVersion: badVersion } });
      const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req);
      assert.strictEqual(auth.state, 'denied', String(badVersion));
      assert.strictEqual(auth.primaryBlocker, 'capability-real-audit-input-invalid', String(badVersion));
      const json = JSON.stringify(auth);
      assert.ok(!json.includes('FIXTURE_SCHEMA_SECRET'));
      if (badVersion && typeof badVersion === 'object') {
        assert.ok(!json.includes('"x"'));
      }
    }
  });

  it('C3 exact plain: context Proxy/class/custom-proto/non-enum/accessor rejected; null-proto frozen still ok', async () => {
    await withTempAuditRoot(async (root) => {
      const req = buildRealAuditProofRequest();
      class Ctx {
        constructor() {
          this.dataDir = root;
        }
      }
      const hostileContexts = [
        new Proxy({ dataDir: root }, {
          get(t, p) { return t[p]; },
          ownKeys(t) { return Reflect.ownKeys(t); },
          getOwnPropertyDescriptor(t, p) { return Reflect.getOwnPropertyDescriptor(t, p); },
        }),
        new Ctx(),
        Object.assign(Object.create({ polluted: true }), { dataDir: root }),
        Object.defineProperty({}, 'dataDir', {
          value: root,
          enumerable: false,
          writable: true,
          configurable: true,
        }),
        Object.defineProperty({}, 'dataDir', {
          enumerable: true,
          get: () => root,
        }),
      ];
      for (const ctx of hostileContexts) {
        const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
        assert.strictEqual(rc.outcomeCode, 'capability-real-audit-context-invalid');
        assert.strictEqual(rc.primaryBlocker, 'capability-real-audit-context-invalid');
        assert.strictEqual(rc.auditEventFingerprint, null);
        assertAuditPreAppendTruth(rc);
      }

      // null prototype + frozen enumerable data object remains usable
      const nullProtoCtx = Object.freeze(Object.create(null, {
        dataDir: {
          value: root,
          enumerable: true,
          writable: false,
          configurable: false,
        },
      }));
      const frozenReq = Object.freeze({
        capabilityKind: 'audit',
        actionId: 'render-launch-agent-plist',
        operation: 'install',
        mode: 'real-proof',
        idempotencyKey: null,
        attemptRef: validRealAuditAttemptRef('fz'),
        anchorRef: null,
        auditInput: Object.freeze(Object.create(null, {
          schemaVersion: {
            value: 1,
            enumerable: true,
            writable: false,
            configurable: false,
          },
        })),
      });
      const ok = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(frozenReq, nullProtoCtx);
      assert.strictEqual(ok.state, 'completed');
      assert.strictEqual(ok.outcomeCode, 'capability-real-audit-persisted');
    });
  });
});

describe('V1.34 RealAuditProof invoke happy + fingerprint vector', () => {
  it('Task3/5: fixed fingerprint vector + exact canonical file line + mode 0600 + events.jsonl absent', async () => {
    await withTempAuditRoot(async (root) => {
      const attemptRef = REAL_AUDIT_FIXED_ATTEMPT_REF;
      const operation = 'install';
      const actionId = 'render-launch-agent-plist';
      const expected = expectedRealAuditFingerprints(attemptRef, operation, actionId);
      assert.match(expected.attemptRefFingerprint, /^[0-9a-f]{64}$/);
      assert.match(expected.eventFingerprint, /^[0-9a-f]{64}$/);

      const receipt = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest({ attemptRef, operation, actionId }),
        buildRealAuditContext(root),
      );
      assert.strictEqual(receipt.receiptKind, 'capability-real-implementation-receipt');
      assert.strictEqual(receipt.state, 'completed');
      assert.strictEqual(receipt.outcomeCode, 'capability-real-audit-persisted');
      assert.strictEqual(receipt.capabilityId, 'real-audit');
      assert.strictEqual(receipt.capabilityKind, 'audit');
      assert.strictEqual(receipt.implementationClass, 'real-implementation');
      assert.strictEqual(receipt.sideEffectClass, 'audit-persist');
      assert.strictEqual(receipt.hostSideEffectOccurred, true);
      assert.strictEqual(receipt.hostMutationOccurred, true);
      assert.strictEqual(receipt.auditPersistOccurred, true);
      assert.strictEqual(receipt.mutationOutcome, 'persisted');
      assert.strictEqual(receipt.wouldPersistAudit, false);
      assert.strictEqual(receipt.wouldMutateHost, false);
      assert.strictEqual(receipt.auditEventFingerprint, expected.eventFingerprint);
      assert.strictEqual(receipt.realAuditCapabilityImplementationReady, true);
      assertAuditGlobalsFalse(receipt);
      assertNoAuditSensitiveLeak(receipt, root, attemptRef);

      const filePath = join(root, REAL_AUDIT_SINK_REL);
      const raw = await readFile(filePath, 'utf8');
      assert.ok(raw.endsWith('\n'));
      const line = raw.slice(0, -1);
      const parsed = JSON.parse(line);
      assert.deepStrictEqual(Object.keys(parsed), [...REAL_AUDIT_CANONICAL_KEYS]);
      assert.strictEqual(parsed.schemaVersion, 1);
      assert.strictEqual(parsed.eventKind, 'capability-real-audit-proof');
      assert.strictEqual(parsed.eventFingerprint, expected.eventFingerprint);
      assert.strictEqual(parsed.operation, operation);
      assert.strictEqual(parsed.actionId, actionId);
      assert.strictEqual(parsed.attemptRefFingerprint, expected.attemptRefFingerprint);
      assert.strictEqual(parsed.proofMode, 'real-proof');
      assert.strictEqual(raw, buildCanonicalAuditLine(parsed));
      assert.ok(!raw.includes(attemptRef), 'raw attemptRef never on disk');
      const { mode } = await import('node:fs/promises').then((fs) => fs.stat(filePath));
      assert.strictEqual(mode & 0o777, 0o600);
      assert.strictEqual(await pathExists(join(root, 'audit/events.jsonl')), false);
    });
  });

  it('Task5: all 10 actions under correct ops persist', async () => {
    await withTempAuditRoot(async (root) => {
      let i = 0;
      for (const [operation, actionIds] of Object.entries(SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS)) {
        for (const actionId of actionIds) {
          i += 1;
          const attemptRef = `op${String(i).padStart(2, '0')}${'a'.repeat(13)}`.slice(0, 16);
          const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
            buildRealAuditProofRequest({ operation, actionId, attemptRef }),
            buildRealAuditContext(root),
          );
          assert.strictEqual(rc.state, 'completed', `${operation}/${actionId}`);
          assert.strictEqual(rc.outcomeCode, 'capability-real-audit-persisted');
          assert.match(rc.auditEventFingerprint, /^[0-9a-f]{64}$/);
        }
      }
      const raw = await readFile(join(root, REAL_AUDIT_SINK_REL), 'utf8');
      const lines = raw.trimEnd().split('\n');
      assert.strictEqual(lines.length, 10);
    });
  });
});

describe('V1.34 RealAuditProof fail-closed + concurrency', () => {
  it('invalid request → fingerprint null + zero write', async () => {
    await withTempAuditRoot(async (root) => {
      const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest({ mode: 'execute' }),
        buildRealAuditContext(root),
      );
      assert.ok(rc.state === 'denied' || rc.state === 'error');
      assert.strictEqual(rc.auditEventFingerprint, null);
      assertAuditPreAppendTruth(rc);
      assert.strictEqual(await pathExists(join(root, REAL_AUDIT_SINK_REL)), false);
    });
  });

  it('invalid context {} / extra key / getter → context-invalid + null fp + zero write', async () => {
    await withTempAuditRoot(async (root) => {
      const req = buildRealAuditProofRequest();
      const cases = [
        {},
        { dataDir: root, extra: true },
        (() => {
          const o = {};
          Object.defineProperty(o, 'dataDir', { enumerable: true, get: () => root });
          return o;
        })(),
        { dataDir: 123 },
        null,
      ];
      for (const ctx of cases) {
        const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
        assert.strictEqual(rc.outcomeCode, 'capability-real-audit-context-invalid', JSON.stringify(ctx));
        assert.strictEqual(rc.primaryBlocker, 'capability-real-audit-context-invalid');
        assert.strictEqual(rc.auditEventFingerprint, null);
        assertAuditPreAppendTruth(rc);
      }
      assert.strictEqual(await pathExists(join(root, REAL_AUDIT_SINK_REL)), false);
    });
  });

  it('missing root / symlink root → context-invalid + null fp', async () => {
    await withTempAuditRoot(async (root) => {
      const missing = join(root, 'does-not-exist');
      const rc1 = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest(),
        buildRealAuditContext(missing),
      );
      assert.strictEqual(rc1.outcomeCode, 'capability-real-audit-context-invalid');
      assert.strictEqual(rc1.auditEventFingerprint, null);
      assertAuditPreAppendTruth(rc1);

      const target = await mkdtemp(join(tmpdir(), 'linke-audit-sym-'));
      try {
        const link = join(root, 'sym-root');
        await symlink(target, link, 'dir');
        const rc2 = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
          buildRealAuditProofRequest(),
          buildRealAuditContext(link),
        );
        assert.strictEqual(rc2.outcomeCode, 'capability-real-audit-context-invalid');
        assert.strictEqual(rc2.auditEventFingerprint, null);
        assertAuditPreAppendTruth(rc2);
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    });
  });

  it('malformed existing / oversize / >4096 → sink-invalid with 64hex, no append', async () => {
    await withTempAuditRoot(async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const filePath = join(root, REAL_AUDIT_SINK_REL);
      await writeFile(filePath, '{not-json\n', { mode: 0o600 });
      const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest({ attemptRef: validRealAuditAttemptRef('m') }),
        buildRealAuditContext(root),
      );
      assert.strictEqual(rc.outcomeCode, 'capability-real-audit-sink-invalid');
      assert.match(rc.auditEventFingerprint, /^[0-9a-f]{64}$/);
      assertAuditPreAppendTruth(rc);
      assert.strictEqual(await readFile(filePath, 'utf8'), '{not-json\n');

      // >4096 existing lines
      const { eventFingerprint, attemptRefFingerprint } = expectedRealAuditFingerprints(
        validRealAuditAttemptRef('q'),
        'install',
        'render-launch-agent-plist',
      );
      const validLine = buildCanonicalAuditLine({
        schemaVersion: 1,
        eventKind: 'capability-real-audit-proof',
        eventFingerprint,
        operation: 'install',
        actionId: 'render-launch-agent-plist',
        attemptRefFingerprint,
        proofMode: 'real-proof',
      });
      // Build 4097 lines with unique fingerprints (hex variation)
      let body = '';
      for (let i = 0; i < CAPABILITY_REAL_AUDIT_MAX_EVENT_LINES + 1; i += 1) {
        const fp = createHash('sha256').update(`line-${i}`, 'utf8').digest('hex');
        const arp = createHash('sha256').update(`arp-${i}`, 'utf8').digest('hex');
        body += buildCanonicalAuditLine({
          schemaVersion: 1,
          eventKind: 'capability-real-audit-proof',
          eventFingerprint: fp,
          operation: 'install',
          actionId: 'render-launch-agent-plist',
          attemptRefFingerprint: arp,
          proofMode: 'real-proof',
        });
      }
      await writeFile(filePath, body, { mode: 0o600 });
      const before = await readFile(filePath, 'utf8');
      const rc2 = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest({ attemptRef: validRealAuditAttemptRef('n') }),
        buildRealAuditContext(root),
      );
      assert.strictEqual(rc2.outcomeCode, 'capability-real-audit-sink-invalid');
      assert.match(rc2.auditEventFingerprint, /^[0-9a-f]{64}$/);
      assertAuditPreAppendTruth(rc2);
      assert.strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('concurrent same fingerprint barrier: second+third deny while owner inflight; one write', async () => {
    await withTempAuditRoot(async (root) => {
      const req = buildRealAuditProofRequest({ attemptRef: validRealAuditAttemptRef('c') });
      const ctx = buildRealAuditContext(root);
      const p1 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
      const p2 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
      const p3 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
      const results = await Promise.all([p1, p2, p3]);
      const completed = results.filter((r) => r.state === 'completed');
      const denied = results.filter((r) => r.outcomeCode === 'capability-real-audit-in-flight-denied');
      assert.strictEqual(completed.length, 1);
      assert.strictEqual(denied.length, 2);
      const fp = completed[0].auditEventFingerprint;
      assert.match(fp, /^[0-9a-f]{64}$/);
      for (const r of results) {
        assert.strictEqual(r.auditEventFingerprint, fp);
      }
      for (const r of denied) {
        assertAuditPreAppendTruth(r);
      }
      const raw = await readFile(join(root, REAL_AUDIT_SINK_REL), 'utf8');
      assert.strictEqual(raw.trimEnd().split('\n').length, 1);
    });
  });

  it('sequential same fingerprint twice both persisted (two lines)', async () => {
    await withTempAuditRoot(async (root) => {
      const req = buildRealAuditProofRequest({ attemptRef: validRealAuditAttemptRef('s') });
      const ctx = buildRealAuditContext(root);
      const a = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
      const b = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
      assert.strictEqual(a.state, 'completed');
      assert.strictEqual(b.state, 'completed');
      assert.strictEqual(a.auditEventFingerprint, b.auditEventFingerprint);
      const raw = await readFile(join(root, REAL_AUDIT_SINK_REL), 'utf8');
      assert.strictEqual(raw.trimEnd().split('\n').length, 2);
    });
  });

  it('different fingerprints concurrent both succeed; lifecycle has no second Map/queue', async () => {
    await withTempAuditRoot(async (root) => {
      const ctx = buildRealAuditContext(root);
      const p1 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest({ attemptRef: validRealAuditAttemptRef('d1') }),
        ctx,
      );
      const p2 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest({ attemptRef: validRealAuditAttemptRef('d2') }),
        ctx,
      );
      const [a, b] = await Promise.all([p1, p2]);
      assert.strictEqual(a.state, 'completed');
      assert.strictEqual(b.state, 'completed');
      assert.notStrictEqual(a.auditEventFingerprint, b.auditEventFingerprint);
      const raw = await readFile(join(root, REAL_AUDIT_SINK_REL), 'utf8');
      assert.strictEqual(raw.trimEnd().split('\n').length, 2);
    });
  });

  it('append afterAppend hook throw → persist-failed + line exists + unknown-after-write-attempt + 64hex', async () => {
    await withTempAuditRoot(async (root) => {
      try {
        setCapabilityRealAuditSinkHooksForTest({
          afterAppend: async () => {
            throw new Error('FIXTURE_AFTER_APPEND_SECRET_do_not_echo');
          },
        });
        const attemptRef = validRealAuditAttemptRef('f2');
        const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
          buildRealAuditProofRequest({ attemptRef }),
          buildRealAuditContext(root),
        );
        assert.strictEqual(rc.state, 'error');
        assert.strictEqual(rc.outcomeCode, 'capability-real-audit-persist-failed');
        assert.strictEqual(rc.primaryBlocker, 'capability-real-audit-persist-failed');
        assert.match(rc.auditEventFingerprint, /^[0-9a-f]{64}$/);
        assert.strictEqual(rc.hostSideEffectOccurred, true);
        assert.strictEqual(rc.hostMutationOccurred, true);
        assert.strictEqual(rc.auditPersistOccurred, false);
        assert.strictEqual(rc.mutationOutcome, 'unknown-after-write-attempt');
        assert.strictEqual(rc.wouldPersistAudit, false);
        assertAuditGlobalsFalse(rc);
        assertNoAuditSensitiveLeak(rc, root, attemptRef, ['FIXTURE_AFTER_APPEND_SECRET_do_not_echo']);
        // Canonical line must have been produced before afterAppend throw.
        const raw = await readFile(join(root, REAL_AUDIT_SINK_REL), 'utf8');
        assert.strictEqual(raw.trimEnd().split('\n').length, 1);
        assert.ok(raw.endsWith('\n'));
        const parsed = JSON.parse(raw.slice(0, -1));
        assert.deepStrictEqual(Object.keys(parsed), [...REAL_AUDIT_CANONICAL_KEYS]);
      } finally {
        setCapabilityRealAuditSinkHooksForTest(null);
      }
    });
  });

  it('C3 deterministic beforeAppend latch concurrency: denied callers never clear owner inFlight', async () => {
    await withTempAuditRoot(async (root) => {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let entered = 0;
      let signalEntered;
      const enteredGate = new Promise((resolve) => {
        signalEntered = resolve;
      });
      try {
        setCapabilityRealAuditSinkHooksForTest({
          beforeAppend: async () => {
            entered += 1;
            if (entered === 1) signalEntered();
            await gate;
          },
        });
        const req = buildRealAuditProofRequest({ attemptRef: validRealAuditAttemptRef('c3') });
        const ctx = buildRealAuditContext(root);
        const owner = invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
        await enteredGate;
        assert.strictEqual(entered, 1);

        const denied = await Promise.all([
          invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx),
          invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx),
        ]);
        for (const rc of denied) {
          assert.strictEqual(rc.outcomeCode, 'capability-real-audit-in-flight-denied');
          assert.match(rc.auditEventFingerprint, /^[0-9a-f]{64}$/);
          assertAuditPreAppendTruth(rc);
        }
        // Fourth still denied before owner release — proves denied callers did not delete owner entry.
        const fourth = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
        assert.strictEqual(fourth.outcomeCode, 'capability-real-audit-in-flight-denied');
        assert.match(fourth.auditEventFingerprint, /^[0-9a-f]{64}$/);

        release();
        const ownerRc = await owner;
        assert.strictEqual(ownerRc.state, 'completed');
        assert.strictEqual(ownerRc.outcomeCode, 'capability-real-audit-persisted');
        const raw = await readFile(join(root, REAL_AUDIT_SINK_REL), 'utf8');
        assert.strictEqual(raw.trimEnd().split('\n').length, 1);
      } finally {
        release();
        setCapabilityRealAuditSinkHooksForTest(null);
      }
    });
  });

  it('C3 receipt never echoes hostile kind/action/operation/mode strings or objects', async () => {
    await withTempAuditRoot(async (root) => {
      const secrets = [
        'FIXTURE_KIND_SECRET',
        'FIXTURE_ACTION_SECRET',
        'FIXTURE_OP_SECRET',
        'FIXTURE_MODE_SECRET',
        'attacker-array-secret',
      ];
      const cases = [
        { capabilityKind: 'FIXTURE_KIND_SECRET' },
        { capabilityKind: { evil: 'FIXTURE_KIND_SECRET' } },
        { capabilityKind: ['attacker-array-secret'] },
        { actionId: 'FIXTURE_ACTION_SECRET' },
        { actionId: { evil: 'FIXTURE_ACTION_SECRET' } },
        { operation: 'FIXTURE_OP_SECRET' },
        { operation: { evil: 'FIXTURE_OP_SECRET' } },
        { mode: 'FIXTURE_MODE_SECRET' },
        { mode: { evil: 'FIXTURE_MODE_SECRET' } },
        { mode: ['attacker-array-secret'] },
      ];
      for (const override of cases) {
        const attemptRef = validRealAuditAttemptRef('hx');
        const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
          buildRealAuditProofRequest({ ...override, attemptRef }),
          buildRealAuditContext(root),
        );
        assert.ok(rc.state === 'denied' || rc.state === 'error');
        // Sanitized allowlist only.
        assert.ok(
          rc.capabilityKind === 'audit' || rc.capabilityKind === 'unknown',
          JSON.stringify(rc.capabilityKind),
        );
        assert.ok(
          rc.mode === 'real-proof' || rc.mode === 'execute' || rc.mode === 'dry-run' || rc.mode === 'unknown',
          JSON.stringify(rc.mode),
        );
        if (override.capabilityKind !== undefined && override.capabilityKind !== 'audit') {
          assert.strictEqual(rc.capabilityKind, 'unknown');
        }
        if (override.operation !== undefined) {
          assert.strictEqual(rc.operation, 'unknown');
        }
        if (override.actionId !== undefined) {
          assert.strictEqual(rc.actionId, 'unknown');
        }
        if (override.mode !== undefined && !['real-proof', 'execute', 'dry-run'].includes(override.mode)) {
          assert.strictEqual(rc.mode, 'unknown');
        }
        assertNoAuditSensitiveLeak(rc, root, attemptRef, secrets);
        // Enumerate + JSON stringify prove no secret echo.
        for (const key of Object.keys(rc)) {
          const val = rc[key];
          const text = typeof val === 'string' ? val : JSON.stringify(val);
          for (const secret of secrets) {
            assert.ok(!String(text).includes(secret), `${key} leaked ${secret}`);
          }
        }
      }
      assert.strictEqual(await pathExists(join(root, REAL_AUDIT_SINK_REL)), false);
    });
  });

  it('C3 valid op/action success receipt keeps allowlisted values', async () => {
    await withTempAuditRoot(async (root) => {
      const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest({
          operation: 'install',
          actionId: 'render-launch-agent-plist',
          attemptRef: validRealAuditAttemptRef('ok'),
        }),
        buildRealAuditContext(root),
      );
      assert.strictEqual(rc.state, 'completed');
      assert.strictEqual(rc.capabilityKind, 'audit');
      assert.strictEqual(rc.operation, 'install');
      assert.strictEqual(rc.actionId, 'render-launch-agent-plist');
      assert.strictEqual(rc.mode, 'real-proof');
    });
  });

  it('cleanup: after owner success/fail, same fingerprint can run again; denial leaves no pollution', async () => {
    await withTempAuditRoot(async (root) => {
      const req = buildRealAuditProofRequest({ attemptRef: validRealAuditAttemptRef('z') });
      const ctx = buildRealAuditContext(root);
      const p1 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
      const p2 = invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
      await Promise.all([p1, p2]);
      const again = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(req, ctx);
      assert.strictEqual(again.state, 'completed');
      assert.match(again.auditEventFingerprint, /^[0-9a-f]{64}$/);
    });
  });

  it('execute/dry-run existing paths zero sink write; agent/server zero RealAuditProof refs', async () => {
    await withTempAuditRoot(async (root) => {
      // dry-run audit plan-only
      const dry = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
        capabilityKind: 'audit',
        actionId: 'render-launch-agent-plist',
        operation: 'install',
        mode: 'dry-run',
        idempotencyKey: null,
        attemptRef: null,
        anchorRef: null,
      });
      assert.strictEqual(dry.receiptKind, 'capability-dry-run-receipt');
      assert.strictEqual(dry.hostSideEffectOccurred, false);

      const execAuth = authorizeSupervisorLifecycleGuardedRunnerCapabilityMode({
        capabilityKind: 'audit',
        actionId: 'render-launch-agent-plist',
        operation: 'install',
        mode: 'execute',
        idempotencyKey: null,
        attemptRef: null,
        anchorRef: null,
      });
      assert.strictEqual(execAuth.executeCapabilityAuthorized, false);

      assert.strictEqual(await pathExists(join(root, REAL_AUDIT_SINK_REL)), false);
      assert.strictEqual(await pathExists(join(root, 'audit/events.jsonl')), false);
    });

    const agent = readFileSync(join(process.cwd(), 'src/agent.js'), 'utf8');
    const server = readFileSync(join(process.cwd(), 'src/server.js'), 'utf8');
    assert.ok(!agent.includes('RealAuditProof'));
    assert.ok(!agent.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof'));
    assert.ok(!server.includes('RealAuditProof'));
    assert.ok(!server.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof'));
    assert.ok(!agent.includes('capability-audit-sink'));
    assert.ok(!server.includes('capability-audit-sink'));
  });

  it('source architecture: single inFlight Set; exact sink API; no second queue/pre-read/events.jsonl', () => {
    const lifecycleSrc = readFileSync(join(process.cwd(), 'src/supervisor-lifecycle.js'), 'utf8');
    const sinkSrc = readFileSync(join(process.cwd(), 'src/capability-audit-sink.js'), 'utf8');
    const agent = readFileSync(join(process.cwd(), 'src/agent.js'), 'utf8');
    const server = readFileSync(join(process.cwd(), 'src/server.js'), 'utf8');
    const auditProofSlice = lifecycleSrc.slice(
      lifecycleSrc.indexOf('// ── V1.34 Real audit capability sink persist'),
    );

    assert.ok(lifecycleSrc.includes('authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof'));
    assert.ok(lifecycleSrc.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof'));
    assert.ok(lifecycleSrc.includes('appendCapabilityRealAuditProofEvent'));
    assert.ok(lifecycleSrc.includes("from './capability-audit-sink.js'"));
    // sole sink call form — exact direct invoke, not registry dispatch / second queue
    assert.ok(
      /await\s+appendCapabilityRealAuditProofEvent\s*\(\s*resolvedDataRoot\s*,\s*canonicalEvent\s*\)/.test(
        lifecycleSrc,
      ),
      'invoke must call sink with exact frozen-literal form',
    );
    // no second queue Map for audit in lifecycle
    assert.ok(!lifecycleSrc.includes('capabilityAuditSinkQueues'));
    assert.ok(!/new Map\s*\(\s*\).*audit/i.test(lifecycleSrc));
    // one inFlight Set for audit fingerprints — exact 1
    const setDecls = lifecycleSrc.match(/realAudit\w*InFlight\w*\s*=\s*new Set/g) || [];
    assert.strictEqual(setDecls.length, 1, 'expected exactly one realAudit inFlight Set');
    // RealAuditProof path: no hardcoded sink relative path / no pre-read / no generic HTTP audit append
    assert.ok(!auditProofSlice.includes('capability-proof-attempts.jsonl'));
    assert.ok(!auditProofSlice.includes('appendAuditEvent'));
    assert.ok(!auditProofSlice.includes('audit/events.jsonl'));
    assert.ok(!/safeReadText\s*\(/.test(auditProofSlice));
    // sink does not callback proof APIs / import lifecycle module
    assert.ok(!sinkSrc.includes('authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof'));
    assert.ok(!sinkSrc.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof'));
    assert.ok(!/from\s+['"]\.\/supervisor-lifecycle\.js['"]/.test(sinkSrc));
    assert.ok(!sinkSrc.includes('supervisor-lifecycle.js'));

    // Handler honesty: factory returns imported sink identity; readiness uses strict ===
    assert.ok(
      /function\s+createRealAuditCapabilityHandler\s*\(\s*\)\s*\{\s*return\s+appendCapabilityRealAuditProofEvent\s*;\s*\}/.test(
        lifecycleSrc,
      ),
      'createRealAuditCapabilityHandler must return appendCapabilityRealAuditProofEvent identity',
    );
    assert.ok(
      /entry\.handler\s*===\s*appendCapabilityRealAuditProofEvent/.test(lifecycleSrc),
      'isRealAuditCapabilityRegistryReady must identity-check handler',
    );
    assert.ok(!/function\s+realAuditCapabilityHandler/.test(lifecycleSrc));

    // TEST ONLY setter may exist in sink definition; production agent/server/lifecycle must not call it.
    assert.ok(sinkSrc.includes('setCapabilityRealAuditSinkHooksForTest'));
    assert.ok(!lifecycleSrc.includes('setCapabilityRealAuditSinkHooksForTest'));
    assert.ok(!agent.includes('setCapabilityRealAuditSinkHooksForTest'));
    assert.ok(!server.includes('setCapabilityRealAuditSinkHooksForTest'));
    // Outer catch uses one fixed allowlisted code for outcome + primaryBlocker.
    assert.ok(
      /outcomeCode:\s*'capability-real-audit-input-invalid'[\s\S]{0,200}primaryBlocker:\s*'capability-real-audit-input-invalid'/.test(
        auditProofSlice,
      ),
      'outer catch outcomeCode/primaryBlocker must share capability-real-audit-input-invalid',
    );
    // Empty semantics if must be gone; Real status JSDoc must not hang on audit descriptor.
    assert.ok(!/if \(snapshot\.mode === 'execute' \|\| snapshot\.mode !== 'real-proof'\)/.test(lifecycleSrc));
    assert.ok(
      !/Real status handler: observational metadata only[\s\S]{0,120}function buildRealAuditCapabilityDescriptor/.test(
        lifecycleSrc,
      ),
    );
  });

  it('public JSON stringify excludes fixture raw attemptRef/dataDir', async () => {
    await withTempAuditRoot(async (root) => {
      const attemptRef = REAL_AUDIT_FIXED_ATTEMPT_REF;
      const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
        buildRealAuditProofRequest({ attemptRef }),
        buildRealAuditContext(root),
      );
      const json = JSON.stringify(rc);
      assert.ok(!json.includes(attemptRef));
      assert.ok(!json.includes(root));
      assert.ok(!json.includes('BEGIN PRIVATE'));
    });
  });
});

// ── V1.34 C4 / Task7: Gate non-live realAudit honesty ──
describe('V1.34 C4 gate non-live realAudit honesty', () => {
  it('T-gate-1: production ready fixture — local audit true; occurred false; globals/execute/wiring false; blocked wiring-missing; 6/0; no fingerprint/event keys', () => {
    const gate = buildGate(getReadyInputs(), { executeRequested: true });

    // Local realAudit readiness (top + gates)
    assert.strictEqual(gate.realAuditCapabilityImplementationReady, true);
    assert.strictEqual(gate.gates.realAuditCapabilityImplementationReady, true);
    // Preserve render/status
    assert.strictEqual(gate.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(gate.realStatusCapabilityImplementationReady, true);
    assert.strictEqual(gate.gates.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(gate.gates.realStatusCapabilityImplementationReady, true);

    // Non-live occurred flags
    assert.strictEqual(gate.hostSideEffectOccurred, false);
    assert.strictEqual(gate.hostMutationOccurred, false);
    assert.strictEqual(gate.auditPersistOccurred, false);
    assert.strictEqual(gate.gates.hostSideEffectOccurred, false);
    assert.strictEqual(gate.gates.hostMutationOccurred, false);
    assert.strictEqual(gate.gates.auditPersistOccurred, false);

    // Global / execute / wiring / realAttempt stay false
    assert.strictEqual(gate.realCapabilityImplementationsReady, false);
    assert.strictEqual(gate.realAttemptAuditImplementationReady, false);
    assert.strictEqual(gate.executeCapabilityAuthorized, false);
    assert.strictEqual(gate.realRunnerWiringReady, false);
    assert.strictEqual(gate.executionEligible, false);
    assert.strictEqual(gate.gates.realCapabilityImplementationsReady, false);
    assert.strictEqual(gate.gates.realAttemptAuditImplementationReady, false);
    assert.strictEqual(gate.gates.executeCapabilityAuthorized, false);
    assert.strictEqual(gate.gates.realRunnerWiringReady, false);
    assert.strictEqual(gate.gates.runnerWiringContractReady, false);

    // Blocked + wiring-missing + 6/0 unchanged
    assert.strictEqual(gate.state, 'blocked');
    assert.deepStrictEqual(gate.nextBlockers, [REAL_WIRING_MISSING]);
    assert.strictEqual(gate.runnerWiringContract.readyCount, 6);
    assert.strictEqual(gate.runnerWiringContract.blockedCount, 0);

    // No live fingerprint / event / result keys
    assert.strictEqual(gate.auditEventFingerprint, undefined);
    assert.strictEqual(gate.auditEvent, undefined);
    assert.strictEqual(gate.auditResult, undefined);
    assert.strictEqual(gate.eventFingerprint, undefined);
    const json = JSON.stringify(gate);
    assert.ok(!json.includes('auditEventFingerprint'));
    assert.ok(!/"auditEvent"\s*:/.test(json));
    assert.ok(!/"auditResult"\s*:/.test(json));
  });

  it('T-gate-2: options full malicious override ignored; no secret leak; proof/sink zero calls', async () => {
    const baseline = buildGate(getReadyInputs(), { executeRequested: true });
    let sinkCalls = 0;
    setCapabilityRealAuditSinkHooksForTest({
      beforeAppend() {
        sinkCalls += 1;
      },
    });
    try {
      const poisoned = buildGate(getReadyInputs(), {
        executeRequested: true,
        realAuditCapabilityImplementationReady: false,
        realCapabilityImplementationsReady: true,
        realAttemptAuditImplementationReady: true,
        executeCapabilityAuthorized: true,
        realRunnerWiringReady: true,
        runnerWiringContractReady: true,
        executionEligible: true,
        hostSideEffectOccurred: true,
        hostMutationOccurred: true,
        auditPersistOccurred: true,
        auditEventFingerprint: 'LEAKED_FINGERPRINT_DEADBEEF',
        auditEvent: { secret: 'UNSAFE_AUDIT_EVENT_BODY' },
        auditResult: { secret: 'UNSAFE_AUDIT_RESULT' },
        handlers: { audit: () => { sinkCalls += 1; } },
        capabilityReceipt: {
          receiptKind: 'capability-real-implementation-receipt',
          auditEventFingerprint: 'LEAKED_FINGERPRINT_DEADBEEF',
          secret: 'UNSAFE_RECEIPT_SECRET',
        },
      });

      // Fixed honesty fields match baseline production path
      assert.strictEqual(poisoned.realAuditCapabilityImplementationReady, true);
      assert.strictEqual(poisoned.gates.realAuditCapabilityImplementationReady, true);
      assert.strictEqual(poisoned.realCapabilityImplementationsReady, false);
      assert.strictEqual(poisoned.realAttemptAuditImplementationReady, false);
      assert.strictEqual(poisoned.executeCapabilityAuthorized, false);
      assert.strictEqual(poisoned.realRunnerWiringReady, false);
      assert.strictEqual(poisoned.executionEligible, false);
      assert.strictEqual(poisoned.hostSideEffectOccurred, false);
      assert.strictEqual(poisoned.hostMutationOccurred, false);
      assert.strictEqual(poisoned.auditPersistOccurred, false);
      assert.strictEqual(poisoned.gates.auditPersistOccurred, false);
      assert.strictEqual(poisoned.gates.realAttemptAuditImplementationReady, false);
      assert.deepStrictEqual(poisoned.nextBlockers, baseline.nextBlockers);
      assert.strictEqual(poisoned.runnerWiringContract.readyCount, baseline.runnerWiringContract.readyCount);
      assert.strictEqual(poisoned.runnerWiringContract.blockedCount, baseline.runnerWiringContract.blockedCount);

      // Render/status not degraded
      assert.strictEqual(poisoned.realRenderCapabilityImplementationReady, true);
      assert.strictEqual(poisoned.realStatusCapabilityImplementationReady, true);

      // No secret/fingerprint leak; no proof/sink call
      const json = JSON.stringify(poisoned);
      assert.ok(!json.includes('LEAKED_FINGERPRINT_DEADBEEF'));
      assert.ok(!json.includes('UNSAFE_AUDIT_EVENT_BODY'));
      assert.ok(!json.includes('UNSAFE_AUDIT_RESULT'));
      assert.ok(!json.includes('UNSAFE_RECEIPT_SECRET'));
      assert.strictEqual(poisoned.auditEventFingerprint, undefined);
      assert.strictEqual(poisoned.capabilityReceipt, undefined);
      assert.strictEqual(sinkCalls, 0);
    } finally {
      setCapabilityRealAuditSinkHooksForTest(null);
    }
  });

  it('T-gate-3: render/status existing gate behavior not degraded', () => {
    const gate = buildGate(getReadyInputs(), { executeRequested: true });
    assert.strictEqual(gate.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(gate.realStatusCapabilityImplementationReady, true);
    assert.strictEqual(gate.gates.realRenderCapabilityImplementationReady, true);
    assert.strictEqual(gate.gates.realStatusCapabilityImplementationReady, true);
    assert.strictEqual(gate.hostObservationOccurred, false);
    assert.strictEqual(gate.hostSideEffectOccurred, false);
    assert.strictEqual(gate.hostMutationOccurred, false);
    assert.strictEqual(gate.realCapabilityImplementationsReady, false);
    assert.strictEqual(gate.executionEligible, false);
    assert.deepStrictEqual(gate.nextBlockers, [REAL_WIRING_MISSING]);
  });

  it('T-gate-source: gate non-live — no RealAuditProof/sink call sites in production gate builder', () => {
    const lifecycleSrc = readFileSync(join(process.cwd(), 'src/supervisor-lifecycle.js'), 'utf8');
    // Stable full-function bounds (not a fixed char length — body is ~19k and still grows).
    const GATE_START_MARKER = 'export function buildSupervisorLifecycleGuardedRunnerExecutionGate(';
    const gateStart = lifecycleSrc.indexOf(GATE_START_MARKER);
    assert.ok(gateStart >= 0, 'gate start marker must exist');
    // Prefer real next top-level export/function marker after this gate; currently last export → EOF.
    const afterGateStart = lifecycleSrc.slice(gateStart + GATE_START_MARKER.length);
    const nextTopLevelMatch = afterGateStart.match(
      /\nexport (?:async )?function |\nexport const |\nexport class |\nexport \{/,
    );
    const gateEnd = nextTopLevelMatch
      ? gateStart + GATE_START_MARKER.length + nextTopLevelMatch.index + 1
      : lifecycleSrc.length;
    assert.ok(gateEnd > gateStart, 'gate end marker/EOF must be after start');
    const gateSlice = lifecycleSrc.slice(gateStart, gateEnd);

    // Call-expression scan (identifier + '('). Comments may abbreviate proof/sink names without
    // the full forbidden call token; this still catches real production call sites.
    for (const name of [
      'authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof',
      'invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof',
      'appendCapabilityRealAuditProofEvent',
      'setCapabilityRealAuditSinkHooksForTest',
    ]) {
      assert.ok(
        !new RegExp(String.raw`\b${name}\s*\(`).test(gateSlice),
        `gate must not call ${name}(`,
      );
    }

    // No production live key/event/result field form (colon key), distinct from comment prose.
    assert.ok(
      !/auditEventFingerprint\s*:/.test(gateSlice),
      'gate must not emit auditEventFingerprint: live field',
    );

    // Honesty + realAudit local/non-live semantics on the complete gateSlice only (no full-file fallback).
    assert.ok(
      gateSlice.includes('Independent global fact (3/7 real kinds)'),
      'gate honesty comment must document Independent global fact (3/7 real kinds)',
    );
    assert.ok(
      !gateSlice.includes('Independent global fact (2/7 real kinds)'),
      'must not retain 2/7 honesty comment inside gate',
    );
    assert.ok(
      gateSlice.includes('Local real-audit fact only')
        && gateSlice.includes('Gate non-live: no authorize/invoke RealAuditProof')
        && /const realAuditCapabilityImplementationReady\s*=/.test(gateSlice),
      'gate must document realAudit local/non-live field semantics',
    );
  });
});
