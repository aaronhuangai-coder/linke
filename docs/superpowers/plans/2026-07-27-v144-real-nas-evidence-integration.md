# Linke V1.44 Real NAS Evidence Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在精确 V1.44 候选 commit 上完成真实 Synology SMB 复制与受控崩溃恢复验收，将脱敏机器凭据接入静态 Gold 计分板，使 `real-nas-remote-backup` 变为 ready，同时总体严格保持 partial。

**Architecture:** 先交付不改变 NAS 数据路径的 C0：V1.44 版本、纯函数封闭 schema 校验器和候选边界；再由 Codex 在非生产隔离 SMB 根目录执行真实复制与 `SIGKILL` 恢复。最后 C1 只加入 JSON/Markdown 证据、静态计分板和当前版本文档，C0→C1 禁止改变 NAS 运行时代码。

**Tech Stack:** Node.js 24 ESM、内置 `node:test` / `node:assert` / `node:fs/promises`、现有 `nas-snapshot-replicate` CLI、真实 macOS `smbfs`、零新增 npm 依赖。

## Global Constraints

- 权威设计：`docs/superpowers/specs/2026-07-27-v144-real-nas-evidence-integration-design.md`。
- 基线设计提交：`f09b813`；开始实现前重新记录 `git rev-parse HEAD` 与 upstream。
- 既存未跟踪 `package-lock.json` 绝对禁止读取、修改、暂存或提交。
- 禁止读取 `.env`、凭证、Token、`~/.ssh`、`~/.grok` 或认证目录；禁止输出环境变量值。
- C0 与 C1 都不修改 NAS 复制、恢复、审计、挂载检测的数据路径。
- C0 必须保持 `real-nas-remote-backup=blocked`、overall `blocked`、`4/4/1/9`、`--fail-on-blocked` 退出 2。
- C1 才允许 `real-nas-remote-backup=ready`、overall `partial`、`5/4/0/9`、`--fail-on-blocked` 退出 0。
- 四个既有 partial：`nas-dry-run`、`automation-installation`、`security-auth`、`production-hardening` 不得升级。
- JSON/Markdown 不含 host、IP、URL、endpoint、真实路径、共享名、用户名、文件名/内容、凭证、Token、PID、attemptId、原始 stdout/stderr、系统错误或堆栈。
- 唯一允许的 64 位小写十六进制值是 `copy.manifestSha256`；`runtimeSourceCommit` 必须是 40 位小写十六进制。
- 真实运行只能写用户确认的非生产 Synology acceptance share 中的新隔离根；不得覆盖或复用 V1.43 根。
- commit 与 push 分别需要用户明确授权；所有计划中的 commit 步骤都先 STOP 请求授权。
- 空输出、超时、429、连接错误、缺少产物、安全过滤或 worker schema 缺失均为 HOLD，不是批准。
- Gold 含义保持“完整版软件发布”；C1 结果仍为 partial，不得称 Gold/GA。
- receipt 是对 Codex 已完成实调的机器可校验、自陈式记录，不是事件本身的密码学证明；scorecard、README 和报告必须继续明示 unsigned / not WORM / no external authenticity。

## PM-DCW Role Map

| 角色 | Worker / 通道 | Effort | 边界 |
| --- | --- | --- | --- |
| hostController / orchestrator / verifier | Codex | 当前原生模型 | 亲自 grounding、RED/GREEN、全量回归、真实 SMB 验收与事实裁决 |
| adversary | GLM-5.2 DashScope helper | `reasoning_effort=xhigh` | fresh、只读；审设计/计划/恢复动作，不得声称本地写入 |
| implementer | Grok 原生 CLI `grok-4.5` | `--reasoning-effort high` | fresh 首轮；`dontAsk` + 精确 `Edit(...)` allow + Bash/Web/MCP deny |
| statistics | Qwen CLI | `effort=N/A:no-supported-control` | fresh、只读；统计 diff、测试与边界，不修改文件 |
| closure_reviewer | Kimi K3 DashScope helper | `reasoning_effort=max` | fresh、只读闭环；必须按固定 closure schema 输出 |

当前可用性探测（2026-07-27）：Grok、GLM-5.2 helper、Qwen、Kimi K3 helper 的 live smoke 均退出 0 并包含 `OK`。实际任务调用仍按 pm-dcw 等待预算执行；探测成功不代替任务验收。

## File Map

### C0 candidate

