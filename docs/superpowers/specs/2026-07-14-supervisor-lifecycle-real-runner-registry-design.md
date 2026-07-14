# V1.25 Supervisor Lifecycle Real Runner Registry Design

## 目标

V1.25 用 **code-owned、纯函数、fail-closed、真实可验证的 runner registry resolver / readiness contract** 替换 V1.18 的 disabled registry catalog stub。本版本把 `runner-registry` required contract 从 `blocked/false` 推进为 `ready/true`，并在 execution gate 内基于 **production-derived sanitized `actionCandidates` + allowlisted `operation`** 调用 pure resolver，返回 sanitized `registryDecision`，把 policy context 的 `runnerRegistryReady` fact 接成严格验证后的本地 boolean。

V1.25 **必须继续保持**：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`
- `realRunnerWiringReady:false`
- 后四项 wiring facts false（hostMutation / rollbackAnchor / attemptAudit / operatorRecovery）
- gate 顶层：`executionEligible:false`、`executorReady:false`、`wouldExecute:false`（**gate 顶层没有** `wouldRun` / `wouldWrite` 字段）
- 副作用 would* 在其真实 locus 恒 false：`policyDecision.wouldRun/wouldWrite`、`registryDecision.wouldRun/wouldWrite`、`actionCandidates[]` 每项 `wouldExecute/wouldRun/wouldWrite`、readiness entry / mapping 行 would*
- `real-guarded-runner-execution-wiring-missing`
- Gold readiness: `blocked`
- G0a 真实双机 PASS 声明不变（不得改写为失败/未验收，也不得表述成 Gold ready）

V1.25 **必须改变**：

- `runnerRegistryReady:true`（readiness 固定 true；production gate fact 仅在 resolver 对 production candidates 解析成功时为 true）
- `runnerRegistryReadiness.state:'ready'` + `codeOwnedRegistryResolverReady:true` + `realRunnerImplementationsReady:false`
- `runnerWiringContract.requiredContracts[1]`（`runner-registry`）→ `status:'ready'`、`blockerCode:null`、`evidenceCode:'runner-registry-ready'`
- `runnerWiringContract.readyCount:2`、`blockedCount:4`
- production gate 返回 sanitized `registryDecision`；`runnerRegistryReady` 为本地 boolean
- 后四 wiring 仍 false → production `policyDecision` **始终 deny**；各 locus 副作用字段全 false

**不得**调度/调用 runner；不得 host shell / process-control / fs / metadata / audit / approval / rollback / NAS / 网络副作用。不新增 endpoint、CLI command、Web button、request body field。**禁止修改** `src/agent.js` / `src/server.js` / `package.json`。不得接受 request/CLI/Web 直传的 `registryDecision` / `registryContext` / `runnerRegistryReady` override。

**恢复锚点：** `1d7f9a2`（`feat: add V1.24 fail-closed execution policy`）。实现越界时回到该 commit 的干净状态再重做（见 §9 无写入核对；**禁止**在 plan/docs 中建议 `git reset --hard` 作为常规步骤）。

### 副作用 / 资格字段 locus（禁止“全部对象都有全部字段”误读）

| 字段 | 所在对象（唯一合法 locus） | V1.25 |
| --- | --- | --- |
| `executionEligible` | **仅** gate 顶层 | 恒 `false` |
| `wouldExecute` | gate 顶层；**另**见于 `registryDecision`、`actionCandidates[]`、readiness entry、mapping 行 | 恒 `false` |
| `wouldRun` / `wouldWrite` | **不在** gate 顶层；见于 `policyDecision`、`registryDecision`、`actionCandidates[]` 每项、readiness entry、mapping 行 | 恒 `false` |
| `gates.runnerRegistryReady` | `gates` 对象 | production resolve 成功时 true；否则 false |
| `runnerRegistryReady`（readiness 级） | `runnerRegistryReadiness` / readiness builder | 固定 true（≠ gate fact） |

**禁止**断言 `result.wouldRun` / `result.wouldWrite`（gate 顶层不存在）。断言 must 按上表 locus 精确落点。

---

## 设计选择总览

| 组件 | V1.18 / V1.24 | V1.25 |
| --- | --- | --- |
| registry catalog | disabled stub | code-owned 固定 action→implementation→runnerKind→mode 映射表 |
| resolver | 无 | 公开 pure `resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, operation)` |
| readiness | disabled, ready=false | fixed ready evidence, ready=true |
| required contract `runner-registry` | blocked + missing | ready + `blockerCode:null` + `evidenceCode:'runner-registry-ready'` |
| wiring readyCount / blockedCount | 1 / 5 | **2 / 4** |
| gate `runnerRegistryReady` | hardcoded false | readiness + production-derived resolver 本地 boolean |
| gate `registryDecision` | 无 | production candidates → resolver → sanitized decision |
| `realRunnerImplementationsReady` | false | **仍 false**（无 host runner） |
| decision 字段名 | — | `codeOwnedResolverWired:true`（见 §1.5 / §2.3；≠ readiness 字段） |
| gate 顶层 `executionEligible` / `wouldExecute` / Gold | false / blocked | 不变；**无** gate 顶层 `wouldRun`/`wouldWrite` |

---

## 1. 纯函数 registry resolver

### 1.1 导出（稳定 public pure API）

```js
/**
 * Resolve and verify sanitized guarded-runner action candidates against the
 * code-owned runner registry mapping table.
 *
 * Ready resolution means only that every candidate actionId maps to the fixed
 * implementationId / runnerKind / mode / numeric maxAttempts bounds for the
 * given operation. It does NOT schedule, dispatch, or invoke any runner; does
 * NOT authorize host mutation; does NOT set wouldExecute/wouldRun/wouldWrite
 * true; does NOT imply executionEligible.
 *
 * Returns a deep-copied plain decision object only — never functions,
 * command strings, paths, hosts, tokens, hashes, or raw Error objects.
 * Invalid input, getters, traps, or mapping mismatch → fail-closed unresolved.
 *
 * @param {unknown} candidates
 * @param {unknown} operation
 * @returns {object}
 */
