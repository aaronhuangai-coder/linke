# Linke V0.46 Release Health Endpoint Design

## Summary

V0.46 adds a stable release health endpoint for Linke:

```text
GET /api/health
```

The endpoint gives operators, smoke tests, and future packaging scripts a simple liveness signal before using the Web Console or agent APIs. It is intentionally read-only and does not inspect or mutate backup data.

## Scope

- Add `buildHealthResponse({ dataDirReadable, now })` as a pure helper in `src/server.js`.
- Add `GET /api/health` to `createServer()`.
- Return JSON with stable fields:

```json
{
  "status": "ok",
  "service": "linke",
  "version": "V0.46",
  "checks": {
    "http": "ok",
    "dataDirReadable": "ok"
  },
  "timestamp": "2026-07-05T00:00:00.000Z"
}
```

- Update README and tests for V0.46.

## Behavior

- `GET /api/health` returns HTTP 200.
- `Content-Type` is `application/json; charset=utf-8`.
- `timestamp` is an ISO timestamp generated at request time.
- `checks.dataDirReadable` is `ok` when the configured `dataDir` is readable and `unavailable` when it is missing or unreadable.
- `status` is `ok` when all checks pass and `degraded` when the data directory is not readable.
- The endpoint does not expose `DATA_DIR`, absolute paths, hostnames, environment variables, credentials, or device data.
- The endpoint does not create directories or files.
- Non-GET methods are not added and continue to fall through to the existing 404 behavior.

## Safety Boundaries

- Read-only liveness signal.
- No metadata writes.
- No backup, restore, retention, snapshot diff, backup preflight, NAS dry-run, NAS app invocation, sync, delete, or remote command.
- No credential or path disclosure.
- No authentication claim; README must keep the existing localhost/prototype warning.

## Resilience Gate

Normal state: a running Linke HTTP process with a readable data directory returns `status:"ok"` from `/api/health`.

Recovery anchor: if a health request returns `status:"degraded"` or fails, the recovery action is to inspect the configured data directory or restart the Linke process; the endpoint itself has no persisted state to repair.

Bounded failure: malformed methods or unsupported paths fall through to the existing JSON 404 handler.

Detection and self-check: unit tests validate the pure response shape; HTTP tests validate the real endpoint, JSON headers, parseable timestamp, readable and missing data directory states, and no data directory mutation.

## Acceptance Criteria

- `buildHealthResponse({ dataDirReadable: true, now: new Date("2026-07-05T00:00:00.000Z") })` returns the exact stable `ok` health payload except no path fields.
- `buildHealthResponse({ dataDirReadable: false, now: new Date("2026-07-05T00:00:00.000Z") })` returns `status:"degraded"` and `checks.dataDirReadable:"unavailable"`.
- `GET /api/health` returns 200 JSON with `status:"ok"`, `service:"linke"`, `version:"V0.46"`, `checks.http:"ok"`, and `checks.dataDirReadable:"ok"` when dataDir is readable.
- Calling `/api/health` with a missing data directory returns `status:"degraded"` and does not create the missing directory.
- Calling `/api/health` does not create files or directories inside the configured data directory.
- `POST`, `PUT`, `PATCH`, and `DELETE /api/health` are not implemented and return 404 through the existing handler.
- README states V0.46 is current and documents the no-write/no-path-disclosure/no-NAS/no-remote safety boundary.

## Qwen Adversarial Findings And PM Decisions

- Finding: a hard-coded `dataDirConfigured:true` would be semantically false and too weak for a Gold release path.
  - Decision: accepted. V0.46 now performs a read-only `dataDir` readability check and reports `ok` or `unavailable`.
- Finding: checking only `POST /api/health` leaves the non-GET method claim under-tested.
  - Decision: accepted. Tests must cover `POST`, `PUT`, `PATCH`, and `DELETE`.
- Finding: `version:"V0.46"` is a manual release constant that can drift in future releases.
  - Decision: recorded as non-blocking for V0.46. Linke already uses README milestone versions separately from `package.json` `0.1.0`; future version bumps must update the release constant with the README version.
