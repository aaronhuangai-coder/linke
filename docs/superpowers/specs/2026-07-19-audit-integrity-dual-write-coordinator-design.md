# V1.37 Journal-First Crash-Recoverable Audit Dual-Write Coordinator Design

## 目标

V1.37 在 **V1.36 audit event/journal cross-store structural consistency verifier** 与 **V1.35 unkeyed audit hash-chain structural consistency foundation** 之上，继续 **M6d T6d.3 partial**，把生产 `appendAuditEvent` 写路径接入一个 **journal-first、崩溃可恢复、单进程串行** 的 `events.jsonl` ↔ `integrity-journal.jsonl` **双写 coordinator**，并用 **durable single-slot WAL/cursor** 精确区分 pre / post / 半写状态。

> **本版交付目标（设计阶段；实现后才算完成）：**
> - 共享 same-resolved-root 单进程写队列（lease-gated；lease settle 仅 queue `finally`）
> - journal event-link **read-only plan → atomic publish** 唯一 SoT（`planAuditIntegrity…` + `publishPlanned…`）
> - durable single-slot state：`audit/integrity-dual-write-state.json`
> - journal-first dual-write 状态机 + 启动/每次 append 恢复真值表
> - public journal-only mutation 的 state-absent gate（**C2 起** state 存在即拒绝 direct init/append；C1 无 gate）
> - retention 两种互斥发布策略（null → append+byte partial **atomic image repair**；enabled → 一次 atomic final image）
> - 唯一生产接线点：`appendAuditEvent`（server/agent 不直接 import coordinator/journal）
>
> **签字上限（唯一允许的完成宣称）：**
> `V1.37 journal-first crash-recoverable audit dual-write coordinator implementation`
>
> **定位：** **T6d.3 still partial** — **不是** T6d.3 complete / **不是** M6d Exit / **不是** production-hardening ready / **不是** Gold ready / **不是** authenticity / external anchor / HMAC / signature / multi-process exclusive lock / journal rotation / monitor/alert / caller delivery enforcement

### 关键边界（必须先读）

| 层级 | V1.37 是否完成（实现后） | 含义 |
| --- | --- | --- |
| **journal-first dual-write coordinator + single-slot WAL** | **是（本设计目标）** | 库级；经 `appendAuditEvent` 唯一接线 |
| **共享 same-resolved-root 单进程写队列 + lease** | **是** | 消除 audit-log / journal 分裂 queue 竞态；unlocked mutator 验 lease |
| **journal event-link 原子发布** | **是** | 崩溃模型下 journal publication 仅 pre/post |
| **exact occurrence 绑定（transactionId + file transition + head/sequence）** | **是（库级）** | 关闭 V1.36 pure-value suffix 的 replay-shaped 歧义（在 dual-write 路径内） |
| **V1.35 journal foundation / V1.36 cross-store verifier** | **保持** | 链 preimage / record schema / path / 只读 verifier 语义保持 |
| **HTTP `events.jsonl` public read shape / sanitize / retention API** | **保持** | `readAuditEvents` 与 `normalizeAuditRetention` 公开语义不破 |
| **T6d.3 complete** | **否** | 仍 partial |
| **M6d Exit / production-hardening ready** | **否** | scorecard 仍 partial |
| **端到端 production audit delivery** | **否** | `server.js`/`agent.js` 仍 best-effort catch |
| **multi-process exclusive writer lock** | **否** | 单进程串行 only |
| **journal rotation / monitor / alert** | **否** | 达 4096 天花板 typed fail-closed |
| **external trusted anchor / HMAC / signature / authenticity** | **否** | SHA-256 仅 fingerprint / 链输入 |
| **state continuity under adversarial state deletion** | **否** | 无 external anchor 时攻击者可删 state 并伪造另一组自洽 stores 触发 re-bootstrap |
| **public HTTP/CLI/Web dual-write API** | **否** | 无新 surface |
| **Gold / GA / V2 / cross-LAN** | **否** | Gold **blocked 4/4/1/9** |
| **新 npm dependency** | **否** | 仅 Node 内置 + 现有 safe-data-files |

**严禁**把 dual-write coordinator 成功、或版本升至 V1.37 冒充：

- T6d.3 complete / M6d Exit / production-hardening ready / **production integration** complete / **production detects** (as full e2e delivery)
- Gold ready / GA / V2.0 / cross-LAN complete
- WORM / immutable / **tamper-proof** / forbidden compound（`tamper-` 与 `evident` 两段；测试 needle 运行时拼接） / **防篡改能力** / **authenticity**
- multi-process exclusive lock / journal rotation / caller 强制 delivery
- 合法 retention 删除已获授权 / legacy 前缀真实已入链
- state deletion 后 re-bootstrap 被写成 delivered protection / state continuity

**能力名冻结：**

```text
FORBIDDEN as delivered claims:
  - forbidden compound = 前缀 "tamper-" + 后缀 "evident"（完整相邻字面量禁止）
  - "tamper-resistant" / "tamper-proof" as delivered
  - "防篡改能力" / 未限定 "detects deletion"
  - "T6d.3 complete" / "M6d Exit" / "production-hardening ready" as delivered
  - "automatic next generation" / "journal rotation" as delivered
  - "end-to-end production audit delivery" as delivered
  - "multi-process exclusive lock" as delivered
  - "state continuity" / "protects against state file deletion re-bootstrap" as delivered

ALLOWED capability (only):
  - journal-first crash-recoverable audit dual-write coordinator
  - events↔journal dual-write with durable single-slot WAL/cursor
  - single-process same-resolved-root serial write queue with lease-gated mutators

ALLOWED signature ceiling (only):
  - V1.37 journal-first crash-recoverable audit dual-write coordinator implementation
```

**角色结论（文档阶段）：** 本任务 **仅 docs（C0）**；设计阶段 `PROCEED` **≠** 实现完成。当前 worktree 事实仍是 **V1.36**。

### C0 review gate（implementation PROCEED 前强制）

```text
C0 审查史（强制记录）：
  第一次 GLM verdict = FAIL
    （retention 两阶段发布 / journal-only 旁路 recover / lease 缺失 /
     bounds 层混用 / 错误码计数旧合同 / C3 stub 假绿 / 授权冲突句 等 P0）
  第二次 GLM verdict = FAIL
    （journal exact post 必须在 prepared 前由 journal module 只读 plan 签发；
     禁止复制 digest/link 公式 / 禁止先写 journal；
     删除 publish(rawPre,recordLine) 含糊接口；
     lease settle 仅 queue infrastructure finally；
     partial recovery 删除 truncate/ftruncate/reappend，改为 atomic byte image；
     C1 无 state gate stub；C2 才有真实 gate；
     prepared+Jpre/Epost 显式 conflict；null partial 六态枚举；
     last* 赋值与 lastSequence 关系；journal-suffix-of-events 可达 canary；
     nested enqueue 不得建议换 root 绕过 等门槛）
  第三次 GLM verdict = PASS（无 P0）
    第四轮窄修并入其 P1/P2 细化并全文一致：
      safeReadBytes 同 fd 二次 fstat size-race；
      recovery 仅靠 next call / explicit recover 的 fresh lease（禁 catch re-grant）；
      journal plan raw 私有化（WeakMap）+ publish 后必须核 post；
      created-empty-partial 为 events 分类、无需 extra flag；
      C2 state 真实完整 schema/parser/publisher/gate（非 skeleton/write-only）；
      nested meta-audit 同/跨 root 均 defer 至 outer settle；
      lastSequence 关系 C2 tests 明确；publish post-write 合同「必须核」
  **fresh Grok** 只读闭环 = PASS / PROCEED YES（无 P0）
    最终措辞修订关闭三条非阻断 finding（本轮；仅 docs）：
      1. C2 concurrent canary 不写「首次 coordinator bootstrap」
         （C2 = 真实 state module + 测试 helper 手工 publish idle|prepared 占位
          ∥ public journal-only init/append；bootstrap 并发迁 C3 行为测 + C6 hostile 复锁）
      2. §3.2 public init/append gate 明确标 C2+；C1 仅 resolve→queue→plan/publish，
         无 state module/gate；删除无条件 gate 冲突
      3. 「V1.35 direct / production append still V1.35 direct」→
         public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
         （明确不是保留 V1.35 safeAppend 半写模型；
          历史 baseline 描述 V1.36 现状仍可保留 safeAppend 事实）

实现 PROCEED 门（docs 审查；≠ 实现完成）：
  1. 本 design + plan 完成本最终措辞修订（关闭非阻断 finding）
  2. 第三次 GLM PASS 已记录（无 P0）
  3. **fresh Grok** 只读闭环 = PASS / PROCEED YES 已记录
  4. PM 验收通过后：**C0 可 commit** 并 **开始 C1**

任一 FAIL → 禁止 implementation PROCEED；改 docs，不写代码。
第三次 GLM PASS + fresh Grok PASS/PROCEED YES 已记录；待 PM 验收后 C0 commit → 开始 C1。
**禁止**把本 C0 文档阶段写成 V1.37 实现完成。
```

---

## 0. 源码与测试事实基线（不得猜）

以下来自当前 worktree（**V1.36 已合入**；本 design 撰写时未改任何源码）：

| 项 | 当前事实 |
| --- | --- |
| 分支 / 版本 | `linke-v0.12-web-panel` / `LINKE_RELEASE_VERSION = 'V1.36'` |
| ERROR_CODES closed-set | **55**（既有 + V1.35 六码 + V1.36 四码 + 既有 `audit-chain-broken`） |
| Gold | **blocked 4 ready / 4 partial / 1 blocked / total 9**；`production-hardening` **partial** |
| journal | `src/audit-integrity-journal.js` → `audit/integrity-journal.jsonl` |
| events | `src/audit-log.js` → `audit/events.jsonl`（`AUDIT_RELATIVE_PATH` **未 export**） |
| cross-store | `src/audit-integrity-cross-store.js` 只读 verifier；**零** production caller |
| schema | `src/audit-event-schema.js`：`sanitizeAuditEvent` / `projectStrict…` / `stringifyStrict…` |
| journal import | `safe-data-files` + `error-codes` + `audit-event-schema`；**禁止** `audit-log` / coordinator |
| audit-log import | schema sanitize + safe-data-files；**禁止** journal / cross-store（实现后仅允许经 coordinator） |
| journal queue | module-private `auditIntegrityJournalQueues`（Map；key = `assertSafeDataRoot`） |
| audit-log queue | module-private `auditFileQueues`（Map；key = `` `${dataDir}\0audit/events.jsonl` ``，**非** resolved root） |
| journal append | **`safeAppendText`**；失败可留 **partial tail**（源码注释与测试明确；**无** truncate/repair） |
| journal init | `safeCreateExclusiveText`（O_EXCL；created:false → already-initialized） |
| journal pre-read | **1_572_864**（1.5 MiB）；size 超限 → **io-error**（≠ bounds） |
| journal lines | existing ≤ **4096** 可 append 至 **4097**；**生成的** link record ≤ **374**；**无 rotation** |
| events cross-store caps | pre-read **16 MiB**；lines **8192**；per-line **16050** |
| events retention | 默认 **disabled / unbounded**（`null`）；`maxEvents===0` 亦 disabled；enabled 时 `compactAuditFile` **后缀** atomic rewrite |
| events append | `safeAppendText`；无 retention 且 queue 空时可 **跳过 queue** 直 append（与 retention 路径不一致；**C5 废除**） |
| events read | `readAuditEvents` **忽略坏行**；**不** fail-closed；**不**适合做 recovery SoT |
| `safeReadText` | 全文件 `Buffer` → `toString('utf8')`；非法 UTF-8 序列会变成 **replacement character**，**不能**用它猜原字节做 partial 分类 |
| production wiring | `server.js` `recordAudit` → `appendAuditEvent` + **catch 仅 console.error**；`agent.js` `appendNasReplicationAudit` → `appendAuditEvent` + **swallow** |
| capability sink | `audit/capability-proof-attempts.jsonl` 独立；**无** journal/cross-store 接线 |
| 历史 scans | journal/cross-store scans **锁死 zero production wiring**（server/agent/audit-log 不得引用 journal/cross-store） |
| V1.36 未关闭 | dual-write、durable cursor、occurrence binding、replay-shaped `E=…+J+J` 歧义、production caller |
| 测试盘 | 既有 suite 使用 `mkdtemp(tmpdir())` |

### 0.1 三路径隔离（永久保持）

```text
audit/events.jsonl                         ← HTTP/API sanitize 审计（可 retention compact）
audit/capability-proof-attempts.jsonl      ← V1.34 capability real-proof sink（隔离）
audit/integrity-journal.jsonl              ← V1.35 integrity chain（generation-open|event-link）
audit/integrity-dual-write-state.json      ← V1.37 single-slot WAL/cursor（本版新增）
```

**不**合并路径；**不**把链字段写入 events body；**不**把 event body/path/secrets 写入错误 message 或 public receipt。

### 0.2 本版关闭 / 不关闭的缺口

