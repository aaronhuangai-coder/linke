# V1.24 Mounted SMB Snapshot Replication Design

## 目标

V1.24 为 Linke 增加第一条真实 NAS 远程备份通道：把已经完成的本地 snapshot 复制到 macOS 已预先挂载的 SMB 共享，并在远端完成逐文件 SHA-256 校验和显式完成标记。

该版本支持群晖和绿联提供的标准 SMB 共享，但不调用厂商应用 API。Linke 不读取 NAS 用户名、密码或 token，不调用 `mount_smbfs`，也不负责挂载或重新连接共享。

V1.24 的目标不是宣称 Gold 完整版已经发布，而是把 `real-nas-remote-backup` 从只存在 dry-run 的 `blocked` 状态推进到经过真实 SMB 验收的 `partial` 状态。群晖/绿联应用 API、远端恢复、自动调度和完整生产矩阵继续作为后续 Gold 路线。

## 当前基础

- `src/storage.js` 已创建本地 snapshot、`manifest.json` 和 `files/` 目录。
- 当前 manifest 的 `files` 字段只是相对路径数组，没有逐文件大小和内容哈希。
- `src/nas.js` 只校验群晖/绿联目标并生成 dry-run/app adapter 计划，固定 `wouldConnect:false` 和 `wouldWrite:false`。
- 当前 Agent CLI 只有 `nas-dry-run`，没有真实 NAS 写入入口。
- Gold scorecard 中 `real-nas-remote-backup` 是唯一 `blocked` item；其它未完成项为 `partial`。

## 已批准的产品边界

1. 第一条真实传输协议使用群晖和绿联都支持的 SMB。
2. SMB 共享必须由 macOS 预先挂载；凭证与挂载生命周期由 Finder、系统钥匙串或运维流程管理。
3. 复制源只能是 Linke 已完成的本地 snapshot，不能再次读取用户原始目录。
4. 新 snapshot manifest 必须记录每个文件的大小和 SHA-256；旧 manifest 可继续读取，但不能执行真实 SMB 复制。
5. 真实写入只允许从本机 Agent CLI 发起，并同时要求 `--execute` 与 `LINKE_NAS_SMB_EXECUTION=enabled`。
6. Web Console 和服务端 API 在 V1.24 不增加真实远端写入按钮或 endpoint。
7. 最终验收必须使用用户提供的专用预挂载 SMB 测试目录；本地临时目录不能作为真实 SMB 证据。
8. commit、push、真实 NAS 测试写入和测试数据删除仍受用户人类硬闸控制。

## 方案比较与裁决

### 方案 A：隐藏 staging、校验、发布、完成标记

用 Node.js 内置文件 API 把 snapshot 写入 SMB 上的唯一隐藏 staging 目录，逐文件校验后 rename 到最终目录，再次校验并原子写入 `COMPLETED.json`。

优点：Linke 完全掌握路径、哈希、状态和错误语义；不依赖系统 rsync 版本；不把未完成数据当成可用 snapshot。

风险：SMB rename 的具体实现可能随 NAS 固件变化，因此不能只依赖 rename 声明原子发布。

裁决：采用，但把 `COMPLETED.json` 作为唯一可用性信号。rename 后仍要全量复验；没有有效完成标记的 final 目录不算可用。

### 方案 B：直接写最终目录，最后创建标记

优点：实现最简单。

缺点：断连或空间不足时会把部分数据留在正式目录；恢复和并发更难区分。

裁决：拒绝。

### 方案 C：调用 macOS rsync

优点：传输工具成熟。

缺点：引入外部进程、系统版本差异、参数与退出码解析，并把 manifest 语义分散到 Linke 之外。

裁决：V1.24 不采用。

## 模块边界

### `src/storage.js`

继续负责本地 snapshot。创建 snapshot 时在现有 `files: string[]` 之外写入兼容的 v2 完整性数据。已有读取、列表和恢复调用仍可使用 `files`，不需要理解新字段。

### `src/smb-snapshot-replication.js`

新增专一模块，负责：

