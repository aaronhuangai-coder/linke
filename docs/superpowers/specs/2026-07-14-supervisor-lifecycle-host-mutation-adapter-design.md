# V1.26 Supervisor Lifecycle Host Mutation Adapter Design

## 目标

V1.26 用 **code-owned、纯函数、fail-closed、受限（restricted）host-mutation-adapter resolver / readiness contract** 替换 V1.19 的 disabled host mutation adapter stub。本版本把 `host-mutation-adapter` required contract 从 `blocked/false` 推进为 `ready/true`，并在 execution gate 内基于 **production-derived sanitized `actionCandidates` + allowlisted `operation`** 调用 pure resolver，返回 sanitized `adapterDecision`，把 policy context 的 `hostMutationAdapterReady` fact 接成严格验证后的本地 boolean。

### 关键边界（必须先读）

| 层级 | V1.26 是否完成 | 含义 |
| --- | --- | --- |
| **restricted adapter contract / readiness** | **是** | code-owned action→mutationKind 映射可核验；readiness/contract ready；gate 可在合法 candidates 上得到 `hostMutationAdapterReady:true` |
| **real host mutation implementation / side-effect execution** | **否** | 不调用 launchctl / shell / fs / process list / metadata / audit / network；`realHostMutationImplementationReady` 恒 false；`wouldMutateHost` 与全部 `*Allowed` 恒 false |

**不得**把 mapping / planner / readiness ready 冒充真实 host implementation。下一步（V1.27+）仍需真实 host mutation implementation，以及后三 wiring（rollback-anchor / attempt-audit / operator-recovery）。**Gold 继续 blocked。**