- Create: `src/real-nas-acceptance-evidence.js` — 纯函数封闭 schema 与脱敏校验。
- Create: `test/real-nas-acceptance-evidence.test.js` — 正反例、固定错误、敏感形态测试。
- Modify: `src/version.js` — 只把常量改为 `V1.44`。
- Modify: `test/version.test.js` — V1.44 candidate 当前签名、V1.43 历史基线与诚实边界。
- Modify: `test/readme.test.js` — 仅更新当前版本/候选边界断言。
- Modify: `README.md` — C0 candidate 当前行；Gold 仍 blocked `4/4/1/9`。
- Verify only unless RED proves required: `test/gold-readiness.test.js`、`test/agent-gold-readiness.test.js`。

### C1 evidence integration

- Create: `docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json`。
- Create: `docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md`。
- Modify: `src/gold-readiness.js` — 只改变真实 NAS 条目及其 evidence/nextStep。
- Modify: `test/real-nas-acceptance-evidence.test.js` — 读取已提交 JSON/Markdown。
- Modify: `test/gold-readiness.test.js` — `5/4/0/9`、overall partial、真实 NAS ready。
- Modify: `test/agent-gold-readiness.test.js` — 当前真实报告与 `--fail-on-blocked` 成功。
- Modify: `test/version.test.js`、`test/readme.test.js`、`README.md` — V1.44 final evidence signature 与非 Gold 边界。
- Do not modify: `src/agent.js`、`src/server.js`、`src/web/**`、`src/smb-snapshot-replication.js`、`src/audit-integrity-*.js`。

## Interfaces

```js
export const REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID =
  'real-nas-acceptance-evidence-invalid';

/**
 * Validate one JSON-parsed V1.44 real-NAS acceptance receipt.
 * Returns true; every invalid input throws only the fixed public code.
 * @param {unknown} input
 * @returns {true}
 */
export function validateRealNasAcceptanceEvidence(input) {}
```

失败对象必须满足：

```js
error.name === 'RealNasAcceptanceEvidenceError'
error.code === 'real-nas-acceptance-evidence-invalid'
error.message === 'real-nas-acceptance-evidence-invalid'
```

校验器不加入 `ERROR_CODES`：它不是 HTTP/Agent 公共错误协议，不引起现有 94-code registry 扩张或全仓 count-pin 改动。

## Runtime Resilience Gate

| 支柱 | 计划状态 | 触发/信号/恢复锚点 |
| --- | --- | --- |
| 有界失效 | Task 1、4、5 | schema/脱敏失败固定 error；SMB/复制/哈希/恢复/审计任一失败即 HOLD，不产出通过凭据 |
| 异常恢复 | Task 4 | staging-ready 后 `SIGKILL`；stale lock + staging 是恢复输入；C0 commit 和首个已发布快照是不变量锚点 |
| 状态侦测与运行后自检 | Task 4、6 | CLI state、COMPLETED、逐文件 SHA、残留计数、audit `healthy/idle/equal`、完整测试 |

正常态定义：C0 时所有测试绿且 Gold 仍 blocked；C1 时凭据严格有效、真实 NAS ready、overall partial、四个 partial 不变、NAS 数据路径与 C0 相同。最高风险演练固定为 `staging-ready-process-termination`，必须形成“触发 SIGKILL → stale lock/staging 可观测 → `--recover` → 无 final/零残留/首快照保持/审计健康”的闭环。

## GLM Plan Adversary Findings Adjudication

2026-07-27 fresh GLM-5.2 抗辩结果：`DONE_WITH_CONCERNS`，P0=0、P1=5、P2=3。PM 裁决：

