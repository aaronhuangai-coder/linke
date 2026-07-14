import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';

const APPROVAL_MAX_WINDOW_MS = 60 * 60 * 1000;
const ALLOWED_OPERATIONS = new Set(['install', 'uninstall', 'rollback', 'recover']);
const EXECUTOR_MISSING_BLOCKER = 'executor-implementation-missing';
const FAKE_EXECUTOR_KIND = 'fake-supervisor-lifecycle-executor';
const FAKE_EXECUTOR_MODE = 'fake-test-only';
const MAX_FAKE_ATTEMPTS = 2;
const APPROVAL_PERSISTENCE_REQUIRED_FIELDS = Object.freeze([
  'schemaVersion',
  'operation',
  'configHash',
  'planHash',
  'approvedAt',
  'expiresAt',
  'approvedBy',
  'reason',
  'acknowledgements',
]);
const APPROVAL_RECORD_READINESS_ALLOWED_PLAN_BLOCKERS = new Set([
  EXECUTOR_MISSING_BLOCKER,
  'approval-missing',
]);
const APPROVAL_RECORD_READINESS_VALIDATION_FLAGS = Object.freeze([
  'approvalValid',
  'windowWithinLimit',
  'operationMatchesPlan',
  'configHashMatchesPlan',
  'planHashMatchesPlan',
]);
const SAFE_PLAN_BLOCKERS = new Set([
  EXECUTOR_MISSING_BLOCKER,
  'apply-flag-required',
  'env-gate-disabled',
  'recovery-supervisor-design-missing',
  'approval-missing',
  'approval-missing-required-fields',
  'approval-not-granted',
  'approval-window-invalid',
  'approval-window-too-wide',
  'approval-expired',
  'approval-operation-mismatch',
  'approval-config-hash-mismatch',
  'approval-plan-hash-mismatch',
]);

function lifecycleSafety() {
  return {
    dryRun: true,
    hostMutation: false,
    launchctlCalled: false,
    filesystemWritten: false,
    metadataWritten: false,
    rollbackAnchorWritten: false,
    auditEventWritten: false,
    approvalPersisted: false,
    sensitiveValuesReturned: false,
  };
}

function normalizeForHash(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeForHash(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, normalizeForHash(value[key])]),
    );
  }
  return value;
}

