# Linke V2.0 Gold M1/T1.2 Control-Plane Message Schemas Implementation Plan

> **For agentic workers:** 本任务固定采用 **pm-dcw h** 编排。实现者（Grok）严格执行 TDD RED→GREEN，不做 Git 写操作；fresh Grok reviewer 只读复审；Codex PM 新鲜验证后用 path-specific add + `git commit --only` + push。

**Goal:** 新增且仅新增 `src/cross-lan-protocol.js` 与 `test/cross-lan-protocol.test.js`，以冻结的 13 个 control-plane message type 字段级 schema + nested denylist entry shape + pure exact-field predicates 完成 T1.2 协议骨架；无依赖、无网络、无 crypto、无状态机；不宣称 Noise / E2EE / cross-LAN / M1 ready。

**Architecture:** 单一新模块导出深冻结 `CONTROL_PLANE_MESSAGE_SCHEMAS`（13 type → descriptor：`requiredFields` / `optionalFields` / `fixedValues`）与 `DENYLIST_ENTRY_SCHEMA`；提供 `hasExactControlPlaneMessageFields(messageType, payload)` 与 `hasExactDenylistEntryFields(entry)` 两个纯谓词。字段级 + nested field-shape only：`Reflect.ownKeys` + plain-record + fail-closed Proxy；**不是** security/crypto/wire/semantic validator。不导出第二 message-type registry，避免双源漂移。

**Tech Stack:** Node.js ESM；内置 `node:test` / `node:assert`；无新依赖；targeted `node --test test/cross-lan-protocol.test.js`；全量 `env -u FORCE_COLOR -u NO_COLOR npm test`。

**上位计划:** `docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md`（M1 / T1.2）

**设计:** `docs/superpowers/specs/2026-07-16-linke-v2-gold-cross-lan-release-design.md`（§4.1.6 / §4.6 / §6.7.2 / §6.7.8 / §6.12）

**基线 HEAD:** T1.1 已提交推送于 `3589f46`（`feat: register v2 cross-lan error codes`）。

**T1.0:** Noise library selection gate 仍 **BLOCKED**（见既有 ADR docs commit）；本 T1.2 仅为字段级 scaffold。

## Global Constraints

- 范围**仅**新增：`src/cross-lan-protocol.js`、`test/cross-lan-protocol.test.js`（实现阶段）。本 plan 文档由 **PM 以独立 `docs:` commit 先入库**；实现阶段不得再改其它 docs。
- **禁止**修改：既有 `src/**`、既有 `test/**`、`README.md`、`src/version.js`、`src/gold-readiness.js`、`src/error-codes.js`、`package.json`、`package-lock.json`、其它 docs。
- **禁止** `git add .` / `git add -A`；仅 path-specific add 上述两个实现文件；**永不**纳入 untracked `package-lock.json`。
- **禁止**网络 I/O、crypto 运算、状态机、persistence、Keychain、import 任何模块（含 `node:crypto` / 相对路径 / 第三方）。
- **禁止**导出重复的 `CONTROL_PLANE_MESSAGE_TYPES`（或等价第二 registry）；唯一 type 闭集 = `Object.keys(CONTROL_PLANE_MESSAGE_SCHEMAS)`。
- **禁止**宣称 T1.0 PASS、M1 ready、Noise/E2EE/cross-LAN ready、security validator。
- **禁止**实现者（Grok）执行任何 Git 写操作（`add` / `commit` / `push` / `restore --staged` / unstage / reset）。
- 提交信息必须精确为：
  - plan docs（PM）：`docs: plan v2 control-plane message schemas`
  - 实现 feat（PM）：`feat: define v2 control-plane message schemas`
- **Git 所有权（本 Gold loop 已获用户授权自动 commit/push）：** 实现者只创建两新文件并完成 Step 1–6 验证；Step 4–6 新鲜验证通过后，由 **PM** 路径专属暂存、`git commit --only` 隔离提交、`git show --name-only` 校验 HEAD 恰好两路径、自动 push。禁止 plain `git commit -m`（无 pathspec）。允许其它用户 staging 保留；不要求 cached 恰好两行。

---

## PM 最终设计冻结（实现者不可改）

### 1. 范围 / 事实

| 项 | 冻结 |
| --- | --- |
| 新增文件 | **仅** `src/cross-lan-protocol.js`、`test/cross-lan-protocol.test.js` |
| 依赖 | 无 import；无 `package.json` / lock 变更 |
| 副作用 | 无网络、无 crypto、无状态机、无 persistence、无 Keychain |
| 不改 | error codes / version / scorecard / README / package files |
| T1.0 | 仍 BLOCKED；本模块不宣称 Noise/E2EE/cross-LAN/M1 ready |
| untracked | 既有 `package-lock.json` **永不**纳入 |

### 2. 13 个 message type — exact schema

| # | messageType | requiredFields | optionalFields | fixedValues |
| ---: | --- | --- | --- | --- |
| 1 | `noise-msg1-payload` | `deviceId`, `enrollmentEpoch`, `ed25519IdentityPub`, `identityBindingSig`, `clientNonce`, `clientTimeUtc` | `[]` | `{}` |
| 2 | `noise-msg2-payload` | `controllerId`, `enrollmentEpoch`, `serverNonce`, `serverTimeUtc`, `keyConfirmServer` | `rekeyGeneration` | `{ rekeyGeneration: 0 }` |
| 3 | `key-confirm-client` | `keyConfirmClient` | `[]` | `{}` |
| 4 | `session-terminate` | `reason` | `[]` | `{ reason: 'revoked' }` |
| 5 | `revoke-epoch` | `deviceId`, `enrollmentEpoch`, `revokeGeneration` | `[]` | `{}` |
| 6 | `denylist-update` | `denylistVersion`, `entries` | `[]` | `{}` |
| 7 | `denylist-ack` | `denylistVersion` | `[]` | `{}` |
| 8 | `relay-pin-set-update` | `relayId`, `oldSpkiPins`, `newSpkiPins`, `notBefore`, `graceUntil`, `updateId`, `trustEpoch`, `signature` | `[]` | `{}` |
| 9 | `relay-pin-set-ack` | `updateId` | `[]` | `{}` |
| 10 | `controller-noise-key-update` | `oldNoiseStaticPub`, `newNoiseStaticPub`, `notBefore`, `graceUntil`, `trustEpoch`, `updateId`, `signature` | `[]` | `{}` |
| 11 | `controller-noise-key-ack` | `updateId` | `[]` | `{}` |
| 12 | `keepalive-ping` | `[]` | `[]` | `{}` |
| 13 | `keepalive-pong` | `[]` | `[]` | `{}` |

**Descriptor shape（每个 type 精确三键，即使空也必须存在并冻结）：**

```js
{
  requiredFields: ReadonlyArray<string>, // Object.freeze
  optionalFields: ReadonlyArray<string>, // Object.freeze
  fixedValues: Readonly<Record<string, unknown>>, // Object.freeze
}
```

### 3. PM 裁决说明（必须遵守；抗辩结果见文末）

