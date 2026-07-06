# Audit Log Web Panel Implementation Plan

**Goal:** Build Linke V0.74 Web Console `audit-log-panel` for manual, read-only visibility into sanitized local audit events.

**Scope:** Reuse existing GET `/api/audit-log`; add only frontend view-model, rendering, HTML, CSS, docs, version, and tests. Do not change audit storage, server schema, auth rules, NAS behavior, backup/restore behavior, or Gold status.

## Constraints

- Manual-only UI action: no startup request and no auto polling.
- Read-only: no metadata writes, no NAS connection, no backup/restore, no remote command.
- The panel must use existing `apiFetch`, so Web Console in-memory token behavior applies.
- Display must use a frontend allowlist and must not render token values, Authorization headers, sourcePath, targetPath, NAS endpoints, password, apiKey, secret, or credential-like fields.
- Gold remains blocked; `production-hardening` remains partial.

## Steps

- [x] Add RED tests for HTML/source/CSS contract, `buildAuditLogViewModel`, manual refresh, error redaction, and in-flight duplicate prevention.
- [x] Implement `buildAuditLogViewModel` and audit event display allowlist in `src/web/app.js`.
- [x] Add `audit-log-panel` markup in `src/web/index.html`.
- [x] Add audit-log panel styling in `src/web/styles.css`.
- [x] Wire manual GET `/api/audit-log?limit=20`, no init fetch, no polling, and error redaction in `initConsole`.
- [x] Update V0.74 version, README, and Gold readiness evidence.
- [x] Verify targeted Web Console tests and docs/version/Gold tests.

## Execution Evidence

- RED: `node --test test/web-console.test.js` initially failed because `buildAuditLogViewModel` was not exported.
- GREEN: `node --test test/web-console.test.js` passed 314/314.
- Docs/version/Gold: `node --test test/version.test.js test/readme.test.js test/gold-readiness.test.js` passed 318/318.
- Targeted combined suite: `node --test test/web-console.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js` passed 632/632.
- Full suite: `node --test --test-reporter=dot test/*.test.js` exited 0.
- Hygiene: `git diff --check` exited 0; overclaim scan found no positive `生产可用`, `production ready`, real-NAS implementation claim, or equivalent release overclaim.
- Qwen adversarial review: no usable output after two timed waits; not counted as approval.
- ZAI closure: strict JSON prompts regressed to default empty response, but a no-tools single-line prompt returned `OK_TO_COMMIT_WITH_CONCERNS`; counted as closure with concerns, not as a blocker-free approval.
