# Linke V1.46 管理鉴权 Keychain 来源设计

> 状态：DESIGN FROZEN。目标是为 `npm start` 的 controller management API 增加显式、可选、关闭式失败的 Keychain 令牌读取路径。该能力只是 `security-auth` 的 secret-management 子项，不把 `security-auth` 提升为 `ready`，不宣称 Gold/GA。

## 1. 背景与问题

controller management 已支持六类内存令牌：

- `authToken`（full）
- `readToken`
- `previousReadToken`
- `writeToken`
- `previousWriteToken`
- `adminToken`

`npm start` 当前仅从环境变量读取这些值。仓库已有成熟的 `KeychainStore`：生产实现固定使用 macOS `/usr/bin/security -i`，默认 service 是 `com.linke.gold`，调用方提供的 `itemId` 映射为 generic-password account。TLS identity 与设备凭据已复用这项基础设施，但 management 令牌尚无 Keychain 读取入口。

## 2. 本轮范围

### 2.1 包含

1. 为 `npm start` / `node src/controller-runtime.js` 增加显式 Keychain 来源选择。
2. 读取 six-scope management 令牌并透传给既有 management server。
3. 禁止 Keychain 与明文令牌环境变量混用或降级。
4. 对 selector、scope 清单、previous/current 配对和启动副作用顺序做 fail-closed 验证。
5. 使用 fake Keychain 完成自动测试和 README 配置说明。

### 2.2 不包含

- 不调用真实 `/usr/bin/security`，不读取、写入或删除真实 Keychain item。
- 不实现令牌 provisioning CLI、动态热重载、自动轮换、用户/会话系统或 OAuth。
- 不改变 `src/server.js` 的本机兼容入口。
- 不执行 deployment、LaunchAgent、真实网络或生产配置修改。
- 不提升 Gold readiness；`security-auth` 保持 `partial`。

## 3. 方案选择

采用方案 A：**显式 selector + 显式非秘密 scope 清单 + 固定 item ID**。

拒绝方案 B（盲读六项、missing 当未配置），因为它会把配置缺失误解释为未启用，且无法证明操作者期望的作用域集合。

拒绝方案 C（每个 scope 的 item ID 都由环境变量指定），因为可配置标识符扩大了拼写、越权和部署漂移面，本轮没有业务需要。

GLM-5.2 对抗审查推荐 A，并要求冻结 service/account 映射、selector 合法集合、依赖注入点和跨 item 启动快照语义；这些要求已纳入下文。

## 4. 外部配置合同

### 4.1 来源 selector

新增：

```text
LINKE_MANAGEMENT_AUTH_SOURCE=keychain
```

合法状态只有两种：

1. 变量**未定义**：沿用现有环境变量令牌路径，行为完全兼容。
2. 值精确等于小写 `keychain`：进入 Keychain 路径。

空串、空白、`environment`、大小写变体或其他值一律拒绝。不得对 selector 做 trim 或 lowercase 后宽松接受。

### 4.2 Keychain scope 清单

Keychain 模式必须同时定义：

```text
LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES=full,read,previous-read,write,previous-write,admin
```

解析规则：

- 以逗号分隔，并对每个元素 trim ASCII whitespace。
- scope 名必须精确为：`full`、`read`、`previous-read`、`write`、`previous-write`、`admin`。
- 空清单、空元素、未知值、大小写变体和 trim 后重复值均拒绝。
- 至少包含一个 current scope：`full`、`read`、`write` 或 `admin`。
- `previous-read` 需要同一清单包含 `read`。
- `previous-write` 需要同一清单包含 `write`。
- 保留调用者声明顺序用于读取；不得自动排序、补 scope 或忽略错误。

scope 清单不包含秘密，可以进入配置文档；令牌值不得进入文档、日志或状态。

### 4.3 禁止混用

Keychain 模式下，以下任一变量只要在 env 对象中**已定义**（包括空串）就必须在任何 Keychain、文件系统、TLS 或 listener 副作用前拒绝：

```text
LINKE_AUTH_TOKEN
LINKE_TOKEN
LINKE_READ_TOKEN
LINKE_PREVIOUS_READ_TOKEN
LINKE_WRITE_TOKEN
LINKE_PREVIOUS_WRITE_TOKEN
LINKE_ADMIN_TOKEN
```

非 Keychain 模式下若定义 `LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES`，同样拒绝。不存在明文 fallback，也不允许 Keychain missing 后回退到 env。

## 5. Keychain 映射

复用 `startController({ keychain })` 的现有依赖注入点；未注入时继续构造一个生产 `KeychainStore()`。不得新增第二个 production store。

生产映射固定为：

| scope | Keychain service | generic-password account / itemId | startController 字段 |
| --- | --- | --- | --- |
| `full` | `com.linke.gold` | `management-auth.full` | `authToken` |
| `read` | `com.linke.gold` | `management-auth.read` | `readToken` |
| `previous-read` | `com.linke.gold` | `management-auth.read.previous` | `previousReadToken` |
| `write` | `com.linke.gold` | `management-auth.write` | `writeToken` |
| `previous-write` | `com.linke.gold` | `management-auth.write.previous` | `previousWriteToken` |
| `admin` | `com.linke.gold` | `management-auth.admin` | `adminToken` |

