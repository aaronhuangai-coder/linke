# V1.39 Safety-Critical Audit Write-Admission Fail-Closed Design

## 目标

V1.39 在 **V1.38 read-only audit integrity run-once monitor/alert** 与 **V1.37 journal-first dual-write coordinator** 之上，交付 **M6d / T6d.3 still partial** 的真实增量：

- **副作用前**（pre-side-effect）写入准入审计 **required / fail-closed**
- 覆盖：server 全部 `API_WRITE_ROUTES` 中央 gate；agent `nas-snapshot-replicate` 的 **execute/recover** 路径
- 失败统一映射注册码 **`audit-delivery-unavailable`**（HTTP 503 / CLI exit 1）

> **本版交付目标（设计阶段；实现后才算完成）：**
> - Server：auth/rate 通过后、**任何 route body parsing 或业务 mutation 前**，对 `API_WRITE_ROUTES` exact-one required admission audit
> - Agent：`nas-snapshot-replicate --execute`（含 `--recover`，因 recover 必须 execute）在任何 SMB replicate/recover 调用前 exact-one required start audit
> - Error registry：仅新增 `AUDIT_DELIVERY_UNAVAILABLE: 'audit-delivery-unavailable'`（60 → **61**）
> - post-outcome / auth denied / rate-limit / validation failure 等现有 `recordAudit` / `appendNasReplicationAudit` **诚实保留 best-effort**
>
> **签字上限（唯一允许的完成宣称）：**
> `V1.39 safety-critical audit write-admission fail-closed implementation`
>
> **定位：** 可把 **pre-side-effect write-admission required** 标为 delivered，但：
> - **T6d.3 still partial**；**not** T6d.3 complete；**not** M6d Exit；**not** Gold
> - **production-hardening = partial**；Gold **blocked 4/4/1/9**
> - **not** end-to-end audit delivery
> - **not** post-outcome audit durability
> - **not** 业务写入与审计的原子事务 / 2PC / outbox
> - **not** production-hardening ready
> - V1.38 monitor/inspector **10-key / exit 0-1-2 / zero-write** 合同 **不得改变**
> - server **仍无** monitor HTTP/Web wiring
> - **不**增加网络、scheduler、remote notification、multi-process lock、journal rotation、authenticity

### 与 master Gold plan 的对齐（只引用，不篡改）

SoT master plan：`docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md`

| Master 边界 | V1.39 对齐 |
| --- | --- |
| **M6d — production-hardening** | 本版仍 **partial**；不得标 ready |
| **T6d.3 审计链完整性与敏感字段扫描** | **still partial** 真增量：仅 pre-side-effect admission required；**not** T6d.3 complete |
| **T6d.4 监控/告警最小可用** | V1.38 已交付 run-once path；**本版不改** monitor 合同 |
| **T6d.6 负向** | 仅 hardening-status 布尔面板 **不得** ready（保持） |
| **T6d.7 脱敏 evidence** | admission 事件禁止 body/token/path/secret；响应禁止 raw err 泄漏 |
| **M6d Exit** | **否** — 本版不得宣称 |
| **M1 / M2 文档** | **不得**改写；M1 route open、M2 denied 事实保持 |

**本设计与实施计划不得修改** master Gold plan、M1/M2 文档、或把 M6d Exit / T6d.3 complete 写成已交付。

### 关键边界

| 层级 | V1.39 是否完成（实现后） | 含义 |
| --- | --- | --- |
| **pre-side-effect write admission required（server 6 write routes）** | **是** | 中央 gate；失败 503 + fixed code；mutation 零调用 |
| **pre-side-effect start admission required（NAS execute/recover）** | **是** | 失败 exit 1 + fixed code；SMB 零调用 |
| **post-outcome / denied / rate-limit / validation audit** | **否（仍 best-effort）** | 诚实保留 `recordAudit` / `appendNasReplicationAudit` catch-swallow |
| **end-to-end production audit delivery** | **否** | 严禁宣称 |
| **业务 mutation ↔ audit 原子 / 2PC / outbox** | **否** | 严禁宣称 |
| **T6d.3 complete / M6d Exit / production-hardening ready** | **否** | scorecard 仍 partial |
| **Gold / GA / V2 / cross-LAN** | **否** | Gold **blocked 4/4/1/9** |
| **V1.38 monitor 合同变更** | **否** | 10-key / 0-1-2 / zero-write 冻结 |
| **新 npm dependency / 网络 / scheduler** | **否** | Node 内置 + 既有模块 |

