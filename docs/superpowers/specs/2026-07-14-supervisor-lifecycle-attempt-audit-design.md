# V1.28 Supervisor Lifecycle Attempt Audit Design

## 目标

V1.28 用 **code-owned、纯函数、fail-closed、受限（restricted）attempt-audit pure data resolver / readiness contract** 替换 V1.21 的 disabled attempt audit stub。本版本把 `attempt-audit` required contract 从 `blocked/false` 推进为 `ready/true`，并在 execution gate 内基于 **production-derived sanitized `actionCandidates` + allowlisted `operation`** 调用 pure resolver，返回 sanitized `auditDecision`，把 policy context 的 `attemptAuditReady` fact 接成严格验证后的本地 boolean。

本版完成的是 **纯数据 attempt-audit 计划校验（pure data attempt-audit plan validation）**：只核验 action 集合是否能映射到 code-owned 固定 `auditKind` 标识符表。它 **不** 持久化审计事件、**不** 写 `events.jsonl` / log / metadata、**不** 调用既有 `appendAuditEvent`、**不** 触发 host mutation 或 rollback write/restore。

### 关键边界（必须先读）

| 层级 | V1.28 是否完成 | 含义 |
| --- | --- | --- |
| **restricted attempt-audit contract / readiness** | **是** | code-owned action→auditKind 映射可核验；readiness/contract ready；gate 可在合法 candidates 上得到 `attemptAuditReady:true` |
| **real attempt audit persist / log write / immutable audit** | **否** | 不写 filesystem/metadata/audit/log；不调用 appendAuditEvent；不连接 NAS/network；`realAttemptAuditImplementationReady` 恒 false；`wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` / 全部 `*Allowed` / `immutableAuditReady` 恒 false |
| **real host mutation implementation（V1.26 遗留）** | **否** | V1.26 的 `realHostMutationImplementationReady:false` **不** 因本版变 true |
| **real rollback anchor write / restore（V1.27 遗留）** | **否** | V1.27 的 `realRollbackAnchorImplementationReady:false` / `wouldWriteAnchor` / `wouldRestore` **不** 因本版变 true |

**不得**把 pure data attempt-audit plan / readiness ready 冒充持久化审计、真实 log write、真实 execution 或 host side effect。下一步仍需 operator-recovery，以及后续独立的真实 attempt audit persist / real host mutation / real rollback write-restore。**Gold 继续 blocked。** **不得提前宣称** `runnerWiringContractReady:true` 或 Gold ready。