1. **keepalive type 保留但空 payload `{}`：** 避免发明 `pingId`。它们表示 **Noise AEAD 应用层** 消息类型，**绝非** RFC6455 WebSocket ping/pong。传输 framing、计时、`negotiatedKeepaliveInterval` / `3×` 断连语义归 **T1.9 / M3**，本任务不实现。
2. **`session-terminate(revoked)` 表示法：** type = `session-terminate` + required `reason` + `fixedValues.reason = 'revoked'`。这是 T1.2 闭集决定；未来若新增其它 reason，**必须**显式 spec + schema 变更，禁止静默放宽。
3. **`signature` 字段名：** 保持上位计划/spec 显式名 `signature`，**不得**擅自改为 `ed25519Signature`。JSDoc 说明语义为 **controller Ed25519 signature**（本任务仍不验签）。
4. **`keyConfirmClient`：** 与 spec §6.7.2.5 的 `keyConfirmServer` 镜像的冻结字段决策。spec 对 client confirm 描述为消息类型 `key-confirm-client` 的 MAC 值，未单独列出 camelCase 字段名；本 T1.2 **冻结** payload 字段名为 `keyConfirmClient`，与 msg2 的 `keyConfirmServer` 对称命名。

### 4. Nested denylist entry

导出深冻结：

```js
DENYLIST_ENTRY_SCHEMA = {
  identifierFields: ['tunnelId', 'deviceRoutingHandle'], // freeze
  generationFields: ['epoch', 'revokeGeneration'],       // freeze
}
```

导出 `hasExactDenylistEntryFields(entry)`：

- 仅接受 plain record（`Object.getPrototypeOf` 为 `Object.prototype` 或 `null`）。
- `Reflect.ownKeys` 必须恰好 **2** 个 string key；拒绝 symbol / non-enumerable / accessor。
- `identifierFields` 中恰好 **1** 项、`generationFields` 中恰好 **1** 项（四种组合均可）。
- **不**校验值类型 / uint64 / wire 编码。

`hasExactControlPlaneMessageFields('denylist-update', payload)`：顶层 exact 成功后额外要求 `entries` 为 `Array.isArray`，且**每一项**通过 `hasExactDenylistEntryFields`；空 array `[]` **可通过**（语义是否允许“空更新”留给后续任务）。

### 5. 公共 API 与安全边界

| 导出 | 契约 |
| --- | --- |
| `CONTROL_PLANE_MESSAGE_SCHEMAS` | outer + 每个 descriptor + 三个子字段全部 `Object.freeze`；不得再导出重复 type registry |
| `DENYLIST_ENTRY_SCHEMA` | outer + 两个数组 freeze |
| `hasExactControlPlaneMessageFields(messageType, payload)` | 见下 |
| `hasExactDenylistEntryFields(entry)` | 见上 |

**`hasExactControlPlaneMessageFields` 行为：**

- `messageType` 必须为 `string`，且必须是 `CONTROL_PLANE_MESSAGE_SCHEMAS` 的 **own property**（`Object.hasOwn(CONTROL_PLANE_MESSAGE_SCHEMAS, messageType)`）。unknown type、`toString` / `constructor` / `__proto__` / `hasOwnProperty` 等 `Object.prototype` 名 → `false`（避免原型链 lookup fail-open / 原型污染面）
- `null` / `array` / 非 plain record payload → `false`
- 使用 `Reflect.ownKeys`；拒绝 symbol、non-enumerable、accessor、未知字段、缺失 required
- fixed value 用 `Object.is`（故 `rekeyGeneration: 1 | '0' | -0` 均为 false；仅 `0` 或缺失（optional）为 true）
- 捕获 Proxy traps / 任意 throw → 返回 `false`，**不抛**
- API 表面仅为 boolean；invalid extra keys / 抛错输入不得 throw。本 plan **不**宣称证明日志系统无泄漏；fixture 仅用固定 sentinel（非真实 secret）
- `Object.create(null)` **允许**；`Date` / `Buffer` / class instance **拒绝**
- field-level + nested field-shape **only**：**NOT** security/crypto/wire/semantic validator；不校验 nonce 32B、签名/MAC、时间、uint64 range、base64/binary encoding、信任状态或 AEAD
- 无 `import`；纯常量 / 纯 predicate。**不要**写读取源码字符串扫描 `import` 的脆弱测试；范围证据见 Step 6（`git status --untracked-files=all` 权威 + package 两侧无 diff）

### 6. GLM 抗辩记录（PM 裁决）

| 项 | 裁决 |
| --- | --- |
| P1 keepalive 去 `pingId` | **采纳** — 空 payload；避免发明字段 |
| P1 nested denylist exact fields | **采纳** — `DENYLIST_ENTRY_SCHEMA` + nested helper |
| session type rename（如 `session-terminate-revoked`） | **拒绝** — PM 有证据：`session-terminate(revoked)` 更直接表达 type+argument；rename 同属发明；保留 fixed `reason` |
| `signature` → `ed25519Signature` | **拒绝** — 上位计划/spec 明确字段名 `signature` |
| 重复 `CONTROL_PLANE_MESSAGE_TYPES` | **拒绝** — 双源漂移 |
| 双 import / 源码字符串扫描 import | **拒绝** — 脆弱；用范围 `status --untracked-files=all` + package working/cached 双侧 diff 证明无依赖 |
| deep freeze + field-only 非安全 validator 警示 | **采纳**，并用更严格 `Reflect.ownKeys` / plain-record / Proxy fail-closed 边界实现 |

---

## Quantity Self-Check

| 集合 | 数量 |
| --- | ---: |
| message types | **13** |
| fixedValues 非空 type | **2**（`noise-msg2-payload`、`session-terminate`） |
| exact empty payload type | **2**（`keepalive-ping`、`keepalive-pong`） |
| denylist entry 合法字段组合 | **4** |
| 新增实现文件 | **2** |
| 本任务修改既有文件 | **0** |

---

## File Map

| Path | Role | This task |
| --- | --- | --- |
| `test/cross-lan-protocol.test.js` | T1.2 schema / predicate 全量单测 | **Create（Step 1 RED 先建）** |
| `src/cross-lan-protocol.js` | 冻结 schema + pure exact-field predicates | **Create（Step 3 GREEN）** |
| 其它一切 | 超出范围 | **Do not touch** |

---

## Interfaces（实现后冻结契约）

**Consumes:** 无（无 import）。

**Produces:**

```js
// src/cross-lan-protocol.js

/** @typedef {{
 *   requiredFields: ReadonlyArray<string>,
 *   optionalFields: ReadonlyArray<string>,
 *   fixedValues: Readonly<Record<string, unknown>>,
 * }} ControlPlaneMessageSchemaDescriptor */

/** @type {Readonly<Record<string, ControlPlaneMessageSchemaDescriptor>>} */
export const CONTROL_PLANE_MESSAGE_SCHEMAS;

/**
 * Nested denylist entry field groups (L1 relay denylist shape only).
 * @type {Readonly<{
 *   identifierFields: ReadonlyArray<string>,
 *   generationFields: ReadonlyArray<string>,
 * }>}
 */
export const DENYLIST_ENTRY_SCHEMA;

/**
 * Field-shape exactness for a control-plane message payload.
 * NOT a security/crypto/wire/semantic validator.
 * @param {string} messageType
 * @param {unknown} payload
 * @returns {boolean}
 */
export function hasExactControlPlaneMessageFields(messageType, payload);

/**
 * Nested denylist entry: exactly one identifier + one generation field.
 * @param {unknown} entry
 * @returns {boolean}
 */
export function hasExactDenylistEntryFields(entry);
```

