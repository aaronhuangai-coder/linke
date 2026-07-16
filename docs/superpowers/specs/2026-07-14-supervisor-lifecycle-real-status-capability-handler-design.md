# V1.33 Supervisor Lifecycle Real Status Capability Handler Design

## 目标

V1.33 在 **V1.32 first real render capability** 基线（`c311a7e`）上，交付**第二个诚实 real implementation handler**：`status` / `capture-current-state`，语义为 **real observational host metadata read**（宿主固定目标元数据只读观测），**不是** host mutation，**不是** 读取/解析 plist 内容，**不是** 注入静态数据冒充 real，**不是** 扩 V1.32 render-specific proof API 的 kind 范围。

> **选定能力：`status`（`capture-current-state`，operation=`rollback`）**
> 作为 **real observational implementation**（真实只读宿主元数据观测 + sanitized bounded schema），
> **`hostMutationOccurred:false`**；真实 fs observation 一旦开始：
> **`hostObservationOccurred:true`** 且 **`hostSideEffectOccurred:true`**（遵守 V1.32 历史定义，见 §1.4）。

本版建立：

1. **术语分离**：`hostMutation` ≠ `hostObservation` ≠ dry-run stub；观测只读可 real，且不得抬升 mutation / execute / Gold。**不重定义** V1.32 `hostSideEffectOccurred`
2. **trusted bootstrap 双轨扩展**：保留 7 dry-run + 1 real render；**追加** 1 real status（合计 **7 dry-run + 2 real**）
3. **独立 @internal PROOF ONLY RealStatusProof API**（不扩 `RealRenderProof`；不引入宽泛 generic framework）
4. **局部 fact**：仅 `realStatusCapabilityImplementationReady` 可 true；全局 real / execute / wiring / Gold **保持 false/blocked**
5. **固定 allowlist 异步宿主 metadata reader**（Node `fs/promises` only；禁止 shell；禁止用户控制 path/argv；**禁止** 读内容字节 / 内容 hash）

### 关键边界（必须先读）

| 层级 | V1.33 是否完成 | 含义 |
| --- | --- | --- |
| **second real implementation handler (`status`)** | **是** | 诚实 observational host **metadata** read；sanitized/bounded/deterministic schema |
| **first real render（V1.32）** | **保持** | 不回归；不扩 RealRenderProof kind |
| **dry-run registry（7 kinds）** | **保持** | V1.31/V1.32 dry-run 路径不变 |
| **`realStatusCapabilityImplementationReady`** | **可 true** | **仅** status 局部 fact |
| **`realRenderCapabilityImplementationReady`** | **保持 true** | V1.32 局部 fact |
| **`realCapabilityImplementationsReady`（全局）** | **否** | 仅 2/7 real；**恒 false**（独立事实，见 §7.2） |
| **`executeCapabilityRegistryReady` / `executeCapabilityAuthorized`** | **否** | 完整 execute 公式仍不满足；execute **仍 hard-deny 且零 dispatch** |
| **host mutation（launchctl write/load/unload、fs write、network、audit persist、notify）** | **否** | **禁止**；`hostMutationOccurred:false` |
| **host observation（固定 path 元数据 lstat/open-stat/close；无 content read）** | **是（本版）** | 仅 fixed allowlist；observe 路径 `hostObservationOccurred:true` 且 `hostSideEffectOccurred:true` |
| **`realRunnerWiringReady` / `runnerWiringContractReady`** | **否** | **禁止**因本版变 true |
| **`executionEligible` / `wouldExecute`** | **否** | 恒 false |
| **消解 `real-guarded-runner-execution-wiring-missing`** | **否** | 仍在 |
| **§4.5 idempotency store / persist audit sink** | **否** | 本版**不**落地 B/C |
| **Gold / GA 发布** | **否** | scorecard 继续 `blocked`；**Gold/GA 仅在 V2.0 定义**（§12.4） |
| **跨局域网协同 / same-LAN multi-host status** | **否** | **V2.0 强制里程碑**；独立协议与威胁模型；**不**暗示本版 LAN status 完成 Gold |
| **G0a dual-host 作为 capability execute 前置** | **否** | 不消费 G0a PASS 为 capability dual-host locus |

**严禁**把 real status proof completed、`realStatusCapabilityImplementationReady:true`、静态 `buildSupervisorStatusResponse` 骨架、dry-run receipt、`wiringPlanSeal` seal-ready、或 policy `authorized` 冒充：

- `realCapabilityImplementationsReady:true`（全局）
- `realRunnerWiringReady:true`
- `runnerWiringContractReady:true`
- `executionEligible:true`
- `executeCapabilityAuthorized:true`
- host mutation / launchctl write-load-unload / fs write / network / audit persist / notify
- Gold ready / GA ready / 跨局域网 Gold

**恢复锚点：** `c311a7e`（`feat: add V1.32 first real render capability`）。实现越界时回到该 commit 的干净状态再重做（见 §11.4；**禁止**在 plan/docs 中建议 `git reset --hard` 作为常规步骤）。

---

## 0. 源码事实基线（c311a7e / V1.32，不得猜）

以下全部来自当前 `src/supervisor-lifecycle.js` / `src/server.js` / `src/agent.js` / `src/web/app.js` / `src/gold-readiness.js` / `src/audit-log.js` / `src/version.js` / 相关 tests / V1.31–V1.32 specs。

### 0.1 V1.32 已完成与仍 blocked

| 项 | c311a7e 事实 |
| --- | --- |
| capability kinds allowlist | `render \| write \| reload \| status \| rollback \| audit \| notify` |
| dry-run registry | 7 kinds；`implementationClass:'dry-run-non-side-effect'`；`supportsModes:['dry-run']` |
| real registry | **仅** `render`；`capabilityId:'real-render'`；`supportsModes:['real-proof']`；`sideEffectClass:'none'` |
| dual registry size | **7 dry-run + 1 real** |
| RealRenderProof API | `authorize...RealRenderProof` / `invoke...RealRenderProof`；`@internal PROOF ONLY`；server/agent **零引用** |
| render 证明物 | `contentSha256` + `renderedByteLength`；`hostSideEffectOccurred:false`（render **不**读 host 受控资源） |
| execute 路径 | hard-deny；**不** dispatch real 或 dry-run handler |
| `realRenderCapabilityImplementationReady` | **true**（局部） |
| `realCapabilityImplementationsReady` | **false**（全局） |
| `executeCapabilityAuthorized` | **false** |
| `idempotencyKeyFingerprint` | 生产 **固定 null**；idempotency store **不存在** |
| `realAttemptAuditImplementationReady` | **false**；attempt-audit 仅 pure plan |
| wiring aggregate | `readyCount:6` / `blockedCount:0` / `state:'blocked'` + wiring-missing |
| `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` | **false** |
| Web | shall realRender 行 + `executionSentinel` 恒 blocked |
| Gold | **blocked**；automation-installation **partial** |
| 版本 | `LINKE_RELEASE_VERSION = 'V1.32'` |
| V1.32 文档对未来 status | §6 预留：timeout / argv allowlist / no shell / 失败注入；**未实现** |
| RealRenderProof 扩 kind | **明确禁止**；须独立 proof API 或另设计 generic framework |

### 0.1.1 V1.32 对 `hostSideEffectOccurred` 的历史定义（权威；不得重定义）

V1.32 design §1.3 明文：

```text
host side effect = 改变或读取 host 受控资源：
  fs mutate、launchctl、process list/control、network、audit persist、external notify
```

**推论（V1.33 强制遵守）：**

- **读取** host 受控资源（含固定 path 上的 fs lstat / open / stat 观测）**属于** host side effect。
- render real 不读 host 受控资源 → `hostSideEffectOccurred:false`（V1.32 正确且保持）。
- status real 一旦开始真实 fs observation → **`hostSideEffectOccurred:true`**，同时 **`hostMutationOccurred:false`**。
- V1.33 **禁止**把 `hostSideEffectOccurred`「收紧」为仅 mutation/elevated IO，以把 observational read 藏成 false。
- `hostSideEffectOccurred:true` **不**抬升 execute / 全局 real / wiring / Gold（与 real implementation 正交；见 §1.4 强制推论）。

### 0.2 `buildLifecycleActions` 与 primary capability map（权威）

```text
install:
  render-launch-agent-plist  → render
  write-launch-agent-plist   → write
  load-launch-agent          → reload

uninstall:
  unload-launch-agent        → reload
  remove-launch-agent-plist  → write
  remove-supervisor-metadata → write

rollback:
  capture-current-state      → status     ← V1.33 real 目标
  restore-previous-plist     → rollback
  restart-previous-supervisor→ reload

recover:
  start-recovery-supervisor  → reload
```

固定映射（源码 `CODE_OWNED_ACTION_PRIMARY_CAPABILITY_MAP`）：

```js
'capture-current-state': 'status'
```

固定 kind→actionIds：

```js
status: Object.freeze(['capture-current-state'])
```

dry-run plannedAction：`capture-state`（`resolveDryRunPlannedAction`）。

### 0.3 既有 status / supervisor-status 表面（复用审查 — 关键）

| 表面 | 位置 | 行为 | 是否真实宿主观测 | V1.33 可否作 real 证据 |
| --- | --- | --- | --- | --- |
| `buildSupervisorStatusResponse()` | `src/server.js` | **静态**返回 `installed:false`…`state:'not_configured'`；`safety.processListRead:false` 等恒 false | **否** — 硬编码骨架 | **否** — 注入静态数据冒充 real 违反诚实目标 |
| `GET /api/supervisor-status` | `src/server.js` | 调用上列 builder | **否** | **否** — 且本版禁止改 server public surface |
| Agent `supervisor-status` | `src/agent.js` | 拉 API 并校验 schema | **否** | **否** — 透传静态 partial |
| Web `buildSupervisorStatusViewModel` | `src/web/app.js` | 渲染 API partial | **否** | **否** |
| dry-run status handler | `createDryRunCapabilityHandler('status')` | 仅 `plannedAction:'capture-state'` | **否** | **否** — stub 计划 |
| host-mutation adapter `capture-state-mutation` | pure map 标识符 | **不**读 host；`processListReadAllowed:false` | **否** | **否** — pure contract only |
| attempt-audit `capture-state-attempt-audit` | pure map | **不** persist | **否** | **否** |

**结论（禁止误复用）：**