**能力名冻结：**

```text
FORBIDDEN as delivered claims:
  - "T6d.3 complete" / "M6d Exit" / "production-hardening ready" as delivered
  - "end-to-end production audit delivery" as delivered
  - "post-outcome audit durability" as delivered
  - "atomic business+audit transaction" / "2PC" / "outbox" as delivered
  - "Gold ready" / "V2.0 Gold/GA" as delivered
  - remote notification / managed scheduler / multi-process exclusive lock
  - authenticity / external anchor / HMAC / signature / immutable as delivered
  - V1.38 monitor contract changed (10-key / exit 0-1-2 / zero-write)

ALLOWED capability (only):
  - pre-side-effect write-admission required (fail-closed)
  - server central gate over API_WRITE_ROUTES
  - agent nas-snapshot-replicate execute/recover required start audit
  - registered error audit-delivery-unavailable (503 / exit 1)

ALLOWED signature ceiling (only):
  - V1.39 safety-critical audit write-admission fail-closed implementation
```

**角色结论（文档阶段）：** 本任务 **仅 docs（C0）**；设计阶段 `PROCEED` **≠** 实现完成。当前 worktree 事实是 **V1.38** @ `e6f2cd6`。

### C0 review gate（implementation PROCEED 前强制）

```text
C0 审查门（docs 审查；≠ 实现完成）:
  1. 本 design + 对应 plan 完稿且自洽
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
  P1) dual-write 合法 recoverable prepared → coordinator auto-recover → idle
      → admission append 成功 → mutation 可继续（非 503）。
      仅 unrecoverable prepared（recovery conflict / fingerprint mismatch / IO）、
      invalid state、hostile append throw → 503。
      禁止为假绿去改 dual-write auto-recovery 行为。
  P2) helper 统一 throw LinkeError；agent catch 第一优先
      err && err.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE
      （覆盖 LinkeError 与等价固定码对象）；先于 SmbReplicationError/generic；
      best-effort failure audit 不得覆盖固定 stderr/exit。

GLM C0 verdict (round 2): PASS (P0/P1/P2 = 0/0/0; PROCEED YES)
fresh Grok C0 verdict: PASS (P0/P1/P2 = 0/0/0; PROCEED YES)
PM C0 accept: PASS — docs boundary accepted; C1 may begin (not implementation complete)
```

---

## 1. 现状事实（V1.38 HEAD 调研冻结）

以下为 **e6f2cd6 / V1.38** 代码事实，实现不得假装已存在 required admission。

### 1.1 Server write routes

`src/server.js` 导出：

```js
export const API_WRITE_ROUTES = [
  { method: 'POST', path: '/api/heartbeat' },
  { method: 'POST', path: '/api/backups' },
  { method: 'POST', path: '/api/restore' },
  { method: 'POST', path: '/api/supervisor-lifecycle-approval-persist' },
  { method: 'POST', path: '/api/device-enrollment-codes' },
  { method: 'POST', path: '/api/device-revoke' },
];
```

`isApiWriteRoute(method, pathname)` 基于该表 exact match。

请求流水（现状）：

1. rate-limit → 拒绝时 **best-effort** `recordAudit`（`api.rate_limited`）
2. auth → 拒绝时 **best-effort** `recordAudit`（`auth.denied` / `auth.forbidden`）
3. **直接进入各 route handler**（含 `readBody` / 业务 mutation）
4. 成功/失败 outcome → 多数仍 **best-effort** `recordAudit`

`recordAudit` 现状：

```js
async function recordAudit(dataDir, event, retention) {
  try {
    await appendAuditEvent(dataDir, event, { retention });
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}
```

→ **swallow**；不阻断 mutation。

### 1.2 Outer server catch（现状漏洞点）

