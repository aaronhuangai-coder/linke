/**
 * V1.46 管理认证轮换 CLI 命令正式行为合同（纯依赖注入，不触真实 Keychain/锁）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  ManagementAuthRotateCommandError,
  runManagementAuthRotateCommand,
} from '../src/management-auth-rotate-command.js';
import { ManagementAuthRotationError } from '../src/management-auth-rotation.js';
import { ManagementAuthRotationProcessLockError } from '../src/management-auth-rotation-process-lock.js';
import { ManagementAuthControllerRestartError } from '../src/management-auth-controller-restart.js';

const ARGUMENTS_INVALID = 'management-auth-rotate-arguments-invalid';
const STDIN_INVALID = 'management-auth-rotate-stdin-invalid';
const DATA_DIR = '/tmp/linke-management-auth-rotate-command';
const TOKEN = `cmd-rotation-token_${'C'.repeat(24)}`;
const VALID_ARGV = Object.freeze([
  'management-auth-rotate',
  '--data-dir',
  DATA_DIR,
  '--scope',
  'read',
  '--token-stdin',
]);
const VALID_RESTART_ARGV = Object.freeze([
  ...VALID_ARGV,
  '--restart-controller',
  '--controller-port',
  '3000',
]);

function assertCommandError(error, code, forbidden = []) {
  assert.ok(error instanceof ManagementAuthRotateCommandError);
  assert.equal(error.name, 'ManagementAuthRotateCommandError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  const rendered = `${error.name}\n${error.code}\n${error.message}\n${error.stack}`;
  for (const value of forbidden) {
    if (value) assert.equal(rendered.includes(String(value)), false);
  }
  return true;
}

function createWorld({
  chunks = [Buffer.from(`${TOKEN}\n`)],
  createKeychainImpl,
  createExclusiveLockImpl,
  stageImpl,
  appendAuditImpl,
  restartImpl,
  writeOutputImpl,
  receipt = Object.freeze({
    state: 'staged',
    scope: 'read',
    previousOverlapConfigured: true,
    restartRequired: true,
    hotReload: false,
    automaticRestart: false,
    sensitiveValuesReturned: false,
    alreadyStaged: false,
  }),
} = {}) {
  const events = [];
  const writes = [];
  const keychain = Object.freeze({ marker: 'synthetic-keychain' });
  const withExclusiveLock = async (task) => task();
  let inputPulls = 0;
  let stageArgs = null;
  const auditArgs = [];
  let restartArgs = null;
  const input = Readable.from((function* inputChunks() {
    for (const chunk of chunks) {
      inputPulls += 1;
      events.push('stdin-read');
      yield chunk;
    }
  }()));
  const deps = {
    input,
    async createKeychain() {
      events.push('createKeychain');
      if (createKeychainImpl) return createKeychainImpl();
      return keychain;
    },
    async createExclusiveLock(dataDir) {
      events.push(`createExclusiveLock:${dataDir}`);
      if (createExclusiveLockImpl) return createExclusiveLockImpl(dataDir);
      return withExclusiveLock;
    },
    async stage(args) {
      events.push('stage');
      stageArgs = args;
      if (stageImpl) return stageImpl(args);
      return receipt;
    },
    async appendAuditEvent(dataDir, event) {
      events.push(`appendAudit:${event.outcome}`);
      auditArgs.push({ dataDir, event: { ...event } });
      if (appendAuditImpl) return appendAuditImpl(dataDir, event, auditArgs.length);
      return { ...event };
    },
    async restartController(args) {
      events.push('restartController');
      restartArgs = args;
      if (restartImpl) return restartImpl(args);
      return Object.freeze({
        state: 'restarted',
        scope: args.rotationReceipt.scope,
        previousOverlapConfigured: true,
        controllerRestarted: true,
        authenticationVerified: true,
        restartRequired: false,
        hotReload: false,
        automaticRestart: false,
        sensitiveValuesReturned: false,
        alreadyStaged: false,
      });
    },
    writeOutput(value) {
      events.push('writeOutput');
      writes.push(value);
      if (writeOutputImpl) return writeOutputImpl(value);
      return undefined;
    },
  };
  return {
    deps,
    events,
    writes,
    keychain,
    withExclusiveLock,
    receipt,
    get inputPulls() { return inputPulls; },
    get stageArgs() { return stageArgs; },
    get auditArgs() { return auditArgs; },
    get restartArgs() { return restartArgs; },
  };
}

describe('management-auth-rotate argv 固定六段合同', () => {
  const secret = `argv-secret-${'S'.repeat(32)}`;
  const invalidArgv = [
    [],
    ['management-auth-rotate'],
    VALID_ARGV.slice(0, 5),
    [...VALID_ARGV, 'extra'],
    ['management-auth-rotate', '--scope', 'read', '--data-dir', DATA_DIR, '--token-stdin'],
    ['management-auth-rotate', '--data-dir', DATA_DIR, '--scope', 'read', '--scope'],
    ['management-auth-rotate', '--data-dir', DATA_DIR, '--scope', 'read', '--new-token-stdin'],
    ['management-auth-rotate', '--data-dir', DATA_DIR, '--scope', 'read', '--token', secret],
    ['management-auth-rotate', '--data-dir', 'relative/path', '--scope', 'read', '--token-stdin'],
    ['management-auth-rotate', '--data-dir', '/tmp/a/../b', '--scope', 'read', '--token-stdin'],
    ['management-auth-rotate', '--data-dir', DATA_DIR, '--scope', 'bogus', '--token-stdin'],
    ['management-auth-rotate', '--data-dir', DATA_DIR, '--scope=read', '--token-stdin'],
    [...VALID_ARGV, '--restart-controller'],
    [...VALID_ARGV, '--restart-controller', '--controller-port'],
    [...VALID_ARGV, '--restart-controller', '--controller-port', '0'],
    [...VALID_ARGV, '--restart-controller', '--controller-port', '65536'],
    [...VALID_ARGV, '--restart-controller', '--controller-port', '03000'],
    [...VALID_ARGV, '--controller-port', '3000', '--restart-controller'],
  ];

  for (const argv of invalidArgv) {
    it(`拒绝非精确 argv：${argv.length} tokens`, async () => {
      const world = createWorld();
      await assert.rejects(
        runManagementAuthRotateCommand(argv, world.deps),
        (error) => assertCommandError(error, ARGUMENTS_INVALID, [secret, DATA_DIR]),
      );
      assert.equal(world.inputPulls, 0, 'argv invalid must fail before reading stdin');
      assert.deepEqual(world.events, []);
      assert.deepEqual(world.writes, []);
    });
  }
});

describe('management-auth-rotate stdin 单行/字节/UTF-8 合同', () => {
  const invalidInputs = [
    [],
    [Buffer.from('\n')],
    [Buffer.from('abc\n')],
    [Buffer.from(`${'A'.repeat(42)}\n`)],
    [Buffer.from(`${'A'.repeat(129)}\n`)],
    [Buffer.from(`${TOKEN}\n${TOKEN}\n`)],
    [Buffer.from(`${TOKEN}\n\n`)],
    [Buffer.from(`${TOKEN}\r\n\r\n`)],
    [Buffer.from(`${'A'.repeat(42)}=\n`)],
    [Buffer.concat([Buffer.from('A'.repeat(42)), Buffer.from([0]), Buffer.from('\n')])],
    [Buffer.from([0xff, 0xfe, 0x0a])],
    [Buffer.from(`${'A'.repeat(4096)}\n`)],
  ];

  for (const chunks of invalidInputs) {
    it(`拒绝无效 stdin 样本 ${invalidInputs.indexOf(chunks) + 1}`, async () => {
      const world = createWorld({ chunks });
      await assert.rejects(
        runManagementAuthRotateCommand([...VALID_ARGV], world.deps),
        (error) => assertCommandError(error, STDIN_INVALID, [TOKEN]),
      );
      assert.equal(world.events.includes('createKeychain'), false);
      assert.equal(world.events.some((event) => event.startsWith('createExclusiveLock:')), false);
      assert.equal(world.events.includes('stage'), false);
      assert.deepEqual(world.writes, []);
    });
  }
});

describe('management-auth-rotate 成功顺序与 receipt 原样输出', () => {
  for (const suffix of ['', '\n', '\r\n']) {
    it(`允许单行 token 结尾 ${JSON.stringify(suffix)}`, async () => {
      const world = createWorld({ chunks: [Buffer.from(`${TOKEN}${suffix}`)] });
      const result = await runManagementAuthRotateCommand([...VALID_ARGV], world.deps);

      assert.equal(result, world.receipt);
      assert.deepEqual(world.events, [
        'stdin-read',
        'createKeychain',
        `createExclusiveLock:${DATA_DIR}`,
        'stage',
        'writeOutput',
      ]);
      assert.deepEqual(world.stageArgs, {
        keychain: world.keychain,
        scope: 'read',
        newToken: TOKEN,
        withExclusiveLock: world.withExclusiveLock,
      });
      assert.deepEqual(world.writes, [`${JSON.stringify(world.receipt)}\n`]);
      const rendered = JSON.parse(world.writes[0]);
      assert.deepEqual(rendered, world.receipt);
      assert.equal('ok' in rendered, false);
      assert.equal('rotatedAt' in rendered, false);
      assert.equal(rendered.scope, 'read');
    });
  }

  it('scope=write 与 128 字符 token 原样传入 stage', async () => {
    const token = 'W'.repeat(128);
    const argv = [...VALID_ARGV];
    argv[4] = 'write';
    const receipt = Object.freeze({ state: 'staged', scope: 'write' });
    const world = createWorld({ chunks: [Buffer.from(`${token}\n`)], receipt });
    assert.equal(await runManagementAuthRotateCommand(argv, world.deps), receipt);
    assert.equal(world.stageArgs.scope, 'write');
    assert.equal(world.stageArgs.newToken, token);
  });

  for (const scope of ['full', 'admin']) {
    it(`scope=${scope} 可进入 staging 并原样输出对应 receipt`, async () => {
      const argv = [...VALID_ARGV];
      argv[4] = scope;
      const receipt = Object.freeze({ state: 'staged', scope });
      const world = createWorld({ receipt });

      assert.equal(await runManagementAuthRotateCommand(argv, world.deps), receipt);
      assert.equal(world.stageArgs.scope, scope);
      assert.deepEqual(JSON.parse(world.writes[0]), receipt);
    });
  }
});

describe('management-auth-rotate 显式 controller restart 编排与审计', () => {
  it('精确 restart argv：required start audit → stage → restart → best-effort completed → 单行输出', async () => {
    const world = createWorld();
    const result = await runManagementAuthRotateCommand([...VALID_RESTART_ARGV], world.deps);

    assert.equal(result.state, 'restarted');
    assert.deepEqual(world.events, [
      'stdin-read',
      'appendAudit:started',
      'createKeychain',
      `createExclusiveLock:${DATA_DIR}`,
      'stage',
      'restartController',
      'appendAudit:success',
      'writeOutput',
    ]);
    assert.deepEqual(world.restartArgs, {
      rotationReceipt: world.receipt,
      newToken: TOKEN,
      controllerPort: 3000,
    });
    assert.equal(world.auditArgs.length, 2);
    assert.deepEqual(world.auditArgs[0], {
      dataDir: DATA_DIR,
      event: {
        type: 'management.auth.controller-restart.started',
        outcome: 'started',
        operation: 'read',
      },
    });
    assert.equal(world.auditArgs[1].event.type, 'management.auth.controller-restart.completed');
    assert.equal(JSON.stringify(world.auditArgs).includes(TOKEN), false);
    assert.deepEqual(JSON.parse(world.writes[0]), result);
  });

  for (const scope of ['full', 'admin']) {
    it(`scope=${scope} 显式 restart 透传 receipt/newToken/port 并记录脱敏 operation`, async () => {
      const argv = [...VALID_RESTART_ARGV];
      argv[4] = scope;
      const receipt = Object.freeze({
        state: 'staged',
        scope,
        previousOverlapConfigured: true,
        restartRequired: true,
        hotReload: false,
        automaticRestart: false,
        sensitiveValuesReturned: false,
        alreadyStaged: false,
      });
      const world = createWorld({ receipt });

      const result = await runManagementAuthRotateCommand(argv, world.deps);
      assert.equal(result.scope, scope);
      assert.equal(world.restartArgs.rotationReceipt, receipt);
      assert.equal(world.restartArgs.newToken, TOKEN);
      assert.equal(world.restartArgs.controllerPort, 3000);
      assert.ok(world.auditArgs.every(({ event }) => event.operation === scope));
      assert.equal(JSON.stringify(world.auditArgs).includes(TOKEN), false);
    });
  }

  it('required start audit 失败在 Keychain/stage/launchctl 前固定拒绝', async () => {
    const raw = new Error(`audit unavailable ${TOKEN}`);
    const world = createWorld({
      appendAuditImpl: async () => { throw raw; },
    });
    await assert.rejects(
      runManagementAuthRotateCommand([...VALID_RESTART_ARGV], world.deps),
      (error) => {
        assert.ok(error instanceof ManagementAuthControllerRestartError);
        assert.equal(error.code, 'management-auth-controller-restart-unavailable');
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      },
    );
    assert.deepEqual(world.events, ['stdin-read', 'appendAudit:started']);
    assert.equal(world.restartArgs, null);
    assert.deepEqual(world.writes, []);
  });

  it('stage/restart 失败保留主错误并 best-effort 记录 failure，不输出', async () => {
    const stageError = new ManagementAuthRotationError('management-auth-rotation-unavailable');
    const stagedWorld = createWorld({ stageImpl: async () => { throw stageError; } });
    await assert.rejects(
      runManagementAuthRotateCommand([...VALID_RESTART_ARGV], stagedWorld.deps),
      (error) => error === stageError,
    );
    assert.equal(stagedWorld.auditArgs.at(-1).event.outcome, 'failure');
    assert.equal(stagedWorld.restartArgs, null);
    assert.deepEqual(stagedWorld.writes, []);

    const restartError = new ManagementAuthControllerRestartError(
      'management-auth-controller-restart-authentication-failed',
    );
    const restartWorld = createWorld({ restartImpl: async () => { throw restartError; } });
    await assert.rejects(
      runManagementAuthRotateCommand([...VALID_RESTART_ARGV], restartWorld.deps),
      (error) => error === restartError,
    );
    assert.equal(restartWorld.auditArgs.at(-1).event.outcome, 'failure');
    assert.deepEqual(restartWorld.writes, []);
  });

  it('completed audit 失败不覆盖已经验证的重启结果', async () => {
    const world = createWorld({
      appendAuditImpl: async (_dataDir, event) => {
        if (event.outcome === 'success') throw new Error(`post audit ${TOKEN}`);
      },
    });
    const result = await runManagementAuthRotateCommand([...VALID_RESTART_ARGV], world.deps);
    assert.equal(result.authenticationVerified, true);
    assert.equal(world.writes.length, 1);
  });
});

describe('management-auth-rotate typed/unknown error 透传与零输出', () => {
  it('stage 的 ManagementAuthRotationError 原引用透传', async () => {
    const stageError = new ManagementAuthRotationError('management-auth-rotation-unavailable');
    const world = createWorld({ stageImpl: async () => { throw stageError; } });
    await assert.rejects(
      runManagementAuthRotateCommand([...VALID_ARGV], world.deps),
      (error) => error === stageError,
    );
    assert.deepEqual(world.writes, []);
  });

  it('lock factory 的 ManagementAuthRotationProcessLockError 原引用透传', async () => {
    const lockError = new ManagementAuthRotationProcessLockError();
    const world = createWorld({ createExclusiveLockImpl: async () => { throw lockError; } });
    await assert.rejects(
      runManagementAuthRotateCommand([...VALID_ARGV], world.deps),
      (error) => error === lockError,
    );
    assert.equal(world.events.includes('stage'), false);
    assert.deepEqual(world.writes, []);
  });

  for (const phase of ['createKeychain', 'createExclusiveLock', 'stage', 'writeOutput']) {
    it(`未知 ${phase} error 原引用透传且失败时不追加输出`, async () => {
      const rawError = new Error(`synthetic ${phase} failure`);
      const options = {};
      if (phase === 'createKeychain') options.createKeychainImpl = async () => { throw rawError; };
      if (phase === 'createExclusiveLock') options.createExclusiveLockImpl = async () => { throw rawError; };
      if (phase === 'stage') options.stageImpl = async () => { throw rawError; };
      if (phase === 'writeOutput') options.writeOutputImpl = () => { throw rawError; };
      const world = createWorld(options);
      await assert.rejects(
        runManagementAuthRotateCommand([...VALID_ARGV], world.deps),
        (error) => error === rawError,
      );
      if (phase !== 'writeOutput') assert.deepEqual(world.writes, []);
    });
  }
});
