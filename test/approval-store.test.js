import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendSupervisorLifecycleApprovalRecord,
  buildSupervisorLifecycleApprovalRecord,
  readSupervisorLifecycleApprovalRecords,
} from '../src/approval-store.js';
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleApprovalPersistencePreview,
} from '../src/supervisor-lifecycle.js';

const NOW = new Date('2026-07-07T08:00:00.000Z');
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'approval-store-mac',
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
    reason: 'V0.93 local approval store should not leak this reason',
    acknowledgements: ['operator accepts local approval persistence'],
    approvedAt: '2026-07-07T07:30:00.000Z',
    expiresAt: '2026-07-07T08:30:00.000Z',
    ...overrides,
  };
}

function validPreview(operation = 'install') {
  const dryRunPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation, now: NOW });
  const approval = validApprovalFor(dryRunPlan);
  const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, {
    operation,
    apply: true,
    envGateEnabled: true,
    approval,
    now: NOW,
  });
  return {
    approval,
    preview: buildSupervisorLifecycleApprovalPersistencePreview(plan, approval, { now: NOW }),
  };
}

describe('supervisor lifecycle approval store', () => {
  it('builds a sanitized record from a valid approval preview', () => {
    const { approval, preview } = validPreview('install');

    const record = buildSupervisorLifecycleApprovalRecord(preview, approval, {
      id: 'approval-record-test-id',
      now: NOW,
    });
    const text = JSON.stringify(record);

    assert.strictEqual(record.command, 'supervisor-lifecycle-approval-record');
    assert.strictEqual(record.schemaVersion, 1);
    assert.strictEqual(record.id, 'approval-record-test-id');
    assert.strictEqual(record.createdAt, NOW.toISOString());
    assert.strictEqual(record.operation, 'install');
    assert.strictEqual(record.state, 'persistable');
    assert.strictEqual(record.approvalValid, true);
    assert.deepStrictEqual(record.blockersResolved, ['approval-persistence-store-missing']);
    assert.deepStrictEqual(record.validation, {
      approvalValid: true,
      acknowledgementCount: 1,
      windowWithinLimit: true,
      operationMatchesPlan: true,
      configHashMatchesPlan: true,
      planHashMatchesPlan: true,
    });
    assert.deepStrictEqual(record.safety, {
      approvalPersisted: false,
      filesystemWritten: false,
      hostMutation: false,
      launchctlCalled: false,
      lifecycleApplied: false,
      sensitiveValuesReturned: false,
    });
    assert.doesNotMatch(text, /operator@example|local approval store|operator accepts/i);
    assert.doesNotMatch(text, /2026-07-07T07:30:00|2026-07-07T08:30:00|sha256:|localhost|Documents|\/Users\/ah|token|secret/i);
  });

  it('appends and reads sanitized approval records from local JSONL storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-approval-store-'));
    try {
      const { approval, preview } = validPreview('rollback');

      const written = await appendSupervisorLifecycleApprovalRecord(dir, preview, approval, {
        id: 'approval-record-persisted-id',
        now: NOW,
      });
      const records = await readSupervisorLifecycleApprovalRecords(dir);
      const raw = await readFile(join(dir, 'approvals', 'supervisor-lifecycle-approvals.jsonl'), 'utf-8');

      assert.strictEqual(written.state, 'persisted');
      assert.strictEqual(written.createdAt, NOW.toISOString());
      assert.strictEqual(written.safety.approvalPersisted, true);
      assert.strictEqual(written.safety.filesystemWritten, true);
      assert.strictEqual(written.safety.hostMutation, false);
      assert.strictEqual(written.safety.launchctlCalled, false);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0], written);
      assert.doesNotMatch(raw, /operator@example|local approval store|operator accepts/i);
      assert.doesNotMatch(raw, /2026-07-07T07:30:00|2026-07-07T08:30:00|sha256:|localhost|Documents|\/Users\/ah|token|secret/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid previews and leaves storage empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-approval-store-'));
    try {
      const dryRunPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });
      const preview = buildSupervisorLifecycleApprovalPersistencePreview(dryRunPlan, undefined, { now: NOW });

      await assert.rejects(
        () => appendSupervisorLifecycleApprovalRecord(dir, preview, undefined, { now: NOW }),
        /approval preview is not persistable/,
      );
      assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
