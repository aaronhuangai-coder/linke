# V1.24 Supervisor Lifecycle Fail-Closed Execution Policy Design

## 目标

V1.24 用 **code-owned、纯函数、fail-closed 的真实 execution policy evaluator** 替换 V1.23 的 disabled execution policy stub。本版本把 `execution-policy` required contract 从 `blocked/false` 推进为 `ready/true`，并在 execution gate 内基于 production-derived boolean facts 调用 evaluator，返回 sanitized `policyDecision`。

V1.24 **必须继续保持**：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`
- `realRunnerWiringReady:false`
- `runnerRegistryReady:false`
- `hostMutationAdapterReady:false`
- `rollbackAnchorReady:false`
- `attemptAuditReady:false`
- `operatorRecoveryReady:false`
- `executionEligible:false`
- `executorReady:false`
- `wouldExecute:false`
- `wouldRun:false`
- `wouldWrite:false`
- `real-guarded-runner-execution-wiring-missing`
- Gold readiness: `blocked`

V1.24 **必须改变**：

- `executionPolicyReady:true` / `realExecutionPolicyReady:true`
- `executionPolicyReadiness.state:'ready'`
- `runnerWiringContract.requiredContracts[0]`（`execution-policy`）为 `status:'ready'`
- `runnerWiringContract.readyCount:1`、`blockedCount:5`
- production gate 路径返回 sanitized `policyDecision`，且因五个下游 contract 仍 false 而 **始终 deny**

不新增 endpoint、CLI command、Web button 或 request body field。`src/agent.js` / `src/server.js` 不得接受 request/CLI 直传的 `policyContext` / `policyDecision`。不得执行 lifecycle apply，不得调用 host shell / process-control APIs，不得读取进程列表，不得读写 filesystem/metadata/audit/approval，不得调度 runner，不得连接 NAS，不得触发备份/恢复，不得执行远程命令。

**恢复锚点：** `2b53f4d`（`docs: record G0a real two-Mac acceptance`）。实现越界或测试失败时回到该 commit。

**G0a 声明保持不变：** README / report 中 G0a 真实双机 PASS 不得改写为失败或“未验收”；也不得把 G0a PASS 表述成 Gold ready。

---

## 设计选择总览

| 组件 | V1.23 | V1.24 |
| --- | --- | --- |
| evaluator | 不存在 | `evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context)` |
| action-candidates structural helper | 内联/未公开 | **公开 pure** `areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, operation): boolean` |
| readiness helper | disabled stub, ready=false | fixed real ready evidence, ready=true |
| required contract `execution-policy` | blocked + `execution-policy-missing` | ready + `blockerCode:null` + `evidenceCode:'execution-policy-ready'` |
| wiring readyCount / blockedCount | 0 / 6 | 1 / 5 |
| gate `executionPolicyReady` | hardcoded false | true（来自 readiness） |
| gate `actionCandidatesReady` | 无独立公开 helper | gate 调用上述公开 helper 写入本地 boolean；**≠ authorize/wouldRun** |
| gate `policyDecision` | 无 | production-derived context → evaluator → sanitized decision |
| executionEligible / wouldExecute | false | 仍 false（下游五 contract 未 ready） |
| Gold | blocked | blocked |

---

## 1. 纯函数 evaluator

### 1.1 导出

```js
export function evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context)
```

- 纯函数：不读文件系统、环境变量、网络、进程、时钟；不写任何状态；不调用 host shell / process-control APIs。
- 绝不产生 side effect。
- 输入与输出均深拷贝语义：调用后 mutation input 不影响已返回 decision；mutation returned decision 不影响后续调用（见 §1.7）。

### 1.2 Context schema（exact-key plain object）与三层防御

Context **必须**同时满足（对外 **best-effort exact data property validation**）：

1. `context !== null && typeof context === 'object'`
2. `!Array.isArray(context)`
3. `Object.getPrototypeOf(context) === Object.prototype` 或 `=== null`（拒绝 class instance / 特殊内置对象）
4. 无 own getter / accessor：对每个 own key，通过 **单次** `Object.getOwnPropertyDescriptor` 捕获，descriptor 必须是 **data property**（存在 `value`，不存在 `get`/`set`），且 `value` 为期望 primitive 类型
5. own keys **恰好**为下列集合（顺序无关；多一个、少一个、同名原型污染键均 deny）：

```text
operation
lifecyclePlanValid
approvalRecordReady
manifestReady
runnerBindingsReady
executionPreviewVerified
executeRequested
actionCandidatesReady
runnerRegistryReady
hostMutationAdapterReady
rollbackAnchorReady
attemptAuditReady
operatorRecoveryReady
```

6. `operation` 必须是 string 且 ∈ `{'install','uninstall','rollback','recover'}`
7. 除 `operation` 外每个 fact 必须是 **严格 boolean**（`true`/`false`）；拒绝 `0`/`1`/`'true'`/`new Boolean()`/`undefined`
8. **不得**出现或接受：approval identity/reason/token/path/host/command/hash/raw error/URL/username/process id/notification payload

#### 1.2.1 Proxy / accessor 能力边界（禁止过度承诺）

**JavaScript 无法可靠识别所有 `Proxy`。** 本设计 **不声称**、**不要求**实现“可证明拒绝所有 Proxy”。

Evaluator 对外仅做 **best-effort** 校验：

- 拒绝可观测的 accessor / getter own properties
- 拒绝 prototype 非 `Object.prototype|null` 的对象
- 拒绝 own keys 集合与 exact allowlist 不一致
- 拒绝非严格 boolean / 非法 operation
- 任何 descriptor 读取、`ownKeys` 枚举、取值过程中的 **throw**（含 trap throw）一律映射为固定 `execution-policy-context-invalid`，**不得**把 raw error message / stack / trap 返回值写入 decision

**生产路径三层防御（真正安全边界，不依赖“识别全部 Proxy”）：**

| 层 | 约束 |
| --- | --- |
| L1 Gate 构造 | production policy context **只在 gate 内部**从本地已计算的 **primitive booleans + allowlisted operation string** 逐字段字面量构造；**不接收** request 对象、options 对象、CLI bag、或任何 caller-supplied object 作为 context |
| L2 Evaluator | best-effort exact-key data-property validation；非法 → deny + `execution-policy-context-invalid` |
| L3 副作用恒 false | 任意 decision（含 synthetic authorized）`wouldRun`/`wouldWrite`/全部 `allow*` 恒 `false`；gate top-level `executionEligible`/`wouldExecute` 在 V1.24 亦恒 false |

因此：即便某个 adversarial 对象在 unit test 中“骗过”部分 best-effort 检查，**production path 从不把外部对象当作 context**，且授权成功也不会打开 host side effect。

#### 1.2.2 单次快照读取策略（避免 check-then-read TOCTOU）

实现 **不得**先“校验通过”再二次 `context[key]` 取值做决策（避免 getter/Proxy trap 在两次读取间改变结果）。

**规定：**

1. 枚举 own keys 一次（`Reflect.ownKeys` 或等价），与 allowlist 做集合相等比较；枚举 throw → invalid。
2. 对每个 allowlisted key，**恰好一次** `Object.getOwnPropertyDescriptor(context, key)`：
   - descriptor 缺失 / 非 data property / 含 get|set → invalid
   - 从 descriptor **直接读取** `descriptor.value` 作为该字段的唯一 snapshot primitive
3. 后续评估 **只读 snapshot 本地对象**（plain `{ operation, ...facts }` 的本地拷贝），不再触碰原始 `context`
4. 若无法保证无 TOCTOU：以“逐字段 descriptor 一次性捕获原始 primitive”为规范，**禁止**先验后读

### 1.3 `actionCandidatesReady` 与公开 pure helper

`actionCandidatesReady` **不是** “会执行 / wouldRun / host execute / authorize” 的信号。

#### 1.3.1 公开 pure helper（稳定名称；A3/A4/A5 可达性依赖此出口）

**不得**把结构校验只藏在未导出的 `computeActionCandidatesReady` / 未定义 `getInputsWith*` 路径里。V1.24 **必须**导出下列稳定公开 pure helper，供 pure unit tests **直接**构造 synthetic malformed 数组覆盖 A1–A7（不依赖 `buildGate` 是否能注入畸形 candidates）：

```js
/**
 * Structural readiness for sanitized guarded-runner action candidates.
 * Returns true only when candidates pass exact schema / nonempty / unique
 * actionId / operation expected-set match / sensitive-field-free checks.
 * Does NOT authorize execution, wouldRun, wouldWrite, or executionEligible.
 * Invalid input, getters, or traps yield false. Returns boolean only — no metadata.
 *
 * @param {unknown} candidates - already-sanitized candidate array (or invalid input)
 * @param {unknown} operation - allowlisted lifecycle operation string
 * @returns {boolean}
 */