function parseTime(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function hasRequiredApprovalFields(approval) {
  return Boolean(
    approval &&
      typeof approval === 'object' &&
      !Array.isArray(approval) &&
      approval.schemaVersion === 1 &&
      Object.hasOwn(approval, 'approved') &&
      isNonEmptyString(approval.operation) &&
      isNonEmptyString(approval.configHash) &&
      isNonEmptyString(approval.planHash) &&
      isNonEmptyString(approval.approvedBy) &&
      isNonEmptyString(approval.reason) &&
      Array.isArray(approval.acknowledgements) &&
      approval.acknowledgements.length > 0 &&
      approval.acknowledgements.every(isNonEmptyString) &&
      parseTime(approval.approvedAt) !== null &&
      parseTime(approval.expiresAt) !== null,
  );
}

function hasTraversalSegment(input) {
  return input.split(/[\\/]+/).includes('..');
}

function isWithinBoundary(targetPath, boundaryPath) {
  if (!boundaryPath) return false;
  const resolvedBoundary = resolve(boundaryPath);
  return targetPath === resolvedBoundary || targetPath.startsWith(`${resolvedBoundary}${sep}`);
}

function buildLifecycleActions(operation) {
  const actionsByOperation = {
    install: [
      ['render-launch-agent-plist', 'Render a launch agent plist preview.'],
      ['write-launch-agent-plist', 'Future apply would write a launch agent plist after all gates pass.'],
      ['load-launch-agent', 'Future apply would ask launchd to load the launch agent.'],
    ],
    uninstall: [
      ['unload-launch-agent', 'Future apply would ask launchd to unload the launch agent.'],
      ['remove-launch-agent-plist', 'Future apply would remove the launch agent plist.'],
      ['remove-supervisor-metadata', 'Future apply would remove supervisor lifecycle metadata.'],
    ],
    rollback: [
      ['capture-current-state', 'Future apply would capture current state before rollback.'],
      ['restore-previous-plist', 'Future apply would restore the previous launch agent plist.'],
      ['restart-previous-supervisor', 'Future apply would restart the previous supervisor.'],
    ],
    recover: [
      ['start-recovery-supervisor', 'Recovery supervisor lifecycle is not designed in V0.88.'],
    ],
  };
  return (actionsByOperation[operation] || []).map(([id, description]) => ({
    id,
    description,
    status: 'blocked',
    wouldRun: false,
    wouldWrite: false,
  }));
}

function hasExpectedLifecycleActions(plan) {
  if (!ALLOWED_OPERATIONS.has(plan?.operation) || !Array.isArray(plan?.actions)) return false;
  const expectedActionIds = buildLifecycleActions(plan.operation).map((action) => action.id);
  const actualActionIds = plan.actions.map((action) => action?.id);
  return expectedActionIds.length === actualActionIds.length &&
    expectedActionIds.every((actionId, index) => actualActionIds[index] === actionId);
}

function safePlanBlockers(blockers) {
  const safeBlockers = blockers.filter((blocker) => SAFE_PLAN_BLOCKERS.has(blocker));
  if (safeBlockers.length !== blockers.length) {
    safeBlockers.push('lifecycle-plan-blocker-not-allowed');
  }
  return safeBlockers;
}

function buildApprovalPersistenceValidation(plan, approval) {
  const approvedAt = parseTime(approval?.approvedAt);
  const expiresAt = parseTime(approval?.expiresAt);
  return {
    approvalValid: false,
    acknowledgementCount: Array.isArray(approval?.acknowledgements) ? approval.acknowledgements.length : 0,
    windowWithinLimit: approvedAt !== null &&
      expiresAt !== null &&
      expiresAt > approvedAt &&
      expiresAt - approvedAt <= APPROVAL_MAX_WINDOW_MS,
    operationMatchesPlan: approval?.operation === plan?.operation,
    configHashMatchesPlan: approval?.configHash === plan?.configHash,
    planHashMatchesPlan: approval?.planHash === plan?.planHash,
  };
}

function normalizeApprovalRecordValidation(validation) {
  const source = validation && typeof validation === 'object' ? validation : {};
  return {
    approvalValid: source.approvalValid === true,
    acknowledgementCount: Number.isInteger(source.acknowledgementCount) && source.acknowledgementCount >= 0
      ? source.acknowledgementCount
      : 0,
    windowWithinLimit: source.windowWithinLimit === true,
    operationMatchesPlan: source.operationMatchesPlan === true,
    configHashMatchesPlan: source.configHashMatchesPlan === true,
    planHashMatchesPlan: source.planHashMatchesPlan === true,
  };
}

function normalizeApprovalRecordSafety(safety) {
  const source = safety && typeof safety === 'object' ? safety : {};
  return {
    approvalPersisted: source.approvalPersisted === true,
    filesystemWritten: source.filesystemWritten === true,
    hostMutation: source.hostMutation === true,
    launchctlCalled: source.launchctlCalled === true,
    lifecycleApplied: source.lifecycleApplied === true,
    sensitiveValuesReturned: source.sensitiveValuesReturned === true,
  };
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSupervisorLifecycleApprovalRecord(record) {
  return isObject(record) && record.command === 'supervisor-lifecycle-approval-record';
}

function isApprovalRecordValidationComplete(record) {
  const validation = normalizeApprovalRecordValidation(record?.validation);
  return record?.approvalValid === true &&
    validation.acknowledgementCount > 0 &&
    APPROVAL_RECORD_READINESS_VALIDATION_FLAGS.every((flag) => validation[flag] === true);
}

function isApprovalRecordSafetyClean(record) {
  const safety = normalizeApprovalRecordSafety(record?.safety);
  return safety.approvalPersisted === true &&
    safety.filesystemWritten === true &&
    safety.hostMutation === false &&
    safety.launchctlCalled === false &&
    safety.lifecycleApplied === false &&
    safety.sensitiveValuesReturned === false;
}

function buildPlanHash(operation, configHash, actions) {
  return hashLifecycleObject({
    version: 'V0.88',
    kind: 'supervisor-lifecycle-apply',
    operation,
    configHash,
    actionIds: actions.map((action) => action.id),
  });
}

export function hashLifecycleObject(value) {
  const stableJson = JSON.stringify(normalizeForHash(value));
  const hex = createHash('sha256').update(stableJson).digest('hex');
  return `sha256:${hex}`;
}

export function buildSupervisorLifecycleApplyReadiness(plan, approvalRecords = []) {
  const operation = ALLOWED_OPERATIONS.has(plan?.operation) ? plan.operation : 'unknown';
  const safeRecords = Array.isArray(approvalRecords)
    ? approvalRecords.filter(isSupervisorLifecycleApprovalRecord)
    : [];
  const operationRecords = safeRecords.filter((record) => record.operation === operation);
  const persistedOperationRecords = operationRecords.filter((record) => record.state === 'persisted');
  const validationReadyRecords = persistedOperationRecords.filter(isApprovalRecordValidationComplete);
  const safeReadyRecords = validationReadyRecords.filter(isApprovalRecordSafetyClean);
  const blockers = [];

  if (!plan || plan.command !== 'supervisor-lifecycle-apply' || !Array.isArray(plan.actions) || !Array.isArray(plan.blockers)) {
    blockers.push('invalid-lifecycle-plan');
  } else {
    if (!hasExpectedLifecycleActions(plan)) blockers.push('lifecycle-plan-action-mismatch');
    const unsafePlanBlockers = plan.blockers
      .filter((blocker) => !APPROVAL_RECORD_READINESS_ALLOWED_PLAN_BLOCKERS.has(blocker));
    blockers.push(...safePlanBlockers(unsafePlanBlockers));
  }

  if (blockers.length === 0) {
    if (safeRecords.length === 0) {
      blockers.push('approval-record-missing');
    } else if (operationRecords.length === 0) {
      blockers.push('approval-record-operation-mismatch');
    } else if (persistedOperationRecords.length === 0) {
      blockers.push('approval-record-not-persisted');
    } else if (validationReadyRecords.length === 0) {
      blockers.push('approval-record-validation-incomplete');
    } else if (safeReadyRecords.length === 0) {
      blockers.push('approval-record-safety-invalid');
    }
  }

  const approvalRecordReady = blockers.length === 0 && safeReadyRecords.length > 0;
  const planGates = isObject(plan?.gates) ? plan.gates : {};
  return {
    command: 'supervisor-lifecycle-apply-readiness',
    operation,
    state: 'blocked',
    approvalRecordState: approvalRecordReady ? 'ready' : 'blocked',
    approvalRecordReady,
    blockers: [...new Set(blockers)],
    nextBlockers: [EXECUTOR_MISSING_BLOCKER],
    approvalRecords: {
      readOnly: true,
      count: safeRecords.length,
      operationMatchCount: operationRecords.length,
      persistedMatchCount: persistedOperationRecords.length,
    },
    gates: {
      lifecyclePlanValid: blockers.includes('invalid-lifecycle-plan') === false &&
        blockers.includes('lifecycle-plan-action-mismatch') === false,
      applyFlag: planGates.applyFlag === true,
      envGate: planGates.envGate === true,
      approvalRecordPersisted: persistedOperationRecords.length > 0,
      approvalRecordValid: safeReadyRecords.length > 0,
      approvalRecordOperationMatched: operationRecords.length > 0,
      executorImplemented: false,
    },
    safety: {
      ...lifecycleSafety(),
      readOnly: true,
      lifecycleApplied: false,
    },
  };
}

export function validateSupervisorLifecycleApproval(approval, expected = {}) {
  const blockers = [];
  if (!hasRequiredApprovalFields(approval)) {
    blockers.push('approval-missing-required-fields');
    return { valid: false, blockers };
  }

  if (approval.approved !== true) blockers.push('approval-not-granted');

  const approvedAt = parseTime(approval.approvedAt);
  const expiresAt = parseTime(approval.expiresAt);
  const now = parseTime(expected.now || new Date());
  if (expiresAt <= approvedAt) {
    blockers.push('approval-window-invalid');
  } else if (expiresAt - approvedAt > APPROVAL_MAX_WINDOW_MS) {
    blockers.push('approval-window-too-wide');
  }
  if (now !== null && expiresAt <= now) {
    blockers.push('approval-expired');
  }
  if (approval.operation !== expected.operation) {
    blockers.push('approval-operation-mismatch');
  }
  if (approval.configHash !== expected.configHash) {
    blockers.push('approval-config-hash-mismatch');
  }
  if (approval.planHash !== expected.planHash) {
    blockers.push('approval-plan-hash-mismatch');
  }

  return { valid: blockers.length === 0, blockers };
}

export function resolveSupervisorLifecyclePathBoundary(input, options = {}) {
  if (!isNonEmptyString(input)) {
    return { allowed: false, blockerCode: 'path-not-string' };
  }
  if (hasTraversalSegment(input)) {
    return { allowed: false, blockerCode: 'path-traversal-or-unresolved' };
  }

  const targetPath = resolve(input);
  const roots = [
    options.userLaunchAgentsDir,
    options.stagingRoot,
    options.metadataRoot,
  ].filter(isNonEmptyString);
  if (roots.some((root) => isWithinBoundary(targetPath, root))) {
    return { allowed: true, path: targetPath };
  }
  return { allowed: false, blockerCode: 'path-outside-allowed-roots' };
}

export function buildSupervisorLifecycleApplyPlan(config, options = {}) {
  const operation = ALLOWED_OPERATIONS.has(options.operation) ? options.operation : 'install';
  const applyRequested = options.apply === true;
  const envGateEnabled = options.envGateEnabled === true;
  const actions = buildLifecycleActions(operation);
  const configHash = hashLifecycleObject(config || {});
  const planHash = buildPlanHash(operation, configHash, actions);
  const blockers = [];

  if (!applyRequested) blockers.push('apply-flag-required');
  if (applyRequested && !envGateEnabled) blockers.push('env-gate-disabled');
  if (operation === 'recover') blockers.push('recovery-supervisor-design-missing');

  let approvalValid = false;
  if (applyRequested) {
    if (!options.approval) {
      blockers.push('approval-missing');
    } else {
      const approvalResult = validateSupervisorLifecycleApproval(options.approval, {
        operation,
        configHash,
        planHash,
        now: options.now || new Date(),
      });
      approvalValid = approvalResult.valid;
      blockers.push(...approvalResult.blockers);
    }
  }
  blockers.push(EXECUTOR_MISSING_BLOCKER);

  return {
    command: 'supervisor-lifecycle-apply',
    mode: applyRequested ? 'apply-requested' : 'dry-run-only',
    operation,
    applyRequested,
    state: 'blocked',
    blockers,
    configHash,
    planHash,
    gates: {
      applyFlag: applyRequested,
      envGate: envGateEnabled,
      approvalValid,
      executorImplemented: false,
    },
    actions,
    safety: lifecycleSafety(),
  };
}

export async function executeSupervisorLifecycleApply(plan, executor, options = {}) {
  const operation = typeof plan?.operation === 'string' ? plan.operation : 'unknown';
  const baseResult = {
    command: 'supervisor-lifecycle-apply',
    operation,
    events: [],
    safety: lifecycleSafety(),
  };
  const blockers = [];

  if (options.mode !== FAKE_EXECUTOR_MODE) blockers.push('fake-executor-mode-required');
  if (!executor || executor.kind !== FAKE_EXECUTOR_KIND || typeof executor.runAction !== 'function') {
    blockers.push('fake-executor-kind-required');
  }
  if (!plan || plan.command !== 'supervisor-lifecycle-apply' || !Array.isArray(plan.actions) || !Array.isArray(plan.blockers)) {
    blockers.push('invalid-lifecycle-plan');
  } else if (!hasExpectedLifecycleActions(plan)) {
    blockers.push('lifecycle-plan-action-mismatch');
  }

  if (blockers.length === 0) {
    const onlyExecutorMissing = plan.blockers.length === 1 && plan.blockers[0] === EXECUTOR_MISSING_BLOCKER;
    if (!onlyExecutorMissing) {
      blockers.push(...safePlanBlockers(plan.blockers));
      if (!plan.blockers.includes(EXECUTOR_MISSING_BLOCKER)) blockers.push('executor-blocker-required');
      if (plan.blockers.length === 0) blockers.push('executor-blocker-required');
    }
  }

  if (blockers.length > 0) {
    return {
      ...baseResult,
      state: 'blocked',
      blockers: [...new Set(blockers)],
    };
  }

  const events = [];
  for (const action of plan.actions) {
    let actionSucceeded = false;
    for (let attempt = 1; attempt <= MAX_FAKE_ATTEMPTS; attempt += 1) {
      const context = {
        operation: plan.operation,
        actionId: action.id,
        attempt,
        maxAttempts: MAX_FAKE_ATTEMPTS,
        mode: FAKE_EXECUTOR_MODE,
      };
      let outcome;
      try {
        outcome = await executor.runAction({ id: action.id, status: action.status }, context);
      } catch {
        outcome = { ok: false };
      }
      if (outcome?.ok === true) {
        events.push({
          operation: plan.operation,
          actionId: action.id,
          attempt,
          status: 'simulated',
          mode: FAKE_EXECUTOR_MODE,
        });
        actionSucceeded = true;
        break;
      }
      events.push({
        operation: plan.operation,
        actionId: action.id,
        attempt,
        status: 'failed',
        mode: FAKE_EXECUTOR_MODE,
      });
    }

    if (!actionSucceeded) {
      return {
        ...baseResult,
        state: 'failed',
        blockers: ['fake-executor-action-failed'],
        failedActionId: action.id,
        attempts: MAX_FAKE_ATTEMPTS,
        events,
      };
    }
  }

  return {
    ...baseResult,
    state: 'simulated',
    blockers: [EXECUTOR_MISSING_BLOCKER],
    events,
  };
}

const ALLOWED_AUDIT_RESULT_STATES = new Set(['blocked', 'failed', 'simulated']);
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function safeRequestId(value) {
  return typeof value === 'string' && SAFE_REQUEST_ID_PATTERN.test(value) ? value : '';
}

export function buildSupervisorLifecycleAuditPreview(plan, lifecycleResult, options = {}) {
  const operation = ALLOWED_OPERATIONS.has(plan?.operation) ? plan.operation : 'unknown';
  const base = {
    command: 'supervisor-lifecycle-apply',
    operation,
    safety: lifecycleSafety(),
  };
  const blockers = [];

  if (!plan || plan.command !== 'supervisor-lifecycle-apply' || !Array.isArray(plan.actions)) {
    blockers.push('invalid-lifecycle-plan');
  } else if (!hasExpectedLifecycleActions(plan)) {
    blockers.push('lifecycle-plan-action-mismatch');
  }
  if (!lifecycleResult || lifecycleResult.command !== 'supervisor-lifecycle-apply') {
    blockers.push('invalid-lifecycle-result');
  }
  if (blockers.length === 0 && lifecycleResult.operation !== plan.operation) {
    blockers.push('lifecycle-audit-operation-mismatch');
  }
  if (blockers.length === 0 && !ALLOWED_AUDIT_RESULT_STATES.has(lifecycleResult.state)) {
    blockers.push('lifecycle-audit-state-not-allowed');
  }

  if (blockers.length > 0) {
    return {
      ...base,
      state: 'blocked',
      blockers: [...new Set(blockers)],
      auditEvent: null,
    };
  }

  const resultState = lifecycleResult.state;
  const auditEvent = {
    type: `supervisor.lifecycle.${plan.operation}.${resultState}`,
    createdAt: isoTimestamp(options.now || new Date()),
    outcome: resultState,
    message: `supervisor lifecycle ${plan.operation} ${resultState}; audit preview only; no host mutation`,
  };
  const requestId = safeRequestId(options.requestId);
  if (requestId) auditEvent.requestId = requestId;

  return {
    ...base,
    state: 'preview',
    auditEvent,
  };
}

export function buildSupervisorLifecycleApprovalPersistencePreview(plan, approval, options = {}) {
  const operation = ALLOWED_OPERATIONS.has(plan?.operation) ? plan.operation : 'unknown';
  const validation = buildApprovalPersistenceValidation(plan, approval);
  const base = {
    command: 'supervisor-lifecycle-approval-persistence-preview',
    operation,
    state: 'blocked',
    approvalValid: false,
    persistence: {
      previewOnly: true,
      wouldPersist: false,
      recordSchemaVersion: 1,
      requiredRecordFields: [...APPROVAL_PERSISTENCE_REQUIRED_FIELDS],
      validation,
    },
    safety: lifecycleSafety(),
  };
  const blockers = [];

  if (!plan || plan.command !== 'supervisor-lifecycle-apply' || !ALLOWED_OPERATIONS.has(plan.operation) || !Array.isArray(plan.actions)) {
    blockers.push('invalid-lifecycle-plan');
  } else if (!hasExpectedLifecycleActions(plan)) {
    blockers.push('lifecycle-plan-action-mismatch');
  }

  if (blockers.length > 0) {
    return {
      ...base,
      blockers: [...new Set(blockers)],
    };
  }

  const approvalResult = validateSupervisorLifecycleApproval(approval, {
    operation: plan.operation,
    configHash: plan.configHash,
    planHash: plan.planHash,
    now: options.now || new Date(),
  });
  validation.approvalValid = approvalResult.valid;
  blockers.push(...safePlanBlockers(approvalResult.blockers));
  blockers.push('approval-persistence-store-missing');

  return {
    ...base,
    approvalValid: approvalResult.valid,
    blockers: [...new Set(blockers)],
  };
}

const ALLOWED_EXECUTOR_READINESS_BLOCKERS = new Set([
  'apply-flag-required',
  'env-gate-disabled',
  'recovery-supervisor-design-missing',
  'approval-missing',
  'approval-missing-required-fields',
  'approval-not-granted',
  'approval-window-invalid',
  'approval-window-too-wide',
  'approval-expired',
  'approval-operation-mismatch',
  'approval-config-hash-mismatch',
  'approval-plan-hash-mismatch',
  'invalid-lifecycle-plan',
  'lifecycle-plan-action-mismatch',
  'approval-record-missing',
  'approval-record-operation-mismatch',
  'approval-record-not-persisted',
  'approval-record-validation-incomplete',
  'approval-record-safety-invalid',
  'approval-record-gate-not-ready',
  'lifecycle-plan-blocker-not-allowed',
]);
const GUARDED_RUNNER_BINDING_KIND = 'supervisor-lifecycle-guarded-runner-binding';
const GUARDED_RUNNER_BINDING_MODE = 'guarded-host-action';
const GUARDED_RUNNER_KIND = 'guarded-runner-stub';
const GUARDED_RUNNER_EXECUTION_DISABLED = 'guarded-runner-execution-disabled';
const GUARDED_RUNNER_EXECUTION_PREVIEW_ONLY = 'guarded-runner-execution-preview-only';
const REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING = 'real-guarded-runner-execution-wiring-missing';
const RUNNER_REGISTRY_REAL_IMPLEMENTATION_MISSING = 'runner-registry-real-implementation-missing';
const HOST_MUTATION_ADAPTER_REAL_IMPLEMENTATION_MISSING = 'host-mutation-adapter-real-implementation-missing';
const ROLLBACK_ANCHOR_REAL_IMPLEMENTATION_MISSING = 'rollback-anchor-real-implementation-missing';
const DISABLED_HOST_MUTATION_ADAPTER_KIND = 'disabled-host-mutation-adapter-stub';
const DISABLED_ROLLBACK_ANCHOR_KIND = 'disabled-rollback-anchor-stub';
const ATTEMPT_AUDIT_REAL_IMPLEMENTATION_MISSING = 'attempt-audit-real-implementation-missing';
const DISABLED_ATTEMPT_AUDIT_KIND = 'disabled-attempt-audit-stub';
const OPERATOR_RECOVERY_REAL_IMPLEMENTATION_MISSING = 'operator-recovery-real-implementation-missing';
const DISABLED_OPERATOR_RECOVERY_KIND = 'disabled-operator-recovery-stub';
const FAIL_CLOSED_EXECUTION_POLICY_KIND = 'fail-closed-execution-policy';
const EXECUTION_POLICY_READY_EVIDENCE = 'execution-policy-ready';
const EXECUTION_POLICY_CONTEXT_INVALID = 'execution-policy-context-invalid';
const EXECUTION_POLICY_OPERATION_INVALID = 'execution-policy-operation-invalid';
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
const EXECUTION_POLICY_CONTEXT_KEYS = Object.freeze([
  'operation',
  ...POLICY_FACT_KEYS,
]);
const EXECUTION_POLICY_BLOCKER_CODES = Object.freeze([
  EXECUTION_POLICY_CONTEXT_INVALID,
  EXECUTION_POLICY_OPERATION_INVALID,
  'lifecycle-plan-not-ready',
  'approval-record-gate-not-ready',
  'executor-manifest-not-ready',
  'guarded-runner-readiness-not-ready',
  'execution-preview-not-verified',
  'execute-request-missing',
  'action-candidates-not-ready',
  'runner-registry-not-ready',
  'host-mutation-adapter-not-ready',
  'rollback-anchor-not-ready',
  'attempt-audit-not-ready',
  'operator-recovery-not-ready',
]);
const EXECUTION_POLICY_BLOCKER_CODE_SET = new Set(EXECUTION_POLICY_BLOCKER_CODES);
const ACTION_CANDIDATE_ALLOWED_KEYS = Object.freeze([
  'actionId',
  'implementationId',
  'runnerKind',
  'mode',
  'status',
  'wouldExecute',
  'wouldRun',
  'wouldWrite',
  'maxAttempts',
]);
const GUARDED_RUNNER_READY_EXECUTION_POLICY_ENTRY = Object.freeze({
  policyKind: FAIL_CLOSED_EXECUTION_POLICY_KIND,
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
  evidenceCode: EXECUTION_POLICY_READY_EVIDENCE,
});
const GUARDED_RUNNER_DISABLED_ATTEMPT_AUDIT_ENTRY = Object.freeze({
  auditKind: DISABLED_ATTEMPT_AUDIT_KIND,
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
  blockerCode: ATTEMPT_AUDIT_REAL_IMPLEMENTATION_MISSING,
});
const GUARDED_RUNNER_DISABLED_OPERATOR_RECOVERY_ENTRY = Object.freeze({
  recoveryKind: DISABLED_OPERATOR_RECOVERY_KIND,
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
  blockerCode: OPERATOR_RECOVERY_REAL_IMPLEMENTATION_MISSING,
});
const HOST_MUTATION_ADAPTER_READY_EVIDENCE = 'host-mutation-adapter-ready';
const HOST_MUTATION_ADAPTER_MUTATION_READY_EVIDENCE = 'host-mutation-adapter-mutation-ready';
const CODE_OWNED_HOST_MUTATION_ADAPTER_KIND = 'code-owned-host-mutation-adapter';
const HOST_MUTATION_ADAPTER_BLOCKER_CODES = Object.freeze([
  'host-mutation-adapter-candidates-invalid',
  'host-mutation-adapter-operation-invalid',
  'host-mutation-adapter-action-missing',
  'host-mutation-adapter-action-duplicate',
  'host-mutation-adapter-action-unknown',
  'host-mutation-adapter-unsafe-mutation',
]);
const HOST_MUTATION_ADAPTER_BLOCKER_CODE_SET = new Set(HOST_MUTATION_ADAPTER_BLOCKER_CODES);
// Identifiers only — not host executors, shell/launchctl argv, or paths.
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
const GUARDED_RUNNER_READY_HOST_MUTATION_ADAPTER_ENTRY = Object.freeze({
  adapterKind: CODE_OWNED_HOST_MUTATION_ADAPTER_KIND,
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
  evidenceCode: HOST_MUTATION_ADAPTER_READY_EVIDENCE,
});
const GUARDED_RUNNER_DISABLED_ROLLBACK_ANCHOR_ENTRY = Object.freeze({
  anchorKind: DISABLED_ROLLBACK_ANCHOR_KIND,
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
  blockerCode: ROLLBACK_ANCHOR_REAL_IMPLEMENTATION_MISSING,
});
const RUNNER_REGISTRY_READY_EVIDENCE = 'runner-registry-ready';
const RUNNER_REGISTRY_MAPPING_READY_EVIDENCE = 'runner-registry-mapping-ready';
const CODE_OWNED_RUNNER_REGISTRY_KIND = 'code-owned-runner-registry';
const RUNNER_REGISTRY_BLOCKER_CODES = Object.freeze([
  'runner-registry-candidates-invalid',
  'runner-registry-operation-invalid',
  'runner-registry-action-missing',
  'runner-registry-action-duplicate',
  'runner-registry-action-unknown',
  'runner-registry-implementation-mismatch',
  'runner-registry-runner-kind-mismatch',
  'runner-registry-mode-mismatch',
  'runner-registry-max-attempts-invalid',
  'runner-registry-side-effect-flag-invalid',
]);
const RUNNER_REGISTRY_BLOCKER_CODE_SET = new Set(RUNNER_REGISTRY_BLOCKER_CODES);
const CODE_OWNED_ACTION_IMPLEMENTATION_MAP = Object.freeze({
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
const GUARDED_RUNNER_READY_REGISTRY_ENTRY = Object.freeze({
  registryKind: CODE_OWNED_RUNNER_REGISTRY_KIND,
  runnerKind: GUARDED_RUNNER_KIND,
  state: 'ready',
  codeOwnedResolverWired: true,
  realHostRunnerReady: false,
  realImplementationReady: false,
  supportsHostMutation: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  blockerCode: null,
  evidenceCode: RUNNER_REGISTRY_READY_EVIDENCE,
});
const GUARDED_RUNNER_WIRING_CONTRACTS = Object.freeze([
  Object.freeze({
    id: 'execution-policy',
    status: 'ready',
    requiredForExecution: true,
    evidence: 'Code-owned fail-closed execution policy evaluator is wired.',
    evidenceCode: EXECUTION_POLICY_READY_EVIDENCE,
    blockerCode: null,
  }),
  Object.freeze({
    id: 'runner-registry',
    status: 'ready',
    requiredForExecution: true,
    evidence: 'Code-owned fail-closed guarded runner registry resolver is wired.',
    evidenceCode: RUNNER_REGISTRY_READY_EVIDENCE,
    blockerCode: null,
  }),
  Object.freeze({
    id: 'host-mutation-adapter',
    status: 'ready',
    requiredForExecution: true,
    evidence: 'Code-owned fail-closed restricted host mutation adapter resolver is wired.',
    evidenceCode: HOST_MUTATION_ADAPTER_READY_EVIDENCE,
    blockerCode: null,
  }),
  Object.freeze({
    id: 'rollback-anchor',
    status: 'blocked',
    requiredForExecution: true,
    evidence: 'No rollback anchor write and verification strategy is wired.',
    evidenceCode: 'rollback-anchor-missing',
    blockerCode: 'rollback-anchor-missing',
  }),
  Object.freeze({
    id: 'attempt-audit',
    status: 'blocked',
    requiredForExecution: true,
    evidence: 'No immutable real execution attempt audit strategy is wired.',
    evidenceCode: 'attempt-audit-missing',
    blockerCode: 'attempt-audit-missing',
  }),
  Object.freeze({
    id: 'operator-recovery',
    status: 'blocked',
    requiredForExecution: true,
    evidence: 'No failure recovery, retry limit, and operator runbook is wired.',
    evidenceCode: 'operator-recovery-missing',
    blockerCode: 'operator-recovery-missing',
  }),
]);
const RUNNER_BINDING_ALLOWED_KEYS = new Set([
  'actionId',
  'implementationId',
  'mode',
  'runnerKind',
  'requiresApprovalRecord',
  'maxAttempts',
]);
const RUNNER_BINDING_REQUIRED_FIELDS = [
  'actionId',
  'implementationId',
  'mode',
  'runnerKind',
  'requiresApprovalRecord',
  'maxAttempts',
];
const SAFE_IMPLEMENTATION_ID_PATTERN = /^(?!.*--)[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export function buildSupervisorLifecycleExecutorReadiness(plan, applyReadiness) {
  const blockers = [];
  let lifecyclePlanValid = true;
  let applyReadinessValid = true;
  const operation = ALLOWED_OPERATIONS.has(plan?.operation) ? plan.operation : 'unknown';
  const safety = {
    ...lifecycleSafety(),
    readOnly: true,
    lifecycleApplied: false,
  };

  if (!plan || typeof plan !== 'object' || plan.command !== 'supervisor-lifecycle-apply' || !Array.isArray(plan.actions) || !Array.isArray(plan.blockers)) {
    lifecyclePlanValid = false;
    blockers.push('invalid-lifecycle-plan');
  } else if (!hasExpectedLifecycleActions(plan)) {
    lifecyclePlanValid = false;
    blockers.push('lifecycle-plan-action-mismatch');
  }

  if (!applyReadiness || typeof applyReadiness !== 'object' || applyReadiness.command !== 'supervisor-lifecycle-apply-readiness' || !Array.isArray(applyReadiness.blockers)) {
    applyReadinessValid = false;
    blockers.push('apply-readiness-invalid');
  }

  if (!lifecyclePlanValid || !applyReadinessValid) {
    return {
      command: 'supervisor-lifecycle-executor-readiness',
      operation,
      state: 'blocked',
      executorState: 'blocked',
      executorReady: false,
      approvalRecordReady: false,
      blockers: [...new Set(blockers)],
      nextBlockers: [],
      executorBlockers: [],
      gates: {
        lifecyclePlanValid,
        applyReadinessValid,
        approvalRecordReady: false,
        executorImplemented: false,
      },
      safety,
    };
  }

  const approvalRecordReady = applyReadiness.approvalRecordReady === true;

  const actionBlockers = plan.actions.map((action) => `executor-not-implemented-for-action:${action.id}`);
  const executorBlockers = plan.actions.map((action) => ({
    actionId: action.id,
    blocker: `executor-not-implemented-for-action:${action.id}`,
    implemented: false,
    wouldRun: false,
    wouldWrite: false,
  }));

  const copiedBlockers = applyReadiness.blockers.filter((b) => {
    if (b === 'executor-implementation-missing') return false;
    return ALLOWED_EXECUTOR_READINESS_BLOCKERS.has(b);
  });

  const finalBlockers = [];
  if (!approvalRecordReady) {
    finalBlockers.push('approval-record-gate-not-ready');
  }
  finalBlockers.push(...copiedBlockers);
  finalBlockers.push(...actionBlockers);

  return {
    command: 'supervisor-lifecycle-executor-readiness',
    operation,
    state: 'blocked',
    executorState: 'blocked',
    executorReady: false,
    approvalRecordReady,
    blockers: [...new Set(finalBlockers)],
    nextBlockers: actionBlockers,
    executorBlockers,
    gates: {
      lifecyclePlanValid: true,
      applyReadinessValid: true,
      approvalRecordReady,
      executorImplemented: false,
    },
    safety,
  };
}

function hasPlaceholder(str) {
  if (typeof str !== 'string') return false;
  return str.includes('{{') || str.includes('}}') || str.includes('${') || str.includes('<%') || str.includes('%>');
}

function hasSecretOrUnsafeText(val) {
  if (typeof val !== 'string') return false;

  const lower = val.toLowerCase();
  const secretKeywords = [
    'password',
    'secret',
    'token',
    'authorization',
    'credential',
    'private',
    'key',
    'auth',
    'passwd',
    'pwd',
    'apikey',
    'api-key',
    'passphrase',
  ];
  if (secretKeywords.some((keyword) => lower.includes(keyword))) {
    return true;
  }

  if (lower.includes('://') || lower.includes('http') || lower.includes('ssh') || lower.includes('git@') || lower.includes('@')) {
    return true;
  }

  if (val.includes('/') || val.includes('\\') || val.startsWith('~')) {
    return true;
  }

  const shellChars = [';', '|', '&', '$', '>', '<', '`', '\n', '\r'];
  if (shellChars.some((char) => val.includes(char))) {
    return true;
  }
  const cmdKeywordsRegex = /\b(sudo|launchctl|exec|eval|run|sh|bash|zsh|systemctl)\b/i;
  if (cmdKeywordsRegex.test(val)) {
    return true;
  }

  if (/[a-f0-9]{64}/i.test(val)) {
    return true;
  }

  return false;
}

function isSafeString(val) {
  if (typeof val !== 'string') return false;
  return !hasPlaceholder(val) && !hasSecretOrUnsafeText(val);
}

function sanitizeString(val) {
  if (typeof val !== 'string') return val;
  if (hasPlaceholder(val) || hasSecretOrUnsafeText(val)) {
    return '[redacted]';
  }
  return val;
}

function hasUnsafeExecutionPreviewMetadata(val) {
  if (typeof val !== 'string') return false;
  if (hasPlaceholder(val) || hasSecretOrUnsafeText(val)) return true;

  if (/\b(launchctl|sudo|shell|node|npm|pnpm|git|curl|wget|osascript|sh|bash|zsh)\b/i.test(val)) {
    return true;
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(val)) {
    return true;
  }
  if (/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/i.test(val)) {
    return true;
  }
  if (/\b(?:pid|ppid|process|process-id|processid)\s*[:=#-]?\s*\d+\b/i.test(val)) {
    return true;
  }
  if (/\b[a-f0-9]{32,}\b/i.test(val)) {
    return true;
  }
  return false;
}

function sanitizeExecutionPreviewMetadata(val) {
  if (typeof val !== 'string') return val;
  return hasUnsafeExecutionPreviewMetadata(val) ? '[redacted]' : val;
}

function sanitizeExecutionPreviewMaxAttempts(val) {
  if (Number.isInteger(val) && val >= 1 && val <= 3) return val;
  return '[redacted]';
}

function executionPreviewSafety() {
  return {
    ...lifecycleSafety(),
    readOnly: true,
    dryRun: true,
    processListRead: false,
    lifecycleApplied: false,
    nasConnected: false,
    backupTriggered: false,
    restoreTriggered: false,
    remoteCommandExecuted: false,
  };
}

function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const sanitized = {
    wouldRun: false,
    wouldWrite: false,
  };
  if (entry.actionId !== undefined) {
    sanitized.actionId = sanitizeString(entry.actionId);
  }
  if (entry.implementationId !== undefined) {
    sanitized.implementationId = sanitizeString(entry.implementationId);
  }
  if (entry.mode !== undefined) {
    sanitized.mode = sanitizeString(entry.mode);
  }
  if (entry.requiresApprovalRecord !== undefined) {
    sanitized.requiresApprovalRecord = entry.requiresApprovalRecord;
  }
  if (entry.maxAttempts !== undefined) {
    sanitized.maxAttempts = entry.maxAttempts;
  }
  return sanitized;
}

function sanitizeRunnerBindingEntry(entry) {
  const sanitized = sanitizeEntry(entry);
  if (!sanitized) return null;
  if (entry.runnerKind !== undefined) {
    sanitized.runnerKind = sanitizeString(entry.runnerKind);
  }
  return sanitized;
}

function checkManifestForUnsafeValues(val, results = { hasPlaceholder: false, hasSecret: false }) {
  if (val === null || val === undefined) return results;

  if (typeof val === 'string') {
    if (hasPlaceholder(val)) {
      results.hasPlaceholder = true;
    }
    if (hasSecretOrUnsafeText(val)) {
      results.hasSecret = true;
    }
  } else if (Array.isArray(val)) {
    for (const item of val) {
      checkManifestForUnsafeValues(item, results);
    }
  } else if (typeof val === 'object') {
    for (const key of Object.keys(val)) {
      checkManifestForUnsafeValues(key, results);
      checkManifestForUnsafeValues(val[key], results);
    }
  }
  return results;
}

function safeActionBlockerId(actionId) {
  return isSafeString(actionId) ? actionId : 'redacted-action-id';
}

export function validateSupervisorLifecycleExecutorManifest(plan, manifest) {
  const planBlockers = [];
  let planValid = true;
  if (!plan || typeof plan !== 'object' || plan.command !== 'supervisor-lifecycle-apply' || !Array.isArray(plan.actions) || !Array.isArray(plan.blockers)) {
    planBlockers.push('invalid-lifecycle-plan');
    planValid = false;
  } else if (!hasExpectedLifecycleActions(plan)) {
    planBlockers.push('lifecycle-plan-action-mismatch');
    planValid = false;
  }

  const operation = ALLOWED_OPERATIONS.has(plan?.operation) ? plan.operation : 'unknown';
  const manifestBlockers = [...planBlockers];
  const actionManifests = [];

  if (manifest !== undefined && manifest !== null) {
    const checkResults = checkManifestForUnsafeValues(manifest);
    if (checkResults.hasPlaceholder) {
      manifestBlockers.push('unresolved-placeholder');
    }
    if (checkResults.hasSecret) {
      manifestBlockers.push('secret-reference');
    }
  }

  if (manifest === undefined || manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    if (planValid) {
      for (const action of plan.actions) {
        const safeActionId = isSafeString(action.id) ? action.id : 'redacted-action-id';
        manifestBlockers.push(`executor-manifest-missing-for-action:${safeActionId}`);
      }
    }
  } else {
    if (manifest.kind !== 'supervisor-lifecycle-executor-manifest') {
      manifestBlockers.push('executor-manifest-invalid-kind');
    }
    if (manifest.schemaVersion !== 1) {
      manifestBlockers.push('executor-manifest-invalid-schema');
    }
    if (!Array.isArray(manifest.actions)) {
      manifestBlockers.push('executor-manifest-invalid-actions');
    }

    if (planValid && Array.isArray(manifest.actions)) {
      const planActionIds = new Set(plan.actions.map((action) => action.id));

      for (const action of plan.actions) {
        const safeActionId = isSafeString(action.id) ? action.id : 'redacted-action-id';
        const entries = manifest.actions.filter((entry) => entry && entry.actionId === action.id);

        if (entries.length === 0) {
          manifestBlockers.push(`executor-manifest-missing-for-action:${safeActionId}`);
        } else {
          for (const entry of entries) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              manifestBlockers.push(`executor-manifest-unsafe-for-action:${safeActionId}:invalid-field`);
              continue;
            }

            const allowedKeys = new Set(['actionId', 'implementationId', 'mode', 'requiresApprovalRecord', 'maxAttempts']);
            let hasForbidden = false;
            for (const key of Object.keys(entry)) {
              if (!allowedKeys.has(key)) {
                hasForbidden = true;
                break;
              }
            }
            if (hasForbidden) {
              manifestBlockers.push(`executor-manifest-unsafe-for-action:${safeActionId}:forbidden-field`);
            }

            const requiredFields = ['actionId', 'implementationId', 'mode', 'requiresApprovalRecord', 'maxAttempts'];
            let hasMissing = false;
            for (const field of requiredFields) {
              if (entry[field] === undefined) {
                hasMissing = true;
              }
            }
            if (hasMissing) {
              manifestBlockers.push(`executor-manifest-unsafe-for-action:${safeActionId}:missing-field`);
            }

            let hasInvalid = false;
            if (entry.actionId !== undefined && (typeof entry.actionId !== 'string' || entry.actionId !== action.id)) {
              hasInvalid = true;
            }
            if (entry.implementationId !== undefined && (typeof entry.implementationId !== 'string' || !SAFE_IMPLEMENTATION_ID_PATTERN.test(entry.implementationId))) {
              hasInvalid = true;
            }
            if (entry.mode !== undefined && entry.mode !== 'guarded-host-action') {
              hasInvalid = true;
            }
            if (entry.requiresApprovalRecord !== undefined && entry.requiresApprovalRecord !== true) {
              hasInvalid = true;
            }
            if (entry.maxAttempts !== undefined && (typeof entry.maxAttempts !== 'number' || !Number.isInteger(entry.maxAttempts) || entry.maxAttempts < 1 || entry.maxAttempts > 3)) {
              hasInvalid = true;
            }

            if (hasInvalid) {
              manifestBlockers.push(`executor-manifest-unsafe-for-action:${safeActionId}:invalid-field`);
            }

            const sanitized = sanitizeEntry(entry);
            if (sanitized) {
              actionManifests.push(sanitized);
            }
          }
        }
      }

      for (const entry of manifest.actions) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const entryActionId = entry.actionId;
          if (typeof entryActionId !== 'string' || !planActionIds.has(entryActionId)) {
            const safeEntryActionId = isSafeString(entryActionId) ? entryActionId : 'redacted-action-id';
            manifestBlockers.push(`executor-manifest-unsafe-for-action:${safeEntryActionId}:invalid-field`);
          }
        }
      }
    }
  }

  const uniqueManifestBlockers = [...new Set(manifestBlockers)];
  const manifestReady = uniqueManifestBlockers.length === 0;
  const manifestState = manifestReady ? 'ready' : 'blocked';
  const topBlockers = [...new Set([...uniqueManifestBlockers, 'guarded-executor-runner-missing'])];

  return {
    command: 'supervisor-lifecycle-executor-manifest-readiness',
    operation,
    state: 'blocked',
    manifestState,
    manifestReady,
    executorReady: false,
    manifestBlockers: uniqueManifestBlockers,
    blockers: topBlockers,
    nextBlockers: ['guarded-executor-runner-missing'],
    actionManifests,
    gates: {
      lifecyclePlanValid: !planBlockers.includes('invalid-lifecycle-plan') && !planBlockers.includes('lifecycle-plan-action-mismatch'),
      manifestReady,
      executorImplemented: false,
    },
    safety: {
      ...lifecycleSafety(),
      readOnly: true,
      lifecycleApplied: false,
    },
  };
}

export function buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, runnerBinding) {
  const runnerBlockers = [];
  const operation = ALLOWED_OPERATIONS.has(manifestReadiness?.operation) ? manifestReadiness.operation : 'unknown';
  const manifestReady = manifestReadiness?.manifestReady === true;
  const actionManifests = Array.isArray(manifestReadiness?.actionManifests)
    ? manifestReadiness.actionManifests
    : [];
  const runnerBindings = isObject(runnerBinding) && Array.isArray(runnerBinding.bindings)
    ? runnerBinding.bindings.map(sanitizeRunnerBindingEntry).filter(Boolean)
    : [];

  if (!isObject(manifestReadiness) ||
      manifestReadiness.command !== 'supervisor-lifecycle-executor-manifest-readiness' ||
      !Array.isArray(manifestReadiness.blockers) ||
      !Array.isArray(manifestReadiness.actionManifests)) {
    runnerBlockers.push('invalid-executor-manifest-readiness');
  } else if (!manifestReady) {
    runnerBlockers.push('executor-manifest-not-ready');
  }

  if (runnerBinding !== undefined && runnerBinding !== null) {
    const checkResults = checkManifestForUnsafeValues(runnerBinding);
    if (checkResults.hasPlaceholder) {
      runnerBlockers.push('unresolved-placeholder');
    }
    if (checkResults.hasSecret) {
      runnerBlockers.push('secret-reference');
    }
  }

  if (!isObject(runnerBinding)) {
    runnerBlockers.push('guarded-runner-binding-invalid-bindings');
  } else {
    const topAllowedKeys = new Set(['kind', 'schemaVersion', 'bindings']);
    if (Object.keys(runnerBinding).some((key) => !topAllowedKeys.has(key))) {
      runnerBlockers.push('guarded-runner-binding-invalid-schema');
    }
    if (runnerBinding.kind !== GUARDED_RUNNER_BINDING_KIND) {
      runnerBlockers.push('guarded-runner-binding-invalid-kind');
    }
    if (runnerBinding.schemaVersion !== 1) {
      runnerBlockers.push('guarded-runner-binding-invalid-schema');
    }
    if (!Array.isArray(runnerBinding.bindings)) {
      runnerBlockers.push('guarded-runner-binding-invalid-bindings');
    }
  }

  if (Array.isArray(runnerBinding?.bindings)) {
    for (const manifestEntry of actionManifests) {
      const safeActionId = safeActionBlockerId(manifestEntry?.actionId);
      const matches = runnerBinding.bindings.filter((entry) =>
        isObject(entry) &&
        entry.actionId === manifestEntry.actionId &&
        entry.implementationId === manifestEntry.implementationId &&
        entry.mode === manifestEntry.mode);

      if (matches.length === 0) {
        runnerBlockers.push(`guarded-runner-binding-missing-for-action:${safeActionId}`);
      } else if (matches.length > 1) {
        runnerBlockers.push(`guarded-runner-binding-unsafe-for-action:${safeActionId}:invalid-field`);
      }
    }

    for (const entry of runnerBinding.bindings) {
      if (!isObject(entry)) {
        runnerBlockers.push('guarded-runner-binding-invalid-bindings');
        continue;
      }

      const safeActionId = safeActionBlockerId(entry.actionId);
      if (Object.keys(entry).some((key) => !RUNNER_BINDING_ALLOWED_KEYS.has(key))) {
        runnerBlockers.push(`guarded-runner-binding-unsafe-for-action:${safeActionId}:forbidden-field`);
      }
      if (RUNNER_BINDING_REQUIRED_FIELDS.some((field) => entry[field] === undefined)) {
        runnerBlockers.push(`guarded-runner-binding-unsafe-for-action:${safeActionId}:missing-field`);
      }

      let hasInvalid = false;
      const matchingManifest = actionManifests.find((manifestEntry) =>
        manifestEntry.actionId === entry.actionId &&
        manifestEntry.implementationId === entry.implementationId &&
        manifestEntry.mode === entry.mode);
      if (!matchingManifest) {
        hasInvalid = true;
      }
      if (entry.actionId !== undefined && (typeof entry.actionId !== 'string' || !isSafeString(entry.actionId))) {
        hasInvalid = true;
      }
      if (entry.implementationId !== undefined &&
          (typeof entry.implementationId !== 'string' || !SAFE_IMPLEMENTATION_ID_PATTERN.test(entry.implementationId))) {
        hasInvalid = true;
      }
      if (entry.mode !== undefined && entry.mode !== GUARDED_RUNNER_BINDING_MODE) {
        hasInvalid = true;
      }
      if (entry.runnerKind !== undefined && entry.runnerKind !== GUARDED_RUNNER_KIND) {
        hasInvalid = true;
      }
      if (entry.requiresApprovalRecord !== undefined && entry.requiresApprovalRecord !== true) {
        hasInvalid = true;
      }
      if (entry.maxAttempts !== undefined &&
          (typeof entry.maxAttempts !== 'number' ||
            !Number.isInteger(entry.maxAttempts) ||
            entry.maxAttempts < 1 ||
            entry.maxAttempts > 3)) {
        hasInvalid = true;
      }

      if (hasInvalid) {
        runnerBlockers.push(`guarded-runner-binding-unsafe-for-action:${safeActionId}:invalid-field`);
      }
    }
  }

  const uniqueRunnerBlockers = [...new Set(runnerBlockers)];
  const runnerBindingsReady = uniqueRunnerBlockers.length === 0;

  return {
    command: 'supervisor-lifecycle-guarded-runner-readiness',
    operation,
    state: 'blocked',
    runnerBindingState: runnerBindingsReady ? 'ready' : 'blocked',
    runnerBindingsReady,
    executorReady: false,
    runnerBlockers: uniqueRunnerBlockers,
    blockers: [...new Set([...uniqueRunnerBlockers, GUARDED_RUNNER_EXECUTION_DISABLED])],
    nextBlockers: [GUARDED_RUNNER_EXECUTION_DISABLED],
    runnerBindings,
    gates: {
      manifestReady,
      runnerBindingsReady,
      executorImplemented: false,
    },
    safety: {
      ...lifecycleSafety(),
      readOnly: true,
      lifecycleApplied: false,
    },
  };
}

