# V1.29 Supervisor Lifecycle Operator Recovery Design

## 目标

V1.29 用 **code-owned、纯函数、fail-closed、受限（restricted）operator-recovery pure data resolver / readiness contract** 替换 V1.22 的 disabled operator recovery stub。本版本把 **最后一个** required contract `operator-recovery` 从 `blocked/false` 推进为 `ready/true`，并在 execution gate 内基于 **production-derived sanitized `actionCandidates` + allowlisted `operation`** 调用 pure resolver，返回 sanitized `recoveryDecision`，把 policy context 的 `operatorRecoveryReady` fact 接成严格验证后的本地 boolean。

本版完成的是 **纯数据 operator-recovery 计划校验（pure data operator-recovery plan validation）**：只核验 action 集合是否能映射到 code-owned 固定 `recoveryKind` 标识符表。它 **不** 执行 failure recovery、**不** 调度 retry、**不** 发 operator notification、**不** 执行 runbook、**不** restart service、**不** restore state、**不** 调用 launchctl/fs/network/process/shell。

### 关键边界（必须先读）

| 层级 | V1.29 是否完成 | 含义 |
| --- | --- | --- |
| **restricted operator-recovery contract / readiness** | **是** | code-owned action→recoveryKind 映射可核验；readiness/contract ready；gate 可在合法 candidates 上得到 `operatorRecoveryReady:true`；wiring **6/0** |
| **real operator recovery implementation（retry / notify / runbook / restart / restore）** | **否** | 不重启服务、不恢复状态、不通知 operator、不写 retry state；`realOperatorRecoveryImplementationReady` 恒 false；`wouldRecover` / `wouldRetry` / `wouldNotifyOperator` / `wouldRestartService` / `wouldRestoreState` / 全部 `*Allowed` 恒 false |
| **real host mutation / real rollback write-restore / real attempt audit persist（V1.26–V1.28 遗留）** | **否** | 对应 `real*ImplementationReady` 字段 **不** 因本版变 true |
| **real guarded runner wiring / Gold 发布** | **否** | `runnerWiringContractReady` / `realRunnerWiringReady` / `executionEligible` / Gold **不** 因 6/0 变 true/ready |

**严禁**把 pure data operator-recovery plan / readiness ready、或 wiring **6/0**，冒充真实 host 执行、真实 recovery、或 Gold 发布完成。

**恢复锚点：** `a088630`（`feat: add V1.28 attempt audit contract`）。实现越界时回到该 commit 的干净状态再重做（见 §9；**禁止**在 plan/docs 中建议 `git reset --hard` 作为常规步骤）。

---

## 0. 源码事实基线（a088630 / V1.28，不得猜）

以下全部来自当前 `src/supervisor-lifecycle.js` / `src/web/app.js` / `src/gold-readiness.js`，是 V1.29 设计的硬约束。

### 0.1 `POLICY_FACT_KEYS` 与 policy blocker 词汇（完整、不可遗漏）

```js
// src/supervisor-lifecycle.js — 当前权威
const POLICY_FACT_KEYS = Object.freeze([
  'lifecyclePlanValid',
  'approvalRecordReady',
  'manifestReady',
  'runnerBindingsReady',
  'executionPreviewVerified',
  'executeRequested',
  'actionCandidatesReady',
  'runnerRegistryReady',
  'hostMutationAdapterReady',
  'rollbackAnchorReady',
  'attemptAuditReady',
  'operatorRecoveryReady',        // ← 最后一项 wiring fact；V1.28 production gate 仍 hardcode false
]);

const POLICY_FACT_BLOCKERS = Object.freeze({
  // ...
  operatorRecoveryReady: 'operator-recovery-not-ready',
});
```

`evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy` 语义（V1.24，**本版不改 evaluator 算法**）：

1. 对 `POLICY_FACT_KEYS` 逐项扫描；任一 `!== true` → 收集对应 `POLICY_FACT_BLOCKERS[key]`。
2. `blockers.length > 0` → `state:'denied'`，`primaryBlocker === blockers[0]`（**顺序 = POLICY_FACT_KEYS 序**）。
3. **全部 fact 为 `true` 且 operation allowlisted** → `state:'authorized'`、`authorized:true`、`wouldAuthorizeExecution:true`、`primaryBlocker:null`、`blockers:[]`。
4. **任意** decision：`wouldRun`/`wouldWrite`/全部 `allow*` **恒 `false`**（authorize ≠ host execute）。

`EXECUTION_POLICY_BLOCKER_CODES` **当前不含** `real-guarded-runner-execution-wiring-missing`。该码仅出现在 gate 顶层 `blockers` / `nextBlockers` 与 wiring aggregate `blockers`，**不是** policy vocabulary 成员。

### 0.2 V1.28 production gate 硬编码事实

| 字段 | V1.28 值 | locus |
| --- | --- | --- |
| `gates.operatorRecoveryReady` / `policyContext.operatorRecoveryReady` | **hardcoded `false`** | gate |
| `operatorRecoveryReadiness.state` | `'blocked'` | wiring |
| `operatorRecoveryReady`（readiness） | `false` | readiness builder |
| `realOperatorRecoveryReady`（旧键名） | `false` | readiness top-level |
| `requiredContracts[5]`（`operator-recovery`） | `status:'blocked'`，`blockerCode:'operator-recovery-missing'` | wiring |
| `readyCount` / `blockedCount` | `5` / `1` | wiring aggregate |
| ready path `policyDecision.primaryBlocker` | `'operator-recovery-not-ready'` | policy |
| `gates.runnerWiringContractReady` | **hardcoded `false`** | gate |
| `gates.realRunnerWiringReady` / 顶层 `realRunnerWiringReady` | **hardcoded `false`** | gate |
| `executionEligible` / `wouldExecute` | **hardcoded `false`** | gate 顶层 |
| gate `blockers` 含 | `real-guarded-runner-execution-wiring-missing`（另加上游 blockers） | gate |
| gate `nextBlockers` | `['real-guarded-runner-execution-wiring-missing']` | gate |
| wiring aggregate `state` | `'blocked'` | wiring |
| wiring aggregate `blockers` | `['real-guarded-runner-execution-wiring-missing']` | wiring |

### 0.3 `executionEligible` 语义（V1.24 写死，源码现 hardcode false 实现）

```text
executionEligible =
  lifecyclePlanValid &&
  approvalRecordReady &&
  manifestReady &&
  runnerBindingsReady &&
  executionPreviewVerified &&
  executeRequested &&
  actionCandidatesReady &&
  executionPolicyReady &&
  policyDecision.authorized === true &&
  runnerRegistryReady &&
  hostMutationAdapterReady &&
  rollbackAnchorReady &&
  attemptAuditReady &&
  operatorRecoveryReady &&
  realRunnerWiringReady &&          // ← 不在 POLICY_FACT_KEYS；V1.29 仍 false
  runnerWiringContractReady         // ← 不在 POLICY_FACT_KEYS；V1.29 仍 false
```

**结论（源码事实）：** 即便六个 pure required contracts 全 ready、全部 `POLICY_FACT_KEYS` 为 true、`policyDecision.authorized === true`，只要 `realRunnerWiringReady` 或 `runnerWiringContractReady` 为 false，`executionEligible` **仍必须 false**。

### 0.4 Web 安全边界（V1.29 方案 A：policy truth ≠ execution eligibility）

**禁止“双层真相”：** 不得把 JSON `policyDecision.state:'authorized'` 渲染为 Web `denied`；不得把 JSON `primaryBlocker:null` 渲染为 policy 行 `primaryBlocker:unknown`。

Web **拆成两个独立 locus**（均 exact、固定、fail-closed、**不回显** raw payload 字符串）：

| Locus | 职责 | V1.29 ready path | 非 authorized / 恶意 payload |
| --- | --- | --- | --- |
| **policy truth**（`policyDecision:` 行） | 镜像 JSON pure policy 判定（经 canonical 校验 + blocker allowlist） | `state:authorized` + `primaryBlocker:none` | canonical fail-closed `state:denied` + allowlisted primary（或 `unknown`） |
| **execution eligibility sentinel**（`executionSentinel:` 行） | 表达“仍不可真实执行” | **恒** `state:blocked` + `blocker:real-guarded-runner-execution-wiring-missing` | **同样恒 blocked**（与 policy 无关） |

**Exact 固定输出（定稿）：**

```text
# Locus A — policy truth（仅当 JSON 通过 canonical authorized 谓词）
policyDecision:state:authorized:authorized:true:wouldAuthorizeExecution:true:primaryBlocker:none

# Locus A — 否则（denied JSON / incomplete / 恶意 drift）
policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false:primaryBlocker:<allowlisted-or-unknown>

# Locus B — UI execution sentinel（V1.29 任意路径恒此行，直至真实 wiring 完成）
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing
```

- JSON `primaryBlocker:null`（authorized path）→ UI **`primaryBlocker:none`**（与 wiring `blocker:none` 同构的 null UI sentinel）；**禁止**映射为 `unknown`。
- `unknown` **仅**用于 denied path 上 primary 缺失或不在 `EXECUTION_POLICY_DECISION_BLOCKER_ALLOWLIST` 时的 fail-closed 回退。
- 不得仅因 `payload.authorized===true` / 单字段就渲染 authorized 行；见 §5.2 canonical 谓词。
- **执行不可用** 由 `executionSentinel` + JSON `executionEligible:false` 表达，**不**再靠伪装 policy denied。

### 0.5 V1.22 disabled operator recovery 现状（将被替换）

- Builder：`buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness()`（无参；state blocked）
- Entry：`recoveryKind:'disabled-operator-recovery-stub'`、`realImplementationReady:false`、`wouldRecover/wouldRetry/wouldNotifyOperator:false`、blocker `operator-recovery-real-implementation-missing`
- **无** pure resolver、**无** gate `recoveryDecision`、**无** production 本地 `operatorRecoveryReady` 推导

---

## 0.6 关键：6/0 之后哪些可变 true、哪些必须继续 false/blocked

### A. V1.29 **允许**变为 true / ready 的（pure contract 层）

