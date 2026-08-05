# Audit Integrity Alert Durable Retry / Backoff / Dead-Letter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement architecture C durable retry, fixed backoff, attempt ledger, explicit `tick(now)`, detailed HTTPS executor classification, and bounded dead-letter quarantine for audit-integrity alert delivery—without managed scheduling, host wiring, or Gold promotion.

**Design:** [2026-08-05-audit-integrity-alert-durable-retry-design.md](../specs/2026-08-05-audit-integrity-alert-durable-retry-design.md)

**Worktree baseline:** `8d1712e3c9a3f59255d56a698133fd9d260bf140`

**Architecture:** Outbox/claim schemas stay frozen. New lifecycle WAL + dead-letter FIFO carry attempt/backoff/quarantine state. All durable writes use existing same-root shared write lease. Advancement is only `tickAuditIntegrityAlertDelivery(dataDir, endpoint, now, policy)`—at most one head and one detailed network attempt per tick.

**Tech Stack:** Node.js ESM, Node test runner (`node --test`), existing Linke error/claim/outbox/write-queue/destination-policy/transport modules, `node:crypto` SHA-256, `safe-data-files` atomic publish mode `0600`.

---

## Global Constraints

- Behavior-type TDD only: freeze RED on missing capability first; prove old-HEAD RED authenticity before GREEN.
- Each Task is an independent commit and push with exact staging allowlist.
- No `setInterval`, `sleep` loops, background workers, LaunchAgent timers, or managed scheduler in any Task.
- No Agent/API/Web route wiring; no credentials/env loaders; do not touch `package-lock.json`.
- No real external network in tests; inject fake transport/DNS/authorize only.
- Public errors remain fixed path-free `audit-delivery-unavailable`.
- Delivery semantics remain at-least-once; never claim exactly-once.
- Gold remains partial **6/3/0/9**; `production-hardening` remains partial; not production-hardening ready; not remote notification delivery; not production monitoring ready; not end-to-end production audit delivery.
- Existing user-owned untracked files remain outside every staging allowlist.
- Fresh read-only review gate per Task before commit; adjudicate every finding; re-run focused GREEN after fixes.
- Forbidden diffusion surfaces unless a Task explicitly lists them: `src/agent.js`, `src/server.js`, `src/web/**`, LaunchAgent modules, config credential paths, deploy scripts.
- Do not modify `src/audit-integrity-alert-delivery-claim.js` in any Task of this plan.
- Every Task’s commit sequence must include exact `git add` of the Task allowlist, then `git diff --cached --check`, then `git diff --cached --name-only`, then `git commit`, then `git push`. Cached name list must equal the Task allowlist exactly.

### Frozen constants (must match design)

```text
AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS = 8
AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS = [30000, 120000, 600000, 1800000, 7200000, 28800000, 86400000]
AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH = audit/integrity-alert-delivery-lifecycle.json
AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES = 16384
AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH = audit/integrity-alert-dead-letter.json
AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES = 256
AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES = 1048576
CLAIM_TTL_MS (existing) = 120000
Idempotency key = audit-integrity-alert:<streamId>:<sequence>
Retryable HTTP = 408, 425, 429, 500..599
Policy input kinds = accepted | retryable-rejected | terminal-rejected | uncertain
Persisted uncertain outcome.kind = unknown
```

### Full suite (Task 8 only for mandatory full run)

```bash
npm test
```

Expected full suite: zero failures aside from repository-known environment-gated skips only.

### old-HEAD RED authenticity pattern

For each new test file, before GREEN production code:

1. Create only the test file using a guarded dynamic import that swallows **module-not-found only**.
2. Syntax errors and other load errors must **rethrow**.
3. Run the Task’s exact `node --check` and `node --test` commands against baseline without the new production module.
4. Expected: syntax check exit 0; test fails solely with the Task’s missing-API sentinel message; no fixture/import/certificate/network noise.

Guard example (Task 1 real path; other tasks substitute their own module path the same way):

```js
import assert from 'node:assert/strict';
import test from 'node:test';

let mod = Object.freeze({});
try {
  mod = await import('../src/audit-integrity-alert-retry-policy.js');
} catch (error) {
  const code = error && error.code;
  if (code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

test('exports the pure retry policy contract', () => {
  assert.equal(
    typeof mod.computeAuditIntegrityAlertRetryDueAt,
    'function',
    'pure retry policy implementation missing',
  );
});
```

---

## Task 1: Pure retry policy

**Files:**

- Create: `src/audit-integrity-alert-retry-policy.js`
- Create: `test/audit-integrity-alert-retry-policy.test.js`

**Allowed files only:** the two files above.

**Forbidden diffusion:** transport, claim, outbox, lifecycle, DLQ, agent/server/web, package-lock.

**Interfaces:**

