# Linke Gold G0a Trust Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Linke 建立可真实运行的 macOS Keychain、控制器 TLS identity、十分钟单次 enrollment、设备 token/撤销、当前与 N-1 协议门，以及与 loopback 管理面分离的私网 Agent HTTPS listener。

**Architecture:** 保留 `src/server.js` 作为 loopback 管理面，但把设备信任链拆成独立模块，并通过显式 service 注入管理 API。新 `src/agent-listener.js` 只承载设备协议；端点使用证书 SHA-256 pin 和 Keychain token，不复用管理面 bearer token。控制器持久化只保存 enrollment/token 摘要，TLS 私钥只存在 Keychain。

**Tech Stack:** Node.js 24 ESM、内置 `node:test`、`node:https`/`node:tls`/`node:crypto`、macOS `/usr/bin/security`、LibreSSL `/usr/bin/openssl`；不新增 npm 运行时依赖。

## Global Constraints

- 管理 listener 只监听 loopback；Agent listener 默认端口 `3443`，必须显式绑定私有 LAN 地址，不能默认监听 `0.0.0.0`。
- 管理员通过独立渠道传递 Agent URL、TLS SHA-256 fingerprint 和十分钟有效、仅使用一次的 256 位 enrollment code。
- 控制器只持久化 enrollment code digest 与 device token digest；端点 token 和控制器 TLS 私钥进入登录用户 Keychain。
- Keychain 不可用、证书/私钥不成对、fingerprint 改变、token 撤销或设备作用域不匹配时全部 fail-closed。
- 设备作用域由服务端 token→`deviceId` 绑定决定；URL、请求体和 manifest 不能扩大作用域。
- 设备协议接受 current 与 N-1；其余返回 `device-protocol-unsupported`，不做部分兼容写入。
- G0a 不实现 snapshot upload/restore；Agent listener 对未注册的设备路径固定返回 404。
- enrollment 管理路由只有配置了 full/write 管理 token 才可用；现有“未配置 token 则开放 API”的兼容行为不得扩散到 enrollment。
- enrollment code 具有 256 位随机熵；Agent listener 对来源 IP 固定 60 次/分钟。G0a 不增加可被未认证攻击者利用的 per-device 自动锁定，避免攻击者主动锁死合法 enrollment；失败审计在 G5 接入。
- 管理面与 Agent listener 使用独立 limiter；Agent 上限 60 次/分钟，管理面沿用 `LINKE_RATE_LIMIT_PER_MINUTE`，单来源总上限是两者之和且不共享排队。
- device registry 与 TLS metadata 的 `dataDir` 必须位于控制器本地 APFS，不支持 NFS/SMB；文件 I/O 阻塞由 G4 launchd 看护重启，不能用无法取消的 Promise timeout 释放 mutation queue 后制造并发写。
- 新 device administration route 固定返回注册错误码；既有管理 route 的英文 error 契约在 G0a 保持兼容，统一迁移由 G5 独立计划处理。
- 所有可观察失败只返回注册错误码，不返回 Keychain、OpenSSL、路径、证书、token 或原始系统错误。
- 自动测试使用注入 runner/内存 adapter；不得把 mock 结果记作真实 Keychain 或真实双 Mac 验收。
- 真实 Keychain 写入、真实私网配对在执行前遵守用户安全边界；缺少真实环境时保持 Gold `blocked`。
- 每个 task 均按 RED→GREEN→聚焦回归→PM diff 检查执行；版本与 Gold 状态在真实硬件门通过前不修改。
- 所有新增公共函数/类必须有简短 JSDoc，所有生产模块保持单一职责。

## File Map

- Create: `src/error-codes.js` — 唯一错误码注册表、`LinkeError` 和注册校验。
- Create: `src/device-protocol.js` — current/N-1 协议常量与验证。
- Create: `src/keychain-store.js` — `/usr/bin/security` runner 与 fail-closed `KeychainStore`。
- Create: `src/tls-identity-store.js` — 私有 LAN host 校验、TLS key/certificate 创建、SAN/配对校验、fingerprint。
- Create: `src/device-registry.js` — enrollment/device 摘要状态、原子持久化、消费、认证、轮换、撤销。
- Create: `src/agent-listener.js` — 独立 HTTPS 设备协议与固定错误响应。
- Create: `src/device-client.js` — endpoint TLS pin、enrollment、Keychain token 与 authenticated request。
- Create: `src/controller-runtime.js` — 双 listener 启停、失败补偿和启动自检。
- Modify: `src/server.js` — 注入 device administration service，新增两个固定管理写路由和只读状态路由。
- Modify: `src/agent.js` — 增加 `device-enroll`、`device-token-rotate`、`device-heartbeat` CLI；secret 只从 stdin/Keychain 进入。
- Modify: `package.json` — `start` 切到 controller runtime 入口；保留零依赖。
- Modify: `README.md`、`test/readme.test.js` — 同步新的默认启动入口、必需的 Agent bind 和旧 `src/server.js` 开发入口。
- Create: `test/error-codes.test.js`、`test/device-protocol.test.js` — 注册表与 N-1 契约。
- Create: `test/keychain-store.test.js`、`test/keychain-real.integration.test.js` — runner 契约与显式启用的真实 Keychain 门。
- Create: `test/tls-identity-store.test.js` — 私网地址、SAN、identity 不完整、fingerprint 变化。
- Create: `test/device-registry.test.js` — digest-only、TTL、single-use、认证、轮换、撤销、并发消费。
- Create: `test/agent-listener.test.js` — HTTPS enrollment/heartbeat/rotate、scope、协议、404 和脱敏。
- Create: `test/device-client.test.js` — pin-before-secret、token Keychain、错误码、CLI 无泄漏。
- Create: `test/controller-runtime.test.js` — 双 listener 绑定、启动失败补偿、关闭和健康状态。
- Modify: `test/health.test.js`、`test/security.test.js`、`test/server.test.js` 及 4 个严格 write-route 数量测试 — 管理路由授权与注册表回归。
- Modify: `test/heartbeat.test.js` — 旧 loopback heartbeat 保持兼容但不等于受管设备身份。
- Create after explicit real test: `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md` — 仅保存脱敏 PASS/FAIL、commit、命令标识和时间。

---

### Task 1: Registered Error Codes and Device Protocol Window

**Files:**
- Create: `src/error-codes.js`
- Create: `src/device-protocol.js`
- Create: `test/error-codes.test.js`
- Create: `test/device-protocol.test.js`

**Interfaces:**
- Produces: `ERROR_CODES`、`LinkeError`、`assertRegisteredErrorCode(code)`。
- Produces: `DEVICE_PROTOCOL_VERSION = 2`、`MIN_DEVICE_PROTOCOL_VERSION = 1`、`assertSupportedDeviceProtocol(version)`。
- Consumed by: Tasks 2–8；任何 API error 只能取自该注册表。

- [ ] **Step 1: 写错误码与协议 RED 测试**

创建 `test/error-codes.test.js`：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from '../src/error-codes.js';

describe('Gold error-code registry', () => {
  it('contains unique registered kebab-case codes', () => {
    const values = Object.values(ERROR_CODES);
    assert.strictEqual(new Set(values).size, values.length);
    for (const code of values) {
      assert.match(code, /^(auth|device|upload|snapshot|smb|restore|retention|scheduler|lifecycle|keychain|audit|upgrade)-[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.strictEqual(assertRegisteredErrorCode(code), code);
    }
  });

  it('rejects raw or unregistered error text', () => {
    assert.throws(() => assertRegisteredErrorCode('ENOENT /Users/private'), /unregistered Linke error code/);
  });

  it('constructs a sanitized LinkeError', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_REVOKED, { statusCode: 403 });
    assert.strictEqual(error.code, 'device-revoked');
    assert.strictEqual(error.message, 'device-revoked');
    assert.strictEqual(error.statusCode, 403);
    assert.strictEqual(error.retryable, false);
  });
});
```

创建 `test/device-protocol.test.js`：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DEVICE_PROTOCOL_VERSION,
  MIN_DEVICE_PROTOCOL_VERSION,
  assertSupportedDeviceProtocol,
} from '../src/device-protocol.js';

describe('device protocol compatibility window', () => {
  it('accepts current and N-1 only', () => {
    assert.strictEqual(DEVICE_PROTOCOL_VERSION, 2);
    assert.strictEqual(MIN_DEVICE_PROTOCOL_VERSION, 1);
    assert.strictEqual(assertSupportedDeviceProtocol(2), 2);
    assert.strictEqual(assertSupportedDeviceProtocol(1), 1);
  });

  it('fails closed for older, future, fractional and string versions', () => {
    for (const version of [0, 3, 1.5, '2', null, undefined]) {
      assert.throws(
        () => assertSupportedDeviceProtocol(version),
        (error) => error.code === 'device-protocol-unsupported' && error.statusCode === 426,
      );
    }
  });
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test test/error-codes.test.js test/device-protocol.test.js`

Expected: FAIL，两个生产模块不存在。

- [ ] **Step 3: 实现唯一注册表和协议门**

创建 `src/error-codes.js`：

```js
export const ERROR_CODES = Object.freeze({
  AUTH_ADMIN_REQUIRED: 'auth-admin-required',
  DEVICE_ENROLLMENT_INVALID: 'device-enrollment-invalid',
  DEVICE_INTERNAL_ERROR: 'device-internal-error',
  DEVICE_NOT_FOUND: 'device-not-found',
  DEVICE_PROTOCOL_UNSUPPORTED: 'device-protocol-unsupported',
  DEVICE_RATE_LIMITED: 'device-rate-limited',
  DEVICE_REVOKED: 'device-revoked',
  DEVICE_ROUTE_NOT_FOUND: 'device-route-not-found',
  DEVICE_REQUEST_INVALID: 'device-request-invalid',
  DEVICE_SCOPE_MISMATCH: 'device-scope-mismatch',
  DEVICE_TOKEN_INVALID: 'device-token-invalid',
  DEVICE_TLS_BIND_INVALID: 'device-tls-bind-invalid',
  DEVICE_TLS_FINGERPRINT_MISMATCH: 'device-tls-fingerprint-mismatch',
  DEVICE_TLS_IDENTITY_INCOMPLETE: 'device-tls-identity-incomplete',
  DEVICE_TLS_SAN_MISMATCH: 'device-tls-san-mismatch',
  KEYCHAIN_ITEM_MISSING: 'keychain-item-missing',
  KEYCHAIN_UNAVAILABLE: 'keychain-unavailable',
});

const REGISTERED_ERROR_CODES = new Set(Object.values(ERROR_CODES));

/** Return a registered public error code or throw without echoing its value. */
export function assertRegisteredErrorCode(code) {
  if (!REGISTERED_ERROR_CODES.has(code)) throw new Error('unregistered Linke error code');
  return code;
}

/** Error whose public message is always a registered, sanitized code. */
export class LinkeError extends Error {
  constructor(code, { statusCode = 500, retryable = false } = {}) {
    const registeredCode = assertRegisteredErrorCode(code);
    super(registeredCode);
    this.name = 'LinkeError';
    this.code = registeredCode;
    this.statusCode = statusCode;
    this.retryable = Boolean(retryable);
  }
}
```

创建 `src/device-protocol.js`：

```js
import { ERROR_CODES, LinkeError } from './error-codes.js';

export const DEVICE_PROTOCOL_VERSION = 2;
export const MIN_DEVICE_PROTOCOL_VERSION = DEVICE_PROTOCOL_VERSION - 1;

/** Accept the current and N-1 integer protocol versions; reject every other value. */
export function assertSupportedDeviceProtocol(version) {
  if (!Number.isInteger(version)
    || version < MIN_DEVICE_PROTOCOL_VERSION
    || version > DEVICE_PROTOCOL_VERSION) {
    throw new LinkeError(ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED, { statusCode: 426 });
  }
  return version;
}
```

- [ ] **Step 4: 运行 GREEN 与导入安全检查**

Run: `node --test test/error-codes.test.js test/device-protocol.test.js && node -e "import('./src/error-codes.js').then(() => import('./src/device-protocol.js'))"`

Expected: PASS；模块导入无副作用。

- [ ] **Step 5: PM 复检并提交**

Run: `git diff --check && git diff -- src/error-codes.js src/device-protocol.js test/error-codes.test.js test/device-protocol.test.js`

PM commit: `feat: add registered device protocol errors`

---

### Task 2: Fail-Closed macOS Keychain Adapter

**Files:**
- Create: `src/keychain-store.js`
- Create: `test/keychain-store.test.js`
- Create: `test/keychain-real.integration.test.js`

