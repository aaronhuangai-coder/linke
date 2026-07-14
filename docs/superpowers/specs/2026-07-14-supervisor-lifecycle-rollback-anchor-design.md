# V1.27 Supervisor Lifecycle Rollback Anchor Design

## 目标

V1.27 用 **code-owned、纯函数、fail-closed、受限（restricted）rollback-anchor resolver / readiness contract** 替换 V1.20 的 disabled rollback anchor stub。本版本把 `rollback-anchor` required contract 从 `blocked/false` 推进为 `ready/true`，并在 execution gate 内基于 **production-derived sanitized `actionCandidates` + allowlisted `operation`** 调用 pure resolver，返回 sanitized `anchorDecision`，把 policy context 的 `rollbackAnchorReady` fact 接成严格验证后的本地 boolean。

本版完成的是 **纯数据锚点计划校验（pure data anchor plan validation）**：只核验 action 集合是否能映射到 code-owned 固定 `anchorKind` 标识符表。它 **不** 写任何 rollback anchor 文件/metadata，**不** 恢复 previous plist，**不** 触发 host mutation。

### 关键边界（必须先读）

| 层级 | V1.27 是否完成 | 含义 |
| --- | --- | --- |
| **restricted rollback-anchor contract / readiness** | **是** | code-owned action→anchorKind 映射可核验；readiness/contract ready；gate 可在合法 candidates 上得到 `rollbackAnchorReady:true` |
| **real rollback anchor write / restore / host mutation** | **否** | 不写 filesystem/metadata/audit；不 restore；不调用 launchctl / shell / process list / network；`realRollbackAnchorImplementationReady` 恒 false；`wouldWriteAnchor` / `wouldRestore` / 全部 `*Allowed` 恒 false |
| **real host mutation implementation（V1.26 遗留）** | **否** | V1.26 的 `realHostMutationImplementationReady:false` **不** 因本版变 true |

**不得**把 pure data anchor plan / readiness ready 冒充真实 rollback write、restore 或 host mutation。下一步（V1.28+）仍需 attempt-audit / operator-recovery，以及后续独立的真实 host mutation implementation 与真实 rollback anchor write/restore。**Gold 继续 blocked。**

