# Linke V1.42 G0c — Endpoint-Pull Restore with Crash-Recoverable Rollback Anchor Design

| 字段 | 值 |
| --- | --- |
| 文档类型 | 产品/架构设计（spec）— **APPROVED DESIGN / PLAN ONLY** |
| 里程碑 | **V1.42 G0c** endpoint-pull restore with crash-recoverable rollback anchor |
| 文档状态 | **DOCS-ONLY C0**；本轮不改 `src/` / `test/` / README / package / version / Gold / 其它 docs |
| 基线 HEAD | `2d8430d274836c3d08f928297e7465fa9e905896` |
| 基线工作区 | 仅允许本文件创建/修改；**绝对禁止**读取/修改 `package-lock.json`、`.superpowers`、敏感文件 |
| 关联 plan | 本 C0 **不**创建 plan；后续独立 plan 文件由 plan 阶段另起 |
| 权威上游 | `docs/superpowers/specs/2026-07-13-linke-gold-single-mac-release-design.md`；`docs/superpowers/plans/2026-07-13-linke-gold-execution-roadmap.md`；`docs/superpowers/specs/2026-07-22-linke-v141-g0b-resumable-snapshot-upload-design.md` |
| 只读边界对齐 | `src/storage.js`、`src/agent-listener.js`、`src/device-client.js`、`src/upload-*.js`、`src/controller-runtime.js`（**不修改**） |
| G0a 证据 | `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md` = **same-LAN dual-Mac PASS**（历史证据，**只读、不得改写**） |
| G0b 真实 LAN | 报告 **absent**；G0b 自动实现 **不** 等价 real-LAN complete |
| V2 Noise | M1 gate **BLOCKED**；M2 **denied**。本 G0c **仅** same-LAN G0a TLS 数据面 + loopback 管理面；不选择、不修改、不绕过 M1/M2 |
| 当前版本常量 | `LINKE_RELEASE_VERSION = 'V1.41'`（`src/version.js`，本阶段不改） |
| G0c 完成后版本 | **常量**仅允许：`LINKE_RELEASE_VERSION = 'V1.42'`。**独立 release signature**（README / Gold evidence / tests 文案）才是：`V1.42 G0c endpoint-pull restore with crash-recoverable rollback anchor implementation`。禁止把完整 signature 写入 `LINKE_RELEASE_VERSION` 字符串值 |
| 当前 Gold | overall **blocked**；counts **ready 4 / partial 4 / blocked 1 / total 9**（**4 / 4 / 1 / 9**）。G0c docs/自动实现 **不得** 改 9-item statuses |

> **诚实声明（冻结）**
>
> 本文档是 **APPROVED DESIGN / PLAN ONLY / DOCS-ONLY C0**。文中全部 API、schema、错误码、文件布局、路由与状态机在 C1+ 落地前均视为**未实现、未交付**。
>
> **不得**将本设计、未完成实现、同进程 fixture 或自动 harness 描述为 “G0c real-LAN complete”、“Gold ready” 或 “GA”。
>
> G0a same-LAN PASS **不**证明 G0b real-LAN PASS；G0b 自动实现 complete **不**证明 G0c real dual-endpoint LAN complete；G0c 自动 harness complete **不**证明 real dual-endpoint LAN complete。

---

## 1. 目标与非目标

### 1.1 目标（G0c 充分必要）

在 G0a 信任基础与 G0b 可恢复上传已冻结契约之上，完成 **端点主动拉取** 的 snapshot 恢复闭环，并与 upload **共享** live binary transfer 背压：

1. **端点主动拉取 + 持久化状态机**
   不新增端点入站 listener。Controller 持有不可变 `RestoreTask`；endpoint 持有私有 `dataDir` 下的可恢复 task state；Agent TLS 数据面提供 claim/task/chunk/progress/receipt/cleanup。
2. **不可变任务与可变状态分离**
   Controller：`TASK.json` 不可变主体；`STATUS.json` 可变 status/receipt/cleanup 字段。Endpoint：intent 状态机 + staging/anchor/quarantine 工件。
3. **loopback 管理面显式创建 / cancel / status**
   无 G3 scheduler、无自动推送、无 Web 自动触发 restore。create/cancel 为 write-token + required audit admission 路由。
4. **目录发布与可崩溃恢复回滚锚点**
   用户明确选择“允许替换旧目录并增加回滚锚点”。纯 Node 可恢复双 rename；staging 完整复验后才 publish；published 失败则 quarantine + anchor 回滚 + fingerprint 复验。
5. **路径与根边界**
   `restoreRoot` 仅本地配置；Controller 只下发严格规范化 `relativeTarget`；JSON task/manifest body **必须**返回 snapshot-root-relative file `path` 以便 endpoint 重建目录树；**禁止** path 进入 URL/header；**禁止** endpoint absolute target path 进入任何 wire/log/response。
6. **并发与背压**
   upload + restore **共用**一个 global live-transfer semaphore（默认 4，合法 1..16；0/17 构造/启动 fail-closed）；slot **仅**在 live binary transfer work unit 内持有；同设备 upload **或** restore 至多一个 nonterminal admission；不同设备可并行；restore 独立 pre-auth IP limiter **1200/min**。
7. **两阶段 cleanup**
   receipt ACK 仅授权 endpoint 删除 task-specific 发布工件并进入 cleanup 报告；Controller 仅在验证 `CleanupReceipt` 后进入 `cleaned`（或 cancel 终态 `cancelled`+`cleanupAckAt`）；私有 STATE tombstone 在 cleanup ACK 后删除。
8. **脱敏与越权**
   跨设备 task/chunk/receipt 统一 not-found；响应/日志/证据无 endpoint 绝对路径、raw error、stack、errno、token、TLS fingerprint 明文。
9. **自动验收 + 真实硬件门**
   pure/hostile/crash-injection/child-process dual-endpoint harness 必须完整；真实第二 Mac / 隔离 VM 门仅在真实 PASS 后写报告；无硬件无报告无 fake PASS。

### 1.2 明确非目标

| 非目标 | 说明 |
| --- | --- |
| 端点入站 listener / Controller 推送 body | 恢复仅 endpoint pull；不新增 endpoint server |
| G3 scheduler / 自动备份触发 restore | 仅 loopback 显式 create |
| Web 自动触发 restore | 管理面 API 显式调用；不挂“一点即恢复”无人审路径 |
| G1 NAS / smbfs 远端恢复缓存编排 | G0c 只从 **控制器已可读** snapshot 供 endpoint 拉取；不实现 NAS→controller 拉取闭环 |
| G2 Retention 自动删除 task 工件 | G0c **禁止**无授权自动扫描删除；删除仅按 §8.8–§8.9 两阶段显式路径 |
| G4 multi-process / distributed lock 产品宣称 | 进程内锁 + 文件状态机；不宣称跨进程 flock 完备 |
| G5 角色矩阵 / 审计链扩展 | create/cancel 复用现有 write-token + required audit admission；不扩三角色 |
| G6 升级监控 / G7 Gold claim | 不触碰 |
| cross-LAN / Noise / E2EE | M1 BLOCKED / M2 denied；本阶段不实现、不选型、不绕过 |
| single-syscall / zero-gap atomic directory swap | **明确不宣称**；双 rename 之间允许短暂 target absent |
| Controller 写远程端点文件系统 | 禁止 |
| endpoint absolute target path 进入 wire/log/response | 禁止 |
| path 进入 URL / header / query | 禁止（path **仅**允许 JSON body 内 snapshot-root-relative 文件路径） |
| 跨断连 / 跨 HTTP 请求长期占用 global semaphore | 禁止；slot 仅 live transfer work unit |
| 把 local `storage.restoreSnapshot` 控制器本机恢复当作 G0c 端点恢复完成证据 | 现有本机 restore 路径保持；G0c 是 **fleet endpoint-pull** 新路径 |
| 修改 G0a/G0b 既有错误码语义或 G0a 60/min、G0b upload 1200/min | 保持不变；restore 另增独立 1200/min |

### 1.3 G0c 完成信号（路线图冻结）

来自 `linke-gold-execution-roadmap`：

> 不可变恢复任务、端点 staging、发布、每设备锁、全局背压；两端点并发上传/恢复且互不可见。

拆分诚实边界：

| 信号 | 自动实现可宣称 | 真实硬件门 |
| --- | --- | --- |
| 状态机 + staging/publish/rollback + 并发锁 + 跨设备 deny（自动测试） | 是（implementation complete） | 否 |
| independent child-process two endpoints auto harness | 是（auto harness complete） | 否 |
| 真实第二 Mac / 隔离 VM dual-endpoint LAN restore + concurrency | 否（report absent 时） | 是（PASS 报告后） |
| Gold / “G0c real-LAN complete” | **否**，除非真实报告生成并通过 | 是 |

---

## 2. 方案比较与裁决

### 2.1 控制面 / 数据面形态

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | loopback 管理面 create/cancel/status；Agent TLS 上 endpoint claim + pull chunks + receipt；无 endpoint 入站 | **采用** |
| B | Controller 主动连接 endpoint 推送数据 | **拒绝** — 需 endpoint 入站 listener、防火墙/NAT 不确定、与 Gold “endpoint 拉取” 冲突 |
| C | 仅在控制器本机 `restoreSnapshot` 扩展 | **拒绝** — 不覆盖 fleet endpoint restore |
| D | WebSocket 双向推流 | **拒绝** — 增加协议面；与 G0a/G0b HTTPS 契约不一致 |

### 2.2 任务持久化

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | Controller：`TASK.json` 不可变 + `STATUS.json` 可变；Endpoint：私有 dataDir task state + 隐藏同级 staging/anchor/quarantine | **采用** |
| B | 仅内存 task | **拒绝** — 崩溃不可恢复 |
| C | SQLite / 外部 DB | **拒绝** — 零运行时依赖约束 |

### 2.3 目录发布原子性

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | 纯 Node 双 rename：`target→anchor` 然后 `staging→target`；每次 rename 各自原子；两步之间允许短暂 target absent；不宣称 single-syscall / zero-gap | **采用** |
| B | 宣称 `renameat2(RENAME_EXCHANGE)` / 零空窗原子交换 | **拒绝** — Node 24 可移植路径与诚实边界不足；不得写入完成宣称 |
| C | 复制覆盖 target | **拒绝** — EXDEV 与半覆盖风险；用户明确要求 fail-closed 不降级复制 |
| D | 删除 target 后 rename staging | **拒绝** — 无 rollback anchor |

### 2.4 并发池

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | upload + restore **共享**单一 global live-transfer semaphore；slot 仅 live binary request 内持有；同设备 nonterminal admission 互斥 | **采用**（对齐 Gold §并发，修正跨断连占槽） |
| B | upload 与 restore 两个独立全局池各 4 | **拒绝** — 可静默放大到 8 并发传输，违背默认 4 硬语义 |
| C | 仅 per-device 锁、无全局信号量 | **拒绝** — 无背压 |
| D | claim/active task 长期占用 global slot | **拒绝** — 离线 task 永久占槽 |

### 2.5 路径模型

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | endpoint 本地配置 `restoreRoot`；Controller 下发 `relativeTarget`；GET task JSON 返回 snapshot-root-relative file `path`；禁止 absolute endpoint path 与 URL/header path | **采用** |
| B | Controller 下发端点绝对路径 | **拒绝** — 泄漏与越权面 |
| C | files[] 无 path，仅 fileIndex | **拒绝** — endpoint 无法重建目录树（functional gap） |
| D | path 放入 chunk URL 或 header | **拒绝** — 日志/代理泄漏 |

### 2.6 Cleanup 时序

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| **A** | 两阶段：receipt ACK ⇒ `cleanupAuthorized`；endpoint 删 staging/anchor/quarantine 后 POST `CleanupReceipt`；Controller 验证后终态；tombstone 重放直至 cleanup ACK | **采用** |
| B | cleanup ACK 才授权 endpoint 开始删工件 | **拒绝** — 颠倒责任；ACK 丢失时 endpoint 无法安全推进 |
| C | receipt ACK 直接 `status=cleaned` | **拒绝** — 未证明 endpoint 工件已清理 |

