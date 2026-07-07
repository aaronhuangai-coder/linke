# Supervisor Lifecycle Approval Persistence Preview Web/API Implementation Plan

**Goal:** Add V0.92 manual Web/API access to the sanitized supervisor lifecycle approval persistence preview without adding real approval persistence or lifecycle execution.

**Scope:** Web Console panel, preview-only API route, sanitized view model, documentation, and release evidence.

## Constraints

- Do not add `/api/supervisor-lifecycle-apply`.
- Do not register the preview route as an `API_WRITE_ROUTES` write route.
- Do not read local approval paths from Web/API.
- Do not write approval records, metadata, audit events, LaunchAgents, rollback anchors, NAS data, backups, restores, or remote resources.
- Do not call `launchctl`, spawn lifecycle commands, install, start, rollback, uninstall, or recover a supervisor.
- Do not expose approval identities, reasons, acknowledgement content, timestamps, hashes, paths, URLs, endpoints, token material, hostnames, usernames, or process ids.
- Keep Gold blocked.

## Tasks

- [x] Write RED Web/API and DOM tests in `test/web-console.test.js`.
- [x] Add server `POST /api/supervisor-lifecycle-approval-persistence-preview` route.
- [x] Add `buildSupervisorLifecycleApprovalPersistencePreviewViewModel`.
- [x] Add Web Console panel markup and safety note.
- [x] Add panel styles.
- [x] Verify targeted Web/API tests pass.
- [x] Update `src/version.js` to V0.92.
- [x] Update README current version, version table, feature list, API table, Gold blockers, and safety boundary text.
- [x] Update `src/gold-readiness.js` evidence and next steps.
- [x] Update version, README, and Gold readiness tests.
- [x] Run targeted release tests.
- [x] Run full suite.
- [x] Run safety scans.
- [x] Run Qwen readonly review and DeepSeek closure.
- [ ] Stop at commit gate unless Aaron confirms commit/push.

## Verification Commands

```bash
node --test --test-reporter=dot test/web-console.test.js test/server.test.js
node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
```

## Current Evidence

- `node --test --test-reporter=dot test/web-console.test.js test/server.test.js` exited 0 after aligning approval hash generation with API config normalization.
- `node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js` exited 0.
- `node --test --test-reporter=dot test/*.test.js` exited 0.
- `git diff --check` exited 0.
- Safety scan only matched a negative server isolation assertion against `approvalPersisted:true`, `wouldPersist:true`, and `launchctl`.
- Route scan confirmed the new preview endpoint is documented and implemented, while `/api/supervisor-lifecycle-apply` remains test-only as a missing route assertion.
- Qwen read-only review returned `状态: PASS`, `阻塞问题: NONE`, `Gold状态: blocked`.
- DeepSeek closure returned JSON `status:"PASS"`, `accepted:true`, `blocking_findings:[]`, `gold_status:"blocked"`.
