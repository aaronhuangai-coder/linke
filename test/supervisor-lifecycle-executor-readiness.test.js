import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleApplyReadiness,
  buildSupervisorLifecycleApprovalPersistencePreview,
  buildSupervisorLifecycleExecutorReadiness,
} from '../src/supervisor-lifecycle.js';
import { buildSupervisorLifecycleApprovalRecord } from '../src/approval-store.js';

const NOW = new Date('2026-07-08T10:00:00.000Z');
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'executor-readiness-mac',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});

function validApprovalFor(plan, overrides = {}) {
  return {
    operation: plan.operation,
    configHash: plan.configHash,
    planHash: plan.planHash,
    approved: true,
    schemaVersion: 1,
    approvedBy: 'operator@example.invalid',
    reason: 'executor readiness approval reason must not leak',
    acknowledgements: ['executor readiness acknowledgement must not leak'],
    approvedAt: '2026-07-08T09:45:00.000Z',
    expiresAt: '2026-07-08T10:45:00.000Z',
    ...overrides,
  };
}

function readinessPlan(operation = 'install', overrides = {}) {
  return buildSupervisorLifecycleApplyPlan(BASE_CONFIG, {
    operation,
    apply: true,
    envGateEnabled: true,
    now: NOW,
    ...overrides,
  });
}

function persistedApprovalRecordFor(operation = 'install', overrides = {}) {
  const dryRunPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation, now: NOW });
  const approval = validApprovalFor(dryRunPlan, overrides.approval || {});
  const approvedPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, {
    operation,
    apply: true,
    envGateEnabled: true,
    approval,
    now: NOW,
  });
  const preview = buildSupervisorLifecycleApprovalPersistencePreview(approvedPlan, approval, { now: NOW });
  const record = buildSupervisorLifecycleApprovalRecord(preview, approval, {
    id: `${operation}-executor-readiness-record`,
    now: NOW,
  });

  return {
    ...record,
    ...overrides.record,
    state: overrides.record?.state || 'persisted',
    safety: {
      ...record.safety,
      approvalPersisted: true,
      filesystemWritten: true,
      ...(overrides.record?.safety || {}),
    },
  };
}

function actionBlockersFor(plan) {
  return plan.actions.map((action) => `executor-not-implemented-for-action:${action.id}`);
}