| Finding | 裁决 | 计划动作 |
| --- | --- | --- |
| P1-1 receipt 不能密码学绑定 C0 SHA | `ACCEPTED_AS_KNOWN_LIMITATION` | receipt 明示 self-attested / unsigned / not WORM / no external authenticity；Codex 以 Task 4 原始证据核对，不把 validator PASS 当真实性证明 |
| P1-2 C0→C1 diff allowlist 覆盖不足 | `ACCEPTED` | Task 4 冻结 validator hash；Task 6 检查除 `src/gold-readiness.js` 外全部 `src` 与 `package.json` 零差异 |
| P1-3 committed receipt 不携带 attemptId | `ACCEPTED_AS_PRIVACY_TRADEOFF` | attemptId 只在 temp raw evidence 内进行恢复前后等值比较；仓库仅记录抽象验证结论与证据局限，不加入可关联的真实 attemptId/hash |
| P1-4 detached worktree 可能缺 lockfile | `REJECTED` | 项目 `package.json` 无 dependencies/devDependencies，测试只用 Node 内置模块；RED worktree 禁止 `npm install`/`npm ci`，直接运行 `node --test` |
| P1-5 marker 与 receipt 是程序性交叉检查 | `ACCEPTED_AS_KNOWN_LIMITATION` | Codex 明确核对 marker version、manifest digest/file counts 与 C0 runtime；`completedMarkerValid=true` 的含义锁定为这些检查全部通过，不声称密码学证明 |
| P2-1 canonical UTC 粒度不清 | `ALREADY_COVERED` | 实现必须满足 `new Date(Date.parse(value)).toISOString() === value`，因此固定毫秒与 `Z` |
| P2-2 非 sourceCommit 的 40-hex | `ACCEPTED` | closed schema 外加递归检查：40-hex 只允许 `runtimeSourceCommit` 路径 |
| P2-3 fail-on-blocked 易被误解 | `ACCEPTED` | README/report/scorecard nextStep 明示 overall partial、four partial remain、unsigned evidence、not Gold |

第二次 fresh GLM-5.2 复审：`DONE_WITH_CONCERNS`，P0=0、P1=0、P2=4，可放行进入人工计划审批。追加裁决：

- `ACCEPTED`：C1 最终使用全文件精确 allowlist，任何根级脚本、`.npmrc`、hook、bin 或未列文件变化都 HOLD。
- `ACCEPTED`：README 当前 surface 与 scorecard tests 使用精确短语/精确状态值，不接受仅语义相近的 Gold 边界。
- `REJECTED_YAGNI`：不为本阶段新增 `goldReady` 或 `scorecard.goldStatus` API 字段；现有 exact `status='partial'`、summary `5/4/0/9` 和四个 partial item 是结构化事实，新增 schema 会扩大无关 API。
- `ACCEPTED_AS_KNOWN_LIMITATION`：attempt identity 只在 temp raw evidence 内核对，外部不可独立复核；对 unsigned、non-Gold partial evidence 明示此限制。

---

### Task 1: C0 纯函数凭据校验器

**Files:**
- Create: `test/real-nas-acceptance-evidence.test.js`
- Create: `src/real-nas-acceptance-evidence.js`

**Interfaces:**
- Consumes: JSON-compatible unknown input；不读文件、不读 Git、不读环境、不访问网络/NAS。
- Produces: `validateRealNasAcceptanceEvidence(input) -> true` 和固定错误常量。

- [ ] **Step 1: 冻结实现前文件哈希与允许范围**

Run:

```bash
git status --short --branch
git hash-object src/version.js src/gold-readiness.js README.md
```

Expected: 除计划文档和既存 `?? package-lock.json` 外无未知改动；记录三个 hash。禁止 hash/read `package-lock.json`。

- [ ] **Step 2: 用 Grok 仅写失败测试**

Grok 首轮只允许：

```text
Edit(test/real-nas-acceptance-evidence.test.js)
```

测试文件定义真实的正例 fixture：

```js
function validEvidence() {
  return {
    schemaVersion: 1,
    kind: 'linke-real-nas-acceptance',
    acceptanceId: 'NAS-REAL-V144-20260727-01',
    runtimeVersion: 'V1.44',
    runtimeSourceCommit: 'a'.repeat(40),
    acceptedAt: '2026-07-27T04:00:00.000Z',
    environment: 'non-production',
    provider: 'synology',
    mountType: 'smbfs',
    copy: {
      state: 'replicated', fileCount: 2, totalBytes: 9,
      verifiedFileCount: 2, manifestSha256: 'b'.repeat(64),
      completedMarkerValid: true, lockResidualCount: 0,
      stagingResidualCount: 0,
    },
    recovery: {
      scenario: 'staging-ready-process-termination',
      terminationSignal: 'SIGKILL', staleLockValidated: true,
      stagedFileCount: 2, stagedVerifiedFileCount: 2,
      state: 'recovered', finalPublished: false,
      postFinalExists: false, lockResidualCount: 0,
      stagingResidualCount: 0, residualFileCount: 0,
      firstPublishedSnapshotPreserved: true,
    },
    audit: {
      status: 'healthy', dualWriteState: 'idle',
      relationship: 'equal', recoveryRequired: false,
    },
  };
}
```

