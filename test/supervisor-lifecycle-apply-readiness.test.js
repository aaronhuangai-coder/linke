import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleApplyReadiness,
  buildSupervisorLifecycleApprovalPersistencePreview,
} from '../src/supervisor-lifecycle.js';
import { buildSupervisorLifecycleApprovalRecord } from '../src/approval-store.js';

const NOW = new Date('2026-07-08T08:00:00.000Z');
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'apply-readiness-mac',
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
    reason: 'readiness approval reason must not leak',
    acknowledgements: ['readiness acknowledgement must not leak'],
    approvedAt: '2026-07-08T07:45:00.000Z',
    expiresAt: '2026-07-08T08:45:00.000Z',
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
    id: `${operation}-approval-record`,
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

describe('buildSupervisorLifecycleApplyReadiness', () => {
  it('fails closed when no persisted approval record exists', () => {
    const result = buildSupervisorLifecycleApplyReadiness(readinessPlan('install'), []);

    assert.strictEqual(result.command, 'supervisor-lifecycle-apply-readiness');
    assert.strictEqual(result.operation, 'install');
    assert.strictEqual(result.state, 'blocked');
    assert.strictEqual(result.approvalRecordState, 'blocked');
    assert.strictEqual(result.approvalRecordReady, false);
    assert.deepStrictEqual(result.blockers, ['approval-record-missing']);
    assert.deepStrictEqual(result.nextBlockers, ['executor-implementation-missing']);
    assert.deepStrictEqual(result.approvalRecords, {
      readOnly: true,
      count: 0,
      operationMatchCount: 0,
      persistedMatchCount: 0,
    });
    assert.deepStrictEqual(result.gates, {
      lifecyclePlanValid: true,
      applyFlag: true,
      envGate: true,
      approvalRecordPersisted: false,
      approvalRecordValid: false,
      approvalRecordOperationMatched: false,
      executorImplemented: false,
    });
    assert.strictEqual(result.safety.readOnly, true);
    assert.strictEqual(result.safety.lifecycleApplied, false);
    assert.strictEqual(result.safety.launchctlCalled, false);
    assert.strictEqual(result.safety.hostMutation, false);
    assert.strictEqual(result.safety.filesystemWritten, false);
    assert.strictEqual(result.safety.sensitiveValuesReturned, false);
  });

  it('marks only the approval record gate ready for a matching persisted sanitized record', () => {
    const result = buildSupervisorLifecycleApplyReadiness(readinessPlan('rollback'), [
      persistedApprovalRecordFor('rollback'),
    ]);

    assert.strictEqual(result.state, 'blocked');
    assert.strictEqual(result.approvalRecordState, 'ready');
    assert.strictEqual(result.approvalRecordReady, true);
    assert.deepStrictEqual(result.blockers, []);
    assert.deepStrictEqual(result.nextBlockers, ['executor-implementation-missing']);
    assert.deepStrictEqual(result.approvalRecords, {
      readOnly: true,
      count: 1,
      operationMatchCount: 1,
      persistedMatchCount: 1,
    });
    assert.strictEqual(result.gates.approvalRecordPersisted, true);
    assert.strictEqual(result.gates.approvalRecordValid, true);
    assert.strictEqual(result.gates.approvalRecordOperationMatched, true);
    assert.strictEqual(result.gates.executorImplemented, false);
    assert.strictEqual(result.safety.dryRun, true);
    assert.strictEqual(result.safety.lifecycleApplied, false);
    assert.strictEqual(result.safety.launchctlCalled, false);
  });

  it('blocks records for the wrong operation without echoing approval material', () => {
    const result = buildSupervisorLifecycleApplyReadiness(readinessPlan('install'), [
      persistedApprovalRecordFor('rollback'),
    ]);
    const serialized = JSON.stringify(result);

    assert.strictEqual(result.state, 'blocked');
    assert.strictEqual(result.approvalRecordReady, false);
    assert.deepStrictEqual(result.blockers, ['approval-record-operation-mismatch']);
    assert.strictEqual(result.approvalRecords.count, 1);
    assert.strictEqual(result.approvalRecords.operationMatchCount, 0);
    assert.doesNotMatch(serialized, /operator@example|readiness approval|readiness acknowledgement|sha256:|localhost|Documents|\/Users\/ah|token|secret/i);
  });

  it('blocks matching records with incomplete validation or non-persisted state', () => {
    const invalidValidation = persistedApprovalRecordFor('install', {
      record: {
        validation: {
          approvalValid: true,
          acknowledgementCount: 1,
          windowWithinLimit: true,
          operationMatchesPlan: true,
          configHashMatchesPlan: false,
          planHashMatchesPlan: true,
        },
      },
    });
    const notPersisted = persistedApprovalRecordFor('install', {
      record: { state: 'persistable' },
    });

    const invalidResult = buildSupervisorLifecycleApplyReadiness(readinessPlan('install'), [invalidValidation]);
    const notPersistedResult = buildSupervisorLifecycleApplyReadiness(readinessPlan('install'), [notPersisted]);

    assert.deepStrictEqual(invalidResult.blockers, ['approval-record-validation-incomplete']);
    assert.strictEqual(invalidResult.gates.approvalRecordValid, false);
    assert.deepStrictEqual(notPersistedResult.blockers, ['approval-record-not-persisted']);
    assert.strictEqual(notPersistedResult.gates.approvalRecordPersisted, false);
  });

  it('blocks tampered safety flags and invalid lifecycle plans', () => {
    const tamperedSafety = persistedApprovalRecordFor('install', {
      record: {
        safety: {
          hostMutation: true,
          launchctlCalled: true,
          lifecycleApplied: true,
        },
      },
    });
    const tamperedResult = buildSupervisorLifecycleApplyReadiness(readinessPlan('install'), [tamperedSafety]);
    const dryRunResult = buildSupervisorLifecycleApplyReadiness(
      buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW }),
      [persistedApprovalRecordFor('install')],
    );

    assert.deepStrictEqual(tamperedResult.blockers, ['approval-record-safety-invalid']);
    assert.strictEqual(tamperedResult.safety.lifecycleApplied, false);
    assert.ok(dryRunResult.blockers.includes('apply-flag-required'));
    assert.strictEqual(dryRunResult.gates.applyFlag, false);
  });
});