---

## 3. 现状基线（只读事实）

### 3.1 可复用资产

| 模块 | 冻结能力 | G0c 用法 |
| --- | --- | --- |
| `src/agent-listener.js` | HTTPS TLS-only；G0a enroll/heartbeat/rotate；G0b upload routes；`MAX_AGENT_JSON_BODY_BYTES = 64 KiB`；Bearer exact-one via `rawHeaders`；auth-before-lookup；`headersTimeout=10s`；`requestTimeout=0` + per-route deadlines；upload path-aware **1200/min**；legacy G0a **60/min** | **扩展** restore routes + **独立** restore IP limiter 1200/min；chunk GET 接入共享 live-transfer semaphore；不得削弱 G0a/G0b |
| `src/device-client.js` | pinned TLS；Keychain token；`requestPinnedJson` / `requestPinnedBinary`；upload resume budget 8；Retry-After 1..30 | **新增** pinned streaming download client；pin 成功前不接受/落盘 secret-bearing body |
| `src/device-registry.js` | digest-only token；`authenticate` → 绑定 `deviceId` | 认证 `deviceId` 为 restore scope **唯一 SoT** |
| `src/controller-runtime.js` | 双 listener；`ensureSafeDataRoot`；装配 upload store/locks/service | **唯一**生产装配点：创建 restore task store/service 并与共享 live-transfer semaphore / per-device admission 注入 listener + management server |
| `src/upload-locks.js` | global active-transfer 默认 4、范围 1..16；非法 fail-closed；keyed runners | G0c **扩展/对齐**为 **live binary transfer** 语义：G0b putChunk 与 G0c chunk GET **同一**全局信号量；**claim 不占槽**；同设备互斥靠 **持久化 nonterminal admission** + 短 per-device state mutex，**不**靠跨 HTTP Promise lease |
| `src/upload-*.js` | session/chunk/commit/service | **不**复用 upload session 目录语义；restore 独立模块；live-transfer 信号量共享 |
| `src/storage.js` | remote-upload readers 以 valid `COMPLETED.json` + digest 为可读边界；`restoreSnapshot` 本机路径；`slugify` / `safeDevicePath` | Controller 供 endpoint 拉取的 snapshot **必须**通过既有 readable 判定；G0c **不**用本机 `restoreSnapshot` 充当 endpoint publish |
| `src/safe-data-files.js` | root-relative / no-follow / O_NOFOLLOW / atomic write | Controller task store 与 endpoint private state 必经 |
| `src/server.js` | loopback 管理面；write-token；required write-admission audit；既有 `POST /api/restore` 本机恢复 | **新增** restore-tasks 管理路由；既有本机 restore **保留**，语义不与 G0c 混称完成 |
| `src/error-codes.js` | 当前含 G0b 后 **74** 个注册码 + `UPLOAD_ERROR_HTTP_CONTRACT` | C1 新增 **14** 个 `restore-*` 与 `RESTORE_ERROR_HTTP_CONTRACT`（协调 count → **88**） |
| `src/version.js` | `LINKE_RELEASE_VERSION = 'V1.41'` | 仅 C8/收尾阶段改为 **`V1.42`** |

### 3.2 既有本机 restore 与 G0c 边界

- 现有 `POST /api/restore` + `storage.restoreSnapshot`：控制器**本机**把 snapshot 复制到本机 `targetPath`（受 `restoreRoot` 约束）。
- G0c：loopback **创建**不可变 restore task；**端点**从 Agent TLS 拉取 chunk 到 endpoint staging，在 endpoint 本机 publish。
- 两者共存；验收与 Gold 证据中 **不得**用本机 restore 冒充 G0c endpoint-pull。

### 3.3 不得触碰

- `package-lock.json`（禁止任何操作）
- G0a 真实报告正文
- V2 Noise M1/M2 结论
- Gold 9-item statuses（docs 阶段与自动实现默认 **不**改；无 real PASS 报告时 **禁止**抬升）
- G0b real-LAN 报告（仍 absent；不得伪造）

---

## 4. 术语

| 术语 | 定义 |
| --- | --- |
| **RestoreTask** | Controller 上不可变任务主体（`TASK.json`）+ 可变 status/receipt/cleanup（`STATUS.json`） |
| **taskId** | 控制器 `randomUUID()`；客户端不可指定；唯一任务定位符 |
| **snapshotId** | 已存在且对目标 device 可读的 snapshot 身份 |
| **relativeTarget** | 相对 endpoint `restoreRoot` 的严格规范化相对路径；Controller 唯一下发的**目标目录**定位 |
| **file path（snapshot-root-relative）** | 权威 manifest 内文件相对 snapshot 根的路径；与 G0b upload manifest path 规则相同；出现在 GET task JSON `files[].path` |
| **restoreRoot** | 仅 endpoint 本地配置的绝对根目录；永不进入 Controller wire 响应 |
| **staging** | target 的隐藏同级目录；完整物化待发布树 |
| **rollback anchor** | target 的隐藏同级目录；publish 前由旧 target rename 而来 |
| **quarantine** | published 验证失败时新 target 被移入的隐藏同级目录 |
| **ReceiptObject** | endpoint 业务完成证明：`outcome ∈ {completed, rolled-back}`；可幂等重发 |
| **CleanupReceipt** | endpoint 工件清理完成证明：`outcome ∈ {completed, rolled-back, cancelled}`；可幂等重发 |
| **cleanupAuthorized** | Controller 已接受业务 ReceiptObject 后的布尔授权；**不**等于 `status=cleaned` |
| **tombstone** | endpoint 在删除 staging/anchor/quarantine 后保留的最小 STATE + CleanupReceipt 持久化，用于 cleanup ACK 丢失重放 |
| **live transfer work unit** | 占用 global semaphore 的单次 live binary 请求：G0b putChunk；G0c chunk GET 的读盘+发送 |
| **admission nonterminal（Controller）** | `STATUS.status ∈ {pending, active}` — 用于同设备 one-active 准入 |
| **business terminal（cleanup pending）** | `status ∈ {completed, rolled-back}`：业务结局已接受，**仍**待 CleanupReceipt；**不是** final cleaned |
| **final terminal** | `status=cleaned`（completed/rolled-back 清理完成）或 `status=cancelled` 且 `cleanupAckAt != null`（取消清理完成）或 pending 直接 cancel 的 `cancelled`（无 endpoint 工件） |
| **anchor-intent** | endpoint 已决定开始 `target→anchor` rename 的持久化意图点；此点后禁止将 cancel 当作无结果取消 |
| **claim** | endpoint 向 Controller 领取 pending task 的认证动作（**不是** G0b publish claim 文件）；**不**占用 global semaphore |

---

## 5. 组件边界

```text
┌──────────────── Loopback Management (127.0.0.1) ────────────────┐
│  POST/GET/cancel restore-tasks                                   │
│  write-token + required audit admission (create/cancel)          │
│  不承载 chunk 数据面                                              │
└───────────────────────────────┬──────────────────────────────────┘
                                │ creates immutable TASK.json
                                v
┌──────────────── Controller dataDir ──────────────────────────────┐
│  restore-tasks/<taskId>/{TASK.json, STATUS.json}                 │
│  readable snapshots under repo/devices/<slug>/snapshots/...      │
│  shared live-transfer semaphore (upload putChunk + restore GET)  │
└───────────────────────────────┬──────────────────────────────────┘
                                │ Agent TLS :3443 private LAN
          claim / task / chunk / progress / receipt / cleanup
                                v
┌──────────────── Endpoint Agent ──────────────────────────────────┐
│  pinned HTTPS pull client                                        │
│  private dataDir (0600) task state — relative paths + digests    │
│  restoreRoot-local: staging / anchor / quarantine (hidden sibs)  │
│  dual-rename publish + fingerprint rollback + two-phase cleanup  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.1 责任分割（冻结）

| 组件 | 职责 | 禁止 |
| --- | --- | --- |
| Restore task store（Controller） | 不可变 TASK、可变 STATUS、幂等 create、one-active admission、cancel 门、receipt ACK（`cleanupAuthorized`）、CleanupReceipt 验证与终态 | 不监听端口；不读 endpoint 绝对路径；不自动删除异身份工件；receipt ACK **不得**直接 `cleaned` |
| Restore service（Controller） | claim、task 摘要（含 files path）、chunk 读取、progress、receipt、cleanup 编排 | 不绕过 auth；不跨 device 查 task；claim **不**检查/占用 global semaphore |
| Shared live-transfer semaphore | 仅 G0b putChunk 与 G0c chunk GET（及实现 plan 内**同请求内**有界 verify 若与 binary 同 unit） | 跨请求/跨断连持有；claim/progress/receipt/cleanup 占槽 |
| Per-device admission + state mutex | 持久化 nonterminal 互斥（upload OR restore）；短临界区写 STATUS/session | 用跨 HTTP Promise lease 冒充同设备互斥 |
| `agent-listener.js` | restore routes、restore IP limiter、auth triad、deadlines、chunk 路径 acquire/release 信号量 | 无 service 时 restore routes **不存在**（404） |
| loopback `server.js` | restore-tasks create/status/cancel | 不把 chunk 挂管理面；不返回 endpoint 绝对路径 |
| Endpoint restore engine | preflight、receive、verify、anchor/publish/rollback、两阶段 cleanup | 不跟随 symlink ancestor；不 EXDEV 复制降级；未 `cleanupAuthorized` 前不删 anchor/quarantine（cancel 未发布 staging 除外，§9.4） |
| Endpoint download client | pin-first streaming GET chunk | pin 前不落盘 body；integrity 失败不 retry |
| `controller-runtime.js` | 装配 store/locks/service 并注入双 listener | 半成品不暴露 public routes |

---

## 6. 目录布局

### 6.1 Controller dataDir

```text
dataDir/
  repo/
    devices/
      <deviceSlug>/                         # slugify(authenticated or management deviceId)
        snapshots/
          <snapshotId>/                     # 既有 G0b/local 布局
            COMPLETED.json                  # remote-upload 可读前提（local 兼容规则不变）
            manifest.json
            files/...
        restore-tasks/
          <taskId>/
            TASK.json                       # 不可变；atomic create once
            STATUS.json                     # 可变；atomic replace
```

规则：

1. `deviceSlug` 仅来自 `slugify(deviceId)` / `safeDevicePath`。
2. task 目录名 = 服务端 `taskId`（UUID）。
3. `TASK.json` 一旦成功创建，**字节语义不可变**（禁止 rewrite 字段）。
4. `STATUS.json` 仅允许注册状态迁移与 receipt/cleanup 字段更新；`cleaned` **不得**抹掉已接受的 `receipt` 与业务 `outcome`。
5. Controller **不**存储 endpoint 绝对路径、staging/anchor 绝对路径。

### 6.2 Endpoint private dataDir（任务状态；0600）

```text
endpointDataDir/                            # ensureSafeDataRoot；目录/文件权限 0700/0600
  restore-tasks/
    <taskId>/
      STATE.json                            # 可变 endpoint 状态机 / tombstone
      RECEIPT.json                          # completed 或 rolled-back ReceiptObject；可幂等重发
      CLEANUP-RECEIPT.json                  # CleanupReceipt tombstone；可幂等重发
      MANIFEST.DIGEST                       # 期望 manifestDigest（64 hex）等安全摘要字段
      progress.json                         # 可选；仅计数与 fileIndex/chunkIndex
