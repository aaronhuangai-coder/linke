import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';

const APPROVAL_MAX_WINDOW_MS = 60 * 60 * 1000;
const ALLOWED_OPERATIONS = new Set(['install', 'uninstall', 'rollback', 'recover']);
const EXECUTOR_MISSING_BLOCKER = 'executor-implementation-missing';
const FAKE_EXECUTOR_KIND = 'fake-supervisor-lifecycle-executor';
const FAKE_EXECUTOR_MODE = 'fake-test-only';
const MAX_FAKE_ATTEMPTS = 2;
const SAFE_PLAN_BLOCKERS = new Set([
  EXECUTOR_MISSING_BLOCKER,
  'apply-flag-required',
  'env-gate-disabled',
  'recovery-supervisor-design-missing',
  'approval-missing',
  'approval-missing-required-fields',
  'approval-not-granted',
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
  if (expiresAt - approvedAt > APPROVAL_MAX_WINDOW_MS) {
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