V1.27 **必须继续保持**：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`
- `realRunnerWiringReady:false`
- 后两项 wiring facts false（attemptAudit / operatorRecovery）
- gate 顶层：`executionEligible:false`、`executorReady:false`、`wouldExecute:false`（**gate 顶层没有** `wouldRun` / `wouldWrite` / `wouldWriteAnchor`）
- 副作用 would* 在其真实 locus 恒 false：`policyDecision.wouldRun/wouldWrite`、`registryDecision` would*、`adapterDecision` would* / `wouldMutateHost` / 全部 `*Allowed`、`anchorDecision` would* / `wouldWriteAnchor` / `wouldRestore` / 全部 `*Allowed`、`actionCandidates[]` 每项 would*、readiness entry / anchor 行 would*
- `realHostMutationImplementationReady:false`（V1.26 字段，本版不抬升）
- `real-guarded-runner-execution-wiring-missing`
- Gold readiness: `blocked`
- G0a 真实双机 PASS 声明不变

V1.27 **必须改变**：

- `rollbackAnchorReady:true`（readiness 固定 true；production gate fact 仅在 resolver 对 production candidates 解析成功时为 true）
- `rollbackAnchorReadiness.state:'ready'` + `codeOwnedAnchorResolverReady:true` + `realRollbackAnchorImplementationReady:false`
- `runnerWiringContract.requiredContracts[3]`（`rollback-anchor`）→ `status:'ready'`、`blockerCode:null`、`evidenceCode:'rollback-anchor-ready'`
- `runnerWiringContract.readyCount:4`、`blockedCount:2`
- production gate 返回 sanitized `anchorDecision`；`rollbackAnchorReady` 为本地 boolean
- 后二 wiring 仍 false → production `policyDecision` **始终 deny**；各 locus 副作用字段全 false
- ready production path primaryBlocker 从 V1.26 的 `rollback-anchor-not-ready` **迁移为** `attempt-audit-not-ready`

**不得**调度/调用 runner；不得 host shell / process-control / fs / metadata / audit / approval / 真实 rollback write/restore / NAS / 网络副作用。不新增 endpoint、CLI command、Web button、request body field。**禁止修改** `src/agent.js` / `src/server.js` / `package.json`。不得接受 request/CLI/Web 直传的 `anchorDecision` / `anchorContext` / `rollbackAnchorReady` override。

**恢复锚点：** `8e89403`（`feat: add V1.26 host mutation adapter contract`）。实现越界时回到该 commit 的干净状态再重做（见 §9 无写入核对；**禁止**在 plan/docs 中建议 `git reset --hard` 作为常规步骤）。

### 副作用 / 资格字段 locus（禁止“全部对象都有全部字段”误读）

| 字段 | 所在对象（唯一合法 locus） | V1.27 |
| --- | --- | --- |
| `executionEligible` | **仅** gate 顶层 | 恒 `false` |
| `wouldExecute` | gate 顶层；**另**见于 `registryDecision`、`adapterDecision`、`anchorDecision`、`actionCandidates[]`、readiness entry、anchor 行 | 恒 `false` |
| `wouldRun` / `wouldWrite` | **不在** gate 顶层；见于 `policyDecision`、`registryDecision`、`adapterDecision`、`anchorDecision`、`actionCandidates[]`、readiness entry、anchor 行 | 恒 `false` |
| `wouldWriteAnchor` / `wouldRestore` | **仅** `anchorDecision`、anchor readiness entry、anchor 行 | 恒 `false` |
| `filesystemWriteAllowed` / `metadataWriteAllowed` / `rollbackAnchorWriteAllowed` / `rollbackRestoreAllowed` | **仅** `anchorDecision`、entry、anchor 行 | 恒 `false` |
| `wouldMutateHost` / adapter `*Allowed` | **仅** `adapterDecision` 等 V1.26 locus | 保持 V1.26 恒 `false`（本版不改语义） |
| `gates.rollbackAnchorReady` | `gates` 对象 | production resolve 成功时 true；否则 false |
| `rollbackAnchorReady`（readiness 级） | `rollbackAnchorReadiness` / readiness builder | 固定 true（≠ gate fact） |
| `gates.hostMutationAdapterReady` | `gates` 对象 | **保持 V1.26 语义**（不回退） |
| `gates.runnerRegistryReady` | `gates` 对象 | **保持 V1.25 语义**（不回退） |

**禁止**断言 `result.wouldRun` / `result.wouldWrite` / `result.wouldWriteAnchor` / `result.wouldRestore`（gate 顶层不存在这些字段）。断言 must 按上表 locus 精确落点。

---

## 设计选择总览

| 组件 | V1.20 / V1.26 | V1.27 |
| --- | --- | --- |
| anchor catalog | disabled stub | code-owned 固定 actionId→anchorKind 受限映射表 |
| resolver | 无 | 公开 pure `resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, operation)` |
| readiness | disabled, ready=false | fixed ready evidence, ready=true |
| required contract `rollback-anchor` | blocked + missing | ready + `blockerCode:null` + `evidenceCode:'rollback-anchor-ready'` |
| wiring readyCount / blockedCount | 3 / 3 | **4 / 2** |
| gate `rollbackAnchorReady` | hardcoded false | readiness + production-derived resolver 本地 boolean |
| gate `anchorDecision` | 无 | production candidates → resolver → sanitized decision |
| `realRollbackAnchorImplementationReady` | false（旧名 `realRollbackAnchorReady`） | **仍 false**（无真实 write/restore） |
| decision 字段名 | — | `codeOwnedResolverWired:true`（见 §2.3；≠ readiness 字段） |
| production policy primary | `rollback-anchor-not-ready` | **`attempt-audit-not-ready`**（合法 ready path） |
| gate 顶层 `executionEligible` / `wouldExecute` / Gold | false / blocked | 不变 |

### 为何本版把 required contract 置 ready（而不是只加 resolver 不改 contract）

与 V1.25 `runner-registry` / V1.26 `host-mutation-adapter` 对称：required contract ready **仅**表示 **code-owned restricted pure data anchor contract/readiness 已接线且可核验**，**不**表示真实 rollback write/restore 或 host side effect 可执行。若只加 pure resolver 而 contract 仍 blocked，则 wiring 计数/primary blocker 无法前进，且与 V1.24–V1.26 的“contract ready = code-owned pure contract ready”语义不一致。

真实 rollback implementation 用 **独立字段** 表达并恒 false：

- readiness：`realRollbackAnchorImplementationReady:false`
- decision / entry / anchor 行：`realRollbackAnchorImplementationReady:false`、`wouldWriteAnchor:false`、`wouldRestore:false`、全部 `*Allowed:false`

### 与 V1.26 adapter 的分层（intentional layered fail-closed）

| 层 | 公开 API | 信任边界 | ready 含义 | 不授权 |
| --- | --- | --- | --- | --- |
| V1.24 | `areSupervisorLifecycleGuardedRunnerActionCandidatesReady` | shape + maxAttempts `1..3` **或** `'[redacted]'` | structural candidates ready | 不授权 registry/adapter/anchor/execution |
| V1.25 | `resolveSupervisorLifecycleGuardedRunnerRegistry` | actionId 集合 + catalog implementationId + numeric maxAttempts | registry mapping 可核验 | 不授权 host mutation / anchor write / execution |
| V1.26 | `resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter` | actionId 集合 + status/would* false；**忽略** implementationId / maxAttempts 值 | restricted mutationKind 映射可核验 | 不授权真实 host mutation / launchctl / fs |
| **V1.27** | `resolveSupervisorLifecycleGuardedRunnerRollbackAnchor` | actionId 集合 + status/would* false；**忽略** implementationId / maxAttempts 值；**不读** mutationKind / adapterDecision | restricted **纯数据** anchorKind 映射可核验 | 不授权 anchor write/restore、host mutation、execution |

**分层失败矩阵（production gate 必须可测）：**

| 场景 | actionCandidatesReady | registryDecision | adapterDecision | anchorDecision | gates.runnerRegistryReady | gates.hostMutationAdapterReady | gates.rollbackAnchorReady | policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 合法 catalog + numeric maxAttempts + would* false | true | resolved | resolved | resolved | true | true | true | deny，primary=`attempt-audit-not-ready`，**不含** `rollback-anchor-not-ready` / `host-mutation-adapter-not-ready` / `runner-registry-not-ready` |
| 合法格式非 catalog `implementationId` | true | unresolved | **resolved** | **resolved** | **false** | **true** | **true** | deny，含 `runner-registry-not-ready`；**不含** adapter/anchor not-ready |
| maxAttempts `'[redacted]'` | true | unresolved | **resolved** | **resolved** | **false** | **true** | **true** | deny，含 `runner-registry-not-ready` |
| empty / missing binding candidates | false | unresolved | unresolved | unresolved | false | false | false | deny，含 registry/adapter/anchor not-ready（或更上游） |
| pure-only unsafe would* true | — | — | unresolved（adapter） | unresolved（anchor） | — | — | — | pure 覆盖；gate 不强制 production 构造 would* true |

**关键不变量：**

1. V1.27 **不**修改 V1.24 / V1.25 / V1.26 的 public 契约语义。
2. Anchor resolver **不得**读取 `adapterDecision` / `registryDecision` / `mutationKind` / request override。
3. Anchor ready **绝不**把 `wouldWriteAnchor` / `wouldRestore` / `executionEligible` / `wouldMutateHost` 变 true。
4. Adapter 与 Anchor 对同一合法 production candidates 应可同时 resolved；对 non-catalog / redacted 路径两者可 resolved 而 registry unresolved（intentional）。

---

## 1. 纯函数 rollback-anchor resolver

### 1.1 导出（稳定 public pure API）

```js
/**
 * Resolve and verify sanitized guarded-runner action candidates against the
 * code-owned restricted rollback-anchor mapping table (pure data plan only).
 *
 * Ready resolution means only that every candidate actionId maps to the fixed
 * restricted anchorKind for the given operation. It does NOT write anchors,
 * restore previous state, execute launchctl/shell/filesystem/process/metadata/
 * audit/network; does NOT set wouldWriteAnchor / wouldRestore / *Allowed /
 * wouldExecute/wouldRun/wouldWrite true; does NOT imply
 * realRollbackAnchorImplementationReady, realHostMutationImplementationReady,
 * or executionEligible.
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
export function resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, operation)
```

| 项 | 要求 |
| --- | --- |
| 可见性 | **export**；公共 JSDoc 声明语义与非执行边界 |
| 参数 | **仅** `candidates` + `operation`；不读 request/options/fs/env/manifest/runnerBinding/registryDecision/adapterDecision；不接受 caller-supplied anchorDecision |
| 返回 | 仅 plain object（深拷贝）；不返回 function / Promise / command / path / host / token / hash / raw error |
| 副作用 | 无 |
| 真值 | `state:'resolved'` 且 `anchorReady:true` **仅**表示受限 pure data anchor 映射核验通过 |
| 假值 | invalid / mismatch / unsafe / trap → `state:'unresolved'` + 单一 exact allowlisted primary blocker |

**命名：** 采用 `resolve...RollbackAnchor`（resolve/readiness，不暗示 write/restore/execute）。拒绝 `writeRollbackAnchor` / `restoreFromAnchor` / `applyRollback` / `dispatch...`。

### 1.2 输入：candidates + operation

`operation` 必须是 string 且 ∈ `{'install','uninstall','rollback','recover'}`；否则 unresolved + **唯一** blocker `rollback-anchor-operation-invalid`，decision.`operation` 输出 **`'unknown'`**（**仅此路径** 输出 unknown）。

**decision.operation 回显规则（禁止“所有 unresolved → unknown”）：**

| 输入 operation | 结果 state | decision.`operation` |
| --- | --- | --- |
| allowlisted（`install` / `uninstall` / `rollback` / `recover`） | resolved **或** unresolved（candidates/集合/unsafe 等任意失败） | **回显同一合法 operation 字符串** |
| 非 allowlisted / 非 string / 缺失等 | unresolved + `rollback-anchor-operation-invalid` | **`'unknown'`**（schema 唯一 unknown 来源） |

测试 helper `assertAnchorUnresolvedExact(decision, primaryBlocker, operation)` 的第三参 **必传**、禁止默认 `'unknown'`；合法 operation 输入的 unresolved 用例一律传对应合法 operation；**仅** invalid-operation 传 expected `'unknown'`。

`candidates` 输入 **不是** “长度必须 equal `|E|`” 的 structure precondition。容器合法（array、非 empty、元素可快照）后，长度/集合偏差走 §1.6 集合类 blocker；**仅** `state:'resolved'` 成功时要求 actionId 集合与 expected set **exact match**（因而 `anchors.length === |E|`）。

结构入口（与 V1.25/V1.26 容器策略同形，blocker 前缀换为 `rollback-anchor-`）：

1. 非 array / null / type-confusion → `rollback-anchor-candidates-invalid`
2. empty array（`len < 1`）→ `rollback-anchor-candidates-invalid`
3. 容器 trap / 元素 shape / exact-key 偏差 / accessor / trap / type-confusion → `rollback-anchor-candidates-invalid`
4. **snapshot 后** `actionId` 非「非空 string」（含 `''`、number、boolean、null、object 等）→ **唯一** `rollback-anchor-candidates-invalid`（**先于** duplicate / unknown / missing）
5. **长度 ≠ `|E|` 本身绝不能直接变** `candidates-invalid`（非 empty、元素 schema 过了、且每项 `actionId` 已是非空 string 之后，一律进入 duplicate → unknown → missing）

每个合法元素通过 §1.4 的 best-effort exact-key plain data property 单次快照。

#### Candidate exact keys（与 V1.25/V1.26 sanitized gate action candidate contract 一致）

```text
actionId, implementationId, runnerKind, mode, status,
wouldExecute, wouldRun, wouldWrite, maxAttempts
```

- 顺序无关；元素 **键集合** 多一个、少一个、同名原型污染键 → `rollback-anchor-candidates-invalid`
- 无 own getter / accessor：每个 own key **恰好一次** `Object.getOwnPropertyDescriptor`，必须是 data property
- `Object.getPrototypeOf(element) === Object.prototype` 或 `=== null`
- descriptor / `ownKeys` throw → `rollback-anchor-candidates-invalid`；**不得**把 raw error message / stack / trap 返回值写入 decision

#### Anchor 对 candidate 字段的信任边界（intentional layered fail-closed）

| 字段 | Anchor 是否用于 ready resolve | 说明 |
| --- | --- | --- |
| `actionId` | **是** | 集合与 `buildLifecycleActions(operation)` expected set exact match；映射 anchorKind |
| `status` / `wouldExecute` / `wouldRun` / `wouldWrite` | **是** | 必须 exact `status:'blocked'` 且三 would* exact `false`；否则 **唯一** `rollback-anchor-unsafe-anchor` |
| `implementationId` / `runnerKind` / `mode` / `maxAttempts` | **否（忽略值内容）** | 仍须存在于 exact-key shape；**不**因非 catalog implementationId / redacted maxAttempts / runnerKind 偏差而 unresolved |

**分层结论（与 V1.25 registry / V1.26 adapter 对称）：**

| 场景 | `actionCandidatesReady`（V1.24） | `registryDecision`（V1.25） | `adapterDecision`（V1.26） | `anchorDecision`（V1.27） |
| --- | --- | --- | --- | --- |
| 合法 catalog + numeric maxAttempts + would* false | true | resolved | resolved | resolved |
| 合法格式非 catalog `implementationId` | true | unresolved | **resolved** | **resolved** |
| maxAttempts `'[redacted]'` | true | unresolved | **resolved** | **resolved** |
| wouldExecute/wouldRun/wouldWrite true 或 status≠blocked | 视 helper | 可能 unresolved | unresolved + adapter-unsafe | **unresolved** + `rollback-anchor-unsafe-anchor` |

这是 **intentional layered fail-closed**，不是 bug。Anchor ready **绝不**授权 write/restore 或抬升 `executionEligible`。

### 1.3 Code-owned 固定 action → anchorKind 映射表

Anchor **只信任** `src/supervisor-lifecycle.js` 内冻结表。manifest / runnerBinding / request / CLI / Web / executionPreview / approval / config / env / fs / caller-supplied decision / `registryDecision` / `adapterDecision` **一律不可**注入 ready。

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

#### 1.3.2 固定 anchorKind 映射（identifiers only — pure data plan）

下列 ID 是 **restricted pure data anchor plan identifiers only**——不是文件路径、不是可写 blob、不是 host executor、不是 shell/launchctl argv。仓库中 **不存在**真实 rollback anchor write/restore implementation。

| actionId | anchorKind | plannedAnchorSurface（元数据标签 only，**不**授权） |
| --- | --- | --- |
| `render-launch-agent-plist` | `render-plist-anchor` | `none` |
| `write-launch-agent-plist` | `write-plist-anchor` | `filesystem-metadata` |
| `load-launch-agent` | `load-agent-anchor` | `launchctl-state` |
| `unload-launch-agent` | `unload-agent-anchor` | `launchctl-state` |
| `remove-launch-agent-plist` | `remove-plist-anchor` | `filesystem-metadata` |
| `remove-supervisor-metadata` | `remove-metadata-anchor` | `metadata` |
| `capture-current-state` | `capture-state-anchor` | `process-list-read` |
| `restore-previous-plist` | `restore-plist-anchor` | `filesystem-metadata` |
| `restart-previous-supervisor` | `restart-supervisor-anchor` | `launchctl-state` |
| `start-recovery-supervisor` | `recovery-supervisor-anchor` | `launchctl-state` |

- `plannedAnchorSurface` **不得**写入 decision 输出（避免 UI/测试把标签当成 permission）。仅存在于源码常量注释或内部表；对外 anchor 行 **只**含 `anchorKind` + 恒 false flags。
- **install** 三 actionId 与既有 gate fixture 兼容。
- uninstall / rollback / recover 映射仅供 pure unit tests；**不**表示已有 write/restore executor。

#### 1.3.3 anchorKind allowlist

```js
const ROLLBACK_ANCHOR_KIND_ALLOWLIST = Object.freeze([
  'render-plist-anchor',
  'write-plist-anchor',
  'load-agent-anchor',
  'unload-agent-anchor',
  'remove-plist-anchor',
  'remove-metadata-anchor',
  'capture-state-anchor',
  'restore-plist-anchor',
  'restart-supervisor-anchor',
  'recovery-supervisor-anchor',
]);
```

输出 anchor 行的 `anchorKind` **必须** ∈ 该 allowlist，且 **exact equal** 上表对 actionId 的固定值。实现不得从 input 读取 anchorKind（input candidate **无** anchorKind 键；多键 → candidates-invalid）。

#### 1.3.4 recover

`recover` 仅一 action：`start-recovery-supervisor` → `recovery-supervisor-anchor`。V1.27 **不**设计/执行真实 recovery supervisor 或 recovery anchor write，不解除既有 apply-path blockers。Anchor 仅允许映射解析为 `resolved`；绝不因此把 would* / wouldWriteAnchor / wouldRestore / *Allowed / executionEligible 变 true。

### 1.4 单次快照 / Proxy 边界（准确声明）

**JavaScript 无法可靠识别所有 `Proxy`。** 本设计 **不声称**可证明拒绝所有 Proxy。

与 V1.25 §1.4 / V1.26 §1.4 **同策略**：

1. 容器：`try/catch` + `Array.isArray` + 一次 `length` + 一次索引读到本地 `elements[]`；**禁止**再触碰原容器；**不**对 array 做 descriptor purity 声称。
2. 元素：`ownKeys` 一次；exact key allowlist；每 key **恰好一次** descriptor → data property → 本地 snapshot；**禁止** check-then-二次读。
3. trap throw / getter / type-confusion → `rollback-anchor-candidates-invalid`。

#### 生产路径三层防御

| 层 | 约束 |
| --- | --- |
| L1 Gate 构造 | candidates **只来自** `buildGuardedRunnerExecutionGateActionCandidates`；operation 来自 allowlisted plan/preview；不接收 request/options anchor bag |
| L2 Resolver | best-effort 容器快照 + 元素 exact-key snapshot + code-owned anchor map；非法/unsafe → unresolved |
| L3 副作用恒 false | 任意 decision：`wouldWriteAnchor` / `wouldRestore` / 全部 `*Allowed` / `wouldExecute/wouldRun/wouldWrite` / `realRollbackAnchorImplementationReady` 恒 false；gate top-level `executionEligible/wouldExecute` 在 V1.27 亦恒 false |

### 1.5 Decision 输出 schema（exact）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-rollback-anchor',
  operation: <allowlisted input echoed, OR 'unknown' only when operation-invalid>,
  state: 'resolved' | 'unresolved',
  anchorReady: boolean,                      // true only when fully resolved
  codeOwnedResolverWired: true,              // 见 §2.3：单次 decision 表示 resolver 路径已接线，恒 true
  realRollbackAnchorImplementationReady: false, // V1.27 恒 false
  wouldWriteAnchor: false,                   // V1.27 恒 false
  wouldRestore: false,                       // V1.27 恒 false
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  filesystemWriteAllowed: false,             // V1.27 恒 false
  metadataWriteAllowed: false,               // V1.27 恒 false
  rollbackAnchorWriteAllowed: false,         // V1.27 恒 false
  rollbackRestoreAllowed: false,             // V1.27 恒 false
  resolvedCount: number,
  unresolvedCount: number,
  anchors: [ /* 见下 */ ],
  primaryBlocker: string | null,
  blockers: string[],
  nextBlockers: string[],
  sensitiveValuesReturned: false,
  safety: executionPreviewSafety(),
}
```

**命名：** 使用 `codeOwnedResolverWired`，**不用** `codeOwnedResolverReady`。后者易与 readiness 的 `codeOwnedAnchorResolverReady` 混淆。

**字段名 `anchorReady`（decision）≠ readiness `rollbackAnchorReady`：** decision 级表示本次 pure data 映射核验；readiness 级表示产品 contract 固定 ready。

#### anchors 行 schema（**仅** resolved 时非空；**不含** `codeOwnedResolverWired`）

```js
{
  actionId: string,                    // expected 序第 i 项
  anchorKind: string,                  // catalog exact；∈ ROLLBACK_ANCHOR_KIND_ALLOWLIST
  anchorReady: true,
  realRollbackAnchorImplementationReady: false,
  wouldWriteAnchor: false,
  wouldRestore: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  filesystemWriteAllowed: false,
  metadataWriteAllowed: false,
  rollbackAnchorWriteAllowed: false,
  rollbackRestoreAllowed: false,
  blockerCode: null,
  evidenceCode: 'rollback-anchor-plan-ready',
}
```

测试：`assertAnchorResolved` 对每一 anchor row 必须断言上表 **全部** 字段；不得用模糊注释占位。

#### resolved / unresolved 的 exact 计数字段（防泄漏、无二义）

V1.27 为 **all-or-nothing** 解析（不做部分 resolved）：

| 结果 | `resolvedCount` | `unresolvedCount` | `anchors` |
| --- | --- | --- | --- |
| resolved | `expectedActionCount(operation)` | `0` | 长度 = expected；顺序 = expected action 序；每行 anchorReady true |
| **任意** unresolved（含 invalid/unsafe/trap） | `0` | `0` | `[]`（**永不**回显未信任输入行，**不**用恶意 input.length 填充计数） |

#### 一致语义

| 不变量 | 说明 |
| --- | --- |
| `state === 'resolved'` ⇔ `anchorReady === true` | 同真同假 |
| resolved ⇒ `blockers:[]`、`primaryBlocker:null`、`nextBlockers:[]`、`resolvedCount===expected`、`unresolvedCount===0`、`operation` 为 allowlisted 输入回显 | |
| unresolved ⇒ `blockers` 为 **单一 exact** allowlisted code 数组、`primaryBlocker===blockers[0]`、`nextBlockers===[primaryBlocker]`、`resolvedCount===0`、`unresolvedCount===0`、`anchors:[]` | |
| unresolved 且 primary ≠ `operation-invalid` ⇒ `decision.operation` **仍为** 输入 allowlisted operation | |
| unresolved 且 primary = `rollback-anchor-operation-invalid` ⇒ `decision.operation === 'unknown'` | schema **唯一** unknown 路径 |
| 任意 decision：wouldWriteAnchor / wouldRestore / *Allowed / would* / realRollbackAnchorImplementationReady 恒 false | anchor resolved ≠ write/restore |
| `codeOwnedResolverWired` 在 well-formed decision 上恒 true | 表示输出由 code-owned resolver 路径产生 |

### 1.6 Blocker vocabulary（收紧后 exact allowlist）

```js
const ROLLBACK_ANCHOR_BLOCKER_CODES = Object.freeze([
  'rollback-anchor-candidates-invalid',
  'rollback-anchor-operation-invalid',
  'rollback-anchor-action-missing',
  'rollback-anchor-action-duplicate',
  'rollback-anchor-action-unknown',
  'rollback-anchor-unsafe-anchor',
]);
```

**故意不引入（不可达 / 与分层冲突 / 与 adapter 重叠）：**

| 不引入码 | 原因 |
| --- | --- |
| `rollback-anchor-operation-mismatch` | 无独立于 operation-invalid / 集合校验的路径 |
| `rollback-anchor-action-extra` | 在 duplicate→unknown→missing 下由鸽笼原理覆盖 |
| `rollback-anchor-implementation-mismatch` | implementationId 校验属于 V1.25 registry，不在 anchor 信任边界 |
| `rollback-anchor-kind-mismatch` | input **无** anchorKind 字段；kind 仅由 code-owned 表输出 |
| `rollback-anchor-real-implementation-missing` | readiness ready 后由 `realRollbackAnchorImplementationReady:false` 表达；**不**再作为 readiness blockers 主码 |
| `rollback-anchor-adapter-not-ready` | anchor **不**依赖 adapterDecision；分层独立 |

#### 失败分类固定规则

| 类别 | 触发条件 | primaryBlocker |
| --- | --- | --- |
| 结构 invalid | 非 array；empty；容器/元素 shape / exact-key / accessor / trap / type-confusion；**snapshot 后 actionId 非非空 string** | **仅** `rollback-anchor-candidates-invalid` |
| 集合偏差 | 非 empty、元素 schema 已过、**且每项 actionId 已是非空 string**；actionId 集合与 E 不等 | 固定 **duplicate → unknown → missing** |
| unsafe anchor | 集合已与 E exact match 后，任一 candidate `status !== 'blocked'` **或** `wouldExecute/wouldRun/wouldWrite !== false` | **仅** `rollback-anchor-unsafe-anchor` |

**长度不等式：** `|A| !== |E|` **本身**绝不能直接映射为 `candidates-invalid`。pure 必须两侧覆盖：

| 侧 | pure case | 构造要点 | 唯一 primary |
| --- | --- | --- | --- |
| `len < \|E\|` | **A6** | install 子集 2 行（合法 shape） | `rollback-anchor-action-missing` |
| `len > \|E\|` | **A23** | fresh install 3 行 + 追加外来 `start-recovery-supervisor`（总长 4、无重复） | `rollback-anchor-action-unknown` |
| `len > \|E\|` | **A24** | fresh install 3 行 + 追加重复 `render-launch-agent-plist`（总长 4、有重复） | `rollback-anchor-action-duplicate` |

#### 评估顺序（稳定 primary；每失败类 **恰好一个** primary）

1. operation allowlist → `rollback-anchor-operation-invalid`
2. candidates 容器 / 元素 shape / exact keys / accessors / traps / type-confusion / empty → `rollback-anchor-candidates-invalid`（**不含** “长度 ≠ expected”）
3. **snapshot 后** 任一 `actionId` 非非空 string → **唯一** `rollback-anchor-candidates-invalid`（先于集合类）
4. duplicate actionId → `rollback-anchor-action-duplicate`
5. unknown actionId（∉ E）→ `rollback-anchor-action-unknown`
6. missing expected（A ⊆ E 且集合 ≠ E）→ `rollback-anchor-action-missing`
7. 集合已 exact match E 后，按 expected 序扫 snapshot：status / would* 非期望 → `rollback-anchor-unsafe-anchor`

多类同时成立时 **primary = 上表最先命中者**；`blockers` 输出至少含 primary；本版测试断言 **primary 与 blockers[0] exact 单一码**。

### 1.7 深拷贝 / 抗 mutation / caller override 防护

1. 调用后改 input → 已返回 decision 不变。
2. 改已返回 decision → 后续调用不受污染。
3. 输出为新对象；`anchors` / `blockers` / `nextBlockers` / `safety` 均为新数组/新对象。
4. 异常映射固定 blocker，不泄露原值 / raw error。
5. Gate **必须忽略** `options.anchorDecision` / `options.rollbackAnchorReady` / `options.anchorContext`（与 V1.25/V1.26 对 registry/adapter override 的防护同形）。即使 caller 传入 `rollbackAnchorReady:true` 或伪造 `anchorDecision.state:'resolved'`，gate 仍只使用 production-derived 本地 boolean。

---

## 2. Readiness helper

### 2.1 签名不变

```js
export function buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness()
```

无参数；忽略 runtime-looking 多余参数；不读 config/manifest/binding/preview/approval/env/fs。

### 2.2 输出 schema（exact）

**Top-level readiness exact keys（顺序固定；不多不少）：**

```text
command, state, rollbackAnchorDefined, rollbackAnchorReady,
codeOwnedAnchorResolverReady, realRollbackAnchorImplementationReady,
readyCount, blockedCount, anchorEntries, blockers, nextBlockers, safety
```

```js
{
  command: 'supervisor-lifecycle-guarded-runner-rollback-anchor-readiness',
  state: 'ready',
  rollbackAnchorDefined: true,
  rollbackAnchorReady: true,                    // readiness 固定 true（≠ gate fact）
  codeOwnedAnchorResolverReady: true,           // readiness 级：resolver contract 已 ready
  realRollbackAnchorImplementationReady: false, // 唯一 real-* 具名字段；恒 false
  readyCount: 1,
  blockedCount: 0,
  anchorEntries: [ /* exactly 1 ready catalog entry — 见 §2.4 */ ],
  blockers: [],
  nextBlockers: [],
  safety: executionPreviewSafety(),             // 含 safety.sensitiveValuesReturned:false
}
```

**Top-level 恒 false / 固定值不变量：**

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `realRollbackAnchorImplementationReady` | 恒 `false` | 无真实 write/restore；**禁止** true 或删键 |
| `rollbackAnchorReady` | 固定 `true` | builder 无参固定输出；**≠** `gates.rollbackAnchorReady` |
| `codeOwnedAnchorResolverReady` | 固定 `true` | 产品级 pure contract ready |
| `readyCount` / `blockedCount` | `1` / `0` | 单 ready entry |
| `blockers` / `nextBlockers` | `[]` | 不再承载 real-implementation-missing |
| `safety.sensitiveValuesReturned` | 恒 `false` | 经 `executionPreviewSafety()`；**不**在 readiness top-level 另开同名键 |

**Top-level 明确排除的键（不得出现）：**

| 排除键 | 原因 |
| --- | --- |
| `realRollbackAnchorReady` | 旧 readiness 键；已重命名为 `realRollbackAnchorImplementationReady` |
| `realImplementationReady` | 旧通用别名；与具名字段语义重叠；**不得残留** |
| `sensitiveValuesReturned` | **仅** decision top-level 与 `safety` 承载；readiness top-level **不**开此键 |
| `codeOwnedResolverWired` | decision / entry 字段；**不**出现在 readiness top-level |
| `wouldWriteAnchor` / `wouldRestore` / `wouldExecute` / `wouldRun` / `wouldWrite` / 全部 `*Allowed` | 副作用字段落在 entry / decision / anchor 行，**不**在 readiness top-level |

### 2.3 字段命名、迁移与差异（必须解释）

| 字段 | 所在对象 | V1.27 值 | 含义 |
| --- | --- | --- | --- |
| `codeOwnedAnchorResolverReady` | **readiness** | `true` | 产品级 readiness：code-owned pure restricted anchor resolver contract 已就绪 |
| `codeOwnedResolverWired` | **anchorDecision** + **entry** | 恒 `true` | 单次 decision / entry 由已接线的 resolver 路径发出；**不是**“本次 mapping 一定 resolved”，**也不是** anchor 可写 |
| `realRollbackAnchorImplementationReady` | readiness / decision / entry / anchor 行 | 恒 `false` | **唯一** real-* 具名字段：无真实 rollback anchor write/restore implementation |
| `rollbackAnchorReady`（readiness） | readiness builder | 固定 `true` | ≠ gate fact `gates.rollbackAnchorReady` |
| `anchorReady`（decision） | anchorDecision | resolved 时 true | 单次 pure data 映射核验结果 |
| `wouldWriteAnchor` / `wouldRestore` / 全部 `*Allowed` | decision / entry / anchor 行 | 恒 `false` | 受限 contract 不授权任何 write/restore side effect |
| `sensitiveValuesReturned` | **仅** decision top-level（+ `safety`） | 恒 `false` | readiness top-level / entry **均不**含此键 |

#### 字段迁移表（V1.20 → V1.27；旧键不得残留）

| 旧 locus / 键 | V1.27 处置 | 新键 / 替代 |
| --- | --- | --- |
| readiness `realRollbackAnchorReady` | **重命名** | `realRollbackAnchorImplementationReady`（值仍恒 `false`） |
| entry / decision / anchor 行的 `realImplementationReady` | **删除**（不得残留） | 仅保留 `realRollbackAnchorImplementationReady:false` |
| entry `sensitiveValuesReturned`（V1.20 disabled entry 曾有） | **删除**（不得残留） | decision top-level `sensitiveValuesReturned:false` + readiness `safety.sensitiveValuesReturned:false` |
| entry `anchorKind:'disabled-rollback-anchor-stub'` / `state:'blocked'` | **替换** | `anchorKind:'code-owned-rollback-anchor'` / `state:'ready'` |
| readiness / entry blocker `rollback-anchor-real-implementation-missing` | **不再**作为 readiness blockers 主码 | 由 `realRollbackAnchorImplementationReady:false` 表达 |

**同步测试（不可漏）：**

- 凡断言旧键 `realRollbackAnchorReady` 的 pure / gate / API / CLI / Web 用例一律改为 `realRollbackAnchorImplementationReady`。
- readiness / entry / decision / anchor 行上 **`Object.hasOwn(..., 'realRollbackAnchorReady') === false`**。
- readiness / entry / decision / anchor 行上 **`Object.hasOwn(..., 'realImplementationReady') === false`**（旧通用别名不得残留）。
- readiness top-level 与 entry 上 **`Object.hasOwn(..., 'sensitiveValuesReturned') === false`**；decision top-level 仍断言 `sensitiveValuesReturned === false`。
- plan fixture `EXPECTED_ROLLBACK_ANCHOR_ENTRIES` 必须与 §2.4 **byte-level deep-equal**（键集合 + 值）。

**禁止：**

- 在 decision 上使用 `codeOwnedAnchorResolverReady` 这个 readiness 级名字
- 把 `realRollbackAnchorImplementationReady` 设为 true 或删除该键
- 把 `wouldWriteAnchor` / `wouldRestore` 或任一 `*Allowed` 设为 true
- 在 readiness / entry 上复活 `realImplementationReady` 或 `sensitiveValuesReturned`

### 2.4 唯一 anchor entry（exact schema）

**Entry exact keys（顺序固定；不多不少）：**

```text
anchorKind, state, codeOwnedResolverWired, realRollbackAnchorImplementationReady,
wouldWriteAnchor, wouldRestore, wouldExecute, wouldRun, wouldWrite,
filesystemWriteAllowed, metadataWriteAllowed, rollbackAnchorWriteAllowed,
rollbackRestoreAllowed, blockerCode, evidenceCode
```

```js
{
  anchorKind: 'code-owned-rollback-anchor',
  state: 'ready',
  codeOwnedResolverWired: true,
  realRollbackAnchorImplementationReady: false, // 唯一 real-* 具名字段；恒 false
  wouldWriteAnchor: false,                      // 恒 false
  wouldRestore: false,                          // 恒 false
  wouldExecute: false,                          // 恒 false
  wouldRun: false,                              // 恒 false
  wouldWrite: false,                            // 恒 false
  filesystemWriteAllowed: false,                // 恒 false
  metadataWriteAllowed: false,                  // 恒 false
  rollbackAnchorWriteAllowed: false,            // 恒 false
  rollbackRestoreAllowed: false,                // 恒 false
  blockerCode: null,
  evidenceCode: 'rollback-anchor-ready',
}
```

**Entry 明确排除的键（不得出现）：**

| 排除键 | 原因 |
| --- | --- |
| `realImplementationReady` | 与 `realRollbackAnchorImplementationReady` 语义重叠；V1.27 **删除**，不得残留 |
| `sensitiveValuesReturned` | V1.20 disabled entry 曾有；V1.27 **删除**；改由 decision + safety 表达 |
| `realRollbackAnchorReady` | 旧 readiness 键名；entry 从未使用且不得引入 |

**Entry 恒 false 不变量：** `realRollbackAnchorImplementationReady`、`wouldWriteAnchor`、`wouldRestore`、`wouldExecute`、`wouldRun`、`wouldWrite`、`filesystemWriteAllowed`、`metadataWriteAllowed`、`rollbackAnchorWriteAllowed`、`rollbackRestoreAllowed` 全部恒 `false`。

- 不再以 `state:'blocked'` / `disabled-rollback-anchor-stub` 作 readiness 主状态。
- readiness `blockers` 不再含 `rollback-anchor-real-implementation-missing` / `real-guarded-runner-execution-wiring-missing`（write/restore 未就绪由 `realRollbackAnchorImplementationReady:false` 表达；wiring 级 blocker 留在 wiring aggregate）。
- plan `EXPECTED_ROLLBACK_ANCHOR_ENTRIES[0]` **必须** 与上表 exact deep-equal。

---

## 3. Wiring contract

### 3.1 requiredContracts（顺序固定）

1. `execution-policy` → ready（V1.24）
2. `runner-registry` → ready（V1.25）
3. `host-mutation-adapter` → ready（V1.26）
4. `rollback-anchor` → **ready**（V1.27）
5. `attempt-audit` → blocked
6. `operator-recovery` → blocked

### 3.2 Ready `rollback-anchor` contract

```js
{
  id: 'rollback-anchor',
  status: 'ready',
  requiredForExecution: true,
  evidence: 'Code-owned fail-closed restricted rollback-anchor pure data plan resolver is wired.',
  evidenceCode: 'rollback-anchor-ready',
  blockerCode: null,
}
```

- `status === 'ready'` ⇒ `blockerCode === null` 且 `evidenceCode === 'rollback-anchor-ready'`
- Web 显示 `blocker:none` 仅为 UI sentinel；JSON 仍为 `null`
- 禁止 `status:'ready'` 与 missing blocker 并存

### 3.3 Wiring aggregate

```js
{
  command: 'supervisor-lifecycle-guarded-runner-wiring-contract',
  state: 'blocked',
  realRunnerWiringReady: false,
  readyCount: 4,
  blockedCount: 2,
  requiredContracts: [ /* 6 */ ],
  executionPolicyReadiness: /* ready */,
  runnerRegistryReadiness: /* ready */,
  hostMutationAdapterReadiness: /* ready */,
  rollbackAnchorReadiness: /* ready builder */,
  attemptAuditReadiness: /* blocked */,
  operatorRecoveryReadiness: /* blocked */,
  blockers: ['real-guarded-runner-execution-wiring-missing'],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  safety: executionPreviewSafety(),
}
```

`buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview)` 仍忽略 preview 内容。

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

// Ignore options.anchorDecision / options.rollbackAnchorReady / options.anchorContext.
const anchorDecision = sanitizeRollbackAnchorDecision(
  resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(actionCandidates, operation),
);

// runnerRegistryReady：保持 V1.25 本地 boolean（不回退）
// hostMutationAdapterReady：保持 V1.26 本地 boolean（不回退）
// rollbackAnchorReady：新增本地 boolean
const rollbackAnchorReadiness = runnerWiringContract.rollbackAnchorReadiness;
const rollbackAnchorReady =
  rollbackAnchorReadiness?.rollbackAnchorReady === true &&
  rollbackAnchorReadiness?.codeOwnedAnchorResolverReady === true &&
  rollbackAnchorReadiness?.state === 'ready' &&
  rollbackAnchorReadiness?.realRollbackAnchorImplementationReady === false &&
  anchorDecision?.anchorReady === true &&
  anchorDecision?.state === 'resolved' &&
  anchorDecision?.codeOwnedResolverWired === true &&
  anchorDecision?.realRollbackAnchorImplementationReady === false &&
  anchorDecision?.wouldWriteAnchor === false &&
  anchorDecision?.wouldRestore === false &&
  anchorDecision?.wouldExecute === false &&
  anchorDecision?.wouldRun === false &&
  anchorDecision?.wouldWrite === false &&
  anchorDecision?.filesystemWriteAllowed === false &&
  anchorDecision?.metadataWriteAllowed === false &&
  anchorDecision?.rollbackAnchorWriteAllowed === false &&
  anchorDecision?.rollbackRestoreAllowed === false;

const policyContext = {
  // ...existing upstream booleans...
  actionCandidatesReady: actionCandidatesReady === true,
  runnerRegistryReady: runnerRegistryReady === true,
  hostMutationAdapterReady: hostMutationAdapterReady === true,
  rollbackAnchorReady: rollbackAnchorReady === true, // 不再 hardcoded false
  attemptAuditReady: false,
  operatorRecoveryReady: false,
};
```