```js
} catch (err) {
  const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  if (statusCode >= 400 && statusCode < 500) {
    return sendError(res, statusCode, err.message);
  }
  console.error('Server error:', err.message);
  return sendError(res, 500, 'Internal Server Error');
}
```

→ 任意带 `statusCode: 503` 的普通 Error 或 **未特殊处理的 LinkeError(503)** 会落入 5xx 分支，响应被压成 **`Internal Server Error`**。
V1.39 **必须**让 `LinkeError(AUDIT_DELIVERY_UNAVAILABLE)` 精确返回 **503 + registered code**；**其他任意 5xx 仍固定** `Internal Server Error`。

### 1.3 Agent NAS execute path

`src/agent.js` `nas-snapshot-replicate`：

- 参数校验 / plan-only → 不写 required admission（现状 plan 不写 started）
- `execute === true` 时：**best-effort** `appendNasReplicationAudit`（`nas.snapshot.replication.started`，含 targetName/deviceId/snapshotId）→ 然后 `replicateSnapshotToMountedSmb` / `recoverMountedSmbSnapshot`
- `appendNasReplicationAudit`：**catch 空 swallow**
- 失败 catch：best-effort failure audit；stderr 固定业务码；**不识别** audit delivery 失败

### 1.4 Audit stack / ERROR_CODES

| 模块 | 事实 |
| --- | --- |
| `appendAuditEvent` | sanitize → retention → exact-one dual-write coordinator |
| dual-write **recoverable prepared** | 合法可恢复 prepared leftover：coordinator **auto-recover → idle**，随后 append **可成功**（**不是** admission 503 源） |
| dual-write **unrecoverable / 其它失败** | **unrecoverable prepared**（recovery conflict / fingerprint mismatch / IO）、**invalid state**、其它 dual-write/IO throw、hostile inject → append **throw**（admission 映射 503） |
| `ERROR_CODES` | **exact 60**（V1.38 闭集） |
| `LinkeError` | `message === code`（registered）；支持 `statusCode` / `retryable` |
| V1.38 monitor | 不改；closed-set 历史文档可写 60；**current tests 在 V1.39 后必须 61** |

**冻结（V1.39 不得破坏）：** dual-write coordinator 对合法 recoverable prepared 的 **auto-recovery 行为保持不变**。V1.39 只把 **append 失败** 在 caller 侧映射为 `audit-delivery-unavailable`；**禁止**为满足 admission 假绿去改 coordinator recovery 语义。

### 1.5 Gold honesty（V1.38）

`production-hardening` **partial**；summary **blocked 4 ready / 4 partial / 1 blocked / total 9**。
evidence 含：

- `not end-to-end production audit delivery`
- `server recordAudit / agent appendNasReplicationAudit best-effort catch`

V1.39 **只**更新“全部 best-effort”历史事实 → **pre-side-effect admission required；post-outcome 仍 best-effort**；并继续写 `not end-to-end production audit delivery`。
**item statuses / summary 完全不变。**

---

## 2. 选定方案

### 2.1 三方案

| 方案 | 描述 | 判定 |
| --- | --- | --- |
| **A（选定）** | 中央 write-admission gate + required helper 映射固定码；NAS execute start 改为 required；post-outcome 仍 best-effort | **SELECTED** |
| **B（拒绝）** | 端到端 audit delivery：所有 outcome 必达 + 业务与审计同事务 / outbox | 超出签字；变相 T6d.3 complete 宣称 |
| **C（拒绝）** | 仅文档/监控宣称 fail-closed，不改 caller catch | 假绿；无真实增量 |

```text
SELECTED = A pre-side-effect write-admission fail-closed (server gate + NAS execute start)
REJECTED = B end-to-end delivery / atomic business+audit
REJECTED = C docs-only / monitor-only claim without caller change
```

### 2.2 架构（实现后）