describe('buildSupervisorLifecycleExecutorReadiness', () => {
  for (const operation of ['install', 'uninstall', 'rollback']) {
    it(`returns action-driven executor blockers for ${operation} after the approval record gate is ready`, () => {
      const plan = readinessPlan(operation);
      const applyReadiness = buildSupervisorLifecycleApplyReadiness(plan, [
        persistedApprovalRecordFor(operation),
      ]);

      const result = buildSupervisorLifecycleExecutorReadiness(plan, applyReadiness);

      assert.strictEqual(applyReadiness.approvalRecordReady, true);
      assert.strictEqual(result.command, 'supervisor-lifecycle-executor-readiness');
      assert.strictEqual(result.operation, operation);
      assert.strictEqual(result.state, 'blocked');
      assert.strictEqual(result.executorState, 'blocked');
      assert.strictEqual(result.executorReady, false);
      assert.strictEqual(result.approvalRecordReady, true);
      assert.deepStrictEqual(result.blockers, actionBlockersFor(plan));
      assert.deepStrictEqual(
        result.executorBlockers.map((entry) => entry.blocker),
        actionBlockersFor(plan),
      );
      assert.deepStrictEqual(
        result.executorBlockers.map((entry) => entry.actionId),
        plan.actions.map((action) => action.id),
      );
      assert.ok(result.executorBlockers.every((entry) => (
        entry.implemented === false &&
        entry.wouldRun === false &&
        entry.wouldWrite === false
      )));
      assert.deepStrictEqual(result.nextBlockers, actionBlockersFor(plan));
      assert.strictEqual(result.gates.lifecyclePlanValid, true);
      assert.strictEqual(result.gates.applyReadinessValid, true);
      assert.strictEqual(result.gates.approvalRecordReady, true);
      assert.strictEqual(result.gates.executorImplemented, false);
      assert.strictEqual(result.safety.readOnly, true);
      assert.strictEqual(result.safety.lifecycleApplied, false);
      assert.strictEqual(result.safety.launchctlCalled, false);
      assert.strictEqual(result.safety.filesystemWritten, false);
    });
  }

  it('keeps recover blocked behind the approval gate and recovery supervisor design blocker', () => {
    const plan = readinessPlan('recover');
    const applyReadiness = buildSupervisorLifecycleApplyReadiness(plan, [
      persistedApprovalRecordFor('recover'),
    ]);

    const result = buildSupervisorLifecycleExecutorReadiness(plan, applyReadiness);

    assert.strictEqual(applyReadiness.approvalRecordReady, false);
    assert.strictEqual(result.operation, 'recover');
    assert.strictEqual(result.executorReady, false);
    assert.strictEqual(result.approvalRecordReady, false);
    assert.ok(result.blockers.includes('approval-record-gate-not-ready'));
    assert.ok(result.blockers.includes('recovery-supervisor-design-missing'));
    assert.ok(result.blockers.includes('executor-not-implemented-for-action:start-recovery-supervisor'));
    assert.deepStrictEqual(result.executorBlockers.map((entry) => entry.actionId), ['start-recovery-supervisor']);
    assert.strictEqual(result.safety.lifecycleApplied, false);
  });

  it('fails closed when no approval record satisfies the approval gate', () => {
    const plan = readinessPlan('install');
    const applyReadiness = buildSupervisorLifecycleApplyReadiness(plan, []);

    const result = buildSupervisorLifecycleExecutorReadiness(plan, applyReadiness);

    assert.strictEqual(applyReadiness.approvalRecordReady, false);
    assert.strictEqual(result.approvalRecordReady, false);
    assert.ok(result.blockers.includes('approval-record-gate-not-ready'));
    assert.ok(result.blockers.includes('approval-record-missing'));
    assert.deepStrictEqual(result.executorBlockers.map((entry) => entry.blocker), actionBlockersFor(plan));
  });

  it('fails closed for invalid lifecycle plans and invalid apply readiness without leaking unsafe input', () => {
    const invalidPlan = {
      command: 'supervisor-lifecycle-apply',
      operation: 'install',
      actions: [{ id: 'launchctl /Users/ah/Library/LaunchAgents/com.linke.agent.plist token=secret' }],
      blockers: ['executor-implementation-missing'],
    };
    const invalidApplyReadiness = {
      command: 'wrong',
      operation: 'install',
      approvalRecordReady: true,
      blockers: ['secret=/Users/ah/.ssh/id_rsa token=password'],
    };

    const result = buildSupervisorLifecycleExecutorReadiness(invalidPlan, invalidApplyReadiness);
    const serialized = JSON.stringify(result);

    assert.strictEqual(result.state, 'blocked');
    assert.ok(result.blockers.includes('lifecycle-plan-action-mismatch'));
    assert.ok(result.blockers.includes('apply-readiness-invalid'));
    assert.deepStrictEqual(result.executorBlockers, []);
    assert.doesNotMatch(serialized, /\/Users\/ah|\.ssh|\blaunchctl\b|token|secret|password/i);
  });

  it('does not leak approval metadata, hashes, URLs, paths, or secret-like values', () => {
    const plan = readinessPlan('rollback');
    const applyReadiness = buildSupervisorLifecycleApplyReadiness(plan, [
      persistedApprovalRecordFor('rollback'),
    ]);

    const result = buildSupervisorLifecycleExecutorReadiness(plan, applyReadiness);
    const serialized = JSON.stringify(result);

    assert.doesNotMatch(serialized, /operator@example|executor readiness approval|executor readiness acknowledgement/i);
    assert.doesNotMatch(serialized, /sha256:|localhost|Documents|\/Users\/ah|token|secret|password|Authorization/i);
    assert.strictEqual(result.safety.sensitiveValuesReturned, false);
  });
});
