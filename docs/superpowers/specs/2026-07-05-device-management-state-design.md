# Linke V0.33 Device/IP Management State Design

## Summary

V0.33 introduces a read-only "Unified Management State" (统一管理态) for devices and IP addresses in the Web Console. The management state classifies each device based on its status and IP address presence to help administrators determine device visibility and configuration readiness.

This feature is strictly a UI-only derived state. It operates within a strict read-only boundary: no new backend APIs, no metadata writes, no remote commands, no NAS connections, and no edit/fix/bulk actions.

## Goals

- Implement `getDeviceManagementState(device)` pure function in `src/web/app.js` to derive management state from status and IP address.
- Support 4 management states:
  - **在线可见** (Online Visible): status is `online` and normalized `ipAddress` is a valid/real IP.
  - **在线缺 IP** (Online Missing IP): status is `online` but `ipAddress` is missing, empty, whitespace-only, null, undefined, or normalizes to `'unknown'`.
  - **离线保留** (Offline Retained): status is `offline`.
  - **未知待确认** (Unknown to Confirm): status is `unknown`, missing, null, or the device object itself is null/empty.
- Render the management state on each device in the device list using `data-testid="device-management-state"`.
- Render the management state in the selected device detail panel using `data-testid="device-detail-management-state"`.
- Provide comprehensive test coverage for pure functions, DOM rendering, and source contracts.

## Non-Goals / Read-Only Boundaries

- **No new API**: Do not add any new backend endpoints or query parameters.
- **No metadata write**: Do not write, modify, or delete any device metadata, configuration, or status on the server.
- **No remote command**: Do not execute any shell commands, scripts, ping, wake, shutdown, or remote diagnostics.
- **No NAS connection**: Do not initiate or test connection to any NAS storage target.
- **No edit/fix/bulk actions**: No user interface buttons or backend workflows to edit IP addresses, resolve missing IPs, or perform bulk management state overrides. The view is completely derived and read-only.

## Data Rules and State Mapping

The `getDeviceManagementState(device)` function maps a device object to one of four status strings:

| Device Status | IP Address | Management State | Description |
|---|---|---|---|
| `online` | Real IP after trim/lowercase normalization (e.g., `192.168.1.100`) | **在线可见** | Device is active and has a usable IP value. |
| `online` | Missing, empty, whitespace-only, `null`, `undefined`, or normalizes to `'unknown'` | **在线缺 IP** | Device is active but lacks a valid network address. |
| `offline` | Any value | **离线保留** | Device is inactive but its registration is retained. |
| `unknown`, `null`, `""`, or missing | Any value | **未知待确认** | Device state is incomplete or unrecognized. |

## Web Console UI Changes

### 1. Device List Item
In the device list, each `device-item` will display the derived management state using a span or similar element:
```html
<span data-testid="device-management-state">在线可见</span>
```

### 2. Device Detail Panel
In the selected device detail panel (`device-detail-content`), a new detail row will display the management state:
```html
<div class="device-detail-row">
  <dt>管理状态</dt>
  <dd data-testid="device-detail-management-state">在线可见</dd>
</div>
```

## DOM Hooks

Add or expect the following hooks for test automation:
- `device-management-state` (inside list item)
- `device-detail-management-state` (inside selected device detail panel)

## Testing Strategy

- **Pure Function Tests**: Verify that `getDeviceManagementState(device)` correctly maps all status/IP combinations, handling null/undefined, whitespace-only, and uppercase/space-padded `unknown` inputs gracefully.
- **Source Contract Tests**: Expect `app.js` to reference the `device-management-state` and `device-detail-management-state` hooks.
- **DOM Tests**: Render mock devices using `initConsole` and verify that the correct management state is rendered in the list item text content and the selected device detail view.
- **Documentation Tests**: Verify that README has V0.33 titles, badges, milestones, feature listings, safety, and testing sections.