```js
export const AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS = 8;
export const AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS = Object.freeze([
  30_000, 120_000, 600_000, 1_800_000, 7_200_000, 28_800_000, 86_400_000,
]);
export function computeAuditIntegrityAlertRetryDueAt(lastAttemptAtIso, attemptCountAfterFailure);
export function computeAuditIntegrityAlertUncertainDueAt(
  lastAttemptAtIso,
  attemptCountAfterFailure,
  claimExpiresAtIso,
);
export function classifyAuditIntegrityAlertRetryDecision(attemptCount, detailedOutcomeKind);
```

`detailedOutcomeKind` closed inputs:

```text
accepted
retryable-rejected
terminal-rejected
uncertain
```

`classifyAuditIntegrityAlertRetryDecision` returns a frozen closed decision among:

```text
accept-complete
retry-wait
uncertain-hold
dead-letter-terminal-http
dead-letter-attempts-exhausted-retryable
dead-letter-attempts-exhausted-uncertain
fail-closed
```

### Steps

- [ ] **Step 1: RED missing-API sentinel**

Use the guard example above with Task 1 path. Sentinel message: `pure retry policy implementation missing`.

- [ ] **Step 2: RED backoff math matrix**

For `lastAttemptAt = 2026-08-05T00:00:00.000Z` and attemptCountAfterFailure `1..7`, assert exact `nextAttemptAt` ISO strings. Reject `0`, `8`, `9`, non-canonical ISO, hostile objects with fixed unavailable.

- [ ] **Step 3: RED decision matrix**

| attemptCount | detailedOutcomeKind | decision |
| --- | --- | --- |
| 1..8 | accepted | accept-complete |
| 1..7 | retryable-rejected | retry-wait |
| 8 | retryable-rejected | dead-letter-attempts-exhausted-retryable |
| any | terminal-rejected | dead-letter-terminal-http |
| 1..7 | uncertain | uncertain-hold |
| 8 | uncertain | dead-letter-attempts-exhausted-uncertain |

- [ ] **Step 4: RED uncertain due max(backoff, claimExpiresAt)**

Prove `max` on both orderings; prove canonical output; pure function only (no watermark I/O).

- [ ] **Step 5: old-HEAD RED authenticity**

```bash
node --check test/audit-integrity-alert-retry-policy.test.js
node --test test/audit-integrity-alert-retry-policy.test.js
```

Expected: sentinel `pure retry policy implementation missing`; no syntax/import noise.

- [ ] **Step 6: GREEN minimal pure module**

No filesystem, no network, no `Date.now` policy reads (may use `Date.parse` / `toISOString` for pure conversion of provided inputs only).

- [ ] **Step 7: Focused verification**

```bash
node --check src/audit-integrity-alert-retry-policy.js test/audit-integrity-alert-retry-policy.test.js
node --test test/audit-integrity-alert-retry-policy.test.js
git diff --check
```

- [ ] **Step 8: Review gate, stage, commit, push**

```bash
git add src/audit-integrity-alert-retry-policy.js test/audit-integrity-alert-retry-policy.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat: add pure audit alert retry policy

Freeze max attempts, fixed backoff delays, and pure due/decision helpers
for durable retry without I/O or scheduling.
EOF
)"
git push
```

Cached name list must be exactly:

```text
src/audit-integrity-alert-retry-policy.js
test/audit-integrity-alert-retry-policy.test.js
```

**Commit message requirement:** must not mention scheduler, Gold ready, or exactly-once.

---

## Task 2: Lifecycle state parser/publisher

**Files:**

- Create: `src/audit-integrity-alert-delivery-lifecycle.js`
- Create: `test/audit-integrity-alert-delivery-lifecycle.test.js`

**Allowed files only:** the two files above.

**Allowed imports from existing code:** write-queue lease assert, safe-data-files, error-codes only.

**Forbidden diffusion:** retry coordinator, DLQ, transport, agent/server/web, outbox schema changes, claim schema changes.

**Interfaces:**

```js
export const AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH =
  'audit/integrity-alert-delivery-lifecycle.json';
export const AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES = 16_384;
export function loadAuditIntegrityAlertDeliveryLifecycle(dataDir);
export function publishAuditIntegrityAlertDeliveryLifecycleUnderLease(dataDir, lease, state);
export function assertAuditIntegrityAlertDeliveryLifecycleIdle(state);
export function createIdleAuditIntegrityAlertDeliveryLifecycle(lastObservedAt);
```

Exact key order and status matrix per design §6, including:

- open `in-flight`: outcome null, nextAttemptAt null, claim fields V
- `retry-wait` unknown: claim fields V
- `retry-wait` retryable release-pending: claim fields V
- `retry-wait` retryable release-completed: claim fields N
- `dead-letter-prepared`: top-level claim fields V
- `blocked` dead-letter-full only: all binding fields V

### Steps

- [ ] **Step 1: RED missing-API + constants**

Sentinel: `lifecycle state implementation missing`.

Guard import path: `../src/audit-integrity-alert-delivery-lifecycle.js` (module-not-found only; rethrow other errors).

- [ ] **Step 2: RED canonical fixtures**

Byte-identical compact JSON + `\n` fixtures for:

- idle with null watermark
- idle with retained watermark
- open in-flight
- retry-wait unknown (claim V)
- retry-wait retryable release-pending (claim V)
- retry-wait retryable release-completed (claim N)
- accepted-pending-completion
- dead-letter-prepared (full nested deadLetter object; top claim V)
- blocked dead-letter-full (all binding fields V)

Assert deep freeze on load snapshots.

- [ ] **Step 3: RED reject matrix**

Reject wrong key order, extra keys, missing keys, non-canonical ISO/UUID, attemptCount 9, illegal null bindings per status matrix (including in-flight with non-null outcome, retry-wait with null nextAttemptAt, blocked with null streamId), Proxy/accessor/symbol, BOM, double newline, oversize, symlink leaf.

- [ ] **Step 4: RED idle assertion helper**

`assertAuditIntegrityAlertDeliveryLifecycleIdle` accepts exact idle; rejects every non-idle fixture with fixed unavailable.

- [ ] **Step 5: RED publish under lease**

Missing/invalid lease fails closed zero write. Valid lease publishes mode `0600`, raw identity round-trip. Publisher rejects `lastObservedAt` older than previously stored when previous exists (load+compare under lease).

- [ ] **Step 6: old-HEAD RED authenticity**

```bash
node --check test/audit-integrity-alert-delivery-lifecycle.test.js
node --test test/audit-integrity-alert-delivery-lifecycle.test.js
```

- [ ] **Step 7: GREEN minimal lifecycle module**

Hostile object contract: `utilTypes.isProxy` first; exact `Reflect.ownKeys` order; enumerable data descriptors only; full-file raw identity.

- [ ] **Step 8: Focused verification**

```bash
node --check src/audit-integrity-alert-delivery-lifecycle.js test/audit-integrity-alert-delivery-lifecycle.test.js
node --test test/audit-integrity-alert-delivery-lifecycle.test.js test/audit-integrity-alert-retry-policy.test.js
git diff --check
```

- [ ] **Step 9: Review gate, stage, commit, push**

```bash
git add src/audit-integrity-alert-delivery-lifecycle.js test/audit-integrity-alert-delivery-lifecycle.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat: add audit alert delivery lifecycle WAL

Canonical single-object lifecycle state with exact key order, dual
retry-wait claim bindings, idle assertion, and lease-guarded publish.
EOF
)"
git push
```

---

## Task 3: Dead-letter FIFO store/read

**Files:**

- Create: `src/audit-integrity-alert-dead-letter.js`
- Create: `test/audit-integrity-alert-dead-letter.test.js`

**Allowed files only:** the two files above.

**Allowed imports from existing code:** write-queue lease assert, safe-data-files, error-codes, `node:crypto`.

**Forbidden diffusion:** tick coordinator, claim/outbox mutations, agent/server/web, scheduler.

**Interfaces:**

```js
export const AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH =
  'audit/integrity-alert-dead-letter.json';
export const AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES = 1_048_576;
export const AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES = 256;
export function readAuditIntegrityAlertDeadLetter(dataDir);
export function appendAuditIntegrityAlertDeadLetterUnderLease(dataDir, lease, entry);
export function fingerprintAuditIntegrityAlertDeadLetterRaw(rawText);
```

### Steps

- [ ] **Step 1: RED missing-API sentinel**

Sentinel: `dead-letter fifo implementation missing`.

Guard import path: `../src/audit-integrity-alert-dead-letter.js`.

- [ ] **Step 2: RED read empty/missing/ready**

Missing file → empty snapshot exact keys. Corrupt → fixed unavailable zero repair.

- [ ] **Step 3: RED append matrix**

- first append assigns `deadLetterSequence = 1`, `nextSequence = 2`
- first append **returns** a frozen durable actual post fingerprint with exact keys `sha256`, `byteLength`, `entryCount`, `nextSequence` whose values equal the durable DLQ bytes after that append (re-read raw identity)
- exact duplicate `(streamId, sequence)` deep-equal → idempotent; **returns** the current durable fingerprint (equals pre when no rewrite occurred; same exact keys)
- append signature remains exactly `(dataDir, lease, entry)` — no prepared `deadLetterPost` parameter
- duplicate identity field mismatch → fail closed, bytes unchanged
- entry 256 boundary: 256 OK, 257 fails
- 1 MiB bound: constructed oversize fails before truncate
- reason enum only three values
- sourceAlert exact keys; reject endpoint-like extra fields

- [ ] **Step 4: RED fingerprint helper + append return alignment**

- `fingerprintAuditIntegrityAlertDeadLetterRaw(rawText)`: SHA-256 lowercase hex + byteLength + entryCount + nextSequence stable for empty canonical state
- first-append return value deep-equals `fingerprintAuditIntegrityAlertDeadLetterRaw` of the durable post-append raw bytes
- exact-duplicate return value deep-equals fingerprint of the current durable raw bytes

- [ ] **Step 5: old-HEAD RED authenticity**

```bash
node --check test/audit-integrity-alert-dead-letter.test.js
node --test test/audit-integrity-alert-dead-letter.test.js
```