---

### Task 1: Define control-plane message schemas (TDD)

**Files:**
- Create: `test/cross-lan-protocol.test.js`（完整文件，见 Step 1）
- Create: `src/cross-lan-protocol.js`（完整文件，见 Step 3）
- Do not modify any other files

**Interfaces:**
- Consumes: none
- Produces: 上表四导出；13 schema exact pin；nested denylist helper

---

- [ ] **Step 1: Write the failing test（完整创建 `test/cross-lan-protocol.test.js`）**

在工作区根创建 `test/cross-lan-protocol.test.js`，内容**必须**为下列完整文件（不得省略、不得 placeholder、不得用循环从 type 列表生成 expected schema 来代替字面量闭集 pin——`EXPECTED_CONTROL_PLANE_MESSAGE_SCHEMAS` 必须是完整字面量）：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  CONTROL_PLANE_MESSAGE_SCHEMAS,
  DENYLIST_ENTRY_SCHEMA,
  hasExactControlPlaneMessageFields,
  hasExactDenylistEntryFields,
} from '../src/cross-lan-protocol.js';

/**
 * Closed-set pin of all 13 control-plane message schemas (T1.2).
 * Exact field names and fixed values are frozen by PM design.
 */
const EXPECTED_CONTROL_PLANE_MESSAGE_SCHEMAS = {
  'noise-msg1-payload': {
    requiredFields: [
      'deviceId',
      'enrollmentEpoch',
      'ed25519IdentityPub',
      'identityBindingSig',
      'clientNonce',
      'clientTimeUtc',
    ],
    optionalFields: [],
    fixedValues: {},
  },
  'noise-msg2-payload': {
    requiredFields: [
      'controllerId',
      'enrollmentEpoch',
      'serverNonce',
      'serverTimeUtc',
      'keyConfirmServer',
    ],
    optionalFields: ['rekeyGeneration'],
    fixedValues: { rekeyGeneration: 0 },
  },
  'key-confirm-client': {
    requiredFields: ['keyConfirmClient'],
    optionalFields: [],
    fixedValues: {},
  },
  'session-terminate': {
    requiredFields: ['reason'],
    optionalFields: [],
    fixedValues: { reason: 'revoked' },
  },
  'revoke-epoch': {
    requiredFields: ['deviceId', 'enrollmentEpoch', 'revokeGeneration'],
    optionalFields: [],
    fixedValues: {},
  },
  'denylist-update': {
    requiredFields: ['denylistVersion', 'entries'],
    optionalFields: [],
    fixedValues: {},
  },
  'denylist-ack': {
    requiredFields: ['denylistVersion'],
    optionalFields: [],
    fixedValues: {},
  },
  'relay-pin-set-update': {
    requiredFields: [
      'relayId',
      'oldSpkiPins',
      'newSpkiPins',
      'notBefore',
      'graceUntil',
      'updateId',
      'trustEpoch',
      'signature',
    ],
    optionalFields: [],
    fixedValues: {},
  },
  'relay-pin-set-ack': {
    requiredFields: ['updateId'],
    optionalFields: [],
    fixedValues: {},
  },
  'controller-noise-key-update': {
    requiredFields: [
      'oldNoiseStaticPub',
      'newNoiseStaticPub',
      'notBefore',
      'graceUntil',
      'trustEpoch',
      'updateId',
      'signature',
    ],
    optionalFields: [],
    fixedValues: {},
  },
  'controller-noise-key-ack': {
    requiredFields: ['updateId'],
    optionalFields: [],
    fixedValues: {},
  },
  'keepalive-ping': {
    requiredFields: [],
    optionalFields: [],
    fixedValues: {},
  },
  'keepalive-pong': {
    requiredFields: [],
    optionalFields: [],
    fixedValues: {},
  },
};

const EXPECTED_DENYLIST_ENTRY_SCHEMA = {
  identifierFields: ['tunnelId', 'deviceRoutingHandle'],
  generationFields: ['epoch', 'revokeGeneration'],
};

/** Fixed sentinel only — never put real secrets in fixtures. */
const SENTINEL_SECRET = 'SENTINEL_NOT_A_REAL_SECRET_VALUE';

/**
 * Minimal valid payloads per type (field presence only; values are dummies).
 * Values are NOT cryptographic material — schema is field-shape only.
 */
const MINIMAL_VALID_PAYLOADS = {
  'noise-msg1-payload': {
    deviceId: 'dev-1',
    enrollmentEpoch: 1,
    ed25519IdentityPub: 'pub',
    identityBindingSig: 'sig',
    clientNonce: 'nonce',
    clientTimeUtc: '2026-07-17T00:00:00.000Z',
  },
  'noise-msg2-payload': {
    controllerId: 'ctl-1',
    enrollmentEpoch: 1,
    serverNonce: 'nonce',
    serverTimeUtc: '2026-07-17T00:00:00.000Z',
    keyConfirmServer: 'mac',
  },
  'key-confirm-client': {
    keyConfirmClient: 'mac',
  },
  'session-terminate': {
    reason: 'revoked',
  },
  'revoke-epoch': {
    deviceId: 'dev-1',
    enrollmentEpoch: 1,
    revokeGeneration: 1,
  },
  'denylist-update': {
    denylistVersion: 1,
    entries: [{ tunnelId: 't1', epoch: 1 }],
  },
  'denylist-ack': {
    denylistVersion: 1,
  },
  'relay-pin-set-update': {
    relayId: 'relay-1',
    oldSpkiPins: [],
    newSpkiPins: [],
    notBefore: '2026-07-17T00:00:00.000Z',
    graceUntil: '2026-07-17T01:00:00.000Z',
    updateId: 'u1',
    trustEpoch: 1,
    signature: 'sig',
  },
  'relay-pin-set-ack': {
    updateId: 'u1',
  },
  'controller-noise-key-update': {
    oldNoiseStaticPub: 'old',
    newNoiseStaticPub: 'new',
    notBefore: '2026-07-17T00:00:00.000Z',
    graceUntil: '2026-07-17T01:00:00.000Z',
    trustEpoch: 1,
    updateId: 'u1',
    signature: 'sig',
  },
  'controller-noise-key-ack': {
    updateId: 'u1',
  },
  'keepalive-ping': {},
  'keepalive-pong': {},
};

class ExampleClass {
  constructor() {
    this.x = 1;
  }
}

