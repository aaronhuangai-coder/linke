# Linke V2 Gold M1 Exit Audit

## 1. Header metadata

| Field | Value |
| --- | --- |
| **Document type** | M1 Exit audit record (static honesty lock) |
| **Audit date** | **2026-07-18** Asia/Shanghai |
| **Audit base HEAD** | `47dcc2d` (`47dcc2d30d030e5980629900540ba79e4a29a48a`) |
| **Branch** | `linke-v0.12-web-panel` (synced with upstream `origin/linke-v0.12-web-panel` before this audit) |
| **Worktree exception** | Only untracked `package-lock.json` exists; **out of scope** for this audit (not staged, not reviewed as M1 deliverable) |
| **Author / role** | Grok (implementation owner) — writes audit document + static lock test only |
| **GLM adversarial input** | Prior GLM draft (adversarial / provisional). **Inaccurate parts overridden** by Codex PM corrections below. |
| **Codex PM correction** | Mandatory corrected facts (this document). PM corrections **override** the prior GLM draft wherever they conflict. |

### 1.1 Authority references

| Ref | Path / section |
| --- | --- |
| Plan M1 T1.0–T1.20 + Exit | `docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md` |
| Design Noise library gate | `docs/superpowers/specs/2026-07-16-linke-v2-gold-cross-lan-release-design.md` **§6.7.7** |
| T1.0 ADR | `docs/superpowers/specs/2026-07-16-linke-v2-m1-noise-library-selection-adr.md` **§6 / §6.5 / §8 / §10** |

### 1.2 Mandatory corrected PM facts (override GLM draft)

1. Audit base HEAD is **`47dcc2d`**; branch/upstream synced before this audit; only untracked **`package-lock.json`** exists and is **out of scope**.
2. Current date is **2026-07-18 Asia/Shanghai**. T1.0 route-decision deadline is **2026-07-23 23:59 Asia/Shanghai** and is still **OPEN / NOT EXPIRED**. User has not made a written route 1/2/3 selection.
3. Baseline full suite at `47dcc2d`: **2226 tests**, **291 suites**, **2225 pass**, **0 fail**, **1 skip**.
4. The actual skip is `test/keychain-real.integration.test.js`, whose real Keychain integration case uses `{ skip: !enabled }` (`LINKE_REAL_KEYCHAIN_TEST === 'enabled'`). It is **unrelated to T1.12**.
5. T1.12 fixed-vector execution test is **ABSENT / NOT IMPLEMENTED / NOT RUN** because T1.0 is BLOCKED. It is **not** the suite skip. Therefore **“0 fail” does not satisfy the fixed-vector Exit requirement** and must not be written as all-green.
6. `src/version.js` is **V1.33**. Current Gold report has **9 items**: **4 ready / 4 partial / 1 blocked**, overall **blocked**. `cross-lan-connectivity` is **absent**.
7. New M1 contract modules are **non-crypto scaffolds**, no production Noise dependency, real cross-LAN network, or Keychain write; runtime remains **not-ready**.

---

## 2. Exact exit marker block

```text
M1_EXIT_AUDIT_EXECUTED: TRUE
M1_EXIT_STATUS: BLOCKED_RECORDED
M1_MILESTONE_PASS: FALSE
M1_NON_CRYPTO_SCAFFOLD_COVERAGE: COMPLETE
M1_CRYPTO_READY: FALSE
T1_12_FIXED_VECTOR_EXECUTION: ABSENT_NOT_RUN_NOT_SKIPPED
T1_0_ROUTE_DECISION: OPEN_PENDING_USER_SELECTION
T1_0_ROUTE_DEADLINE: 2026-07-23T23:59:00+08:00
M2_PRODUCTION_HANDSHAKE_ENTRY: DENIED
SCORECARD_MUTATION: NONE
VERSION_MUTATION: NONE
```

---

## 3. T1.0–T1.20 task / commit matrix

