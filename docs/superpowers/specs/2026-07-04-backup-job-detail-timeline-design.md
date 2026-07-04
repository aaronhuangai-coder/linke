# Linke V0.18 备份任务详情时间线设计

## 摘要

V0.18 在 Web Console 中增加只读的备份任务详情时间线。用户在 V0.17 的“备份任务概览”中选择一个推断出的备份任务后，可以查看该任务对应的历史快照列表。

该功能完全复用现有 `GET /api/devices/:deviceId/snapshots` 响应。它不新增后端路由，不写入 metadata，不创建、删除、恢复或传输文件，也不连接或调用 Synology / Ugreen NAS 应用。

## 目标

- 在 Web Console 中新增备份任务详情面板。
- 允许用户从“备份任务概览”选择一个任务。
- 按与 V0.17 概览一致的规则，从现有 snapshots 中过滤出该任务的快照。
- 在详情面板中展示：
  - 任务名称
  - 源路径
  - 快照数量
  - 最近备份时间
  - 快照时间线
- 每条时间线记录展示：
  - snapshot ID
  - createdAt
  - file count
  - sourcePath
- 设备切换、快照加载中、加载失败时立即清空旧任务详情，避免残留旧设备数据。
- 更新 README 到 V0.18。
- 增加纯函数、HTML hook、DOM 交互、状态清理、安全边界和 README 测试。

## 非目标

- 不新增备份任务配置模型。
- 不新增 `/api/devices/:deviceId/backup-jobs` 或 `/api/devices/:deviceId/backup-jobs/:key` 路由。
- 不新增真实备份、恢复、删除、重试、调度或同步按钮。
- 不新增任务编辑、任务删除、任务启停或任务重命名。
- 不联动 manifest detail 或 restore dry-run；时间线行在 V0.18 中只读展示。
- 不连接 NAS，不调用 NAS app，不传输远端数据，不保存凭证。
- 不改变现有 snapshot list、snapshot manifest、snapshot diff、restore dry-run、retention dry-run、backup preflight、NAS dry-run 或 adapter dry-run 的行为。

## 现有数据契约

现有 snapshot list endpoint 已包含详情时间线需要的数据：

```json
[
  {
    "snapshotId": "11111111-1111-1111-1111-111111111111",
    "createdAt": "2026-07-04T10:00:00.000Z",
    "hostname": "Aaron-Mac",
    "sourcePath": "/Users/ah/Documents",
    "fileCount": 42,
    "jobName": "documents"
  }
]
```

V0.18 不要求新增存储字段。

## Web Console 行为

初始状态：

- 备份任务概览保持 V0.17 行为。
- 新详情面板显示 `请选择一个备份任务`。
- 不新增初始 API 调用。

选择设备时：

- 现有设备点击路径仍设置 `selectedDeviceId`，渲染设备详情，刷新设备列表状态，并调用 `fetchSnapshots(deviceId)` 与 `fetchRetentionPlan(deviceId)`。
- `fetchSnapshots(deviceId)` 仍只调用 `GET /api/devices/:deviceId/snapshots`。
- 快照加载开始时，旧的备份任务详情立即重置为加载或占位状态。
- 快照加载成功后，渲染 snapshot list、backup jobs overview、backup job detail 占位状态和 snapshot diff controls。

选择备份任务时：

- 用户点击概览中的某个任务项。
- 控制台记录 `selectedBackupJobKey`。
- 备份任务概览重新渲染选中态。
- 详情面板用同一份 snapshots 渲染该任务的时间线。
- 点击任务不触发任何写 API，也不触发 NAS、restore 或 backup 操作。

没有快照时：

- 概览显示 `暂无备份任务`。
- 详情面板显示 `请选择一个备份任务`。
- 计数保持 `0`，最近备份显示 `无备份`。

快照加载失败时：

- 概览显示 `加载失败`。
- 详情面板显示 `加载失败`。
- 计数重置为 `0`，最近备份显示 `无备份`。
- 现有事件日志错误行为保持不变。

## 分组与时间线规则

V0.18 复用 V0.17 的任务分组规则：

- `snapshot.jobName` 是非空字符串时，按 `jobName` 分组。
- `snapshot.jobName` 缺失或为空时，按 `sourcePath` 分组。
- `sourcePath` 缺失或为空时使用 `unknown`。
- 显示名称优先使用 `jobName`，否则使用 `未命名任务`。
- 任务 key 必须与 `buildBackupJobOverview(snapshots)` 输出的 `key` 保持一致。

新增纯函数为 `buildBackupJobTimeline(snapshots, jobKey)`，返回：