| 项 | 条件 | 含义 |
| --- | --- | --- |
| `operatorRecoveryReadiness.state` | builder 固定 | `'ready'` |
| readiness `operatorRecoveryReady` | builder 固定 | `true`（**≠** gate fact） |
| `codeOwnedRecoveryResolverReady` | builder 固定 | `true` |
| `requiredContracts[5]` | wiring 固定 | `status:'ready'`、`blockerCode:null`、`evidenceCode:'operator-recovery-ready'` |
| wiring `readyCount` / `blockedCount` | wiring 固定 | **`6` / `0`** |
| `recoveryDecision.state` / `recoveryReady` | production candidates 合法 resolve | `'resolved'` / `true` |
| `gates.operatorRecoveryReady` | readiness ∧ recoveryDecision 严格本地 boolean | production ready install fixtures → `true` |
| `policyContext.operatorRecoveryReady` | 同上本地 boolean | production ready path → `true` |
| **全部 `POLICY_FACT_KEYS` true 时** `policyDecision` | evaluator 既有算法 | **`state:'authorized'`**、`authorized:true`、`wouldAuthorizeExecution:true`、`primaryBlocker:null`、`blockers:[]` |

### B. V1.29 **必须继续 false / blocked** 的（真实实现 / Gold 层）

| 项 | V1.29 值 | 原因（源码事实） |
| --- | --- | --- |
| `realOperatorRecoveryImplementationReady` | **恒 false** | 无真实 recovery/retry/notify/runbook/restart/restore |
| `wouldRecover` / `wouldRetry` / `wouldNotifyOperator` / `wouldRestartService` / `wouldRestoreState` | **恒 false** | pure data 不授权 side effect |
| 全部 recovery `*Allowed`（`metadataWriteAllowed` / `filesystemWriteAllowed` / `remoteCommandAllowed` / `operatorNotificationAllowed`） | **恒 false** | 同上 |
| `policyDecision.wouldRun` / `wouldWrite` / 全部 policy `allow*` | **恒 false** | V1.24 L3；authorize ≠ host execute |
| `realHostMutationImplementationReady` / `wouldMutateHost` / adapter `*Allowed` | **保持 V1.26 false** | 本版不抬升 |
| `realRollbackAnchorImplementationReady` / `wouldWriteAnchor` / `wouldRestore` / anchor `*Allowed` | **保持 V1.27 false** | 本版不抬升 |
| `realAttemptAuditImplementationReady` / `wouldPersistAudit` / `wouldWriteLog` / audit `*Allowed` / `immutableAuditReady` | **保持 V1.28 false** | 本版不抬升 |
| `realRunnerImplementationsReady` / `realHostRunnerReady` | **保持 V1.25 false** | 本版不抬升 |
| **`runnerWiringContractReady`** | **恒 false** | **6/0 ≠ real wiring ready**；gate hardcode；不在 pure contract 完成定义内 |
| **`realRunnerWiringReady`** | **恒 false** | 无真实 host runner dispatch / launchctl wiring |
| **`executionEligible` / gate 顶层 `wouldExecute`** | **恒 false** | 公式要求 `realRunnerWiringReady && runnerWiringContractReady`；二者仍 false |
| wiring aggregate `state` | **`'blocked'`** | 仍挂 `real-guarded-runner-execution-wiring-missing` |
| wiring aggregate `blockers` / `nextBlockers` | 含 **`real-guarded-runner-execution-wiring-missing`** | 真实 wiring 缺失的 stable gate-level 信号 |
| gate `blockers` / `nextBlockers` | 仍含 **`real-guarded-runner-execution-wiring-missing`** | 同上 |
| Gold readiness | **`blocked`** | scorecard 静态；真实 execution 未达 |
| Web `executionSentinel` 行 | **恒 blocked** | execution eligibility locus；真实 wiring 完成前不解除 |
| Web `policyDecision` 行（policy truth） | ready path **authorized** / `primaryBlocker:none` | 与 JSON pure policy 同真；**不**伪装 denied |

### C. 诚实 primary / blocker 迁移（禁止矛盾）

| 场景 | V1.28 | V1.29（合法 ready production path：全部上游 fact true + operatorRecovery resolve 成功） |
| --- | --- | --- |
| `gates.operatorRecoveryReady` | false | **true** |
| `policyDecision.state` | denied | **`authorized`**（evaluator 既有：全部 POLICY_FACT_KEYS true） |
| `policyDecision.primaryBlocker` | `operator-recovery-not-ready` | **`null`** |
| policy blockers 是否含 `operator-recovery-not-ready` | 是（primary） | **否**（fact 已 true，**禁止**再挂该码） |
| gate `nextBlockers[0]` / 执行资格 primary 信号 | `real-guarded-runner-execution-wiring-missing` | **仍** `real-guarded-runner-execution-wiring-missing` |
| `executionEligible` | false | **false** |

**禁止制造的矛盾：**

> ❌ “全部 six contracts ready、`operatorRecoveryReady:true`，但 `policyDecision.primaryBlocker` 仍是 `operator-recovery-not-ready`”

该矛盾在源码上无法诚实成立：evaluator 在 fact true 时 **不会** 再输出该 blocker。V1.29 **必须**接受 ready path 的 `policyDecision.authorized === true`，同时用 **独立字段** 证明仍不可执行：

- `executionEligible:false`
- `runnerWiringContractReady:false`
- `realRunnerWiringReady:false`
- `policyDecision.wouldRun/wouldWrite:false` + 全部 `allow*:false`
- recovery / adapter / anchor / audit 全部 would* / *Allowed / real*ImplementationReady false
- gate + wiring aggregate 仍带 `real-guarded-runner-execution-wiring-missing`

**最小诚实迁移（不扩展 POLICY_FACT_KEYS）：**

1. **不**新增 policy fact（如 `realRunnerWiringReady`）——扩展 vocabulary 属后续独立版本。
2. **不**把 `real-guarded-runner-execution-wiring-missing` 塞进 `EXECUTION_POLICY_BLOCKER_CODES` 只为“让 policy 继续 deny”——那是伪装 deny，且与 V1.24 “all facts true → authorized” 契约冲突。
3. **做：** 让 `operatorRecoveryReady` 成为真实本地 boolean；ready path policy 自然 authorize；执行资格继续被 `realRunnerWiringReady` / `runnerWiringContractReady` / hardcode `executionEligible` 挡住。
4. **Web（方案 A）：** policy 行诚实镜像 JSON policy truth（authorized path → authorized + `primaryBlocker:none`）；**另增**固定 `executionSentinel` 行恒 blocked。测试必须同时断言两个 locus：**JSON + Web policy 行** may be authorized；**Web executionSentinel + `executionEligible`** 仍 blocked/false。

### D. 后续真实实现 blocker / primary（显式非本版）

6/0 pure contracts 完成后，**下一批** 真实实现缺口（Gold / execution 的 primary 方向）为：

| 优先级 | 缺口 | 表达字段 / 码 | 抬升前不得宣称 |
| --- | --- | --- | --- |
| P0 | real guarded runner host wiring / dispatch | `realRunnerWiringReady`、`runnerWiringContractReady`、`real-guarded-runner-execution-wiring-missing` | `executionEligible:true` / Gold ready |
| P1 | real host mutation implementation | `realHostMutationImplementationReady`、`wouldMutateHost`、adapter `*Allowed` | host launchctl/fs/process side effect |
| P1 | real rollback anchor write/restore | `realRollbackAnchorImplementationReady`、`wouldWriteAnchor`/`wouldRestore` | 真实 rollback IO |
| P1 | real attempt audit persist/log | `realAttemptAuditImplementationReady`、`wouldPersistAudit`/`wouldWriteLog` | 真实 audit IO |
| P1 | real operator recovery | `realOperatorRecoveryImplementationReady`、`wouldRecover`/`wouldRetry`/`wouldNotifyOperator`/`wouldRestartService`/`wouldRestoreState` | 真实 recovery/retry/notify |
| P2 | Gold release 其余 partial（NAS / auth / hardening） | Gold scorecard items | Gold ready |

- **gate 级当前 primary（V1.29 后仍）：** `real-guarded-runner-execution-wiring-missing`
- **policy 级 ready path primary（V1.29 后）：** `null`（authorized）——**不是** “仍 blocked at policy”

---

## 设计选择总览

| 组件 | V1.22 / V1.28 | V1.29 |
| --- | --- | --- |
| recovery catalog | disabled stub | code-owned 固定 actionId→recoveryKind 受限映射表 |
| resolver | 无 | 公开 pure `resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, operation)` |
| readiness | disabled, ready=false | fixed ready evidence, ready=true |
| required contract `operator-recovery` | blocked + missing | ready + `blockerCode:null` + `evidenceCode:'operator-recovery-ready'` |
| wiring readyCount / blockedCount | 5 / 1 | **6 / 0** |
| gate `operatorRecoveryReady` | hardcoded false | readiness + production-derived resolver 本地 boolean |
| gate `recoveryDecision` | 无 | production candidates → resolver → sanitized decision |
| `realOperatorRecoveryImplementationReady` | false（旧名 `realOperatorRecoveryReady`） | **仍 false**（无真实 recovery） |
| decision 字段名 | — | `codeOwnedResolverWired:true`（**来源路径标识**；≠ readiness 的 `codeOwnedRecoveryResolverReady`） |
| production policy ready path | denied，primary=`operator-recovery-not-ready` | **`authorized`**，primary=`null`；wouldRun/wouldWrite/allow* 仍 false |
| gate 顶层 `executionEligible` / `wouldExecute` / `runnerWiringContractReady` / `realRunnerWiringReady` / Gold | false / blocked | **不变** |
| Web policyDecision 行（policy truth） | 强制 denied（V1.24 旧边界） | **方案 A：** authorized path 诚实 authorized + `primaryBlocker:none`；denied/恶意 fail-closed |
| Web executionSentinel 行（execution eligibility） | （无独立行；伪装进 policy denied） | **恒** blocked + `real-guarded-runner-execution-wiring-missing` |

### 为何本版把 required contract 置 ready（而不是只加 resolver 不改 contract）

