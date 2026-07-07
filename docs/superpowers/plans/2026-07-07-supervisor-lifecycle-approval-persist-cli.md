# Supervisor Lifecycle Approval Persist CLI Implementation Plan

**Goal:** Add V0.94 Agent CLI support for explicitly persisting sanitized supervisor lifecycle approval records into a caller-provided local `dataDir`.

## Tasks

- [x] Write RED CLI tests.
- [x] Write design spec.
- [x] Verify RED fails because command is unknown.
- [x] Let AGY implement only `src/agent.js` changes.
- [x] Run targeted CLI tests.
- [x] Update version, README, Gold readiness, and release tests to V0.94.
- [x] Run full suite and `git diff --check`.
- [x] Run Qwen adversarial review.
- [x] Run DeepSeek closure.
- [x] Commit and push after verification.

## Verification Commands

```bash
node --test --test-reporter=dot test/agent-supervisor-lifecycle-approval-persist.test.js test/approval-store.test.js
node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
```
