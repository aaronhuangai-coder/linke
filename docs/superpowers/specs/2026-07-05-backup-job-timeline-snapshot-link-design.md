# Linke V0.19 备份任务时间线快照联动设计

## 摘要

V0.19 在 V0.18 的“备份任务详情时间线”上增加只读联动。用户点击某个备份任务的历史 snapshot 行后，Web Console 复用现有快照选择逻辑，加载该 snapshot 的 manifest detail 和 restore dry-run 预览。

该功能仍是前端只读派生视图。不新增后端路由，不写入 metadata，不执行恢复，不创建或删除快照，不连接 NAS，不调用 Synology / Ugreen NAS 应用。

## 目标

- 让备份任务详情时间线中的每条 snapshot 行可选择。
- 点击时间线 snapshot 行后，设置当前 `selectedSnapshotId`。
- 复用现有 `fetchSnapshotManifest(deviceId, snapshotId)`。
- 复用现有 `fetchRestoreDryRunPlan(deviceId, snapshotId)`。
- 更新 manifest detail 面板标题和内容。
- 更新 restore dry-run 面板标题、计数和文件列表。
- 为时间线行增加稳定选中态，方便用户知道当前正在查看哪个版本。
- 设备切换、snapshot 加载中、snapshot 加载失败时清空旧的时间线选中态。
- 更新 README 到 V0.19，说明该联动仍然不会执行恢复。
- 增加 Web Console 交互测试和 README 测试。

## 非目标

- 不新增 snapshot detail API。
- 不新增 backup job API。
- 不新增任务版本专用后端模型。
- 不新增真实恢复执行按钮。
- 不自动恢复、复制、覆盖、删除、清理、重试或调度。
- 不改变现有 snapshot list 点击行为。
- 不改变现有 manifest detail API、restore dry-run API、snapshot diff dry-run API 或 retention dry-run API。
- 不连接 NAS，不调用 NAS app，不传输远端数据，不保存凭证。
- 不把时间线行联动到真实 restore endpoint。

## 现有数据契约

V0.19 继续复用 V0.18 的时间线数据来源：

```json
[
  {
    "snapshotId": "11111111-1111-1111-1111-111111111111",
    "createdAt": "2026-07-04T10:00:00.000Z",
    "sourcePath": "/Users/ah/Documents",
    "fileCount": 42,
    "jobName": "documents"
  }
]
```

点击时间线行后复用既有端点：

- `GET /api/devices/:deviceId/snapshots/:snapshotId/manifest`
- `GET /api/devices/:deviceId/snapshots/:snapshotId/restore-dry-run?targetPath=...`

V0.19 不要求新增存储字段。

## Web Console 行为

初始状态：

- 备份任务详情时间线仍显示 `请选择一个备份任务`。
- snapshot manifest detail 和 restore dry-run 面板保持既有占位状态。
- 不新增初始 API 调用。

选择设备时：

- 现有设备点击路径仍设置 `selectedDeviceId`。
- 设备切换时清空 `selectedSnapshotId` 和 `selectedBackupJobKey`。
- 旧备份任务详情和旧时间线选中态立即清空。
- 快照加载成功后，时间线详情默认仍未选择具体 snapshot。

选择备份任务时：

- 用户点击备份任务概览项。
- 控制台记录 `selectedBackupJobKey`。
- 详情时间线渲染该任务历史 snapshot。
- 此时不自动选择某个 snapshot，不自动调用 manifest 或 restore dry-run。

选择时间线 snapshot 时：

- 用户点击 `backup-job-timeline-item`。
- 控制台把该行 snapshot ID 写入 `selectedSnapshotId`。
- 时间线重新渲染或更新该行选中态。
- 调用现有 manifest detail 读取逻辑。
- 调用现有 restore dry-run 读取逻辑。
- 若 restore target input 为空，保持现有 `请输入目标目录` 行为。

选择普通 snapshot list 项时：

- 保持既有行为。
- 普通 snapshot list 点击仍可加载 manifest detail 和 restore dry-run。
- V0.19 不要求普通 snapshot list 反向高亮备份任务时间线。

快照加载失败时：

- 备份任务概览显示 `加载失败`。
- 备份任务详情显示 `加载失败`。
- `selectedSnapshotId` 清空。
- restore dry-run 和 snapshot detail 使用现有失败或占位行为。

## DOM Hooks 与样式

复用 V0.18 hooks：

