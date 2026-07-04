# Linke V0.10 Restore Dry-Run Design

## Goal

Add a read-only restore preview for a snapshot. The preview tells the user what a restore would write to a target directory, without copying files, creating directories, overwriting files, or modifying metadata.

## Scope

- API: `GET /api/devices/:deviceId/snapshots/:snapshotId/restore-dry-run?targetPath=...`
- CLI: `node src/agent.js restore-dry-run --server ... --device ... --snapshot ... --target ...`
- Web Console: after selecting a snapshot, show a restore preview panel with target path, total files, would-create count, would-overwrite count, and per-file actions.
- README: update the project version to V0.10 and document the new dry-run boundary.

## Output Contract

The dry-run result must include:

- `mode: "dry-run"`
- `wouldWrite: false`
- `deviceId`
- `snapshotId`
- `targetPath`
- `summary.totalFiles`
- `summary.wouldCreateCount`
- `summary.wouldOverwriteCount`
- `files[]`

Each `files[]` item must include:

- `sourceRelativePath`
- `targetPath`
- `action: "would-create" | "would-overwrite"`

## Safety Boundary

- The dry-run must not call `copyFile`, `mkdir`, `writeFile`, `rename`, or any restore write path.
- The dry-run must not modify `manifest.json`, `snapshots.json`, `device.json`, or the target directory.
- `snapshotId` must keep the existing path traversal rejection behavior.
- `targetPath` is required and is used only for path calculation and existing-file checks.
- The Web Console must not add a real restore execution button in V0.10.

## Resilience

- Normal state: a valid request returns a deterministic JSON plan and leaves source snapshot metadata plus target directory unchanged.
- Recovery anchor: no state transition is performed, so failed dry-run requests return HTTP errors without cleanup work.
- Observable signals: HTTP status, JSON error messages, and tests that hash/list target directory contents before and after the call.

## Acceptance

- New API, CLI, pure function, README, and Web Console contract tests exist.
- Tests prove the dry-run does not alter the target directory or snapshot metadata.
- `npm test` passes.
- Local server on port `3003` serves the V0.10 UI and route.
- AGY may provide front-end/test suggestions, but is not a hard final gate.
- zai returns an auxiliary `ACCEPT` or `REJECT`; Codex PM remains final verifier.
