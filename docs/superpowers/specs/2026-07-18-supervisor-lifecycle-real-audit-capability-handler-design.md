# V1.34 Supervisor Lifecycle Real Audit Capability Handler Design

## 目标

V1.34 在 **V1.33 second real status capability** 基线之上，交付**第三个诚实 real implementation handler**：`capabilityKind=audit`（cross-cutting），语义为 **real-proof capability audit persist**（向 **独立** append-only sink 写入固定 canonical event 行），**不是** HTTP `events.jsonl` 复用，**不是** T6d.3 audit-chain-integrity 完成，**不是** M6d Exit，**不是** production-hardening ready，**不是** execute/wiring/global real 抬升。

> **选定能力：`audit`（cross-cutting kind；operation=`install|uninstall|rollback|recover`；actionId ∈ `buildLifecycleActions(operation)`）**
> 作为 **real audit-persist implementation**（真实 sink append + sync + fingerprint 可验证产物），
> 成功路径：`hostSideEffectOccurred:true`、`hostMutationOccurred:true`、`auditPersistOccurred:true`、`mutationOutcome:'persisted'`。
> 局部 fact 仅 `realAuditCapabilityImplementationReady:true`；全局 real / execute / wiring / Gold **保持 false/blocked**。

本版建立：

1. **第三个 local real capability = audit**；real registry **2/7 → 3/7**（render / status / audit）
2. **独立 @internal PROOF ONLY RealAuditProof API**（不扩 RealRenderProof / RealStatusProof；不引入 generic multi-kind framework）
3. **独立 sink module**（后续实现 `src/capability-audit-sink.js`；固定相对路径 `audit/capability-proof-attempts.jsonl`）
4. **fail-closed existing-file + reentry/concurrency + fingerprint/canonical event** 合同
5. **full receipt truth** 与 mutationOutcome 三态；Gate/Web 仅 non-live readiness
6. **V1.x audit milestone 诚实版本叙事**（可升 V1.34；Gold 仍 4/4/1/9 blocked；M7 前 overall Gold blocked）
7. **M1 Exit audit temporal snapshot 兼容**：不改写 2026-07-18/`47dcc2d` 历史 V1.33 记录

### 关键边界（必须先读）

| 层级 | V1.34 是否完成 | 含义 |
| --- | --- | --- |
| **third real implementation handler (`audit`)** | **是（本设计目标）** | 独立 sink append-only API behavior；canonical event + fingerprint |
| **first real render（V1.32）** | **保持** | 不回归；不扩 RealRenderProof |
| **second real status（V1.33）** | **保持** | 不回归；不扩 RealStatusProof |
| **dry-run registry（7 kinds）** | **保持** | dry-run 路径不变；dry-run `audit` 仍为 plan-only |
| **`realAuditCapabilityImplementationReady`** | **可 true** | **仅** audit 局部 fact |
| **`realRender*` / `realStatus*`** | **保持 true** | 既有局部 fact |
| **`realCapabilityImplementationsReady`（全局）** | **否** | 仅 3/7 real；**恒 false**（独立事实） |
| **`executeCapabilityRegistryReady` / `executeCapabilityAuthorized`** | **否** | 完整 execute 公式仍不满足；execute **仍 hard-deny 且零 dispatch** |
| **`realAttemptAuditImplementationReady`** | **否** | attempt-audit pure plan / future execute wiring **不**因本版 true |
| **`realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible`** | **否** | **禁止**因本版变 true |
| **T6d.3 audit-chain-integrity** | **否** | 本版是 **M6d-prep 独立预备增量**，**不是** T6d.3 完成 |
| **M6d Exit / production-hardening ready** | **否** | 不使 M6d Exit；不把 production-hardening 标 ready |
| **T1.0 / M1 crypto / M2 / cross-LAN** | **否** | 完全不依赖、不进入 |
| **Gold / GA / V2.0** | **否** | scorecard 继续 `blocked`；**仅 M7** 在 10/10 + 全真实证据 + 用户批准时升 V2.0 |
| **HTTP/CLI/Web proof endpoint/button/request field** | **否** | 无 public surface；server/agent **零引用** proof API |
| **新 dependency** | **否** | 不新增 package |

**严禁**把 real audit proof completed、`realAuditCapabilityImplementationReady:true`、独立 sink 成功写入、或 gate non-live readiness 冒充：

- `realCapabilityImplementationsReady:true`（全局）
- `realAttemptAuditImplementationReady:true`
- `realRunnerWiringReady:true` / `runnerWiringContractReady:true`
- `executionEligible:true` / `executeCapabilityAuthorized:true`
- T6d.3 audit-chain-integrity complete / M6d Exit / production-hardening ready
- Gold ready / GA ready / V2.0 / cross-LAN / dual-host / execute wiring
- immutable / WORM / tamper-proof / production-grade audit / durability chronology / rotation / retention 完成

**角色结论（文档阶段历史）：** GLM round1 因直接复用 `events.jsonl` / 递归 / 确定性问题 **BLOCKED**；PM 修订后 GLM round2 **`PROCEED`（无 P0）**。本任务 **仅 docs**；docs 通过 fresh review/PM 后才进 TDD 代码。**`PROCEED` ≠ 实现完成。**

**恢复锚点（实现阶段）：** 实现前 clean tree HEAD（docs 合入后的 commit；当前 worktree 基线含 M1 Exit audit 文档记录）。实现越界时回到该锚点干净状态再重做（**禁止**把 `git reset --hard` 写为常规步骤）。

---

## 0. 源码事实基线（V1.33 + M1 Exit audit，不得猜）

以下全部来自当前 `src/supervisor-lifecycle.js` / `src/safe-data-files.js` / `src/audit-log.js` / `src/version.js` / `src/gold-readiness.js` / 相关 tests / V1.32–V1.33 specs / V2 Gold plan / M1 Exit audit。

### 0.1 V1.32 / V1.33 已完成与仍 blocked

| 项 | 当前事实 |
| --- | --- |
| capability kinds allowlist | `render \| write \| reload \| status \| rollback \| audit \| notify` |
| dry-run registry | 7 kinds；`implementationClass:'dry-run-non-side-effect'`；`supportsModes:['dry-run']` |
| real registry | **render + status**；size **2**；**无** real `audit` |
| RealRenderProof | `authorize...RealRenderProof` / `invoke...RealRenderProof`；sync；server/agent 零引用 |
| RealStatusProof | `authorize...RealStatusProof` / `invoke...RealStatusProof`；async；server/agent 零引用 |
| execute 路径 | hard-deny；**不** dispatch real 或 dry-run handler |
| `realRenderCapabilityImplementationReady` | **true**（局部） |
| `realStatusCapabilityImplementationReady` | **true**（局部） |
| `realCapabilityImplementationsReady` | **false**（全局；2/7） |
| `executeCapabilityAuthorized` | **false** |
| `idempotencyKeyFingerprint` | 生产 **固定 null**；idempotency store **不存在** |
| `realAttemptAuditImplementationReady` | **false**；attempt-audit 仅 pure plan |
| wiring aggregate | `readyCount:6` / `blockedCount:0` / `state:'blocked'` + wiring-missing |
| `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` | **false** |
| Web | realRender + realStatus non-live 行 + `executionSentinel` 恒 blocked |
| Gold | **blocked**；**9 items**；**4 ready / 4 partial / 1 blocked**；**无** `cross-lan-connectivity` |
| 版本 | `LINKE_RELEASE_VERSION = 'V1.33'`（实现前；本版计划可升 `V1.34`） |
| RealRender/StatusProof 扩 kind | **明确禁止**；须独立 proof API |

### 0.2 operation / action IDs 唯一 SoT（方案 A，写死）

**唯一权威 pure shared module（后续实现新建）：** `src/supervisor-lifecycle-actions.js`

该模块 **不** import lifecycle、**不** import sink，作为 operation/action ID 的 **唯一 SoT**，至少导出：

```js
// frozen operation → actionIds map（顺序稳定；Object.freeze 深冻结）
export const SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS /* frozen map */;

export function isSupervisorLifecycleOperation(value) // boolean
export function listSupervisorLifecycleActionIds(operation) // 安全 copy；非法 operation → []
export function isSupervisorLifecycleActionForOperation(operation, actionId) // boolean
```

冻结 map 内容（与当前 lifecycle 行为字节级一致）：

```text
install:
  render-launch-agent-plist
  write-launch-agent-plist
  load-launch-agent

uninstall:
  unload-launch-agent
  remove-launch-agent-plist
  remove-supervisor-metadata

rollback:
  capture-current-state
  restore-previous-plist
  restart-previous-supervisor

recover:
  start-recovery-supervisor
```

**消费规则（强制）：**

| 消费者 | 规则 |
| --- | --- |
| `src/supervisor-lifecycle.js` | **必须** import/消费此 SoT。`ALLOWED_OPERATIONS` **从 shared operations 派生**；本地 `buildLifecycleActions(operation)` **只**给 shared action IDs 配既有 `description` / `status` / `would*` 字段，**不得**再保留第二份 action ID list |
| `src/capability-audit-sink.js` | **必须** import `isSupervisorLifecycleActionForOperation`（及所需 operation 校验）；在 **唯一** per-root queue 内对 **existing + incoming** event 做 operation/action 一致性校验 |
| 禁止 | lifecycle 与 sink 互为权威；sink 自建第二份 action allowlist；任何“只信 lifecycle 校验 / sink 对 schema 无关”的冲突表述 |

**无 ESM cycle：** shared pure module import **neither** lifecycle **nor** sink。

**回归：** 既有全部 lifecycle tests 必须证明 action 输出 **顺序/内容不变**。

