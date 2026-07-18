# V1.35 Audit Integrity Journal Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 **M6d T6d.3 partial foundation**：独立 `audit/integrity-journal.jsonl` **unkeyed hash-chain structural consistency foundation / 无密钥哈希链结构一致性基座**（generation-open + event-link）、共享 `audit-event-schema` byte-stable sanitize 提取、`safeCreateExclusiveText` exclusive init（仅并发）、typed path-free 错误（I/O vs chain-broken + 独立 bounds 码）与固定 receipts。实现后仅升 **V1.35**；Gold 仍 **blocked 4/4/1/9**。

**签字上限（唯一允许的完成宣称）：**
`V1.35 unkeyed audit hash-chain structural consistency foundation implementation`

**不是：** T6d.3 complete / M6d Exit / production-hardening ready / **production integration** / dual-write / public surface / Gold / GA / V2 / cross-LAN / tamper-evident / 防篡改能力 / authenticity / 密码学防篡改 / 合规审计链完成。

**Architecture:**
`audit-event-schema.js` 成为 sanitize + strict canonical projection 的 SoT；`audit-log.js` import 并 re-export `sanitizeAuditEvent`（bit-identical）；`audit-integrity-journal.js` **只** import shared schema + safe-data-files（**禁止** import audit-log）；`safeCreateExclusiveText` **直接** `deps.open(final, O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW)`（**禁止**复用会吞 EEXIST 的 `openRegularNoFollow`；EEXIST→`{created:false}`；禁 rename/unlink final）做 generation-open（**仅**防并发 init；EEXIST 不区分 leaf；**不**验证 generation 真实性）；**`initializeAuditIntegrityJournal` 与 `appendAuditIntegrityEvent` 都经同一 per-root `auditIntegrityJournalQueues` Map**（verify 可读独立；init/append 不得分队列/绕队列）；append 另含 bounds preflight + full structure verify + `safeAppendText`；`safeReadText` size 超限 → **io-error**（≠ bounds）；bounds **仅** lines/per-line；verify **只**证明 journal 内部结构自洽。单进程 queue；多进程 single-writer assumed（O_EXCL 跨进程 init 抢占）。**无** production dual-write / events 绑定。

**Tech Stack:** Node.js ESM、`node:test` / `node:assert/strict`、`node:crypto` **unkeyed** SHA-256、`node:fs` constants、现有 `safe-data-files` / `error-codes`。无新 npm 依赖。无 HMAC/signature。

**Design SoT:** `docs/superpowers/specs/2026-07-18-audit-integrity-journal-foundation-design.md`

---

## PM 冻结摘要（实现不得偏离）

```text
MILESTONE     = V1.35 = M6d T6d.3 partial foundation
SIGNATURE     = V1.35 unkeyed audit hash-chain structural consistency foundation implementation
NOT           = T6d.3 complete | M6d Exit | production-hardening ready | production integration
                | Gold | GA | V2 | cross-LAN | tamper-evident | 防篡改能力 | authenticity
GOLD          = blocked 4 ready / 4 partial / 1 blocked / total 9
FLAGS         = realAttemptAudit/global real/execute/wiring/eligible 全部 false
ROUTES        = M1 open / M2 denied
PATH          = audit/integrity-journal.jsonl
ISOLATION     = ≠ events.jsonl ≠ capability-proof-attempts.jsonl
NO_WIRING     = no server/agent/Web/HTTP/CLI/production dual-write/binding
CAPABILITY    = unkeyed hash-chain structural consistency foundation only
FORBIDDEN_NAME= tamper-evident (any qualifier) | tamper-resistant-as-delivered | 防篡改能力
DETECTS       = local/accidental corruption without digest recompute;
                middle delete/insert/reorder → seq/prev break;
                bad tail / bad JSON / wrong schema|key|order|hash
UNDETECTABLE  = suffix rewrite | tail truncation | events-only mutation | full-file replacement
                (honest limitation tests MUST PASS = verify success)
O_EXCL        = concurrent init only; NOT generation authenticity;
                EEXIST {created:false} does NOT distinguish file/dir/symlink/malicious leaf
                → initialize maps ALL EEXIST to already-initialized (NOT io-error)
BOUNDS_4096   = generation-open is record #1; preflight allows existing <=4096
                so existing==4096 MAY append record #4097;
                next preflight existing==4097 → audit-integrity-bounds-exceeded (NOT chain-broken);
                per-line UTF-8 >374 (before JSON.parse) → bounds-exceeded;
                NO automatic next generation; V1.35 has NO recovery generation
SIZE_IO       = safeReadText(...,{maxBytes:1_572_864}) size overlimit → SafeDataFileError
                → audit-integrity-io-error (SAME as read/stat/permission); NEVER bounds-exceeded
ERRORS        = I/O vs chain-broken dichotomy + independent audit-integrity-bounds-exceeded
                closed-set: EXPECTED_ERROR_CODES 45→51 (+6 new; audit-chain-broken EXISTING)
QUEUE         = initialize + append MUST share one Map auditIntegrityJournalQueues per root;
                verify read-only MAY be independent; init/append MUST NOT split/bypass queue
PAYLOAD       = payloadDigest = format-only at verify + link preimage input;
                write-time post-sanitize projection digest only; NOT events provenance
SUFFIX_TEST   = mutate event-link.payloadDigest only; keep 7-key order+sequence;
                recompute that linkDigest; sync prev+recompute subsequent until EOF; expect verified
RECOVERY      = BLOCKED missing trusted-recovery authorization model
ANCHOR        = no external anchor / HMAC / signature → no crypto anti-tamper claim
TESTS_ROOT    = only mkdtemp(tmpdir())
VERSION_BUMP  = only after implementation + temporal/gold/readme tests green
M1_AUDIT_DOC  = do not rewrite historical V1.33 snapshot markdown
```

```text
REJECTED = A events 行内链 | C 纯 validator 无落盘
SELECTED = B 独立 journal foundation (unkeyed structural consistency)
FROZEN   = shared schema | safe exclusive | single queue (init+append) | initial generation only
           | size→io not bounds | no production/public | Gold/M1/M2 honesty
```

---

## Commit boundaries（强制）