与 V1.25–V1.28 对称：required contract ready **仅**表示 **code-owned restricted pure data operator-recovery contract/readiness 已接线且可核验**，**不**表示真实 recovery side effect 可执行。若只加 pure resolver 而 contract 仍 blocked，则 wiring 无法到达诚实的 6/0，且与“contract ready = code-owned pure contract ready”语义不一致。

真实 operator recovery implementation 用 **独立字段** 表达并恒 false：

- readiness：`realOperatorRecoveryImplementationReady:false`
- decision / entry / recovery 行：`realOperatorRecoveryImplementationReady:false`、`wouldRecover:false`、`wouldRetry:false`、`wouldNotifyOperator:false`、`wouldRestartService:false`、`wouldRestoreState:false`、全部 `*Allowed:false`

### 与 V1.25–V1.28 的分层（intentional layered fail-closed）

| 层 | 公开 API | 信任边界 | ready 含义 | 不授权 |
| --- | --- | --- | --- | --- |
| V1.24 | `areSupervisorLifecycleGuardedRunnerActionCandidatesReady` | shape + maxAttempts | structural candidates ready | 不授权 registry/adapter/anchor/audit/recovery/execution |
| V1.25 | `resolveSupervisorLifecycleGuardedRunnerRegistry` | actionId + catalog implementationId + numeric maxAttempts | registry mapping 可核验 | 不授权 host mutation / recovery / execution |
| V1.26 | `resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter` | actionId + status/would* false；**忽略** implementationId / maxAttempts | restricted mutationKind 可核验 | 不授权真实 host mutation |
| V1.27 | `resolveSupervisorLifecycleGuardedRunnerRollbackAnchor` | actionId + status/would* false；**不读** mutationKind | restricted anchorKind 可核验 | 不授权 anchor write/restore |
| V1.28 | `resolveSupervisorLifecycleGuardedRunnerAttemptAudit` | actionId + status/would* false；**不读** mutationKind/anchorKind | restricted auditKind 可核验 | 不授权 persist/log |
| **V1.29** | `resolveSupervisorLifecycleGuardedRunnerOperatorRecovery` | actionId + status/would* false；**忽略** implementationId / maxAttempts；**不读** mutationKind / anchorKind / auditKind / registryDecision / adapterDecision / anchorDecision / auditDecision | restricted **纯数据** recoveryKind 可核验 | 不授权 recover/retry/notify/restart/restore、host mutation、execution |

**分层失败矩阵（production gate 必须可测）：**

| 场景 | actionCandidatesReady | registry | adapter | anchor | audit | recovery | gates.*Ready（reg/ada/anc/aud/rec） | policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 合法 catalog + numeric maxAttempts + would* false + executeRequested | true | resolved | resolved | resolved | resolved | resolved | 全 true | **authorized**，primary=`null`；**不含**任何 `*-not-ready`；**仍** `executionEligible:false` |
| 同上但 executeRequested false | true | resolved | resolved | resolved | resolved | resolved | recovery 等 wiring facts 仍 true；`executeRequested:false` | denied，含 `execute-request-missing`；**不含** `operator-recovery-not-ready` |
| 合法格式非 catalog `implementationId` | true | unresolved | resolved | resolved | resolved | **resolved** | reg false；其余 true | denied，含 `runner-registry-not-ready`；**不含** recovery/adapter/anchor/audit not-ready |
| maxAttempts `'[redacted]'` | true | unresolved | resolved | resolved | resolved | **resolved** | 同上 | 同上 |
| empty / missing binding candidates | false | unresolved | unresolved | unresolved | unresolved | unresolved | 全 false | deny，含 not-ready 族 |
| pure-only unsafe would* true | — | — | unresolved | unresolved | unresolved | unresolved | — | pure 覆盖 |

**关键不变量：**

1. V1.29 **不**修改 V1.24–V1.28 的 public 契约语义。
2. Operator-recovery resolver **不得**读取 `registryDecision` / `adapterDecision` / `anchorDecision` / `auditDecision` / `mutationKind` / `anchorKind` / `auditKind` / request override。
3. Operator-recovery ready **绝不**把 `wouldRecover` / `wouldRetry` / `wouldNotifyOperator` / `wouldRestartService` / `wouldRestoreState` / `*Allowed` / `executionEligible` / 上游 would* 变 true。
4. Adapter / Anchor / Audit / Recovery 对同一合法 production candidates 应可同时 resolved；对 non-catalog / redacted 路径后三者可 resolved 而 registry unresolved（intentional）。
5. **`runnerWiringContractReady` / `realRunnerWiringReady` / `executionEligible` / Gold 在 V1.29 仍 false/blocked**——即使 readyCount 变为 **6/0**。
6. Ready path **禁止** `policyDecision.primaryBlocker === 'operator-recovery-not-ready'`。

V1.29 **必须继续保持**：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`（**禁止**因 6/0 变 true）
- `realRunnerWiringReady:false`
- gate 顶层：`executionEligible:false`、`executorReady:false`、`wouldExecute:false`
- 副作用 would* 在其真实 locus 恒 false
- `real-guarded-runner-execution-wiring-missing` 仍在 gate + wiring aggregate
- Gold readiness: `blocked`
- G0a 真实双机 PASS 声明不变
- Web `executionSentinel` 恒 blocked（execution eligibility locus；**不**再伪装 policy denied）

V1.29 **必须改变**：

- `operatorRecoveryReady:true`（readiness 固定 true；production gate fact 仅在 resolver 对 production candidates 解析成功时为 true）
- `operatorRecoveryReadiness.state:'ready'` + `codeOwnedRecoveryResolverReady:true` + `realOperatorRecoveryImplementationReady:false`
- `runnerWiringContract.requiredContracts[5]` → ready + `operator-recovery-ready`
- `runnerWiringContract.readyCount:6`、`blockedCount:0`
- production gate 返回 sanitized `recoveryDecision`；`operatorRecoveryReady` 为本地 boolean
- ready production path（全部上游 + recovery ready + executeRequested）：`policyDecision` **authorized**，primary=`null`
- Web ready path：`policyDecision:` 行 **authorized** + `primaryBlocker:none`；并 **始终** 输出固定 `executionSentinel:` blocked 行
- 旧键 `realOperatorRecoveryReady` / entry `realImplementationReady` / entry `sensitiveValuesReturned` / stub kind **不得残留**

**不得**调度/调用 runner；不得 host shell / process-control / fs / metadata / audit / approval / 真实 recovery / NAS / 网络副作用。不新增 endpoint、CLI command、Web button、request body field。**禁止修改** `src/agent.js` / `src/server.js` / `package.json`。不得接受 request/CLI/Web 直传的 `recoveryDecision` / `recoveryContext` / `operatorRecoveryReady` override。

### 副作用 / 资格字段 locus（禁止“全部对象都有全部字段”误读）

| 字段 | 所在对象（唯一合法 locus） | V1.29 |
| --- | --- | --- |
| `executionEligible` | **仅** gate 顶层 | 恒 `false` |
| `wouldExecute` | gate 顶层；**另**见于 registry/adapter/anchor/audit/recovery decision、actionCandidates、readiness entry、recovery 行 | 恒 `false` |
| `wouldRun` / `wouldWrite` | **不在** gate 顶层；见于 policy/registry/adapter/anchor/audit/recovery decision、candidates、entry、行 | 恒 `false` |
| `wouldRecover` / `wouldRetry` / `wouldNotifyOperator` / `wouldRestartService` / `wouldRestoreState` | **仅** `recoveryDecision`、recovery readiness entry、recovery 行 | 恒 `false` |
| recovery `*Allowed` | **仅** recovery decision / entry / 行 | 恒 `false` |
| `gates.operatorRecoveryReady` | `gates` | production resolve 成功时 true；否则 false |
| `operatorRecoveryReady`（readiness 级） | readiness builder | 固定 true（≠ gate fact） |
| `gates.attemptAuditReady` / `rollbackAnchorReady` / `hostMutationAdapterReady` / `runnerRegistryReady` | `gates` | **保持 V1.28/V1.27/V1.26/V1.25 语义**（不回退） |
| `gates.runnerWiringContractReady` / `realRunnerWiringReady` | `gates` | **恒 false** |

**禁止**断言 `result.wouldRun` / `result.wouldWrite` / `result.wouldRecover`（gate 顶层不存在这些字段）。断言 must 按上表 locus 精确落点。

关于用户提及的 `wouldRecoverHost`：本设计 **不** 引入该字段名（避免与 V1.22 既有 `wouldRecover` 双轨）。主机恢复意图由 **`wouldRecover` + `wouldRestartService` + `wouldRestoreState`** 三个恒 false 字段共同表达。

---

## 1. 纯函数 operator-recovery resolver

### 1.1 导出（稳定 public pure API）

```js
/**
 * Resolve and verify sanitized guarded-runner action candidates against the
 * code-owned restricted operator-recovery mapping table (pure data plan only).
 *
 * Ready resolution means only that every candidate actionId maps to the fixed
 * restricted recoveryKind for the given operation. It does NOT recover hosts,
 * restart services, restore state, schedule retries, notify operators, execute
 * runbooks, launchctl/shell/process/network/fs; does NOT set wouldRecover /
 * wouldRetry / wouldNotifyOperator / wouldRestartService / wouldRestoreState /
 * *Allowed / wouldExecute/wouldRun/wouldWrite true; does NOT imply
 * realOperatorRecoveryImplementationReady, realHostMutationImplementationReady,
 * realRollbackAnchorImplementationReady, realAttemptAuditImplementationReady,
 * realRunnerWiringReady, runnerWiringContractReady, or executionEligible.
 *
 * Returns a deep-copied plain decision object only — never functions,
 * command strings, paths, hosts, tokens, hashes, or raw Error objects.
 * Invalid input, getters, traps, unsafe mutation flags, or set mismatch →
 * fail-closed unresolved.
 *
 * @param {unknown} candidates
 * @param {unknown} operation
 * @returns {object}
 */
