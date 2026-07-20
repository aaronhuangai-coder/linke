# V1.38 Read-Only Audit Integrity Run-Once Monitor/Alert Design

## 目标

V1.38 在 **V1.37 journal-first crash-recoverable audit dual-write coordinator** 之上，交付 **M6d T6d.4 最小可用**：

- **只读、单次运行** audit integrity monitor
- **机器可消费** 的本地 alert contract（固定 JSON + exit code）

> **本版交付目标（设计阶段；实现后才算完成）：**
> - public **read-only** dual-write inspector（`src/audit-integrity-dual-write.js` 内；共享 queue 取 **fresh lease** 做一致观察）
> - monitor 核心（`src/audit-integrity-monitor.js`）只调 public inspector；输出冻结 report
> - Agent CLI：`audit-integrity-monitor --data-dir <path>`；stdout 固定 JSON；exit `0|1|2`
>
> **签字上限（唯一允许的完成宣称）：**
> `V1.38 read-only audit integrity run-once monitor/alert implementation`
>
> **定位：** 可把 **T6d.4 minimum viable run-once path** 标为 delivered，但：
> - **production-hardening = partial**；Gold **blocked 4/4/1/9**
> - **T6d.3 still partial**；**not** T6d.3 complete；**not** M6d Exit；**not** Gold
> - **no** managed/background scheduler（T6d.2 separate）
> - **no** remote notification delivery / webhook / email / SaaS
> - **not** multi-process exclusive lock
> - **no** journal rotation / automatic next generation
> - **no** caller delivery enforcement；server/agent 现有 audit catch **不改**
> - **no** external anchor / HMAC / signature / authenticity / immutable / state continuity
> - **no** repair / bootstrap / recovery writes by monitor
> - **no** HTTP/Web endpoint；**不**把 hardening-status boolean panel 当 monitor

### 关键边界

| 层级 | V1.38 是否完成（实现后） | 含义 |
| --- | --- | --- |
| **read-only run-once monitor + local alert contract** | **是** | 库 + Agent CLI；单次执行 |
| **一致观察（同进程 shared queue + fresh lease）** | **是** | 观察不撞本进程 writer；**不**宣称 multi-process 安全 |
| **machine-consumable stdout JSON + exit 0/1/2** | **是** | launchd/外部监控可消费 exit 2；本版不实现调度 |
| **T6d.4 minimum viable run-once path** | **是（可标 delivered）** | 仅最小探针路径 |
| **T6d.3 complete** | **否** | still partial |
| **T6d.2 managed scheduler** | **否** | separate |
| **M6d Exit / production-hardening ready** | **否** | scorecard 仍 partial |
| **remote alert delivered / production monitoring ready** | **否** | 严禁宣称 |
| **Gold / GA / V2 / cross-LAN** | **否** | Gold **blocked 4/4/1/9** |
| **新 npm dependency / 环境配置 / 网络** | **否** | Node 内置 + 既有模块 |

**能力名冻结：**

```text
FORBIDDEN as delivered claims:
  - forbidden compound = 前缀 "tamper-" + 后缀 "evident"（完整相邻字面量禁止）
  - "tamper-resistant" / "tamper-proof" as delivered
  - "防篡改能力" / 未限定 "detects deletion"
  - "T6d.3 complete" / "M6d Exit" / "production-hardening ready" as delivered
  - "remote alert delivered" / "production monitoring ready" as delivered
  - "multi-process exclusive lock" / "managed scheduler" as delivered
  - "end-to-end production audit delivery" as delivered
  - "state continuity" / authenticity / immutable as delivered
  - run-once exit 2 冒充 “远程告警已送达” 或 “生产监控已就绪”

ALLOWED capability (only):
  - read-only audit integrity run-once monitor
  - machine-consumable local alert contract (stdout JSON + exit codes)
  - single-process consistent observation via shared write-queue lease

ALLOWED signature ceiling (only):
  - V1.38 read-only audit integrity run-once monitor/alert implementation
```

**角色结论（文档阶段）：** 本任务 **仅 docs（C0）**；设计阶段 `PROCEED` **≠** 实现完成。当前 worktree 事实是 **V1.37**。

### C0 review gate（implementation PROCEED 前强制）

```text
C0 审查门（docs 审查；≠ 实现完成）:
  1. 本 design + 对应 plan 完稿且自洽
  2. GLM 抗辩 PASS（无 P0）后记录
  3. fresh Grok 只读闭环 PASS / PROCEED YES 后记录
  4. PM 验收通过后：C0 可 commit 并开始 C1

任一 FAIL → 禁止 implementation PROCEED；改 docs，不写代码。
禁止把本 C0 文档阶段写成 V1.38 实现完成。
```

**C0 docs review record（仅 docs 审查证据；≠ 实现完成）：**

```text
GLM C0 verdict: PASS
  P0 = 0
  P1 = 0
  P2 = 3
  PROCEED = YES

P2 disposition（PM；第一轮 GLM）:
  全部 3 个 P2 已在本 design + plan 文档收紧，避免实现漂移：
  1) idle + empty / uncovered-events 确定映射（fail-closed integrity-alert）
  2) unsafe/oversize/state IO 与 assertSafeDataRoot 确定映射（io-alert + dual-write-io-error）
  3) Task 0 ERROR_CODES exact preflight（实际 registry / assertRegisteredErrorCode）
  其它冻结合同不变。本记录不得写成实现完成。

fresh Grok C0 verdict（round 1）: PASS
  P0 = 0
  P1 = 0
  P2 = 2
  PROCEED = YES
  FILES_CHANGED = none

P2 disposition（PM；fresh Grok round 1 后收紧；docs only；≠ 实现完成）:
  全部 2 个 P2 已在本 design + plan 文档收紧：
  1) cursor SoT / typed error 精确化：
     同模块外科抽取 private read-only granular helper；
     inspector 只调 granular precise helper，
     禁止 wholesale 调用 V1.37 validateIdleCursorAgainstStoresUnlocked
     （该 wrapper 将 cross-store throw / UTF-8 baseline fail remap 为
      audit-integrity-dual-write-cursor-mismatch，破坏 #8/#9/#10 precise priority）；
     production wrapper 必须委托/refactor 后保持 V1.37 外部 remapping 无回归
  2) relationship 输出确定化：
     prepared/cursor-mismatch/typed-error/IO/RootFail → relationship=null 固定；
     state-missing + receipt 成功 → relationship 精确取 receipt enum；
     state-missing + typed error → relationship=null + typed priority；
     idle healthy/empty/uncovered → exact allowed enum
  本记录仅为 docs review PASS + P2 tightened；不是实现完成。

fresh Grok C0 verdict（final）: PASS
  P0 = 0
  P1 = 0
  P2 = 1
  PROCEED = YES
  FILES_CHANGED = none

P2 disposition（PM；fresh Grok final 后收紧；docs only；≠ 实现完成）:
  唯一 1 个 P2 已在本 design + plan 文档收紧：
  observation 字段 vs report 字段漂移：
    1) inspector observation **仅**使用 `statePresence`
       enum = absent|idle|prepared|invalid|io-error；**删除**不可达/未冻结 `unsafe`
       （V1.37 loadDualWriteStateUnlocked 已将 state symlink/dir/oversize/
        permission/其它 safe-read failure 统一 dual-write IO；RootFail 在
        state read 前统一为 IO observation；本版不额外 occupancy 细分）
    2) observation.stateStatus 保持 idle|prepared|null
    3) observation **禁止** dualWriteState 字段；`dualWriteState=unknown`
       **仅** report 层（C2 映射）；C1 断言 observation.statePresence/stateStatus 等
    4) journalOutcome enum 扩为 missing|verified|typed-error|skipped
       （原则：未执行不得称 typed-error；Sio/RootFail 取 skipped）
    5) Sio/RootFail 全 observation 字段冻结映射（见 §3.2）：
       statePresence=io-error；stateStatus=null；storesEmpty=false（fail-closed）；
       cursorMatch=skipped；journalOutcome=skipped；crossStoreOutcome=skipped；
       relationship=null；reasonCode=audit-integrity-dual-write-io-error；
       errorLayer=state（Sio）/root（RootFail）
  本记录仅为 docs review PASS + P2 tightened；不是实现完成。
```

---

## 0. 源码与测试事实基线（不得猜）

以下来自当前 worktree（**V1.37 已合入**；本 design 撰写时未改任何源码）：

