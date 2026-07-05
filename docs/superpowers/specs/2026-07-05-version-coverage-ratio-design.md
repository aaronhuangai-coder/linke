# Linke V0.30 版本覆盖率显示设计

## 目标

V0.30 在 Web Console 的“备份版本一致性”面板的各任务组“覆盖缺口元素”（`data-testid="version-consistency-coverage-gap"`）中，新增展示该任务的版本百分比覆盖率（例如 `覆盖率 67%`）。该更新能够清晰反映各个任务在可观测设备中的备份覆盖比例。

## 范围

- **HTML 渲染与内容规则**：
  在 `data-testid="version-consistency-coverage-gap"` 元素的文本内容中：
  - 如果该任务组的 `expectedDeviceCount` 大于 `0`，则在该元素的文本中包含 `覆盖率 X%`（如 `覆盖 2 / 3 · 覆盖率 67% · 缺 Mac C`）。
  - 百分比覆盖率计算公式为：`Math.round((coveredDeviceCount / expectedDeviceCount) * 100)`。
  - 如果 `expectedDeviceCount` 等于 `0`，则该元素的文本内容中绝对不能包含 `覆盖率` 字样。
- **组合逻辑**：
  覆盖率显示逻辑属于只读前端渲染，与现有的状态过滤、搜索过滤、覆盖筛选和覆盖缺口排序等功能组合生效，不影响数据的计算流与排序流。
- **交互设计**：
  在浏览器内存中直接派生计算并渲染更新，不触发任何额外的 API 请求，不重新拉取快照。

## 非目标

- **不新增后端 API 接口**。
- **不修改/更新任何后端元数据**。
- **不建立 NAS 连接，不调用任何 NAS 应用，不执行远程传输**。
- **不触发备份、同步、恢复或删除操作**。

## 安全边界（Safety Boundary）

- 纯前端内存态计算与渲染，无任何状态写入。
- 不会向后端发送任何写请求。
- 不连接 NAS，不进行备份、同步、恢复、淘汰或远程文件传输操作。

## 验收标准

- 当 `coveredDeviceCount = 2, expectedDeviceCount = 3` 时，对应任务组的 `version-consistency-coverage-gap` 元素 textContent 包含 `覆盖率 67%`。
- 当 `expectedDeviceCount = 0` 时，对应任务组的 `version-consistency-coverage-gap` 元素 textContent 不包含 `覆盖率` 字样。
- DOM 渲染交互全部在前端内存中完成，无新增 API 请求。
- 自动化测试通过，且 README 文档断言成功升级至 V0.30。
