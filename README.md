# Linke V0.37

轻量级备份与恢复代理，带 Web 管理控制台。

> **当前版本：V0.37** — 单机 localhost 原型阶段，尚未具备生产级安全隔离。

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
| V0.16 | 设备列表控制 | Web Console 设备面板新增搜索、状态过滤、排序和计数工具栏，纯前端只读派生视图 |
| V0.17 | 备份任务概览 | Web Console 新增只读备份任务概览面板，从现有 snapshot 元数据按 jobName/sourcePath 聚合任务视图 |
| V0.18 | 备份任务详情时间线 | Web Console 新增只读备份任务详情时间线，从既有 snapshot 元数据展示单个任务的历史版本 |
| V0.19 | 备份任务时间线 snapshot 联动 | Web Console 备份任务时间线 snapshot 联动，可点击任务历史版本并复用快照清单详情与恢复预检 dry-run |
| V0.20 | 事件日志面板增强 | Web Console 事件日志面板增强，展示前端内存态结构化事件、累计计数、最近事件和 50 条可见上限 |
| V0.21 | 设备备份健康 | Web Console 新增设备备份健康面板，基于现有设备状态、快照数和最后备份时间生成只读健康分类 |
| V0.22 | 备份版本一致性 | Web Console 新增备份版本一致性面板，从现有 snapshot 元数据比较跨设备任务最新版本 |
| V0.23 | 版本一致性 snapshot 联动 | Web Console 版本一致性 snapshot 联动，可点击设备版本行并复用快照清单详情与恢复预检 dry-run |
| V0.24 | 版本一致性筛选与搜索 | Web Console 版本一致性筛选与搜索，可按状态和任务 / 路径 / 设备 / IP 搜索任务组 |
| V0.25 | 版本一致性非最新摘要 | Web Console 版本一致性非最新摘要，在一致性面板中增加只读摘要 |
| V0.26 | 版本一致性排序控制 | Web Console 版本一致性排序控制，可按风险、最大时间差、非最新设备数、最近备份和任务名重排任务组 |
| V0.27 | 覆盖缺口摘要 Lite | 覆盖缺口摘要 Lite，在版本一致性面板增加只读覆盖缺口统计与各任务组覆盖情况 |
| V0.28 | 版本一致性覆盖筛选 | 在版本一致性面板增加只读覆盖筛选下拉框，按 all/gap/full 过滤任务组 |
| V0.29 | 版本一致性覆盖缺口排序 | 在版本一致性面板增加只读覆盖缺口排序选项，按缺失设备数、缺失率、预期设备数进行级联排序 |
| V0.30 | 版本一致性覆盖率显示 | 在各任务组覆盖行展示整数覆盖率百分比，分母为 0 时不显示覆盖率 |
| V0.31 | 版本一致性无可观测设备回退 | 当任务组 expectedDeviceCount <= 0 时展示无可观测设备并不包含覆盖率，> 0 时不展示无可观测设备 |
| V0.32 | 无可观测设备筛选 | 版本一致性无可观测设备筛选，在覆盖筛选下拉框增加 unobservable 选项 |
| V0.33 | 统一管理态 | 统一管理态：设备/IP 统一管理状态只读展示 |
| V0.34 | 管理态筛选 | 管理状态筛选与计数支持 |
| V0.35 | 管理态分桶统计 | 管理状态分桶统计与快速切换 |
| V0.36 | 管理态分桶选中态 | 分桶按钮 active 高亮与 aria-pressed 可访问状态 |
| V0.37 | 当前版本 | 管理态分桶作用域：分桶计数按搜索和状态筛选联动 |

## 特性