export function areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, operation)
```

**硬性契约：**

| 项 | 要求 |
| --- | --- |
| 可见性 | **export** 公共 API；公共 **JSDoc** 必须声明语义与非授权边界 |
| 参数 | **仅**接收 `candidates` + `operation`；不读 request/options/fs/env；不接受 metadata 输出 bag |
| 返回 | **仅** `boolean`；**不**返回 metadata / blockers / reasons / partial scores |
| 真值 | 同时满足：数组 **nonempty**；每元素 **exact allowlisted schema**（keys/types 与既有 sanitized gate action candidate contract 一致；未知 key / 缺必需字段 → false）；每个 `actionId` 非空 string 且数组内 **唯一**；候选 `actionId` 集合与 **operation 预期 action 集合完全匹配**（既有 V1.x operation→expected set；多余/缺失/错映射 → false）；**sensitive-field-free**（不得含 path/token/host/command/hash 等敏感字段；出现 → false） |
| 假值 | 任何 invalid input（`null` / non-array / non-object element / 非法 operation / type-confused）；own getter / accessor；descriptor/`ownKeys` trap throw；上述结构任一失败 → **`false`**（不抛敏感 raw error） |
| 非目标 | **不等于** `authorize` / `wouldAuthorizeExecution` / `wouldRun` / `wouldWrite` / `executionEligible`；helper `true` 仅表示结构可进入 policy evaluation |

Gate 内写法（本地 boolean，再写入 policy context；**绝不**把 candidates 数组传入 evaluator）：

```js
const actionCandidates = buildGuardedRunnerExecutionGateActionCandidates(plan, executionPreview);
const actionCandidatesReady = areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
  actionCandidates,
  operation,
);
```

**禁止：** request/CLI/Web payload 直传 `actionCandidatesReady`；虚构未定义的 `getInputsWithSchemaInvalidCandidates` / `getInputsWithDuplicateActionIds` / `getInputsWithOperationSetMismatch` 等 gate 注入 helper 来“覆盖” A3/A4/A5。

#### 1.3.2 语义

| 含义 | 是 / 否 |
| --- | --- |
| 表示 sanitized `actionCandidates` 已通过 **公开 pure helper** 结构验证，**可进入 policy evaluation** | 是 |
| 表示 policy 将 authorize | 否 |
| 表示 `wouldRun` / `wouldWrite` / host execute | 否 |
| 表示 `executionEligible` | 否 |

Evaluator 仅消费该 boolean：

- `actionCandidatesReady === false` → blocker `action-candidates-not-ready`
- `actionCandidatesReady === true` **仅**表示可进入 evaluation；**当前 production** 即便 candidates 结构 ready，五个下游 wiring facts 仍 false → policy **仍 denied**，且 `executionEligible` 仍 false

#### 1.3.3 TDD 分层（pure 可达 A1–A7；gate 集成不虚构 getInputs）

**层 P — pure unit（直接调用 helper；synthetic malformed 数组可达）：**

| # | 输入条件（synthetic `candidates` / `operation`） | helper 返回 | 说明 |
| --- | --- | --- | --- |
| A1 | 非空 + exact schema + unique actionId + operation 预期集合完全匹配 + sensitive-field-free | `true` | 结构 ready only |
| A2 | 空数组 | `false` | nonempty 失败 |
| A3 | 缺必需 schema 字段 / 含未知 key | `false` | exact schema 失败 |
| A4 | 重复 `actionId` | `false` | 唯一性失败 |
| A5 | candidates 与 operation 预期集合不完全匹配 | `false` | expected-set 失败 |
| A6 | trap / own getter / non-array / null / 非法 operation / type-confused | `false` | invalid input fail-closed |
| A7 | 含 path/token/host/command/hash 等敏感字段（opaque 键名或字段） | `false` | sensitive-field-free 失败 |

**层 G — gate 集成（仅验证 helper 结果接线 + production deny；禁止虚构未定义 getInputs helpers）：**

| # | 场景 | 断言 |
| --- | --- | --- |
| G1 | production ready inputs → **valid** sanitized candidates | `gates.actionCandidatesReady === true`；`policyDecision` denied；blockers 含五个下游 not-ready；`executionEligible:false`；`wouldExecute:false` |
| G2 | 可构造的 **empty** sanitized candidates 路径 | `gates.actionCandidatesReady === false`；blockers 含 `action-candidates-not-ready`；`executionEligible:false` |
| G3 | （可选）对 gate 输出的 candidates 再调 helper，结果与 `gates.actionCandidatesReady` 一致 | 证明 gate 使用同一公开 helper，而非平行未测试逻辑 |

**不在 gate 集成中要求：** 通过未定义的 `getInputsWithSchemaInvalidCandidates()` 等注入 A3/A4/A5 畸形数组——那些路径由 **层 P** pure tests 覆盖。

### 1.4 输入 fail-closed 分类

| 条件 | 结果 | primary blockerCode |
| --- | --- | --- |
| 非 plain exact-key object / unknown key / missing key / 可观测 accessor / type-confused / descriptor 读取 throw | denied | `execution-policy-context-invalid` |
| operation 非法 | denied | `execution-policy-operation-invalid` |
| `lifecyclePlanValid === false` | denied | `lifecycle-plan-not-ready` |
| `approvalRecordReady === false` | denied | `approval-record-gate-not-ready` |
| `manifestReady === false` | denied | `executor-manifest-not-ready` |
| `runnerBindingsReady === false` | denied | `guarded-runner-readiness-not-ready` |
| `executionPreviewVerified === false` | denied | `execution-preview-not-verified` |
| `executeRequested === false` | denied | `execute-request-missing` |
| `actionCandidatesReady === false` | denied | `action-candidates-not-ready` |
| `runnerRegistryReady === false` | denied | `runner-registry-not-ready` |
| `hostMutationAdapterReady === false` | denied | `host-mutation-adapter-not-ready` |
| `rollbackAnchorReady === false` | denied | `rollback-anchor-not-ready` |
| `attemptAuditReady === false` | denied | `attempt-audit-not-ready` |
| `operatorRecoveryReady === false` | denied | `operator-recovery-not-ready` |
| 全部 required facts `true` 且 operation 合法 | authorized | （无 blocker） |

**评估顺序（稳定、可测试、primary blocker 确定性）：**

1. context shape / exact keys / types / accessors（单次 descriptor snapshot）→ `execution-policy-context-invalid`
2. operation allowlist → `execution-policy-operation-invalid`
3. 按下列固定顺序扫描 **snapshot** 中的 boolean facts，**收集全部 false facts 对应 blockers**（不是只返回第一个），以保证 table tests 可预测：

```text
lifecyclePlanValid
approvalRecordReady
manifestReady
runnerBindingsReady
executionPreviewVerified
executeRequested
actionCandidatesReady
runnerRegistryReady
hostMutationAdapterReady
rollbackAnchorReady
attemptAuditReady
operatorRecoveryReady
```

4. 若 blockers 非空 → denied；否则 authorized。

**primaryBlocker 确定性：**

- denied：`primaryBlocker === blockers[0]`，且 `blockers` 顺序严格遵循上表固定扫描序（先出现的 false fact 先入列）
- authorized：`primaryBlocker === null`，`blockers === []`，`nextBlockers === []`
- denied：`nextBlockers === [primaryBlocker]`
- 任何 throw / 无法归类分支 → **固定** `execution-policy-context-invalid`（不得透传异常文本）

### 1.5 Blocker vocabulary exact allowlist

Evaluator 输出的 `blockers` / `primaryBlocker` **只能**来自下列冻结集合（不得自创、不得透传外部字符串）：

```js
const EXECUTION_POLICY_BLOCKER_CODES = Object.freeze([
  'execution-policy-context-invalid',
  'execution-policy-operation-invalid',
  'lifecycle-plan-not-ready',
  'approval-record-gate-not-ready',
  'executor-manifest-not-ready',
  'guarded-runner-readiness-not-ready',
  'execution-preview-not-verified',
  'execute-request-missing',
  'action-candidates-not-ready',
  'runner-registry-not-ready',
  'host-mutation-adapter-not-ready',
  'rollback-anchor-not-ready',
  'attempt-audit-not-ready',
  'operator-recovery-not-ready',
]);
```

- `primaryBlocker` = blockers[0] 或 denied 时固定首个；authorized 时 `primaryBlocker: null`
- 任何实现分支若无法归类，必须映射到 `execution-policy-context-invalid`，不得抛出含敏感信息的 raw error 到返回值

### 1.6 Decision 输出 schema 与一致语义

```js
{
  command: 'supervisor-lifecycle-guarded-runner-execution-policy',
  operation: <sanitized allowed operation or 'unknown' on invalid context>,
  state: 'authorized' | 'denied',
  authorized: boolean,
  wouldAuthorizeExecution: boolean,
  wouldRun: false,          // V1.24 恒 false
  wouldWrite: false,        // V1.24 恒 false
  primaryBlocker: string | null,
  blockers: string[],       // allowlist only; authorized 时 []
  nextBlockers: string[],   // denied: [primaryBlocker]; authorized: []
  policyKind: 'fail-closed-execution-policy',
  realImplementationReady: true,
  approvalPolicyDefined: true,
  approvalPolicyEnforced: true,
  allowLifecycleApply: false,
  allowHostMutation: false,
  allowLaunchctl: false,
  allowFilesystemWrite: false,
  allowMetadataWrite: false,
  allowAuditWrite: false,
  allowRollbackAnchorWrite: false,
  allowNasConnection: false,
  allowBackupRestore: false,
  allowRemoteCommand: false,
  sensitiveValuesReturned: false,
  safety: executionPreviewSafety(),
}
```

#### 一致语义（强制不变量）

| 不变量 | 说明 |
| --- | --- |
| `state === 'authorized'` ⇔ `authorized === true` ⇔ `wouldAuthorizeExecution === true` | 三者必须同真同假 |
| `state === 'denied'` ⇔ `authorized === false` ⇔ `wouldAuthorizeExecution === false` | 三者必须同真同假 |
| authorized ⇒ `blockers.length === 0` 且 `primaryBlocker === null` 且 `nextBlockers.length === 0` | 无假 blocker |
| denied ⇒ `blockers.length >= 1` 且 `primaryBlocker === blockers[0]` 且 `nextBlockers[0] === primaryBlocker` | 可预测 |
| V1.24 任意 decision：`wouldRun === false` 且 `wouldWrite === false` 且全部 `allow* === false` | **policy authorize ≠ host execute** |
| 不得返回 path/token/hash/approval identity/reason/command/host/raw error | 敏感 payload 不泄漏 |

**语义定义：**

- `authorized` / `wouldAuthorizeExecution`：在给定 **boolean facts** 下，policy 是否 **授权** 进入后续 runner wiring 执行链。
- `wouldRun` / `wouldWrite` / `allowHostMutation` 等：是否实际或允许产生 host/NAS/remote side effect。V1.24 evaluator **永不**把这些设为 true，即使 authorized。
- 因此 synthetic all-true case 可得到 `authorized:true`，但仍 `wouldRun:false`、`wouldWrite:false`；production gate 因下游 facts false 得到 `authorized:false`，且 top-level `executionEligible:false`。

### 1.7 深拷贝 / 抗 mutation 契约

实现必须保证：

1. **Input mutation 不影响已返回 decision**
   调用 `evaluate...(context)` 得到 `decision` 后，修改 `context` 任意字段，`decision` 的序列化与字段值保持不变。
2. **Output mutation 不影响后续调用**
   修改已返回 `decision`（含 `blockers.push`、改 `state`/`authorized`/`wouldRun` 等）后，对 **新的** 合法 context 再次调用 evaluator，新 decision 仍符合契约，且不包含被污染字段。
3. 测试须 **直接断言** 上述两点（见 plan TDD），而不是只断言“再调一次仍 authorized”。

推荐实现：从 descriptor snapshot 构造本地 plain facts → 评估 → `structuredClone` / JSON round-trip / 手动字段拷贝生成全新 decision 对象；`blockers`/`nextBlockers`/`safety` 均为新数组/新对象。

### 1.8 唯一 authorize 路径

**只有** pure synthetic contract case（unit test 直接调用 evaluator，context 全部 required booleans 为 `true` 且 operation 合法）才返回 authorized。

Production `buildSupervisorLifecycleGuardedRunnerExecutionGate` 构造的 context 中：

```text
runnerRegistryReady: false
hostMutationAdapterReady: false
rollbackAnchorReady: false
attemptAuditReady: false
operatorRecoveryReady: false
```

因此 **当前代码路径必须 deny**。即使上游 plan/approval/manifest/binding/preview/executeRequested/actionCandidatesReady 全 true，policyDecision 仍 denied，blockers 至少包含五个下游 not-ready codes。

---

## 2. Readiness helper：fixed real ready evidence

### 2.1 签名不变

```js
export function buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness()
```

- **无参数**；忽略任何 runtime-looking 多余参数（`length === 0`）
- 不读 config/manifest/binding/preview/approval/env/fs

### 2.2 输出（V1.24）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-execution-policy-readiness',
  state: 'ready',
  executionPolicyDefined: true,
  executionPolicyReady: true,
  realExecutionPolicyReady: true,
  readyCount: 1,
  blockedCount: 0,
  policyEntries: [ /* exactly 1 */ ],
  blockers: [],
  nextBlockers: [],
  safety: executionPreviewSafety(),
}
```

