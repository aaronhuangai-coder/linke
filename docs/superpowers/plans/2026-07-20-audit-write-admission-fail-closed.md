# V1.39 Safety-Critical Audit Write-Admission Fail-Closed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 **M6d / T6d.3 still partial** 的真实增量——**副作用前** audit write-admission **fail-closed**（server 全部 `API_WRITE_ROUTES` 中央 gate + agent `nas-snapshot-replicate` execute/recover required start）。实现后仅升 **V1.39**；Gold 仍 **blocked 4/4/1/9**；`production-hardening` **partial**；T6d.3 **still partial**。

**签字上限（唯一允许的完成宣称）：**
`V1.39 safety-critical audit write-admission fail-closed implementation`

**可附带窄句：** pre-side-effect write-admission required（fail-closed）**delivered**。

**不是：** T6d.3 complete / M6d Exit / production-hardening ready / Gold ready / end-to-end production audit delivery / post-outcome audit durability / 业务与审计原子事务·2PC·outbox / V1.38 monitor 合同变更 / remote notification / managed scheduler / multi-process exclusive lock / journal rotation / authenticity / external anchor / HMAC / signature / immutable / server HTTP-Web monitor。

**Architecture:**
- `src/error-codes.js` — **仅 +1**：`AUDIT_DELIVERY_UNAVAILABLE: 'audit-delivery-unavailable'`（60→**61**）
- `src/server.js` — `recordRequiredWriteAdmissionAudit` + auth/rate 后中央 `isApiWriteRoute` gate + outer catch 精确 503 映射；`recordAudit` **保持** best-effort
- `src/agent.js` — `recordRequiredNasReplicationStartAudit`（execute/recover）；`appendNasReplicationAudit` **保持** best-effort；catch 优先级保护固定码
- 复用：`appendAuditEvent` → dual-write coordinator
  - **非 503：** 合法 **recoverable prepared** → coordinator **auto-recover → idle** → admission append 可成功
  - **503 失败源：** **unrecoverable prepared**（recovery conflict / fingerprint mismatch / IO）、**invalid state**、hostile/typed/untyped append throw、其它 `appendAuditEvent` throw
  - **禁止**修改 dual-write auto-recovery 行为
- **不改**：`API_WRITE_ROUTES` 集合、auth 语义、V1.38 monitor/inspector、dual-write recovery 语义、master Gold plan、M1/M2 docs
- Gold/README（C4）— 历史事实改为 “pre-side-effect admission required；post-outcome 仍 best-effort”；继续 `not end-to-end production audit delivery`；statuses **不变**

**Tech Stack:** Node.js ESM、`node:test` / `node:assert/strict`、既有 `createServer` 测试夹具、dual-write state fixtures。无新 npm 依赖。

**Design SoT:** `docs/superpowers/specs/2026-07-20-audit-write-admission-fail-closed-design.md`

**Master Gold 对齐（只引用）：** `docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md`
→ M6d production-hardening；T6d.3 still partial 增量；T6d.6 负向；T6d.7 脱敏。**禁止篡改**该 master plan 或 M1/M2 文档。

---

## C0 review gate（implementation PROCEED 前强制）

```text
C0 审查门（docs 审查；≠ 实现完成）:
  1. design + 本 plan 完稿且自洽
  2. GLM 抗辩 PASS（无 P0）后记录
  3. fresh Grok 只读闭环 PASS / PROCEED YES 后记录
  4. PM 验收通过后：C0 可 commit 并开始 C1

任一 FAIL → 禁止 implementation PROCEED；改 docs，不写代码。
禁止把本 C0 文档阶段写成 V1.39 实现完成。
```

**C0 docs review record（仅 docs 审查证据；≠ 实现完成）：**

