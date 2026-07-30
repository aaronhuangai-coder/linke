/**
 * Linke V1.46 Task 3 RED — host-adapter 安全接口与行为冻结测试。
 *
 * 目标模块当前故意不存在：先做显式存在性断言，仅在存在时动态 import。
 * 当前唯一允许的 RED 失败是 missing-feature 存在性测试；禁止静态 import host-adapter、
 * 禁止依赖 ERR_MODULE_NOT_FOUND、禁止语法/fixture 错误掩盖缺失实现。
 *
 * 边界（与实现共享）：
 * - 仅 current-user LaunchAgent；无 sudo / LaunchDaemon / 真实 launchctl / 真实 home / 部署。
 * - 文件路径只落在测试 temp root；DS / execFile / HTTP 一律 test-only 注入 spy。
 * - path / home / username / argv / stdout / stderr / body / fixture raw / canary
 *   不得进入对外 projection、日志 sink 或异常消息。
 * - production factory 零依赖注入；test-only factory 以 ForTest 后缀命名，仅本模块直接 import。
 * - 无 generic write/rename/unlink/open-for-write；无真实 /bin/launchctl runner。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHAGENT_LIFECYCLE,
  LAUNCHAGENT_LIFECYCLE_CODES,
  LaunchAgentLifecycleError,
} from '../src/launchagent-lifecycle/contracts.js';

const hostAdapterUrl = new URL(
  '../src/launchagent-lifecycle/host-adapter.js',
  import.meta.url,
);
const hostAdapterPath = fileURLToPath(hostAdapterUrl);
const hostAdapterExists = existsSync(hostAdapterPath);

// ---------------------------------------------------------------------------
// 固定词汇（与 contracts 对齐，测试侧再冻结一次以免漂移）
// ---------------------------------------------------------------------------

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

const FIXED_UID = 501;
/** 合成 DirectoryService home；绝不读取真实 home / 环境变量值。 */
const FIXTURE_HOME = '/Users/linke-fixture-home';
const HOSTILE_HOME = '/hostile/HOME/canary-home-LEAK';
const HOSTILE_OS_HOMEDIR = '/hostile/osHomedir/canary-os-LEAK';
const CANARY_PATH = '/tmp/linke-canary-path-SHOULD-NOT-LEAK';
const CANARY_STDOUT = 'CANARY_STDOUT_should_never_surface';
const CANARY_STDERR = 'CANARY_STDERR_should_never_surface';
const CANARY_ARGV = '--canary-argv-leak';
const CANARY_BODY = 'CANARY_HTTP_BODY_should_never_surface';
const CANARY_USERNAME = 'canary-username-LEAK';

/** DirectoryService / plutil 固定超时与输出上限（毫秒 / 字节）。 */
const DSCL_TIMEOUT_MS = 5_000;
const DSCL_MAX_BUFFER_BYTES = 64 * 1024;
const PLUTIL_TIMEOUT_MS = 5_000;
const PLUTIL_MAX_BUFFER_BYTES = 64 * 1024;
const HEALTH_ABSOLUTE_CEILING_MS = 30_000;

const BOOTSTRAP_BOOTOUT_TIMEOUT_MS = 10_000;
const KICKSTART_PRINT_TIMEOUT_MS = 5_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TX_ID = '018f0f95-3d3a-7f01-8c6a-2a6f98765432';
const CANDIDATE_SHA256 = 'a'.repeat(64);

/**
 * account fact 路径派生冻结：绝对路径只来自 dscl NFSHomeDirectory，
 * 忽略 HOME / osHomedir。metadata 落在 Application Support 下的固定后缀。
 */
function expectedLaunchAgentsPath(home) {
  return `${home}/Library/LaunchAgents`;
}
function expectedMetadataPath(home) {
  return `${home}/Library/Application Support/Linke/launchagent-lifecycle`;
}
function expectedAccountFact(uid, home) {
  return {
    uid,
    roots: {
      launchAgents: {
        rootId: ROOT_LAUNCH_AGENTS,
        canonicalPath: expectedLaunchAgentsPath(home),
      },
      metadata: {
        rootId: ROOT_METADATA,
        canonicalPath: expectedMetadataPath(home),
      },
    },
  };
}

