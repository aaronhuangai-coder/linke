# Linke V1.41 G0b — Resumable Manifest v2 Snapshot Upload Design

| 字段 | 值 |
| --- | --- |
| 文档类型 | 产品/架构设计（spec）— **PROPOSED / PLAN ONLY** |
| 里程碑 | **V1.41 G0b** resumable manifest v2 snapshot upload |
| 文档状态 | **C0 docs-only**；本轮不改 `src/` / `test/` / README / package / version / Gold |
| 基线 HEAD | `4064cd14b3c3ca9c1b26b9b515f9714cf82c7b2a` |
| 基线工作区 | 仅 `?? package-lock.json`（**绝对禁止**读取/修改/暂存） |
| 关联 plan | `docs/superpowers/plans/2026-07-22-linke-v141-g0b-resumable-snapshot-upload.md` |
| 权威上游 | `docs/superpowers/specs/2026-07-13-linke-gold-single-mac-release-design.md`（G0b / Upload Session / 并发背压）；`docs/superpowers/plans/2026-07-13-linke-gold-execution-roadmap.md`（G0a→G0b→G0c） |
| G0a 证据 | `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md` = **same-LAN dual-Mac PASS**（历史证据，**不得改写**） |
| V2 Noise | M1 gate **BLOCKED**；M2 **denied**。本 G0b **仅** same-LAN G0a TLS 数据面，不选择、不修改、不绕过 M1/M2 |
| 当前版本常量 | `LINKE_RELEASE_VERSION = 'V1.40'`（`src/version.js`） |
| G0b 完成后版本 | **常量**仅允许：`LINKE_RELEASE_VERSION = 'V1.41'`。**独立 release signature**（README / Gold evidence / tests 文案）才是：`V1.41 G0b resumable manifest v2 snapshot upload implementation`。禁止把完整 signature 写入 `LINKE_RELEASE_VERSION` 字符串值 |
| 当前 Gold | overall **blocked**；counts **ready 4 / partial 4 / blocked 1 / total 9**（**4 / 4 / 1 / 9**）。G0b 自动实现**不得**抬升 9-item statuses |

> **诚实声明（冻结）**
> 本文档是 **PROPOSED design**。任何文中 API、schema、错误码、文件布局在 C1+ 落地前均视为**未实现**。
> **不得**将本设计、未完成实现或同进程 fixture 描述为 “G0b real-LAN complete”、“Gold ready” 或 “GA”。
> G0a same-LAN PASS **不**自动证明 G0b upload real-LAN PASS。

---

## 1. 目标与非目标

### 1.1 目标（G0b 充分必要）

在 G0a 已冻结的 **same-LAN TLS + Keychain device token** 数据面上，完成端点 → 控制器的 **可恢复 manifest v2 snapshot 上传闭环**：

1. **不可变上传 session**
   身份 `(deviceId, snapshotId, manifestDigest, uploadId)`；状态机
   `initialized → receiving → verifying → committed`，冲突/完整性失败可进入 terminal `aborted`。
2. **控制器权威 manifest v2**
   精确键投影、UTF-8 字节序路径排序、SHA-256 canonical digest；**不信任**客户端自报 digest。
3. **固定 8 MiB chunk + contiguous resume**
   每文件 contiguous confirmed boundary；断连后可恢复；exact duplicate 幂等 ACK；future/out-of-order 拒绝且不推进。
4. **原子提交 + 读者契约**
   全部 chunk 到齐 → 逐文件 fd hash/size → 总量复核 → snapshot lock → 同文件系统 staging publish；**所有 snapshot readers**（含 `listSnapshots`、`getSnapshotManifest`、`restoreSnapshot` 及任何等价 direct reader）对 remote-upload snapshot **只**把 valid `COMPLETED.json`（`origin=remote-upload` + digest 一致）视为可读/可列/可恢复；pending final、corrupt/missing marker、stale remote index **一律 fail-close**，不得返回 manifest/files。
5. **并发与背压**
   同设备同时最多一个 upload；per-device / per-session / per-snapshot locks；全局 active transfer 默认 **4**，有效配置范围 **仅 1..16**（可下调不可放大硬顶）；配置 `<1` 或 `>16` 时构造/启动 **fail-closed 拒绝**（禁止静默钳制）；运行时超限 `upload-backpressure` + bounded `Retry-After`。
6. **脱敏与越权**
   跨设备 session/status/chunk/finalize 100% deny；响应/日志/证据不含 path、host/IP、token、fingerprint、raw errors。
7. **自动验收**
   pure + hostile + TLS listener + child-process endpoint harness；若真实第二 Mac 当期不可用，**可提交代码**，但 **real-LAN evidence 与 Gold 不得提升**。

### 1.2 明确非目标

| 非目标 | 说明 |
| --- | --- |
| cross-LAN / Noise / E2EE | V2 M1 BLOCKED；本阶段不实现、不选型、不绕过 |
| G0c restore | 不可变恢复任务、端点 staging/publish 属下一阶段 |
| G1 SMB | 不读写 NAS / smbfs |
| G2 Retention 自动删除 | G0b 禁止自动删除过期 session；仅 fail-close 并保留记录 |
| G3 scheduler | 不调度自动备份上传 |
| G4 multi-process lifecycle | 不宣称 cross-process / distributed lock |
| G5 角色/审计链扩展 | 复用现有脱敏错误；不扩三角色 |
| Gold / GA 抬升 | 自动实现不得改 9-item statuses；真实 LAN 报告仅在硬件通过后创建 |
| 管理面上传 | 上传只走 Agent listener，不进 loopback Web/API |
| 客户端 path 作为存储 SoT | 目录一律由服务端 device slug + uploadId/fileIndex 导出 |
| 复用 `DATA_RESUME_EXHAUSTED` | V2 Noise 错误码；G0b 使用独立 `upload-resume-exhausted` |

### 1.3 G0b 完成信号（路线图冻结）

来自 `linke-gold-execution-roadmap`：

> 断连恢复、损坏拒绝、跨设备越权测试及**真实 LAN 上传**。

拆分诚实边界：

| 信号 | 自动实现可宣称 | 真实硬件门 |
| --- | --- | --- |
| 断连 resume + 损坏拒绝 + 跨设备越权（自动测试） | 是（implementation complete） | 否 |
| 真实第二 Mac / 隔离 VM LAN 上传 | 否（report absent 时） | 是（PASS 报告后） |
| Gold / “G0b real-LAN complete” | **否**，除非真实报告生成并通过 | 是 |

---

## 2. 方案比较与裁决

### 2.1 传输协议

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | 在现有 G0a Agent HTTPS listener 上扩展固定 JSON/binary routes；chunk 固定 8 MiB；session 持久化到 dataDir | **采用** |
| B | 新建 WebSocket / 自定义流协议 | **拒绝** — 增加实现面与防火墙不确定性；与 G0a TLS/token 契约不一致 |
| C | multipart/form-data 单次上传 | **拒绝** — 无法干净 resume；path 易泄漏到 MIME headers |
| D | 把文件 path 放进 URL 或 header | **拒绝** — 日志/代理泄漏；path 只存在于已验证 manifest 映射 |
| E | 信任客户端 manifestDigest / deviceId 作为目录 SoT | **拒绝** — 设备作用域仅由 registry 认证绑定 |

### 2.2 Session 持久化

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | 每 session 目录下 atomic JSON state + 隐藏 staging chunks；dataDir 本地 APFS | **采用** |
| B | 仅内存 session | **拒绝** — 控制器重启不可 resume |
| C | SQLite / 外部 DB | **拒绝** — 零依赖约束；新增运行时依赖禁止 |

### 2.3 Chunk 身份

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | `fileIndex`（manifest `files[]` 下标）+ `chunkIndex` + `offset` + `size` + `sha256`；path 不进 wire | **采用** |
| B | path + chunkIndex | **拒绝** — URL/header 泄漏与编码歧义 |
| C | 仅 content-hash 寻址 | **拒绝** — 无法表达 contiguous boundary 与 empty-file 语义 |

### 2.4 哈希与 digest 权威

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | 控制器 exact-key canonical projection → UTF-8 byte path sort → SHA-256；客户端自报 digest 仅对齐检查，**不一致唯一** `upload-manifest-invalid`（**禁止**强制新身份继续） | **采用** |
| B | 信任客户端 digest | **拒绝** |
| C | 非确定性 JSON.stringify | **拒绝** — 键序/空白不稳定 |

### 2.5 并发锁范围

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | 单进程内 per-device / per-session / per-snapshot 锁 + 全局 active transfer 信号量（默认 4） | **采用**（诚实：非跨进程） |
| B | 本阶段宣称 flock 跨进程分布式 | **拒绝** — G4 lifecycle 前证据不足；可在实现中**预留**文件锁钩子，但不写进完成宣称 |

---

## 3. 现状基线（只读事实）