- **设备心跳** — 注册设备并跟踪在线状态
- **设备列表控制** — Web Console 设备面板支持按名称 / Device ID / IP 搜索、按状态过滤（全部 / 在线 / 离线 / 未知）、按名称 / IP / 最后心跳 / 快照数排序，并实时显示可见 / 总数计数
- **设备备份健康** — Web Console 基于现有 `/api/devices` 数据生成前端只读健康分类，展示健康、需关注、离线和未知设备数量
- **备份版本一致性** — Web Console 只读读取现有设备快照，按 jobName / sourcePath 比较跨设备任务的最新版本是否一致
- **版本一致性 snapshot 联动** — Web Console 可从版本一致性面板点击设备版本行，并复用现有快照清单详情与恢复预检 dry-run 查看具体 snapshot
- **版本一致性筛选与搜索** — Web Console 可在版本一致性面板按全部 / 版本不一致 / 单设备 / 一致过滤，并按 jobName / sourcePath / deviceId / hostname / IP 搜索任务组，显示可见 / 总数计数
- **版本一致性非最新摘要** — Web Console 在备份版本一致性面板的每个任务组中增加只读摘要，展示最新和非最新设备数、单设备判定及最大时间差
- **版本一致性排序控制** — Web Console 可在版本一致性面板中按风险优先、最大时间差、非最新设备数、最近备份和任务名重排任务组，排序只作用于已加载的浏览器内存数据
- **覆盖缺口摘要 Lite** — Web Console 在版本一致性面板中增加只读覆盖缺口统计，展示可观测设备、加载失败排除设备、覆盖缺口任务数及完全覆盖任务数，并在各任务组行中显示具体覆盖比例及缺失设备
- **版本一致性覆盖筛选** — Web Console 支持在版本一致性面板按全部（all）/ 有覆盖缺口（gap） / 完全覆盖（full）过滤任务组，内存过滤联动不触发 snapshot 重新请求
- **版本一致性覆盖缺口排序** — Web Console 支持在版本一致性面板按覆盖缺口相关的指标在浏览器内存中对已加载的任务组进行级联降序排序
- **版本一致性覆盖率显示** — Web Console 在版本一致性面板的每个任务组覆盖行显示整数覆盖率百分比，分母为 0 时不显示覆盖率，避免 NaN 或误导性百分比
- **版本一致性无可观测设备回退** — Web Console 当版本一致性任务组 expectedDeviceCount <= 0 时在覆盖行展示无可观测设备且不显示覆盖率，expectedDeviceCount > 0 时不展示无可观测设备
- **版本一致性无可观测设备筛选** — Web Console 在版本一致性覆盖筛选中增加无可观测设备（unobservable）选项，仅显示 expectedDeviceCount <= 0 的任务组
- **备份任务概览** — Web Console 只读备份任务概览面板，从现有 snapshot 元数据按 jobName / sourcePath 聚合，展示任务数、快照总数、最近备份时间和每个任务的详情
- **备份任务详情时间线** — Web Console 可从备份任务概览中选择一个任务，只读查看该任务的历史快照时间线、源路径、快照数量和最近备份时间
- **备份任务时间线 snapshot 联动** — Web Console 可从备份任务详情时间线中选择单个历史 snapshot，并复用快照清单详情与恢复预检 dry-run 面板查看版本内容和恢复影响预览
- **设备详情** — Web Console 可只读查看设备的 deviceId、hostname、IP 地址、状态、最后心跳、最后备份和快照数
- **统一管理态** — Web Console 统一管理态支持基于设备状态和 IP 地址进行只读分类展示（在线可见 / 在线缺 IP / 离线保留 / 未知待确认），无任何写入、控制或修改操作
- **管理态筛选** — Web Console 管理态筛选支持在设备面板通过下拉框筛选不同管理状态（`visible`、`missing-ip`、`offline-retained`、`unknown`），并支持与已有状态和搜索词的 AND 复合检索，实时显示可见/总数计数
- **管理态分桶统计** — Web Console 设备面板展示 `all` / `visible` / `missing-ip` / `offline-retained` / `unknown` 分桶计数，并支持点击分桶快速切换现有管理态筛选
- **管理态分桶选中态** — Web Console 管理态分桶控件使用按钮语义，基于 `device-management-filter` 同步 active 高亮、`aria-pressed` 与 `data-active` 状态
- **管理态分桶作用域** — Web Console 管理态分桶计数会随搜索词和状态筛选同步变化，但忽略当前管理态筛选，便于在同一搜索 / 状态范围内快速切换管理态
- **事件日志面板增强** — Web Console 事件日志面板增强，展示前端内存态结构化事件、累计计数、最近事件和 50 条可见上限
- **快照备份** — 将本地文件备份到仓库，支持并发隔离
- **快照恢复** — 从快照精确恢复文件（sha256 校验）
- **Web Console** — 管理界面：设备列表 / 设备详情 / 快照列表 / 快照清单详情 / 恢复预检 / 备份预检 / NAS 预检 / 快照差异预览 / 事件日志面板增强 / 保留计划面板 / 备份任务概览 / 备份任务详情时间线 / 备份任务时间线 snapshot 联动 / 设备备份健康 / 备份版本一致性 / 版本一致性 snapshot 联动 / 版本一致性筛选与搜索 / 版本一致性非最新摘要 / 版本一致性排序控制 / 覆盖缺口摘要 / 版本一致性覆盖筛选 / 版本一致性覆盖缺口排序 / 版本一致性覆盖率显示 / 版本一致性无可观测设备回退 / 版本一致性无可观测设备筛选 / 统一管理态 / 管理态筛选 / 管理态分桶统计 / 管理态分桶选中态 / 管理态分桶作用域
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

