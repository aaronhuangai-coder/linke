/**
 * LaunchAgent 生命周期宿主适配层（V1.46 Task 3）。
 *
 * 边界：
 * - 仅 current-user LaunchAgent；无 sudo、LaunchDaemon、真实宿主 mutation、部署路径。
 * - production 仅提供只读 DirectoryService、host inspect、plutil lint、loopback health。
 * - launchctl runner 硬禁用；atomic publisher 固定 unsupported。
 * - `/bin/launchctl` 仅作不可调用边界声明，绝不可作为子进程可执行文件传入。
 * - 无 shell 拼接、无通用 rename/unlink/open-for-write；inspector 仅 lstat/realpath/read/hash。
 * - production factory 零 caller 依赖注入；ForTest factory 仅接受闭合注入面。
 * - 所有错误归一为 LaunchAgentLifecycleError 与既有固定码；绝不回显 path/home/uid/argv/stdout/stderr/body/原始异常消息。
 */

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFsPromises from 'node:fs/promises';
import http from 'node:http';
import {
  isAbsolute,
  basename as pathBasename,
  dirname as pathDirname,
  join as pathJoin,
  normalize as pathNormalize,
} from 'node:path';
import {
  LAUNCHAGENT_LIFECYCLE,
  LAUNCHAGENT_LIFECYCLE_CODES,
  LaunchAgentLifecycleError,
} from './contracts.js';

// ---------------------------------------------------------------------------
// 固定可执行路径与资源常量
// ---------------------------------------------------------------------------

/** DirectoryService 查询可执行文件（可调用）。 */
const DSCL_EXECUTABLE = '/usr/bin/dscl';
/** plutil lint 可执行文件（可调用）。 */
const PLUTIL_EXECUTABLE = '/usr/bin/plutil';
/**
 * launchctl 边界声明：仅记录固定路径，本模块绝不将其传入子进程 API。
 * 真实 runner 不存在；仅 disabled runner 对外暴露。
 */
const LAUNCHCTL_EXECUTABLE = '/bin/launchctl';
const LAUNCHCTL_CALLABLE = false;

const DSCL_TIMEOUT_MS = 5_000;
const DSCL_MAX_BUFFER_BYTES = 64 * 1024;
const PLUTIL_TIMEOUT_MS = 5_000;
const PLUTIL_MAX_BUFFER_BYTES = 64 * 1024;
const HEALTH_ABSOLUTE_CEILING_MS = 30_000;
const HEALTH_MAX_BODY_BYTES = 64 * 1024;
const BOOTSTRAP_BOOTOUT_TIMEOUT_MS = 10_000;
const KICKSTART_PRINT_TIMEOUT_MS = 5_000;

const ROOT_LAUNCH_AGENTS = LAUNCHAGENT_LIFECYCLE.rootIds.launchAgents;
const ROOT_METADATA = LAUNCHAGENT_LIFECYCLE.rootIds.metadata;
const FILENAME_CONTROLLER = LAUNCHAGENT_LIFECYCLE.filenames.controller;
const FILENAME_SCHEDULER = LAUNCHAGENT_LIFECYCLE.filenames.scheduler;
const FILENAME_MANIFEST = LAUNCHAGENT_LIFECYCLE.filenames.manifest;
const LABEL_CONTROLLER = LAUNCHAGENT_LIFECYCLE.labels.controller;
const LABEL_SCHEDULER = LAUNCHAGENT_LIFECYCLE.labels.scheduler;

const CODE_INVALID = LAUNCHAGENT_LIFECYCLE_CODES.INVALID;
const CODE_ACCOUNT = LAUNCHAGENT_LIFECYCLE_CODES.ACCOUNT_RESOLUTION_UNAVAILABLE;
const CODE_LAUNCHCTL_DISABLED = LAUNCHAGENT_LIFECYCLE_CODES.LAUNCHCTL_DISABLED;
const CODE_MUTATION_UNSUPPORTED =
  LAUNCHAGENT_LIFECYCLE_CODES.CONDITIONAL_MUTATION_UNSUPPORTED;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FILE_MODE_EXACT = 0o600;

const LAUNCHCTL_OPERATIONS = new Set(['bootstrap', 'bootout', 'kickstart', 'print']);
const PRINT_STATES = new Set(['running', 'waiting', 'exited', 'unknown']);
const CANDIDATE_ROLES = new Set(['controller', 'scheduler']);
const MAP_OUTCOMES = new Set([
  'ok',
  'timeout',
  'permission-denied',
  'nonzero-exit',
  'malformed-output',
  'unknown-result',
]);

/** 固定 basename → 角色 / 标签映射（仅 launchAgents 叶）。 */
const LAUNCH_AGENT_BASENAMES = Object.freeze({
  [FILENAME_CONTROLLER]: Object.freeze({
    role: 'controller',
    label: LABEL_CONTROLLER,
  }),
  [FILENAME_SCHEDULER]: Object.freeze({
    role: 'scheduler',
    label: LABEL_SCHEDULER,
  }),
});

/** rootId + basename 合法组合。 */
const ADDRESS_ALLOWLIST = Object.freeze({
  [ROOT_LAUNCH_AGENTS]: Object.freeze(new Set([FILENAME_CONTROLLER, FILENAME_SCHEDULER])),
  [ROOT_METADATA]: Object.freeze(new Set([FILENAME_MANIFEST])),
});

