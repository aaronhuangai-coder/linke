/**
 * 管理认证 controller 显式重启边界。
 *
 * 只接受同一进程内真实 Keychain staging receipt 的一次性对象身份 authority；固定执行
 * `launchctl kickstart -k gui/<uid>/com.linke.controller`，随后用新 token 请求固定 loopback
 * `/api/auth-status`，证明 controller 已从 Keychain 建立新的 startup snapshot 且 previous
 * overlap 生效。公开结果与错误均不包含 token、Authorization、响应 body 或底层异常。
 */

import { execFile as execFileCallback } from 'node:child_process';
import http from 'node:http';
import { promisify, types as utilTypes } from 'node:util';

import {
  assertAndConsumeManagementAuthRestartAuthority,
  validateManagementAuthRotationToken,
} from './management-auth-rotation.js';

const RESTART_INVALID = 'management-auth-controller-restart-invalid';
const RESTART_UNAVAILABLE = 'management-auth-controller-restart-unavailable';
const RESTART_AUTHENTICATION_FAILED =
  'management-auth-controller-restart-authentication-failed';
const RESTART_CODES = new Set([
  RESTART_INVALID,
  RESTART_UNAVAILABLE,
  RESTART_AUTHENTICATION_FAILED,
]);

const LAUNCHCTL_EXECUTABLE = '/bin/launchctl';
const CONTROLLER_LABEL = 'com.linke.controller';
const LAUNCHCTL_TIMEOUT_MS = 10_000;
const MAX_SUBPROCESS_BUFFER_BYTES = 64 * 1024;
const AUTH_REQUEST_TIMEOUT_MS = 5_000;
const AUTH_PROOF_WINDOW_MS = 30_000;
const AUTH_RETRY_DELAY_MS = 250;
const MAX_AUTH_ATTEMPTS = 121;
const MAX_AUTH_BODY_BYTES = 64 * 1024;

const execFileAsync = promisify(execFileCallback);

/** 固定、无秘密回显的 controller 重启错误。 */
export class ManagementAuthControllerRestartError extends Error {
  constructor(code = RESTART_INVALID) {
    const fixedCode = RESTART_CODES.has(code) ? code : RESTART_INVALID;
    super(fixedCode);
    this.name = 'ManagementAuthControllerRestartError';
    this.code = fixedCode;
  }
}

function invalid() {
  throw new ManagementAuthControllerRestartError(RESTART_INVALID);
}

function unavailable() {
  throw new ManagementAuthControllerRestartError(RESTART_UNAVAILABLE);
}

function authenticationFailed() {
  throw new ManagementAuthControllerRestartError(RESTART_AUTHENTICATION_FAILED);
}

function readExactObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== 'string')) {
    invalid();
  }
  const expected = new Set(expectedKeys);
  const fields = Object.create(null);
  for (const key of ownKeys) {
    if (!expected.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    fields[key] = descriptor.value;
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(fields, key)) invalid();
  }
  return fields;
}

function validateInput(input) {
  const fields = readExactObject(input, ['rotationReceipt', 'newToken', 'controllerPort']);
  let newToken;
  try {
    newToken = validateManagementAuthRotationToken(fields.newToken);
  } catch {
    invalid();
  }
  if (
    !Number.isSafeInteger(fields.controllerPort)
    || fields.controllerPort < 1
    || fields.controllerPort > 65_535
  ) {
    invalid();
  }
  return {
    rotationReceipt: fields.rotationReceipt,
    newToken,
    controllerPort: fields.controllerPort,
  };
}

function validateDependencies(value) {
  const fields = readExactObject(value, ['getUid', 'execFile', 'request', 'now', 'wait']);
  for (const key of ['getUid', 'execFile', 'request', 'now', 'wait']) {
    if (typeof fields[key] !== 'function') invalid();
  }
  return fields;
}