- 构建只读复制计划。
- 校验本地 manifest v2、源文件、SMB 挂载和剩余空间。
- 获取和维护远端 snapshot 排他锁。
- 把文件复制到隐藏 staging，并在复制前后校验 SHA-256。
- 发布到最终目录并写入完成标记。
- 验证已有 final snapshot 的幂等性。
- 报告和恢复本次 snapshot 的 stale lock/staging。

该模块不读取配置文件、不解析 CLI、不访问凭证，也不触发 Web/API 行为。系统和测试差异通过显式依赖注入提供：时钟、UUID、mount inspector、空间 inspector 和文件复制器。

### `src/nas.js`

保留现有 dry-run 语义，扩展 target 配置校验和 mounted SMB 只读计划展示。`buildNasDryRunPlan()` 仍固定不连接、不写入。

### `src/agent.js`

新增 `nas-snapshot-replicate` CLI 命令，负责读取 config、选择 target、解析参数、组合本地 snapshot 路径，并调用复制模块。CLI 输出必须是 sanitized JSON。

## NAS 配置

NAS target 增加可选 mounted SMB 配置：

```json
{
  "name": "primary-nas",
  "provider": "synology",
  "endpoint": "https://nas.example.invalid",
  "shareName": "backup",
  "remotePath": "/provider-owned/path",
  "enabled": true,
  "mountedShare": {
    "enabled": true,
    "mountPath": "/Volumes/LinkeBackup",
    "relativeRoot": "linke"
  }
}
```

约束：

- `mountPath` 必须是绝对路径、存在且本身不是符号链接。
- 真实 adapter 必须使用固定可执行文件和固定参数检查文件系统类型，结果必须精确为 `smbfs`。
- `relativeRoot` 必须是非空安全相对路径，不得包含空段、`.`、`..`、控制字符或绝对路径语义。
- `mountedShare` 不允许包含任何凭证字段。
- `credentialRef` 即使存在，也不得由 mounted SMB 复制路径解析或读取。
- 既有 `remotePath` 仅供 provider app/dry-run 元数据使用，mounted SMB 复制必须忽略它；真实目标只由 `mountedShare.mountPath` 与 `mountedShare.relativeRoot` 组合确定。
- mounted SMB 配置不得改变现有 endpoint、provider app adapter 或 dry-run 行为。

## Agent CLI 契约

```text
node src/agent.js nas-snapshot-replicate \
  --config <config-path> \
  --data-dir <data-dir> \
  --target <target-name> \
  --device-id <device-id> \
  --snapshot-id <snapshot-id> \
  [--execute] \
  [--recover]
```

规则：

- 无 `--execute`：只构建 plan，不创建目录、lock、staging、manifest 或完成标记。
- 有 `--execute`：仍要求 `LINKE_NAS_SMB_EXECUTION=enabled`、target enabled、mountedShare enabled 和全部 preflight 通过。
- `--recover` 必须与 `--execute` 同时使用，只处理同一 target/device/snapshot 的 stale attempt。
- CLI 不接受用户名、密码、token、credential value、SMB URL 或 shell command 参数。
- CLI 不输出 config path、dataDir、mountPath、sourcePath、endpoint、credentialRef 或原始错误消息。

主要结果状态：

- `planned`：只读计划已生成。
- `replicated`：首次复制、发布和复验成功。
- `already_verified`：远端已有相同且完整的 snapshot。
- `blocked`：执行门或 preflight 未通过，退出码 2。
- `recovery_required`：检测到 stale lock/staging 或无完成标记的 final，退出码 3。
- `failed`：复制、发布或完整性验证失败，退出码 1。
- `recovered`：显式恢复成功并回到可重试或 completed 状态。

## Manifest v2

本地 manifest 保留已有字段，并增加：

```json
{
  "schemaVersion": 2,
  "files": ["relative/file.txt"],
  "integrity": {
    "algorithm": "sha256",
    "totalBytes": 1234,
    "entries": [
      {
        "path": "relative/file.txt",
        "size": 1234,
        "sha256": "lowercase-64-hex"
      }
    ]
  }
}
```

不变量：