**operation 不是 `audit`。** audit 是 **capabilityKind**，不是 lifecycle operation。

### 0.3 primary map 与 audit cross-cutting（权威）

```js
// CODE_OWNED_ACTION_PRIMARY_CAPABILITY_MAP（primary kinds；audit 不在 primary 列）
'render-launch-agent-plist' → 'render'
'write-launch-agent-plist' → 'write'
'load-launch-agent' → 'reload'
'unload-launch-agent' → 'reload'
'remove-launch-agent-plist' → 'write'
'remove-supervisor-metadata' → 'write'
'capture-current-state' → 'status'
'restore-previous-plist' → 'rollback'
'restart-previous-supervisor' → 'reload'
'start-recovery-supervisor' → 'reload'
```

```js
// CAPABILITY_KIND_ACTION_IDS
audit: Object.freeze(Object.keys(CODE_OWNED_ACTION_PRIMARY_CAPABILITY_MAP))  // all 10 action ids
// CAPABILITY_CROSS_CUTTING_KINDS = {'audit','notify'}
// resolveDryRunPlannedAction: capabilityKind==='audit' → 'audit-plan'
```

**V1.34 合同：**

- `capabilityKind` 固定 `'audit'`
- `operation` ∈ shared SoT operations（`isSupervisorLifecycleOperation`）
- `actionId` **必须** `isSupervisorLifecycleActionForOperation(operation, actionId)` 为 true（= `listSupervisorLifecycleActionIds(operation)` 集合）
- audit **可覆盖**该 operation 对应 action 集合（cross-cutting）
- **禁止**跨 operation 的 action（例如 `operation:'install'` + `actionId:'capture-current-state'` → fail-closed）
- lifecycle 侧 `buildLifecycleActions` 仅包装 shared IDs 的 description 等字段；**action ID 权威只在 pure module**
### 0.4 为何不能直接复用 `appendAuditEvent` / `events.jsonl`（权威；GLM round1 BLOCK 根因）

`src/audit-log.js` 事实：

| 属性 | `appendAuditEvent` / `audit/events.jsonl` | V1.34 capability real-audit sink |
| --- | --- | --- |
| 相对路径 | `audit/events.jsonl` | **`audit/capability-proof-attempts.jsonl`**（独立） |
| 语义 | HTTP/API 请求审计（type/method/path/outcome/requestId…） | capability real-proof attempt canonical event |
| schema | 动态字段 + `randomUUID` id + `createdAt` 时间戳 | **fixed 7 keys**；无 UUID/time/raw attemptRef |
| 失败行 | `readAuditEvents` **忽略** JSON 解析失败行 | **fail-closed**；malformed → 绝不 append |
| retention | 可选 `maxEvents` + **atomic rewrite compact** | **本版无** retention/rotation/compaction |
| 队列 | 仅在 retention 或已有 queue 时串行；无 retention 可无 queue 直写 | **sink 内**每 resolved root 强制串行 queue（**唯一 SoT**；invoke 无第二 queue） |
| 既有文件校验 | 无 exact 7-key / key-order byte-for-byte 校验 | **sink queue 内** bounded pre-read + exact canonical 校验 |
| public surface | server/agent/Web 审计面板可消费 | **禁止** HTTP/CLI/Web proof 暴露 |
| 与 capability | **未**挂 capability real | **本版**挂 RealAuditProof only |

**强制禁止：**

1. 调用或修改 `appendAuditEvent`
2. 读写 `audit/events.jsonl` 作为 capability real-audit 证据
3. 共享 HTTP schema / retention / queue Map key 空间
4. 把 `sanitizeAuditEvent` 的 UUID/time 语义导入 capability sink
5. 宣称与 production HTTP audit 链完整性（T6d.3）等价

**可复用的仅是：** `safe-data-files` primitives（`assertSafeDataRoot` / `safeAppendText` / `safeReadText` / `SafeDataFileError`）+ per-root queue 模式思想（**新 Map 仅在 sink module**；invoke 不持有第二 Map）。

### 0.5 `safe-data-files` 真实保证（权威；不得虚构）

| API | 真实保证 | 本版承诺边界 |
| --- | --- | --- |
| `assertSafeDataRoot(root)` | root 必须已存在；`lstat` 非 symlink 且为 directory；返回 **resolved absolute root**；失败 → `SafeDataFileError`（path-free） | invoke 在 pure request/context shape 校验后、任何 fingerprint/Set/sink 前调用；**dataDir 必须已存在**（不 `ensureSafeDataRoot` 创建 root） |
| `safeAppendText(root, rel, text)` | 安全确保 **缺失 parent 段**（non-recursive mkdir + re-lstat）；`O_APPEND\|O_CREAT\|O_WRONLY\|O_NOFOLLOW`；fd **mode 0600** + `chmod(0600)`；**若 FileHandle 提供 `sync` 方法则实现总是 `await handle.sync()`**（调用方无关闭开关） | 文档只承诺：**no-symlink parent** + **file 0600** + **有 sync 则总是 await**；**不**虚构 directory **0700**；**不**夸大没有 `sync` 方法的测试 seam（无 `sync` 时仅跳过该调用，非 durability claim） |
| `safeReadText(root, rel, {maxBytes})` | parent 安全；leaf 非 symlink 常规文件；size ≤ maxBytes；ENOENT 原样抛 | sink **queue 内** pre-read 使用 **max 1.5 MiB (1_572_864 bytes / 1536 * 1024)** bound；missing → 允许 create |
| `SafeDataFileError` | path-free；不嵌入 path/content/system message | receipt 永不回显底层 error message/stack/path |

### 0.6 `hostSideEffect` / `hostMutation` 历史定义（不得重定义）

V1.32 design：host side effect = 改变或读取 host 受控资源（含 audit persist）。

V1.33 design：host mutation = **改变** host 受控资源，**明确包含 audit persist**。

**V1.34 强制推论：**

```text
成功 sink write+sync
  ⇒ hostSideEffectOccurred === true
  ⇒ hostMutationOccurred === true     // audit persist = mutation
  ⇒ auditPersistOccurred === true
  ⇒ mutationOutcome === 'persisted'

append mutating call 已 invoke 后 throws
  ⇒ hostSideEffectOccurred === true
  ⇒ hostMutationOccurred === true     // conservative fail-closed
  ⇒ auditPersistOccurred === false
  ⇒ mutationOutcome === 'unknown-after-write-attempt'
  // 绝不声称 partial 是否存在

validation / assertSafeDataRoot / malformed file / in-flight deny（append 前）
  ⇒ 三者 occurred === false
  ⇒ mutationOutcome === 'not-attempted'
```

**兼容既有 non-live/execute intent 字段（不得被 options override）：**

```text
auditWriteAllowed: false
filesystemWriteAllowed: false
wouldPersistAudit: false
wouldMutateHost: false
```

解释：`wouldPersistAudit:false` 仍表示 **不是 future execute intent**；live `auditPersistOccurred` 独立。
局部 descriptor 新增：`canPersistAuditInProof:true`、`sideEffectClass:'audit-persist'`。

### 0.7 M6 / M6d / M7 / scorecard 边界（V2 Gold plan）

来自 `docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md`：

| 项 | 事实 |
| --- | --- |
| M6d | production-hardening 子轨；scorecard 项 `production-hardening` → ready **仅** M6d 全出口 |
| T6d.3 | 审计链完整性与敏感字段扫描 — **本版不是** |
| M5 ∥ M6a–d | 可时间并行；单子轨失败不阻塞其它子轨提交 |
| M7 | **唯一**允许 V2.0 Gold/GA；要求 M5 + M6a–d 全出口 + scorecard **10/10** + 用户批准 |
| V1.x | 可继续作审计里程碑；**不得**升 overall Gold ready |

**本版定位：** **M6d-prep 独立预备增量**（可与 M5 并行）— 为未来 production-hardening / realAttemptAudit wiring **铺 sink 与 truth 合同**；**不**完成 M6d，**不**改 `production-hardening` 为 ready。

### 0.8 M1 Exit audit temporal snapshot（权威）

`docs/superpowers/specs/2026-07-18-linke-v2-m1-exit-audit.md` + `test/cross-lan-m1-exit-audit.test.js`：

| 字段 | 历史 snapshot 值 |
| --- | --- |
| Audit base HEAD | `47dcc2d` |
| 审计当时 version | **V1.33** |
| Gold 审计当时 | 4 ready / 4 partial / 1 blocked / total 9；overall blocked；无 cross-lan-connectivity |
| `VERSION_MUTATION` | **NONE**（**仅**表示该 audit 文档本身未改 version） |
| `SCORECARD_MUTATION` | **NONE** |
| M1 status | `BLOCKED_RECORDED` |

**未来 V1.34 实现时：**

1. **不得**把 audit 文档中的当时 V1.33 改写为 V1.34
2. `VERSION_MUTATION: NONE` 继续表示 **audit 本身**未改 version，**不是**“运行时永远 V1.33”
3. `test/cross-lan-m1-exit-audit.test.js` **不得永久**断言“当前 runtime 必须 V1.33”
4. 正确拆分：
   - **doc snapshot 锁**：audit 文本仍含 V1.33、4/4/1/9、`VERSION_MUTATION:NONE`、`47dcc2d`
   - **runtime 锁**：overall `blocked` + 无 `cross-lan-connectivity` + 未抬升 M1/M2；**允许** `LINKE_RELEASE_VERSION === 'V1.34'`
5. 不依赖 git CLI / shallow history 来“证明” snapshot

### 0.9 `executionEligible` / execute 公式（本版仍不可满足）

