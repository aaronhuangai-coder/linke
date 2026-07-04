# Linke V0.16

轻量级备份与恢复代理，带 Web 管理控制台。

> **当前版本：V0.16** — 单机 localhost 原型阶段，尚未具备生产级安全隔离。

## 版本演进

| 版本 | 里程碑 | 主要内容 |
|------|--------|----------|
| V0.1 | 初始原型 | 设备心跳、快照备份/恢复、Web Console、原子写入、路径安全 |
| V0.2 | Agent CLI | `run-once` 命令：从配置文件批量执行备份，含心跳前置 |
| V0.3 | launchd 集成 | `launchd-dry-run` 命令：生成 launchd plist，不安装、不调用 launchctl |
| V0.4 | NAS dry-run | `nas-dry-run` 命令：验证 NAS 配置并输出计划，不连接 NAS、不写远端 |
| V0.5 | 文档补齐 | 文档与操作手册补齐 |
| V0.6 | Retention dry-run | `retention-dry-run`：快照保留策略 dry-run，只读不删 |
| V0.7 | Web retention panel | Web Console 新增保留计划面板，可视化查看 retention dry-run 结果 |
| V0.8 | Manifest detail | Web Console 新增只读快照清单详情面板，可查看 snapshot manifest 文件列表 |
| V0.9 | 快照差异 dry-run | `diff-dry-run`：按 manifest 文件路径比较两个快照，输出 added / removed / unchanged |
| V0.10 | 恢复预检 dry-run | `restore-dry-run`：预览恢复到目标目录的 would-create / would-overwrite，不复制、不覆盖、不写入 |
| V0.11 | 备份预检 dry-run | `backup-preflight-dry-run`：预览 sourcePath + excludePatterns 的 included / excluded，不创建快照、不复制、不写入 |
| V0.12 | Web backup preflight panel | Web Console 新增备份预检 dry-run 面板，可输入 sourcePath / excludePatterns 并查看 included / excluded |
| V0.13 | Web NAS dry-run panel | Web Console 新增 NAS dry-run 面板，可粘贴 nasTargets 配置并查看 wouldConnect:false / wouldWrite:false 的计划 |
| V0.14 | NAS app adapter dry-run | 为 Synology / Ugreen 目标生成应用嵌套调用计划，不调用 NAS app、不连接、不写入 |
| V0.15 | 设备详情面板 | Web Console 新增只读设备详情面板，展示 deviceId / hostname / ipAddress / status / lastHeartbeatAt / lastBackupAt / snapshotCount |
| V0.16 | 当前版本 | Web Console 设备面板新增搜索、状态过滤、排序和计数工具栏，纯前端只读派生视图 |

## 特性

- **设备心跳** — 注册设备并跟踪在线状态
- **设备列表控制** — Web Console 设备面板支持按名称 / Device ID / IP 搜索、按状态过滤（全部 / 在线 / 离线 / 未知）、按名称 / IP / 最后心跳 / 快照数排序，并实时显示可见 / 总数计数
- **设备详情** — Web Console 可只读查看设备的 deviceId、hostname、IP 地址、状态、最后心跳、最后备份和快照数
- **快照备份** — 将本地文件备份到仓库，支持并发隔离
- **快照恢复** — 从快照精确恢复文件（sha256 校验）
- **Web Console** — 管理界面：设备列表 / 设备详情 / 快照列表 / 快照清单详情 / 恢复预检 / 备份预检 / NAS 预检 / 快照差异预览 / 事件日志 / 保留计划面板
- **原子写入** — 元数据写入使用 tmp + rename，保证一致性
- **路径安全** — deviceId slug 化，防止 path traversal
- **保留计划预览** — Web Console 与 CLI 均可查看 retention dry-run 结果，不执行删除
- **快照清单详情** — Web Console 可只读查看 snapshot manifest 的源路径、创建时间和文件清单
- **快照差异预览** — Web Console 可按 manifest 文件路径比较两个快照的 added / removed / unchanged
- **恢复预检** — API、CLI 与 Web Console 可预览 restore-dry-run 计划，显示 would-create / would-overwrite，不执行复制或覆盖
- **备份预检** — API、CLI 与 Web Console 可预览 backup-preflight-dry-run 计划，显示 included / excluded，不创建快照、不复制文件、不写 metadata
- **NAS dry-run** — API、CLI 与 Web Console 可验证 Synology / Ugreen 目标配置并输出计划，不连接 NAS、不写远端、不保存凭证
- **NAS app adapter dry-run** — 为 Synology / Ugreen 目标生成 `adapterPlan`，显示 `wouldInvokeApp:false`，不调用 NAS app、不连接、不写远端

