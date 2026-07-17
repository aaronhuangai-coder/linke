# Linke V2.0 Gold M1/T1.1 Cross-LAN Public Error-Code Registry Implementation Plan

> **For agentic workers:** 本任务固定采用 **pm-dcw h** 编排（见 Execution Handoff）。实现者（Grok）严格按 checkbox 步骤执行 TDD RED→GREEN；**不得**自行 `git commit` / `git push`。Git 状态变更（path-specific add、`git commit --only` 两目标路径、HEAD 文件范围 gate、push）由 **PM（Codex）** 在 Step 4–6 新鲜验证通过后执行。

**Goal:** 将 T1.1 规定的 cross-LAN 公共错误码并入唯一冻结 `ERROR_CODES` registry，使闭集精确为 45 项（保留现有 17 + 新增 28；T1.1 列表 30 中有 2 项已存在），并完成 TDD 全量回归；不实现网络/Noise/状态机，不宣称 T1.0 PASS。

**Architecture:** 直接扩展现有 `src/error-codes.js` 中的唯一 `ERROR_CODES` 对象（`Object.freeze`），不新增第二 registry、不动态生成属性。`REGISTERED_ERROR_CODES` Set、`assertRegisteredErrorCode`、`LinkeError` 实现保持不变——它们自动从扩展后的 `ERROR_CODES` 取值。测试侧以完整 45 项 exact expected object + `assert.deepStrictEqual` 锁定闭集；prefix allowlist 仅追加 13 个新 prefix，禁止改为任意 kebab open set。

**Tech Stack:** Node.js ESM；内置 `node:test` / `node:assert`；无新依赖；`npm test` 为仓库既有全量测试入口。

## Global Constraints

- 范围**仅**修改：`src/error-codes.js`、`test/error-codes.test.js`（实现阶段）。本 plan 文档由 **PM 以独立 `docs:` commit 先入库**；实现阶段不得再改其它 docs。
- **禁止**修改：`src/**`（除 `error-codes.js`）、`test/**`（除 `error-codes.test.js`）、`README.md`、`src/version.js`、`src/gold-readiness.js`、`package.json`、`package-lock.json`、其它 docs。
- **禁止** `git add .` / `git add -A`；仅 path-specific add 上述两个实现文件；不得捕获 untracked `package-lock.json`。
- **禁止**实现网络/Noise/state machine；**禁止**宣称 T1.0 PASS 或 M1 整体完成。
- **禁止**新增第二 error registry；**禁止**动态 `Object.defineProperty` / Proxy 生成码。
- 命名规则（常量 key）：value 按 `-` split → 每段 uppercase → `_` join，数字保留。例：`e2ee-required` → `E2EE_REQUIRED`；`enrollment-code-unknown-or-expired` → `ENROLLMENT_CODE_UNKNOWN_OR_EXPIRED`。
- 显式保留现有 `DEVICE_RATE_LIMITED = 'device-rate-limited'` 与 `DEVICE_REVOKED = 'device-revoked'`（T1.1 重叠项，不重命名、不重复定义）。
- Prefix allowlist 从现有 12 个扩展到 25 个：保留 `auth|device|upload|snapshot|smb|restore|retention|scheduler|lifecycle|keychain|audit|upgrade`，**仅**加入 `handshake|protocol|e2ee|enrollment|control|stale|relay|proxy|data|controller|revoke|session|evidence`（13 个）。
- Runtime resilience = **N/A**（冻结常量 registry，无 I/O / 可变状态 / 异步）。替代验证：frozen、45 exact、唯一值、prefix+kebab、round-trip、raw rejection、LinkeError sanitation、全量回归。
- 提交信息必须精确为：`feat: register v2 cross-lan error codes`。
- **Git 所有权（本 Gold loop 已获用户授权自动 commit/push）：** 实现者（Grok）只改两实现文件并完成 Step 1–6 验证；**禁止** Grok 自行 `git add` / `git commit` / `git push` / `git restore --staged` / 任何 unstage。Step 4–6 新鲜验证通过后，由 **PM** 路径专属暂存目标两文件、用 `git commit --only` 隔离提交、以 `git show --name-only` 校验 HEAD commit 文件范围、自动 push，并立即进入下一任务。**禁止**无 pathspec 的 plain `git commit -m`（会提交整个 index）。目标两文件必须 staged；其它用户 staging 允许保留；最终通过 HEAD commit 文件范围 gate 证明隔离，**不要求** cached 恰好只有两行。

---

## Quantity Self-Check（必须与 M0 T1.1 一致）