### 3.1 G0a 可复用资产

| 模块 | 冻结能力 | G0b 用法 |
| --- | --- | --- |
| `src/agent-listener.js` | HTTPS TLS-only；enroll / heartbeat / rotate；`MAX_AGENT_JSON_BODY_BYTES = 64 KiB`；Bearer exact-one via `rawHeaders`；auth-before-body 模式；固定 404；现 `requestTimeout=15s` / `headersTimeout=10s` | 扩展 upload routes + path-aware limiter + per-route reader deadlines；**不得**偷读 registry 私有 dataDir |
| `src/device-client.js` | pinned TLS；Keychain token；`requestPinnedJson` | 新增 bounded binary request；复用 pin/token；处理 429 双码 |
| `src/device-registry.js` | digest-only token；`authenticate` → 绑定 `deviceId` | 认证得到的 `deviceId` 是唯一 scope SoT |
| `src/controller-runtime.js` | 双 listener；`ensureSafeDataRoot`；组装 registry/identity | **唯一**生产装配点：创建 upload store/locks/service 并注入 `createAgentListener` / `agentServerFactory`（C6 暴露 public routes 时） |
| `src/storage.js` | local snapshot manifest v2；`slugify` / `safeDevicePath`（`repo/devices/<slug>`）；`listSnapshots` / `getSnapshotManifest` / `restoreSnapshot` | commit 后幂等 upsert 索引；**全部** remote-upload direct readers 以 valid COMPLETED+digest 为唯一可读边界（pending/corrupt/stale fail-close）；旧 local 不要求 marker |
| `src/safe-data-files.js` | root-relative / no-follow / O_NOFOLLOW / atomic write | 全部 upload I/O 必经 |
| `src/error-codes.js` | 当前 **62** 个注册码 | C1 新增 12 个 `upload-*`（协调 count → **74**） |

### 3.2 现有 local manifest v2 形状（兼容锚点）

本地 `createBackup` 写入：

```text
schemaVersion: 2
snapshotId, deviceId (slug), createdAt, hostname, ipAddress, sourcePath
files: string[]
integrity: { algorithm: 'sha256', totalBytes, entries: [{ path, size, sha256 }] }
```

G0b **上传线**的 canonical manifest 是控制器权威投影（见 §5）；`hostname`/`sourcePath` 为 §5.2 **可选**（sourcePath opaque）；**`ipAddress` 禁止**进入上传 canonical/create body（仅属既有 heartbeat/local 元数据）。`sourcePath` 在上传路径仅为 endpoint **opaque metadata**（可持久化，**绝不** controller resolve/open，不进错误/日志/证据）。

### 3.3 不得触碰

- `package-lock.json`（未跟踪；禁止任何操作）
- G0a 真实报告正文
- V2 Noise M1/M2 ADR 与相关 contract（本阶段 docs 也不得改写其结论）
- Gold 9-item statuses（C8 仅在真实 LAN PASS 后才允许**评估**是否更新证据引用；默认 **不** 改 status）

---

## 4. Session / 状态机

### 4.1 不可变身份

```text
UploadSessionIdentity = {
  deviceId,        // 仅来自 registry.authenticate 返回值
  snapshotId,      // UUID-like，见 §5
  manifestDigest,  // 控制器计算的 64 lower-hex SHA-256
  uploadId         // 控制器 randomUUID()，客户端不可指定
}
```

任一字段变化 → **必须**新 session（不得“修复”旧 session 身份）。

### 4.2 状态机

```text
                    ┌──────────────────────────────────────┐
                    │                                      │
                    v                                      │
              initialized ──► receiving ──► verifying ──► committed
                    │             │             │
                    │             └──────┬──────┘
                    │                    v
                    └────────────►    aborted
```

| 状态 | 含义 | 可进入 | 可离开 |
| --- | --- | --- | --- |
| `initialized` | manifest 已验证、容量预检通过、session record 原子创建；尚无 confirmed chunk | create 成功 | 首个合法 chunk → `receiving`；冲突 → `aborted` |
| `receiving` | 正在按 contiguous 顺序接收 chunk | chunk ACK | 全部到齐 → `verifying`；完整性/身份冲突 → `aborted` |
| `verifying` | 全量 fd 复验中 | 内部 | 成功 → `committed`；失败 → `aborted` |
| `committed` | snapshot 已原子发布；**terminal** | finalize 成功 / crash 恢复到 terminal | 不可离开 |
| `aborted` | 冲突或完整性失败；**terminal**；不可 resume | 任何冲突路径 | 不可离开 |

**单调性：** terminal 不可回退；`committed` 与 `aborted` 互斥；状态推进必须经 session 锁 + atomic state write。

### 4.3 TTL 与 active 判定（冻结）

- 默认 **24h**，从 `createdAt` 起算（wall clock；时钟回拨 fail-close 为 **唯一** `upload-session-expired`）。
- 对过期 session 的 chunk/status/finalize/abort（非 create）：**fail-close** `upload-session-expired`；**保留** session 记录与 staging（**G0b 禁止自动删除**）。
- **Active nonterminal** 定义（用于“同设备同时最多一个”）：
  `status ∈ {initialized, receiving, verifying}` **且** `now < createdAt + 24h`。
  **过期 session 不再算 active**，故同设备在过期后可 **create 新 session**，无需等 Retention；旧记录/staging 仍保留。
- 清理由 **G2 Retention** 独立计划处理，且不得触碰 `committed` snapshot 数据。

### 4.3.1 显式 abort（防 24h 自锁；无新错误码）

冻结新增 authenticated route：

```text
POST /agent/upload/sessions/:uploadId/abort
```

规则：

1. 与其它 upload routes 相同：**auth-before-lookup**（§6.0 三元组）；认证成功后才 lookup。
2. `initialized|receiving|verifying` → 转为 terminal `aborted`（atomic）；staging 保留至 Retention。
3. 已 `aborted` → **幂等** 返回 aborted 安全摘要。
4. 已 `committed` → **不可 abort** → **唯一** `upload-commit-conflict`（**不**新增错误码、**不**映射其它冲突码）。
5. 过期 nonterminal → `upload-session-expired`（记录保留）。
6. 同设备 create 若已有 **active** session → `upload-session-conflict`，响应可含**本设备** active locator（`uploadId` + status + snapshotId + manifestDigest 安全字段 only）；**禁止**跨设备泄露。
7. 客户端 journal 可选择 resume 该 active session；**显式 abort 后**允许新 create。
8. 客户端 **不得**自动抢占仍在推进的**不同 snapshotId** active session → fail-close `upload-session-conflict`（需用户/上层显式 abort）。

### 4.4 Resume 语义

客户端（或 status 查询）提交同一 `uploadId` + 认证 `deviceId` + 期望 `snapshotId` + `manifestDigest`：

**成功响应（安全字段 only）：**

```json
{
  "uploadId": "...",
  "snapshotId": "...",
  "manifestDigest": "...",
  "status": "receiving",
  "files": [
    {
      "fileIndex": 0,
      "size": 123456,
      "confirmedBytes": 8388608,
      "confirmedChunks": 1,
      "complete": false
    }
  ],
  "missingSummary": {
    "incompleteFileCount": 1,
    "remainingBytes": 123456,
    "next": { "fileIndex": 0, "chunkIndex": 1, "offset": 8388608 }
  },
  "expiresAt": "..."
}
```

冻结规则：

1. **per-file contiguous confirmed boundary**：只报告已连续确认的前缀字节；中间空洞不存在（协议禁止 out-of-order 推进）。
2. **missing summary** 只含计数 + 建议 next 坐标；**不含 path**。
3. 身份/digest 不一致映射（**唯一码；禁止“或”**）：
   - create：客户端自报 `manifestDigest` ≠ 控制器 canonical → **`upload-manifest-invalid`**（**禁止**强制新身份继续）。
   - create：manifest/body `deviceId` ≠ authenticated `deviceId` → **`upload-manifest-invalid`**。
   - 同设备 active 且不同 snapshot/digest → **`upload-session-conflict`**（见 §4.3.1 / §5.5）。
   - status/finalize/abort：认证成功后跨 device 或 scope 内不存在 → **`upload-session-not-found`**（不泄漏他设备存在性）。
4. terminal `committed`：resume/status 返回 committed 安全摘要；finalize 幂等。
5. terminal `aborted` / expired：不可 resume 上传；返回对应错误码。

### 4.5 Crash reconciliation 窗口

**窗口定义：** chunk 内容文件已 publish 到 staging，但 session state 的 confirmed boundary **尚未** atomic 推进。

**规则（冻结）：**

