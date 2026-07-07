# Supervisor Lifecycle Approval Persistence Preview CLI Implementation Plan

**Goal:** Add V0.91 Agent CLI access to the sanitized supervisor lifecycle approval persistence preview without adding any real persistence or lifecycle execution.

**Scope:** `agent.js supervisor-lifecycle-approval-persistence-preview` only. No Web/API endpoint, no `--apply`, no approval writes, no host mutation.

## Constraints

- The command may read only explicit `--config` and optional `--approval` paths.
- Forbidden approval paths must be rejected before reading.
- The command must not write approval files, metadata, audit events, LaunchAgents, rollback anchors, backups, restores, NAS data, or remote data.
- Output must be the sanitized `buildSupervisorLifecycleApprovalPersistencePreview(...)` object.
- Output must not contain approval identities, reasons, acknowledgement content, timestamps, `sha256:` values, local paths, URLs, tokens, secret-like strings, hostnames, usernames, or process ids.
- `--apply` must be rejected for this command.
- `--fail-on-blocked` may exit 2 after printing the blocked JSON preview.
- Gold remains blocked.

## Tasks

- [x] Write RED CLI tests in `test/agent-supervisor-lifecycle-approval-persistence-preview.test.js`.
- [x] Verify RED fails because command is unknown.
- [x] Import `buildSupervisorLifecycleApprovalPersistencePreview` into `src/agent.js`.
- [x] Add help text and option text for `supervisor-lifecycle-approval-persistence-preview`.
- [x] Add CLI branch with config/operation validation, optional approval parsing, forbidden approval path guard, `--apply` rejection, and `--fail-on-blocked` support.
- [x] Update `src/version.js` to V0.91.
- [x] Update README current version, version table, Gold blockers, and safety boundary text.
- [x] Update `src/gold-readiness.js` evidence and next steps.
- [x] Update version, README, and Gold readiness tests.
- [x] Run targeted tests.
- [x] Run full suite.
- [x] Run safety scans.
- [x] Run Qwen review and DeepSeek closure.
- [ ] Stop at commit gate unless Aaron confirms commit/push.

## Verification Commands

```bash
node --test --test-reporter=dot test/agent-supervisor-lifecycle-approval-persistence-preview.test.js test/agent-supervisor-lifecycle-apply.test.js
node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js
node --test --test-reporter=dot test/supervisor-lifecycle-approval-persistence-preview.test.js test/supervisor-lifecycle.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
```

## Verification Evidence

- `node --test --test-reporter=dot test/agent-supervisor-lifecycle-approval-persistence-preview.test.js test/agent-supervisor-lifecycle-apply.test.js` exited 0.
- `node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js` exited 0.
- `node --test --test-reporter=dot test/supervisor-lifecycle-approval-persistence-preview.test.js test/supervisor-lifecycle.test.js` exited 0.
- `node --test --test-reporter=dot test/*.test.js` exited 0.
- `git diff --check` exited 0.
- Diff safety scan for added write paths, launchctl/spawn/exec, positive production-ready claims, and host-mutation true flags returned no matches.
- Route isolation scan found no approval persistence preview endpoint in `src/server.js`, `src/web`, `test/server.test.js`, or `test/web-console.test.js`.
- Qwen advisory review returned `STATUS: PASS`, `BLOCKING_FINDINGS: NONE`, `GOLD_STATUS: blocked`.
- DeepSeek closure returned JSON `status:"PASS"`, `accepted:true`, `gold_status:"blocked"`, with no blocking findings.
