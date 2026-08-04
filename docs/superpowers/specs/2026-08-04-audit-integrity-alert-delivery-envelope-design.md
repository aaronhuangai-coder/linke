# Audit integrity alert delivery envelope design

## Goal

Add a pure, deterministic request-envelope foundation for a future HTTPS alert transport. This slice performs no network I/O, stores no credential, reads or acknowledges no outbox entry, starts no scheduler, and does not claim remote delivery or Gold.

## Contract

- New module: `src/audit-integrity-alert-delivery.js`.
- Export `buildAuditIntegrityAlertDeliveryEnvelope(streamId, entry)` and `buildAuditIntegrityAlertDeliveryRequest(endpoint, streamId, entry)`.
- `streamId` is mandatory and must be a canonical lowercase UUIDv4. It identifies one durable outbox stream without exposing a path, host name, user name, or credential. Provisioning and persisting that stable stream identity is deliberately not part of this pure builder slice.
- An entry must have the exact closed outbox entry shape and semantics already accepted by the outbox: canonical positive safe `sequence`, canonical ISO millisecond `checkedAt`, and an allowed `code` / `recoveryRequired` / `nextAction` / `reasonCode` combination.
- The deeply frozen envelope has exact keys `schemaVersion`, `kind`, `streamId`, `idempotencyKey`, `deliverySemantics`, `alert`; fixed values are schema 1, `audit-integrity-alert`, the validated stream UUID, `audit-integrity-alert:<streamId>:<sequence>`, and `at-least-once`. The namespace makes keys distinct across outbox streams; `alert` is a deeply frozen defensive copy.
- The request accepts only a canonical HTTPS URL of at most 2048 UTF-8 bytes, with no username, password, query, or fragment. It returns a deeply frozen exact request descriptor: schema version, URL, POST method, fixed JSON content type and idempotency-key headers, and one compact JSON body made from the envelope.
- Invalid entry, endpoint, hostile accessor/proxy, or serialization failure maps to the existing fixed path-free `audit-delivery-unavailable` error.

## Boundaries

The production module must not import or call `fetch`, `http`, `https`, `net`, `tls`, `dns`, child processes, filesystem, timers, environment variables, or outbox read/ack APIs. It composes data only. At-least-once is an honest future retry contract, not exactly-once evidence. A request descriptor is not delivery, acknowledgement, retry/backoff, dead-letter handling, scheduling, monitoring, deployment, or Gold.