| 集合 | 数量 | 说明 |
| --- | ---: | --- |
| 当前 `ERROR_CODES` | **17** | `src/error-codes.js` 现有常量 |
| T1.1 required values | **30** | design/plan 冻结列表（见下） |
| 重叠（已存在，保留） | **2** | `device-rate-limited`、`device-revoked` |
| 本次新增常量 | **28** | 30 − 2 |
| 最终闭集 | **45** | 17 + 28 |
| 新 prefix | **13** | 见 Global Constraints |
| 最终 prefix allowlist | **25** | 12 旧 + 13 新 |

### T1.1 required values（完整 30，顺序与 M0 一致）

```text
device-replay-detected
device-clock-skew
device-counter-rollback
device-rate-limited          ← 已存在 DEVICE_RATE_LIMITED
device-session-limit
device-clone-suspected
handshake-identity-failed
protocol-downgrade-attempt
e2ee-required
enrollment-rate-limited
enrollment-code-unknown-or-expired
enrollment-secret-unavailable
control-queue-overflow
stale-epoch-rejected
device-revoked               ← 已存在 DEVICE_REVOKED
relay-connect-failed
proxy-auth-failed
proxy-connect-failed
relay-tls-pin-mismatch
proxy-tls-intercepted
proxy-unsupported-auth
proxy-pac-unsupported
proxy-chain-unsupported
data-resume-exhausted
audit-chain-broken
controller-state-untrusted
revoke-propagation-degraded
session-keepalive-timeout
evidence-artifact-missing
evidence-artifact-digest-mismatch
```

### 28 个新增 key/value（由命名规则生成）

| Constant key | Value |
| --- | --- |
| `DEVICE_REPLAY_DETECTED` | `device-replay-detected` |
| `DEVICE_CLOCK_SKEW` | `device-clock-skew` |
| `DEVICE_COUNTER_ROLLBACK` | `device-counter-rollback` |
| `DEVICE_SESSION_LIMIT` | `device-session-limit` |
| `DEVICE_CLONE_SUSPECTED` | `device-clone-suspected` |
| `HANDSHAKE_IDENTITY_FAILED` | `handshake-identity-failed` |
| `PROTOCOL_DOWNGRADE_ATTEMPT` | `protocol-downgrade-attempt` |
| `E2EE_REQUIRED` | `e2ee-required` |
| `ENROLLMENT_RATE_LIMITED` | `enrollment-rate-limited` |
| `ENROLLMENT_CODE_UNKNOWN_OR_EXPIRED` | `enrollment-code-unknown-or-expired` |
| `ENROLLMENT_SECRET_UNAVAILABLE` | `enrollment-secret-unavailable` |
| `CONTROL_QUEUE_OVERFLOW` | `control-queue-overflow` |
| `STALE_EPOCH_REJECTED` | `stale-epoch-rejected` |
| `RELAY_CONNECT_FAILED` | `relay-connect-failed` |
| `PROXY_AUTH_FAILED` | `proxy-auth-failed` |
| `PROXY_CONNECT_FAILED` | `proxy-connect-failed` |
| `RELAY_TLS_PIN_MISMATCH` | `relay-tls-pin-mismatch` |
| `PROXY_TLS_INTERCEPTED` | `proxy-tls-intercepted` |
| `PROXY_UNSUPPORTED_AUTH` | `proxy-unsupported-auth` |
| `PROXY_PAC_UNSUPPORTED` | `proxy-pac-unsupported` |
| `PROXY_CHAIN_UNSUPPORTED` | `proxy-chain-unsupported` |
| `DATA_RESUME_EXHAUSTED` | `data-resume-exhausted` |
| `AUDIT_CHAIN_BROKEN` | `audit-chain-broken` |
| `CONTROLLER_STATE_UNTRUSTED` | `controller-state-untrusted` |
| `REVOKE_PROPAGATION_DEGRADED` | `revoke-propagation-degraded` |
| `SESSION_KEEPALIVE_TIMEOUT` | `session-keepalive-timeout` |
| `EVIDENCE_ARTIFACT_MISSING` | `evidence-artifact-missing` |
| `EVIDENCE_ARTIFACT_DIGEST_MISMATCH` | `evidence-artifact-digest-mismatch` |

---

## File Map

| Path | Role | This task |
| --- | --- | --- |
| `test/error-codes.test.js` | Gold error-code registry 行为 + 闭集 exact pin | **Modify（RED 先改）** |
| `src/error-codes.js` | 唯一冻结 `ERROR_CODES` + assert + `LinkeError` | **Modify（GREEN 只加 28 常量）** |
| 其它一切 | 超出范围 | **Do not touch** |

