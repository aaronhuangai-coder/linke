# V1.32 Supervisor Lifecycle First Real Capability Handler Design

## 目标

V1.32 在 **V1.31 capability injection interface + dry-run registry + execute 单闸 hard-deny** 的基线（`3cf4848`）上，交付**第一个诚实的 real implementation handler**，使 V1.31 接口开始承接 **real 能力**——而不是继续叠 pure map 或假装 host wiring 完成。

> **选定能力：`render`（`render-launch-agent-plist`）**
> 作为 **real implementation**（确定性内容生成），**不是** host side effect。

本版建立：

1. **术语分离**：`real implementation` ≠ `host side effect`；render 可真实实现且 `hostSideEffectOccurred:false`
2. **trusted bootstrap 双轨注册**：保留 7 个 dry-run handler；**仅**为 `render` 追加 real implementation handler
3. **direct internal proof 调用面**：在完整 execute 公式仍不满足时，用 **非 execute** 的 proof API 验证 real render，**不**暴露 public execute
4. **局部 fact**：仅 `realRenderCapabilityImplementationReady` 可 true；全局 real/Gold/wiring-missing/execution sentinel **保持 false/blocked**

### 关键边界（必须先读）

| 层级 | V1.32 是否完成 | 含义 |
| --- | --- | --- |
| **first real implementation handler (`render`)** | **是** | code-owned 确定性 plist 渲染；可测、可哈希、无 host 写 |
| **dry-run registry（7 kinds）** | **保持** | V1.31 dry-run 路径不变；可并行存在 |
| **`realRenderCapabilityImplementationReady`** | **可 true** | **仅** render 局部 fact |
| **`realCapabilityImplementationsReady`（全局）** | **否** | 7 kinds 未全 real；**恒 false** |
| **`executeCapabilityRegistryReady` / `executeCapabilityAuthorized`** | **否** | 完整 execute 公式仍不满足；execute **仍 hard-deny** |
| **host side effect（launchctl / fs write / process / network / audit persist / notify）** | **否** | **禁止**；`hostSideEffectOccurred:false` |
| **`realRunnerWiringReady` / `runnerWiringContractReady`** | **否** | **禁止**因本版变 true |
| **`executionEligible` / `wouldExecute`** | **否** | 恒 false |
| **消解 `real-guarded-runner-execution-wiring-missing`** | **否** | 仍在 |
| **Gold 发布** | **否** | scorecard 继续 `blocked` |
| **G0a dual-host 作为 capability execute 前置** | **否** | G0a PASS **不**消费为 capability execute locus；本版 **不**调用双机 |

**严禁**把 real render proof completed、`realRenderCapabilityImplementationReady:true`、dry-run receipt completed、`wiringPlanSeal` seal-ready、或 policy `authorized` 冒充：

- `realRunnerWiringReady:true`
- `runnerWiringContractReady:true`
- `executionEligible:true`
- `realCapabilityImplementationsReady:true`（全局）
- `executeCapabilityAuthorized:true`
- 真实 host runner dispatch / launchctl / fs write / process list / network
- Gold ready

**恢复锚点：** `3cf4848`（`feat: add V1.31 runner capability injection`）。实现越界时回到该 commit 的干净状态再重做（见 §11；**禁止**在 plan/docs 中建议 `git reset --hard` 作为常规步骤）。

---

## 0. 源码事实基线（3cf4848 / V1.31，不得猜）

以下全部来自当前 `src/supervisor-lifecycle.js` / `src/web/app.js` / `src/gold-readiness.js` / `README.md` / `src/agent.js` / `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md` / 相关 tests。

### 0.1 V1.31 已完成与仍 blocked

| 项 | 3cf4848 事实 |
| --- | --- |
| capability kinds allowlist | `render \| write \| reload \| status \| rollback \| audit \| notify` |
| dry-run registry | trusted bootstrap 按 **7 kind** 各注册 1 个 `implementationClass:'dry-run-non-side-effect'`；`supportsModes:['dry-run']` |
| dry-run handler 行为 | 仅返回 `{ok, plannedAction, capabilityId}`；**无** content / hash / host IO |
| public API | `build...CapabilityInjectionReadiness` / `resolve...CapabilityInjection` / `authorize...CapabilityMode` / `invoke...CapabilityDryRun` |
| execute 路径 | **单闸** immediate hard-deny；**不**调任何 handler；**无** real handler |
| `realCapabilityImplementationsReady` | **false** |
| `executeCapabilityAuthorized` | **false** |
| `hostSideEffectOccurred` | 任意 receipt 路径 **false** |
| `idempotencyKeyFingerprint` | 生产 **固定 null** |
| receipt 生产 state | `completed \| denied \| error`；`partial`/`timeout` 仅 harness；`rolled-back` 预留 |
| wiring aggregate | `readyCount:6` / `blockedCount:0` / `state:'blocked'` + wiring-missing |
| `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` | **false** |
| Web | 方案 A + wiringPlan/wiringPlanSeal 行 + **shall** capabilityInjection 行；`executionSentinel` 恒 blocked |
| Gold | **blocked**；automation-installation **partial** |
| agent.js / server.js / package.json | V1.31 **未改**（默认本版也 **禁止改**） |
| 版本 | `LINKE_RELEASE_VERSION = 'V1.31'` |

### 0.2 `buildLifecycleActions` 与 primary capability map（权威）

```text
install:
  render-launch-agent-plist  → render     (mutationKind: render-plist-mutation；副作用类: none)
  write-launch-agent-plist   → write      (host-mutating fs write 语义)
  load-launch-agent          → reload     (host-mutating launchctl load)

uninstall:
  unload-launch-agent        → reload
  remove-launch-agent-plist  → write
  remove-supervisor-metadata → write

rollback:
  capture-current-state      → status     (observational / process-fs read 语义)
  restore-previous-plist     → rollback
  restart-previous-supervisor→ reload

recover:
  start-recovery-supervisor  → reload
```

横切：每个 action 仍有 audit / notify dry-run 计划序（V1.31）；本版 **不** real 化 audit/notify。

### 0.3 V1.31 dry-run render vs 已有 launchd 生成（证据对照）

| 表面 | 位置 | 行为 | 是否 host write | 是否 capability real |
| --- | --- | --- | --- | --- |
| dry-run capability render | `createDryRunCapabilityHandler('render')` | `plannedAction:'render-plist'` only | 否 | **否**（stub 计划） |
| `generateLaunchdPlist` | `src/agent.js` | 真实确定性 XML 字符串生成 | 否（纯函数） | **未**挂到 capability registry |
| `writeLaunchdDryRun` | `src/agent.js` | 可选 **fs write**（project-dir only） | **可能是** | 非 capability；本版 **禁止** 调用 write 路径 |

**结论：** 真实确定性渲染逻辑已在 agent 侧以 pure 函数形态存在，但 **未** 进入 V1.31 capability registry。V1.32 必须把 **code-owned pure render** 挂到 capability 接口上，且：

- **默认不改** `agent.js` → 在 `supervisor-lifecycle.js` **内嵌/复刻最小 pure render**（或抽取到仅被 lifecycle 使用的纯模块——若新增文件需在 plan 明示；**首选 lifecycle 内 private pure renderer**，避免 scope 扩张）。
- **禁止** 走 `writeLaunchdDryRun` / 任何输出路径写文件。

### 0.4 `status` 候选为何更重（对照证据）

| 维度 | `render` | `status`（`capture-current-state`） |
| --- | --- | --- |
| 主语义 | 确定性内容生成 | 观测当前 host/process/fs 状态 |
| host IO | **无** | 可能 process list / fs read |
| V1.31 dry-run | `plannedAction:'capture-state'` | 同左 |
| adapter 标志 | `processListReadAllowed` 等恒 false | real 化时需抬升 **只读** allow + timeout + argv allowlist + no shell |
| 双机/失败注入 | 本版不需要 | 若声称 observational real evidence，需更完整 evidence |
| 与“不要为了叫 real 就执行 host 命令” | **完全一致** | 容易滑向 host command |

### 0.5 Gold blockers / 远端双机证据历史（诚实消费边界）