```text
GLM C0 verdict (round 1): FAIL
  P0 = 0
  P1 = 1  prepared recovery semantics (bare prepared 误作 503)
  P2 = 1  agent catch priority (不得仅 instanceof LinkeError)

P1/P2 disposition（本轮 docs-only 收紧；≠ 实现完成）:
  P1) recoverable prepared → auto-recover → admission 成功 → mutation proceeds
      （字节 = recovery + 新 append；禁止 unchanged 断言）。
      仅 unrecoverable prepared / invalid / hostile append throw → 503。
      unrecoverable fixture：真实 prepared + 破坏 events/journal fingerprint
      → recovery conflict；或 invalid state；可复现、非 flaky。
      禁止改 dual-write auto-recovery 满足旧文档。
  P2) helper 统一 throw LinkeError；agent catch 第一优先
      err && err.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE
      （覆盖 LinkeError 与等价固定码对象）；先于 SmbReplicationError/generic；
      best-effort failure audit 不得覆盖固定 stderr/exit。

GLM C0 verdict (round 2): PASS (P0/P1/P2 = 0/0/0; PROCEED YES)
fresh Grok C0 verdict: PASS (P0/P1/P2 = 0/0/0; PROCEED YES)
PM C0 accept: PASS — docs boundary accepted; C1 may begin (not implementation complete)
```

---

## PM 冻结摘要（实现不得偏离）

```text
MILESTONE     = V1.39 = M6d/T6d.3 still-partial pre-side-effect write-admission fail-closed
SIGNATURE     = V1.39 safety-critical audit write-admission fail-closed implementation
ALSO_OK       = pre-side-effect write-admission required (fail-closed) delivered
NOT           = T6d.3 complete | M6d Exit | production-hardening ready | Gold ready
                | end-to-end production audit delivery | post-outcome durability
                | atomic business+audit / 2PC / outbox
                | V1.38 monitor contract change | remote alert | managed scheduler
GOLD          = blocked 4 ready / 4 partial / 1 blocked / total 9  (UNCHANGED statuses)
HARDENING     = production-hardening remains partial
ERRORS        = ERROR_CODES closed-set 60 → 61
NEW_CODE_ONLY = AUDIT_DELIVERY_UNAVAILABLE = 'audit-delivery-unavailable'
HTTP          = 503 + exact code; retryable=true; body only fixed code
CLI           = stderr "Error: audit-delivery-unavailable"; exit 1
SERVER_HELPER = recordRequiredWriteAdmissionAudit
AGENT_HELPER  = recordRequiredNasReplicationStartAudit
ADMISSION_EVT = type api.write.admission.started
                fields ONLY method/path/outcome=started/requestId (+ sanitize id/createdAt)
                FORBIDDEN body/token/sourcePath/targetPath/deviceId/snapshotId/secret
NAS_START_EVT = type nas.snapshot.replication.started (existing; now REQUIRED on execute)
GATE          = after auth/rate; before any write route readBody/mutation
                if (isApiWriteRoute) await recordRequiredWriteAdmissionAudit(...)
COVER         = all 6 API_WRITE_ROUTES; future table rows auto-covered
NO_GATE       = read-only/dry-run; auth denied; rate-limit denied
KEEP_BEST_EFF = recordAudit; appendNasReplicationAudit; post-outcome/auth/rate audits
OUTER_CATCH   = LinkeError(AUDIT_DELIVERY_UNAVAILABLE) → 503+code
                any other 5xx → Internal Server Error
HELPER_MAP    = catch only to remap; NO swallow; NO raw err.message/path/token/stack/errno
AGENT_CATCH   = FIRST: err && err.code === AUDIT_DELIVERY_UNAVAILABLE
                (LinkeError OR equivalent fixed-code object; NOT instanceof-only)
                THEN SmbReplicationError; ELSE generic
                best-effort failure audit MUST NOT override stderr/exit
PREPARED_OK   = legal recoverable prepared → auto-recover → admission success
                → mutation proceeds; bytes MAY change (recovery + append)
                FORBIDDEN: treat bare/legal prepared as 503; FORBIDDEN: unchanged assert
PREPARED_503  = unrecoverable prepared (recovery conflict / fingerprint mismatch / IO)
                | invalid state | hostile append throw
PREPARED_FIX  = real prepared THEN break events/journal fingerprint → recovery conflict
                OR invalid state; deterministic; no flaky
DUAL_WRITE    = auto-recovery behavior UNCHANGED (do not edit for admission tests)
API_WRITE_SET = UNCHANGED (6 routes)
AUTH_SEMANTICS= UNCHANGED
MONITOR_V138  = 10-key / exit 0-1-2 / zero-write UNCHANGED; no server HTTP/Web monitor
CALLER_POST   = post-outcome still best-effort (honesty required)
E2E_DENY      = not end-to-end production audit delivery (must remain)
VERSION_BUMP  = only C4 after C1–C3 green
GIT_AUTH      = each boundary tests+review green → PM precise stage/commit/push
                never stage untracked package-lock.json; never read package-lock as input
IMPLEMENTERS  = Grok codes; GLM adversarial; fresh Grok acceptance per boundary
MASTER_PLAN   = cite only; do not edit 2026-07-16 gold plan or M1/M2 docs
```