// 边界常量被读取一次，防止被优化掉，同时证明不可调用。
void (LAUNCHCTL_EXECUTABLE && LAUNCHCTL_CALLABLE === false);

// ---------------------------------------------------------------------------
// 错误与投影工具
// ---------------------------------------------------------------------------

/** 固定 invalid 码。 */
function invalid() {
  throw new LaunchAgentLifecycleError(CODE_INVALID);
}

/** 账号解析不可用。 */
function accountUnavailable() {
  throw new LaunchAgentLifecycleError(CODE_ACCOUNT);
}

/** 将任意异常归一为指定契约错误；已是契约错误则原样抛出。 */
function normalizeTo(error, throwFn) {
  if (error instanceof LaunchAgentLifecycleError) throw error;
  throwFn();
}

/** 深度冻结普通对象；TypedArray/Buffer 原样返回。 */
function deepFreeze(value) {
  if (
    value === null
    || typeof value !== 'object'
    || ArrayBuffer.isView(value)
    || Object.isFrozen(value)
  ) {
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

/**
 * 要求 plain exact object：仅允许 expectedKeys，且为可枚举数据属性。
 * 失败时调用 throwFn（默认 invalid）。
 */
function readExactObject(value, expectedKeys, throwFn = invalid) {
  if (value === null || typeof value !== 'object') throwFn();
  if (Object.getPrototypeOf(value) !== Object.prototype) throwFn();

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== 'string')) {
    throwFn();
  }

  const expected = new Set(expectedKeys);
  const fields = Object.create(null);
  for (const key of ownKeys) {
    if (!expected.has(key)) throwFn();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throwFn();
    }
    fields[key] = descriptor.value;
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(fields, key)) throwFn();
  }
  return fields;
}

function requireString(value, throwFn = invalid) {
  if (typeof value !== 'string' || value.length === 0) throwFn();
  return value;
}

function requireLiteral(value, expected, throwFn = invalid) {
  if (value !== expected) throwFn();
  return value;
}

function requireBoolean(value, throwFn = invalid) {
  if (typeof value !== 'boolean') throwFn();
  return value;
}

function requireSafeInteger(value, minimum, throwFn = invalid) {
  if (!Number.isSafeInteger(value) || value < minimum) throwFn();
  return value;
}

function requireUuid(value, throwFn = invalid) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throwFn();
  return value;
}

function requireSha256(value, throwFn = invalid) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throwFn();
  return value;
}

function requireFunction(value, throwFn = invalid) {
  if (typeof value !== 'function') throwFn();
  return value;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stdoutToString(stdout) {
  if (typeof stdout === 'string') return stdout;
  if (Buffer.isBuffer(stdout)) return stdout.toString('utf8');
  return null;
}

// ---------------------------------------------------------------------------
// DirectoryService 解析
// ---------------------------------------------------------------------------

/**
 * 由绝对 home 派生仅内存中的 account fact 路径。
 * 不读取 HOME / osHomedir。
 */
function buildAccountFact(uid, home) {
  return deepFreeze({
    uid,
    roots: {
      launchAgents: {
        rootId: ROOT_LAUNCH_AGENTS,
        canonicalPath: `${home}/Library/LaunchAgents`,
      },
      metadata: {
        rootId: ROOT_METADATA,
        canonicalPath: `${home}/Library/Application Support/Linke/launchagent-lifecycle`,
      },
    },
  });
}

/**
 * 严格解析 dscl -read 风格 stdout：UniqueID 与 NFSHomeDirectory 各恰好一次。
 * 除空行外，任何未知非空行均 fail-closed（不静默忽略、不回显行内容）。
 */
function parseDsclReadStdout(stdout, expectedUid) {
  if (typeof stdout !== 'string') accountUnavailable();

  let uidValue = null;
  let homeValue = null;
  let uidCount = 0;
  let homeCount = 0;

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const uidMatch = line.match(/^UniqueID:\s*(\d+)\s*$/);
    if (uidMatch) {
      uidCount += 1;
      uidValue = Number(uidMatch[1]);
      continue;
    }
    const homeMatch = line.match(/^NFSHomeDirectory:\s*(.+?)\s*$/);
    if (homeMatch) {
      homeCount += 1;
      homeValue = homeMatch[1];
      continue;
    }
    // 未知非空行：不得静默忽略
    accountUnavailable();
  }

  if (uidCount !== 1 || homeCount !== 1) accountUnavailable();
  if (!Number.isSafeInteger(uidValue) || uidValue !== expectedUid) accountUnavailable();
  if (typeof homeValue !== 'string' || homeValue.length === 0) accountUnavailable();
  if (!isAbsolute(homeValue) || homeValue.includes('\0')) accountUnavailable();

  return { uid: uidValue, home: homeValue };
}

/**
 * 纯函数：darwin 下严格解析 DirectoryService 账号事实。
 * HOME / osHomedir 为必填敌意字段，永不用于路径派生。
 *
 * @param {object} input exact `{ platform, stdout, expectedUid, HOME, osHomedir }`
 * @returns {Readonly<object>} 冻结 account fact
 */
export function parseDirectoryServiceAccount(input) {
  try {
    const fields = readExactObject(
      input,
      ['platform', 'stdout', 'expectedUid', 'HOME', 'osHomedir'],
      accountUnavailable,
    );
    requireLiteral(fields.platform, 'darwin', accountUnavailable);
    requireSafeInteger(fields.expectedUid, 0, accountUnavailable);
    // 敌意字段必须存在；读取后丢弃，绝不参与路径派生。
    void fields.HOME;
    void fields.osHomedir;

    const stdout = fields.stdout;
    if (typeof stdout !== 'string') accountUnavailable();
    const { uid, home } = parseDsclReadStdout(stdout, fields.expectedUid);
    return buildAccountFact(uid, home);
  } catch (error) {
    normalizeTo(error, accountUnavailable);
  }
}

