# Release Health Web Panel Design

## Goal

Add Linke V0.48 Web Console release health panel that lets an operator run a read-only visual check of the existing `GET /api/health` endpoint.

## Scope

- Add a Web Console panel named `发布健康检查`.
- Add a read-only refresh control that performs exactly one `GET /api/health` request per click.
- Display normalized health fields: status, service version, `checks.dataDirReadable`, and timestamp.
- Display failure state when `/api/health` is unreachable or returns a non-2xx response.
- Update README and README tests to document V0.48.
- Do not add or change server routes.
- Do not add automatic background polling in V0.48.

## Non-Goals

- No authentication.
- No production readiness claim.
- No daemon/watch mode.
- No retry loop.
- No release blocking policy.
- No NAS, backup, restore, sync, delete, metadata write, credential, or remote command behavior.

## UI Contract

HTML adds these stable hooks:

- `release-health-panel`
- `release-health-status`
- `release-health-version`
- `release-health-data-dir`
- `release-health-timestamp`
- `release-health-message`
- `release-health-refresh`
- `release-health-safety-note`

`release-health-panel` owns the state attribute:

- `data-status="unknown"` before any check.
- `data-status="ok"` when `/api/health` returns `status:"ok"`.
- `data-status="degraded"` when `/api/health` returns `status:"degraded"`.
- `data-status="error"` when fetch, JSON parsing, or non-2xx response handling fails.

The panel starts in `unknown` state:

- `release-health-status` text: `未检查`
- version: `—`
- data directory readability: `—`
- timestamp: `—`
- message: `点击刷新状态获取 /api/health`

Clicking `release-health-refresh` calls `/api/health` and updates the panel using textContent only.
During the request the button is disabled and `aria-disabled="true"` is set. On completion the button is re-enabled. V0.48 does not queue concurrent checks; it uses this disable-until-complete behavior instead of a retry loop.

## Data Flow

1. `initConsole()` keeps the existing `(doc, fetchImpl, intervalImpl)` signature and adds the release health click binding internally.
2. The handler calls `fetchImpl('/api/health')`.
3. If `res.ok` is false, the handler throws `HTTP <status>`.
4. If the response is valid JSON, the panel renders a normalized view model.
5. If fetch or parsing fails, the panel renders error state and logs a read-only event.

V0.48 intentionally does not call `/api/health` during startup or the existing 10 second `/api/devices` interval. This keeps existing device refresh behavior unchanged and avoids hidden background requests.

## Normal State

When `/api/health` returns:

```json
{
  "status": "ok",
  "service": "linke",
  "version": "V0.48",
  "checks": {
    "http": "ok",
    "dataDirReadable": "ok"
  },
  "timestamp": "2026-07-05T00:00:00.000Z"
}
```

The Web Console shows:

- status: `正常`
- version: `V0.48`
- data directory: `可读`
- timestamp: the response timestamp
- message: `GET /api/health 成功`
- panel state: `data-status="ok"`

When `status` is `degraded`, the panel still treats the request as successful and displays `降级`. It does not turn degraded into a release failure policy; it only exposes the server payload visually.
The panel sets `data-status="degraded"` so CSS can give it a distinct warning treatment from the normal state.

## Failure State

When `/api/health` is unreachable, non-2xx, or invalid:

- status: `检查失败`
- version: `—`
- data directory: `—`
- timestamp: `—`
- message includes the error text, for example `HTTP 500`.
- panel state: `data-status="error"`

The failure state is visible but does not trigger any retry, write, NAS action, remote command, or page-level crash.

## Safety Boundaries

- The panel is read-only.
- It only calls `GET /api/health`.
- It does not send a request body.
- It does not require a device selection.
- It does not read or write metadata.
- It does not create, modify, or delete local data.
- It does not connect to NAS or invoke NAS applications.
- It does not execute remote commands.
- It does not display local data directory paths, environment variables, credentials, tokens, or secrets.

## Resilience

- Bounded failure: one request per explicit click, no retry loop.
- Recovery anchor: failed checks leave local application state unchanged except for visible panel text and event log.
- Detection signal: panel `data-status` plus visible status/message fields.
- Manual recovery: operator can click refresh again after fixing the server or data directory.

## Test Plan

- HTML contract test for all `release-health-*` hooks.
- HTML safety test that the panel states read-only behavior and does not expose backup/restore/NAS/remote execution wording.
- Source contract test that `app.js` references `/api/health`, `release-health-refresh`, and a release health render path.
- Pure view-model tests for ok, degraded, and error states.
- DOM test: clicking refresh calls exactly `/api/health` and renders ok response.
- DOM test: failed response renders error state without throwing.
- DOM test: refresh button is disabled during the request and re-enabled after completion.
- CSS/source contract test for state-specific styling through `release-health-panel[data-status="ok"]`, `[data-status="degraded"]`, and `[data-status="error"]`.
- README tests for V0.48 title/badge/table row, feature docs, safety boundary, and testing coverage.
- Full suite plus real HTTP smoke against a temporary server.

## Qwen Design Review

- Status: `DONE_WITH_CONCERNS`, not blocking.
- Accepted finding: define `release-health-panel` `data-status` values in the UI contract.
- Accepted finding: keep `initConsole(doc, fetchImpl, intervalImpl)` unchanged and bind the panel internally.
- Accepted finding: disable `release-health-refresh` while a request is in flight.
- Accepted finding: require state-specific visual hooks for degraded and error states.