- [ ] **Step 6: GREEN minimal DLQ module**

Mode `0600`; compact JSON + newline; no requeue/drop APIs.

- [ ] **Step 7: Focused verification**

```bash
node --check src/audit-integrity-alert-dead-letter.js test/audit-integrity-alert-dead-letter.test.js
node --test test/audit-integrity-alert-dead-letter.test.js test/audit-integrity-alert-delivery-lifecycle.test.js
git diff --check
```

- [ ] **Step 8: Review gate, stage, commit, push**

```bash
git add src/audit-integrity-alert-dead-letter.js test/audit-integrity-alert-dead-letter.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat: add bounded audit alert dead-letter FIFO

Persist sanitized quarantine entries with exact identity idempotency,
256/1MiB bounds, and inspect-only read snapshots.
EOF
)"
git push
```

---

## Task 4: Detailed transport outcome seam

**Files (exact four):**

- Create: `src/audit-integrity-alert-https-transport-outcome.js`
- Create: `test/audit-integrity-alert-https-transport-outcome.test.js`
- Modify: `src/audit-integrity-alert-https-transport.js`
- Modify: `test/audit-integrity-alert-https-transport.test.js`

**Allowed files only:** the four files above.

**Forbidden diffusion:** claim/outbox/lifecycle/DLQ/tick, agent/server/web, Retry-After parsing, response body retention, public-result classifiers.

**Interfaces:**

```js
// src/audit-integrity-alert-https-transport-outcome.js
export function classifyAuditIntegrityAlertHttpStatusDetailedOutcome(statusCode);

// src/audit-integrity-alert-https-transport.js (added; existing public exports unchanged)
export function executeAuditIntegrityAlertHttpsRequestDetailed(requestDescriptor);
export function createAuditIntegrityAlertHttpsDetailedExecutorForTesting(deps);
```

Existing public exports remain verbatim compatible:

```js
export function executeAuditIntegrityAlertHttpsRequest(requestDescriptor);
export function createAuditIntegrityAlertHttpsExecutorForTesting(deps);
// still resolve only to {schemaVersion:1,status:'accepted'|'rejected'} or throw fixed unavailable
```

There is no `classifyAuditIntegrityAlertTransportDetailedOutcome(publicResult)` export.

### Steps

- [ ] **Step 1: RED missing-API sentinel (outcome module)**

Sentinel: `transport detailed outcome implementation missing`.

Guard import path: `../src/audit-integrity-alert-https-transport-outcome.js`.

- [ ] **Step 2: RED pure status tables**

- 200..299 → `accepted`
- 408, 425, 429 → `retryable-rejected`
- 500 and 599 boundaries → `retryable-rejected`
- 400, 401, 403, 404, 418, 422, 451, 300, 301 → `terminal-rejected`
- non-integer / missing → fail closed (not terminal)

Classifier outputs exact keys `schemaVersion`, `kind` only.

- [ ] **Step 3: RED detailed executor**

Add tests in `test/audit-integrity-alert-https-transport.test.js`:

- `executeAuditIntegrityAlertHttpsRequestDetailed` / detailed test factory exist
- 200 → `{schemaVersion:1, kind:'accepted'}`
- 429 → `{schemaVersion:1, kind:'retryable-rejected'}`
- 404 → `{schemaVersion:1, kind:'terminal-rejected'}`
- timeout/DNS error → fixed unavailable throw (no kind object)
- public executor still returns `status:'accepted'|'rejected'` only for the same fixtures

- [ ] **Step 4: old-HEAD RED authenticity**

```bash
node --check test/audit-integrity-alert-https-transport-outcome.test.js
node --test test/audit-integrity-alert-https-transport-outcome.test.js
```

(Detailed-executor export tests against current tree may RED until GREEN modifies transport; keep public surface tests green after GREEN.)

- [ ] **Step 5: GREEN**

Implement pure classifier module. Implement detailed executor that classifies at settlement while statusCode is in hand. Do not change public executor return shape. Do not parse body/headers/Retry-After.

- [ ] **Step 6: Focused verification**

```bash
node --check \
  src/audit-integrity-alert-https-transport-outcome.js \
  test/audit-integrity-alert-https-transport-outcome.test.js \
  src/audit-integrity-alert-https-transport.js \
  test/audit-integrity-alert-https-transport.test.js
node --test \
  test/audit-integrity-alert-https-transport-outcome.test.js \
  test/audit-integrity-alert-https-transport.test.js \
  test/audit-integrity-alert-delivery-once.test.js
git diff --check
```

- [ ] **Step 7: Review gate, stage, commit, push**

```bash
git add \
  src/audit-integrity-alert-https-transport-outcome.js \
  test/audit-integrity-alert-https-transport-outcome.test.js \
  src/audit-integrity-alert-https-transport.js \
  test/audit-integrity-alert-https-transport.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat: add detailed audit alert HTTPS outcomes

Add pure statusCode classification and a detailed executor while keeping
the public accepted/rejected transport surface compatible.
EOF
)"
git push
```

