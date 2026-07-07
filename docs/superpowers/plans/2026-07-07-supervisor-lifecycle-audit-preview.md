# Supervisor Lifecycle Audit Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a V0.89 sanitized supervisor lifecycle audit preview without writing audit files or enabling real lifecycle apply.

**Architecture:** Extend `src/supervisor-lifecycle.js` with one pure `buildSupervisorLifecycleAuditPreview(plan, lifecycleResult, options)` function. The preview creates an audit-log-compatible event shape but never calls `appendAuditEvent`; CLI/API/Web apply surfaces remain absent or blocked.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, existing `sanitizeAuditEvent` allowlist.

## Global Constraints

- No call to `appendAuditEvent`.
- No audit JSONL write.
- No `launchctl`, LaunchAgents write, metadata write, rollback anchor write, backup, restore, NAS command, or remote command.
- No CLI/Web/API lifecycle apply success path.
- Audit preview event fields are limited to `type`, `createdAt`, `outcome`, `message`, and optional safe `requestId`.
- `requestId` must match `^[A-Za-z0-9._:-]{1,80}$`; unsafe values are omitted.
- Event type and outcome must never contain `completed`, `success`, `ready`, or `production`.
- Gold remains blocked.

---

## File Structure

- Modify `src/supervisor-lifecycle.js`: export `buildSupervisorLifecycleAuditPreview`.
- Create `test/supervisor-lifecycle-audit-preview.test.js`: audit preview contract tests.
- Modify `test/agent-supervisor-lifecycle-apply.test.js`: assert CLI reports no `auditEvent`.
- Reuse `test/server.test.js`: keep GET/POST lifecycle apply API isolation.
- Modify `src/version.js`: bump to `V0.89`.
- Modify `README.md`: add V0.89 current row and audit preview safety docs.
- Modify `src/gold-readiness.js`: add V0.89 evidence while preserving partial/blocked statuses.
- Modify `test/version.test.js`, `test/readme.test.js`, `test/gold-readiness.test.js`: align version and docs evidence.

## Task 1: RED Tests For Audit Preview

**Files:**
- Create: `test/supervisor-lifecycle-audit-preview.test.js`

**Interfaces:**
- Consumes: `buildSupervisorLifecycleApplyPlan`, `executeSupervisorLifecycleApply`
- Produces expected future export: `buildSupervisorLifecycleAuditPreview(plan, lifecycleResult, options)`

- [x] **Step 1: Write failing tests**

Create `test/supervisor-lifecycle-audit-preview.test.js`:

```js
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
```

- [x] **Step 2: Run RED**

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle-audit-preview.test.js
```

Expected: fail because `buildSupervisorLifecycleAuditPreview` is not exported.

## Task 2: Implement Pure Audit Preview

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Test: `test/supervisor-lifecycle-audit-preview.test.js`

**Interfaces:**
- Produces: `buildSupervisorLifecycleAuditPreview(plan, lifecycleResult, options = {})`

- [x] **Step 1: Add constants and helpers**

Add near the existing lifecycle constants:

```js
const ALLOWED_AUDIT_RESULT_STATES = new Set(['blocked', 'failed', 'simulated']);
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
```

Add helpers:

```js
function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function safeRequestId(value) {
  return typeof value === 'string' && SAFE_REQUEST_ID_PATTERN.test(value) ? value : '';
}
```

- [x] **Step 2: Add exported function**

Add:

```js
export function buildSupervisorLifecycleAuditPreview(plan, lifecycleResult, options = {}) {
  const operation = ALLOWED_OPERATIONS.has(plan?.operation) ? plan.operation : 'unknown';
  const base = {
    command: 'supervisor-lifecycle-apply',
    operation,
    safety: lifecycleSafety(),
  };
  const blockers = [];

  if (!plan || plan.command !== 'supervisor-lifecycle-apply' || !Array.isArray(plan.actions)) {
    blockers.push('invalid-lifecycle-plan');
  } else if (!hasExpectedLifecycleActions(plan)) {
    blockers.push('lifecycle-plan-action-mismatch');
  }
  if (!lifecycleResult || lifecycleResult.command !== 'supervisor-lifecycle-apply') {
    blockers.push('invalid-lifecycle-result');
  }
  if (blockers.length === 0 && lifecycleResult.operation !== plan.operation) {
    blockers.push('lifecycle-audit-operation-mismatch');
  }
  if (blockers.length === 0 && !ALLOWED_AUDIT_RESULT_STATES.has(lifecycleResult.state)) {
    blockers.push('lifecycle-audit-state-not-allowed');
  }

  if (blockers.length > 0) {
    return {
      ...base,
      state: 'blocked',
      blockers: [...new Set(blockers)],
      auditEvent: null,
    };
  }

  const resultState = lifecycleResult.state;
  const auditEvent = {
    type: `supervisor.lifecycle.${plan.operation}.${resultState}`,
    createdAt: isoTimestamp(options.now || new Date()),
    outcome: resultState,
    message: `supervisor lifecycle ${plan.operation} ${resultState}; audit preview only; no host mutation`,
  };
  const requestId = safeRequestId(options.requestId);
  if (requestId) auditEvent.requestId = requestId;

  return {
    ...base,
    state: 'preview',
    auditEvent,
  };
}
```

- [x] **Step 3: Run GREEN**

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle-audit-preview.test.js test/supervisor-lifecycle-executor.test.js test/supervisor-lifecycle.test.js
```

