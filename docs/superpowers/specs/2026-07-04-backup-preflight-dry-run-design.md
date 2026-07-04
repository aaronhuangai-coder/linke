# Linke V0.11 Backup Preflight Dry-Run Design

## Goal

Add a read-only backup preflight preview. Given a `sourcePath` and `excludePatterns`, Linke reports which relative file paths would be included or excluded by a future backup, without creating a snapshot, copying files, creating directories, or writing metadata.

## Scope

- API: `GET /api/backup-preflight-dry-run?sourcePath=...&exclude=...`
- CLI: `node src/agent.js backup-preflight-dry-run --source ... --exclude "*.tmp" --exclude node_modules`
- Web Console: document the preflight dry-run command in the existing Agent config panel. V0.11 does not add a full interactive preflight form.
- README: update the project version to V0.11 and document the new dry-run boundary.

## Output Contract

The dry-run result must include:

- `mode: "dry-run"`
- `wouldWrite: false`
- `sourcePath`
- `excludePatterns`
- `summary.totalFiles`
- `summary.includedCount`
- `summary.excludedCount`
- `included[]`
- `excluded[]`

Each `excluded[]` item must include:

- `sourceRelativePath`
- `matchedPattern`

## Safety Boundary

- The dry-run must not call `copyFile`, `mkdir`, `writeFile`, `rename`, or any backup write path.
- The dry-run must not create a snapshot directory.
- The dry-run must not modify `device.json`, `snapshots.json`, `manifest.json`, or any repository metadata.
- `sourcePath` must exist; missing paths return a 400 response.
- The scan is local and read-only. V0.11 does not provide production-grade source path sandboxing.

## Resilience

- Normal state: a valid request returns a deterministic JSON plan and leaves the data repository unchanged.
- Recovery anchor: no state transition is performed, so failed dry-run requests return HTTP errors without cleanup work.
- Observable signals: HTTP status, JSON error messages, and tests that hash/list repository contents before and after the call.

## Acceptance

- New API, CLI, pure function, README, and Web Console contract tests exist.
- Tests prove preflight does not create snapshots or alter repository metadata.
- `npm test` passes.
- Local server on port `3003` serves the V0.11 README/UI hints and route.
- AGY may provide front-end/test suggestions, but is not a hard final gate.
- zai returns an auxiliary `ACCEPT` or `REJECT`; Codex PM remains final verifier.