至少覆盖这些 table-driven mutation：顶层/嵌套缺键、额外键、数组/null/non-object、getter、错误版本/commit/ISO/SHA、负数/小数/unsafe integer、零文件、验证数不等、非 replicated、marker false、任一残留非零、错误恢复场景/信号、staleLock false、staged 数不等/为零、final true、首快照未保持、非 `healthy/idle/equal`、recoveryRequired true、额外 64-hex、绝对路径、URL、IP、credential/token/ownerToken/PID/attemptId/stdout/stderr 字段。每个失败均断言固定 name/code/message 且不回显恶意值。

- [ ] **Step 3: Codex 独立观察有效 RED**

Run:

```bash
node --test test/real-nas-acceptance-evidence.test.js
```

Expected: FAIL，唯一有效原因是 `src/real-nas-acceptance-evidence.js` 尚不存在；语法、fixture 或测试导入错误不算有效 RED。

- [ ] **Step 4: 扩大 Grok 白名单并写最小实现**

允许文件：

```text
Edit(test/real-nas-acceptance-evidence.test.js)
Edit(src/real-nas-acceptance-evidence.js)
```

实现必须使用封闭 key 集、`Object.getOwnPropertyDescriptors` 拒绝 accessor、`Number.isSafeInteger`、`Date.parse` + `new Date(ms).toISOString() === value`、40/64 lower-hex regex。所有内部断言只调用：

```js
function invalidEvidence() {
  const error = new Error(REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID);
  error.name = 'RealNasAcceptanceEvidenceError';
  error.code = REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID;
  return error;
}
```

任何 catch 都不得拼接 input、key、value 或底层 message。

- [ ] **Step 5: Codex 独立 GREEN 与越界核验**

Run:

```bash
node --test test/real-nas-acceptance-evidence.test.js
git diff --check
git status --short
```

Expected: PASS；只出现两个 Task 1 文件和计划文档；`package-lock.json` 仍 `??`。

### Task 2: C0 V1.44 候选版本与诚实边界

**Files:**
- Modify: `src/version.js`
- Modify: `test/version.test.js`
- Modify: `test/readme.test.js`
- Modify: `README.md`
- Verify: `test/gold-readiness.test.js`
- Verify: `test/agent-gold-readiness.test.js`

**Interfaces:**
- Consumes: Task 1 校验器。
- Produces: 精确 `LINKE_RELEASE_VERSION === 'V1.44'`；候选签名 `V1.44 real NAS evidence-validation candidate`。

- [ ] **Step 1: 先更新测试形成 RED**

在 `test/version.test.js` 增加/替换：

```js
const V144_CANDIDATE_SIGNATURE =
  'V1.44 real NAS evidence-validation candidate';
const V143_SIGNATURE =
  'V1.43 explicit crash-recoverable audit integrity rotation foundation';
```

当前 surface 必须包含 V1.44 candidate signature、`exact V1.44 hardware evidence pending`、`real-nas-remote-backup remains blocked`、`not Gold`、`Gold remains blocked 4/4/1/9`；V1.43 行必须变为历史版本并保留 V1.43 signature。`test/readme.test.js` 只更新当前版本/候选事实，不删历史断言。

- [ ] **Step 2: Codex 观察版本 RED**

Run:

```bash
node --test test/version.test.js test/readme.test.js
```

Expected: FAIL，因为源码和 README 仍为 V1.43。

- [ ] **Step 3: Grok 最小更新版本和 README**

精确改动：

```js
export const LINKE_RELEASE_VERSION = 'V1.44';
```

README 必须：标题/徽章/current row 改 V1.44；新增 candidate signature；把 V1.43 current row 降为历史；保留 V1.43 及更早历史事实；候选阶段仍明确未运行 exact V1.44 hardware evidence，不增加真实 NAS PASS 报告引用。

- [ ] **Step 4: 聚焦 GREEN 与 C0 scorecard 不变量**

Run:

```bash
node --test test/real-nas-acceptance-evidence.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js test/agent-gold-readiness.test.js
```

Expected: 全 PASS；真实报告仍 `blocked`、summary 精确 `{ ready: 4, partial: 4, blocked: 1, total: 9 }`、`--fail-on-blocked` 测试仍退出 2。

- [ ] **Step 5: 完整 C0 GREEN**

Run:

```bash
npm test
git diff --check
git status --short
```

Expected: 完整 suite PASS；无白名单外改动；`package-lock.json` 未触碰。

### Task 3: C0 对抗、独立 RED 重建与候选提交门

