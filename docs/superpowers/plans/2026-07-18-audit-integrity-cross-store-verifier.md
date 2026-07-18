# V1.36 Audit Event/Journal Cross-Store Structural Consistency Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 **M6d T6d.3 still-partial** 的只读、retention-aware **`audit/events.jsonl` ↔ `audit/integrity-journal.jsonl` payloadDigest 时间序列关系核验器**，关闭 linked 覆盖范围内 events-only mutation 在显式 verifier 调用下完全不可见的库级缺口；为 V1.37 production dual-write 提供可检测半成功边界。实现后仅升 **V1.36**；Gold 仍 **blocked 4/4/1/9**。

**签字上限（唯一允许的完成宣称）：**
`V1.36 audit event/journal cross-store structural consistency verifier implementation`

**不是：** T6d.3 complete / M6d Exit / production-hardening ready / production dual-write / production integration / production detects / public surface / Gold / GA / V2 / cross-LAN / forbidden compound（`tamper-`+`evident` 两段拼接；文档不写完整相邻字面量） / 防篡改 / authenticity / WORM / init-append-repair-recovery-rotation-anchor-HMAC-signature。

**Architecture:**
`audit-integrity-journal.js` 新增最小 `@internal` 只读导出（`inspectAuditIntegrityJournalFile` + `computeAuditIntegrityEventPayloadDigest`），**不** import audit-log。
`audit-integrity-cross-store.js` **只** import safe-data-files、audit-event-schema strict API、journal 只读 helpers、error-codes；完全 read-only；无 queue；无 production wiring。
比较 `J`/`E` 完整逐项 digest 关系（empty 1a/1b / equal / 非空 suffix / partial uncovered / broken）；禁止 set/count/head 假绿。

**Tech Stack:** Node.js ESM、`node:test` / `node:assert/strict`、`node:crypto` unkeyed SHA-256、现有 safe-data-files / error-codes。无新 npm 依赖。

**Design SoT:** `docs/superpowers/specs/2026-07-18-audit-integrity-cross-store-verifier-design.md`

---

## PM 冻结摘要（实现不得偏离）

```text
MILESTONE     = V1.36 = M6d T6d.3 still partial (cross-store verifier only)
SIGNATURE     = V1.36 audit event/journal cross-store structural consistency verifier implementation
NOT           = T6d.3 complete | M6d Exit | production-hardening ready | dual-write
                | production integration | production detects | Gold | forbidden compound
GOLD          = blocked 4 ready / 4 partial / 1 blocked / total 9
PATHS         = audit/events.jsonl  ↔  audit/integrity-journal.jsonl (read-only compare)
MODULE        = src/audit-integrity-cross-store.js
PUBLIC_API    = verifyAuditIntegrityAgainstEventStore(root, options?)
JOURNAL_ADD   = inspectAuditIntegrityJournalFile + computeAuditIntegrityEventPayloadDigest (@internal)
NO_WIRING     = audit-log/server/agent/capability-sink MUST NOT import journal new exports or cross-store
JOURNAL_STILL = MUST NOT import audit-log / events path / cross-store
COMPARE       = full per-item digest sequences; forbid set/multiset/includes/head-only/count-only
EMPTY_RULES   = 1a: no journal + no events → verified empty; generationId/headDigest null
                1b: journal only-open + events empty → verified empty; meta from open; journalEventCount=0
                J=[]&&E>0 → partial uncovered-events;
                J>0&&E=[] → THROW cross-store-broken (no empty-suffix loophole)
JOURNAL_MISS  = ONLY exact AUDIT_INTEGRITY_NOT_INITIALIZED → J=[]; other journal errors rethrow typed
CLASSIFY      = 1 both empty (1a/1b) → 2 exact equal nonempty → 3 E nonempty proper suffix of J
                → 4 J nonempty proper suffix of E → 5 J empty && E nonempty → partial/uncovered-events
                → 6 else broken
                // non-empty proper suffix only; MUST NOT omit uncovered and write “otherwise broken”
EVENTS_PARSE  = strict canonical only; no sanitize repair; final newline required if non-empty
BOUNDS_EVENTS = MAX_LINE=16050; MAX_LINES=8192; MAX_PRE_READ=16_777_216
                // three independent caps; NOT floor(bytes/(maxLine+1)); ASCII canary ≠ max
                // proven by NUL canary + lone-surrogate canary (each 16050)
SIZE_IO       = events size overlimit → cross-store-io-error (≠ bounds); before line parse
ERR_PRIORITY  = size>16MiB→io; then line>16050|lines>8192→bounds; then newline/JSON/canonical→event-invalid; rel→broken
ERRORS        = +4 codes; closed-set 51→55
RECEIPT       = state|relationship|generationId|headDigest|journalEventCount|
                retainedEventCount|matchedEventCount|uncoveredEventCount  (no ok)
SNAPSHOT      = payloadDigests deep-copy + freeze; no shared mutable internal array
READ_ONLY     = no queue; no writes; concurrent with writer may fail-closed (never partial masking misalign)
TESTS_ROOT    = only mkdtemp(tmpdir())
VERSION_BUMP  = only after C1–C3 green + C4 temporal
M1_AUDIT_DOC  = do not rewrite historical V1.33 snapshot markdown
FORBIDDEN_LIT = forbidden compound (prefix "tamper-" + suffix "evident"; test needle runtime-concat)
GIT_AUTH      = PM stages/commits/pushes each green boundary under active user auth; never re-ask;
                never stage untracked package-lock.json
V1.37_NEXT    = same-root write queue dual-write + this verifier preflight/reconcile;
                outside that queue still needs durable cursor/idempotency/occurrence
                binding to close replay-shaped half-success (NOT implemented / NOT promised in V1.36)
REPLAY_LIMIT  = E=legacy+J+J → partial journal-suffix (matched=J.len, uncovered=J.len when E=J+J);
                pure-value suffix ambiguity; no cursor/occurrence binding; MUST NOT claim all unjournaled tails broken
SUFFIX_TRUTH  = J=[x,x,y], E=[x,y] IS events-suffix → verified (NOT broken);
                hostile non-suffix canary: J=[x,y,x], E=[x,x] → broken (index-by-index)
```