1. **不能**把 `buildSupervisorStatusResponse` 的静态字段直接或间接当作 real status proof 产物。
2. **不能**复制一个宽泛 shell wrapper（`sh -c`、字符串拼接 launchctl、用户 path）再包一层叫 real。
3. **不能**通过调用 server API 自指“观测”来制造闭环假证据。
4. 可复用的仅是：**字段命名灵感**（boolean / enum 状态）与 **脱敏纪律**（safety flags、不回显 path/token 原文）；实现必须在 `supervisor-lifecycle` capability 路径内新建 **独立 fixed-path observational metadata reader**。

### 0.4 §4.5 六证据 locus 现状（B/C 相关）

| locus | c311a7e 事实 | 写宿主？ | 本版 |
| --- | --- | --- | --- |
| idempotency store | **不存在**；fingerprint 固定 null | 若落地 store 通常 **是**（持久化） | **不做（拒绝 B）** |
| real rollback anchor | `realRollbackAnchorImplementationReady:false` | 未来 write/restore **是** | 不做 |
| persist audit sink | `realAttemptAuditImplementationReady:false`；`appendAuditEvent` 存在于 audit-log 但 **未** 挂 capability real | **是** | **不做（拒绝 C）** |
| recovery / notify path | false | 可能外部 notify | 不做 |
| dual-host evidence（capability 侧） | 不存在 | 可能网络 | 不做 |
| failure-injection suite evidence | 生产无 inject | n/a | 本版 **测试矩阵** 覆盖 failure 映射；**不**宣称 execute locus ready |

### 0.5 `executionEligible` / execute 公式（权威；本版仍不可满足）

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
  realCapabilityImplementationsReady &&   // 全局；2/7 仍 false
  executeCapabilityRegistryReady &&       // 仍 false
  idempotency + rollback sink + audit sink + recovery/notify &&
  dual-host evidence recorded &&
  failure-injection suite evidence recorded &&
  handler.implementationClass ∈ REAL_IMPLEMENTATION_CLASSES &&
  handler.supportsModes includes 'execute'
```

**V1.33 结论：** 即便 real status handler 已注册并 proof 成功，**execute 仍必须 hard-deny 且零 dispatch**；验证 real status 走 **独立 RealStatusProof**，**不**开放 execute。

---

## 1. 候选评估与选定（A / B / C）

### 1.1 评估矩阵

| 准则 | A：real status / capture-current-state | B：§4.5 idempotency store locus | C：persist audit sink / real audit |
| --- | --- | --- | --- |
| **Gold blocker 价值** | **高（直接）**：推进 dual real registry 1→2；对齐 gold nextStep「按 kind 注册 real handlers」 | 中：execute 公式单项；**不**增加 real capability kind | 中：execute 公式单项；**不**增加 real kind；audit pure 已 ready |
| **安全 blast radius** | **中低**：只读**元数据**观测；可控 fixed path；无 mutation；无 content read | **中高**：持久化 store → 写盘 / 状态污染 / replay 语义错误面 | **高**：immutable audit persist → 写 events.jsonl / 与 server audit 耦合 |
| **可测试性** | **中高**：enum/boolean 可 deterministic 化；async timeout/race 矩阵清晰；CI 可在 absent 路径稳定 | 中：需 store lifecycle / crash / concurrency | 中：IO + 脱敏 + 保留策略 |
| **已有代码复用** | **低但干净**：status API 是静态骨架不可复用；可复用 V1.32 dual-registry / proof 模式 | 低：仅 blocker code / null fingerprint 占位 | 中：`audit-log.js` 可写，但 **semantic 是 HTTP audit**，非 capability attempt-audit sink |
| **是否会写宿主** | **否**（合同强制） | **是**（store 落地即写或至少 durable state） | **是** |
| **是否需要 public surface** | **否**：@internal proof only；默认零 server/agent 引用 | 可能新 module；易诱使 execute 侧接线 | 易诱使 appendAuditEvent 进 gate 热路径 |
| **失败恢复** | **易**：无 mutation；失败 = fixed error receipt | 中：store 损坏 / 半写 | 难：audit 半写、不可变语义冲突 |
| **与 V1.32 路线一致性** | **高**：nextStep 明确「next real kind via separate proof API」 | 偏 execute locus，跨层 | 偏 wiring real audit，跨层 |
| **诚实性风险** | 若复用静态 status API → **极高**（本设计显式禁止） | 易把 fingerprint 非 null 误抬升 execute | 易把 pure attempt-audit ready 误抬升 real audit |

### 1.2 源码证据为何不支持 B/C 更安全且更高价值

1. **B 会写宿主或引入 durable state**：当前 `idempotencyKeyFingerprint` 固定 null，store 不存在；落地 store 立刻扩大 blast radius，且 **不** 证明任一 real capability handler 语义。
2. **C 明确仍是高风险写路径**：V1.28 合同把 `realAttemptAuditImplementationReady` 恒 false；`appendAuditEvent` / `events.jsonl` 是另一条 surface；挂 capability real audit 等于 **首次 host-mutating capability 邻近路径**，比 observational status 更危险。
3. **Gold nextStep（automation-installation）** 在 V1.32 后明确指向：**next real kind via separate proof API or generic framework + §4.5 loci**；在 2/7 real 之前优先单点 store/audit **不会**更快解除「real handlers 缺失」主 blocker 叙事。
4. **execute 公式仍有多项 false**；单独 B 或 C **不能**使 `executeCapabilityAuthorized` 变 true，却引入 write 面。
5. 因此：**除非**未来源码出现「无写盘 memory-only idempotency 且被 execute 唯一阻塞」的证据，否则 **B/C 不优于 A**。

### 1.3 选定

```text
V1.33 SELECTED_CAPABILITY = status
SELECTED_ACTION_ID        = capture-current-state
SELECTED_OPERATION        = rollback
SELECTED_MODE             = real-proof
PROOF_API                 = RealStatusProof（独立；不扩 RealRenderProof）
HOST_IO                   = observational metadata read only
                          （Node fs/promises 固定 path；无 content read；无 shell）
```

**明确拒绝本版：**

- **B**：§4.5 idempotency store locus 落地
- **C**：persist audit sink / real audit capability / 调用 `appendAuditEvent` 作为 status 证据
- `write` / `reload` / `rollback` real（host-mutating）
- `audit` / `notify` real
- 扩 `RealRenderProof` 接受 `status` kind
- 用 `buildSupervisorStatusResponse` 静态 JSON 冒充 observational real
- 宽泛 shell wrapper / `shell:true` / 用户可控 command、argv、path
- launchctl load/unload/bootstrap/kickstart/write、fs write、network、notify
- **sync** `lstatSync` / `openSync` / `readSync` 生产 reader
- **读取 plist 字节** / 解析 plist / 返回 raw size/inode/timestamps/path/hash
- **`contentSha256` 对文件内容**（任何形式）
- 跨局域网 / same-LAN multi-host status / Gold-GA 宣称

### 1.4 术语定义（强制；全文档与 API 语义以此为准）

| 术语 | 定义 | V1.33 对 status 的取值 |
| --- | --- | --- |
| **dry-run non-side-effect** | 仅模拟计划；无真实观测字段 | 仍保留 `dry-run-status` |
| **real implementation** | 真实执行 capability 语义并产生可验证产物（**真实产物，非 stub**）；与 host mutation / host side effect **正交** | **是**（本版交付） |
| **host mutation** | **改变** host 受控资源：fs write/rm、launchctl load/unload/bootstrap、process control/kill、network send、audit persist、external notify | **否**；`hostMutationOccurred:false` |
| **host observation** | **只读观测** host 固定 path 元数据：逐层 lstat、`open(O_RDONLY\|O_NOFOLLOW)`、`FileHandle.stat`、close；**不含** content read；**不含** mutation | **是**；真实 fs observation 开始后 **true** |
| **`hostSideEffectOccurred`** | **V1.32 历史伞形字段，不得重定义**：本次是否发生「**改变或读取** host 受控资源」。含 observational fs metadata read | 真实 fs observation 开始后 **true**；validation/injection 未入 reader **false**；Gate/Web 非 live **false** |
| **`hostMutationOccurred`** | 本次是否发生 host mutation | **false**（全路径） |
| **`hostObservationOccurred`** | 本次是否执行了真实宿主只读观测（非注入静态表） | 真实 reader 调用开始后 **true**；validation deny 未读 host 时 **false** |
| **`real-implementation`** | class：真实实现；sideEffectClass 可 observational | status 使用 |
| **`sideEffectClass:'observational-read'`** | 诚实 class 细分：只读元数据观测；**不是** `real-side-effect` mutation class name abuse | status real descriptor |
| **`real-side-effect`（未来）** | 会 host mutation 的 real handler | **本版不注册** |

**观测路径三元布尔（锁定）：**

```text
# 真实 fs observation 一旦开始（含 ENOENT/EACCES/symlink 等已进入 reader 的诚实观测）
hostObservationOccurred  = true
hostSideEffectOccurred   = true    // V1.32：读 host 受控资源 = side effect
hostMutationOccurred     = false

# validation / caller-injection 在 reader 前失败
hostObservationOccurred  = false
hostSideEffectOccurred   = false
hostMutationOccurred     = false

# Gate / Web 非 live observe（仅 readiness/gate facts）
hostObservationOccurred  = false
hostSideEffectOccurred   = false
hostMutationOccurred     = false
```

**强制推论：**

```text
real status proof completed（observe 路径）
  ⇒ hostObservationOccurred === true
  ⇒ hostSideEffectOccurred === true
  ⇒ hostMutationOccurred === false

