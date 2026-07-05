# Release Readiness Web Panel Implementation Plan

> Required flow: RED test first, AGY implementation, Qwen adversarial review, ZAI auxiliary verification, PM final verification.

## Goal

Implement Linke V0.51 release-readiness API and Web Console readiness subsection using the V0.50 readiness helper.

## Constraints

- Reuse `src/release-readiness.js`; do not duplicate readiness check logic in `server.js`.
- Do not change the V0.50 CLI behavior.
- Keep existing `/api/health` and existing release health panel behavior.
- Do not add startup requests or polling for release readiness.
- Do not touch backup, restore, NAS, delete, remote command, or metadata-write behavior.
- Do not read or write `.env`, credentials, SSH/cloud auth, or token-bearing files.
- Use TDD.

## Task 1: RED Tests

- [x] Add endpoint tests for `GET /api/release-readiness`.
- [x] Add endpoint/CLI/helper consistency tests using a temp server.
- [x] Add non-GET method tests for `/api/release-readiness`.
- [x] Add Web Console HTML/source contract tests for readiness hooks inside the release health panel.
- [x] Add pure view model tests for ready/not-ready/error/unknown states.
- [x] Add DOM tests: no init request, manual refresh once, button busy state, not-ready render, error render.
- [x] Add README/version tests for V0.51.
- [x] Run target tests and confirm RED failures.

## Task 2: GREEN Implementation

- [x] Update `src/version.js` to `V0.51`.
- [x] Update `src/server.js`:
  - import `buildReleaseReadinessReport`
  - add `GET /api/release-readiness`
  - keep non-GET methods falling through to `404`
- [x] Update `src/web/index.html`:
  - add readiness subsection inside `release-health-panel`
  - add readiness button, status, expected/actual version, failed count, check list, message, and safety note hooks
- [x] Update `src/web/app.js`:
  - add `buildReleaseReadinessViewModel`
  - wire DOM references
  - add manual fetch with in-flight guard
  - render unknown/ready/not-ready/error states
- [x] Update `src/web/styles.css` for readiness states and check list.
- [x] Update README to V0.51 current with endpoint and Web Console readiness docs.

## Task 3: Verification

- [x] `git diff --check`
- [x] Target tests for endpoint, Web Console, README, version, health, CLI.
- [x] `npm test`
- [x] Real HTTP smoke:

```bash
curl -s http://127.0.0.1:<port>/api/release-readiness
```

- [x] Qwen implementation review.
- [x] ZAI auxiliary verification with strict English PASS/FAIL schema.
- [x] Commit and push.

## Execution Record

- Qwen design review returned `DONE_WITH_CONCERNS`.
- PM accepted shared-helper, merged-panel, non-GET 404, and endpoint/helper consistency test requirements before implementation.
- AGY produced RED tests and PM confirmed target RED failures before GREEN implementation.
- Qwen implementation review returned `DONE_WITH_CONCERNS` with no blockers; PM added duplicate in-flight refresh and long-string truncation regression tests.
- Verification passed: target tests 484/484, full `npm test` 651/651, `git diff --check`, and HTTP smoke `GET /api/release-readiness` returned `ready:true` for V0.51.
- ZAI first strict verifier attempt was invalid because its file tool failed and it returned `I don't have a specific response`; PM did not accept it. ZAI no-tools auxiliary verifier then returned `Status: PASS` based on PM evidence.