export function resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, operation)
```

| 项 | 要求 |
| --- | --- |
| 可见性 | **export**；公共 JSDoc 声明语义与非执行边界 |
| 参数 | **仅** `candidates` + `operation`；不读 request/options/fs/env/manifest/runnerBinding；不接受 caller-supplied registryDecision |
| 返回 | 仅 plain object（深拷贝）；不返回 function / Promise / command / path / host / token / hash / raw error |
| 副作用 | 无 |
| 真值 | `state:'resolved'` 且 `registryReady:true` **仅**表示映射核验通过 |
| 假值 | invalid / mismatch / trap → `state:'unresolved'` + 单一 exact allowlisted primary blocker |

**命名：** 采用 `resolve...Registry`（resolve/readiness，不暗示 dispatch）。拒绝 `lookupRunner` / `getRunner` / `dispatch...` / `run...`。

### 1.2 输入：candidates + operation

`operation` 必须是 string 且 ∈ `{'install','uninstall','rollback','recover'}`；否则 unresolved + **唯一** blocker `runner-registry-operation-invalid`，decision.`operation` 输出 **`'unknown'`**（**仅此路径** 输出 unknown）。

**decision.operation 回显规则（禁止“所有 unresolved → unknown”）：**

| 输入 operation | 结果 state | decision.`operation` |
| --- | --- | --- |
| allowlisted（`install` / `uninstall` / `rollback` / `recover`） | resolved **或** unresolved（candidates/mapping/集合/side-effect 等任意失败） | **回显同一合法 operation 字符串** |
| 非 allowlisted / 非 string / 缺失等 | unresolved + `runner-registry-operation-invalid` | **`'unknown'`**（schema 唯一 unknown 来源） |

测试 helper `assertUnresolvedExact(decision, primaryBlocker, operation)` 的第三参 **必传**、禁止默认 `'unknown'`；合法 operation 输入的 unresolved 用例一律传对应合法 operation；**仅** invalid-operation（R17）传 expected `'unknown'`。

`candidates` 输入 **不是** “长度必须 equal `|E|`” 的 structure precondition。容器合法（array、非 empty、元素可快照）后，长度/集合偏差走 §1.6 集合类 blocker；**仅** `state:'resolved'` 成功时要求 actionId 集合与 expected set **exact match**（因而 `mappings.length === |E|`）。

结构入口：

1. 非 array / null / type-confusion → `runner-registry-candidates-invalid`
2. empty array（`len < 1`）→ `runner-registry-candidates-invalid`
3. 容器 trap / 元素 shape / exact-key 偏差 / accessor / trap / type-confusion → `runner-registry-candidates-invalid`
4. **snapshot 后** `actionId` 非「非空 string」（含 `''`、number、boolean、null、object 等）→ **唯一** `runner-registry-candidates-invalid`（**先于** duplicate / unknown / missing）
5. **长度 ≠ `|E|` 本身绝不能直接变** `candidates-invalid`（非 empty、元素 schema 过了、且每项 `actionId` 已是非空 string 之后，一律进入 duplicate → unknown → missing）

每个合法元素通过 §1.4 的 best-effort exact-key plain data property 单次快照。

#### Candidate exact keys（与现有 sanitized gate action candidate contract 一致）

```text
actionId, implementationId, runnerKind, mode, status,
wouldExecute, wouldRun, wouldWrite, maxAttempts
```

- 顺序无关；元素 **键集合** 多一个、少一个、同名原型污染键 → `runner-registry-candidates-invalid`（这是 **元素 shape**，不是数组长度）
- 无 own getter / accessor：每个 own key **恰好一次** `Object.getOwnPropertyDescriptor`，必须是 data property
- `Object.getPrototypeOf(element) === Object.prototype` 或 `=== null`
- descriptor / `ownKeys` throw → `runner-registry-candidates-invalid`；**不得**把 raw error message / stack / trap 返回值写入 decision

#### Candidate value constraints（snapshot 后；resolved 成功才要求集合 exact）

| 字段 | 约束 |
| --- | --- |
| `actionId` | **必须** 非空 string（`typeof === 'string' && length >= 1`）。snapshot 后若为 `''` / number / 其它非非空 string → **唯一** `runner-registry-candidates-invalid`，**不**进入 duplicate / unknown / missing 分类。resolved 成功时：数组内唯一且集合与 operation expected set **完全匹配**；合法 string 集合偏差按 §1.6 分类 |
| `implementationId` | string；必须 **exact match** code-owned catalog 对该 `actionId` 的固定值；且满足 `SAFE_IMPLEMENTATION_ID_PATTERN` |
| `runnerKind` | exact `'guarded-runner-stub'`（`GUARDED_RUNNER_KIND`） |
| `mode` | exact `'guarded-host-action'`（`GUARDED_RUNNER_BINDING_MODE`） |
| `status` | exact `'blocked'` |
| `wouldExecute` / `wouldRun` / `wouldWrite` | exact `false`（严格 boolean） |
| `maxAttempts` | **可核验整数** `1..3`；**拒绝** `'[redacted]'`、string `'1'`、`1.5`、`0`、`4`、非 number（见 §1.2.1）；resolved 行写回 **该 candidate snapshot 的 exact 整数** |

#### 1.2.1 分层契约：V1.24 helper vs V1.25 resolver（intentional fail-closed）

| 层 | 函数 | maxAttempts 规则 | 语义 |
| --- | --- | --- | --- |
| L-struct | `areSupervisorLifecycleGuardedRunnerActionCandidatesReady`（V1.24 已定） | 接受整数 `1..3` **或** `'[redacted]'` | **仅** sanitized structural shape ready |
| L-registry | `resolveSupervisorLifecycleGuardedRunnerRegistry`（V1.25） | **仅** number + `Number.isInteger` + `1..3` | 映射可核验；redacted 不可作为 ready resolve 输入 |

**结论：** production 路径上可以出现 `actionCandidatesReady === true` 且 `registryDecision.state === 'unresolved'`（例如 sanitized `maxAttempts:'[redacted]'`）。这是 **intentional layered fail-closed**，不是 bug。

- **禁止**为 V1.25 偷改 V1.24 helper 契约（全仓兼容 + 文档同步成本高，且会削弱 redacted 结构路径的既有语义）。
- V1.25 只在 resolver 层拒绝 redacted / 非整数，gate 将 `runnerRegistryReady` 置 false，policy 含 `runner-registry-not-ready`。

#### 1.2.2 candidates 的 ID 来源 vs resolver 信任边界（P1：非 catalog implementationId 可达）

| 来源 | 谁产生 ID | 是否可信 |
| --- | --- | --- |
| plan / `buildLifecycleActions` | `actionId` 集合 | 仅决定 expected action 集合 |
| manifest / runnerBinding / executionPreview | `implementationId`、`maxAttempts` 等 | **不可**注入 registry ready |
| gate `buildGuardedRunnerExecutionGateActionCandidates` | 从 preview 再 sanitize 成 candidates | 结构可 ready，**映射仍须 resolver 核验** |
| code-owned catalog（`src/supervisor-lifecycle.js` 冻结表） | 唯一可信 implementationId | resolver **只**接受此表 |

因此：

- 合法 slug 格式（过 `SAFE_IMPLEMENTATION_ID_PATTERN`）但 **不在 catalog** 的 `implementationId`（例如 `other-plist-impl`）→ **预期** `unresolved` + **唯一** `runner-registry-implementation-mismatch`。
- 生产路径若 preview/manifest 被换成非 catalog ID，gate 必须 `gates.runnerRegistryReady:false`，policy blockers 含 `runner-registry-not-ready`；gate 顶层 `executionEligible:false` / `wouldExecute:false`；`policyDecision` / `registryDecision` / `actionCandidates[]` 的 would* 全 false（**无** gate 顶层 `wouldRun`/`wouldWrite`）。

### 1.3 Code-owned 固定映射表

Registry **只信任** `src/supervisor-lifecycle.js` 内冻结表。manifest / runnerBinding / request / CLI / Web / executionPreview / approval / config / env / fs / caller-supplied decision **一律不可**注入 ready。

#### 1.3.1 Action 集合（必须来自 `buildLifecycleActions`，不得增减）

| operation | actionId（顺序固定） |
| --- | --- |
| `install` | `render-launch-agent-plist`, `write-launch-agent-plist`, `load-launch-agent` |
| `uninstall` | `unload-launch-agent`, `remove-launch-agent-plist`, `remove-supervisor-metadata` |
| `rollback` | `capture-current-state`, `restore-previous-plist`, `restart-previous-supervisor` |
| `recover` | `start-recovery-supervisor` |

#### 1.3.2 固定 implementation 映射

下列 ID 是 **registry mapping identifiers only**——不是 host executor、不是可调用函数、不是 shell/command。仓库中 **不存在**真实 host runner implementation。

| actionId | implementationId | runnerKind | mode | maxAttempts |
| --- | --- | --- | --- | --- |
| `render-launch-agent-plist` | `render-plist-impl` | `guarded-runner-stub` | `guarded-host-action` | 1..3 |
| `write-launch-agent-plist` | `write-plist-impl` | `guarded-runner-stub` | `guarded-host-action` | 1..3 |
| `load-launch-agent` | `load-agent-impl` | `guarded-runner-stub` | `guarded-host-action` | 1..3 |
| `unload-launch-agent` | `unload-agent-impl` | `guarded-runner-stub` | `guarded-host-action` | 1..3 |
| `remove-launch-agent-plist` | `remove-plist-impl` | `guarded-runner-stub` | `guarded-host-action` | 1..3 |
| `remove-supervisor-metadata` | `remove-metadata-impl` | `guarded-runner-stub` | `guarded-host-action` | 1..3 |
| `capture-current-state` | `capture-state-impl` | `guarded-runner-stub` | `guarded-host-action` | 1..3 |
| `restore-previous-plist` | `restore-plist-impl` | `guarded-runner-stub` | `guarded-host-action` | 1..3 |
| `restart-previous-supervisor` | `restart-supervisor-impl` | `guarded-runner-stub` | `guarded-host-action` | 1..3 |
| `start-recovery-supervisor` | `recovery-supervisor-impl` | `guarded-runner-stub` | `guarded-host-action` | 1..3 |

- **install** 三 ID 与既有 gate fixture `getValidManifest()` / `getValidRunnerBinding()` **exact 兼容**。
- uninstall / rollback / recover 映射仅供 pure unit tests；**不**表示已有 host executor。

#### 1.3.3 recover

`recover` 仅一 action：`start-recovery-supervisor`。V1.25 **不**设计/执行真实 recovery supervisor，不解除既有 apply-path blockers。Registry 仅允许映射解析为 `resolved`；绝不因此把 would* / executionEligible / host mutation 变 true。

### 1.4 单次快照 / Proxy 边界（准确声明）

**JavaScript 无法可靠识别所有 `Proxy`。** 本设计 **不声称**可证明拒绝所有 Proxy。

#### 数组容器边界（必须准确）

| 事实 | 含义 |
| --- | --- |
| `Array.isArray(proxyOfArray) === true` | **不能**用 `Array.isArray` 拒绝 array Proxy |
| `length` / 索引读可能触发 trap | 容器访问本身不是 free |
| `Reflect.ownKeys` / descriptor 也可能 trap | 不能声称“零 trap 触发” |

**容器策略（best-effort 一次性本地快照，不声称 exact descriptor 保证）：**

1. `try/catch` 包围整个 candidates 读取。
2. `Array.isArray(candidates)` 为 false / null → `runner-registry-candidates-invalid`。
3. 一次读取 `const len = candidates.length`（可能 trap）；非有限非负整数 → invalid；`len < 1`（empty）→ `runner-registry-candidates-invalid`。
4. **`len !== |E|` 不是 candidates-invalid**（只要 `len >= 1` 且元素可读，进入集合/映射评估）。
5. `for (let i = 0; i < len; i++)` **一次**读取 `candidates[i]` 到本地 `elements[]`；任何 throw → invalid。
6. 后续 **只**使用本地 `elements` + 元素级 snapshot；**禁止**再触碰原 `candidates` 容器。
7. **不**对 array 容器本身做 `getOwnPropertyDescriptor` 拒绝 Proxy；**不**声称“descriptor-level array purity”。

#### 元素级策略（与 V1.24 candidate snapshot 对齐）

1. 每个元素：`ownKeys` 一次；与 exact key allowlist 集合相等。
2. 每个 key **恰好一次** descriptor → data property → 写入本地 snapshot；**禁止** check-then-二次 `element[key]`。
3. 后续评估 **只读** snapshot。
4. trap throw / getter / type-confusion → `runner-registry-candidates-invalid`。

#### 生产路径三层防御

| 层 | 约束 |
| --- | --- |
| L1 Gate 构造 | candidates **只来自** `buildGuardedRunnerExecutionGateActionCandidates`；operation 来自 allowlisted plan/preview；不接收 request/options registry bag |
| L2 Resolver | best-effort 容器快照 + 元素 exact-key snapshot + code-owned mapping；非法 → unresolved |
| L3 副作用恒 false | 任意 decision：`wouldExecute/wouldRun/wouldWrite/supportsHostMutation/realHostRunnerReady` 恒 false；gate top-level `executionEligible/wouldExecute` 在 V1.25 亦恒 false |

### 1.5 Decision 输出 schema（exact）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-registry',
  operation: <allowlisted input echoed, OR 'unknown' only when operation-invalid>,
  state: 'resolved' | 'unresolved',
  registryReady: boolean,              // true only when fully resolved
  codeOwnedResolverWired: true,        // 见 §2.3：单次 decision 表示 resolver 路径已接线，恒 true
  realHostRunnerReady: false,          // V1.25 恒 false
  supportsHostMutation: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  resolvedCount: number,
  unresolvedCount: number,
  mappings: [ /* 见下 */ ],
  primaryBlocker: string | null,
  blockers: string[],
  nextBlockers: string[],
  sensitiveValuesReturned: false,
  safety: executionPreviewSafety(),
}
```

