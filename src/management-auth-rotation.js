/**
 * V1.46 管理认证 Keychain 轮换 staging。
 *
 * 职责：
 * - 在调用方注入的排他锁临界区内，把指定 current scope（read/write）的 Keychain item
 *   轮换为 newToken：先把旧 current 写入配对的 previous item（overlap 回滚锚点），
 *   再写 current=newToken，最后严格复读校验；
 * - 幂等重试：crash window 状态（previous 已写/current 未写、两写均已完成）可被
 *   同一 newToken 安全重试；
 * - 所有公开结果只有两种形状：冻结的 sanitized receipt，或固定三码之一的
 *   ManagementAuthRotationError（message===code，绝不回显 token、itemId、scope、
 *   底层错误或路径）。
 *
 * 边界（本轮不交付）：
 * - 不接真实 Keychain、不提供 CLI、不接线任何自动重启；receipt 固定
 *   restartRequired:true / hotReload:false / automaticRestart:false；
 * - 排他锁由调用方注入；本模块只做单进程 task exact-once/结果防篡改 guard，
 *   不声称 production 多进程锁语义；
 * - 失败路径只读分类，绝不 delete、绝不自动 rollback/修复。
 */

import { timingSafeEqual } from 'node:crypto';
import { MANAGEMENT_AUTH_SCOPE_MAP } from './management-auth-keychain.js';

const ROTATION_INVALID = 'management-auth-rotation-invalid';
const ROTATION_UNAVAILABLE = 'management-auth-rotation-unavailable';
const ROTATION_RECOVERY_REQUIRED = 'management-auth-rotation-recovery-required';

const ROTATION_ERROR_CODES = new Set([
  ROTATION_INVALID,
  ROTATION_UNAVAILABLE,
  ROTATION_RECOVERY_REQUIRED,
]);

/**
 * 管理认证轮换固定错误：name/code/message 不包含 token、itemId、scope、路径或底层错误。
 */
export class ManagementAuthRotationError extends Error {
  /**
   * @param {unknown} code
   */
  constructor(code = ROTATION_INVALID) {
    const fixedCode = ROTATION_ERROR_CODES.has(code) ? code : ROTATION_INVALID;
    super(fixedCode);
    this.name = 'ManagementAuthRotationError';
    this.code = fixedCode;
  }
}

/** KeychainStore 缺失项错误码：仅在 previous 初读时视为 absent。 */
const KEYCHAIN_ITEM_MISSING = 'keychain-item-missing';

/** newToken 纯前置约束：base64url 字符集且长度 43..128。 */
const NEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * newToken 单一真值源纯校验：base64url 字符集且长度 43..128。
 * 合法时原样返回该字符串；非法时固定抛 ManagementAuthRotationError(invalid)，
 * 绝不回显 token 内容。纯函数：零副作用、零 I/O。
 * @param {unknown} token
 * @returns {string} 校验通过的原 token 字符串
 */
export function validateManagementAuthRotationToken(token) {
  if (typeof token !== 'string' || !NEW_TOKEN_PATTERN.test(token)) {
    throw new ManagementAuthRotationError(ROTATION_INVALID);
  }
  return token;
}

/**
 * 从既有固定映射表派生 scope 的 current/previous itemId（不复制硬编码映射）。
 * @param {string} scope 已通过前置校验的 scope（read/write）
 * @returns {{ currentId: string, previousId: string }}
 */
function rotationItemIds(scope) {
  const current = MANAGEMENT_AUTH_SCOPE_MAP.find((def) => def.scope === scope && def.current === true);
  const previous = MANAGEMENT_AUTH_SCOPE_MAP.find(
    (def) => def.current === false && def.requires === scope,
  );
  if (!current || !previous) {
    throw new ManagementAuthRotationError(ROTATION_INVALID);
  }
  return { currentId: current.itemId, previousId: previous.itemId };
}

/**
 * @param {unknown} value
 * @returns {boolean} 是否 plain object（Object.prototype 或 null 原型）
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} value
 * @returns {boolean} 可用秘密值：非空白字符串
 */
