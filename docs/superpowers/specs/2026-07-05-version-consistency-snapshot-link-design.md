# Linke V0.23 版本一致性 snapshot 联动设计

## 目标

V0.23 在 V0.22 “备份版本一致性”面板上增加只读 drill-down：点击某个任务组下的设备版本行后，Web Console 复用现有快照清单详情和恢复预检 dry-run 面板，加载该设备对应的最新 snapshot。

该功能用于让用户从“版本不一致”快速跳到具体 snapshot 内容和恢复影响预览，仍不执行同步、恢复、删除、NAS 连接或远程传输。

## 范围

- 在版本一致性任务组内，每个设备版本行携带 `deviceId`、`latestSnapshotId` 和版本状态。
- 点击设备版本行后：
  - 设置当前选中设备。
  - 渲染设备详情。
  - 刷新设备列表选中态。
  - 读取该设备 snapshots。
  - 读取该设备 retention dry-run。
  - 读取该 snapshot manifest。
  - 读取该 snapshot restore-dry-run。
- 使用现有 API，不新增后端路由。

## 非目标

- 不新增同步按钮。
- 不执行真实同步。
- 不执行真实恢复。
- 不删除快照。
- 不写入 metadata。
- 不连接 NAS。
- 不调用 NAS app。
- 不执行远程文件传输。
- 不解决冲突，也不自动选择“正确版本”。

## DOM Hook

动态设备版本行继续使用：

- `data-testid="version-consistency-device"`

新增动态属性：

- `data-device-id`
- `data-snapshot-id`
- `data-version-state`

所有动态内容继续使用 `textContent` 渲染。

## 交互规则

点击设备版本行时，只要 `deviceId` 和 `latestSnapshotId` 都存在，就调用现有读取流程：

- `/api/devices/:deviceId/snapshots`
- `/api/devices/:deviceId/retention-dry-run`
- `/api/devices/:deviceId/snapshots/:snapshotId/manifest`
- `/api/devices/:deviceId/snapshots/:snapshotId/restore-dry-run`

如果缺少 `latestSnapshotId`，点击不做任何操作。

## 安全边界

V0.23 仍是前端只读联动：

- 不新增 API。
- 不写入 metadata。
- 不保存联动状态。
- 不触发备份。
- 不执行同步。
- 不执行恢复。
- 不删除快照。
- 不连接 NAS。
- 不调用 NAS app。
- 不执行远程文件传输。

## 验收标准

- 点击版本一致性设备行会加载对应设备的 snapshot manifest。
- 点击版本一致性设备行会加载对应 snapshot 的 restore-dry-run。
- 点击版本一致性设备行会刷新该设备 snapshots 和 retention dry-run。
- 设备详情会切到被点击的设备。
- 版本一致性面板仍无按钮，安全文案仍声明只读、不写 metadata、不执行同步/恢复、不连接 NAS。
- README 当前版本更新为 V0.23，并说明 V0.23 只是只读联动，不是同步能力。
