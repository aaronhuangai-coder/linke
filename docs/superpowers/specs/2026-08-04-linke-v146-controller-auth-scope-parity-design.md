# Linke V1.46 Controller Auth Scope Parity 设计

## 1. 目标

让真实 `npm start` 使用的 `src/controller-runtime.js` 与 `createServer()` 已有认证范围保持一致，补齐 controller 管理面丢失的三个配置：

- `previousReadToken` / `LINKE_PREVIOUS_READ_TOKEN`
- `previousWriteToken` / `LINKE_PREVIOUS_WRITE_TOKEN`
- `adminToken` / `LINKE_ADMIN_TOKEN`

本任务只修复入口透传，不新增认证规则。完成后 `security-auth` 仍为 `partial`，Gold 仍为 `6 ready / 3 partial / 0 blocked / 9 total`。

## 2. 当前缺口

基准提交 `dafc0ff` 的 `createServer()` 已支持 full、read、previous-read、write、previous-write、admin 六类令牌，也已实现管理路由的精确 admin gate。独立 `src/server.js` 入口会读取全部范围。

真实 controller 入口当前只接收并传递 full/read/write：

- `startController()` 没有 previous-read、previous-write、admin 参数；
- `managementServerFactory()` 收不到这三个参数；
- `parseControllerEnv()` 不读取对应环境变量。

因此直接启动 `src/server.js` 与 `npm start` 的管理面行为不一致。

## 3. 冻结方案

采用 GLM 推荐的 A1：沿用现有透传模式，以 `createServer()` 作为令牌规范化和 previous/current 配对校验的唯一事实源。

### 3.1 `startController()`

新增三个可选参数并原样传给 `managementServerFactory()`：

- `previousReadToken`
- `previousWriteToken`
- `adminToken`

管理面参数对象与 Agent listener 参数对象必须独立构造。Agent listener 参数对象不得拥有上述三个属性，也不得拥有 full/read/write 管理令牌属性。

### 3.2 `parseControllerEnv()`

新增一一映射：

| 环境变量 | 返回字段 |
| --- | --- |
| `LINKE_PREVIOUS_READ_TOKEN` | `previousReadToken` |
| `LINKE_PREVIOUS_WRITE_TOKEN` | `previousWriteToken` |
| `LINKE_ADMIN_TOKEN` | `adminToken` |

保留既有规则：`LINKE_AUTH_TOKEN` 优先于 `LINKE_TOKEN`。解析器不 trim、不输出、不记录令牌；空字符串原样返回，随后由 `createServer()` 按未配置处理。

### 3.3 校验与半启动清理

本任务不调用 `buildAuthStatusResponse()` 充当校验器，也不新增 `validateApiAuthConfiguration()`：

- 避免两套令牌规则漂移；
- 避免扩大 `src/server.js` 重构面；
- previous-only 配置仍由真实 management `createServer()` 拒绝。

若 management factory 因 previous-only 配置抛错，`startController()` 必须关闭已经启动的 Agent listener，释放监听端口，并传播不含令牌值的固定校验错误。该清理路径必须由真实行为测试证明。

## 4. 行为矩阵

### 4.1 真实 controller 管理 HTTP

通过 `startController()` 与默认 management factory 验证：

| admin 配置 | 凭证 | 精确 enrollment/revoke |
| --- | --- | --- |
| 有 | current write | `403` / `403` |
| 有 | previous write | `403` / `403` |
| 有 | admin | `201` / `200` |
| 无 | current write | `201` / `200` |
| 无 | previous write | `201` / `200` |

所有请求必须走 controller runtime 的真实管理 listener，不得直接调用 `createServer()` 冒充入口证明。

### 4.2 空值兼容

- `LINKE_ADMIN_TOKEN=''` 等价于未配置 admin；
- 空 previous token 等价于未配置 previous；
- 空值不得造成无可满足的 admin gate。

### 4.3 脱敏与隔离

- `runtime.status` 不得拥有任何 token 字段；
- controller 成功日志、启动失败日志、运行时错误日志不得包含 sentinel 令牌；
- 传播的校验错误不得包含令牌值；
- Agent listener options 不得拥有管理令牌属性；
- 不新增审计正文中的令牌字段。

## 5. 文件范围

允许修改生产/测试代码：

- `src/controller-runtime.js`
- `test/controller-runtime.test.js`

允许新增本规格及对应计划。若实现证明必须修改其它文件，立即 HOLD，由 Codex 重新裁决。

明确禁止：

- `src/server.js`
- `src/keychain-store.js`
- Agent listener 内部
- `src/gold-readiness.js`
- `README.md`
- `src/version.js`
- `package-lock.json`
- LaunchAgent、部署、真实 Keychain、生产凭证或系统配置

## 6. TDD 与验收

1. 在 `dafc0ff` 旧生产上加入最终测试，必须出现入口透传相关行为 RED，而不是 fixture/import/syntax RED。
2. 最小实现只增加参数、环境映射和 management factory 透传。
3. focused 测试至少覆盖：解析、透传、Agent options 隔离、status/log 脱敏、真实 HTTP 矩阵、previous-only 半启动清理和端口复用。
4. 运行 controller-runtime focused、认证相关回归、完整 `test/*.test.js`、`git diff --check`。
5. fresh reviewer 必须检查真实入口证据、options 对象隔离和清理顺序。
6. 不修改 Gold 状态；本任务仅关闭 controller 入口一致性缺口。

## 7. 回滚锚点

- Git 基准：`dafc0ff`
- 代码允许列表：`src/controller-runtime.js`、`test/controller-runtime.test.js`
- 回滚只撤销本任务提交；不得删除或覆盖用户未跟踪文件。
