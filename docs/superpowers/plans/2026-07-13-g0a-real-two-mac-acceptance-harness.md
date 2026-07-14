# G0a Real Two-Mac Acceptance Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个显式启用、测试专用、secret-safe 的真实双 Mac 验收 harness，证明 G0a 的 rotate 旧 token 拒绝、current/N-1/N-2、revoke、restart 与 fingerprint replacement 边界。

**Architecture:** Common 模块负责显式 gate、私密文件、严格 schema、状态机和脱敏输出；Controller runner 通过真实 loopback management route 驱动 production Controller；Endpoint runner 通过 production device client 与 raw pinned compatibility request 驱动第二台 Mac。所有外部副作用前先写 intent state，跨机结果只由 `0600` sanitized receipt 推进。

**Tech Stack:** Node.js ESM、`node:test`、macOS Keychain `/usr/bin/security`、Node HTTP/HTTPS、现有 `startController`、`KeychainStore`、`DeviceCredentialStore` 和 device client exports。

## Global Constraints

- 主要新增 `test/helpers/g0a-real-common.js`、`test/helpers/g0a-real-controller-runner.js`、`test/helpers/g0a-real-endpoint-runner.js`、`test/g0a-real-acceptance.test.js`，并最小修改 `README.md` 与 `test/readme.test.js`。
- 默认不修改 `src/`、`package.json`、版本号、Gold 状态或生产 API；Task 4.9 是唯一例外，只修复 fresh review 已用 synthetic temp 稳定复现的 production dataDir symlink/no-follow 写入安全缺口，不扩大功能面。
- 只有 `LINKE_REAL_G0A_ACCEPTANCE === 'enabled'` 才允许真实 Keychain/network/file cleanup 副作用；import helper 必须零副作用。
- 真实 Controller config、state、bundle、receipt 必须是非 symlink 普通文件且 mode `0600`；读取使用 `O_NOFOLLOW` 并在已打开 fd 上复核 mode/schema。
- bundle/token/code/fingerprint/URL/host/IP/路径/Keychain service/item/原始错误不得进入 stdout、stderr、报告或 Git；management token 只在 Controller 进程内存。
- Controller config 使用显式私网 IP literal 与固定非零 Agent port；不自动发现网卡，不读取或修改 `~/.ssh`。
- initial bundle 生成 current、N-1、N-2 三个 code；pre-revoke 后原子转换为无 code/TTL 的 `initial-consumed` continuation bundle；reenrollment bundle 只生成 current 一个 code。
- current heartbeat 使用 production `heartbeatDevice()`；N-1 heartbeat 使用 `requestPinnedJson()` 且 body protocolVersion 为 current-1；N-2 必须是 HTTP 426 / `device-protocol-unsupported`。
- rotate old token 只保留在当前函数局部内存；rotate 后立即用它请求 heartbeat 并严格要求 `device-token-invalid`。
- fingerprint replacement 只操作专用 Keychain service 下 `controller-tls-private-key` 和专用 data directory 下 `tls/controller-cert.pem`；禁止 wildcard、扫描和 production service。
- 自动测试只使用临时目录、内存 adapter 与合成 secret，不创建真实报告，不把 mock 结果描述成真实 PASS。
- Grok implementer 是唯一代码写入者，不执行 commit/push；Qwen 只读抗辩；Grok fresh reviewer 不改文件；Codex PM 验证后执行已授权 commit/push。

## File Map

- Create `test/helpers/g0a-real-common.js` — gate、schema、`0600` 原子 I/O、state transition、receipt、redaction 与固定文件名。
- Create `test/helpers/g0a-real-controller-runner.js` — Controller 生命周期、真实 management HTTP、bundle、stdin command 与 identity replacement。
- Create `test/helpers/g0a-real-endpoint-runner.js` — Endpoint phase、production client/raw compatibility request、Keychain state、receipt 与 cleanup。
- Create `test/g0a-real-acceptance.test.js` — Common/Controller/Endpoint 的 RED→GREEN 契约与 fault injection。
- Modify `README.md` — test-only 操作边界、SSH alias、真实门仍 BLOCKED。
- Modify `test/readme.test.js` — 锁定 README 不误报 Gold。
- Create `src/safe-data-files.js` — production dataDir 相对路径、ancestor、`O_NOFOLLOW`、fd 复核、原子发布与 append/read 安全原语。
- Modify `src/device-registry.js`、`src/audit-log.js`、`src/storage.js`、`src/tls-identity-store.js`、`src/controller-runtime.js` — 仅把已复现写路径接入安全原语。
- Modify production 对应 tests — registry/audit/repo/TLS symlink RED→GREEN 与非回退测试。

---

### Task 1: Common Secret-Safe Primitives and State Machine

**Files:**
- Create: `test/helpers/g0a-real-common.js`
- Create: `test/g0a-real-acceptance.test.js`

**Interfaces:**
- Consumes: `ERROR_CODES`、`LinkeError`、`assertRegisteredErrorCode` from `src/error-codes.js`；`isPrivateAgentHost` from `src/controller-runtime.js`；`DEVICE_PROTOCOL_VERSION`、`MIN_DEVICE_PROTOCOL_VERSION` from `src/device-protocol.js`。
- Produces: `assertRealGate(env)`、`assertDedicatedRunDirectory(runDir)`、`atomicWritePrivateJson(path, value, deps)`、`readPrivateJson(path, validator, deps)`、`validateControllerConfig(value)`、`validateBundle(value, options)`、`validateReceipt(value, options)`、`validateControllerState(value, { runDir })`、`validateEndpointState(value, { runDir })`、`transitionControllerState(state, command)`、`transitionEndpointState(state, command)`、`isIdempotentControllerCommand(state, command)`、`isIdempotentEndpointPhase(state, phase)`、`resolveAllowlistedPath(runDir, relativePath)`、`assertSafeCleanupTarget(runDir, relativePath, expectedType, deps)`、`assertNoSensitiveData(value)`、`serializeSanitizedResult(result)`、`sanitizedFailure(role, phase, error, now)`。
- Produces constants: `REAL_GATE_ENV`、`REAL_GATE_VALUE`、`SCHEMA_VERSION`、固定 filenames、phase/command/state sets、`CONTROLLER_TLS_KEY_ITEM`、`CONTROLLER_CERT_RELATIVE_PATH`。

- [ ] **Step 1: 写 Common RED 测试**

在 `test/g0a-real-acceptance.test.js` 建立以下 imports 与 fixture；所有测试数据必须是合成值：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, lstat, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { isPrivateAgentHost } from '../src/controller-runtime.js';
import {
  DEVICE_PROTOCOL_VERSION,
  MIN_DEVICE_PROTOCOL_VERSION,
} from '../src/device-protocol.js';
import {
  assertRealGate,
  assertDedicatedRunDirectory,
  assertSafeCleanupTarget,
  atomicWritePrivateJson,
  readPrivateJson,
  validateControllerConfig,
  validateBundle,
  validateReceipt,
  validateControllerState,
  validateEndpointState,
  transitionControllerState,
  transitionEndpointState,
  assertNoSensitiveData,
  serializeSanitizedResult,
  sanitizedFailure,
  CONTROLLER_STATES,
} from './helpers/g0a-real-common.js';

async function privateDir() {
  const root = await mkdtemp(join(tmpdir(), 'linke-g0a-common-'));
  await chmod(root, 0o700);
  return root;
}

