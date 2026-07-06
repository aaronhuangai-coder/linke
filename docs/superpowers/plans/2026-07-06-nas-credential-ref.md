# NAS Credential Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.64 NAS credential reference foundation and execution gate without enabling real NAS execution.

**Architecture:** Export a shared credential-ref validator from `src/config.js`, reuse it from `src/nas.js`, sanitize dry-run output, and keep Gold blocked.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing HTTP server.

## Global Constraints

- Do not read or output `.env`, credentials, SSH keys, cloud auth files, tokens, or passwords.
- Do not read environment variables for NAS credentials.
- Do not make any network request to NAS endpoints.
- Do not add a real remote write path.
- Do not echo `credentialRef` raw values in API, CLI, Web, README examples that imply output, or Gold readiness output.
- Keep `real-nas-remote-backup` blocked and `nas-dry-run` partial.
- Use TDD: add failing tests before production code.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/nas-dry-run.test.js`
- Modify: `test/config.test.js`

- [x] Add valid `credentialRef` tests for `home-synology` and `nas-01`.
- [x] Add invalid `credentialRef` tests for empty, whitespace, uppercase, special/path-like characters, too-long values, and numeric-leading values.
- [x] Add a test proving `credentialRef` plus a forbidden credential field still rejects.
- [x] Add dry-run tests proving output includes `credentialRefConfigured` only and never the raw `credentialRef` value.
- [x] Add dry-run tests proving top-level `executionGate.remoteExecutionAllowed === false` and input cannot override it.
- [x] Run `node --test test/config.test.js test/nas-dry-run.test.js` and verify RED.

### Task 2: Implementation

**Files:**
- Modify: `src/config.js`
- Modify: `src/nas.js`

- [x] Export `ALLOWED_NAS_CREDENTIAL_REF_PATTERN`.
- [x] Export `validateNasCredentialRef(value)`.
- [x] Use the helper in `validateConfig()`.
- [x] Use the helper in `validateNasTarget()`.
- [x] Add `credentialRefConfigured` to dry-run target output without echoing the raw ref.
- [x] Add top-level immutable `executionGate` output to `buildNasDryRunPlan()`.
- [x] Run `node --test test/config.test.js test/nas-dry-run.test.js` and verify GREEN.

### Task 3: Version and Docs

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `src/web/index.html` only if current safety text needs version alignment
- Modify: docs/version/readiness tests as needed

- [x] Move current version to V0.64.
- [x] Document `credentialRef` as a non-secret reference only.
- [x] Document `executionGate` as blocked real NAS execution evidence, not a production claim.
- [x] Keep `real-nas-remote-backup` blocked and `nas-dry-run` partial.
- [x] Run targeted docs/version/readiness tests.

### Task 4: Review and Verification

- [x] Ask Qwen for read-only review focused on secret leakage, raw ref echoing, executionGate override, docs overclaims, and Gold state.
- [x] Address blockers. Qwen reported no blockers; non-blocking suggestions are deferred.
- [x] Run `npm test`.
- [x] Run `git diff --check`.
- [x] Run HTTP/API smoke proving `/api/nas-dry-run` does not echo `credentialRef` and returns `credentialRefConfigured:true`.
- [x] Ask ZAI for short English verifier PASS/FAIL. Long-form ZAI verifier prompts returned the invalid generic response `I understand, but I don't have a specific response.`; a one-word fallback returned `PASS`, so PM treats ZAI as auxiliary only and relies on Qwen plus local verification evidence for closure.
- [x] Commit and push with `feat: add nas credential reference gate`.