```

规则：

1. endpoint task state 可存：`relativeTarget`、snapshot-root-relative file paths（若本地缓存 GET task 结果）、摘要、计数、枚举状态、taskId/snapshotId。
2. **禁止**把 `restoreRoot` 拼接后的绝对 target/staging/anchor 路径写入 STATE 的可序列化对外字段、日志、receipt、wire。
3. 文件 mode：**0600**；目录 **0700**；创建时 fail-closed 校验。
4. no-follow：所有 state I/O 经 safe-data-files 语义；symlink/type swap → `restore-state-invalid`。
5. 进入 `cleanup-completed-awaiting-ack` 后：staging/anchor/quarantine **已删**；保留最小 STATE + `CLEANUP-RECEIPT.json`（及业务 `RECEIPT.json` 若存在）作为 tombstone，直至 cleanup ACK。

### 6.3 Endpoint restoreRoot 工作区（隐藏同级工件）

对规范化后的目标目录 `target = restoreRoot / relativeTarget`：

```text
<parent-of-target>/
  <target-basename>/                        # 最终发布目录（relativeTarget 指向）
  .<safeTaskId>.linke-restore-staging/      # staging
  .<safeTaskId>.linke-restore-anchor/       # rollback anchor
  .<safeTaskId>.linke-restore-quarantine/   # failed published tree
```

名称派生（冻结）：

1. `safeTaskId` = `taskId` 的安全派生：仅保留 `[0-9a-f-]`；必须匹配 UUID 正则；否则 fail-closed `restore-task-invalid`（endpoint 侧不应出现；若 STATE 损坏则 `restore-state-invalid`）。
2. staging / anchor / quarantine **必须**是 target 的**隐藏同级**目录（同一 `dirname(target)`）。
3. **禁止**把 staging 放在 target 内部或 dataDir 内再 copy 到跨设备路径。
4. preflight `stat.dev`：仅对**已存在**的 `parent-of-target` 与 **已存在**的 `target`（若有）执行 `lstat`/`stat`；要求其 `dev` 全等。staging/anchor/quarantine **未来路径不 stat**；它们继承 `parent-of-target` 的 `dev`。parent 不存在或不可用、或 target 存在但 `dev` 与 parent 不一致 → `restore-path-invalid` 400。**EXDEV 风险 fail-closed**，**绝不**复制覆盖降级。

### 6.4 权限与 no-follow

| 对象 | 要求 |
| --- | --- |
| endpointDataDir 文件 | `0600` |
| endpointDataDir 目录 | `0700` |
| Controller task 文件 | dataDir 既有安全根策略 + atomic write；不跟随 symlink |
| staging/anchor/quarantine/target 遍历 | `lstat` / `O_NOFOLLOW`；ancestor 不得为 symlink |
| 最终 publish 后 target | 普通目录树；不得通过 symlink 逃逸 restoreRoot |

---

## 7. Task / State / Receipt Schemas

### 7.1 通用标量约束

| 类型 | 约束 |
| --- | --- |
| UUID | `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/` 小写 |
| SHA-256 | `/^[a-f0-9]{64}$/` |
| ISO time | 毫秒 UTC：`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` 且日历合法 |
| safe integer | `Number.isSafeInteger`；禁止浮点/NaN/Infinity/字符串数字 |
| plain object | 无 hostile prototype getters；unknown keys → invalid；exact-key projection |

### 7.2 Controller `TASK.json`（不可变）

```text
{
  "schemaVersion": 1,
  "taskId": "<uuid>",
  "deviceId": "<deviceId string>",
  "snapshotId": "<uuid>",
  "manifestDigest": "<64 lower hex>",
  "relativeTarget": "<strict relative path>",
  "createdAt": "<ISO-8601 ms Z>",
  "fileCount": <safe int >= 0>,
  "totalBytes": <safe int >= 0>,
  "chunkSize": 8388608
}
```

| 键 | 类型 | 限制 |
| --- | --- | --- |
| `schemaVersion` | number | 必须为 `1` |
| `taskId` | string | UUID；服务端生成 |
| `deviceId` | string | 非空；与管理面路径 deviceId 全等；长度 ≤ 256 UTF-8 bytes |
| `snapshotId` | string | UUID |
| `manifestDigest` | string | 64 lower hex；必须等于可读 snapshot 的权威 digest |
| `relativeTarget` | string | §7.5；UTF-8 bytes ≤ 1024 |
| `createdAt` | string | ISO ms Z |
| `fileCount` | number | 与 manifest 一致；≤ 100_000 |
| `totalBytes` | number | 与 manifest 一致；≤ Number.MAX_SAFE_INTEGER |
| `chunkSize` | number | **固定** `8 * 1024 * 1024` = `8388608` |

**禁止键：** endpoint 绝对路径、hostname、ipAddress、token、任意未知键。

**不可变规则：** 成功写入后任何字段变更尝试 → `restore-state-invalid`（内部）并 fail-closed；对外 create 幂等见 §9。

### 7.3 Controller `STATUS.json`（可变）

```text
{
  "schemaVersion": 1,
  "taskId": "<uuid>",
  "status": "pending|active|completed|rolled-back|cancelled|cleaned",
  "updatedAt": "<ISO-8601 ms Z>",
  "claimedAt": "<ISO-8601 ms Z>" | null,
  "completedAt": "<ISO-8601 ms Z>" | null,
  "receipt": null | <ReceiptObject>,
  "receiptAckAt": "<ISO-8601 ms Z>" | null,
  "cleanupAuthorized": true | false,
  "cleanupReceipt": null | <CleanupReceipt>,
  "cleanupAckAt": "<ISO-8601 ms Z>" | null,
  "cancelRequestedAt": "<ISO-8601 ms Z>" | null,
  "lastProgress": null | {
    "fileIndex": <safe int>,
    "chunkIndex": <safe int>,
    "receivedBytes": <safe int>,
    "updatedAt": "<ISO-8601 ms Z>"
  }
}
```

| status | 含义 | admission nonterminal? | 业务/清理语义 |
| --- | --- | --- | --- |
| `pending` | 已创建，未被 endpoint claim | **yes** | 非业务完成 |
| `active` | 已被 claim；传输/发布/取消握手进行中 | **yes** | 可含 `cancelRequestedAt != null` 且**仍** `active` |
| `completed` | 已接受 `ReceiptObject(outcome=completed)`；**business terminal, cleanup pending** | no | `cleanupAuthorized=true`；`receipt` **必须保留**；**尚未** `cleaned` |
| `rolled-back` | 已接受 `ReceiptObject(outcome=rolled-back)`；**business terminal, cleanup pending** | no | 同上 |
| `cancelled` | 取消终态：pending 直接取消，或 active 取消且已接受 `CleanupReceipt(outcome=cancelled)` | no | 必须保留业务结局为取消；`cleanupAckAt` 在 endpoint 清理完成时非 null；**不**迁到 `cleaned`（避免抹掉 cancelled 结局） |
| `cleaned` | completed/rolled-back 的 **final terminal**：已接受匹配 `CleanupReceipt` | no | **必须保留**原 `receipt` 与 `receipt.outcome`；**禁止**清空 receipt 来“瘦身” |

**术语冻结：**

1. `completed` / `rolled-back` = **business terminal but cleanup pending**（可观测业务结局已定，工件清理未 ACK）。
2. `cleaned` = 仅 completed/rolled-back 路径的 final terminal；**不得**抹掉 `receipt` / final outcome。
3. `cancelled` = 取消路径 final terminal（pending 直取消时无 cleanup 工件；active 取消时带 `cleanupAckAt`）。
4. **不得**引入与上表矛盾的 `status` 枚举值。
5. **admission nonterminal（one-active）：** 仅 `pending` 或 `active`。`completed`/`rolled-back`/`cancelled`/`cleaned` **均不**阻塞同设备新建 restore task。

**字段规则：**

1. 接受 completed/rolled-back receipt 成功时：写 `receipt`、`receiptAckAt`、`completedAt`（适用时）、`status` 对应值、`cleanupAuthorized=true`；**status 不得**直接变 `cleaned`。
2. 接受匹配 `CleanupReceipt` 且 outcome 为 completed/rolled-back：写 `cleanupReceipt`、`cleanupAckAt`、`status=cleaned`；`receipt` 保持不变。
3. 接受 `CleanupReceipt(outcome=cancelled)`：要求 `status=active` 且 `cancelRequestedAt != null`；写 `cleanupReceipt`、`cleanupAckAt`、`status=cancelled`；`receipt` 保持 `null`。
4. `cleanupAuthorized` 默认 `false`；仅业务 receipt ACK 置 `true`；cancel 路径不依赖该标志（使用 `cancelRequestedAt` + CleanupReceipt）。

### 7.4 ReceiptObject（completed / rolled-back）

```text
{
  "schemaVersion": 1,
  "taskId": "<uuid>",
  "deviceId": "<deviceId>",
  "snapshotId": "<uuid>",
  "manifestDigest": "<64 hex>",
  "outcome": "completed" | "rolled-back",
  "relativeTarget": "<strict relative path>",
  "totalBytes": <safe int>,
  "fileCount": <safe int>,
  "contentSha256": "<64 hex>" | null,
  "structureFingerprint": "<64 hex>" | null,
  "publishedVerifiedAt": "<ISO ms Z>" | null,
  "rolledBackAt": "<ISO ms Z>" | null,
  "anchorPresentBeforePublish": true | false,
  "receiptId": "<uuid>"
}
```

**fingerprint nullability（冻结唯一表）：**

| outcome | `anchorPresentBeforePublish` | `contentSha256` | `structureFingerprint` |
| --- | --- | --- | --- |
| `completed` | `true` 或 `false` | **必须** 64 lower hex（真实 target 复验） | **必须** 64 lower hex |
| `rolled-back` | `true`（old target existed） | **必须** 64 lower hex（= old 记录） | **必须** 64 lower hex |
| `rolled-back` | `false`（original target absent） | **必须** `null` | **必须** `null` |

其它组合（例如 completed 带 null、rolled-back+true 带 null、一个 null 一个 hex）→ `restore-task-invalid` 或 receipt 接受时 `restore-task-conflict`：冻结为 **`restore-task-invalid` 400**（schema）在校验层；若已过 schema 但与 Controller 记录的 preflight 期望冲突 → **`restore-task-conflict` 409**。

其它规则：

1. `outcome=completed`：`publishedVerifiedAt` 非 null；`rolledBackAt` 必须 null。
2. `outcome=rolled-back`：`rolledBackAt` 非 null；`publishedVerifiedAt` 必须 null。
3. receipt **可幂等重发**：相同 `receiptId` + 全字段一致 → ACK 幂等；同 task 不同字段 → `restore-task-conflict`。
4. **禁止**包含 endpoint 绝对路径、errno、raw message。
5. 成功 ACK **仅**表示 Controller 接受业务结局且 `cleanupAuthorized=true`；**不**表示 endpoint 工件已删除，**不**将 status 设为 `cleaned`。

### 7.5 CleanupReceipt（两阶段 cleanup 报告）

```text
{
  "schemaVersion": 1,
  "cleanupId": "<uuid>",
  "taskId": "<uuid>",
  "deviceId": "<deviceId>",
  "outcome": "completed" | "rolled-back" | "cancelled",
  "receiptId": "<uuid>" | null,
  "cleanedAt": "<ISO-8601 ms Z>"
}
```

| 键 | 类型 | 限制 |
| --- | --- | --- |
| `schemaVersion` | number | `1` |
| `cleanupId` | string | UUID；endpoint 生成；幂等键 |
| `taskId` | string | UUID；与 URL/task 一致 |
| `deviceId` | string | 必须等于 authenticated deviceId |
| `outcome` | string | 三选一枚举 |
| `receiptId` | string\|null | `outcome=cancelled` → **必须** `null`；`completed`/`rolled-back` → **必须** 等于已接受 `ReceiptObject.receiptId` |
| `cleanedAt` | string | ISO ms Z |

**禁止键：** 任何 path、绝对路径、staging/anchor/quarantine 名以外的自由字符串、raw error。

**幂等：** 相同 `cleanupId` + 全字段一致 → cleanup ACK 幂等重放。不同 `cleanupId` 或字段冲突 → `restore-task-conflict` 409。

### 7.6 `relativeTarget` 规范化（严格）

输入必须满足 **全部** 条件，否则 `restore-path-invalid`（管理面 create）或 endpoint 本地拒绝：

1. 类型 string；非空；UTF-8 byte length ∈ `[1, 1024]`。
2. 使用 `/` 分隔；**禁止** `\`。
3. **禁止**绝对路径：不得以 `/` 开头。
4. 分段后 **禁止** 空段、`.`、`..`。
5. **禁止** NUL 与 C0/C1 控制字符（含 `\n` `\r`）。
6. 规范化结果不得改变语义（重复 `/` → invalid，不静默塌缩后接受——**严格拒绝**未规范化输入）。
7. 解析后在 endpoint 与 `restoreRoot` 拼接时：最终 resolved 路径必须严格保持在 `restoreRoot` 内；任一 ancestor `lstat` 为 symlink → `restore-path-invalid`。
8. wire/log/response **只**出现 `relativeTarget` 作为**目标目录**相对路径，**永不**出现拼接后 endpoint 绝对路径。

### 7.7 Snapshot-root-relative file `path`（与 G0b upload manifest 对齐）

`files[].path` 必须是**规范安全相对路径**（相对 snapshot 根，不是 restoreRoot）：

1. 非空；UTF-8 byte length ≤ **1024**。
2. 无空段；无 `.` / `..` 段。
3. 无反斜杠 `\`；无 NUL；无 C0/C1 control。
4. 非绝对路径；不以 `/` 开头。
5. 唯一；与权威 manifest 排序/投影一致。
6. **允许且必须**出现在 GET task JSON body 的 `files[]` 中，供 endpoint 在 staging 下重建目录树。
7. **禁止**进入 URL、header、query。
8. **禁止**与 endpoint absolute target path 混淆；日志默认字段不得打印 `restoreRoot + relativeTarget + path` 拼接绝对路径。

### 7.8 Endpoint `STATE.json`

```text
{
  "schemaVersion": 1,
  "taskId": "<uuid>",
  "deviceId": "<deviceId>",
  "snapshotId": "<uuid>",
  "manifestDigest": "<64 hex>",
  "relativeTarget": "<strict relative path>",
  "phase": "<endpoint phase enum — exact §10.3>",
  "updatedAt": "<ISO ms Z>",
  "receivedBytes": <safe int>,
  "confirmedFiles": <safe int>,
  "fileCount": <safe int>,
  "totalBytes": <safe int>,
  "chunkSize": 8388608,
  "oldStructureFingerprint": "<64 hex>" | null,
  "oldContentSha256": "<64 hex>" | null,
  "originalTargetExisted": true | false,
  "receiptId": "<uuid>" | null,
  "cleanupId": "<uuid>" | null,
  "cleanupAuthorized": true | false,
  "lastErrorCode": null | "<registered restore-* or device-* code>"
}
```

`phase` 枚举见 **§10.3**（精确字符串，禁止别名）。交叉引用 **仅** §10.3，不以 §10.2 替代。

### 7.9 Endpoint fingerprint 定义（冻结）

**structureFingerprint：**

1. 枚举树（no-follow）：仅普通文件与目录；遇到 symlink → fail-closed `restore-integrity-failed` 或 preflight `restore-path-invalid`。
2. 对每个普通文件记录：`relativePath`（相对 target 根，严格相对）+ `size`（safe int）。
3. 对每个目录记录：`relativePath` + type `dir`。
4. 记录按 path UTF-8 字节序排序。
5. canonical JSON（无多余空白、固定键序）UTF-8 字节的 SHA-256 → 64 lower hex。

**contentSha256：**

1. 按 path UTF-8 字节序遍历全部普通文件。
2. 对每个文件：`path` + NUL + `size` 八字节 big-endian + 文件原始内容，流式更新单一 SHA-256。
3. 输出 64 lower hex。
4. 空目录树：零文件时 contentSha256 = SHA-256(empty) = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`；structureFingerprint 仍按目录集合计算。