- `key`
- `jobName`
- `sourcePath`
- `snapshotCount`
- `latestSnapshotId`
- `latestCreatedAt`
- `latestFileCount`
- `snapshots`

`snapshots` 按 `createdAt` 有效时间倒序排列。无效或缺失日期排在最后，并且界面不得显示 `Invalid Date`。

## DOM Hooks

保留 V0.17 hooks，并新增稳定 hooks：

- `backup-job-detail-panel`
- `backup-job-detail-device-name`
- `backup-job-detail-title`
- `backup-job-detail-source`
- `backup-job-detail-count`
- `backup-job-detail-latest`
- `backup-job-detail-list`
- `backup-job-detail-empty`
- `backup-job-timeline-item`
- `backup-job-timeline-id`
- `backup-job-timeline-created`
- `backup-job-timeline-file-count`
- `backup-job-timeline-source`

概览任务项继续使用 V0.17 的 `backup-job-item` hook，并增加选中态样式。

## 数据流

1. `fetchDevices()` 按现有逻辑加载设备。
2. 用户点击设备。
3. 点击处理器设置 `selectedDeviceId`，清空 `selectedSnapshotId` 与 `selectedBackupJobKey`。
4. 控制台清空旧 snapshot detail、restore dry-run、backup job detail 等派生状态。
5. `fetchSnapshots(deviceId)` 请求现有 snapshots endpoint。
6. 成功后缓存当前设备 snapshots 到 `cachedSnapshots`。
7. `renderSnapshots(snapshots, deviceId)` 渲染现有快照列表。
8. `renderBackupJobsOverview(snapshots, deviceId)` 渲染概览，并给每个任务项绑定只读选择行为。
9. `renderBackupJobDetail(null, snapshots, deviceId)` 渲染占位状态。
10. 用户点击任务项后，设置 `selectedBackupJobKey`，调用 `renderBackupJobsOverview` 更新选中态，并调用 `renderBackupJobDetail(selectedBackupJobKey, cachedSnapshots, selectedDeviceId)`。
11. `renderSnapshotDiffControls(snapshots, deviceId)` 保持现有行为。

## 安全边界

该功能只读：

- 不新增 API route。
- 不调用 `POST /api/backups`。
- 不调用 `POST /api/restore`。
- 不调用 `POST /api/nas-dry-run`。
- 不写入 metadata。
- 不创建、恢复、删除、覆盖或传输文件。
- 不连接 NAS，不调用 NAS app。
- 不保存 job 状态。
- 不读取或输出任何凭证、token、API key 或 `.env` 内容。

## 运行韧性

正常状态：

- 设备选择加载 snapshots。
- 概览和详情都从同一份 response 派生。
- 任务详情按最新快照优先展示稳定时间线。

恢复锚点：

- 详情面板无持久状态。刷新 snapshots 后可重新由服务端 metadata 派生。

有界失败：

- 缺失 `jobName`、缺失 `sourcePath`、无效 `createdAt`、缺失 `fileCount` 使用稳定 fallback。
- 快照 API 失败只重置派生视图，不产生执行路径。
- 设备切换时先清空旧详情，避免异步请求期间显示旧设备任务。

检测信号：

- 测试覆盖纯函数、DOM hooks、任务点击渲染、设备切换清理、只读安全边界和 README 版本说明。

最高风险路径：

- 用户快速从设备 A 切换到设备 B 时，不得继续显示设备 A 的任务详情或时间线。

## 验收标准

- `npm test` 通过。
- `git diff --check` 通过。
- Web Console 显示只读备份任务详情面板。
- 选择设备后，概览仍按 V0.17 规则显示任务。
- 点击任务后，详情面板显示该任务的历史快照时间线。
- 快照时间线按 `createdAt` 倒序排列。
- 切换设备或 snapshot 请求失败时，旧任务详情被清空。
- 不新增后端路由。
- 新面板不调用任何写接口。
- README 标识 V0.18 为当前版本，并说明备份任务详情时间线。

## PM 决策

采纳：

- V0.18 仅做前端只读详情时间线。
- 复用 `GET /api/devices/:deviceId/snapshots`。
- 任务 key 复用 V0.17 概览分组规则。
- 时间线行只读展示，不联动 manifest detail 或 restore dry-run。
- 配置过但从未执行过的备份任务仍不显示。

拒绝：

- V0.18 不新增后端聚合 endpoint。
- V0.18 不新增持久化 backup job registry。
- V0.18 不新增执行、编辑、删除、重试、调度、NAS 或远程传输控制。