### Web Console 备份任务概览

V0.17 在 Web Console 中增加只读备份任务概览面板。选中设备后，控制台复用现有 `/api/devices/:deviceId/snapshots` 响应，从 snapshot 元数据推导备份任务：

- 优先按 `jobName` 聚合
- 缺失 `jobName` 时按 `sourcePath` 聚合
- 展示任务数、快照总数、最近备份时间
- 每个任务展示任务名、源路径、快照数、最近备份时间和最近文件数

该面板只读展示历史快照中可确认存在的任务，不新增 API 路由、不写入 metadata、不触发备份、不创建快照、不连接 NAS、不调用 NAS app、不执行远程传输。尚未执行过、没有历史 snapshot 的配置任务不会出现在 V0.17 概览中。

### Web Console 备份任务详情时间线

V0.18 在 Web Console 中增加只读备份任务详情时间线。选中设备后，先在"备份任务概览"中选择一个从历史 snapshot 推导出的任务，控制台会继续复用现有 `/api/devices/:deviceId/snapshots` 响应展示该任务的历史版本：

- 任务名称
- 源路径
- 快照数量
- 最近备份时间
- 每个历史快照的 snapshot ID、创建时间、文件数量和 sourcePath

该面板是只读派生视图，不新增 API 路由、不写入 metadata、不触发备份、不执行恢复、不创建快照、不删除快照、不连接 NAS、不调用 NAS app、不执行远程传输。时间线行在 V0.18 中不联动 manifest detail 或 restore dry-run。尚未执行过、没有历史 snapshot 的配置任务不会出现在详情时间线中。

### Web Console 备份任务时间线 snapshot 联动

V0.19 在 V0.18 的备份任务详情时间线上增加只读 snapshot 联动。选中设备并选择一个备份任务后，可以点击该任务时间线中的某个历史 snapshot。控制台会复用现有快照清单详情和恢复预检 dry-run 面板：

- 快照清单详情显示该 snapshot 的 manifest、sourcePath、createdAt 和文件列表
- 恢复预检 dry-run 使用当前目标目录输入，显示 would-create / would-overwrite 预览
- 时间线行会显示选中态，帮助确认当前查看的历史版本

该联动只读取既有 snapshot、manifest 和 restore-dry-run 结果，不新增 API 路由、不写入 metadata、不执行恢复、不复制文件、不覆盖文件、不创建目录、不删除快照、不连接 NAS、不调用 NAS app、不执行远程传输。点击备份任务本身不会自动选择 snapshot；只有点击具体时间线行才会加载 manifest detail 和 restore dry-run。

### Web Console 事件日志面板增强

V0.20 在 Web Console 中增强事件日志面板。展示前端内存态结构化事件、累计计数、最近事件和 50 条可见上限。

