# Linke V0.12 Backup Preflight Web Panel Design

## Goal

Add a read-only Web Console panel for `backup-preflight-dry-run` so a user can preview backup file selection from the browser without creating snapshots, copying files, or writing metadata.

## Scope

V0.12 extends the V0.11 API/CLI dry-run feature into the Web Console. It does not add real backup execution from the browser and does not change the backup storage format.

In scope:

- A Web Console panel for backup preflight dry-run.
- Inputs for `sourcePath` and newline-separated or comma-separated `excludePatterns`.
- A dry-run trigger button that calls the existing `GET /api/backup-preflight-dry-run` endpoint.
- Display of `summary.totalFiles`, `summary.includedCount`, and `summary.excludedCount`.
- Display of included relative paths.
- Display of excluded relative paths and each `matchedPattern`.
- Frontend validation for missing `sourcePath`.
- README update from V0.11 to V0.12.
- Tests for HTML hooks, frontend API call behavior, result rendering, and README coverage.

Out of scope:

- No real backup execution button.
- No snapshot creation from the Web Console.
- No file copy, restore, delete, or metadata write from this panel.
- No production-grade `sourcePath` sandboxing in V0.12.
- No authentication or permission model changes.

## User Experience

The Web Console gets a new panel near the existing restore, diff, and retention dry-run panels. The panel is a work surface, not a marketing section.

Controls:

- `sourcePath` text input, initially empty.
- `excludePatterns` textarea, initially populated with a small example such as `*.tmp` and `node_modules`.
- A button labeled for dry-run preview only.

Results:

- Before running: show a placeholder telling the user to enter a source path.
- If `sourcePath` is empty: show a local validation error and do not call the API.
- On success: show total, included, and excluded counts.
- Show included paths as plain text list items.
- Show excluded paths as plain text list items with the matched pattern.
- On API error: show a concise error message from the response or status code.

Safety copy:

- The panel must explicitly state that it is dry-run only.
- The panel must state that it does not create snapshots.
- The panel must state that it does not copy files.
- The panel must state that it does not write metadata.

## API Contract

The panel reuses the V0.11 endpoint:

```http
GET /api/backup-preflight-dry-run?sourcePath=<absolute-or-relative-path>&exclude=<pattern>&exclude=<pattern>
```

Expected success body:

```json
{
  "mode": "dry-run",
  "wouldWrite": false,
  "sourcePath": "/example/source",
  "excludePatterns": ["*.tmp", "node_modules"],
  "summary": {
    "totalFiles": 3,
    "includedCount": 1,
    "excludedCount": 2
  },
  "included": ["keep.txt"],
  "excluded": [
    { "sourceRelativePath": "skip.tmp", "matchedPattern": "*.tmp" },
    { "sourceRelativePath": "node_modules/pkg.js", "matchedPattern": "node_modules" }
  ]
}
```

The frontend must preserve repeated `exclude` query parameters. It must not encode multiple patterns into a single comma-joined `exclude` parameter.

## Parsing Rules

`excludePatterns` in the textarea are parsed by the frontend:

- Split on newline or comma.
- Trim whitespace.
- Drop empty entries.
- Preserve order.
- Add each pattern to `URLSearchParams` as a repeated `exclude` parameter.

Examples:

```text
*.tmp
node_modules
```

and:

```text
*.tmp, node_modules
```

both produce:

```text
exclude=*.tmp&exclude=node_modules
```

## Implementation Boundaries

Files expected to change:

- `src/web/index.html`: add backup preflight panel markup and stable `data-testid` hooks.
- `src/web/app.js`: add parsing, request, validation, and rendering logic.
- `test/web-console.test.js`: add HTML contract and DOM behavior tests.
- `test/readme.test.js`: add V0.12 README assertions.
- `README.md`: update version table, feature list, Web Console docs, safety boundaries, and test coverage text.

No changes are required to:

- `src/backup-preflight.js`
- `src/server.js`
- `src/agent.js`

Those files already implement the V0.11 API/CLI contract.

## Required Test Hooks

HTML hooks:

- `data-testid="backup-preflight-panel"`
- `data-testid="backup-preflight-source"`
- `data-testid="backup-preflight-excludes"`
- `data-testid="backup-preflight-run"`
- `data-testid="backup-preflight-total-count"`
- `data-testid="backup-preflight-included-count"`
- `data-testid="backup-preflight-excluded-count"`
- `data-testid="backup-preflight-result"`
- `data-testid="backup-preflight-safety-note"`

The existing V0.11 command hint hook may remain:

- `data-testid="backup-preflight-dry-run-command"`

## Error Handling

Frontend validation:

- Empty `sourcePath` shows an error in `backup-preflight-result`.
- Empty `sourcePath` must not call `fetch`.

API errors:

- Non-2xx responses show a concise error in `backup-preflight-result`.
- If the JSON body has an `error` field, display that error.
- If no JSON error is available, display `HTTP <status>`.

Rendering safety:

- Included and excluded paths must be rendered with text nodes or `textContent`.
- Do not inject API strings with `innerHTML`.

## Testing

Use the existing project standard:

```bash
npm test
```

TDD expectations:

- First add failing tests for the HTML hooks and README V0.12 text.
- Add DOM tests that call `initConsole` with a fake `fetchImpl`.
- Verify empty `sourcePath` blocks fetch.
- Verify newline and comma exclude parsing creates repeated `exclude` parameters.
- Verify success rendering shows counts, included paths, excluded paths, and matched patterns.
- Verify API error rendering shows a readable error.

## Acceptance Criteria

V0.12 is acceptable when:

- `npm test` passes.
- The Web Console has a read-only backup preflight dry-run panel.
- Running the panel calls the existing V0.11 endpoint with repeated `exclude` query parameters.
- Results render included/excluded paths and counts.
- Empty `sourcePath` is blocked in the browser before network request.
- README identifies the project as V0.12 and documents the new Web panel.
- Documentation still states the prototype has no production-grade auth or source path sandboxing.
- There is no browser control that performs a real backup.

