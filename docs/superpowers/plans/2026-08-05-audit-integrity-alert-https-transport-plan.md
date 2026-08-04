# Audit Integrity Alert Bounded HTTPS Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one bounded programmatic HTTPS attempt for a durably claimed audit-integrity alert without adding retry, scheduling, external wiring, or a Gold claim.

**Architecture:** A dedicated HTTPS module owns only request/response settlement and returns `accepted` or `rejected`; uncertain failures throw a fixed error. A separate one-shot coordinator owns claim, complete, and release policy. Documentation changes are a third TDD task so runtime evidence and Gold wording remain independently reviewable.

**Tech Stack:** Node.js ESM, built-in `node:https`, `node:tls`, `node:buffer`, `node:events`, Node test runner, existing Linke error/claim/outbox/write-queue modules.

## Global Constraints

- Production version remains V1.46; `production-hardening` remains partial and Gold remains not achieved.
- HTTPS total deadline is exactly `10_000` milliseconds.
- Maximum response body is exactly `4_096` bytes, counted incrementally as bytes.
- Request `content-length` uses `Buffer.byteLength(body, 'utf8')`.
- Production options require `agent: false`, `rejectUnauthorized: true`, `checkServerIdentity: tls.checkServerIdentity`, `ca: tls.rootCertificates`, and minimum TLS 1.2.
- No redirects, proxy integration, arbitrary caller headers/options, environment reads, credential reads, filesystem access, retry, dead-letter handling, scheduler, Agent/API/Web/config wiring, deployment, or real external network calls in tests.
- A complete bounded 2xx response is `accepted`; a complete bounded non-2xx response is `rejected`; every uncertain outcome preserves the durable claim.
- All public errors map to the fixed path-free `audit-delivery-unavailable` contract.
- Existing user-owned untracked files and `package-lock.json` remain outside every staging allowlist.

---

### Task 1: Bounded HTTPS request executor

**Files:**
- Create: `src/audit-integrity-alert-https-transport.js`
- Create: `test/audit-integrity-alert-https-transport.test.js`

**Interfaces:**
- Consumes: the frozen request descriptor returned by `buildAuditIntegrityAlertDeliveryRequest(endpoint, streamId, entry)`.
- Produces: `AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS`, `AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES`, `executeAuditIntegrityAlertHttpsRequest(requestDescriptor)`, and `createAuditIntegrityAlertHttpsExecutorForTesting(deps)`.
- `deps` has exact ordered keys `request`, `setTimer`, `clearTimer`; any extra, missing, reordered, accessor, Proxy, or non-function value fails closed.
- The executor resolves to exact frozen `{ schemaVersion: 1, status: 'accepted' }` or `{ schemaVersion: 1, status: 'rejected' }` and otherwise rejects with `audit-delivery-unavailable`.

- [ ] **Step 1: Create the RED test file with a missing-API sentinel**

Use a guarded dynamic import so old HEAD reaches one behavior-specific assertion instead of producing module-loader noise:

```js
let transport = Object.freeze({});
try {
  transport = await import('../src/audit-integrity-alert-https-transport.js');
} catch {}

test('exports the bounded HTTPS transport contract', () => {
  assert.equal(
    typeof transport.executeAuditIntegrityAlertHttpsRequest,
    'function',
    'bounded HTTPS transport implementation missing',
  );
  assert.equal(transport.AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS, 10_000);
  assert.equal(transport.AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES, 4_096);
});
```

- [ ] **Step 2: Add deterministic fake request/response primitives**

Build `EventEmitter`-based request and response doubles. The fake request must record `(url, options)`, expose `end(body)`, and expose idempotent `destroy()`. The timer harness must expose `advanceTo(ms)` and count `clearTimer` calls. Do not create a listener or make a real DNS/TLS/network call.

```js
function createTransportHarness(script) {
  const calls = [];
  const timers = new Map();
  let nextTimerId = 1;
  const deps = {
    request(url, options, onResponse) {
      const req = new EventEmitter();
      req.destroyCount = 0;
      req.destroy = () => { req.destroyCount += 1; };
      req.end = (body) => {
        calls.push({ url, options, body, req });
        script({ req, onResponse });
      };
      return req;
    },
    setTimer(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  };
  return { deps, calls, timers };
}
```

