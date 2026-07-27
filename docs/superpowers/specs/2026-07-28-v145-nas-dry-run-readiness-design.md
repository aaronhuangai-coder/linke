# Linke V1.45 — NAS dry-run 配置就绪与执行授权分离设计

## 目标

让 `nas-dry-run` 的就绪结论与已经实现、已经完成 V1.44 真实 Synology SMB 验收的 mounted SMB adapter 对齐，同时保持 dry-run 的零连接、零挂载访问、零写入边界。

本阶段完成后，完整启用且配置合法的 `mountedShare` target 应得到配置就绪结论，`nas-dry-run --fail-on-blocked` 应退出 `0`；真实复制或恢复仍只能由 `nas-snapshot-replicate` 在 CLI `--execute` 与 `LINKE_NAS_SMB_EXECUTION=enabled` 双闸门同时满足后执行。

当本设计的实现、测试、真实 CLI 进程边界验证和独立闭环审查全部通过后，Gold 计分板中的 `nas-dry-run` 才能从 `partial` 升为 `ready`。计分板预计从 `5 ready / 4 partial / 0 blocked / 9 total` 变为 `6 ready / 3 partial / 0 blocked / 9 total`，总体状态仍为 `partial`，不宣称 Gold、GA 或完整版软件发布。

## pm-dcw 角色与阶段边界

- `hostController: Codex`
- `orchestrator: Codex`
- `pm: Codex@native`
- `adversary: GLM-5.2 via DashScope helper, fresh, read-only, reasoning_effort=xhigh`；设计抗辩已完成，初始结论为 `HOLD`，有效 finding 已纳入本文。
- `implementer: Grok native CLI, grok-4.5, reasoning_effort=high`；仅在计划获批后按 TDD 和精确文件白名单写代码。
- `statistics: Qwen CLI, effort=N/A:no-supported-control`；只统计测试、diff、Gold 状态和边界证据，不裁决发布事实。
- `reviewer: Kimi K3 via DashScope helper, fresh, read-only, reasoning_effort=max`。
- `closure_reviewer: Kimi K3 via DashScope helper, independent fresh worker, read-only, reasoning_effort=max`。
- `verifier: Codex host`；独立重建有效 RED、GREEN、完整回归、CLI 进程边界和最终事实裁决。

设计文档落盘不授予产品代码修改、commit、push、部署、真实 NAS 写入或 Gold 发布权限。commit 与 push 继续分别经过用户显式批准。

## 当前事实

### 现有 dry-run

`src/nas.js` 当前固定返回：

- `mode: "dry-run"`
- `wouldConnect: false`
- `wouldWrite: false`
- `executionGate.remoteExecutionAllowed: false`
- `executionGate.blockingReason: "real NAS transport not implemented"`

当前 target readiness 只检查 target 是否启用、是否配置 `credentialRef` 和全局 `remoteExecutionAllowed`。因此任何合法配置都会包含 `remote-execution-blocked`，`readinessSummary.state` 永远是 `blocked`。

### 已实现的真实 adapter

`src/smb-snapshot-replication.js` 已实现 mounted SMB 的计划、真实复制和恢复：

- plan 路径只读取本地 snapshot manifest，不访问 SMB；
- execute 必须同时满足 CLI `--execute` 与环境闸门 `LINKE_NAS_SMB_EXECUTION=enabled`；
- 执行前由 canonical `realpath`、`/bin/df -T smbfs` 和 statfs 检查真实 SMB；
- provider 仅支持 `synology` 与 `ugreen`；
- OS 挂载负责 SMB 认证，Linke 不读取 SMB 密码。

V1.44 已提交版本精确的真实 Synology SMB 复制、受控 `SIGKILL`、stale recovery 和审计收敛凭据，`real-nas-remote-backup` 已为 `ready`。这证明真实 adapter 边界已存在，但不单独证明新的 dry-run readiness 逻辑正确。

### 当前矛盾

`nas-dry-run` 仍声称“real NAS transport not implemented”，而真实 mounted SMB adapter 已经存在。直接把 `remoteExecutionAllowed` 改为 `true` 会错误地暗示 dry-run 授权执行；继续让所有配置 blocked 又会让有效 automation gate 永远退出 `2`。因此必须拆分配置就绪、adapter 可用和执行授权三种事实。

## 已选方案与已拒绝方案

### 采用：配置就绪与执行授权分离

