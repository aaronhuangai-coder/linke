# V1.36 Audit Event/Journal Cross-Store Structural Consistency Verifier Design

## 目标

V1.36 在 **V1.35 unkeyed audit hash-chain structural consistency foundation** 之上，继续 **M6d T6d.3 partial**，交付**只读**、**retention-aware** 的 `audit/events.jsonl` ↔ `audit/integrity-journal.jsonl` **payloadDigest 时间序列关系核验器**。

> **本版交付：** `src/audit-integrity-cross-store.js` + journal 最小 `@internal` 只读 SoT 导出
> **核验对象：** 序列 `J`（journal event-link `payloadDigest` 时间序）↔ 序列 `E`（events 每条 strict canonical 重算的 `payloadDigest` 时间序）
> **签字上限（唯一允许的完成宣称）：**
> `V1.36 audit event/journal cross-store structural consistency verifier implementation`
> **定位：** **T6d.3 still partial** — **不是** T6d.3 complete / M6d Exit / production-hardening ready / production dual-write / Gold / GA / V2 / cross-LAN

本版关闭的**库级缺口**（仅当调用方显式调用本 verifier 时）：

- V1.35 在 linked 覆盖范围内，`events.jsonl` 单侧 mutation **完全不可见**于 journal `verify`
- V1.36 使 **overlap 内** events-only 错位/改写/重排/插入/删除 在本 verifier 下 **fail-closed** 为 `audit-integrity-cross-store-broken`

本版**为 V1.37 production dual-write** 提供可检测的半成功边界（`partial` / `verified` / `cross-store-broken`），**不**实现 dual-write 本身。

### 关键边界（必须先读）

| 层级 | V1.36 是否完成 | 含义 |
| --- | --- | --- |
| **只读 cross-store structural consistency verifier** | **是（本设计目标）** | 库级 API；无 production caller |
| **journal 只读 snapshot / digest SoT 最小导出** | **是** | 避免复制 parser/digest domain |
| **V1.35 journal foundation（init/append/verify 内部链）** | **保持** | 不改链 preimage / record schema / path |
| **HTTP `events.jsonl` schema / retention / 宽松 read** | **保持** | verifier **不**改 append/read 语义；**不**用宽松 sanitize 修复存量 |
| **T6d.3 complete** | **否** | 仍 partial |
| **M6d Exit / production-hardening ready** | **否** | scorecard 仍 partial |
| **production dual-write / wiring** | **否** | **零** server/agent/audit-log/capability sink 接线 |
| **init / append / repair / recovery / rotation / anchor / HMAC / signature** | **否** | 本版无写路径（除文档外） |
| **authenticity / WORM / immutable / 防篡改 / 密码学防篡改** | **否** | SHA-256 仅作 digest 比较输入 |
| **public HTTP/CLI/Web/Agent / monitor/alert** | **否** | 无 public surface |
| **Gold / GA / V2 / cross-LAN** | **否** | Gold **blocked 4/4/1/9** |
| **新 npm dependency** | **否** | 仅 Node 内置 |

**严禁**把 cross-store receipt `state:'verified'|'partial'`、或版本升至 V1.36 冒充：

- T6d.3 complete / M6d Exit / production-hardening ready / **production integration** / **production detects**
- Gold ready / GA / V2.0 / cross-LAN complete
- WORM / immutable / **tamper-proof** / forbidden compound（`tamper-` 与 `evident` 两段；测试 needle 运行时拼接） / **防篡改能力** / **authenticity**
- 合法 retention 删除已获授权 / legacy 前缀真实
- dual-write 事务协议已完成

**能力名冻结：**

```text
FORBIDDEN:
  - forbidden compound = 前缀 "tamper-" + 后缀 "evident"（任何限定；源码/README/Gold/commit/测试字面量
    均不得出现完整相邻形式；测试 needle 运行时由两段拼接）
  - "tamper-resistant" / "tamper-proof" as delivered
  - "防篡改能力" / 未限定 "detects deletion"
  - "T6d.3 complete" / "M6d Exit" / "production detects" as delivered
  - "automatic next generation" as delivered

ALLOWED capability (only):
  - audit event/journal cross-store structural consistency verifier
  - events↔journal payloadDigest 时间序列结构一致性核验

ALLOWED signature ceiling (only):
  - V1.36 audit event/journal cross-store structural consistency verifier implementation
```

**角色结论（文档阶段）：** 本任务 **仅 docs**；`PROCEED` ≠ 实现完成。

---

## 0. 源码与文档事实基线（不得猜）

以下来自当前 worktree（V1.35 已合入后）：

| 项 | 当前事实 |
| --- | --- |
| 版本 | `LINKE_RELEASE_VERSION = 'V1.35'` |
| journal | `src/audit-integrity-journal.js` → `audit/integrity-journal.jsonl` |
| events | `src/audit-log.js` → `audit/events.jsonl`（`AUDIT_RELATIVE_PATH` **未 export**） |
| schema | `src/audit-event-schema.js`：`sanitizeAuditEvent` / `projectStrict…` / `stringifyStrict…` |
| ERROR_CODES closed-set | **51**（含 V1.35 六码 + 既有 `audit-chain-broken`） |
| Gold | **blocked 4 ready / 4 partial / 1 blocked / total 9**；`production-hardening` **partial** |
| journal 导出 | `initialize` / `append` / `verify` + bounds 常量；**无** cross-store；`eventPayloadDigest` **私有** |
| journal import | 仅 `safe-data-files` + `error-codes` + `audit-event-schema`（`stringifyStrict`）；**禁止** `audit-log` |
| audit-log import | 仅 schema sanitize + safe-data-files；**禁止** journal |
| journal verify 对 events | **不读**；events-only mutation → journal verify **success**（honest limitation） |
| `safeReadText` 默认 maxBytes | `DEFAULT_MAX_READ_BYTES = 16 MiB` |
| journal pre-read | `1_572_864`（1.5 MiB）；size 超限 → **io-error**（≠ bounds） |
| journal lines | existing ≤4096 可 append 至 4097；per-line ≤374 |
| events `readAuditEvents` | 忽略坏行；**不** fail-closed；**不**适合做 cross-store SoT |
| events retention | `compactAuditFile` 保留 **后缀** `maxEvents` 行（atomic rewrite） |
| §8.3 production-hardening ready | 审计链/限流/restore/Retention/调度/监控真机跑通 — **本版仍不满足** |
| M6d T6d.3 | 审计链完整性与敏感字段扫描 — V1.36 仍 **partial** |

### 0.1 三路径隔离（永久保持）

```text
audit/events.jsonl                      ← HTTP/API sanitize 审计（可 retention compact）
audit/capability-proof-attempts.jsonl   ← V1.34 capability real-proof sink
audit/integrity-journal.jsonl           ← V1.35 integrity chain（generation-open|event-link）
```

V1.36 **只读** 比较 events 与 journal；**不**合并路径、**不**共享 queue、**不**把链字段写入 events。

### 0.2 本版关闭 / 不关闭的缺口