function isLifecycleApplyPlanShape(plan) {
  return isObject(plan) &&
    plan.command === 'supervisor-lifecycle-apply' &&
    ALLOWED_OPERATIONS.has(plan.operation) &&
    Array.isArray(plan.actions) &&
    Array.isArray(plan.blockers);
}

function isGuardedRunnerReadinessShape(readiness) {
  return isObject(readiness) &&
    readiness.command === 'supervisor-lifecycle-guarded-runner-readiness' &&
    typeof readiness.runnerBindingsReady === 'boolean' &&
    Array.isArray(readiness.blockers) &&
    Array.isArray(readiness.nextBlockers) &&
    Array.isArray(readiness.runnerBlockers) &&
    Array.isArray(readiness.runnerBindings);
}

function isApplyReadinessShape(readiness) {
  return isObject(readiness) &&
    readiness.command === 'supervisor-lifecycle-apply-readiness' &&
    typeof readiness.approvalRecordReady === 'boolean' &&
    Array.isArray(readiness.blockers) &&
    Array.isArray(readiness.nextBlockers);
}

function isExecutorManifestReadinessShape(readiness) {
  return isObject(readiness) &&
    readiness.command === 'supervisor-lifecycle-executor-manifest-readiness' &&
    typeof readiness.manifestReady === 'boolean' &&
    Array.isArray(readiness.blockers) &&
    Array.isArray(readiness.nextBlockers) &&
    Array.isArray(readiness.manifestBlockers) &&
    Array.isArray(readiness.actionManifests);
}

