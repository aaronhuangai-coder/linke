/**
 * V1.46 管理认证轮换 CLI 命令 bootstrap 骨架 smoke：
 * 只验证可导入契约面与立即固定失败，并证明 input / keychain / lock /
 * stage / output 全部零触碰（Proxy 探针 + 输出间谍 + 源码边界）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ManagementAuthRotateCommandError,
  runManagementAuthRotateCommand,
} from '../src/management-auth-rotate-command.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COMMAND_SRC = join(__dirname, '..', 'src', 'management-auth-rotate-command.js');

/** 固定错误码：message/code 恒等于该值。 */
const FIXED = 'management-auth-rotate-failed';

/**
 * 零触碰探针：任何属性读取（含 then/symbol）都会记录。
 * @returns {{ target: object, accessed: string[] }}
 */
function zeroTouchProbe() {
  const accessed = [];
  const target = new Proxy({}, {
    get(_t, prop) {
      accessed.push(String(prop));
      return undefined;
    },
  });
  return { target, accessed };
}

describe('management-auth-rotate-command bootstrap 骨架', () => {
  it('导出固定错误类型与命令入口', () => {
    assert.equal(typeof runManagementAuthRotateCommand, 'function');
    const error = new ManagementAuthRotateCommandError({
      argv: ['--scope', 'read'],
      token: 'A'.repeat(43),
    });
    assert.equal(error.name, 'ManagementAuthRotateCommandError');
    assert.equal(error.code, FIXED);
    assert.equal(error.message, FIXED);
    assert.ok(!String(error).includes('A'.repeat(43)), '未知输入不得回显');
  });

  it('调用即固定失败：rawArgv 与 deps（含 input）零读取', async () => {
    const argvProbe = zeroTouchProbe();
    const depsProbe = zeroTouchProbe();
    await assert.rejects(
      () => runManagementAuthRotateCommand(argvProbe.target, depsProbe.target),
      (error) => {
        assert.ok(error instanceof ManagementAuthRotateCommandError);
        assert.equal(error.name, 'ManagementAuthRotateCommandError');
        assert.equal(error.code, FIXED);
        assert.equal(error.message, FIXED);
        return true;
      },
    );
    assert.deepEqual(argvProbe.accessed, [], '不得读取 rawArgv 任何内容');
    assert.deepEqual(depsProbe.accessed, [], '不得读取 deps（含 deps.input）任何内容');
  });

  it('固定失败路径零输出：stdout/stderr/console 均未被触碰', async () => {
    const writes = [];
    const originals = [
      ['stdout', 'write'],
      ['stderr', 'write'],
    ].map(([stream, method]) => {
      const original = process[stream][method];
      process[stream][method] = (...chunks) => {
        writes.push(['process', stream, ...chunks]);
        return true;
      };
      return [process[stream], method, original];
    });
    const consoleWrites = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...chunks) => consoleWrites.push(chunks);
    console.error = (...chunks) => consoleWrites.push(chunks);
    try {
      await assert.rejects(
        () => runManagementAuthRotateCommand(['management-auth-rotate'], {}),
        (error) => error instanceof ManagementAuthRotateCommandError
          && error.message === FIXED,
      );
    } finally {
      for (const [streamObj, method, original] of originals) {
        streamObj[method] = original;
      }
      console.log = originalLog;
      console.error = originalError;
    }
    assert.deepEqual(writes, [], '不得写 process.stdout/stderr');
    assert.deepEqual(consoleWrites, [], '不得调用 console.log/error');
  });

  it('零能力源码边界：无任何模块依赖，无 keychain/锁/stage 调用、无输出调用', async () => {
    const source = await readFile(COMMAND_SRC, 'utf8');
    assert.ok(!/^\s*import\s/m.test(source), '不得 import 任何模块');
    assert.ok(!source.includes('require('), '不得 require 任何模块');
    assert.ok(!source.includes('new KeychainStore('), '不得构造 KeychainStore');
    assert.ok(!source.includes('createManagementAuthRotationExclusiveLock('), '不得调用进程锁 factory');
    assert.ok(!source.includes('acquireManagementAuthRotationProcessLock('), '不得调用进程锁 acquire');
    assert.ok(!source.includes('stageManagementAuthKeychainRotation('), '不得调用 stage');
    assert.ok(!source.includes('process.stdout'), '不得写 stdout');
    assert.ok(!source.includes('process.stderr'), '不得写 stderr');
    assert.ok(!source.includes('console.'), '不得写 console');
  });
});