**Interfaces:**
- Consumes: Task 1 `LinkeError` and Keychain item ids matching `^[a-z][a-z0-9.-]{1,63}$`.
- Produces: `createSecurityRunner({ spawnImpl })` and `new KeychainStore({ runner, service })` with `get(itemId)`、`set(itemId, secret)`、`delete(itemId)`。
- Security contract: secret is sent through stdin for `add-generic-password -w` and never appears in argv/error text/logs.

- [ ] **Step 1: 写 runner 与 store RED 测试**

创建 `test/keychain-store.test.js`，使用以下 runner spy；不得调用真实 Keychain：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { KeychainStore } from '../src/keychain-store.js';

describe('KeychainStore', () => {
  it('writes through stdin and never places the secret in argv', async () => {
    const calls = [];
    const runner = async (args, options = {}) => {
      calls.push({ args, input: options.input });
      return { stdout: '', exitCode: 0 };
    };
    const store = new KeychainStore({ runner, service: 'com.linke.test' });
    await store.set('device-token.alpha', 'test-secret-value');
    assert.deepStrictEqual(calls[0].args, [
      'add-generic-password', '-U', '-s', 'com.linke.test',
      '-a', 'device-token.alpha', '-w',
    ]);
    assert.strictEqual(calls[0].input, 'test-secret-value');
    assert.ok(!calls[0].args.join(' ').includes('test-secret-value'));
  });

  it('returns stdout only from a successful lookup', async () => {
    const runner = async () => ({ stdout: 'stored-value\n', exitCode: 0 });
    const store = new KeychainStore({ runner, service: 'com.linke.test' });
    assert.strictEqual(await store.get('device-token.alpha'), 'stored-value');
  });

  it('maps missing and permission failures to sanitized registered errors', async () => {
    const missing = new KeychainStore({
      runner: async () => ({ stdout: '', exitCode: 44 }),
      service: 'com.linke.test',
    });
    await assert.rejects(missing.get('device-token.alpha'), (error) => (
      error.code === 'keychain-item-missing' && !error.message.includes('alpha')
    ));

    const denied = new KeychainStore({
      runner: async () => ({ stdout: '', exitCode: 36 }),
      service: 'com.linke.test',
    });
    await assert.rejects(denied.set('device-token.alpha', 'do-not-leak'), (error) => (
      error.code === 'keychain-unavailable' && !error.message.includes('do-not-leak')
    ));
  });

  it('rejects unsafe service and item identifiers before spawning', () => {
    assert.throws(() => new KeychainStore({ runner: async () => {}, service: 'bad service' }));
    const store = new KeychainStore({ runner: async () => {}, service: 'com.linke.test' });
    assert.throws(() => store.get('../token'));
  });
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test test/keychain-store.test.js`

Expected: FAIL，`src/keychain-store.js` 不存在。

- [ ] **Step 3: 实现 subprocess runner 与 KeychainStore**

创建 `src/keychain-store.js`；runner 只返回退出码与 stdout，绝不把 stderr 包进异常：

```js
import { spawn } from 'node:child_process';
import { ERROR_CODES, LinkeError } from './error-codes.js';

const SAFE_ID = /^[a-z][a-z0-9.-]{1,63}$/;

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

/** Create the production /usr/bin/security runner; secret input is written only to stdin. */
export function createSecurityRunner({ spawnImpl = spawn } = {}) {
  return (args, { input } = {}) => new Promise((resolve, reject) => {
    const child = spawnImpl('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.resume();
    child.once('error', () => reject(new LinkeError(ERROR_CODES.KEYCHAIN_UNAVAILABLE)));
    child.once('close', (exitCode) => resolve({
      stdout: Buffer.concat(stdout).toString('utf8'),
      exitCode: Number.isInteger(exitCode) ? exitCode : 1,
    }));
    if (input === undefined) child.stdin.end();
    else child.stdin.end(`${input}\n`);
  });
}

/** Minimal fail-closed generic-password adapter for Linke-owned secrets. */
export class KeychainStore {
  constructor({ runner = createSecurityRunner(), service = 'com.linke.gold' } = {}) {
    this.runner = runner;
    this.service = assertSafeId(service, 'service');
  }

  async get(itemId) {
    const account = assertSafeId(itemId, 'itemId');
    const result = await this.runner([
      'find-generic-password', '-s', this.service, '-a', account, '-w',
    ]);
    if (result.exitCode === 44) {
      throw new LinkeError(ERROR_CODES.KEYCHAIN_ITEM_MISSING, { statusCode: 404 });
    }
    if (result.exitCode !== 0) throw new LinkeError(ERROR_CODES.KEYCHAIN_UNAVAILABLE);
    return result.stdout.replace(/\r?\n$/, '');
  }

  async set(itemId, secret) {
    const account = assertSafeId(itemId, 'itemId');
    if (typeof secret !== 'string' || secret.length === 0) throw new Error('secret is required');
    const result = await this.runner([
      'add-generic-password', '-U', '-s', this.service, '-a', account, '-w',
    ], { input: secret });
    if (result.exitCode !== 0) throw new LinkeError(ERROR_CODES.KEYCHAIN_UNAVAILABLE);
  }

  async delete(itemId) {
    const account = assertSafeId(itemId, 'itemId');
    const result = await this.runner([
      'delete-generic-password', '-s', this.service, '-a', account,
    ]);
    if (result.exitCode === 44) return false;
    if (result.exitCode !== 0) throw new LinkeError(ERROR_CODES.KEYCHAIN_UNAVAILABLE);
    return true;
  }
}
```

- [ ] **Step 4: 增加显式启用的真实 Keychain integration gate**

创建 `test/keychain-real.integration.test.js`。测试默认 skip；启用后只写随机专用 service/item，断言 set/get/delete，并在 `finally` 清理：

```js
import { it } from 'node:test';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { KeychainStore } from '../src/keychain-store.js';

const enabled = process.env.LINKE_REAL_KEYCHAIN_TEST === 'enabled';

it('round-trips a dedicated real macOS Keychain item', { skip: !enabled }, async () => {
  const suffix = randomBytes(8).toString('hex');
  const store = new KeychainStore({ service: `com.linke.test.${suffix}` });
  const itemId = `integration.${suffix}`;
  const value = randomBytes(32).toString('base64url');
  try {
    await store.set(itemId, value);
    assert.strictEqual(await store.get(itemId), value);
  } finally {
    await store.delete(itemId);
  }
  await assert.rejects(store.get(itemId), (error) => error.code === 'keychain-item-missing');
});
```

该命令只有在用户明确允许专用 Keychain 测试项写入后执行：

Run: `LINKE_REAL_KEYCHAIN_TEST=enabled node --test test/keychain-real.integration.test.js`

Expected: PASS；Keychain 可能显示由用户处理的权限弹窗。未获允许时只运行默认 skip，并记录真实门为 `blocked`。

- [ ] **Step 5: 运行 GREEN 与敏感信息检查**

Run: `node --test test/error-codes.test.js test/keychain-store.test.js test/keychain-real.integration.test.js`

Expected: PASS，真实 integration 显示 1 skipped；测试输出不含 `test-secret-value` 或 `do-not-leak`。

- [ ] **Step 6: PM 复检并提交**

Run: `git diff --check && rg -n "console\.(log|error)|-w.*secret|do-not-leak|test-secret-value" src/keychain-store.js test/keychain-store.test.js`

Expected: 生产模块无日志；secret 只存在测试断言和 stdin 参数，不进入 argv。

PM commit: `feat: add fail-closed macOS Keychain store`

---

### Task 3: Controller TLS Identity Without Private-Key Files

**Files:**
- Create: `src/tls-identity-store.js`
- Create: `test/tls-identity-store.test.js`

**Interfaces:**
- Consumes: Task 2 `KeychainStore` item `controller-tls-private-key`。
- Produces: `validateAgentBind(host, port)`、`fingerprintCertificate(certPem)`、`createOpenSslCertificate(options)`、`TlsIdentityStore.ensure({ host, port })`。
- Produces identity: `{ keyPem, certPem, fingerprint, host, port }`；`keyPem` 只在进程内存中交给 `https.createServer`，不写文件。

- [ ] **Step 1: 写私网 bind、identity 成对状态与指纹 RED 测试**

创建 `test/tls-identity-store.test.js`，使用内存 Keychain 和注入 certificate inspector：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TlsIdentityStore, validateAgentBind } from '../src/tls-identity-store.js';

function memoryKeychain(initial = new Map()) {
  return {
    async get(id) {
      if (!initial.has(id)) {
        const error = new Error('keychain-item-missing');
        error.code = 'keychain-item-missing';
        throw error;
      }
      return initial.get(id);
    },
    async set(id, value) { initial.set(id, value); },
    async delete(id) { return initial.delete(id); },
  };
}

describe('TLS identity store', () => {
  it('accepts private LAN IPv4, ULA IPv6 and .local DNS only', () => {
    assert.deepStrictEqual(validateAgentBind('192.168.10.4', 3443), {
      host: '192.168.10.4', port: 3443, san: 'IP:192.168.10.4',
    });
    assert.strictEqual(validateAgentBind('linke-controller.local', 4443).san, 'DNS:linke-controller.local');
    assert.strictEqual(validateAgentBind('fd00::10', 3443).san, 'IP:fd00::10');
    for (const host of ['0.0.0.0', '127.0.0.1', 'localhost', '8.8.8.8', 'public.example.com']) {
      assert.throws(() => validateAgentBind(host, 3443), (error) => error.code === 'device-tls-bind-invalid');
    }
  });

  it('creates a matched identity once and reloads it without regeneration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-identity-'));
    const keychain = memoryKeychain();
    let generated = 0;
    const inspectCertificate = () => ({
      fingerprint: 'a'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
    });
    const store = new TlsIdentityStore({
      dataDir: root,
      keychain,
      generatePrivateKey: () => ({ keyPem: 'PRIVATE', publicKeyDigest: 'matched' }),
      certificateFactory: async ({ keyPem, san }) => {
        generated += 1;
        assert.strictEqual(keyPem, 'PRIVATE');
        assert.strictEqual(san, 'IP:192.168.10.4');
        return 'CERTIFICATE';
      },
      inspectCertificate,
      inspectPrivateKey: () => 'matched',
    });
    try {
      const first = await store.ensure({ host: '192.168.10.4', port: 3443 });
      const second = await store.ensure({ host: '192.168.10.4', port: 3443 });
      assert.strictEqual(first.fingerprint, 'a'.repeat(64));
      assert.strictEqual(second.keyPem, 'PRIVATE');
      assert.strictEqual(generated, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when only certificate or only Keychain key exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-incomplete-'));
    try {
      await writeFile(join(root, 'controller-cert.pem'), 'CERTIFICATE');
      const store = new TlsIdentityStore({
        dataDir: root,
        keychain: memoryKeychain(),
        inspectCertificate: () => ({ fingerprint: 'b'.repeat(64), sanEntries: [], publicKeyDigest: 'x' }),
      });
      await assert.rejects(
        store.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => error.code === 'device-tls-identity-incomplete',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects SAN, public-key or approved-fingerprint changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-mismatch-'));
    try {
      await writeFile(join(root, 'controller-cert.pem'), 'CERTIFICATE');
      const keychain = memoryKeychain(new Map([['controller-tls-private-key', 'PRIVATE']]));
      const store = new TlsIdentityStore({
        dataDir: root,
        keychain,
        generatePrivateKey: () => ({ keyPem: 'PRIVATE', publicKeyDigest: 'matched' }),
        inspectPrivateKey: () => 'matched',
        inspectCertificate: () => ({
          fingerprint: 'c'.repeat(64), sanEntries: ['IP:192.168.10.9'], publicKeyDigest: 'different',
        }),
      });
      await assert.rejects(
        store.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => ['device-tls-san-mismatch', 'device-tls-identity-incomplete'].includes(error.code),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test test/tls-identity-store.test.js`

Expected: FAIL，TLS identity 模块不存在。

- [ ] **Step 3: 实现 bind 校验、OpenSSL fd3 runner 和证书检查**

在 `src/tls-identity-store.js` 定义以下生产边界；OpenSSL 的 `-key /dev/fd/3` 从额外 pipe 读取 key，argv 和文件系统都不含私钥：

```js
import { spawn } from 'node:child_process';
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, X509Certificate,
} from 'node:crypto';
import { isIP } from 'node:net';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from './error-codes.js';

const TLS_KEY_ITEM = 'controller-tls-private-key';
const CERT_FILE = 'controller-cert.pem';

function isPrivateIpv4(host) {
  const parts = host.split('.').map(Number);
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254);
}

function isPrivateIpv6(host) {
  const normalized = host.toLowerCase();
  return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8')
    || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}

/** Validate an explicit private Agent listener bind and return its SAN. */
export function validateAgentBind(host, port = 3443) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_BIND_INVALID, { statusCode: 400 });
  }
  const family = isIP(host);
  const privateIp = family === 4 ? isPrivateIpv4(host) : family === 6 ? isPrivateIpv6(host) : false;
  const privateDns = family === 0 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.local$/.test(host);
  if (!privateIp && !privateDns) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_BIND_INVALID, { statusCode: 400 });
  }
  return { host, port, san: family ? `IP:${host}` : `DNS:${host}` };
}

/** Generate an EC private key in memory and return its SPKI digest. */
export function generateControllerPrivateKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { keyPem, publicKeyDigest: createHash('sha256').update(spki).digest('hex') };
}

/** Build a self-signed certificate while passing the private key only through fd 3. */
export function createOpenSslCertificate({ keyPem, san, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const args = [
      'req', '-new', '-x509', '-sha256', '-days', '825', '-batch',
      '-subj', '/CN=Linke Controller', '-addext', `subjectAltName=${san}`,
      '-key', '/dev/fd/3',
    ];
    const child = spawnImpl('/usr/bin/openssl', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.resume();
    child.once('error', () => reject(new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE)));
    child.once('close', (code) => {
      if (code !== 0) reject(new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdio[3].end(keyPem);
  });
}

/** Inspect certificate SAN, fingerprint and public key without exposing key material. */
export function inspectControllerCertificate(certPem) {
  const certificate = new X509Certificate(certPem);
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const sanEntries = String(certificate.subjectAltName || '').split(', ').filter(Boolean);
  return {
    fingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
    sanEntries,
    publicKeyDigest: createHash('sha256').update(spki).digest('hex'),
  };
}

/** Return the SPKI digest derived from a private key held in memory. */
export function inspectControllerPrivateKey(keyPem) {
  const publicKey = createPublicKey(createPrivateKey(keyPem));
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}
```

- [ ] **Step 4: 实现成对持久化与不可静默再生成**

同一文件增加 `TlsIdentityStore`。`ensure()` 只在 key 和 cert 都不存在时创建；只存在一项立即失败。写 cert 使用同目录临时文件和 `rename`，写失败时删除新 Keychain key；加载时用 `createPublicKey(createPrivateKey(keyPem))` 与证书 SPKI digest 双检：

```js
export class TlsIdentityStore {
  constructor({
    dataDir,
    keychain,
    generatePrivateKey = generateControllerPrivateKey,
    certificateFactory = createOpenSslCertificate,
    inspectCertificate = inspectControllerCertificate,
    inspectPrivateKey = inspectControllerPrivateKey,
  }) {
    if (!dataDir || !keychain) throw new Error('dataDir and keychain are required');
    this.dataDir = dataDir;
    this.keychain = keychain;
    this.generatePrivateKey = generatePrivateKey;
    this.certificateFactory = certificateFactory;
    this.inspectCertificate = inspectCertificate;
    this.inspectPrivateKey = inspectPrivateKey;
  }

  async ensure({ host, port = 3443, approvedFingerprint } = {}) {
    const bind = validateAgentBind(host, port);
    await mkdir(this.dataDir, { recursive: true });
    const certPath = join(this.dataDir, CERT_FILE);
    let keyPem = null;
    let certPem = null;
    try { keyPem = await this.keychain.get(TLS_KEY_ITEM); } catch (error) {
      if (error.code !== ERROR_CODES.KEYCHAIN_ITEM_MISSING) throw error;
    }
    try { certPem = await readFile(certPath, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE);
    }
    if (Boolean(keyPem) !== Boolean(certPem)) {
      throw new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE);
    }
    if (!keyPem) {
      const generated = this.generatePrivateKey();
      const generatedCert = await this.certificateFactory({ keyPem: generated.keyPem, san: bind.san });
      const tempPath = `${certPath}.${randomUUID()}.new`;
      await this.keychain.set(TLS_KEY_ITEM, generated.keyPem);
      try {
        await writeFile(tempPath, generatedCert, { mode: 0o600, flag: 'wx' });
        await rename(tempPath, certPath);
      } catch {
        await unlink(tempPath).catch(() => {});
        await this.keychain.delete(TLS_KEY_ITEM).catch(() => {});
        throw new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE);
      }
      keyPem = generated.keyPem;
      certPem = generatedCert;
    }
    const inspected = this.inspectCertificate(certPem);
    if (!inspected.sanEntries.includes(bind.san)) {
      throw new LinkeError(ERROR_CODES.DEVICE_TLS_SAN_MISMATCH);
    }
    const privateDigest = this.inspectPrivateKey(keyPem);
    if (privateDigest !== inspected.publicKeyDigest) {
      throw new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE);
    }
    if (approvedFingerprint && approvedFingerprint !== inspected.fingerprint) {
      throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 409 });
    }
    return { keyPem, certPem, fingerprint: inspected.fingerprint, host: bind.host, port: bind.port };
  }
}
```

- [ ] **Step 5: 运行 GREEN、真实 OpenSSL 子进程契约与回归**

Run: `node --test test/error-codes.test.js test/keychain-store.test.js test/tls-identity-store.test.js`

Expected: PASS。

增加一个使用 `generateControllerPrivateKey()` + `createOpenSslCertificate()` + `inspectControllerCertificate()` 的测试，断言 SAN、64 位 fingerprint 和 SPKI digest 一致；该测试使用真实 `/usr/bin/openssl`，但仍使用内存 Keychain，不写真实凭据。

Run: `node --test test/tls-identity-store.test.js --test-name-pattern="OpenSSL"`

Expected: PASS；项目目录与临时目录均不存在私钥文件。

PM 在计划审查阶段已用 Node `spawn('/usr/bin/openssl', ..., { stdio:['ignore','pipe','pipe','pipe'] })` 实测当前 macOS LibreSSL 3.3.6：fd 3 输入成功、exit 0、生成 certificate、stdout 不含 private key。实现测试仍必须复跑，不能只引用本次预检。

- [ ] **Step 6: PM 复检并提交**

Run: `git diff --check && rg -n "keyout|PRIVATE KEY|console\.(log|error)|0\.0\.0\.0|rejectUnauthorized" src/tls-identity-store.js test/tls-identity-store.test.js`

Expected: 无 `keyout`、无私钥日志、无 wildcard bind、无 TLS 绕过。

PM commit: `feat: add Keychain-backed controller TLS identity`

---

### Task 4: Digest-Only Device Enrollment Registry

**Files:**
- Create: `src/device-registry.js`
- Create: `test/device-registry.test.js`

**Interfaces:**
- Consumes: Task 1 protocol/error modules。
- Produces: `DeviceRegistry.verifyControllerFingerprint(fingerprint)`、`acceptControllerFingerprint(fingerprint)`、`issueEnrollment({ deviceId })`、`consumeEnrollment({ deviceId, code, protocolVersion })`、`authenticate({ deviceId, token, protocolVersion })`、`beginTokenRotation(...)`、`confirmTokenRotation(...)`、`revokeDevice(deviceId)`、`getStatus()`。
- Persistence: `dataDir/device-registry-v1.json` with `{ schemaVersion:1, controllerTlsFingerprint, enrollments, devices }`；只含公开 fingerprint、digest、时间、状态和 protocol，不含 code/token。

- [ ] **Step 1: 写 digest、TTL、single-use、scope、轮换与撤销 RED 测试**

创建 `test/device-registry.test.js`，核心场景如下：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceRegistry } from '../src/device-registry.js';

describe('DeviceRegistry', () => {
  it('persists only digests and atomically consumes one enrollment once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-device-registry-'));
    let now = new Date('2026-07-13T00:00:00.000Z');
    const registry = new DeviceRegistry({ dataDir: root, now: () => now });
    try {
      const issued = await registry.issueEnrollment({ deviceId: 'mac-alpha' });
      assert.match(issued.code, /^[A-Za-z0-9_-]{43}$/);
      assert.strictEqual(issued.expiresAt, '2026-07-13T00:10:00.000Z');
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-alpha', code: issued.code, protocolVersion: 2,
      });
      assert.match(enrolled.token, /^[A-Za-z0-9_-]{43}$/);
      await assert.rejects(
        registry.consumeEnrollment({ deviceId: 'mac-alpha', code: issued.code, protocolVersion: 2 }),
        (error) => error.code === 'device-enrollment-invalid',
      );
      const raw = await readFile(join(root, 'device-registry-v1.json'), 'utf8');
      assert.ok(!raw.includes(issued.code));
      assert.ok(!raw.includes(enrolled.token));
      assert.match(raw, /"codeDigest":"[a-f0-9]{64}"/);
      assert.match(raw, /"tokenDigest":"[a-f0-9]{64}"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects expired enrollment and concurrent double consumption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-device-expiry-'));
    let now = new Date('2026-07-13T00:00:00.000Z');
    const registry = new DeviceRegistry({ dataDir: root, now: () => now });
    try {
      const expired = await registry.issueEnrollment({ deviceId: 'mac-expired' });
      now = new Date('2026-07-13T00:10:00.001Z');
      await assert.rejects(
        registry.consumeEnrollment({ deviceId: 'mac-expired', code: expired.code, protocolVersion: 2 }),
        (error) => error.code === 'device-enrollment-invalid',
      );

      now = new Date('2026-07-13T00:20:00.000Z');
      const concurrent = await registry.issueEnrollment({ deviceId: 'mac-race' });
      const results = await Promise.allSettled([
        registry.consumeEnrollment({ deviceId: 'mac-race', code: concurrent.code, protocolVersion: 2 }),
        registry.consumeEnrollment({ deviceId: 'mac-race', code: concurrent.code, protocolVersion: 2 }),
      ]);
      assert.strictEqual(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.strictEqual(results.filter((result) => result.status === 'rejected').length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds token scope, rotates atomically and revokes immediately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-device-auth-'));
    const registry = new DeviceRegistry({ dataDir: root });
    try {
      const issued = await registry.issueEnrollment({ deviceId: 'mac-alpha' });
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-alpha', code: issued.code, protocolVersion: 2,
      });
      assert.strictEqual((await registry.authenticate({
        deviceId: 'mac-alpha', token: enrolled.token, protocolVersion: 2,
      })).deviceId, 'mac-alpha');
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-beta', token: enrolled.token, protocolVersion: 2 }),
        (error) => error.code === 'device-scope-mismatch',
      );
      const pending = await registry.beginTokenRotation({
        deviceId: 'mac-alpha', token: enrolled.token, protocolVersion: 2,
      });
      assert.strictEqual((await registry.authenticate({
        deviceId: 'mac-alpha', token: enrolled.token, protocolVersion: 2,
      })).deviceId, 'mac-alpha');
      await registry.confirmTokenRotation({
        deviceId: 'mac-alpha', token: pending.token, protocolVersion: 2,
      });
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-alpha', token: enrolled.token, protocolVersion: 2 }),
        (error) => error.code === 'device-token-invalid',
      );
      assert.strictEqual((await registry.authenticate({
        deviceId: 'mac-alpha', token: pending.token, protocolVersion: 2,
      })).deviceId, 'mac-alpha');
      await registry.revokeDevice('mac-alpha');
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-alpha', token: pending.token, protocolVersion: 2 }),
        (error) => error.code === 'device-revoked',
      );
      await assert.rejects(
        registry.revokeDevice('mac-missing'),
        (error) => error.code === 'device-not-found' && error.statusCode === 404,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires explicit acceptance before a controller fingerprint change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-controller-fingerprint-'));
    const registry = new DeviceRegistry({ dataDir: root });
    try {
      await registry.verifyControllerFingerprint('a'.repeat(64));
      const issued = await registry.issueEnrollment({ deviceId: 'mac-alpha' });
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-alpha', code: issued.code, protocolVersion: 2,
      });
      const issuedBeta = await registry.issueEnrollment({ deviceId: 'mac-beta' });
      const enrolledBeta = await registry.consumeEnrollment({
        deviceId: 'mac-beta', code: issuedBeta.code, protocolVersion: 1,
      });
      await assert.rejects(
        registry.verifyControllerFingerprint('b'.repeat(64)),
        (error) => error.code === 'device-tls-fingerprint-mismatch',
      );
      await registry.acceptControllerFingerprint('b'.repeat(64));
      const status = await registry.getStatus();
      assert.deepStrictEqual(status, { active: 0, revoked: 0, suspended: 2 });
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-alpha', token: enrolled.token, protocolVersion: 2 }),
        (error) => error.code === 'device-token-invalid',
      );
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-beta', token: enrolledBeta.token, protocolVersion: 1 }),
        (error) => error.code === 'device-token-invalid',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test test/device-registry.test.js`

Expected: FAIL，registry 模块不存在。

- [ ] **Step 3: 实现 serial mutation queue、摘要比较和原子 state write**

创建 `src/device-registry.js`，使用固定 32-byte `randomBytes(...).toString('base64url')`，SHA-256 digest 和 `timingSafeEqual`。所有 read-modify-write 经过实例级 promise queue；临时文件同目录、mode `0600`、rename 发布：

```js
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertSupportedDeviceProtocol } from './device-protocol.js';

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestsMatch(left, right) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new LinkeError(ERROR_CODES.DEVICE_SCOPE_MISMATCH, { statusCode: 400 });
  }
  return deviceId;
}