### 2.3 唯一 policy entry

```js
{
  policyKind: 'fail-closed-execution-policy',
  state: 'ready',
  realImplementationReady: true,
  approvalPolicyDefined: true,
  approvalPolicyEnforced: true,
  allowLifecycleApply: false,
  allowHostMutation: false,
  allowLaunchctl: false,
  allowFilesystemWrite: false,
  allowMetadataWrite: false,
  allowAuditWrite: false,
  allowRollbackAnchorWrite: false,
  allowNasConnection: false,
  allowBackupRestore: false,
  allowRemoteCommand: false,
  wouldAuthorizeExecution: false,  // readiness  alone never authorizes a run
  wouldRun: false,
  wouldWrite: false,
  sensitiveValuesReturned: false,
  blockerCode: null,               // ready entry: nullable, 不用假 blocker
  evidenceCode: 'execution-policy-ready',
}
```

**为何 readiness entry 的 `wouldAuthorizeExecution` 仍是 false：**
readiness 只证明 evaluator **已接线且可 fail-closed 评估**；它不携带某次执行的 facts，因此不得声称“将授权执行”。授权只由 evaluator 的 decision 在具体 context 下给出。

**删除 / 停用 V1.23 常量语义：**

- 不再输出 `disabled-execution-policy-stub`
- 不再输出 `execution-policy-real-implementation-missing`
- readiness `blockers` 不得再包含 `real-guarded-runner-execution-wiring-missing`（那是 wiring 级 blocker，不属于 policy readiness）

