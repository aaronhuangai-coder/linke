# NAS Execution Readiness Summary Design

## Goal

Linke V0.67 adds a machine-readable NAS execution readiness summary to the existing dry-run plan. The summary helps the Web Console and later orchestration code explain why each NAS target is not executable yet, without enabling real NAS transport.

## Scope

Add dry-run-only fields:

- Top-level `readinessSummary`
- Per-target `executionReadiness`

The readiness signal is about future remote execution readiness, not Gold readiness and not production readiness.

## Readiness Rules

For every validated target:

- `target-disabled` is a blocker when `enabled` is false.
- `credential-ref-missing` is a blocker when the target is enabled and `credentialRefConfigured` is false.
- `remote-execution-blocked` is always a blocker while `executionGate.remoteExecutionAllowed` is false.
- `state` is `blocked` when any blocker exists; otherwise `ready`.

In V0.67, `ready` is unreachable because `executionGate.remoteExecutionAllowed` is fixed to false. The value is reserved for future dry-run configuration completeness only; it does not mean production release approval, Gold release approval, or approved remote execution.

Top-level `readinessSummary` reports:

- `mode: "dry-run"`
- `state`
- `totalTargets`
- `enabledTargets`
- `disabledTargets`
- `credentialRefConfiguredTargets`
- `enabledCredentialRefMissingTargets`
- `blockedTargets`
- `remoteExecutionBlocked`
- `blockers`

## Non-Goals

- No real NAS connection.
- No credential resolver.
- No `.env`, token, password, SSH key, cloud credential, or secret manager lookup.
- No NAS app invocation.
- No remote write path.
- No production release or Gold release claim.
- No raw `credentialRef` value in API or Web rendering.
- `credentialRefConfigured` only means a non-secret reference name is present. It must not trigger credential reading or secret resolution.
- Blocker codes must come from fixed allowlisted constants, not from user-controlled strings.

## Web Console

Render `readinessSummary` before the target list using DOM nodes and `textContent`.

Render each target's `executionReadiness.state` and blocker codes near the existing credential reference row.

The UI text must keep saying this is dry-run and blocked. It must not expose any action button for connect, execute, backup, sync, or write.

## Testing

Tests must cover:

- Pure `buildNasDryRunPlan()` readiness summary counts.
- Per-target readiness blockers for enabled/missing credentialRef, enabled/configured credentialRef, and disabled targets.
- API response includes readiness fields and still has `wouldConnect:false`, `wouldWrite:false`, and `executionGate.remoteExecutionAllowed:false`.
- Web rendering shows readiness summary and target blockers with `textContent`.
- Raw `credentialRef` values still do not appear in rendered output.
- README, version, Gold readiness evidence, and Web safety notes move to V0.67 without promoting Gold readiness.
