# Linke V0.21 设备备份健康面板设计

## 摘要

V0.21 在现有 Web Console 中新增“设备备份健康”面板。该面板复用 `/api/devices` 已返回的设备状态、IP、快照数、最后心跳和最后备份时间，在前端生成只读健康分类，帮助用户快速识别多台设备中哪些备份状态正常、哪些需要关注。

## 目标

- 在 Web Console 中新增只读设备备份健康面板。
- 基于现有 `/api/devices` 响应生成健康分类，不新增 API。
- 展示健康汇总计数：健康、需关注、离线、未知。
- 展示每台设备的健康条目：名称、Device ID、IP、设备状态、快照数、最后心跳、最后备份和健康标签。
- 点击健康条目时复用现有设备选择流程，加载设备详情、快照、保留计划、备份任务概览和任务时间线。
- 更新测试和 README，使 V0.21 成为当前版本。

## 非目标

- 不触发真实备份。
- 不执行恢复、删除、清理或同步。
- 不新增后端 API 路由。
- 不写入 `device.json`、`snapshots.json`、`manifest.json` 或任何 metadata。
- 不连接 NAS，不调用 NAS app，不执行远程文件传输。
- 不新增认证、鉴权或生产级安全隔离。
- 不实现健康告警、邮件通知、后台调度或持久化健康历史。

## 健康分类规则

分类函数输入为 `/api/devices` 返回的设备数组。每个设备只产生一个健康状态：

- `healthy`：`status === "online"`，`snapshotCount > 0`，并且 `lastBackupAt` 是有效且不晚于当前时间的日期。
- `attention`：`status === "online"`，但没有有效备份记录；包括 `snapshotCount <= 0`、缺少 `snapshotCount`、缺少 `lastBackupAt` 或 `lastBackupAt` 不是有效日期。
- `offline`：`status === "offline"`。
- `unknown`：状态不是 `online` / `offline`，或设备对象缺失关键字段导致无法归入以上类别。

汇总计数按上述最终分类累计。列表默认按健康优先级排序：

1. `attention`
2. `offline`
3. `unknown`
4. `healthy`

同一分类内按设备名称排序。设备名称优先使用 `hostname`，缺失时使用 `deviceId`，仍缺失时显示 `unknown`。

每个健康项还需要生成 `healthReason`：

- `healthy`：`最近备份有效`
- `attention`：`缺少有效备份`
- `offline`：`设备离线`
- `unknown`：`状态未知`

离线设备仍归类为 `offline`，但条目必须继续展示 `snapshotCount` 和 `lastBackupAt`，让用户能区分“离线前有备份”和“离线且从未备份”。未来时间的 `lastBackupAt` 视为无效备份，避免因时钟漂移误报健康。

## 用户体验

面板位于现有“设备详情”和“快照”区域之间，作为统一管理视图的一部分。顶部显示四个紧凑统计值：

- 健康
- 需关注
- 离线
- 未知

下方列表展示所有已加载设备。每条健康项包含：

- 设备名称
- Device ID
- IP 地址
- 健康标签
- 健康原因
- 设备状态
- 快照数
- 最后心跳
- 最后备份

点击健康项时，行为与点击设备列表项一致：设置当前设备、重置当前 snapshot 和备份任务选择、渲染设备详情、刷新设备选中态、加载快照和 retention dry-run。

空设备列表时显示“暂无设备健康数据”。设备加载失败时沿用现有事件日志错误提示，不额外写入健康状态。

## DOM 合约

HTML 需要新增稳定 hook：

- `data-testid="device-health-panel"`
- `data-testid="device-health-healthy-count"`
- `data-testid="device-health-attention-count"`
- `data-testid="device-health-offline-count"`
- `data-testid="device-health-unknown-count"`
- `data-testid="device-health-list"`
- `data-testid="device-health-safety-note"`

每条健康项由 `app.js` 动态创建，并使用：

