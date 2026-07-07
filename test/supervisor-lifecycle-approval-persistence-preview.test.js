import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleApprovalPersistencePreview,
} from '../src/supervisor-lifecycle.js';

const NOW = new Date('2026-07-07T07:00:00.000Z');
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'macbook-alpha',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});
const EXPECTED_SAFETY_KEYS = [
  'approvalPersisted',
  'auditEventWritten',
  'dryRun',
  'filesystemWritten',
  'hostMutation',
  'launchctlCalled',
  'metadataWritten',
  'rollbackAnchorWritten',
  'sensitiveValuesReturned',
];

function validApprovalFor(plan, overrides = {}) {
  return {
    operation: plan.operation,
    configHash: plan.configHash,
    planHash: plan.planHash,
    approved: true,
    schemaVersion: 1,
    approvedBy: 'operator@example.invalid',
    reason: 'V0.90 persistence preview approval should not leak',
    acknowledgements: ['operator accepts dry-run persistence preview only'],
    approvedAt: '2026-07-07T06:30:00.000Z',
    expiresAt: '2026-07-07T07:30:00.000Z',
    ...overrides,
  };
}

function applyReadyPlan(operation = 'install') {
  const dryRunPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation, now: NOW });
  return buildSupervisorLifecycleApplyPlan(BASE_CONFIG, {
    operation,
    apply: true,
    envGateEnabled: true,
    approval: validApprovalFor(dryRunPlan),
    now: NOW,
  });
}

