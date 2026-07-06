# NAS Credential Reference Design

## Goal

Add Linke V0.64 NAS credential reference foundation without enabling real NAS execution.

## PM Decision

Qwen rejected the broader NAS readiness contract as over-documentation. V0.64 is narrowed to:

- accept an optional non-secret `credentialRef` slug on each `nasTargets[]` item;
- validate the slug with a strict allowlist;
- never read environment variables or credential stores;
- never echo the `credentialRef` value in `nas-dry-run` output;
- expose only `credentialRefConfigured: boolean` in dry-run target output;
- expose one top-level `executionGate` showing real remote execution remains blocked.

## Credential Reference Contract

- `credentialRef` is optional.
- Valid pattern: `^[a-z][a-z0-9-]{1,30}$`.
- Examples: `home-synology`, `nas-01`.
- Invalid examples: empty strings, whitespace, `../escape`, special characters, uppercase, pure numeric prefixes, and values longer than 31 characters.
- `credentialRef` is a reference identifier only. It is not a credential, not a token, not a username, and not a password.
- Existing forbidden credential fields remain forbidden even when `credentialRef` is present.

## Execution Gate Contract

`buildNasDryRunPlan()` returns:

```js
executionGate: {
  remoteExecutionAllowed: false,
  blockingReason: 'real NAS transport not implemented',
}
```

This gate is code-owned and cannot be overridden by config input.

## Non-Goals

- No real NAS network connection.
- No remote writes.
- No credential resolution.
- No environment variable reads.
- No secret manager integration.
- No Web Console credential display.
- No Gold readiness status upgrade.

## Verification

- Unit tests cover valid and invalid `credentialRef` values.
- Unit tests prove `credentialRef` raw values are not returned in dry-run plans.
- Unit tests prove `executionGate.remoteExecutionAllowed` cannot be flipped by input.
- Existing NAS dry-run and config tests remain green.
- README and Gold docs keep `real-nas-remote-backup` blocked and `nas-dry-run` partial.