```text
SELECTED = A central write-admission gate + required NAS execute start
REJECTED = B end-to-end delivery / atomic transaction
REJECTED = C docs-only claim without caller fail-closed
```

---

## Commit boundaries（强制）

| Boundary | Contents | Commit message（boundary 测试绿后 **PM** 精确 stage/commit/push） |
| --- | --- | --- |
| **C0 docs** | 仅两份 docs（design + 本 plan） | `docs: design V1.39 audit write-admission fail-closed` |
| **C1 server** | ERROR_CODES +1；server helper/gate/outer catch；server admission tests | `feat: require write-admission audit before API mutations` |
| **C2 agent** | NAS execute/recover required start + tests | `feat: require NAS execute start audit before SMB mutation` |
| **C3 scans/honesty** | 静态扫描、closed-set 61、post best-effort 诚实、V1.38 回归 | `test: write-admission scans honesty and closed-set 61` |
| **C4 version/Gold/README** | V1.39 时间线诚实；Gold statuses **不变** | `chore: release milestone V1.39 write-admission fail-closed` |
| **C5 full suite** | 全量 `npm test` + GLM + fresh Grok closure | 仅在有修复时 `test:`/`fix:` commit |

**规则：**

- Never mix C0 docs-only with code。
- **每个 boundary** 相关测试与审查绿后，**PM** 精确 stage 该 boundary 文件 → commit → push；永不 stage 未跟踪 `package-lock.json`。
- Never bump version before C1–C3 绿。
- 每任务：精确 files、RED 命令、GREEN 命令、禁止项、commit boundary。
- 测试写盘 **只能** `mkdtemp(join(tmpdir(), ...))`。
- Commit message / README / Gold **禁止**无限定 T6d.3 complete、M6d Exit、production-hardening ready、end-to-end production audit delivery as delivered。
- 每个 boundary runtime 必须可运行：真实功能或真实 fail-closed；禁止 silent stub 假绿。
- **禁止** “实现选一” / TODO stub 当完成。
- **禁止**借机增加其它 ERROR_CODES 或改 `API_WRITE_ROUTES` 集合。

---

## Fresh review / PM gate（代码前）

- [ ] **G0:** design + 本 plan 完稿；方案 A 选定 / B·C 拒绝已写。
- [ ] **G1:** GLM 抗辩 PASS（无 P0）。
- [ ] **G2:** fresh Grok 对照 design + plan + V1.38 源码事实 = PASS / PROCEED YES。
- [ ] **G3:** PM 验收后 **C0 可 commit** 并 **开始 C1**（≠ V1.39 实现完成）。

若 P0：**停**；改 docs；不写代码。

---

## 全局命令约定

```bash
# C1 server + registry
node --test test/error-codes.test.js test/server-write-admission.test.js

# C2 agent
node --test test/agent-nas-snapshot-replicate.test.js

# C3 scans/honesty（文件名以实现时新建为准；可并入下列）
node --test test/server-write-admission-scans.test.js \
  test/error-codes.test.js \
  test/audit-integrity-monitor.test.js \
  test/audit-integrity-monitor-scans.test.js

# C4 诚实
node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js

# 关键回归
node --test test/security.test.js test/audit-log.test.js test/server.test.js

# 全量
npm test
```

期望：exit 0；ERROR_CODES length **61**（C1 后）；全量仅既有 keychain skip（若有）。

---

## Task 0: Baseline 确认（无产品代码）

**Files:** Read only