**硬性约束：**

- 不得从 `options` / request / CLI 读取 anchor override
- `options` 仅允许既有 `executeRequested` boolean
- 不得把 approval identity / path / hash / command / raw error 放进 resolver 或 policy context
- 不得因 anchor ready 而把 `executionEligible` / `wouldExecute` / `wouldWriteAnchor` / `wouldRestore` / 任一 `*Allowed` / `wouldMutateHost` 变 true
- 不得因 anchor ready 而把 `realHostMutationImplementationReady` 变 true

### 4.2 Gate 输出

```js
{
  // ...existing...
  registryDecision,  // V1.25 保持
  adapterDecision,   // V1.26 保持
  anchorDecision,    // V1.27 新增；含 wouldWriteAnchor / wouldRestore / *Allowed / would*（decision locus）
  policyDecision,    // 含 wouldRun/wouldWrite（policy locus；≠ gate 顶层）
  actionCandidates,
  gates: {
    // ...
    actionCandidatesReady,
    executionPolicyReady: true,
    runnerRegistryReady,           // V1.25 语义
    hostMutationAdapterReady,      // V1.26 语义
    rollbackAnchorReady,           // production ready install fixtures → true
    realRunnerWiringReady: false,
    runnerWiringContractReady: false,
    attemptAuditReady: false,
    operatorRecoveryReady: false,
  },
  // gate 顶层仅下列资格字段（V1.27 仍恒 false）：
  executionEligible: false,
  wouldExecute: false,
  // **无** gate 顶层 wouldRun / wouldWrite / wouldWriteAnchor / wouldRestore
}
```