---

## 3. Wiring contract：execution-policy ready，其余五 blocked

### 3.1 requiredContracts

顺序仍为：

1. `execution-policy` → **ready**
2. `runner-registry` → blocked（不变）
3. `host-mutation-adapter` → blocked（不变）
4. `rollback-anchor` → blocked（不变）
5. `attempt-audit` → blocked（不变）
6. `operator-recovery` → blocked（不变）

### 3.2 Ready contract 的 `blockerCode: null` schema migration（关键决策）

**采用：schema 明确 nullable + 拆 `evidenceCode`，禁止假 blocker。**

#### Schema migration 声明

| 字段 | V1.23 | V1.24 | 消费者义务 |
| --- | --- | --- | --- |
| `requiredContracts[].status` | 全 `blocked` | `execution-policy` 可为 `ready` | 分支处理 `ready`/`blocked` |
| `requiredContracts[].blockerCode` | 恒非空 string | **nullable**：ready 时 **必须** `null`；blocked 时非空 string | **null-safe**：禁止假设恒为 string；`status==='ready'` 时不得把 `null` 当错误 |
| `requiredContracts[].evidenceCode` | 可选/等同 blocker | ready 合同用 **evidenceCode** 表达就绪证据，**不用假 blocker** | 就绪证据读 `evidenceCode`，不读 `blockerCode` |
| UI sentinel `blocker:none` | n/a | **仅 Web 展示层**字面量；JSON 仍为 `null` | 不得把 `none` 写入 JSON `blockerCode` |

