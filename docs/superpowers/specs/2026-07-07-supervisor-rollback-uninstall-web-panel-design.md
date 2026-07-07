# Supervisor Rollback Uninstall Web Panel Design

## Goal

V0.86 extends the existing Web Console `supervisor-install-dry-run-panel` so operators can inspect the V0.85 `rollbackUninstallPlan` returned by `POST /api/supervisor-install-dry-run`.

The feature remains display-only and dry-run-only. It must not add a new lifecycle endpoint, call `launchctl`, read process lists, install, start, roll back, uninstall, remove files, restore previous plists, start a recovery supervisor, write metadata, connect NAS, trigger backup/restore, execute remote commands, or claim Gold readiness.

## Current Context

V0.84 added the manual Web Console supervisor install dry-run panel:

- `POST /api/supervisor-install-dry-run`
- `supervisor-install-dry-run-panel`
- `buildSupervisorInstallDryRunViewModel(plan, errorMessage = '')`
- manual click-only request flow
- no startup request and no polling
- allowlisted rendering of readiness, command preview, preflight, approval manifest, and top-level safety flags

V0.85 added the backend full-plan `rollbackUninstallPlan` object:

- `rollbackUninstallPlan.state:"blocked"`
- `rollback.available:false`
- `uninstall.available:false`
- `recovery.available:false`
- `actions[].wouldRun:false`
- `actions[].wouldWrite:false`
- `safety.rollbackExecuted:false`
- `safety.uninstallExecuted:false`
- `safety.recoverySupervisorStarted:false`
- `safety.launchctlCalled:false`
- `safety.processListRead:false`
- `safety.filesystemWritten:false`
- `safety.metadataWritten:false`
- `safety.launchdFileRemoved:false`
- `safety.previousPlistRestored:false`

The current Web panel already receives this object through the existing POST response, but does not render it beyond the older approval-manifest rollback summary.

## Selected Approach

Reuse the existing `POST /api/supervisor-install-dry-run` endpoint and add a strictly allowlisted Web view-model/rendering layer for `rollbackUninstallPlan`.

This approach is selected because it keeps V0.86 as a presentation and operator-visibility increment. It does not widen server behavior or introduce a lifecycle mutation surface.

The Web view model should add:

- `rollbackStateText`: derived from `rollbackUninstallPlan.rollback.available`, `uninstall.available`, and `recovery.available` when the plan exists; otherwise fall back to the V0.84 approval-manifest rollback summary.
- `rollbackUninstallActions`: an array of strings using only `action.id`, `action.kind`, `action.status`, `action.wouldRun`, `action.wouldWrite`, and `action.blockerCode`.
- `rollbackUninstallSafetyLines`: an array of allowlisted boolean safety flags from `rollbackUninstallPlan.safety`.

The view model must not include `action.evidence`, `rollback.evidence`, `uninstall.evidence`, or `recovery.evidence` strings. Those fields are backend schema documentation only and are not part of the Web rendering allowlist.

The DOM renderer should add two groups inside the existing result area:

- `Rollback / uninstall plan`
- `Rollback / uninstall safety flags`

No raw action `evidence`, command strings, config summaries, local paths, URLs, NAS endpoints, credential refs, tokens, Authorization headers, approval identity, timestamps, hostnames, usernames, process ids, plist paths, executable paths, or runnable command arguments may be rendered.

## Alternatives Considered

### 1. Add a new `GET /api/supervisor-rollback-uninstall-dry-run` endpoint

Rejected. The full dry-run plan already contains the lifecycle plan. A second endpoint would add routing and authorization surface without improving safety.

### 2. Add rollback/uninstall buttons

Rejected. V0.86 is not a mutating lifecycle release. Buttons for rollback, uninstall, recovery, stop, unload, remove, install, start, or approve would imply capability that does not exist and would violate the Gold boundary.

### 3. Render `rollbackUninstallPlan` as raw JSON

Rejected. Raw JSON would be faster to implement but would weaken the existing Web panel's allowlist discipline and could expose future sensitive fields if the backend schema grows.

## Non-Goals

