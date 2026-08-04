/**
 * V1.46 管理认证轮换跨进程锁 bootstrap 骨架 smoke：
 * 只验证可导入契约面、固定错误（未知输入零回显）、factory 行为
 * （返回函数、固定失败、绝不调用 task）与零 I/O 源码边界。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANAGEMENT_AUTH_ROTATION_PROCESS_LOCK_RELATIVE_PATH,
  MANAGEMENT_AUTH_ROTATION_PROCESS_LOCK_TIMEOUT_SECONDS,
  ManagementAuthRotationProcessLockError,
  acquireManagementAuthRotationProcessLock,
  createManagementAuthRotationExclusiveLock,
  releaseManagementAuthRotationProcessLock,
} from '../src/management-auth-rotation-process-lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOCK_SRC = join(__dirname, '..', 'src', 'management-auth-rotation-process-lock.js');

/** 固定错误码：message/code 恒等于该值。 */
const FIXED = 'management-auth-rotation-process-lock-failed';

describe('management-auth-rotation-process-lock bootstrap 骨架', () => {
  it('导出固定常量与全部契约函数', () => {
    assert.equal(
      MANAGEMENT_AUTH_ROTATION_PROCESS_LOCK_RELATIVE_PATH,
      'auth/management-rotation.lock',
    );
    assert.equal(MANAGEMENT_AUTH_ROTATION_PROCESS_LOCK_TIMEOUT_SECONDS, 5);
    assert.equal(typeof acquireManagementAuthRotationProcessLock, 'function');
    assert.equal(typeof releaseManagementAuthRotationProcessLock, 'function');
    assert.equal(typeof createManagementAuthRotationExclusiveLock, 'function');
  });

  it('固定错误：name/code/message 三码固定，未知输入零回显', () => {
    const error = new ManagementAuthRotationProcessLockError({
      path: '/tmp/secret-lock-path',
      token: 'A'.repeat(43),
      cause: new Error('底层错误不应回显'),
    });
    assert.equal(error.name, 'ManagementAuthRotationProcessLockError');
    assert.equal(error.code, FIXED);
    assert.equal(error.message, FIXED);
    const rendered = String(error);
    assert.ok(!rendered.includes('/tmp/secret-lock-path'));
    assert.ok(!rendered.includes('A'.repeat(43)));
    assert.ok(!rendered.includes('底层错误不应回显'));
  });

  it('acquire/release 调用即固定抛错（参数忽略且零回显）', () => {
    for (const fn of [
      acquireManagementAuthRotationProcessLock,
      releaseManagementAuthRotationProcessLock,
    ]) {
      assert.throws(() => fn('/tmp/secret-lock-path', { timeout: 999 }), (error) => {
        assert.ok(error instanceof ManagementAuthRotationProcessLockError);
        assert.equal(error.name, 'ManagementAuthRotationProcessLockError');
        assert.equal(error.code, FIXED);
        assert.equal(error.message, FIXED);
        assert.ok(!String(error).includes('/tmp/secret-lock-path'));
        return true;
      });
    }
  });

  it('factory 构造零 I/O，返回函数固定失败且绝不调用 task', async () => {
    // 构造本身必须零副作用（无返回值读取之外的任何行为）。
    const withExclusiveLock = createManagementAuthRotationExclusiveLock();
    assert.equal(typeof withExclusiveLock, 'function');
    let taskCalled = false;
    await assert.rejects(
      () => withExclusiveLock(() => {
        taskCalled = true;
      }),
      (error) => {
        assert.ok(error instanceof ManagementAuthRotationProcessLockError);
        assert.equal(error.code, FIXED);
        assert.equal(error.message, FIXED);
        return true;
      },
    );
    assert.equal(taskCalled, false);
  });

  it('零 I/O 源码边界：无 fs/child_process 依赖、无 spawn/lockf 调用', async () => {
    const source = await readFile(LOCK_SRC, 'utf8');
    assert.ok(!source.includes("from 'node:fs"), '不得依赖 node:fs');
    assert.ok(!source.includes("from 'node:child_process'"), '不得依赖 node:child_process');
    assert.ok(!source.includes('spawn('), '不得 spawn 子进程');
    assert.ok(!source.includes('lockf('), '不得调用 lockf');
  });
});