- `data-testid="device-health-item"`
- `data-device-id="<deviceId>"`
- `data-health-status="<healthy|attention|offline|unknown>"`
- 子元素 `data-testid="device-health-name"`
- 子元素 `data-testid="device-health-device-id"`
- 子元素 `data-testid="device-health-ip"`
- 子元素 `data-testid="device-health-status"`
- 子元素 `data-testid="device-health-reason"`
- 子元素 `data-testid="device-health-snapshots"`
- 子元素 `data-testid="device-health-heartbeat"`
- 子元素 `data-testid="device-health-backup"`

测试可以依赖 `data-testid`、`data-health-status` 和文本 fallback，不应依赖完整 className。

## 架构

`src/web/app.js` 增加纯函数：

- `getDeviceBackupHealthStatus(device)`：返回单个设备的健康状态。
- `buildDeviceBackupHealth(devices)`：返回 `{ summary, items }`。

`summary` 结构：

```js
{
  healthy: 0,
  attention: 0,
  offline: 0,
  unknown: 0,
  total: 0
}
```

`items` 中每个元素结构：

```js
{
  deviceId: "my-mac",
  hostname: "Aaron-MacBook",
  ipAddress: "192.168.1.20",
  status: "online",
  healthStatus: "healthy",
  healthLabel: "健康",
  healthReason: "最近备份有效",
  snapshotCount: 3,
  lastHeartbeatAt: "2026-07-05T08:00:00.000Z",
  lastBackupAt: "2026-07-05T07:30:00.000Z"
}
```

日期展示复用现有 `formatLastHeartbeat()` 和 `formatLastBackup()`，不在健康面板内新增独立日期格式。测试只断言 fallback 文案和有效日期会产生非 fallback 文案，不依赖完整本地化时间字符串。

`initConsole()` 在每次 `fetchDevices()` 成功后调用 `renderDeviceBackupHealth(devices)`。该渲染函数只读取内存中的设备数据，不调用后端写接口。`buildDeviceBackupHealth()` 必须先用 `Array.isArray(devices)` 守住输入；`null`、`undefined`、对象和错误值都按空数组处理。

## 数据流

1. `fetchDevices()` 调用既有 `/api/devices`。
2. 响应数组写入既有 `cachedDevices`。
3. `buildDeviceBackupHealth(cachedDevices)` 生成健康汇总和健康项。
4. `renderDeviceBackupHealth(cachedDevices)` 渲染计数和列表。
5. 用户点击健康项后复用现有设备选择逻辑，触发 `fetchSnapshots(deviceId)` 与 `fetchRetentionPlan(deviceId)`。

## 安全边界

设备备份健康面板是只读前端派生视图：

- 不新增 API。
- 不调用 `POST /api/backups`。
- 不调用 `POST /api/restore`。
- 不调用 `POST /api/nas-dry-run`。
- 不写入任何 metadata。
- 不保存健康结果。
- 不连接 NAS、不调用 NAS app、不执行远程传输。

健康项中的设备字段可能来自本机或测试数据。渲染必须使用 `createElement` + `textContent`，不得用 `innerHTML` 拼接设备名称、Device ID、IP、状态或时间字段。

健康项文本需要使用 CSS 处理长字符串：允许换行或截断，但不得让超长 hostname、Device ID、IP 或路径样式文本撑破面板布局。

## 正常态定义

完成后，访问 Web Console 时：

- HTML 包含设备备份健康面板 hook 和安全说明。
- 成功加载设备后，健康汇总计数与设备数组分类结果一致。
- 健康列表展示所有已加载设备。
- 缺失字段不会导致 `initConsole()` 抛异常。
- 连续两次成功加载 `/api/devices` 时，第二次响应会覆盖健康面板的派生结果，不保留旧计数。
- 点击健康项会选择对应设备，并加载该设备的快照和 retention dry-run。
- README 当前版本为 V0.21，并说明设备备份健康面板仍是只读前端派生视图。

## 恢复锚点

