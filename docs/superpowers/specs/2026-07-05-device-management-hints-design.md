# Linke V0.38 Device Management Hints Design

## Summary

V0.38 adds read-only management-state decision hints to the Web Console. The existing management state label remains the short state name. The new hint explains why the device is in that state and what operator attention is implied.

## Scope

- Add `getDeviceManagementHint(device)` as a pure exported helper.
- Render `device-management-hint` inside each device list item.
- Render `device-detail-management-hint` inside the selected device detail panel.
- Update README, tests, and implementation plan docs.

## State Mapping

| Management key | Label | Hint |
|---|---|---|
| `visible` | 在线可见 | 在线且 IP 可用，可纳入统一管理 |
| `missing-ip` | 在线缺 IP | 设备在线但缺少可用 IP，需补充 IP 信息 |
| `offline-retained` | 离线保留 | 设备离线，保留历史记录和备份上下文 |
| `unknown` | 未知待确认 | 状态未知，需确认设备心跳 |

`getDeviceManagementHint(device)` must call `getDeviceManagementStateKey(device)` and map the key to text. This prevents duplicated management-state classification branches.

## Safety Boundaries

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No `/api/devices` refetch on local rendering.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.
- No persistent operator action or remediation workflow.

## Resilience

- Normal state: loaded device rows and selected device detail show both the management label and hint.
- Recovery anchor: if device loading fails, existing error handling still clears derived management summary and logs the load failure; hints are not rendered from stale data.
- Bounded failure: unknown or null devices map to the existing `unknown` key and the unknown hint.
- Detection: pure tests and DOM tests verify hint mapping, list rendering, detail rendering, and non-mutation.

## Qwen Adversarial Findings And Decisions

- Hint text may overlap with the existing label: accepted because labels are compact state names and hints are explanatory.
- Avoid duplicated classification logic: accepted by requiring `getDeviceManagementHint` to call `getDeviceManagementStateKey`.
- Text must match tests exactly: accepted and covered by pure and DOM tests.
