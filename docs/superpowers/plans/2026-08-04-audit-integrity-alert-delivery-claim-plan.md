# Audit integrity alert delivery claim/lease implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Every production change follows behavior-specific RED -> observed RED -> minimal GREEN -> focused regression.

**Goal:** Implement the approved persistent claim, fencing, completion, release, and manual-ack exclusion contracts without network I/O.

**Architecture:** A dedicated canonical claim-state module owns parsing and persistence. A delivery-claim coordinator combines that state, stable stream identity, outbox head, owner identity, and the shared audit write lease. The outbox exposes one capability-guarded internal acknowledgement primitive; its public acknowledgement refuses any persisted claim.

**Tech Stack:** Node.js 24 ESM, `node:test`, existing safe-data files, existing audit write queue/process lock, existing LaunchAgent process identity reader. No new dependency.

## Global constraints

- Exact design authority: `docs/superpowers/specs/2026-08-04-audit-integrity-alert-delivery-claim-design.md`.
- No `.env`, credentials, auth directories, network calls, server/Agent/Web wiring, launchd, deployment, or Gold promotion.
- Only Grok implementer may write in its strict no-`.git` isolation copy; Codex integrates an exact allowlist.
- Existing untracked `.superpowers/`, Task 6 plans/spec, and `package-lock.json` remain untouched.
- Existing public errors remain exactly `audit-delivery-unavailable` and path-free.

---

### Task 1: Canonical claim state

**Files:**
- Create: `test/audit-integrity-alert-delivery-claim-state.test.js`
- Create: `src/audit-integrity-alert-delivery-claim-state.js`

**Produces:**

```js
AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH
AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_MAX_BYTES
loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease)
publishAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease, state)
assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease)
```

- [ ] Write tests with literal canonical idle/claimed bytes; validate exact keys, UUIDv4, safe sequence/PID, exact nested identity fields, millisecond UTC timestamps, `claimedAt < expiresAt`, mode `0600`, frozen copies, missing-as-idle, exact post-write readback, oversize, BOM, duplicate/extra/reordered keys, hostile values, symlink/directory leaf, wrong-root/missing/expired lease, and fixed path-free error.
- [ ] Run `node --test test/audit-integrity-alert-delivery-claim-state.test.js`; expected RED is only `ERR_MODULE_NOT_FOUND` / `claim state implementation missing`.
- [ ] Implement minimal canonical parser/serializer/load/publish under an active same-root lease. No clock, process, outbox, stream, or request imports.
- [ ] Run the focused test to GREEN, then `node --check src/audit-integrity-alert-delivery-claim-state.js`.

### Task 2: Lease-guarded outbox acknowledgement and public exclusion

**Files:**
- Modify: `test/audit-integrity-alert-outbox.test.js`
- Modify: `src/audit-integrity-alert-outbox.js`

**Produces:**

```js
acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(resolvedRoot, lease, sequence)
```

- [ ] Add RED tests proving public ack succeeds in idle/missing claim state, fails without mutation for every claimed state including expired timestamps, and the internal primitive rejects missing/wrong/expired leases while removing only the exact head under a valid lease.
- [ ] Run `node --test test/audit-integrity-alert-outbox.test.js`; expected RED is missing exclusion/internal API, not fixture/import noise.
- [ ] Refactor the existing locked head mutation into the lease-guarded primitive; public ack enters the queue, calls `assertNoAuditIntegrityAlertDeliveryClaim`, then delegates. Preserve all existing receipt shapes.
- [ ] Run focused outbox plus claim-state tests to GREEN.

### Task 3: Persistent claim coordinator

**Files:**
- Create: `test/audit-integrity-alert-delivery-claim.test.js`
- Create: `test/helpers/audit-integrity-alert-delivery-claim-contender.js`
- Create: `src/audit-integrity-alert-delivery-claim.js`

**Consumes:** claim-state APIs, stream ensure/read, outbox read/internal ack, request builder, shared queue, `createLaunchAgentProcessIdentityReader`.

**Produces:**

```js
AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_TTL_MS // exactly 120000
claimAuditIntegrityAlertDelivery(dataDir, endpoint, now)
completeAuditIntegrityAlertDelivery(dataDir, claim)
releaseAuditIntegrityAlertDelivery(dataDir, claim)
```

- [ ] Add RED tests for exact empty/busy/claimed/completed/already-completed/released receipts; no stream creation for empty outbox; request built before claim write; time boundaries `expiresAt-1`, `expiresAt`, `expiresAt+1`; live owner, dead owner, PID reuse, boot mismatch, unavailable observation, and live-owner clock rollback.
- [ ] Add stale fencing RED: replace claim A with B, then A complete/release must fail without changing head or B.
- [ ] Add crash RED with an injected claim-idle write failure after successful head removal; the next complete must return `already-completed`, clear residual state, and preserve successor head.
- [ ] Add stream drift, impossible head relation, corrupt state, hostile capability, nested enqueue, and no-network/source import boundaries.
- [ ] Add real multi-process contention: two contenders on one root yield one claimed and one busy; kill the owner and prove a fresh process reclaims without waiting for wall-clock expiry.
- [ ] Run focused tests; expected RED is `delivery claim implementation missing` and missing stream read API only.
- [ ] Implement the minimal coordinator and any narrow read-only stream API required by the approved design. No transport or scheduler.
- [ ] Run focused claim/outbox/stream/request/process-lock tests to GREEN.

### Task 4: Detached old-HEAD RED and documentation honesty

**Files:**
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`

- [ ] In a detached worktree at parent HEAD, apply only the final test/helper changes. Run the claim tests and record a behavior-specific RED caused by absent claim APIs, not syntax/import/fixture noise.
- [ ] Update documentation to say durable local claim/fencing is delivered while HTTPS transport, retry, dead-letter, scheduler, real delivery, and Gold remain absent/partial.
- [ ] Add honesty tests that reject claims of exactly-once, remote notification delivery, production-hardening ready, or Gold.
- [ ] Run claim-focused and documentation tests to GREEN.

### Task 5: Review and verification

- [ ] Grok fresh reviewer, plan-only, checks the exact diff against this design; no resume/continue and no writes.
- [ ] Codex verifies every finding against code and returns P0/P1 to the same Grok implementer only as a complete finding list.
- [ ] Run `node --test` for all claim/outbox/stream/request/process-lock suites.
- [ ] Run `npm test`; require zero failures and only the repository's already-known environment-gated skips.
- [ ] Run the crash drill and real multi-process owner-kill recovery as the required resilience boundary.
- [ ] Run `git diff --check`, exact allowlist, sensitive-path scan, staged-file audit, and confirm protected untracked files are unchanged.
- [ ] Commit using `feat: add audit alert delivery claims`, push, verify local HEAD equals upstream, then continue to bounded HTTPS transport.
