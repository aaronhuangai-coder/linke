# V1.35 Audit Integrity Journal Foundation Design

## 目标

V1.35 在 **V1.34 real audit capability sink（M6d-prep）** 基线之上，交付 **M6d T6d.3 的 partial foundation**：独立、可验证、fail-closed 的 **audit integrity journal**（**unkeyed hash-chain structural consistency foundation / 无密钥哈希链结构一致性基座**），为未来 production dual-write、external anchor、HMAC/signature、trusted recovery 与完整 T6d.3 提供 **可落地的链结构原语**。

> **本版交付：** `src/audit-integrity-journal.js` + 共享 `src/audit-event-schema.js` + `safeCreateExclusiveText`
> **路径：** `audit/integrity-journal.jsonl`
> **语义：** generation-open + event-link 的 **无密钥哈希链结构一致性**；模块/API 名可保留 `integrity`，但 **解释不是** authenticity / tamper-resistance / 防篡改能力
> **签字上限（唯一允许的完成宣称）：** `V1.35 unkeyed audit hash-chain structural consistency foundation implementation`
> **定位：** **T6d.3 partial foundation only** — **不是** T6d.3 complete / M6d Exit / production-hardening ready / production integration / Gold / GA / V2 / cross-LAN

本版建立：

1. **独立 journal 文件与模块**（严格隔离于 `audit/events.jsonl` 与 `audit/capability-proof-attempts.jsonl`）
2. **共享 audit event schema SoT**（sanitize 从 `audit-log.js` **byte-stable 提取**；journal 只 import shared，禁止 cycle）
3. **exclusive create 安全原语** `safeCreateExclusiveText`（**仅**防并发初始化竞态；**不**验证 generation 真实性）
4. **canonical unkeyed hash chain**（domain-separated preimage；固定 key order；verify fail-closed）
5. **typed path-free 错误 + fixed success receipts**（I/O vs chain-broken 二分 + 独立 bounds 码）
6. **DoS/validation 上界证明**（`safeReadText` maxBytes 1.5 MiB → size 超限 **io-error**；existing ≤4096 可 append 至 4097 / per-line UTF-8 上界 → **bounds-exceeded**）
7. **诚实 scope（必须）**：
   - **能检测：** 未重算 digest 的局部/意外损坏；中间删插/乱序导致的 seq/prev 断裂；坏尾/坏 JSON/错 schema/key/order/hash
   - **不能检测（honest limitation tests 必须 PASS = verify 返回 success）：** suffix rewrite；tail truncation；仅改 `events.jsonl`；以新 generationId 的 full-file replacement
8. **V1.x unkeyed structural-consistency foundation 诚实版本叙事**（实现+测试绿后可升 V1.35；Gold 仍 4/4/1/9 blocked）

### 关键边界（必须先读）

| 层级 | V1.35 是否完成 | 含义 |
| --- | --- | --- |
| **独立 integrity journal 模块 + 路径** | **是（本设计目标）** | init / append / verify 库级 API；`integrity` 名 ≠ authenticity |
| **共享 sanitize schema 提取** | **是** | `audit-event-schema.js`；`audit-log` re-export bit-identical |
| **safe exclusive create primitive** | **是** | `safeCreateExclusiveText`；仅并发 init 互斥 |
| **V1.34 capability real-audit sink** | **保持** | 不改 sink schema/路径；不 dual-write |
| **HTTP `events.jsonl` schema / retention** | **保持** | **禁止**改 schema；**禁止**把链字段塞进 events 行 |
| **T6d.3 audit-chain-integrity complete** | **否** | 仅 **partial foundation** |
| **M6d Exit / production-hardening ready** | **否** | scorecard `production-hardening` 仍 partial |
| **production dual-write / production integration** | **否** | 本版零 wiring；**无** events↔journal 绑定 |
| **server / agent / Web / HTTP / CLI 接入** | **否** | 无 public surface |
| **external trusted anchor / HMAC / signature** | **否** | 无密钥、无链外锚点 → **不得**称密码学防篡改或合规审计链完成 |
| **priorChainHeadDigest / 断链后 new generation / recovery** | **否** | **missing trusted-recovery authorization model**；**无** automatic next generation |
| **auto repair / truncate / retention / rotation / monitor** | **否** | 明确不实现 |
| **capability / approval 绑定** | **否** | 不接 RealAuditProof / attempt-audit |
| **`realAttemptAuditImplementationReady`** | **否** | **恒 false** |
| **global real / execute / wiring / eligible** | **否** | **全部保持 false** |
| **Gold / GA / V2.0 / cross-LAN** | **否** | Gold **blocked 4 ready / 4 partial / 1 blocked / total 9**；M1 route open；M2 denied |
| **新 npm dependency** | **否** | 仅 Node 内置 `crypto` / `fs` |

**严禁**把 journal verify 成功、`state:initialized` / `state:appended`、或版本升至 V1.35 冒充：

- T6d.3 complete / M6d Exit / production-hardening ready / **production integration**
- Gold ready / GA / V2.0 / cross-LAN complete
- `realAttemptAuditImplementationReady:true` / `executionEligible:true` / global real ready
- WORM / immutable / **tamper-proof** / **tamper-evident** / **防篡改能力** / **authenticity** / 密码学防篡改 / 合规审计链完成
- 可检测 suffix rewrite / tail truncation / events-only mutation / full-file replacement 成自洽链
- multi-process lock-free concurrent correctness
- O_EXCL/EEXIST **识别合法初始化** 或 **验证 generation 真实性**
- bounds 满界后 **自动 next generation**

**模块顶部 BLOCKED 列表（实现强制写入 `src/audit-integrity-journal.js` 文件头注释）：**

```text
BLOCKED (V1.35 — do not claim complete):
- T6d.3 complete / M6d Exit / production-hardening ready / production integration
- production dual-write (events.jsonl ↔ integrity-journal)
- public surface (server/agent/Web/HTTP/CLI)
- external trusted anchor / HMAC / signature / head file / priorChainHeadDigest
- new generation after chain-break / automatic next generation / recovery / auto-repair / truncate
- retention / rotation / monitor / alert
- capability / approval binding
- multi-process exclusive writer lock
- missing trusted-recovery authorization model
- authenticity / tamper-resistance / cryptographic anti-tamper / compliance audit-chain complete
- detection of: suffix rewrite | tail truncation | events-only mutation | full-file replacement
  (no external anchor; honest limitation tests must PASS with verify success)
```

**能力名冻结（禁止/允许）：**

```text
FORBIDDEN capability names/claims:
  - "tamper-evident" (qualified or unqualified)
  - "tamper-resistant" / "tamper-proof" as delivered capability
  - "防篡改能力" / "detects deletion" without scoped structural-break wording
  - "automatic next generation"

ALLOWED capability name (only):
  - unkeyed hash-chain structural consistency foundation
  - 无密钥哈希链结构一致性基座

ALLOWED implementation signature (only upper bound):
  - V1.35 unkeyed audit hash-chain structural consistency foundation implementation
```

**角色结论（文档阶段）：** 本任务 **仅 docs**；docs 经 fresh review/PM 后才进 TDD 代码。**`PROCEED` ≠ 实现完成。**

**恢复锚点（实现阶段）：** 实现前 clean tree HEAD（docs 合入后的 commit）。实现越界时回到该锚点干净状态再重做（**禁止**把 `git reset --hard` 写为常规步骤）。

---

## 0. 源码与文档事实基线（不得猜）

以下全部来自当前 worktree：`src/audit-log.js`、`src/safe-data-files.js`、`src/capability-audit-sink.js`、`src/error-codes.js`、`src/version.js`、`src/gold-readiness.js`、V1.34 design/plan、V2 cross-LAN design §6.11/§8.3、M6d plan。

### 0.1 V1.34 已完成与仍 blocked

| 项 | 当前事实 |
| --- | --- |
| 版本 | `LINKE_RELEASE_VERSION = 'V1.34'` |
| capability sink | `src/capability-audit-sink.js` → `audit/capability-proof-attempts.jsonl` |
| HTTP audit | `src/audit-log.js` → `audit/events.jsonl`；`sanitizeAuditEvent` 内联于 audit-log |
| Gold | **blocked**；**4 ready / 4 partial / 1 blocked / total 9**；**无** `cross-lan-connectivity` |
| production-hardening | **partial**（仅 hardening-status 面板级；§8.3 未满足 ready） |
| realAttemptAudit / global real / execute / wiring / eligible | **全部 false** |
| M1 | route open；Exit audit 历史 snapshot 仍记 V1.33 @ `47dcc2d` |
| M2 | denied |
| ERROR_CODES 与审计链 | **仅** `AUDIT_CHAIN_BROKEN: 'audit-chain-broken'`；**无** integrity-not-initialized / already-initialized / io-error / bounds-exceeded |

### 0.2 `audit-log.js` 真实行为（byte-stable 提取目标）

| 属性 | 事实 |
| --- | --- |
| 路径 | `AUDIT_RELATIVE_PATH = 'audit/events.jsonl'` |
| sanitize | `id`：`sanitizeString` 或 `randomUUID()`；`createdAt`：`toIsoString`；string allowlist 最长 **200**；`statusCode` 仅 `Number.isInteger`；非负整数字段；boolean 字段；**丢弃** allowlist 外字段 |
| append | `JSON.stringify(sanitized) + '\n'` + `safeAppendText`；可选 retention compact（`safeAtomicWriteText` 重写） |
| read | 解析失败行 **忽略**（不 fail-closed） |
| 队列 | 仅 retention 或已有 queue 时串行 |

