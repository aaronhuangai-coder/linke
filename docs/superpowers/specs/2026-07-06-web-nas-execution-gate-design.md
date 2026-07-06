# Web NAS Execution Gate Display Design

## Goal

Linke V0.65 exposes the V0.64 NAS credential reference gate in the Web Console NAS dry-run panel. The change is presentation-only: it renders fields already returned by `POST /api/nas-dry-run` and does not add real NAS transport, credential resolution, NAS network probes, or remote writes.

## Scope

- Render top-level `executionGate.remoteExecutionAllowed` and `executionGate.blockingReason` in the NAS dry-run result.
- Render per-target `credentialRefConfigured` as a boolean state, without reading or displaying raw `credentialRef`.
- Update the NAS dry-run safety note to state that `executionGate` is a dry-run boundary and not a production-ready NAS transport.
- Move the release marker to V0.65 and update README / Gold readiness evidence text.
- Keep `nas-dry-run` partial and `real-nas-remote-backup` blocked.

## Non-Goals

- No NAS endpoint connection.
- No NAS app invocation.
- No credential, secret manager, `.env`, token, password, or key lookup.
- No raw `credentialRef` output in API, CLI, Web, README examples, or Gold readiness.
- No claim that Linke is production-ready.

## UI Behavior

When a NAS dry-run response contains `executionGate`, the result panel shows a compact gate row before the target list. The row must communicate:

- remote execution is blocked when `remoteExecutionAllowed:false`
- the blocking reason comes from the API response
- the result is still a dry-run plan

Each target item shows credential reference state as one of:

- `凭证引用：已配置` when `credentialRefConfigured === true`
- `凭证引用：未配置` otherwise

The UI must use textContent-created DOM nodes only, preserving the existing injection-safe rendering pattern.

## Testing

Add DOM tests in `test/web-console.test.js` proving:

- `executionGate.remoteExecutionAllowed:false` and blocking reason render in the NAS dry-run result.
- `credentialRefConfigured` true and false both render.
- a raw credential slug provided only in the submitted config does not appear in the rendered result.

Update version, README, Web safety text, and Gold readiness tests to V0.65.

## Qwen Adversarial Notes

Qwen returned `PASS` with no blockers. It specifically requested DOM coverage for gate rendering, true/false credential reference state, and raw slug non-leakage. It also recommended clarifying that `executionGate` does not mean real NAS transport is production-ready.