```text
REJECTED = A embed events lookup inside journal verify | C events in-line digest
SELECTED = B independent read-only cross-store verifier
```

---

## Commit boundaries（强制）

| Boundary | Contents | Commit message（boundary 测试绿后 PM 精确 stage/commit/push） |
| --- | --- | --- |
| **C0 docs** | 仅两份 docs（design + 本 plan） | `docs: design V1.36 audit event/journal cross-store structural consistency verifier` |
| **C1 journal SoT** | inspect + payload digest export + journal 测试；**不碰** events/cross-store 生产模块 | `feat: export journal inspect snapshot and event payload digest SoT` |
| **C2 cross-store core** | 新模块 + error codes + 关系/parser/receipt 测试 | `feat: add audit event/journal cross-store structural consistency verifier` |
| **C3 hostile/scans** | hostile canaries + limitations + isolation/honesty scans | `test: cross-store verifier hostile canaries and isolation scans` |
| **C4 temporal→V1.36** | temporal 绿 → version/gold/readme honesty | `chore: release milestone V1.36 cross-store structural consistency verifier` |
| **C5 full verification** | 全量测试 + GLM/fresh reviewer（可无代码 commit；修复则 `test:`/`fix:`） | 仅在有修复时 commit/push |

**规则：**

- Never mix C0 docs-only with code。
- **PM 按 active user 授权**：每个 boundary 相关测试绿后 **精确 stage 该 boundary 文件 → commit → push**；**无需再次确认**。
- **永不** stage 未跟踪的 `package-lock.json`。
- Never bump version before C1–C3 绿。
- 每任务：精确 files、RED/GREEN 命令、期望、commit message、禁止项、回滚。
- 测试写盘 **只能** `mkdtemp(join(tmpdir(), ...))`。
- Commit message / README / Gold **禁止**完整 forbidden compound 字面量、T6d.3 complete、production detects、M6d Exit 作为已交付。

---

## Fresh review / PM gate（代码前）

- [ ] **G1:** Fresh reviewer 对照 design + 本 plan + 源码事实（journal / audit-log / schema / error-codes / §8.3 / M6d / V1.35）。
- [ ] **G2:** 确认无 P0：dual-write wiring、空后缀掩盖 events 丢失、set 假绿、sanitize 修复存量、1.5MiB 误用于 events 窗口、旧 ASCII 低估 max-line、floor 推导行数、完整 forbidden compound 字面量、T6d.3 complete、journal 非 NOT_INITIALIZED 错误吞 empty。
- [ ] **G3:** PM 记录 **implementation PROCEED**（≠ docs PROCEED）。
- [ ] **G4:** 仅此后开始 Task 0+。

若 P0：**停**；改 docs；不写代码。

---

## 全局命令约定

```bash
# journal
node --test test/audit-integrity-journal.test.js

# cross-store
node --test test/audit-integrity-cross-store.test.js

# scans
node --test test/audit-integrity-cross-store-scans.test.js

# error codes
node --test test/error-codes.test.js

# C4 诚实
node --test test/version.test.js test/gold-readiness.test.js test/cross-lan-m1-exit-audit.test.js

# 相关回归
node --test test/audit-integrity-journal.test.js test/audit-integrity-journal-scans.test.js \
  test/audit-event-schema.test.js test/audit-log.test.js test/error-codes.test.js

# 全量
npm test
```

期望计数以 **当前 suite 增量** 为准；全量必须以 exit code 0 为准。

---

## Task 0: Baseline 确认（无产品代码）

**Files:** Read only — design、本 plan、`src/audit-integrity-journal.js`、`src/audit-log.js`、`src/audit-event-schema.js`、`src/error-codes.js`、`src/version.js`、`src/gold-readiness.js`

- [ ] **Step 0.1:** 记录 baseline

```bash
node --test test/audit-integrity-journal.test.js test/audit-integrity-journal-scans.test.js \
  test/audit-event-schema.test.js test/audit-log.test.js test/error-codes.test.js test/version.test.js
```

Expected: exit 0；`LINKE_RELEASE_VERSION === 'V1.35'`；ERROR_CODES length **51**。

- [ ] **Step 0.2:** 确认无 `src/audit-integrity-cross-store.js`；journal **无** `inspectAuditIntegrityJournalFile` / `computeAuditIntegrityEventPayloadDigest` export。
- [ ] **Step 0.3:** 复算 bounds canary（文档锁定；C2 测试固化）。**禁止**用 `floor(16MiB/(n+1))` 推导行数。