V1.26 **必须继续保持**：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`
- `realRunnerWiringReady:false`
- 后三项 wiring facts false（rollbackAnchor / attemptAudit / operatorRecovery）
- gate 顶层：`executionEligible:false`、`executorReady:false`、`wouldExecute:false`（**gate 顶层没有** `wouldRun` / `wouldWrite`）
- 副作用 would* 在其真实 locus 恒 false：`policyDecision.wouldRun/wouldWrite`、`registryDecision` would*、`adapterDecision` would* / `wouldMutateHost` / 全部 `*Allowed`、`actionCandidates[]` 每项 would*、readiness entry / mutation 行 would*
- `real-guarded-runner-execution-wiring-missing`
- Gold readiness: `blocked`
- G0a 真实双机 PASS 声明不变

V1.26 **必须改变**：

- `hostMutationAdapterReady:true`（readiness 固定 true；production gate fact 仅在 resolver 对 production candidates 解析成功时为 true）
- `hostMutationAdapterReadiness.state:'ready'` + `codeOwnedAdapterResolverReady:true` + `realHostMutationImplementationReady:false`
- `runnerWiringContract.requiredContracts[2]`（`host-mutation-adapter`）→ `status:'ready'`、`blockerCode:null`、`evidenceCode:'host-mutation-adapter-ready'`
- `runnerWiringContract.readyCount:3`、`blockedCount:3`
- production gate 返回 sanitized `adapterDecision`；`hostMutationAdapterReady` 为本地 boolean
- 后三 wiring 仍 false → production `policyDecision` **始终 deny**；各 locus 副作用字段全 false
- ready production path primaryBlocker 从 V1.25 的 `host-mutation-adapter-not-ready` **迁移为** `rollback-anchor-not-ready`

**不得**调度/调用 runner；不得 host shell / process-control / fs / metadata / audit / approval / rollback / NAS / 网络副作用。不新增 endpoint、CLI command、Web button、request body field。**禁止修改** `src/agent.js` / `src/server.js` / `package.json`。不得接受 request/CLI/Web 直传的 `adapterDecision` / `adapterContext` / `hostMutationAdapterReady` override。

**恢复锚点：** `22c33db`（`feat: add V1.25 code-owned runner registry`）。实现越界时回到该 commit 的干净状态再重做（见 §9 无写入核对；**禁止**在 plan/docs 中建议 `git reset --hard` 作为常规步骤）。

### 副作用 / 资格字段 locus（禁止“全部对象都有全部字段”误读）

| 字段 | 所在对象（唯一合法 locus） | V1.26 |
| --- | --- | --- |
| `executionEligible` | **仅** gate 顶层 | 恒 `false` |
| `wouldExecute` | gate 顶层；**另**见于 `registryDecision`、`adapterDecision`、`actionCandidates[]`、readiness entry、mutation 行 | 恒 `false` |
| `wouldRun` / `wouldWrite` | **不在** gate 顶层；见于 `policyDecision`、`registryDecision`、`adapterDecision`、`actionCandidates[]`、readiness entry、mutation 行 | 恒 `false` |
| `wouldMutateHost` | **仅** `adapterDecision`、adapter readiness entry、mutation 行 | 恒 `false` |
| `launchctlAllowed` / `filesystemWriteAllowed` / `processListReadAllowed` / `metadataWriteAllowed` / `auditWriteAllowed` / `rollbackAnchorWriteAllowed` | **仅** `adapterDecision`、entry、mutation 行 | 恒 `false` |
| `gates.hostMutationAdapterReady` | `gates` 对象 | production resolve 成功时 true；否则 false |
| `hostMutationAdapterReady`（readiness 级） | `hostMutationAdapterReadiness` / readiness builder | 固定 true（≠ gate fact） |
| `gates.runnerRegistryReady` | `gates` 对象 | **保持 V1.25 语义**（不回退） |

**禁止**断言 `result.wouldRun` / `result.wouldWrite` / `result.wouldMutateHost`（gate 顶层不存在 wouldRun/wouldWrite/wouldMutateHost）。断言 must 按上表 locus 精确落点。

---

## 设计选择总览

| 组件 | V1.19 / V1.25 | V1.26 |
| --- | --- | --- |
| adapter catalog | disabled stub | code-owned 固定 actionId→mutationKind 受限映射表 |
| resolver | 无 | 公开 pure `resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, operation)` |
| readiness | disabled, ready=false | fixed ready evidence, ready=true |
| required contract `host-mutation-adapter` | blocked + missing | ready + `blockerCode:null` + `evidenceCode:'host-mutation-adapter-ready'` |
| wiring readyCount / blockedCount | 2 / 4 | **3 / 3** |
| gate `hostMutationAdapterReady` | hardcoded false | readiness + production-derived resolver 本地 boolean |
| gate `adapterDecision` | 无 | production candidates → resolver → sanitized decision |
| `realHostMutationImplementationReady` | false | **仍 false**（无真实 host mutation） |
| decision 字段名 | — | `codeOwnedResolverWired:true`（见 §2.3；≠ readiness 字段） |
| production policy primary | `host-mutation-adapter-not-ready` | **`rollback-anchor-not-ready`**（合法 ready path） |
| gate 顶层 `executionEligible` / `wouldExecute` / Gold | false / blocked | 不变 |

### 为何本版把 required contract 置 ready（而不是只加 resolver 不改 contract）

与 V1.25 `runner-registry` 对称：required contract ready **仅**表示 **code-owned restricted adapter contract/readiness 已接线且可核验**，**不**表示真实 host side effect 可执行。若只加 pure resolver 而 contract 仍 blocked，则 wiring 计数/primary blocker 无法前进，且与 V1.24/V1.25 的“contract ready = code-owned pure contract ready”语义不一致。

真实 host implementation 用 **独立字段** 表达并恒 false：

- readiness：`realHostMutationImplementationReady:false`
- decision / entry / mutation 行：`realHostMutationImplementationReady:false`、`wouldMutateHost:false`、全部 `*Allowed:false`

---

## 1. 纯函数 host-mutation-adapter resolver

### 1.1 导出（稳定 public pure API）

```js
/**
 * Resolve and verify sanitized guarded-runner action candidates against the
 * code-owned restricted host-mutation-adapter mapping table.
 *
 * Ready resolution means only that every candidate actionId maps to the fixed
 * restricted mutationKind for the given operation. It does NOT execute
 * launchctl/shell/filesystem/process/metadata/audit/network; does NOT set
 * wouldMutateHost / *Allowed / wouldExecute/wouldRun/wouldWrite true; does NOT
 * imply realHostMutationImplementationReady or executionEligible.
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
export function resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, operation)
```

| 项 | 要求 |
| --- | --- |
| 可见性 | **export**；公共 JSDoc 声明语义与非执行边界 |
| 参数 | **仅** `candidates` + `operation`；不读 request/options/fs/env/manifest/runnerBinding/registryDecision；不接受 caller-supplied adapterDecision |
| 返回 | 仅 plain object（深拷贝）；不返回 function / Promise / command / path / host / token / hash / raw error |
| 副作用 | 无 |
| 真值 | `state:'resolved'` 且 `adapterReady:true` **仅**表示受限 mutation 映射核验通过 |
| 假值 | invalid / mismatch / unsafe / trap → `state:'unresolved'` + 单一 exact allowlisted primary blocker |

**命名：** 采用 `resolve...HostMutationAdapter`（resolve/readiness，不暗示 mutate/execute）。拒绝 `mutateHost` / `applyHostMutation` / `runLaunchctl` / `dispatch...`。

### 1.2 输入：candidates + operation

`operation` 必须是 string 且 ∈ `{'install','uninstall','rollback','recover'}`；否则 unresolved + **唯一** blocker `host-mutation-adapter-operation-invalid`，decision.`operation` 输出 **`'unknown'`**（**仅此路径** 输出 unknown）。

**decision.operation 回显规则（禁止“所有 unresolved → unknown”）：**

| 输入 operation | 结果 state | decision.`operation` |
| --- | --- | --- |
| allowlisted（`install` / `uninstall` / `rollback` / `recover`） | resolved **或** unresolved（candidates/集合/unsafe 等任意失败） | **回显同一合法 operation 字符串** |
| 非 allowlisted / 非 string / 缺失等 | unresolved + `host-mutation-adapter-operation-invalid` | **`'unknown'`**（schema 唯一 unknown 来源） |

测试 helper `assertAdapterUnresolvedExact(decision, primaryBlocker, operation)` 的第三参 **必传**、禁止默认 `'unknown'`；合法 operation 输入的 unresolved 用例一律传对应合法 operation；**仅** invalid-operation 传 expected `'unknown'`。

`candidates` 输入 **不是** “长度必须 equal `|E|`” 的 structure precondition。容器合法（array、非 empty、元素可快照）后，长度/集合偏差走 §1.6 集合类 blocker；**仅** `state:'resolved'` 成功时要求 actionId 集合与 expected set **exact match**（因而 `mutations.length === |E|`）。

结构入口（与 V1.25 registry 容器策略同形，blocker 前缀换为 `host-mutation-adapter-`）：

1. 非 array / null / type-confusion → `host-mutation-adapter-candidates-invalid`
2. empty array（`len < 1`）→ `host-mutation-adapter-candidates-invalid`
3. 容器 trap / 元素 shape / exact-key 偏差 / accessor / trap / type-confusion → `host-mutation-adapter-candidates-invalid`
4. **snapshot 后** `actionId` 非「非空 string」（含 `''`、number、boolean、null、object 等）→ **唯一** `host-mutation-adapter-candidates-invalid`（**先于** duplicate / unknown / missing）
5. **长度 ≠ `|E|` 本身绝不能直接变** `candidates-invalid`（非 empty、元素 schema 过了、且每项 `actionId` 已是非空 string 之后，一律进入 duplicate → unknown → missing）

每个合法元素通过 §1.4 的 best-effort exact-key plain data property 单次快照。

#### Candidate exact keys（与 V1.25 sanitized gate action candidate contract 一致）

```text
actionId, implementationId, runnerKind, mode, status,
wouldExecute, wouldRun, wouldWrite, maxAttempts
```

- 顺序无关；元素 **键集合** 多一个、少一个、同名原型污染键 → `host-mutation-adapter-candidates-invalid`
- 无 own getter / accessor：每个 own key **恰好一次** `Object.getOwnPropertyDescriptor`，必须是 data property
- `Object.getPrototypeOf(element) === Object.prototype` 或 `=== null`
- descriptor / `ownKeys` throw → `host-mutation-adapter-candidates-invalid`；**不得**把 raw error message / stack / trap 返回值写入 decision

#### Adapter 对 candidate 字段的信任边界（intentional layered fail-closed）

| 字段 | Adapter 是否用于 ready resolve | 说明 |
| --- | --- | --- |
| `actionId` | **是** | 集合与 `buildLifecycleActions(operation)` expected set exact match；映射 mutationKind |
| `status` / `wouldExecute` / `wouldRun` / `wouldWrite` | **是** | 必须 exact `status:'blocked'` 且三 would* exact `false`；否则 **唯一** `host-mutation-adapter-unsafe-mutation` |
| `implementationId` / `runnerKind` / `mode` / `maxAttempts` | **否（忽略值内容）** | 仍须存在于 exact-key shape；**不**因非 catalog implementationId / redacted maxAttempts / runnerKind 偏差而 unresolved |

**分层结论（与 V1.25 registry 对称）：**

| 场景 | `actionCandidatesReady`（V1.24） | `registryDecision`（V1.25） | `adapterDecision`（V1.26） |
| --- | --- | --- | --- |
| 合法 catalog + numeric maxAttempts + would* false | true | resolved | resolved |
| 合法格式非 catalog `implementationId` | true | unresolved（implementation-mismatch） | **resolved**（adapter 只认 actionId 集合） |
| maxAttempts `'[redacted]'` | true | unresolved（max-attempts-invalid） | **resolved**（adapter 忽略 maxAttempts 值） |
| wouldExecute/wouldRun/wouldWrite true 或 status≠blocked | 视 helper | 可能 unresolved | **unresolved** + `host-mutation-adapter-unsafe-mutation` |

这是 **intentional layered fail-closed**，不是 bug。Adapter ready **绝不**授权 host mutation 或抬升 `executionEligible`。

### 1.3 Code-owned 固定 action → mutationKind 映射表

Adapter **只信任** `src/supervisor-lifecycle.js` 内冻结表。manifest / runnerBinding / request / CLI / Web / executionPreview / approval / config / env / fs / caller-supplied decision / `registryDecision` **一律不可**注入 ready。

#### 1.3.1 Action 集合（必须来自 `buildLifecycleActions`，不得增减）

| operation | actionId（顺序固定） |
| --- | --- |
| `install` | `render-launch-agent-plist`, `write-launch-agent-plist`, `load-launch-agent` |
| `uninstall` | `unload-launch-agent`, `remove-launch-agent-plist`, `remove-supervisor-metadata` |
| `rollback` | `capture-current-state`, `restore-previous-plist`, `restart-previous-supervisor` |
| `recover` | `start-recovery-supervisor` |

#### 1.3.2 固定 mutationKind 映射（identifiers only）

下列 ID 是 **restricted mutation plan identifiers only**——不是 host executor、不是可调用函数、不是 shell/launchctl argv、不是 path。仓库中 **不存在**真实 host mutation implementation。

| actionId | mutationKind | plannedHostSurface（元数据标签 only，**不**授权） |
| --- | --- | --- |
| `render-launch-agent-plist` | `render-plist-mutation` | `none` |
| `write-launch-agent-plist` | `write-plist-mutation` | `filesystem` |
| `load-launch-agent` | `load-agent-mutation` | `launchctl` |
| `unload-launch-agent` | `unload-agent-mutation` | `launchctl` |
| `remove-launch-agent-plist` | `remove-plist-mutation` | `filesystem` |
| `remove-supervisor-metadata` | `remove-metadata-mutation` | `metadata` |
| `capture-current-state` | `capture-state-mutation` | `process-list-read` |
| `restore-previous-plist` | `restore-plist-mutation` | `filesystem` |
| `restart-previous-supervisor` | `restart-supervisor-mutation` | `launchctl` |
| `start-recovery-supervisor` | `recovery-supervisor-mutation` | `launchctl` |

- `plannedHostSurface` **不得**写入 decision 输出（避免 UI/测试把标签当成 permission）。仅存在于源码常量注释或内部表；对外 mutation 行 **只**含 `mutationKind` + 恒 false flags。
- **install** 三 actionId 与既有 gate fixture 兼容。
- uninstall / rollback / recover 映射仅供 pure unit tests；**不**表示已有 host executor。

#### 1.3.3 mutationKind allowlist

```js
const HOST_MUTATION_KIND_ALLOWLIST = Object.freeze([
  'render-plist-mutation',
  'write-plist-mutation',
  'load-agent-mutation',
  'unload-agent-mutation',
  'remove-plist-mutation',
  'remove-metadata-mutation',
  'capture-state-mutation',
  'restore-plist-mutation',
  'restart-supervisor-mutation',
  'recovery-supervisor-mutation',
]);
```

输出 mutation 行的 `mutationKind` **必须** ∈ 该 allowlist，且 **exact equal** 上表对 actionId 的固定值。实现不得从 input 读取 mutationKind（input candidate **无** mutationKind 键；多键 → candidates-invalid）。

#### 1.3.4 recover

`recover` 仅一 action：`start-recovery-supervisor` → `recovery-supervisor-mutation`。V1.26 **不**设计/执行真实 recovery supervisor，不解除既有 apply-path blockers。Adapter 仅允许映射解析为 `resolved`；绝不因此把 would* / wouldMutateHost / *Allowed / executionEligible 变 true。

### 1.4 单次快照 / Proxy 边界（准确声明）

**JavaScript 无法可靠识别所有 `Proxy`。** 本设计 **不声称**可证明拒绝所有 Proxy。

与 V1.25 §1.4 **同策略**：

1. 容器：`try/catch` + `Array.isArray` + 一次 `length` + 一次索引读到本地 `elements[]`；**禁止**再触碰原容器；**不**对 array 做 descriptor purity 声称。
2. 元素：`ownKeys` 一次；exact key allowlist；每 key **恰好一次** descriptor → data property → 本地 snapshot；**禁止** check-then-二次读。
3. trap throw / getter / type-confusion → `host-mutation-adapter-candidates-invalid`。

#### 生产路径三层防御

| 层 | 约束 |
| --- | --- |
| L1 Gate 构造 | candidates **只来自** `buildGuardedRunnerExecutionGateActionCandidates`；operation 来自 allowlisted plan/preview；不接收 request/options adapter bag |
| L2 Resolver | best-effort 容器快照 + 元素 exact-key snapshot + code-owned mutation map；非法/unsafe → unresolved |
| L3 副作用恒 false | 任意 decision：`wouldMutateHost` / 全部 `*Allowed` / `wouldExecute/wouldRun/wouldWrite` / `realHostMutationImplementationReady` 恒 false；gate top-level `executionEligible/wouldExecute` 在 V1.26 亦恒 false |

### 1.5 Decision 输出 schema（exact）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-host-mutation-adapter',
  operation: <allowlisted input echoed, OR 'unknown' only when operation-invalid>,
  state: 'resolved' | 'unresolved',
  adapterReady: boolean,                 // true only when fully resolved
  codeOwnedResolverWired: true,          // 见 §2.3：单次 decision 表示 resolver 路径已接线，恒 true
  realHostMutationImplementationReady: false, // V1.26 恒 false
  wouldMutateHost: false,                // V1.26 恒 false
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,               // V1.26 恒 false
  filesystemWriteAllowed: false,         // V1.26 恒 false
  processListReadAllowed: false,         // V1.26 恒 false
  metadataWriteAllowed: false,           // V1.26 恒 false
  auditWriteAllowed: false,              // V1.26 恒 false
  rollbackAnchorWriteAllowed: false,     // V1.26 恒 false
  resolvedCount: number,
  unresolvedCount: number,
  mutations: [ /* 见下 */ ],
  primaryBlocker: string | null,
  blockers: string[],
  nextBlockers: string[],
  sensitiveValuesReturned: false,
  safety: executionPreviewSafety(),
}
```

**命名：** 使用 `codeOwnedResolverWired`，**不用** `codeOwnedResolverReady`。后者易与 readiness 的 `codeOwnedAdapterResolverReady` 混淆。

**字段名 `adapterReady`（decision）≠ readiness `hostMutationAdapterReady`：** decision 级表示本次映射核验；readiness 级表示产品 contract 固定 ready。

#### mutations 行 schema（**仅** resolved 时非空；**不含** `codeOwnedResolverWired`）

```js
{
  actionId: string,                    // expected 序第 i 项
  mutationKind: string,                // catalog exact；∈ HOST_MUTATION_KIND_ALLOWLIST
  mutationReady: true,
  realHostMutationImplementationReady: false,
  wouldMutateHost: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  metadataWriteAllowed: false,
  auditWriteAllowed: false,
  rollbackAnchorWriteAllowed: false,
  blockerCode: null,
  evidenceCode: 'host-mutation-adapter-mutation-ready',
}
```

测试：`assertAdapterResolved` 对每一 mutation row 必须断言上表 **全部** 字段；不得用模糊注释占位。

#### resolved / unresolved 的 exact 计数字段（防泄漏、无二义）

V1.26 为 **all-or-nothing** 解析（不做部分 resolved）：

| 结果 | `resolvedCount` | `unresolvedCount` | `mutations` |
| --- | --- | --- | --- |
| resolved | `expectedActionCount(operation)` | `0` | 长度 = expected；顺序 = expected action 序；每行 mutationReady true |
| **任意** unresolved（含 invalid/unsafe/trap） | `0` | `0` | `[]`（**永不**回显未信任输入行，**不**用恶意 input.length 填充计数） |

#### 一致语义

| 不变量 | 说明 |
| --- | --- |
| `state === 'resolved'` ⇔ `adapterReady === true` | 同真同假 |
| resolved ⇒ `blockers:[]`、`primaryBlocker:null`、`nextBlockers:[]`、`resolvedCount===expected`、`unresolvedCount===0`、`operation` 为 allowlisted 输入回显 | |
| unresolved ⇒ `blockers` 为 **单一 exact** allowlisted code 数组、`primaryBlocker===blockers[0]`、`nextBlockers===[primaryBlocker]`、`resolvedCount===0`、`unresolvedCount===0`、`mutations:[]` | |
| unresolved 且 primary ≠ `operation-invalid` ⇒ `decision.operation` **仍为** 输入 allowlisted operation | |
| unresolved 且 primary = `host-mutation-adapter-operation-invalid` ⇒ `decision.operation === 'unknown'` | schema **唯一** unknown 路径 |
| 任意 decision：wouldMutateHost / *Allowed / would* / realHostMutationImplementationReady 恒 false | adapter resolved ≠ host mutate |
| `codeOwnedResolverWired` 在 well-formed decision 上恒 true | 表示输出由 code-owned resolver 路径产生 |

### 1.6 Blocker vocabulary（收紧后 exact allowlist）

```js
const HOST_MUTATION_ADAPTER_BLOCKER_CODES = Object.freeze([
  'host-mutation-adapter-candidates-invalid',
  'host-mutation-adapter-operation-invalid',
  'host-mutation-adapter-action-missing',
  'host-mutation-adapter-action-duplicate',
  'host-mutation-adapter-action-unknown',
  'host-mutation-adapter-unsafe-mutation',
]);
```

**故意不引入（不可达 / 与分层冲突 / 与 registry 重叠）：**

| 不引入码 | 原因 |
| --- | --- |
| `host-mutation-adapter-operation-mismatch` | 无独立于 operation-invalid / 集合校验的路径 |
| `host-mutation-adapter-action-extra` | 在 duplicate→unknown→missing 下由鸽笼原理覆盖 |
| `host-mutation-adapter-implementation-mismatch` | implementationId 校验属于 V1.25 registry，不在 adapter 信任边界 |
| `host-mutation-adapter-mutation-kind-mismatch` | input **无** mutationKind 字段；kind 仅由 code-owned 表输出 |
| `host-mutation-adapter-real-implementation-missing` | readiness ready 后由 `realHostMutationImplementationReady:false` 表达；**不**再作为 readiness blockers 主码 |

#### 失败分类固定规则

| 类别 | 触发条件 | primaryBlocker |
| --- | --- | --- |
| 结构 invalid | 非 array；empty；容器/元素 shape / exact-key / accessor / trap / type-confusion；**snapshot 后 actionId 非非空 string** | **仅** `host-mutation-adapter-candidates-invalid` |
| 集合偏差 | 非 empty、元素 schema 已过、**且每项 actionId 已是非空 string**；actionId 集合与 E 不等 | 固定 **duplicate → unknown → missing** |
| unsafe mutation | 集合已与 E exact match 后，任一 candidate `status !== 'blocked'` **或** `wouldExecute/wouldRun/wouldWrite !== false` | **仅** `host-mutation-adapter-unsafe-mutation` |

**长度不等式：** `|A| !== |E|` **本身**绝不能直接映射为 `candidates-invalid`。pure 必须两侧覆盖：

| 侧 | pure case | 构造要点 | 唯一 primary |
| --- | --- | --- | --- |
| `len < \|E\|` | **H6** | install 子集 2 行（合法 shape） | `host-mutation-adapter-action-missing` |
| `len > \|E\|` | **H23** | fresh install 3 行 + 追加外来 `start-recovery-supervisor`（总长 4、无重复） | `host-mutation-adapter-action-unknown` |
| `len > \|E\|` | **H24** | fresh install 3 行 + 追加重复 `render-launch-agent-plist`（总长 4、有重复） | `host-mutation-adapter-action-duplicate` |

#### 评估顺序（稳定 primary；每失败类 **恰好一个** primary）

1. operation allowlist → `host-mutation-adapter-operation-invalid`
2. candidates 容器 / 元素 shape / exact keys / accessors / traps / type-confusion / empty → `host-mutation-adapter-candidates-invalid`（**不含** “长度 ≠ expected”）
3. **snapshot 后** 任一 `actionId` 非非空 string → **唯一** `host-mutation-adapter-candidates-invalid`（先于集合类）
4. duplicate actionId → `host-mutation-adapter-action-duplicate`
5. unknown actionId（∉ E）→ `host-mutation-adapter-action-unknown`
6. missing expected（A ⊆ E 且集合 ≠ E）→ `host-mutation-adapter-action-missing`
7. 集合已 exact match E 后，按 expected 序扫 snapshot：status / would* 非期望 → `host-mutation-adapter-unsafe-mutation`

多类同时成立时 **primary = 上表最先命中者**；`blockers` 输出至少含 primary；本版测试断言 **primary 与 blockers[0] exact 单一码**。

### 1.7 深拷贝 / 抗 mutation

1. 调用后改 input → 已返回 decision 不变。
2. 改已返回 decision → 后续调用不受污染。
3. 输出为新对象；`mutations` / `blockers` / `nextBlockers` / `safety` 均为新数组/新对象。
4. 异常映射固定 blocker，不泄露原值 / raw error。

---

## 2. Readiness helper

### 2.1 签名不变

```js
export function buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness()
```

无参数；忽略 runtime-looking 多余参数；不读 config/manifest/binding/preview/approval/env/fs。

### 2.2 输出（V1.26）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-host-mutation-adapter-readiness',
  state: 'ready',
  hostMutationAdapterDefined: true,
  hostMutationAdapterReady: true,
  codeOwnedAdapterResolverReady: true,      // readiness 级：resolver contract 已 ready
  realHostMutationImplementationReady: false, // 保持 false — 无真实 host mutation
  readyCount: 1,
  blockedCount: 0,
  adapterEntries: [ /* exactly 1 ready catalog entry */ ],
  blockers: [],
  nextBlockers: [],
  safety: executionPreviewSafety(),
}
```