---

## Interfaces（实现后冻结契约）

**Consumes（现有，不改签名）：**

```js
// src/error-codes.js
export const ERROR_CODES; // Readonly<Record<string, string>>, Object.freeze
export function assertRegisteredErrorCode(code: string): string;
export class LinkeError extends Error {
  constructor(code: string, options?: { statusCode?: number, retryable?: boolean });
  name: 'LinkeError';
  code: string;       // registered value
  message: string;    // same as registered value
  statusCode: number; // default 500
  retryable: boolean; // default false
}
```

**Produces（本任务新增的对外常量，均为 string value）：**

- 保留 17 个既有 key 不变（含 `DEVICE_RATE_LIMITED`、`DEVICE_REVOKED`）。
- 新增上表 28 个 key；`Object.keys(ERROR_CODES).length === 45`；`Object.values` 唯一；全部通过扩展后 prefix+kebab regex。
- `REGISTERED_ERROR_CODES` 仍为 `new Set(Object.values(ERROR_CODES))`，无手写重复列表。

---

### Task 1: Register T1.1 cross-LAN error codes (TDD)

**Files:**
- Modify: `test/error-codes.test.js`（完整重写为下列最终内容）
- Modify: `src/error-codes.js`（仅扩展 `ERROR_CODES` 字面量；其余逻辑不变）
- Test: `test/error-codes.test.js`
- Do not create any other files

**Interfaces:**
- Consumes: 现有 `ERROR_CODES`、`LinkeError`、`assertRegisteredErrorCode`
- Produces: 闭集 45 项 `ERROR_CODES`；测试 exact map `EXPECTED_ERROR_CODES` 与源对象 `deepStrictEqual`

---

- [ ] **Step 1: Write the failing test（完整替换 `test/error-codes.test.js`）**

将 `test/error-codes.test.js` **整体替换**为下列完整文件内容（不得省略 45 项 map 的任何一项；不得用循环从 T1.1 列表“生成” expected 来代替字面量闭集 pin——expected 必须是字面量 object）：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from '../src/error-codes.js';

/**
 * Closed-set pin of the entire public ERROR_CODES registry.
 * Count: 45 = 17 existing + 28 new T1.1 codes
 * (T1.1 lists 30 values; device-rate-limited and device-revoked already exist).
 */
const EXPECTED_ERROR_CODES = {
  // --- existing 17 (regression pin) ---
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
  // --- new 28 (T1.1 minus 2 overlaps) ---
  DEVICE_REPLAY_DETECTED: 'device-replay-detected',
  DEVICE_CLOCK_SKEW: 'device-clock-skew',
  DEVICE_COUNTER_ROLLBACK: 'device-counter-rollback',
  DEVICE_SESSION_LIMIT: 'device-session-limit',
  DEVICE_CLONE_SUSPECTED: 'device-clone-suspected',
  HANDSHAKE_IDENTITY_FAILED: 'handshake-identity-failed',
  PROTOCOL_DOWNGRADE_ATTEMPT: 'protocol-downgrade-attempt',
  E2EE_REQUIRED: 'e2ee-required',
  ENROLLMENT_RATE_LIMITED: 'enrollment-rate-limited',
  ENROLLMENT_CODE_UNKNOWN_OR_EXPIRED: 'enrollment-code-unknown-or-expired',
  ENROLLMENT_SECRET_UNAVAILABLE: 'enrollment-secret-unavailable',
  CONTROL_QUEUE_OVERFLOW: 'control-queue-overflow',
  STALE_EPOCH_REJECTED: 'stale-epoch-rejected',
  RELAY_CONNECT_FAILED: 'relay-connect-failed',
  PROXY_AUTH_FAILED: 'proxy-auth-failed',
  PROXY_CONNECT_FAILED: 'proxy-connect-failed',
  RELAY_TLS_PIN_MISMATCH: 'relay-tls-pin-mismatch',
  PROXY_TLS_INTERCEPTED: 'proxy-tls-intercepted',
  PROXY_UNSUPPORTED_AUTH: 'proxy-unsupported-auth',
  PROXY_PAC_UNSUPPORTED: 'proxy-pac-unsupported',
  PROXY_CHAIN_UNSUPPORTED: 'proxy-chain-unsupported',
  DATA_RESUME_EXHAUSTED: 'data-resume-exhausted',
  AUDIT_CHAIN_BROKEN: 'audit-chain-broken',
  CONTROLLER_STATE_UNTRUSTED: 'controller-state-untrusted',
  REVOKE_PROPAGATION_DEGRADED: 'revoke-propagation-degraded',
  SESSION_KEEPALIVE_TIMEOUT: 'session-keepalive-timeout',
  EVIDENCE_ARTIFACT_MISSING: 'evidence-artifact-missing',
  EVIDENCE_ARTIFACT_DIGEST_MISMATCH: 'evidence-artifact-digest-mismatch',
};