```bash
node --input-type=module -e '
import { stringifyStrictCanonicalSanitizedEvent } from "./src/audit-event-schema.js";

// Canonical extended-year Date#toISOString() form (27 chars). Must roundtrip exact;
// zero-padded 4-digit years with a leading '+' are NOT canonical (toISOString drops them).
const EXTENDED_DATE = "+275760-09-13T00:00:00.000Z";
if (new Date(EXTENDED_DATE).toISOString() !== EXTENDED_DATE) {
  throw new Error("EXTENDED_DATE not canonical: " + new Date(EXTENDED_DATE).toISOString());
}
const strFields = ["type","method","path","outcome","requestId","deviceId","snapshotId",
  "operation","message","targetName","attemptId","errorCode"];

function buildMax(fill) {
  const o = {
    id: fill, createdAt: EXTENDED_DATE,
    // statusCode allows negatives → -MAX adds one JSON char (minus) to hit frozen 16050.
    // fileCount/totalBytes/verifiedFileCount/retryCount are non-negative → +MAX only.
    statusCode: -Number.MAX_VALUE,
    fileCount: Number.MAX_VALUE, totalBytes: Number.MAX_VALUE,
    verifiedFileCount: Number.MAX_VALUE, retryCount: Number.MAX_VALUE,
    wouldWrite: true, executionRequired: true,
  };
  for (const k of strFields) o[k] = fill;
  return o;
}

const ascii = "a".repeat(200);
const nul = "\u0000".repeat(200);
const loneSurrogate = "\uD800".repeat(200);
const emoji = "😀".repeat(100); // 100 emoji = 200 code units

const nAscii = Buffer.byteLength(stringifyStrictCanonicalSanitizedEvent(buildMax(ascii)), "utf8");
const nNul = Buffer.byteLength(stringifyStrictCanonicalSanitizedEvent(buildMax(nul)), "utf8");
const nSur = Buffer.byteLength(stringifyStrictCanonicalSanitizedEvent(buildMax(loneSurrogate)), "utf8");
const nEmoji = Buffer.byteLength(stringifyStrictCanonicalSanitizedEvent(buildMax(emoji)), "utf8");

console.log({
  nAscii, nNul, nSur, nEmoji,
  maxValueIsInteger: Number.isInteger(Number.MAX_VALUE),
  maxValueJson: JSON.stringify(Number.MAX_VALUE),
  negMaxValueJson: JSON.stringify(-Number.MAX_VALUE),
  roundtrip: new Date(EXTENDED_DATE).toISOString() === EXTENDED_DATE,
  locked: { MAX_LINE: 16050, MAX_LINES: 8192, PRE_READ: 16_777_216 },
});
'
```

Expected（与 design §6 对齐；允许 schema 漂移时先改 design）：

- `new Date(EXTENDED_DATE).toISOString() === EXTENDED_DATE`（**roundtrip true**；非 canonical extended year 会被 strict 拒绝）
- `Number.isInteger(Number.MAX_VALUE) === true`
- `JSON.stringify(Number.MAX_VALUE) === "1.7976931348623157e+308"`
- `JSON.stringify(-Number.MAX_VALUE) === "-1.7976931348623157e+308"`（statusCode 用 **负** MAX）
- `nNul === 16050` 且 `nSur === 16050`（**两个独立 max-line canary**）
- `nAscii < 16050`（**ASCII canary 不是 max**）
- `nEmoji < 16050`
- 行数上限 **固定 8192**（非 floor 产物）；I/O cap **固定 16_777_216**
- 诚实：`8192*(16050+1)` 与 `4096*(16050+1)` 均 **>** 16MiB → 满载 max-line 会先触 I/O；**不得**宣称满载 4096 max-event 一定可读；4096 条**只要总文件 ≤16MiB** 即可核验

- [ ] **Step 0.4:** 本 Task 不 commit（无产品代码变更）。

**禁止：** 改任何文件。
**回滚：** n/a。

---

## Task 1（C1）: Journal 只读 snapshot / digest SoT — RED → GREEN

**Files:**

- Modify: `src/audit-integrity-journal.js`
- Modify: `test/audit-integrity-journal.test.js`
- **禁止** 新建 cross-store 生产模块（可延后）；**禁止** 改 audit-log / events schema

### 导出合同

```js
/**
 * @internal SoT identical to append write-time payloadDigest.
 */
export function computeAuditIntegrityEventPayloadDigest(strictEvent) { /* ... */ }

/**
 * @internal read-only; same verify parser; no raw records/path/body.
 */
export async function inspectAuditIntegrityJournalFile(root, options = {}) { /* ... */ }
```

### RED

- [ ] **Step 1.1:** 在 `test/audit-integrity-journal.test.js` 新增 describe，最少 **10** 个 it：

1. **digest SoT：** 固定 strict event → `computeAuditIntegrityEventPayloadDigest` 等于测试内独立 `SHA256(DOMAIN_EVENT_PAYLOAD + stringifyStrict(...))`
2. **与 append 一致：** `appendAuditIntegrityEvent` receipt.`payloadDigest` === `compute…(event)`
3. **strict 失败：** 缺 id / Proxy / extra key → `audit-integrity-event-invalid`；**不** sanitize 补全
4. **inspect 成功：** init + 2 append → snapshot
   - `recordCount===3`、`eventCount===2`
   - `payloadDigests` 长度 2 且逐项等于两次 append 的 payloadDigest
   - `generationId`/`headDigest` 与 `verifyAuditIntegrityJournalFile` 一致
5. **inspect 不含 generation-open digest：** `payloadDigests` 不含 null；eventCount 不含 open
6. **inspect missing → not-initialized**（与 verify 相同码 `AUDIT_INTEGRITY_NOT_INITIALIZED`）
7. **inspect 断链 → audit-chain-broken**；**不**返回 partial snapshot
8. **snapshot deep isolation：** 修改返回的 `payloadDigests`（`push` / 下标赋值）**不**影响再次 inspect；数组须为拷贝
9. **snapshot freeze：** `Object.isFrozen(payloadDigests) === true`（或等价不可变合同）；赋值抛错或无效且内部不受污染
10. **options hostile getter/Proxy：** 传入含 getter/Proxy 的 options **不**能通过共享引用改写已返回 snapshot / 模块内部状态

```bash
node --test test/audit-integrity-journal.test.js
```

Expected: **FAIL**（export 不存在）。

### GREEN

- [ ] **Step 1.2:** 实现：

  - 将私有 `eventPayloadDigest` 用于 `computeAuditIntegrityEventPayloadDigest`（stringifyStrict try/catch → event-invalid）
  - `inspect`：复用 verify 的 read + `verifyRawJournal`；在解析过程中收集 event-link `payloadDigest`（可在 verifyRaw 返回扩展私有字段，或 parse 后二次提取——**不得**降低 chain 检查强度）
  - 返回 allowlist 对象；**必须** `payloadDigests = Object.freeze(digests.slice())`（deep-copy + freeze；禁止返回内部可变数组）