publish 前若 `originalTargetExisted=true`：必须先计算并持久化 `oldStructureFingerprint` 与 `oldContentSha256`，再进入 `anchor-intent`。
若 `originalTargetExisted=false`：**禁止**创建伪 anchor；两 old fingerprint 字段必须为 `null`。

---

## 8. 精确路由与 Wire

### 8.1 Loopback 管理面

| Method | Path | Auth | Body | 成功 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/devices/:deviceId/restore-tasks` | **write-token** + **required audit admission** | JSON ≤ 64 KiB | `201` 新建 / `200` 幂等 + task 安全摘要 |
| `GET` | `/api/devices/:deviceId/restore-tasks/:taskId` | read 或 write token（与现有读路由一致） | 无 | `200` + status 安全摘要 |
| `POST` | `/api/devices/:deviceId/restore-tasks/:taskId/cancel` | **write-token** + **required audit admission** | JSON 空对象或省略；≤ 64 KiB | 见 §9.4：`200` 或 `202` |

**Create body exact keys：**

```text
{
  "snapshotId": "<uuid>",
  "relativeTarget": "<strict relative path>"
}
```

- 未知键 → `restore-task-invalid`（HTTP 400）。
- `deviceId` **仅**来自 URL；body 不得覆盖；若 body 含 `deviceId` → `restore-task-invalid`。

**Create 成功响应 allowlist：**

```text
{
  "taskId": "...",
  "deviceId": "...",
  "snapshotId": "...",
  "manifestDigest": "...",
  "relativeTarget": "...",
  "status": "pending",
  "fileCount": <from-manifest-integer>,
  "totalBytes": <from-manifest-integer>,
  "createdAt": "..."
}
```

> 文中若出现字面量 `0` 作为 `fileCount`/`totalBytes` 示意，**仅为类型示意**；运行时必须来自权威 manifest 实际值，不得把 `0` 当作协议默认值。

**Status 响应 allowlist：** 上表字段 + `status` + `updatedAt` + `cancelRequested`（boolean，= `cancelRequestedAt != null`）+ `cleanupAuthorized` + `lastProgress`（无 endpoint 绝对路径）+ `receipt` 安全子集 + `cleanupReceipt` 安全子集（均无绝对路径）。

**Cancel 响应：** §9.4。

**管理面响应禁止：** endpoint 绝对路径、staging/anchor/quarantine 绝对路径、raw stack、errno、token。

**Headers（管理面）：** 遵循现有 loopback bearer/write-token 机制；JSON `Content-Type: application/json`；`Cache-Control: no-store`。

### 8.2 Agent TLS 数据面

| Method | Path | Body | 成功 |
| --- | --- | --- | --- |
| `POST` | `/agent/restore/tasks/claim` | JSON ≤ 64 KiB；可 `{}` | `200` claim 结果 |
| `GET` | `/agent/restore/tasks/:taskId` | 无 | `200` task 安全摘要 + files（含 path）+ `cancelRequested` |
| `GET` | `/agent/restore/tasks/:taskId/files/:fileIndex/chunks/:chunkIndex` | 无 | `200` application/octet-stream；满载 → `429 restore-backpressure` |
| `POST` | `/agent/restore/tasks/:taskId/progress` | JSON ≤ 64 KiB | `200` ACK + `cancelRequested` |
| `POST` | `/agent/restore/tasks/:taskId/receipts` | JSON ≤ 64 KiB | `200` receipt ACK（`cleanupAuthorized=true`） |
| `POST` | `/agent/restore/tasks/:taskId/cleanup` | JSON ≤ 64 KiB `CleanupReceipt` | `200` cleanup ACK |

**不新增路由。** cleanup 仍为既有 path；body 改为完整 `CleanupReceipt`。

### 8.3 全部 authenticated restore routes 的认证顺序（冻结）

**所有** §8.2 路由强制 rawHeaders **exact-one**（大小写不敏感计数）三元组：

| Header | 语义 |
| --- | --- |
| `Authorization: Bearer <token>` | exact-one Bearer |
| `X-Linke-Device-Id` | 认证输入候选 deviceId；**不是** storage SoT |
| `X-Linke-Protocol-Version` | mandatory current/N-1 整数（字符串严格解析） |

**顺序：**

0. **Path-aware pre-auth IP limiter**（restore 1200/min，§12.4）— 命中 → `device-rate-limited` 429；不读 body、不查 task。
1. 解析三元组 + Bearer 形态；失败 → 既有 `device-token-invalid` / `device-request-invalid` / `device-protocol-unsupported`；**不**读 body、**不**查 task。
2. `registry.authenticate({ deviceId: headerDeviceId, token, protocolVersion })`。
3. **仅**认证返回的 `deviceId` 为 scope SoT。
4. 之后才 lookup `taskId` / 读 body / 读 snapshot。
5. 跨 device 或 scope 内不存在 → **统一** `restore-task-not-found`（404）；**不**泄漏他设备存在性。
6. 重复 critical headers → `device-request-invalid`；**不得**继续处理。

**文件 path 禁止进入 URL、header、query。** chunk 坐标仅 `fileIndex` / `chunkIndex`。
**文件 path 必须进入** GET task JSON `files[].path`（§7.7 / §8.5）。

### 8.4 Claim

**Request body：** `{}` 或省略字段；未知键 → `restore-task-invalid`。

**行为：**

1. 在 authenticated device 的 admission-nonterminal tasks 中领取 **一个** `pending` task（FIFO by `createdAt` then `taskId`）。
2. 无 pending → `200` + `{ "task": null }`（非错误）。
3. 有 pending → atomic：`STATUS.status: pending→active`，写 `claimedAt`；返回 task 安全摘要。
4. 同设备已有 `active` restore → `restore-task-conflict` 409。
5. 同设备已有 active **upload** session（G0b nonterminal）→ `restore-task-conflict` 409。
6. **不**检查、**不**占用 global live-transfer semaphore。全局满载 **不**导致 claim `restore-backpressure`。

**Claim 响应 allowlist：**

```text
{
  "task": null | {
    "taskId": "...",
    "snapshotId": "...",
    "manifestDigest": "...",
    "relativeTarget": "...",
    "status": "active",
    "fileCount": <from manifest>,
    "totalBytes": <from manifest>,
    "chunkSize": 8388608,
    "createdAt": "...",
    "claimedAt": "...",
    "cancelRequested": false
  }
}
```

### 8.5 GET task

返回：

```text
{
  "taskId": "...",
  "snapshotId": "...",
  "manifestDigest": "...",
  "relativeTarget": "...",
  "status": "active|completed|...",
  "cancelRequested": true | false,
  "cleanupAuthorized": true | false,
  "fileCount": <from manifest>,
  "totalBytes": <from manifest>,
  "chunkSize": 8388608,
  "files": [
    {
      "fileIndex": 0,
      "path": "<snapshot-root-relative strict path>",
      "size": <safe int>,
      "sha256": "<64 hex>",
      "chunkCount": <safe int>
    }
  ]
}
```

**`files[]` entry exact keys（冻结）：** `fileIndex` / `path` / `size` / `sha256` / `chunkCount`。未知键不得出现在响应中。

规则：

1. `files[]` 按 `fileIndex` 升序；与权威 manifest 一致。
2. `path` **必须**存在且满足 §7.7；endpoint **必须**用其在 staging 下重建目录与文件布局。
3. `chunkCount = size===0 ? 0 : ceil(size / 8388608)`。
4. `cancelRequested === (cancelRequestedAt != null)`；**不**返回任何路径类取消目标。
5. snapshot 不可读 / digest 漂移 → fail-closed：`restore-integrity-failed` 422。
6. **响应 hard cap：** `MAX_RESTORE_TASK_JSON_BYTES = 1 * 1024 * 1024`。create preflight 必须按**含 path** 的 files 元数据编码估算；超过 → create **`restore-task-invalid` 400**。
7. endpoint absolute target path **永不**进入本响应。

### 8.6 GET chunk

**URL 参数：** `fileIndex`、`chunkIndex` 非负十进制整数，无前导零（`0` 允许），safe int。**无 path。**

**成功响应：**

| 项 | 值 |
| --- | --- |
| status | `200` |
| `Content-Type` | `application/octet-stream` |
| `Content-Length` | exact chunk bytes |
| `Cache-Control` | `no-store` |
| `X-Linke-Task-Id` | taskId |
| `X-Linke-File-Index` | fileIndex |
| `X-Linke-Chunk-Index` | chunkIndex |
| `X-Linke-Chunk-Offset` | offset |
| `X-Linke-Chunk-Size` | size |
| `X-Linke-Chunk-Sha256` | 64 lower hex |

规则：

1. chunk 尺寸语义与 G0b 对称：`CHUNK_SIZE=8MiB`；非最后 chunk exact 8MiB；最后 chunk ∈ `[1, 8MiB]`；空文件 **无** chunk，GET 任何 chunkIndex → `restore-task-invalid` 400。
2. identity headers 与 body 长度、服务端重算 SHA-256 **全匹配**。
3. under/over-read 内部错误 → single-settle 错误；不写部分成功状态。
4. 非法 index → `restore-task-invalid` 400。
5. task 状态不允许下载：
   - 同设备已知 task 但状态不允许 → **`restore-task-conflict` 409**
   - 跨设备/不存在 → **`restore-task-not-found` 404**
6. **Global live-transfer semaphore：** 进入读盘+发送前 acquire；满载 → **`restore-backpressure` 429** + `Retry-After` 1..30；request settle / abort / timeout **必须** release。不得在 acquire 前开始发送 body。

### 8.7 Progress

**Body exact keys：**

```text
{
  "fileIndex": <safe int >= 0>,
  "chunkIndex": <safe int >= 0>,
  "receivedBytes": <safe int >= 0>
}
```

- 未知键 → `restore-task-invalid`。
- 单调性：`receivedBytes` 不得超过 `totalBytes`；回拨 → `restore-task-invalid`。
- 仅更新 `lastProgress`；不单独改变 business terminal status。
- **成功响应 must include：** `{ "ok": true, "cancelRequested": <boolean> }`（allowlist；可含安全计数，无路径）。

### 8.8 Receipts（业务 ACK = cleanupAuthorized）

**Body：** ReceiptObject（§7.4）exact keys。

规则：

1. auth-before-lookup。
2. task 必须属于 authenticated device。
3. `outcome=completed` → `status=completed`，持久化 `receipt`，`receiptAckAt=now`，`cleanupAuthorized=true`；**不**变 `cleaned`。
4. `outcome=rolled-back` → `status=rolled-back`，同上。
5. 幂等重放相同 receipt → `200` 相同 ACK（仍 `cleanupAuthorized=true`）。
6. 不同 `receiptId` 或字段冲突 → `restore-task-conflict` 409。
7. 若 `cancelRequestedAt != null` 且 endpoint 已过 anchor-intent 并提交匹配 completed/rolled-back receipt：**必须接受**（取消不能推翻已锚定发布结局）。
8. 若 `status=cancelled` 已 final → receipt → `restore-task-conflict`。
9. **成功 ACK 语义：** 仅 `cleanupAuthorized=true` + business status；endpoint 随后才可删除 task-specific staging/anchor/quarantine（§10.5）。**禁止**把本 ACK 描述为“授权后才允许开始删”的反相——本 ACK **就是**删除发布工件的授权；cleanup 路由是删除**完成报告**。

**Receipt ACK 响应 allowlist：**

```text
{
  "ok": true,
  "taskId": "...",
  "status": "completed" | "rolled-back",
  "cleanupAuthorized": true,
  "receiptId": "..."
}
```

### 8.9 Cleanup（CleanupReceipt 完成报告）

**Body：** CleanupReceipt（§7.5）exact keys。**不是**仅 `{taskId, receiptId}`。

**Controller 接受条件（唯一表）：**

| CleanupReceipt.outcome | 要求的 STATUS 前置 | 成功后 STATUS |
| --- | --- | --- |
| `completed` | `status=completed` 且 `cleanupAuthorized=true` 且 `receipt.receiptId` 全等 `receiptId` | `cleaned`；保留 `receipt`；写 `cleanupReceipt` + `cleanupAckAt` |
| `rolled-back` | `status=rolled-back` 且 `cleanupAuthorized=true` 且 receiptId 匹配 | `cleaned`；保留 `receipt`；写 `cleanupReceipt` + `cleanupAckAt` |
| `cancelled` | `status=active` 且 `cancelRequestedAt != null` 且 `receiptId === null` | `cancelled`；写 `cleanupReceipt` + `cleanupAckAt`；**不**变 `cleaned` |

其它前置不匹配 → **`restore-task-conflict` 409**。
Controller 状态写失败 → **`restore-cleanup-failed` 500**。

**幂等：**

- 已 `cleaned` 且相同 `cleanupId`/字段一致 → `200`。
- 已 `cancelled` 且 `cleanupAckAt != null` 且相同 CleanupReceipt → `200`。
- 冲突 cleanupId/字段 → `restore-task-conflict` 409。

**成功响应 allowlist：**

```text
{
  "ok": true,
  "taskId": "...",
  "status": "cleaned" | "cancelled",
  "cleanupId": "...",
  "cleanupAckAt": "..."
}
```

**endpoint 侧（与 Controller 对称）：**

1. 收到业务 receipt ACK（`cleanupAuthorized=true`）后：phase → `cleanup-intent`；删除 **仅本 taskId** 的 staging/anchor/quarantine（存在则删；不存在幂等）；**保留**最小 STATE + `CLEANUP-RECEIPT.json` tombstone（及业务 RECEIPT.json）。
2. 删除成功 → phase `cleanup-completed-awaiting-ack`；POST `/agent/restore/tasks/:taskId/cleanup` 提交 CleanupReceipt。
3. cleanup ACK 丢失：从 tombstone **重放同一 CleanupReceipt**（相同 cleanupId 与字段）。
4. 收到 cleanup ACK 后：删除私有 STATE/RECEIPT/CLEANUP-RECEIPT tombstone；phase → `cleaned`（endpoint 本地）。
5. cancel 路径：见 §9.4 / §10.5；未发布 staging 在 `cancelled-local` 删除后同样进入 `cleanup-completed-awaiting-ack`。
6. **禁止**删除其他 task 工件；**禁止**无 tombstone 的盲扫删除。

### 8.10 响应与 body 总表

| 路由类 | Req body limit | Total deadline | Idle | Global semaphore |
| --- | ---: | ---: | ---: | --- |
| Management create/cancel | 64 KiB | 15_000 ms | n/a | 不参与 |
| Management GET status | 0 | 15_000 ms | n/a | 不参与 |
| claim / task GET / progress / receipts / cleanup | 64 KiB（GET 0） | **15_000 ms** | n/a | **不** acquire |
| chunk GET | 0 req | **120_000 ms** | client：nonempty data **重置 15_000 ms** idle | **必须** acquire→release |

**task GET 响应 cap：** 1 MiB（§8.5）；progress/receipt/cleanup JSON **64 KiB**。

**Single-settle：** 所有路由一次响应；timeout 后 late events 不得二次 `writeHead`/`end`，不得二次状态写；chunk 路径 timeout 必须 release 信号量。

**JSON 错误体 allowlist：**

```text
{ "error": "<registered kebab-case code>" }
```

可选（仅 backpressure / rate-limit）：`Retry-After` header。
**禁止：** `message`、`stack`、endpoint 绝对 path、errno、details 回显。snapshot-root-relative path **不得**出现在错误体中。

---

## 9. Controller 状态机与幂等

### 9.1 状态图

```text
pending ──claim──► active ──ReceiptObject(completed)──► completed ──CleanupReceipt──► cleaned
                      │                                      ▲
                      ├──ReceiptObject(rolled-back)──► rolled-back ──CleanupReceipt──► cleaned
                      │
                      ├──cancel (pending only)──► cancelled          # 200; no endpoint cleanup
                      │
                      └──cancel (active)──► active + cancelRequestedAt   # 202
                              │
                              ├── endpoint pre-anchor CleanupReceipt(cancelled)
                              │         ──► cancelled (+ cleanupAckAt)
                              └── endpoint post-anchor ReceiptObject(completed|rolled-back)
                                        ──► completed|rolled-back ──CleanupReceipt──► cleaned
                                        (cancelRequestedAt 可仍非 null；必须接受匹配 receipt)