export class DeviceRegistry {
  constructor({ dataDir, now = () => new Date(), randomToken = () => randomBytes(32).toString('base64url') }) {
    if (!dataDir) throw new Error('dataDir is required');
    this.statePath = join(dataDir, 'device-registry-v1.json');
    this.tempPath = join(dataDir, 'device-registry-v1.json.new');
    this.dataDir = dataDir;
    this.now = now;
    this.randomToken = randomToken;
    this.mutation = Promise.resolve();
  }

  async mutate(fn) {
    const operation = this.mutation.then(async () => {
      const state = await this.readState();
      const result = await fn(state);
      await this.writeState(state);
      return result;
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }

  async readState() {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (state.schemaVersion !== 1 || !Array.isArray(state.enrollments) || !Array.isArray(state.devices)) {
        throw new Error('invalid device registry');
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return {
        schemaVersion: 1, controllerTlsFingerprint: null, enrollments: [], devices: [],
      };
      throw error;
    }
  }

  async writeState(state) {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(this.tempPath, this.statePath);
  }
}
```

- [ ] **Step 4: 实现五个公开状态操作**

在同一 class 中加入以下行为，所有失败只抛 Task 1 注册码：

```js
async issueEnrollment({ deviceId }) {
  const scopedId = assertDeviceId(deviceId);
  return this.mutate(async (state) => {
    const code = this.randomToken();
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + ENROLLMENT_TTL_MS);
    const retentionCutoff = new Date(issuedAt.getTime() - 24 * 60 * 60 * 1000);
    state.enrollments = state.enrollments.filter((item) => (
      !item.usedAt ? new Date(item.expiresAt) > issuedAt : new Date(item.usedAt) > retentionCutoff
    ));
    state.enrollments.push({
      deviceId: scopedId, codeDigest: digest(code), issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(), usedAt: null,
    });
    return { deviceId: scopedId, code, expiresAt: expiresAt.toISOString() };
  });
}

async consumeEnrollment({ deviceId, code, protocolVersion }) {
  const scopedId = assertDeviceId(deviceId);
  assertSupportedDeviceProtocol(protocolVersion);
  if (typeof code !== 'string') throw new LinkeError(ERROR_CODES.DEVICE_ENROLLMENT_INVALID, { statusCode: 401 });
  return this.mutate(async (state) => {
    const enrollment = state.enrollments.find((item) => (
      item.deviceId === scopedId && !item.usedAt && digestsMatch(item.codeDigest, digest(code))
    ));
    if (!enrollment || this.now() > new Date(enrollment.expiresAt)) {
      throw new LinkeError(ERROR_CODES.DEVICE_ENROLLMENT_INVALID, { statusCode: 401 });
    }
    const token = this.randomToken();
    enrollment.usedAt = this.now().toISOString();
    state.devices = state.devices.filter((device) => device.deviceId !== scopedId);
    state.devices.push({
      deviceId: scopedId, tokenDigest: digest(token), protocolVersion,
      status: 'active', enrolledAt: this.now().toISOString(), rotatedAt: null, revokedAt: null,
      pendingTokenDigest: null, pendingTokenExpiresAt: null,
    });
    return { deviceId: scopedId, token, protocolVersion };
  });
}
```

继续在 class 中加入完整认证、两阶段轮换、撤销和状态实现：

```js
authenticateState(state, { deviceId, token, protocolVersion, pendingOnly = false }) {
  const scopedId = assertDeviceId(deviceId);
  assertSupportedDeviceProtocol(protocolVersion);
  if (typeof token !== 'string' || token.length === 0) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  const tokenDigest = digest(token);
  const now = this.now();
  const device = state.devices.find((item) => {
    const currentMatch = !pendingOnly && digestsMatch(item.tokenDigest, tokenDigest);
    const pendingMatch = item.pendingTokenDigest
      && new Date(item.pendingTokenExpiresAt) >= now
      && digestsMatch(item.pendingTokenDigest, tokenDigest);
    return currentMatch || pendingMatch;
  });
  if (!device) throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  if (device.deviceId !== scopedId) {
    throw new LinkeError(ERROR_CODES.DEVICE_SCOPE_MISMATCH, { statusCode: 403 });
  }
  if (device.status === 'revoked') {
    throw new LinkeError(ERROR_CODES.DEVICE_REVOKED, { statusCode: 403 });
  }
  if (device.status !== 'active') {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 403 });
  }
  return device;
}

