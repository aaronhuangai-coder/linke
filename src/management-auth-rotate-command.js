/**
 * 管理认证轮换 CLI 命令核心。
 * argv 只接收公开参数；新 token 仅从 stdin 读取，所有底层错误均由调用方固定映射。
 */

import { isAbsolute, normalize } from 'node:path';
import { TextDecoder } from 'node:util';
import { KeychainStore } from './keychain-store.js';
import { appendAuditEvent as appendLocalAuditEvent } from './audit-log.js';
import {
  ManagementAuthControllerRestartError,
  restartManagementAuthController,
} from './management-auth-controller-restart.js';
import {
  stageManagementAuthKeychainRotation,
  validateManagementAuthRotationToken,
} from './management-auth-rotation.js';
import { createManagementAuthRotationExclusiveLock } from './management-auth-rotation-process-lock.js';

const ARGUMENTS_INVALID = 'management-auth-rotate-arguments-invalid';
const STDIN_INVALID = 'management-auth-rotate-stdin-invalid';
const MAX_STDIN_BYTES = 4_096;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const ROTATABLE_SCOPES = new Set(['full', 'read', 'write', 'admin']);

/** 管理认证轮换命令的固定、无回显错误。 */
export class ManagementAuthRotateCommandError extends Error {
  constructor(code = ARGUMENTS_INVALID) {
    const fixedCode = code === STDIN_INVALID ? STDIN_INVALID : ARGUMENTS_INVALID;
    super(fixedCode);
    this.name = 'ManagementAuthRotateCommandError';
    this.code = fixedCode;
  }
}

function argumentsInvalid() {
  return new ManagementAuthRotateCommandError(ARGUMENTS_INVALID);
}

function stdinInvalid() {
  return new ManagementAuthRotateCommandError(STDIN_INVALID);
}

/**
 * 解析精确六段 staging argv 或九段显式重启 argv；任何偏差都固定拒绝。
 * @param {unknown} rawArgv
 */
function parseRawArgv(rawArgv) {
  if (!Array.isArray(rawArgv) || (rawArgv.length !== 6 && rawArgv.length !== 9)) {
    throw argumentsInvalid();
  }
  const [command, dataDirFlag, dataDir, scopeFlag, scope, stdinFlag] = rawArgv;
  if (
    command !== 'management-auth-rotate'
    || dataDirFlag !== '--data-dir'
    || scopeFlag !== '--scope'
    || stdinFlag !== '--token-stdin'
    || !ROTATABLE_SCOPES.has(scope)
    || typeof dataDir !== 'string'
    || dataDir.length === 0
    || dataDir.includes('\0')
    || !isAbsolute(dataDir)
    || normalize(dataDir) !== dataDir
  ) {
    throw argumentsInvalid();
  }
  if (rawArgv.length === 6) {
    return { dataDir, scope, restartController: false, controllerPort: null };
  }

  const [restartFlag, controllerPortFlag, rawControllerPort] = rawArgv.slice(6);
  if (
    restartFlag !== '--restart-controller'
    || controllerPortFlag !== '--controller-port'
    || typeof rawControllerPort !== 'string'
    || !/^[1-9]\d{0,4}$/.test(rawControllerPort)
  ) {
    throw argumentsInvalid();
  }
  const controllerPort = Number(rawControllerPort);
  if (
    !Number.isSafeInteger(controllerPort)
    || controllerPort > 65_535
    || String(controllerPort) !== rawControllerPort
  ) {
    throw argumentsInvalid();
  }
  return { dataDir, scope, restartController: true, controllerPort };
}

async function appendRestartAuditBestEffort(appendAuditEvent, dataDir, event) {
  try {
    await appendAuditEvent(dataDir, event);
  } catch {
    // 重启主结果优先；post-outcome audit 保持 best-effort。
  }
}

async function appendRequiredRestartStartAudit(appendAuditEvent, dataDir, scope) {
  try {
    await appendAuditEvent(dataDir, {
      type: 'management.auth.controller-restart.started',
      outcome: 'started',
      operation: scope,
    });
  } catch {
    throw new ManagementAuthControllerRestartError(
      'management-auth-controller-restart-unavailable',
    );
  }
}