## 快速开始

```bash
# 启动服务器（默认监听 127.0.0.1:3000，数据目录 ./data）
node src/server.js

# 指定端口和数据目录
PORT=8080 DATA_DIR=/tmp/linke-data node src/server.js

# 局域网测试（受控环境，显式开放监听地址）
HOST=0.0.0.0 PORT=3000 node src/server.js
```

> **默认只监听 127.0.0.1**，不暴露到局域网/公网。如需局域网测试可设置 `HOST=0.0.0.0`，仅限受控测试环境使用。

## Agent CLI

```bash
# 发送心跳
node src/agent.js heartbeat --server http://localhost:3000 --device my-pc --hostname MyPC --ip 192.168.1.10

# 备份文件
node src/agent.js backup --server http://localhost:3000 --device my-pc --source ./important-doc.txt

# 备份预检 dry-run（不创建快照、不复制文件、不写 metadata）
node src/agent.js backup-preflight-dry-run --server http://localhost:3000 --source ./important-docs --exclude "*.tmp" --exclude node_modules

# 查看快照列表
node src/agent.js snapshots --server http://localhost:3000 --device my-pc

# 恢复快照
node src/agent.js restore --server http://localhost:3000 --device my-pc --snapshot <snapshotId> --target ./restored/

# 恢复预检 dry-run（不复制、不覆盖、不写入目标目录）
node src/agent.js restore-dry-run --server http://localhost:3000 --device my-pc --snapshot <snapshotId> --target ./restored/

# 查看设备状态
node src/agent.js status --server http://localhost:3000 --device my-pc

# run-once：从配置文件批量执行备份
node src/agent.js run-once --config linke.config.json

# launchd-dry-run：生成 launchd plist（不安装、不调用 launchctl）
node src/agent.js launchd-dry-run --config linke.config.json
node src/agent.js launchd-dry-run --config linke.config.json --output ./scratch/my-agent.plist

# nas-dry-run：查看 NAS 备份计划（不连接 NAS、不写远端）
node src/agent.js nas-dry-run --config linke.config.json

# retention-dry-run：查看快照保留计划（不删除、只读）
node src/agent.js retention-dry-run --server http://localhost:3000 --device my-pc
node src/agent.js retention-dry-run --server http://localhost:3000 --device my-pc --keep-last 5
```

### run-once

从 JSON 配置文件加载 `backupJobs`，先发送心跳，再逐一执行备份。

```json
{
  "serverUrl": "http://127.0.0.1:3000",
  "deviceId": "my-macbook",
  "backupJobs": [
    { "name": "docs", "sourcePath": "/Users/me/Documents" }
  ],
  "excludePatterns": ["*.tmp", "node_modules"]
}
```

### launchd-dry-run

生成 macOS launchd plist XML，用于定时执行 `run-once`。

- **不会调用 `launchctl`**，不会自动安装到 `~/Library/LaunchAgents/`
- **不会自动启动**任何系统服务
- 输出路径被限制在项目目录内，拒绝 `../` 逃逸
- 用户需手动 `cp` plist 到 `~/Library/LaunchAgents/` 并 `launchctl load` 才能生效

### nas-dry-run

验证 NAS 目标配置并输出 dry-run 计划。

- **不会连接 NAS**（不发起任何网络请求）
- **不会写入远端**（不传输任何文件）
- **不会保存或允许凭证字段**（`username`、`password`、`token`、`apiKey`、`secret`、`accessKey`、`refreshToken` 均被拒绝）
- **拒绝 endpoint 中包含 userinfo**（如 `http://user:pass@host`）
- 支持的 NAS provider：`synology`、`ugreen`

```json
{
  "nasTargets": [
    {
      "name": "home-synology",
      "provider": "synology",
      "endpoint": "http://192.168.1.100:5000",
      "shareName": "backup",
      "remotePath": "/volume1/backup",
      "enabled": true
    }
  ]
}
```