- `backup-job-detail-panel`
- `backup-job-detail-list`
- `backup-job-timeline-item`
- `backup-job-timeline-id`
- `backup-job-timeline-created`
- `backup-job-timeline-file-count`
- `backup-job-timeline-source`

新增或强化：

- 时间线行设置 `data-snapshot-id`。
- 当前选中的时间线行增加 `selected` class。
- 时间线行可点击，但不得包含执行按钮。
- 样式只表达选择状态，不暗示执行恢复。

## 数据流

1. `fetchDevices()` 按现有逻辑加载设备。
2. 用户点击设备，清空 `selectedSnapshotId`、`selectedBackupJobKey` 和 `cachedSnapshots`。
3. `fetchSnapshots(deviceId)` 请求现有 snapshots endpoint。
4. 成功后缓存 snapshots 到 `cachedSnapshots`。
5. `renderBackupJobsOverview(cachedSnapshots, deviceId)` 渲染任务概览。
6. 用户点击任务项，设置 `selectedBackupJobKey`。
7. `renderBackupJobDetail(selectedBackupJobKey, cachedSnapshots, deviceId)` 渲染时间线。
8. 用户点击时间线 snapshot 行。
9. `selectSnapshotForDetail(deviceId, snapshotId)` 设置 `selectedSnapshotId`。
10. 该 helper 调用 `fetchSnapshotManifest(deviceId, snapshotId)` 和 `fetchRestoreDryRunPlan(deviceId, snapshotId)`。
11. 时间线行选中态更新。

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
- 不读取或输出 `.env`、token、API key、SSH key 或任何凭证。

restore dry-run 仍只调用既有 dry-run endpoint。它不会复制文件、不会覆盖文件、不会创建目录、不会写入目标目录。

## 运行韧性

正常状态：

- 设备选择加载 snapshots。
- 任务概览和任务详情由同一份 snapshots 派生。
- 用户选择时间线 snapshot 后，manifest detail 与 restore dry-run 都显示同一个 snapshot ID 对应的结果。

恢复锚点：

- 该联动不持久化任何状态。刷新页面或重新选择设备后，可从服务端 metadata 和当前用户选择重新派生。

有界失败：

- 时间线中缺失 `snapshotId` 的行不得触发 fetch。
- manifest detail 请求失败时只显示 manifest 加载失败，不影响时间线。
- restore dry-run 请求失败时只显示 restore dry-run 加载失败，不影响 manifest detail。
- 设备切换时先清空旧选中态，避免异步请求期间误显示旧设备版本。

检测信号：

- 测试覆盖时间线行可点击、调用 manifest endpoint、调用 restore dry-run endpoint、选中态、设备切换清理和只读安全文案。

最高风险路径：

- 用户在设备 A 的任务时间线选择 snapshot 后，快速切换到设备 B。控制台不得继续显示设备 A 的时间线选中态，也不得把后续 restore dry-run 选择错误地绑定到设备 A。

## 验收标准

- `npm test` 通过。
- `git diff --check` 通过。
- Web Console 时间线行可选择。
- 点击时间线行会调用既有 manifest endpoint。
- 点击时间线行会调用既有 restore dry-run endpoint。
- 点击时间线行后 `selectedSnapshotId` 逻辑与普通 snapshot list 点击保持一致。
- 时间线行显示 selected 状态。
- 切换设备或 snapshot 请求失败时旧时间线选中态清空。
- 不新增后端路由。
- 不调用任何写接口。
- README 标识 V0.19 为当前版本，并说明备份任务时间线 snapshot 联动仍是只读 dry-run 预览。

## PM 抗辩与决策

采纳：

- V0.19 做“时间线行联动现有快照详情能力”。
- 复用现有 manifest detail 和 restore dry-run 逻辑。
- 不新增任务版本专用 API。
- 点击备份任务时不自动选择最新 snapshot，避免用户误以为系统自动准备恢复。
- 点击具体时间线行后才加载 manifest 与 restore dry-run。

拒绝：

- 不做真实恢复。
- 不新增“恢复此版本”按钮。
- 不新增 NAS 远程传输或 NAS app 调用。
- 不新增后端聚合 endpoint。
- 不让时间线行自动触发任何写操作。

## 本轮协助程序状态

- implementer：Qwen 可用，后续实现阶段使用。
- reviewer：Codex PM。
- verifier：Codex PM。
- ZAI / GLM-5.2：本轮 smoke 返回无效固定句式，不作为抗辩或验收依据。
- AGY：本轮 smoke 超时无输出，不作为审核依据。