```text
executeCapabilityAuthorized =
  mode==='execute' &&
  executeRequested &&
  policyDecision.authorized &&
  executionEligible 全项 &&
  各 real*ImplementationReady（含 realAttemptAuditImplementationReady）&&
  realCapabilityImplementationsReady &&   // 全局；3/7 仍 false
  executeCapabilityRegistryReady &&
  idempotency + rollback sink + audit sink wiring + recovery/notify &&
  dual-host evidence recorded &&
  failure-injection suite evidence recorded &&
  handler.supportsModes includes 'execute'
```

**V1.34 结论：** 即便 real audit handler 已注册并 proof 成功，**execute 仍必须 hard-deny 且零 dispatch**；验证走 **独立 RealAuditProof**；**不得**开放 execute；**不得**因 sink 存在而宣称 `realAttemptAuditImplementationReady:true`。

---

## 1. 候选评估与选定

### 1.1 评估矩阵

| 准则 | A：独立 capability real-audit sink + RealAuditProof | B：直接复用 `appendAuditEvent`/`events.jsonl` | C：扩 RealStatusProof / generic framework 塞 audit |
| --- | --- | --- | --- |
| **Gold/M6d 预备价值** | **高**：第三 real kind；为 T6d.3/realAttemptAudit 铺独立合同 | 中：假“复用”实际污染 HTTP audit | 低：schema 异构；违反 V1.32/V1.33 独立 proof 合同 |
| **安全 blast radius** | **中**：写盘但隔离路径 + fail-closed + 无 public surface | **高**：与 HTTP audit 耦合；retention rewrite；UUID/time 泄漏面 | 中高：injection surface 扩大 |
| **确定性** | **高**：fixed preimage + fixed 7 keys | **低**：UUID/time 不确定 | 中 |
| **fail-closed 既有文件** | **可强制** | 现实现忽略 corrupt 行 | 不适用 |
| **与 GLM round1** | 对齐 PM 修订后 PROCEED 方向 | **正是 BLOCK 根因** | 过早抽象 |
| **是否抬升 execute** | **否**（合同强制） | 易误抬升 | 易误抬升 |

### 1.2 选定

```text
V1.34 SELECTED_CAPABILITY     = audit
SELECTED_CAPABILITY_KIND      = 'audit'
SELECTED_OPERATIONS           = install | uninstall | rollback | recover
SELECTED_ACTION_IDS           = listSupervisorLifecycleActionIds(operation)  // pure SoT
SHARED_ACTIONS_SOT            = src/supervisor-lifecycle-actions.js
SELECTED_MODE                 = real-proof
PROOF_API                     = RealAuditProof（独立；不扩 Render/Status）
SINK                          = src/capability-audit-sink.js
RELATIVE_PATH                 = audit/capability-proof-attempts.jsonl
HOST_IO                       = safe-data-files only under trusted context.dataDir
```

**明确拒绝本版：**

- **B**：复用 / 修改 `appendAuditEvent` 或 `events.jsonl`
- **C**：扩 RealRenderProof / RealStatusProof kind；generic multi-kind framework
- 把 operation 设为 `'audit'`
- 接受跨 operation actionId
- HTTP/CLI/Web proof endpoint / button / request field
- 抬升全局 real / execute / wiring / `realAttemptAuditImplementationReady`
- 宣称 T6d.3 / M6d Exit / production-hardening ready / Gold / GA / V2.0
- immutable / WORM / tamper-proof / retention / rotation / durability chronology
- T1.0/M1 crypto/M2/cross-LAN 任何依赖
- 新 npm dependency
- 改 `agent.js` / `server.js` public surface

### 1.3 术语定义（强制）

| 术语 | 定义 | V1.34 对 audit 的取值 |
| --- | --- | --- |
| **dry-run non-side-effect** | 仅模拟计划；无真实 persist | 仍保留 dry-run `audit` → `audit-plan` |
| **real implementation** | 真实执行 capability 语义并产生可验证产物（非 stub）；与 global execute readiness **正交** | **是**（本版交付） |
| **host side effect** | 改变或读取 host 受控资源（V1.32 伞形） | 成功/写后失败路径 **true** |
| **host mutation** | **改变** host 受控资源；含 audit persist（V1.33） | 成功/写后失败路径 **true** |
| **audit persist** | 向 capability sink 追加 canonical event 行并 sync | 成功 → `auditPersistOccurred:true` |
| **append-only API behavior** | 成功路径只 append；不 truncate/delete/rewrite 既有合法文件 | **本版用语**；**禁止**称 immutable/WORM |
| **mutationOutcome** | `not-attempted \| persisted \| unknown-after-write-attempt` | 见 §10 |
| **canPersistAuditInProof** | local descriptor：proof 模式允许 persist | **true** |
| **wouldPersistAudit / auditWriteAllowed** | future execute intent / broad allow | **保持 false**（不得 override） |
| **realAuditCapabilityImplementationReady** | 局部 readiness | bootstrap 成功 → **true** |
| **realAttemptAuditImplementationReady** | execute-wiring attempt audit locus | **恒 false** |
| **realCapabilityImplementationsReady** | 全局 7/7 | **恒 false**（3/7） |
| **M6d-prep** | production-hardening 预备增量 | **是**；≠ M6d Exit |
| **T6d.3** | audit-chain-integrity 完成项 | **否** |

**代码注释合同（registry/handler/sink 附近 must）：**

```text
// real audit = 真实 capability sink persist 非 stub；独立于 events.jsonl
// 成功 write+sync：hostSideEffectOccurred=true 且 hostMutationOccurred=true
//   且 auditPersistOccurred=true 且 mutationOutcome=persisted
// append 已 invoke 后 throws：occurred true/true/false；mutationOutcome=unknown-after-write-attempt
// wouldPersistAudit=false 仍表示非 future execute intent；live occurred 独立
// 不得抬升 execute / 全局 real / wiring / realAttemptAudit / Gold / M6d Exit
// 只称 append-only API behavior；禁止 immutable/WORM/tamper-proof 宣称
```

---

## 2. 设计选择总览

| 组件 | V1.33 | V1.34 |
| --- | --- | --- |
| dry-run registry | 7 kinds | **保持** 7 |
| real registry | render + status | **+ audit**（size **3**） |
| RealRenderProof | render-specific | **保持；禁止扩 kind** |
| RealStatusProof | status-specific | **保持；禁止扩 kind** |
| RealAuditProof | 无 | **新增独立 API** |
| sink | 无 capability sink | **`capability-audit-sink.js`** |
| receiptKind | `capability-real-implementation-receipt` | **同 kind**；靠 capabilityId/outcome/audit fields 区分 |
| 局部 ready | realRender + realStatus | **+ realAudit** |
| 全局 realCapabilityImplementationsReady | false（2/7） | **false（3/7）** |
| execute / wiring / Gold | hard-deny / blocked | **保持** |
| version | V1.33 | **计划 V1.34**（Gold 计数不变） |
| agent.js / server.js | 零 proof 引用 | **保持零引用** |
| 新 endpoint / CLI / Web button | 无 | **无** |
| production-hardening scorecard | partial | **仍 partial**（不 ready） |

### 字段命名（禁止混淆）

| 名称 | 类型 | V1.34 语义 |
| --- | --- | --- |
| `realAuditCapabilityImplementationReady` | **局部** fact | audit real handler + sink 契约就绪 |
| `realAttemptAuditImplementationReady` | execute locus | **恒 false** |
| `realCapabilityImplementationsReady` | **全局** | **恒 false**（3/7 独立事实） |
| `auditEventFingerprint` | receipt 动态 | 64 lowercase hex 或 null |
| `auditPersistOccurred` | receipt 动态 live | 是否确认 persist |
| `hostMutationOccurred` | receipt 动态 live | audit persist 路径可 true |
| `mutationOutcome` | receipt 动态 enum | 三态 |
| `canPersistAuditInProof` | descriptor | true |
| `wouldPersistAudit` | intent 字段 | **false**（非 execute intent） |
| `capability-real-implementation-receipt` | receiptKind | real audit/render/status 共用；**NOT** execute receipt |

**禁止别名：** `auditReady` 单独冒充 wiring、`realAttemptAuditReady` 混用、`events.jsonl ready`、`chain-integrity ready`、`production-grade audit`。

---

## 3. Proof API 策略：独立 RealAuditProof（选定）

### 3.1 为什么独立

1. V1.32/V1.33 合同：未来 kind **不得**扩既有 Real*Proof；须 **独立 proof API** 或另开 generic framework。
2. audit 需要 `auditInput` / context.`dataDir` / sink / mutationOutcome — 与 render hash 产物、status observation enum **不同构**。
3. 在 3 real kinds 时仍拒绝 generic framework：execute 接线前先把 audit persist 合同钉死。

**禁止：** 在 RealRender/Status invoke 内 `if (kind==='audit')` 分支。

### 3.2 Export 合同（exact）

```js
/**
 * @internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint
 * Authorize real-proof mode for **audit only**. Never authorizes execute.
 * Audit-specific: do not reuse this API for other real kinds.
 * Pure validation only — does not accept context; does not touch sink/fs.
 */
export function authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(request)

/**
 * @internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint
 * Invoke real **audit** persist implementation proof (async).
 * Writes only to capability-proof-attempts.jsonl via capability-audit-sink.
 * Never calls appendAuditEvent. Never touches audit/events.jsonl.
 * Never accepts mode execute. Never returns dataDir/path/raw attemptRef/system error.
 * Audit-specific proof API — do not expand kind range.
 * @param {object} request
 * @param {object} context exact own keys: { dataDir } only
 * @returns {Promise<object>} single settled receipt
 */
export async function invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(request, context)
```