export function resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, operation)
```

| 项 | 要求 |
| --- | --- |
| 可见性 | **export**；公共 JSDoc 声明语义与非执行边界 |
| 参数 | **仅** `candidates` + `operation`；不读 request/options/fs/env/manifest/runnerBinding/上游 decision；不接受 caller-supplied recoveryDecision |
| 返回 | 仅 plain object（深拷贝）；不返回 function / Promise / command / path / host / token / hash / raw error |
| 副作用 | 无 |
| 真值 | `state:'resolved'` 且 `recoveryReady:true` **仅**表示受限 pure data recovery 映射核验通过 |
| 假值 | invalid / mismatch / unsafe / trap → `state:'unresolved'` + 单一 exact allowlisted primary blocker |

**命名：** `resolve...OperatorRecovery`（resolve/readiness，不暗示 execute）。拒绝 `recoverHost` / `restartService` / `notifyOperator` / `dispatch...`。

### 1.2 输入：candidates + operation

`operation` 必须是 string 且 ∈ `{'install','uninstall','rollback','recover'}`；否则 unresolved + **唯一** blocker `operator-recovery-operation-invalid`，decision.`operation` 输出 **`'unknown'`**（**仅此路径** 输出 unknown）。

**decision.operation 回显规则（禁止“所有 unresolved → unknown”）：**

| 输入 operation | 结果 state | decision.`operation` |
| --- | --- | --- |
| allowlisted | resolved **或** unresolved（candidates/集合/unsafe 等） | **回显同一合法 operation** |
| 非 allowlisted / 非 string / 缺失 | unresolved + `operator-recovery-operation-invalid` | **`'unknown'`** |

测试 helper `assertRecoveryUnresolvedExact(decision, primaryBlocker, operation)` 的第三参 **必传**、禁止默认 `'unknown'`。

`candidates` 输入 **不是** “长度必须 equal `|E|`” 的 structure precondition。容器合法后，长度/集合偏差走 §1.6 集合类 blocker；**仅** `state:'resolved'` 成功时要求 actionId 集合与 expected set **exact match**。

结构入口（与 V1.25–V1.28 容器策略同形，blocker 前缀换为 `operator-recovery-`）：

1. 非 array / null / type-confusion → `operator-recovery-candidates-invalid`
2. empty array → `operator-recovery-candidates-invalid`
3. 容器 trap / 元素 shape / exact-key 偏差 / accessor / trap / type-confusion → `operator-recovery-candidates-invalid`
4. **snapshot 后** `actionId` 非「非空 string」→ **唯一** `operator-recovery-candidates-invalid`（先于 duplicate / unknown / missing）
5. **长度 ≠ `|E|` 本身绝不能直接变** `candidates-invalid`

#### Candidate exact keys（与 sanitized gate action candidate contract 一致）

```text
actionId, implementationId, runnerKind, mode, status,
wouldExecute, wouldRun, wouldWrite, maxAttempts
```

- 顺序无关；键集合多/少/原型污染 → `operator-recovery-candidates-invalid`
- 无 own getter：每 key 恰好一次 `Object.getOwnPropertyDescriptor`，必须 data property
- `Object.getPrototypeOf(element) === Object.prototype` 或 `=== null`
- descriptor / `ownKeys` throw → candidates-invalid；**不得**把 raw error 写入 decision

#### Operator-recovery 对 candidate 字段的信任边界

| 字段 | 是否用于 ready resolve | 说明 |
| --- | --- | --- |
| `actionId` | **是** | 集合与 `buildLifecycleActions(operation)` expected set exact match；映射 recoveryKind |
| `status` / `wouldExecute` / `wouldRun` / `wouldWrite` | **是** | 必须 exact `status:'blocked'` 且三 would* exact `false`；否则 **唯一** `operator-recovery-unsafe-recovery` |
| `implementationId` / `runnerKind` / `mode` / `maxAttempts` | **否（忽略值内容）** | 仍须存在于 exact-key shape |

### 1.3 Code-owned 固定 action → recoveryKind 映射表

Operator-recovery **只信任** `src/supervisor-lifecycle.js` 内冻结表。manifest / runnerBinding / request / CLI / Web / executionPreview / approval / config / env / fs / caller-supplied decision / 上游 decision **一律不可**注入 ready。

#### 1.3.1 Action 集合（必须来自 `buildLifecycleActions`，不得增减）

| operation | actionId（顺序固定） |
| --- | --- |
| `install` | `render-launch-agent-plist`, `write-launch-agent-plist`, `load-launch-agent` |
| `uninstall` | `unload-launch-agent`, `remove-launch-agent-plist`, `remove-supervisor-metadata` |
| `rollback` | `capture-current-state`, `restore-previous-plist`, `restart-previous-supervisor` |
| `recover` | `start-recovery-supervisor` |

权威来源 **仅** `buildLifecycleActions(operation).map((a) => a.id)`。测试 fixture 经公开 apply plan 路径间接核验，禁止第二套可漂移列表。

#### 1.3.2 固定 recoveryKind 映射（identifiers only — pure data plan）

下列 ID 是 **restricted pure data operator-recovery plan identifiers only**——不是 runbook 路径、不是 notification payload、不是 retry scheduler handle、不是 shell/launchctl argv。仓库中 **不存在**真实 operator recovery implementation。

| actionId | recoveryKind |
| --- | --- |
| `render-launch-agent-plist` | `render-plist-operator-recovery` |
| `write-launch-agent-plist` | `write-plist-operator-recovery` |
| `load-launch-agent` | `load-agent-operator-recovery` |
| `unload-launch-agent` | `unload-agent-operator-recovery` |
| `remove-launch-agent-plist` | `remove-plist-operator-recovery` |
| `remove-supervisor-metadata` | `remove-metadata-operator-recovery` |
| `capture-current-state` | `capture-state-operator-recovery` |
| `restore-previous-plist` | `restore-plist-operator-recovery` |
| `restart-previous-supervisor` | `restart-supervisor-operator-recovery` |
| `start-recovery-supervisor` | `recovery-supervisor-operator-recovery` |

- 不得输出 planned runbook path / operator address / notification body。
- **install** 三 actionId 与既有 gate fixture 兼容。
- uninstall / rollback / recover 映射仅供 pure unit tests；**不**表示已有真实 recovery executor。

#### 1.3.3 recoveryKind allowlist

```js
const OPERATOR_RECOVERY_KIND_ALLOWLIST = Object.freeze([
  'render-plist-operator-recovery',
  'write-plist-operator-recovery',
  'load-agent-operator-recovery',
  'unload-agent-operator-recovery',
  'remove-plist-operator-recovery',
  'remove-metadata-operator-recovery',
  'capture-state-operator-recovery',
  'restore-plist-operator-recovery',
  'restart-supervisor-operator-recovery',
  'recovery-supervisor-operator-recovery',
]);
```

输出 recovery 行的 `recoveryKind` **必须** ∈ 该 allowlist，且 **exact equal** 上表固定值。实现不得从 input 读取 recoveryKind（input candidate **无** recoveryKind 键；多键 → candidates-invalid）。

#### 1.3.4 recover operation

`recover` 仅一 action：`start-recovery-supervisor` → `recovery-supervisor-operator-recovery`。V1.29 **不**设计/执行真实 recovery supervisor；仅允许 pure 映射解析为 `resolved`；绝不因此把 would* / *Allowed / executionEligible 变 true。

### 1.4 单次快照 / Proxy 边界

**JavaScript 无法可靠识别所有 `Proxy`。** 本设计 **不声称**可证明拒绝所有 Proxy。

与 V1.25–V1.28 §1.4 **同策略**：

1. 容器：`try/catch` + `Array.isArray` + 一次 `length` + 一次索引读到本地 `elements[]`；禁止再触碰原容器。
2. 元素：`ownKeys` 一次；exact key allowlist；每 key 恰好一次 descriptor → data property → 本地 snapshot。
3. trap throw / getter / type-confusion → `operator-recovery-candidates-invalid`。

#### 生产路径三层防御

| 层 | 约束 |
| --- | --- |
| L1 Gate 构造 | candidates **只来自** `buildGuardedRunnerExecutionGateActionCandidates`；operation 来自 allowlisted plan/preview；不接收 request/options recovery bag |
| L2 Resolver | best-effort 容器快照 + 元素 exact-key snapshot + code-owned recovery map；非法/unsafe → unresolved |
| L3 副作用恒 false | 任意 decision：wouldRecover / wouldRetry / wouldNotifyOperator / wouldRestartService / wouldRestoreState / 全部 *Allowed / would* / realOperatorRecoveryImplementationReady 恒 false；gate top-level executionEligible/wouldExecute 与 runnerWiringContractReady/realRunnerWiringReady 亦恒 false |

### 1.5 Decision 输出 schema（exact）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-operator-recovery',
  operation: <allowlisted input echoed, OR 'unknown' only when operation-invalid>,
  state: 'resolved' | 'unresolved',
  recoveryReady: boolean,                         // true only when fully resolved
  codeOwnedResolverWired: true,                   // 见 §2.3
  realOperatorRecoveryImplementationReady: false, // V1.29 恒 false
  wouldRecover: false,
  wouldRetry: false,
  wouldNotifyOperator: false,
  wouldRestartService: false,
  wouldRestoreState: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  metadataWriteAllowed: false,
  filesystemWriteAllowed: false,
  remoteCommandAllowed: false,
  operatorNotificationAllowed: false,
  resolvedCount: number,
  unresolvedCount: number,
  recoveries: [ /* 见下 */ ],
  primaryBlocker: string | null,
  blockers: string[],
  nextBlockers: string[],
  sensitiveValuesReturned: false,
  safety: executionPreviewSafety(),
}
```

**命名：** 使用 `codeOwnedResolverWired`，**不用** `codeOwnedResolverReady`。后者易与 readiness 的 `codeOwnedRecoveryResolverReady` 混淆。

**`codeOwnedResolverWired:true` 语义（P1 定稿）：**

| 是 | 否 |
| --- | --- |
| **单次 decision 来源路径标识**：本条 `recoveryDecision` / readiness entry 由已接线的 code-owned pure resolver 路径发出 | **不是** readiness / readiness-ready 信号 |
| well-formed decision 上恒 `true`（含 resolved 与 unresolved） | **不是** `codeOwnedRecoveryResolverReady`（不同 locus、不同语义） |
| 证明“此输出走了 resolver 路径”，防 stub/伪造旁路 | **不是** real recovery implementation ready；**不是** execution eligibility |