### 2.3 字段命名与差异（必须解释）

| 字段 | 所在对象 | V1.26 值 | 含义 |
| --- | --- | --- | --- |
| `codeOwnedAdapterResolverReady` | **readiness** | `true` | 产品级 readiness：code-owned pure restricted adapter resolver contract 已就绪 |
| `codeOwnedResolverWired` | **adapterDecision**（及 entry 对齐字段） | 恒 `true` | 单次 decision 由已接线的 resolver 路径发出；**不是**“本次 mapping 一定 resolved”，**也不是** host 可 mutate |
| `realHostMutationImplementationReady` | readiness / decision / entry / mutation 行 | 恒 `false` | 无真实 host mutation implementation |
| `hostMutationAdapterReady`（readiness） | readiness builder | 固定 `true` | ≠ gate fact `gates.hostMutationAdapterReady` |
| `adapterReady`（decision） | adapterDecision | resolved 时 true | 单次映射核验结果 |
| `wouldMutateHost` / 全部 `*Allowed` | decision / entry / mutation 行 | 恒 `false` | 受限 contract 不授权任何 host side effect |

**禁止**在 decision 上使用 `codeOwnedAdapterResolverReady` 这个 readiness 级名字。
**禁止**把 `realHostMutationImplementationReady` 设为 true 或删除该键。
**禁止**把 `wouldMutateHost` 或任一 `*Allowed` 设为 true。