V1.28 **必须继续保持**：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`（**禁止**因本版变 true）
- `realRunnerWiringReady:false`
- 最后一项 wiring fact false（operatorRecovery）
- gate 顶层：`executionEligible:false`、`executorReady:false`、`wouldExecute:false`（**gate 顶层没有** `wouldRun` / `wouldWrite` / `wouldPersistAudit` / `wouldWriteLog`）
- 副作用 would* 在其真实 locus 恒 false：`policyDecision.wouldRun/wouldWrite`、`registryDecision` would*、`adapterDecision` would* / `wouldMutateHost` / 全部 adapter `*Allowed`、`anchorDecision` would* / `wouldWriteAnchor` / `wouldRestore` / 全部 anchor `*Allowed`、`auditDecision` would* / `wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` / 全部 audit `*Allowed` / `immutableAuditReady`、`actionCandidates[]` 每项 would*、readiness entry / audit 行 would*
- `realHostMutationImplementationReady:false`（V1.26 字段，本版不抬升）
- `realRollbackAnchorImplementationReady:false`（V1.27 字段，本版不抬升）
- `real-guarded-runner-execution-wiring-missing`
- Gold readiness: `blocked`
- G0a 真实双机 PASS 声明不变

V1.28 **必须改变**：

- `attemptAuditReady:true`（readiness 固定 true；production gate fact 仅在 resolver 对 production candidates 解析成功时为 true）
- `attemptAuditReadiness.state:'ready'` + `codeOwnedAuditResolverReady:true` + `realAttemptAuditImplementationReady:false`
- `runnerWiringContract.requiredContracts[4]`（`attempt-audit`）→ `status:'ready'`、`blockerCode:null`、`evidenceCode:'attempt-audit-ready'`
- `runnerWiringContract.readyCount:5`、`blockedCount:1`
- production gate 返回 sanitized `auditDecision`；`attemptAuditReady` 为本地 boolean
- 最后一项 wiring 仍 false → production `policyDecision` **始终 deny**；各 locus 副作用字段全 false
- ready production path primaryBlocker 从 V1.27 的 `attempt-audit-not-ready` **迁移为** `operator-recovery-not-ready`

**不得**调度/调用 runner；不得 host shell / process-control / fs / metadata / audit / approval / 真实 rollback write/restore / NAS / 网络副作用。不新增 endpoint、CLI command、Web button、request body field。**禁止修改** `src/agent.js` / `src/server.js` / `package.json`。不得接受 request/CLI/Web 直传的 `auditDecision` / `auditContext` / `attemptAuditReady` override。

**恢复锚点：** `b42f57c`（`feat: add V1.27 rollback anchor contract`）。实现越界时回到该 commit 的干净状态再重做（见 §9 无写入核对；**禁止**在 plan/docs 中建议 `git reset --hard` 作为常规步骤）。

### 副作用 / 资格字段 locus（禁止“全部对象都有全部字段”误读）

| 字段 | 所在对象（唯一合法 locus） | V1.28 |
| --- | --- | --- |
| `executionEligible` | **仅** gate 顶层 | 恒 `false` |
| `wouldExecute` | gate 顶层；**另**见于 `registryDecision`、`adapterDecision`、`anchorDecision`、`auditDecision`、`actionCandidates[]`、readiness entry、audit 行 | 恒 `false` |
| `wouldRun` / `wouldWrite` | **不在** gate 顶层；见于 `policyDecision`、`registryDecision`、`adapterDecision`、`anchorDecision`、`auditDecision`、`actionCandidates[]`、readiness entry、audit 行 | 恒 `false` |
| `wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` | **仅** `auditDecision`、audit readiness entry、audit 行 | 恒 `false` |
| `auditWriteAllowed` / `metadataWriteAllowed` / `filesystemWriteAllowed` / `immutableAuditReady` | **仅** `auditDecision`、entry、audit 行 | 恒 `false` |
| `wouldMutateHost` / adapter `*Allowed` | **仅** `adapterDecision` 等 V1.26 locus | 保持 V1.26 恒 `false`（本版不改语义） |
| `wouldWriteAnchor` / `wouldRestore` / anchor `*Allowed` | **仅** `anchorDecision` 等 V1.27 locus | 保持 V1.27 恒 `false`（本版不改语义） |
| `gates.attemptAuditReady` | `gates` 对象 | production resolve 成功时 true；否则 false |
| `attemptAuditReady`（readiness 级） | `attemptAuditReadiness` / readiness builder | 固定 true（≠ gate fact） |
| `gates.rollbackAnchorReady` | `gates` 对象 | **保持 V1.27 语义**（不回退） |
| `gates.hostMutationAdapterReady` | `gates` 对象 | **保持 V1.26 语义**（不回退） |
| `gates.runnerRegistryReady` | `gates` 对象 | **保持 V1.25 语义**（不回退） |
| `gates.runnerWiringContractReady` | `gates` 对象 | **恒 false**（本版禁止抬升） |

**禁止**断言 `result.wouldRun` / `result.wouldWrite` / `result.wouldPersistAudit` / `result.wouldWriteLog`（gate 顶层不存在这些字段）。断言 must 按上表 locus 精确落点。

---

## 设计选择总览

| 组件 | V1.21 / V1.27 | V1.28 |
| --- | --- | --- |
| audit catalog | disabled stub | code-owned 固定 actionId→auditKind 受限映射表 |
| resolver | 无 | 公开 pure `resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, operation)` |
| readiness | disabled, ready=false | fixed ready evidence, ready=true |
| required contract `attempt-audit` | blocked + missing | ready + `blockerCode:null` + `evidenceCode:'attempt-audit-ready'` |
| wiring readyCount / blockedCount | 4 / 2 | **5 / 1** |
| gate `attemptAuditReady` | hardcoded false | readiness + production-derived resolver 本地 boolean |
| gate `auditDecision` | 无 | production candidates → resolver → sanitized decision |
| `realAttemptAuditImplementationReady` | false（旧名 `realAttemptAuditReady`） | **仍 false**（无真实 persist/log） |
| decision 字段名 | — | `codeOwnedResolverWired:true`（见 §2.3；≠ readiness 字段） |
| production policy primary | `attempt-audit-not-ready` | **`operator-recovery-not-ready`**（合法 ready path） |
| gate 顶层 `executionEligible` / `wouldExecute` / Gold / `runnerWiringContractReady` | false / blocked / false | **不变** |

### 为何本版把 required contract 置 ready（而不是只加 resolver 不改 contract）

与 V1.25 `runner-registry` / V1.26 `host-mutation-adapter` / V1.27 `rollback-anchor` 对称：required contract ready **仅**表示 **code-owned restricted pure data attempt-audit contract/readiness 已接线且可核验**，**不**表示真实 audit persist、log write 或 host side effect 可执行。若只加 pure resolver 而 contract 仍 blocked，则 wiring 计数/primary blocker 无法前进，且与 V1.24–V1.27 的“contract ready = code-owned pure contract ready”语义不一致。

真实 attempt audit implementation 用 **独立字段** 表达并恒 false：

- readiness：`realAttemptAuditImplementationReady:false`
- decision / entry / audit 行：`realAttemptAuditImplementationReady:false`、`wouldPersistAudit:false`、`wouldWriteLog:false`、`wouldWriteAudit:false`、全部 `*Allowed:false`、`immutableAuditReady:false`

### 与 V1.25/V1.26/V1.27 的分层（intentional layered fail-closed）

| 层 | 公开 API | 信任边界 | ready 含义 | 不授权 |
| --- | --- | --- | --- | --- |
| V1.24 | `areSupervisorLifecycleGuardedRunnerActionCandidatesReady` | shape + maxAttempts `1..3` **或** `'[redacted]'` | structural candidates ready | 不授权 registry/adapter/anchor/audit/execution |
| V1.25 | `resolveSupervisorLifecycleGuardedRunnerRegistry` | actionId 集合 + catalog implementationId + numeric maxAttempts | registry mapping 可核验 | 不授权 host mutation / anchor / audit / execution |
| V1.26 | `resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter` | actionId 集合 + status/would* false；**忽略** implementationId / maxAttempts 值 | restricted mutationKind 映射可核验 | 不授权真实 host mutation |
| V1.27 | `resolveSupervisorLifecycleGuardedRunnerRollbackAnchor` | actionId 集合 + status/would* false；**忽略** implementationId / maxAttempts；**不读** mutationKind | restricted pure data anchorKind 映射可核验 | 不授权 anchor write/restore |
| **V1.28** | `resolveSupervisorLifecycleGuardedRunnerAttemptAudit` | actionId 集合 + status/would* false；**忽略** implementationId / maxAttempts；**不读** mutationKind / anchorKind / registryDecision / adapterDecision / anchorDecision | restricted **纯数据** auditKind 映射可核验 | 不授权 persist/log/write audit、host mutation、execution |

**分层失败矩阵（production gate 必须可测）：**

| 场景 | actionCandidatesReady | registryDecision | adapterDecision | anchorDecision | auditDecision | gates.runnerRegistryReady | gates.hostMutationAdapterReady | gates.rollbackAnchorReady | gates.attemptAuditReady | policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 合法 catalog + numeric maxAttempts + would* false | true | resolved | resolved | resolved | resolved | true | true | true | true | deny，primary=`operator-recovery-not-ready`，**不含** `attempt-audit-not-ready` / `rollback-anchor-not-ready` / `host-mutation-adapter-not-ready` / `runner-registry-not-ready` |
| 合法格式非 catalog `implementationId` | true | unresolved | **resolved** | **resolved** | **resolved** | **false** | **true** | **true** | **true** | deny，含 `runner-registry-not-ready`；**不含** adapter/anchor/audit not-ready |
| maxAttempts `'[redacted]'` | true | unresolved | **resolved** | **resolved** | **resolved** | **false** | **true** | **true** | **true** | deny，含 `runner-registry-not-ready` |
| empty / missing binding candidates | false | unresolved | unresolved | unresolved | unresolved | false | false | false | false | deny，含 registry/adapter/anchor/audit not-ready（或更上游） |
| pure-only unsafe would* true | — | — | unresolved | unresolved | unresolved | — | — | — | — | pure 覆盖；gate 不强制 production 构造 would* true |

**关键不变量：**

1. V1.28 **不**修改 V1.24 / V1.25 / V1.26 / V1.27 的 public 契约语义。
2. Attempt-audit resolver **不得**读取 `adapterDecision` / `registryDecision` / `anchorDecision` / `mutationKind` / `anchorKind` / request override。
3. Attempt-audit ready **绝不**把 `wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` / `immutableAuditReady` / `executionEligible` / `wouldMutateHost` / `wouldWriteAnchor` / `wouldRestore` 变 true。
4. Adapter / Anchor / Attempt-audit 对同一合法 production candidates 应可同时 resolved；对 non-catalog / redacted 路径三者可 resolved 而 registry unresolved（intentional）。
5. **`runnerWiringContractReady` 与 Gold 在 V1.28 仍 false/blocked**——即使 readyCount 变为 5/1。

---

## 1. 纯函数 attempt-audit resolver

### 1.1 导出（稳定 public pure API）

```js
/**
 * Resolve and verify sanitized guarded-runner action candidates against the
 * code-owned restricted attempt-audit mapping table (pure data plan only).
 *
 * Ready resolution means only that every candidate actionId maps to the fixed
 * restricted auditKind for the given operation. It does NOT persist audit
 * events, write logs/filesystem/metadata, call appendAuditEvent, execute
 * launchctl/shell/process/network; does NOT set wouldPersistAudit /
 * wouldWriteLog / wouldWriteAudit / *Allowed / immutableAuditReady /
 * wouldExecute/wouldRun/wouldWrite true; does NOT imply
 * realAttemptAuditImplementationReady, realHostMutationImplementationReady,
 * realRollbackAnchorImplementationReady, or executionEligible.
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
export function resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, operation)
```

| 项 | 要求 |
| --- | --- |
| 可见性 | **export**；公共 JSDoc 声明语义与非执行边界 |
| 参数 | **仅** `candidates` + `operation`；不读 request/options/fs/env/manifest/runnerBinding/registryDecision/adapterDecision/anchorDecision；不接受 caller-supplied auditDecision |
| 返回 | 仅 plain object（深拷贝）；不返回 function / Promise / command / path / host / token / hash / raw error |
| 副作用 | 无 |
| 真值 | `state:'resolved'` 且 `auditReady:true` **仅**表示受限 pure data audit 映射核验通过 |
| 假值 | invalid / mismatch / unsafe / trap → `state:'unresolved'` + 单一 exact allowlisted primary blocker |

**命名：** 采用 `resolve...AttemptAudit`（resolve/readiness，不暗示 write/persist/execute）。拒绝 `writeAttemptAudit` / `persistAudit` / `appendAuditLog` / `dispatch...`。

### 1.2 输入：candidates + operation

`operation` 必须是 string 且 ∈ `{'install','uninstall','rollback','recover'}`；否则 unresolved + **唯一** blocker `attempt-audit-operation-invalid`，decision.`operation` 输出 **`'unknown'`**（**仅此路径** 输出 unknown）。

**decision.operation 回显规则（禁止“所有 unresolved → unknown”）：**

| 输入 operation | 结果 state | decision.`operation` |
| --- | --- | --- |
| allowlisted（`install` / `uninstall` / `rollback` / `recover`） | resolved **或** unresolved（candidates/集合/unsafe 等任意失败） | **回显同一合法 operation 字符串** |
| 非 allowlisted / 非 string / 缺失等 | unresolved + `attempt-audit-operation-invalid` | **`'unknown'`**（schema 唯一 unknown 来源） |

测试 helper `assertAuditUnresolvedExact(decision, primaryBlocker, operation)` 的第三参 **必传**、禁止默认 `'unknown'`；合法 operation 输入的 unresolved 用例一律传对应合法 operation；**仅** invalid-operation 传 expected `'unknown'`。

`candidates` 输入 **不是** “长度必须 equal `|E|`” 的 structure precondition。容器合法（array、非 empty、元素可快照）后，长度/集合偏差走 §1.6 集合类 blocker；**仅** `state:'resolved'` 成功时要求 actionId 集合与 expected set **exact match**（因而 `audits.length === |E|`）。

结构入口（与 V1.25–V1.27 容器策略同形，blocker 前缀换为 `attempt-audit-`）：

1. 非 array / null / type-confusion → `attempt-audit-candidates-invalid`
2. empty array（`len < 1`）→ `attempt-audit-candidates-invalid`
3. 容器 trap / 元素 shape / exact-key 偏差 / accessor / trap / type-confusion → `attempt-audit-candidates-invalid`
4. **snapshot 后** `actionId` 非「非空 string」（含 `''`、number、boolean、null、object 等）→ **唯一** `attempt-audit-candidates-invalid`（**先于** duplicate / unknown / missing）
5. **长度 ≠ `|E|` 本身绝不能直接变** `candidates-invalid`（非 empty、元素 schema 过了、且每项 `actionId` 已是非空 string 之后，一律进入 duplicate → unknown → missing）

每个合法元素通过 §1.4 的 best-effort exact-key plain data property 单次快照。

#### Candidate exact keys（与 V1.25–V1.27 sanitized gate action candidate contract 一致）

```text
actionId, implementationId, runnerKind, mode, status,
wouldExecute, wouldRun, wouldWrite, maxAttempts
```

- 顺序无关；元素 **键集合** 多一个、少一个、同名原型污染键 → `attempt-audit-candidates-invalid`
- 无 own getter / accessor：每个 own key **恰好一次** `Object.getOwnPropertyDescriptor`，必须是 data property
- `Object.getPrototypeOf(element) === Object.prototype` 或 `=== null`
- descriptor / `ownKeys` throw → `attempt-audit-candidates-invalid`；**不得**把 raw error message / stack / trap 返回值写入 decision

#### Attempt-audit 对 candidate 字段的信任边界（intentional layered fail-closed）

| 字段 | Attempt-audit 是否用于 ready resolve | 说明 |
| --- | --- | --- |
| `actionId` | **是** | 集合与 `buildLifecycleActions(operation)` expected set exact match；映射 auditKind |
| `status` / `wouldExecute` / `wouldRun` / `wouldWrite` | **是** | 必须 exact `status:'blocked'` 且三 would* exact `false`；否则 **唯一** `attempt-audit-unsafe-audit` |
| `implementationId` / `runnerKind` / `mode` / `maxAttempts` | **否（忽略值内容）** | 仍须存在于 exact-key shape；**不**因非 catalog implementationId / redacted maxAttempts / runnerKind 偏差而 unresolved |

**分层结论：**

| 场景 | `actionCandidatesReady`（V1.24） | `registryDecision`（V1.25） | `adapterDecision`（V1.26） | `anchorDecision`（V1.27） | `auditDecision`（V1.28） |
| --- | --- | --- | --- | --- | --- |
| 合法 catalog + numeric maxAttempts + would* false | true | resolved | resolved | resolved | resolved |
| 合法格式非 catalog `implementationId` | true | unresolved | **resolved** | **resolved** | **resolved** |
| maxAttempts `'[redacted]'` | true | unresolved | **resolved** | **resolved** | **resolved** |
| wouldExecute/wouldRun/wouldWrite true 或 status≠blocked | 视 helper | 可能 unresolved | unresolved | unresolved | **unresolved** + `attempt-audit-unsafe-audit` |

这是 **intentional layered fail-closed**，不是 bug。Attempt-audit ready **绝不**授权 persist/log 或抬升 `executionEligible` / `runnerWiringContractReady`。

### 1.3 Code-owned 固定 action → auditKind 映射表

Attempt-audit **只信任** `src/supervisor-lifecycle.js` 内冻结表。manifest / runnerBinding / request / CLI / Web / executionPreview / approval / config / env / fs / caller-supplied decision / `registryDecision` / `adapterDecision` / `anchorDecision` **一律不可**注入 ready。

#### 1.3.1 Action 集合（必须来自 `buildLifecycleActions`，不得增减）

| operation | actionId（顺序固定） |
| --- | --- |
| `install` | `render-launch-agent-plist`, `write-launch-agent-plist`, `load-launch-agent` |
| `uninstall` | `unload-launch-agent`, `remove-launch-agent-plist`, `remove-supervisor-metadata` |
| `rollback` | `capture-current-state`, `restore-previous-plist`, `restart-previous-supervisor` |
| `recover` | `start-recovery-supervisor` |

**测试 / plan fixture 恒等不变量（不可漂移）：**

```js
// 生产权威（resolver 内必须直接调用，不得另写可漂移列表）：
expectedIds = buildLifecycleActions(operation).map((a) => a.id)

// 测试 fixture 必须与之 deep-equal。buildLifecycleActions 为模块内函数时，
// 经公开 apply plan 路径间接核验（plan.actions 由其派生）：
deepStrictEqual(
  OPERATION_EXPECTED_ACTION_IDS[operation],
  buildSupervisorLifecycleApplyPlan({}, { operation }).actions.map((a) => a.id),
);
```

- pure / gate fixture 中的 `OPERATION_EXPECTED_ACTION_IDS` **不是** 第二套权威表。
- 权威来源 **仅** `buildLifecycleActions(operation).map((a) => a.id)`（顺序 + 成员均 exact）。
- 实现 resolver 的 expected set **必须** 由同一 `buildLifecycleActions` 派生；禁止手写另一份可独立漂移的 action 列表。
- plan 测试 **必须** 含上式一致性断言（每个 allowlisted operation 各一次）。

#### 1.3.2 固定 auditKind 映射（identifiers only — pure data plan）

下列 ID 是 **restricted pure data attempt-audit plan identifiers only**——不是 audit 文件路径、不是 JSONL 事件、不是可调用 writer、不是 shell/launchctl argv。仓库中 **不存在**真实 attempt audit persist/log implementation。

| actionId | auditKind | plannedAuditSurface（元数据标签 only，**不**授权） |
| --- | --- | --- |
| `render-launch-agent-plist` | `render-plist-attempt-audit` | `none` |
| `write-launch-agent-plist` | `write-plist-attempt-audit` | `audit-log` |
| `load-launch-agent` | `load-agent-attempt-audit` | `audit-log` |
| `unload-launch-agent` | `unload-agent-attempt-audit` | `audit-log` |
| `remove-launch-agent-plist` | `remove-plist-attempt-audit` | `audit-log` |
| `remove-supervisor-metadata` | `remove-metadata-attempt-audit` | `metadata` |
| `capture-current-state` | `capture-state-attempt-audit` | `audit-log` |
| `restore-previous-plist` | `restore-plist-attempt-audit` | `audit-log` |
| `restart-previous-supervisor` | `restart-supervisor-attempt-audit` | `audit-log` |
| `start-recovery-supervisor` | `recovery-supervisor-attempt-audit` | `audit-log` |

- `plannedAuditSurface` **不得**写入 decision 输出（避免 UI/测试把标签当成 permission）。仅存在于源码常量注释或内部表；对外 audit 行 **只**含 `auditKind` + 恒 false flags。
- **install** 三 actionId 与既有 gate fixture 兼容。
- uninstall / rollback / recover 映射仅供 pure unit tests；**不**表示已有 persist/log writer。

#### 1.3.3 auditKind allowlist

```js
const ATTEMPT_AUDIT_KIND_ALLOWLIST = Object.freeze([
  'render-plist-attempt-audit',
  'write-plist-attempt-audit',
  'load-agent-attempt-audit',
  'unload-agent-attempt-audit',
  'remove-plist-attempt-audit',
  'remove-metadata-attempt-audit',
  'capture-state-attempt-audit',
  'restore-plist-attempt-audit',
  'restart-supervisor-attempt-audit',
  'recovery-supervisor-attempt-audit',
]);
```

输出 audit 行的 `auditKind` **必须** ∈ 该 allowlist，且 **exact equal** 上表对 actionId 的固定值。实现不得从 input 读取 auditKind（input candidate **无** auditKind 键；多键 → candidates-invalid）。

#### 1.3.4 recover

`recover` 仅一 action：`start-recovery-supervisor` → `recovery-supervisor-attempt-audit`。V1.28 **不**设计/执行真实 recovery supervisor 或 recovery audit persist，不解除既有 apply-path blockers。Attempt-audit 仅允许映射解析为 `resolved`；绝不因此把 would* / wouldPersistAudit / wouldWriteLog / *Allowed / immutableAuditReady / executionEligible 变 true。

### 1.4 单次快照 / Proxy 边界（准确声明）

**JavaScript 无法可靠识别所有 `Proxy`。** 本设计 **不声称**可证明拒绝所有 Proxy。

与 V1.25 §1.4 / V1.26 §1.4 / V1.27 §1.4 **同策略**：

1. 容器：`try/catch` + `Array.isArray` + 一次 `length` + 一次索引读到本地 `elements[]`；**禁止**再触碰原容器；**不**对 array 做 descriptor purity 声称。
2. 元素：`ownKeys` 一次；exact key allowlist；每 key **恰好一次** descriptor → data property → 本地 snapshot；**禁止** check-then-二次读。
3. trap throw / getter / type-confusion → `attempt-audit-candidates-invalid`。

#### 生产路径三层防御

| 层 | 约束 |
| --- | --- |
| L1 Gate 构造 | candidates **只来自** `buildGuardedRunnerExecutionGateActionCandidates`；operation 来自 allowlisted plan/preview；不接收 request/options audit bag |
| L2 Resolver | best-effort 容器快照 + 元素 exact-key snapshot + code-owned audit map；非法/unsafe → unresolved |
| L3 副作用恒 false | 任意 decision：`wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` / 全部 `*Allowed` / `immutableAuditReady` / `wouldExecute/wouldRun/wouldWrite` / `realAttemptAuditImplementationReady` 恒 false；gate top-level `executionEligible/wouldExecute` 与 `runnerWiringContractReady` 在 V1.28 亦恒 false |

### 1.5 Decision 输出 schema（exact）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-attempt-audit',
  operation: <allowlisted input echoed, OR 'unknown' only when operation-invalid>,
  state: 'resolved' | 'unresolved',
  auditReady: boolean,                         // true only when fully resolved
  codeOwnedResolverWired: true,                // 见 §2.3：单次 decision 表示 resolver 路径已接线，恒 true
  realAttemptAuditImplementationReady: false,  // V1.28 恒 false
  wouldPersistAudit: false,                    // V1.28 恒 false
  wouldWriteLog: false,                        // V1.28 恒 false
  wouldWriteAudit: false,                      // V1.28 恒 false
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  auditWriteAllowed: false,                    // V1.28 恒 false
  metadataWriteAllowed: false,                 // V1.28 恒 false
  filesystemWriteAllowed: false,               // V1.28 恒 false
  immutableAuditReady: false,                  // V1.28 恒 false
  resolvedCount: number,
  unresolvedCount: number,
  audits: [ /* 见下 */ ],
  primaryBlocker: string | null,
  blockers: string[],
  nextBlockers: string[],
  sensitiveValuesReturned: false,
  safety: executionPreviewSafety(),
}
```

**命名：** 使用 `codeOwnedResolverWired`，**不用** `codeOwnedResolverReady`。后者易与 readiness 的 `codeOwnedAuditResolverReady` 混淆。

**字段名 `auditReady`（decision）≠ readiness `attemptAuditReady`：** decision 级表示本次 pure data 映射核验；readiness 级表示产品 contract 固定 ready。

#### audits 行 schema（**仅** resolved 时非空；**不含** `codeOwnedResolverWired`）

```js
{
  actionId: string,                    // expected 序第 i 项
  auditKind: string,                   // catalog exact；∈ ATTEMPT_AUDIT_KIND_ALLOWLIST
  auditReady: true,
  realAttemptAuditImplementationReady: false,
  wouldPersistAudit: false,
  wouldWriteLog: false,
  wouldWriteAudit: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  auditWriteAllowed: false,
  metadataWriteAllowed: false,
  filesystemWriteAllowed: false,
  immutableAuditReady: false,
  blockerCode: null,
  evidenceCode: 'attempt-audit-plan-ready',
}
```

测试：`assertAuditResolved` 对每一 audit row 必须断言上表 **全部** 字段；不得用模糊注释占位。

#### resolved / unresolved 的 exact 计数字段（防泄漏、无二义）

V1.28 为 **all-or-nothing** 解析（不做部分 resolved）：

| 结果 | `resolvedCount` | `unresolvedCount` | `audits` |
| --- | --- | --- | --- |
| resolved | `expectedActionCount(operation)` | `0` | 长度 = expected；顺序 = expected action 序；每行 auditReady true |
| **任意** unresolved（含 invalid/unsafe/trap） | `0` | `0` | `[]`（**永不**回显未信任输入行，**不**用恶意 input.length 填充计数） |

**`unresolvedCount` 在 all-or-nothing 下恒为 `0` 是刻意选择，不是漏计数：** 任一失败即整单 unresolved，**不**累计“第几行失败”或 `input.length` 式部分计数；失败细节只落在 **单一** allowlisted `primaryBlocker` / `blockers[0]`。断言时不得把 `unresolvedCount===0` 误读为“未统计失败数”的缺陷。

#### 一致语义

| 不变量 | 说明 |
| --- | --- |
| `state === 'resolved'` ⇔ `auditReady === true` | 同真同假 |
| resolved ⇒ `blockers:[]`、`primaryBlocker:null`、`nextBlockers:[]`、`resolvedCount===expected`、`unresolvedCount===0`、`operation` 为 allowlisted 输入回显 | |
| unresolved ⇒ `blockers` 为 **单一 exact** allowlisted code 数组、`primaryBlocker===blockers[0]`、`nextBlockers===[primaryBlocker]`、`resolvedCount===0`、`unresolvedCount===0`、`audits:[]` | |
| unresolved 且 primary ≠ `operation-invalid` ⇒ `decision.operation` **仍为** 输入 allowlisted operation | |
| unresolved 且 primary = `attempt-audit-operation-invalid` ⇒ `decision.operation === 'unknown'` | schema **唯一** unknown 路径 |
| 任意 decision：wouldPersistAudit / wouldWriteLog / wouldWriteAudit / *Allowed / immutableAuditReady / would* / realAttemptAuditImplementationReady 恒 false | audit resolved ≠ persist/log |
| `codeOwnedResolverWired` 在 well-formed decision 上恒 true | 表示输出由 code-owned resolver 路径产生 |

### 1.6 Blocker vocabulary（收紧后 exact allowlist）

```js
const ATTEMPT_AUDIT_BLOCKER_CODES = Object.freeze([
  'attempt-audit-candidates-invalid',
  'attempt-audit-operation-invalid',
  'attempt-audit-action-missing',
  'attempt-audit-action-duplicate',
  'attempt-audit-action-unknown',
  'attempt-audit-unsafe-audit',
]);
```

**故意不引入（不可达 / 与分层冲突 / 与上下游重叠）：**

| 不引入码 | 原因 |
| --- | --- |
| `attempt-audit-operation-mismatch` | 无独立于 operation-invalid / 集合校验的路径 |
| `attempt-audit-action-extra` | 在 duplicate→unknown→missing 下由鸽笼原理覆盖 |
| `attempt-audit-implementation-mismatch` | implementationId 校验属于 V1.25 registry，不在 audit 信任边界 |
| `attempt-audit-kind-mismatch` | input **无** auditKind 字段；kind 仅由 code-owned 表输出 |
| `attempt-audit-real-implementation-missing` | readiness ready 后由 `realAttemptAuditImplementationReady:false` 表达；**不**再作为 readiness blockers 主码 |
| `attempt-audit-adapter-not-ready` / `attempt-audit-anchor-not-ready` | audit **不**依赖 adapterDecision / anchorDecision；分层独立 |

#### 失败分类固定规则

| 类别 | 触发条件 | primaryBlocker |
| --- | --- | --- |
| 结构 invalid | 非 array；empty；容器/元素 shape / exact-key / accessor / trap / type-confusion；**snapshot 后 actionId 非非空 string** | **仅** `attempt-audit-candidates-invalid` |
| 集合偏差 | 非 empty、元素 schema 已过、**且每项 actionId 已是非空 string**；actionId 集合与 E 不等 | 固定 **duplicate → unknown → missing** |
| unsafe audit | 集合已与 E exact match 后，任一 candidate `status !== 'blocked'` **或** `wouldExecute/wouldRun/wouldWrite !== false` | **仅** `attempt-audit-unsafe-audit` |

**长度不等式：** `|A| !== |E|` **本身**绝不能直接映射为 `candidates-invalid`。pure 必须两侧覆盖：

| 侧 | pure case | 构造要点 | 唯一 primary |
| --- | --- | --- | --- |
| `len < \|E\|` | **T6** | install 子集 2 行（合法 shape） | `attempt-audit-action-missing` |
| `len > \|E\|` | **T23** | fresh install 3 行 + 追加外来 `start-recovery-supervisor`（总长 4、无重复） | `attempt-audit-action-unknown` |
| `len > \|E\|` | **T24** | fresh install 3 行 + 追加重复 `render-launch-agent-plist`（总长 4、有重复） | `attempt-audit-action-duplicate` |

#### 评估顺序（稳定 primary；每失败类 **恰好一个** primary）

1. operation allowlist → `attempt-audit-operation-invalid`
2. candidates 容器 / 元素 shape / exact keys / accessors / traps / type-confusion / empty → `attempt-audit-candidates-invalid`（**不含** “长度 ≠ expected”）
3. **snapshot 后** 任一 `actionId` 非非空 string → **唯一** `attempt-audit-candidates-invalid`（先于集合类）
4. duplicate actionId → `attempt-audit-action-duplicate`
5. unknown actionId（∉ E）→ `attempt-audit-action-unknown`
6. missing expected（A ⊆ E 且集合 ≠ E）→ `attempt-audit-action-missing`
7. 集合已 exact match E 后，按 expected 序扫 snapshot：status / would* 非期望 → `attempt-audit-unsafe-audit`

多类同时成立时 **primary = 上表最先命中者**；`blockers` 输出至少含 primary；本版测试断言 **primary 与 blockers[0] exact 单一码**。

### 1.7 深拷贝 / 抗 mutation / caller override 防护

1. 调用后改 input → 已返回 decision 不变。
2. 改已返回 decision → 后续调用不受污染。
3. 输出为新对象；`audits` / `blockers` / `nextBlockers` / `safety` 均为新数组/新对象。
4. 异常映射固定 blocker，不泄露原值 / raw error。
5. Gate **必须忽略** `options.auditDecision` / `options.attemptAuditReady` / `options.auditContext`（与 V1.25–V1.27 对 registry/adapter/anchor override 的防护同形）。即使 caller 传入 `attemptAuditReady:true` 或伪造 `auditDecision.state:'resolved'`，gate 仍只使用 production-derived 本地 boolean。

---

## 2. Readiness helper

### 2.1 签名不变

```js
export function buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness()
```

无参数；忽略 runtime-looking 多余参数；不读 config/manifest/binding/preview/approval/env/fs。

### 2.2 输出 schema（exact）

**Top-level readiness exact keys（顺序固定；不多不少）：**

```text
command, state, attemptAuditDefined, attemptAuditReady,
codeOwnedAuditResolverReady, realAttemptAuditImplementationReady,
readyCount, blockedCount, auditEntries, blockers, nextBlockers, safety
```

```js
{
  command: 'supervisor-lifecycle-guarded-runner-attempt-audit-readiness',
  state: 'ready',
  attemptAuditDefined: true,
  attemptAuditReady: true,                       // readiness 固定 true（≠ gate fact）
  codeOwnedAuditResolverReady: true,             // readiness 级：resolver contract 已 ready
  realAttemptAuditImplementationReady: false,    // 唯一 real-* 具名字段；恒 false
  readyCount: 1,
  blockedCount: 0,
  auditEntries: [ /* exactly 1 ready catalog entry — 见 §2.4 */ ],
  blockers: [],
  nextBlockers: [],
  safety: executionPreviewSafety(),              // 含 safety.sensitiveValuesReturned:false
}
```

**Top-level 恒 false / 固定值不变量：**

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `realAttemptAuditImplementationReady` | 恒 `false` | 无真实 persist/log；**禁止** true 或删键 |
| `attemptAuditReady` | 固定 `true` | builder 无参固定输出；**≠** `gates.attemptAuditReady` |
| `codeOwnedAuditResolverReady` | 固定 `true` | 产品级 pure contract ready |
| `readyCount` / `blockedCount` | `1` / `0` | 单 ready entry |
| `blockers` / `nextBlockers` | `[]` | 不再承载 real-implementation-missing |
| `safety.sensitiveValuesReturned` | 恒 `false` | 经 `executionPreviewSafety()`；**不**在 readiness top-level 另开同名键 |

**Top-level 明确排除的键（不得出现）：**

| 排除键 | 原因 |
| --- | --- |
| `realAttemptAuditReady` | 旧 readiness 键；已重命名为 `realAttemptAuditImplementationReady` |
| `realImplementationReady` | 旧通用别名；与具名字段语义重叠；**不得残留** |
| `sensitiveValuesReturned` | **仅** decision top-level 与 `safety` 承载；readiness top-level **不**开此键 |
| `codeOwnedResolverWired` | decision / entry 字段；**不**出现在 readiness top-level |
| `wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` / `wouldExecute` / `wouldRun` / `wouldWrite` / 全部 `*Allowed` / `immutableAuditReady` | 副作用字段落在 entry / decision / audit 行，**不**在 readiness top-level |

### 2.3 字段命名、迁移与差异（必须解释）

| 字段 | 所在对象 | V1.28 值 | 含义 |
| --- | --- | --- | --- |
| `codeOwnedAuditResolverReady` | **readiness** | `true` | 产品级 readiness：code-owned pure restricted attempt-audit resolver contract 已就绪 |
| `codeOwnedResolverWired` | **auditDecision** + **entry** | 恒 `true` | 单次 decision / entry 由已接线的 resolver 路径发出；**不是**“本次 mapping 一定 resolved”，**也不是** audit 可写 |
| `realAttemptAuditImplementationReady` | readiness / decision / entry / audit 行 | 恒 `false` | **唯一** real-* 具名字段：无真实 attempt audit persist/log implementation |
| `attemptAuditReady`（readiness） | readiness builder | 固定 `true` | ≠ gate fact `gates.attemptAuditReady` |
| `auditReady`（decision） | auditDecision | resolved 时 true | 单次 pure data 映射核验结果 |
| `wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` / 全部 `*Allowed` / `immutableAuditReady` | decision / entry / audit 行 | 恒 `false` | 受限 contract 不授权任何 persist/log/write side effect |
| `sensitiveValuesReturned` | **仅** decision top-level（+ `safety`） | 恒 `false` | readiness top-level / entry **均不**含此键 |

#### 字段迁移表（V1.21 → V1.28；旧键不得残留）

| 旧 locus / 键 | V1.28 处置 | 新键 / 替代 |
| --- | --- | --- |
| readiness `realAttemptAuditReady` | **重命名** | `realAttemptAuditImplementationReady`（值仍恒 `false`） |
| entry / decision / audit 行的 `realImplementationReady` | **删除**（不得残留） | 仅保留 `realAttemptAuditImplementationReady:false` |
| entry `sensitiveValuesReturned`（V1.21 disabled entry 曾有） | **删除**（不得残留） | decision top-level `sensitiveValuesReturned:false` + readiness `safety.sensitiveValuesReturned:false` |
| entry `auditKind:'disabled-attempt-audit-stub'` / `state:'blocked'` | **替换** | `auditKind:'code-owned-attempt-audit'` / `state:'ready'` |
| readiness / entry blocker `attempt-audit-real-implementation-missing` | **不再**作为 readiness blockers 主码 | 由 `realAttemptAuditImplementationReady:false` 表达 |

**同步测试（不可漏）：**

- 凡断言旧键 `realAttemptAuditReady` 的 pure / gate / API / CLI / Web 用例一律改为 `realAttemptAuditImplementationReady`。
- readiness / entry / decision / audit 行上 **`Object.hasOwn(..., 'realAttemptAuditReady') === false`**。
- readiness / entry / decision / audit 行上 **`Object.hasOwn(..., 'realImplementationReady') === false`**（旧通用别名不得残留）。
- readiness top-level 与 entry 上 **`Object.hasOwn(..., 'sensitiveValuesReturned') === false`**；decision top-level 仍断言 `sensitiveValuesReturned === false`。
- plan fixture `EXPECTED_ATTEMPT_AUDIT_ENTRIES` 必须与 §2.4 **byte-level deep-equal**（键集合 + 值）。

**禁止：**

- 在 decision 上使用 `codeOwnedAuditResolverReady` 这个 readiness 级名字
- 把 `realAttemptAuditImplementationReady` 设为 true 或删除该键
- 把 `wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` 或任一 `*Allowed` / `immutableAuditReady` 设为 true
- 在 readiness / entry 上复活 `realImplementationReady` 或 `sensitiveValuesReturned`
- 因本版把 `runnerWiringContractReady` 或 Gold 标为 true/ready

### 2.4 唯一 audit entry（exact schema）

**Entry exact keys（顺序固定；不多不少）：**

```text
auditKind, state, codeOwnedResolverWired, realAttemptAuditImplementationReady,
wouldPersistAudit, wouldWriteLog, wouldWriteAudit, wouldExecute, wouldRun, wouldWrite,
auditWriteAllowed, metadataWriteAllowed, filesystemWriteAllowed,
immutableAuditReady, blockerCode, evidenceCode
```

```js
{
  auditKind: 'code-owned-attempt-audit',
  state: 'ready',
  codeOwnedResolverWired: true,
  realAttemptAuditImplementationReady: false, // 唯一 real-* 具名字段；恒 false
  wouldPersistAudit: false,                   // 恒 false
  wouldWriteLog: false,                       // 恒 false
  wouldWriteAudit: false,                     // 恒 false
  wouldExecute: false,                        // 恒 false
  wouldRun: false,                            // 恒 false
  wouldWrite: false,                          // 恒 false
  auditWriteAllowed: false,                   // 恒 false
  metadataWriteAllowed: false,                // 恒 false
  filesystemWriteAllowed: false,              // 恒 false
  immutableAuditReady: false,                 // 恒 false
  blockerCode: null,
  evidenceCode: 'attempt-audit-ready',
}
```

**`auditKind` 语义分层（禁止混淆）：** readiness entry 上的 `auditKind: 'code-owned-attempt-audit'` 是 **catalog-level 汇总标识**（表示 code-owned restricted attempt-audit catalog/entry 本身），**不等于** decision `audits[]` 行上的 **action-level** `auditKind`（后者必须 ∈ `ATTEMPT_AUDIT_KIND_ALLOWLIST`，且 exact equal §1.3.2 对每个 `actionId` 的固定映射，例如 `render-plist-attempt-audit`）。不得把 catalog 汇总 kind 写入 audit 行，也不得把 action-level kind 当作 readiness entry kind。

**Entry 明确排除的键（不得出现）：**

| 排除键 | 原因 |
| --- | --- |
| `realImplementationReady` | 与 `realAttemptAuditImplementationReady` 语义重叠；V1.28 **删除**，不得残留 |
| `sensitiveValuesReturned` | V1.21 disabled entry 曾有；V1.28 **删除**；改由 decision + safety 表达 |
| `realAttemptAuditReady` | 旧 readiness 键名；entry 从未使用且不得引入 |

**Entry 恒 false 不变量：** `realAttemptAuditImplementationReady`、`wouldPersistAudit`、`wouldWriteLog`、`wouldWriteAudit`、`wouldExecute`、`wouldRun`、`wouldWrite`、`auditWriteAllowed`、`metadataWriteAllowed`、`filesystemWriteAllowed`、`immutableAuditReady` 全部恒 `false`。

- 不再以 `state:'blocked'` / `disabled-attempt-audit-stub` 作 readiness 主状态。
- readiness `blockers` 不再含 `attempt-audit-real-implementation-missing` / `real-guarded-runner-execution-wiring-missing`（persist/log 未就绪由 `realAttemptAuditImplementationReady:false` 表达；wiring 级 blocker 留在 wiring aggregate）。
- plan `EXPECTED_ATTEMPT_AUDIT_ENTRIES[0]` **必须** 与上表 exact deep-equal。

---

## 3. Wiring contract

### 3.1 requiredContracts（顺序固定）

1. `execution-policy` → ready（V1.24）
2. `runner-registry` → ready（V1.25）
3. `host-mutation-adapter` → ready（V1.26）
4. `rollback-anchor` → ready（V1.27）
5. `attempt-audit` → **ready**（V1.28）
6. `operator-recovery` → blocked

### 3.2 Ready `attempt-audit` contract

```js
{
  id: 'attempt-audit',
  status: 'ready',
  requiredForExecution: true,
  evidence: 'Code-owned fail-closed restricted attempt-audit pure data plan resolver is wired.',
  evidenceCode: 'attempt-audit-ready',
  blockerCode: null,
}
```

- `status === 'ready'` ⇒ `blockerCode === null` 且 `evidenceCode === 'attempt-audit-ready'`
- Web 显示 `blocker:none` 仅为 UI sentinel；JSON 仍为 `null`
- 禁止 `status:'ready'` 与 missing blocker 并存

### 3.3 Wiring aggregate

```js
{
  command: 'supervisor-lifecycle-guarded-runner-wiring-contract',
  state: 'blocked',
  realRunnerWiringReady: false,
  readyCount: 5,
  blockedCount: 1,
  requiredContracts: [ /* 6 */ ],
  executionPolicyReadiness: /* ready */,
  runnerRegistryReadiness: /* ready */,
  hostMutationAdapterReadiness: /* ready */,
  rollbackAnchorReadiness: /* ready */,
  attemptAuditReadiness: /* ready builder */,
  operatorRecoveryReadiness: /* blocked */,
  blockers: ['real-guarded-runner-execution-wiring-missing'],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  safety: executionPreviewSafety(),
}
```

`buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview)` 仍忽略 preview 内容。

**关键：** `readyCount:5` / `blockedCount:1` **不等于** `runnerWiringContractReady:true`。aggregate `state` 仍 `'blocked'`；gate `gates.runnerWiringContractReady` 仍恒 `false`。

---

## 4. Execution gate 集成

### 4.1 仅 production-derived 输入调用 resolver

```js
const actionCandidates = buildGuardedRunnerExecutionGateActionCandidates(plan, executionPreview);
const actionCandidatesReady = areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
  actionCandidates,
  operation,
);