| 缺口 | V1.35 | V1.36（显式调用 verifier 时） |
| --- | --- | --- |
| journal 内部未重算局部损坏 / 中间删插乱序 / 坏尾 | 可检测 | 保持（inspect 复用） |
| **linked overlap 内 events-only mutation** | **不可见** | **可检测 → cross-store-broken** |
| retention 导致 events 为 journal 后缀 | N/A | **verified** `events-suffix-of-journal`（仅结构兼容） |
| legacy 前缀 events 未入链 | N/A | **partial** `journal-suffix-of-events` / `uncovered-events` |
| 普通非 suffix 未入链尾 U | N/A | **cross-store-broken** |
| replay-shaped 未入链尾（`E=…+J+J`） | N/A | **partial** journal-suffix（limitation；**非** broken；无 occurrence 绑定） |
| 同时重写两边至自洽 / 一致 suffix / 新 generation 全量替换 | 不可检 | **仍可能通过**（honest limitation） |
| production 自动检测 | 无 | **仍无** production caller |

---

## 1. 候选评估与选定

| 准则 | **A：在 journal verify 内嵌 events 反查** | **B：独立只读 cross-store verifier（选定）** | **C：改 events 行内嵌 digest** |
| --- | --- | --- | --- |
| journal 模块纯度 | 破坏「verify 仅内部结构」合同 | **保持**；inspect 只读 | 污染 events schema |
| retention 语义 | 易把 suffix 误判 broken | **可**显式 relationship | compact 破坏行内链 |
| production wiring 风险 | 高（verify 常被误当完整完整性） | **低**（显式 API、零接线） | 高 |
| SoT 复制 | 易复制 digest domain | **最小 @internal 导出** | 新 schema 风险 |
| V1.37 dual-write 预备 | 纠缠 | **清晰 preflight/reconcile 钩子** | 难 |

```text
SELECTED = B 独立只读 cross-store verifier
MODULE   = src/audit-integrity-cross-store.js
PUBLIC   = verifyAuditIntegrityAgainstEventStore(root, options?)
JOURNAL  = + inspectAuditIntegrityJournalFile + computeAuditIntegrityEventPayloadDigest (@internal 只读)
REJECTED = A 内嵌 journal verify | C events 行内 digest
```

---

## 2. 威胁模型与能力边界

### 2.1 资产

| 资产 | 说明 | 本版保证边界 |
| --- | --- | --- |
| A1 序列 `J` | journal 已内部 verify 后的 event-link `payloadDigest[]` | 仅 journal 文件；依赖 V1.35 结构自洽 |
| A2 序列 `E` | 当前 `events.jsonl` 每条 **strict canonical** 重算 digest[] | 仅当前窗口；**不**用 sanitize 补 id/time |
| A3 关系 `rel(J,E)` | 完整逐项 suffix/equal/empty 关系 | **结构**关系；≠ 授权/真实性 |
| A4 receipt | 固定 allowlist、path-free | 无 raw event / path / secret |
| A5 零 wiring | production 不自动调用 | 检测 **仅**发生在显式调用时 |

### 2.2 攻击者与结果

| 攻击者 | 能力 | 本版结果 |
| --- | --- | --- |
| T1 overlap 内改 events 一行（digest 变）且 journal 不变 | 改 events | **cross-store-broken**（非 suffix） |
| T2 overlap 内删/插/重排 events | 改 events 序 | **cross-store-broken** |
| T3 合法 retention compact 保留后缀 | events 变短为 J 的后缀 | **verified** `events-suffix-of-journal` |
| T4 legacy 前缀未覆盖 | events 更长，J 为 E 后缀 | **partial** `journal-suffix-of-events` |
| T5 仅有 events、无 journal | journal missing | **partial** `uncovered-events` |
| T6 有 journal event-links、events 空/缺失 | 删 events | **cross-store-broken**（禁止空后缀掩盖丢失） |
| T7 同时重写 events+journal 至 EOF 自洽 | 双写一致假历史 | **可能 verified**（limitation） |
| T8 两边截成同一合法 suffix | 一致截断 | **可能 verified**（limitation） |
| T9 full replacement 新 generation + 匹配 events | 新自洽对 | **可能 verified**（limitation） |
| T10 并发写入中点读 | 半行/中间态 | **fail-closed** typed error；V1.36 **不**加锁掩盖 |
| T11 hostile 假绿 | 用 set/count/head/prefix 冒充 suffix | **禁止**；测试锁逐项 |
| T12 路径/敏感泄漏 | 错误带 path | path-free；receipt 无 body |
| T13 普通非 suffix 未入链尾 U | events 尾与 J 任意后缀均不逐项匹配 | **cross-store-broken** |
| T14 replay-shaped 未入链尾（`E=…+J+J` 等） | 完整重放整段 J 的值序列 | **partial** `journal-suffix-of-events`（limitation；**不是** broken） |

**签字语义（强制）：** 本版仅证明 **J↔E 的结构关系**（equal / 非空 suffix / partial uncovered / broken）。**不**证明 occurrence 唯一绑定、writer cursor、或「所有 unjournaled tail 必 broken」。

### 2.3 明确不防 / 不宣称

1. 无 external anchor / HMAC / signature 时的 authenticity / 防篡改 / 合规审计链完成
2. retention 删除**已获授权**（仅结构兼容）
3. uncovered/legacy 前缀内的 mutation（声明覆盖范围外）
4. 双文件一致重写 / 一致 suffix 截断 / 新 generation 配对替换
5. journal-only 四类 V1.35 limitation（suffix rewrite / tail truncation / events-only **对 journal verify** / full replace）**仍成立**
6. **production detects**（无 production caller）
7. multi-process 读写锁正确性
8. **replay-shaped suffix ambiguity**：`E = legacy + J + J`（未入链尾完整重放整段 J）时，纯 payloadDigest 值序列把最后一个 J 识别为 journal 后缀 → `partial/journal-suffix-of-events`；**无法**区分两个相同 occurrence。精心构造的重复 digest 序列同理可制造 suffix 歧义。V1.36 **无** writer cursor / baseline / unique occurrence binding，**不得**宣称检测所有 unjournaled tail

### 2.4 与 V1.35 能力叠加（强制诚实）

```text
V1.35 journal verify:
  + 内部结构自洽
  − events-only mutation 不可见
  − suffix rewrite / tail truncation / full replace 不可见

V1.36 cross-store verifier (explicit call only):
  + linked overlap 内 events↔journal payloadDigest 序列错位可见
  + retention-compatible suffix 显式 relationship
  + legacy uncovered 显式 partial
  + 普通非 suffix 未入链尾 / 错位 → broken（逐项）
  − 仍无 authenticity / 双一致重写检测 / production auto-detect
  − V1.35 journal-only limitations 不因本版消失
  − 无 cursor/occurrence binding → replay-shaped suffix ambiguity 可能 partial 而非 broken
```

---

## 3. 冻结序列语义与真值表

### 3.1 定义

