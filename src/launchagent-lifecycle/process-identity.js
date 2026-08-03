/**
 * LaunchAgent process identity reader（V1.46 Task 6B.0 Task 1）。
 *
 * 闭合 surface：current() / observe() only。
 * 生产命令固定 sysctl kern.boottime 与 ps lstart；身份仅输出 SHA-256 前缀串。
 * 失败与畸形归一为 unavailable / 对应闭合 status；禁止泄漏 raw stdout/路径/错误原文。
 */

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';

const SYSCTL_PATH = '/usr/sbin/sysctl';
const SYSCTL_ARGV = Object.freeze(['-n', 'kern.boottime']);
const PS_PATH = '/bin/ps';
const EXEC_OPTIONS = Object.freeze({
  encoding: 'utf8',
  timeout: 3000,
  maxBuffer: 4096,
});
const MAX_STDOUT_UTF8_BYTES = 4096;
const BOOT_PREFIX = 'boot-sha256-';
const PROCESS_START_PREFIX = 'process-start-sha256-';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      deepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

function frozenIdentity(available, value) {
  return deepFreeze({ available, value });
}

function unavailableIdentity() {
  return frozenIdentity(false, null);
}

function frozenCurrent(bootSessionIdentity, processStartIdentity) {
  return deepFreeze({ bootSessionIdentity, processStartIdentity });
}

function frozenObserve(status) {
  return deepFreeze({ status });
}

function invalidDeps() {
  throw new TypeError('invalid dependencies');
}

/**
 * 精确闭合注入面 {execFile, kill}：仅允许这两个可枚举数据属性且为 function。
 * 不读取未知键值，避免触发敌意 accessor。
 */
function readExactDeps(deps) {
  if (deps === null || typeof deps !== 'object') invalidDeps();
  if (Object.getPrototypeOf(deps) !== Object.prototype) invalidDeps();

  const ownKeys = Reflect.ownKeys(deps);
  if (ownKeys.length !== 2 || ownKeys.some((key) => typeof key !== 'string')) {
    invalidDeps();
  }

  const expected = new Set(['execFile', 'kill']);
  const fields = Object.create(null);
  for (const key of ownKeys) {
    if (!expected.has(key)) invalidDeps();
    const descriptor = Object.getOwnPropertyDescriptor(deps, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalidDeps();
    }
    if (typeof descriptor.value !== 'function') invalidDeps();
    fields[key] = descriptor.value;
  }
  return fields;
}

/** 规范化 stdout：非 string → null；trim 后为空 / 超长 / 含 NUL → null；否则返回 trim 后原文。 */
function normalizeStdout(stdout) {
  if (typeof stdout !== 'string') return null;
  const normalized = stdout.trim();
  if (normalized.length === 0) return null;
  if (Buffer.byteLength(normalized, 'utf8') > MAX_STDOUT_UTF8_BYTES) return null;
  if (normalized.includes('\0')) return null;
  return normalized;
}

function digestWithPrefix(prefix, normalized) {
  const hex = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `${prefix}${hex}`;
}

async function runExec(execFile, file, args) {
  try {
    const result = await execFile(file, args, EXEC_OPTIONS);
    const stdout = result == null ? undefined : result.stdout;
    return normalizeStdout(stdout);
  } catch {
    return null;
  }
}

async function readBootIdentity(execFile) {
  const normalized = await runExec(execFile, SYSCTL_PATH, SYSCTL_ARGV);
  if (normalized === null) return unavailableIdentity();
  return frozenIdentity(true, digestWithPrefix(BOOT_PREFIX, normalized));
}

async function readProcessStartIdentity(execFile, pid) {
  const args = Object.freeze(['-p', String(pid), '-o', 'lstart=']);
  const normalized = await runExec(execFile, PS_PATH, args);
  if (normalized === null) return unavailableIdentity();
  return frozenIdentity(true, digestWithPrefix(PROCESS_START_PREFIX, normalized));
}

/**
 * 记录中的身份必须是精确 {available:true, value:非空 string} 数据属性对象。
 * 否则（含 recorded-unavailable / 畸形 / accessor 形态）由调用方归一 unavailable。
 */
function isExactAvailableIdentity(identity) {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    return false;
  }
  if (Object.getPrototypeOf(identity) !== Object.prototype) return false;

  const ownKeys = Reflect.ownKeys(identity);
  if (ownKeys.length !== 2 || ownKeys.some((key) => typeof key !== 'string')) {
    return false;
  }

  const expected = new Set(['available', 'value']);
  let available;
  let value;
  for (const key of ownKeys) {
    if (!expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(identity, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return false;
    }
    if (key === 'available') available = descriptor.value;
    if (key === 'value') value = descriptor.value;
  }
  if (available !== true) return false;
  if (typeof value !== 'string' || value.length === 0) return false;
  return true;
}

function createProductionExecFile() {
  return function productionExecFile(file, args, options) {
    return new Promise((resolve, reject) => {
      execFileCallback(file, args, options, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout });
      });
    });
  };
}

function createReader({ execFile, kill }) {
  async function current() {
    const bootSessionIdentity = await readBootIdentity(execFile);
    const processStartIdentity = await readProcessStartIdentity(execFile, process.pid);
    return frozenCurrent(bootSessionIdentity, processStartIdentity);
  }

  async function observe(record) {
    try {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        return frozenObserve('unavailable');
      }

      // 投影消费字段；允许 lock record 上存在 schemaVersion 等额外普通字段。
      const ownerPid = record.ownerPid;
      const bootSessionIdentity = record.bootSessionIdentity;
      const processStartIdentity = record.processStartIdentity;

      if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
        return frozenObserve('unavailable');
      }
      if (!isExactAvailableIdentity(bootSessionIdentity)) {
        return frozenObserve('unavailable');
      }
      if (!isExactAvailableIdentity(processStartIdentity)) {
        return frozenObserve('unavailable');
      }

      const recordedBoot = bootSessionIdentity.value;
      const recordedStart = processStartIdentity.value;

      const currentBoot = await readBootIdentity(execFile);
      if (!currentBoot.available) {
        return frozenObserve('unavailable');
      }
      if (currentBoot.value !== recordedBoot) {
        return frozenObserve('boot-session-mismatch');
      }

      try {
        kill(ownerPid, 0);
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ESRCH') {
          return frozenObserve('dead');
        }
        return frozenObserve('unavailable');
      }

      const currentStart = await readProcessStartIdentity(execFile, ownerPid);
      if (!currentStart.available) {
        return frozenObserve('unavailable');
      }
      if (currentStart.value === recordedStart) {
        return frozenObserve('alive-same-owner');
      }
      return frozenObserve('pid-reused');
    } catch {
      return frozenObserve('unavailable');
    }
  }

  return deepFreeze({ current, observe });
}

/** 生产工厂：零参；内部固定 node:child_process execFile 与 process.kill。 */
export function createLaunchAgentProcessIdentityReader() {
  return createReader({
    execFile: createProductionExecFile(),
    kill(pid, signal) {
      process.kill(pid, signal);
    },
  });
}

/** ForTest 工厂：仅接受精确 {execFile, kill} 数据属性注入。 */
export function createLaunchAgentProcessIdentityReaderForTest(deps) {
  const fields = readExactDeps(deps);
  return createReader({
    execFile: fields.execFile,
    kill: fields.kill,
  });
}
