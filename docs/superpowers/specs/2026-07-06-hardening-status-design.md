# Hardening Status Design

## Goal

Ship Linke V0.70 with a read-only runtime hardening status endpoint:

```bash
GET /api/hardening-status
```

The endpoint reports which local hardening controls are configured without exposing token values, restore paths, audit paths, environment variable values, or credential material.

## Current State

V0.69 exposes:

- `GET /api/health` for release liveness.
- `GET /api/auth-status` for sanitized auth scope status.
- Optional API auth, read/write token scopes, API rate limiting, audit retention, restore root guard, request body limits, and sanitized unexpected 500 errors.

Gold readiness still marks `security-auth` and `production-hardening` as partial, and `real-nas-remote-backup` remains blocked.

## Design

Add a pure response builder in `src/server.js`:

```js
buildHardeningStatusResponse({
  authToken,
  readToken,
  writeToken,
  restoreRoot,
  rateLimit,
  auditRetention,
})
```

Add a route:

```text
GET /api/hardening-status
```

The route follows the existing API auth gate. If any auth token is configured, callers must provide a matching full, read, or write token. A read token is enough because the route is read-only.

The response shape is closed and contains only booleans, fixed constants, route names, and version metadata:

```json
{
  "status": "partial",
  "service": "linke",
  "version": "V0.70",
  "hardening": {
    "authConfigured": true,
    "configuredAuthScopes": {
      "full": true,
      "read": true,
      "write": true
    },
    "scopedTokensConfigured": true,
    "rateLimitConfigured": true,
    "auditRetentionConfigured": true,
    "restoreRootConfigured": true,
    "requestBodyLimitBytes": 1048576,
    "writeRoutes": [
      "POST /api/heartbeat",
      "POST /api/backups",
      "POST /api/restore"
    ]
  },
  "safety": {
    "tokenValuesReturned": false,
    "restoreRootValueReturned": false,
    "auditPathReturned": false,
    "environmentValuesReturned": false,
    "successAuditEvent": false
  }
}
```

`status` is `partial` because this is a status surface, not a Gold promotion. Even when every listed local control is configured, the endpoint must not claim production readiness.

## Safety Boundaries

- Do not read `.env`, secret managers, SSH keys, cloud credentials, or token stores.
- Do not return token values, token lengths, token prefixes, token hashes, restore root values, audit file paths, dataDir values, environment variable values, or request headers.
- Do not change auth enforcement semantics for existing API routes.
- Do not change `release-readiness` default pass/fail semantics.
- Do not create local metadata, audit events, backups, restores, NAS network calls, NAS writes, or NAS app invocations.
- Keep `real-nas-remote-backup` blocked and Gold readiness blocked.

## Runtime Resilience

Normal state: `GET /api/hardening-status` returns sanitized JSON and does not mutate `dataDir`.

Recovery anchor: removing or not calling this endpoint leaves all existing runtime routes unchanged.

Failure modes:

- No auth configured: endpoint remains readable like other GET API routes in localhost prototype mode.
- Auth configured and no/unknown token supplied: existing API auth gate returns `401 Unauthorized` before hardening fields are returned.
- Read token supplied: endpoint returns status JSON because it is a read-only route.
- Mutating methods on `/api/hardening-status`: return `404 Not Found`.

Observable signals:

- Response includes `safety.tokenValuesReturned:false`.
- Response includes `safety.restoreRootValueReturned:false`.
- Response includes `safety.auditPathReturned:false`.
- Tests assert the serialized response does not include sample token values or restore root paths.
- Tests assert the endpoint does not write to `dataDir` on success.

## Acceptance Criteria

- `buildHardeningStatusResponse()` returns a closed, sanitized response with no secret/path values.
- `GET /api/hardening-status` returns sanitized JSON and does not mutate `dataDir`.
- Existing API auth gate protects `/api/hardening-status` when auth is configured.
- Read token can access `/api/hardening-status`; unknown token receives `401` without hardening fields.
- Mutating methods on `/api/hardening-status` return `404`.
- README, version, Gold readiness evidence, Web safety note, and tests are updated to V0.70.
- `release-readiness` remains based on `/api/health` and is not tightened by this endpoint.
- Full test suite passes.