**Files:**
- Review only: C0 全部 diff。
- Temporary only: `/private/tmp` 中的 prompt、补丁和 detached verification worktree。

**Interfaces:**
- Consumes: Task 1–2 工作树 diff。
- Produces: 精确可验收 C0 commit；不 push。

- [ ] **Step 1: GLM fresh adversarial review**

证据包必须含 design、plan 中 C0 条款、完整 C0 diff、聚焦/完整测试输出、工作树状态、禁止 Gold 升级边界。GLM 输出 P0/P1/P2、证据、建议；空输出或缺 schema 为 HOLD。

- [ ] **Step 2: Codex 裁决 findings**

逐项记录 `ACCEPTED / REJECTED + 本地证据`。实现缺陷只打回同一 Grok implementer session，prompt 包含完整 findings；`max_attempts=3`。方案缺陷回到设计/计划并请求用户审查，不直接改口径。

- [ ] **Step 3: Codex 在 detached worktree 重建 RED/GREEN**

Run outline:

```bash
git diff -- test/real-nas-acceptance-evidence.test.js test/version.test.js test/readme.test.js > /private/tmp/linke-v144-c0-tests.patch
git diff -- src/real-nas-acceptance-evidence.js src/version.js README.md > /private/tmp/linke-v144-c0-impl.patch
git worktree add --detach /private/tmp/linke-v144-c0-red HEAD
```

对两个新增文件分别运行：

```bash
git diff --no-index /dev/null test/real-nas-acceptance-evidence.test.js > /private/tmp/linke-v144-c0-new-test.patch
git diff --no-index /dev/null src/real-nas-acceptance-evidence.js > /private/tmp/linke-v144-c0-new-impl.patch
```

在 detached worktree 只应用测试补丁并运行聚焦测试：必须因缺目标行为失败；再应用实现补丁，聚焦和完整测试必须通过。不得通过删除/放宽失败测试制造绿色。

RED/GREEN worktree 都禁止运行 `npm install` 或 `npm ci`。先确认 `package.json` 不含 `dependencies` / `devDependencies`，再直接用 `node --test`；任何第三方模块解析错误都判无效 RED。

- [ ] **Step 4: 检查 C0 可部署差异**

Run:

```bash
git diff --name-only HEAD
git diff -- src/smb-snapshot-replication.js src/agent.js src/server.js src/web
```

Expected: 第二条为空；C0 未改变 NAS 数据路径、API 或 Web。

- [ ] **Step 5: STOP，请求 C0 commit 授权**

建议 message：

```text
feat: prepare V1.44 real NAS evidence candidate
```

批准后仅精确 stage C0 文件；commit 后重新跑 `git show --stat`、`git status --short --branch`。push 另行请求，不得包含在 commit 授权内。

### Task 4: 精确 C0 commit 的真实 SMB 复制与崩溃恢复

**Files:**
- Repository: 不修改。
- Temporary: 新 `/private/tmp/linke-v144-nas-acceptance.XXXXXX` fixture/config/raw evidence。
- External: 已确认非生产 SMB share 中两个新的隔离根。

**Interfaces:**
- Consumes: 已提交 C0 `git rev-parse HEAD`、用户确认的 mounted acceptance share。
- Produces: 本地 raw evidence 与可脱敏字段；不得直接写仓库报告。

- [ ] **Step 1: 冻结候选身份与 mount gate**

Run:

```bash
git status --short --branch
C0_COMMIT="$(git rev-parse HEAD)"
export C0_COMMIT
C0_VALIDATOR_HASH="$(git hash-object src/real-nas-acceptance-evidence.js)"
export C0_VALIDATOR_HASH
node -e "import('./src/version.js').then(m=>{if(m.LINKE_RELEASE_VERSION!=='V1.44')process.exit(1)})"
```

随后由 Codex 交互式读取确认后的 mount path 到当前 shell 变量，不打印它；使用 `mount`/`statfs` 只判定目标恰为 `smbfs` 且空间为正。失败即 HOLD。

- [ ] **Step 2: 建立一次性 V2 snapshot fixture**

通过现有 `createBackup` 在新 temp root 创建两个合计 9 bytes 的合成文件，并生成只存在于 temp root 的配置。固定安全身份：

```text
targetName=acceptance-smb
deviceId=linke-v144-acceptance
remoteRoot=linke-v144-acceptance-$C0_COMMIT
recoveryRemoteRoot=linke-v144-recovery-acceptance-$C0_COMMIT
```

