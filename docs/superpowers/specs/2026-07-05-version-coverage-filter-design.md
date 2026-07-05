# Linke V0.28 版本一致性覆盖筛选设计

## 目标

V0.28 在 Web Console 的“备份版本一致性”面板的筛选工具栏中，新增一个只读覆盖筛选下拉框（Select），支持按“全部”（all）、“有覆盖缺口”（gap）和“完全覆盖”（full）进行任务组过滤。该过滤操作完全在前端浏览器内存中完成，与其他筛选（状态、搜索、排序）组合生效，不触发重新获取快照，且不改变整体汇总计数。

## 范围

- **HTML 结构**：新增 `data-testid="version-consistency-coverage-filter"` 的 `<select>` 下拉框，且包含且仅包含三个选项：`all`、`gap`、`full`。
- **纯函数逻辑**：扩展 `filterVersionConsistencyGroups(consistency, controls)` 函数，使其支持 `controls.coverage` 参数：
  - `all`：返回所有任务组（默认值）。
  - `gap`：仅返回 `missingDeviceCount > 0` 的任务组。
  - `full`：仅返回 `expectedDeviceCount > 0` 且 `missingDeviceCount === 0` 的任务组。
- **组合逻辑**：覆盖率筛选必须与现有的状态（status）、搜索查询（query/search）和排序（sort）规则相组合，且在过滤/排序时不得修改/污染原始数据源顺序。
- **DOM 交互**：当用户切换该下拉框时，DOM 列表根据组合条件在浏览器内存中实时刷新，更新可见/总数计数，整个过程不调用任何后端 API 重新获取快照数据。

## 非目标

- **不添加 loading-failure-only 筛选**：因为现有的任务组（Group）级别数据结构不足以支持该筛选粒度。
- **不新增后端 API**。
- **不修改/更新任何元数据**。
- **不改变版本一致性面板顶部的整体汇总计数**（只读汇总保持不变，仅更新可见/总数比例标签如 `1 / 3`）。

## 安全边界（Safety Boundary）

- 纯前端内存视图计算，无任何状态写入。
- 不会向后端发送任何写请求。
- 不建立任何 NAS 连接，不进行备份、同步、恢复、淘汰或远程文件传输操作。

## 验收标准

- HTML 中存在 `data-testid="version-consistency-coverage-filter"` 下拉框，包含 `all`、`gap`、`full` 三个选项。
- 纯函数 `filterVersionConsistencyGroups` 正确实现 `all`、`gap`、`full` 的过滤口径。
- 筛选操作不污染/修改原始输入数据源的数组顺序。
- DOM 交互绑定 change 事件，切换时能够实时过滤，更新可见计数，且网络请求数不增加（无 refetch）。
- 自动化测试通过，且 README 文档断言成功升级至 V0.28。