describe('control-plane message schemas (T1.2)', () => {
  it('pins the exact closed-set of 13 message schemas', () => {
    assert.strictEqual(Object.keys(EXPECTED_CONTROL_PLANE_MESSAGE_SCHEMAS).length, 13);
    assert.strictEqual(Object.keys(CONTROL_PLANE_MESSAGE_SCHEMAS).length, 13);
    assert.deepStrictEqual(CONTROL_PLANE_MESSAGE_SCHEMAS, EXPECTED_CONTROL_PLANE_MESSAGE_SCHEMAS);
  });

  it('deep-freezes CONTROL_PLANE_MESSAGE_SCHEMAS and every descriptor field', () => {
    assert.ok(Object.isFrozen(CONTROL_PLANE_MESSAGE_SCHEMAS));
    for (const type of Object.keys(CONTROL_PLANE_MESSAGE_SCHEMAS)) {
      const d = CONTROL_PLANE_MESSAGE_SCHEMAS[type];
      assert.ok(Object.isFrozen(d), `descriptor frozen: ${type}`);
      assert.ok(Object.isFrozen(d.requiredFields), `requiredFields frozen: ${type}`);
      assert.ok(Object.isFrozen(d.optionalFields), `optionalFields frozen: ${type}`);
      assert.ok(Object.isFrozen(d.fixedValues), `fixedValues frozen: ${type}`);
    }
  });

  it('deep-freezes DENYLIST_ENTRY_SCHEMA and both field arrays', () => {
    assert.deepStrictEqual(DENYLIST_ENTRY_SCHEMA, EXPECTED_DENYLIST_ENTRY_SCHEMA);
    assert.ok(Object.isFrozen(DENYLIST_ENTRY_SCHEMA));
    assert.ok(Object.isFrozen(DENYLIST_ENTRY_SCHEMA.identifierFields));
    assert.ok(Object.isFrozen(DENYLIST_ENTRY_SCHEMA.generationFields));
  });

  it('accepts minimal valid payloads for all 13 types', () => {
    for (const type of Object.keys(EXPECTED_CONTROL_PLANE_MESSAGE_SCHEMAS)) {
      const payload = MINIMAL_VALID_PAYLOADS[type];
      assert.strictEqual(
        hasExactControlPlaneMessageFields(type, payload),
        true,
        `minimal valid for ${type}`,
      );
    }
  });

  it('accepts Object.create(null) plain records with exact fields', () => {
    const payload = Object.assign(Object.create(null), {
      keyConfirmClient: 'mac',
    });
    assert.strictEqual(hasExactControlPlaneMessageFields('key-confirm-client', payload), true);
  });

  it('noise-msg2-payload optional rekeyGeneration: missing or 0 true; 1/"0"/-0 false', () => {
    const base = { ...MINIMAL_VALID_PAYLOADS['noise-msg2-payload'] };
    assert.strictEqual(hasExactControlPlaneMessageFields('noise-msg2-payload', base), true);
    assert.strictEqual(
      hasExactControlPlaneMessageFields('noise-msg2-payload', { ...base, rekeyGeneration: 0 }),
      true,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('noise-msg2-payload', { ...base, rekeyGeneration: 1 }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('noise-msg2-payload', { ...base, rekeyGeneration: '0' }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('noise-msg2-payload', { ...base, rekeyGeneration: -0 }),
      false,
    );
  });

  it('session-terminate only accepts fixed reason revoked', () => {
    assert.strictEqual(
      hasExactControlPlaneMessageFields('session-terminate', { reason: 'revoked' }),
      true,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('session-terminate', { reason: 'timeout' }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('session-terminate', { reason: 'REVOKED' }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('session-terminate', {}),
      false,
    );
  });

  it('keepalive types accept exact empty payload and reject invented pingId', () => {
    assert.strictEqual(hasExactControlPlaneMessageFields('keepalive-ping', {}), true);
    assert.strictEqual(hasExactControlPlaneMessageFields('keepalive-pong', {}), true);
    assert.strictEqual(
      hasExactControlPlaneMessageFields('keepalive-ping', { pingId: 1 }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('keepalive-pong', { pingId: 1 }),
      false,
    );
  });

  it('rejects unknown type, null, array, Date, Buffer, class instance', () => {
    assert.strictEqual(hasExactControlPlaneMessageFields('no-such-type', {}), false);
    // Object.prototype names must not resolve via inherited lookup (own-key only).
    assert.strictEqual(hasExactControlPlaneMessageFields('toString', {}), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('constructor', {}), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('__proto__', {}), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('hasOwnProperty', {}), false);
    assert.doesNotThrow(() => {
      hasExactControlPlaneMessageFields('toString', {});
      hasExactControlPlaneMessageFields('constructor', {});
      hasExactControlPlaneMessageFields('__proto__', {});
      hasExactControlPlaneMessageFields('hasOwnProperty', {});
    });
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', null), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', []), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', new Date()), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', Buffer.from('x')), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', new ExampleClass()), false);
  });

  it('rejects missing required, extra unknown, symbol, non-enumerable, accessor', () => {
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', {}), false);

    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-ack', {
        denylistVersion: 1,
        extra: true,
      }),
      false,
    );

    const withSymbol = { denylistVersion: 1 };
    Object.defineProperty(withSymbol, Symbol('s'), { value: 1, enumerable: true });
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', withSymbol), false);

    const nonEnum = {};
    Object.defineProperty(nonEnum, 'denylistVersion', {
      value: 1,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', nonEnum), false);

    const accessor = {};
    Object.defineProperty(accessor, 'denylistVersion', {
      get() {
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', accessor), false);
  });

  it('returns false for throwing Proxy without throwing', () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(SENTINEL_SECRET);
        },
        get() {
          throw new Error(SENTINEL_SECRET);
        },
        getOwnPropertyDescriptor() {
          throw new Error(SENTINEL_SECRET);
        },
        getPrototypeOf() {
          throw new Error(SENTINEL_SECRET);
        },
      },
    );
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', proxy), false);
    assert.strictEqual(hasExactDenylistEntryFields(proxy), false);
  });

  it('returns boolean false for invalid extra keys without throwing', () => {
    const bad = {
      denylistVersion: 1,
      [SENTINEL_SECRET]: SENTINEL_SECRET,
    };
    let result;
    assert.doesNotThrow(() => {
      result = hasExactControlPlaneMessageFields('denylist-ack', bad);
    });
    assert.strictEqual(result, false);
    assert.strictEqual(typeof result, 'boolean');
  });

  it('accepts all four legal denylist entry field combinations', () => {
    assert.strictEqual(hasExactDenylistEntryFields({ tunnelId: 't', epoch: 1 }), true);
    assert.strictEqual(
      hasExactDenylistEntryFields({ tunnelId: 't', revokeGeneration: 1 }),
      true,
    );
    assert.strictEqual(
      hasExactDenylistEntryFields({ deviceRoutingHandle: 'h', epoch: 1 }),
      true,
    );
    assert.strictEqual(
      hasExactDenylistEntryFields({ deviceRoutingHandle: 'h', revokeGeneration: 1 }),
      true,
    );
    // null-prototype plain record with a legal pair is accepted.
    const nullProtoEntry = Object.assign(Object.create(null), {
      tunnelId: 't',
      epoch: 1,
    });
    assert.strictEqual(hasExactDenylistEntryFields(nullProtoEntry), true);
  });

  it('rejects illegal denylist entry shapes', () => {
    assert.strictEqual(hasExactDenylistEntryFields(null), false);
    assert.strictEqual(hasExactDenylistEntryFields([]), false);
    assert.strictEqual(hasExactDenylistEntryFields(new Date()), false);
    assert.strictEqual(hasExactDenylistEntryFields({ tunnelId: 't' }), false);
    assert.strictEqual(
      hasExactDenylistEntryFields({ tunnelId: 't', epoch: 1, revokeGeneration: 2 }),
      false,
    );
    assert.strictEqual(
      hasExactDenylistEntryFields({ tunnelId: 't', deviceRoutingHandle: 'h' }),
      false,
    );
    assert.strictEqual(
      hasExactDenylistEntryFields({ epoch: 1, revokeGeneration: 2 }),
      false,
    );
    assert.strictEqual(
      hasExactDenylistEntryFields({ tunnelId: 't', epoch: 1, extra: true }),
      false,
    );
    assert.strictEqual(hasExactDenylistEntryFields({ foo: 1, bar: 2 }), false);
    assert.strictEqual(hasExactDenylistEntryFields(new ExampleClass()), false);
  });

  it('denylist-update requires entries array of exact entries; empty array ok', () => {
    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-update', {
        denylistVersion: 1,
        entries: [],
      }),
      true,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-update', {
        denylistVersion: 1,
        entries: [{ tunnelId: 't', epoch: 1 }],
      }),
      true,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-update', {
        denylistVersion: 1,
        entries: 'not-array',
      }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-update', {
        denylistVersion: 1,
        entries: [{ tunnelId: 't', epoch: 1, extra: true }],
      }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-update', {
        denylistVersion: 1,
        entries: [{ tunnelId: 't', epoch: 1 }, { bad: true }],
      }),
      false,
    );
  });
});
```

说明（实现者必读）：

- 测试文件**首先**创建；此时 `src/cross-lan-protocol.js` 尚不存在 → Step 2 预期 `ERR_MODULE_NOT_FOUND`。
- expected schema 为字面量闭集 pin（13 type）；不得从生产 schema re-export 生成 expected。
- 无效 extra keys 用例只证明 **boolean false + doesNotThrow**；sentinel 非真实 secret；**不**宣称证明日志系统无泄漏。
- unknown-type `it` 内必须覆盖 `toString` / `constructor` / `__proto__` / `hasOwnProperty` 均 false，并含至少一条 `assert.doesNotThrow`；**不**新增 it（总数仍 15）。
- denylist legal/illegal `it` 内分别并入 `Object.create(null)` 合法 entry true 与 `{foo:1,bar:2}` false；**不**新增 it。
- **不要**添加“读取 `src/cross-lan-protocol.js` 源码字符串断言无 import”的测试。

---

- [ ] **Step 2: Run targeted tests to verify RED**

Run:

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
node --test test/cross-lan-protocol.test.js
```