| Boundary | Contents | Commit message（用户确认后才 commit） |
| --- | --- | --- |
| **C0 docs** | 仅两份 docs（design + 本 plan） | `docs: design V1.35 unkeyed audit hash-chain structural consistency foundation` |
| **C1 schema + exclusive** | `audit-event-schema.js` 提取 + `audit-log` re-export bit-identical + `safeCreateExclusiveText` + 对应测试 | `feat: extract audit event schema and exclusive create primitive` |
| **C2 journal init/verify** | `audit-integrity-journal.js` canonical/init/verify + error codes（含 bounds-exceeded）+ 测试 | `feat: add audit integrity journal init and verify` |
| **C3 append/queue/hostile** | append + queue + concurrency + hostile + chain-broken 拒写 + 4096/4097 bounds + honest limitations | `feat: append audit integrity event links with fail-closed verify` |
| **C4 scans** | source/sensitive/scope/honesty 扫描测试（禁 tamper-evident） | `test: audit integrity journal isolation and honesty scans` |
| **C5 temporal→V1.35** | temporal 绿 → version/gold/readme V1.35 诚实措辞（签字上限） | `chore: release milestone V1.35 unkeyed audit hash-chain foundation` |
| **C6 full verification** | 全量测试 + fresh review 清单（可无代码 commit；若有修复则 `test:`/`fix:`） | 仅在有修复时 commit |

**规则：**

- Never mix C0 docs-only with code。
- Never auto `git commit` / `git push` — 每 boundary 用户确认。
- Never stage 无请求的 `package-lock.json`。
- Never bump version before C2–C4 绿。
- 每任务：精确 files、RED/GREEN 命令、期望、commit message、禁止项、回滚。
- 测试写盘 **只能** `mkdtemp(join(tmpdir(), ...))`。
- Commit message / README / Gold **禁止** `tamper-evident`、T6d.3 complete、production integration、防篡改能力。

---

## Fresh review / PM gate（代码前）

- [ ] **G1:** Fresh reviewer 对照 design + 本 plan + 源码事实（audit-log / safe-data-files / capability-sink / error-codes / §6.11 / §8.3 / M6d / V1.34）。
- [ ] **G2:** 确认无 P0：events 行内链、dual-write、public surface、M6d Exit 宣称、`tamper-evident`、tamper-proof 作为已交付、防篡改能力、改 M1 audit 文档、把 4097 写成 chain-broken、自动 next generation。
- [ ] **G3:** PM 记录 **implementation PROCEED**（≠ docs PROCEED）。
- [ ] **G4:** 仅此后开始 Task 0+。

若 P0：**停**；改 docs；不写代码。

---

## 全局命令约定

```bash
# 单文件
node --test test/<file>.test.js

# 相关子集（按 task 调整）
node --test test/audit-log.test.js test/audit-event-schema.test.js test/safe-data-files.test.js

# journal 子集
node --test test/audit-integrity-journal.test.js

# C5 诚实
node --test test/version.test.js test/gold-readiness.test.js test/cross-lan-m1-exit-audit.test.js

# 全量
npm test
# 等价：node --test test/*.test.js
```

期望计数以 **当前 suite 增量** 为准：任务内写明 **新增 it 最少数量** 与 **关键 assert**；全量必须以 exit code 0 为准。

---

## Task 0: Baseline 确认（无产品代码）

**Files:**

- Read only: design、本 plan、`src/audit-log.js`、`src/safe-data-files.js`、`src/capability-audit-sink.js`、`src/error-codes.js`、`src/version.js`

- [ ] **Step 0.1:** 记录 baseline

```bash
node --test test/audit-log.test.js test/safe-data-files.test.js test/capability-audit-sink.test.js test/version.test.js
```

Expected: exit 0；`LINKE_RELEASE_VERSION === 'V1.34'`。

- [ ] **Step 0.2:** 确认 ERROR_CODES 现仅有 `audit-chain-broken` 作为链相关码；integrity 新码（含 `audit-integrity-bounds-exceeded`）尚未注册。

- [ ] **Step 0.3:** 确认无 `src/audit-integrity-journal.js` / `src/audit-event-schema.js`。

- [ ] **Step 0.4:** 不 commit。

**禁止：** 改任何文件。
**回滚：** n/a。

---

## Task 1（C1-a）: `audit-event-schema.js` sanitize 提取 — RED → GREEN

**Files:**

- Create: `src/audit-event-schema.js`
- Create: `test/audit-event-schema.test.js`
- Modify: `src/audit-log.js` — 删除内联 sanitize 实现；`import { sanitizeAuditEvent } from './audit-event-schema.js'` 并 **re-export**
- Modify if needed: `test/audit-log.test.js` — 仅当需固定 `now` 向量；默认保持现有用例

### RED

- [ ] **Step 1.1:** 写失败测试（文件尚无实现或实现未接线）

`test/audit-event-schema.test.js` 最少覆盖：

1. **fixed vector bit-stable：** 固定 `now`、固定输入（含敏感字段应丢弃）、`assert.deepEqual` 完整输出对象；并 `assert.equal(JSON.stringify(out), '<exact json>')`（字段顺序锁）
2. **string trim/max 200**
3. **缺 id → UUID 形态**（regex）；**不**对 digest 用随机 id
4. **非法 createdAt → fallback ISO**
5. **statusCode 整数（含负）保留；非整数丢弃**
6. **非负整数 / boolean 规则**
7. **strict projection：合法 fixed id/createdAt 通过；缺 id 拒；extra key 拒；Proxy 拒；symbol 拒；accessor 拒；Array 拒**
8. **stringifyStrict 固定顺序可复现**

```bash
node --test test/audit-event-schema.test.js
```

Expected: **FAIL**（模块不存在或导出缺失）。

### GREEN

- [ ] **Step 1.2:** 实现 `src/audit-event-schema.js`

必须导出：

```js
export function sanitizeAuditEvent(event = {}, now = new Date()) { /* byte-stable 自 audit-log 提取 */ }
export function projectStrictCanonicalSanitizedEvent(event) { /* design §5.4 */ }
export function stringifyStrictCanonicalSanitizedEvent(event) {
  const projected = projectStrictCanonicalSanitizedEvent(event);
  // 固定字面量顺序 JSON.stringify
  return JSON.stringify({ /* only present keys in fixed order */ });
}
```

实现细节：

- 将 `toIsoString` / `sanitizeString` / 字段表移入 shared（module-private 即可）
- `sanitizeAuditEvent` 逻辑与提取前 **逐行等价**
- strict：`utilTypes.isProxy`；`Object.getPrototypeOf` ∈ `{Object.prototype, null}`；own keys 扫描

- [ ] **Step 1.3:** 改 `audit-log.js`：

```js
export { sanitizeAuditEvent } from './audit-event-schema.js';
// 其余 append/read/retention 不变；不得 import journal
```

- [ ] **Step 1.4:** GREEN

```bash
node --test test/audit-event-schema.test.js test/audit-log.test.js
```