```text
J = 在 journal 已通过内部 structure verify 之后，
    按文件顺序提取的所有 recordKind==='event-link' 的 payloadDigest 数组
    （不含 generation-open；generation-open.payloadDigest 恒为 null，不进入 J）

E = 对当前 audit/events.jsonl 按文件顺序解析出的每一行，
    使用 projectStrictCanonicalSanitizedEvent + stringifyStrictCanonicalSanitizedEvent
    得到 canonical UTF-8 后，经与 append 完全相同的
    computeAuditIntegrityEventPayloadDigest 得到的 payloadDigest 数组

比较 primitive（强制）:
  - 完整逐项 digest 相等 / 非空 suffix 关系
  - 禁止 set / multiset / includes / 只比 head / 只比 count
  - 判定顺序（精确；不得省略 uncovered 分支写 “otherwise broken”）:
      1. both empty（1a/1b）
      2. exact equal nonempty
      3. E nonempty proper suffix of J
      4. J nonempty proper suffix of E
      5. J empty && E nonempty → partial/uncovered-events
      6. else broken
  - 禁止用「空数组是任意数组的后缀」数学规则掩盖 events 丢失
```

### 3.2 真值表（完整）

| # | 条件 | HTTP/结果 | `state` | `relationship` | counts / meta |
| --- | --- | --- | --- | --- | --- |
| 1a | **无 journal**（exact `AUDIT_INTEGRITY_NOT_INITIALIZED`）**且** 无 events / events 空 → `J=[] && E=[]` | success | `verified` | `empty` | matched=0, uncovered=0, journalEventCount=0, retained=0；**`generationId===null` 且 `headDigest===null`** |
| 1b | journal **仅** generation-open（0 条 event-link）**且** events 空/缺失 → `J=[] && E=[]` | success | `verified` | `empty` | matched=0, uncovered=0, journalEventCount=0, retained=0；**`generationId`/`headDigest` 来自 open，均非 null**（不得因 empty 丢弃 open 身份） |
| 2 | `J===E` 且 `J.length>0`（逐项） | success | `verified` | `equal` | matched=J.length, uncovered=0；meta 来自 journal snapshot |
| 3 | `E` 是 `J` 的**非空后缀** 且 `J.length>E.length` | success | `verified` | `events-suffix-of-journal` | matched=E.length, uncovered=0 |
| 4 | `J` 是 `E` 的**非空后缀** 且 `E.length>J.length` | success | `partial` | `journal-suffix-of-events` | matched=J.length, uncovered=E.length−J.length |
| 5 | `J=[] && E.length>0`（含 journal missing → J=[]，或仅 open） | success | `partial` | `uncovered-events` | matched=0, uncovered=E.length；missing→meta null；仅 open→meta 来自 open |
| 6 | `J.length>0 && E=[]`（含 events missing 视作空） | **throw** | — | — | `audit-integrity-cross-store-broken` |
| 7 | 其它（**普通非 suffix** 未入链尾 U、overlap mutation/delete/reorder/insert、非 suffix 错位、prefix-only 等） | **throw** | — | — | `audit-integrity-cross-store-broken` |
| — | **replay-shaped suffix ambiguity**（见 §11.1）：如 `E = legacy + J + J`（未入链尾完整重放整段 J）→ 纯值序列把**最后一个** J 识别为 journal 后缀 | success | `partial` | `journal-suffix-of-events` | matched=J.length, uncovered=E.length−J.length；**非** broken；属明确 limitation |

**真值 #1 两分支（强制）：** `relationship:'empty'` 时 **一律** `state:'verified'` 且 counts 全 0；差别**仅**在 open 身份是否存在——1a 无 journal 身份（双 null）；1b 保留 generation-open 的 `generationId`/`headDigest`，**禁止**把 1b 压成“丢 open 身份的空”。

### 3.3 Suffix 精确定义

```text
isNonEmptySuffix(short, long):
  short.length > 0
  AND long.length > short.length
  AND for i in 0..short.length-1:
        short[i] === long[long.length - short.length + i]

isExactEqual(a, b):
  a.length === b.length
  AND for i in 0..a.length-1: a[i] === b[i]
  （空数组 exact equal 由规则 1 单独处理，避免与 suffix 混淆）
```

**解释合同：**

| relationship | 只允许解释为 | 禁止解释为 |
| --- | --- | --- |
| `empty` | 两边当前皆无 event payload | 系统从未写过审计 / 已 purge 获授权 |
| `equal` | 当前窗口逐项 digest 一致 | authenticity / 防篡改 |
| `events-suffix-of-journal` | retention-compatible 当前窗口结构兼容 | 删除已授权 / 历史真实 |
| `journal-suffix-of-events` | journal 覆盖 E 的尾部；前缀未覆盖 | 前缀已验证 / 可忽略前缀 mutation |
| `uncovered-events` | 无 journal event-link 覆盖 | verified coverage |

### 3.4 状态机（只读）

```text
                    read journal snapshot
   START ─────────────────────────────────► JOURNAL_OK (J, meta)
     │                                         │
     │ other journal errors (broken/bounds/io/…) │ only exact NOT_INITIALIZED → J=[], meta null
     │                                         │ success only-open → J=[], meta from open
     ▼                                         ▼
   THROW (journal typed codes; NOT swallowed)  read+parse events → E
                                               │
                         events io/bounds/invalid
                                               ▼
                                         THROW (cross-store typed)
                                               │
                                         classify rel(J,E)
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    ▼                          ▼                          ▼
              verified receipt           partial receipt            THROW cross-store-broken
              (1a,1b,2,3)                (4,5)                      (6,7)
```

**无写边：** 不创建 queue、不 append、不 atomic rewrite、不 repair。

---

## 4. 模块与 API 边界

### 4.1 文件图（实现后）

```text
src/
  audit-integrity-journal.js     [MOD] + @internal 只读导出（inspect + payload digest SoT）
  audit-integrity-cross-store.js [NEW] 只读 verifier + events 严格解析 + 关系分类
  audit-event-schema.js          [不变] strict projection/stringify SoT
  audit-log.js                   [不变] 禁止 import journal / cross-store
  error-codes.js                 [MOD] + cross-store 新码；closed-set 51→N
  version.js                     [MOD 仅 C4] → V1.36
  gold-readiness.js              [MOD 仅 C4] evidence/nextStep 诚实
README.md                        [MOD 仅 C4] V1.36 边界

test/
  audit-integrity-journal.test.js          [MOD] inspect/digest 导出合同
  audit-integrity-cross-store.test.js      [NEW] 关系/parser/receipt/errors/limitations
  audit-integrity-cross-store-scans.test.js[NEW] isolation/honesty/hostile
  error-codes.test.js                      [MOD] closed-set
  version / gold / temporal                [MOD 仅 C4]
```

### 4.2 Import closed set

```text
audit-integrity-journal.js
  MAY import: safe-data-files, error-codes, audit-event-schema
  MUST NOT import: audit-log, audit-integrity-cross-store, server, agent, capability-audit-sink

audit-integrity-cross-store.js
  MAY import: safe-data-files, error-codes, audit-event-schema (projectStrict/stringifyStrict),
              audit-integrity-journal (仅只读 helpers + 路径/常量若需要)
  MUST NOT import: audit-log, server, agent, capability-audit-sink

audit-log.js / server.js / agent.js / capability-audit-sink.js
  MUST NOT import: audit-integrity-journal, audit-integrity-cross-store
```

### 4.3 Journal 最小 `@internal` 只读导出

