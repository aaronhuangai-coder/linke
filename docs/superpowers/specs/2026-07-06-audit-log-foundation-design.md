# Audit Log Foundation Design

## Goal

Add a local audit-log foundation for Linke V0.58 that records selected API security and mutation events without storing secrets, absolute backup/restore paths, NAS endpoints, or request bodies.

## Scope

- Add a focused `src/audit-log.js` module.
- Store JSON Lines at `dataDir/audit/events.jsonl`.
- Add `GET /api/audit-log?limit=N` for newest audit events.
- Record these events:
  - `auth.denied`
  - `api.heartbeat.success`
  - `api.heartbeat.failure`
  - `api.backup.created`
  - `api.backup.failure`
  - `api.restore.completed`
  - `api.restore.failure`
- Keep event fields intentionally small:
  - `id`
  - `createdAt`
  - `type`
  - `method`
  - `path`
  - `statusCode`
  - `outcome`
  - `requestId`
  - `deviceId`
  - `snapshotId`
  - `fileCount`
  - `message`

## Non-Goals

- No production-grade audit guarantee.
- No log rotation, retention, signing, encryption, SIEM export, or tamper-proof storage.
- No role-based authorization, users, sessions, token rotation, secret management, monitoring, supervisor, or real NAS remote backup.
- No storage of Authorization headers, bearer tokens, request bodies, `sourcePath`, `targetPath`, NAS endpoint URLs, or credential-like fields.
- No Gold-ready or production-ready claim.

## Behavior

`appendAuditEvent(dataDir, event)` writes one sanitized JSON line. It creates `dataDir/audit` as needed and never uses user-controlled path segments for the audit file path.

`readAuditEvents(dataDir, { limit })` returns newest events first. `limit` defaults to 50 and is clamped to a small maximum. Missing audit files return an empty list.

`GET /api/audit-log?limit=N` is read-only and protected by the existing `/api/*` bearer-token gate. If `LINKE_AUTH_TOKEN` is not configured, this route follows current localhost behavior and is unauthenticated. In that mode `auth.denied` events are not expected.

Audit append failures are best-effort in V0.58: they are logged to stderr with a generic message and do not block the original API response. The stderr message must not include the event payload.

## Safety

Event sanitization uses an allowlist. Unknown keys are dropped. Credential-like keys and path-bearing fields are never emitted even if a caller passes them.

The JSONL file may grow without bound in V0.58. README and Gold readiness must keep production hardening partial and document that rotation/retention remains a later operations task.

## Tests

- Pure append/read tests cover missing file, newest-first limit, and concurrent append integrity.
- Sanitization tests assert exact key allowlist and absence of sensitive fields.
- API tests cover `auth.denied`, `GET /api/audit-log`, backup success event, restore success event, restore failure event, and `limit` parsing.
- README and Gold readiness tests keep V0.58 aligned and prevent production-ready overclaims.

## Qwen Design Review Conditions

- Add event key allowlist assertions.
- Explicitly document that no `auth.denied` event exists when auth is disabled.
- Document lack of JSONL rotation and keep Gold readiness partial.
