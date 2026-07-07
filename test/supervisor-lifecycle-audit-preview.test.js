import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeAuditEvent } from '../src/audit-log.js';
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleAuditPreview,
  executeSupervisorLifecycleApply,
} from '../src/supervisor-lifecycle.js';

const NOW = new Date('2026-07-07T06:00:00.000Z');
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'macbook-alpha',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});

function approvalFor(plan) {
  return {
    operation: plan.operation,
    configHash: plan.configHash,
    planHash: plan.planHash,
    approved: true,
    schemaVersion: 1,
    approvedBy: 'operator@example.invalid',
    reason: 'V0.89 audit preview approval should not leak',
    acknowledgements: ['audit-preview-only'],
    approvedAt: '2026-07-07T05:30:00.000Z',
    expiresAt: '2026-07-07T06:30:00.000Z',
  };
}

function applyReadyPlan(operation = 'install') {
  const dryRunPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation, now: NOW });
  return buildSupervisorLifecycleApplyPlan(BASE_CONFIG, {
    operation,
    apply: true,
    envGateEnabled: true,
    approval: approvalFor(dryRunPlan),
    now: NOW,
  });
}

function fakeExecutor(runAction = () => ({ ok: true })) {
  return {
    kind: 'fake-supervisor-lifecycle-executor',
    calls: [],
    runAction(action, context) {
      this.calls.push({ action, context });
      return runAction(action, context);
    },
  };
}