**不得**复制 `DOMAIN_EVENT_PAYLOAD` / `verifyRawJournal` / line parser 到 cross-store。

#### 4.3.1 `computeAuditIntegrityEventPayloadDigest(strictEvent)`

```js
/**
 * @internal SoT — identical domain/canonical path as appendAuditIntegrityEvent write-time digest.
 * @param {unknown} strictEvent already strict-acceptable event (no sanitize defaults)
 * @returns {string} 64 lowercase hex
 * @throws AuditIntegrityJournalError(AUDIT_INTEGRITY_EVENT_INVALID) on strict failure
 */
export function computeAuditIntegrityEventPayloadDigest(strictEvent)
```

**语义：**

1. `canonical = stringifyStrictCanonicalSanitizedEvent(strictEvent)`（内部已 projectStrict）
2. `return SHA256(DOMAIN_EVENT_PAYLOAD + canonical).hex`
3. **不**调用 `sanitizeAuditEvent`；**不**发明 id/time
4. 与 `appendAuditIntegrityEvent` 使用**同一私有** `eventPayloadDigest` 实现（export 为薄包装，禁止分叉公式）

#### 4.3.2 `inspectAuditIntegrityJournalFile(root, options?)`

```js
/**
 * @internal read-only snapshot after full structure verify (same parser as verify).
 * @returns {Promise<{
 *   generationId: string,
 *   headDigest: string,
 *   recordCount: number,   // includes generation-open
 *   eventCount: number,    // event-link count === payloadDigests.length
 *   payloadDigests: string[]  // deep-copied + frozen; event-link order only
 * }>}
 */
export async function inspectAuditIntegrityJournalFile(root, options = {})
```

**语义：**

1. 复用 `verifyRawJournal` 同一路径：read maxBytes → bounds → parse → structure
2. 成功后从已解析 records 提取 event-link 的 `payloadDigest` 序列 → `J`
3. **不**返回 raw records、文件 path、event body、linkDigest 列表（head 除外）
4. **不**入写队列（与 `verify` 相同只读）
5. 结构失败 / bounds / io / not-initialized：**抛出与 `verifyAuditIntegrityJournalFile` 相同的 journal 错误码**（由 cross-store **仅**把 exact `AUDIT_INTEGRITY_NOT_INITIALIZED` 映射为 J 空；**其它错误原样 typed 传播**）
6. **`payloadDigests` 必须 deep-copy 后再 `Object.freeze`（或等价不可变副本）**：
   - 调用方 `push`/`[i]=` 不得污染模块内部数组
   - 不得返回内部可变数组引用
   - 测试必须覆盖：返回后 mutation 不影响再次 inspect；options 含 hostile getter/Proxy 不得通过共享引用改写 snapshot

**public `verifyAuditIntegrityJournalFile` 行为不变**（receipt 仍仅 `state/generationId/recordCount/headDigest`）。

### 4.4 Public cross-store API

```js
export const AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH = 'audit/events.jsonl'; // 字面量常量；不从 audit-log import
// bounds constants — 见 §6

export class AuditIntegrityCrossStoreError extends Error {
  // message === code; name fixed; code registered only; path-free
}

/**
 * Read-only retention-aware structural relationship check J ↔ E.
 * @param {string} root
 * @param {{ deps?: SafeDataFileDeps }} [options]
 * @returns {Promise<CrossStoreReceipt>}
 */
export async function verifyAuditIntegrityAgainstEventStore(root, options = {})
```

**步骤（冻结）：**

```text
1) assertSafeDataRoot(root) → io 失败 map cross-store-io-error
2) journal 侧：
   try inspectAuditIntegrityJournalFile(root)
   catch ONLY if code === AUDIT_INTEGRITY_NOT_INITIALIZED
        → J=[], generationId=null, headDigest=null,
          journalRecordCount=0, journalEventCount=0
   catch other journal errors
        → rethrow as-is / 设计固定 typed 映射（chain-broken / bounds / io / event-invalid / …）
        → 禁止把 broken/io/bounds 吞成 J=[] 或 empty receipt
   on success (含仅 generation-open)：
        → J=payloadDigests（可能 length 0）, generationId/headDigest/recordCount 来自 snapshot
        → journalEventCount === J.length（仅 open 时为 0；不得丢 open 身份）
3) events 侧：
   safeReadText(root, 'audit/events.jsonl', { maxBytes: EVENTS_MAX_PRE_READ })
   ENOENT → raw 视作 empty → E=[]
   size/stat/permission/SafeDataFileError → cross-store-io-error
   parseEventsToPayloadDigests(raw) → E 或 throw（§5）
4) classifyRelationship(J, E, meta) → receipt 或 throw cross-store-broken
   （empty 时按 1a/1b 填 generationId/headDigest）
5) 全程不写任何路径；不建立 queue
```

**options：** V1.36 仅允许只读 deps 注入（测试）；**禁止** options 关闭 fail-closed、放宽 strict、传入预计算 digest 绕过解析；options 若含 hostile getter/Proxy，**不得**通过共享可变结构改写 receipt/snapshot。

---

## 5. Events 解析合同（fail-closed；≠ audit-log 宽松读）

### 5.1 路径与缺失

```text
RELATIVE_PATH = 'audit/events.jsonl'
missing (ENOENT) → E = []   // 不是 io-error
empty file raw === '' → E = []
```

**注意：** `readAuditEvents` 忽略坏行的语义 **不得** 复用。

### 5.2 非空文件解析算法

对已读入 UTF-8 `raw`（size 已在 read 层 ≤ max pre-read；超限已在 P1 以 **io** 抛出）：

```text
1) 若 raw === '' → E=[]（success path；交关系分类）
2) 为做 bounds 检查：若 raw.endsWith('\n') 则 body=raw.slice(0,-1) 否则 body=raw
   lines = body === '' ? [] : body.split('\n')
   // 注意：此处仅用于计数/按行量字节；最终仍要求非空文件带 final newline
3) 若 lines.length > MAX_EVENT_LINES → bounds-exceeded
4) 对每个 line：若 Buffer.byteLength(line,'utf8') > MAX_EVENT_LINE_BYTES
     → bounds-exceeded   // JSON.parse 前；先于 newline/JSON
5) 若 !raw.endsWith('\n') → event-invalid
   （坏尾；与 journal 坏尾同严格，但码为 cross-store-event-invalid）
6) 若任一 line === ''（含 interior blank）→ event-invalid
7) 对每个 line index i：
   7a) JSON.parse；失败 → event-invalid
   7b) 拒绝：null / 非 object / Array / Proxy / 非 plain prototype
       / symbol keys / accessor / extra keys / 类型不符
       → 一律经由 projectStrictCanonicalSanitizedEvent 失败 → event-invalid
   7c) canonical = stringifyStrictCanonicalSanitizedEvent(parsed)
       若 canonical !== line（byte-equal）→ event-invalid
       // 禁止“读入后重新 sanitize 再比”；禁止补 id/time 修复存量
   7d) digests.push(computeAuditIntegrityEventPayloadDigest(projectedOrParsed))
8) 返回 E = digests
```

**强制：**