**Expected RED（精确语义）：**

- 退出码 **非 0**。
- 根因是 **`ERR_MODULE_NOT_FOUND`**（`../src/cross-lan-protocol.js` 尚不存在），**不是**测试文件语法错误、也不是断言失败。
- 输出应含 `Cannot find module` / `ERR_MODULE_NOT_FOUND` 一类信息，指向 `cross-lan-protocol`。

若出现 **SyntaxError**（测试文件本身语法错误）或其它非 MODULE_NOT_FOUND 失败：停止并修正测试文件，**不要**进入 Step 3。

---

- [ ] **Step 3: Minimal implementation（完整创建 `src/cross-lan-protocol.js`）**

创建 `src/cross-lan-protocol.js`，内容**必须**为下列完整文件（不得省略；不得添加 import；不得扩展为 crypto/状态机）：

```js
/**
 * Linke V2 control-plane message schema scaffold (T1.2 / M1).
 *
 * Field-level + nested field-shape only.
 * NOT a security, crypto, wire-encoding, or semantic validator.
 * Does not verify nonces, MACs/signatures, times, uint64 ranges,
 * binary encodings, trust state, or AEAD.
 *
 * T1.0 Noise library selection gate remains BLOCKED.
 * This module does not claim Noise / E2EE / cross-LAN / M1 readiness.
 *
 * Keepalive types are Noise AEAD application-layer messages with empty
 * payloads — not RFC6455 WebSocket ping/pong (transport timing is T1.9/M3).
 *
 * `signature` fields (relay-pin-set-update, controller-noise-key-update)
 * are controller Ed25519 signatures over canonical TBS in later tasks;
 * this module only checks field presence/shape.
 *
 * `keyConfirmClient` is the frozen camelCase mirror of spec `keyConfirmServer`
 * (design §6.7.2.5 client confirm transport message payload field name).
 */

/**
 * @param {string[]} requiredFields
 * @param {string[]} [optionalFields]
 * @param {Record<string, unknown>} [fixedValues]
 */
function freezeDescriptor(requiredFields, optionalFields = [], fixedValues = {}) {
  return Object.freeze({
    requiredFields: Object.freeze(requiredFields.slice()),
    optionalFields: Object.freeze(optionalFields.slice()),
    fixedValues: Object.freeze({ ...fixedValues }),
  });
}

/**
 * Frozen closed-set of control-plane message schemas.
 * Message type identity is Object.keys(this object) only — no second registry.
 * @type {Readonly<Record<string, {
 *   requiredFields: ReadonlyArray<string>,
 *   optionalFields: ReadonlyArray<string>,
 *   fixedValues: Readonly<Record<string, unknown>>,
 * }>>}
 */
export const CONTROL_PLANE_MESSAGE_SCHEMAS = Object.freeze({
  'noise-msg1-payload': freezeDescriptor([
    'deviceId',
    'enrollmentEpoch',
    'ed25519IdentityPub',
    'identityBindingSig',
    'clientNonce',
    'clientTimeUtc',
  ]),
  'noise-msg2-payload': freezeDescriptor(
    ['controllerId', 'enrollmentEpoch', 'serverNonce', 'serverTimeUtc', 'keyConfirmServer'],
    ['rekeyGeneration'],
    { rekeyGeneration: 0 },
  ),
  'key-confirm-client': freezeDescriptor(['keyConfirmClient']),
  'session-terminate': freezeDescriptor(['reason'], [], { reason: 'revoked' }),
  'revoke-epoch': freezeDescriptor(['deviceId', 'enrollmentEpoch', 'revokeGeneration']),
  'denylist-update': freezeDescriptor(['denylistVersion', 'entries']),
  'denylist-ack': freezeDescriptor(['denylistVersion']),
  'relay-pin-set-update': freezeDescriptor([
    'relayId',
    'oldSpkiPins',
    'newSpkiPins',
    'notBefore',
    'graceUntil',
    'updateId',
    'trustEpoch',
    'signature',
  ]),
  'relay-pin-set-ack': freezeDescriptor(['updateId']),
  'controller-noise-key-update': freezeDescriptor([
    'oldNoiseStaticPub',
    'newNoiseStaticPub',
    'notBefore',
    'graceUntil',
    'trustEpoch',
    'updateId',
    'signature',
  ]),
  'controller-noise-key-ack': freezeDescriptor(['updateId']),
  'keepalive-ping': freezeDescriptor([]),
  'keepalive-pong': freezeDescriptor([]),
});

/**
 * Nested L1 denylist entry field groups (shape only).
 * @type {Readonly<{
 *   identifierFields: ReadonlyArray<string>,
 *   generationFields: ReadonlyArray<string>,
 * }>}
 */
export const DENYLIST_ENTRY_SCHEMA = Object.freeze({
  identifierFields: Object.freeze(['tunnelId', 'deviceRoutingHandle']),
  generationFields: Object.freeze(['epoch', 'revokeGeneration']),
});

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject symbols, non-enumerable own keys, and accessor properties.
 * @param {object} record
 * @returns {string[] | null} string own keys, or null if invalid
 */
function getExactOwnStringDataKeys(record) {
  const ownKeys = Reflect.ownKeys(record);
  /** @type {string[]} */
  const stringKeys = [];
  for (const key of ownKeys) {
    if (typeof key === 'symbol') return null;
    const desc = Object.getOwnPropertyDescriptor(record, key);
    if (!desc || desc.enumerable !== true) return null;
    if (desc.get !== undefined || desc.set !== undefined) return null;
    stringKeys.push(key);
  }
  return stringKeys;
}

/**
 * Nested denylist entry: exactly one identifier field + one generation field.
 * Does not validate value types or wire encoding.
 * @param {unknown} entry
 * @returns {boolean}
 */
export function hasExactDenylistEntryFields(entry) {
  try {
    if (!isPlainRecord(entry)) return false;
    const keys = getExactOwnStringDataKeys(entry);
    if (keys === null || keys.length !== 2) return false;

    const keySet = new Set(keys);
    let idCount = 0;
    for (const f of DENYLIST_ENTRY_SCHEMA.identifierFields) {
      if (keySet.has(f)) idCount += 1;
    }
    let genCount = 0;
    for (const f of DENYLIST_ENTRY_SCHEMA.generationFields) {
      if (keySet.has(f)) genCount += 1;
    }
    return idCount === 1 && genCount === 1;
  } catch {
    return false;
  }
}

/**
 * Field-shape exactness for a control-plane message payload.
 * Returns boolean only; never throws; never echoes input.
 * NOT a security/crypto/wire/semantic validator.
 * @param {string} messageType
 * @param {unknown} payload
 * @returns {boolean}
 */
export function hasExactControlPlaneMessageFields(messageType, payload) {
  try {
    if (typeof messageType !== 'string') return false;
    // Own-key only: reject Object.prototype names (toString/constructor/__proto__/…).
    // Do not use truthy schema lookup — inherited names must never fail-open.
    if (!Object.hasOwn(CONTROL_PLANE_MESSAGE_SCHEMAS, messageType)) return false;
    const schema = CONTROL_PLANE_MESSAGE_SCHEMAS[messageType];
    if (!isPlainRecord(payload)) return false;

    const ownKeys = getExactOwnStringDataKeys(payload);
    if (ownKeys === null) return false;

    /** @type {Set<string>} */
    const allowed = new Set([
      ...schema.requiredFields,
      ...schema.optionalFields,
      ...Object.keys(schema.fixedValues),
    ]);

    for (const key of ownKeys) {
      if (!allowed.has(key)) return false;
    }

    for (const req of schema.requiredFields) {
      if (!ownKeys.includes(req)) return false;
    }

    for (const [fixedKey, fixedValue] of Object.entries(schema.fixedValues)) {
      if (ownKeys.includes(fixedKey)) {
        if (!Object.is(payload[fixedKey], fixedValue)) return false;
      }
    }

    if (messageType === 'denylist-update') {
      const entries = payload.entries;
      if (!Array.isArray(entries)) return false;
      for (const item of entries) {
        if (!hasExactDenylistEntryFields(item)) return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
```

