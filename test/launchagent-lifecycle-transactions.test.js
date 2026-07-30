/**
 * Linke V1.46 Task 4 RED — transaction coordinator 存在性门与事务行为冻结测试。
 *
 * 目标模块 src/launchagent-lifecycle/transaction-coordinator.js 故意不存在：
 * 仅存在性断言失败；缺失时行为测试不注册、不动态 import。
 * 覆盖 first install / managed upgrade / stop / 有界 compensation；
 * rollback/uninstall/recover/MIR takeover/concurrency 属 Task 5。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LaunchAgentLifecycleError,
  validateLaunchAgentReceipt,
} from '../src/launchagent-lifecycle/contracts.js';
import { validateLaunchctlRequest } from '../src/launchagent-lifecycle/host-adapter.js';
import { createLaunchAgentLifecycleHarness } from './helpers/launchagent-lifecycle-harness.js';

const coordinatorUrl = new URL(
  '../src/launchagent-lifecycle/transaction-coordinator.js',
  import.meta.url,
);
const coordinatorExists = existsSync(fileURLToPath(coordinatorUrl));

test('transaction-coordinator module must exist before Task 4 behavior tests', () => {
  assert.equal(
    coordinatorExists,
    true,
    'expected src/launchagent-lifecycle/transaction-coordinator.js to exist before transaction behavior tests',
  );
});

test('Task 4 harness readJournalHeads mirrors closed global validation semantics', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  const store = harness.dependencies().metadataStore;
  const empty = await store.readJournalHeads();
  assert.equal(empty.kind, 'journal-heads');
  assert.match(empty.journalSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(empty.heads, []);
  assert.ok(Object.isFrozen(empty));
  assert.ok(Object.isFrozen(empty.heads));
  await assert.rejects(store.readJournalHeads({}), (error) => {
    assert.ok(error instanceof LaunchAgentLifecycleError);
    assert.equal(error.code, 'launchagent-lifecycle-invalid');
    return true;
  });
  assert.throws(
    () => harness.seedForeignNonterminalHead({
      transactionId: 'f0000000-0000-4000-8000-000000000003',
      operation: 'not-a-real-operation',
      state: 'not-a-real-state',
    }),
    (error) => {
      assert.ok(error instanceof LaunchAgentLifecycleError);
      assert.equal(error.code, 'launchagent-lifecycle-invalid');
      return true;
    },
  );
});

if (coordinatorExists) {
  const { createLaunchAgentLifecycleCoordinator } = await import(coordinatorUrl);

  test('coordinator factory export createLaunchAgentLifecycleCoordinator is a function', () => {
    assert.equal(typeof createLaunchAgentLifecycleCoordinator, 'function');
  });

  if (typeof createLaunchAgentLifecycleCoordinator === 'function') {
    const COMMIT_A = 'a'.repeat(40);
    const COMMIT_B = 'b'.repeat(40);
    const SCHEDULE = 300;
    const LABEL_C = 'com.linke.controller';
    const LABEL_S = 'com.linke.scheduler';
    const FULL_IDENTITY_KEYS = Object.freeze([
      'basename', 'device', 'inode', 'ownerUid', 'rootId', 'sha256', 'type',
    ]);
    const INSTALL_INPUT = Object.freeze({
      sourceCommit: COMMIT_A,
      scheduleSeconds: SCHEDULE,
      controllerEnvironment: {},
    });

    const INSTALL_JOURNAL = Object.freeze([
      'prepared', 'anchored',
      'controller-publish-intent', 'controller-published',
      'scheduler-publish-intent', 'scheduler-published',
      'manifest-publish-intent', 'manifest-published',
      'controller-load-intent', 'controller-loaded', 'controller-ready',
      'scheduler-load-intent', 'scheduler-loaded',
      'committed',
    ]);
    const UPGRADE_JOURNAL = Object.freeze([
      'prepared', 'anchored',
      'scheduler-stop-intent', 'scheduler-stopped',
      'controller-stop-intent', 'controller-stopped',
      'controller-publish-intent', 'controller-published',
      'scheduler-publish-intent', 'scheduler-published',
      'manifest-publish-intent', 'manifest-published',
      'controller-load-intent', 'controller-loaded', 'controller-ready',
      'scheduler-load-intent', 'scheduler-loaded',
      'committed',
    ]);
    const STOP_JOURNAL = Object.freeze([
      'prepared', 'anchored',
      'scheduler-stop-intent', 'scheduler-stopped',
      'controller-stop-intent', 'controller-stopped',
      'committed',
    ]);
    const HOST_MUTATION_EVENTS = Object.freeze([
      'publish-controller', 'publish-scheduler', 'publish-manifest',
      'remove-controller', 'remove-scheduler', 'remove-manifest',
      'bootout-controller', 'bootout-scheduler',
      'bootstrap-controller', 'bootstrap-scheduler',
    ]);
    const LEAK_CANARIES = Object.freeze([
      'CANARY', '/Users/', '/bin/launchctl', 'Library/LaunchAgents',
      'stdout', 'stderr', 'argv',
    ]);

    function collectStrings(value, out = []) {
      if (typeof value === 'string') {
        out.push(value);
        return out;
      }
      if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return out;
      if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, out);
        return out;
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'string') out.push(key);
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (d && Object.hasOwn(d, 'value')) collectStrings(d.value, out);
      }
      return out;
    }

    function assertNoLeakage(value, label) {
      const text = JSON.stringify(collectStrings(value));
      for (const canary of LEAK_CANARIES) {
        assert.equal(text.includes(canary), false, `${label} must not leak ${JSON.stringify(canary)}`);
      }
    }

    function assertLifecycleInvalid(error) {
      assert.ok(error instanceof LaunchAgentLifecycleError);
      assert.equal(error.code, 'launchagent-lifecycle-invalid');
      assert.equal(error.message, 'launchagent-lifecycle-invalid');
      return true;
    }

    function assertThrowsInvalid(fn) {
      assert.throws(fn, assertLifecycleInvalid);
    }

    async function assertRejectsInvalid(promise) {
      await assert.rejects(promise, assertLifecycleInvalid);
    }

    async function assertRejectsCode(promise, code) {
      await assert.rejects(promise, (error) => {
        assert.ok(error instanceof LaunchAgentLifecycleError);
        assert.equal(error.code, code);
        assert.equal(error.message, code);
        return true;
      });
    }

    function compEvent(action, phase) {
      return { kind: 'compensation', action, phase };
    }

    function eventsEqual(actual, expected) {
      if (typeof actual === 'string' || typeof expected === 'string') return actual === expected;
      return actual.kind === expected.kind
        && actual.action === expected.action
        && actual.phase === expected.phase;
    }

    function countEvents(trace, name) {
      return trace.filter((e) => e === name).length;
    }

    function indexOfEvent(trace, name) {
      return trace.findIndex((e) => e === name);
    }

    function assertSubsequence(trace, expected, label) {
      let cursor = 0;
      for (const wanted of expected) {
        let found = -1;
        for (let i = cursor; i < trace.length; i += 1) {
          if (eventsEqual(trace[i], wanted)) {
            found = i;
            break;
          }
        }
        assert.notEqual(found, -1, `${label}: missing ${JSON.stringify(wanted)} after ${cursor}`);
        cursor = found + 1;
      }
    }

    function assertCompensationSequence(harness, actions) {
      const expected = actions.flatMap((a) => [compEvent(a, 'intent'), compEvent(a, 'completed')]);
      assert.deepEqual(harness.compensationEvents(), expected);
    }

    /** prepared 必须是本事务第一条 journal；blocked/no-change 不得当首条。 */
    function assertPreparedFirst(harness, transactionId) {
      const states = harness.journalStates(transactionId);
      assert.ok(states.length >= 1, 'journal must have entries');
      assert.equal(states[0], 'prepared', 'first journal state must be prepared');
    }

    function assertJournalOperation(harness, transactionId, operation) {
      const entries = harness.journalEntries(transactionId);
      assert.ok(entries.length > 0, 'journal operation check requires entries');
      assert.deepEqual(
        [...new Set(entries.map((entry) => entry.operation))],
        [operation],
        'journal operation must remain immutable for the whole transaction',
      );
    }

    function assertTerminalCloseout(harness, result, expectation) {
      const receipt = validateLaunchAgentReceipt(result);
      assert.equal(receipt.state, expectation.state);
      assert.equal(receipt.outcome, expectation.outcome);
      assert.equal(receipt.success, expectation.success);
      const stored = harness.receiptFor(receipt.transactionId);
      assert.ok(stored !== null, 'receipt must be published');
      assert.deepEqual(receipt, stored);
      assertPreparedFirst(harness, receipt.transactionId);
      const entries = harness.journalEntries(receipt.transactionId);
      const terminal = entries.at(-1);
      assert.equal(terminal.state, expectation.state);
      const expectedReceiptSha = harness.sha256(Buffer.from(JSON.stringify(stored), 'utf8'));
      assert.equal(terminal.payload.receiptSha256, expectedReceiptSha);
      assert.equal(terminal.payload.hostMutationCount, receipt.hostMutationCount);
      const trace = harness.trace();
      const lastReceipt = trace.lastIndexOf('receipt');
      const lockRelease = trace.lastIndexOf('lock-release');
      assert.ok(lastReceipt !== -1 && lockRelease !== -1);
      assert.ok(lastReceipt < lockRelease, 'receipt before unlock');
      assert.equal(lockRelease, trace.length - 1, 'unlock is final');
      assert.equal(receipt.hostMutationCount, harness.sentinels().hostMutationCount);
      assert.deepEqual(harness.lockState(), {
        transactionLock: false,
        manualInterventionLock: false,
      });
      return receipt;
    }

    function assertManualInterventionHandoff(harness, result) {
      const projection = validateLaunchAgentReceipt(result);
      assert.equal(projection.state, 'manual-intervention-required');
      assert.equal(projection.outcome, 'manual-intervention-required');
      assert.equal(projection.success, false);
      assert.equal(harness.receiptFor(projection.transactionId), null);
      assert.deepEqual(harness.lockState(), {
        transactionLock: false,
        manualInterventionLock: true,
      });
      return projection;
    }

    function assertZeroHostMutation(harness, label) {
      const trace = harness.trace();
      for (const name of HOST_MUTATION_EVENTS) {
        assert.equal(countEvents(trace, name), 0, `${label}: ${name}`);
      }
      const s = harness.sentinels();
      assert.equal(s.hostMutationCount, 0, `${label}: hostMutationCount`);
      assert.equal(s.publish + s.remove + s.bootout + s.bootstrap, 0, `${label}: mutation parts`);
    }

    function assertSingleCompensationPlan(harness, transactionId) {
      assert.equal(
        harness.journalStates(transactionId).filter((s) => s === 'compensating').length,
        1,
        'exactly one frozen reverse plan',
      );
    }

    /** 精确冻结 dual-heads → lock/verify → prepared → inspect → anchor → stage/lint/publish。 */
    function assertGateAndPreparedOrder(
      harness,
      { requiresCandidates = true, terminalHeadCount = 0 } = {},
    ) {
      const names = harness.adapterCalls().map((call) => call.name);
      const firstHeads = names.indexOf('read-journal-heads');
      const lockAcquire = names.indexOf('lock-acquire', firstHeads + 1);
      const lockVerify = names.indexOf('lock-verify', lockAcquire + 1);
      const secondHeads = names.indexOf('read-journal-heads', lockVerify + 1);
      const prepared = names.indexOf('append-journal', secondHeads + 1);
      const firstInspectFile = names.indexOf('inspect-file');
      const firstInspectJob = names.indexOf('inspect-job');
      const firstInspection = Math.min(
        firstInspectFile === -1 ? Number.POSITIVE_INFINITY : firstInspectFile,
        firstInspectJob === -1 ? Number.POSITIVE_INFINITY : firstInspectJob,
      );
      const anchor = names.indexOf('write-anchor', prepared + 1);

      assert.ok(firstHeads !== -1, 'pre-lock readJournalHeads required');
      assert.ok(firstHeads < lockAcquire, 'pre-lock heads before lock acquisition');
      assert.ok(lockAcquire < lockVerify, 'lock acquisition before identity verification');
      assert.ok(lockVerify < secondHeads, 'post-lock heads after verified lock');
      assert.ok(secondHeads < prepared, 'prepared append after identical post-lock heads');
      assert.equal(
        names.slice(firstHeads + 1, lockAcquire).filter((name) => name === 'read-receipt').length,
        terminalHeadCount,
        'pre-lock terminal heads require durable receipt revalidation',
      );
      assert.equal(
        names.slice(secondHeads + 1, prepared).filter((name) => name === 'read-receipt').length,
        terminalHeadCount,
        'post-lock terminal heads require durable receipt revalidation',
      );
      assert.ok(Number.isFinite(firstInspection), 'ownership/file/job inspection required');
      assert.ok(prepared < firstInspection, 'inspection must not precede prepared');
      assert.ok(firstInspection < anchor, 'anchor follows frozen inspected pre-state');

      const forbiddenBeforePrepared = new Set([
        'inspect-file', 'inspect-job', 'write-anchor',
        'write-candidate', 'plist-validate', 'publish', 'host-mutation',
      ]);
      assert.equal(
        names.slice(0, prepared).some((name) => forbiddenBeforePrepared.has(name)),
        false,
        'no inspection/staging/plutil/publish/host mutation before prepared',
      );

      if (requiresCandidates) {
        const candidateIndices = names
          .map((name, index) => (name === 'write-candidate' ? index : -1))
          .filter((index) => index !== -1);
        const lintIndices = names
          .map((name, index) => (name === 'plist-validate' ? index : -1))
          .filter((index) => index !== -1);
        const firstCandidate = candidateIndices[0] ?? -1;
        const firstLint = lintIndices[0] ?? -1;
        const firstPublish = names.indexOf('publish');
        assert.equal(candidateIndices.length, 3, 'all three candidates staged exactly once');
        assert.equal(lintIndices.length, 2, 'exactly two staged plists linted');
        assert.ok(anchor < firstCandidate, 'candidate staging follows anchor');
        assert.ok(
          candidateIndices.every((index) => index > anchor),
          'no candidate staging may occur before anchor',
        );
        assert.ok(
          Math.max(...candidateIndices) < Math.min(...lintIndices),
          'all candidate staging completes before plist lint',
        );
        assert.ok(
          Math.max(...lintIndices) < firstPublish,
          'all plist lint completes before first publish',
        );
      }

      const sentinels = harness.sentinels();
      assert.equal(sentinels.readJournalHeads, 2, 'exactly pre-lock and post-lock heads reads');
      assert.equal(sentinels.lockVerify, 1, 'transaction lock identity verified exactly once');
    }

    function upgradeInput(overrides = {}) {
      return {
        sourceCommit: COMMIT_B,
        scheduleSeconds: SCHEDULE,
        controllerEnvironment: {},
        ...overrides,
      };
    }

    // ----- factory fail-closed -----

    test('factory fails closed on missing/unknown keys and required methods', async (t) => {
      const harness = createLaunchAgentLifecycleHarness();
      const contract = harness.factoryContract();
      const deps = harness.dependencies();

      for (const key of contract.keys) {
        await t.test(`missing ${key}`, () => {
          const reduced = { ...deps };
          delete reduced[key];
          assertThrowsInvalid(() => createLaunchAgentLifecycleCoordinator(reduced));
        });
      }

      assertThrowsInvalid(() => createLaunchAgentLifecycleCoordinator({
        ...deps,
        rogue: {},
      }));

      for (const [depKey, methods] of Object.entries(contract.methods)) {
        for (const method of methods) {
          await t.test(`missing ${depKey}.${method}`, () => {
            const next = { ...deps, [depKey]: { ...deps[depKey] } };
            delete next[depKey][method];
            assertThrowsInvalid(() => createLaunchAgentLifecycleCoordinator(next));
          });
          await t.test(`non-function ${depKey}.${method}`, () => {
            const next = { ...deps, [depKey]: { ...deps[depKey], [method]: 1 } };
            assertThrowsInvalid(() => createLaunchAgentLifecycleCoordinator(next));
          });
        }
      }
    });

    test('P1-6 factory rejects accessor-backed dependencies without invoking hostile getters', () => {
      const harness = createLaunchAgentLifecycleHarness();
      const deps = harness.dependencies();
      const methods = harness.factoryContract().methods.metadataStore;
      let getterReads = 0;
      const descriptors = Object.fromEntries(methods.map((method) => [method, {
        value: deps.metadataStore[method],
        enumerable: true,
        configurable: true,
        writable: true,
      }]));
      descriptors.readJournal = {
        get() {
          getterReads += 1;
          throw new Error('hostile dependency getter executed');
        },
        enumerable: true,
        configurable: true,
      };
      const metadataStore = Object.create(Object.prototype, descriptors);

      assertThrowsInvalid(() => createLaunchAgentLifecycleCoordinator({
        ...deps,
        metadataStore,
      }));
      assert.equal(getterReads, 0, 'factory validation must inspect descriptors, not execute accessors');
    });

    test('factory accepts exact surface and exposes install/managedUpgrade/stop', () => {
      const harness = createLaunchAgentLifecycleHarness();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      assert.equal(typeof c.install, 'function');
      assert.equal(typeof c.managedUpgrade, 'function');
      assert.equal(typeof c.stop, 'function');
    });

    test('operations reject malformed closed inputs', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      await assertRejectsInvalid(c.install({}));
      await assertRejectsInvalid(c.install({
        sourceCommit: 'bad',
        scheduleSeconds: SCHEDULE,
        controllerEnvironment: {},
      }));
      await assertRejectsInvalid(c.install({ ...INSTALL_INPUT, unexpected: true }));
      await assertRejectsInvalid(c.install({
        sourceCommit: COMMIT_A,
        scheduleSeconds: 30,
        controllerEnvironment: {},
      }));
      await assertRejectsInvalid(c.managedUpgrade({}));
      await assertRejectsInvalid(c.stop({}));
      await assertRejectsInvalid(c.stop({ sourceCommit: 'bad' }));
    });

    test('final-review controllerEnvironment null is normalized to lifecycle-invalid', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      await assertRejectsInvalid(c.install({
        ...INSTALL_INPUT,
        controllerEnvironment: null,
      }));
      assertZeroHostMutation(harness, 'null controllerEnvironment');
      assert.deepEqual(harness.lockState(), {
        transactionLock: false,
        manualInterventionLock: false,
      });
    });

    test('launchctlRunner rejects non-validateLaunchctlRequest shapes', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const runner = harness.dependencies().launchctlRunner;
      await assert.rejects(
        () => runner.run({ operation: 'bootout', role: 'scheduler', purpose: 'operation' }),
        assertLifecycleInvalid,
      );
      await assert.rejects(
        () => runner.run({
          operation: 'print',
          uid: harness.fixedUid(),
          rootId: 'current-user-launch-agents',
          basename: 'com.linke.scheduler.plist',
          resolvedPath: harness.syntheticResolvedPath('scheduler'),
          argv: ['print', `gui/${harness.fixedUid()}/com.linke.scheduler`],
          purpose: 'inspect',
        }),
        assertLifecycleInvalid,
      );
      // 合法形状可通过 production validator
      const ok = validateLaunchctlRequest({
        operation: 'print',
        uid: harness.fixedUid(),
        rootId: 'current-user-launch-agents',
        basename: 'com.linke.scheduler.plist',
        resolvedPath: harness.syntheticResolvedPath('scheduler'),
        argv: ['print', `gui/${harness.fixedUid()}/com.linke.scheduler`],
      });
      assert.equal(ok.operation, 'print');
      assert.equal(ok.role, 'scheduler');
    });

    // ----- first install -----

    test('foreign nonterminal global head blocks unknown-id first install before lock', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const foreignTransactionId = 'f0000000-0000-4000-8000-000000000001';
      const foreignHead = harness.seedForeignNonterminalHead({
        transactionId: foreignTransactionId,
        operation: 'install',
        state: 'prepared',
      });
      assert.equal(foreignHead.transactionId, foreignTransactionId);
      assert.deepEqual(harness.journalStates(foreignTransactionId), ['prepared']);
      assert.deepEqual(harness.lockState(), {
        transactionLock: false,
        manualInterventionLock: false,
      });

      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      await assertRejectsCode(c.install(INSTALL_INPUT), 'recovery-required');

      assert.deepEqual(harness.journalStates(foreignTransactionId), ['prepared']);
      assert.deepEqual(harness.journalTransactionIds(), [foreignTransactionId]);
      assert.deepEqual(harness.receiptTransactionIds(), []);
      assert.deepEqual(
        harness.adapterCalls().map((call) => call.name),
        ['read-journal-heads'],
        'pre-lock blocker must not acquire a lock or create a current transaction',
      );
      assert.deepEqual(harness.trace(), ['journal']);
      assert.equal(harness.sentinels().readJournalHeads, 1);
      assert.equal(harness.sentinels().writeCandidate, 0);
      assert.equal(harness.sentinels().plistValidate, 0);
      assert.equal(harness.sentinels().inspect, 0);
      assert.deepEqual(harness.lockState(), {
        transactionLock: false,
        manualInterventionLock: false,
      });
      assertZeroHostMutation(harness, 'foreign nonterminal global block');
    });

    test('pre-lock terminal head requires present and hash-aligned durable receipt', async (t) => {
      const cases = [
        ['missing receipt', (h, seed) => h.deleteReceiptFor(seed.transactionId)],
        ['receipt hash mismatch', (h, seed) => h.misalignReceiptHashFor(seed.transactionId)],
      ];
      for (const [name, corrupt] of cases) {
        await t.test(name, async () => {
          const harness = createLaunchAgentLifecycleHarness();
          const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
          harness.resetObservations();
          corrupt(harness, seed);
          const beforeJournalIds = harness.journalTransactionIds();
          const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

          await assertRejectsCode(c.install(INSTALL_INPUT), 'recovery-required');

          assert.deepEqual(harness.journalTransactionIds(), beforeJournalIds);
          assert.deepEqual(
            harness.adapterCalls().map((call) => call.name),
            ['read-journal-heads', 'read-receipt'],
            `${name}: terminal receipt failure must remain pre-lock`,
          );
          assert.deepEqual(harness.lockState(), {
            transactionLock: false,
            manualInterventionLock: false,
          });
          assert.equal(harness.sentinels().writeCandidate, 0);
          assert.equal(harness.sentinels().inspect, 0);
          assertZeroHostMutation(harness, name);
        });
      }
    });

    test('post-lock journal snapshot drift closes current attempt blocked without host mutation', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const foreignTransactionId = 'f0000000-0000-4000-8000-000000000002';
      let foreignHead = null;
      harness.afterEvent('lock-acquire', () => {
        foreignHead = harness.seedForeignNonterminalHead({
          transactionId: foreignTransactionId,
          operation: 'install',
          state: 'prepared',
        });
      });

      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.install(INSTALL_INPUT);
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'blocked', outcome: 'recovery-required', success: false,
      });
      assert.ok(foreignHead !== null);
      assert.deepEqual(harness.journalStates(foreignTransactionId), ['prepared']);
      assert.deepEqual(harness.journalStates(receipt.transactionId), ['prepared', 'blocked']);
      assert.equal(
        harness.journalEntries(receipt.transactionId).at(-1).payload.blockedByEntrySha256,
        foreignHead.entrySha256,
      );
      assert.equal(harness.sentinels().readJournalHeads, 2);
      assert.equal(harness.sentinels().writeCandidate, 0);
      assert.equal(harness.sentinels().plistValidate, 0);
      assert.equal(harness.sentinels().inspect, 0);
      assertZeroHostMutation(harness, 'post-lock journal snapshot drift');
    });

    test('post-lock terminal receipt disappearance closes current attempt blocked', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      harness.afterEvent('lock-acquire', () => {
        harness.deleteReceiptFor(seed.transactionId);
      });

      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.managedUpgrade(upgradeInput({ sourceCommit: COMMIT_B }));
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'blocked', outcome: 'recovery-required', success: false,
      });
      const seedTerminal = harness.journalEntries(seed.transactionId).at(-1);
      assert.deepEqual(harness.journalStates(receipt.transactionId), ['prepared', 'blocked']);
      assert.equal(
        harness.journalEntries(receipt.transactionId).at(-1).payload.blockedByEntrySha256,
        seedTerminal.entrySha256,
      );
      assert.deepEqual(harness.receiptTransactionIds(), [receipt.transactionId]);
      assert.equal(harness.sentinels().readJournalHeads, 2);
      assert.equal(harness.sentinels().writeCandidate, 0);
      assert.equal(harness.sentinels().inspect, 0);
      assertZeroHostMutation(harness, 'post-lock missing terminal receipt');
    });

    test('first install happy path: order, staging, lint, revalidate, receipt', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.install(INSTALL_INPUT);
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'committed',
        outcome: 'completed',
        success: true,
      });
      assert.equal(receipt.operation, 'install');
      assertJournalOperation(harness, receipt.transactionId, 'install');
      assert.deepEqual(harness.journalStates(receipt.transactionId), [...INSTALL_JOURNAL]);

      const trace = harness.trace();
      assertGateAndPreparedOrder(harness);
      assertSubsequence(trace, [
        'journal', 'lock-acquire', 'journal', 'journal',
        'inspect', 'inspect', 'inspect',
        'inspect-job-controller', 'inspect-job-scheduler',
        'anchor',
        'publish-controller', 'publish-scheduler', 'publish-manifest',
        'bootstrap-controller', 'verify-job-controller',
        'health-controller',
        'bootstrap-scheduler', 'verify-job-scheduler', 'verify-scheduler-outcome',
        'verify-job-controller', 'verify-job-scheduler',
        'journal', 'receipt', 'lock-release',
      ], 'install order');
      assert.ok(
        indexOfEvent(trace, 'health-controller') < indexOfEvent(trace, 'bootstrap-scheduler'),
      );

      // candidate staging：三角色均 staged；仅两 plist lint
      const stagedRoles = harness.candidatesWritten().map((x) => x.role).sort();
      assert.deepEqual(stagedRoles, ['controller', 'manifest', 'scheduler']);
      const stagedRefs = [...harness.candidatesWritten()].sort((a, b) => a.role.localeCompare(b.role));
      const publishedRefs = [...harness.publishedCandidateRefs()]
        .sort((a, b) => a.role.localeCompare(b.role));
      assert.deepEqual(publishedRefs, stagedRefs, 'publisher receives exact opaque candidate refs');
      for (const ref of publishedRefs) {
        assert.deepEqual(
          Object.keys(ref).sort(),
          ['kind', 'role', 'sha256', 'transactionId'],
          'publisher candidate ref surface is exact',
        );
        assert.equal(ref.kind, 'candidate');
      }
      const s = harness.sentinels();
      assert.equal(s.writeCandidate, 3);
      assert.ok(s.readCandidate >= 2, 'plist bytes read-back/hash 复核');
      assert.equal(s.plistValidate, 2, 'exactly two plist lints');

      // revalidate：manifest publish 前、每个 bootstrap 前、commit 前
      const marks = s.revalidateMarks;
      assert.ok(marks.includes('before-manifest-publish'));
      assert.ok(marks.includes('before-bootstrap-controller'));
      assert.ok(marks.includes('before-bootstrap-scheduler'));
      assert.ok(marks.includes('before-commit'));
      assert.ok(s.revalidate >= 4);
      assert.ok(s.render >= 1);

      assert.deepEqual(receipt.roles, {
        controller: { label: LABEL_C, outcome: 'created', changed: true },
        scheduler: { label: LABEL_S, outcome: 'created', changed: true },
      });
      const anchor = harness.anchorFor(receipt.anchorId);
      assert.equal(anchor.purpose, 'first-install');
      assert.deepEqual(anchor.controller, { priorState: 'absent' });
      assert.deepEqual(anchor.scheduler, { priorState: 'absent' });
      assert.deepEqual(anchor.manifest, { priorState: 'absent' });
      assert.deepEqual(anchor.loaded, { controller: false, scheduler: false });

      const snap = harness.hostSnapshot();
      assert.deepEqual(snap.loaded, { controller: true, scheduler: true });
      assert.equal(snap.jobIdentity.controller, snap.controller.sha256);
      assert.equal(snap.jobIdentity.scheduler, snap.scheduler.sha256);
      assert.equal(s.publish, 3);
      assert.equal(s.bootstrap, 2);
      assert.equal(s.hostMutationCount, 5);
      assert.equal(s.realLaunchctlCalls, 0);
      assertNoLeakage(result, 'install');
      assertNoLeakage(harness.journalEntries(receipt.transactionId), 'install journal');
    });

    test('P1-1 closeout rereads and validates the full terminal journal before unlock', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.afterEvent('receipt', () => harness.corruptLatestJournalLink());
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      await assertRejectsInvalid(c.install(INSTALL_INPUT));
      assert.equal(harness.sentinels().readJournal, 1, 'terminal closeout must reread its journal');
      assert.ok(
        indexOfEvent(harness.trace(), 'receipt') < harness.trace().lastIndexOf('journal'),
        'terminal journal reread must happen after receipt publication',
      );
      assert.equal(countEvents(harness.trace(), 'lock-release'), 0);
      assert.deepEqual(harness.lockState(), {
        transactionLock: true,
        manualInterventionLock: false,
      });
    });

    test('first install label-in-use/unknown blocks after prepared with zero mutation', async (t) => {
      const cases = [
        ['controller loaded', (h) => h.seedLoadedJob('controller', { foreign: true })],
        ['scheduler loaded', (h) => h.seedLoadedJob('scheduler', { foreign: true })],
        ['controller unknown', (h) => h.setProbeMode('controller', 'unknown')],
        ['scheduler unknown', (h) => h.setProbeMode('scheduler', 'unknown')],
      ];
      for (const [name, prepare] of cases) {
        await t.test(name, async () => {
          const harness = createLaunchAgentLifecycleHarness();
          prepare(harness);
          const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
          const result = await c.install(INSTALL_INPUT);
          const receipt = assertTerminalCloseout(harness, result, {
            state: 'blocked',
            outcome: 'label-in-use',
            success: false,
          });
          assert.equal(receipt.hostMutationCount, 0);
          assert.deepEqual(harness.journalStates(receipt.transactionId), ['prepared', 'blocked']);
          assertZeroHostMutation(harness, name);
        });
      }
    });

    test('plist lint invalid blocks before any host mutation', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.setPlistLintValid('controller', false);
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.install(INSTALL_INPUT);
      const r = validateLaunchAgentReceipt(result);
      assert.equal(r.state, 'blocked');
      assert.equal(r.success, false);
      assert.equal(r.hostMutationCount, 0);
      assertPreparedFirst(harness, r.transactionId);
      assert.equal(harness.journalStates(r.transactionId).at(-1), 'blocked');
      const stored = harness.receiptFor(r.transactionId);
      assert.ok(stored !== null);
      assert.deepEqual(r, stored);
      assertZeroHostMutation(harness, 'plist lint');
      assert.equal(countEvents(harness.trace(), 'publish-controller'), 0);
      assert.ok(harness.sentinels().plistValidate >= 1);
      const trace = harness.trace();
      assert.ok(trace.lastIndexOf('receipt') < trace.lastIndexOf('lock-release'));
    });

    test('first install first publish mismatch blocks with prepared then blocked', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.failNext('publish-controller');
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.install(INSTALL_INPUT);
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'blocked',
        outcome: 'conditional-mutation-mismatch',
        success: false,
      });
      assert.equal(receipt.hostMutationCount, 0);
      assert.ok(harness.journalStates(receipt.transactionId).includes('prepared'));
      assert.equal(harness.journalStates(receipt.transactionId).at(-1), 'blocked');
      assert.deepEqual(harness.compensationEvents(), []);
      assertZeroHostMutation(harness, 'first publish mismatch');
    });

    // ----- managed upgrade / no-change -----

    test('managed upgrade stops scheduler first; only changed roles publish', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      const before = harness.hostSnapshot();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      // 双 profile 均变：同时改 controllerEnvironment + scheduleSeconds（sourceCommit 不改 plist）
      const result = await c.managedUpgrade(upgradeInput({
        sourceCommit: COMMIT_B,
        scheduleSeconds: 600,
        controllerEnvironment: { PORT: '9090' },
      }));
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'committed',
        outcome: 'completed',
        success: true,
      });
      assert.equal(receipt.operation, 'managed-upgrade');
      assertJournalOperation(harness, receipt.transactionId, 'managed-upgrade');
      assert.deepEqual(harness.journalStates(receipt.transactionId), [...UPGRADE_JOURNAL]);

      const trace = harness.trace();
      assertGateAndPreparedOrder(harness, { terminalHeadCount: 1 });
      assert.ok(
        indexOfEvent(trace, 'bootout-scheduler') < indexOfEvent(trace, 'bootout-controller'),
      );
      assert.ok(
        indexOfEvent(trace, 'bootstrap-controller') < indexOfEvent(trace, 'health-controller'),
      );
      assert.ok(
        indexOfEvent(trace, 'health-controller') < indexOfEvent(trace, 'bootstrap-scheduler'),
      );
      assert.equal(countEvents(trace, 'remove-controller'), 0);

      const anchor = harness.anchorFor(receipt.anchorId);
      assert.equal(anchor.purpose, 'managed-upgrade');
      assert.deepEqual(anchor.loaded, { controller: true, scheduler: true });
      assert.equal(anchor.controller.sha256, seed.controllerSha256);

      const after = harness.hostSnapshot();
      assert.notEqual(after.controller.sha256, before.controller.sha256);
      assert.notEqual(after.controller.inode, before.controller.inode);
      assert.notEqual(after.scheduler.sha256, before.scheduler.sha256);
      assert.deepEqual(after.loaded, { controller: true, scheduler: true });
      // 2 bootout + 3 publish + 2 bootstrap
      assert.equal(harness.sentinels().hostMutationCount, 7);
      assert.equal(receipt.hostMutationCount, 7);
    });

    test('P1-2 replace CAS requires full identity and proves a real identity transition', async (t) => {
      await t.test('strict expected identity succeeds and changed files get new device/inode identity', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        harness.seedInstalled({ sourceCommit: COMMIT_A });
        harness.resetObservations();
        const before = harness.hostSnapshot();
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        const result = await c.managedUpgrade(upgradeInput({
          scheduleSeconds: 600,
          controllerEnvironment: { PORT: '9090' },
        }));
        const receipt = assertTerminalCloseout(harness, result, {
          state: 'committed', outcome: 'completed', success: true,
        });
        const after = harness.hostSnapshot();
        assert.notEqual(after.controller.inode, before.controller.inode);
        assert.notEqual(after.scheduler.inode, before.scheduler.inode);
        for (const attempt of harness.atomicExpectedAttempts()) {
          assert.deepEqual(attempt.keys, [...FULL_IDENTITY_KEYS]);
        }
        assert.equal(receipt.hostMutationCount, harness.sentinels().hostMutationCount);
      });

      await t.test('replace INVALID propagates after one full-identity attempt without downgrade retry', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        harness.seedInstalled({ sourceCommit: COMMIT_A });
        harness.resetObservations();
        harness.failNextAtomicExpectedValidation('replace', 'controller');
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        await assertRejectsInvalid(c.managedUpgrade(upgradeInput({
          sourceCommit: COMMIT_A,
          controllerEnvironment: { PORT: '9090' },
        })));
        const attempts = harness.atomicExpectedAttempts()
          .filter((attempt) => attempt.operation === 'replace' && attempt.role === 'controller');
        assert.deepEqual(attempts, [{
          operation: 'replace', role: 'controller', keys: [...FULL_IDENTITY_KEYS],
        }], 'INVALID must not trigger a legacy three-field retry');
      });

      await t.test('remove INVALID enters MIR after one full-identity attempt without downgrade retry', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        harness.failNextAtomicExpectedValidation('remove', 'controller');
        harness.failNext('publish-scheduler');
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        const result = await c.install(INSTALL_INPUT);
        const projection = validateLaunchAgentReceipt(result);
        assert.equal(projection.state, 'manual-intervention-required');
        assert.equal(projection.outcome, 'manual-intervention-required');
        const attempts = harness.atomicExpectedAttempts()
          .filter((attempt) => attempt.operation === 'remove' && attempt.role === 'controller');
        assert.deepEqual(attempts, [{
          operation: 'remove', role: 'controller', keys: [...FULL_IDENTITY_KEYS],
        }], 'INVALID must not trigger a legacy three-field retry');
      });

      await t.test('manifest-only replace always sends one full-identity expectation', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        harness.seedInstalled({ sourceCommit: COMMIT_A });
        harness.resetObservations();
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        let result = null;
        let failure = null;
        try {
          result = await c.managedUpgrade(upgradeInput({ sourceCommit: COMMIT_B }));
        } catch (error) {
          failure = error;
        }
        const attempts = harness.atomicExpectedAttempts()
          .filter((attempt) => attempt.operation === 'replace' && attempt.role === 'manifest');
        assert.deepEqual(attempts, [{
          operation: 'replace', role: 'manifest', keys: [...FULL_IDENTITY_KEYS],
        }]);
        if (failure !== null) throw failure;
        assertTerminalCloseout(harness, result, {
          state: 'committed', outcome: 'completed', success: true,
        });
      });

      await t.test('publisher success with unchanged device/inode cannot be committed', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
        harness.resetObservations();
        harness.forgeNextReplaceSuccessWithoutMutation('controller');
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        const result = await c.managedUpgrade(upgradeInput({
          sourceCommit: COMMIT_A,
          controllerEnvironment: { PORT: '9090' },
        }));
        const receipt = assertTerminalCloseout(harness, result, {
          state: 'recovered', outcome: 'conditional-mutation-mismatch', success: false,
        });
        assert.equal(receipt.hostMutationCount, 4);
        assert.equal(harness.sentinels().hostMutationCount, 4);
        assert.equal(harness.hostSnapshot().controller.sha256, seed.controllerSha256);
      });
    });

    test('final-review publisher mutation with corrupt post hash cannot close blocked count=0', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.corruptNextPublishedIdentityAfterMutation('controller', 'bad-sha256');
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      const result = await c.install(INSTALL_INPUT);
      const projection = assertManualInterventionHandoff(harness, result);
      assert.ok(projection.hostMutationCount >= 1, 'actual publisher mutation must be counted');
      assert.equal(harness.sentinels().publish, 1, 'harness performed one real file mutation');
      assert.notEqual(harness.fileBytes('controller'), null, 'mutated file remains safety-relevant');
      assert.equal(countEvents(harness.trace(), 'lock-release'), 0);
    });

    test('final-review publisher three-field post identity is rejected and never committed', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      harness.corruptNextPublishedIdentityAfterMutation('manifest', 'three-field');
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      let result = null;
      let failure = null;
      try {
        result = await c.managedUpgrade(upgradeInput({ sourceCommit: COMMIT_B }));
      } catch (error) {
        failure = error;
      }

      if (failure !== null) {
        assertLifecycleInvalid(failure);
        assert.deepEqual(harness.lockState(), {
          transactionLock: true,
          manualInterventionLock: false,
        });
      } else {
        assertManualInterventionHandoff(harness, result);
      }
      assert.equal(harness.sentinels().publish, 1, 'three-field reply follows an actual replace');
      assert.equal(
        JSON.parse(harness.fileBytes('manifest').toString('utf8')).sourceCommit,
        COMMIT_B,
      );
    });

    test('final-review possible publisher mutations survive an unreadable post-publish inspect', async (t) => {
      const cases = [
        ['three-field identity', (identity) => ({
          device: identity.device,
          inode: identity.inode,
          sha256: identity.sha256,
        })],
        ['corrupt sha256', (identity) => ({ ...identity, sha256: 'f'.repeat(64) })],
      ];

      for (const [name, corruptIdentity] of cases) {
        await t.test(`${name} is conservatively counted and enters MIR`, async () => {
          const harness = createLaunchAgentLifecycleHarness();
          const dependencies = harness.dependencies();
          let postPublishInspectArmed = false;
          const c = createLaunchAgentLifecycleCoordinator({
            ...dependencies,
            atomicPublisher: {
              ...dependencies.atomicPublisher,
              async publishAbsent(input) {
                const result = await dependencies.atomicPublisher.publishAbsent(input);
                postPublishInspectArmed = true;
                return result;
              },
            },
            hostInspector: {
              ...dependencies.hostInspector,
              async inspect(input) {
                const identity = await dependencies.hostInspector.inspect(input);
                if (!postPublishInspectArmed) return identity;
                postPublishInspectArmed = false;
                return corruptIdentity(identity);
              },
            },
          });

          const result = await c.install(INSTALL_INPUT);
          const projection = assertManualInterventionHandoff(harness, result);
          assert.ok(
            projection.hostMutationCount >= 1,
            'publisher outcome=ok makes the mutation count conservatively non-zero',
          );
          assert.equal(harness.sentinels().publish, 1);
          assert.notEqual(harness.fileBytes('controller'), null);
          assert.equal(countEvents(harness.trace(), 'lock-release'), 0);
        });
      }
    });

    test('P1-3 runtime-artifact-only upgrade restarts jobs instead of manifest-only commit', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      harness.setRuntimeArtifactSha256('agent', 'd4'.repeat(32));
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      const result = await c.managedUpgrade(upgradeInput({ sourceCommit: COMMIT_A }));
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'committed', outcome: 'completed', success: true,
      });
      assert.equal(countEvents(harness.trace(), 'publish-controller'), 0);
      assert.equal(countEvents(harness.trace(), 'publish-scheduler'), 0);
      assert.equal(countEvents(harness.trace(), 'publish-manifest'), 1);
      assert.equal(countEvents(harness.trace(), 'bootout-controller'), 1);
      assert.equal(countEvents(harness.trace(), 'bootout-scheduler'), 1);
      assert.equal(countEvents(harness.trace(), 'bootstrap-controller'), 1);
      assert.equal(countEvents(harness.trace(), 'bootstrap-scheduler'), 1);
      assert.equal(harness.hostSnapshot().controller.sha256, seed.controllerSha256);
      assert.equal(harness.hostSnapshot().scheduler.sha256, seed.schedulerSha256);
      assert.equal(
        JSON.parse(harness.fileBytes('manifest').toString('utf8')).runtimeArtifacts.agent.sha256,
        'd4'.repeat(32),
      );
      assert.equal(receipt.hostMutationCount, 5);
    });

    test('P2-1 managed ownership requires the manifest active anchor to exist and validate', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.deleteAnchorFor(seed.anchorId);
      harness.resetObservations();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      const result = await c.managedUpgrade(upgradeInput({ sourceCommit: COMMIT_B }));
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'blocked', outcome: 'ownership-mismatch', success: false,
      });
      assert.ok(harness.sentinels().readAnchor >= 1, 'active anchor must be read from durable store');
      assert.equal(receipt.hostMutationCount, 0);
      assertZeroHostMutation(harness, 'missing active anchor');
    });

    test('install internal managed-upgrade mode keeps one transaction operation=install', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      const result = await c.install({ ...INSTALL_INPUT, sourceCommit: COMMIT_B });
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'committed', outcome: 'completed', success: true,
      });
      assert.notEqual(receipt.transactionId, seed.transactionId);
      assert.equal(receipt.operation, 'install');
      assertJournalOperation(harness, receipt.transactionId, 'install');
      assertGateAndPreparedOrder(harness, { terminalHeadCount: 1 });
      assert.equal(harness.anchorFor(receipt.anchorId).purpose, 'managed-upgrade');
      assert.equal(harness.sentinels().readJournalHeads, 2, 'no second heads gate/re-entry');
      assert.equal(countEvents(harness.trace(), 'lock-acquire'), 1, 'one transaction lock only');
      assert.equal(countEvents(harness.trace(), 'lock-release'), 1, 'one transaction closeout only');
      assert.equal(countEvents(harness.trace(), 'publish-controller'), 0);
      assert.equal(countEvents(harness.trace(), 'publish-scheduler'), 0);
      assert.equal(countEvents(harness.trace(), 'publish-manifest'), 1);
    });

    test('profileRenderer: env→controller only; schedule→scheduler only; commit→manifest only', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const seed = harness.seedInstalled({
        sourceCommit: COMMIT_A,
        scheduleSeconds: SCHEDULE,
        controllerEnvironment: {},
      });
      harness.resetObservations();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      // 仅 controllerEnvironment 变化
      const r1 = await c.managedUpgrade(upgradeInput({
        sourceCommit: COMMIT_A,
        controllerEnvironment: { PORT: '8080' },
      }));
      const receipt1 = assertTerminalCloseout(harness, r1, {
        state: 'committed', outcome: 'completed', success: true,
      });
      assert.equal(countEvents(harness.trace(), 'publish-controller'), 1);
      assert.equal(countEvents(harness.trace(), 'publish-scheduler'), 0);
      const noop1 = harness.journalEntries(receipt1.transactionId)
        .filter((e) => e.state === 'role-noop');
      assert.equal(noop1.length, 1);
      assert.equal(noop1[0].payload.role, 'scheduler');
      assert.equal(harness.hostSnapshot().scheduler.sha256, seed.schedulerSha256);
      assert.deepEqual(receipt1.roles.scheduler, {
        label: LABEL_S, outcome: 'unchanged', changed: false,
      });

      // 再 seed 后仅 scheduleSeconds 变化
      const harness2 = createLaunchAgentLifecycleHarness();
      const seed2 = harness2.seedInstalled({ sourceCommit: COMMIT_A });
      harness2.resetObservations();
      const c2 = createLaunchAgentLifecycleCoordinator(harness2.dependencies());
      const r2 = await c2.managedUpgrade(upgradeInput({
        sourceCommit: COMMIT_A,
        scheduleSeconds: 900,
      }));
      const receipt2 = assertTerminalCloseout(harness2, r2, {
        state: 'committed', outcome: 'completed', success: true,
      });
      assert.equal(countEvents(harness2.trace(), 'publish-scheduler'), 1);
      assert.equal(countEvents(harness2.trace(), 'publish-controller'), 0);
      assert.equal(harness2.hostSnapshot().controller.sha256, seed2.controllerSha256);
      assert.deepEqual(receipt2.roles.controller, {
        label: LABEL_C, outcome: 'unchanged', changed: false,
      });

      // 仅 sourceCommit 变化：必须 committed + manifest-only，禁止 no-change。
      const harness3 = createLaunchAgentLifecycleHarness();
      harness3.seedInstalled({ sourceCommit: COMMIT_A });
      harness3.resetObservations();
      const before3 = harness3.hostSnapshot();
      const c3 = createLaunchAgentLifecycleCoordinator(harness3.dependencies());
      const r3 = await c3.managedUpgrade(upgradeInput({ sourceCommit: COMMIT_B }));
      const receipt3 = assertTerminalCloseout(harness3, r3, {
        state: 'committed', outcome: 'completed', success: true,
      });
      assert.equal(receipt3.operation, 'managed-upgrade');
      assertJournalOperation(harness3, receipt3.transactionId, 'managed-upgrade');
      assert.equal(countEvents(harness3.trace(), 'publish-controller'), 0);
      assert.equal(countEvents(harness3.trace(), 'publish-scheduler'), 0);
      assert.equal(countEvents(harness3.trace(), 'publish-manifest'), 1);
      const sentinels3 = harness3.sentinels();
      assert.equal(receipt3.hostMutationCount, 1);
      assert.equal(sentinels3.hostMutationCount, 1);
      assert.equal(sentinels3.publish, 1);
      assert.equal(sentinels3.remove, 0);
      assert.equal(sentinels3.bootout, 0);
      assert.equal(sentinels3.bootstrap, 0);
      const after3 = harness3.hostSnapshot();
      assert.deepEqual(after3.controller, before3.controller);
      assert.deepEqual(after3.scheduler, before3.scheduler);
      assert.deepEqual(after3.loaded, before3.loaded);
      assert.deepEqual(after3.jobIdentity, before3.jobIdentity);
      assert.equal(
        JSON.parse(harness3.fileBytes('manifest').toString('utf8')).sourceCommit,
        COMMIT_B,
      );
      assert.deepEqual(
        harness3.publishedCandidateRefs().map((ref) => ref.role),
        ['manifest'],
      );
    });

    test('managed upgrade all-identical closes no-change after prepared, count=0', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      const before = harness.hostSnapshot();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.managedUpgrade(upgradeInput({ sourceCommit: COMMIT_A }));
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'no-change',
        outcome: 'no-change',
        success: true,
      });
      assert.equal(receipt.hostMutationCount, 0);
      assert.deepEqual(harness.journalStates(receipt.transactionId), ['prepared', 'no-change']);
      assertZeroHostMutation(harness, 'no-change');
      assert.deepEqual(harness.hostSnapshot().controller, before.controller);
      assert.deepEqual(receipt.roles, {
        controller: { label: LABEL_C, outcome: 'unchanged', changed: false },
        scheduler: { label: LABEL_S, outcome: 'unchanged', changed: false },
      });
    });

    test('upgrade post-lock identity drift blocks before any host mutation', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      harness.afterEvent('lock-acquire', () => harness.driftHostFile('controller'));
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.managedUpgrade(upgradeInput());
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'blocked',
        outcome: 'ownership-mismatch',
        success: false,
      });
      assert.equal(receipt.hostMutationCount, 0);
      assert.deepEqual(harness.journalStates(receipt.transactionId).slice(0, 2), [
        'prepared', 'blocked',
      ]);
      assertZeroHostMutation(harness, 'drift');
    });

    // ----- stop -----

    test('schema-illegal stop anchor is rejected by production validator before mutation', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      const illegalAnchor = harness.plausibleInvalidStopAnchor(COMMIT_A);
      assert.equal(Object.getPrototypeOf(illegalAnchor), Object.prototype);
      assert.equal(illegalAnchor.purpose, 'stop');
      assert.equal(typeof illegalAnchor.anchorId, 'string');
      assert.equal(illegalAnchor.unexpected, true);
      harness.overrideNextAnchor(illegalAnchor);

      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      await assertRejectsInvalid(c.stop({ sourceCommit: COMMIT_A }));

      assert.ok(
        harness.adapterCalls().some((call) => call.name === 'write-anchor'),
        'stop path must invoke metadataStore.writeAnchor production validation seam',
      );
      assert.equal(harness.sentinels().writeCandidate, 0);
      assert.equal(harness.sentinels().plistValidate, 0);
      assertZeroHostMutation(harness, 'illegal stop anchor');
    });

    test('stop bootouts owned loaded jobs scheduler-first; preserves bytes', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      const before = harness.hostSnapshot();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.stop({ sourceCommit: COMMIT_A });
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'committed',
        outcome: 'completed',
        success: true,
      });
      assert.equal(receipt.operation, 'stop');
      assertJournalOperation(harness, receipt.transactionId, 'stop');
      assertGateAndPreparedOrder(harness, {
        requiresCandidates: false,
        terminalHeadCount: 1,
      });
      assert.deepEqual(harness.journalStates(receipt.transactionId), [...STOP_JOURNAL]);
      const trace = harness.trace();
      assert.ok(
        indexOfEvent(trace, 'bootout-scheduler') < indexOfEvent(trace, 'bootout-controller'),
      );
      for (const name of [
        'publish-controller', 'publish-scheduler', 'publish-manifest',
        'remove-controller', 'remove-scheduler', 'remove-manifest',
      ]) {
        assert.equal(countEvents(trace, name), 0);
      }
      const after = harness.hostSnapshot();
      assert.deepEqual(after.controller, before.controller);
      assert.deepEqual(after.scheduler, before.scheduler);
      assert.deepEqual(after.manifest, before.manifest);
      assert.equal(after.controller.sha256, seed.controllerSha256);
      assert.deepEqual(after.loaded, { controller: false, scheduler: false });
      assert.deepEqual(receipt.roles, {
        controller: { label: LABEL_C, outcome: 'unloaded', changed: true },
        scheduler: { label: LABEL_S, outcome: 'unloaded', changed: true },
      });
      assert.equal(harness.sentinels().bootout, 2);
      assert.equal(harness.sentinels().hostMutationCount, 2);
      const anchor = harness.anchorFor(receipt.anchorId);
      assert.equal(anchor.purpose, 'stop');
      assert.deepEqual(anchor.loaded, { controller: true, scheduler: true });
    });

    test('repeated stop writes stop-noop without launchctl mutation', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({
        sourceCommit: COMMIT_A,
        loaded: { controller: false, scheduler: false },
      });
      harness.resetObservations();
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const first = await c.stop({ sourceCommit: COMMIT_A });
      const r1 = assertTerminalCloseout(harness, first, {
        state: 'committed', outcome: 'completed', success: true,
      });
      assert.deepEqual(harness.journalStates(r1.transactionId), [
        'prepared', 'anchored', 'role-stop-noop', 'role-stop-noop', 'committed',
      ]);
      const noopRoles = harness.journalEntries(r1.transactionId)
        .filter((e) => e.state === 'role-stop-noop')
        .map((e) => e.payload.role);
      assert.deepEqual(noopRoles, ['scheduler', 'controller']);
      assertZeroHostMutation(harness, 'stop-noop');

      harness.resetObservations();
      const second = await c.stop({ sourceCommit: COMMIT_A });
      const r2 = assertTerminalCloseout(harness, second, {
        state: 'committed', outcome: 'completed', success: true,
      });
      assert.notEqual(r2.transactionId, r1.transactionId);
      assertZeroHostMutation(harness, 'double stop');
    });

    test('P2-2 stop no-op performs a fresh probe and rejects post-anchor foreign load', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({
        sourceCommit: COMMIT_A,
        loaded: { controller: false, scheduler: false },
      });
      harness.resetObservations();
      harness.afterEvent('anchor', () => {
        harness.seedLoadedJob('scheduler', { foreign: true });
      });
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      const result = await c.stop({ sourceCommit: COMMIT_A });
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'blocked', outcome: 'ownership-mismatch', success: false,
      });
      assert.ok(harness.sentinels().print >= 3, 'scheduler no-op requires a post-anchor probe');
      assert.equal(
        harness.journalEntries(receipt.transactionId)
          .some((entry) => entry.state === 'role-stop-noop' && entry.payload.role === 'scheduler'),
        false,
      );
      assertZeroHostMutation(harness, 'foreign load after stop anchor');
      assert.equal(harness.hostSnapshot().jobIdentity.scheduler, 'f'.repeat(64));
    });

    test('final-review stop performs a final dual-label probe after the role loop', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      let driftInjected = false;
      harness.afterEvent('verify-job-controller', () => {
        driftInjected = true;
        harness.seedLoadedJob('scheduler', { foreign: true });
      });
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      const result = await c.stop({ sourceCommit: COMMIT_A });
      const projection = validateLaunchAgentReceipt(result);
      assert.equal(driftInjected, true, 'late scheduler race must occur after controller stop verify');
      assert.notEqual(projection.state, 'committed');
      assert.equal(projection.success, false);
      assert.equal(harness.hostSnapshot().loaded.scheduler, true);
      assert.equal(harness.hostSnapshot().jobIdentity.scheduler, 'f'.repeat(64));
      assert.ok(harness.sentinels().print >= 8, 'stop needs a final fresh probe of both labels');
    });

    test('stop never bootouts unproven ownership; incomplete bootout is recovered', async (t) => {
      await t.test('foreign job', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        harness.seedInstalled({
          sourceCommit: COMMIT_A,
          foreign: { controller: true, scheduler: false },
        });
        harness.resetObservations();
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
        const result = await c.stop({ sourceCommit: COMMIT_A });
        const receipt = assertTerminalCloseout(harness, result, {
          state: 'blocked',
          outcome: 'ownership-mismatch',
          success: false,
        });
        assert.equal(receipt.hostMutationCount, 0);
        assertZeroHostMutation(harness, 'foreign');
        assert.equal(harness.hostSnapshot().loaded.controller, true);
        assert.equal(harness.hostSnapshot().jobIdentity.controller, 'f'.repeat(64));
      });

      await t.test('bootout leaves loaded → recovered stop-incomplete count>0', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
        harness.resetObservations();
        harness.failNext('bootout-scheduler');
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
        const result = await c.stop({ sourceCommit: COMMIT_A });
        const receipt = assertTerminalCloseout(harness, result, {
          state: 'recovered',
          outcome: 'stop-incomplete',
          success: false,
        });
        const trace = harness.trace();
        assert.equal(countEvents(trace, 'bootout-scheduler'), 1);
        assert.equal(countEvents(trace, 'bootout-controller'), 0);
        // 已发出 bootout ⇒ hostMutationCount > 0；不继续自动 mutation
        assert.ok(receipt.hostMutationCount > 0);
        assert.equal(harness.sentinels().bootout, 1);
        assert.equal(harness.sentinels().bootstrap, 0);
        assert.equal(harness.sentinels().publish, 0);
        const after = harness.hostSnapshot();
        assert.deepEqual(after.loaded, { controller: true, scheduler: true });
        assert.equal(after.controller.sha256, seed.controllerSha256);
      });
    });

    test('final-review stop partially completed bootout uses one bounded reverse plan', async (t) => {
      await t.test('scheduler is restored after controller bootout fails', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
        harness.resetObservations();
        harness.failNext('bootout-controller');
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        const result = await c.stop({ sourceCommit: COMMIT_A });
        const receipt = assertTerminalCloseout(harness, result, {
          state: 'recovered', outcome: 'stop-incomplete', success: false,
        });
        assertSingleCompensationPlan(harness, receipt.transactionId);
        const compensating = harness.journalEntries(receipt.transactionId)
          .find((entry) => entry.state === 'compensating');
        assert.deepEqual(
          compensating.payload.reversePlan.map((step) => step.action),
          ['load-scheduler'],
        );
        assertCompensationSequence(harness, ['load-scheduler']);
        const after = harness.hostSnapshot();
        assert.deepEqual(after.loaded, { controller: true, scheduler: true });
        assert.equal(after.jobIdentity.controller, seed.controllerSha256);
        assert.equal(after.jobIdentity.scheduler, seed.schedulerSha256);
      });

      await t.test('scheduler restoration failure still hands off to MIR', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        harness.seedInstalled({ sourceCommit: COMMIT_A });
        harness.resetObservations();
        harness.failNext('bootout-controller');
        harness.failNext('bootstrap-scheduler');
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        const result = await c.stop({ sourceCommit: COMMIT_A });
        const projection = assertManualInterventionHandoff(harness, result);
        assertSingleCompensationPlan(harness, projection.transactionId);
        assert.deepEqual(
          harness.compensationEvents(),
          [compEvent('load-scheduler', 'intent')],
        );
        assert.deepEqual(harness.hostSnapshot().loaded, {
          controller: true,
          scheduler: false,
        });
        assert.equal(countEvents(harness.trace(), 'lock-release'), 0);
      });
    });

    // ----- compensation -----

    test('final-review recovered compensation requires one fresh union verification', async (t) => {
      const cases = [
        ['three-file set', (harness) => harness.driftHostFile('manifest')],
        ['dual-job set', (harness) => harness.seedLoadedJob('scheduler', { foreign: true })],
        ['active anchor', (harness, seed) => harness.deleteAnchorFor(seed.anchorId)],
        ['runtime binding', (harness) => harness.setRuntimeArtifactSha256('agent', 'e5'.repeat(32))],
      ];

      for (const [name, injectDrift] of cases) {
        await t.test(`${name} drift after last compensation action enters MIR`, async () => {
          const harness = createLaunchAgentLifecycleHarness();
          const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
          harness.resetObservations();
          harness.failNext('bootstrap-scheduler');
          let driftInjected = false;
          harness.afterCompensationEvent('load-scheduler', 'completed', () => {
            driftInjected = true;
            injectDrift(harness, seed);
          });
          const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

          const result = await c.managedUpgrade(upgradeInput({
            scheduleSeconds: 600,
            controllerEnvironment: { PORT: '9090' },
          }));
          assert.equal(driftInjected, true, 'drift must occur after the durable final action');
          assertManualInterventionHandoff(harness, result);
          if (name === 'runtime binding') {
            assert.ok(
              harness.sentinels().revalidateMarks.includes('compensate-before-close'),
              'recovered closeout must revalidate runtime binding',
            );
          }
        });
      }
    });

    test('final-review compensating journal freezes a durable evidence-bound reverse plan', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      harness.failNext('bootstrap-scheduler');
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      const result = await c.managedUpgrade(upgradeInput({
        scheduleSeconds: 600,
        controllerEnvironment: { PORT: '9090' },
      }));
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'recovered', outcome: 'scheduler-load-failed', success: false,
      });
      const entries = harness.journalEntries(receipt.transactionId);
      const compensating = entries.find((entry) => entry.state === 'compensating');
      assert.ok(compensating, 'compensating entry must be durable');
      assert.deepEqual(
        Object.keys(compensating.payload).sort(),
        ['hostMutationCount', 'reversePlan', 'reversePlanSha256'],
      );
      const plan = compensating.payload.reversePlan;
      assert.ok(Array.isArray(plan) && plan.length > 0, 'reversePlan must be non-empty');
      assert.equal(Object.isFrozen(plan), true, 'persisted reversePlan must be frozen');
      assert.deepEqual(plan.map((item) => item.action), [
        'stop-controller',
        'restore-manifest', 'restore-scheduler', 'restore-controller',
        'load-controller', 'load-scheduler',
      ]);
      assert.deepEqual(plan.map((item) => item.index), [0, 1, 2, 3, 4, 5]);
      for (const item of plan) {
        assert.deepEqual(
          Object.keys(item).sort(),
          ['action', 'evidence', 'expectedPost', 'expectedPre', 'index', 'role'],
        );
        assert.deepEqual(Object.keys(item.expectedPre).sort(), ['file', 'job']);
        assert.deepEqual(Object.keys(item.expectedPost).sort(), ['file', 'job']);
        assert.ok(item.evidence.kind === 'candidate' || item.evidence.kind === 'anchor');
        const evidenceKeys = item.evidence.kind === 'candidate'
          ? ['kind', 'role', 'sha256', 'transactionId']
          : ['anchorId', 'kind', 'loaded', 'role', 'sha256'];
        assert.deepEqual(Object.keys(item.evidence).sort(), evidenceKeys);
      }
      assert.equal(
        compensating.payload.reversePlanSha256,
        harness.sha256(Buffer.from(JSON.stringify(plan), 'utf8')),
      );

      const intents = entries.filter((entry) => (
        entry.state.startsWith('compensate-') && entry.state.endsWith('-intent')
      ));
      assert.equal(intents.length, plan.length);
      for (const [index, intent] of intents.entries()) {
        assert.deepEqual(
          Object.keys(intent.payload).sort(),
          ['action', 'hostMutationCount', 'planIndex', 'reversePlanSha256'],
        );
        assert.equal(intent.payload.planIndex, index);
        assert.equal(intent.payload.action, plan[index].action);
        assert.equal(
          intent.payload.reversePlanSha256,
          compensating.payload.reversePlanSha256,
        );
      }
      const trace = harness.trace();
      const firstIntent = trace.findIndex((event) => (
        typeof event === 'object' && event.kind === 'compensation' && event.phase === 'intent'
      ));
      assert.ok(firstIntent > 0 && trace.slice(0, firstIntent).includes('journal'));
      const compensationBootout = trace.findIndex((event, index) => (
        index > firstIntent && event === 'bootout-controller'
      ));
      assert.ok(compensationBootout > firstIntent);
    });

    test('final-review every durable compensation intent performs a fresh union precheck', async (t) => {
      const cases = [
        ['stop-controller', (harness) => harness.seedLoadedJob('controller', { foreign: true })],
        ['restore-manifest', (harness) => harness.driftHostFile('controller')],
        ['restore-scheduler', (harness) => {
          const rollbackAnchor = harness.anchorsWritten().at(-1);
          harness.deleteAnchorFor(rollbackAnchor.anchorId);
        }],
        ['restore-controller', (harness) => {
          harness.setRuntimeArtifactSha256('agent', 'e6'.repeat(32));
        }],
        ['load-controller', (harness) => {
          harness.seedLoadedJob('scheduler', { foreign: true });
        }],
        ['load-scheduler', (harness) => harness.driftHostFile('manifest')],
      ];

      for (const [action, injectDrift] of cases) {
        await t.test(`${action} rejects union drift before any new host mutation`, async () => {
          const harness = createLaunchAgentLifecycleHarness();
          harness.seedInstalled({ sourceCommit: COMMIT_A });
          harness.resetObservations();
          harness.failNext('bootstrap-scheduler');
          let hookReached = false;
          let mutationCountAtIntent = null;
          let bootoutCountAtIntent = null;
          harness.afterCompensationEvent(action, 'intent', () => {
            hookReached = true;
            const sentinels = harness.sentinels();
            mutationCountAtIntent = sentinels.hostMutationCount;
            bootoutCountAtIntent = sentinels.bootout;
            injectDrift(harness);
          });
          const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

          const result = await c.managedUpgrade(upgradeInput({
            scheduleSeconds: 600,
            controllerEnvironment: { PORT: '9090' },
          }));
          assert.equal(hookReached, true, `${action} intent hook must be reached`);
          const projection = assertManualInterventionHandoff(harness, result);
          assert.equal(
            projection.hostMutationCount,
            mutationCountAtIntent,
            `${action} must not issue its host mutation after union mismatch`,
          );
          assert.equal(harness.sentinels().hostMutationCount, mutationCountAtIntent);
          assert.equal(
            harness.compensationEvents().some((event) => (
              event.action === action && event.phase === 'completed'
            )),
            false,
            `${action} cannot be completed after failed expectedPre`,
          );
          if (action === 'stop-controller') {
            assert.equal(harness.sentinels().bootout, bootoutCountAtIntent);
            assert.equal(harness.hostSnapshot().loaded.controller, true);
            assert.equal(harness.hostSnapshot().jobIdentity.controller, 'f'.repeat(64));
          }
          assert.equal(countEvents(harness.trace(), 'lock-release'), 0);
        });
      }
    });

    test('P1-4 compensation uses fresh observed state and contains non-Flow failures', async (t) => {
      await t.test('upgrade scheduler bootout failure recovers anchor state without raw TypeError', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        harness.seedInstalled({ sourceCommit: COMMIT_A });
        harness.resetObservations();
        harness.failNext('bootout-scheduler');
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        const result = await c.managedUpgrade(upgradeInput({
          scheduleSeconds: 600,
          controllerEnvironment: { PORT: '9090' },
        }));
        const receipt = assertTerminalCloseout(harness, result, {
          state: 'recovered', outcome: 'conditional-mutation-mismatch', success: false,
        });
        assert.equal(receipt.hostMutationCount, 1);
        assert.equal(countEvents(harness.trace(), 'bootout-scheduler'), 1);
        assert.equal(countEvents(harness.trace(), 'bootstrap-controller'), 0);
        assert.equal(countEvents(harness.trace(), 'bootstrap-scheduler'), 0);
        assert.deepEqual(harness.hostSnapshot().loaded, { controller: true, scheduler: true });
      });

      await t.test('unknown scheduler verification enters MIR without speculative compensation mutation', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        harness.seedInstalled({ sourceCommit: COMMIT_A });
        harness.resetObservations();
        harness.enableStrictLaunchctlTransitions();
        harness.failAt('verify-job-scheduler', 2);
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        const result = await c.managedUpgrade(upgradeInput({
          scheduleSeconds: 600,
          controllerEnvironment: { PORT: '9090' },
        }));
        const projection = validateLaunchAgentReceipt(result);
        assert.equal(projection.state, 'manual-intervention-required');
        assert.equal(projection.outcome, 'manual-intervention-required');
        assert.equal(projection.success, false);
        assert.equal(harness.receiptFor(projection.transactionId), null);
        assert.deepEqual(harness.compensationEvents(), []);
        assert.equal(countEvents(harness.trace(), 'bootout-controller'), 1);
        assert.equal(countEvents(harness.trace(), 'bootout-scheduler'), 1);
        assert.equal(countEvents(harness.trace(), 'publish-controller'), 1);
        assert.equal(countEvents(harness.trace(), 'publish-scheduler'), 1);
        assert.equal(countEvents(harness.trace(), 'publish-manifest'), 1);
        assert.equal(countEvents(harness.trace(), 'bootstrap-controller'), 1);
        assert.equal(countEvents(harness.trace(), 'bootstrap-scheduler'), 1);
        assert.deepEqual(harness.lockState(), {
          transactionLock: false,
          manualInterventionLock: true,
        });
      });

      await t.test('before-commit runtime revalidation failure restores the exact anchor', async () => {
        const harness = createLaunchAgentLifecycleHarness();
        const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
        harness.resetObservations();
        harness.failNextRevalidation('before-commit');
        const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        const result = await c.managedUpgrade(upgradeInput({
          scheduleSeconds: 600,
          controllerEnvironment: { PORT: '9090' },
        }));
        const receipt = assertTerminalCloseout(harness, result, {
          state: 'recovered', outcome: 'rollback-runtime-mismatch', success: false,
        });
        assertSingleCompensationPlan(harness, receipt.transactionId);
        assertCompensationSequence(harness, [
          'stop-scheduler', 'stop-controller',
          'restore-manifest', 'restore-scheduler', 'restore-controller',
          'load-controller', 'load-scheduler',
        ]);
        const after = harness.hostSnapshot();
        assert.equal(after.controller.sha256, seed.controllerSha256);
        assert.equal(after.scheduler.sha256, seed.schedulerSha256);
        assert.equal(after.manifest.sha256, seed.manifestSha256);
        assert.deepEqual(after.loaded, { controller: true, scheduler: true });
      });
    });

    test('P1-5 restoration candidate collision is no-clobber and hands off to MIR', async () => {
      const transactionId = '10000000-0000-4000-8000-000000000001';
      const harness = createLaunchAgentLifecycleHarness();
      const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      harness.queueClockIds([
        transactionId,
        '10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000003',
        transactionId,
        '10000000-0000-4000-8000-000000000004',
      ]);
      harness.failNext('bootstrap-scheduler');
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      const result = await c.managedUpgrade(upgradeInput({
        scheduleSeconds: 600,
        controllerEnvironment: { PORT: '9090' },
      }));
      const projection = validateLaunchAgentReceipt(result);
      assert.equal(projection.state, 'manual-intervention-required');
      assert.equal(projection.outcome, 'manual-intervention-required');
      assert.equal(harness.receiptFor(transactionId), null);
      assert.deepEqual(harness.lockState(), {
        transactionLock: false,
        manualInterventionLock: true,
      });
      const forwardCandidates = harness.candidatesWritten();
      assert.equal(forwardCandidates.length, 3);
      assert.deepEqual(
        [...new Set(forwardCandidates.map((candidate) => candidate.transactionId))],
        [transactionId],
      );
      const manifestCandidate = forwardCandidates.find((candidate) => candidate.role === 'manifest');
      assert.equal(manifestCandidate.sha256, harness.hostSnapshot().manifest.sha256);
      assert.notEqual(manifestCandidate.sha256, seed.manifestSha256);
    });

    test('final-review compensation remove ok counts mutation before damaged post-inspect', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.failNext('publish-scheduler');
      const dependencies = harness.dependencies();
      let postRemoveInspectArmed = false;
      const c = createLaunchAgentLifecycleCoordinator({
        ...dependencies,
        atomicPublisher: {
          ...dependencies.atomicPublisher,
          async removeIfMatch(input) {
            const result = await dependencies.atomicPublisher.removeIfMatch(input);
            if (result?.outcome === 'ok') postRemoveInspectArmed = true;
            return result;
          },
        },
        hostInspector: {
          ...dependencies.hostInspector,
          async inspect(input) {
            const identity = await dependencies.hostInspector.inspect(input);
            if (!postRemoveInspectArmed) return identity;
            postRemoveInspectArmed = false;
            return {
              rootId: identity.rootId,
              basename: identity.basename,
              type: identity.type,
            };
          },
        },
      });

      const result = await c.install(INSTALL_INPUT);
      const projection = assertManualInterventionHandoff(harness, result);
      const sentinels = harness.sentinels();
      assert.equal(sentinels.publish, 1, 'forward controller publish actually mutated');
      assert.equal(sentinels.remove, 1, 'compensation remove outcome=ok actually mutated');
      assert.equal(sentinels.hostMutationCount, 2, 'fixture has exactly two host mutations');
      assert.equal(
        projection.hostMutationCount,
        2,
        'MIR count must conservatively include the successful remove call',
      );
      assert.deepEqual(
        harness.compensationEvents(),
        [compEvent('remove-controller', 'intent')],
      );
      assert.equal(harness.hostSnapshot().controller, null);
      assert.equal(countEvents(harness.trace(), 'lock-release'), 0);
    });

    test('final-review compensation restore ok counts mutation before three-field post-inspect', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      harness.failNext('bootstrap-scheduler');
      const dependencies = harness.dependencies();
      let restoreManifestAction = false;
      let postRestoreInspectArmed = false;
      harness.afterCompensationEvent('restore-manifest', 'intent', () => {
        restoreManifestAction = true;
      });
      const c = createLaunchAgentLifecycleCoordinator({
        ...dependencies,
        atomicPublisher: {
          ...dependencies.atomicPublisher,
          async replaceIfMatch(input) {
            const result = await dependencies.atomicPublisher.replaceIfMatch(input);
            if (restoreManifestAction && result?.outcome === 'ok') {
              restoreManifestAction = false;
              postRestoreInspectArmed = true;
            }
            return result;
          },
        },
        hostInspector: {
          ...dependencies.hostInspector,
          async inspect(input) {
            const identity = await dependencies.hostInspector.inspect(input);
            if (!postRestoreInspectArmed) return identity;
            postRestoreInspectArmed = false;
            return {
              device: identity.device,
              inode: identity.inode,
              sha256: identity.sha256,
            };
          },
        },
      });

      const result = await c.managedUpgrade(upgradeInput({
        scheduleSeconds: 600,
        controllerEnvironment: { PORT: '9090' },
      }));
      const projection = assertManualInterventionHandoff(harness, result);
      const sentinels = harness.sentinels();
      assert.equal(sentinels.hostMutationCount, 9, 'fixture has exactly nine host mutations');
      assert.equal(
        projection.hostMutationCount,
        9,
        'MIR count must conservatively include the successful restore publish call',
      );
      assert.deepEqual(harness.compensationEvents(), [
        compEvent('stop-controller', 'intent'),
        compEvent('stop-controller', 'completed'),
        compEvent('restore-manifest', 'intent'),
      ]);
      assert.equal(countEvents(harness.trace(), 'lock-release'), 0);
    });

    test('install compensation freezes reverse plan after publish/load failures', async (t) => {
      const cases = [
        ['scheduler publish', 'publish-scheduler', ['remove-controller'], 'conditional-mutation-mismatch'],
        ['manifest publish', 'publish-manifest', ['remove-scheduler', 'remove-controller'], 'conditional-mutation-mismatch'],
        ['controller bootstrap', 'bootstrap-controller', ['remove-manifest', 'remove-scheduler', 'remove-controller'], 'controller-not-ready'],
        ['controller health', 'health-controller', ['stop-controller', 'remove-manifest', 'remove-scheduler', 'remove-controller'], 'controller-not-ready'],
        ['scheduler bootstrap', 'bootstrap-scheduler', ['stop-controller', 'remove-manifest', 'remove-scheduler', 'remove-controller'], 'scheduler-load-failed'],
      ];
      for (const [name, failEvent, actions, outcome] of cases) {
        await t.test(name, async () => {
          const harness = createLaunchAgentLifecycleHarness();
          harness.failNext(failEvent);
          const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
          const result = await c.install(INSTALL_INPUT);
          const receipt = assertTerminalCloseout(harness, result, {
            state: 'recovered', outcome, success: false,
          });
          assertSingleCompensationPlan(harness, receipt.transactionId);
          assertCompensationSequence(harness, actions);
          const snap = harness.hostSnapshot();
          assert.equal(snap.controller, null);
          assert.equal(snap.scheduler, null);
          assert.equal(snap.manifest, null);
          assert.deepEqual(snap.loaded, { controller: false, scheduler: false });
          if (failEvent === 'bootstrap-controller') {
            assert.equal(countEvents(harness.trace(), 'bootout-controller'), 0);
          }
          if (failEvent === 'health-controller') {
            assert.equal(countEvents(harness.trace(), 'bootout-controller'), 1);
          }
        });
      }
    });

    test('upgrade scheduler load failure: reverse plan restores last-green loaded', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      harness.failNext('bootstrap-scheduler');
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.managedUpgrade(upgradeInput({
        scheduleSeconds: 600,
        controllerEnvironment: { PORT: '1' },
      }));
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'recovered',
        outcome: 'scheduler-load-failed',
        success: false,
      });
      assertSingleCompensationPlan(harness, receipt.transactionId);
      assertCompensationSequence(harness, [
        'stop-controller', 'restore-manifest', 'restore-scheduler',
        'restore-controller', 'load-controller', 'load-scheduler',
      ]);
      assertSubsequence(harness.trace(), [
        compEvent('stop-controller', 'intent'), 'bootout-controller',
        compEvent('stop-controller', 'completed'),
        compEvent('restore-manifest', 'intent'), 'publish-manifest',
        compEvent('restore-manifest', 'completed'),
        compEvent('restore-scheduler', 'intent'), 'publish-scheduler',
        compEvent('restore-scheduler', 'completed'),
        compEvent('restore-controller', 'intent'), 'publish-controller',
        compEvent('restore-controller', 'completed'),
        compEvent('load-controller', 'intent'), 'bootstrap-controller', 'health-controller',
        compEvent('load-controller', 'completed'),
        compEvent('load-scheduler', 'intent'), 'bootstrap-scheduler',
        compEvent('load-scheduler', 'completed'),
        'journal', 'receipt', 'lock-release',
      ], 'highest-risk drill');
      const after = harness.hostSnapshot();
      assert.equal(after.controller.sha256, seed.controllerSha256);
      assert.equal(after.scheduler.sha256, seed.schedulerSha256);
      assert.equal(after.manifest.sha256, seed.manifestSha256);
      assert.deepEqual(after.loaded, { controller: true, scheduler: true });
      assert.equal(after.jobIdentity.controller, seed.controllerSha256);
    });

    test('upgrade compensation from stopped pre-state never starts jobs', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      const seed = harness.seedInstalled({
        sourceCommit: COMMIT_A,
        loaded: { controller: false, scheduler: false },
      });
      harness.resetObservations();
      harness.failNext('health-controller');
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.managedUpgrade(upgradeInput({
        scheduleSeconds: 600,
        controllerEnvironment: { PORT: '1' },
      }));
      const receipt = assertTerminalCloseout(harness, result, {
        state: 'recovered',
        outcome: 'controller-not-ready',
        success: false,
      });
      assertSingleCompensationPlan(harness, receipt.transactionId);
      assertCompensationSequence(harness, [
        'stop-controller', 'restore-manifest', 'restore-scheduler', 'restore-controller',
      ]);
      const trace = harness.trace();
      assert.equal(countEvents(trace, 'bootout-controller'), 1);
      assert.equal(countEvents(trace, 'bootout-scheduler'), 0);
      assert.equal(countEvents(trace, 'bootstrap-controller'), 1);
      assert.equal(countEvents(trace, 'bootstrap-scheduler'), 0);
      const noopRoles = harness.journalEntries(receipt.transactionId)
        .filter((e) => e.state === 'role-stop-noop')
        .map((e) => e.payload.role);
      assert.deepEqual(noopRoles, ['scheduler', 'controller']);
      const after = harness.hostSnapshot();
      assert.equal(after.controller.sha256, seed.controllerSha256);
      assert.deepEqual(after.loaded, { controller: false, scheduler: false });
      assert.deepEqual(after.jobIdentity, { controller: null, scheduler: null });
    });

    test('compensation failure MIR handoff without mir-lock-release or receipt', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      harness.failNext('bootstrap-scheduler');
      harness.failAt('bootout-controller', 2);
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.managedUpgrade(upgradeInput({
        scheduleSeconds: 600,
        controllerEnvironment: { PORT: '1' },
      }));
      const projection = validateLaunchAgentReceipt(result);
      assert.equal(projection.state, 'manual-intervention-required');
      assert.equal(projection.outcome, 'manual-intervention-required');
      assert.equal(projection.success, false);
      assert.equal(harness.receiptFor(projection.transactionId), null);
      assert.equal(harness.journalStates(projection.transactionId).at(-1), 'manual-intervention-required');
      assert.equal(
        harness.journalStates(projection.transactionId).filter((s) => s === 'compensating').length,
        1,
      );
      assert.deepEqual(harness.compensationEvents(), [compEvent('stop-controller', 'intent')]);
      const trace = harness.trace();
      assertSubsequence(trace, [
        'mir-lock-publish', 'mir-lock-verify', 'mir-transaction-lock-release',
      ], 'MIR handoff');
      assert.equal(countEvents(trace, 'receipt'), 0);
      assert.equal(countEvents(trace, 'lock-release'), 0);
      assert.equal(countEvents(trace, 'mir-lock-release'), 0, 'Task 4 does not release mir-lock');
      assert.equal(trace.at(-1), 'mir-transaction-lock-release');
      assert.deepEqual(harness.lockState(), {
        transactionLock: false,
        manualInterventionLock: true,
      });
      assert.equal(harness.hostSnapshot().loaded.controller, true);
      assertNoLeakage(result, 'MIR');
    });

    test('no raw host path/canary leaks into projections', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({ sourceCommit: COMMIT_A });
      harness.resetObservations();
      harness.failNext('bootstrap-scheduler');
      const c = createLaunchAgentLifecycleCoordinator(harness.dependencies());
      const result = await c.managedUpgrade(upgradeInput({
        scheduleSeconds: 600,
        controllerEnvironment: { PORT: '1' },
      }));
      const projection = validateLaunchAgentReceipt(result);
      assertNoLeakage(result, 'result');
      assertNoLeakage(harness.trace(), 'trace');
      assertNoLeakage(harness.journalEntries(projection.transactionId), 'journal');
      const stored = harness.receiptFor(projection.transactionId);
      assert.ok(stored !== null);
      assertNoLeakage(stored, 'receipt');
      assert.equal(harness.sentinels().realLaunchctlCalls, 0);
    });
  }
}
