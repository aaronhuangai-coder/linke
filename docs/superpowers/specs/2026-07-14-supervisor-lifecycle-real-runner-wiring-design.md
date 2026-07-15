# V1.30 Supervisor Lifecycle Real Guarded Runner Wiring Orchestrator Design

## 目标

V1.30 在 **V1.29 已完成 6/0 pure required contracts** 的基线上，交付下一最小、诚实、可验证的 **real guarded runner wiring** 阶段：

> **code-owned pure fail-closed real-wiring orchestrator / plan / seal contract**

它把 production-derived 的六个 pure decision（policy/registry/adapter/anchor/audit/recovery）与 gate 结构事实，**纯函数合成**为一个可审计的 **wiring plan + wiring plan seal**，证明“真实 host 执行前的编排表面”已存在且 fail-closed。

`wiringPlanSeal` 是 **plan-only seal**：**NOT** execution receipt、**NOT** persisted audit、**NOT** side-effect evidence。`pureWiringOrchestratorPlanReady` 是 **pure plan fact**：**不是** policy fact、**不是**真实 wiring、**不能**消解 `real-guarded-runner-execution-wiring-missing`、**不能**抬升 `realRunnerWiringReady`。

### 关键边界（必须先读）

| 层级 | V1.30 是否完成 | 含义 |
| --- | --- | --- |
| **pure wiring orchestrator / plan / seal** | **是** | code-owned 合成 `wiringPlan` + `wiringPlanSeal`；readiness 可 ready；gate 可附 sanitized 对象 |
| **realRunnerWiringReady / runnerWiringContractReady** | **否** | **禁止**因本版变 true；本版是 **wiring proof/contract**，不是 host wiring 完成 |
| **executionEligible / wouldExecute** | **否** | 公式仍要求 real wiring facts；本版恒 false |
| **真实 host 副作用**（launchctl / fs / process / network / metadata / audit write / recovery） | **否** | 本阶段 **禁止** 未经设计证明的真实 host 副作用 |
| **任一 `real*ImplementationReady`** | **否** | V1.25–V1.29 遗留 real 实现字段 **全部保持 false** |
| **Gold 发布** | **否** | scorecard 继续 `blocked` |

**严禁**把 pure orchestrator plan ready、`wiringPlanSeal.state:'seal-ready'`、或 policy `authorized` 冒充：

- `realRunnerWiringReady:true`
- `runnerWiringContractReady:true`
- `executionEligible:true`
- 真实 host runner dispatch
- Gold ready

**恢复锚点：** `d913785`（`feat: add V1.29 operator recovery contract`）。实现越界时回到该 commit 的干净状态再重做（见 §9；**禁止**在 plan/docs 中建议 `git reset --hard` 作为常规步骤）。

---

## 0. Remaining Gold blockers audit（基线 d913785 / V1.29，不得猜）

以下全部来自当前 `src/supervisor-lifecycle.js` / `src/web/app.js` / `src/gold-readiness.js` / `README.md` / 相关 tests，是 V1.30 的硬约束。

### 0.1 六个 pure required contracts 现状（已完成 = 6/0）

| # | contract id | pure API | readiness state | gate local fact（ready path） | real* 字段（仍 false） |
| --- | --- | --- | --- | --- | --- |
| 1 | `execution-policy` | `evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy` | ready | `gates.executionPolicyReady:true` | policy entry `realImplementationReady:true` **仅表示 pure evaluator 存在**，**不**授权 host |
| 2 | `runner-registry` | `resolveSupervisorLifecycleGuardedRunnerRegistry` | ready | `gates.runnerRegistryReady:true` | `realRunnerImplementationsReady` / `realHostRunnerReady` |
| 3 | `host-mutation-adapter` | `resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter` | ready | `gates.hostMutationAdapterReady:true` | `realHostMutationImplementationReady` |
| 4 | `rollback-anchor` | `resolveSupervisorLifecycleGuardedRunnerRollbackAnchor` | ready | `gates.rollbackAnchorReady:true` | `realRollbackAnchorImplementationReady` |
| 5 | `attempt-audit` | `resolveSupervisorLifecycleGuardedRunnerAttemptAudit` | ready | `gates.attemptAuditReady:true` | `realAttemptAuditImplementationReady` |
| 6 | `operator-recovery` | `resolveSupervisorLifecycleGuardedRunnerOperatorRecovery` | ready | `gates.operatorRecoveryReady:true` | `realOperatorRecoveryImplementationReady` |

Wiring aggregate（源码事实）：

```js
// buildSupervisorLifecycleGuardedRunnerWiringContract
readyCount: 6,
blockedCount: 0,
state: 'blocked',                         // 仍 blocked
realRunnerWiringReady: false,
blockers: ['real-guarded-runner-execution-wiring-missing'],
nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
```

**结论：** 6/0 **只**表示 six pure required contracts 已 ready；**不等于** `runnerWiringContractReady` 或 `realRunnerWiringReady`。

### 0.2 精确 locus / 公式（权威）

#### A. `POLICY_FACT_KEYS`（policy 层；不含 real wiring）

```js
// src/supervisor-lifecycle.js — d913785 权威
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
  'operatorRecoveryReady',
]);
```

`evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy`：

1. 任一 fact `!== true` → `state:'denied'`，`primaryBlocker === blockers[0]`（顺序 = `POLICY_FACT_KEYS`）。
2. 全部 true 且 operation allowlisted → `state:'authorized'`、`authorized:true`、`wouldAuthorizeExecution:true`、`primaryBlocker:null`、`blockers:[]`。
3. **任意** decision：`wouldRun` / `wouldWrite` / 全部 `allow*` **恒 false**（authorize ≠ host execute）。

`EXECUTION_POLICY_BLOCKER_CODES` **不含** `real-guarded-runner-execution-wiring-missing`。该码 **仅** gate 顶层 / wiring aggregate / Web `executionSentinel`。

#### B. `executionEligible`（gate 顶层；语义写死，源码现 hardcode `false`）

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
  realRunnerWiringReady &&          // ← 不在 POLICY_FACT_KEYS；V1.30 仍 false
  runnerWiringContractReady         // ← 不在 POLICY_FACT_KEYS；V1.30 仍 false