real status proof completed ⇏ realRunnerWiringReady
real status proof completed ⇏ realCapabilityImplementationsReady（全局）
real status proof completed ⇏ executeCapabilityAuthorized
real status proof completed ⇏ executionEligible
hostSideEffectOccurred:true ⇏ execute / wiring / Gold 抬升
static buildSupervisorStatusResponse ⇏ real observation evidence
```

**代码注释合同（registry/handler 附近 must）：**

```text
// real status = 真实宿主元数据观测非 stub；hostMutationOccurred=false
// 真实 fs observation 开始后：hostObservationOccurred=true 且 hostSideEffectOccurred=true
// （遵守 V1.32：读 host 受控资源 = side effect；不得重定义该历史字段）
// observational-read ≠ host mutation；不得抬升 execute / 全局 real / wiring / Gold
```

---

## 2. 设计选择总览

| 组件 | V1.32 | V1.33 |
| --- | --- | --- |
| dry-run registry | 7 kinds | **保持** 7 |
| real registry | 仅 render | **render + status**（size **2**） |
| bootstrap | dry-run + real render | **+ real status** |
| RealRenderProof | render-specific **sync** | **保持；禁止扩 kind** |
| RealStatusProof | 无 | **新增独立 async API** |
| receipt kinds | + real-implementation-receipt（render） | **同 receiptKind**；靠 capabilityId/outcome/statusResult 区分 |
| 局部 ready | `realRender*Ready` | **+ `realStatusCapabilityImplementationReady`** |
| 全局 realCapabilityImplementationsReady | false | **false**（独立事实） |
| execute | hard-deny 零 dispatch | **保持** |
| wiring-missing / Gold / executionSentinel | blocked | **保持** |
| agent.js / server.js / package.json | 默认未改 proof | **默认禁止改** |
| 新 endpoint / CLI / Web button / request field | 无 | **无** |
| host reader | n/a | **async fs/promises metadata-only** |

### 字段命名（禁止混淆）

| 名称 | 类型 | V1.33 语义 |
| --- | --- | --- |
| `realStatusCapabilityImplementationReady` | **局部** fact | status real handler trusted 注册且 proof 契约就绪 |
| `realRenderCapabilityImplementationReady` | **局部** fact | **保持** V1.32 |
| `realCapabilityImplementationsReady` | **全局** | **恒 false**（2/7）；**独立事实**，不是 ready 输入谓词的「成功信号」 |
| `executeCapabilityAuthorized` | mode | **恒 false** |
| `hostMutationOccurred` | 调用结果 | status proof **false** |
| `hostObservationOccurred` | 调用结果 | 真实 reader 调用开始后 **true** |
| `hostSideEffectOccurred` | 调用结果 | 真实 reader 调用开始后 **true**（V1.32 定义）；validation/Gate/Web **false** |
| `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` | gate | **恒 false** |
| `capability-real-implementation-receipt` | receiptKind | real status/render proof 共用 kind；**NOT** execute receipt |
| Web `executionSentinel` | UI | **恒 blocked** |

**禁止别名：** `statusReady`（含糊）、`realWiringReady`、`observationReady` 单独冒充 wiring、`capabilitySeal`、把 statusResult 叫 `supervisor` 并等同 server status API。

---

## 3. Proof API 策略：独立 RealStatusProof（选定）vs generic framework（拒绝）

### 3.1 二选一论证

| 选项 | 做法 | 优点 | 缺点 | 判定 |
| --- | --- | --- | --- | --- |
| **P1：独立 RealStatusProof** | 新增 `authorize...RealStatusProof` / `invoke...RealStatusProof`；request/result schema 专属 status | 贴合 V1.32 强制合同；schema 隔离；失败码清晰；server/agent 零引用可测 | 两套 proof API 有样板重复 | **选定** |
| **P2：严格 generic framework** | 统一 `...RealCapabilityProof(kind,…)` + per-kind schema registry | 长期扩 kind 成本低 | V1.33 仅第 2 个 real；过早抽象易把 kind 校验变软；render/status I/O 异构（sync hash 产物 vs async observation enum）；风险把 injection surface 做大 | **拒绝（本版）** |

**选定 P1 理由（源码合同驱动）：**

1. V1.32 §5.2.1 明文：未来 kind **不得**扩 RealRenderProof；须 **独立 proof API** 或 **另开** generic framework 设计。
2. status 需要 `statusInput` / `statusResult` / `hostObservationOccurred` / async observational failure codes — 与 `renderInput` / `renderResult` 不同构。
3. 在仅 2 real kinds 时，generic framework 的正确性证明成本高于样板复制；framework 应在 **≥3 real kinds 或 execute 接线前** 另开 design。

**禁止：** 在 `invoke...RealRenderProof` 内 `if (kind==='status')` 分支。

### 3.2 Export 合同

```js
/**
 * @internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint
 * Authorize real-proof mode for **status only**. Never authorizes execute.
 * Status-specific: do not reuse this API for other real kinds.
 * Sync validation only — does not call host reader.
 */
export function authorizeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(request)

/**
 * @internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint
 * Invoke real **status** observational implementation proof (async).
 * Metadata-only host observation via Node fs/promises; never reads file content.
 * On real fs observation start: hostObservationOccurred=true AND
 * hostSideEffectOccurred=true AND hostMutationOccurred=false
 * (V1.32: reading host-controlled resources is a host side effect).
 * Never accepts mode execute. Never returns functions / raw paths / raw stdout / content hashes.
 * Status-specific proof API — do not expand kind range.
 * @returns {Promise<object>} single settled receipt
 */
export async function invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(request)
```

| 检查 | 要求 |
| --- | --- |
| `src/server.js` | **零** `RealStatusProof` / `RealRenderProof` 引用 |
| `src/agent.js` | **零** 引用 |
| Web button / CLI flag / HTTP route | **禁止** 挂载 |
| 允许引用 | `src/supervisor-lifecycle.js` + `test/**` |

---

## 4. Trusted bootstrap：双轨注册扩展

### 4.1 注册结构

```text
dryRunCapabilityRegistry: Map<kind, {descriptor, handler}>   // 保持 7
realCapabilityRegistry:   Map<kind, {descriptor, handler}>   // V1.33: 'render' + 'status'
```

**禁止** 覆盖 dry-run。
**禁止** export `registerCapability` / 接受 `options.handlers`。

### 4.2 Real status descriptor（exact）

```js
{
  capabilityKind: 'status',
  capabilityId: 'real-status',
  implementationClass: 'real-implementation',
  sideEffectClass: 'observational-read',   // NOT none；NOT real-side-effect mutation class name abuse
  supportsModes: ['real-proof'],           // 本版不含 'execute'
  actionIds: ['capture-current-state'],
  realImplementationReady: true,
  wouldMutateHost: false,
  wouldPersistAudit: false,
  wouldNotifyExternal: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,          // 本版不做 process list dump
  networkAllowed: false,
  metadataWriteAllowed: false,
  auditWriteAllowed: false,
  rollbackAnchorWriteAllowed: false,
  hostObservationAllowed: true,           // 新增局部 flag；仅 status real
  contentReadAllowed: false,              // 显式：禁止读文件内容
  evidenceCode: 'capability-real-status-implementation-ready',
  blockerCode: null,
}
```

### 4.3 trustedBootstrap 增量算法

```text
// after V1.32 real-render registration:
8. build real-status descriptor (exact §4.2)
9. validate:
     implementationClass === 'real-implementation'
     sideEffectClass === 'observational-read'
     supportsModes exact ['real-proof']
     realImplementationReady === true
     hostObservationAllowed === true
     contentReadAllowed === false
     wouldMutateHost === false
     全部 mutation *Allowed === false
     processListReadAllowed === false
     actionIds exact ['capture-current-state']
10. realCapabilityRegistry.set('status', {
      descriptor,
      handler: createRealStatusCapabilityHandler(/* production reader only */)
    })
11. assert realCapabilityRegistry.size === 2
12. assert has('render') && has('status')
13. assert !has('write'|'reload'|'rollback'|'audit'|'notify')
14. production bootstrap MUST bind default async metadata reader
15. production bootstrap MUST NEVER call set*ForTest / inject hooks
```

### 4.4 Readiness 局部事实

```js
// readiness object 增量
realRenderCapabilityImplementationReady: true|false   // 保持 V1.32 probe
realStatusCapabilityImplementationReady: true|false   // 新
realCapabilityImplementationsReady: false             // 全局恒 false（独立事实）
realImplementationEntries: [
  { capabilityKind:'render', capabilityId:'real-render', ... },
  { capabilityKind:'status', capabilityId:'real-status', sideEffectClass:'observational-read', ... },
]
```

**`isRealStatusCapabilityRegistryReady()`** 与 render probe **分离**（per-kind local readiness）。
**禁止** 用「任一 real ready」冒充全局 `realCapabilityImplementationsReady`。

### 4.5 real-status-proof 授权公式（局部；≠ execute）

```text
realStatusProofAuthorized =
  request.mode === 'real-proof' &&
  request.capabilityKind === 'status' &&
  request.actionId === 'capture-current-state' &&
  request.operation === 'rollback' &&
  real status registry entry exists &&
  entry.descriptor.implementationClass === 'real-implementation' &&
  entry.descriptor.sideEffectClass === 'observational-read' &&
  entry.descriptor.supportsModes includes 'real-proof' &&
  entry.descriptor.realImplementationReady === true &&
  entry.descriptor.hostObservationAllowed === true &&
  entry.descriptor.contentReadAllowed === false &&
  entry.descriptor.wouldMutateHost === false &&
  全部 mutation *Allowed === false &&
  processListReadAllowed === false &&
  无 caller injection &&
  statusInput 通过 §5 exact schema 校验（含 targetToken 类型硬校验）
```

**不要求：** `executeRequested`、`realRunnerWiringReady`、dual-host、idempotency store、audit sink。

### 4.6 execute 路径（保持 hard-deny 零 dispatch）

```text
if (mode === 'execute') {
  // 不得调用 real-status / real-render / dry-run handler
  return capability-execute-denied-receipt
  executeCapabilityAuthorized: false
  hostMutationOccurred: false
  hostObservationOccurred: false
  hostSideEffectOccurred: false
}
```

real status proof completed **不得**抬升：

- `realCapabilityImplementationsReady`
- `executeCapabilityAuthorized`
- `realRunnerWiringReady`
- `runnerWiringContractReady`
- `executionEligible`
- Gold / GA

---

## 5. Real status：可信边界、异步宿主 reader、I/O schema

### 5.1 固定 allowlist（operation / action / kind / token）

| 字段 | 唯一合法值 |
| --- | --- |
| `capabilityKind` | `'status'` |
| `actionId` | `'capture-current-state'` |
| `operation` | `'rollback'` |
| `mode` | `'real-proof'` |
| `statusInput.targetToken` | **仅** `REAL_STATUS_TARGET_TOKENS` 成员（**exact string**） |

```js
// exact allowlist — 禁止用户自由 label/path
const REAL_STATUS_TARGET_TOKENS = Object.freeze([
  'linke-launch-agent-default',
]);
// token → fixed basename only（非 path；非用户输入拼接）
const REAL_STATUS_TARGET_BASENAME_BY_TOKEN = Object.freeze({
  'linke-launch-agent-default': 'com.linke.agent.default.plist',
});
// metadata size class buckets only — never returned as raw size
const REAL_STATUS_MAX_METADATA_SIZE_BYTES = 65536;
const REAL_STATUS_OBSERVE_DEADLINE_MS = /* fixed code-owned budget, e.g. 250 */;
const REAL_STATUS_MAX_IN_FLIGHT = /* small fixed cap, e.g. 2 */;
```

**禁止** request 携带：`path`、`cwd`、`command`、`argv`、`env`、`uid`、`plist` 原文、`homedir`、`home`、`LaunchAgents` 绝对路径字符串、`reader`、`fs`、`timeoutMs`（用户覆盖）、任何 function。

### 5.2 可信边界（trust boundary）

```text
                    ┌──────────────────────────────────────┐
  request (test/    │  exact snapshot + allowlist validate │
  pure caller only) │  reject null/undefined/non-string/   │
                    │  empty/extra/symbol/function/getter/ │
                    │  proxy/prototype pollution           │
                    └───────────────┬──────────────────────┘
                                    │ validated statusInput only
                                    ▼
                    ┌──────────────────────────────────────┐
                    │  code-owned path derivation          │
                    │  root = os.homedir() INTERNAL ONLY   │
                    │  fixed segments + basename           │
                    │  NEVER echo absolute path            │
                    └───────────────┬──────────────────────┘
                                    │ internal PathRef only
                                    ▼
                    ┌──────────────────────────────────────┐
                    │  RealStatusHostReader (async)        │
                    │  fs/promises only                    │
                    │  parent walk lstat → target lstat    │
                    │  open O_RDONLY|O_NOFOLLOW            │
                    │  FileHandle.stat recheck             │
                    │  NO content read                     │
                    │  finally close                       │
                    │  absolute deadline + single-settle   │
                    └───────────────┬──────────────────────┘
                                    │ private metadata only
                                    ▼
                    ┌──────────────────────────────────────┐
                    │  sanitize → statusResult enum schema │
                    │  no path/error.message/stack/code    │
                    │  no stdout/HOME/pid/size/hash        │
                    └──────────────────────────────────────┘