### 4.3 Production path 仍 deny

anchor ready 后 primaryBlocker 从 V1.26 的 `rollback-anchor-not-ready` **迁移为** `attempt-audit-not-ready`。policy blockers 至少含后二 `*-not-ready`。

`executionEligible` 语义写死后二 + wiring aggregate 为 false → 结果必 false。测试必须覆盖 “anchor ready 后仍 deny 且 executionEligible false”。

### 4.4 `sanitizeRollbackAnchorDecision`

- 只保留 allowlisted keys
- blockers / primaryBlocker / nextBlockers 过滤到 `ROLLBACK_ANCHOR_BLOCKER_CODES`
- 强制 wouldWriteAnchor / wouldRestore / 全部 *Allowed / would* / realRollbackAnchorImplementationReady false；`codeOwnedResolverWired:true`
- 强制 state/anchorReady 一致；漂移 → unresolved + `rollback-anchor-candidates-invalid`
- unresolved 强制 `anchors:[]`、`resolvedCount:0`、`unresolvedCount:0`
- 返回新对象

---

## 5. API / CLI / Web

### 5.1 透传边界

| 通道 | 行为 |
| --- | --- |
| API | 既有 body 不变；响应透传 gate JSON；**不改** `src/server.js` |
| CLI | 既有 flags；JSON 透传；`--fail-on-blocked` 仍 exit 2；**不改** `src/agent.js` |
| Web | 不新增按钮/字段；**strict canonical fail-closed assembly**（§5.2） |