/**
 * 从 dscl -search 输出严格抽取单一 record 名。
 */
function parseDsclSearchRecordName(stdout, expectedUid) {
  if (typeof stdout !== 'string') accountUnavailable();

  const records = [];
  const pattern = /^(\S+)[ \t]+UniqueID[ \t]*=[ \t]*\([\s\t\n]*(\d+)[\s\t\n]*\)/gm;
  for (const match of stdout.matchAll(pattern)) {
    records.push({
      name: match[1],
      uid: Number(match[2]),
    });
  }
  if (records.length !== 1) accountUnavailable();
  const record = records[0];
  if (!Number.isSafeInteger(record.uid) || record.uid !== expectedUid) accountUnavailable();
  if (!/^[A-Za-z0-9_.-]+$/.test(record.name)) accountUnavailable();
  return record.name;
}

/** 固定 dscl 调用选项。 */
function dsclExecOptions() {
  return {
    timeout: DSCL_TIMEOUT_MS,
    maxBuffer: DSCL_MAX_BUFFER_BYTES,
    shell: false,
    encoding: 'utf8',
  };
}

/**
 * 将 callback 风格 execFile 包装为 Promise；import/构造无副作用。
 */
function createPromiseExecFile(execFileImpl) {
  return function promiseExecFile(file, args, options) {
    return new Promise((resolve, reject) => {
      execFileImpl(file, args, options, (error, stdout, stderr) => {
        if (error) {
          if (stdout !== undefined) error.stdout = stdout;
          if (stderr !== undefined) error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  };
}

const productionExecFile = createPromiseExecFile(execFileCallback);

/**
 * 内部账号解析实现（production 与 ForTest 共用）。
 */
function createAccountResolverInternal({ platform, getUid, execFile }) {
  return {
    async resolve() {
      try {
        if (platform !== 'darwin') accountUnavailable();
        const uid = getUid();
        if (!Number.isSafeInteger(uid) || uid < 0) accountUnavailable();

        const searchArgs = ['.', '-search', '/Users', 'UniqueID', String(uid)];
        const searchResult = await execFile(DSCL_EXECUTABLE, searchArgs, dsclExecOptions());
        const searchStdout = stdoutToString(searchResult?.stdout);
        if (searchStdout === null) accountUnavailable();
        const recordName = parseDsclSearchRecordName(searchStdout, uid);

        const readArgs = ['.', '-read', `/Users/${recordName}`, 'UniqueID', 'NFSHomeDirectory'];
        const readResult = await execFile(DSCL_EXECUTABLE, readArgs, dsclExecOptions());
        const readStdout = stdoutToString(readResult?.stdout);
        if (readStdout === null) accountUnavailable();

        return parseDirectoryServiceAccount({
          platform: 'darwin',
          stdout: readStdout,
          expectedUid: uid,
          HOME: '',
          osHomedir: '',
        });
      } catch (error) {
        normalizeTo(error, accountUnavailable);
      }
    },
  };
}

/**
 * production 零参数账号解析 factory；使用本机 platform/uid 与固定 dscl。
 */
export function createDarwinAccountResolver() {
  return createAccountResolverInternal({
    platform: process.platform,
    getUid: () => {
      if (typeof process.getuid !== 'function') accountUnavailable();
      return process.getuid();
    },
    execFile: productionExecFile,
  });
}

/**
 * 测试专用账号解析 factory：仅注入 platform / getUid / execFile。
 *
 * @param {object} options exact 注入面
 */
export function createDarwinAccountResolverForTest(options) {
  const fields = readExactObject(options, ['platform', 'getUid', 'execFile']);
  requireString(fields.platform);
  requireFunction(fields.getUid);
  requireFunction(fields.execFile);
  return createAccountResolverInternal({
    platform: fields.platform,
    getUid: fields.getUid,
    execFile: fields.execFile,
  });
}

// ---------------------------------------------------------------------------
// Host inspector（只读）
// ---------------------------------------------------------------------------

/** 校验 inspect 地址：固定 rootId/basename 组合，禁止嵌套/绝对/前缀碰撞。 */
function readInspectAddress(address) {
  const fields = readExactObject(address, ['rootId', 'basename']);
  const rootId = requireString(fields.rootId);
  const basename = requireString(fields.basename);
  const allowed = ADDRESS_ALLOWLIST[rootId];
  if (!allowed || !allowed.has(basename)) invalid();
  if (basename.includes('/') || basename.includes('\\') || basename.includes('\0')) invalid();
  if (basename !== pathBasename(basename)) invalid();
  return { rootId, basename };
}

/** 从 account fact 取根路径。 */
function rootPathFromAccount(account, rootId) {
  if (!account || typeof account !== 'object') invalid();
  const roots = account.roots;
  if (!roots || typeof roots !== 'object') invalid();
  if (rootId === ROOT_LAUNCH_AGENTS) {
    const node = roots.launchAgents;
    if (!node || typeof node !== 'object') invalid();
    if (node.rootId !== ROOT_LAUNCH_AGENTS) invalid();
    if (typeof node.canonicalPath !== 'string' || !isAbsolute(node.canonicalPath)) invalid();
    return node.canonicalPath;
  }
  if (rootId === ROOT_METADATA) {
    const node = roots.metadata;
    if (!node || typeof node !== 'object') invalid();
    if (node.rootId !== ROOT_METADATA) invalid();
    if (typeof node.canonicalPath !== 'string' || !isAbsolute(node.canonicalPath)) invalid();
    return node.canonicalPath;
  }
  invalid();
}

/**
 * 校验根目录：必须可 realpath、为目录、属主为 account uid，且非符号链接。
 * 返回冻结的根身份（realpath + device/inode/uid），供前后精确比较。
 * 不要求 accountPath 字面等于 realpath（允许 macOS /var ↔ /private/var 等 alias）。
 */
async function assertRootCanonical(fs, accountPath, accountUid) {
  let real;
  try {
    real = await fs.realpath(accountPath);
  } catch {
    invalid();
  }
  if (typeof real !== 'string' || real.length === 0 || !isAbsolute(real)) invalid();

  let st;
  try {
    st = await fs.lstat(accountPath);
  } catch {
    invalid();
  }
  if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()) invalid();
  if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) invalid();
  if (!Number.isSafeInteger(st.uid) || st.uid !== accountUid) invalid();
  // device/inode 以字符串冻结；同路径被另一 inode 替换时 realpath 文本可能不变
  if (st.dev === undefined || st.dev === null || st.ino === undefined || st.ino === null) {
    invalid();
  }
  return {
    real,
    device: String(st.dev),
    inode: String(st.ino),
    uid: st.uid,
  };
}

/** 根身份前后精确一致（realpath + device/inode/uid）。 */
function rootIdentityMatches(before, after) {
  return (
    before !== null
    && after !== null
    && typeof before === 'object'
    && typeof after === 'object'
    && before.real === after.real
    && before.device === after.device
    && before.inode === after.inode
    && before.uid === after.uid
  );
}

/** 读取文件字节并计算 sha256。 */
async function hashFile(fs, filePath) {
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    invalid();
  }
  if (!Buffer.isBuffer(bytes)) {
    bytes = Buffer.from(bytes);
  }
  return { bytes, sha256: sha256Hex(bytes) };
}

/**
 * 在已校验根上对叶路径做 present/absent 观察。
 */
async function inspectAtRoot(fs, account, rootId, basename) {
  const accountUid = account.uid;
  if (!Number.isSafeInteger(accountUid)) invalid();
  const accountPath = rootPathFromAccount(account, rootId);
  const rootBefore = await assertRootCanonical(fs, accountPath, accountUid);

  const leafPath = pathJoin(accountPath, basename);
  if (pathBasename(leafPath) !== basename) invalid();
  if (pathDirname(leafPath) !== accountPath) invalid();

  let st;
  try {
    st = await fs.lstat(leafPath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      // absent：仍复核根身份（realpath + device/inode）未漂移/被替换
      const rootAfter = await assertRootCanonical(fs, accountPath, accountUid);
      if (!rootIdentityMatches(rootBefore, rootAfter)) invalid();
      return deepFreeze({
        rootId,
        basename,
        type: 'regular-file',
        ownerUid: accountUid,
      });
    }
    invalid();
  }

  if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) invalid();
  if (typeof st.isFile !== 'function' || !st.isFile()) invalid();
  if ((st.mode & 0o777) !== FILE_MODE_EXACT) invalid();
  if (!Number.isSafeInteger(st.uid) || st.uid !== accountUid) invalid();

  const { sha256 } = await hashFile(fs, leafPath);

  // 读后复核 identity（防 TOCTOU 漂移）。
  let stAfter;
  try {
    stAfter = await fs.lstat(leafPath);
  } catch {
    invalid();
  }
  if (typeof stAfter.isSymbolicLink === 'function' && stAfter.isSymbolicLink()) invalid();
  if (typeof stAfter.isFile !== 'function' || !stAfter.isFile()) invalid();
  if ((stAfter.mode & 0o777) !== FILE_MODE_EXACT) invalid();
  if (stAfter.uid !== accountUid) invalid();
  if (String(stAfter.dev) !== String(st.dev) || String(stAfter.ino) !== String(st.ino)) invalid();

  const { sha256: shaAfter } = await hashFile(fs, leafPath);
  if (shaAfter !== sha256) invalid();

  // 根再确认一次（含 device/inode）
  const rootAfter = await assertRootCanonical(fs, accountPath, accountUid);
  if (!rootIdentityMatches(rootBefore, rootAfter)) invalid();

  return deepFreeze({
    rootId,
    basename,
    type: 'regular-file',
    ownerUid: accountUid,
    device: String(st.dev),
    inode: String(st.ino),
    sha256,
  });
}

function createInspectorInternal({ accountResolver, fs }) {
  return {
    async inspect(address) {
      try {
        const { rootId, basename } = readInspectAddress(address);
        const account = await accountResolver.resolve();
        return await inspectAtRoot(fs, account, rootId, basename);
      } catch (error) {
        normalizeTo(error, invalid);
      }
    },

    async read(identity) {
      try {
        const fields = readExactObject(identity, [
          'rootId',
          'basename',
          'type',
          'ownerUid',
          'device',
          'inode',
          'sha256',
        ]);
        requireLiteral(fields.type, 'regular-file');
        requireSafeInteger(fields.ownerUid, 0);
        requireString(fields.device);
        requireString(fields.inode);
        requireSha256(fields.sha256);
        const rootId = requireString(fields.rootId);
        const basename = requireString(fields.basename);
        const allowed = ADDRESS_ALLOWLIST[rootId];
        if (!allowed || !allowed.has(basename)) invalid();

        const account = await accountResolver.resolve();
        if (!Number.isSafeInteger(account.uid) || account.uid !== fields.ownerUid) invalid();

        const accountPath = rootPathFromAccount(account, rootId);
        const rootBefore = await assertRootCanonical(fs, accountPath, account.uid);

        const leafPath = pathJoin(accountPath, basename);
        if (pathBasename(leafPath) !== basename) invalid();
        if (pathDirname(leafPath) !== accountPath) invalid();

        let st;
        try {
          st = await fs.lstat(leafPath);
        } catch {
          invalid();
        }
        if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) invalid();
        if (typeof st.isFile !== 'function' || !st.isFile()) invalid();
        if ((st.mode & 0o777) !== FILE_MODE_EXACT) invalid();
        if (st.uid !== fields.ownerUid) invalid();
        if (String(st.dev) !== fields.device || String(st.ino) !== fields.inode) invalid();

        const { bytes, sha256 } = await hashFile(fs, leafPath);
        if (sha256 !== fields.sha256) invalid();

        // 读后复核
        let stAfter;
        try {
          stAfter = await fs.lstat(leafPath);
        } catch {
          invalid();
        }
        if (typeof stAfter.isSymbolicLink === 'function' && stAfter.isSymbolicLink()) invalid();
        if (typeof stAfter.isFile !== 'function' || !stAfter.isFile()) invalid();
        if ((stAfter.mode & 0o777) !== FILE_MODE_EXACT) invalid();
        if (stAfter.uid !== fields.ownerUid) invalid();
        if (String(stAfter.dev) !== fields.device || String(stAfter.ino) !== fields.inode) invalid();
        const after = await hashFile(fs, leafPath);
        if (after.sha256 !== fields.sha256) invalid();

        const rootAfter = await assertRootCanonical(fs, accountPath, account.uid);
        if (!rootIdentityMatches(rootBefore, rootAfter)) invalid();

        // detached clone
        return Buffer.from(bytes);
      } catch (error) {
        normalizeTo(error, invalid);
      }
    },
  };
}

