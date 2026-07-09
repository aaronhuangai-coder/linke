# Supervisor Lifecycle Guarded Runner Execution Preview CLI Design

## Goal

Add V1.10 Agent CLI visibility for the V1.09 pure guarded runner execution preview by introducing `agent.js supervisor-lifecycle-guarded-runner-execution-preview`.

## Scope

- Add a read-only CLI command that accepts `--config <path>`, `--operation <install|uninstall|rollback|recover>`, `--manifest <path>`, and `--runner-binding <path>`.
- Reuse the existing lifecycle chain: `buildSupervisorLifecycleApplyPlan` -> `validateSupervisorLifecycleExecutorManifest` -> `buildSupervisorLifecycleGuardedRunnerReadiness` -> `buildSupervisorLifecycleGuardedRunnerExecutionPreview`.
- Print sanitized JSON only.
- Support `--fail-on-blocked` with exit code 2 when the preview remains blocked.
- Update release version, README, Gold readiness evidence, and tests to V1.10.

## Out Of Scope

- No `executeSupervisorLifecycleApply` call.
- No lifecycle apply execution.
- No launchctl call.
- No filesystem writes.
- No process list reads.
- No NAS connection.
- No backup or restore trigger.
- No remote command execution.
- No API route.
- No Web Console surface.
- No approval JSON or approval store input.
- No `--data-dir`, `--output`, or `--apply` support.

## CLI Contract

Command:

```bash
node src/agent.js supervisor-lifecycle-guarded-runner-execution-preview \
  --config <path> \
  --operation install \
  --manifest <path> \
  --runner-binding <path>
```

Required arguments:

- `--config <path>` loads a normal Linke config through existing config validation.
- `--operation <install|uninstall|rollback|recover>` selects the lifecycle plan operation.
- `--manifest <path>` reads executor manifest JSON.
- `--runner-binding <path>` reads guarded runner binding JSON.

Optional argument:

- `--fail-on-blocked` exits 2 after printing JSON when `preview.state === "blocked"`.

Rejected arguments:

- `--apply`
- `--approval`
- `--data-dir`
- `--output`

## Output Contract

The command prints the object returned by `buildSupervisorLifecycleGuardedRunnerExecutionPreview`.

Required top-level safety values:

```json
{
  "command": "supervisor-lifecycle-guarded-runner-execution-preview",
  "state": "blocked",
  "executionReady": false,
  "executorReady": false,
  "wouldExecute": false,
  "blockers": ["guarded-runner-execution-preview-only"],
  "nextBlockers": ["real-guarded-runner-execution-wiring-missing"]
}
```

`runnerBindingsReady` may be true when the runner binding metadata validates, but execution still remains blocked.

## Error Contract

All read or parse errors must be sanitized and must not echo config paths, manifest paths, runner binding paths, token-like values, hostnames, usernames, local directories, URLs, raw JSON parse errors, or Node filesystem error names.

Error messages:

- Config: `supervisor-lifecycle-guarded-runner-execution-preview failed; verify --config points to a readable valid Linke config`
- Manifest: `supervisor-lifecycle-guarded-runner-execution-preview failed; verify --manifest points to a readable valid executor manifest JSON`
- Runner binding: `supervisor-lifecycle-guarded-runner-execution-preview failed; verify --runner-binding points to a readable valid guarded runner binding JSON`
- Validation: `supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete`

## Safety And Resilience

Normal state is a blocked preview with deterministic JSON. The command may read only the explicit config, manifest, and runner-binding paths supplied by the operator. It must not write local state, create approval storage, touch LaunchAgents, read process lists, start daemons, connect to NAS targets, trigger backup or restore, or execute remote commands.

Failure mode is fail-closed: missing or invalid inputs exit 1 with sanitized errors; a blocked preview with `--fail-on-blocked` exits 2 after printing the sanitized JSON. The recovery anchor is the unchanged repository and no generated local state. Observability is the CLI JSON plus exit code.

## Tests

Create `test/agent-supervisor-lifecycle-guarded-runner-execution-preview.test.js` covering:

- Valid config, manifest, and runner binding print blocked execution preview and do not create local storage.
- `--fail-on-blocked` exits 2 after printing blocked preview.
- Unsafe runner binding metadata is redacted in action previews.
- Config, manifest, and runner-binding read or parse failures are sanitized.
- Unsupported write-like flags are rejected.
- `--help` documents the new command and required flags.

Update existing version, Gold readiness, and README tests to treat V1.10 as current while preserving V1.09 as historical pure-function evidence.