| 检查 | 要求 |
| --- | --- |
| `authorize` | **pure**；**不**收 context；**不** IO |
| `invoke` | **async**；收 `(request, context)` |
| `src/server.js` / `src/agent.js` | **零** RealAuditProof / RealRenderProof / RealStatusProof 生产引用 |
| Web button / CLI flag / HTTP route / request field | **禁止** |
| 允许引用 | `src/supervisor-lifecycle.js` + `src/capability-audit-sink.js` + `test/**` |

---

## 4. Trusted bootstrap：双轨注册扩展

### 4.1 注册结构

```text
dryRunCapabilityRegistry: Map<kind, {descriptor, handler}>   // 保持 7
realCapabilityRegistry:   Map<kind, {descriptor, handler}>   // V1.34: render + status + audit
```

**禁止** 覆盖 dry-run。
**禁止** export `registerCapability` / 接受 `options.handlers` 作为生产证据。
**禁止** options override 抬升 `auditWriteAllowed` / `filesystemWriteAllowed` / `wouldPersistAudit` / `wouldMutateHost` / 全局 flags。

### 4.2 Real audit descriptor（exact）

```js
{
  capabilityKind: 'audit',
  capabilityId: 'real-audit',
  implementationClass: 'real-implementation',
  sideEffectClass: 'audit-persist',
  supportsModes: ['real-proof'],           // 本版不含 'execute'
  actionIds: /* all 10 from CODE_OWNED_ACTION_PRIMARY_CAPABILITY_MAP keys, frozen order stable */,
  realImplementationReady: true,
  canPersistAuditInProof: true,            // NEW local
  wouldMutateHost: false,                  // intent：非 execute
  wouldPersistAudit: false,                // intent：非 execute
  wouldNotifyExternal: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,           // intent allow：false（proof 走 sink 专用路径）
  processListReadAllowed: false,
  networkAllowed: false,
  metadataWriteAllowed: false,
  auditWriteAllowed: false,                // intent allow：false
  rollbackAnchorWriteAllowed: false,
  evidenceCode: 'capability-real-audit-implementation-ready',
  blockerCode: null,
}
```

### 4.3 trustedBootstrap 增量算法

```text
// after V1.33 real-status registration:
N. build real-audit descriptor (exact §4.2)
N+1. validate:
     implementationClass === 'real-implementation'
     sideEffectClass === 'audit-persist'
     supportsModes exact ['real-proof']
     realImplementationReady === true
     canPersistAuditInProof === true
     wouldMutateHost === false
     wouldPersistAudit === false
     auditWriteAllowed === false
     filesystemWriteAllowed === false
     全部其它 mutation *Allowed === false
N+2. realCapabilityRegistry.set('audit', {
       descriptor,
       handler: createRealAuditCapabilityHandler(/* binds sink; no events.jsonl */)
     })
N+3. assert realCapabilityRegistry.size === 3
N+4. assert has('render') && has('status') && has('audit')
N+5. assert !has('write'|'reload'|'rollback'|'notify') as real entries
N+6. production bootstrap MUST NEVER call test-only hooks
```

### 4.4 Readiness 局部事实

```js
realRenderCapabilityImplementationReady: true|false
realStatusCapabilityImplementationReady: true|false
realAuditCapabilityImplementationReady: true|false   // NEW local only
realCapabilityImplementationsReady: false            // 全局恒 false（3/7 独立事实）
realAttemptAuditImplementationReady: false           // 恒 false
executeCapabilityRegistryReady: false
executeCapabilityAuthorized: false
realRunnerWiringReady: false
runnerWiringContractReady: false
executionEligible: false
realImplementationEntries: [
  { capabilityKind:'render', ... },
  { capabilityKind:'status', ... },
  { capabilityKind:'audit', capabilityId:'real-audit', sideEffectClass:'audit-persist',
    canPersistAuditInProof:true, supportsModes:['real-proof'], ... },
]
```

**禁止** 用「任一/三个 local ready」冒充全局 `realCapabilityImplementationsReady`。

### 4.5 real-audit-proof 授权公式（局部；≠ execute）

```text
realAuditProofAuthorized =
  request.mode === 'real-proof' &&
  request.capabilityKind === 'audit' &&
  isSupervisorLifecycleOperation(request.operation) &&
  isSupervisorLifecycleActionForOperation(request.operation, request.actionId) &&
  request.idempotencyKey === null &&
  request.anchorRef === null &&
  attemptRef matches exact pattern &&
  auditInput exact {schemaVersion:1} &&
  real audit registry entry exists &&
  entry.descriptor.implementationClass === 'real-implementation' &&
  entry.descriptor.sideEffectClass === 'audit-persist' &&
  entry.descriptor.supportsModes includes 'real-proof' &&
  entry.descriptor.realImplementationReady === true &&
  entry.descriptor.canPersistAuditInProof === true &&
  entry.descriptor.wouldPersistAudit === false &&
  entry.descriptor.auditWriteAllowed === false &&
  entry.descriptor.filesystemWriteAllowed === false &&
  无 caller injection / dangerous keys / getters / symbols / functions / proxies
```

**invoke 额外（顺序冻结；Option A fingerprint 时序）：**

```text
1. pure snapshot+validate request shape（无 IO）→ fail ⇒ auditEventFingerprint MUST null
2. pure snapshot+validate context exact { dataDir } plain own data property（无 IO）
   → fail ⇒ auditEventFingerprint MUST null
3. assertSafeDataRoot(context.dataDir) → resolvedDataRoot
   // assert 在 fingerprint / inFlightSet / sink 之前
   → fail ⇒ auditEventFingerprint MUST null
4. compute attemptRefFingerprint + eventFingerprint in memory（成功后才有 64hex）
5. same-fingerprint inFlight 原子同步段（同一同步段；任何 await / sink call 之前）:
     if (inFlightSet.has(eventFingerprint)) deny;  // fingerprint 已算；再 has
     inFlightSet.add(eventFingerprint);
   // finally delete（所有出口）
6. await appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)
   // 唯一 sink 入口；queue / pre-read / existing+incoming validation / append
   // 全部且只在 sink 内作为一个 queue task 串行完成
```

**invoke MUST NOT maintain/enqueue a second queue.**
**invoke MUST NOT pre-read existing sink file.**
**sink `capabilityAuditSinkQueues` Map 是唯一 queue SoT**（禁止 lifecycle 第二套 Map / 嵌套 queue）。

**不要求：** `executeRequested`、`realRunnerWiringReady`、dual-host、idempotency store、`realAttemptAuditImplementationReady`。

### 4.6 execute 路径（保持 hard-deny 零 dispatch）

```text
if (mode === 'execute') {
  // 不得调用 real-audit / real-status / real-render / dry-run handler
  // 不得调用 capability-audit-sink / appendAuditEvent
  return capability-execute-denied-receipt
  executeCapabilityAuthorized: false
  hostSideEffectOccurred: false
  hostMutationOccurred: false
  auditPersistOccurred: false
  mutationOutcome: 'not-attempted'   // 若该 receipt 暴露 mutationOutcome；否则保持既有 execute receipt 字段
}
```

---

## 5. Request / context exact schema

### 5.1 Request top-level exact keys（顺序用于文档；校验用 set equality）

```text
capabilityKind, actionId, operation, mode, idempotencyKey, attemptRef, anchorRef, auditInput
```

| 字段 | exact 约束 |
| --- | --- |
| `capabilityKind` | `'audit'` |
| `actionId` | string；`isSupervisorLifecycleActionForOperation(operation, actionId)` |
| `operation` | `'install' \| 'uninstall' \| 'rollback' \| 'recover'`（shared SoT） |
| `mode` | `'real-proof'` |
| `idempotencyKey` | **`null` only** |
| `attemptRef` | string；pattern 见 §5.2；**raw 永不存储/返回** |
| `anchorRef` | **`null` only** |
| `auditInput` | exact only `{ schemaVersion: 1 }` |

**禁止 request 含：** `dataDir`、`path`、`event`、`message`、`metadata`、`time`/`timestamp`、`token`、`handler`、`function`、`fs`、`reader`、`retention`、任意 extra key、symbol key、getter、proxy、危险键（`__proto__`/`constructor`/`prototype`）。

### 5.2 `attemptRef` pattern（精确冻结）

```text
^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$
```

- ASCII 总长 **16–128**
- 无 whitespace / control
- raw 值：**永不**写入 sink event、**永不**进入 receipt、**永不**日志原文
- 仅以 `attemptRefFingerprint`（64 hex）形式出现在 event/receipt

### 5.3 `auditInput` exact

```js
{ schemaVersion: 1 }
```

- 单一 schema version 空间：`auditInput.schemaVersion` 与 stored event `schemaVersion` **同步**；当前均 **1**
- 禁止任何其它键（含 dataDir/path/event/message/metadata/time/token/handler）

### 5.4 Context exact

```js
{ dataDir: string }
```

| 规则 | 要求 |
| --- | --- |
| keys | **仅** `dataDir` |
| 形态 | plain object；own data property；data descriptor；非 getter/setter |
| 位置 | **仅** `invoke` 第二参数；**禁止**出现在 request |
| 存储/返回 | **禁止** 存 event / 回显 receipt |
| 信任模型 | **trusted internal context**；**不是** tenant-isolation claim |
| 存在性 | 必须已存在目录；`assertSafeDataRoot` 失败 → context-invalid 类 blocker |

### 5.5 Hostile graph / snapshot discipline