- 事件日志为前端内存态，纯只读显示。
- 刷新页面后事件日志会重置。
- 界面最多展示最近的 50 条可见事件。
- 累计计数为页面生命周期计数器。
- 不新增 API，不写入任何元数据，不会进行备份、恢复、删除、NAS 连接、NAS 应用适配或远程文件传输。

### Web Console 设备备份健康

V0.21 在 Web Console 中新增设备备份健康面板。控制台复用现有 `/api/devices` 响应，在前端生成只读健康分类：

- `健康`：设备在线，快照数大于 0，且最后备份时间有效且不晚于当前时间
- `需关注`：设备在线，但缺少有效备份记录，例如快照数为 0、缺少最后备份时间或最后备份时间无效
- `离线`：设备状态为 offline
- `未知`：设备状态缺失或不是 online / offline

面板会展示健康、需关注、离线和未知数量，并列出每台设备的 hostname、Device ID、IP 地址、状态、快照数、最后心跳、最后备份和健康原因。点击健康项会复用现有设备选择流程，加载设备详情、快照、保留计划和备份任务视图。

该面板是前端只读派生视图，不新增 API、不写入 metadata、不触发备份、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。健康结果刷新页面后会重新从 `/api/devices` 派生，不会被持久化保存。

### Web Console 备份版本一致性

V0.22 在 Web Console 中新增备份版本一致性面板。控制台复用现有 `/api/devices` 与 `/api/devices/:deviceId/snapshots` 响应，在前端按备份任务聚合跨设备最新版本：

- 分组规则：优先按 `jobName` 分组；没有 `jobName` 时按 `sourcePath` 分组
- `一致`：多台设备都有该任务快照，且最新版本一致，即最新快照的创建时间与文件数一致
- `版本不一致`：多台设备都有该任务快照，但最新版本不同，即最新快照时间或文件数不同
- `单设备`：只有一台设备存在该任务快照，当前无法做跨设备一致性比较

面板会展示一致、版本不一致、单设备和任务组总数，并列出每个任务组的 jobName、sourcePath、最新备份时间、快照数量、设备版本状态和原因。该视图用于发现“哪些任务可能需要人工检查”，不做自动同步、不解决冲突、不判断文件内容 hash 是否完全一致。

该面板是前端只读派生视图，不新增 API、不写入 metadata、不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。尚未执行过、没有历史 snapshot 的配置任务不会出现在 V0.22 一致性面板中。

### Web Console 版本一致性 snapshot 联动

V0.23 在 V0.22 的备份版本一致性面板上增加只读 drill-down。点击任一任务组下的设备版本行后，控制台会切换到该设备上下文，并复用现有面板加载对应最新 snapshot：

- 设备详情：切换到被点击的设备
- 快照列表：刷新该设备的现有 snapshots
- 保留计划：刷新该设备的 retention dry-run
- 快照清单详情：读取该 snapshot manifest
- 恢复预检：读取该 snapshot 的 restore-dry-run

该联动只用于从“版本不一致”快速查看具体 snapshot 内容和恢复影响预览。它不是同步能力，不会自动判断正确版本，不解决冲突，不执行文件复制或覆盖。

该功能仍是前端只读联动，不新增 API、不写入 metadata、不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。

### Web Console 版本一致性筛选与搜索

V0.24 在 V0.22/V0.23 的备份版本一致性面板上增加只读筛选与搜索工具栏。控制台仍先读取现有 `/api/devices` 与 `/api/devices/:deviceId/snapshots` 响应，生成全量一致性结果，然后只在浏览器内存中重新过滤和渲染任务组，不重新请求 API，不保存筛选状态。

支持的状态筛选：

- `全部`
- `版本不一致`
- `单设备`
- `一致`

支持的搜索字段：

- `jobName`
- `sourcePath`
- `deviceId`
- `hostname`
- `IP`

面板会显示可见 / 总数计数。汇总数字仍代表全量任务组的一致、版本不一致、单设备和任务组总数；筛选只影响下方列表的可见范围。

该功能只是前端只读派生视图控制，不新增 API、不写入 metadata、不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。