**命名：** 使用 `codeOwnedResolverWired`，**不用** `codeOwnedResolverReady`。后者易与 readiness 的 `codeOwnedRegistryResolverReady` 混淆，且在单次 decision 中恒 true，更准确描述为 “wired”。

#### mappings 行 schema（**仅** resolved 时非空；**不含** `codeOwnedResolverWired`）

```js
{
  actionId: string,                    // expected 序第 i 项
  implementationId: string,            // catalog exact
  runnerKind: 'guarded-runner-stub',
  mode: 'guarded-host-action',
  maxAttempts: number,                 // 对应 input candidate snapshot 的 exact 整数；Number.isInteger && 1..3
  mappingReady: true,
  realHostRunnerReady: false,
  supportsHostMutation: false,         // 每行必 false；plan assertResolved 必须断言
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  blockerCode: null,
  evidenceCode: 'runner-registry-mapping-ready',
}
```

测试：`assertResolved` 对每一 mapping row 必须断言上表 **全部** 字段（含 `supportsHostMutation:false` 与 `maxAttempts === inputSnapshot.maxAttempts`）；不得用模糊注释占位。

#### resolved / unresolved 的 exact 计数字段（防泄漏、无二义）

V1.25 为 **all-or-nothing** 解析（不做部分 resolved）：