**字段名 `recoveryReady`（decision）≠ readiness `operatorRecoveryReady`。**

#### recoveries 行 schema（**仅** resolved 时非空；**不含** `codeOwnedResolverWired`）

```js
{
  actionId: string,
  recoveryKind: string,              // ∈ OPERATOR_RECOVERY_KIND_ALLOWLIST；catalog exact
  recoveryReady: true,
  realOperatorRecoveryImplementationReady: false,
  wouldRecover: false,
  wouldRetry: false,
  wouldNotifyOperator: false,
  wouldRestartService: false,
  wouldRestoreState: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  metadataWriteAllowed: false,
  filesystemWriteAllowed: false,
  remoteCommandAllowed: false,
  operatorNotificationAllowed: false,
  blockerCode: null,
  evidenceCode: 'operator-recovery-plan-ready',
}
```

#### resolved / unresolved 的 exact 计数字段（all-or-nothing）

| 结果 | `resolvedCount` | `unresolvedCount` | `recoveries` |
| --- | --- | --- | --- |
| resolved | `expectedActionCount(operation)` | `0` | 长度 = expected；顺序 = expected action 序 |
| **任意** unresolved | `0` | `0` | `[]`（永不回显未信任输入行） |

**`unresolvedCount` 在 all-or-nothing 下恒为 `0` 是刻意选择，不是漏计数（P1 定稿）：**

| 规则 | 说明 |
| --- | --- |
| all-or-nothing | 任一 action 失败 ⇒ 整次 decision `state:'unresolved'`，**不**部分产出 recoveries 行 |
| **不统计 action 失败数** | `unresolvedCount` **永不**枚举“失败了几个 action”；不是 partial-fail 计数器 |
| decision 状态 locus | 成败 / 阻塞 **仅** 由 `state` + `primaryBlocker`（及 `blockers` / `nextBlockers`）表达 |
| resolved 时 | `unresolvedCount` 亦为 `0`（无失败 action 行需计数） |
| unresolved 时 | `resolvedCount:0` + `unresolvedCount:0` + `recoveries:[]`；primary 为单一 allowlisted 码 |

#### 一致语义

| 不变量 | 说明 |
| --- | --- |
| `state === 'resolved'` ⇔ `recoveryReady === true` | 同真同假 |
| resolved ⇒ empty blockers、primary null、resolvedCount===expected | |
| unresolved ⇒ 单一 exact allowlisted primary、recoveries:[]、counts 0 | |
| unresolved 且 primary ≠ operation-invalid ⇒ operation 回显合法输入 | |
| unresolved 且 primary = operation-invalid ⇒ operation === 'unknown' | |
| 任意 decision：would* / *Allowed / realOperatorRecoveryImplementationReady 恒 false | resolved ≠ real recovery |
| `codeOwnedResolverWired` 在 well-formed decision 上恒 true | **来源路径标识**（非 readiness） |

### 1.6 Blocker vocabulary（exact allowlist）

```js
const OPERATOR_RECOVERY_BLOCKER_CODES = Object.freeze([
  'operator-recovery-candidates-invalid',
  'operator-recovery-operation-invalid',
  'operator-recovery-action-missing',
  'operator-recovery-action-duplicate',
  'operator-recovery-action-unknown',
  'operator-recovery-unsafe-recovery',
]);
```

**故意不引入：**

| 不引入码 | 原因 |
| --- | --- |
| `operator-recovery-operation-mismatch` | 无独立路径 |
| `operator-recovery-action-extra` | 由 duplicate→unknown→missing 覆盖 |
| `operator-recovery-implementation-mismatch` | implementationId 属 V1.25 |
| `operator-recovery-kind-mismatch` | input 无 recoveryKind 字段 |
| `operator-recovery-real-implementation-missing` | readiness ready 后由 `realOperatorRecoveryImplementationReady:false` 表达；**不**再作 readiness blockers 主码 |
| `operator-recovery-audit-not-ready` 等跨层码 | recovery **不**依赖上游 decision |

#### 评估顺序（稳定 primary）

1. operation allowlist → `operator-recovery-operation-invalid`
2. candidates 容器/元素 shape/exact keys/accessors/traps/empty → `operator-recovery-candidates-invalid`
3. snapshot 后 actionId 非非空 string → `operator-recovery-candidates-invalid`
4. duplicate → `operator-recovery-action-duplicate`
5. unknown（∉ E）→ `operator-recovery-action-unknown`
6. missing expected → `operator-recovery-action-missing`
7. 集合 exact match 后 status/would* 非期望 → `operator-recovery-unsafe-recovery`

多类同时成立时 **primary = 最先命中者**；测试断言 primary 与 blockers[0] exact 单一码。

**长度不等式 pure 覆盖：**

| 侧 | 构造 | primary |
| --- | --- | --- |
| `len < \|E\|` | install 子集 2 行 | `operator-recovery-action-missing` |
| `len > \|E\|` 无重复 | install 3 + 外来 `start-recovery-supervisor` | `operator-recovery-action-unknown` |
| `len > \|E\|` 有重复 | install 3 + 重复 render | `operator-recovery-action-duplicate` |

### 1.7 深拷贝 / 抗 mutation / caller override 防护

1. 调用后改 input → 已返回 decision 不变。
2. 改已返回 decision → 后续调用不受污染。
3. 输出为新对象；`recoveries` / `blockers` / `nextBlockers` / `safety` 均为新数组/新对象。
4. 异常映射固定 blocker，不泄露原值 / raw error。
5. Gate **必须忽略** `options.recoveryDecision` / `options.operatorRecoveryReady` / `options.recoveryContext`。即使 caller 传入 `operatorRecoveryReady:true` 或伪造 `recoveryDecision.state:'resolved'`，gate 仍只使用 production-derived 本地 boolean。

---

## 2. Readiness helper

### 2.1 签名不变

```js
export function buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness()
```

无参数；忽略 runtime-looking 多余参数；不读 config/manifest/binding/preview/approval/env/fs。

### 2.2 输出 schema（exact）

**Top-level readiness exact keys（顺序固定；不多不少）：**

```text
command, state, operatorRecoveryDefined, operatorRecoveryReady,
codeOwnedRecoveryResolverReady, realOperatorRecoveryImplementationReady,
readyCount, blockedCount, recoveryEntries, blockers, nextBlockers, safety
```

```js
{
  command: 'supervisor-lifecycle-guarded-runner-operator-recovery-readiness',
  state: 'ready',
  operatorRecoveryDefined: true,
  operatorRecoveryReady: true,                       // readiness 固定 true（≠ gate fact）
  codeOwnedRecoveryResolverReady: true,
  realOperatorRecoveryImplementationReady: false,    // 唯一 real-* 具名字段；恒 false
  readyCount: 1,
  blockedCount: 0,
  recoveryEntries: [ /* exactly 1 ready catalog entry — 见 §2.4 */ ],
  blockers: [],
  nextBlockers: [],
  safety: executionPreviewSafety(),
}
```

**Top-level 明确排除的键（不得出现）：**

| 排除键 | 原因 |
| --- | --- |
| `realOperatorRecoveryReady` | 旧 readiness 键；重命名为 `realOperatorRecoveryImplementationReady` |
| `realImplementationReady` | 旧通用别名；不得残留 |
| `sensitiveValuesReturned` | 仅 decision top-level + safety；readiness top-level 不开 |
| `codeOwnedResolverWired` | decision / entry 字段；不在 readiness top-level |
| would* / *Allowed 副作用字段 | 落在 entry / decision / recovery 行，不在 readiness top-level |

### 2.3 字段命名、迁移与差异

| 字段 | 所在对象 | V1.29 值 | 含义 |
| --- | --- | --- | --- |
| `codeOwnedRecoveryResolverReady` | readiness | `true` | **产品级 readiness**：pure restricted operator-recovery resolver contract 已就绪 |
| `codeOwnedResolverWired` | recoveryDecision + entry | 恒 `true` | **单次 decision 来源路径标识**（非 readiness；≠ `codeOwnedRecoveryResolverReady`） |
| `realOperatorRecoveryImplementationReady` | readiness / decision / entry / 行 | 恒 `false` | **唯一** real-* 具名字段 |
| `operatorRecoveryReady`（readiness） | readiness builder | 固定 `true` | ≠ `gates.operatorRecoveryReady` |
| `recoveryReady`（decision） | recoveryDecision | resolved 时 true | 单次 pure data 映射核验 |
| wouldRecover / wouldRetry / wouldNotifyOperator / wouldRestartService / wouldRestoreState / *Allowed | decision / entry / 行 | 恒 `false` | 不授权任何 recovery side effect |

#### 字段迁移表（V1.22 → V1.29）

| 旧 locus / 键 | V1.29 处置 | 新键 / 替代 |
| --- | --- | --- |
| readiness `realOperatorRecoveryReady` | **重命名** | `realOperatorRecoveryImplementationReady`（仍恒 false） |
| entry `realImplementationReady` | **删除** | 仅 `realOperatorRecoveryImplementationReady:false` |
| entry `sensitiveValuesReturned` | **删除** | decision top-level + safety |
| entry `failureRecoveryReady` / `retryLimitReady` / `operatorRunbookReady` | **删除**（不得以 true 或 false 残留于 ready entry） | 由 would* 恒 false + real*ImplementationReady:false 表达 |
| entry `recoveryKind:'disabled-operator-recovery-stub'` / `state:'blocked'` | **替换** | `recoveryKind:'code-owned-operator-recovery'` / `state:'ready'` |
| readiness / entry blocker `operator-recovery-real-implementation-missing` | **不再**作为 readiness blockers 主码 | `realOperatorRecoveryImplementationReady:false` |
| readiness blockers 含 `real-guarded-runner-execution-wiring-missing` | **移出** readiness | 仅 wiring aggregate / gate 顶层保留 |

### 2.4 唯一 recovery entry（exact schema）

**Entry exact keys（顺序固定；不多不少）：**

```text
recoveryKind, state, codeOwnedResolverWired, realOperatorRecoveryImplementationReady,
wouldRecover, wouldRetry, wouldNotifyOperator, wouldRestartService, wouldRestoreState,
wouldExecute, wouldRun, wouldWrite,
metadataWriteAllowed, filesystemWriteAllowed, remoteCommandAllowed, operatorNotificationAllowed,
blockerCode, evidenceCode
```