```text
HTTP API request
  ├─ rate-limit?  --denied--> best-effort api.rate_limited → 429
  ├─ auth?        --denied--> best-effort auth.* → 401/403
  ├─ isApiWriteRoute?
  │     yes → recordRequiredWriteAdmissionAudit  (REQUIRED; no swallow)
  │              ├─ success → continue to route body / mutation
  │              └─ fail    → LinkeError(audit-delivery-unavailable, 503, retryable)
  │                            outer catch → HTTP 503 + exact code only
  └─ non-write / dry-run routes → unchanged (no required admission)

nas-snapshot-replicate
  ├─ argv/config validation (no required admission)
  ├─ plan-only → buildSmbSnapshotReplicationPlan (no required admission)
  └─ execute/recover
        → recordRequiredNasReplicationStartAudit (REQUIRED)
             ├─ success → SMB replicate/recover
             └─ fail    → Error: audit-delivery-unavailable ; exit 1 ; SMB zero-call
        → result/failure audits remain best-effort appendNasReplicationAudit
```

---

## 3. 冻结合同

### 3.1 Error registry（+1 only）

```js
// src/error-codes.js — 仅新增一条
AUDIT_DELIVERY_UNAVAILABLE: 'audit-delivery-unavailable',
```

| 项 | 冻结值 |
| --- | --- |
| key | `AUDIT_DELIVERY_UNAVAILABLE` |
| value | `audit-delivery-unavailable` |
| closed-set | **60 → 61** |
| 其它新码 | **禁止** |
| HTTP | **503** |
| `retryable` | **true** |
| 响应 body | `{ "error": "audit-delivery-unavailable" }` 仅固定 code（经既有 `sendError`） |
| CLI stderr | `Error: audit-delivery-unavailable` |
| CLI exit | **1** |

`test/error-codes.test.js` 的 `EXPECTED_ERROR_CODES` / length 断言同步到 **61**。
所有 **current** 锁 60 的 tests/scans **必须**改为 61（含 V1.38 时代 runtime 断言）。
历史 **文档** 可保留 “当时 60” 叙述。

### 3.2 Server required helper

**命名冻结：** `recordRequiredWriteAdmissionAudit`

| 项 | 合同 |
| --- | --- |
| 位置 | `src/server.js`（private/async；与 `recordAudit` 并列） |
| 底层 | 调用 `appendAuditEvent`（既有 dual-write 路径）；**不** fork 新存储 |
| 成功 | resolve；**exact-one** append per call |
| 失败 | **不得 swallow**；任何 append/sanitize/dual-write throw → **统一** `throw new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, { statusCode: 503, retryable: true })` |
| 映射 catch | 允许 **仅用于 remapping**；remap 后必须 rethrow；**禁止** `return` / 空 catch / `.catch(() => {})` |
| 日志 | **禁止**输出 raw `err.message` / path / token / stack / errno / dual-write state 细节 |
| 事件 type | 固定 **`api.write.admission.started`** |
| 调用方字段 | **仅** `method`, `path`, `outcome: 'started'`, `requestId` |
| sanitize | 允许自动 `id` / `createdAt`（既有 `sanitizeAuditEvent`） |
| 禁止字段 | body、token、Authorization、sourcePath、targetPath、deviceId、snapshotId、secret、message 含路径/token、任意业务 payload |

```js
// 语义伪代码（实现须等价）
async function recordRequiredWriteAdmissionAudit(dataDir, { method, path, requestId }, retention) {
  try {
    await appendAuditEvent(dataDir, {
      type: 'api.write.admission.started',
      method,
      path,
      outcome: 'started',
      requestId,
    }, { retention });
  } catch {
    throw new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, {
      statusCode: 503,
      retryable: true,
    });
  }
}
```

**`recordAudit` 保持原样**（best-effort + 可继续 `console.error` 通用失败行，不扩大 secret 面即可）。
不得把 post-outcome 审计偷偷改成 required。

### 3.3 Server 中央 gate 词法位置

在 `createServer` 请求处理中，**auth/rate gate 之后**、**任何 write route 的 `readBody` / 业务函数之前**，插入：

```js
if (isApiWriteRoute(method, pathname)) {
  await recordRequiredWriteAdmissionAudit(
    dataDir,
    { method, path: pathname, requestId },
    auditRetention,
  );
}
```