| 项 | 当前事实 |
| --- | --- |
| 分支 / 版本 | `linke-v0.12-web-panel` / `LINKE_RELEASE_VERSION = 'V1.37'` |
| ERROR_CODES closed-set | **60**（V1.37 +5 dual-write 码已计入） |
| Gold | **blocked 4 ready / 4 partial / 1 blocked / total 9**；`production-hardening` **partial** |
| dual-write | `src/audit-integrity-dual-write.js`：bootstrap / prepare / recover / `appendAuditEventWithIntegrityDualWrite` |
| state | `src/audit-integrity-dual-write-state.js`：schema/parser/load/publish/absent gate；`loadDualWriteStateUnlocked` lease-gated |
| queue | `src/audit-integrity-write-queue.js`：same-resolved-root serial + lease；nested enqueue 禁 |
| journal | `src/audit-integrity-journal.js`：plan/publish SoT；`inspect` / `verify` 只读 public/internal |
| cross-store | `src/audit-integrity-cross-store.js`：只读 verifier；relationship 枚举固定 |
| production wiring | `appendAuditEvent` → dual-write；server/agent **best-effort catch 未改** |
| Agent CLI | `src/agent.js`：`parseArgs`；已有 `--data-dir` 等命令；**无** `audit-integrity-monitor` |
| M6d T6d.4 | Gold plan：监控/告警路径最小可用；负向：仅 hardening-status 布尔面板 **不得** ready |
| 测试盘 | suite 使用 `mkdtemp(tmpdir())` |

### 0.1 三路径 + state 隔离（永久保持）

```text
audit/events.jsonl                         ← HTTP/API sanitize 审计
audit/capability-proof-attempts.jsonl      ← capability sink（隔离）
audit/integrity-journal.jsonl              ← integrity chain
audit/integrity-dual-write-state.json      ← single-slot WAL/cursor
```

Monitor **只读**上述 integrity 相关 path（经既有 SoT）；**不写**任何 path；**不**碰 capability sink。

### 0.2 本版关闭 / 不关闭的缺口

| 缺口 | V1.37 | V1.38（实现后） |
| --- | --- | --- |
| 无生产可调用的完整性探针 | 仅库级 dual-write + 显式 recover | **关闭（最小）**：run-once CLI + library |
| 机器可消费 alert 合同 | 无 | **关闭（本地）**：固定 JSON + exit 2 |
| managed scheduler / launchd 内置 | 无 | **仍无**（外部可包一层；本版不实现） |
| remote notification | 无 | **仍无** |
| multi-process exclusive lock | 无 | **仍无** |
| monitor 自动 recover/bootstrap | 无（recover 另 API） | **明确禁止** monitor 写 |
| server/agent catch 吞失败 | 存在 | **仍存在**（不改） |
| ERROR_CODES 扩展 | 60 | **保持 60**（默认不新增） |

---

## 1. 候选评估与选定

| 准则 | **A：read-only library inspector + Agent CLI run-once（选定）** | **B：server 内后台 timer + 本地 alert spool** | **C：先做 multi-process lock 或 external anchor** |
| --- | --- | --- | --- |
| 交付 T6d.4 最小探针 | **是** | 过重；夹带调度/生命周期 | **否**（T6d.3/安全后续，不直接交付探针） |
| 递归/写失败风险 | 低：只读；stdout only | 高：spool 写失败、timer 生命周期、可能递归 audit | 与 T6d.4 最小路径无关 |
| 可被外部监控消费 | exit 2 + JSON | 需额外消费者读 spool | 无本地 alert 合同 |
| 与 V1.37 queue 复用 | fresh lease 一致观察 | server 进程耦合；scope 扩到 T6d.2 | 扩 scope |
| 诚实边界 | 可明确 not remote / not scheduler | 易被误读为 production monitoring ready | 易假绿 “安全完成” |

```text
SELECTED = A read-only library inspector + local Agent CLI
           audit-integrity-monitor --data-dir <path>
           single run; stdout fixed JSON;
           healthy exit 0; attention exit 2; contract error exit 1
REJECTED = B server background timer + local alert spool
           （生命周期 / 递归 / 写失败 / 调度属其它任务；scope 过大）
REJECTED = C multi-process lock 或 external anchor 作为 V1.38 首步
           （T6d.3/安全后续；不直接交付 T6d.4 最小探针）
```

---

## 2. 威胁模型与能力边界

### 2.1 资产

| 资产 | 本版保证 |
| --- | --- |
| A1 events / journal / state bytes | monitor **零写入**；existence + bytes 不变 |
| A2 prepared WAL | 保持 prepared；**不** recover |
| A3 一致性观察 | 同进程：持 fresh lease；不读 active writer 的 prepared 中间态（crash 遗留 prepared 除外） |
| A4 alert contract | 固定 key 序 JSON；path/body/digest/token-free |
| A5 错误码 registry | **保持 60**；condition `code` 独立 enum |

### 2.2 攻击者 / 故障与结果

| 场景 | 结果 |
| --- | --- |
| C1 cold empty stores | `uninitialized` alert；exit 2；**不**自动初始化 |
| C2 state 删除但 journal/events 非空 | `state-missing` alert；exit 2 |
| C3 crash 遗留 prepared | `recovery-required`；bytes 不变；提示显式 recovery |
| C4 idle + cursor 被外部改 | `integrity-alert` + `cursor-mismatch` reasonCode |
| C5 journal/event 损坏 / cross-store broken | sanitized integrity-alert |
| C6 state symlink/dir/oversize/permission/其它 safe read failure；或 RootFail（path unsafe/nonexistent/non-directory/invalid dataDir） | **observation** `statePresence=io-error`（**非** `unsafe`；**无** dualWriteState）；Sio `errorLayer=state` / RootFail `errorLayer=root`；storesEmpty=false；cursor/journal/crossStore=`skipped`；**report** `io-alert` + `dualWriteState=unknown`；`relationship=null`；`reasonCode=audit-integrity-dual-write-io-error`；RootFail：**enqueue 0**；**不**创建 root；**非** integrity-alert / invalid |
| C7 本进程 active dual-write | monitor **排队**等待；看到稳定 post；不读半事务中间态 |
| C8 multi-process 并发写 | **不保证**；limitation |
| C9 hostile options（inspector vs monitor 分流） | **inspector**：options 完全 reserved；`void options`；不做任何 property/reflection/enumeration → hostile Proxy traps **不运行**。**monitor**：不枚举字符串键；test-only checkedAt 仅经 `Object.getOwnPropertyDescriptor(options, SYMBOL)` 接受「普通 own data property」（own `value` 且无 get/set）且值严格 ISO；**getter 不得执行**；Proxy 的 `getOwnPropertyDescriptor` trap **可能**执行（语言事实）→ trap 抛错/非法 descriptor 必须 try/catch 退回真实时钟（或内部安全默认）；**trap 不得逃逸或把 raw error/path/body/digest/token 泄漏到 report/CLI**（禁止宣称 monitor “完全不触发 Proxy trap”） |
| C10 CLI 额外 args / token / recover | contract error exit 1；stderr 固定脱敏 |
| C11 把 exit 2 当远程送达 | 文档/honesty 禁止 |

### 2.3 明确不防 / 不宣称

1. remote notification delivery
2. managed background scheduler / production monitoring ready
3. multi-process exclusive writer correctness
4. authenticity / external anchor / state continuity
5. monitor 自动 repair/bootstrap/recovery
6. caller 强制 delivery
7. HTTP/Web monitor surface
8. ERROR_CODES 扩展（默认）

---

## 3. 架构总览

```text
  external cron/launchd/human
            │
            ▼
  node src/agent.js audit-integrity-monitor --data-dir <path>
            │  only command + exact --data-dir
            │  no network / no file write / no --recover
            ▼
  src/audit-integrity-monitor.js
            │  ONLY public read-only inspector
            │  map observation → frozen report
            │  reasonCode: direct map from observation (trusted contract)
            │  NO ERROR_CODES membership whitelist / NO registry copy
            │  structure fail-closed only → integrity-alert + reasonCode null
            │  FORBIDDEN: unlocked mutators / safe write /
            │             audit-log / server / agent / error-codes /
            │             copy state schema / digest-link /
            │             cursor formula / cross-store formula
            ▼
  src/audit-integrity-dual-write.js
     inspectAuditIntegrityDualWriteReadOnly(dataDir, options?)
            │  1) assertSafeDataRoot first
            │     RootFail (unsafe/nonexistent/non-directory/invalid dataDir)
            │       → frozen path-free IO observation (#7b); enqueue 0;
            │         no root create; return
            │     valid resolvedRoot only → enqueue exactly once + fresh lease
            │  2) under lease: read-only probes via existing SoT
            │  observation.reasonCode SoT: registered ERROR_CODES | null
            │  (reuse module existing ERROR_CODES import/typed errors;
            │   NO new codes; closed-set remains 60)
            │  FORBIDDEN: bootstrap / recover / publish / write
            ├─→ dual-write-state load / path occupancy (read)
            ├─→ journal inspect/verify (read)
            ├─→ cross-store verify (read)
            └─→ idle cursor SoT via private granular read-only helper
                 (same module extraction/reuse; NOT wholesale
                  validateIdleCursorAgainstStoresUnlocked remapping wrapper)
            ▼
  frozen report → stdout JSON
  exit 0 | 2 | 1
```

### 3.1 模块边界与依赖 DAG（冻结）