async authenticate(request) {
  const state = await this.readState();
  const device = this.authenticateState(state, request);
  return { deviceId: device.deviceId, protocolVersion: device.protocolVersion };
}

async beginTokenRotation(request) {
  return this.mutate(async (state) => {
    const device = this.authenticateState(state, request);
    const token = this.randomToken();
    device.pendingTokenDigest = digest(token);
    device.pendingTokenExpiresAt = new Date(this.now().getTime() + ENROLLMENT_TTL_MS).toISOString();
    return { deviceId: device.deviceId, token, expiresAt: device.pendingTokenExpiresAt };
  });
}

async confirmTokenRotation(request) {
  return this.mutate(async (state) => {
    const device = this.authenticateState(state, { ...request, pendingOnly: true });
    device.tokenDigest = device.pendingTokenDigest;
    device.pendingTokenDigest = null;
    device.pendingTokenExpiresAt = null;
    device.rotatedAt = this.now().toISOString();
    return { deviceId: device.deviceId, rotated: true };
  });
}

async revokeDevice(deviceId) {
  const scopedId = assertDeviceId(deviceId);
  return this.mutate(async (state) => {
    const device = state.devices.find((item) => item.deviceId === scopedId);
    if (!device) throw new LinkeError(ERROR_CODES.DEVICE_NOT_FOUND, { statusCode: 404 });
    device.status = 'revoked';
    device.revokedAt = this.now().toISOString();
    device.pendingTokenDigest = null;
    device.pendingTokenExpiresAt = null;
    return { deviceId: scopedId, revoked: true };
  });
}

async getStatus() {
  const state = await this.readState();
  return {
    active: state.devices.filter((device) => device.status === 'active').length,
    revoked: state.devices.filter((device) => device.status === 'revoked').length,
    suspended: state.devices.filter((device) => device.status === 'suspended').length,
  };
}

async verifyControllerFingerprint(fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 400 });
  }
  const state = await this.readState();
  if (state.controllerTlsFingerprint === fingerprint) return true;
  if (state.controllerTlsFingerprint || state.devices.length > 0) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 409 });
  }
  await this.mutate(async (freshState) => {
    if ((freshState.controllerTlsFingerprint && freshState.controllerTlsFingerprint !== fingerprint)
      || (!freshState.controllerTlsFingerprint && freshState.devices.length > 0)) {
      throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 409 });
    }
    freshState.controllerTlsFingerprint = fingerprint;
    return true;
  });
  return true;
}

