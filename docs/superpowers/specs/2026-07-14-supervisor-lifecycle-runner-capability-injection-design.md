# V1.31 Supervisor Lifecycle Runner Capability Injection + Dry-Run/Execute Boundary Design

## 目标

V1.31 在 **V1.30 pure real-wiring orchestrator / plan / seal proof** 与 **V1.29 6/0 pure required contracts** 的基线上，交付从 pure proof 进入真实 runner 的**必要前置**：

> **code-owned capability injection interface + dry-run / execute authorization boundary**

本版建立：

1. **可测试**的 capability interface exact schema（由现有 10 lifecycle actions 证据派生最小集合）
2. **不可 caller 伪造**的 code-owned factory / registry（禁止 options 注入任意 function / command / shell string）
3. **可审计**的 capability result / receipt（命名与 V1.30 `wiringPlanSeal` plan-only seal **严格区分**）
4. **默认 dry-run**、**execute 单闸 immediate hard-deny**（V1.31 **无 real handler**；不得进入真实 host 副作用；双闸属 V1.32+）

### 关键边界（必须先读）

| 层级 | V1.31 是否完成 | 含义 |
| --- | --- | --- |
| **capability injection interface / dry-run registry / mode boundary** | **是** | code-owned schema + 内部 dry-run 注册 + authorize/invoke 边界可证明 |
| **non-side-effect dry-run invoke + dry-run receipt** | **是** | 仅 `implementationClass:'dry-run-non-side-effect'`；`hostSideEffectOccurred:false` |
| **real host capability implementations** | **否** | 不注册 real handlers；不 launchctl / fs write / process / network / audit persist / notify |
| **execute mode authorization** | **否** | V1.31 **单闸 immediate hard-deny**；公式文档化；无 real handler；**非**双闸 |
| **`realRunnerWiringReady` / `runnerWiringContractReady`** | **否** | **禁止**因本版变 true |
| **`executionEligible` / `wouldExecute`** | **否** | 公式仍要求 real wiring + 全部上游；本版恒 false |
| **任一 `real*ImplementationReady` / side-effect would\* / \*Allowed** | **否** | V1.25–V1.30 遗留 **全部保持 false** |
| **消解 `real-guarded-runner-execution-wiring-missing`** | **否** | gate / wiring `nextBlockers` **仍含**该码 |
| **Gold 发布** | **否** | scorecard 继续 `blocked` |

**严禁**把 capability injection ready、dry-run registry ready、dry-run receipt `completed`、`wiringPlanSeal.state:'seal-ready'`、或 policy `authorized` 冒充：

- `realRunnerWiringReady:true`
- `runnerWiringContractReady:true`
- `executionEligible:true`
- execute mode authorized
- 真实 host runner dispatch / launchctl / fs / audit persist
- Gold ready

**恢复锚点：** `7ac8d6c`（`feat: add V1.30 real runner wiring proof`）。实现越界时回到该 commit 的干净状态再重做（见 §10；**禁止**在 plan/docs 中建议 `git reset --hard` 作为常规步骤）。

---

## 0. 源码事实基线（7ac8d6c / V1.30，不得猜）

以下全部来自当前 `src/supervisor-lifecycle.js` / `src/web/app.js` / `src/gold-readiness.js` / `README.md` / 相关 tests。

### 0.1 V1.30 已完成与仍 blocked

| 项 | 7ac8d6c 事实 |
| --- | --- |
| six pure required contracts | `readyCount:6` / `blockedCount:0` |
| wiring aggregate `state` | **`'blocked'`** + `real-guarded-runner-execution-wiring-missing` |
| `pureWiringOrchestratorPlanReady`（gate ready path） | **true**（pure plan fact only） |
| `wiringPlan.state` / `mode` | `'planned'` / **`'plan-only'`** |
| `wiringPlanSeal.state` | **`'seal-ready'`**（plan-only seal；**NOT** execution receipt / **NOT** persisted audit） |
| `realRunnerWiringReady` / `runnerWiringContractReady` | **false** |
| `executionEligible` / `wouldExecute` | **false** |
| 全部 `real*ImplementationReady` + side-effect would\* / \*Allowed | **false** |
| policy ready path | **authorized** / `primaryBlocker:null` |
| Web | 方案 A：`policyDecision` authorized + `executionSentinel` 恒 blocked + wiringPlan/wiringPlanSeal 行 |
| Gold | **blocked**；`automation-installation` **partial** |
| V1.30 预留模式枚举 | `plan-only → dry-run-injected → execute-injected`（仅 `plan-only` 启用） |
| V1.30 预留下一步 | capability injection interfaces + dry-run/execute 边界 |

### 0.2 `executionEligible` 公式（权威；V1.31 仍 hardcode false 实现）

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
  realRunnerWiringReady &&          // ← 不在 POLICY_FACT_KEYS；V1.31 仍 false
  runnerWiringContractReady         // ← 不在 POLICY_FACT_KEYS；V1.31 仍 false
```

**结论：** capability injection / dry-run ready **不得**单独抬升 `executionEligible`。即便 dry-run invoke 成功、receipt `completed`，只要 `realRunnerWiringReady` 或 `runnerWiringContractReady` 为 false，gate 顶层 **必须** `executionEligible:false`。

### 0.3 现有 10 actions 证据（capability 最小集合派生源）

来源：`buildLifecycleActions` + `CODE_OWNED_ACTION_*_MAP`（registry / mutation / anchor / audit / recovery 五表同键）。

| # | actionId | 出现于 operation | mutationKind（既有） | 主 capabilityKind（V1.31 派生） | 副作用类（证据） |
| --- | --- | --- | --- | --- | --- |
| 1 | `render-launch-agent-plist` | install | `render-plist-mutation` | **`render`** | none（预览渲染；非 host write） |
| 2 | `write-launch-agent-plist` | install | `write-plist-mutation` | **`write`** | host-mutating（fs write） |
| 3 | `load-launch-agent` | install | `load-agent-mutation` | **`reload`** | host-mutating（launchctl load） |
| 4 | `unload-launch-agent` | uninstall | `unload-agent-mutation` | **`reload`** | host-mutating（launchctl unload） |
| 5 | `remove-launch-agent-plist` | uninstall | `remove-plist-mutation` | **`write`** | host-mutating（fs remove） |
| 6 | `remove-supervisor-metadata` | uninstall | `remove-metadata-mutation` | **`write`** | host-mutating（metadata） |
| 7 | `capture-current-state` | rollback | `capture-state-mutation` | **`status`** | observational（state capture / process-fs read 语义） |
| 8 | `restore-previous-plist` | rollback | `restore-plist-mutation` | **`rollback`** | host-mutating（restore write） |
| 9 | `restart-previous-supervisor` | rollback | `restart-supervisor-mutation` | **`reload`** | host-mutating（launchctl restart） |
| 10 | `start-recovery-supervisor` | recover | `recovery-supervisor-mutation` | **`reload`** | host-mutating（launchctl start recovery） |

**横切（每个 action 均有 code-owned 映射行）：**

| 横切 | 证据 map | capabilityKind | V1.31 dry-run 语义 |
| --- | --- | --- | --- |
| attempt audit | `CODE_OWNED_ACTION_AUDIT_MAP` | **`audit`** | 仅规划/模拟 audit 序；**不** persist / **不** write log |
| operator recovery notify | recovery `wouldNotifyOperator` locus | **`notify`** | 仅模拟通知计划；**不**发外部通知 |

### 0.4 最小 capability 集合（exact allowlist）

```text
CAPABILITY_KIND_ALLOWLIST =
  render | write | reload | status | rollback | audit | notify