const ERROR_CODE_PREFIX_PATTERN =
  /^(auth|device|upload|snapshot|smb|restore|retention|scheduler|lifecycle|keychain|audit|upgrade|handshake|protocol|e2ee|enrollment|control|stale|relay|proxy|data|controller|revoke|session|evidence)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('Gold error-code registry', () => {
  it('matches the exact closed-set ERROR_CODES registry (45 entries)', () => {
    assert.strictEqual(Object.keys(EXPECTED_ERROR_CODES).length, 45);
    assert.strictEqual(Object.keys(ERROR_CODES).length, 45);
    assert.deepStrictEqual(ERROR_CODES, EXPECTED_ERROR_CODES);
  });

  it('contains unique registered kebab-case codes', () => {
    assert.ok(Object.isFrozen(ERROR_CODES));
    const values = Object.values(ERROR_CODES);
    assert.strictEqual(new Set(values).size, values.length);
    for (const code of values) {
      assert.match(code, ERROR_CODE_PREFIX_PATTERN);
      assert.strictEqual(assertRegisteredErrorCode(code), code);
    }
  });

  it('rejects raw or unregistered error text', () => {
    assert.throws(() => assertRegisteredErrorCode('ENOENT /Users/private'), /unregistered Linke error code/);
  });

  it('rejects unregistered raw text in LinkeError without echoing it', () => {
    const raw = 'ENOENT /Users/private/secret';
    assert.throws(
      () => new LinkeError(raw),
      (error) => {
        assert.match(error.message, /unregistered Linke error code/);
        assert.ok(!error.message.includes(raw));
        assert.ok(!error.message.includes('/Users/private'));
        return true;
      },
    );
  });

  it('constructs a sanitized LinkeError', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_REVOKED, { statusCode: 403 });
    assert.strictEqual(error.code, 'device-revoked');
    assert.strictEqual(error.message, 'device-revoked');
    assert.strictEqual(error.statusCode, 403);
    assert.strictEqual(error.retryable, false);
  });

  it('defaults LinkeError statusCode, retryable, and name', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR);
    assert.strictEqual(error.name, 'LinkeError');
    assert.strictEqual(error.statusCode, 500);
    assert.strictEqual(error.retryable, false);
  });

  it('preserves retryable true when explicitly set', () => {
    const error = new LinkeError(ERROR_CODES.DEVICE_RATE_LIMITED, { statusCode: 429, retryable: true });
    assert.strictEqual(error.retryable, true);
    assert.strictEqual(error.statusCode, 429);
  });
});
```

说明（实现者必读，不是可跳过步骤）：

- 新增 exact-registry 测试放在 suite **最前**，失败原因最清晰。
- 扩展后的 `ERROR_CODE_PREFIX_PATTERN` **不会单独变红**：当前源中 17 个 value 仍全部匹配新 allowlist 超集；**唯一**预期失败点是 exact closed-set 测试（源缺 28 常量 → keys 长度与 deepStrictEqual 失败）。
- 既有 6 个行为测试（unique/prefix/round-trip、raw rejection、LinkeError sanitation×3）在 RED 阶段必须继续通过。

---

- [ ] **Step 2: Run targeted tests to verify RED**

Run:

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
node --test test/error-codes.test.js
```

**Expected RED（精确语义，命令输出可能含 tap/spec 格式差异）：**

- 退出码 **非 0**。
- **失败且仅失败**新增用例：`matches the exact closed-set ERROR_CODES registry (45 entries)`。
- 失败形态至少满足其一（Node `assert` 文案）：
  - `Object.keys(ERROR_CODES).length` 实际为 **17**、期望 **45**；和/或
  - `assert.deepStrictEqual(ERROR_CODES, EXPECTED_ERROR_CODES)` 失败，缺失 `DEVICE_REPLAY_DETECTED` 等 28 个 key（或显示 expected/actual 对象差异）。
- 下列用例必须 **pass**：
  - `contains unique registered kebab-case codes`
  - `rejects raw or unregistered error text`
  - `rejects unregistered raw text in LinkeError without echoing it`
  - `constructs a sanitized LinkeError`
  - `defaults LinkeError statusCode, retryable, and name`
  - `preserves retryable true when explicitly set`