```text
agent.js  ──import──► audit-integrity-monitor.js
                          │
                          └──import──► audit-integrity-dual-write.js
                                          │  (public read-only inspector only)
                                          ├─→ write-queue (enqueue + lease only)
                                          ├─→ dual-write-state load (read)
                                          ├─→ journal inspect/verify (read)
                                          └─→ cross-store verify (read)

monitor     ↛ dual-write-state / journal / cross-store / queue / audit-log / server
monitor     ↛ unlocked mutators / safeAtomic* / safeAppend*
monitor     ↛ error-codes（reasonCode membership SoT 在 inspector observation）
dual-write inspector ↛ bootstrap/recover/publish path on this code path
server/web  ↛ monitor (zero wiring)
```

| 模块 | 职责 | 可写？ |
| --- | --- | --- |
| `src/audit-integrity-dual-write.js` | 新增 **public read-only inspector**；同模块抽取 private **granular** cursor/cross-store read-only helper（reuse journal/events fingerprint + cross-store SoT；**禁止**复制 formula）；inspector 调 granular precise helper；**不** wholesale 调 V1.37 remapping wrapper；**observation.reasonCode SoT**（已注册 ERROR_CODES 或 null；复用本模块既有 ERROR_CODES import/typed errors；不新增码；closed-set 60） | **否**（本路径） |
| `src/audit-integrity-monitor.js` | report 映射（reasonCode **直接映射** observation；结构 fail-closed）、exit helper、JSON stringify 固定 key 序；**无** membership whitelist / **无** registry 复制 | **否** |
| `src/agent.js` | CLI dispatch exact-one；args 合同 | **否**（本命令） |
| queue / state / journal / cross-store | 既有；inspector 只读复用 | 不变职责 |

### 3.2 Public read-only inspector（冻结）

```js
/**
 * Read-only consistent observation of dual-write integrity stores.
 * assertSafeDataRoot first; RootFail → frozen path-free IO observation
 * (enqueue 0; no root create). Valid resolvedRoot only → enqueue exactly
 * once + fresh lease → observe → return frozen snapshot.
 * NEVER bootstrap / recover / publish / write any store.
 *
 * @param {string} dataDir
 * @param {object} [options] fully reserved; void options; no property/reflection/enumeration
 * @returns {Promise<Readonly<DualWriteReadOnlyObservation>>}
 */
export async function inspectAuditIntegrityDualWriteReadOnly(dataDir, options = {}) { /* ... */ }
```

**inspector options 合同（冻结；与 monitor 分流）：**

```text
inspectAuditIntegrityDualWriteReadOnly(dataDir, options):
  - options 完全 reserved（实现阶段不消费任何键/Symbol）
  - 必须 void options（或等价：参数存在但不读）
  - 禁止 Object.keys / for…in / Object.getOwnProperty* /
        Reflect.* / JSON.stringify(options) / options[any] 读取
  - 因此 hostile Proxy traps 在 inspector 路径 **不运行**
  - 测试可断言：传入 hostile Proxy 时 get/getOwnPropertyDescriptor/ownKeys 等 trap **零次**调用
```

**Observation 内部字段（实现冻结；不直接当 CLI 输出；≠ report schema）：**

| 字段 | 枚举 / 类型 | 备注 |
| --- | --- | --- |
| `statePresence` | `absent` \| `idle` \| `prepared` \| `invalid` \| `io-error` | **仅** occupancy/load 结果；**删除** `unsafe`（不可达/未冻结；见下） |
| `stateStatus` | `idle` \| `prepared` \| `null` | 仅合法 parse 后回显 status；Sio/RootFail/absent/invalid → `null` |
| `storesEmpty` | boolean | **existing SoT** 判定：journal missing/not-init **且** events missing-or-zero-strict；**无法安全证明 empty 时 fail-closed = `false`**（Sio/RootFail） |
| `cursorMatch` | `n/a` \| `match` \| `mismatch` \| `skipped` | 未探测 → `skipped` |
| `journalOutcome` | `missing` \| `verified` \| `typed-error` \| `skipped` | **原则：未执行不得称 `typed-error`**；未探测 → `skipped` |
| `crossStoreOutcome` | `ok` \| `typed-error` \| `skipped` | 未探测 → `skipped` |
| `relationship` | 既有 relationship 枚举或 `null` | 见 §3.6 确定化 |
| `reasonCode` | **SoT：** 已注册 ERROR_CODES 值或 `null`（见下） | membership 见下 |
| `errorLayer` | `none` \| `state` \| `journal` \| `events` \| `cross-store` \| `cursor` \| `root` | Sio=`state`；RootFail=`root` |

**observation vs report 字段边界（冻结；防漂移）：**

```text
OBSERVATION（inspector 返回；C1 断言）:
  有: statePresence, stateStatus, storesEmpty, cursorMatch,
      journalOutcome, crossStoreOutcome, relationship, reasonCode, errorLayer
  无: dualWriteState  ← FORBIDDEN on observation（report-only）

REPORT（monitor 映射；C2/C3 断言）:
  有: dualWriteState = idle|prepared|missing|invalid|unknown
  无: statePresence / stateStatus / storesEmpty / cursorMatch /
      journalOutcome / crossStoreOutcome / errorLayer
      （这些是内部 observation；不进 CLI JSON）

映射提示（非完整表；完整见 §3.6）:
  statePresence=absent      → report.dualWriteState=missing
  statePresence=idle        → report.dualWriteState=idle
  statePresence=prepared    → report.dualWriteState=prepared
  statePresence=invalid     → report.dualWriteState=invalid
  statePresence=io-error    → report.dualWriteState=unknown   (#7 Sio / #7b RootFail)
```

**statePresence 删除 `unsafe` 的原因（冻结）：**

```text
V1.37 事实：loadDualWriteStateUnlocked 已将 state symlink / directory /
  oversize / permission / 其它 safe-read failure 统一抛
  audit-integrity-dual-write-io-error → observation.statePresence='io-error'
RootFail（assertSafeDataRoot：path unsafe / nonexistent / non-directory /
  invalid dataDir）在 state read **前**捕获 → 同为 path-free IO observation
  statePresence='io-error'（errorLayer='root' 区分）
本版 **不**额外 occupancy 细分；observation 枚举 **无** `unsafe`。
（assertSafeDataRoot 失败原因字面量 “unsafe path” 仍可存在于 root 合同，
 但 **不是** statePresence 枚举值。）
```

**Sio / RootFail 全字段冻结 observation 映射（C1 必须逐字段 assert；防下一轮漂移）：**

| 字段 | #7 Sio（state symlink/dir/oversize/permission/其它 safe-read failure） | #7b RootFail（assertSafeDataRoot；enqueue 0；不创建 root） |
| --- | --- | --- |
| `statePresence` | **`io-error`** | **`io-error`** |
| `stateStatus` | **`null`** | **`null`** |
| `storesEmpty` | **`false`**（无法安全证明 empty → fail-closed） | **`false`**（同理 fail-closed） |
| `cursorMatch` | **`skipped`** | **`skipped`** |
| `journalOutcome` | **`skipped`**（未执行 journal probe；≠ typed-error） | **`skipped`** |
| `crossStoreOutcome` | **`skipped`** | **`skipped`** |
| `relationship` | **`null`** | **`null`** |
| `reasonCode` | **`audit-integrity-dual-write-io-error`** | **`audit-integrity-dual-write-io-error`** |
| `errorLayer` | **`state`** | **`root`** |
| enqueue | valid root 路径下 exactly once 后观察 | **0**（enqueue 前捕获） |
| path-free | 是 | 是 |

**对应 report 层（仅 C2；observation 无 dualWriteState）：**

```text
#7 / #7b → report:
  status=alert
  code=io-alert
  dualWriteState=unknown          ← report only
  relationship=null
  recoveryRequired=false
  nextAction=investigate-integrity
  reasonCode=audit-integrity-dual-write-io-error
  alertRequired=true
```

**reasonCode observation 合同（membership SoT；冻结）：**

```text
inspectAuditIntegrityDualWriteReadOnly observation.reasonCode:
  - 仅允许：已注册 ERROR_CODES 值，或 null
  - 产出位置：本 dual-write 模块（已有 ERROR_CODES import / typed errors 路径）
  - 复用既有注册码；默认不新增 ERROR_CODES；closed-set 仍 60
  - 非 null 时必须可 assertRegisteredErrorCode / ∈ 实际 ERROR_CODES
  - 禁止在 observation 侧维护第二份独立 code 列表副本
  - C1 membership 测试锁定本合同；monitor 不再做 membership 复验
```

**一致观察规则：**

