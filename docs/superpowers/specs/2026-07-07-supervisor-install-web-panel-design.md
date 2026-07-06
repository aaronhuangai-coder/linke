# Supervisor Install Web Panel Design

## Goal

V0.84 adds a Web Console `supervisor-install-dry-run-panel` that lets an operator paste Linke config JSON, run a manual dry-run request, and inspect the sanitized supervisor install plan already produced by `buildSupervisorInstallDryRunPlan(config)`.

The feature is still blocked and dry-run-only. It must not install, start, approve, roll back, uninstall, write files, call `launchctl`, read process lists, connect NAS, trigger backup/restore, execute remote commands, or claim Gold readiness.

## Current Context

V0.79-V0.83 built the backend supervisor install dry-run ladder:

- `agent.js supervisor-install-dry-run --config <file>`
- `buildSupervisorInstallDryRunPlan(config)`
- `readinessSummary.state:"blocked"`
- `installCommandPreview.state:"blocked"`
- `installCommandPreview.actions[].wouldRun:false`
- `installPreflight.state:"blocked"`
- `installApprovalManifest.state:"blocked"`
- `installApprovalManifest.approval.approved:false`
- `installApprovalManifest.rollback.available:false`

The Web Console already has safe, manual panels for hardening status, supervisor status, audit log, Gold readiness, backup preflight, and NAS dry-run. The closest existing pattern is `nas-dry-run-panel`: a textarea accepts JSON, a button sends a manual POST to a dry-run API, and the UI renders only a sanitized plan.

## Selected Approach

Add a manual POST `/api/supervisor-install-dry-run` endpoint and a matching Web Console panel.

The endpoint accepts a JSON Linke config body in memory, validates it with `validateConfig`, calls `buildSupervisorInstallDryRunPlan(validatedConfig)`, and returns the plan. It must not read a config path, invoke the CLI, write any output file, or mutate server state. Validation errors return `400` with sanitized messages. Unknown errors keep using existing server error redaction.

The UI mirrors the NAS dry-run panel shape:

- textarea: sample Linke config JSON
- button: `Supervisor install dry-run`
- summary stats: status, install state, approval state, rollback state
- result area: readiness blockers, command preview action summary, preflight checks, approval controls, and safety flags
- safety note: explicit manual-only dry-run boundaries

The panel must not auto-request on startup or poll. It only runs when the operator clicks the button.

## Alternatives Considered

### 1. Parse pasted CLI full JSON entirely in the browser

This avoids adding an API route, but forces operators to run the CLI outside the Web Console and paste a large generated plan. It is safe, but less useful for the unified management goal.

### 2. Add POST `/api/supervisor-install-dry-run` and render the returned plan

This is selected. It reuses existing pure dry-run plan code, keeps the control surface in the Web Console, and matches the existing NAS dry-run interaction. The main risk is that POST can look like a write action, so the spec requires explicit non-mutating tests, safety notes, and no addition to `API_WRITE_ROUTES` unless a later auth design decides dry-run POSTs should be write-token gated.

### 3. Add real install/approve/rollback buttons

Rejected. V0.84 is not an installer release. Real install, approval persistence, rollback, uninstall, and recovery supervisor behavior require separate design, auth, audit, rollback, and production-safety gates.

## Non-Goals

- Do not add `--install`, `--start`, `--load`, `--unload`, `--uninstall`, `--approve-install`, or any mutating supervisor command.
- Do not write config, metadata, LaunchAgents, plist files, reports, audit success records, approval records, rollback manifests, snapshots, device records, or NAS data.
- Do not read config files from the Web endpoint; the endpoint accepts only request-body JSON.
- Do not call the CLI from the server route.
- Do not call `launchctl`.
- Do not read process lists.
- Do not connect NAS or call NAS apps.
- Do not trigger backup, restore, remote copy, or remote command execution.
- Do not display config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, environment values, approval identity, approval timestamps, real home paths, real plist paths, executable paths, or runnable command arguments.
- Do not claim production supervisor, production hardening, real installer readiness, rollback readiness, approval completed, managed daemon lifecycle, or Gold readiness.