Expected: exit 0；audit-log 既有用例全绿（bit-identical 行为）。

- [ ] **Step 1.5:** 可选中间 commit（若拆 C1）：
  `feat: extract audit event schema SoT`

**禁止：** journal 文件；改 events 路径 schema；改 retention；version bump。
**回滚：** 删除 new files；恢复 `audit-log.js` sanitize 内联。

---

## Task 2（C1-b）: `safeCreateExclusiveText` — RED → GREEN

**Files:**

- Modify: `src/safe-data-files.js`
- Modify: `test/safe-data-files.test.js`

### RED

- [ ] **Step 2.1:** 在 `test/safe-data-files.test.js` 新增 describe `safeCreateExclusiveText`，最少：

1. 成功创建：`{created:true}`；文件内容精确；mode 0600（`lstat` mode & 0o777）
2. 再次创建同 path：`{created:false}`；内容不变（**不区分**“合法已初始化”语义；primitive 只返回 false）
3. 并发 10 次：`created:true` 计数 **=== 1**；其余 false（**O_EXCL 仅防并发 init**）
4. parent 缺失时安全创建 parent 后成功
5. leaf 预置 **symlink 指向 dataDir 外目标** → **`{created:false}`**（O_EXCL **EEXIST** 路径；**不是** SafeDataFileError）；**必须**断言：外部目标 **size/mtime/probe 字节未被写入修改**；测试 **不要读取**外部敏感内容（专用 temp 外部文件只写已知 probe 字节）
6. leaf 预置 **directory** 于同相对 path → **`{created:false}`**（与 file/symlink 一样 **不**特殊“识别合法 init”；EEXIST 统一）
7. 不使用 rename 覆盖已存在 regular file（第二次 created:false）
8. text 非 string → SafeDataFileError
9. 实现扫描/注释锁定：**未**调用/复用 `openRegularNoFollow`（该 helper 吞 EEXIST → fail，破坏 exclusive 语义）

根目录：

```js
const root = await mkdtemp(join(tmpdir(), 'linke-safe-excl-'));
```

```bash
node --test test/safe-data-files.test.js
```

Expected: FAIL（export 不存在）。

### GREEN

- [ ] **Step 2.2:** 实现 `safeCreateExclusiveText`（design §6）

**强制实现合同（禁止偏离）：**

```js
// 禁止：复用 openRegularNoFollow（其 catch 把 EEXIST 变成 SafeDataFileError，吞掉 exclusive 语义）
// 禁止：rename over final；unlink final；向 symlink 外部 target 写入

const flags =
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
// 直接：
handle = await deps.open(finalAbsolutePath, flags, mode); // mode 默认 0o600

// EEXIST → 立即：
if (error && error.code === 'EEXIST') return { created: false };
// EEXIST 对 normal file / directory / symlink / 恶意 leaf 一律 created:false；不区分

// 成功 open 后：
//   fstat → must be regular file；否则 SafeDataFileError
//   完整写满 text → handle.sync()（若有）→ close
//   open 成功后任意出口（fstat/write/sync error，含成功路径）必须 finally close；
//   close failure → SafeDataFileError（path-free）
//   parent dir sync：仅 created:true 且 write+sync+close 成功后 best-effort
// 非 EEXIST open/write/stat/close 故障 → SafeDataFileError（path-free）
// 成功 → { created: true }
```

- [ ] **Step 2.3:** GREEN

```bash
node --test test/safe-data-files.test.js test/audit-log.test.js test/capability-audit-sink.test.js
```

Expected: exit 0（无回归）。

- [ ] **Step 2.4:** **C1 commit**（用户确认后）：

```text
feat: extract audit event schema and exclusive create primitive
```

含：schema + exclusive + 相关测试 + audit-log re-export。

**禁止：** journal API；error-codes 新码可延到 C2；version；宣称 O_EXCL 验证 generation 真实性；复用 `openRegularNoFollow`；rename/unlink final。
**回滚：** `git checkout --` 相关 files；删 new schema/test。

---

## Task 3（C2-a）: Error codes 注册 — RED → GREEN

**Files:**

- Modify: `src/error-codes.js`
- Modify: `test/error-codes.test.js` — **必须**更新 closed-set `EXPECTED_ERROR_CODES` 全表与计数（当前精确 **45** 项）

### 既有 vs 新增（强制计数）

**当前事实：** `test/error-codes.test.js` closed-set 精确 **45** 项；其中 **`AUDIT_CHAIN_BROKEN: 'audit-chain-broken'` 已存在**（结构损坏用；**不计新增**）。

**本 task 新增 6 码（仅此六项）：**

```js
// 新增 6 — 全部 kebab-case；不得与既有值冲突
AUDIT_INTEGRITY_BOUNDS_EXCEEDED: 'audit-integrity-bounds-exceeded', // 非 chain corruption；非 size io
AUDIT_INTEGRITY_NOT_INITIALIZED: 'audit-integrity-not-initialized',
AUDIT_INTEGRITY_ALREADY_INITIALIZED: 'audit-integrity-already-initialized',
AUDIT_INTEGRITY_IO_ERROR: 'audit-integrity-io-error', // 含 size 超限 / SafeDataFileError 映射
AUDIT_INTEGRITY_EVENT_INVALID: 'audit-integrity-event-invalid',
AUDIT_INTEGRITY_GENERATION_ID_INVALID: 'audit-integrity-generation-id-invalid',
```

```text
既有：audit-chain-broken  （已在 45 内；本 task 不新增）
新增六码：
  1. audit-integrity-bounds-exceeded
  2. audit-integrity-not-initialized
  3. audit-integrity-already-initialized
  4. audit-integrity-io-error
  5. audit-integrity-event-invalid
  6. audit-integrity-generation-id-invalid
计数：45 → 51（existing + 6）
```

**错误分类 + bounds 独立（design §7.5；精确码表为 SoT，分类标题不得覆盖分码）：**

- **I/O：** `audit-integrity-io-error` — **仅** size/maxBytes 超限与其它 SafeDataFileError/root/read/write/fsync 等 I/O 失败
- **独立状态/输入（禁止并入 io-error）：** `not-initialized`、`already-initialized`、`event-invalid`、`generation-id-invalid` 各自独立
- **链结构（仅结构链）：** `audit-chain-broken`（linkDigest/prev/seq/JSON/schema；payloadDigest **仅**格式 + link 输入）
- **Bounds（仅 lines/per-line；不是 chain corruption；不是 size io）：** `audit-integrity-bounds-exceeded` — **仅** lines>4096/4097 与 per-line UTF-8>374（JSON.parse 前）

