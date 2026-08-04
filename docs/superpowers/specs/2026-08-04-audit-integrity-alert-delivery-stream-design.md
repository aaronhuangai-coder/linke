# Audit integrity alert delivery stream identity design

## Goal

Provision one stable, non-secret canonical UUIDv4 namespace per local audit-integrity alert outbox stream. This closes only stream identity creation/persistence for the pure delivery envelope; it performs no network delivery, credential access, outbox acknowledgement, retry, scheduling, or production monitoring.

## Contract

- New module `src/audit-integrity-alert-delivery-stream.js` exports `AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH` and `ensureAuditIntegrityAlertDeliveryStream(dataDir)`.
- State path is fixed to `audit/integrity-alert-delivery-stream.json`, mode 0600, exact canonical bytes `{"schemaVersion":1,"streamId":"<lowercase UUIDv4>"}\n`, and a 128-byte read bound.
- The first explicit ensure on an existing safe data root acquires the existing same-root audit write queue/process lock, generates a UUIDv4 with `node:crypto.randomUUID`, atomically publishes it, and returns a deeply frozen exact `created` receipt.
- Later ensures validate exact keys/order/bytes and return the same stream ID in an exact `existing` receipt without rewriting. Same-root concurrent and independent-process ensures must converge on one persisted ID.
- Missing/non-directory data roots, corrupt/noncanonical/oversized state, unsafe/symlink leaves, lock failures, random generation failures, or I/O failures map to fixed path-free `audit-delivery-unavailable`; existing bytes and symlink targets are never repaired or rewritten.

## Boundaries

The module does not import or call delivery-envelope builders, outbox enqueue/read/ack, monitor, Agent/server/Web, network, timers, environment variables, credentials, Keychain, or child processes. Deleting the identity file can create a new namespace on the next explicit ensure; this foundation does not provide deletion resistance, external authenticity, remote registration, delivery, exactly-once semantics, or Gold.
