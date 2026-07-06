# NAS Credential Denylist Hardening Implementation Plan

> **For agentic workers:** implement task-by-task and keep checkboxes current.

**Goal:** Ship Linke V0.66 expanded NAS credential-like field rejection while keeping real NAS execution blocked.

**Role Map:**
- PM / verifier: Codex
- implementer: AGY
- adversary: Qwen
- auxiliary final verifier: ZAI when usable

**Implementation note:** AGY implementer command exited with code 0 after several minutes but returned no output and made no file changes. PM fallback is used for implementation while preserving the same scope and verification gates.

## Constraints

- Do not read or output `.env`, credentials, SSH keys, cloud auth files, tokens, or passwords.
- Do not read environment variables for NAS credentials.
- Do not make network requests to NAS endpoints.
- Do not add real NAS writes or remote transport.
- Do not echo forbidden field values in API, CLI, Web, README examples, or readiness output.
- Keep `nas-dry-run` partial and `real-nas-remote-backup` blocked.

## Task 1: RED Tests

Files:
- `test/config.test.js`
- `test/nas-dry-run.test.js`
- `test/web-console.test.js`
- `test/readme.test.js`
- `test/version.test.js`
- `test/gold-readiness.test.js`

- [x] Add tests proving the 8 new forbidden fields are rejected in `validateConfig()`.
- [x] Add tests proving the 8 new forbidden fields are rejected by `validateNasTarget()`.
- [x] Add tests proving the 8 new forbidden fields are rejected inside `appAdapter`.
- [x] Add a `credentialRef` plus new forbidden field rejection test.
- [x] Add API/Web test proving a forbidden field value is not echoed in error output.
- [x] Update version/readiness/README tests to expect V0.66 and full denylist docs.
- [x] Run targeted tests and confirm RED.

## Task 2: Implementation

Files:
- `src/config.js`
- `src/version.js`
- `src/gold-readiness.js`
- `src/web/index.html`
- `README.md`

- [x] Extend `FORBIDDEN_NAS_CREDENTIAL_FIELDS` with the 8 new exact keys.
- [x] Add concise comments explaining `connectionString` and `secretKey`.
- [x] Move current version to V0.66.
- [x] Update Gold readiness evidence without changing blocked/partial states.
- [x] Update README and Web safety text without production-ready claims.
- [x] Run targeted tests and confirm GREEN.

## Task 3: Review and Verification

- [x] Ask Qwen for read-only adversarial review of the V0.66 plan. Qwen returned PASS with implementation constraints.
- [x] Run Qwen final read-only review after implementation. First attempt exceeded review wait budget with no output; second shorter read-only prompt returned PASS with no blockers. PM addressed the non-blocking exact-key false-positive risk by adding near-key acceptance tests.
- [x] Run `npm test`. Full suite after exact-key false-positive tests: 914 pass, 0 fail.
- [x] Run `git diff --check`.
- [x] Ask ZAI for short PASS/FAIL if the channel returns a valid answer. ZAI minimal prompt returned PASS.
- [x] Commit and push with `feat: harden nas credential denylist`.
