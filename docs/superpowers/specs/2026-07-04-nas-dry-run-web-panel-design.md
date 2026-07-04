# Linke V0.13 NAS Dry-Run Web Panel Design

## Summary

V0.13 extends the existing NAS dry-run capability from the Agent CLI into the Web Console. The feature adds a read-only Web panel where the user can paste a Linke config JSON, submit it to a new local API endpoint, and inspect the NAS dry-run plan for Synology and Ugreen targets.

The feature does not implement real NAS connections, remote writes, credential storage, or background jobs. It only validates the provided config object and renders the plan returned by the existing `buildNasDryRunPlan(config)` function.

## Goals

- Add `POST /api/nas-dry-run`.
- Add a Web Console NAS dry-run panel with stable test hooks.
- Let users paste config JSON that contains `deviceId`, `nasTargets`, and optional `backupJobs`.
- Show target count, job count, enabled/disabled target status, provider, endpoint, share name, and remote path.
- Reject invalid JSON, invalid providers, credential-like fields, and endpoint URL userinfo.
- Preserve the existing dry-run guarantee: no NAS connection, no network request to NAS, no remote write, no local config persistence.

## Non-Goals

- No real Synology or Ugreen API calls.
- No ping, probe, auth check, SMB/WebDAV test, or HTTP fetch to a NAS endpoint.
- No credentials in Web Console examples.
- No saved config files.
- No execution button for a real NAS backup.
- No authentication or permission model changes.

## Architecture

The server adds a local-only API route:

```text
POST /api/nas-dry-run
```

The route parses the request body with existing JSON body parsing, calls `buildNasDryRunPlan(body)`, and returns the plan. Validation errors are returned as `400` with `{ "error": "..." }`. Invalid JSON also returns `400` with `{ "error": "Invalid JSON body" }`.

The Web Console adds a new panel in `src/web/index.html`. Browser logic in `src/web/app.js` parses the textarea JSON before sending it. Empty and malformed JSON are blocked client-side. Server-side validation remains authoritative.

Rendering must use `textContent` and DOM nodes. The panel must not use `innerHTML` for user-provided config values or API error messages.

## Web Console Hooks

The panel must expose these stable hooks:

```text
nas-dry-run-panel
nas-dry-run-config
nas-dry-run-run
nas-dry-run-target-count
nas-dry-run-job-count
nas-dry-run-result
nas-dry-run-safety-note
```

Existing hooks remain:

```text
nas-config-sample
nas-dry-run-command
nas-safety-note
```

The new safety hook is purpose-specific and must not replace the existing Agent command safety note.

## API Contract

Request:

```json
{
  "deviceId": "web-console-dry-run",
  "nasTargets": [
    {
      "name": "my-synology",
      "provider": "synology",
      "endpoint": "http://192.168.1.100:5000",
      "shareName": "backup",
      "remotePath": "/volume1/backup",
      "enabled": true
    }
  ],
  "backupJobs": [
    { "name": "documents", "sourcePath": "/Users/ah/Documents" }
  ]
}
```

Successful response:

```json
{
  "mode": "dry-run",
  "deviceId": "web-console-dry-run",
  "wouldConnect": false,
  "wouldWrite": false,
  "targets": [
    {
      "name": "my-synology",
      "provider": "synology",
      "endpoint": "http://192.168.1.100:5000",
      "shareName": "backup",
      "remotePath": "/volume1/backup",
      "enabled": true
    }
  ],
  "jobs": [
    { "name": "documents", "sourcePath": "/Users/ah/Documents" }
  ]
}
```

Failure responses:

- Invalid JSON body: `400 { "error": "Invalid JSON body" }`
- Unsupported provider: `400`, error includes `provider`
- Credential-like field: `400`, error includes `credential` or equivalent rejection wording
- Endpoint userinfo: `400`, error includes credential/userinfo rejection wording

## UI Behavior

- The textarea starts with a credential-free Synology/Ugreen sample config.
- Clicking the run button with an empty textarea does not call `fetch`.
- Invalid JSON is caught client-side and displayed in the panel.
- Valid JSON sends a `POST /api/nas-dry-run` request with `Content-Type: application/json`.
- Success resets error state and renders counts plus a list of targets.
- Server errors render the server error message as text.
- The panel copy must say dry-run only, no NAS connection, no remote write, and no config persistence.
- The panel must not say or imply production-ready NAS backup capability.

## Testing

Add focused tests in the existing Node test suite:

- README mentions V0.13 and documents the Web Console NAS dry-run panel.
- API returns a dry-run plan and `wouldConnect:false`, `wouldWrite:false`.
- API rejects invalid JSON with `400`.
- API rejects unsupported provider.
- API rejects credential-like fields.
- API rejects endpoint URL userinfo.
- HTML contains the new hooks.
- HTML panel communicates dry-run safety and has no real NAS execution wording.
- `app.js` references `/api/nas-dry-run`.
- DOM tests cover empty config blocking, invalid JSON blocking, successful render, and API error render.

Run:

```bash
npm test
```

## Resilience Design

Normal state:

- `POST /api/nas-dry-run` returns either a dry-run plan or a `400` validation error.
- The Web panel renders counts and target details without writing local files or contacting NAS endpoints.

Recovery anchor:

- The route is stateless. On malformed input, the system returns a bounded `400` response and remains ready for the next request.

Bounded failure:

- Invalid JSON is caught and returns `400`.
- Invalid config is caught by existing validation and returns `400`.
- No external NAS network call exists in the call chain.
- No config is persisted, so a bad submission has no durable side effect.

Observability:

- Web panel displays validation failures.
- Event log records success/failure.
- Tests exercise at least one real HTTP API boundary using the local test server.

Highest-risk failure path for acceptance:

```text
credential-like NAS target field submitted
-> server validation returns 400
-> Web panel renders error
-> no NAS connection, no write, no config persistence
```

## PM Decisions From AGY Review

Accepted:

- Use a Web Console panel and local POST API.
- Reuse `buildNasDryRunPlan(config)`.
- Add API, HTML hook, DOM interaction, and README coverage.

Rejected:

- Do not claim "100% safe".
- Do not render user/API values with `innerHTML`.
- Do not add decorative UI complexity or animation beyond the existing Linke style.
