# Agent Auth Status CLI Implementation Plan

**Goal:** Build Linke V0.76 Agent CLI `auth-status` command for read-only visibility into sanitized auth scope status.

**Scope:** Reuse existing GET `/api/auth-status`; add only Agent CLI command handling, focused CLI tests, version/docs/Gold evidence updates, and release notes. Do not change auth semantics, server auth gate behavior, metadata writes, NAS behavior, backup/restore behavior, or Gold status.

## Constraints

- Read-only: no metadata writes, no NAS connection, no backup/restore, no remote command.
- The CLI must use the existing API request helper so `--token` behavior remains consistent with other Agent commands.
- Output must not contain token values, Authorization header, Bearer token, token prefix, env token names with values, metadata, NAS endpoint, or path values.
- Missing or invalid token must fail through existing 401 handling without echoing token material.
- Gold remains blocked; this is auth visibility evidence only, not production-grade authorization.

## Steps

- [x] Add RED tests for `agent.js auth-status`, read token support, missing token, invalid token, unreachable server, and no dataDir/token leakage.
- [x] Implement the Agent CLI command and help text in `src/agent.js`.
- [x] Update V0.76 version, README, and Gold readiness evidence.
- [x] Verify focused Agent CLI, version, README, and Gold readiness tests.

## Execution Evidence

- RED: `node --test test/agent-auth-status.test.js` initially failed because `auth-status` was an unknown command.
- GREEN: `node --test test/agent-auth-status.test.js` passed 5/5.
- Docs/version/Gold: `node --test test/agent-auth-status.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js` passed 325/325.
- Auth regression: `node --test test/agent-auth-status.test.js test/agent-hardening-status.test.js test/health.test.js test/security.test.js` passed 67/67.
- Full suite: `node --test --test-reporter=dot test/*.test.js` exited 0.
- Hygiene: `git diff --check` exited 0; README/src overclaim scan found no positive production-ready, Gold-ready, or real-NAS implementation claims.
- Qwen adversarial review: two timed attempts produced no usable output; not counted as approval.
- ZAI closure: one short prompt returned `FAIL` without a reason; the clarified prompt ignored the no-tools/patch-only instruction, inspected unrelated local GitHub token state, and produced an irrelevant failure. ZAI output is invalid and not counted as acceptance or blocker evidence.
