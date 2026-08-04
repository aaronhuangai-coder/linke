# Audit integrity alert delivery stream ensure CLI design

## Goal

Expose the stable local stream identity foundation through one explicit operator-controlled Agent command:

`audit-integrity-alert-delivery-stream-ensure --data-dir <path>`

This command provisions or reads only the local non-secret stream namespace. It does not read or acknowledge the alert outbox, build/send a request, access credentials, start a scheduler, or claim remote delivery.

## Contract

- Raw argv must be exactly the command plus `--data-dir <nonblank>` in that order; parsed keys are exact. Invalid argv prints fixed path-free `arguments are invalid`, no stdout, exit 1, and performs no filesystem access.
- Valid argv calls only `ensureAuditIntegrityAlertDeliveryStream(dataDir)` once. Created/existing receipts print as one compact JSON line and exit 0; the stream UUID is non-secret, while the data path is never printed.
- Registered `audit-delivery-unavailable` failures print fixed `<command> refused`, no stdout, exit 2. Unexpected post-validation failures print fixed `<command> failed`, no stdout, exit 1. No raw error, path, stack, errno, endpoint, or credential is exposed.
- The command is Agent-only and appears in help. No server/API/Web route, network transport, outbox operation, automatic invocation, retry, timer, or background process is added.

## Gold boundary

This closes only explicit local stream identity provisioning/visibility. Identity deletion can still create a new namespace on a later ensure. Production-hardening remains partial and Gold remains 6/3/0/9.