| Task | Commit(s) | Status (audit) | Notes |
| --- | --- | --- | --- |
| **T1.0** | `d00554e` | **BLOCKED** | Written ADR BLOCKED branch recorded; library gate not passed; no candidate selected |
| **T1.1** | `aedf33b`, `3589f46` | DONE (non-crypto) | Error-code plan + registration |
| **T1.2** | `409ebfb`, `5a08cea` | DONE (non-crypto) | Control-plane message schema plan + freeze |
| **T1.3** | `b043d41` | DONE (non-crypto) | Session state machine scaffold |
| **T1.4** | `7cac666` | DONE (non-crypto) | Replay sequence guard contract |
| **T1.5** | `6a5b38e` | DONE (non-crypto) | Protocol downgrade profile reject |
| **T1.6** | `b6b4b24` | DONE (non-crypto) | DeviceId consistency |
| **T1.7** | `0d1ace4` | DONE (non-crypto) | Clock skew policy |
| **T1.8** | `710a159` | DONE (non-crypto) | Lifecycle isolation boundary |
| **T1.9** | `f732c1a` | DONE (non-crypto) | Transport capacity / keepalive policy |
| **T1.10** | `fdbd573` | DONE (non-crypto) | Noise domain / suite name constants only |
| **T1.11** | `0ac3f5e` | DONE (non-crypto) | Relay ≠ E2EE boundary docs/clarify |
| **T1.12** | only T1.12a `d958c35` | **NOT COMPLETE** | T1.12a = non-crypto token-sequence scaffold only; **full fixed-vector execution ABSENT_NOT_RUN_NOT_SKIPPED** |
| **T1.13** | `4bf777a`, `ff2615d`, `a06cf17` | DONE (non-crypto) | Enrollment code / secret lifecycle / delivery contracts |
| **T1.14** | `f42523b` | DONE (non-crypto) | Counter reservation + trustEpoch contract |
| **T1.15** | `e24c863` | DONE (non-crypto) | Evidence schema contract |
| **T1.16** | `1aab3e9` | DONE (non-crypto) | Relay pin-set contract |
| **T1.17** | `6972056` | DONE (non-crypto) | Proxy scope contract |
| **T1.18** | `872d7f3` | DONE (non-crypto) | Controller Noise lifecycle contract (schema only) |
| **T1.19** | `a632259` | DONE (non-crypto) | denylistVersion exhaustion contract |
| **T1.20** | `47dcc2d` | DONE (non-crypto) | Traffic-shape honesty contract (audit base HEAD) |

**T1.12 honesty pin:** T1.12a freezes msg1 `e,es,s,ss` / msg2 `e,ee,se` as a pure non-crypto scaffold. T1.12 fixed-vector execution test is ABSENT / NOT IMPLEMENTED / NOT RUN because T1.0 remains BLOCKED. It is not the suite skip. **Do not call this skipped or passing.** Marker: `T1_12_FIXED_VECTOR_EXECUTION: ABSENT_NOT_RUN_NOT_SKIPPED`.

---

## 4. Baseline test table (suite vs T1.12)

### 4.1 Full suite at base HEAD `47dcc2d`

| Metric | Value |
| --- | --- |
| Tests | **2226** |
| Suites | **291** |
| Pass | **2225** |
| Fail | **0 fail** |
| Skip | **1 skip** |

### 4.2 Actual suite skip (identity / reason)

| Item | Fact |
| --- | --- |
| File | `test/keychain-real.integration.test.js` |
| Case | `real keychain create/update/get/delete/missing with fixed boolean diagnostics` |
| Gate | `const enabled = process.env.LINKE_REAL_KEYCHAIN_TEST === 'enabled'` |
| Skip form | `{ skip: !enabled }` |
| Relation to T1.12 | **unrelated to T1.12** — real Keychain integration opt-in only |

### 4.3 T1.12 fixed-vector execution (separate from suite skip)

| Item | Fact |
| --- | --- |
| Status | **ABSENT / NOT IMPLEMENTED / NOT RUN** |
| Marker | `ABSENT_NOT_RUN_NOT_SKIPPED` |
| Cause | T1.0 Noise library gate **BLOCKED**; no production Noise path / fixed-vector harness |
| Is the suite skip? | **No** |
| Does “0 fail” satisfy fixed-vector Exit? | **No** — **does not satisfy the fixed-vector Exit requirement**; must not be written as all-green for M1 Exit crypto vectors |