function isGuardedRunnerExecutionPreviewShape(preview) {
  return isObject(preview) &&
    preview.command === 'supervisor-lifecycle-guarded-runner-execution-preview' &&
    typeof preview.executionReady === 'boolean' &&
    typeof preview.executorReady === 'boolean' &&
    typeof preview.wouldExecute === 'boolean' &&
    Array.isArray(preview.blockers) &&
    Array.isArray(preview.nextBlockers) &&
    Array.isArray(preview.actionPreviews);
}

function buildGuardedRunnerActionPreviews(plan, guardedRunnerReadiness) {
  if (!Array.isArray(plan?.actions) || !Array.isArray(guardedRunnerReadiness?.runnerBindings)) {
    return [];
  }

  return plan.actions
    .map((action) => {
      const binding = guardedRunnerReadiness.runnerBindings.find((entry) =>
        isObject(entry) && entry.actionId === action?.id);
      if (!binding) return null;
      return {
        actionId: sanitizeExecutionPreviewMetadata(action?.id),
        implementationId: sanitizeExecutionPreviewMetadata(binding.implementationId),
        runnerKind: sanitizeExecutionPreviewMetadata(binding.runnerKind),
        mode: sanitizeExecutionPreviewMetadata(binding.mode),
        status: 'blocked',
        wouldExecute: false,
        wouldRun: false,
        wouldWrite: false,
        maxAttempts: sanitizeExecutionPreviewMaxAttempts(binding.maxAttempts),
      };
    })
    .filter(Boolean);
}