### RED

- [ ] **Step 3.1:** 在 `test/error-codes.test.js` **同步**更新：

1. `EXPECTED_ERROR_CODES` **全表**追加上述 **6** 个新 key/value（保持对象字面量完整 SoT；不要只测 `assertRegisteredErrorCode` 而漏 closed-set）
2. 计数断言改为 **51**：`Object.keys(EXPECTED_ERROR_CODES).length === 51` 且 `Object.keys(ERROR_CODES).length === 51`
3. it 标题/注释从 `45 entries` 改为 `51 entries`（或 `existing+6`）
4. `assert.deepStrictEqual(ERROR_CODES, EXPECTED_ERROR_CODES)` 仍必须成立
5. `Object.values(ERROR_CODES)` **唯一**；全部匹配既有 kebab/prefix pattern
6. 每个新码 `assertRegisteredErrorCode` 成功；`new LinkeError(code)` message === code
7. 注释明确：`audit-integrity-bounds-exceeded` **≠** `audit-chain-broken`；size 超限用 **io-error** 而非 bounds；`audit-chain-broken` 为既有不计新增

```bash
node --test test/error-codes.test.js
```

Expected: FAIL until `src/error-codes.js` 注册且测试 closed-set 同步到 51。

### GREEN

- [ ] **Step 3.2:** 写入 `ERROR_CODES` 六新码 + 测试 closed-set 全表/计数 45→51 并 GREEN。

**禁止：** 删除旧码；改既有码字符串；把 bounds 别名到 chain-broken；**只注册码而不更新 `EXPECTED_ERROR_CODES` closed-set**；把 `audit-chain-broken` 算作新增导致计数错误。
**回滚：** 还原 `error-codes.js` 与 `error-codes.test.js`。

---

## Task 4（C2-b）: Journal canonical + initialize + verify — RED → GREEN

**Files:**

- Create: `src/audit-integrity-journal.js`
- Create: `test/audit-integrity-journal.test.js`
- 依赖：C1 schema + exclusive + C2-a codes

### 模块导出（最小）

```js
export const AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH = 'audit/integrity-journal.jsonl';
export const AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES = 1_572_864;
export const AUDIT_INTEGRITY_JOURNAL_MAX_EXISTING_LINES = 4096;
export const AUDIT_INTEGRITY_JOURNAL_MAX_LINES_AFTER_APPEND = 4097; // = 4096 + 1
export const AUDIT_INTEGRITY_JOURNAL_MAX_RECORD_LINE_BYTES = 374;

export class AuditIntegrityJournalError extends Error { /* code; message===code */ }

export async function initializeAuditIntegrityJournal(root, { generationId }) {}
export async function verifyAuditIntegrityJournalFile(root) {}
// append 可在 Task 5 再 export；若需编译通过可先 export 并 throw not implemented — 但 TDD 偏好 Task5 再加
```

文件头注释必须复制 design BLOCKED（含 authenticity / tamper-resistance 限制）+ **unkeyed hash-chain structural consistency foundation** 说明 + honest limitations 列表；源码中**不得**出现 `tamper-evident` 字面量（与 Task7 扫描一致）。

**Queue 合同（Task4 即锁死；Task5 不得另建队列）：**

```js
// module-private
const auditIntegrityJournalQueues = new Map(); // key = resolvedRoot from assertSafeDataRoot

// initializeAuditIntegrityJournal 与 appendAuditIntegrityEvent（Task5）
// 都必须：enqueue on auditIntegrityJournalQueues.get/set(resolvedRoot)
// 禁止：init-only queue / append-only queue / 绕过 Map 直接 exclusive/append
// O_EXCL 仍负责跨进程 init 抢占；queue 负责同进程 init∥append 排序
// verifyAuditIntegrityJournalFile：read-only 可独立（不强制入写队列）
```

### 固定测试向量（示例；实现后用代码算出期望 digest 并写死）

```js
const GENERATION_ID = '0123456789abcdef0123456789abcdef';
// DOMAIN 与 design §4.3–4.4 一致；在测试中用 createHash 独立重算 expected open linkDigest
// unkeyed SHA-256 only — 不得在测试注释中写成 authenticity/防篡改证明
```

**禁止**从实现模块 import 私有 preimage 函数除非 export test helper；推荐测试内 **独立重算** preimage 以锁定合同。

### RED 用例（最少 15 个 it）

1. initialize 成功：receipt `state:'initialized'`, `recordCount:1`（generation-open = **第 1 条**）, `headDigest` 匹配独立重算
2. 文件行：exact key order byte-equal generation-open
3. 重复 initialize → `audit-integrity-already-initialized`；文件字节不变（**不**宣称识别合法 init）
4. 并发 initialize ×8 → 恰好 1 成功（O_EXCL 仅并发）
5. 预置 **symlink leaf** 再 init → **`audit-integrity-already-initialized`**（EEXIST 统一；**不是** io-error）；**外部 target 不读不写**（size/mtime/probe 不变）
6. 预置 **directory / 恶意 leaf** 再 init → 同样 **`already-initialized`**（非 io-error）
7. bad generationId → `audit-integrity-generation-id-invalid`
8. verify missing → `audit-integrity-not-initialized`
9. verify 成功：与 init receipt generationId/headDigest/recordCount 一致；`state:'verified'`（**仅**结构自洽）
10. 缺尾 `\n` → `audit-chain-broken`（坏尾）
11. 篡改 linkDigest 一字节且**不**重算后缀 → `audit-chain-broken`（未重算的局部损坏）
12. 错误 message === code；无 path 子串；无 stack 泄漏到 message
13. bounds 证明单元：open line 240；max event-link 374；`4096*375 < 1572864`；`4097*375 < 1572864`；并注释 **size 超限 → io-error ≠ bounds**
14. root 非法 / 可读 size 超限路径（可用 fixture 或 deps mock）→ **`audit-integrity-io-error`**（**不是** bounds-exceeded）
15. verify 注释/断言：success **不是** authenticity / 防篡改；payloadDigest 仅格式+link 输入、不反查 events

```bash
node --test test/audit-integrity-journal.test.js
```

Expected: FAIL。

### GREEN

- [ ] **Step 4.1:** 实现 init + verify（design §4、§7.1、§7.3、§8）
- [ ] **Step 4.1b:** 实现 **`auditIntegrityJournalQueues`**；`initializeAuditIntegrityJournal` **必须**经该 Map 串行（append 在 Task5 接入同一 Map）
- [ ] **Step 4.2:** SafeDataFileError（**含** size 超限）→ map **`audit-integrity-io-error`**（**禁止** map 到 bounds-exceeded）
- [ ] **Step 4.3:** EEXIST/`{created:false}` → **统一** `audit-integrity-already-initialized`（file/dir/symlink/恶意 leaf；**禁止**写成 io-error）
- [ ] **Step 4.4:** GREEN 上述测试