```

| 字段 | locus | V1.29 现状 | V1.30 |
| --- | --- | --- | --- |
| `executionEligible` | **仅** gate 顶层 | hardcode `false` | **仍 hardcode `false`** |
| `wouldExecute` | gate 顶层 + 各 decision/candidates | hardcode `false` | **仍 false** |
| `gates.realRunnerWiringReady` / 顶层 `realRunnerWiringReady` | gate + wiring | hardcode `false` | **仍 false** |
| `gates.runnerWiringContractReady` | gate | hardcode `false` | **仍 false** |
| `runnerWiringContract.realRunnerWiringReady` | wiring | hardcode `false` | **仍 false** |
| gate `nextBlockers` | gate | `['real-guarded-runner-execution-wiring-missing']` | **不变** |
| wiring aggregate `state` | wiring | `'blocked'` | **不变** |

#### C. 各 `real*ImplementationReady` 与 would*（真实 side-effect 层；全部仍 false）

| 字段 | 唯一合法 locus | V1.30 | 抬升依赖 |
| --- | --- | --- | --- |
| `realRunnerImplementationsReady` / `realHostRunnerReady` | registry readiness / `registryDecision` / entries | false | 真实 host runner 实现 + capability injection |
| `realHostMutationImplementationReady` | adapter readiness / `adapterDecision` / mutation 行 | false | launchctl/fs/process/metadata 真实 adapter |
| `wouldMutateHost` + adapter `*Allowed` | adapter locus only | false | 同上 |
| `realRollbackAnchorImplementationReady` | anchor readiness / `anchorDecision` / anchor 行 | false | 真实 anchor write/restore IO |
| `wouldWriteAnchor` / `wouldRestore` + anchor `*Allowed` | anchor locus only | false | 同上 |
| `realAttemptAuditImplementationReady` | audit readiness / `auditDecision` / audit 行 | false | 真实 persist/log + 不可篡改存储 |
| `wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` + audit `*Allowed` / `immutableAuditReady` | audit locus only | false | 同上 |
| `realOperatorRecoveryImplementationReady` | recovery readiness / `recoveryDecision` / recovery 行 | false | 真实 recover/retry/notify/restart/restore |
| `wouldRecover` / `wouldRetry` / `wouldNotifyOperator` / `wouldRestartService` / `wouldRestoreState` + recovery `*Allowed` | recovery locus only | false | 同上 |
| policy `wouldAuthorizeExecution` | `policyDecision` only | ready path **true** | pure policy 已可 authorize；**≠** execute |
| policy `wouldRun` / `wouldWrite` / 全部 policy `allow*` | `policyDecision` only | **恒 false** | 真实 host execute 授权面（后置） |

#### D. Web 方案 A（policy truth ≠ execution eligibility）

| Locus | 行前缀 | V1.29 / V1.30 ready path |
| --- | --- | --- |
| policy truth | `policyDecision:` | `state:authorized` + `primaryBlocker:none`（与 JSON 同真） |
| execution eligibility sentinel | `executionSentinel:` | **恒** `state:blocked` + `blocker:real-guarded-runner-execution-wiring-missing` |

```text
policyDecision:state:authorized:authorized:true:wouldAuthorizeExecution:true:primaryBlocker:none
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing
```

**禁止**把 policy authorized 误解为 execution ready。`executionSentinel` 保留到 **真实 wiring 完全证明**（`realRunnerWiringReady && runnerWiringContractReady` 均有真实实现证据）为止。

### 0.3 Gold scorecard remaining blockers（d913785 实测）

`buildGoldReadinessReport()` 摘要：`ready:4` / `partial:4` / `blocked:1` / `total:9`，总体 `status:'blocked'`。

| id | status | 与 V1.30 关系 |
| --- | --- | --- |
| `release-readiness` | ready | 无关；保持 |
| `local-backup-restore` | ready | 无关；保持 |
| `fleet-device-management` | ready | 无关；保持 |
| `version-consistency` | ready | 无关；保持 |
| `nas-dry-run` | **partial** | 并行 NAS 轨；本版不碰 |
| `automation-installation` | **partial** | **主轨**：真实 lifecycle apply / launchd 仍缺；nextStep 已指向 real guarded runner host wiring |
| `security-auth` | **partial** | 并行 G5；本版不碰 |
| `real-nas-remote-backup` | **blocked** | 并行 G1；本版不碰 |
| `production-hardening` | **partial** | 并行 ops；本版不碰 |

G0a 真实双机 PASS **不变**，**不得**表述为 Gold 发布条件已满足。

### 0.4 6/0 之后 remaining Gold / execution blockers 与依赖图

```text
[DONE V1.24–V1.29] 6 pure required contracts (readyCount 6 / blockedCount 0)
        │
        │  policy ready path → authorized (primary null)
        │  gate nextBlockers → real-guarded-runner-execution-wiring-missing
        ▼
┌───────────────────────────────────────────────────────────────┐
│ V1.30 (THIS) pure real-wiring orchestrator / plan / seal   │
│  + wiringPlan + wiringPlanSeal + orchestrator readiness        │
│  + pureWiringOrchestratorPlanReady (pure)                     │
│  − realRunnerWiringReady stays false                          │
│  − runnerWiringContractReady stays false                      │
│  − executionEligible stays false                              │
│  − real*ImplementationReady all stay false                    │
│  − no launchctl/fs/process/network                            │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│ NEXT (post-V1.30, 独立版本；需单独设计批准)                      │
│  capability injection interfaces (code-owned, no shell str)   │
│  dry-run mode using injected fakes / sandbox                  │
│  then guarded execute mode with:                              │
│    - real host mutation (launchctl/fs/process)                │
│    - real rollback anchor write/restore                       │
│    - real attempt audit persist/log                           │
│    - real operator recovery                                   │
│    - dual-host + failure-injection tests                      │
│  only then may flip:                                          │
│    real*ImplementationReady / would* / *Allowed (per locus)   │
│    realRunnerWiringReady / runnerWiringContractReady          │
│    and only if formula holds → executionEligible              │
└───────────────────────────────┬───────────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   G4 launchd lifecycle   G1 real NAS          G5 auth/audit
   (automation-install)   (real-nas-remote)    (security-auth)
          │                     │                     │
          └──────────┬──────────┴──────────┬──────────┘
                     ▼                     ▼
              G2/G3 retention/sched   G6 upgrade/monitor
                     └──────────┬──────────┘
                                ▼
                    G7 Gold qualification (9/9)