#### Gold（`src/gold-readiness.js`）

- overall **blocked**
- `automation-installation` **partial**；nextStep 已指向：V1.31 之后应 **按 7 kind 注册 real handlers** + §4.5 六 locus + pre-dispatch 双闸
- V1.32 **只**诚实推进 **第一个** real implementation（render）；**不得**把 Gold 标 ready

#### G0a 双机（`docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md`）

| 事实 | 值 |
| --- | --- |
| overallStatus | `PASS`（**仅** G0a Keychain/LAN 边界） |
| sourceCommit | `10ffad69e6a3` |
| Gold overall | **仍 BLOCKED** |
| 是否 capability execute locus | **否** — V1.31 §4.5 dual-host evidence **不存在** 于 capability 层 |

**V1.32 消费规则：**

- G0a PASS **保持不变**；不改写报告
- **不得** 因 G0a PASS 置 `dual-host evidence recorded = true`（capability execute 公式项）
- **不得** 因 real render 声称 dual-host 已满足
- 本版 **不** 实际调用双机 / SSH / Keychain / 远端 harness

#### V1.31 §4.5 六证据 locus 现状

| locus | V1.31/V1.32 事实 |
| --- | --- |
| idempotency store | **不存在**；fingerprint 固定 null |
| real rollback anchor | false |
| persist audit sink | false |
| recovery / notify path | false |
| dual-host evidence（capability 侧） | **不存在** |
| failure-injection suite evidence | 生产无 inject；仅 harness 模拟 |

→ **完整 `executeCapabilityAuthorized` 公式在 V1.32 仍恒 false**。

### 0.6 `executionEligible` / execute 公式（权威；本版仍不可满足）

```text
executionEligible =
  ...全部上游 pure facts... &&
  realRunnerWiringReady &&          // 仍 false
  runnerWiringContractReady         // 仍 false

executeCapabilityAuthorized =
  mode==='execute' &&
  executeRequested &&
  policyDecision.authorized &&
  executionEligible 全项 &&
  各 real*ImplementationReady（全局/相关）&&
  realCapabilityImplementationsReady &&   // 全局；本版仍 false
  executeCapabilityRegistryReady &&       // 本版仍 false
  idempotency + rollback sink + audit sink + recovery/notify &&
  dual-host evidence recorded &&
  failure-injection suite evidence recorded &&
  handler.implementationClass ∈ REAL_IMPLEMENTATION_CLASSES &&
  handler.supportsModes includes 'execute'
```

**V1.32 结论：** 即便 real render handler 已注册并 proof 成功，**execute 仍必须 hard-deny**；验证 real handler 走 **direct internal proof**，**不**开放 execute。

---

## 1. 候选评估与选定

### 1.1 评估矩阵（最小安全优先）

| 准则 | render | status |
| --- | --- | --- |
| 无 host write | ✅ | ✅（若严格 read-only） |
| 无 host command / process | ✅ | ❌ 风险高 |
| 确定性 / 可哈希 | ✅ | 弱（依赖瞬时 host 状态） |
| 与 lifecycle install 第一 action 对齐 | ✅ 首位 | rollback 链 |
| 与现有 pure 渲染证据对齐 | ✅ agent generateLaunchdPlist | 无现成 pure capture |
| 证明“不是 dry-run stub”难度 | 低（hash/size） | 高（需真实观测物） |
| 是否迫使抬升 `*Allowed` | **否** | 可能 `processListReadAllowed` |
| 是否触发双机证据需求 | **否** | 若声称 host observational real，压力更大 |
| 安全 blast radius | **最小** | 中 |

### 1.2 选定

```text
V1.32 SELECTED_CAPABILITY = render
SELECTED_ACTION_ID        = render-launch-agent-plist
SELECTED_OPERATION        = install
```

**明确拒绝本版：**

- `status` real（留给未来 observational real；需 timeout/argv allowlist/no shell/双机或失败注入设计）
- `write` / `reload` / `rollback` real（host-mutating）
- `audit` / `notify` real（persist / external）
- 为了“叫 real”而 `spawn` / `launchctl` / `fs.write` / `child_process`

### 1.3 术语定义（强制；全文档与 API 语义以此为准）

| 术语 | 定义 | V1.32 对 render 的取值 |
| --- | --- | --- |
| **dry-run non-side-effect** | 仅模拟计划；无真实产物字段（无 content hash） | 仍保留 `dry-run-render` |
| **real implementation** | 真实执行 capability 语义并产生可验证产物（**真实产物，非 stub**）；**不必然** host 副作用；**与 host side effect 正交** | **是**（本版交付） |
| **host side effect** | 改变或读取 host 受控资源：fs mutate、launchctl、process list/control、network、audit persist、external notify | **否** |
| **`hostSideEffectOccurred`** | 本次调用是否发生 host side effect（与 “是否 real implementation” **正交**） | **false** |
| **`real-side-effect`（历史名）** | V1.31 预留的笼统类名；易与 host side effect 混淆 | **本版弃用为 render 的 class 名** |
| **`real-implementation`（本版 class）** | 诚实 class：真实实现，sideEffectClass 可 `none` | **render 使用** |
| **`real-side-effect`（未来 class）** | 专指 **会** host side effect 的 real handler（write/reload/…） | **本版不注册** |

**强制推论：**

```text
real implementation completed ⇏ hostSideEffectOccurred
real implementation completed ⇏ realRunnerWiringReady
real implementation completed ⇏ realCapabilityImplementationsReady（全局）
real implementation completed ⇏ executeCapabilityAuthorized
real implementation completed ⇏ executionEligible
```

**代码注释合同（实现必须写在 registry/handler 附近，中文或英文二选一但语义 exact）：**

```text
// real = 真实产物非 stub，与 host side effect 正交
// real implementation produces a verifiable artifact; hostSideEffectOccurred may still be false
```

---

## 2. 设计选择总览

| 组件 | V1.31 | V1.32 |
| --- | --- | --- |
| dry-run registry | 7 kinds dry-run | **保持** 7 kinds dry-run |
| real registry | 无 | **仅 render** real-implementation |
| bootstrap | `trustedBootstrapCapabilityRegistry` dry-run only | **扩展** 同函数：先 dry-run 全集，再注册 real render |
| invoke dry-run | 公共 API | **保持** |
| invoke execute | 单闸 hard-deny | **保持 hard-deny**（公式仍不满足；可加 pre-dispatch 重算记录但结果仍 deny） |
| real proof API | 无 | **新增** `invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof` |
| receipt kinds | dry-run / execute-denied | **+** `capability-real-implementation-receipt` |
| 局部 ready fact | 无 per-kind real | **`realRenderCapabilityImplementationReady:true`** |
| 全局 realCapabilityImplementationsReady | false | **false** |
| realRunnerWiringReady / executionEligible | false | **false** |
| wiring-missing | 仍在 | **仍在** |
| Gold | blocked | **blocked** |
| agent.js / server.js / package.json | 未改 | **默认禁止改** |
| 新 endpoint / CLI / Web button / request field | 无 | **无** |

### 字段命名（禁止混淆）

| 名称 | 类型 | V1.32 语义 |
| --- | --- | --- |
| `realRenderCapabilityImplementationReady` | **局部** fact | render real handler 已 trusted 注册且 proof 契约就绪 |
| `realCapabilityImplementationsReady` | **全局** | 全部 required real kinds 就绪；**恒 false** |
| `executeCapabilityRegistryReady` | 全局 execute 注册 | **恒 false**（无完整 execute 注册面） |
| `executeCapabilityAuthorized` | mode | **恒 false** |
| `hostSideEffectOccurred` | 调用结果 | real render proof **false** |
| `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` | gate | **恒 false** |
| `capability-real-implementation-receipt` | receiptKind | real render proof 回执；**NOT** execute receipt；**NOT** wiringPlanSeal |
| `capability-execute-receipt` | 未来 | **本版不得产出 completed execute** |
| Web `executionSentinel` | UI | **恒 blocked** |

**禁止别名：** `realWiringReady`、`renderReady`（含糊）、`capabilitySeal`、把 real-implementation-receipt 叫 `executionReceipt`。