```

Controller **不**跟踪 endpoint 全部 phase；cancel 与 cleanup 门见 §9.4 / §8.9。

### 9.2 Create 算法（Plan→Preflight→Execute→Verify）

**Plan**

1. 校验 write-token + required audit admission **先于**任何 task 写入。
2. exact-key body；规范化并校验 `relativeTarget`。
3. 解析 `snapshotId`；**不**信任客户端 manifestDigest（create body 无此字段）。

**Preflight**

1. device 存在且未 revoke（管理面 device 范围）。
2. snapshot 对 device **可读**：沿用 G0b reader 规则（remote-upload 需 valid COMPLETED+digest；local 兼容）。
3. 读取权威 manifest；计算 `manifestDigest`、`fileCount`、`totalBytes`。
4. 估算 GET task JSON（**含** `files[].path`）编码大小；> 1 MiB → `restore-task-invalid` 400。
5. 同设备若已有 admission-nonterminal restore task：
   - 同请求幂等键命中 → 返回既有 task（§9.3）；
   - 否则 → `restore-task-conflict` 409。
6. 同设备若有 active upload nonterminal → create 仍可创建 pending restore，但 claim 时冲突；管理面 create **不**因 upload 拒绝（endpoint claim 时互斥）。冻结：**create 不检查 upload**；**claim 检查 upload**。
7. snapshot 读预检失败 → **`restore-integrity-failed` 422**（内容不可用）或 **`restore-task-invalid` 400**（参数）。

**Execute**

1. 生成 `taskId`。
2. atomic 创建 task 目录 + `TASK.json`（O_EXCL / safe exclusive create）。
3. atomic 写 `STATUS.json`：`status=pending`，`cleanupAuthorized=false`，receipt/cleanup 字段 null。

**Verify**

1. 重读 `TASK.json` 字段全等。
2. 重读 `STATUS.json` 为 `pending`。
3. 返回安全摘要。

### 9.3 幂等与冲突

**Create 幂等键（冻结）：** 相同 `(deviceId, snapshotId, relativeTarget)`。

| 现有 task | 新 create | 结果 |
| --- | --- | --- |
| 无 | — | 新建 `pending` |
| admission-nonterminal；`snapshotId`+`relativeTarget`+权威 `manifestDigest` 全等 | 相同 | **幂等**返回既有 task（**200**） |
| admission-nonterminal；任一 identity 字段不同 | 不同 | **`restore-task-conflict` 409** |
| `completed` / `rolled-back` / `cancelled` / `cleaned` | 任意 | **允许**新建（新 taskId） |

> 管理面 create **不**接受客户端 taskId；幂等仅按业务 identity。

### 9.4 Cancel 门与握手（冻结）

**管理面 `POST .../cancel`：**

| 当前 status | Controller 行为 | HTTP | 响应要点 |
| --- | --- | --- | --- |
| `pending` | `status=cancelled`；`cancelRequestedAt=now`（可写）；无 endpoint 工件 | **200** | `{ "status":"cancelled", "cancelRequested":true }` |
| `active` | **只**写 `cancelRequestedAt=now`；**status 仍为 `active`**；**不得**假装已取消 | **202** | `{ "status":"active", "cancelRequested":true }` |
| `cancelled` 且已是终态 | 幂等 | **200** | 同 cancelled 摘要 |
| `completed` / `rolled-back` / `cleaned` | 拒绝 | **409** `restore-task-conflict` | — |

**endpoint 取消观察（必须）：**

1. GET task 与 progress ACK 均返回 `cancelRequested` boolean（无路径字段）。
2. 进入 **`anchor-intent` 之前**必须做**最后一次** cancel 门刷新（GET task 或依赖最新 progress ACK 中的 `cancelRequested`；推荐显式 GET task）。
3. 若 `phase ∈ {planned, receiving, staging-verified}` 且 `cancelRequested===true`：
   - 进入 `cancelled-local`；
   - **显式删除未发布 staging**（若存在）；**不得**创建/保留伪 anchor；
   - 持久化 `CleanupReceipt`（`outcome=cancelled`，`receiptId=null`，新 `cleanupId`）；
   - phase → `cleanup-completed-awaiting-ack`；
   - POST cleanup 重放直至 ACK；
   - Controller 验证 `active + cancelRequestedAt` 后 → `status=cancelled` + `cleanupAckAt`；
   - endpoint 收 ACK 后删除 tombstone → 本地 `cleaned` phase。
4. 若 phase 已是 **`anchor-intent` 或更后**：
   - **忽略**取消为无结果；
   - **必须**走到 `completed` 或 `rolled-back`（ReceiptObject）；
   - Controller **必须**接受匹配 ReceiptObject，**即使** `cancelRequestedAt != null`；
   - 随后两阶段 cleanup 按 completed/rolled-back 路径 → `cleaned`。

**关键不变量：** Cancel 只允许 endpoint 在 **anchor-intent 前**变为无发布结局的 `cancelled`；之后必须恢复到 new target 或 old target。

---

## 10. Endpoint 状态机

### 10.1 主成功路径 phase

```text
planned
  → receiving
  → staging-verified
  → anchor-intent
  → anchored
  → publish-intent
  → published
  → completed-awaiting-ack          # POST ReceiptObject until receipt ACK
  → cleanup-intent                  # cleanupAuthorized; delete staging/anchor/quarantine
  → cleanup-completed-awaiting-ack  # POST CleanupReceipt until cleanup ACK
  → cleaned                         # local tombstone removed