```

#### Remaining blockers 分类

| 类别 | blocker / fact | 下一步？ | 依赖真实 side effects？ |
| --- | --- | --- | --- |
| **P0 gate primary** | `real-guarded-runner-execution-wiring-missing` | **是（V1.30 开始证明编排，但不消解）** | **消解依赖**真实 host wiring |
| **P0 资格** | `realRunnerWiringReady:false` | 否（V1.30 不抬升） | **是** |
| **P0 资格** | `runnerWiringContractReady:false` | 否（V1.30 不抬升；6/0 ≠ 此字段） | **是**（真实 wiring 证明后） |
| **P0 资格** | `executionEligible:false` | 否 | **是**（公式末两项 + 上游） |
| **P1 real impl** | `realHostMutationImplementationReady:false` + wouldMutateHost / *Allowed | 否 | **是** launchctl/fs/process |
| **P1 real impl** | `realRollbackAnchorImplementationReady:false` + wouldWriteAnchor/wouldRestore | 否 | **是** fs/metadata |
| **P1 real impl** | `realAttemptAuditImplementationReady:false` + wouldPersistAudit/wouldWriteLog | 否 | **是** audit IO |
| **P1 real impl** | `realOperatorRecoveryImplementationReady:false` + wouldRecover/* | 否 | **是** recovery/notify/restart |
| **P1 real impl** | `realRunnerImplementationsReady` / `realHostRunnerReady` | 否 | **是** host runner |
| **P2 Gold parallel** | `real-nas-remote-backup` blocked；`nas-dry-run` partial | 否 | **是** smbfs |
| **P2 Gold parallel** | `security-auth` partial | 否 | Keychain/role/rotation |
| **P2 Gold parallel** | `production-hardening` partial | 否 | 监控/审计链/限流等 |
| **已完成 pure** | 6 contracts ready / policy authorize | — | 否 |

**哪些是下一步、哪些依赖真实 side effects：**

1. **下一步（V1.30）：** pure wiring orchestrator/plan/seal —— **不**依赖真实 side effects；**不能**诚实消解 P0 gate primary。
2. **紧随其后（post-V1.30）：** capability injection + dry-run/execute 边界设计落地 —— dry-run 可先无真实 mutate；execute 与各 `real*ImplementationReady` **依赖**真实 side effects。
3. **Gold 9/9：** 依赖 G0a..G6 + 真实硬件证据；本版不推进。

### 0.5 为什么 V1.30 选 “orchestrator/plan/seal” 而不是直接 real host

| 候选 | 诚实性 | 最小性 | 可验证性 | 判定 |
| --- | --- | --- | --- | --- |
| A. 直接 `realRunnerWiringReady=true` | **不诚实**（无 host 证据） | 表面最小 | 测试只能 hardcode | **拒绝** |
| B. 直接 launchctl/fs 真执行 | 越界（用户禁止未经设计证明的 host 副作用） | 过大 | 需双机/失败注入 | **拒绝（本阶段）** |
| C. pure wiring plan/seal/orchestrator | **诚实**（明确 proof/contract） | **最小** | pure TDD 全覆盖 | **采纳** |
| D. 再做一个 disabled stub | 无新信息；6/0 后无 “missing pure contract” | 空转 | 假推进 | **拒绝** |

**V1.30 答案（问题 2）：**

> **可以且必须**只实现 real runner wiring **orchestrator / plan / seal**，**不**执行 launchctl/fs/process/network。
> 如此 **仍不能**诚实置 `realRunnerWiringReady=true` 或 `runnerWiringContractReady=true`。
> 本版正式定位：**wiring proof/contract**。
> Gold **继续 blocked**；gate primary 仍 `real-guarded-runner-execution-wiring-missing`。
> **下一步（post-V1.30）：** code-owned capability injection + dry-run/execute 边界 + 各 real implementation（需真实 side effects 证据）。

---

## 1. 设计选择总览

| 组件 | V1.29 | V1.30 |
| --- | --- | --- |
| pure contracts | 6/0 ready | **保持 6/0**；不新增第 7 个 requiredContract 冒充 real wiring |
| wiring aggregate `state` | blocked + wiring-missing | **不变** |
| `realRunnerWiringReady` | false | **false** |
| `runnerWiringContractReady` | false | **false** |
| `executionEligible` | false | **false** |
| policy ready path | authorized / primary null | **不变** |
| 新 pure API | — | `buildSupervisorLifecycleGuardedRunnerRealWiringPlan` + `buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal` |
| 新 readiness | — | `buildSupervisorLifecycleGuardedRunnerRealWiringOrchestratorReadiness`（固定 pure ready evidence） |
| gate 新字段 | — | sanitized `wiringPlan` + `wiringPlanSeal` + `gates.pureWiringOrchestratorPlanReady`（本地 pure plan fact boolean） |
| Web | 方案 A 双 locus | **保持**；**必须新增（shall）** **wiringPlan / wiringPlanSeal** 固定行（非 executionSentinel 解除） |
| host 副作用 | 无 | **无** |
| Gold | blocked | **blocked** |

### 为何不把 `runnerWiringContractReady` 绑到 6/0

源码与 V1.17–V1.29 文档一致：

- `readyCount` / `blockedCount` = **requiredContracts 计数**
- `runnerWiringContractReady` = **“真实执行 wiring 是否完备”** 的 gate fact（当前 hardcode false）
- 6/0 **故意** 与 `runnerWiringContractReady` 解耦，防止 pure contract 完成被误读为可执行

V1.30 **继续**该分层：pure orchestrator plan ready ≠ wiring contract ready ≠ real runner wiring ready ≠ execution eligible。

### 字段命名（禁止混淆）

| 名称 | 类型 | V1.30 语义 |
| --- | --- | --- |
| `pureWiringOrchestratorPlanReady`（readiness 级） | **固定** builder 输出 | **pure plan fact** only：pure plan/seal 合同就绪；**不是** policy fact；**不是**真实 wiring；**≠** host ready；**不能**消解 wiring-missing；**不能**抬升 `realRunnerWiringReady` |
| `gates.pureWiringOrchestratorPlanReady` | **动态** pure plan fact | readiness ∧ plan planned ∧ seal-ready ∧ 全 side-effect/real-ready false 的严格本地 boolean（见 §5.1）；**不**入 `POLICY_FACT_KEYS` |
| `wiringPlan.state` | decision-like | `'planned'` \| `'unplanned'`（纯数据） |
| `wiringPlanSeal` / `wiringPlanSeal.state` | plan-only seal | `'seal-ready'` \| `'seal-blocked'`（纯数据）；**NOT** execution receipt、**NOT** persisted audit、**NOT** side-effect evidence |
| `realRunnerWiringReady` | gate + wiring | **恒 false** |
| `runnerWiringContractReady` | gate | **恒 false** |
| `executionEligible` | gate 顶层 | **恒 false** |
| `real*ImplementationReady` | 各 real locus | **全部恒 false** |
| `would*` / `*Allowed`（side-effect） | 各 real locus | **全部恒 false** |
| Web `executionSentinel` | UI | **恒 blocked** |

**禁止**引入会与 `realRunnerWiringReady` 混淆的别名（如 `realWiringReady`、`wiringReady`、`runnerReady`）作为 “可执行” 暗示。
**禁止**把 `wiringPlanSeal` 命名/描述为 execution receipt、audit receipt、persisted proof 或 side-effect evidence。

---

## 2. 纯函数 Real Wiring Plan

### 2.1 导出

```js
/**
 * Build a pure, code-owned, fail-closed real guarded-runner wiring plan
 * from production-derived sanitized decisions and gate structure facts.
 *
 * Ready plan means only that the six pure contracts + structure facts
 * compose into a deterministic orchestrator plan object. It does NOT
 * schedule/dispatch runners; does NOT call launchctl/shell/fs/process/
 * network; does NOT set realRunnerWiringReady, runnerWiringContractReady,
 * executionEligible, any real*ImplementationReady, or any would*/*Allowed
 * side-effect flags true.
 *
 * Returns a deep-copied plain object only — never functions, command
 * strings, paths, hosts, tokens, hashes, or raw Error objects.
 *
 * @param {unknown} input
 * @returns {object}
 */