```js
{
  recoveryKind: 'code-owned-operator-recovery',  // catalog-level 汇总标识
  state: 'ready',
  codeOwnedResolverWired: true,
  realOperatorRecoveryImplementationReady: false,
  wouldRecover: false,
  wouldRetry: false,
  wouldNotifyOperator: false,
  wouldRestartService: false,
  wouldRestoreState: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  metadataWriteAllowed: false,
  filesystemWriteAllowed: false,
  remoteCommandAllowed: false,
  operatorNotificationAllowed: false,
  blockerCode: null,
  evidenceCode: 'operator-recovery-ready',
}
```

**`recoveryKind` 语义分层：** readiness entry 上的 `'code-owned-operator-recovery'` 是 **catalog-level 汇总标识**，**不等于** decision `recoveries[]` 行上的 **action-level** `recoveryKind`（后者 ∈ `OPERATOR_RECOVERY_KIND_ALLOWLIST`）。

---

## 3. Wiring contract

### 3.1 requiredContracts（顺序固定）

1. `execution-policy` → ready（V1.24）
2. `runner-registry` → ready（V1.25）
3. `host-mutation-adapter` → ready（V1.26）
4. `rollback-anchor` → ready（V1.27）
5. `attempt-audit` → ready（V1.28）
6. `operator-recovery` → **ready**（V1.29）

### 3.2 Ready `operator-recovery` contract

```js
{
  id: 'operator-recovery',
  status: 'ready',
  requiredForExecution: true,
  evidence: 'Code-owned fail-closed restricted operator-recovery pure data plan resolver is wired.',
  evidenceCode: 'operator-recovery-ready',
  blockerCode: null,
}
```

- `status === 'ready'` ⇒ `blockerCode === null` 且 `evidenceCode === 'operator-recovery-ready'`
- Web 显示 `blocker:none` 仅为 UI sentinel；JSON 仍为 `null`
- 禁止 `status:'ready'` 与 missing blocker 并存

### 3.3 Wiring aggregate

```js
{
  command: 'supervisor-lifecycle-guarded-runner-wiring-contract',
  state: 'blocked',                         // 仍 blocked！
  realRunnerWiringReady: false,             // 恒 false
  readyCount: 6,
  blockedCount: 0,
  requiredContracts: [ /* 6 全 ready */ ],
  executionPolicyReadiness: /* ready */,
  runnerRegistryReadiness: /* ready */,
  hostMutationAdapterReadiness: /* ready */,
  rollbackAnchorReadiness: /* ready */,
  attemptAuditReadiness: /* ready */,
  operatorRecoveryReadiness: /* ready builder */,
  blockers: ['real-guarded-runner-execution-wiring-missing'],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  safety: executionPreviewSafety(),
}
```

`buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview)` 仍忽略 preview 内容。

**关键：**

- `readyCount:6` / `blockedCount:0` **不等于** `runnerWiringContractReady:true`
- `blockedCount:0` **不等于** aggregate `state:'ready'`
- aggregate 仍 `state:'blocked'`，因 **真实** guarded runner wiring 缺失（`real-guarded-runner-execution-wiring-missing`）
- gate `gates.runnerWiringContractReady` 仍恒 `false`
- gate `gates.realRunnerWiringReady` 仍恒 `false`

---

## 4. Execution gate 集成

### 4.1 仅 production-derived 输入调用 resolver

```js
// Ignore options.recoveryDecision / options.operatorRecoveryReady / options.recoveryContext.
const recoveryDecision = sanitizeOperatorRecoveryDecision(
  resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(actionCandidates, operation),
);

const operatorRecoveryReadiness = runnerWiringContract.operatorRecoveryReadiness;
const operatorRecoveryReady =
  operatorRecoveryReadiness?.operatorRecoveryReady === true &&
  operatorRecoveryReadiness?.codeOwnedRecoveryResolverReady === true &&
  operatorRecoveryReadiness?.state === 'ready' &&
  operatorRecoveryReadiness?.realOperatorRecoveryImplementationReady === false &&
  recoveryDecision?.recoveryReady === true &&
  recoveryDecision?.state === 'resolved' &&
  recoveryDecision?.codeOwnedResolverWired === true &&
  recoveryDecision?.realOperatorRecoveryImplementationReady === false &&
  recoveryDecision?.wouldRecover === false &&
  recoveryDecision?.wouldRetry === false &&
  recoveryDecision?.wouldNotifyOperator === false &&
  recoveryDecision?.wouldRestartService === false &&
  recoveryDecision?.wouldRestoreState === false &&
  recoveryDecision?.wouldExecute === false &&
  recoveryDecision?.wouldRun === false &&
  recoveryDecision?.wouldWrite === false &&
  recoveryDecision?.metadataWriteAllowed === false &&
  recoveryDecision?.filesystemWriteAllowed === false &&
  recoveryDecision?.remoteCommandAllowed === false &&
  recoveryDecision?.operatorNotificationAllowed === false;

const policyContext = {
  // ...existing upstream booleans（V1.25–V1.28 语义不回退）...
  attemptAuditReady: attemptAuditReady === true,
  operatorRecoveryReady: operatorRecoveryReady === true, // 不再 hardcoded false
};
```

**硬性约束：**

- 不得从 `options` / request / CLI 读取 recovery override
- `options` 仅允许既有 `executeRequested` boolean
- 不得因 recovery ready 而把 `executionEligible` / `wouldExecute` / `runnerWiringContractReady` / `realRunnerWiringReady` / 任一 would* / *Allowed / real*ImplementationReady 变 true
- 不得把 approval identity / path / hash / command / raw error 放进 resolver 或 policy context

### 4.2 Gate 输出

```js
{
  // ...existing...
  registryDecision,   // V1.25
  adapterDecision,    // V1.26
  anchorDecision,     // V1.27
  auditDecision,      // V1.28
  recoveryDecision,   // V1.29 新增
  policyDecision,     // ready path 可为 authorized；wouldRun/wouldWrite 仍 false
  actionCandidates,
  gates: {
    // ...
    attemptAuditReady,              // V1.28 语义
    operatorRecoveryReady,          // production ready install → true
    realRunnerWiringReady: false,   // 恒 false
    runnerWiringContractReady: false, // 恒 false — 禁止因 6/0 抬升
  },
  executionEligible: false,         // 恒 false
  wouldExecute: false,              // 恒 false
  realRunnerWiringReady: false,
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  // blockers 仍 push real-guarded-runner-execution-wiring-missing
}
```

### 4.3 Production path：policy 可 authorize，执行资格仍 blocked

| 条件 | policy | executionEligible | gate nextBlockers |
| --- | --- | --- | --- |
| 合法 ready install + executeRequested + 全部 wiring resolve 成功 | **authorized**，primary=`null` | **false** | `real-guarded-runner-execution-wiring-missing` |
| 合法 ready install + executeRequested false | denied，含 `execute-request-missing`；**不含** `operator-recovery-not-ready` | false | 同上 |
| empty candidates | denied，含 not-ready 族 | false | 同上 |

测试必须覆盖：

1. “recovery ready 后 policy **不再**以 `operator-recovery-not-ready` 为 primary”
2. “policy authorized **时** executionEligible 仍 false、runnerWiringContractReady 仍 false、realRunnerWiringReady 仍 false”
3. “gate blockers 仍含 `real-guarded-runner-execution-wiring-missing`”
4. “Web ready path：`policyDecision:` 行 authorized + `primaryBlocker:none`，**且** `executionSentinel:` 恒 blocked”（方案 A 双 locus；见 §5.2 W1–W7）

### 4.4 `sanitizeOperatorRecoveryDecision`

- 只保留 allowlisted keys
- blockers / primaryBlocker / nextBlockers 过滤到 `OPERATOR_RECOVERY_BLOCKER_CODES`
- 强制 wouldRecover / wouldRetry / wouldNotifyOperator / wouldRestartService / wouldRestoreState / 全部 *Allowed / would* / realOperatorRecoveryImplementationReady false；`codeOwnedResolverWired:true`（**来源路径标识**，非 readiness）
- 强制 state/recoveryReady 一致；漂移 → unresolved + `operator-recovery-candidates-invalid`
- unresolved 强制 `recoveries:[]`、`resolvedCount:0`、`unresolvedCount:0`（all-or-nothing：**不**统计 action 失败数；决策状态由 `state`/`primaryBlocker` 表达）
- 返回新对象

---

## 5. API / CLI / Web

### 5.1 透传边界

| 通道 | 行为 |
| --- | --- |
| API | 既有 body 不变；响应透传 gate JSON（policy truth 在 `policyDecision`；execution eligibility 在 `executionEligible`/gate blockers）；**不改** `src/server.js` |
| CLI | 既有 flags；JSON 透传（同 API 双 locus）；`--fail-on-blocked` 仍 exit 2；**不改** `src/agent.js` |
| Web | 不新增按钮/字段；**strict canonical fail-closed assembly**（§5.2）；**方案 A：** `policyDecision:` = policy truth，`executionSentinel:` = execution eligibility UI sentinel |

禁止 request/CLI 强制 `recoveryDecision` / `operatorRecoveryReady:true` / `recoveryEntries` override；传入必须忽略。

#### 5.1.1 API / CLI 测试验证契约

改造两个现有共用 helper，**新增参数** `operatorRecoveryReady`（必传 boolean；禁止默认 false 掩盖漏传）：

| Helper | 文件 |
| --- | --- |
| `assertBlockedExecutionGate(body, { runnerRegistryReady, hostMutationAdapterReady, rollbackAnchorReady, attemptAuditReady, operatorRecoveryReady })` | API test |
| `assertBlockedGate(report, { ...同上 })` | CLI test |

**共用 helper 固定（所有 200/成功 gate JSON 路径一致）：**

