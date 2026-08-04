# Audit integrity alert delivery prepare composer design

## Goal

Compose the current local outbox head, stable stream identity, and pure HTTPS request descriptor into one snapshot-only preparation API. It performs no network I/O, claim, acknowledgement, retry, scheduling, or remote registration/delivery.

## Contract

- New module `src/audit-integrity-alert-delivery-prepare.js` exports `prepareAuditIntegrityAlertDelivery(dataDir, endpoint)`.
- It first reads the bounded outbox. Empty state returns a deeply frozen exact `{schemaVersion:1,status:"empty",sequence:null,streamId:null,request:null}` receipt and creates no stream identity.
- For a nonempty snapshot it explicitly ensures the stable stream identity, reads the outbox again, and either returns empty if it drained or builds the existing canonical HTTPS descriptor for the new exact head. A prepared receipt has exact keys `schemaVersion,status,sequence,streamId,request`; all nested data is already frozen.
- Any outbox, identity, endpoint, builder, or unexpected failure maps to fixed path-free `audit-delivery-unavailable`; raw errors and endpoint/path values are never exposed.

## Concurrency and boundaries

The composer holds no write lock across calls and never claims an occurrence. A prepared descriptor is only a local snapshot and may become stale immediately; any future transport must revalidate/claim the same stream ID and exact FIFO head before dispatch. Identity may be created if the outbox drains between the first read and ensure. This slice adds no Agent/server/API/Web wiring and does not prove remote delivery, exactly-once behavior, production monitoring, or Gold.