### retention-dry-run

查看快照保留策略的 dry-run 计划，按 `createdAt` 降序排序，保留最新 N 个快照（默认 keepLast=3）。

- **不会删除任何快照**，只输出计划
- **不会写入任何文件**，纯只读操作
- **不承诺自动清理**：当前版本不实现真实删除/自动清理功能
- 排序字段：`createdAt`（降序，最新优先）
- 相同 `createdAt` 时保持稳定顺序（按原始数组顺序）
- `keepLast` 必须是正整数，拒绝 0、负数、小数、非数字

### backup-preflight-dry-run

V0.11 增加备份预检 dry-run。给定 `sourcePath` 和可选 `excludePatterns` 后，Linke 会只读扫描源目录，输出：

- `included`：会进入备份的相对路径列表
- `excluded`：被排除规则命中的相对路径和 `matchedPattern`
- `summary.totalFiles`、`summary.includedCount`、`summary.excludedCount`

backup-preflight-dry-run **不会创建快照、不会复制文件、不会写入 metadata、不会修改仓库元数据**。它只做本机只读扫描，不解决生产级 `sourcePath` 沙箱问题。

### Web Console 备份预检 dry-run

V0.12 在 Web Console 中增加备份预检 dry-run 面板。输入 `sourcePath` 和可选 `excludePatterns` 后，控制台会调用 `backup-preflight-dry-run` 并显示：

- 总文件数、拟包含数量、拟排除数量
- `included`：会进入备份的相对路径列表
- `excluded`：被排除的相对路径和 `matchedPattern`

该面板只做备份预检，**没有真实备份执行按钮**，不会创建快照、不会复制文件、不会写入 metadata。当前版本仍不提供生产级 `sourcePath` 沙箱。

### Web Console NAS dry-run

V0.13 在 Web Console 中增加 NAS dry-run 面板。粘贴包含 `deviceId`、`nasTargets` 和可选 `backupJobs` 的配置 JSON 后，控制台会调用 `POST /api/nas-dry-run` 并显示：

- NAS 目标数量和关联任务数量
- 每个目标的 provider、name、endpoint、shareName、remotePath 和 enabled 状态
- `wouldConnect:false` 与 `wouldWrite:false` 的 dry-run 安全结果

该面板只做配置验证和计划预览，不连接 NAS、不发起 NAS 网络请求、不传输文件、不写入远端、不保存配置。配置示例不包含密码、token 或 API key；带 credential 字段或 URL userinfo 的目标会被拒绝。

### NAS app adapter dry-run

V0.14 在 NAS dry-run 中增加应用适配器计划。`nasTargets[]` 可声明可选 `appAdapter`：

```json
{
  "appAdapter": {
    "appId": "synology-backup",
    "operation": "backup-plan"
  }
}
```

支持的 appId：

- `synology-backup`
- `synology-files`
- `ugreen-backup`
- `ugreen-files`

dry-run 输出会在对应 target 上增加 `adapterPlan`，包含 `wouldInvokeApp:false`、`wouldConnect:false`、`wouldWrite:false` 和计划步骤。该功能只生成应用嵌套调用预览，不调用 NAS app、不发起认证、不 ping/probe、不连接 NAS、不写入远端、不保存配置。`appAdapter` 内出现 credential 字段会被拒绝，provider 与 appId 不匹配也会被拒绝。

### Web Console 设备详情面板

V0.15 在 Web Console 中增加只读设备详情面板。点击设备列表中的任意设备后，面板会复用现有 `/api/devices` 数据显示：

- `deviceId`
- `hostname`
- `ipAddress`
- `status`
- `lastHeartbeatAt`
- `lastBackupAt`
- `snapshotCount`

该面板只做统一管理视图展示，不新增设备详情 API、不写入设备元数据、不提供编辑、删除、远程命令、ping/probe 或 NAS 操作按钮。缺失字段会显示稳定 fallback，例如 `unknown`、`无心跳`、`无备份` 或 `0`。

### Web Console 多设备列表控制

V0.16 在 Web Console 设备面板中增加紧凑工具栏，支持：