/**
 * production 零参数 host inspector：内置账号解析与 node:fs/promises。
 */
export function createLaunchAgentHostInspector() {
  return createInspectorInternal({
    accountResolver: createDarwinAccountResolver(),
    fs: nodeFsPromises,
  });
}

/**
 * 测试专用 host inspector：仅注入 accountResolver 与窄 fs。
 *
 * @param {object} options exact `{ accountResolver, fs }`
 */
export function createLaunchAgentHostInspectorForTest(options) {
  const fields = readExactObject(options, ['accountResolver', 'fs']);
  if (fields.accountResolver === null || typeof fields.accountResolver !== 'object') invalid();
  requireFunction(fields.accountResolver.resolve);
  if (fields.fs === null || typeof fields.fs !== 'object') invalid();
  requireFunction(fields.fs.lstat);
  requireFunction(fields.fs.readFile);
  requireFunction(fields.fs.realpath);
  return createInspectorInternal({
    accountResolver: fields.accountResolver,
    fs: fields.fs,
  });
}

// ---------------------------------------------------------------------------
// launchctl 请求校验 / 结果映射 / print 解析（均不执行 launchctl）
// ---------------------------------------------------------------------------

/** 校验 resolvedPath：绝对、叶名匹配、父目录名为 LaunchAgents。 */
function requireResolvedLaunchAgentPath(resolvedPath, basename) {
  requireString(resolvedPath);
  if (!isAbsolute(resolvedPath) || resolvedPath.includes('\0')) invalid();
  if (pathBasename(resolvedPath) !== basename) invalid();
  if (pathBasename(pathDirname(resolvedPath)) !== 'LaunchAgents') invalid();
  return resolvedPath;
}

