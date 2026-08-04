# Audit Integrity Alert Outbox CLI Design

## Outcome

Add two explicit local Agent commands over the closed outbox library contract:

- `audit-integrity-alert-outbox-read --data-dir <path>`
- `audit-integrity-alert-outbox-ack --data-dir <path> --sequence <canonical positive safe integer>`

This closes only the local CLI read/ack consumer gap. It adds no capture loop, API/Web route, network transport, remote notification, retry/backoff/dead-letter policy, managed scheduler, background process, service installation, or production-monitoring claim.

## Strict argv and output

Read accepts exactly three raw argv tokens. Ack accepts exactly five, with `--sequence` after `--data-dir`; decimal input has no sign, whitespace, exponent, fraction, or leading zero and must parse as a positive safe integer.

Invalid argv exits 1 with a command-specific fixed `arguments are invalid` message. Input values are never echoed.

Read prints the existing closed, deeply frozen state as one compact JSON line and exits 0. An absent state prints the canonical empty snapshot and creates no outbox.

Ack calls only `acknowledgeAuditIntegrityAlertOutboxHead`. Exact-head success prints its closed receipt and exits 0. Empty state prints the closed `empty` receipt, exits 0, and creates no outbox. Wrong/stale/future/non-head sequence and storage/lock errors print a fixed `refused` message, no stdout, and exit 2. Unexpected post-validation errors use a fixed `failed` message and exit 1.

## Safety boundary

Both commands are local and path-free on stdout/stderr. Read does not repair or write. Ack removes exactly one current head under the existing same-root queue/process lock and atomic publication path. A local ack proves only local queue removal; it does not prove a remote delivery occurred.

Gold remains 6 ready / 3 partial / 0 blocked / 9. Production-hardening remains partial: no API/Web consumer, no remote notification delivery, no managed scheduler, no background monitoring, no production monitoring readiness, and no end-to-end production audit delivery.