function isUsableSecret(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 安全判定 keychain-item-missing：读取 error.code 本身可能触发 throwing getter，
 * 任何意外都按非 missing 处理（→ unavailable），绝不让底层异常逃逸。
 * @param {unknown} error
 * @returns {boolean}
 */
function isKeychainItemMissing(error) {
  if (error === null || typeof error !== 'object') return false;
  try {
    return error.code === KEYCHAIN_ITEM_MISSING;
  } catch {
    return false;
  }
}

/**
 * Constant-time 秘密值相等：长度不同直接 false（不泄露内容），否则 timingSafeEqual。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function secretsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 纯前置校验：任何非法输入在锁与 Keychain 之前固定 invalid，零副作用。
 * @param {unknown} input
 * @returns {{ keychain: { get: Function, set: Function }, scope: string, newToken: string, withExclusiveLock: Function }}
 */
function validateRotationInput(input) {
  if (!isPlainObject(input)) {
    throw new ManagementAuthRotationError(ROTATION_INVALID);
  }
  const { keychain, scope, newToken, withExclusiveLock } = input;
  if (
    keychain === null
    || typeof keychain !== 'object'
    || typeof keychain.get !== 'function'
    || typeof keychain.set !== 'function'
  ) {
    throw new ManagementAuthRotationError(ROTATION_INVALID);
  }
  if (typeof withExclusiveLock !== 'function') {
    throw new ManagementAuthRotationError(ROTATION_INVALID);
  }
  if (scope !== 'read' && scope !== 'write') {
    throw new ManagementAuthRotationError(ROTATION_INVALID);
  }
  // newToken 校验委托给单一真值源 validateManagementAuthRotationToken。
  return { keychain, scope, newToken: validateManagementAuthRotationToken(newToken), withExclusiveLock };
}

/**
 * 冻结的 sanitized 成功 receipt：无 token、无 itemId、无路径。
 * @param {string} scope
 * @param {boolean} alreadyStaged
 */
function buildStagedReceipt(scope, alreadyStaged) {
  return Object.freeze({
    state: 'staged',
    scope,
    previousOverlapConfigured: true,
    restartRequired: true,
    hotReload: false,
    automaticRestart: false,
    sensitiveValuesReturned: false,
    alreadyStaged,
  });
}

/**
 * 写入后的只读分类复读（正常最终校验与写错误分类共用同一真值表）：
 * - previous==oldCurrent 且 current==newToken → staged receipt；
 * - previous==oldCurrent 且 current==oldCurrent → unavailable（写未生效）；
 * - 其它组合或无法读取 → recovery-required。
 * 严格按 previous → current 顺序复读；绝不写入、delete 或修复。
 * @param {{ get: Function }} keychain
 * @param {{ scope: string, newToken: string, currentId: string, previousId: string, oldCurrent: string }} ctx
 */
async function classifyAfterWrite(keychain, { scope, newToken, currentId, previousId, oldCurrent }) {
  let previousNow;
  try {
    previousNow = await keychain.get(previousId);
  } catch {
    throw new ManagementAuthRotationError(ROTATION_RECOVERY_REQUIRED);
  }
  let currentNow;
  try {
    currentNow = await keychain.get(currentId);
  } catch {
    throw new ManagementAuthRotationError(ROTATION_RECOVERY_REQUIRED);
  }
  if (!isUsableSecret(previousNow) || !isUsableSecret(currentNow)) {
    throw new ManagementAuthRotationError(ROTATION_RECOVERY_REQUIRED);
  }
  if (!secretsEqual(previousNow, oldCurrent)) {
    throw new ManagementAuthRotationError(ROTATION_RECOVERY_REQUIRED);
  }
  if (secretsEqual(currentNow, newToken)) {
    return buildStagedReceipt(scope, false);
  }
  if (secretsEqual(currentNow, oldCurrent)) {
    throw new ManagementAuthRotationError(ROTATION_UNAVAILABLE);
  }
  throw new ManagementAuthRotationError(ROTATION_RECOVERY_REQUIRED);
}

/**
 * 锁内 staging 主体：初读 → 同值分类 → 写入 → 只读复读分类。
 * @param {{ get: Function, set: Function }} keychain
 * @param {{ scope: string, newToken: string, currentId: string, previousId: string }} ctx
 */
async function runStaging(keychain, { scope, newToken, currentId, previousId }) {
  // 初读 current：missing/任意异常/非字符串/空白 → unavailable。
  let current;
  try {
    current = await keychain.get(currentId);
  } catch {
    throw new ManagementAuthRotationError(ROTATION_UNAVAILABLE);
  }
  if (!isUsableSecret(current)) {
    throw new ManagementAuthRotationError(ROTATION_UNAVAILABLE);
  }
  // 初读 previous：仅 code=keychain-item-missing 视为 absent；其它异常 unavailable；
  // 正常返回的非字符串/空白 → recovery-required。
  // 注意 absent 必须用独立布尔记录：get 可能正常返回 null/undefined 等任意非法值，
  // 不能与"缺失"哨兵混用。
  let previous = null;
  let previousPresent = false;
  try {
    previous = await keychain.get(previousId);
    previousPresent = true;
  } catch (error) {
    if (isKeychainItemMissing(error)) {
      previousPresent = false;
    } else {
      throw new ManagementAuthRotationError(ROTATION_UNAVAILABLE);
    }
  }
  if (previousPresent && !isUsableSecret(previous)) {
    throw new ManagementAuthRotationError(ROTATION_RECOVERY_REQUIRED);
  }
  // 同值分类（constant-time 比较）。
  if (secretsEqual(newToken, current)) {
    if (previousPresent && !secretsEqual(previous, current)) {
      return buildStagedReceipt(scope, true);
    }
    throw new ManagementAuthRotationError(ROTATION_RECOVERY_REQUIRED);
  }
  if (previousPresent && secretsEqual(newToken, previous)) {
    throw new ManagementAuthRotationError(ROTATION_INVALID);
  }
  // 写入顺序严格 previous=oldCurrent → current=newToken；任何写错误转入只读分类。
  const oldCurrent = current;
  try {
    await keychain.set(previousId, oldCurrent);
    await keychain.set(currentId, newToken);
  } catch {
    return classifyAfterWrite(keychain, { scope, newToken, currentId, previousId, oldCurrent });
  }
  // 正常路径最终复读：与写错误分类同一真值表。
  return classifyAfterWrite(keychain, { scope, newToken, currentId, previousId, oldCurrent });
}

/**
 * 管理认证 Keychain 轮换 staging 入口。
 *
 * 全部 Keychain 读取/写入/复读都发生在注入的 withExclusiveLock(task) 临界区内；
 * task 只允许被调用一次，重复/迟到调用在任何 I/O 前 fail closed；锁 settle 后校验
 * task 已完整 settle，且锁返回值与 task 原始结果对象严格同一引用（防伪造/篡改），
 * 否则固定 fail closed。
 *
 * @param {unknown} input { keychain, scope, newToken, withExclusiveLock }
 * @returns {Promise<object>} 冻结的 sanitized receipt
 */
export async function stageManagementAuthKeychainRotation(input) {
  // 前置校验期间的任何意外异常（如输入字段 getter 抛错）也属于公开入口错误：
  // 一律转换为固定 invalid，绝不裸漏底层错误。
  let validated;
  try {
    validated = validateRotationInput(input);
  } catch (error) {
    if (error instanceof ManagementAuthRotationError) throw error;
    throw new ManagementAuthRotationError(ROTATION_INVALID);
  }
  const { keychain, scope, newToken, withExclusiveLock } = validated;
  const { currentId, previousId } = rotationItemIds(scope);

  // task exact-once guard：记录调用次数与执行状态，锁 settle 后禁止任何迟到执行；
  // 即使锁吞掉重复调用的 fail-closed 错误，settle 后的无条件校验仍能发现违规。
  let invocationCount = 0;
  let guardViolation = false;
  let taskSettled = false;
  let taskOutcome = null;
  let lockSettled = false;

  const guardedTask = async () => {
    invocationCount += 1;
    if (invocationCount > 1 || lockSettled) {
      // 重复/迟到调用：在任何 I/O 之前 fail closed，并留下违规记录。
      guardViolation = true;
      throw new ManagementAuthRotationError(ROTATION_UNAVAILABLE);
    }
    try {
      const value = await runStaging(keychain, { scope, newToken, currentId, previousId });
      taskOutcome = { ok: true, value };
      return value;
    } catch (error) {
      taskOutcome = { ok: false, error };
      throw error;
    } finally {
      taskSettled = true;
    }
  };

  let lockReturn;
  try {
    lockReturn = await withExclusiveLock(guardedTask);
  } catch (error) {
    lockSettled = true;
    // task 自身已分类的失败原样抛出；锁后端失败固定 fail closed。
    if (taskOutcome !== null && !taskOutcome.ok) {
      throw taskOutcome.error;
    }
    throw new ManagementAuthRotationError(ROTATION_UNAVAILABLE);
  }
  lockSettled = true;

  // task 必须恰好完整执行过一次；锁返回值必须是 task 原始结果对象本身。
  if (guardViolation || invocationCount !== 1 || !taskSettled || taskOutcome === null) {
    throw new ManagementAuthRotationError(ROTATION_UNAVAILABLE);
  }
  if (!taskOutcome.ok) {
    throw taskOutcome.error;
  }
  if (lockReturn !== taskOutcome.value) {
    throw new ManagementAuthRotationError(ROTATION_UNAVAILABLE);
  }
  return taskOutcome.value;
}