Cached name list must be exactly the four Task 4 files.

---

## Task 5: Explicit tick + in-flight / retry-wait / accepted completion

**Files:**

- Create: `src/audit-integrity-alert-delivery-retry.js`
- Create: `test/audit-integrity-alert-delivery-retry.test.js`

**Allowed files only:** the two files above.

**Forbidden diffusion:** agent/server/web, scheduler, package-lock, operator requeue/drop, claim module edits, outbox module edits (manual-ack gate is Task 7).

**Task 5 scope freeze:** implement empty / not-due / busy / delivered / retry-scheduled paths, including:

- open in-flight before request
- accepted-pending-completion then complete
- retryable-rejected release choreography (claim V then N)
- settled uncertain retry-wait with claim retained
- crash conversion of loaded open in-flight to retry-wait unknown with zero network

Terminal and attempts-exhausted success paths that produce `dead-lettered` receipts are implemented in Task 6. In Task 5, if a terminal decision is reached, the coordinator must fail closed with fixed unavailable and must not ack outbox or append DLQ. Task 5 tests must not require green `dead-lettered` success receipts.

**Interfaces:**

```js
export function tickAuditIntegrityAlertDelivery(dataDir, endpoint, now, policy);
export function createAuditIntegrityAlertDeliveryRetryForTesting(deps);
```

Test deps exact order per design §5.5 (`executeRequestDetailed`, not public rejected).

### Steps

- [ ] **Step 1: RED missing-API + receipt shapes + deps closed hostile**

Sentinel: `durable retry tick implementation missing`.

Guard import path: `../src/audit-integrity-alert-delivery-retry.js`.

Assert exact public receipt keys and forbidden fields (`claimId`, `attemptId`, endpoint, body, IP, path).

Assert `createAuditIntegrityAlertDeliveryRetryForTesting(deps)` fails closed with fixed `audit-delivery-unavailable` and zero durable mutation for every closed hostile case against the exact §5.5 key order:

- extra key
- missing key
- reordered keys
- accessor (getter) property on any required key
- Proxy `deps` object
- non-function value for any required key

No other key set is accepted.

- [ ] **Step 2: RED ordering — open in-flight before detailed request**

Using injected deps and a barrier:

1. claim succeeds
2. publishLifecycle observed with `status:'in-flight'`, `outcome:null`, `nextAttemptAt:null`, claim fields V, incremented attemptCount
3. only then `executeRequestDetailed` called
4. if publishLifecycle fails, executeRequestDetailed count stays 0

- [ ] **Step 3: RED accepted path**

```text
detailed kind accepted
  -> publish accepted-pending-completion
  -> completeDelivery once
  -> publish idle watermark retained
  -> never release
  -> receipt delivered
```

Crash window: accepted detailed + complete fails → claim preserved; lifecycle remains accepted-pending-completion when publish succeeded; next tick completes only; zero network.

- [ ] **Step 4: RED retryable path**

```text
detailed kind retryable-rejected
  -> publish retry-wait with claim fields V and nextAttemptAt=backoffDue
  -> release exact claim
  -> publish retry-wait with claim fields N
  -> receipt retry-scheduled only after claim-N publish
```

Same-tick release failure after claim-V publish (design §8.5 step 4) — exact assertions (path is after the original detailed attempt already returned `retryable-rejected`):

```text
executeRequestDetailed total call count for this original settlement === 1
  (the single request that returned retryable-rejected; never assert zero for the original attempt)
publish retry-wait claim fields V succeeds
  -> release throws or returns failure
  -> same tick throws fixed audit-delivery-unavailable (no success receipt)
  -> durable lifecycle remains retry-wait release-pending (claim fields V; outcome retryable-rejected)
  -> after that release failure, executeRequestDetailed total remains === 1 (no additional call on the failing tick)
  -> next release-recovery tick: release only; executeRequestDetailed total still === 1 (zero network)
  -> after release recovery publishes claim fields N and now >= nextAttemptAt: fresh claim then new open in-flight
  -> only that new attempt may raise executeRequestDetailed total from 1 to 2
```

- [ ] **Step 5: RED settled uncertain path**

```text
executeRequestDetailed throws fixed unavailable
  -> publish retry-wait with outcome unknown/uncertain-network
  -> nextAttemptAt = max(backoffDue, claimExpiresAt)
  -> claim fields V retained
  -> never release
  -> receipt retry-scheduled
```

- [ ] **Step 6: RED loaded open in-flight crash conversion**

```text
durable status in-flight at tick entry
  -> publish retry-wait unknown (detail null), effectiveDue, claim fields V
  -> attemptCount unchanged
  -> executeRequestDetailed count stays 0 on this tick
```

- [ ] **Step 7: RED not-due / empty / clock rollback / non-canonical now**