function validDsclStdout(uid = FIXED_UID, home = FIXTURE_HOME) {
  return `UniqueID: ${uid}\nNFSHomeDirectory: ${home}\n`;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertDeepFrozen(value, location = 'value') {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${location} must be frozen`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      assertDeepFrozen(descriptor.value, `${location}.${String(key)}`);
    }
  }
}

function assertExactKeys(value, expectedKeys, location = 'value') {
  assert.equal(value === null || typeof value !== 'object', false, `${location} must be object`);
  const keys = Reflect.ownKeys(value)
    .filter((k) => typeof k === 'string')
    .sort();
  assert.deepEqual(keys, [...expectedKeys].sort(), `${location} exact keys`);
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  if (Buffer.isBuffer(value)) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') out.push(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      collectStrings(descriptor.value, out);
    }
  }
  return out;
}

/** 对外结果 / 错误不得携带敏感 canary 或绝对路径泄漏。 */
function assertNoLeakage(value, canaries, label) {
  let text;
  if (value instanceof Error) {
    // stack 是测试运行器诊断位置，不属于对外 projection；Error 泄漏只查 name/code/message 与可枚举 own 字段。
    const ownData = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        continue;
      }
      ownData[key] = descriptor.value;
    }
    text = [
      String(value.name ?? ''),
      String(value.code ?? ''),
      String(value.message ?? ''),
      ...collectStrings(ownData),
    ].join('\n');
  } else {
    text = JSON.stringify(collectStrings(value));
  }
  for (const canary of canaries) {
    assert.equal(
      text.includes(canary),
      false,
      `${label} must not leak ${JSON.stringify(canary)}`,
    );
  }
}

const DEFAULT_CANARIES = Object.freeze([
  CANARY_PATH,
  CANARY_STDOUT,
  CANARY_STDERR,
  CANARY_ARGV,
  CANARY_BODY,
  CANARY_USERNAME,
  HOSTILE_HOME,
  HOSTILE_OS_HOMEDIR,
  FIXTURE_HOME,
  '/Users/',
  '/bin/launchctl',
  'Library/LaunchAgents',
]);

function assertLifecycleError(error, code) {
  assert.ok(error instanceof LaunchAgentLifecycleError, 'must be LaunchAgentLifecycleError');
  assert.equal(error.name, 'LaunchAgentLifecycleError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assertNoLeakage(error, DEFAULT_CANARIES, `error(${code})`);
}

function assertThrowsCode(fn, code) {
  assert.throws(fn, (error) => {
    assertLifecycleError(error, code);
    return true;
  });
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assertLifecycleError(error, code);
    return true;
  });
}

function withOwnData(fixture, key, value) {
  const candidate = { ...fixture };
  Object.defineProperty(candidate, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
  return candidate;
}

function withAccessor(fixture, key, onRead = () => {}) {
  const candidate = { ...fixture };
  Object.defineProperty(candidate, key, {
    configurable: true,
    enumerable: true,
    get() {
      onRead();
      return 'forbidden';
    },
  });
  return candidate;
}

function withSymbol(fixture) {
  const candidate = { ...fixture };
  candidate[Symbol('unexpected')] = true;
  return candidate;
}

function ownEnumerableNames(object) {
  return Reflect.ownKeys(object)
    .filter((key) => typeof key === 'string')
    .filter((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && descriptor.enumerable;
    })
    .sort();
}

function ownEnumerableMethodNames(object) {
  return ownEnumerableNames(object).filter(
    (key) => typeof object[key] === 'function',
  );
}

// ---------------------------------------------------------------------------
// 存在性：当前唯一 RED（模块缺失时）
// ---------------------------------------------------------------------------

test('host-adapter module exists before host-adapter behavior tests', () => {
  assert.equal(
    hostAdapterExists,
    true,
    'expected src/launchagent-lifecycle/host-adapter.js to exist before host-adapter behavior tests',
  );
});

// ---------------------------------------------------------------------------
// 行为测试：仅在模块存在时注册，避免 ERR_MODULE_NOT_FOUND 噪声
// ---------------------------------------------------------------------------

if (hostAdapterExists) {
  const hostAdapter = await import(hostAdapterUrl);

  const {
    parseDirectoryServiceAccount,
    createDarwinAccountResolver,
    createDarwinAccountResolverForTest,
    createLaunchAgentHostInspector,
    createLaunchAgentHostInspectorForTest,
    validateLaunchctlRequest,
    mapLaunchctlResult,
    parseLaunchctlPrint,
    createDisabledLaunchctlRunner,
    createUnsupportedProductionAtomicPublisher,
    createPlistValidator,
    createPlistValidatorForTest,
    createLoopbackHealthChecker,
    createLoopbackHealthCheckerForTest,
  } = hostAdapter;

  // -------------------------------------------------------------------------
  // 共享 helper（行为套件内）
  // -------------------------------------------------------------------------

  function requireExport(name) {
    const value = hostAdapter[name];
    assert.equal(typeof value, 'function', `expected export ${name} to be a function`);
    return value;
  }

  async function withTempRoot(t, run) {
    const root = await mkdtemp(join(tmpdir(), 'linke-host-adapter-'));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    return run(root);
  }

  /**
   * 窄 fs wrapper：委托 node:fs/promises，附带调用计数与可选故障注入。
   * 绝不指向真实用户 home；仅操作测试 temp root。
   */
  function createCountingFs(overrides = {}) {
    const counts = Object.create(null);
    const wrap = (name, impl) => async (...args) => {
      counts[name] = (counts[name] ?? 0) + 1;
      if (typeof overrides[name] === 'function') {
        return overrides[name](...args);
      }
      return impl(...args);
    };
    return {
      counts,
      fs: {
        mkdir: wrap('mkdir', mkdir),
        writeFile: wrap('writeFile', writeFile),
        readFile: wrap('readFile', readFile),
        lstat: wrap('lstat', lstat),
        chmod: wrap('chmod', chmod),
        symlink: wrap('symlink', symlink),
        rm: wrap('rm', rm),
        mkdtemp: wrap('mkdtemp', mkdtemp),
        realpath: wrap('realpath', async (p) => {
          const { realpath } = await import('node:fs/promises');
          return realpath(p);
        }),
        open: wrap('open', async () => {
          throw new Error('test fs open should not be used as generic write handle');
        }),
        rename: wrap('rename', async () => {
          throw new Error('test fs rename must not be invoked by host-adapter');
        }),
        unlink: wrap('unlink', async () => {
          throw new Error('test fs unlink must not be invoked by host-adapter');
        }),
      },
    };
  }

  function fixedAccountResolver(accountFact) {
    let calls = 0;
    let current = accountFact;
    return {
      get calls() {
        return calls;
      },
      setAccount(next) {
        current = next;
      },
      async resolve() {
        calls += 1;
        return current;
      },
    };
  }

  async function seedRegularFile(dir, basename, contents, mode = 0o600) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, basename);
    await writeFile(path, contents, { mode });
    await chmod(path, mode);
    return path;
  }

  // =========================================================================
  // 0) 导出面与 import 无副作用
  // =========================================================================

  test('host-adapter 最小导出面：解析 / 校验 / factory / ForTest 齐备', () => {
    const expected = [
      'parseDirectoryServiceAccount',
      'createDarwinAccountResolver',
      'createDarwinAccountResolverForTest',
      'createLaunchAgentHostInspector',
      'createLaunchAgentHostInspectorForTest',
      'validateLaunchctlRequest',
      'mapLaunchctlResult',
      'parseLaunchctlPrint',
      'createDisabledLaunchctlRunner',
      'createUnsupportedProductionAtomicPublisher',
      'createPlistValidator',
      'createPlistValidatorForTest',
      'createLoopbackHealthChecker',
      'createLoopbackHealthCheckerForTest',
    ];
    for (const name of expected) {
      requireExport(name);
    }
  });

  test('import 无顶层 DirectoryService / fs / HTTP / launchctl 副作用', async () => {
    // 动态 import 已完成；此处用静态源码扫描 + 行为探针证明无顶层副作用。
    const source = await readFile(hostAdapterPath, 'utf8');

    // 禁止危险原语；允许 import execFile 与函数体内 dscl/plutil 的 execFile 风格。
    const forbidden = [
      { re: /\bexec\s*\(/, label: 'exec(' },
      { re: /\bspawn\s*\(/, label: 'spawn(' },
      { re: /shell\s*:\s*true/, label: 'shell:true' },
      { re: /\beval\s*\(/, label: 'eval(' },
      { re: /\brename\s*\(/, label: 'rename(' },
      { re: /\bunlink\s*\(/, label: 'unlink(' },
    ];
    for (const { re, label } of forbidden) {
      assert.equal(re.test(source), false, `host-adapter source must not contain ${label}`);
    }

    // 主计划：源码必须存在固定 /bin/launchctl executable constant/literal。
    // 零真实调用边界不变：该 literal 不得出现在 execFile/spawn/exec 等可调用位置。
    assert.equal(
      /['"]\/bin\/launchctl['"]/.test(source),
      true,
      'host-adapter source must contain fixed /bin/launchctl literal/constant',
    );
    const subprocessCallee =
      String.raw`(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)`;
    // 直接字符串作为 subprocess 可执行首参
    assert.equal(
      new RegExp(
        String.raw`\b${subprocessCallee}\s*\(\s*['"]\/bin\/launchctl['"]`,
      ).test(source),
      false,
      'host-adapter must not pass /bin/launchctl literal to execFile/spawn/exec',
    );
    // 绑定到标识符后作为 subprocess 首参同样禁止（常量可存在，但不可调用）
    const bindingRe =
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]\/bin\/launchctl['"]/g;
    let binding;
    while ((binding = bindingRe.exec(source)) !== null) {
      const id = binding[1];
      assert.equal(
        new RegExp(String.raw`\b${subprocessCallee}\s*\(\s*${id}\b`).test(source),
        false,
        `host-adapter must not pass bound /bin/launchctl constant ${id} to subprocess`,
      );
    }
    // 继续拒绝可调用真实 runner 导出（与 Task 3 诚实边界用例一致）
    for (const name of [
      'createLaunchctlRunner',
      'createRealLaunchctlRunner',
      'createLaunchctlRunnerForTest',
    ]) {
      assert.equal(
        hostAdapter[name],
        undefined,
        `${name} must not be exported (no real launchctl runner)`,
      );
    }

    // 允许 execFile 出现（dscl / plutil）；但不得在模块求值阶段自动调用。
    // 行为探针：禁用 runner / unsupported publisher 在构造时零 I/O（见后续用例）。
    const disabled = createDisabledLaunchctlRunner();
    const publisher = createUnsupportedProductionAtomicPublisher();
    assert.deepEqual(ownEnumerableMethodNames(disabled), ['run']);
    assert.deepEqual(ownEnumerableMethodNames(publisher).sort(), [
      'publishAbsent',
      'removeIfMatch',
      'replaceIfMatch',
    ].sort());
  });

  // =========================================================================
  // 1) parseDirectoryServiceAccount
  // =========================================================================

  test('parseDirectoryServiceAccount：darwin 严格解析 UniqueID 与 NFSHomeDirectory', () => {
    const input = {
      platform: 'darwin',
      stdout: validDsclStdout(FIXED_UID, FIXTURE_HOME),
      expectedUid: FIXED_UID,
      HOME: HOSTILE_HOME,
      osHomedir: HOSTILE_OS_HOMEDIR,
    };
    const fact = parseDirectoryServiceAccount(input);
    assert.deepEqual(fact, expectedAccountFact(FIXED_UID, FIXTURE_HOME));
    assertDeepFrozen(fact, 'accountFact');
    assertExactKeys(fact, ['uid', 'roots']);
    assertExactKeys(fact.roots, ['launchAgents', 'metadata']);
    assertExactKeys(fact.roots.launchAgents, ['rootId', 'canonicalPath']);
    assertExactKeys(fact.roots.metadata, ['rootId', 'canonicalPath']);
    // 绝对路径只存活于 account fact 内存字段
    assert.equal(fact.roots.launchAgents.canonicalPath.startsWith(FIXTURE_HOME), true);
    assert.equal(fact.roots.launchAgents.canonicalPath.includes(HOSTILE_HOME), false);
    assert.equal(fact.roots.metadata.canonicalPath.includes(HOSTILE_OS_HOMEDIR), false);
  });

  test('parseDirectoryServiceAccount：忽略 hostile HOME/osHomedir，仅信任 NFSHomeDirectory', () => {
    const fact = parseDirectoryServiceAccount({
      platform: 'darwin',
      stdout: validDsclStdout(502, '/Users/from-dscl-only'),
      expectedUid: 502,
      HOME: HOSTILE_HOME,
      osHomedir: HOSTILE_OS_HOMEDIR,
    });
    assert.deepEqual(fact, expectedAccountFact(502, '/Users/from-dscl-only'));
    assert.equal(fact.roots.launchAgents.canonicalPath.startsWith(HOSTILE_HOME), false);
  });

  test('parseDirectoryServiceAccount：missing/duplicate/malformed/mismatch/non-darwin/unknown/accessor → account-resolution-unavailable', () => {
    const base = {
      platform: 'darwin',
      stdout: validDsclStdout(),
      expectedUid: FIXED_UID,
      HOME: HOSTILE_HOME,
      osHomedir: HOSTILE_OS_HOMEDIR,
    };

    const cases = [
      ['non-darwin', { ...base, platform: 'linux' }],
      ['empty platform', { ...base, platform: '' }],
      ['missing UniqueID', { ...base, stdout: `NFSHomeDirectory: ${FIXTURE_HOME}\n` }],
      ['missing NFSHomeDirectory', { ...base, stdout: `UniqueID: ${FIXED_UID}\n` }],
      [
        'duplicate UniqueID',
        {
          ...base,
          stdout: `UniqueID: ${FIXED_UID}\nUniqueID: ${FIXED_UID}\nNFSHomeDirectory: ${FIXTURE_HOME}\n`,
        },
      ],
      [
        'duplicate NFSHomeDirectory',
        {
          ...base,
          stdout:
            `UniqueID: ${FIXED_UID}\nNFSHomeDirectory: ${FIXTURE_HOME}\nNFSHomeDirectory: ${FIXTURE_HOME}\n`,
        },
      ],
      [
        'malformed UniqueID',
        { ...base, stdout: `UniqueID: not-a-uid\nNFSHomeDirectory: ${FIXTURE_HOME}\n` },
      ],
      [
        'relative home',
        { ...base, stdout: `UniqueID: ${FIXED_UID}\nNFSHomeDirectory: relative/home\n` },
      ],
      [
        'uid mismatch',
        { ...base, expectedUid: 999, stdout: validDsclStdout(FIXED_UID, FIXTURE_HOME) },
      ],
      [
        'canary in stdout still no leak on error',
        { ...base, stdout: `${CANARY_STDOUT}\nUniqueID: x\n` },
      ],
      [
        // 严格 parser：valid UniqueID/NFSHomeDirectory 之外的未知非空字段行不得静默忽略
        'unknown non-empty DS field line',
        {
          ...base,
          stdout:
            `UniqueID: ${FIXED_UID}\nNFSHomeDirectory: ${FIXTURE_HOME}\nRealName: ${CANARY_USERNAME}\n`,
        },
      ],
      ['unknown key', withOwnData(base, 'unexpected', true)],
      ['symbol key', withSymbol(base)],
      ['null input', null],
      ['array input', Object.assign([], base)],
      ['missing HOME key', {
        platform: 'darwin',
        stdout: validDsclStdout(),
        expectedUid: FIXED_UID,
        osHomedir: HOSTILE_OS_HOMEDIR,
      }],
    ];

    for (const [name, input] of cases) {
      assertThrowsCode(() => parseDirectoryServiceAccount(input), CODE_ACCOUNT);
      try {
        parseDirectoryServiceAccount(input);
      } catch (error) {
        assertNoLeakage(
          error,
          [CANARY_STDOUT, CANARY_USERNAME, CANARY_PATH, FIXTURE_HOME, HOSTILE_HOME],
          name,
        );
      }
    }

    let accessorHits = 0;
    assertThrowsCode(
      () => parseDirectoryServiceAccount(withAccessor(base, 'extra', () => {
        accessorHits += 1;
      })),
      CODE_ACCOUNT,
    );
    assert.equal(accessorHits, 0, 'hostile accessor must not execute');
  });

  // =========================================================================
  // 2) createDarwinAccountResolver (+ ForTest)
  // =========================================================================

  test('createDarwinAccountResolver：production 零参数 factory，不接受依赖注入', () => {
    assert.equal(typeof createDarwinAccountResolver, 'function');
    assert.equal(createDarwinAccountResolver.length, 0);
    // 传入伪装依赖不得被接受为注入面（零参数签名）；构造本身不得抛与依赖相关的泄漏。
    const resolver = createDarwinAccountResolver();
    assert.equal(typeof resolver.resolve, 'function');
    assert.deepEqual(ownEnumerableMethodNames(resolver), ['resolve']);
  });

  test('createDarwinAccountResolverForTest：固定 /usr/bin/dscl、字面 argv、timeout/cap，返回 account fact', async () => {
    const calls = [];
    const execFile = async (file, args, options) => {
      calls.push({
        file,
        args: Array.isArray(args) ? [...args] : args,
        options: options ? { ...options } : options,
      });
      // 两阶段可实现契约：search(UniqueID) → read(userPath)；亦允许单次 read。
      // 测试接受 1..2 次 /usr/bin/dscl 调用，最后一次 stdout 供 parseDirectoryServiceAccount。
      if (Array.isArray(args) && args.includes('-search')) {
        return {
          stdout: `fixtureuser\t\tUniqueID = (\n\t${FIXED_UID}\n)\n`,
        };
      }
      return { stdout: validDsclStdout(FIXED_UID, FIXTURE_HOME) };
    };

    const resolver = createDarwinAccountResolverForTest({
      platform: 'darwin',
      getUid: () => FIXED_UID,
      execFile,
    });
    const fact = await resolver.resolve();
    assert.deepEqual(fact, expectedAccountFact(FIXED_UID, FIXTURE_HOME));
    assertDeepFrozen(fact, 'resolvedAccount');

    assert.ok(calls.length >= 1 && calls.length <= 2, 'dscl must be invoked 1..2 times');
    for (const call of calls) {
      assert.equal(call.file, '/usr/bin/dscl');
      assert.ok(Array.isArray(call.args), 'argv must be literal string array (no shell command string)');
      assert.equal(
        call.args.every((a) => typeof a === 'string'),
        true,
        'argv elements must be strings',
      );
      // 不得把整条命令当作 shell 字符串
      assert.equal(typeof call.args, 'object');
      assert.equal(call.options?.timeout, DSCL_TIMEOUT_MS);
      assert.equal(call.options?.maxBuffer, DSCL_MAX_BUFFER_BYTES);
      assert.notEqual(call.options?.shell, true);
      // 禁止 shell 元字符拼进单一 command 字段
      assert.equal(Object.hasOwn(call.options ?? {}, 'shell') && call.options.shell === true, false);
    }

    // 至少一次调用必须把 uid 以十进制字面量放入 argv，或 read 属性列表含 UniqueID/NFSHomeDirectory
    const argvJoined = calls.map((c) => c.args.join('\0')).join('\n');
    assert.ok(
      argvJoined.includes(String(FIXED_UID))
        || calls.some((c) => c.args.includes('UniqueID') && c.args.includes('NFSHomeDirectory')),
      'dscl argv must reference uid or explicit UniqueID/NFSHomeDirectory read fields',
    );
  });

  test('createDarwinAccountResolverForTest：timeout/nonzero/permission/malformed/oversize → account-resolution-unavailable 且无 raw', async () => {
    const scenarios = [
      {
        name: 'timeout',
        execFile: async () => {
          const err = new Error(`Timeout ${CANARY_STDOUT}`);
          err.killed = true;
          err.signal = 'SIGTERM';
          throw err;
        },
      },
      {
        name: 'nonzero',
        execFile: async () => {
          const err = new Error(`Command failed: ${CANARY_STDERR}`);
          err.code = 1;
          err.stdout = CANARY_STDOUT;
          err.stderr = CANARY_STDERR;
          throw err;
        },
      },
      {
        name: 'permission',
        execFile: async () => {
          const err = new Error(`EACCES ${CANARY_PATH}`);
          err.code = 'EACCES';
          throw err;
        },
      },
      {
        name: 'malformed stdout',
        execFile: async () => ({ stdout: `garbage ${CANARY_STDOUT}\n` }),
      },
      {
        name: 'oversize',
        execFile: async () => {
          const err = new Error(`maxBuffer exceeded ${CANARY_STDOUT}`);
          err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          throw err;
        },
      },
    ];

    for (const scenario of scenarios) {
      const resolver = createDarwinAccountResolverForTest({
        platform: 'darwin',
        getUid: () => FIXED_UID,
        execFile: scenario.execFile,
      });
      await assertRejectsCode(resolver.resolve(), CODE_ACCOUNT);
      try {
        await resolver.resolve();
      } catch (error) {
        assertNoLeakage(
          error,
          [CANARY_STDOUT, CANARY_STDERR, CANARY_PATH, FIXTURE_HOME],
          scenario.name,
        );
      }
    }
  });

  test('createDarwinAccountResolverForTest：拒绝 unknown key / hostile accessor / 非 darwin', async () => {
    const execFile = async () => ({ stdout: validDsclStdout() });
    let hits = 0;
    assertThrowsCode(
      () => createDarwinAccountResolverForTest(withAccessor({
        platform: 'darwin',
        getUid: () => FIXED_UID,
        execFile,
      }, 'evil', () => {
        hits += 1;
      })),
      CODE_INVALID,
    );
    assert.equal(hits, 0);

    assertThrowsCode(
      () => createDarwinAccountResolverForTest(withOwnData({
        platform: 'darwin',
        getUid: () => FIXED_UID,
        execFile,
      }, 'extra', 1)),
      CODE_INVALID,
    );

    const resolver = createDarwinAccountResolverForTest({
      platform: 'linux',
      getUid: () => FIXED_UID,
      execFile,
    });
    await assertRejectsCode(resolver.resolve(), CODE_ACCOUNT);
  });

  // =========================================================================
  // 3) createLaunchAgentHostInspector (+ ForTest)
  // =========================================================================

  test('createLaunchAgentHostInspector：production 零参数；own surface 仅 inspect/read', () => {
    assert.equal(createLaunchAgentHostInspector.length, 0);
    const inspector = createLaunchAgentHostInspector();
    assert.deepEqual(ownEnumerableMethodNames(inspector), ['inspect', 'read'].sort());
    for (const forbidden of [
      'writeFile',
      'rename',
      'unlink',
      'remove',
      'replace',
      'open',
      'publishAbsent',
      'replaceIfMatch',
      'removeIfMatch',
    ]) {
      assert.equal(
        ownEnumerableNames(inspector).includes(forbidden),
        false,
        `inspector must not expose ${forbidden}`,
      );
    }
  });

  test('createLaunchAgentHostInspectorForTest：inspect 现有 0600 文件返回完整 identity；absent 返回 address', async (t) => {
    await withTempRoot(t, async (tempRoot) => {
      const launchAgentsDir = join(tempRoot, 'LaunchAgents');
      const metadataDir = join(tempRoot, 'metadata');
      const contents = Buffer.from('controller-plist-bytes-v1', 'utf8');
      await seedRegularFile(launchAgentsDir, FILENAME_CONTROLLER, contents, 0o600);
      await mkdir(metadataDir, { recursive: true, mode: 0o700 });

      const st = await lstat(join(launchAgentsDir, FILENAME_CONTROLLER));
      const account = {
        uid: FIXED_UID,
        roots: {
          launchAgents: {
            rootId: ROOT_LAUNCH_AGENTS,
            canonicalPath: launchAgentsDir,
          },
          metadata: {
            rootId: ROOT_METADATA,
            canonicalPath: metadataDir,
          },
        },
      };
      // ownerUid 必须等于 account.uid；测试环境文件 owner 可能不是 501。
      // 窄化：ForTest 的 account.uid 对齐 st.uid，以验证 identity 字段而非强改系统账号。
      account.uid = st.uid;

      const { fs, counts } = createCountingFs();
      const inspector = createLaunchAgentHostInspectorForTest({
        accountResolver: fixedAccountResolver(account),
        fs,
      });

      const present = await inspector.inspect({
        rootId: ROOT_LAUNCH_AGENTS,
        basename: FILENAME_CONTROLLER,
      });
      assert.deepEqual(present, {
        rootId: ROOT_LAUNCH_AGENTS,
        basename: FILENAME_CONTROLLER,
        type: 'regular-file',
        ownerUid: account.uid,
        device: String(st.dev),
        inode: String(st.ino),
        sha256: sha256Hex(contents),
      });
      assertDeepFrozen(present, 'fullIdentity');
      assertExactKeys(present, [
        'rootId',
        'basename',
        'type',
        'ownerUid',
        'device',
        'inode',
        'sha256',
      ]);

      const absent = await inspector.inspect({
        rootId: ROOT_METADATA,
        basename: FILENAME_MANIFEST,
      });
      assert.deepEqual(absent, {
        rootId: ROOT_METADATA,
        basename: FILENAME_MANIFEST,
        type: 'regular-file',
        ownerUid: account.uid,
      });
      assertDeepFrozen(absent, 'absentAddress');
      assertExactKeys(absent, ['rootId', 'basename', 'type', 'ownerUid']);

      assert.ok((counts.lstat ?? 0) + (counts.readFile ?? 0) > 0, 'fs seams must be used');
    });
  });

  test('createLaunchAgentHostInspectorForTest：inspect 拒绝交叉组合 / nested / absolute / unknown key', async (t) => {
    await withTempRoot(t, async (tempRoot) => {
      const launchAgentsDir = join(tempRoot, 'LaunchAgents');
      const metadataDir = join(tempRoot, 'metadata');
      await mkdir(launchAgentsDir, { recursive: true });
      await mkdir(metadataDir, { recursive: true });
      const account = {
        uid: FIXED_UID,
        roots: {
          launchAgents: { rootId: ROOT_LAUNCH_AGENTS, canonicalPath: launchAgentsDir },
          metadata: { rootId: ROOT_METADATA, canonicalPath: metadataDir },
        },
      };
      const { fs } = createCountingFs();
      const inspector = createLaunchAgentHostInspectorForTest({
        accountResolver: fixedAccountResolver(account),
        fs,
      });

      const invalidAddresses = [
        { rootId: ROOT_LAUNCH_AGENTS, basename: FILENAME_MANIFEST },
        { rootId: ROOT_METADATA, basename: FILENAME_CONTROLLER },
        { rootId: ROOT_LAUNCH_AGENTS, basename: '../etc/passwd' },
        { rootId: ROOT_LAUNCH_AGENTS, basename: FILENAME_CONTROLLER + '/nested' },
        { rootId: ROOT_LAUNCH_AGENTS, basename: '/absolute.plist' },
        { rootId: ROOT_LAUNCH_AGENTS, basename: 'com.linke.controller.plist.backup' },
        { rootId: 'unknown-root', basename: FILENAME_CONTROLLER },
        { rootId: ROOT_LAUNCH_AGENTS, basename: FILENAME_CONTROLLER, extra: true },
        null,
      ];

      for (const address of invalidAddresses) {
        await assertRejectsCode(inspector.inspect(address), CODE_INVALID);
        try {
          await inspector.inspect(address);
        } catch (error) {
          assertNoLeakage(error, [tempRoot, CANARY_PATH, launchAgentsDir], 'inspect invalid');
        }
      }

      let hits = 0;
      await assertRejectsCode(
        inspector.inspect(withAccessor({
          rootId: ROOT_LAUNCH_AGENTS,
          basename: FILENAME_CONTROLLER,
        }, 'x', () => {
          hits += 1;
        })),
        CODE_INVALID,
      );
      assert.equal(hits, 0);
    });
  });

  test('createLaunchAgentHostInspectorForTest：read 仅在 identity 全匹配时返回 detached Buffer；漂移 fail-closed', async (t) => {
    await withTempRoot(t, async (tempRoot) => {
      const launchAgentsDir = join(tempRoot, 'LaunchAgents');
      const metadataDir = join(tempRoot, 'metadata');
      const contents = Buffer.from('stable-bytes-for-read', 'utf8');
      const filePath = await seedRegularFile(
        launchAgentsDir,
        FILENAME_SCHEDULER,
        contents,
        0o600,
      );
      await mkdir(metadataDir, { recursive: true });
      const st = await lstat(filePath);
      const account = {
        uid: st.uid,
        roots: {
          launchAgents: { rootId: ROOT_LAUNCH_AGENTS, canonicalPath: launchAgentsDir },
          metadata: { rootId: ROOT_METADATA, canonicalPath: metadataDir },
        },
      };
      const resolver = fixedAccountResolver(account);
      const { fs } = createCountingFs();
      const inspector = createLaunchAgentHostInspectorForTest({
        accountResolver: resolver,
        fs,
      });

      const identity = await inspector.inspect({
        rootId: ROOT_LAUNCH_AGENTS,
        basename: FILENAME_SCHEDULER,
      });
      const bytes = await inspector.read(identity);
      assert.ok(Buffer.isBuffer(bytes));
      assert.equal(bytes.equals(contents), true);
      // detached：修改返回值不得影响再次 read
      bytes.fill(0);
      const bytes2 = await inspector.read(identity);
      assert.equal(bytes2.equals(contents), true);

      // hash 漂移
      await writeFile(filePath, Buffer.from('tampered', 'utf8'), { mode: 0o600 });
      await chmod(filePath, 0o600);
      await assertRejectsCode(inspector.read(identity), CODE_INVALID);

      // 恢复后构造 mode 漂移
      await writeFile(filePath, contents, { mode: 0o600 });
      await chmod(filePath, 0o644);
      const identity2 = {
        ...identity,
        sha256: sha256Hex(contents),
      };
      // mode 非 0600 → invalid（重新 inspect 也应失败）
      await assertRejectsCode(
        inspector.inspect({
          rootId: ROOT_LAUNCH_AGENTS,
          basename: FILENAME_SCHEDULER,
        }),
        CODE_INVALID,
      );
      await chmod(filePath, 0o600);

      // root swap：resolve 返回不同 canonicalPath → fail closed
      resolver.setAccount({
        uid: st.uid,
        roots: {
          launchAgents: {
            rootId: ROOT_LAUNCH_AGENTS,
            canonicalPath: join(tempRoot, 'swapped-LaunchAgents'),
          },
          metadata: { rootId: ROOT_METADATA, canonicalPath: metadataDir },
        },
      });
      await assertRejectsCode(inspector.read(identity2), CODE_INVALID);

      // symlink leaf
      resolver.setAccount(account);
      await rm(filePath, { force: true });
      await symlink(join(tempRoot, 'elsewhere'), filePath);
      await assertRejectsCode(
        inspector.inspect({
          rootId: ROOT_LAUNCH_AGENTS,
          basename: FILENAME_SCHEDULER,
        }),
        CODE_INVALID,
      );
    });
  });

  test('createLaunchAgentHostInspectorForTest：拒绝 unknown injection key；directory 类型 invalid', async (t) => {
    await withTempRoot(t, async (tempRoot) => {
      const launchAgentsDir = join(tempRoot, 'LaunchAgents');
      const metadataDir = join(tempRoot, 'metadata');
      await mkdir(launchAgentsDir, { recursive: true });
      await mkdir(metadataDir, { recursive: true });
      // basename 位置是目录而非文件
      await mkdir(join(launchAgentsDir, FILENAME_CONTROLLER), { recursive: true });

      const account = {
        uid: FIXED_UID,
        roots: {
          launchAgents: { rootId: ROOT_LAUNCH_AGENTS, canonicalPath: launchAgentsDir },
          metadata: { rootId: ROOT_METADATA, canonicalPath: metadataDir },
        },
      };
      const { fs } = createCountingFs();

      assertThrowsCode(
        () => createLaunchAgentHostInspectorForTest(withOwnData({
          accountResolver: fixedAccountResolver(account),
          fs,
        }, 'execFile', async () => {})),
        CODE_INVALID,
      );

      const inspector = createLaunchAgentHostInspectorForTest({
        accountResolver: fixedAccountResolver(account),
        fs,
      });
      await assertRejectsCode(
        inspector.inspect({
          rootId: ROOT_LAUNCH_AGENTS,
          basename: FILENAME_CONTROLLER,
        }),
        CODE_INVALID,
      );
    });
  });

  test('createLaunchAgentHostInspectorForTest：absent leaf 期间真实 root inode swap → invalid', async (t) => {
    // 证明 root identity 复核基于 device/inode，而非仅 resolver canonicalPath 字符串或 realpath 文本。
    // 仅在 temp root 内 rename；两根同属测试 uid、leaf 均 absent、canonical 字符串不变。
    await withTempRoot(t, async (tempRoot) => {
      const launchAgentsDir = join(tempRoot, 'LaunchAgents');
      const metadataDir = join(tempRoot, 'metadata-root');
      const replacementDir = join(tempRoot, 'metadata-replacement');
      const siblingDir = join(tempRoot, 'metadata-swapped-out');
      await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
      await mkdir(metadataDir, { recursive: true, mode: 0o700 });
      await mkdir(replacementDir, { recursive: true, mode: 0o700 });

      const rootBefore = await lstat(metadataDir);
      const rootReplacement = await lstat(replacementDir);
      assert.equal(rootBefore.uid, rootReplacement.uid, '两根必须同属当前测试 uid');
      assert.notEqual(
        String(rootBefore.ino),
        String(rootReplacement.ino),
        'replacement 必须是不同 inode，才能证明 swap 检测',
      );

      // 固定 account fact：canonicalPath 字符串全程不变（不是 resolver path 漂移用例）
      const frozenCanonical = metadataDir;
      const account = {
        uid: rootBefore.uid,
        roots: {
          launchAgents: { rootId: ROOT_LAUNCH_AGENTS, canonicalPath: launchAgentsDir },
          metadata: { rootId: ROOT_METADATA, canonicalPath: frozenCanonical },
        },
      };
      assert.equal(account.roots.metadata.canonicalPath, frozenCanonical);

      const leafPath = join(metadataDir, FILENAME_MANIFEST);
      let leafLstatSeen = 0;
      let swapped = false;

      const { fs } = createCountingFs({
        lstat: async (targetPath) => {
          // 第一次目标 leaf lstat 返回 ENOENT 之前：原 root rename 到 sibling，replacement rename 进同路径
          if (targetPath === leafPath) {
            leafLstatSeen += 1;
            if (!swapped) {
              swapped = true;
              await rename(metadataDir, siblingDir);
              await rename(replacementDir, metadataDir);
            }
            const err = new Error('ENOENT');
            err.code = 'ENOENT';
            throw err;
          }
          return lstat(targetPath);
        },
      });

      const inspector = createLaunchAgentHostInspectorForTest({
        accountResolver: fixedAccountResolver(account),
        fs,
      });

      await assert.rejects(
        inspector.inspect({
          rootId: ROOT_METADATA,
          basename: FILENAME_MANIFEST,
        }),
        (error) => {
          assertLifecycleError(error, CODE_INVALID);
          assertNoLeakage(
            error,
            [tempRoot, metadataDir, siblingDir, CANARY_PATH, FIXTURE_HOME],
            'root inode swap',
          );
          return true;
        },
      );
      assert.equal(leafLstatSeen >= 1, true, '必须真正触达 leaf lstat 并在 ENOENT 前完成 root swap');
      assert.equal(swapped, true);
      // swap 后同路径仍是目录且 leaf 仍 absent；失败原因应是 root inode 变化，canonical 字符串未变
      const rootAfter = await lstat(metadataDir);
      assert.equal(String(rootAfter.ino), String(rootReplacement.ino));
      assert.notEqual(String(rootAfter.ino), String(rootBefore.ino));
      assert.equal(account.roots.metadata.canonicalPath, frozenCanonical);
    });
  });

  // =========================================================================
  // 4) validateLaunchctlRequest
  // =========================================================================

  test('validateLaunchctlRequest：四类合法 argv（controller/scheduler 同形）与固定 timeout', () => {
    const resolvedController = '/resolved/LaunchAgents/com.linke.controller.plist';
    const resolvedScheduler = '/resolved/LaunchAgents/com.linke.scheduler.plist';

    const legal = [
      {
        input: {
          operation: 'bootstrap',
          uid: FIXED_UID,
          rootId: ROOT_LAUNCH_AGENTS,
          basename: FILENAME_CONTROLLER,
          resolvedPath: resolvedController,
          argv: ['bootstrap', 'gui/501', resolvedController],
        },
        expected: {
          operation: 'bootstrap',
          role: 'controller',
          timeoutMs: BOOTSTRAP_BOOTOUT_TIMEOUT_MS,
          argv: ['bootstrap', 'gui/501', resolvedController],
        },
      },
      {
        input: {
          operation: 'bootout',
          uid: FIXED_UID,
          rootId: ROOT_LAUNCH_AGENTS,
          basename: FILENAME_CONTROLLER,
          resolvedPath: resolvedController,
          argv: ['bootout', 'gui/501/com.linke.controller'],
        },
        expected: {
          operation: 'bootout',
          role: 'controller',
          timeoutMs: BOOTSTRAP_BOOTOUT_TIMEOUT_MS,
          argv: ['bootout', 'gui/501/com.linke.controller'],
        },
      },
      {
        input: {
          operation: 'kickstart',
          uid: FIXED_UID,
          rootId: ROOT_LAUNCH_AGENTS,
          basename: FILENAME_CONTROLLER,
          resolvedPath: resolvedController,
          argv: ['kickstart', '-k', 'gui/501/com.linke.controller'],
        },
        expected: {
          operation: 'kickstart',
          role: 'controller',
          timeoutMs: KICKSTART_PRINT_TIMEOUT_MS,
          argv: ['kickstart', '-k', 'gui/501/com.linke.controller'],
        },
      },
      {
        input: {
          operation: 'print',
          uid: FIXED_UID,
          rootId: ROOT_LAUNCH_AGENTS,
          basename: FILENAME_CONTROLLER,
          resolvedPath: resolvedController,
          argv: ['print', 'gui/501/com.linke.controller'],
        },
        expected: {
          operation: 'print',
          role: 'controller',
          timeoutMs: KICKSTART_PRINT_TIMEOUT_MS,
          argv: ['print', 'gui/501/com.linke.controller'],
        },
      },
      {
        input: {
          operation: 'bootstrap',
          uid: FIXED_UID,
          rootId: ROOT_LAUNCH_AGENTS,
          basename: FILENAME_SCHEDULER,
          resolvedPath: resolvedScheduler,
          argv: ['bootstrap', 'gui/501', resolvedScheduler],
        },
        expected: {
          operation: 'bootstrap',
          role: 'scheduler',
          timeoutMs: BOOTSTRAP_BOOTOUT_TIMEOUT_MS,
          argv: ['bootstrap', 'gui/501', resolvedScheduler],
        },
      },
      {
        input: {
          operation: 'print',
          uid: FIXED_UID,
          rootId: ROOT_LAUNCH_AGENTS,
          basename: FILENAME_SCHEDULER,
          resolvedPath: resolvedScheduler,
          argv: ['print', 'gui/501/com.linke.scheduler'],
        },
        expected: {
          operation: 'print',
          role: 'scheduler',
          timeoutMs: KICKSTART_PRINT_TIMEOUT_MS,
          argv: ['print', 'gui/501/com.linke.scheduler'],
        },
      },
    ];

    for (const { input, expected } of legal) {
      const out = validateLaunchctlRequest(input);
      assert.deepEqual(out, expected);
      assertDeepFrozen(out, 'launchctlRequest');
      assertExactKeys(out, ['operation', 'role', 'timeoutMs', 'argv']);
      // caller 不得通过输入传入 timeout 字段
      assert.equal(Object.hasOwn(input, 'timeoutMs'), false);
    }
  });

  test('validateLaunchctlRequest：command string / shell chars / 错 uid / 错 path / unknown → invalid 无 raw', () => {
    const resolvedController = '/resolved/LaunchAgents/com.linke.controller.plist';
    const base = {
      operation: 'bootstrap',
      uid: FIXED_UID,
      rootId: ROOT_LAUNCH_AGENTS,
      basename: FILENAME_CONTROLLER,
      resolvedPath: resolvedController,
      argv: ['bootstrap', 'gui/501', resolvedController],
    };

    const cases = [
      withOwnData(base, 'argv', 'bootstrap gui/501 /resolved/...'),
      withOwnData(base, 'argv', ['bootstrap', 'gui/501', resolvedController, CANARY_ARGV]),
      withOwnData(base, 'argv', ['bootstrap', 'gui/501;rm -rf /', resolvedController]),
      withOwnData(base, 'uid', 502),
      withOwnData(base, 'argv', ['bootstrap', 'gui/502', resolvedController]),
      withOwnData(base, 'argv', ['bootstrap', 'system/501', resolvedController]),
      withOwnData(base, 'basename', FILENAME_SCHEDULER),
      withOwnData(base, 'resolvedPath', 'relative/LaunchAgents/com.linke.controller.plist'),
      withOwnData(base, 'resolvedPath', '/resolved/LaunchAgents/nested/com.linke.controller.plist'),
      withOwnData(base, 'operation', 'load'),
      withOwnData(base, 'timeoutMs', 1),
      withOwnData(base, 'rootId', ROOT_METADATA),
      withOwnData(base, 'unexpected', true),
      withSymbol(base),
      null,
      Object.assign([], base),
    ];

    for (const input of cases) {
      assertThrowsCode(() => validateLaunchctlRequest(input), CODE_INVALID);
      try {
        validateLaunchctlRequest(input);
      } catch (error) {
        assertNoLeakage(
          error,
          [CANARY_ARGV, resolvedController, CANARY_PATH, '/resolved/'],
          'validateLaunchctlRequest',
        );
      }
    }

    let hits = 0;
    assertThrowsCode(
      () => validateLaunchctlRequest(withAccessor(base, 'evil', () => {
        hits += 1;
      })),
      CODE_INVALID,
    );
    assert.equal(hits, 0);
  });

  // =========================================================================
  // 5) mapLaunchctlResult
  // =========================================================================

  test('mapLaunchctlResult：仅投影 frozen { outcome }，raw/canary 永不回显', () => {
    const closedOutcomes = new Set([
      'ok',
      'timeout',
      'permission-denied',
      'nonzero-exit',
      'malformed-output',
      'unknown-result',
    ]);

    const samples = [
      {
        input: {
          operation: 'bootstrap',
          timedOut: false,
          permissionDenied: false,
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        outcome: 'ok',
      },
      {
        input: {
          operation: 'bootout',
          timedOut: true,
          permissionDenied: false,
          exitCode: null,
          stdout: CANARY_STDOUT,
          stderr: CANARY_STDERR,
        },
        outcome: 'timeout',
      },
      {
        input: {
          operation: 'kickstart',
          timedOut: false,
          permissionDenied: true,
          exitCode: 1,
          stdout: CANARY_STDOUT,
          stderr: CANARY_STDERR,
        },
        outcome: 'permission-denied',
      },
      {
        input: {
          operation: 'print',
          timedOut: false,
          permissionDenied: false,
          exitCode: 7,
          stdout: CANARY_STDOUT,
          stderr: CANARY_STDERR,
        },
        outcome: 'nonzero-exit',
      },
      {
        input: {
          operation: 'print',
          timedOut: false,
          permissionDenied: false,
          exitCode: 0,
          stdout: `not-a-valid-print ${CANARY_STDOUT}`,
          stderr: '',
        },
        // print + exit 0 但 stdout 明确 malformed：必须 malformed-output，不得静默 ok，且不回显 raw
        outcome: 'malformed-output',
      },
      {
        input: {
          operation: 'print',
          timedOut: false,
          permissionDenied: false,
          exitCode: null,
          stdout: '',
          stderr: '',
        },
        // exitCode null 且无 timeout/permission → unknown-result
        outcome: 'unknown-result',
      },
    ];

    for (const { input, outcome } of samples) {
      const projected = mapLaunchctlResult(input);
      assert.deepEqual(projected, { outcome });
      assertDeepFrozen(projected, 'mapLaunchctlResult');
      assertExactKeys(projected, ['outcome']);
      assert.equal(closedOutcomes.has(projected.outcome), true);
      assertNoLeakage(projected, [CANARY_STDOUT, CANARY_STDERR, CANARY_PATH], 'outcome projection');
    }
  });

  test('mapLaunchctlResult：closed input；unknown key / accessor → invalid', () => {
    const base = {
      operation: 'bootstrap',
      timedOut: false,
      permissionDenied: false,
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
    assertThrowsCode(() => mapLaunchctlResult(withOwnData(base, 'signal', 9)), CODE_INVALID);
    assertThrowsCode(() => mapLaunchctlResult(null), CODE_INVALID);
    let hits = 0;
    assertThrowsCode(
      () => mapLaunchctlResult(withAccessor(base, 'x', () => {
        hits += 1;
      })),
      CODE_INVALID,
    );
    assert.equal(hits, 0);
  });

  // =========================================================================
  // 6) parseLaunchctlPrint
  // =========================================================================

  /**
   * 合成 launchctl print fixture（非真实主机输出）。
   * 解析 state / pid / path / ProgramArguments，canonicalize 后哈希 job identity。
   */
  function syntheticPrintStdout({
    uid = FIXED_UID,
    label = LABEL_CONTROLLER,
    state = 'running',
    pid = 4242,
    plistPath = `${FIXTURE_HOME}/Library/LaunchAgents/${FILENAME_CONTROLLER}`,
    programArguments = ['/usr/bin/node', '/opt/linke/src/controller-runtime.js'],
  } = {}) {
    const argsBlock = programArguments
      .map((arg, index) => `\t\t${index} = ${arg}`)
      .join('\n');
    return [
      `gui/${uid}/${label} = {`,
      `\tactive count = 1`,
      `\tpath = ${plistPath}`,
      `\tstate = ${state}`,
      `\tprogram = ${programArguments[0]}`,
      `\targuments = {`,
      argsBlock,
      `\t}`,
      `\tpid = ${pid}`,
      `}`,
    ].join('\n');
  }

  function expectedJobIdentitySha256({ plistPath, programArguments }) {
    // 哈希输入：node:path.normalize(path) + NUL + JSON.stringify(逐个 normalize 的绝对 argv；非路径旗标原值)
    // 仅词法 normalize，不用 realpath / 真实文件。
    const normalizedPath = normalize(plistPath);
    const normalizedArgs = programArguments.map((arg) =>
      (typeof arg === 'string' && isAbsolute(arg) ? normalize(arg) : arg),
    );
    const canonical = `${normalizedPath}\0${JSON.stringify(normalizedArgs)}`;
    return sha256Hex(Buffer.from(canonical, 'utf8'));
  }

  test('parseLaunchctlPrint：loaded 形状与 jobIdentitySha256；unloaded 闭合形状', () => {
    const programArguments = ['/usr/bin/node', '/opt/linke/src/controller-runtime.js'];
    const plistPath = `${FIXTURE_HOME}/Library/LaunchAgents/${FILENAME_CONTROLLER}`;
    const stdout = syntheticPrintStdout({
      state: 'running',
      pid: 4242,
      plistPath,
      programArguments,
    });
    const loaded = parseLaunchctlPrint({
      stdout,
      expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
    });
    assert.deepEqual(loaded, {
      loaded: true,
      pid: 4242,
      state: 'running',
      jobIdentitySha256: expectedJobIdentitySha256({ plistPath, programArguments }),
    });
    assertDeepFrozen(loaded, 'printLoaded');
    assertExactKeys(loaded, ['loaded', 'pid', 'state', 'jobIdentitySha256']);
    assert.equal(SHA256_HEX.test(loaded.jobIdentitySha256), true);
    assertNoLeakage(loaded, [FIXTURE_HOME, plistPath, '/usr/bin/node', CANARY_PATH], 'print loaded');

    // waiting / exited / unknown
    for (const state of ['waiting', 'exited', 'unknown']) {
      const projected = parseLaunchctlPrint({
        stdout: syntheticPrintStdout({ state, pid: state === 'exited' ? 0 : 99 }),
        expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
      });
      assert.equal(projected.loaded, true);
      assert.equal(projected.state, state);
      assert.equal(Object.hasOwn(projected, 'jobIdentitySha256'), true);
      assertNoLeakage(projected, [FIXTURE_HOME, CANARY_STDOUT], `state=${state}`);
    }

    // unloaded：无 job 块 / 明确未加载的闭合形状
    const unloaded = parseLaunchctlPrint({
      stdout: `Could not find service "${LABEL_CONTROLLER}" in domain for gui/${FIXED_UID}\n`,
      expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
    });
    assert.deepEqual(unloaded, {
      loaded: false,
      pid: null,
      state: 'unloaded',
      jobIdentitySha256: null,
    });
    assertDeepFrozen(unloaded, 'printUnloaded');
    assertExactKeys(unloaded, ['loaded', 'pid', 'state', 'jobIdentitySha256']);
  });

  test('parseLaunchctlPrint：malformed/duplicate/mismatch/canary → invalid 且无 raw', () => {
    const good = {
      stdout: syntheticPrintStdout(),
      expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
    };
    const cases = [
      { stdout: '', expected: good.expected },
      { stdout: `garbage ${CANARY_STDOUT}`, expected: good.expected },
      {
        stdout: syntheticPrintStdout({ uid: 999 }),
        expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
      },
      {
        stdout: syntheticPrintStdout({ label: LABEL_SCHEDULER }),
        expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
      },
      {
        stdout: `${syntheticPrintStdout()}\n${syntheticPrintStdout({ pid: 1 })}`,
        expected: good.expected,
      },
      withOwnData(good, 'extra', 1),
      withSymbol(good),
      null,
    ];

    for (const input of cases) {
      assertThrowsCode(() => parseLaunchctlPrint(input), CODE_INVALID);
      try {
        parseLaunchctlPrint(input);
      } catch (error) {
        assertNoLeakage(
          error,
          [CANARY_STDOUT, FIXTURE_HOME, CANARY_PATH, LABEL_CONTROLLER],
          'parseLaunchctlPrint',
        );
      }
    }

    let hits = 0;
    assertThrowsCode(
      () => parseLaunchctlPrint(withAccessor(good, 'evil', () => {
        hits += 1;
      })),
      CODE_INVALID,
    );
    assert.equal(hits, 0);
  });

  test('parseLaunchctlPrint：词法 normalize 后的 jobIdentitySha256；错 plist 文件名/label → invalid', () => {
    // lexical normalization fixture：plistPath 与绝对 ProgramArguments 含 `..` / `.`
    const rawPlistPath =
      `${FIXTURE_HOME}/Library/LaunchAgents/../LaunchAgents/./${FILENAME_CONTROLLER}`;
    const rawProgramArguments = [
      '/usr/bin/../bin/node',
      '--flag-keep-raw',
      '/opt/linke/./src/../src/controller-runtime.js',
    ];
    const normalizedPlistPath = normalize(rawPlistPath);
    const normalizedProgramArguments = rawProgramArguments.map((arg) =>
      (isAbsolute(arg) ? normalize(arg) : arg),
    );
    // 非路径旗标必须保持原值
    assert.equal(normalizedProgramArguments[1], '--flag-keep-raw');
    assert.notEqual(rawPlistPath, normalizedPlistPath);
    assert.notEqual(rawProgramArguments[0], normalizedProgramArguments[0]);

    const stdout = syntheticPrintStdout({
      plistPath: rawPlistPath,
      programArguments: rawProgramArguments,
      state: 'running',
      pid: 4242,
    });
    const loaded = parseLaunchctlPrint({
      stdout,
      expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
    });
    assert.equal(loaded.loaded, true);
    assert.equal(
      loaded.jobIdentitySha256,
      expectedJobIdentitySha256({
        plistPath: rawPlistPath,
        programArguments: rawProgramArguments,
      }),
    );
    // 显式对照：hash 必须等于 normalize 后输入，不得等于 raw 未 normalize 拼接
    const rawHash = sha256Hex(
      Buffer.from(`${rawPlistPath}\0${JSON.stringify(rawProgramArguments)}`, 'utf8'),
    );
    const normalizedHash = sha256Hex(
      Buffer.from(
        `${normalizedPlistPath}\0${JSON.stringify(normalizedProgramArguments)}`,
        'utf8',
      ),
    );
    assert.equal(loaded.jobIdentitySha256, normalizedHash);
    assert.notEqual(loaded.jobIdentitySha256, rawHash);
    assertNoLeakage(
      loaded,
      [FIXTURE_HOME, rawPlistPath, normalizedPlistPath, CANARY_PATH],
      'lexical normalize identity',
    );

    // wrong plist filename（与 expected label 对应固定文件名不符）→ invalid
    assertThrowsCode(
      () => parseLaunchctlPrint({
        stdout: syntheticPrintStdout({
          label: LABEL_CONTROLLER,
          plistPath: `${FIXTURE_HOME}/Library/LaunchAgents/com.linke.wrong.plist`,
        }),
        expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
      }),
      CODE_INVALID,
    );

    // label mismatch（stdout label 与 expected 不一致）→ invalid
    assertThrowsCode(
      () => parseLaunchctlPrint({
        stdout: syntheticPrintStdout({
          label: LABEL_SCHEDULER,
          plistPath: `${FIXTURE_HOME}/Library/LaunchAgents/${FILENAME_SCHEDULER}`,
        }),
        expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
      }),
      CODE_INVALID,
    );

    // controller label 配 scheduler 文件名 → invalid
    assertThrowsCode(
      () => parseLaunchctlPrint({
        stdout: syntheticPrintStdout({
          label: LABEL_CONTROLLER,
          plistPath: `${FIXTURE_HOME}/Library/LaunchAgents/${FILENAME_SCHEDULER}`,
        }),
        expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
      }),
      CODE_INVALID,
    );

    try {
      parseLaunchctlPrint({
        stdout: syntheticPrintStdout({
          label: LABEL_CONTROLLER,
          plistPath: `${FIXTURE_HOME}/Library/LaunchAgents/com.linke.wrong.plist`,
        }),
        expected: { uid: FIXED_UID, label: LABEL_CONTROLLER },
      });
    } catch (error) {
      assertNoLeakage(
        error,
        [FIXTURE_HOME, 'com.linke.wrong.plist', CANARY_PATH],
        'wrong plist filename',
      );
    }
  });

  // =========================================================================
  // 7) createDisabledLaunchctlRunner
  // =========================================================================

  test('createDisabledLaunchctlRunner：surface 仅 run；永远 launchctl-disabled；零子进程', async () => {
    let subprocessCalls = 0;
    const spyExec = async () => {
      subprocessCalls += 1;
      return { stdout: CANARY_STDOUT };
    };

    // production factory 零参数；caller 不得注入真实/测试 launchctl runner。
    assert.equal(createDisabledLaunchctlRunner.length, 0);
    const runner = createDisabledLaunchctlRunner();
    assert.deepEqual(ownEnumerableMethodNames(runner), ['run']);

    const result = await runner.run({
      operation: 'bootstrap',
      argv: ['bootstrap', 'gui/501', CANARY_PATH],
    });
    assert.deepEqual(result, { outcome: 'launchctl-disabled' });
    assertDeepFrozen(result, 'disabledRunner');
    assertExactKeys(result, ['outcome']);
    assert.equal(result.outcome, CODE_LAUNCHCTL_DISABLED);

    // 尝试注入 spy：必须 invalid 或被完全忽略，且 spy 零调用。
    let injectedRunner = null;
    try {
      injectedRunner = createDisabledLaunchctlRunner({ execFile: spyExec });
    } catch (error) {
      assertLifecycleError(error, CODE_INVALID);
    }
    if (injectedRunner) {
      const injectedResult = await injectedRunner.run({
        operation: 'print',
        argv: ['print', 'gui/501/com.linke.controller'],
      });
      assert.deepEqual(injectedResult, { outcome: 'launchctl-disabled' });
    }
    assert.equal(subprocessCalls, 0);
    assertNoLeakage(result, [CANARY_PATH, CANARY_STDOUT, '/bin/launchctl'], 'disabled outcome');
  });

  // =========================================================================
  // 8) createUnsupportedProductionAtomicPublisher
  // =========================================================================

  test('createUnsupportedProductionAtomicPublisher：三方法均 conditional-mutation-unsupported；零 rename/unlink', async () => {
    let renameCalls = 0;
    let unlinkCalls = 0;
    const hostileFs = {
      rename: async () => {
        renameCalls += 1;
      },
      unlink: async () => {
        unlinkCalls += 1;
      },
    };

    assert.equal(createUnsupportedProductionAtomicPublisher.length, 0);
    const publisher = createUnsupportedProductionAtomicPublisher();
    assert.deepEqual(ownEnumerableMethodNames(publisher).sort(), [
      'publishAbsent',
      'removeIfMatch',
      'replaceIfMatch',
    ].sort());

    for (const method of ['publishAbsent', 'replaceIfMatch', 'removeIfMatch']) {
      const out = await publisher[method]({
        rootId: ROOT_LAUNCH_AGENTS,
        basename: FILENAME_CONTROLLER,
        canary: CANARY_PATH,
      });
      assert.deepEqual(out, { outcome: 'conditional-mutation-unsupported' });
      assertDeepFrozen(out, method);
      assert.equal(out.outcome, CODE_MUTATION_UNSUPPORTED);
      assertNoLeakage(out, [CANARY_PATH], method);
    }

    // 拒绝 caller 注入：多余依赖要么 invalid，要么被忽略且永不 rename/unlink。
    let injected = null;
    try {
      injected = createUnsupportedProductionAtomicPublisher({ fs: hostileFs });
    } catch (error) {
      assertLifecycleError(error, CODE_INVALID);
    }
    if (injected) {
      await injected.replaceIfMatch({ match: CANARY_PATH });
      await injected.removeIfMatch({ match: CANARY_PATH });
      await injected.publishAbsent({ path: CANARY_PATH });
    }
    assert.equal(renameCalls, 0);
    assert.equal(unlinkCalls, 0);
  });

  // =========================================================================
  // 9) createPlistValidator (+ ForTest)
  // =========================================================================

  function validCandidateRef(overrides = {}) {
    return {
      kind: 'launchagent-candidate',
      transactionId: TX_ID,
      role: 'controller',
      sha256: CANDIDATE_SHA256,
      ...overrides,
    };
  }

  test('createPlistValidator：production 零依赖；ForTest spy 证明 plutil -lint 契约', async () => {
    assert.equal(createPlistValidator.length, 0);
    const production = createPlistValidator();
    assert.equal(typeof production.validate, 'function');

    const resolvedCandidatePath = `${join(tmpdir(), 'linke-candidate-never-touched')}/candidate.plist`;
    const calls = [];
    const execFile = async (file, args, options) => {
      calls.push({
        file,
        args: [...args],
        options: { ...options },
      });
      return { stdout: `${resolvedCandidatePath}: OK\n` };
    };
    const resolveCandidate = (ref) => {
      assert.deepEqual(ref.kind, 'launchagent-candidate');
      return resolvedCandidatePath;
    };

    const validator = createPlistValidatorForTest({ resolveCandidate, execFile });
    const ref = Object.freeze(validCandidateRef());
    const ok = await validator.validate(ref);
    assert.deepEqual(ok, { valid: true, outcome: 'valid' });
    assertDeepFrozen(ok, 'plistValid');
    assertExactKeys(ok, ['valid', 'outcome']);
    assertNoLeakage(ok, [resolvedCandidatePath, CANARY_PATH], 'plist ok');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, '/usr/bin/plutil');
    assert.deepEqual(calls[0].args, ['-lint', resolvedCandidatePath]);
    assert.equal(calls[0].options.timeout, PLUTIL_TIMEOUT_MS);
    assert.equal(calls[0].options.maxBuffer, PLUTIL_MAX_BUFFER_BYTES);
    assert.notEqual(calls[0].options.shell, true);
  });

  test('createPlistValidatorForTest：lint 失败 → {valid:false,outcome:invalid}；非法 ref / 泄漏检查', async () => {
    const resolvedCandidatePath = `/tmp/linke-plutil-${CANARY_PATH.split('/').pop()}`;
    const execFileFail = async () => {
      const err = new Error(`${resolvedCandidatePath}: ${CANARY_STDERR}`);
      err.code = 1;
      err.stdout = CANARY_STDOUT;
      err.stderr = `${resolvedCandidatePath}: invalid object for key\n`;
      throw err;
    };
    const validator = createPlistValidatorForTest({
      resolveCandidate: () => resolvedCandidatePath,
      execFile: execFileFail,
    });
    const bad = await validator.validate(validCandidateRef({ role: 'scheduler' }));
    assert.deepEqual(bad, { valid: false, outcome: 'invalid' });
    assertDeepFrozen(bad, 'plistInvalid');
    assertNoLeakage(bad, [resolvedCandidatePath, CANARY_STDOUT, CANARY_STDERR], 'plist bad');

    // 拒绝 path 直传 / unknown key / accessor
    await assertRejectsCode(
      validator.validate({
        kind: 'launchagent-candidate',
        transactionId: TX_ID,
        role: 'controller',
        sha256: CANDIDATE_SHA256,
        path: CANARY_PATH,
      }),
      CODE_INVALID,
    );
    await assertRejectsCode(validator.validate(null), CODE_INVALID);
    await assertRejectsCode(
      validator.validate(validCandidateRef({ role: 'manifest' })),
      CODE_INVALID,
    );

    let hits = 0;
    await assertRejectsCode(
      validator.validate(withAccessor(validCandidateRef(), 'x', () => {
        hits += 1;
      })),
      CODE_INVALID,
    );
    assert.equal(hits, 0);

    assertThrowsCode(
      () => createPlistValidatorForTest(withOwnData({
        resolveCandidate: () => resolvedCandidatePath,
        execFile: async () => ({}),
      }, 'extra', 1)),
      CODE_INVALID,
    );
  });

  // =========================================================================
  // 10) createLoopbackHealthChecker (+ ForTest)
  // =========================================================================

  test('createLoopbackHealthCheckerForTest：仅 port；只请求 127.0.0.1/health；投影 {statusCode,ready,count}', async () => {
    assert.equal(createLoopbackHealthChecker.length, 0);

    const requests = [];
    let nowMs = 1_000_000;
    const request = async (url, options) => {
      requests.push({ url, options: options ? { ...options } : options });
      assert.equal(url, 'http://127.0.0.1:18456/health');
      return {
        statusCode: 200,
        body: Buffer.from(JSON.stringify({ ready: true, count: 3, secret: CANARY_BODY })),
      };
    };
    const checker = createLoopbackHealthCheckerForTest({
      request,
      now: () => nowMs,
    });

    const ok = await checker.check({ port: 18456 });
    assert.deepEqual(ok, { statusCode: 200, ready: true, count: 3 });
    assertDeepFrozen(ok, 'healthOk');
    assertExactKeys(ok, ['statusCode', 'ready', 'count']);
    assertNoLeakage(ok, [CANARY_BODY, '127.0.0.1', 'http://'], 'health ok');

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://127.0.0.1:18456/health');
    // caller 不得控制 host/url/path/timeout/body
    assert.equal(Object.hasOwn(requests[0].options ?? {}, 'body'), false);
    // 精确断言：传给 request 的 timeout/deadline 固定且不超过 30000ms
    {
      const reqOptions = requests[0].options ?? {};
      const timeoutCandidates = [
        reqOptions.timeout,
        reqOptions.timeoutMs,
        reqOptions.deadline,
        reqOptions.deadlineMs,
      ].filter((value) => value !== undefined && value !== null);
      assert.ok(
        timeoutCandidates.length >= 1,
        'health request must receive fixed timeout/deadline configuration',
      );
      for (const value of timeoutCandidates) {
        assert.equal(
          value,
          HEALTH_ABSOLUTE_CEILING_MS,
          'health request timeout/deadline must be fixed at 30000ms',
        );
        assert.equal(
          value <= HEALTH_ABSOLUTE_CEILING_MS,
          true,
          'health request timeout/deadline must not exceed 30000ms',
        );
      }
    }

    // 拒绝额外字段；caller 不能覆盖 timeout
    await assertRejectsCode(
      checker.check({ port: 18456, host: 'evil.example', url: 'http://evil' }),
      CODE_INVALID,
    );
    await assertRejectsCode(checker.check({ port: 18456, path: '/admin' }), CODE_INVALID);
    await assertRejectsCode(checker.check({ port: 18456, timeout: 1 }), CODE_INVALID);
    await assertRejectsCode(checker.check({ port: '18456' }), CODE_INVALID);
    await assertRejectsCode(checker.check({ port: 0 }), CODE_INVALID);
    await assertRejectsCode(checker.check({ port: 70000 }), CODE_INVALID);

    let hits = 0;
    await assertRejectsCode(
      checker.check(withAccessor({ port: 18456 }, 'url', () => {
        hits += 1;
      })),
      CODE_INVALID,
    );
    assert.equal(hits, 0);
  });

  test('createLoopbackHealthCheckerForTest：timeout/network/malformed 与 30s ceiling → 闭合 failure shape', async () => {
    const failureShape = { statusCode: null, ready: false, count: null };

    // network error
    {
      const checker = createLoopbackHealthCheckerForTest({
        request: async () => {
          throw new Error(`connect ECONNREFUSED ${CANARY_BODY}`);
        },
        now: () => 0,
      });
      const out = await checker.check({ port: 9 });
      assert.deepEqual(out, failureShape);
      assertDeepFrozen(out, 'healthNetwork');
      assertNoLeakage(out, [CANARY_BODY], 'network failure');
    }

    // malformed body
    {
      const checker = createLoopbackHealthCheckerForTest({
        request: async () => ({
          statusCode: 200,
          body: Buffer.from(`not-json ${CANARY_BODY}`),
        }),
        now: () => 0,
      });
      const out = await checker.check({ port: 9 });
      assert.deepEqual(out, failureShape);
      assertNoLeakage(out, [CANARY_BODY], 'malformed body');
    }

    // non-ready status
    {
      const checker = createLoopbackHealthCheckerForTest({
        request: async () => ({
          statusCode: 503,
          body: Buffer.from(JSON.stringify({ ready: false, count: 0, detail: CANARY_BODY })),
        }),
        now: () => 0,
      });
      const out = await checker.check({ port: 9 });
      // 非 200：允许带回 statusCode，ready 固定 false，count 不回显 body
      assert.equal(out.ready, false);
      assert.equal(out.statusCode, 503);
      assert.equal(out.count, null);
      assertDeepFrozen(out, 'health503');
      assertNoLeakage(out, [CANARY_BODY], '503');
    }

    // absolute ceiling 30000ms：now 跨过 ceiling → fail closed，且不得无限等待
    {
      let nowMs = 10_000;
      let requestCalls = 0;
      const checker = createLoopbackHealthCheckerForTest({
        request: async () => {
          requestCalls += 1;
          nowMs += HEALTH_ABSOLUTE_CEILING_MS + 1;
          throw new Error('should be cut by ceiling');
        },
        now: () => nowMs,
      });
      const out = await checker.check({ port: 9 });
      assert.deepEqual(out, failureShape);
      assert.ok(requestCalls <= 1, 'ceiling must bound request attempts');
    }

    // body cap：200 + 合法 JSON + 大量 trailing whitespace，总长 > 64KiB → fail closed
    // 证明不是仅依赖 JSON.parse 恰好失败（JSON.parse 允许尾随空白）
    {
      const jsonCore = JSON.stringify({ ready: true, count: 1 });
      assert.equal(JSON.parse(jsonCore + ' '.repeat(16)).ready, true);
      const oversizePad = ' '.repeat(64 * 1024 - Buffer.byteLength(jsonCore, 'utf8') + 1);
      const body = Buffer.from(jsonCore + oversizePad, 'utf8');
      assert.equal(body.length > 64 * 1024, true, 'fixture body must exceed 64KiB');
      // 对照：去掉长度门后 JSON.parse 仍成功，故 cap 不得只靠 parse 失败
      assert.equal(JSON.parse(body.toString('utf8')).count, 1);

      const checker = createLoopbackHealthCheckerForTest({
        request: async () => ({
          statusCode: 200,
          body,
        }),
        now: () => 1_000_000,
      });
      const out = await checker.check({ port: 9 });
      assert.deepEqual(out, failureShape);
      assertDeepFrozen(out, 'healthBodyCap');
      assertNoLeakage(out, [CANARY_BODY, jsonCore], 'body cap oversize');
    }

    // clock 倒退：end < start 必须 fail closed（不得把负间隔当成“未超 ceiling”）
    {
      let tick = 0;
      const checker = createLoopbackHealthCheckerForTest({
        request: async () => ({
          statusCode: 200,
          body: Buffer.from(JSON.stringify({ ready: true, count: 2 })),
        }),
        now: () => {
          tick += 1;
          return tick === 1 ? 5_000_000 : 4_999_000;
        },
      });
      const out = await checker.check({ port: 9 });
      assert.deepEqual(out, failureShape);
      assertDeepFrozen(out, 'healthClockRegression');
    }
  });

  // =========================================================================
  // 11) 补充：scheduler inspect 合法组合；ForTest 命名与 production 对照
  // =========================================================================

  test('inspect 允许 launchAgents+scheduler 与 metadata+manifest；禁止 prefix collision basename', async (t) => {
    await withTempRoot(t, async (tempRoot) => {
      const launchAgentsDir = join(tempRoot, 'LaunchAgents');
      const metadataDir = join(tempRoot, 'metadata');
      const schedBytes = Buffer.from('scheduler-v1', 'utf8');
      const manifestBytes = Buffer.from('{"schemaVersion":1}', 'utf8');
      const schedPath = await seedRegularFile(
        launchAgentsDir,
        FILENAME_SCHEDULER,
        schedBytes,
        0o600,
      );
      const manifestPath = await seedRegularFile(
        metadataDir,
        FILENAME_MANIFEST,
        manifestBytes,
        0o600,
      );
      const stSched = await lstat(schedPath);
      const stManifest = await lstat(manifestPath);
      // 统一 uid：两文件应同属测试用户
      assert.equal(stSched.uid, stManifest.uid);

      const account = {
        uid: stSched.uid,
        roots: {
          launchAgents: { rootId: ROOT_LAUNCH_AGENTS, canonicalPath: launchAgentsDir },
          metadata: { rootId: ROOT_METADATA, canonicalPath: metadataDir },
        },
      };
      const { fs } = createCountingFs();
      const inspector = createLaunchAgentHostInspectorForTest({
        accountResolver: fixedAccountResolver(account),
        fs,
      });

      const schedId = await inspector.inspect({
        rootId: ROOT_LAUNCH_AGENTS,
        basename: FILENAME_SCHEDULER,
      });
      assert.equal(schedId.sha256, sha256Hex(schedBytes));
      assert.equal(schedId.device, String(stSched.dev));
      assert.equal(schedId.inode, String(stSched.ino));

      const manifestId = await inspector.inspect({
        rootId: ROOT_METADATA,
        basename: FILENAME_MANIFEST,
      });
      assert.equal(manifestId.sha256, sha256Hex(manifestBytes));

      // prefix collision：固定 basename 的前缀/后缀变体
      for (const basename of [
        `${FILENAME_SCHEDULER}.bak`,
        ` ${FILENAME_SCHEDULER}`,
        `${FILENAME_SCHEDULER} `,
        `com.linke.scheduler.plist\0`,
        'com.linke.scheduler',
      ]) {
        await assertRejectsCode(
          inspector.inspect({ rootId: ROOT_LAUNCH_AGENTS, basename }),
          CODE_INVALID,
        );
      }
    });
  });

  test('Task 3 诚实边界：不声称 coordinator/receipt/journal 全流水线已验证', () => {
    // 本文件仅冻结 host-adapter 单元边界（inspect/parser/validator/disabled/health）。
    // 以下导出必须不存在于 host-adapter（防伪造“已验证全流水线”）。
    for (const name of [
      'createLaunchAgentLifecycleCoordinator',
      'installLaunchAgents',
      'publishReceipt',
      'appendJournal',
      'createLaunchctlRunner',
      'createRealLaunchctlRunner',
      'createLaunchctlRunnerForTest',
    ]) {
      assert.equal(
        hostAdapter[name],
        undefined,
        `${name} must not be exported from host-adapter in Task 3 unit boundary`,
      );
    }
  });
}