## API Design

Add route:

```text
POST /api/supervisor-install-dry-run
Content-Type: application/json
```

Request body is a Linke config JSON object. It is processed in this order:

1. Parse through existing `readBody(req)` with the existing body-size limit.
2. Validate through `validateConfig(body)`.
3. Build response through `buildSupervisorInstallDryRunPlan(config)`.
4. Return `200` and sanitized JSON.

Expected successful response fields:

- `status:"partial"`
- `command:"supervisor-install-dry-run"`
- `supervisor.state:"not_configured"`
- `supervisor.wouldInstall:false`
- `supervisor.wouldStart:false`
- `safety.launchctlCalled:false`
- `safety.processListRead:false`
- `safety.launchdFileWritten:false`
- `safety.metadataWritten:false`
- `safety.nasConnected:false`
- `safety.backupTriggered:false`
- `safety.restoreTriggered:false`
- `safety.remoteCommandExecuted:false`
- `readinessSummary.state:"blocked"`
- `installCommandPreview.state:"blocked"`
- `installCommandPreview.actions[].wouldRun:false`
- `installCommandPreview.actions[].wouldWrite:false`
- `installPreflight.state:"blocked"`
- `installApprovalManifest.state:"blocked"`
- `installApprovalManifest.approval.approved:false`
- `installApprovalManifest.rollback.available:false`

Validation failures return `400` and must not echo sensitive submitted values. Credential-like NAS fields remain rejected by `validateConfig` / `assertNoCredentials`.

The route is a dry-run preview and must not be added to `API_WRITE_ROUTES` in V0.84. This keeps the existing read-token behavior aligned with NAS dry-run. The safety note and tests must make clear that POST here is transport shape for a preview, not a write operation.

The implementation comment above the route must state that this POST is a dry-run preview and not a write operation. This prevents later write routes from copying the pattern without also entering `API_WRITE_ROUTES`.

## Web UI Design

Add a new section near the existing supervisor status and NAS dry-run panels:

```text
section[data-testid="supervisor-install-dry-run-panel"]
textarea[data-testid="supervisor-install-dry-run-config"]
button[data-testid="supervisor-install-dry-run-run"]
span[data-testid="supervisor-install-dry-run-status"]
span[data-testid="supervisor-install-dry-run-install-state"]
span[data-testid="supervisor-install-dry-run-approval-state"]
span[data-testid="supervisor-install-dry-run-rollback-state"]
div[data-testid="supervisor-install-dry-run-result"]
div[data-testid="supervisor-install-dry-run-safety-note"]
```

The textarea sample contains safe localhost-style sample values and no credentials. On click:

1. Empty textarea shows a local validation message and does not call the API.
2. Invalid JSON shows a local JSON parse error and does not call the API.
3. Valid JSON sends one POST to `/api/supervisor-install-dry-run`.
4. While loading, the result area shows a loading placeholder.
5. `200` renders only allowlisted plan fields.
6. Non-2xx renders a sanitized error message.

Rendered fields:

- top-level status and command
- supervisor state and would-install/would-start false summary
- readiness summary state and blocker codes
- command preview action count plus action IDs with `wouldRun:false` and `wouldWrite:false`
- preflight check IDs, statuses, and blocker codes
- approval manifest approval and rollback state
- approval manifest control IDs, statuses, and blocker codes
- safety flags proving no install/start/launchctl/process/NAS/backup/restore/remote command behavior happened

The renderer must not display raw `serverUrl`, `sourcePath`, NAS `endpoint`, `remotePath`, `credentialRef`, token-like values, config path, approval identity, timestamp, real plist path, executable path, or runnable command arguments. Existing full plan currently includes sanitized `configSummary` and non-runnable labels/program strings; the Web renderer must stay stricter and render only the allowlist above.

## Frontend Helpers

Reuse `parseNasDryRunConfig(value)` behavior or add a thin alias if clearer. Add a pure helper:

```js
export function buildSupervisorInstallDryRunViewModel(plan, errorMessage = '')
```