describe('buildSupervisorLifecycleAuditPreview', () => {
  it('builds a simulated install audit preview with exact allowlisted fields', async () => {
    const plan = applyReadyPlan('install');
    const result = await executeSupervisorLifecycleApply(plan, fakeExecutor(), { mode: 'fake-test-only' });

    const preview = buildSupervisorLifecycleAuditPreview(plan, result, {
      now: NOW,
      requestId: 'req-v089.install:1',
    });

    assert.strictEqual(preview.state, 'preview');
    assert.strictEqual(preview.operation, 'install');
    assert.deepStrictEqual(Object.keys(preview.auditEvent).sort(), [
      'createdAt',
      'message',
      'outcome',
      'requestId',
      'type',
    ]);
    assert.deepStrictEqual(preview.auditEvent, {
      type: 'supervisor.lifecycle.install.simulated',
      createdAt: '2026-07-07T06:00:00.000Z',
      outcome: 'simulated',
      message: 'supervisor lifecycle install simulated; audit preview only; no host mutation',
      requestId: 'req-v089.install:1',
    });
    assert.strictEqual(preview.safety.auditEventWritten, false);
  });

  it('builds a blocked dry-run audit preview', () => {
    const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });

    const preview = buildSupervisorLifecycleAuditPreview(plan, plan, { now: NOW });

    assert.strictEqual(preview.state, 'preview');
    assert.strictEqual(preview.auditEvent.type, 'supervisor.lifecycle.install.blocked');
    assert.strictEqual(preview.auditEvent.outcome, 'blocked');
    assert.doesNotMatch(JSON.stringify(preview), /operator@example|\/Users\/ah|localhost|Documents/);
  });

  it('builds a failed rollback audit preview without executor error text', async () => {
    const plan = applyReadyPlan('rollback');
    const result = await executeSupervisorLifecycleApply(plan, fakeExecutor(() => ({
      ok: false,
      error: 'launchctl bootout /Users/ah/Library/LaunchAgents/com.linke.agent.plist token=secret',
    })), { mode: 'fake-test-only' });

    const preview = buildSupervisorLifecycleAuditPreview(plan, result, { now: NOW });
    const serialized = JSON.stringify(preview);

    assert.strictEqual(preview.auditEvent.type, 'supervisor.lifecycle.rollback.failed');
    assert.strictEqual(preview.auditEvent.outcome, 'failed');
    assert.doesNotMatch(serialized, /\blaunchctl\b|\/Users\/ah|token|secret|password/i);
  });

  it('blocks invalid plans and omits auditEvent', () => {
    const preview = buildSupervisorLifecycleAuditPreview(null, { command: 'supervisor-lifecycle-apply', state: 'blocked' }, { now: NOW });

    assert.strictEqual(preview.state, 'blocked');
    assert.ok(preview.blockers.includes('invalid-lifecycle-plan'));
    assert.strictEqual(preview.auditEvent, null);
  });

  it('blocks operation mismatches without echoing unsafe input', () => {
    const plan = applyReadyPlan('install');
    const preview = buildSupervisorLifecycleAuditPreview(plan, {
      command: 'supervisor-lifecycle-apply',
      operation: 'rollback',
      state: 'blocked',
      blockers: ['secret=/Users/ah/.ssh/id_rsa token=password'],
    }, { now: NOW });
    const serialized = JSON.stringify(preview);

    assert.strictEqual(preview.state, 'blocked');
    assert.ok(preview.blockers.includes('lifecycle-audit-operation-mismatch'));
    assert.doesNotMatch(serialized, /\/Users\/ah|\.ssh|token|secret|password/i);
  });

  it('blocks unsupported result states and never emits completed-like words', () => {
    const plan = applyReadyPlan('install');
    const preview = buildSupervisorLifecycleAuditPreview(plan, {
      command: 'supervisor-lifecycle-apply',
      operation: 'install',
      state: 'completed',
    }, { now: NOW });
    const serialized = JSON.stringify(preview);

    assert.strictEqual(preview.state, 'blocked');
    assert.ok(preview.blockers.includes('lifecycle-audit-state-not-allowed'));
    assert.strictEqual(preview.auditEvent, null);
    assert.doesNotMatch(serialized, /completed|success|ready|production/i);
  });

  it('omits unsafe requestId values and preserves safe requestId values', async () => {
    const plan = applyReadyPlan('install');
    const result = await executeSupervisorLifecycleApply(plan, fakeExecutor(), { mode: 'fake-test-only' });

    const unsafe = buildSupervisorLifecycleAuditPreview(plan, result, {
      now: NOW,
      requestId: 'req /Users/ah token=secret',
    });
    const safe = buildSupervisorLifecycleAuditPreview(plan, result, {
      now: NOW,
      requestId: 'req.safe-123:abc',
    });

    assert.strictEqual(Object.hasOwn(unsafe.auditEvent, 'requestId'), false);
    assert.strictEqual(safe.auditEvent.requestId, 'req.safe-123:abc');
    assert.doesNotMatch(JSON.stringify(unsafe), /\/Users\/ah|token|secret/i);
  });

  it('blocks tampered action ids and never echoes them', () => {
    const plan = {
      ...applyReadyPlan('install'),
      actions: [{ id: 'launchctl /Users/ah token=secret' }],
    };
    const preview = buildSupervisorLifecycleAuditPreview(plan, {
      command: 'supervisor-lifecycle-apply',
      operation: 'install',
      state: 'blocked',
    }, { now: NOW });
    const serialized = JSON.stringify(preview);

    assert.strictEqual(preview.state, 'blocked');
    assert.ok(preview.blockers.includes('lifecycle-plan-action-mismatch'));
    assert.doesNotMatch(serialized, /\blaunchctl\b|\/Users\/ah|token|secret/i);
  });

  it('survives sanitizeAuditEvent with the same preview field set', async () => {
    const plan = applyReadyPlan('uninstall');
    const result = await executeSupervisorLifecycleApply(plan, fakeExecutor(), { mode: 'fake-test-only' });
    const preview = buildSupervisorLifecycleAuditPreview(plan, result, {
      now: NOW,
      requestId: 'req-uninstall-1',
    });

    const sanitized = sanitizeAuditEvent(preview.auditEvent, NOW);

    assert.deepStrictEqual(Object.keys(sanitized).filter((key) => key !== 'id').sort(), Object.keys(preview.auditEvent).sort());
    assert.strictEqual(sanitized.type, 'supervisor.lifecycle.uninstall.simulated');
    assert.doesNotMatch(JSON.stringify(sanitized), /completed|success|ready|production/i);
  });
});