### 2.4 唯一 adapter entry

```js
{
  adapterKind: 'code-owned-host-mutation-adapter',
  state: 'ready',
  codeOwnedResolverWired: true,
  realHostMutationImplementationReady: false,
  realImplementationReady: false,
  wouldMutateHost: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  metadataWriteAllowed: false,
  auditWriteAllowed: false,
  rollbackAnchorWriteAllowed: false,
  blockerCode: null,
  evidenceCode: 'host-mutation-adapter-ready',
}
```

- 不再以 `state:'blocked'` / `disabled-host-mutation-adapter-stub` 作 readiness 主状态。
- readiness `blockers` 不再含 `host-mutation-adapter-real-implementation-missing` / `real-guarded-runner-execution-wiring-missing`（host 未就绪由 `realHostMutationImplementationReady:false` 表达；wiring 级 blocker 留在 wiring aggregate）。

---

## 3. Wiring contract

### 3.1 requiredContracts（顺序固定）

1. `execution-policy` → ready（V1.24）
2. `runner-registry` → ready（V1.25）
3. `host-mutation-adapter` → **ready**（V1.26）
4. `rollback-anchor` → blocked
5. `attempt-audit` → blocked
6. `operator-recovery` → blocked

### 3.2 Ready `host-mutation-adapter` contract