| 结果 | `resolvedCount` | `unresolvedCount` | `mappings` |
| --- | --- | --- | --- |
| resolved | `expectedActionCount(operation)` | `0` | 长度 = expected；顺序 = expected action 序；每行 mappingReady true |
| **任意** unresolved（含 invalid/mismatch/trap） | `0` | `0` | `[]`（**永不**回显未信任输入行，**不**用恶意 input.length 填充计数） |

理由：用输入长度或“未解析行数”会泄漏恶意 payload 规模/形状；部分成功也不属于本版 scope。

#### 一致语义

| 不变量 | 说明 |
| --- | --- |
| `state === 'resolved'` ⇔ `registryReady === true` | 同真同假 |
| resolved ⇒ `blockers:[]`、`primaryBlocker:null`、`nextBlockers:[]`、`resolvedCount===expected`、`unresolvedCount===0`、`operation` 为 allowlisted 输入回显 | |
| unresolved ⇒ `blockers` 为 **单一 exact** allowlisted code 数组、`primaryBlocker===blockers[0]`、`nextBlockers===[primaryBlocker]`、`resolvedCount===0`、`unresolvedCount===0`、`mappings:[]` | |
| unresolved 且 primary ≠ `operation-invalid` ⇒ `decision.operation` **仍为** 输入 allowlisted operation（**禁止**一律写成 `'unknown'`） | candidates/mapping/集合/side-effect 失败保留合法 operation |
| unresolved 且 primary = `runner-registry-operation-invalid` ⇒ `decision.operation === 'unknown'` | schema **唯一** unknown 路径 |
| 任意 decision：would* / supportsHostMutation / realHostRunnerReady 恒 false | registry resolved ≠ host execute |
| `codeOwnedResolverWired` 在 well-formed decision 上恒 true | 表示输出由 code-owned resolver 路径产生 |

### 1.6 Blocker vocabulary（收紧后 exact allowlist）

```js
const RUNNER_REGISTRY_BLOCKER_CODES = Object.freeze([
  'runner-registry-candidates-invalid',
  'runner-registry-operation-invalid',
  'runner-registry-action-missing',
  'runner-registry-action-duplicate',
  'runner-registry-action-unknown',
  'runner-registry-implementation-mismatch',
  'runner-registry-runner-kind-mismatch',
  'runner-registry-mode-mismatch',
  'runner-registry-max-attempts-invalid',
  'runner-registry-side-effect-flag-invalid',
]);
```

**已删除（不可达 / 与其它码重叠）：**

| 删除码 | 原因 |
| --- | --- |
| `runner-registry-operation-mismatch` | 无独立于 `operation-invalid` / candidates 集合校验的真实触发路径；与 unknown/missing 重叠 |
| `runner-registry-action-extra` | 在 duplicate→unknown→missing 顺序下，unique + 全 ∈ expected 时 `length > expected` 由鸽笼原理不可能；含 unknown id 的“多余行”归 **unknown** |

#### 失败分类固定规则（candidates-invalid vs 集合类）

| 类别 | 触发条件 | primaryBlocker |
| --- | --- | --- |
| 结构 invalid | 非 array；empty；容器/元素 shape / exact-key 偏差 / accessor / trap / type-confusion；**snapshot 后 actionId 非非空 string**（含 `''`、number 等） | **仅** `runner-registry-candidates-invalid` |
| 集合偏差 | 非 empty、元素 schema 已过、**且每项 actionId 已是非空 string**；actionId 集合与 E 不等 | **禁止**用 candidates-invalid；固定 **duplicate → unknown → missing** |
| 映射/字段 | 集合已 exact match E 后的 per-field 核验 | implementation / runnerKind / mode / maxAttempts / side-effect 各单一码 |

**长度不等式：** `|A| !== |E|` **本身**绝不能直接映射为 `candidates-invalid`。长度偏差（无论 `|A| < |E|` 或 `|A| > |E|`）在元素 schema 与非空 string actionId 已过后，一律进入 **duplicate → unknown → missing**，**禁止**用“较长数组 / 较短数组”短路为 `candidates-invalid`。

**pure 测试必须两侧覆盖长度不等式（锁定分类，禁止错误实现把 `|A|>|E|` 直接 invalid）：**

| 侧 | pure case | 构造要点 | 唯一 primary |
| --- | --- | --- | --- |
| `len < \|E\|` | **R6** | install 子集 2 行（合法 shape） | `runner-registry-action-missing` |
| `len > \|E\|` | **R23** | fresh install 3 行 + 追加外来 `start-recovery-supervisor`（总长 4、无重复） | `runner-registry-action-unknown` |
| `len > \|E\|` | **R24** | fresh install 3 行 + 追加重复 `render-launch-agent-plist`（总长 4、有重复） | `runner-registry-action-duplicate` |

**actionId 类型边界（R22）：** snapshot 后 `actionId` 不是非空 string 时 **唯一** 映射 `runner-registry-candidates-invalid`，**禁止**把它当 unknown/missing/duplicate 处理。

#### 互不重叠、真正可构造的集合类输入

设 `E = expectedIds(operation)`，`A =` 快照后 **已确认为非空 string** 的 actionId 列表（已通过元素 schema + actionId 类型检查，**允许** `|A| ≠ |E|`）。

| blocker | 可构造输入（单一 exact） | 不变量 |
| --- | --- | --- |
| `runner-registry-action-duplicate` | `A` 中某 actionId 出现 ≥2 次（无论是否 ∈ E；可 `|A|≠|E|`） | 优先于 unknown/missing |
| `runner-registry-action-unknown` | `A` 无重复，且 ∃ id ∈ A 且 id ∉ E（可 `|A|≠|E|`） | 覆盖“替入外来 action”与“多出外来 id” |
| `runner-registry-action-missing` | `A` 无重复、A ⊆ E、且 A 作为集合 ≠ E（通常 `\|A\| < \|E\|`） | 仅缺 expected，无外来 id |
| （无 extra） | — | 见上删除理由 |

**示例（install，`|E|=3`）——每输入单一 primary，与 R5/R6/R7/R22/R23/R24 一致：**

