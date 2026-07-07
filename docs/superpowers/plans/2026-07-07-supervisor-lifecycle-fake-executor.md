# Supervisor Lifecycle Fake Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a V0.88 fake-executor-only supervisor lifecycle apply contract without enabling real host mutation.

**Architecture:** `src/supervisor-lifecycle.js` stays the single pure supervisor lifecycle module. The new `executeSupervisorLifecycleApply(plan, executor, options)` function accepts an existing V0.87 plan and an injected fake executor, returns sanitized simulation results, and is never called by the Agent CLI or server.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, existing Linke CLI/server tests.

## Global Constraints

- V0.88 must not call `launchctl`.
- V0.88 must not write LaunchAgents, metadata, rollback anchors, audit files, NAS data, backups, restores, or remote commands.
- V0.88 successful fake execution returns `state:"simulated"`, never `state:"completed"`.
- Simulation is allowed only when `plan.blockers` is exactly `['executor-implementation-missing']`.
- Plan action ids must exactly match the known action sequence for the requested operation.
- Unknown blocker strings from tampered plans must be replaced with a generic safe blocker code.
- Retries are immediate fake retries with at most two attempts total per action; no timers, sleeps, polling, or backoff logic.
- Executor context contains exactly `operation`, `actionId`, `attempt`, `maxAttempts`, and `mode`.
- Events contain exactly `operation`, `actionId`, `attempt`, `status`, and `mode`.
- Agent CLI still exits `2` for valid `--apply` because the real executor remains missing.
- No Web/API lifecycle apply endpoint is introduced.
- Gold remains blocked.

---

## File Structure

- Modify `src/supervisor-lifecycle.js`: export `executeSupervisorLifecycleApply`, constants, safety helpers, event/context allowlists.
- Create `test/supervisor-lifecycle-executor.test.js`: focused fake executor contract tests.
- Modify `test/agent-supervisor-lifecycle-apply.test.js`: add regression that CLI output has no simulation events.
- Modify `test/server.test.js`: add regression that lifecycle apply API route is absent.
- Modify `src/version.js`: bump current version to `V0.88`.
- Modify `README.md`: add V0.88 current version row and lifecycle fake-executor docs while preserving Gold blocked language.
- Modify `src/gold-readiness.js`: update V0.88 evidence and keep blocked/partial capabilities unchanged.
- Modify `test/version.test.js`, `test/readme.test.js`, `test/gold-readiness.test.js`: align current version and documentation evidence.

## Task 1: RED Tests For Fake Executor Contract

**Files:**
- Create: `test/supervisor-lifecycle-executor.test.js`

**Interfaces:**
- Consumes: `buildSupervisorLifecycleApplyPlan(config, options)` from `src/supervisor-lifecycle.js`
- Produces expected future export: `executeSupervisorLifecycleApply(plan, executor, options)`

- [x] **Step 1: Write failing tests**

Create `test/supervisor-lifecycle-executor.test.js` with these behaviors:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSupervisorLifecycleApplyPlan,
  executeSupervisorLifecycleApply,
} from '../src/supervisor-lifecycle.js';

const NOW = new Date('2026-07-07T05:00:00.000Z');
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'macbook-alpha',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});

