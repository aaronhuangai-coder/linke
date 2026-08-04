# Audit integrity alert delivery claim/lease design

**Status:** approved continuation design after GLM-5.2 adversarial review

**Goal:** Replace snapshot-only delivery preparation with a persistent, fenced claim that can be completed or released without allowing a stale worker to remove a successor's FIFO head.

**Non-goals:** This slice does not perform HTTPS I/O, retry, scheduling, Agent/API/Web wiring, deployment, or Gold promotion. Delivery remains at-least-once; the existing stream-scoped idempotency key remains mandatory.

## Current boundary

- `audit/integrity-alert-outbox.json` is the monotonic FIFO source of truth.
- `audit/integrity-alert-delivery-stream.json` is the stable UUIDv4 namespace.
- `enqueueAuditIntegrityWriteTask` is the only same-root local write admission path and combines an in-process FIFO with `/usr/bin/lockf` multi-process exclusion.
- `prepareAuditIntegrityAlertDelivery` remains a clearly labelled snapshot-only legacy helper and must not be used by transport.
- Network filesystems, cross-host locking, malicious same-user mutation, and real remote notification delivery remain outside this slice.

## Chosen architecture

Use a separate, always-canonical claim state rather than migrating the stable outbox schema or relying on create/delete lock files.

Path: `audit/integrity-alert-delivery-claim.json`

The file is one compact JSON object followed by exactly one newline, mode `0600`, with exact field order:

```json
{"schemaVersion":1,"status":"idle","claimId":null,"streamId":null,"sequence":null,"ownerPid":null,"bootSessionIdentity":null,"processStartIdentity":null,"claimedAt":null,"expiresAt":null}
```

For `claimed`, the null fields become:

- `claimId`: canonical lowercase UUIDv4.
- `streamId`: canonical lowercase UUIDv4 equal to the current stream file.
- `sequence`: positive safe integer equal to the FIFO head at claim publication.
- `ownerPid`: positive safe integer.
- `bootSessionIdentity` and `processStartIdentity`: exact `{available:true,value:<non-empty path-free digest string>}` values from the existing process identity reader.
- `claimedAt` and `expiresAt`: canonical UTC ISO strings with exactly millisecond precision and `Z`; `expiresAt = claimedAt + 120000 ms`.

The maximum claim state size is fixed and exported. Parsing accepts no alternate key order, whitespace, escapes, duplicate fields, extra fields, unsafe integers, noncanonical UUID/timestamps, symlink leaf, directory leaf, BOM, or extra newline.

## Public interfaces

```js
claimAuditIntegrityAlertDelivery(dataDir, endpoint, now)
completeAuditIntegrityAlertDelivery(dataDir, claim)
releaseAuditIntegrityAlertDelivery(dataDir, claim)
```

`now` is a canonical ISO timestamp supplied explicitly by the future scheduler/transport. The claim module never reads `Date.now`. The exact claim capability is `{claimId,streamId,sequence}`; hostile or extra fields are rejected before filesystem mutation.

Claim receipts are deeply frozen and exact-key:

- Empty: `{schemaVersion:1,status:'empty',claimId:null,streamId:null,sequence:null,expiresAt:null,request:null}`.
- Busy: `{schemaVersion:1,status:'busy',claimId:null,streamId:<current>,sequence:<head>,expiresAt:<persisted>,request:null}`. The active claim capability is never disclosed.
- Claimed: `{schemaVersion:1,status:'claimed',claimId,streamId,sequence,expiresAt,request}`.
- Complete: `{schemaVersion:1,status:'completed'|'already-completed',completed:true,streamId,sequence,pendingCount}`. It does not echo `claimId`.
- Released: `{schemaVersion:1,status:'released',released:true,streamId,sequence}`. It does not echo `claimId`.

All failures collapse to the existing path-free `audit-delivery-unavailable` error.

## Claim algorithm