| 输入 | primaryBlocker | pure |
| --- | --- | --- |
| 缺 `load-launch-agent`，仅 2 个合法 install id（`|A|=2≠3`） | `runner-registry-action-missing`（**不是** candidates-invalid） | **R6** |
| 用 `start-recovery-supervisor` 替换 `load-launch-agent`（仍 3 行、无重复） | `runner-registry-action-unknown` | **R5** |
| 两行同为 `render-launch-agent-plist`（`|A|=3`） | `runner-registry-action-duplicate` | **R7** |
| 3 合法 install + 第 4 行外来 id（`|A|=4≠3`，无重复） | **unknown**（外来 id；**不是** candidates-invalid） | **R23** |
| 3 合法 install + 第 4 行重复某 install id（`|A|=4≠3`） | **duplicate**（**不是** candidates-invalid） | **R24** |
| 首行 `actionId:''` 或 `actionId:1`（其余字段合法 shape） | **candidates-invalid**（**不是** unknown/missing/duplicate） | **R22** |
| `[]` / non-array / shape trap | **candidates-invalid** | R13–R16 / R21 等 |

#### 评估顺序（稳定 primary；每失败类 **恰好一个** primary）

1. operation allowlist → `runner-registry-operation-invalid`
2. candidates 容器 / 元素 shape / exact keys / accessors / traps / type-confusion / empty → `runner-registry-candidates-invalid`（**不含** “长度 ≠ expected”）
3. **snapshot 后** 任一 `actionId` 非非空 string（含 `''`、number、boolean、null、object 等）→ **唯一** `runner-registry-candidates-invalid`（**先于** duplicate / unknown / missing；与集合类互斥）
4. duplicate actionId → `runner-registry-action-duplicate`
5. unknown actionId（∉ E）→ `runner-registry-action-unknown`
6. missing expected（A ⊆ E 且集合 ≠ E）→ `runner-registry-action-missing`
7. per-candidate（集合已与 E exact match 后，按 expected 序扫 snapshot）：
   - implementation ≠ catalog 或非 string 或不满足 pattern → `runner-registry-implementation-mismatch`
   - runnerKind ≠ → `runner-registry-runner-kind-mismatch`
   - mode ≠ → `runner-registry-mode-mismatch`
   - maxAttempts 非整数或不在 1..3（含 `'[redacted]'`）→ `runner-registry-max-attempts-invalid`
   - status / would* 非期望 → `runner-registry-side-effect-flag-invalid`

实现：结构性 invalid（含非法 actionId 类型）可短路为 candidates-invalid；**长度偏差不得短路为 candidates-invalid**；mapping 类 mismatch **必须**可被 table tests 单独覆盖。多类同时成立时 **primary = 上表最先命中者**；`blockers` 输出至少含 primary；本版测试断言 **primary 与 blockers[0] exact 单一码**（允许 blockers 仅含该 primary，避免非确定多码集合）。

### 1.7 深拷贝 / 抗 mutation

1. 调用后改 input → 已返回 decision 不变。
2. 改已返回 decision → 后续调用不受污染。
3. 输出为新对象；`mappings` / `blockers` / `nextBlockers` / `safety` 均为新数组/新对象。
4. 异常映射固定 blocker，不泄露原值 / raw error。

---

## 2. Readiness helper

### 2.1 签名不变

```js
export function buildSupervisorLifecycleGuardedRunnerRegistryReadiness()
```

无参数；忽略 runtime-looking 多余参数；不读 config/manifest/binding/preview/approval/env/fs。

