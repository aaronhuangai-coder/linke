# Linke V0.31 版本一致性无可观测设备回退设计

## 目标

V0.31 在 Web Console 的“备份版本一致性”面板中，当某个版本一致性任务组的预期设备数 `expectedDeviceCount` 小于或等于 `0` 时，其覆盖行（`data-testid="version-consistency-coverage-gap"` 元素）中应当展示 `无可观测设备` 回退提示，且绝对不能包含 `覆盖率` 字样。当 `expectedDeviceCount` 大于 `0` 时，覆盖行绝对不能包含 `无可观测设备` 字样。

## 范围

- **HTML 渲染与内容规则**：
  在 `data-testid="version-consistency-coverage-gap"` 元素的文本内容中：
  - 如果该任务组的 `expectedDeviceCount <= 0`：
    - 文本内容中必须包含 `无可观测设备`。
    - 文本内容中绝对不能包含 `覆盖率` 字样。
  - 如果该任务组的 `expectedDeviceCount > 0`：
    - 文本内容中绝对不能包含 `无可观测设备` 字样。
    - 维持 V0.30 的覆盖率百分比展示规则（如包含 `覆盖率 X%`）。
- **组合逻辑**：
  此项规则属于只读前端渲染逻辑，不影响数据的计算流与排序流。
- **交互设计**：
  所有判断与展示均在前端内存中直接派生计算并完成渲染，不触发任何额外的 API 请求，不重新拉取快照。

## 非目标

- 不新增后端 API 接口。
- 不修改/更新任何后端元数据。
- 不建立 NAS 连接，不调用任何 NAS 应用，不执行远程传输。
- 不触发备份、同步、恢复或删除操作。

## 安全边界（Safety Boundary）

- 纯前端内存态计算与渲染，无任何状态写入。
- 不会向后端发送任何写请求。
- 不连接 NAS，不进行备份、同步、恢复、淘汰或远程文件传输操作。

## 验收标准

- 当任务组的 `expectedDeviceCount <= 0` 时，对应任务组的 `version-consistency-coverage-gap` 元素 textContent 包含 `无可观测设备`，且不包含 `覆盖率` 字样。
- 当任务组的 `expectedDeviceCount > 0` 时，对应任务组的 `version-consistency-coverage-gap` 元素 textContent 不包含 `无可观测设备` 字样。
- DOM 渲染交互全部在前端内存中完成，无新增 API 请求。
- 自动化测试通过，且 README 文档断言成功升级至 V0.31。
