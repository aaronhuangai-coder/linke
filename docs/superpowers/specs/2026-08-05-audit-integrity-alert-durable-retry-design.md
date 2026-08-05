# Audit Integrity Alert Durable Retry / Backoff / Dead-Letter Design

Date: 2026-08-05
Status: Design freeze (architecture C; GLM PASS_WITH_REVISIONS; main-review P0 lifecycle + detailed-transport revisions applied)
Worktree baseline: `8d1712e3c9a3f59255d56a698133fd9d260bf140`
Release surface: V1.46 `production-hardening` remains partial only; not Gold
Gold scorecard boundary: remains partial **6/3/0/9** (no score change in this batch)

---

## 1. Goal

Close the local durable retry gap for audit-integrity alert delivery after the existing one-shot claim → authorize → HTTPS → complete/release path.

This batch freezes and will implement:

1. an exact canonical **lifecycle WAL** that records attempt ledger, backoff due times, and recovery status;
2. a fixed **retry/backoff policy** with a hard attempt ceiling;
3. a bounded durable **dead-letter FIFO** with exact quarantine transaction ordering and crash recovery;
4. an explicit programmatic **`tick(now)`** that advances at most one FIFO head and performs at most one network attempt;
5. a pure HTTP status classifier plus a **separate detailed HTTPS executor** that returns closed kinds while the public executor stays accepted/rejected compatible;
6. sanitized public receipts and fixed path-free public errors;
7. a complete TDD matrix and implementation slice plan (see companion plan file).

Delivery remains **at-least-once**. This design never claims exactly-once remote delivery.

---

## 2. Non-goals (explicit future batches)

The following are **not** in this batch. They may be referenced as future contracts but must not be implemented here:

| Deferred item | Why deferred |
| --- | --- |
| Managed scheduler / LaunchAgent timer / `setInterval` / `sleep` loop / background worker | Lifecycle, host install, and operator wiring are separate Gold gates |
| Agent / API / Web / external config wiring for retry tick or DLQ inspection | Host-surface expansion is a later authorized wiring batch |
| External env-driven endpoint or policy loading | Destination policy remains caller-supplied capability |
| Deploy / install / production webhook acceptance | Real staging delivery evidence is separate |
| Operator requeue / drop / rewrite of dead-letter entries | Requires explicit future quarantine-advance contract; this batch only appends and inspects |
| Exactly-once remote semantics | Receiver-side idempotency is not proved by local state |
| Retry-After / response body / content-type parsing | Privacy and closed outcome surface forbid remote body coupling |
| Outbox or claim schema migration | Architecture C keeps both stable |
| Cross-host / network-FS locking claims | Existing same-root lock contract is unchanged |
| Gold promotion or `production-hardening` ready | Scorecard stays partial 6/3/0/9 |

**Future contract (not implemented):** if operators must truly quarantine-and-advance or requeue a dead-lettered occurrence, a later design must add an explicit programmatic requeue/drop API with its own crash truth table. This batch freezes dead-letter FIFO as append-only inspectable quarantine only.

---

## 3. Existing facts (frozen inputs)

These contracts already exist and are **not** redesigned:

### 3.1 Outbox FIFO

- Path: `audit/integrity-alert-outbox.json`
- Bounds: max **256** entries / **1 MiB**
- Compact JSON + exactly one trailing newline; mode `0600`
- Exact top keys: `schemaVersion`, `nextSequence`, `entries`
- Exact entry keys: `sequence`, `checkedAt`, `code`, `recoveryRequired`, `nextAction`, `reasonCode`
- Monotonic contiguous sequences; no drop-oldest; full/corrupt fail closed

### 3.2 Stream identity and idempotency

- Stable stream UUID file: `audit/integrity-alert-delivery-stream.json`
- Idempotency key (fixed): `audit-integrity-alert:<streamId>:<sequence>`
- Delivery semantics remain `at-least-once`

### 3.3 Durable claim

- Path: `audit/integrity-alert-delivery-claim.json`
- TTL: **120_000 ms**
- Boot/process identity fencing for owner liveness
- Capability exact keys: `{claimId, streamId, sequence}`
- Complete order: acknowledge exact outbox head **first**, then publish claim idle
- Post-ack residual may complete as `already-completed` without deleting successor
- Manual outbox ack refuses while claim status is `claimed`

### 3.4 One-shot transport and authorize gate

- Public transport result surface remains `accepted` / `rejected` (or fixed uncertain throw)
- Public `{status:'rejected'}` **discards** the integer status code; retry classification **cannot** be recovered from the public result alone
- 2xx accepted; bounded non-2xx rejected; DNS/TLS/timeout/close/throw uncertain
- Fixed path-free error: `audit-delivery-unavailable`
- Exact destination allowlist; authorize-before-claim; public-DNS pin
- Trusted local programmatic endpoint only; no Agent/API/Web wiring

### 3.5 Shared write lease

- All durable mutations under same-root `enqueueAuditIntegrityWriteTask` + `/usr/bin/lockf`
- Nested same-root re-entry fails closed
- Local host only; not distributed

### 3.6 Gold honesty

- Gold remains partial **6/3/0/9**
- Three partial items remain, including `production-hardening`
- Not remote notification delivery ready; not production monitoring ready; not end-to-end production audit delivery

---

## 4. Architecture selection

### 4.1 Option A — Migrate outbox entries to carry attempt/backoff fields

Rejected.

- Forces schema migration of the stable FIFO source of truth.
- Couples issuance sanitization with delivery attempt accounting.
- Complicates manual ack, corrupt recovery, and partial-write crash windows already frozen for outbox.

### 4.2 Option B — Expand claim state into multi-status delivery ledger

Rejected.

- Claim is a single-slot fencing token with exact null grammar for idle/claimed.
- Expanding it mixes owner fencing, attempt history, DLQ preparation, and clock watermark.
- Residual post-ack claim recovery becomes entangled with backoff due math.

### 4.3 Option C — Add lifecycle WAL + dead-letter FIFO; keep outbox/claim unchanged (selected)

Selected and frozen after GLM PASS_WITH_REVISIONS.

- Outbox remains the monotonic FIFO source of truth for pending alerts.
- Claim remains the single-slot fencing capability for one head.
- Lifecycle WAL is the exact attempt ledger, backoff clock, and recovery status machine.
- Dead-letter FIFO is the bounded quarantine store after terminal local exhaustion or terminal rejection.
- All durable mutations remain under the existing same-root shared write lease.
- Advancement is only via explicit programmatic `tick(now)`: at most one head, at most one network attempt, no `setInterval` / sleep / background worker / managed scheduler.

### 4.4 GLM adjudication and main-review P0 revisions (adopted)

Adopted:

- No outbox/claim schema migration.
- Lifecycle is always-canonical single-object WAL, not unbounded JSONL attempt log.
- Dead-letter is independent bounded FIFO with exact entry identity `(streamId, sequence)`.
- Network attempt requires durable `in-flight` + incremented `attemptCount` **before** request.
- **`in-flight` is only the open-attempt window** (`outcome=null`, `nextAttemptAt=null`, claim fields required).
- Crash recovery of open `in-flight` **must first** durable-publish `retry-wait` with outcome `unknown` and effective due; it must **not** issue network from the leftover open `in-flight` row.
- **Settled uncertain publishes `retry-wait`** (not a second meaning of `in-flight`), retains claim fields, never releases.
- Retryable bounded rejection: durable `retry-wait` **with claim capability retained first**, then release, then clear lifecycle claim fields only after successful release.
- 2xx requires durable `accepted-pending-completion` before complete; later ticks only complete.
- Crash after remote 2xx but before `accepted-pending-completion` is honest at-least-once redelivery with the same idempotency key.
- Dead-letter transaction order is fixed; crash truth table is exhaustive.
- Public errors remain fixed `audit-delivery-unavailable`; public receipts are sanitized.
- Explicit `tick(now)` only; no scheduler in this batch.
- Detailed classification uses pure statusCode classifier + separate detailed executor; public accepted/rejected surface stays byte-compatible.

**Revocation:** any prior wording (including interim delivery notes) that stated “settled uncertain does not use `retry-wait`” is **void**. Settled uncertain **must** use `retry-wait` with retained claim fields.

Rejected:

- Storing endpoint / request body / headers / raw errors in lifecycle or DLQ.
- Parsing `Retry-After` or response bodies.
- Inferring retry class from public `{status:'rejected'}` after statusCode discard.
- Automatic requeue/drop operator APIs in this batch.
- Claiming OS monotonic clock across process restarts.
- Claiming exactly-once.

---

## 5. Modules and public/internal APIs

