/**
 * V1.46 management auth Keychain source — 启动读取路径。
 *
 * 职责：
 * - 固定 scope → Keychain itemId → management option 字段映射（声明顺序即读取顺序）；
 * - 纯 selector / scope 解析与 direct token 互斥校验（无任何 I/O，可单测）；
 * - fake-friendly 的异步加载器：只依赖注入 keychain 的 get(itemId)，便于内存 fake。
 *
 * 边界：
 * - 读取构成非原子的 startup snapshot；不做 hot reload，运行期 Keychain 变更需受控重启；
 * - previous/current pairing 仅为 presence 校验；同一 token 值跨 scope 沿用既有最宽权限语义；
 * - 缺失/不可用/任意读取拒绝原样传播，无 fallback；值必须是非空白字符串，否则 fail closed。
 */

/** 管理认证来源 selector 环境变量名。 */
export const MANAGEMENT_AUTH_SOURCE_ENV = 'LINKE_MANAGEMENT_AUTH_SOURCE';

/** Keychain scope 声明列表环境变量名。 */
export const MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV = 'LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES';

/** selector 唯一合法取值（精确小写 keychain；未定义表示 legacy 环境变量直读）。 */
const MANAGEMENT_AUTH_SOURCE_KEYCHAIN = 'keychain';

/**
 * 固定 scope 定义表。
 * itemId 即既有 KeychainStore 默认 service（com.linke.gold）下的 account；
 * current=false 的 previous scope 通过 requires 声明 presence 配对要求。
 */
export const MANAGEMENT_AUTH_SCOPE_MAP = Object.freeze([
  Object.freeze({ scope: 'full', itemId: 'management-auth.full', optionKey: 'authToken', current: true, requires: null }),
  Object.freeze({ scope: 'read', itemId: 'management-auth.read', optionKey: 'readToken', current: true, requires: null }),
  Object.freeze({ scope: 'previous-read', itemId: 'management-auth.read.previous', optionKey: 'previousReadToken', current: false, requires: 'read' }),
  Object.freeze({ scope: 'write', itemId: 'management-auth.write', optionKey: 'writeToken', current: true, requires: null }),
  Object.freeze({ scope: 'previous-write', itemId: 'management-auth.write.previous', optionKey: 'previousWriteToken', current: false, requires: 'write' }),
  Object.freeze({ scope: 'admin', itemId: 'management-auth.admin', optionKey: 'adminToken', current: true, requires: null }),
]);

const SCOPE_BY_NAME = new Map(MANAGEMENT_AUTH_SCOPE_MAP.map((def) => [def.scope, def]));

/** keychain 模式下禁止已定义（含空串）的 direct token 环境变量；永不 fallback。 */
const DIRECT_TOKEN_ENV_NAMES = Object.freeze([
  'LINKE_AUTH_TOKEN',
  'LINKE_TOKEN',
  'LINKE_READ_TOKEN',
  'LINKE_PREVIOUS_READ_TOKEN',
  'LINKE_WRITE_TOKEN',
  'LINKE_PREVIOUS_WRITE_TOKEN',
  'LINKE_ADMIN_TOKEN',
]);

/** startController options 中与 managementAuthKeychainScopes 互斥的 direct token 字段。 */
const DIRECT_TOKEN_OPTION_KEYS = Object.freeze([
  'authToken',
  'readToken',
  'previousReadToken',
  'writeToken',
  'previousWriteToken',
  'adminToken',
]);

/**
 * 校验 scope 名称列表：拒绝非字符串/空项/未知/大小写变体/重复；
 * 要求 previous 配对 current presence，且至少一个 current scope。顺序保持不变。
 * 返回值为独立、不可变（frozen）的快照副本：调用方随后改写原数组不影响校验结果，
 * 也不会在异步读取的 await 之间改变实际读取集合/顺序（TOCTOU 防线）。
 * @param {unknown[]} scopes
 * @returns {string[]} 通过校验的 scope 不可变快照（原顺序）
 */
function assertValidScopeList(scopes) {
  const seen = new Set();
  for (const scope of scopes) {
    if (typeof scope !== 'string' || scope.length === 0) {
      throw new Error('management auth scope entry must be a non-empty string');
    }
    if (!SCOPE_BY_NAME.has(scope)) {
      throw new Error('unknown management auth scope');
    }
    if (seen.has(scope)) {
      throw new Error('duplicate management auth scope');
    }
    seen.add(scope);
  }
  let hasCurrent = false;
  for (const scope of scopes) {
    const def = SCOPE_BY_NAME.get(scope);
    if (def.current) hasCurrent = true;
    if (def.requires !== null && !seen.has(def.requires)) {
      throw new Error(`${scope} scope requires matching current ${def.requires} scope`);
    }
  }
  if (!hasCurrent) {
    throw new Error('at least one current management auth scope is required');
  }
  // 独立不可变快照：与调用方数组脱离，声明顺序保持。
  return Object.freeze([...scopes]);
}

