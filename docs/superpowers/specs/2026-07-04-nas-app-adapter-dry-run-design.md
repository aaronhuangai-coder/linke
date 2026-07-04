# Linke V0.14 NAS App Adapter Dry-Run Design

## Summary

V0.14 adds a NAS app adapter dry-run layer to the existing NAS dry-run provider skeleton. A NAS target may declare an optional `appAdapter` block. Linke validates the adapter, maps it to provider-specific dry-run steps, and returns an `adapterPlan` for each NAS target.

This is still a dry-run-only feature. It does not connect to Synology or Ugreen devices, does not invoke NAS apps, does not authenticate, does not ping/probe endpoints, and does not write local or remote state.

## Goals

- Extend `nasTargets[]` with optional `appAdapter`.
- Support these adapter IDs:
  - `synology-backup`
  - `synology-files`
  - `ugreen-backup`
  - `ugreen-files`
- Reject provider/app mismatches.
- Reject credential-like fields inside `appAdapter`.
- Return `adapterPlan` in `buildNasDryRunPlan(config)` target entries.
- Show adapter plan details in the Web Console NAS dry-run result.
- Update README to V0.14 and document the dry-run boundary.

## Non-Goals

- No real NAS app invocation.
- No Synology DSM API or Ugreen API calls.
- No SMB, WebDAV, rsync, SSH, HTTP NAS endpoint call, ping, probe, auth check, or token exchange.
- No credential storage.
- No config persistence.
- No background scheduler or queue.
- No production security boundary.

## Configuration

Example:

```json
{
  "name": "home-synology",
  "provider": "synology",
  "endpoint": "http://192.168.1.100:5000",
  "shareName": "backup",
  "remotePath": "/volume1/backup",
  "enabled": true,
  "appAdapter": {
    "appId": "synology-backup",
    "operation": "backup-plan"
  }
}
```

`appAdapter` fields:

- `appId`: required non-empty string when `appAdapter` exists.
- `operation`: optional non-empty string, defaults to `backup-plan`.

Forbidden credential-like fields inside `appAdapter`:

```text
username, password, token, apiKey, secret, accessKey, refreshToken
```

## Adapter Rules

Allowed provider/app matrix:

| provider | appId |
|---|---|
| `synology` | `synology-backup` |
| `synology` | `synology-files` |
| `ugreen` | `ugreen-backup` |
| `ugreen` | `ugreen-files` |

Provider mismatch examples:

- `provider:"synology"` + `appId:"ugreen-backup"` => reject
- `provider:"ugreen"` + `appId:"synology-files"` => reject

## Adapter Plan Contract

When a target has no `appAdapter`, return:

```json
{
  "adapterPlan": null
}
```

When a target has `appAdapter`, return:

```json
{
  "adapterPlan": {
    "mode": "dry-run",
    "provider": "synology",
    "appId": "synology-backup",
    "operation": "backup-plan",
    "wouldInvokeApp": false,
    "wouldConnect": false,
    "wouldWrite": false,
    "steps": [
      "validate-target",
      "prepare-app-request",
      "map-backup-jobs",
      "preview-remote-destination"
    ]
  }
}
```

Step presets:

- backup app IDs (`synology-backup`, `ugreen-backup`):
  - `validate-target`
  - `prepare-app-request`
  - `map-backup-jobs`
  - `preview-remote-destination`
- files app IDs (`synology-files`, `ugreen-files`):
  - `validate-target`
  - `prepare-file-browser-request`
  - `map-share-and-path`
  - `preview-file-operation`

## API And CLI Behavior

Existing interfaces remain:

- CLI: `node src/agent.js nas-dry-run --config linke.config.json`
- API: `POST /api/nas-dry-run`
- Web Console: NAS dry-run panel

No new route is required. The returned NAS dry-run plan includes `adapterPlan` on each target. Because the CLI and API already use `buildNasDryRunPlan(config)`, they receive the adapter dry-run output without adding real side effects.

## Web Console Behavior

The existing V0.13 NAS dry-run panel remains the entry point.

Changes:

- The sample JSON includes one Synology backup adapter and one Ugreen files adapter.
- Render each target's adapter plan when present.
- Show:
  - `appId`
  - `operation`
  - `wouldInvokeApp:false`
  - dry-run steps
- If no adapter is configured, show `未配置应用适配器`.
- Render all values with DOM nodes and `textContent`.

No additional real-action button is added.

## Testing

Add tests for:

- `validateNasTarget` accepts valid adapter configs.
- Missing `appId` is rejected.
- Provider/app mismatch is rejected.
- Unknown app ID is rejected.
- Credential-like field inside `appAdapter` is rejected.
- `buildNasDryRunPlan` emits `adapterPlan` with `wouldInvokeApp:false`.
- API returns adapter plans through `POST /api/nas-dry-run`.
- Web Console HTML sample contains `appAdapter`.
- DOM rendering displays adapter app ID, operation, dry-run steps, and no-adapter fallback.
- README documents V0.14 and does not claim real NAS app invocation.

Run:

```bash
npm test
```

## Resilience Design

Normal state:

- Valid adapter config returns an `adapterPlan` with `wouldInvokeApp:false`, `wouldConnect:false`, and `wouldWrite:false`.
- Web Console renders the plan as static text.

Recovery anchor:

- Adapter validation is stateless. Bad adapter input returns `400` via existing API behavior or throws in pure tests. No durable state is changed.

Bounded failure:

- Missing or invalid app IDs are rejected.
- Provider/app mismatch is rejected.
- Credential-like fields are rejected.
- No network or file write function is added to the adapter path.

Observability:

- The Web Console renders adapter validation errors from `POST /api/nas-dry-run`.
- Tests cover the highest-risk path: provider/app mismatch rejected before any side effect.

## PM Decisions

Accepted:

- Model NAS app embedding as dry-run adapter plans.
- Keep V0.14 on existing `nas-dry-run` API/CLI/Web path.
- Support four initial adapter IDs.

Rejected:

- No real app execution in V0.14.
- No credentials in adapter config.
- No new service, scheduler, or remote transport.
