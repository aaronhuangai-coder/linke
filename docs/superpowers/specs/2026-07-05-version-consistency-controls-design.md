# Linke V0.24 版本一致性筛选与搜索设计

## 目标

V0.24 在 V0.22/V0.23 的“备份版本一致性”面板上增加前端只读筛选与搜索工具栏。用户可以在任务组数量增加后，快速只看“版本不一致”“单设备”“一致”任务组，或按 jobName、sourcePath、deviceId、hostname、IP 地址搜索相关任务。

该功能服务于多设备统一管理，不改变备份、同步、恢复、NAS dry-run 的行为。

## 范围

- 在版本一致性面板增加：
  - 搜索输入框 `version-consistency-search`
  - 状态筛选 `version-consistency-status-filter`
  - 可见 / 总数计数 `version-consistency-filter-count`
- 筛选对象是 `buildBackupVersionConsistency()` 产出的任务组。
- 搜索范围：
  - `jobName`
  - `sourcePath`
  - 每个设备版本行的 `deviceId`
  - 每个设备版本行的 `hostname`
  - 每个设备版本行的 `ipAddress`
- 状态筛选范围：
  - `all`
  - `drifted`
  - `single-device`
  - `synced`
- 汇总计数继续展示全量任务组统计；可见计数单独显示过滤后的数量。

## 非目标

- 不新增后端 API。
- 不持久化筛选条件。
- 不新增同步、恢复、删除或应用策略按钮。
- 不做跨设备文件内容 hash 比较。
- 不自动判断正确版本。
- 不连接真实 NAS，不调用 NAS app，不执行远程文件传输。

## 数据流

1. `fetchBackupVersionConsistency(devices)` 继续读取现有设备 snapshot 列表。
2. `buildBackupVersionConsistency(devices, snapshotsByDevice)` 继续生成全量一致性结果。
3. UI 保存最近一次全量结果。
4. 搜索框或状态筛选变化时，只重新过滤和渲染内存中的结果，不重新请求 API。

## 安全边界

V0.24 仅增加前端派生视图控制：

- 不写 metadata。
- 不触发备份。
- 不执行同步。
- 不执行恢复。
- 不删除快照。
- 不连接 NAS。
- 不调用 NAS app。
- 不执行远程文件传输。

## 验收标准

- HTML 包含搜索、状态筛选和可见计数 DOM hook。
- 搜索 `jobName` 或 `sourcePath` 能只显示匹配任务组。
- 搜索设备 `deviceId`、`hostname` 或 `ipAddress` 能显示包含该设备的任务组。
- 状态筛选 `drifted` 只显示版本不一致任务组。
- 无匹配结果时显示“无匹配版本一致性任务”。
- README 当前版本更新为 V0.24，并说明此功能只读、不新增 API、不写 metadata、不执行同步/恢复/NAS 操作。
