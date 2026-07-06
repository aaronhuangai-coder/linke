# NAS Execution Readiness Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Linke V0.67 with dry-run-only NAS execution readiness summary and per-target blockers.

**Architecture:** Extend `src/nas.js` plan construction with a pure helper that derives execution readiness from validated target metadata and the existing fixed `executionGate`. Render the new fields in `src/web/app.js` with DOM nodes and `textContent`, then sync version, README, Web safety, and Gold readiness evidence.

**Tech Stack:** Node.js ESM, `node:test`, vanilla DOM rendering, existing Linke Web Console.

## Global Constraints

- Do not read or output `.env`, credentials, SSH keys, cloud auth files, tokens, or passwords.
- Do not read environment variables for NAS credentials.
- Do not make network requests to NAS endpoints.
- Do not add real NAS writes, NAS app invocation, remote backup execution, or remote transport.
- Do not echo raw `credentialRef` values in API, CLI, Web, README examples, or readiness output.
- Keep `nas-dry-run` partial and `real-nas-remote-backup` blocked.
- `executionReadiness` means future execution readiness under dry-run safety gates; it is not Gold readiness.
- In V0.67, `ready` is unreachable because `executionGate.remoteExecutionAllowed` is fixed to false; future `ready` only means dry-run configuration completeness, not production readiness.
- `credentialRefConfigured` only means a non-secret reference name is present. It must not trigger credential reading or secret resolution.
- Blocker codes must come from fixed allowlisted constants, not from user-controlled strings.

---

## File Structure

- Modify `src/nas.js`: add pure readiness derivation and include `readinessSummary` plus per-target `executionReadiness` in dry-run plans.
- Modify `src/web/app.js`: render summary and per-target readiness codes safely.
- Modify `src/version.js`: bump `LINKE_RELEASE_VERSION` to `V0.67`.
- Modify `src/gold-readiness.js`: add V0.67 evidence while keeping statuses unchanged.
- Modify `src/web/index.html`: update Gold safety note to V0.67.
- Modify `README.md`: update current version, version table, NAS docs, Gold docs, and testing coverage.
- Modify tests: `test/nas-dry-run.test.js`, `test/web-console.test.js`, `test/version.test.js`, `test/gold-readiness.test.js`, `test/readme.test.js`.

## Task 1: RED Tests

**Files:**
- Modify: `test/nas-dry-run.test.js`
- Modify: `test/web-console.test.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes existing `buildNasDryRunPlan(config)` and `POST /api/nas-dry-run`.
- Produces failing expectations for `readinessSummary` and `executionReadiness`.

- [x] Add a pure NAS plan test expecting top-level `readinessSummary` counts:
  - `mode: "dry-run"`
  - `state: "blocked"`
  - `totalTargets: 3`
  - `enabledTargets: 2`
  - `disabledTargets: 1`
  - `credentialRefConfiguredTargets: 1`
  - `enabledCredentialRefMissingTargets: 1`
  - `blockedTargets: 3`
  - `remoteExecutionBlocked: true`
  - `blockers` includes `remote-execution-blocked`, `credential-ref-missing`, and `target-disabled`.
- [x] Add pure target tests for:
  - enabled + missing credentialRef -> blockers include `credential-ref-missing` and `remote-execution-blocked`.
  - enabled + credentialRef -> blockers include only `remote-execution-blocked`.
  - disabled -> blockers include `target-disabled` and `remote-execution-blocked`.
- [x] Add API test proving readiness fields are returned while `wouldConnect:false`, `wouldWrite:false`, and `executionGate.remoteExecutionAllowed:false` remain fixed.
- [x] Add DOM test proving readiness summary and target blocker codes render without leaking raw `credentialRef`.
- [x] Update V0.67 version, README, and Gold readiness tests.
- [x] Run targeted tests and confirm RED. AGY reported RED during implementation; PM did not preserve independent RED output, then verified GREEN with targeted tests.

Run:

```bash
node --test test/nas-dry-run.test.js test/web-console.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected before implementation: FAIL because `readinessSummary`, `executionReadiness`, and V0.67 docs/version do not exist yet.

## Task 2: Implementation

**Files:**
- Modify: `src/nas.js`
- Modify: `src/web/app.js`
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `src/web/index.html`
- Modify: `README.md`

**Interfaces:**
- Produces `buildNasDryRunPlan(config).readinessSummary`.
- Produces `buildNasDryRunPlan(config).targets[].executionReadiness`.

- [x] Add a helper in `src/nas.js` that builds target readiness from `enabled`, `credentialRefConfigured`, and `NAS_EXECUTION_GATE.remoteExecutionAllowed`.
- [x] Add a helper in `src/nas.js` that builds summary counts from target readiness rows.
- [x] Attach `executionReadiness` to each target in `buildNasDryRunPlan()`.
- [x] Attach `readinessSummary` to the top-level plan.
- [x] Keep all blocker codes as fixed constants; do not derive blocker codes from target names, endpoints, paths, or other user input.
- [x] Render `readinessSummary` in `src/web/app.js` before target list using `textContent`.
- [x] Render per-target `executionReadiness.state` and blocker codes using `textContent`.
- [x] Bump version/docs/readiness text to V0.67 without changing Gold blocked/partial statuses.
- [x] Run targeted tests and confirm GREEN. PM verified `node --test test/nas-dry-run.test.js test/web-console.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js`: 682 pass, 0 fail.

Run:

```bash
node --test test/nas-dry-run.test.js test/web-console.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected after implementation: PASS.

## Task 3: Review and Verification

- [x] Ask Qwen for read-only final review of V0.67. First final prompt exceeded wait budget with no output; shorter fixed-schema prompt returned PASS with no blockers.
- [x] Run `npm test`. Full suite: 920 pass, 0 fail.
- [x] Run `git diff --check`.
- [x] Ask ZAI for short PASS/FAIL if the channel returns a valid answer. ZAI minimal prompt returned PASS.
- [x] Commit and push with `feat: add nas execution readiness summary`.

## Self-Review

- Spec coverage: all readiness rules map to Task 1 tests and Task 2 implementation.
- Placeholder scan: no TODO/TBD placeholders.
- Boundary check: no task enables NAS network, credential resolution, app invocation, remote write, or Gold promotion.