- design + 本 plan
- `src/server.js`（`API_WRITE_ROUTES` / `recordAudit` / outer catch / write handlers）
- `src/agent.js`（`appendNasReplicationAudit` / nas-snapshot-replicate）
- `src/audit-log.js` / `src/error-codes.js` / `src/version.js` / `src/gold-readiness.js`
- `src/audit-integrity-dual-write*.js`（失败注入方式）
- 相关 tests；**不读** `package-lock.json`

- [ ] **Step 0.1:** 记录 baseline

```bash
git rev-parse --short HEAD
node -e "import { ERROR_CODES } from './src/error-codes.js'; import { LINKE_RELEASE_VERSION } from './src/version.js'; console.log(LINKE_RELEASE_VERSION, Object.keys(ERROR_CODES).length)"
node --test test/error-codes.test.js test/version.test.js
```

Expected: HEAD **e6f2cd6** 系；version **V1.38**；ERROR_CODES **60**。

- [ ] **Step 0.2:** 确认 6 write routes 与 best-effort catch 仍在

```bash
rg -n "API_WRITE_ROUTES|async function recordAudit|appendNasReplicationAudit|Internal Server Error" src/server.js src/agent.js
```

Expected: 6 routes；两处 swallow catch；outer 5xx → Internal Server Error。

---

## C0 — Docs only（本 boundary；无 src/test）

**Files:**

- Create: `docs/superpowers/specs/2026-07-20-audit-write-admission-fail-closed-design.md`
- Create: `docs/superpowers/plans/2026-07-20-audit-write-admission-fail-closed.md`

**禁止：** 任何 `src/**`、`test/**`、`README.md`、`version.js`、Gold 文件、master plan、M1/M2 docs、`package-lock.json`。

- [ ] **Step C0.1:** 两份文档齐套；签字上限 / 非目标 / master 对齐一致。
- [ ] **Step C0.2:** 只读校验

```bash
git status --short
git diff --check
rg -n "T6d\.3 complete|M6d Exit|production-hardening ready|end-to-end production audit delivery as delivered" \
  docs/superpowers/specs/2026-07-20-audit-write-admission-fail-closed-design.md \
  docs/superpowers/plans/2026-07-20-audit-write-admission-fail-closed.md || true
```

Expected: 仅两份 `??` docs（或已 staged docs）；无 src/test 变更；文档中上述短语只作为 **FORBIDDEN/not** 出现。

**Commit boundary（PM）：** `docs: design V1.39 audit write-admission fail-closed`
（本 C0 执行轮次可按 PM 指示 **暂不 commit**。）

---

## C1 — Server RED → GREEN

### Task 1.1: ERROR_CODES +1（可与 1.2 同 commit）

**Files:**

- Modify: `src/error-codes.js`
- Modify: `test/error-codes.test.js`

- [ ] **Step 1.1-RED:** 先把 `EXPECTED_ERROR_CODES` / length 断言改为 **61** 并加入新码期望 → 跑红

```bash
node --test test/error-codes.test.js
```

Expected: FAIL（registry 仍 60 或缺新码）。

- [ ] **Step 1.1-GREEN:** 仅新增：

```js
AUDIT_DELIVERY_UNAVAILABLE: 'audit-delivery-unavailable',
```

```bash
node --test test/error-codes.test.js
```

Expected: PASS；`Object.keys(ERROR_CODES).length === 61`；无其它码增删。

**禁止：** 借机改名/删除旧码；借机加第 62 个码。

### Task 1.2: Server admission 行为测试（先 RED）

**Files:**

- Create: `test/server-write-admission.test.js`（冻结名）
- （后续 GREEN）Modify: `src/server.js`

**最低用例清单（映射 design 攻击矩阵）：**

