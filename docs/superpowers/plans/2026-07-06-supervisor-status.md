# Linke V0.77 Supervisor Status API/CLI Plan

**Goal:** Add a read-only supervisor status foundation for Linke V0.77 without installing, starting, probing, or managing any local daemon.

**Scope:** Add `GET /api/supervisor-status`, `agent.js supervisor-status`, focused API/CLI tests, version/docs/Gold readiness updates, and release notes. Keep Gold blocked and keep `automation-installation` / `production-hardening` partial.

**Non-goals:**
- Do not call `launchctl`.
- Do not read process lists.
- Do not install or start launchd jobs.
- Do not write metadata.
- Do not connect NAS.
- Do not trigger backup, restore, or remote commands.

## Steps

- [x] Add RED tests for `agent.js supervisor-status`, token behavior, unreachable server behavior, no dataDir leakage, and no mutation.
- [x] Add RED API tests for `GET /api/supervisor-status`, auth gate behavior, no dataDir mutation, and non-GET 404.
- [x] Implement `buildSupervisorStatusResponse()` and `GET /api/supervisor-status`.
- [x] Implement `agent.js supervisor-status`.
- [x] Update version, Gold readiness evidence, README, and docs tests to V0.77.
- [x] Run targeted supervisor/API tests.
- [x] Run docs/version/Gold regression tests.
- [x] Run full test suite.
- [x] Run overclaim and whitespace checks.
- [x] Run qwen adversarial review.
- [x] Run ZAI closure verification.
- [x] Commit and push.

## Evidence

- RED: `node --test test/agent-supervisor-status.test.js test/health.test.js` initially failed because `supervisor-status` was an unknown Agent command and `GET /api/supervisor-status` returned 404.
- GREEN implementation added `buildSupervisorStatusResponse()`, `GET /api/supervisor-status`, and `agent.js supervisor-status`.
- Targeted GREEN before docs sync: `node --test test/agent-supervisor-status.test.js test/health.test.js` passed 33/33.
- Reviewer adjustment: ZAI first returned `FAIL` with one useful edge-case concern; V0.77 absorbed it by adding Agent supervisor-status response schema validation and an invalid-response test. Supervisor presence detection remains explicitly out of scope for this slice.
- Targeted GREEN after schema validation: `node --test test/agent-supervisor-status.test.js` passed 6/6 and `node --test test/agent-supervisor-status.test.js test/health.test.js` passed 34/34.
- Docs/version/Gold GREEN: `node --test test/agent-supervisor-status.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js` passed 328/328.
- Agent/server regression GREEN: `node --test test/agent-supervisor-status.test.js test/agent-auth-status.test.js test/agent-hardening-status.test.js test/health.test.js test/gold-readiness.test.js test/readme.test.js test/version.test.js` passed 365/365 before the schema guard; the focused guard suite and docs suite were re-run after the guard.
- Full suite GREEN: `node --test --test-reporter=dot test/*.test.js` exited 0 after the schema guard.
- Hygiene: `git diff --check` exited 0. README/src overclaim scan for production-ready, Gold-ready, real NAS implemented, daemon installed, launchd installed, and always-running claims returned no matches.
- qwen review: `PASS_WITH_CONCERNS` because the status is fixed rather than real detection; this matches the V0.77 read-only foundation boundary and remains a next-version concern.
- ZAI closure: second run returned `PASS` after response validation was added and real supervisor detection was restated as out of scope.

## Safety Boundary

V0.77 reports `supervisor.state:not_configured` and `supervisorInstalled:false` only. It does not call `launchctl`, read process lists, install supervisor files, start daemons, write metadata, connect NAS, trigger backup/restore, or execute local/remote commands.