```js
{
  id: 'host-mutation-adapter',
  status: 'ready',
  requiredForExecution: true,
  evidence: 'Code-owned fail-closed restricted host mutation adapter resolver is wired.',
  evidenceCode: 'host-mutation-adapter-ready',
  blockerCode: null,
}
```

- `status === 'ready'` ⇒ `blockerCode === null` 且 `evidenceCode === 'host-mutation-adapter-ready'`
- Web 显示 `blocker:none` 仅为 UI sentinel；JSON 仍为 `null`
- 禁止 `status:'ready'` 与 missing blocker 并存

### 3.3 Wiring aggregate

```js
{
  command: 'supervisor-lifecycle-guarded-runner-wiring-contract',
  state: 'blocked',
  realRunnerWiringReady: false,
  readyCount: 3,
  blockedCount: 3,
  requiredContracts: [ /* 6 */ ],
  executionPolicyReadiness: /* ready */,
  runnerRegistryReadiness: /* ready */,
  hostMutationAdapterReadiness: /* ready builder */,
  rollbackAnchorReadiness: /* blocked */,
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

// runnerRegistryReady：保持 V1.25 本地 boolean（不回退）
// hostMutationAdapterReady：新增本地 boolean
const hostMutationAdapterReadiness = runnerWiringContract.hostMutationAdapterReadiness;
const hostMutationAdapterReady =
  hostMutationAdapterReadiness?.hostMutationAdapterReady === true &&
  hostMutationAdapterReadiness?.codeOwnedAdapterResolverReady === true &&
  hostMutationAdapterReadiness?.state === 'ready' &&
  hostMutationAdapterReadiness?.realHostMutationImplementationReady === false &&
  adapterDecision?.adapterReady === true &&
  adapterDecision?.state === 'resolved' &&
  adapterDecision?.codeOwnedResolverWired === true &&
  adapterDecision?.realHostMutationImplementationReady === false &&
  adapterDecision?.wouldMutateHost === false &&
  adapterDecision?.wouldExecute === false &&
  adapterDecision?.wouldRun === false &&
  adapterDecision?.wouldWrite === false &&
  adapterDecision?.launchctlAllowed === false &&
  adapterDecision?.filesystemWriteAllowed === false &&
  adapterDecision?.processListReadAllowed === false &&
  adapterDecision?.metadataWriteAllowed === false &&
  adapterDecision?.auditWriteAllowed === false &&
  adapterDecision?.rollbackAnchorWriteAllowed === false;

const policyContext = {
  // ...existing upstream booleans...
  actionCandidatesReady: actionCandidatesReady === true,
  runnerRegistryReady: runnerRegistryReady === true,
  hostMutationAdapterReady: hostMutationAdapterReady === true, // 不再 hardcoded false
  rollbackAnchorReady: false,
  attemptAuditReady: false,
  operatorRecoveryReady: false,
};
```

**硬性约束：**

- 不得从 `options` / request / CLI 读取 adapter override
- `options` 仅允许既有 `executeRequested` boolean
- 不得把 approval identity / path / hash / command / raw error 放进 resolver 或 policy context
- 不得因 adapter ready 而把 `executionEligible` / `wouldExecute` / `wouldMutateHost` / 任一 `*Allowed` 变 true

### 4.2 Gate 输出

```js
{
  // ...existing...
  registryDecision,  // V1.25 保持
  adapterDecision,   // V1.26 新增；含 wouldMutateHost / *Allowed / would*（decision locus）
  policyDecision,    // 含 wouldRun/wouldWrite（policy locus；≠ gate 顶层）
  actionCandidates,
  gates: {
    // ...
    actionCandidatesReady,
    executionPolicyReady: true,
    runnerRegistryReady,           // V1.25 语义
    hostMutationAdapterReady,      // production ready install fixtures → true
    realRunnerWiringReady: false,
    runnerWiringContractReady: false,
    rollbackAnchorReady: false,
    attemptAuditReady: false,
    operatorRecoveryReady: false,
  },
  // gate 顶层仅下列资格字段（V1.26 仍恒 false）：
  executionEligible: false,
  wouldExecute: false,
  // **无** gate 顶层 wouldRun / wouldWrite / wouldMutateHost
}
```