1. **先** `assertSafeDataRoot(dataDir)`：
   - **RootFail**（unsafe / nonexistent / non-directory / invalid dataDir）在 enqueue **前**捕获 → 返回冻结 path-free IO observation（#7b）；**不**创建 root；`enqueueAuditIntegrityWriteTask` 调用次数 **0**。
   - **仅**成功解析出 `resolvedRoot` 的路径才 `enqueueAuditIntegrityWriteTask(resolvedRoot, …)` **exactly once** + fresh lease；callback 内 `assertAuditIntegrityWriteLease`。
   - **禁止**绝对句 “resolves → 必须 enqueue once” 覆盖 RootFail；正确合同：valid resolved root exactly once；RootFail zero enqueue。
2. lease 内 **只读**：`loadDualWriteStateUnlocked`（或 path occupancy 探测 + load）、journal inspect/verify、cross-store verify、idle cursor SoT via **private granular read-only helper**（见下；**禁止** wholesale 调 V1.37 remapping wrapper）。
3. **禁止**调用：`bootstrap*`、`recover*`、`publishDualWriteState*`、`plan*`/`publishPlanned*`、events append/atomic write、任何 `safeAtomic*`/`safeAppend*`/`safeCreateExclusive*`。
4. **禁止**复制：state schema 序列化公式、digest/link 公式、cursor 验证公式、cross-store 关系公式——**调用/抽取复用**既有函数（extraction/reuse only）。
5. active writer 时 monitor **排队**；writer settle 后观察稳定 post；**不得**读到同进程 active 事务的 prepared 中间态（crash 遗留 prepared 是稳定磁盘态，允许报告 `recovery-required`）。
6. **诚实：** 单进程 queue **不**等于 multi-process lock。
7. **reasonCode：** 触发的第一个注册 ERROR_CODES（无则 null）；membership 由本 observation 合同 + C1 测试保证；idle 路径 **precise typed priority** 不得被 cursor-mismatch remapping 吞掉。

**Idle cursor / cross-store granular helper（C1 冻结实现方式；同模块 extraction；禁止“任选”）：**

```text
V1.37 事实：private validateIdleCursorAgainstStoresUnlocked
  - journal typed error 已原样上抛（measureJournalFingerprint 无 catch）
  - journal/events raw fingerprint field mismatch → cursor-mismatch
  - UTF-8 baseline fail（assertEventsUtf8Baseline → CROSS_STORE_EVENT_INVALID）
    与 verifyCrossStoreBaseline throw 一律 catch remap → cursor-mismatch
  - 成功 receipt 后 strictRecordCount ≠ idle state → cursor-mismatch
  → 该 remapping 会破坏 V1.38 #8/#9/#10 precise typed reason priority

C1 冻结实现（同一 src/audit-integrity-dual-write.js；外科抽取/重构）：
  抽取 private read-only granular helper，复用现有 journal/events fingerprint
  与 cross-store SoT（禁止复制 cursor/digest/cross-store formula）：

  granular precise 分类（inspector 只调此 helper；不调 remapping wrapper）：
    1) journal typed error → 原样保留（not-initialized / io / chain 等）
    2) journal/events raw fingerprint field mismatch →
         audit-integrity-dual-write-cursor-mismatch
    3) cross-store event invalid / broken / io / bounds（含 UTF-8 baseline
         抛出的 CROSS_STORE_EVENT_INVALID）→ 原 typed error 保留
    4) cross-store receipt 成功后 strictRecordCount 与 idle state 不符 →
         cursor-mismatch
    5) 成功 → 返回 receipt / relationship（供 #4/#12/#13 映射）

  production validateIdleCursorAgainstStoresUnlocked：
    必须委托/refactor 到同一 granular helper；
    对外保持 V1.37 现有 remapping/行为不变：
      尤其 cross-store typed throw 与 UTF-8 baseline fail → 仍 remap 为
      audit-integrity-dual-write-cursor-mismatch；
    既有 dual-write tests 证明无回归。

  FORBIDDEN:
    - inspector wholesale 调用会吞分类的 remapping wrapper
    - 复制 cursor/digest/cross-store formula（必须 extraction/reuse）
    - 文档写“可调 validateIdleCursor… 或自写比较”等鼓励 wholesale 的模糊句
```

### 3.3 Monitor 核心（冻结）

```js
/** Test-only Symbol; CLI MUST NOT accept wall-clock override. */
export const AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT = Symbol(
  'linke.audit-integrity-monitor.test-checkedAt',
);

/**
 * @param {string} dataDir
 * @param {object} [options] see options contract below (test-only checkedAt via Symbol data property)
 * @returns {Promise<Readonly<AuditIntegrityMonitorReport>>}
 */
export async function runAuditIntegrityMonitor(dataDir, options = {}) { /* ... */ }

/** @returns {0|2} — never 1 (1 is CLI contract only) */
export function auditIntegrityMonitorExitCode(report) { /* ... */ }

/** Fixed key order JSON + trailing "\\n"; deep-frozen report only. */
export function formatAuditIntegrityMonitorReportJson(report) { /* ... */ }
```

**monitor options 合同（冻结；与 inspector 分流）：**

```text
runAuditIntegrityMonitor(dataDir, options):
  1. 不枚举字符串键：禁止 Object.keys / for…in / ownKeys 遍历 / JSON.stringify(options)
     作为读取手段（CLI 永远不传 test Symbol）
  2. test-only checkedAt 唯一读取路径：
       Object.getOwnPropertyDescriptor(options, AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT)
     整个反射读取必须 try/catch
  3. 仅当 descriptor 是「普通 own data property」才采用：
       - descriptor 非 null/undefined
       - own 字段 hasOwn(descriptor, 'value') === true
       - descriptor.get === undefined 且 descriptor.set === undefined
       - typeof descriptor.value === 'string'
       - value 匹配严格 ISO：/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
     否则（缺属性 / accessor / 非法 value / 非法 descriptor）→ 退回真实时钟
       new Date().toISOString()（或内部安全默认时钟路径）
  4. hostile accessor：不得用普通属性读取（options[SYMBOL] / Reflect.get）触发 getter；
     getter **不得执行**
  5. hostile Proxy：语言事实下 getOwnPropertyDescriptor trap **可能**执行；
     禁止文档/实现宣称 “完全不触发 Proxy trap”
     合同改为：trap 不得逃逸；抛错/非法返回值 catch 后退回真实时钟；
     不得把 raw error/path/body/digest/token/stack 泄漏到 report / CLI stdout/stderr
  6. 禁止 CLI 暴露任何时间覆盖 flag；生产路径 options 可省略；CLI 调用永不传 Symbol
```

**依赖收紧（monitor 模块）：**

- monitor **只** import public inspector（`inspectAuditIntegrityDualWriteReadOnly`）
- **禁止** import `error-codes`
- **reasonCode SoT** 在 inspector observation 合同（§3.2）：仅已注册 ERROR_CODES 或 null；dual-write 模块复用既有 ERROR_CODES import/typed errors；**不**新增 code；closed-set 仍 60
- monitor 将 inspector observation 视为**受信内部合同**，**直接映射** `reasonCode` 到 report
- **禁止**在 monitor 做 ERROR_CODES membership whitelist 验证
- **禁止**维护/复制任何 code 列表或 ERROR_CODES registry
- **禁止**设计新内部异常码
- **防御性结构处理（仅此）：** 若 observation 自身不满足冻结结构（缺字段 / 错误类型 / 不可识别 shape 等），monitor fail-closed 映射为 `integrity-alert` 且 `reasonCode: null`
- **禁止**声称 monitor 能在不依赖 registry 的情况下确认任意字符串已注册

### 3.4 Report schema（冻结 exact key order）

```json
{
  "schemaVersion": 1,
  "status": "healthy",
  "code": "healthy",
  "checkedAt": "2026-07-19T00:00:00.000Z",
  "dualWriteState": "idle",
  "relationship": "equal",
  "recoveryRequired": false,
  "alertRequired": false,
  "nextAction": "none",
  "reasonCode": null
}
```

**顶层 key 序（Object.keys 必须逐位相等）：**

`schemaVersion`, `status`, `code`, `checkedAt`, `dualWriteState`, `relationship`, `recoveryRequired`, `alertRequired`, `nextAction`, `reasonCode`

| 字段 | 类型 / 枚举 | 约束 |
| --- | --- | --- |
| `schemaVersion` | number literal `1` | only |
| `status` | `healthy` \| `alert` | only |
| `code` | 见 §3.5 condition enum | **非** ERROR_CODES；独立固定 |
| `checkedAt` | string | 规范 ISO-8601 UTC，毫秒 3 位 + `Z`（`YYYY-MM-DDTHH:mm:ss.sssZ`） |
| `dualWriteState` | `idle` \| `prepared` \| `missing` \| `invalid` \| `unknown` | only |
| `relationship` | 既有 cross-store 枚举或 `null` | `empty` \| `equal` \| `events-suffix-of-journal` \| `journal-suffix-of-events` \| `uncovered-events` \| `null` |
| `recoveryRequired` | boolean | prepared 且可识别为 recovery 目标时 true |
| `alertRequired` | boolean | `status==='alert'` ⇔ true；`healthy` ⇔ false |
| `nextAction` | 见下 | only |
| `reasonCode` | 注册 ERROR_CODES 值或 `null` | SoT = inspector observation；monitor **直接映射**；membership **不**在 monitor 复验；**禁止** message/path/raw/body |