```bash
node --test test/audit-integrity-journal.test.js test/audit-event-schema.test.js test/safe-data-files.test.js test/error-codes.test.js
```

Expected: exit 0。

- [ ] **Step 4.5:** **C2 commit**（若 append 尚未就绪，C2 可只含 init/verify；或与 Task5 合并为单 feat——**偏好分离**）：

```text
feat: add audit integrity journal init and verify
```

**禁止：** append production dual-write；server import；version bump；改 events schema；源码出现 `tamper-evident` 字面量（与 Task7 扫描一致）；symlink EEXIST→io-error；size→bounds-exceeded；init 绕过 queue。
**回滚：** 删 journal 源与测试；还原 error-codes 若仅本 task 引入。

---

## Task 5（C3）: append + queue + concurrency + hostile — RED → GREEN

**Files:**

- Modify: `src/audit-integrity-journal.js` — `appendAuditIntegrityEvent`（**必须**接入 Task4 已有的 **同一** `auditIntegrityJournalQueues`）
- Modify: `test/audit-integrity-journal.test.js`

### Queue 锁定（强制；与 Task4 同一 Map）

```text
Map name: auditIntegrityJournalQueues
key: resolvedRoot
writers that MUST enqueue:
  - initializeAuditIntegrityJournal
  - appendAuditIntegrityEvent
verifyAuditIntegrityJournalFile: read-only MAY run outside write queue
FORBIDDEN:
  - separate appendQueues / initQueues
  - bypass queue for exclusive create or safeAppendText on journal path
O_EXCL: cross-process init race only
queue: same-process init ∥ append ordering
```

### RED 用例（最少 20 个 it）

**可检测（期望 chain-broken / typed fail）：**

1. 未 init append → not-initialized
2. init 后首条 append：`state:'appended'`, `sequence:1`, `recordCount:2`, payloadDigest/headDigest 独立可复算
3. 第二事件 `sequence:2`, previous 链正确
4. verify 全程绿（结构自洽 only）
5. **调用方指定 sequence/previous 无效**（API 无此字段；若传入多余 options 忽略或拒——冻结：**函数签名仅 `{generationId,event}`**，多余 key 忽略且不得影响链）
6. event 缺 id → event-invalid；文件不变
7. Proxy event → event-invalid
8. extra key event → event-invalid
9. 同 root 并发 20 append：最终 recordCount=21（1 open +20）；sequence 连续；verify OK
10. **同 root 并发 init∥append 交错**（init 与若干 append 同时 kick）：最终要么合法链要么 fail-closed typed error；**不得**半写错序；证明 **同一 queue**（可用 spy/计数或最终结构断言）
11. **未重算 digest** 篡改中间行后 append → chain-broken；**文件字节与篡改后相同**（无额外写入）
12. **中间**删除一行后 append/verify → chain-broken（seq/prev 断裂）
13. 重排两行 → verify chain-broken
14. bad tail（半行无 newline）append → chain-broken
15. generationId 与文件不一致 → chain-broken

**4096 唯一语义（强制；不是 chain-broken；不是 size io）：**

16. 构造 existing lines **=== 4096**（可用 stub/fixture 快速构造合法链或测试 helper；generation-open 计第 1 条）→ append **成功** → recordCount **=== 4097**；verify success
17. 在 existing **=== 4097** 时再 append → **`audit-integrity-bounds-exceeded`**；文件字节 **不变**；**不是** `audit-chain-broken`；**不**触发 next generation
18. per-line UTF-8 >374（JSON.parse 前）→ **`audit-integrity-bounds-exceeded`**；size>1.5MiB 读路径 → **`audit-integrity-io-error`**（**禁止** size→bounds）

**payloadDigest 解释（文档化 assert/注释）：**

19. payloadDigest 等于 DOMAIN_EVENT_PAYLOAD + strict stringify 独立重算；测试注释写明：**仅** write-time post-sanitize projection 一致性；verify **仅**格式校验 + 作 link preimage 输入，**不**重算 event 原像、**不**反查 events
20. 修改 `audit/events.jsonl`（同 root 写入无关内容）后 journal verify 仍 success（可与 Task 6 合并，但至少一处覆盖）

**固定 event 向量：**

```js
const EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-07-18T00:00:00.000Z',
  type: 'api.test',
  method: 'POST',
  path: '/api/test',
  outcome: 'success',
};
// 先 projectStrict 或直接满足 strict；payloadDigest 用 DOMAIN_EVENT_PAYLOAD + stringify 独立算
```

### GREEN

- [ ] **Step 5.1:** 实现 append 流程（design §7.2）；**强制** `appendAuditIntegrityEvent` 与 `initializeAuditIntegrityJournal` 共用 **`auditIntegrityJournalQueues`**（**禁止**新建第二 Map 或绕队列）
- [ ] **Step 5.2:** append 前：`safeReadText` size/stat/permission 故障 → **io-error**；若 existing > 4096 → **`audit-integrity-bounds-exceeded`**；若 existing ≤ 4096 → full structure verify 后允许写（恰 4096 → 第 4097 条）
- [ ] **Step 5.3:** GREEN

```bash
node --test test/audit-integrity-journal.test.js
```

Expected: exit 0；新增用例全过。

- [ ] **Step 5.4:** 回归

```bash
node --test test/audit-log.test.js test/capability-audit-sink.test.js test/safe-data-files.test.js
```

Expected: exit 0。

- [ ] **Step 5.5:** **C3 commit**

```text
feat: append audit integrity event links with fail-closed verify
```

**禁止：** multi-process lock 宣称测试“证明安全”；dual-write；public API；把 4097 拒绝写成 chain-broken；自动 next generation；size→bounds；init/append 分队列或绕队列。
**回滚：** 还原 journal 至 C2；删 C3 测试用例。

---

## Task 6（C3 补）: Honest limitation tests（必须 PASS = verify success）+ crash partial

**Files:**

- Modify: `test/audit-integrity-journal.test.js` only

> **关键：** 下列测试是 **“必须 PASS 表明系统不虚假检测”**，**不是**期望 `audit-chain-broken`。

- [ ] **Step 6.1:** suffix rewrite（必须 verify **success**）

```js
it('documents that suffix rewrite is not detected (verify succeeds after recompute-to-end)', ...)
```

