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

test('Task 5A.2 harness exposes deterministic crash-image controls', () => {
  const harness = createLaunchAgentLifecycleHarness();
  assert.equal(typeof harness.armCrashCapture, 'function');
  assert.equal(typeof harness.takeCrashImage, 'function');
  assert.throws(
    () => createLaunchAgentLifecycleHarness({ crashImage: {} }),
    /launchagent-harness:/,
  );
});

async function captureInstallImage(selector) {
  const harness = createLaunchAgentLifecycleHarness();
  harness.armCrashCapture(selector);
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const completed = validateLaunchAgentReceipt(await coordinator.install({
    sourceCommit: COMMIT_A,
    scheduleSeconds: 300,
    controllerEnvironment: {},
  }));
  const image = harness.takeCrashImage();
  return {
    harness,
    image,
    revived: createLaunchAgentLifecycleHarness({ crashImage: image }),
    transactionId: completed.transactionId,
    completed,
  };
}

test('Task 5A.2 crash image revives a detached fresh harness', async () => {
  const { harness: original, image, revived, transactionId } = await captureInstallImage({
    kind: 'journal-state',
    state: 'controller-publish-intent',
    occurrence: 1,
  });
  assert.equal(original.journalStates(transactionId).at(-1), 'committed');
  assert.equal(revived.journalStates(transactionId).at(-1), 'controller-publish-intent');
  assert.deepEqual(revived.trace(), []);
  assert.deepEqual(revived.adapterCalls(), []);
  assert.throws(() => { image.sequence.clockIndex = 999; }, TypeError);
  assert.throws(() => createLaunchAgentLifecycleHarness({
    crashImage: structuredClone(image),
  }), /untrusted crash image/);
  assert.equal(revived.fileBytes('controller'), null);
  assert.deepEqual(revived.lockState(), {
    transactionLock: true,
    manualInterventionLock: false,
  });
});

test('Task 5A.2 crash image rejects invalid selectors and factory inputs', () => {
  for (const badOptions of [null, [], 'crashImage', Object.create(null)]) {
    assert.throws(
      () => createLaunchAgentLifecycleHarness(badOptions),
      /harness options must be a plain object/,
    );
  }
  assert.throws(
    () => createLaunchAgentLifecycleHarness({ unknown: true }),
    /launchagent-lifecycle-invalid/,
  );
  assert.throws(
    () => createLaunchAgentLifecycleHarness({ [Symbol('crashImage')]: {} }),
    /launchagent-lifecycle-invalid/,
  );
  assert.throws(
    () => createLaunchAgentLifecycleHarness({ get crashImage() { return {}; } }),
    /launchagent-lifecycle-invalid/,
  );
  assert.throws(
    () => createLaunchAgentLifecycleHarness({ crashImage: undefined }),
    /untrusted crash image/,
  );

  const harness = createLaunchAgentLifecycleHarness();
  for (const badSelector of [null, [], 'journal-state', Object.create(null)]) {
    assert.throws(
      () => harness.armCrashCapture(badSelector),
      /crash selector must be a plain object/,
    );
  }
  assert.throws(() => harness.armCrashCapture({}), /unknown crash selector kind/);
  assert.throws(
    () => harness.armCrashCapture({ kind: 'process-exit', occurrence: 1 }),
    /unknown crash selector kind/,
  );
  assert.throws(
    () => harness.armCrashCapture({
      get kind() { return 'journal-state'; },
      state: 'prepared',
      occurrence: 1,
    }),
    /unknown crash selector kind/,
  );
  for (const badOccurrence of [0, -1, 1.5, Number.NaN, '1']) {
    assert.throws(
      () => harness.armCrashCapture({
        kind: 'journal-state',
        state: 'prepared',
        occurrence: badOccurrence,
      }),
      /crash capture occurrence must be a positive integer/,
    );
  }
  for (const badState of ['', 42]) {
    assert.throws(
      () => harness.armCrashCapture({
        kind: 'journal-state',
        state: badState,
        occurrence: 1,
      }),
      /journal crash state must be non-empty/,
    );
  }
  assert.throws(
    () => harness.armCrashCapture({ kind: 'journal-state', state: 'prepared' }),
    /launchagent-lifecycle-invalid/,
  );
  assert.throws(
    () => harness.armCrashCapture({
      kind: 'journal-state',
      state: 'prepared',
      occurrence: 1,
      extra: true,
    }),
    /launchagent-lifecycle-invalid/,
  );
  assert.throws(
    () => harness.armCrashCapture({ kind: 'host-mutation', state: 'prepared', occurrence: 1 }),
    /launchagent-lifecycle-invalid/,
  );
  assert.throws(
    () => harness.armCrashCapture({ kind: 'journal-state', action: 'publish-controller', occurrence: 1 }),
    /launchagent-lifecycle-invalid/,
  );
  assert.throws(
    () => harness.armCrashCapture({ kind: 'host-mutation', action: 'explode', occurrence: 1 }),
    /unknown crash host action/,
  );
  assert.throws(() => harness.takeCrashImage(), /crash image unavailable/);

  assert.equal(
    harness.armCrashCapture({ kind: 'journal-state', state: 'prepared', occurrence: 1 }),
    true,
  );
  assert.throws(
    () => harness.armCrashCapture({ kind: 'journal-state', state: 'prepared', occurrence: 1 }),
    /crash capture already configured/,
  );

  const hostArmed = createLaunchAgentLifecycleHarness();
  assert.equal(
    hostArmed.armCrashCapture({ kind: 'host-mutation', action: 'publish-controller', occurrence: 1 }),
    true,
  );
});

test('Task 5A.2 crash image capture is deterministic and detached', async () => {
  const selector = { kind: 'journal-state', state: 'controller-publish-intent', occurrence: 1 };
  const first = await captureInstallImage(selector);
  const second = await captureInstallImage(selector);
  assert.notEqual(first.image, second.image);
  assert.deepEqual(first.image, second.image);

  assert.equal(first.harness.journalStates(first.transactionId).at(-1), 'committed');
  assert.equal(first.image.journal.at(-1).state, 'controller-publish-intent');
  assert.equal(
    first.revived.journalEntries(first.transactionId).length,
    first.image.journal.length,
  );
  assert.equal(first.image.host.loaded.controller, false);
  assert.equal(first.harness.hostSnapshot().loaded.controller, true);
});