- [ ] **Step 1.3:** GREEN

```bash
node --test test/audit-integrity-journal.test.js test/audit-integrity-journal-scans.test.js \
  test/audit-event-schema.test.js
```

Expected: exit 0。

- [ ] **Step 1.4:** **C1 commit + push**（测试绿后 PM 精确 stage 本 boundary 文件；无需再确认）：

```text
feat: export journal inspect snapshot and event payload digest SoT
```

**禁止：** cross-store 生产文件；改 events；version bump；import audit-log；返回 raw records/path；返回未 freeze 的内部数组；stage `package-lock.json`。
**回滚：** 还原 journal 源与测试。

---

## Task 2（C2-a）: Error codes 51→55 — RED → GREEN

**Files:**

- Modify: `src/error-codes.js`
- Modify: `test/error-codes.test.js`

### 新增 4 码（仅此四项）

```js
AUDIT_INTEGRITY_CROSS_STORE_BROKEN:          'audit-integrity-cross-store-broken',
AUDIT_INTEGRITY_CROSS_STORE_IO_ERROR:        'audit-integrity-cross-store-io-error',
AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED: 'audit-integrity-cross-store-bounds-exceeded',
AUDIT_INTEGRITY_CROSS_STORE_EVENT_INVALID:   'audit-integrity-cross-store-event-invalid',
```

```text
计数：51 → 55
```

### RED

- [ ] **Step 2.1:** 更新 `EXPECTED_ERROR_CODES` **全表** + 计数断言 55；唯一性/kebab；`assertRegisteredErrorCode`；注释 size≠bounds、broken≠event-invalid。

```bash
node --test test/error-codes.test.js
```

Expected: FAIL until registry 同步。

### GREEN

- [ ] **Step 2.2:** 注册四码 + GREEN。

**禁止：** 删除旧码；只注册不改 closed-set；把 `audit-chain-broken` 算新增。
**回滚：** 还原两文件。

---

## Task 3（C2-b）: Cross-store parser / relationship / receipt — RED → GREEN

**Files:**

- Create: `src/audit-integrity-cross-store.js`
- Create: `test/audit-integrity-cross-store.test.js`
- 依赖：C1 + C2-a

### 模块头注释（强制）

必须含 BLOCKED 列表（T6d.3 complete / M6d Exit / dual-write / production integration / production detects / authenticity / external anchor / automatic next generation 等）+ 签字上限 + honest limitations；**不得**出现完整 forbidden compound 字面量（前缀 `tamper-` 与后缀 `evident` 相邻）。

### 导出最小集

```js
export const AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH = 'audit/events.jsonl';
export const AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES = 16_777_216;
export const AUDIT_CROSS_STORE_MAX_EVENT_LINES = 8192;
export const AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES = 16050;

export class AuditIntegrityCrossStoreError extends Error { /* message===code */ }

export async function verifyAuditIntegrityAgainstEventStore(root, options = {}) {}
```

### 固定测试向量

```js
const GENERATION_ID = '0123456789abcdef0123456789abcdef';
const EVENT_A = {
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-18T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/a',
  outcome: 'success',
};
const EVENT_B = { ...EVENT_A, id: '22222222-2222-4222-8222-222222222222', path: '/api/b' };
const EVENT_C = { ...EVENT_A, id: '33333333-3333-4333-8333-333333333333', path: '/api/c' };
// digests via computeAuditIntegrityEventPayloadDigest / independent DOMAIN recompute
```

**helpers（测试内）：** 写 journal（init+append）；写 events 文件为 **strict stringify + `\n`** 拼接（**不要**用 `appendAuditEvent` 除非随后 strict 一致且固定 id/time）。

### RED 用例（最少 28 个 it）

**Bounds 证明：**

1. 常量锁：`MAX_EVENT_LINE_BYTES===16050`；`MAX_EVENT_LINES===8192`；`MAX_PRE_READ===16_777_216`
2. **NUL canary：** 全字符串字段 200×NUL + canonical extended date `+275760-09-13T00:00:00.000Z`（先 assert `toISOString()` roundtrip exact）+ **`statusCode: -Number.MAX_VALUE`** + 四个 non-negative integer 字段 **`Number.MAX_VALUE`** → `byteLength===16050`
3. **lone-surrogate canary（独立）：** 同整数/日期布局；全字符串字段 200×lone surrogate → `byteLength===16050`
4. **ASCII 非 max：** `'a'.repeat(200)` 全字段 canary `byteLength < 16050`
5. `Number.isInteger(Number.MAX_VALUE)===true`；锁定 `JSON.stringify(Number.MAX_VALUE)` 与 `JSON.stringify(-Number.MAX_VALUE)`；**禁止** canary 把 `statusCode` 写成正 `Number.MAX_VALUE`（达不到 16050）
6. **三 cap 独立：** 文档/注释断言 **不得** `floor(PRE_READ/(LINE+1))` 推导 `MAX_LINES`；`8192` 是 CPU/序列上限
7. **分层诚实：** `8192*(16050+1) > 16_777_216` 且 `4096*(16050+1) > 16_777_216`；不得宣称满载 4096 max-line 可读；4096 短行且总文件≤16MiB 可核验

**真值表：**