**精确构造（journal 没有“业务字段”；禁止含糊“改业务字段”）：**

```text
1. 合法链：generation-open + ≥2 条 event-link（exact 7-key order 每行）
2. 选定中间 event-link index i（i ≥ 1）
3. 仅修改 records[i].payloadDigest → 另一合法 64 lowercase hex
   - 保持 exact 7-key canonical order
   - sequence / generationId / recordKind / schemaVersion / previousLinkDigest(本步暂不变) 不变
4. 从 index i 重算 records[i].linkDigest
   = SHA256(DOMAIN_EVENT_LINK || gen || seq || previousLinkDigest || NEW payloadDigest)
5. 对后续每条 j = i+1 .. EOF：
   - records[j].previousLinkDigest = records[j-1].linkDigest
   - 重算 records[j].linkDigest（用更新后的 prev + 该行既有 payloadDigest）
6. 按 exact key order re-stringify 每行 + 尾 '\n' 写回
7. expect verify → state:'verified'（success）
FORBIDDEN false-negative setups:
  - 只改 payloadDigest 不重算 linkDigest → 会 chain-broken（那是可检测损坏，不是 limitation）
  - 打乱 key order / 改 sequence → 会 chain-broken
```

注释引用 design §2.4 / §17。

- [ ] **Step 6.2:** tail truncation（必须 verify **success**）

```js
it('documents that tail truncation to a valid prefix is not detected (verify succeeds)', ...)
```

步骤：合法链 ≥3 行 → 删除尾部 N 条（N≥1）得合法前缀 → `verify` **success**。

- [ ] **Step 6.3:** events-only mutation（必须 journal verify **success**）

```js
it('documents that events.jsonl mutation alone is not detected by journal verify', ...)
```

步骤：journal 合法；写入/修改 `audit/events.jsonl`（或删除其内容）→ `verifyAuditIntegrityJournalFile` **success**（无 production dual-write/绑定 → journal 不知情）。

- [ ] **Step 6.4:** full-file replacement with new generationId（必须 verify **success**）

```js
it('documents that full-file replacement with new generationId is not detected (verify succeeds)', ...)
```

步骤：用 **另一** generationId 构造全新自洽链覆盖 journal 路径 → `verify` **success**。

- [ ] **Step 6.5:** partial/crash tail（期望 chain-broken — 可检测类）

写入残缺字节 → verify `audit-chain-broken`；append 拒；无 repair；无 auto next generation。

```bash
node --test test/audit-integrity-journal.test.js
```

Expected: exit 0（limitation 用例 **PASS 因 success**，不是因抛错）。

- [ ] **Step 6.6:** 若需单独 commit：`test: document integrity journal honest limitations`
  否则并入 C3。

**禁止：** 把 limitation 测试写成 “detects deletion/rewrite/truncation”；**禁止** expect chain-broken for suffix rewrite / tail truncation / events-only / full replacement。
**回滚：** 删用例。

---

## Task 7（C4）: source / sensitive / scope / honesty scans — RED → GREEN

**Files:**

- Create: `test/audit-integrity-journal-scans.test.js`（或并入 journal 测试文件的 describe）

### 扫描断言（读源文件字符串；不执行 git）

1. `src/audit-integrity-journal.js` 文本 **不**包含 `from './audit-log.js'` / `appendAuditEvent` / `events.jsonl`
2. `src/audit-log.js` **不**包含 `audit-integrity-journal`
3. `src/server.js` / `src/agent.js` **不**包含 `audit-integrity-journal` / `initializeAuditIntegrityJournal` / `appendAuditIntegrityEvent`
4. `src/capability-audit-sink.js` **不**包含 `integrity-journal`
5. journal 源包含 `missing trusted-recovery authorization model`
6. journal 源包含 **unkeyed** structural consistency 关键词（如 `unkeyed hash-chain structural consistency` 或中文 **无密钥哈希链结构一致性**）
7. journal 源 **禁止**出现 `tamper-evident`（任何上下文若出现在实现源，扫描失败；BLOCKED 列表也用 “authenticity / tamper-resistance” 等替代，避免保留 `tamper-evident` 词）
8. journal **不**包含声称 `WORM` 为已实现（允许出现在 BLOCKED/禁止列表）
9. journal / gold / readme（C5 后）**不**包含未否定的 `T6d.3 complete` / `production integration` 作为已交付
10. 敏感：故意 append 含 `password`/`token` 的 raw 时，strict 拒或 sanitize 后 journal **行内**不出现这些明文（journal 本就不存 event；断言文件内容无 `password-secret`）
11. 错误对象 `JSON.stringify(error)` 或 `error.message` 无 tmp 绝对路径
12. journal 源包含 `audit-integrity-bounds-exceeded` 使用点或常量引用路径可测；且 **4097 拒绝路径不映射** `audit-chain-broken`
13. 无 `automatic next generation` / 自动 next generation 作为已实现行为

```bash
node --test test/audit-integrity-journal-scans.test.js
```

Expected: RED then GREEN after comments/strings present.

- [ ] **Step 7.1:** **C4 commit**

```text
test: audit integrity journal isolation and honesty scans
```

**禁止：** 为过 scan 而改 server 业务逻辑（本应零引用）；为过 scan 保留 `tamper-evident` 词。
**回滚：** 删 scan 测试。

---

## Task 8（C5-a）: temporal 确认（版本 bump 前）

**Files:**

- Read: `docs/superpowers/specs/2026-07-18-linke-v2-m1-exit-audit.md` — **禁止修改**
- Modify only if needed: `test/cross-lan-m1-exit-audit.test.js` — 允许 runtime 为当前版本；**不得**要求 markdown 改成 V1.35

- [ ] **Step 8.1:**

```bash
node --test test/cross-lan-m1-exit-audit.test.js
```

Expected: exit 0 on V1.34 baseline **before** bump。若失败且因硬编码 runtime===V1.33，修复测试拆分 snapshot vs runtime（与 V1.34 相同模式），**仍不改 markdown**。

- [ ] **Step 8.2:** 确认 markdown 仍含 V1.33、`47dcc2d`、4/4/1/9、`VERSION_MUTATION: NONE`。

**禁止：** 改 M1 audit 文档内容把版本写成 V1.35。
**回滚：** 还原 temporal 测试文件。

---

## Task 9（C5-b）: Version V1.35 + Gold/README honesty — RED → GREEN

**仅在 Task 1–8 全绿后。**

**Files:**