沿用 V1.32/V1.33 exact own-key / data-descriptor / plain graph / dangerous keys / getter / symbol / function / proxy **fail-closed** + `structuredClone` public deep-copy discipline：

1. top request exact key set equality（length + membership）
2. nested `auditInput` **独立** exact snapshot
3. context **独立** exact snapshot（invoke only）
4. 校验后仅使用 snapshot；不再读原对象
5. public 返回 `capabilityPublicDeepCopy`；function 存在 → fail-closed

---

## 6. 独立 sink 架构

### 6.1 Module 与路径

| 项 | 值 |
| --- | --- |
| 后续新文件 | `src/capability-audit-sink.js` |
| pure SoT（sink 前独立交付） | `src/supervisor-lifecycle-actions.js` |
| 相对路径常量 | `audit/capability-proof-attempts.jsonl` |
| 禁止路径 | `audit/events.jsonl` |
| 禁止 import | `appendAuditEvent` / 修改 `audit-log.js` 语义 / lifecycle module（防 cycle） |
| 允许 import | `assertSafeDataRoot`, `safeAppendText`, `safeReadText`, `SafeDataFileError` from `safe-data-files.js`；`isSupervisorLifecycleActionForOperation`（及 operation 校验）from `supervisor-lifecycle-actions.js` |

### 6.2 Sink 公开 API（exact 名称与签名；@internal）

```js
/**
 * @internal capability real-audit sink — append-only API behavior only.
 * Not immutable/WORM/tamper-proof. Not HTTP audit.
 * Sole queue SoT: per-resolved-root serialization lives ONLY here.
 * @param {string} resolvedDataRoot
 *   invoke 对 exact context 做 assertSafeDataRoot 后返回的 root；
 *   该 assert 在 fingerprint / inFlightSet / sink call 之前完成。
 *   sink 仍通过 safeReadText/safeAppendText 重新执行安全 root/path
 *   traversal/no-symlink 检查，不把 caller string 当安全证明。
 * @param {object} event canonical 7-key plain object（非 pre-string line 权威名）
 * @returns {Promise<void>} 成功 settle；失败 throw path-free error
 *   stage 映射必须与 receipt truth 对齐：
 *   - pre-append validation/root/preflight/incoming-event fail → mutationOutcome not-attempted；
 *     occurred 三元组 false（lifecycle 映射 sink-invalid / context-invalid）
 *   - append mutating call 已 invoke 后 throw → unknown-after-write-attempt；
 *     sideEffect+mutation true，persist false（lifecycle 映射 persist-failed）
 */
export async function appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)
```

**禁止旧签名：** 任何 `append…Line(dataDir, …)` 变体（第二参为 pre-string line / 第一参命名 dataDir 的旧形态）。唯一 API 见上。

**queue task 内全部且只在本函数完成（单一归属；禁止 invoke 第二 queue）：**

```text
enqueue on capabilityAuditSinkQueues[resolvedDataRoot]  // sole Map SoT
  → bounded pre-read existing file（§8.1–§8.2）
  → existing-line exact validation（§8.3）
  → incoming event exact validation（§8.5；与 §8.3 同级）
  → serialize event to fixed-key-order JSON + '\n'
  → safeAppendText(resolvedDataRoot, REL, line)
finally Map cleanup
```

**event 处理：** operation/action 校验 **必须**走 pure SoT（sink 对 existing **与** incoming event 的 schema/op/action **非**无关、**必须**校验）。**无需/不能**从 raw attemptRef 重算 preimage（raw 不落盘；incoming 亦无 raw）。

### 6.3 Queue / Map cleanup（唯一 SoT）

```text
// ONLY in src/capability-audit-sink.js:
capabilityAuditSinkQueues: Map<resolvedDataRoot, Promise>
// key = assertSafeDataRoot 返回的 resolved data root 字符串
// 每 root 串行；唯一 queue SoT
// finally: if map.get(key) === thisCleanup then map.delete(key)
// 禁止无限累积
// 禁止 lifecycle/invoke 维护第二套 Map 或嵌套 enqueue
```

**invoke MUST NOT maintain/enqueue a second queue。**

### 6.4 写路径顺序（invoke → sink 分工冻结）

```text
// ── invoke（lifecycle RealAuditProof）──
1. pure snapshot+validate request shape（无 IO）
   → fail: auditEventFingerprint MUST null; not-attempted; occurred false
2. pure snapshot+validate context shape（无 IO）
   → fail: auditEventFingerprint MUST null; not-attempted; occurred false
3. assertSafeDataRoot(context.dataDir) → resolvedDataRoot
   // before fingerprint / inFlightSet / sink
   → fail: auditEventFingerprint MUST null; not-attempted; occurred false
4. compute attemptRefFingerprint + eventFingerprint（内存；raw attemptRef 随后丢弃）
   // 仅此步成功后，receipt 才允许带 64hex fingerprint
5. inFlight 原子同步段（同一同步段；任何 await / sink call 之前）:
     if (inFlightSet.has(eventFingerprint)) deny;
       // fingerprint 先算再 has；deny 仍返回该 64hex；not-attempted；零写
     inFlightSet.add(eventFingerprint);
6. await appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)
   // invoke 唯一 sink 调用；不 pre-read；不 enter 第二 queue
7. success → finally delete inflight；return persisted receipt（64hex）
8. sink pre-append fail（malformed existing / incoming invalid / over bound / …）
   → not-attempted；occurred false；receipt 带已算 64hex；finally delete
9. throw after mutating call → unknown-after-write-attempt；64hex；finally delete
10. any path with fingerprint computed: finally { inFlightSet.delete(eventFingerprint); }

// ── appendCapabilityRealAuditProofEvent（sole queue task）──
A. enqueue per-resolved-root on capabilityAuditSinkQueues ONLY
B. bounded pre-read existing file fail-closed（§8 算法）
C. existing-line validation（§8.3）
D. incoming-event validation（§8.5；与 §8.3 同级 structural/type/enum/hash/op-action/key-order）
E. safeAppendText（有 FileHandle.sync 则总是 await；creates missing audit/ parent safely）
```

**禁止：**

- `invoke` enter / maintain / enqueue 任何第二 queue
- `invoke` pre-read existing sink file
- lifecycle 与 sink 各持一套 queue Map
- 嵌套 queue（sink 内再 enqueue 到另一 Map）

**Sink terminal 规则：**

- sink **不** callback proof/通用 dispatch
- sink **不**为自己的写生成第二 attempt
- handler/sink 不递归 invoke RealAuditProof

### 6.5 Directory / file mode 诚实承诺

| 对象 | 承诺 | 非承诺 |
| --- | --- | --- |
| dataDir root | 必须已存在；non-symlink directory | 本版不创建 root |
| `audit/` parent | safe helper 可创建缺失段；no-symlink | **不**保证 directory mode 0700 |
| sink file | open/chmod **0600** | 不保证跨进程 umask 后 directory bits |
| external tamper / TOCTOU | **不在本版证明** | 禁止 claim tamper-proof |

---

## 7. Fingerprint / canonical event（exact）

### 7.1 算法

- UTF-8 encode preimage
- SHA-256
- digest **lowercase hex** 精确 **64** chars

### 7.2 `attemptRefFingerprint` preimage（exact）

```text
linke:v1.34:real-audit-proof:attempt-ref:v1\x1f${attemptRef}
```

- `\x1f` = ASCII unit separator（单字节 0x1F）
- 使用 raw attemptRef **仅在内存计算**；计算结果后丢弃 raw

### 7.3 `eventFingerprint` preimage（exact）

```text
linke:v1.34:real-audit-proof:event:v1\x1f1\x1f${operation}\x1f${actionId}\x1f${attemptRef}
```

- 第二字段 `1` = schemaVersion 字面
- 分隔符均为 `\x1f`
- 含 raw attemptRef（仅 preimage 内存）；**stored event 不存 raw**

### 7.4 Stored canonical event exact ordered keys

```text
schemaVersion, eventKind, eventFingerprint, operation, actionId, attemptRefFingerprint, proofMode
```

| 键 | 值约束 |
| --- | --- |
| `schemaVersion` | number `1`（与 auditInput 同步） |
| `eventKind` | `'capability-real-audit-proof'` |
| `eventFingerprint` | 64 lowercase hex |
| `operation` | install\|uninstall\|rollback\|recover |
| `actionId` | 对应 operation 合法 action |
| `attemptRefFingerprint` | 64 lowercase hex |
| `proofMode` | `'real-proof'` |

**禁止 stored 字段：** UUID、time/timestamp、raw attemptRef、path、dataDir、eventCount、sequence、message、metadata、hostname、pid。

### 7.5 Canonical JSON line

```text
JSON.stringify(eventObjectWithExactKeyOrder) + '\n'
```

- **single line** + trailing newline
- key 顺序 **固定**为 §7.4 顺序（实现必须按该序构造 plain object 再 stringify；**不得**依赖引擎 key 枚举偶然顺序）
- sequential duplicate：**允许** append **第二条**语义相同 line（same fingerprint）；**不** dedup；**不是** idempotency store

### 7.6 与 idempotency 的边界

| 概念 | 本版 |
| --- | --- |
| `idempotencyKey` | 必须 null |
| `idempotencyKeyFingerprint` | 保持 null |
| sequential duplicate same fingerprint | **允许**（两次成功 append） |
| concurrent same fingerprint | **deny**（in-flight Set） |
| dedup / retry store | **不存在**；禁止宣称 |

---

## 8. Existing file fail-closed preflight + incoming event validation

**归属：** 以下全部且只在 `appendCapabilityRealAuditProofEvent` 的 **per-resolved-root queue task 内**、append 前执行。**invoke 不 pre-read。**