---

## 3. Trusted bootstrap：双轨注册 + identity + mode + 第二闸

### 3.1 注册结构（module-private）

```text
dryRunCapabilityRegistry: Map<kind, {descriptor, handler}>   // 保持 7
realCapabilityRegistry:   Map<kind, {descriptor, handler}>   // V1.32 仅 'render'
```

**禁止** 用同一 Map 覆盖 dry-run（必须可同时证明 dry-run 与 real 并存）。
**禁止** export `registerCapability` / 接受 `options.handlers`。

### 3.2 Handler identity（exact）

#### Dry-run render（保持）

```js
{
  capabilityKind: 'render',
  capabilityId: 'dry-run-render',
  implementationClass: 'dry-run-non-side-effect',
  sideEffectClass: 'none',
  supportsModes: ['dry-run'],
  actionIds: ['render-launch-agent-plist'],
  realImplementationReady: false,
  // 全部 would* / *Allowed false
}
```

#### Real render（新增）

```js
{
  capabilityKind: 'render',
  capabilityId: 'real-render',
  implementationClass: 'real-implementation',   // NOT 'real-side-effect'
  sideEffectClass: 'none',
  supportsModes: ['real-proof'],                // 本版不含 'execute'
  actionIds: ['render-launch-agent-plist'],
  realImplementationReady: true,                // descriptor 级局部 true
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
  evidenceCode: 'capability-real-render-implementation-ready',
  blockerCode: null,
}
```

**identity 不变式：**

1. `capabilityId` 全局唯一：`dry-run-render` ≠ `real-render`
2. real descriptor **不得** 声明 `supportsModes` 含 `execute`（本版）
3. real descriptor **不得** 抬升任何 `*Allowed`
4. `implementationClass` 仅允许：`dry-run-non-side-effect` | `real-implementation`（本版）；未来 host-mutating 才引入 `real-side-effect`

### 3.3 Mode 支持矩阵

| mode | 谁可授权 | 调用 API | V1.32 结果 |
| --- | --- | --- | --- |
| `dry-run` | dry-run 公式（V1.31） | `invoke...DryRun` | 保持 dry-run receipt |
| `real-proof` | real-render 局部公式（§3.5） | `invoke...RealRenderProof` | real-implementation receipt |
| `execute` | 完整 §0.6 公式 | 经 DryRun 入口或未来 execute 入口 | **仍 denied**；不调 real handler |

**禁止** 把 `real-proof` 伪装成 `execute`。
**禁止** 公共 request 通过 `mode:'execute'` 触达 real render handler。

### 3.4 trustedBootstrap 算法（exact）

```text
function trustedBootstrapCapabilityRegistry():
  1. clear dryRunCapabilityRegistry + realCapabilityRegistry
  2. for kind in CAPABILITY_KIND_ALLOWLIST:
       register dry-run descriptor+handler (V1.31 语义不变)
  3. validate dry-run size==7 and all primary map kinds present
  4. build real-render descriptor (exact §3.2)
  5. validate:
       implementationClass === 'real-implementation'
       sideEffectClass === 'none'
       supportsModes exact ['real-proof']
       realImplementationReady === true
       all *Allowed / would* (except realImplementationReady) === false
       actionIds exact ['render-launch-agent-plist']
  6. realCapabilityRegistry.set('render', {descriptor, handler: createRealRenderHandler()})
  7. assert realCapabilityRegistry.size === 1
  8. assert !realCapabilityRegistry.has('status'|others)
```

失败 → registry incomplete；`realRenderCapabilityImplementationReady:false`；readiness blocked 或局部 fact false。

### 3.5 real-proof 授权公式（局部；≠ execute）

```text
realRenderProofAuthorized =
  request.mode === 'real-proof' &&
  request.capabilityKind === 'render' &&
  request.actionId === 'render-launch-agent-plist' &&
  request.operation === 'install' &&
  realRender registry entry exists &&
  entry.descriptor.implementationClass === 'real-implementation' &&
  entry.descriptor.sideEffectClass === 'none' &&
  entry.descriptor.supportsModes includes 'real-proof' &&
  entry.descriptor.realImplementationReady === true &&
  entry.descriptor.wouldMutateHost === false &&
  全部 *Allowed === false &&
  无 caller injection &&
  renderInput 通过 §4 exact schema 校验
```

**不要求：** `executeRequested`、`realRunnerWiringReady`、dual-host、idempotency store、audit sink。

### 3.6 execute 第二闸（文档 + 实现挂钩；结果仍 deny）

V1.31 = **单闸** hard-deny（无 real handler）。
V1.32 = 虽有 real render，但 **execute 完整公式仍不满足** → 行为：

```text
if (mode === 'execute') {
  // 闸 1：immediate structural deny（保持 V1.31 安全底线）
  // 闸 2（新增可观测）：computeExecuteCapabilityAuthorizedFullFormula()
  //   → 因 realCapabilityImplementationsReady/executeCapabilityRegistryReady/
  //     dual-host/idempotency/... 仍 false → authorized=false
  // 仍：不得调用 real 或 dry-run handler
  return capability-execute-denied-receipt
    primaryBlocker ∈ {
      capability-execute-hard-denied,
      capability-execute-prerequisites-incomplete
    }
    executeCapabilityAuthorized: false
    hostSideEffectOccurred: false
    // 可选诊断（plain, allowlisted）：executeFormulaSnapshot 仅 boolean 计数/缺项 codes
}
```

| 版本 | 闸门 | 说明 |
| --- | --- | --- |
| V1.31 | 单闸 | mode=execute → deny；无 real handler |
| V1.32 | **deny 保持** + **公式重算可观测** | 有 real render **也不** dispatch；第二闸证明“公式仍 false”而非“有 handler 就执行” |
| V1.33+ | 真双闸放行条件 | 仅当完整公式 true **且** handler supports execute **且** host policy 允许 |

**如何在不暴露 execute 的前提下验证 real handler：** 使用 §5 的 **RealRenderProof** API。

---

## 4. Real render：exact 输入 / 输出 / 确定性 / 安全

### 4.1 输入 schema（CapabilityRealRenderProofRequest；exact keys only）

```js
{
  capabilityKind: 'render',                 // required exact
  actionId: 'render-launch-agent-plist',    // required exact
  operation: 'install',                     // required exact
  mode: 'real-proof',                       // required exact
  idempotencyKey: null,                     // proof 允许 null；不得回显
  attemptRef: null | string,                // opaque
  anchorRef: null | string,                 // opaque evidence ref；非 path
  renderInput: {                            // required plain object；exact keys
    label: string,                          // 1..128；匹配 /^[A-Za-z0-9._-]+$/
    scheduleSeconds: number,                // integer 60..86400（含端点）
    programToken: string,                   // allowlisted token only；见 §4.4
    // 禁止 path / configPath / token / url / host / env
  },
}
```

**顶层 key whitelist（exact）：**

```text
capabilityKind, actionId, operation, mode, idempotencyKey,
attemptRef, anchorRef, renderInput
```

**`renderInput` key whitelist（exact）：**

```text
label, scheduleSeconds, programToken
```

#### 4.1.1 顶层 request exact snapshot（V1.31 §2.7 同构，仍强制）

顶层 `CapabilityRealRenderProofRequest` 必须走 **独立** exact whitelist extraction（与 V1.31 dry-run request 同一算法族）：

```text
1. 仅从顶层 allowlisted exact key 列表逐 key 读取；未知 key → fail-closed
2. 禁止 Object.assign / object spread / JSON.stringify+parse 作为清洗
3. 每个允许 key：Object.hasOwn(source, key) === true
   且 data-descriptor（desc.get/set === undefined）
4. 拒绝 '__proto__' | 'constructor' | 'prototype'
5. 拒绝 symbol keys（Object.getOwnPropertySymbols(source).length !== 0）
6. own string keys 必须 exact-equal 顶层 whitelist 集合
7. 拒绝 Proxy / accessor trap；function 值 fail-closed
8. 提取结果经 validated deep-copy 后再进入 authorize/invoke
```