export function buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input)
```

### 2.2 输入（exact-key plain object only）

仅允许下列 exact keys（多 key / getter / Proxy trap → fail-closed unplanned）：

```js
{
  operation,                    // allowlisted lifecycle operation
  actionCandidates,             // production sanitized candidates array
  policyDecision,               // sanitized policy decision
  registryDecision,             // sanitized registry decision
  adapterDecision,              // sanitized adapter decision
  anchorDecision,               // sanitized anchor decision
  auditDecision,                // sanitized audit decision
  recoveryDecision,             // sanitized recovery decision
  // structure facts — booleans only, production-derived
  lifecyclePlanValid,
  approvalRecordReady,
  manifestReady,
  runnerBindingsReady,
  executionPreviewVerified,
  executeRequested,
  actionCandidatesReady,
  executionPolicyReady,
  runnerRegistryReady,
  hostMutationAdapterReady,
  rollbackAnchorReady,
  attemptAuditReady,
  operatorRecoveryReady,
}
```

**禁止**接受：

- `wiringPlan` / `wiringPlanSeal` / `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` caller override
- request/options/fs/env/manifest/runnerBinding 原样对象
- capability handles、function、command argv、path、host、token

### 2.3 Planned 条件（全部满足）

1. `operation` ∈ allowlisted lifecycle operations
2. `actionCandidates` 通过既有 `areSupervisorLifecycleGuardedRunnerActionCandidatesReady`
3. 六个 decision 均为 **resolved / authorized（policy）** 的 **sanitized** 形态，且各自 real* / would* / *Allowed 副作用位为 false（与 V1.25–V1.29 production ready path 一致）
4. 全部 structure facts `=== true`（与 policy ready path 对齐）
5. 输入无多余 key / 无 trap

任一失败 → `state:'unplanned'` + 单一 allowlisted `primaryBlocker`。

### 2.4 Plan 输出 schema（exact）

**planned：**

```js
{
  command: 'supervisor-lifecycle-guarded-runner-real-wiring-plan',
  state: 'planned',
  operation: '<allowlisted>',
  planReady: true,
  pureWiringOrchestratorPlanReady: true, // pure plan fact only — NOT policy / NOT real wiring
  realRunnerWiringReady: false,          // 恒 false — pure ready 不得抬升
  runnerWiringContractReady: false,      // 恒 false
  executionEligible: false,              // 恒 false（plan 对象可重复该证据；gate 顶层仍 hardcode）
  mode: 'plan-only',                     // 非 dry-run-host / 非 execute
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  networkAllowed: false,
  steps: [ /* deterministic per actionId; identifiers only */ ],
  evidenceCode: 'real-wiring-orchestrator-plan-ready',
  primaryBlocker: null,
  blockers: [],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  safety: executionPreviewSafety(),
}
```

**steps[] 每项（identifiers only）：**

```js
{
  actionId: '<allowlisted actionId>',
  implementationId: '<catalog id or redacted-safe id from candidate>',
  registryRef: 'registry-mapping-ready',
  mutationRef: 'host-mutation-adapter-mutation-ready', // evidence codes only
  anchorRef: 'rollback-anchor-plan-ready',
  auditRef: 'attempt-audit-plan-ready',
  recoveryRef: 'operator-recovery-plan-ready',
  order: <number>,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
}
```

**禁止** steps 含：command string、argv、path、plist 内容、shell、URL、token、hostname、function。

**unplanned：**

```js
{
  command: 'supervisor-lifecycle-guarded-runner-real-wiring-plan',
  state: 'unplanned',
  operation: '<allowlisted-or-unknown>',
  planReady: false,
  pureWiringOrchestratorPlanReady: false,
  realRunnerWiringReady: false,
  runnerWiringContractReady: false,
  executionEligible: false,
  mode: 'plan-only',
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  networkAllowed: false,
  steps: [],
  evidenceCode: null,
  primaryBlocker: '<allowlisted>',
  blockers: ['<allowlisted>'],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  safety: executionPreviewSafety(),
}
```

### 2.5 Plan blocker vocabulary（exact allowlist）

```text
real-wiring-plan-input-invalid
real-wiring-plan-operation-invalid
real-wiring-plan-candidates-not-ready
real-wiring-plan-policy-not-authorized
real-wiring-plan-registry-not-resolved
real-wiring-plan-adapter-not-resolved
real-wiring-plan-anchor-not-resolved
real-wiring-plan-audit-not-resolved
real-wiring-plan-recovery-not-resolved
real-wiring-plan-structure-facts-incomplete
real-wiring-plan-side-effect-flag-invalid
```

**禁止**把 `real-guarded-runner-execution-wiring-missing` 用作 plan primary（该码保留为 **execution/wiring aggregate** 信号，避免与 “plan unplanned” 混淆）。
Plan 的 `nextBlockers` **始终**仍指向 `real-guarded-runner-execution-wiring-missing`（诚实：plan ready 后下一缺口仍是 real wiring）。

---

## 3. 纯函数 Real Wiring Plan Seal

### 3.1 导出

```js
/**
 * Build a pure, code-owned wiring plan seal for a real-wiring plan.
 * Plan seal is a deterministic, in-memory, plan-only seal object.
 * NOT an execution receipt; NOT persisted audit; NOT side-effect evidence.
 * Does NOT persist audit, write logs, dispatch runners, or imply
 * realAttemptAuditImplementationReady / realRunnerWiringReady.
 *
 * @param {unknown} plan
 * @returns {object}
 */