**STRING_FIELDS 顺序（实现权威）：**
`id, createdAt, type, method, path, outcome, requestId, deviceId, snapshotId, operation, message, targetName, attemptId, errorCode`

**NON_NEGATIVE_INTEGER_FIELDS：** `fileCount, totalBytes, verifiedFileCount, retryCount`
**BOOLEAN_FIELDS：** `wouldWrite, executionRequired`

**强制：** 提取到 shared 后，现有 `sanitizeAuditEvent` 调用方与输出必须 **bit-identical**（含缺省 id/time 语义）。

### 0.3 `capability-audit-sink.js` 可借鉴模式（不得混淆路径）

| 模式 | sink 事实 | journal 采用 |
| --- | --- | --- |
| 独立相对路径 | `audit/capability-proof-attempts.jsonl` | **`audit/integrity-journal.jsonl`**（第三路径） |
| 固定 key order + re-stringify byte-equal | 7 keys | journal record **7 keys**（不同语义） |
| per-root queue | `capabilityAuditSinkQueues` | **独立** `auditIntegrityJournalQueues` |
| bounds / pre-read | 1.5 MiB pre-read；existing lines ≤4096 可再 append 1 行 | pre-read `maxBytes:1_572_864` 的 **size 超限**与其它 read/stat/permission 一样 → path-free `SafeDataFileError` → journal **`audit-integrity-io-error`**；**仅** existing lines>4096/4097 与 per-line UTF-8>374（JSON.parse 前）→ **`audit-integrity-bounds-exceeded`**（非 retention；**非** chain-broken） |
| path-free typed error | `CapabilityRealAuditSinkError` | `AuditIntegrityJournalError`（或等价） |
| 不 import audit-log | 是 | **是**（journal 只 import shared schema + safe-data-files） |

### 0.4 `safe-data-files.js` 真实保证与缺口

| API | 真实保证 | V1.35 |
| --- | --- | --- |
| `assertSafeDataRoot` | root 已存在；非 symlink 目录；返回 resolved root | 复用 |
| `safeReadText` | O_NOFOLLOW regular file；`size ≤ maxBytes`（超限 → path-free `SafeDataFileError`）；ENOENT 原样抛 | journal verify/append pre-read；journal 边界将 size/stat/permission 等 **统一**映射 `audit-integrity-io-error`（**不是** bounds-exceeded） |
| `safeAppendText` | parent ensure；`O_APPEND\|O_CREAT\|O_WRONLY\|O_NOFOLLOW`；0600；有 `sync` 则 await | **event-link append** |
| `safeAtomicWriteText` | temp `O_EXCL` + rename 覆盖 publish | **禁止**用于 journal 续写；**禁止** rename 覆盖 integrity-journal 既有文件 |
| **exclusive final create** | **不存在**面向 final path 的 `O_EXCL` create 原语（temp 有，final 无） | **新增** `safeCreateExclusiveText` |

### 0.5 cross-LAN design §6.11（审计链相关冻结）

来源：`docs/superpowers/specs/2026-07-16-linke-v2-gold-cross-lan-release-design.md` §6.11：

| 条款 | 冻结语义 | V1.35 覆盖 |
| --- | --- | --- |
| 审计链断裂 | 检测 hash 链缺口/校验失败 → 显式 `audit-chain-broken`；**禁止**静默续写同一链 | **本版实现** 结构断裂 detect + 拒续写（**非** authenticity） |
| 新链世代 | 必须开启 **新链世代**（记录 `priorChainHeadDigest` 若可知）并告警 | **本版不实现**；**不触发、不建议** automatic next generation；**无** recovery generation |
| 备份含链头锚定 | 权威状态含 **审计链头/锚定哈希** | **本版无 external anchor / HMAC / signature**；备份格式属未来 |
| 测试（M3/M6d） | 链破坏触发 `audit-chain-broken` 且不静默续写 | **本版库级测试覆盖**；非 M6d Exit |

### 0.6 §8.3 production-hardening 进入条件

| ready 条件 | V1.35 |
| --- | --- |
| 审计链、限流、restore root、Retention 真删、调度、监控在真实本机跑通 | **不满足**；仅 journal foundation |
| 仍 blocked 若仅 hardening-status 布尔面板 | 本版 **不得** 把 scorecard 标 ready |

### 0.7 M6d / T6d.3 plan 事实

来源：`docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md` M6d：

| 项 | 事实 |
| --- | --- |
| T6d.3 | 审计链完整性与敏感字段扫描 |
| Exit | 达 §8.3 production-hardening ready |
| V1.35 | **T6d.3 partial foundation only**；**不**勾选 T6d.3 complete；**不** M6d Exit |

### 0.8 三路径隔离合同（永久）

```text
audit/events.jsonl                      ← HTTP/API sanitize 审计（可 retention compact）
audit/capability-proof-attempts.jsonl   ← V1.34 capability real-proof sink（固定 7 keys）
audit/integrity-journal.jsonl           ← V1.35 integrity chain（generation-open|event-link）
```

**禁止：** 共享 schema、共享 queue Map key、互相 import 形成 cycle、把链字段写入 events 行、把 capability sink 行当 journal record。

---

## 1. 候选评估与选定

### 1.1 方案矩阵

| 准则 | **A：events 行内 hash 链** | **B：独立 integrity journal（选定）** | **C：纯 validator（无落盘）** |
| --- | --- | --- | --- |
| 与 retention compact | **冲突**：`compactAuditFile` atomic rewrite 会破坏/重写链上下文；行内链与 truncate 语义纠缠 | **隔离**：journal 无 retention；events 可继续 compact | 无状态；无法证明落盘链 |
| schema 稳定性 | **高风险**：events 动态字段 + UUID/time；读侧忽略 corrupt 行 | **高**：journal 固定 7 keys；fail-closed | N/A |
| T6d.3 预备价值 | 中：污染 HTTP 审计产品语义 | **高**：真实落盘 + 结构一致性 verify + 拒续写 | 低：无 durable evidence |
| blast radius | **高**：改 events schema/读写语义 | **中**：新文件；零 production wiring | 低但无产品价值 |
| 自洽重写/截断检测 | 仍需 external anchor/HMAC/signature | **同样不可检测**（诚实 limitation；见 §2.4） | 无 |
| 与 §6.11 | 难对齐“禁止静默续写同一链”且不碰 retention | **对齐结构断裂 detect + 拒续写**；recovery / next generation 明确 BLOCKED | 无法演练落盘断裂 |
| 实现复杂度 | 高（双写语义、compact 交互） | **中**（独立模块） | 低 |
| 能力宣称边界 | 易与 “events 审计真实性” 混淆 | **清晰**：仅 journal 内部 unkeyed 结构一致性 | 无 durable 边界 |

### 1.2 选定与拒绝

```text
V1.35 SELECTED                    = B 独立 integrity journal foundation
RELATIVE_PATH                     = audit/integrity-journal.jsonl
MODULE                            = src/audit-integrity-journal.js
SHARED_SCHEMA                     = src/audit-event-schema.js
EXCLUSIVE_PRIMITIVE               = safeCreateExclusiveText (src/safe-data-files.js)
REJECTED_A                        = events 行内链（retention/compact 冲突 + schema 污染）
REJECTED_C                        = 纯 validator（无真实落盘，不构成 foundation）
```

**拒 A 精确理由：**
`appendAuditEvent` 在 `maxEvents` 时调用 `compactAuditFile` → `safeAtomicWriteText` **整文件重写**。行内 previous-digest 链一旦与 retention 共存，必须定义“compact 后如何重算/丢弃历史链”——这正是 T6d.3 complete / DR 范围，**不是** foundation 首步。把链塞进 events 还会迫使所有 HTTP audit 读者理解链字段，并与“忽略 corrupt 行”的宽松读语义冲突。

**拒 C 精确理由：**
无落盘则无法证明 exclusive init、crash partial tail、symlink leaf、EEXIST 竞态、断链后文件字节不变等 **M6d 演练所需的真实边界**。validator-only 可作为单元辅助，**不能**替代 journal foundation。

**选 B 精确理由：**
独立路径 + 独立 schema + 独立 queue，复用 safe-data-files 安全模型；不改 events/capability sink 既有合同；可先交付 **unkeyed structural-consistency** detect/fail-closed 原语，再在后续里程碑接 dual-write / external anchor / HMAC / signature / recovery。**不**因选 B 而获得 authenticity 或 防篡改能力。

---

## 2. 威胁模型与能力边界

### 2.1 资产（结构一致性视角）

| 资产 | 说明 | 本版保证边界 |
| --- | --- | --- |
| A1 journal 内部结构自洽 | `audit/integrity-journal.jsonl` 行间 seq/prev/linkDigest 自洽 | **仅** journal 文件自身；**不**绑定 external history |
| A2 generation 标签 | `generationId`（32 lowercase hex）标识**本地**链世代标签 | **不是**经认证的 generation 真实性 |
| A3 head digest | 最新 `linkDigest`；未来 anchor/HMAC 的**候选输入** | 无 external anchor 时 **不能**防自洽替换 |
| A4 写入时 payload 摘要 | `payloadDigest` = 写入时对 **post-sanitize projection** 的摘要 | **仅**证明 append 时刻投影一致性；**不**为外部 `events.jsonl` 历史提供可信溯源/真实性 |
| A5 path-free 错误面 | 错误不得泄漏 path / leaf type / underlying message / stack | 统一 fail-closed codes |

### 2.2 攻击者与能力