| 规则 | 冻结 |
| --- | --- |
| 覆盖 | **全部 6** 条 `API_WRITE_ROUTES`；未来新增 write route 只要进 `API_WRITE_ROUTES` **自动**受 gate |
| 不改变 | `API_WRITE_ROUTES` 集合本身、auth/read/write token 语义、rate-limit 语义 |
| 不进入 gate | 非 write / dry-run / read-only API；auth denied；rate-limit denied；403 forbidden |
| 进入 gate 后 | admission **成功**才允许 `readBody`、heartbeat/backup/restore/approval persist/device enrollment/device revoke 的 mutation/hook |
| admission 失败 | 上述 mutation/hook **零调用**；相关持久化文件字节不变（spy + 字节断言） |

**词法顺序（强制扫描）：**

```text
rate-limit block
→ auth block
→ isApiWriteRoute + recordRequiredWriteAdmissionAudit   // central gate
→ first write-route handler body (device-enrollment / heartbeat / ...)
```

测试必须证明 gate 源码位置 **词法上** 在 route dispatch/`readBody` 之前（静态扫描，防 per-route 漏挂 / 假注释绿）。

### 3.4 Outer catch 精确映射

```js
} catch (err) {
  if (
    err instanceof LinkeError
    && err.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE
  ) {
    // 可选：不打印 raw err.message；若需日志仅固定码
    return sendError(res, 503, ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
  }
  const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  if (statusCode >= 400 && statusCode < 500) {
    return sendError(res, statusCode, err.message);
  }
  console.error('Server error:', err.message);
  return sendError(res, 500, 'Internal Server Error');
}
```

| 情况 | 响应 |
| --- | --- |
| `LinkeError(AUDIT_DELIVERY_UNAVAILABLE)` | **503** + `audit-delivery-unavailable` |
| 其它 `LinkeError` 且 4xx | 保持既有 4xx + `err.message`（= registered code）行为 |
| 任意非上述 5xx / 未识别 | **500** + `Internal Server Error`（**禁止**公开 raw） |
| 非 LinkeError 但 statusCode=503 | 仍 **500 Internal Server Error**（防伪造） |

**原则：** 只有 **该** 注册 LinkeError 才能在 5xx 通道公开 fixed code；不得开放“任意 LinkeError 5xx 透传 message”。

### 3.5 Dual-write prepared 路径语义（recoverable vs unrecoverable；admission 视角）

| 场景 | 期望 |
| --- | --- |
| cold/healthy dataDir + 合法 write | exact-one `api.write.admission.started`，然后原业务语义不变 |
| admission 成功 + invalid body | 返回原 4xx（如 `deviceId is required`）；**不得**在 admission 前因 body 失败 |
| admission 成功 + 业务成功 | 原 success audit 仍 best-effort |
| admission 成功 + 业务失败 | 原 failure audit 仍 best-effort |
| **合法 recoverable prepared** leftover | coordinator **auto-recover → idle** → admission append **成功** → exact-one admission → **mutation proceeds**；state/events/journal 字节变化 **符合 recovery + 新 append**，**禁止**断言 “字节不变” |
| **unrecoverable prepared**（recovery conflict / fingerprint mismatch / IO） | admission 失败 → 503 fixed code；6 routes mutation spy=0；业务持久化文件字节不变；响应无 path/token/raw state |
| **invalid** dual-write state | 同 unrecoverable：503 + mutation 零副作用 |
| hostile append throw（typed dual-write / untyped Error / SafeDataFileError） | **一律**映射 `audit-delivery-unavailable`（调用方不可区分底层原因）；mutation 零副作用 |

**503 失败源（穷尽，admission 视角）：** unrecoverable prepared · invalid state · hostile/typed/untyped append throw · 其它导致 `appendAuditEvent` throw 的 IO/sanitize 失败。
**不是 503 失败源：** bare / 合法 recoverable prepared（auto-recover 成功路径）。

### 3.6 Agent required start audit

**命名冻结：** `recordRequiredNasReplicationStartAudit`（`src/agent.js` private）

