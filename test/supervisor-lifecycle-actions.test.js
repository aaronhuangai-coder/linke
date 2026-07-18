import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSupervisorLifecycleApplyPlan } from '../src/supervisor-lifecycle.js';
import {
  SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS,
  isSupervisorLifecycleOperation,
  listSupervisorLifecycleActionIds,
  isSupervisorLifecycleActionForOperation,
} from '../src/supervisor-lifecycle-actions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ACTIONS_SRC = join(ROOT, 'src/supervisor-lifecycle-actions.js');
const LIFECYCLE_SRC = join(ROOT, 'src/supervisor-lifecycle.js');

const EXPECTED_OPERATIONS = Object.freeze([
  'install',
  'uninstall',
  'rollback',
  'recover',
]);

const EXPECTED_ACTION_IDS = Object.freeze({
  install: Object.freeze([
    'render-launch-agent-plist',
    'write-launch-agent-plist',
    'load-launch-agent',
  ]),
  uninstall: Object.freeze([
    'unload-launch-agent',
    'remove-launch-agent-plist',
    'remove-supervisor-metadata',
  ]),
  rollback: Object.freeze([
    'capture-current-state',
    'restore-previous-plist',
    'restart-previous-supervisor',
  ]),
  recover: Object.freeze([
    'start-recovery-supervisor',
  ]),
});

const ALL_ACTION_IDS = Object.freeze(
  EXPECTED_OPERATIONS.flatMap((operation) => EXPECTED_ACTION_IDS[operation]),
);

const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'macbook-alpha',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});

const BASELINE_ACTIONS = Object.freeze({
  install: Object.freeze([
    Object.freeze({
      id: 'render-launch-agent-plist',
      description: 'Render a launch agent plist preview.',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    }),
    Object.freeze({
      id: 'write-launch-agent-plist',
      description: 'Future apply would write a launch agent plist after all gates pass.',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    }),
    Object.freeze({
      id: 'load-launch-agent',
      description: 'Future apply would ask launchd to load the launch agent.',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    }),
  ]),
  uninstall: Object.freeze([
    Object.freeze({
      id: 'unload-launch-agent',
      description: 'Future apply would ask launchd to unload the launch agent.',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    }),
    Object.freeze({
      id: 'remove-launch-agent-plist',
      description: 'Future apply would remove the launch agent plist.',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    }),
    Object.freeze({
      id: 'remove-supervisor-metadata',
      description: 'Future apply would remove supervisor lifecycle metadata.',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    }),
  ]),
  rollback: Object.freeze([
    Object.freeze({
      id: 'capture-current-state',
      description: 'Future apply would capture current state before rollback.',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    }),
    Object.freeze({
      id: 'restore-previous-plist',
      description: 'Future apply would restore the previous launch agent plist.',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    }),
    Object.freeze({
      id: 'restart-previous-supervisor',
      description: 'Future apply would restart the previous supervisor.',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    }),
  ]),
  recover: Object.freeze([
    Object.freeze({
      id: 'start-recovery-supervisor',
      description: 'Recovery supervisor lifecycle is not designed in V0.88.',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    }),
  ]),
});