| 攻击者 | 能力假设 | 本版对策 / 诚实结果 |
| --- | --- | --- |
| T1 进程内误用 API | 传 hostile object / 指定 sequence / 未 init append | strict projection；调用方不可指定 seq/prev；typed fail |
| T2 局部/意外损坏（未重算 digest） | 改 journal 字节且**未**重算该点至结尾 digest；中间删插/乱序；坏尾/坏 JSON/错 schema/key/order/hash | verify fail-closed `audit-chain-broken`；断链后拒续写 |
| T3 **suffix rewrite** | 改中间 event-link 的 **`payloadDigest`**（保持 7-key order/sequence）；从该 index 重算 `linkDigest`，并对后续每条同步 `previousLinkDigest` 并重算 `linkDigest` 至 EOF | **不可检测**；verify **success**（honest limitation） |
| T4 **tail truncation** | 删除尾部 N 条得到合法前缀 | **不可检测**；verify **success**（合法前缀仍自洽） |
| T5 **events-only mutation** | 修改/删除 `audit/events.jsonl` 而 journal 不变 | **不可检测**；journal verify **不知情**（无 production dual-write/绑定） |
| T6 **full-file replacement** | 以新 generationId 构造全新自洽文件替换 | **不可检测**；verify **success** |
| T7 symlink / TOCTOU | 指向 journal 路径的 symlink leaf/parent | safe root/parent + `O_NOFOLLOW`；root/parent 故障 → io-error；**leaf symlink/恶意 leaf 的 init** 因 `O_EXCL` **EEXIST** → `{created:false}` → **`already-initialized`（统一；不得写成 io-error）**；**不写/不读**外部 target |
| T8 并发 init | 两调用同时 exclusive create | `O_EXCL`：一成功；其余 EEXIST → `{created:false}` → already-initialized |
| T9 init 路径占位 DoS | 预置 file/dir/symlink/恶意 leaf 使 EEXIST | 统一 `already-initialized` fail-closed；**不区分** leaf 类型；**可能是 DoS**；**不得**称“识别合法初始化”；**不得**映射 io-error |
| T10 多进程并发 append | 无跨进程锁 | **single-writer assumed**；争用最终 chain-broken fail-closed；**不宣称** multi-process correct |
| T11 DoS / 上界 | 超大文件 / 超长行 / 海量行 | **size > maxBytes（1.5 MiB）** 在 `safeReadText` → path-free `SafeDataFileError` → **`audit-integrity-io-error`**（与其它 read/stat/permission 同）；**仅** existing lines>4096（append）/ lines>4097（verify）与 per-line UTF-8>374（JSON.parse 前）→ **`audit-integrity-bounds-exceeded`**（**不是** chain-broken） |
| T12 敏感泄漏 | 错误带 path；receipt 带 raw event | path-free errors；receipt 仅固定 allowlist |

### 2.3 明确 **不** 防 / **不** 宣称的威胁

1. **suffix rewrite**（改记录 + 重算后缀 digest 至结尾）
2. **tail truncation**（删尾部 N 条得合法前缀）
3. **仅改 `events.jsonl` / capability sink**（journal 不读不写、无 dual-write 绑定）
4. **以新 generationId 的 full-file self-consistent replacement**
5. **无 external trusted anchor / HMAC / signature 时的密码学防篡改、authenticity、合规审计链完成**
6. **可信恢复授权缺失下的 automatic next generation**（§6.11 恢复策略 **本版不实现**；bounds 满界也 **不** 触发 next generation）
7. **多进程无锁正确性**
8. **O_EXCL/EEXIST 区分合法 init vs 恶意占位** 或 **验证 generation 真实性**

### 2.4 能力名与检测范围（强制；禁止 `tamper-evident`）

**禁止**在模块注释、README、Gold `nextStep` / evidence、测试名、commit message、API 文档中使用 **`tamper-evident`**（无论是否加限定语）。统一能力名：

> **unkeyed hash-chain structural consistency foundation**
> **无密钥哈希链结构一致性基座**

**能检测（verify / append-preflight → `audit-chain-broken` 或结构失败）：**

1. **未重算 digest** 的局部/意外字节损坏（in-place mutation without suffix recompute）
2. **中间**删除 / 插入 / 乱序导致的 **seq / previousLinkDigest 断裂**
3. **坏尾**（缺 `\n` / 半行）、坏 JSON、错 schema、错 key set/order、错 hex/hash、generation-open 约束失败

**不能检测（honest limitation tests 必须 PASS，即 verify 返回 `state:'verified'` / success；不是期望 chain-broken）：**

| 场景 | 期望 | 测试意图 |
| --- | --- | --- |
| **suffix rewrite** | verify **success** | 改 event-link.`payloadDigest` + 精确重算该点至 EOF 的 link 链后仍自洽；证明系统 **不**虚假检测 |
| **tail truncation**（删尾部 N 条，N≥1，剩合法前缀） | verify **success** | 合法前缀仍结构自洽 |
| **events-only mutation**（改/删 `events.jsonl`，journal 不变） | journal verify **success** | 无 dual-write/绑定 → journal 不知情 |
| **full-file replacement**（新 generationId 的全新自洽文件） | verify **success** | 无 external anchor |

**解释合同（强制）：**

- journal **只**验证自身内部结构自洽
- `payloadDigest` **仅**证明写入时对 post-sanitize projection 的摘要一致性
- `payloadDigest` **不**为外部 `events.jsonl` 历史提供可信溯源 / 真实性
- **无** external anchor / HMAC / signature 时，**不得**称密码学防篡改、合规审计链完成、authenticity、防篡改能力
- 签字上限：**`V1.35 unkeyed audit hash-chain structural consistency foundation implementation`**

---

## 3. 状态机

### 3.1 文件状态

```text
                  initialize (O_EXCL success only; not authenticity)
   ABSENT ──────────────────────────────────► OPEN (structurally valid chain, head = generation-open)
     ▲                                            │
     │                                            │ append event-link (structure verify OK
     │                                            │   && existing lines ≤ 4096)
     │                                            ▼
     │                                       OPEN (recordCount ≥ 2; max legal via API = 4097)
     │                                            │
     │            structure verify fail            │
     │                                            ▼
     │                                       BROKEN (chain structure invalid)
     │                                            │
     │                                            │ further append
     │                                            ▼
     │                                       REJECT chain-broken (file bytes unchanged)
     │
     │            append preflight existing > 4096 │
     │                                            ▼
     │                                       REJECT bounds-exceeded (file bytes unchanged;
     │                                        NOT chain-broken; NO auto next generation)
     │
     └── 本版无 delete/reset API；人工删除文件后可重新 initialize（新 generationId）
         这不是 trusted recovery，也不记录 priorChainHeadDigest；
         也不是 automatic next generation
```

**说明：** `OPEN` 仅表示 **journal 内部 unkeyed 结构自洽**，**不是** authenticity / 防篡改成功。

### 3.2 API × 状态转移

| 当前状态 | API | 成功结果 | 失败码 | 文件字节 |
| --- | --- | --- | --- | --- |
| ABSENT | `initializeAuditIntegrityJournal` | OPEN；receipt `state:initialized` | io-error / invalid input | 新建 1 行 generation-open（**第 1 条**） |
| 路径已存在（file/dir/symlink/任意 leaf；含并发 loser） | `initialize...` | — | `audit-integrity-already-initialized`（**统一**；**不区分** leaf 类型） | **不变**；**不写** symlink 外部目标 |
| ABSENT | `appendAuditIntegrityEvent` | — | `audit-integrity-not-initialized` | 不变 |
| OPEN，existing lines ≤ 4096 | `append...` | OPEN；`state:appended` | event-invalid / io / chain-broken | 成功则 +1 行（恰 4096 时可写出第 **4097** 条） |
| OPEN，existing lines = 4097（或 >4096） | `append...` | — | **`audit-integrity-bounds-exceeded`** | **不变**；**不**开 next generation |
| BROKEN | `append...` | — | `audit-chain-broken` | **不变** |
| ABSENT | `verifyAuditIntegrityJournalFile` | — | `audit-integrity-not-initialized` | 不变 |
| OPEN（含合法 4097 行） | `verify...` | receipt `state:verified`（见 §8） | — | 不变 |
| BROKEN | `verify...` | — | `audit-chain-broken` | 不变 |
| lines.length > 4097（verify）或 append existing lines > 4096；或 per-line UTF-8 > 374（JSON.parse 前） | `verify...` / append preflight | — | **`audit-integrity-bounds-exceeded`** | 不变 |
| 读/权限/磁盘失败；**含** `safeReadText(...,{maxBytes:1_572_864})` 的 **size 超限**与其它 SafeDataFileError | 任一 | — | `audit-integrity-io-error` | 不变（写失败不半提交由 exclusive/append+fsync 约束） |
| **注意** | size 超限 **不是** bounds-exceeded；bounds 仅 lines 与 per-line UTF-8 | — | — | — |

### 3.3 断链后永不静默续写（§6.11 对齐子集）

一旦 `verify` 或 append 前 full-verify 判定 **结构** chain-broken：

1. 抛 `audit-chain-broken`（path-free）
2. **不** append
3. **不** truncate / repair / **automatic next generation** / recovery generation
4. 文件字节 **保持不变**
5. 后续同文件所有 append **永远** 再验再拒

**bounds 满界**（existing > 4096）走 **`audit-integrity-bounds-exceeded`**，**不是** chain corruption，也 **不** 触发 next generation。

---

## 4. 记录格式与 canonical preimage

### 4.1 相对路径与常量

```text
AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH = 'audit/integrity-journal.jsonl'
AUDIT_INTEGRITY_JOURNAL_SCHEMA_VERSION = 1
AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES = 1_572_864   // 1.5 MiB
AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES = 4096
  // validation only; not retention; not chain-broken
  // generation-open 计第 1 条；preflight 允许 existing <= 4096，故恰 4096 可 append 出第 4097 条
  // existing == 4097 时下一次 preflight → audit-integrity-bounds-exceeded；文件不变；无 auto next generation
AUDIT_INTEGRITY_JOURNAL_MAX_LINES_AFTER_APPEND = 4097
  // API 可达的最大合法行数（= MAX_EXISTING_LINES + 1）
```

