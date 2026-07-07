# Supervisor Lifecycle Approval Persistence Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add V0.90 sanitized approval persistence preview for supervisor lifecycle apply without persisting approval data.

**Architecture:** Extend `src/supervisor-lifecycle.js` with a pure `buildSupervisorLifecycleApprovalPersistencePreview(plan, approval, options)` function. The function validates a lifecycle plan and approval object, returns only safe booleans/counts/static field names, and keeps `state:"blocked"` because no persistence store exists.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, existing lifecycle approval validation helpers.

**Implementation Routing Note:** AGY implementer dispatch for V0.90 exited with no stdout and no target artifact, so it was treated as `EXITED_NO_OUTPUT` and not used as implementation evidence. Codex PM fallback applied the scoped implementation and must verify it with local tests, safety scans, Qwen review, and DeepSeek closure before the commit gate.

## Global Constraints

- No approval file write.
- No `fs`, database, keychain, network, `launchctl`, process spawn, metadata write, rollback anchor write, audit write, NAS command, backup, restore, or remote command.
- `lifecycleSafety()` must include `approvalPersisted:false` and all existing non-mutating safety fields.
- Plan structural validation must run before approval validation.
- `approvalValid` must be `false` when the plan is invalid.
- Inverted or zero-length approval windows must return `approval-window-invalid`.
- Never return approval values: `approvedBy`, `reason`, acknowledgement content, `approvedAt`, `expiresAt`, `configHash`, `planHash`, paths, URLs, commands, tokens, hostnames, usernames, PIDs, or unknown raw blocker strings.
- Even a valid approval remains `state:"blocked"` with `approval-persistence-store-missing`.
- CLI `supervisor-lifecycle-apply --apply` remains blocked and returns no persistence preview.
- GET/POST `/api/supervisor-lifecycle-apply` remain 404.
- Gold remains blocked.

---

## File Structure

- Modify `src/supervisor-lifecycle.js`: add approval persistence preview export, extend safety.
- Create `test/supervisor-lifecycle-approval-persistence-preview.test.js`: preview contract tests.
- Modify `test/supervisor-lifecycle.test.js`, `test/supervisor-lifecycle-executor.test.js`, `test/supervisor-lifecycle-audit-preview.test.js`: align exact safety key expectations with `approvalPersisted:false`.
- Modify `test/agent-supervisor-lifecycle-apply.test.js`: assert CLI has no approval persistence preview.
- Modify `src/version.js`, `README.md`, `src/gold-readiness.js`, `test/version.test.js`, `test/readme.test.js`, `test/gold-readiness.test.js`: V0.90 docs and evidence.

## Task 1: RED Tests For Approval Persistence Preview

**Files:**
- Create: `test/supervisor-lifecycle-approval-persistence-preview.test.js`

**Interfaces:**
- Consumes: `buildSupervisorLifecycleApplyPlan(config, options)`
- Produces expected future export: `buildSupervisorLifecycleApprovalPersistencePreview(plan, approval, options)`

- [x] **Step 1: Write failing tests**

Create tests covering:

```js
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
    assert.strictEqual(preview.persistence.validation.acknowledgementCount, 1);
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
    assert.ok(wrongCommand.blockers.includes('invalid-lifecycle-plan'));
    assert.strictEqual(wrongCommand.approvalValid, false);
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
    assert.ok(mismatch.blockers.includes('approval-operation-mismatch'));
    assert.ok(mismatch.blockers.includes('approval-config-hash-mismatch'));
    assert.ok(mismatch.blockers.includes('approval-plan-hash-mismatch'));
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

    assert.deepStrictEqual(Object.keys(preview.safety).sort(), [
      'approvalPersisted',
      'auditEventWritten',
      'dryRun',
      'filesystemWritten',
      'hostMutation',
      'launchctlCalled',
      'metadataWritten',
      'rollbackAnchorWritten',
      'sensitiveValuesReturned',
    ]);
    assert.ok(Object.values(preview.safety).every((value) => value === false || value === true));
    assert.strictEqual(preview.safety.dryRun, true);
    assert.strictEqual(preview.safety.approvalPersisted, false);
  });
});
```

- [x] **Step 2: Run RED**

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle-approval-persistence-preview.test.js
```

Expected: fail because the export does not exist.

## Task 2: Implement Pure Preview

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: existing lifecycle safety tests as needed.

- [x] **Step 1: Extend shared safety**

Add `approvalPersisted:false` to `lifecycleSafety()`.

- [x] **Step 2: Add preview constants and helpers**

Add:

```js
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
```

Create a validation summary helper that computes booleans/counts without returning approval values.

- [x] **Step 3: Export function**

Implement `buildSupervisorLifecycleApprovalPersistencePreview(plan, approval, options = {})`:

- validate plan command, operation, actions first
- if plan invalid, return blocked with `approvalValid:false`
- otherwise call `validateSupervisorLifecycleApproval`
- return only safe blockers
- always append `approval-persistence-store-missing`
- return static required field names, booleans, counts, and safety

- [x] **Step 4: Run targeted GREEN**

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle-approval-persistence-preview.test.js test/supervisor-lifecycle.test.js test/supervisor-lifecycle-executor.test.js test/supervisor-lifecycle-audit-preview.test.js
```