- **只**使用 shared `projectStrict…` / `stringifyStrict…`
- **禁止**调用 `sanitizeAuditEvent` 修复缺 id/time 的存量行
- 存量若不是 strict canonical 落盘形态 → **event-invalid**（honest：历史宽松写入可能无法通过 cross-store，直至 rewrite/dual-write 时代）

### 5.3 错误优先级（events 侧 first-throw）

同一文件可能多条件，**按下列顺序 first-throw**（实现与测试锁定）：

```text
P0 root/assertSafeDataRoot 失败          → audit-integrity-cross-store-io-error
P1 file stat size > 16 MiB / safeReadText size>maxBytes / 非 regular / 权限 / 其它 SafeDataFileError
                                         → audit-integrity-cross-store-io-error
   （ENOENT 不走 P1，映射 empty）
   // I/O size cap 先于任何行解析；与 bounds 分层
P2 成功读入后：lines.length > MAX_EVENT_LINES
                                         → audit-integrity-cross-store-bounds-exceeded
P3 成功读入后：任一 line UTF-8 > MAX_EVENT_LINE_BYTES（JSON.parse 前）
                                         → audit-integrity-cross-store-bounds-exceeded
P4 非空且缺 final newline                → audit-integrity-cross-store-event-invalid
P5 interior/blank empty line             → audit-integrity-cross-store-event-invalid
P6 JSON.parse 失败 / 非 plain / strict 失败 / re-stringify ≠ line
                                         → audit-integrity-cross-store-event-invalid
```

**优先级一句话（强制）：**
`file stat size > 16 MiB → io`；成功读入后 `line > 16050` 或 `lines > 8192 → bounds`；然后 `newline / JSON / canonical → event-invalid`；关系错位 → `broken`。

**Journal 侧**错误在步骤 2 已先处理：

- **仅** exact `AUDIT_INTEGRITY_NOT_INITIALIZED` → 转为 J=[] / meta null（继续）
- journal `chain-broken` / `bounds-exceeded` / `io-error` / 其它 typed **原样抛出**（不改码、不吞成 empty），保证 journal 损坏不被 cross-store 关系层掩盖

**关系层**仅在 J/E 均成功物化后：

```text
P7 rel ∈ {6,7} → audit-integrity-cross-store-broken
```

### 5.4 Journal vs Events 错误分工

| 条件 | code |
| --- | --- |
| journal 不存在（exact `AUDIT_INTEGRITY_NOT_INITIALIZED`） | **不抛**；J=[]；meta null |
| journal 仅 generation-open | **不抛**；J=[]；meta 来自 open |
| journal 存在但结构坏 | `audit-chain-broken`（journal）**原样** |
| journal bounds / per-line | `audit-integrity-bounds-exceeded`（journal）**原样** |
| journal size/io | `audit-integrity-io-error`（journal）**原样** |
| events 不存在 | **不抛**；E=[] |
| events size/io | `audit-integrity-cross-store-io-error` |
| events bounds（line/lines） | `audit-integrity-cross-store-bounds-exceeded` |
| events 行 invalid | `audit-integrity-cross-store-event-invalid` |
| 关系 6/7 | `audit-integrity-cross-store-broken` |

---

## 6. Bounds 证明（必须可复算；禁止拍脑袋）

### 6.1 为何旧 ASCII/`MAX_SAFE_INTEGER` 推导错误

旧推导用 `'a'.repeat(200)` + safe integer 估单行，**漏算** strict schema 合法极值：

| 因素 | 事实 |
| --- | --- |
| strict string | 可合法含 **NUL**（`\u0000`）或 **lone surrogate**；`sanitizeString` **不会**移除 NUL |
| `JSON.stringify` | 每个 JS code unit 最坏可编码为 **6** ASCII bytes（`\uXXXX`） |
| strict integer | 只要求 `Number.isInteger`；**`Number.isInteger(Number.MAX_VALUE) === true`**，JSON 表示 `1.7976931348623157e+308` 远长于 safe integer |
| `statusCode` vs non-negative | **`statusCode` 允许负数** → canary 必须用 **`-Number.MAX_VALUE`**（JSON 多一个 `-`，比正 MAX 长 1）；**`fileCount` / `totalBytes` / `verifiedFileCount` / `retryCount` 为 non-negative integer** → 只能用 **`Number.MAX_VALUE`（正）** |
| canonical Date | 必须是 **`Date#toISOString()` exact roundtrip** 的 extended year（27 字符）。示例：`+275760-09-13T00:00:00.000Z` 可用；**带前导 `+` 的零填充四位年**不可用（`toISOString()` 会去掉扩展年形态，strict 必拒） |

**当前 schema 实测（PM 运行锁定；实现 canary 复算）：**

```text
// buildMax 布局（冻结）：
//   createdAt = "+275760-09-13T00:00:00.000Z"  // assert toISOString() === self
//   statusCode = -Number.MAX_VALUE              // 负 MAX（多一个 minus）
//   fileCount/totalBytes/verifiedFileCount/retryCount = Number.MAX_VALUE  // 正 MAX only
//   12 string fields = fill.repeat(200)

ascii fill + above extrema                         ≈  3050   // ASCII canary ≠ max
200 NUL / string field + above extrema             = 16050   // max-line canary A
200 lone surrogate / string field + above extrema  = 16050   // max-line canary B（独立）
100 emoji (200 code units) / field                 ≈  5650
Number.isInteger(Number.MAX_VALUE)                 = true
JSON.stringify(Number.MAX_VALUE)                   = "1.7976931348623157e+308"
JSON.stringify(-Number.MAX_VALUE)                  = "-1.7976931348623157e+308"
new Date("+275760-09-13T00:00:00.000Z").toISOString() === self  // roundtrip true
```

因此 **per-line cap 必须取 16050**（不含 newline），并用 **NUL 与 lone-surrogate 两个独立 canary** 证明；**ASCII canary 不是 max**。
达到已冻结 **16050** 时：**`statusCode` 必须是 `-Number.MAX_VALUE`**；其它四个 non-negative integer 字段用 **`Number.MAX_VALUE`**；extended date 必须 **canonical roundtrip**（禁止带前导 `+` 的零填充四位年等非 canonical 填充）。

### 6.2 三独立防护（禁止用 floor 互推）

```text
size cap      = AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES   // I/O
per-line cap  = AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES        // 单行 UTF-8
line-count cap= AUDIT_CROSS_STORE_MAX_EVENT_LINES             // CPU / 序列比较
```

**强制：**

1. **不得**再用 `floor(preReadBytes / (maxLineBytes+1))` 推导 line-count
2. 合法文件 **不要求**每行同时达到 max-line；三 cap 独立 fail-closed
3. line-count **不是** retention，也 **不是**磁盘容量公式

### 6.3 为何不能照搬 journal 1.5 MiB

journal pre-read `1_572_864` 面向短 journal 行（≤374）。events 行可达 **16050** UTF-8 bytes；1.5 MiB 装不下合理 equal/retention 窗口所需的多行 events 读取。
故 events 侧 pre-read **对齐** `safeReadText` 默认 **16 MiB**（`16_777_216`）。

### 6.4 选定常数（冻结）

