# Linke V1.44 — 真实 NAS 验收证据集成设计

## 目标

将已经具备的真实 Synology SMB 复制与受控崩溃恢复能力，转化为可随版本审计、可由测试机读校验的 V1.44 验收证据，并据此关闭 Gold 计分板中的 `real-nas-remote-backup` 阻塞项。

本阶段完成后，计分板从 `4 ready / 4 partial / 1 blocked / 9 total` 变为 `5 ready / 4 partial / 0 blocked / 9 total`，总体状态为 `partial`。四个既有 `partial` 项保持不变，因此本阶段不宣称 Gold、GA 或完整版软件发布。

## 当前边界

- 现有真实 NAS 验收运行在 V1.43 代码上，已证明挂载识别、复制、完整性校验、崩溃后清理恢复及审计收敛有效。
- V1.43 的 `COMPLETED.json` 与运行上下文不能被重新标记为 V1.44 证据。
- Gold 计分板仍由源码静态定义，生成结果必须保持确定性；它不得在运行时读取本机临时目录、NAS 挂载或未提交证据。
- 当前证据不是签名、WORM 或外部证明。未来 G7 的签名 `gold-evidence-v1` 仍是独立能力，不由本设计替代。

## 非目标

- 不修改 NAS 复制、恢复、审计或挂载检测的数据路径。
- 不新增 HTTP API、Web Console schema、部署流程、自动挂载或生产任务。
- 不把任何真实 NAS 地址、共享名、用户名、路径、文件名、文件内容或凭证写入仓库。
- 不改变 `nas-dry-run`、`automation-installation`、`security-auth`、`production-hardening` 四个 `partial` 项。
- 不以测试通过、候选分支或单次硬件验收代表 Gold。

## 核心决策：候选版本与证据版本分离

采用两个严格分离的提交阶段，避免用旧版本证据证明新版本。

### C0：V1.44 候选提交

C0 只包含：

- 将公开版本升级为 V1.44；
- 新增纯函数真实 NAS 验收凭据校验器及其单元测试；
- 更新当前版本文档和版本边界测试；
- 保持 `real-nas-remote-backup` 为 `blocked`；
- 保持计分板 `4/4/1/9` 和 `--fail-on-blocked` 的失败退出行为。

C0 经聚焦测试和完整测试通过后形成精确 commit。只有该 commit 才能作为 V1.44 真实硬件验收的 `runtimeSourceCommit`。

### 真实硬件验收

在 C0 精确 commit 上，使用新的本地临时目录和新的 NAS 隔离根目录执行：

1. 验证挂载类型为 `smbfs` 且空间信息有效；
2. 创建一次性 V2 快照并执行真实复制；
3. 校验清单摘要、文件数量、文件字节数和逐文件 SHA-256；
4. 在 staging 已就绪但 publish 尚未发生时，对专用子进程发送 `SIGKILL`；
5. 验证 stale lock 身份与 staging 内容完整；
6. 使用正式 CLI `--execute --recover` 完成清理恢复；
7. 验证未错误发布 final、锁和 staging 零残留、首个已发布快照保持不变；
8. 验证审计状态为 `healthy / idle / equal`，且无需进一步恢复。

验收只能在用户已确认的非生产 Synology acceptance share 上执行。现有 V1.43 隔离根目录不得覆盖或复用。

### C1：证据集成提交

C1 只允许加入验收证据及其静态集成：

- 新增脱敏 Markdown 验收报告；
- 新增机器可校验 JSON 凭据；
- 让测试读取并校验该 JSON；
- 将 `real-nas-remote-backup` 改为 `ready`，并引用具体证据；
- 更新计分板、CLI、README 和相关测试至 `5/4/0/9`、总体 `partial`；
- 保持 NAS 复制、恢复和审计运行时代码与 C0 完全一致。

C1 的硬件证据指向 C0 commit。C0 到 C1 的差异必须仅限证据、计分板、测试和文档，不得包含 NAS 数据路径行为变化。

## 证据文件

机器凭据固定写入：

`docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json`

配套人工可读报告固定写入：

`docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md`

Markdown 报告只解释范围、阶段结果、清理结果、脱敏边界和非 Gold 结论；机器事实以 JSON 凭据为唯一可执行校验输入。

## JSON 凭据契约

顶层结构固定如下：