**nextAction 枚举（only）：**

| 值 | 何时 |
| --- | --- |
| `none` | healthy |
| `initialize-via-production-write` | uninitialized（cold empty） |
| `run-explicit-recovery` | recovery-required（prepared） |
| `investigate-integrity` | 其余 alert |

**禁止出现在 report 中：** absolute path、dataDir、event body、digests（payload/link/raw）、transactionId、token、errno message、stack、raw error text。

**序列化：** `JSON.stringify(report)` 依赖插入序；实现用 plain object 按上表顺序赋值；`Object.freeze` 顶层 + 深冻结；stdout **恰好一行 JSON + `\\n`**（或整块 pretty？→ **冻结 compact 单行 + trailing newline**，无 pretty，避免 CLI 漂移）。

> 收紧说明：用户建议字段保留；`alertRequired` 与 `status` 冗余但是机器友好显式位，**保留且强制一致**，不得一个 true 一个 healthy。

### 3.5 Condition code enum（非 ERROR_CODES）

```text
MONITOR_CONDITION_CODES (frozen; NOT registered in ERROR_CODES):
  healthy
  uninitialized
  state-missing
  recovery-required
  integrity-alert
  io-alert
```

**默认不新增 ERROR_CODES**；计数保持 **60**。`reasonCode` **仅**复用既有注册码（或 null）；membership SoT 在 inspector observation（§3.2），**不**在 monitor 白名单。

### 3.6 状态机 / 真值表（冻结）

**术语（stores empty SoT）：**

```text
J∅  = journal missing 或 exact AUDIT_INTEGRITY_NOT_INITIALIZED
E∅  = events ENOENT 或 present 且 strictRecordCount==0（经既有 dual-write/cross-store 读路径）
S∅  = state path exact ENOENT（absent gate 同强度 path occupancy：仅 ENOENT=absent）
Sidle / Sprep = 合法 parse 的 idle / prepared
Sbad = 存在但 schema invalid / wrong order / 非 idle|prepared
       （仅 invalid JSON/schema；≠ symlink/dir/oversize/permission IO）
Sio  = loadDualWriteStateUnlocked 对 state 的 symlink/dir/oversize/permission/
       其它 SafeDataFileError 或 safe-read failure
       （V1.37 事实：统一抛 audit-integrity-dual-write-io-error；ENOENT→null；
        invalid JSON/schema 另抛 audit-integrity-dual-write-state-invalid）
RootFail = assertSafeDataRoot 失败（unsafe/nonexistent/non-directory/invalid dataDir）
           在 enqueue **前**捕获 → 冻结 path-free dual-write IO observation（#7b）；
           **不**创建 root；enqueue 次数 **0**
```

| # | 观察 | status | code | dualWriteState（**report only**） | relationship | recoveryRequired | nextAction | reasonCode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | S∅ ∧ J∅ ∧ E∅ | alert | `uninitialized` | `missing` | **`null` 固定** | false | `initialize-via-production-write` | `null` |
| 2a | S∅ ∧ ¬(J∅∧E∅) ∧ 只读 cross-store receipt **成功** | alert | `state-missing` | `missing` | **精确取 receipt enum**（`empty`/`equal`/`events-suffix-of-journal`/`journal-suffix-of-events`/`uncovered-events` 之一） | false | `investigate-integrity` | **`null` 固定** |
| 2b | S∅ ∧ ¬(J∅∧E∅) ∧ journal/events/cross-store **typed error** | alert | typed priority：`integrity-alert` 或 `io-alert` | `missing` | **`null` 固定** | false | `investigate-integrity` | **对应 typed 注册码**（优先于 state-missing） |
| 3 | Sprep 合法 | alert | `recovery-required` | `prepared` | **`null` 固定** | true | `run-explicit-recovery` | `null` |
| 4 | Sidle ∧ cursor exact match ∧ journal initialized+verified ∧ cross-store ok ∧ relationship ∈ {`equal`,`events-suffix-of-journal`,`journal-suffix-of-events`} | healthy | `healthy` | `idle` | **exact receipt allowed enum**（上列之一） | false | `none` | `null` |
| 5 | Sidle ∧ cursor mismatch（raw fingerprint field mismatch **或** receipt 成功后 strictRecordCount 与 idle 不符） | alert | `integrity-alert` | `idle` | **`null` 固定**（即便内部先前取得 receipt 也不输出） | false | `investigate-integrity` | `audit-integrity-dual-write-cursor-mismatch` |
| 6 | Sbad（invalid JSON/schema） | alert | `integrity-alert` | `invalid` | **`null` 固定** | false | `investigate-integrity` | `audit-integrity-dual-write-state-invalid` |
| 7 | Sio（state symlink/dir/oversize/permission/其它 safe read failure）；**obs** `statePresence=io-error` / `errorLayer=state` / probes `skipped`（§3.2） | alert | `io-alert` | `unknown`（**非** obs 字段） | **`null` 固定** | false | `investigate-integrity` | `audit-integrity-dual-write-io-error` |
| 7b | RootFail（assertSafeDataRoot：path unsafe/nonexistent/non-directory/invalid dataDir；enqueue 前捕获；enqueue 0；不创建 root）；**obs** `statePresence=io-error` / `errorLayer=root` / probes `skipped`（§3.2） | alert | `io-alert` | `unknown`（**非** obs 字段） | **`null` 固定** | false | `investigate-integrity` | `audit-integrity-dual-write-io-error` |
| 8 | journal chain / event invalid（typed integrity；非 IO；含 granular 保留的 journal/cross-store integrity typed） | alert | `integrity-alert` | 已知 state 值保留 | **`null` 固定** | false | `investigate-integrity` | journal/cross-store 对应注册 integrity 码（**非** cursor-mismatch） |
| 9 | cross-store broken（typed） | alert | `integrity-alert` | 已知 state 值保留 | **`null` 固定** | false | `investigate-integrity` | `audit-integrity-cross-store-broken`（**非** cursor-mismatch） |
| 10 | events/journal/cross-store **自身** typed IO | alert | `io-alert` | **已知 state 值保留** | **`null` 固定** | false | `investigate-integrity` | 对应已注册 `*-io-error`（**非** cursor-mismatch） |
| 11 | **P6a：** Sidle ∧ journal missing 或 exact `AUDIT_INTEGRITY_NOT_INITIALIZED`（events 亦可 empty） | alert | `integrity-alert` | `idle` | **`null` 固定** | false | `investigate-integrity` | `audit-integrity-not-initialized` |
| 12 | **idle+empty：** Sidle ∧ cursor exact match ∧ journal 已 initialized 且 verified ∧ cross-store relationship=`empty` | alert | `integrity-alert` | `idle` | **`empty` 固定** | false | `investigate-integrity` | `null` |
| 13 | **idle+uncovered-events：** Sidle ∧ cross-store relationship=`uncovered-events`（V1.37 `verifyAuditIntegrityAgainstEventStore`：J empty + E nonempty → `{state:'partial', relationship:'uncovered-events'}` receipt；**同一次 receipt 不**抛 `cross-store-broken`） | alert | `integrity-alert` | `idle` | **`uncovered-events` 固定** | false | `investigate-integrity` | `null` |

**relationship 输出确定化（全表同步；禁止“null 或可读枚举”模糊句）：**

```text
#1  cold empty (state absent + stores empty)     → relationship=null 固定
#2a state-missing + cross-store receipt 成功      → relationship=精确 receipt enum；reasonCode=null
#2b state-missing 路径上 journal/events/cross-store typed error
                                                → relationship=null；code/reason 按 typed priority
                                                  （integrity-alert 或 io-alert；优先于 state-missing）
#3  valid prepared                              → relationship=null 固定
                                                  recovery-required 优先短路；
                                                  不为填充 relationship 继续探测 cross-store；零写
#4  idle healthy                                → exact receipt allowed enum
                                                  （equal|events-suffix-of-journal|journal-suffix-of-events）
#5  cursor mismatch                             → relationship=null 固定
                                                  （即便 internal 先前取得 receipt 也不输出，保证优先级稳定）
#6/#7/#7b invalid state / state IO / RootFail   → relationship=null 固定
#8/#9/#10 journal/event/cross-store typed       → relationship=null 固定
#11 idle + not-initialized                      → relationship=null 固定
#12 idle + empty                                → relationship=empty 固定
#13 idle + uncovered-events                     → relationship=uncovered-events 固定
```

**prepared 补充：**

- 合法 prepared **一律** `recovery-required`，**即使** stores 已 exact post/post（仍需显式 recovery/idle publish；monitor **不**做）。
- prepared 字段损坏无法 parse → 走 Sbad（#6），**不是** recovery-required。
- **`relationship=null` 固定**；**禁止**为填充 relationship 继续探测 cross-store；recovery-required 优先短路；零写。

