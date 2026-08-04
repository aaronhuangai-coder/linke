/**
 * 管理认证轮换锁的真实多进程测试 helper。
 * stdout/stderr 只输出固定词；绝不输出 root、witness path 或底层错误。
 */

import { appendFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ManagementAuthRotationProcessLockError,
  acquireManagementAuthRotationProcessLock,
  createManagementAuthRotationExclusiveLock,
  releaseManagementAuthRotationProcessLock,
} from '../../src/management-auth-rotation-process-lock.js';

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;

function fixedWrite(fd, value) {
  const target = fd === 1 ? process.stdout : process.stderr;
  target.write(`${value}\n`);
}

function exitFor(error) {
  if (error instanceof ManagementAuthRotationProcessLockError) {
    fixedWrite(2, 'LOCK_UNAVAILABLE');
    process.exitCode = 2;
    return;
  }
  fixedWrite(2, 'UNEXPECTED');
  process.exitCode = 1;
}

async function main() {
  const [mode, root, third, fourth] = process.argv.slice(2);
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    throw new Error('invalid arguments');
  }

  if (mode === 'hold') {
    const holdMs = Number(third);
    if (!Number.isInteger(holdMs) || holdMs < 1 || holdMs > 60_000 || fourth !== undefined) {
      throw new Error('invalid arguments');
    }
    const handle = await acquireManagementAuthRotationProcessLock(root);
    fixedWrite(1, 'HOLDING');
    await delay(holdMs);
    await releaseManagementAuthRotationProcessLock(handle);
    fixedWrite(1, 'RELEASED');
    return;
  }

  if (mode === 'task') {
    if (!/^[A-Z]$/.test(third) || !isAbsolute(fourth) || fourth.includes('\0')) {
      throw new Error('invalid arguments');
    }
    const withExclusiveLock = createManagementAuthRotationExclusiveLock(root);
    await withExclusiveLock(async () => {
      await appendFile(fourth, `BEGIN ${third}\n`, { encoding: 'utf8', mode: 0o600 });
      await delay(300);
      await appendFile(fourth, `END ${third}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    fixedWrite(1, 'DONE');
    return;
  }

  throw new Error('invalid mode');
}

main().catch(exitFor);