function approvalFor(plan, overrides = {}) {
  return {
    operation: plan.operation,
    configHash: plan.configHash,
    planHash: plan.planHash,
    approved: true,
    schemaVersion: 1,
    approvedBy: 'operator@example.invalid',
    reason: 'V0.88 fake executor test approval',
    acknowledgements: ['fake-executor-only'],
    approvedAt: '2026-07-07T04:30:00.000Z',
    expiresAt: '2026-07-07T05:30:00.000Z',
    ...overrides,
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

describe('executeSupervisorLifecycleApply fake executor contract', () => {
  it('blocks invalid plan objects without calling the executor', async () => {
    const executor = fakeExecutor();

    const result = await executeSupervisorLifecycleApply(null, executor, { mode: 'fake-test-only' });

    assert.strictEqual(result.operation, 'unknown');
    assert.strictEqual(result.state, 'blocked');
    assert.ok(result.blockers.includes('invalid-lifecycle-plan'));
    assert.strictEqual(executor.calls.length, 0);
  });

  it('blocks missing executors before any fake action can run', async () => {
    const plan = applyReadyPlan();

    const result = await executeSupervisorLifecycleApply(plan, null, { mode: 'fake-test-only' });

    assert.strictEqual(result.state, 'blocked');
    assert.ok(result.blockers.includes('fake-executor-kind-required'));
  });

  it('blocks when fake mode is missing and does not call the executor', async () => {
    const plan = applyReadyPlan();
    const executor = fakeExecutor();

    const result = await executeSupervisorLifecycleApply(plan, executor);

    assert.strictEqual(result.state, 'blocked');
    assert.ok(result.blockers.includes('fake-executor-mode-required'));
    assert.deepStrictEqual(result.events, []);
    assert.strictEqual(executor.calls.length, 0);
  });

  it('blocks when executor kind is not the test-only fake kind', async () => {
    const plan = applyReadyPlan();
    const executor = { kind: 'real-looking-executor', runAction() {} };

    const result = await executeSupervisorLifecycleApply(plan, executor, { mode: 'fake-test-only' });

    assert.strictEqual(result.state, 'blocked');
    assert.ok(result.blockers.includes('fake-executor-kind-required'));
  });

  it('blocks required lifecycle gates that are not executor-only', async () => {
    const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });
    const executor = fakeExecutor();

    const result = await executeSupervisorLifecycleApply(plan, executor, { mode: 'fake-test-only' });

    assert.strictEqual(result.state, 'blocked');
    assert.ok(result.blockers.includes('apply-flag-required'));
    assert.strictEqual(executor.calls.length, 0);
  });

  it('blocks tampered plans that remove the executor blocker', async () => {
    const plan = { ...applyReadyPlan(), blockers: [] };
    const executor = fakeExecutor();

    const result = await executeSupervisorLifecycleApply(plan, executor, { mode: 'fake-test-only' });

    assert.strictEqual(result.state, 'blocked');
    assert.ok(result.blockers.includes('executor-blocker-required'));
    assert.strictEqual(executor.calls.length, 0);
  });

  it('blocks tampered action sequences without leaking action ids', async () => {
    const plan = {
      ...applyReadyPlan(),
      actions: [{ id: 'launchctl /Users/ah/Library/LaunchAgents/com.linke.agent.plist token=secret' }],
    };
    const executor = fakeExecutor();

    const result = await executeSupervisorLifecycleApply(plan, executor, { mode: 'fake-test-only' });
    const serialized = JSON.stringify(result);

    assert.strictEqual(result.state, 'blocked');
    assert.ok(result.blockers.includes('lifecycle-plan-action-mismatch'));
    assert.strictEqual(executor.calls.length, 0);
    assert.doesNotMatch(serialized, /\/Users\/ah|\blaunchctl\b|token|secret|password/i);
  });

  it('does not echo unsafe blocker strings from tampered plans', async () => {
    const plan = {
      ...applyReadyPlan(),
      blockers: [
        'executor-implementation-missing',
        'secret=/Users/ah/.ssh/id_rsa token=password',
      ],
    };
    const executor = fakeExecutor();

    const result = await executeSupervisorLifecycleApply(plan, executor, { mode: 'fake-test-only' });
    const serialized = JSON.stringify(result);

    assert.strictEqual(result.state, 'blocked');
    assert.ok(result.blockers.includes('lifecycle-plan-blocker-not-allowed'));
    assert.strictEqual(executor.calls.length, 0);
    assert.doesNotMatch(serialized, /\/Users\/ah|\.ssh|token|secret|password/i);
  });

  it('simulates actions in order with exact redacted context and events', async () => {
    const plan = applyReadyPlan('install');
    const executor = fakeExecutor();

    const result = await executeSupervisorLifecycleApply(plan, executor, { mode: 'fake-test-only' });

    assert.strictEqual(result.state, 'simulated');
    assert.notStrictEqual(result.state, 'completed');
    assert.deepStrictEqual(executor.calls.map((call) => call.action.id), [
      'render-launch-agent-plist',
      'write-launch-agent-plist',
      'load-launch-agent',
    ]);
    assert.deepStrictEqual(Object.keys(executor.calls[0].context).sort(), [
      'actionId',
      'attempt',
      'maxAttempts',
      'mode',
      'operation',
    ]);
    assert.ok(result.events.every((event) => (
      JSON.stringify(Object.keys(event).sort()) === JSON.stringify(['actionId', 'attempt', 'mode', 'operation', 'status'])
    )));
  });

  it('retries each failed action once and caps total calls at actions length times two', async () => {
    const plan = applyReadyPlan('uninstall');
    let firstActionAttempts = 0;
    const executor = fakeExecutor((action) => {
      if (action.id === 'unload-launch-agent' && firstActionAttempts < 1) {
        firstActionAttempts += 1;
        return { ok: false };
      }
      return { ok: true };
    });

    const result = await executeSupervisorLifecycleApply(plan, executor, { mode: 'fake-test-only' });

    assert.strictEqual(result.state, 'simulated');
    assert.ok(executor.calls.length <= plan.actions.length * 2);
    assert.strictEqual(executor.calls.filter((call) => call.action.id === 'unload-launch-agent').length, 2);
  });

  it('stops on the first action that still fails after two attempts', async () => {
    const plan = applyReadyPlan('rollback');
    const executor = fakeExecutor((action) => ({ ok: action.id !== 'restore-previous-plist' }));

    const result = await executeSupervisorLifecycleApply(plan, executor, { mode: 'fake-test-only' });

    assert.strictEqual(result.state, 'failed');
    assert.ok(result.blockers.includes('fake-executor-action-failed'));
    assert.strictEqual(result.failedActionId, 'restore-previous-plist');
    assert.strictEqual(executor.calls.filter((call) => call.action.id === 'restore-previous-plist').length, 2);
    assert.strictEqual(executor.calls.some((call) => call.action.id === 'restart-previous-supervisor'), false);
  });

  it('keeps recover blocked even with a valid approval', async () => {
    const plan = applyReadyPlan('recover');
    const executor = fakeExecutor();

    const result = await executeSupervisorLifecycleApply(plan, executor, { mode: 'fake-test-only' });

    assert.strictEqual(result.state, 'blocked');
    assert.ok(result.blockers.includes('recovery-supervisor-design-missing'));
    assert.strictEqual(executor.calls.length, 0);
  });

  it('does not leak approval metadata, paths, commands, or secret-like text', async () => {
    const plan = applyReadyPlan('install');
    const executor = fakeExecutor(() => ({
      ok: false,
      error: 'launchctl bootstrap /Users/ah/Library/LaunchAgents/com.linke.agent.plist token=secret',
    }));

    const result = await executeSupervisorLifecycleApply(plan, executor, { mode: 'fake-test-only' });
    const serialized = JSON.stringify(result);

    assert.doesNotMatch(serialized, /operator@example|fake executor test approval|acknowledgements/i);
    assert.doesNotMatch(serialized, /\/Users\/ah|launchctl|token|secret|password/i);
    assert.strictEqual(result.safety.sensitiveValuesReturned, false);
  });
});
```

- [x] **Step 2: Run RED**

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle-executor.test.js
```