### 8.1 Bounds

| bound | 值 | 语义 |
| --- | --- | --- |
| max pre-read bytes | **1.5 MiB**（`1_572_864` / `1536 * 1024`） | existing-file 读取上限（UTF-8 **file-size bytes**） |
| max **existing** event lines | **4096** | **existing-file validation bound only** — **不是** retention/cap/rotation |

**Bound 语义与 contract correction（强制明写）：**

```text
CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES = 1_572_864  // 1.5 MiB = 1536 * 1024
  = safeReadText({ maxBytes }) / file stat.size 的 UTF-8 file-size bytes
  ≠ JS string.length（code units）

为何不是 1 MiB：
  冻结 contract 的 1 MiB 与「真实 4096 条完整合法 canonical 行」不可同时满足
  这是 design 内部不可满足矛盾的 formal correction，不是功能扩张

为何 1.5 MiB 足够且安全：
  accepted operation/actionId 不是任意字符串，而是
  SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS 的精确枚举 SoT
  unknown / cross-op / 超长字符串 fail-closed
  当前所有 SoT pair 中 canonical UTF-8 JSONL 最大行 = 328 bytes
  328 * 4097 = 1_343_816 < 1_572_864
  → 能真实读入 4096 后 append 4097，并能在下一次完整读入 4097 后按 line count 拒绝
  → 比 2 MiB 更紧，无 residual-risk / 实现偏离文档措辞
```

超 bound → fixed sink-invalid；**不** append / truncate / delete / compact / rotate。

**4096 边界（强制明写；防实现者误当 retention）：**

```text
existing lines.length === 4096 且每行合法
  → validation PASS
  → 允许 append 第 4097 行
  → 成功后文件可有 4097 行（短暂/持续均可；本版无 compaction）

existing lines.length === 4097（或 > 4096）
  → 下一次 preflight FAIL → sink-invalid；不 append

禁止：删除/compaction/rotation 把文件“收回”到 ≤4096
禁止：宣称“文件永不超过 4096 行”（按冻结算法，4096→append 后可达 4097）
```

### 8.2 JSONL 算法（design 与 plan 同步冻结；exact）

对 `safeReadText` 得到的 `raw`（UTF-8 string；file size 已受 1.5 MiB / `1_572_864` bytes bound，按 `stat.size` 而非 JS `string.length`）：

```text
if raw.length === 0 => empty allow
if !raw.endsWith('\n') => sink-invalid
body = raw.slice(0, -1)
lines = body === '' ? [] : body.split('\n')
if lines.some(line => line.length === 0) => internal blank => sink-invalid
if lines.length > 4096 => sink-invalid
then exact JSON/canonical validation per line
```

**语义锁定：**

| 既有状态 | 行为 |
| --- | --- |
| file missing（ENOENT） | **allow create**（pre-read 前/外层 ENOENT 分支） |
| empty file（`raw.length === 0`） | **allow** |
| non-empty 缺 final newline | **sink-invalid**（`!raw.endsWith('\n')`） |
| 仅 trailing newline 的“空 body” | `body === ''` → `lines = []` → **allow**（**不**把尾部 newline 当 blank / off-by-one） |
| internal blank（`lines` 中 `line.length === 0`） | **sink-invalid** |
| `lines.length === 4096` 且每行合法 | **allow** 再 append → 成功后文件 **4097** 行 |
| `lines.length > 4096`（含 4097） | **sink-invalid**（下次 preflight 拒绝） |
| every non-empty line | `JSON.parse` 成功；plain object；**exact 7 keys**；types/enums/hash regex/operation-action 一致性正确；`JSON.stringify(normalizedInFixedKeyOrder) === originalLine` **byte-for-byte** |
| any violation | **fixed sink-invalid**；绝不 append/truncate/delete/compact/rotate |

**TDD 必须覆盖：** missing、empty、单行合法+newline、恰好 4096 合法 → append 成 4097、随后再 preflight 因 existing 4097 拒绝、internal blank 拒、missing final newline 拒、尾部 newline 不作为 blank/off-by-one。**不得**把 4096 测成“文件永不超过 4096”的 retention 语义。

### 8.3 一致性检查（existing 每行）

1. keys exact set + count 7
2. key order when re-stringified matches fixed order
3. `schemaVersion === 1`
4. `eventKind === 'capability-real-audit-proof'`
5. `proofMode === 'real-proof'`
6. `isSupervisorLifecycleOperation(operation)`
7. `isSupervisorLifecycleActionForOperation(operation, actionId)`（**import pure SoT**；非 lifecycle 第二份 list）
8. `eventFingerprint` / `attemptRefFingerprint` match `/^[0-9a-f]{64}$/`
9. **不**要求/不能从 stored 反推 eventFingerprint 全等 preimage（raw attemptRef 不落盘）；但 **禁止**接受无法 parse / 错误 enum 的行

> 注：因 raw attemptRef 不落盘，既有行 **不能** 从磁盘重算 attemptRef preimage；fail-closed 依赖 structural/canonical byte 校验，**不**依赖“重放 raw 重建”。

### 8.4 明示非目标

- external tamper detection after open
- TOCTOU 完全消除
- WORM / immutable media
- multi-writer 跨进程锁（本版仅 process 内 **sink** Map queue）
- retention / compaction / rotation / “文件永不超过 4096”

### 8.5 Incoming event validation（append 前；与 §8.3 同级）

sink 在 queue task 内、**append 之前**，必须对 **incoming code-constructed event** 做与 existing lines §8.3 **同级**的 exact 校验：

| 检查 | 要求 |
| --- | --- |
| structural | plain object；exact 7 keys；无 extra key / symbol / getter |
| types / enums | `schemaVersion===1`；`eventKind`/`proofMode` exact；operation/action enums |
| hash form | `eventFingerprint` / `attemptRefFingerprint` 均为 `/^[0-9a-f]{64}$/` |
| operation-action SoT | `isSupervisorLifecycleActionForOperation(operation, actionId)` |
| canonical key order | 按 §7.4 固定序构造后再 stringify；顺序错误 → invalid |
| preimage 重算 | **无需/不能**从 raw attemptRef 重算（incoming 亦无 raw；与 existing 一致） |

**incoming invalid 固定结果：**

```text
→ fixed sink-invalid（lifecycle 映射 capability-real-audit-sink-invalid）
→ safeAppendText / append 未调用
→ hostSideEffectOccurred/hostMutationOccurred/auditPersistOccurred 全 false
→ mutationOutcome: 'not-attempted'
→ auditEventFingerprint: 64 hex（invoke 已在 call sink 前算完）
→ dedicated sink file 不被 poison（既有合法内容不变；missing 仍不创建污染行）
```

**TDD 必须覆盖：** hostile/malformed incoming event（wrong key set/order、bad enum、bad hash form、cross-op action、extra key）→ sink-invalid；**随后**再以合法 event 调用 **不得**因本次失败而污染 dedicated file。

---

## 9. Reentry / concurrency

| 机制 | 规则 |
| --- | --- |
| module-private `inFlightSet: Set<eventFingerprint>`（lifecycle） | **仅**阻止 **same-fingerprint** concurrent/reentrant |
| 原子同步段（强制） | 见下；**在任何 `await` 或 sink call 之前同一同步段完成** |
| finally | **必须** `inFlightSet.delete(eventFingerprint)` |
| different fingerprint | **允许** 并发进入 invoke；但 **同 root sink queue 串行**（sink Map only） |
| sequential same fingerprint after complete | **允许**（duplicate append） |
| retry/idempotency claim | **禁止** |
| sink → proof callback | **禁止**（terminal） |
| queue SoT | **仅** `capabilityAuditSinkQueues` in sink；invoke **MUST NOT** 第二 queue |
| Map/Set cleanup | **必须**计划测试；不得无限累积 |

**inFlight 原子时序（design/plan 明文冻结；fingerprint 先算再 has）：**

```text
// fingerprint 已成功计算（64hex）之后：
if (inFlightSet.has(eventFingerprint)) deny;  // receipt 仍带该 64hex
inFlightSet.add(eventFingerprint);
```

- 必须在任何 `await` 或 sink call **之前**的 **同一同步段** 完成
- deny 路径：`mutationOutcome:'not-attempted'`；occurred 三元组 false；**零第二写**；**fingerprint = 已算 64hex**
- 所有出口 `finally` delete
- **不**在 invoke 侧 enqueue sink queue；仅 `await appendCapabilityRealAuditProofEvent(...)`

**测试（barrier 证明）：**

- same-fingerprint concurrent：第二个 deny / 零第二写 / 双方 fingerprint 64hex
- different fingerprint：正常由 **sink 唯一 queue** 串行（均可成功）
- 禁止嵌套 queue / 两套 Map

---

## 10. Receipt truth tables

### 10.1 共用 base

- `receiptKind: 'capability-real-implementation-receipt'`
- 沿用既有 base schema（command / state / mode / capabilityKind / capabilityId / actionId / operation / outcomeCode / blockers / redaction / 全局 false flags / nextBlockers wiring-missing 等）

### 10.2 新增 / 冻结字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `realAuditCapabilityImplementationReady` | boolean | 局部 |
| `realRenderCapabilityImplementationReady` | boolean | 保持 |
| `realStatusCapabilityImplementationReady` | boolean | 保持 |
| `auditEventFingerprint` | `string(64hex) \| null` | 见下 |
| `auditPersistOccurred` | boolean | live |
| `hostMutationOccurred` | boolean | live |
| `hostSideEffectOccurred` | boolean | live |
| `mutationOutcome` | enum | `not-attempted \| persisted \| unknown-after-write-attempt` |