export function buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, guardedRunnerReadiness) {
  const operation = ALLOWED_OPERATIONS.has(plan?.operation)
    ? plan.operation
    : (ALLOWED_OPERATIONS.has(guardedRunnerReadiness?.operation) ? guardedRunnerReadiness.operation : 'unknown');
  const blockers = [];
  let lifecyclePlanValid = false;
  let runnerBindingsReady = false;

  if (!isLifecycleApplyPlanShape(plan)) {
    blockers.push('invalid-lifecycle-plan');
  } else if (!hasExpectedLifecycleActions(plan)) {
    blockers.push('lifecycle-plan-action-mismatch');
  } else {
    lifecyclePlanValid = true;
  }

  if (!isGuardedRunnerReadinessShape(guardedRunnerReadiness)) {
    blockers.push('invalid-guarded-runner-readiness');
  } else {
    runnerBindingsReady = guardedRunnerReadiness.runnerBindingsReady === true;
    if (!runnerBindingsReady) {
      blockers.push('guarded-runner-readiness-not-ready');
    }
  }

  if (lifecyclePlanValid && isGuardedRunnerReadinessShape(guardedRunnerReadiness)) {
    if (guardedRunnerReadiness.operation !== plan.operation) {
      blockers.push('guarded-runner-operation-mismatch');
      runnerBindingsReady = false;
    }
  }

  blockers.push(GUARDED_RUNNER_EXECUTION_PREVIEW_ONLY);

  return {
    command: 'supervisor-lifecycle-guarded-runner-execution-preview',
    operation,
    state: 'blocked',
    executionReady: false,
    executorReady: false,
    wouldExecute: false,
    runnerBindingsReady,
    blockers: [...new Set(blockers)],
    nextBlockers: [REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING],
    actionPreviews: buildGuardedRunnerActionPreviews(plan, guardedRunnerReadiness),
    gates: {
      lifecyclePlanValid,
      runnerBindingsReady,
      executionPreviewOnly: true,
      executorReady: false,
    },
    safety: executionPreviewSafety(),
  };
}

function snapshotExactKeyPlainPolicyContext(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return null;
  const proto = Object.getPrototypeOf(context);
  if (proto !== Object.prototype && proto !== null) return null;

  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(context);
  } catch {
    return null;
  }

  const expected = new Set(EXECUTION_POLICY_CONTEXT_KEYS);
  if (ownKeys.length !== expected.size) return null;
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !expected.has(key)) return null;
  }

  const snapshot = Object.create(null);
  for (const key of EXECUTION_POLICY_CONTEXT_KEYS) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(context, key);
    } catch {
      return null;
    }
    if (!desc || desc.get !== undefined || desc.set !== undefined || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      return null;
    }
    snapshot[key] = desc.value;
  }

  if (typeof snapshot.operation !== 'string') return null;
  for (const key of POLICY_FACT_KEYS) {
    if (snapshot[key] !== true && snapshot[key] !== false) return null;
  }
  return snapshot;
}

function buildExecutionPolicyDecisionBase(fields) {
  return {
    command: 'supervisor-lifecycle-guarded-runner-execution-policy',
    operation: fields.operation,
    state: fields.state,
    authorized: fields.authorized,
    wouldAuthorizeExecution: fields.wouldAuthorizeExecution,
    wouldRun: false,
    wouldWrite: false,
    primaryBlocker: fields.primaryBlocker,
    blockers: [...fields.blockers],
    nextBlockers: [...fields.nextBlockers],
    policyKind: FAIL_CLOSED_EXECUTION_POLICY_KIND,
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
    sensitiveValuesReturned: false,
    safety: executionPreviewSafety(),
  };
}

function denyExecutionPolicyDecision(operation, blockers) {
  const safeBlockers = blockers.filter((code) => EXECUTION_POLICY_BLOCKER_CODE_SET.has(code));
  const finalBlockers = safeBlockers.length > 0
    ? safeBlockers
    : [EXECUTION_POLICY_CONTEXT_INVALID];
  return buildExecutionPolicyDecisionBase({
    operation,
    state: 'denied',
    authorized: false,
    wouldAuthorizeExecution: false,
    primaryBlocker: finalBlockers[0],
    blockers: finalBlockers,
    nextBlockers: [finalBlockers[0]],
  });
}

function authorizeExecutionPolicyDecision(operation) {
  return buildExecutionPolicyDecisionBase({
    operation,
    state: 'authorized',
    authorized: true,
    wouldAuthorizeExecution: true,
    primaryBlocker: null,
    blockers: [],
    nextBlockers: [],
  });
}

/**
 * Pure fail-closed execution policy evaluator for guarded runner lifecycle.
 * Authorizes only exact-key plain boolean context with all facts true.
 * Never sets wouldRun/wouldWrite/allow* true. Deep-copy output.
 *
 * @param {unknown} context
 * @returns {object}
 */
export function evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context) {
  try {
    const snapshot = snapshotExactKeyPlainPolicyContext(context);
    if (!snapshot) {
      return denyExecutionPolicyDecision('unknown', [EXECUTION_POLICY_CONTEXT_INVALID]);
    }

    const operation = snapshot.operation;
    if (!ALLOWED_OPERATIONS.has(operation)) {
      return denyExecutionPolicyDecision('unknown', [EXECUTION_POLICY_OPERATION_INVALID]);
    }

    const blockers = [];
    for (const key of POLICY_FACT_KEYS) {
      if (snapshot[key] !== true) {
        blockers.push(POLICY_FACT_BLOCKERS[key]);
      }
    }
    if (blockers.length > 0) {
      return denyExecutionPolicyDecision(operation, blockers);
    }
    return authorizeExecutionPolicyDecision(operation);
  } catch {
    return denyExecutionPolicyDecision('unknown', [EXECUTION_POLICY_CONTEXT_INVALID]);
  }
}