---

## 5. Scorecard / version snapshot (audit mutates neither)

| Item | Snapshot at audit |
| --- | --- |
| `LINKE_RELEASE_VERSION` / `src/version.js` | **V1.33** |
| Gold overall status | **blocked** |
| Summary | `{ ready: 4, partial: 4, blocked: 1, total: 9 }` → **4 ready / 4 partial / 1 blocked**, **total: 9** |
| `cross-lan-connectivity` item | **absent** (not in scorecard) |
| `SCORECARD_MUTATION` | **NONE** — **neither is changed by the audit** |
| `VERSION_MUTATION` | **NONE** — **neither is changed by the audit** |

This audit **does not authorize scorecard/version mutation**. Runtime remains not-ready for cross-LAN Gold elevation.

---

## 6. Exit truth table

| Exit criterion (plan M1 Exit) | Result | Detail |
| --- | --- | --- |
| Written T1.0 BLOCKED branch: satisfied | **satisfied** | ADR `d00554e` + this audit record `BLOCKED_RECORDED` |
| Related unit tests including fixed vectors: unsatisfied | **unsatisfied** | Non-crypto scaffold unit tests present; **fixed-vector execution test/path is absent** — do not call it skipped or passing |
| No real network/Keychain writes within new M1 work: satisfied | **satisfied** | New M1 modules are pure contracts/scaffolds; no production Noise dep; no real cross-LAN network; no Keychain write in M1 deliverables |
| Scorecard remains blocked and no partial cross-LAN ready claim: satisfied | **satisfied** | Overall blocked; 9 items; `cross-lan-connectivity` absent; no partial-ready claim |
| Terms/numerics spec alignment: satisfied | **satisfied** | Based on per-task closure reviews; **does not elevate runtime** |
| **Overall M1 Exit status** | **`BLOCKED_RECORDED`** | **never PASS/COMPLETE** |

Plain lock lines (static test anchors):

- Written T1.0 BLOCKED branch: satisfied
- Related unit tests including fixed vectors: unsatisfied
- No real network/Keychain writes within new M1 work: satisfied
- Scorecard remains blocked and no partial cross-LAN ready claim: satisfied
- Terms/numerics spec alignment: satisfied

---

## 7. Forbidden claims / negative declarations

This audit **must not claim** any of the following (forbidden claims / negative declarations):

| Forbidden claim | Declaration |
| --- | --- |
| **M1 PASS** | Forbidden — `M1_MILESTONE_PASS: FALSE` |
| **M1 COMPLETE** | Forbidden |
| **M1 DONE** | Forbidden (milestone not complete) |
| **crypto ready** | Forbidden — `M1_CRYPTO_READY: FALSE` |
| **fixed vectors pass** | Forbidden |
| **fixed vectors verified** | Forbidden |
| **fixed vectors skipped** | Forbidden — execution is **ABSENT_NOT_RUN_NOT_SKIPPED**, not skipped |
| **cross-LAN ready** | Forbidden |
| **cross-LAN partial-ready** | Forbidden |
| **M2 handshake ready** | Forbidden — `M2_PRODUCTION_HANDSHAKE_ENTRY: DENIED` |
| **candidate selected** | Forbidden — no library candidate selected under T1.0 |
| **route selected** | Forbidden — user written route 1/2/3 selection pending |

Non-crypto scaffold coverage may be recorded as **COMPLETE** without elevating crypto, runtime, scorecard, or milestone PASS.

---

## 8. Route window (still OPEN)

| Item | Value |
| --- | --- |
| day 0 | 2026-07-16 Asia/Shanghai (T1.0 formal BLOCKED) |
| Deadline | **2026-07-23 23:59 Asia/Shanghai** (`T1_0_ROUTE_DEADLINE: 2026-07-23T23:59:00+08:00`) |
| Audit-time status | **OPEN / NOT EXPIRED** (audit date 2026-07-18 Asia/Shanghai is before deadline) |
| User selection | **user has not made a written route 1/2/3 selection** |
| Marker | `T1_0_ROUTE_DECISION: OPEN_PENDING_USER_SELECTION` |
| Generic Gold intent | generic "continue to full Gold" is not a written route selection |