| # | 用例 |
| --- | --- |
| 1 | `API_WRITE_ROUTES.length === 6` 且与 export 表一致 |
| 2 | 中央 gate：源码在 auth 块之后、首个 write handler/`readBody` 之前含 `isApiWriteRoute` + `recordRequiredWriteAdmissionAudit` |
| 3 | healthy cold：每个 write route 成功路径 exact-one `api.write.admission.started`（method/path/outcome/requestId；无 deviceId/body/token） |
| 4 | invalid body（如 heartbeat 缺 deviceId）：admission 已写后原 4xx |
| 5a | **合法 recoverable prepared** leftover：coordinator auto-recover → admission **成功**；exact-one admission；mutation **proceeds**；state/events/journal 字节变化符合 **recovery + 新 append**；**禁止** assert unchanged |
| 5b | **unrecoverable prepared**：6 routes 均 503 + `audit-delivery-unavailable`；mutation spies 0；**业务**持久化文件字节不变；响应无 path/token/raw state |
| 6 | **invalid** dual-write state：同 5b（503；mutation 零副作用） |
| 7 | hostile untyped append failure（mock/inject）：503 fixed code；响应 JSON 无 path/token/stack |
| 8 | read-only / dry-run route：无 `api.write.admission.started` |
| 9 | auth denied / rate-limit：无 admission 事件；既有 best-effort 类型仍可出现 |
| 10 | outer catch：普通 5xx → `Internal Server Error`；helper 的 `LinkeError(AUDIT_DELIVERY_UNAVAILABLE)` → 503 exact code |
| 11 | helper 不泄漏：强制 append 抛带 path/token 的 Error → 响应与 audit 映射输出无泄漏 |

**失败 / 正向 fixture（冻结；可复现；禁止 flaky；禁止改 dual-write auto-recovery）：**

| 目的 | fixture |
| --- | --- |
| **正向 5a recoverable prepared** | 制造 **合法 recoverable** prepared leftover（与 V1.37 coordinator 可 auto-recover 的形态一致）→ 发 write 请求 → 期望 recover+admission 成功 |
| **503 5b unrecoverable prepared** | **先**制造真实 prepared，**再**破坏 events 和/或 journal 的 fingerprint/binding，使 recovery 落入 **recovery conflict**（或等价 unrecoverable / recovery IO fail）→ 期望 503 |
| **503 6 invalid state** | 直接写入 schema/关系非法的 `integrity-dual-write-state.json`（deterministic invalid） |
| **503 7 hostile** | test-only 对 `appendAuditEvent` 可控 stub 抛 typed/untyped Error（若用 stub：不得默认开启 production test hook） |

**禁止：** 把 bare / 合法 prepared 单独当作 503 用例；禁止为让 prepared “失败”而修改 coordinator auto-recovery。

- [ ] **Step 1.2-RED:**

```bash
node --test test/server-write-admission.test.js
```

Expected: FAIL（无 helper/gate/新事件 type）。

- [ ] **Step 1.2-GREEN:** 实现 `src/server.js`：

  1. `recordRequiredWriteAdmissionAudit`（design §3.2 语义）
  2. auth/rate 后中央 gate
  3. outer catch 特例映射
  4. **不改** `recordAudit` swallow；**不改** `API_WRITE_ROUTES` 集合
  5. **不改** dual-write coordinator auto-recovery（合法 recoverable prepared 仍恢复成功）

```bash
node --test test/server-write-admission.test.js test/error-codes.test.js
```

Expected: PASS。

**回归（C1 结束前）：**

```bash
node --test test/security.test.js test/audit-log.test.js test/server.test.js
# dual-write recovery 不回归（合法 recoverable prepared 仍 auto-recover；可选）
node --test test/audit-integrity-dual-write.test.js
```

**禁止：**

- per-route 复制 admission 代替中央 gate
- admission 事件写入 body/token/deviceId/snapshotId/sourcePath/targetPath
- 把 `recordAudit` 改为 required
- outer catch 透传任意 5xx raw message 或任意 LinkeError 5xx
- 把 **合法 recoverable prepared** 当成 503 失败源，或对其 assert 字节不变
- 修改 dual-write auto-recovery 行为以满足旧/错误文档

**Commit boundary（PM）：** `feat: require write-admission audit before API mutations`
Stage 仅：`src/error-codes.js` `src/server.js` `test/error-codes.test.js` `test/server-write-admission.test.js`（及本 boundary 必需文件）。

---

## C2 — Agent RED → GREEN

### Task 2.1: NAS execute/recover required start

**Files:**