const registryDecision = sanitizeRegistryDecision(
  resolveSupervisorLifecycleGuardedRunnerRegistry(actionCandidates, operation),
);

const adapterDecision = sanitizeHostMutationAdapterDecision(
  resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(actionCandidates, operation),
);

const anchorDecision = sanitizeRollbackAnchorDecision(
  resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(actionCandidates, operation),
);

// Ignore options.auditDecision / options.attemptAuditReady / options.auditContext.
const auditDecision = sanitizeAttemptAuditDecision(
  resolveSupervisorLifecycleGuardedRunnerAttemptAudit(actionCandidates, operation),
);

// runnerRegistryReady / hostMutationAdapterReady / rollbackAnchorReady：保持既有语义（不回退）
// attemptAuditReady：新增本地 boolean
const attemptAuditReadiness = runnerWiringContract.attemptAuditReadiness;
const attemptAuditReady =
  attemptAuditReadiness?.attemptAuditReady === true &&
  attemptAuditReadiness?.codeOwnedAuditResolverReady === true &&
  attemptAuditReadiness?.state === 'ready' &&
  attemptAuditReadiness?.realAttemptAuditImplementationReady === false &&
  auditDecision?.auditReady === true &&
  auditDecision?.state === 'resolved' &&
  auditDecision?.codeOwnedResolverWired === true &&
  auditDecision?.realAttemptAuditImplementationReady === false &&
  auditDecision?.wouldPersistAudit === false &&
  auditDecision?.wouldWriteLog === false &&
  auditDecision?.wouldWriteAudit === false &&
  auditDecision?.wouldExecute === false &&
  auditDecision?.wouldRun === false &&
  auditDecision?.wouldWrite === false &&
  auditDecision?.auditWriteAllowed === false &&
  auditDecision?.metadataWriteAllowed === false &&
  auditDecision?.filesystemWriteAllowed === false &&
  auditDecision?.immutableAuditReady === false;