### 4.3 Production path 仍 deny

adapter ready 后 primaryBlocker 从 V1.25 的 `host-mutation-adapter-not-ready` **迁移为** `rollback-anchor-not-ready`。policy blockers 至少含后三 `*-not-ready`。

`executionEligible` 语义写死后三 + wiring aggregate 为 false → 结果必 false。测试必须覆盖 “adapter ready 后仍 deny 且 executionEligible false”。

**分层失败生产路径（必须可测）：**

| 场景 | actionCandidatesReady | registryDecision | adapterDecision | gates.runnerRegistryReady | gates.hostMutationAdapterReady | policy |
| --- | --- | --- | --- | --- | --- | --- |
| 合法 catalog + numeric maxAttempts + would* false | true | resolved | resolved | true | true | deny，primary=`rollback-anchor-not-ready`，**不含** `host-mutation-adapter-not-ready` / `runner-registry-not-ready` |
| 合法格式非 catalog `implementationId` | true | unresolved | **resolved** | **false** | **true** | deny，含 `runner-registry-not-ready`；**不含** `host-mutation-adapter-not-ready`（adapter fact true） |
| maxAttempts `'[redacted]'` | true | unresolved | **resolved** | **false** | **true** | deny，含 `runner-registry-not-ready` |
| empty / missing binding candidates | false | unresolved | unresolved | false | false | deny，含两者 not-ready（或更上游 blockers） |
| production 路径无法自然构造 would* true candidates | — | — | — | — | — | pure H12 覆盖 unsafe；gate 不强制 production 构造 would* true |

### 4.4 `sanitizeHostMutationAdapterDecision`

- 只保留 allowlisted keys
- blockers / primaryBlocker / nextBlockers 过滤到 `HOST_MUTATION_ADAPTER_BLOCKER_CODES`
- 强制 wouldMutateHost / 全部 *Allowed / would* / realHostMutationImplementationReady false；`codeOwnedResolverWired:true`
- 强制 state/adapterReady 一致；漂移 → unresolved + `host-mutation-adapter-candidates-invalid`
- unresolved 强制 `mutations:[]`、`resolvedCount:0`、`unresolvedCount:0`
- 返回新对象

---

## 5. API / CLI / Web

### 5.1 透传边界

| 通道 | 行为 |
| --- | --- |
| API | 既有 body 不变；响应透传 gate JSON；**不改** `src/server.js` |
| CLI | 既有 flags；JSON 透传；`--fail-on-blocked` 仍 exit 2；**不改** `src/agent.js` |
| Web | 不新增按钮/字段；**strict canonical fail-closed assembly**（§5.2） |

禁止 request/CLI 强制 `adapterDecision` / `hostMutationAdapterReady:true` / `adapterEntries` override；传入必须忽略。

#### 5.1.1 API / CLI 测试验证契约

V1.26 改造 **两个现有共用 helper**（参数化，非单点改一行布尔）：

| Helper | 文件 |
| --- | --- |
| `assertBlockedExecutionGate(body, { runnerRegistryReady, hostMutationAdapterReady })` | `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` |
| `assertBlockedGate(report, { runnerRegistryReady, hostMutationAdapterReady })` | `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` |

**共用 helper 固定（所有 200/成功 gate JSON 路径一致）：**

- wiring：`readyCount:3`、`blockedCount:3`
- `requiredContracts[2]`（`host-mutation-adapter`）：`status:'ready'`、`blockerCode:null`、`evidenceCode:'host-mutation-adapter-ready'`
- 后三：`requiredContracts.slice(3)` 全 `blocked`（**不得** `slice(2)`）
- `hostMutationAdapterReadiness`：`state:'ready'`、`hostMutationAdapterReady:true`、`codeOwnedAdapterResolverReady:true`、`realHostMutationImplementationReady:false`、ready entry exact
- `runnerRegistryReadiness` / contract[1]：**保持 V1.25 ready** 断言
- `gates.runnerRegistryReady`：**严格等于**调用方传入 boolean（**必传**）
- `gates.hostMutationAdapterReady`：**严格等于**调用方传入 boolean（**必传**；禁止用 `false` 默认掩盖漏传）
- policy：`state:'denied'` + would* false；gate 顶层 `executionEligible`/`wouldExecute` false

**共用 helper 不得固定（场景不同，只在专属 `it`）：**

- `adapterDecision.state` / `adapterDecision.adapterReady`
- `registryDecision.state` / `registryDecision.registryReady`
- `policyDecision.primaryBlocker`（含 ready 路径的 `rollback-anchor-not-ready`）
- no-approval / no-execute / missing-binding 等 primary 或 blockers 细节

**`gates.hostMutationAdapterReady` 语义矩阵（API/CLI）：**

| 条件 | gate fact |
| --- | --- |
| valid manifest + valid runnerBinding（action set 可构造；adapter resolve 成功） | **true** — 不论 `executeRequested` true/false、approval ready/not ready；**可独立于** registry resolve（非 catalog impl 时 registry false 但 adapter true） |
| missing `runnerBinding`（API 现有：empty candidates） | **false** |
| invalid manifest/binding | 通道级 400 / CLI exit 1；**不**经 blocked helper |

### 5.2 Web：strict canonical fail-closed assembly

#### 设计原则

Web **不得**仅因 `adapterEntries.length >= 1`、单字段 contract status、或 `gates.hostMutationAdapterReady` 孤值就显示 ready。
**共享单一 canonical predicate**（下称 `canonicalHostMutationAdapterReady`）：wiring line、adapter line、`validationLines.hostMutationAdapterReady` **必须**基于同一 boolean。

后三 contract（rollback-anchor / attempt-audit / operator-recovery）**永远不能**被 payload 推成 ready。
`runner-registry` 继续使用 V1.25 的 `canonicalRunnerRegistryReady`（C∧R∧G∧D_registry），**不得**与 adapter predicate 混用。

#### 共享单一 canonical predicate（C ∧ A ∧ G ∧ D）

记：

- `C` = `requiredContracts` 中 `id === 'host-mutation-adapter'` 的那一项
- `A` = `runnerWiringContract.hostMutationAdapterReadiness`
- `G` = `gates.hostMutationAdapterReady`
- `D` = `payload.adapterDecision`