### 5.1 New modules (production)

| Module | Responsibility |
| --- | --- |
| `src/audit-integrity-alert-retry-policy.js` | Pure retry/backoff/attempt ceiling math; no I/O |
| `src/audit-integrity-alert-delivery-lifecycle.js` | Lifecycle WAL parse / serialize / load / publish / idle assertion under lease |
| `src/audit-integrity-alert-dead-letter.js` | Dead-letter FIFO parse / serialize / load / append / read/inspect under lease |
| `src/audit-integrity-alert-https-transport-outcome.js` | Pure `statusCode → detailed kind` classifier; no network |
| `src/audit-integrity-alert-delivery-retry.js` | Explicit `tick` coordinator: authorize → recover → claim → in-flight → detailed request → outcome branches → complete/DLQ |

### 5.2 Touched existing modules (contract-preserving)

| Module | Allowed change surface |
| --- | --- |
| `src/audit-integrity-alert-https-transport.js` | Add independent detailed executor + detailed test factory; keep existing public executor and public test factory returning only `accepted`/`rejected` |
| `src/audit-integrity-alert-outbox.js` | Manual public ack imports lifecycle idle assertion and refuses when lifecycle is non-idle under the same write lease (in addition to existing claimed-claim refusal) |
| `README.md` | Task 8 honesty text only; partial 6/3/0/9 preserved |
| `src/gold-readiness.js` | Task 8 honesty `nextStep`/blocker text only; statuses and counts stay partial 6/3/0/9 |

Forbidden touch surfaces in this batch:

- `src/audit-integrity-alert-delivery-claim.js` schema or claim algorithms (reuse as-is; do not extend manual-ack into claim module)
- `package-lock.json`
- credentials / env loaders
- LaunchAgent profiles / install
- Agent/API/Web route wiring for tick or DLQ
- managed scheduler code

### 5.3 Public programmatic API (frozen)

```js
// Pure policy (src/audit-integrity-alert-retry-policy.js)
export const AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS = 8;
export const AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS = Object.freeze([
  30_000,
  120_000,
  600_000,
  1_800_000,
  7_200_000,
  28_800_000,
  86_400_000,
]);
export function computeAuditIntegrityAlertRetryDueAt(lastAttemptAtIso, attemptCountAfterFailure);
export function computeAuditIntegrityAlertUncertainDueAt(
  lastAttemptAtIso,
  attemptCountAfterFailure,
  claimExpiresAtIso,
);
export function classifyAuditIntegrityAlertRetryDecision(attemptCount, detailedOutcomeKind);

// Lifecycle (src/audit-integrity-alert-delivery-lifecycle.js)
export const AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_RELATIVE_PATH =
  'audit/integrity-alert-delivery-lifecycle.json';
export const AUDIT_INTEGRITY_ALERT_DELIVERY_LIFECYCLE_MAX_BYTES = 16_384;
export function loadAuditIntegrityAlertDeliveryLifecycle(dataDir);
export function publishAuditIntegrityAlertDeliveryLifecycleUnderLease(dataDir, lease, state);
export function assertAuditIntegrityAlertDeliveryLifecycleIdle(state);
export function createIdleAuditIntegrityAlertDeliveryLifecycle(lastObservedAt);

// Dead-letter (src/audit-integrity-alert-dead-letter.js)
export const AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH =
  'audit/integrity-alert-dead-letter.json';
export const AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES = 1_048_576;
export const AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES = 256;
export function readAuditIntegrityAlertDeadLetter(dataDir);
export function appendAuditIntegrityAlertDeadLetterUnderLease(dataDir, lease, entry);
export function fingerprintAuditIntegrityAlertDeadLetterRaw(rawText);

// Pure detailed outcome classifier (src/audit-integrity-alert-https-transport-outcome.js)
export function classifyAuditIntegrityAlertHttpStatusDetailedOutcome(statusCode);

// Existing transport module gains detailed executor (src/audit-integrity-alert-https-transport.js)
export function executeAuditIntegrityAlertHttpsRequest(requestDescriptor);
export function createAuditIntegrityAlertHttpsExecutorForTesting(deps);
export function executeAuditIntegrityAlertHttpsRequestDetailed(requestDescriptor);
export function createAuditIntegrityAlertHttpsDetailedExecutorForTesting(deps);

// Tick coordinator (src/audit-integrity-alert-delivery-retry.js)
export function tickAuditIntegrityAlertDelivery(dataDir, endpoint, now, policy);
export function createAuditIntegrityAlertDeliveryRetryForTesting(deps);
```

Notes:

- `policy` is the already-compiled destination allowlist capability from the existing destination-policy module.
- Production `tick` performs authorize-before-claim using that capability, then advances one unit of work.
- Production `tick` calls **`executeAuditIntegrityAlertHttpsRequestDetailed`**, never the public-only executor, because public `rejected` cannot reconstruct retry class.
- There is **no** `startRetryWorker`, `scheduleRetry`, `setInterval`, or sleep helper.
- There is **no** `classifyAuditIntegrityAlertTransportDetailedOutcome(publicResult)` API. Public rejected results are insufficient.

### 5.4 Retry-policy input kinds versus persisted outcome kinds

**Policy / detailed-executor input kinds** (closed):

```text
accepted
retryable-rejected
terminal-rejected
uncertain
```

Mapping sources:

| Source | Kind passed to `classifyAuditIntegrityAlertRetryDecision` |
| --- | --- |
| Detailed executor returns `{schemaVersion:1, kind:'accepted'}` | `accepted` |
| Detailed executor returns `{schemaVersion:1, kind:'retryable-rejected'}` | `retryable-rejected` |
| Detailed executor returns `{schemaVersion:1, kind:'terminal-rejected'}` | `terminal-rejected` |
| Detailed executor throws fixed unavailable (DNS/TLS/timeout/close/throw) | `uncertain` |

**Persisted lifecycle `outcome.kind` for uncertain settlements** uses the string **`unknown`** (not the policy input token `uncertain`). Mapping:

```text
policy/decision input kind "uncertain"
  -> durable lifecycle outcome.kind = "unknown"
  -> outcome.detail = "uncertain-network" when settled after a completed uncertain network attempt
  -> outcome.detail = null when crash-recovering an open in-flight that never settled
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

Where `uncertain-hold` means: durable `retry-wait` with claim fields retained and `outcome.kind=unknown`.

### 5.5 Test factory dependency exact key order

`createAuditIntegrityAlertDeliveryRetryForTesting(deps)` accepts exact ordered keys:

```text
authorizeDestination
claimDelivery
completeDelivery
releaseDelivery
loadLifecycle
publishLifecycle
readOutbox
loadClaimState
readDeadLetter
appendDeadLetter
executeRequestDetailed
computeRetryDue
computeUncertainDue
classifyRetryDecision
```

Rules:

- `executeRequestDetailed` must resolve to a detailed result `{schemaVersion:1, kind}` or reject with fixed unavailable.
- Any extra, missing, reordered, accessor, Proxy, or non-function value fails closed with fixed unavailable.

### 5.6 Explicit tick contract

```js
tickAuditIntegrityAlertDelivery(dataDir, endpoint, now, policy) -> Promise<PublicReceipt>
```

Rules:

1. `now` is a canonical millisecond UTC ISO string `YYYY-MM-DDTHH:mm:ss.sssZ` and must equal `new Date(now).toISOString()`.
2. Module never reads `Date.now()` for policy decisions.
3. One tick performs at most:
   - one authorize evaluation;
   - one durable recovery/advance mutation chain under shared lease slices;
   - **at most one** network request via the detailed executor.
4. Concurrent ticks on the same root: at most one active claim / one request; others return `busy` / `not-due` / `blocked` / fixed error without double-settling.
5. Empty outbox with idle lifecycle returns `empty` and performs zero network.
6. No background continuation after the Promise settles.
7. Observing durable status `in-flight` at tick entry is always a crash-recovery case: the tick **must first** convert it to `retry-wait` (outcome unknown + effectiveDue) under lease and **must not** call the network against that open in-flight row.

---

## 6. Lifecycle WAL schema (exact freeze)

### 6.1 Path, bounds, publication grammar

- Relative path: `audit/integrity-alert-delivery-lifecycle.json`
- Max bytes: **16_384**
- Mode: `0600`
- Grammar: single compact JSON object + exactly one trailing newline (`\n`)
- Parse requires full-file raw identity: re-serialize must equal raw bytes
- Missing leaf = logical idle with `lastObservedAt: null` (no file created on pure read)
- Corrupt / wrong key order / wrong types / symlink leaf / directory leaf / BOM / extra newline / oversize → fixed fail closed, **zero mutation** (never published as `blocked`)

### 6.2 Exact top-level key order

```text
schemaVersion
status
lastObservedAt
streamId
sequence
idempotencyKey
attemptId
attemptCount
firstAttemptAt
lastAttemptAt
nextAttemptAt
claimId
claimExpiresAt
outcome
deadLetter
```

`schemaVersion` is exactly integer `1`.

### 6.3 Status enum (closed)

```text
idle
in-flight
retry-wait
accepted-pending-completion
dead-letter-prepared
blocked
```

No other status strings are valid.

### 6.4 Field types and null grammar

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | always |
| `status` | enum above | always string |
| `lastObservedAt` | canonical ISO or `null` | durable clock watermark; **retained on idle** once observed |
| `streamId` | lowercase UUIDv4 or `null` | null only on idle |
| `sequence` | positive safe integer or `null` | null only on idle |
| `idempotencyKey` | exact `audit-integrity-alert:<streamId>:<sequence>` or `null` | must match streamId+sequence when non-null; null only on idle |
| `attemptId` | lowercase UUIDv4 or `null` | null only on idle |
| `attemptCount` | integer `0..8` | `0` only on idle |
| `firstAttemptAt` | canonical ISO or `null` | null only on idle |
| `lastAttemptAt` | canonical ISO or `null` | null only on idle |
| `nextAttemptAt` | canonical ISO or `null` | null only when status does not wait for a future request |
| `claimId` | lowercase UUIDv4 or `null` | see status matrix; WAL may retain capability after claim file is idle |
| `claimExpiresAt` | canonical ISO or `null` | paired with claimId |
| `outcome` | closed object or `null` | see §6.6 |
| `deadLetter` | closed nested object or `null` | non-null only in `dead-letter-prepared` |

Canonical ISO: `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` and `Date#toISOString` identity.

