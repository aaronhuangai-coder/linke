# Linke V0.15 Device Detail Panel Design

## Summary

V0.15 adds a read-only device detail panel to the Web Console. The panel reuses the existing `GET /api/devices` response and shows the selected device's identity, network address, status, heartbeat, backup, and snapshot summary.

This is a UI-only management improvement. It does not add a backend route, does not change the device storage format, does not write device metadata, and does not perform any remote management action.

## Goals

- Add a Web Console device detail panel.
- Show the selected device's:
  - `deviceId`
  - `hostname`
  - `ipAddress`
  - `status`
  - `lastHeartbeatAt`
  - `lastBackupAt`
  - `snapshotCount`
- Reuse the existing `/api/devices` payload.
- Update details when the user selects a device from the device list.
- Render missing values with stable fallbacks.
- Update README to V0.15 and document the panel.
- Add focused Web Console contract and DOM tests.

## Non-Goals

- No new `/api/devices/:deviceId` endpoint.
- No device editing.
- No tags, notes, groups, ownership, or labels.
- No device metadata persistence changes.
- No authentication or permission model changes.
- No remote backup, remote command, wake, shutdown, ping, probe, or NAS action.
- No change to backup, restore, retention, NAS dry-run, or adapter behavior.

## Existing Data Contract

The existing `GET /api/devices` response already contains the fields needed by the panel. A typical device object is:

```json
{
  "deviceId": "my-macbook",
  "hostname": "MyMac",
  "ipAddress": "192.168.1.10",
  "lastHeartbeatAt": "2026-07-04T10:00:00.000Z",
  "lastBackupAt": "2026-07-04T10:30:00.000Z",
  "snapshotCount": 3,
  "status": "online"
}
```

No new storage fields are required.

## Web Console Behavior

The Web Console gets a new `device-detail-panel` section near the existing device list and snapshot panels.

Initial state:

- Shows a placeholder: `请选择一个设备`.
- Does not call any new API.

When a device is selected:

- The existing device selection flow still updates snapshots, retention plan, and selected styling.
- The new detail panel renders the selected device from the cached `/api/devices` list.
- Values are rendered with DOM nodes and `textContent`.

Fallbacks:

| Field | Fallback |
|---|---|
| `deviceId` | `unknown` |
| `hostname` | `unknown` |
| `ipAddress` | `unknown` |
| `status` | `unknown` |
| `lastHeartbeatAt` | `无心跳` |
| `lastBackupAt` | `无备份` |
| `snapshotCount` | `0` |

Invalid dates must not render `Invalid Date`.

## DOM Hooks

Add stable hooks for tests and future automation:

- `device-detail-panel`
- `device-detail-placeholder`
- `device-detail-content`
- `device-detail-device-id`
- `device-detail-hostname`
- `device-detail-ip`
- `device-detail-status`
- `device-detail-heartbeat`
- `device-detail-backup`
- `device-detail-snapshots`

## Data Flow

1. `fetchDevices()` calls existing `GET /api/devices`.
2. The response is stored in the existing `cachedDevices`.
3. `renderDevices(devices)` renders the device list as it does today.
4. Clicking a device sets `selectedDeviceId`.
5. The click handler calls a new local render helper, for example `renderDeviceDetail(device)`.
6. The helper updates only the detail panel. It does not fetch, persist, or mutate device data.

If a refresh later removes the selected device from the device list, the detail panel should return to the placeholder state.

## Error Handling

- If `/api/devices` fails, existing event log behavior remains unchanged.
- The detail panel should remain in placeholder state when devices fail to load.
- Missing or malformed device fields should use fallbacks.
- Rendering must not throw if `device` is `null` or `undefined`.

## Testing

Add or update tests for:

- README mentions V0.15 and the device detail panel.
- HTML contains `device-detail-panel` and required `data-testid` hooks.
- Initial detail panel shows the placeholder.
- Clicking a device renders `deviceId`, `hostname`, `ipAddress`, `status`, `lastHeartbeatAt`, `lastBackupAt`, and `snapshotCount`.
- Missing fields render fallbacks and do not show `undefined`, `null`, or `Invalid Date`.
- Existing device selection still fetches snapshots and retention dry-run.
- Rendering uses DOM nodes and `textContent`, with no user-controlled `innerHTML`.

Verification command:

```bash
npm test
```

## Resilience Design

Normal state:

- Device list loads from `/api/devices`.
- Selecting a device renders detail data from cached device objects.
- Existing snapshot and retention panel behavior remains unchanged.

Recovery anchor:

- The feature is stateless and read-only. Refreshing `/api/devices` restores the detail panel from server state.

Bounded failure:

- If devices fail to load, no detail content is rendered.
- If selected device data is incomplete, fallbacks are shown.
- If a selected device disappears after refresh, the placeholder is shown.

Observability:

- Existing event log continues to report device loading success or failure.
- Tests verify the highest-risk UI path: selecting a device with missing fields must not render broken dates or undefined values.

## Acceptance Criteria

- `npm test` passes.
- Web Console displays a read-only device detail panel.
- Selecting a device updates the panel without adding a new API call.
- No storage format changes are made.
- No real remote management action is added.
- README identifies V0.15 as the current version and documents the new panel.

## PM Decisions

Accepted:

- V0.15 is UI-only.
- Reuse `GET /api/devices`.
- Keep the panel read-only and focused on unified device visibility.

Rejected:

- No device detail API in V0.15.
- No editable tags, notes, groups, or metadata.
- No remote action buttons.