### 10.3 成功路径

| 字段 | 值 |
| --- | --- |
| `state` | `completed` |
| `outcomeCode` | `capability-real-audit-persisted` |
| `auditEventFingerprint` | 64 hex |
| `hostSideEffectOccurred` | `true` |
| `hostMutationOccurred` | `true` |
| `auditPersistOccurred` | `true` |
| `mutationOutcome` | `persisted` |
| `wouldPersistAudit` | `false` |
| `wouldMutateHost` | `false` |
| 全局 real/execute/wiring | **false** |

### 10.4 失败 / deny 路径（fingerprint Option A — 无 may/可有）

| 场景 | occurred 三元组 (sideEffect, mutation, persist) | mutationOutcome | `auditEventFingerprint` | 典型 outcome/blocker |
| --- | --- | --- | --- | --- |
| invalid request shape/fields | false,false,false | not-attempted | **null**（必须） | 见 §10.5 allowlist |
| invalid context shape | false,false,false | not-attempted | **null**（必须） | `capability-real-audit-context-invalid` |
| assertSafeDataRoot fail | false,false,false | not-attempted | **null**（必须） | `capability-real-audit-context-invalid` |
| same-inflight deny（fingerprint 已算 → has → deny） | false,false,false | not-attempted | **64 lowercase hex**（必须） | `capability-real-audit-in-flight-denied` |
| malformed existing file / over bound / preflight | false,false,false | not-attempted | **64 lowercase hex**（必须） | `capability-real-audit-sink-invalid` |
| incoming event invalid（§8.5；append 未调用） | false,false,false | not-attempted | **64 lowercase hex**（必须） | `capability-real-audit-sink-invalid` |
| append mutating call invoked then throws | **true,true,false** | **unknown-after-write-attempt** | **64 lowercase hex**（必须） | `capability-real-audit-persist-failed`；state `error` |
| success | true,true,true | persisted | **64 lowercase hex**（必须） | `capability-real-audit-persisted` |

**总规则（冻结；删除一切 may/可有 模糊措辞）：**

```text
auditEventFingerprint === null  当且仅当失败发生在 fingerprint 计算之前：
  - invalid request shape/fields
  - invalid context shape
  - assertSafeDataRoot fail

auditEventFingerprint === 64 lowercase hex  当且仅当 fingerprint 已成功计算之后的路径：
  - same-inflight deny（先算 fingerprint，再 inFlightSet.has）
  - malformed existing file / over bound / preflight fail
  - incoming event invalid（sink-invalid；append 未调用）
  - sink failure after mutating call
  - success

顺序（与 §4.5 / §6.4 同步）：
  pure request/context shape → assertSafeDataRoot → fingerprint → sync inFlight has/add → sink
```

- append 后失败：**绝不**声称 partial 行是否存在
- receipt **禁止**：dataDir / path / raw attemptRef / original event object / timestamp / eventCount / system error / stack
- **禁止**对 context/root 失败路径写 “fingerprint 可有 / may return fingerprint”

### 10.5 Fixed outcomes / blockers（至少冻结）

```text
capability-caller-injection-rejected
capability-mode-invalid
capability-kind-unknown
capability-action-unmapped
capability-operation-invalid
capability-idempotency-key-invalid
capability-real-audit-input-invalid
capability-real-audit-context-invalid
capability-real-audit-in-flight-denied
capability-real-audit-sink-invalid
capability-real-audit-persist-failed
capability-real-audit-persisted
```

（实现可将 validation 细分为 action-unmapped vs operation-invalid；须保持 allowlist 固定，禁止自由字符串 / 系统 errno 原文。）

### 10.6 Gate / Web non-live

| 表面 | 显示 |
| --- | --- |
| readiness | `realAuditCapabilityImplementationReady:true`（合法 bootstrap） |
| hostSideEffectOccurred | **false** |
| hostMutationOccurred | **false** |
| auditPersistOccurred | **false** |
| event / result / fingerprint live | **不显示** |
| executionSentinel | **仍 blocked** |
| 全局 flags | 全 false |

---

## 11. Global flags honesty

| Flag | V1.34 |
| --- | --- |
| `realAuditCapabilityImplementationReady` | **local true** only |
| `realRenderCapabilityImplementationReady` | true |
| `realStatusCapabilityImplementationReady` | true |
| `realCapabilityImplementationsReady` | **false**（3/7 incomplete） |
| `executeCapabilityRegistryReady` | **false** |
| `realRunnerWiringReady` | **false** |
| `runnerWiringContractReady` | **false** |
| `executionEligible` | **false** |
| `executeCapabilityAuthorized` | **false** |
| `realAttemptAuditImplementationReady` | **false** |
| wiring-missing primary | **仍在** |
| Gold overall | **blocked** |
| production-hardening | **仍 partial**（不 ready） |

---

## 12. Threat model（本版）

| 威胁 | 缓解 | 非覆盖 |
| --- | --- | --- |
| caller injection / prototype pollution | exact own-key + data descriptor + dangerous key reject | — |
| path traversal / symlink root | `assertSafeDataRoot` + safe-data-files | 跨进程 TOCTOU |
| 写错 HTTP audit 文件 | 独立相对路径；禁 appendAuditEvent | — |
| raw attemptRef 泄漏 | 只存/回 fingerprint | 内存短时存在（进程内） |
| 无限 queue/Set 增长 | finally cleanup + 测试 | — |
| reentry 双写同 fingerprint 并发 | inflight Set deny | 跨进程 |
| 损坏文件继续 append 污染 | fail-closed preflight | 外部篡改后的密码学链 |
| options 抬升权限 | 忽略 override；descriptor 固定 false intents | — |
| public surface 误暴露 | server/agent 零引用；无 endpoint | 操作员本地滥用 proof API |
| 假 Gold / M6d | scorecard/version 诚实测试 | — |

**禁止宣称：** tamper-proof、immutable、WORM、audit chain integrity complete、production-grade durability chronology、failure-injection evidence ready。

---

## 13. File / surface map

### 13.1 本设计/计划阶段（仅 docs）

| 文件 | 状态 |
| --- | --- |
| `docs/superpowers/specs/2026-07-18-supervisor-lifecycle-real-audit-capability-handler-design.md` | **本文件（新建）** |
| `docs/superpowers/plans/2026-07-18-supervisor-lifecycle-real-audit-capability-handler.md` | **配套 plan（新建）** |
| 其它任何文件 | **禁止修改**（含 `package-lock.json`） |

### 13.2 实现阶段允许修改（精确 allowlist；plan 任务绑定）

| 文件 | 变更 |
| --- | --- |
| `src/supervisor-lifecycle-actions.js` | **新建** pure SoT：operation→actionIds + helpers；**无** lifecycle/sink import |
| `test/supervisor-lifecycle-actions.test.js` | **新建** SoT 顺序/内容/helper 矩阵（或精确覆盖进既有 lifecycle test；计划默认独立文件） |
| `src/capability-audit-sink.js` | **新建** 独立 sink；import pure SoT 做 per-line op/action 校验 |
| `src/supervisor-lifecycle.js` | import/消费 pure SoT；`ALLOWED_OPERATIONS` 派生；`buildLifecycleActions` 仅包装 description 等；real audit registry / RealAuditProof / readiness / gate mappings / 注释；**删除第二份 action ID list** |
| `src/web/app.js` | realAudit **non-live** 固定行（无 button；无 live event） |
| `src/gold-readiness.js` | evidence/nextStep 指向 V1.34 real audit prep；仍 blocked；**不** ready production-hardening |
| `src/version.js` | → `V1.34` |
| `README.md` | 版本条 + 边界措辞；V1.34 current；保留 V1.32/V1.33 historical |
| `test/capability-audit-sink.test.js` | **新建** 独立 sink 矩阵（JSONL 算法 + API 签名） |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | real audit contract 主矩阵；既有 lifecycle 输出顺序/内容不变 |
| `test/web-console.test.js` | non-live realAudit 行 |
| `test/gold-readiness.test.js` | evidence；counts 仍 4/4/1/9 blocked |
| `test/version.test.js` | current → V1.34 |
| `test/readme.test.js` | current/historical 合同 |
| `test/cross-lan-m1-exit-audit.test.js` | **temporal semantics 最小修复**（见 §14；**必须先于** version bump 验证可绿） |

**默认禁止：** `src/agent.js`、`src/server.js`、`src/audit-log.js`（禁止改语义）、`package.json` / lockfile、真实用户 dataDir 写入测试。

### 13.3 禁止表面

- HTTP/CLI/Web proof endpoint / button / request field
- server/agent 引用 RealAuditProof / sink test hooks
- 生产调用 `appendAuditEvent` 作为 capability proof
- 真实用户 `~/...` dataDir 作为测试根（必须 `mkdtemp`）

---

## 14. Scorecard / version honesty + M1 temporal

### 14.1 Version

| 项 | 值 |
| --- | --- |
| 实现后 `LINKE_RELEASE_VERSION` | **`V1.34`** |
| V1.34 含义 | V1.x **audit milestone**（第三 real capability） |
| V2.0 | **仅 M7** |

### 14.2 Gold

| 项 | 实现后必须 |
| --- | --- |
| overall status | **blocked** |
| summary | **ready:4 / partial:4 / blocked:1 / total:9** |
| `cross-lan-connectivity` | **absent** |
| production-hardening | **仍 partial**；**不得** ready |
| automation-installation 等 | 不得因本版虚假抬升 overall |

### 14.3 M1 Exit audit 测试演进（执行顺序强制：先 temporal 后 bump）

**实现顺序（plan 任务编号与命令必须遵守）：**

