# Linke V0.29 版本一致性覆盖缺口排序设计

## 目标

V0.29 在 Web Console 的“备份版本一致性”面板的排序下拉框（Select）中，新增一个排序选项“覆盖缺口排序”（coverage-gap），支持按覆盖缺口相关的指标在浏览器内存中对已加载的任务组进行实时排序。整个排序完全在前端浏览器内存中完成，且不改变整体汇总计数，与其他筛选（状态、搜索、覆盖率筛选）组合生效，不触发重新获取快照。

## 范围

- **HTML 结构**：在现有的 `data-testid="version-consistency-sort"` 的 `<select>` 下拉框中，新增一个 `value="coverage-gap"` 的 `<option>` 选项。
- **排序链规则（Sort Chain）**：
  在选择 `coverage-gap` 排序时，按以下优先级和顺序级联对比两个版本一致性组 $a$ 和 $b$：
  1. **缺失设备数（missingDeviceCount）降序**：缺口设备越多的组越优先。
  2. **缺失率（missing ratio）降序**：比例越高的组越优先。
     - 缺失率的计算公式为：$\text{ratio} = \frac{\text{missingDeviceCount}}{\text{expectedDeviceCount}}$。
     - 若 $\text{expectedDeviceCount} \le 0$，则缺失率 $\text{ratio}$ 视为 0。
  3. **预期设备数（expectedDeviceCount）降序**：在上述值均相同时，预期设备数越多的组越优先。
  4. **现有风险排序器（compareVersionConsistencyRisk）兜底**：若上述值仍相同，则回退到现有的风险优先（risk）对比逻辑进行排序。现有的风险对比逻辑依次比较：
     - 任务状态优先级顺序（status: drifted > single-device > synced）。
     - 最新备份创建时间（latestCreatedAt）降序。
     - 任务名称（jobName）字母升序（localeCompare）。
     - 备份源路径（sourcePath）字母升序（localeCompare）。
- **组合逻辑**：排序规则必须与现有的状态（status）、搜索查询（query/search）和覆盖率（coverage）筛选规则相组合，且在排序和过滤时不得修改/污染原始数据源顺序。
- **DOM 交互**：当用户切换到“覆盖缺口排序”时，DOM 列表根据组合条件在浏览器内存中重新排序并实时渲染，整个过程不调用任何后端 API 重新获取快照数据。
- **单设备组**：无需针对单设备组（single-device groups）进行特判，统一适用以上排序逻辑。

## 非目标

- **不新增后端 API**。
- **不修改/更新任何元数据**。
- **不建立 NAS 连接，不调用 NAS 应用，不执行远程传输**。
- **不触发备份、同步、恢复或删除操作**。

## 安全边界（Safety Boundary）

- 纯前端内存排序计算，无任何状态写入。
- 不会向后端发送任何写请求。
- 不连接 NAS，不进行备份、同步、恢复、淘汰或远程文件传输操作。

## 验收标准

- HTML 中 `data-testid="version-consistency-sort"` 下拉框存在并且包含 `value="coverage-gap"` 选项。
- 纯函数 `filterVersionConsistencyGroups` 正确实现 `coverage-gap` 排序链的降序逻辑与 tie-break 规则。
- 排序操作不污染/修改原始输入数据源的数组顺序。
- DOM 交互绑定 change 事件，切换到 `coverage-gap` 时能够实时重新排序渲染，且网络请求数不增加（无 refetch）。
- 自动化测试通过，且 README 文档断言成功升级至 V0.29。