- **不要**声称“旧 regex 自己会先红”——旧 17 项在扩展 allowlist 下仍合法；RED 只来自 exact closed-set pin。

若出现其它失败（import 错误、语法错误、既有用例红），停止并修正测试文件，**不要**进入 GREEN。

---

- [ ] **Step 3: Minimal implementation（完整替换 `src/error-codes.js` 中 `ERROR_CODES` 对象；逻辑块不变）**

将 `src/error-codes.js` **整体替换**为下列完整文件内容。允许的唯一实质 diff：在 `ERROR_CODES` 中于既有 17 项之后追加 28 个新常量。`Object.freeze`、`REGISTERED_ERROR_CODES`、`assertRegisteredErrorCode`、`LinkeError` 的实现必须与现网一致（不得改 throw 文案、默认 statusCode/retryable、name 赋值逻辑）。

```js
/**
 * Frozen registry of all public Linke error codes (kebab-case values only).
 * @type {Readonly<Record<string, string>>}
 */
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
  DEVICE_REPLAY_DETECTED: 'device-replay-detected',
  DEVICE_CLOCK_SKEW: 'device-clock-skew',
  DEVICE_COUNTER_ROLLBACK: 'device-counter-rollback',
  DEVICE_SESSION_LIMIT: 'device-session-limit',
  DEVICE_CLONE_SUSPECTED: 'device-clone-suspected',
  HANDSHAKE_IDENTITY_FAILED: 'handshake-identity-failed',
  PROTOCOL_DOWNGRADE_ATTEMPT: 'protocol-downgrade-attempt',
  E2EE_REQUIRED: 'e2ee-required',
  ENROLLMENT_RATE_LIMITED: 'enrollment-rate-limited',
  ENROLLMENT_CODE_UNKNOWN_OR_EXPIRED: 'enrollment-code-unknown-or-expired',
  ENROLLMENT_SECRET_UNAVAILABLE: 'enrollment-secret-unavailable',
  CONTROL_QUEUE_OVERFLOW: 'control-queue-overflow',
  STALE_EPOCH_REJECTED: 'stale-epoch-rejected',
  RELAY_CONNECT_FAILED: 'relay-connect-failed',
  PROXY_AUTH_FAILED: 'proxy-auth-failed',
  PROXY_CONNECT_FAILED: 'proxy-connect-failed',
  RELAY_TLS_PIN_MISMATCH: 'relay-tls-pin-mismatch',
  PROXY_TLS_INTERCEPTED: 'proxy-tls-intercepted',
  PROXY_UNSUPPORTED_AUTH: 'proxy-unsupported-auth',
  PROXY_PAC_UNSUPPORTED: 'proxy-pac-unsupported',
  PROXY_CHAIN_UNSUPPORTED: 'proxy-chain-unsupported',
  DATA_RESUME_EXHAUSTED: 'data-resume-exhausted',
  AUDIT_CHAIN_BROKEN: 'audit-chain-broken',
  CONTROLLER_STATE_UNTRUSTED: 'controller-state-untrusted',
  REVOKE_PROPAGATION_DEGRADED: 'revoke-propagation-degraded',
  SESSION_KEEPALIVE_TIMEOUT: 'session-keepalive-timeout',
  EVIDENCE_ARTIFACT_MISSING: 'evidence-artifact-missing',
  EVIDENCE_ARTIFACT_DIGEST_MISMATCH: 'evidence-artifact-digest-mismatch',
});

const REGISTERED_ERROR_CODES = new Set(Object.values(ERROR_CODES));

/**
 * Return a registered public error code or throw without echoing its value.
 * @param {string} code
 * @returns {string}
 */
export function assertRegisteredErrorCode(code) {
  if (!REGISTERED_ERROR_CODES.has(code)) throw new Error('unregistered Linke error code');
  return code;
}

/**
 * Error whose public message is always a registered, sanitized code.
 * Unregistered code or message inputs are rejected without echoing raw text.
 * @param {string} code - Must be a registered ERROR_CODES value.
 * @param {{ statusCode?: number, retryable?: boolean }} [options]
 */
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

实现约束再强调：

- **不要**重命名或删除既有 17 项。
- **不要**把 `DEVICE_RATE_LIMITED` / `DEVICE_REVOKED` 写第二遍。
- **不要**改 `assertRegisteredErrorCode` 的错误字符串。
- **不要**改 `LinkeError` 默认参数或 `Boolean(retryable)`。

---

- [ ] **Step 4: Run targeted tests to verify GREEN**

Run:

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
node --test test/error-codes.test.js
```

