# Supervisor Lifecycle Guarded Runner Execution Preview Design

## Goal

V1.09 adds a pure, fail-closed execution preview layer after guarded runner readiness. The feature composes an existing supervisor lifecycle apply plan with `buildSupervisorLifecycleGuardedRunnerReadiness(...)` output and returns a sanitized preview of what a future guarded runner execution pipeline would need before any real execution can be enabled.

## Role Map

- PM: Codex
- Implementer: AGY / ayg
- Adversary: Qwen, read-only
- Verifier: DeepSeek plus Codex PM

## Scope

- Add `buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, guardedRunnerReadiness)` to `src/supervisor-lifecycle.js`.
- Add focused tests in `test/supervisor-lifecycle-guarded-runner-execution-preview.test.js`.
- Bump release metadata and README/Gold evidence to V1.09.
- Keep the result blocked by design: `executionReady:false`, `wouldExecute:false`, `executorReady:false`, and `guarded-runner-execution-preview-only`.

## Non-Goals

- Do not add CLI, API, or Web Console controls in V1.09.
- Do not call `executeSupervisorLifecycleApply`.
- Do not call launchctl, write files, read process lists, connect to NAS, trigger backup or restore, or run remote commands.
- Do not introduce production auth, secret management, token rotation, or daemon installation.
- Do not change existing V1.08 Web behavior.

## Data Shape

The preview returns a stable object:

```js
{
  command: 'supervisor-lifecycle-guarded-runner-execution-preview',
  operation: 'install',
  state: 'blocked',
  executionReady: false,
  executorReady: false,
  runnerBindingsReady: true,
  blockers: ['guarded-runner-execution-preview-only'],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  actionPreviews: [
    {
      actionId: 'render-launch-agent-plist',
      implementationId: 'render-plist-impl',
      runnerKind: 'guarded-runner-stub',
      mode: 'guarded-host-action',
      status: 'blocked',
      wouldExecute: false,
      wouldRun: false,
      wouldWrite: false,
      maxAttempts: 2
    }
  ],
  gates: {
    lifecyclePlanValid: true,
    runnerBindingsReady: true,
    executionPreviewOnly: true,
    executorReady: false
  },
  safety: {
    readOnly: true,
    dryRun: true,
    hostMutation: false,
    launchctlCalled: false,
    processListRead: false,
    filesystemWritten: false,
    metadataWritten: false,
    rollbackAnchorWritten: false,
    auditEventWritten: false,
    approvalPersisted: false,
    lifecycleApplied: false,
    nasConnected: false,
    backupTriggered: false,
    restoreTriggered: false,
    remoteCommandExecuted: false,
    sensitiveValuesReturned: false
  }
}
```

## Validation Rules

- `null`, `undefined`, arrays, strings, numbers, or otherwise invalid `plan` input return a blocked object with `invalid-lifecycle-plan`; the function must not throw for bad caller input.
- `null`, `undefined`, arrays, strings, numbers, or otherwise invalid `guardedRunnerReadiness` input return a blocked object with `invalid-guarded-runner-readiness`; the function must not throw for bad caller input.
- Invalid or tampered lifecycle plans return `invalid-lifecycle-plan` or `lifecycle-plan-action-mismatch`.
- Invalid guarded runner readiness returns `invalid-guarded-runner-readiness`.
- Guarded runner readiness that is not ready adds `guarded-runner-readiness-not-ready`.
- Valid readiness still remains blocked with `guarded-runner-execution-preview-only` and `real-guarded-runner-execution-wiring-missing`.
- Action previews must be derived from the intersection of plan action IDs and guarded runner readiness binding metadata. The blocker flags `wouldExecute:false`, `wouldRun:false`, and `wouldWrite:false` are constant safety caps, but action identity, implementation ID, runner kind, mode, and max attempts must come from validated input so tampered action sequences can be detected.
- Redaction replaces unsafe action or runner metadata with `[redacted]`. Unsafe values include path-like strings, URLs, hostnames, IP addresses, token/secret/password/credential/API-key-like text, hashes, process IDs, and command-like strings containing launchctl, sudo, shells, node/npm/pnpm, git, curl, wget, or osascript.
- The function must never call an executor or async side effect.

## Resilience Gate

- Normal state: V1.09 reports deterministic blocked preview data for a valid plan and valid guarded runner readiness.
- Recovery anchor: the nearest previous green layer is V1.08 guarded runner readiness Web plus V1.07 API and V1.05 pure readiness.
- Bounded failure: malformed plans or readiness payloads return stable blockers and sanitized output.
- Observability: tests assert blocker codes, safety flags, action preview shape, redaction, and no execution-ready overclaim.

## Acceptance Criteria

- New pure-function tests pass and fail before implementation.
- Existing `npm test` remains green.
- README and Gold readiness explicitly say V1.09 is execution preview only and Gold remains blocked.
- Qwen adversarial review and DeepSeek closure both pass before commit/push.
