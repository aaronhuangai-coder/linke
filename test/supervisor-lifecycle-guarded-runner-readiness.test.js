import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleGuardedRunnerReadiness,
  validateSupervisorLifecycleExecutorManifest,
} from '../src/supervisor-lifecycle.js';

const NOW = new Date('2026-07-08T12:00:00.000Z');
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'macbook-alpha',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});

function getValidManifestReadiness() {
  const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });
  return validateSupervisorLifecycleExecutorManifest(plan, {
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
  });
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

describe('buildSupervisorLifecycleGuardedRunnerReadiness', () => {
  it('marks complete guarded runner binding metadata ready while execution remains disabled', () => {
    const result = buildSupervisorLifecycleGuardedRunnerReadiness(
      getValidManifestReadiness(),
      getValidRunnerBinding(),
    );

    assert.strictEqual(result.command, 'supervisor-lifecycle-guarded-runner-readiness');
    assert.strictEqual(result.operation, 'install');
    assert.strictEqual(result.state, 'blocked');
    assert.strictEqual(result.runnerBindingState, 'ready');
    assert.strictEqual(result.runnerBindingsReady, true);
    assert.strictEqual(result.executorReady, false);
    assert.deepStrictEqual(result.runnerBlockers, []);
    assert.deepStrictEqual(result.blockers, ['guarded-runner-execution-disabled']);
    assert.deepStrictEqual(result.nextBlockers, ['guarded-runner-execution-disabled']);
    assert.strictEqual(result.gates.manifestReady, true);
    assert.strictEqual(result.gates.runnerBindingsReady, true);
    assert.strictEqual(result.gates.executorImplemented, false);
    assert.ok(result.runnerBindings.every((entry) => entry.wouldRun === false && entry.wouldWrite === false));
    assert.strictEqual(result.safety.readOnly, true);
    assert.strictEqual(result.safety.lifecycleApplied, false);
    assert.strictEqual(result.safety.launchctlCalled, false);
    assert.strictEqual(result.safety.filesystemWritten, false);
  });

  it('fails closed when a manifest action lacks an exact binding match', () => {
    const runnerBinding = getValidRunnerBinding();
    runnerBinding.bindings = runnerBinding.bindings.filter((entry) => entry.actionId !== 'load-launch-agent');

    const result = buildSupervisorLifecycleGuardedRunnerReadiness(getValidManifestReadiness(), runnerBinding);

    assert.strictEqual(result.runnerBindingsReady, false);
    assert.strictEqual(result.runnerBindingState, 'blocked');
    assert.ok(result.runnerBlockers.includes('guarded-runner-binding-missing-for-action:load-launch-agent'));
    assert.ok(result.blockers.includes('guarded-runner-execution-disabled'));
    assert.doesNotMatch(JSON.stringify(result), /\/Users\/ah|localhost|Documents/);
  });

  it('rejects invalid binding kind, schema, and bindings shape with stable blockers', () => {
    const result = buildSupervisorLifecycleGuardedRunnerReadiness(getValidManifestReadiness(), {
      kind: 'bad-kind',
      schemaVersion: 2,
      bindings: 'not-an-array',
    });

    assert.strictEqual(result.runnerBindingsReady, false);
    assert.ok(result.runnerBlockers.includes('guarded-runner-binding-invalid-kind'));
    assert.ok(result.runnerBlockers.includes('guarded-runner-binding-invalid-schema'));
    assert.ok(result.runnerBlockers.includes('guarded-runner-binding-invalid-bindings'));
    assert.deepStrictEqual(result.runnerBindings, []);
  });

  it('rejects forbidden, missing, and invalid binding fields', () => {
    const runnerBinding = getValidRunnerBinding();
    runnerBinding.bindings = [
      {
        actionId: 'render-launch-agent-plist',
        implementationId: 'render-plist-impl',
        mode: 'guarded-host-action',
        runnerKind: 'guarded-runner-stub',
        requiresApprovalRecord: true,
        maxAttempts: 2,
        command: 'launchctl load something',
      },
      {
        actionId: 'write-launch-agent-plist',
        implementationId: 'write-plist-impl',
        mode: 'guarded-host-action',
        runnerKind: 'guarded-runner-stub',
        requiresApprovalRecord: true,
      },
      {
        actionId: 'load-launch-agent',
        implementationId: 'load-agent-impl',
        mode: 'direct-host-action',
        runnerKind: 'real-runner',
        requiresApprovalRecord: false,
        maxAttempts: 4,
      },
    ];

    const result = buildSupervisorLifecycleGuardedRunnerReadiness(getValidManifestReadiness(), runnerBinding);

    assert.strictEqual(result.runnerBindingsReady, false);
    assert.ok(result.runnerBlockers.includes('guarded-runner-binding-unsafe-for-action:render-launch-agent-plist:forbidden-field'));
    assert.ok(result.runnerBlockers.includes('guarded-runner-binding-unsafe-for-action:write-launch-agent-plist:missing-field'));
    assert.ok(result.runnerBlockers.includes('guarded-runner-binding-unsafe-for-action:load-launch-agent:invalid-field'));
    assert.ok(result.runnerBlockers.includes('secret-reference'));
  });

  it('redacts unresolved placeholders and command-like binding values', () => {
    const runnerBinding = getValidRunnerBinding();
    runnerBinding.bindings[0] = {
      actionId: 'render-launch-agent-plist',
      implementationId: 'render-{{env}}-impl',
      mode: 'guarded-host-action',
      runnerKind: '/usr/bin/unsafe-runner token=secret-token',
      requiresApprovalRecord: true,
      maxAttempts: 2,
    };

    const result = buildSupervisorLifecycleGuardedRunnerReadiness(getValidManifestReadiness(), runnerBinding);
    const serialized = JSON.stringify(result);

    assert.strictEqual(result.runnerBindingsReady, false);
    assert.ok(result.runnerBlockers.includes('unresolved-placeholder'));
    assert.ok(result.runnerBlockers.includes('secret-reference'));
    assert.doesNotMatch(serialized, /\{\{env\}\}|\/usr\/bin|unsafe-runner|secret-token|token=/);
    assert.ok(serialized.includes('[redacted]'));
  });

  it('fails closed for invalid or not-ready manifest readiness input', () => {
    const invalidResult = buildSupervisorLifecycleGuardedRunnerReadiness(
      { command: 'not-manifest-readiness' },
      getValidRunnerBinding(),
    );
    assert.ok(invalidResult.runnerBlockers.includes('invalid-executor-manifest-readiness'));
    assert.strictEqual(invalidResult.runnerBindingsReady, false);
    assert.strictEqual(invalidResult.executorReady, false);

    const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });
    const notReadyManifest = validateSupervisorLifecycleExecutorManifest(plan, undefined);
    const notReadyResult = buildSupervisorLifecycleGuardedRunnerReadiness(
      notReadyManifest,
      getValidRunnerBinding(),
    );
    assert.ok(notReadyResult.runnerBlockers.includes('executor-manifest-not-ready'));
    assert.strictEqual(notReadyResult.runnerBindingsReady, false);
    assert.ok(notReadyResult.blockers.includes('guarded-runner-execution-disabled'));
  });
});