实现约束再强调：

- **不要** `import` 任何模块。
- **不要**导出 `CONTROL_PLANE_MESSAGE_TYPES` 或其它重复 type 列表。
- **不要**把 `signature` 改名为 `ed25519Signature`。
- **不要**给 keepalive 加 `pingId`。
- **不要**实现验签 / MAC / nonce 长度 / 时间窗 / uint64。
- **不要**改 `error-codes.js` 或其它既有文件。

---

- [ ] **Step 4: Run targeted tests to verify GREEN**

Run:

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
node --test test/cross-lan-protocol.test.js
```

**Expected GREEN：**

- 退出码 **0**。
- suite `control-plane message schemas (T1.2)` 下全部 it 通过（本 plan 共 **15** 个 `it`）。
- 无 failure / todo。

若失败：优先核对 13 schema 字面量拼写、`Object.is` 对 `-0`/`'0'`、plain-record 拒绝 Date/Buffer/class、denylist 四种组合与 nested entries。

---

- [ ] **Step 5: Full regression GREEN**

Run:

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
env -u FORCE_COLOR -u NO_COLOR npm test
```

**Expected：**

- 退出码 **0**。
- 全量 `node --test test/*.test.js` 通过（含既有 T1.1 error-codes 与全部既有 suite）。
- 本变更为纯新增两文件，不得导致下游失败。

若全量失败且归因于本变更：修复**仅限**两新文件；不得为“消红”改 version / scorecard / 其它模块。

---

- [ ] **Step 6: Diff / scope / numeric verification**

**范围权威命令（untracked 可见）：**

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
git status --short --untracked-files=all
```

**人工精确期望（status 权威）：**

实现交付完成后，status 输出中**必须**看见（实现相关 untracked）：

```text
?? src/cross-lan-protocol.js
?? test/cross-lan-protocol.test.js
```

并**允许**既有无关 untracked：

```text
?? package-lock.json
```

- **`?? package-lock.json` 可存在**，但**不得** staged（不得出现 `A` / `M` / 索引侧状态；status 中 package-lock 只能是 `??`）。
- 本 plan 文档应由 PM 以独立 docs commit 入库；实现阶段工作区**不应**再把 plan 当作未提交交付物与 feat 混交。
- **禁止**对 `package.json`、`src/version.js`、`src/gold-readiness.js`、`src/error-codes.js`、`README.md`、其它既有 src/test 的修改；`package-lock.json` 永不纳入 commit。

**重要：`git diff` / `git diff --name-only` / `git diff --stat` 不显示 untracked 文件。**

- **禁止**把「`git diff` 为空」当成「交付范围只有两新文件」的证据——untracked 新文件对 plain diff **不可见**。
- 交付范围是否正确的**唯一权威**是：`git status --short --untracked-files=all` 中看见上述 `??` 两实现文件（及可选 `?? package-lock.json`）。
- 可**保留**下列 diff 命令，**仅**用于已跟踪文件的越界检查（不是 untracked 交付证明）：

```bash
# 仅检查已跟踪路径是否被改动（输出应为空；不证明 untracked 交付）
git diff --name-only
git diff --stat
```

**package 文件两侧只读门禁（清晰命令 + 人工期望；勿用 `test -z "$(...)"` 易误读写法）：**

```bash
# working tree：package.json 不得有未暂存修改 → 必须无输出
git diff -- package.json

# index / staged：package.json 与 package-lock.json 均不得 staged → 必须无输出
git diff --cached -- package.json package-lock.json

# 再看 status：package-lock 若存在，只能是 untracked（??），不能是 staged
git status --short --untracked-files=all -- package.json package-lock.json
```

**人工期望：**

| 命令 | 精确期望 |
| --- | --- |
| `git diff -- package.json` | **无输出**（working tree 未改 package.json） |
| `git diff --cached -- package.json package-lock.json` | **无输出**（二者均未 staged） |
| status 中 `package-lock.json` | 仅允许 `?? package-lock.json`；**禁止** staged |
| status 中 `package.json` | 无 `M` / `A` / 其它变更行 |

**数值 / 冻结快速自检：**

```bash
node -e "
import {
  CONTROL_PLANE_MESSAGE_SCHEMAS,
  DENYLIST_ENTRY_SCHEMA,
  hasExactControlPlaneMessageFields,
  hasExactDenylistEntryFields,
} from './src/cross-lan-protocol.js';

