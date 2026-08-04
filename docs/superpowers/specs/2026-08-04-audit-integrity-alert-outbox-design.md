# Audit Integrity Alert Outbox Foundation Design

## 1. Outcome

Add a bounded, local, durable outbox foundation for issued audit-integrity monitor alerts while preserving the existing `audit-integrity-monitor` command as strictly read-only.

This closes only the local durable handoff gap. It does not deliver remote notifications, a managed scheduler, background polling, production monitoring readiness, or Gold.

## 2. Selected design

Selected: a separate library module with explicit enqueue/read/FIFO-ack APIs.

Rejected:

- changing `audit-integrity-monitor` to write, because that breaks its frozen read-only contract;
- adding a server timer, because lifecycle and scheduling are separate work;
- adding webhook/email delivery, because credentials, retries, and external effects require separate approval and acceptance;
- unbounded JSONL append, because a failed consumer would create unbounded local growth;
- overwriting a single latest alert, because that loses alert occurrences.

## 3. Scope

New module: `src/audit-integrity-alert-outbox.js`.

Public APIs:

- `enqueueAuditIntegrityAlertOutbox(dataDir, report)`
- `readAuditIntegrityAlertOutbox(dataDir)`
- `acknowledgeAuditIntegrityAlertOutboxHead(dataDir, sequence)`

No CLI/API/Web wiring in this slice. That wiring is a separate follow-up after the storage contract is closed.

The outbox module never calls `runAuditIntegrityMonitor`. A future composer must first `await` the run-once monitor to completion, after its read lease has been released, and only then call enqueue with the returned report. Calling enqueue from inside any active audit-integrity queue task is forbidden and must fail closed through the existing nested-enqueue guard. No reentrant lock path is introduced.

## 4. Issuance and sanitization

`enqueueAuditIntegrityAlertOutbox` accepts only an in-process report accepted by both:

- `auditIntegrityMonitorExitCode(report)`; and
- `formatAuditIntegrityMonitorReportJson(report)`.

Forged, hostile Proxy, mutable, or semantically inconsistent reports fail before filesystem access.

A healthy issued report performs zero filesystem access and returns an `ignored-healthy` receipt.

An alert report is reduced to the following fixed, path-free entry:

```json
{
  "sequence": 1,
  "checkedAt": "2026-08-04T12:00:00.000Z",
  "code": "integrity-alert",
  "recoveryRequired": false,
  "nextAction": "investigate-integrity",
  "reasonCode": null
}
```

The outbox never stores paths, store bytes, event bodies, hashes, tokens, credentials, hostnames, usernames, process IDs, commands, stdout, stderr, or raw errors.

Persisted entry semantic matrix:

| code | recoveryRequired | nextAction | reasonCode |
| --- | --- | --- | --- |
| `uninitialized` | false | `initialize-via-production-write` | null |
| `state-missing` | false | `investigate-integrity` | null |
| `recovery-required` | true | `run-explicit-recovery` | null |
| `rotation-recovery-required` | true | `run-explicit-recovery` | exact `audit-integrity-rotation-recovery-required` |
| `integrity-alert` | false | `investigate-integrity` | null or path-free lowercase kebab reason |
| `io-alert` | false | `investigate-integrity` | null or path-free lowercase kebab reason ending in `-io-error` |

`checkedAt` is exactly the canonical 24-byte UTC millisecond form `YYYY-MM-DDTHH:mm:ss.sssZ` and must round-trip through `Date#toISOString`.

## 5. Durable state

Root-relative path:

```text
audit/integrity-alert-outbox.json
```

Exact state:

```json
{
  "schemaVersion": 1,
  "nextSequence": 2,
  "entries": []
}
```

Rules:

- exact key order and exact entry key order;
- state file maximum: 1 MiB;
- maximum pending entries: 256;
- sequence starts at 1, is contiguous and strictly increasing;
- `nextSequence` equals last sequence plus one, or 1 for an empty never-used state;
- `nextSequence` must remain a safe integer;
- JSON is strict single document with one trailing newline;
- unknown keys, wrong types, invalid enums, contradictory code/action/recovery combinations, gaps, duplicates, oversize, symlink/unsafe leaf, or corrupt JSON fail closed;
- no silent reset, truncate, skip, drop-oldest, or bootstrap over corrupt state.
- when 256 pending entries or the 1 MiB publication bound would be exceeded, enqueue fails with fixed `audit-delivery-unavailable`; it never overwrites or drops an unacknowledged entry.
- increment past `Number.MAX_SAFE_INTEGER` fails with the same fixed error and publishes nothing.

## 6. Concurrency and publication

Writes run under the existing same-root `enqueueAuditIntegrityWriteTask` queue and macOS process lock. The module validates the issued lease before state mutation.

This is the only write-lock path. The module must not acquire the process lock directly, must not enqueue while another same- or cross-root audit queue lease is active, and must not attempt reentrant locking.

The lock contract is macOS user-host local only (`/usr/bin/lockf`); this slice does not claim Linux portability, network-filesystem correctness, distributed locking, or cross-host coordination.

Publication uses `safeAtomicWriteText` with mode `0600`. Enqueue and acknowledgement load, validate, transform, and publish inside one lease.

Read is safe and read-only. It returns a deeply frozen defensive snapshot and never repairs state.

## 7. Behavior

### Enqueue

- healthy issued report: zero filesystem access; receipt `ignored-healthy`, `queued:false`, sequence/pending count null;
- alert issued report: append one occurrence; receipt `queued`, `queued:true`, assigned sequence and current pending count;
- same report may be enqueued multiple times; occurrences are preserved;
- capacity full, corrupt state, IO failure, process-lock failure, unsafe path, or publish failure: fixed `audit-delivery-unavailable`, no raw details.

### Read

- absent state: frozen empty snapshot with `nextSequence:1` and zero entries; no write;
- valid state: deeply frozen defensive snapshot;
- invalid/unsafe/oversize/IO: fixed `audit-delivery-unavailable`.

### FIFO acknowledgement

- only the exact current head sequence may be acknowledged;
- empty/absent returns `empty`, `acknowledged:false`, no write;
- wrong, stale, non-head, unsafe integer, or future sequence fails closed;
- successful ack removes exactly one head occurrence and atomically republishes state;
- acknowledgement is local queue state only; it does not prove remote delivery.

There are no `delivering`, `acking`, reservation, visibility-timeout, or in-flight states in this foundation. Enqueue and exact-head acknowledgement are single atomic state transitions under one lease, so a crash before publish leaves the old state and a successful atomic publish leaves the new state. Retry is explicit at the caller boundary.

## 8. Error contract

Use existing registered `ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE` for every public storage/concurrency failure. The public error name, code, and message are fixed and path-free. No new error-code registry entry is added.

Programmer misuse of a forged report or invalid acknowledgement sequence is also mapped to the same fixed public error at this module boundary.

## 9. Evidence ceiling

Allowed claim:

`bounded local audit-integrity alert outbox storage foundation`

Required negative claims:

- not remote notification delivery;
- not managed scheduler;
- not production monitoring ready;
- not end-to-end production audit delivery;
- no delivery retry/backoff/dead-letter policy yet;
- no CLI/API/Web consumer wiring yet;
- production-hardening remains partial;
- not Gold.

## 10. Acceptance

- behavior-specific old-HEAD RED for enqueue/read/FIFO ack;
- healthy zero-filesystem proof;
- forged report zero-filesystem proof;
- repeated occurrence preservation;
- capacity 256 boundary and 257th fail-closed;
- corrupt/extra-key/gap/duplicate/unsafe path fail-closed without rewrite;
- same-root concurrent enqueue produces exact contiguous unique sequences;
- ack head success, empty no-write, non-head fail-closed;
- persisted bytes and public receipts contain none of the forbidden material classes;
- focused, related, full suite, diff check, independent adversarial and closure reviews.