function sanitizePolicyDecision(decision) {
  const deniedInvalid = () => denyExecutionPolicyDecision('unknown', [EXECUTION_POLICY_CONTEXT_INVALID]);
  if (!isObject(decision)) return deniedInvalid();

  try {
    // Only allowlisted lifecycle operations keep their id; anything else is unknown.
    // Do not invent a default operation here — authorize path never falls back to install.
    const operation = typeof decision.operation === 'string' && ALLOWED_OPERATIONS.has(decision.operation)
      ? decision.operation
      : 'unknown';

    const rawBlockers = Array.isArray(decision.blockers) ? decision.blockers : null;
    if (rawBlockers === null) return deniedInvalid();
    const blockers = [];
    for (const code of rawBlockers) {
      if (typeof code !== 'string' || !EXECUTION_POLICY_BLOCKER_CODE_SET.has(code)) {
        return deniedInvalid();
      }
      blockers.push(code);
    }

    let primaryBlocker = decision.primaryBlocker;
    if (primaryBlocker !== null && primaryBlocker !== undefined) {
      if (typeof primaryBlocker !== 'string' || !EXECUTION_POLICY_BLOCKER_CODE_SET.has(primaryBlocker)) {
        return deniedInvalid();
      }
    } else {
      primaryBlocker = null;
    }

    const state = decision.state;
    const authorized = decision.authorized === true;
    const wouldAuthorizeExecution = decision.wouldAuthorizeExecution === true;
    // Authorize only when flags are consistent AND operation is allowlisted.
    // unknown/invalid operation with authorized flags collapses to deniedInvalid —
    // never authorizeExecutionPolicyDecision('install') as a fallback.
    const consistentAuthorized =
      state === 'authorized' &&
      authorized &&
      wouldAuthorizeExecution &&
      ALLOWED_OPERATIONS.has(operation);
    const consistentDenied = state === 'denied' && !authorized && !wouldAuthorizeExecution &&
      decision.authorized === false && decision.wouldAuthorizeExecution === false;

    if (!consistentAuthorized && !consistentDenied) {
      return deniedInvalid();
    }

    if (consistentAuthorized) {
      if (blockers.length !== 0 || primaryBlocker !== null) return deniedInvalid();
      return authorizeExecutionPolicyDecision(operation);
    }

    if (blockers.length < 1) return deniedInvalid();
    if (primaryBlocker !== blockers[0]) return deniedInvalid();
    return denyExecutionPolicyDecision(operation, blockers);
  } catch {
    return deniedInvalid();
  }
}

function isPlainDataPropertyObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function snapshotPlainCandidate(candidate) {
  if (!isPlainDataPropertyObject(candidate)) return null;
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(candidate);
  } catch {
    return null;
  }
  if (ownKeys.length !== ACTION_CANDIDATE_ALLOWED_KEYS.length) return null;
  const allowed = new Set(ACTION_CANDIDATE_ALLOWED_KEYS);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !allowed.has(key)) return null;
  }

  const snapshot = Object.create(null);
  for (const key of ACTION_CANDIDATE_ALLOWED_KEYS) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(candidate, key);
    } catch {
      return null;
    }
    if (!desc || desc.get !== undefined || desc.set !== undefined || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      return null;
    }
    snapshot[key] = desc.value;
  }
  return snapshot;
}

function isValidActionCandidateSnapshot(snapshot) {
  if (!snapshot) return false;
  if (typeof snapshot.actionId !== 'string' || snapshot.actionId.length < 1) return false;
  if (typeof snapshot.implementationId !== 'string') return false;
  if (typeof snapshot.runnerKind !== 'string') return false;
  if (typeof snapshot.mode !== 'string') return false;
  if (snapshot.status !== 'blocked') return false;
  if (snapshot.wouldExecute !== false) return false;
  if (snapshot.wouldRun !== false) return false;
  if (snapshot.wouldWrite !== false) return false;
  if (!(
    (typeof snapshot.maxAttempts === 'number' &&
      Number.isInteger(snapshot.maxAttempts) &&
      snapshot.maxAttempts >= 1 &&
      snapshot.maxAttempts <= 3) ||
    snapshot.maxAttempts === '[redacted]'
  )) {
    return false;
  }
  return true;
}

/**
 * Structural readiness for sanitized guarded-runner action candidates.
 * Returns true only when candidates pass exact schema / nonempty / unique
 * actionId / operation expected-set match / sensitive-field-free checks.
 * Does NOT authorize execution, wouldRun, wouldWrite, or executionEligible.
 * Invalid input, getters, or traps yield false. Returns boolean only — no metadata.
 *
 * @param {unknown} candidates - already-sanitized candidate array (or invalid input)
 * @param {unknown} operation - allowlisted lifecycle operation string
 * @returns {boolean}
 */
export function areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, operation) {
  try {
    if (!ALLOWED_OPERATIONS.has(operation)) return false;
    if (!Array.isArray(candidates) || candidates.length < 1) return false;

    const expectedIds = buildLifecycleActions(operation).map((action) => action.id);
    if (candidates.length !== expectedIds.length) return false;

    const seen = new Set();
    const actualIds = [];
    for (const candidate of candidates) {
      const snapshot = snapshotPlainCandidate(candidate);
      if (!isValidActionCandidateSnapshot(snapshot)) return false;
      if (seen.has(snapshot.actionId)) return false;
      seen.add(snapshot.actionId);
      actualIds.push(snapshot.actionId);
    }

    if (actualIds.length !== expectedIds.length) return false;
    const expectedSet = new Set(expectedIds);
    if (actualIds.length !== expectedSet.size) return false;
    for (const id of actualIds) {
      if (!expectedSet.has(id)) return false;
    }
    for (const id of expectedIds) {
      if (!seen.has(id)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function buildUnresolvedRegistryDecision(operation, primaryBlocker) {
  return {
    command: 'supervisor-lifecycle-guarded-runner-registry',
    operation,
    state: 'unresolved',
    registryReady: false,
    codeOwnedResolverWired: true,
    realHostRunnerReady: false,
    supportsHostMutation: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    resolvedCount: 0,
    unresolvedCount: 0,
    mappings: [],
    primaryBlocker,
    blockers: [primaryBlocker],
    nextBlockers: [primaryBlocker],
    sensitiveValuesReturned: false,
    safety: executionPreviewSafety(),
  };
}

function buildResolvedRegistryDecision(operation, mappings) {
  return {
    command: 'supervisor-lifecycle-guarded-runner-registry',
    operation,
    state: 'resolved',
    registryReady: true,
    codeOwnedResolverWired: true,
    realHostRunnerReady: false,
    supportsHostMutation: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    resolvedCount: mappings.length,
    unresolvedCount: 0,
    mappings,
    primaryBlocker: null,
    blockers: [],
    nextBlockers: [],
    sensitiveValuesReturned: false,
    safety: executionPreviewSafety(),
  };
}

function sanitizeRegistryDecision(decision) {
  const fallback = () => buildUnresolvedRegistryDecision('unknown', 'runner-registry-candidates-invalid');
  if (!isObject(decision)) return fallback();
  try {
    const operation = typeof decision.operation === 'string' && ALLOWED_OPERATIONS.has(decision.operation)
      ? decision.operation
      : 'unknown';
    const state = decision.state === 'resolved' ? 'resolved' : 'unresolved';
    const registryReady = decision.registryReady === true;
    if ((state === 'resolved') !== registryReady) {
      return buildUnresolvedRegistryDecision(operation, 'runner-registry-candidates-invalid');
    }

    const rawBlockers = Array.isArray(decision.blockers) ? decision.blockers : [];
    const blockers = [];
    for (const code of rawBlockers) {
      if (typeof code === 'string' && RUNNER_REGISTRY_BLOCKER_CODE_SET.has(code)) {
        blockers.push(code);
      }
    }

    if (state === 'resolved') {
      if (blockers.length !== 0 || decision.primaryBlocker !== null) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-candidates-invalid');
      }
      const mappings = Array.isArray(decision.mappings)
        ? decision.mappings.map((row) => ({
          actionId: typeof row?.actionId === 'string' ? row.actionId : 'unknown',
          implementationId: typeof row?.implementationId === 'string' ? row.implementationId : 'unknown',
          runnerKind: GUARDED_RUNNER_KIND,
          mode: GUARDED_RUNNER_BINDING_MODE,
          maxAttempts: Number.isInteger(row?.maxAttempts) && row.maxAttempts >= 1 && row.maxAttempts <= 3
            ? row.maxAttempts
            : 1,
          mappingReady: true,
          realHostRunnerReady: false,
          supportsHostMutation: false,
          wouldExecute: false,
          wouldRun: false,
          wouldWrite: false,
          blockerCode: null,
          evidenceCode: RUNNER_REGISTRY_MAPPING_READY_EVIDENCE,
        }))
        : [];
      return buildResolvedRegistryDecision(operation, mappings);
    }

    const primary = typeof decision.primaryBlocker === 'string' && RUNNER_REGISTRY_BLOCKER_CODE_SET.has(decision.primaryBlocker)
      ? decision.primaryBlocker
      : (blockers[0] || 'runner-registry-candidates-invalid');
    return buildUnresolvedRegistryDecision(
      primary === 'runner-registry-operation-invalid' ? 'unknown' : operation,
      primary,
    );
  } catch {
    return fallback();
  }
}

/**
 * Resolve and verify sanitized guarded-runner action candidates against the
 * code-owned runner registry mapping table.
 *
 * Ready resolution means only that every candidate actionId maps to the fixed
 * implementationId / runnerKind / mode / numeric maxAttempts bounds for the
 * given operation. It does NOT schedule, dispatch, or invoke any runner; does
 * NOT authorize host mutation; does NOT set wouldExecute/wouldRun/wouldWrite
 * true; does NOT imply executionEligible.
 *
 * Returns a deep-copied plain decision object only — never functions,
 * command strings, paths, hosts, tokens, hashes, or raw Error objects.
 * Invalid input, getters, traps, or mapping mismatch → fail-closed unresolved.
 *
 * @param {unknown} candidates
 * @param {unknown} operation
 * @returns {object}
 */
export function resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, operation) {
  try {
    if (typeof operation !== 'string' || !ALLOWED_OPERATIONS.has(operation)) {
      return buildUnresolvedRegistryDecision('unknown', 'runner-registry-operation-invalid');
    }

    if (!Array.isArray(candidates)) {
      return buildUnresolvedRegistryDecision(operation, 'runner-registry-candidates-invalid');
    }

    let len;
    try {
      len = candidates.length;
    } catch {
      return buildUnresolvedRegistryDecision(operation, 'runner-registry-candidates-invalid');
    }
    if (!Number.isInteger(len) || len < 0 || !Number.isFinite(len)) {
      return buildUnresolvedRegistryDecision(operation, 'runner-registry-candidates-invalid');
    }
    if (len < 1) {
      return buildUnresolvedRegistryDecision(operation, 'runner-registry-candidates-invalid');
    }

    const elements = [];
    try {
      for (let i = 0; i < len; i++) {
        elements.push(candidates[i]);
      }
    } catch {
      return buildUnresolvedRegistryDecision(operation, 'runner-registry-candidates-invalid');
    }

    const snapshots = [];
    for (const element of elements) {
      const snapshot = snapshotPlainCandidate(element);
      if (!snapshot) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-candidates-invalid');
      }
      snapshots.push(snapshot);
    }

    for (const snapshot of snapshots) {
      if (typeof snapshot.actionId !== 'string' || snapshot.actionId.length < 1) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-candidates-invalid');
      }
    }

    const expectedIds = buildLifecycleActions(operation).map((action) => action.id);
    const expectedSet = new Set(expectedIds);
    const actionIds = snapshots.map((snapshot) => snapshot.actionId);

    const seen = new Set();
    for (const actionId of actionIds) {
      if (seen.has(actionId)) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-action-duplicate');
      }
      seen.add(actionId);
    }

    for (const actionId of actionIds) {
      if (!expectedSet.has(actionId)) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-action-unknown');
      }
    }

    for (const expectedId of expectedIds) {
      if (!seen.has(expectedId)) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-action-missing');
      }
    }

    const byActionId = new Map(snapshots.map((snapshot) => [snapshot.actionId, snapshot]));
    const mappings = [];
    for (const actionId of expectedIds) {
      const snapshot = byActionId.get(actionId);
      const catalogImpl = CODE_OWNED_ACTION_IMPLEMENTATION_MAP[actionId];
      if (
        typeof snapshot.implementationId !== 'string' ||
        !SAFE_IMPLEMENTATION_ID_PATTERN.test(snapshot.implementationId) ||
        snapshot.implementationId !== catalogImpl
      ) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-implementation-mismatch');
      }
      if (snapshot.runnerKind !== GUARDED_RUNNER_KIND) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-runner-kind-mismatch');
      }
      if (snapshot.mode !== GUARDED_RUNNER_BINDING_MODE) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-mode-mismatch');
      }
      if (!(
        typeof snapshot.maxAttempts === 'number' &&
        Number.isInteger(snapshot.maxAttempts) &&
        snapshot.maxAttempts >= 1 &&
        snapshot.maxAttempts <= 3
      )) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-max-attempts-invalid');
      }
      if (
        snapshot.status !== 'blocked' ||
        snapshot.wouldExecute !== false ||
        snapshot.wouldRun !== false ||
        snapshot.wouldWrite !== false
      ) {
        return buildUnresolvedRegistryDecision(operation, 'runner-registry-side-effect-flag-invalid');
      }
      mappings.push({
        actionId,
        implementationId: catalogImpl,
        runnerKind: GUARDED_RUNNER_KIND,
        mode: GUARDED_RUNNER_BINDING_MODE,
        maxAttempts: snapshot.maxAttempts,
        mappingReady: true,
        realHostRunnerReady: false,
        supportsHostMutation: false,
        wouldExecute: false,
        wouldRun: false,
        wouldWrite: false,
        blockerCode: null,
        evidenceCode: RUNNER_REGISTRY_MAPPING_READY_EVIDENCE,
      });
    }

    return buildResolvedRegistryDecision(operation, mappings);
  } catch {
    const op = typeof operation === 'string' && ALLOWED_OPERATIONS.has(operation) ? operation : 'unknown';
    return buildUnresolvedRegistryDecision(
      op === 'unknown' ? 'unknown' : op,
      op === 'unknown' ? 'runner-registry-operation-invalid' : 'runner-registry-candidates-invalid',
    );
  }
}