`nas-dry-run` 只判断配置是否足以交给已实现的 mounted SMB adapter。它不检查真实挂载是否在线，也不授予真实执行权限。

采用理由：

- 与现有真实 adapter 对齐；
- 保留 dry-run 的纯计划、安全和确定性；
- 使 `--fail-on-blocked` 能作为配置自动化门，而不是永久失败门；
- 不削弱真实复制与恢复的双闸门和执行时 mount 检查。

### 拒绝：只改 Gold 计分板

保留 CLI 永远 blocked、只凭 V1.44 receipt 把 `nas-dry-run` 标记 ready，会形成“计分板 ready、命令永远 exit 2”的矛盾，因此拒绝。

### 拒绝：让 dry-run 读取真实 SMB mount

在 dry-run 中调用 stat、df、realpath 或 mount inspector 会把配置预检变成硬件相关检查，破坏零挂载访问与确定性，也与真实执行前检查重复，因此拒绝。

## 术语与不变量

- **configuration readiness**：合法配置是否完整描述一个 Linke 已支持的 mounted SMB target。
- **adapter availability**：代码中是否已有可执行的 mounted SMB adapter。
- **runtime verification**：真实执行前对 mount canonical path、文件系统类型和空间状态的检查。
- **execution authorization**：本次命令是否被允许产生真实复制或恢复副作用。

强制不变量：

1. `configuration ready` 不等于 `runtime verified`。
2. `configuration ready` 不等于 `execution authorized`。
3. `nas-dry-run` 永远不连接 endpoint、不访问 mountedShare 指向的文件系统路径、不运行 SMB inspector、不写文件到 NAS；读取并校验配置对象中的 mountedShare 字符串字段不属于挂载访问。
4. `nas-dry-run` 永远不能设置 `executionAuthorized:true`。
5. 真实复制或恢复只由 `nas-snapshot-replicate` 双闸门路径执行。
6. dry-run 输出不得包含 `mountedShare.mountPath`、`mountedShare.relativeRoot`、原始 `credentialRef`、环境变量值或命令绝对路径。

## 输出契约 V2

顶层 dry-run plan 新增 `schemaVersion: 2`。既有顶层 `mode`、`deviceId`、`wouldConnect`、`wouldWrite`、`executionGate`、`readinessSummary`、`targets` 和 `jobs` 保留。

### 顶层安全行为

```json
{
  "schemaVersion": 2,
  "mode": "dry-run",
  "wouldConnect": false,
  "wouldWrite": false
}
```

`wouldConnect` 与 `wouldWrite` 必须为字面量 `false`，不得根据配置、环境变量或调用参数改变。

### executionGate

`executionGate` 精确扩展为：

```json
{
  "schemaVersion": 2,
  "adapterAvailable": true,
  "executionAuthorized": false,
  "remoteExecutionAllowed": false,
  "blockingReason": "dry-run does not authorize execution",
  "requiredGates": [
    { "type": "cli-flag", "name": "--execute" },
    { "type": "env-var", "name": "LINKE_NAS_SMB_EXECUTION" }
  ]
}
```

语义：

- `adapterAvailable:true` 只说明 mounted SMB adapter 已实现；
- `executionAuthorized:false` 是当前唯一执行授权事实，dry-run 中恒为 `false`；
- `remoteExecutionAllowed:false` 为 V1 兼容字段，V1.45 保留，但不再参与 readiness 计算；
- `blockingReason` 为 V1 兼容展示字段，改为解释 dry-run 本身不授权执行，不再声称 transport 未实现；
- `requiredGates` 只暴露 bare flag/env 名称，不暴露环境变量值、命令路径或 target 参数。

V1.45 不删除兼容字段。未来若删除，必须在独立设计中升级 major schema 并提供迁移测试。

### target executionReadiness

为减少消费者破坏，既有 `executionReadiness` 字段名保留，但其内部显式限定为 configuration-only：

```json
{
  "schemaVersion": 2,
  "state": "ready",
  "basis": "configuration-only",
  "blockers": [],
  "runtimeVerificationPerformed": false,
  "runtimeVerificationRequired": true
}
```

对 blocked target，`runtimeVerificationPerformed` 仍为 `false`；只有配置已经 ready 时，`runtimeVerificationRequired` 才为 `true`。这表示真实 mount 检查被延迟到执行路径，而不是已经通过。

每个 target 继续只输出：