8. **#1a empty：** 无 journal + 无 events → `state:'verified'`, `relationship:'empty'`, counts 全 0, `generationId===null`, `headDigest===null`
9. **#1b empty：** journal 仅 generation-open + events missing/empty → verified empty；counts 全 0 且 `journalEventCount===0`；**`generationId`/`headDigest` 非 null（来自 open）**；不得丢 open 身份
10. **#2 equal：** journal 2 links + events 同 2 行 strict → verified equal；matched=2
11. **#3 events-suffix-of-journal：** J=[dA,dB,dC], E=[dB,dC] → verified；matched=2；journal=3；retained=2
12. **#4 journal-suffix-of-events：** E=[d0,dA,dB], J=[dA,dB] → partial；uncovered=1；matched=2
13. **#5 uncovered-events：** 无 journal（或仅 open）+ events 2 行 → partial uncovered-events；matched=0；uncovered=2
14. **#6 J non-empty E empty：** journal 有 links + events missing/empty → throw `audit-integrity-cross-store-broken`
15. **#7 reorder：** E 置换 → broken
16. **#7 mutate overlap：** 改 E 最后一行字段使 digest 变 → broken
17. **#7 prefix-not-suffix：** E 是 J 的前缀（非后缀）→ broken
18. **#7 insert middle：** 在 E 中部插入 → broken

**Events 解析 / 错误优先级 + journal 错误传播：**

19. 非空缺 final newline → `cross-store-event-invalid`（在 bounds 之后）
20. interior blank line → event-invalid
21. bad JSON → event-invalid
22. extra key / Proxy 落盘不可行则构造 non-canonical re-stringify mismatch → event-invalid
23. 缺 id 的 JSON 行（不 sanitize）→ event-invalid
24. per-line >16050（parse 前）→ bounds-exceeded
25. lines >8192 → bounds-exceeded（可用 stub 短行快速构造）
26. size >16MiB read → **io-error**（≠ bounds）
27. journal 断链 / bounds / io → **原样 journal typed 码**；**不**吞成 empty / partial
28. receipt 精确 keys allowlist；无 `ok`；message===code；无 tmp path 子串；options hostile getter **不得** mutation receipt 成功结果

```bash
node --test test/audit-integrity-cross-store.test.js
```

Expected: FAIL。

### GREEN

- [ ] **Step 3.1:** 实现 design §3–§8：
  - journal：**仅** exact `AUDIT_INTEGRITY_NOT_INITIALIZED` → J=[] / meta null
  - journal 其它错误 **rethrow 原样 typed**（禁止吞 empty）
  - journal 成功仅 open → J=[] 但 meta 保留 open 身份（#1b）
  - events ENOENT → E=[]
  - 严格解析 + `computeAuditIntegrityEventPayloadDigest`
  - 错误优先级：size→io；line/lines→bounds；newline/JSON/canonical→event-invalid；rel→broken
  - 关系分类精确顺序：both empty(1a/1b) → exact equal nonempty → E nonempty proper suffix of J → J nonempty proper suffix of E → J empty && E nonempty → partial/uncovered-events → else broken
  - 无 queue；与 writer 并发可 fail-closed，**禁止** partial 掩盖错位
- [ ] **Step 3.2:** GREEN 上述测试

```bash
node --test test/audit-integrity-cross-store.test.js test/error-codes.test.js \
  test/audit-integrity-journal.test.js
```

Expected: exit 0。

- [ ] **Step 3.3:** **C2 commit + push**（含 C2-a + C2-b；测试绿后 PM 精确 stage；无需再确认）：

```text
feat: add audit event/journal cross-store structural consistency verifier
```

**禁止：** import audit-log；写文件；建立 queue；server wiring；version bump；空后缀把 #6 当 success；stage `package-lock.json`；floor 推导行数；完整 forbidden compound 字面量。
**回滚：** 删 cross-store 源/测；还原 error-codes。

---

## Task 4（C3）: Hostile / limitations / isolation scans — RED → GREEN

**Files:**

- Modify or extend: `test/audit-integrity-cross-store.test.js`
- Create: `test/audit-integrity-cross-store-scans.test.js`

### 4.1 Honest limitations（必须 PASS = verified/partial；不准 expect broken）

- [ ] **Step 4.1:** 最少 **7** 个 documents-* it：

1. `documents-retention-suffix-is-verified-structure-only`
   - J 3 links；E 仅后 2 行 → verified events-suffix；注释：**不**证明删除授权
2. `documents-legacy-prefix-is-partial-not-broken`
   - E 前缀额外一行 + J 后缀匹配 → partial journal-suffix
3. `documents-uncovered-prefix-mutation-still-partial`
   - 仅改 E 前缀（非 overlap）→ 仍 partial（非 broken）
4. `documents-paired-rewrite-of-events-and-journal-may-verify`
   - 两边同步换成新 equal 序列 → verified equal
5. `documents-consistent-dual-suffix-truncation-may-verify`
   - 两边截成同一后缀 → verified
6. `documents-journal-only-events-mutation-still-invisible-to-journal-verify`
   - 改 events 后 `verifyAuditIntegrityJournalFile` **success**；**同时** cross-store **broken**（对比证明 V1.36 仅显式 verifier 可见）
7. `documents-full-j-replay-shaped-tail-is-partial-not-broken`
   - **强制：** `E = J + J`（未入链尾完整重放整段 J 的 payloadDigest 值序列；无额外 legacy）
   - 期望：**partial** `journal-suffix-of-events`（**禁止** expect broken）
   - counts：`matchedEventCount === J.length`，`uncoveredEventCount === J.length`（E=J+J）
   - 注释：纯值序列把最后一个 J 识别为 journal 后缀；无法区分两个相同 occurrence；
     V1.36 无 writer cursor / baseline / unique occurrence binding；
     **不得**宣称检测所有 unjournaled tail；关闭本歧义属 V1.37+ cursor/idempotency/occurrence binding

### 4.2 Hostile canaries（必须 broken / 防假绿）+ 正向 suffix canary

- [ ] **Step 4.2:** 最少 **5** 个 broken it + **1** 个正向 verified-suffix it：

