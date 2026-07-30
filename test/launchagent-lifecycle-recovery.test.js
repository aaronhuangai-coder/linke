/**
 * Linke V1.46 Task 5A.1 RED：rollback / uninstall 的闭合事务契约。
 *
 * 本测试只使用内存 harness；不访问真实 HOME、不调用真实 launchctl，也不写真实
 * LaunchAgents。recover、MIR takeover 与多进程锁属于后续子波，不在本文件扩域。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchAgentReceipt } from '../src/launchagent-lifecycle/contracts.js';
import { createLaunchAgentLifecycleCoordinator } from '../src/launchagent-lifecycle/transaction-coordinator.js';
import { createLaunchAgentLifecycleHarness } from './helpers/launchagent-lifecycle-harness.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const LABEL_CONTROLLER = 'com.linke.controller';
const LABEL_SCHEDULER = 'com.linke.scheduler';
const HOST_MUTATION_EVENTS = Object.freeze([
  'publish-controller', 'publish-scheduler', 'publish-manifest',
  'remove-controller', 'remove-scheduler', 'remove-manifest',
  'bootout-controller', 'bootout-scheduler',
  'bootstrap-controller', 'bootstrap-scheduler',
]);

function countEvent(trace, name) {
  return trace.filter((event) => event === name).length;
}

function xmlControllerPlist(port) {
  return Buffer.from([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LABEL_CONTROLLER}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PORT</key>',
    `    <string>${port}</string>`,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n'), 'utf8');
}

function assertNoFileMutation(harness, label) {
  const trace = harness.trace();
  for (const event of [
    'publish-controller', 'publish-scheduler', 'publish-manifest',
    'remove-controller', 'remove-scheduler', 'remove-manifest',
  ]) {
    assert.equal(countEvent(trace, event), 0, `${label}: ${event}`);
  }
  const sentinels = harness.sentinels();
  assert.equal(sentinels.publish, 0, `${label}: publish`);
  assert.equal(sentinels.remove, 0, `${label}: remove`);
}

function assertZeroHostMutation(harness, label) {
  const trace = harness.trace();
  for (const event of HOST_MUTATION_EVENTS) {
    assert.equal(countEvent(trace, event), 0, `${label}: ${event}`);
  }
  const sentinels = harness.sentinels();
  assert.equal(sentinels.hostMutationCount, 0, `${label}: hostMutationCount`);
  assert.equal(
    sentinels.publish + sentinels.remove + sentinels.bootout + sentinels.bootstrap,
    0,
    `${label}: mutation counters`,
  );
}

function assertFileHashes(harness, expected) {
  const snapshot = harness.hostSnapshot();
  for (const role of ['controller', 'scheduler', 'manifest']) {
    assert.equal(snapshot[role]?.sha256 ?? null, expected[role], `${role} hash`);
  }
}

function assertClosedReceipt(harness, result, expected) {
  const receipt = validateLaunchAgentReceipt(result);
  assert.equal(receipt.operation, expected.operation);
  assert.equal(receipt.state, expected.state);
  assert.equal(receipt.outcome, expected.outcome);
  assert.equal(receipt.success, expected.success);
  assert.deepEqual(harness.receiptFor(receipt.transactionId), receipt);
  assert.equal(harness.journalStates(receipt.transactionId).at(-1), expected.state);
  assert.equal(receipt.hostMutationCount, harness.sentinels().hostMutationCount);
  assert.deepEqual(harness.lockState(), {
    transactionLock: false,
    manualInterventionLock: false,
  });
  return receipt;
}

function rollbackInput(targetAnchorId, sourceCommit = COMMIT_B) {
  return { sourceCommit, targetAnchorId };
}

function upgradeInput() {
  return {
    sourceCommit: COMMIT_B,
    scheduleSeconds: 600,
    controllerEnvironment: { PORT: '9090' },
  };
}

async function createUpgradeTarget(options = {}) {
  const harness = createLaunchAgentLifecycleHarness();
  const seed = harness.seedInstalled({
    sourceCommit: COMMIT_A,
    controllerEnvironment: options.controllerEnvironment ?? {},
    loaded: options.loaded ?? { controller: true, scheduler: true },
  });
  if (options.nextRuntimeAgentSha256) {
    harness.setRuntimeArtifactSha256('agent', options.nextRuntimeAgentSha256);
  }
  harness.resetObservations();
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const upgraded = validateLaunchAgentReceipt(
    await coordinator.managedUpgrade(upgradeInput()),
  );
  assert.equal(upgraded.state, 'committed');
  assert.equal(upgraded.outcome, 'completed');
  const target = harness.anchorFor(upgraded.anchorId);
  assert.ok(target, 'managed upgrade must leave a rollback target');
  return { harness, coordinator, seed, upgraded, target };
}

test('committed install/upgrade anchors bind rollback-from to the resulting manifest', async (t) => {
  await t.test('first install target matches the installed manifest and restores absence', async () => {
    const harness = createLaunchAgentLifecycleHarness();
    const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
    const installed = validateLaunchAgentReceipt(await coordinator.install({
      sourceCommit: COMMIT_A,
      scheduleSeconds: 300,
      controllerEnvironment: {},
    }));
    const anchor = harness.anchorFor(installed.anchorId);
    const manifestSha256 = harness.hostSnapshot().manifest.sha256;

    assert.equal(anchor.rollbackFromManifestSha256, manifestSha256);
    assert.equal(anchor.restoreManifestSha256, null);
    assert.equal(anchor.manifest.priorState, 'absent');
  });

  await t.test('upgrade target matches the new manifest and restores the prior manifest', async () => {
    const { harness, seed, target } = await createUpgradeTarget();
    const currentManifestSha256 = harness.hostSnapshot().manifest.sha256;

    assert.equal(target.rollbackFromManifestSha256, currentManifestSha256);
    assert.equal(target.restoreManifestSha256, seed.manifestSha256);
    assert.equal(target.manifest.sha256, seed.manifestSha256);
  });
});

const surfaceHarness = createLaunchAgentLifecycleHarness();
const surfaceCoordinator = createLaunchAgentLifecycleCoordinator(surfaceHarness.dependencies());
const rollbackImplemented = typeof surfaceCoordinator.rollback === 'function';
const uninstallImplemented = typeof surfaceCoordinator.uninstall === 'function';

test('Task 5A.1 coordinator exposes rollback and uninstall', () => {
  assert.equal(
    typeof surfaceCoordinator.rollback,
    'function',
    'expected coordinator.rollback to implement Task 5A.1',
  );
  assert.equal(
    typeof surfaceCoordinator.uninstall,
    'function',
    'expected coordinator.uninstall to implement Task 5A.1',
  );
});

if (rollbackImplemented && uninstallImplemented) {
  test('rollback and uninstall reject non-closed inputs before host mutation', async () => {
    const harness = createLaunchAgentLifecycleHarness();
    const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
    const assertInvalid = (error) => {
      assert.equal(error?.code, 'launchagent-lifecycle-invalid');
      assert.equal(error?.message, 'launchagent-lifecycle-invalid');
      return true;
    };

    await assert.rejects(coordinator.rollback({}), assertInvalid);
    await assert.rejects(coordinator.rollback({
      ...rollbackInput('00000000-0000-4000-8000-000000000001'),
      unexpected: true,
    }), assertInvalid);
    await assert.rejects(coordinator.uninstall({}), assertInvalid);
    await assert.rejects(coordinator.uninstall({ sourceCommit: COMMIT_A, unexpected: true }), assertInvalid);
    assertZeroHostMutation(harness, 'invalid inputs');
  });

  test('rollback restores exact bytes and recorded loaded booleans, then rejects replay', async () => {
    const { harness, coordinator, seed, target } = await createUpgradeTarget({
      loaded: { controller: false, scheduler: true },
    });
    harness.resetObservations();

    const result = await coordinator.rollback(rollbackInput(target.anchorId));
    const receipt = assertClosedReceipt(harness, result, {
      operation: 'rollback', state: 'committed', outcome: 'completed', success: true,
    });
    assert.deepEqual(harness.fileBytes('controller'), seed.controllerBytes);
    assert.deepEqual(harness.fileBytes('scheduler'), seed.schedulerBytes);
    assert.deepEqual(harness.fileBytes('manifest'), seed.manifestBytes);
    assert.deepEqual(harness.hostSnapshot().loaded, {
      controller: false,
      scheduler: true,
    });
    assert.equal(
      JSON.parse(harness.fileBytes('manifest').toString('utf8')).activeAnchorId,
      seed.anchorId,
    );
    assert.deepEqual(receipt.roles, {
      controller: { label: LABEL_CONTROLLER, outcome: 'restored', changed: true },
      scheduler: { label: LABEL_SCHEDULER, outcome: 'restored', changed: true },
    });

    harness.resetObservations();
    const replay = validateLaunchAgentReceipt(
      await coordinator.rollback(rollbackInput(target.anchorId, COMMIT_A)),
    );
    assert.equal(replay.success, false, 'an applied target must be single-use');
    assert.notEqual(replay.state, 'committed');
    assertZeroHostMutation(harness, 'rollback replay');
  });

  test('rollback-to-absent removes both plists and manifest without bootstrap', async () => {
    const harness = createLaunchAgentLifecycleHarness();
    const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
    const installed = validateLaunchAgentReceipt(await coordinator.install({
      sourceCommit: COMMIT_A,
      scheduleSeconds: 300,
      controllerEnvironment: {},
    }));
    harness.resetObservations();

    const result = await coordinator.rollback(rollbackInput(installed.anchorId, COMMIT_A));
    assertClosedReceipt(harness, result, {
      operation: 'rollback', state: 'committed', outcome: 'completed', success: true,
    });
    assert.equal(harness.fileBytes('controller'), null);
    assert.equal(harness.fileBytes('scheduler'), null);
    assert.equal(harness.fileBytes('manifest'), null);
    assert.deepEqual(harness.hostSnapshot().loaded, { controller: false, scheduler: false });
    assert.equal(harness.sentinels().bootstrap, 0);
  });

  test('rollback runtime mismatch performs zero bootstrap and restores pre-rollback state', async () => {
    const { harness, coordinator, target } = await createUpgradeTarget({
      nextRuntimeAgentSha256: 'd4'.repeat(32),
    });
    const stopped = validateLaunchAgentReceipt(
      await coordinator.stop({ sourceCommit: COMMIT_B }),
    );
    assert.equal(stopped.state, 'committed');
    assert.deepEqual(harness.hostSnapshot().loaded, { controller: false, scheduler: false });
    const before = harness.hostSnapshot();
    const beforeHashes = {
      controller: before.controller.sha256,
      scheduler: before.scheduler.sha256,
      manifest: before.manifest.sha256,
    };
    harness.resetObservations();

    const result = await coordinator.rollback(rollbackInput(target.anchorId));
    assertClosedReceipt(harness, result, {
      operation: 'rollback',
      state: 'recovered',
      outcome: 'rollback-runtime-mismatch',
      success: false,
    });
    assert.equal(harness.sentinels().bootstrap, 0, 'target runtime mismatch forbids bootstrap');
    assertFileHashes(harness, beforeHashes);
    assert.deepEqual(harness.hostSnapshot().loaded, before.loaded);
    assert.ok(
      harness.anchorsWritten().some((anchor) => anchor.purpose === 'rollback-compensation'),
      'rollback attempt must preserve a separate compensation anchor',
    );
  });

  test('rollback incomplete bootout mutates no files and restores loaded booleans', async () => {
    const { harness, coordinator, target } = await createUpgradeTarget();
    const before = harness.hostSnapshot();
    const beforeHashes = {
      controller: before.controller.sha256,
      scheduler: before.scheduler.sha256,
      manifest: before.manifest.sha256,
    };
    harness.resetObservations();
    harness.failNext('bootout-scheduler');

    const result = await coordinator.rollback(rollbackInput(target.anchorId));
    assertClosedReceipt(harness, result, {
      operation: 'rollback',
      state: 'recovered',
      outcome: 'rollback-unload-incomplete',
      success: false,
    });
    assertNoFileMutation(harness, 'rollback incomplete unload');
    assertFileHashes(harness, beforeHashes);
    assert.deepEqual(harness.hostSnapshot().loaded, before.loaded);
  });

  test('rollback apply and bootstrap failures compensate the exact pre-rollback snapshot', async (t) => {
    for (const [name, inject, outcome] of [
      [
        'scheduler publish mismatch after controller restore',
        (harness) => harness.failNext('publish-scheduler'),
        'conditional-mutation-mismatch',
      ],
      [
        'controller bootstrap failure after file restore',
        (harness) => harness.failNext('bootstrap-controller'),
        'controller-not-ready',
      ],
    ]) {
      await t.test(name, async () => {
        const { harness, coordinator, target } = await createUpgradeTarget();
        const before = harness.hostSnapshot();
        const beforeBytes = {
          controller: harness.fileBytes('controller'),
          scheduler: harness.fileBytes('scheduler'),
          manifest: harness.fileBytes('manifest'),
        };
        harness.resetObservations();
        inject(harness);

        const result = await coordinator.rollback(rollbackInput(target.anchorId));
        assertClosedReceipt(harness, result, {
          operation: 'rollback', state: 'recovered', outcome, success: false,
        });
        for (const role of ['controller', 'scheduler', 'manifest']) {
          assert.deepEqual(harness.fileBytes(role), beforeBytes[role], `${name}: ${role}`);
        }
        assert.deepEqual(harness.hostSnapshot().loaded, before.loaded);
        assert.ok(
          harness.journalStates(result.transactionId).includes('compensating'),
          `${name}: compensation journal`,
        );
      });
    }
  });

  test('rollback replays and verifies the controller port recorded in the target plist', async () => {
    const harness = createLaunchAgentLifecycleHarness();
    const dependencies = harness.dependencies();
    const checkedPorts = [];
    const coordinator = createLaunchAgentLifecycleCoordinator({
      ...dependencies,
      profileRenderer: {
        ...dependencies.profileRenderer,
        async render(input) {
          const rendered = await dependencies.profileRenderer.render(input);
          const controllerBytes = xmlControllerPlist(input.controllerEnvironment.PORT ?? '8899');
          return {
            ...rendered,
            controller: {
              ...rendered.controller,
              plistBytes: controllerBytes,
              plistSha256: createHash('sha256').update(controllerBytes).digest('hex'),
            },
          };
        },
      },
      healthChecker: {
        async check(input) {
          checkedPorts.push(input.port);
          return dependencies.healthChecker.check(input);
        },
      },
    });
    const installed = validateLaunchAgentReceipt(await coordinator.install({
      sourceCommit: COMMIT_A,
      scheduleSeconds: 300,
      controllerEnvironment: { PORT: '3000' },
    }));
    assert.equal(installed.state, 'committed');
    const seedControllerBytes = harness.fileBytes('controller');
    const upgraded = validateLaunchAgentReceipt(
      await coordinator.managedUpgrade(upgradeInput()),
    );
    const target = harness.anchorFor(upgraded.anchorId);
    checkedPorts.length = 0;
    harness.resetObservations();

    const result = await coordinator.rollback(rollbackInput(target.anchorId));
    assertClosedReceipt(harness, result, {
      operation: 'rollback', state: 'committed', outcome: 'completed', success: true,
    });
    assert.deepEqual(harness.fileBytes('controller'), seedControllerBytes);
    assert.ok(checkedPorts.length >= 1, 'rollback must perform controller health verification');
    assert.ok(
      checkedPorts.every((port) => port === 3000),
      `expected only restored port 3000, got ${checkedPorts.join(',')}`,
    );
  });

  test('rollback compensation uses the non-default pre-rollback controller port', async () => {
    const harness = createLaunchAgentLifecycleHarness();
    const dependencies = harness.dependencies();
    const checkedPorts = [];
    const coordinator = createLaunchAgentLifecycleCoordinator({
      ...dependencies,
      profileRenderer: {
        ...dependencies.profileRenderer,
        async render(input) {
          const rendered = await dependencies.profileRenderer.render(input);
          const controllerBytes = xmlControllerPlist(input.controllerEnvironment.PORT ?? '8899');
          return {
            ...rendered,
            controller: {
              ...rendered.controller,
              plistBytes: controllerBytes,
              plistSha256: createHash('sha256').update(controllerBytes).digest('hex'),
            },
          };
        },
      },
      healthChecker: {
        async check(input) {
          checkedPorts.push(input.port);
          return dependencies.healthChecker.check(input);
        },
      },
    });
    await coordinator.install({
      sourceCommit: COMMIT_A,
      scheduleSeconds: 300,
      controllerEnvironment: { PORT: '3000' },
    });
    const upgraded = validateLaunchAgentReceipt(
      await coordinator.managedUpgrade(upgradeInput()),
    );
    const target = harness.anchorFor(upgraded.anchorId);
    const before = harness.hostSnapshot();
    const beforeBytes = {
      controller: harness.fileBytes('controller'),
      scheduler: harness.fileBytes('scheduler'),
      manifest: harness.fileBytes('manifest'),
    };
    checkedPorts.length = 0;
    harness.resetObservations();
    harness.failNext('publish-scheduler');

    const result = await coordinator.rollback(rollbackInput(target.anchorId));
    assertClosedReceipt(harness, result, {
      operation: 'rollback',
      state: 'recovered',
      outcome: 'conditional-mutation-mismatch',
      success: false,
    });
    for (const role of ['controller', 'scheduler', 'manifest']) {
      assert.deepEqual(harness.fileBytes(role), beforeBytes[role], role);
    }
    assert.deepEqual(harness.hostSnapshot().loaded, before.loaded);
    assert.ok(checkedPorts.length >= 1, 'compensation must verify controller health');
    assert.ok(
      checkedPorts.every((port) => port === 9090),
      `expected only pre-rollback port 9090, got ${checkedPorts.join(',')}`,
    );
  });

  test('uninstall proves both labels unloaded before identity-gated removal', async () => {
    const harness = createLaunchAgentLifecycleHarness();
    harness.seedInstalled({ sourceCommit: COMMIT_A });
    harness.resetObservations();
    const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());

    const result = await coordinator.uninstall({ sourceCommit: COMMIT_A });
    assertClosedReceipt(harness, result, {
      operation: 'uninstall', state: 'committed', outcome: 'completed', success: true,
    });
    const trace = harness.trace();
    const schedulerBootout = trace.indexOf('bootout-scheduler');
    const controllerBootout = trace.indexOf('bootout-controller');
    const schedulerRemove = trace.indexOf('remove-scheduler');
    const controllerRemove = trace.indexOf('remove-controller');
    const manifestRemove = trace.indexOf('remove-manifest');
    assert.ok(schedulerBootout >= 0 && schedulerBootout < controllerBootout);
    assert.ok(controllerBootout < schedulerRemove);
    assert.ok(
      trace.slice(controllerBootout + 1, schedulerRemove).includes('verify-job-scheduler'),
      'scheduler must be freshly proven unloaded before the first remove',
    );
    assert.ok(
      trace.slice(controllerBootout + 1, schedulerRemove).includes('verify-job-controller'),
      'controller must be freshly proven unloaded before the first remove',
    );
    assert.ok(schedulerRemove < controllerRemove && controllerRemove < manifestRemove);
    assert.equal(harness.fileBytes('controller'), null);
    assert.equal(harness.fileBytes('scheduler'), null);
    assert.equal(harness.fileBytes('manifest'), null);
    assert.deepEqual(harness.hostSnapshot().loaded, { controller: false, scheduler: false });
  });

  test('uninstall failed or unknown bootout performs zero file mutation and compensates', async (t) => {
    for (const [name, inject] of [
      ['failed bootout', (harness) => harness.failNext('bootout-scheduler')],
      ['unknown verification', (harness) => harness.failNext('verify-job-scheduler')],
    ]) {
      await t.test(name, async () => {
        const harness = createLaunchAgentLifecycleHarness();
        harness.seedInstalled({ sourceCommit: COMMIT_A });
        const before = harness.hostSnapshot();
        const beforeHashes = {
          controller: before.controller.sha256,
          scheduler: before.scheduler.sha256,
          manifest: before.manifest.sha256,
        };
        harness.resetObservations();
        inject(harness);
        const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());

        const result = await coordinator.uninstall({ sourceCommit: COMMIT_A });
        assertClosedReceipt(harness, result, {
          operation: 'uninstall',
          state: 'recovered',
          outcome: 'uninstall-unload-incomplete',
          success: false,
        });
        assertNoFileMutation(harness, `uninstall ${name}`);
        assertFileHashes(harness, beforeHashes);
        assert.deepEqual(harness.hostSnapshot().loaded, before.loaded);
      });
    }
  });

  test('uninstall partial remove failure restores every file and loaded boolean', async () => {
    const harness = createLaunchAgentLifecycleHarness();
    harness.seedInstalled({ sourceCommit: COMMIT_A });
    const before = harness.hostSnapshot();
    const beforeBytes = {
      controller: harness.fileBytes('controller'),
      scheduler: harness.fileBytes('scheduler'),
      manifest: harness.fileBytes('manifest'),
    };
    harness.resetObservations();
    harness.failNext('remove-controller');
    const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());

    const result = await coordinator.uninstall({ sourceCommit: COMMIT_A });
    assertClosedReceipt(harness, result, {
      operation: 'uninstall',
      state: 'recovered',
      outcome: 'conditional-mutation-mismatch',
      success: false,
    });
    for (const role of ['controller', 'scheduler', 'manifest']) {
      assert.deepEqual(harness.fileBytes(role), beforeBytes[role], role);
    }
    assert.deepEqual(harness.hostSnapshot().loaded, before.loaded);
    assert.ok(harness.journalStates(result.transactionId).includes('compensating'));
  });

  test('uninstall never deletes a sibling for drift and never bootouts a foreign label', async (t) => {
    await t.test('one drifted plist blocks every delete', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({ sourceCommit: COMMIT_A });
      const schedulerBytes = harness.fileBytes('scheduler');
      const manifestBytes = harness.fileBytes('manifest');
      harness.driftHostFile('controller');
      harness.resetObservations();
      const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      const result = validateLaunchAgentReceipt(
        await coordinator.uninstall({ sourceCommit: COMMIT_A }),
      );
      assert.equal(result.success, false);
      assert.deepEqual(harness.fileBytes('scheduler'), schedulerBytes);
      assert.deepEqual(harness.fileBytes('manifest'), manifestBytes);
      assertZeroHostMutation(harness, 'drifted uninstall');
    });

    await t.test('foreign label is never booted out', async () => {
      const harness = createLaunchAgentLifecycleHarness();
      harness.seedInstalled({
        sourceCommit: COMMIT_A,
        foreign: { controller: false, scheduler: true },
      });
      harness.resetObservations();
      const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());

      const result = validateLaunchAgentReceipt(
        await coordinator.uninstall({ sourceCommit: COMMIT_A }),
      );
      assert.equal(result.success, false);
      assert.equal(harness.sentinels().bootout, 0);
      assertZeroHostMutation(harness, 'foreign uninstall');
    });
  });
}