健康面板没有持久化状态。异常后恢复锚点是下一次 `/api/devices` 成功响应：

- 如果单个设备字段缺失，该设备归类为 `unknown` 或按规则归类为 `attention`，不影响其他设备渲染。
- 如果健康列表 DOM 容器缺失，渲染函数安全返回，不影响设备列表、快照列表和事件日志。
- 如果健康列表为空，保留汇总计数为 0，并显示“暂无设备健康数据”。
- 页面刷新后健康面板重新从 `/api/devices` 派生。

## 运行韧性

### 有界失效

- 设备数组不是数组：按空数组处理。
- `status` 缺失或不合法：分类为 `unknown`。
- 在线设备没有有效备份：分类为 `attention`，而不是误报健康。
- `snapshotCount` 缺失、负数或非数字：按 0 处理。
- `lastBackupAt` 是未来日期：分类为 `attention`，而不是误报健康。
- 日期字段无效：使用既有 fallback 文案，健康分类不抛异常。
- 设备文本字段包含 HTML：使用 `textContent`，按文本显示。

### 异常恢复

- 健康面板不依赖后端写入，因此失败不会污染数据。
- 下一次成功加载 `/api/devices` 会覆盖前一次派生结果。
- JavaScript 单线程执行下不新增并发锁；健康面板只消费当前 `fetchDevices()` 成功路径写入的 `cachedDevices`。
- 用户仍可通过原设备列表选择设备；健康面板失败不应阻断核心设备列表。

### 状态侦测与自检

- 测试断言纯函数分类、汇总计数和排序。
- DOM 测试断言健康面板 hook、健康项 hook、fallback 文案和点击复用设备选择流程。
- HTTP smoke 断言 `/` 与 `/app.js` 包含 V0.21 健康面板信号。
- 全量 `npm test` 作为回归门。

## 测试要求

- `test/web-console.test.js`
  - HTML 包含 V0.21 设备备份健康面板 hook。
  - 设备备份健康面板无执行按钮，不含备份、恢复、NAS 调用按钮。
  - `buildDeviceBackupHealth()` 将 healthy / attention / offline / unknown 分类正确。
  - `buildDeviceBackupHealth()` 对缺失字段设备不抛异常，并给出稳定 fallback。
  - `buildDeviceBackupHealth()` 将未来 `lastBackupAt` 归为 attention。
  - `initConsole()` 成功加载设备后渲染健康计数和健康项。
  - 连续两次设备加载后，健康计数反映第二次响应。
  - 点击健康项会调用既有快照加载路径，选择对应设备。
  - 设备文本中的 HTML 不通过 `innerHTML` 注入。
- `test/readme.test.js`
  - README 标题、版本徽章、版本表升级到 V0.21。
  - README 说明设备备份健康面板是前端只读派生视图。
  - README 说明该功能不新增 API、不写 metadata、不触发备份/恢复、不连接 NAS。
  - 测试覆盖摘要包含设备备份健康面板。

## 验收命令

```bash
node --test test/web-console.test.js
node --test test/readme.test.js
npm test
git diff --check
```

HTTP smoke 需要用脚本或命令断言响应内容；如果任一断言失败，本轮验收失败：

```bash
PORT=3006 HOST=127.0.0.1 DATA_DIR=/tmp/linke-v021-smoke node src/server.js
```

然后请求：

```bash
GET /
GET /app.js
GET /api/devices
```

预期：

- HTML 包含 `device-health-panel`、`device-health-list` 和 `device-health-safety-note`。
- `app.js` 包含 `buildDeviceBackupHealth`、`device-health-item` 和 `data-health-status`。
- `/api/devices` 返回 JSON 数组。

## 完成标准

- V0.21 设备备份健康面板实现并通过测试。
- 不新增后端写入路径。
- 不新增 NAS、备份、恢复、删除、同步或远程传输能力。
- README 与测试同步到 V0.21。
- Codex PM 独立验证全量测试、diff check 和 HTTP smoke。