1. **先**修改 `test/cross-lan-m1-exit-audit.test.js` temporal semantics
2. **仍在 V1.33** 时运行该 suite → **必须可绿**（旧 suite 不得出现计划内必红中间态）
3. **再** bump `V1.34` / version / README / gold
4. 再跑 temporal + version + gold 确认仍绿

Commit boundary：可将 temporal+version 纳入同一 boundary（步骤仍先 temporal 后 bump），或 temporal 先独立 commit；**禁止** version bump 先于 temporal 导致计划内必红。

```text
KEEP (doc snapshot — 不改 M1 audit markdown):
  audit file still records V1.33 at 47dcc2d
  VERSION_MUTATION: NONE / SCORECARD_MUTATION: NONE
  4/4/1/9 at audit time
  M1_EXIT_STATUS: BLOCKED_RECORDED

CHANGE (runtime assertions only in test file):
  DO NOT assert LINKE_RELEASE_VERSION === 'V1.33' forever
  ASSERT overall blocked
  ASSERT no cross-lan-connectivity item
  ASSERT M1/M2 not elevated (crypto still blocked narrative; no M2 handshake entry)
  ALLOW runtime version V1.34 after release bump
```

**禁止：** 把 audit markdown 历史版本改成 V1.34；依赖 git history CLI；shallow clone 特例逻辑。

---

## 15. TDD 矩阵（实现阶段摘要；plan 展开为可执行任务）

| # | 场景 | 期望 |
| --- | --- | --- |
| T1 | readiness：三 local true + 全局 real false | realAudit true；3 entries；wiring-missing |
| T2 | bootstrap size 3；无 write/reload/rollback/notify real | exact kinds |
| T3 | dry-run audit 仍 plan-only | 无 sink write |
| T4 | authorize pure；无 context；valid matrix | authorized |
| T5 | invoke happy：四 operation × 各 action 子集矩阵 | persisted；fingerprint；file 0600 |
| T6 | fingerprint preimage exact（attemptRef + event） | 64 hex 固定向量 |
| T7 | canonical line key order byte-for-byte | 精确 |
| T8 | sequential duplicate same fingerprint | 第二行 append；不 dedup |
| T9 | concurrent same fingerprint | in-flight denied；occurred false |
| T10 | concurrent different fingerprint same root | queue 串行均成功 |
| T11 | reentry 禁止 sink→proof | 无第二 attempt |
| T12 | Set/Map cleanup | 无泄漏 |
| T13 | missing file create；empty allow；单行合法+newline | ok |
| T14 | missing final newline | sink-invalid |
| T15 | internal blank line / bad JSON / wrong keys / wrong order | sink-invalid |
| T15b | 尾部 newline 不当 blank/off-by-one（`body===''` → lines=[]） | allow |
| T16 | oversize >1.5 MiB（`bound + 1` byte / `1_572_864 + 1`） | sink-invalid |
| T16b | existing 恰好 4096 合法行 | validation pass；允许 append 第 4097 行（非 retention） |
| T16c | existing 4097 行（或 >4096） | 下次 preflight sink-invalid |
| T16d | same-fingerprint concurrent barrier | 第二 deny；零第二写；双方 64hex fingerprint |
| T16e | pure SoT：lifecycle 输出顺序/内容不变；sink 用 shared 校验 | 无第二 action list |
| T16f | hostile/malformed **incoming** event | sink-invalid；append 未调用；occurred false；文件不 poison |
| T16g | queue 单一归属 | 仅 sink Map；invoke 无第二 queue / 无 pre-read |
| T17 | symlink root / traversal / bad dataDir | context-invalid；**fingerprint null**；无写 |
| T18 | events.jsonl untouched | 内容不变或不存在 |
| T19 | append failure after call | unknown-after-write-attempt；**64hex fingerprint** |
| T20 | invalid request hostile objects | injection/input-invalid；**fingerprint null** |
| T21 | invalid context extra keys/getter | context-invalid；**fingerprint null** |
| T21b | assertSafeDataRoot fail | context-invalid；**fingerprint null** |
| T21c | same-inflight / malformed existing / incoming invalid | **64hex fingerprint**（先算后 has/sink） |
| T22 | execute mode zero dispatch/write | 无 sink / 无 appendAuditEvent |
| T23 | options cannot elevate | 全局 false；intent flags false |
| T24 | Gate/Web non-live | occurred false；无 event 显示 |
| T25 | no agent/server proof refs | 扫描 0 |
| T26 | secret category scan | path/raw attemptRef/dataDir 0 回显 |
| T27 | version V1.34 + Gold 4/4/1/9 blocked | 诚实 |
| T28 | M1 exit audit temporal semantics | snapshot V1.33；runtime not forever V1.33 |
| T29 | README current/historical | V1.34 current |
| T30 | 不碰 package-lock；无新 dependency | scope |
| T31 | 所有写在 mkdtemp；cleanup pattern | 无真实用户 dataDir |
| T32 | wouldPersistAudit false 与 auditPersistOccurred true 并存 | intent vs live |

---

## 16. Rollback

| 场景 | 动作 |
| --- | --- |
| docs-only 阶段 | 删除两份新文档即可；无代码回滚 |
| 实现越界（碰 events.jsonl / 抬升 global / 改 agent/server） | 丢弃工作区；回到实现前 clean anchor；按 plan 重做 |
| version 误升 V2.0 / Gold ready | **立即**回退 version/scorecard/README；禁止发布 |
| 测试污染真实 dataDir | 停止；清理仅限 mkdtemp；审计是否误用路径 |

**禁止**常规步骤写 `git reset --hard`。

---

## 17. 完成标准

### 17.1 本 docs 阶段完成标准

- [x] 仅新建 design + plan 两文件（本阶段目标）
- [ ] `git diff --check` 两文件无 whitespace error
- [ ] 无源码/测试/版本/lockfile 修改
- [ ] 冻结 A–L 全部权威事实
- [ ] **不**声称 PROCEED = 实现完成
- [ ] 等待 fresh review / PM gate 后才允许 TDD 代码

### 17.2 实现阶段完成标准（摘要）

- real registry 3/7；local realAudit true；全局 flags 全 false
- 独立 sink + 不碰 events.jsonl / appendAuditEvent
- receipt truth tables 全覆盖
- TDD 矩阵绿；full `node --test` 绿
- V1.34 + Gold 4/4/1/9 blocked + 无 cross-lan-connectivity
- M1 audit temporal 兼容
- Web non-live；server/agent 零引用
- 无新 dependency；无生产 write 测真实 dataDir

### 17.3 明确非完成（forbidden claims 逐项）

禁止在 README/Gold/commit/message/Web 声称：

1. Gold ready / GA ready
2. M2 / cross-LAN / dual-host complete
3. execute authorized / wiring ready
4. global `realCapabilityImplementationsReady`
5. production-grade audit
6. `realAttemptAuditImplementationReady` / realAttemptAudit wiring ready
7. idempotency / dedup store
8. retention / rotation complete
9. tamper-proof / immutable / WORM
10. audit chain integrity（T6d.3）complete
11. durability chronology proved
12. failure-injection suite evidence ready
13. scorecard `production-hardening` ready / M6d Exit
14. V2.0

---

## 18. 与后续里程碑的关系

```text
V1.34 real-audit proof (this)
  → 预备：独立 sink 合同 + mutationOutcome 真理
  ↛ T6d.3 audit-chain-integrity（另任务）
  ↛ realAttemptAuditImplementationReady（execute wiring 另任务）
  ↛ M6d Exit
  ↛ M7 / V2.0 Gold

可并行：M5 cross-LAN work（本版零依赖）
不可并行冒充：用本版 sink 充 cross-LAN audit-chain 或 Gold
```

---

## 19. Source-of-truth

| 主题 | SoT |
| --- | --- |
| operations/actions IDs | **`src/supervisor-lifecycle-actions.js`（唯一 pure SoT）** |
| lifecycle action 包装 | `buildLifecycleActions` 仅消费 shared IDs + description/status/would*；`ALLOWED_OPERATIONS` 从 shared 派生 |
| cross-cutting audit actions | `CAPABILITY_KIND_ACTION_IDS.audit` + **shared** operation/action 交集校验 |
| safe IO | `src/safe-data-files.js` |
| HTTP audit（禁止复用） | `src/audit-log.js` |
| dual registry / proof pattern | `src/supervisor-lifecycle.js` V1.32/V1.33 |
| sink 合同 | 本 design §6–§9；API = `appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)`；**唯一 queue SoT** |
| JSONL preflight | 本 design §8.2 算法（1.5 MiB / `1_572_864` file-size bytes + **existing** 4096-line validation bound；非 retention） |
| incoming event | 本 design §8.5（与 §8.3 同级；无 raw preimage 重算） |
| fingerprint 时序 | 本 design §4.5/§6.4/§10.4 Option A：shape → assert root → fingerprint → inFlight → sink |
| inFlight 时序 | 本 design §9：fingerprint 先算；同步段 `has→deny / add` + finally delete |
| M6d/M7 | `docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md` |
| M1 temporal | `docs/superpowers/specs/2026-07-18-linke-v2-m1-exit-audit.md`（historical V1.33@47dcc2d 不改） |
| 版本 | `src/version.js`（实现后 V1.34；bump **晚于** temporal test 绿） |
| Gold | `src/gold-readiness.js`（仍 blocked 4/4/1/9） |

---

**文档状态：** design frozen for review（docs only）。
**下一闸：** fresh review + PM；通过后按配套 plan 做 TDD 实现。
**不声称：** 实现完成 / M6d ready / Gold ready / PROCEED=done / 审核 PASS。