### Web Console 版本一致性非最新摘要

V0.25 在备份版本一致性面板的每个任务组中增加只读非最新摘要行。最新设备数量、非最新设备数量、单设备任务判定以及最大时间差都会被计算并直接呈现在界面上。

#### 版本一致性非最新摘要安全保证

- **不新增 API**：不增加任何后端 API 接口，只复用现有 API 响应。
- **不写入任何元数据**：纯前端内存计算只读派生视图，不修改/不写入 metadata 且不保存状态。
- **不触发备份**：不触发备份。
- **不执行同步**：不执行同步。
- **不执行恢复**：不执行恢复。
- **不删除快照**：不删除快照。
- **不连接 NAS**：不连接 NAS。
- **不调用 NAS app**：不调用 NAS app。
- **不执行远程传输**：不执行远程传输。

### Web Console 版本一致性排序控制

V0.26 在备份版本一致性面板的筛选与搜索工具栏中增加只读排序控制。排序只对已经加载到浏览器内存中的任务组生效，不重新请求 API，不保存排序状态。

支持的排序方式：

- `风险优先`：保持默认风险顺序，版本不一致优先，其次单设备和一致任务组。
- `最大时间差`：最大 `maxTimeDriftMs` 优先，便于优先查看跨设备版本差异最大的任务。
- `非最新设备数`：非最新设备数最多的任务优先。
- `最近备份`：最近 `latestCreatedAt` 优先。
- `任务名`：按 `jobName` 字母顺序排列，同名时按 `sourcePath` 排列。

该功能只是前端只读派生视图控制，不新增 API、不写入 metadata、不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。

### Web Console 版本一致性覆盖筛选

V0.28 在备份版本一致性面板的筛选与搜索工具栏中增加只读覆盖筛选。支持在浏览器内存中按以下选项过滤任务组，且整个过程不重新请求 API，不新增 API：

- `all`：全部任务组（默认值）。
- `gap`：有覆盖缺口的任务组，即存在至少一个可观测设备未上传该任务组的快照（`missingDeviceCount > 0`）。
- `full`：完全覆盖的任务组，即所有可观测设备均已上传快照且至少有一个预期设备（`expectedDeviceCount > 0` 且 `missingDeviceCount === 0`）。

该功能仅用于前端内存视图过滤，整个过程无需向后端发送任何写请求，亦不连接 NAS，不影响顶部的全量汇总计数。

### Web Console 版本一致性覆盖缺口排序

V0.29 在备份版本一致性面板的排序工具栏中增加只读覆盖缺口排序选项。在选择该选项时，通过如下降序级联排序链在前端内存中重新排序已加载的任务组：

1. **缺失设备数（missingDeviceCount）降序**：缺失设备越多的任务组优先展示。
2. **缺失率（missingDeviceCount / expectedDeviceCount）降序**：比例越高越优先（若预期设备数 <= 0，缺失率视为 0）。
3. **预期设备数（expectedDeviceCount）降序**：预期设备数越多越优先。
4. **现有风险排序器（compareVersionConsistencyRisk）兜底**：用于对上述项完全相同的任务组进行兜底，按既有风险优先顺序比较状态、时间戳、任务名和路径。

该功能仅用于前端只读派生视图重排，不重新请求 API，不新增 API，不修改任何元数据。

### Web Console 版本一致性覆盖率显示

V0.30 在备份版本一致性面板的各任务组覆盖行中增加只读覆盖率显示。覆盖率只基于已加载到浏览器内存中的 `coveredDeviceCount` 与 `expectedDeviceCount` 计算：

- 当 `expectedDeviceCount > 0` 时，界面显示整数百分比，例如 `覆盖 2 / 3 · 覆盖率 67% · 缺 Mac C`。
- 百分比使用 `Math.round((coveredDeviceCount / expectedDeviceCount) * 100)` 计算。
- 当 `expectedDeviceCount <= 0` 时不显示 `覆盖率` 字样，避免出现 `NaN%`、`0%` 或 `100%` 这类误导性展示。