- empty outbox + idle lifecycle → empty receipt, zero claim/request
- `now < nextAttemptAt` on retry-wait → not-due, zero request
- `now < lastObservedAt` → zero mutation, fixed throw
- non-canonical `now` → fixed throw `audit-delivery-unavailable`, zero mutation, zero claim/request/publish. Cover at least:
  - missing milliseconds: `2026-08-05T00:00:00Z`
  - offset timezone: `2026-08-05T00:00:00.000+00:00`
  - non-string / non-ISO values that fail the canonical millisecond UTC identity `now === new Date(now).toISOString()`

- [ ] **Step 8: old-HEAD RED authenticity**

```bash
node --check test/audit-integrity-alert-delivery-retry.test.js
node --test test/audit-integrity-alert-delivery-retry.test.js
```

- [ ] **Step 9: GREEN tick coordinator for non-DLQ paths**

Production binds real authorize/claim/complete/release/lifecycle/policy/detailed executor/retry policy. Still no scheduler.

- [ ] **Step 10: Focused verification**

```bash
node --check src/audit-integrity-alert-delivery-retry.js test/audit-integrity-alert-delivery-retry.test.js
node --test \
  test/audit-integrity-alert-delivery-retry.test.js \
  test/audit-integrity-alert-retry-policy.test.js \
  test/audit-integrity-alert-delivery-lifecycle.test.js \
  test/audit-integrity-alert-delivery-claim.test.js \
  test/audit-integrity-alert-delivery-once.test.js \
  test/audit-integrity-alert-https-transport.test.js
git diff --check
```

- [ ] **Step 11: Review gate, stage, commit, push**

```bash
git add src/audit-integrity-alert-delivery-retry.js test/audit-integrity-alert-delivery-retry.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat: add explicit audit alert delivery retry tick

Programmatic tick advances at most one attempt with open in-flight,
retry-wait dual claim bindings, and accepted-pending-completion paths.
EOF
)"
git push
```

---

## Task 6: Dead-letter transaction + crash recovery

**Files (exact two):**

- Modify: `src/audit-integrity-alert-delivery-retry.js`
- Modify: `test/audit-integrity-alert-delivery-retry.test.js`

**Allowed files only:** the two files above.

**Forbidden diffusion:** new split test files, lifecycle/DLQ module edits, agent/server/web, scheduler, operator requeue/drop APIs, package-lock, claim module edits.

If existing lifecycle/DLQ APIs from Tasks 2–3 are insufficient, stop and revise the design; do not silently expand file scope in this Task.

### Steps

- [ ] **Step 1: RED terminal-http dead-letter success path**

Prove transaction order with call log:

1. preflight DLQ post/bounds
2. publish lifecycle `dead-letter-prepared` with top-level claim fields V
3. appendDeadLetter with only `(dataDir, lease, entry)`; coordinator **receives the append helper return value** (actual post fingerprint) and compares it to lifecycle prepared nested `deadLetter.deadLetterPost`
4. **only if** returned actual post equals prepared `deadLetterPost`: complete/ack outbox head then clear claim — never reverse
5. publish lifecycle idle watermark retained (claim fields finally N)
6. receipt `dead-lettered` with sanitized reason `terminal-http`

Assert mismatch branch on the same path: when returned actual post does **not** equal prepared `deadLetterPost`, coordinator fails closed with fixed unavailable, **does not** ack outbox, **does not** clear claim, lifecycle remains `dead-letter-prepared`.

- [ ] **Step 2: RED attempts-exhausted reasons**

- attempt 8 + retryable-rejected → `attempts-exhausted-retryable`
- attempt 8 + uncertain → `attempts-exhausted-uncertain`

- [ ] **Step 3: RED crash truth table**

Table-driven recovery fixtures for design §11.1 and §11.3:

| fixture | expected |
| --- | --- |
| DLQ post / outbox pre / claim claimed / prepared | ack then clear then idle |
| DLQ post / outbox post / claim claimed / prepared | clear claim only; no successor delete |
| DLQ post / outbox post / claim idle / prepared | lifecycle idle only; WAL claim fields cleared only by idle |
| DLQ pre / outbox post / prepared | fail closed zero unsafe mutation |
| returned actual post !== prepared deadLetterPost | fail closed; no ack; no claim clear; stay prepared |
| append idempotent exact duplicate after crash before ack (returned actual post === prepared deadLetterPost; deadLetterPre may !== deadLetterPost) | continue ack |
| open in-flight at entry | convert to retry-wait unknown; zero network |
| retry-wait retryable release-pending | release only; zero network |

- [ ] **Step 4: RED DLQ full blocked**

Before prepared: lifecycle `blocked` detail `dead-letter-full` with **all binding fields V**; head+claim retained; subsequent ticks return `blocked` without network.

- [ ] **Step 5: RED DLQ corrupt / lifecycle corrupt**

Zero mutation; fixed unavailable; do not fake dead-lettered; do not publish blocked.

- [ ] **Step 6: RED accepted-pending-completion recovery**

Residual already-completed; successor preserved.

- [ ] **Step 7: GREEN implement transaction + recovery**

Reuse existing complete residual semantics through claim/outbox APIs already exported; no claim/outbox schema migration; no claim module edits.

