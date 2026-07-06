# Agent Gold Readiness CLI Implementation Plan

**Goal:** Build Linke V0.75 Agent CLI `gold-readiness` command for read-only Gold blocker visibility and automation gating.

**Scope:** Reuse existing GET `/api/gold-readiness`; add only Agent CLI command handling, focused CLI tests, version/docs/Gold evidence updates, and release notes. Do not change server Gold scorecard semantics, NAS behavior, backup/restore behavior, auth rules, metadata writes, or Gold blocked status.

## Constraints

- Read-only: no metadata writes, no NAS connection, no backup/restore, no remote command.
- The CLI must use the existing API request helper so `--token` behavior remains consistent with other Agent commands.
- `--fail-on-blocked` is a boolean flag and must reject values.
- `--fail-on-blocked` exits 2 only when GET `/api/gold-readiness` returns `status:"blocked"`; it still prints the JSON report first.
- Gold remains blocked; this is an automation gate, not a Gold release approval.

## Steps

- [x] Add RED tests for `agent.js gold-readiness`, read token support, `--fail-on-blocked`, flag validation, unreachable server handling, and no dataDir/token leakage.
- [x] Implement the Agent CLI command, help text, and invalid-status guard in `src/agent.js`.
- [x] Update V0.75 version, README, and Gold readiness evidence.
- [x] Verify focused Agent CLI, version, README, and Gold readiness tests.

## Execution Evidence

- RED: `node --test test/agent-gold-readiness.test.js` initially failed because `gold-readiness` was an unknown command.
- GREEN: `node --test test/agent-gold-readiness.test.js` passed 6/6.
- Docs/version/Gold: `node --test test/agent-gold-readiness.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js` passed 325/325.
- Agent/server regression: `node --test test/agent-gold-readiness.test.js test/agent-release-readiness.test.js test/health.test.js test/security.test.js` passed 69/69.
- Full suite: `node --test --test-reporter=dot test/*.test.js` exited 0.
- Qwen adversarial review: returned `PASS`; one concern about unknown Gold status silently exiting 0 was fixed with an invalid-status guard and regression test.
- ZAI closure: smoke prompt returned `OK`, but multiple no-tools verifier prompts returned `I understand, but I don't have a specific response`; this is invalid and was not counted as acceptance evidence.