export function buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal(plan)
```

### 3.2 Plan seal 输出 schema（exact）

**seal-ready（仅当 plan.state==='planned' 且 planReady===true 且副作用位全 false）：**

```js
{
  command: 'supervisor-lifecycle-guarded-runner-real-wiring-plan-seal',
  state: 'seal-ready',
  sealReady: true,
  pureWiringOrchestratorPlanReady: true,   // pure plan fact only
  realRunnerWiringReady: false,            // 恒 false — seal 不抬升
  runnerWiringContractReady: false,        // 恒 false
  executionEligible: false,                // 恒 false
  wouldPersistAudit: false,                // NOT persisted audit
  wouldWriteLog: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  stepCount: <number>,
  evidenceCode: 'real-wiring-orchestrator-plan-seal-ready',
  primaryBlocker: null,
  blockers: [],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  safety: executionPreviewSafety(),
}
```

**seal-blocked：** 对应 fail-closed；`sealReady:false`；单一 allowlisted primary（`real-wiring-plan-seal-plan-invalid` 等）。

`wiringPlanSeal` **不是** execution receipt、**不是** persisted audit、**不是** attempt audit 实现；不得设置 `realAttemptAuditImplementationReady`、`immutableAuditReady` 或任何 side-effect would* / *Allowed 为 true。

---

## 4. Readiness helper

```js
export function buildSupervisorLifecycleGuardedRunnerRealWiringOrchestratorReadiness()
```

固定输出（无参）：

```js
{
  command: 'supervisor-lifecycle-guarded-runner-real-wiring-orchestrator-readiness',
  state: 'ready',
  realWiringOrchestratorDefined: true,
  pureWiringOrchestratorPlanReady: true,   // pure plan fact only — NOT policy fact; NOT real wiring
  codeOwnedWiringOrchestratorReady: true,
  realRunnerWiringReady: false,            // 恒 false — cannot elevate real wiring
  readyCount: 1,
  blockedCount: 0,
  entries: [{
    orchestratorKind: 'code-owned-real-wiring-orchestrator',
    state: 'ready',
    codeOwnedResolverWired: true,
    realRunnerWiringReady: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    launchctlAllowed: false,
    filesystemWriteAllowed: false,
    processListReadAllowed: false,
    networkAllowed: false,
    blockerCode: null,
    evidenceCode: 'real-wiring-orchestrator-plan-ready',
  }],
  blockers: [],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'], // pure ready 不消解 wiring-missing
  safety: executionPreviewSafety(),
}
```

**产品级** `codeOwnedWiringOrchestratorReady:true` ≠ **决策路径** `codeOwnedResolverWired:true`（沿用 V1.25–V1.29 分层命名）。

**Readiness exact 断言（实现/plan helper 必须同步）：**

```js
assert.strictEqual(r.state, 'ready');
assert.strictEqual(r.pureWiringOrchestratorPlanReady, true);
assert.strictEqual(r.codeOwnedWiringOrchestratorReady, true);
assert.strictEqual(r.realRunnerWiringReady, false);
assert.strictEqual(r.readyCount, 1);
assert.strictEqual(r.blockedCount, 0);
assert.deepStrictEqual(r.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
assert.strictEqual(r.entries[0].realRunnerWiringReady, false);
assert.strictEqual(r.entries[0].wouldExecute, false);
assert.strictEqual(r.entries[0].wouldRun, false);
assert.strictEqual(r.entries[0].wouldWrite, false);
assert.strictEqual(r.entries[0].launchctlAllowed, false);
assert.strictEqual(r.entries[0].filesystemWriteAllowed, false);
assert.strictEqual(r.entries[0].processListReadAllowed, false);
assert.strictEqual(r.entries[0].networkAllowed, false);
assert.strictEqual(r.entries[0].evidenceCode, 'real-wiring-orchestrator-plan-ready');
```

---

## 5. Execution gate 集成

### 5.1 production-derived only

在 `buildSupervisorLifecycleGuardedRunnerExecutionGate` 内，于既有 policy/registry/adapter/anchor/audit/recovery 解析之后：

1. **忽略** `options.wiringPlan` / `options.wiringPlanSeal` / `options.pureWiringOrchestratorPlanReady` / `options.realRunnerWiringReady` overrides。
2. 用 **本地** decisions + structure booleans 组装 plan input。
3. `wiringPlan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input)`
4. `wiringPlanSeal = buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal(wiringPlan)`
5. 本地 pure plan fact boolean（**完整 conjunction；禁止省略**）。
   `pureWiringOrchestratorPlanReady` **仅**表示 pure plan/seal 合同就绪：
   - **不是** policy fact（**禁止**加入 `POLICY_FACT_KEYS`）
   - **不是**真实 wiring
   - **不能**消解 `real-guarded-runner-execution-wiring-missing`
   - **不能**抬升 `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible`

```js
const pureWiringOrchestratorPlanReady =
  // readiness (pure plan fact surface)
  orchestratorReadiness?.state === 'ready' &&
  orchestratorReadiness?.pureWiringOrchestratorPlanReady === true &&
  orchestratorReadiness?.codeOwnedWiringOrchestratorReady === true &&
  orchestratorReadiness?.realRunnerWiringReady === false &&
  // plan state / evidence
  wiringPlan?.state === 'planned' &&
  wiringPlan?.planReady === true &&
  wiringPlan?.pureWiringOrchestratorPlanReady === true &&
  wiringPlan?.mode === 'plan-only' &&
  wiringPlan?.evidenceCode === 'real-wiring-orchestrator-plan-ready' &&
  wiringPlan?.primaryBlocker === null &&
  // plan real-ready / eligibility (must stay false)
  wiringPlan?.realRunnerWiringReady === false &&
  wiringPlan?.runnerWiringContractReady === false &&
  wiringPlan?.executionEligible === false &&
  // plan side-effect bits (must stay false)
  wiringPlan?.wouldExecute === false &&
  wiringPlan?.wouldRun === false &&
  wiringPlan?.wouldWrite === false &&
  wiringPlan?.launchctlAllowed === false &&
  wiringPlan?.filesystemWriteAllowed === false &&
  wiringPlan?.processListReadAllowed === false &&
  wiringPlan?.networkAllowed === false &&
  // plan seal state / evidence (plan-only seal — NOT execution receipt / NOT persisted audit)
  wiringPlanSeal?.state === 'seal-ready' &&
  wiringPlanSeal?.sealReady === true &&
  wiringPlanSeal?.pureWiringOrchestratorPlanReady === true &&
  wiringPlanSeal?.evidenceCode === 'real-wiring-orchestrator-plan-seal-ready' &&
  wiringPlanSeal?.primaryBlocker === null &&
  // seal real-ready / eligibility (must stay false)
  wiringPlanSeal?.realRunnerWiringReady === false &&
  wiringPlanSeal?.runnerWiringContractReady === false &&
  wiringPlanSeal?.executionEligible === false &&
  // seal side-effect bits (must stay false; NOT side-effect evidence)
  wiringPlanSeal?.wouldPersistAudit === false &&
  wiringPlanSeal?.wouldWriteLog === false &&
  wiringPlanSeal?.wouldExecute === false &&
  wiringPlanSeal?.wouldRun === false &&
  wiringPlanSeal?.wouldWrite === false;