UUIDv4: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`.

### 6.5 Status relationship matrix (required field binding)

Legend: `V` = required non-null/meaningful value; `0` = numeric zero; `N` = must be JSON `null`.

| status | lastObservedAt | streamId | sequence | idempotencyKey | attemptId | attemptCount | firstAttemptAt | lastAttemptAt | nextAttemptAt | claimId | claimExpiresAt | outcome | deadLetter |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `idle` | V or N\* | N | N | N | N | 0 | N | N | N | N | N | N | N |
| `in-flight` | V | V | V | V | V | 1..8 | V | V | N | V | V | N | N |
| `retry-wait` (unknown) | V | V | V | V | V | 1..7 | V | V | V | V | V | `{unknown,…}` | N |
| `retry-wait` (retryable, release pending) | V | V | V | V | V | 1..7 | V | V | V | V | V | `{retryable-rejected,…}` | N |
| `retry-wait` (retryable, release completed) | V | V | V | V | V | 1..7 | V | V | V | N | N | `{retryable-rejected,…}` | N |
| `accepted-pending-completion` | V | V | V | V | V | 1..8 | V | V | N | V | V | `{accepted,…}` | N |
| `dead-letter-prepared` | V | V | V | V | V | 1..8 | V | V | N | V | V | V terminal family | V |
| `blocked` (`dead-letter-full` only) | V | V | V | V | V | 1..8 | V | V | N | V | V | `{blocked,dead-letter-full}` | N |

\* First-ever missing file loads as idle with `lastObservedAt: null`. After any successful observation, idle retains the watermark and never rewinds it.

#### 6.5.1 `in-flight` semantics (exclusive)

`in-flight` means exactly one thing: a durable request attempt has been published and **has not yet received a durable settlement**.

Required:

- `outcome === null`
- `nextAttemptAt === null`
- `claimId` and `claimExpiresAt` are both V and match the live claim capability used for the attempt

Forbidden for `in-flight`:

- non-null outcome (including `unknown`)
- non-null `nextAttemptAt`
- null claim fields

Network is allowed only for the same tick that just published this open `in-flight` and still holds the in-memory attempt context. Any later tick that **loads** durable `in-flight` is crash recovery and must not request until after conversion to `retry-wait` (§8.4).

#### 6.5.2 `retry-wait` dual claim binding (exact)

| Subcase | `outcome.kind` | `outcome.detail` | claimId / claimExpiresAt | External claim file | Network |
| --- | --- | --- | --- | --- | --- |
| Settled uncertain | `unknown` | `uncertain-network` | **V / V retained** | remains claimed; **never release** | only after due, via new `in-flight` |
| Crash-recovered open attempt | `unknown` | `null` | **V / V retained** | remains claimed; **never release** for this conversion | only after due, via new `in-flight` |
| Retryable-rejected, release pending | `retryable-rejected` | `retryable-http` | **V / V retained** | still claimed until release succeeds | never while release pending |
| Retryable-rejected, release completed | `retryable-rejected` | `retryable-http` | **N / N** | idle | only after due, via fresh claim then new `in-flight` |

`nextAttemptAt` is **always V** for every `retry-wait` row.

attemptCount on `retry-wait` is `1..7` because attempt 8 terminalizes into dead-letter instead of waiting.

#### 6.5.3 `dead-letter-prepared` claim fields

Top-level lifecycle `claimId` and `claimExpiresAt` are **always V** for the entire prepared lifetime until the final publish of `idle`. Even when the external claim file has already been cleared to idle during step 4 residual recovery, the WAL itself still retains the original capability values for classification. Nested `deadLetter.claim` mirrors the same capability.

#### 6.5.4 `blocked` only for persistent dead-letter-full

`blocked` is frozen solely for preflight-proven **`dead-letter-full`** while the current head and claim must be retained.

All of the following are **V** (not optional, not null):

- `lastObservedAt`, `streamId`, `sequence`, `idempotencyKey`
- `attemptId`, `attemptCount` (1..8), `firstAttemptAt`, `lastAttemptAt`
- `claimId`, `claimExpiresAt`
- `outcome = {kind:'blocked', detail:'dead-letter-full'}`
- `nextAttemptAt = null`, `deadLetter = null`

DLQ corrupt/unsafe and lifecycle corrupt **never** enter `blocked`. They are fixed fail closed with zero mutation.

### 6.6 `outcome` object (exact keys when non-null)

Exact key order:

```text
kind
detail
```

Closed `kind` values:

| kind | When |
| --- | --- |
| `unknown` | Settled uncertain, or crash recovery conversion from open `in-flight` |
| `retryable-rejected` | Bounded retryable non-2xx classified |
| `terminal-rejected` | Bounded terminal non-2xx classified (may appear on prepared path before/with DLQ reason detail) |
| `accepted` | Bounded 2xx observed (`accepted-pending-completion`) |
| `attempts-exhausted` | Ceiling reached without acceptance (prepared / terminalization) |
| `blocked` | Persistent `dead-letter-full` only |

`detail` is either `null` or a path-free closed enum string from:

```text
null
terminal-http
retryable-http
uncertain-network
attempts-exhausted-retryable
attempts-exhausted-uncertain
dead-letter-full
```

Removed from detail enum (must not be stored as fake blockers): `dead-letter-corrupt`, `lifecycle-recovery`.

`detail` never contains endpoint, status code integers, body, header, IP, path, or raw error strings.

### 6.7 `deadLetter` nested transaction object (exact)

Non-null only when `status === 'dead-letter-prepared'`. Exact key order:

```text
deadLetterId
reason
sourceAlert
claim
deadLetterPre
deadLetterPost
outboxPre
outboxPost
preparedAt
```

#### 6.7.1 Scalar fields

- `deadLetterId`: lowercase UUIDv4 identifying this quarantine transaction
- `reason`: enum exactly one of:
  - `terminal-http`
  - `attempts-exhausted-retryable`
  - `attempts-exhausted-uncertain`
- `preparedAt`: canonical ISO

#### 6.7.2 `sourceAlert` (sanitized outbox head snapshot)

Exact keys (same as outbox entry, defensive copy):

```text
sequence
checkedAt
code
recoveryRequired
nextAction
reasonCode
```

Must equal the outbox FIFO head at prepare time for the bound `sequence`.

#### 6.7.3 `claim` capability binding

Exact keys:

```text
claimId
streamId
sequence
```

Equals the lifecycle top-level claim capability retained through prepared. Residual recovery uses this stored capability for classification and must not delete successors.

#### 6.7.4 Fingerprint objects

`deadLetterPre`, `deadLetterPost`, `outboxPre`, `outboxPost` share exact keys:

```text
sha256
byteLength
entryCount
nextSequence
```

Definitions:

- `sha256`: lowercase hex SHA-256 of the **exact raw file bytes** (or of canonical empty-state serialization when file missing and empty is legal)
- `byteLength`: UTF-8 byte length of those exact raw bytes (`Buffer.byteLength`)
- `entryCount`: number of entries in the parsed FIFO
- `nextSequence`: parsed `nextSequence` (positive safe integer)

For missing DLQ file before first append, `deadLetterPre` uses the canonical empty DLQ serialization:

```json
{"schemaVersion":1,"nextSequence":1,"entries":[]}
```

plus trailing newline, hashed as those exact bytes.

`outboxPre` / `outboxPost` always hash real outbox file bytes under the lease (outbox missing is not a legal delivery path when preparing dead-letter for a head).

Relationships that must hold at prepare publication:

- `deadLetterPost.entryCount === deadLetterPre.entryCount + 1` **or** exact duplicate idempotent case where post equals pre and the exact entry already exists (see §10)
- `deadLetterPost.nextSequence === deadLetterPre.nextSequence + 1` on first successful append of that entry identity; duplicate exact entry leaves counters unchanged
- `outboxPost` after successful ack: head removed; `entryCount` decreased by 1 when pre had ≥1; `nextSequence` unchanged
- `claim.sequence === sourceAlert.sequence === lifecycle.sequence === outbox head sequence` at prepare

### 6.8 Idle publication shape (exact example)

After successful delivery completion or successful dead-letter terminalization:

```json
{"schemaVersion":1,"status":"idle","lastObservedAt":"2026-08-05T12:00:00.000Z","streamId":null,"sequence":null,"idempotencyKey":null,"attemptId":null,"attemptCount":0,"firstAttemptAt":null,"lastAttemptAt":null,"nextAttemptAt":null,"claimId":null,"claimExpiresAt":null,"outcome":null,"deadLetter":null}
```

`lastObservedAt` is retained as the durable clock watermark. All other binding fields are null/zero.

### 6.9 Forbidden stored content

Lifecycle must **never** store:

- endpoint URL
- request body / headers / tokens
- DNS answers / IP addresses
- filesystem paths
- raw Error messages / errno / certificates
- remote response body / status code integers
- Authorization material

### 6.10 Lifecycle helpers

`assertAuditIntegrityAlertDeliveryLifecycleIdle(state)`:

- accepts a loaded/parsed lifecycle snapshot;
- returns void when `status === 'idle'` and the idle null/zero grammar holds;
- otherwise throws fixed `audit-delivery-unavailable`.

Used by outbox manual ack under the same write lease.

`createIdleAuditIntegrityAlertDeliveryLifecycle(lastObservedAt)` builds a canonical idle object with the supplied watermark (`null` or canonical ISO).

---

## 7. Dead-letter FIFO schema (exact freeze)

### 7.1 Path, bounds, publication grammar

- Relative path: `audit/integrity-alert-dead-letter.json`
- Max entries: **256**
- Max bytes: **1_048_576** (1 MiB)
- Mode: `0600`
- Compact JSON + exactly one trailing newline
- Full-file raw identity on parse
- Missing leaf = empty state on read; corrupt/unsafe → fixed fail closed, zero mutation

### 7.2 Top-level exact keys

```text
schemaVersion
nextSequence
entries
```

- `schemaVersion`: `1`
- `nextSequence`: positive safe integer (DLQ-local monotonic id allocator; starts at 1)
- `entries`: array length 0..256

### 7.3 Entry exact keys

```text
deadLetterSequence
deadLetterId
streamId
sequence
idempotencyKey
enqueuedAt
attemptCount
firstAttemptAt
lastAttemptAt
reason
sourceAlert
```

Identity for idempotency and duplicate detection:

```text
(streamId, sequence)
```

Field rules:

| Field | Rule |
| --- | --- |
| `deadLetterSequence` | positive safe integer; contiguous in file order; matches allocator |
| `deadLetterId` | UUIDv4; matches lifecycle prepared transaction |
| `streamId` | UUIDv4 |
| `sequence` | positive safe integer (outbox sequence of the quarantined alert) |
| `idempotencyKey` | `audit-integrity-alert:<streamId>:<sequence>` |
| `enqueuedAt` | canonical ISO |
| `attemptCount` | 1..8 |
| `firstAttemptAt` / `lastAttemptAt` | canonical ISO |
| `reason` | `terminal-http` \| `attempts-exhausted-retryable` \| `attempts-exhausted-uncertain` |
| `sourceAlert` | exact sanitized outbox entry snapshot (same keys as §6.7.2) |

Forbidden in entries: endpoint, network details, headers, bodies, IPs, paths, raw errors, claim owner pid/boot digests.

### 7.4 Append semantics

`appendAuditIntegrityAlertDeadLetterUnderLease(dataDir, lease, entry)` is the store helper only. It accepts exactly those three arguments; it does **not** accept prepared `deadLetterPost`, lifecycle state, or any other unfrozen parameter.

Under shared lease:

1. Load+parse DLQ (missing → empty).
2. If exact `(streamId, sequence)` exists:
   - if entry deep-equal to candidate → idempotent success, no rewrite required (or rewrite identical bytes);
   - if mismatch on any field → fail closed, zero mutation.
3. If new:
   - reject if `entries.length === 256` or serialized size would exceed 1 MiB;
   - append with `deadLetterSequence = nextSequence`, then `nextSequence += 1`;
   - publish canonical bytes mode `0600`;
   - re-read and verify **append-helper-owned** raw identity and local boundaries only (full-file re-serialize equals raw bytes; entryCount/nextSequence/contiguous sequences/byteLength within bounds).
4. On success (new or exact-duplicate idempotent), return a frozen actual post-append fingerprint object with exact keys `sha256`, `byteLength`, `entryCount`, `nextSequence` for the durable DLQ bytes after the operation (idempotent duplicate returns the current durable post fingerprint, which equals pre when no rewrite occurred).

**Coordinator-only duty:** comparing the actual post fingerprint to the prepared nested `deadLetter.deadLetterPost` from lifecycle is **not** the append helper’s responsibility. That comparison is owned by the dead-letter transaction coordinator at §10 Step 3. The append helper must not take prepared fingerprints as inputs and must not soft-pass a coordinator mismatch.

### 7.5 Read / inspect API

```js
readAuditIntegrityAlertDeadLetter(dataDir) -> FrozenSnapshot
```

Snapshot exact keys:

```text
schemaVersion
status
entryCount
nextSequence
entries
```

- `status`: `empty` \| `ready` (never “healthy delivery”)
- `entries`: deeply frozen defensive copies
- Read performs zero repair and zero truncation
- No requeue, drop, rewrite, or automatic deletion APIs in this batch

---

## 8. Clock, backoff, and attempt ledger

### 8.1 Clock watermark and rollback

- `tick` receives canonical ISO `now`.
- Lifecycle stores `lastObservedAt` as a durable watermark of the latest accepted observation.
- If `now < lastObservedAt` (lexicographic ISO compare is valid for canonical forms): **fixed fail closed, zero mutation**, do not write a backward watermark.
- Across process restarts, rollback detection uses this durable watermark only.
- This design **does not** claim an OS monotonic clock, `process.hrtime`, or cross-host time sync.
- Claim TTL and backoff due comparisons also use the supplied `now` against stored canonical ISO fields.

### 8.2 Attempt counting rules

- Maximum total attempts: **8** (`AUDIT_INTEGRITY_ALERT_RETRY_MAX_ATTEMPTS`).
- Attempt 1 is **immediate** when a head is eligible and not waiting.
- `attemptCount` increments **only** when publishing a new open `in-flight` that authorizes a new network request.
- Crash recovery conversion from open `in-flight` to `retry-wait` **must not** increment `attemptCount`.
- A new request after due recovery creates a **new** `attemptId` and increments `attemptCount` by exactly one when publishing the next open `in-flight`.

### 8.3 Backoff delays (exact)

After a failed attempt that remains retryable, delays before the next request are fixed milliseconds:

```text
[30_000, 120_000, 600_000, 1_800_000, 7_200_000, 28_800_000, 86_400_000]
```

| attemptCount after failure | delay before next request |
| --- | --- |
| 1 | 30s |
| 2 | 2m |
| 3 | 10m |
| 4 | 30m |
| 5 | 2h |
| 6 | 8h |
| 7 | 24h |
| 8 | no next request → attempts exhausted |

Formula:

```text
delayMs = AUDIT_INTEGRITY_ALERT_RETRY_BACKOFF_MS[attemptCountAfterFailure - 1]
nextAttemptAt = toCanonicalIso(Date.parse(lastAttemptAt) + delayMs)
```

`computeAuditIntegrityAlertRetryDueAt` fails closed if `attemptCountAfterFailure` is not in `1..7` or timestamps are non-canonical.

### 8.4 Open in-flight crash recovery and settled uncertain (both use retry-wait)

#### 8.4.1 Effective due for claim-retaining waits

```text
backoffDue = canonicalIso(Date.parse(lastAttemptAt) + delayMs(attemptCount))
claimDue   = claimExpiresAt
effectiveDue = max(backoffDue, claimDue)
```

#### 8.4.2 Crash recovery of durable open `in-flight`

When a tick loads `status === 'in-flight'` (always means outcome null, nextAttemptAt null):

1. Do **not** call the network.
2. Under the write lease, publish `retry-wait` with:
   - same `attemptCount`, `attemptId`, stream/sequence/idempotency, claim fields V retained
   - `outcome = {kind:'unknown', detail:null}`
   - `nextAttemptAt = effectiveDue` (using `lastAttemptAt` already stored on the open attempt)
3. Return public `retry-scheduled` or `not-due` according to `now` vs `nextAttemptAt`.
4. Only a **later** due tick may authorize a **new** open `in-flight` (new attemptId, attemptCount+1) and then request.

#### 8.4.3 Settled uncertain after a completed network attempt

When the detailed executor throws fixed unavailable after an open `in-flight` was published and the request was issued:

1. Publish `retry-wait` with:
   - `outcome = {kind:'unknown', detail:'uncertain-network'}`
   - `nextAttemptAt = effectiveDue = max(backoffDue, claimExpiresAt)`
   - `claimId` / `claimExpiresAt` **retained (V)**
2. **Never** call release.
3. Return public receipt `retry-scheduled` when the durable wait publish succeeds; if that publish fails, throw fixed unavailable and leave prior durable open `in-flight` for the crash-recovery path above.
4. When due: if claim still valid/replaceable per existing claim rules, publish a **new** open `in-flight` and enter the next attempt; same idempotency key.

**Revocation statement:** settled uncertain **uses `retry-wait`**. Wording that said uncertain avoids `retry-wait` is revoked.

### 8.5 Retryable rejection release choreography (exact)

For retryable bounded rejection with `attemptCount < 8`:

1. Publish lifecycle `retry-wait` with:
   - `outcome = {kind:'retryable-rejected', detail:'retryable-http'}`
   - `nextAttemptAt = backoffDue` (not claim-max; claim will be released)
   - **claimId / claimExpiresAt retained (V)** matching the exact live capability
2. Call `releaseAuditIntegrityAlertDelivery` with that exact capability.
3. On release success: publish the **same** logical `retry-wait` again with claim fields cleared to **N/N** (all other wait fields unchanged). Return public receipt `retry-scheduled` only after this claim-N publish succeeds.
4. On release failure or crash after step 1 (durable claim-V `retry-wait` already published). This path occurs **after** the original open `in-flight` detailed network attempt has already returned `retryable-rejected`:
   - the original attempt’s detailed request count for this settlement is **exactly one** (the request that produced `retryable-rejected`); never imply that original attempt was zero-network;
   - lifecycle remains durable `retry-wait` with claim fields V (**release-pending**);
   - the **same tick** that published claim-V wait and then observed release failure **throws** fixed `audit-delivery-unavailable` (it must not return a success receipt for that tick);
   - after claim-V publish and release failure, this failing tick must **not** issue any **additional** network request beyond that original detailed attempt;
   - subsequent ticks **only** attempt release recovery using the lifecycle-stored capability;
   - subsequent release-recovery ticks remain **zero network** until release completed (claim fields N) **and** `now >= nextAttemptAt`, then fresh claim and a new open `in-flight`.
5. When due after release completed: authorize → claim fresh → publish new open `in-flight` → enter the next attempt.

### 8.6 Accepted path attempt rule

On bounded 2xx (`kind: accepted`):

1. Publish `accepted-pending-completion` with `outcome = {kind:'accepted', detail:null}` **before** complete.
2. Complete outbox head + clear claim (existing order: ack first, then claim idle).
3. Publish lifecycle idle retaining watermark.
4. Later ticks seeing `accepted-pending-completion` only run complete/residual recovery — **never** request again for that occurrence. Impossible sequence relations fail closed.

### 8.7 Honesty: crash between remote 2xx and accepted-pending-completion

If the process dies after the remote may have accepted bytes but before lifecycle `accepted-pending-completion` is published:

- Local state is still open `in-flight` (or converts via §8.4.2 to `retry-wait` unknown).
- Local state cannot prove remote acceptance.
- After due rules allow, local may **re-send** with the **same idempotency key**.
- This is **at-least-once**, not exactly-once.
- Receivers that ignore the idempotency key may observe duplicates; that is accepted.

---

## 9. Detailed transport outcome architecture

### 9.1 Why public rejected is insufficient

The existing public executor returns only:

```js
{ schemaVersion: 1, status: 'accepted' }
{ schemaVersion: 1, status: 'rejected' }
```

or throws fixed `audit-delivery-unavailable` for uncertain paths.

After settlement, the integer HTTP status code is discarded. Therefore **`{status:'rejected'}` cannot be classified** into retryable vs terminal. Retry code must never call `classifyAuditIntegrityAlertTransportDetailedOutcome(publicResult)`.

### 9.2 Pure classifier (no network)

Module: `src/audit-integrity-alert-https-transport-outcome.js`

```js
classifyAuditIntegrityAlertHttpStatusDetailedOutcome(statusCode)
  -> frozen { schemaVersion: 1, kind: 'accepted' | 'retryable-rejected' | 'terminal-rejected' }
