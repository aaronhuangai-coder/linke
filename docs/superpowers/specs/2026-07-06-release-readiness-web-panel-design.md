# Release Readiness Web Panel Design

## Goal

Linke V0.51 exposes the V0.50 release-readiness gate in Web Console without changing backup, restore, NAS, or metadata behavior.

## Problem

V0.50 added a CLI release gate, but Web Console users still only see raw release health. Gold release preparation needs the same readiness signal available in the visual control surface.

## Scope

- Add a read-only `GET /api/release-readiness` endpoint.
- The endpoint must reuse `buildReleaseReadinessReport()` from `src/release-readiness.js`.
- The endpoint builds its health input from the existing `buildHealthResponse()` path and uses `LINKE_RELEASE_VERSION` as the expected version.
- Extend the existing release health panel with a release-readiness subsection instead of adding a separate top-level panel.
- Add a manual readiness refresh button. It must not request on initialization and must not poll.
- Display:
  - readiness status: unknown / ready / not-ready / error
  - expected version
  - actual version
  - failed check count
  - concise check list
  - sanitized message
- Update README to V0.51 current.

## Non-Goals

- Do not change the existing `agent.js release-readiness` command.
- Do not remove or replace `GET /api/health`.
- Do not run readiness automatically when the page loads.
- Do not add retries, polling, daemon behavior, or background loops.
- Do not add NAS, backup, restore, delete, remote command, or metadata-write behavior.
- Do not expose raw health payloads or path-like values.

## Endpoint Contract

`GET /api/release-readiness` returns:

```json
{
  "ready": true,
  "service": "linke",
  "expectedVersion": "V0.51",
  "actualVersion": "V0.51",
  "status": "ok",
  "checkedAt": "2026-07-06T00:00:00.000Z",
  "checks": [
    { "id": "health.schema", "ok": true, "expected": "...", "actual": "allowed schema" }
  ]
}
```

Non-GET methods for `/api/release-readiness` return `404`, matching `/api/health`.

## Web Console Behavior

- Existing release health refresh remains unchanged and keeps calling `/api/health`.
- New readiness subsection lives inside `release-health-panel`.
- Readiness refresh calls exactly one `GET /api/release-readiness`.
- Button is disabled while the request is in flight.
- Success renders the report.
- Non-2xx, invalid JSON, and thrown fetch errors render error state.
- The subsection never renders raw health JSON or leaked path values.

## Qwen Design Review

Qwen returned `DONE_WITH_CONCERNS`. Accepted findings:

- Reuse `buildReleaseReadinessReport()` in the endpoint; do not duplicate readiness logic.
- Merge readiness into the existing release health panel rather than adding a confusing parallel panel.
- Test non-GET methods return `404`.
- Test endpoint output matches a local `buildReleaseReadinessReport(buildHealthResponse(...))` calculation for the same server state.

## Acceptance

- Current version becomes `V0.51`.
- `GET /api/release-readiness` returns sanitized readiness JSON.
- Non-GET `/api/release-readiness` methods return `404`.
- Web Console contains release-readiness hooks inside the release health panel.
- Web Console does not call `/api/release-readiness` on initialization.
- Clicking the readiness button calls `/api/release-readiness` once and renders ready/not-ready/error states.
- Tests prove no dataDir path disclosure and no metadata writes.
- `npm test` and `git diff --check` pass.