1. prefix-not-suffix（再锁）
2. same multiset different order
3. same count + same last digest but middle wrong
4. **repeated-digest 真实非 suffix（hostile broken）：**
   - `J=[x,y,x]`，`E=[x,x]`
   - 断言：J 最后两项实际为 `[y,x]`，故 `E` **不是** J 的非空后缀 → **broken**
   - **保留 index-by-index / 逐项比较断言**（禁止 set/count 假绿实现）
   - **禁止**再使用 `J=[x,x,y], E=[x,y]` 作为 broken 用例（该对是**真** suffix，见下条）
5. empty-suffix loophole guard：`J=[x] E=[]` broken（非 verified empty）
6. **正向 canary（必须 verified suffix）：**
   - `J=[x,x,y]`，`E=[x,y]`
   - 期望：`state:'verified'`，`relationship:'events-suffix-of-journal'`
   - 证明：重复 digest 值本身**不**破坏 index-by-index 非空 suffix；末两项 `[x,y]===E`
   - **禁止**把此对写成 broken / 非 suffix

### 4.3 Scans

- [ ] **Step 4.3:** `test/audit-integrity-cross-store-scans.test.js` 最少：

1. cross-store 源 import 仅 allowlist（无 `audit-log`）
2. journal 源无 `audit-integrity-cross-store` / 无 `events.jsonl` 业务写入
3. `audit-log.js` / `server.js` / `agent.js` / `capability-audit-sink.js` **不**含
   `audit-integrity-cross-store` / `verifyAuditIntegrityAgainstEventStore` / `inspectAuditIntegrityJournalFile`
4. cross-store 源含 BLOCKED / signature ceiling 关键词
5. **禁止**源码出现完整 forbidden compound；测试用 `['tamper','evident'].join('-')` 作 runtime needle 扫描（文档/源码均不得写完整相邻字面量）
6. honesty：`T6d.3 complete` / `production integration` / `production detects` / `automatic next generation` / `M6d Exit` 仅 negative/BLOCKED 上下文
7. 错误对象无 path
8. 无写 API（源码无 `safeAppendText`/`safeAtomicWriteText`/`safeCreateExclusiveText` 调用）；无 queue 符号

```bash
node --test test/audit-integrity-cross-store.test.js test/audit-integrity-cross-store-scans.test.js
```

Expected: RED then GREEN。

- [ ] **Step 4.4:** **C3 commit + push**（测试绿后 PM 精确 stage；无需再确认）：

```text
test: cross-store verifier hostile canaries and isolation scans
```

**禁止：** 为过 scan 保留完整 forbidden compound 字面量；把 limitation 写成 broken；
把 `J=[x,x,y], E=[x,y]` 写成 broken/非 suffix；把 full-J replay `E=J+J` 写成 broken；
stage `package-lock.json`。
**回滚：** 删/还原测试。

---

## Task 5（C4-a）: temporal 确认（版本 bump 前）

**Files:**

- Read: `docs/superpowers/specs/2026-07-18-linke-v2-m1-exit-audit.md` — **禁止修改**
- Modify only if needed: `test/cross-lan-m1-exit-audit.test.js` — runtime 允许当前版本；**不得**要求 markdown→V1.36

- [ ] **Step 5.1:**

```bash
node --test test/cross-lan-m1-exit-audit.test.js
```

Expected: exit 0 on V1.35 baseline **before** bump。若硬编码 runtime===V1.35，改为 snapshot vs runtime 分离（同 V1.34→V1.35 模式）。

- [ ] **Step 5.2:** 确认 markdown 仍含 V1.33 历史 snapshot 字段。

**禁止：** 改 M1 audit 文档内容。
**回滚：** 还原 temporal 测试。

---

## Task 6（C4-b）: Version V1.36 + Gold/README honesty — RED → GREEN

**仅在 Task 1–5 全绿后。**

**Files:**

- Modify: `src/version.js` → `V1.36`
- Modify: `src/gold-readiness.js` — production-hardening evidence/nextStep：
  - 签字上限句
  - cross-store verifier / `verifyAuditIntegrityAgainstEventStore`
  - T6d.3 **still partial**
  - not dual-write / not M6d Exit / not production-hardening ready / not production detects
  - Gold 仍 4/4/1/9
  - honest：retention suffix 结构 only；paired rewrite 可能通过；无 production caller
  - **禁止**完整 forbidden compound 字面量
- Modify: `README.md` — 标题/当前版本/版本表/边界
- Modify: `test/version.test.js`、`test/gold-readiness.test.js` 及锁 V1.35 的期望

### RED / GREEN

- [ ] **Step 6.1:** 更新测试期望与实现

```bash
node --test test/version.test.js test/gold-readiness.test.js test/cross-lan-m1-exit-audit.test.js
```

Expected: exit 0；`LINKE_RELEASE_VERSION==='V1.36'`；summary 4/4/1/9 blocked。

- [ ] **Step 6.2:** **C4 commit + push**（测试绿后 PM 精确 stage；无需再确认）：

```text
chore: release milestone V1.36 cross-store structural consistency verifier
```

**禁止：** 抬升 production-hardening ready；改 M1 markdown；签字超过上限；stage `package-lock.json`。
**回滚：** version→V1.35；还原 gold/readme/tests。

---

## Task 7（C5）: Full verification + GLM/fresh reviewer

- [ ] **Step 7.1:**

```bash
npm test
```

Expected: exit 0。

- [ ] **Step 7.2:** 手工清单