```

**禁止**本版扩张到：`shell`、`exec`、`network`、`nas`、`backup`、`restore-volume`、任意自由字符串 kind。
**禁止**把 `wiringPlanSeal` / plan step ref 当作 capability kind。

### 0.5 actionId → primaryCapabilityKind（exact code-owned map）

```js
const CODE_OWNED_ACTION_PRIMARY_CAPABILITY_MAP = Object.freeze({
  'render-launch-agent-plist': 'render',
  'write-launch-agent-plist': 'write',
  'load-launch-agent': 'reload',
  'unload-launch-agent': 'reload',
  'remove-launch-agent-plist': 'write',
  'remove-supervisor-metadata': 'write',
  'capture-current-state': 'status',
  'restore-previous-plist': 'rollback',
  'restart-previous-supervisor': 'reload',
  'start-recovery-supervisor': 'reload',
});
```

每个 action 在 dry-run 规划中还绑定横切 capability 序（见 §3.4）：

```text
primary → (rollback-anchor plan check) → invoke-primary → audit → (notify plan if recovery-class)
```

V1.31 **不**执行真实 anchor write；仅在 receipt 的 `auditSequence` 中记录 **planned** 顺序证据。

### 0.6 为何 V1.31 不是“又一个 pure mapping stub”

| 候选 | 诚实性 | 价值 | 判定 |
| --- | --- | --- | --- |
| A. 第 7 个 requiredContract pure map | 与 6/0 重复形态 | 低（不解锁 invoke 边界） | **拒绝** |
| B. 直接 real host handlers + execute | 越界（用户禁止未经证明的 host 副作用） | 过大 | **拒绝（本阶段）** |
| C. capability interface + dry-run-only registry + execute **单闸** hard-deny + receipt | **诚实**；直接成为 real impl 的挂载面 | **高** | **采纳** |
| D. 仅文档、无 API/schema | 不可测 | 空转 | **拒绝** |

**V1.31 答案：**

> 本版交付 **可 invoke 的 dry-run 边界合同**（仍无 host 副作用），**不是**继续无价值 pure 层。
> 它 **直接解锁** 下一版：在**同一 interface** 下以 trusted bootstrap 注册 real implementations，并沿用本版写死的 execute 多重事实公式做抬升。
> 本版 **仍不能**诚实置 `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible`。

---

## 1. 设计选择总览

| 组件 | V1.30 | V1.31 |
| --- | --- | --- |
| wiring orchestrator plan/seal | planned / seal-ready / mode plan-only | **保持**；不改 plan seal 语义 |
| capability injection | 仅文档预留 | **落地** code-owned interface + factory/registry |
| capability mode | 预留 `dry-run-injected` / `execute-injected` | **启用 dry-run**；**execute 单闸 hard-deny**（无 real handler） |
| public 返回物 | plain plan/seal | plain decision + **capability receipt**（≠ seal） |
| handlers 可见性 | n/a | **模块私有**；永不进入 gate JSON / options |
| `realRunnerWiringReady` 等 | false | **false** |
| `executionEligible` | false | **false** |
| wiring-missing | 仍在 | **仍在** |
| Gold | blocked | **blocked** |
| agent.js / server.js / package.json | 未改 | **禁止改** |
| 新 endpoint / CLI / Web button / request field | 无 | **无**（除非 rg 证明不可避免；默认不实施） |

### 字段命名（禁止混淆）

| 名称 | 类型 | V1.31 语义 |
| --- | --- | --- |
| `pureCapabilityInjectionReady`（readiness 级） | **固定** builder | pure capability contract 就绪；**不是** policy fact；**不是** real wiring |
| `gates.capabilityInjectionReady` | **动态** | readiness ∧ decision resolved ∧ dry-run registry ready ∧ executeReady false ∧ 全 real/side-effect false |
| `gates.dryRunCapabilityRegistryReady` | **动态** | 仅 dry-run-non-side-effect 全集注册可核验 |
| `capabilityInjectionDecision` | decision | resolved / unresolved；**不含** function |
| `capabilityReceipt` / `receiptKind` | **capability receipt** | dry-run / denied /（未来）execute；**NOT** `wiringPlanSeal` |
| `wiringPlanSeal` | plan-only seal | **保持 V1.30**；禁止改名/混用为 capability receipt |
| `realCapabilityImplementationsReady` | real locus | **恒 false**（无 real handlers） |
| `executeCapabilityAuthorized` | mode | **恒 false**（单闸 hard-deny；无 real handler） |
| `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` | gate / wiring | **恒 false** |
| Web `executionSentinel` | UI | **恒 blocked** |

**禁止**别名：`realWiringReady`、`wiringReady`、`runnerReady`、`executionReceipt`（用于 plan seal）、`capabilitySeal`（易与 plan seal 混淆）。
**禁止**把 dry-run receipt 命名为 `wiringPlanSeal` / `executionReceipt` / `persistedAudit`。

---

## 2. Capability interface exact schema

### 2.1 CapabilityKind（exact）

```ts
type CapabilityKind =
  | 'render'
  | 'write'
  | 'reload'
  | 'status'
  | 'rollback'
  | 'audit'
  | 'notify';
```

### 2.2 CapabilityDescriptor（registry 对外只暴露 plain descriptor）

**exact keys only**（多 key / getter / Proxy → fail-closed）：

```js
{
  capabilityKind: '<CapabilityKind>',
  capabilityId: '<code-owned-id>',          // e.g. 'dry-run-render'
  implementationClass: 'dry-run-non-side-effect', // V1.31 唯一允许注册类
  sideEffectClass: 'none',                  // V1.31 dry-run 全集 none
  supportsModes: ['dry-run'],               // 不得含 'execute'（V1.31）
  actionIds: ['<allowlisted actionId>', ...], // 该 capability 覆盖的 actions
  realImplementationReady: false,           // 恒 false（descriptor 级）
  wouldMutateHost: false,
  wouldPersistAudit: false,
  wouldNotifyExternal: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  networkAllowed: false,
  metadataWriteAllowed: false,
  auditWriteAllowed: false,
  rollbackAnchorWriteAllowed: false,
  evidenceCode: 'capability-dry-run-descriptor-ready',
  blockerCode: null,
}
```

**禁止** descriptor 含：`handler`、`fn`、`command`、`argv`、`shell`、`path`、`env`、`token`、function、Promise。

### 2.3 CapabilityInvokeRequest（exact keys）

```js
{
  capabilityKind,     // required, allowlisted
  actionId,           // required, allowlisted + map-consistent
  operation,          // required, ∈ {install,uninstall,rollback,recover}
  mode,               // required: 'dry-run' | 'execute'
  idempotencyKey,     // execute 必填；dry-run 可为 null
  // 可选结构化 plain 字段（V1.31 dry-run 可忽略内容，只校验类型）:
  attemptRef,         // string | null — opaque id only
  anchorRef,          // string | null — evidence ref only（非 path）
}
```

**禁止** request 含：

- `handler` / `fn` / `implementation` / `command` / `argv` / `shell` / `cwd`
- `path` / `plistPath` / `host` / `url` / `token` / `Authorization`
- 任意 function / class instance / Buffer
- caller 自带 `capabilityReceipt` / `real*Ready` override

### 2.4 CapabilityReceipt（exact；与 V1.30 seal 命名隔离）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-capability-receipt',
  receiptKind: 'capability-dry-run-receipt'
    | 'capability-execute-denied-receipt'
    | 'capability-execute-receipt', // 仅未来；V1.31 不得产出 completed execute receipt
  // state 可达性见 §2.4.1（V1.31 生产可达仅 completed|denied|error）
  state: 'completed' | 'denied' | 'error' | 'partial' | 'timeout' | 'rolled-back',
  mode: 'dry-run' | 'execute',
  capabilityKind: '<CapabilityKind>',
  capabilityId: '<code-owned-id-or-null>',
  actionId: '<allowlisted-or-unknown>',
  operation: '<allowlisted-or-unknown>',
  // V1.31 生产路径固定 null；永不回显原 key；不用含糊 sentinel 字符串
  idempotencyKeyFingerprint: null,
  outcomeCode: '<allowlisted>',
  errorClass: null
    | 'authorization'
    | 'validation'
    | 'timeout'
    | 'partial-failure'
    | 'rollback-failure'
    | 'internal',
  partial: false,
  timedOut: false,
  rolledBack: false,
  hostSideEffectOccurred: false,   // V1.31 任意路径恒 false
  wouldMutateHost: false,
  wouldPersistAudit: false,
  wouldNotifyExternal: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  networkAllowed: false,
  auditSequence: [ /* ordered allowlisted step ids */ ],
  redaction: {
    secretsRedacted: true,
    pathsRedacted: true,
    hostsRedacted: true,
  },
  realCapabilityImplementationsReady: false,
  realRunnerWiringReady: false,
  runnerWiringContractReady: false,
  executionEligible: false,
  executeCapabilityAuthorized: false,
  evidenceCode: '<string-or-null>',
  primaryBlocker: null | '<allowlisted>',
  blockers: [ /* allowlisted */ ],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  safety: executionPreviewSafety(),
}
```