| 缺口 | V1.36 | V1.37（实现后，库级 dual-write 路径内） |
| --- | --- | --- |
| events 写与 journal 写分裂 queue 竞态 | 存在（两 Map） | **关闭**（共享 same-resolved-root 队列 + lease） |
| journal append 崩溃半写（partial tail） | 存在（`safeAppendText`） | **关闭**（atomic publish → 仅 pre/post） |
| dual-write 半成功无法判 occurrence | 存在 | **关闭**（prepared WAL + exact pre/post fingerprint） |
| replay-shaped pure-value suffix 歧义 | partial（无 cursor） | **在 dual-write 新写入上关闭**（file transition + journal head/sequence + transactionId） |
| production 经 `appendAuditEvent` 写 journal | 无 | **是（唯一接线）** |
| public journal-only 在 dual-write state 存在时旁路 | 无 gate | **关闭**（state 存在 → DIRECT_MUTATION_BLOCKED） |
| server/agent best-effort catch 吞失败 | 存在 | **仍存在**（诚实 limitation；**不是** e2e delivery；本版不改 catch） |
| multi-process 互斥 | 无 | **仍无** |
| journal 4096 后 rotation | 无 | **仍无**；达上限 fail-closed |
| external authenticity / state continuity | 无 | **仍无**（state 删除 re-bootstrap 诚实 limitation） |
| 双文件一致重写 / 新 generation 配对替换 | 不可检 authenticity | **仍不可**当 authenticity |

---

## 1. 候选评估与选定

必须先比较至少三种方案，再冻结 WAL。

| 准则 | **A：朴素两次 append** | **B：single-slot WAL/cursor + journal-first（选定）** | **C：SQLite / 新依赖 / 整文件多文件“原子”替换** |
| --- | --- | --- | --- |
| 崩溃半成功可判定 | **否**（journal ok + events fail 无法知是否已写 / 写了几次） | **是**（prepared 含 exact pre/post；恢复分类按 retention 策略互斥） | 单 DB 内可；**跨** events 文件仍非 OS 原子 |
| occurrence 绑定 | 靠 last-id/count/suffix **猜** → 重复 payload 假绿 | **file transition + head/sequence + transactionId** | 可能，但引入新依赖/新 schema 面 |
| 依赖与攻击面 | 无新依赖 | 无新依赖；复用 `safeAtomicWriteText` | SQLite/多文件 rename 伪原子 → 拒绝本版 |
| 与现有 journal/events 兼容 | 表面简单 | 显式状态机 + bootstrap 矩阵 | 迁移成本高；events JSONL 兼容破裂 |
| 跨文件原子性诚实 | 假“事务” | **诚实**：单文件 atomic + WAL 恢复；**不**伪称跨文件原子 | 易伪称跨文件原子 → **拒绝** |
| 单进程串行 | 仍要 queue | 共享 queue + lease 一等公民 | 仍要外层锁 |
| V1.37 范围拟合 | 不足 | **匹配签字** | 超 scope / 延期 |

```text
REJECTED = A 朴素两次 append（崩溃半成功且无法判 occurrence）
REJECTED = C SQLite/新依赖或整文件多文件“原子”替换（本版不引入；不能伪称跨文件原子）
SELECTED = B single-slot durable WAL/cursor + journal-first dual-write
MODULES  =
  src/audit-integrity-write-queue.js          // shared queue + lease
  src/audit-integrity-dual-write-state.js     // state schema/read/publish/absent gate
  src/audit-integrity-dual-write.js           // coordinator/bootstrap/recovery
QUEUE    = lease-gated same-resolved-root serial queue
WIRING   = appendAuditEvent → coordinator（唯一生产接线；C5 落地）
```

**跨文件原子性诚实声明（强制）：** POSIX 下无法对两个独立 path 做真正原子 dual-commit。V1.37 保证的是：

1. **每个** durable 单文件发布在崩溃模型下可判定（state / journal 用 atomic write；events 按 retention 策略：null→append+classifier，enabled→一次 atomic final image）；
2. prepared WAL 使任意崩溃点可分类并 **幂等恢复** 到 post/post 或 fail-closed；
3. **不是** “两文件同时可见或同时不可见” 的硬件事务。

---

## 2. 威胁模型与能力边界

### 2.1 资产

| 资产 | 说明 | 本版保证边界 |
| --- | --- | --- |
| A1 events store | `audit/events.jsonl` | dual-write 路径下与 journal 同队列串行；public read 仍宽松 |
| A2 journal store | `audit/integrity-journal.jsonl` | event-link 原子发布；init 仍 exclusive-create |
| A3 single-slot WAL | `audit/integrity-dual-write-state.json` | idle\|prepared；strict schema；atomic publish |
| A4 occurrence | 一次 dual-write 事务 | transactionId + pre→post file transition + journal sequence/head |
| A5 共享队列 + lease | same resolved root | 单进程内 journal/events/state mutator 互斥串行且 lease 校验 |
| A6 path-free errors | typed codes | 无 path / errno / body / secret 泄漏 |

### 2.2 攻击者 / 故障与结果

| 场景 | 能力/故障 | 本版结果 |
| --- | --- | --- |
| C1 进程在 prepared 前崩溃 | kill | stores 不变；下次 append 无 prepared 恢复 |
| C2 prepared 后、journal 前崩溃 | kill | 两边 exact pre → 恢复：journal 用同一 `plan…` 从 prepared+current pre 重建并 assert 后 publish→events→idle |
| C3 journal post 后、events 前崩溃 | kill | journal post + events pre → 只补 events→idle |
| C4a events 半写（**仅** retention null） | append 中断 | events = byte partial / created-empty-partial → **一次** `safeAtomicWriteBytes(preBytes+eventLineBytes)` repair → idle |
| C4b events atomic rename 前（**仅** retention enabled） | kill mid-atomic | events exact pre；**无** partial 分类；重做一次 atomic publish |
| C4c events atomic rename 后（**仅** retention enabled） | kill post-rename | events exact post；只写 idle |
| C5 events post 后、idle 前崩溃 | kill | 两边 post → 只发 idle（幂等） |
| C5b prepared + Jpre + Epost | 外部 mutation/rollback | **recovery-conflict**；保留 prepared；两 store **都不改**（单进程正常崩溃顺序不可达） |
| C6 重复 payload / 同 id / 连续相同事件 | 正常业务 | **不得**靠 last-id/count/suffix；靠 transition+sequence |
| C7 external mutation（idle 后改文件） | 攻击者/运维 | idle cursor 不符 → **fail-closed** cursor-mismatch；**不**自动重基线 |
| C8 journal 达 4096 天花板 | 容量 | preflight **不写 prepared**；stores 不变；typed bounds |
| C9 multi-process 双写 | 第二进程 | **不保证**；limitation（无 exclusive lock） |
| C10 错误消息诱骗 | 含 path/body | path-free；receipt 无 body |
| C11 调用内部 unlocked 原语 | 任意模块 | lease assert + allowlist + scans；**不是**恶意同进程 import 沙箱 |
| C12 server/agent 吞异常 | best-effort | 库抛错仍被吞；**不得**宣称 e2e delivery；本版不改 catch |
| C13 state 存在时 public journal-only | direct init/append | **DIRECT_MUTATION_BLOCKED**（C2 起）；journal/events bytes 不变；**不** auto-recover |
| C14 删除 state + 伪造自洽 stores | 攻击者 | 可触发 re-bootstrap；**不**宣称 state continuity（limitation） |
| C15 init O_EXCL 留下 zero/partial journal | 写中断 | 下次按 `Jbad` fail-closed；**不** auto-repair/unlink/truncate |
| C16 nested enqueue（含 meta-audit） | active lease 内再 enqueue | **拒绝**（同 root 与 cross-root）；**不得**建议“换 root”绕过；meta-audit 必须 outer settle 后 defer；outer task **不** poison |

### 2.3 明确不防 / 不宣称

1. 无 external anchor 时的 authenticity / 防篡改 / 合规审计链完成
2. multi-process exclusive writer correctness
3. journal rotation 后的无限生产写入
4. caller 强制 delivery（server/agent catch；本版不改）
5. capability-proof sink 与 dual-write 合并
6. 把 cross-store `partial` legacy 前缀伪称“已获链覆盖”
7. 把设计 `PROCEED` 或 C0 docs 写成实现完成
8. state 文件删除后的 continuity / re-bootstrap 防护（无 external authenticity）
9. 恶意同进程 JS 绕过 import allowlist 的安全沙箱

### 2.4 与 V1.35 / V1.36 能力叠加（强制诚实）

```text
V1.35 journal verify:
  + 内部结构自洽
  − events-only mutation 不可见
  − suffix rewrite / tail truncation / full replace 不可见（无 anchor）

V1.36 cross-store verifier (explicit call only):
  + linked overlap 内 J↔E 错位可见
  + retention-compatible suffix / legacy partial 显式
  − 无 production caller；无 cursor/occurrence binding
  − replay-shaped E=…+J+J 可能 partial 而非 broken

V1.37 dual-write coordinator (via appendAuditEvent only):
  + 生产写路径 journal-first dual-write + durable WAL 恢复
  + 同 root 串行 + lease-gated unlocked mutators
  + journal atomic event-link；exact occurrence（库级）
  + state 存在时 public journal-only 拒绝（gate）
  + 关闭 dual-write 路径内的半成功/重放猜 occurrence
  − 仍无 authenticity / multi-process lock / rotation / e2e caller delivery
  − 仍无 state continuity under adversarial deletion
  − V1.35 journal-only limitations（无 anchor）不因本版消失
  − legacy 未入链前缀仍 partial（bootstrap 诚实）
  − T6d.3 still partial；M6d Exit 未完成；production-hardening not ready；Gold blocked 4/4/1/9
```

---

## 3. 架构总览

```text
                    ┌─────────────────────────────────────────┐
                    │ server.recordAudit / agent.audit wrapper │
                    │   (best-effort catch — NOT e2e delivery) │
                    └───────────────────┬─────────────────────┘
                                        │
                                        ▼
                          appendAuditEvent(dataDir, event, opts)
                                        │
                                        ▼
                          coordinator (C5 接线后)
                                        │
                    sanitize → strict project → resolve root
                                        │
                                        ▼
        enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
              assert lease on every unlocked mutator
              // lease settle ONLY in queue finally after this task Promise settles
              1 load/bootstrap/recover state → idle validated
              2 journal planAuditIntegrity…（只读 exact post）+ events post fingerprints
              3 durable prepare WAL (status=prepared；不存 raw)
              4 journal publishPlanned…（WeakMap rawPost + atomic write 后**必须核** post）
              5 events post（null: append | enabled: 一次 atomic final；
                 recovery null partial: 一次 safeAtomicWriteBytes image）
              6 expected-post fingerprints + supplemental cross-store check
              7 durable idle cursor（last* from prepared）
        })
                                        │
                    returns sanitized event (public contract unchanged)
```

### 3.1 模块边界与依赖 DAG（冻结）

```text
audit-log  →  audit-integrity-dual-write (coordinator)
                ├─→ audit-integrity-write-queue (lease enqueue)
                ├─→ audit-integrity-dual-write-state
                ├─→ journal unlocked (lease required)
                └─→ events unlocked (lease required)

journal public wrappers
  C1: resolve root → shared queue (lease) → unlocked plan/publish
      // public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
      // 无 state module / 无 gate；**不是** V1.35 safeAppend 半写模型
  C2+: resolve root → shared queue (lease) → inside callback:
      assertDualWriteStateAbsentUnlocked(root, lease)  // 真实 state-absent gate（C2+）
      → journal unlocked plan/publish (lease required)
  // 禁止：先 gate 再 enqueue（TOCTOU）；禁止 C1 gate stub

dual-write-state  不 import journal / coordinator / audit-log
journal           不 import coordinator / audit-log
audit-log         不 import journal public（只经 coordinator）
cross-store       只读；coordinator 可调用 verify 作 supplemental post-check
```