#### 4.1.2 nested `renderInput` **独立** exact snapshot（**不得**只靠顶层 V1.31 snapshot）

> **P1 硬约束：** nested `renderInput` 必须作为 **第二层独立 snapshot 对象** 处理。
> 仅对顶层 request 做 V1.31 §2.7 提取 **不够**：`renderInput` 值本身若是 Proxy / 带 accessor / 含 extra/symbol/dangerous keys，必须在 **nested 层** 再次 fail-closed。

```text
function snapshotRenderInput(rawRenderInput): plainRenderInput | fail-closed
  前置：
    - rawRenderInput 必须是 plain object（typeof object && !== null && !Array.isArray）
    - 拒绝 function / null / primitive 作为 renderInput 本体

  对 nested 对象 rawRenderInput 独立执行（与顶层同算法，whitelist 不同）：
    1. own string keys exact-equal {label, scheduleSeconds, programToken}
    2. Object.getOwnPropertySymbols(rawRenderInput).length === 0
    3. 拒绝 dangerous keys：'__proto__' | 'constructor' | 'prototype'
    4. 对每个 allowlisted key：
         a. Object.hasOwn(rawRenderInput, key) === true
         b. data descriptor only（无 getter/setter）
         c. 禁止 function 值
         d. 禁止嵌套 object/array（本版三字段均为 primitive）
    5. 禁止 Object.assign / spread / JSON round-trip 清洗 nested
    6. 输出 = validated deep-copy 的 plain {label, scheduleSeconds, programToken}
       （仅 data-property 值；与输入对象无共享可变引用）

  类型合同（在 snapshot 之后、render 之前）：
    label:
      - typeof string
      - length 1..128 inclusive
      - 匹配 /^[A-Za-z0-9._-]+$/
      - 禁止 null byte / 任意 control char (U+0000..U+001F, U+007F)
      - empty("") / length 129 / unicode 字母(非 ASCII allowlist) → validation-failed
    scheduleSeconds:
      - typeof number && Number.isInteger(n) && !Object.is(n, -0) 可选：接受 +0 为 0 但 0 已越界
      - 60 <= n <= 86400 inclusive
      - 拒绝：59, 86401, NaN, Infinity, -Infinity, float(3600.5), string "3600"
    programToken:
      - typeof string && exact ∈ REAL_RENDER_PROGRAM_TOKENS
```

**错误归类（null / control / boundary）：**

| 条件 | outcomeCode |
| --- | --- |
| nested injection / extra / symbol / accessor / Proxy / function / dangerous keys | `capability-caller-injection-rejected` **或** `capability-real-render-validation-failed`（实现选一并锁定；**推荐** injection 类 → caller-injection-rejected，字段值非法 → validation-failed） |
| label empty / 129 / unicode 非 allowlist / null byte / control | **`capability-real-render-validation-failed`** |
| scheduleSeconds 59/86401/NaN/Infinity/float/非 integer | **`capability-real-render-validation-failed`** |
| programToken 非 allowlist | **`capability-real-render-validation-failed`** |

**禁止：** 依赖“顶层 snapshot 已通过”而直接 `renderInput.label` 读源对象；必须读 **nested snapshot 副本**。

### 4.2 输出 schema（receipt 扩展字段；plain only）

在 V1.31 `CapabilityReceipt` 基础上，real-implementation receipt **额外** 允许：

```js
{
  // ...基础 receipt 字段...
  receiptKind: 'capability-real-implementation-receipt',
  mode: 'real-proof',
  capabilityId: 'real-render',
  implementationClass: 'real-implementation',
  sideEffectClass: 'none',
  state: 'completed' | 'denied' | 'error',
  outcomeCode: 'capability-real-render-completed'
    | 'capability-real-render-validation-failed'
    | 'capability-real-render-redaction-failed'
    | /* 既有 validation/authorization codes */,
  hostSideEffectOccurred: false,
  realRenderCapabilityImplementationReady: true,  // 成功路径
  realCapabilityImplementationsReady: false,      // 全局仍 false
  executeCapabilityAuthorized: false,
  realRunnerWiringReady: false,
  runnerWiringContractReady: false,
  executionEligible: false,
  renderResult: {
    contentType: 'application/x-apple-plist-xml',
    templateId: 'code-owned-launch-agent-plist-v1',
    renderedByteLength: number,             // UTF-8 byte length；合同：>0 && <8192
    contentSha256: string,                  // 64 lowercase hex；基于 UTF-8 exact bytes
    deterministic: true,
    // 可选：redactedPreview — 仅结构标签计数，不得含 label 原文以外的敏感
    structureFingerprint: string,           // 对规范化结构的次级哈希或 fixed token
  },
  // 默认不回传全文 XML（防意外 path 泄漏进日志）；测试可走 internal recomputation
  // 若实现选择返回 content：必须先 redaction gate 且测试证明无 path/secret
  plannedAction: 'render-plist',
  idempotencyKeyFingerprint: null,          // 仍固定 null（idempotency store 未落地）
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
}
```

**禁止** receipt 含：raw path、hostname、username、pid、Authorization、token、env、function、Buffer、未脱敏 configPath。

### 4.3 Determinism / hash / size / 固定 renderer 字节规范

```text
canonicalPlist = pureRenderLaunchAgentPlistV1(snapshotRenderInput)  // code-owned
utf8Bytes          = UTF-8 encoding of canonicalPlist
renderedByteLength = utf8Bytes.byteLength
contentSha256      = sha256_hex(utf8Bytes)  // lowercase 64-hex；基于 UTF-8 exact bytes

合同：
  renderedByteLength > 0 && renderedByteLength < 8192
  同一 snapshot renderInput → 同一 utf8Bytes → 同一 hash/size
  不同 label/scheduleSeconds/programToken → 不同 hash（测试覆盖）
```

**确定性规则：**

1. 固定 XML prologue / 键序 / 缩进 / 换行（§4.3.2 exact）
2. 禁止依赖 `Date.now` / `Math.random` / env / cwd / hostname / locale
3. 禁止读取文件系统或配置文件（renderInput 已是 plain 入参）
4. 单元测试：连续两次 proof → hash 全等；独立 pure 重算 → hash 全等
5. **固定 golden 输入** → **exact sha256 字符串断言**（§4.3.3；非仅 “匹配 64-hex”）

#### 4.3.1 `xmlEscape` exact 映射（强制）

```text
xmlEscape 仅接受已通过 validation 的 string（无 null/control）。
对每个字符 **单次** 替换，映射 exact：

  &  →  &amp;
  <  →  &lt;
  >  →  &gt;
  "  →  &quot;
  '  →  &apos;

其它字符：原样保留（label allowlist 已限制为 [A-Za-z0-9._-]；
  但 xmlEscape 仍必须定义完整五字符映射，防止未来字段扩展漏逃逸）。

禁止：
  - double escape（不得把已是 &amp; 的序列再变成 &amp;amp;；
    推荐按字符迭代：遇五字符之一输出实体，否则 append 原字符）
  - 接受 null / undefined 并 String() 强转后渲染
  - 接受含 U+0000..U+001F / U+007F control 的字符串进入 escape
    （应在 validation 阶段已拒 → capability-real-render-validation-failed）
  - 用 HTML-only 子集漏掉 &apos; / &quot;
```

#### 4.3.2 固定 renderer 字节布局（锁定；实现不得漂移）

```text
编码: UTF-8
换行: Unix LF only (`\n` = U+000A)；禁止 `\r` / `\r\n`
trailing newline: **无** — 最后一行是 `</plist>`，其后 **不** 再追加 `\n`
  （锁定理由：与 agent.js generateLaunchdPlist 的 `.join('\n')` 语义一致；hash 依赖 exact bytes）
缩进: TAB `\t`（U+0009），不用空格
属性/声明/键序: 固定如下（不得重排、不得插注释、不得改 DOCTYPE 空格）
```

**Exact 模板骨架（tag/key 顺序锁定）：**