- wiring：`readyCount:6`、`blockedCount:0`
- `requiredContracts[5]`：ready + `operator-recovery-ready` + `blockerCode:null`
- 全部 6 contracts status ready
- `operatorRecoveryReadiness`：state ready、operatorRecoveryReady true、codeOwnedRecoveryResolverReady true、realOperatorRecoveryImplementationReady false、ready entry exact
- 上游 readiness / contract[0..4]：**保持 V1.24–V1.28 ready**（不回退）
- `gates.runnerWiringContractReady` / `realRunnerWiringReady`：**恒 false**
- gate 顶层 `executionEligible` / `wouldExecute`：false
- `policyDecision.wouldRun` / `wouldWrite`：false
- 必须含 `recoveryDecision`；`codeOwnedResolverWired:true`；real* false；wouldRecover 等 false
- wiring aggregate `state:'blocked'`；blockers 含 `real-guarded-runner-execution-wiring-missing`

**共用 helper 不得固定（场景不同，只在专属 `it`）：**

- `recoveryDecision.state` / `recoveryReady`
- 上游 decision states
- `policyDecision.state` / `primaryBlocker`（ready path 为 authorized/null；其他 path 为 denied + 具体码）
- no-approval / no-execute / missing-binding 细节

**`gates.operatorRecoveryReady` 语义矩阵（API/CLI）：**

| 条件 | gate fact |
| --- | --- |
| valid manifest + valid runnerBinding（recovery resolve 成功） | **true** — 不论 executeRequested true/false、approval ready/not；**可独立于** registry resolve |
| missing runnerBinding（empty candidates） | **false** |
| invalid manifest/binding | 通道级 400 / CLI exit 1 |

**Ready path 专属断言（合法 install + executeRequested）：**

```js
assert.strictEqual(body.policyDecision.state, 'authorized');
assert.strictEqual(body.policyDecision.authorized, true);
assert.strictEqual(body.policyDecision.wouldAuthorizeExecution, true);
assert.strictEqual(body.policyDecision.primaryBlocker, null);
assert.deepStrictEqual(body.policyDecision.blockers, []);
assert.strictEqual(body.policyDecision.wouldRun, false);
assert.strictEqual(body.policyDecision.wouldWrite, false);
assert.ok(!body.policyDecision.blockers.includes('operator-recovery-not-ready'));
assert.strictEqual(body.executionEligible, false);
assert.strictEqual(body.gates.runnerWiringContractReady, false);
assert.strictEqual(body.gates.realRunnerWiringReady, false);
assert.ok(body.blockers.includes('real-guarded-runner-execution-wiring-missing'));
assert.deepStrictEqual(body.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
```

### 5.2 Web：strict canonical fail-closed assembly

#### 设计原则

Web **不得**仅因 `recoveryEntries.length >= 1`、单字段 contract status、或 `gates.operatorRecoveryReady` 孤值就显示 ready。
**共享单一 canonical predicate**（下称 `canonicalOperatorRecoveryReady`）：wiring line、recovery line、`validationLines.operatorRecoveryReady` **必须**基于同一 boolean。

`WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS` **清空** `operator-recovery` 项（对象可空 `{}`，或删除该固定 map 的最后一项）。**禁止**再“永远 blocked”最后一项。

上游 registry / adapter / anchor / audit 继续使用各自独立 canonical boolean，**不得**混用。

#### 共享单一 canonical predicate（C ∧ A ∧ G ∧ D）

记：

- `C` = `requiredContracts` 中 `id === 'operator-recovery'`
- `A` = `runnerWiringContract.operatorRecoveryReadiness`
- `G` = `gates.operatorRecoveryReady`
- `D` = `payload.recoveryDecision`

```js
function isCanonicalOperatorRecoveryReady({ C, A, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'operator-recovery-ready' &&
    C?.requiredForExecution === true &&
    A?.state === 'ready' &&
    A?.operatorRecoveryReady === true &&
    A?.codeOwnedRecoveryResolverReady === true &&
    A?.realOperatorRecoveryImplementationReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.recoveryReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realOperatorRecoveryImplementationReady === false &&
    D?.wouldRecover === false &&
    D?.wouldRetry === false &&
    D?.wouldNotifyOperator === false &&
    D?.wouldRestartService === false &&
    D?.wouldRestoreState === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false &&
    D?.metadataWriteAllowed === false &&
    D?.filesystemWriteAllowed === false &&
    D?.remoteCommandAllowed === false &&
    D?.operatorNotificationAllowed === false
  );
}
```

任一 missing / invalid / contradictory / side-effect flag true → **false**。

#### Wiring contract lines（operator-recovery）

- **ready 当且仅当** `canonicalOperatorRecoveryReady === true` →
  `wiringContract:operator-recovery:status:ready:requiredForExecution:true:blocker:none`
- **否则固定** →
  `wiringContract:operator-recovery:status:blocked:requiredForExecution:true:blocker:operator-recovery-missing`
  （canonical blocked；**不**回显 payload blocker / secret）

#### Operator-recovery readiness line（同一 boolean）

- **ready 当且仅当** canonical true：

```text
operatorRecovery:code-owned-operator-recovery:state:ready:codeOwnedResolverWired:true:realOperatorRecoveryImplementationReady:false:wouldRecover:false:wouldRestartService:false:wouldRestoreState:false:blocker:none
```

- **否则固定 blocked**（始终恰好一行）：

```text
operatorRecovery:code-owned-operator-recovery:state:blocked:codeOwnedResolverWired:true:realOperatorRecoveryImplementationReady:false:wouldRecover:false:wouldRestartService:false:wouldRestoreState:false:blocker:operator-recovery-not-ready
```

**禁止**继续渲染 `disabled-operator-recovery-stub` / `realImplementationReady` / `operator-recovery-real-implementation-missing` 作为 V1.29 正常路径文案（恶意 payload 注入 stub kind 时仍输出上列 fixed blocked 行）。

#### validationLines（同一 boolean）

- `operatorRecoveryReady:true` **当且仅当** `canonicalOperatorRecoveryReady === true`；否则 false
- **禁止**仅 `gates.operatorRecoveryReady===true` 就渲染 true
- 始终固定 `executionEligible:false`、`realRunnerWiringReady:false`、`runnerWiringContractReady:false`
- 上游 `runnerRegistryReady` / `hostMutationAdapterReady` / `rollbackAnchorReady` / `attemptAuditReady` 继续用各自 canonical

#### 强制 case：C/A/G 表面 ready、D.wouldRecover=true（side-effect 漂移）

- canonical false → wiring blocked + recovery blocked + validation false
- **不得**出现任何 operator-recovery / operatorRecovery **ready** 行
- 敏感/恶意值不回显

#### policyDecision line + executionSentinel line（方案 A；两个 locus）

**Locus 分离（硬约束）：**

| Locus | Web 行前缀 | 表达对象 | ready path | denied / 恶意 |
| --- | --- | --- | --- | --- |
| **policy truth** | `policyDecision:` | JSON pure policy 判定 | authorized + `primaryBlocker:none` | fail-closed denied + allowlisted primary / `unknown` |
| **execution eligibility** | `executionSentinel:` | 真实执行资格 UI sentinel | **恒 blocked** | **恒 blocked** |

**禁止：**

- 把 JSON `authorized` 渲染为 Web `denied`（旧“强制 denied”矛盾；**本版废除**）
- 把 JSON `primaryBlocker:null` 渲染为 policy 行 `primaryBlocker:unknown`（null → **`none`**，仅 authorized path）
- 用 policy denied **伪装** execution 阻塞（execution 阻塞只走 `executionSentinel` + JSON `executionEligible:false`）
- 回显 raw payload 字符串（blocker 仅 allowlist；行格式固定）

**Canonical authorized 谓词（policy truth；conjunction；缺一则 denied）：**

```js
function isCanonicalPolicyDecisionAuthorized(pd) {
  return (
    pd?.state === 'authorized' &&
    pd?.authorized === true &&
    pd?.wouldAuthorizeExecution === true &&
    pd?.primaryBlocker === null &&
    Array.isArray(pd?.blockers) &&
    pd.blockers.length === 0 &&
    pd?.wouldRun === false &&
    pd?.wouldWrite === false
  );
}
```

**`buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines` 定稿行为：**

1. 若 `isCanonicalPolicyDecisionAuthorized(payload.policyDecision)` → **恰好**输出：

```text
policyDecision:state:authorized:authorized:true:wouldAuthorizeExecution:true:primaryBlocker:none
```

2. 否则 → **恰好**输出 fail-closed denied 行：

```text
policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false:primaryBlocker:<allowlisted-or-unknown>
```

其中 `primary = sanitizeAllowlistedExecutionPolicyBlocker(pd?.primaryBlocker) || 'unknown'`（**仅** denied path；authorized path **永不**走该回退）。

3. **同函数或紧邻 builder** 必须 **始终** 另输出固定 execution sentinel（与 policy 状态无关）：

```text
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing
```

**Ready path 两层真相（同真、分 locus；非“双层矛盾”）：**

| 层 | ready path 值 |
| --- | --- |
| API/CLI JSON `policyDecision` | `state:'authorized'` / `primaryBlocker:null` |
| Web `policyDecision:` 行 | `state:authorized` / `primaryBlocker:none` |
| API/CLI/Web JSON `executionEligible` | `false` |
| Web `executionSentinel:` 行 | `state:blocked` / `blocker:real-guarded-runner-execution-wiring-missing` |
| gate `nextBlockers` | `['real-guarded-runner-execution-wiring-missing']` |

#### Web policy / execution 测试矩阵（§5.2 专属；与 pure T1–T28 独立计数）

| ID | Case | policy 行 | executionSentinel 行 |
| --- | --- | --- | --- |
| W1 | JSON pure ready path（canonical authorized） | **authorized** + `primaryBlocker:none` | **恒** blocked + wiring-missing |
| W2 | JSON denied（allowlisted primary，如 `execute-request-missing`） | denied + 该 allowlisted primary | 恒 blocked + wiring-missing |
| W3 | JSON primary 非 allowlist / 缺失 | denied + `primaryBlocker:unknown` | 恒 blocked + wiring-missing |
| W4 | 恶意：`authorized:true` 但 `wouldRun:true` / `wouldWrite:true` / state 非 authorized / primary 非 null | **denied** fail-closed（不得 authorized 行） | 恒 blocked + wiring-missing |
| W5 | 恶意：注入 secret 于 primaryBlocker | denied + `unknown`（**不回显** secret） | 恒 blocked + wiring-missing |
| W6 | payload 缺 `policyDecision` / 非对象 | denied + `unknown` | 恒 blocked + wiring-missing |
| W7 | 任意路径 `requiredFields` | 恰含一行 `policyDecision:` | 恰含一行 `executionSentinel:`；**无**旧“仅 forced-denied、无 sentinel”形态 |