| 模块 | 职责 | 可写？ | 队列 / lease |
| --- | --- | --- | --- |
| `src/audit-integrity-write-queue.js` | same-resolved-root 串行队列 + **module-generated lease** | 否（仅调度） | **唯一** Map |
| `src/audit-integrity-dual-write-state.js` | **C2 起真实完整** state schema/parser/read/publish/**absent gate**（**非** skeleton/write-only）；**不** bootstrap/recover 业务（bootstrap 归 C3） | state | mutator 验 lease（lease 证临界区，**不**判 occupancy） |
| `src/audit-integrity-dual-write.js` | coordinator、bootstrap、prepare/recover | 协调两边 + 经 state 模块写 state | **只** enqueue 一次；内部调 unlocked |
| `src/audit-integrity-journal.js` | init/append/verify/inspect；unlocked **plan + publish** 原语；event-link **atomic** | journal | public API：**先 enqueue 一次**；**C1** callback 内 unlocked plan/publish（public journal-only post-C1 plan/publish SoT；**无** state/gate；**不是** V1.35 safeAppend）；**C2+** callback 内 active lease 下做 **真实** absent gate 再 unlocked；**禁止** dual-write 再调 public enqueue |
| `src/audit-log.js` | `appendAuditEvent` 接线 dual-write；`readAuditEvents` 保持；retention normalize 保持 | events（经 coordinator） | **废除**独立 production 写队列与无 retention fast-path 旁路 |
| `src/audit-integrity-cross-store.js` | 只读 verifier | **否** | **无** |
| `src/safe-data-files.js` | 既有 atomic/append/read + **新增 `safeReadBytes` / `safeAtomicWriteBytes`**（**禁止** truncate/ftruncate 合同） | 通用 | n/a |
| `src/server.js` / `src/agent.js` | 仅 `appendAuditEvent` | 间接 | 不直接 import coordinator/journal |
| `src/capability-audit-sink.js` | 独立 sink | 独立 | **禁止** dual-write/journal import |

### 3.2 共享单进程写队列 + lease capability（冻结）

**目标：** 消除 `auditFileQueues` 与 `auditIntegrityJournalQueues` 的分裂竞态，并用 lease 绑定 “当前 task 持有写权”。

```text
MODULE     = src/audit-integrity-write-queue.js
KEY        = assertSafeDataRoot(root)  // 必须 resolved absolute root，禁止 raw dataDir 字符串
VALUE      = cleanup Promise（identity pattern；与 journal 现网一致）
DEPS       = Node 内置 AsyncLocalStorage（node:async_hooks）；**无新 npm 依赖**

API:
  enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => { ... }) → Promise
  assertAuditIntegrityWriteLease(resolvedRoot, lease) → void  // fail-closed if invalid

LEASE SEMANTICS（运行时可实现；冻结）:
  - lease 由 queue module 创建；绑定 (resolvedRoot, 当前 task)；object identity 唯一
  - queue 执行 callback 时用 AsyncLocalStorage.run(activeLease, ...) 注入当前 lease
  - active leases 同时由 module-private WeakSet/WeakMap 绑定 root 与有效期
    （ALS store + module 元数据双重 SoT；仅 ALS 不足识别 nested enqueue 调用上下文）
  - enqueue 开头检查 current async context：
      若已处于 **任一** active audit write lease
      → **禁止所有 nested enqueue**（同 root 与 cross-root 一律拒绝）
      原因：防 self-deadlock 与 AB/BA lock-order 死锁
      **Limitation（明确）：** active lease 内 meta-audit **必须** 在 outer task Promise settle 后 defer 再 enqueue；
      **禁止**建议“换 root”绕过——cross-root nested 同样拒绝。测试：outer task 拒绝/完成 **不** poison 后续 task。
  - **Lease settle 责任（P0 精确化）：**
      · **只有** queue infrastructure 在 `await task(lease)` 的 **`finally`** 中 expire/delete lease
      · task **无** settle API、**不能**提前失效 lease
      · task Promise settle（fulfill 或 reject）**定义** lease 生命周期终点
      · settle 后 detached continuation 必须 expired 拒绝
  - assertAuditIntegrityWriteLease(resolvedRoot, lease) 同时检查：
      1. lease object identity 仍在 active 集合
      2. lease 绑定 root === resolvedRoot
      3. ALS current store === lease（object identity）
      wrong-root / missing / expired / cross-root / outside-context / wrong identity
      → fail-closed
  - **Recovery lease 来源（P1 冻结；纠正“catch re-grant / 复用 expired”误读）：**
      · **禁止** queue `.catch` 重 grant lease、**禁止** 复用已 expired lease 做 recovery
      · 当前 coordinator task 失败 → prepared 保留 → task settle → **old lease expire** → 错误返回 caller
      · **下一次** `appendAuditEvent` 取得 **全新** queue task / **fresh lease**，在 S3b 发现 prepared
        并在该 fresh lease 内 recover；**或** 显式 internal `recoverAuditIntegrityDualWrite(root)`
        自身 resolve+enqueue 取得 fresh lease
      · process restart 同样靠新调用 / new lease
      · 若当前 task 在 throw **前** 主动执行已设计的内部 reconcile，可用 **当前 active lease**；
        **一旦 settle 绝不可复用**
      · 测试：old lease expired；next call 用 fresh lease recovery 成功/冲突 **不是** lease 错误；
        explicit recover obtains fresh lease
  - C1 错误合同：**既有 path-free `SafeDataFileError`**
    （internal programmer / bypass error；**C1 不提前新增 C2 dual-write error codes**）
    journal public wrapper 若意外遇到可按既有 journal IO 映射
  - unlocked journal / events / state mutators **必须** assert lease
  - public wrappers 每次只 enqueue 一次

HONESTY:
  - 静态 import allowlist 仍是 accidental-bypass guard
  - 这 **不是** 对恶意同进程 JS import 的安全沙箱

SEMANTICS  = previous.catch(()=>{}).then(async () => {
               try {
                 return await als.run(lease, () => task(lease));
               } finally {
                 // ONLY queue infrastructure may settle/expire lease here
                 expireAndDeleteLease(lease);
               }
             });
             // previous.catch(()=>{}) 仅隔离 poison；**绝不** re-grant / 复用 expired lease
             cleanup.finally 删除 self；cleanup.catch(()=>{})
FAILURE    = 单 task 拒绝 **不** poison 后续 task
SCOPE      = 单 Node 进程内；非 multi-process lock
```
**谁必须走该队列：**

1. `initializeAuditIntegrityJournal`（public）— resolve root → enqueue 一次 → callback 内 unlocked init
   - **C1：** 仅 resolve → queue → unlocked init；**无** state module / **无** gate
   - **C2+：** callback 内 active lease 下先做 state-absent gate，再 unlocked init
2. `appendAuditIntegrityEvent`（public）— resolve root → enqueue 一次 → callback 内 unlocked plan/publish
   - **C1：** 仅 resolve → queue → unlocked plan/publish；**无** state module / **无** gate
   - **C2+：** callback 内 active lease 下先做 state-absent gate，再 unlocked plan/publish
   - **禁止**先 gate 再 enqueue（TOCTOU）
3. dual-write coordinator（`appendAuditEvent` 路径）— enqueue 一次
4. 任何会 mutate journal / events / dual-write state 的生产写路径

**public journal-only 冻结顺序（P0；删 TOCTOU；C1/C2 分层）：**

```text
C1 public journal init/append（尚无 state module / 无 gate）:
  resolve root
  enqueue shared root queue
  inside callback, with active lease:
    journal unlocked plan/publish 或 init
  // public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
  // 不是 V1.35 safeAppend 半写模型；无 gate stub / forward import / always-allow

C2+ public journal init/append（真实 gate；gate 仅 C2+）:
  resolve root
  enqueue shared root queue
  inside callback, with active lease:
    assertDualWriteStateAbsentUnlocked(resolvedRoot, lease)  // C2+ only
    journal unlocked plan/publish 或 init
```

- **C2+** gate **必须**在取得 shared queue 后、mutation 前执行，并验证当前 lease；**C1 无 gate**（无 state module）。
- coordinator 对同 root 建 state 与 public journal-only mutation **互斥**（共享同一 queue），因此 **不存在** absent-check 后、enqueue 前 state 被创建再旁路的窗口。
- **删除**所有 “先 gate 再 enqueue” 残留；**删除** C1 gate stub；**删除** 无条件“public 必走 gate”与 C1 冲突句。

**谁禁止走“外层持队列再调会二次 enqueue 的 public API”：**

- dual-write coordinator **已在** queue 内时，**必须**调用 journal / events / state 的 **non-reentrant unlocked 内部原语**（并传入/assert 当前 lease）
- 若误调 public `appendAuditIntegrityEvent` → nested enqueue 被拒绝（同 root 与 cross-root 均 fail-closed；`SafeDataFileError`）

**Unlocked 内部原语（冻结命名意图；实现可 `@internal` 导出供 allowlist 测试）：**

```text
// journal (require valid lease for resolvedRoot) — planning/publish 是唯一 SoT
// DELETED 含糊接口: publishAuditIntegrityEventLinkAtomicUnlocked(root, lease, { rawPre, recordLine })

planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, { generationId, event })
  - assert lease
  - bounded read raw journal
  - full verify + append bounds preflight
  - 用 journal 模块 **唯一 SoT** 计算 canonical payloadDigest、sequence、previous、link record
  - NO filesystem mutation / NO enqueue
  - 返回 module-issued frozen plan（object identity / brand 绑定 same root + active lease）:
      **仅** 可序列化 pre/post metadata（byteLength/sha256/recordCount/sequence/previous/head/link/payload…）
      **禁止** 把 rawPre/rawPost Buffer/string 作为 caller 可访问 plan 字段
  - journal module-private WeakMap 以 plan identity 保存
      `{ resolvedRoot, leaseIdentity, rawPreText, rawPostText }`
      （raw* 为 exact immutable JS string；caller **不可读/改** raw）

publishPlannedAuditIntegrityEventLinkAtomicUnlocked(resolvedRoot, lease, plan)
  - assert lease + plan 由 journal module 签发且绑定 same root / **current active** lease
  - 从 WeakMap 取 exact immutable JS string rawPost；**不信任** caller raw
  - publish 前重新读取当前 journal fingerprint，必须 exact plan.pre（防外部竞态）
  - safeAtomicWriteText exact rawPost（module-private；非 caller 字段）
  - plan lease 已过期 → publish 拒绝；并可删除 private payload
  - **publish atomic write 返回后必须核（非“可核”）**：
      reopen final nofollow + full verify/hash，必须 exact plan.post 才成功；
      否则 typed conflict/io，**不得**当成功 receipt
  - 承认 atomic write return 后、reopen verify 前的 multi-process race 仍属 limitation
appendAuditIntegrityEventUnlocked(resolvedRoot, lease, { generationId, event | ... })
  // public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
  // **必须** 复用 plan… + publishPlanned…（唯一 SoT；不是 V1.35 safeAppend）
initializeAuditIntegrityJournalUnlocked(resolvedRoot, lease, { generationId })
// verify/load helpers 可读（read-only 可不持锁；与写交错时 fail-closed 可接受）

// events (require same lease)
appendAuditEventsLineUnlocked(resolvedRoot, lease, lineUtf8)          // retention === null 热路径
publishAuditEventsFinalImageAtomicUnlocked(resolvedRoot, lease, bytes) // retention.enabled 路径
// recovery（仅 null partial）：safeReadBytes → 内存 preBytes+eventLineBytes → safeAtomicWriteBytes 一次
readAuditEventsRawBytesUnlocked(...)                                  // recovery/classification
// 读后业务 strict parser：fatal UTF-8 decode（见 §3.4 / §5.5 邻接）

// state (require same lease for mutators) — C2 起存在；C1 无 state 模块
loadDualWriteStateUnlocked / publishDualWriteStateUnlocked
assertDualWriteStateAbsentUnlocked(resolvedRoot, lease)
  // public gate 的 queue-内部形态；必须 assert lease；占位判定 only（不 parse schema）
```

**Allowlist / scans：**

- 生产模块中，**仅** `audit-integrity-journal.js`、`audit-integrity-dual-write.js`、`audit-integrity-dual-write-state.js`、`audit-log.js`（必要时）可引用 unlocked 符号
- `server.js` / `agent.js` / `capability-audit-sink.js` / `audit-integrity-cross-store.js` **禁止** import unlocked 或 dual-write 内部
- scans 用静态 import 抽取 + 符号 allowlist；**禁止**假绿（注释里写名字不算 call-site）
- 诚实：allowlist **不是** 恶意同进程沙箱

**journal 迁移：** 删除/停用 module-private `auditIntegrityJournalQueues`，改为 shared queue。历史“sole per-resolved-root write queue”注释与测试 source-contract **必须更新**，不得绕过。

**audit-log 迁移：** production `appendAuditEvent` **不再**使用独立 `auditFileQueues` 作为 dual-write 旁路；废除无 retention 时跳过 queue 的 fast path。所有写经 shared queue。保留 `readAuditEvents` 无队列只读。C5 用静态 scan + 首次 cold append 测试锁死旁路废除。

### 3.3 journal 只读 planning + 原子发布（唯一 SoT；冻结）

**现状：** `appendAuditIntegrityEvent` 在 full verify 后 `safeAppendText(line)` → 崩溃可 partial tail → 后续 verify chain-broken 且 **不** repair。

**V1.37 P0：** coordinator **必须**在写 prepared 之前知道 journal **exact post**。**禁止**复制 journal digest/link 公式；**禁止**先写 journal 再回填 prepared；**禁止**含糊 `publish(rawPre, recordLine)` 接口。

```text
// 正常同进程（dual-write / direct 共用）
plan = planAuditIntegrityEventLinkUnlocked(root, lease, { generationId, event })
  // 只读；签发 frozen plan（caller 仅见可序列化 pre/post metadata）
  // rawPreText/rawPostText 存 journal module-private WeakMap（plan identity）
serialize prepared（仅允许字段；**不**存 rawPre/rawPost）
atomic publish prepared WAL
  // publish 返回后至少 read/parse exact expected status+transaction 再碰下一 store
publishPlannedAuditIntegrityEventLinkAtomicUnlocked(root, lease, plan)
  // re-read current must exact plan.pre
  // → WeakMap rawPostText → safeAtomicWriteText
  // → reopen final nofollow + full verify/hash **必须** exact plan.post

// 崩溃恢复（plan object / WeakMap 丢失；须 fresh lease — 见 §3.2 recovery lease）
if journal current exact prepared.journal.pre:
  plan' = planAuditIntegrityEventLinkUnlocked(root, lease, {
    generationId: prepared.generationId,
    event: prepared.event
  })  // 从 prepared.event/generation + current verified pre 重建
  逐字段 assert plan'.pre/post fingerprints + sequence/previous/head/link/payload
    === prepared.journal.pre/post（完全相等）
  然后 publishPlanned...(plan')
elif journal current exact prepared.journal.post:
  只核验；不写 journal
else:
  recovery-conflict；保留 prepared；不写
// 不得另写 link 公式 / 不得从 state 重算 digest 公式
```

**Public `appendAuditIntegrityEventUnlocked`（public journal-only；post-C1 plan/publish SoT；no dual-write coordinator）** 也必须复用 `plan…` + `publishPlanned…`，因此 planning/publish 是 **唯一 SoT**（**不是** 保留 V1.35 `safeAppendText` 半写模型）。public journal-only append 与 dual-write / recovery 对同一 input 必须得到 **完全相同** line / hash。

**崩溃模型：** journal 文件在 rename 发布点只有 **exact pre** 或 **exact post**；**不再**出现 journal partial tail（atomic temp+rename 语义下）。
**初始化：** 仍 `safeCreateExclusiveText`（exclusive-create 语义保持）。
**Jbad / partial-exclusive-create 诚实：** init 的 O_EXCL write+sync 失败或进程中断若留下 zero/partial journal，下一次按 `Jbad` **fail-closed**；本版 **不** auto-repair / unlink / truncate 空或残缺 journal。
**历史测试：** `safeAppendText` source-contract / partial-tail limitation 测试 **必须改写为 atomic 合同**（禁止留“仍用 append”假绿）。
**verify/inspect：** 语义不变；仍 fail-closed。

**State / events durable publish post-verify（与 journal 同强度意图）：**

```text
凡状态机即将推进到下一步时，应对刚 durable publish 的 store 做 expected post fingerprint check
（events 热路径后 / state prepared|idle 写后 / journal publish 后）：
  - journal：见上 — reopen + full verify/hash **必须** exact plan.post
  - state prepared/idle 写后：至少 read/parse exact expected status + transaction/cursor
    再碰下一 store / 返回 success（现 S3j 已对两边 primary fingerprints 有核）
  - 失败 → typed conflict/io；**不得**当成功 receipt
```

**Plan 测试（强制）：**
1. `plan…` **无** filesystem mutation / **无** enqueue；同 pre 幂等；frozen（签发后字段不可被调用方合法改写为可 publish）
2. direct append 与 dual/recovery 得到完全相同 line/hash
3. `publishPlanned…` 拒 wrong root / wrong lease / forged plan / expired plan / current-pre mismatch
4. prepared 字段人为改一位 → recovery conflict 且 **不写** journal/events
5. 尝试给 plan 加/改 rawPre/rawPost 字段 **无效**（caller 不可读/改 private WeakMap payload）
6. forged plan（非 module-issued / 伪造 brand）→ publish 拒绝
7. post-rename swap injected（atomic write 成功返回后、verify 前被换掉）→ publish **不**报成功
8. plan lease 过期后 publish 拒绝；private payload 可删

### 3.4 events 发布策略 — 两种互斥策略（冻结）

**删除**旧合同：`retention enabled: safeAppendText → compact` 两阶段状态机（append 后 compact）。**不存在** `append-complete/uncompacted` intermediate 分类，也 **禁止** 写虚构 intermediate fingerprint。

| 策略 | 条件 | 发布原语 | prepared 分类 | partial? |
| --- | --- | --- | --- | --- |
| **A: append** | `retention === null`（含 `normalize` 后 0 / disabled） | 热路径 `safeAppendText(exact eventLineUtf8)`；crash recovery 用 **一次** `safeAtomicWriteBytes(preBytes+eventLineBytes)` | exact-pre / exact-post / created-empty-partial / byte partial-prefix / other | **是**（仅本策略；recovery only） |
| **B: atomic final** | `retention.maxEvents >= 1` | 在 prepare **前** 按 strict-valid pre bytes + new line 计算 **最终 retained suffix bytes**；用 **一次** `safeAtomicWriteText`/`safeAtomicWriteBytes` 发布 final retained events image | exact-pre / exact-post / other | **否** |

```text
prepared.events.post  = 始终最终可见 bytes 的 fingerprint
                        （策略 A：pre + line；策略 B：compacted retained suffix）
O(n) 成本              = 策略 B 热路径 + 策略 A **仅 crash recovery** repair（非正常 hot path）
正常 null hot path     = 仍 safeAppend O(line)
公开 retention 结果语义 = 不变（suffix keep maxEvents）
```

#### 3.4.1 safe-data-files 字节原语（冻结；**删除** truncate 合同）

**删除**所有 `safe truncate` / `ftruncate` / `truncate → rehash → append` 合同。

```text
safeReadBytes(root, path, { maxBytes })
  - 安全 parent walk
  - final O_RDONLY | O_NOFOLLOW
  - **初次 fstat**（同一 fd）：记录 dev / ino / size / mode
      必须 regular file；size ≤ maxBytes
  - 按 offset 循环 exact read（读满初次 size）
  - **exact read 结束后对同一 fd 二次 fstat**：
      必须 dev/ino/size 仍相等且仍 regular
      否则 → SafeDataFileError（size-race / same-inode growth|truncate）
  - premature EOF → fail
  - 返回 exact Buffer（或 copy）；**不** UTF-8 decode
  - **atomic pathname rename 语义（诚实）：**
      读期间 fd 仍旧 inode 是可接受 snapshot（rename 换 path 不改变 open fd 内容）
      但后续 publish / repair 前 **必须** 重新读取 pathname 并匹配
      prepared / plan expected current fingerprint；外部变化 → conflict
  - **测试强制：** append / grow / truncate 发生在两次 fstat 之间 → fail

safeAtomicWriteBytes(root, path, buffer, { mode: 0o600 })
  - 复用/抽取现有 same-dir temp：O_EXCL | O_NOFOLLOW
  - fd regular；write all；fsync；close
  - revalidate parent / final
  - rename；best-effort dir sync
  - **不得** follow symlink
```
#### 3.4.2 策略 A null-retention partial 精确枚举（冻结）

分类 **始终在 decode 前按 bytes**；**禁止**用 `safeReadText`→UTF-8 replacement 猜原字节。

**`created-empty-partial` 冻结（纠正“需要 partial flag / 是 journal init”误读）：**

```text
- 这是 **events** 文件分类，**不是** journal init
- 前置：**prepared 已 durable 存在** 且
    prepared.events.pre.present === false
    prepared.events.pre.byteLength === 0
    prepared.events.pre.sha256 === emptyDigest (SHA256(""))
- 观察：current events **present regular empty**（append create 后 0 bytes）
  → 分类 **created-empty-partial**
- **无需**额外 partial flag / 状态字段；仅由 prepared.events.pre 指纹 + current 观察推出
- 若 **没有 prepared** → **不**走 recovery classifier，走 **bootstrap**
- 若 prepared.events.pre.present === true 且 empty → current empty = **exact-pre**
- 测试锁三者：created-empty-partial / 无 prepared→bootstrap / pre.present=true empty→exact-pre
```

| # | 观察 | 分类 | 动作 |
| --- | --- | --- | --- |
| 1 | pre missing + current missing | **exact-pre** | 继续 append / recovery redo append |
| 2 | prepared.events.pre missing/emptyDigest + current present empty（events append create 后 0 bytes） | **`created-empty-partial`** | 可 **atomic repair**：`preBytes=[]` + eventLineBytes → 一次 `safeAtomicWriteBytes` |
| 3 | pre present empty + current present empty | **exact-pre** | 继续 append |
| 4 | pre bytes + nonempty strict prefix of line（prefix 可截在 emoji 多字节中） | **byte partial** | 可 **atomic repair**：`preBytes + eventLineBytes` 一次 write |
| 5 | pre nonempty + current empty；present/missing flag 异常；suffix 非 prefix | **other/conflict** | fail-closed；append **不会**截断 pre |
| 6 | full line（size/hash 匹配 post） | **exact-post** | 只 idle / 跳过 events 写 |
**repair（仅 #2 / #4 成功分类后）：**

```text
// prepared 不存 pre raw
// 但 current partial 文件前 preLength bytes 经 hash 验证就是 exact pre bytes
// 不要写“从 journal raw 恢复 events pre”（GLM 错误提议；prepared 无 pre raw）
preBytes     = (pre missing + created-empty) ? empty Buffer
               : currentBytes.subarray(0, pre.byteLength)  // 已 hash 验证
postBytes    = Buffer.concat([preBytes, eventLineBytes])   // === prepared post image
safeAtomicWriteBytes(root, eventsPath, postBytes, { mode: 0o600 })  // 一次 repair
// 崩溃只保留 partial pre-state 或 exact post；下次恢复幂等
// 这是仅 crash recovery 的 O(n) repair，不是正常 hot path
```

**Hostile canary（强制）：** symlink swap / size grow / short read / premature EOF / **两次 fstat 间 append|grow|truncate** / kill before rename / kill after rename；repair 后 bytes hash **必须** equal prepared post；safeReadBytes 同 fd 二次 fstat 失败 → SafeDataFileError。

**NUL / lone surrogate / emoji：** 分类与 canary 一律 byte 域；JSON UTF-16 code unit ≠ 磁盘 UTF-8 字节。

**events 原始字节严格解码（冻结；两策略共用）：**

```text
coordinator 读取 events raw bytes 后：
  1. partial / pre-post 分类 **始终在 decode 前按 bytes 完成**
  2. 业务 strict parser 必须用 fatal UTF-8 decode，例如：
       new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)
  3. 再做 final newline / JSON / strict canonical 校验
  4. **禁止** replacement character 修复（禁止 Buffer.toString('utf8') /
     TextDecoder 默认 non-fatal 把非法序列变成 U+FFFD 后继续解析）
  5. invalid UTF-8 baseline → fail-closed（state-invalid / cross-store-event-invalid
     映射；bootstrap 与 recovery 均不得当合法基线）
```

**策略 B 崩溃 canary（强制）：**

1. retention atomic publish 在 **rename 前** 观察 events = exact pre；**rename 后** = exact post
2. 恢复幂等；连续 recover N 次不重复改写 occurrence
3. **禁止** 在 prepared 中写入任何 “append-then-compact intermediate” fingerprint

---

## 4. Durable state 文件与 exact schema

### 4.1 路径与 I/O

```text
RELATIVE_PATH = audit/integrity-dual-write-state.json
PUBLISH       = safeAtomicWriteText(..., { mode: 0o600 })
READ          = safeReadText with maxBytes = AUDIT_DUAL_WRITE_STATE_MAX_BYTES（冻结常量）
MISSING       = ENOENT only → treat as state-missing for bootstrap / direct gate；
                其它 SafeDataFileError → dual-write-io-error
OCCUPIED      = 文件存在（idle/prepared/invalid JSON 均可）
                或 leaf 为 symlink / directory / 不可安全判定为 missing
                → 对 public journal-only 一律视为占用
```

**规则：**

- prepared **必须**先 durable publish，再碰 journal/events
- idle **只能**在两边都达到 expected post 之后 publish
- **任何失败路径禁止**把 prepared 清成 idle 或删除 state 以“掩盖”半写
- 成功路径：prepared → … → idle（覆盖同一 single slot）
- 错误 **永不**嵌入 path、绝对路径、event body、canonical payload、secrets
- **publish 前**按 UTF-8 `Buffer.byteLength` 检查序列化结果 ≤ 65536；超限 → `DUAL_WRITE_STATE_INVALID`（生成对象不满足 schema bound；**绝不**先写后读失败）
- oversize **读**（磁盘文件超 maxBytes）→ `DUAL_WRITE_IO_ERROR`

### 4.2 schemaVersion 与 status

```text
schemaVersion = 1   // number literal 1 only
status ∈ { "idle", "prepared" }
```

仅两种 status；未知 status → state-invalid。

### 4.3 规范 JSON 形状（冻结 key 顺序）

实现必须 **JSON.stringify 固定插入顺序**；parser 必须 **Object.keys 逐位相等**（与 journal record 相同强度），拒绝 extra key / 缺 key / 错序。

#### 4.3.1 `status: "idle"` — 完整 key 序

```json
{
  "schemaVersion": 1,
  "status": "idle",
  "generationId": "0123456789abcdef0123456789abcdef",
  "journal": {
    "recordCount": 1,
    "headDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "rawByteLength": 0,
    "rawSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "events": {
    "present": false,
    "byteLength": 0,
    "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "strictRecordCount": 0
  },
  "lastTransactionId": null,
  "lastPayloadDigest": null,
  "lastSequence": null
}
```

**idle 嵌套 key 序：**

- 顶层：`schemaVersion`, `status`, `generationId`, `journal`, `events`, `lastTransactionId`, `lastPayloadDigest`, `lastSequence`
- `journal`：`recordCount`, `headDigest`, `rawByteLength`, `rawSha256`
- `events`：`present`, `byteLength`, `sha256`, `strictRecordCount`

**语义：**

| 字段 | 类型 / 约束 | 含义 |
| --- | --- | --- |
| `generationId` | string `/^[0-9a-f]{32}$/` | 当前 journal generation |
| `journal.recordCount` | safe integer ≥ 1 | open 计入；与 verify 一致 |
| `journal.headDigest` | `/^[0-9a-f]{64}$/` | 链头 linkDigest |
| `journal.rawByteLength` | safe integer ≥ 0 | journal 文件 UTF-8 **字节**长度 |
| `journal.rawSha256` | `/^[0-9a-f]{64}$/` | `SHA256(rawBytes)` — domain-free raw file hash |
| `events.present` | boolean | false = ENOENT 语义上“无文件”；true = 常规文件存在（可空文件） |
| `events.byteLength` | safe integer ≥ 0 | present=false 时 **必须** 0 |
| `events.sha256` | hex64 | present=false 时冻结为 **empty-file digest** `SHA256("")` |
| `events.strictRecordCount` | safe integer ≥ 0 | strict canonical 行数；坏行/非严格 **不允许**进入 idle 基线 |
| `lastTransactionId` | null 或 uuid 规范串 | 最近成功 dual-write；bootstrap 初值 null |
| `lastPayloadDigest` | null 或 hex64 | 最近成功 payloadDigest |
| `lastSequence` | null 或 safe integer ≥ 0 | 最近成功 journal sequence（open=0 时仍 null 直至首 event-link） |

#### 4.3.2 `status: "prepared"` — 完整 key 序

```json
{
  "schemaVersion": 1,
  "status": "prepared",
  "transactionId": "11111111-1111-4111-8111-111111111111",
  "generationId": "0123456789abcdef0123456789abcdef",
  "retention": null,
  "event": {
    "id": "22222222-2222-4222-8222-222222222222",
    "createdAt": "2026-07-19T00:00:00.000Z",
    "type": "api.test"
  },
  "payloadDigest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "eventLineUtf8": "{\"id\":\"22222222-2222-4222-8222-222222222222\",\"createdAt\":\"2026-07-19T00:00:00.000Z\",\"type\":\"api.test\"}\n",
  "journal": {
    "pre": {
      "recordCount": 1,
      "headDigest": "…64 hex…",
      "rawByteLength": 123,
      "rawSha256": "…64 hex…"
    },
    "post": {
      "recordCount": 2,
      "headDigest": "…64 hex…",
      "rawByteLength": 456,
      "rawSha256": "…64 hex…",
      "sequence": 1,
      "linkDigest": "…64 hex…",
      "previousLinkDigest": "…64 hex…"
    }
  },
  "events": {
    "pre": {
      "present": true,
      "byteLength": 10,
      "sha256": "…64 hex…",
      "strictRecordCount": 1
    },
    "post": {
      "present": true,
      "byteLength": 80,
      "sha256": "…64 hex…",
      "strictRecordCount": 2
    }
  }
}
```

**prepared 顶层 key 序：**
`schemaVersion`, `status`, `transactionId`, `generationId`, `retention`, `event`, `payloadDigest`, `eventLineUtf8`, `journal`, `events`

**`retention`：**

- `null` = disabled（与 `normalizeAuditRetention` 后 null 对齐；含 maxEvents=0）
- 或对象 **仅一键**：`{ "maxEvents": <safe integer ≥ 1> }`（key 序仅 `maxEvents`）
- **禁止** `false` / 缺省键 / 额外键
- retention 决定 events **发布策略**（§3.4 互斥）；`events.post` 始终是最终可见 fingerprint

**`event`：** 仅 `projectStrictCanonicalSanitizedEvent` 允许字段；**STRICT_FIELD_ORDER** 子集且 key 序与 schema 固定序一致（`id`, `createdAt`, `type`, …）；**禁止** extra keys / symbol / non-enumerable。
**`eventLineUtf8`：** `stringifyStrictCanonicalSanitizedEvent(event) + "\n"` 的精确字符串；必须与 `event` object 及 strict stringify 一致——**先 `id` 再 `createdAt` 再 `type`**（不得出现 `createdAt`→`id` 顺序）；必须与磁盘将发布的 bytes 在 UTF-8 下一致（策略 A 为 append line；策略 B 为 final image 内最后一行）。
**`payloadDigest`：** `computeAuditIntegrityEventPayloadDigest(event)`；必须与 journal event-link 一致。

**`journal.pre` key 序：** 同 idle.journal 四键。
**`journal.post` key 序：** `recordCount`, `headDigest`, `rawByteLength`, `rawSha256`, `sequence`, `linkDigest`, `previousLinkDigest`
**`events.pre` / `events.post` key 序：** 同 idle.events 四键。

### 4.3.3 prepared / idle 关系不变量（parser 强制；不仅 shape）

state parser **不仅**查 key 序/类型/regex，**还必须**查以下关系；任一失败 → `dual-write-state-invalid`：

```text
PREPARED:
  eventLineUtf8 === stringifyStrictCanonicalSanitizedEvent(event) + '\n'
  payloadDigest === computeAuditIntegrityEventPayloadDigest(event)  // 既有 SoT
  journal.post.recordCount = journal.pre.recordCount + 1
  journal.post.sequence = journal.pre.recordCount
    // open sequence=0 且 recordCount 含 open；首 event-link sequence=1 当 pre.recordCount=1
  journal.post.previousLinkDigest = journal.pre.headDigest
  journal.post.linkDigest = journal.post.headDigest
  // 职责分层（P0）：
  //   state parser **不**凭 pre hash 重算 full raw post hash / link 公式
  //   build 时：journal plan 签发 → prepared.journal.* 与 plan 逐字段相等
  //   recovery 时：journal plan' + current bytes 核验；plan' 与 prepared 逐字段 assert
  events.post.present 必须 true
  retention === null:
    events.post.strictRecordCount = events.pre.strictRecordCount + 1
  retention.enabled (maxEvents ≥ 1):
    events.post.strictRecordCount = min(events.pre.strictRecordCount + 1, maxEvents)

IDLE:
  lastTransactionId, lastPayloadDigest, lastSequence 必须：
    all-null（bootstrap 初值） 或 all-non-null（已至少一次成功 commit）
  all-non-null 时：lastSequence === journal.recordCount - 1
    // 与 journal 既有 lastSequence = recordCount - 1 关系一致；C2 test 锁死
  **不**要求 bootstrap 在 existing journal 上填 last*（允许 all-null）

成功 idle 赋值（S3l；从 prepared 明确赋值）：
  lastTransactionId  = prepared.transactionId
  lastPayloadDigest  = prepared.payloadDigest
  lastSequence       = prepared.journal.post.sequence
  // 因 prepared 不变量 journal.post.sequence = journal.pre.recordCount
  // 且 post.recordCount = pre.recordCount + 1，故成功后
  // lastSequence === idle.journal.recordCount - 1
```

### 4.4 Hash domain（冻结）

| 用途 | 输入 | 输出 |
| --- | --- | --- |
| raw file fingerprint | 文件原始字节（无 domain 前缀） | SHA-256 hex64 lowercase |
| event payloadDigest | 既有 journal domain：`linke.audit-integrity-journal.v1.event-payload\u0000` + canonicalEventUtf8 | 既有 SoT；**禁止** dual-write 复制公式 |
| event-link linkDigest | 既有 journal event-link domain + fields | 既有 SoT |
| empty events missing | `SHA256(empty buffer)` | 常量；present=false 时使用 |

**禁止**把 path、绝对路径、hostname、secret 混入 fingerprint domain。

### 4.5 大小 / 换行 / UTF-8 上限

```text
AUDIT_DUAL_WRITE_STATE_MAX_BYTES = 65536
  // state 为 single-slot；含最大 strict event（≤16050 line）+ fingerprints + 固定键
  // publish 前：UTF-8 byteLength 检查；>65536 → dual-write-state-invalid（绝不先写）
  // read oversize（磁盘超 maxBytes）→ dual-write-io-error
  // 不得 silent truncate

编码：UTF-8 only；文件必须以单行 JSON 可选 trailing '\n' 的规范形式存储。
冻结 publish 形式：canonical JSON object + 恰好一个 trailing '\n'（与 journal line 风格一致）。
parser：允许最终一个 '\n'；拒绝 leading BOM、interior 多 JSON、尾部垃圾。
```

**证明测试（强制）：**

1. 最坏 strict event（含 NUL 字段 canary + lone surrogate 独立 canary）序列化 prepared state ≤ 65536
2. 65537 synthetic fixture → 拒绝（publish 前 state-invalid；或 read 路径 io-error，按场景）
3. direct gate **不**解析 state schema；只需安全判断占用（ENOENT vs 存在/不可安全判定）

### 4.6 错误码（55 → 60，+5）

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID` | `audit-integrity-dual-write-state-invalid` | schema/key order/types/regex/hash 自洽失败；**publish 前**序列化超 65536 |
| `AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR` | `audit-integrity-dual-write-io-error` | state 或分类 I/O；**读** size overlimit；path-free |
| `AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT` | `audit-integrity-dual-write-recovery-conflict` | prepared 恢复时 store 为 **other** / 不可修复 partial / post-check 不符 |
| `AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH` | `audit-integrity-dual-write-cursor-mismatch` | **idle 已存在**但 stores ≠ cursor preimage（外部 mutation） |
| `AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED` | `audit-integrity-dual-write-direct-mutation-blocked` | state **占用**时 public journal-only init/append 被拒 |

```text
ERROR_CODES closed-set: 55 → 60  (+5)
```

**复用（不新增）的既有码：**

- journal：`not-initialized` / `already-initialized` / `io-error` / `bounds-exceeded` / `event-invalid` / `generation-id-invalid` / `audit-chain-broken`
- cross-store：broken / io / bounds / event-invalid（post 校验可调用 verifier）
- events sanitize 仍可抛既有 `Error`/`SafeDataFileError`（`appendAuditEvent` 现网合同）
- coordinator 内部 strict 失败（含 fatal UTF-8 decode 失败）→ **不得写 prepared**；映射既有 journal `event-invalid` 或 cross-store event-invalid（与 V1.36 层一致）；**不**静默降级

**Error class：** `AuditIntegrityDualWriteError` — `name` 固定；`message === code`；`code` 经 `assertRegisteredErrorCode`。

### 4.7 Public journal-only mutation gate（冻结；C1 无 / C2 起真实完整）

```text
C1:
  无 state module / 无 state file / 无 gate / 无 stub
  public journal = resolve → shared queue → unlocked plan/publish
  // public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
  // 不是 V1.35 safeAppend 半写模型

C2+ GATE (queue-internal): assertDualWriteStateAbsentUnlocked(resolvedRoot, lease)
  // 真实完整 state module（schema/parser/publisher/absent gate）的 path occupancy 检查
  // 禁止 always-allow / TODO / stub / skeleton / write-only
  // gate 仅 C2+；C1 无条件 gate 句作废

PUBLIC 调用顺序（C2+；P0；禁止 TOCTOU）:
  resolve root
  enqueue shared root queue
  inside callback, with active lease:
    assertDualWriteStateAbsentUnlocked(resolvedRoot, lease)
    journal unlocked plan/publish 或 init

判定（gate 内；检查 state **path** occupancy；不 parse schema 判占用）:
  - exact ENOENT → absent → 允许 public journal-only
      (post-C1 plan/publish SoT; no dual-write coordinator)
  - 任何存在形式（idle / prepared / invalid JSON / 空文件 / symlink / directory）
    或无法安全判定为 absent → occupied → 拒绝
  - state invalid / symlink / dir **仍 occupied**；拒绝时 journal / events / state bytes **不变**
  - **不**靠 queue lease「判 occupancy」；lease 只证明 gate 运行在临界区
  - C2 cold：production 仍 public journal-only (post-C1 plan/publish SoT;
      no dual-write coordinator) 且不 create state → state absent → public journal-only 允许
  - C2 测试：真实 state module 在 shared queue 内，用手工/测试 helper publish
      idle|prepared 占位，验证与 public journal-only init/append 的互斥；
      C3 才 bootstrap create idle

拒绝码:
  AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED
  path-free；message === code

副作用:
  - 拒绝时 journal / events / state bytes **不变**
  - **不**自动 recover
  - prepared 存在时 public journal-only init/append 也直接拒绝
  - 恢复只由 coordinator 路径（next append 的 fresh lease）或显式内部 recover 入口（自身 enqueue fresh lease）完成
  - 任何 state file 只会从 C2 测试 / 后续 C3+ 产生；C2 结束后 gate 真实
互斥（消除 absent→enqueue 窗口；C2+）:
  - coordinator 对同 root 建 state 与 public journal-only mutation 共享同一 queue
  - 因此不存在 “absent-check 后、enqueue 前 state 被创建再旁路” 的 TOCTOU
  - **C2 concurrent canary（仅 C2；无 bootstrap）：**
      真实 state module 在 shared queue 内，手工/测试 helper publish idle|prepared 占位
      ∥ public journal-only init/append；无论队列顺序：
      · 占位先 publish → public journal-only 拒绝 DIRECT_MUTATION_BLOCKED
      · public journal-only 先完成 → journal-only 写完后占位再 publish
      **绝不**出现 state 已占用后 journal-only 写（gate 已在 queue 内）
  - **真正 `direct append ∥ first coordinator bootstrap`：**
      迁到 **C3 行为测试**；**C6 hostile** 复锁（bootstrap 归 C3，不在 C2）

两阶段规则:
  1. state missing (ENOENT) + verified/partial stores → bootstrap 建立 idle
     （这是 bootstrap；**不是** idle cursor-mismatch；**C3+**）
  2. state idle 已存在 + stores 不符 → cursor-mismatch
     （idle mismatch 规则只适用于 state 已经存在）
```

**删除旧合同：** “direct append 先 recover 再允许”、“init 先 recover”、“**先 gate 再 enqueue**”、**C1 gate stub**、**无条件 public 必走 gate** — **全部作废**。C2 起 state 占用即拒绝；gate 在 queue 内执行；C1 无 gate。

---

## 5. 精确状态机与恢复真值表

### 5.1 每次 `appendAuditEvent` 顺序（冻结）

```text
S0  sanitizeAuditEvent(event) → sanitized
S1  projectStrict + stringifyStrict + payloadDigest（失败 → 抛；不入队副作用）
S2  assertSafeDataRoot(dataDir) → resolvedRoot
S3  enqueue shared queue(resolvedRoot, async (lease) => ...):
    S3a load state（lease-gated）
    S3b if prepared → recoverPrepared() until idle or throw
        （C3 边界：若 recovery 尚未暴露，prepared fixture 必须 fail-closed /
         recovery-not-yet-exposed；**禁止** no-op 当 idle；C4 替换该门）
    S3c if state missing → bootstrap() → idle
        （state missing + verified/partial = bootstrap，非 cursor-mismatch）
    S3d if idle → validateIdleCursorAgainstStores()  // mismatch → cursor-mismatch fail-closed
    S3e preflight bounds（§7 精确拆分；全部在 prepared 前）
        失败 → 抛；**不写 prepared**；stores 不变
    S3f build exact post fingerprints：
        - journal: **planAuditIntegrityEventLinkUnlocked**（只读；exact post 已知）
          prepared.journal.* 与 plan 逐字段相等；**不**存 raw
        - events:
            retention === null → pre bytes + eventLineUtf8（append post）
            retention.maxEvents ≥ 1 → 最终 retained suffix bytes（atomic final image）
        prepared.events.post = 最终可见 fingerprint；**禁止** intermediate
    S3g durable publish prepared WAL（publish 前 byteLength ≤ 65536）
        写后至少 read/parse exact expected status=prepared + transactionId 再碰 journal
    S3h journal post：`publishPlannedAuditIntegrityEventLinkAtomicUnlocked(plan)`
        （WeakMap rawPost；atomic write 返回后 **必须核** exact plan.post）
    S3i events post（互斥）：
        retention === null     → unlocked safeAppendText(exact line)
        retention.maxEvents≥1  → unlocked 一次 safeAtomicWriteText/Bytes(final retained bytes)
        // 不存在 “append 后再 compact” 第二步
    S3j primary commit check：两边 exact post fingerprints 匹配 prepared
        （状态机推进前 expected post fingerprint check；已有）
    S3k supplemental：verifyAuditIntegrityAgainstEventStore
        成功 post 仅 equal | events-suffix-of-journal | journal-suffix-of-events（§5.5）；
        empty / uncovered-events / throw / broken / 非预期 → recovery-conflict；
        **保留 prepared**；**不写 idle**
    S3l durable publish idle cursor：
        lastTransactionId = prepared.transactionId
        lastPayloadDigest = prepared.payloadDigest
        lastSequence      = prepared.journal.post.sequence
        写后至少 read/parse exact expected status=idle + last* / cursor 再返回 success
S4 return sanitized（与今日 public 合同一致）
// 若 S3 中途失败：prepared 保留 → task settle → old lease expire → 错误返回 caller
// 下一次 appendAuditEvent（或 explicit recover）以 **fresh lease** 在 S3b 恢复
// 禁止 queue catch re-grant / 复用 expired lease
```
### 5.2 崩溃点与恢复

| 崩溃点 | state | journal | events | retention 策略 | 恢复动作 |
| --- | --- | --- | --- | --- | --- |
| CP0 prepared 前 | idle 或 missing | pre | pre | 任一 | 无恢复；新事务从 S3 开始 |
| CP1 prepared 后、journal 前 | prepared | **exact pre** | **exact pre** | 任一 | 同一 `plan…` 从 prepared+current pre 重建并逐字段 assert → publishPlanned → events → idle |
| CP2 journal post 后、events 前 | prepared | **exact post** | **exact pre** | 任一 | 跳过 journal；做 S3i→…→S3l |
| CP3a events 写入中 | prepared | exact post | **byte partial / created-empty-partial** | **null only** | 一次 `safeAtomicWriteBytes(preBytes+eventLineBytes)` → idle |
| CP3b atomic rename 前 | prepared | exact post | **exact pre** | **enabled only** | 重做一次 atomic final publish |
| CP3c atomic rename 后 | prepared | exact post | **exact post** | **enabled only** | 只 S3l idle |
| CP4 events post 后、idle 前 | prepared | exact post | **exact post** | 任一 | 只 S3l idle |
| CP5 idle 后 | idle | post | post | 任一 | 完成；幂等 |
| CP-X prepared + **Jpre** + **Epost** | prepared | exact pre | exact post | 任一 | **recovery-conflict**；保留 prepared；**两 store 都不改**（单进程正常崩溃顺序不可达；表示外部 mutation/rollback） |

**分类矩阵：**

| 观察 | journal（atomic） | events（retention null / append） | events（retention enabled / atomic final） |
| --- | --- | --- | --- |
| exact pre | 允许 | 允许 | 允许 |
| exact post | 允许 | 允许 | 允许 |
| created-empty-partial / byte partial-prefix | **不应出现**；若出现 → other/conflict | 允许 → **一次 atomic byte image repair** | **不存在此分类**；若 size 介于中间 → **other/conflict** |
| other（含 Jpre+Epost） | recovery-conflict | recovery-conflict | recovery-conflict |

**幂等：** 对同一 prepared fixture，连续 recover N 次结果一致；不得重复 append/atomic 出第二 occurrence（post/post 只写 idle）。

**Retention atomic canary（强制两条）：**

1. rename 前 = pre；rename 后 = post（无 intermediate fingerprint）
2. 恢复幂等

### 5.3 重复 payload / 重复 id / 连续相同事件 canary

证明 **不**依赖：

- events 最后一行 id
- events 行数
- payloadDigest 是否已在 journal 出现
- cross-store suffix 猜测

而依赖：

- prepared.transactionId 唯一
- journal.pre.headDigest / sequence → journal.post.sequence = pre.headSequence+1
- rawByteLength/rawSha256 pre→post
- events byteLength/sha256 pre→post
- 重复三次相同 sanitized 内容 → journal sequence 递增 3；events 3 行（或 retention 后 retained 后缀内仍能区分 occurrence via journal）；idle.lastSequence 为最后一次

### 5.4 启动路径与 public gate

进程启动 **无** 独立 daemon。恢复发生在：

1. 下一次 `appendAuditEvent` 入队时（S3b）
2. 可选：显式 `@internal` `recoverAuditIntegrityDualWrite(root)` 供测试（**无** HTTP/CLI）

**public direct journal-only：**

```text
C1 initialize/append:
  1. resolve root
  2. enqueue shared root queue
  3. unlocked plan/publish 或 init
     // public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
     // 无 state module / 无 gate；不是 V1.35 safeAppend

C2+ initialize/append（gate 仅 C2+）:
  1. resolve root
  2. enqueue shared root queue
  3. inside callback, with active lease:
       assertDualWriteStateAbsentUnlocked(resolvedRoot, lease)  // 真实 gate
         - occupied → DIRECT_MUTATION_BLOCKED；bytes 不变；不 recover
         - absent → journal unlocked plan/publish 或 init
```

**禁止：** direct append/init 先 recover 再允许；prepared 存在时旁路 journal-only；**先 gate 再 enqueue**；C1 gate stub；无条件 public gate。

### 5.5 Post validation 与允许 relationship（冻结）

```text
PRIMARY commit condition = prepared exact fingerprints 匹配
SUPPLEMENTAL             = cross-store verifier post-check

成功 transaction post commit 仅允许:
  - equal
  - events-suffix-of-journal          // retention 后 journal 仍含更多 link
  - journal-suffix-of-events          // legacy 前缀后 journal 追上 events 后缀

journal-suffix-of-events 成功 post **确实可达**（写入 canary；非理论）:
  例：legacy baseline E=[legacy,a], J=[a]
      append x 后 E=[legacy,a,x], J=[a,x] → journal-suffix-of-events
  **仅**在 state bootstrap 保留 legacy uncovered 基线后可接受；
  idle 已有 **非 legacy** 基线时，不应凭空转为该关系。

成功 append 之后 journal 至少有一个 event-link，因此：
  - uncovered-events（J 空 / 无 event-link 覆盖、E 非空）**不可能** 是成功 post
  - empty（两边皆空）**不可能** 是成功 post

empty 与 uncovered-events:
  - **只允许** bootstrap receipt（§6.1 / §6.4）
  - **不允许** transaction post commit

若成功 append 的 post-check 返回 uncovered-events 或 empty:
  - 视为 unexpected
  - 保留 prepared
  - 不写 idle
  - typed recovery-conflict

任何 verifier throw / broken / 与预期模式不符:
  - 保留 prepared
  - 不写 idle
  - typed recovery-conflict
```

**不要**只允许 equal；也 **不要**把 bootstrap-only 关系（empty / uncovered-events）误当成成功 post。

---

## 6. Bootstrap / migration 矩阵

仅 **exact** `AUDIT_INTEGRITY_NOT_INITIALIZED` 可视为 journal missing。
仅 state 文件 **ENOENT** 可视为 state missing。
其它 typed/IO 错误 **不吞**。

记：

- `J∅` = journal missing (NOT_INITIALIZED)
- `Jopen` = journal only generation-open（eventCount=0）
- `Jevt` = journal 有 ≥1 event-link 且 verify ok
- `Jbad` = journal 存在但 verify 失败（chain/bounds/io…；含 init 崩溃留下的 zero/partial）
- `E∅` = events missing ENOENT
- `Eempty` = events 存在且 0 strict 行（空文件或仅无内容）
- `Elegacy` = events 有 ≥1 **strict-valid** 行
- `Ebad` = events 存在但非 strict 可解析（对 dual-write 基线而言 fail-closed）
- `S∅` / `Sidle` / `Sprep` = state missing / idle / prepared

### 6.1 state missing（`S∅`）— bootstrap 阶段

| journal | events | 动作 |
| --- | --- | --- |
| `J∅` | `E∅` 或 `Eempty` | 生成 `generationId`；`initializeUnlocked`；写 idle（recordCount=1, events present 按实）；**无**伪覆盖 |
| `J∅` | `Elegacy` | 同上 init journal；idle.events 记录 legacy fingerprint；**诚实**：首条 dual-write 后 cross-store 为 `partial/journal-suffix-of-events` 或 equal 仅当无额外 legacy——**保留** partial 语义；**禁止**宣称 legacy 已获链覆盖 |
| `J∅` | `Ebad` | **fail-closed**（io 或 state-invalid / 映射 cross-store-event-invalid）；不 init 掩盖 |
| `Jopen` / `Jevt` | 任意可解析 | 从 journal verify + events 实测建立 idle cursor；**不**改写 stores；若 J↔E 关系为 **verified 或 partial**（含 retention suffix / legacy uncovered）→ **允许**首次 bootstrap；若 **broken** → **fail-closed** 不写 idle |
| `Jbad` | * | 传播 journal typed 错误；**不** auto-repair/unlink/truncate |

**冻结（保留 V1.36 relationship 诚实）：** verified **与** partial 均可作为首次 bootstrap 基线（legacy/uncovered/retention suffix 是合法设计语义）。**不**采纳 “partial 一律失败”。

**Limitation（强制诚实，非 delivered protection）：** 无 external anchor / authenticity 时，攻击者删除 state 并把 journal/events 改为另一组自洽 verified/partial，可触发 **重新 bootstrap**。V1.37 **不能**证明 state continuity。此项 **不得**写成 delivered protection。

### 6.2 state idle 存在 — cursor 校验阶段

| 条件 | 动作 |
| --- | --- |
| stores 精确匹配 idle preimage | 继续新事务 |
| 任一 fingerprint 不符 | **`cursor-mismatch`**；**禁止**自动重基线 |
| journal generationId ≠ idle.generationId | cursor-mismatch |

**说明：** idle mismatch 规则 **只**适用于 state **已经存在**。`S∅` + verified/partial **不是** idle mismatch，而是 §6.1 bootstrap。

### 6.3 state prepared 存在

走 §5.2 recover；成功后变 idle 再继续；失败 **保留 prepared** + typed conflict。
public journal-only 见 §4.7：直接 **DIRECT_MUTATION_BLOCKED**，不 recover。

### 6.4 V1.36 cross-store 关系在 bootstrap 后

| 关系 | bootstrap 后是否允许 idle | 成功 transaction post 是否允许 |
| --- | --- | --- |
| empty | **允许** bootstrap idle | **否**（unexpected → recovery-conflict） |
| uncovered-events | **允许** bootstrap idle（partial 诚实） | **否**（成功 post 后 journal 必有 event-link） |
| equal / events-suffix-of-journal / journal-suffix-of-events | **允许** | **是**（成功 post 仅此三类） |
| broken | **不允许**静默 idle；fail-closed | **否**（recovery-conflict） |

---

## 7. Bounds / retention / journal 4096 天花板

### 7.1 冲突事实

| 子系统 | cap | 默认行为 |
| --- | --- | --- |
| audit-log retention | maxEvents optional | **disabled / unbounded** |
| cross-store events | 16MiB / 8192 / 16050 | 只读核验窗 |
| journal | 1.5MiB pre-read；existing 4096→4097；**生成 link record** 374 | **无 rotation** |

### 7.2 Bounds 精确拆分（冻结 — 禁止混用）

**全部 preflight 在 prepared 前执行；失败不改 state/stores。**

| 检查对象 | 条件 | typed code | 说明 |
| --- | --- | --- | --- |
| business canonical event line UTF-8 | `> 16050` | `AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED` | **不是** journal 374 |
| events strict record count **post** | `> 8192` | `AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED` | |
| events final / append-recovery window bytes | `> 16_777_216` | `AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR`（或既有 cross-store io；保持 V1.36 **size≠bounds**） | size 层，不新造 layering code |
| journal **生成的** link record byte length | `> 374` | `AUDIT_INTEGRITY_BOUNDS_EXCEEDED` | 与 event line 16050 **独立** |
| journal existing lines | `> 4096` 或 post total `> 4097` | `AUDIT_INTEGRITY_BOUNDS_EXCEEDED` | 无 rotation |
| journal current/post raw | `> 1_572_864` | `AUDIT_INTEGRITY_IO_ERROR` | size/maxBytes 仍是 io，不新造 layering code |

```text
FORBIDDEN 混用:
  - "event line > journal 374" 作为 business event 拒绝理由
  - 把 16050 业务行上限写成 journal bounds
  - 把 16MiB size 写成 bounds

ALLOWED canaries:
  - 合法 500-byte business event line 必须通过（远大于 374 但 ≤16050）
  - 16050 / 16051 边界
  - 独立 journal generated link record cap 374
```

### 7.3 V1.37 兼容策略（冻结）

1. **不**悄悄改变默认 retention 语义（仍 disabled/unbounded）。
2. **不**实现 journal rotation（列为后续 milestone）；raw size 超 1.5MiB 按既有 **IO** fail-closed。
3. retention 互斥发布见 §3.4；**不**改公开 retention 结果语义。
4. 失败不得破坏 prepared（若尚未写则无）与既有 stores。
5. 若未来必须改默认 retention：单列破坏性迁移（health/docs/tests）——**本版不做**。
6. **不**要求业务层因 journal size 做新 fail 通道；库级 IO fail-closed 即可。

### 7.4 后续 milestone（仅文档）

```text
V1.38+ candidates (NOT in V1.37):
  - journal rotation / next generation under trusted-recovery authorization
  - multi-process exclusive lock
  - caller delivery enforcement (server/agent no silent swallow) — product decision
  - external anchor / HMAC / signature / state continuity
  - monitor/alert on dual-write conflict
  - automatic repair tooling for cursor-mismatch（需授权模型）
```

---

## 8. Production wiring 与边界

### 8.1 唯一接线点

```text
appendAuditEvent  = 唯一 production dual-write 入口（C5 落地）
server/agent      = 仅 import appendAuditEvent；零 direct coordinator/journal/cross-store
capability sink   = 保持隔离
cross-store       = 保持 read-only；coordinator 可调用 verify 作 supplemental post-check
HTTP/CLI/Web      = 不新增 dual-write API
```

### 8.2 保持的 public 合同

- `appendAuditEvent` 返回 **sanitized event**（非 strict 投影对象的冻结 copy 亦可，但字段语义与今日一致）
- `normalizeAuditRetention` / `parseAuditRetentionMaxEvents` 行为保持
- `readAuditEvents`：limit 默认 50/max 100；坏行忽略；**不**因 dual-write 改为 fail-closed（避免破 API）

### 8.3 Scans 替换（禁止 fake green）

历史 **zero production wiring** 扫描必须 **有意替换** 为：

1. **exactly one controlled wiring：** `audit-log.js` 静态 import dual-write coordinator 且 `appendAuditEvent` 调用它
2. **server/agent zero direct wiring：** 不得出现 dual-write / journal / cross-store 模块 specifier 或 unlocked API
3. **journal 仍不得 import audit-log / coordinator**
4. **dual-write-state 不得 import journal / coordinator / audit-log**
5. **cross-store 仍 read-only**（无 append/write/queue）
6. **capability sink 零 dual-write/journal**
7. unlocked 原语 import allowlist + lease assert 存在性
8. 废除无 retention fast path / 独立 `auditFileQueues`：静态 scan + 首次 cold append 测试

**禁止**删除旧扫描却不设新扫描导致假绿。

### 8.4 Caller best-effort limitation（诚实）

```text
server.recordAudit: try appendAuditEvent catch console.error
agent.appendNasReplicationAudit: try appendAuditEvent catch {}

因此：
  - 库级 dual-write 失败可被吞
  - 不得宣称 end-to-end production audit delivery
  - 必须有正向诚实测试：mock/force coordinator throw → server/agent 路径不抛、不改 exit/HTTP 主语义
  - 本版 **不修改** 该 catch 策略（产品决策；属后续 milestone）
  - 不扩 scope 要求 HTTP 失败通道或新返回通道
```

### 8.5 Commit boundary 可运行性（禁止 stub 假绿）

**不拆 commit。** C1 / C2 边界裁定（冻结）：

```text
C1:
  - 尚无 state module、无 state file、无 production coordinator wiring
  - public journal wrapper = public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)：
      resolve → shared queue → unlocked plan/publish
  - **不是** V1.35 safeAppend 半写模型；**没有** gate stub / forward import / always-allow 占位
  - shared queue + lease settle finally + journal plan/publish 可独立测

C2:
  - 同一个 boundary 创建 **真实完整** dual-write-state module：
      schema / parser / publisher / absent gate
      （**不是** skeleton；**不是** write-only）
  - 修改 public wrappers 为 queue callback 内调用 **真实** absent gate（gate 仅 C2+）
  - Gate 明确检查 state **path**：
      exact ENOENT = absent allow；
      存在 / unsafe（symlink/dir/不可安全判定）= occupied block
  - Gate **不**靠 queue lease「判 occupancy」；lease 只证明在临界区
  - C2 production 仍 public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
    且 **不会** create state；cold state absent → public journal-only 允许
  - C2 测试 **手工/helper 发布** valid idle|prepared / invalid / unsafe state 占位验证阻断
  - C2 concurrent canary：**仅** 占位 publish ∥ public journal-only（**不**写 bootstrap）
  - C2 测试锁：无 stub / TODO / always-allow / skeleton / write-only 假绿
  - 任何 state file **只会** 从 C2 测试 / 后续 C3+ 产生
  - C2 结束后 gate 真实；**lastSequence 关系**（all-non-null ⇒ lastSequence === journal.recordCount-1）
    在 C2 state parser tests 明确锁死

C3:
  - **才**引入 bootstrap create idle
  - 行为测试锁 `direct append ∥ first coordinator bootstrap` 并发
  - prepared fixture fail-closed / recovery-not-yet-exposed
  - 禁止 no-op 当 idle
  - production appendAuditEvent 仍未接线（C5 前无 prepared WAL 由生产写入）

C4:
  - 实现 recovery；替换 C3 prepared 门；CP 真值表
  - partial repair = atomic byte image（无 truncate）

C5:
  - 接线 appendAuditEvent；废除 fast path / 分裂 queue

C6–C7:
  - scans / honesty / version
```

每个 boundary 的 production 路径必须 **真实 fail-closed 或真实功能**，不得 “崩溃恢复退化 silent”。

---

## 9. 安全 / scan 锁

1. import allowlist：queue / dual-write / dual-write-state / journal / audit-log / safe-data-files / schema / error-codes
2. exactly-one wiring + zero direct server/agent
3. 禁止完整 forbidden compound 字面量（runtime 拼接 needle）
4. honesty clause scan：`T6d.3 complete` / `M6d Exit` / `production-hardening ready` / `production integration` / `authenticity` / `state continuity` 等仅允许同 clause `not/未/不是/BLOCKED`
5. 错误 JSON/message 无绝对 path / event body
6. state parser 错序/extra key fail-closed
7. 测试只 `mkdtemp(join(tmpdir(), …))`
8. 永不 stage 未跟踪 `package-lock.json`
9. lease assert on unlocked mutators；nested enqueue（同 root 与 cross-root）禁止；ALS + active-set；lease settle 仅 queue `finally`
10. direct mutation gate 在 **queue 内** 执行（**C2 起**）；state 占用时拒绝；禁止先 gate 再 enqueue；C1 无 gate stub
11. journal plan/publish 唯一 SoT；禁止复制 digest/link 公式；禁止 `publish(rawPre,recordLine)`
12. partial recovery 禁止 truncate/ftruncate；仅 `safeReadBytes`（同 fd 二次 fstat）+ `safeAtomicWriteBytes`
13. journal plan raw 私有化（WeakMap）；publish post-write **必须核**；recovery 仅 fresh lease
14. C2 state 真实完整（非 skeleton/write-only）；created-empty-partial 为 events 分类、无 extra flag

---

## 10. Gold / temporal / version 边界

| Flag / 项 | V1.37 实现后值 |
| --- | --- |
| `LINKE_RELEASE_VERSION` | **`V1.37`**（仅 C1–C6 全绿后 C7 升级） |
| Gold overall | **blocked** |
| ready / partial / blocked / total | **4 / 4 / 1 / 9** |
| `production-hardening` | **partial**（**not** ready） |
| T6d.3 | **仍 partial** |
| M6d Exit | **否** |
| 签字上限 | `V1.37 journal-first crash-recoverable audit dual-write coordinator implementation` |
| M1 Exit audit markdown | **不改** |

README / Gold 若提本版，必须含：

- journal-first dual-write coordinator + single-slot WAL
- T6d.3 **partial** only
- not M6d Exit / not production-hardening ready / not Gold
- not multi-process lock / not rotation / not e2e caller delivery
- server/agent best-effort catch 诚实
- not state continuity under adversarial state deletion

---

## 11. 风险账本

| ID | 级 | 风险 | 缓解 |
| --- | --- | --- | --- |
| R01 | P0 | 外层 queue + public journal API 死锁 | ALS + nested enqueue 全拒（同/跨 root）+ unlocked 原语 + 测试 |
| R02 | P0 | 朴素双 append 无 WAL | 方案 B 冻结 |
| R03 | P0 | 用 last-id/count/suffix 猜 occurrence | canary + transition fingerprints |
| R04 | P0 | `safeReadText` replacement 误分类 partial | `safeReadBytes`；禁止 string 猜字节；partial 仅 retention null |
| R05 | P0 | 失败清掉 prepared | 规范禁止；测试 |
| R06 | P0 | idle 自动重基线掩盖 mutation | cursor-mismatch fail-closed；仅 state 已存在时适用 |
| R07 | P0 | 旧 zero-wiring scan 假绿 | 有意替换 exactly-one |
| R08 | P0 | 宣称 T6d.3 complete / M6d Exit / Gold ready | honesty scans + Gold 锁 4/4/1/9 |
| R09 | P0 | journal 仍 append partial | plan + atomic publishPlanned + 更新 source-contract |
| R10 | P0 | 4096 后仍写 prepared | preflight 先于 prepare（plan 内 bounds） |
| R11 | P0 | retention 两阶段 append+compact 残留 | 互斥策略；enabled 一次 atomic；无 intermediate |
| R12 | P0 | state 占用时 direct journal-only 旁路 / gate-enqueue TOCTOU | C2 queue 内真实 absent gate + DIRECT_MUTATION_BLOCKED；并发 canary |
| R13 | P0 | event line 与 journal 374 混用 | bounds 精确拆分表 + 500-byte / 16050 canary |
| R14 | P0 | C3 prepared stub 当 idle 假绿 | recovery-not-yet-exposed fail-closed |
| R15 | P0 | 成功 post 误允 empty/uncovered-events | post 仅 equal/suffix 两类 suffix；empty/uncovered 仅 bootstrap |
| R16 | P0 | prepared eventLineUtf8 与 STRICT_FIELD_ORDER 不一致 | id→createdAt→type；parser 关系不变量 |
| R17 | P0 | events 非法 UTF-8 被 replacement 修复 | fatal TextDecoder；invalid UTF-8 fail-closed canary |
| R27 | P0 | coordinator 复制 journal digest/link 公式 / 先写 journal | plan 唯一 SoT；prepared 前只读 plan；禁止 publish(rawPre,recordLine) |
| R28 | P0 | partial repair 用 truncate/ftruncate/reappend | 删除 truncate 合同；一次 safeAtomicWriteBytes(pre+line) |
| R29 | P0 | task 提前 settle lease / settle 责任不清 | 仅 queue `await task` 的 finally expire；task 无 settle API |
| R30 | P0 | C1 引入 gate stub / always-allow 假绿 | C1 无 state/gate；C2 才真实 gate；测试锁无 stub/TODO |
| R31 | P0 | prepared+Jpre+Epost 被当可修复 | 显式 recovery-conflict；两 store 不改 |
| R18 | P1 | audit-log queue key 非 resolved root | 统一 resolved root key + 废除 fast path |
| R19 | P1 | 错误码只加测试不改 registry | 55→60 全表 +5 |
| R20 | P1 | 无说明改默认 retention | 明确不改 |
| R21 | P1 | e2e delivery 假宣称 | caller catch 诚实测试；不改 catch |
| R22 | P1 | multi-process 被写成已支持 | limitation + scan |
| R23 | P1 | state deletion re-bootstrap 被写成 delivered | 强制 limitation 条款 |
| R24 | P1 | lease 被当安全沙箱 | 诚实：仅 accidental-bypass guard |
| R25 | P1 | publish 超 65536 先写后失败 | publish 前 byteLength 检查 → state-invalid |
| R26 | P1 | nested enqueue 仅文档禁止、运行时不可识别 | ALS + WeakSet/WeakMap；同/跨 root 全拒；不得建议换 root 绕过 |
| R32 | P1 | safeReadBytes size-race 漏检 same-inode grow/truncate | 同 fd 初次+二次 fstat：dev/ino/size/mode 必须相等且 regular；两次 fstat 间 append/grow/truncate 测试 |
| R33 | P1 | recovery 复用 expired lease / queue catch re-grant | 禁止；仅 next call / explicit recover 的 fresh lease；settle 后绝不可复用 |
| R34 | P1 | caller 可读写 plan.rawPost 或 forged plan 成功 publish | plan 仅 metadata；raw 在 module-private WeakMap；publish 只信 WeakMap + brand/lease |
| R35 | P1 | publish atomic write 返回即当成功、post-rename swap 假绿 | write 后 reopen nofollow+full verify **必须核** exact plan.post |
| R36 | P1 | created-empty 被当成 journal init / 需 extra flag | events 分类；prepared.pre.present=false+emptyDigest + current empty；无 flag |
| R37 | P1 | C2 state 被当成 skeleton/write-only / lease 判 occupancy | C2 真实完整 schema/parser/publisher/gate；path ENOENT vs occupied；lease 仅临界区 |
| R38 | P2 | nested meta-audit 在 active lease 内同/跨 root 尝试 | 一律拒绝；必须 defer 到 outer settle 后；不得换 root |

---

## 12. 明确不实现清单（V1.37）

1. multi-process exclusive lock
2. journal rotation / automatic next generation
3. external anchor / HMAC / signature / authenticity / state continuity
4. 修改 server/agent best-effort catch 为强制 delivery 或新 HTTP 失败通道
5. 新 HTTP/CLI/Web API
6. capability sink 合并
7. 默认 retention 行为变更
8. SQLite / 新 npm 依赖
9. T6d.3 complete / M6d Exit / production-hardening ready / Gold ready
10. 把 cross-store 改为可写
11. init 崩溃留下 Jbad 的 auto-repair/unlink/truncate
12. 对恶意同进程 import 的安全沙箱
13. safe truncate / ftruncate / truncate→rehash→append 合同
14. 复制 journal digest/link 公式或 `publish(rawPre,recordLine)` 含糊接口
15. task 侧 lease settle API / 提前失效 lease
16. C1 gate stub / always-allow / forward import
17. active lease 内 nested enqueue 的 “换 root” 绕过建议

---

## 13. 测试要求（设计层）

1. 仅 `mkdtemp(tmpdir())`
2. 同 root 50+ concurrent append → 两 store 顺序/digest 严格一致
3. 不同 root 无串行污染；失败 task 不 poison queue
4. lease：wrong-root / wrong-token / expired / missing / outside-context 全 fail-closed
5. nested enqueue：**same-root** 禁止；**cross-root** 禁止；detached continuation 携带过期 ALS store 拒绝；在另一 async context 复用 lease 拒绝；**不得**“换 root”绕过；outer task 不 poison；**nested meta-audit** active lease 内 same/cross root 均拒绝，必须 defer 到 outer settle 后
6. **lease settle：** 仅 queue infrastructure 在 `await task(lease)` 的 `finally` 中 expire；task 无 settle API；task settle 后 detached 必须 expired 拒绝
7. **recovery lease：** 禁止 queue catch re-grant / 复用 expired；old lease expired 后 next call fresh lease recovery 成功/冲突不是 lease 错误；explicit `recoverAuditIntegrityDualWrite` obtains fresh lease；process restart 同理
8. journal init / dual-write 共队列；无 deadlock；public wrappers 每次只 enqueue 一次
9. **journal plan SoT：** plan 无 writes / 幂等 / frozen；caller 仅见可序列化 pre/post metadata；raw 在 module-private WeakMap；direct append 与 dual/recovery 完全相同 line/hash；publish 拒 wrong root/lease/forged/expired plan/current-pre mismatch；尝试加/改 raw 无效；prepared 改一位 → recovery conflict 且不写
10. **publish post-write 必须核：** atomic write 返回后 reopen final nofollow+full verify/hash 必须 exact plan.post；post-rename swap injected → **不**报成功；return 后 race 属 multi-process limitation
11. **direct gate（C2 queue 内；真实完整 state module）：** state path exact ENOENT allow；idle/prepared/invalid/symlink/dir occupied 时 public journal-only init+append 全拒绝且 journal bytes 不变；state missing 时原 public APIs 仍工作；C1 无 gate stub；gate 不靠 lease 判 occupancy；C2 手工/helper publish idle|prepared/invalid/unsafe 阻断；C2 production 不 create state；C3 才 bootstrap idle
12. **gate TOCTOU canary 分层：**
    - **C2：** 真实 state module 在 shared queue 内，手工/测试 helper publish idle|prepared 占位 ∥ public journal-only init/append；占位先 → public 拒绝；public 先 → journal-only 完成后占位发布；**绝不** state 已占用后 journal-only 写（**不**写 bootstrap）
    - **C3 行为 + C6 hostile：** 真正 `direct append ∥ first coordinator bootstrap`；coordinator 先创 state → direct 拒绝；direct 先完成 → coordinator 合法 bootstrap；绝不 idle 创建后 journal-only 写
13. retention 0/disabled → append 策略 + partial 六态枚举 + atomic byte image repair；maxEvents≥1 → 一次 atomic final；无 intermediate fingerprint；**无 truncate**
14. retention atomic canary：rename 前 pre / rename 后 post；恢复幂等
15. 每个 crash point 的 prepared fixture 恢复；幂等；**prepared+Jpre+Epost → recovery-conflict，两 store 不改**
16. pre/pre、post/pre、post/post、created-empty-partial（events；prepared.pre.present=false+emptyDigest；无 extra flag）、byte partial（仅 null）、other/broken（enabled 无 partial）；无 prepared→bootstrap；pre.present=true empty→exact-pre
17. hostile bytes：symlink swap / size grow / short read / premature EOF / **两次 fstat 间 append|grow|truncate** / kill before|after rename；repair hash = prepared post18. state symlink/dir/oversize/invalid JSON/extra key/wrong order/wrong hash/count/path-free
19. prepared 关系不变量：eventLineUtf8===strict stringify+`\n`；payloadDigest；journal post recordCount/sequence/previous/link；events present/count；idle last* all-null 或 all-non-null；**last* all-non-null 时 lastSequence === journal.recordCount-1**（**C2 state parser tests 明确锁死**）；成功 idle last* 从 prepared 赋值
20. state parser **不**凭 pre hash 重算 full raw post；build/recovery 由 journal plan + current bytes 核验
21. publish 前 >65536 → state-invalid；read oversize → io-error；最坏 strict event prepared ≤65536
22. NUL / lone surrogate / emoji byte 边界；**invalid UTF-8 baseline fail-closed**（fatal TextDecoder；禁止 replacement）
23. 重复 payload/id/连续相同事件 occurrence canary
24. bounds：合法 500-byte event；16050/16051；journal link 374 独立；journal lines 4096；journal raw 1.5MiB → io；events 16MiB → cross-store io；preflight 失败不写 prepared
25. 成功 post-check **仅** equal / events-suffix / journal-suffix；**journal-suffix-of-events 可达 canary**（legacy baseline）；uncovered-events 与 empty **禁止**作成功 post；bootstrap 可允许 empty/uncovered
26. bootstrap：verified **与** partial 均可；broken 否；state missing ≠ idle mismatch
27. Jbad / partial init 残留 fail-closed，不 auto-repair
28. old zero-wiring → exactly-one 有意替换；fast path / auditFileQueues 废除 scan + cold append
29. server/agent best-effort 诚实测试（不改 catch；不要求 HTTP 失败通道）
30. error-codes **55→60**
31. C3 prepared fixture 不得 no-op 当 idle；C1 无 state gate stub；C2 无 stub/TODO/always-allow/**skeleton/write-only**；C2 真实完整 schema/parser/publisher/gate
32. full suite + 唯一既有 keychain skip 检查
33. state deletion re-bootstrap limitation 有正向诚实文档/注释（非 delivered claim）

---

## 14. 文档阶段约束

- **只允许新建/修订**本 design 与对应 plan
- **不**改源码/测试/README/version/Gold/`package-lock.json`/其它未跟踪文件
- 实现阶段：每个 boundary 测试/审查绿后，**PM 自动精确 stage/commit/push**（**无需再次确认**）；永不 stage 未跟踪 `package-lock.json`
- 版本仅在实现边界全绿后升级
- 设计阶段 `PROCEED` ≠ 实现完成；**禁止**把 C0 文档阶段写成 V1.37 实现完成
- **C0 review gate：** 第一/二次 GLM FAIL + **第三次 GLM PASS（无 P0）** + **fresh Grok PASS/PROCEED YES** 已记录；最终措辞修订关闭三条非阻断 finding；**PM 验收后 C0 可 commit 并开始 C1**

---

## 15. 设计验收清单

- [x] 三方案比较并选定 WAL journal-first
- [x] 共享队列 + lease capability（AsyncLocalStorage + WeakSet/WeakMap）+ non-reentrant unlocked 原语 + nested 同/跨 root 全禁
- [x] **lease settle 仅 queue `await task` 的 finally**；task 无 settle API；detached 过期拒绝
- [x] **recovery lease 来源：** 禁止 catch re-grant / 复用 expired；仅 next call / explicit recover 的 fresh lease
- [x] C1 错误合同冻结 path-free `SafeDataFileError`（无“实现选一”）
- [x] journal **plan + publishPlanned 唯一 SoT**；删除 `publish(rawPre,recordLine)`；禁止复制 digest/link 公式
- [x] plan caller 仅见可序列化 metadata；raw 在 journal module-private WeakMap；publish 只信 WeakMap rawPost
- [x] publish atomic write 返回后 **必须核** exact plan.post（非“可核”）；forged/raw 篡改/post-rename swap 不报成功
- [x] public direct append 复用同一 plan/publish；recovery 从 prepared+current pre 重建 plan 并逐字段 assert
- [x] events **两种互斥**发布策略（null append+byte partial atomic image repair / enabled 一次 atomic final）
- [x] **删除 truncate/ftruncate/reappend**；冻结 `safeReadBytes`（同 fd 二次 fstat size-race）+ `safeAtomicWriteBytes`
- [x] null partial 六态枚举（含 created-empty-partial：events 分类、无 extra flag、非 journal init）；prepared 不存 pre raw；current 前缀 hash 即 preBytes
- [x] events raw → fatal UTF-8 decode；partial 分类在 decode 前按 bytes；invalid UTF-8 fail-closed
- [x] 删除 append+compact 两阶段与 intermediate fingerprint
- [x] state 完整 JSON 形状 / key 序 / 类型 / hash domain / 关系不变量
- [x] prepared `eventLineUtf8` 与 STRICT_FIELD_ORDER（id→createdAt→type）一致
- [x] 成功 idle last* 从 prepared 赋值；all-non-null 时 lastSequence === journal.recordCount-1（C2 tests 明确）
- [x] state parser 不重算 full raw post hash；build/recovery 由 journal plan 核验
- [x] state publish 前 65536 检查 → state-invalid；read oversize → io；prepared/idle 写后至少 read/parse expected 再推进
- [x] 错误码 **+5（55→60）** 含 DIRECT_MUTATION_BLOCKED
- [x] public journal-only：C1 无 gate；C2 真实完整 schema/parser/publisher/absent gate（非 skeleton/write-only；path occupancy；lease 仅临界区）
- [x] C1/C2 边界裁定：不拆 commit；C1 无 state/gate；C2+ gate 真实；C2 production 仍 public journal-only (post-C1 plan/publish SoT; no dual-write coordinator) 且不 create state；C3 才 bootstrap idle
- [x] 模块 DAG：dual-write-state 独立；journal 不 import coordinator/audit-log
- [x] 状态机顺序 + 崩溃点真值表（含 Jpre+Epost conflict；atomic image repair；retention atomic canary）
- [x] bootstrap 矩阵：verified/partial 允许；broken 否；state continuity limitation
- [x] bounds 精确拆分（16050 / 374 / 8192 / 16MiB / 1.5MiB / 4096 不混用）
- [x] 成功 post 仅 equal / events-suffix / journal-suffix；journal-suffix 可达 canary；empty/uncovered 仅 bootstrap
- [x] nested enqueue limitation 明确（active lease 内 same/cross root 均拒绝；meta-audit 必须 defer outer settle；不得换 root 绕过）
- [x] C3/C4 无 stub 假绿；C1 无 gate stub；C2 无 skeleton/write-only
- [x] 唯一 wiring + scans 替换 + caller catch 诚实（不改 catch）
- [x] Gold 4/4/1/9 / T6d.3 partial / 非 M6d Exit / 非 production-hardening ready
- [x] 签字上限冻结
- [x] 零完整 forbidden compound 字面量
- [x] C0 review gate：第一/二次 GLM FAIL + **第三次 GLM PASS（无 P0）** + **fresh Grok PASS/PROCEED YES** 已记录；最终措辞修订关闭非阻断 finding；PM 验收后 C0 commit → 开始 C1（≠ V1.37 实现完成）
- [x] C2 concurrent canary = 占位 publish ∥ public journal-only；真正 bootstrap 并发迁 C3/C6
- [x] §3.2 public init/append gate 标 C2+；C1 仅 resolve→queue→plan/publish
- [x] 「V1.35 direct」→ public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)；非 safeAppend 半写

**本 design 本身不提升任何 runtime flag。当前事实仍为 V1.36。C0 ≠ V1.37 实现完成。**