```

Rules:

- non-integer / non-safe-integer statusCode → fixed fail closed
- `200 <= statusCode <= 299` → `accepted`
- `statusCode` in `{408, 425, 429}` or `500 <= statusCode <= 599` → `retryable-rejected`
- any other final integer status → `terminal-rejected`

Exact result keys: `schemaVersion`, `kind` only. No status code field on the result.

### 9.3 Detailed executor (independent surface)

In `src/audit-integrity-alert-https-transport.js`, add:

```js
executeAuditIntegrityAlertHttpsRequestDetailed(requestDescriptor)
createAuditIntegrityAlertHttpsDetailedExecutorForTesting(deps)
```

Behavior:

- Same bounds, DNS pin, TLS options, single-settlement, and uncertain throw semantics as the public executor.
- At the response settlement edge, while the integer `statusCode` is still in hand, call `classifyAuditIntegrityAlertHttpStatusDetailedOutcome(statusCode)`.
- Resolve with exact frozen `{ schemaVersion: 1, kind }` for accepted / retryable-rejected / terminal-rejected.
- Uncertain paths throw fixed `audit-delivery-unavailable` (no detailed object).

Test-factory `deps` exact key order matches the public factory’s deps (including `request`, `lookupAll`, `setTimer`, `clearTimer` as already frozen by the allowlist/transport batch). The detailed factory is a separate export; it does not alter the public factory’s return type.

### 9.4 Public executor compatibility (verbatim)

Existing exports remain:

```js
executeAuditIntegrityAlertHttpsRequest(requestDescriptor)
createAuditIntegrityAlertHttpsExecutorForTesting(deps)
```

They continue to return only:

```js
{ schemaVersion: 1, status: 'accepted' }
{ schemaVersion: 1, status: 'rejected' }
```

or throw fixed unavailable. Public rejected collapses both retryable and terminal finals. One-shot coordinator paths that still use the public executor stay behavior-compatible.

### 9.5 Explicit non-behavior

- Do **not** parse `Retry-After`
- Do **not** parse response body or content-type
- Do **not** log status codes
- Do **not** return status codes on public tick receipts
- Do **not** provide `classifyAuditIntegrityAlertTransportDetailedOutcome(publicResult)`

### 9.6 Mapping to retry decision

```text
accepted
  -> accept-complete
  -> publish accepted-pending-completion
  -> complete
  -> publish idle

