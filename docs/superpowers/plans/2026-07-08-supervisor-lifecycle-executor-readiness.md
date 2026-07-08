# Supervisor Lifecycle Executor Readiness V0.98

**Goal:** Add a read-only fail-closed executor readiness preflight that turns the generic `executor-implementation-missing` blocker into action-driven executor blockers without executing lifecycle apply.

**Frozen completion criteria:**
- `buildSupervisorLifecycleExecutorReadiness(plan, applyReadiness)` returns sanitized blocked readiness JSON.
- `agent.js supervisor-lifecycle-executor-readiness --config <path> --operation <operation> --data-dir <path>` composes the existing plan, approval-record apply readiness, and executor readiness.
- Executor blockers are driven by lifecycle action ids using `executor-not-implemented-for-action:<actionId>`.
- Output includes `state:"blocked"`, `executorState:"blocked"`, `executorReady:false`, `approvalRecordReady`, `blockers`, `nextBlockers`, `executorBlockers`, `gates`, and `safety`.
- `--fail-on-blocked` exits 2 after printing blocked readiness.
- `--apply` and `--approval` are rejected.
- Config/store failures are sanitized and do not leak paths or secret-like values.
- No approval store writes, lifecycle apply execution, fake executor execution, `launchctl`, metadata writes, NAS calls, backup/restore triggers, or remote commands.

## Implementation Plan

1. Add failing tests.
   - Pure tests cover install, uninstall, rollback, recover, invalid input, missing approval records, and sensitive-output redaction.
   - CLI tests cover empty stores, persisted approval records, `--fail-on-blocked`, rejected write-like flags, sanitized errors, and help output.

2. Implement pure executor readiness.
   - Validate lifecycle plan structure and action sequence.
   - Validate apply readiness structure.
   - Copy only allowlisted apply-readiness blockers.
   - Generate executor blockers from `plan.actions`.
   - Keep all safety flags read-only and fail-closed.

3. Implement Agent CLI command.
   - Read only `--config`, `--operation`, and `--data-dir`.
   - Reuse `buildSupervisorLifecycleApplyPlan`, `readSupervisorLifecycleApprovalRecords`, `buildSupervisorLifecycleApplyReadiness`, and `buildSupervisorLifecycleExecutorReadiness`.
   - Reject `--apply` and `--approval`.
   - Keep `--fail-on-blocked` no-value-only and exit 2 when blocked.

4. Update release docs and scorecard.
   - Bump to `V0.98`.
   - Add README version row and executor readiness CLI section.
   - Add Gold readiness evidence for pure and CLI executor readiness.

5. Verify and review.
   - Run focused tests, `git diff --check`, and full `npm test`.
   - Run Qwen adversarial review and DeepSeek closure verification.
   - Commit and push after validation.

## Resilience Notes

- Normal state: executor readiness remains blocked until real production executor wiring exists.
- Recovery anchor: V0.97 apply-readiness and V0.88 fake executor contract remain unchanged.
- Failure handling: invalid plan/readiness and unreadable stores fail closed.
- Observability: tests assert action-driven blockers, exit codes, no storage creation on read-only paths, and no sensitive text in output.
