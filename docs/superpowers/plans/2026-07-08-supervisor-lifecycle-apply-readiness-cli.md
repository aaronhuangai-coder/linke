# Supervisor Lifecycle Apply Readiness CLI V0.97

**Goal:** Add a read-only Agent CLI preflight for `supervisor-lifecycle-apply-readiness` so operators and automation can inspect the V0.96 approval-record gate from local sanitized approval storage without using the Web/API surface.

**Frozen completion criteria:**
- `agent.js supervisor-lifecycle-apply-readiness --config <path> --operation <operation> --data-dir <path>` prints sanitized readiness JSON.
- The command reads config and existing approval records only.
- Missing records fail closed with `approval-record-missing`.
- Matching persisted sanitized records set only `approvalRecordReady:true` and `approvalRecordState:"ready"`.
- Top-level `state` stays `blocked` and `nextBlockers` stays `["executor-implementation-missing"]`.
- `--fail-on-blocked` accepts no value and exits 2 when top-level readiness is blocked.
- `--apply` and `--approval` are rejected.
- Config and approval-store read errors are sanitized and do not leak paths or secret-like values.
- No approval store writes, lifecycle apply execution, `launchctl`, metadata writes, NAS calls, backup/restore triggers, or remote commands.

## Implementation Plan

1. Add failing CLI tests.
   - Run the real `node src/agent.js` command through `execFile`.
   - Cover empty store, persisted ready record, `--fail-on-blocked`, rejected write-like flags, sanitized config/store errors, and help output.

2. Implement the Agent CLI command.
   - Import `buildSupervisorLifecycleApplyReadiness` and `readSupervisorLifecycleApprovalRecords`.
   - Reuse `buildSupervisorLifecycleApplyPlan(config, { apply:true, envGateEnabled:true })`.
   - Validate `--config`, `--operation`, `--data-dir`, `--fail-on-blocked`, `--apply`, and `--approval`.
   - Catch config and store errors with stable sanitized messages.

3. Update docs and scorecard.
   - Bump `LINKE_RELEASE_VERSION` to `V0.97`.
   - Add README version row and CLI safety section.
   - Add V0.97 CLI evidence to Gold readiness items.

4. Verify and review.
   - Run focused tests for the new CLI and related lifecycle readiness paths.
   - Run full `npm test`.
   - Ask Qwen for adversarial read-only diff review.
   - Ask DeepSeek for strict closure validation.
   - Commit and push after validation.

## Resilience Notes

- Normal state: CLI prints sanitized readiness JSON and exits 0 unless `--fail-on-blocked` is requested.
- Recovery anchor: V0.96 readiness pure function and approval-store read helper remain the source of truth.
- Failure handling: missing or corrupt approval data fails closed; unreadable store errors return a sanitized operator-facing message.
- Observability: tests assert output schema, exit codes, no writes on empty stores, and no sensitive text in stdout/stderr.