禁止 request/CLI 强制 `anchorDecision` / `rollbackAnchorReady:true` / `anchorEntries` override；传入必须忽略。

#### 5.1.1 API / CLI 测试验证契约

V1.27 改造 **两个现有共用 helper**（参数化，非单点改一行布尔）：

| Helper | 文件 |
| --- | --- |
| `assertBlockedExecutionGate(body, { runnerRegistryReady, hostMutationAdapterReady, rollbackAnchorReady })` | `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` |
| `assertBlockedGate(report, { runnerRegistryReady, hostMutationAdapterReady, rollbackAnchorReady })` | `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` |

**共用 helper 固定（所有 200/成功 gate JSON 路径一致）：**

- wiring：`readyCount:4`、`blockedCount:2`
- `requiredContracts[3]`（`rollback-anchor`）：`status:'ready'`、`blockerCode:null`、`evidenceCode:'rollback-anchor-ready'`
- 后二：`requiredContracts.slice(4)` 全 `blocked`（**不得** `slice(3)`）
- `rollbackAnchorReadiness`：`state:'ready'`、`rollbackAnchorReady:true`、`codeOwnedAnchorResolverReady:true`、`realRollbackAnchorImplementationReady:false`、ready entry exact
- `hostMutationAdapterReadiness` / contract[2]：**保持 V1.26 ready** 断言
- `runnerRegistryReadiness` / contract[1]：**保持 V1.25 ready** 断言
- `gates.runnerRegistryReady`：**严格等于**调用方传入 boolean（**必传**）
- `gates.hostMutationAdapterReady`：**严格等于**调用方传入 boolean（**必传**）
- `gates.rollbackAnchorReady`：**严格等于**调用方传入 boolean（**必传**；禁止用 `false` 默认掩盖漏传）
- policy：`state:'denied'` + would* false；gate 顶层 `executionEligible`/`wouldExecute` false