#### 2.4.1 receipt `state` 可达性（exact）

| state | V1.31 生产公共 API | 说明 |
| --- | --- | --- |
| `completed` | **可达** | dry-run 成功路径 |
| `denied` | **可达** | execute hard-deny / 授权拒绝 / caller injection 拒绝 |
| `error` | **可达** | validation / internal 等 fail-closed 错误路径 |
| `partial` | **不可达（生产）** | **仅** test harness 可模拟；不表示真实 half-applied host |
| `timeout` | **不可达（生产）** | **仅** test harness 可模拟；不启动真实 host timer |
| `rolled-back` | **不可达** | **V1.32+ 预留**；V1.31 生产与 harness 均不得产出 |

**V1.31 `idempotencyKeyFingerprint`：** 生产与公共 API **固定 `null`**。
- **禁止**写入 `'redacted-idempotency-fingerprint'` 或其它含糊 sentinel 字符串冒充已计算指纹。
- **禁止**回显 raw `idempotencyKey`。
- 真实指纹化（若需要）属 V1.32+ idempotency store 证据 locus 的 schema owner 范围（见 §4.5）。

#### receiptKind 与 V1.30 seal 对照（强制）

| 对象 | command | 含义 | 是否 side-effect evidence |
| --- | --- | --- | --- |
| `wiringPlanSeal` | `...-real-wiring-plan-seal` | plan-only seal | **否** |
| `capabilityReceipt` (`capability-dry-run-receipt`) | `...-capability-receipt` | dry-run 调用回执 | **否**（模拟） |
| `capabilityReceipt` (`capability-execute-denied-receipt`) | 同上 | execute 被拒回执 | **否** |
| 未来 `capability-execute-receipt` | 同上 | 真实执行回执 | **是**（需 real 证据） |

**禁止**复用 `sealReady` / `wiringPlanSeal` 字段名表示 capability 结果。
**禁止** dry-run receipt 使用 `receiptKind:'capability-execute-receipt'`。

### 2.5 outcomeCode / blocker allowlist（exact）

```text
# outcomeCode
capability-dry-run-completed
capability-dry-run-validation-failed
capability-execute-hard-denied
capability-execute-prerequisites-incomplete
capability-mode-invalid
capability-kind-unknown
capability-action-unmapped
capability-caller-injection-rejected
capability-timeout-simulated
capability-partial-failure-simulated
capability-rollback-planned-only

# primaryBlocker / blockers（capability 层；不含 policy vocabulary 污染）
capability-injection-input-invalid
capability-kind-unknown
capability-action-unmapped
capability-action-duplicate
capability-operation-invalid
capability-mode-invalid
capability-registry-incomplete
capability-handler-class-invalid
capability-caller-injection-rejected
capability-execute-hard-denied
capability-execute-prerequisites-incomplete
capability-idempotency-key-missing
capability-idempotency-key-invalid
capability-timeout
capability-partial-failure
capability-rollback-failed
capability-audit-sequence-invalid
capability-redaction-failed
```

**禁止**把 `real-guarded-runner-execution-wiring-missing` 用作 capability **primary**（该码保留为 gate/wiring execution 信号）。
capability receipt 的 `nextBlockers` **始终**仍指向 `real-guarded-runner-execution-wiring-missing`（诚实：dry-run 完成后下一缺口仍是 real wiring）。

### 2.6 错误分类 / 超时 / partial / rollback / audit 顺序 / 脱敏

| 主题 | V1.31 规则 |
| --- | --- |
| **errorClass** | 仅 allowlisted；validation/authorization 优先于 internal |
| **timeout** | **生产公共 API 不可达** `state:'timeout'`。**仅** test harness 可模拟 `timedOut:true` + `errorClass:'timeout'`；**不**启动真实 timer 触达 host |
| **partial failure** | **生产公共 API 不可达** `state:'partial'`。**仅** test harness 可模拟 `partial:true`；**不**表示真实 half-applied host 状态 |
| **rollback** | dry-run 仅 `outcomeCode:'capability-rollback-planned-only'` 且 `rolledBack:false`；**不** restore host。`state:'rolled-back'` **V1.32+ 预留**，V1.31 不得产出 |
| **auditSequence 顺序（fixed）** | `authorize` → `mode-check` → `registry-lookup` → `anchor-plan` → `invoke` → `receipt` → `audit-plan` → `notify-plan` |
| **秘密/路径脱敏** | 输出永不含 token/Authorization/path/hostname/username/pid/raw idempotency key；仅 category hit counts；`idempotencyKeyFingerprint` V1.31 **固定 null**（不用含糊 sentinel） |
| **失败注入** | 测试可走 code-owned **simulated** 分支——仅通过 **test-only internal harness** 或 allowlisted `outcomeCode` fixture builder；生产 API **无** failure-inject request field |

### 2.7 Prototype / pollution 防护与公开返回物深拷贝（exact）

所有公共 API 的 **入参提取** 与 **出参返回** 必须满足下列 **exact** 规则（实现与测试均按此断言）。

#### 2.7.1 入参：exact whitelist extraction（禁止 assign/spread/JSON round-trip）

```text
1. 仅从 allowlisted exact key 列表逐 key 读取；未知 key → fail-closed。
2. 禁止 Object.assign / object spread ({...obj}) / JSON.stringify+parse 作为“拷贝/清洗”手段
   （三者均可漏掉或误带 prototype / accessor / non-enumerable 陷阱）。
3. 每个允许 key 必须同时通过：
   a. Object.hasOwn(source, key) === true
   b. 属性 descriptor 为 data property（非 accessor）：
      desc.get === undefined && desc.set === undefined
      && desc.value 符合该 key 的类型合同
4. 拒绝下列键名（无论是否在 whitelist）：
   '__proto__' | 'constructor' | 'prototype'
5. 拒绝 symbol keys：Object.getOwnPropertySymbols(source).length !== 0 → fail-closed
6. 拒绝 extra enumerable/own keys：own string keys 必须 exact-equal whitelist 集合
7. 拒绝 Proxy / 带 trap 的对象：以 ownKeys + hasOwn + data-descriptor 检查后仍异常 → fail-closed
```