该功能仅用于前端只读派生视图展示，不重新请求 API，不新增 API，不修改任何元数据。

### Web Console 版本一致性无可观测设备回退

V0.31 在备份版本一致性面板的各任务组覆盖行中增加只读的无可观测设备回退显示。

- 当 `expectedDeviceCount <= 0` 时，在覆盖行中追加 ` · 无可观测设备` 回退提示，且绝对不包含 `覆盖率` 字样。
- 当 `expectedDeviceCount > 0` 时，覆盖行中绝对不包含 `无可观测设备` 字样，并保持 V0.30 的覆盖率百分比展示规则。

该功能仅用于前端内存视图渲染，不重新请求 API，不新增 API，不修改任何元数据。

### Web Console 版本一致性无可观测设备筛选

V0.32 在备份版本一致性面板的覆盖筛选下拉框中增加 `unobservable`（无可观测设备）选项。覆盖筛选的语义为：

- `all`：显示全部任务组。
- `gap`：仅显示 `expectedDeviceCount > 0` 且 `missingDeviceCount > 0` 的任务组。
- `full`：仅显示 `expectedDeviceCount > 0` 且 `missingDeviceCount === 0` 的任务组。
- `unobservable`：仅显示 `expectedDeviceCount <= 0` 的任务组。

该功能只在浏览器内存中重排可见任务组，不重新请求 API，不新增 API，不写入任何元数据。

### Web Console 统一管理态

V0.33 在 Web Console 中新增只读的 "统一管理态" (Unified Management State)。该状态基于设备状态和 IP 地址进行前端只读分类展示：
- 在线可见：在线（online）且 IP 地址为有效 IP。
- 在线缺 IP：在线（online）但 IP 地址为 `null`/`undefined`、空字符串、纯空白字符或 `'unknown'`/`' UNKNOWN '`（不区分大小写及首尾空格）。
- 离线保留：离线（offline）。
- 未知待确认：其它未知状态、缺少状态或设备对象为空。

统一管理态安全边界：
- 属于纯前端只读视图，不新增 API。
- 不写入元数据 (不写入任何元数据，不写入 metadata)。
- 不触发备份 (不进行备份)。
- 不执行远程命令 (不执行任何远程命令)。
- 不连接 NAS (不建立真实 NAS 连接)。
- 不进行修改 (无批量操作，无修复操作)。

### Web Console 管理态筛选

V0.34 在 Web Console 设备面板中增加了 "管理态筛选" 功能。管理员可以在设备列表中通过下拉选择框按管理状态分类过滤设备：
- `all`：显示所有管理状态（默认）。
- `visible`：显示在线可见的设备。
- `missing-ip`：显示在线缺 IP 的设备。
- `offline-retained`：显示离线保留的设备。
- `unknown`：显示未知待确认的设备。

该筛选采用 **AND 复合语义** 与现有的搜索输入和设备状态过滤器相结合，重绘和计数更新均在浏览器本地内存中进行，不触发对后端 `/api/devices` 的重新获取。

### Web Console 管理态筛选安全边界

V0.34 管理态筛选属于前端只读视图，具备以下安全保证：
- 只读，不新增 API。
- 不写入元数据，不写入任何元数据。
- 不执行远程命令，不执行任何远程命令。
- 不连接 NAS，不建立真实 NAS 连接。
- 不进行修改，无批量操作，无修复操作。

### Web Console 管理态分桶统计

V0.35 在 Web Console 设备面板中增加了 "管理态分桶统计" 功能。系统自动根据当前设备列表计算出各管理状态的设备数量，并在控制台上方的分桶计数面板中展示：
- `all`：全部。
- `visible`：在线可见。
- `missing-ip`：在线缺 IP。
- `offline-retained`：离线保留。
- `unknown`：未知待确认。

管理员可以点击任意分桶，快速将底部的管理态过滤器切换到对应的状态并实时刷新列表与计数。该操作仅影响前端本地内存视图，不进行后端 API 重新获取。

### Web Console 管理态分桶统计安全边界