配置中的 endpoint/shareName/credentialRef 使用本地非凭证占位值；真实挂载路径只留在 temp config，不进入 argv 输出、Git 或报告。

- [ ] **Step 3: 运行正式复制 CLI**

Run:

```bash
LINKE_NAS_SMB_EXECUTION=enabled node src/agent.js nas-snapshot-replicate \
  --config "$CONFIG_PATH" --data-dir "$DATA_DIR" \
  --target acceptance-smb --device-id linke-v144-acceptance \
  --snapshot-id "$SNAPSHOT_ID" --execute
```

Expected sanitized JSON: `state=replicated`、`fileCount=2`、`totalBytes=9`。Codex 另行读取 remote `FILES.json`/`COMPLETED.json`，逐文件重算 SHA-256，确认 2/2、marker version 精确为 V1.44、marker manifest digest/file count 与实测一致、lock/staging 零残留；原始路径和值只留 temp evidence。只有这些交叉检查全部通过时，receipt 才可写 `completedMarkerValid=true`。

- [ ] **Step 4: 在第二隔离根触发最高风险失败路径**

使用 production `replicateSnapshotToMountedSmb(options, { beforePublish })` 的专用 child；`beforePublish` 只向 parent 发 `staging-ready` 后永久等待。parent 收到该精确信号才发送 `SIGKILL`，并确认：final 不存在、stale lock identity 合法、staging manifest 合法、staged files 2/2 哈希正确、Step 3 已发布根完全不变。真实 attempt identity 只在 temp raw evidence/内存中比较，不打印、不提交；恢复前先记录，恢复结果必须与其全等。

禁止以 timeout 猜测 crash window；未收到 `staging-ready` 就杀进程不算有效演练。

- [ ] **Step 5: 用正式 CLI 恢复**

Run:

```bash
LINKE_NAS_SMB_EXECUTION=enabled node src/agent.js nas-snapshot-replicate \
  --config "$RECOVERY_CONFIG_PATH" --data-dir "$DATA_DIR" \
  --target acceptance-smb --device-id linke-v144-acceptance \
  --snapshot-id "$SNAPSHOT_ID" --execute --recover
```

Expected: `state=recovered`；Codex 在 temp raw evidence 内确认与 crash attempt identity 全等；恢复根无 final、lock/staging/其它残留均为 0；Step 3 根仍 2/2 有效。仓库报告只写“same attempt identity validated”，同时明示 receipt 本身不提供密码学证明。

- [ ] **Step 6: 运行只读审计与收敛检查**

Run:

```bash
node src/agent.js audit-integrity-monitor --data-dir "$DATA_DIR"
```

Expected: exit 0，`status=healthy`、`dualWriteState=idle`、`relationship=equal`、`recoveryRequired=false`。任一不符都保持 Gold blocked。

- [ ] **Step 7: 生成本地脱敏 candidate receipt**

只从已核验 raw evidence 映射设计中的固定 JSON 字段；`runtimeSourceCommit` 为 Step 1 完整 40-hex；`acceptedAt` 取最终通过时 canonical UTC；`manifestSha256` 取 Step 3 实际 digest。运行凭据校验器，但此时不改仓库。

### Task 5: C1 证据文件与封闭验收测试

**Files:**
- Create: `docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json`
- Create: `docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md`
- Modify: `test/real-nas-acceptance-evidence.test.js`

**Interfaces:**
- Consumes: Task 4 实测字段、Task 1 validator。
- Produces: 可提交但不具签名/WORM/外部真实性的静态验收证据。

- [ ] **Step 1: 先写 committed-artifact RED**

新增测试：

```js
const receiptPath = resolve(
  import.meta.dirname, '..',
  'docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json',
);
const reportPath = resolve(
  import.meta.dirname, '..',
  'docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md',
);

const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
assert.strictEqual(validateRealNasAcceptanceEvidence(receipt), true);
assert.strictEqual(receipt.runtimeSourceCommit, C0_COMMIT);
```

`C0_COMMIT` 在 Task 4 后写成实际 40-hex 常量。Markdown 测试断言包含 acceptanceId、PASS、overall partial、`5/4/0/9`、not Gold；并拒绝设计列出的敏感字段/形态及任何 64-hex。

- [ ] **Step 2: Codex 观察证据 RED**

Run:

```bash
node --test test/real-nas-acceptance-evidence.test.js
```

Expected: FAIL，原因仅为两个报告尚不存在。

- [ ] **Step 3: Grok 写入实测 JSON 与脱敏 Markdown**