- [ ] **Step 8: Focused verification**

```bash
node --check src/audit-integrity-alert-delivery-retry.js test/audit-integrity-alert-delivery-retry.test.js
node --test \
  test/audit-integrity-alert-delivery-retry.test.js \
  test/audit-integrity-alert-dead-letter.test.js \
  test/audit-integrity-alert-delivery-lifecycle.test.js \
  test/audit-integrity-alert-delivery-claim.test.js \
  test/audit-integrity-alert-outbox.test.js
git diff --check
```

- [ ] **Step 9: Review gate, stage, commit, push**

```bash
git add src/audit-integrity-alert-delivery-retry.js test/audit-integrity-alert-delivery-retry.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat: add audit alert dead-letter transaction recovery

Quarantine terminal and exhausted attempts with fingerprint crash
recovery, sticky DLQ-full blocked state, and successor-safe acks.
EOF
)"
git push
```

---

## Task 7: Authorized integration / concurrency / privacy / manual-ack gate

**Files (exact four):**

- Modify: `src/audit-integrity-alert-outbox.js`
- Modify: `src/audit-integrity-alert-delivery-retry.js`
- Modify: `test/audit-integrity-alert-outbox.test.js`
- Create: `test/audit-integrity-alert-delivery-retry-integration.test.js`

**Allowed files only:** the four files above.

**Forbidden diffusion:** claim module, agent/server/web, LaunchAgent, env config, scheduler, package-lock.

**Outbox gate freeze:** `src/audit-integrity-alert-outbox.js` imports `loadAuditIntegrityAlertDeliveryLifecycle` and `assertAuditIntegrityAlertDeliveryLifecycleIdle`, and under the same write lease used for manual ack loads lifecycle then refuses when non-idle. Existing refusal when claim is `claimed` remains. Claim module is not modified.

### Steps

- [ ] **Step 1: RED authorize-before-claim integration**

In `test/audit-integrity-alert-delivery-retry-integration.test.js`:

- Deny policy → zero claim, zero lifecycle attempt increment, zero detailed request, fixed unavailable
- Allow policy → bit-identical endpoint primitive reaches claim/tick path

- [ ] **Step 2: RED concurrency**

Two overlapping ticks on one temp data root with barrier detailed transport:

- exactly one `executeRequestDetailed`
- other receipt `busy` without second request

- [ ] **Step 3: RED manual ack gate**

In `test/audit-integrity-alert-outbox.test.js`:

For each lifecycle status in `{in-flight, retry-wait, accepted-pending-completion, dead-letter-prepared, blocked}` with head present:

- public/manual outbox ack refuses fixed unavailable
- outbox bytes unchanged

Also retain existing: claim `claimed` refuses manual ack.

Idle lifecycle + idle claim + exact head → existing manual ack behavior unchanged.

- [ ] **Step 4: RED privacy scans**

In integration tests: lifecycle/DLQ files and receipts/errors contain no endpoint substrings, raw headers, `Authorization`, IP literals from fixtures, or response bodies used in tests.

- [ ] **Step 5: RED in-flight recovery does not double-count attempt**

Crash after open in-flight publish before request; recover converts to retry-wait without increment; first re-request increments once only when due rules allow a new open in-flight.

- [ ] **Step 6: old-HEAD RED authenticity**

On the Task-6 tree, before modifying `src/audit-integrity-alert-outbox.js` or `src/audit-integrity-alert-delivery-retry.js`, with the new integration test already written:

```bash
node --check test/audit-integrity-alert-delivery-retry-integration.test.js
node --test test/audit-integrity-alert-delivery-retry-integration.test.js
```

Expected: syntax check exit 0; test fails solely from Task 7 missing behavior or missing production wiring asserted by the RED fixtures (authorize-before-claim gate, single-flight concurrency, privacy ceiling, lifecycle non-idle manual-ack refusal as covered by this Task); no fixture, import, certificate, or network noise.

- [ ] **Step 7: GREEN gates**

Implement outbox lifecycle non-idle refusal under same lease. Ensure production `tickAuditIntegrityAlertDelivery` performs authorize-before-claim so integration tests exercise the real authorize gate.

- [ ] **Step 8: Focused + related verification**

```bash
node --check \
  src/audit-integrity-alert-outbox.js \
  src/audit-integrity-alert-delivery-retry.js \
  test/audit-integrity-alert-outbox.test.js \
  test/audit-integrity-alert-delivery-retry-integration.test.js
node --test \
  test/audit-integrity-alert-delivery-retry.test.js \
  test/audit-integrity-alert-delivery-retry-integration.test.js \
  test/audit-integrity-alert-outbox.test.js \
  test/audit-integrity-alert-delivery-claim.test.js \
  test/audit-integrity-alert-delivery-authorized-once.test.js \
  test/audit-integrity-alert-destination-policy.test.js \
  test/audit-integrity-alert-https-transport.test.js
git diff --check
```

- [ ] **Step 9: Review gate, stage, commit, push**