```json
{
  "schemaVersion": 1,
  "kind": "linke-real-nas-acceptance",
  "acceptanceId": "NAS-REAL-V144-20260727-01",
  "runtimeVersion": "V1.44",
  "runtimeSourceCommit": "<40 lowercase hex>",
  "acceptedAt": "<canonical UTC ISO timestamp>",
  "environment": "non-production",
  "provider": "synology",
  "mountType": "smbfs",
  "copy": {
    "state": "replicated",
    "fileCount": 2,
    "totalBytes": 9,
    "verifiedFileCount": 2,
    "manifestSha256": "<64 lowercase hex>",
    "completedMarkerValid": true,
    "lockResidualCount": 0,
    "stagingResidualCount": 0
  },
  "recovery": {
    "scenario": "staging-ready-process-termination",
    "terminationSignal": "SIGKILL",
    "staleLockValidated": true,
    "stagedFileCount": 2,
    "stagedVerifiedFileCount": 2,
    "state": "recovered",
    "finalPublished": false,
    "postFinalExists": false,
    "lockResidualCount": 0,
    "stagingResidualCount": 0,
    "residualFileCount": 0,
    "firstPublishedSnapshotPreserved": true
  },
  "audit": {
    "status": "healthy",
    "dualWriteState": "idle",
    "relationship": "equal",
    "recoveryRequired": false
  }
}
```

凭据使用封闭 schema：所有层级都拒绝额外字段，所有字段都校验精确类型和值域。

## 校验器设计

新增 `src/real-nas-acceptance-evidence.js`，导出单一公共校验入口。校验器是纯函数，不读取文件、不访问 Git、不连接网络或 NAS，也不依赖当前时间。

校验规则：

- `schemaVersion`、`kind`、`runtimeVersion`、环境、提供商和挂载类型必须为契约精确值；
- `runtimeSourceCommit` 必须是 40 位小写十六进制；
- `acceptedAt` 必须是规范 UTC ISO 时间戳；
- 数量和字节字段必须为非负 safe integer；复制文件数必须大于零；
- `copy.state` 必须为 `replicated`，且 `verifiedFileCount === fileCount`；
- `manifestSha256` 必须是 64 位小写十六进制；
- `completedMarkerValid` 必须为 `true`，复制阶段锁和 staging 残留必须为零；
- 恢复场景必须为 staging-ready 进程终止，信号必须为 `SIGKILL`；
- stale lock 必须已验证，staging 验证数必须等于 staging 文件数且大于零；
- 恢复状态必须为 `recovered`，不得发布 final，恢复后三类残留都必须为零；
- 首个已发布快照必须保持不变；
- 审计必须为 `healthy / idle / equal`，且 `recoveryRequired === false`。

所有 schema、类型、格式、状态或脱敏边界失败统一抛出固定域错误：

`real-nas-acceptance-evidence-invalid`

不得透传解析值、路径、系统错误、堆栈或原始输入。

## 脱敏硬边界

JSON 和 Markdown 均禁止包含：

- host、IP、URL、endpoint；
- 挂载路径、配置路径、dataDir 或任何绝对路径；
- NAS SMB 共享名、用户名；
- 文件名、文件内容；
- 密码、Token、凭证、ownerToken 或 Authorization 材料；
- PID、attemptId；
- 原始 stdout、stderr、系统错误或堆栈。

证据中唯一允许出现的 64 位十六进制值是 `copy.manifestSha256`。`runtimeSourceCommit` 只允许 40 位小写十六进制。测试必须递归检查键名和字符串值，防止禁止字段或敏感形态进入已提交证据。

## Gold 计分板集成

`src/gold-readiness.js` 继续是静态、确定性的唯一计分板来源。

C0 状态：

- `real-nas-remote-backup`: `blocked`
- summary: `ready=4, partial=4, blocked=1, total=9`
- overall: `blocked`
- `--fail-on-blocked`: 非零退出

C1 状态：

- `real-nas-remote-backup`: `ready`
- evidence 同时引用 Markdown 报告、JSON 凭据和相关测试；
- summary: `ready=5, partial=4, blocked=0, total=9`
- overall: `partial`
- `--fail-on-blocked`: 成功退出，因为只检查 blocked，而不是 Gold 完成度。

`real-nas-remote-backup` 的后续说明应改为持续维护受保护的真实 SMB 回归和版本对应凭据，不得写成 Gold 已完成。

## TDD 顺序

### C0 RED

