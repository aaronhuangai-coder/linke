# V0.26 Version Consistency Sort Controls Design

## Goal

V0.26 adds read-only sort controls to the Web Console backup version consistency panel. Operators can reorder already loaded consistency groups without refetching snapshots, writing metadata, or triggering backup, sync, restore, deletion, NAS connection, NAS app invocation, or remote transfer.

## Scope

- Add one sort `<select>` inside the existing version consistency control bar.
- Keep the default order as current risk-first order.
- Sort only the filtered in-memory group list.
- Preserve V0.24 status/search controls and V0.25 staleness summaries.
- Update README version and test coverage documentation.

## Sort Modes

- `risk`: default current order from `buildBackupVersionConsistency()`; drifted, single-device, synced, then latest time and name.
- `max-drift`: largest `maxTimeDriftMs` first.
- `stale-count`: largest `staleCount` first.
- `latest`: newest `latestCreatedAt` first.
- `name`: alphabetical `jobName`, then `sourcePath`.

Invalid or missing sort values fall back to `risk`.

## Safety Boundary

- No new API.
- No metadata writes.
- No backup trigger.
- No sync execution.
- No restore execution.
- No snapshot deletion.
- No NAS connection.
- No NAS app invocation.
- No remote file transfer.

## Acceptance Criteria

- HTML exposes `data-testid="version-consistency-sort"`.
- Sorting changes list order without refetching `/api/devices/:deviceId/snapshots`.
- `filterVersionConsistencyGroups()` supports `controls.sort` without mutating the original group array.
- README current version is V0.26 and documents the sort controls and safety boundary.
- Target tests, full tests, `git diff --check`, and HTTP smoke pass before completion claim.