```text
[ ] 仅新增 cross-store 模块 + journal 只读导出；无 dual-write
[ ] journal 仍不 import audit-log；cross-store 不 import audit-log
[ ] audit-log/server/agent/capability-sink 零引用 cross-store / inspect
[ ] 真值表 1a/1b–7 全覆盖；#1b 保留 open 身份；#6 broken 非 empty
[ ] journal 仅 exact NOT_INITIALIZED→J=[]；其它 typed 原样
[ ] suffix 逐项；hostile canaries 防假绿
[ ] events 严格 canonical；无 sanitize 修复
[ ] bounds 16050（NUL+surrogate）/ 8192 / 16_777_216 证明；三 cap 独立；ASCII 非 max
[ ] size→io-error；lines/line→bounds；newline/JSON/canonical→event-invalid
[ ] 不得宣称满载 4096 max-line 可读；4096 条总文件≤16MiB 可核验
[ ] receipt allowlist 无 ok；path-free
[ ] inspect payloadDigests deep-freeze；hostile options/receipt mutation 测过
[ ] error closed-set 55 = 51+4
[ ] honest limitations success/partial 套件 PASS（含 full-J replay E=J+J → partial，非 broken）
[ ] journal-only events mutation 仍 journal-verify success；cross-store broken
[ ] hostile repeated non-suffix：J=[x,y,x], E=[x,x] → broken；逐项断言
[ ] 正向 canary：J=[x,x,y], E=[x,y] → verified events-suffix（非 broken）
[ ] 无完整 forbidden compound 字面量；无 production detects 作为已交付
[ ] 无 queue；并发 fail-closed 不 partial 掩盖
[ ] V1.36；Gold 4/4/1/9 blocked；production-hardening partial
[ ] M1 audit doc 未改
[ ] 测试仅 tmpdir
[ ] 签字 ≤ V1.36 audit event/journal cross-store structural consistency verifier implementation
[ ] V1.37 dual-write + cursor/occurrence binding 仅文档预留；本版不承诺关闭 replay-shaped half-success
[ ] 未 stage package-lock.json
```

- [ ] **Step 7.3:** Fresh reviewer / 可选 GLM 对 **代码 diff** 再审（≠ docs PROCEED）
- [ ] **Step 7.4:** 修复若有 → `fix:` / `test:` 小 commit + push（测试绿后 PM 精确 stage；无需再确认）；再 `npm test`
- [ ] **Step 7.5:** C5 无修复则无需额外 commit；有修复则已在 7.4 push

**回滚：** 按 boundary 逆向；禁止 hard reset 除非用户明确要求。

---

## 每任务共用禁止项

1. production dual-write / server/agent/HTTP/CLI/Web wiring
2. journal import audit-log；audit-log import journal/cross-store
3. 复制 DOMAIN_EVENT_PAYLOAD 到 cross-store（必须用 journal SoT）
4. set/multiset/includes/head/count-only 关系实现
5. 空后缀规则把 J>0&&E=[] 判 success
6. sanitizeAuditEvent 修复 events 存量
7. 改 events schema / retention 算法
8. repair / recovery / rotation / automatic next generation
9. external anchor / HMAC / signature / authenticity / 防篡改宣称
10. 完整 forbidden compound 字面量（`tamper-` 与 `evident` 相邻）
11. T6d.3 complete / M6d Exit / production detects / Gold ready 作为已交付
12. 抬升 eligible / realAttemptAudit / production-hardening ready
13. 改历史 M1 audit markdown
14. 测试写入仓库目录
15. 新 npm dependency
16. 在 boundary 测试未绿时 commit/push；或 stage 范围超出本 boundary
17. 把 size>maxBytes 映射 bounds；或用 floor 从字节推导行数
18. 把 honest limitation 写成 expect broken（含 full-J replay `E=J+J` → 必须 partial）
19. 只注册 error codes 而不更新 `EXPECTED_ERROR_CODES` 51→55
20. stage 未跟踪 `package-lock.json`
21. 把 journal broken/io/bounds 吞成 J=[] / empty
22. 返回未 deep-freeze 的 `payloadDigests` 内部数组
23. 宣称满载 4096 max-line events 一定可读
24. 并发中间态返回 partial/verified 掩盖错位
25. 把 `J=[x,x,y], E=[x,y]`（真 suffix）写成 broken/非 suffix；hostile 必须用真实非 suffix 如 `J=[x,y,x], E=[x,x]`
26. 宣称 V1.36 检测所有 unjournaled tail / 已关闭 replay-shaped suffix ambiguity

---

## 回滚策略（总）

| 已完成 boundary | 回滚动作 |
| --- | --- |
| C0 only | 删两份 docs |
| C1 | 还原 journal 导出与测试 |
| C2 | 删 cross-store；还原 error-codes |
| C3 | 删/还原 scan 与 limitation 测试 |
| C4 | version→V1.35；还原 gold/readme |
| C5 修复 | 针对性 revert |

---

## 实现顺序总览（TDD）

```text
Task0 baseline + bounds recompute
 → Task1 journal inspect/digest SoT (RED/GREEN)     ⇒ C1
 → Task2 error codes 51→55 (RED/GREEN)
 → Task3 cross-store core relationship (RED/GREEN)  ⇒ C2
 → Task4 hostile + limitations + scans              ⇒ C3
 → Task5 temporal
 → Task6 V1.36 honesty                              ⇒ C4
 → Task7 npm test + fresh review                    ⇒ C5
```

---

## 期望测试文件与最小用例计数

| 文件 | 最少新增 `it` |
| --- | --- |
| `test/audit-integrity-journal.test.js` | **10**（SoT/inspect/deep-freeze/hostile options） |
| `test/error-codes.test.js` | closed-set **51→55** 全表 |
| `test/audit-integrity-cross-store.test.js` | **28** core + **7** limitations + **5** hostile broken + **1** 正向 suffix canary ≈ **41** |
| `test/audit-integrity-cross-store-scans.test.js` | **8** |
| version/gold/temporal | 期望值更新 |

### 测试矩阵摘要