#### 2.7.2 出参：validated deep copy（function 不可 clone → fail-closed）

```text
1. 公共返回物必须是 plain JSON-serializable object graph（无 function / class instance / Buffer / Promise）。
2. 拷贝手段二选一（等价均可）：
   a. structuredClone(validatedPlainObject)
   b. 手工 validated deep copy：仅沿 allowlisted schema 递归复制 data-property 值
3. 若待返回图中出现 function（含 handler 泄漏）→ **fail-closed**（抛 internal/validation 错误或返回 error receipt）；
   不得 silently drop function 后仍标 completed。
4. 禁止用 Object.assign / spread / JSON.stringify 作为返回深拷贝实现。
5. 深拷贝后的对象不得与 registry / handler 闭包共享可变引用。
```

**测试断言（plan T4/T8/T12 同步）：** extra keys、`__proto__`、symbol key、accessor trap、返回含 function → 全部 fail-closed；返回物 `JSON.stringify` 可序列化且无 function。

---

## 3. Code-owned factory / registry（禁止 caller 注入）

### 3.1 所有权边界

```text
┌─────────────────────────────────────────────────────────────┐
│ Public pure API (export)                                     │
│  - resolve / readiness / authorize / invokeDryRun            │
│  - 仅 plain object in/out                                    │
│  - 永不返回 function / handler                                │
└───────────────────────────┬─────────────────────────────────┘
                            │ calls
┌───────────────────────────▼─────────────────────────────────┐
│ Module-private registry (NOT export)                         │
│  - Map<capabilityKind, DryRunHandler>                        │
│  - 仅 module init / trustedBootstrapCapabilityRegistry()     │
│  - trusted bootstrap 只接受 code-owned descriptor 表          │
└───────────────────────────┬─────────────────────────────────┘
                            │ V1.31 only
┌───────────────────────────▼─────────────────────────────────┐
│ Dry-run non-side-effect handlers                             │
│  - 纯函数模拟；无 launchctl/fs/process/network/audit IO       │
│  - 产出 capability-dry-run-receipt                           │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 禁止的注入面（fail-closed）

| 注入尝试 | 行为 |
| --- | --- |
| `options.capabilities` / `options.handlers` / `options.registry` | **忽略**；不读 |
| `options.capabilityInjectionDecision` override | **忽略**；本地重算 |
| request 内 function / command string / shell | **reject** → `capability-caller-injection-rejected` |
| env / config 开关抬升 `real*` / execute | **禁止** |
| 动态 `eval` / `new Function` / `child_process` 拼装 | **禁止** |
| 测试通过生产 options 注册 real handler | **禁止**；仅模块内 bootstrap |

### 3.3 Trusted bootstrap（exact）

```js
/**
 * Module-private. Registers only dry-run-non-side-effect descriptors+handlers
 * from code-owned tables. Not exported. Not callable from request/CLI/Web.
 */
function trustedBootstrapCapabilityRegistry()
```

V1.31 bootstrap **必须**：

1. 为 7 个 `CapabilityKind` 各注册 **恰好 1** 个 dry-run handler
2. 校验 `implementationClass === 'dry-run-non-side-effect'`
3. 校验 `supportsModes` **恰好** `['dry-run']`
4. 校验全部 side-effect / real flags false
5. 校验 10 action primary map 的每个 kind 均有 handler
6. 失败 → registry incomplete；readiness blocked / decision unresolved

**不**注册 execute handlers。
**不**暴露 `registerCapability(kind, fn)` 公共 API。

### 3.4 Dry-run handler 语义（7 类；按 kind 注册，handler 内按 operation+actionId 分派）

**注册粒度（V1.31 与 V1.32 一致）：** trusted bootstrap **按 7 个 `CapabilityKind` 各注册恰好 1 个 handler**（不是按 10 action 各注册一个）。
**分派粒度：** handler 内部 **必须** 读取 `request.operation` + `request.actionId` 做 action-aware 分支；与 `CODE_OWNED_ACTION_PRIMARY_CAPABILITY_MAP` 一致性校验失败 → fail-closed。

| capabilityKind | dry-run 行为 | hostSideEffectOccurred |
| --- | --- | --- |
| `render` | 模拟 plist render 成功路径；无文件写出 | false |
| `write` | **actionId 区分**：`write-launch-agent-plist` → write/create/update 计划；`remove-launch-agent-plist` / `remove-supervisor-metadata` → remove/delete 计划；无 fs | false |
| `reload` | **operation/actionId 区分**：`load-launch-agent`→load；`unload-launch-agent`→unload；`restart-previous-supervisor`→restart；`start-recovery-supervisor`→start；无 launchctl | false |
| `status` | 模拟 capture-state 计划；无 process list | false |
| `rollback` | 模拟 restore 计划 + rollback planned-only | false |
| `audit` | 模拟 audit-plan 步；无 persist/log | false |
| `notify` | 模拟 notify-plan 步；无外部通知 | false |

#### 3.4.1 `write` real handler 分派合同（V1.32+ 强制；V1.31 dry-run 已按同分支模拟）

| actionId | 语义分支 | 禁止混用 |
| --- | --- | --- |
| `write-launch-agent-plist` | **write / create / update**（fs write 语义） | 不得走 remove/delete 路径 |
| `remove-launch-agent-plist` | **remove / delete**（fs remove 语义） | 不得走 write/create 路径 |
| `remove-supervisor-metadata` | **remove / delete**（metadata remove 语义） | 不得走 write/create 路径 |

#### 3.4.2 `reload` real handler 分派合同（V1.32+ 强制；V1.31 dry-run 已按同分支模拟）

| actionId | operation 语境 | 语义分支 | 禁止混用 |
| --- | --- | --- | --- |
| `load-launch-agent` | install | **load** | 不得 unload/restart/start |
| `unload-launch-agent` | uninstall | **unload** | 不得 load/restart/start |
| `restart-previous-supervisor` | rollback | **restart** | 不得 load/unload/start |
| `start-recovery-supervisor` | recover | **start** | 不得 load/unload/restart |

**V1.32 real handlers：** 仍按 **7 capability kind** 注册；handler 内按 `operation`+`actionId` dispatch；粒度与 V1.31 dry-run **完全一致**（见 §8.4）。

### 3.5 导出 API（稳定 public）

```js
/** Fixed readiness: pure capability injection contract + dry-run registry evidence. */
export function buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness()

/**
 * Resolve capability injection plan for candidates+operation.
 * Does NOT invoke handlers; does NOT authorize execute; does NOT elevate real wiring.
 */
export function resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(candidates, operation)

/**
 * Authorize mode. Default dry-run path may be ready; execute is hard-denied in V1.31.
 * Returns plain authorization decision (no handlers).
 */
export function authorizeSupervisorLifecycleGuardedRunnerCapabilityMode(request)

/**
 * Invoke dry-run capability only. Execute mode → hard-denied receipt.
 * Never performs host side effects. Never returns functions.
 */