function buildUnresolvedAdapterDecision(operation, primaryBlocker) {
  return {
    command: 'supervisor-lifecycle-guarded-runner-host-mutation-adapter',
    operation,
    state: 'unresolved',
    adapterReady: false,
    codeOwnedResolverWired: true,
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
    resolvedCount: 0,
    unresolvedCount: 0,
    mutations: [],
    primaryBlocker,
    blockers: [primaryBlocker],
    nextBlockers: [primaryBlocker],
    sensitiveValuesReturned: false,
    safety: executionPreviewSafety(),
  };
}

function buildResolvedAdapterDecision(operation, mutations) {
  return {
    command: 'supervisor-lifecycle-guarded-runner-host-mutation-adapter',
    operation,
    state: 'resolved',
    adapterReady: true,
    codeOwnedResolverWired: true,
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
    resolvedCount: mutations.length,
    unresolvedCount: 0,
    mutations,
    primaryBlocker: null,
    blockers: [],
    nextBlockers: [],
    sensitiveValuesReturned: false,
    safety: executionPreviewSafety(),
  };
}

export function sanitizeHostMutationAdapterDecision(decision) {
  const fallback = () => buildUnresolvedAdapterDecision('unknown', 'host-mutation-adapter-candidates-invalid');
  if (!isObject(decision)) return fallback();
  try {
    const operation = typeof decision.operation === 'string' && ALLOWED_OPERATIONS.has(decision.operation)
      ? decision.operation
      : 'unknown';
    const state = decision.state === 'resolved' ? 'resolved' : 'unresolved';
    const adapterReady = decision.adapterReady === true;
    if ((state === 'resolved') !== adapterReady) {
      return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-candidates-invalid');
    }

    const rawBlockers = Array.isArray(decision.blockers) ? decision.blockers : [];
    const blockers = [];
    for (const code of rawBlockers) {
      if (typeof code === 'string' && HOST_MUTATION_ADAPTER_BLOCKER_CODE_SET.has(code)) {
        blockers.push(code);
      }
    }

    if (state === 'resolved') {
      if (blockers.length !== 0 || decision.primaryBlocker !== null) {
        return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-candidates-invalid');
      }
      const mutations = Array.isArray(decision.mutations)
        ? decision.mutations.map((row) => {
          const actionId = typeof row?.actionId === 'string' ? row.actionId : 'unknown';
          // Always code-owned mapping; never passthrough input mutationKind on mismatch.
          const mappedKind = CODE_OWNED_ACTION_MUTATION_MAP[actionId];
          return {
            actionId,
            mutationKind: typeof mappedKind === 'string' ? mappedKind : 'unknown',
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
            evidenceCode: HOST_MUTATION_ADAPTER_MUTATION_READY_EVIDENCE,
          };
        })
        : [];
      return buildResolvedAdapterDecision(operation, mutations);
    }

    const primary = typeof decision.primaryBlocker === 'string' && HOST_MUTATION_ADAPTER_BLOCKER_CODE_SET.has(decision.primaryBlocker)
      ? decision.primaryBlocker
      : (blockers[0] || 'host-mutation-adapter-candidates-invalid');
    return buildUnresolvedAdapterDecision(
      primary === 'host-mutation-adapter-operation-invalid' ? 'unknown' : operation,
      primary,
    );
  } catch {
    return fallback();
  }
}

/**
 * Resolve and verify sanitized guarded-runner action candidates against the
 * code-owned restricted host-mutation-adapter mapping table.
 *
 * Ready resolution means only that every candidate actionId maps to the fixed
 * restricted mutationKind for the given operation. It does NOT execute
 * launchctl/shell/filesystem/process/metadata/audit/network; does NOT set
 * wouldMutateHost / *Allowed / wouldExecute/wouldRun/wouldWrite true; does NOT
 * imply realHostMutationImplementationReady or executionEligible.
 *
 * Returns a deep-copied plain decision object only — never functions,
 * command strings, paths, hosts, tokens, hashes, or raw Error objects.
 * Invalid input, getters, traps, unsafe mutation flags, or set mismatch →
 * fail-closed unresolved.
 *
 * @param {unknown} candidates
 * @param {unknown} operation
 * @returns {object}
 */
export function resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, operation) {
  try {
    if (typeof operation !== 'string' || !ALLOWED_OPERATIONS.has(operation)) {
      return buildUnresolvedAdapterDecision('unknown', 'host-mutation-adapter-operation-invalid');
    }

    if (!Array.isArray(candidates)) {
      return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-candidates-invalid');
    }

    let len;
    try {
      len = candidates.length;
    } catch {
      return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-candidates-invalid');
    }
    if (!Number.isInteger(len) || len < 0 || !Number.isFinite(len)) {
      return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-candidates-invalid');
    }
    if (len < 1) {
      return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-candidates-invalid');
    }

    const elements = [];
    try {
      for (let i = 0; i < len; i++) {
        elements.push(candidates[i]);
      }
    } catch {
      return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-candidates-invalid');
    }

    const snapshots = [];
    for (const element of elements) {
      const snapshot = snapshotPlainCandidate(element);
      if (!snapshot) {
        return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-candidates-invalid');
      }
      snapshots.push(snapshot);
    }

    for (const snapshot of snapshots) {
      if (typeof snapshot.actionId !== 'string' || snapshot.actionId.length < 1) {
        return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-candidates-invalid');
      }
    }

    const expectedIds = buildLifecycleActions(operation).map((action) => action.id);
    const expectedSet = new Set(expectedIds);
    const actionIds = snapshots.map((snapshot) => snapshot.actionId);

    const seen = new Set();
    for (const actionId of actionIds) {
      if (seen.has(actionId)) {
        return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-action-duplicate');
      }
      seen.add(actionId);
    }

    for (const actionId of actionIds) {
      if (!expectedSet.has(actionId)) {
        return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-action-unknown');
      }
    }

    for (const expectedId of expectedIds) {
      if (!seen.has(expectedId)) {
        return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-action-missing');
      }
    }

    const byActionId = new Map(snapshots.map((snapshot) => [snapshot.actionId, snapshot]));
    const mutations = [];
    for (const actionId of expectedIds) {
      const snapshot = byActionId.get(actionId);
      // intentional layered fail-closed: ignore implementationId / runnerKind / mode / maxAttempts values
      if (
        snapshot.status !== 'blocked' ||
        snapshot.wouldExecute !== false ||
        snapshot.wouldRun !== false ||
        snapshot.wouldWrite !== false
      ) {
        return buildUnresolvedAdapterDecision(operation, 'host-mutation-adapter-unsafe-mutation');
      }
      const mutationKind = CODE_OWNED_ACTION_MUTATION_MAP[actionId];
      mutations.push({
        actionId,
        mutationKind,
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
        evidenceCode: HOST_MUTATION_ADAPTER_MUTATION_READY_EVIDENCE,
      });
    }

    return buildResolvedAdapterDecision(operation, mutations);
  } catch {
    const op = typeof operation === 'string' && ALLOWED_OPERATIONS.has(operation) ? operation : 'unknown';
    return buildUnresolvedAdapterDecision(
      op === 'unknown' ? 'unknown' : op,
      op === 'unknown' ? 'host-mutation-adapter-operation-invalid' : 'host-mutation-adapter-candidates-invalid',
    );
  }
}

export function buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness() {
  return {
    command: 'supervisor-lifecycle-guarded-runner-execution-policy-readiness',
    state: 'ready',
    executionPolicyDefined: true,
    executionPolicyReady: true,
    realExecutionPolicyReady: true,
    readyCount: 1,
    blockedCount: 0,
    policyEntries: [{ ...GUARDED_RUNNER_READY_EXECUTION_POLICY_ENTRY }],
    blockers: [],
    nextBlockers: [],
    safety: executionPreviewSafety(),
  };
}

export function buildSupervisorLifecycleGuardedRunnerRegistryReadiness() {
  return {
    command: 'supervisor-lifecycle-guarded-runner-registry-readiness',
    state: 'ready',
    runnerRegistryDefined: true,
    runnerRegistryReady: true,
    codeOwnedRegistryResolverReady: true,
    realRunnerImplementationsReady: false,
    readyCount: 1,
    blockedCount: 0,
    registryEntries: [{ ...GUARDED_RUNNER_READY_REGISTRY_ENTRY }],
    blockers: [],
    nextBlockers: [],
    safety: executionPreviewSafety(),
  };
}

export function buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness() {
  return {
    command: 'supervisor-lifecycle-guarded-runner-host-mutation-adapter-readiness',
    state: 'ready',
    hostMutationAdapterDefined: true,
    hostMutationAdapterReady: true,
    codeOwnedAdapterResolverReady: true,
    realHostMutationImplementationReady: false,
    readyCount: 1,
    blockedCount: 0,
    adapterEntries: [{ ...GUARDED_RUNNER_READY_HOST_MUTATION_ADAPTER_ENTRY }],
    blockers: [],
    nextBlockers: [],
    safety: executionPreviewSafety(),
  };
}

export function buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness() {
  return {
    command: 'supervisor-lifecycle-guarded-runner-rollback-anchor-readiness',
    state: 'blocked',
    rollbackAnchorDefined: true,
    rollbackAnchorReady: false,
    realRollbackAnchorReady: false,
    readyCount: 0,
    blockedCount: 1,
    anchorEntries: [{ ...GUARDED_RUNNER_DISABLED_ROLLBACK_ANCHOR_ENTRY }],
    blockers: [
      ROLLBACK_ANCHOR_REAL_IMPLEMENTATION_MISSING,
      REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING,
    ],
    nextBlockers: [ROLLBACK_ANCHOR_REAL_IMPLEMENTATION_MISSING],
    safety: executionPreviewSafety(),
  };
}

