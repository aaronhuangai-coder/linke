# Supervisor Lifecycle Executor Readiness API V0.99

**Goal:** Add a read-only fail-closed server API for supervisor lifecycle executor readiness, reusing the V0.98 executor readiness helper without adding Web UI or real lifecycle execution.

**Frozen completion criteria:**
- `POST /api/supervisor-lifecycle-executor-readiness` accepts inline `operation` and `config`.
- The endpoint validates `install|uninstall|rollback|recover`, validates config, builds an apply plan, reads server-owned approval records, builds apply readiness, then builds executor readiness.
- The endpoint is not registered in `API_WRITE_ROUTES`, and read-token auth can call it.
- Empty approval stores are not created by the read-only endpoint.
- Submitted approval JSON is ignored and never echoed.
- Outputs and errors do not leak paths, hashes, URLs, approval metadata, token, secret, password, or Authorization material.
- No approval-store writes, lifecycle apply execution, fake executor execution, launchctl, metadata writes, NAS calls, backup/restore triggers, or remote commands.

## Implementation Plan

1. Add failing API tests.
   - Cover route classification, blocked empty-store output, persisted approval record output, read-token access, invalid input sanitization, ignored approval JSON, and no approval storage creation.

2. Implement server route.
   - Import `buildSupervisorLifecycleExecutorReadiness`.
   - Add the read-only route beside apply readiness.
   - Compose existing helpers instead of accepting client-supplied readiness.

3. Update release docs and scorecard.
   - Bump to `V0.99`.
   - Add README version row and executor readiness API section.
   - Add Gold readiness evidence for the endpoint and API tests.

4. Verify and review.
   - Run focused API/version/README/Gold tests.
   - Run `git diff --check` and full test suite.
   - Run Qwen adversarial review and DeepSeek closure verification.

## Resilience Notes

- Normal state: executor readiness remains blocked until real production executor wiring exists.
- Recovery anchor: V0.98 CLI executor readiness and V0.96 apply-readiness API remain unchanged.
- Failure handling: invalid operation and config fail closed with sanitized errors.
- Observability: API tests assert action-driven blockers, read-token behavior, no route write classification, no storage creation, and no sensitive text in output.
