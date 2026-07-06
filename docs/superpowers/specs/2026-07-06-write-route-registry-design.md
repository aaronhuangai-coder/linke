# Write Route Registry Design

## Goal

Add Linke V0.63 shared write-route registry so auth enforcement and `/api/auth-status` report the same write API route list from one code-owned source.

## Scope

- Export a shared write route list from `src/server.js`.
- Use the shared list for the read-token write denial decision.
- Use the same list for `buildAuthStatusResponse().auth.writeRoutes`.
- Keep the route list sanitized: method + path only, no tokens, request bodies, filesystem paths, NAS endpoints, or environment values.
- Keep existing auth behavior unchanged.
- Keep Gold readiness blocked and `security-auth` partial.

## Non-Goals

- No new API endpoint.
- No route auto-discovery or dynamic router.
- No RBAC, user sessions, token rotation, secret management, or production-grade authorization.
- No change to which routes are write routes.

## Behavior

`API_WRITE_ROUTES` is the single source of truth:

```js
[
  { method: 'POST', path: '/api/heartbeat' },
  { method: 'POST', path: '/api/backups' },
  { method: 'POST', path: '/api/restore' },
]
```

The auth gate checks incoming requests against this list. `buildAuthStatusResponse()` exposes the same list as strings:

```json
[
  "POST /api/heartbeat",
  "POST /api/backups",
  "POST /api/restore"
]
```

## Tests

- Unit test exports the shared registry and verifies the exact write route objects.
- Unit test verifies `formatApiRoute()` output used by auth status.
- Auth status response test verifies `writeRoutes` equals the shared registry formatting, not a duplicate literal.
- Security test verifies every route in the registry rejects read-token writes with `403 Forbidden` before mutation.
- Existing read-token and write-token behavior remains green.

## Run-Time Resilience

- Normal state: write-route authorization and auth-status reporting stay aligned.
- Recovery anchor: revert to the last green release commit if a route registration change breaks auth tests.
- Bounded failure: newly added write routes must be added to the registry or read-token regression tests should fail.
- Detection: registry, security, auth-status, and README tests detect drift.