export function invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(request)
```

命名约束：

- 采用 `resolve` / `authorize` / `invoke...DryRun`（明确 dry-run）
- **拒绝** export：`runCapability`、`executeCapability`、`dispatchRunner`、`registerCapability`

---

## 4. dry-run vs execute 授权公式

### 4.1 默认模式

```text
default mode = dry-run
```

任何缺失 / 非法 `mode` → `capability-mode-invalid`（fail-closed），**不**回落到 execute。

### 4.2 dry-run 授权（V1.31 可 true）

```text
dryRunCapabilityAuthorized =
  request.mode === 'dry-run' &&
  capabilityKind ∈ CAPABILITY_KIND_ALLOWLIST &&
  actionId 与 CODE_OWNED_ACTION_PRIMARY_CAPABILITY_MAP 一致（对 primary invoke）&&
  operation ∈ ALLOWED_OPERATIONS &&
  dryRunCapabilityRegistryReady === true &&
  handler.implementationClass === 'dry-run-non-side-effect' &&
  handler.supportsModes includes 'dry-run' &&
  handler.realImplementationReady === false &&
  全部 side-effect *Allowed / would* === false &&
  无 caller injection 字段
```

**注意：** dry-run **不**要求 `executeRequested`、**不**要求 `realRunnerWiringReady`、**不**要求 dual-host。
dry-run **成功** ≠ gate `executionEligible`。

### 4.3 execute 授权（V1.31 恒 false → 单闸 immediate hard-deny）

```text
executeCapabilityAuthorized =
  request.mode === 'execute' &&
  executeRequested === true &&                          // gate/policy fact
  policyDecision.authorized === true &&
  // 完整 gate executionEligible 公式全部 true：
  lifecyclePlanValid &&
  approvalRecordReady &&
  manifestReady &&
  runnerBindingsReady &&
  executionPreviewVerified &&
  actionCandidatesReady &&
  executionPolicyReady &&
  runnerRegistryReady &&
  hostMutationAdapterReady &&
  rollbackAnchorReady &&
  attemptAuditReady &&
  operatorRecoveryReady &&
  realRunnerWiringReady &&                              // V1.31 false
  runnerWiringContractReady &&                          // V1.31 false
  // 各 real implementation（全部 V1.31 false）：
  realHostMutationImplementationReady &&
  realRollbackAnchorImplementationReady &&
  realAttemptAuditImplementationReady &&
  realOperatorRecoveryImplementationReady &&
  realRunnerImplementationsReady &&                     // / realHostRunnerReady
  realCapabilityImplementationsReady &&                 // NEW；V1.31 false
  executeCapabilityRegistryReady &&                     // real handlers 注册完备；V1.31 false
  // 操作前置：
  idempotencyKey present && valid && replay-safe &&
  real rollback anchor write/restore sink ready &&
  real immutable audit sink ready &&
  real operator recovery / notify path ready &&
  dual-host evidence recorded &&
  failure-injection suite evidence recorded &&
  handler.implementationClass === 'real-side-effect' && // 非 dry-run class
  handler.supportsModes includes 'execute'
```

**V1.31 实现要求（单闸架构保证）：**

```text
// V1.31 = 单闸 immediate hard-deny + 无 real handler 架构保证
// 不是“公式已验证后再 deny”的双闸；real handlers 本版根本不存在。
if (mode === 'execute') {
  return capability-execute-denied-receipt
    with primaryBlocker = 'capability-execute-hard-denied'
       or 'capability-execute-prerequisites-incomplete'
    hostSideEffectOccurred = false
    executeCapabilityAuthorized = false
    // 立即返回；不得调用任何 handler（含 dry-run handler 的 execute 分支）
    // 不得进入 real dispatch（V1.31 无 real handler 可调度）
}
```

| 版本 | 闸门结构 | 架构保证 |
| --- | --- | --- |
| **V1.31** | **单闸**：`mode==='execute'` → **immediate hard-deny receipt** | **无 real handler** 注册；execute 路径永不 dispatch；公式文档化但**不**作为第二道运行时校验（因无 real 路径可走） |
| **V1.32+** | **双闸**：① 注册 real handlers 后，**dispatch 前**必须再次验证 **完整** `executeCapabilityAuthorized` 公式；② 公式 false → deny，true 才允许 real dispatch | 有 real handlers 后，仅 hard-deny 不够；必须 **pre-dispatch re-validate full formula** 形成双闸 |

**禁止旧措辞：** 不得把 V1.31 描述为“公式 + hard-deny 双闸 / defense-in-depth 双闸”——本版是 **单闸 hard-deny + 无 real handler**。
**V1.32 强制：** 注册 `implementationClass:'real-side-effect'` 后，**必须**在每次 real dispatch 前完整重算 §4.3 公式；缺任一证据 locus（§4.5）→ deny。

### 4.4 与 gate `executionEligible` 的关系

| 表面 | dry-run authorized | executeCapabilityAuthorized | executionEligible |
| --- | --- | --- | --- |
| V1.31 production ready + dry-run | **可 true** | **false** | **false** |
| V1.31 任意 execute request | n/a | **false** | **false** |
| 未来 real wiring 全证明后 | true | 可能 true | 仅当完整公式 true |

**禁止**用 `dryRunCapabilityAuthorized` 驱动 Web 去掉 `executionSentinel`。
**禁止**把 `executeCapabilityAuthorized` 写入 `POLICY_FACT_KEYS`。

### 4.5 Execute 证据 locus 占位表（V1.31 不存在 / false；V1.32 schema owner）

下列 locus 是 §4.3 公式中 real execute 前置的 **证据挂点**。V1.31 **不实现、不注册、不存在运行时 store**；相关 readiness / ready 标志 **恒 false**。V1.32+ 才由明确 schema owner 落地。

| 证据 locus | V1.31 存在？ | V1.31 事实 | V1.32+ schema owner（职责） | 进入 execute 公式的语义 |
| --- | --- | --- | --- | --- |
| **idempotency store** | **否** | 不存在；`idempotencyKeyFingerprint` 生产固定 `null`；缺 key 仍 deny | capability idempotency module（key validate + replay-safe store + fingerprint） | `idempotencyKey present && valid && replay-safe` |
| **real rollback anchor** | **否** | `realRollbackAnchorImplementationReady:false`；无 write/restore sink | rollback-anchor real implementation（V1.27+ locus 抬升） | real rollback anchor write/restore sink ready |
| **persist audit sink** | **否** | `realAttemptAuditImplementationReady:false`；无 immutable persist | attempt-audit real implementation（V1.28+ locus 抬升） | real immutable audit sink ready |
| **recovery / notify path** | **否** | `realOperatorRecoveryImplementationReady:false`；notify 仅 dry-run plan | operator-recovery real implementation + notify capability real handler | real operator recovery / notify path ready |
| **dual-host evidence** | **否** | 不存在记录面；无 dual-host PASS 写入 capability 层 | dual-host evidence recorder（与 G0a 边界协调；capability execute 侧消费） | dual-host evidence recorded |
| **failure injection suite evidence** | **否** | 生产 API 无 inject field；仅 test harness 可模拟 partial/timeout | failure-injection evidence suite + harness（证明 partial/timeout/rollback 路径） | failure-injection suite evidence recorded |

**V1.31 断言合同：**

- 上表 6 行在 readiness / decision / receipt / gate 上均不得以“已 ready”出现。
- 不得用 dry-run receipt / wiringPlanSeal / policy authorized 冒充任一 locus 已满足。
- Gold / README 可列出这些 **占位名** 作为 nextStep，但必须标明 **V1.31 false / not present**。

---

## 5. Gate / wiring 集成

### 5.1 production-derived only

在 `buildSupervisorLifecycleGuardedRunnerExecutionGate` 内，于 wiring plan/seal 之后（或紧邻）：

1. **忽略** `options.capabilityInjectionDecision` / `options.capabilityReceipt` / `options.capabilityInjectionReady` / `options.handlers` / `options.capabilities` / 任意 `realCapability*` override
2. `capabilityInjectionReadiness = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness()`
3. `capabilityInjectionDecision = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(actionCandidates, operation)`
4. 本地 boolean：

```js
const capabilityInjectionReady =
  capabilityInjectionReadiness?.state === 'ready' &&
  capabilityInjectionReadiness?.pureCapabilityInjectionReady === true &&
  capabilityInjectionReadiness?.codeOwnedCapabilityFactoryReady === true &&
  capabilityInjectionReadiness?.dryRunCapabilityRegistryReady === true &&
  capabilityInjectionReadiness?.realCapabilityImplementationsReady === false &&
  capabilityInjectionReadiness?.executeCapabilityRegistryReady === false &&
  capabilityInjectionDecision?.state === 'resolved' &&
  capabilityInjectionDecision?.capabilityInjectionReady === true &&
  capabilityInjectionDecision?.dryRunCapabilityRegistryReady === true &&
  capabilityInjectionDecision?.executeCapabilityAuthorized === false &&
  capabilityInjectionDecision?.realCapabilityImplementationsReady === false &&
  capabilityInjectionDecision?.wouldExecute === false &&
  capabilityInjectionDecision?.wouldRun === false &&
  capabilityInjectionDecision?.wouldWrite === false &&
  capabilityInjectionDecision?.hostSideEffectOccurred === false &&
  capabilityInjectionDecision?.realRunnerWiringReady === false &&
  capabilityInjectionDecision?.runnerWiringContractReady === false &&
  capabilityInjectionDecision?.executionEligible === false;