Expected: fail because `executeSupervisorLifecycleApply` is not exported.

## Task 2: Implement Pure Fake Executor

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Test: `test/supervisor-lifecycle-executor.test.js`

**Interfaces:**
- Produces: `executeSupervisorLifecycleApply(plan, executor, options = {})`

- [x] **Step 1: Add minimal implementation**

Add helper constants near the top of `src/supervisor-lifecycle.js`:

```js
const FAKE_EXECUTOR_KIND = 'fake-supervisor-lifecycle-executor';
const FAKE_EXECUTOR_MODE = 'fake-test-only';
const MAX_FAKE_ATTEMPTS = 2;
```

Add a helper:

```js
function lifecycleSafety() {
  return {
    dryRun: true,
    hostMutation: false,
    launchctlCalled: false,
    filesystemWritten: false,
    metadataWritten: false,
    rollbackAnchorWritten: false,
    auditEventWritten: false,
    sensitiveValuesReturned: false,
  };
}
```

Use that helper in `buildSupervisorLifecycleApplyPlan` instead of duplicating the safety literal.

Add the exported function:

```js
export async function executeSupervisorLifecycleApply(plan, executor, options = {}) {
  const operation = typeof plan?.operation === 'string' ? plan.operation : 'unknown';
  const baseResult = {
    command: 'supervisor-lifecycle-apply',
    operation,
    events: [],
    safety: lifecycleSafety(),
  };
  const blockers = [];

  if (options.mode !== FAKE_EXECUTOR_MODE) blockers.push('fake-executor-mode-required');
  if (!executor || executor.kind !== FAKE_EXECUTOR_KIND || typeof executor.runAction !== 'function') {
    blockers.push('fake-executor-kind-required');
  }
  if (!plan || plan.command !== 'supervisor-lifecycle-apply' || !Array.isArray(plan.actions) || !Array.isArray(plan.blockers)) {
    blockers.push('invalid-lifecycle-plan');
  }

  if (blockers.length === 0) {
    const onlyExecutorMissing = plan.blockers.length === 1 && plan.blockers[0] === EXECUTOR_MISSING_BLOCKER;
    if (!onlyExecutorMissing) {
      blockers.push(...plan.blockers);
      if (!plan.blockers.includes(EXECUTOR_MISSING_BLOCKER)) blockers.push('executor-blocker-required');
      if (plan.blockers.length === 0) blockers.push('executor-blocker-required');
    }
  }

  if (blockers.length > 0) {
    return {
      ...baseResult,
      state: 'blocked',
      blockers: [...new Set(blockers)],
    };
  }

  const events = [];
  for (const action of plan.actions) {
    let actionSucceeded = false;
    for (let attempt = 1; attempt <= MAX_FAKE_ATTEMPTS; attempt += 1) {
      const context = {
        operation: plan.operation,
        actionId: action.id,
        attempt,
        maxAttempts: MAX_FAKE_ATTEMPTS,
        mode: FAKE_EXECUTOR_MODE,
      };
      let outcome;
      try {
        outcome = await executor.runAction({ id: action.id, status: action.status }, context);
      } catch {
        outcome = { ok: false };
      }
      if (outcome?.ok === true) {
        events.push({
          operation: plan.operation,
          actionId: action.id,
          attempt,
          status: 'simulated',
          mode: FAKE_EXECUTOR_MODE,
        });
        actionSucceeded = true;
        break;
      }
      events.push({
        operation: plan.operation,
        actionId: action.id,
        attempt,
        status: 'failed',
        mode: FAKE_EXECUTOR_MODE,
      });
    }

    if (!actionSucceeded) {
      return {
        ...baseResult,
        state: 'failed',
        blockers: ['fake-executor-action-failed'],
        failedActionId: action.id,
        attempts: MAX_FAKE_ATTEMPTS,
        events,
      };
    }
  }

  return {
    ...baseResult,
    state: 'simulated',
    blockers: [EXECUTOR_MISSING_BLOCKER],
    events,
  };
}
```