- Modify: `src/agent.js`
- Modify: `test/agent-nas-snapshot-replicate.test.js`（扩展；或新建 `test/agent-nas-write-admission.test.js` 若需隔离——默认 **扩展既有文件** 以集中 NAS 合同）

**最低用例：**

| # | 用例 |
| --- | --- |
| 1 | execute + healthy audit store：exact-one `nas.snapshot.replication.started` 后才调用 replicate helper |
| 2 | recover + execute：start required；recover helper 前 admission 成功 |
| 3a | execute + **合法 recoverable prepared**：auto-recover 后 required start **成功**；随后 SMB 按原语义（**非** admission 503）；字节允许 recovery+append 变化 |
| 3b | admission 失败（**unrecoverable prepared** / invalid / hostile）：stderr 固定码；exit 1；real SMB helper callCount=0；目标目录字节不变 |
| 4 | plan-only：不要求 required admission（无强制 started；不因 audit store broken 而改 plan 出口语义为 admission 码） |
| 5 | 参数校验失败：不进 required admission |
| 6 | required 失败后 optional best-effort failure audit 若执行，stderr/exit **仍** `audit-delivery-unavailable` / 1（不得覆盖） |
| 7 | 成功/业务失败路径：result/failure 仍走 `appendNasReplicationAudit` best-effort（可保留既有 C6 swallow 诚实测） |
| 8 | catch 识别：**不**依赖 `instanceof LinkeError`；`err && err.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE` 对等价固定码对象同样命中；且该分支 **先于** `SmbReplicationError` / generic |

实现要点：

```text
recordRequiredNasReplicationStartAudit(dataDir, fields)
  → appendAuditEvent(...)  // NOT appendNasReplicationAudit
  → on failure: ALWAYS throw new LinkeError(
        ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE,
        { statusCode: 503, retryable: true },
      )
     // helper 统一 LinkeError；不得 swallow

agent execute/recover catch 优先级（强制顺序）:
  1) FIRST: if (err && err.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE)
        // covers LinkeError AND equivalent fixed-code objects
        // FORBIDDEN: require instanceof LinkeError to recognize
        → optional best-effort failure audit (MUST NOT change stderr/exit)
        → console.error('Error: audit-delivery-unavailable'); process.exit(1)
  2) THEN: if (err instanceof SmbReplicationError) → existing path
  3) ELSE: generic → nas-snapshot-replicate-failed / exit 1

unrecoverable fixture: same as C1 (real prepared + break fingerprint → recovery conflict)
  OR invalid state; deterministic; do NOT change dual-write auto-recovery
```

- [ ] **Step 2.1-RED:**

```bash
node --test test/agent-nas-snapshot-replicate.test.js
```

Expected: 新断言 FAIL（started 仍 swallow 或失败码被覆盖）。

- [ ] **Step 2.1-GREEN:**

```bash
node --test test/agent-nas-snapshot-replicate.test.js test/error-codes.test.js
```

Expected: PASS。

**禁止：**

- plan-only 强制 required admission
- admission 失败仍调用 SMB
- 用 `appendNasReplicationAudit` 充当 required start
- 失败映射为 `nas-snapshot-replicate-failed` 覆盖固定码
- 在 stderr 打印 raw err.message/path
- catch **仅** `instanceof LinkeError` 识别 admission 失败（必须 `err.code ===`）
- 把 **合法 recoverable prepared** 当成 NAS admission 503 用例
- 修改 dual-write auto-recovery

**Commit boundary（PM）：** `feat: require NAS execute start audit before SMB mutation`

---

## C3 — Scans / honesty / closed-set 61

### Task 3.1: 静态扫描与诚实边界

**Files:**

- Create: `test/server-write-admission-scans.test.js`（冻结名）
- Modify: 所有 **current** 仍断言 `Object.keys(ERROR_CODES).length === 60` 的 runtime tests → **61**
  已知（V1.38 遗留，C3 必须清零）：
  - `test/error-codes.test.js`（C1 已改则跳过）
  - `test/audit-integrity-dual-write-scans.test.js`
  - `test/audit-integrity-dual-write-readonly-inspect.test.js`
  - `test/audit-integrity-monitor.test.js`
  - `test/audit-integrity-monitor-scans.test.js`
  - `test/agent-audit-integrity-monitor.test.js`
  - 以及 `rg` 新发现的任何 current test