- provider、name、endpoint、shareName、remotePath；
- enabled；
- `credentialRefConfigured` 布尔；
- `mountedShareConfigured` 与 `mountedShareEnabled` 布尔；
- `executionReadiness`；
- 已有 sanitized app adapter plan。

不得新增 mountPath、relativeRoot 或 credentialRef 原文。

### readinessSummary

`readinessSummary` 保留既有字段，并扩展为：

```json
{
  "schemaVersion": 2,
  "mode": "dry-run",
  "scope": "configuration-only",
  "state": "ready",
  "totalTargets": 1,
  "enabledTargets": 1,
  "disabledTargets": 0,
  "mountedShareConfiguredTargets": 1,
  "mountedShareEnabledTargets": 1,
  "configurationReadyTargets": 1,
  "runtimeVerificationPendingTargets": 1,
  "blockedTargets": 0,
  "executionAuthorized": false,
  "remoteExecutionBlocked": true,
  "blockers": []
}
```

兼容规则：

- `credentialRefConfiguredTargets` 与 `enabledCredentialRefMissingTargets` 暂时保留为信息字段，不参与 state 计算；
- `remoteExecutionBlocked:true` 暂时保留，表示 dry-run 不授权执行，不再自动注入 `remote-execution-blocked` blocker；
- summary `state` 只聚合 configuration readiness；
- `totalTargets === 0` 时必须为 blocked，并包含 `no-targets-configured`。

## readiness 判定

配置先经过既有 `validateConfig` 与 `validateNasTarget`。非法 provider、非法 endpoint、非法或不安全 mountedShare 路径、credential-like 字段和其他 schema 错误继续抛配置错误；这些错误不转换成 readiness blocker。

对已经通过配置校验的 target，按以下顺序计算：

1. `enabled !== true`：`target-disabled`；
2. 缺少 `mountedShare`：`mounted-share-missing`；
3. `mountedShare.enabled !== true`：`mounted-share-disabled`；
4. 无 blocker：`state: "ready"`。

既有 `credential-ref-missing` 与 `remote-execution-blocked` 常量为源码兼容可暂时保留，但 V2 readiness 不再产出这两个 blocker。

mounted SMB 由 OS 挂载处理认证，所以已配置且启用的 mountedShare target 不要求 `credentialRef`。仅有 `credentialRef`、没有 `mountedShare` 的旧 target 明确得到 `mounted-share-missing`，不会静默 ready。

provider allowlist 继续由配置校验层固定为 `synology` 与 `ugreen`。不再新增不可到达的 `provider-unsupported` readiness blocker；非法 provider 属于 CLI exit `1` 的配置错误。

## 多 target 聚合

- 每个 target 独立产生 `executionReadiness`。
- 任一 target blocked，则 summary blocked。
- 全部 target ready 且 target 数量大于零，则 summary ready。
- 禁用 target 仍属于显式配置对象并阻塞 summary；本阶段不改变既有 fail-closed 行为。
- blockers 按稳定顺序去重：`no-targets-configured`、`target-disabled`、`mounted-share-missing`、`mounted-share-disabled`。

## CLI 行为与错误模型

`src/agent.js` 现有状态驱动逻辑原则上无需修改：它继续依据 `readinessSummary.state` 决定 `--fail-on-blocked` 的退出码。

- exit `0`：命令成功，并且未要求 fail gate，或 `--fail-on-blocked` 下 summary 为 ready；
- exit `1`：参数错误、配置读取错误或配置校验错误；
- exit `2`：命令成功产生 sanitized JSON，但 `--fail-on-blocked` 检测到 summary blocked。

`--readiness-summary` 继续只输出 summary。缺少 summary 时继续 fail-closed 为 exit `1`。正常无 flag 模式继续输出完整 dry-run plan。

任何错误输出都不得包含 credentialRef 原文、mountPath、relativeRoot、凭据、Token、原始配置或堆栈。

## Web Console

现有 NAS dry-run 面板继续使用同一 API，不新增 endpoint、按钮或写操作。

展示语义改为：

- “mounted SMB adapter：已实现”；
- “dry-run 执行授权：未授权”；
- “配置就绪状态：ready/blocked”；
- ready target 明确显示“运行时挂载检查：将在真实执行前完成”；
- 不再显示“真实 NAS transport 未实现”；
- 不显示 mountPath、relativeRoot、credentialRef 原文或环境变量值。