/**
 * 校验 launchctl 请求形状与固定 argv；不执行任何宿主命令。
 *
 * @returns {Readonly<{ operation, role, timeoutMs, argv }>}
 */
export function validateLaunchctlRequest(input) {
  try {
    const fields = readExactObject(input, [
      'operation',
      'uid',
      'rootId',
      'basename',
      'resolvedPath',
      'argv',
    ]);

    const operation = requireString(fields.operation);
    if (!LAUNCHCTL_OPERATIONS.has(operation)) invalid();
    const uid = requireSafeInteger(fields.uid, 0);
    requireLiteral(fields.rootId, ROOT_LAUNCH_AGENTS);
    const basename = requireString(fields.basename);
    const mapping = LAUNCH_AGENT_BASENAMES[basename];
    if (!mapping) invalid();
    const resolvedPath = requireResolvedLaunchAgentPath(fields.resolvedPath, basename);

    if (!Array.isArray(fields.argv)) invalid();
    const argv = fields.argv.map((item) => {
      if (typeof item !== 'string') invalid();
      return item;
    });

    const domain = `gui/${uid}`;
    const service = `${domain}/${mapping.label}`;
    let expectedArgv;
    let timeoutMs;

    if (operation === 'bootstrap') {
      expectedArgv = ['bootstrap', domain, resolvedPath];
      timeoutMs = BOOTSTRAP_BOOTOUT_TIMEOUT_MS;
    } else if (operation === 'bootout') {
      expectedArgv = ['bootout', service];
      timeoutMs = BOOTSTRAP_BOOTOUT_TIMEOUT_MS;
    } else if (operation === 'kickstart') {
      expectedArgv = ['kickstart', '-k', service];
      timeoutMs = KICKSTART_PRINT_TIMEOUT_MS;
    } else if (operation === 'print') {
      expectedArgv = ['print', service];
      timeoutMs = KICKSTART_PRINT_TIMEOUT_MS;
    } else {
      invalid();
    }

    if (argv.length !== expectedArgv.length) invalid();
    for (let i = 0; i < expectedArgv.length; i += 1) {
      if (argv[i] !== expectedArgv[i]) invalid();
    }

    return deepFreeze({
      operation,
      role: mapping.role,
      timeoutMs,
      argv: [...argv],
    });
  } catch (error) {
    normalizeTo(error, invalid);
  }
}

