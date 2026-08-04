# Audit Integrity Alert Bounded HTTPS Transport Design

Date: 2026-08-05
Status: Approved under the user's standing default-confirmation authorization
Release surface: V1.46 production-hardening partial only; not Gold

## Goal

Add the first real, bounded, programmatic HTTPS attempt for one already-claimed audit-integrity alert. The slice must preserve the durable claim/fencing semantics delivered by `src/audit-integrity-alert-delivery-claim.js`, distinguish a verified 2xx response from an explicit non-2xx rejection, and remain honest about uncertain network outcomes.

This slice is one-shot only. It does not add automatic retry, backoff, dead-letter storage, a scheduler, a background worker, Agent/API/Web/config wiring, deployment, installation, or real staging-delivery evidence.

## Existing Contract

`buildAuditIntegrityAlertDeliveryRequest` already returns a deeply frozen canonical descriptor with:

- an HTTPS URL without credentials, query, or fragment;
- method `POST`;
- only `content-type` and `idempotency-key` headers;
- a compact JSON body whose semantics are `at-least-once`.

`claimAuditIntegrityAlertDelivery` returns one of `empty`, `busy`, or `claimed`. A claimed receipt includes the exact claim capability and request descriptor. `completeAuditIntegrityAlertDelivery` acknowledges only the fenced FIFO head. `releaseAuditIntegrityAlertDelivery` returns an exact live claim to idle without changing the outbox.

The claim TTL is 120 seconds. It is the conservative hold interval for uncertain delivery outcomes; it is not an exactly-once guarantee.

## Considered Approaches

### A. Layered bounded executor plus one-shot coordinator — selected

Keep the HTTPS state machine separate from durable claim state. A low-level module validates and executes the frozen request descriptor. A one-shot coordinator owns `claim -> execute -> complete/release` policy.

This makes network races and durable-state races independently testable and prevents future retry policy from leaking into the transport primitive.

### B. One combined transport/claim module — rejected

This uses fewer files but mixes socket settlement, response bounds, claim fencing, outbox acknowledgement, and crash recovery. The combined state machine is harder to audit and easier to settle twice.

### C. Immediate retry/backoff/dead-letter worker — deferred

This would cross several independent Gold gates in one change. It also requires a durable attempt ledger, a scheduling policy, and observability that do not belong in the first transport slice.

## Components

### `src/audit-integrity-alert-https-transport.js`

Exports:

- `AUDIT_INTEGRITY_ALERT_HTTPS_TIMEOUT_MS = 10_000`;
- `AUDIT_INTEGRITY_ALERT_HTTPS_MAX_RESPONSE_BYTES = 4_096`;
- a production executor for one frozen request descriptor;
- a narrowly marked internal factory for deterministic tests.

The internal factory accepts exactly a request implementation and timer functions. It must not accept caller-provided request options, Agent objects, TLS validators, response validators, proxy settings, or environment data. The production executor binds Node's built-in HTTPS and timer implementations.

The executor internally constructs all request options:

- exact HTTPS URL and `POST` method from the descriptor;
- exact descriptor headers plus `content-length`, calculated with `Buffer.byteLength(body, 'utf8')`;
- `agent: false`;
- `rejectUnauthorized: true`;
- `checkServerIdentity: tls.checkServerIdentity`;
- `ca: tls.rootCertificates` so process-start `NODE_EXTRA_CA_CERTS` cannot silently expand this executor's trust roots;
- minimum TLS version 1.2;
- no redirect following and no proxy integration.

The module must not read `process.env`, credential stores, endpoint configuration, files, claim/outbox state, or scheduling state.

The executor returns only one of these deeply frozen, path-free results after the response ends:

```js
{ schemaVersion: 1, status: 'accepted' }
{ schemaVersion: 1, status: 'rejected' }
```

`accepted` requires a final integer status code in `200..299`, an `end` event, and at most 4096 response bytes. A fully ended, bounded response with any other final status is `rejected`. Informational events do not settle the request. Redirects are not followed and therefore settle as `rejected` when the final response ends within bounds.

The response body is streamed and counted as bytes. It is never decoded, parsed, logged, or returned. Byte 4097 fails immediately and destroys the request/response path. A total 10-second timer begins before request creation. Timeout, TLS/DNS/socket error, premature close, aborted response, invalid status, malformed injected result, or oversized response all throw the fixed path-free `audit-delivery-unavailable` error.

Settlement is single-shot. The timer is cleared exactly once. Late error/data/end/close events cannot change a settled outcome. Raw errors, errno, certificates, hostnames, endpoint text, headers, response bytes, and request bodies never appear in errors or receipts.

### `src/audit-integrity-alert-delivery-once.js`

Exports a programmatic `deliverAuditIntegrityAlertOnce(dataDir, endpoint, now)` operation and a narrowly marked internal factory for deterministic orchestration tests.

The default operation uses the real claim coordinator and the production HTTPS executor. Its data flow is:

1. Call `claimAuditIntegrityAlertDelivery(dataDir, endpoint, now)`.
2. For `empty`, return a frozen sanitized empty receipt and perform no network operation.
3. For `busy`, return a frozen sanitized busy receipt and perform no network operation.
4. For `claimed`, derive only the exact capability `{claimId, streamId, sequence}` and execute the embedded request exactly once.
5. If the executor returns `accepted`, call `completeAuditIntegrityAlertDelivery` exactly once. Never call release on this branch, even if completion fails.
6. If the executor returns `rejected`, call `releaseAuditIntegrityAlertDelivery` exactly once, then throw the fixed unavailable error. Never call complete on this branch.
7. If execution throws or returns anything other than the two exact results, treat the outcome as uncertain: do not call complete or release; preserve the durable claim until owner/TTL recovery and throw the fixed unavailable error.

This conservative rule avoids immediate duplicate delivery after bytes may have reached the remote endpoint but no verified response was received. It intentionally delays a retry after even an early DNS/TLS/connect failure; retry/backoff classification is a later durable-policy slice.

Successful delivery returns a deeply frozen sanitized receipt containing only:

- `schemaVersion: 1`;
- `status: 'delivered'`;
- `delivered: true`;
- `streamId`;
- `sequence`;
- `pendingCount`;
- `completionStatus: 'completed' | 'already-completed'`.

The empty and busy receipts expose no request descriptor or claim ID. Busy may expose the already-public stream ID, sequence, and expiry timestamp. No receipt contains endpoint, headers, body, remote response, hostname, certificate, raw error, or filesystem path.

## Failure and Crash Semantics

The transport layer cannot prove whether a remote service committed a request when a timeout or reset occurs before a complete response. Such outcomes therefore preserve the claim. The 120-second claim TTL supplies a conservative minimum hold, not automatic retry.

A fully ended non-2xx response is an explicit application rejection and releases the claim. A later explicit caller may claim and try again.

Once a bounded 2xx response is observed, the remote may have accepted the event. Failure or process death during local completion must never release the claim. Existing completion ordering provides these recovery cases:

- failure before outbox acknowledgement leaves the claim and head for later at-least-once retry;
- failure after acknowledgement but before idle leaves a residual claim that a later exact completion resolves as `already-completed` without deleting the successor.

No branch provides exactly-once delivery. The stable idempotency key is evidence available to the receiving service, not proof that the receiver enforces deduplication.

## Endpoint Trust Boundary

This slice exposes no Agent, API, Web, environment, or persisted configuration path. The endpoint is accepted only from a trusted local programmatic caller and remains subject to the canonical HTTPS validation in the existing request builder.

Before any later external/configuration wiring, a separate design must add an explicit destination allowlist and DNS/IP policy. Without that gate, this executor must not be wired to untrusted input. Real staging delivery to an approved endpoint remains a separate acceptance step.

## TDD and Acceptance

Create behavior-specific RED tests first in:

- `test/audit-integrity-alert-https-transport.test.js`;
- `test/audit-integrity-alert-delivery-once.test.js`.

The old-HEAD RED must be caused by the missing transport/one-shot APIs, not syntax, import, fixture, certificate, or network noise. Production code is added only after that RED is captured.

Mandatory transport tests:

- exact constants and public/internal export surface;
- status boundaries `199/200/299/300`;
- response-byte boundaries `4096/4097` with streaming accumulation;
- total deadline just before/at the 10-second boundary with injected timers;
- UTF-8 request body produces exact byte `content-length`;
- exact internally constructed options, `agent:false`, TLS verification, TLS 1.2 minimum, built-in root certificates, and no arbitrary headers;
- 3xx is not followed;
- informational events do not settle;
- timeout, early close, aborted response, TLS/DNS/socket errors, malformed status, and late-event races settle once with the fixed error;
- response/endpoint/error secrets are absent from results and error text;
- preset proxy/TLS environment variables do not alter the exact constructed options because the module does not read them.

Mandatory one-shot tests:

- empty and busy perform zero network/complete/release calls and return sanitized receipts;
- two concurrent one-shot calls on one root yield at most one executor call while the other is busy;
- accepted 2xx calls complete once and never release;
- complete failure after accepted preserves the claim and returns only the fixed error;
- real post-ack completion fault remains recoverable through `already-completed`;
- rejected non-2xx releases once, never completes, and throws the fixed error;
- release failure still never completes and leaves the claim for recovery;
- uncertain executor failures never release or complete;
- malformed executor results fail closed and preserve the claim;
- all receipts are deeply frozen, exact-key, and contain no claim ID, request, endpoint, body, headers, response, errno, or path.

Run focused claim/outbox/stream/request/transport/one-shot tests, documentation honesty tests if updated, then the complete `npm test` suite. Require zero failures and only the repository's known environment-gated skips.

## Gold Boundary

Passing this design proves only a bounded one-shot HTTPS transport and its local claim integration. `production-hardening` remains partial and Linke remains not Gold.

Still required in later slices are at least:

- destination allowlist and DNS/IP policy before external wiring;
- durable retry/backoff and attempt accounting;
- dead-letter handling and operator inspection;
- managed scheduling/background lifecycle;
- observability without sensitive payloads;
- real approved staging delivery and failure drills;
- independent security and release review.

No test, local listener, fake transport, or code-only receipt from this slice may be described as real notification delivery, production monitoring ready, production-hardening ready, Gold, or GA.
