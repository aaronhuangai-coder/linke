# Supervisor Lifecycle Apply Readiness V0.96

**Goal:** Add a read-only fail-closed readiness preflight that checks whether a persisted sanitized supervisor lifecycle approval record can satisfy the approval-store gate before any real lifecycle apply wiring exists.

**Constraints:**
- Do not add a real `/api/supervisor-lifecycle-apply` endpoint.
- Do not call `executeSupervisorLifecycleApply` from server or Web Console.
- Do not call `launchctl`, write LaunchAgents, write metadata, write audit events, connect NAS, trigger backup/restore, or execute remote commands.
- Do not return approval identity, reason, acknowledgement text, timestamps from approval payloads, hashes, paths, URLs, tokens, Authorization headers, hostname, username, process id, or `dataDir`.
- Treat persisted approval records as sanitized evidence only; they do not make Gold production-ready.

## Implementation Plan

1. Add pure readiness tests.
   - Missing records returns blocked with `approval-record-missing`.
   - Matching persisted sanitized record returns approval-record gate `ready` while `lifecycleApplied:false`.
   - Mismatched operation, invalid validation, and tampered safety stay blocked.

2. Implement `buildSupervisorLifecycleApplyReadiness(plan, approvalRecords)`.
   - Accept only an existing `supervisor-lifecycle-apply` plan.
   - Require `applyFlag:true` and `envGate:true`.
   - Ignore the expected `approval-missing` plan blocker when a persisted record satisfies the approval-store gate.
   - Keep `executor-implementation-missing` as a next blocker, not as proof of apply readiness.
   - Return allowlisted counts, blockers, gates, and safety flags only.

3. Add read-only Web/API route.
   - `POST /api/supervisor-lifecycle-apply-readiness` accepts inline `operation` and `config`.
   - Reads server-owned approval records from `dataDir`.
   - Must not be registered in `API_WRITE_ROUTES`.
   - Read token may call it; write token/full token also works through existing auth gate.

4. Add Web Console manual action.
   - Add `supervisor-lifecycle-apply-readiness-button`.
   - Reuse operation/config inputs.
   - Do not parse or require approval JSON for readiness.
   - Do not call the endpoint on initialization.
   - Render readiness blockers, record counts, validation gate, and safety flags.

5. Update release docs and scorecard.
   - Bump to `V0.96`.
   - Document the route, Web button, fail-closed semantics, and Gold blocked boundary.

6. Verify and review.
   - Run focused tests first, then full `node --test`.
   - Ask Qwen for adversarial review of the diff.
   - Ask DeepSeek for strict closure validation.
   - Commit and push after validation.