```js
// ready
{
  id: 'execution-policy',
  status: 'ready',
  requiredForExecution: true,
  evidence: 'Code-owned fail-closed execution policy evaluator is wired.',
  evidenceCode: 'execution-policy-ready',
  blockerCode: null,
}

// blocked（其余五个保持既有字段；可选同步加 evidenceCode=blockerCode，但不得改名既有 blockerCode）
{
  id: 'runner-registry',
  status: 'blocked',
  requiredForExecution: true,
  evidence: 'No code-owned guarded runner registry is wired.',
  evidenceCode: 'runner-registry-missing', // 可选，等于 blockerCode
  blockerCode: 'runner-registry-missing',
}
```

**规则：**

- `status === 'ready'` ⇒ `blockerCode === null` 且 `evidenceCode` 为非 blocker 证据码（如 `execution-policy-ready`）
- `status === 'blocked'` ⇒ `blockerCode` 为既有 missing code，**不得**用 `'none'` / `'ready'` / 空字符串冒充
- Web 显示 ready 行时，`blocker` 展示字面量 `none` **仅作 UI sentinel**，不是 registered blocker vocabulary 成员；JSON 中仍是 `null`
- 禁止 `blockerCode: 'execution-policy-missing'` 与 `status:'ready'` 并存
- 禁止 ready 时继续使用 `execution-policy-missing` 或任何假 blocker 字符串

#### 全消费者 null-safe 覆盖要求

下列消费者 **都必须**有显式测试断言 `blockerCode === null`（或 null-safe 映射）且 ready 证据来自 `evidenceCode`：

| 层 | 覆盖点 |
| --- | --- |
| pure unit | wiring contract `requiredContracts[0].blockerCode === null` 且 `evidenceCode === 'execution-policy-ready'`；policy entry 同理 |
| API | success body 同上；恶意 body 不能把 ready 合同改回假 blocker |
| CLI | JSON report 同上 |
| Web | ready 行渲染 `blocker:none`（sentinel）；**不**把 payload 中非 null 假 blocker 当 truth；null-safe 分支不 throw |