/**
 * 从 AsyncIterable 读取最多 4096 字节，严格解码 UTF-8，并剥离最多一个尾部 LF/CRLF。
 * @param {AsyncIterable<unknown>} input
 */
async function readRotationToken(input) {
  const chunks = [];
  const sourceBuffers = [];
  let combined = null;
  try {
    if (!input || typeof input[Symbol.asyncIterator] !== 'function') throw stdinInvalid();
    let totalBytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      if (Buffer.isBuffer(chunk)) sourceBuffers.push(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_STDIN_BYTES) throw stdinInvalid();
    }

    combined = Buffer.concat(chunks);
    let value = UTF8_DECODER.decode(combined);
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    else if (value.endsWith('\n')) value = value.slice(0, -1);
    if (!value || value.includes('\n') || value.includes('\r') || value.includes('\0')) {
      throw stdinInvalid();
    }
    return validateManagementAuthRotationToken(value);
  } catch (error) {
    if (error instanceof ManagementAuthRotateCommandError && error.code === STDIN_INVALID) {
      throw error;
    }
    throw stdinInvalid();
  } finally {
    // Node 字符串不可可靠清零；这里只收敛可变 stdin 字节及内部复制品的驻留窗口。
    for (const buffer of [combined, ...chunks, ...sourceBuffers]) {
      try {
        if (Buffer.isBuffer(buffer)) buffer.fill(0);
      } catch {
        // 清理保持 best-effort，不能覆盖既有成功或固定失败语义。
      }
    }
    chunks.length = 0;
    sourceBuffers.length = 0;
  }
}

/**
 * 执行 management-auth-rotate。
 * @param {unknown} rawArgv
 * @param {{
 *   input?: AsyncIterable<unknown>,
 *   createKeychain?: () => unknown | Promise<unknown>,
 *   createExclusiveLock?: (dataDir: string) => unknown | Promise<unknown>,
 *   stage?: typeof stageManagementAuthKeychainRotation,
 *   appendAuditEvent?: typeof appendLocalAuditEvent,
 *   restartController?: typeof restartManagementAuthController,
 *   writeOutput?: (value: string) => unknown | Promise<unknown>,
 * }} [deps]
 */
export async function runManagementAuthRotateCommand(rawArgv, deps = {}) {
  const {
    dataDir,
    scope,
    restartController: restartRequested,
    controllerPort,
  } = parseRawArgv(rawArgv);
  const input = deps.input ?? process.stdin;
  const newToken = await readRotationToken(input);

  const createKeychain = deps.createKeychain ?? (() => new KeychainStore());
  const createExclusiveLock = deps.createExclusiveLock ?? createManagementAuthRotationExclusiveLock;
  const stage = deps.stage ?? stageManagementAuthKeychainRotation;
  const appendAuditEvent = deps.appendAuditEvent ?? appendLocalAuditEvent;
  const restartController = deps.restartController ?? restartManagementAuthController;
  const writeOutput = deps.writeOutput ?? ((value) => process.stdout.write(value));

  if (restartRequested) {
    await appendRequiredRestartStartAudit(appendAuditEvent, dataDir, scope);
  }

  let rotationReceipt;
  try {
    const keychain = await createKeychain();
    const withExclusiveLock = await createExclusiveLock(dataDir);
    rotationReceipt = await stage({ keychain, scope, newToken, withExclusiveLock });
  } catch (error) {
    if (restartRequested) {
      await appendRestartAuditBestEffort(appendAuditEvent, dataDir, {
        type: 'management.auth.controller-restart.failed',
        outcome: 'failure',
        operation: scope,
      });
    }
    throw error;
  }

  let outputReceipt = rotationReceipt;
  if (restartRequested) {
    try {
      outputReceipt = await restartController({
        rotationReceipt,
        newToken,
        controllerPort,
      });
    } catch (error) {
      await appendRestartAuditBestEffort(appendAuditEvent, dataDir, {
        type: 'management.auth.controller-restart.failed',
        outcome: 'failure',
        operation: scope,
      });
      throw error;
    }
    await appendRestartAuditBestEffort(appendAuditEvent, dataDir, {
      type: 'management.auth.controller-restart.completed',
      outcome: 'success',
      operation: scope,
    });
  }

  await writeOutput(`${JSON.stringify(outputReceipt)}\n`);
  return outputReceipt;
}
