# Auth Status Readiness Design

## Goal

Add Linke V0.62 read-only auth status readiness API so local operators can confirm which Bearer auth scopes are configured without exposing token values or changing Gold readiness status.

## Scope

- Add `GET /api/auth-status`.
- Keep the endpoint read-scope, so configured read, write, and full-access tokens can read it.
- Return version, service, auth enabled state, configured scope booleans, and the current write-scope route list.
- Keep no-auth localhost prototype mode compatible: if no token is configured, `GET /api/auth-status` returns `enabled:false`.
- Do not return token values, token prefixes, Authorization headers, environment variable values, request bodies, source paths, target paths, NAS endpoints, or credential-like fields.
- Do not write metadata and do not emit audit success events for successful reads.
- Keep Gold readiness blocked and `security-auth` partial.

## Non-Goals

- No live secret validation, token strength scoring, token rotation, secret management, RBAC, user sessions, or OAuth.
- No production-grade authorization claim.
- No `goldStatus` shortcut field.
- No separate Web Console panel.

## Behavior

The response is a sanitized status object:

```json
{
  "status": "ok",
  "service": "linke",
  "version": "V0.62",
  "auth": {
    "enabled": true,
    "configuredScopes": {
      "full": true,
      "read": true,
      "write": true
    },
    "writeRoutes": [
      "POST /api/heartbeat",
      "POST /api/backups",
      "POST /api/restore"
    ]
  },
  "safety": {
    "tokenValuesReturned": false,
    "successAuditEvent": false
  }
}
```

When auth is enabled, the existing `/api/*` auth gate runs before route dispatch. Missing or unknown tokens return `401 Unauthorized` and do not reveal auth status fields. A read token can access the endpoint because the endpoint is read-scope.

## Tests

- Pure response builder returns deterministic scope booleans and write route list.
- No-auth mode returns `enabled:false` without mutating `dataDir`.
- Read token can GET `/api/auth-status`.
- Unknown or missing token gets `401 Unauthorized` when auth is enabled.
- Successful response body does not include token values or token prefixes.
- Successful GET does not create audit success events.
- Mutating methods for `/api/auth-status` return 404.
- README, Web safety note, and Gold readiness keep `security-auth` partial and Gold blocked.

## Run-Time Resilience

- Normal state: authenticated operators can confirm auth scope configuration through a read-only endpoint.
- Recovery anchor: restart the local server with corrected environment variables.
- Bounded failure: missing or unknown tokens fail closed with 401 before any auth-status body is returned.
- Detection: tests verify schema, auth gate behavior, no token leakage, no metadata mutation, and Gold blocked status.