**测试计数（Web policy/sentinel 子矩阵）：** W1–W7 = **7** 条；实现阶段须全部 GREEN，且不得残留断言 `policyDecision:state:denied` 于 authorized ready path。

---

## 6. 版本 / README / Gold

- `LINKE_RELEASE_VERSION = 'V1.29'`
- README 标题、badge、version table：V1.29 当前，V1.28 历史
- Gold evidence 添加：`resolveSupervisorLifecycleGuardedRunnerOperatorRecovery`、`operatorRecoveryReadiness.state:ready`、`operatorRecoveryReady:true`、`codeOwnedRecoveryResolverReady:true`、`codeOwnedResolverWired`、`operator-recovery-ready`、`realOperatorRecoveryImplementationReady:false`、`recoveryDecision`、`readyCount:6`/`blockedCount:0`
- 移除作为 **当前缺口** 的 `operator-recovery-missing` / readiness 主码 `operator-recovery-real-implementation-missing` / `operatorRecoveryReadiness.state:blocked` / `operatorRecoveryReady:false`（历史叙述可保留）
- nextStep 指向：**真实 guarded runner wiring**（`realRunnerWiringReady` / `runnerWiringContractReady` / `real-guarded-runner-execution-wiring-missing`），并明确真实 host mutation / rollback write-restore / attempt audit persist / operator recovery implementation 仍缺失；**不得**写 “next wiring item is operator-recovery”
- Gold 仍 `blocked`；`runnerWiringContractReady:false`；G0a PASS 不变
- 明确叙述：**6/0 pure contracts ready ≠ Gold ready ≠ executionEligible**

---

## 7. 安全与非目标

### 安全

- 全路径无 host mutation / runner dispatch / launchctl / shell / process list / fs write / metadata / audit persist / recovery retry / operator notification / NAS / network
- fixture 禁止：用户名形态绝对路径、SSH 路径形态、具体 IP/CIDR、真实邮箱、真实 command 名、credential 形态、64-hex digest
- 恶意 fixture 仅 opaque synthetic（`UNSAFE_SECRET_MATERIAL`、`OPAQUE_UNSAFE_FIELD`）
- 敏感扫描只报类别计数，不回显匹配行
- 输出深拷贝
- caller override 必须忽略

### 非目标

- **不实现真实 operator recovery / retry / notify / runbook / restart / restore**
- **不实现真实 host mutation / rollback write-restore / attempt audit persist**（遗留）
- 不调度/调用 runner
- 不把 `executionEligible` / `runnerWiringContractReady` / `realRunnerWiringReady` / Gold 变 ready/true
- 不设 `realOperatorRecoveryImplementationReady:true` 或任一 would*/\*Allowed true
- 不扩展 `POLICY_FACT_KEYS` / 不把 `real-guarded-runner-execution-wiring-missing` 塞进 policy vocabulary 伪装 deny
- **不**解除 Web `executionSentinel` 恒 blocked 边界（真实 wiring 完成前）
- **不**把 policy 行伪装 denied 以代替 execution sentinel
- 不声称可证明拒绝所有 Proxy
- 不改 V1.24–V1.28 public 契约（含 evaluator 算法；Web 展示从“强制 denied”迁移为方案 A 双 locus，属 V1.29 定稿）
- 不修改 `src/agent.js` / `src/server.js` / `package.json`
- 不新增 endpoint / CLI command / Web button / request field

### 下一步（显式非本版）

1. **真实 guarded runner host wiring**（使 `realRunnerWiringReady` / 最终 `runnerWiringContractReady` 可诚实讨论；移除或满足 `real-guarded-runner-execution-wiring-missing`；**届时**才可讨论解除 `executionSentinel` blocked）
2. 真实 host mutation implementation
3. 真实 rollback anchor write/restore
4. 真实 attempt audit persist / immutable log
5. 真实 operator recovery（retry limit / runbook / notify / restart / restore）
6. 独立版本：是否扩展 policy facts 纳入 real-wiring；是否在真实 wiring 证明后调整 execution sentinel 语义
7. 任一真实 side effect 前必须有独立设计；默认 Gold blocked 直到证明完成

---

## 8. Scope 文件列表（基于实际 rg，非猜测）

对以下硬编码/断言模式做了仓库扫描（排除 `node_modules` / `.git` / 本设计 docs）：

`operator-recovery-missing`、`operator-recovery-real-implementation-missing`、`disabled-operator-recovery-stub`、`operatorRecoveryReady:false`（gate hardcode）、`realOperatorRecoveryReady`、`readyCount:5`+`blockedCount:1`、`operator-recovery-not-ready`（ready-path primary）、Web `operatorRecovery:` / `wiringContract:operator-recovery` 行、version/README/Gold V1.28 当前标记。

### 允许修改（实现阶段）— 仅下列文件

| 文件 | 原因（rg 命中） |
| --- | --- |
| `src/supervisor-lifecycle.js` | resolver/readiness/wiring/gate 实现与常量 |
| `src/web/app.js` | wiring/recovery lines + validationLines + canonical predicate |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | pure/gate/readiness/wiring 断言 |
| `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` | API 透传断言 |
| `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` | CLI JSON 断言（**不改** `src/agent.js`） |
| `test/web-console.test.js` | Web assembly / 恶意 payload |
| `src/version.js` | `V1.29` |
| `README.md` | 版本叙述 |
| `src/gold-readiness.js` | scorecard evidence / nextStep |
| `test/version.test.js` | 版本期望 |
| `test/gold-readiness.test.js` | Gold 期望 |
| `test/readme.test.js` | README 期望 |

### 明确禁止

- `src/agent.js`、`src/server.js`、`package.json` / lockfiles
- 任何新 endpoint / CLI command / Web button / request body field
- 设计阶段：除本 spec 与对应 plan 外不改生产源码/测试

**兜底：** 实现完成后跑全量 `npm test`；若发现未列入文件因间接断言失败，**先停**并仅把 **rg 证实需要** 的文件补入允许列表（不得凭猜测扩大）。

---

## 9. 验证命令与无写入核对

### Focused

```bash
node --check src/supervisor-lifecycle.js
node --check src/web/app.js
git diff --check
node --test --test-reporter=spec \
  test/supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js \
  test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/web-console.test.js
node --test --test-reporter=spec \
  test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

### Full regression

```bash
npm test
```

### Side-effect scan（实现差分相对 a088630）

```bash
git diff a088630 -- src/supervisor-lifecycle.js | rg -n \
  'launchctl|child_process|execSync|spawn\(|exec\(|fs\.(write|rm|unlink|mkdir)|process\.kill|net\.|http\.|https\.|appendAuditEvent' \
  && echo 'FAIL: side-effect call pattern in diff' || echo 'ok: no side-effect pattern in lifecycle diff'
```

### Sensitive category count only

```bash
git diff a088630 -- src/ test/ | rg -c \
  'ssh-rsa|BEGIN (RSA |OPENSSH )?PRIVATE|AKIA[0-9A-Z]{16}|[0-9a-f]{64}' \
  || true
# 期望：无命中；若有命中只报告 count，不得 cat 原文
```

### Scope / anchor 核对（无写入；不要 hard reset）

```bash
git merge-base --is-ancestor a088630 HEAD && echo 'anchor-ok'
git rev-parse HEAD
git diff --name-only a088630 --
git status --short
git diff --name-only a088630 -- src/agent.js src/server.js package.json
# 期望：禁止文件无输出
```

允许修改文件名必须 ⊆ §8 列表。

---

## 10. 完成标准（实现阶段验收）

1. pure resolver 全矩阵 GREEN（T1–T28）；all-or-nothing（unresolved 时 `unresolvedCount` 恒 0，**不**统计 action 失败数；决策状态由 `state`/`primaryBlocker` 表达）；深拷贝；稳定 blocker 序。
2. readiness fixed ready + entry exact；`codeOwnedRecoveryResolverReady:true`（readiness）与 `codeOwnedResolverWired:true`（decision 来源路径标识）语义分离；catalog-level `recoveryKind:'code-owned-operator-recovery'` ≠ action-level kinds；旧键不残留。
3. wiring `readyCount:6` / `blockedCount:0`；六个 required contracts 全 ready；aggregate 仍 `state:'blocked'` + `real-guarded-runner-execution-wiring-missing`。
4. production gate ready path：`gates.operatorRecoveryReady:true`，`recoveryDecision` resolved，**`policyDecision` authorized / primary null**，**不含** `operator-recovery-not-ready`，`executionEligible:false`，`runnerWiringContractReady:false`，`realRunnerWiringReady:false`，gate nextBlockers 仍为 `real-guarded-runner-execution-wiring-missing`。
5. API/CLI/Web 透传与 C∧A∧G∧D 一致；恶意 side-effect drift fail-closed；Web 替换 operator recovery lines 本体及旧 stub 文案；**Web 方案 A：** policy truth 与 execution sentinel 双 locus（W1–W7）；ready path policy 行 authorized + `primaryBlocker:none`；`executionSentinel` 恒 blocked；**无**“Web 强制 denied/unknown 伪装 authorized”残留。
6. version/README/Gold → V1.29；Gold 仍 blocked；G0a PASS 不变；nextStep 指向真实 wiring 而非 operator-recovery。
7. 无 fs/network/process/shell/launchctl/appendAuditEvent 副作用；禁止文件未改。
8. **不**宣称 `runnerWiringContractReady:true`、`realRunnerWiringReady:true`、`executionEligible:true` 或 Gold ready。
9. **不**制造 “6/0 + operatorRecoveryReady true 仍以 operator-recovery-not-ready 为 policy primary” 的矛盾。
10. **不**制造 “JSON authorized/null 但 Web policy 行 denied/unknown” 的双重真相矛盾。