- Modify: `src/version.js` → `export const LINKE_RELEASE_VERSION = 'V1.35';`
- Modify: `src/gold-readiness.js` — `nextStep` / evidence 字符串必须对齐 design §13：
  - V1.35 **unkeyed audit hash-chain structural consistency foundation**
  - `audit/integrity-journal.jsonl`
  - T6d.3 **partial foundation only**
  - **not** M6d Exit / not production-hardening ready / not dual-write / not production integration
  - Gold 仍 4/4/1/9 blocked
  - **禁止** `tamper-evident` / 防篡改能力 / T6d.3 complete
  - 可一句 honest：suffix rewrite / tail truncation / events-only / full-file replacement 不可检测（无 external anchor）
- Modify: `README.md` — 标题/当前版本/版本表当前行 → V1.35；边界措辞对齐 design §13；签字上限句
- Modify: `test/version.test.js` 及任何锁 V1.34 的测试期望 → V1.35
- Modify: gold/readme 相关测试期望

### RED

- [ ] **Step 9.1:** 先改测试期望为 V1.35（或先改 version 再跑看失败点），确保有明确 RED 点。

### GREEN

- [ ] **Step 9.2:** 更新 version/gold/readme

关键锁：

```js
assert.equal(LINKE_RELEASE_VERSION, 'V1.35');
// gold summary
assert.equal(summary.ready, 4);
assert.equal(summary.partial, 4);
assert.equal(summary.blocked, 1);
assert.equal(summary.total, 9);
assert.equal(overall, 'blocked');
// production-hardening still partial
// no cross-lan-connectivity item
// evidence/nextStep/README must NOT contain: 'tamper-evident'
// evidence/nextStep/README should contain unkeyed structural consistency wording
```

README / Gold **不得**出现：

- `T6d.3 complete` 作为已交付
- `M6d Exit` 作为已交付
- `production integration` 作为已交付
- `tamper-evident`（任何限定）
- `tamper-proof` / `WORM` 作为已交付（否定句/BLOCKED 列表除外）
- 未限定 “detects deletion” / “防篡改能力”

README / Gold **应**出现签字上限或等价：

- `V1.35 unkeyed audit hash-chain structural consistency foundation implementation`
  或中文 **无密钥哈希链结构一致性基座**

- [ ] **Step 9.3:**

```bash
node --test test/version.test.js test/gold-readiness.test.js test/cross-lan-m1-exit-audit.test.js
```

Expected: exit 0。

- [ ] **Step 9.4:** **C5 commit**

```text
chore: release milestone V1.35 unkeyed audit hash-chain foundation
```

**禁止：** 抬升 production-hardening ready；改 M1 audit markdown；抬升 eligible/realAttemptAudit；签字超过上限。
**回滚：** version 回 V1.34；还原 gold/readme/tests。

---

## Task 10（C6）: Full verification + fresh review

- [ ] **Step 10.1:** 全量

```bash
npm test
```

Expected: exit 0。

- [ ] **Step 10.2:** 手工清单

```text
[ ] 仅 journal 路径 integrity-journal.jsonl
[ ] events.jsonl / capability-proof-attempts.jsonl schema 未改
[ ] sanitize bit-identical（audit-log 测试绿）
[ ] journal 不 import audit-log；audit-log 不 import journal
[ ] server/agent 零引用 journal
[ ] 无 production dual-write / production integration
[ ] 断链后 append 字节不变
[ ] concurrent init 单成功；EEXIST 统一 already-initialized；symlink 外部不写
[ ] receipts 无 ok 含混布尔；字段 allowlist 正确
[ ] error codes closed-set 51（45+6）；含 bounds-exceeded；audit-chain-broken 既有
[ ] 4096：恰 4096 可 append 第 4097；再 append → bounds-exceeded 非 chain-broken；无 auto next generation
[ ] size>maxBytes → io-error（≠ bounds）；per-line>374 → bounds
[ ] init+append 同一 auditIntegrityJournalQueues；verify 可读独立
[ ] safeCreateExclusiveText 直 open O_EXCL；未复用 openRegularNoFollow；禁 rename/unlink final
[ ] symlink/恶意 leaf init → already-initialized（非 io-error）；外部 target 不读不写
[ ] Gold 4/4/1/9 blocked；V1.35
[ ] M1 audit doc 仍为历史 snapshot
[ ] 测试仅 tmpdir
[ ] 无 tamper-evident 词；能力名 = unkeyed structural consistency foundation
[ ] 签字 ≤ V1.35 unkeyed audit hash-chain structural consistency foundation implementation
[ ] BLOCKED 含 missing trusted-recovery authorization model
[ ] honest limitations 四类均 PASS（verify success）：suffix rewrite（精确 payloadDigest+link 重算）/ tail truncation / events-only / full-file replacement
[ ] payloadDigest：verify 仅格式+link 输入；不重算 event 原像；非 events 真实性
```

- [ ] **Step 10.3:** Fresh reviewer 对 **代码 diff** 再审（≠ docs PROCEED）
- [ ] **Step 10.4:** 修复若有 → `fix:` / `test:` 小 commit；再 `npm test`
- [ ] **Step 10.5:** **不**自动 push

**回滚：** 按 boundary 逆向；禁止 hard reset 除非用户明确要求。

---

## 每任务共用禁止项

1. 改 `audit/events.jsonl` 行 schema / 行内链
2. 调用 `appendAuditEvent` 从 journal
3. 接 server/agent/Web/HTTP/CLI
4. production dual-write / production integration
5. external anchor / HMAC / signature / priorChainHeadDigest / automatic next generation / recovery generation
6. auto repair / truncate / retention / rotation
7. 宣称 WORM / immutable / tamper-proof / **`tamper-evident`** / 防篡改能力 / authenticity / multi-process correct / 密码学防篡改 / 合规审计链完成
8. 抬升 Gold / M6d Exit / production-hardening ready / eligible / realAttemptAudit
9. 改历史 M1 audit markdown
10. 测试写入仓库目录
11. 新 npm dependency
12. 未确认的 `git commit` / `git push`
13. 把 4097 拒绝写成 `audit-chain-broken`
14. 把 honest limitation 写成期望 chain-broken
15. 把 O_EXCL/EEXIST 写成“识别合法初始化”或 generation 真实性验证
16. 把 size>maxBytes 映射为 `audit-integrity-bounds-exceeded`（必须 io-error）
17. 把 symlink/恶意 leaf EEXIST init 写成 io-error（必须 already-initialized）
18. init/append 分队列或绕过 `auditIntegrityJournalQueues`
19. 复用吞 EEXIST 的 `openRegularNoFollow` 实现 exclusive create
20. 只注册 error codes 而不更新 `EXPECTED_ERROR_CODES` 45→51 全表