如果浏览器收到旧 schema，继续按旧字段保守展示，不得把缺少 `executionAuthorized` 当作已授权。

## Gold 证据与升级规则

`nas-dry-run` 从 partial 升 ready 必须同时具备两个不同证明域：

1. **dry-run 行为证据**：V2 schema、blocker、CLI 退出码、Web 展示、兼容和零副作用测试全部通过；
2. **adapter 边界证据**：V1.44 已提交的版本精确真实 NAS receipt 证明 mounted SMB adapter 确实完成真实复制与恢复。

真实 receipt 不能替代 dry-run 测试；dry-run 测试也不能替代真实 NAS receipt。只有二者共同成立，才能说明“计划语义与真实 adapter 对齐，且 dry-run 未冒充真实 NAS”。

升级后的 `nas-dry-run` evidence 应引用：

- `test/nas-dry-run.test.js`；
- `test/agent-nas-dry-run.test.js`；
- `test/web-console.test.js` 对应 DOM 契约；
- V1.44 real NAS acceptance JSON/Markdown 与验证测试；
- V2 schema、安全不变量和 CLI 真实进程边界结果。

升级后仍保留三个 partial：`automation-installation`、`security-auth`、`production-hardening`。Gold 总体必须保持 `partial`。

## TDD 验收矩阵

### 有效 RED

先只修改测试，冻结生产文件 hash。RED 必须因为缺少 V2 readiness 行为而失败，不接受语法、导入、fixture、路径或测试自身错误造成的假 RED。

最小测试矩阵：

1. 有效、启用的 mountedShare 且无 credentialRef：target/summary ready；
2. 有效 mountedShare 且有 credentialRef：仍 ready，且只输出 configured 布尔；
3. target disabled：`target-disabled`；
4. mountedShare 缺失且无 credentialRef：`mounted-share-missing`；
5. 仅 credentialRef 的 legacy target：`mounted-share-missing`；
6. mountedShare disabled：`mounted-share-disabled`；
7. 空 target 列表：`no-targets-configured`；
8. 多 target 混合：逐 target 状态正确、summary blocked、blocker 稳定去重；
9. 非法 provider：配置错误，不产生 readiness JSON；
10. 非法/不安全 mountPath 或 relativeRoot：配置错误；
11. ready 时 `executionAuthorized:false`、`remoteExecutionAllowed:false`、`wouldConnect:false`、`wouldWrite:false`；
12. requiredGates 只包含 bare flag/env 名称，不含值或绝对命令路径；
13. 不存在的 mountPath 仍可完成 configuration readiness，证明 dry-run 不以真实 mount 可达性为前置；
14. 输出不含 mountPath、relativeRoot、credentialRef 原文及 credential-like 字段；
15. `--fail-on-blocked` 对全 ready 配置输出 JSON 并 exit `0`；
16. `--readiness-summary --fail-on-blocked` 对全 ready 配置只输出 summary 并 exit `0`；
17. blocked 或 mixed 配置在 `--fail-on-blocked` 下 exit `2`；
18. 参数或配置错误 exit `1`；
19. Web Console 同时显示 configuration ready 与 execution unauthorized；
20. 旧字段存在且 Web 对旧 schema fail-closed；
21. Gold 计分板精确为 `6/3/0/9`、overall partial；
22. 版本、README 和既有 NAS app adapter 行为无回归。

### 零连接真实进程边界

Codex verifier 必须启动实际 `node src/agent.js nas-dry-run` 子进程，并使用：

- 临时合法配置文件；
- 不存在但语法合法的 mountPath；
- 本地 sentinel HTTP listener 作为 endpoint。

命令结束后必须证明：

- CLI exit code 与 readiness 状态一致；
- sentinel listener 接收连接数为零；
- mountPath 不需要存在也能产生 configuration-only ready；
- 没有 NAS、备份、恢复或远程写入产物。

该验证是真实 CLI 进程边界，不是外部 NAS 写入。V1.44 receipt 继续承担真实 NAS adapter 的硬件证明，本切片不重复真实 NAS 写入。

### GREEN 与回归

RED 有效后，Grok 才获得最小生产文件写权限。Codex 依次验证：

1. 新增/修改的聚焦测试；
2. NAS dry-run、Agent CLI、Web Console、Gold、version 与 README 相关测试；
3. 完整 `npm test`；
4. `git diff --check`；
5. Git 状态、允许文件与保护文件 hash；
6. 上述零连接真实 CLI 进程边界。