- `files` 与 `integrity.entries[].path` 必须是按字节序稳定排序的一一对应集合。
- path 必须是规范化安全相对路径；重复路径、绝对路径、路径穿越、空路径和 NUL 均非法。
- size 必须是非负安全整数。
- SHA-256 必须是 64 位小写十六进制。
- snapshot 创建完成后，对 snapshot `files/` 中的普通文件计算 hash；发现符号链接或非普通文件时 snapshot 创建失败。
- v1/无 schemaVersion manifest 继续支持既有只读和本地恢复路径，但真实 SMB plan 必须返回 `snapshot-integrity-v2-required`。
- V1.24 不提供 v1 manifest 原地升级，避免在无法证明旧 snapshot 未被篡改时补写完整性证据。用户必须用原始来源重新创建 v2 snapshot；dry-run/execute 使用同一 blocker，README 必须给出迁移步骤和额外空间提示。

## 远端最小 manifest 和 digest

远端不复制本地 manifest 原文。复制模块从本地 manifest 派生 allowlist 远端 manifest，只包含：

- `schemaVersion`
- `snapshotId`
- `deviceId`
- `createdAt`
- `files`
- `integrity.algorithm`
- `integrity.totalBytes`
- `integrity.entries`

它不得包含 `sourcePath`、hostname、IP、mountPath、endpoint 或 credentialRef。

`manifestDigest` 是 Linke 受限 canonical JSON 的 SHA-256。canonical 字节规则固定如下：

- 先构造新对象，不对任意输入对象直接序列化。顶层键顺序固定为 `schemaVersion`、`snapshotId`、`deviceId`、`createdAt`、`files`、`integrity`。
- `integrity` 键顺序固定为 `algorithm`、`totalBytes`、`entries`；每个 entry 键顺序固定为 `path`、`size`、`sha256`。
- 数组保持已验证的字节序排序；字符串保持原 Unicode 标量并由标准 JSON 转义；数字只允许非负安全整数；不得出现 `null`、浮点数或额外字段。
- 使用 Node.js `JSON.stringify` 的紧凑形式生成无空白、无结尾换行的 UTF-8 字节，再计算小写十六进制 SHA-256。

完成标记、lock、staging 元数据和幂等验证都使用这个 digest。测试必须包含至少 3 组固定 manifest 与期望 digest 的 golden vector，防止字段顺序或序列化规则漂移。

## 远端目录协议

```text
<mountPath>/<relativeRoot>/
├── .linke-control/
│   ├── locks/<deviceId>/<snapshotId>.json
│   └── staging/<deviceId>/<snapshotId>/<attemptId>/
└── devices/<deviceId>/snapshots/<snapshotId>/
    ├── files/
    ├── manifest.json
    └── COMPLETED.json
```

所有路径组件都必须经过与 `safeDevicePath` 等价或更严格的 slug/relative boundary 校验。边界判断使用 `realpath` 和 `relative`，不得仅使用字符串 `startsWith`。

## 复制与发布状态机

```text
planned
  -> preflighted
  -> locked
  -> copying
  -> staging_verified
  -> published
  -> final_verified
  -> completed
```

执行顺序：

1. 校验 CLI 双重执行门、config、target 和本地 snapshot 标识。
2. 读取 manifest v2，确认条目集合、大小、hash 格式和 canonical digest。
3. 对每个本地 snapshot 文件执行 `lstat`，拒绝符号链接和非普通文件，并重新计算 SHA-256，防止本地 snapshot 已被篡改。
4. 检查 mountPath 是真实 `smbfs`、可写且剩余空间满足 `totalBytes + safetyMargin`。`safetyMargin` 取 64 MiB 与 `totalBytes * 5%` 的较大值，用于覆盖小快照的固定目录/元数据成本和大快照的比例性块分配波动；它是保守 preflight 下限，不替代 NAS quota 或实际写入错误处理。
5. 在 SMB 上以 exclusive-create 创建 snapshot lock；lock 已存在时不得抢写。
6. 在 lock 保护下检查 final 与 `COMPLETED.json`；若已存在则立即执行完整幂等验证，一致时释放 lock 并返回 `already_verified`，不创建 staging、不复制文件。
7. 创建唯一 attempt staging，并写入不含路径的 attempt metadata。
8. 逐文件流式复制到 staging；每个文件有 120 秒无进度超时。每复制 50 个文件或 100 MiB（先到者）以及发布前，重新确认 mountPath 仍是同一 `smbfs` 边界。仅在未发布阶段对可重试 I/O 错误重试一次；ENOSPC、EACCES、路径和完整性错误不重试。
9. 对 staging 全量复验并写入远端最小 manifest。
10. final 不存在时，把 staging rename 到 final；final 已存在时禁止 rename 覆盖，改走幂等验证。rename 只是传输状态转换，不假设 NAS 在掉电或断连下提供原子发布语义。
11. 对 final 全量复验。rename 不是完成证据。
12. 通过临时文件加 rename 原子写入 `COMPLETED.json`。
13. 释放本次 owner token 对应的 lock，并确认 staging 不再存在。

