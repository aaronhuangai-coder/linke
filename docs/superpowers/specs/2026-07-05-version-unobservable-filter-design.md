# Linke V0.32 版本一致性无可观测设备筛选设计

## 目标

V0.32 在 Web Console 的“备份版本一致性”面板中，针对覆盖筛选器（`data-testid="version-consistency-coverage-filter"`）引入一个新的选项值 `unobservable`（无可观测设备筛选）。该选项仅返回预期设备数 `expectedDeviceCount <= 0` 的任务组。同时，`gap` 和 `full` 筛选模式应当严格排除 `expectedDeviceCount <= 0` 的任务组。

## 范围

- **HTML 契约（HTML Contract）**：
  - 覆盖筛选器下拉菜单 `version-consistency-coverage-filter` 中必须包含 `<option value="unobservable">` 选项（即 `value="unobservable"`）。

- **纯函数逻辑（`filterVersionConsistencyGroups`）**：
  - 增加对 `coverage: 'unobservable'` 的支持，在此过滤条件下仅返回预期设备数 `expectedDeviceCount <= 0` 的任务组。
  - 调整 `coverage: 'gap'` 的逻辑：必须排除 `expectedDeviceCount <= 0` 的任务组（即仅包含 `expectedDeviceCount > 0` 且 `missingDeviceCount > 0`）。
  - 调整 `coverage: 'full'` 的逻辑：必须排除 `expectedDeviceCount <= 0` 的任务组（即仅包含 `expectedDeviceCount > 0` 且 `missingDeviceCount === 0`）。
  - 确保此筛选条件支持与 `status`（任务组状态）、`query`（搜索关键字）和 `sort`（排序规则）进行组合过滤，且不改动数据源数组的顺序（无副作用）。

- **交互设计**：
  - 此项功能为纯前端内存级 derived data 的过滤与重渲染，不触发任何额外的 API 请求，不重新拉取快照。

## 非目标

- 不新增后端 API 接口。
- 不修改任何后端元数据。
- 不建立 NAS 连接，不触发任何实际的备份、同步、恢复或删除操作。

## 安全边界（Safety Boundary）

- 纯前端内存态过滤与渲染，无任何状态写入。
- 绝不向后端发送写请求或触发任何耗时网络请求。

## 验收标准

- Web Console 页面 HTML 中，覆盖筛选器 `version-consistency-coverage-filter` 包含 `value="unobservable"`。
- 纯函数 `filterVersionConsistencyGroups` 在 `coverage: 'unobservable'` 条件下只返回 `expectedDeviceCount <= 0` 的任务组，且组合筛选正常，不修改源数组。
- 纯函数 `filterVersionConsistencyGroups` 在 `coverage: 'gap'` 和 `coverage: 'full'` 条件下不包含 `expectedDeviceCount <= 0` 的任务组。
- README.md 中已将当前版本更新为 V0.32，并在表格和说明中添加“版本一致性无可观测设备筛选”特性与对应的安全边界陈述，自动化测试（`test/readme.test.js`）能够识别这一改动。