任何失败均保持 Gold `nas-dry-run=partial`。

## 运行韧性设计门

### 正常态定义

- 合法启用 mountedShare target：configuration readiness 为 ready；
- dry-run 永远报告 execution unauthorized、wouldConnect false、wouldWrite false；
- 真实 mount 检查明确 pending；
- CLI exit code 严格遵循 `0/1/2`；
- Web、CLI 和 Gold 静态文案使用相同语义；
- 不产生外部副作用或持久运行状态。

### 恢复锚点

设计前 last-green 为 `eea7c9d0b2a2aac2597e4a42fc0339e19c357b42`（V1.44 真实 NAS 证据提交）。本切片是无持久状态的 dry-run 语义升级；若 V1.45 回归，恢复目标是回到该 V1.44 行为与代码状态。任何 destructive Git 恢复仍需用户批准，本设计不自动执行 reset/restore。

### 有界失效

| failureMode | 预期行为 | 兜底机制 | 可观测信号 | 验证 |
|---|---|---|---|---|
| 非法配置 | fail-closed，不生成误导性 readiness | 既有 validateConfig/validateNasTarget | CLI exit 1 + 脱敏错误 | 负向配置测试 |
| 缺少/禁用 mountedShare | 产生稳定 blocker | V2 target readiness | summary blocked + exit 2 | blocker/CLI 测试 |
| ready 被误读为授权 | executionAuthorized 恒 false | 独立 executionGate 字段与 UI 文案 | JSON/DOM 明示 unauthorized | schema/Web 测试 |
| 运行时 mount 不可用 | dry-run 不声称成功；真实执行时 fail-closed | runtimeVerificationRequired + execute path mount inspector | dry-run pending；execute 返回受控错误 | dry-run 边界测试 + 既有 SMB 测试 |
| 旧消费者读取旧字段 | 保留旧字段但移出 readiness 计算 | schemaVersion 2 + compatibility aliases | 旧字段仍存在 | 兼容测试 |
| 输出泄漏路径/凭据 | 拒绝或只输出布尔状态 | 既有 credential denylist + sanitized projection | 递归输出扫描无敏感值 | redaction 测试 |

本命令无重试、队列、网络依赖或资源累积，不新增 timeout/backoff 机制。

### 异常恢复

`nas-dry-run` 是无状态、幂等、零写入命令。配置错误或 blocker 不产生待恢复数据，调用方修复配置后可直接重跑。真实复制/恢复的异常恢复继续由既有 SMB replication WAL/lock/staging 路径负责，本设计不改变该路径。

### 状态侦测与运行后自检

- JSON 的 schemaVersion、state、blockers、executionAuthorized 和 runtimeVerificationRequired 是机器信号；
- CLI exit `0/1/2` 是 automation 信号；
- Web Console 是人工可读信号；
- Gold scorecard 只在测试、真实 adapter 证据和版本边界同时满足后升级；
- release 后运行一次本地 sentinel CLI smoke，确认零连接和精确 exit code。

最高风险失败路径为“合法配置被标记 ready 后错误授予真实执行权限”。验收必须触发该组合并证明 `ready + executionAuthorized:false + wouldConnect:false + wouldWrite:false + sentinelConnections:0`，形成 fail-safe 闭环。

### 运行风险扫描

- 外部依赖退化：dry-run 不访问外部依赖；真实 mount 退化在 execute path fail-closed。
- 数据持久化/一致性：dry-run 无持久化，N/A。
- 队列积压/重试耗尽：无队列、无重试，N/A。
- 配置/凭证缺失：由 exit 1 或 V2 blocker 检测；mounted SMB 不要求 Linke credentialRef。
- 启动/关闭顺序：单次 CLI，无 daemon，N/A。
- 迁移/回滚：schemaVersion 2 + 兼容字段；回滚锚点为 V1.44 last-green。
- 资源耗尽：只处理有限配置对象；沿用既有 config/file size 边界，不新增资源占用。
- 告警阈值：CLI 状态码和 Gold scorecard 是本切片信号；生产监控仍属于 `production-hardening` partial。

## 预计文件范围

设计阶段：

- `docs/superpowers/specs/2026-07-28-v145-nas-dry-run-readiness-design.md`（新增）

实施阶段预计允许：

