/**
 * 管理认证轮换 CLI 命令核心。
 * argv 只接收公开参数；新 token 仅从 stdin 读取，所有底层错误均由调用方固定映射。
 */

import { isAbsolute, normalize } from 'node:path';
import { TextDecoder } from 'node:util';
import { KeychainStore } from './keychain-store.js';
import {
  stageManagementAuthKeychainRotation,
  validateManagementAuthRotationToken,
} from './management-auth-rotation.js';
import { createManagementAuthRotationExclusiveLock } from './management-auth-rotation-process-lock.js';

const ARGUMENTS_INVALID = 'management-auth-rotate-arguments-invalid';
const STDIN_INVALID = 'management-auth-rotate-stdin-invalid';
const MAX_STDIN_BYTES = 4_096;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

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
 * 解析精确六段 argv；任何数量、顺序、值域或路径形状偏差都固定拒绝。
 * @param {unknown} rawArgv
 */
function parseRawArgv(rawArgv) {
  if (!Array.isArray(rawArgv) || rawArgv.length !== 6) throw argumentsInvalid();
  const [command, dataDirFlag, dataDir, scopeFlag, scope, stdinFlag] = rawArgv;
  if (
    command !== 'management-auth-rotate'
    || dataDirFlag !== '--data-dir'
    || scopeFlag !== '--scope'
    || stdinFlag !== '--token-stdin'
    || (scope !== 'read' && scope !== 'write')
    || typeof dataDir !== 'string'
    || dataDir.length === 0
    || dataDir.includes('\0')
    || !isAbsolute(dataDir)
    || normalize(dataDir) !== dataDir
  ) {
    throw argumentsInvalid();
  }
  return { dataDir, scope };
}

/**
 * 从 AsyncIterable 读取最多 4096 字节，严格解码 UTF-8，并剥离最多一个尾部 LF/CRLF。
 * @param {AsyncIterable<unknown>} input
 */
async function readRotationToken(input) {
  try {
    if (!input || typeof input[Symbol.asyncIterator] !== 'function') throw stdinInvalid();
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_STDIN_BYTES) throw stdinInvalid();
      chunks.push(buffer);
    }

    let value = UTF8_DECODER.decode(Buffer.concat(chunks));
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
 *   writeOutput?: (value: string) => unknown | Promise<unknown>,
 * }} [deps]
 */
export async function runManagementAuthRotateCommand(rawArgv, deps = {}) {
  const { dataDir, scope } = parseRawArgv(rawArgv);
  const input = deps.input ?? process.stdin;
  const newToken = await readRotationToken(input);

  const createKeychain = deps.createKeychain ?? (() => new KeychainStore());
  const createExclusiveLock = deps.createExclusiveLock ?? createManagementAuthRotationExclusiveLock;
  const stage = deps.stage ?? stageManagementAuthKeychainRotation;
  const writeOutput = deps.writeOutput ?? ((value) => process.stdout.write(value));

  const keychain = await createKeychain();
  const withExclusiveLock = await createExclusiveLock(dataDir);
  const receipt = await stage({ keychain, scope, newToken, withExclusiveLock });
  await writeOutput(`${JSON.stringify(receipt)}\n`);
  return receipt;
}
