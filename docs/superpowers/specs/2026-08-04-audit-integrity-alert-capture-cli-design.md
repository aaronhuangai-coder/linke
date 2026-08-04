# Audit Integrity Alert Capture CLI Design

## Outcome

Add one explicit local Agent command, `audit-integrity-alert-capture --data-dir <path>`, that runs the existing read-only monitor to completion and then hands its issued report to the bounded local outbox.

The existing `audit-integrity-monitor` command and monitor module remain strictly read-only. This slice adds no read/ack consumer command, network delivery, timer, background loop, managed scheduler, service installation, remote notification, or production-monitoring claim.

## Contract

The command accepts exactly three raw argv elements:

```text
audit-integrity-alert-capture --data-dir <non-empty path not starting with -->
```

Invalid argv exits 1 with exactly `Error: audit-integrity-alert-capture arguments are invalid` and never echoes input.

After valid argv, the command:

1. awaits `runAuditIntegrityMonitor(dataDir)` completely;
2. calls `enqueueAuditIntegrityAlertOutbox(dataDir, report)` only after the monitor returns;
3. writes exactly one compact JSON receipt plus one newline;
4. returns exit 0 for `ignored-healthy` and exit 2 for a successfully queued alert, using the issued report's existing monitor exit helper.

Known audit-integrity refusal errors, including a full/corrupt/unwritable outbox, print exactly `Error: audit-integrity-alert-capture refused`, emit no stdout, and exit 2. Other post-validation failures print exactly `Error: audit-integrity-alert-capture failed`, emit no stdout, and exit 1.

The receipt is the existing closed outbox receipt only. It contains no path, report body, hashes, token, credentials, stdout/stderr, hostname, username, PID, or raw error.

## Safety and concurrency

The CLI never composes enqueue from inside an audit-integrity queue lease. Monitor completion releases its read task before enqueue obtains the existing same-root queue/process lock. No new lock path is added.

Cold empty data roots produce an issued `uninitialized` alert, persist one occurrence, output `queued`, and exit 2. Repeated explicit invocations preserve repeated occurrences. Healthy state returns `ignored-healthy` without creating the outbox.

## Evidence ceiling

Allowed claim: `explicit local audit-integrity alert capture CLI`.

Required limits: no CLI read/ack consumer yet; not remote notification delivery; not managed scheduler; not background monitoring; not production monitoring ready; not end-to-end production audit delivery; production-hardening remains partial; not Gold.
