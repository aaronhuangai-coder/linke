# Supervisor Lifecycle Approval Store Implementation Plan

**Goal:** Add V0.93 local sanitized approval record persistence foundation while keeping lifecycle apply, Web/API persist, installer, rollback, uninstall, recovery supervisor, NAS, backup, restore, and Gold release blocked.

## Tasks

- [x] Write design spec.
- [x] Write RED tests in `test/approval-store.test.js`.
- [x] Verify RED fails for missing `src/approval-store.js`.
- [x] Let AGY implement only `src/approval-store.js`.
- [x] Run targeted approval store tests.
- [x] Update version, README, Gold readiness, and release tests for V0.93.
- [x] Run full suite and `git diff --check`.
- [x] Run Qwen adversarial review.
- [x] Run DeepSeek closure.
- [ ] Commit and push after verification.

## Verification Commands

```bash
node --test --test-reporter=dot test/approval-store.test.js
node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
```

## Verification Evidence

- RED: `node --test --test-reporter=spec test/approval-store.test.js` failed because `src/approval-store.js` was missing.
- GREEN: `node --test --test-reporter=dot test/approval-store.test.js` exited 0 after AGY implementation and repair.
- Release targets: `node --test --test-reporter=dot test/approval-store.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js` exited 0.
- Full suite: `node --test --test-reporter=dot test/*.test.js` exited 0.
- `git diff --check` exited 0.
- Route boundary suite: `node --test --test-reporter=dot test/server.test.js test/web-console.test.js test/agent-supervisor-lifecycle-approval-persistence-preview.test.js test/approval-store.test.js` exited 0.
- Qwen review returned `状态: PASS`, `阻塞问题: NONE`, `Gold状态: blocked`.
- DeepSeek closure returned JSON `status:"PASS"`, `accepted:true`, `blocking_findings:[]`, `gold_status:"blocked"`.