- [ ] **Step 3.1-RED:** 扫描测试先写期望

**扫描必须覆盖：**

| 扫描 | 期望 |
| --- | --- |
| S1 | `src/server.js` production 对 `recordRequiredWriteAdmissionAudit` **exact-one** 调用点（gate 内）；无 dead helper |
| S2 | required helper 函数体：**禁止**空 `catch` / `.catch(` swallow；仅允许 remap+throw |
| S3 | gate 词法位于 auth 块后、write route `readBody` 前（行序/结构断言） |
| S4 | admission 事件 type 字符串 production 唯一；测试可引用 |
| S5 | `recordAudit` 仍存在 best-effort catch（post 诚实） |
| S6 | `appendNasReplicationAudit` 仍存在 swallow catch（post 诚实） |
| S7 | 无 comment/string 伪实现：`recordRequiredWriteAdmissionAudit` 真函数 + 真 await |
| S8 | `ERROR_CODES` length **61**；全 test 树对 `length, 60` / `length === 60` 的 **current 锁** 清零（历史 docs 除外） |
| S9 | 无第二新 error code 混入 |
| S10 | V1.38 monitor 关键：`node --test test/audit-integrity-monitor.test.js` 子集或全文件绿 |

```bash
# 发现残留 60 锁
rg -n "keys\\(ERROR_CODES\\)\\.length, 60|length === 60\\)|exact 60|remains 60|closed-set 60" test/ --glob '*.js'
```

Expected after C3: **无** current test 再锁 60（历史叙事只在 docs）。

- [ ] **Step 3.1-GREEN:**

```bash
node --test test/server-write-admission-scans.test.js \
  test/error-codes.test.js \
  test/server-write-admission.test.js \
  test/agent-nas-snapshot-replicate.test.js \
  test/audit-integrity-monitor.test.js \
  test/audit-integrity-monitor-scans.test.js \
  test/agent-audit-integrity-monitor.test.js \
  test/audit-integrity-dual-write-scans.test.js \
  test/audit-integrity-dual-write-readonly-inspect.test.js
```

Expected: PASS。

**禁止：**

- 用注释/字符串匹配冒充 helper 存在
- 删除 post best-effort catch 冒充 e2e delivery
- 修改 monitor 10-key / exit / zero-write 合同“顺便重构”

**Commit boundary（PM）：** `test: write-admission scans honesty and closed-set 61`

---

## C4 — Version / Gold / README → V1.39

### Task 4.1: 时间线诚实（statuses 不变）

**Files:**

- Modify: `src/version.js` → `V1.39`
- Modify: `src/gold-readiness.js`（**仅** production-hardening evidence/nextStep 事实句）
- Modify: `README.md`（当前版本叙事）
- Modify: `test/version.test.js` / `test/gold-readiness.test.js` / `test/readme.test.js`（若断言版本或诚实句）

**Gold 硬约束：**

```text
status summary UNCHANGED:
  ready == 4
  partial == 4
  blocked == 1
  total == 9
production-hardening.status == 'partial'
execution flags remain false
```

**evidence / nextStep 必须同时具备：**

- V1.39 signature 窄句
- `pre-side-effect admission required`（或等价）
- `post-outcome` / `recordAudit` / `appendNasReplicationAudit` **仍 best-effort**
- `not end-to-end production audit delivery`
- `T6d.3 still partial` / `not T6d.3 complete` / `not M6d Exit` / `not production-hardening ready` / `not Gold`
- `Gold remains blocked 4/4/1/9`
- V1.38 monitor 交付句可保留；**不**改 monitor 为 e2e delivery

将旧句：

```text
server recordAudit / agent appendNasReplicationAudit best-effort catch
```

更新为更精确历史事实（示例，实现可微调措辞但测试须锁语义）：

```text
pre-side-effect admission required; post-outcome recordAudit / appendNasReplicationAudit still best-effort
```