---

## 回滚策略（总）

| 已完成 boundary | 回滚动作 |
| --- | --- |
| C0 only | 删两份 docs |
| C1 | 还原 audit-log/safe-data-files；删 schema 与测试 |
| C2 | 删 journal init/verify；还原 error-codes |
| C3 | 还原 append；保留 init 若需 |
| C4 | 删 scan 测试 |
| C5 | version→V1.34；还原 gold/readme |
| C6 修复 | 针对性 revert 修复 commit |

---

## 实现顺序总览（TDD）

```text
Task0 baseline
 → Task1 schema sanitize+strict (RED/GREEN)
 → Task2 safeCreateExclusiveText (RED/GREEN)  ⇒ C1 commit
 → Task3 error codes incl. bounds-exceeded (RED/GREEN)
 → Task4 journal init+verify (RED/GREEN)      ⇒ C2 commit
 → Task5 append+queue+hostile+4096/4097 (RED/GREEN)
 → Task6 honest limitation PASS suite         ⇒ C3 commit
 → Task7 isolation/honesty scans              ⇒ C4 commit
 → Task8 temporal
 → Task9 V1.35 honesty + 签字上限             ⇒ C5 commit
 → Task10 full npm test + fresh review        ⇒ C6
```

---

## 期望测试文件与最小用例计数

| 文件 | 最少新增 `it` |
| --- | --- |
| `test/audit-event-schema.test.js` | 8 |
| `test/safe-data-files.test.js`（exclusive） | 8 |
| `test/error-codes.test.js` | closed-set **45→51** 全表 + 唯一/kebab（含 6 新码；chain-broken 既有） |
| `test/audit-integrity-journal.test.js` | 15 + 20 + 5 ≈ **40**（含 4 honest limitations + partial tail + size→io + queue） |
| `test/audit-integrity-journal-scans.test.js` | 13 |
| version/gold/temporal | 期望值更新，非纯新增 |

### 测试矩阵摘要（与 design §2.4 / §17 对齐）

| 类别 | 场景 | 期望 |
| --- | --- | --- |
| 可检测 | 未重算 digest 的局部损坏 | chain-broken |
| 可检测 | 中间删/插/乱序 → seq/prev 断 | chain-broken |
| 可检测 | 坏尾 / 坏 JSON / 错 schema/key/order/hash | chain-broken |
| **Limitation（must PASS）** | suffix rewrite（改 event-link.payloadDigest + 从 i 重算 link 至 EOF） | verify **success** |
| **Limitation（must PASS）** | tail truncation | verify **success** |
| **Limitation（must PASS）** | events-only mutation | journal verify **success** |
| **Limitation（must PASS）** | full-file replacement (new generationId) | verify **success** |
| Bounds | existing=4096 append | success → 4097 |
| Bounds | existing=4097 append / per-line>374 | **bounds-exceeded**；非 chain-broken；无 next generation |
| Size IO | size>1.5MiB read | **io-error**（**不是** bounds） |
| Queue | init+append 同一 Map | 同 root 串行；verify 可读独立 |
| O_EXCL | 并发 init | 恰 1 成功 |
| O_EXCL | file/dir/symlink/恶意 leaf EEXIST | 统一 already-initialized（非 io-error）；外部 target 不读不写 |

全量 `npm test` 必须 **exit 0**。

---

## 完成定义（DoD）

1. 两模块 + exclusive primitive + error codes（closed-set **51** = 45+6；含 **bounds-exceeded**；chain-broken 既有）落地
2. init/append/verify 行为与 design 一致（unkeyed 结构一致性 only）
3. 三路径隔离与 cycle 扫描通过
4. 断链 fail-closed 且字节不变
5. 并发 init 单成功；**init+append 同一 queue**；EEXIST 不区分 leaf → already-initialized
6. **Honest limitation 四类测试存在且 PASS（verify success）**；suffix 精确 payloadDigest+link 重算
7. 4096 语义：恰 4096→可写 4097；再 append→bounds-exceeded；size→io-error；无 auto next generation
8. V1.35 + Gold 4/4/1/9 blocked + production-hardening partial
9. 无 public wiring / 无 dual-write / 无 production integration
10. 无 `tamper-evident`；签字 ≤ `V1.35 unkeyed audit hash-chain structural consistency foundation implementation`
11. `npm test` 绿
12. 用户确认前 **无** push

---

## 附录 A：canonical preimage 伪代码（实现复制源）

```js
import { createHash } from 'node:crypto';

const DOMAIN_GENERATION_OPEN = 'linke.audit-integrity-journal.v1.generation-open\u0000';
const DOMAIN_EVENT_PAYLOAD = 'linke.audit-integrity-journal.v1.event-payload\u0000';
const DOMAIN_EVENT_LINK = 'linke.audit-integrity-journal.v1.event-link\u0000';

function sha256Hex(bufOrStr) {
  return createHash('sha256').update(bufOrStr).digest('hex');
}

function generationOpenLinkDigest(generationId) {
  return sha256Hex(
    DOMAIN_GENERATION_OPEN + generationId + '\u0000' + '0' + '\u0000' + 'null' + '\u0000' + 'null',
  );
}

function eventPayloadDigest(canonicalEventUtf8) {
  return sha256Hex(DOMAIN_EVENT_PAYLOAD + canonicalEventUtf8);
}

function eventLinkDigest({ generationId, sequence, previousLinkDigest, payloadDigest }) {
  return sha256Hex(
    DOMAIN_EVENT_LINK
      + generationId + '\u0000'
      + String(sequence) + '\u0000'
      + previousLinkDigest + '\u0000'
      + payloadDigest,
  );
}
```

## 附录 B：receipt 形状速查

```text
initialized: state, generationId, recordCount=1, headDigest
appended:    state, generationId, sequence, recordCount, headDigest, payloadDigest
verified:    state, generationId, recordCount, headDigest
```

## 附录 C：与 V1.34 / M6d 关系一句话

V1.34 交付 capability **proof sink**（无链）；V1.35 交付 **unkeyed audit hash-chain structural consistency foundation / 无密钥哈希链结构一致性基座**（有 journal 内部结构链、无 dual-write、无 authenticity/防篡改宣称）；签字上限为 `V1.35 unkeyed audit hash-chain structural consistency foundation implementation`。T6d.3 complete / M6d Exit / production integration 仍属未来，需 external anchor / HMAC / signature、recovery 授权（**非** automatic next generation）、敏感扫描演练与 §8.3 全项。