- [ ] **Step 3: Add RED matrices for validation and exact request options**

Assert exact descriptor keys and reject hostile objects before `deps.request` runs. For a descriptor containing a non-ASCII reason, assert `content-length === Buffer.byteLength(body, 'utf8')`. Assert exact method, headers, `agent:false`, TLS verification, root certificates, TLS 1.2 minimum, and absence of proxy/authorization/cookie fields.

- [ ] **Step 4: Add RED response-state boundary tests**

Use table-driven tests for final status `199 -> rejected`, `200 -> accepted`, `299 -> accepted`, and `300 -> rejected`. Emit body chunks totaling 4096 bytes and prove settlement; emit byte 4097 and prove fixed rejection plus request destruction. Emit an informational event before the final response and prove it does not settle. Emit a 302 response and prove exactly one request call occurs.

- [ ] **Step 5: Add RED uncertain-outcome and single-settlement tests**

Cover the timer at 9999 and 10000 milliseconds, request error, response error, response `aborted`, response close before end, invalid/missing status, request-construction throw, late error after end, and late end after timeout. Every failure must be the registered fixed error and must not contain endpoint, response bytes, header values, certificate text, hostname, errno, or filesystem paths. Assert timer clear and destroy counts exactly.

- [ ] **Step 6: Prove behavior-specific RED on archived old HEAD**

Create a clean archive of `6f1b596` and apply only `test/audit-integrity-alert-https-transport.test.js`.

Run:

```bash
node --check test/audit-integrity-alert-https-transport.test.js
node --test test/audit-integrity-alert-https-transport.test.js
```

Expected: syntax exits 0; exactly the missing-API sentinel fails with `bounded HTTPS transport implementation missing`; no import, fixture, certificate, socket, or timer-harness failure occurs.

- [ ] **Step 7: Implement the minimal executor**

Implement an exact-key descriptor validator, a fixed `unavailableError()` mapper, the exact dependency factory, internal request options, a byte-counting response consumer, a total timer, and a single settlement guard. Keep the response body as bytes and discard it.

The settle branch must follow this shape:

```js
if (statusCode >= 200 && statusCode <= 299) {
  resolve(Object.freeze({ schemaVersion: 1, status: 'accepted' }));
} else {
  resolve(Object.freeze({ schemaVersion: 1, status: 'rejected' }));
}
```

All throws/events outside a fully ended bounded response reject with a fresh fixed `LinkeError`.

- [ ] **Step 8: Run Task 1 GREEN and structural scans**

Run:

```bash
node --check src/audit-integrity-alert-https-transport.js
node --check test/audit-integrity-alert-https-transport.test.js
node --test test/audit-integrity-alert-delivery.test.js test/audit-integrity-alert-https-transport.test.js
```

Expected: zero failures. Scan the production source to require only built-in buffer/https/tls plus `error-codes.js`, and to forbid `fetch`, proxy packages, `process.env`, retry/backoff/dead-letter/scheduler strings, claim/outbox imports, Agent/Server/Web imports, and filesystem imports.

- [ ] **Step 9: Fresh review, stage exact files, commit, and push**

Obtain a fresh read-only reviewer verdict on the two-file diff, adjudicate every finding, and rerun Task 1 GREEN after any correction.

```bash
git add src/audit-integrity-alert-https-transport.js test/audit-integrity-alert-https-transport.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: add bounded audit alert HTTPS transport"
git push origin linke-v0.12-web-panel
```

The cached name list must contain exactly the two Task 1 files.

---

### Task 2: One-shot claim-to-HTTPS delivery coordinator

**Files:**
- Create: `src/audit-integrity-alert-delivery-once.js`
- Create: `test/audit-integrity-alert-delivery-once.test.js`