- [ ] **Step 4.1-RED:** 版本/Gold 测试先指向 V1.39 诚实句 → 红

```bash
node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

- [ ] **Step 4.1-GREEN:** 改 version/Gold/README 至绿

```bash
node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/cross-lan-m1-exit-audit.test.js
```

Expected: PASS；Gold 计数不变；M1/M2 审计文档不改仍绿。

**禁止：**

- 把 production-hardening 标 ready
- 删 e2e deny 句
- 改其它 8 个 Gold item status
- 改 master Gold plan / M1 / M2 docs
- stage `package-lock.json`

**Commit boundary（PM）：** `chore: release milestone V1.39 write-admission fail-closed`

---

## C5 — 全量 + GLM + fresh Grok closure

### Task 5.1: Full suite

```bash
npm test
```

Expected: exit 0（仅既有允许 skip）；ERROR_CODES **61**；version **V1.39**。

### Task 5.2: 对抗与验收

- [ ] GLM 抗辩：对照 design 攻击矩阵 A01–A22；无 P0
- [ ] fresh Grok 只读：对照源码 + 测试 + Gold 诚实；PROCEED YES / 签字上限未越界
- [ ] PM 最终验收：允许宣称 signature；**禁止**越界宣称

若发现 P0：停发布宣称；`fix:` 最小修复；重跑相关 boundary + `npm test`。

**Commit boundary：** 仅修复时由 PM `fix:` / `test:` commit；无修复则无额外 commit。

---

## 每阶段 RED / GREEN 速查

| Stage | RED | GREEN | 禁止项 |
| --- | --- | --- | --- |
| **C0** | n/a docs | docs 齐套 + `git diff --check` | 改 src/test/README/version/Gold；commit 若 PM 未授权 |
| **C1** | `node --test test/error-codes.test.js test/server-write-admission.test.js` 红 | 同命令 + security/audit-log/server 回归绿 | 改 route 集合；swallow required；透传 raw 5xx；合法 recoverable prepared 当 503；改 dual-write auto-recovery |
| **C2** | agent NAS 新断言红 | `test/agent-nas-snapshot-replicate.test.js` 绿 | plan-only required；SMB on fail；码覆盖；instanceof-only catch；合法 recoverable prepared 当 503 |
| **C3** | scans / 60 锁残留红 | scans + monitor + dual-write 相关绿 | 假绿扫描；删 best-effort 诚实 |
| **C4** | version/gold/readme 红 | 同文件绿；4/4/1/9 不变 | hardening ready；改 master plan |
| **C5** | n/a | `npm test` + 双模型 PASS | 越界签字 |

---

## Rollback

| Boundary | Rollback |
| --- | --- |
| C0 | 删除两份 docs |
| C1 | revert server + error-codes + admission tests |
| C2 | revert agent NAS required start |
| C3 | revert scans + 60→61 测试对齐 |
| C4 | 回 V1.38 version/Gold/README |
| 全量 | 按 boundary 逆序 revert；不触碰 package-lock |

---

## 完成检查清单（C5 后）

- [ ] Signature 仅：`V1.39 safety-critical audit write-admission fail-closed implementation`
- [ ] 6 routes 中央 gate；词法位置正确；未来表项自动覆盖
- [ ] admission 失败（unrecoverable prepared / invalid / hostile·其它 append throw）：HTTP 503 exact code；mutation 零副作用
- [ ] 合法 recoverable prepared：auto-recover + admission 成功 + mutation proceeds（字节允许 recovery+append）
- [ ] dual-write auto-recovery **未**被本版修改
- [ ] NAS execute/recover：失败 exit 1 fixed code；SMB zero-call；catch `err.code ===` 第一优先
- [ ] post-outcome / auth / rate 仍 best-effort（可证）
- [ ] ERROR_CODES **61**；current tests 无 60 锁
- [ ] Gold **blocked 4/4/1/9**；production-hardening **partial**
- [ ] `not end-to-end production audit delivery` 仍在
- [ ] V1.38 monitor 合同回归绿
- [ ] master Gold plan / M1 / M2 **未**被修改
- [ ] **not** T6d.3 complete / **not** M6d Exit / **not** production-hardening ready / **not** Gold
