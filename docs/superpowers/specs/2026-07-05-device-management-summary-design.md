# Linke V0.35 Device Management State Summary & Quick Switching Design

## Summary

V0.35 introduces a read-only "Management State Bucket Summary" (管理态分桶统计) and "Quick Switching" (快速切换) capability in the Web Console. This feature displays aggregate counts of devices grouped by their derived management states (all, visible, missing-ip, offline-retained, and unknown) and allows administrators to quickly switch the device list filter by clicking on these summary buckets.

This feature is strictly a UI-only derived state and interaction logic. It operates within a strict read-only boundary: no new backend APIs, no metadata writes, no remote commands, no NAS connections, and no edit/fix/bulk actions.

## Goals

- Implement `buildDeviceManagementSummary(devices)` pure function in `src/web/app.js` to compute summary counts `{ all, visible, missingIp, offlineRetained, unknown }` from a device list.
- Support empty or non-array inputs by returning all counts as 0, without mutating the original input array.
- Use `getDeviceManagementStateKey(device)` semantics (from V0.34) to categorize devices, handling whitespace and UNKNOWN IP cases correctly.
- Add a summary panel in the Web Console device list container with `data-testid="device-management-summary"` and bucket controls:
  - **All**: `data-testid="device-management-summary-all"`
  - **Online Visible (在线可见)**: `data-testid="device-management-summary-visible"`
  - **Online Missing IP (在线缺 IP)**: `data-testid="device-management-summary-missing-ip"`
  - **Offline Retained (离线保留)**: `data-testid="device-management-summary-offline-retained"`
  - **Unknown (未知待确认)**: `data-testid="device-management-summary-unknown"`
- Provide "Quick Switching" interaction: clicking a summary bucket control automatically updates the select value of the existing `device-management-filter` element and triggers the filter update logic.
- Reuse the existing `device-management-filter` AND semantics (e.g. composing with query and status filters) without refetching `/api/devices` from the server.

## Non-Goals / Read-Only Boundaries

- **No new API**: Do not add any new backend endpoints or query parameters. All aggregation and filtering are done client-side.
- **No metadata write**: Do not write, modify, or delete any device metadata, configuration, or status on the server.
- **No remote command**: Do not execute any shell commands, scripts, ping, wake, shutdown, or remote diagnostics.
- **No NAS connection**: Do not initiate or test connection to any NAS storage target.
- **No edit/fix/bulk actions**: No user interface buttons or backend workflows to edit IP addresses, resolve missing IPs, or perform bulk management state overrides. The view is completely derived and read-only.

## Data Rules and State Mapping

The `buildDeviceManagementSummary(devices)` function processes an array of devices. For each device, it determines the management state key using `getDeviceManagementStateKey(device)`:

- `visible`: status is `online` and `ipAddress` normalizes to a valid IP.
- `missing-ip`: status is `online` and `ipAddress` normalizes to empty/unknown/whitespace/UNKNOWN.
- `offline-retained`: status is `offline`.
- `unknown`: any other status or null/undefined device.

The function returns a summary object:
```json
{
  "all": 4,
  "visible": 1,
  "missingIp": 1,
  "offlineRetained": 1,
  "unknown": 1
}
```

If the input is null, undefined, or not an array, it returns all zeros:
```json
{
  "all": 0,
  "visible": 0,
  "missingIp": 0,
  "offlineRetained": 0,
  "unknown": 0
}
```

## Web Console UI Changes

### 1. Bucket Summary Panel
A new container is added above or near the device list with bucket controls:
```html
<div data-testid="device-management-summary" class="device-management-summary">
  <div data-testid="device-management-summary-all" class="summary-bucket">全部: <span class="count">0</span></div>
  <div data-testid="device-management-summary-visible" class="summary-bucket">在线可见: <span class="count">0</span></div>
  <div data-testid="device-management-summary-missing-ip" class="summary-bucket">在线缺 IP: <span class="count">0</span></div>
  <div data-testid="device-management-summary-offline-retained" class="summary-bucket">离线保留: <span class="count">0</span></div>
  <div data-testid="device-management-summary-unknown" class="summary-bucket">未知待确认: <span class="count">0</span></div>
</div>
```

### 2. Interaction & Quick Switching
Clicking on `data-testid="device-management-summary-visible"` will:
1. Update `document.getElementById('device-management-filter').value` to `'visible'`.
2. Dispatch a change event or call the filter logic so the device list and `device-filter-count` update locally.
3. No additional fetch calls are made to `/api/devices`.

## DOM Hooks

Add or expect the following hooks for test automation:
- `device-management-summary` (the summary wrapper element)
- `device-management-summary-all` (all devices bucket control)
- `device-management-summary-visible` (visible devices bucket control)
- `device-management-summary-missing-ip` (missing-ip devices bucket control)
- `device-management-summary-offline-retained` (offline-retained devices bucket control)
- `device-management-summary-unknown` (unknown devices bucket control)

## Testing Strategy

- **Pure Function Tests**: Verify that `buildDeviceManagementSummary(devices)` returns all zeros for empty/non-array input, does not mutate input, and maps mixed device arrays accurately.
- **Source Contract Tests**: Expect `index.html` to contain `device-management-summary` and all bucket testids. Expect `app.js` to reference them and import/reference `buildDeviceManagementSummary`.
- **DOM Tests**: Load console with mock devices, assert counts render correctly in the summary buckets, simulate clicking a summary bucket control, and assert `device-management-filter` updates, list filters, count updates, and fetch count does not increase.