```

6. 附加到 gate 输出：`wiringPlan`、`wiringPlanSeal`、`gates.pureWiringOrchestratorPlanReady`。
7. **仍 hardcode：**

```js
executionEligible: false,
wouldExecute: false,
realRunnerWiringReady: false,
gates.realRunnerWiringReady: false,
gates.runnerWiringContractReady: false,
nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
// blockers 集合仍含 real-guarded-runner-execution-wiring-missing
// pureWiringOrchestratorPlanReady:true 不得移除或替换上述 wiring-missing
```

8. **不**把 `pureWiringOrchestratorPlanReady` 加入 `POLICY_FACT_KEYS`（它是 pure plan fact，**不是** policy fact；避免 policy vocabulary 扩张伪装；policy 已可 authorize）。
9. **不**修改六个 pure requiredContracts 的 status/计数。
10. wiring aggregate **可**附带 `realWiringOrchestratorReadiness` 子对象，但：
    - `state` 仍 `'blocked'`
    - `realRunnerWiringReady` 仍 false
    - `blockers` 仍含 wiring-missing
    - pure plan ready **不得**改写 aggregate 为 ready

### 5.2 诚实性：plan ready 与 wiring-missing 并存

| 场景 | `gates.pureWiringOrchestratorPlanReady` | `policyDecision` | `realRunnerWiringReady` | `executionEligible` | `nextBlockers[0]` |
| --- | --- | --- | --- | --- | --- |
| production ready + executeRequested | **true** | authorized / null | **false** | **false** | `real-guarded-runner-execution-wiring-missing` |
| executeRequested false | false（structure 缺 execute → plan unplanned / fact false） | denied `execute-request-missing` | false | false | wiring-missing（及上游 blockers） |
| empty candidates | false | deny not-ready 族 | false | false | wiring-missing |
| 恶意 would* true 输入 | false | deny / unplanned | false | false | wiring-missing |

**禁止矛盾：**

> ❌ pure plan ready / seal-ready **同时** `realRunnerWiringReady:true`
> ❌ pure plan ready **消解** `real-guarded-runner-execution-wiring-missing`
> ❌ pure plan ready **抬升** `runnerWiringContractReady` 或 `executionEligible`
> ❌ policy authorized **且** Web 去掉 `executionSentinel`
> ❌ 把 `wiringPlanSeal` 当作 execution receipt / persisted audit / side-effect evidence

---

## 6. 若未来要置某个 real fact true（本版不实现；设计约束预声明）

问题 3 的强制契约——**任何** post-V1.30 版本若要把下列任一字段置 true，必须先满足；V1.30 **只**预留接口形状，**不**落地真实 capability：

| 目标 fact | 必备 |
| --- | --- |
| `realHostMutationImplementationReady` | code-owned `HostMutationCapability` 接口；注入而非 shell 字符串；dry-run/execute 边界；idempotency；rollback/audit/recovery 钩子；秘密保护；双机 + 失败注入测试 |
| `realRollbackAnchorImplementationReady` | code-owned anchor store capability；原子 write/restore；校验 digest；无 path 穿越；失败补偿 |
| `realAttemptAuditImplementationReady` | code-owned audit sink；append-only / 摘要链；无 secret 回显；与 attempt id 关联 |
| `realOperatorRecoveryImplementationReady` | code-owned recovery runner；retry 上限；通知通道注入；无自动无限重启 |
| `realRunnerWiringReady` | 上述（及 registry real host runner）**真实证据** + orchestrator **execute mode** 在注入 capability 下可证明；仍 fail-closed |
| `runnerWiringContractReady` | wiring aggregate 与 gate 对 real wiring 的 **完整证明谓词**（不得仅 6/0 或 plan ready） |
| `executionEligible` | 完整公式全部 true，含上两项 |

**一律禁止：**

- 直接 `child_process` shell 字符串拼接
- caller / request / CLI override 任意 `*Ready` / decision / capability
- 无 dry-run 的 execute
- 无 audit receipt 的 host mutate
- 无 rollback anchor 的 destructive unload/remove

V1.30 `wiringPlan.mode` 固定 `'plan-only'`。未来模式枚举预留（本版 **不** 启用）：

```text
plan-only → dry-run-injected → execute-injected
```

---

## 7. Policy / Web / API / CLI 语义

### 7.1 Policy

- **不**扩展 `POLICY_FACT_KEYS`。
- ready path 继续 **authorized** / `primaryBlocker:null`。
- **authorize ≠ execution ready** 继续由 `executionEligible:false` + wiring-missing + Web `executionSentinel` 表达。
- **禁止**为了 “policy 看起来仍 blocked” 而把 wiring-missing 塞进 policy vocabulary。

### 7.2 API / CLI

- **不**新增 endpoint、CLI command、request body 字段。
- 既有 gate 透传 JSON 自然包含 `wiringPlan` / `wiringPlanSeal` / `gates.pureWiringOrchestratorPlanReady`。
- 继续拒绝 apply / approval override / dataDir client override（API）等既有边界。
- 参数化测试 helper 仅扩展 assertion，不改 `src/agent.js` / `src/server.js`。

### 7.3 Web（方案 A 保持 + wiring plan/seal 行 **必须新增 / shall**）

**必须保持：**

```text
policyDecision:state:authorized:authorized:true:wouldAuthorizeExecution:true:primaryBlocker:none   # ready path
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing
```

**必须新增（shall）** wiring plan / plan-seal 固定行（固定格式、canonical、不回显 raw；与 T12 一致）：

```text
wiringPlan:state:planned:planReady:true:realRunnerWiringReady:false:mode:plan-only:blocker:none
wiringPlanSeal:state:seal-ready:sealReady:true:realRunnerWiringReady:false:blocker:none
```

blocked / unplanned / seal-blocked path 必须渲染对应 blocked 行（仍含 `realRunnerWiringReady:false`）。`validationLines` **必须**含：

```text
pureWiringOrchestratorPlanReady:true|false
realRunnerWiringReady:false
runnerWiringContractReady:false
executionEligible:false
```

**禁止**因 pure plan ready 删除或改写 `executionSentinel`。
**禁止**把 `wiringPlanSeal` Web 行描述为 execution receipt 或 audit 落盘证据。

### 7.4 executionSentinel 保留条件

`executionSentinel` **直到**同时满足以下 **真实实现证据** 才允许重新设计（独立版本，非 V1.30）：

1. `realRunnerWiringReady===true` 有 capability + dual-host/failure-injection 证据
2. `runnerWiringContractReady===true` 有 code-owned 谓词（非 hardcode true）
3. 各执行路径 `real*ImplementationReady` 与 dry-run/execute 边界已证明
4. 用户/PM 明确批准解除 sentinel

V1.30：**sentinel 不变**。

---

## 8. Scope（实现阶段；本设计阶段不改源码）

### 8.1 允许修改（实现阶段）

| 文件 | 变更 |
| --- | --- |
| `src/supervisor-lifecycle.js` | plan / plan-seal / readiness pure API + gate 集成 |
| `src/web/app.js` | view model 固定行 / validationLines（无新 button） |
| `src/gold-readiness.js` | evidence + nextStep 指向 V1.30 proof/contract 与下一步 real host wiring |
| `src/version.js` / 版本常量 | → `V1.30`（若项目惯例） |
| `README.md` | 版本条 + 边界 |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | pure + gate TDD |
| `test/web-console.test.js` | wiring 行 + sentinel 保持 |
| `test/gold-readiness.test.js` | evidence / nextStep |
| 既有 gate API/CLI 透传测试（若断言完整 JSON shape） | 仅断言扩展 |

### 8.2 明确禁止（除非 rg 证明不可避免 + 单独 PM 批准 scope 扩张）

| 文件 / 行为 | 状态 |
| --- | --- |
| `src/agent.js` | **禁止改** |
| `src/server.js` | **禁止改** |
| `package.json` / lockfiles | **禁止改** |
| 新增 endpoint / CLI command / Web button | **禁止** |
| launchctl / shell / fs write / process list / network / NAS / backup / restore | **禁止** |
| 置 `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` / 任一 `real*ImplementationReady` / 任一 side-effect would* / *Allowed 为 true | **禁止** |
| 消解 `real-guarded-runner-execution-wiring-missing` | **禁止** |

**rg 预检（设计阶段已核对）：** gate / wiring / policy / Web view model 均在 `supervisor-lifecycle.js` + `web/app.js` + tests + gold/README/version 可闭环；**无**不可避免的 agent/server/package 依赖。

### 8.3 本设计/计划阶段允许写入

仅：

- `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-real-runner-wiring-design.md`
- `docs/superpowers/plans/2026-07-14-supervisor-lifecycle-real-runner-wiring.md`

---

## 9. TDD 矩阵（实现阶段）

| # | 场景 | 期望 |
| --- | --- | --- |
| T1 | pure plan：合法 production-shaped input | `state:planned`，`planReady:true`，`realRunnerWiringReady:false`，`nextBlockers` 含 wiring-missing |
| T2 | pure plan：缺 structure fact / empty candidates / unauthorized policy | `unplanned` + allowlisted primary |
| T3 | pure plan：side-effect flag true 输入 | fail-closed unplanned |
| T4 | pure plan：多余 key / Proxy / getter | fail-closed |
| T5 | pure plan seal：planned plan | `seal-ready`，不抬升 real wiring；NOT execution receipt / NOT persisted audit |
| T6 | pure plan seal：unplanned plan | `seal-blocked` |
| T7 | readiness builder | fixed ready + `pureWiringOrchestratorPlanReady:true` + `realRunnerWiringReady:false` + nextBlockers wiring-missing（exact 断言见 §4） |
| T8 | gate production ready + executeRequested | `gates.pureWiringOrchestratorPlanReady:true`（完整 §5.1 conjunction），policy authorized，`executionEligible:false`，`realRunnerWiringReady:false`，`runnerWiringContractReady:false`，`nextBlockers` wiring-missing |
| T9 | gate 无 executeRequested | plan 不 ready 或 structure 不全；policy deny execute-request-missing；execution 仍 blocked |
| T10 | gate options override wiringPlan / wiringPlanSeal / pureWiringOrchestratorPlanReady / Ready | **忽略** override |
| T11 | wiring 6/0 保持；aggregate state blocked | readyCount 6 / blockedCount 0 / state blocked |
| T12 | Web ready path | policy authorized 行 + **executionSentinel blocked** + **必须（shall）** wiringPlan / wiringPlanSeal 行 |
| T13 | Web 恶意 payload | fail-closed；不回显 secret；sentinel 仍 blocked |
| T14 | Gold | overall blocked；automation evidence 含 V1.30 plan/seal 与 false wiring facts |
| T15 | 敏感扫描 | category counts only；无 token/path 泄漏 |
| T16 | 差分无 host API | 相对 d913785 无 launchctl/child_process/fs.write 新增调用 |

---

## 10. 验证命令与恢复锚点

### Focused（实现阶段）

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
node --test test/web-console.test.js
node --test test/gold-readiness.test.js
# 以及既有 gate API/CLI 透传相关测试（若 shape 断言失败则修测试，不改 agent/server）
```