```js
function isCanonicalHostMutationAdapterReady({ C, A, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'host-mutation-adapter-ready' &&
    C?.requiredForExecution === true &&
    A?.state === 'ready' &&
    A?.hostMutationAdapterReady === true &&
    A?.codeOwnedAdapterResolverReady === true &&
    A?.realHostMutationImplementationReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.adapterReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realHostMutationImplementationReady === false &&
    D?.wouldMutateHost === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false &&
    D?.launchctlAllowed === false &&
    D?.filesystemWriteAllowed === false &&
    D?.processListReadAllowed === false &&
    D?.metadataWriteAllowed === false &&
    D?.auditWriteAllowed === false &&
    D?.rollbackAnchorWriteAllowed === false
  );
}
```

**canonical ready 当且仅当** `isCanonicalHostMutationAdapterReady(...) === true`。
任一 missing / invalid / contradictory / side-effect flag true（含 `D.wouldMutateHost===true` 或任一 `*Allowed===true`）→ **false**。

#### Wiring contract lines（host-mutation-adapter）

- 从 `WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS` **移除** `host-mutation-adapter`。
- **ready 当且仅当** `canonicalHostMutationAdapterReady === true` →
  `wiringContract:host-mutation-adapter:status:ready:requiredForExecution:true:blocker:none`
- **否则固定** →
  `wiringContract:host-mutation-adapter:status:blocked:requiredForExecution:true:blocker:host-mutation-adapter-missing`
  （canonical blocked；**不**回显 payload blocker / secret 原文）
- 后三：仍 **固定** canonical missing blocked。
- `execution-policy` / `runner-registry`：保持既有 V1.24/V1.25 分支。

#### Adapter readiness line（同一 boolean）

- **ready 当且仅当** `canonicalHostMutationAdapterReady === true`：

```text
hostMutationAdapter:code-owned-host-mutation-adapter:state:ready:codeOwnedResolverWired:true:realHostMutationImplementationReady:false:wouldMutateHost:false:blocker:none
```

  必须显式含 `realHostMutationImplementationReady:false` **与** `wouldMutateHost:false`，避免 “ready = 可 mutate host” 误导。

- **否则固定 blocked**（始终输出恰好一行）：

```text
hostMutationAdapter:code-owned-host-mutation-adapter:state:blocked:codeOwnedResolverWired:true:realHostMutationImplementationReady:false:wouldMutateHost:false:blocker:host-mutation-adapter-not-ready
```

  **不得**泄漏 `OPAQUE_UNSAFE_FIELD` / secret-like adapterKind / 恶意 wouldMutateHost 原文。
  **禁止**继续渲染 `disabled-host-mutation-adapter-stub` 作为 V1.26 正常路径文案（恶意 payload 注入 stub kind 时仍输出上列 fixed blocked 行，不回显 payload kind）。

#### validationLines（同一 boolean）

- `hostMutationAdapterReady:true` **当且仅当** `canonicalHostMutationAdapterReady === true`；否则 `hostMutationAdapterReady:false`
- **禁止**仅 `gates.hostMutationAdapterReady===true` 就渲染 true
- 始终固定 `executionEligible:false`、后三 false、`realRunnerWiringReady:false`、`runnerWiringContractReady:false`
- `runnerRegistryReady` 继续用 V1.25 canonical（独立 boolean）

#### 强制 case：C/A/G 表面 ready、D.wouldMutateHost=true（side-effect 漂移）

当 `C`/`A`/`G` 均表面 ready，且 `D.state==='resolved' && D.adapterReady===true`，但 `D.wouldMutateHost===true`（或任一 `*Allowed===true` / would* true）时：

- `canonicalHostMutationAdapterReady === false`
- wiring line：**blocked** + `host-mutation-adapter-missing`
- adapter line：**blocked** + `host-mutation-adapter-not-ready`
- validation：`hostMutationAdapterReady:false`
- 后三仍 blocked
- **不得**出现任何 host-mutation-adapter / hostMutationAdapter **ready** 行
- 敏感/恶意值不回显

#### policyDecision line

- 保持 V1.24：**强制 denied**
- primaryBlocker 仅 allowlist 透传展示（ready path 展示 `rollback-anchor-not-ready`）

---

## 6. 版本 / README / Gold

- `LINKE_RELEASE_VERSION = 'V1.26'`
- README 标题、badge、version table：V1.26 当前，V1.25 历史
- Gold evidence 添加：`resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter`、`hostMutationAdapterReadiness.state:ready`、`hostMutationAdapterReady:true`、`codeOwnedAdapterResolverReady:true`、`codeOwnedResolverWired`、`host-mutation-adapter-ready`、`realHostMutationImplementationReady:false`、`adapterDecision`、`readyCount:3`/`blockedCount:3`
- 移除作为 **当前缺口** 的 `host-mutation-adapter-real-implementation-missing` / `host-mutation-adapter-missing`（历史叙述可保留）
- nextStep 指向 **rollback-anchor**（并明确真实 host mutation implementation 仍缺失）
- Gold 仍 `blocked`；G0a PASS 不变

---

## 7. 安全与非目标

### 安全

- 全路径无 host mutation / runner dispatch / launchctl / shell / process list / fs write / metadata / audit / NAS / network
- fixture 禁止：用户名形态绝对路径、SSH 路径形态、具体 IP/CIDR、真实邮箱、真实 command 名、credential 形态、64-hex digest
- 恶意 fixture 仅 opaque synthetic（`UNSAFE_SECRET_MATERIAL`、`OPAQUE_UNSAFE_FIELD`）
- 敏感扫描只报类别计数，不回显匹配行
- 输出深拷贝

### 非目标

- **不实现真实 host mutation adapter execution**（launchctl/shell/fs/process/metadata/audit）
- 不实现后三 wiring 真实能力（rollback-anchor / attempt-audit / operator-recovery）
- 不调度/调用 runner
- 不把 executionEligible 或 Gold 变 ready
- 不设 `realHostMutationImplementationReady:true` / `wouldMutateHost:true` / 任一 `*Allowed:true`
- 不声称可证明拒绝所有 Proxy
- 不改 V1.24 actionCandidates helper 契约
- 不改 V1.25 registry resolver 映射/redacted 契约
- 不修改 `src/agent.js` / `src/server.js` / `package.json`
- 不设计真实 recovery supervisor（仅 mutationKind 映射可解析）

### 下一步（显式非本版）

1. 真实 host mutation implementation（在 restricted adapter 之后，仍须 fail-closed + policy + 后三 wiring）
2. rollback-anchor code-owned contract（V1.26 之后的下一个 wiring Gold blocker）
3. attempt-audit / operator-recovery
4. 任一真实 side effect 前必须有独立设计证明不会越界；默认仍保持 Gold blocked 直到证明完成

---

## 8. Scope 文件列表（基于实际 rg，非猜测）

对以下硬编码/断言模式做了仓库扫描（排除 `node_modules` / `.git` / 本设计 docs）：