**healthy 补充（仅 #4）：**

- 仅 #4 可 `status=healthy` / `code=healthy`。
- `relationship` **必须**为 exact receipt allowed enum：`equal` \| `events-suffix-of-journal` \| `journal-suffix-of-events`。
- 与 V1.37 dual-write supplemental post-receipt allowed set 对齐：该 set **只含**上述三者，**明确拒** `empty`（及 uncovered/broken）。
- **禁止**把 #12 idle+`empty` 或 #13 `uncovered-events` 标 healthy；**不**新增 condition `code`。

**idle + empty / uncovered-events 确定映射（本版保守策略；冻结）：**

```text
#11 P6a journal typed failure（state 已是 idle；≠ #1 cold uninitialized）:
  status=alert
  code=integrity-alert
  dualWriteState=idle
  relationship=null
  recoveryRequired=false
  nextAction=investigate-integrity
  reasonCode=audit-integrity-not-initialized

#12 idle + relationship=empty（cursor exact match；journal initialized+verified）:
  status=alert
  code=integrity-alert
  dualWriteState=idle
  relationship=empty
  recoveryRequired=false
  nextAction=investigate-integrity
  reasonCode=null
  说明：本版保守 run-once attention / fail-closed。
        不得声称 empty 是“损坏证据”；只是 attention，永不 healthy。
        依据：V1.37 ALLOWED_SUPPLEMENTAL_RELATIONSHIPS =
          {equal, events-suffix-of-journal, journal-suffix-of-events} 拒 empty。

#13 uncovered-events（V1.37 事实；固定；禁止二选一）:
  status=alert
  code=integrity-alert
  dualWriteState=idle
  relationship=uncovered-events
  recoveryRequired=false
  nextAction=investigate-integrity
  reasonCode=null
  依据：verifyAuditIntegrityAgainstEventStore 对 J empty + E nonempty
        返回 {state:'partial', relationship:'uncovered-events'}；
        **同一次 receipt 上不会**同时抛 cross-store-broken。
        真正的 typed broken 是另一场景 #9（audit-integrity-cross-store-broken）。
  绝不 healthy；不新增 code；禁止写 “broken 或 null / verifier 抛时通常 broken”。
```

**state / root IO 确定映射（以已验证 V1.37 loader 事实为准；冻结；分 observation / report）：**

```text
loadDualWriteStateUnlocked:
  ENOENT → null（absent；交给 P5）
    observation: statePresence=absent；stateStatus=null
  invalid JSON/schema → audit-integrity-dual-write-state-invalid
    observation #6: statePresence=invalid；stateStatus=null；
      reasonCode=audit-integrity-dual-write-state-invalid；relationship=null
    report #6: integrity-alert + dualWriteState=invalid + 同上 reasonCode
  symlink / directory / oversize / permission / 其它 SafeDataFileError 或 safe-read failure
    → 统一抛 audit-integrity-dual-write-io-error
    observation #7 Sio（全字段；见 §3.2 表）:
      statePresence=io-error；stateStatus=null；storesEmpty=false；
      cursorMatch=skipped；journalOutcome=skipped；crossStoreOutcome=skipped；
      relationship=null；reasonCode=audit-integrity-dual-write-io-error；
      errorLayer=state
    report #7: status=alert；code=io-alert；dualWriteState=unknown；
      relationship=null；recoveryRequired=false；
      nextAction=investigate-integrity；
      reasonCode=audit-integrity-dual-write-io-error
    FORBIDDEN: observation.dualWriteState；statePresence=unsafe

assertSafeDataRoot / RootFail（path unsafe / nonexistent / non-directory / invalid dataDir）:
  在 enqueue **前**捕获；返回冻结 path-free dual-write IO observation（#7b）:
    observation #7b（全字段；见 §3.2 表）:
      statePresence=io-error；stateStatus=null；storesEmpty=false；
      cursorMatch=skipped；journalOutcome=skipped；crossStoreOutcome=skipped；
      relationship=null；reasonCode=audit-integrity-dual-write-io-error；
      errorLayer=root
    report #7b: status=alert；code=io-alert；dualWriteState=unknown；
      relationship=null；recoveryRequired=false；
      nextAction=investigate-integrity；
      reasonCode=audit-integrity-dual-write-io-error
  enqueue 次数 **0**；禁止 ensure/create root；
  禁止把 root 失败写成 integrity-alert 或 report.dualWriteState=invalid
  禁止 observation 使用 dualWriteState 或 statePresence=unsafe
  仅 valid resolvedRoot → enqueueAuditIntegrityWriteTask exactly once + fresh lease

events/journal/cross-store 自身 typed IO（#10）:
  observation: journalOutcome 或 crossStoreOutcome = typed-error（真实 probe 后）；
    已知 statePresence 保留；relationship=null
  report: code=io-alert；reasonCode=各层已注册 IO 码；dualWriteState 保留已知值
  禁止写 “io 或 integrity”“invalid/unknown 二选一” 等不确定措辞
  禁止把未执行的 journal/cross-store probe 标为 typed-error（用 skipped）
```

**uninitialized vs state-missing vs idle+not-initialized：**

- **必须**用 existing journal/events read SoT 判定 stores 是否空；**禁止**只看目录 listing 猜测。
- cold empty（#1）**不**调用 bootstrap；**不**创建 state/journal/events；journal not-initialized 在 S∅∧E∅ 路径视为 empty 组成，**不**单独 integrity-alert。
- state **已** idle 但 journal missing/NOT_INITIALIZED → **#11**（P6a），**不是** #1 uninitialized。

### 3.7 错误优先级（冻结）

观察管线固定顺序；**先命中先分类**（短路）：

```text
P0  dataDir/root resolve 失败
      → CLI 层：argv / parseArgs 合同错误（缺 flag、重复、未知 flag、boolean 等）→ exit 1
         （**不要**把 CLI argv string 合同与 library invalid type 混淆）
      → CLI 合法 argv（non-empty string path）+ RootFail（nonexistent/unsafe/non-directory 等）
        → 库 #7b io-alert → exit **2**（可映射 alert；**不** exit 1）
      → 库 inspect/run 被调用时 RootFail（path unsafe/nonexistent/non-directory/invalid dataDir）
        → 确定 #7b observation（§3.2 全字段）：
          statePresence=io-error；stateStatus=null；storesEmpty=false；
          cursorMatch=skipped；journalOutcome=skipped；crossStoreOutcome=skipped；
          relationship=null；reasonCode=audit-integrity-dual-write-io-error；
          errorLayer=root；enqueue **0**；不创建 root
        → report：io-alert + dualWriteState=unknown（report-only）+ 同上 reason/relationship
P1  state path Sio（symlink/dir/oversize/permission/其它 safe read failure）
      → 确定 #7 observation（§3.2 全字段）：
        statePresence=io-error；stateStatus=null；storesEmpty=false；
        cursorMatch=skipped；journalOutcome=skipped；crossStoreOutcome=skipped；
        relationship=null；reasonCode=audit-integrity-dual-write-io-error；
        errorLayer=state
      → report：io-alert + dualWriteState=unknown（report-only）
      （不再写 “io 或 integrity” / “invalid/unknown 二选一” / observation.dualWriteState）
P2  （已并入 P1：oversize 与其它 safe-read failure 同 dual-write-io-error）
P3  state present + parse invalid（JSON/schema）→ #6
      observation: statePresence=invalid；stateStatus=null；
        reasonCode=audit-integrity-dual-write-state-invalid；relationship=null
      report: integrity-alert + dualWriteState=invalid + 同上 reasonCode
P4  state prepared (valid) → #3 recovery-required
      + relationship=null 固定
      + 停止 “应 recover” 写意图；**不为填充 relationship 继续探测**；零写
P5  state absent:
      P5a stores empty → #1 uninitialized + relationship=null 固定
      P5b stores non-empty:
         P5b-typed journal/events/cross-store typed integrity/IO 已命中
           → #2b：code/reason 按 typed priority（integrity-alert 或 io-alert）
             + dualWriteState=missing + relationship=null 固定
         P5b-ok 只读 cross-store receipt 成功
           → #2a：code=state-missing + dualWriteState=missing
             + relationship=精确 receipt enum + reasonCode=null
P6  state idle（cursor/cross-store 分类经 **granular precise helper**；
      **禁止** wholesale remapping wrapper 吞 typed reason）:
      P6a journal missing / exact NOT_INITIALIZED → #11 integrity-alert
          + dualWriteState=idle + relationship=null
          + reasonCode=audit-integrity-not-initialized
      P6b journal typed integrity fail（chain 等，非 not-init；granular 原样保留）
          → #8 integrity-alert + 对应 journal 注册码 + relationship=null
      P6c raw journal/events fingerprint field mismatch
          → #5 integrity-alert + cursor-mismatch + relationship=null
            （即便 internal 先前取得 receipt 也不输出 relationship）
      P6d cross-store broken / event-invalid / bounds（非 IO；granular 原样保留；
          含 UTF-8 baseline → CROSS_STORE_EVENT_INVALID）
          → #9/#8 integrity-alert + 对应 cross-store 注册码 + relationship=null
          （**禁止** remap 为 cursor-mismatch）
      P6e cross-store / journal / events typed IO → #10 io-alert
          + 对应 *-io-error；dualWriteState 保留 idle（已知）
          + relationship=null（**禁止** remap 为 cursor-mismatch）
      P6f receipt 成功但 strictRecordCount 与 idle state 不符
          → #5 integrity-alert + cursor-mismatch + relationship=null
      P6g relationship=empty（cursor exact match；journal verified；receipt ok）
          → #12 integrity-alert + relationship=empty + reasonCode=null
      P6h relationship=uncovered-events
          → #13 integrity-alert + relationship=uncovered-events
          + reasonCode=null（固定；≠ #9 typed broken）
      P6i all ok 且 relationship ∈ {equal, events-suffix-of-journal,
          journal-suffix-of-events} → #4 healthy
          + relationship=exact receipt allowed enum
```