- `src/nas.js`
- `src/web/app.js`
- `src/gold-readiness.js`
- `src/version.js`
- `test/nas-dry-run.test.js`
- `test/agent-nas-dry-run.test.js`
- `test/web-console.test.js`
- `test/gold-readiness.test.js`
- `test/agent-gold-readiness.test.js`（仅状态断言需要时）
- `test/version.test.js`
- `test/readme.test.js`
- `README.md`

`src/agent.js` 与 server/API production code 原则上不改；现有 state-driven CLI 和透传 API 应自动接受新 plan。若有效 RED 证明必须修改，先暂停并更新设计范围。

明确禁止：

- `package-lock.json`：现有未跟踪用户文件，不读取、不 hash、不修改、不 stage；
- `.env`、secrets、credentials、SSH、云认证和任何 Token 文件；
- NAS 复制、恢复、mount inspector、审计数据路径；
- deployment、launchd、cron、邮件和真实生产环境；
- 新增 API、Web 写按钮或真实 NAS 执行入口。

若 RED 证明某个预计文件无需变化，不为匹配清单而强改；若需要新文件或越界文件，必须先回到设计变更控制。

## GLM 抗辩 finding 裁决

采纳：

- 精确定义 adapterAvailable、executionAuthorized 与 dry-run 行为；
- Gold 行为证据与真实 receipt 分属不同证明域；
- 保留旧字段并增加 schemaVersion；
- 明确 credentialRef-only legacy target；
- 明确 configuration-only 与 runtime verification pending；
- 补齐多 target、CLI exit code、redaction 和 Web 测试；
- requiredGates 只暴露 bare 名称。

修订后采纳：

- 旧 `remote-execution-blocked` 不继续作为 blocker；否则方案 A 无法 ready。改为保留旧字段、移出 state 计算。
- provider-unsupported 不作为 readiness blocker；既有配置校验会先以 exit 1 拒绝非法 provider。
- 不要求 macOS 上使用需要高权限的 syscall tracing；改用真实子进程、本地 sentinel listener、不存在 mountPath 和静态依赖边界共同验证零连接。
- `configValidated` 不用于把 blocked target 误标为非法配置；合法但被禁用的 target 仍是 valid config。改用 `basis` 与 runtime verification 字段表达语义。

## HOLD 条件

以下任一情况均停止升级并保持 `nas-dry-run=partial`：

- RED 不是因为缺少目标行为而失败；
- ready 状态下 executionAuthorized、wouldConnect 或 wouldWrite 不是 false；
- dry-run 访问 sentinel endpoint、要求 mountPath 存在或调用 SMB execute/recover；
- 缺失/禁用 mountedShare 被误判 ready；
- legacy credentialRef-only target 被误判 ready；
- CLI exit code 不符合 0/1/2 契约；
- 输出泄漏 mountPath、relativeRoot、credentialRef、环境变量值或凭据；
- Web 把 configuration ready 展示成执行已授权；
- Gold 被升级但测试或真实 V1.44 receipt 任一证明域缺失；
- 聚焦测试、完整测试、diff 检查、独立 reviewer、closure reviewer 或 Codex 验收未通过；
- Grok、Qwen、Kimi、GLM 发生越界、错误 schema、无结论、服务错误或安全过滤；
- 出现允许范围外 tracked diff，或 `package-lock.json` 被纳入变更。

LLM 的 timeout、PENDING、空输出或断连不是通过结论；按 pm-dcw 等待与恢复规则处理。

## 提交、推送与完成边界

- 本设计文档是独立提交候选，但 commit 必须再次由用户明确批准。
- 设计 commit 与 push 分开批准。
- 实施、版本/Gold 升级、commit 和 push 分属后续独立闸门。
- 本切片不需要真实 NAS 写入；如后续发现必须重跑硬件验收，必须重新确认非生产 share 和新隔离根目录。
- V1.45 只关闭 `nas-dry-run` partial，不代表 Gold。

## 设计阶段验收标准

- 本文准确记录用户批准的方案 A、GLM finding 裁决与安全边界；
- schema、readiness、CLI、Web、Gold、测试和韧性语义无矛盾；
- 不包含真实 NAS 地址、共享名、路径、凭据或 Token；
- 不修改产品源码、测试、计分板或运行状态；
- 自审无 placeholder、未决设计或越界范围；
- 等待用户复核书面 spec 后，才调用 writing-plans 生成实施计划。