**Expected GREEN：**

- 退出码 **0**。
- suite `Gold error-code registry` 下 **7** 个 test 全部 pass（1 个 exact closed-set + 6 个既有/扩展行为）。
- 无 failure / todo。

若 exact 测试仍失败：核对 key 拼写（尤其 `E2EE_REQUIRED`、`ENROLLMENT_CODE_UNKNOWN_OR_EXPIRED`、`EVIDENCE_ARTIFACT_DIGEST_MISMATCH`）、value 是否完整 kebab、是否误增第 46 项。

---

- [ ] **Step 5: Full regression GREEN**

Run:

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
npm test
```

**Expected：**

- 退出码 **0**。
- 全量 `node --test`（或 package.json 中 `test` script 定义的等价命令）全部通过。
- 无因 `ERROR_CODES` 形状变化导致的下游失败（本变更仅**增**常量，不改既有 key/value，下游引用应保持兼容）。

若全量失败且归因于本变更：修复仅限 `src/error-codes.js` / `test/error-codes.test.js`；不得为“消红”去改 version/scorecard/其它模块。

---

- [ ] **Step 6: Diff / scope verification**

Run:

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
git status --short
git diff --stat
git diff -- src/error-codes.js test/error-codes.test.js
```

**Expected scope gate：**

- 实现相关 **modified** 文件有且仅有：
  - `src/error-codes.js`
  - `test/error-codes.test.js`
- 本 plan 文档（`docs/superpowers/plans/2026-07-17-linke-v2-m1-cross-lan-error-codes.md`）**已由 PM 以独立 docs commit 入库**；实现阶段工作区**不应**再把它当作 untracked 交付物描述。若工作区仍见该 plan 的 diff，属计划返修/另轨，**不得**并入本 feat commit。
- 允许无关 untracked `package-lock.json` 存在于工作区，但**绝不** `git add` / 纳入本 feat commit。
- **禁止**出现对 `package.json`、`package-lock.json`、`src/version.js`、`src/gold-readiness.js`、`README.md`、其它 docs 的修改并纳入本提交。
- 快速数值自检（可选，应全部打印通过语义）：

```bash
node -e "
import { ERROR_CODES } from './src/error-codes.js';
const n = Object.keys(ERROR_CODES).length;
const vals = Object.values(ERROR_CODES);
console.log('count', n);
console.log('unique', new Set(vals).size === n);
console.log('frozen', Object.isFrozen(ERROR_CODES));
console.log('overlap pins', ERROR_CODES.DEVICE_RATE_LIMITED, ERROR_CODES.DEVICE_REVOKED);
const t11 = [
  'device-replay-detected','device-clock-skew','device-counter-rollback','device-rate-limited','device-session-limit','device-clone-suspected','handshake-identity-failed','protocol-downgrade-attempt','e2ee-required','enrollment-rate-limited','enrollment-code-unknown-or-expired','enrollment-secret-unavailable','control-queue-overflow','stale-epoch-rejected','device-revoked','relay-connect-failed','proxy-auth-failed','proxy-connect-failed','relay-tls-pin-mismatch','proxy-tls-intercepted','proxy-unsupported-auth','proxy-pac-unsupported','proxy-chain-unsupported','data-resume-exhausted','audit-chain-broken','controller-state-untrusted','revoke-propagation-degraded','session-keepalive-timeout','evidence-artifact-missing','evidence-artifact-digest-mismatch'
];
const set = new Set(vals);
console.log('t11 all present', t11.every((v) => set.has(v)), t11.length);
"
```

期望输出语义：`count 45`、`unique true`、`frozen true`、overlap pins 为 `device-rate-limited` / `device-revoked`、`t11 all present true 30`。

**Runtime resilience 替代验证清单（N/A 正式项的替代）：**

| 检查 | 如何证明 |
| --- | --- |
| frozen | `Object.isFrozen(ERROR_CODES)` 在 unit test 中断言 |
| 45 exact | `deepStrictEqual` + keys length 45 |
| 唯一值 | `new Set(values).size === values.length` |
| prefix+kebab | 扩展 allowlist regex 对全部 values |
| round-trip | `assertRegisteredErrorCode(code) === code` |
| raw rejection | unregistered 文本 throws，不 echo |
| LinkeError sanitation | 既有 3 个 LinkeError 用例 |
| 全量回归 | `npm test` exit 0 |

---

- [ ] **Step 7: PM path-specific stage / commit / push（仅两目标文件；PM 执行）**

**执行者：PM（Codex），不是 Grok 实现者。**