```text
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{xmlEscape(label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/env</string>
		<string>node</string>
		<string>__LINKE_REDACTED_PROGRAM_REF__</string>
		<string>run-once</string>
		<string>--config</string>
		<string>__LINKE_REDACTED_CONFIG_REF__</string>
	</array>
	<key>StartInterval</key>
	<integer>{scheduleSeconds decimal, no leading zeros, no exponent}</integer>
</dict>
</plist>
```

| 项 | 锁定值 |
| --- | --- |
| XML prologue | exact `<?xml version="1.0" encoding="UTF-8"?>` |
| DOCTYPE | exact Apple plist 1.0 行（上表） |
| 根元素 | `<plist version="1.0">` … `</plist>` |
| dict 键序 | **Label → ProgramArguments → StartInterval** |
| ProgramArguments 数组序 | env → node → redacted-program → run-once → --config → redacted-config |
| 缩进 | dict 子节点 1×TAB；array 子节点 2×TAB |
| 行分隔 | 仅 `\n`；**无** trailing newline |
| hash 输入 | UTF-8 exact bytes of 上述完整字符串 |

#### 4.3.3 Fixed-input golden sha256（exact 断言）

测试必须锁定 **一个** canonical golden fixture（推荐）：

```js
const GOLDEN_RENDER_INPUT = Object.freeze({
  label: 'com.linke.test.agent',
  scheduleSeconds: 3600,
  programToken: 'linke-agent-run-once',
});
// GOLDEN_CONTENT_SHA256 = 实现 GREEN 后写入的 64 lowercase hex
// assert.strictEqual(actual, GOLDEN_CONTENT_SHA256)  — exact 字符串全等
// 不得仅 assert.match(/^[a-f0-9]{64}$/)
```

**规则：**

1. pure renderer 与 proof invoke 对 golden 输入必须产出 **同一** `contentSha256` exact 字符串
2. 该 hex **写入测试常量** 并 `assert.strictEqual`；变更 template 字节 → 测试失败 → 显式更新常量（禁止 silent drift）
3. 另测：改 label → hash **不等于** golden
4. `renderedByteLength`：`> 0 && < 8192`，且对 golden 可锁定 exact size 常量（推荐）

#### 4.3.4 XML well-formed / plist 结构测试（无新依赖）

**不引入** `xml2js` / `fast-xml-parser` / `plist` 等新 npm 依赖（`package.json` 禁止改）。

本版采用 **现有 Node 能力 + 严格结构断言**（须写在测试注释）：

| 方法 | 做法 | 是否默认 |
| --- | --- | --- |
| A. exact multi-line string equality | golden 全文 `assert.strictEqual(rendered, GOLDEN_PLIST_XML)` | **推荐主路径** |
| B. 行数组结构断言 | `rendered.split('\n')` 与锁定行模板逐行 equal；断言无 `\r` | 可与 A 等价 |
| C. 轻量 tag-stack 自检 | 测试内小型开关标签匹配；**非**完整 XML 1.0 解析器 | 可选补充 |
| D. 键序/占位符断言 | Label/ProgramArguments/StartInterval 顺序 + redacted refs + 无真实 path 模式 | **必须** |

**明确非目标：** 完整 XML 规范校验、DTD 网络抓取、第三方 plist round-trip。

### 4.4 Template 来源（code-owned only）

```text
templateId = 'code-owned-launch-agent-plist-v1'
位置 = module-private pure function in src/supervisor-lifecycle.js
  （首选；避免新文件与 agent.js 改动）
```

**programToken allowlist（exact；映射到固定 ProgramArguments 模式，不嵌入用户 path）：**

| programToken | 语义（渲染进 plist 的固定 argv 模式） |
| --- | --- |
| `linke-agent-run-once` | `/usr/bin/env` + `node` + **redacted-program-ref** + `run-once` + `--config` + **redacted-config-ref** |

**禁止** programToken 自由字符串直通 XML。
**禁止** 把真实 filesystem path 写入 plist 内容；使用固定占位：

```text
__LINKE_REDACTED_PROGRAM_REF__
__LINKE_REDACTED_CONFIG_REF__
```

这与 capability 安全边界一致：**real render 证明“能生成合法结构内容”**，而不是复现 agent.js 写盘 dry-run 的 path 嵌入行为。

Label / StartInterval 来自 **nested snapshot 后** 的 `label` / `scheduleSeconds`（经 `xmlEscape` / decimal integer 格式化）。

### 4.5 禁止路径 / secret

| 禁止 | 处理 |
| --- | --- |
| 任何 filesystem path 字符串入参 | validation fail → error/denied |
| `~/`、`/Users/`、`/private/`、`\\` traversal | reject |
| `Authorization` / `token` / `password` / `secret` 键 | reject（顶层与 renderInput） |
| env 抬升 ready / 开关 execute | 禁止读取 |
| 调用 `writeFile` / `launchctl` / `child_process` / `process.binding` | 禁止；差分扫描 **host mutation call sites = 0** |
| 回显 raw idempotencyKey | 禁止；fingerprint 仍 null |

### 4.6 错误分类

| 条件 | state | errorClass | outcomeCode / primaryBlocker |
| --- | --- | --- | --- |
| extra keys / prototype pollution / nested injection / Proxy / accessor / symbol / function | denied/error | authorization/validation | `capability-caller-injection-rejected` |
| mode≠real-proof on proof API | denied | validation | `capability-mode-invalid` |
| kind/action/operation 不匹配 | error/denied | validation | `capability-action-unmapped` 等 |
| renderInput 字段非法（含 label empty/129/unicode、schedule 越界/NaN/Infinity/float、programToken 非 allowlist） | error | validation | **`capability-real-render-validation-failed`** |
| label/string 含 null byte 或 control chars（U+0000..U+001F, U+007F） | error | validation | **`capability-real-render-validation-failed`** |
| redaction 失败 | error | internal | `capability-real-render-redaction-failed` |
| registry 缺 real render | error | internal | `capability-registry-incomplete` |
| execute 入口 | denied | authorization | `capability-execute-hard-denied` / prerequisites-incomplete |

### 4.7 Idempotency

- proof 路径：**不**要求 idempotencyKey；允许 null
- **不**写入 idempotency store（store 仍不存在）
- `idempotencyKeyFingerprint` **固定 null**
- 真实 execute idempotency 仍属未来 §4.5 locus

### 4.8 如何证明不是 dry-run stub

| 证据 | dry-run render | real render proof |
| --- | --- | --- |
| `capabilityId` | `dry-run-render` | `real-render` |
| `implementationClass` | `dry-run-non-side-effect` | `real-implementation` |
| `receiptKind` | `capability-dry-run-receipt` | `capability-real-implementation-receipt` |
| `mode` | `dry-run` | `real-proof` |
| `renderResult.contentSha256` | **absent/null** | **64-hex present + golden exact 全等** |
| `renderResult.renderedByteLength` | absent | `> 0 && < 8192` |
| `plannedAction` only | 是 | 是（另加 renderResult） |
| 独立 pure 重算 hash | n/a | **必须匹配** |
| 改 label → hash 变 | n/a | **必须** |
| fixed golden sha256 | n/a | **exact 字符串断言** |
| XML/plist 结构 | n/a | golden 全文或行级结构断言（无新依赖） |
| `hostSideEffectOccurred` | false | false |

测试必须 **同请求** 调 dry-run 与 real-proof，断言 receiptKind/capabilityId/renderResult 差异，且两者 `hostSideEffectOccurred===false`、`realRunnerWiringReady===false`。

**代码注释（registry / real handler 附近 must）：** `real = 真实产物非 stub，与 host side effect 正交`。

---

## 5. Public / private API 表面

### 5.1 保持（V1.31）

```js
export function buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness()
export function resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(candidates, operation)
export function authorizeSupervisorLifecycleGuardedRunnerCapabilityMode(request)
export function invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(request)
```

### 5.2 新增（V1.32）