```

5. **可选（推荐）** 对 production ready path 生成 **示例 dry-run receipt**（install 的 primary `render` 或逐步汇总 `receipts[]` 摘要 identifiers only）——若复杂度过高，gate **可只挂 decision + readiness**，把 invoke 留给 pure unit tests；plan 实现阶段二选一但必须可测。
6. **仍 hardcode：**

```js
executionEligible: false,
wouldExecute: false,
realRunnerWiringReady: false,
gates.realRunnerWiringReady: false,
gates.runnerWiringContractReady: false,
nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
// capabilityInjectionReady:true 不得移除 wiring-missing
```

7. **不**把 capability facts 加入 `POLICY_FACT_KEYS`
8. **不**修改 six requiredContracts 计数（保持 6/0）
9. wiring aggregate：`state:'blocked'`、`realRunnerWiringReady:false`、blockers 仍含 wiring-missing；**可**嵌套 `capabilityInjectionReadiness` 子对象

### 5.2 诚实性：capability ready 与 wiring-missing 并存

| 场景 | `gates.capabilityInjectionReady` | dry-run | execute | `realRunnerWiringReady` | `executionEligible` | `nextBlockers[0]` |
| --- | --- | --- | --- | --- | --- | --- |
| production ready + executeRequested | **true** | authorized surface ready | hard-deny | **false** | **false** | wiring-missing |
| empty candidates | false | n/a | deny | false | false | wiring-missing |
| caller handlers 注入 | false / reject | reject | deny | false | false | wiring-missing |
| mode=execute invoke | decision 可 resolved | n/a | **denied receipt** | false | false | wiring-missing |

**禁止矛盾：**

> ❌ capabilityInjectionReady **同时** `realRunnerWiringReady:true`
> ❌ dry-run receipt completed **消解** wiring-missing
> ❌ dry-run receipt completed **抬升** `executionEligible`
> ❌ execute denied 被渲染为 execute completed
> ❌ 把 capability receipt 当作 `wiringPlanSeal`

---

## 6. Readiness / Decision 输出 schema

### 6.1 Readiness（固定 builder，无参）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-capability-injection-readiness',
  state: 'ready',
  pureCapabilityInjectionReady: true,       // pure contract fact only
  codeOwnedCapabilityFactoryReady: true,
  dryRunCapabilityRegistryReady: true,
  executeCapabilityRegistryReady: false,    // 恒 false
  realCapabilityImplementationsReady: false,// 恒 false
  realRunnerWiringReady: false,
  executeCapabilityAuthorized: false,
  readyCount: 1,
  blockedCount: 0,
  entries: [{
    injectionKind: 'code-owned-capability-injection',
    state: 'ready',
    codeOwnedResolverWired: true,
    dryRunCapabilityRegistryReady: true,
    executeCapabilityRegistryReady: false,
    realCapabilityImplementationsReady: false,
    realRunnerWiringReady: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    hostSideEffectOccurred: false,
    launchctlAllowed: false,
    filesystemWriteAllowed: false,
    processListReadAllowed: false,
    networkAllowed: false,
    blockerCode: null,
    evidenceCode: 'capability-injection-ready',
  }],
  capabilityKinds: ['render','write','reload','status','rollback','audit','notify'],
  blockers: [],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  safety: executionPreviewSafety(),
}
```

### 6.2 Decision（resolved 路径摘要）

```js
{
  command: 'supervisor-lifecycle-guarded-runner-capability-injection',
  state: 'resolved',
  operation: '<allowlisted>',
  capabilityInjectionReady: true,
  dryRunCapabilityRegistryReady: true,
  executeCapabilityAuthorized: false,
  realCapabilityImplementationsReady: false,
  realRunnerWiringReady: false,
  runnerWiringContractReady: false,
  executionEligible: false,
  hostSideEffectOccurred: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  codeOwnedResolverWired: true,
  mappings: [
    {
      actionId,
      primaryCapabilityKind,
      capabilityId,              // dry-run id
      implementationClass: 'dry-run-non-side-effect',
      supportsModes: ['dry-run'],
      wouldExecute: false,
      hostSideEffectOccurred: false,
    },
    // ... per candidate order
  ],
  evidenceCode: 'capability-injection-plan-ready',
  primaryBlocker: null,
  blockers: [],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  safety: executionPreviewSafety(),
}
```

---

## 7. API / CLI / Web 语义

### 7.1 Policy

- **不**扩展 `POLICY_FACT_KEYS`
- ready path 继续 **authorized** / primary null
- authorize ≠ execution ready 继续由 `executionEligible:false` + wiring-missing + `executionSentinel` 表达

### 7.2 API / CLI

- **不**新增 endpoint、CLI command、request body field
- 既有 gate 透传 JSON **自然包含** `capabilityInjectionDecision` / readiness 嵌套 /（若有）receipt 摘要
- 继续拒绝 apply / approval override / dataDir client override 等既有边界
- 参数化测试 helper 仅扩展 assertion；**不改** `src/agent.js` / `src/server.js`
- **无** `--capability-handler` / `--execute-capability` 新旗标

### 7.3 Web（方案 A 保持 + capability 行 shall）

**必须保持：**

```text
policyDecision:state:authorized:...:primaryBlocker:none
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing
wiringPlan:state:planned:planReady:true:realRunnerWiringReady:false:mode:plan-only:blocker:none
wiringPlanSeal:state:seal-ready:sealReady:true:realRunnerWiringReady:false:blocker:none
```

**必须新增（shall）** capability 固定行（canonical、不回显 raw）：

```text
capabilityInjection:state:resolved:dryRunReady:true:executeReady:false:realRunnerWiringReady:false:blocker:none
```

若 gate 附带 dry-run receipt 摘要：

```text
capabilityReceipt:kind:dry-run:state:completed:hostSideEffectOccurred:false:realRunnerWiringReady:false:blocker:none
```