- [x] **Step 2: Run GREEN**

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle-executor.test.js test/supervisor-lifecycle.test.js
```

Expected: pass.

## Task 3: CLI/API Isolation Regressions

**Files:**
- Modify: `test/agent-supervisor-lifecycle-apply.test.js`
- Modify: `test/server.test.js`

**Interfaces:**
- Consumes: existing Agent CLI and server handler behavior.
- Produces: tests proving V0.88 fake executor is not reachable from runtime surfaces.

- [x] **Step 1: Add CLI assertion**

In the existing valid approval CLI test, assert:

```js
assert.strictEqual(report.state, 'blocked');
assert.strictEqual(report.events, undefined);
assert.doesNotMatch(error.stdout, /simulated|fake-test-only|events/i);
```

- [x] **Step 2: Add API absence test**

Add a server test that sends:

```http
POST /api/supervisor-lifecycle-apply
```

Expected: `404`, and response body does not contain `simulated`, `fake-test-only`, or `launchctl`.

- [x] **Step 3: Run targeted tests**

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

**Interfaces:**
- Consumes: V0.88 implementation and tests.
- Produces: current version evidence that does not overclaim Gold readiness.

- [x] **Step 1: Update version**

Set:

```js
export const VERSION = 'V0.88';
```

- [x] **Step 2: Update README**

Add a V0.88 current row above V0.87:

```markdown
| V0.88 | 当前版本 | supervisor lifecycle fake executor contract：新增 `executeSupervisorLifecycleApply(plan, executor, options)` 的 fake-test-only 单元测试执行契约，只在注入 `fake-supervisor-lifecycle-executor` 且 `plan.blockers` 精确为 `executor-implementation-missing` 时返回 `state:"simulated"`；Agent CLI 与 Web/API 仍不调用执行器，真实 `--apply` 继续 blocked；不调用 `launchctl`，不写 LaunchAgents、metadata、rollback anchor 或 audit 文件，Gold 依旧 blocked |
```

Add a lifecycle section stating the same boundary and no Gold-ready claim.

- [x] **Step 3: Update Gold readiness**

Update V0.87 text references to V0.88 evidence, while leaving `automation-installation` and `production-hardening` partial and `real-nas-remote-backup` blocked.

- [x] **Step 4: Update docs tests**

Update tests to assert:

```js
assert.strictEqual(VERSION, 'V0.88');
assertReadmeContains(/V0\.88[\s\S]*?fake executor/i);
assertReadmeContains(/V0\.88[\s\S]*?Gold\s+依旧\s+blocked/i);
assertGoldReadinessContains(/V0\.88[\s\S]*?executeSupervisorLifecycleApply/);
```

- [x] **Step 5: Run docs tests**

Run:

```bash
node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

Expected: pass.

## Task 5: PM Verification And Worker Review

**Files:**
- Review all changed files.

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
rg -n "Gold ready|production ready|launchctlCalled:true|filesystemWritten:true|metadataWritten:true|auditEventWritten:true|hostMutation:true|state:\\\"completed\\\"|state:'completed'" README.md src test docs/superpowers/specs/2026-07-07-supervisor-lifecycle-fake-executor-design.md
```

Expected: no positive production-ready or completed lifecycle claims. Negative test assertions and explicit blocked wording are allowed.

- [x] **Step 4: Qwen read-only adversarial review**

Run Qwen in read-only mode over the diff. Required verdict: PASS or no blocking findings.

- [x] **Step 5: DeepSeek closed-loop verification**

Run DeepSeek with JSON-only schema. Required verdict: PASS, accepted true, `gold_status:"blocked"`.

- [x] **Step 6: Commit gate**

Because `AGENTS.md` requires confirmation for `git commit` and `git push`, stop after verification and ask Aaron for explicit commit/push approval unless a newer direct instruction in this turn overrides the gate.