describe('G0a real common gate and private files', () => {
  it('requires the exact real acceptance gate', () => {
    assert.throws(() => assertRealGate({}), (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID);
    assert.throws(() => assertRealGate({ LINKE_REAL_G0A_ACCEPTANCE: 'ENABLED' }));
    assert.equal(assertRealGate({ LINKE_REAL_G0A_ACCEPTANCE: 'enabled' }), true);
  });

  it('accepts only an exact private-IP fixed-port controller config', () => {
    assert.deepEqual(validateControllerConfig({
      schemaVersion: 1, agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0,
    }), {
      schemaVersion: 1, agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0,
    });
    for (const invalid of [
      { schemaVersion: 1, agentHost: '127.0.0.1', agentPort: 3443, managementPort: 0 },
      { schemaVersion: 1, agentHost: '10.0.0.10', agentPort: 0, managementPort: 0 },
      { schemaVersion: 1, agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0, token: 'synthetic' },
    ]) assert.throws(() => validateControllerConfig(invalid));
  });

  it('writes atomic 0600 JSON and rejects symlink, 0644 and unknown schema fields', async () => {
    const root = await privateDir();
    const target = join(root, 'bundle.json');
    await atomicWritePrivateJson(target, { schemaVersion: 1, runId: 'run-synthetic' });
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    assert.deepEqual(await readPrivateJson(target, (value) => value), {
      schemaVersion: 1,
      runId: 'run-synthetic',
    });

    await chmod(target, 0o644);
    await assert.rejects(readPrivateJson(target, (value) => value));
    const link = join(root, 'link.json');
    await symlink(target, link);
    await assert.rejects(readPrivateJson(link, (value) => value));
  });
});

describe('G0a real common schemas, transitions and output', () => {
  it('rejects expired, cross-run and unknown-field bundles', () => {
    const base = {
      schemaVersion: 1,
      kind: 'reenrollment',
      runId: 'run-synthetic',
      agentUrl: 'https://10.0.0.10:3443',
      tlsFingerprint: 'a'.repeat(64),
      current: { deviceId: 'device-synthetic', enrollmentCode: 'b'.repeat(43) },
      endpointKeychainService: 'com.linke.test.synthetic',
      createdAt: '2030-01-01T00:00:00.000Z',
      expiresAt: '2030-01-01T00:10:00.000Z',
    };
    assert.throws(() => validateBundle({ ...base, extra: true }, {
      runId: 'run-synthetic', now: new Date('2030-01-01T00:01:00.000Z'),
    }));
    assert.throws(() => validateBundle(base, {
      runId: 'different-run', now: new Date('2030-01-01T00:01:00.000Z'),
    }));
    assert.throws(() => validateBundle(base, {
      runId: 'run-synthetic', now: new Date('2030-01-01T00:11:00.000Z'),
    }));
  });

  it('uses explicit intent states and refuses skipped transitions', () => {
    assert.equal(transitionControllerState('controller-ready', 'prepare'), 'preparing-bundle');
    assert.equal(transitionControllerState('preparing-bundle', 'prepare-complete'), 'bundle-prepared');
    assert.equal(transitionControllerState('endpoint-pre-revoke-passed', 'revoke-current'), 'revoking-current');
    assert.equal(transitionControllerState('preparing-bundle', 'stop'), 'cleaning');
    assert.equal(transitionEndpointState('pre-revoke-running', 'cleanup'), 'cleaning');
    assert.throws(() => transitionControllerState('controller-ready', 'revoke-current'));
    assert.ok(CONTROLLER_STATES.includes('replacing-fingerprint'));
  });

  it('allows only registered sanitized result fields and rejects secret-like nested values', () => {
    const safe = serializeSanitizedResult({
      role: 'endpoint', phase: 'pre-revoke', status: 'PASS',
      code: ERROR_CODES.DEVICE_TOKEN_INVALID, count: 2,
      at: '2030-01-01T00:00:00.000Z',
    });
    assert.doesNotThrow(() => JSON.parse(safe));
    for (const value of [
      '/private/synthetic/path', 'https://192.0.2.10:3443', 'a'.repeat(64),
      '-----BEGIN PRIVATE KEY-----', 'synthetic-token-value',
    ]) {
      assert.throws(() => assertNoSensitiveData({ nested: { note: value } }));
    }

    const failure = sanitizedFailure(
      'controller', 'prepare', new Error('raw path /private/synthetic'),
      () => new Date('2030-01-01T00:00:00.000Z'),
    );
    assert.deepEqual(failure, {
      role: 'controller', phase: 'prepare', status: 'FAIL',
      code: ERROR_CODES.DEVICE_INTERNAL_ERROR,
      at: '2030-01-01T00:00:00.000Z',
    });
    assert.doesNotMatch(JSON.stringify(failure), /private|synthetic/);
  });

  it('requires a matching PASS receipt before state advancement', () => {
    const receipt = {
      schemaVersion: 1,
      runId: 'run-synthetic',
      phase: 'pre-revoke',
      status: 'PASS',
      count: 1,
      at: '2030-01-01T00:00:00.000Z',
    };
    assert.deepEqual(validateReceipt(receipt, {
      runId: 'run-synthetic', phase: 'pre-revoke', requirePass: true,
    }), receipt);
    assert.throws(() => validateReceipt({ ...receipt, status: 'BLOCKED' }, {
      runId: 'run-synthetic', phase: 'pre-revoke', requirePass: true,
    }));
    assert.doesNotThrow(() => validateReceipt({
      schemaVersion: 1, runId: 'run-synthetic', phase: 'pre-revoke',
      status: 'PASS', at: '2030-01-01T00:00:00.000Z',
    }, { runId: 'run-synthetic', phase: 'pre-revoke', requirePass: true }));
  });
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-name-pattern="G0a real common" test/g0a-real-acceptance.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `g0a-real-common.js`。

- [ ] **Step 3: 实现 Common 模块**

实现以下固定导出与规则；validator 必须手写 exact-key checks，不能用会保留未知字段的 object spread：

```js
export const REAL_GATE_ENV = 'LINKE_REAL_G0A_ACCEPTANCE';
export const REAL_GATE_VALUE = 'enabled';
export const SCHEMA_VERSION = 1;
export const CONTROLLER_CONFIG_FILE = 'controller-config.json';
export const RUN_MARKER_FILE = '.linke-g0a-real-run.json';
export const CONTROLLER_STATE_FILE = 'controller-state.json';
export const ENDPOINT_STATE_FILE = 'endpoint-state.json';
export const INITIAL_BUNDLE_FILE = 'bundle-initial.json';
export const REENROLLMENT_BUNDLE_FILE = 'bundle-reenrollment.json';
export const CONTROLLER_TLS_KEY_ITEM = 'controller-tls-private-key';
export const CONTROLLER_CERT_RELATIVE_PATH = 'tls/controller-cert.pem';

export const CONTROLLER_STATES = Object.freeze([
  'initialized', 'controller-ready', 'preparing-bundle', 'bundle-prepared',
  'endpoint-pre-revoke-passed', 'revoking-current', 'current-revoked',
  'endpoint-post-revoke-passed', 'restarting-controller', 'controller-restarted',
  'restart-passed', 'replacing-fingerprint', 'identity-deleted',
  'identity-regenerated', 'fingerprint-replaced',
  'preparing-reenrollment', 'reenrollment-bundle-prepared',
  'fingerprint-mismatch-passed', 'reenrollment-passed', 'cleaning', 'cleaned',
]);

export const ENDPOINT_STATES = Object.freeze([
  'initialized', 'pre-revoke-running', 'pre-revoke-passed',
  'post-revoke-running', 'post-revoke-passed',
  'post-restart-running', 'post-restart-passed',
  'post-fingerprint-change-running', 'post-fingerprint-change-passed',
  'reenroll-running', 'reenroll-passed', 'cleaning', 'cleaned',
]);

export const IDEMPOTENT_CONTROLLER_COMMANDS = Object.freeze({
  'bundle-prepared:prepare': true,
  'endpoint-pre-revoke-passed:ack-pre-revoke': true,
  'current-revoked:revoke-current': true,
  'endpoint-post-revoke-passed:ack-post-revoke': true,
  'controller-restarted:restart': true,
  'restart-passed:ack-post-restart': true,
  'fingerprint-replaced:replace-identity-confirmed': true,
  'reenrollment-bundle-prepared:prepare-reenrollment': true,
  'fingerprint-mismatch-passed:ack-post-fingerprint-change': true,
  'reenrollment-passed:ack-reenroll': true,
  'cleaned:stop': true,
});

export const IDEMPOTENT_ENDPOINT_PHASES = Object.freeze({
  'pre-revoke-passed:pre-revoke': true,
  'post-revoke-passed:post-revoke': true,
  'post-restart-passed:post-restart': true,
  'post-fingerprint-change-passed:post-fingerprint-change': true,
  'reenroll-passed:reenroll': true,
  'cleaned:cleanup': true,
});

const ENDPOINT_TRANSITIONS = Object.freeze({
  'initialized:begin-pre-revoke': 'pre-revoke-running',
  'pre-revoke-running:complete-pre-revoke': 'pre-revoke-passed',
  'pre-revoke-passed:begin-post-revoke': 'post-revoke-running',
  'post-revoke-running:complete-post-revoke': 'post-revoke-passed',
  'post-revoke-passed:begin-post-restart': 'post-restart-running',
  'post-restart-running:complete-post-restart': 'post-restart-passed',
  'post-restart-passed:begin-post-fingerprint-change': 'post-fingerprint-change-running',
  'post-fingerprint-change-running:complete-post-fingerprint-change': 'post-fingerprint-change-passed',
  'post-fingerprint-change-passed:begin-reenroll': 'reenroll-running',
  'reenroll-running:complete-reenroll': 'reenroll-passed',
  'cleaning:cleanup-complete': 'cleaned',
});

const TRANSITIONS = Object.freeze({
  'initialized:start': 'controller-ready',
  'controller-ready:prepare': 'preparing-bundle',
  'preparing-bundle:prepare-complete': 'bundle-prepared',
  'bundle-prepared:ack-pre-revoke': 'endpoint-pre-revoke-passed',
  'endpoint-pre-revoke-passed:revoke-current': 'revoking-current',
  'revoking-current:revoke-complete': 'current-revoked',
  'current-revoked:ack-post-revoke': 'endpoint-post-revoke-passed',
  'endpoint-post-revoke-passed:restart': 'restarting-controller',
  'restarting-controller:restart-complete': 'controller-restarted',
  'controller-restarted:ack-post-restart': 'restart-passed',
  'restart-passed:replace-identity-confirmed': 'replacing-fingerprint',
  'replacing-fingerprint:identity-delete-complete': 'identity-deleted',
  'identity-deleted:identity-regenerate-complete': 'identity-regenerated',
  'identity-regenerated:replacement-complete': 'fingerprint-replaced',
  'fingerprint-replaced:prepare-reenrollment': 'preparing-reenrollment',
  'preparing-reenrollment:prepare-reenrollment-complete': 'reenrollment-bundle-prepared',
  'reenrollment-bundle-prepared:ack-post-fingerprint-change': 'fingerprint-mismatch-passed',
  'fingerprint-mismatch-passed:ack-reenroll': 'reenrollment-passed',
  'cleaning:cleanup-complete': 'cleaned',
});

export function assertRealGate(env = process.env) {
  if (env?.[REAL_GATE_ENV] !== REAL_GATE_VALUE) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  return true;
}

export function transitionControllerState(state, command) {
  if (command === 'stop' && CONTROLLER_STATES.includes(state) && state !== 'cleaned') return 'cleaning';
  const next = TRANSITIONS[`${state}:${command}`];
  if (!next) throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 409 });
  return next;
}

export function transitionEndpointState(state, command) {
  if (command === 'cleanup' && ENDPOINT_STATES.includes(state) && state !== 'cleaned') return 'cleaning';
  const key = `${state}:${command}`;
  const next = ENDPOINT_TRANSITIONS[key];
  if (!next) throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 409 });
  return next;
}

export function isIdempotentControllerCommand(state, command) {
  return IDEMPOTENT_CONTROLLER_COMMANDS[`${state}:${command}`] === true;
}

export function isIdempotentEndpointPhase(state, phase) {
  return IDEMPOTENT_ENDPOINT_PHASES[`${state}:${phase}`] === true;
}
```

`atomicWritePrivateJson()` 的固定顺序是 `open(temp, O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, 0600)` → `writeFile(JSON + newline)` → `sync()` → `chmod(0600)` → `close()` → `rename()` → 打开 parent directory 并 `sync()`。失败时只 unlink 本次随机 temp；不得 unlink target。

`readPrivateJson()` 固定顺序是 `lstat` 拒绝 symlink/非普通文件/非 0600 → `open(O_RDONLY|O_NOFOLLOW)` → `handle.stat()` 再复核 → bounded read（最大 64 KiB）→ JSON parse → validator。任何 fs/JSON/schema 错误统一抛 `LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID)`，不保留 raw cause/message。

`validateControllerConfig()` 必须复用 production `isPrivateAgentHost()` 校验 agentHost，并额外要求真实 Agent port 是 1..65535；不得复制一份可能漂移的 RFC1918/ULA 规则。`resolveAllowlistedPath(runDir, relativePath)` 必须拒绝 absolute、空字符串、NUL、空 segment、`.` 和 `..` segment，再用 `resolve(runDir, relativePath)` + `relative(runDir, resolved)` 证明目标仍在 root 内。`validateControllerState(value, { runDir })` 和 `validateEndpointState(value, { runDir })` 对每个 cleanup file/directory 调用它；cleanup 执行前通过 `assertSafeCleanupTarget()` 再次 resolve，并逐级 `lstat` 已存在 ancestor，任何 symlink/非预期 file-vs-directory 类型固定 BLOCKED。

`assertSafeCleanupTarget(runDir, relativePath, expectedType, { lstatImpl = lstat } = {})` 先调用 `resolveAllowlistedPath()`，再从 runDir 的第一个 child segment 逐级 `lstat`。既有 ancestor 必须是非 symlink directory；既有 target 必须是非 symlink 且匹配 `expectedType === 'file' | 'directory'`；ENOENT 只对 target/尚未创建的后续 segments 视为幂等安全。任何其它 fs 结果统一映射 `DEVICE_REQUEST_INVALID`，不保留 raw error。

`assertNoSensitiveData()` 递归检查 plain object/array/scalar，拒绝敏感 key、URL/IP、路径分隔符、精确 `/^[0-9a-f]{64}$/i`、PEM marker，以及包含 token/fingerprint/enrollment/keychain/private/secret/password 的字符串；只在测试合成对象与 sanitized 输出前使用，不对 bundle 做会回显值的报错。`serializeSanitizedResult()` 只允许 `role`、`phase`、`status`、`code`、`count`、`flag`、`at`、`promptHandled`；`code` 可省略，存在时必须过 `assertRegisteredErrorCode()` 且不套用 64-hex 检查。未知 key、非有限整数和嵌套 object/array 全部拒绝。`validateReceipt()` 中 `count`/`flag`/`code` 均可省略；存在时分别必须是非负有限整数、boolean、registered code。

- [ ] **Step 4: 运行 Common GREEN 与泄漏扫描**

Run: `node --test --test-name-pattern="G0a real common" test/g0a-real-acceptance.test.js`

Expected: PASS。

Run: `rg -n "console\.(log|error)|process\.env\[[^]]*(TOKEN|CODE|KEY)|cause:|\.stack|JSON\.stringify\((bundle|state)" test/helpers/g0a-real-common.js`

Expected: no matches。

---

### Task 2: Controller Runner, Management Route and Receipt Journal

**Files:**
- Modify: `test/helpers/g0a-real-common.js`
- Create: `test/helpers/g0a-real-controller-runner.js`
- Modify: `test/g0a-real-acceptance.test.js`

**Interfaces:**
- Consumes: Task 1 Common exports、`startController(options)`、`KeychainStore`、Node loopback HTTP。
- Produces: `requestManagementJson(options)`、`createControllerHarness(options)`、`runControllerHarnessMain(options)`。
- `createControllerHarness()` returns `{ start(): Promise<object>, execute(command): Promise<object>, close(): Promise<void>, getState(): object }`。

- [ ] **Step 1: 写 Controller RED 测试**

先增加 imports 与完整 fixture；fake dependencies 只返回合成公开数据，management token 只能由 spy 看到：

```js
import { access } from 'node:fs/promises';
import {
  createControllerHarness,
} from './helpers/g0a-real-controller-runner.js';
import { TlsIdentityStore } from '../src/tls-identity-store.js';
import {
  CONTROLLER_CERT_RELATIVE_PATH,
  CONTROLLER_TLS_KEY_ITEM,
  RUN_MARKER_FILE,
  CONTROLLER_CONFIG_FILE,
} from './helpers/g0a-real-common.js';

function memoryKeychain(initial = new Map(), events = []) {
  return {
    async get(id) {
      events.push(`keychain:get:${id}`);
      if (!initial.has(id)) {
        throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
      }
      return initial.get(id);
    },
    async set(id, value) {
      events.push(`keychain:set:${id}`);
      initial.set(id, value);
    },
    async delete(id) {
      events.push(`keychain:delete:${id}`);
      return initial.delete(id);
    },
  };
}

async function createSyntheticDedicatedRun() {
  const root = await privateDir();
  await atomicWritePrivateJson(join(root, RUN_MARKER_FILE), {
    schemaVersion: 1,
    purpose: 'linke-g0a-real-acceptance',
  });
  await atomicWritePrivateJson(join(root, CONTROLLER_CONFIG_FILE), {
    schemaVersion: 1,
    agentHost: '10.0.0.10',
    agentPort: 3443,
    managementPort: 0,
  });
  return root;
}

function fakeControllerRuntime() {
  return {
    status: {
      managementListening: true,
      agentListening: true,
      tlsFingerprint: 'a'.repeat(64),
    },
    managementServer: { address: () => ({ address: '127.0.0.1', port: 31001 }) },
    agentServer: { address: () => ({ address: '10.0.0.10', port: 3443 }) },
    async close() {},
  };
}

function syntheticControllerState(phase) {
  return {
    schemaVersion: 1,
    purpose: 'linke-g0a-real-acceptance',
    runId: 'run-synthetic',
    phase,
    controllerKeychainService: 'com.linke.test.controller',
    endpointKeychainService: 'com.linke.test.endpoint',
    dataDirectoryName: 'controller-data',
    cleanupFiles: [],
    cleanupDirectories: [],
    currentDeviceId: 'device-current',
    nMinusOneDeviceId: 'device-n-1',
    nMinusTwoDeviceId: 'device-n-2',
  };
}

async function syntheticControllerAt(phase, sinks = {}, { autoStart = true } = {}) {
  const runDir = await createSyntheticDedicatedRun();
  let state = syntheticControllerState(phase);
  const harness = await createControllerHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir,
    readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
    readState: async () => state,
    writeState: async (next) => {
      state = structuredClone(next);
      sinks.events?.push(`state:${next.phase}`);
      sinks.writes?.push({ kind: 'state', phase: next.phase });
    },
    writeBundle: async (_name, value) => sinks.writes?.push({ kind: 'bundle', value }),
    readReceipt: async (phaseName) => {
      sinks.events?.push(`read:${phaseName}`);
      return {
        schemaVersion: 1, runId: state.runId, phase: phaseName,
        status: 'PASS', count: 1, at: '2030-01-01T00:00:00.000Z',
      };
    },
    deleteReceipt: async (phaseName) => sinks.events?.push(`delete:${phaseName}`),
    keychainFactory: () => memoryKeychain(),
    startControllerImpl: async (options) => {
      sinks.starts?.push(options);
      sinks.calls?.push('start-controller');
      return fakeControllerRuntime();
    },
    managementRequest: async (request) => {
      sinks.requests?.push(request);
      if (request.path === '/api/device-revoke') {
        return { statusCode: 200, body: { deviceId: state.currentDeviceId, revoked: true } };
      }
      return {
        statusCode: 201,
        body: {
          deviceId: request.body.deviceId,
          enrollmentCode: 'c'.repeat(43),
          expiresAt: '2030-01-01T00:10:00.000Z',
          agentUrl: 'https://10.0.0.10:3443',
          tlsFingerprint: 'a'.repeat(64),
          protocolVersion: DEVICE_PROTOCOL_VERSION,
        },
      };
    },
  });
  if (autoStart) {
    await harness.start();
    for (const list of [sinks.events, sinks.starts, sinks.calls]) list?.splice(0);
  }
  return harness;
}

async function syntheticStartedController(sinks = {}) {
  return syntheticControllerAt('controller-ready', sinks);
}

async function exerciseTlsIdentityContract() {
  const root = await privateDir();
  let keyItem;
  const values = new Map();
  const keychain = {
    async get(id) {
      keyItem = id;
      if (!values.has(id)) throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
      return values.get(id);
    },
    async set(id, value) { keyItem = id; values.set(id, value); },
    async delete(id) { return values.delete(id); },
  };
  const store = new TlsIdentityStore({ dataDir: join(root, 'tls'), keychain });
  await store.ensure({ host: '10.0.0.10', port: 3443 });
  await access(join(root, CONTROLLER_CERT_RELATIVE_PATH));
  return { keyItem, certRelativePath: CONTROLLER_CERT_RELATIVE_PATH };
}
```

再增加以下测试组：

```js
describe('G0a real controller runner', () => {
  it('persists initialized state before Keychain or listener side effects', async () => {
    const events = [];
    const harness = await createControllerHarness({
      env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
      runDir: await createSyntheticDedicatedRun(),
      readConfig: async () => ({ agentHost: '10.0.0.10', agentPort: 3443, managementPort: 0 }),
      writeState: async (state) => events.push(`state:${state.phase}`),
      keychainFactory: () => { events.push('keychain'); return memoryKeychain(); },
      startControllerImpl: async (options) => {
        events.push('network');
        assert.equal(typeof options.authToken, 'string');
        assert.ok(options.authToken.length >= 32);
        return fakeControllerRuntime();
      },
    });
    await harness.start();
    assert.deepEqual(events.slice(0, 3), ['state:initialized', 'keychain', 'network']);
  });

  it('journals prepare intent, generates exactly three initial codes and never persists admin token', async () => {
    const writes = [];
    const requests = [];
    const harness = await syntheticStartedController({ writes, requests });
    const result = await harness.execute('prepare');
    assert.equal(result.status, 'PASS');
    assert.deepEqual(writes.filter((v) => v.kind === 'state').map((v) => v.phase), [
      'preparing-bundle', 'bundle-prepared',
    ]);
    assert.equal(requests.filter((r) => r.path === '/api/device-enrollment-codes').length, 3);
    assert.doesNotMatch(JSON.stringify(writes), /admin-token-synthetic/);
  });

  it('validates a fixed PASS receipt before ack and writes state before deleting receipt', async () => {
    const events = [];
    const harness = await syntheticControllerAt('bundle-prepared', { events });
    await harness.execute('ack-pre-revoke');
    assert.deepEqual(events, ['read:pre-revoke', 'state:endpoint-pre-revoke-passed', 'delete:pre-revoke']);
  });

  it('does not replay uncertain prepare or revoke intent after a crash', async () => {
    for (const phase of ['preparing-bundle', 'revoking-current']) {
      const calls = [];
      const harness = await syntheticControllerAt(phase, { calls }, { autoStart: false });
      await assert.rejects(harness.start(), (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID);
      assert.deepEqual(calls, []);
    }
  });

  it('restarts on the same data directory and fixed Agent port', async () => {
    const starts = [];
    const harness = await syntheticControllerAt('endpoint-post-revoke-passed', { starts });
    await harness.execute('restart');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].agentPort, 3443);
    assert.equal(harness.getState().phase, 'controller-restarted');
  });

  it('pins internal TLS identifiers with an injected TlsIdentityStore contract test', async () => {
    const observed = await exerciseTlsIdentityContract();
    assert.equal(observed.keyItem, 'controller-tls-private-key');
    assert.equal(observed.certRelativePath, 'tls/controller-cert.pem');
  });
});
```

- [ ] **Step 2: 运行 Controller RED**

Run: `node --test --test-name-pattern="G0a real controller" test/g0a-real-acceptance.test.js`

Expected: FAIL because `g0a-real-controller-runner.js` or its exports do not exist。

- [ ] **Step 3: 实现 Controller runner**

runner 固定依赖注入接口：

```js
export async function createControllerHarness({
  env = process.env,
  runDir = process.cwd(),
  now = () => new Date(),
  randomUuid = randomUUID,
  randomBytesImpl = randomBytes,
  keychainFactory = (service) => new KeychainStore({ service }),
  startControllerImpl = startController,
  managementRequest = requestManagementJson,
  readConfig,
  readState,
  writeState,
  writeBundle,
  readReceipt,
  deleteReceipt,
  deleteFile,
} = {}) {
  assertRealGate(env);
  await assertDedicatedRunDirectory(runDir);
  // 返回闭包对象；构造阶段不得创建 Keychain、listener 或 signal handler。
}
```

`start()` 必须先读取/验证 config，再在无 state 时原子写：

```js
{
  schemaVersion: 1,
  purpose: 'linke-g0a-real-acceptance',
  runId,
  phase: 'initialized',
  controllerKeychainService,
  endpointKeychainService,
  dataDirectoryName: 'controller-data',
  cleanupFiles: [
    'bundle-initial.json', 'bundle-reenrollment.json',
    'receipt-pre-revoke.json', 'receipt-post-revoke.json',
    'receipt-post-restart.json', 'receipt-post-fingerprint-change.json',
    'receipt-reenroll.json',
    'controller-data/device-registry-v1.json',
    'controller-data/device-registry-v1.json.new',
    'controller-data/tls/controller-cert.pem',
    'controller-data/audit/events.jsonl',
    'controller-data/repo/devices/device-current/device.json',
    'controller-data/repo/devices/device-n-1/device.json',
  ],
  cleanupDirectories: [
    'controller-data/repo/devices/device-current',
    'controller-data/repo/devices/device-n-1',
    'controller-data/repo/devices',
    'controller-data/repo',
    'controller-data/audit',
    'controller-data/tls',
    'controller-data',
  ],
  currentDeviceId,
  nMinusOneDeviceId,
  nMinusTwoDeviceId,
}
```

然后才创建专用 `KeychainStore`、32-byte base64url management token 和 `startController()`。只传：同一 data dir、loopback management host、config ports/private host、内存 auth token、dedicated keychain。token 不成为对象公开属性。

Controller cleanup artifact 名称分别锚定 `src/device-registry.js` 的 registry state、`src/tls-identity-store.js` 的 cert、`src/audit-log.js` 的 audit file 和 `src/storage.js` 的 device heartbeat file。未来命名漂移不会静默 PASS：逐项 unlink 后对预期空目录执行 `rmdir`，目录非空固定 BLOCKED，并由 contract/fault test 暴露；禁止为绕过漂移而扫描目录。

`requestManagementJson()` 只允许 loopback address、固定 `/api/device-enrollment-codes`/`/api/device-revoke`/`/api/agent-listener-status`、Bearer token 内存 header、64 KiB response 上限和 10 秒 timeout；任何网络/parse/shape 错误映射为注册 code，不回传 raw error。非 2xx 响应只读取 `{ error }`，该值通过 `assertRegisteredErrorCode()` 才可成为 `LinkeError`；缺失或未注册值固定映射 `DEVICE_REQUEST_INVALID`，不得回显 body。

`execute()` 使用 exact command switch。`prepare` 先写 `preparing-bundle`，通过 management route 为三个预先记录的 device id 签发 code，严格验证 201 response，再写 initial bundle，最后写 `bundle-prepared`。任何中途失败保留 intent state 并返回/抛 sanitized BLOCKED，不自动重放。

`execute()` 在任何 transition 前先调用 `isIdempotentControllerCommand(state.phase, command)`。命中固定幂等表时返回 `{ role: 'controller', phase: command, status: 'PASS', flag: true, at }` 且不重放 network/Keychain；重复 ack 额外允许精确删除同名残留 receipt，ENOENT 视为成功。未命中幂等表才进入 transition；不得把所有历史已完成 command 泛化为幂等。

`revoke-current` 先写 `revoking-current`，只通过 management `/api/device-revoke` 撤销 state.currentDeviceId，验证 200，再写 `current-revoked`。`restart` 先写 `restarting-controller`，close 后以同一 config/data/keychain 重启，再写 `controller-restarted`。

`replace-identity-confirmed` 固定顺序：写 `replacing-fingerprint` → close → `keychain.delete(CONTROLLER_TLS_KEY_ITEM)` → `unlink(join(dataDir, CONTROLLER_CERT_RELATIVE_PATH))` → 无 accept 启动并严格要求 `device-tls-fingerprint-mismatch` → accept=true 启动 → 写 `fingerprint-replaced`。半状态只返回 `device-tls-identity-incomplete`。

`prepare-reenrollment` 只签发 current 一个 code，写 kind=`reenrollment` bundle，再写 `reenrollment-bundle-prepared`。五个 `ack-*` 使用固定 receipt filename，严格 `PASS`，写完成 state 后删除 receipt。

`stop` 可从任一已验证 Controller state 进入 `cleaning`。它先 close runtime，再删除 dedicated controller Keychain item；随后按 `cleanupFiles` 顺序逐项 unlink（ENOENT 视为幂等成功），按 `cleanupDirectories` 顺序逐项 `rmdir` 已知空目录；任何非空目录固定 BLOCKED，不调用 `readdir`/recursive remove。全部完成后写 `cleaned`。

stdin main 逐行只接受固定 command。每次只用 `serializeSanitizedResult()` 向 stdout 写一行 JSON。top-level catch 只写 sanitized result；不得写 `error.message`/`stack`。main 才注册 signal，import 时不注册。

- [ ] **Step 4: 运行 Controller GREEN、contract 与无副作用 import**

Run: `node --test --test-name-pattern="G0a real controller" test/g0a-real-acceptance.test.js`

Expected: PASS。

Run: `node --input-type=module -e "await import('./test/helpers/g0a-real-controller-runner.js')"`

Expected: exit 0, no stdout/stderr, no Keychain/network/file writes。

---

### Task 3: Endpoint Runner and Real Protocol Boundary Phases

**Files:**
- Modify: `test/helpers/g0a-real-common.js`
- Create: `test/helpers/g0a-real-endpoint-runner.js`
- Modify: `test/g0a-real-acceptance.test.js`

**Interfaces:**
- Consumes: production `KeychainStore`、`DeviceCredentialStore`、`enrollDevice`、`heartbeatDevice`、`rotateDeviceToken`、`requestPinnedJson`、protocol constants。
- Produces: `createEndpointHarness(options)`、`runEndpointHarnessMain(options)`。
- `createEndpointHarness()` returns `{ runPhase(phase): Promise<object>, getState(): object }`。

- [ ] **Step 1: 写 Endpoint RED 测试**

先增加 import、bundle/state 和注入 fixture；spy request 只记录合成 label/body，不保存 token 值，断言失败文本不得包含 token：

```js
import { createEndpointHarness } from './helpers/g0a-real-endpoint-runner.js';

function syntheticInitialBundle() {
  return {
    schemaVersion: 1,
    kind: 'initial',
    runId: 'run-synthetic',
    agentUrl: 'https://10.0.0.10:3443',
    tlsFingerprint: 'a'.repeat(64),
    current: { deviceId: 'device-current', enrollmentCode: 'c'.repeat(43) },
    nMinusOne: { deviceId: 'device-n-1', enrollmentCode: 'd'.repeat(43) },
    nMinusTwo: { deviceId: 'device-n-2', enrollmentCode: 'e'.repeat(43) },
    endpointKeychainService: 'com.linke.test.endpoint',
    createdAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:10:00.000Z',
  };
}

function syntheticReenrollmentBundle() {
  return {
    schemaVersion: 1,
    kind: 'reenrollment',
    runId: 'run-synthetic',
    agentUrl: 'https://10.0.0.10:3443',
    tlsFingerprint: 'b'.repeat(64),
    current: { deviceId: 'device-current', enrollmentCode: 'f'.repeat(43) },
    endpointKeychainService: 'com.linke.test.endpoint',
    createdAt: '2030-01-01T00:02:00.000Z',
    expiresAt: '2030-01-01T00:12:00.000Z',
  };
}

function syntheticEndpointState(phase = 'initialized') {
  return {
    schemaVersion: 1,
    purpose: 'linke-g0a-real-acceptance',
    runId: 'run-synthetic',
    phase,
    endpointKeychainService: 'com.linke.test.endpoint',
    credentialItemIds: ['device-token.11111111111111111111111111111111', 'device-token.22222222222222222222222222222222'],
    cleanupFiles: [],
    cleanupDirectories: [],
  };
}

async function syntheticEndpoint(sinks = {}, { initialPhase = 'absent', mode = 'normal' } = {}) {
  const runDir = await createSyntheticDedicatedRun();
  let state = initialPhase === 'absent' ? null : syntheticEndpointState(initialPhase);
  const tokenMap = new Map([
    ['device-current', 'old-token-synthetic-0000000000000000'],
    ['device-n-1', 'n1-token-synthetic-00000000000000000'],
  ]);
  const credentialStore = {
    itemId(_agentUrl, deviceId) {
      return deviceId === 'device-current'
        ? 'device-token.11111111111111111111111111111111'
        : 'device-token.22222222222222222222222222222222';
    },
    async getToken(_agentUrl, deviceId) {
      sinks.events?.push(`keychain:get:${deviceId}`);
      if (deviceId === 'device-current') sinks.calls?.push({ name: 'getOldToken' });
      return tokenMap.get(deviceId);
    },
    async setToken(_agentUrl, deviceId, token) {
      sinks.events?.push(`keychain:set:${deviceId}`);
      tokenMap.set(deviceId, token);
    },
  };
  return createEndpointHarness({
    env: { LINKE_REAL_G0A_ACCEPTANCE: 'enabled' },
    runDir,
    now: () => new Date('2030-01-01T00:03:00.000Z'),
    readBundle: async (kind) => kind === 'initial'
      ? syntheticInitialBundle()
      : syntheticReenrollmentBundle(),
    readState: async () => state,
    writeState: async (next) => {
      state = structuredClone(next);
      sinks.events?.push(`state:${next.phase === 'initialized' ? 'item-ids-recorded' : next.phase}`);
    },
    writeBundle: async () => {},
    writeReceipt: async (_phase, receipt) => sinks.receipts?.push(receipt),
    keychainFactory: () => ({
      async delete(itemId) { sinks.deleted?.push(itemId); return true; },
    }),
    credentialStoreFactory: () => credentialStore,
    enroll: async (_options) => {
      sinks.calls?.push({ name: 'enrollDevice' });
      tokenMap.set('device-current', 'current-token-synthetic-00000000000000');
      return {
        deviceId: 'device-current', enrolled: true,
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      };
    },
    heartbeat: async () => {
      sinks.calls?.push({ name: 'heartbeatDevice' });
      if (mode === 'post-revoke') {
        sinks.outcomes?.push(ERROR_CODES.DEVICE_REVOKED);
        throw new LinkeError(ERROR_CODES.DEVICE_REVOKED, { statusCode: 403 });
      }
      if (mode === 'reenroll') {
        sinks.outcomes?.push('current-reenrolled-and-heartbeat-accepted');
      }
      return { deviceId: 'device-current', accepted: true };
    },
    rotate: async () => {
      sinks.calls?.push({ name: 'rotateDeviceToken' });
      sinks.rotateCalls?.push('rotate-call');
      if (mode === 'expired-pending') {
        throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
      }
      tokenMap.set('device-current', 'new-token-synthetic-0000000000000000');
      return { deviceId: 'device-current', rotated: true };
    },
    pinnedRequest: async (request) => {
      const label = request.body.protocolVersion === MIN_DEVICE_PROTOCOL_VERSION - 1
        ? 'n-2-enroll'
        : request.path === '/agent/enroll'
          ? 'n-1-enroll'
          : request.body.deviceId === 'device-n-1'
            ? 'n-1-heartbeat'
            : 'old-token-heartbeat';
      sinks.requests?.push({
        label, path: request.path, body: request.body,
        expectedStatus: label === 'n-2-enroll' ? 426 : undefined,
        expectedCode: label === 'n-2-enroll' ? ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED : undefined,
      });
      if (mode === 'fingerprint-change') {
        sinks.outcomes?.push(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH);
        throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH);
      }
      if (label === 'old-token-heartbeat') {
        sinks.calls?.push({ name: 'oldTokenHeartbeat', expectedCode: ERROR_CODES.DEVICE_TOKEN_INVALID });
        throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
      }
      if (label === 'n-2-enroll') {
        throw new LinkeError(ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED, { statusCode: 426 });
      }
      if (label === 'n-1-enroll') {
        return {
          deviceId: 'device-n-1',
          deviceToken: 'n1-token-synthetic-00000000000000000',
          protocolVersion: MIN_DEVICE_PROTOCOL_VERSION,
        };
      }
      sinks.outcomes?.push('n-1-heartbeat-accepted');
      return { deviceId: 'device-n-1', accepted: true };
    },
  });
}

async function syntheticEndpointWithExpiredPending(sinks = {}) {
  return syntheticEndpoint(sinks, { mode: 'expired-pending' });
}
```

再增加以下 tests：

```js
describe('G0a real endpoint runner', () => {
  it('locks the supported window to exactly current and N-1', () => {
    assert.equal(MIN_DEVICE_PROTOCOL_VERSION, DEVICE_PROTOCOL_VERSION - 1);
  });

  it('persists exact credential item ids before Keychain/network use', async () => {
    const events = [];
    const harness = await syntheticEndpoint({ events });
    await harness.runPhase('pre-revoke');
    const firstCredentialSideEffect = events.findIndex((v) => v.startsWith('keychain:'));
    const stateWrite = events.findIndex((v) => v === 'state:item-ids-recorded');
    assert.ok(stateWrite >= 0 && stateWrite < firstCredentialSideEffect);
  });

  it('runs current enroll, two heartbeats, rotate, old-token rejection and new-token heartbeat in order', async () => {
    const calls = [];
    const harness = await syntheticEndpoint({ calls });
    await harness.runPhase('pre-revoke');
    assert.deepEqual(calls.slice(0, 6).map((c) => c.name), [
      'enrollDevice', 'heartbeatDevice', 'heartbeatDevice',
      'getOldToken', 'rotateDeviceToken', 'oldTokenHeartbeat',
    ]);
    assert.equal(calls[5].expectedCode, ERROR_CODES.DEVICE_TOKEN_INVALID);
    assert.equal(calls[6].name, 'heartbeatDevice');
  });

  it('uses current-1 for N-1 enroll/heartbeat and current-2 for strict 426', async () => {
    const requests = [];
    const harness = await syntheticEndpoint({ requests });
    await harness.runPhase('pre-revoke');
    const n1 = requests.filter((r) => r.label.startsWith('n-1'));
    assert.deepEqual(n1.map((r) => r.body.protocolVersion), [
      MIN_DEVICE_PROTOCOL_VERSION,
      MIN_DEVICE_PROTOCOL_VERSION,
    ]);
    const n2 = requests.find((r) => r.label === 'n-2-enroll');
    assert.equal(n2.body.protocolVersion, MIN_DEVICE_PROTOCOL_VERSION - 1);
    assert.equal(n2.expectedStatus, 426);
    assert.equal(n2.expectedCode, ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED);
  });

  it('requires revoke, restart, old pin mismatch and reenrollment outcomes', async () => {
    const cases = [
      { phase: 'post-revoke', prior: 'pre-revoke-passed', mode: 'post-revoke', expected: ERROR_CODES.DEVICE_REVOKED },
      { phase: 'post-restart', prior: 'post-revoke-passed', mode: 'normal', expected: 'n-1-heartbeat-accepted' },
      { phase: 'post-fingerprint-change', prior: 'post-restart-passed', mode: 'fingerprint-change', expected: ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH },
      { phase: 'reenroll', prior: 'post-fingerprint-change-passed', mode: 'reenroll', expected: 'current-reenrolled-and-heartbeat-accepted' },
    ];
    for (const item of cases) {
      const outcomes = [];
      const harness = await syntheticEndpoint({ outcomes }, { initialPhase: item.prior, mode: item.mode });
      await harness.runPhase(item.phase);
      assert.deepEqual(outcomes, [item.expected]);
    }
  });

  it('maps expired rotate recovery to bounded FAIL without a second begin', async () => {
    const calls = [];
    const rotateCalls = [];
    const harness = await syntheticEndpointWithExpiredPending({ calls, rotateCalls });
    const result = await harness.runPhase('pre-revoke');
    assert.equal(result.status, 'FAIL');
    assert.equal(rotateCalls.length, 1);
  });

  it('writes only 0600 sanitized receipts and cleans exact state allowlist items', async () => {
    const deleted = [];
    const harness = await syntheticEndpoint({ deleted }, { initialPhase: 'reenroll-passed' });
    await harness.runPhase('cleanup');
    assert.deepEqual(deleted.sort(), harness.getState().credentialItemIds.slice().sort());
    assert.ok(deleted.every((id) => id.startsWith('device-token.')));
  });
});
```

- [ ] **Step 2: 运行 Endpoint RED**

Run: `node --test --test-name-pattern="G0a real endpoint" test/g0a-real-acceptance.test.js`

Expected: FAIL because `g0a-real-endpoint-runner.js` or exports do not exist。

- [ ] **Step 3: 实现 Endpoint runner**

固定依赖注入接口：

```js
export async function createEndpointHarness({
  env = process.env,
  runDir = process.cwd(),
  now = () => new Date(),
  keychainFactory = (service) => new KeychainStore({ service }),
  credentialStoreFactory = (keychain) => new DeviceCredentialStore({ keychain }),
  enroll = enrollDevice,
  heartbeat = heartbeatDevice,
  rotate = rotateDeviceToken,
  pinnedRequest = requestPinnedJson,
  readBundle,
  readState,
  writeState,
  writeBundle,
  writeReceipt,
  deleteFile,
} = {}) {
  assertRealGate(env);
  await assertDedicatedRunDirectory(runDir);
  // 返回 phase runner；构造阶段不访问 Keychain/network。
}
```

首次 phase 在任何凭证/network 副作用前写 Endpoint state：

```js
{
  schemaVersion: 1,
  purpose: 'linke-g0a-real-acceptance',
  runId,
  phase: 'initialized',
  endpointKeychainService,
  credentialItemIds: [
    credentialStore.itemId(agentUrl, current.deviceId),
    credentialStore.itemId(agentUrl, nMinusOne.deviceId),
  ],
  cleanupFiles: [
    'bundle-initial.json', 'bundle-reenrollment.json', 'endpoint-state.json',
    'receipt-pre-revoke.json', 'receipt-post-revoke.json',
    'receipt-post-restart.json', 'receipt-post-fingerprint-change.json',
    'receipt-reenroll.json',
  ],
  cleanupDirectories: [],
}
```

`pre-revoke` 必须严格执行：production current enroll → production heartbeat x2 → `oldToken = credentialStore.getToken()` 局部变量 → production rotate → raw current heartbeat with oldToken 严格捕获 `LinkeError(device-token-invalid, 401)` → production heartbeat with new Keychain token → raw N-1 enroll response shape 校验并 `credentialStore.setToken()` → 从 Keychain 读 N-1 token → raw N-1 heartbeat → raw N-2 enroll 严格捕获 `device-protocol-unsupported` + 426。之后删除三个 consumed code 字段并原子覆写 initial bundle，写 PASS receipt。

raw request body 不写数字字面量协议版本：current 使用 `DEVICE_PROTOCOL_VERSION`，N-1 使用 `MIN_DEVICE_PROTOCOL_VERSION`，N-2 使用 `MIN_DEVICE_PROTOCOL_VERSION - 1`。响应 shape 也与相同常量比较，使协议版本升级时测试同步失败而非静默过期。

oldToken 不能成为 object property、state、bundle、receipt、log 或 returned result。rotate 抛出的 pending-expired/invalid recovery 只产生一次 sanitized FAIL；runner 不自行再次调用 rotate begin。

`post-revoke` 用 production current heartbeat 严格要求 `device-revoked`。`post-restart` 从 Keychain 读取 N-1 token并用 raw N-1 heartbeat。`post-fingerprint-change` 使用 initial bundle 的旧 pin和已有 token，严格要求 `device-tls-fingerprint-mismatch`。`reenroll` 读取 kind=`reenrollment` bundle，用 production enroll + heartbeat，写 PASS receipt。

每个 phase 先调用 `isIdempotentEndpointPhase(state.phase, phase)`；命中时不重放 network/Keychain，只重新原子写同一 phase 的 sanitized PASS receipt 并返回 `flag: true`。其它 phase 再验证 Endpoint state 顺序，写 phase intent，然后执行；无法证明安全的 intent crash 返回 BLOCKED。每个成功 phase 用 `atomicWritePrivateJson()` 写固定 `0600` receipt。`cleanup` 可从任一已验证 Endpoint state 进入 `cleaning`，只对 state.credentialItemIds 调用 dedicated keychain.delete，只删除 cleanupFiles 固定 basename，并只 `rmdir` cleanupDirectories 中的已知空目录；不递归、不 glob、不扫描。

Endpoint main 只接受一个固定 phase positional argument；其它 argv 拒绝。stdout 每次只写一个 sanitized JSON line；catch 不写 raw error。import 不执行 main/signal/Keychain/network。

- [ ] **Step 4: 运行 Endpoint GREEN 和旧 token 静态泄漏扫描**

Run: `node --test --test-name-pattern="G0a real endpoint" test/g0a-real-acceptance.test.js`

Expected: PASS。

Run: `rg -n "oldToken.*(state|write|return|console)|console\.(log|error)|process\.env\[[^]]*(TOKEN|CODE)|\.stack|error\.message" test/helpers/g0a-real-endpoint-runner.js`

Expected: no secret-flow matches；局部 `oldToken` 请求使用本身允许出现。

Run: `node --input-type=module -e "await import('./test/helpers/g0a-real-endpoint-runner.js')"`

Expected: exit 0, no stdout/stderr, no side effects。

---

### Task 4: Documentation, Fault Matrix and Automated Acceptance

**Files:**
- Modify: `README.md`
- Modify: `test/readme.test.js`
- Modify: `test/g0a-real-acceptance.test.js`

**Interfaces:**
- Consumes: Tasks 1–3 fixed command/phase/file contracts。
- Produces: README test-only runbook boundary and full automated harness contract。

- [ ] **Step 1: 写 README RED 测试**

在 `test/readme.test.js` 增加：

```js
describe('README — G0a real two-Mac acceptance harness', () => {
  it('documents the exact test-only safety boundary', () => {
    assertReadmeContains(/LINKE_REAL_G0A_ACCEPTANCE=enabled/, 'exact real G0a gate');
    assertReadmeContains(/SSH alias/i, 'preconfigured SSH alias only');
    assertReadmeContains(/0600/, 'private bundle and receipt mode');
    assertReadmeContains(/test-only|测试专用/i, 'test-only harness');
    assertReadmeContains(/Gold[^\n]*(BLOCKED|blocked)/, 'Gold remains blocked before real gates');
  });

  it('does not describe automation as real hardware proof', () => {
    assertReadmeDoesNotContain(/自动测试[^\n]*(真实双 Mac|真实 Keychain)[^\n]*(PASS|通过)/i,
      'automation must not claim real hardware PASS');
  });
});
```

- [ ] **Step 2: 运行 README RED**

Run: `node --test --test-name-pattern="G0a real two-Mac" test/readme.test.js`

Expected: FAIL because README has no harness section。

- [ ] **Step 3: 增加最小 README 安全说明**

增加 `G0a 真实双 Mac 验收（测试专用）` 小节，只说明：exact gate、专用目录 marker/0600 config、固定非零 Agent port、预配置 SSH alias、不读取 `.ssh`、bundle/receipt 固定相对文件名、命令 phase、用户 UI 处理 Keychain allow/deny/lock/unlock、所有真实门前 Gold BLOCKED。不得放任何实际 host/IP/URL/path/fingerprint/code/token/service/item 示例值。

真实命令只用占位 label，不提供会被复制成真实 secret 的字段：

```text
Controller stdin phases:
prepare → ack-pre-revoke → revoke-current → ack-post-revoke
→ restart → ack-post-restart → replace-identity-confirmed
→ prepare-reenrollment → ack-post-fingerprint-change → ack-reenroll → stop

Endpoint phases:
pre-revoke → post-revoke → post-restart
→ post-fingerprint-change → reenroll → cleanup
```

- [ ] **Step 4: 增加 fault tests**

在 `test/g0a-real-acceptance.test.js` 增加以下明确 fault tests；gate、bundle expiry/cross-run、receipt FAIL/wrong-phase、prepare/revoke intent、rotate expiry 已由前面具名测试覆盖，不再用返回常量的伪 driver 重复：

```js
describe('G0a real fault matrix', () => {
  it('rejects a symlink marker and 0644 config before dependencies run', async () => {
    const root = await privateDir();
    const realMarker = join(root, 'real-marker.json');
    await atomicWritePrivateJson(realMarker, {
      schemaVersion: 1, purpose: 'linke-g0a-real-acceptance',
    });
    await symlink(realMarker, join(root, RUN_MARKER_FILE));
    await assert.rejects(assertDedicatedRunDirectory(root));

    const config = join(root, CONTROLLER_CONFIG_FILE);
    await writeFile(config, '{"schemaVersion":1}\n', { mode: 0o644 });
    await assert.rejects(readPrivateJson(config, (value) => value));
  });

  it('keeps the same prepared bundle and does not issue new codes after transfer retry', async () => {
    const requests = [];
    const harness = await syntheticControllerAt('bundle-prepared', { requests });
    const result = await harness.execute('prepare');
    assert.equal(result.status, 'PASS');
    assert.equal(result.flag, true);
    assert.equal(requests.length, 0);
  });

  it('detects both TLS identity half-states before listener start', async () => {
    const root = await privateDir();
    const tlsDir = join(root, 'tls');
    await mkdir(tlsDir, { recursive: true });
    await writeFile(join(tlsDir, 'controller-cert.pem'), 'synthetic-cert', { mode: 0o600 });
    const certOnly = new TlsIdentityStore({ dataDir: tlsDir, keychain: memoryKeychain() });
    await assert.rejects(
      certOnly.ensure({ host: '10.0.0.10', port: 3443 }),
      (e) => e.code === ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE,
    );

    const otherRoot = await privateDir();
    const keyOnly = new TlsIdentityStore({
      dataDir: join(otherRoot, 'tls'),
      keychain: memoryKeychain(new Map([[CONTROLLER_TLS_KEY_ITEM, 'synthetic-private-key']])),
    });
    await assert.rejects(
      keyOnly.ensure({ host: '10.0.0.10', port: 3443 }),
      (e) => e.code === ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE,
    );
  });

  it('rejects cleanup paths that escape the dedicated run directory', () => {
    const state = syntheticControllerState('cleaning');
    state.cleanupFiles = ['../outside'];
    assert.throws(() => validateControllerState(state, { runDir: '/private/synthetic-run' }),
      (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID);

    const endpointState = syntheticEndpointState('cleaning');
    endpointState.cleanupFiles = ['../outside'];
    assert.throws(() => validateEndpointState(endpointState, { runDir: '/private/synthetic-run' }),
      (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID);
  });

  it('blocks cleanup through a symlink ancestor or a target type mismatch', async () => {
    const root = await privateDir();
    const realDir = join(root, 'real-dir');
    await mkdir(realDir);
    await symlink(realDir, join(root, 'linked-dir'));
    await assert.rejects(
      assertSafeCleanupTarget(root, 'linked-dir/file.json', 'file'),
      (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
    );

    await writeFile(join(root, 'must-be-directory'), 'synthetic', { mode: 0o600 });
    await assert.rejects(
      assertSafeCleanupTarget(root, 'must-be-directory', 'directory'),
      (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
    );
  });
});
```

- [ ] **Step 5: 运行 focused、Step 4 和全量测试**

Run: `node --test test/g0a-real-acceptance.test.js test/readme.test.js`

Expected: PASS；不触发真实 gate。

Run: `node --test test/error-codes.test.js test/keychain-store.test.js test/tls-identity-store.test.js test/device-registry.test.js test/agent-listener.test.js test/device-client.test.js test/controller-runtime.test.js test/server.test.js test/g0a-real-acceptance.test.js`

Expected: PASS；真实 Keychain test 不在此命令中。

Run: `npm test`

Expected: PASS，既有真实 Keychain integration 仍默认 skip。

Run: `git diff --check`

Expected: no output, exit 0。

Run: `git status --short`

Expected: 仅包含本计划允许的 6 个 implementation/doc files 与已批准的 spec/plan 文档变更；不得出现 bundle/state/receipt/config/marker 或报告。

---

### Task 4.5: Fresh-Review Remediation and Real-Runner Operability

**Files:**
- Modify: `test/helpers/g0a-real-common.js`
- Modify: `test/helpers/g0a-real-controller-runner.js`
- Modify: `test/helpers/g0a-real-endpoint-runner.js`
- Modify: `test/g0a-real-acceptance.test.js`
- Modify: `README.md`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: Tasks 1–4 implementation and Grok fresh review P0/P1 findings。
- Produces: `readOptionalPrivateJson()`、`kind=initial-consumed`、recoverable replacement substates、direct main guards、strict response/cleanup semantics。

- [ ] **Step 1: 写 review finding regression RED tests**

每个 finding 必须先有独立失败测试，至少包括：

```js
describe('G0a fresh-review regressions', () => {
  it('distinguishes missing state from corrupt, 0644 and symlink state', async () => {
    for (const fault of ['bad-schema', 'truncated-json', '0644', 'symlink']) {
      const counters = { stateWrites: 0, keychain: 0, network: 0 };
      const harness = await controllerWithStateFault(fault, counters);
      await assert.rejects(harness.start(), (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID);
      assert.deepEqual(counters, { stateWrites: 0, keychain: 0, network: 0 });
    }
  });

  it('allows stop-only recovery from unsafe controller intent', async () => {
    const calls = [];
    const harness = await controllerAtIntent('preparing-bundle', calls);
    const started = await harness.start();
    assert.equal(started.status, 'BLOCKED');
    assert.equal(calls.includes('network'), false);
    assert.equal((await harness.execute('prepare')).status, 'BLOCKED');
    assert.equal((await harness.execute('stop')).status, 'PASS');
  });

  it('resumes restart, replacement substates and cleaning without replaying unsafe work', async () => {
    for (const phase of [
      'restarting-controller', 'replacing-fingerprint',
      'identity-deleted', 'identity-regenerated', 'cleaning',
    ]) {
      const result = await exerciseSafeControllerResume(phase);
      assert.equal(result.unsafeReplay, false);
      assert.equal(result.status, 'PASS');
    }
  });

  it('does not mark cleanup complete when dedicated Keychain deletion is unavailable', async () => {
    for (const role of ['controller', 'endpoint']) {
      const result = await cleanupWithKeychainFailure(role, ERROR_CODES.KEYCHAIN_UNAVAILABLE);
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.state.phase, 'cleaning');
    }
  });

  it('binds every post-init bundle to Endpoint state runId', async () => {
    const calls = { keychain: 0, network: 0 };
    const harness = await endpointWithCrossRunBundle(calls);
    const result = await harness.runPhase('post-revoke');
    assert.notEqual(result.status, 'PASS');
    assert.deepEqual(calls, { keychain: 0, network: 0 });
  });

  it('uses initial-consumed metadata after the enrollment TTL without retaining codes', async () => {
    const consumed = await runSyntheticPreRevokeAndReadBundle();
    assert.equal(consumed.kind, 'initial-consumed');
    assert.equal('expiresAt' in consumed, false);
    assert.equal(JSON.stringify(consumed).includes('enrollmentCode'), false);
    assert.doesNotThrow(() => validateBundle(consumed, {
      runId: consumed.runId,
      now: new Date('2031-01-01T00:00:00.000Z'),
    }));
  });

  it('strictly validates management and N-1 response shapes', async () => {
    for (const responseFault of [
      'enrollment-expiry-missing', 'enrollment-expiry-noncanonical',
      'revoke-device-mismatch', 'revoke-flag-false',
      'n1-short-token', 'n1-heartbeat-missing-accepted',
      'post-restart-heartbeat-missing-accepted',
    ]) {
      const result = await exerciseMalformedResponse(responseFault);
      assert.notEqual(result.status, 'PASS');
      assert.equal(result.passReceiptWritten, false);
    }
  });

  it('preflights paired identity and preserves Keychain unavailable', async () => {
    for (const fault of ['key-only', 'cert-only', 'delete-false', 'keychain-unavailable']) {
      const result = await exerciseReplacementFault(fault);
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.state.phase, 'replacing-fingerprint');
    }
  });

  it('returns BLOCKED after an irreversible intent-side-effect failure', async () => {
    const result = await failSecondEnrollmentIssue();
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.state.phase, 'preparing-bundle');
  });
});
```

测试 helpers 必须真正调用 harness/public helpers，不得直接返回预期常量。loopback management 测试使用本机 ephemeral HTTP fixture；Keychain 使用会区分 `false` 与 `KEYCHAIN_UNAVAILABLE` 的 adapter。

- [ ] **Step 2: 运行 remediation RED**

Run: `node --test --test-name-pattern="G0a fresh-review regressions" test/g0a-real-acceptance.test.js`

Expected: FAIL on corrupt-state reset、intent cleanup、direct entry、cross-run、response shape、identity preflight 或 initial-consumed behavior；逐项记录正确失败原因。

- [ ] **Step 3: 修复 Common 与 schemas**

新增 `readOptionalPrivateJson(path, validator, deps)`：先 `lstat`；只有 ENOENT 返回 null，symlink/权限/schema/JSON/其它错误全部抛 registered sanitized error。Controller/Endpoint state load 必须使用它。

`validateBundle()` 增加 exact `kind=initial-consumed`：字段固定为 schemaVersion、kind、runId、agentUrl、tlsFingerprint、current/N-1/N-2（只含 deviceId）、endpointKeychainService、createdAt、consumedAt；禁止 enrollmentCode 与 expiresAt。initial/reenrollment 仍严格检查 canonical expiresAt 且未过期。

Common Controller states/transitions必须包含：

```js
'restart-passed:replace-identity-confirmed' -> 'replacing-fingerprint'
'replacing-fingerprint:identity-delete-complete' -> 'identity-deleted'
'identity-deleted:identity-regenerate-complete' -> 'identity-regenerated'
'identity-regenerated:replacement-complete' -> 'fingerprint-replaced'
```

`atomicWritePrivateJson()` 用已打开 `FileHandle.chmod(0o600)` 而非按路径 chmod，缩小 temp swap TOCTOU；sanitized count 必须非负。

- [ ] **Step 4: 修复 Controller recovery、response、replacement 与 main**

`start()` 对 state 分类：

- missing：首次创建 state；任何其它 state read error 直接拒绝且零副作用；
- cleaned：idempotent PASS，不启动 listener；
- preparing-bundle/revoking-current/preparing-reenrollment：返回 sanitized BLOCKED 并进入 cleanup-only，只有 stop 可执行；
- restarting-controller：同 data/keychain/port 启动一次，写 controller-restarted；
- cleaning：不启动 listener，允许继续 stop cleanup；
- replacing-fingerprint/identity-deleted/identity-regenerated：调用明确的 replacement resume helper；
- 其它完成态：正常启动 runtime。

replacement helper 必须在删除前只判断 key/cert presence，不输出内容：both present 才删除；both missing 表示 delete 已完成；half state→`device-tls-identity-incomplete`；Keychain unavailable 保持 `keychain-unavailable`。`delete()` 返回 false 在预期 key present 时是 BLOCKED。每个阶段完成后写对应 substate，再进入下一阶段。`identity-regenerated` no-accept mismatch 时执行 accept；no-accept 已成功说明 accept 在 crash 前完成，可直接完成 state。

enrollment response 严格验证 exact fields、canonical expiresAt、相同 agentUrl/fingerprint/protocol；initial bundle expiresAt 使用三者最早时间。revoke response 必须是 status 200 + matching deviceId + `revoked:true`。任何已经写 intent 后的不可证明失败返回 BLOCKED，保留 intent state。

cleanup 的 Keychain delete：false=missing 幂等；throw 一律非 PASS，保留 cleaning。不得吞 `keychain-unavailable`。

文件尾使用 `pathToFileURL(resolve(process.argv[1])).href === import.meta.url` main guard；import 仍零副作用。direct main 的 gate/config/state error 输出一个 sanitized result。Controller BLOCKED start 结果写出后继续 stdin，但 cleanup-only 模式拒绝非 stop command。

- [ ] **Step 5: 修复 Endpoint run binding、strict protocol、cleanup 与 main**

Endpoint state load 使用 `readOptionalPrivateJson`。首次 pre-revoke 可从 initial bundle bootstrap runId；state 存在后所有 bundle validation 必须传 `state.runId`。pre-revoke 成功后写 `kind=initial-consumed`；post-revoke/post-restart/post-fingerprint-change 只接受它，且不受原 code TTL 限制。

N-1 enroll token 至少 32 字符；N-1 与 post-restart heartbeat response 必须 matching deviceId + `accepted:true`；post-revoke 必须 `device-revoked` + 403。所有失败都不能写 PASS receipt。

cleanup 不吞 Keychain throw，且 cleanupFiles 不包含 Endpoint state journal；state 先写 cleaning，全部成功后写 cleaned。running intent 重启只允许 cleanup，其它 phase 返回 BLOCKED。

Endpoint direct main 只接受恰好一个 phase argv；额外 argv 拒绝并输出一个 sanitized result。文件尾 main guard 使 direct node 可运行，module import 继续零副作用。

- [ ] **Step 6: README 与 direct-entry tests**

README 增加 repository-relative test-only 命令形态，不包含任何真实连接/认证值：Controller `node test/helpers/g0a-real-controller-runner.js`，Endpoint `node test/helpers/g0a-real-endpoint-runner.js <phase>`；强调 cwd 必须是 dedicated run directory，真实 gate 由本地环境预先设置。

用 child process 测试 direct entry：gate 缺失时单行 sanitized FAIL；import 时无输出/副作用；Endpoint 额外 argv 固定拒绝。不得在 child argv/env 放合成 token/code/fingerprint。

- [ ] **Step 7: 运行 remediation GREEN 与全量回归**

Run: `node --test --test-name-pattern="G0a fresh-review regressions" test/g0a-real-acceptance.test.js`

Expected: PASS。

Run: `node --test test/g0a-real-acceptance.test.js test/readme.test.js`

Expected: PASS。

Run: `node --test test/error-codes.test.js test/keychain-store.test.js test/tls-identity-store.test.js test/device-registry.test.js test/agent-listener.test.js test/device-client.test.js test/controller-runtime.test.js test/server.test.js test/g0a-real-acceptance.test.js`

Expected: PASS。

Run: `npm test`

Expected: PASS with only the existing real Keychain default skip。

Run: `git diff --check`

Expected: no output。

---

### Task 4.9: Production dataDir No-Follow Hardening

**Files:**
- Create: `src/safe-data-files.js`
- Modify: `src/device-registry.js`
- Modify: `src/audit-log.js`
- Modify: `src/storage.js`
- Modify: `src/tls-identity-store.js`
- Modify: `src/controller-runtime.js` only if root-relative wiring is required
- Modify: `test/device-registry.test.js`
- Modify: `test/audit-log.test.js`
- Modify: `test/storage.test.js` or the existing storage test owner
- Modify: `test/tls-identity-store.test.js`
- Modify: `test/g0a-real-acceptance.test.js`

**Interfaces:**
- Consumes: confirmed synthetic reproductions for registry temp symlink、audit directory symlink、repo directory symlink and reviewer TLS write-window finding。
- Produces: shared root-relative no-follow file primitives plus production callers that fail closed before writing outside dataDir。

- [ ] **Step 1: Add production RED reproductions**

Tests must use private temporary roots and only boolean/synthetic assertions. Cover registry `.new` and final symlink, audit directory and final file symlink, repo/devices/device directory and `device.json` symlink, TLS directory/temp/final symlink, plus a deterministic injected preflight-to-write swap where an existing injection seam permits it. Every case asserts outside remains unchanged and the production operation rejects with its existing safe error contract.

- [ ] **Step 2: Implement shared safe data-file primitives**

The new module must validate relative paths, walk/create each directory component without recursive symlink following, reject symlink/non-directory ancestors, open final files with `O_NOFOLLOW`, verify the opened fd is a regular file, and expose bounded read、append and same-directory atomic write operations. Atomic temp files are `O_EXCL | O_NOFOLLOW`, mode `0600`, fd-synced/chmodded, then renamed only after parent/target revalidation. No raw path is included in outward errors.

- [ ] **Step 3: Wire production owners**

Device registry read/write, audit read/append/compaction, heartbeat repo directory/read/write and TLS cert read/create/publish use the shared primitives while preserving existing response/error semantics, concurrency serialization and file formats. Harness runtime preflight expands to the known registry/audit/repo ancestors as defense in depth; it is not the root fix.

- [ ] **Step 4: Verify focused and full**

```bash
node --test test/device-registry.test.js test/audit-log.test.js test/storage.test.js test/tls-identity-store.test.js test/controller-runtime.test.js test/g0a-real-acceptance.test.js
npm test
git diff --check
```

Expected: all new RED cases GREEN, existing concurrency/mode/format tests pass, no outside file is created, no secret/raw path output, and the only skip remains the existing real Keychain default skip. Parent-shell color warning must be reported separately and may not be hidden as a passing bare run.

---

### Task 5: External Review, PM Verification and Authorized Git Handoff

**Files:**
- Review only: all Task 1–4 files。
- Do not create: `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md` until real gates pass。

**Interfaces:**
- Consumes: green implementation and test evidence。
- Produces: reviewed commit pushed to `linke-v0.12-web-panel`; Gold remains BLOCKED until real run。

- [ ] **Step 1: Grok fresh-session review**

Reviewer checks with repository line evidence: gate-before-side-effects、`O_NOFOLLOW`/0600、schema unknown-field rejection、intent crash behavior、management token memory-only、oldToken local-only、N-1 body version、N-2 426、exact identity deletion、receipt ack ordering、cleanup allowlist、import no side effects。Output must be `ACCEPT` or findings with P0/P1/P2; P0/P1 must be zero before commit。

- [ ] **Step 2: Codex PM independent verification**

Run the three Task 4 commands again from a clean process, inspect `git diff --check`、`git diff --stat`、`git status --short`、all new public function JSDoc, and search:

```bash
rg -n "BEGIN (PRIVATE KEY|CERTIFICATE)|Bearer |enrollmentCode.*console|deviceToken.*console|fingerprint.*console|console\.(log|error)|\.stack|error\.message|rmSync|rm\(|glob|readdir" test/helpers test/g0a-real-acceptance.test.js README.md
```

Expected: no embedded secret、raw error output、wildcard cleanup or recursive deletion；合法 test assertions must be manually dispositioned。

- [ ] **Step 3: Commit and push under standing user authorization**

```bash
git add docs/superpowers/specs/2026-07-13-g0a-real-two-mac-acceptance-harness-design.md \
  docs/superpowers/plans/2026-07-13-g0a-real-two-mac-acceptance-harness.md \
  test/helpers/g0a-real-common.js \
  test/helpers/g0a-real-controller-runner.js \
  test/helpers/g0a-real-endpoint-runner.js \
  test/g0a-real-acceptance.test.js README.md test/readme.test.js
git diff --cached --check
git commit -m "test: add G0a real two-Mac acceptance harness"
git push
```

Expected: commit succeeds and remote branch advances；then proceed directly to real Keychain and SSH-alias acceptance without claiming Gold complete。

## Real-Gate Handoff After This Plan

1. Run existing real Keychain allow test under its exact gate; user handles UI prompt。
2. User performs deny/lock/unlock through macOS UI; runner only observes registered fail-closed/recovery codes。
3. Use a dedicated Controller run directory with `0600` marker/config and fixed nonzero private Agent port。
4. Start Controller runner, use only the user-provided SSH alias, and transfer fixed relative bundle/receipt files by SCP。
5. Execute phases in Task 4 order; every ack consumes a validated PASS receipt。
6. Run exact cleanup on both Macs, then verify no dedicated Keychain item/file remains without scanning unrelated Keychain data。
7. Only after every real gate passes, create the sanitized report with source commit、Node/macOS major、command id、PASS/FAIL/BLOCKED、registered code、UTC time、promptHandled；never include host/IP/URL/path/fingerprint/code/token/service/item/raw error。