1. resume **不得**盲信“文件存在即已确认”。
2. 对每个文件，仅信任 state 中的 `confirmedBytes`。
3. 若 staging 上存在 **exact expected next chunk** 文件，resume/reconcile 必须 **重新 hash** 该文件；仅当 size + sha256 与期望完全一致时，才可推进 boundary 并 ACK。
4. hash 不匹配或 size 不符 → 删除/忽略该幽灵 chunk（实现选固定策略：标记 orphan 待 G2 清理，不计入 confirmed），不推进。
5. 不得用目录 listing 顺序推断确认状态。

---

## 5. Manifest v2（控制器权威）

### 5.1 输入与投影

客户端 create body 携带 manifest 对象（及可选自报 digest）。控制器：

1. 拒绝非 plain object、array、null、hostile prototype getters（`Object.create(null)` 可接受；有污染原型的必须 fail-close）。
2. **exact-key canonical projection**（仅保留允许键；未知键 → `upload-manifest-invalid`）。
3. 校验语义（§5.2）。
4. 对 `files` / `integrity.entries` 按 path 的 **UTF-8 字节序**排序（与 `storage.js` `compareUtf8Bytes` 同语义）。
5. 计算 `manifestDigest = SHA-256(canonicalUtf8Json)`，**忽略**客户端 digest 作为权威；若客户端提供 digest 且与 canonical **不一致** → **唯一** `upload-manifest-invalid`；**禁止**“强制新身份继续”、**禁止**静默改用服务端 digest 创建同请求 session。

### 5.2 Canonical 字段（上传线）

```text
{
  "schemaVersion": 2,
  "snapshotId": "<uuid-like>",
  "deviceId": "<authenticated deviceId>",
  "createdAt": "<ISO-8601>",
  "hostname": "<string, optional normalized>",   // 可选；有界；不得在错误中回显
  "files": [ "<relative-path>", ... ],
  "integrity": {
    "algorithm": "sha256",
    "totalBytes": <safe integer>,
    "entries": [
      { "path": "<relative-path>", "size": <safe integer>, "sha256": "<64 lower hex>" }
    ]
  },
  "sourcePath": "<opaque string, optional>"   // 可选；永不 resolve；见 §5.6
}
```

**字段冻结（上传线；非开放项）：**

- `hostname`：**可选**；进入 canonical 时有界规范化；**不得**在错误/日志/证据中回显。
- `sourcePath`：**可选 opaque**；规则见 §5.6（永不 resolve/open）。
- **`ipAddress`：禁止**进入 upload canonical manifest / create body；它**只**属于既有 device heartbeat / local storage 元数据（§3.2 local 形状可含）。上传路径 **不得**从 payload 接受、投影、持久化或回显 `ipAddress`；出现 → `upload-manifest-invalid`。

**Canonical JSON 规则（冻结）：**

- UTF-8；无多余空白；键顺序固定为上述投影顺序。
- `files` 与 `entries` 已按 path UTF-8 字节序排序且一一对应（`files[i] === entries[i].path`）。
- 数字为 JSON number 且为 **Number.isSafeInteger**；禁止浮点、NaN、Infinity、字符串数字。
- digest / sha256 必须 `^[a-f0-9]{64}$`（小写）。

### 5.3 硬限制

| 限制 | 值 |
| --- | --- |
| manifest body | ≤ **8 MiB**（create route 独立上限；≠ 64 KiB enroll/heartbeat） |
| file count | ≤ **100_000** |
| 单文件 size | ≤ **512 GiB**（`512 * 1024**3`，safe integer 范围内） |
| totalBytes | ≤ Number.MAX_SAFE_INTEGER，且等于 entries sizes 之和 |
| path UTF-8 bytes | ≤ **1024** / path |
| path 唯一 | 排序后相邻不可等；集合无重复 |

> **与 `DEFAULT_MAX_HASH_BYTES`（当前 512 MiB）的关系：**
> G0b 上传管线必须使用 **显式 elevated / streaming hash 边界**（或分 chunk 已验证后 finalize 仅聚合），不得静默依赖 512 MiB 默认导致“协议允许但实现截断”。C4 必须把该协调写进测试；禁止为“图方便”全局放开所有 safe-read 默认值而不加审计。

### 5.4 Path 安全

每个 path 必须是**规范安全相对路径**：

- 非空；无空段；无 `.` / `..` 段；
- 无反斜杠 `\`；无 NUL；无 C0/C1 control（含 `\n` `\r`）；
- 非绝对路径；不以 `/` 开头；
- 与 `normalizeRelativeDataPath` 精神一致，但 **manifest path** 额外限制 UTF-8 byte length ≤ 1024；
- 唯一。

### 5.5 deviceId / snapshotId

- `deviceId` **必须**与 `registry.authenticate` 返回值 **字符串全等**；manifest 内 deviceId 或请求体 deviceId **不能**决定服务端目录。
- `snapshotId`：**UUID-like** — 推荐冻结为
  `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`（小写规范化后存储）。
- 相同 `snapshotId` 已 `committed` 且 digest 不同 / device 不同 → `upload-commit-conflict` fail-close。
- 相同 `snapshotId` + 相同 digest + 同 device 的重复 create：返回既有 session（若未过期且状态兼容）或 committed 幂等摘要（C2 锁死精确表）。

### 5.6 sourcePath

- 类型：string 或省略；长度有界（建议 ≤ 4096 UTF-8 bytes；C1 钉死具体上限数值，不改变 opaque/永不 resolve 语义）。
- **opaque only**：可写入 session/manifest 持久化字段。
- **禁止**：`fs` open/stat/resolve、拼进错误 message、日志、证据、HTTP 响应。

---

## 6. Chunk / Resume 协议

### 6.0 全部 authenticated upload routes 的认证顺序（冻结）

现有 `registry.authenticate({ deviceId, token, protocolVersion })` **不能**仅凭 Bearer token 反查 `deviceId`。因此 **create / status / chunk / finalize / abort** 全部必须在 **读取 create/chunk body 或 lookup uploadId 之前**完成认证。

**所有 authenticated upload routes**（create、status、chunk、finalize、**abort**）强制 rawHeaders exact-one（大小写不敏感计数）三元组：

| Header | 语义 |
| --- | --- |
| `Authorization: Bearer <token>` | exact-one Bearer；token 输入 |
| `X-Linke-Device-Id` | 认证输入候选 deviceId；**不是** storage scope SoT |
| `X-Linke-Protocol-Version` | **mandatory** current/N-1 整数（字符串形式须可严格解析为整数；C6 钉死 wire 字符串形态，不改认证顺序） |

**顺序（冻结）：**

0. **Path-aware pre-auth IP limiter**（§6.6）— 先于 auth，命中则 `device-rate-limited`，不读 body、不查 session。
1. 解析并校验上述三元组 + Bearer 形态（失败 → `device-token-invalid` / `device-request-invalid` / `device-protocol-unsupported`，**不**读 body、**不**查 session）。
2. `registry.authenticate({ deviceId: headerDeviceId, token, protocolVersion })`。
3. **仅**认证成功返回的 `deviceId` 是 storage / session scope 的 **唯一 SoT**。
4. 之后才允许：lookup `uploadId`、读取 create/chunk body、读取 finalize/abort 小 body（若有）、acquire per-device/session locks。
5. **deviceId / 身份唯一映射（禁止“或”）：**
   - **create**：manifest / body 中 `deviceId`（若出现）与 authenticated `deviceId` **字符串不全等** → **唯一** `upload-manifest-invalid`。
   - **chunk**：URL / critical headers / session 身份（uploadId、snapshotId、manifestDigest、device 作用域）不一致 → **唯一** `upload-chunk-invalid`，并按冻结策略 **abort** session（不推进 boundary）。
   - **status / finalize / abort**：认证成功后跨 device 或本 scope 不存在 → **唯一** `upload-session-not-found`（404），**不**泄漏他设备存在性；**不**用 `device-scope-mismatch` 等替代码。

**防泄漏：** 认证失败时对任意 `uploadId` 一律不查盘、不区分存在性；跨设备在认证成功后 lookup 失败统一 `upload-session-not-found`（404），不泄漏“他设备是否有该 session”。

### 6.1 固定尺寸

- **CHUNK_SIZE = 8 MiB** = `8 * 1024 * 1024`。
- 文件 size = 0：**不发送任何 chunk**；create 后该 fileIndex 即 `complete=true`（仍参与 finalize 空文件创建）。**禁止** `X-Linke-Chunk-Size=0` 的 chunk 请求。
- 文件 size > 0：chunk 数 = `ceil(size / CHUNK_SIZE)`；**仅最后一 chunk** 可 `< CHUNK_SIZE` 且 **必须 > 0**；其余必须 **exact 8 MiB**。
- `X-Linke-Chunk-Size`：**必须为正整数**（`>= 1` 且 `<= CHUNK_SIZE`）；`Content-Length` 与之 exact 相等。
- `Content-Length`：**必须存在**、**exact-one**（rawHeaders）、数值 **exact** 等于声明 size；缺失/重复/不匹配 → `upload-chunk-invalid`，且 **在读 body 前**失败时须安全 drain/destroy。

### 6.2 Wire 身份（无 path）

Route 表（**C6 首次注册 public routes**；C5 仅内部 service，**不**暴露）：

```text
POST /agent/upload/sessions
  — create（JSON，manifest ≤ 8 MiB）；pre-auth IP limit → headers auth → body