### 2.2 输出（V1.25）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-registry-readiness',
  state: 'ready',
  runnerRegistryDefined: true,
  runnerRegistryReady: true,
  codeOwnedRegistryResolverReady: true,   // readiness 级：resolver contract 已 ready
  realRunnerImplementationsReady: false,  // 保持 false — 无 host implementation
  readyCount: 1,
  blockedCount: 0,
  registryEntries: [ /* exactly 1 ready catalog entry */ ],
  blockers: [],
  nextBlockers: [],
  safety: executionPreviewSafety(),
}
```

### 2.3 字段命名与差异（必须解释）

| 字段 | 所在对象 | V1.25 值 | 含义 |
| --- | --- | --- | --- |
| `codeOwnedRegistryResolverReady` | **readiness** | `true` | 产品级 readiness：code-owned pure resolver / registry readiness contract 已就绪 |
| `codeOwnedResolverWired` | **registryDecision**（及 entry 对齐字段） | 恒 `true` | 单次 decision 由已接线的 resolver 路径发出；**不是**“本次 mapping 一定 resolved” |
| `realRunnerImplementationsReady` | readiness | 恒 `false` | 无 host-side-effect runner implementation |
| `realHostRunnerReady` / `realImplementationReady` | decision / entry | 恒 `false` | 同上，字段名保留以对齐既有 UI/entry shape |

**禁止**在 decision 上再使用 `codeOwnedResolverReady` 这个易混名。
**禁止**把 `realRunnerImplementationsReady` 设为 true 或删除该键。

### 2.4 唯一 registry entry

```js
{
  registryKind: 'code-owned-runner-registry',
  runnerKind: 'guarded-runner-stub',
  state: 'ready',
  codeOwnedResolverWired: true,
  realHostRunnerReady: false,
  realImplementationReady: false,
  supportsHostMutation: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  blockerCode: null,
  evidenceCode: 'runner-registry-ready',
}
```

- 不再以 `state:'blocked'` 作 readiness 主状态。
- readiness `blockers` 不再含 `runner-registry-real-implementation-missing` / `real-guarded-runner-execution-wiring-missing`（host 未就绪由 `realRunnerImplementationsReady:false` 表达；wiring 级 blocker 留在 wiring aggregate）。

---

## 3. Wiring contract

### 3.1 requiredContracts（顺序固定）

1. `execution-policy` → ready（V1.24）
2. `runner-registry` → **ready**（V1.25）
3. `host-mutation-adapter` → blocked
4. `rollback-anchor` → blocked
5. `attempt-audit` → blocked
6. `operator-recovery` → blocked

### 3.2 Ready `runner-registry` contract

```js
{
  id: 'runner-registry',
  status: 'ready',
  requiredForExecution: true,
  evidence: 'Code-owned fail-closed guarded runner registry resolver is wired.',
  evidenceCode: 'runner-registry-ready',
  blockerCode: null,
}
```

- `status === 'ready'` ⇒ `blockerCode === null` 且 `evidenceCode === 'runner-registry-ready'`
- Web 显示 `blocker:none` 仅为 UI sentinel；JSON 仍为 `null`
- 禁止 `status:'ready'` 与 missing blocker 并存

### 3.3 Wiring aggregate

```js
{
  command: 'supervisor-lifecycle-guarded-runner-wiring-contract',
  state: 'blocked',
  realRunnerWiringReady: false,
  readyCount: 2,
  blockedCount: 4,
  requiredContracts: [ /* 6 */ ],
  executionPolicyReadiness: /* ready */,
  runnerRegistryReadiness: /* ready builder */,
  hostMutationAdapterReadiness: /* blocked */,
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

const runnerRegistryReadiness = runnerWiringContract.runnerRegistryReadiness;
const runnerRegistryReady =
  runnerRegistryReadiness?.runnerRegistryReady === true &&
  runnerRegistryReadiness?.codeOwnedRegistryResolverReady === true &&
  runnerRegistryReadiness?.state === 'ready' &&
  runnerRegistryReadiness?.realRunnerImplementationsReady === false &&
  registryDecision?.registryReady === true &&
  registryDecision?.state === 'resolved' &&
  registryDecision?.codeOwnedResolverWired === true &&
  registryDecision?.realHostRunnerReady === false &&
  registryDecision?.wouldExecute === false &&
  registryDecision?.wouldRun === false &&
  registryDecision?.wouldWrite === false;

const policyContext = {
  // ...existing upstream booleans...
  actionCandidatesReady: actionCandidatesReady === true,
  runnerRegistryReady: runnerRegistryReady === true, // 不再 hardcoded false
  hostMutationAdapterReady: false,
  rollbackAnchorReady: false,
  attemptAuditReady: false,
  operatorRecoveryReady: false,
};
```

**硬性约束：**

- 不得从 `options` / request / CLI 读取 registry override
- `options` 仅允许既有 `executeRequested` boolean
- 不得把 approval identity / path / hash / command / raw error 放进 resolver 或 policy context

### 4.2 Gate 输出

```js
{
  // ...existing...
  registryDecision, // 含 wouldExecute/wouldRun/wouldWrite（decision locus）
  policyDecision,   // 含 wouldRun/wouldWrite（policy locus；≠ gate 顶层）
  actionCandidates, // 每项含 wouldExecute/wouldRun/wouldWrite
  gates: {
    // ...
    actionCandidatesReady,
    executionPolicyReady: true,
    runnerRegistryReady, // production ready install fixtures → true
    realRunnerWiringReady: false,
    runnerWiringContractReady: false,
    hostMutationAdapterReady: false,
    rollbackAnchorReady: false,
    attemptAuditReady: false,
    operatorRecoveryReady: false,
  },
  // gate 顶层仅下列资格字段（V1.25 仍恒 false）：
  executionEligible: false,
  wouldExecute: false,
  // **无** gate 顶层 wouldRun / wouldWrite — 勿断言 result.wouldRun / result.wouldWrite
}
```

### 4.3 Production path 仍 deny

registry ready 后 primaryBlocker 从 V1.24 的 `runner-registry-not-ready` **迁移为** `host-mutation-adapter-not-ready`。policy blockers 至少含后四 `*-not-ready`。

`executionEligible` 语义写死后四 + wiring aggregate 为 false → 结果必 false。测试必须覆盖 “registry ready 后仍 deny 且 executionEligible false”。

**分层失败生产路径（必须可测）：**

| 场景 | actionCandidatesReady | registryDecision | gates.runnerRegistryReady | policy |
| --- | --- | --- | --- | --- |
| 合法 catalog + numeric maxAttempts | true | resolved | true | deny，primary=`host-mutation-adapter-not-ready`，**不含** `runner-registry-not-ready` |
| 合法格式非 catalog `implementationId` | true（结构仍过 helper） | unresolved + `implementation-mismatch` | **false** | deny，含 `runner-registry-not-ready`；gate 顶层 `executionEligible/wouldExecute:false`；policy/registry/candidate would* false |
| maxAttempts `'[redacted]'`（sanitize 后） | true（V1.24 契约） | unresolved + `max-attempts-invalid` | **false** | deny，含 `runner-registry-not-ready`；gate 顶层 `executionEligible/wouldExecute:false`；policy/registry/candidate would* false |

### 4.4 `sanitizeRegistryDecision`

- 只保留 allowlisted keys
- blockers / primaryBlocker / nextBlockers 过滤到 `RUNNER_REGISTRY_BLOCKER_CODES`
- 强制 would* / supportsHostMutation / realHostRunnerReady false；`codeOwnedResolverWired:true`
- 强制 state/registryReady 一致；漂移 → unresolved + `runner-registry-candidates-invalid`
- unresolved 强制 `mappings:[]`、`resolvedCount:0`、`unresolvedCount:0`
- 返回新对象

---

## 5. API / CLI / Web

### 5.1 透传边界

| 通道 | 行为 |
| --- | --- |
| API | 既有 body 不变；响应透传 gate JSON；**不改** `src/server.js` |
| CLI | 既有 flags；JSON 透传；`--fail-on-blocked` 仍 exit 2；**不改** `src/agent.js` |
| Web | 不新增按钮/字段；**strict canonical fail-closed assembly**（§5.2） |

禁止 request/CLI 强制 `registryDecision` / `runnerRegistryReady:true` / `registryEntries` override；传入必须忽略。

#### 5.1.1 API / CLI 测试验证契约（共用 helper vs 专属 it）

V1.25 测试改造 **两个现有共用 helper**（非单点改一行布尔）：

| Helper | 文件 |
| --- | --- |
| `assertBlockedExecutionGate(body, { runnerRegistryReady })` | `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` |
| `assertBlockedGate(report, { runnerRegistryReady })` | `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` |

**共用 helper 固定（所有 200/成功 gate JSON 路径一致）：**

- wiring：`readyCount:2`、`blockedCount:4`
- `requiredContracts[1]`（`runner-registry`）：`status:'ready'`、`blockerCode:null`、`evidenceCode:'runner-registry-ready'`
- 后四：`requiredContracts.slice(2)` 全 `blocked`（**不得** `slice(1)`）
- `runnerRegistryReadiness`：`state:'ready'`、`runnerRegistryReady:true`、`codeOwnedRegistryResolverReady:true`、`realRunnerImplementationsReady:false`、ready entry exact（与 pure fixture 同形）
- `gates.runnerRegistryReady`：**严格等于**调用方传入的 boolean（**必传**；禁止用 `false` 默认掩盖漏传）
- policy：`state:'denied'` + would* false；gate 顶层 `executionEligible`/`wouldExecute` false

**共用 helper 不得固定（场景不同，只在专属 `it`）：**

- `registryDecision.state` / `registryDecision.registryReady`
- `policyDecision.primaryBlocker`（含 ready 路径的 `host-mutation-adapter-not-ready`）
- no-approval / no-execute / missing-binding 等 primary 或 blockers 细节

**`gates.runnerRegistryReady` 语义矩阵（API/CLI）：**

| 条件 | gate fact |
| --- | --- |
| valid manifest + valid runnerBinding（catalog match；candidates 可构造/resolve） | **true** — 不论 `executeRequested` true/false、approval ready/not ready |
| missing `runnerBinding`（API 现有：empty candidates） | **false** |
| invalid manifest/binding | 通道级 400 / CLI exit 1；**不**经 blocked helper |
| empty / not-verified / non-catalog / redacted | pure/gate 单测（G4/G8/G9）覆盖；API/CLI 不强制重复，除非新增专用 it |

**历史（V1.18/V1.24，非当前预期）：** helper 硬编码 `gates.runnerRegistryReady:false`、`readyCount:1`/`blockedCount:5`、`slice(1)` 全 blocked、readiness blocked + `runner-registry-real-implementation-missing` entry。

### 5.2 Web：strict canonical fail-closed assembly（禁止无条件固定 ready）

#### 设计原则

Web **不得**仅因 `registryEntries.length >= 1`、单字段 contract status、或 `gates.runnerRegistryReady` 孤值就显示 ready。
**共享单一 canonical predicate**（下称 `canonicalRunnerRegistryReady`）：wiring line、registry line、`validationLines.runnerRegistryReady` **必须**基于同一 boolean，禁止“仅 wiring 用 contract 字段 / registry 另算”的分叉语义。

后四 contract **永远不能**被 payload 推成 ready。

#### 共享单一 canonical predicate（C ∧ R ∧ G ∧ D）

记：

- `C` = `requiredContracts` 中 `id === 'runner-registry'` 的那一项
- `R` = `runnerWiringContract.runnerRegistryReadiness`
- `G` = `gates.runnerRegistryReady`
- `D` = `payload.registryDecision`

```js
// 伪代码：单一函数；wiring / registry / validation 共用返回值
function isCanonicalRunnerRegistryReady({ C, R, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'runner-registry-ready' &&
    C?.requiredForExecution === true &&
    R?.state === 'ready' &&
    R?.runnerRegistryReady === true &&
    R?.codeOwnedRegistryResolverReady === true &&
    R?.realRunnerImplementationsReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.registryReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realHostRunnerReady === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false
  );
}
```

**canonical ready 当且仅当** `isCanonicalRunnerRegistryReady(...) === true`。
任一 missing / invalid / contradictory / side-effect flag true（含 `D.wouldRun===true`）→ **false**。

#### Wiring contract lines（runner-registry）

- 从 `WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS` **移除** `runner-registry`。
- **ready 当且仅当** `canonicalRunnerRegistryReady === true` →
  `wiringContract:runner-registry:status:ready:requiredForExecution:true:blocker:none`
- **否则固定** →
  `wiringContract:runner-registry:status:blocked:requiredForExecution:true:blocker:runner-registry-missing`
  （canonical blocked；**不**回显 payload blocker / secret 原文；**禁止**“与 execution-policy 同模式仅看 contract 字段”的放宽）
- `execution-policy`：保持 V1.24 既有分支（独立 predicate；**不**与 runner-registry 共用放宽语义）。
- 后四：仍 **固定** canonical missing blocked；**永不**信任 payload status/blocker/evidence 变 ready。

#### Registry readiness line（同一 boolean）

- **ready 当且仅当** `canonicalRunnerRegistryReady === true`：

```text
runnerRegistry:code-owned-runner-registry:state:ready:codeOwnedResolverWired:true:realHostRunnerReady:false:wouldExecute:false:blocker:none
```

  必须显式含 `realHostRunnerReady:false` **与** `wouldExecute:false`，避免 “ready = 可执行” 误导。

- **否则固定 blocked**（始终输出恰好一行，UI 稳定）：

```text
runnerRegistry:code-owned-runner-registry:state:blocked:codeOwnedResolverWired:true:realHostRunnerReady:false:wouldExecute:false:blocker:runner-registry-not-ready
```

  **不得**泄漏 `OPAQUE_UNSAFE_FIELD` / secret-like runnerKind / 恶意 would* 原文。

#### validationLines（同一 boolean）

- `runnerRegistryReady:true` **当且仅当** `canonicalRunnerRegistryReady === true`；否则 `runnerRegistryReady:false`
- **禁止**仅 `gates.runnerRegistryReady===true` 就渲染 true
- 始终固定 `executionEligible:false`、后四 false、`realRunnerWiringReady:false`、`runnerWiringContractReady:false`
- error / unknown payload：fail-closed false；**无**信任型 ready/authorized 行

#### 强制 case：C/R/G 表面 ready、D.wouldRun=true（side-effect 漂移）

当 `C`/`R`/`G` 均表面 ready，且 `D.state==='resolved' && D.registryReady===true`，但 `D.wouldRun===true`（或其它 D side-effect flag true）时：

- `canonicalRunnerRegistryReady === false`
- wiring line：**blocked** + `runner-registry-missing`
- registry line：**blocked** + `runner-registry-not-ready`
- validation：`runnerRegistryReady:false`
- 后四仍 blocked
- **不得**出现任何 `runner-registry` / `runnerRegistry` **ready** 行
- 敏感/恶意值不回显

#### policyDecision line

- 保持 V1.24：**强制 denied**
- primaryBlocker 仅 allowlist 透传展示

---

## 6. 版本 / README / Gold

- `LINKE_RELEASE_VERSION = 'V1.25'`
- README 标题、badge、version table：V1.25 当前，V1.24 历史
- Gold evidence 添加：`resolveSupervisorLifecycleGuardedRunnerRegistry`、`runnerRegistryReadiness.state:ready`、`runnerRegistryReady:true`、`codeOwnedRegistryResolverReady:true`、`codeOwnedResolverWired`、`runner-registry-ready`、`realRunnerImplementationsReady:false`、`registryDecision`、`readyCount:2`/`blockedCount:4`
- 移除作为 **当前缺口** 的 `runner-registry-real-implementation-missing` / `runner-registry-missing`（历史叙述可保留）
- nextStep 指向 host-mutation-adapter
- Gold 仍 `blocked`；G0a PASS 不变

---

## 7. 安全与非目标

### 安全

- 全路径无 host mutation / runner dispatch
- fixture 禁止：用户名形态绝对路径、SSH 路径形态、具体 IP/CIDR、真实邮箱、真实 command 名、credential 形态、64-hex digest
- 恶意 fixture 仅 opaque synthetic（`UNSAFE_SECRET_MATERIAL`、`OPAQUE_UNSAFE_FIELD`）
- 敏感扫描只报类别计数，不回显匹配行
- 输出深拷贝

### 非目标

- 不实现后四 wiring 真实能力
- 不调度/调用 runner；不 launchctl/shell/fs/network
- 不把 executionEligible 或 Gold 变 ready
- 不设 `realRunnerImplementationsReady:true`
- 不声称可证明拒绝所有 Proxy
- 不改 V1.24 actionCandidates helper 的 maxAttempts/`[redacted]` 契约
- 不修改 `src/agent.js` / `src/server.js` / `package.json`
- 不设计真实 recovery supervisor（仅映射可解析）

---

## 8. Scope 文件列表（基于实际 rg，非猜测）

对以下硬编码/断言模式做了仓库扫描（排除 `node_modules` / `.git` / 本设计 docs）：

`runner-registry-missing`、`runner-registry-real-implementation-missing`、`runnerRegistryReady:false`、`readyCount:1`+`blockedCount:5`（wiring 级）、`buildSupervisorLifecycleGuardedRunnerRegistryReadiness` 期望、Web `runnerRegistry:` / `wiringContract:runner-registry` 行、version/README/Gold V1.24 当前标记。

### 允许修改（实现阶段）— 仅下列文件

| 文件 | 原因（rg 命中） |
| --- | --- |
| `src/supervisor-lifecycle.js` | resolver/readiness/wiring/gate 实现与常量 |
| `src/web/app.js` | wiring/registry lines + validationLines |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | pure/gate/readiness/wiring 断言 |
| `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` | API 透传断言 |
| `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` | CLI JSON 断言（**不改** `src/agent.js`） |
| `test/web-console.test.js` | Web assembly / 恶意 payload |
| `src/version.js` | `V1.25` |
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

### 无写入 scope / 锚点核对（人工允许列表；**不要**生成 `actual-changes.txt`；**不要** hard reset）

```bash
# 恢复锚点必须是当前 HEAD 祖先（无写入）
git merge-base --is-ancestor 1d7f9a2 HEAD && echo 'anchor-ok'

# 变更文件名必须 ⊆ §8 允许列表
git diff --name-only 1d7f9a2 --
git status --short

# 明确禁止文件无 diff
git diff --name-only 1d7f9a2 -- src/agent.js src/server.js package.json
# 期望：无输出
```

若 `git diff --name-only` 出现允许列表外文件：停止合并/提交，回退该文件改动或更新设计允许列表（需证明 rg 命中）。

### 预期不变量

| 不变量 | 期望 |
| --- | --- |
| version | `V1.25` |
| wiring ready/blocked | 2 / 4 |
| production `gates.runnerRegistryReady` | true（ready install fixtures） |
| non-catalog impl / redacted maxAttempts | `runnerRegistryReady:false` + policy 含 `runner-registry-not-ready` |
| production policy | denied；ready path primary=`host-mutation-adapter-not-ready` |
| gate 顶层 `executionEligible` / `wouldExecute` | false（**无** gate 顶层 wouldRun/wouldWrite） |
| `policyDecision` / `registryDecision` / `actionCandidates[]` / readiness entry would* | false |
| `realRunnerImplementationsReady` / `realHostRunnerReady` | false |
| Gold / G0a | blocked / PASS 不变 |
| agent/server/package | unmodified |

---

## 10. 运行韧性设计门

**正常态：** production gate `runnerRegistryReady:true`、`registryDecision` resolved、`policyDecision` denied（primary=`host-mutation-adapter-not-ready`）、`executionEligible:false`；wiring 2/4；Gold blocked。

**三支柱：**

1. **有界失效：** 畸形 candidates / 恶意 Web payload → unresolved 或 blocked Web 行 / 强制 denied policy；不抛敏感 raw error。
2. **异常恢复：** 若发现 request 可非法把 `executionEligible` / `wouldExecute` / `runnerRegistryReady` 变 true → 立即硬编码 false + pure-only 路径。
3. **状态侦测：** pure / gate / API / CLI / Web / version / README / Gold + `npm test` + §9 无写入 diff 核对。

---

## 11. 完成标准

1. pure resolver 存在；不返回函数/command/path/host/token/hash/raw error；无副作用
2. 四 operation happy path `resolved` + would* false
3. 每个失败类 **单一 exact** blocker；unknown/missing/duplicate 可构造且不重叠；pure 必须覆盖 `len<|E|`（R6 → missing）与 `len>|E|`（R23 → unknown、R24 → duplicate）两侧；长度不等式本身永不直接 `candidates-invalid`；snapshot 后非法 actionId（`''`/number）唯一 `candidates-invalid` 且先于集合类；无 operation-mismatch / action-extra 词汇
4. 非 catalog implementationId 与 `'[redacted]'` maxAttempts：pure **与** production gate G8/G9 均可 fail-closed（`gates.runnerRegistryReady:false`、policy 含 `runner-registry-not-ready`、各 locus 副作用 false）；helper true + resolver unresolved 为 intentional；pure R8/R12 **不能**替代 G8/G9
5. readiness + required contract ready；`realRunnerImplementationsReady:false`；decision 用 `codeOwnedResolverWired`
6. wiring 2/4；后四 blocked；production deny + `executionEligible:false`
7. Web 共享单一 `canonicalRunnerRegistryReady`（C∧R∧G∧D）；wiring/registry/validation 同源；恶意/side-effect 漂移 payload 不能 ready；ready 行显式 `realHostRunnerReady:false` + `wouldExecute:false`；禁止 wiring 仅 contract 字段放宽
8. 版本 V1.25；Gold blocked；G0a PASS 不变
9. 仅改 §8 列表；agent/server/package 未改；§9 无写入核对通过

---

## 12. 关键决策摘要

1. Public API：`resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, operation)`；≠ dispatch。
2. Code-owned 10 映射；install 三 ID 与 fixture 兼容；其余 mapping-only。
3. recover 仅映射解析，不执行 recovery supervisor。
4. `realRunnerImplementationsReady` 保持 false；readiness 用 `codeOwnedRegistryResolverReady`；decision 用 `codeOwnedResolverWired`。
5. Registry resolved ≠ host execute。
6. Proxy：**best-effort** 容器快照 + 元素 descriptor snapshot；不声称拒绝所有 Proxy / array exact descriptor。
7. unresolved 恒 `mappings:[]`、`resolvedCount:0`、`unresolvedCount:0`（防长度泄漏）。
8. 删除不可达 blocker：`operation-mismatch`、`action-extra`。
9. 分层：V1.24 helper 保留 `[redacted]`；resolver 要求 numeric 1..3。
10. 非 catalog implementationId 可达且必须 fail-closed。
11. Web：共享单一 multi-field canonical predicate（C∧R∧G∧D）；wiring/registry/validation 同源；非无条件固定 ready；禁止 wiring 仅 contract 字段放宽。
12. 输入长度 ≠ `|E|` 不进 candidates-invalid；集合偏差固定 duplicate→unknown→missing；pure 必测两侧：R6（`len<|E|`）+ R23/R24（`len>|E|`）。
13. snapshot 后 actionId 非非空 string（`''`/number 等）唯一 `candidates-invalid`，先于 duplicate/unknown/missing。
14. gate 顶层仅 `executionEligible`/`wouldExecute`；`wouldRun`/`wouldWrite` 仅在 policyDecision / registryDecision / candidate / readiness entry / mapping 行。
15. Scope 来自实际 rg；全量 `npm test` 兜底；无写入 merge-base + diff 允许列表核对。
16. 恢复锚点 `1d7f9a2`；Gold blocked；G0a PASS 不变。