`host-mutation-adapter-missing`、`host-mutation-adapter-real-implementation-missing`、`disabled-host-mutation-adapter-stub`、`hostMutationAdapterReady:false`（gate hardcode）、`readyCount:2`+`blockedCount:4`（wiring 级）、`host-mutation-adapter-not-ready`（ready-path primary）、Web `hostMutationAdapter:` / `wiringContract:host-mutation-adapter` 行、version/README/Gold V1.25 当前标记。

### 允许修改（实现阶段）— 仅下列文件

| 文件 | 原因（rg 命中） |
| --- | --- |
| `src/supervisor-lifecycle.js` | resolver/readiness/wiring/gate 实现与常量 |
| `src/web/app.js` | wiring/adapter lines + validationLines + canonical predicate |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | pure/gate/readiness/wiring 断言 |
| `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` | API 透传断言 |
| `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` | CLI JSON 断言（**不改** `src/agent.js`） |
| `test/web-console.test.js` | Web assembly / 恶意 payload |
| `src/version.js` | `V1.26` |
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
git diff 22c33db -- src/supervisor-lifecycle.js | rg -n \
  'launchctl|child_process|execSync|spawn\(|exec\(|fs\.(write|rm|unlink|mkdir)|process\.kill|net\.|http\.|https\.' \
  && echo 'FAIL: side-effect call pattern in diff' || echo 'ok: no side-effect pattern in lifecycle diff'

# 敏感类别计数 only（不打印匹配行内容）
git diff 22c33db -- src/ test/ | rg -c \
  'ssh-rsa|BEGIN (RSA |OPENSSH )?PRIVATE|AKIA[0-9A-Z]{16}|[0-9a-f]{64}' \
  || true
# 期望：无命中；若有命中只报告 count，不得 cat 原文
```

### 无写入 scope / 锚点核对（人工允许列表；**不要**生成 `actual-changes.txt`；**不要** hard reset）

```bash
# 恢复锚点必须是当前 HEAD 祖先（无写入）
git merge-base --is-ancestor 22c33db HEAD && echo 'anchor-ok'

# 变更文件名必须 ⊆ §8 允许列表
git diff --name-only 22c33db --
git status --short

# 明确禁止文件无 diff
git diff --name-only 22c33db -- src/agent.js src/server.js package.json
# 期望：无输出
```

### 预期不变量

| 不变量 | 期望 |
| --- | --- |
| version | `V1.26` |
| wiring ready/blocked | 3 / 3 |
| production `gates.hostMutationAdapterReady` | true（ready install fixtures） |
| production `gates.runnerRegistryReady` | true（ready install fixtures；非 catalog 路径 false） |
| production policy | denied；ready path primary=`rollback-anchor-not-ready` |
| gate 顶层 `executionEligible` / `wouldExecute` | false |
| `adapterDecision` wouldMutateHost / *Allowed / would* | false |
| `realHostMutationImplementationReady` | false |
| Gold / G0a | blocked / PASS 不变 |
| agent/server/package | unmodified |

---

## 10. 运行韧性设计门

**正常态：** production gate `hostMutationAdapterReady:true`、`adapterDecision` resolved、`runnerRegistryReady:true`、`policyDecision` denied（primary=`rollback-anchor-not-ready`）、`executionEligible:false`；wiring 3/3；Gold blocked。

**三支柱：**

1. **有界失效：** 畸形 candidates / unsafe would* / 恶意 Web payload → unresolved 或 blocked Web 行 / 强制 denied policy；不抛敏感 raw error。
2. **异常恢复：** 若发现 request 可非法把 `executionEligible` / `wouldExecute` / `hostMutationAdapterReady` / `wouldMutateHost` 变 true → 立即硬编码 false + pure-only 路径。
3. **状态侦测：** pure / gate / API / CLI / Web / version / README / Gold + `npm test` + §9 无写入 diff 核对。

---

## 11. 完成标准

1. pure resolver 存在；不返回函数/command/path/host/token/hash/raw error；无副作用
2. 四 operation happy path `resolved` + wouldMutateHost false + 全部 *Allowed false
3. 每个失败类 **单一 exact** blocker；unknown/missing/duplicate/unsafe 可构造且不重叠；pure 必须覆盖 `len<|E|`（H6 → missing）与 `len>|E|`（H23 → unknown、H24 → duplicate）；长度不等式本身永不直接 `candidates-invalid`；snapshot 后非法 actionId 唯一 `candidates-invalid`；unsafe would* → `host-mutation-adapter-unsafe-mutation`
4. non-catalog implementationId 与 redacted maxAttempts：adapter 可 resolved 而 registry unresolved（intentional）；gate 两 fact 独立
5. readiness + required contract ready；`realHostMutationImplementationReady:false`；decision 用 `codeOwnedResolverWired`
6. wiring 3/3；后三 blocked；production deny + `executionEligible:false`；primary=`rollback-anchor-not-ready`
7. Web 共享单一 `canonicalHostMutationAdapterReady`（C∧A∧G∧D）；wiring/adapter/validation 同源；恶意/side-effect 漂移 payload 不能 ready；ready 行显式 `realHostMutationImplementationReady:false` + `wouldMutateHost:false`
8. 版本 V1.26；Gold blocked；G0a PASS 不变；nextStep 指向 rollback-anchor 并声明真实 host mutation 仍缺
9. 仅改 §8 列表；agent/server/package 未改；§9 无写入核对通过

---

## 12. 关键决策摘要

1. **本版完成 restricted adapter contract/readiness ready；不完成真实 host mutation execution。**
2. Public API：`resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, operation)`；≠ mutate/execute。
3. Code-owned 10 action→mutationKind 映射；mutationKind 仅为 plan identifier。
4. recover 仅映射解析，不执行 recovery supervisor。
5. `realHostMutationImplementationReady` / `wouldMutateHost` / 全部 `*Allowed` 保持 false；readiness 用 `codeOwnedAdapterResolverReady`；decision 用 `codeOwnedResolverWired`。
6. Adapter resolved ≠ host mutate；不得冒充 real implementation。
7. Proxy：best-effort 容器快照 + 元素 descriptor snapshot；不声称拒绝所有 Proxy。
8. unresolved 恒 `mutations:[]`、`resolvedCount:0`、`unresolvedCount:0`。
9. 分层：adapter 忽略 implementationId/maxAttempts 值内容；registry 继续负责 catalog/maxAttempts；unsafe would* 由 adapter 拒绝。
10. Web：共享单一 multi-field canonical predicate（C∧A∧G∧D）；禁止无条件固定 ready。
11. wiring 3/3；primary → `rollback-anchor-not-ready`；后三仍 blocked；policy 仍 deny。
12. 不新增 surface；不改 agent/server/package。
13. Scope 来自实际 rg；全量 `npm test` 兜底；无写入 merge-base + diff 允许列表核对。
14. 恢复锚点 `22c33db`；Gold blocked；G0a PASS 不变。
15. 下一步仍需真实 host mutation implementation + rollback-anchor / attempt-audit / operator-recovery。