test('Task 5A.2 crash image is a deep-frozen plain projection with base64 bytes', async () => {
  const { harness, image, revived } = await captureInstallImage({
    kind: 'journal-state',
    state: 'committed',
    occurrence: 1,
  });
  const walk = (value, path) => {
    if (value === null || typeof value !== 'object') return;
    assert.ok(!Buffer.isBuffer(value), `${path}: no Buffer leakage`);
    assert.ok(Object.isFrozen(value), `${path}: frozen`);
    if (!Array.isArray(value)) {
      assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path}: plain object`);
    }
    for (const key of Reflect.ownKeys(value)) {
      assert.equal(typeof key, 'string', `${path}: string keys only`);
      walk(value[key], `${path}.${key}`);
    }
  };
  walk(image, 'image');
  assert.ok(image.files.length >= 3, 'committed image must contain host files');
  assert.ok(image.candidates.length >= 1, 'committed image must contain candidates');
  for (const item of [...image.files, ...image.candidates]) {
    assert.equal(typeof item.bytesBase64, 'string');
    assert.ok(item.bytesBase64.length > 0);
  }
  for (const role of ['controller', 'scheduler', 'manifest']) {
    assert.deepEqual(revived.fileBytes(role), harness.fileBytes(role), `${role} bytes`);
  }
  assert.deepEqual(revived.hostSnapshot(), harness.hostSnapshot());
  // terminal journal 落盘瞬间锁尚未条件释放：image 冻结该窗口，原实例随后释放。
  assert.deepEqual(revived.lockState(), {
    transactionLock: true,
    manualInterventionLock: false,
  });
  assert.deepEqual(harness.lockState(), {
    transactionLock: false,
    manualInterventionLock: false,
  });
});

test('Task 5A.2 crash image leaves execution untouched when the selector never matches', async () => {
  const baseline = createLaunchAgentLifecycleHarness();
  const baselineCoordinator = createLaunchAgentLifecycleCoordinator(baseline.dependencies());
  const baselineReceipt = validateLaunchAgentReceipt(await baselineCoordinator.install({
    sourceCommit: COMMIT_A,
    scheduleSeconds: 300,
    controllerEnvironment: {},
  }));

  const armed = createLaunchAgentLifecycleHarness();
  armed.armCrashCapture({ kind: 'journal-state', state: 'no-such-journal-state', occurrence: 1 });
  const armedCoordinator = createLaunchAgentLifecycleCoordinator(armed.dependencies());
  const armedReceipt = validateLaunchAgentReceipt(await armedCoordinator.install({
    sourceCommit: COMMIT_A,
    scheduleSeconds: 300,
    controllerEnvironment: {},
  }));

  assert.deepEqual(armedReceipt, baselineReceipt);
  assert.deepEqual(armed.trace(), baseline.trace());
  assert.deepEqual(armed.adapterCalls(), baseline.adapterCalls());
  assert.deepEqual(armed.sentinels(), baseline.sentinels());
  assert.deepEqual(
    armed.journalStates(armedReceipt.transactionId),
    baseline.journalStates(baselineReceipt.transactionId),
  );
  assert.throws(() => armed.takeCrashImage(), /crash image unavailable/);
});

test('Task 5A.2 crash image honors occurrence and single-use take', async () => {
  const missing = createLaunchAgentLifecycleHarness();
  missing.armCrashCapture({ kind: 'journal-state', state: 'controller-publish-intent', occurrence: 2 });
  const missingCoordinator = createLaunchAgentLifecycleCoordinator(missing.dependencies());
  const missed = validateLaunchAgentReceipt(await missingCoordinator.install({
    sourceCommit: COMMIT_A,
    scheduleSeconds: 300,
    controllerEnvironment: {},
  }));
  assert.equal(missed.state, 'committed');
  assert.throws(() => missing.takeCrashImage(), /crash image unavailable/);

  const harness = createLaunchAgentLifecycleHarness();
  harness.armCrashCapture({ kind: 'journal-state', state: 'committed', occurrence: 1 });
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  await coordinator.install({
    sourceCommit: COMMIT_A,
    scheduleSeconds: 300,
    controllerEnvironment: {},
  });
  const image = harness.takeCrashImage();
  assert.ok(image);
  assert.throws(() => harness.takeCrashImage(), /crash image unavailable/);
  assert.throws(
    () => harness.armCrashCapture({ kind: 'journal-state', state: 'prepared', occurrence: 1 }),
    /crash capture already configured/,
  );
});

// ---- Task 2：精确 mutation 边界捕获与 Step 4 预证明锁接缝 ----

function lockRefFromImage(image) {
  return {
    kind: 'transaction-lock',
    transactionId: image.transactionLock.transactionId,
    ownerNonce: image.transactionLock.ownerNonce,
    sha256: createHash('sha256')
      .update(JSON.stringify(image.transactionLock), 'utf8')
      .digest('hex'),
  };
}

function durableBytesSnapshot(harness, transactionIds) {
  const files = ['controller', 'scheduler', 'manifest'].map((role) => {
    const bytes = harness.fileBytes(role);
    return bytes === null ? null : bytes.toString('base64');
  });
  return JSON.stringify({
    journal: transactionIds.map((id) => harness.journalEntries(id)),
    receipts: transactionIds.map((id) => harness.receiptFor(id)),
    files,
    host: harness.hostSnapshot(),
    locks: harness.lockState(),
    trace: harness.trace(),
    adapterCalls: harness.adapterCalls(),
    sentinels: harness.sentinels(),
  });
}

async function captureMirImage(selector) {
  const harness = createLaunchAgentLifecycleHarness();
  harness.corruptNextPublishedIdentityAfterMutation('controller', 'bad-sha256');
  harness.armCrashCapture(selector);
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const mirReceipt = validateLaunchAgentReceipt(await coordinator.install({
    sourceCommit: COMMIT_A,
    scheduleSeconds: 300,
    controllerEnvironment: {},
  }));
  assert.equal(mirReceipt.state, 'manual-intervention-required');
  const image = harness.takeCrashImage();
  return {
    harness,
    image,
    revived: createLaunchAgentLifecycleHarness({ crashImage: image }),
    transactionId: mirReceipt.transactionId,
  };
}

test('crash image distinguishes intent/pre-mutation from mutation/pre-completed', async () => {
  const before = await captureInstallImage({
    kind: 'journal-state', state: 'controller-publish-intent', occurrence: 1,
  });
  const after = await captureInstallImage({
    kind: 'host-mutation', action: 'publish-controller', occurrence: 1,
  });
  assert.equal(before.revived.fileBytes('controller'), null);
  assert.ok(after.revived.fileBytes('controller'));
  assert.equal(
    after.revived.journalStates(after.transactionId).at(-1),
    'controller-publish-intent',
  );
});

test('pre-proven lock seam is exact and host-mutation free', async () => {
  const { revived, transactionId } = await captureInstallImage({
    kind: 'journal-state', state: 'controller-publish-intent', occurrence: 1,
  });
  assert.deepEqual(revived.lockState(), {
    transactionLock: true,
    manualInterventionLock: false,
  });
  revived.preProveRecoveryLockRelease({ transactionId });
  assert.deepEqual(revived.lockState(), {
    transactionLock: false,
    manualInterventionLock: false,
  });
  assert.deepEqual(revived.trace(), ['recovery-lock-seam']);
  assert.equal(revived.sentinels().hostMutationCount, 0);
});

test('pre-proven lock seam covers terminal receipt windows without pre-judging closure', async (t) => {
  await t.test('terminal missing receipt releases the stale lock', async () => {
    const { revived, transactionId } = await captureInstallImage({
      kind: 'journal-state', state: 'committed', occurrence: 1,
    });
    assert.equal(revived.journalStates(transactionId).at(-1), 'committed');
    assert.equal(revived.receiptFor(transactionId), null, 'crash window must lack the receipt');
    assert.deepEqual(revived.lockState(), {
      transactionLock: true,
      manualInterventionLock: false,
    });
    assert.equal(revived.preProveRecoveryLockRelease({ transactionId }), true);
    assert.deepEqual(revived.lockState(), {
      transactionLock: false,
      manualInterventionLock: false,
    });
    assert.equal(revived.receiptFor(transactionId), null, 'seam must not fabricate a receipt');
    assert.equal(revived.journalStates(transactionId).at(-1), 'committed');
    assert.deepEqual(revived.trace(), ['recovery-lock-seam']);
    assert.equal(revived.sentinels().hostMutationCount, 0);
    assert.equal(revived.sentinels().realLaunchctlCalls, 0);
  });

  await t.test('terminal exact receipt plus stale lock releases without touching the receipt', async () => {
    const {
      revived, image, transactionId, completed,
    } = await captureInstallImage({
      kind: 'journal-state', state: 'committed', occurrence: 1,
    });
    await revived.dependencies().metadataStore.publishReceipt({
      receipt: completed,
      lockRef: lockRefFromImage(image),
    });
    assert.deepEqual(revived.receiptFor(transactionId), completed);
    assert.equal(revived.preProveRecoveryLockRelease({ transactionId }), true);
    assert.deepEqual(revived.lockState(), {
      transactionLock: false,
      manualInterventionLock: false,
    });
    assert.deepEqual(
      revived.receiptFor(transactionId),
      completed,
      'seam must not mutate the closed receipt',
    );
    assert.equal(revived.journalStates(transactionId).at(-1), 'committed');
    assert.deepEqual(revived.trace(), ['receipt', 'recovery-lock-seam']);
    assert.equal(revived.sentinels().hostMutationCount, 0);
  });

  await t.test('terminal conflicting receipt still releases the stale lock', async () => {
    const {
      revived, image, transactionId, completed,
    } = await captureInstallImage({
      kind: 'journal-state', state: 'committed', occurrence: 1,
    });
    await revived.dependencies().metadataStore.publishReceipt({
      receipt: completed,
      lockRef: lockRefFromImage(image),
    });
    const misaligned = revived.misalignReceiptHashFor(transactionId);
    const terminal = revived.journalEntries(transactionId).at(-1);
    assert.notEqual(
      misaligned.sha256,
      terminal.payload.receiptSha256,
      'receipt must genuinely conflict with the terminal journal',
    );
    assert.equal(revived.preProveRecoveryLockRelease({ transactionId }), true);
    assert.deepEqual(revived.lockState(), {
      transactionLock: false,
      manualInterventionLock: false,
    });
    const conflicting = revived.receiptFor(transactionId);
    assert.equal(conflicting.sourceCommit, COMMIT_B, 'seam must not heal the conflicting receipt');
    assert.equal(revived.journalStates(transactionId).at(-1), 'committed');
    assert.deepEqual(revived.trace(), ['receipt', 'recovery-lock-seam']);
    assert.equal(revived.sentinels().hostMutationCount, 0);
  });
});

test('pre-proven lock seam rejects unsafe inputs and preserves state byte-for-byte', async (t) => {
  const nonterminalSelector = {
    kind: 'journal-state', state: 'controller-publish-intent', occurrence: 1,
  };
  const mirSelector = {
    kind: 'journal-state', state: 'manual-intervention-required', occurrence: 1,
  };

  await t.test('wrong transactionId rejects and preserves the stale lock', async () => {
    const { revived, transactionId } = await captureInstallImage(nonterminalSelector);
    const before = durableBytesSnapshot(revived, [transactionId]);
    assert.throws(
      () => revived.preProveRecoveryLockRelease({
        transactionId: '00000000-0000-4000-8000-ffffffffffff',
      }),
      /stale transaction lock mismatch/,
    );
    assert.equal(durableBytesSnapshot(revived, [transactionId]), before);
    assert.equal(
      revived.preProveRecoveryLockRelease({ transactionId }),
      true,
      'preserved stale lock must still release for the matching transactionId',
    );
  });

  await t.test('manual-intervention journal rejects without a MIR lock', async () => {
    const { revived, transactionId } = await captureMirImage(mirSelector);
    assert.equal(revived.journalStates(transactionId).at(-1), 'manual-intervention-required');
    assert.deepEqual(revived.lockState(), {
      transactionLock: true,
      manualInterventionLock: false,
    });
    const before = durableBytesSnapshot(revived, [transactionId]);
    assert.throws(
      () => revived.preProveRecoveryLockRelease({ transactionId }),
      /lock seam requires a recoverable non-MIR journal/,
    );
    assert.equal(durableBytesSnapshot(revived, [transactionId]), before);
  });

  await t.test('manual-intervention lock rejects ordinary recovery', async () => {
    const { revived, transactionId } = await captureMirImage(mirSelector);
    await revived.dependencies().metadataStore.acquireManualInterventionLock({
      schemaVersion: 1,
      transactionId,
      ownerPid: 4242,
      ownerNonce: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      bootSessionIdentity: { available: false, value: null },
      processStartIdentity: { available: false, value: null },
    });
    assert.deepEqual(revived.lockState(), {
      transactionLock: true,
      manualInterventionLock: true,
    });
    const before = durableBytesSnapshot(revived, [transactionId]);
    assert.throws(
      () => revived.preProveRecoveryLockRelease({ transactionId }),
      /manual intervention lock blocks ordinary recovery/,
    );
    assert.equal(durableBytesSnapshot(revived, [transactionId]), before);
  });

  await t.test('unbranded fresh harness rejects', async () => {
    const fresh = createLaunchAgentLifecycleHarness();
    const before = durableBytesSnapshot(fresh, []);
    assert.throws(
      () => fresh.preProveRecoveryLockRelease({
        transactionId: '00000000-0000-4000-8000-000000000001',
      }),
      /lock seam requires revived crash image/,
    );
    assert.equal(durableBytesSnapshot(fresh, []), before);
  });

  await t.test('extra key rejects', async () => {
    const { revived, transactionId } = await captureInstallImage(nonterminalSelector);
    const before = durableBytesSnapshot(revived, [transactionId]);
    assert.throws(
      () => revived.preProveRecoveryLockRelease({ transactionId, unexpected: true }),
      /launchagent-lifecycle-invalid/,
    );
    assert.equal(durableBytesSnapshot(revived, [transactionId]), before);
  });

  await t.test('double call rejects and keeps a single seam event', async () => {
    const { revived, transactionId } = await captureInstallImage(nonterminalSelector);
    assert.equal(revived.preProveRecoveryLockRelease({ transactionId }), true);
    const before = durableBytesSnapshot(revived, [transactionId]);
    assert.throws(
      () => revived.preProveRecoveryLockRelease({ transactionId }),
      /stale transaction lock mismatch/,
    );
    assert.equal(durableBytesSnapshot(revived, [transactionId]), before);
    assert.deepEqual(
      revived.trace(),
      ['recovery-lock-seam'],
      'rejected second call must not record a duplicate seam event',
    );
  });

  await t.test('missing lock rejects after a production-shaped release', async () => {
    const {
      revived, image, transactionId, completed,
    } = await captureInstallImage({
      kind: 'journal-state', state: 'committed', occurrence: 1,
    });
    const lockRef = lockRefFromImage(image);
    await revived.dependencies().metadataStore.publishReceipt({
      receipt: completed,
      lockRef,
    });
    await revived.dependencies().metadataStore.releaseTransactionLock(lockRef);
    assert.deepEqual(revived.lockState(), {
      transactionLock: false,
      manualInterventionLock: false,
    });
    const before = durableBytesSnapshot(revived, [transactionId]);
    assert.throws(
      () => revived.preProveRecoveryLockRelease({ transactionId }),
      /stale transaction lock mismatch/,
    );
    assert.equal(durableBytesSnapshot(revived, [transactionId]), before);
  });
});

// ---- Task 3：公开 recover RED 与完整业务意图矩阵 ----
//
// stop/uninstall fixture 的 sourceCommit 必须与 seed manifest 相同：生产
// parseManagedInstallation 以 sourceCommit 作 ownership 证明，不匹配会 blocked、
// 任何 intent/mutation 均不可达（已用内存 harness 实验证实 COMMIT_B 全部 blocked）。
// 因此 seed 与操作统一使用 COMMIT_A，业务语义与计划矩阵完全一致。

const recoverImplemented = typeof surfaceCoordinator.recover === 'function';

test('Task 5A.2 coordinator exposes recover', () => {
  assert.equal(
    typeof surfaceCoordinator.recover,
    'function',
    'expected coordinator.recover to implement Task 5A.2',
  );
});

const BUSINESS_CRASH_CASES = Object.freeze([
  { intent: 'controller-publish-intent', action: 'publish-controller', operation: 'install' },
  { intent: 'scheduler-publish-intent', action: 'publish-scheduler', operation: 'install' },
  { intent: 'manifest-publish-intent', action: 'publish-manifest', operation: 'install' },
  { intent: 'controller-load-intent', action: 'bootstrap-controller', operation: 'install' },
  { intent: 'scheduler-load-intent', action: 'bootstrap-scheduler', operation: 'install' },
  { intent: 'scheduler-stop-intent', action: 'bootout-scheduler', operation: 'stop' },
  { intent: 'controller-stop-intent', action: 'bootout-controller', operation: 'stop' },
  { intent: 'scheduler-remove-intent', action: 'remove-scheduler', operation: 'uninstall' },
  { intent: 'controller-remove-intent', action: 'remove-controller', operation: 'uninstall' },
  { intent: 'manifest-remove-intent', action: 'remove-manifest', operation: 'uninstall' },
]);

const CRASH_PHASES = Object.freeze([
  { phase: 'intent-before-mutation', selectorKind: 'journal-state' },
  { phase: 'mutation-before-completed', selectorKind: 'host-mutation' },
]);

async function runBusinessFixture(row, selector) {
  const harness = createLaunchAgentLifecycleHarness();
  if (row.operation === 'stop' || row.operation === 'uninstall') {
    harness.seedInstalled({
      sourceCommit: COMMIT_A,
      loaded: { controller: true, scheduler: true },
    });
    harness.resetObservations();
  } else if (row.operation !== 'install') {
    throw new Error(`unsupported business fixture operation: ${row.operation}`);
  }
  const preOperationSnapshot = {
    host: harness.hostSnapshot(),
    bytes: Object.fromEntries(
      ['controller', 'scheduler', 'manifest']
        .map((role) => [role, harness.fileBytes(role)]),
    ),
  };
  harness.armCrashCapture(selector);
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  let completedResult;
  if (row.operation === 'install') {
    completedResult = await coordinator.install({
      sourceCommit: COMMIT_A,
      scheduleSeconds: 300,
      controllerEnvironment: {},
    });
  } else if (row.operation === 'stop') {
    completedResult = await coordinator.stop({ sourceCommit: COMMIT_A });
  } else {
    completedResult = await coordinator.uninstall({ sourceCommit: COMMIT_A });
  }
  const completedReceipt = validateLaunchAgentReceipt(completedResult);
  const image = harness.takeCrashImage();
  return {
    harness,
    image,
    revived: createLaunchAgentLifecycleHarness({ crashImage: image }),
    transactionId: completedReceipt.transactionId,
    originalOperation: row.operation,
    preOperationSnapshot,
    completedResult: completedReceipt,
  };
}

function selectorFor(row, phase) {
  return phase.selectorKind === 'journal-state'
    ? { kind: 'journal-state', state: row.intent, occurrence: 1 }
    : { kind: 'host-mutation', action: row.action, occurrence: 1 };
}

function assertBusinessIdentity(fixture, row, phase) {
  const host = fixture.revived.hostSnapshot();
  const afterMutation = phase.phase === 'mutation-before-completed';
  if (row.action.startsWith('publish-')) {
    const role = row.action.slice('publish-'.length);
    assert.equal(host[role] !== null, afterMutation, `${row.action}: presence`);
    if (afterMutation) {
      assert.equal(host[role].sha256, fixture.harness.hostSnapshot()[role].sha256);
    }
    return;
  }
  if (row.action.startsWith('bootstrap-')) {
    const role = row.action.slice('bootstrap-'.length);
    assert.equal(host.loaded[role], afterMutation, `${row.action}: loaded`);
    assert.equal(host.jobIdentity[role] !== null, afterMutation, `${row.action}: identity`);
    assert.equal(host[role].sha256, fixture.harness.hostSnapshot()[role].sha256);
    return;
  }
  if (row.action.startsWith('bootout-')) {
    const role = row.action.slice('bootout-'.length);
    assert.equal(host.loaded[role], !afterMutation, `${row.action}: loaded`);
    assert.equal(host.jobIdentity[role] !== null, !afterMutation, `${row.action}: identity`);
    assert.equal(host[role].sha256, fixture.preOperationSnapshot.host[role].sha256);
    return;
  }
  if (row.action.startsWith('remove-')) {
    const role = row.action.slice('remove-'.length);
    assert.equal(host[role] !== null, !afterMutation, `${row.action}: presence`);
    if (!afterMutation) {
      assert.equal(host[role].sha256, fixture.preOperationSnapshot.host[role].sha256);
    }
    return;
  }
  throw new Error(`unsupported business fixture action: ${row.action}`);
}

for (const row of BUSINESS_CRASH_CASES) {
  for (const phase of CRASH_PHASES) {
    test(`business crash fixture is reachable: ${row.intent}/${phase.phase}`, async () => {
      const fixture = await runBusinessFixture(row, selectorFor(row, phase));
      const entries = fixture.revived.journalEntries(fixture.transactionId);
      assert.equal(entries.at(-1).state, row.intent);
      assert.equal(entries.at(-1).operation, row.operation);
      assert.equal(fixture.revived.lockState().transactionLock, true);
      assertBusinessIdentity(fixture, row, phase);
    });
  }
}

// 仅首个 install 的 scheduler bootstrap post-mutation image 可独立验证完整 operation
// post-state，故 committed；其余所有行一律逆向收敛到 pre-operation anchor。
function expectedBusinessRecoveryState(row, phase) {
  return row.operation === 'install'
    && row.action === 'bootstrap-scheduler'
    && phase.phase === 'mutation-before-completed'
    ? 'committed'
    : 'recovered';
}

function assertPreOperationHostState(fixture) {
  const current = fixture.revived.hostSnapshot();
  const expected = fixture.preOperationSnapshot.host;
  for (const role of ['controller', 'scheduler', 'manifest']) {
    assert.equal(current[role]?.sha256 ?? null, expected[role]?.sha256 ?? null, `${role}: sha256`);
    assert.deepEqual(fixture.revived.fileBytes(role), fixture.preOperationSnapshot.bytes[role]);
  }
  assert.deepEqual(current.loaded, expected.loaded);
  assert.deepEqual(current.jobIdentity, expected.jobIdentity);
}

if (recoverImplemented) {
  for (const row of BUSINESS_CRASH_CASES) {
    for (const phase of CRASH_PHASES) {
      test(`business crash recovery restores intent boundary: ${row.intent}/${phase.phase}`, async () => {
        const fixture = await runBusinessFixture(row, selectorFor(row, phase));
        fixture.revived.preProveRecoveryLockRelease({ transactionId: fixture.transactionId });
        const coordinator = createLaunchAgentLifecycleCoordinator(fixture.revived.dependencies());
        const receipt = validateLaunchAgentReceipt(
          await coordinator.recover({ transactionId: fixture.transactionId }),
        );
        assert.equal(receipt.operation, fixture.originalOperation);
        const expectedState = expectedBusinessRecoveryState(row, phase);
        assert.equal(receipt.state, expectedState);
        assert.equal(receipt.success, expectedState === 'committed');
        if (expectedState === 'recovered') assertPreOperationHostState(fixture);
        else assert.equal(receipt.outcome, 'completed');
        assert.equal(
          countEvent(fixture.revived.trace(), row.action),
          0,
          `${row.action}: no forward replay`,
        );
      });
    }
  }
}

// spec 7.4 必测 intent 间窗口：前一 completed 已落盘、下一 intent 尚未开始。
const BETWEEN_INTENT_WINDOWS = Object.freeze([
  {
    state: 'manifest-published',
    expected: 'controller+scheduler+manifest published; controller not loaded',
  },
  {
    state: 'controller-ready',
    expected: 'controller loaded and identity-proven; scheduler not loaded',
  },
]);

async function runBetweenWindowFixture(window) {
  const harness = createLaunchAgentLifecycleHarness();
  const preOperationSnapshot = {
    host: harness.hostSnapshot(),
    bytes: Object.fromEntries(
      ['controller', 'scheduler', 'manifest']
        .map((role) => [role, harness.fileBytes(role)]),
    ),
  };
  harness.armCrashCapture({ kind: 'journal-state', state: window.state, occurrence: 1 });
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const completedResult = await coordinator.install({
    sourceCommit: COMMIT_A,
    scheduleSeconds: 300,
    controllerEnvironment: {},
  });
  const completedReceipt = validateLaunchAgentReceipt(completedResult);
  const image = harness.takeCrashImage();
  return {
    harness,
    image,
    revived: createLaunchAgentLifecycleHarness({ crashImage: image }),
    transactionId: completedReceipt.transactionId,
    originalOperation: 'install',
    preOperationSnapshot,
    completedResult: completedReceipt,
  };
}

function assertBetweenWindowIdentity(fixture, window) {
  const host = fixture.revived.hostSnapshot();
  const completed = fixture.harness.hostSnapshot();
  for (const role of ['controller', 'scheduler', 'manifest']) {
    assert.ok(host[role] !== null, `${window.state}: ${role} published`);
    assert.equal(
      host[role].sha256,
      completed[role].sha256,
      `${window.state}: ${role} sha256`,
    );
  }
  if (window.state === 'manifest-published') {
    assert.deepEqual(host.loaded, { controller: false, scheduler: false }, `${window.state}: loaded`);
    assert.deepEqual(
      host.jobIdentity,
      { controller: null, scheduler: null },
      `${window.state}: jobIdentity`,
    );
    return;
  }
  if (window.state === 'controller-ready') {
    assert.deepEqual(host.loaded, { controller: true, scheduler: false }, `${window.state}: loaded`);
    assert.equal(
      host.jobIdentity.controller,
      host.controller.sha256,
      `${window.state}: controller identity binds the published file`,
    );
    assert.equal(host.jobIdentity.scheduler, null, `${window.state}: scheduler identity`);
    return;
  }
  throw new Error(`unsupported between-intent window: ${window.state}`);
}

for (const window of BETWEEN_INTENT_WINDOWS) {
  test(`business crash fixture is reachable: ${window.state}/intent-between-window`, async () => {
    const fixture = await runBetweenWindowFixture(window);
    const entries = fixture.revived.journalEntries(fixture.transactionId);
    assert.equal(entries.at(-1).state, window.state);
    assert.equal(entries.at(-1).operation, 'install');
    assert.equal(fixture.revived.lockState().transactionLock, true);
    assertBetweenWindowIdentity(fixture, window);
  });
}

if (recoverImplemented) {
  for (const window of BETWEEN_INTENT_WINDOWS) {
    test(`business crash recovery converges to pre-install anchor: ${window.state}`, async () => {
      const fixture = await runBetweenWindowFixture(window);
      fixture.revived.preProveRecoveryLockRelease({ transactionId: fixture.transactionId });
      const coordinator = createLaunchAgentLifecycleCoordinator(fixture.revived.dependencies());
      const receipt = validateLaunchAgentReceipt(
        await coordinator.recover({ transactionId: fixture.transactionId }),
      );
      assert.equal(receipt.operation, fixture.originalOperation);
      assert.equal(receipt.state, 'recovered');
      assert.equal(receipt.success, false);
      assertPreOperationHostState(fixture);
      for (const action of ['bootstrap-controller', 'bootstrap-scheduler']) {
        assert.equal(
          countEvent(fixture.revived.trace(), action),
          0,
          `${window.state}: no forward replay of ${action}`,
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Task 4：闭合 compensation 表、真实 coordinator fixture、20 行 active
// reachability，以及文件尾部 Step 4 的 capability-gated recovery 断言。
// ---------------------------------------------------------------------------

const UPGRADE_COMPENSATION_ACTIONS = Object.freeze([
  'stop-scheduler',
  'stop-controller',
  'restore-manifest',
  'restore-scheduler',
  'restore-controller',
  'load-controller',
  'load-scheduler',
]);

const INSTALL_COMPENSATION_ACTIONS = Object.freeze([
  'stop-scheduler',
  'stop-controller',
  'remove-manifest',
  'remove-scheduler',
  'remove-controller',
]);

const COMPENSATION_CASES = Object.freeze([
  ...UPGRADE_COMPENSATION_ACTIONS.map((action) => ({ action, operation: 'managed-upgrade' })),
  ...INSTALL_COMPENSATION_ACTIONS
    .filter((action) => !UPGRADE_COMPENSATION_ACTIONS.includes(action))
    .map((action) => ({ action, operation: 'install' })),
]);

// 10 行 unique union 必须精确等于生产 contract set。
assert.deepEqual(
  COMPENSATION_CASES.map(({ action }) => action).sort(),
  [
    'load-controller', 'load-scheduler',
    'remove-controller', 'remove-manifest', 'remove-scheduler',
    'restore-controller', 'restore-manifest', 'restore-scheduler',
    'stop-controller', 'stop-scheduler',
  ],
);

function compensationSelectorFor(row, phase) {
  return phase.selectorKind === 'journal-state'
    ? { kind: 'journal-state', state: `compensate-${row.action}-intent`, occurrence: 1 }
    : { kind: 'host-mutation', action: row.action, occurrence: 1 };
}

async function runCompensationFixture(row, selector) {
  const harness = createLaunchAgentLifecycleHarness();
  if (row.operation === 'managed-upgrade') {
    harness.seedInstalled({
      sourceCommit: COMMIT_A,
      loaded: { controller: true, scheduler: true },
    });
    harness.resetObservations();
  } else if (row.operation !== 'install') {
    throw new Error(`unsupported compensation fixture operation: ${row.operation}`);
  }
  // 在 failure 注入、crash capture 与 operation 之前冻结真实 pre-operation
  // anchor，供 gated recovery 断言精确恢复 bytes/hash/loaded/jobIdentity。
  const preOperationSnapshot = {
    host: harness.hostSnapshot(),
    bytes: Object.fromEntries(
      ['controller', 'scheduler', 'manifest']
        .map((role) => [role, harness.fileBytes(role)]),
    ),
  };
  harness.failNextRevalidation('before-commit');
  harness.armCrashCapture(selector);
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const completedResult = row.operation === 'managed-upgrade'
    ? await coordinator.managedUpgrade(upgradeInput())
    : await coordinator.install({
      sourceCommit: COMMIT_A,
      scheduleSeconds: 300,
      controllerEnvironment: {},
    });
  const completedReceipt = validateLaunchAgentReceipt(completedResult);
  const image = harness.takeCrashImage();
  return {
    harness,
    image,
    revived: createLaunchAgentLifecycleHarness({ crashImage: image }),
    transactionId: completedReceipt.transactionId,
    originalOperation: row.operation,
    preOperationSnapshot,
    completedResult: completedReceipt,
  };
}

// 20 行按相位精确分三类。10 行 present file 对冻结 identity 执行精确 inode
// equality：stop-* pre/post 4 行 + remove-* pre 3 行 + restore-* pre 3 行；3 行
// remove-* post 执行精确 absent（file === null）；其余 7 行（restore-* post 3 行与
// load-* pre/post 4 行）冻结的是 prior content/job target，deterministic harness
// 已分配新 inode，按裁决执行 typeof string + 不等式 + 精确 device/sha256/bytes/job
// state。该不等式仅是 harness 关系证据，不声称真实文件系统永不复用旧 inode。
function assertReverseExpected(harness, step, expected, phase) {
  const host = harness.hostSnapshot();
  const file = host[step.role];
  if (expected.file.state === 'absent') {
    assert.equal(file, null, `${step.action}: file absent`);
  } else {
    const restoredWithFreshHarnessInode = step.action.startsWith('load-')
      || (
        step.action.startsWith('restore-')
        && phase === 'mutation-before-completed'
      );
    assert.equal(file?.device, expected.file.identity.device);
    assert.equal(typeof file?.inode, 'string', `${step.action}: inode present`);
    if (restoredWithFreshHarnessInode) {
      assert.notEqual(
        file.inode,
        expected.file.identity.inode,
        `${step.action}: deterministic harness allocates a fresh restore inode`,
      );
    } else {
      assert.equal(file.inode, expected.file.identity.inode);
    }
    assert.equal(file?.sha256, expected.file.sha256);
    assert.equal(harness.sha256(harness.fileBytes(step.role)), expected.file.sha256);
  }
  if (step.role !== 'manifest') {
    const loaded = expected.job.state === 'loaded';
    assert.equal(host.loaded[step.role], loaded, `${step.action}: loaded`);
    assert.equal(host.jobIdentity[step.role], expected.job.identitySha256);
  }
}

for (const row of COMPENSATION_CASES) {
  for (const phase of CRASH_PHASES) {
    test(`compensation crash fixture is reachable: ${row.action}/${phase.phase}`, async () => {
      const fixture = await runCompensationFixture(row, compensationSelectorFor(row, phase));
      const entries = fixture.revived.journalEntries(fixture.transactionId);
      const compensating = entries.find((entry) => entry.state === 'compensating');
      const latest = entries.at(-1);
      const expectedStep = compensating.payload.reversePlan.find(
        (step) => step.action === row.action,
      );
      assert.ok(expectedStep, `${row.action}: reachable frozen step`);
      assert.equal(latest.state, `compensate-${row.action}-intent`);
      assert.equal(latest.payload.action, row.action);
      assert.equal(latest.payload.planIndex, expectedStep.index);
      assert.equal(latest.payload.reversePlanSha256, compensating.payload.reversePlanSha256);
      assert.deepEqual(compensating.payload.reversePlan[expectedStep.index], expectedStep);
      assertReverseExpected(
        fixture.revived,
        expectedStep,
        phase.phase === 'intent-before-mutation'
          ? expectedStep.expectedPre
          : expectedStep.expectedPost,
        phase.phase,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Task 4 Step 4：capability-gated compensation recovery 断言。recover 公开面
// 缺失时本块不注册任何 test，完整计数保持 86/85/1；激活后 10 action × 2 phase
// 必须 resume 同一 hash-bound frozen reverse plan：不产生第二 compensating、
// 不重复已持久化的 side effect，最终回到 pre-operation anchor 并收口 recovered。
// ---------------------------------------------------------------------------

const COMPENSATION_HOST_EVENT_VERB = Object.freeze({
  stop: 'bootout',
  load: 'bootstrap',
  restore: 'publish',
  remove: 'remove',
});

// 当前 compensation action 的宿主 side-effect 必须按真实 trace event 映射，
// 禁止直接统计 semantic action 名。
function compensationHostEventFor(action) {
  const [verb, role] = action.split('-');
  const eventVerb = COMPENSATION_HOST_EVENT_VERB[verb];
  if (eventVerb === undefined) {
    throw new Error(`unsupported compensation action: ${action}`);
  }
  return `${eventVerb}-${role}`;
}

if (recoverImplemented) {
  for (const row of COMPENSATION_CASES) {
    for (const phase of CRASH_PHASES) {
      test(`compensation crash recovery resumes the frozen reverse plan: ${row.action}/${phase.phase}`, async () => {
        const fixture = await runCompensationFixture(row, compensationSelectorFor(row, phase));
        const transactionId = fixture.transactionId;
        const preEntries = fixture.revived.journalEntries(transactionId);
        const frozen = preEntries.find((entry) => entry.state === 'compensating');
        assert.ok(frozen, `${row.action}: frozen compensating entry`);
        const frozenHash = frozen.payload.reversePlanSha256;
        const expectedStep = frozen.payload.reversePlan.find(
          (step) => step.action === row.action,
        );
        assert.ok(expectedStep, `${row.action}: current frozen step`);
        const hostEvent = compensationHostEventFor(row.action);
        const preEventCount = countEvent(fixture.revived.trace(), hostEvent);

        fixture.revived.preProveRecoveryLockRelease({ transactionId });
        const receipt = validateLaunchAgentReceipt(
          await createLaunchAgentLifecycleCoordinator(fixture.revived.dependencies())
            .recover({ transactionId }),
        );
        assert.equal(receipt.operation, fixture.originalOperation);
        assert.equal(receipt.state, 'recovered');
        assert.equal(receipt.success, false);
        assertPreOperationHostState(fixture);

        // post-mutation image 绝不重复当前 side effect；intent image 精确补一次。
        assert.equal(
          countEvent(fixture.revived.trace(), hostEvent),
          phase.phase === 'mutation-before-completed' ? preEventCount : preEventCount + 1,
          `${row.action}/${phase.phase}: host side effect count`,
        );

        // frozen plan 连续性：全 journal 仍只有一个 compensating、一个 plan hash。
        const postEntries = fixture.revived.journalEntries(transactionId);
        const compensatingEntries = postEntries.filter((entry) => entry.state === 'compensating');
        assert.equal(compensatingEntries.length, 1, `${row.action}: no second compensating entry`);
        assert.equal(compensatingEntries[0].payload.reversePlanSha256, frozenHash);
        assert.equal(
          new Set(compensatingEntries.map((entry) => entry.payload.reversePlanSha256)).size,
          1,
          `${row.action}: unique frozen plan hash`,
        );

        // appended checkpoints：先补 current completed，再严格按 frozen 余下 plan
        // 逐 step 追加 intent/completed；不得重建、跳过、重排或重复 current intent。
        const appended = postEntries.slice(preEntries.length)
          .filter((entry) => entry.state.startsWith('compensate-'));
        const remainingSteps = frozen.payload.reversePlan.slice(expectedStep.index + 1);
        assert.deepEqual(
          appended.map((entry) => entry.state),
          [
            `compensate-${row.action}-completed`,
            ...remainingSteps.flatMap((step) => [
              `compensate-${step.action}-intent`,
              `compensate-${step.action}-completed`,
            ]),
          ],
        );
        assert.equal(appended[0].payload.action, row.action);
        for (const [offset, step] of remainingSteps.entries()) {
          const intent = appended[1 + offset * 2];
          const completed = appended[1 + offset * 2 + 1];
          assert.equal(intent.payload.action, step.action);
          assert.equal(intent.payload.planIndex, step.index);
          assert.equal(intent.payload.reversePlanSha256, frozenHash);
          assert.equal(completed.payload.action, step.action);
        }
        assert.equal(postEntries.at(-1).state, 'recovered');
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Task 5 Step 1：真实 terminal committed journal/receipt gap 的 active 观察，
// 以及同一 missing-receipt 场景的 capability-gated embedded receipt/hash 闭合。
// active 测试只记录当前生产事实：committed 终端 journal 仅持 receiptSha256
// 指针、receipt 本体缺失、revived 后零 host mutation；不构成第二 active RED。
// gated 测试在 recover 公开面出现后才注册：要求终端 payload 内嵌 exact
// receipt projection 并与 receiptSha256 哈希闭合，recover 幂等重发同一
// projection，零 host mutation、双锁均释放、不覆盖其它 receipt。
// ---------------------------------------------------------------------------

test('Task 5A.2 terminal committed crash image exposes the missing-receipt gap', async () => {
  const fixture = await captureInstallImage({
    kind: 'journal-state', state: 'committed', occurrence: 1,
  });
  const latest = fixture.revived.journalEntries(fixture.transactionId).at(-1);
  assert.equal(latest.state, 'committed');
  assert.equal(fixture.revived.receiptFor(fixture.transactionId), null);
  assert.equal(typeof latest.payload.receiptSha256, 'string');
  assert.equal(Object.hasOwn(latest.payload, 'receipt'), false);
  assert.equal(fixture.revived.sentinels().hostMutationCount, 0);
});

if (recoverImplemented) {
  test('Task 5A.2 recover republishes the exact embedded terminal receipt projection', async () => {
    const fixture = await captureInstallImage({
      kind: 'journal-state', state: 'committed', occurrence: 1,
    });
    const { revived, transactionId, completed } = fixture;
    const latest = revived.journalEntries(transactionId).at(-1);
    assert.equal(latest.state, 'committed');
    assert.equal(
      Object.hasOwn(latest.payload, 'receipt'),
      true,
      'terminal journal must embed the exact receipt projection',
    );
    const embedded = validateLaunchAgentReceipt(latest.payload.receipt);
    const embeddedSha256 = createHash('sha256')
      .update(JSON.stringify(embedded), 'utf8')
      .digest('hex');
    assert.equal(embeddedSha256, latest.payload.receiptSha256);
    assert.deepEqual(embedded, completed);
    assert.equal(revived.receiptFor(transactionId), null);
    assert.equal(revived.sentinels().hostMutationCount, 0);

    revived.preProveRecoveryLockRelease({ transactionId });
    const receipt = validateLaunchAgentReceipt(
      await createLaunchAgentLifecycleCoordinator(revived.dependencies())
        .recover({ transactionId }),
    );
    assert.deepEqual(receipt, embedded);
    assert.deepEqual(revived.receiptFor(transactionId), embedded);
    assert.equal(receipt.operation, embedded.operation);
    assert.equal(receipt.state, 'committed');
    assert.equal(receipt.success, true);
    assert.equal(revived.sentinels().hostMutationCount, 0);
    assert.deepEqual(revived.lockState(), {
      transactionLock: false,
      manualInterventionLock: false,
    });
    assert.deepEqual(revived.receiptTransactionIds(), [transactionId]);
    assert.equal(countEvent(revived.trace(), 'receipt'), 1);
  });
}

// ---------------------------------------------------------------------------
// Task 5 Step 2：capability-gated terminal receipt variants（plan case 2-4；
// case 1 missing receipt 已由上方 Task 5 Step 1 gated 测试覆盖，禁止重复）。
// recover 公开面缺失时本块不注册任何 test，完整计数保持 87/86/1。激活后必须
// 证明：seeded exact receipt 幂等返回且零新 publish；no-clobber race 下
// coordinator 重读并接受 exact embedded projection；conflicting receipt 绝不
// 覆盖/修复，classify MIR 且 ordinary lock release/seam 从未发生。
// ---------------------------------------------------------------------------

if (recoverImplemented) {
  test('Task 5A.2 recover returns the exact already-existing seeded receipt idempotently', async () => {
    const harness = createLaunchAgentLifecycleHarness();
    const seed = harness.seedInstalled({ sourceCommit: COMMIT_A });
    const transactionId = seed.transactionId;
    const terminal = harness.journalEntries(transactionId).at(-1);
    assert.equal(terminal.state, 'committed');
    const existing = harness.receiptFor(transactionId);
    assert.ok(existing, 'seedInstalled must persist a real committed receipt');
    const existingSha256 = createHash('sha256')
      .update(JSON.stringify(existing), 'utf8')
      .digest('hex');
    assert.equal(existingSha256, terminal.payload.receiptSha256);
    assert.equal(existing.operation, terminal.operation);
    assert.equal(existing.state, terminal.state);
    assert.equal(existing.hostMutationCount, terminal.payload.hostMutationCount);
    harness.resetObservations();
    const idsBefore = harness.receiptTransactionIds();
    assert.deepEqual(idsBefore, [transactionId]);

    const receipt = validateLaunchAgentReceipt(
      await createLaunchAgentLifecycleCoordinator(harness.dependencies())
        .recover({ transactionId }),
    );
    assert.deepEqual(receipt, existing);
    assert.equal(receipt.operation, 'install');
    assert.equal(receipt.state, 'committed');
    assert.equal(receipt.success, true);
    assert.deepEqual(harness.receiptFor(transactionId), existing);
    assert.deepEqual(harness.receiptTransactionIds(), idsBefore);
    assert.equal(harness.sentinels().hostMutationCount, 0);
    assert.deepEqual(harness.lockState(), {
      transactionLock: false,
      manualInterventionLock: false,
    });
    assert.equal(
      countEvent(harness.trace(), 'receipt'),
      0,
      'idempotent return must not republish the receipt',
    );
  });

  test('Task 5A.2 recover re-reads the exact receipt after a no-clobber publish race', async () => {
    const fixture = await captureInstallImage({
      kind: 'journal-state', state: 'committed', occurrence: 1,
    });
    const { revived, transactionId } = fixture;
    const latest = revived.journalEntries(transactionId).at(-1);
    assert.equal(latest.state, 'committed');
    assert.equal(
      Object.hasOwn(latest.payload, 'receipt'),
      true,
      'terminal journal must embed the exact receipt projection',
    );
    const embedded = validateLaunchAgentReceipt(latest.payload.receipt);
    const embeddedSha256 = createHash('sha256')
      .update(JSON.stringify(embedded), 'utf8')
      .digest('hex');
    assert.equal(embeddedSha256, latest.payload.receiptSha256);
    assert.equal(revived.receiptFor(transactionId), null);
    assert.equal(revived.sentinels().hostMutationCount, 0);

    revived.raceExactTerminalReceiptOnNextPublish({ transactionId });
    revived.preProveRecoveryLockRelease({ transactionId });
    const receipt = validateLaunchAgentReceipt(
      await createLaunchAgentLifecycleCoordinator(revived.dependencies())
        .recover({ transactionId }),
    );
    assert.deepEqual(receipt, embedded);
    assert.deepEqual(revived.receiptFor(transactionId), embedded);
    assert.equal(receipt.operation, embedded.operation);
    assert.equal(receipt.state, 'committed');
    assert.equal(receipt.success, true);
    assert.equal(revived.sentinels().hostMutationCount, 0);
    assert.deepEqual(revived.lockState(), {
      transactionLock: false,
      manualInterventionLock: false,
    });
    assert.deepEqual(revived.receiptTransactionIds(), [transactionId]);
    // no-clobber 证明：receipt 由 helper race injection 抢先落盘，正常 publish
    // 路径从未成功；coordinator 必须重读并接受 exact receipt，不得把 injection
    // 伪装成一次新的 receipt publish。
    assert.equal(countEvent(revived.trace(), 'receipt'), 0);
    assert.equal(countEvent(revived.trace(), 'recovery-lock-seam'), 1);
    assert.ok(
      revived.adapterCalls().filter((call) => call.name === 'read-receipt').length >= 1,
      'coordinator must re-read the raced receipt instead of publishing over it',
    );
  });

  test('Task 5A.2 recover classifies a conflicting terminal receipt as manual-intervention-required', async () => {
    const fixture = await captureInstallImage({
      kind: 'journal-state', state: 'committed', occurrence: 1,
    });
    const {
      revived, image, transactionId, completed,
    } = fixture;
    await revived.dependencies().metadataStore.publishReceipt({
      receipt: completed,
      lockRef: lockRefFromImage(image),
    });
    const misaligned = revived.misalignReceiptHashFor(transactionId);
    const terminal = revived.journalEntries(transactionId).at(-1);
    assert.notEqual(
      misaligned.sha256,
      terminal.payload.receiptSha256,
      'receipt must genuinely conflict with the terminal journal',
    );
    const conflicting = revived.receiptFor(transactionId);
    assert.equal(conflicting.sourceCommit, COMMIT_B);
    const idsBefore = revived.receiptTransactionIds();
    const hostBefore = revived.hostSnapshot();
    revived.resetObservations();

    // 禁止 preProve ordinary release：conflicting receipt 必须走 MIR takeover。
    const receipt = validateLaunchAgentReceipt(
      await createLaunchAgentLifecycleCoordinator(revived.dependencies())
        .recover({ transactionId }),
    );
    assert.equal(receipt.state, 'manual-intervention-required');
    assert.equal(receipt.success, false);
    assert.equal(receipt.operation, terminal.operation);
    assert.deepEqual(
      revived.receiptFor(transactionId),
      conflicting,
      'conflicting receipt must not be overwritten or healed',
    );
    assert.deepEqual(revived.receiptTransactionIds(), idsBefore);
    assert.deepEqual(revived.hostSnapshot(), hostBefore);
    assert.equal(revived.sentinels().hostMutationCount, 0);
    assert.equal(revived.journalStates(transactionId).at(-1), 'manual-intervention-required');
    assert.deepEqual(revived.lockState(), {
      transactionLock: false,
      manualInterventionLock: true,
    });
    const trace = revived.trace();
    assert.equal(countEvent(trace, 'mir-lock-publish'), 1);
    assert.equal(countEvent(trace, 'mir-lock-verify'), 1);
    assert.equal(countEvent(trace, 'mir-transaction-lock-release'), 1);
    assert.equal(countEvent(trace, 'recovery-lock-seam'), 0);
    assert.equal(countEvent(trace, 'lock-release'), 0);
    assert.equal(countEvent(trace, 'receipt'), 0);
  });
}

// ---------------------------------------------------------------------------
// Task 5 Step 3：capability-gated 四行 fail-closed representative MIR rows
// （amended plan Task 5 Step 3；本块不执行 Step 4-5）。recover 公开面缺失时
// 本块不注册任何 test，完整计数保持 87/86/1。每行复用真实 runBusinessFixture/
// runCompensationFixture 与 reachable selector，在 revived crash image 上、
// recover 之前施加既有 deterministic fault seam，证明 recover 必须 fail-closed：
// classify MIR、冻结 receipt、不产生第二 compensation plan/hash。严禁 MIR lock
// handoff/takeover/release 断言（parent plan Step 5 域），本块不断言任何锁状态。
// ---------------------------------------------------------------------------

// 共同契约（amended plan Task 5 Step 3 逐字语义 + operation 保持断言）：MIR 收口、
// receipt 不被覆盖、不产生第二 compensation plan/hash、journal 以 MIR 结尾。
function assertFailClosedMirContract(fixture, receiptBefore, result) {
  const { revived, transactionId } = fixture;
  assert.equal(result.state, 'manual-intervention-required');
  assert.equal(result.success, false);
  assert.equal(result.operation, fixture.originalOperation);
  assert.notEqual(result.operation, 'recover');
  assert.deepEqual(revived.receiptFor(transactionId), receiptBefore);
  const afterEntries = revived.journalEntries(transactionId);
  const planEntries = afterEntries.filter((entry) => entry.state === 'compensating');
  assert.ok(planEntries.length <= 1, 'must not create a second compensation plan');
  assert.ok(new Set(planEntries.map((entry) => entry.payload.reversePlanSha256)).size <= 1);
  assert.equal(afterEntries.at(-1).state, 'manual-intervention-required');
}

// 前三行共用：fail-closed 必须零 host mutation，宿主快照（含已施加 fault）逐字段冻结。
function assertZeroMutationFrozenHost(fixture, hostBefore) {
  assert.equal(
    fixture.revived.sentinels().hostMutationCount,
    0,
    'fail-closed 必须零 host mutation',
  );
  assert.deepEqual(
    fixture.revived.hostSnapshot(),
    hostBefore,
    'fail-closed 不得改变任何宿主状态',
  );
}

// host trace 闭合词汇：文件 inspect/read、launchctl print、health 与全部 mutation
// 事件；journal/receipt/lock 等 metadata 事件不属于 host event。仅用于最终失败
// revalidation/MIR journal 之后“无任何 host event”的明确分类断言。
const FAIL_CLOSED_HOST_EVENT_SET = new Set([
  ...HOST_MUTATION_EVENTS,
  'inspect',
  'inspect-job-controller', 'inspect-job-scheduler',
  'verify-job-controller', 'verify-job-scheduler',
  'verify-scheduler-outcome', 'health-controller',
]);

if (recoverImplemented) {
  test('Task 5A.2 recover fail-closed MIR: mixed file identity from driftHostFile', async () => {
    // stop intent-before-mutation 窗口：三个文件与两个 loaded job 全部真实存在，
    // recovery union precheck 必须逐一核对身份，drift fault 必被消费。
    const row = { intent: 'scheduler-stop-intent', action: 'bootout-scheduler', operation: 'stop' };
    const fixture = await runBusinessFixture(row, selectorFor(row, CRASH_PHASES[0]));
    const { revived, transactionId } = fixture;
    const entries = revived.journalEntries(transactionId);
    assert.equal(entries.at(-1).state, row.intent);
    assert.equal(entries.at(-1).operation, 'stop');
    const windowHost = revived.hostSnapshot();
    assert.ok(windowHost.controller !== null && windowHost.scheduler !== null);
    assert.ok(windowHost.manifest !== null);
    assert.deepEqual(windowHost.loaded, { controller: true, scheduler: true });
    assert.ok(windowHost.jobIdentity.controller !== null && windowHost.jobIdentity.scheduler !== null);
    assert.equal(windowHost.scheduler.sha256, fixture.preOperationSnapshot.host.scheduler.sha256);

    revived.driftHostFile('scheduler');
    const driftedSha256 = revived.hostSnapshot().scheduler.sha256;
    assert.notEqual(
      driftedSha256,
      fixture.preOperationSnapshot.host.scheduler.sha256,
      'drift 必须真实改变 scheduler 文件身份',
    );
    const driftedBytes = revived.fileBytes('scheduler');

    const receiptBefore = revived.receiptFor(transactionId);
    assert.equal(receiptBefore, null, '非终端窗口不存在既有 receipt');
    const hostBefore = revived.hostSnapshot();
    revived.preProveRecoveryLockRelease({ transactionId });
    const result = validateLaunchAgentReceipt(
      await createLaunchAgentLifecycleCoordinator(revived.dependencies())
        .recover({ transactionId }),
    );

    assertFailClosedMirContract(fixture, receiptBefore, result);
    assertZeroMutationFrozenHost(fixture, hostBefore);
    assert.deepEqual(
      revived.fileBytes('scheduler'),
      driftedBytes,
      'fail-closed 不得修复或回滚 drifted scheduler 文件',
    );
    assert.equal(revived.hostSnapshot().scheduler.sha256, driftedSha256);
  });

  test('Task 5A.2 recover fail-closed MIR: unknown job probe from setProbeMode', async () => {
    // 同一 stop 窗口：controller job 真实 loaded 且持有身份，union precheck 必须
    // probe controller；unknown 结果使身份无法证明，必须 fail-closed。
    const row = { intent: 'scheduler-stop-intent', action: 'bootout-scheduler', operation: 'stop' };
    const fixture = await runBusinessFixture(row, selectorFor(row, CRASH_PHASES[0]));
    const { revived, transactionId } = fixture;
    assert.equal(revived.journalEntries(transactionId).at(-1).state, row.intent);
    const windowHost = revived.hostSnapshot();
    assert.equal(windowHost.loaded.controller, true, 'controller job 必须真实 loaded，probe fault 才可消费');
    assert.ok(windowHost.jobIdentity.controller !== null);
    assert.equal(windowHost.loaded.scheduler, true);
    assert.ok(windowHost.jobIdentity.scheduler !== null);

    revived.setProbeMode('controller', 'unknown');

    const receiptBefore = revived.receiptFor(transactionId);
    assert.equal(receiptBefore, null, '非终端窗口不存在既有 receipt');
    const hostBefore = revived.hostSnapshot();
    revived.preProveRecoveryLockRelease({ transactionId });
    const result = validateLaunchAgentReceipt(
      await createLaunchAgentLifecycleCoordinator(revived.dependencies())
        .recover({ transactionId }),
    );

    assertFailClosedMirContract(fixture, receiptBefore, result);
    assertZeroMutationFrozenHost(fixture, hostBefore);
    // seam 消费证据：revived printPhase 从 inspect 起步，controller print 必产生
    // inspect/verify-job-controller 事件；该窗口除此之外无任何可致 MIR 的宿主异常。
    const trace = revived.trace();
    assert.ok(
      countEvent(trace, 'inspect-job-controller') + countEvent(trace, 'verify-job-controller') >= 1,
      'recover 必须真实 probe controller job 并消费 unknown fault',
    );
  });

  test('Task 5A.2 recover fail-closed MIR: conditional CAS mismatch from failNextAtomicExpectedValidation', async () => {
    // managed-upgrade frozen plan 当前 step 即 restore-controller：recover 续跑时的
    // 下一 compensation host action 必为 replace controller，armed CAS seam 必被消费。
    const row = { action: 'restore-controller', operation: 'managed-upgrade' };
    const fixture = await runCompensationFixture(row, compensationSelectorFor(row, CRASH_PHASES[0]));
    const { revived, transactionId } = fixture;
    const entries = revived.journalEntries(transactionId);
    const frozen = entries.find((entry) => entry.state === 'compensating');
    assert.ok(frozen, 'frozen compensating entry');
    const stepIndex = frozen.payload.reversePlan.findIndex((step) => step.action === row.action);
    assert.ok(stepIndex >= 0, 'restore-controller 必须是 frozen plan 的真实 step');
    const latest = entries.at(-1);
    assert.equal(latest.state, 'compensate-restore-controller-intent');
    assert.equal(latest.payload.action, row.action);
    assert.equal(latest.payload.planIndex, stepIndex);
    assert.equal(latest.payload.reversePlanSha256, frozen.payload.reversePlanSha256);
    assert.ok(revived.hostSnapshot().controller !== null, 'replace 目标 controller 文件真实存在');

    revived.failNextAtomicExpectedValidation('replace', 'controller');

    const receiptBefore = revived.receiptFor(transactionId);
    assert.equal(receiptBefore, null, '非终端窗口不存在既有 receipt');
    const hostBefore = revived.hostSnapshot();
    revived.preProveRecoveryLockRelease({ transactionId });
    const result = validateLaunchAgentReceipt(
      await createLaunchAgentLifecycleCoordinator(revived.dependencies())
        .recover({ transactionId }),
    );

    assertFailClosedMirContract(fixture, receiptBefore, result);
    assertZeroMutationFrozenHost(fixture, hostBefore);
    // seam 消费证据：replace controller 的 atomic expected validation 恰好发生一次，
    // 且失败必须先于任何 controller mutation。
    const attempts = revived.atomicExpectedAttempts()
      .filter((attempt) => attempt.operation === 'replace' && attempt.role === 'controller');
    assert.equal(attempts.length, 1, 'armed CAS seam 必须被下一次 replace controller 真实消费');
    assert.equal(
      countEvent(revived.trace(), 'publish-controller'),
      0,
      'CAS 失败必须先于任何 controller mutation',
    );
  });

  test('Task 5A.2 recover fail-closed MIR: final verification failure from failNextRevalidation', async () => {
    // install frozen plan 最后一步即 remove-controller：recover 续完同一 frozen plan
    // 后必然进入 compensate-before-close 最终验证，armed revalidation seam 必被消费。
    const row = { action: 'remove-controller', operation: 'install' };
    const fixture = await runCompensationFixture(row, compensationSelectorFor(row, CRASH_PHASES[0]));
    const { revived, transactionId } = fixture;
    const entries = revived.journalEntries(transactionId);
    const frozen = entries.find((entry) => entry.state === 'compensating');
    assert.ok(frozen, 'frozen compensating entry');
    const lastStep = frozen.payload.reversePlan.at(-1);
    assert.equal(lastStep.action, row.action, 'remove-controller 必须是 install frozen plan 最后一步');
    const latest = entries.at(-1);
    assert.equal(latest.state, 'compensate-remove-controller-intent');
    assert.equal(latest.payload.action, row.action);
    assert.equal(latest.payload.planIndex, lastStep.index);
    assert.equal(latest.payload.reversePlanSha256, frozen.payload.reversePlanSha256);
    assert.ok(revived.hostSnapshot().controller !== null, 'remove 目标 controller 文件真实存在');

    revived.failNextRevalidation('compensate-before-close');

    const receiptBefore = revived.receiptFor(transactionId);
    assert.equal(receiptBefore, null, '非终端窗口不存在既有 receipt');
    revived.preProveRecoveryLockRelease({ transactionId });
    const result = validateLaunchAgentReceipt(
      await createLaunchAgentLifecycleCoordinator(revived.dependencies())
        .recover({ transactionId }),
    );

    assertFailClosedMirContract(fixture, receiptBefore, result);

    // 允许已完成的 frozen reverse-plan mutation：恰好 remove-controller 一次。
    assert.equal(revived.sentinels().hostMutationCount, 1, '仅 frozen 最后一步 remove 已完成');
    assert.equal(countEvent(revived.trace(), 'remove-controller'), 1);
    assert.equal(revived.hostSnapshot().controller, null, 'frozen 最后一步 remove 必须已完成');

    // seam 消费证据：最后一次 revalidation 即失败的 compensate-before-close。
    const marks = revived.sentinels().revalidateMarks;
    assert.equal(marks.at(-1), 'compensate-before-close', '最终失败 revalidation 必须被真实消费');
    assert.equal(marks.filter((mark) => mark === 'compensate-before-close').length, 1);

    // trace 顺序证明：最终失败 revalidation/MIR journal 之后没有任何 host event。
    // compensate-before-close 只在 frozen plan 全部完成后运行，故最后一条
    // compensation completed 之后不得出现任何 host/plan 事件。
    const trace = revived.trace();
    let completedIndex = -1;
    for (const [index, event] of trace.entries()) {
      if (
        event !== null && typeof event === 'object'
        && event.kind === 'compensation'
        && event.action === row.action
        && event.phase === 'completed'
      ) {
        completedIndex = index;
      }
    }
    assert.ok(completedIndex >= 0, 'frozen 最后一步 completed 必须真实落在 trace');
    for (const event of trace.slice(completedIndex + 1)) {
      const label = typeof event === 'string' ? event : `${event?.kind}:${event?.action}/${event?.phase}`;
      assert.equal(typeof event, 'string', `最终验证之后不得出现 compensation plan event: ${label}`);
      assert.ok(
        !FAIL_CLOSED_HOST_EVENT_SET.has(event),
        `最终失败 revalidation/MIR journal 之后不得出现 host event: ${label}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Task 5 Step 4：capability-gated exact input 与 hostile-object 拒绝
// （amended plan Task 5 Step 4；本块不执行 Step 5 privacy/schema/original-
// operation）。recover 公开面缺失时本块不注册任何 test，完整计数保持
// 87/86/1。recover 必须在任何依赖/adapter 调用、任何 host mutation 之前
// 完成 exact input 校验：非法输入只能以 code 与 message 均精确等于
// launchagent-lifecycle-invalid 的闭合契约错误拒绝，系统逐字节保持原样。
// ---------------------------------------------------------------------------

if (recoverImplemented) {
  test('Task 5A.2 exact input and hostile-object rejection touches nothing', async () => {
    // install controller-publish-intent journal-state occurrence 1：非终端、
    // 真实可达 crash 窗口。输入校验先于一切依赖调用，故本块禁止
    // preProveRecoveryLockRelease，窗口持有的事务锁原样保留。
    const fixture = await captureInstallImage({
      kind: 'journal-state', state: 'controller-publish-intent', occurrence: 1,
    });
    const { revived } = fixture;
    const validId = fixture.transactionId;
    const coordinator = createLaunchAgentLifecycleCoordinator(revived.dependencies());

    // 表驱动只搬运输入引用：不得克隆、展开、序列化或读取输入内部属性，
    // 否则 hostile getter 会被测试自身触发，丧失“recover 从未读取”的证明力。
    let getterCalls = 0;
    const getterInput = Object.defineProperty({}, 'transactionId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return validId;
      },
    });
    const symbolInput = Object.defineProperty(
      { transactionId: validId },
      Symbol('transactionId'),
      { enumerable: true, value: 'hostile' },
    );
    const cases = [
      { name: 'null', input: null },
      { name: 'empty plain object', input: {} },
      { name: 'non-uuid transactionId', input: { transactionId: 'not-a-uuid' } },
      { name: 'extra sourceCommit key', input: { transactionId: validId, sourceCommit: COMMIT_A } },
      { name: 'extra operation key', input: { transactionId: validId, operation: 'install' } },
      { name: 'extra approved key', input: { transactionId: validId, approved: true } },
      { name: 'null-prototype object', input: Object.create(null) },
      { name: 'hostile own enumerable transactionId getter', input: getterInput },
      { name: 'own enumerable symbol key', input: symbolInput },
    ];

    for (const { name, input } of cases) {
      assert.deepEqual(
        revived.adapterCalls(),
        [],
        `adapterCalls 调用前必须精确为空: ${name}`,
      );
      assert.equal(
        revived.sentinels().hostMutationCount,
        0,
        `hostMutationCount 调用前必须为 0: ${name}`,
      );
      const before = durableBytesSnapshot(revived, [validId]);
      // async 包装同时覆盖同步 throw 与异步 reject；code/message 必须逐字
      // 精确命中闭合 invalid 契约，禁止正则放宽。
      await assert.rejects(
        async () => coordinator.recover(input),
        (error) => {
          assert.equal(error?.code, 'launchagent-lifecycle-invalid', `code: ${name}`);
          assert.equal(error?.message, 'launchagent-lifecycle-invalid', `message: ${name}`);
          return true;
        },
        `case 必须拒绝: ${name}`,
      );
      assert.deepEqual(revived.adapterCalls(), [], `adapterCalls 必须精确为空: ${name}`);
      assert.equal(revived.sentinels().hostMutationCount, 0, `hostMutationCount: ${name}`);
      assert.equal(getterCalls, 0, `transactionId getter 必须始终未被调用: ${name}`);
      assert.equal(
        durableBytesSnapshot(revived, [validId]),
        before,
        `journal/receipt/host/locks/trace/adapterCalls/sentinels 必须逐字节冻结: ${name}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Task 5 Step 5：capability-gated original-operation、闭合 receipt schema 与
// 隐私断言（amended plan Task 5 Step 5；本块不执行 Step 6 验证，不断言任何
// MIR/lock takeover/handoff）。recover 公开面缺失时本块不注册任何 test，
// 完整计数保持 87/86/1。五类真实可达 crash recovery fixture（install、
// managed-upgrade、stop、uninstall、rollback）在 revived crash image 上先
// preProveRecoveryLockRelease，再执行真实 recover；最终 receipt 必须保持原
// operation（普通恢复绝不改写为 recover）、own keys 精确等于闭合 11 字段，
// 且公开 projection 不含路径、HOME、用户名、进程输出、环境变量、凭证或
// 自由文本 exception。
// ---------------------------------------------------------------------------

// closed receipt checker（parent plan Task 5 Step 5 逐字逻辑）：只递归扫描公开
// receipt projection，不扫描 journal/crash image/内部 fixture；key 仅拒绝精确
// 闭合集合（大小写无关），字符串仅拒绝绝对路径、$HOME 与 harness 异常文本，
// 不做会误伤合法 lifecycle 公开标识符的宽泛扫描。
function assertSafeReceiptProjection(value) {
  const forbiddenKey = /^(?:path|home|username|stdout|stderr|argv|environment|token|secret|message)$/iu;
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, nested] of Object.entries(node)) {
        assert.equal(forbiddenKey.test(key), false, `forbidden receipt key: ${key}`);
        visit(nested);
      }
      return;
    }
    if (typeof node === 'string') {
      assert.equal(node.startsWith('/'), false, 'absolute path in receipt');
      assert.equal(node.includes('$HOME'), false, 'HOME token in receipt');
      assert.equal(node.includes('launchagent-harness:'), false, 'exception text in receipt');
    }
  };
  visit(value);
}

// rollback 极窄 fixture（无既有业务/compensation fixture 可复用）：真实
// createUpgradeTarget 后 resetObservations，arm 首个 scheduler-stop-intent
// 窗口，用同一 coordinator 执行真实 rollback 至 completed 并取 crash image；
// 不得手工 seed journal。窗口已实证可达：latest 为 scheduler-stop-intent/
// rollback、stale transaction lock 存在、hostMutationCount=0。
async function runRollbackRecoveryFixture() {
  const { harness, coordinator, target } = await createUpgradeTarget();
  harness.resetObservations();
  harness.armCrashCapture({ kind: 'journal-state', state: 'scheduler-stop-intent', occurrence: 1 });
  const completed = validateLaunchAgentReceipt(
    await coordinator.rollback(rollbackInput(target.anchorId)),
  );
  assert.equal(completed.operation, 'rollback');
  assert.equal(completed.state, 'committed');
  const image = harness.takeCrashImage();
  return {
    revived: createLaunchAgentLifecycleHarness({ crashImage: image }),
    transactionId: completed.transactionId,
    originalOperation: 'rollback',
  };
}

// 每个 recovery receipt 的统一断言：operation 精确等于原 operation 且绝不为
// recover；own keys 精确等于闭合 11 字段；公开 projection 通过 closed checker。
// 失败消息一律带 original operation。
function assertRecoveryReceiptContract(receipt, originalOperation) {
  assert.equal(
    receipt.operation,
    originalOperation,
    `recovery receipt operation 必须等于原 operation: ${originalOperation}`,
  );
  assert.notEqual(
    receipt.operation,
    'recover',
    `普通恢复不得把 operation 改写为 recover: ${originalOperation}`,
  );
  assert.deepEqual(
    Reflect.ownKeys(receipt).sort(),
    [
      'anchorId', 'completedAt', 'hostMutationCount', 'operation', 'outcome',
      'roles', 'schemaVersion', 'sourceCommit', 'state', 'success', 'transactionId',
    ].sort(),
    `recovery receipt own keys 必须精确等于闭合 11 字段: ${originalOperation}`,
  );
  assertSafeReceiptProjection(receipt);
}

if (recoverImplemented) {
  test('Task 5A.2 receipt original-operation, schema and privacy hold across crash recovery fixtures', async (t) => {
    const installRow = { intent: 'controller-publish-intent', action: 'publish-controller', operation: 'install' };
    const upgradeRow = { action: 'restore-controller', operation: 'managed-upgrade' };
    const stopRow = { intent: 'scheduler-stop-intent', action: 'bootout-scheduler', operation: 'stop' };
    const uninstallRow = { intent: 'scheduler-remove-intent', action: 'remove-scheduler', operation: 'uninstall' };
    const cases = [
      { operation: 'install', run: () => runBusinessFixture(installRow, selectorFor(installRow, CRASH_PHASES[0])) },
      { operation: 'managed-upgrade', run: () => runCompensationFixture(upgradeRow, compensationSelectorFor(upgradeRow, CRASH_PHASES[0])) },
      { operation: 'stop', run: () => runBusinessFixture(stopRow, selectorFor(stopRow, CRASH_PHASES[0])) },
      { operation: 'uninstall', run: () => runBusinessFixture(uninstallRow, selectorFor(uninstallRow, CRASH_PHASES[0])) },
      { operation: 'rollback', run: () => runRollbackRecoveryFixture() },
    ];
    for (const { operation, run } of cases) {
      await t.test(`${operation}: receipt keeps original operation, closed schema and privacy`, async () => {
        const fixture = await run();
        const { revived, transactionId } = fixture;
        revived.preProveRecoveryLockRelease({ transactionId });
        const receipt = validateLaunchAgentReceipt(
          await createLaunchAgentLifecycleCoordinator(revived.dependencies())
            .recover({ transactionId }),
        );
        assertRecoveryReceiptContract(receipt, fixture.originalOperation);
      });
    }
  });
}