retryable-rejected + attemptCount < 8
  -> retry-wait path (§8.5)

retryable-rejected + attemptCount == 8
  -> dead-letter reason attempts-exhausted-retryable

terminal-rejected
  -> dead-letter reason terminal-http (any attemptCount)

uncertain throw + attemptCount < 8
  -> retry-wait unknown hold (§8.4.3)

uncertain throw + attemptCount == 8
  -> dead-letter reason attempts-exhausted-uncertain
```

---

## 10. Dead-letter transaction order (exact)

When a terminal local decision requires quarantine of the current head:

### Step 1 — Preflight under shared lease

Under `enqueueAuditIntegrityWriteTask`:

1. Revalidate stream identity, outbox head, claim capability, lifecycle binding.
2. Load DLQ; compute `deadLetterPre` fingerprint.
3. Build candidate entry; compute would-be `deadLetterPost` fingerprint and size.
4. If DLQ would exceed 256 entries or 1 MiB: **do not** publish `dead-letter-prepared`. Publish lifecycle `blocked` with `outcome = {kind:'blocked', detail:'dead-letter-full'}` and **all blocked matrix fields V**, retain outbox head and claim, return public `blocked`. Later ticks only return `blocked` until operator capacity repair in a future batch (no auto-drop here).
5. If DLQ corrupt/unsafe at preflight: **zero mutation, fixed fail**. Never write `blocked` for corrupt.
6. If lifecycle bytes are corrupt at load: **zero mutation, fixed fail**. Lifecycle cannot record a blocker into itself.

### Step 2 — Publish lifecycle `dead-letter-prepared`

Publish canonical lifecycle including full `deadLetter` nested transaction object and **top-level claimId/claimExpiresAt V**.

### Step 3 — Append/verify exact dead-letter entry

Coordinator calls `appendAuditIntegrityAlertDeadLetterUnderLease` with only `(dataDir, lease, entry)`. The append helper verifies its own raw identity and local boundaries and returns the actual post fingerprint (§7.4). The coordinator then compares that **returned** actual post fingerprint to the prepared nested `deadLetter.deadLetterPost`.

**Sole continue condition:** returned actual post equals prepared `deadLetterPost`. Only then may the coordinator proceed to Step 4 (ack/clear).

Exact-duplicate paths are **not** one rule about `deadLetterPre` vs `deadLetterPost`:

- **Crash recovery after prepared + successful append:** a later tick may re-call append and observe exact-duplicate idempotent success. Returned actual post equals prepared `deadLetterPost`, while prepared `deadLetterPre !== deadLetterPost` (the entry is already durable). This is normal recovery and must continue when the sole continue condition holds.
- **Preflight when DLQ already holds the exact same identity/entry:** prepared may freeze a no-op post with `deadLetterPre === deadLetterPost` only when that preflight model explicitly computes no-op post. That equality must **not** be generalized to every exact-duplicate path.

**Fail closed (no Step 4 ack, no claim clear):** returned actual post does not equal prepared `deadLetterPost`; or append fails closed on identity field mismatch. Lifecycle remains `dead-letter-prepared`; zero unsafe further mutation.

### Step 4 — Acknowledge exact outbox head and clear claim

Reuse existing complete residual semantics:

1. Acknowledge exact outbox head first (lease-guarded internal ack).
2. Then publish claim idle / clear residual.
3. **Never** clear claim before outbox ack.
4. Ack success + claim clear failure must be recoverable via residual; **never** delete successor head.
5. Lifecycle top-level claim fields remain V until step 5 even if the claim file is already idle.

### Step 5 — Publish lifecycle `idle`

Publish idle with retained `lastObservedAt` watermark; all other fields null/zero; `deadLetter` null; claim fields finally N.

---

## 11. Crash truth tables

### 11.1 Dead-letter crash truth table

Axes:

- DLQ: `pre` (entry absent) | `post` (exact entry present)
- Outbox: `pre` (head present) | `post` (head acked/absent for that sequence)
- Claim file: `claimed` | `idle`
- Lifecycle: `dead-letter-prepared` with top-level claim fields V until idle

| DLQ | Outbox | Claim file | Lifecycle | Recovery action on next tick |
| --- | --- | --- | --- | --- |
| pre | pre | claimed | prepared | resume step 3 append |
| pre | pre | claimed | not prepared | not in DLQ tx; normal paths |
| pre | pre | idle | prepared | fail closed (default); WAL claim fields still V for diagnosis |
| post | pre | claimed | prepared | resume step 4 ack head, then clear claim, then idle |
| post | pre | idle | prepared | resume step 4 ack head using WAL capability classification, then lifecycle idle |
| post | post | claimed | prepared | residual clear claim only; then lifecycle idle; **never** ack successor |
| post | post | idle | prepared | publish lifecycle idle only (WAL claim fields cleared only by idle publish) |
| post | post | idle | idle | no-op success path |
| pre | post | any | prepared | **fail closed** (outbox advanced without DLQ evidence) |
| fingerprint / sequence / other bytes mismatch | any | any | prepared | **fail closed**, zero unsafe mutation; prepared remains |

Additional invariants:

- `DLQ-post + outbox-pre` **must ack** the exact prepared sequence head.
- `DLQ-post + outbox-post + claim residual` **must idempotent clear** claim only.
- `DLQ-post + outbox-post + claim idle` **direct lifecycle idle**.
- `DLQ-pre + outbox-post` or any other bytes/sequence mismatch → **fail closed**.
- Ack success / claim clear failure is always recoverable; successor deletion is forbidden.

### 11.2 Accepted-completion crash truth table

| Lifecycle | Outbox head | Claim file | Action |
| --- | --- | --- | --- |
| accepted-pending-completion | exact sequence present | claimed matching | complete (ack then idle claim) then lifecycle idle |
| accepted-pending-completion | residual (head advanced) | claimed residual | already-completed clear claim; lifecycle idle |
| accepted-pending-completion | residual | idle | lifecycle idle only |
| accepted-pending-completion | sequence mismatch | any | fail closed |
| open in-flight after possible 2xx (no accepted-pending-completion) | head present | claimed | convert to retry-wait unknown (§8.4.2); later due enters next attempt with same idempotency key (at-least-once honesty) |

### 11.3 In-flight / retry-wait crash truth table

| Durable lifecycle at tick entry | Claim file | Due? | Action |
| --- | --- | --- | --- |
| `in-flight` (open; outcome null) | claimed matching | any | convert to `retry-wait` unknown + effectiveDue; **zero network** this conversion |
| `retry-wait` unknown (claim fields V) | claimed | no | `not-due` or `retry-scheduled`; zero network |
| `retry-wait` unknown (claim fields V) | claimed | yes | new open `in-flight` (new attemptId, attemptCount+1) then one detailed request; same idempotency key |
| `retry-wait` unknown (claim fields V) | dead/expired replaceable | yes | existing claim replacement rules, then new open `in-flight` and enter next attempt |
| `retry-wait` retryable release-pending (claim fields V) | claimed residual | any | release recovery only; zero network |
| `retry-wait` retryable release-pending (claim fields V) | idle already | any | publish claim fields N (align WAL); still no network until due |
| `retry-wait` retryable release-completed (claim fields N) | idle | no | `not-due` |
| `retry-wait` retryable release-completed (claim fields N) | idle | yes | authorize → fresh claim → new open `in-flight` → enter next attempt |

### 11.4 Blocked / corrupt table

| Condition | Mutation | Public |
| --- | --- | --- |
| DLQ full detected before prepared | lifecycle `blocked` detail `dead-letter-full`; all blocked fields V; retain head+claim | `blocked` |
| DLQ corrupt/unsafe | zero mutation | fixed error |
| Lifecycle corrupt | zero mutation | fixed error |
| Clock rollback `now < lastObservedAt` | zero mutation | fixed error |
| Prepared fingerprint mismatch | zero unsafe mutation; stay prepared | fixed error |

---

## 12. Full state transition catalog

### 12.1 Happy path first attempt

```text
idle + empty outbox
  -> receipt empty