- Do not add a new API route.
- Do not add `--rollback`, `--uninstall`, `--stop`, `--unload`, `--remove`, `--recover`, `--approve-install`, `--install`, or `--start`.
- Do not add any button or UI action that implies execution of rollback, uninstall, recovery, install, start, stop, unload, remove, or approve.
- Do not call `launchctl`.
- Do not read process lists or installed launch agents.
- Do not inspect, create, delete, or restore LaunchAgents or plist files.
- Do not write config, metadata, approval records, rollback manifests, reports, snapshots, device records, NAS data, or recovery state.
- Do not connect NAS, trigger backup, trigger restore, copy remote data, or execute remote commands.
- Do not display raw `evidence`, `command`, `program`, `configSummary`, `serverUrl`, `sourcePath`, NAS endpoint, `remotePath`, `credentialRef`, token values, Authorization headers, environment values, approval identity, timestamps, hostnames, usernames, process ids, real home paths, plist paths, executable paths, or runnable command arguments.
- Do not claim production supervisor, rollback readiness, uninstall readiness, recovery supervisor readiness, managed daemon lifecycle, production hardening, or Gold readiness.

## Web View-Model Contract

`buildSupervisorInstallDryRunViewModel(plan, errorMessage = '')` should keep the V0.84 fields and add:

```js
{
  rollbackStateText: 'rollback:false / uninstall:false / recovery:false',
  rollbackUninstallActions: [
    'capture-current-state · rollback · blocked · wouldRun:false · wouldWrite:false · rollback-state-capture-missing'
  ],
  rollbackUninstallSafetyLines: [
    'dryRun:true',
    'planOnly:true',
    'rollbackExecuted:false',
    'uninstallExecuted:false',
    'recoverySupervisorStarted:false',
    'launchctlCalled:false',
    'processListRead:false',
    'filesystemWritten:false',
    'metadataWritten:false',
    'supervisorInstalled:false',
    'supervisorStarted:false',
    'launchdFileWritten:false',
    'launchdFileRemoved:false',
    'previousPlistRestored:false',
    'nasConnected:false',
    'backupTriggered:false',
    'restoreTriggered:false',
    'remoteCommandExecuted:false',
    'sensitiveValuesReturned:false'
  ]
}
```

Unknown and error states should return empty `rollbackUninstallActions` and `rollbackUninstallSafetyLines`.

The `rollbackUninstallSafetyLines` example above is exhaustive for V0.86. If future backend releases add new lifecycle safety flags, they must be deliberately allowlisted and tested before they are rendered.

When `rollbackUninstallPlan` is missing, `rollbackStateText` should remain compatible with the existing approval-manifest fallback:

```text
available:false
```

When `rollbackUninstallPlan` exists, the stat should use the more complete lifecycle summary:

```text
rollback:false / uninstall:false / recovery:false
```

The existing `Approval manifest` group remains rendered. The new `Rollback / uninstall plan` group supplements it with the more detailed V0.85 lifecycle plan. Do not suppress or reinterpret the approval controls; they remain install prerequisites.

## DOM Rendering

`renderSupervisorInstallDryRun(viewModel)` should keep the current group order and insert lifecycle groups before top-level safety flags:

1. `Readiness blockers`
2. `Command preview`
3. `Install preflight`
4. `Approval manifest`
5. `Rollback / uninstall plan`
6. `Rollback / uninstall safety flags`
7. `Safety flags`

The result area should still start with the existing status message. The panel must remain manual-only: no request on initialization and no polling.

## HTML Copy

Update the existing safety note inside `supervisor-install-dry-run-panel` to mention that the panel may display rollback/uninstall/recovery dry-run blockers, but it does not execute rollback, uninstall, file removal, previous plist restore, or recovery supervisor startup.

The copy must keep the existing no-Gold-ready boundary.

Required safety-note meaning:

```text
Supervisor install dry-run 仅手动 POST /api/supervisor-install-dry-run 生成只读预览，可展示 install、approval、rollback、uninstall 与 recovery supervisor 的 blocked dry-run 计划；无启动请求、不自动轮询、不调用 launchctl、不读取进程列表、不安装或启动 supervisor、不执行 rollback 或 uninstall、不删除 launchd 文件、不恢复 previous plist、不启动 recovery supervisor、不写入 metadata、不连接 NAS、不触发备份或恢复、不执行远程命令；仅展示 allowlist 字段，不显示 token、Authorization header、serverUrl、sourcePath、NAS endpoint、credentialRef、approval identity、timestamp、hostname、username、process id、plist path、executable path、raw evidence 或 runnable command；Gold 仍 blocked，不能声明生产就绪。
```

## Testing Strategy

Add focused tests in `test/web-console.test.js`:

- `buildSupervisorInstallDryRunViewModel` returns empty lifecycle arrays for missing payload and error payload.
- Full view-model test includes `rollbackUninstallPlan` with deliberately dangerous raw strings in ignored fields and verifies:
  - `rollbackStateText` becomes `rollback:false / uninstall:false / recovery:false`
  - `rollbackUninstallActions` includes action ID, kind, status, `wouldRun:false`, `wouldWrite:false`, and blocker code
  - `rollbackUninstallSafetyLines` includes rollback/uninstall/recovery/launchctl/process/filesystem/NAS/remote false flags
  - rendered model text does not contain raw `evidence`, command strings, local paths, URLs, NAS endpoint, credential refs, token-like values, approval identity, timestamp, hostname, username, process id, plist path, executable path, or runnable command strings
- DOM click test response includes `rollbackUninstallPlan` and verifies the result area renders:
  - `capture-current-state`
  - `unload-launch-agent`
  - `wouldRun:false`
  - `wouldWrite:false`
  - `rollbackExecuted:false`
  - `uninstallExecuted:false`
  - `recoverySupervisorStarted:false`
  - no raw evidence or runnable command string
- HTML safety-note test verifies rollback/uninstall/recovery dry-run wording and the absence of production/Gold-ready claims.
- Existing tests for no startup request, duplicate in-flight blocking, invalid JSON, sanitized errors, and POST behavior stay intact.

Focused verification commands:

```bash
node --test --test-reporter=dot test/web-console.test.js
node --test --test-reporter=dot test/agent-supervisor-install-dry-run.test.js test/gold-readiness.test.js test/readme.test.js test/version.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
```

## Documentation and Versioning

After implementation, update:

- `src/version.js` to `V0.86`
- `src/gold-readiness.js` evidence for `automation-installation` and `production-hardening`, limited to these exact display-only evidence strings:
  - `rollbackUninstallPlan Web Console rendering`
  - `buildSupervisorInstallDryRunViewModel rollbackUninstallActions`
  - `buildSupervisorInstallDryRunViewModel rollbackUninstallSafetyLines`
- `README.md` current-version summary, version table, Web panel section, and Gold boundary text
- `test/version.test.js`
- `test/gold-readiness.test.js`
- `test/readme.test.js`

Gold must remain blocked. `automation-installation` and `production-hardening` must remain `partial`; the three allowed evidence strings above are display-only visibility evidence and must not claim rollback readiness, uninstall readiness, recovery supervisor readiness, production hardening, or Gold readiness. `real-nas-remote-backup` remains blocked.

## Runtime Resilience Gate

### Normal State

The panel is idle until clicked. Normal successful V0.86 state is:

- one manual POST to `/api/supervisor-install-dry-run`
- HTTP `200`
- sanitized blocked install plan rendered
- sanitized blocked rollback/uninstall plan rendered
- no writes and no external system calls
- UI remains usable after success or error

### Recovery Anchor

The recovery anchor remains the idle unknown panel state with textarea content preserved. On parse failure or API failure, the panel renders a sanitized error without changing server data.

### Bounded Failure

- Empty textarea: local error, no network request.
- Invalid JSON: local error, no network request.
- Invalid config: `400`, sanitized error, no raw submitted values.
- Non-2xx response: sanitized error, no raw sensitive values.
- Duplicate click while in flight: second request blocked.

### State Detection

The UI reports status through the existing status stat and renders explicit false lifecycle safety flags. Tests assert no startup request, no auto polling, one manual POST, and no raw sensitive lifecycle fields in rendered text.