**映射原则：**

- condition `code` = monitor enum（§3.5）
- `reasonCode` = inspector observation 产出的值（observation 合同保证：触发的 **第一个** 注册 ERROR_CODES，或 null）；monitor **直接映射**
- idle 路径 reason 必须经 granular precise helper：journal typed / cross-store typed / IO **原样保留**；仅 raw fingerprint mismatch 或 receipt 后 strictRecordCount 不符 → cursor-mismatch
- production `validateIdleCursorAgainstStoresUnlocked` 仍可对外 remap cross-store/UTF8 → cursor-mismatch（V1.37 无回归）；**inspector 不得走该 remapping 出口**
- monitor **不**做 ERROR_CODES membership whitelist；结构不满足冻结 observation shape 时 fail-closed → `integrity-alert` + `reasonCode: null`
- **禁止**把 Error.message 拷进 report
- journal `not-initialized` 在 S∅∧J∅∧E∅（#1）路径视为 empty 组成，**不**单独 integrity-alert；**仅** state 已 idle 时走 #11
- **禁止**不确定措辞：`io 或 integrity`、`invalid/unknown` 二选一、idle empty 未定义、`null 或可读枚举`、鼓励 wholesale 调 remapping wrapper
### 3.8 CLI 合同（冻结）

```bash
node src/agent.js audit-integrity-monitor --data-dir <path>
```

| 项 | 合同 |
| --- | --- |
| 接受 | command 名 + **exactly one** `--data-dir` + **exactly one** path 值 |
| 拒绝 | `--token` / `--output` / `--recover` / `--fail-on-blocked` / `--server` / 额外 flag / 位置多余 args / 重复 `--data-dir` / `--data-dir` 无值或 boolean `true` / 未知 flag |
| 网络 | **无** |
| 文件写 | **无**（含 state/journal/events/tmp spool） |
| stdout healthy | 单行 JSON report + `\\n`；exit **0** |
| stdout alert | 同形 JSON；exit **2** |
| stderr contract | 固定短消息（无 raw stack、无绝对 path 回显若可避免；dataDir 用户自知但 report 不含）；exit **1** |
| help | `help` / `-h` / `--help` 可列出命令名；**不得**暗示 remote alert 或 scheduler 已交付 |

**Exit table：**

| exit | 含义 |
| --- | --- |
| 0 | report.status === `healthy` |
| 2 | report.status === `alert`（含 uninitialized / state-missing / recovery-required / integrity / io；**含**合法 argv + nonexistent/unsafe root 的 #7b io-alert） |
| 1 | **仅** CLI/argv 合同错误（缺/重复/未知 flag、非 string 值等）；或进程级无法产生 report 的 programmer misuse。**禁止**把可映射 alert（含合法 path 字符串 + RootFail）塞进 1。**不要**混淆：CLI argv string 合同 vs library invalid dataDir type（后者走 #7b observation，库路径不 exit） |

**prepared 运维说明（文档/ nextAction）：** 用户须 **另行** 显式调用既有 `recoverAuditIntegrityDualWrite` / 未来运维工具；CLI **无** `--recover`，避免 monitor 变 repair。

### 3.9 并发模型（冻结）

```text
IN-PROCESS:
  monitor/inspect: valid resolvedRoot → exactly one enqueue task with fresh lease
  RootFail → enqueue 0（path-free IO observation；no root create）
  concurrent appendAuditEvent on same root → serial behind/before monitor
  canary: active writer running → monitor waits → observes stable post
  canary: failed writer leaves prepared → monitor reports recovery-required; bytes unchanged
  canary: 50 concurrent monitors same root → all complete; no deadlock; no nested enqueue
  canary: cross-root monitors parallel OK（非嵌套）
  FORBIDDEN: monitor callback 内再 enqueue（nested）

MULTI-PROCESS:
  NOT guaranteed
  limitation tests/docs only
```

### 3.10 安全边界 / scans

1. monitor 源码 **无** write API 调用（atomic/append/createExclusive/publish/bootstrap/recover）
2. monitor **无** import：unlocked mutators、audit-log、server、agent、safe-data-files 写接口、**error-codes**
3. monitor **仅** import dual-write **public** inspector；**无** reasonCode membership whitelist / **无** registry 复制
4. agent **仅** import public monitor API；**exact-one** CLI case
5. server / web **zero** monitor wiring
6. **无** `setInterval` / `setTimeout` 常驻 / background handle 在 monitor 模块
7. **无** alert spool 文件
8. ERROR_CODES length **60**
9. honesty：禁止无限定 T6d.3 complete / M6d Exit / production-hardening ready / remote alert delivered / production monitoring ready
10. forbidden compound 仅 runtime concat needle
11. 不改 M1 exit audit markdown
12. 不改 server/agent audit catch

---

## 4. checkedAt 与可测性

```text
DEFAULT = new Date().toISOString()  // 必须匹配严格正则
TEST    = only via Object.getOwnPropertyDescriptor(options, AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT)
          accept only plain own data property descriptor:
            hasOwn value, no get/set, typeof value === 'string',
            value matches /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
          else / throw / illegal descriptor → real clock (fail-closed; no leak)
          FORBIDDEN: ordinary property read options[SYMBOL] (would run accessor getters)
          FORBIDDEN claim: monitor "never triggers any Proxy trap"
          REQUIRED: getOwnPropertyDescriptor trap may run; must not escape or leak
CLI     = 无时间覆盖参数；永不传 test Symbol
REPEAT  = 同 fixture 连续两次：除 checkedAt 外 deep equal；key 序稳定；Object.isFrozen
INSPECTOR options = void only; no Symbol checkedAt path (inspector 不消费 options)
```

---

## 5. 与 V1.35–V1.37 能力叠加（诚实）

```text
V1.35 journal verify: 结构自洽；无 events 关系；无 monitor
V1.36 cross-store: 显式 J↔E；无 production caller；无 monitor
V1.37 dual-write: 生产写路径 + WAL 恢复；无 run-once 探针 surface
V1.38 monitor: + 只读 run-once 观察 + 本地 alert 合同
  − 仍无 scheduler / remote notify / multi-process lock / authenticity
  − 仍无 caller delivery enforcement
  − T6d.3 still partial；T6d.4 minimum viable only；M6d Exit 未完成
  − production-hardening partial；Gold blocked 4/4/1/9
```

---

## 6. Gold / temporal / version 边界

| Flag / 项 | V1.38 实现后值 |
| --- | --- |
| `LINKE_RELEASE_VERSION` | **`V1.38`**（仅 C1–C4 全绿后 C5 升级） |
| Gold overall | **blocked** |
| ready / partial / blocked / total | **4 / 4 / 1 / 9** |
| `production-hardening` | **partial**（**not** ready） |
| T6d.3 | **仍 partial** |
| T6d.4 minimum viable run-once path | **delivered**（仅此窄句） |
| M6d Exit | **否** |
| 签字上限 | `V1.38 read-only audit integrity run-once monitor/alert implementation` |
| M1 Exit audit markdown | **不改** |

README / Gold 若提本版，必须含：

- read-only run-once monitor + local JSON/exit contract
- T6d.4 minimum viable only；not managed scheduler；not remote notification
- T6d.3 partial；not M6d Exit；not production-hardening ready；not Gold
- not multi-process lock / not authenticity / not monitor auto-repair

---

## 7. 风险账本