idle + head eligible
  -> authorize
  -> claim
  -> publish open in-flight (attemptCount=1, new attemptId, outcome=null, nextAttemptAt=null, claim fields V)
  -> one detailed network request
  -> kind accepted
  -> publish accepted-pending-completion
  -> complete (ack outbox, clear claim)
  -> publish idle (watermark retained)
  -> receipt delivered
```

### 12.2 Retryable rejection with budget remaining

```text
open in-flight attempt k (k < 8)
  -> kind retryable-rejected
  -> publish retry-wait (outcome retryable-rejected, nextAttemptAt=backoffDue, claim fields V)
  -> release exact claim
  -> publish retry-wait again (same wait fields, claim fields N)
  -> receipt retry-scheduled

later tick now < nextAttemptAt
  -> receipt not-due (zero network)

later tick now >= nextAttemptAt and claim fields N
  -> authorize
  -> fresh claim
  -> publish open in-flight attempt k+1
  -> enter the next attempt
```

Release-pending recovery:

```text
same tick after claim-V retry-wait publish + release failure
  -> throw fixed audit-delivery-unavailable
  -> durable release-pending retained (claim fields V)

later tick: retry-wait retryable with claim fields V
  -> release only
  -> on success publish claim fields N
  -> zero network until due after release completed