GET  /agent/upload/sessions/:uploadId
  — status / resume；pre-auth IP limit → headers auth → lookup；无 body
    （若 POST status：仍 headers auth 后才读 ≤ 64 KiB body）

POST /agent/upload/sessions/:uploadId/chunks
  — binary；pre-auth IP limit → headers auth + chunk identity → body

POST /agent/upload/sessions/:uploadId/finalize
  — pre-auth IP limit → headers auth → lookup → 可选小 JSON body（≤ 64 KiB）

POST /agent/upload/sessions/:uploadId/abort
  — pre-auth IP limit → headers auth → lookup → 幂等 abort（§4.3.1）；可选空/小 body
```

**Auth 公共 headers（create / status / chunk / finalize / abort；§6.0）：**
`Authorization`、`X-Linke-Device-Id`、`X-Linke-Protocol-Version` — 均为 rawHeaders **exact-one**。

**Chunk 附加 critical headers（rawHeaders exact-one，大小写不敏感计数，值严格）：**

| Header | 语义 |
| --- | --- |
| `Content-Length` | exact body bytes；**positive** 且 = `X-Linke-Chunk-Size` |
| `X-Linke-Upload-Id` | 与 URL uploadId 一致 |
| `X-Linke-Snapshot-Id` | 与 session 一致 |
| `X-Linke-Manifest-Digest` | 与 session 一致 |
| `X-Linke-File-Index` | 非负整数 |
| `X-Linke-Chunk-Index` | 非负整数 |
| `X-Linke-Chunk-Offset` | 非负整数，= fileIndex 内 offset |
| `X-Linke-Chunk-Size` | **正整数** `1..CHUNK_SIZE`（禁止 0） |
| `X-Linke-Chunk-Sha256` | 64 lower hex |

**禁止：** path 出现在 URL、header、query、错误体。

### 6.3 顺序与幂等

对每个 fileIndex（**错误码唯一；禁止二选一**）：

1. 期望 next = `(chunkIndex = floor(confirmedBytes / CHUNK_SIZE), offset = confirmedBytes)`（空文件除外，且空文件不接受任何 chunk）。
2. **exact expected** 且 hash/size 与 manifest/期望匹配 → 落盘 → 复验 → atomic 推进 `confirmedBytes` → ACK。
3. **exact duplicate**（同一 fileIndex/chunkIndex/offset/size/hash 且已确认）→ **幂等 ACK**，不重写、不推进越界。
4. **future / out-of-order / gap / `offset` ≠ confirmed boundary** → **HTTP 409** + **唯一** `upload-chunk-out-of-order`；**不**推进 boundary；**不** abort session；**不**保留错误数据为 confirmed。
5. **同一已确认坐标**（同 fileIndex/chunkIndex/offset）但 **size/hash 与既有 confirmed 或 manifest 期望冲突** → **唯一** `upload-integrity-failed` + session **abort**；不推进。
6. **语法 / Content-Length / critical header 非法**（含缺失、重复、非正 size、CL 不匹配、非 64-hex 等）→ **唯一** `upload-chunk-invalid`；**在读 body 前**拒绝；安全 drain/destroy；**不**推进；不因本条单独 abort（身份冲突 abort 见 §6.0 step 5）。

### 6.4 Body 读取纪律与超时架构（唯一冻结；C6 落地）

**问题：** 现有 G0a `server.requestTimeout = 15_000` 与 8 MiB chunk 的 120s 总预算**冲突**；Node `https.Server.requestTimeout` 是 **server 级** hard ceiling，**不能** per-route 设置。

**唯一架构（非二选一、非建议语气）：**

| 层 | 冻结值 | 作用 |
| --- | --- | --- |
| `server.headersTimeout` | **10_000 ms**（保持） | 仅限制 headers 到达 |
| `server.requestTimeout` | **0**（关闭 server 级整请求 hard ceiling） | 消除 15s 与 chunk 120s 的冲突；**不是**无限请求 |
| Per-route **explicit bounded reader/handler deadline** | 见下表 | **唯一**请求时长 SoT；超时由 handler **可控** settle |

**Per-route reader/handler deadlines（写死；测试钉死）：**

| Route 类 | Body 上限 | Inactivity | Total deadline | 超时行为 |
| --- | ---: | ---: | ---: | --- |
| G0a enroll / heartbeat / rotate / confirm | **64 KiB** | n/a（小 JSON） | **15_000 ms** body total | body parse/size/15s deadline 超时：**唯一**公开码既有 **`device-request-invalid`（400）**；**不得变松**；**禁止**“或既有映射”留实现选择 |
| upload create | **8 MiB** | n/a | **30_000 ms** total | body total deadline 超时/越界：**唯一**公开码既有 **`device-request-invalid`（400）**；**不创建/不推进** session；**禁止** `upload-io-error`；**禁止**“后续锁死一码” |
| upload status / finalize / abort | **64 KiB** req（status 可无 body） | n/a | **15_000 ms** total | single-settle 脱敏错误；不推进 terminal 错误状态除非已验证 |
| upload chunk | **≤ 8 MiB** exact CL | **15_000 ms** 无数据 | **120_000 ms** total | 不推进 boundary；drain/destroy；single-settle 脱敏错误 |

纪律：

1. **认证三元组 + authenticate 成功** 必须在 create/chunk body 读取与 uploadId lookup **之前**完成（§6.0 step 0–4）。
2. chunk：Content-Length / identity preflight 通过后，请求体硬界限 = 声明 `X-Linke-Chunk-Size`（且 ≤ 8 MiB）；超过立即 **drain/destroy**，single settle。
3. early EOF / 客户端中止 / deadline 触发 → 不推进 boundary；**single settle**（不双写响应）。
4. 成功路径：写临时 → 必要 fsync → hash 复验 → atomic 更新 session boundary。
5. **诚实说明：** 本架构关闭冲突的 server hard ceiling 后，用 **per-route reader deadline** 恢复并**强化**边界；**禁止**声称“server-level per-route `requestTimeout`”。C6 必须含 **G0a 回归**：64 KiB 上限与 15s total 行为/错误映射不松。

#### 6.4.1 Deadline 实现锚点（冻结；C6 钉死）

**唯一实现模型**（非建议语气）：

| 计时器 | 作用域 | 行为 |
| --- | --- | --- |
| **Handler-level monotonic total timer** | 每个请求 handler 一次 | 从 handler 进入起算；到期触发 abort gate |
| **Chunk idle timer** | 仅 chunk binary reader | 每收到 **非空** `data` chunk **重置** 15s；首包前同样 15s idle |

规则：

1. **两个 timer 共用同一个 idempotent abort/settle gate**（一次 settle 标志）。
2. 超时后 **立即停止** 继续 hash / write / state advance；**销毁/关闭**输入流；**只返回一次**脱敏错误响应；**clear 两个 timer**。
3. **late events**（timeout 后到达的 `data`/`end`/`error`）**不得**二次 `writeHead`/`end`，**不得**推进 session boundary 或其它可变状态。
4. G0a enroll/heartbeat/rotate/confirm：**仅 total timer 15s**（无 idle timer）。
5. upload create：**仅 total timer 30s**。
6. upload status/finalize/abort：**仅 total timer 15s**。
7. upload chunk：**total 120s + idle 15s**（双 timer + 共享 gate）。
8. 测试（C6）：fake timers；slow drip 重置 idle；超时后 late event 不二次响应/不推进；single-settle 断言。

### 6.5 客户端 resume 策略

- 使用 status 返回的 `missingSummary.next` 继续；同设备 active conflict 时可用响应中的 locator resume 或 **显式 abort** 后新 create。
- 对 HTTP 429：区分 `device-rate-limited`（IP limiter）与 `upload-backpressure`（upload service 容量/锁）；**两者都**按 `Retry-After` **有界**重试，**不**混淆错误码语义。
- 网络/有界重试耗尽 → 客户端本地 `upload-resume-exhausted`（HTTP **N/A**）。
- **禁止**无限 retry；**禁止**自动抢占不同 snapshot 的 active session。
- 不与 V2 `DATA_RESUME_EXHAUSTED` 混用。

### 6.6 Path-aware pre-auth IP limiter（冻结）

**不得**让 chunk 沿用 legacy **60/min** 全路径共享计数。

| 路径类 | Limiter | 默认上限 | 时机 |
| --- | --- | ---: | --- |
| G0a：`/agent/enroll`、`/agent/heartbeat`、`/agent/token/*` | legacy | **60 requests / min / IP** | pre-auth（保持现网） |
| Upload：`/agent/upload/*` | **独立** token bucket | **1200 requests / min / IP** | **先于 auth**（step 0） |

冻结细节：

1. 两套计数器**隔离**；upload flood **不**耗尽 G0a 60/min，G0a 也不误伤 upload。
2. Upload IP limiter 命中 → HTTP **429** + 注册码 **`device-rate-limited`** + bounded `Retry-After`（与现 G0a 形态一致）。
3. **`upload-backpressure`** 仅表示 **已认证后** upload service 的全局 active-transfer 信号量 / 锁竞争饱和——**不是** IP limiter。
4. 主并发边界仍是认证后的 **per-device mutex** + **global active-transfer semaphore**（默认 4）。
5. **测试必须证明：** 1 GiB payload ≈ **128** 个 8 MiB chunks **不会**因 legacy 60/min 失败；同时对 upload 路径的匿名/已认证 flood 仍被 1200/min 与 service 信号量有界拒绝。

---

## 7. 拟注册错误码（C1 才改代码）

当前 `ERROR_CODES` count = **62**。G0b 新增 **12** 个 → 目标 **74**。所有相关测试中的 count pin 必须**同 PR 协调**更新。

| 常量键（建议） | code | HTTP | retryable | 含义 |
| --- | --- | --- | --- | --- |
| `UPLOAD_MANIFEST_INVALID` | `upload-manifest-invalid` | 400 | false | manifest 投影/语义/path/digest 失败；客户端自报 digest 不一致；create deviceId 不符；非法键（含 `ipAddress`） |
| `UPLOAD_SESSION_CONFLICT` | `upload-session-conflict` | 409 | false | 同设备并行 upload / 不同 snapshot·digest active 冲突 |
| `UPLOAD_SESSION_NOT_FOUND` | `upload-session-not-found` | 404 | false | uploadId 不存在或不在设备 scope（status/finalize/abort 跨 device 统一此码） |
| `UPLOAD_SESSION_EXPIRED` | `upload-session-expired` | 410 | false | 超过 24h TTL |
| `UPLOAD_CHUNK_INVALID` | `upload-chunk-invalid` | 400 | false | headers/CL/语法非法（读 body 前拒绝）；chunk URL/header/session 身份不一致（+abort） |
| `UPLOAD_CHUNK_OUT_OF_ORDER` | `upload-chunk-out-of-order` | 409 | true* | future/gap/offset≠boundary；**不**推进、**不** abort |
| `UPLOAD_INTEGRITY_FAILED` | `upload-integrity-failed` | 409 | false | 同坐标 size/hash 与既有/manifest 冲突或 finalize 复验失败；session abort |
| `UPLOAD_CAPACITY_INSUFFICIENT` | `upload-capacity-insufficient` | **507** | false | 容量不足 **或** `statfs` 不可用/不可信/查询失败（fail-close，见 §8.2）；**受控数值状态** + Linke code |
| `UPLOAD_BACKPRESSURE` | `upload-backpressure` | **429** | true | 认证后 service 容量/锁竞争；带 Retry-After；**≠** IP `device-rate-limited` |
| `UPLOAD_COMMIT_CONFLICT` | `upload-commit-conflict` | 409 | false | snapshot 已存在冲突；**committed session 不可 abort**（唯一码） |
| `UPLOAD_IO_ERROR` | `upload-io-error` | 500 | false | 脱敏 I/O 失败（**不**用于 create body deadline / G0a 15s） |
| `UPLOAD_RESUME_EXHAUSTED` | `upload-resume-exhausted` | **N/A（非 HTTP）** | false | **client-local only** 注册 LinkeError；服务端**永不**以该码响应；**禁止**伪装 HTTP 429 |

**既有码复用（非新增；唯一公开映射）：**

| 场景 | 唯一公开码 | HTTP |
| --- | --- | --- |
| G0a body parse/size/15s deadline | `device-request-invalid` | 400 |
| upload create body total 30s deadline / 越界拒绝（不创建 session） | `device-request-invalid` | 400 |

\* `upload-chunk-out-of-order`：服务端可标记 retryable；客户端必须先 status 再发 expected chunk，不得盲重放 future chunk。

**Retry-After：** 仅 **`upload-backpressure`** 与既有 **`device-rate-limited`**（含 upload path-aware IP limiter）允许；有界秒数（1–60，实现固定上限 30）。`upload-resume-exhausted` **不是** HTTP 错误，**不得**带 Retry-After。其他错误不得附带误导性 Retry-After。

**HTTP 507（冻结）：** `upload-capacity-insufficient` 使用 **数值状态码 507** + JSON `{ error: "upload-capacity-insufficient" }`。这是 Linke 受控映射，**不是** WebDAV 语义依赖。Node 客户端必须按 `statusCode === 507` 数字分支 + 注册码处理；**不**新增专用错误码；C1/C6 加映射测试。

**禁止：** 复用 `data-resume-exhausted` / 任何 Noise 域错误码表达 G0b 上传耗尽；禁止把 client-local `upload-resume-exhausted` 映射为服务端 HTTP 状态。

---

## 8. 存储 / 提交

### 8.1 路径导出（禁止客户端字符串拼目录）

与当前 `safeDevicePath` / `deviceRel = repo/devices/<slug>` **一致**（**禁止**写成 `dataDir/devices/...`）：

```text
dataDir/
  repo/
    devices/
      <deviceSlug>/                              # slugify(authenticated deviceId) via safeDevicePath
        upload-sessions/
          <uploadId>/
            session.json                         # atomic state
            manifest.canonical.json              # 控制器投影
            .staging/
              files/
                <fileIndex>/                     # 仅数字下标，不使用客户端 path 段
                  chunk-<chunkIndex>.part        # 或完整文件聚合策略（C3 锁死）
        snapshots/
          <snapshotId>/                          # final snapshot 目录
            manifest.json                        # 权威 manifest（publish 阶段写入）
            COMPLETED.json                       # remote-upload commit point（atomic）
            files/
              <manifest-relative-paths...>       # 已验证 path 映射 + safe-data-files no-follow
        snapshots.json                           # 现有 listSnapshots 索引（须幂等 upsert）
        device.json                              # 现有 device summary（count / lastBackupAt）
```

冻结相对路径：

- session：`repo/devices/<slug>/upload-sessions/<uploadId>/...`
- final snapshot：`repo/devices/<slug>/snapshots/<snapshotId>/...`
- 索引：`repo/devices/<slug>/snapshots.json`、`repo/devices/<slug>/device.json`

冻结规则：

1. `deviceSlug` 仅来自 `slugify(authenticatedDeviceId)` / `safeDevicePath`。
2. staging 文件名仅 `uploadId` / `fileIndex` / `chunkIndex`。
3. 最终 `files/` 下相对路径 **只**从已验证 manifest path 映射，经 `normalizeRelativeDataPath` + no-follow。
4. 隐藏 staging（`.` 前缀）不得被 snapshot reader 当作已提交数据。
5. **只 rename snapshot 目录不足以让列表可见**——必须协调 `snapshots.json` / `device.json`（§8.3）。
6. snapshots 父目录可含 sibling claim 文件 `.claim-<snapshotId-safe>` 与 candidate `.upload-*.pending/`（非 list 条目）。

### 8.2 Capacity preflight

- 在 create 时对 **dataDir** 所在卷调用 Node **`fs.statfs` / `fs.promises.statfs`**（或等价封装）。**不**虚构 Windows 支持矩阵——只冻结 API 可用时的行为与不可用时的 fail-close。
- **双份峰值：** 必须覆盖 **staging 完整副本 + sibling candidate 完整副本** 的同时存在，外加安全余量：
  `required = 2 * totalBytes + max(64 MiB, ceil(totalBytes * 0.05))`。
- 可用空间充足 → 继续 create；不足 → `upload-capacity-insufficient`（HTTP **507**）。
- **`statfs` 不可用 / 返回不可信 / 数值溢出 / 查询抛错：** **禁止**静默跳过容量门；create **必须 fail-close**，**唯一** **`upload-capacity-insufficient`（507）**。**不得**在未通过预检时创建 session；**禁止**改映 `upload-io-error` 等替代码。
- 错误脱敏：无路径、无 errno 原文、无 raw system message。
- 本 Gold 目标是 **single Mac**，但这 **不**授权跳过容量门。

### 8.3 Finalize / commit：candidate + publish claim + rename（唯一冻结）

**禁止**“逐文件 rename 进 final 后可重跑或留下半迁移”。

**禁止的错误承诺（PM 在 macOS Node 24.14.0 实测驳回）：**

- **不得**声称 `fs.rename` 在 target 已存在时“必 EEXIST / no-replace”。
- 实测：source 为**非空目录**、target 为**空目录**时，`fs.renameSync(source, target)` **可直接替换 target**，**不会** EEXIST。
- 因此 **禁止** `rename-onto-absent`、`O_EXCL rename`、`EEXIST 即 no-replace` 等错误架构承诺。
- **禁止**仅 `lstat → rename` 就宣称跨进程原子排他。

**可实现的发布临界区：sibling publish claim（文件系统 atomic reservation）**

在 `repo/devices/<slug>/snapshots/` 父目录，为每个 `snapshotId` 使用 **安全派生名** 的 sibling **claim 文件**（命名规则 C4 锁死，例如 `.claim-<snapshotId-safe>`；仅安全字符）。

| 步骤 | 行为 |
| --- | --- |
| 1 | `open(claimPath, "wx")` — **atomic exclusive-create**（`wx` = 写 + 排他创建；**claim 原子性来源**，不是 rename） |
| 2 | 写入绑定：authenticated `deviceId`、`snapshotId`、`uploadId`、`manifestDigest`（+ schema 版本）；**atomic/fdatasync** |
| 3 | **仅**持有有效 claim 后，Linke **合规 writer** 才允许 final exists 检查与 candidate→final `rename` |
| 4 | claim **至少保留到** COMPLETED + indexes 幂等修 + session `committed`；之后尽力清理 |
| 5 | **清理失败不反转**已提交结果；后续同身份可 **幂等清理** 残留 claim |

**claim 冲突：** claim 已存在 → **safe-read**（no-follow / 有界）：

- 内容完整且与**当前**身份全等 → 允许恢复/接管；
- 损坏、截断、未知 schema、或 **不同身份** → **`upload-commit-conflict` fail-close**；**不覆盖** claim；**不得**自动删除未知 claim。

**诚实边界：** claim 仅为 **发布临界区** 提供文件系统级 atomic reservation；**所有 Linke writer 必须遵守**。这 **不**扩张为 G4 cross-process lifecycle / distributed lock 产品宣称。

**Commit 算法（session 锁 + 进程内 per-snapshot 锁；claim 为跨 writer 约定）：**

1. 状态 `receiving` 且全文件 complete，或 crash-recovery。
2. 进入 `verifying`（atomic）。
3. **staging 保持不动**；全量 hash/size 对齐 manifest；复核 totalBytes。
4. 建 sibling candidate：`.upload-<uploadId>.pending/`；物化 `files/` + `manifest.json` + **pending metadata**（绑定 uploadId/deviceId/snapshotId/manifestDigest）；逐项复验 + 必要 fsync。
5. **获取 publish claim**（`open("wx")` 或同身份恢复）；失败按上表 conflict。
6. **持 claim 期间** 检查 final `snapshots/<snapshotId>`：
   - valid COMPLETED + 同 identity/digest → 不覆盖；幂等 indexes + session committed；清理 candidate/claim（尽力）。
   - valid COMPLETED + 不同 identity/digest → `upload-commit-conflict`。
   - 无 COMPLETED 的目录：仅 pending metadata 与当前身份完全一致可接管；否则 conflict，**绝不覆盖**。
   - final **不存在** → 允许 `rename(candidate → snapshots/<snapshotId>)`（**不**依赖 EEXIST 做互斥；互斥靠 claim）。
7. rename 后尚无 `COMPLETED.json`。**pending metadata 必须保留至少到 valid COMPLETED 写出**，确保 direct readers 可识别“remote pending 非完成”。全量复验 final → **atomic 写 `COMPLETED.json`**（含 `origin: "remote-upload"`、snapshotId、manifestDigest、committedAt、uploadId、deviceId）。**COMPLETED 是 remote-upload 唯一 commit point**。COMPLETED 之后清理 pending **不影响** marker 权威；若保留 pending，readers **仍只认** valid COMPLETED，**不得**因 pending 存在而误判可读。
8. **仅 COMPLETED 后** 幂等 upsert `snapshots.json`（§8.4 字段，必含 `origin`/`manifestDigest`）与 `device.json`。
9. session → `committed`；尽力清理 claim；清理失败不反转 committed。

**候选目录可读性：** rename **前** candidate 不位于 final path，**自然不可**被 `listSnapshots` / `getSnapshotManifest` / `restoreSnapshot` 当作已提交 snapshot。

**Crash 矩阵（staging 完整）：**

| 窗口 | 状态 | 恢复 |
| --- | --- | --- |
| candidate 构建中 | final 可不存在；可能无 claim | 重建同身份 candidate；staging 不动 |
| claim 创建后 / rename 前 | claim 在 | 同身份可接管；异身份 conflict |
| rename 后 / COMPLETED 前 | final 无 marker；claim 应在 | pending 身份一致 → COMPLETED；否则 conflict **不覆盖** |
| COMPLETED 后 / index 或 session 前 | 有 marker | 修 indexes + session；尽力清 claim |
| COMPLETED 后残留 claim | 已提交 | 同身份幂等删 claim；失败不反转 |

**禁止表述/实现：** 逐文件 rename 半迁移、EEXIST-no-replace 神话、`O_EXCL rename`、把 `snapshots.json` 当 commit point、无 claim 的多 writer final rename。

### 8.4 Readers / direct-read 完整性（冻结；C4 storage helper）

**适用范围：** `listSnapshots`、`getSnapshotManifest`、`restoreSnapshot` 及任何等价 **direct reader**（读 final snapshot 目录 / index 并返回 manifest 或 files 的路径）。**禁止**只收紧 list 而放行 get/restore。

**Index 条目 schema（remote-upload 写入时强制）：**

```text
{
  "snapshotId": "<uuid>",
  "origin": "remote-upload",          // 必填；仅此值强制 marker 校验
  "manifestDigest": "<64 lower hex>", // 必填
  "committedAt": "<ISO-8601>",        // 必填
  // 可含 fileCount 等兼容字段；不得含 path/host
}
```

**C4 storage helper 判定（冻结唯一表）：**

| 磁盘 / index 状态 | 全部 direct readers 行为 |
| --- | --- |
| final 有 **valid** `COMPLETED.json`（`origin=remote-upload`）**且** digest 与 index/manifest 一致 | remote **可读**（list 可见；getSnapshotManifest/restore 可返回 manifest/files） |
| final 有 **pending metadata** 但 **无** valid COMPLETED | **fail-close**：list **隐藏**；get/restore **不**返回 manifest/files（不把 pending final 当完成） |
| index entry `origin=remote-upload` 但 marker **missing / corrupt / digest mismatch**（stale remote index） | **fail-close**：list **隐藏**；get/restore **不**返回 manifest/files |
| COMPLETED 与 pending **均不存在**，且 local entry **无** `origin` 或 `origin !== "remote-upload"` | **保持旧 local 行为**；**不**要求 marker；**绝不能**因 remote marker 规则被隐藏/拒绝 |
| candidate（rename 前，非 final path） | **自然不可读**为已提交 snapshot |

| Snapshot 来源 | index 识别 | readers 行为摘要 |
| --- | --- | --- |
| **旧 local** `createBackup` | **无** `origin` 或 `origin !== "remote-upload"` | **沿用现有可见/可读/可恢复行为**；**不**强制 COMPLETED |
| **G0b remote-upload** | **必须** `origin === "remote-upload"` 且含 `manifestDigest` | 仅 valid COMPLETED 后才 upsert；**list + get + restore** 均强制 marker+digest |

共享规则：

1. 读有界 index `snapshots.json`（无分页则 **O(n)**）。
2. **仅当** `entry.origin === "remote-upload"`（或 direct path 识别为 remote pending/COMPLETED 语义）：强制 COMPLETED/marker + digest；**stale / missing / corrupt / digest 不符 / pending-without-marker** → **fail-close**（list 隐藏；get/restore 拒绝且**不**返回内容）。
3. **非** `origin === "remote-upload"`（含全部历史 local）：**不做** marker 强制；保持既有 list/get/restore 语义。
4. **`snapshots.json` 不是 commit point**。
5. staging、candidate、claim 文件、无 marker 的 remote final **不得** list/get/restore 为成功备份。
6. COMPLETED 后清 pending **不削弱** marker；保留 pending **不得**使 get/restore 绕过 COMPLETED。

---

## 9. API / Client

### 9.1 保持不变

- enroll / heartbeat / rotate / rotate/confirm 的 **JSON 64 KiB** 契约、状态码与字段。
- G0a body total deadline **15s** 与 64 KiB 上限 **不得变松**（§6.4；C6 关闭 server `requestTimeout` hard ceiling 后由 per-route reader 强制）。
- 设备协议 current / N-1 门。
- 管理面 loopback 路由集合（G0b 不把 upload 挂管理面）。

### 9.2 Create / status / finalize / abort

- 全部先走 §6.6 IP limiter + §6.0 认证三元组；**auth 成功前禁止 body 读与 uploadId lookup**。
- create：独立 **8 MiB** body reader（30s total）；冲突时本设备 active locator 见 §4.3.1。
- status：推荐 GET + 仅 headers auth。
- finalize / abort：小 JSON（≤ 64 KiB）；abort 规则 §4.3.1。
- chunk：独立 binary reader + §6.2 附加 headers；15s inactivity + 120s total。

### 9.3 响应 allowlist

仅允许：安全 ID（uploadId、snapshotId、manifestDigest、deviceId）、status、计数、boundary、missingSummary、expiresAt、本设备 active locator 字段、registered error code。

**禁止：** 文件 path、host、IP、URL、token、fingerprint、Keychain 名、raw stack、errno、sourcePath。

### 9.4 Endpoint client

- 复用 pinned TLS + Keychain token。
- 所有 upload 请求发送 **mandatory** `Authorization`、`X-Linke-Device-Id`、`X-Linke-Protocol-Version`（exact-one）。
- 新增 `requestPinnedBinary`（名称 C7 锁死）：pin 成功前不写 body；响应有界；single settle。
- 读取本地 snapshot：safe root-relative / no-follow；只上传 manifest allowlist 普通文件。
- HTTP 429：`device-rate-limited` 与 `upload-backpressure` **分开映射**，均尊重 bounded `Retry-After`。
- HTTP **507** + `upload-capacity-insufficient`：按 **数值 507** 处理（非 WebDAV）。
- 重试预算耗尽 → **本地** `UPLOAD_RESUME_EXHAUSTED`（HTTP N/A）。
- 支持 status resume 与 **显式 abort** API；不得自动抢占不同 snapshot 的 active session。

### 9.5 Production wiring（controller-runtime；C6 暴露时点）

**责任分割（冻结）：**

| 组件 | 职责 | 禁止 |
| --- | --- | --- |
| `src/upload-session-store.js` / `upload-commit.js` / `upload-locks.js` / `upload-service.js`（或等价编排模块，C5 命名锁死） | 纯领域逻辑；接收显式 `dataDir` 与依赖 | 不监听端口；不读全局 process 隐式路径 |
| `src/agent-listener.js` | HTTP 路由、limiter、auth headers、body readers、调用 **注入的** `uploadService` | **不得**偷读 `registry` 私有 dataDir 字段；无 service 时 upload routes **不存在**（404） |
| `src/controller-runtime.js` | `ensureSafeDataRoot(dataDir)` 后创建 store/locks/service；将 `{ registry, uploadService, rateLimit, ... }` 注入 `createAgentListener` / `agentServerFactory` | 不得在 listener 内隐式 new 半成品 service |

**Production exposure 时点：**

- **C5：** 实现 locks + backpressure + upload service orchestration 与单测；**不**注册 public upload routes；controller-runtime **尚未**注入 service（或注入但 listener 无 route 表项）。
- **C6：** 注册 public routes + path-aware limiter + per-route deadlines + **controller-runtime production wiring**；此时 store/commit/locks/semaphore **全部**已完整注入；每个 commit **可部署且 fail-closed**。
- **C7：** pinned client/resume + concurrency/hostile 集成；不削弱 C6 fail-closed。

---

## 10. 并发 / 背压

| 边界 | 键 / 范围 | 规则 |
| --- | --- | --- |
| Upload IP limiter | IP + `/agent/upload/*` | pre-auth **1200/min**；429 `device-rate-limited` |
| G0a IP limiter | IP + G0a paths | pre-auth **60/min**（不变） |
| per-device upload mutex | authenticated `deviceId` | 同时最多 **一个 active** nonterminal session（§4.3） |
| per-session | `deviceId + uploadId` | 串行化 chunk/finalize/abort/state |
| per-snapshot | `deviceId + snapshotId` | 进程内 commit 串行；**跨 writer 互斥靠 publish claim（`open wx`）**，不靠 rename EEXIST |
| global transfer semaphore | 进程内 | 默认 **4** active transfers；有效配置范围 **仅 1..16**；可下调、**禁止**放大硬顶；超限 `upload-backpressure` |

**Global active-transfer 配置（唯一行为；对齐 plan Global Constraints 5b / C5）：**

1. 默认 **`maxGlobalTransfers = 4`**。
2. 有效范围 **只能** `1..16`（含端点）：允许配置**下调**至 ≥1；**禁止**通过配置把有效上限抬到 **>16**。
3. 配置 **`<1` 或 `>16`**：构造/启动 **fail-closed 拒绝**（**唯一**行为）。
4. **禁止**静默钳制（clamp）到合法区间；**禁止**“reject 或 clamp”二选一。
5. 运行时有效并发永远 **≤16**；信号量满 → `upload-backpressure`（不无限排队）。

最小测试说明：默认 4 时第 5 个 active → backpressure；配置下调（如 2）时第 3 个 → backpressure；`maxGlobalTransfers=0` 与 `=17`（及更大）→ **构造/启动失败**；不得出现静默 clamp 为 1 或 16 的路径。

- 不同设备可并行（受全局信号量约束）。
- **不**无限内存排队。
- **不宣称** cross-process/distributed lock（G4 后另议）。

---

## 11. 威胁模型（G0b 范围）

| 威胁 | 缓解 |
| --- | --- |
| 跨设备猜测 uploadId | auth-before-lookup；session 绑定 authenticated deviceId；not-found 不区分存在性细节（固定 404 码） |
| 客户端伪报 deviceId / path 逃逸 | header deviceId 仅认证输入；目录只从 authenticate 返回 slug + uploadId/fileIndex 导出；path 仅 manifest 映射 |
| 重复 Authorization / Device-Id / Protocol / 走私头 | 全部 critical headers rawHeaders exact-one |
| 匿名 auth/body DoS | path-aware pre-auth IP limiter（upload 1200/min；G0a 60/min） |
| 大包 / 长连接 DoS | 8 MiB 硬界限；per-route deadlines；auth-before-body；service 信号量 |
| 半成品当成功 | COMPLETED commit point；**全部** direct readers（list/getSnapshotManifest/restore）对 remote：pending/corrupt/stale **fail-close**；**仅** origin=remote-upload 强制 marker；local 不要求 marker |
| 半迁移 / 破坏 staging | candidate 物化 + staging 不动 |
| 空 target rename 替换 / 无互斥 rename | sibling claim `open("wx")`；禁止 EEXIST-no-replace 神话 |
| statfs 缺失被跳过 | create fail-close capacity-insufficient |
| 日志泄漏 path/token | 响应/错误/证据 allowlist；测试 secret scan |
| 损坏 chunk / 位翻转 | chunk hash + finalize 全文件 hash |
| 重放旧 session | TTL 24h；terminal abort；digest 变更新 session |
| 同 snapshot 覆写投毒 | publish claim + pending metadata 绑定 + COMPLETED/digest 冲突 fail-close |
| 24h 自锁 | 显式 abort；过期不再算 active |
| symlink 交换 | safe-data-files no-follow / O_NOFOLLOW |
| 无限 resume 打爆对端 | 客户端有界；IP limiter + upload-backpressure |

**超出范围：** 跨局域网主动攻击、中继、Noise 降级、管理面 XSS 等（不在 G0b 宣称已防护完备）。

---

## 12. 失败 / 恢复矩阵

| failureMode | 行为 | 锚点 |
| --- | --- | --- |
| 断连于 chunk 中 | 不推进 boundary；resume 从 confirmedBytes | session.json boundary |
| crash 于 chunk 文件后 / state 前 | resume re-hash expected next only | staging + state |
| crash 于 candidate 构建 | final 可不存在；重建同身份 candidate；**staging 完整** | staging + `.upload-*.pending` |
| claim 竞争 | 仅一个 `open("wx")` 成功；败者 conflict 或同身份恢复 | claim 文件 |
| crash 于 rename 后 / COMPLETED 前 | final pending metadata 身份一致 → COMPLETED；否则 conflict **不覆盖** | final pending + claim |
| crash 于 COMPLETED 后 / index 或 session 前 | 验证 marker+manifest+files → 幂等修 indexes → session；尽力清 claim | COMPLETED.json |
| COMPLETED 后残留 claim | 同身份幂等清理；失败不反转 committed | claim 文件 |
| manifest digest 改变 | 新 session | 新 uploadId |
| 设备 revoke | 拒绝 create/chunk/finalize/abort | registry |
| 容量不足 / statfs 不可用 | create 失败；**不**创建 session | statfs → 507 capacity-insufficient |
| IP 限流 | 429 `device-rate-limited` | path-aware limiter |
| 全局 transfer 满载 | 429 `upload-backpressure` | 信号量 |
| TTL | 410 expired；不再算 active；可新 create | createdAt+24h |
| 用户放弃 | 显式 abort → aborted；可新 create | abort route |

---

## 13. 验收标准

### 13.1 自动（必须）

见 plan 测试矩阵：pure manifest hostile、store/TTL/reconcile、binary body 纪律、TLS + registry 跨设备 deny、child-process endpoint 断连/resume/corrupt、双设备并行、backpressure、secret scan、G0a 回归、ERROR_CODES count、全量 `npm test`。

### 13.2 真实 LAN（硬件门）

- 独立第二 Mac 或隔离 VM；**真实** pinned TLS + Keychain token + 实际上传。
- 至少覆盖：完整上传成功、断连 resume、损坏 chunk 拒绝、跨设备 deny。
- 报告路径（仅成功后创建）：
  `docs/superpowers/reports/2026-07-22-g0b-real-lan-upload-acceptance.md`（字段脱敏，对齐 G0a 报告红线）。
- 硬件不可用 → report **absent**；**不**改 Gold。
- 自动实现完成时：`LINKE_RELEASE_VERSION` 仅可为 **`V1.41`**；README/evidence/tests 可用独立 signature
  `V1.41 G0b resumable manifest v2 snapshot upload implementation`（**不得**写 real-LAN complete）。

---

## 14. Gold / 版本诚实边界

| 项 | G0b 自动实现后 | 真实 LAN PASS 后 |
| --- | --- | --- |
| `LINKE_RELEASE_VERSION`（`src/version.js`） | 仅允许 **`V1.41`** | 不因此变 V2.0/Gold |
| Release signature（README / evidence / tests） | 可用：`V1.41 G0b resumable manifest v2 snapshot upload implementation` | 可注明 real-LAN 报告存在与否；**仍非 Gold** |
| Gold 9-item statuses | **保持** 4 ready / 4 partial / 1 blocked（**4 / 4 / 1 / 9**） | **仍默认不变**；fleet/local 的“有限 ready”不因 G0b 自动抬升 |
| overall Gold | **blocked** | **blocked**（缺 G0c/G1/…/G7） |
| 宣称 “G0b real-LAN complete” | **禁止** | 仅当脱敏报告 overallStatus=PASS |
| M1/M2 | 仍 BLOCKED / denied | 不变 |

**禁止话术：** Gold ready、GA、cross-LAN、Noise complete、G0b real-LAN complete（无报告时）、用 G0a PASS 暗示 G0b PASS、把完整 signature 写成 `LINKE_RELEASE_VERSION` 值。

---

## 15. 阶段划分（与 plan 对齐；C5–C7 已按 fail-closed 重排）

| 阶段 | 内容 | 代码？ | Public upload routes? |
| --- | --- | --- | --- |
| **C0** | 本 design + plan | docs only | 否 |
| **C1** | error codes + canonical manifest/session schema/validators | 是 | 否 |
| **C2** | persistent session store + TTL/active/abort primitives + reconcile | 是 | 否 |
| **C3** | bounded chunk ingest + resume/idempotency | 是 | 否 |
| **C4** | candidate + **publish claim** + rename + COMPLETED + indexes；`storage.js` **全部** direct readers（list/getSnapshotManifest/restore）**origin=remote-upload** marker fail-close；statfs fail-close | 是 | 否 |
| **C5** | **locks/backpressure + upload service orchestration**（单元/组件测试；**不**注册 public routes；**不**要求 controller-runtime 暴露） | 是 | **否** |
| **C6** | **Agent upload routes + path-aware limiter + per-route deadlines + controller-runtime production wiring**；store/commit/locks/semaphore 全部注入；G0a 回归 | 是 | **是（首次）** |
| **C7** | **pinned client/resume + abort client + concurrency/hostile integration** | 是 | 是（已存在） |
| **C8** | real-LAN test-only harness；成功才写报告；version=`V1.41` + signature 分离；Gold 不抬 | 有条件 | 是 |
| **C9** | full suite + GLM/Qwen/fresh Grok + PM | 验证 | — |

**Dependency graph：**
C1 → C2 → C3 → C4 → **C5 (service, no routes)** → **C6 (routes + runtime wiring)** → **C7 (client + hostile)** → C8 → C9

**每个 commit 必须可部署且 fail-closed：** C5 合并后生产 listener **无** upload 入口；C6 起入口完整受 limiter/auth/locks 保护。

建议 C0 commit message（**本 worker 不执行**；待多模型+PM ACCEPTED）：

```text
docs: design V1.41 G0b resumable snapshot upload
```

---

## 16. 文件地图（实现期；C0 不创建）

| 路径 | 职责 | 阶段 |
| --- | --- | --- |
| `src/error-codes.js` | +12 upload codes；count 74 | C1 |
| `src/upload-manifest.js` | canonical projection / digest / path validators | C1 |
| `src/upload-session-store.js` | session、TTL/active、abort、boundary、reconcile | C2 |
| `src/upload-chunk-ingest.js` | bounded binary ingest、幂等、顺序 | C3 |
| `src/upload-commit.js` | candidate 物化、publish claim（`open wx`）、rename、COMPLETED、indexes、claim 清理 | C4 |
| `src/storage.js` | listSnapshots / getSnapshotManifest / restoreSnapshot：仅 `origin=remote-upload` 做 marker+digest fail-close；pending/corrupt/stale 不返回内容；local 兼容 | C4 |
| `src/safe-data-files.js` | 大文件 hash 边界协调（若需） | C4 |
| `src/upload-locks.js` | per-device/session/snapshot + global semaphore | C5 |
| `src/upload-service.js`（名称可微调，plan 锁死） | 编排 create/chunk/finalize/abort；无 HTTP | C5 |
| `src/agent-listener.js` | routes、path-aware limiter、deadlines、注入 uploadService | C6 |
| `src/controller-runtime.js` | 创建 store/locks/service 并注入 listener | C6 |
| `test/controller-runtime*.test.js` / 扩展既有 | production wiring 回归 | C6 |
| `src/device-client.js` | binary pinned + uploader + abort/resume | C7 |
| `test/upload-*.test.js` 等 | 见 plan | C1–C7 |
| `test/helpers/g0b-real-*` | C8 真实门 | C8 |

---

## 17. 开放实现细节（允许 C1+ 微调，不得违反冻结语义）

> **范围：** 仅保留**不改变 wire / 安全语义**的实现细节。下列项**已冻结、不再开放**：`hostname`/`sourcePath` 为 §5.2 可选字段（sourcePath opaque §5.6）；**`ipAddress` 禁止**进入 upload canonical/create body；协议错误码唯一映射（§4.3.1 / §5.1 / §6.0 / §6.3 / §6.4）；remote direct-reader fail-close（§8.4）。

1. chunk 落盘是“每 chunk 一文件”还是边收边写完整文件 — C3 选一并测 crash；**不得**改变 §8.3 publish 算法与 §6.3 错误码。
2. status GET vs POST — 默认 GET；若 POST，仍 §6.0 auth 先于 body；错误码不变。
3. upload service 模块文件名（`upload-service.js` vs 并入 store）— C5 锁死单一导出边界即可。
4. publish claim 文件名派生细节可在 C4 微调，但必须 `open("wx")` 排他 + 身份绑定 + 禁止静默删未知 claim。
5. ~~超时二选一~~ / ~~resume-exhausted HTTP~~ / ~~逐文件 rename~~ / ~~EEXIST-no-replace rename~~ / ~~hostname·ipAddress 是否进 canonical~~ / ~~协议错误“或/后续锁死一码”~~ / ~~仅 list 收紧 reader~~ — **均已冻结**，不得再开。

---

## 18. 文档修订记录

| 日期 | 作者角色 | 变更 |
| --- | --- | --- |
| 2026-07-22 | Grok C0 文档实施者 | 初版 PROPOSED design |
| 2026-07-22 | Grok C0（PM 通读修订） | version/signature；auth 三元组；repo/devices；索引幂等；resume-exhausted client-local |
| 2026-07-22 | Grok C0（GLM FAIL 闭环） | controller-runtime 与 C5–C7 fail-closed 重排；requestTimeout=0 + per-route deadlines；path-aware 1200/min；copy-then-atomic-rename；listSnapshots marker；abort route；507 客户端映射 |
| 2026-07-22 | Grok C0（GLM PASS P2 闭环） | `origin: remote-upload` index 识别；publish claim `open(wx)` 取代 EEXIST/rename 神话；deadline dual-timer + single settle gate；statfs unavailable fail-close |
| 2026-07-22 | Grok C0（fresh Grok P2 闭环） | §10 / §1.1：global active transfer 默认 4、有效范围仅 1..16；`<1`/`>16` 构造/启动 fail-closed 拒绝（禁止静默钳制/放大硬顶）；同步最小测试说明 |
| 2026-07-22 | Grok C0（第 2 次 fresh Grok P2 闭环） | §1.1/§8.4/§11：全部 direct readers（list/get/restore）remote fail-close；协议错误唯一码（committed abort / digest / deviceId / chunk / create·G0a deadline）；§5.2 冻结 hostname/sourcePath 可选、**禁止 ipAddress**；§17 仅保留非 wire 实现细节 |

**END OF DESIGN — PROPOSED / NOT IMPLEMENTED**