```text
AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH      = 'audit/events.jsonl'
AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES = 16_777_216
  // = safe-data-files DEFAULT_MAX_READ_BYTES (16 MiB)；I/O size cap
AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES      = 16050
  // JSON.parse 前 per-line UTF-8；不含 newline
  // 由 NUL canary 与 lone-surrogate canary 各自独立证明
AUDIT_CROSS_STORE_MAX_EVENT_LINES           = 8192
  // CPU / 序列比较上限（独立常数；非 floor 推导）
  // 覆盖 journal 最多 4096 event-link 的 equal / retention 场景
  // 并为 journal-suffix-of-events 提供最多 4096 legacy-prefix headroom
  // 不是 retention；不是磁盘容量公式
```

### 6.5 分层诚实性（16 MiB × max-line）

```text
8192 × (16050 + 1)  ≫  16_777_216
  → 若每行皆 max-line，会先触 16 MiB I/O cap → cross-store-io-error
  → 这是预期分层，与 line-count=8192 不矛盾

4096 × (16050 + 1)  ≫  16_777_216
  → 同样：不得宣称「满载 4096 条 max-event 行一定可读」
  → 正确合同：4096 条 event **只要总文件 ≤ 16 MiB** 即可进入核验；
     若总文件 > 16 MiB → io-error（先于 bounds/关系）
  → equal / retention / journal-suffix 场景用**典型短行**或总字节可控的 fixture 覆盖，
     不依赖「每行 16050 × 4096 全装入」
```

实现 plan **C2 RED** 必须：

1. 常量锁：`MAX_EVENT_LINE_BYTES === 16050`、`MAX_EVENT_LINES === 8192`、`MAX_PRE_READ === 16_777_216`
2. **两个独立** max-line canary：全字符串字段 NUL 串 / lone-surrogate 串 + **`statusCode: -Number.MAX_VALUE`** + 四个 non-negative 字段 **`Number.MAX_VALUE`** + canonical extended date `+275760-09-13T00:00:00.000Z` → `byteLength === 16050`
3. ASCII canary（`'a'.repeat(200)` 等）**断言严格小于 16050**（证明 ASCII 非 max）
4. `Number.isInteger(Number.MAX_VALUE) === true`；锁定 `JSON.stringify(Number.MAX_VALUE)` 与 `JSON.stringify(-Number.MAX_VALUE)`；assert extended date `toISOString()` roundtrip exact
5. 若 schema 变更导致 16050 漂移 → **先改设计常数**再实现

### 6.6 size vs bounds vs relationship（对齐分层）

| 上界 | 触发 | code |
| --- | --- | --- |
| file size > 16 MiB | `safeReadText` / stat maxBytes | **cross-store-io-error** |
| 成功读入后 lines > 8192 或 line > 16050 | 解析层 | **cross-store-bounds-exceeded** |
| newline / JSON / strict / canonical mismatch | 解析层 | **cross-store-event-invalid** |
| 结构/关系 | rel 6/7 或 journal chain | **cross-store-broken** / **audit-chain-broken** |

Journal 侧仍用 V1.35：`1.5 MiB` / `4097` / `374`。

### 6.7 与 retention 的关系

- line-count **不是**产品 retention
- retention compact 保留后缀 → 关系 3（verified suffix）
- 8192 的 4096+4096 headroom 支持 `journal-suffix-of-events` 下 E 可长于 J 的 legacy 前缀窗口（在总文件 ≤16 MiB 前提下）
- 本版 **不**实现 rotation/repair

---

## 7. Receipt schema

### 7.1 Success allowlist（无 `ok`）

```js
{
  state: 'verified' | 'partial',
  relationship:
    'empty' |
    'equal' |
    'events-suffix-of-journal' |
    'journal-suffix-of-events' |
    'uncovered-events',
  generationId: string | null,  // 32 hex；1a missing→null；1b only-open→from open
  headDigest: string | null,    // 64 hex；1a missing→null；1b only-open→from open
  journalEventCount: number,    // === J.length ≥ 0（only-open 时为 0）
  retainedEventCount: number,   // === E.length ≥ 0
  matchedEventCount: number,    // ≥ 0
  uncoveredEventCount: number,  // ≥ 0
}
```

**禁止字段：** `ok`、path、raw event、payload body、完整 `J`/`E` 数组、secret、errno。

### 7.2 Count 公式（强制）

| relationship | matched | uncovered | journal | retained |
| --- | --- | --- | --- | --- |
| `empty` | 0 | 0 | 0 | 0 |
| `equal` | J.length | 0 | J.length | E.length（=J） |
| `events-suffix-of-journal` | E.length | 0 | J.length | E.length |
| `journal-suffix-of-events` | J.length | E.length−J.length | J.length | E.length |
| `uncovered-events` | 0 | E.length | 0 | E.length |

全部 count 为 **non-negative integer**；`matched + uncovered === retained` 在 `journal-suffix-of-events` 与 `uncovered-events` 成立；`equal`/`events-suffix`/`empty` 下 `uncovered===0`。

### 7.3 state 约束

```text
state === 'verified'  ⇔ relationship ∈ { empty, equal, events-suffix-of-journal }
state === 'partial'   ⇔ relationship ∈ { journal-suffix-of-events, uncovered-events }
throw                 ⇔ 无 receipt
```

---

## 8. 错误码 registry

### 8.1 新增码（closed-set）

**当前：** 51
**新增 4：**

```js
AUDIT_INTEGRITY_CROSS_STORE_BROKEN:          'audit-integrity-cross-store-broken',
AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR:        'audit-integrity-cross-store-io-error',
AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED: 'audit-integrity-cross-store-bounds-exceeded',
AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID:   'audit-integrity-cross-store-event-invalid',
```

```text
计数：51 → 55（existing 51 + 4）
```

### 8.2 分类

| 类 | code | 何时 |
| --- | --- | --- |
| 关系/跨库结构 | `audit-integrity-cross-store-broken` | 真值表 6/7 |
| Events I/O | `audit-integrity-cross-store-io-error` | root/size/permission/SafeDataFileError（events 路径） |
| Events bounds | `audit-integrity-cross-store-bounds-exceeded` | lines/per-line only |
| Events invalid | `audit-integrity-cross-store-event-invalid` | 坏尾/空行/JSON/strict/canonical mismatch |
| Journal 既有 | `audit-chain-broken` / `audit-integrity-io-error` / `bounds-exceeded` / … | inspect 失败原样 |

**规则：**

1. `error.message === error.code`
2. path-free；不附加 cause 可枚举泄漏
3. `EXPECTED_ERROR_CODES` **全表** + 计数 **51→55**
4. **禁止**把 size 超限映射为 bounds；**禁止**把关系失败映射为 event-invalid

### 8.3 Failure matrix（摘要）