固定 item ID 都满足既有安全正则，不包含 host、用户、URL 或令牌材料。

## 6. 模块与调用合同

新增独立模块 `src/management-auth-keychain.js`，负责：

1. 导出固定 scope/item 映射。
2. 纯解析和验证 env 来源配置。
3. 纯验证 library options 的互斥和配对关系。
4. 从注入的 `{ get(itemId) }` 读取声明项并返回六字段对象。

`parseControllerEnv()`：

- legacy env 模式仍返回既有六字段，保持 `LINKE_AUTH_TOKEN || LINKE_TOKEN` precedence。
- Keychain 模式返回经过验证的 `managementAuthKeychainScopes`，六个直接令牌字段保持 `undefined`。

`startController()` 新增可选 `managementAuthKeychainScopes`：

- scopes 与任何非 `undefined` 的直接令牌参数互斥；空串也算直接参数。
- 所有 scope 结构验证必须发生在构造生产 KeychainStore 之前。
- 纯 dataDir/host/port/limiter/max-transfer 校验完成后，构造或复用 `resolvedKeychain`。
- 在 `ensureSafeDataRoot()`、TLS identity、registry、factory 和 listener 之前读取 management items。
- 按 scope 清单声明顺序依次读取；任一 missing、unavailable、空值或接口错误使启动整体失败，不读取 env fallback。
- 全部读取成功后，resolved token fields 才传给 management factory。

Agent factory options、runtime status、日志、错误响应、JSON 输出都不得拥有或包含 management token 字段和值。

## 7. 启动快照与轮换语义

本轮是**启动时内存快照**，不是动态热重载：

- `KeychainStore.get()` 只保证单 item 读取；多个 item 之间不是原子事务。
- previous/current 的“匹配”只指 scope presence 配对，不验证两者值之间的派生关系。
- 操作者必须在 controller 启动读取窗口内停止修改这些 item；轮换由外部受控流程完成 Keychain 单 item 原子更新后，再受控重启 controller。
- 运行中更新 Keychain 不改变已启动进程的内存令牌。
- 在线无中断轮换、批量事务和自动 provisioning 属后续独立设计。

跨 scope 使用相同令牌值时，继续继承既有“最宽 scope 胜出”语义；本轮不改变兼容行为，也不把 secret 比较结果写入日志。

## 8. 失败与脱敏

- `keychain-item-missing`、`keychain-unavailable`、锁定、权限拒绝和空 secret 均 fail closed；不得启动任何 listener。
- `runControllerMain()` 只打印既有固定文本 `Linke controller failed to start` 并返回失败退出码，不打印 scope、itemId、raw Error 或 secret。
- loader 不拼接 secret、stdout 或底层错误消息。
- direct library caller 可接收既有稳定 LinkeError code；不新增包含敏感上下文的错误码。
- macOS Keychain UI prompt/锁定等待上界是现有 `KeychainStore` 的后续 P2；本轮不改 runner，但在未完成读取前不会启动服务，因此仍是 fail closed。

## 9. TDD 验收矩阵

必须覆盖：

1. legacy env 未设置 selector 时逐字段兼容，包括 full precedence 和空串语义。
2. selector 未定义/精确 keychain/非法空白、大小写和 `environment`。
3. scopes 缺失、空、空元素、未知、重复、previous-only、合法顺序。
4. Keychain 模式与七个 legacy/current token env 分别混用，均在 `get()` 之前拒绝。
5. 固定 itemId、声明顺序、返回字段映射、未声明 item 零读取。
6. missing、unavailable、empty 与 fake raw error 都不产生 listener/文件系统/TLS/factory 副作用。
7. `startController` 使用同一注入 keychain 完成 management 读取与 TLS identity；不构造第二个 production store。
8. 真实 loopback management HTTP：Keychain 读取的 read/write/admin/previous token 保持现有 scope 行为。
9. management tokens 不进入 Agent options、runtime status、成功/启动失败/运行时失败日志。
10. README 说明 selector、scope/item 映射、无 fallback、启动快照、fake-test 与 Gold partial 边界。
11. old-HEAD RED 必须是行为缺口，不得由 import、fixture 或路径错误制造。
12. focused tests、controller runtime regression、full `npm test`、diff/whitespace 检查全绿。

## 10. Gold 边界

本任务完成后只能声称：controller management 有一个显式 Keychain-backed startup read path，且自动测试证明 fail-closed 配置和透传边界。

仍然缺失：安全 provisioning/rotation 操作面、动态/受控轮换闭环、完整三角色入口矩阵、生产安全审查及其它 Gold partial 项。因此：

- `security-auth` 仍为 `partial`。
- Gold 仍为 `6 ready / 3 partial / 0 blocked / 9 total`。
- 不新增 Gold/GA/production-ready 声明。