async acceptControllerFingerprint(fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 400 });
  }
  return this.mutate(async (state) => {
    state.controllerTlsFingerprint = fingerprint;
    for (const device of state.devices) {
      if (device.status === 'active') {
        device.status = 'suspended';
        device.pendingTokenDigest = null;
        device.pendingTokenExpiresAt = null;
      }
    }
    return { accepted: true, suspended: state.devices.filter((device) => device.status === 'suspended').length };
  });
}
```

`authenticateState` 必须先按 token digest 找到服务端绑定设备，再比较请求 `deviceId`，从而把“未知 token”和“已知 token 越权”分别映射为 `device-token-invalid` 与 `device-scope-mismatch`。两阶段轮换中，旧 token 在 confirm 前继续有效；pending token 有十分钟期限并可完成 confirm。端点 Keychain 写入失败时不调用 confirm，因此旧 token 不会提前失效。controller fingerprint 改变必须先显式调用 `acceptControllerFingerprint`，该操作暂停所有 active 设备，设备只有用新 fingerprint 重新 enrollment 才恢复 active。

- [ ] **Step 5: 运行 GREEN、并发复验与泄漏扫描**

Run: `node --test test/error-codes.test.js test/device-protocol.test.js test/device-registry.test.js`

Expected: PASS；并发 consume 恰好一个成功。

Run: `rg -n '"(code|token)"\s*:' test/fixtures data 2>/dev/null || true`

Expected: 没有由测试留下的 plaintext enrollment/token fixture。

- [ ] **Step 6: PM 复检并提交**

Run: `git diff --check && git diff -- src/device-registry.js test/device-registry.test.js`

PM 必查：每个 mutation 都经过 queue、state 不含 plaintext、token scope 由服务端绑定、协议验证在签发与认证两端都执行。

PM commit: `feat: add digest-only device enrollment registry`

---

### Task 5: Isolated Agent HTTPS Listener

**Files:**
- Create: `src/agent-listener.js`
- Create: `test/agent-listener.test.js`

**Interfaces:**
- Consumes: Task 3 identity `{ keyPem, certPem }` and Task 4 `DeviceRegistry`。
- Produces: `createAgentListener({ identity, registry, onHeartbeat, rateLimit })` returning a Node HTTPS server。
- Routes: `POST /agent/enroll`、`POST /agent/heartbeat`、`POST /agent/token/rotate`、`POST /agent/token/rotate/confirm`；其它 `/agent/*` paths return 404。
- Public error shape: `{ error: <registered-code> }`；body limit 64 KiB。

- [ ] **Step 1: 写 HTTPS 路由、协议、scope、撤销与脱敏 RED 测试**

创建 `test/agent-listener.test.js`。测试使用 Task 3 真实 OpenSSL 证书与临时 registry，通过 `https.request` 访问临时端口：

```js
it('enrolls once, authenticates heartbeat and rotates the token', async () => {
  const issued = await registry.issueEnrollment({ deviceId: 'mac-alpha' });
  const enrolled = await postAgent('/agent/enroll', {
    deviceId: 'mac-alpha', protocolVersion: 2, enrollmentCode: issued.code,
  });
  assert.strictEqual(enrolled.status, 201);
  assert.match(enrolled.body.deviceToken, /^[A-Za-z0-9_-]{43}$/);

  const heartbeat = await postAgent('/agent/heartbeat', {
    deviceId: 'mac-alpha', protocolVersion: 2, hostname: 'alpha.local',
  }, enrolled.body.deviceToken);
  assert.strictEqual(heartbeat.status, 200);
  assert.deepStrictEqual(heartbeat.body, { deviceId: 'mac-alpha', accepted: true });

  const rotated = await postAgent('/agent/token/rotate', {
    deviceId: 'mac-alpha', protocolVersion: 2,
  }, enrolled.body.deviceToken);
  assert.strictEqual(rotated.status, 200);
  assert.match(rotated.body.deviceToken, /^[A-Za-z0-9_-]{43}$/);

  const oldBeforeConfirm = await postAgent('/agent/heartbeat', {
    deviceId: 'mac-alpha', protocolVersion: 2,
  }, enrolled.body.deviceToken);
  assert.strictEqual(oldBeforeConfirm.status, 200);

  const confirmed = await postAgent('/agent/token/rotate/confirm', {
    deviceId: 'mac-alpha', protocolVersion: 2,
  }, rotated.body.deviceToken);
  assert.strictEqual(confirmed.status, 200);
  assert.deepStrictEqual(confirmed.body, { deviceId: 'mac-alpha', rotated: true });

  const oldToken = await postAgent('/agent/heartbeat', {
    deviceId: 'mac-alpha', protocolVersion: 2,
  }, enrolled.body.deviceToken);
  assert.strictEqual(oldToken.status, 401);
  assert.deepStrictEqual(oldToken.body, { error: 'device-token-invalid' });
});

it('rejects scope mismatch, revoked devices and unsupported protocol', async () => {
  const { token } = await enrollFixture(registry, 'mac-alpha');
  const wrongScope = await postAgent('/agent/heartbeat', {
    deviceId: 'mac-beta', protocolVersion: 2,
  }, token);
  assert.strictEqual(wrongScope.status, 403);
  assert.deepStrictEqual(wrongScope.body, { error: 'device-scope-mismatch' });

  const futureProtocol = await postAgent('/agent/heartbeat', {
    deviceId: 'mac-alpha', protocolVersion: 3,
  }, token);
  assert.strictEqual(futureProtocol.status, 426);
  assert.deepStrictEqual(futureProtocol.body, { error: 'device-protocol-unsupported' });

  await registry.revokeDevice('mac-alpha');
  const revoked = await postAgent('/agent/heartbeat', {
    deviceId: 'mac-alpha', protocolVersion: 2,
  }, token);
  assert.strictEqual(revoked.status, 403);
  assert.deepStrictEqual(revoked.body, { error: 'device-revoked' });
});

it('has no Web/admin routes and never echoes secret or raw failure text', async () => {
  for (const path of ['/', '/api/health', '/agent/upload', '/agent/restore']) {
    const response = await requestAgent('GET', path);
    assert.strictEqual(response.status, 404);
  }
  const response = await postAgent('/agent/enroll', {
    deviceId: 'mac-alpha', protocolVersion: 2, enrollmentCode: 'private-enrollment-value',
  });
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /private-enrollment-value|Keychain|openssl|\/Users\//i);
});

it('bounds body size, rejects invalid JSON and requires bearer auth', async () => {
  const oversized = await postAgentRaw('/agent/enroll', 'x'.repeat(MAX_AGENT_JSON_BODY_BYTES + 1));
  assert.strictEqual(oversized.status, 413);
  assert.deepStrictEqual(oversized.body, { error: 'device-request-invalid' });
  const invalid = await postAgentRaw('/agent/enroll', '{broken');
  assert.strictEqual(invalid.status, 400);
  assert.deepStrictEqual(invalid.body, { error: 'device-request-invalid' });
  const missingBearer = await postAgent('/agent/heartbeat', {
    deviceId: 'mac-alpha', protocolVersion: 2,
  });
  assert.strictEqual(missingBearer.status, 401);
  assert.deepStrictEqual(missingBearer.body, { error: 'device-token-invalid' });
});

it('accepts N-1 and rate-limits without queueing', async () => {
  const { token } = await enrollFixture(registry, 'mac-n-minus-one', 1);
  const accepted = await postAgent('/agent/heartbeat', {
    deviceId: 'mac-n-minus-one', protocolVersion: 1,
  }, token);
  assert.strictEqual(accepted.status, 200);

  const limitedServer = await startAgentFixture({
    rateLimit: { check: () => ({ allowed: false, retryAfterMs: 1_000 }) },
  });
  const startedAt = Date.now();
  const limited = await limitedServer.post('/agent/enroll', {
    deviceId: 'mac-limited', protocolVersion: 2, enrollmentCode: 'unused',
  });
  assert.strictEqual(limited.status, 429);
  assert.deepStrictEqual(limited.body, { error: 'device-rate-limited' });
  assert.ok(Date.now() - startedAt < 500);
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test test/agent-listener.test.js`

Expected: FAIL，Agent listener 模块不存在。

- [ ] **Step 3: 实现独立 HTTPS server、body gate 和固定路由**

创建 `src/agent-listener.js`，入口形状固定如下：

```js
import { createServer as createHttpsServer } from 'node:https';
import { ERROR_CODES, LinkeError } from './error-codes.js';

export const MAX_AGENT_JSON_BODY_BYTES = 64 * 1024;

function sendJson(res, statusCode, body) {
  const serialized = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
  });
  res.end(serialized);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : '';
}

async function readAgentBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_AGENT_JSON_BODY_BYTES) {
      throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
}

function normalizeHostname(value) {
  if (value === undefined) return 'unknown';
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  return value;
}

/** Create the TLS-only device listener; no Web or management routes are mounted. */
export function createAgentListener({ identity, registry, onHeartbeat = async () => {}, rateLimit } = {}) {
  if (!identity?.keyPem || !identity?.certPem || !registry) throw new Error('identity and registry are required');
  const server = createHttpsServer({
    key: identity.keyPem, cert: identity.certPem, minVersion: 'TLSv1.2',
  }, async (req, res) => {
    try {
      if (rateLimit && !rateLimit.check(req.socket.remoteAddress || 'unknown').allowed) {
        throw new LinkeError(ERROR_CODES.DEVICE_RATE_LIMITED, { statusCode: 429, retryable: true });
      }
      if (req.method === 'POST' && req.url === '/agent/enroll') {
        const body = await readAgentBody(req);
        const result = await registry.consumeEnrollment({
          deviceId: body.deviceId,
          code: body.enrollmentCode,
          protocolVersion: body.protocolVersion,
        });
        return sendJson(res, 201, {
          deviceId: result.deviceId,
          deviceToken: result.token,
          protocolVersion: result.protocolVersion,
        });
      }
      if (req.method === 'POST' && req.url === '/agent/heartbeat') {
        const body = await readAgentBody(req);
        const device = await registry.authenticate({
          deviceId: body.deviceId,
          token: bearerToken(req),
          protocolVersion: body.protocolVersion,
        });
        await onHeartbeat({
          deviceId: device.deviceId,
          hostname: normalizeHostname(body.hostname),
          remoteAddress: req.socket.remoteAddress || 'unknown',
        });
        return sendJson(res, 200, { deviceId: device.deviceId, accepted: true });
      }
      if (req.method === 'POST' && req.url === '/agent/token/rotate') {
        const body = await readAgentBody(req);
        const result = await registry.beginTokenRotation({
          deviceId: body.deviceId,
          token: bearerToken(req),
          protocolVersion: body.protocolVersion,
        });
        return sendJson(res, 200, { deviceId: result.deviceId, deviceToken: result.token });
      }
      if (req.method === 'POST' && req.url === '/agent/token/rotate/confirm') {
        const body = await readAgentBody(req);
        const result = await registry.confirmTokenRotation({
          deviceId: body.deviceId,
          token: bearerToken(req),
          protocolVersion: body.protocolVersion,
        });
        return sendJson(res, 200, { deviceId: result.deviceId, rotated: result.rotated });
      }
      return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
    } catch (error) {
      const code = error instanceof LinkeError && Object.values(ERROR_CODES).includes(error.code)
        ? error.code
        : ERROR_CODES.DEVICE_INTERNAL_ERROR;
      const statusCode = error instanceof LinkeError ? error.statusCode : 500;
      return sendJson(res, statusCode, { error: code });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}
```

Task 1 已注册 `DEVICE_INTERNAL_ERROR`、`DEVICE_ROUTE_NOT_FOUND`、`DEVICE_REQUEST_INVALID`、`DEVICE_RATE_LIMITED`；本任务的 body/JSON/rate-limit/internal failure 分别使用这些精确码，不能复用 token/scope 错误掩盖原因。

- [ ] **Step 4: 运行 GREEN 与 listener 隔离回归**

Run: `node --test test/error-codes.test.js test/device-protocol.test.js test/device-registry.test.js test/agent-listener.test.js`

Expected: PASS；N-1 和 current 均可 heartbeat，future/older 均 426；Web/admin path 均 404。

- [ ] **Step 5: PM 复检并提交**

Run: `git diff --check && git diff -- src/error-codes.js src/agent-listener.js test/error-codes.test.js test/agent-listener.test.js`

PM 必查：`createHttpsServer` 而非 HTTP、没有 static handler、未把管理 token 当设备 token、错误响应只含注册 code。

PM commit: `feat: add isolated Agent HTTPS listener`

---

### Task 6: Loopback Device Administration Routes

**Files:**
- Modify: `src/server.js`
- Modify: `test/health.test.js`
- Modify: `test/security.test.js`
- Modify: `test/server.test.js`
- Modify: `test/supervisor-lifecycle-executor-readiness-api.test.js`
- Modify: `test/supervisor-lifecycle-executor-manifest-readiness-api.test.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-readiness-api.test.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`

**Interfaces:**
- Consumes injected `deviceAdministration` with `issueEnrollment`、`revokeDevice`、`getStatus` and public `agentUrl`/`tlsFingerprint`。
- Produces: `POST /api/device-enrollment-codes`、`POST /api/device-revoke` and `GET /api/agent-listener-status`。
- Both POST routes enter `API_WRITE_ROUTES`; both additionally require configured full/write token even when legacy API auth is otherwise disabled。

- [ ] **Step 1: 写管理授权、一次性返回与状态脱敏 RED 测试**

在 `test/security.test.js` 增加独立 server fixture 和以下断言：

```js
it('requires a configured admin-capable token for device enrollment', async () => {
  const deviceAdministration = {
    issueEnrollment: async () => ({ code: 'one-time-code', expiresAt: '2026-07-13T00:10:00.000Z' }),
    revokeDevice: async () => {},
    getStatus: async () => ({ active: 0, revoked: 0 }),
    agentUrl: 'https://linke-controller.local:3443',
    tlsFingerprint: 'a'.repeat(64),
  };
  await withServer({ deviceAdministration }, async (port) => {
    const response = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' });
    assert.strictEqual(response.status, 503);
    assert.deepStrictEqual(await response.json(), { error: 'auth-admin-required' });
  });
});

it('rejects null or missing device ids before calling administration services', async () => {
  let called = false;
  const deviceAdministration = {
    issueEnrollment: async () => { called = true; },
    revokeDevice: async () => { called = true; },
    getStatus: async () => ({ active: 0, revoked: 0 }),
    agentUrl: 'https://linke-controller.local:3443',
    tlsFingerprint: 'a'.repeat(64),
  };
  await withServer({ deviceAdministration, writeToken: 'admin-write' }, async (port) => {
    for (const path of ['/api/device-enrollment-codes', '/api/device-revoke']) {
      for (const body of [null, {}, { deviceId: 42 }]) {
        const response = await postJson(port, path, body, 'admin-write');
        assert.strictEqual(response.status, 400);
        assert.deepStrictEqual(await response.json(), { error: 'device-request-invalid' });
      }
    }
  });
  assert.strictEqual(called, false);
});

it('allows write token, rejects read token, and returns the code exactly once', async () => {
  let issueCount = 0;
  const deviceAdministration = {
    issueEnrollment: async ({ deviceId }) => {
      issueCount += 1;
      return { deviceId, code: `code-${issueCount}`, expiresAt: '2026-07-13T00:10:00.000Z' };
    },
    revokeDevice: async () => {},
    getStatus: async () => ({ active: 0, revoked: 0 }),
    agentUrl: 'https://linke-controller.local:3443',
    tlsFingerprint: 'a'.repeat(64),
  };
  await withServer({ deviceAdministration, readToken: 'read-only', writeToken: 'admin-write' }, async (port) => {
    const denied = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, 'read-only');
    assert.strictEqual(denied.status, 403);
    const allowed = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, 'admin-write');
    assert.strictEqual(allowed.status, 201);
    assert.strictEqual(allowed.headers.get('cache-control'), 'no-store');
    const body = await allowed.json();
    assert.deepStrictEqual(body, {
      deviceId: 'mac-alpha', enrollmentCode: 'code-1',
      expiresAt: '2026-07-13T00:10:00.000Z',
      agentUrl: 'https://linke-controller.local:3443',
      tlsFingerprint: 'a'.repeat(64), protocolVersion: 2,
    });
  });
});

it('returns only sanitized Agent listener status', async () => {
  const deviceAdministration = {
    issueEnrollment: async () => {},
    revokeDevice: async () => {},
    getStatus: async () => ({
      bindConfigured: true, listening: true, tlsFingerprintConfigured: true,
      active: 2, revoked: 1,
      host: '192.168.10.4', tlsFingerprint: 'b'.repeat(64), tokenDigest: 'c'.repeat(64),
    }),
    agentUrl: 'https://linke-controller.local:3443',
    tlsFingerprint: 'a'.repeat(64),
  };
  await withServer({ deviceAdministration, readToken: 'read-only', writeToken: 'admin-write' }, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent-listener-status`, {
      headers: { authorization: 'Bearer read-only' },
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body, {
      status: 'ok',
      listener: { bindConfigured: true, listening: true, tlsFingerprintConfigured: true },
      devices: { active: 2, revoked: 1 },
    });
    assert.doesNotMatch(JSON.stringify(body), /192\.168|linke-controller|3443|[abc]{64}|digest|token/i);
  });
});
```

在 `test/health.test.js` 把期望写路由精确更新为六项，并断言新增两个 POST；其它五个硬编码 `API_WRITE_ROUTES.length === 4` 的测试改为六项，但不改变其只读 route 断言。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/health.test.js test/security.test.js test/server.test.js test/supervisor-lifecycle-executor-readiness-api.test.js test/supervisor-lifecycle-executor-manifest-readiness-api.test.js test/supervisor-lifecycle-guarded-runner-readiness-api.test.js test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`

Expected: FAIL，新增路由不存在且 write-route 数量仍为 4。

- [ ] **Step 3: 注入 administration service 并实现固定路由**

在 `src/server.js`：

```js
import { DEVICE_PROTOCOL_VERSION } from './device-protocol.js';
import { ERROR_CODES } from './error-codes.js';

function sendNoStoreJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export const API_WRITE_ROUTES = [
  { method: 'POST', path: '/api/heartbeat' },
  { method: 'POST', path: '/api/backups' },
  { method: 'POST', path: '/api/restore' },
  { method: 'POST', path: '/api/supervisor-lifecycle-approval-persist' },
  { method: 'POST', path: '/api/device-enrollment-codes' },
  { method: 'POST', path: '/api/device-revoke' },
];

export function createServer({
  dataDir, backupHooks, authToken, readToken, writeToken, restoreRoot,
  rateLimit, auditRetention, deviceAdministration,
} = {}) {
  // existing normalization remains unchanged
}
```

在现有 auth gate 后、health route 前加入：

```js
const adminAuthConfigured = Boolean(expectedAuthToken || expectedWriteToken);

if (method === 'POST' && pathname === '/api/device-enrollment-codes') {
  if (!adminAuthConfigured) return sendError(res, 503, ERROR_CODES.AUTH_ADMIN_REQUIRED);
  if (!deviceAdministration) return sendError(res, 503, ERROR_CODES.DEVICE_REQUEST_INVALID);
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || typeof body.deviceId !== 'string') {
    return sendError(res, 400, ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  const enrollment = await deviceAdministration.issueEnrollment({ deviceId: body.deviceId });
  return sendNoStoreJSON(res, 201, {
    deviceId: enrollment.deviceId,
    enrollmentCode: enrollment.code,
    expiresAt: enrollment.expiresAt,
    agentUrl: deviceAdministration.agentUrl,
    tlsFingerprint: deviceAdministration.tlsFingerprint,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
  });
}

if (method === 'POST' && pathname === '/api/device-revoke') {
  if (!adminAuthConfigured) return sendError(res, 503, ERROR_CODES.AUTH_ADMIN_REQUIRED);
  if (!deviceAdministration) return sendError(res, 503, ERROR_CODES.DEVICE_REQUEST_INVALID);
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || typeof body.deviceId !== 'string') {
    return sendError(res, 400, ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  await deviceAdministration.revokeDevice(body.deviceId);
  return sendJSON(res, 200, { deviceId: body.deviceId, revoked: true });
}

if (method === 'GET' && pathname === '/api/agent-listener-status') {
  if (!deviceAdministration) return sendError(res, 503, ERROR_CODES.DEVICE_REQUEST_INVALID);
  const status = await deviceAdministration.getStatus();
  return sendJSON(res, 200, {
    status: status.listening ? 'ok' : 'degraded',
    listener: {
      bindConfigured: status.bindConfigured,
      listening: status.listening,
      tlsFingerprintConfigured: status.tlsFingerprintConfigured,
    },
    devices: { active: status.active, revoked: status.revoked },
  });
}
```

生产实现必须在 `deviceAdministration` 缺失时对三条新路由返回注册错误，不得产生 `TypeError` 或 500 原始文本；audit 只记录 route、status、outcome、requestId、脱敏 deviceId，不记录 response body。

- [ ] **Step 4: 运行 GREEN 与管理面完整回归**

Run: `node --test test/health.test.js test/security.test.js test/server.test.js test/heartbeat.test.js test/agent-auth-status.test.js test/agent-hardening-status.test.js test/supervisor-lifecycle-*-api.test.js`

Expected: PASS；旧 API auth 语义不变，新 enrollment/revoke 必须使用 admin-capable token。

- [ ] **Step 5: PM 复检并提交**

Run: `git diff --check && git diff --stat && rg -n "enrollmentCode|tlsFingerprint|tokenDigest|codeDigest" src/server.js src/audit-log.js`

Expected: `enrollmentCode` 只出现在一次性成功 response 构造；audit 和 status 不含任何 code/token/fingerprint 值。

PM commit: `feat: add loopback device administration routes`

---

### Task 7: Certificate-Pinned Endpoint Client and Secret-Safe CLI

**Files:**
- Create: `src/device-client.js`
- Modify: `src/agent.js`
- Create: `test/device-client.test.js`

**Interfaces:**
- Consumes: Task 1 protocol and Task 2 `KeychainStore`。
- Produces: `DeviceCredentialStore`、`requestPinnedJson(options)`、`enrollDevice(options)`、`heartbeatDevice(options)`、`rotateDeviceToken(options)`。
- CLI: `device-enroll`、`device-heartbeat`、`device-token-rotate`；exported command runners accept injected stdin/credential store for tests，enrollment code only from stdin, device token only from Keychain。

- [ ] **Step 1: 写 pin-before-secret、Keychain 和 CLI 脱敏 RED 测试**

创建 `test/device-client.test.js`，从 `node:stream` import `Readable`，使用两个不同自签名 HTTPS server 和内存 Keychain：

```js
it('does not send enrollment code when the TLS fingerprint mismatches', async () => {
  let requestCount = 0;
  const server = await startHttpsFixture(() => { requestCount += 1; });
  await assert.rejects(
    enrollDevice({
      agentUrl: server.url,
      tlsFingerprint: '0'.repeat(64),
      deviceId: 'mac-alpha',
      enrollmentCode: 'must-not-cross-wrong-tls',
      credentialStore: memoryCredentialStore(),
    }),
    (error) => error.code === 'device-tls-fingerprint-mismatch',
  );
  assert.strictEqual(requestCount, 0);
});

it('stores the returned token in Keychain and never returns it to the caller', async () => {
  const credentialStore = memoryCredentialStore();
  const server = await startHttpsFixture((req, res) => {
    sendJson(res, 201, { deviceId: 'mac-alpha', deviceToken: 'endpoint-secret-token', protocolVersion: 2 });
  });
  const result = await enrollDevice({
    agentUrl: server.url,
    tlsFingerprint: server.fingerprint,
    deviceId: 'mac-alpha',
    enrollmentCode: 'single-use-code',
    credentialStore,
  });
  assert.deepStrictEqual(result, { deviceId: 'mac-alpha', enrolled: true, protocolVersion: 2 });
  assert.strictEqual(await credentialStore.getToken(server.url, 'mac-alpha'), 'endpoint-secret-token');
  assert.ok(!JSON.stringify(result).includes('endpoint-secret-token'));
});

it('keeps the old token if rotation fails and replaces it only after success', async () => {
  const credentialStore = memoryCredentialStore();
  let shouldFail = true;
  const server = await startHttpsFixture((req, res) => {
    if (req.url === '/agent/token/rotate' && shouldFail) {
      return sendJson(res, 503, { error: 'device-request-invalid' });
    }
    if (req.url === '/agent/token/rotate') {
      return sendJson(res, 200, { deviceId: 'mac-alpha', deviceToken: 'n'.repeat(43) });
    }
    if (req.url === '/agent/token/rotate/confirm') {
      return sendJson(res, 200, { deviceId: 'mac-alpha', rotated: true });
    }
    return sendJson(res, 404, { error: 'device-route-not-found' });
  });
  await credentialStore.setToken(server.url, 'mac-alpha', 'old-token');
  await assert.rejects(rotateDeviceToken({
    agentUrl: server.url, tlsFingerprint: server.fingerprint,
    deviceId: 'mac-alpha', credentialStore,
  }));
  assert.strictEqual(await credentialStore.getToken(server.url, 'mac-alpha'), 'old-token');

  shouldFail = false;
  const result = await rotateDeviceToken({
    agentUrl: server.url, tlsFingerprint: server.fingerprint,
    deviceId: 'mac-alpha', credentialStore,
  });
  assert.deepStrictEqual(result, { deviceId: 'mac-alpha', rotated: true });
  assert.strictEqual(await credentialStore.getToken(server.url, 'mac-alpha'), 'n'.repeat(43));
});

it('CLI reads enrollment code from stdin and never prints code or token', async () => {
  const output = [];
  const result = await runDeviceEnrollCommand({
    server: 'https://controller.invalid:3443', device: 'mac-alpha',
    'tls-fingerprint': 'a'.repeat(64), 'enrollment-code-stdin': true,
  }, {
    input: Readable.from(['cli-one-time-code\n']),
    credentialStore: memoryCredentialStore(),
    enroll: async (options) => {
      assert.strictEqual(options.enrollmentCode, 'cli-one-time-code');
      return { deviceId: 'mac-alpha', enrolled: true, protocolVersion: 2 };
    },
    writeOutput: (value) => output.push(JSON.stringify(value)),
  });
  assert.deepStrictEqual(result, {
    deviceId: 'mac-alpha', enrolled: true, protocolVersion: 2,
  });
  assert.doesNotMatch(output.join(''), /cli-one-time-code|endpoint-secret-token/);
});

it('rejects unsafe URL and fingerprint before opening a request', async () => {
  for (const agentUrl of ['http://controller.local:3443', 'https://user:pass@controller.local:3443']) {
    assert.throws(() => requestPinnedJson({
      agentUrl, path: '/agent/enroll', tlsFingerprint: 'a'.repeat(64), body: {},
    }), (error) => error.code === 'device-tls-bind-invalid');
  }
  for (const tlsFingerprint of [undefined, '', 'aa:bb', 'g'.repeat(64)]) {
    assert.throws(() => requestPinnedJson({
      agentUrl: 'https://controller.invalid:3443',
      path: '/agent/enroll', tlsFingerprint, body: {},
    }), (error) => error.code === 'device-tls-fingerprint-mismatch');
  }
});

it('rejects argv secrets and empty enrollment stdin before Keychain access', async () => {
  const forbiddenArgs = {
    server: 'https://controller.invalid:3443', device: 'mac-alpha',
    'tls-fingerprint': 'a'.repeat(64), 'enrollment-code-stdin': true,
    'enrollment-code': 'argv-secret',
  };
  await assert.rejects(
    runDeviceEnrollCommand(forbiddenArgs, { input: Readable.from(['stdin-secret\n']) }),
    /accepts secrets from stdin and Keychain only/,
  );
  await assert.rejects(runDeviceEnrollCommand({
    server: 'https://controller.invalid:3443', device: 'mac-alpha',
    'tls-fingerprint': 'a'.repeat(64), 'enrollment-code-stdin': true,
  }, { input: Readable.from([]), credentialStore: memoryCredentialStore() }), /stdin secret is invalid/);
  await assert.rejects(runDeviceEnrollCommand({
    server: 'https://controller.invalid:3443', device: 'mac-alpha',
    'tls-fingerprint': 'a'.repeat(64), 'enrollment-code-stdin': true,
  }, {
    input: Readable.from(['x'.repeat(4_097)]), credentialStore: memoryCredentialStore(),
  }), /stdin secret is invalid/);
  await assert.rejects(runDeviceHeartbeatCommand({ token: 'argv-secret' }), /reads the token from Keychain/);
  await assert.rejects(runDeviceTokenRotateCommand({ token: 'argv-secret' }), /reads the token from Keychain/);
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test test/device-client.test.js`

Expected: FAIL，client 模块和 CLI command 不存在。

- [ ] **Step 3: 实现证书 pin 和 endpoint credential key**

创建 `src/device-client.js`。Keychain account 由公开 URL/deviceId 的 SHA-256 前 32 hex 派生，不包含原始 host；TLS request 在 `secureConnect` 校验成功前不得 `req.end(body)`：

```js
import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { DEVICE_PROTOCOL_VERSION } from './device-protocol.js';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from './error-codes.js';

function normalizeFingerprint(value) {
  const normalized = String(value || '').replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 400 });
  }
  return normalized;
}

function parseAgentUrl(agentUrl) {
  const url = new URL(agentUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_BIND_INVALID, { statusCode: 400 });
  }
  return url;
}

/** Keychain-backed endpoint token store; item names contain no host or token material. */
export class DeviceCredentialStore {
  constructor({ keychain }) {
    if (!keychain) throw new Error('keychain is required');
    this.keychain = keychain;
  }

  itemId(agentUrl, deviceId) {
    const id = createHash('sha256').update(`${agentUrl}\0${deviceId}`).digest('hex').slice(0, 32);
    return `device-token.${id}`;
  }

  getToken(agentUrl, deviceId) {
    return this.keychain.get(this.itemId(agentUrl, deviceId));
  }

  setToken(agentUrl, deviceId, token) {
    return this.keychain.set(this.itemId(agentUrl, deviceId), token);
  }
}

/** POST JSON only after the peer certificate exactly matches the approved SHA-256 pin. */
export function requestPinnedJson({ agentUrl, path, tlsFingerprint, body, token, timeoutMs = 10_000 }) {
  const url = parseAgentUrl(agentUrl);
  const expected = Buffer.from(normalizeFingerprint(tlsFingerprint), 'hex');
  const serialized = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let pinned = false;
    const req = httpsRequest({
      protocol: 'https:', hostname: url.hostname, port: url.port || 443,
      path, method: 'POST', agent: false, rejectUnauthorized: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(serialized),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        if (!pinned) return reject(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
        let response;
        try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reject(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID)); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let publicCode;
          try { publicCode = assertRegisteredErrorCode(response.error); }
          catch { publicCode = ERROR_CODES.DEVICE_REQUEST_INVALID; }
          return reject(new LinkeError(publicCode, { statusCode: res.statusCode }));
        }
        resolve(response);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID)));
    req.once('error', (error) => reject(error instanceof LinkeError
      ? error : new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID)));
    req.once('socket', (socket) => socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate(true)?.raw;
      const actual = raw ? createHash('sha256').update(raw).digest() : Buffer.alloc(0);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return req.destroy(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
      }
      pinned = true;
      req.end(serialized);
    }));
  });
}
```

同一文件加入三个高层操作：

```js
export async function enrollDevice({
  agentUrl, tlsFingerprint, deviceId, enrollmentCode, credentialStore,
}) {
  const response = await requestPinnedJson({
    agentUrl, path: '/agent/enroll', tlsFingerprint,
    body: { deviceId, protocolVersion: DEVICE_PROTOCOL_VERSION, enrollmentCode },
  });
  if (response.deviceId !== deviceId
    || response.protocolVersion !== DEVICE_PROTOCOL_VERSION
    || typeof response.deviceToken !== 'string'
    || response.deviceToken.length < 32) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  await credentialStore.setToken(agentUrl, deviceId, response.deviceToken);
  return { deviceId, enrolled: true, protocolVersion: response.protocolVersion };
}