| 类别 | 场景 | 期望 |
| --- | --- | --- |
| 真值 #1a | 无 journal + 无 events | verified empty；meta **null** |
| 真值 #1b | 仅 open + events 空 | verified empty；meta **from open**；journalEventCount=0 |
| 真值 #2 | J===E 非空 | verified equal |
| 真值 #3 | E 非空后缀 of J | verified events-suffix |
| 真值 #4 | J 非空后缀 of E | partial journal-suffix |
| 真值 #5 | J 空 E 非空 | partial uncovered |
| 真值 #6 | J 非空 E 空 | **broken** |
| 真值 #7 | 普通非 suffix 错位/重排/改 overlap/未入链尾 U | **broken** |
| Journal err | broken/io/bounds | **原样 typed**；不吞 empty |
| Hostile | prefix/count/head/multiset | **broken** |
| Hostile | repeated **real** non-suffix `J=[x,y,x], E=[x,x]`（末项 `[y,x]≠[x,x]`） | **broken**（逐项） |
| Positive | repeated **true** suffix `J=[x,x,y], E=[x,y]` | **verified** events-suffix |
| Limitation | retention suffix | **verified** |
| Limitation | legacy prefix | **partial** |
| Limitation | paired rewrite | **verified** 可 |
| Limitation | full-J replay `E=J+J` | **partial** journal-suffix；matched=J.len；uncovered=J.len |
| Limitation | journal-only still blind; cross-store sees | journal success + cross-store broken |
| Bounds | 16050 NUL+surrogate / 8192 / 16MiB | 三独立 cap + typed errors |
| Snapshot | deep-freeze + hostile options | 无泄漏可变内部数组 |
| Isolation | 零 wiring / 无完整 forbidden compound | scan PASS |

---

## 完成定义（DoD）

1. journal 只读 SoT 导出 + cross-store 模块落地；`payloadDigests` deep-copy + freeze
2. 真值表 1a/1b–7 与 receipt 公式一致（empty 双分支 meta）
3. events 严格解析 fail-closed；错误优先级：size→io；line/lines→bounds；newline/JSON/canonical→event-invalid；rel→broken
4. bounds：`16050`（NUL + lone-surrogate 双 canary）/ `8192` / `16_777_216`；三 cap 独立；ASCII 非 max；禁止 floor 推导
5. journal 仅 exact `NOT_INITIALIZED`→J=[]；其它 journal 错误原样 typed
6. error-codes **55**；isolation/honesty scans 绿
7. hostile canaries 防假绿（含 `J=[x,y,x],E=[x,x]`）；正向 `J=[x,x,y],E=[x,y]` verified suffix；limitations 套件 PASS（含 full-J replay partial）
8. 零 production wiring；无 dual-write；无 queue
9. 并发只读可 fail-closed；禁止 partial 掩盖错位
10. V1.36 + Gold 4/4/1/9 blocked + production-hardening partial
11. 签字 ≤ `V1.36 audit event/journal cross-store structural consistency verifier implementation`（仅结构关系；不宣称关闭全部 unjournaled-tail）
12. `npm test` 绿
13. 每 boundary 测试绿后 PM 精确 stage/commit/push（active user 授权；无需再确认）；永不 stage 未跟踪 `package-lock.json`

---

## 附录 A：关系分类伪代码（实现复制源）

```js
function isExactEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isNonEmptyProperSuffix(shortSeq, longSeq) {
  if (shortSeq.length === 0) return false;
  if (longSeq.length <= shortSeq.length) return false;
  const offset = longSeq.length - shortSeq.length;
  for (let i = 0; i < shortSeq.length; i += 1) {
    if (shortSeq[i] !== longSeq[offset + i]) return false;
  }
  return true;
}

function classify(J, E) {
  if (J.length === 0 && E.length === 0) {
    return { state: 'verified', relationship: 'empty', matched: 0, uncovered: 0 };
  }
  if (isExactEqual(J, E) && J.length > 0) {
    return { state: 'verified', relationship: 'equal', matched: J.length, uncovered: 0 };
  }
  if (isNonEmptyProperSuffix(E, J)) {
    return {
      state: 'verified',
      relationship: 'events-suffix-of-journal',
      matched: E.length,
      uncovered: 0,
    };
  }
  if (isNonEmptyProperSuffix(J, E)) {
    return {
      state: 'partial',
      relationship: 'journal-suffix-of-events',
      matched: J.length,
      uncovered: E.length - J.length,
    };
  }
  if (J.length === 0 && E.length > 0) {
    return {
      state: 'partial',
      relationship: 'uncovered-events',
      matched: 0,
      uncovered: E.length,
    };
  }
  // includes J.length > 0 && E.length === 0
  throwCrossStoreBroken();
}
```

## 附录 B：receipt 形状速查

```text
verified empty #1a (no journal):     generationId=null, headDigest=null, all counts=0
verified empty #1b (only-open):      generationId/headDigest from open, journalEventCount=0, other counts=0
verified equal:                      matched=J=E, uncovered=0
verified events-suffix-of-journal:   matched=E, uncovered=0, journal>E
partial journal-suffix-of-events:    matched=J, uncovered=E-J
partial uncovered-events:            matched=0, uncovered=E, journal=0 (meta null if missing; from open if only-open)
throw:                               no receipt
```

## 附录 C：与 V1.35 / M6d / V1.37 一句话

V1.35 交付 journal **内部** unkeyed 结构一致性基座；V1.36 交付 **显式只读** events↔journal payloadDigest 时间序列结构核验器（签字上限如上；**仅结构关系**），T6d.3 **仍 partial**；V1.37 才在同一 root write queue 下接 production dual-write 并用本 verifier 做 preflight/reconcile——**本 plan 不实现 dual-write，不承诺事务协议已完成**。同 root write queue 之外，仍需 **durable cursor / idempotency / unique occurrence binding** 设计才能关闭 replay-shaped half-success（如 `E=J+J` → pure-value `partial` 而非 broken）；**V1.36 不承诺该协议**。