- 按名称 / Device ID / IP 搜索设备
- 按状态过滤：全部 / 在线 / 离线 / 未知
- 按名称、IP、最后心跳、快照数排序
- 实时显示可见设备数 / 总数计数

该功能仅前端只读派生视图，不新增写接口、不触发备份、不连接 NAS、不新增 API 路由。筛选状态不持久化，刷新页面后重置。如果筛选结果隐藏了已选设备，设备详情面板不会清空，只有当 `/api/devices` 中不再包含该设备时才清空详情。

### Web Console 保留计划面板

V0.7 在 Web Console 中增加只读保留计划面板。选中设备后，控制台会请求该设备的 `retention-dry-run` 计划，并显示：

- `keepLast` 输入：默认 3，仅允许正整数
- 保留数量与拟淘汰数量
- 每个快照的计划动作：`保留` 或 `拟淘汰`

该面板只做 dry-run 可视化预览，**没有应用策略、清理或删除按钮**，不会删除快照、不会写入文件、不会执行自动清理。

### Web Console 快照清单详情

V0.8 在 Web Console 中增加只读快照清单详情面板。选中设备并点击某个快照后，控制台会读取该快照的 `manifest.json`，并显示：

- 快照 ID
- 原始 `sourcePath`
- 创建时间
- 文件数量
- 备份文件相对路径列表

该面板只读展示 snapshot manifest，**没有修改、重新扫描、恢复执行或删除按钮**，不会修改快照、不会写入 manifest、不会删除任何数据。

### Web Console 快照差异 dry-run

V0.9 在 Web Console 中增加快照差异预览面板。选中设备后，如果该设备至少有两个快照，控制台会用 `diff-dry-run` 比较两个快照的 `manifest.files`，并显示：

- `added`：目标快照新增的相对路径
- `removed`：目标快照不再包含的相对路径
- `unchanged`：两个快照共同包含的相对路径

该面板只比较 manifest 文件路径列表，**不读取文件内容、不比较 hash、不写入文件、不执行恢复、不删除数据**。

### restore-dry-run

V0.10 增加恢复预检 dry-run。给定设备、快照和目标目录后，Linke 会读取 snapshot manifest，并只读扫描目标目录中已存在的相对路径，输出：

- `would-create`：目标目录中不存在、恢复时会创建的文件路径
- `would-overwrite`：目标目录中已经存在、恢复时会覆盖的文件路径
- `summary.totalFiles`、`summary.wouldCreateCount`、`summary.wouldOverwriteCount`

restore-dry-run **不会复制文件、不会覆盖文件、不会创建目录、不会写入目标目录**，也不会修改 `manifest.json`、`snapshots.json` 或其他元数据。

### Web Console 恢复预检 dry-run

V0.10 在 Web Console 中增加恢复预检面板。选中设备和快照后，输入目标目录即可查看 restore-dry-run 计划：

- 拟创建数量
- 拟覆盖数量
- 每个 manifest 文件的 `sourceRelativePath`、目标 `targetPath` 和 `action`

该面板只做恢复预检，**没有真实恢复执行按钮**，不会复制文件、不会覆盖文件、不会写入目标目录。

## 安全边界

**Linke V0.x 是 localhost 原型**，设计为单机开发/测试用途，不具备生产级安全隔离：

### 无认证

- **没有认证/鉴权机制**，任何能访问 HTTP 端口的人都可以触发备份和恢复
- **不可直接暴露到网络**（公网或不受信任的局域网）

### API 路径风险

- `/api/backups` 的 `sourcePath` 是**服务端本机路径**，由调用方直接传入，服务端未做沙箱限制
- `/api/restore` 的 `targetPath` 同样是**服务端本机路径**，恢复操作直接写入该路径

### NAS dry-run 安全保证

- nas-dry-run **不会连接 NAS**，不会发起任何网络请求
- nas-dry-run **不会写入远端**，不会传输任何文件到 NAS 设备
- **拒绝凭证字段**：nasTargets 中不允许出现 `username`、`password`、`token`、`apiKey`、`secret`、`accessKey`、`refreshToken` 等字段
- **拒绝 endpoint userinfo**：endpoint URL 中不允许嵌入 `user:pass@host` 形式的凭证

### launchd dry-run 安全保证