**共用 helper 不得固定（场景不同，只在专属 `it`）：**

- `anchorDecision.state` / `anchorDecision.anchorReady`
- `adapterDecision.state` / `adapterDecision.adapterReady`
- `registryDecision.state` / `registryDecision.registryReady`
- `policyDecision.primaryBlocker`（含 ready 路径的 `attempt-audit-not-ready`）
- no-approval / no-execute / missing-binding 等 primary 或 blockers 细节

**`gates.rollbackAnchorReady` 语义矩阵（API/CLI）：**

| 条件 | gate fact |
| --- | --- |
| valid manifest + valid runnerBinding（action set 可构造；anchor resolve 成功） | **true** — 不论 `executeRequested` true/false、approval ready/not ready；**可独立于** registry resolve（非 catalog impl 时 registry false 但 adapter/anchor true） |
| missing `runnerBinding`（API 现有：empty candidates） | **false** |
| invalid manifest/binding | 通道级 400 / CLI exit 1；**不**经 blocked helper |

### 5.2 Web：strict canonical fail-closed assembly

#### 设计原则

Web **不得**仅因 `anchorEntries.length >= 1`、单字段 contract status、或 `gates.rollbackAnchorReady` 孤值就显示 ready。
**共享单一 canonical predicate**（下称 `canonicalRollbackAnchorReady`）：wiring line、anchor line、`validationLines.rollbackAnchorReady` **必须**基于同一 boolean。