```

### 10.2 失败 / 回滚路径 phase

```text
published  (verification failed)
  → rollback-intent
  → failed-target-quarantined
  → anchor-restored                 # or absent-target confirmed
  → old-fingerprint-verified
  → rolled-back-awaiting-ack        # POST ReceiptObject
  → cleanup-intent
  → cleanup-completed-awaiting-ack
  → cleaned
```

### 10.3 phase 枚举完整表（唯一权威）

| phase | 含义 |
| --- | --- |
| `planned` | preflight 通过；STATE 已写；尚未收 chunk |
| `receiving` | 正在拉 chunk 写入 staging |
| `staging-verified` | staging 全量 size/SHA-256 通过 |
| `anchor-intent` | 持久化意图：即将 `target→anchor`（此点后不可无结果 cancel） |
| `anchored` | `target→anchor` rename 已确认（或 original absent 的空操作确认） |
| `publish-intent` | 持久化意图：即将 `staging→target` |
| `published` | `staging→target` 已发生；待从真实 target 复验 |
| `completed-awaiting-ack` | ReceiptObject(completed) 已持久化；待 Controller receipt ACK |
| `rollback-intent` | published 复验失败；准备回滚 |
| `failed-target-quarantined` | 新 target 已 rename 到 quarantine |
| `anchor-restored` | anchor 已 rename 回 target（或 absent 稳态） |
| `old-fingerprint-verified` | 回滚后 fingerprint 与 old 记录一致（或 absent 路径确认） |
| `rolled-back-awaiting-ack` | ReceiptObject(rolled-back) 已持久化；待 receipt ACK |
| `cancelled-local` | pre-anchor 观察到 cancelRequested；准备/正在删未发布 staging |
| `cleanup-intent` | 已获 `cleanupAuthorized`（或 cancel 路径已删 staging）；正在删 task-specific 发布工件或已决定进入完成报告 |
| `cleanup-completed-awaiting-ack` | 发布工件已删；CleanupReceipt tombstone 已写；待 cleanup ACK |
| `cleaned` | 已收 cleanup ACK 并删除私有 tombstone（endpoint 本地终态） |

### 10.4 Plan → Preflight → Execute → Verify（endpoint）

**Plan**

1. claim 获得 task 或 resume 本地 nonterminal STATE。
2. GET task 对齐 file 表（**含 path**）与 digests；缓存 path 仅用于 staging 相对布局。

**Preflight**

1. `restoreRoot` 配置存在且为目录；no symlink root。
2. 规范化 `relativeTarget`；解析 `target`；校验全 ancestor 非 symlink 且落在 restoreRoot 内。
3. 计算 staging/anchor/quarantine 同级路径；名称由 taskId 派生。
4. `stat.dev`：仅 stat **已存在** parent 与 **已存在** target（若有）；二者 dev 必须一致；未来 staging/anchor/quarantine **不 stat**，继承 parent dev。不一致或不存在 parent → `restore-path-invalid` 400。
5. 容量（§12.5）：
   `requiredBytes = remainingStagingBytes + max(64 MiB, ceil(totalBytes * 0.05))`
   首次 `remainingStagingBytes = totalBytes`。**不得**再加 `oldTargetBytes`（old target 已占用 free 空间；rename 成 anchor **不复制** blocks；quarantine/anchor rename **不额外复制**）。`statfs` 不可用 → **507** `restore-capacity-insufficient`。
6. 若 target 存在：计算 old fingerprints，`originalTargetExisted=true`。
   若 target 不存在：`originalTargetExisted=false`；**禁止**创建伪 anchor。
7. 同设备本地已有另一 active restore STATE → `restore-task-conflict`。
8. 进入 `anchor-intent` 前最后一次刷新 `cancelRequested`（§9.4）。

**Execute（接收）**

1. phase=`receiving`。
2. 按 fileIndex 顺序拉取 chunk；使用 `files[].path` 在 staging 下创建相对布局（no-follow）。
3. 每 chunk：Content-Length、size、SHA-256 全匹配；失败 → `restore-integrity-failed`；不 retry。
4. progress 有界上报；观察 `cancelRequested`。

**Verify（staging）**

1. 全文件 size + SHA-256 对权威表。
2. 通过 → `staging-verified`。
3. 失败 → 不进入 anchor-intent；保留 staging（非 cancel 路径不自动删）；标记 lastErrorCode；完整性失败默认需新 task。

**Execute（publish）**

1. 最后一次 cancel 门：若 cancelRequested → §9.4 cancel 路径，**不**写 anchor-intent。
2. 持久化 `anchor-intent`（fsync STATE）。
3. 若 `originalTargetExisted`：`rename(target → anchor)` → `anchored`。否则 assert anchor/target absent → `anchored`。
4. 持久化 `publish-intent`；`rename(staging → target)` → `published`。
5. 从 **真实 target** 重读全量 size/SHA-256 + fingerprints。
6. 成功 → RECEIPT(completed) → `completed-awaiting-ack` → POST receipts。
7. 失败 → §11 回滚算法。

### 10.5 两阶段 cleanup（endpoint）

**A. completed / rolled-back**

```text
on receipt ACK (cleanupAuthorized=true):
  write phase=cleanup-intent; fsync
  delete task-specific staging/anchor/quarantine if present (idempotent)
  write CLEANUP-RECEIPT.json (outcome=completed|rolled-back, receiptId=ReceiptObject.receiptId)
  write phase=cleanup-completed-awaiting-ack; fsync
  POST /agent/restore/tasks/:taskId/cleanup until ACK
  on cleanup ACK: delete STATE/RECEIPT/CLEANUP-RECEIPT tombstone; phase=cleaned
```

**B. cancelled（pre-anchor）**

```text
on cancelRequested in planned|receiving|staging-verified:
  write phase=cancelled-local; fsync
  delete unpublished staging if present
  write CLEANUP-RECEIPT.json (outcome=cancelled, receiptId=null)
  write phase=cleanup-completed-awaiting-ack; fsync
  POST cleanup until ACK → Controller status=cancelled
  on cleanup ACK: delete tombstone; phase=cleaned
```

**崩溃：**

| 窗口 | 恢复 |
| --- | --- |
| `cleanup-intent` 删一半 | 继续幂等删剩余 task-specific 工件；重写同一 CleanupReceipt（同 cleanupId） |
| `cleanup-completed-awaiting-ack` | **重放同一 CleanupReceipt**；不得新 cleanupId |
| cleanup ACK 已到但 tombstone 未删 | 幂等删 tombstone → `cleaned` |

---

## 11. 回滚算法与崩溃真值表

### 11.1 双 rename 诚实声明（冻结）

- 使用纯 Node `fs.promises.rename` / `fs.rename`。
- **每次** rename 各自在同一文件系统上原子。
- **两步之间**可能短暂 **target absent**。
- **不宣称** single-syscall directory swap。
- **不宣称** zero-gap。
- **禁止** EXDEV 时复制覆盖降级。

### 11.2 Publish 成功算法

```text
require phase == staging-verified
assert cancelRequested == false (final gate)
write phase=anchor-intent; fsync STATE
if originalTargetExisted:
  rename(target, anchor)
  confirm anchor exists && target absent
  write phase=anchored; fsync
else:
  assert anchor absent && target absent
  write phase=anchored; fsync
write phase=publish-intent; fsync
rename(staging, target)
confirm target exists && staging absent
write phase=published; fsync
re-verify tree at target (size + sha256 + fingerprints)
if ok:
  write RECEIPT completed (fingerprints non-null); phase=completed-awaiting-ack; fsync
  POST receipt until ACK (cleanupAuthorized)
  enter two-phase cleanup §10.5.A
else:
  enter rollback algorithm
```

### 11.3 Published 验证失败回滚

```text
write phase=rollback-intent; fsync
rename(target, quarantine)
write phase=failed-target-quarantined; fsync
if originalTargetExisted:
  rename(anchor, target)
  write phase=anchor-restored; fsync
  recompute fingerprints on target
  must equal oldStructureFingerprint && oldContentSha256
  else → restore-rollback-failed (fail-closed)
  write phase=old-fingerprint-verified; fsync
  write RECEIPT rolled-back with both fingerprints 64hex, anchorPresentBeforePublish=true
else:
  assert target absent
  write phase=old-fingerprint-verified; fsync
  write RECEIPT rolled-back with contentSha256=null, structureFingerprint=null,
       anchorPresentBeforePublish=false