```

### 12.3 Uncertain settlement with budget remaining

```text
open in-flight attempt k (k < 8)
  -> detailed executor throws fixed unavailable
  -> publish retry-wait (outcome unknown/uncertain-network, nextAttemptAt=max(backoffDue, claimExpiresAt), claim fields V)
  -> never release
  -> receipt retry-scheduled
```

Crash before settlement:

```text
durable open in-flight loaded by later tick
  -> publish retry-wait (outcome unknown/detail null, nextAttemptAt=effectiveDue, claim fields V)
  -> zero network on this conversion
  -> when due: publish open in-flight attempt k+1 and enter the next attempt
```

### 12.4 Terminal rejection

```text
open in-flight (any attemptCount)
  -> kind terminal-rejected
  -> dead-letter transaction (reason terminal-http)
  -> receipt dead-lettered
```

### 12.5 Attempts exhausted

```text
attemptCount == 8 + retryable-rejected
  -> DLQ reason attempts-exhausted-retryable

attemptCount == 8 + uncertain throw
  -> DLQ reason attempts-exhausted-uncertain
```

### 12.6 DLQ full

```text
terminal decision + DLQ full preflight
  -> lifecycle blocked (dead-letter-full) with all blocked fields V
  -> retain outbox head + claim
  -> receipt blocked
  -> future ticks: only blocked (no network, no ack)
