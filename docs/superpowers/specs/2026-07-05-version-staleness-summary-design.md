# Linke V0.25 版本一致性非最新摘要设计

## 目标

V0.25 在现有“备份版本一致性”面板中增加只读摘要，帮助用户快速看到每个任务组里有多少设备是最新版本、多少设备是非最新版本、单设备任务是否无法比较，以及最大时间差。

该功能只呈现既有 snapshot 元数据推导出的事实，不判断正确版本，不触发同步，不执行恢复。

## 范围

- 扩展 `buildBackupVersionConsistency()` 的每个 group：
  - `latestCount`
  - `staleCount`
  - `singleCount`
  - `maxTimeDriftMs`
  - `staleDeviceNames`
- 在 Web Console 的每个 `version-consistency-item` 中新增摘要行：
  - latest 数量
  - non-latest 数量
  - single 数量
  - max drift 文本
  - 非最新设备名称，超过 3 台时显示前 3 台和 `+N 更多`
- 所有动态文本继续使用 `textContent`。
- 复用现有 `/api/devices` 与 `/api/devices/:deviceId/snapshots` 响应。

## 非目标

- 不新增 API。
- 不新增按钮或执行动作。
- 不自动判断正确版本。
- 不新增排序控件。
- 不做设备 × 任务覆盖缺口矩阵。
- 不写入 metadata。
- 不触发备份、同步、恢复、删除、NAS 连接、NAS app 调用或远程文件传输。

## 语义

- `latestCount`：设备版本状态为 `latest` 的数量。
- `staleCount`：设备版本状态为 `stale` 的数量。
- `singleCount`：设备版本状态为 `single` 的数量。
- `maxTimeDriftMs`：同一任务组中最晚 `latestTime` 与最早 `latestTime` 的差值。只有 `drifted` 且至少两台设备有有效时间时才返回非 `null` 数值。
- `staleDeviceNames`：`versionState === "stale"` 的设备 hostname 列表，用于只读提示。

## 安全边界

- 纯前端只读派生视图。
- 不新增 API，不重新请求额外接口。
- 不写入 metadata，不保存摘要状态。
- 不触发备份、不执行同步、不执行恢复、不删除快照。
- 不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 文案避免“危险”“修复”“需要同步”等引导性词汇。

## 验收标准

- 纯函数测试覆盖 drifted、synced、single-device 三类摘要字段。
- DOM 测试能看到 `data-testid="version-consistency-staleness-summary"`。
- 摘要文本包含 `最新`、`非最新`、`单设备` 和 `最大时间差`。
- 非最新设备超过 3 台时显示 `+N 更多`。
- V0.24 搜索/筛选仍可用。
- README 当前版本更新为 V0.25，并说明 V0.25 是只读摘要，不新增 API、不写 metadata、不执行同步/恢复/NAS 操作。
