# Audit Integrity Alert Outbox Foundation Implementation Plan

## Phase 0: freeze contracts

- Review the design against current monitor, safe-data, queue, and process-lock contracts.
- Freeze allowlist and old-HEAD behavior RED.
- No production host, network, Keychain, launchctl, email, or external delivery actions.

## Phase 1: schema and parser RED/GREEN

Files:

- `src/audit-integrity-alert-outbox.js`
- `test/audit-integrity-alert-outbox.test.js`

Implement strict state/entry validation, fixed error mapping, deep-frozen defensive snapshots, absent-state read, and serialization bounds.

Checkpoint: parser/reader tests pass; corrupt state never rewrites.

## Phase 2: enqueue RED/GREEN

Implement issued-report validation, healthy zero-filesystem result, alert reduction, same-root queue/process-lock write, capacity gate, atomic publication, and fixed receipt.

The module does not run the monitor. Tests and future composition must await monitor completion before enqueue; nested/reentrant enqueue remains fail-closed.

Checkpoint: repeated alerts produce contiguous occurrence sequences; capacity boundary and failure paths are deterministic.

## Phase 3: FIFO ack RED/GREEN

Implement exact-head acknowledgement under the same queue/lock and atomic publication.

No transient delivery/acking state or timeout recovery is introduced; crash behavior is the existing atomic old-or-new publication boundary.

Checkpoint: exact head removes one; empty is no-write; stale/non-head/invalid fails closed.

## Phase 4: adversarial and concurrency evidence

Add tests for hostile Proxy reports, extra keys, symlink leaf, corrupt JSON, oversize state, duplicate/gapped sequences, concurrent enqueue, publish failure, and leak-free fixed errors/receipts.

Use same-process concurrent calls for queue ordering and independent child processes for the local macOS process-lock sequence proof. Keep the existing platform limitation explicit.

Checkpoint: focused suite plus audit-integrity queue/process-lock/safe-data regressions pass.

## Phase 5: documentation and Gold honesty

Update README and production-hardening evidence with only the allowed code-stage claim and all required negative claims. Do not change the current monitor read-only contract.

Checkpoint: README/Gold/version honesty scanners pass.

Gold partial is an honesty ceiling, not a waiver: capacity, bounds, strict schema, zero-filesystem paths, concurrency, FIFO, corruption, and leak tests remain mandatory.

## Phase 6: full verification and delivery

- full test suite;
- `git diff --check`;
- GLM adversarial review;
- Qwen statistics;
- Kimi closure review;
- exact allowlist stage;
- conventional commit and push under the active user authorization.

## Deferred follow-up

Separate slice: explicit local CLI composition for monitor → enqueue and outbox read/ack. Remote delivery, scheduler, retries/backoff/dead-letter, and production host acceptance remain separately gated.