### Full regression

```bash
node --test
```

### Side-effect / sensitive scan（相对 d913785）

- 仅报告 category hit counts
- 断言无新增 host mutation 调用路径
- scope 仅允许 §8.1 文件

### 恢复锚点

- **commit：** `d913785`
- **信息：** `feat: add V1.29 operator recovery contract`
- 越界时：丢弃工作区改动，回到该锚点干净树后按 plan 重做
- **禁止**把 `git reset --hard` 写进常规实施步骤清单

---

## 11. 安全与非目标

### 安全

- 无 secret / token / Authorization / path / URL / hostname / username / pid / hash 回显
- 恶意 fixture 仅 opaque synthetic 字符串
- 深拷贝输出；抗 prototype pollution / getter trap
- 不读 env 作为执行开关以抬升 real wiring

### 非目标（V1.30）

- 真实 launchctl / fs / process / network / NAS
- `realRunnerWiringReady=true` / `runnerWiringContractReady=true` / `executionEligible=true`
- 任一 `real*ImplementationReady=true` 或 side-effect would* / *Allowed
- 消解 `real-guarded-runner-execution-wiring-missing`
- 新增 endpoint / CLI / Web button
- 修改 agent.js / server.js / package.json
- Gold ready 声明
- G0a 报告改写

### 下一步（显式非本版）