```

### 5.3 宿主 reader 选定：**async Node `fs/promises` metadata-only**（非 shell；非 sync）

| 方案 | 是否本版 | 理由 |
| --- | --- | --- |
| **R1：async `fs/promises` 元数据只读** | **选定** | 无 shell；无 content read；可 deadline/single-settle；与 timeout 诚实语义一致 |
| R1b：sync `lstatSync`/`openSync`/`readSync` | **拒绝** | 阻塞事件循环；timeout 只能 fake；与 F1/F8/F10 生产语义不一致 |
| R2：`execFile('/bin/launchctl', fixed argv)` | **拒绝本版** | elevated IO；输出难脱敏 |
| R3：`ps` / process list | **拒绝** | `processListReadAllowed` 必须保持 false |
| R4：复用 `buildSupervisorStatusResponse` | **拒绝** | 静态假证据 |
| R5：读文件字节 + contentSha256 | **拒绝** | 过度暴露；非 status 产品所需 |

#### 5.3.1 固定 path 推导（内部 only；fixed path trust）

```text
function deriveObservationalTargetPath(targetToken): PathRef | fail
  // targetToken 已通过 §5.4.2 exact string allowlist
  basename = REAL_STATUS_TARGET_BASENAME_BY_TOKEN[targetToken]
  home = os.homedir()   // 生产 root 唯一来源；仅内部；失败 → observation-error mapping
  // fixed segments only — no user segments:
  //   home / 'Library' / 'LaunchAgents' / basename
  // 规范化：reject home 含 null；join 后 must still under home/Library/LaunchAgents
  // 禁止 .. 与额外 segment
  // 路径对象仅用于内部 fs 调用；永不进入 public receipt / error message
  return PathRef(internalAbsolute)
```

**locale / env / cwd：**

- reader **不**读 `process.env` 作为策略开关
- **不**依赖 `process.cwd()`
- locale 不影响 enum 输出（**不**把 `error.message` / `error.stack` / `error.path` 拼进 schema；只用 **内部** `error.code` → **固定 mapping code**，且 mapping 后丢弃原始 error 对象）

#### 5.3.2 Async metadata observation 算法（生产权威）

```text
async observeLaunchAgentPresence(targetToken) → private metadata | mapped failure

guards:
  - acquire in-flight slot (MAX_IN_FLIGHT)；若已达上限 → fixed outcome
    capability-real-status-observation-failed（或独立 in-flight code 若实现选择；公开仍固定 mapping）
  - 同 token 防重复启动：若同 target 已有 in-flight，不并行洪泛；返回既定 single-settle 策略
    （实现可选择 queue-coalesce 或 immediate fixed busy mapping；测试锁定一种）

deadline:
  - absolute deadline = now + REAL_STATUS_OBSERVE_DEADLINE_MS
  - single-settle guard: 仅第一次 settle 的结果进入 public receipt
  - 超时：立即 settle 固定 timeout receipt（state=error, outcome=capability-real-status-timeout）
  - 迟到的 resolve/reject：必须丢弃；.catch(()=>{}) 防 unhandled rejection；仍须 best-effort close
  - AbortSignal：能用则用（例如上层 Promise.race 协作取消标记）；
    **不得谎称**所有底层 fs syscalls 可强制取消——未取消的只读操作可在后台完成，但结果必须丢弃