1. Validate `now` and obtain a fully available current boot/process identity. Any unavailable identity fails closed.
2. Ensure the stable stream identity outside the queue.
3. Enter `enqueueAuditIntegrityWriteTask`; nested entry inherits the existing fail-closed guard.
4. Re-read the stream and outbox under the active lease. A stream mismatch, missing-after-ensure stream, corrupt stream, or unsafe state fails closed.
5. Load claim state. Missing means logical idle; corrupt/unsafe does not.
6. Classify the FIFO relationship:
   - `claim.sequence === head.sequence`: current-head claim.
   - `claim.sequence < head.sequence`, or empty outbox with `nextSequence > claim.sequence`: provable post-ack residual.
   - `claim.sequence > head.sequence`, or empty outbox with `nextSequence <= claim.sequence`: impossible/ambiguous and fail-closed.
7. A provable residual is atomically rewritten to idle before continuing or returning `already-completed` from completion.
8. For a current-head claim, observe its owner with the existing process identity reader:
   - `dead`, `pid-reused`, or `boot-session-mismatch`: immediately replace with a fresh claim.
   - `alive-same-owner` and `now < expiresAt`: return busy.
   - `alive-same-owner` and `now >= expiresAt`: replace with a fresh claim. The old token is fenced; at-least-once duplicates remain possible and use the stable idempotency key.
   - `unavailable`: fail closed.
   - `now < claimedAt` while the owner is alive: return busy and expose the existing expiry only. Do not guess through clock rollback.
9. Build the pure HTTPS request before publishing a new claim. Persist and exact-readback the claim, then return the claimed receipt.

Expiry alone does not invalidate the persisted token. It becomes stale only when a successor claim with a new `claimId` is published.

## Completion, release, and manual acknowledgement

Completion enters the same queue, validates the exact persisted capability and stream, and classifies the head before mutation:

- Exact head: use a lease-guarded internal outbox acknowledgement primitive. Atomically publish outbox-without-head first, then publish idle claim.
- Provable post-ack residual: publish idle claim and return `already-completed`; never remove the current head.
- Any other relation or capability mismatch: fail closed without touching outbox or claim.

The write order is deliberate. A crash after outbox publication but before idle publication leaves a provable residual. Reversing the order would open a second claimant before the first head was removed.

Release changes claimed to idle only when all three capability fields match. A stale or foreign release fails closed.

The existing public/manual outbox acknowledgement must consult the claim state while holding the same write lease and fail closed whenever status is `claimed`, regardless of deadline. Only delivery completion may use the lease-guarded internal acknowledgement primitive. This is an intentional safety tightening.

## Resilience

**Normal state:** empty+idle, or a nonempty FIFO with zero/one exact persisted claim for its head.

**Recovery anchor:** monotonic `nextSequence` and FIFO head, stable stream UUID, exact claim record, and boot/process owner identity.

**Bounded failures:** malformed bytes, unsafe paths, stream drift, impossible sequence relations, wrong capabilities, unavailable owner observation, clock rollback with a live owner, and the existing five-second process-lock timeout all fail closed.

**Automatic recovery:** dead/reused/rebooted owner claims can be replaced immediately; live expired claims can be replaced; post-ack residuals become idle idempotently. Ambiguous states require explicit operator repair in a later slice.

**Detection:** tests cover byte identity, symlink/corruption, time boundaries, stale fencing, manual-ack exclusion, post-ack crash recovery, multi-process contention, killed owner recovery, and lock timeout. The highest-risk drill is `outbox publish succeeds -> claim idle publish fails -> next completion returns already-completed without removing the successor head`.

## Adversarial-review adjudication

- Adopted: exact byte grammar, explicit head classifier, exact receipts, stream-drift fail-closed, nested enqueue rejection, lock-timeout coverage, and old-HEAD behavior RED.
- Strengthened: wall-clock TTL is paired with boot/process liveness. Dead/PID-reused/rebooted owners recover without waiting for wall time.
- Rejected: allowing manual acknowledgement merely because the deadline passed. Deadline does not revoke the persisted capability and cannot safely authorize a bypass.

## Gold impact

This closes only the local durable claim/fencing prerequisite. `production-hardening` remains partial until bounded HTTPS transport, response validation, retry/backoff/dead-letter handling, managed scheduling, observability, and real staging delivery evidence are complete. No Gold score changes in this slice.