The helper normalizes unknown input into a safe `unknown` model, errors into `error`, and valid dry-run plans into a blocked/partial display model. It must not pass through arbitrary nested strings from the plan. Arrays are mapped to allowlisted IDs/status/blocker fields only.

The DOM renderer consumes that view model. This keeps tests focused on sanitation and avoids ad hoc rendering of raw objects.

## Testing Strategy

Add focused tests in `test/web-console.test.js`:

- HTML contains all `supervisor-install-dry-run-*` test hooks.
- Safety note says manual POST `/api/supervisor-install-dry-run`, dry-run-only, no startup request, no auto polling, no `launchctl`, no process list read, no install/start, no metadata write, no NAS connection, no backup/restore, no remote command, no Gold readiness claim.
- POST `/api/supervisor-install-dry-run` returns the sanitized plan and all blocked false safety fields.
- POST rejects invalid JSON body with `400`.
- POST rejects invalid config with `400`.
- POST rejects credential-like NAS fields without echoing submitted secret values.
- App JS references `/api/supervisor-install-dry-run` and the new DOM hooks.
- DOM init does not request `/api/supervisor-install-dry-run`.
- Empty textarea and invalid JSON do not call the API.
- Valid input calls the API exactly once and renders blocked readiness, approval, rollback, preflight, command preview, and safety signals.
- Duplicate clicks while a request is in flight do not start a second request.
- Non-2xx errors render a sanitized error.
- Rendered text does not contain submitted `serverUrl`, `sourcePath`, NAS endpoint, `remotePath`, `credentialRef`, token-like strings, Authorization, approval identity, approval timestamp, config path, plist path, executable path, or runnable command arguments.

Focused verification commands:

```bash
node --test --test-reporter=dot test/web-console.test.js
node --test --test-reporter=dot test/agent-supervisor-install-dry-run.test.js test/gold-readiness.test.js test/readme.test.js test/version.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
```

## Gold Readiness Boundary

V0.84 improves visibility and unified management ergonomics, but Gold remains blocked.

`automation-installation` and `production-hardening` may gain partial evidence for the Web panel and endpoint:

- `POST /api/supervisor-install-dry-run`
- `supervisor-install-dry-run-panel`
- `buildSupervisorInstallDryRunViewModel`
- `installApprovalManifest.approval.approved:false`
- `installApprovalManifest.rollback.available:false`

They must remain `partial`. `real-nas-remote-backup` remains `blocked`. README and readiness tests must continue to say that real NAS transport, real installer, launchd install/start, approval persistence, rollback, uninstall, recovery supervisor, monitoring, production hardening, and Gold release are not complete.

## Runtime Resilience Gate

### Normal State

The panel is idle until clicked. Normal successful dry-run state is:

- one manual POST to `/api/supervisor-install-dry-run`
- HTTP `200`
- blocked sanitized plan rendered
- no writes and no external system calls
- UI remains usable after success or error

### Recovery Anchor

The recovery anchor is the idle unknown panel state with the textarea content preserved. On parse failure or API failure, the panel stays in the same page state and renders an error without changing server data.

### Bounded Failure

- Empty input fails locally and does not call the API.
- Invalid JSON fails locally and does not call the API.
- Invalid config returns `400` and renders sanitized error text.
- Duplicate clicks during an active request are ignored by an in-flight guard.
- Unexpected server failure uses existing redacted `Internal Server Error` behavior.

### Observability

- The result area shows loading, success, or error text.
- The safety note states all non-mutating guarantees.
- Tests assert no startup request and no duplicate in-flight request.
- Existing server error handling and body-size limit remain in force.

### Verification Path

The highest-risk failure path for V0.84 is secret leakage through the request body or returned plan rendering. Tests must submit credential-like fields and secret-looking values, assert rejection or allowlisted rendering, and assert that the rendered result and error body do not echo those values.

## Documentation Updates

Update README and version to V0.84 after implementation:

- version table current row
- feature list
- supervisor install dry-run section
- Web Console section
- Gold blockers / partial hardening sections
- coverage list

The wording must preserve dry-run-only and Gold-blocked boundaries.
