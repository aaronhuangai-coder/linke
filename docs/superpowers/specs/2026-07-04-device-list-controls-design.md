# Linke V0.16 Device List Controls Design

## Goal

V0.16 strengthens the Web Console device management surface by adding read-only search, status filtering, sort controls, and a filtered result summary to the existing device list.

## Scope

- Add controls to the existing `devices-panel`.
- Filter devices by search text across `hostname`, `deviceId`, and `ipAddress`.
- Filter by status: all, online, offline, unknown.
- Sort by name, IP address, last heartbeat, or snapshot count.
- Preserve the current selected device detail when filters hide that device.
- Keep all changes client-side. Do not change the `/api/devices` response shape.

## Out Of Scope

- No real backup execution.
- No NAS connection.
- No remote file transfer.
- No snapshot deletion.
- No production authentication or authorization.
- No metadata writes caused by the controls.

## User Experience

The device panel gets a compact toolbar above the list:

- A search input with `data-testid="device-search"`.
- A status select with `data-testid="device-status-filter"`.
- A sort select with `data-testid="device-sort"`.
- A result count with `data-testid="device-filter-count"`.

The list updates immediately when a control changes. Empty filtered results show a placeholder that explains there is no matching device. The fleet summary remains based on all loaded devices so it continues to describe the full fleet, while the result count describes the filtered list.

## Architecture

The feature is implemented in `src/web/app.js` as pure helper functions plus small DOM bindings inside `initConsole`.

- `normalizeDeviceStatus(status)` normalizes missing statuses to `unknown`.
- `matchesDeviceSearch(device, query)` checks hostname, device ID, and IP address.
- `compareDevicesForSort(a, b, sortKey)` handles stable deterministic ordering.
- `applyDeviceListControls(devices, controls)` returns the derived visible list.

`initConsole` stores the current control state, applies it after every `/api/devices` refresh, and re-renders only the visible list.

## Data Flow

1. `/api/devices` returns the complete device array.
2. The array is cached in `cachedDevices`.
3. Control state is read from the toolbar.
4. `applyDeviceListControls(cachedDevices, controls)` returns the visible devices.
5. `renderDevices(visibleDevices)` updates the list.
6. Selecting a visible device still loads snapshots and retention dry-run data exactly as before.

## Error Handling

- If `/api/devices` fails, the existing event-log error behavior remains unchanged.
- Invalid or missing status values are treated as `unknown`.
- Invalid sort keys fall back to name sorting.
- Missing hostname, device ID, IP address, heartbeat, or snapshot count never throws.

## Safety Boundary

The feature is read-only:

- It does not add API routes.
- It does not call write endpoints.
- It does not persist filter state.
- It does not start backups, deletes, restore operations, NAS app calls, or remote transfer.

## Runtime Resilience

- Normal state: the console loads `/api/devices`, shows full-fleet totals, and shows a derived visible list from the current controls.
- Recovery anchor: if controls are empty or invalid, the visible list falls back to all devices sorted by name.
- Bounded failure: malformed device fields are normalized locally instead of breaking the page.
- Detection signal: tests cover helper output, required DOM hooks, and no new real execution wording.
- Highest-risk failure path: filtering to zero visible devices must render a harmless placeholder and must not clear the selected detail state.

## Test Plan

- Unit tests for `applyDeviceListControls`.
- HTML contract tests for the new toolbar hooks.
- Source contract tests proving `app.js` references the new controls.
- Full `npm test`.
- Optional local Web smoke after implementation to inspect the rendered console.