管理态分桶统计属于只读视图派生逻辑，具备以下安全保证：
- 只读，不新增 API。
- 不写入任何元数据。
- 不执行远程命令，不执行任何远程命令。
- 不连接 NAS，不建立真实 NAS 连接。
- 不进行修改，无批量操作，无修复操作。

### Web Console 管理态分桶选中态

V0.36 将管理态分桶控件升级为可访问的按钮控件。分桶按钮继续复用现有 `device-management-filter` 作为唯一状态源，点击按钮或手动切换下拉框时，都会同步更新：
- active 高亮状态。
- `aria-pressed` 状态。
- `data-active` 状态。
- 设备列表和 `device-filter-count` 的本地筛选结果。

该功能只同步浏览器内存中的选中态，不持久化筛选状态，刷新页面后不保留当前筛选。

### Web Console 管理态分桶选中态安全边界

管理态分桶选中态属于前端只读交互增强，具备以下安全保证：
- 只读，不新增 API。
- 不写入任何元数据。
- 不执行远程命令。
- 不连接 NAS。
- 不保存筛选状态，不持久化筛选状态。

### Web Console 管理态分桶作用域

V0.37 将管理态分桶计数的作用域调整为当前搜索词和状态筛选后的设备集合。分桶计数会响应：
- `device-search` 搜索词。
- `device-status-filter` 状态筛选。

分桶计数会忽略当前管理态筛选（`device-management-filter`），因此点击 `visible`、`missing-ip`、`offline-retained` 或 `unknown` 分桶时，分桶数字保持在同一个搜索 / 状态范围内，只有设备列表和 `device-filter-count` 随管理态筛选变化。

该逻辑只在浏览器内存中对已加载的 `/api/devices` 数据做派生计算，不重新请求 `/api/devices`，不新增后端接口。

### Web Console 管理态分桶作用域安全边界

管理态分桶作用域属于前端只读派生视图，具备以下安全保证：
- 只读，不新增 API。
- 不重新请求 `/api/devices`。
- 不写入任何元数据。
- 不执行远程命令。
- 不连接 NAS。

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

### 备份任务时间线 snapshot 联动安全保证

- 备份任务时间线 snapshot 联动只调用既有 manifest detail 与 restore-dry-run 读取接口，不执行恢复、不写入 metadata、不连接 NAS。
- 不新增 API 路由、不复制文件、不覆盖文件、不创建目录、不删除快照、不调用 NAS app、不执行远程传输。
- 纯只读操作：复用现有快照清单详情和恢复预检 dry-run 面板展示历史版本内容和恢复影响预览。

### 事件日志面板增强安全保证

- 事件日志面板增强为纯只读展示，数据仅保存在前端内存中，刷新页面即重置。
- 事件日志面板不会保存或写入任何元数据，不触发备份、恢复或删除操作。
- 事件日志最多只在界面展示最近的 50 条记录，累计计数仅作为页面生命周期计数器。
- 该功能不新增任何后端 API 路由。
- 不会建立真实 NAS 连接，不会调用 NAS 应用适配器，不会执行任何远程文件传输。

### 设备备份健康安全保证

- 设备备份健康面板只读取现有 `/api/devices` 响应，在前端生成只读派生视图。
- 不新增 API，不写入任何元数据，不保存健康分类结果。
- 不触发备份、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 未来时间的最后备份会被视为无效备份，避免因时钟漂移误报健康。

### 备份版本一致性安全保证

- 备份版本一致性面板只读取现有 `/api/devices` 与 `/api/devices/:deviceId/snapshots` 响应，在前端生成只读派生视图。
- 不新增 API，不写入任何元数据，不保存一致性分类结果。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 版本一致性只比较每个任务组最新快照的创建时间和文件数，不读取文件内容，不进行冲突自动处理。

### 版本一致性 snapshot 联动安全保证

- 版本一致性 snapshot 联动只读取现有 `/api/devices/:deviceId/snapshots`、manifest detail、restore-dry-run 和 retention-dry-run 响应。
- 不新增 API，不写入任何元数据，不保存联动状态。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 点击设备版本行只是切换 Web Console 的只读查看上下文，不会自动选择正确版本或解决冲突。