describe('buildSupervisorLifecycleApprovalPersistencePreview', () => {
  it('keeps a valid approval blocked because no persistence store exists', () => {
    const plan = applyReadyPlan('install');
    const approval = validApprovalFor(plan);

    const preview = buildSupervisorLifecycleApprovalPersistencePreview(plan, approval, { now: NOW });

    assert.strictEqual(preview.command, 'supervisor-lifecycle-approval-persistence-preview');
    assert.strictEqual(preview.operation, 'install');
    assert.strictEqual(preview.state, 'blocked');
    assert.strictEqual(preview.approvalValid, true);
    assert.deepStrictEqual(preview.blockers, ['approval-persistence-store-missing']);
    assert.strictEqual(preview.persistence.previewOnly, true);
    assert.strictEqual(preview.persistence.wouldPersist, false);
    assert.strictEqual(preview.persistence.recordSchemaVersion, 1);
    assert.deepStrictEqual(preview.persistence.requiredRecordFields, [
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
    assert.deepStrictEqual(preview.persistence.validation, {
      approvalValid: true,
      acknowledgementCount: 1,
      windowWithinLimit: true,
      operationMatchesPlan: true,
      configHashMatchesPlan: true,
      planHashMatchesPlan: true,
    });
    assert.strictEqual(preview.safety.approvalPersisted, false);
  });

  it('blocks invalid and wrong-command plans before approval validation', () => {
    const validPlan = applyReadyPlan('install');
    const approval = validApprovalFor(validPlan);
    const nullPlan = buildSupervisorLifecycleApprovalPersistencePreview(null, approval, { now: NOW });
    const wrongCommand = buildSupervisorLifecycleApprovalPersistencePreview({
      ...validPlan,
      command: 'wrong-command',
    }, approval, { now: NOW });

    assert.ok(nullPlan.blockers.includes('invalid-lifecycle-plan'));
    assert.strictEqual(nullPlan.approvalValid, false);
    assert.strictEqual(nullPlan.persistence.validation.approvalValid, false);
    assert.ok(wrongCommand.blockers.includes('invalid-lifecycle-plan'));
    assert.strictEqual(wrongCommand.approvalValid, false);
  });

  it('blocks missing approval with safe blocker codes only', () => {
    const plan = applyReadyPlan('install');

    const preview = buildSupervisorLifecycleApprovalPersistencePreview(plan, undefined, { now: NOW });

    assert.strictEqual(preview.approvalValid, false);
    assert.ok(preview.blockers.includes('approval-missing-required-fields'));
    assert.ok(preview.blockers.includes('approval-persistence-store-missing'));
    assert.strictEqual(preview.persistence.validation.approvalValid, false);
    assert.strictEqual(preview.persistence.validation.acknowledgementCount, 0);
    assert.strictEqual(preview.persistence.wouldPersist, false);
  });

  it('reports approval validation blockers with safe codes only', () => {
    const plan = applyReadyPlan('install');
    const expired = buildSupervisorLifecycleApprovalPersistencePreview(plan, validApprovalFor(plan, {
      approvedAt: '2026-07-07T05:00:00.000Z',
      expiresAt: '2026-07-07T06:00:00.000Z',
    }), { now: NOW });
    const mismatch = buildSupervisorLifecycleApprovalPersistencePreview(plan, validApprovalFor(plan, {
      operation: 'rollback',
      configHash: 'sha256:wrong-config-secret',
      planHash: 'sha256:wrong-plan-secret',
    }), { now: NOW });

    assert.ok(expired.blockers.includes('approval-expired'));
    assert.strictEqual(expired.persistence.validation.windowWithinLimit, true);
    assert.ok(mismatch.blockers.includes('approval-operation-mismatch'));
    assert.ok(mismatch.blockers.includes('approval-config-hash-mismatch'));
    assert.ok(mismatch.blockers.includes('approval-plan-hash-mismatch'));
    assert.strictEqual(mismatch.persistence.validation.operationMatchesPlan, false);
    assert.strictEqual(mismatch.persistence.validation.configHashMatchesPlan, false);
    assert.strictEqual(mismatch.persistence.validation.planHashMatchesPlan, false);
    assert.doesNotMatch(JSON.stringify(mismatch), /wrong-config-secret|wrong-plan-secret/);
  });

  it('rejects approval not granted and over-wide approval windows', () => {
    const plan = applyReadyPlan('install');
    const rejected = buildSupervisorLifecycleApprovalPersistencePreview(plan, validApprovalFor(plan, {
      approved: false,
    }), { now: NOW });
    const wide = buildSupervisorLifecycleApprovalPersistencePreview(plan, validApprovalFor(plan, {
      approvedAt: '2026-07-07T05:00:00.000Z',
      expiresAt: '2026-07-07T07:01:00.000Z',
    }), { now: NOW });

    assert.ok(rejected.blockers.includes('approval-not-granted'));
    assert.ok(wide.blockers.includes('approval-window-too-wide'));
    assert.strictEqual(wide.persistence.validation.windowWithinLimit, false);
  });

  it('rejects inverted approval windows as invalid', () => {
    const plan = applyReadyPlan('install');

    const inverted = buildSupervisorLifecycleApprovalPersistencePreview(plan, validApprovalFor(plan, {
      approvedAt: '2026-07-07T07:30:00.000Z',
      expiresAt: '2026-07-07T07:15:00.000Z',
    }), { now: NOW });

    assert.ok(inverted.blockers.includes('approval-window-invalid'));
    assert.strictEqual(inverted.persistence.validation.windowWithinLimit, false);
  });

  it('does not leak approval metadata in serialized or round-tripped output', () => {
    const plan = applyReadyPlan('install');
    const approval = validApprovalFor(plan, {
      ignoredUnknownField: 'token=secret /Users/ah/.ssh/id_rsa',
    });

    const preview = buildSupervisorLifecycleApprovalPersistencePreview(plan, approval, { now: NOW });
    const serialized = JSON.stringify(preview);
    const roundTrip = JSON.parse(serialized);

    assert.doesNotMatch(serialized, /operator@example|persistence preview approval|operator accepts|2026-07-07T06:30|2026-07-07T07:30|sha256:|localhost|Documents|token|secret|\.ssh|\/Users\/ah/i);
    assert.doesNotMatch(JSON.stringify(roundTrip), /operator@example|operator accepts|token|secret|\.ssh|\/Users\/ah/i);
  });

  it('blocks tampered action ids without echoing them and keeps inputs immutable', () => {
    const plan = applyReadyPlan('rollback');
    const approval = validApprovalFor(plan);
    const tamperedPlan = Object.freeze({
      ...plan,
      actions: Object.freeze([{ id: 'launchctl /Users/ah token=secret' }]),
    });
    const frozenApproval = Object.freeze({ ...approval });

    const preview = buildSupervisorLifecycleApprovalPersistencePreview(tamperedPlan, frozenApproval, { now: NOW });

    assert.ok(preview.blockers.includes('lifecycle-plan-action-mismatch'));
    assert.strictEqual(preview.approvalValid, false);
    assert.doesNotMatch(JSON.stringify(preview), /\blaunchctl\b|\/Users\/ah|token|secret/i);
    assert.strictEqual(frozenApproval.reason, approval.reason);
  });

  it('returns exact safety keys with approvalPersisted false', () => {
    const plan = applyReadyPlan('install');
    const preview = buildSupervisorLifecycleApprovalPersistencePreview(plan, validApprovalFor(plan), { now: NOW });

    assert.deepStrictEqual(Object.keys(preview.safety).sort(), EXPECTED_SAFETY_KEYS);
    assert.strictEqual(preview.safety.dryRun, true);
    assert.strictEqual(preview.safety.hostMutation, false);
    assert.strictEqual(preview.safety.launchctlCalled, false);
    assert.strictEqual(preview.safety.filesystemWritten, false);
    assert.strictEqual(preview.safety.metadataWritten, false);
    assert.strictEqual(preview.safety.rollbackAnchorWritten, false);
    assert.strictEqual(preview.safety.auditEventWritten, false);
    assert.strictEqual(preview.safety.approvalPersisted, false);
    assert.strictEqual(preview.safety.sensitiveValuesReturned, false);
  });
});