Grok prompt 只提供 Task 4 已脱敏字段，不提供 mount/config/dataDir/路径、文件名、原始输出。JSON 使用实测精确值，不允许示例值；Markdown 明示：non-production、真实复制 PASS、受控 SIGKILL 恢复 PASS、零残留、audit healthy、证据非签名/WORM/外部真实性、Linke overall 仍 partial/not Gold。

- [ ] **Step 4: Codex 独立验证凭据 GREEN**

Run:

```bash
node --test test/real-nas-acceptance-evidence.test.js
git diff --check
```

Expected: PASS；JSON schema/脱敏、Markdown 脱敏均通过。

### Task 6: C1 静态 Gold 计分板与 V1.44 最终文档

**Files:**
- Modify: `src/gold-readiness.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/agent-gold-readiness.test.js`
- Modify: `test/version.test.js`
- Modify: `test/readme.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 5 committed-path evidence。
- Produces: `real-nas-remote-backup=ready`、overall partial、`5/4/0/9`。

- [ ] **Step 1: 先写 scorecard/CLI/final-surface RED**

测试精确要求：

```js
assert.strictEqual(report.status, 'partial');
assert.deepStrictEqual(report.summary, {
  ready: 5, partial: 4, blocked: 0, total: 9,
});
assert.strictEqual(nasItem.status, 'ready');
```

NAS evidence 必须包含 JSON、Markdown、validator test 三条具体路径；`nextStep` 必须要求保持 guarded real SMB regression/version-bound receipt，不含 Gold 已完成措辞。真实 server 的 `gold-readiness --fail-on-blocked` 应退出 0 并打印 partial report；保留 mock invalid/unreachable 测试。

最终 current signature 固定为：

```text
V1.44 real Synology SMB copy and crash-recovery acceptance evidence
```

当前 README surface 必须包含 `real-nas-remote-backup ready`、`overall partial 5/4/0/9`、`four partial items remain`、`not Gold`；V1.43 继续是历史行。

测试必须逐项执行以下精确断言，并精确断言 scorecard `status === 'partial'`；不得用允许近义词漂移的宽松正则替代：

```js
for (const phrase of [
  'real-nas-remote-backup ready',
  'overall partial 5/4/0/9',
  'four partial items remain',
  'not Gold',
]) {
  assert.ok(currentSurface.includes(phrase), `missing exact phrase: ${phrase}`);
}
```

- [ ] **Step 2: Codex 观察 C1 RED**

Run:

```bash
node --test test/gold-readiness.test.js test/agent-gold-readiness.test.js test/version.test.js test/readme.test.js
```

Expected: FAIL，因为 scorecard 仍 blocked `4/4/1/9` 且 README 仍 candidate。

- [ ] **Step 3: Grok 最小更新静态条目和文档**

`src/gold-readiness.js` 的唯一业务状态变化：

```js
{
  id: 'real-nas-remote-backup',
  area: 'nas',
  label: 'Real NAS remote backup execution',
  status: 'ready',
  evidence: [
    'docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json',
    'docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md',
    'test/real-nas-acceptance-evidence.test.js',
  ],
  nextStep: 'Keep guarded real SMB regression and version-bound unsigned acceptance evidence current; four partial Gold items remain.',
}
```

不硬编码总体 summary；继续由现有 `buildSummary` / `buildOverallStatus` 计算。README 只改当前 V1.44 surface、版本表和两处当前 Gold 汇总；历史行保持原始历史状态。

- [ ] **Step 4: 聚焦 GREEN**

Run:

```bash
node --test test/real-nas-acceptance-evidence.test.js test/gold-readiness.test.js test/agent-gold-readiness.test.js test/version.test.js test/readme.test.js
```

Expected: 全 PASS；overall partial、`5/4/0/9`、无 blocked、CLI exit 0。

- [ ] **Step 5: 验证 C0→C1 无数据路径变化**

Run:

```bash
C0_COMMIT="$(node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const receipt = JSON.parse(readFileSync(
    'docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json',
    'utf8',
  ));
  process.stdout.write(receipt.runtimeSourceCommit);