### 3.3 Wiring aggregate

```js
{
  command: 'supervisor-lifecycle-guarded-runner-wiring-contract',
  state: 'blocked',                 // overall still blocked
  realRunnerWiringReady: false,
  readyCount: 1,
  blockedCount: 5,
  requiredContracts: [ /* 6 */ ],
  executionPolicyReadiness: buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(),
  // ... 其余五个 readiness helpers 仍 blocked ...
  blockers: ['real-guarded-runner-execution-wiring-missing'],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  safety: executionPreviewSafety(),
}
```

`buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview)` 仍 **忽略** `executionPreview` 内容（与 V1.17+ 一致）。

---

## 4. Execution gate 集成

### 4.1 构造 policy context（仅 production-derived local primitives）

在 `buildSupervisorLifecycleGuardedRunnerExecutionGate(...)` 内，于已有 gate fact 计算之后：

```js
const actionCandidates = buildGuardedRunnerExecutionGateActionCandidates(plan, executionPreview);
// 公开 pure helper（§1.3.1）；≠ authorize / wouldRun；仅 boolean，无 metadata
const actionCandidatesReady = areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
  actionCandidates,
  operation,
);

const executionPolicyReadiness = runnerWiringContract.executionPolicyReadiness;
const executionPolicyReady =
  executionPolicyReadiness?.executionPolicyReady === true &&
  executionPolicyReadiness?.realExecutionPolicyReady === true &&
  executionPolicyReadiness?.state === 'ready';

// 逐字段字面量构造：仅本地 primitive；不传入 request/options 对象
const policyContext = {
  operation: ALLOWED_OPERATIONS.has(operation) ? operation : 'invalid',
  lifecyclePlanValid: lifecyclePlanValid === true,
  approvalRecordReady: approvalRecordReady === true,
  manifestReady: manifestReady === true,
  runnerBindingsReady: runnerBindingsReady === true,
  executionPreviewVerified: executionPreviewVerified === true,
  executeRequested: executeRequested === true,
  actionCandidatesReady: actionCandidatesReady === true,
  runnerRegistryReady: false, // V1.24 from readiness / gates
  hostMutationAdapterReady: false,
  rollbackAnchorReady: false,
  attemptAuditReady: false,
  operatorRecoveryReady: false,
};

const policyDecision = sanitizePolicyDecision(
  evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(policyContext),
);
```

**硬性约束：**

- 不得从 `options`、request body、CLI args 读取 `policyContext` / `policyDecision` / 任意 policy override
- 不得把 approval identity、path、hash、command、raw error 放进 context
- 不得把 request 对象、options 对象或任何外部引用直接传给 evaluator
- `options` 仅允许既有 `executeRequested` boolean（读取后立即归一化为本地 primitive）

### 4.2 Gate 输出变更

新增 / 变更字段：

```js
{
  // ...existing...
  policyDecision, // sanitized evaluator output
  gates: {
    lifecyclePlanValid,
    approvalRecordReady,
    manifestReady,
    runnerBindingsReady,
    executionPreviewVerified,
    executeRequested,
    actionCandidatesReady,   // 结构 ready（含 sensitive-field-free）≠ wouldRun / executionEligible
    executionPolicyReady: true,  // V1.24 fixed from readiness
    runnerRegistryReady: false,
    realRunnerWiringReady: false,
    runnerWiringContractReady: false,
    hostMutationAdapterReady: false,
    rollbackAnchorReady: false,
    attemptAuditReady: false,
    operatorRecoveryReady: false,
  },
  executionEligible: false, // 仍恒 false until 全部 wiring ready 且 decision authorized（本版未达）
  wouldExecute: false,
  // ...
}
```

**executionEligible 规则（V1.24 仍恒 false，但语义写死防回归）：**

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
  realRunnerWiringReady &&
  runnerWiringContractReady
