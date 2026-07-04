# Linke V0.17 Backup Jobs Overview Design

## Summary

V0.17 adds a read-only Backup Jobs Overview panel to the Web Console. The panel derives backup-job visibility from the existing snapshot list for the selected device.

This is a frontend-only management view. It does not add a backend route, does not change storage, does not create or delete snapshots, does not connect to NAS, and does not execute backup jobs.

## Goals

- Add a Web Console backup jobs overview panel.
- Reuse the existing `GET /api/devices/:deviceId/snapshots` response.
- Group snapshots by `jobName` when present.
- Group snapshots without `jobName` by `sourcePath`.
- Show, for each inferred job:
  - job display name
  - source path
  - snapshot count
  - latest backup time
  - latest file count
- Show device-level summary counts:
  - inferred job count
  - total snapshots
  - latest backup time
- Render stable empty and error states.
- Update README to V0.17 and document the panel.
- Add focused pure-helper, HTML contract, source contract, DOM interaction, and README tests.

## Non-Goals

- No new backup job configuration model.
- No `/api/devices/:deviceId/backup-jobs` endpoint.
- No real backup execution button.
- No job editing, deletion, scheduling, retry, or remote execution.
- No NAS connection, NAS app invocation, remote transfer, credential handling, or config persistence.
- No changes to backup, restore, retention, snapshot diff, NAS dry-run, or adapter behavior.

## Existing Data Contract

The existing snapshot list endpoint already has enough metadata for an inferred overview:

```json
[
  {
    "snapshotId": "11111111-1111-1111-1111-111111111111",
    "createdAt": "2026-07-04T10:00:00.000Z",
    "hostname": "Aaron-Mac",
    "sourcePath": "/Users/ah/Documents",
    "fileCount": 42,
    "jobName": "documents"
  }
]
```

No new storage fields are required.

## Web Console Behavior

Initial state:

- Shows `请选择一个设备`.
- Summary counters show `0`, `0`, and `无备份`.
- No API call is added during initial load.

When a device is selected:

- The existing click path still calls `fetchSnapshots(deviceId)` and `fetchRetentionPlan(deviceId)`.
- `fetchSnapshots(deviceId)` continues to call only `GET /api/devices/:deviceId/snapshots`.
- The returned snapshots render the existing snapshot list and the new backup jobs overview.
- The panel title updates to the selected device ID.

When snapshots are empty:

- The overview shows `暂无备份任务`.
- Job count and snapshot count remain `0`.
- Latest backup shows `无备份`.

When snapshot loading fails:

- The overview shows `加载失败`.
- Counters reset to `0`, `0`, and `无备份`.
- Existing event-log error behavior remains unchanged.

## Grouping Rules

- If `snapshot.jobName` is a non-empty string, group by that job name.
- If `snapshot.jobName` is missing or empty, group by `sourcePath`.
- Empty or missing `sourcePath` uses `unknown`.
- Display name is `jobName` when present, otherwise `未命名任务`.
- Each group tracks:
  - `snapshotCount`
  - `sourcePath`
  - `latestSnapshotId`
  - `latestCreatedAt`
  - `latestFileCount`
- Groups sort by latest valid `createdAt` descending, then by display name.
- Invalid or missing dates sort last and must not render `Invalid Date`.

## DOM Hooks

Add stable hooks:

- `backup-jobs-panel`
- `backup-jobs-device-name`
- `backup-jobs-total-count`
- `backup-jobs-snapshot-count`
- `backup-jobs-last-backup`
- `backup-jobs-list`
- `backup-jobs-safety-note`
- `backup-job-item`
- `backup-job-name`
- `backup-job-source`
- `backup-job-meta`

## Data Flow

1. `fetchDevices()` loads devices as it does today.
2. User clicks a device.
3. Existing click handler sets `selectedDeviceId`, renders device detail, re-renders the filtered device list, calls `fetchSnapshots(deviceId)`, and calls `fetchRetentionPlan(deviceId)`.
4. `fetchSnapshots(deviceId)` fetches the existing snapshots endpoint.
5. `renderSnapshots(snapshots, deviceId)` renders the existing snapshot list.
6. `renderBackupJobsOverview(snapshots, deviceId)` derives and renders the new panel from the same response.
7. `renderSnapshotDiffControls(snapshots, deviceId)` keeps existing diff behavior.

## Safety Boundary

The feature is read-only:

- It does not add an API route.
- It does not call `POST /api/backups`.
- It does not call `POST /api/restore`.
- It does not call `POST /api/nas-dry-run`.
- It does not write metadata.
- It does not create, restore, delete, or transfer files.
- It does not connect to NAS or invoke NAS apps.
- It does not persist job state.

## Runtime Resilience

Normal state:

- Device selection loads snapshots.
- Existing snapshot list, snapshot diff controls, and backup job overview render from one successful response.
- The overview shows deterministic aggregate rows sorted by latest backup time.

Recovery anchor:

- The feature is stateless and derived. Refreshing snapshots restores the panel from server metadata.

Bounded failure:

- Missing `jobName`, missing `sourcePath`, invalid `createdAt`, and missing `fileCount` use stable fallbacks.
- Snapshot API failure resets only the derived overview and leaves no execution path.

Detection signal:

- Tests cover pure aggregation, required DOM hooks, source wiring, click rendering, and read-only safety wording.

Highest-risk failure path:

- A device with snapshots missing `jobName` must still show an inferred job grouped by `sourcePath`, with no `undefined`, `null`, or `Invalid Date` text.

## Acceptance Criteria

- `npm test` passes.
- `git diff --check` passes.
- Web Console displays the read-only Backup Jobs Overview panel.
- Selecting a device renders inferred jobs from the existing snapshot response.
- No new backend route is added.
- No write endpoint is called by the new panel.
- README identifies V0.17 as the current version and documents the panel.

## PM Decisions

Accepted:

- V0.17 is frontend-only.
- Reuse `GET /api/devices/:deviceId/snapshots`.
- Infer visible backup jobs from historical snapshots only.
- Treat configured but never-run jobs as out of scope for this version.

Rejected:

- No backend aggregation endpoint in V0.17.
- No persistent backup job registry in V0.17.
- No execute, edit, delete, retry, schedule, NAS, or remote-transfer controls.