### 版本一致性筛选与搜索安全保证

- 版本一致性筛选与搜索只读取已加载到浏览器内存中的一致性结果，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存筛选条件，不保存搜索内容。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 搜索和状态筛选只改变可见任务组列表，不改变一致性分类结果，也不会自动选择正确版本或解决冲突。

### 版本一致性排序控制安全保证

- 版本一致性排序控制只读取已加载到浏览器内存中的一致性结果，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存排序条件。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 排序只改变可见任务组顺序，不改变一致性分类结果，也不会自动选择正确版本或解决冲突。

### 版本一致性覆盖筛选安全保证

- 版本一致性覆盖筛选只在前端浏览器内存中进行，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存筛选条件。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 覆盖率筛选只改变可见任务组列表，不改变一致性分类结果，也不会自动选择正确版本或解决冲突。

### 版本一致性覆盖缺口排序安全保证

- 版本一致性覆盖缺口排序只在前端浏览器内存中进行，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存排序条件。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 排序只改变可见任务组顺序，不改变一致性分类结果，也不会自动选择正确版本或解决冲突。

### 版本一致性覆盖率显示安全保证

- 版本一致性覆盖率显示只在前端浏览器内存中进行，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存覆盖率结果。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 覆盖率显示只改变任务组覆盖行的文字表达，不改变一致性分类结果、覆盖筛选结果或覆盖缺口排序结果。

### 版本一致性无可观测设备回退安全保证

- 版本一致性无可观测设备回退处理完全在前端浏览器内存中进行，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存回退提示状态。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 无可观测设备回退展示只改变任务组覆盖行的文字表达，不改变一致性分类结果、覆盖筛选结果或覆盖缺口排序结果。

### 版本一致性无可观测设备筛选安全保证

- 版本一致性无可观测设备筛选只读取已加载到浏览器内存中的一致性结果，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存筛选条件。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 该筛选只改变可见任务组列表，不改变一致性分类结果，也不会自动选择正确版本或解决冲突。

### 备份版本一致性覆盖缺口摘要安全保证

- 备份版本一致性覆盖缺口摘要为纯只读展示，在前端生成只读派生视图。
- 该功能不重新请求 API，不新增 API。
- 不写入任何元数据，不保存任何一致性或覆盖分类结果。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 覆盖缺口摘要只检测可观测设备是否成功上传该任务组的快照，不修改设备配置或快照元数据。

### 备份版本覆盖与缺口统计

版本一致性面板包含覆盖缺口摘要统计。由于单设备任务组（`single-device`）也属于存在设备覆盖缺失的情况，因此覆盖缺口计数与单设备任务组有重叠。两者并不是互斥的问题，UI/README 透明表达了这种重叠，不制造互斥的错觉。若设备快照加载失败，该设备将被自动排除或进行降级提示，不计入覆盖缺口分母，以避免虚高覆盖要求。

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

测试覆盖：心跳、备份/恢复、并发隔离、路径安全、excludePatterns、run-once、launchd-dry-run、nas-dry-run、NAS app adapter dry-run、retention-dry-run、restore-dry-run、backup-preflight-dry-run、manifest 详情 API、snapshot diff dry-run API、Web Console 契约、保留计划面板、快照清单详情面板、恢复预检面板、备份预检面板、NAS dry-run 面板、备份预检命令提示与快照差异预览面板、设备详情面板、备份任务概览面板、备份任务详情时间线面板、备份任务时间线 snapshot 联动、事件日志面板增强、设备备份健康面板、备份版本一致性面板、版本一致性 snapshot 联动、版本一致性筛选与搜索、版本一致性非最新摘要、版本一致性排序控制、覆盖缺口摘要、版本一致性覆盖筛选、版本一致性覆盖缺口排序、版本一致性覆盖率显示、版本一致性无可观测设备回退、版本一致性无可观测设备筛选、统一管理态、管理态筛选、管理态分桶统计、管理态分桶选中态、管理态分桶作用域。

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