/**
 * 解析并校验逗号分隔的 scope 声明字符串：split 后逐项 trim，保持声明顺序。
 * @param {unknown} raw LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES 原始值
 * @returns {string[]} 合法 scope 不可变快照
 */
export function parseManagementAuthScopeList(raw) {
  if (typeof raw !== 'string') {
    throw new Error(
      `${MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV} is required when management auth source is keychain`,
    );
  }
  return assertValidScopeList(raw.split(',').map((item) => item.trim()));
}

/**
 * 解析管理认证 selector 环境（纯函数，无 I/O）。
 * legacy：LINKE_MANAGEMENT_AUTH_SOURCE 未定义（此时 scopes 变量必须也未定义）；
 * keychain：精确小写 keychain + 合法 scopes + 七个 direct token 环境变量全部未定义。
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {{ mode: 'legacy', scopes: undefined } | { mode: 'keychain', scopes: string[] }}
 */
export function parseManagementAuthEnv(env = {}) {
  const rawSource = env[MANAGEMENT_AUTH_SOURCE_ENV];
  const rawScopes = env[MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV];
  if (rawSource === undefined) {
    if (rawScopes !== undefined) {
      throw new Error(
        `${MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV} requires ${MANAGEMENT_AUTH_SOURCE_ENV}=keychain`,
      );
    }
    return { mode: 'legacy', scopes: undefined };
  }
  if (rawSource !== MANAGEMENT_AUTH_SOURCE_KEYCHAIN) {
    throw new Error(`${MANAGEMENT_AUTH_SOURCE_ENV} must be exactly "keychain" when defined`);
  }
  const scopes = parseManagementAuthScopeList(rawScopes);
  for (const name of DIRECT_TOKEN_ENV_NAMES) {
    if (env[name] !== undefined) {
      throw new Error(`${name} must not be defined when management auth source is keychain`);
    }
  }
  return { mode: 'keychain', scopes };
}

/**
 * 校验 startController 的 managementAuthKeychainScopes 选项（纯函数，无 I/O）。
 * 必须在生产 KeychainStore 构造之前调用；scopes 与 direct token 选项（含空串）互斥。
 * @param {{
 *   managementAuthKeychainScopes?: unknown,
 *   authToken?: unknown,
 *   readToken?: unknown,
 *   previousReadToken?: unknown,
 *   writeToken?: unknown,
 *   previousWriteToken?: unknown,
 *   adminToken?: unknown,
 * }} [options]
 * @returns {string[] | null} keychain 模式返回校验后的 scope 不可变快照；legacy 返回 null
 */
export function validateManagementAuthOptions(options = {}) {
  const scopes = options.managementAuthKeychainScopes;
  if (scopes === undefined) return null;
  if (!Array.isArray(scopes)) {
    throw new Error('managementAuthKeychainScopes must be an array of management auth scope names');
  }
  for (const key of DIRECT_TOKEN_OPTION_KEYS) {
    if (options[key] !== undefined) {
      throw new Error(
        'managementAuthKeychainScopes must not be combined with direct management token options',
      );
    }
  }
  return assertValidScopeList(scopes);
}

/**
 * 按声明顺序从注入 keychain 顺序读取已声明管理认证项（只读取声明项）。
 * 读取拒绝（missing/unavailable/任意原始错误）原样传播，无 fallback；
 * 值必须是非空白字符串，否则以固定非秘密错误 fail closed；失败后不再发起后续 get。
 * @param {{ get: (itemId: string) => Promise<string> }} keychain 注入的 Keychain 适配器
 * @param {string[]} scopes 已通过校验的 scope 列表
 * @returns {Promise<{
 *   authToken?: string,
 *   readToken?: string,
 *   previousReadToken?: string,
 *   writeToken?: string,
 *   previousWriteToken?: string,
 *   adminToken?: string,
 * }>} 仅含已声明 scope 对应字段的 token 对象
 */
export async function loadManagementAuthTokens(keychain, scopes) {
  const tokens = {};
  for (const scope of scopes) {
    const def = SCOPE_BY_NAME.get(scope);
    if (!def) {
      throw new Error('unknown management auth scope');
    }
    const value = await keychain.get(def.itemId);
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`management auth Keychain item ${def.itemId} must hold a non-empty secret`);
    }
    tokens[def.optionKey] = value;
  }
  return tokens;
}