const policyContext = {
  // ...existing upstream booleans...
  actionCandidatesReady: actionCandidatesReady === true,
  runnerRegistryReady: runnerRegistryReady === true,
  hostMutationAdapterReady: hostMutationAdapterReady === true,
  rollbackAnchorReady: rollbackAnchorReady === true,
  attemptAuditReady: attemptAuditReady === true, // 不再 hardcoded false
  operatorRecoveryReady: false,
};
```

**硬性约束：**

- 不得从 `options` / request / CLI 读取 audit override
- `options` 仅允许既有 `executeRequested` boolean
- 不得把 approval identity / path / hash / command / raw error 放进 resolver 或 policy context
- 不得因 audit ready 而把 `executionEligible` / `wouldExecute` / `wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` / 任一 `*Allowed` / `immutableAuditReady` / `wouldMutateHost` / `wouldWriteAnchor` / `wouldRestore` 变 true
- 不得因 audit ready 而把 `realHostMutationImplementationReady` / `realRollbackAnchorImplementationReady` / `runnerWiringContractReady` 变 true

### 4.2 Gate 输出

```js
{
  // ...existing...
  registryDecision,  // V1.25 保持
  adapterDecision,   // V1.26 保持
  anchorDecision,    // V1.27 保持
  auditDecision,     // V1.28 新增；含 wouldPersistAudit / wouldWriteLog / wouldWriteAudit / *Allowed / would*
  policyDecision,    // 含 wouldRun/wouldWrite（policy locus；≠ gate 顶层）
  actionCandidates,
  gates: {
    // ...
    actionCandidatesReady,
    executionPolicyReady: true,
    runnerRegistryReady,           // V1.25 语义
    hostMutationAdapterReady,      // V1.26 语义
    rollbackAnchorReady,           // V1.27 语义
    attemptAuditReady,             // production ready install fixtures → true
    realRunnerWiringReady: false,
    runnerWiringContractReady: false, // V1.28 仍恒 false
    operatorRecoveryReady: false,
  },
  // gate 顶层仅下列资格字段（V1.28 仍恒 false）：
  executionEligible: false,
  wouldExecute: false,
  // **无** gate 顶层 wouldRun / wouldWrite / wouldPersistAudit / wouldWriteLog
}
```

### 4.3 Production path 仍 deny

audit ready 后 primaryBlocker 从 V1.27 的 `attempt-audit-not-ready` **迁移为** `operator-recovery-not-ready`。policy blockers 至少含最后一项 `operator-recovery-not-ready`。

`executionEligible` 语义写死后一 wiring + wiring aggregate 为 false → 结果必 false。测试必须覆盖 “audit ready 后仍 deny 且 executionEligible false 且 runnerWiringContractReady false”。

### 4.4 `sanitizeAttemptAuditDecision`

- 只保留 allowlisted keys
- blockers / primaryBlocker / nextBlockers 过滤到 `ATTEMPT_AUDIT_BLOCKER_CODES`
- 强制 wouldPersistAudit / wouldWriteLog / wouldWriteAudit / 全部 *Allowed / immutableAuditReady / would* / realAttemptAuditImplementationReady false；`codeOwnedResolverWired:true`
- 强制 state/auditReady 一致；漂移 → unresolved + `attempt-audit-candidates-invalid`
- unresolved 强制 `audits:[]`、`resolvedCount:0`、`unresolvedCount:0`
- 返回新对象

---

## 5. API / CLI / Web

### 5.1 透传边界

| 通道 | 行为 |
| --- | --- |
| API | 既有 body 不变；响应透传 gate JSON；**不改** `src/server.js` |
| CLI | 既有 flags；JSON 透传；`--fail-on-blocked` 仍 exit 2；**不改** `src/agent.js` |
| Web | 不新增按钮/字段；**strict canonical fail-closed assembly**（§5.2） |

禁止 request/CLI 强制 `auditDecision` / `attemptAuditReady:true` / `auditEntries` override；传入必须忽略。

#### 5.1.1 API / CLI 测试验证契约

V1.28 改造 **两个现有共用 helper**（参数化，非单点改一行布尔）：

| Helper | 文件 |
| --- | --- |
| `assertBlockedExecutionGate(body, { runnerRegistryReady, hostMutationAdapterReady, rollbackAnchorReady, attemptAuditReady })` | `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` |
| `assertBlockedGate(report, { runnerRegistryReady, hostMutationAdapterReady, rollbackAnchorReady, attemptAuditReady })` | `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` |

**共用 helper 固定（所有 200/成功 gate JSON 路径一致）：**

- wiring：`readyCount:5`、`blockedCount:1`
- `requiredContracts[4]`（`attempt-audit`）：`status:'ready'`、`blockerCode:null`、`evidenceCode:'attempt-audit-ready'`
- 最后一项：`requiredContracts[5]`（`operator-recovery`）`blocked`（**不得** `slice(4)` 把 attempt-audit 再当 blocked）
- `attemptAuditReadiness`：`state:'ready'`、`attemptAuditReady:true`、`codeOwnedAuditResolverReady:true`、`realAttemptAuditImplementationReady:false`、ready entry exact
- `rollbackAnchorReadiness` / contract[3]：**保持 V1.27 ready** 断言
- `hostMutationAdapterReadiness` / contract[2]：**保持 V1.26 ready** 断言
- `runnerRegistryReadiness` / contract[1]：**保持 V1.25 ready** 断言
- `gates.runnerRegistryReady` / `hostMutationAdapterReady` / `rollbackAnchorReady` / `attemptAuditReady`：**严格等于**调用方传入 boolean（**必传**；禁止用 `false` 默认掩盖漏传）
- policy：`state:'denied'` + would* false；gate 顶层 `executionEligible`/`wouldExecute` false；`runnerWiringContractReady:false`

**共用 helper 不得固定（场景不同，只在专属 `it`）：**

- `auditDecision.state` / `auditDecision.auditReady`
- `anchorDecision.state` / `anchorDecision.anchorReady`
- `adapterDecision.state` / `adapterDecision.adapterReady`
- `registryDecision.state` / `registryDecision.registryReady`
- `policyDecision.primaryBlocker`（含 ready 路径的 `operator-recovery-not-ready`）
- no-approval / no-execute / missing-binding 等 primary 或 blockers 细节

**`gates.attemptAuditReady` 语义矩阵（API/CLI）：**

| 条件 | gate fact |
| --- | --- |
| valid manifest + valid runnerBinding（action set 可构造；audit resolve 成功） | **true** — 不论 `executeRequested` true/false、approval ready/not ready；**可独立于** registry resolve（非 catalog impl 时 registry false 但 adapter/anchor/audit true） |
| missing `runnerBinding`（API 现有：empty candidates） | **false** |
| invalid manifest/binding | 通道级 400 / CLI exit 1；**不**经 blocked helper |

### 5.2 Web：strict canonical fail-closed assembly

#### 设计原则

Web **不得**仅因 `auditEntries.length >= 1`、单字段 contract status、或 `gates.attemptAuditReady` 孤值就显示 ready。
**共享单一 canonical predicate**（下称 `canonicalAttemptAuditReady`）：wiring line、audit line、`validationLines.attemptAuditReady` **必须**基于同一 boolean。

最后一项 contract（operator-recovery）**永远不能**被 payload 推成 ready。
`runner-registry` 继续使用 V1.25 的 `canonicalRunnerRegistryReady`。
`host-mutation-adapter` 继续使用 V1.26 的 `canonicalHostMutationAdapterReady`。
`rollback-anchor` 继续使用 V1.27 的 `canonicalRollbackAnchorReady`。
四者 **不得**混用。

#### 共享单一 canonical predicate（C ∧ A ∧ G ∧ D）

记：

- `C` = `requiredContracts` 中 `id === 'attempt-audit'` 的那一项
- `A` = `runnerWiringContract.attemptAuditReadiness`
- `G` = `gates.attemptAuditReady`
- `D` = `payload.auditDecision`

```js
function isCanonicalAttemptAuditReady({ C, A, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'attempt-audit-ready' &&
    C?.requiredForExecution === true &&
    A?.state === 'ready' &&
    A?.attemptAuditReady === true &&
    A?.codeOwnedAuditResolverReady === true &&
    A?.realAttemptAuditImplementationReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.auditReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realAttemptAuditImplementationReady === false &&
    D?.wouldPersistAudit === false &&
    D?.wouldWriteLog === false &&
    D?.wouldWriteAudit === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false &&
    D?.auditWriteAllowed === false &&
    D?.metadataWriteAllowed === false &&
    D?.filesystemWriteAllowed === false &&
    D?.immutableAuditReady === false
  );
}
```

**canonical ready 当且仅当** `isCanonicalAttemptAuditReady(...) === true`。
任一 missing / invalid / contradictory / side-effect flag true（含 `D.wouldPersistAudit===true` 或 `D.wouldWriteLog===true` 或任一 `*Allowed===true`）→ **false**。

#### Wiring contract lines（attempt-audit）

- 从 `WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS` **移除** `attempt-audit`（只留 `operator-recovery`）。
- **ready 当且仅当** `canonicalAttemptAuditReady === true` →
  `wiringContract:attempt-audit:status:ready:requiredForExecution:true:blocker:none`
- **否则固定** →
  `wiringContract:attempt-audit:status:blocked:requiredForExecution:true:blocker:attempt-audit-missing`
  （canonical blocked；**不**回显 payload blocker / secret 原文）
- 最后一项 `operator-recovery`：仍 **固定** canonical missing blocked。
- `execution-policy` / `runner-registry` / `host-mutation-adapter` / `rollback-anchor`：保持既有分支。

#### Attempt-audit readiness line（同一 boolean）

- **ready 当且仅当** `canonicalAttemptAuditReady === true`：

```text
attemptAudit:code-owned-attempt-audit:state:ready:codeOwnedResolverWired:true:realAttemptAuditImplementationReady:false:wouldPersistAudit:false:wouldWriteLog:false:blocker:none
```

  必须显式含 `realAttemptAuditImplementationReady:false`、`wouldPersistAudit:false` 与 `wouldWriteLog:false`，避免 “ready = 可持久化审计” 误导。

- **否则固定 blocked**（始终输出恰好一行）：

```text
attemptAudit:code-owned-attempt-audit:state:blocked:codeOwnedResolverWired:true:realAttemptAuditImplementationReady:false:wouldPersistAudit:false:wouldWriteLog:false:blocker:attempt-audit-not-ready
```

  **不得**泄漏 `OPAQUE_UNSAFE_FIELD` / secret-like auditKind / 恶意 wouldPersistAudit 原文。
  **禁止**继续渲染 `disabled-attempt-audit-stub` 作为 V1.28 正常路径文案（恶意 payload 注入 stub kind 时仍输出上列 fixed blocked 行，不回显 payload kind）。

#### validationLines（同一 boolean）

- `attemptAuditReady:true` **当且仅当** `canonicalAttemptAuditReady === true`；否则 `attemptAuditReady:false`
- **禁止**仅 `gates.attemptAuditReady===true` 就渲染 true
- 始终固定 `executionEligible:false`、`operatorRecoveryReady:false`、`realRunnerWiringReady:false`、`runnerWiringContractReady:false`
- `runnerRegistryReady` / `hostMutationAdapterReady` / `rollbackAnchorReady` 继续用各自独立 canonical boolean

#### 强制 case：C/A/G 表面 ready、D.wouldPersistAudit=true（side-effect 漂移）

当 `C`/`A`/`G` 均表面 ready，且 `D.state==='resolved' && D.auditReady===true`，但 `D.wouldPersistAudit===true`（或 `D.wouldWriteLog===true` 或任一 `*Allowed===true` / would* true / `immutableAuditReady===true`）时：

- `canonicalAttemptAuditReady === false`
- wiring line：**blocked** + `attempt-audit-missing`
- audit line：**blocked** + `attempt-audit-not-ready`
- validation：`attemptAuditReady:false`
- operator-recovery 仍 blocked
- **不得**出现任何 attempt-audit / attemptAudit **ready** 行
- 敏感/恶意值不回显

#### policyDecision line

- 保持 V1.24：**强制 denied**
- primaryBlocker 仅 allowlist 透传展示（ready path 展示 `operator-recovery-not-ready`）

---

## 6. 版本 / README / Gold

- `LINKE_RELEASE_VERSION = 'V1.28'`
- README 标题、badge、version table：V1.28 当前，V1.27 历史
- Gold evidence 添加：`resolveSupervisorLifecycleGuardedRunnerAttemptAudit`、`attemptAuditReadiness.state:ready`、`attemptAuditReady:true`、`codeOwnedAuditResolverReady:true`、`codeOwnedResolverWired`、`attempt-audit-ready`、`realAttemptAuditImplementationReady:false`、`auditDecision`、`readyCount:5`/`blockedCount:1`
- 移除作为 **当前缺口** 的 `attempt-audit-real-implementation-missing` / `attempt-audit-missing`（历史叙述可保留）
- nextStep 指向 **operator-recovery**（并明确：真实 attempt audit persist/log 仍缺失；真实 rollback write/restore 仍缺失；真实 host mutation implementation 仍缺失）
- Gold 仍 `blocked`；`runnerWiringContractReady:false`；G0a PASS 不变

---

## 7. 安全与非目标

### 安全

- 全路径无 host mutation / runner dispatch / launchctl / shell / process list / fs write / metadata / audit persist / log write / NAS / network / 真实 rollback write/restore
- fixture 禁止：用户名形态绝对路径、SSH 路径形态、具体 IP/CIDR、真实邮箱、真实 command 名、credential 形态、64-hex digest
- 恶意 fixture 仅 opaque synthetic（`UNSAFE_SECRET_MATERIAL`、`OPAQUE_UNSAFE_FIELD`）
- 敏感扫描只报类别计数，不回显匹配行
- 输出深拷贝
- caller override（`options.auditDecision` / `options.attemptAuditReady` / `options.auditContext`）必须忽略

### 非目标

- **不实现真实 attempt audit persist / log write / immutable audit**
- **不实现真实 host mutation adapter execution**（V1.26 遗留；本版不推进）
- **不实现真实 rollback anchor write / restore**（V1.27 遗留；本版不推进）
- 不实现最后一项 wiring 真实能力（operator-recovery）
- 不调度/调用 runner
- 不把 executionEligible 或 Gold 变 ready
- 不把 `runnerWiringContractReady` 变 true
- 不设 `realAttemptAuditImplementationReady:true` / `wouldPersistAudit:true` / `wouldWriteLog:true` / `wouldWriteAudit:true` / 任一 `*Allowed:true` / `immutableAuditReady:true`
- 不设 `realHostMutationImplementationReady:true` / `wouldMutateHost:true`
- 不设 `realRollbackAnchorImplementationReady:true` / `wouldWriteAnchor:true` / `wouldRestore:true`
- 不声称可证明拒绝所有 Proxy
- 不改 V1.24 actionCandidates helper 契约
- 不改 V1.25 registry resolver 映射/redacted 契约
- 不改 V1.26 adapter resolver 映射/unsafe 契约
- 不改 V1.27 anchor resolver 映射/unsafe 契约
- 不修改 `src/agent.js` / `src/server.js` / `package.json`
- 不设计真实 recovery supervisor（仅 auditKind 映射可解析）
- 不调用既有 `appendAuditEvent` / 不写 `dataDir/audit/events.jsonl`

### 下一步（显式非本版）

1. operator-recovery code-owned contract（V1.28 之后的下一个 wiring Gold blocker）
2. 真实 attempt audit persist / immutable log implementation（在 restricted pure data plan 之后，仍须独立设计）
3. 真实 host mutation implementation（在 restricted adapter 之后）
4. 真实 rollback anchor write/restore implementation（在 restricted pure data plan 之后）
5. 任一真实 side effect 前必须有独立设计证明不会越界；默认仍保持 Gold blocked 直到证明完成

---

## 8. Scope 文件列表（基于实际 rg，非猜测）

对以下硬编码/断言模式做了仓库扫描（排除 `node_modules` / `.git` / 本设计 docs）：

`attempt-audit-missing`、`attempt-audit-real-implementation-missing`、`disabled-attempt-audit-stub`、`attemptAuditReady:false`（gate hardcode）、`realAttemptAuditReady`、`readyCount:4`+`blockedCount:2`（wiring 级）、`attempt-audit-not-ready`（ready-path primary）、Web `attemptAudit:` / `wiringContract:attempt-audit` 行、version/README/Gold V1.27 当前标记。

### 允许修改（实现阶段）— 仅下列文件

| 文件 | 原因（rg 命中） |
| --- | --- |
| `src/supervisor-lifecycle.js` | resolver/readiness/wiring/gate 实现与常量 |
| `src/web/app.js` | wiring/audit lines + validationLines + canonical predicate |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | pure/gate/readiness/wiring 断言 |
| `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` | API 透传断言 |
| `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` | CLI JSON 断言（**不改** `src/agent.js`） |
| `test/web-console.test.js` | Web assembly / 恶意 payload |
| `src/version.js` | `V1.28` |
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

### Side-effect scan（实现差分相对 b42f57c）

```bash
git diff b42f57c -- src/supervisor-lifecycle.js | rg -n \
  'launchctl|child_process|execSync|spawn\(|exec\(|fs\.(write|rm|unlink|mkdir)|process\.kill|net\.|http\.|https\.|appendAuditEvent' \
  && echo 'FAIL: side-effect call pattern in diff' || echo 'ok: no side-effect pattern in lifecycle diff'