后二 contract（attempt-audit / operator-recovery）**永远不能**被 payload 推成 ready。
`runner-registry` 继续使用 V1.25 的 `canonicalRunnerRegistryReady`（C∧R∧G∧D_registry）。
`host-mutation-adapter` 继续使用 V1.26 的 `canonicalHostMutationAdapterReady`（C∧A∧G∧D_adapter）。
三者 **不得**混用。

#### 共享单一 canonical predicate（C ∧ A ∧ G ∧ D）

记：

- `C` = `requiredContracts` 中 `id === 'rollback-anchor'` 的那一项
- `A` = `runnerWiringContract.rollbackAnchorReadiness`
- `G` = `gates.rollbackAnchorReady`
- `D` = `payload.anchorDecision`

```js
function isCanonicalRollbackAnchorReady({ C, A, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'rollback-anchor-ready' &&
    C?.requiredForExecution === true &&
    A?.state === 'ready' &&
    A?.rollbackAnchorReady === true &&
    A?.codeOwnedAnchorResolverReady === true &&
    A?.realRollbackAnchorImplementationReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.anchorReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realRollbackAnchorImplementationReady === false &&
    D?.wouldWriteAnchor === false &&
    D?.wouldRestore === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false &&
    D?.filesystemWriteAllowed === false &&
    D?.metadataWriteAllowed === false &&
    D?.rollbackAnchorWriteAllowed === false &&
    D?.rollbackRestoreAllowed === false
  );
}
```

**canonical ready 当且仅当** `isCanonicalRollbackAnchorReady(...) === true`。
任一 missing / invalid / contradictory / side-effect flag true（含 `D.wouldWriteAnchor===true` 或 `D.wouldRestore===true` 或任一 `*Allowed===true`）→ **false**。

#### Wiring contract lines（rollback-anchor）

- 从 `WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS` **移除** `rollback-anchor`。
- **ready 当且仅当** `canonicalRollbackAnchorReady === true` →
  `wiringContract:rollback-anchor:status:ready:requiredForExecution:true:blocker:none`
- **否则固定** →
  `wiringContract:rollback-anchor:status:blocked:requiredForExecution:true:blocker:rollback-anchor-missing`
  （canonical blocked；**不**回显 payload blocker / secret 原文）
- 后二：仍 **固定** canonical missing blocked。
- `execution-policy` / `runner-registry` / `host-mutation-adapter`：保持既有 V1.24/V1.25/V1.26 分支。

#### Anchor readiness line（同一 boolean）

- **ready 当且仅当** `canonicalRollbackAnchorReady === true`：

```text
rollbackAnchor:code-owned-rollback-anchor:state:ready:codeOwnedResolverWired:true:realRollbackAnchorImplementationReady:false:wouldWriteAnchor:false:wouldRestore:false:blocker:none
```

  必须显式含 `realRollbackAnchorImplementationReady:false`、`wouldWriteAnchor:false` 与 `wouldRestore:false`，避免 “ready = 可写/可 restore anchor” 误导。

- **否则固定 blocked**（始终输出恰好一行）：

```text
rollbackAnchor:code-owned-rollback-anchor:state:blocked:codeOwnedResolverWired:true:realRollbackAnchorImplementationReady:false:wouldWriteAnchor:false:wouldRestore:false:blocker:rollback-anchor-not-ready
```

  **不得**泄漏 `OPAQUE_UNSAFE_FIELD` / secret-like anchorKind / 恶意 wouldWriteAnchor 原文。
  **禁止**继续渲染 `disabled-rollback-anchor-stub` 作为 V1.27 正常路径文案（恶意 payload 注入 stub kind 时仍输出上列 fixed blocked 行，不回显 payload kind）。

#### validationLines（同一 boolean）

- `rollbackAnchorReady:true` **当且仅当** `canonicalRollbackAnchorReady === true`；否则 `rollbackAnchorReady:false`
- **禁止**仅 `gates.rollbackAnchorReady===true` 就渲染 true
- 始终固定 `executionEligible:false`、后二 false、`realRunnerWiringReady:false`、`runnerWiringContractReady:false`
- `runnerRegistryReady` / `hostMutationAdapterReady` 继续用各自独立 canonical boolean

#### 强制 case：C/A/G 表面 ready、D.wouldWriteAnchor=true（side-effect 漂移）

当 `C`/`A`/`G` 均表面 ready，且 `D.state==='resolved' && D.anchorReady===true`，但 `D.wouldWriteAnchor===true`（或 `D.wouldRestore===true` 或任一 `*Allowed===true` / would* true）时：

- `canonicalRollbackAnchorReady === false`
- wiring line：**blocked** + `rollback-anchor-missing`
- anchor line：**blocked** + `rollback-anchor-not-ready`
- validation：`rollbackAnchorReady:false`
- 后二仍 blocked
- **不得**出现任何 rollback-anchor / rollbackAnchor **ready** 行
- 敏感/恶意值不回显

#### policyDecision line

- 保持 V1.24：**强制 denied**
- primaryBlocker 仅 allowlist 透传展示（ready path 展示 `attempt-audit-not-ready`）

---

## 6. 版本 / README / Gold

- `LINKE_RELEASE_VERSION = 'V1.27'`
- README 标题、badge、version table：V1.27 当前，V1.26 历史
- Gold evidence 添加：`resolveSupervisorLifecycleGuardedRunnerRollbackAnchor`、`rollbackAnchorReadiness.state:ready`、`rollbackAnchorReady:true`、`codeOwnedAnchorResolverReady:true`、`codeOwnedResolverWired`、`rollback-anchor-ready`、`realRollbackAnchorImplementationReady:false`、`anchorDecision`、`readyCount:4`/`blockedCount:2`
- 移除作为 **当前缺口** 的 `rollback-anchor-real-implementation-missing` / `rollback-anchor-missing`（历史叙述可保留）
- nextStep 指向 **attempt-audit**（并明确：真实 rollback anchor write/restore 仍缺失；真实 host mutation implementation 仍缺失）
- Gold 仍 `blocked`；G0a PASS 不变

---

## 7. 安全与非目标

### 安全

- 全路径无 host mutation / runner dispatch / launchctl / shell / process list / fs write / metadata / audit / NAS / network / 真实 rollback write/restore
- fixture 禁止：用户名形态绝对路径、SSH 路径形态、具体 IP/CIDR、真实邮箱、真实 command 名、credential 形态、64-hex digest
- 恶意 fixture 仅 opaque synthetic（`UNSAFE_SECRET_MATERIAL`、`OPAQUE_UNSAFE_FIELD`）
- 敏感扫描只报类别计数，不回显匹配行
- 输出深拷贝
- caller override（`options.anchorDecision` / `options.rollbackAnchorReady` / `options.anchorContext`）必须忽略

### 非目标

- **不实现真实 rollback anchor write / restore**
- **不实现真实 host mutation adapter execution**（V1.26 遗留；本版不推进）
- 不实现后二 wiring 真实能力（attempt-audit / operator-recovery）
- 不调度/调用 runner
- 不把 executionEligible 或 Gold 变 ready
- 不设 `realRollbackAnchorImplementationReady:true` / `wouldWriteAnchor:true` / `wouldRestore:true` / 任一 `*Allowed:true`
- 不设 `realHostMutationImplementationReady:true` / `wouldMutateHost:true`
- 不声称可证明拒绝所有 Proxy
- 不改 V1.24 actionCandidates helper 契约
- 不改 V1.25 registry resolver 映射/redacted 契约
- 不改 V1.26 adapter resolver 映射/unsafe 契约
- 不修改 `src/agent.js` / `src/server.js` / `package.json`
- 不设计真实 recovery supervisor（仅 anchorKind 映射可解析）

### 下一步（显式非本版）

1. attempt-audit code-owned contract（V1.27 之后的下一个 wiring Gold blocker）
2. operator-recovery
3. 真实 host mutation implementation（在 restricted adapter 之后，仍须 fail-closed + policy + 后二 wiring）
4. 真实 rollback anchor write/restore implementation（在 restricted pure data plan 之后，仍须独立设计）
5. 任一真实 side effect 前必须有独立设计证明不会越界；默认仍保持 Gold blocked 直到证明完成