`COMPLETED.json` 是唯一 published/usable 信号，字段仅包含：schemaVersion、state、snapshotId、deviceId、manifestDigest、algorithm、fileCount、totalBytes、completedAt 和 Linke version。

## 幂等与不覆盖规则

- final 和有效完成标记已存在：每次仍重新验证远端 manifest digest、文件集合、大小和 SHA-256；全部一致才返回 `already_verified`。
- final 存在但没有完成标记：返回 `recovery_required`。显式恢复会全量校验，完全一致时补写完成标记。
- final 存在且任一内容不一致：返回 `remote-snapshot-conflict`，不得覆盖、合并、删除或补写标记。
- 完成标记存在但内容或文件不一致：返回 `remote-snapshot-integrity-failed`，不得把标记当作真实证据。
- rename 报错或状态不确定时不得删除 staging 或 final；重新检查两者状态后返回 `recovery_required`。后续恢复只在 final 与 manifest 全量一致时补标记，否则返回 `remote-snapshot-conflict`。
- 同一 snapshot 的两个进程由 remote lock 串行化；不同 device/snapshot 可以并发。

收到 `remote-snapshot-conflict` 后，Linke 只保留现场并输出 sanitized error code。README 必须要求运维先保存远端 manifest/完成标记和本地 snapshot 的独立取证结果，再由用户在 Linke 外部明确决定隔离或删除冲突 final；V1.24 不提供自动修复、覆盖、合并或删除命令。人工处置后必须重新从 plan 开始并通过全部 preflight。

## Lock、heartbeat 和恢复

lock 内容只包含 schemaVersion、attemptId、ownerToken、deviceId、snapshotId、manifestDigest、createdAt 和 heartbeatAt。ownerToken 是随机并发所有权值，不是凭证，不输出到 CLI 或审计日志。

- active attempt 每 30 秒原子更新 heartbeat，但更新前必须确认 ownerToken 仍匹配。
- 120 秒无复制进度时主动中止本次 pipeline，进入失败清理。
- 正常成功或可处理失败在 `finally` 中只清理 ownerToken 匹配的 lock 和当前 attempt staging。
- 进程崩溃、机器掉电或 SMB 断连可能留下 lock/staging。默认执行只报告 `recovery_required`，不自动删除。
- lock heartbeat 超过 30 分钟未更新才有资格执行显式恢复；该阈值不等于自动删除授权。
- `--recover --execute` 必须重新验证 smbfs、target/device/snapshot、manifestDigest、stale heartbeat 和 attempt metadata。
- 恢复进程从 lock 读取 ownerToken，但只以 attemptId、deviceId、snapshotId、manifestDigest 与 staging metadata 的完整匹配判定目标 attempt；ownerToken 仅用于恢复操作期间的 compare-and-delete，不能单独授权或扩大恢复范围。
- 恢复只能删除匹配 attempt 的 staging 和 lock，或者在 final 完全通过哈希验证时补写完成标记；不得删除 final。
- 恢复结束后必须重新执行 preflight，确认系统回到可重试或 completed 正常态。

## Sanitized 输出和审计

CLI JSON 和本地审计事件只允许返回：command、mode、state、provider、targetName、deviceId、snapshotId、attemptId、fileCount、totalBytes、verifiedFileCount、blocker/error code、retryCount 和布尔安全字段。