blocked / unresolved path 渲染对应 blocked 行（仍含 `realRunnerWiringReady:false`、`executeReady:false`）。

`validationLines` **必须**含：

```text
capabilityInjectionReady:true|false
dryRunCapabilityRegistryReady:true|false
executeCapabilityAuthorized:false
realCapabilityImplementationsReady:false
realRunnerWiringReady:false
runnerWiringContractReady:false
executionEligible:false
```

**禁止**因 capability ready 删除 `executionSentinel`。
**禁止**把 capabilityReceipt 描述为 wiringPlanSeal 或 persisted audit。

### 7.4 executionSentinel 保留条件（继承 V1.30，本版不解除）

直至同时：

1. `realRunnerWiringReady===true` 有 real capability + dual-host/failure-injection 证据
2. `runnerWiringContractReady===true` 有 code-owned 谓词（非 hardcode true）
3. 各 `real*ImplementationReady` 与 execute 边界已证明
4. 用户/PM 明确批准

V1.31：**sentinel 不变**。

---

## 8. V1.31 最小实现阶段：仅 non-side-effect dry-run

### 8.1 本版实现什么

| 交付 | 说明 |
| --- | --- |
| interface schema + maps | 7 kinds × 10 actions 证据派生 |
| trusted dry-run registry | 仅 `dry-run-non-side-effect` |
| resolve / readiness / authorize / invokeDryRun | pure + 模块私有 handler |
| execute 单闸 hard-deny | 任意 execute → denied receipt；无 real handler；非双闸 |
| gate 附加 decision + facts | 动态 `capabilityInjectionReady` 等 |
| Web shall 行 | capabilityInjection（+ 可选 receipt 行） |
| Gold evidence / README / version | V1.31 诚实措辞 |

### 8.2 哪些 fact 可 true

| Fact | V1.31 |
| --- | --- |
| `pureCapabilityInjectionReady` | **true**（readiness） |
| `codeOwnedCapabilityFactoryReady` | **true** |
| `dryRunCapabilityRegistryReady` | **true** |
| `gates.capabilityInjectionReady` | production resolve 成功 → **true** |
| dry-run authorize / dry-run receipt completed | **可 true** |
| `pureWiringOrchestratorPlanReady` | **保持** V1.30 true |
| wiring `readyCount/blockedCount` | **保持 6/0** |
| policy authorized ready path | **保持** |

### 8.3 哪些 real\* / 资格 仍 false / blocked

| Fact | V1.31 |
| --- | --- |
| `realCapabilityImplementationsReady` | **false** |
| `executeCapabilityRegistryReady` | **false** |
| `executeCapabilityAuthorized` | **false** |
| `realRunnerWiringReady` | **false** |
| `runnerWiringContractReady` | **false** |
| `executionEligible` / `wouldExecute` | **false** |
| 全部既有 `real*ImplementationReady` | **false** |
| 全部 side-effect would\* / \*Allowed | **false** |
| `hostSideEffectOccurred` | **false** |
| wiring aggregate `state` | **blocked** |
| `real-guarded-runner-execution-wiring-missing` | **仍在** |
| Gold | **blocked** |
| Web `executionSentinel` | **blocked** |

### 8.4 如何直接解锁下一版（非无价值 pure 层）

```text
V1.30 plan-only proof
        │
        ▼
V1.31 capability interface + dry-run registry
     + execute 单闸 immediate hard-deny（无 real handler）
        │  ← 同一 CapabilityDescriptor / Receipt / 7-kind 注册粒度
        ▼
V1.32+ trusted bootstrap 按 7 capability kind 注册 real-side-effect handlers
        │  handler 内 operation+actionId dispatch（write/remove；load/unload/restart/start）
        │  + §4.5 六证据 locus 落地
        │  + dispatch 前再次验证完整 execute 公式 → 形成双闸
        ▼
per-locus real*ImplementationReady → true（各自独立版本）
        │
        ▼
谓词化 realRunnerWiringReady / runnerWiringContractReady
        │
        ▼
executionEligible 公式可首次为 true（仍 fail-closed）
```

**下一版可直接挂载的挂点（V1.32 mount guide）：**

1. **`trustedBootstrapCapabilityRegistry`**：扩展注册 `implementationClass:'real-side-effect'`（仍禁止 caller 注入）。
2. **注册粒度 = 7 capability kind**（与 V1.31 一致）：`render|write|reload|status|rollback|audit|notify` 各 1 real handler——**不是**按 10 action 各注册。
3. **handler 内 dispatch**：按 `operation` + `actionId` 分支：
   - `write` → write/create/update vs remove/delete（§3.4.1）
   - `reload` → load / unload / restart / start（§3.4.2）
4. **双闸**：注册 real handlers 后，**每次 real dispatch 前**必须完整重算 §4.3 `executeCapabilityAuthorized`；公式 false → deny，不得“有 handler 就直接执行”。
5. **§4.5 六证据 locus** 由各自 schema owner 落地后，才允许对应公式输入变 true。
6. **`capability-execute-receipt` schema** 已预留（含 `state:'rolled-back'`）；与 dry-run 同 command、不同 receiptKind。
7. gate / Web / Gold 扩展点已预留字段名，避免再挖“又一层 pure map”。

---

## 9. Scope（实现阶段；本设计阶段不改源码）

### 9.1 允许修改（实现阶段）

| 文件 | 变更 |
| --- | --- |
| `src/supervisor-lifecycle.js` | capability maps / private registry / resolve / readiness / authorize / invokeDryRun / gate 集成 |
| `src/web/app.js` | view model 固定行 / validationLines（无新 button） |
| `src/gold-readiness.js` | evidence + nextStep 指向 V1.31 capability injection + 仍 blocked 边界 |
| `src/version.js` | → `V1.31` |
| `README.md` | 版本条 + 边界 |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | pure + gate TDD |
| `test/web-console.test.js` | capability 行 + sentinel 保持 |
| `test/gold-readiness.test.js` | evidence / nextStep |
| 既有 gate API/CLI 透传测试 | 仅断言扩展 |

### 9.2 明确禁止

| 文件 / 行为 | 状态 |
| --- | --- |
| `src/agent.js` / `src/server.js` / `package.json` | **禁止改** |
| 新增 endpoint / CLI command / Web button / request field | **禁止** |
| launchctl / shell / fs write / process list / network / NAS / backup / restore / audit persist / notify send | **禁止** |
| 置 `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` / 任一 `real*ImplementationReady` / executeCapabilityAuthorized true | **禁止** |
| 消解 `real-guarded-runner-execution-wiring-missing` | **禁止** |
| 公共 `registerCapability` / options handlers 注入 | **禁止** |
| 把 `wiringPlanSeal` 改作 execution/capability receipt | **禁止** |

### 9.3 本设计/计划阶段允许写入

仅：

- `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-runner-capability-injection-design.md`
- `docs/superpowers/plans/2026-07-14-supervisor-lifecycle-runner-capability-injection.md`

---

## 10. TDD 矩阵（实现阶段）