**Interfaces:**
- Consumes: `claimAuditIntegrityAlertDelivery`, `executeAuditIntegrityAlertHttpsRequest`, `completeAuditIntegrityAlertDelivery`, and `releaseAuditIntegrityAlertDelivery`.
- Produces: `deliverAuditIntegrityAlertOnce(dataDir, endpoint, now)` and `createAuditIntegrityAlertDeliveryOnceForTesting(deps)`.
- `deps` has exact ordered keys `claimDelivery`, `executeRequest`, `completeDelivery`, `releaseDelivery`.
- Empty receipt: exact frozen `{ schemaVersion: 1, status: 'empty', delivered: false }`.
- Busy receipt: exact frozen `{ schemaVersion: 1, status: 'busy', delivered: false, streamId, sequence, expiresAt }`.
- Delivered receipt: exact frozen `{ schemaVersion: 1, status: 'delivered', delivered: true, streamId, sequence, pendingCount, completionStatus }`.

- [ ] **Step 1: Write the missing-API RED and exact receipt tests**

Use the guarded dynamic-import pattern from Task 1 and fail explicitly with `one-shot HTTPS delivery implementation missing`. Add deep-freeze and exact-key assertions for empty, busy, and delivered receipts. Assert no receipt contains `claimId`, `request`, `endpoint`, `headers`, `body`, `response`, `errno`, or path-like content.

- [ ] **Step 2: Write the deterministic branch matrix**

Using the injected factory, prove:

```text
claim empty    -> zero execute/complete/release, empty receipt
claim busy     -> zero execute/complete/release, busy receipt
claimed+accepted -> execute once, complete once, never release, delivered receipt
claimed+rejected -> execute once, release once, never complete, fixed throw
claimed+throw    -> execute once, never complete/release, fixed throw
malformed result -> never complete/release, fixed throw
```

For accepted then `completeDelivery` rejection, assert release count stays zero. For rejected then `releaseDelivery` rejection, assert complete count stays zero and the public error remains fixed.

- [ ] **Step 3: Add real claim integration tests without real network**

Use a temporary safe data root, the real alert outbox, real claim coordinator, real complete/release functions, and only an injected fake executor. Start two calls on the same root while the first fake executor is held at a barrier. Assert one call reaches the executor and the second returns busy with no duplicate request.

Exercise accepted completion and verify the exact FIFO head is removed. Exercise rejected release and verify the exact head remains. Exercise uncertain failure and verify the claim remains claimed until the existing owner/TTL recovery contract permits replacement.

- [ ] **Step 4: Add completion crash-window tests**

Inject a completion failure before acknowledgement and assert the accepted branch does not release. Reuse the existing scoped FileHandle fault technique to fail idle publication after a real outbox acknowledgement; prove an exact subsequent completion returns `already-completed` and does not remove the successor head.

- [ ] **Step 5: Prove behavior-specific RED on Task 1 HEAD**

In a clean archive of the Task 1 commit, apply only `test/audit-integrity-alert-delivery-once.test.js`.

Run:

```bash
node --check test/audit-integrity-alert-delivery-once.test.js
node --test test/audit-integrity-alert-delivery-once.test.js
```

Expected: syntax exits 0; exactly the missing one-shot API assertion fails; no fake-executor, temporary-root, or claim fixture failure occurs.

- [ ] **Step 6: Implement the minimal coordinator**

Validate every dependency result as an exact plain data object. Build the exact claim capability only from `claimId`, `streamId`, and `sequence`. Follow this policy without catch-and-release:

```js
const transport = await executeRequest(claim.request);
if (transport.status === 'accepted') {
  const completed = await completeDelivery(dataDir, capability);
  return deliveredReceipt(completed);
}
if (transport.status === 'rejected') {
  await releaseDelivery(dataDir, capability);
  throw unavailableError();
}
throw unavailableError();
```

An exception from `executeRequest` or `completeDelivery` must bypass release. Only the exact `rejected` result reaches release.

- [ ] **Step 7: Run Task 2 GREEN and related regression**

Run:

```bash
node --check src/audit-integrity-alert-delivery-once.js
node --check test/audit-integrity-alert-delivery-once.test.js
node --test test/audit-integrity-alert-delivery-once.test.js test/audit-integrity-alert-delivery-claim.test.js test/audit-integrity-alert-delivery-claim-state.test.js test/audit-integrity-alert-outbox.test.js test/audit-integrity-alert-delivery-stream.test.js test/audit-integrity-alert-delivery.test.js test/audit-integrity-alert-https-transport.test.js test/audit-integrity-process-lock.test.js test/audit-integrity-write-queue.test.js
```