function projectAuthenticationProof(response, scope) {
  try {
    if (response === null || typeof response !== 'object' || utilTypes.isProxy(response)) {
      return false;
    }
    if (response.statusCode !== 200) return false;
    let body = response.body;
    if (typeof body === 'string') body = Buffer.from(body, 'utf8');
    if (!Buffer.isBuffer(body) || body.byteLength > MAX_AUTH_BODY_BYTES) return false;
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const auth = parsed.auth;
    const source = parsed.startupCredentialSource;
    const safety = parsed.safety;
    if (
      parsed.status !== 'ok'
      || parsed.service !== 'linke'
      || auth === null
      || typeof auth !== 'object'
      || Array.isArray(auth)
      || auth.enabled !== true
      || auth.configuredScopes === null
      || typeof auth.configuredScopes !== 'object'
      || Array.isArray(auth.configuredScopes)
      || auth.configuredScopes[scope] !== true
      || auth.previousTokenOverlapConfigured === null
      || typeof auth.previousTokenOverlapConfigured !== 'object'
      || Array.isArray(auth.previousTokenOverlapConfigured)
      || auth.previousTokenOverlapConfigured[scope] !== true
      || source === null
      || typeof source !== 'object'
      || Array.isArray(source)
      || source.mode !== 'keychain'
      || source.startupSnapshot !== true
      || source.hotReload !== false
      || safety === null
      || typeof safety !== 'object'
      || Array.isArray(safety)
      || safety.tokenValuesReturned !== false
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function launchctlOptions() {
  return {
    timeout: LAUNCHCTL_TIMEOUT_MS,
    maxBuffer: MAX_SUBPROCESS_BUFFER_BYTES,
    shell: false,
    encoding: 'utf8',
  };
}

function authRequestOptions(newToken) {
  return {
    timeout: AUTH_REQUEST_TIMEOUT_MS,
    headers: { authorization: `Bearer ${newToken}` },
  };
}

function resultReceipt(authority) {
  return Object.freeze({
    state: 'restarted',
    scope: authority.scope,
    previousOverlapConfigured: true,
    controllerRestarted: true,
    authenticationVerified: true,
    restartRequired: false,
    hotReload: false,
    automaticRestart: false,
    sensitiveValuesReturned: false,
    alreadyStaged: authority.alreadyStaged,
  });
}

async function restartInternal(input, dependencies) {
  const validated = validateInput(input);
  const deps = validateDependencies(dependencies);

  let uid;
  let proofStartedAt;
  try {
    uid = deps.getUid();
    proofStartedAt = deps.now();
  } catch {
    invalid();
  }
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isFinite(proofStartedAt)) invalid();

  let authority;
  try {
    authority = assertAndConsumeManagementAuthRestartAuthority(validated.rotationReceipt);
  } catch {
    unavailable();
  }

  try {
    await deps.execFile(
      LAUNCHCTL_EXECUTABLE,
      ['kickstart', '-k', `gui/${uid}/${CONTROLLER_LABEL}`],
      launchctlOptions(),
    );
  } catch {
    unavailable();
  }

  const url = `http://127.0.0.1:${validated.controllerPort}/api/auth-status`;
  for (let attempt = 0; attempt < MAX_AUTH_ATTEMPTS; attempt += 1) {
    let response = null;
    try {
      response = await deps.request(url, authRequestOptions(validated.newToken));
    } catch {
      response = null;
    }
    if (projectAuthenticationProof(response, authority.scope)) {
      return resultReceipt(authority);
    }

    let currentTime;
    try {
      currentTime = deps.now();
    } catch {
      authenticationFailed();
    }
    if (
      !Number.isFinite(currentTime)
      || currentTime < proofStartedAt
      || currentTime - proofStartedAt >= AUTH_PROOF_WINDOW_MS
      || attempt === MAX_AUTH_ATTEMPTS - 1
    ) {
      authenticationFailed();
    }
    try {
      await deps.wait(AUTH_RETRY_DELAY_MS);
    } catch {
      authenticationFailed();
    }
  }
  authenticationFailed();
}

function productionGetUid() {
  if (typeof process.getuid !== 'function') invalid();
  return process.getuid();
}

async function productionExecFile(file, argv, options) {
  return execFileAsync(file, argv, options);
}

function productionRequest(url, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    const chunks = [];
    let request;
    let responseStream;
    let hardDeadline;

    const clearHardDeadline = () => {
      if (hardDeadline !== undefined) clearTimeout(hardDeadline);
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      clearHardDeadline();
      try {
        request?.destroy();
      } catch {
        // ignore
      }
      try {
        responseStream?.destroy();
      } catch {
        // ignore
      }
      reject(new Error(RESTART_AUTHENTICATION_FAILED));
    };

    hardDeadline = setTimeout(fail, AUTH_REQUEST_TIMEOUT_MS);

    try {
      request = http.get(url, options, (response) => {
        responseStream = response;
        response.on('data', (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bytes.byteLength;
          if (totalBytes > MAX_AUTH_BODY_BYTES) {
            try {
              response.destroy();
            } catch {
              // ignore
            }
            fail();
            return;
          }
          chunks.push(bytes);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearHardDeadline();
          resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks) });
        });
        response.on('aborted', fail);
        response.on('error', fail);
      });
      request.on('error', fail);
      request.on('timeout', fail);
    } catch {
      fail();
    }
  });
}

function productionWait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  getUid: productionGetUid,
  execFile: productionExecFile,
  request: productionRequest,
  now: () => Date.now(),
  wait: productionWait,
});

/**
 * 生产显式 controller 重启。构造/import 零副作用；仅调用本函数才执行 launchctl/loopback HTTP。
 */
export async function restartManagementAuthController(input) {
  return restartInternal(input, PRODUCTION_DEPENDENCIES);
}

/** 测试专用：精确注入 getUid/execFile/request/now/wait，绝不被生产 CLI 调用。 */
export async function restartManagementAuthControllerForTest(input, dependencies) {
  return restartInternal(input, dependencies);
}