| # | 场景 | 期望 |
| --- | --- | --- |
| T1 | readiness builder | ready + dryRun true + executeRegistry false + real\* false + nextBlockers wiring-missing |
| T2 | resolve：合法 install candidates | resolved；10/3 action maps；primary kinds exact；executeAuthorized false |
| T3 | resolve：unknown action / duplicate / invalid op | unresolved + allowlisted primary |
| T4 | resolve：extra keys / `__proto__` / symbol / accessor / Proxy | §2.7 fail-closed；无 assign/spread/JSON 清洗 |
| T5 | authorize dry-run | authorized surface；无 host flags |
| T6 | authorize/invoke execute | **单闸 immediate hard-deny**；不调 handler；无 real dispatch；hostSideEffectOccurred false |
| T7 | invokeDryRun 7 kinds；write/reload actionId 分派 | completed dry-run；write≠remove；load≠unload≠restart≠start；≠ seal |
| T8 | invoke 含 function/command/path | `capability-caller-injection-rejected`；返回无 function |
| T9 | idempotency：execute 缺 key | deny；dry-run 允许 null；**fingerprint 恒 null** |
| T10 | timeout/partial **仅** test harness | 生产不可达；harness errorClass 正确；无 host；`rolled-back` 不产出 |
| T11 | auditSequence 顺序固定 | exact order |
| T12 | 敏感扫描 + 返回深拷贝 | 无 token/path；category counts only；structuredClone/validated copy；function fail-closed |
| T13 | gate production ready | capabilityInjectionReady true；executionEligible false；wiring-missing 仍在；6/0；seal 仍 plan-only |
| T14 | gate options handlers/decision override | **忽略** |
| T15 | Web ready path | policy authorized + executionSentinel blocked + wiring 行 + **shall** capability 行 |
| T16 | Gold | blocked；evidence 含 V1.31 capability + false real wiring |
| T17 | 差分无 host API | 相对 7ac8d6c 无 launchctl/child_process/fs.write 新增调用 |
| T18 | 不改 agent/server/package | scope check |

---

## 11. 验证命令与恢复锚点

### Focused

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
node --test test/web-console.test.js
node --test test/gold-readiness.test.js
```

### Full

```bash
node --test
```

### Side-effect / sensitive scan（相对 7ac8d6c）

- 仅 category hit counts
- 无新增 host mutation 调用路径
- scope 仅 §9.1

### 恢复锚点

- **commit：** `7ac8d6c`
- **信息：** `feat: add V1.30 real runner wiring proof`
- 越界时：丢弃工作区改动，回到该锚点干净树后按 plan 重做
- **禁止**把 `git reset --hard` 写进常规实施步骤清单

---

## 12. 安全与非目标

### 安全

- 无 secret / token / Authorization / path / URL / hostname / username / pid / raw idempotency key 回显
- 恶意 fixture 仅 opaque synthetic 字符串
- **入参 exact whitelist extraction** + `Object.hasOwn` + data-descriptor 检查；拒绝 `__proto__` / `constructor` / `prototype` / symbol / extra keys（§2.7）
- **出参** `structuredClone` 或等效 validated manual deep copy；function 不可 clone → fail-closed；**禁止** `Object.assign` / spread / JSON round-trip 作拷贝
- 不读 env 作为执行开关以抬升 real wiring / execute
- handlers 永不序列化进 JSON；`idempotencyKeyFingerprint` V1.31 固定 `null`

### 非目标（V1.31）

- 真实 launchctl / fs / process / network / NAS / audit persist / notify
- `realRunnerWiringReady=true` / `runnerWiringContractReady=true` / `executionEligible=true`
- `executeCapabilityAuthorized=true` / real capability registry
- 消解 `real-guarded-runner-execution-wiring-missing`
- 实现 §4.5 任一证据 locus（idempotency store / real rollback / audit sink / recovery-notify / dual-host / failure-injection）
- 把 V1.31 描述为 execute “双闸”（本版为 **单闸 hard-deny + 无 real handler**）
- 新增 endpoint / CLI / Web button / request field
- 修改 agent.js / server.js / package.json
- Gold ready 声明
- G0a 报告改写
- 把 wiringPlan.mode 从 `plan-only` 改为 execute

### 下一步（显式非本版）

1. **V1.32+：** 按 **7 capability kind** 注册 real-side-effect handlers（trusted bootstrap only）；handler 内 `operation`+`actionId` dispatch
2. 落地 §4.5 六证据 locus（idempotency store / real rollback anchor / persist audit sink / recovery-notify / dual-host / failure-injection）
3. **双闸：** real dispatch 前再次验证完整 execute 公式
4. 抬升对应 `real*ImplementationReady`
5. 谓词化 `realRunnerWiringReady` / `runnerWiringContractReady`
6. 仅当完整公式成立 → `executionEligible`
7. 并行 Gold：NAS / auth / hardening / G4–G7

---

## 13. 完成标准（实现阶段验收）

1. capability interface schema + 10-action 派生 map + 7 kind dry-run registry 存在且 fail-closed
2. 公共 API 永不接受/返回 function/command/shell；caller injection reject；**§2.7 prototype 防护 + structuredClone/validated deep copy** 落实
3. dry-run invoke 产出 `capability-dry-run-receipt`（**NOT** wiringPlanSeal）
4. execute **单闸 immediate hard-deny**（无 real handler；**非**双闸）；`executeCapabilityAuthorized:false`；`hostSideEffectOccurred:false`
5. production gate：`gates.capabilityInjectionReady:true`（合法 path）**同时** `realRunnerWiringReady:false`、`runnerWiringContractReady:false`、`executionEligible:false`
6. gate + wiring 仍含 `real-guarded-runner-execution-wiring-missing`
7. wiring `readyCount:6` / `blockedCount:0` / `state:'blocked'`
8. 全部既有 `real*ImplementationReady` 与 side-effect would\* / \*Allowed 仍 false；§4.5 六 locus **均不存在 / false**
9. policy ready path 仍 authorized；Web 方案 A + wiring 行 + **shall** capability 行 + executionSentinel 恒 blocked
10. 无 agent.js / server.js / package.json 变更
11. 无 host 副作用调用
12. Gold overall **blocked**；README 标明 V1.31 为 capability injection + dry-run boundary（非 real runner 完成）
13. 恢复锚点 `7ac8d6c` 文档化
14. receipt 生产可达 state **仅** `completed|denied|error`；`partial`/`timeout` 仅 harness；`rolled-back` V1.32+ 预留；`idempotencyKeyFingerprint` **固定 null**
15. dry-run `write`/`reload` handlers **actionId/operation 分派**合同与 §3.4.1–3.4.2 一致（为 V1.32 real 同粒度预留）
16. **不**宣称 Gold 发布或 real runner wiring 完成；**不**宣称 V1.31 已是 execute 双闸

---

## 14. 问题对照表（设计必须回答）

| # | 问题 | 答案 |
| --- | --- | --- |
| 1 | capability interface exact schema；code-owned factory；禁 caller 注入 | §2–§3；7 kinds 由 10 actions 派生 |
| 2 | dry-run vs execute 授权公式；V1.31 **单闸** hard-deny；V1.32 **双闸** | §4.3–§4.4 |
| 3 | receipt 命名与 seal 区分；可达 state；fingerprint null；timeout/partial/rollback | §2.4–§2.6 |
| 4 | prototype 防护；exact whitelist；structuredClone；function fail-closed | §2.7 |
| 5 | write/reload actionId 分派；V1.32 7-kind 注册 + 内部 dispatch | §3.4、§8.4 |
| 6 | execute 证据 locus 占位；V1.31 不存在；V1.32 schema owner | §4.5 |
| 7 | 是否仅 dry-run capabilities；哪些 true/false；如何解锁下一版 | §8 |
| 8 | API/CLI/Web；无新 endpoint/button/field；scope/TDD/扫描；锚点 7ac8d6c | §7、§9–§11 |
| — | 何时仍不能置 realRunnerWiringReady / runnerWiringContractReady / executionEligible | **V1.31 全程不能**；见 §0.2、§4.4、§5.2、§8.3 |