```

因后五个 wiring facts 与 `realRunnerWiringReady` / `runnerWiringContractReady` 在 V1.24 为 false，`executionEligible` 必为 false。实现可继续 hardcode `false`，但测试必须覆盖“即便 policyDecision 在 synthetic 上 authorized，gate production 路径仍 false”以及“`actionCandidatesReady:true` 但五个下游 false → 仍 deny 且 executionEligible false”。

### 4.3 policyDecision sanitize

`sanitizePolicyDecision(decision)`：

- 只保留 allowlisted keys
- `blockers` / `primaryBlocker` / `nextBlockers` 过滤到 `EXECUTION_POLICY_BLOCKER_CODES`
- 强制 `wouldRun/wouldWrite/allow*:false`、`sensitiveValuesReturned:false`
- 强制 state/authorized/wouldAuthorizeExecution 一致性（若漂移则 collapse 为 denied + `execution-policy-context-invalid`）
- 返回新对象（深拷贝）

---

## 5. API / CLI / Web

### 5.1 透传边界

| 通道 | 行为 |
| --- | --- |
| API `POST /api/supervisor-lifecycle-guarded-runner-execution-gate` | 仍只接受既有 inline operation/config/manifest/runnerBinding/executeRequested；响应透传 gate JSON（含 readiness + policyDecision） |
| CLI `supervisor-lifecycle-guarded-runner-execution-gate` | 仍既有 flags；JSON 透传；`--fail-on-blocked` 仍 exit 2 |
| Web gate button | 不新增按钮/字段；view model 渲染 allowlisted lines |

**禁止：** request body / CLI 传入 `policyContext`、`policyDecision`、`executionPolicyReady` override、`authorized:true` 强制等。即使传入也必须被忽略（API 已只解构 allowlisted body 字段则天然忽略；测试必须覆盖）。

### 5.2 Web 显示

#### ViewModel 装配契约（P2；必须写进实现与测试）

`buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(payload, errorMessage)` **必须**：

1. 调用 `buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload)`（或同名稳定 helper）
2. 将该 helper **返回的行数组**展开装配进 view model 的 **`requiredFields`**（当前 execution gate VM 的等价展示字段；与既有 wiring/policy/registry 行同一数组）
3. 正常 path 同时更新 `validationLines`（含 `executionPolicyReady:true` 条件渲染与硬编码 `executionEligible:false` 等）
4. **error / unknown** path 继续 fail-closed：`requiredFields: []`（或不含信任型 authorized 行）；`validationLines` 保持 `executionPolicyReady:false` 等既有 fail-closed 行；**不得**从 errorMessage / 空 payload 渲染 `policyDecision:state:authorized` 或 `executionEligible:true`

示意（正常 path）：

```js
const policyDecisionLines = buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload);
// ...
return {
  // ...
  requiredFields: [
    ...actionLines,
    ...wiringContractLines,
    ...executionPolicyLines,
    ...policyDecisionLines, // 必须装配；不得只定义 helper 而不接入 VM
    ...runnerRegistryLines,
    // ...hostMutation / rollback / attemptAudit / operatorRecovery lines
  ],
  validationLines: [
    // ...
    `executionPolicyReady:${gates.executionPolicyReady === true ? 'true' : 'false'}`,
    'executionEligible:false',
    // ...
  ],
};
```

测试必须同时覆盖：

- **VM 断言**：`viewModel.requiredFields` 含 policy decision denied 行与 ready policy/wiring 行
- **DOM 断言**（若 panel 渲染 `requiredFields`）：渲染文本同样含上述行；恶意 payload 不出现 opaque 材料或 authorized 行
- **error / unknown**：`requiredFields` 无 authorized 泄漏；`validationLines` fail-closed

#### Policy readiness line（固定 allowlisted，忽略恶意 payload 内容）

```text
executionPolicy:fail-closed-execution-policy:state:ready:realImplementationReady:true:wouldAuthorizeExecution:false:blocker:none
```

#### Wiring contract lines

- ready：

```text
wiringContract:execution-policy:status:ready:requiredForExecution:true:blocker:none
```

- blocked（其余五个不变）：

```text
wiringContract:runner-registry:status:blocked:requiredForExecution:true:blocker:runner-registry-missing
```

实现：`status` 仅允许 `ready|blocked`；`blockerCode === null` → 显示 `none`；未知 status collapse 为 `blocked` + sanitized blocker。读取 `blockerCode` 时必须 null-safe（`=== null` 与 missing 分支分离）。

#### Policy decision line — V1.24 production path 强制 denied（版本安全边界）

```text
policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false:primaryBlocker:<allowlisted-or-unknown>
```

由 `buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload)` 生成，并 **装配进** `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel` 的 `requiredFields`。

**V1.24 安全边界（明确）：**

- Web gate view model 对 `policyDecision` **强制渲染 denied/false**，与 production API 行为一致，并抵抗恶意 client-side JSON。
- **不得**从 payload 直接信任 `authorized` / `state:'authorized'` / `wouldAuthorizeExecution` / `wouldRun`。
- 本强制 denied 是 **当前版本（V1.24）** 的安全边界，**不是**永久产品语义。
- **未来真正 authorized UI** 必须通过 **独立后续版本** 显式解除该强制，并配套：服务端可信 evidence、allowlisted 一致性校验、以及不会从恶意 payload 直接信任授权字段的新契约。V1.24 **不**实现该解除。

#### validationLines

正常 payload：

- `executionPolicyReady:true`（来自 `gates.executionPolicyReady === true`）
- 仍固定 `executionEligible:false`、`wouldExecute` 不出现为 true、`runnerRegistryReady:false` 等

error / unknown：继续 fail-closed，可显示 `executionPolicyReady:false` 或 unknown 态不下放 true（与现有 error/unknown 模式一致：未知时不假装 ready）；**不得**在 error/unknown 的 `requiredFields` 中装配信任型 authorized policyDecision 行。

---

## 6. 版本 / README / Gold

- `LINKE_RELEASE_VERSION = 'V1.24'`
- README 标题、badge、version table：V1.24 当前，V1.23 历史
- Gold scorecard：
  - 更新 evidence：`evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy`、`executionPolicyReadiness.state:ready`、`executionPolicyReady:true`、`execution-policy` ready contract、`policyDecision` denied on production path
  - **移除**作为当前缺口的 `execution-policy-real-implementation-missing` / disabled stub 表述（可保留历史叙述若需要，但 evidence 列表应反映 V1.24 ready policy）
  - 继续强调五个下游 missing + `executionEligible:false` + Gold `blocked`
- **禁止**把任何 capability 标为 Gold ready / overall ready
- **G0a 真实双机 PASS** 段落、报告引用与措辞保持不变

---

## 7. 安全与非目标

### 安全边界

- evaluator / readiness / wiring / gate / API / CLI / Web 均无 host mutation
- **文档与测试 fixture 禁止**嵌入：用户名形态绝对路径、SSH 私钥路径形态、具体 IP/CIDR、真实邮箱、真实 command 名、credential 形态、64-hex digest
- 恶意 / 抗泄漏 fixture **仅**使用无路径、无网络结构的 opaque synthetic strings（例如 `UNSAFE_SECRET_MATERIAL`、`OPAQUE_UNSAFE_FIELD`）；不得出现实际 host/email/hash/command/credential 形态字面量
- 文档内敏感扫描类别仅限抽象类别（absolute-user-path / ipv4-or-cidr / private-key-pem / credential-assignment / long-hex-digest / email-shape 等），用 Node/regex 策略实现；**扫描输出只报告命中类别计数，不回显匹配行**
- **authentication-directory**（含 SSH 认证目录形态）由 PM **文档外**扫描器检查；文档内扫描 **不包含**该 category，且 **不得**在文档中重现、编码或重建其具体 pattern
- 输出深拷贝，防止 caller mutation 污染缓存常量

### 非目标

- 不实现 runner registry / host mutation adapter / rollback anchor / attempt audit / operator recovery
- 不把 `executionEligible` 或 Gold 变 ready
- 不新增 endpoint / CLI command / Web button / request field
- 不执行 install/uninstall/rollback/recover
- 不修改 auth / write-route 语义
- 不让 authorized policy decision 触发任何 runner dispatch
- 不声称可证明拒绝所有 `Proxy`
- 不在 V1.24 Web 显示真正 authorized decision（强制 denied 为版本边界）

---

## 8. 运行韧性设计门

**正常态：** production gate 显示 `executionPolicyReady:true`、`policyDecision` denied、`executionEligible:false`；wiring `readyCount:1` `blockedCount:5`；Gold blocked。

**恢复锚点：** `2b53f4d`。

**三支柱：**

1. **有界失效：** 畸形 context / 恶意 payload → denied 或固定 ready evidence line / 强制 denied decision line，不抛敏感 raw error 到 API body。
2. **异常恢复：** 若发现 request 可把 `executionEligible` 或 `wouldExecute` 变 true，立即回退到硬编码 false 与 evaluator-only authorize path。
3. **状态侦测：** pure / API / CLI / Web / version / README / Gold 全覆盖；`npm test` 为最终信号。

---

## 9. 完成标准

V1.24 证明：

1. code-owned fail-closed evaluator 存在且纯函数
2. synthetic all-true context 可 authorize，且 `wouldRun/wouldWrite` 仍 false
3. 任一 fact false 或输入 fail-closed 场景均 deny
4. readiness 与 required contract `execution-policy` 为 ready；`blockerCode:null` + `evidenceCode`；全消费者 null-safe
5. **公开 pure** `areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, operation)` 已导出，带公共 JSDoc；仅 boolean、无 metadata；**≠ authorize/wouldRun**；A1–A7 pure unit tests 用 synthetic malformed 数组直接可达
6. production gate 路径始终 deny，`executionEligible:false`；`gates.actionCandidatesReady` 由上述 helper 写入；gate 集成只验证 empty/valid candidates + 五下游 deny，**不**虚构未定义 getInputs helpers
7. API/CLI/Web 不新增 surface，恶意 payload 不能把 decision/execution 变 true
8. Web：`buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel` **调用** `buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines` 并把返回行装配进 **`requiredFields`**；VM/DOM 断言覆盖；error/unknown 仍 fail-closed
9. Web 强制 denied 为 V1.24 版本边界；未来 authorized UI 需独立版本解除
10. 版本升级到 V1.24，Gold 仍 blocked，G0a PASS 声明不变
11. 文档/fixture 无用户名路径、SSH 路径形态、具体 IP/CIDR、credential 形态；敏感扫描只报类别计数（全部敏感类别 0 命中）

真实 runner wiring 与 Gold 发布能力仍缺失。

---

## 10. 关键决策摘要

1. **Blocker vocabulary：** 封闭 allowlist；未知一律 `execution-policy-context-invalid`。
2. **Ready contract 字段：** `blockerCode: null` + `evidenceCode: 'execution-policy-ready'`；UI `blocker:none` 仅为 sentinel；全消费者 null-safe。
3. **state / authorized / wouldAuthorizeExecution：** 三者恒等；与 `wouldRun/wouldWrite` 严格分离。
4. **Readiness `wouldAuthorizeExecution:false`：** readiness 不代表某次授权。
5. **Proxy：** JS 无法可靠识别全部 Proxy；evaluator best-effort；生产 context 仅 gate 内本地 primitive 构造 + 副作用恒 false 三层防御。
6. **单次 descriptor snapshot：** 禁止 check-then-read；trap throw → 固定 invalid。
7. **`areSupervisorLifecycleGuardedRunnerActionCandidatesReady`：** 公开 pure boolean helper（公共 JSDoc）；exact schema / nonempty / unique actionId / operation expected-set 完全匹配 / sensitive-field-free；trap/getter/invalid → false；不返回 metadata；**≠ authorize/wouldRun/executionEligible**。A1–A7 pure 直测；gate 集成仅 empty/valid + 五下游 deny。
8. **Web policyDecision 强制 denied：** V1.24 版本安全边界；`ExecutionGateViewModel` 必须调用 `PolicyDecisionLines` 并装配进 `requiredFields`；error/unknown fail-closed；未来真正 authorized UI 需独立版本解除，不从恶意 payload 直接信任。
9. **敏感材料：** opaque synthetic strings only；扫描只报类别计数（0 命中）。
10. **恢复锚点 `2b53f4d`。**