const types = Object.keys(CONTROL_PLANE_MESSAGE_SCHEMAS);
console.log('typeCount', types.length);
console.log('outerFrozen', Object.isFrozen(CONTROL_PLANE_MESSAGE_SCHEMAS));
let allDescFrozen = true;
for (const t of types) {
  const d = CONTROL_PLANE_MESSAGE_SCHEMAS[t];
  if (!Object.isFrozen(d) || !Object.isFrozen(d.requiredFields)
    || !Object.isFrozen(d.optionalFields) || !Object.isFrozen(d.fixedValues)) {
    allDescFrozen = false;
  }
}
console.log('allDescFrozen', allDescFrozen);
console.log('denylistFrozen', Object.isFrozen(DENYLIST_ENTRY_SCHEMA)
  && Object.isFrozen(DENYLIST_ENTRY_SCHEMA.identifierFields)
  && Object.isFrozen(DENYLIST_ENTRY_SCHEMA.generationFields));
console.log('ownKeyRejectsProtoNames',
  !hasExactControlPlaneMessageFields('toString', {})
  && !hasExactControlPlaneMessageFields('constructor', {})
  && !hasExactControlPlaneMessageFields('__proto__', {})
  && !hasExactControlPlaneMessageFields('hasOwnProperty', {}));
console.log('keepaliveEmpty',
  hasExactControlPlaneMessageFields('keepalive-ping', {})
  && !hasExactControlPlaneMessageFields('keepalive-ping', { pingId: 1 }));
console.log('sessionRevokedOnly',
  hasExactControlPlaneMessageFields('session-terminate', { reason: 'revoked' })
  && !hasExactControlPlaneMessageFields('session-terminate', { reason: 'timeout' }));
console.log('msg2ObjectIs',
  hasExactControlPlaneMessageFields('noise-msg2-payload', {
    controllerId: 'c', enrollmentEpoch: 1, serverNonce: 'n',
    serverTimeUtc: 't', keyConfirmServer: 'm', rekeyGeneration: 0,
  })
  && !hasExactControlPlaneMessageFields('noise-msg2-payload', {
    controllerId: 'c', enrollmentEpoch: 1, serverNonce: 'n',
    serverTimeUtc: 't', keyConfirmServer: 'm', rekeyGeneration: -0,
  }));
console.log('denylistFour',
  hasExactDenylistEntryFields({ tunnelId: 't', epoch: 1 })
  && hasExactDenylistEntryFields({ tunnelId: 't', revokeGeneration: 1 })
  && hasExactDenylistEntryFields({ deviceRoutingHandle: 'h', epoch: 1 })
  && hasExactDenylistEntryFields({ deviceRoutingHandle: 'h', revokeGeneration: 1 }));
console.log('denylistNullProto',
  hasExactDenylistEntryFields(Object.assign(Object.create(null), { tunnelId: 't', epoch: 1 })));
console.log('denylistFooBarFalse',
  !hasExactDenylistEntryFields({ foo: 1, bar: 2 }));
console.log('emptyEntriesOk',
  hasExactControlPlaneMessageFields('denylist-update', { denylistVersion: 1, entries: [] }));
"
```

期望语义：`typeCount 13`；全部 frozen `true`；`ownKeyRejectsProtoNames` / keepalive / session / msg2 Object.is / denylist four / nullProto / fooBar / emptyEntries 打印均为真值语义。

**无依赖证据（不要源码字符串扫描）：**

- 权威：`git status --short --untracked-files=all` 显示两实现文件 `??` + 可选 `?? package-lock.json`。
- package：`git diff -- package.json` 与 `git diff --cached -- package.json package-lock.json` **均无输出**。
- **不要**用 `git diff` 为空反证 untracked 交付范围。

**Runtime resilience 替代验证（本模块无 I/O / 无可变状态 → N/A 正式项）：**

| 检查 | 如何证明 |
| --- | --- |
| deep freeze | unit tests + Step 6 node -e |
| 13 exact pin | `deepStrictEqual` |
| messageType own-key only | `Object.hasOwn` + prototype-name tests |
| plain-record / Proxy fail-closed | unit tests；boolean false + no throw |
| fixed `Object.is` | rekeyGeneration / reason 用例 |
| nested denylist | 四组合 + null-proto + foo/bar + denylist-update entries |
| 无依赖 | status 权威 + package 两侧无 diff；模块无 import |
| 全量回归 | `env -u FORCE_COLOR -u NO_COLOR npm test` exit 0 |

---

- [ ] **Step 7: PM path-specific stage / commit / push（仅两目标新文件；PM 执行）**

**执行者：PM（Codex），不是 Grok 实现者。**

**前置条件：** Step 4–6 新鲜验证全部通过（targeted GREEN + full `npm test` GREEN + scope gate）。

用户已明确授权本 Gold loop **自动 commit 与 push**，无需再次向用户确认。PM 完成下列步骤后**立即进入下一任务**。

**7.0 若本 plan 文档尚未入库（PM 先做独立 docs commit）**

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
git add docs/superpowers/plans/2026-07-17-linke-v2-m1-control-plane-message-schemas.md
git commit --only docs/superpowers/plans/2026-07-17-linke-v2-m1-control-plane-message-schemas.md -m "docs: plan v2 control-plane message schemas"
git show --name-only --pretty=format: HEAD
# 必须恰好一行：docs/superpowers/plans/2026-07-17-linke-v2-m1-control-plane-message-schemas.md
git push
```

实现 feat commit **不得**与 docs plan commit 混合。

**7.1 检查既有 staging（只读记录；禁止 unstage；不阻塞）**

```bash
cd /Users/ah/linke/.worktrees/linke-v0.12-web-panel
git diff --cached --name-only
```

- **只读**记录当前 cached 路径列表（允许为空，也允许含用户/其它路径）。
- **严禁** unstage：禁止 `git restore --staged`、`git reset`、`git restore --staged --worktree` 或任何取消暂存命令。
- 不要因“cached 不止两文件”而停止。

**7.2 路径专属暂存（仅两目标新文件）**

```bash
git add src/cross-lan-protocol.js test/cross-lan-protocol.test.js
git status --short
git diff --cached --name-only
git diff --cached --stat
```

**Staging 确认（非 exclusive gate）：**

- `src/cross-lan-protocol.js` 与 `test/cross-lan-protocol.test.js` **必须**出现在 `git diff --cached --name-only` 中。
- **允许**其它用户已 staged 路径继续存在；**禁止**为清 index 而 unstage。
- **不要求** cached 最终恰好两行。

**禁止：**

```bash
# 禁止使用：
git add .
git add -A
git add --all
git restore --staged
git restore --staged --worktree
git reset HEAD
# 禁止无 pathspec 的 plain commit：
# git commit -m "feat: define v2 control-plane message schemas"
# 禁止把 package-lock.json 或 plan docs 加入 feat commit
```

**7.3 自动 commit（必须 `--only` pathspec）**

```bash
git commit --only src/cross-lan-protocol.js test/cross-lan-protocol.test.js -m "feat: define v2 control-plane message schemas"
git show --name-only --pretty=format: HEAD
git status --short
```