Routes (ADR §8; decision pending — template not filled):

1. Alternate compliant library
2. Revise protocol/spec under change control, then reopen M1
3. Pause V2.0 cross-LAN/Gold until conditions met

Overdue without written choice → remains BLOCKED (no auto-pause, no default route). This audit **does not authorize route 1/2/3**.

---

## 9. Allowed / forbidden next work while route decision pending

### 9.1 Allowed next work

While T1.0 remains BLOCKED and route selection is pending, ADR authorizes **M1 non-crypto pure contracts only**:

- **error codes**, **message schemas**, **state-machine constants**, and **equivalent pure scaffold** contracts/tests
- Additional pure schema / honesty / capacity / denylist / evidence contracts that **do not** load Noise, generate keys, write Keychain, or open real cross-LAN
- All such work **must** continue to label `T1.0 BLOCKED` (not M1 crypto PASS)
- All such work **must** label M2 milestone / handshake / crypto as **BLOCKED**

This **does not authorize M2 entry**. While T1.0 is BLOCKED / route pending, the following remain **denied** and must not enter:

- mock-relay dry-run
- relay framing implementation tracks
- topology implementation tracks
- production handshake, crypto, or real network paths

Allowed next work keywords locked for static test: M1 non-crypto pure contracts only; error codes; message schemas; state-machine constants; equivalent pure scaffold; M2 entry denied; mock-relay dry-run denied; relay framing implementation denied; topology implementation denied; T1.0 BLOCKED.

### 9.2 Forbidden next work

| Forbidden | Reason |
| --- | --- |
| Noise dependency / binding introduction | T1.0 gate not passed |
| crypto/key generation | `M1_CRYPTO_READY: FALSE` |
| Keychain write (production or unauthorized test) | M1 Exit honesty; real Keychain remains opt-in only |
| real cross-LAN network acceptance | M5 / later; not M1 Exit |
| production handshake | `M2_PRODUCTION_HANDSHAKE_ENTRY: DENIED` |
| scorecard/version elevation | `SCORECARD_MUTATION: NONE` / `VERSION_MUTATION: NONE` |
| Silent fixed-fixture shortcut / suite downgrade / self-implemented KE | design §6.7.7 + ADR §8.4 |

Forbidden next work keywords locked for static test: Noise dependency; crypto/key generation; Keychain write; real cross-LAN; production handshake; scorecard/version elevation.

This audit **does not authorize dependency introduction**.
This audit **does not authorize M2 production handshake**.
This audit **does not authorize scorecard/version mutation**.

---

## 10. Runtime honesty (non-elevation)

- New M1 modules: non-crypto scaffolds / pure contracts only.
- No production Noise dependency in tree for Gold path.
- No real cross-LAN network exercised by M1 deliverables.
- No Keychain write in new M1 work (suite skip remains gated real Keychain test).
- Runtime remains **not-ready** for cross-LAN connectivity Gold item (item still **absent**).

---

## 11. Sign-off

This sign-off **signs the audit record**, **not milestone PASS**.

| Role | Action |
| --- | --- |
| Implementation owner (Grok) | Records M1 Exit audit at base `47dcc2d` with status **`BLOCKED_RECORDED`** |
| Milestone claim | **Denied** — `M1_MILESTONE_PASS: FALSE` |
| Static lock test | `test/cross-lan-m1-exit-audit.test.js` locks markers, matrix, suite-skip identity, T1.12 absence, scorecard/version snapshot, and next-work matrix |

```text
SIGNED: M1_EXIT_AUDIT_RECORD_ONLY
MILESTONE_PASS_SIGNED: FALSE
AUDIT_HEAD: 47dcc2d
AUDIT_DATE: 2026-07-18 Asia/Shanghai
```