| 项 | 合同 |
| --- | --- |
| 触发 | `execute === true`（含 `recover === true`，因 recover 必须 execute） |
| 时机 | **任何** `replicateSnapshotToMountedSmb` / `recoverMountedSmbSnapshot` 调用前 |
| 不触发 | 参数校验失败；plan-only（无 `--execute`） |
| 事件 type | 保持既有 **`nas.snapshot.replication.started`**（真实增量 = required，不是新 type 刷分） |
| 字段 | 与现状 started 对齐：`type`, `outcome: 'started'`, `targetName`, `deviceId`, `snapshotId`（allowlist；经 sanitize） |
| 禁止 | body/token/secret/raw path/stack 进入事件或 stderr |
| 底层 | `appendAuditEvent`（**不**走 swallow 的 `appendNasReplicationAudit`） |
| helper 抛出 | **统一** `throw new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, { statusCode: 503, retryable: true })`（实现不得 swallow） |
| catch 识别 | **第一优先** `err && err.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE`；覆盖 `LinkeError` **与** 任意等价固定码对象；**不得**要求 `instanceof LinkeError` 才识别 |
| 失败出口 | **exit 1**；stderr **仅** `Error: audit-delivery-unavailable` |
| SMB | admission 失败时 real SMB helper **zero-call**；目标目录字节不变 |
| post | result / failure 仍 `appendNasReplicationAudit` **best-effort** |
| 码覆盖 | 该分支内 optional best-effort failure audit **不得**改写 stderr 文案或 exit code；**不得**落入 `nas-snapshot-replicate-failed` 覆盖路径 |

```text
catch 优先级（execute/recover 路径；顺序强制）:
  1) FIRST: err && err.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE
       （LinkeError 或等价固定码对象；FORBIDDEN: 仅 instanceof LinkeError 才识别）
       → optional best-effort failure audit (errorCode 固定码；不得改 stderr/exit)
       → console.error('Error: audit-delivery-unavailable'); process.exit(1)
  2) THEN: err instanceof SmbReplicationError
       → 既有 best-effort + Error: <code> + exitCode
  3) ELSE: other
       → 既有 best-effort + nas-snapshot-replicate-failed + exit 1
```

### 3.7 诚实边界（post-audit）

| 路径 | V1.39 后 |
| --- | --- |
| write admission / NAS execute start | **required** |
| auth.denied / auth.forbidden / api.rate_limited | **best-effort**（保持） |
| api.\*.success / failure / created 等 outcome | **best-effort**（保持） |
| NAS planned / completed / failed / recovery_required | **best-effort**（保持） |
| monitor / inspector | **不变** |

Gold / README（C4 才改代码）必须同时出现：

- `pre-side-effect admission required`
- `post-outcome still best-effort`（或等价诚实措辞）
- `not end-to-end production audit delivery`

**禁止**删掉 best-effort 诚实句后只留 required，造成 e2e 假绿。

### 3.8 V1.38 不变量（回归锁）

| 不变量 | 要求 |
| --- | --- |
| monitor report keys | 仍 **exact 10-key** 顺序合同 |
| monitor exit | **0 / 1 / 2** |
| monitor zero-write | 全路径无 events/journal/state 字节变化 |
| server monitor HTTP/Web | **无** |
| ERROR_CODES 除 +1 外 | 无其它增删改 |
| Gold summary | **blocked 4/4/1/9** 不变 |
| execution flags | 全局 false 保持 |
| package-lock.json | **永不** stage / 不读作实现输入 |

---

## 4. 攻击矩阵（TDD 必须覆盖）