先新增失败测试，证明：

- 校验器模块尚不存在；
- 正确凭据应通过；缺失字段、额外字段、错误类型或错误状态应失败；
- 敏感字段、绝对路径和多余 64 位摘要应失败；
- 当前版本和 README 尚不是 V1.44；
- 候选阶段仍保持真实 NAS blocked 和 `4/4/1/9`。

只运行新增及直接相关测试，确认失败原因与预期一致。

### C0 GREEN

以最小实现完成纯校验器、V1.44 版本更新和候选文档边界。依次运行：

1. 凭据校验器聚焦测试；
2. version、README、Gold readiness 和 agent CLI 相关测试；
3. 完整 `npm test`；
4. `git diff --check` 与工作树审查。

### C1 RED

在真实硬件验收完成后，先令测试要求：

- 固定路径 JSON 凭据存在并通过校验；
- `real-nas-remote-backup` 为 ready；
- 总体为 partial 且 summary 为 `5/4/0/9`；
- `--fail-on-blocked` 返回成功；
- README 明确仍有四个 partial，不能称为 Gold。

此时凭据尚未接入且计分板仍 blocked，测试必须按预期失败。

### C1 GREEN

写入从实际运行结果提取的脱敏凭据与报告，更新静态计分板和最小相关表面，再重复聚焦测试、完整测试、凭据独立校验、`git diff --check` 与差异审查。

## 预计文件范围

C0：

- `src/version.js`
- `src/real-nas-acceptance-evidence.js`（新增）
- `test/real-nas-acceptance-evidence.test.js`（新增）
- `test/version.test.js`
- `test/gold-readiness.test.js`
- `test/readme.test.js`
- `README.md`

C1：

- `docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json`（新增）
- `docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md`（新增）
- `src/gold-readiness.js`
- `test/real-nas-acceptance-evidence.test.js`
- `test/gold-readiness.test.js`
- `test/agent-gold-readiness.test.js`
- `test/version.test.js`、`test/readme.test.js`（仅在当前状态断言需要时修改）
- `README.md`

若 RED 证明某个文件无需变化，则不为匹配清单而强行修改。`package.json` 的历史包版本不在本阶段升级。API 和 Web Console 源码原则上不改；只有现有契约测试暴露真实不兼容时，才另行评审范围。

## 失败与 HOLD 条件

以下任一情况都保持 `real-nas-remote-backup=blocked`，不得生成通过凭据：

- C0 commit 与真实运行 commit 不一致；
- SMB 挂载类型或空间检查失败；
- 复制、清单、逐文件哈希或 `COMPLETED.json` 校验失败；
- 崩溃窗口未准确到达 staging-ready / pre-publish；
- stale lock 或 staging 身份无法验证；
- 恢复后出现 final、锁、staging 或其他残留；
- 首个已发布快照发生变化；
- 审计不是 `healthy / idle / equal`；
- 凭据含禁止字段、格式错误或与实测值不一致；
- 聚焦测试、完整测试或独立复审未通过。

LLM 空输出、超时、限流、服务错误、安全过滤或缺少验收产物同样视为 HOLD，不构成批准。

## 提交、推送与完成边界

- 设计文档、C0 和 C1 分别是独立提交候选；每次提交都需用户单独批准。
- 每次 push 与 commit 分开授权。
- 真实 NAS 验收属于受控非生产外部写入，只能写入用户确认的隔离 acceptance 根目录。
- C1 完成只关闭真实 NAS 阻塞，结果仍是 `partial`，不是 Gold。
- Gold 只有在剩余四个 partial 分别完成设计、实现、真实验证和独立闭环后才可能成立。

## 验收标准

本设计阶段的完成标准：

- 本文档准确记录用户确认的三段设计；
- 不包含真实环境敏感信息；
- 不修改实现代码、计分板或运行状态；
- 经差异自审后，等待用户批准设计文档提交。

后续 V1.44 证据集成阶段的完成标准：

- C0 精确 commit 上的真实硬件复制与恢复验收全部通过；
- JSON 凭据满足封闭 schema 与脱敏测试；
- C1 与 C0 间无 NAS 数据路径行为变化；
- `real-nas-remote-backup=ready`，总体 `partial`，summary 精确为 `5/4/0/9`；
- 聚焦测试、完整测试和独立闭环验收均通过；
- README 和报告明确不宣称 Gold。