Expected: pass.

## Task 3: Runtime Isolation Regression

**Files:**
- Modify: `test/agent-supervisor-lifecycle-apply.test.js`
- Test: `test/server.test.js`

- [x] **Step 1: Assert CLI has no auditEvent**

In the valid approval CLI test, add:

```js
assert.strictEqual(report.auditEvent, undefined);
assert.doesNotMatch(error.stdout, /auditEvent|supervisor\.lifecycle/i);
```

- [x] **Step 2: Run runtime isolation tests**

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

Set:

```js
export const LINKE_RELEASE_VERSION = 'V0.89';
```

- [x] **Step 2: Update README**

Add V0.89 current row:

```markdown
| V0.89 | 当前版本 | supervisor lifecycle audit preview：新增 `buildSupervisorLifecycleAuditPreview(plan, lifecycleResult, options)` sanitized 审计预览契约，只生成兼容 `sanitizeAuditEvent` allowlist 的 preview event，不调用 `appendAuditEvent`，不写 `dataDir/audit/events.jsonl`，Agent CLI 与 Web/API 仍不调用生命周期执行器，真实 `--apply` 继续 blocked；不调用 `launchctl`，不写 LaunchAgents、metadata、rollback anchor 或 audit 文件，Gold 依旧 blocked |
```

- [x] **Step 3: Update Gold readiness evidence**

Add evidence strings:

```js
'buildSupervisorLifecycleAuditPreview',
'test/supervisor-lifecycle-audit-preview.test.js',
```

Keep `automation-installation` and `production-hardening` partial and `real-nas-remote-backup` blocked.

- [x] **Step 4: Update documentation tests**

Tests should assert current version `V0.89`, V0.88 historical, V0.89 README row, audit preview non-write boundary, Gold blocked, and Gold readiness evidence.

- [x] **Step 5: Run docs tests**

Run:

```bash
node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

Expected: pass.

## Task 5: PM Verification

- [x] **Step 1: Run full suite**

Run:

```bash
node --test --test-reporter=dot test/*.test.js
```

Expected: pass.

- [x] **Step 2: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [x] **Step 3: Run overclaim scan**

Run:

```bash
rg -n "Gold ready|production ready|production-ready|launchctlCalled:true|filesystemWritten:true|metadataWritten:true|auditEventWritten:true|hostMutation:true|appendAuditEvent\\(|events\\.jsonl|state:\\\"completed\\\"|state:'completed'" README.md src test docs/superpowers/specs/2026-07-07-supervisor-lifecycle-audit-preview-design.md docs/superpowers/plans/2026-07-07-supervisor-lifecycle-audit-preview.md
```

Expected: no positive production-ready or write claims. Negative tests and explicit non-goals are allowed.

- [x] **Step 4: Qwen read-only review**

Required: `VERDICT: PASS` or no blocking findings.

- [x] **Step 5: DeepSeek closed-loop verification**

Required JSON: `verdict:"PASS"`, `accepted:true`, `gold_status:"blocked"`.

- [x] **Step 6: Commit gate**

Stop before commit/push unless Aaron explicitly confirms commit/push for this turn.