### 4.2 Record exact key order（强制）

每一行 JSON 对象 **own enumerable string keys** 必须 **恰好** 下列顺序（byte-stable `JSON.stringify` 固定字面量构造）：

```text
schemaVersion, recordKind, generationId, sequence, previousLinkDigest, payloadDigest, linkDigest
```

| 字段 | 类型约束 |
| --- | --- |
| `schemaVersion` | 数字 `1` |
| `recordKind` | 字符串 `generation-open` **或** `event-link` |
| `generationId` | **32** 字符 lowercase hex `[0-9a-f]{32}` |
| `sequence` | safe integer（`Number.isSafeInteger`）；generation-open **必须** `0`；event-link **≥ 1** |
| `previousLinkDigest` | generation-open：**`null`**；event-link：**64** lowercase hex |
| `payloadDigest` | generation-open：**`null`**；event-link：**64** lowercase hex |
| `linkDigest` | **64** lowercase hex（两种 record 均非 null） |

**禁止：** extra keys、symbol keys、accessor、custom prototype、Proxy、数组、非 plain object、key 顺序错误、uppercase hex、省略 null（必须显式 `null`）。

### 4.3 Domain separation 常量（精确）

使用 UTF-8 字节串（含尾部分隔），**禁止**与其它 Linke hash domain 复用：

```text
DOMAIN_GENERATION_OPEN =
  "linke.audit-integrity-journal.v1.generation-open\u0000"

DOMAIN_EVENT_PAYLOAD =
  "linke.audit-integrity-journal.v1.event-payload\u0000"

DOMAIN_EVENT_LINK =
  "linke.audit-integrity-journal.v1.event-link\u0000"
```

摘要算法：**SHA-256**（**unkeyed**；无 HMAC）；输出 **64 lowercase hex**（`digest('hex')`）。
**不得**因使用 SHA-256 而宣称密码学防篡改 / authenticity；无 external anchor / HMAC / signature 时仅为结构一致性输入。

### 4.4 generation-open preimage

输入：`generationId`（已校验 32 lowercase hex）。

```text
linkDigest = SHA256(
  DOMAIN_GENERATION_OPEN
  + generationId
  + "\u0000"
  + "0"                  // sequence 十进制 ASCII
  + "\u0000"
  + "null"               // previousLinkDigest 字面
  + "\u0000"
  + "null"               // payloadDigest 字面
).hex
```

落盘 record：

```json
{"schemaVersion":1,"recordKind":"generation-open","generationId":"<32hex>","sequence":0,"previousLinkDigest":null,"payloadDigest":null,"linkDigest":"<64hex>"}
```

**证明上界：** 该行 UTF-8 长度恒为 **240** 字节（见 §9.2 实测公式）；加尾 `\n` → **241**。

### 4.5 event-link preimage

输入：

- `generationId`（与 head 相同）
- `sequence = head.sequence + 1`（**调用方不可指定**）
- `previousLinkDigest = head.linkDigest`（**调用方不可指定**）
- `event` = **strict canonical sanitized projection**（§5）

```text
canonicalEventUtf8 = stringifyStrictCanonicalSanitizedEvent(event)   // fixed key order UTF-8

payloadDigest = SHA256(
  DOMAIN_EVENT_PAYLOAD + canonicalEventUtf8
).hex

linkDigest = SHA256(
  DOMAIN_EVENT_LINK
  + generationId
  + "\u0000"
  + decimalAscii(sequence)     // 无符号十进制，无前导零（0 除外；event-link ≥1）
  + "\u0000"
  + previousLinkDigest         // 64 hex
  + "\u0000"
  + payloadDigest              // 64 hex
).hex
```

落盘 record：

```json
{"schemaVersion":1,"recordKind":"event-link","generationId":"<32hex>","sequence":<n>,"previousLinkDigest":"<64hex>","payloadDigest":"<64hex>","linkDigest":"<64hex>"}
```

**证明上界：** `sequence = Number.MAX_SAFE_INTEGER`（16 位）时该行 UTF-8 长度 **374** 字节；加 `\n` → **375**（§9.2）。

### 4.6 与 UUID 的关系

**禁止**从 digest / sequence 派生 UUID。
`sanitizeAuditEvent` 仍可对缺省 `id` 使用 `randomUUID()`；journal **只**哈希 **post-sanitize canonical event**，不生成事件 id。

---

## 5. 共享 schema：`src/audit-event-schema.js`

### 5.1 职责拆分

| 导出 | 用途 | 消费者 |
| --- | --- | --- |
| `sanitizeAuditEvent(event, now?)` | **byte-stable** 提取自当前 `audit-log.js` 行为 | `audit-log.js` re-export；既有调用方不变 |
| `projectStrictCanonicalSanitizedEvent(event)` | 严格投影：固定字段顺序；拒 hostile | **仅 journal**（及本模块测试） |
| `stringifyStrictCanonicalSanitizedEvent(event)` | 对 strict projection 固定顺序 `JSON.stringify` | journal payloadDigest |
| allowlist 常量（可选 export） | STRING/INT/BOOL 字段表 | 测试/文档对齐 |

### 5.2 cycle 禁止

```text
audit-log.js          → import sanitize from audit-event-schema.js；re-export sanitizeAuditEvent
audit-integrity-journal.js → import strict projection/stringify from audit-event-schema.js
audit-event-schema.js → 不得 import audit-log / journal / server / agent
journal               → 不得 import audit-log
未来 audit-log        → 不得 import journal
```

### 5.3 `sanitizeAuditEvent` byte-stable 合同

实现必须保持与提取前 **bit-identical** 行为，包括：

1. `sanitizeString`：非 string → `''`；trim；空 → `''`；`slice(0, 200)`
2. `id`：sanitize 后空则 `randomUUID()`
3. `createdAt`：`toIsoString(event.createdAt || fallbackDate, fallbackDate)`；非法时间回落 fallback
4. 其它 STRING_FIELDS：仅非空才写入
5. `statusCode`：仅 `Number.isInteger`（含负数）
6. 非负整数 / boolean 规则不变
7. 返回 **普通对象**；字段插入顺序与当前实现一致（id/createdAt 先，再 string 循环，再 statusCode，再 ints，再 bools）

**回归：** 既有 `test/audit-log.test.js` + 新增 byte-stable 向量（固定 `id`/`createdAt`/`now`）必须绿。

### 5.4 strict canonical sanitized projection

`projectStrictCanonicalSanitizedEvent(input)`：

1. 拒绝：`null` / 非 object / Array / function / Proxy（`utilTypes.isProxy`）/ 非 `Object.prototype` 且非 `null` prototype
2. 拒绝：任何 symbol own key；任何 accessor（get/set）；任何 non-enumerable 依赖；任何 function 值
3. 拒绝：allowlist **之外** 的 own enumerable string key
4. 要求 **至少** 存在数据字段 `id`、`createdAt`（string，且通过与 sanitize 相同的可见约束：非空、id 可用，createdAt 为合法 ISO 产出形态）
5. 对允许字段按 **固定顺序** 重建 plain object：

```text
id, createdAt, type, method, path, outcome, requestId, deviceId, snapshotId,
operation, message, targetName, attemptId, errorCode,
statusCode,
fileCount, totalBytes, verifiedFileCount, retryCount,
wouldWrite, executionRequired
```

6. 缺省可选字段 **不出现**（与 sanitize “仅有值才写”一致）；类型不符 → 拒绝（strict **不**静默改写；与 sanitize 宽松不同）
7. **不**调用 `randomUUID` / **不**补时间；调用方必须提供已 sanitize 的稳定事件

**journal append 入口合同：**

```text
caller 必须传入 strict projection 可接受的 event
（推荐：先 sanitizeAuditEvent(..., fixedNow) 再 projectStrict...；
 或测试直接构造 fixed id/createdAt 的 strict 对象）
```

### 5.5 随机 id/time 与 digest 语义（强制文档化）

| 事实 | 说明 |
| --- | --- |
| digest 输入 | **仅** post-sanitize **canonical** event UTF-8 |
| 同一 raw event 多次 `sanitizeAuditEvent` | 若缺 `id`/`createdAt`，可能得到 **不同** id/time → **不同** payloadDigest |
| 测试 | **必须**固定 `id` 与 `createdAt`（及 `now` 若需要）以保证向量可复现 |
| 禁止 | 从 digest/seq 派生 UUID；在 journal record 内嵌 raw event |
| payloadDigest **是** | 写入时对 post-sanitize projection 的摘要一致性承诺 |
| payloadDigest **不是** | 外部 `events.jsonl` 历史的可信溯源 / authenticity / 防篡改证明 |

---

## 6. `safeCreateExclusiveText`

### 6.1 签名

```js
/**
 * @param {string} root
 * @param {string} relativePath
 * @param {string} text
 * @param {{ mode?: number, deps?: SafeDataFileDeps }} [options]
 * @returns {Promise<{ created: true } | { created: false }>}
 */
export async function safeCreateExclusiveText(root, relativePath, text, options = {})
```

### 6.2 行为