- launchd-dry-run **不会调用 `launchctl`**
- **不会自动安装** plist 到系统目录
- **不会自动启动**任何持久化服务
- 输出路径限制在项目目录内，拒绝路径逃逸

### retention dry-run 安全保证

- retention-dry-run **不会删除任何快照**，不执行任何文件/目录删除操作
- **不会写入任何文件**，不修改 snapshots.json 或其他元数据
- 纯只读操作：读取现有快照列表，输出保留/淘汰计划
- **不承诺自动清理**：当前版本不实现真实删除或自动清理功能

### restore-dry-run 安全保证

- restore-dry-run **不会复制文件**，不会执行真实恢复
- restore-dry-run **不会覆盖文件**，不会改写目标目录中的已有文件
- restore-dry-run **不会写入目标目录**，不会创建目录或写入任何文件
- restore-dry-run **不会修改快照元数据**，不写入 `manifest.json`、`snapshots.json` 或 `device.json`
- 纯只读操作：读取 snapshot manifest，并只读扫描目标目录中已存在的相对路径

### backup-preflight-dry-run 安全保证

- backup-preflight-dry-run **不会创建快照**，不会创建 snapshot 目录
- backup-preflight-dry-run **不会复制文件**，不会把源文件写入仓库
- backup-preflight-dry-run **不会写入 metadata**，不修改 `device.json`、`snapshots.json`、`manifest.json` 或其他仓库元数据
- 纯只读操作：读取 `sourcePath` 的目录项并应用 `excludePatterns`
- 当前版本仍允许调用方传入服务端本机 `sourcePath`，不提供生产级路径沙箱

### NAS 实现现状

> **重要**：当前 NAS 实现仅为 **dry-run provider 骨架**。它只负责验证配置结构和输出计划，**不会建立真实 NAS 连接**，不会执行真实远程备份。真实 NAS 传输功能尚未实现。

## API

| 方法   | 路径                                        | 说明               |
| ------ | ------------------------------------------- | ------------------ |
| GET    | /                                           | Web Console        |
| GET    | /api/backup-preflight-dry-run              | 备份预检 dry-run   |
| GET    | /api/devices                                | 设备列表           |
| GET    | /api/devices/:deviceId/snapshots            | 设备快照列表       |
| GET    | /api/devices/:deviceId/snapshots/:snapshotId/manifest | 快照 manifest 详情 |
| GET    | /api/devices/:deviceId/snapshots/:snapshotId/restore-dry-run | 恢复预检 dry-run |
| GET    | /api/devices/:deviceId/snapshots/diff-dry-run | 快照差异 dry-run   |
| GET    | /api/devices/:deviceId/retention-dry-run    | 快照保留 dry-run   |
| POST   | /api/heartbeat                              | 记录心跳           |
| POST   | /api/backups                                | 创建备份快照       |
| POST   | /api/nas-dry-run                            | NAS 预检 dry-run   |
| POST   | /api/restore                                | 从快照恢复         |

## 测试

```bash
npm test
```

测试覆盖：心跳、备份/恢复、并发隔离、路径安全、excludePatterns、run-once、launchd-dry-run、nas-dry-run、NAS app adapter dry-run、retention-dry-run、restore-dry-run、backup-preflight-dry-run、manifest 详情 API、snapshot diff dry-run API、Web Console 契约、保留计划面板、快照清单详情面板、恢复预检面板、备份预检面板、NAS dry-run 面板、备份预检命令提示与快照差异预览面板、设备详情面板。

## 技术约束

- Node.js ESM，零外部运行时依赖
- 仅使用 Node 内置模块（node:http, node:fs/promises, node:path, node:crypto, node:os）
- 原子元数据写入（write-to-tmp + rename）
- deviceId slug 化防止路径穿越攻击

## 未实现 / 不在当前范围

以下内容 **尚未实现**，请勿将当前版本用于对应场景：

- ❌ 真实快照删除 / 自动清理（retention-dry-run 仅输出计划，不执行删除）
- ❌ 真实 NAS 连接与远程文件传输
- ❌ 多设备间数据互相同步
- ❌ 文件版本冲突自动处理
- ❌ 生产级认证/鉴权
- ❌ 自动启动守护进程（需用户手动配置 launchd）
- ❌ 生产环境部署