```

### Sensitive category count only

```bash
git diff b42f57c -- src/ test/ | rg -c \
  'ssh-rsa|BEGIN (RSA |OPENSSH )?PRIVATE|AKIA[0-9A-Z]{16}|[0-9a-f]{64}' \
  || true
# 期望：无命中；若有命中只报告 count，不得 cat 原文
```

### Scope / anchor 核对（无写入；不要 hard reset）

```bash
git merge-base --is-ancestor b42f57c HEAD && echo 'anchor-ok'
git rev-parse HEAD
git diff --name-only b42f57c --
git status --short
git diff --name-only b42f57c -- src/agent.js src/server.js package.json
# 期望：禁止文件无输出
```

允许修改文件名必须 ⊆ §8 列表。

---

## 10. 完成标准（实现阶段验收）

1. pure resolver 全矩阵 **T1–T28** GREEN；all-or-nothing（含 unresolved 时 `unresolvedCount` 恒 0，非漏计）；深拷贝；稳定 blocker 序（含 T28：duplicate 优先于 unsafe）。
2. readiness fixed ready + entry exact；entry `auditKind:'code-owned-attempt-audit'` 仅为 catalog-level 汇总标识（≠ audit 行 action-level kind）；旧键不残留。
3. wiring `readyCount:5` / `blockedCount:1`；`attempt-audit` contract ready；`operator-recovery` 仍 blocked。
4. production gate ready path：`gates.attemptAuditReady:true`，`auditDecision` resolved，primary=`operator-recovery-not-ready`，`executionEligible:false`，`runnerWiringContractReady:false`。
5. API/CLI/Web 透传与 C∧A∧G∧D 一致；恶意 side-effect drift fail-closed；Web 替换 `buildSupervisorLifecycleGuardedRunnerAttemptAuditLines` 本体及旧 stub 文案。
6. version/README/Gold → V1.28；Gold 仍 blocked；G0a PASS 不变。
7. 无 fs/network/process/shell/launchctl/appendAuditEvent 副作用；禁止文件未改。
8. **不**宣称 `runnerWiringContractReady:true` 或 Gold ready。