export async function heartbeatDevice({
  agentUrl, tlsFingerprint, deviceId, hostname, credentialStore,
}) {
  const token = await credentialStore.getToken(agentUrl, deviceId);
  const response = await requestPinnedJson({
    agentUrl, path: '/agent/heartbeat', tlsFingerprint, token,
    body: { deviceId, protocolVersion: DEVICE_PROTOCOL_VERSION, hostname },
  });
  if (response.deviceId !== deviceId || response.accepted !== true) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  return { deviceId, accepted: true };
}

export async function rotateDeviceToken({
  agentUrl, tlsFingerprint, deviceId, credentialStore,
}) {
  const currentToken = await credentialStore.getToken(agentUrl, deviceId);
  const pending = await requestPinnedJson({
    agentUrl, path: '/agent/token/rotate', tlsFingerprint, token: currentToken,
    body: { deviceId, protocolVersion: DEVICE_PROTOCOL_VERSION },
  });
  if (pending.deviceId !== deviceId
    || typeof pending.deviceToken !== 'string'
    || pending.deviceToken.length < 32) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  await credentialStore.setToken(agentUrl, deviceId, pending.deviceToken);
  const confirmed = await requestPinnedJson({
    agentUrl, path: '/agent/token/rotate/confirm', tlsFingerprint, token: pending.deviceToken,
    body: { deviceId, protocolVersion: DEVICE_PROTOCOL_VERSION },
  });
  if (confirmed.deviceId !== deviceId || confirmed.rotated !== true) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  return { deviceId, rotated: true };
}
```

begin 请求失败时 Keychain 保留旧 token；Keychain 写失败时服务端旧 token 仍有效且不会 confirm；confirm 请求失败时 Keychain 已持有仍在十分钟窗口内有效的 pending token，可安全重试。

- [ ] **Step 4: 在 Agent CLI 增加三条无 argv secret 命令**

在 `src/agent.js` import `KeychainStore`、`DeviceCredentialStore` 和三个 client operation。新增 stdin helper，并把命令主体导出为可注入测试的 `runDeviceEnrollCommand`/`runDeviceHeartbeatCommand`/`runDeviceTokenRotateCommand`；`main()` 只负责构造生产 Keychain adapter 和输出函数：

```js
async function readSingleSecretLine(input = process.stdin) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 4_096) throw new Error('stdin secret is invalid');
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!value || value.includes('\n') || value.includes('\r')) throw new Error('stdin secret is invalid');
  return value;
}