**HEAD commit 文件范围 gate（隔离证明）：** `git show --name-only --pretty=format: HEAD` 必须**恰好**只含：

```text
src/cross-lan-protocol.js
test/cross-lan-protocol.test.js
```

（两行、无第三路径。若多出任何路径，视为 commit 失败/污染，停止 push 并上报。）

**7.4 自动 push（PM 执行）**

```bash
git push
```

**Expected：**

- docs plan 已独立入库（message：`docs: plan v2 control-plane message schemas`）。
- feat commit 成功，message subject 精确为 `feat: define v2 control-plane message schemas`。
- `git show --name-only --pretty=format: HEAD` 恰好两目标路径。
- push 成功。
- untracked `package-lock.json`（若存在）仍保持 untracked、未入库。
- 用户其它 staged 路径（若有）仍可保留在 index，**未被**本 feat commit 吞入。
- PM 完成 push 后**立即进入下一任务**（T1.3 或 M1 队列下一未完成项），无需再向用户确认 commit/push。

**Grok 实现者在本步的职责：** 零 Git 写操作；仅在交接报告中声明 Step 4–6 已通过，并把 diff/status 摘要交给 PM。

---

## Out of Scope（明确不在本 plan 实现）

- T1.0 Noise library selection 解阻 / 引入 crypto 依赖
- T1.1 以外的 error-codes 再改
- T1.3 会话状态机（idle → handshaking → established → …）
- T1.4+ 重放 / 降级 / 时钟窗 / 容量常量 / fixed vectors
- 网络、WSS、proxy、Keychain、persistence
- `signature` / MAC / nonce 密码学验证
- keepalive 传输定时与 RFC6455 交互（T1.9 / M3）
- `src/version.js` / Gold scorecard / README 版本宣称
- 依赖新增或 `package-lock.json` 变更
- 宣称 M1 PASS、T1.0 PASS、cross-lan-connectivity ready

---

## Plan Self-Review

### 1. Spec / PM 裁决覆盖

| 裁决 / 要求 | Plan 落点 |
| --- | --- |
| 仅两新文件 | File Map + Global Constraints + Step 6–7 |
| 13 schema exact 字面量 | Quantity + Step 1 expected object + Step 3 source |
| keepalive 空 payload、无 pingId | PM 裁决 §3 + 测试 + 源码 |
| session-terminate + fixed reason revoked | 表 + 测试 + 源码；拒绝 rename |
| signature 字段名保留；JSDoc 说明 Ed25519 | PM 裁决 + 源文件头注释 |
| keyConfirmClient 镜像 keyConfirmServer | PM 裁决 + schema + 注释 |
| DENYLIST_ENTRY_SCHEMA + 4 组合 + nested | §4 + 测试 + 源码 |
| 无第二 type registry | Architecture + 源码注释 + Out of Scope |
| Reflect.ownKeys / plain-record / Proxy fail-closed | 源码 helpers + 测试 |
| messageType **own property**（`Object.hasOwn`）；拒绝 Object.prototype 名 | API §5 + Step 3 lookup + unknown-type `it` 四原型名 + doesNotThrow |
| field-only NOT security validator | 源文件头 + Interfaces + tests 文案 |
| invalid extra keys：boolean false + no throw（不宣称日志无泄漏） | Step 1 诚实 it 标题 + API §5 |
| denylist null-proto legal + `{foo,bar}` illegal | Step 1 legal/illegal `it` 并入（不增 it） |
| 无 import；无源码扫描测试 | Global Constraints + Step 1 说明 + Step 6 证据 |
| RED = ERR_MODULE_NOT_FOUND | Step 2 |
| TDD Step 1→6；PM commit --only + push | Step 1–7 + Handoff |
| 范围权威 = `git status --short --untracked-files=all`；diff 不证 untracked | Step 6 |
| package working+cached 两侧检查；lock 仅 `??`、不得 staged | Step 6 清晰只读命令 + 人工表 |
| package-lock 永不纳入 | Global Constraints + Step 6–7 |
| T1.0 仍 BLOCKED；不宣称 M1 ready | Architecture + Out of Scope |
| GLM 抗辩记录 | §6 表 |

### 2. Placeholder scan

- 无 TBD / TODO / “类似上面” / 省略 schema。
- Step 1 与 Step 3 均为完整可复制文件内容。
- 命令与期望退出语义已写死。
- schema lookup **不**使用 `const schema=...; if (!schema)` 真值依赖；必须 `Object.hasOwn`。

### 3. Type / name consistency

- 13 type 字符串在 expected、source、MINIMAL_VALID_PAYLOADS 一致。
- `keyConfirmClient` / `keyConfirmServer` / `signature` / `trustEpoch` / `rekeyGeneration` 命名一致。
- fixedValues：`rekeyGeneration: 0`（number）、`reason: 'revoked'`（string）；`Object.is` 语义与测试一致。
- denylist identifier/generation 字段与 spec §4.6 L1 一致。
- messageType 闭集仅 own keys；`toString` / `constructor` / `__proto__` / `hasOwnProperty` 均拒绝。

### 4. Count audit (final)

```text
message types in expected pin:     13
message types in source freeze:    13
it() blocks in test file:          15
new implementation files:          2
package/dependency changes:        0
```

---

## Execution Handoff

Plan path: `docs/superpowers/plans/2026-07-17-linke-v2-m1-control-plane-message-schemas.md`（PM 以独立 docs commit 入库后进入实现）。

### 固定编排：pm-dcw h（本任务唯一路径）

本任务**不**提供通用 Subagent-Driven / Inline Execution 二选一。固定角色与顺序：

| 角色 | 担当 | 职责 |
| --- | --- | --- |
| adversary | GLM-5.2 | 已对 plan/设计抗辩（见 §6）；实现中若复开抗辩则只读指出缺陷 |
| implementer | Grok | 按 Task 1 **TDD RED→GREEN** 执行 Step 1–6：先建测试、确认 RED（MODULE_NOT_FOUND）、再建源码、targeted GREEN、全量 GREEN、scope 验证；**禁止** commit/push/unstage |
| reviewer | 全新 Grok 会话 | 只读复审实现 diff 与 plan 符合性；不改码、不 commit |
| verifier / Git owner | Codex PM | 新鲜验证 Step 4–6 证据；路径专属 `git add` 两新文件；`git commit --only src/cross-lan-protocol.js test/cross-lan-protocol.test.js -m "feat: define v2 control-plane message schemas"`；`git show --name-only` 校验 HEAD 恰好两路径；`git push`；立即进入下一任务。禁止 plain `git commit -m`（无 pathspec）。 |

**TDD 顺序（不可颠倒）：** Step 1 失败测试 → Step 2 RED（ERR_MODULE_NOT_FOUND）→ Step 3 最小实现 → Step 4 targeted GREEN → Step 5 full GREEN → Step 6 scope → Step 7 PM docs（若未入库）+ `commit --only` / push。

**禁止：** Grok 自行提交或推送；`git add .` / `-A`；`git restore --staged` 或任何取消用户 staging 的操作；无 pathspec 的 plain `git commit -m`；把 `package-lock.json` 或 plan 文档塞进 feat commit；要求 cached 恰好两行才允许继续；把本模块宣称为 Noise/E2EE/security validator 或 M1 ready。