describe('supervisor-lifecycle-actions pure SoT', () => {
  it('exports exact 4 operations and 10 ordered action IDs as a deep-frozen map', () => {
    assert.deepEqual(Object.keys(SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS), [...EXPECTED_OPERATIONS]);
    assert.equal(ALL_ACTION_IDS.length, 10);

    for (const operation of EXPECTED_OPERATIONS) {
      assert.deepEqual(
        SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS[operation],
        EXPECTED_ACTION_IDS[operation],
      );
      assert.ok(Object.isFrozen(SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS[operation]));
    }
    assert.ok(Object.isFrozen(SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS));
  });

  it('isSupervisorLifecycleOperation is exact string membership only', () => {
    for (const operation of EXPECTED_OPERATIONS) {
      assert.equal(isSupervisorLifecycleOperation(operation), true);
    }

    const invalids = [
      null,
      undefined,
      0,
      1,
      true,
      false,
      [],
      {},
      Symbol('install'),
      'Install',
      'INSTALL',
      ' install',
      'install ',
      'install\n',
      'uninstal',
      'audit',
      'restart',
      '',
      'install\0',
    ];
    for (const value of invalids) {
      assert.equal(isSupervisorLifecycleOperation(value), false, `expected false for ${String(value)}`);
    }
  });

  it('listSupervisorLifecycleActionIds returns ordered safe copies and fails closed', () => {
    for (const operation of EXPECTED_OPERATIONS) {
      const first = listSupervisorLifecycleActionIds(operation);
      assert.deepEqual(first, EXPECTED_ACTION_IDS[operation]);
      assert.notEqual(first, SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS[operation]);
      first.push('mutated-by-caller');
      first[0] = 'mutated-id';
      const second = listSupervisorLifecycleActionIds(operation);
      assert.deepEqual(second, EXPECTED_ACTION_IDS[operation]);
      assert.deepEqual(
        SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS[operation],
        EXPECTED_ACTION_IDS[operation],
      );
    }

    const invalids = [
      null,
      undefined,
      0,
      true,
      [],
      {},
      Symbol('install'),
      'Install',
      ' install',
      'install ',
      'audit',
      'restart',
      '',
    ];
    for (const value of invalids) {
      assert.deepEqual(listSupervisorLifecycleActionIds(value), []);
    }
  });

  it('isSupervisorLifecycleActionForOperation covers full valid/invalid matrix fail-closed', () => {
    for (const operation of EXPECTED_OPERATIONS) {
      for (const actionId of EXPECTED_ACTION_IDS[operation]) {
        assert.equal(isSupervisorLifecycleActionForOperation(operation, actionId), true);
      }
      for (const otherOp of EXPECTED_OPERATIONS) {
        if (otherOp === operation) continue;
        for (const foreignActionId of EXPECTED_ACTION_IDS[otherOp]) {
          assert.equal(
            isSupervisorLifecycleActionForOperation(operation, foreignActionId),
            false,
            `${operation} must reject ${foreignActionId}`,
          );
        }
      }
    }

    const invalidPairs = [
      ['install', 'Install'],
      ['install', ' render-launch-agent-plist'],
      ['install', 'render-launch-agent-plist '],
      ['install', 'RENDER-LAUNCH-AGENT-PLIST'],
      ['install', 'render'],
      ['install', ''],
      ['Install', 'render-launch-agent-plist'],
      [' install', 'render-launch-agent-plist'],
      ['audit', 'render-launch-agent-plist'],
      [null, 'render-launch-agent-plist'],
      ['install', null],
      ['install', undefined],
      ['install', 0],
      ['install', true],
      ['install', []],
      ['install', {}],
      ['install', Symbol('render-launch-agent-plist')],
      [[], 'render-launch-agent-plist'],
      [{}, 'render-launch-agent-plist'],
      [Symbol('install'), 'render-launch-agent-plist'],
    ];
    for (const [operation, actionId] of invalidPairs) {
      assert.equal(
        isSupervisorLifecycleActionForOperation(operation, actionId),
        false,
        `expected false for ${String(operation)} / ${String(actionId)}`,
      );
    }
  });

  it('shared module imports neither lifecycle nor future sink', () => {
    const source = readFileSync(ACTIONS_SRC, 'utf8');
    assert.equal(/from\s+['"]\.\/supervisor-lifecycle\.js['"]/.test(source), false);
    assert.equal(/from\s+['"]\.\/capability-audit-sink\.js['"]/.test(source), false);
    assert.equal(/require\s*\(\s*['"].*supervisor-lifecycle/.test(source), false);
    assert.equal(/require\s*\(\s*['"].*capability-audit-sink/.test(source), false);
  });

  it('lifecycle consumes shared SoT and no longer owns actionsByOperation ID lists', () => {
    const lifecycleSource = readFileSync(LIFECYCLE_SRC, 'utf8');
    assert.match(lifecycleSource, /from\s+['"]\.\/supervisor-lifecycle-actions\.js['"]/);
    assert.equal(lifecycleSource.includes('actionsByOperation'), false);
    assert.equal(
      /install:\s*\[\s*\[\s*['"]render-launch-agent-plist['"]/.test(lifecycleSource),
      false,
    );
    assert.equal(
      /uninstall:\s*\[\s*\[\s*['"]unload-launch-agent['"]/.test(lifecycleSource),
      false,
    );
    assert.equal(
      /rollback:\s*\[\s*\[\s*['"]capture-current-state['"]/.test(lifecycleSource),
      false,
    );
    assert.equal(
      /recover:\s*\[\s*\[\s*['"]start-recovery-supervisor['"]/.test(lifecycleSource),
      false,
    );
  });

  it('buildLifecycleActions / plan action order+content stay byte-stable vs pre-extract baseline', () => {
    for (const operation of EXPECTED_OPERATIONS) {
      const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, {
        operation,
        now: new Date('2026-07-07T05:00:00.000Z'),
      });
      assert.deepEqual(plan.actions, BASELINE_ACTIONS[operation]);
      assert.deepEqual(
        plan.actions.map((action) => action.id),
        EXPECTED_ACTION_IDS[operation],
      );
      assert.ok(plan.actions.every((action) => (
        action.status === 'blocked'
        && action.wouldRun === false
        && action.wouldWrite === false
      )));
    }
  });
});
