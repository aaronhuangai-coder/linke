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
    assert.doesNotMatch(serialized, /\/Users\/ah|\blaunchctl\b|token|secret|password/i);
    assert.strictEqual(result.safety.sensitiveValuesReturned, false);
  });
});