")"
export C0_COMMIT
test "$(git hash-object src/real-nas-acceptance-evidence.js)" = "$(git rev-parse "$C0_COMMIT:src/real-nas-acceptance-evidence.js")"
git diff --exit-code "$C0_COMMIT" -- src package.json ':(exclude)src/gold-readiness.js'
```

Expected: validator hash 不变；除 `src/gold-readiness.js` 外全部 `src` 与 `package.json` diff 为空。若任一不符，进入 HOLD，不得把 NAS 项标 ready。

### Task 7: 独立统计、闭环审查与 C1 提交/推送门

**Files:**
- Review only: C1 全部 diff、测试与真实验收证据。
- Temporary only: GLM/Qwen/Kimi prompt 与脱敏证据包。

**Interfaces:**
- Consumes: Task 4–6 的可复现实证。
- Produces: 外部意见 + Codex 最终裁决；不自动 commit/push。

- [ ] **Step 1: Codex 完整回归与静态检查**

Run:

```bash
C0_COMMIT="$(node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const receipt = JSON.parse(readFileSync(
    'docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json',
    'utf8',
  ));
  process.stdout.write(receipt.runtimeSourceCommit);
")"
export C0_COMMIT
npm test
git diff --check
git status --short --branch
git diff --stat "$C0_COMMIT"
node --input-type=module -e "
  import { execFileSync } from 'node:child_process';
  const allowed = new Set([
    'README.md',
    'docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json',
    'docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md',
    'src/gold-readiness.js',
    'test/real-nas-acceptance-evidence.test.js',
    'test/gold-readiness.test.js',
    'test/agent-gold-readiness.test.js',
    'test/version.test.js',
    'test/readme.test.js',
  ]);
  const changed = execFileSync('git', ['diff', '--name-only', process.env.C0_COMMIT], {
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);
  const unexpected = changed.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) process.exit(1);
"
```

Expected: 全部测试 PASS；只含 C1 精确白名单文件；任何根级脚本、`.npmrc`、hook、bin 或其它路径变化都退出 1；`package-lock.json` 未触碰。

- [ ] **Step 2: Qwen fresh statistics**

只读证据包包含：文件列表、diff numstat、测试命令/通过失败数量、receipt key/value 类型摘要、Gold 前后计数、C0→C1 运行时代码 diff 为空的证据。Qwen 只输出统计与不一致项，不给批准，不写文件。

- [ ] **Step 3: Kimi fresh closure review**

Kimi helper 输入包含完整设计验收标准、C1 diff（或带 hash/行数/区间的受控证据包）、全部测试输出、真实 SMB 阶段证据、GLM findings 与 PM 裁决、Qwen 统计、Git HEAD/status、Gold boundary 和 `UNVERIFIED_GAPS`。固定输出：

```text
VERDICT: PASS|BLOCKED|NEEDS_CONTEXT
P0:
P1:
P2:
EVIDENCE_CHECKED:
UNVERIFIED_GAPS:
GOLD_IMPACT:
CLOSURE_READY: YES|NO
```

等待预算 600–900 秒，每 30 秒轮询；空输出、缺 `[DONE]`、timeout 或 schema 缺失都不是 PASS。

- [ ] **Step 4: Codex verifier 最终事实裁决**

Codex 独立确认：有效 RED、GREEN、完整 suite、真实 SMB copy、受控 crash/recover、receipt 实测一致、零残留、审计健康、C0→C1 无 NAS 数据路径变化、Gold partial `5/4/0/9`。外部模型 PASS 不能替代任何一项。

- [ ] **Step 5: STOP，请求 C1 commit 授权**

建议 message：

```text
feat: record V1.44 real NAS acceptance evidence
```

批准后精确 stage C1 文件并执行 cached diff 检查；commit 后验证。随后单独请求 push 授权；push 后核对 upstream commit。不得把 Gold 状态描述为 ready。

## Final Completion Criteria

- C0 候选 commit 与 receipt `runtimeSourceCommit` 精确一致。
- 真实复制 2 files / 9 bytes / 2 verified，COMPLETED marker V1.44 有效。
- staging-ready 后真实 `SIGKILL`，恢复 `state=recovered`、无错误 final、三类残留为零、首个发布快照保持。
- audit 为 `healthy / idle / equal` 且无需恢复。
- JSON/Markdown 脱敏与封闭 schema 测试通过。
- `real-nas-remote-backup=ready`，overall `partial`，summary `5/4/0/9`，四个 partial 不变。
- 聚焦测试、完整 `npm test`、diff/whitespace、C0→C1 runtime-diff 检查通过。
- GLM adversary findings 已裁决、Qwen statistics 无矛盾、Kimi closure schema 完整、Codex verifier 通过。
- C1 commit/push 均分别获用户授权后完成；本计划不宣称 Gold/GA。