1. **V1.31+（建议）：** code-owned capability injection 接口（HostMutation / Anchor / Audit / Recovery / Runner）+ dry-run-injected 模式（仍默认无真实 mutate，或仅 sandbox 观测）。
2. **其后：** execute-injected + 双机 / 失败注入 / idempotency / rollback / 秘密保护 全证明后，才可抬升对应 `real*ImplementationReady`。
3. **再后：** 谓词化 `realRunnerWiringReady` 与 `runnerWiringContractReady`（禁止 hardcode true）。
4. **并行 Gold：** NAS / auth / hardening / G4–G7。

---

## 12. 完成标准（实现阶段验收）

1. pure plan / plan-seal / readiness API 存在且 fail-closed；`wiringPlanSeal` 明确为 plan-only seal（NOT execution receipt / NOT persisted audit / NOT side-effect evidence）。
2. production gate ready path：`gates.pureWiringOrchestratorPlanReady:true`（满足 §5.1 **完整** conjunction），附带 sanitized `wiringPlan`/`wiringPlanSeal`。
3. `pureWiringOrchestratorPlanReady` 仅为 **pure plan fact**（非 policy fact、非真实 wiring），**不能**消解 wiring-missing，**不能**抬升 `realRunnerWiringReady`。
4. **同时** `realRunnerWiringReady:false`、`runnerWiringContractReady:false`、`executionEligible:false`、`wouldExecute:false`。
5. gate + wiring `nextBlockers` / blockers 仍含 `real-guarded-runner-execution-wiring-missing`。
6. wiring `readyCount:6` / `blockedCount:0` / aggregate `state:'blocked'`。
7. 全部 `real*ImplementationReady` 与 side-effect would* / *Allowed 仍 false。
8. policy ready path 仍 authorized；Web 方案 A：policy 行 authorized + **executionSentinel 恒 blocked** + **必须（shall）** wiringPlan / wiringPlanSeal 行。
9. 无 agent.js / server.js / package.json 变更。
10. 无 host 副作用调用。
11. Gold overall **blocked**；README 标明 V1.30 为 wiring proof/contract。
12. 恢复锚点 `d913785` 文档化。
13. **不**宣称 Gold 发布或 real runner wiring 完成。

---

## 13. 问题对照表（设计必须回答）

| # | 问题 | 答案 |
| --- | --- | --- |
| 1 | 各 fact 精确 locus/公式；下一步 vs side-effect | §0.2–0.4 |
| 2 | 能否只做 orchestrator/plan/seal；能否置 realRunnerWiringReady | **能做**；**不能**诚实置 true；本版 proof/contract；Gold blocked；下一步 capability+real impl |
| 3 | 置 real fact true 的强制接口/注入/dry-run/idempotency/… | §6（本版不落地） |
| 4 | policy/Web/API/CLI；sentinel | §7 |
| 5 | scope、TDD、扫描、锚点 d913785；不改 agent/server/package | §8–10 |