```js
/**
 * Fixed readiness extension: reports realRender local fact + global real still false.
 * May be folded into build...CapabilityInjectionReadiness fields rather than new export
 * if plan chooses single readiness object — either way fields are exact.
 */
// preferred: extend existing readiness object with:
//   realRenderCapabilityImplementationReady: true|false
//   realCapabilityImplementationsReady: false
//   executeCapabilityRegistryReady: false

/**
 * @internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint
 * Authorize real-proof mode for **render only**. Never authorizes execute.
 * Render-specific: do not reuse this API for future real kinds.
 */
export function authorizeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(request)

/**
 * @internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint
 * Invoke real **render** implementation proof. Never host side effect.
 * Never accepts mode execute. Never returns functions.
 * Render-specific proof API — future real kinds must not expand this function's
 * kind range; they require a separate proof API or a later generic framework.
 */
export function invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(request)
```

**JSDoc / contract 标记（强制，export 函数上方 exact 语义）：**

```text
@internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint
```

**Scope / 引用门禁：**

| 检查 | 要求 |
| --- | --- |
| `src/server.js` | **零** 对 `...RealRenderProof` 的 import/引用 |
| `src/agent.js` | **零** 对 `...RealRenderProof` 的 import/引用 |
| Web button / CLI flag / HTTP route | **禁止** 挂载 proof API |
| 允许引用 | `src/supervisor-lifecycle.js` 定义处 + `test/**` 单测 |

**拒绝 export：** `executeCapability`、`runCapability`、`dispatchRunner`、`registerCapability`、`invoke...Execute`。

#### 5.2.1 Proof API 为 **render-specific**（禁止未来 kind 复用扩范围）

```text
V1.32 RealRenderProof API 合同：
  - capabilityKind 仅 'render'
  - actionId 仅 'render-launch-agent-plist'
  - 不得通过放宽 kind allowlist 把 status/write/... 塞进同一函数

未来若 real-ize 其它 kind：
  - 必须新增独立 proof API（例如 ...RealStatusProof），或
  - 另开设计：通用 proof framework（新 design/spec；非本版偷偷扩参）
  - 禁止：在 RealRenderProof 上加 kind 分支“顺便证明”其它 capability
```

### 5.3 Readiness 扩展字段（exact 增量）

```js
{
  // ...V1.31 fields...
  realRenderCapabilityImplementationReady: true,  // 当 bootstrap 成功
  realCapabilityImplementationsReady: false,      // 全局恒 false
  executeCapabilityRegistryReady: false,
  executeCapabilityAuthorized: false,
  realRunnerWiringReady: false,
  // entries 可增加 real-render entry（plain descriptor 摘要，无 handler）
  realImplementationEntries: [
    {
      capabilityKind: 'render',
      capabilityId: 'real-render',
      implementationClass: 'real-implementation',
      sideEffectClass: 'none',
      supportsModes: ['real-proof'],
      realImplementationReady: true,
      hostSideEffectOccurred: false,
      evidenceCode: 'capability-real-render-implementation-ready',
    },
  ],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
}
```

### 5.4 Gate 集成

在 `buildSupervisorLifecycleGuardedRunnerExecutionGate`：

1. **忽略** options 对 realRender / realCapability / execute 的覆盖
2. 本地：

```js
const realRenderCapabilityImplementationReady =
  capabilityInjectionReadiness?.realRenderCapabilityImplementationReady === true &&
  /* registry private probe via readiness only */ true;

// 全局仍强制：
realCapabilityImplementationsReady: false
executeCapabilityAuthorized: false
executionEligible: false
realRunnerWiringReady: false
runnerWiringContractReady: false
nextBlockers: ['real-guarded-runner-execution-wiring-missing']
```

3. `gates.capabilityInjectionReady` 谓词 **必须继续要求**
   `realCapabilityImplementationsReady === false` 与 `executeCapabilityAuthorized === false`
   （与 V1.31 一致；**不得**因 local real render 把全局 real 改 true 后弄崩 gate ready）
4. 可选：gate 附带 **sanitized** `realRenderProofSummary`（仅 capabilityId/hash-present boolean/byteLength；**非**全文）
5. **不**把 `realRenderCapabilityImplementationReady` 加入 `POLICY_FACT_KEYS`

### 5.5 Decision mappings 增量

install resolve 时，`render-launch-agent-plist` mapping 可增加：

```js
{
  actionId: 'render-launch-agent-plist',
  primaryCapabilityKind: 'render',
  capabilityId: 'dry-run-render',           // dry-run 映射保持
  realCapabilityId: 'real-render',         // 新增 plain 字段
  implementationClass: 'dry-run-non-side-effect',
  realImplementationClass: 'real-implementation',
  supportsModes: ['dry-run'],
  realSupportsModes: ['real-proof'],
  realRenderCapabilityImplementationReady: true,
  hostSideEffectOccurred: false,
  wouldExecute: false,
}
```

---

## 6. 若未来选 status：权限合同（本版不实现、不调用）

> 设计阶段记录；**V1.32 不实现、不调用、不注册 real status。**

| 项 | 合同 |
| --- | --- |
| 权限 | 仅 process list **read** / 指定 metadata **read**；无 write |
| timeout | 硬超时（建议 ≤ 500ms）fail-closed → `capability-timeout`（未来） |
| command argv allowlist | 若必须 spawn：仅 `['/bin/ps', ...固定 args]` 或优先 **无 spawn** 的 `process` API；**no shell**、无 `sh -c` |
| no shell | 禁止 `shell:true`、禁止字符串拼接 command |
| 双机证据 | 若声称 host observational real 用于 execute 抬升，需 capability 侧 dual-host recorder（**独立于** G0a PASS 报告） |
| 失败注入 | partial/timeout harness + 生产不可达 |
| 本版 | **全部不落地** |

---

## 7. 哪些 fact 可 true / 必须 false

### 7.1 可 true（局部 / 既有 pure）

| Fact | V1.32 |
| --- | --- |
| `pureCapabilityInjectionReady` | true |
| `dryRunCapabilityRegistryReady` | true |
| `gates.capabilityInjectionReady`（合法 path） | true |
| dry-run authorize / dry-run receipt completed | 可 true |
| **`realRenderCapabilityImplementationReady`** | **true** |
| real-proof authorize / real-implementation receipt completed | 可 true |
| `pureWiringOrchestratorPlanReady` / wiringPlan planned / seal-ready | 保持 |
| wiring `readyCount/blockedCount` | **6/0** |
| policy ready path authorized | 保持 |

### 7.2 必须 false / blocked

| Fact | V1.32 |
| --- | --- |
| `realCapabilityImplementationsReady`（全局） | **false** |
| `executeCapabilityRegistryReady` | **false** |
| `executeCapabilityAuthorized` | **false** |
| `realRunnerWiringReady` / `runnerWiringContractReady` | **false** |
| `executionEligible` / `wouldExecute` / `wouldRun` / `wouldWrite` | **false** |
| 全部既有 `real*ImplementationReady`（mutation/anchor/audit/recovery/runner） | **false** |
| 全部 side-effect `*Allowed` | **false** |
| `hostSideEffectOccurred` | **false**（含 real render） |
| `realStatusCapabilityImplementationReady` 等其它 per-kind | **absent/false** |
| wiring aggregate `state` | **blocked** |
| `real-guarded-runner-execution-wiring-missing` | **仍在** |
| Gold | **blocked** |
| Web `executionSentinel` | **blocked** |
| §4.5 六 locus | **不存在/false** |

---

## 8. API / CLI / Web 清晰语义

### 8.1 Policy

- **不**扩展 `POLICY_FACT_KEYS`
- ready path 继续 authorized / primary null
- authorize ≠ execution ready 继续由 `executionEligible:false` + wiring-missing + `executionSentinel` 表达

### 8.2 API / CLI

- **不**新增 endpoint、CLI command、request body field
- 既有 gate JSON **自然包含** readiness 增量字段 / decision 增量
- real-proof **仅** 作为 pure export + unit test / 内部 proof 调用；**不**挂 Web button、**不**挂 agent 子命令
- **无** `--execute-capability` / `--real-render` CLI 旗标（本版）

### 8.3 Web（方案 A + 增量 shall 行）

**必须保持：**

