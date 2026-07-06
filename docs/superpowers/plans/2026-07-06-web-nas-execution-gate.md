# Web NAS Execution Gate Display Implementation Plan

> **For agentic workers:** implement task-by-task. Keep this plan updated with checkbox state.

**Goal:** Ship Linke V0.65 Web Console rendering for the NAS credential reference gate without enabling real NAS execution.

**Role Map:**
- PM / verifier: Codex
- implementer: AGY
- adversary: Qwen
- auxiliary final verifier: ZAI when usable

## Constraints

- Do not read or output `.env`, credentials, SSH keys, cloud auth files, tokens, or passwords.
- Do not read environment variables for NAS credentials.
- Do not make network requests to NAS endpoints.
- Do not add real NAS writes or remote transport.
- Do not render or echo raw `credentialRef` values.
- Keep `nas-dry-run` partial and `real-nas-remote-backup` blocked.

## Task 1: RED Tests

Files:
- `test/web-console.test.js`
- `test/version.test.js`
- `test/gold-readiness.test.js`
- `test/readme.test.js`

- [x] Add DOM test for `executionGate.remoteExecutionAllowed:false` and blocking reason rendering.
- [x] Add DOM test for `credentialRefConfigured` true/false rendering.
- [x] Add DOM non-leak test proving a submitted raw credential slug is not rendered.
- [x] Update version/readiness/README tests to expect V0.65.
- [x] Run targeted tests and confirm RED.

## Task 2: Web Implementation

Files:
- `src/web/app.js`
- `src/web/index.html`
- `src/web/styles.css` if needed

- [x] Render a NAS execution gate row before target results.
- [x] Render credential reference state per target from `credentialRefConfigured` only.
- [x] Keep rendering injection-safe through created nodes and `textContent`.
- [x] Update Web safety note to clarify no real NAS transport.
- [x] Run targeted Web tests and confirm GREEN.

## Task 3: Version and Docs

Files:
- `src/version.js`
- `src/gold-readiness.js`
- `README.md`

- [x] Move current version to V0.65.
- [x] Document Web NAS execution gate display.
- [x] Keep Gold readiness blocked and NAS dry-run partial.
- [x] Run targeted docs/version/readiness tests.

## Task 4: Review and Verification

- [x] Ask Qwen for read-only adversarial review of the V0.65 plan. Qwen returned PASS with no blockers.
- [x] Run Qwen final read-only review. Qwen returned PASS with no blockers after implementation.
- [x] Run `npm test`.
- [x] Run `git diff --check`.
- [x] Run HTTP/API or DOM smoke proving Web output does not render raw `credentialRef`. Covered by DOM tests in `test/web-console.test.js`.
- [x] Ask ZAI for short PASS/FAIL if the channel returns a valid answer. ZAI long-form prompts are unreliable in this environment, but the minimal one-word probe returned `PASS`; PM treats it as auxiliary only.
- [x] Commit and push with `feat: display nas execution gate in web console`.