1. `typeof text === 'string'` 否则 `SafeDataFileError`
2. 安全 `ensureParentForRelativeFile`（与 append/atomic 相同 parent 规则）
3. **禁止**复用会吞掉 `EEXIST` 的 `openRegularNoFollow`（其 catch 把非 ENOENT open 故障统一 `fail()` → 会丢失 exclusive create 语义）
4. **直接** `deps.open(finalAbsolutePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode)`，mode 默认 `0o600`
5. **`EEXIST`** → 立即返回 `{ created: false }`（**不**抛；**不**泄漏 path / leaf type / errno 细节到 message）；对 normal file / directory / symlink / 恶意 leaf **一律相同**
6. 成功 open 后：`fstat` 必须 regular file（非 symlink/dir）；否则 → `SafeDataFileError`
7. 完整写满 `text` → `handle.sync()`（若存在）→ `close`
8. **open 成功后任意出口**（fstat / write / sync error，含成功路径）**必须** `finally close`；**close failure** 映射 `SafeDataFileError`（path-free）
9. **parent directory sync** 仅在 `{created:true}` 且文件 write + sync + close **均成功后** best-effort 执行（与 `safeAtomicWriteText` 相同 best-effort 模式；失败不改变已成功 create 结果）
10. 成功 → `{ created: true }`
11. **非 EEXIST** open/write/stat/close 故障 → `SafeDataFileError`（path-free）
12. **禁止** overwrite / truncate existing；**禁止** `rename` over final；**禁止** `unlink` final；**禁止**向 symlink 外部目标写入

### 6.3 并发 init（O_EXCL 真实保证与非保证）

同一路径并发 N 个 `safeCreateExclusiveText`：**恰好一个** `{created:true}`，其余 `{created:false}`（或 SafeDataFileError 仅当非 EEXIST 故障）。

**O_EXCL 只防并发初始化竞态。它不验证 generation 真实性，也不区分“合法已初始化”与“恶意占位”。**

### 6.4 EEXIST 语义（强制诚实）

`{ created: false }` 对以下 **一律相同**、**不区分**：

- 已存在的正常 regular file（含合法 generation-open）
- 已存在的 directory leaf
- 已存在的 symlink leaf（含指向 dataDir 外目标）
- 其它恶意/占位 leaf

journal `initializeAuditIntegrityJournal` 对 `{created:false}` **统一**映射为 `audit-integrity-already-initialized`（fail-closed）。

**symlink / 恶意 leaf init 统一（强制）：** 因 final path `O_EXCL` 对已存在 leaf（含 symlink / 恶意 leaf / 目录 / 正常文件）产生 **EEXIST** → primitive 返回 `{created:false}` → initializer **一律** `audit-integrity-already-initialized`。**不允许**把该 EEXIST 路径写成 `audit-integrity-io-error`。**仅**非 EEXIST 的 open/write/stat 故障映射 `audit-integrity-io-error`。外部 target **不读不写**。

**后果：**

1. 攻击者可预置任意 EEXIST leaf → **DoS** 阻止合法 init
2. **不得**宣称系统“识别合法初始化”
3. **不得**从 already-initialized 推断 generationId/内容真实
4. 测试必须证明：leaf 为 **symlink 指向外部目标** 时，**不向外部目标写入、不读取**外部敏感内容（只断言外部文件 mtime/size/probe 字节不变等安全观测）

### 6.5 与 atomic write 区别

| | `safeAtomicWriteText` | `safeCreateExclusiveText` |
| --- | --- | --- |
| 目标 | 发布/覆盖最终文件 | **仅**首次创建 |
| rename | 有 | **无** |
| 已存在 | 覆盖（regular file） | `{created:false}`（**不区分** leaf 类型） |
| journal 用途 | **禁止**用于 journal 续写 | **仅** generation-open 首次落盘 |
| 真实性 | N/A | **不**验证 generation 真实性 |

---

## 7. Journal 公共 API

### 7.1 `initializeAuditIntegrityJournal(root, { generationId })`

**前置：**

- `root` 经 `assertSafeDataRoot`（必须已存在）
- `generationId` 匹配 `^[0-9a-f]{32}$`

**同进程 single queue（强制）：** 与 `appendAuditIntegrityEvent` **共用** 同一 per-root Map `auditIntegrityJournalQueues`（key = `assertSafeDataRoot` 返回的 resolved root）。**禁止** init/append 分队列或绕过队列。`O_EXCL` 仍负责跨进程 init 抢占；queue 负责同进程 `init ∥ append` 排序。`verifyAuditIntegrityJournalFile` **可读独立**（不强制入写队列），但不得因此让 init/append 绕队列。

**queue 内步骤：**

1. 校验 generationId（非法 → `audit-integrity-generation-id-invalid`；可在 queue 外快速拒，但 **成功路径的 exclusive create 必须在 queue 内**）
2. 构造 generation-open record + `linkDigest`（§4.4）
3. `line = canonicalStringify(record) + '\n'`
4. `safeCreateExclusiveText(root, AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH, line, { mode: 0o600 })`
5. `created:false`（含 file/dir/symlink/恶意 leaf/并发 loser；**统一 EEXIST 语义**）→ throw `audit-integrity-already-initialized`（**禁止**映射 io-error；**可能是 DoS**；**不**验证 generation 真实性）
6. 非 EEXIST 的 SafeDataFileError / open 故障 → `audit-integrity-io-error`
7. `created:true` → return success receipt

**Success receipt（仅此 allowlist）：**

```js
{
  state: 'initialized',
  generationId,          // 32 hex（调用方提供的标签；非经认证身份）
  recordCount: 1,        // generation-open 计第 1 条
  headDigest,            // = linkDigest of open
}
```

**禁止：** `ok: true/false` 含混布尔；附带 path；附带 raw record 全文非必要字段；宣称“合法初始化识别成功”。

### 7.2 `appendAuditIntegrityEvent(root, { generationId, event })`

**前置：**

- `generationId` 合法 32 hex
- `event` 通过 `projectStrictCanonicalSanitizedEvent`（失败 → `audit-integrity-event-invalid`）

**同进程 single queue（强制）：** 与 `initializeAuditIntegrityJournal` **共用** 同一 per-root Map `auditIntegrityJournalQueues`（key = resolved root）。**禁止** 另建 append-only 队列或绕过队列直接读写 journal。模式同 capability sink / audit-log retention queue；rejection 不毒化后续 task。

**queue 内步骤（完整）：**

1. `safeReadText(..., { maxBytes: 1_572_864 })`
   - ENOENT → `audit-integrity-not-initialized`
   - **size 超限** / 权限 / stat / 非 regular / 其它 `SafeDataFileError` → **统一** `audit-integrity-io-error`（**不是** bounds-exceeded）
2. **解析行数 preflight（bounds，先于或并列于结构 verify，但码独立）：**
   - 若 existing `lines.length > 4096` → **`audit-integrity-bounds-exceeded`**；**不写**；**不开** next generation
   - 若 existing `lines.length === 4096` → **允许**继续（将写出第 **4097** 条）
   - 若 existing `lines.length < 4096` → 允许继续
3. **full structure verify** 内存解析（§8）
   - 结构失败 → `audit-chain-broken`；**不写**
   - bounds 失败 → `audit-integrity-bounds-exceeded`；**不写**
4. 校验文件 `generationId ===` 调用参数；否则 `audit-chain-broken`（mismatch 是链不一致子集；**本设计冻结为 `audit-chain-broken`**）
5. `sequence = head.sequence + 1`；`previousLinkDigest = head.linkDigest`
6. 计算 payloadDigest / linkDigest（§4.5）— payloadDigest **仅**绑定本次 post-sanitize projection
7. `safeAppendText` 写入一行
8. 返回 receipt

**Success receipt：**

```js
{
  state: 'appended',
  generationId,
  sequence,              // ≥ 1；首 event 为 1
  recordCount,           // append 后总行数（含 generation-open 第 1 条）；API 最大 4097
  headDigest,            // 新 linkDigest
  payloadDigest,         // 写入时 projection 摘要；非外部 events 真实性证明
}
```

**首 event 计数：** open 为 sequence 0 / recordCount 1（**第 1 条**）；首 event-link sequence **1**，recordCount **2**。

**4096 唯一语义（冻结）：**

```text
generation-open                    = 第 1 条（sequence 0）
preflight allows existing lines    <= 4096
existing == 4096                   → 允许 append → 文件变为 4097 条
existing == 4097（下一次 preflight）→ audit-integrity-bounds-exceeded
                                     文件不变
                                     不触发、不建议 automatic next generation
                                     V1.35 无 recovery generation
禁止把 4097 拒绝写成 audit-chain-broken
```

### 7.3 `verifyAuditIntegrityJournalFile(root)`

**步骤：**

1. assert root
2. read with maxBytes
   - ENOENT → `audit-integrity-not-initialized`
   - 读/权限/size 超限等 → `audit-integrity-io-error`
3. bounds + parse + schema + chain（§8）
   - **成功仅表示 journal 内部结构自洽**，**不是** authenticity / 防篡改
4. 成功 receipt：

```js
{
  state: 'verified',
  generationId,
  recordCount,
  headDigest,
}
```

### 7.4 错误类型

```js
export class AuditIntegrityJournalError extends Error {
  // message === code；name = 'AuditIntegrityJournalError'
  // code: 下列固定 kebab-case 之一
  // 不包含 path / underlying message / stack 注入
}
```

### 7.5 错误码 registry

**分类标题（仅导航；精确码表为 SoT，分类标题不得覆盖分码）：**