禁止返回：config path、dataDir、mountPath、relativeRoot 的展开绝对路径、sourcePath、endpoint、shareName、remotePath、credentialRef、ownerToken、原始系统错误、shell 命令、用户名、密码或 token。

本地 audit log 增加 allowlist 事件：

- `nas.snapshot.replication.planned`
- `nas.snapshot.replication.started`
- `nas.snapshot.replication.completed`
- `nas.snapshot.replication.already_verified`
- `nas.snapshot.replication.failed`
- `nas.snapshot.replication.recovery_required`
- `nas.snapshot.replication.recovered`

## 运行韧性设计门

### 正常态定义

CLI 返回 `replicated` 或 `already_verified`、退出码 0；final 全量 hash 通过；`COMPLETED.json` 与 manifestDigest 一致；当前 lock/staging 不存在；本地 snapshot 未被修改。

### 恢复锚点

数据恢复锚点是不可变的本地 snapshot v2。远端失败不得修改本地 snapshot；远端 final 只有在完整验证后才能成为新的完成锚点。代码恢复锚点是 V1.23 last-green commit `14b1015`。

### 有界失效

| Failure mode | 预期行为 | 兜底 | 可观测信号 | 验证 |
|---|---|---|---|---|
| 非 SMB/未挂载 | 写前阻断 | 不创建远端状态 | `smb-mount-required` | mount inspector 测试 + 真实 SMB 验收 |
| 空间不足 | 写前阻断 | 保留本地 snapshot | `smb-space-insufficient` | statfs fixture |
| manifest/source 被篡改 | 写前阻断 | 不信任本地 snapshot | `snapshot-integrity-failed` | hash/symlink/path 测试 |
| 同 snapshot 并发 | 后到者阻断 | remote exclusive lock | `replication-lock-held` | 多进程/并发 fixture |
| SMB 复制断连 | 不发布 | 周期性复检 mount；一次有界重试；可达时清理 owned staging，不可达时保留待恢复 | `replication-copy-failed` | fault-injected integration |
| rename 中/后进程崩溃 | final 不可用 | 不假设 rename 原子；无标记；显式恢复全量验证，不一致即 conflict | `recovery_required` | crash-point fixture |
| final 已有不一致数据 | fail-closed | 永不覆盖或删除 | `remote-snapshot-conflict` | corruption test |
| stale lock/staging | 默认阻断 | 显式恢复且只处理匹配 attempt | `recovery_required` | lease/recovery fixture |

### 异常恢复

复制前只依赖本地 snapshot；复制后只有完整 final 才是远端锚点。handled failure 清理本次 staging，崩溃残留由 stale lease + 显式恢复处理。恢复后重新运行 preflight 和全量 hash，自报 completed 或 fail-closed。

### 状态侦测和运行后自检

- CLI 状态和退出码。
- sanitized audit events。
- lock heartbeat、staging/final/完成标记状态组合。
- 每次 success/already_verified 都重新计算远端 SHA-256，不只信任标记。
- 真实验收同时检查文件系统类型是 smbfs、远端文件、manifest 和完成标记。

## 自动测试

### Manifest 和本地 snapshot

- 新 snapshot 生成稳定排序的完整性 entries、totalBytes 和 SHA-256。
- 相同输入产生相同 remote manifest digest。
- 旧 manifest 仍可被既有读取/恢复路径使用，但真实 SMB plan 被阻断。
- snapshot 中的 symlink、非普通文件、重复/穿越/绝对路径被拒绝。

### Config 和 CLI

- mountedShare 允许合法 mountPath/relativeRoot，拒绝凭证字段和不安全路径。
- 无 `--execute` 全程只读。
- `--execute` 与环境门缺一不可。
- CLI 拒绝未知 target、disabled target、missing snapshot、旧 manifest 和额外执行参数。
- 所有错误和 JSON 输出通过敏感字符串扫描。

### 复制状态机