```text
policyDecision:state:authorized:...:primaryBlocker:none
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing
wiringPlan:state:planned:planReady:true:realRunnerWiringReady:false:mode:plan-only:blocker:none
wiringPlanSeal:state:seal-ready:sealReady:true:realRunnerWiringReady:false:blocker:none
capabilityInjection:state:resolved:dryRunReady:true:executeReady:false:realRunnerWiringReady:false:blocker:none
```

**必须新增（shall）** 局部 real render 行（canonical、不回显 hash 全文除非已有 sanitized 字段策略；推荐仅 boolean）：

```text
realRenderCapability:state:ready:realRenderReady:true:hostSideEffectOccurred:false:realCapabilityImplementationsReady:false:realRunnerWiringReady:false:blocker:none
```

`validationLines` **必须**含：

```text
realRenderCapabilityImplementationReady:true|false
realCapabilityImplementationsReady:false
executeCapabilityAuthorized:false
hostSideEffectOccurred:false
realRunnerWiringReady:false
runnerWiringContractReady:false
executionEligible:false
```

**禁止** 因 realRender ready 删除 `executionSentinel`。
**禁止** 把 real-implementation-receipt 渲染为 execute completed 或 wiringPlanSeal。

---

## 9. Scope

### 9.1 允许修改（实现阶段）

| 文件 | 变更 |
| --- | --- |
| `src/supervisor-lifecycle.js` | real render registry / pure renderer / authorize+invoke proof / readiness+gate 字段 / execute 公式重算可观测 deny |
| `src/web/app.js` | realRender 固定行 + validationLines（无新 button） |
| `src/gold-readiness.js` | evidence + nextStep 指向 V1.32 first real render；仍 blocked |
| `src/version.js` | → `V1.32` |
| `README.md` | 版本条 + 边界措辞 |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | pure + gate TDD |
| `test/web-console.test.js` | realRender 行 + sentinel 保持 |
| `test/gold-readiness.test.js` | evidence / nextStep |
| 既有 gate API/CLI 透传测试 | 仅断言扩展 |

### 9.2 明确禁止

| 文件 / 行为 | 状态 |
| --- | --- |
| `src/agent.js` / `src/server.js` / `package.json` | **默认禁止改** |
| 新增 endpoint / CLI command / Web button / request field | **禁止** |
| server.js / agent.js 引用 `...RealRenderProof` | **禁止**（scope 扫描 = 0 hits） |
| 将 RealRenderProof API 扩 kind 范围复用 | **禁止**（须独立 proof API / 通用 framework 另设计） |
| launchctl / shell / fs write / process list / network / NAS / audit persist / notify send | **禁止**；差分 **host mutation call sites = 0** |
| 置 `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` / 全局 `realCapabilityImplementationsReady` / `executeCapabilityAuthorized` true | **禁止** |
| 消解 `real-guarded-runner-execution-wiring-missing` | **禁止** |
| 公共 `registerCapability` / options handlers 注入 | **禁止** |
| 产出 completed `capability-execute-receipt` | **禁止** |
| 改写 G0a 报告为 capability dual-host locus | **禁止** |
| 实现 real status/write/reload/... | **禁止** |

### 9.3 本设计/计划阶段允许写入

仅：

- `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-first-real-capability-handler-design.md`
- `docs/superpowers/plans/2026-07-14-supervisor-lifecycle-first-real-capability-handler.md`

---

## 10. TDD 矩阵（实现阶段）

| # | 场景 | 期望 |
| --- | --- | --- |
| T1 | readiness：realRender true + 全局 real false | nextBlockers wiring-missing |
| T2 | bootstrap：dry-run 7 + real render 1 并存 | capabilityId 不同 |
| T3 | dry-run render 仍 completed 且无 contentSha256 | 回归 V1.31 |
| T4 | real-proof happy path | receiptKind real-implementation；hash 64-hex；`renderedByteLength > 0 && < 8192`；hostSideEffect false |
| T5 | 确定性：两次 proof hash 相等；pure 重算匹配 | deterministic true |
| T6 | 改 label/schedule/programToken → hash 变 | 非 stub 常量 |
| T7 | dry-run vs real-proof 同 action 对照 | kind/id/result 字段可区分 |
| T8 | execute 仍 denied；不调 real handler | executeCapabilityAuthorized false |
| T9 | execute 公式重算可观测缺项 | 含全局 real/dual-host 等 false codes（allowlisted） |
| T10 | 顶层 caller injection / path / secret keys | reject（caller-injection） |
| T11 | **nested** `renderInput` extra keys / dangerous keys | fail-closed；**独立** nested snapshot（非仅顶层） |
| T12 | programToken 非 allowlist | `capability-real-render-validation-failed` |
| T13 | gate production ready | realRender local true；executionEligible false；wiring-missing；6/0 |
| T14 | options override realRender/execute/realRunner | **忽略** |
| T15 | Web ready path | sentinel blocked + shall realRender 行 |
| T16 | Gold | blocked；evidence 含 V1.32 real render；全局 real false |
| T17 | 差分 host mutation | 相对 3cf4848：**host mutation call sites = 0**（pass threshold） |
| T18 | 不改 agent/server/package；server/agent **零** RealRenderProof 引用 | scope check |
| T19 | 敏感扫描 | category hit counts only；无 path/token 回显 |
| T20 | status/write/reload 无 real registry entry | 保持 dry-run only |
| T21 | **golden sha256 exact** | fixed input → `assert.strictEqual(contentSha256, GOLDEN_…)` |
| T22 | **byte contract** | UTF-8；仅 `\n`；无 trailing newline；prologue/键序/TAB 缩进锁定；无 `\r` |
| T23 | **xmlEscape 映射** | `& < > " '` 五字符 exact；无 double-escape 路径 |
| T24 | label boundary fuzz | empty / len128 accept / len129 reject / unicode reject / null-byte / control → **validation-failed** |
| T25 | scheduleSeconds boundary fuzz | 59 reject / 60 accept / 86400 accept / 86401 reject / NaN / Infinity / float → **validation-failed** |
| T26 | nested injection fuzz | nested accessor / Proxy / symbol / function / extra key → reject（独立 snapshot） |
| T27 | XML/plist 结构 | golden 全文或行级结构 + 键序/redacted refs；**无新依赖** |
| T28 | proof API JSDoc `@internal PROOF ONLY` 存在；render-specific 不扩 kind | 源码注释/合同扫描或人工 checklist |
| T29 | 代码注释 `real=真实产物非stub，与host side effect正交` | registry/handler 附近存在 |

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

### Side-effect / sensitive scan（相对 3cf4848）

- 仅 category hit counts
- **Pass threshold（强制）：host mutation call sites = 0**
  - 扫描类别：`launchctl` / `child_process` / `execFile` / `spawn` / `writeFile` / `process.kill` / `net.` / `fetch(` 等
  - 本版 real render 路径与 `src/supervisor-lifecycle.js` 差分：**新增 host mutation 调用点必须为 0**
- scope 仅 §9.1
- server/agent 对 `RealRenderProof` 引用 hits = 0

### 恢复锚点

- **commit：** `3cf4848`
- **信息：** `feat: add V1.31 runner capability injection`
- 越界时：丢弃工作区改动，回到该锚点干净树后按 plan 重做
- **禁止**把 `git reset --hard` 写进常规实施步骤清单

---

## 12. 安全与非目标

### 安全

- 无 secret / token / Authorization / path / URL / hostname / username / pid / raw idempotency key 回显
- 恶意 fixture 仅 opaque synthetic 字符串
- §2.7 prototype 防护 + structuredClone/validated deep copy
- 不读 env 作为执行开关抬升 real wiring / execute
- handlers 永不进入 JSON
- real render **无** host IO

### 非目标（V1.32）

- real status / write / reload / rollback / audit / notify
- host side effect 任何形式
- `realRunnerWiringReady=true` / `executionEligible=true`
- 全局 `realCapabilityImplementationsReady=true`
- 消解 wiring-missing
- 完整 §4.5 六 locus 落地
- 开放 public execute 成功路径
- 新增 endpoint / CLI / Web button
- 修改 agent.js / server.js / package.json
- Gold ready / 改写 G0a 为 capability dual-host

### 下一步（显式非本版）