**前置条件：** Step 4–6 新鲜验证全部通过（targeted GREEN + full `npm test` GREEN + scope gate）。

用户已明确授权本 Gold loop **自动 commit 与 push**，无需再次向用户确认。PM 完成下列步骤后**立即进入下一任务**。

**7.1 检查既有 staging（只读记录；禁止 unstage；不阻塞）**

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
git diff --cached --name-only
```

- **只读**记录当前 cached 路径列表（允许为空，也允许含用户/其它路径）。
- **无论**是否有其它 cached 路径，**均可继续** 7.2：隔离由 7.3 的 `git commit --only` 保证，不依赖 index 恰好干净。
- **严禁** unstage：禁止 `git restore --staged`、`git reset`、`git restore --staged --worktree` 或任何取消暂存命令去动用户/第三方 staging。
- 不要因“cached 不止两文件”而停止；那是死锁性旧规则，已废止。

**7.2 路径专属暂存（仅两目标文件）**

```bash
git add src/error-codes.js test/error-codes.test.js
git status --short
git diff --cached --name-only
git diff --cached --stat
```

**Staging 确认（非 exclusive gate）：**

- `src/error-codes.js` 与 `test/error-codes.test.js` **必须**出现在 `git diff --cached --name-only` 中。
- **允许**其它用户已 staged 路径继续存在于 index；**禁止**为清 index 而 unstage。
- **不要求** cached 最终恰好两行；最终隔离证明见 7.3 的 HEAD commit 文件范围 gate。

**禁止：**

```bash
# 禁止使用：
git add .
git add -A
git add --all
git restore --staged
git restore --staged --worktree
git reset HEAD
# 禁止无 pathspec 的 plain commit（会提交整个 index；风险示例，不可执行）：
# git commit -m "feat: register v2 cross-lan error codes"
```

**7.3 自动 commit（必须 `--only` pathspec；无 heredoc / 无命令替换）**

```bash
git commit --only src/error-codes.js test/error-codes.test.js -m "feat: register v2 cross-lan error codes"
git show --name-only --pretty=format: HEAD
git status --short
```

**HEAD commit 文件范围 gate（隔离证明）：** `git show --name-only --pretty=format: HEAD` 必须**恰好**只含：

```text
src/error-codes.js
test/error-codes.test.js
```

（两行、无第三路径。若多出任何路径，视为 commit 失败/污染，停止 push 并上报。）

**7.4 自动 push（PM 执行）**

```bash
git push
```

**Expected：**

- 若 plan 文档**尚未入库**，PM **必须先**以独立 docs commit 入库：`docs: plan v2 m1 cross-lan error codes`，**然后**才执行实现与本 feat commit；二者**不得**混合进同一 commit。
- feat commit 成功，message subject 精确为 `feat: register v2 cross-lan error codes`。
- `git show --name-only --pretty=format: HEAD` 恰好两目标路径（commit 范围 gate PASS）。
- push 成功（当前跟踪分支）。
- 工作区不再含上述两文件的 unstaged 实现 diff。
- untracked `package-lock.json`（若存在）仍保持 untracked、未入库。
- 本 plan 文档不在本 feat commit 内（已由先前独立 docs commit 处理，或本步 Expected 首条先入库）。
- 用户其它 staged 路径（若有）仍可保留在 index，**未被**本 feat commit 吞入。
- PM 完成 push 后**立即进入下一任务**，无需再向用户确认 commit/push。

**Grok 实现者在本步的职责：** 零 Git 写操作；仅在交接报告中声明 Step 4–6 已通过，并把 diff/status 摘要交给 PM。

---

## Out of Scope（明确不在本 plan 实现）

- T1.0 Noise library selection / ADR 代码落地
- T1.2+ 消息 schema、状态机、重放、降级、时钟窗、容量常量
- 网络、WSS relay、proxy CONNECT 运行时、Keychain enrollment secret 生命周期
- `src/version.js` / Gold scorecard / README 版本宣称
- 依赖新增或 `package-lock.json` 变更
- 宣称 M1 PASS、T1.0 PASS、cross-lan-connectivity ready

---

## Plan Self-Review

### 1. Spec / PM 裁决覆盖

| 裁决 / 要求 | Plan 落点 |
| --- | --- |
| 唯一 `ERROR_CODES`，无第二 registry | Architecture + Step 3 |
| 17 / 30 / 2 overlap / 28 new / 45 final | Quantity Self-Check + exact map |
| 命名规则 `-`→`_` uppercase | Global Constraints + 28 项表 + 完整代码 |
| exact expected object + `deepStrictEqual` | Step 1 完整测试文件 |
| 13 新 prefix，非 open set | Step 1 `ERROR_CODE_PREFIX_PATTERN` |
| 保留 `DEVICE_RATE_LIMITED` / `DEVICE_REVOKED` | 现有 17 段 + 数量表 |
| RED 仅 exact 失败；旧行为绿；不宣称旧 regex 先红 | Step 2 Expected RED |
| GREEN 只加 28 常量；freeze/Set/assert/LinkeError 不变 | Step 3 |
| targeted → full `npm test` | Step 4–5 |
| 范围两文件；PM path-specific stage + `commit --only` + HEAD 范围 gate + push | Step 6–7；Grok 不 commit/push |
| 禁止 unstage；7.1 只读 cached（可空/可含外来）；不因外来 staged 停止 | Step 7.1 |
| 目标两文件必须 staged；其它用户 staging 可保留；不要求 cached 恰好两行 | Step 7.2 |
| 禁止 plain `git commit -m`；必须 `git commit --only` 两路径；HEAD 恰好两文件 | Step 7.3 |
| plan 若未入库：独立 `docs: plan v2 m1 cross-lan error codes` 先入库，再 feat；不得混合 | Step 7 Expected |
| plan 已独立 docs 入库；实现工作区两 modified + 可选 untracked lock | Step 6 |
| Runtime resilience N/A + 替代验证 | Global Constraints + Step 6 表 |
| 不改 version/scorecard/deps；不实现网络/Noise | Out of Scope + Global Constraints |
| pm-dcw h 固定编排；无通用 subagent 二选一 | Execution Handoff |

### 2. Placeholder scan

- 无 TBD / TODO / “类似上面” / 省略 map。
- Step 1 与 Step 3 均为完整可复制文件内容。
- 命令与期望退出语义已写死。

### 3. Type / name consistency

- 测试 `EXPECTED_ERROR_CODES` 与源 `ERROR_CODES` 使用同一 45 组 key/value。
- 重叠项 key 名与现网一致：`DEVICE_RATE_LIMITED`、`DEVICE_REVOKED`。
- 新 key 均符合命名规则（含 `E2EE_REQUIRED`、`ENROLLMENT_CODE_UNKNOWN_OR_EXPIRED`）。
- `AUDIT_CHAIN_BROKEN` 使用既有 prefix `audit`（已在旧 allowlist；新 13 个 prefix 不含重复 `audit`）。

### 4. Count audit (final)

```text
existing keys in plan source block: 17
new keys in plan source block:      28
total keys:                         45
T1.1 values covered:                30 (28 new + 2 retained)
new prefixes listed:                13
```

---

## Execution Handoff

Plan path: `docs/superpowers/plans/2026-07-17-linke-v2-m1-cross-lan-error-codes.md`（PM 以独立 docs commit 入库后进入实现）。

### 固定编排：pm-dcw h（本任务唯一路径）

本任务**不**提供通用 Subagent-Driven / Inline Execution 二选一。固定角色与顺序：

| 角色 | 担当 | 职责 |
| --- | --- | --- |
| adversary | GLM-5.2 | 已对 plan/设计抗辩；实现中若复开抗辩则只读指出缺陷 |
| implementer | Grok | 按 Task 1 **TDD RED→GREEN** 执行 Step 1–6：先改测试、确认 RED、再改源码、targeted GREEN、全量 GREEN、scope 验证；**禁止** commit/push/unstage |
| reviewer | 全新 Grok 会话 | 只读复审实现 diff 与 plan 符合性；不改码、不 commit |
| verifier / Git owner | Codex PM | 新鲜验证 Step 4–6 证据；路径专属 `git add` 两文件；`git commit --only src/error-codes.js test/error-codes.test.js -m "feat: register v2 cross-lan error codes"`；`git show --name-only` 校验 HEAD 恰好两路径；`git push`；立即进入下一任务。禁止 plain `git commit -m`（无 pathspec）。 |

**TDD 顺序（不可颠倒）：** Step 1 失败测试 → Step 2 RED → Step 3 最小实现 → Step 4 targeted GREEN → Step 5 full GREEN → Step 6 scope → Step 7 PM `commit --only` / push。

**禁止：** Grok 自行提交或推送；`git add .` / `-A`；`git restore --staged` 或任何取消用户 staging 的操作；无 pathspec 的 plain `git commit -m`（会提交整个 index）；把 `package-lock.json` 或 plan 文档塞进 feat commit；要求 cached 恰好两行才允许继续（死锁旧规则）。