Expected: pass.

## Task 3: Runtime Isolation Regression

**Files:**
- Modify: `test/agent-supervisor-lifecycle-apply.test.js`

- [x] **Step 1: Add CLI no-preview assertion**

In the valid approval CLI test, add:

```js
assert.strictEqual(report.approvalPersistencePreview, undefined);
assert.doesNotMatch(error.stdout, /approvalPersistencePreview|approval-persistence/i);
```

- [x] **Step 2: Run runtime isolation**

Run:

```bash
node --test --test-reporter=dot test/agent-supervisor-lifecycle-apply.test.js test/server.test.js
```

Expected: pass.

## Task 4: Version, README, Gold Evidence

**Files:**
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`

- [x] **Step 1: Update version**

Set `LINKE_RELEASE_VERSION` to `V0.90`.

- [x] **Step 2: Update README**

Add current version row:

```markdown
| V0.90 | 当前版本 | supervisor lifecycle approval persistence preview：新增 `buildSupervisorLifecycleApprovalPersistencePreview(plan, approval, options)` sanitized 批准持久化预览契约，只返回 approval validation booleans、acknowledgement count 与静态 requiredRecordFields；不返回 approvedBy、reason、acknowledgements 内容、timestamps、configHash 或 planHash 值；不写 approval 文件、不调用 fs/db/keychain/network，真实 `--apply` 继续 blocked，Gold 依旧 blocked |
```

- [x] **Step 3: Update Gold readiness evidence**

Add evidence:

```js
'buildSupervisorLifecycleApprovalPersistencePreview',
'test/supervisor-lifecycle-approval-persistence-preview.test.js',
```

Keep statuses partial/blocked.

- [x] **Step 4: Run docs tests**

Run:

```bash
node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

Expected: pass.

## Task 5: PM Verification

- [x] **Step 1: Full suite**

Run:

```bash
node --test --test-reporter=dot test/*.test.js
```

- [x] **Step 2: Whitespace check**

Run:

```bash
git diff --check
```

- [x] **Step 3: Safety scan**

Run:

```bash
rg -n "Gold ready|production ready|production-ready|approvalPersisted:true|filesystemWritten:true|metadataWritten:true|auditEventWritten:true|hostMutation:true|appendAuditEvent\\(|events\\.jsonl|writeFile\\(|appendFile\\(|keychain|launchctl|state:\\\"completed\\\"|state:'completed'" README.md src test docs/superpowers/specs/2026-07-07-supervisor-lifecycle-approval-persistence-preview-design.md docs/superpowers/plans/2026-07-07-supervisor-lifecycle-approval-persistence-preview.md
```

Expected: no positive production-ready or persistence/write claims. Negative tests and non-goals are allowed.

- [x] **Step 4: Qwen review**

Required: PASS or no blocking findings.

- [x] **Step 5: DeepSeek closure**

Required: JSON PASS, accepted true, `gold_status:"blocked"`.

- [ ] **Step 6: Commit gate**

Stop before commit/push unless Aaron explicitly confirms commit/push for this turn.

## Verification Evidence

- `node --test --test-reporter=dot test/supervisor-lifecycle-approval-persistence-preview.test.js test/supervisor-lifecycle.test.js test/supervisor-lifecycle-executor.test.js test/supervisor-lifecycle-audit-preview.test.js` exited 0.
- `node --test --test-reporter=dot test/agent-supervisor-lifecycle-apply.test.js test/server.test.js` exited 0.
- `node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js` exited 0.
- `node --test --test-reporter=dot test/*.test.js` exited 0.
- `git diff --check` exited 0.
- Safety scans after the `approval-window-invalid` fix found only fixture writes, negative documentation statements, historical non-goal statements, or existing unrelated source writes outside the V0.90 lifecycle preview diff.
- Qwen read-only review after the `approval-window-invalid` fix returned `STATUS: PASS`, `BLOCKING_FINDINGS: NONE`, `GOLD_STATUS: blocked`; it was advisory and based on PM-provided evidence.
- DeepSeek closure after the `approval-window-invalid` fix returned JSON `status:"PASS"`, `accepted:true`, `gold_status:"blocked"`, and no blocking findings; it was based on PM-provided evidence.