- **I/O 类：** `audit-integrity-io-error` — **仅** file size / `maxBytes` 超限，以及其它 `SafeDataFileError` / root / read / write / fsync 等 I/O 失败
- **独立状态/输入码（禁止并入 io-error）：** `audit-integrity-not-initialized`、`audit-integrity-already-initialized`、`audit-integrity-event-invalid`、`audit-integrity-generation-id-invalid` 各自独立
- **链结构损坏类：** `audit-chain-broken` — **仅** 结构链（JSON/schema/key/order/seq/prev/**linkDigest** 等结构不一致）
- **Bounds 类（不是 chain corruption；也不是 size io）：** `audit-integrity-bounds-exceeded` — **仅** lines 与 per-line UTF-8 上界

| code | 何时 | ERROR_CODES |
| --- | --- | --- |
| `audit-chain-broken` | 结构/JSON/exact key set&order/seq/`previousLinkDigest`/`linkDigest` mismatch/generation 不一致；坏尾/空行/未重算的局部损坏。**`payloadDigest` 仅校验格式（64 lowercase hex 等）并作为 link preimage 输入**；verify **不**重算 event 原像、**不**反查 `events.jsonl`。linkDigest mismatch / prev 断裂 / seq 断裂等均为 chain-broken | **已有** `AUDIT_CHAIN_BROKEN`（**不是**本次新增） |
| `audit-integrity-bounds-exceeded` | **仅**：(a) append preflight existing lines > 4096；或 (b) verify 时 `lines.length > 4097`；或 (c) 任一 line `Buffer.byteLength(line,'utf8') > 374`（**JSON.parse 前**）。**禁止**把 file size / maxBytes 超限映射到本码 | **新增** `AUDIT_INTEGRITY_BOUNDS_EXCEEDED` |
| `audit-integrity-not-initialized` | 文件不存在（verify/append） | **新增** `AUDIT_INTEGRITY_NOT_INITIALIZED` |
| `audit-integrity-already-initialized` | exclusive create `{created:false}`（已存在 file/dir/symlink/恶意 leaf/并发 loser；**统一**；**禁止**写成 io-error） | **新增** `AUDIT_INTEGRITY_ALREADY_INITIALIZED` |
| `audit-integrity-io-error` | 读/写/权限/磁盘/root 等 IO 安全失败；**含** `safeReadText(...,{maxBytes:1_572_864})` 的 **size 超限**与其它 path-free `SafeDataFileError`（与 permission/stat 同映射） | **新增** `AUDIT_INTEGRITY_IO_ERROR` |
| `audit-integrity-event-invalid` | append 的 event 未通过 strict projection | **新增** `AUDIT_INTEGRITY_EVENT_INVALID` |
| `audit-integrity-generation-id-invalid` | generationId 格式非法 | **新增** `AUDIT_INTEGRITY_GENERATION_ID_INVALID` |

**规则：**

1. 所有公开抛出的 `error.code` 必须是上表之一
2. `error.message === error.code`
3. **不**附加 `cause` 到公开可枚举字段；不复制 underlying stack 到 message
4. `test/error-codes.test.js` 必须更新 closed-set：`EXPECTED_ERROR_CODES` **全表** + 计数 **45 → 51**（既有 45 + **新增 6**；`audit-chain-broken` 已在 45 内 **不计新增**）；保持 kebab-case + unique + `assertRegisteredErrorCode`。**禁止**只注册码而不改 closed-set 测试
5. SafeDataFileError 在 journal 边界 **映射** 为 `audit-integrity-io-error`（不向外抛 SafeDataFileError），except 测试直接测 primitive 时；**size 超限同此映射**
6. **禁止**把 bounds 满界 / 4097 拒绝映射为 `audit-chain-broken`
7. **禁止**把 size/maxBytes 超限映射为 `audit-integrity-bounds-exceeded`
8. per-line 过长（JSON.parse 前）→ **`audit-integrity-bounds-exceeded`**；坏 JSON / 错 schema 仍为 **`audit-chain-broken`**

---

## 8. Verify 算法（bounds 与 chain 分离）

对已读入的 UTF-8 字符串 `raw`（size 已在 `safeReadText(...,{maxBytes:1_572_864})` 层 ≤ 1.5 MiB；**size 超限在 read 层产生 path-free SafeDataFileError → journal 映射 `audit-integrity-io-error`，绝非 bounds-exceeded**）：

```text
1) 若 raw === '' → audit-chain-broken
2) 若 !raw.endsWith('\n') → audit-chain-broken          // 坏尾
3) 拆行：body = raw.slice(0,-1)；lines = body==='' ? [] : body.split('\n')
4) 若存在空行 → audit-chain-broken
5) 若 lines.length === 0 → audit-chain-broken
6) 若 lines.length > 4097 → audit-integrity-bounds-exceeded
   （API 可达最大 = 4097；validation/DoS bound；非 retention；非 chain corruption；非 size io）
7) 对每个 line index i：
   7a) 若 Buffer.byteLength(line,'utf8') > MAX_CANONICAL_RECORD_LINE_BYTES (374)
       → audit-integrity-bounds-exceeded
       （在 JSON.parse 之前；防巨行 parse DoS；非 chain corruption；非 size io）
   7b) JSON.parse；失败 → audit-chain-broken
   7c) plain + exact 7 keys + exact key order + 类型/hex 约束
       失败 → audit-chain-broken
       其中 payloadDigest：generation-open 必须 null；event-link 必须 64 lowercase hex 格式
       （**仅格式**；不重算 event 原像；不反查 events）
   7d) re-stringify canonical 必须与 line **byte-equal**；否则 audit-chain-broken
8) 首行必须 recordKind=generation-open；sequence=0；prev=null；payloadDigest=null
9) 计算 expectedOpenLink；与 record.linkDigest 比较；失败 → audit-chain-broken
10) generationId 固定为 open.generationId
11) 对 i=1..n-1：
    - recordKind=event-link
    - sequence === i（因 open 为 0，第 k 个 event-link sequence 为 k）
    - previousLinkDigest === 前一行 linkDigest
    - generationId 一致
    - payloadDigest：仅确认已通过格式校验；作为 link preimage 输入字段
    - 用记录内 payloadDigest 重算 link：
      expectedLink = SHA256(DOMAIN_EVENT_LINK || gen || seq || prev || payloadDigest)
      必须等于 record.linkDigest；mismatch → audit-chain-broken
    任一失败 → audit-chain-broken
12) 返回 generationId, recordCount=lines.length, headDigest=last.linkDigest
    （成功 = 内部结构自洽；≠ authenticity / 防篡改）
```

**说明：**

- journal **不存储** event 原文 → verify **不**重算 payloadDigest 的事件原像、**不**反查 `events.jsonl`
- `payloadDigest` **仅**格式校验 + 作为 link preimage 输入；append 时对 post-sanitize projection 的摘要一致性 **只在 write-time** 承诺
- **不为**外部 `events.jsonl` 历史提供可信溯源 / 真实性
- `linkDigest` mismatch / `previousLinkDigest` 断裂 / `sequence` 断裂 → **`audit-chain-broken`**
- 合法 **tail truncation**（删尾部 N 条）后的前缀仍可通过上述算法 → honest limitation 必须 PASS
- **suffix rewrite**（改某 event-link 的 `payloadDigest` 后按 §17 精确重算该点至 EOF 的 link 链）仍可通过 → honest limitation 必须 PASS

### 8.1 Append 前 preflight 与 4096 唯一语义

```text
MAX_EXISTING_LINES = 4096
MAX_LINES_AFTER_APPEND = 4097   // = MAX_EXISTING_LINES + 1

append preflight:
  existing = lines.length
  if existing > 4096:
      throw audit-integrity-bounds-exceeded   // NOT audit-chain-broken
      // 文件不变；不触发、不建议 automatic next generation
      // V1.35 无 recovery generation
  if existing <= 4096:
      // 允许继续；existing == 4096 时本 append 写出第 4097 条
  then: full structure verify (chain-broken on structural failure)
  then: write one line
```

| existing | append 结果 |
| --- | --- |
| 0（无文件） | not-initialized |
| 1..4095 | 允许（结构 OK 时）→ existing+1 |
| **4096** | **允许** → 写出第 **4097** 条 |
| **4097** | **`audit-integrity-bounds-exceeded`**；文件不变 |
| >4097 | **`audit-integrity-bounds-exceeded`**；文件不变 |

### 8.2 Failure matrix（摘要）

| 条件 | code |
| --- | --- |
| 文件不存在 | not-initialized |
| **size>1.5MiB**（`safeReadText` maxBytes）/ 权限 / root 非法 / 写失败 / 其它 SafeDataFileError | **`audit-integrity-io-error`**（size **不是** bounds-exceeded） |
| existing > 4096（append）/ lines > 4097（verify）/ per-line UTF-8 >374（JSON.parse 前） | **`audit-integrity-bounds-exceeded`**（**不是** chain-broken；**不含** file size） |
| 缺尾换行 / 空行 / 坏 JSON / 错 schema/key order/hex | chain-broken |
| payloadDigest **格式**非法（非 null/非 64hex） | chain-broken（格式层）；**不**反查 events |
| linkDigest mismatch / prev 断 / seq 断 / 未重算的局部损坏 | chain-broken |
| 中间删插乱序致 seq/prev 断 | chain-broken |
| 断链后 append | chain-broken；字节不变 |
| 已存在 leaf 再 init（file/dir/symlink/恶意 leaf；EEXIST） | already-initialized（**统一**；可能 DoS；**不是** io-error） |
| event hostile / 缺 id | event-invalid |
| generationId 格式错误 | generation-id-invalid |
| suffix rewrite / tail truncation / events-only / full replace | **无错误**；verify **success**（limitation） |

---

## 9. Bounds 证明（canonical max line UTF-8）

### 9.1 常量

```text
MAX_PRE_READ_BYTES = 1_572_864          // 1536 * 1024
MAX_EXISTING_LINES = 4096               // append preflight 允许 existing <= 此值
MAX_LINES_AFTER_APPEND = 4097           // 恰 4096 可再 append 1 条
MAX_CANONICAL_RECORD_LINE_BYTES = 374   // 见下
MAX_LINE_WITH_NEWLINE = 375
```

### 9.2 记录行上界推导

**generation-open（固定）：**

- keys + 固定 null + generationId(32) + linkDigest(64) + sequence `0`
- 实测：`Buffer.byteLength = 240`

**event-link（最大）：**

- `recordKind` 固定 `event-link`
- `generationId` 32 hex
- `sequence` 最大 `9007199254740991`（16 digits）
- `previousLinkDigest` / `payloadDigest` / `linkDigest` 各 64 hex
- 实测：`Buffer.byteLength = 374`

**结论：** `MAX_CANONICAL_RECORD_LINE_BYTES = 374` 是精确上界（schemaVersion=1 且 key order 固定时）。

### 9.3 文件上界

```text
4096 * 375 = 1_536_000  <  1_572_864
4097 * 375 = 1_536_375  <  1_572_864
```

因此：**在每行 ≤374 且含尾 `\n` 的合法 journal 上，API 可达的 4097 行永远不会触发 1.5 MiB size 拒读**。1.5 MiB 是 `safeReadText` 的 maxBytes：**size 超限 → SafeDataFileError → `audit-integrity-io-error`**（与其它 read/stat/permission 同）。非规范巨行若仍 ≤1.5 MiB 整文件，则在 JSON.parse 前被 **per-line 374** 拦截 → **`audit-integrity-bounds-exceeded`**。**禁止**把 size 超限写成 bounds-exceeded。

### 9.4 事件 payload 上界（digest 输入，不入 journal 行）

strict sanitized event 的 canonical UTF-8 远低于 1.5 MiB read bound（理论全字段 string 各 200 量级约 3187；post-sanitize 含 ISO `createdAt` 约 3011），**不**进入 journal 行，故 **不影响** record max 374 的行上界证明。payloadDigest 只存 64 hex。verify **不**重算该 event 原像。

### 9.5 非 retention / 非 chain-broken / 非 auto-generation / size≠bounds 声明

错误码分层（SoT）：

| 上界 | 触发条件 | 错误码 |
| --- | --- | --- |
| file size / maxBytes 1.5 MiB | `safeReadText` size 超限等 | **`audit-integrity-io-error`** |
| existing lines / per-line UTF-8 | existing>4096 或 lines>4097 或 line>374（parse 前） | **`audit-integrity-bounds-exceeded`** |
| 结构链 | linkDigest/prev/seq/JSON/schema 等 | **`audit-chain-broken`** |

- **不**删除旧行
- **不** rotation
- lines/per-line 满界后 fail-closed → **`audit-integrity-bounds-exceeded`**
- size 满界后 fail-closed → **`audit-integrity-io-error`**
- bounds **不是** `audit-chain-broken`（bounds ≠ chain corruption）
- size io **不是** bounds-exceeded
- **不**触发、**不**建议 automatic next generation
- V1.35 **无** recovery generation
- **不是**产品 retention 策略

---

## 10. 并发与 crash 模型

### 10.1 同进程

- **唯一** queue Map：`auditIntegrityJournalQueues` 位于 journal 模块
- key = `assertSafeDataRoot` 返回的 resolved root
- rejection 不毒化后续 task（`previous.catch(() => {})` 模式）
- **`initializeAuditIntegrityJournal` 与 `appendAuditIntegrityEvent` 都必须**经该 Map 串行（**禁止**分队列 / 绕队列）
- `O_EXCL` 负责跨进程 init 抢占；queue 负责同进程 `init ∥ append` 排序
- `verifyAuditIntegrityJournalFile` **可读独立**（不强制入写队列），但不得因此削弱 init/append 的 queue 合同

### 10.2 多进程

```text
ASSUMPTION: single-writer per dataDir journal file
NO cross-process lock in V1.35
ON contention: eventual verify → audit-chain-broken (fail-closed)
DO NOT claim multi-process correctness
```

### 10.3 crash / partial

| 场景 | 期望 |
| --- | --- |
| exclusive create 写中崩溃 | 可能留下 partial 文件；再次 init → already-initialized 或随后 verify chain-broken；**禁止**自动 unlink repair / next generation |
| append 写中崩溃 | 可能缺尾 `\n` 或半行 → verify chain-broken；拒续写 |
| fsync 前断电 | 同 partial；fail-closed |
| parent sync best-effort 失败 | 不单独成功宣称 durability beyond “有 sync 则 await file sync” |

### 10.4 symlink

| 场景 | 期望 |
| --- | --- |
| root 为 symlink | SafeDataFileError → io-error |
| parent 段 symlink | fail → io-error |
| leaf symlink / 恶意 leaf / 目录 / 正常文件（init） | final `O_EXCL` → **EEXIST** → `{created:false}` → init **统一** `audit-integrity-already-initialized`；**禁止**该 EEXIST 路径写成 io-error |
| 非 EEXIST open/write/stat 故障 | io-error |
| leaf symlink 外部目标 | **禁止读、禁止写**外部 target；测试仅断言外部 size/mtime/probe 字节不变 |
| 不泄漏 leaf 是 symlink 还是 directory | message 仅为 code；EEXIST 路径 **不区分** leaf 类型 |

---

## 11. Success receipt / error truth table

| API | 条件 | 结果 |
| --- | --- | --- |
| initialize | exclusive OK | `{state:'initialized', generationId, recordCount:1, headDigest}` |
| initialize | EEXIST / loser / 任意已存在 leaf | throw already-initialized（**统一**；可能 DoS） |
| initialize | bad generationId | throw generation-id-invalid |
| initialize | root/IO | throw io-error |
| append | not exists | throw not-initialized |
| append | bad event | throw event-invalid |
| append | existing ≤4096 且结构 ok | `{state:'appended', generationId, sequence, recordCount, headDigest, payloadDigest}` |
| append | existing >4096 | throw **`audit-integrity-bounds-exceeded`**；**无写入**；**无** next generation |
| append | structure bad | throw chain-broken；**无写入** |
| append | IO after/during write | throw io-error（writeAttempt 语义：若需与 sink 对齐，可内嵌非公开字段；**公开 receipt 不使用 ok boolean**） |
| verify | missing | not-initialized |
| verify | 结构 ok（含合法 4097 行；含合法前缀 tail truncation） | `{state:'verified', generationId, recordCount, headDigest}`（**仅**结构自洽） |
| verify | structure bad | chain-broken |
| verify | lines >4097 / per-line UTF-8 >374（JSON.parse 前） | **`audit-integrity-bounds-exceeded`** |
| verify | size>1.5MiB / 其它 SafeDataFileError / IO | **`audit-integrity-io-error`**（size **≠** bounds） |

**禁止** success 使用 `ok:true` 作为唯一信号。**禁止**把 verify success 解释为 authenticity / 防篡改。

---

## 12. 文件图（实现后）

```text
src/
  audit-event-schema.js          [NEW] sanitize SoT + strict projection
  audit-log.js                   [MOD] import+re-export sanitize；行为 bit-identical
  audit-integrity-journal.js     [NEW] journal API + queue + BLOCKED 头注释
                                 （unkeyed structural consistency；禁 tamper-evident）
  safe-data-files.js             [MOD] + safeCreateExclusiveText
  error-codes.js                 [MOD] + 6 integrity codes（含 bounds-exceeded；chain-broken 已存在）
  version.js                     [MOD 仅 C5] → V1.35
  gold-readiness.js              [MOD 仅 C5] evidence/nextStep 诚实措辞；计数不变
README.md                        [MOD 仅 C5] V1.35 边界；unkeyed structural-consistency 措辞

test/
  audit-event-schema.test.js     [NEW]
  audit-integrity-journal.test.js[NEW]（含 honest limitation PASS 套件）
  safe-data-files.test.js        [MOD] exclusive create + symlink 外部不写
  audit-log.test.js              [保持/可加 bit-identical 向量]
  error-codes 相关测试           [MOD]（含 bounds-exceeded）
  version / gold / readme 测试   [MOD 仅 C5]
  cross-lan-m1-exit-audit.test.js[不改 markdown；runtime 允许 V1.35]

docs/ 历史 M1 audit              [不改]
```

**不改：** `src/server.js`、`src/agent.js`、`src/capability-audit-sink.js` schema、Web、package.json 依赖。

---

## 13. Gold / 版本诚实 flags

| Flag / 项 | V1.35 值 |
| --- | --- |
| `LINKE_RELEASE_VERSION` | 实现+测试绿后 **`V1.35`** |
| Gold overall | **blocked** |
| ready / partial / blocked / total | **4 / 4 / 1 / 9** |
| `production-hardening` | **partial**（不 ready） |
| `cross-lan-connectivity` | **不存在** |
| realAttemptAudit / global real / execute / wiring / eligible | **false** |
| M1 route | open |
| M2 | denied |
| T6d.3 | **partial foundation only** |
| M6d Exit | **否** |
| production integration | **否** |
| 签字上限 | **`V1.35 unkeyed audit hash-chain structural consistency foundation implementation`** |
| M1 Exit audit markdown | **不改**（仍 V1.33 snapshot） |

README / Gold 文本若提 journal，必须含：

- independent `audit/integrity-journal.jsonl`
- T6d.3 **partial foundation**
- **unkeyed hash-chain structural consistency foundation**（中文：无密钥哈希链结构一致性基座）
- **禁止** `tamper-evident` / 防篡改能力 / T6d.3 complete / production integration
- not dual-write / not M6d Exit / not Gold
- honest：suffix rewrite / tail truncation / events-only / full-file replacement **不可检测**

---

## 14. 风险账本（P0 / P1）

| ID | 级 | 风险 | 缓解 |
| --- | --- | --- | --- |
| R01 | P0 | 把行内链做进 events 破坏 retention | 选 B；测试禁止 journal import 写 events |
| R02 | P0 | sanitize 提取后 bit 漂移 | 固定向量 + 全量 audit-log 测试 |
| R03 | P0 | journal ↔ audit-log cycle | 架构禁令 + source scan |
| R04 | P0 | 使用 `tamper-evident` / 宣称防篡改 / 可检 suffix rewrite 等 | **禁止** `tamper-evident`；统一 unkeyed structural-consistency 措辞；Gold/README/scan 测试；honest limitation PASS 套件 |
| R05 | P0 | 断链后仍续写 | append 前 full verify；字节不变测试 |
| R06 | P0 | exclusive create 覆盖已存在文件 | O_EXCL；EEXIST→created:false；测试 |
| R06b | P0 | 把 EEXIST 当成“合法 init 识别”或验证 generation 真实性 | §6.3–6.4 诚实合同；统一 already-initialized；symlink 外部不写测试 |
| R07 | P0 | 错误泄漏 path/stack | path-free 断言；message===code |
| R08 | P0 | 抬升 Gold / M6d / eligible / production integration | C5 诚实测试；计数锁 4/4/1/9；签字上限扫描 |
| R09 | P0 | production dual-write 误接 server | source scan 零引用 journal from server/agent |
| R09b | P0 | 把 4097 拒绝写成 chain-broken 或自动 next generation | 独立 `audit-integrity-bounds-exceeded`；显式禁 auto generation |
| R10 | P1 | 多进程竞态被宣称为安全 | 文档 ASSUMPTION；测试不伪称跨进程锁 |
| R11 | P1 | 行上界错误导致 DoS 或误拒 | §9 精确证明 + 4096/4097 边界测试 |
| R11b | P0 | 把 size>maxBytes 映射为 bounds-exceeded | size/stat/permission → 统一 io-error；bounds **仅** lines/per-line |
| R12 | P1 | 随机 id 使 digest 向量不稳 | 测试固定 id/createdAt；文档 §5.5 |
| R13 | P1 | 与 capability sink queue 互相污染；或 init/append 分队列/绕队列 | 独立 Map；init+append **同一** `auditIntegrityJournalQueues` |
| R14 | P1 | 新增 error code 重复/非 kebab；或只注册不改 closed-set 测试 | `EXPECTED_ERROR_CODES` **45→51** 全表更新 |
| R15 | P1 | partial crash 后自动 repair 掩盖破坏 | 禁止 repair；broken 永久拒写 |
| R16 | P1 | C5 过早 bump 版本 | 仅在实现与测试全绿后 bump |
| R17 | P1 | 改历史 M1 audit 文档 | 明确禁止；temporal 只锁 snapshot 文本 |
| R18 | P1 | 测试写入仓库目录 | **仅** `mkdtemp(tmpdir())` |
| R19 | P1 | 把 payloadDigest 解释为 events 历史真实性 | §2.4 / §5.5 强制解释；scan 禁过度宣称 |
| R20 | P1 | honest limitation 被写成期望 chain-broken | 测试名 + assert verify success；DoD 锁 |

---

## 15. 明确不实现清单（V1.35）

1. external anchor / HMAC / signature / 独立 head 文件
2. `priorChainHeadDigest`
3. 断链后 new generation / **automatic next generation** / recovery UI / recovery generation
4. auto repair / truncate / compact journal
5. retention / rotation
6. monitor / alert 接线
7. production dual-write / **production integration**（events 或 capability sink → journal）
8. public HTTP/CLI/Web/Agent 表面
9. capability / approval / RealAuditProof 绑定
10. 多进程文件锁
11. 把 chain 字段写入 `events.jsonl`
12. WORM / immutable / tamper-proof / **`tamper-evident`** / 防篡改能力 / authenticity / 密码学防篡改 / 合规审计链完成 宣称
13. 检测 suffix rewrite / tail truncation / events-only mutation / full-file replacement
14. 从 EEXIST 识别合法初始化或验证 generation 真实性

---

## 16. 与后续里程碑的接口预留（仅文档）

| 未来项 | 依赖本版 | 本版不实现的缺口 |
| --- | --- | --- |
| production dual-write | append API + receipt | wiring、事务顺序、失败补偿、events↔journal 绑定 |
| T6d.3 complete | verify + 敏感扫描 + 演练证据 | scorecard ready 证据包；**非**本版签字范围 |
| §6.11 DR | chain-broken 语义 | trusted-recovery authorization、prior head、fleet re-enroll、**非 auto next generation** |
| external anchor / HMAC / signature | headDigest | 密钥/Keychain/备份 blob；此后才可谈更强完整性宣称 |
| realAttemptAudit wiring | 无直接依赖 | 仍是独立 execute locus |

---

## 17. 测试要求（设计层）

1. **仅** `fs.mkdtemp(os.tmpdir(), ...)` 作为可写根；**禁止**写仓库树
2. 向量：固定 generationId、固定 event id/createdAt、期望 digests 可复现
3. **可检测类（期望 chain-broken）：** 坏尾；未重算 digest 的改中间行；中间删行；插行；重排；错 schema/key/order/hash
4. **Honest limitation 类（必须 PASS = verify success；证明系统不虚假检测）：**
   - `documents-suffix-rewrite-is-not-detected`：**精确构造（journal 无“业务字段”）**
     1. 合法链：generation-open + ≥2 条 event-link
     2. 选定中间某条 **event-link** index `i`（`i≥1`）
     3. **仅**修改该记录的 `payloadDigest` 为另一合法 64 lowercase hex（保持 exact 7-key canonical order 与 `sequence` / `generationId` / `recordKind` / `schemaVersion` **不变**）
     4. **从该 index 重算**其 `linkDigest`（用新 payloadDigest + 原 prev/seq/gen 作 preimage）
     5. **对后续每条** `j=i+1..EOF`：同步 `previousLinkDigest = records[j-1].linkDigest`，并重算 `linkDigest`，直至 EOF
     6. 写回整文件 → `verify` **success**（`state:'verified'`）
     7. **禁止**只改 payload 而不重算 link、或打乱 key order，导致假 `audit-chain-broken`（那测的是可检测损坏，不是 limitation）
   - `documents-tail-truncation-is-not-detected`：删尾部 N 条得合法前缀 → verify **success**
   - `documents-events-only-mutation-is-not-detected-by-journal-verify`：改/删 `events.jsonl`，journal 不变 → journal verify **success**
   - `documents-full-file-replacement-with-new-generation-is-not-detected`：新 generationId 自洽文件替换 → verify **success**
5. **4096 语义：** existing=4096 可 append 第 4097；existing=4097 再 append → **`audit-integrity-bounds-exceeded`**；文件不变；**不是** chain-broken；**无** next generation
6. **size vs bounds：** 构造 >1.5 MiB journal 读路径 → **`audit-integrity-io-error`**；**不是** bounds-exceeded
7. **O_EXCL / EEXIST：** 并发单成功；file/dir/symlink/恶意 leaf 均 **already-initialized**（非 io-error）；symlink 外部 target **不读不写**
8. hostile event：Proxy、symbol、accessor、extra key、缺 id
9. source scans：journal 不 import audit-log；server/agent 不 import journal；不写 events 路径；源码/注释 **禁止** `tamper-evident`；含 unkeyed structural consistency 诚实说明；含 missing trusted-recovery authorization model
10. error code closed-set：`EXPECTED_ERROR_CODES` **45→51**（+6 新码；`audit-chain-broken` 既有）；kebab + unique
11. sanitize bit-identical

---

## 18. 文档阶段约束

- **只允许新增/修订**本 design 与对应 plan 两份文件
- **不**改源码/测试/README/version
- **不** commit / push（除非用户另行确认 C0）
- 实现必须严格 TDD 与 plan commit boundaries C0–C6

---

## 19. 设计验收清单

- [x] 比较 A/B/C 并选定 B
- [x] threat model + 可检测/不可检测边界 + 禁止 `tamper-evident`
- [x] state machine + 断链拒写 + bounds 独立码 + 无 auto next generation
- [x] 4096 唯一语义（恰 4096 → 4097；再 append → bounds-exceeded）
- [x] size>maxBytes → io-error（≠ bounds）；bounds 仅 lines/per-line
- [x] O_EXCL 仅并发 init；EEXIST 不区分 leaf；symlink/恶意 leaf → already-initialized（非 io-error）
- [x] payloadDigest 仅格式+link preimage 输入；verify 不重算 event 原像/不反查 events
- [x] init+append 同一 per-root queue；verify 可读独立
- [x] safeCreateExclusiveText 直 open O_EXCL；禁 openRegularNoFollow；禁 rename/unlink final
- [x] canonical preimage 精确 domain（unkeyed SHA-256）
- [x] failure matrix + receipt allowlist + bounds vs chain-broken vs size-io
- [x] file graph + Gold honesty + 签字上限
- [x] ≥10 P0/P1 risks（含过度宣称 / bounds / EEXIST DoS / size 错码）
- [x] 对齐 §6.11 / §8.3 / M6d T6d.3 partial
- [x] 对齐 V1.34 三路径隔离与零 public surface
- [x] honest limitation：suffix rewrite 精确 payloadDigest+link 重算；四类 must-PASS verify success
- [x] error closed-set 45→51（+6；chain-broken 既有）

**本 design 本身不提升任何 runtime flag。**
**签字上限：** `V1.35 unkeyed audit hash-chain structural consistency foundation implementation`