phase=rolled-back-awaiting-ack; fsync
POST receipt until ACK
enter two-phase cleanup §10.5.A  # quarantine retained until cleanup-intent deletes it
```

### 11.4 original target absent

| 步骤 | 行为 |
| --- | --- |
| preflight | 无伪 anchor；`originalTargetExisted=false` |
| publish 失败 | 新 target → quarantine；**不**创建 anchor；结束后 target **仍 absent** |
| ReceiptObject | `outcome=rolled-back`；`anchorPresentBeforePublish=false`；**两个 fingerprint 必须 null** |

### 11.5 Crash 真值表 — `anchor-intent`

崩溃时 STATE.phase=`anchor-intent`。观察 `(targetExists, anchorExists)`（no-follow lstat；类型必须为 directory，否则 conflict）。

**取消门冻结：** 最终 cancel 检查只发生在**持久化** `anchor-intent` **之前**。一旦 `phase=anchor-intent` 已落盘，**无论** `target→anchor` rename 是否已发生，都 **不得** 转为 `cancelled-local`，也 **不得** 执行“无结果取消”。此阶段 `cancelRequested` **仅保留审计意义**，不改变收敛方向；恢复后必须继续 publish，最终 **只能** `completed` 或 `rolled-back`。

| target | anchor | 判定 | 恢复动作 |
| --- | --- | --- | --- |
| yes | no | rename **未**发生 | 重校验 staging/target 不变量；**重试** `target→anchor`；写 `anchored`；继续 publish。**禁止**因 `cancelRequested=true` 取消 |
| no | yes | rename **已**发生 | 写 `anchored`；继续 publish。**禁止** cancel 无结果 |
| yes | yes | **不可能/冲突** | **fail-closed** `restore-state-invalid`；不猜测；不自动删除 |
| no | no | `originalTargetExisted=true` → **冲突**；`false` → 空操作完成 | existed=true：fail-closed；false：写 `anchored`；继续 publish |

symlink 或非 directory → **fail-closed** `restore-state-invalid`。

### 11.6 Crash 真值表 — `publish-intent`

STATE.phase=`publish-intent`。观察 `(targetExists, stagingExists)`：

| target | staging | 判定 | 恢复动作 |
| --- | --- | --- | --- |
| no | yes | publish rename **未**发生 | 重新 `rename(staging→target)` |
| yes | no | publish rename **已**发生 | 写 `published`；**必须完整重验**；通过 → completed；失败 → rollback |
| yes | yes | **冲突** | fail-closed `restore-publish-conflict` |
| no | no | **冲突** | fail-closed `restore-state-invalid` |

target 已出现：**禁止**跳过全量重验。

### 11.7 Crash 真值表 — 其它关键窗

| 窗口 | 规则 |
| --- | --- |
| `receiving` | 以 STATE 计数与 staging 实际文件 re-hash；仅信任完整且 hash 匹配文件 |
| `staging-verified` | 重跑 staging 全量校验；失败则 fail-closed 不 publish |
| `anchored` | 确认存在性符合 `originalTargetExisted`；然后 publish-intent |
| `published` 未完成重验 | 完整重验；分支 completed 或 rollback |
| `rollback-intent` / quarantine / restore | 按目录存在性真值推进；歧义 fail-closed |
| `completed-awaiting-ack` / `rolled-back-awaiting-ack` | **重放一致 ReceiptObject** |
| `cleanup-intent` | 幂等删 task-specific 工件；写/保持 CleanupReceipt |
| `cleanup-completed-awaiting-ack` | **重放同一 CleanupReceipt** |
| STATE corrupt / JSON invalid | `restore-state-invalid`；无自动删除 |
| fingerprint mismatch after rollback | `restore-rollback-failed`；保留现状；不自动删除 |

### 11.8 删除纪律（取代“无删除”笼统句）

| 对象 | 何时可删 |
| --- | --- |
| staging/anchor/quarantine（task-specific） | **仅** `cleanup-intent`（已 `cleanupAuthorized` 或 cancel 的 `cancelled-local` 对**未发布 staging**） |
| endpoint STATE / RECEIPT / CLEANUP-RECEIPT tombstone | **仅**收到 Controller cleanup ACK 之后 |
| 其它 task 工件 | **永不**因本 task 删除 |
| 无授权扫描删除 | **禁止** |

---

## 12. 并发 / 锁 / 背压

### 12.1 共享 global live-transfer semaphore

| 项 | 冻结值 |
| --- | --- |
| 默认 `maxGlobalTransfers` | **4** |
| 合法范围 | **1..16** 含端 |
| `0`、`17`、非整数、非 number | 构造/启动 **fail-closed**；**禁止**静默 clamp |
| 占用者 | **仅** live binary transfer work unit：G0b **putChunk** 请求；G0c **chunk GET** 读盘+发送 |
| 释放 | request **settle / abort / timeout** 必须 release；禁止 finally 遗漏 |
| 满载 | putChunk → `upload-backpressure`；**chunk GET** → `restore-backpressure`；429 + `Retry-After` **1..30** |
| **不**占用 | claim、GET task、progress、receipt、cleanup、管理面路由、纯 JSON |
| active task 离线 | **不得**永久持有进程内 slot |
| 排队 | **禁止**无限内存排队；信号量 fail-fast |

实现 plan 若需把“同请求内有界 verify”并入 work unit，**不得**跨断连/跨 HTTP 持有 slot。

### 12.2 同设备互斥（admission，非跨 HTTP lease）

| 规则 | 说明 |
| --- | --- |
| same-device | 同时最多一个 admission-nonterminal **upload** **或** 一个 admission-nonterminal **restore**（互斥 OR） |
| 实现 | **持久化** nonterminal 记录 + 短 **per-device state mutex** 保护 STATUS/session 写入 |
| **禁止** | 用跨多个 HTTP 请求的 Promise lease 充当互斥 |
| 冲突码 | 上传侧已有 active restore → `upload-session-conflict`；恢复 claim 时已有 active upload → `restore-task-conflict` |
| different-device | 可并行；live chunk 受全局信号量限制 |

### 12.3 锁键

| 锁 | 键 | 范围 |
| --- | --- | --- |
| global live-transfer semaphore | 进程内 | **仅** putChunk 与 restore chunk GET work unit |
| per-device state mutex | authenticated `deviceId` | 短临界区：admission 检查与 STATUS/session 原子更新 |
| per-task mutex | `deviceId + taskId` | progress/receipt/cleanup/status 更新串行 |
| per-snapshot read lock | — | **本阶段不需要**：committed snapshot 内容对 G0c **immutable**；并发 chunk 只读同一 immutable 树。**禁止**再写“可选 per-snapshot read lock”。 |

**不宣称** cross-process distributed lock（G4 前）。

### 12.4 IP limiter

| 路径类 | 上限 | 码 |
| --- | ---: | --- |
| G0a `/agent/enroll`、`/agent/heartbeat`、`/agent/token/*` | **60/min/IP** | `device-rate-limited`（不变） |
| G0b `/agent/upload/*` | **1200/min/IP** | `device-rate-limited`（不变） |
| G0c `/agent/restore/*` | **1200/min/IP** 独立桶 | `device-rate-limited` |

三套计数器隔离。

### 12.5 Endpoint capacity 公式（冻结）

```text
requiredBytes =
  remainingStagingBytes
  + max(64 * 1024 * 1024, ceil(totalBytes * 0.05))

// 首次 preflight：remainingStagingBytes = totalBytes
// 恢复接收中：remainingStagingBytes = totalBytes - bytesAlreadyDurableInStaging
// 不得加 oldTargetBytes
// anchor/quarantine rename 不额外增加复制预算
```

`statfs` 失败或不可信 → `restore-capacity-insufficient` 507。

---

## 13. Client / Transport

### 13.1 Pinned streaming download client

1. 新客户端能力：certificate pin **成功前**不得接受或落盘 **任何** secret-bearing body。
2. `rejectUnauthorized: false` **仅**可与强制 pin 配对。
3. 请求发送 mandatory 三元组 headers exact-one。
4. GET task 必须解析 `files[].path` 并用于 staging 布局；不得向 URL/header 回填 path。

### 13.2 Chunk 完整性

| 项 | 规则 |
| --- | --- |
| 尺寸 | 固定 8 MiB 语义（§8.6） |
| 匹配 | headers identity、`Content-Length`、实际 size、SHA-256 **全部**一致 |
| under-read / over-read / early EOF | **fail-close** `restore-integrity-failed` |
| 空文件 | 不发 GET chunk |

### 13.3 Retry budget

| 项 | 值 |
| --- | --- |
| network retry budget | **8** |
| 可 retry | 瞬时 disconnect、timeout、HTTP 429（`device-rate-limited` 或 `restore-backpressure`） |
| 不可 retry | integrity / path / capacity / state conflict / task-invalid / publish-conflict / rollback-required / rollback-failed |
| 耗尽 | 本地 **`restore-resume-exhausted`**（HTTP N/A；non-retry） |

`restore-interrupted`：客户端将瞬时 disconnect/timeout 归类为此传输信号，计入 budget。

### 13.4 Timeouts（client）

| 调用 | total | idle |
| --- | ---: | ---: |
| claim / task / progress / receipt / cleanup | **15_000 ms** | n/a |
| chunk download | **120_000 ms** | nonempty data **重置 15_000 ms** |

Single-settle；late events 无二次状态写。

---

## 14. 固定错误模型

当前 `ERROR_CODES` count = **74**。G0c 新增 **14** 个 → 目标 **88**。所有 count pin 测试必须同 PR 协调。

| 常量键（实现期建议） | code | HTTP | retryable | 含义 |
| --- | --- | ---: | --- | --- |
| `RESTORE_TASK_INVALID` | `restore-task-invalid` | **400** | false | body/schema/unknown keys/非法 index/files cap/参数/fingerprint nullability 违规 |
| `RESTORE_TASK_NOT_FOUND` | `restore-task-not-found` | **404** | false | task 不存在或跨 device 统一 not-found |
| `RESTORE_TASK_CONFLICT` | `restore-task-conflict` | **409** | false | admission 冲突、identity 冲突、非法状态迁移、cleanup/receipt 冲突、同设备 upload/restore 互斥 |
| `RESTORE_STATE_INVALID` | `restore-state-invalid` | **500** | false | STATE/TASK 损坏、类型/symlink swap、崩溃歧义组合 |
| `RESTORE_PATH_INVALID` | `restore-path-invalid` | **400** | false | relativeTarget 非法、restoreRoot 逃逸、symlink ancestor、已存在路径 dev 不一致 |
| `RESTORE_INTEGRITY_FAILED` | `restore-integrity-failed` | **422** | false | chunk/树 size 或 SHA-256 失败、early EOF、manifest 不可读 |
| `RESTORE_CAPACITY_INSUFFICIENT` | `restore-capacity-insufficient` | **507** | false | 磁盘不足或 `statfs` 不可用/不可信 |
| `RESTORE_BACKPRESSURE` | `restore-backpressure` | **429** | true | **chunk GET** 时 global live-transfer 满载；`Retry-After` **1..30**（**不是** claim） |
| `RESTORE_INTERRUPTED` | `restore-interrupted` | **null（N/A）** | true* | 瞬时传输信号（client-local 分类） |
| `RESTORE_PUBLISH_CONFLICT` | `restore-publish-conflict` | **409** | false | publish/anchor 目录存在性冲突 |
| `RESTORE_ROLLBACK_REQUIRED` | `restore-rollback-required` | **409** | false | published 后验证失败，必须回滚 |
| `RESTORE_ROLLBACK_FAILED` | `restore-rollback-failed` | **500** | false | 回滚后 fingerprint 不一致或回滚 rename 失败 |
| `RESTORE_CLEANUP_FAILED` | `restore-cleanup-failed` | **500** | false | CleanupReceipt 接受路径持久化失败 |
| `RESTORE_RESUME_EXHAUSTED` | `restore-resume-exhausted` | **null（N/A）** | false | **client-local only** |

\* `restore-interrupted`：仅瞬时 disconnect/timeout 分类可 retry；耗尽 → `restore-resume-exhausted`。

**映射纪律：**

1. 异常 **只**映射注册 code。
2. **禁止** raw error / message / stack / errno / endpoint 绝对 path 泄露；错误体也**禁止**回显 snapshot-relative path。
3. HTTP 507 为受控数值状态 + JSON `{error}`。
4. `Retry-After` 仅允许：`restore-backpressure`、`device-rate-limited`、`upload-backpressure`。
5. `RESTORE_ERROR_HTTP_CONTRACT` 与 `LinkeError` 对齐；null statusCode 强化同 G0b resume-exhausted。

**既有码复用：**

| 场景 | 码 |
| --- | --- |
| 认证失败 | `device-token-invalid` / `device-revoked` / … |
| 协议 | `device-protocol-unsupported` |
| pre-auth IP | `device-rate-limited` |
| 小 JSON body 超时/越界 | `device-request-invalid` |

---

## 15. 安全与脱敏

| 威胁 | 缓解 |
| --- | --- |
| 跨设备猜 taskId | auth-before-lookup；统一 `restore-task-not-found` |
| endpoint 绝对路径泄漏 | wire/log/response 禁止 absolute target；仅 `relativeTarget` + snapshot-relative `files[].path` |
| path 进 URL/header | 禁止；chunk 仅 fileIndex/chunkIndex |
| 无 path 无法重建树 | GET task **必须**含 `files[].path`（§7.7/§8.5） |
| 重复 headers 走私 | rawHeaders exact-one |
| symlink 逃逸 / type swap | no-follow；ancestor 检查；fail-closed |
| 半发布当成功 | staging 全量校验 + 真实 target 再校验 + receipt |
| 取消于不可取消窗 | anchor-intent 后强制 completed 或 rolled-back |
| 崩溃双目录歧义 | 真值表 fail-closed；不猜测删除 |
| 过早 cleaned | receipt ACK 只设 cleanupAuthorized；CleanupReceipt 后才 cleaned/cancelled final |
| 全局池被离线 task 占死 | semaphore 仅 live transfer unit |
| 日志敏感 | allowlist；secret scan；错误体无 path |
| pin 前落盘 | download client pin-first |

---

## 16. 验收矩阵

### 16.1 Schema / 解析

- exact-key / canonical digest / hostile getters / prototype pollution / unknown keys
- `relativeTarget` 与 `files[].path` 规范化：绝对路径、`..`、空段、`\`、控制字符
- ReceiptObject fingerprint nullability 表（completed 双 hex；rolled-back+absent 双 null；rolled-back+existed 双 hex）
- CleanupReceipt exact keys；cancelled 时 receiptId null
- UUID / sha256 / ISO / safe integer 边界
- task GET 响应含 path 的 1 MiB cap（create 预拒）

### 16.2 Task store

- TASK 不可变；STATUS 合法迁移
- `completed`/`rolled-back` 保留 receipt；`cleaned` 不抹 outcome
- create 幂等与 conflict
- admission one-active per device
- cancel：pending→200 cancelled；active→202 cancel-requested
- 0600/0700；no-follow；symlink/type swap → state-invalid

### 16.3 Auth / wire

- auth-before-lookup
- 跨 device 统一 not-found
- 重复 headers
- path **不**在 URL/header；path **在** GET task JSON
- 非法 chunk 坐标；under/over/early EOF
- timeout single-settle；chunk timeout 释放 semaphore

### 16.4 容量与路径

- capacity 公式 **无** oldTargetBytes
- 仅 stat 已存在 parent/target 的 dev
- symlink ancestor；mount swap fail-closed
- 全量 SHA-256；staging 用 path 重建树

### 16.5 Crash injection

- 每个 intent / rename / verify / receipt ACK / cleanup-intent / cleanup ACK
- anchor-intent / publish-intent 四象限
- **canary（冻结）：** `phase=anchor-intent` 且 `target=yes` 且 `anchor=no` 且 `cancelRequested=true` → **不得** 进入 `cancelled-local` / 无结果取消；必须重校验后重试 `target→anchor` 并继续 publish，收敛到 **completed 或 rolled-back**
- CleanupReceipt 重放
- corrupt STATE；fingerprint mismatch

### 16.6 Rollback / cancel / cleanup

- quarantine + anchor 恢复 + old fingerprint
- original absent：receipt 双 null fingerprints
- pre-anchor cancel → CleanupReceipt cancelled → Controller cancelled
- post-`anchor-intent`（含 rename 未发生的 target=yes/anchor=no）`cancelRequested` **不得** 取消；必须 completed/rolled-back；Controller 仍接受匹配 ReceiptObject
- 两阶段 cleanup：receipt ACK ≠ cleaned

### 16.7 并发

- same-device upload vs restore admission 冲突
- different-device 并行
- claim **不满载失败**；仅 chunk GET 测 restore-backpressure
- 全局限制 1 / 4 / 16；非法 0 / 17 构造失败
- settle/abort/timeout 释放 slot；离线 active task 不占槽
- restore 1200/min 与 G0a 60、upload 1200 隔离

### 16.8 进程与硬件

- independent child-process two endpoints auto harness
- real second Mac or isolated VM gate；无硬件无报告无 fake PASS
- G0a / G0b 回归 + 全量 `npm test`

---

## 17. 真实硬件门与报告

| 项 | 规则 |
| --- | --- |
| 环境 | 真实第二 Mac **或** 隔离 VM；真实 pinned TLS + Keychain device token |
| 覆盖 | 双端点并发、断连恢复、损坏拒绝、跨设备 deny、rollback、cancel 握手、两阶段 cleanup 至少覆盖主路径 |
| 报告路径（**仅** overall PASS 后创建） | `docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md` |
| 硬件不可用 | report **absent**；**不**改 Gold；**不**写 fake PASS |
| 自动 harness complete | **≠** real dual-endpoint LAN complete |

---

## 18. Version / Gold / 诚实边界

| 项 | G0c 自动实现后 | 真实 LAN PASS 后 |
| --- | --- | --- |
| `LINKE_RELEASE_VERSION` | 仅允许 **`V1.42`** | 不因此变 Gold/V2 |
| Release signature | 精确：`V1.42 G0c endpoint-pull restore with crash-recoverable rollback anchor implementation` | 可注明 real-LAN 报告存在与否；**仍非 Gold** |
| Gold 9-item statuses | **保持** **4 ready / 4 partial / 1 blocked / total 9** | **仍默认不变**（docs 阶段 **禁止**改 9 item statuses） |
| overall Gold | **blocked** | **blocked** |
| 宣称 G0c real-LAN complete | **禁止**（无报告） | 仅当脱敏报告 overallStatus=PASS |
| M1 / M2 | BLOCKED / denied **未触碰** | 不变 |
| G0a report | 只读 | 只读 |
| G0b real-LAN report | **仍 absent** | 不因 G0c 伪造 |

**禁止话术：** Gold ready、GA、cross-LAN complete、G0c real-LAN complete（无报告）、用 auto harness 冒充 real dual-endpoint、把完整 signature 写入 `LINKE_RELEASE_VERSION`、docs 阶段修改 9-item 分布。

**范围禁止：** G1 NAS、G2 retention 自动删、G3 scheduler、G4 lifecycle 扩展、G5 角色/审计扩展、G6 upgrade、G7 Gold claim。

---

## 19. 超时 / 速率 / 容量汇总

| 类别 | 值 |
| --- | --- |
| Agent `headersTimeout` | 10_000 ms（保持） |
| Agent `requestTimeout` | 0 + per-route deadlines（保持） |
| restore JSON routes total | 15_000 ms |
| restore chunk total | 120_000 ms |
| restore chunk idle（client） | 15_000 ms reset on nonempty data |
| G0a IP | 60/min |
| upload IP | 1200/min |
| restore IP | 1200/min（独立） |
| global live-transfer | default 4；1..16；非法 fail-closed；**仅** putChunk + chunk GET |
| claim vs semaphore | claim **不**检查/占用 |
| Retry-After | 1..30 s |
| client network retries | 8 |
| chunk size | 8 MiB |
| task GET JSON cap | **1 MiB**（含 `files[].path`） |
| progress/receipt/cleanup JSON | 64 KiB |

**endpoint capacity：**

```text
requiredBytes =
  remainingStagingBytes
  + max(64 MiB, ceil(totalBytes * 0.05))
// 首次 remainingStagingBytes = totalBytes
// 不加 oldTargetBytes
```

`statfs` 失败 → `restore-capacity-insufficient` 507。

---

## 20. 后续 plan 阶段建议（非本文件 plan；仅阶段切分）

> 本 C0 **不**创建 plan 文件。下列为后续实现 plan 的建议切片；每阶段仍须 RED→GREEN 与独立 review。

| 阶段 | 内容 | Public routes? |
| --- | --- | --- |
| **C0** | 本 design（docs-only） | 否 |
| **C1** | `restore-*` error codes + HTTP contract + schema validators（task/status/ReceiptObject/CleanupReceipt/relativeTarget/file path） | 否 |
| **C2** | Controller task store：TASK 不可变、STATUS、幂等 create、admission one-active、cancel 200/202、cleanupAuthorized | 否 |
| **C3** | Endpoint STATE 机（§10.3 全枚举）+ staging I/O（按 path 建树）+ fingerprint 纯函数 | 否 |
| **C4** | dual-rename publish + rollback + crash truth tables；fingerprint nullability | 否 |
| **C5** | 共享 **live-transfer** semaphore（putChunk + chunk GET）+ per-device admission mutex + restore service（无 HTTP）；**claim 不占槽** | 否 |
| **C6** | Agent restore routes + restore IP limiter + deadlines + controller-runtime wiring；loopback restore-tasks；两阶段 cleanup 路由语义 | 是 |
| **C7** | pinned download client + path 重建 + retry budget + cancel 握手 + hostile/concurrency 集成 | 是 |
| **C8** | child-process dual-endpoint harness；real-LAN 有条件报告；version=`V1.42` + signature 分离；Gold 不抬 | 是 |
| **C9** | full `npm test` + 多模型 review / PM | — |

**Dependency：** C1→C2→C3→C4→C5→C6→C7→C8→C9

**每 commit fail-closed：** C5 前无 public restore 入口；C6 起入口完整受 limiter/auth/admission/live-semaphore 保护。

建议 C0 commit message（**本 worker 不执行**）：

```text
docs: design V1.42 G0c endpoint-pull restore concurrency
```

---

## 21. 文件地图（实现期；C0 不创建）

| 路径 | 职责 | 阶段 |
| --- | --- | --- |
| `src/error-codes.js` | +14 restore codes；count 88；`RESTORE_ERROR_HTTP_CONTRACT` | C1 |
| `src/restore-path.js`（名可微调） | relativeTarget + file path 严格规范化 | C1 |
| `src/restore-task-store.js` | Controller TASK/STATUS/receipt/cleanupAuthorized/CleanupReceipt | C2 |
| `src/restore-endpoint-state.js` | endpoint STATE/RECEIPT/CLEANUP-RECEIPT tombstone | C3 |
| `src/restore-publish.js` | staging verify、dual rename、rollback、fingerprint | C4 |
| `src/upload-locks.js` 或 `src/transfer-locks.js` | live-transfer 信号量 + per-device admission | C5 |
| `src/restore-service.js` | claim/chunk/progress/receipt/cleanup 编排 | C5 |
| `src/agent-listener.js` | restore routes + limiter + chunk acquire/release | C6 |
| `src/server.js` | loopback restore-tasks + cancel 200/202 | C6 |
| `src/controller-runtime.js` | 装配注入 | C6 |
| `src/device-client.js` | pinned streaming download + restore client | C7 |
| `src/version.js` | `V1.42` only | C8 |
| `test/restore-*.test.js` | 见 §16 | C1–C7 |
| `docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md` | 仅真实 PASS | C8 |

---

## 22. 实现期允许微调的非语义细节

下列项**不得**改变 wire / 安全 / 状态机语义：

1. 模块文件名在 `restore-*.js` 与是否拆分 publish/store 之间调整。
2. progress 是否合并进 STATE 或独立 `progress.json`。
3. chunk 服务端读使用流式或预读缓冲（仍须 Content-Length 与 sha256 头一致）。
4. claim FIFO 并列 `createdAt` 时用 `taskId` 字典序打破平局。

下列项**已冻结、不得再开：**

- GET task `files[]` 必须含 snapshot-root-relative `path`
- path 禁止 URL/header；endpoint absolute path 禁止 wire/log
- ReceiptObject fingerprint nullability 唯一表
- 两阶段 cleanup：receipt ACK = cleanupAuthorized；CleanupReceipt 后才 cleaned/cancelled-final
- cancel：pending 200；active 202 + cancelRequested；pre-anchor CleanupReceipt(cancelled)；post-anchor 必须 completed/rolled-back
- capacity 不加 oldTargetBytes
- global semaphore 仅 live binary unit；claim 不占槽
- 无 per-snapshot read lock（immutable committed snapshot）
- 双 rename 与非 zero-gap 声明
- version/signature/Gold 诚实边界

---

## 23. 文档修订记录

| 日期 | 作者角色 | 变更 |
| --- | --- | --- |
| 2026-07-23 | Grok V1.42 G0c design implementer | 初版 APPROVED DESIGN / PLAN ONLY / DOCS-ONLY C0 |
| 2026-07-23 | Grok V1.42 G0c design implementer（自审返修） | 修复：GET task `files[].path`；ReceiptObject fingerprint nullability；两阶段 CleanupReceipt；active cancel 202 握手；capacity 去 oldTargetBytes；live-transfer semaphore 生命周期；phase 交叉引用/锁/STATUS 术语/stat.dev/示例占位全局同步 |
| 2026-07-23 | Grok V1.42 G0c design implementer（一致性窄修） | §11.5：anchor-intent 已持久化后 target=yes/anchor=no 禁止 cancel，必须重试 anchor/publish；§16.5/§16.6 增加对应 crash canary |

**END OF DESIGN — APPROVED / PLAN ONLY / DOCS-ONLY C0 — NOT IMPLEMENTED**