export async function runDeviceEnrollCommand(args, {
  input = process.stdin,
  credentialStore = new DeviceCredentialStore({ keychain: new KeychainStore() }),
  enroll = enrollDevice,
  writeOutput = (value) => console.log(JSON.stringify(value, null, 2)),
} = {}) {
  if (args['enrollment-code'] !== undefined || args.token !== undefined) {
    throw new Error('device-enroll accepts secrets from stdin and Keychain only');
  }
  if (args['enrollment-code-stdin'] !== true) throw new Error('--enrollment-code-stdin is required');
  const result = await enroll({
    agentUrl: args.server,
    tlsFingerprint: args['tls-fingerprint'],
    deviceId: args.device,
    enrollmentCode: await readSingleSecretLine(input),
    credentialStore,
  });
  writeOutput(result);
  return result;
}

export async function runDeviceHeartbeatCommand(args, {
  credentialStore = new DeviceCredentialStore({ keychain: new KeychainStore() }),
  heartbeat = heartbeatDevice,
  writeOutput = (value) => console.log(JSON.stringify(value, null, 2)),
} = {}) {
  if (args.token !== undefined) throw new Error('device-heartbeat reads the token from Keychain');
  const result = await heartbeat({
    agentUrl: args.server,
    tlsFingerprint: args['tls-fingerprint'],
    deviceId: args.device,
    hostname: args.hostname,
    credentialStore,
  });
  writeOutput(result);
  return result;
}

export async function runDeviceTokenRotateCommand(args, {
  credentialStore = new DeviceCredentialStore({ keychain: new KeychainStore() }),
  rotate = rotateDeviceToken,
  writeOutput = (value) => console.log(JSON.stringify(value, null, 2)),
} = {}) {
  if (args.token !== undefined) throw new Error('device-token-rotate reads the token from Keychain');
  const result = await rotate({
    agentUrl: args.server,
    tlsFingerprint: args['tls-fingerprint'],
    deviceId: args.device,
    credentialStore,
  });
  writeOutput(result);
  return result;
}
```

在 `main()` switch 增加：

```js
case 'device-enroll': {
  await runDeviceEnrollCommand(args);
  break;
}
case 'device-heartbeat': {
  await runDeviceHeartbeatCommand(args);
  break;
}
case 'device-token-rotate': {
  await runDeviceTokenRotateCommand(args);
  break;
}
```

help 文本必须明确 `--server` 仅接受 HTTPS Agent URL、`--tls-fingerprint` 是管理员通过独立渠道确认的 64 hex、enrollment code 从 stdin 读取、token 永不接受 CLI 参数。

- [ ] **Step 5: 运行 GREEN 与既有 Agent CLI 回归**

Run: `node --test test/device-client.test.js test/agent-run-once.test.js test/agent-health.test.js test/agent-auth-status.test.js test/agent-nas-snapshot-replicate.test.js`

Expected: PASS；既有管理面 `--token` 行为保持兼容，但三条设备命令拒绝 `--token`。

- [ ] **Step 6: PM 复检并提交**

Run: `git diff --check && rg -n "rejectUnauthorized:false|req\.end|secureConnect|enrollment-code|deviceToken|console\.log" src/device-client.js src/agent.js`

PM 必查：唯一的 `rejectUnauthorized:false` 紧邻强制 fingerprint pin；`req.end` 只在 pin 成功后；stdout 对象不含 code/token。

PM commit: `feat: add certificate-pinned device enrollment client`

---

### Task 8: Dual-Listener Controller Runtime and G0a Acceptance

**Files:**
- Create: `src/controller-runtime.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `test/readme.test.js`
- Modify: `src/server.js`
- Modify: `src/agent-listener.js`
- Modify: `src/storage.js`
- Create: `test/controller-runtime.test.js`
- Modify: `test/heartbeat.test.js`
- Create after explicit real test: `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md`

**Interfaces:**
- Consumes: Tasks 2–7 and existing `recordHeartbeat(dataDir, deviceId, hostname, ipAddress)`。
- Produces: `startController(options)` returning `{ managementServer, agentServer, status, close() }`。
- Standalone config: management defaults `127.0.0.1:3000`; Agent listener requires explicit `LINKE_AGENT_HOST` and defaults `LINKE_AGENT_PORT=3443`；fingerprint 改变只有显式 `LINKE_ACCEPT_TLS_FINGERPRINT_CHANGE=enabled` 才能暂停旧设备并启动重新 enrollment。

- [ ] **Step 1: 写双 listener、启动补偿、关闭和真实 heartbeat RED 测试**

创建 `test/controller-runtime.test.js`：

```js
it('starts management on loopback and Agent HTTPS on the explicit private bind', async () => {
  const runtime = await startController({
    dataDir,
    managementHost: '127.0.0.1', managementPort: 0,
    agentHost: '192.168.10.4', agentPort: 3443,
    keychain: memoryKeychain(),
    listenServer: createLoopbackTestListenAdapter(),
  });
  try {
    assert.strictEqual(runtime.status.managementHost, '127.0.0.1');
    assert.strictEqual(runtime.status.agentBindConfigured, true);
    assert.strictEqual(runtime.status.managementListening, true);
    assert.strictEqual(runtime.status.agentListening, true);
    assert.match(runtime.status.tlsFingerprint, /^[a-f0-9]{64}$/);
  } finally {
    await runtime.close();
  }
});

it('closes the Agent listener when management startup fails', async () => {
  const events = [];
  await assert.rejects(startController({
    dataDir,
    managementHost: '127.0.0.1', managementPort: 0,
    agentHost: '192.168.10.4', agentPort: 3443,
    keychain: memoryKeychain(),
    managementServerFactory: () => failingServer(events, 'management'),
    agentServerFactory: () => trackedServer(events, 'agent'),
  }));
  assert.deepStrictEqual(events, ['agent:listening', 'management:error', 'agent:closed']);
});

it('is idempotent when close is called twice and leaves no listening server', async () => {
  const runtime = await startRuntimeFixture();
  await Promise.all([runtime.close(), runtime.close()]);
  assert.strictEqual(runtime.status.managementListening, false);
  assert.strictEqual(runtime.status.agentListening, false);
});
```

在 `test/heartbeat.test.js` 增加真实 Agent listener heartbeat：先 enrollment，再 HTTPS heartbeat，最后从现有 `GET /api/devices` 读取相同 `deviceId`；断言存储的 IP 来源是 socket remote address，不接受 body 自报 IP。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/controller-runtime.test.js test/heartbeat.test.js`

Expected: FAIL，controller runtime 不存在。

- [ ] **Step 3: 实现启动顺序、补偿关闭和脱敏状态**

创建 `src/controller-runtime.js`，固定启动顺序为 identity→Agent server→management server；第二步之后任意失败必须关闭已启动 server：

```js
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createManagementServer } from './server.js';
import { createAgentListener } from './agent-listener.js';
import { DeviceRegistry } from './device-registry.js';
import { KeychainStore } from './keychain-store.js';
import { TlsIdentityStore } from './tls-identity-store.js';
import { recordHeartbeat } from './storage.js';
import { createFixedWindowRateLimiter } from './rate-limit.js';

function listen(server, port, host) {
  return new Promise((resolveListen, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server?.listening) return resolveClose();
    server.close(() => resolveClose());
  });
}

function formatUrlHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

