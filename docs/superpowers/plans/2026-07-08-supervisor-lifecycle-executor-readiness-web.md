# Linke V1.00 Supervisor Lifecycle Executor Readiness Web Console

## Goal

Expose the V0.99 read-only executor readiness API in Web Console as a manual, fail-closed preflight view without adding any real lifecycle apply, launchctl, NAS, backup, restore, remote command, or production-ready claim.

## Role Map

- PM: Codex
- Implementer: AGY/ayg
- Adversary: Qwen
- Closure verifier: DeepSeek

## Scope

- Add `supervisor-lifecycle-executor-readiness-button` beside the existing apply readiness control.
- Add a safety note documenting manual-only read-only boundaries.
- Add `buildSupervisorLifecycleExecutorReadinessViewModel`.
- Add a click handler that posts only `operation` and `config` to `/api/supervisor-lifecycle-executor-readiness`.
- Keep approval textarea ignored.
- Keep UI fail-closed with `executorReady:false`.
- Keep Gold blocked.

## TDD Evidence

- RED: `node --test --test-reporter=spec test/web-console.test.js`
  - Failed because `buildSupervisorLifecycleExecutorReadinessViewModel` was not exported.
- GREEN: `node --test --test-reporter=spec test/web-console.test.js`
  - 381 tests passed, 0 failed.
- Version/docs GREEN: `node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js`
  - 341 tests passed, 0 failed.

## Worker Notes

- AGY write-channel smoke returned `OK.`
- First implementation attempt exited with no output and no target diff.
- Second narrowed implementation attempt produced `src/web/app.js` and `src/web/index.html` changes.
- PM independently tightened the view model to avoid any ready branch and to display only executor-specific gate lines.

## Remaining Gold Blockers

- Real installer
- launchd install/start
- watchdog and monitoring
- real guarded lifecycle apply execution wiring
- rollback, uninstall, and recovery supervisor execution
- real NAS remote backup
- production auth, secret management, and production audit
