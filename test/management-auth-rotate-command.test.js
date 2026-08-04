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
    ['management-auth-rotate', '--data-dir', DATA_DIR, '--scope', 'admin', '--token-stdin'],
    ['management-auth-rotate', '--data-dir', DATA_DIR, '--scope=read', '--token-stdin'],
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