- staging 复制、双重 hash、publish、完成标记和 lock 清理。
- 已有相同 snapshot 返回 `already_verified`。
- 已有不一致 final 或损坏完成标记 fail-closed 且不改数据。
- lock 竞争阻断；不同 snapshot 可并发。
- ENOSPC、EACCES、断连、无进度超时和 hash mismatch 不创建完成标记。
- handled failure 只清理自己的 attempt。
- stale attempt 默认返回 recovery_required。
- 显式恢复只处理匹配 metadata，能补全 rename 后缺标记状态。
- rename 失败或产生不完整 final 时不覆盖、不合并、不补标记，并返回 conflict/recovery_required。
- 复制中周期性 mount 复检失败时停止发布；共享不可达导致清理失败时保留可识别残留。
- 固定 canonical manifest golden vector 在不同字段输入下保持预期 digest。

### 回归

- 现有本地 backup/restore、manifest、concurrency、NAS dry-run、Agent、Web、Gold 和 README 测试全绿。
- V1.24 不新增 Web 按钮或服务端真实写 endpoint。
- 现有 NAS dry-run 仍固定 `wouldConnect:false` 和 `wouldWrite:false`。

## 真实 SMB 验收

用户在验收时提供一个专用预挂载 SMB 测试目录。任何写入或删除前再次确认目标和操作范围；验收报告只记录 provider、filesystem type、结果、计数和哈希状态，不记录真实路径或凭证。

验收步骤：

1. 在临时本地 dataDir 创建包含多个小文件和至少一个嵌套目录的 snapshot v2。
2. 不带 `--execute` 运行 CLI，确认远端零写入。
3. 带双重执行门运行，确认 `replicated`、完成标记和远端全量 SHA-256。
4. 重复运行，确认 `already_verified` 且没有新 staging/final。
5. 并发启动同一 snapshot 的两个执行，确认只有一个持锁推进，另一个返回 `replication-lock-held`，且最终只有一个有效完成目录。
6. 在专用测试 snapshot 中人工破坏一个远端文件，再运行 CLI，确认 `remote-snapshot-integrity-failed` 或 `remote-snapshot-conflict`，且没有覆盖损坏文件。
7. 在专用范围构造 stale lock/staging，确认默认执行只报 `recovery_required`，显式恢复只清理匹配 attempt；rename 后无标记场景只有全量 hash 一致时才补标记。
8. 经用户确认后只删除本次专用测试数据。
9. 保存 sanitized 验收报告到 `docs/superpowers/reports/`。

本地目录 fixture、mock mount inspector 或单元测试不能替代这些证据。

## Gold 状态边界

只有在自动测试、全量回归和真实 SMB 验收全部通过后，V1.24 才允许：

- 把 `real-nas-remote-backup` 从 `blocked` 改为 `partial`。
- 把 Gold overall 从 `blocked` 改为 `partial`。
- 在 README 声明已存在经过真实 SMB 测试的手动 snapshot replication。

`partial` 只表示手动 snapshot replication 已通过真实 SMB 边界验证；它不包含自动调度、远端恢复、厂商 API 集成或完整生产加固，不能作为生产备份策略的唯一依赖。

仍不得声明：

- Gold ready 或完整版发布。
- 群晖/绿联厂商应用 API 已接入。
- 远端恢复、自动调度、断点续传或清理策略已生产就绪。
- NAS 凭证由 Linke 管理。
- Web/API 可以触发真实 NAS 写入。

## 非目标

- 自动挂载/卸载 SMB。
- 读取钥匙串或任何凭证文件。
- 厂商应用 API 嵌套调用。
- 远端 snapshot 恢复。
- 增量块级传输、去重、压缩或加密。
- 自动删除旧 snapshot 或 orphan staging。
- Web/API 真实执行入口。
- 自动调度和 supervisor 集成。
- 把 production-hardening、security-auth 或 automation-installation 标记为 ready。

## 发布与回滚

- V1.24 的最后 green 锚点必须包含 manifest v2、SMB 复制模块、CLI、测试、README、Gold scorecard 和 sanitized 真实验收报告。
- 任何自动测试或真实 SMB 验收失败都保持 Gold blocked，不得通过修改 scorecard 或跳过测试发布。
- 代码回滚恢复到 `14b1015` 时，不删除任何已复制到 NAS 的数据；远端测试数据只按用户确认的精确范围清理。
- commit、push 和后续发布均需用户明确确认。
