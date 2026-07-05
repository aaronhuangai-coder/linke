# Linke V0.34 Device Management State Filter and Count Design

## Summary

V0.34 introduces a read-only "Management State Filter" (管理态筛选) and dynamic device counts in the Web Console device panel. This feature allows administrators to filter devices by their derived management states (`visible`, `missing-ip`, `offline-retained`, and `unknown`) in addition to existing searches and status filters.

This feature is strictly a UI-only derived filter. It operates within a strict read-only boundary: no new backend APIs, no metadata writes, no remote commands, no NAS connections, and no edit/fix/bulk actions.

## Goals

- Implement `getDeviceManagementStateKey(device)` pure function in `src/web/app.js` to derive a machine-readable key (`visible`, `missing-ip`, `offline-retained`, or `unknown`) for each device.
- Add a dropdown filter in the Web Console device list with `data-testid="device-management-filter"` containing option values `all`, `visible`, `missing-ip`, `offline-retained`, and `unknown`.
- Extend `applyDeviceListControls` to support `controls.management` values (`all`, `visible`, `missing-ip`, `offline-retained`, `unknown`).
- Composing filters: Search query, status filter, and management state filter must use **AND semantics** (i.e. a device must match all selected criteria to be visible).
- Dynamic device list rendering and `device-filter-count` update locally without refetching `/api/devices` from the server.

## Non-Goals / Read-Only Boundaries

- **No new API**: Do not add any new backend endpoints or query parameters. All filtering is done client-side.
- **No metadata write**: Do not write, modify, or delete any device metadata, configuration, or status on the server.
- **No remote command**: Do not execute any shell commands, scripts, ping, wake, shutdown, or remote diagnostics.
- **No NAS connection**: Do not initiate or test connection to any NAS storage target.
- **No edit/fix/bulk actions**: No user interface buttons or backend workflows to edit IP addresses, resolve missing IPs, or perform bulk management state overrides. The view is completely derived and read-only.

## Data Rules and Filter Semantics

The `getDeviceManagementStateKey(device)` function maps a device object to one of four status keys:

| Device Status | IP Address | Management State Key | Description |
|---|---|---|---|
| `online` | Real IP after trim/lowercase normalization | `visible` | Device is active and has a usable IP value. |
| `online` | Missing, empty, whitespace-only, `null`, `undefined`, or normalizes to `'unknown'` | `missing-ip` | Device is active but lacks a valid network address. |
| `offline` | Any value | `offline-retained` | Device is inactive but its registration is retained. |
| `unknown`, `null`, `""`, or missing | Any value | `unknown` | Device state is incomplete or unrecognized. |

### Filter Composition (AND Semantics)
When applying controls to the device list, multiple criteria are combined using **AND semantics**:
$$\text{visible} = \text{matchesSearch}(device, query) \land \text{matchesStatus}(device, status) \land \text{matchesManagement}(device, management)$$

Where:
- `matchesSearch`: matches search term in hostname, device ID, or IP.
- `matchesStatus`: matches device status filter (`all`, `online`, `offline`, `unknown`).
- `matchesManagement`: matches device management state filter (`all`, `visible`, `missing-ip`, `offline-retained`, `unknown`).

## Web Console UI Changes

### 1. Management Filter Dropdown
In the device list control panel, a new drop-down select element is added:
```html
<select data-testid="device-management-filter" id="device-management-filter">
  <option value="all">所有管理状态</option>
  <option value="visible">在线可见</option>
  <option value="missing-ip">在线缺 IP</option>
  <option value="offline-retained">离线保留</option>
  <option value="unknown">未知待确认</option>
</select>
```

### 2. Device Count Display
The device list count element `data-testid="device-filter-count"` (e.g. `1 / 3`) will automatically update when the management state filter is changed.

## DOM Hooks

Add or expect the following hooks for test automation:
- `device-management-filter` (the select element)
- `device-filter-count` (the count element showing `X / Y`)

## Testing Strategy

- **Pure Function Tests**: Verify that `getDeviceManagementStateKey(device)` correctly maps all status/IP combinations to `visible`, `missing-ip`, `offline-retained`, and `unknown`.
- **Apply controls Tests**: Verify `applyDeviceListControls` correctly filters and composes filters without mutating original input.
- **Source Contract Tests**: Expect `app.js` and `index.html` to reference `device-management-filter` and options.
- **DOM Tests**: Simulate user changing the dropdown, assert device list updates and `device-filter-count` changes without refetching `/api/devices`.