export function buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness() {
  return {
    command: 'supervisor-lifecycle-guarded-runner-attempt-audit-readiness',
    state: 'blocked',
    attemptAuditDefined: true,
    attemptAuditReady: false,
    realAttemptAuditReady: false,
    readyCount: 0,
    blockedCount: 1,
    auditEntries: [{ ...GUARDED_RUNNER_DISABLED_ATTEMPT_AUDIT_ENTRY }],
    blockers: [
      ATTEMPT_AUDIT_REAL_IMPLEMENTATION_MISSING,
      REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING,
    ],
    nextBlockers: [ATTEMPT_AUDIT_REAL_IMPLEMENTATION_MISSING],
    safety: executionPreviewSafety(),
  };
}

export function buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness() {
  return {
    command: 'supervisor-lifecycle-guarded-runner-operator-recovery-readiness',
    state: 'blocked',
    operatorRecoveryDefined: true,
    operatorRecoveryReady: false,
    realOperatorRecoveryReady: false,
    readyCount: 0,
    blockedCount: 1,
    recoveryEntries: [{ ...GUARDED_RUNNER_DISABLED_OPERATOR_RECOVERY_ENTRY }],
    blockers: [
      OPERATOR_RECOVERY_REAL_IMPLEMENTATION_MISSING,
      REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING,
    ],
    nextBlockers: [OPERATOR_RECOVERY_REAL_IMPLEMENTATION_MISSING],
    safety: executionPreviewSafety(),
  };
}

export function buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview) {
  const requiredContracts = GUARDED_RUNNER_WIRING_CONTRACTS.map((contract) => ({ ...contract }));
  return {
    command: 'supervisor-lifecycle-guarded-runner-wiring-contract',
    state: 'blocked',
    realRunnerWiringReady: false,
    readyCount: 3,
    blockedCount: 3,
    requiredContracts,
    executionPolicyReadiness: buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(),
    runnerRegistryReadiness: buildSupervisorLifecycleGuardedRunnerRegistryReadiness(),
    hostMutationAdapterReadiness: buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(),
    rollbackAnchorReadiness: buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(),
    attemptAuditReadiness: buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness(),
    operatorRecoveryReadiness: buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(),
    blockers: [REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING],
    nextBlockers: [REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING],
    safety: executionPreviewSafety(),
  };
}

function isGuardedRunnerExecutionPreviewVerified(preview) {
  if (!isGuardedRunnerExecutionPreviewShape(preview)) return false;
  return preview.state === 'blocked' &&
    preview.executionReady === false &&
    preview.executorReady === false &&
    preview.wouldExecute === false &&
    preview.blockers.includes(GUARDED_RUNNER_EXECUTION_PREVIEW_ONLY) &&
    preview.nextBlockers.includes(REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING) &&
    preview.actionPreviews.every((entry) =>
      isObject(entry) &&
        entry.status === 'blocked' &&
        entry.wouldExecute === false &&
        entry.wouldRun === false &&
        entry.wouldWrite === false);
}

function buildGuardedRunnerExecutionGateActionCandidates(plan, executionPreview) {
  if (!isLifecycleApplyPlanShape(plan) ||
      !hasExpectedLifecycleActions(plan) ||
      !isGuardedRunnerExecutionPreviewShape(executionPreview) ||
      !isGuardedRunnerExecutionPreviewVerified(executionPreview) ||
      executionPreview.operation !== plan.operation) {
    return [];
  }

  return plan.actions
    .map((action) => {
      const preview = executionPreview.actionPreviews.find((entry) =>
        isObject(entry) && entry.actionId === action?.id);
      if (!preview) return null;
      return {
        actionId: sanitizeExecutionPreviewMetadata(preview.actionId),
        implementationId: sanitizeExecutionPreviewMetadata(preview.implementationId),
        runnerKind: sanitizeExecutionPreviewMetadata(preview.runnerKind),
        mode: sanitizeExecutionPreviewMetadata(preview.mode),
        status: 'blocked',
        wouldExecute: false,
        wouldRun: false,
        wouldWrite: false,
        maxAttempts: sanitizeExecutionPreviewMaxAttempts(preview.maxAttempts),
      };
    })
    .filter(Boolean);
}

export function buildSupervisorLifecycleGuardedRunnerExecutionGate(
  plan,
  applyReadiness,
  manifestReadiness,
  guardedRunnerReadiness,
  executionPreview,
  options = {},
) {
  const operation = ALLOWED_OPERATIONS.has(plan?.operation)
    ? plan.operation
    : (ALLOWED_OPERATIONS.has(executionPreview?.operation) ? executionPreview.operation : 'unknown');
  const blockers = [];
  let lifecyclePlanValid = false;
  let approvalRecordReady = false;
  let manifestReady = false;
  let runnerBindingsReady = false;
  let executionPreviewVerified = false;
  const executeRequested = options?.executeRequested === true;

  if (!isLifecycleApplyPlanShape(plan)) {
    blockers.push('invalid-lifecycle-plan');
  } else if (!hasExpectedLifecycleActions(plan)) {
    blockers.push('lifecycle-plan-action-mismatch');
  } else {
    lifecyclePlanValid = true;
  }

  if (!isApplyReadinessShape(applyReadiness)) {
    blockers.push('apply-readiness-invalid');
  } else if (lifecyclePlanValid && applyReadiness.operation !== plan.operation) {
    blockers.push('apply-readiness-invalid');
  } else {
    approvalRecordReady = applyReadiness.approvalRecordReady === true;
    if (!approvalRecordReady) {
      blockers.push('approval-record-gate-not-ready');
    }
  }

  if (!isExecutorManifestReadinessShape(manifestReadiness)) {
    blockers.push('executor-manifest-readiness-invalid');
  } else if (lifecyclePlanValid && manifestReadiness.operation !== plan.operation) {
    blockers.push('executor-manifest-readiness-invalid');
  } else {
    manifestReady = manifestReadiness.manifestReady === true;
    if (!manifestReady) {
      blockers.push('executor-manifest-not-ready');
    }
  }

  if (!isGuardedRunnerReadinessShape(guardedRunnerReadiness)) {
    blockers.push('guarded-runner-readiness-invalid');
  } else if (lifecyclePlanValid && guardedRunnerReadiness.operation !== plan.operation) {
    blockers.push('guarded-runner-readiness-invalid');
  } else {
    runnerBindingsReady = guardedRunnerReadiness.runnerBindingsReady === true;
    if (!runnerBindingsReady) {
      blockers.push('guarded-runner-readiness-not-ready');
    }
  }

  if (!isGuardedRunnerExecutionPreviewShape(executionPreview)) {
    blockers.push('execution-preview-invalid');
  } else if (lifecyclePlanValid && executionPreview.operation !== plan.operation) {
    blockers.push('execution-preview-operation-mismatch');
  } else {
    executionPreviewVerified = isGuardedRunnerExecutionPreviewVerified(executionPreview);
    if (!executionPreviewVerified) {
      blockers.push('execution-preview-not-verified');
    }
  }

  if (!executeRequested) {
    blockers.push('execute-request-missing');
  }
  blockers.push(REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING);
  const runnerWiringContract = buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview);
  const actionCandidates = buildGuardedRunnerExecutionGateActionCandidates(plan, executionPreview);
  const actionCandidatesReady = areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
    actionCandidates,
    operation,
  );

  const registryDecision = sanitizeRegistryDecision(
    resolveSupervisorLifecycleGuardedRunnerRegistry(actionCandidates, operation),
  );

  // Ignore options.adapterDecision / options.hostMutationAdapterReady / options.adapterContext.
  const adapterDecision = sanitizeHostMutationAdapterDecision(
    resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(actionCandidates, operation),
  );

  const executionPolicyReadiness = runnerWiringContract.executionPolicyReadiness;
  const executionPolicyReady =
    executionPolicyReadiness?.executionPolicyReady === true &&
    executionPolicyReadiness?.realExecutionPolicyReady === true &&
    executionPolicyReadiness?.state === 'ready';

  const runnerRegistryReadiness = runnerWiringContract.runnerRegistryReadiness;
  const runnerRegistryReady =
    runnerRegistryReadiness?.runnerRegistryReady === true &&
    runnerRegistryReadiness?.codeOwnedRegistryResolverReady === true &&
    runnerRegistryReadiness?.state === 'ready' &&
    runnerRegistryReadiness?.realRunnerImplementationsReady === false &&
    registryDecision?.registryReady === true &&
    registryDecision?.state === 'resolved' &&
    registryDecision?.codeOwnedResolverWired === true &&
    registryDecision?.realHostRunnerReady === false &&
    registryDecision?.wouldExecute === false &&
    registryDecision?.wouldRun === false &&
    registryDecision?.wouldWrite === false;

  const hostMutationAdapterReadiness = runnerWiringContract.hostMutationAdapterReadiness;
  const hostMutationAdapterReady =
    hostMutationAdapterReadiness?.hostMutationAdapterReady === true &&
    hostMutationAdapterReadiness?.codeOwnedAdapterResolverReady === true &&
    hostMutationAdapterReadiness?.state === 'ready' &&
    hostMutationAdapterReadiness?.realHostMutationImplementationReady === false &&
    adapterDecision?.adapterReady === true &&
    adapterDecision?.state === 'resolved' &&
    adapterDecision?.codeOwnedResolverWired === true &&
    adapterDecision?.realHostMutationImplementationReady === false &&
    adapterDecision?.wouldMutateHost === false &&
    adapterDecision?.wouldExecute === false &&
    adapterDecision?.wouldRun === false &&
    adapterDecision?.wouldWrite === false &&
    adapterDecision?.launchctlAllowed === false &&
    adapterDecision?.filesystemWriteAllowed === false &&
    adapterDecision?.processListReadAllowed === false &&
    adapterDecision?.metadataWriteAllowed === false &&
    adapterDecision?.auditWriteAllowed === false &&
    adapterDecision?.rollbackAnchorWriteAllowed === false;

  // Production policy context: local primitive booleans only — never request/options objects.
  // Ignore options.registryDecision / options.runnerRegistryReady / options.registryContext.
  // Ignore options.adapterDecision / options.hostMutationAdapterReady / options.adapterContext.
  const policyContext = {
    operation: ALLOWED_OPERATIONS.has(operation) ? operation : 'invalid',
    lifecyclePlanValid: lifecyclePlanValid === true,
    approvalRecordReady: approvalRecordReady === true,
    manifestReady: manifestReady === true,
    runnerBindingsReady: runnerBindingsReady === true,
    executionPreviewVerified: executionPreviewVerified === true,
    executeRequested: executeRequested === true,
    actionCandidatesReady: actionCandidatesReady === true,
    runnerRegistryReady: runnerRegistryReady === true,
    hostMutationAdapterReady: hostMutationAdapterReady === true,
    rollbackAnchorReady: false,
    attemptAuditReady: false,
    operatorRecoveryReady: false,
  };

  const policyDecision = sanitizePolicyDecision(
    evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(policyContext),
  );

  return {
    command: 'supervisor-lifecycle-guarded-runner-execution-gate',
    operation,
    state: 'blocked',
    executionGateState: 'blocked',
    executionEligible: false,
    executorReady: false,
    wouldExecute: false,
    realRunnerWiringReady: false,
    blockers: [...new Set(blockers)],
    nextBlockers: [REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING],
    runnerWiringContract,
    actionCandidates,
    registryDecision,
    adapterDecision,
    policyDecision,
    gates: {
      lifecyclePlanValid,
      approvalRecordReady,
      manifestReady,
      runnerBindingsReady,
      executionPreviewVerified,
      executeRequested,
      actionCandidatesReady,
      executionPolicyReady,
      runnerRegistryReady: runnerRegistryReady === true,
      realRunnerWiringReady: false,
      runnerWiringContractReady: false,
      hostMutationAdapterReady: hostMutationAdapterReady === true,
      rollbackAnchorReady: false,
      attemptAuditReady: false,
      operatorRecoveryReady: false,
    },
    safety: executionPreviewSafety(),
  };
}