/** Start the isolated Agent listener before loopback management and compensate on failure. */
export async function startController({
  dataDir,
  managementHost = '127.0.0.1', managementPort = 3000,
  agentHost, agentPort = 3443,
  authToken, readToken, writeToken,
  keychain = new KeychainStore(),
  acceptTlsFingerprintChange = false,
  agentRateLimit = { maxRequests: 60, windowMs: 60_000 },
  listenServer = listen,
  managementServerFactory = createManagementServer,
  agentServerFactory = createAgentListener,
} = {}) {
  if (!['127.0.0.1', '::1'].includes(managementHost)) throw new Error('management host must be loopback');
  const identityStore = new TlsIdentityStore({ dataDir: join(dataDir, 'tls'), keychain });
  const identity = await identityStore.ensure({ host: agentHost, port: agentPort });
  const registry = new DeviceRegistry({ dataDir });
  try {
    await registry.verifyControllerFingerprint(identity.fingerprint);
  } catch (error) {
    if (error.code !== 'device-tls-fingerprint-mismatch' || !acceptTlsFingerprintChange) throw error;
    await registry.acceptControllerFingerprint(identity.fingerprint);
  }
  const status = {
    managementHost, managementListening: false,
    agentBindConfigured: true, agentListening: false,
    tlsFingerprint: identity.fingerprint,
  };
  const agentServer = agentServerFactory({
    identity,
    registry,
    rateLimit: createFixedWindowRateLimiter(agentRateLimit),
    onHeartbeat: ({ deviceId, hostname, remoteAddress }) => (
      recordHeartbeat(dataDir, deviceId, hostname, remoteAddress)
    ),
  });
  let managementServer;
  try {
    await listenServer(agentServer, agentPort, agentHost);
    status.agentListening = true;
    const address = agentServer.address();
    const publicPort = typeof address === 'object' ? address.port : agentPort;
    const deviceAdministration = {
      issueEnrollment: (request) => registry.issueEnrollment(request),
      revokeDevice: (deviceId) => registry.revokeDevice(deviceId),
      getStatus: async () => ({
        ...await registry.getStatus(),
        bindConfigured: status.agentBindConfigured,
        listening: status.agentListening,
        tlsFingerprintConfigured: Boolean(identity.fingerprint),
      }),
      agentUrl: `https://${formatUrlHost(agentHost)}:${publicPort}`,
      tlsFingerprint: identity.fingerprint,
    };
    managementServer = managementServerFactory({
      dataDir, authToken, readToken, writeToken, deviceAdministration,
    });
    await listenServer(managementServer, managementPort, managementHost);
    status.managementListening = true;
  } catch (error) {
    await closeServer(managementServer);
    await closeServer(agentServer);
    status.managementListening = false;
    status.agentListening = false;
    throw error;
  }
  let closing;
  return {
    managementServer, agentServer, status,
    close() {
      if (!closing) closing = Promise.all([
        closeServer(managementServer), closeServer(agentServer),
      ]).then(() => {
        status.managementListening = false;
        status.agentListening = false;
      });
      return closing;
    },
  };
}
```

standalone entry point 读取既有管理 auth/rate/retention 配置和非敏感 `LINKE_AGENT_HOST`/`LINKE_AGENT_PORT`；`LINKE_AGENT_HOST` 缺失时 fail-closed 退出，不自动选择网卡。只有 `LINKE_ACCEPT_TLS_FINGERPRINT_CHANGE` 精确为 `enabled` 才向 `startController` 传 `acceptTlsFingerprintChange:true`，其它值均为 false。SIGINT/SIGTERM 调用一次 `runtime.close()`。日志只打印管理面监听状态、Agent listener 已启用和 fingerprint 的前 12 hex，不打印完整 URL、路径、token 或 Keychain 信息。

修改 `package.json`：

```json
{
  "scripts": {
    "start": "node src/controller-runtime.js",
    "test": "node --test test/*.test.js"
  }
}
```

在 `README.md` 的启动说明中把默认命令更新为 `npm start`/`node src/controller-runtime.js`，明确 `LINKE_AGENT_HOST` 必填且只能是私网地址，管理面固定 loopback；保留 `node src/server.js` 仅作为不启用设备 enrollment 的本机开发入口。`test/readme.test.js` 精确断言这四个边界，并断言文档没有把自动测试描述成真实 Keychain/双 Mac PASS。

- [ ] **Step 4: 运行 G0a 自动验收与全量回归**

Run: `node --test test/error-codes.test.js test/device-protocol.test.js test/keychain-store.test.js test/tls-identity-store.test.js test/device-registry.test.js test/agent-listener.test.js test/device-client.test.js test/controller-runtime.test.js test/heartbeat.test.js test/security.test.js test/health.test.js test/server.test.js test/readme.test.js`

Expected: PASS，真实 Keychain integration 仍默认 skip。

Run: `npm test`

Expected: 全量 PASS；既有 587 项候选基线不得减少，新增测试计数只增不减。

Run: `git diff --check && git status --short && rg -n "BEGIN .*PRIVATE KEY|enrollmentCode.*console|deviceToken.*console|tokenDigest.*send|codeDigest.*send" src test docs -g '!docs/superpowers/plans/2026-07-13-linke-gold-g0a-trust-foundation.md'`

Expected: 无私钥、code/token/digest 泄漏；只有计划内文件变化。

- [ ] **Step 5: 执行真实边界门或保持明确 blocked**

获得用户对专用测试资源的明确允许后，按顺序执行：

1. Real Keychain: `LINKE_REAL_KEYCHAIN_TEST=enabled node --test test/keychain-real.integration.test.js`
2. Keychain failure: 由用户通过 macOS UI 控制登录 Keychain 的锁定/解锁并分别观察 controller fail-closed 与恢复；用户拒绝一次权限弹窗，确认只出现 `keychain-unavailable`。Linke 测试不自动执行 `security lock-keychain`、不修改 Keychain 密码。
3. Controller Mac: 用明确私网 host 启动 controller，确认管理面只在 loopback、Agent listener 只在指定私网地址。
4. Endpoint Mac/隔离 VM: 用独立渠道输入 fingerprint/code，运行 `device-enroll`、两次 heartbeat、两阶段 token rotate、旧 token 拒绝、revoke 后立即拒绝。
5. N-1: current 与 N-1 客户端各完成 enrollment/heartbeat；N-2 固定 426。
6. Restart: 重启 controller/endpoint，证书 fingerprint 和 Keychain token 继续有效，没有重新生成或明文 fallback。
7. Fingerprint replacement: 备份测试状态后替换专用测试 identity；无显式 accept 时启动拒绝，显式 accept 后全部旧设备 suspended，只有重新 enrollment 的设备恢复 active。

证据报告只允许以下字段：source commit、Node/macOS 主版本、命令标识、PASS/FAIL、错误码、时间、是否用户处理 Keychain prompt；不得记录 host、IP、URL、路径、fingerprint、code、token、Keychain item 或原始系统错误。第二 Mac 不可用时，G0a 自动化代码可以提交，但 `fleet-device-management` 和 `security-auth` 不得转 ready。

- [ ] **Step 6: Grok fresh review、Codex PM 验收并提交**

Grok reviewer 必查：TLS pin 是否在 secret 发出前完成、管理/Agent listener 是否隔离、Keychain 是否存在明文 fallback、registry 并发消费是否单写者、API status/audit 是否泄密、启动失败是否关闭已启动 listener。

Codex PM 复跑 Step 4，并至少手工复现：wrong fingerprint、expired code、concurrent consume、revoked token、N-2、management bind 非 loopback、Agent bind wildcard。每条必须观察到固定错误码或启动拒绝。

PM commit: `feat: complete G0a device trust foundation`

## Resilience Gate Traceability

| 风险 | 分类 | 触发条件 | 成功判据 | 验证命令/检查 | 证据 |
| --- | --- | --- | --- | --- | --- |
| Keychain 不可用 | task | runner exit 非 0/锁定 | listener 不启动，无明文 fallback | Task 2 tests + real Keychain gate | 测试输出/脱敏报告 |
| TLS identity 半状态 | task | cert/key 只存在一项 | `device-tls-identity-incomplete`，不再生成 | Task 3 focused test | 测试输出 |
| 证书指纹改变 | task | endpoint 连接错误证书 | code/token 未发送 | Task 7 request-count test | 测试输出 |
| enrollment 重放/过期 | task | 第二次消费/TTL 后消费 | 固定 401，未签发 token | Task 4/5 tests | registry state + 测试输出 |
| 并发双消费 | task | 两请求同时消费 | 恰好一个成功 | Task 4 concurrent test | 测试输出 |
| 协议越界 | task | N-2/future | 426 且无写入 | Task 1/5/8 | 测试输出/真实报告 |
| 设备越权 | task | alpha token 请求 beta | `device-scope-mismatch` | Task 4/5 | 测试输出 |
| 撤销/轮换 | task | 旧 token 再请求 | 立即拒绝，新 token 仅 Keychain | Task 4/5/7 | 测试输出 |
| body/rate 资源耗尽 | task | >64 KiB/超过窗口 | 有界 413/429，不排队 | Task 5 | 测试输出 |
| Agent 已启动而管理启动失败 | task | management listen error | Agent listener 自动关闭 | Task 8 | 事件序列 |
| 进程重启 | task | controller/endpoint restart | fingerprint/token 保持，health 正常 | Task 8 real gate | 脱敏报告 |
| upload queue/backpressure | N/A | G0a 无上传 | 由 G0b/G0c 独立计划实现 | 路由 404 契约 | Task 5 测试 |
| snapshot/NAS/Retention | N/A | G0a 不处理数据复制删除 | 由 G0b–G2 实现 | 未挂载相应 route | Task 5 测试 |
| 第二真实 macOS | BLOCKED | 当前无测试端点证据 | 完成配对/心跳/轮换/撤销 | Task 8 real gate | 脱敏报告 |

## Qwen Adversarial Review Disposition

| finding | PM 裁决 | 计划处理 |
| --- | --- | --- |
| F1 fingerprint TOCTOU | 驳回 | `null` 不命中 read-only 快速路径；两个初始化调用都进入串行 `mutate()`，第二次在回调内读取 fresh state 并幂等写同一 fingerprint。不存在 Qwen 所述“两次看到 null 后快速返回”。|
| F2 管理 body 校验 | 采纳 | Task 6 对 null/object/deviceId 做 route-level 400 校验，并测试 service 未被调用。|
| F3 撤销错误语义 | 采纳 | Task 1 注册 `device-not-found`，Task 4 精确使用并测试 404。|
| F4 LibreSSL fd 3 | 实证关闭 | PM 已在 LibreSSL 3.3.6 实测 exit 0/certificate generated/private key not printed；Task 3 保留真实 subprocess 回归。|
| F5 re-enrollment 删除 snapshot 历史 | 驳回 | `device-registry-v1.json` 只存 credential lifecycle；snapshot/backup 历史在现有 `src/storage.js` 的独立 repo 中，不会被设备凭据替换删除。G5 审计将记录 credential lifecycle。|
| F6 enrollment 枚举 | 采纳设计说明 | 256 位 code + 来源 IP limiter；不加入可被攻击者触发的 per-device lockout，G5 增加失败审计。|
| F7 管理 error 格式混合 | 采纳 | 新路由固定注册码并测试；旧路由保持兼容，G5 独立迁移，避免 G0a 扩大回归面。|
| F8 mutation timeout | 驳回 timeout，采纳边界 | registry 强制本地 APFS；无法取消的 timeout 会释放 queue 却留下 I/O，反而产生并发写。进程 hang 恢复由 G4 supervisor 承担。|
| F9 独立 limiter | 采纳说明 | 固定 Agent 60/min，管理面保持可配置；两者总资源上界明确，互不共享等待队列。|
| F10 stdin 无上限 | 采纳 | Task 7 增加 4096-byte cap 和 4097-byte RED 测试。|
| F11 fingerprint 多设备 | 采纳 | Task 4 用 current 与 N-1 两台设备断言全部 suspended。|
| F12 catch 二次注册校验 | 采纳 | Task 5 对异常 code 做 allowlist fallback，未知/被篡改 code 固定映射 `device-internal-error`。|

计划审查后没有未闭合 P0/P1；真实 Keychain、第二 macOS 仍是产品验收 `BLOCKED`，不是计划缺口。

## Frozen G0a Completion Definition

G0a 代码完成必须同时满足：全部自动测试通过；无 secret/path/raw-error 泄漏；管理面 loopback 与 Agent HTTPS listener 分离；Keychain/TLS/enrollment/token/scope/revoke/current+N-1 的真实代码路径存在；任何暂缺的真实 Keychain/第二 Mac 验收保持 `blocked`。只有真实 Keychain 与第二 Mac 证据同时通过，G0a 才能作为 Gold ready 证据；完成定义不得以 mock、同进程 fixture 或静态 readiness 字符串替代。