| 条件 | 结果 |
| --- | --- |
| 双方空（1a missing / 1b only-open） | verified / empty（meta 见 §3.2） |
| 逐项 equal 非空 | verified / equal |
| E 非空后缀 of J | verified / events-suffix-of-journal |
| J 非空后缀 of E | partial / journal-suffix-of-events |
| J 空 E 非空 | partial / uncovered-events |
| J 非空 E 空 | **cross-store-broken** |
| overlap 错位 / 普通非 suffix 未入链尾 U | **cross-store-broken** |
| replay-shaped `E=…+J+J` 等 suffix 歧义 | **partial** journal-suffix（limitation；非 broken） |
| events 缺尾 `\n` / JSON / canonical | event-invalid |
| events 成功读入后 line>16050 或 lines>8192 | bounds |
| events size>16MiB | io-error |
| journal 断链 / bounds / io | journal typed **原样**（不吞 empty） |
| journal missing（exact NOT_INITIALIZED） | J=[] 继续 |

---

## 9. 并发与中间态

```text
V1.36:
  - verifier 完全 read-only；无 queue（不建立 auditIntegrityCrossStoreQueues）
  - 不与 auditIntegrityJournalQueues / auditFileQueues 联动
  - 并发只读无锁；与 writer 并发不提供 isolation 保证
  - 与 writer 并发导致瞬态 broken / event-invalid / io 是**允许的 fail-closed**
  - 诚实边界：可 fail-closed；**禁止**返回 partial/verified 掩盖错位中间态
      （例：半行被宽松跳过 → 错误 suffix/partial 假绿）
  - 不得用重试/宽松解析/set 比较掩盖中间态
  - V1.37：同一 root write queue 下 dual-write + 本 verifier 作 preflight/reconcile
```

---

## 10. Retention / migration / legacy

| 场景 | 期望 |
| --- | --- |
| 启用 maxEvents compact 后 E 为 J 后缀 | verified / events-suffix-of-journal |
| journal 从某代开始写，历史 events 更长 | partial / journal-suffix-of-events |
| 仅有 events、从未 init journal | partial / uncovered-events |
| 仅有 journal event-links、events 被删光 | **broken** |
| 历史 events 非 strict canonical（宽松 sanitize 落盘） | event-invalid（不静默修复） |
| V1.35 已存在 journal + 手动对齐的 events | equal 或 suffix/partial 依数据 |

**迁移策略（文档 only）：** V1.36 不提供自动 rewrite；生产 dual-write 属 V1.37。

---

## 11. Honest limitations（测试必须 PASS = success/partial，不准假装 broken）

下列场景 **必须**有测试，且断言 **success 或 partial**（或 journal-only 路径 success），**禁止**写成 expect broken：

1. **合法 retention suffix** → `verified` + `events-suffix-of-journal`
   - 不证明删除授权
2. **legacy/uncovered 前缀** → `partial` + `journal-suffix-of-events` 或 `uncovered-events`
   - 前缀内 mutation **不在**覆盖声明内；测试可另证：只改前缀仍 partial（非 broken）
3. **同时重写 events+journal 并重算到 EOF 一致** → 可 `verified`/`equal`
4. **两边截成一致 suffix** → 可 `verified`
5. **两文件 full replacement / new generation 且 digests 对齐** → 可 `verified`
6. **SHA-256 ≠ authenticity / 防篡改**
7. **V1.35 四类 journal-only limitation 仍成立**（journal verify success）
8. **V1.36 仅使 linked overlap 的 events-only mismatch 在显式 verifier 调用时可见**
9. **无 production caller → 不得写 “production detects”**
10. **replay-shaped full-J replay（§11.1）** → `partial` + `journal-suffix-of-events`（**禁止** expect broken）

### 11.1 Replay-shaped suffix ambiguity（强制 honest）

```text
若 E = legacy + J + J（未入链尾完整重放整段 J 的 payloadDigest 值序列）：
  - 纯值序列 index-by-index 会把**最后一个** J 识别为 journal 的非空后缀
  - 结果：partial / journal-suffix-of-events
  - counts（E = J+J，无额外 legacy 时）：matched = J.length，uncovered = J.length
  - 无法区分「两个相同 occurrence」；V1.36 无 writer cursor / baseline / unique occurrence binding
  - 同理：精心构造的重复 digest 序列可制造 suffix 歧义
  - 不得宣称：所有 unjournaled tail → broken
  - 签字仍只结构关系；关闭本歧义属 V1.37+（durable cursor / idempotency / occurrence binding）
```

**对比（冻结算法真值，禁止为 hostile 测试违背）：**

| 序列 | 是否 suffix？ | 期望 |
| --- | --- | --- |
| `J=[x,x,y]`，`E=[x,y]` | **是**（E 为 J 非空后缀；末两项 `[x,y]`） | **verified** `events-suffix-of-journal` |
| `J=[x,y,x]`，`E=[x,x]` | **否**（J 末两项实际 `[y,x]` ≠ `[x,x]`） | **broken**（hostile canary） |
| `J=[x,y]`，`E=[x,y,x,y]`（E=J+J） | **是**（J 为 E 非空后缀） | **partial** `journal-suffix-of-events`；matched=2, uncovered=2 |

**Hostile canaries（必须 broken / 不得假绿）：**

| canary | 期望 |
| --- | --- |
| E 是 J 的**前缀**非后缀（非空） | broken |
| 仅 count 相同、head 相同、中间不同 | broken |
| 重复 digest **真实非 suffix**：`J=[x,y,x]`，`E=[x,x]`（末两项 `[y,x]`≠`[x,x]`）仍逐项比 | broken |
| 空 J + 非空 E 不得因「空后缀」变 verified | partial uncovered-events |
| 非空 J + 空 E 不得当 empty/suffix | broken |
| set 相等但顺序不同 | broken |

**正向 canary（必须 verified suffix；证明重复值本身不破坏 index-by-index suffix）：**

| canary | 期望 |
| --- | --- |
| `J=[x,x,y]`，`E=[x,y]`（E 确为 J 非空后缀） | **verified** `events-suffix-of-journal`；**禁止**写成 broken/非 suffix |

---

## 12. 安全 / scan 锁

1. import closed set（§4.2）源码扫描
2. 零 production wiring：`server`/`agent`/`audit-log`/`capability-audit-sink` 不得出现 cross-store / inspect 新导出调用
3. **禁止**完整 forbidden compound 字面量（前缀 `tamper-` 与后缀 `evident` 相邻）；测试 needle **runtime 两段拼接**
4. honesty clause scan：`production integration` / `automatic next generation` / `T6d.3 complete` / `M6d Exit` / `production detects` 仅允许同 clause negative/BLOCKED
5. 测试 **仅** `mkdtemp(join(tmpdir(), …))`
6. 错误 JSON/message 无绝对 path / errno 文本 / secret
7. receipt 无 raw event
8. inspect `payloadDigests` deep-copy + freeze；mutation / hostile options 测试


---

## 13. Gold / temporal / version 边界

| Flag / 项 | V1.36 值 |
| --- | --- |
| `LINKE_RELEASE_VERSION` | 实现+测试绿后 **`V1.36`** |
| Gold overall | **blocked** |
| ready / partial / blocked / total | **4 / 4 / 1 / 9** |
| `production-hardening` | **partial**（不 ready） |
| T6d.3 | **仍 partial**（+ cross-store verifier；**非** complete） |
| M6d Exit | **否** |
| production dual-write / integration | **否** |
| 签字上限 | `V1.36 audit event/journal cross-store structural consistency verifier implementation` |
| M1 Exit audit markdown | **不改**（历史 snapshot） |

