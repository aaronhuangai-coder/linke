# Audit Retention Foundation Design

## Goal

Add Linke V0.60 optional audit-log retention foundation so local JSONL audit files can be bounded by event count without changing default localhost behavior or claiming production-grade audit.

## Scope

- Add optional `LINKE_AUDIT_MAX_EVENTS` standalone server configuration.
- Allow tests and embedders to pass `createServer({ auditRetention: { maxEvents } })`.
- Keep audit retention disabled by default.
- Retain only the newest N non-empty JSONL lines when retention is enabled.
- Preserve existing audit event allowlist and sensitive-field exclusions.
- Keep `GET /api/audit-log` read-only and capped by its existing query limit.
- Keep Gold readiness blocked and `production-hardening` partial.

## Non-Goals

- No tamper-proof audit store, signing, encryption, SIEM export, or external log shipping.
- No multi-process file lock, distributed audit retention, or cross-instance coordination.
- No time-based retention, size-based rotation, compression, or archive files.
- No production-grade audit claim and no readiness item moves to `ready`.

## Behavior

`LINKE_AUDIT_MAX_EVENTS` accepts a positive integer. Missing, empty, or `0` means disabled. Values are parsed with integer semantics: only `Number.isInteger(parsed) && parsed > 0` is enabled. Any other non-positive or non-integer value, including `1.5`, is a startup configuration error.

Programmatic `auditRetention` accepts `null`, `undefined`, `false`, or `{ maxEvents: 0 }` as disabled. `{ maxEvents: <positive integer> }` enables retention. Other values are configuration errors.

When retention is enabled, each `appendAuditEvent()` call appends the sanitized event and then compacts `dataDir/audit/events.jsonl` to the newest `maxEvents` non-empty lines. The compaction writes through a temporary file and rename so readers do not observe a partially written compacted log.

Within one Node.js process, append and compaction operations for the same audit file are serialized through an in-memory per-file queue only when retention is enabled. When retention is disabled, `appendAuditEvent()` keeps the existing direct append path. This protects Linke's current single-process server and test concurrency path without changing default timing semantics. Multi-process writers remain a documented non-goal.

`appendAuditEvent()` does not start background compaction. Its returned promise resolves only after append and any configured compaction finish, so there is no separate retention queue drain step on normal request completion.

If audit append or compaction fails, the existing best-effort server audit behavior remains: `recordAudit()` catches the failure, writes a generic stderr message, and does not block the original API response.

## Tests

- Default `appendAuditEvent()` behavior remains unbounded.
- `appendAuditEvent(dataDir, event, { retention: { maxEvents } })` keeps only the newest events.
- Concurrent append calls with retention preserve one event per request up to `maxEvents`.
- `parseAuditRetentionMaxEvents()` handles disabled and invalid env values.
- `{ maxEvents: 0 }` disables programmatic retention.
- `createServer({ auditRetention })` applies retention to API-generated audit events.
- `GET /api/audit-log` still returns newest events first after compaction.
- README and Gold readiness keep `production-hardening` partial and Gold blocked.

## Run-Time Resilience

- Normal state: audit events append successfully and `GET /api/audit-log` returns newest events first.
- Recovery anchor: the latest compacted `events.jsonl` file in `dataDir/audit`.
- Bounded failure: audit retention failures fail open for business APIs but surface as generic stderr.
- Detection: tests verify retained event counts, newest-event ordering, sensitive-field exclusion, and Gold blocked status.
