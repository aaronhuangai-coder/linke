# Linke V0.27 版本覆盖缺口摘要 Lite 面板设计

## 目标

V0.27 在 Web Console 的“备份版本一致性”面板下方新增“版本覆盖缺口摘要 Lite”，帮助用户从多台可观测设备中判断哪些备份任务未被完全覆盖（例如在某些设备上缺失该备份任务），并提供失败设备自动排除能力。

## 范围

- 扩展纯函数 `buildBackupVersionConsistency(devices, snapshotsByDevice, options = {})` 支持 `excludedCoverageDeviceIds`。
- 前端计算可观测设备数（`coverageDeviceCount`）、排除/加载失败设备数（`coverageExcludedDeviceCount`）、有覆盖缺口的任务组数（`coverageGapCount`）和完全覆盖任务组数（`fullyCoveredCount`）。
- 并在每个任务组行中展示其覆盖设备数、可观测覆盖设备数、缺失设备数和缺失设备的主机名。
- 新增只读摘要 `data-testid="version-consistency-coverage-summary"` 和各任务行的覆盖行 `data-testid="version-consistency-coverage-gap"`。
- 新增 `fetchBackupVersionConsistency` 捕获单设备快照加载失败自动排除逻辑。
- 更新 README 文档与单元/集成测试。

## 非目标

- 不新增后端 API。
- 不修改 `package.json` / `node_modules`。
- 不新增任何备份、同步、恢复、删除、NAS 连接或远程传输能力。

## 覆盖口径与重叠设计

- **可观测覆盖设备（Observable Coverage Devices）**：`safeDevices` 中拥有有效 `deviceId` 且不在 `excludedCoverageDeviceIds` 中的设备。
- **重叠表达**：单设备（`single-device`）任务组与覆盖缺口任务组（`coverageGapCount`）有重叠（若可观测覆盖设备数大于 1，则仅在单设备上有快照的任务组也属于有覆盖缺口的任务组）。UI 与文档将对此进行透明表达，不制造两者互斥的错觉。
- **排除加载失败**：在加载设备快照失败时，捕获异常并把该 `deviceId` 加入排除列表，避免在摘要中虚高分母，并由 UI 显示“排除加载失败 N 台”。

## 验收标准

- Web Console 包含只读摘要 `data-testid="version-consistency-coverage-summary"`。
- 任务组行包含 `data-testid="version-consistency-coverage-gap"`，在有缺失时显示最多 3 个缺失设备名和 `+N 更多`。
- 测试覆盖 HTML hook、DOM 渲染、纯函数 coverage 字段、加载失败排除以及 README V0.27。
- README 更新到 V0.27，更新里程碑表格，并包含安全保证与未承诺的生产限制说明。