README / Gold 若提本版，必须含：

- cross-store **structural consistency verifier**（只读）
- T6d.3 **partial** only
- not dual-write / not M6d Exit / not production-hardening ready / not Gold
- honest：retention suffix 仅结构兼容；双一致重写仍可能通过；无 production caller

---

## 14. V1.37 next（仅文档预留；本版不实现）

```text
V1.37（planned, not implemented here）:
  - 同一 data root 下统一 write queue（或协调 events queue + journal queue）
  - production dual-write：append event 与 append journal event-link 同临界区
  - 使用 verifyAuditIntegrityAgainstEventStore 作为：
      preflight（写前）与/或 reconcile（写后/启动）
  - 半成功边界：journal ok + events fail 等显式补偿策略
  - 同 root write queue 之外，仍需 durable cursor / idempotency /
    unique occurrence binding 设计，才能关闭 replay-shaped half-success
    （E=legacy+J+J 等 pure-value suffix 歧义 → partial 而非 broken）
  - 本版（V1.36）不承诺该 cursor/occurrence 协议；不把 partial 半成功当已关闭
  - 仍需 external anchor/HMAC/signature 才可谈更强完整性
V1.36:
  - 不实现 dual-write
  - 不承诺具体 transaction 协议已完成
  - 不承诺 durable cursor / occurrence binding / 关闭全部 unjournaled-tail 检测
  - 不接 server/agent
```

---

## 15. 风险账本

| ID | 级 | 风险 | 缓解 |
| --- | --- | --- | --- |
| R01 | P0 | 复制 digest domain 导致 append≠verify | journal 导出 SoT；禁止 cross-store 私建 DOMAIN |
| R02 | P0 | 用 set/count/head 实现 suffix 假绿 | 逐项算法 + hostile canaries |
| R03 | P0 | 空后缀掩盖 events 丢失 | 规则 6 强制 broken |
| R04 | P0 | sanitize 修复存量变 silent rewrite | 禁止 sanitize；strict+byte-equal |
| R05 | P0 | 1.5MiB 装不下合理 events 窗口；旧 ASCII 推导低估单行 | §6：16MiB I/O + 16050 line + 8192 lines 三独立 cap；NUL/surrogate canary |
| R06 | P0 | production wiring 误接 | import scan 零引用 |
| R07 | P0 | 宣称 forbidden compound / T6d.3 complete / production detects | 禁止完整字面量 + honesty scan（needle 运行时拼接） |
| R08 | P0 | 抬升 Gold / M6d Exit | C4 锁 4/4/1/9 partial |
| R09 | P0 | size 映射 bounds；或用 floor 互推行数 | 分层码表 + 独立常数 + 测试 |
| R10 | P0 | journal broken/io/bounds 被吞成 empty | 仅 exact NOT_INITIALIZED→J=[]；其它原样抛 |
| R11 | P1 | 并发中间态假绿（partial 掩盖错位） | fail-closed；禁止宽松跳行；无 queue |
| R12 | P1 | receipt 泄漏 body/path；payloadDigests 共享可变引用 | allowlist + deep-freeze 测试 |
| R13 | P1 | closed-set 只加码不改测试 | 51→55 全表 |
| R14 | P1 | 改 M1 audit 历史文档 | 明确禁止 |
| R15 | P1 | limitation 写成 expect broken | DoD + 测试名 documents-* |
| R16 | P1 | 宣称「满载 4096 max-line 可读」 | §6.5 诚实：总文件≤16MiB 才可核验 |
| R17 | P0 | 把 `J=[x,x,y],E=[x,y]`（真 suffix）写成 broken | 正向 canary + 冻结算法；hostile 用 `J=[x,y,x],E=[x,x]` |
| R18 | P0 | 把 full-J replay `E=J+J` 写成 broken / 宣称检测所有 unjournaled tail | §11.1 limitation；partial + counts；V1.37 cursor/binding |

---

## 16. 明确不实现清单（V1.36）

1. production dual-write / wiring / transaction 协议
2. init/append journal 行为变更（除只读导出）
3. repair / recovery / rotation / automatic next generation
4. external anchor / HMAC / signature / authenticity
5. public HTTP/CLI/Web/Agent
6. monitor / alert
7. 改 events schema / retention 算法
8. 从 audit-log 导出路径或复用宽松 read
9. T6d.3 complete / M6d Exit / Gold ready
10. 多进程锁

---

## 17. 测试要求（设计层）

1. 仅 `mkdtemp(tmpdir())`
2. 真值表 1a/1b–7 全覆盖（empty 双分支 meta）
3. Hostile canaries（§11）：含 `J=[x,y,x],E=[x,x]` 真实非 suffix → broken（逐项）
4. Honest limitations success/partial（§11）：含 full-J replay `E=J+J` → partial；正向 `J=[x,x,y],E=[x,y]` → verified suffix
5. Bounds 证明：16050（NUL + lone-surrogate 双 canary）；8192 line-count；16MiB I/O；三 cap 独立；禁止 floor 推导；ASCII 非 max
6. Error priority 抽样（size→io；line/lines→bounds；newline/JSON/canonical→event-invalid；关系→broken）
7. Journal inspect/digest SoT：与 append 独立重算一致；`payloadDigests` deep-freeze；hostile options
8. Isolation/honesty/forbidden-compound needle scans（runtime 拼接）
9. error-codes 51→55
10. temporal 不改 M1 markdown；C4 升 V1.36
11. journal 非 NOT_INITIALIZED 错误不吞 empty


---

## 18. 文档阶段约束

- **只允许新建**本 design 与对应 plan
- **不**改源码/测试/README/version/package-lock
- 实现阶段 commit/push 规则见 plan：**PM 按 active user 授权在每个 boundary 测试绿后精确 stage/commit/push**；永不 stage 未跟踪 `package-lock.json`
- 实现严格 TDD 与 plan commit boundaries

---

## 19. 设计验收清单

- [x] 冻结签字上限与 partial 定位
- [x] 序列语义真值表 1a/1b–7 + 禁止空后缀歧义 + empty 双分支 meta
- [x] 模块边界 / 零 wiring / SoT 导出 + payloadDigests deep-freeze
- [x] events 解析 fail-closed + 错误优先级（io→bounds→event-invalid→broken）
- [x] bounds 由 schema 实测证明（16050 NUL/surrogate / 8192 / 16MiB；三独立 cap）
- [x] journal 仅 exact NOT_INITIALIZED→J 空；其它 typed 原样
- [x] receipt allowlist + count 公式
- [x] 并发只读 fail-closed；禁止 partial 掩盖错位
- [x] honest limitations + hostile canaries（真实非 suffix；正向重复-digest suffix；full-J replay partial）
- [x] Gold/version 边界
- [x] V1.37 dual-write + cursor/occurrence binding 预留且本版不实现 / 不承诺关闭 replay-shaped half-success
- [x] 对齐 §8.3 / M6d T6d.3 partial / V1.35 foundation
- [x] 零完整 forbidden compound 字面量

**本 design 本身不提升任何 runtime flag。**
