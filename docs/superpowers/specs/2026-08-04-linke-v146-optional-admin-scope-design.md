# Linke V1.46 Optional Admin Scope Design

## Goal

Add an optional admin bearer-token scope that can protect device enrollment and
device revocation without breaking deployments that currently use a full or
write token for those routes.

## Frozen Semantics

- `adminToken` is optional and is loaded by the standalone server from
  `LINKE_ADMIN_TOKEN`.
- When `adminToken` is absent, the existing authorization contract remains
  unchanged: the full token, current write token, and previous write token may
  call `POST /api/device-enrollment-codes` and `POST /api/device-revoke`.
- When `adminToken` is present, those two exact routes accept only the full token
  or admin token. Current and previous write tokens receive HTTP 403 before
  request-body parsing, required-write admission, or device-administration calls.
- An admin token has the broadest scoped-token authority: it may call read,
  write, and admin routes. A full token retains the same authority.
- If one token value is configured for multiple scopes, the broadest matching
  scope wins.
- Missing or incorrect credentials still receive HTTP 401. A valid but
  insufficient scoped token receives HTTP 403 and an `auth.forbidden` audit
  event without token material.
- Whitespace-only and non-string `adminToken` inputs fail during server/status
  construction using the same validation style as existing token inputs.

## Components and Data Flow

`src/server.js` gains admin-token normalization and an exact admin-route
classifier for the two device-administration POST routes. `createServer()`
normalizes all configured tokens once, includes admin in the authentication
enablement check, calculates the broadest matching scope, and performs the
admin-route gate inside the existing authentication block.

`buildAuthStatusResponse()` exposes only `configuredScopes.admin: boolean`.
`buildHardeningStatusResponse()` similarly includes
`configuredAuthScopes.admin: boolean`, counts an admin-only configuration as
authentication configured, and never returns token values. The standalone
entry point reads `LINKE_ADMIN_TOKEN`, passes it into `createServer()`, and uses
its presence only for the existing generic authentication-enabled log line.

No dynamic key-change API, previous-admin overlap token, persistent credential
store, installation, deployment, or Gold declaration is in scope.

## Error Handling and Compatibility

- Admin token absent: preserve the current full/write/previous-write behavior.
- Admin token present and write token used on an admin route: fail closed with
  HTTP 403 before any business side effect.
- Admin token present and used on a normal write route: allow it.
- Admin token present as the only credential: authentication remains enabled;
  unauthenticated requests cannot fall through to localhost-open behavior.
- Device-administration service absent or incomplete: preserve existing 503/404
  behavior after successful authorization.

## Runtime Resilience

**Normal state:** configured credentials authenticate only their documented
scope; auth and hardening status report boolean scope configuration without
credential material; authorized device administration preserves existing
responses and audit behavior.

**Recovery anchor:** commit `54c428d` is the last-green source checkpoint. The
feature is configuration-only and stateless, so removing `LINKE_ADMIN_TOKEN`
returns the server to the existing compatible authorization contract on restart.

### Bounded failure

| Failure mode | Expected behavior | Fallback | Signal | Verification |
|---|---|---|---|---|
| Missing/wrong credential | HTTP 401 | None; fail closed | `auth.denied` | Security contract test |
| Write credential on admin route while admin is configured | HTTP 403 before body/service work | Use full/admin credential | `auth.forbidden` | Real HTTP boundary test with service call counter |
| Invalid admin-token configuration | Server/status construction throws | Correct configuration | deterministic validation error | Unit test |
| Admin token accidentally omitted at runtime | Existing write compatibility remains | Restore configuration and restart | status reports `admin: false` | Status/compatibility tests |

### Recovery

Authorization carries no mutable server state. Correcting the configuration and
restarting returns to the normal state. Source rollback returns to `54c428d`.
No automatic credential substitution or retry is permitted.

### Detection and post-run self-check

The auth and hardening status endpoints expose boolean admin-scope configuration.
Tests assert no token value is serialized. The highest-risk acceptance drill
starts a real loopback HTTP server with admin plus previous-write credentials,
sends a previous-write request to an admin route, observes HTTP 403 and an
`auth.forbidden` audit event, and proves the administration service was not
called.

## Runtime Risk Scan

- External dependency degradation: N/A; authorization is local and synchronous.
- Persistence/consistency: N/A; no credential state is persisted.
- Queue/retry exhaustion: N/A; authorization does not queue or retry.
- Missing configuration: covered by compatible fallback and boolean status.
- Startup/shutdown ordering: invalid configuration fails during construction.
- Migration/rollback: optional environment configuration; rollback anchor above.
- Resource exhaustion: existing body and rate limits remain unchanged; the new
  gate runs before body parsing.
- Alerting threshold: N/A for this narrow foundation; audit events and status are
  the available local signals.

## Acceptance Criteria

1. Old behavior remains green when no admin token is configured.
2. Admin/full tokens can call both exact admin routes when admin is configured.
3. Current and previous write tokens receive 403 on both admin routes when admin
   is configured, with no request-body or administration-service side effect.
4. Admin token can call a representative read route and normal write route.
5. Status surfaces report admin configuration as booleans and contain no token.
6. Invalid admin-token types/whitespace fail deterministically.
7. The focused security/status suites and the full source suite pass.
8. Security-auth remains a partial Gold category; this task does not change the
   version, README Gold matrix, installation state, or deployment state.
