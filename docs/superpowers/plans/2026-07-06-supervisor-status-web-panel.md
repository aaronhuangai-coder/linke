# Linke V0.78 Supervisor Status Web Panel Plan

**Goal:** Add a manual read-only Web Console supervisor status panel for Linke V0.78 using the existing `GET /api/supervisor-status` endpoint.

**Scope:** Add `supervisor-status-panel`, `buildSupervisorStatusViewModel()`, manual refresh wiring, in-flight request guard, CSS status styling, version/docs/Gold readiness updates, and focused Web Console tests. Keep Gold blocked and keep `automation-installation` / `production-hardening` partial.

**Non-goals:**
- Do not request `/api/supervisor-status` on Web Console startup.
- Do not poll automatically.
- Do not call `launchctl`.
- Do not read process lists.
- Do not install or start launchd jobs or managed supervisor daemons.
- Do not write metadata.
- Do not connect NAS.
- Do not trigger backup, restore, or remote commands.
- Do not display token, Authorization header, path, env, or credential material.

## Steps

- [x] Add RED Web Console contract, pure view model, and DOM interaction tests for supervisor-status.
- [x] Confirm RED failures for missing HTML hooks, missing view model export, missing endpoint wiring, missing CSS selectors, and missing click handling.
- [x] Add `supervisor-status-panel` to `src/web/index.html`.
- [x] Add `buildSupervisorStatusViewModel()` with whitelisted fields and error redaction.
- [x] Add manual fetch wiring, busy state, and in-flight guard in `src/web/app.js`.
- [x] Add `supervisor-status-panel` CSS status styling.
- [x] Update version, README, Gold readiness evidence, and docs tests to V0.78.
- [x] Run targeted supervisor Web tests.
- [x] Run docs/version/Gold regression tests.
- [x] Run full test suite.
- [x] Run overclaim and whitespace checks.
- [x] Run qwen adversarial review.
- [x] Run ZAI closure verification.
- [ ] Commit and push.

## Evidence

- RED: `node --test --test-name-pattern "supervisor-status|Supervisor status" test/web-console.test.js` failed 10/11 because the Web panel, view model, endpoint wiring, CSS selectors, and click listener were missing.
- Targeted GREEN: `node --test --test-name-pattern "supervisor-status|Supervisor status" test/web-console.test.js` passed 11/11.
- Docs/version/Gold/Web regression GREEN: `node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/web-console.test.js` passed 648/648.
- Full suite GREEN: `node --test --test-reporter=dot test/*.test.js` exited 0.
- Hygiene: `git diff --check` exited 0.
- Overclaim scan: README/src positive scan for `production ready`, `Gold ready`, real NAS ready, daemon installed, launchd installed, and always-running claims returned no matches.
- qwen review: `PASS_WITH_CONCERNS`; no blockers. One low-risk concern about accepting `status:"ready"` as forward compatibility is covered by current docs and safety text that state the current supervisor response remains fixed `not_configured` / partial.
- ZAI closure: first run was invalid because ZAI's file-view tool failed with `fs.stat is not a function`; second evidence-only run returned `PASS`.

## Safety Boundary

V0.78 only exposes manual Web visibility for the existing sanitized `not_configured` supervisor status. It does not start, install, probe, monitor, or recover a supervisor. It does not call `launchctl`, read process lists, write metadata, connect NAS, trigger backup/restore, or execute remote commands.