| ID | 级 | 风险 | 缓解 |
| --- | --- | --- | --- |
| R01 | P0 | monitor 误调用 recover/bootstrap | DAG + scans + zero-write byte canary |
| R02 | P0 | 读到同进程 writer 中间态 | shared queue lease；并发 canary |
| R03 | P0 | report 泄漏 path/body/digest/token | schema 白名单 + tests |
| R04 | P0 | 新增 ERROR_CODES 破坏 60 | 独立 condition enum；registry 锁 60 |
| R05 | P0 | exit 2 冒充 remote delivered / monitoring ready | honesty scans |
| R06 | P0 | CLI `--recover` 使 monitor 变 repair | 拒绝未知 flag；无 recover 分支 |
| R07 | P0 | uninitialized 自动 init | 只读 inspector；cold empty 测 bytes 不增 |
| R08 | P0 | 复制 cursor/cross-store 公式漂移；或 inspector wholesale 调 remapping wrapper 吞 typed reason | 同模块 extraction/reuse granular helper；inspector 只调 precise helper；production wrapper 委托并保持 V1.37 remap |
| R09 | P0 | Gold/T6d.3 假 complete | C5 honesty + 4/4/1/9 锁 |
| R10 | P1 | hostile options Proxy/getter 与 checkedAt 注入矛盾 | **分流合同**：inspector `void options`（traps 不运行）；monitor 仅 `getOwnPropertyDescriptor` 收 data property + try/catch；getter 不执行；Proxy trap 可运行但不得逃逸/泄漏；禁止“完全不触发 trap”句 |
| R11 | P1 | multi-process 被写成安全 | limitation 句 + scans |
| R12 | P1 | server timer 回流 | 拒方案 B；server zero wiring |
| R13 | P1 | prepared 被标 healthy | 真值表 #3 强制 recovery-required |
| R14 | P1 | monitor 无 SoT 的 reasonCode membership whitelist → 复制/漂移 | reasonCode membership SoT 在 inspector observation（dual-write 既有 ERROR_CODES）；monitor **直接映射** + 结构 fail-closed only；**禁止** membership whitelist / registry 复制 / error-codes import；C1 membership；C2 只测映射与结构 |
| R15 | P2 | checkedAt 不可测 | test Symbol 注入 |

---

## 8. 明确不实现清单（V1.38）

1. managed/background scheduler / in-process timer daemon
2. remote webhook/email/SaaS notification
3. multi-process exclusive lock
4. journal rotation / automatic next generation
5. monitor 内 bootstrap/recover/repair/write
6. CLI `--recover` / token / output file / fail-on-blocked
7. HTTP/Web monitor endpoint
8. 修改 server/agent audit catch
9. external anchor / HMAC / signature / authenticity / state continuity
10. 新 npm dependency / 环境变量配置面
11. ERROR_CODES 扩充（默认）
12. 把 hardening-status 面板当 T6d.4 完成证据
13. M1 exit audit markdown 改写
14. T6d.3 complete / M6d Exit / production-hardening ready / Gold ready

---

## 9. 测试要求（设计层）

1. 仅 `mkdtemp(tmpdir())`
2. 矩阵：healthy（#4 allowed relationships）/ cold uninitialized / **state-missing receipt-success（#2a）** / **state-missing typed-error（#2b）** / prepared（relationship=null）/ invalid JSON/schema / state symlink / state dir / state oversize / state permission / root unsafe-or-missing / **cursor mismatch（relationship=null）** / journal broken / event invalid / cross-store broken / typed IO / **idle+journal NOT_INITIALIZED（#11）** / **idle+relationship=empty（#12）** / **idle+uncovered-events（#13）** / **granular canary：raw fp 仍 match 但 cross-store semantic broken/event-invalid → typed code 非 cursor-mismatch** / **真正 raw fingerprint mismatch → cursor-mismatch**
3. **zero writes：** events/journal/state bytes + existence 不变；prepared 保持 prepared；root fail **不**创建 root；prepared 路径不为 relationship 探测而写/继续探测
4. queue concurrency：active writer 前后；failed writer；50 monitors；cross-root；no deadlock/nested enqueue
5. repeated run：仅 checkedAt 可变；key 序/freeze/deep freeze
6. hostile options 分流测试：
   - **inspector**：hostile Proxy 的 get/getOwnPropertyDescriptor/ownKeys 等 trap **零次**运行；observation path-free
   - **monitor**：hostile accessor getter **不执行**；Proxy `getOwnPropertyDescriptor` trap 可运行但抛错/非法 descriptor → 退回真实时钟；report/CLI **无** raw error/path/body/digest/token 泄漏
   - test Symbol 仅 data property 注入生效；accessor / 非 ISO / 反射失败均不采用注入值
7. CLI truth table exit 0/2/1；stdout JSON；stderr 脱敏；无网络/文件写；help 合同
8. static scans：monitor 无 write/unlocked/audit-log/server/agent/**error-codes**；仅 import public inspector；**无** reasonCode membership whitelist / **无** registry 复制；agent 只 import public monitor；server/web zero；exact-one dispatch；no timer；no spool
9. honesty + forbidden runtime needle 扩到 V1.38 docs/source/tests/README/Gold
10. ERROR_CODES **60**；C1 membership 用实际 `ERROR_CODES` / `assertRegisteredErrorCode`（至少锁定 not-initialized / cross-store-broken / dual-write-state-invalid / dual-write-io-error / dual-write-cursor-mismatch 及计划引用的其它 journal/event/cross-store IO/invalid 码）
11. 既有 dual-write 回归 + C8 13-file package + full `npm test` 绿；仅既有 keychain skip；**production validateIdleCursor remapping 无回归**
12. **reasonCode membership：** C1 inspector——任何非 null `observation.reasonCode` 必须 `assertRegisteredErrorCode` / 属于实际 ERROR_CODES；C2 monitor——只测直接映射与结构 fail-closed（坏 shape → `integrity-alert` + `reasonCode: null`），**不**复制 registry、**不**做 membership whitelist
13. **确定映射用例（C1 断言 observation.*；C2 才断言 report.*；禁止 C1 写 observation.dualWriteState）：**
    - **#7 Sio 全字段（C1）：** statePresence=`io-error`；stateStatus=`null`；storesEmpty=`false`；cursorMatch=`skipped`；journalOutcome=`skipped`；crossStoreOutcome=`skipped`；relationship=`null`；reasonCode=`audit-integrity-dual-write-io-error`；errorLayer=`state`（symlink|dir|oversize|permission 同表）
    - **#7b RootFail 全字段（C1）：** 同上但 errorLayer=`root`；enqueue 0；disk 无新建 root；path-free
    - **#7/#7b report（C2 only）：** io-alert / dualWriteState=`unknown` / relationship=null / dual-write-io-error
    - #11 idle + journal NOT_INITIALIZED → C1: statePresence=idle + reasonCode=not-initialized + relationship=null；C2: integrity-alert / dualWriteState=idle / 同上
    - #12 idle + empty → integrity-alert / relationship=empty / reasonCode=null（**不** healthy；不新增 code）
    - #13 uncovered-events → integrity-alert / relationship=uncovered-events / reasonCode=null（固定；≠ #9 broken）
    - #6 invalid JSON → C1: statePresence=invalid；C2: dualWriteState=invalid；reasonCode=state-invalid；relationship=null
    - **#3 prepared valid → C1: statePresence=prepared；C2: recovery-required / dualWriteState=prepared / relationship=null 固定（不继续探测）**
    - **#5 cursor mismatch → relationship=null 固定**
    - **#2a state-missing + receipt 成功 → C1: statePresence=absent；C2: dualWriteState=missing；relationship=精确 receipt enum / reasonCode=null**
    - **#2b state-missing 路径 typed error → relationship=null + typed code/reason**
    - **canary：state raw fingerprints 仍匹配但 cross-store semantic broken/event-invalid → reason=cross-store typed code，非 cursor-mismatch**
    - **canary：真正 raw fingerprint field mismatch → reason=cursor-mismatch**
    - **observation 无 dualWriteState 字段**；**statePresence 无 `unsafe`**；**journalOutcome 含 `skipped`**

---

## 10. 文档阶段约束

- **只允许新建**本 design 与对应 plan
- **不**改 src/test/README/version/Gold/`package-lock.json`
- **不** stage/commit/push（本 C0 作者任务）；实现阶段每 boundary 绿后由 **PM** 精确 commit/push
- 永不 stage 未跟踪 `package-lock.json`
- 设计阶段 `PROCEED` ≠ 实现完成

---

## 11. Definition of Done（实现后）

- [ ] inspector + monitor + CLI 按本 design 冻结合同落地
- [ ] 测试矩阵全绿；zero-write / concurrency / scans / honesty 全绿
- [ ] ERROR_CODES 仍 60；Gold 仍 4/4/1/9；production-hardening partial
- [ ] 唯一签字：`V1.38 read-only audit integrity run-once monitor/alert implementation`
- [ ] 可称 T6d.4 minimum viable run-once path delivered；**不可**称 M6d Exit / remote alert delivered / production monitoring ready
- [ ] full `npm test` 绿；GLM 抗辩 + fresh Grok 闭环通过

**本 design 本身不提升任何 runtime flag。当前事实仍为 V1.37。C0 ≠ V1.38 实现完成。**