/**
 * print 成功时最窄合成格式 sanity check（非完整 identity parser）。
 * 仅接受以 `gui/<uid>/<label> = {` 开头，或明确 unloaded 文案。
 */
function isPlausiblePrintStdout(stdout) {
  if (typeof stdout !== 'string') return false;
  if (/^gui\/\d+\/\S+ = \{/.test(stdout)) return true;
  const trimmed = stdout.trim();
  if (/^Could not find service "[^"]+" in domain for gui\/\d+$/.test(trimmed)) return true;
  return false;
}

/**
 * 将 launchctl 执行观察投影为闭合 outcome；丢弃 raw。
 * 优先级：timeout → permission-denied → nonzero-exit →
 * print+exit0 合成格式 sanity → ok / unknown-result。
 *
 * @returns {Readonly<{ outcome: string }>}
 */
export function mapLaunchctlResult(input) {
  try {
    const fields = readExactObject(input, [
      'operation',
      'timedOut',
      'permissionDenied',
      'exitCode',
      'stdout',
      'stderr',
    ]);
    const operation = requireString(fields.operation);
    if (!LAUNCHCTL_OPERATIONS.has(operation)) invalid();
    const timedOut = requireBoolean(fields.timedOut);
    const permissionDenied = requireBoolean(fields.permissionDenied);
    if (typeof fields.stdout !== 'string') invalid();
    if (typeof fields.stderr !== 'string') invalid();
    const stdout = fields.stdout;
    // stderr 立即丢弃，永不回显
    void fields.stderr;

    const exitCode = fields.exitCode;
    if (!(exitCode === null || Number.isSafeInteger(exitCode))) invalid();

    let outcome;
    if (timedOut) {
      outcome = 'timeout';
    } else if (permissionDenied) {
      outcome = 'permission-denied';
    } else if (typeof exitCode === 'number' && exitCode !== 0) {
      outcome = 'nonzero-exit';
    } else if (exitCode === 0) {
      if (operation === 'print' && !isPlausiblePrintStdout(stdout)) {
        outcome = 'malformed-output';
      } else {
        outcome = 'ok';
      }
    } else {
      // exitCode === null 且无 timeout/permission
      outcome = 'unknown-result';
    }
    // 确保 stdout 不进入结果
    void stdout;
    if (!MAP_OUTCOMES.has(outcome)) invalid();
    return deepFreeze({ outcome });
  } catch (error) {
    normalizeTo(error, invalid);
  }
}

/**
 * expected label → 固定 plist filename（纯词汇绑定，不访问 FS）。
 */
function expectedFilenameForLabel(label) {
  if (label === LABEL_CONTROLLER) return FILENAME_CONTROLLER;
  if (label === LABEL_SCHEDULER) return FILENAME_SCHEDULER;
  invalid();
}

/**
 * 解析合成 launchctl print 文本；返回 loaded/unloaded 闭合形状。
 * 哈希输入：path.normalize(plistPath) + NUL + JSON.stringify(逐 absolute arg normalize)。
 * 纯函数：仅词法 normalize，不访问 FS。
 */
export function parseLaunchctlPrint(input) {
  try {
    const fields = readExactObject(input, ['stdout', 'expected']);
    if (typeof fields.stdout !== 'string') invalid();
    const expected = readExactObject(fields.expected, ['uid', 'label']);
    const uid = requireSafeInteger(expected.uid, 0);
    const label = requireString(expected.label);
    if (label !== LABEL_CONTROLLER && label !== LABEL_SCHEDULER) invalid();
    const expectedFilename = expectedFilenameForLabel(label);

    const stdout = fields.stdout;

    // 明确未加载：整段 trim 后与期望 label/uid 精确匹配
    const unloadedMessage = `Could not find service "${label}" in domain for gui/${uid}`;
    if (stdout.trim() === unloadedMessage) {
      return deepFreeze({
        loaded: false,
        pid: null,
        state: 'unloaded',
        jobIdentitySha256: null,
      });
    }

    // 恰好一个匹配 expected 的 job header；禁止其它 gui 头
    const header = `gui/${uid}/${label} = {`;
    const headerEscaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headerMatches = stdout.match(new RegExp(headerEscaped, 'g'));
    if (!headerMatches || headerMatches.length !== 1) invalid();
    const anyGuiHeaders = stdout.match(/^gui\/\d+\/\S+ = \{/gm) || [];
    if (anyGuiHeaders.length !== 1) invalid();

    const pathMatches = [...stdout.matchAll(/^\tpath = (.+)$/gm)];
    if (pathMatches.length !== 1) invalid();
    const plistPath = pathMatches[0][1];
    if (typeof plistPath !== 'string' || !isAbsolute(plistPath)) invalid();

    // 词法 normalize；parent 必须为 LaunchAgents，leaf 必须绑定 expected label 的固定文件名
    const normalizedPlistPath = pathNormalize(plistPath);
    if (!isAbsolute(normalizedPlistPath) || normalizedPlistPath.includes('\0')) invalid();
    if (pathBasename(pathDirname(normalizedPlistPath)) !== 'LaunchAgents') invalid();
    if (pathBasename(normalizedPlistPath) !== expectedFilename) invalid();

    const stateMatches = [...stdout.matchAll(/^\tstate = (\S+)$/gm)];
    if (stateMatches.length !== 1) invalid();
    const state = stateMatches[0][1];
    if (!PRINT_STATES.has(state)) invalid();

    const pidMatches = [...stdout.matchAll(/^\tpid = (\d+)$/gm)];
    if (pidMatches.length !== 1) invalid();
    const pid = Number(pidMatches[0][1]);
    if (!Number.isSafeInteger(pid) || pid < 0) invalid();

    const argsBlockMatch = stdout.match(/^\targuments = \{\n([\s\S]*?)\n\t\}/m);
    if (!argsBlockMatch) invalid();
    const argLines = argsBlockMatch[1].split('\n').filter((line) => line.length > 0);
    const programArguments = [];
    for (let i = 0; i < argLines.length; i += 1) {
      const lineMatch = argLines[i].match(/^\t\t(\d+) = (.*)$/);
      if (!lineMatch) invalid();
      if (Number(lineMatch[1]) !== i) invalid();
      programArguments.push(lineMatch[2]);
    }
    if (programArguments.length === 0) invalid();

    // 绝对 path 词法 normalize；非绝对 flag 保持原样
    const normalizedArgs = programArguments.map((arg) =>
      (typeof arg === 'string' && isAbsolute(arg) ? pathNormalize(arg) : arg),
    );

    const jobIdentitySha256 = sha256Hex(
      Buffer.from(`${normalizedPlistPath}\0${JSON.stringify(normalizedArgs)}`, 'utf8'),
    );

    return deepFreeze({
      loaded: true,
      pid,
      state,
      jobIdentitySha256,
    });
  } catch (error) {
    normalizeTo(error, invalid);
  }
}

// ---------------------------------------------------------------------------
// Disabled launchctl runner / unsupported publisher
// ---------------------------------------------------------------------------

/**
 * 硬禁用的 launchctl runner：永远返回 launchctl-disabled，零 I/O。
 * 边界常量 LAUNCHCTL_EXECUTABLE 不可调用。
 */
export function createDisabledLaunchctlRunner() {
  void LAUNCHCTL_EXECUTABLE;
  void LAUNCHCTL_CALLABLE;
  return {
    async run() {
      return deepFreeze({ outcome: CODE_LAUNCHCTL_DISABLED });
    },
  };
}

/**
 * production atomic publisher：三方法均固定 conditional-mutation-unsupported，零 I/O。
 */
export function createUnsupportedProductionAtomicPublisher() {
  const unsupported = async () => deepFreeze({ outcome: CODE_MUTATION_UNSUPPORTED });
  return {
    publishAbsent: unsupported,
    replaceIfMatch: unsupported,
    removeIfMatch: unsupported,
  };
}

// ---------------------------------------------------------------------------
// plutil 校验
// ---------------------------------------------------------------------------

/** 固定 plutil 调用选项。 */
function plutilExecOptions() {
  return {
    timeout: PLUTIL_TIMEOUT_MS,
    maxBuffer: PLUTIL_MAX_BUFFER_BYTES,
    shell: false,
    encoding: 'utf8',
  };
}

/** 校验 opaque candidate ref。 */
function readCandidateRef(ref) {
  const fields = readExactObject(ref, ['kind', 'transactionId', 'role', 'sha256']);
  requireLiteral(fields.kind, 'launchagent-candidate');
  requireUuid(fields.transactionId);
  const role = requireString(fields.role);
  if (!CANDIDATE_ROLES.has(role)) invalid();
  requireSha256(fields.sha256);
  return {
    kind: fields.kind,
    transactionId: fields.transactionId,
    role,
    sha256: fields.sha256,
  };
}

function createPlistValidatorInternal({ resolveCandidate, execFile }) {
  return {
    async validate(candidateRef) {
      try {
        const ref = readCandidateRef(candidateRef);
        let resolvedPath;
        try {
          resolvedPath = resolveCandidate(ref);
        } catch (error) {
          normalizeTo(error, invalid);
        }
        if (typeof resolvedPath !== 'string' || resolvedPath.length === 0 || !isAbsolute(resolvedPath)) {
          invalid();
        }

        try {
          await execFile(PLUTIL_EXECUTABLE, ['-lint', resolvedPath], plutilExecOptions());
          return deepFreeze({ valid: true, outcome: 'valid' });
        } catch {
          // 执行失败：净化为 invalid result，不抛、不回显 raw
          return deepFreeze({ valid: false, outcome: 'invalid' });
        }
      } catch (error) {
        normalizeTo(error, invalid);
      }
    },
  };
}

/**
 * production 零依赖 plutil 校验器。
 * candidate 路径解析留给组合层；本 factory 无 caller 注入。
 */
export function createPlistValidator() {
  return createPlistValidatorInternal({
    resolveCandidate() {
      invalid();
    },
    execFile: productionExecFile,
  });
}

/**
 * 测试专用 plutil 校验器：注入 resolveCandidate 与 execFile。
 *
 * @param {object} options exact `{ resolveCandidate, execFile }`
 */
export function createPlistValidatorForTest(options) {
  const fields = readExactObject(options, ['resolveCandidate', 'execFile']);
  requireFunction(fields.resolveCandidate);
  requireFunction(fields.execFile);
  return createPlistValidatorInternal({
    resolveCandidate: fields.resolveCandidate,
    execFile: fields.execFile,
  });
}

// ---------------------------------------------------------------------------
// Loopback health
// ---------------------------------------------------------------------------

const HEALTH_FAILURE = () => deepFreeze({
  statusCode: null,
  ready: false,
  count: null,
});

/**
 * production 局部 HTTP GET；仅在 check 调用时联网，import/构造零副作用。
 * - 30000ms 为真正 absolute wall-clock timer（另可有 socket inactivity timeout）
 * - body 累计超过 HEALTH_MAX_BODY_BYTES 立即 destroy/拒绝，不缓冲超限内容
 * - 错误消息固定，不回显 raw
 */
function productionHttpRequest(url, options) {
  return new Promise((resolve, reject) => {
    const absoluteCeilingMs =
      typeof options?.timeout === 'number' && Number.isFinite(options.timeout)
        ? options.timeout
        : HEALTH_ABSOLUTE_CEILING_MS;

    let settled = false;
    let totalBytes = 0;
    const chunks = [];
    /** @type {import('node:http').ClientRequest | null} */
    let req = null;

    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      try {
        if (req) req.destroy();
      } catch {
        // ignore
      }
      // 固定消息，永不携带 raw body/error
      reject(new Error('health-request-failed'));
    };

    const absoluteTimer = setTimeout(() => {
      fail();
    }, absoluteCeilingMs);
    // 不阻止进程退出
    if (typeof absoluteTimer.unref === 'function') absoluteTimer.unref();

    try {
      req = http.get(url, { timeout: absoluteCeilingMs }, (res) => {
        res.on('data', (chunk) => {
          if (settled) return;
          const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += piece.byteLength;
          if (totalBytes > HEALTH_MAX_BODY_BYTES) {
            try {
              res.destroy();
            } catch {
              // ignore
            }
            fail();
            return;
          }
          chunks.push(piece);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(absoluteTimer);
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', () => {
          fail();
        });
      });
    } catch {
      fail();
      return;
    }

    req.on('error', () => {
      fail();
    });
    req.on('timeout', () => {
      fail();
    });
  });
}

function createHealthCheckerInternal({ request, now }) {
  return {
    async check(input) {
      try {
        const fields = readExactObject(input, ['port']);
        const port = requireSafeInteger(fields.port, 1);
        if (port > 65535) invalid();

        const url = `http://127.0.0.1:${port}/health`;
        const start = now();
        if (!Number.isFinite(start)) invalid();

        let response;
        try {
          response = await request(url, { timeout: HEALTH_ABSOLUTE_CEILING_MS });
        } catch {
          const endOnError = now();
          void endOnError;
          return HEALTH_FAILURE();
        }

        const end = now();
        // absolute ceiling 与 clock 倒退均 fail closed（end-start < 0 不得当作未超时）
        if (
          !Number.isFinite(end)
          || end - start > HEALTH_ABSOLUTE_CEILING_MS
          || end - start < 0
        ) {
          return HEALTH_FAILURE();
        }

        if (!response || typeof response !== 'object') {
          return HEALTH_FAILURE();
        }

        const statusCode = response.statusCode;
        if (!Number.isSafeInteger(statusCode)) {
          return HEALTH_FAILURE();
        }

        if (statusCode !== 200) {
          return deepFreeze({
            statusCode,
            ready: false,
            count: null,
          });
        }

        let body = response.body;
        if (typeof body === 'string') body = Buffer.from(body, 'utf8');
        if (!Buffer.isBuffer(body)) {
          return HEALTH_FAILURE();
        }

        // 固定 64KiB body cap：按 Buffer byte length 在 JSON.parse 前 fail closed
        if (body.byteLength > HEALTH_MAX_BODY_BYTES) {
          return HEALTH_FAILURE();
        }

        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return HEALTH_FAILURE();
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return HEALTH_FAILURE();
        }
        if (typeof parsed.ready !== 'boolean') {
          return HEALTH_FAILURE();
        }
        if (!Number.isSafeInteger(parsed.count) || parsed.count < 0) {
          return HEALTH_FAILURE();
        }

        return deepFreeze({
          statusCode: 200,
          ready: parsed.ready,
          count: parsed.count,
        });
      } catch (error) {
        normalizeTo(error, invalid);
      }
    },
  };
}

/**
 * production 零参数 loopback health checker。
 */
export function createLoopbackHealthChecker() {
  return createHealthCheckerInternal({
    request: productionHttpRequest,
    now: () => Date.now(),
  });
}

/**
 * 测试专用 health checker：注入 request 与 now。
 *
 * @param {object} options exact `{ request, now }`
 */
export function createLoopbackHealthCheckerForTest(options) {
  const fields = readExactObject(options, ['request', 'now']);
  requireFunction(fields.request);
  requireFunction(fields.now);
  return createHealthCheckerInternal({
    request: fields.request,
    now: fields.now,
  });
}