steps (all via fs/promises; no Sync APIs; no content read):
  1. derive internal PathRef from token (no user path)
  2. walk parent segments from home root:
       for each intermediate segment (Library, LaunchAgents):
         await fs.lstat(segmentPath)
         if ENOENT → presence=absent（诚实：目标树不存在；observation 已开始）
         if EACCES/EPERM → presence=unreadable
         if isSymbolicLink() → presence=symlink-blocked（fail-closed；不 follow；不 readlink 回显）
         if !isDirectory() → presence=unexpected-type
  3. await fs.lstat(targetPath)
       ENOENT → presence=absent
       EACCES/EPERM → presence=unreadable
       isSymbolicLink() → presence=symlink-blocked
       !isFile() → presence=unexpected-type
  4. open:
       fh = await fs.open(targetPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
       // macOS：O_NOFOLLOW **必须启用**（darwin 强制；不写「若平台支持」）
       // 非 macOS 实现路径：若常量不存在则本版 **fail-closed** 为 observation-error
       //   （本产品 macOS-first；不得静默降级 follow）
  5. st = await fh.stat()
       reconfirm regular file
       if size > REAL_STATUS_MAX_METADATA_SIZE_BYTES → presence=oversize
         （仅元数据 sizeClass；不 read 内容；不返回 raw size）
  6. **禁止** fh.read / readFile / createReadStream / 任何字节读取
  7. finally:
       try { await fh.close() } catch {
         // close failure：不泄漏 error 原文；
         // 若 observation 尚未 settle 为 completed → 保守固定 reader error
         //   state=error, outcome=capability-real-status-observation-failed
         // single receipt only（不双 settle）
       }

TOCTOU / target swap:
  - lstat 与 open 之间若 target 被替换为 symlink：O_NOFOLLOW open 失败 →
    map 到 symlink-blocked 或 observation-error（实现锁定一种；测试覆盖）
  - open 后 fh.stat 与 lstat 类型不一致 → observation-error（fail-closed）

mutation:
  - 全程无 write/unlink/rename/chmod/chown/utimes
```

**上限与并发：**

| 项 | 值 / 规则 |
| --- | --- |
| `REAL_STATUS_MAX_METADATA_SIZE_BYTES` | `65536`（仅 sizeClass / oversize；**不**读内容） |
| absolute deadline | code-owned fixed ms |
| single-settle | 每 invoke 仅一次 public receipt |
| max in-flight | 小上限；防 timeout 洪泛 |
| 防重复启动 | 同 target 不并行洪泛 |
| 不使用 child_process | **强制** |
| 不使用 Sync fs | **强制**（生产 reader） |

#### 5.3.3 AbortSignal 与取消诚实性

```text
ALLOWED:
  - 用 AbortSignal / AbortController 标记协作取消
  - Promise.race(deadline, observation)
  - 超时后忽略 late result

FORBIDDEN claims:
  - “所有 fs syscalls 可强制取消”
  - “timeout 后底层一定已停止”

REQUIRED on late completion:
  - discard result
  - catch rejections
  - best-effort close FileHandle if still open
```

#### 5.3.4 若未来被迫使用命令（本版禁止实现，仅合同）

仅当 Node API 不足时另开 design，且必须 absolute executable、`execFile`/无 shell、固定 argv、timeout+kill、stdout 上限、sanitize enum；**永不**回传 raw stdout。本版 **不**实现。

### 5.4 输入 schema（CapabilityRealStatusProofRequest）

```js
{
  capabilityKind: 'status',
  actionId: 'capture-current-state',
  operation: 'rollback',
  mode: 'real-proof',
  idempotencyKey: null,          // proof 允许 null；不得回显
  attemptRef: null | string,     // opaque
  anchorRef: null | string,      // opaque evidence ref；非 path
  statusInput: {
    targetToken: string,         // exact ∈ REAL_STATUS_TARGET_TOKENS
  },
}
```

**顶层 exact keys：**

```text
capabilityKind, actionId, operation, mode, idempotencyKey,
attemptRef, anchorRef, statusInput
```

**`statusInput` exact keys：**

```text
targetToken
```

#### 5.4.1 顶层 + nested 独立 exact snapshot

与 V1.32 render 同构算法族：

1. 顶层 allowlist + Object.hasOwn + data descriptor only
2. 拒绝 symbol / dangerous keys / Proxy / accessor / function / extra keys
3. **nested `statusInput` 独立 snapshot**（不得只靠顶层）
4. validated deep-copy 后进入 authorize/invoke
5. 禁止 Object.assign / spread / JSON round-trip 作为清洗
6. **禁止** request 含 path/home/cwd/homedir/reader 等任何 I/O 注入面

#### 5.4.2 `targetToken` 类型硬校验（fail-closed）

| 输入 | 结果 |
| --- | --- |
| exact allowlisted string | pass |
| `null` / `undefined` | validation-failed；observation/sideEffect **false** |
| non-string（number/boolean/object/array） | validation-failed |
| empty string `''` | validation-failed |
| whitespace-only / 前后缀不同 | validation-failed（exact match only） |
| non-allowlist string | validation-failed |
| extra keys on statusInput | injection-rejected |
| symbol keys | injection-rejected |
| function value | injection-rejected |
| getter / accessor descriptor | injection-rejected |
| Proxy | injection-rejected |
| prototype pollution (`__proto__` / `constructor` / `prototype`) | injection-rejected |

### 5.5 输出 schema（sanitized / bounded / deterministic；**无 content hash**）

```js
{
  receiptKind: 'capability-real-implementation-receipt',
  mode: 'real-proof',
  capabilityKind: 'status',
  capabilityId: 'real-status',
  actionId: 'capture-current-state',
  operation: 'rollback',
  implementationClass: 'real-implementation',
  sideEffectClass: 'observational-read',
  state: 'completed' | 'denied' | 'error',
  outcomeCode: /* §5.7 */,
  plannedAction: 'capture-state',
  hostMutationOccurred: false,
  hostObservationOccurred: boolean,   // true iff real reader started
  hostSideEffectOccurred: boolean,    // true iff real reader started（V1.32）
  realStatusCapabilityImplementationReady: true|false,
  realRenderCapabilityImplementationReady: true|false, // 可附带；不因 status 变 false
  realCapabilityImplementationsReady: false,
  executeCapabilityAuthorized: false,
  realRunnerWiringReady: false,
  runnerWiringContractReady: false,
  executionEligible: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  idempotencyKeyFingerprint: null,
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  statusResult: {
    schemaVersion: 1,
    observationClass: 'launch-agent-presence',
    targetToken: 'linke-launch-agent-default',  // allowlisted token only
    presence: /* enum §5.5.1 */,
    isRegularFile: true | false | null,
    readability: /* enum §5.5.1 */,
    sizeClass: /* enum §5.5.1 */,
    deterministic: true,
    // 首选：完全无 digest 字段
    // 若实现阶段确需完整性锚点：仅允许对 **本 sanitized statusResult 低熵 schema**
    // 做 fixed canonical digest（不含 path/raw size/内容）；本版 **首选省略**
  },
  // 禁止字段见 §5.6
}
```

#### 5.5.1 固定枚举

**`presence`（exact）：**

```text
'present'
'absent'
'unreadable'
'unexpected-type'
'oversize'
'symlink-blocked'
'observation-error'
```

**`readability`（exact）：**

```text
'readable'         // open(O_RDONLY|O_NOFOLLOW) + fh.stat 成功且非 unreadable 路径
'unreadable'       // EACCES/EPERM 等权限失败
'not-applicable'   // absent / symlink-blocked / unexpected-type / oversize（未建立可读 regular 语义）
'unknown'          // observation-error / 未完成分类
```

**`sizeClass`（exact；仅元数据桶，无 raw size）：**

```text
'empty'      // metadata size === 0
'small'      // 1..1024
'medium'     // 1025..65536
'oversize'   // > MAX（配合 presence oversize）
'unknown'    // 未取得 metadata size
```

**映射规则（锁定；无 contentSha256）：**

| host 事实 | presence | isRegularFile | readability | sizeClass | hostObservation | hostSideEffect | hostMutation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ENOENT（target 或必要 parent） | `absent` | null | `not-applicable` | `unknown` | true | true | false |
| regular file size 0 | `present` | true | `readable` | `empty` | true | true | false |
| regular file 1..MAX | `present` | true | `readable` | small/medium | true | true | false |
| metadata size > MAX | `oversize` | true | `not-applicable` | `oversize` | true | true | false |
| symlink（parent 或 target） | `symlink-blocked` | false | `not-applicable` | `unknown` | true | true | false |
| dir/socket/etc | `unexpected-type` | false | `not-applicable` | `unknown` | true | true | false |
| EACCES/EPERM | `unreadable` | null | `unreadable` | `unknown` | true | true | false |
| open/stat/close 其它 IO | `observation-error` 或 error outcome | null | `unknown` | `unknown` | true | true | false |
| deadline timeout（reader 已启动） | 无 completed statusResult 或固定 timeout 形状 | — | — | — | true | true | false |
| validation / injection（未调用 reader） | 无 completed statusResult | — | — | — | **false** | **false** | **false** |
| close failure（尚未 completed settle） | error；outcome observation-failed | null | `unknown` | `unknown` | true | true | false |

**确定性：** 同一 host 元数据事实 → 同一 enum 集合；schema 键序稳定；**不**依赖 Date.now/random/locale 字符串；**不**依赖内容字节 hash。

### 5.6 绝对禁止回显 / 包含

| 禁止 | 说明 |
| --- | --- |
| 原始 stdout/stderr | 无 command 亦禁止假字段 |
| username / HOME / 绝对路径 | 含 `/Users/`、`~`、`LaunchAgents` 绝对串 |
| PID 列表 / process table | processListReadAllowed false |
| env / plist 全文 / 内容字节 | **禁止读取**；亦禁止回显 |
| raw size / inode / timestamps / mode 原文 | 仅 coarse sizeClass |
| `contentSha256` / 任何文件内容 digest | **禁止** |
| raw `error.code` / `error.message` / `error.stack` / `error.path` | 仅固定 mapping outcome/presence；原始 error 不得进入 public receipt |
| raw idempotencyKey | fingerprint 仍 null |
| function / Buffer / circular | public deep-copy fail-closed |
| `buildSupervisorStatusResponse` 整包嵌入 | 禁止 |

敏感扫描：仅 **category hit counts**；恶意 fixture 用 opaque synthetic 字符串。

### 5.7 Outcome / blocker codes（增量）

```text
outcome:
  capability-real-status-completed
  capability-real-status-validation-failed
  capability-real-status-observation-failed
  capability-real-status-timeout
  （既有）capability-caller-injection-rejected / capability-mode-invalid / ...

blocker:
  capability-real-status-validation-failed
  capability-real-status-observation-failed
  capability-real-status-timeout
  capability-real-status-redaction-failed
  （既有 injection / registry / mode codes）

evidence:
  capability-real-status-implementation-ready
```

| 条件 | state | outcomeCode | hostObservation | hostSideEffect | hostMutation |
| --- | --- | --- | --- | --- | --- |
| happy path（含 absent） | completed | `capability-real-status-completed` | true | true | false |
| schema/injection | denied/error | injection / validation | false | false | false |
| reader 映射失败不可恢复 | error | `capability-real-status-observation-failed` | true（已入 reader） | true | false |
| absolute deadline timeout | error | `capability-real-status-timeout` | true（若已开始） | true（若已开始） | false |
| close failure（未 completed） | error | `capability-real-status-observation-failed` | true | true | false |
| execute 入口 | denied | execute hard-denied / mode-invalid | false | false | false |

**说明：** `presence:'absent'` **仍是 completed real observation**（诚实读到不存在），**不是** dry-run stub。

### 5.8 如何证明不是 dry-run / 不是静态 status API

| 证据 | dry-run status | static server status | real status proof |
| --- | --- | --- | --- |
| `capabilityId` | `dry-run-status` | n/a | `real-status` |
| `implementationClass` | dry-run-non-side-effect | n/a | real-implementation |
| `receiptKind` | dry-run-receipt | n/a | real-implementation-receipt |
| `statusResult` | absent | n/a | **present schema（metadata enums）** |
| `hostObservationOccurred` | false | n/a | **true** on observe |
| `hostSideEffectOccurred` | false | n/a | **true** on observe（V1.32） |
| `hostMutationOccurred` | false | false | false |
| content / contentSha256 | n/a | n/a | **禁止** |
| 与 `buildSupervisorStatusResponse` 全等？ | — | 自身 | **必须不等同依赖** |
| 同 token 两次观察 | n/a | 静态恒等假 | 同一 host 元数据 → 同 enums；删除/创建文件 → presence 变（harness） |

### 5.9 测试 seam / inject hook（严格边界）

```js
/**
 * @internal TEST ONLY — never call from production bootstrap / server / agent / web
 * Swap the RealStatusHostReader for failure-injection tests.
 * Must not accept path/home/cwd injection from callers.
 * Production trustedBootstrap must never invoke this function.
 */
export function setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(readerOrNull)
```

| 规则 | 要求 |
| --- | --- |
| JSDoc | **必须** `@internal TEST ONLY` |
| 生产 bootstrap | **永不**调用 |
| server / agent / Web | **零引用** |
| 调用者注入 path/reader 进 request | **禁止**；request schema 不含 reader/path |
| hook 能力 | 仅替换 module-private reader 实现；仍输出同一 sanitize 出口 |
| afterEach | 测试必须 reset 到 null/default |
| 证据等级 | inject 结果 **≠** 生产 host 证据；Gold 不依赖 inject |

---

## 6. 失败注入矩阵（测试；不得把 fake 当生产证据）

### 6.1 原则

1. **生产路径**默认绑定 **真实** async `RealStatusHostReader`（Node `fs/promises` metadata-only）。
2. **测试**可使用 **module-private / `@internal TEST ONLY` inject hook** 模拟故障。
3. **禁止** 把 inject hook 导出为 public execute surface 或允许 request 注入 reader/path。
4. **禁止** 生产 bootstrap 注册 “always-present fake reader” 并宣称 real。
5. Gold / readiness **不得**依赖 inject 结果。
6. **F1 / F8 / F10 必须同时覆盖生产 async 语义与 test fake**，**不得**标 N/A 或 fake-only。

### 6.2 矩阵

| # | 注入 / 场景 | 期望 state | outcome / presence | hostObservation | hostSideEffect | hostMutation |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | **absolute deadline timeout**（生产 async race + fake slow reader） | error | `capability-real-status-timeout` | true | true | false |
| F2 | not-found（ENOENT） | completed | presence `absent` | true | true | false |
| F3 | permission-denied（EACCES） | completed | `unreadable` | true | true | false |
| F4 | malformed targetToken（null/非字符串/empty/非 allowlist） | error/denied | validation-failed | false | false | false |
| F5 | oversize metadata | completed | `oversize`；**无** content hash | true | true | false |
| F6 | adapter 返回非法 shape | error | observation-failed | per call（已入则 true） | 同 observation | false |
| F7 | adapter throw / reject | error | observation-failed | true if reader entered | 同 observation | false |
| F8 | **double-settle / concurrent invoke**（生产 single-settle + fake double resolve） | 仅一次 public receipt | 确定性 | 不双计 | 不双计 | false |
| F9 | prototype pollution / getter / proxy / function | denied | caller-injection-rejected | false | false | false |
| F10 | **迟到 resolve/reject**（生产 discard + fake late callback） | 不覆盖已 settle receipt | — | 保持首次 | 保持首次 | false |
| F11 | symlink at target | completed | `symlink-blocked` | true | true | false |
| F12 | unexpected type（directory） | completed | `unexpected-type` | true | true | false |
| F13 | redaction 失败（内部 path 泄漏检测） | error | redaction-failed | * | * | false |
| F14 | execute mode on status proof API | denied | mode-invalid | false | false | false |
| F15 | 静态 server status 比对 | real proof **不得** 返回 server builder 对象 | — | — | — | false |
| F16 | **parent segment symlink** | completed/error 锁定：`symlink-blocked` | fail-closed | true | true | false |
| F17 | **target swap**（lstat regular → open 时变 symlink） | symlink-blocked 或 observation-error（锁定一种） | true | true | false |
| F18 | **deadline before open** | timeout；无 content；single receipt | true if reader started | true if started | false |
| F19 | **deadline after open, before/during close** | timeout 或 completed 仅一次 settle；handle closed | true | true | false |
| F20 | **close failure** | observation-failed（若未 completed）；不泄漏 close error | true | true | false |
| F21 | **concurrent calls / in-flight cap** | 不洪泛；单次有效语义 | per policy | per policy | false |
| F22 | **不读取内容**：spy/assert 无 read/readFile/createReadStream | completed 路径仍无 content API | true | true | false |
| F23 | raw error.code/message/stack/path 不得进入 receipt | redaction / mapping only | — | — | false |

### 6.3 生产 vs 测试证据分层

| 层 | 允许 | 禁止 |
| --- | --- | --- |
| 单元测试（注入 reader） | 证明 sanitize / enum / 失败映射 / injection / async settle | 宣称 “生产已观测某台 Mac 的真实 launchd” |
| 集成烟测（真实 reader） | 对当前 host 调用；常见 `absent` completed | 要求 CI 机器必有 plist；不得写 LaunchAgents；不得读内容 |
| Gold scorecard | 仅登记 API/evidence 字符串 | 不因 completed proof 改 Gold ready |

---

## 7. Decision mappings / Gate / Web

### 7.1 resolve mappings 增量

`capture-current-state` mapping 可增加 plain 字段（无 function）：

```js
{
  actionId: 'capture-current-state',
  primaryCapabilityKind: 'status',
  capabilityId: 'dry-run-status',
  realCapabilityId: 'real-status',
  implementationClass: 'dry-run-non-side-effect',
  realImplementationClass: 'real-implementation',
  supportsModes: ['dry-run'],
  realSupportsModes: ['real-proof'],
  realStatusCapabilityImplementationReady: true,
  hostMutationOccurred: false,
  hostObservationOccurred: false,  // resolve 不做观测
  hostSideEffectOccurred: false,   // resolve 不读 host
  wouldExecute: false,
}
```

install 路径 render 映射 **保持** V1.32。

### 7.2 Gate

在 `buildSupervisorLifecycleGuardedRunnerExecutionGate`：

1. **忽略** options 对 realStatus / realCapability / execute / observation / sideEffect 的覆盖
2. 本地 `realStatusCapabilityImplementationReady` 仅来自 readiness builder
3. 强制：

```js
realCapabilityImplementationsReady: false   // 独立事实：2/7 未齐；不是「ready 输入信号」
executeCapabilityAuthorized: false
executionEligible: false
realRunnerWiringReady: false
runnerWiringContractReady: false
nextBlockers: ['real-guarded-runner-execution-wiring-missing']
hostMutationOccurred: false
hostObservationOccurred: false              // gate 非 live observe
hostSideEffectOccurred: false               // gate 非 live observe
```

4. **不**把 `realStatusCapabilityImplementationReady` 加入 `POLICY_FACT_KEYS`
5. `gates.capabilityInjectionReady` 谓词 **继续要求** 全局 `realCapabilityImplementationsReady === false` 与 `executeCapabilityAuthorized === false`
   —— 此处 `false` 是 **fail-closed 边界断言**（“仍未齐备 / 仍未授权”），**不是**把 `false` 解释为 “ready 成功输入”。全局 real 保持 false 与局部 `realStatus*Ready:true` **同时成立且互不冒充**。
6. Gate **不**调用 RealStatusProof / host reader；**不**产生 `statusResult`。

### 7.3 Web（方案 A + 增量 shall 行）

**保持** V1.32 行 + sentinel。

**必须新增（shall）** 局部 real status 行（展示 **gate 非 live 事实**，不是 live observation）：

```text
realStatusCapability:state:ready:realStatusReady:true:hostObservationOccurred:false:hostSideEffectOccurred:false:hostMutationOccurred:false:realCapabilityImplementationsReady:false:realRunnerWiringReady:false:blocker:none
```

> 既有 Web 消费点（gate view model / validationLines / executionSentinel）**只展示 gate 非 live 事实**。
> gate 展示路径默认 **不**调用 observational reader → `hostObservationOccurred:false` 与 `hostSideEffectOccurred:false` 于 Web 固定行是诚实的（readiness ≠ live observation）。
> live observation 仅 RealStatusProof / 测试；**不得**在 Web 上展示 live statusResult。

`validationLines` 增量：

```text
realStatusCapabilityImplementationReady:true|false
hostMutationOccurred:false
hostObservationOccurred:false   # gate/web 非 live observe
hostSideEffectOccurred:false    # gate/web 非 live observe
realCapabilityImplementationsReady:false   # 独立事实，非 ready 成功信号
executeCapabilityAuthorized:false
realRunnerWiringReady:false
executionEligible:false
# 无 statusResult 行（validation 不携带 live observation）
```

**禁止** 因 realStatus ready 删除 `executionSentinel` 或 realRender 行。
**禁止** 暗示 Web 行 = 已完成 Gold 或跨局域网观测。

---

## 8. 哪些 fact 可 true / 必须 false

### 8.1 可 true

| Fact | V1.33 |
| --- | --- |
| dry-run registry / pure injection | 保持 true |
| `realRenderCapabilityImplementationReady` | true |
| **`realStatusCapabilityImplementationReady`** | **true** |
| real-status-proof authorize / completed receipt | 可 true |
| `hostObservationOccurred`（proof observe 路径） | 可 true |
| `hostSideEffectOccurred`（proof observe 路径） | 可 true（V1.32 定义） |
| wiring `readyCount/blockedCount` | **6/0** |
| policy ready path authorized | 保持 |

### 8.2 必须 false / blocked

| Fact | V1.33 |
| --- | --- |
| `realCapabilityImplementationsReady`（全局） | **false**（独立事实） |
| `executeCapabilityRegistryReady` / `executeCapabilityAuthorized` | **false** |
| `realRunnerWiringReady` / `runnerWiringContractReady` | **false** |
| `executionEligible` / `wouldExecute` / `wouldRun` / `wouldWrite` | **false** |
| `hostMutationOccurred` | **false**（全路径） |
| `hostSideEffectOccurred`（validation / Gate / Web / execute deny） | **false** |
| 全部既有 `real*ImplementationReady`（mutation/anchor/audit/recovery/runner） | **false** |
| mutation `*Allowed` / `processListReadAllowed` / `contentReadAllowed` | **false** |
| §4.5 idempotency store / audit sink ready | **不存在/false** |
| wiring-missing / Gold / executionSentinel | **仍 blocked** |
| Gold / GA / 跨局域网 milestone | **非本版** |

---

## 9. Scope

### 9.1 实现阶段允许修改（精确 allowlist）

**精确 10 files：** `README.md` + 4 src + 5 tests（gate / web / gold / version / readme）。**默认禁止**改 `src/agent.js` / `src/server.js` / `package.json`。

| 文件 | 变更 |
| --- | --- |
| `src/supervisor-lifecycle.js` | real status registry / async metadata reader / authorize+invoke RealStatusProof / readiness+gate+mappings 字段 / 注释与常量 / TEST ONLY hook |
| `src/web/app.js` | realStatus 固定行 + validationLines（无新 button；仅 gate 非 live 事实） |
| `src/gold-readiness.js` | evidence + nextStep 指向 V1.33 real status；仍 blocked；不宣称 V2.0 Gold |
| `src/version.js` | → `V1.33` |
| `README.md` | 版本条 + 边界措辞（诚实 observational metadata；非 Gold；非跨局域网）；V1.33 为当前版本；**保留** V1.32 历史条目且不再 current |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | TDD 主矩阵（async） |
| `test/web-console.test.js` | realStatus 行 + sentinel 保持 |
| `test/gold-readiness.test.js` | evidence / nextStep |
| `test/version.test.js` | 当前里程碑断言 → `V1.33`（现有 L16–17 仍断言 `V1.32`；未改则 full test 红） |
| `test/readme.test.js` | V1.33 current + V1.32 historical 合同（现有约 L1871+ 仍断言 V1.32 current milestone；未改则 full test 红） |

若既有 gate API/CLI 透传测试仅因 additive 字段失败：先停；仅允许断言扩展字段，且须经确认后补入 allowlist（**不得**凭猜测扩大出 10 files）。

### 9.2 明确禁止

| 文件 / 行为 | 状态 |
| --- | --- |
| `src/agent.js` / `src/server.js` / `package.json` | **默认禁止改** |
| 改 `buildSupervisorStatusResponse` 为“真观测”并声称 capability real | **禁止**（另版设计） |
| 新增 endpoint / CLI / Web button / request field | **禁止** |
| server/agent 引用 RealStatusProof / RealRenderProof / TEST ONLY hook | **禁止** |
| 扩 RealRenderProof kind 范围 | **禁止** |
| launchctl write/load/unload、fs write、network、audit persist、notify、shell | **禁止** |
| process list dump / PID 回显 | **禁止** |
| 读 plist 内容 / contentSha256 / raw size/inode/timestamps/path | **禁止** |
| 生产 sync `*Sync` fs reader | **禁止** |
| 置全局 real / execute / wiring / executionEligible true | **禁止** |
| 消解 wiring-missing | **禁止** |
| 落地 idempotency store（B）或 persist audit sink（C） | **禁止** |
| 产出 completed `capability-execute-receipt` | **禁止** |
| 写用户 `~/Library/LaunchAgents` 以制造 present | **禁止**（测试用 inject reader 或只断言 absent） |
| 跨局域网协议 / Gold-GA 本版落地 | **禁止** |

### 9.3 本设计/计划阶段允许写入

仅：

- `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-real-status-capability-handler-design.md`
- `docs/superpowers/plans/2026-07-14-supervisor-lifecycle-real-status-capability-handler.md`

---

## 10. TDD 红绿矩阵（实现阶段）

| # | 场景 | 期望 |
| --- | --- | --- |
| T1 | readiness：realRender true + realStatus true + 全局 real false | nextBlockers wiring-missing；全局 false 为独立事实 |
| T2 | bootstrap：7 dry-run + 2 real（render/status） | size/kind 断言；无 write real；contentReadAllowed false |
| T3 | dry-run status 仍 completed 且无 statusResult | 回归 |
| T4 | real-status-proof happy path（真实 async reader，常见 absent） | completed；presence enum；observation **true**；sideEffect **true**；mutation false |
| T5 | inject present regular + sizeClass empty/small/medium | **无** contentSha256；enums 稳定 |
| T6 | inject 改 metadata size 桶 → sizeClass 变 | 非 stub 常量；仍无 content read |
| T7 | dry-run vs real-status 对照 | capabilityId/receiptKind/statusResult 可区分 |
| T8 | execute 仍 denied；零 dispatch（spy/不调 reader） | executeCapabilityAuthorized false；三布尔 false |
| T9 | 顶层 injection / path / home / secret keys | caller-injection-rejected |
| T10 | nested statusInput extra/proxy/getter/symbol/function | fail-closed |
| T11 | targetToken null/undefined/non-string/empty/extra allowlist 外 | validation-failed；observation/sideEffect false |
| T12 | F2 ENOENT → absent completed | 见 §6 |
| T13 | F3 EACCES → unreadable | 见 §6 |
| T14 | F5 oversize metadata | 无 content hash；oversize |
| T15 | F11 symlink-blocked | 不 follow |
| T16 | F1 timeout（生产 absolute deadline + fake slow） | timeout outcome；三布尔 observe 后 true/true/false |
| T17 | F7 adapter throw/reject | observation-failed |
| T18 | F9 prototype/proxy | injection rejected |
| T19 | F14 execute mode on proof API | denied |
| T20 | gate production ready | local realStatus true；executionEligible false；6/0；observation/sideEffect false |
| T21 | options override realStatus/observation/sideEffect | **忽略** |
| T22 | Web ready path | sentinel blocked + shall realStatus 行（非 live 三布尔 false）+ realRender 行保持；**无** live statusResult |
| T23 | Gold blocked；evidence 含 V1.33 real status | 全局 real false；不宣称 V2.0 Gold |
| T24 | 差分：相对 c311a7e **无** launchctl/writeFile/spawn/shell/read content；**允许** async lstat/open/stat/close **仅** reader 内 | side-effect scan 分类计数 |
| T25 | 不改 agent/server/package；server/agent/Web **零** RealStatusProof / ForTest 引用 | scope |
| T26 | 敏感扫描 category counts；receipt 无 path/HOME/username/pid/error.message | 通过 |
| T27 | 禁止依赖 `buildSupervisorStatusResponse` 填充 statusResult | 源码/测试断言 |
| T28 | per-kind readiness 分离：render probe 与 status probe 独立 | 破坏其一仅对应 local false |
| T29 | proof API JSDoc `@internal PROOF ONLY`；status-specific；invoke **async** | 扫描/checklist |
| T30 | 注释含 observational vs mutation vs V1.32 side-effect 术语 | registry 附近 |
| T31 | F8/F10 concurrent + late resolve/reject | 单次有效 receipt；生产+fake |
| T32 | redaction：强制 path/error 进 receipt 应失败 | redaction-failed |
| T33 | idempotencyKeyFingerprint 仍 null | 无 store |
| T34 | realImplementationEntries length 2；kind 集合 exact | render+status |
| T35 | F16 parent symlink | symlink-blocked |
| T36 | F17 target swap | 锁定 mapping |
| T37 | F18/F19 deadline before/after open | single-settle；close best-effort |
| T38 | F20 close failure | observation-failed；不泄漏 |
| T39 | F21 concurrent / in-flight cap | 无 timeout 洪泛 |
| T40 | F22 无 content read API | spy 断言 |
| T41 | TEST ONLY hook JSDoc；bootstrap 永不调用；request 不能注入 path/reader | 扫描 |
| T42 | O_NOFOLLOW 在 macOS open flags 中强制存在 | 源码/单测 |
| T43 | version 合同：`LINKE_RELEASE_VERSION === 'V1.33'`；`test/version.test.js` 同步当前里程碑（先 RED 后 GREEN） | 不得残留 `V1.32` 为 current release 断言 |
| T44 | README current/historical：title/badge/version table 以 **V1.33 为当前版本**；**V1.32 历史条目仍存在且不再 current**；`test/readme.test.js` 同步（先 RED 后 GREEN） | 诚实 observational metadata；非 Gold/GA；非跨局域网 |

---

## 11. Source-of-truth / 验证命令 / side-effect scan

### 11.1 Source-of-truth

| 主题 | SoT |
| --- | --- |
| action→capability | `CODE_OWNED_ACTION_PRIMARY_CAPABILITY_MAP` |
| dual registry | module-private `dryRunCapabilityRegistry` / `realCapabilityRegistry` |
| status real 语义 | 本 design §1.4 / §5 |
| `hostSideEffectOccurred` 历史定义 | **V1.32 design §1.3**（不得重定义） |
| proof API | 本 design §3；实现于 `supervisor-lifecycle.js` |
| 静态 supervisor HTTP status | `buildSupervisorStatusResponse` — **非** capability real SoT |
| Gold | `src/gold-readiness.js`；**Gold/GA 定义在 V2.0**（§12.4） |
| 版本 | `src/version.js` |

### 11.2 验证命令

#### Focused

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
node --test test/web-console.test.js
node --test test/gold-readiness.test.js
node --test test/version.test.js
node --test test/readme.test.js
```

#### Full

```bash
node --test
```

### 11.3 Side-effect / sensitive scan（相对 c311a7e）

- 仅 category hit counts
- **禁止新增：** `child_process` / `execFile` / `spawn` / `exec(` / `shell:true` / `launchctl` / `writeFile` / `appendFile` / `process.kill` / `net.` / `fetch(` / `appendAuditEvent`（于 capability status 路径）/ `readFile` / `readSync` / `createReadStream`（于 status reader）
- **禁止生产 status reader：** `lstatSync` / `openSync` / `readSync` / `fstatSync` / `closeSync`
- **允许且必须限制在 reader 私有函数内：** `fs.lstat` / `fs.open` / `FileHandle.stat` / `FileHandle.close`（`fs/promises`）；`O_RDONLY | O_NOFOLLOW`
- scope 仅 §9.1 **精确 10 files**（README + 4 src + 5 tests：gate/web/gold/version/readme）；默认禁止 agent/server/package
- server/agent/Web 对 `RealStatusProof` / `ForTest` hits = 0
- public JSON 敏感类别：path / HOME / username / pid / token / Authorization / error.message / raw size / content hash → **0 回显**

### 11.4 恢复锚点

- **commit：** `c311a7e`
- **信息：** `feat: add V1.32 first real render capability`
- 越界时：丢弃工作区改动，回到该锚点干净树后按 plan 重做
- **禁止**把 `git reset --hard` 写进常规实施步骤清单

---

## 12. 安全与非目标

### 12.1 安全

- 无 secret / token / Authorization / path / URL / hostname / username / pid / raw idempotency key / plist 全文 / env / error 原文回显
- 无 content read / content hash / raw size/inode/timestamps
- 恶意 fixture 仅 opaque synthetic 字符串
- exact snapshot + structuredClone/validated deep copy
- 不读 env 抬升 execute / wiring
- handlers 永不进入 JSON
- observational metadata read **不等于** mutation 授权；**等于** V1.32 意义下的 host side effect（读受控资源）
- 测试 inject **不等于** 生产证据
- O_NOFOLLOW 强制（macOS）；parent/target symlink fail-closed
- close failure 不泄漏；single receipt
- async deadline + in-flight cap 防洪泛；不谎称 syscall 可强制取消

### 12.2 非目标（V1.33）

- real write / reload / rollback / audit / notify
- host mutation 任何形式
- process list / launchctl invoke
- 读取/解析 plist 内容或 content digest
- sync fs 生产 reader
- `realRunnerWiringReady=true` / `executionEligible=true`
- 全局 `realCapabilityImplementationsReady=true`
- 消解 wiring-missing
- §4.5 idempotency store（B）/ persist audit sink（C）完整落地
- 开放 public execute 成功路径
- 把 server supervisor-status API 改为真观测（可未来独立版本）
- 新增 endpoint / CLI / Web button
- 修改 agent.js / server.js / package.json
- Gold ready / GA ready / 改写 G0a 为 capability dual-host
- **跨局域网 / same-LAN multi-host status / 暗示 LAN status 完成 Gold**
- generic multi-kind proof framework（另 design）

### 12.3 下一步（显式非本版）

1. 第 3 个最小 real kind **或** 在 ≥3 kinds 时另开 generic proof framework design
2. §4.5 loci 按 schema owner 逐个落地（idempotency / audit sink / …）— 仍 fail-closed
3. 可选：独立版本将 HTTP supervisor-status 接到同一 observational metadata reader（**另 scope**；非本版）
4. 当且仅当完整公式可满足 → execute 双闸放行
5. 并行 Gold 前置：NAS / auth / hardening（仍非 GA）
6. **V2.0：Gold/GA 定义 + 跨局域网强制里程碑**（§12.4）

### 12.4 V2.0 边界声明（产品要求；不扩 V1.33 scope）

```text
V2.0 SHALL define:
  - Gold release criteria（scorecard → ready 的充分必要条件）
  - GA criteria（与 Gold 的关系、支持边界、升级/回滚承诺）

V2.0 SHALL include as a MANDATORY milestone:
  - 跨局域网（cross-LAN / multi-host over LAN）协同能力
  - 采用 **后续独立协议与威胁模型设计**（不得把 V1.33 本机 fixed-path status
    观测、same-host proof、或 G0a 手工双机报告 冒充跨局域网完成）

V1.33 MUST NOT:
  - 实现跨局域网 status / multi-host observation protocol
  - 暗示「本机 real status 完成」= Gold 或 GA
  - 暗示 same-LAN 探测完成 Gold
```

本声明仅约束产品路线图措辞与非目标；**不**增加 V1.33 实现任务。

---

## 13. 完成标准（实现阶段验收）

1. 选定 **A = status / capture-current-state**；拒绝 B/C 理由写入文档；术语 hostMutation / hostObservation / hostSideEffect（V1.32）分离且不重定义
2. dual registry：**7 dry-run + 2 real（render/status）**；per-kind local readiness 分离；全局 real false（独立事实）
3. 独立 **async** RealStatusProof API + `@internal PROOF ONLY`；**不**扩 RealRenderProof；server/agent 零引用
4. 真实 **async metadata-only** observational reader（Node `fs/promises` fixed path）；**不**用静态 `buildSupervisorStatusResponse` 冒充；**不**读内容
5. 输出 sanitized enum/boolean schema；无 path/HOME/username/pid/stdout/plist 全文/raw size/content hash/error 原文
6. observe 路径：`hostMutationOccurred:false` + `hostObservationOccurred:true` + `hostSideEffectOccurred:true`；validation/Gate/Web：三者 observation/sideEffect 为 false、mutation false
7. execute hard-deny 零 dispatch；不抬升 execute/wiring/executionEligible/Gold；wiring-missing 保留
8. 失败注入矩阵 F1–F23 / T1–T44 覆盖；F1/F8/F10 生产+fake；inject ≠ 生产证据
9. Web shall realStatus 行（非 live）+ sentinel 保持；Gold blocked + evidence 更新；不宣称 V2.0 Gold
10. scope 仅 §9.1 **精确 10 files**（README + 4 src + 5 tests：gate/web/gold/version/readme）；默认禁止 agent/server/package；恢复锚点 `c311a7e`；**无** `git reset --hard` 常规步骤
11. 差分扫描：无 shell/launchctl/write/network/audit-persist/content-read/Sync-fs 于 status 路径；O_NOFOLLOW 强制
12. **不**宣称 Gold/GA 发布、跨局域网完成、或 real runner wiring 完成
13. version/README 合同：当前里程碑 **V1.33**；**V1.32 历史条目仍存在且不再 current**；`test/version.test.js` + `test/readme.test.js` 绿

---

## 14. P0 / P1 风险

### P0（必须在实现前/中锁死）

| ID | 风险 | 缓解 |
| --- | --- | --- |
| P0-1 | 用静态 server status 冒充 real | §0.3/§5.8/T27；禁止 import builder 填 statusResult |
| P0-2 | path/HOME/username/error 原文泄漏进 receipt | sanitize 单点出口；仅固定 mapping；T26/T32/F23 |
| P0-3 | 跟随 symlink / TOCTOU 读到界外 | parent walk + O_NOFOLLOW **强制** + fh.stat；F11/F16/F17 |
| P0-4 | 抬升 execute / 全局 real / wiring / Gold | 固定 false 断言全矩阵；全局 false 为独立事实 |
| P0-5 | 扩 RealRenderProof 塞 status | API 分离 + 源码扫描 |
| P0-6 | shell/execFile 宽泛 wrapper | §5.3 选定 fs/promises；扫描禁止 child_process |
| P0-7 | 读内容 / contentSha256 回潮 | contentReadAllowed false；F22/T40；禁止 read API |
| P0-8 | 重定义 V1.32 hostSideEffectOccurred 为 false | §0.1.1/§1.4；observe 路径强制 true |

### P1

| ID | 风险 | 缓解 |
| --- | --- | --- |
| P1-1 | CI 主机 LaunchAgents 状态不一致 | present 用 inject；真实 reader 允许 absent completed |
| P1-2 | 把 hostSideEffect true 误读为 mutation/execute 授权 | 三布尔分列 + 注释 + 完成标准 |
| P1-3 | Web 行显示 live observation/sideEffect true 误导 | gate/web 非 live；固定 false；无 statusResult |
| P1-4 | 过早 generic framework | §3 拒绝；≥3 kinds 另 design |
| P1-5 | 测试 inject 泄漏为生产默认 / request 注入 path | ForTest `@internal TEST ONLY`；bootstrap 永不调用；T41 |
| P1-6 | README/Gold 措辞过度宣称 / 跨局域网暗示 | nextStep 仍 blocked；§12.4 V2.0 边界 |
| P1-7 | timeout 仅 fake、与生产 async 脱节 | 生产 absolute deadline + single-settle；F1/F8/F10 双覆盖 |
| P1-8 | close failure 双 settle 或泄漏 | F20；保守 observation-failed；single receipt |
| P1-9 | timeout 洪泛 / 无 in-flight 上限 | MAX_IN_FLIGHT + 防重复启动；F21 |
| P1-10 | targetToken 弱类型放过 | §5.4.2 硬表；T11 |
| P1-11 | O_NOFOLLOW「若支持」静默降级 | macOS 强制；否则 fail-closed；T42 |

---

## 15. 自检清单（设计阶段 / 实现收尾共用）

- [ ] 决策 A；B/C 拒绝理由有源码证据
- [ ] 7 dry-run + 2 real；entries 含 render+status
- [ ] RealStatusProof 独立 async；RealRenderProof 未扩 kind
- [ ] operation/action/kind 固定 rollback/capture-current-state/status
- [ ] async fs/promises metadata reader；无 shell/launchctl/process list/Sync/content-read
- [ ] 不复用 `buildSupervisorStatusResponse` 作 real 证据
- [ ] statusResult 仅 enum/boolean（presence/isRegularFile/readability/sizeClass）；无 content hash/raw size
- [ ] observe：hostMutation false + observation true + sideEffect true（V1.32）
- [ ] validation/Gate/Web：observation false + sideEffect false + mutation false
- [ ] execute 零 dispatch；全局 real/execute/wiring/Gold 边界；全局 false 为独立事实
- [ ] wiring-missing 保留
- [ ] 失败注入矩阵 F1–F23 与 TDD T1–T44 完整；F1/F8/F10 生产+fake
- [ ] fixed path trust：request 无 path；homedir 内部；token 硬校验；error 去敏
- [ ] O_NOFOLLOW macOS 强制；close failure 映射明确
- [ ] TEST ONLY hook 边界；bootstrap 永不调用
- [ ] Web 仅 gate 非 live 事实；无 live statusResult
- [ ] V2.0 Gold/GA + 跨局域网声明在非目标/下一步；不扩本版 scope
- [ ] scope allowlist **精确 10 files**（README + 4 src + 5 tests：gate/web/gold/version/readme）；默认禁止 agent/server/package；锚点 c311a7e
- [ ] version/README：V1.33 current；V1.32 historical 仍在且不再 current；`test/version.test.js` + `test/readme.test.js` 纳入 allowlist 与 focused
- [ ] 无 git reset --hard 常规建议
- [ ] server/agent/Web 零 proof / ForTest 引用
- [ ] 敏感扫描与 side-effect 分类规则明确

---

## 16. 问题对照表

| # | 问题 | 答案 |
| --- | --- | --- |
| 1 | A/B/C 选谁 | **A**；§1 矩阵；B/C 写宿主且不增 real kind |
| 2 | proof API 独立还是 generic | **独立 RealStatusProof（async）**；§3 |
| 3 | 能否复用 buildSupervisorStatusResponse | **不能**；§0.3 |
| 4 | 如何诚实观测 | fixed token→basename→parent walk lstat→open O_NOFOLLOW→stat；**无 content**；§5.3 |
| 5 | 输出如何脱敏 | presence/readability/sizeClass/isRegularFile only；§5.5–5.6 |
| 6 | hostSideEffect 为何 true | **V1.32：读 host 受控资源 = side effect**；§0.1.1/§1.4；不抬升 execute/Gold |
| 7 | execute / Gold | 仍 deny/blocked；Gold/GA 与跨局域网属 **V2.0**；§4.6 / §8 / §12.4 |
| 8 | dual registry | 7+2；§4 |
| 9 | 失败注入 | §6；inject ≠ 生产证据；F1/F8/F10 生产+fake |
| 10 | scope / 锚点 | §9.1 **精确 10 files**（README + 4 src + 5 tests：gate/web/gold/version/readme）/ §11.4 = c311a7e；默认禁止 agent/server/package |

---

## 17. Qwen 抗辩消解映射（设计修订记录）

| 原编号 | 主题 | 处置 |
| --- | --- | --- |
| P0 | （无） | — |
| P1 | `hostSideEffectOccurred` 重定义 | **拒绝重定义**；恢复 V1.32；observe → true；descriptor/receipt/矩阵/shall/TDD/风险/完成标准全量同步；明确不抬升 execute/全局 real/wiring/Gold |
| P1 | raw plist contentSha256 / 内容读取 | **删除**；metadata-only；无 digest 优先 |
| P1 | sync lstat/open/read 与 timeout | **放弃 sync**；async fs/promises + absolute deadline + single-settle；F1/F8/F10 生产+fake |
| P1 | fixed path trust / targetToken 类型 | §5.3.1 + §5.4.2 硬表；request 永不含 path |
| P1 | error 去敏 | 禁止 error.code/message/stack/path 进 receipt；仅固定 mapping |
| P1 | O_NOFOLLOW / close / test seam | macOS 强制 O_NOFOLLOW；close fail 保守 mapping；ForTest `@internal TEST ONLY` |
| P2 | Gate 措辞 / 全局 false 当 ready 输入 | §7.2 明确独立事实 vs fail-closed 边界断言 |
| P2 | validation 无 statusResult / observation false | §7.2–7.3 补行 |
| P2 | Web 消费点仅 gate 非 live | §7.3 明确 |
| P2 | failure matrix / TDD / scope 与 async 对齐 | §6/§10 全量重写；删 sync/content-hash/fake-only 矛盾 |
| P2 | V2.0 Gold/GA + 跨局域网 | §12.3–12.4 简洁声明；不扩 V1.33 scope |

---

## Key Decisions

1. **选 A（real observational status metadata）**，拒绝 B/C — blast radius 与 real-kind 进度最优。
2. **独立 async RealStatusProof**，不扩 RealRenderProof，本版不做 generic framework。
3. **async Node `fs/promises` 固定 path 元数据只读**，禁止 shell/launchctl/process list/Sync/content-read；禁止静态 status API 冒充。
4. **遵守 V1.32 `hostSideEffectOccurred`**：真实 fs observation 开始后 observation=true **且** sideEffect=true，mutation=false；**不**抬升 execute/全局 real/wiring/Gold。
5. **无 contentSha256 / 无 content read**；statusResult = presence + isRegularFile + readability + sizeClass。
6. **全局 real / execute / wiring / Gold 不抬升**；wiring-missing 保留；全局 false 是独立事实。
7. **`presence:absent` 仍是 completed real**（诚实观测）。
8. **测试 inject 允许，生产默认真实 reader**；ForTest 永不进入 bootstrap；二者不得混淆证据等级。
9. **V2.0 定义 Gold/GA；跨局域网为 V2.0 强制里程碑**；不得由 V1.33 暗示完成。
10. **恢复锚点 `c311a7e`**；禁止 `git reset --hard` 常规化。

---

## Open Questions

无阻塞性问题。下列默认已关闭（实现不得擅自反转）：

1. targetToken 仅 `linke-launch-agent-default`（单 token 最小 allowlist；exact string）。
2. proof invoke **async**（`fs/promises` + absolute deadline + single-settle）；authorize 可 sync。
3. EACCES → **completed + presence unreadable**（而非 error），以区分 validation 与 observation。
4. gate/Web **不**触发 live host observation；无 statusResult 展示。
5. `sideEffectClass:'observational-read'`（不用 `'none'`，避免与 render 混淆）。
6. **首选完全无 digest**；若需 digest 仅允许 sanitized schema canonical digest（非内容）。
7. O_NOFOLLOW 在 macOS **必须**启用；close failure → 保守 observation-failed；single receipt。
8. 跨局域网 / Gold-GA **不在** V1.33。