Expected: zero failures, no external network connection, and the real multi-process owner-kill recovery test still passes.

- [ ] **Step 8: Fresh review, stage exact files, commit, and push**

Obtain a fresh reviewer verdict focused on uncertain-outcome preservation and the 2xx-complete crash window. Rerun Task 2 GREEN after any accepted correction.

```bash
git add src/audit-integrity-alert-delivery-once.js test/audit-integrity-alert-delivery-once.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: deliver one claimed audit alert over HTTPS"
git push origin linke-v0.12-web-panel
```

The cached name list must contain exactly the two Task 2 files.

---

### Task 3: Documentation and Gold-readiness honesty

**Files:**
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`

**Interfaces:**
- Consumes: the committed Task 1 and Task 2 module/test paths and exact transport constants.
- Produces: truthful V1.46 evidence for bounded programmatic one-shot HTTPS delivery while preserving score `6/3/0/9` and `production-hardening: partial`.

- [ ] **Step 1: Write documentation honesty RED tests**

Require README and `production-hardening.evidence` to include:

```text
bounded programmatic audit-integrity alert HTTPS transport
src/audit-integrity-alert-https-transport.js
test/audit-integrity-alert-https-transport.test.js
src/audit-integrity-alert-delivery-once.js
test/audit-integrity-alert-delivery-once.test.js
10-second total deadline
4096-byte response bound
uncertain outcomes preserve the durable claim
complete bounded non-2xx releases the claim
at-least-once; not exactly-once
```

Require the current evidence to stop saying `no HTTPS transport executor`. Continue to require direct negatives for automatic retry, dead-letter handling, managed scheduler, external/untrusted endpoint wiring, real remote notification delivery, production monitoring ready, end-to-end production delivery, production-hardening ready, and Gold. Freeze status and summary at partial and `6/3/0/9`.

- [ ] **Step 2: Prove RED against the Task 2 runtime commit**

Run the modified tests before changing README/report content:

```bash
node --check test/readme.test.js
node --check test/gold-readiness.test.js
node --test test/readme.test.js test/gold-readiness.test.js
```

Expected: exactly the new transport-honesty assertions fail because evidence is absent or stale; existing documentation tests pass.

- [ ] **Step 3: Make the minimal truthful documentation update**

Replace only the stale current-milestone `no HTTPS transport executor` evidence. Add Task 1/2 paths, exact bounds, accepted/rejected/uncertain semantics, and the trusted-local-caller-only endpoint boundary. Do not rewrite historical rows. Do not alter score counts or mark `production-hardening` ready.

- [ ] **Step 4: Run documentation GREEN and complete verifier suite**

Run:

```bash
node --test test/readme.test.js test/gold-readiness.test.js test/audit-integrity-alert-https-transport.test.js test/audit-integrity-alert-delivery-once.test.js
npm test
git diff --check
```

Expected: focused tests have zero failures; full suite has zero failures and only the repository's existing environment-gated skips.

- [ ] **Step 5: Independent closure review and final audits**

Send the exact four-file documentation diff, Task 1/2 commit hashes, RED/GREEN outputs, full-suite totals, Gold boundary, and unverified real-staging gap to a fresh closure reviewer. Codex verifies every finding against the worktree.

Audit:

```bash
git diff --name-only
git diff --check
git status --short
```

Require exactly the four Task 3 files in the diff, no sensitive path, and no staged `package-lock.json` or protected user file.

- [ ] **Step 6: Commit, push, and verify upstream equality**

```bash
git add README.md src/gold-readiness.js test/readme.test.js test/gold-readiness.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "docs: document bounded audit alert HTTPS delivery"
git push origin linke-v0.12-web-panel
git rev-parse HEAD
git rev-parse origin/linke-v0.12-web-panel
```

The two revisions must match. Continue to the separate destination-allowlist and durable retry design; do not declare Gold.