1. 下一个最小 real implementation 候选评估（可能仍非 status；或 status read-only 专项设计）
2. §4.5 loci 按 schema owner 逐个落地
3. 当且仅当完整公式可满足 → execute 双闸放行（仍 fail-closed）
4. 谓词化 `realRunnerWiringReady` / `runnerWiringContractReady`
5. 并行 Gold：NAS / auth / hardening / G4–G7

---

## 13. 完成标准（实现阶段验收）

1. 选定 **render**；术语 **real implementation vs host side effect 正交**；代码注释含 **`real=真实产物非stub，与host side effect正交`**；与 README 一致
2. trusted bootstrap **同时**注册 7 dry-run + 1 real render；identity/mode 正确
3. real-proof API 产出 `capability-real-implementation-receipt` + contentSha256/size；`hostSideEffectOccurred:false`；`renderedByteLength > 0 && < 8192`
4. 测试证明 **不是** dry-run stub（对照 + 确定性 + **golden sha256 exact** + 输入敏感 hash + XML/plist 结构断言）
5. execute 仍 hard-deny；可选公式缺项可观测；**不**调 real handler
6. **仅** `realRenderCapabilityImplementationReady` 可 true；全局 real / wiring / execution / Gold 边界保持
7. Web shall realRender 行 + executionSentinel 恒 blocked
8. 无 agent.js / server.js / package.json 变更；**server/agent 零引用** proof API
9. **host mutation call sites = 0**；敏感扫描 category counts only 通过
10. 恢复锚点 `3cf4848` 文档化
11. **不**宣称 Gold 发布或 real runner wiring 完成
12. nested `renderInput` **独立** exact snapshot（Object.hasOwn + data descriptor + reject symbol/dangerous/extra/getter/function/proxy + validated deep-copy）
13. export proof 函数带 **`@internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint`**；API **render-specific**，未来 kind 不得扩范围复用
14. 固定 renderer 字节规范（UTF-8 prologue、`\n` only、无 trailing newline、TAB 缩进、键序）+ `xmlEscape` 五字符 exact；null/control → **validation-failed**
15. TDD 覆盖 T1–T29（含 fuzz/boundary T24–T26、golden T21、结构 T27）

---

## 14. 问题对照表（设计必须回答）

| # | 问题 | 答案 |
| --- | --- | --- |
| 1 | real implementation vs host side effect | §1.3；render real 且 hostSideEffectOccurred=false；不得抬升 realRunnerWiringReady / 全局 realCapabilityImplementationsReady |
| 2 | bootstrap 双轨、identity、mode、execute 第二闸与 proof | §3；execute 公式仍不满足 → proof API §5 |
| 3 | render exact I/O / nested snapshot / xmlEscape / 字节规范 / golden hash / 非 stub 证明 | §4（含 §4.1.2 / §4.3.x） |
| 4 | 若 host read/process | §6 仅未来 status 合同；本版不调用 |
| 5 | 局部 fact true / 其余 false；API/CLI/Web 语义 | §7–§8 |
| 6 | scope / TDD T1–T29 / host mutation=0 / 锚点 3cf4848；默认不改 agent/server/package | §9–§11 |
| 7 | proof API @internal + render-specific 不扩 kind | §5.2 / §5.2.1 |

---

## Key Decisions

1. **选 render 而非 status** — 最小安全、确定性、无 host command；status 需 read allowlist/timeout，本版不做。
2. **class 名用 `real-implementation` 而非 `real-side-effect`** — 避免把“真实实现”偷换成“host 副作用”；**real=真实产物非stub，与host side effect正交**。
3. **mode `real-proof` 与 `execute` 分离** — 完整 execute 公式仍不可满足时，仍能诚实验证 real handler。
4. **全局 `realCapabilityImplementationsReady` 保持 false** — 只有 1/7 kind real，禁止用局部成功冒充全局 ready。
5. **plist 使用 redacted program/config ref** — 证明结构渲染能力，不把真实 path 引入 capability 回执。
6. **默认不改 agent.js** — pure renderer 落在 `supervisor-lifecycle.js`；不调用 `writeLaunchdDryRun`。
7. **G0a PASS 不计入 capability dual-host locus** — 防止错误抬升 execute 公式。
8. **保持 wiring-missing 与 executionSentinel** — real render ≠ real runner wiring。
9. **nested `renderInput` 独立 exact snapshot** — 不得只靠顶层 V1.31 snapshot。
10. **RealRenderProof 为 render-specific** — 未来 real kind 须独立 proof API 或另设计通用 framework，禁止扩 kind 复用。
11. **trailing newline = 无**；换行仅 `\n`；hash 基于 UTF-8 exact bytes；golden sha256 exact 断言。
12. **XML 结构测试无新依赖** — golden 全文/行级结构断言；host mutation call sites pass threshold = 0。

---

## Open Questions

无阻塞性问题。下列为已在设计内关闭的默认选择（实现不得擅自反转）：

- real-proof **不**挂 CLI/Web button（仅 pure API + tests）；export 标 `@internal PROOF ONLY`
- readiness **扩展现有 builder 字段**，不强制新 endpoint
- 默认 **不返回** 全文 plist，只返回 hash/size/structureFingerprint
- trailing newline：**无**；null/control → **validation-failed**
- nested injection 推荐 outcome：`capability-caller-injection-rejected`；字段值非法：`capability-real-render-validation-failed`

---

## 实现后报告模板（给 agent；与 plan 同步）

```text
V1.32 实现完成（first real capability handler = render only）

基线锚点: 3cf4848
版本: V1.32

变更文件:
- （仅列实现阶段实际 diff 路径；须 ⊆ §9.1）

事实矩阵:
- readyCount/blockedCount: 6/0
- realRenderCapabilityImplementationReady: true
- realCapabilityImplementationsReady: false（全局）
- executeCapabilityAuthorized: false
- realRunnerWiringReady / runnerWiringContractReady / executionEligible: false
- hostSideEffectOccurred: false（含 real-proof）
- nextBlockers: [real-guarded-runner-execution-wiring-missing]
- receiptKind: capability-real-implementation-receipt（NOT execute / NOT wiringPlanSeal）
- renderedByteLength: >0 && <8192
- golden contentSha256: exact 断言通过
- nested renderInput independent snapshot: 已测
- proof API: @internal PROOF ONLY；render-specific；server/agent 引用=0
- xmlEscape 五字符 + 字节规范（UTF-8 / LF-only / 无 trailing newline）: 锁定
- XML/plist 结构断言: 无新依赖
- policy ready path: authorized / primary null
- executionSentinel: blocked
- Web realRender 行: present (shall)
- Gold: blocked

TDD: T1–T29 PASS/FAIL 摘要

测试:
- focused: PASS/FAIL
- full: PASS/FAIL

scope check: agent.js/server.js/package.json 未改；RealRenderProof 引用 server/agent=0
side-effect scan: host mutation call sites = 0（pass threshold）
敏感扫描: category counts only

下一步（非本版）:
- 下一 real kind：独立 proof API 或通用 framework（禁止扩 RealRenderProof kind）
- §4.5 loci / execute 双闸 / realRunnerWiringReady 谓词化
```

---

## PR Plan

### PR1 — V1.32 design/plan docs only

- **Files:** 本 spec + 对应 plan
- **Deps:** none
- **Description:** 文档落地；无源码；关闭 Qwen P1×6 + P2×5

### PR2 — Real render registry + proof API + tests

- **Files:** `src/supervisor-lifecycle.js`, gate tests
- **Deps:** PR1
- **Description:** bootstrap 双轨、pure renderer（字节规范/xmlEscape）、nested snapshot、authorize/invoke proof（@internal）、execute deny+公式快照、T1–T14/T17–T29

### PR3 — Web + Gold + version/README

- **Files:** `src/web/app.js`, `src/gold-readiness.js`, `src/version.js`, `README.md`, web/gold tests
- **Deps:** PR2
- **Description:** shall 行、validationLines、scorecard evidence、版本 V1.32；sentinel/Gold blocked 保持

> 实施时可合并 PR2+PR3 为单提交 `feat: add V1.32 first real render capability handler`，但审查粒度按上表。