```bash
git add \
  src/audit-integrity-alert-outbox.js \
  src/audit-integrity-alert-delivery-retry.js \
  test/audit-integrity-alert-outbox.test.js \
  test/audit-integrity-alert-delivery-retry-integration.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat: gate audit alert retry integration and manual ack

Enforce authorize-before-claim, single-flight concurrency, privacy
ceilings, and manual ack refusal while lifecycle is non-idle.
EOF
)"
git push
```

---

## Task 8: README / Gold honesty + full suite closure

**Files (exact four):**

- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`

**Allowed files only:** the four files above.

**Forbidden diffusion:** package-lock, credentials, LaunchAgent, Agent/API/Web feature wiring, scheduler implementation, retry runtime logic (if full suite exposes a runtime bug, return to the owning Task).

**Honesty freeze:** keep Gold partial **6/3/0/9**; do not flip any scorecard status to ready for production-hardening; do not claim managed scheduler, remote notification delivery ready, production monitoring ready, end-to-end production audit delivery, production-hardening ready, Gold, or exactly-once.

### Steps

- [ ] **Step 1: TEST-ONLY RED**

Modify only `test/readme.test.js` and `test/gold-readiness.test.js` first. Assert README and gold-readiness text include all of:

- durable retry/backoff/dead-letter local foundation (programmatic tick)
- explicit programmatic tick only
- no automatic retry scheduler / not managed scheduler
- not remote notification delivery
- not production monitoring ready
- not end-to-end production audit delivery
- production-hardening remains partial
- not production-hardening ready
- not Gold
- Gold remains partial 6/3/0/9
- at-least-once; not exactly-once

Run:

```bash
node --test test/readme.test.js test/gold-readiness.test.js
```

Expected: RED solely on missing new honesty phrases / still-wrong partial claims.

- [ ] **Step 2: DOCS/SOURCE GREEN**

Update `README.md` and `src/gold-readiness.js` honesty wording only. Preserve partial counts 6/3/0/9. Mirror existing alert-delivery bullet style. Must not claim real staging delivery or Gold.

- [ ] **Step 3: Source closed-set assertions in tests**

`test/readme.test.js` / `test/gold-readiness.test.js` must fail if honesty phrases claim scheduler readiness or Gold flip.

- [ ] **Step 4: Focused verification**

```bash
node --check src/gold-readiness.js test/readme.test.js test/gold-readiness.test.js
node --test test/readme.test.js test/gold-readiness.test.js
git diff --check
```

- [ ] **Step 5: Full suite**

```bash
npm test
```

Expected: all non-environment-gated tests pass; Gold scorecard still partial 6/3/0/9.

- [ ] **Step 6: Review gate, stage, commit, push**

```bash
git add README.md src/gold-readiness.js test/readme.test.js test/gold-readiness.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
docs: honest audit alert durable retry boundaries

Document programmatic tick retry/dead-letter foundation without claiming
managed scheduling, remote delivery readiness, or Gold.
EOF
)"
git push
```

---

## Cross-task dependency graph

```text
Task1 (policy)
  -> Task5 (tick) -> Task6 (DLQ tx) -> Task7 (integration gates) -> Task8 (honesty)
Task2 (lifecycle) -> Task5
Task3 (DLQ store) -> Task5
Task4 (detailed outcome) -> Task5
```

Tasks 1–4 are mutually independent and may proceed in parallel after baseline; Task 5 requires 1–4; Task 6 requires 5; Task 7 requires 6; Task 8 last.

---

## Review gate checklist (every Task)

Before commit:

1. Focused tests green
2. `git diff --check` clean on the working tree used for the Task
3. Exact `git add` allowlist
4. `git diff --cached --check` clean
5. `git diff --cached --name-only` equals the Task allowlist exactly
6. Fresh reviewer verdict adjudicated (P0/P1 none for closure)
7. No scheduler/Agent/API/Web/package-lock leakage
8. No exactly-once or Gold-ready claims in commit message or docs touched by the Task

---

## Explicit non-implementation registry

| Item | Status |
| --- | --- |
| Managed scheduler / LaunchAgent timer | future batch |
| Agent/API/Web tick or DLQ routes | future batch |
| External config/env endpoint loading | future batch |
| Deploy / real external acceptance | future batch |
| Operator requeue/drop of DLQ entries | future explicit contract only |
| Exactly-once delivery | never claimed |
| Outbox/claim schema migration | rejected (architecture C) |
| Claim module edits for manual ack | rejected; outbox imports lifecycle idle assertion |
| Retry-After / body parsing | rejected |
| Inferring retry class from public rejected | rejected; use detailed executor |
| package-lock changes | forbidden |

---

## Plan freeze statement

This plan is executable behavior-type TDD for the frozen design. Implementers must keep schemas, backoff array, attempt ceiling, dual retry-wait claim bindings, open in-flight crash conversion, detailed-executor architecture, transaction order, crash tables, privacy ceiling, exact Task file allowlists, and Gold honesty intact. Any need for scheduler or host wiring requires a separate design—not a silent Task expansion.