```

### 12.7 Concurrent ticks

```text
tick A holds claim / open in-flight or recovery work
tick B -> busy or not-due or blocked as state dictates
single-settle: only one detailed request executor call
```

---

## 13. Public receipt contract

### 13.1 Closed status set (single set, no duplicates)

```text
idle
empty
not-due
busy
delivered
retry-scheduled
dead-lettered
blocked
```

`tick` on idle lifecycle + empty outbox returns `empty`. `idle` is available as a sanitized observation receipt when a caller-facing path reports idle lifecycle without work; it is not required on every path.

### 13.2 Exact receipt keys by status

Common required top keys for all receipts (exact order):

```text
schemaVersion
status
streamId
sequence
attemptCount
nextAttemptAt
pendingCount
detail
```

Rules:

- `schemaVersion`: `1`
- `status`: exactly one value from the closed set in §13.1
- `streamId` / `sequence`: UUIDv4 / positive int when bound to a head; otherwise `null`
- `attemptCount`: integer `0..8` or `null` only where §13.3 freezes `null`
- `nextAttemptAt`: canonical ISO or `null` only where §13.3 freezes `null`
- `pendingCount`: non-negative safe integer or `null` only where §13.3 freezes `null` (no status may leave this field ambiguous between null and a number)
- `detail`: path-free enum or `null` (never internal stacks)

`pendingCount` semantics when non-null: remaining outbox FIFO `entries.length` observed for that receipt (after successful ack on `delivered` / `dead-lettered`; while head still present on wait/busy/blocked paths).

Forbidden on all receipts:

- `claimId`, `attemptId`
- endpoint, URL, headers, body
- IP, DNS, path, filename
- raw error messages
- HTTP status codes
- deadLetter fingerprints / SHA digests

### 13.3 Status-specific requirements

Closed status rows below are exactly the §13.1 set (no additions, no omissions). Every receipt still carries the §13.2 exact key order including `pendingCount`.

| status | streamId/sequence | attemptCount | nextAttemptAt | pendingCount | detail |
| --- | --- | --- | --- | --- | --- |
| `empty` | null/null | null | null | `0` | null |
| `not-due` | V/V | V (`1..8`) | V | V (`≥1`) | null |
| `busy` | V/V | V (`0..8`) | null | V (`≥1`) | null |
| `delivered` | V/V | V (`1..8`) | null | V (`≥0`) | null |
| `retry-scheduled` | V/V | V (`1..7`) | V | V (`≥1`) | null or `retryable-http` or `uncertain-network` |
| `dead-lettered` | V/V | V (`1..8`) | null | V (`≥0`) | reason enum (`terminal-http` \| `attempts-exhausted-retryable` \| `attempts-exhausted-uncertain`) |
| `blocked` | V/V | V (`1..8`) | null | V (`≥1`) | `dead-letter-full` |
| `idle` | null/null | `0` | null | null | null |

Freeze notes (remove null/number ambiguity):

- `empty`: outbox observed empty → `pendingCount` is exactly integer `0`, never `null`.
- `not-due` / `busy` / `retry-scheduled` / `blocked`: head still present → `pendingCount` is a positive safe integer (`≥1`), never `null`.
- `delivered` / `dead-lettered`: after successful outbox ack of the bound head → `pendingCount` is the remaining entry count (`≥0`), never `null`.
- `idle`: sanitized idle observation without an outbox pending snapshot → `pendingCount` is exactly JSON `null`, never `0` (use `empty` when the tick observed an empty outbox).
- `busy`: `nextAttemptAt` is exactly `null` (busy is claim/work contention, not a due-wait receipt).
- `idle`: `attemptCount` is exactly integer `0`, never `null`.

Deep freeze all receipts.

### 13.4 Public errors

All thrown public errors from tick/retry modules are fresh `LinkeError` with code/message surface `audit-delivery-unavailable` and **no** blocker internal details, paths, endpoints, or status codes.

Sanitized DLQ `reason` may appear on **dead-letter inspection snapshots** and on `dead-lettered` receipt `detail`, not on thrown errors.

---

## 14. Manual acknowledgement interaction

Under the same write lease, public/manual outbox acknowledgement must refuse when **either**:

1. claim status is `claimed`; or
2. lifecycle status is **not** `idle` (via `assertAuditIntegrityAlertDeliveryLifecycleIdle` after load under the same lease).

Rationale: prevents operators from advancing a successor while dead-letter / accepted-pending-completion / retry-wait / in-flight / blocked transactions are unfinished.

Refusal is fixed `audit-delivery-unavailable` with zero mutation.

Implementation locus: **`src/audit-integrity-alert-outbox.js`** imports the lifecycle idle assertion. The claim module is not modified for this gate.

Delivery completion and dead-letter step 4 remain the only paths that may use lease-guarded internal head acknowledgement during non-idle lifecycle.

---

## 15. Concurrency and single-settle

1. Same-root write lease serializes durable mutations.
2. Claim fencing ensures at most one live capability for a head.
3. Tick entry that observes durable open `in-flight` performs recovery conversion first; it does not race a second request against the open row.
4. Detailed transport settlement remains single-shot per request.
5. Lifecycle publish of terminal transitions is single-settle: a second tick must observe durable state and take recovery branches, never double-append mismatched DLQ entries.
6. Concurrent ticks: one progresses; others return `busy` / `not-due` / `blocked` / empty without network.

---

## 16. Privacy and security ceiling

### 16.1 Must not persist or return

- endpoint strings
- Authorization / tokens / cookies
- request/response bodies
- headers beyond the fact that transport used only content-type + idempotency-key internally
- DNS answers, IPs, certificates
- filesystem paths
- raw exceptions
- HTTP status codes on public surfaces

### 16.2 May persist

- streamId, sequence, idempotency key
- sanitized source alert fields already allowed in outbox
- attempt counters and canonical timestamps
- closed reason enums
- SHA-256 fingerprints of local durable files for crash evidence

### 16.3 Authorize-before-claim remains mandatory

Tick production path:

```text
authorize(endpoint) -> primitive string identical to input
then recover / claim / request
```

Deny ⇒ zero claim, zero DNS, zero request, zero lifecycle attempt increment.

### 16.4 Observability ceiling

Allowed local observability in this batch:

- public receipts as defined
- DLQ inspect snapshot
- lifecycle load for tests/operators via library read without secrets

Forbidden:

- metrics labels with endpoints
- verbose error logs with status codes
- tracing payloads with bodies

No new Agent/API/Web metrics endpoints in this batch.

---

## 17. State invariants (summary checklist)

1. Outbox remains monotonic FIFO; no schema migration.
2. Claim remains single-slot fencing; no schema migration.
3. Lifecycle is single canonical object; exact keys/order/null grammar.
4. `in-flight` means open attempt only: outcome null, nextAttemptAt null, claim fields V.
5. Crash recovery never networks from loaded open `in-flight`; convert to `retry-wait` unknown first.
6. Settled uncertain is `retry-wait` with claim fields V; never release.
7. Retryable-rejected release order: retry-wait+claim V → release → retry-wait+claim N.
8. `dead-letter-prepared` top-level claim fields stay V until idle publish.
9. `blocked` is only persistent `dead-letter-full` with all binding fields V.
10. DLQ/lifecycle corrupt → zero mutation fixed fail (never blocked).
11. `attemptCount ∈ [0,8]`; increments only on new open in-flight publish.
12. Network request requires durable open in-flight publish first.
13. 2xx → accepted-pending-completion before complete.
14. Complete/DLQ ack never deletes successor; residual is already-completed/clear.
15. DLQ entry identity `(streamId, sequence)` exact-duplicate idempotent; mismatch fail closed.
16. Manual ack refused on claim claimed **or** lifecycle non-idle.
17. Public errors fixed unavailable.
18. Detailed retry classification uses detailed executor + pure statusCode classifier; not public rejected.
19. No scheduler / sleep / background worker.
20. At-least-once honesty preserved; never claim exactly-once.
21. Gold remains partial 6/3/0/9.

---

## 18. TDD matrix (design-level)

Behavior-first RED/GREEN is mandatory. Categories:

| ID | Behavior |
| --- | --- |
| P1 | pure backoff table exact ms and nextAttemptAt |
| P2 | attempt ceiling decisions for kinds accepted / retryable-rejected / terminal-rejected / uncertain |
| L1 | lifecycle parse exact keys/order/null grammar including dual retry-wait claim bindings |
| L2 | lifecycle reject corrupt/hostile/Proxy/accessor |
| L3 | idle retains watermark; no rewind write |
| L4 | publish mode 0600 and raw identity |
| L5 | `assertAuditIntegrityAlertDeliveryLifecycleIdle` accepts only idle grammar |
| D1 | DLQ empty/missing read |
| D2 | DLQ append bounds 256 / 1MiB |
| D3 | DLQ duplicate exact idempotent; mismatch fail |
| D4 | DLQ entry exact keys; no endpoint fields |
| O1 | pure statusCode mapping 408/425/429/5xx → retryable-rejected |
| O2 | pure statusCode mapping terminal non-2xx |
| O3 | pure statusCode mapping 2xx → accepted |
| O4 | detailed executor returns `{schemaVersion,kind}` at settlement edge |
| O5 | public executor still accepted/rejected only; one-shot tests remain green |
| T1 | tick empty |
| T2 | tick publishes open in-flight before detailed request |
| T3 | accepted-pending-completion then complete |
| T4 | retryable: retry-wait claim V → release → retry-wait claim N |
| T5 | settled uncertain: retry-wait claim V; never release; due max(backoff, claimExp) |
| T6 | loaded open in-flight converts to retry-wait unknown; zero network on conversion |
| T7 | not-due zero network |
| T8 | attempts exhausted → DLQ reasons |
| T9 | terminal-http → DLQ |
| T10 | crash tables §11 |
| T11 | concurrent ticks single detailed request |
| T12 | clock rollback zero mutation |
| T13 | manual ack refused for claim claimed and for lifecycle non-idle |
| T14 | blocked dead-letter-full sticky with all fields V |
| T15 | privacy: no secrets in receipts/errors/files |
| T16 | authorize deny zero side effects |
| T17 | old-HEAD RED authenticity for each new test file |

No test may perform real external network I/O. Fake transport/DNS only.

---

## 19. Implementation slices (design map)

Mapped 1:1 to the companion plan tasks:

1. Pure retry policy module + tests
2. Lifecycle parser/publisher + idle assertion + tests
3. Dead-letter FIFO store/read + tests
4. Pure outcome classifier + detailed transport executor (four fixed files)
5. Explicit tick + open in-flight / retry-wait / accepted-completion paths
6. Dead-letter transaction + crash recovery (retry source + retry test only)
7. Outbox manual-ack lifecycle gate + integration concurrency/privacy tests
8. README + gold-readiness honesty + full suite closure

No slice implements a scheduler.

---

## 20. Gold boundary and honesty

This batch, when implemented, still provides only:

- local durable retry/backoff ledger
- local dead-letter quarantine FIFO
- programmatic tick advancement
- at-least-once delivery attempts under existing claim/transport gates

It does **not** provide:

- managed scheduling
- remote notification delivery ready
- production monitoring ready
- end-to-end production audit delivery
- production-hardening ready
- Gold / GA

Gold scorecard remains partial **6/3/0/9**. No design text or future commit message may claim Gold promotion from this work alone.

---

## 21. Key Decisions

1. **Architecture C** — lifecycle WAL + DLQ FIFO; freeze outbox/claim schemas.
2. **Explicit `tick(now)` only** — no managed scheduler in this batch.
3. **Open `in-flight` only** — outcome null, nextAttemptAt null, claim V; crash converts to `retry-wait` before any network.
4. **Settled uncertain uses `retry-wait` with claim retained** — prior “uncertain avoids retry-wait” wording is revoked.
5. **Retryable release choreography** — retry-wait+claim V → release → retry-wait+claim N.
6. **Accepted requires accepted-pending-completion before complete**.
7. **Detailed executor separate from public accepted/rejected surface**.
8. **Honest at-least-once** after 2xx/local crash windows.
9. **Dead-letter exact 5-step transaction** with fingerprint crash evidence; prepared claim fields V until idle.
10. **`blocked` only for dead-letter-full** with all binding fields V; corrupt paths fixed fail.
11. **Manual ack refuses claim claimed or lifecycle non-idle** (outbox imports lifecycle assertion).
12. **Privacy ceiling** forbids endpoint/body/IP/status storage on public surfaces.
13. **Gold remains partial 6/3/0/9**.

---

## 22. Open Questions

None remaining for this batch. Deferred items are explicitly non-goals (§2), including operator requeue/drop as a future contract only.

---

## 23. PR Plan

### PR1 — Pure retry policy

- Files: `src/audit-integrity-alert-retry-policy.js`, `test/audit-integrity-alert-retry-policy.test.js`
- Deps: none
- Delivers frozen backoff constants and pure decision helpers for kinds accepted / retryable-rejected / terminal-rejected / uncertain

### PR2 — Lifecycle WAL

- Files: `src/audit-integrity-alert-delivery-lifecycle.js`, `test/audit-integrity-alert-delivery-lifecycle.test.js`
- Deps: none
- Delivers parse/publish/load, idle assertion, dual retry-wait claim bindings

### PR3 — Dead-letter FIFO

- Files: `src/audit-integrity-alert-dead-letter.js`, `test/audit-integrity-alert-dead-letter.test.js`
- Deps: none
- Delivers bounded append/read/inspect

### PR4 — Detailed transport outcome

- Files: `src/audit-integrity-alert-https-transport-outcome.js`, `test/audit-integrity-alert-https-transport-outcome.test.js`, `src/audit-integrity-alert-https-transport.js`, `test/audit-integrity-alert-https-transport.test.js`
- Deps: existing transport public surface
- Delivers pure classifier + detailed executor; public accepted/rejected unchanged

### PR5 — Tick coordinator core paths

- Files: `src/audit-integrity-alert-delivery-retry.js`, `test/audit-integrity-alert-delivery-retry.test.js`
- Deps: PR1–PR4, existing claim/outbox/authorize
- Delivers empty/not-due/busy/delivered/retry-scheduled paths including open in-flight recovery conversion

### PR6 — Dead-letter transaction + crash recovery

- Files: `src/audit-integrity-alert-delivery-retry.js`, `test/audit-integrity-alert-delivery-retry.test.js`
- Deps: PR5
- Delivers §10–§11 inside the retry module and its test

### PR7 — Integration gates

- Files: `src/audit-integrity-alert-outbox.js`, `src/audit-integrity-alert-delivery-retry.js`, `test/audit-integrity-alert-outbox.test.js`, `test/audit-integrity-alert-delivery-retry-integration.test.js`
- Deps: PR6
- Delivers manual-ack lifecycle gate, concurrency, authorize deny, privacy

### PR8 — Honesty + full suite

- Files: `README.md`, `src/gold-readiness.js`, `test/readme.test.js`, `test/gold-readiness.test.js`
- Deps: PR7
- Delivers Gold-boundary honesty; no Gold flip; partial 6/3/0/9 retained

Each PR is independently reviewable; no PR includes scheduler/Agent/API/Web wiring.

---

## 24. Companion plan

Executable TDD plan:

`docs/superpowers/plans/2026-08-05-audit-integrity-alert-durable-retry-plan.md`

---

## 25. Document freeze statement

This specification freezes schema, order, crash recovery, TDD matrix, and task decomposition for durable retry/backoff/dead-letter. Implementation must not widen scope into managed scheduling, host wiring, or Gold claims. Any deviation from exact key orders, reason enums, attempt ceiling, backoff array, transaction steps, lifecycle dual retry-wait claim bindings, detailed-executor architecture, or privacy ceiling requires a new design revision—not silent code drift.
