# API Read/Write Token Foundation Design

## Goal

Add Linke V0.61 optional read/write Bearer token authorization foundation so local operators can separate read-only API access from mutating API access without changing the default localhost prototype behavior or claiming production-grade authorization.

## Scope

- Keep existing `LINKE_AUTH_TOKEN` / `LINKE_TOKEN` as a full-access compatibility token.
- Add optional `LINKE_READ_TOKEN` and `LINKE_WRITE_TOKEN` standalone server configuration.
- Allow embedders and tests to pass `createServer({ readToken, writeToken })`.
- Accept read token for read-scope API routes only.
- Accept write token for write-scope API routes and read-scope API routes.
- Return `403 Forbidden` and record `auth.forbidden` when a valid read token attempts a write-scope route.
- Return `401 Unauthorized` and record `auth.denied` for missing, malformed, or unknown tokens when auth is enabled.
- Keep rate limiting before auth.
- Keep Gold readiness blocked and `security-auth` partial.

## Non-Goals

- No users, roles, groups, sessions, refresh tokens, OAuth, token rotation, or secret management.
- No distributed authorization, proxy trust policy, production deployment hardening, or production security review.
- No Web Console multi-token UI; the existing single in-memory API Token input can carry whichever token the operator chooses.
- No claim that V0.61 is Gold-ready.

## Behavior

Auth is enabled if any of `authToken`, `readToken`, or `writeToken` is configured. If no token is configured, all API behavior remains compatible with the existing localhost prototype.

`authToken` is a full-access compatibility token. `writeToken` grants read and write scopes. `readToken` grants read scope only. If multiple configured tokens match the same header value, the broadest scope wins: full/write access beats read-only access. This keeps overlapping `LINKE_READ_TOKEN` and `LINKE_WRITE_TOKEN` fail-open only to the explicitly configured broader local token value, not to unknown tokens.

Write-scope API routes are the routes that mutate Linke data: `POST /api/heartbeat`, `POST /api/backups`, and `POST /api/restore`. Other current API routes are read-scope routes, including dry-run endpoints that do not write metadata or transfer files.

The server compares all configured token candidates before deciding the matched scope, avoiding an early-return dependency on token order. Audit events never include full tokens, token prefixes, Authorization headers, request bodies, source paths, target paths, NAS endpoints, or credential-like values.

## Tests

- Existing `authToken` full-access behavior remains unchanged.
- No-token localhost mode remains allowed.
- `readToken` can GET read-scope API routes.
- `readToken` cannot POST write-scope API routes and returns `403 Forbidden` without writing device data.
- `auth.forbidden` is recorded for valid read-token write attempts.
- `writeToken` can GET read-scope API routes and POST write-scope API routes.
- Unknown or missing tokens still return `401 Unauthorized` and record `auth.denied`.
- Overlapping read/write token values use broadest-scope semantics.
- README, Web safety note, and Gold readiness keep `security-auth` partial and Gold blocked.

## Run-Time Resilience

- Normal state: configured Bearer tokens gate API access according to read/write scope.
- Recovery anchor: no background auth state exists; changing environment variables and restarting the local server returns to the configured token set.
- Bounded failure: missing or unknown tokens fail closed with `401`; read-token write attempts fail closed with `403`.
- Detection: server tests cover status codes, no data mutation on forbidden writes, audit event types, docs evidence, and Gold blocked status.