| ID | 攻击 / 场景 | 期望 |
| --- | --- | --- |
| A01 | 6 write routes 未挂 gate / 只挂部分 | **FAIL** — 中央 `isApiWriteRoute` gate；词法在 dispatch 前 |
| A02 | 未来新增 `API_WRITE_ROUTES` 项 | 自动进入 gate（表驱动测试） |
| A03a | **合法 recoverable prepared** leftover | coordinator auto-recover → admission **成功**；exact-one admission；mutation **proceeds**；字节变化 = recovery + 新 append（**禁止** unchanged 断言） |
| A03b | **unrecoverable prepared**（先真实 prepared，再破坏 events/journal fingerprint 致 recovery conflict；或 IO 使 recovery 失败） | 503 + exact code；mutation spy=0；业务文件字节不变；无 path/token/raw state 泄漏 |
| A04 | **invalid** dual-write state | 同 A03b（503；mutation 零副作用） |
| A05 | hostile typed append throw（其它 LinkeError） | 仍映射 admission 固定码（不泄漏原 code 到 HTTP body 作为“内部真相”以外的混杂）——HTTP body **仅** `audit-delivery-unavailable` |
| A06 | hostile untyped Error / errno / path message | 503 fixed code；无 path/token/stack 泄漏 |
| A07 | healthy cold 每请求 | exact-one admission event，业务语义不变 |
| A08 | invalid body | 仅 admission 成功后原 4xx |
| A09 | GET/read-only/dry-run | **不**进入 required gate |
| A10 | auth denied / rate-limit | **不**进入 required gate；原 best-effort 审计保持 |
| A11 | outer catch 任意 5xx Error | 仍 `Internal Server Error` |
| A12 | outer catch：helper 抛出的 `LinkeError(AUDIT_DELIVERY_UNAVAILABLE)` | 精确 503 + registered code |
| A13 | NAS execute admission fail（**unrecoverable prepared** / invalid / hostile；**非** recoverable prepared） | SMB zero-call；目标字节不变；exit 1 fixed code |
| A14 | NAS recover admission fail（同 A13 失败源限定） | 同 A13 |
| A14b | NAS execute + **合法 recoverable prepared** | auto-recover 后 required start 成功；随后 SMB 路径按原语义（非 admission 503） |
| A15 | NAS plan-only | 不强制写 required admission |
| A16 | required 失败后 best-effort failure log | 不得覆盖 fixed stderr/exit；catch 第一优先 `err.code === AUDIT_DELIVERY_UNAVAILABLE`（**非**仅 `instanceof`） |
| A17 | 静态：comment/string/dead helper / `\|\| true` 假绿 | scans 拒绝 |
| A18 | required helper production call exact-one；禁止 catch swallow / `.catch` | scans 锁定 |
| A19 | post-audit 诚实：server `recordAudit` / agent `appendNasReplicationAudit` 仍存在 catch | honesty tests |
| A20 | ERROR_CODES exact **61**；current tests 无 length===60 | closed-set tests |
| A21 | V1.38 monitor 合同回归 | 10-key / 0-1-2 / zero-write 绿 |
| A22 | Gold statuses 不变；仅 honesty 事实句更新 | gold-readiness tests |

---

## 5. 文件影响面（实现阶段；C0 不改）

| 文件 | C? | 变更 |
| --- | --- | --- |
| `docs/superpowers/specs/2026-07-20-audit-write-admission-fail-closed-design.md` | C0 | 本设计 |
| `docs/superpowers/plans/2026-07-20-audit-write-admission-fail-closed.md` | C0 | 实施计划 |
| `src/error-codes.js` | C1 | +1 code |
| `src/server.js` | C1 | helper + gate + outer catch |
| `test/error-codes.test.js` | C1 | 61 + new code |
| `test/server-write-admission*.test.js`（新建名由 plan 冻结） | C1 | RED→GREEN 行为 |
| `src/agent.js` | C2 | required NAS start + catch 优先级 |
| `test/agent-nas-snapshot-replicate*.test.js` / 扩展 | C2 | execute/recover admission |
| scans / honesty tests | C3 | 静态 + 60→61 + post best-effort |
| `src/version.js` / `src/gold-readiness.js` / `README.md` / version tests | C4 | V1.39 诚实 |
| 全量 + GLM + fresh Grok | C5 | 闭环 |

**明确不改（本版）：**

- master Gold plan、M1/M2 docs
- `API_WRITE_ROUTES` 成员集合（除非未来任务单独扩展；本版集合不变）
- audit integrity journal/dual-write/monitor 核心算法与 **auto-recovery**（合法 recoverable prepared 仍 auto-recover；V1.39 不改 coordinator；仅 caller 映射 **append throw**）
- web panel / HTTP monitor
- `package-lock.json`（不读、不 stage）

---

## 6. 测试策略（摘要）

1. **C1 RED：** 无 gate 时 write + **unrecoverable/invalid/hostile** audit failure 仍可能 mutation → 必须先红
2. **C1 GREEN：** gate + helper + outer catch + error registry；含 **recoverable prepared 正向** 与 **unrecoverable 503**
3. **C2 RED/GREEN：** NAS execute/recover（同样区分 recoverable vs unrecoverable；catch `err.code ===`）
4. **C3：** 静态扫描 + closed-set 61 + honesty
5. **C4：** version/Gold/README
6. **C5：** `npm test` + 抗辩 + fresh Grok