---

## 8. Scope 文件列表（基于实际 rg，非猜测）

对以下硬编码/断言模式做了仓库扫描（排除 `node_modules` / `.git` / 本设计 docs）：

`rollback-anchor-missing`、`rollback-anchor-real-implementation-missing`、`disabled-rollback-anchor-stub`、`rollbackAnchorReady:false`（gate hardcode）、`realRollbackAnchorReady`、`readyCount:3`+`blockedCount:3`（wiring 级）、`rollback-anchor-not-ready`（ready-path primary）、Web `rollbackAnchor:` / `wiringContract:rollback-anchor` 行、version/README/Gold V1.26 当前标记。

### 允许修改（实现阶段）— 仅下列文件

| 文件 | 原因（rg 命中） |
| --- | --- |
| `src/supervisor-lifecycle.js` | resolver/readiness/wiring/gate 实现与常量 |
| `src/web/app.js` | wiring/anchor lines + validationLines + canonical predicate |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | pure/gate/readiness/wiring 断言 |
| `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` | API 透传断言 |
| `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` | CLI JSON 断言（**不改** `src/agent.js`） |
| `test/web-console.test.js` | Web assembly / 恶意 payload |
| `src/version.js` | `V1.27` |
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

### Full

```bash
npm test
```

### 无 side-effect 源码检查（实现后）

```bash
# 禁止在 supervisor-lifecycle.js 新增 host side-effect 调用（实现差分内）
git diff 8e89403 -- src/supervisor-lifecycle.js | rg -n \
  'launchctl|child_process|execSync|spawn\(|exec\(|fs\.(write|rm|unlink|mkdir)|process\.kill|net\.|http\.|https\.' \
  && echo 'FAIL: side-effect call pattern in diff' || echo 'ok: no side-effect pattern in lifecycle diff'

# 敏感类别计数 only（不打印匹配行内容）
git diff 8e89403 -- src/ test/ | rg -c \
  'ssh-rsa|BEGIN (RSA |OPENSSH )?PRIVATE|AKIA[0-9A-Z]{16}|[0-9a-f]{64}' \
  || true
# 期望：无命中；若有命中只报告 count，不得 cat 原文
```

### 无写入 scope / 锚点核对（人工允许列表；**不要**生成 `actual-changes.txt`；**不要** hard reset）

```bash
# 恢复锚点必须是当前 HEAD 祖先（无写入）
git merge-base --is-ancestor 8e89403 HEAD && echo 'anchor-ok'

# 变更文件名必须 ⊆ §8 允许列表
git diff --name-only 8e89403 --
git status --short

# 明确禁止文件无 diff
git diff --name-only 8e89403 -- src/agent.js src/server.js package.json
# 期望：无输出
```

### 预期不变量

| 不变量 | 期望 |
| --- | --- |
| version | `V1.27` |
| wiring ready/blocked | 4 / 2 |
| production `gates.rollbackAnchorReady` | true（ready install fixtures） |
| production `gates.hostMutationAdapterReady` | true（ready install fixtures） |
| production `gates.runnerRegistryReady` | true（ready install fixtures；非 catalog 路径 false） |
| production policy | denied；ready path primary=`attempt-audit-not-ready` |
| gate 顶层 `executionEligible` / `wouldExecute` | false |
| `anchorDecision` wouldWriteAnchor / wouldRestore / *Allowed / would* | false |
| `realRollbackAnchorImplementationReady` | false |
| `realHostMutationImplementationReady` | false（V1.26 不抬升） |
| Gold / G0a | blocked / PASS 不变 |
| agent/server/package | unmodified |

---

## 10. 运行韧性设计门

**正常态：** production gate `rollbackAnchorReady:true`、`anchorDecision` resolved、`hostMutationAdapterReady:true`、`runnerRegistryReady:true`、`policyDecision` denied（primary=`attempt-audit-not-ready`）、`executionEligible:false`；wiring 4/2；Gold blocked。

**三支柱：**

1. **有界失效：** 畸形 candidates / unsafe would* / 恶意 Web payload → unresolved 或 blocked Web 行 / 强制 denied policy；不抛敏感 raw error。
2. **异常恢复：** 若发现 request 可非法把 `executionEligible` / `wouldExecute` / `rollbackAnchorReady` / `wouldWriteAnchor` / `wouldRestore` 变 true → 立即硬编码 false + pure-only 路径。
3. **状态侦测：** pure / gate / API / CLI / Web / version / README / Gold + `npm test` + §9 无写入 diff 核对。

---

## 11. 完成标准

1. pure resolver 存在；不返回函数/command/path/host/token/hash/raw error；无副作用
2. 四 operation happy path `resolved` + wouldWriteAnchor false + wouldRestore false + 全部 *Allowed false
3. 每个失败类 **单一 exact** blocker；unknown/missing/duplicate/unsafe 可构造且不重叠；pure 必须覆盖 `len<|E|`（A6 → missing）与 `len>|E|`（A23 → unknown、A24 → duplicate）；长度不等式本身永不直接 `candidates-invalid`；snapshot 后非法 actionId 唯一 `candidates-invalid`；unsafe would* → `rollback-anchor-unsafe-anchor`
4. non-catalog implementationId 与 redacted maxAttempts：anchor 可 resolved 而 registry unresolved（intentional）；gate 三 fact 独立
5. readiness + required contract ready；`realRollbackAnchorImplementationReady:false`；decision 用 `codeOwnedResolverWired`
6. wiring 4/2；后二 blocked；production deny + `executionEligible:false`；primary=`attempt-audit-not-ready`
7. Web 共享单一 `canonicalRollbackAnchorReady`（C∧A∧G∧D）；wiring/anchor/validation 同源；恶意/side-effect 漂移 payload 不能 ready；ready 行显式 `realRollbackAnchorImplementationReady:false` + `wouldWriteAnchor:false` + `wouldRestore:false`
8. 版本 V1.27；Gold blocked；G0a PASS 不变；nextStep → attempt-audit + 声明真实 rollback write/restore 与真实 host mutation 仍缺
9. 仅改 §8 列表；agent/server/package 未改；§9 无写入核对通过
10. 与 V1.26 adapter 分层清楚：anchor 不读 adapterDecision；两者 trust 边界独立；real host mutation 仍 false

---

## 12. 关键决策摘要

1. **本版完成 restricted pure data rollback-anchor contract/readiness ready；不完成真实 write/restore 或 host mutation。**
2. Public API：`resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, operation)`；≠ write/restore/execute。
3. Code-owned 10 action→anchorKind 映射；anchorKind 仅为 pure data plan identifier。
4. recover 仅映射解析，不执行 recovery supervisor / recovery write。
5. `realRollbackAnchorImplementationReady` / `wouldWriteAnchor` / `wouldRestore` / 全部 `*Allowed` 保持 false；readiness 用 `codeOwnedAnchorResolverReady`；decision 用 `codeOwnedResolverWired`；旧键 `realRollbackAnchorReady` 重命名为唯一具名字段；`realImplementationReady` 与 entry 级 `sensitiveValuesReturned` **不得残留**；`OPERATION_EXPECTED_ACTION_IDS` 与 `buildLifecycleActions(...).map(a=>a.id)` 一致。
6. Anchor resolved ≠ write/restore；不得冒充 real implementation；亦不得抬升 V1.26 `realHostMutationImplementationReady`。
7. Proxy：best-effort 容器快照 + 元素 descriptor snapshot；不声称拒绝所有 Proxy。
8. unresolved 恒 `anchors:[]`、`resolvedCount:0`、`unresolvedCount:0`。
9. 分层：anchor 忽略 implementationId/maxAttempts 值内容；registry 继续负责 catalog/maxAttempts；adapter 继续负责 mutationKind；unsafe would* 由 adapter 与 anchor 各自拒绝。
10. Web：共享单一 multi-field canonical predicate（C∧A∧G∧D）；禁止无条件固定 ready。
11. wiring 4/2；primary → `attempt-audit-not-ready`；后二仍 blocked；policy 仍 deny。
12. 不新增 surface；不改 agent/server/package。
13. Scope 来自实际 rg；全量 `npm test` 兜底；无写入 merge-base + diff 允许列表核对。
14. 恢复锚点 `8e89403`；Gold blocked；G0a PASS 不变。
15. 下一步仍需 attempt-audit / operator-recovery + 真实 host mutation implementation + 真实 rollback write/restore。