临时盘：**仅** `mkdtemp(join(tmpdir(), ...))`。
禁止依赖开发者机器上的真实 NAS / 网络。

---

## 7. 风险与非目标

### 7.1 风险

| 风险 | 缓解 |
| --- | --- |
| outer catch 漏映射 → 503 变 500 假失败码 | A12 单测锁 `LinkeError(AUDIT_DELIVERY_UNAVAILABLE)` 分支 |
| 过宽透传任意 LinkeError 5xx | 仅 AUDIT_DELIVERY_UNAVAILABLE 特例 |
| per-route 手写 admission 漏挂 | 强制中央 `isApiWriteRoute` + 词法扫描 |
| 把 post-outcome 也改 required 扩大范围 | 签字上限 + honesty tests |
| 锁 60 的历史测试残留 | C3 全库 rg 清零 current `length, 60` |
| 误把 **合法 recoverable prepared** 当 503 / 断言字节不变 | A03a 正向用例；**禁止**改 dual-write auto-recovery |
| unrecoverable fixture flaky | 冻结：真实 prepared + 破坏 events/journal fingerprint → recovery conflict；或 invalid state |
| dual-write 并发 / multi-process | 沿用单进程 queue；本版不宣称 multi-process |
| agent catch 仅 `instanceof` 漏识别等价码对象；顺序错误覆盖固定码 | A16：`err.code ===` 第一优先，先于 SmbReplicationError/generic |

### 7.2 非目标（完整列表）

- T6d.3 complete / M6d Exit / production-hardening ready / Gold
- end-to-end audit delivery / post-outcome durability
- 业务与审计原子事务 / 2PC / outbox / 跨进程可靠投递
- 改变 V1.38 monitor/inspector 合同
- server monitor HTTP/Web、remote notification、scheduler
- multi-process lock、journal rotation、authenticity/HMAC/anchor
- 新增除 `audit-delivery-unavailable` 外任何 ERROR_CODES
- 修改 `API_WRITE_ROUTES` 集合或 auth 语义
- 修改 master Gold plan / M1 / M2 文档

---

## 8. 完成定义（实现后签字）

**仅当**同时满足才可宣称：

```text
V1.39 safety-critical audit write-admission fail-closed implementation
```

检查清单：

- [ ] 6 write routes 中央 gate；词法在 body/mutation 前
- [ ] admission 失败（**仅** unrecoverable prepared / invalid / hostile·其它 append throw）→ 503 + `audit-delivery-unavailable` + retryable 语义；mutation 零副作用
- [ ] **合法 recoverable prepared** → auto-recover + admission 成功 + mutation proceeds（字节允许 recovery+append 变化）
- [ ] dual-write auto-recovery 行为 **未**被本版修改
- [ ] healthy 路径 exact-one admission + 原业务语义
- [ ] NAS execute/recover required start；失败 exit 1 fixed code；SMB zero-call；catch 用 `err.code ===` 第一优先
- [ ] plan-only / auth denied / rate-limit 不进 required gate
- [ ] post-outcome 仍 best-effort（诚实可证）
- [ ] ERROR_CODES **61**；无其它新码
- [ ] Gold **blocked 4/4/1/9**；production-hardening **partial**
- [ ] 继续 `not end-to-end production audit delivery`
- [ ] V1.38 monitor 合同回归绿
- [ ] **not** T6d.3 complete / **not** M6d Exit / **not** production-hardening ready / **not** Gold

---

## 9. 文档控制

| 项 | 值 |
| --- | --- |
| 设计 SoT | 本文件 |
| 实施 plan | `docs/superpowers/plans/2026-07-20-audit-write-admission-fail-closed.md` |
| Master Gold 引用 | `docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md`（M6d / T6d.3 / T6d.6 / T6d.7） |
| 前置版本 | V1.38 @ e6f2cd6 |
| C0 范围 | **仅**本 design + plan；不改 src/test/README/version/Gold；不 commit/push |
