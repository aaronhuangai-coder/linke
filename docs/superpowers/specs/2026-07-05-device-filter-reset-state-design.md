# Linke V0.41 Device Filter Reset State Design

## Summary

V0.41 makes the Web Console `device-filter-reset` button stateful. The button is disabled when all device list controls are at their defaults and enabled when any control differs from default.

## Scope

- Export `isDeviceFilterResetActive(controls)` as a pure helper.
- Initialize `device-filter-reset` as disabled in static HTML.
- Sync `disabled`, `aria-disabled`, and `data-active` through the existing `renderFilteredDevices()` path.
- Add a disabled style for the reset button.
- Update README, tests, and plan docs.

## Defaults

| Control | Default |
|---|---|
| `query` | empty or whitespace |
| `status` | `all` |
| `management` | `all` |
| `sort` | `name` |

`isDeviceFilterResetActive(controls)` returns `true` only when at least one control differs from the defaults above.

## DOM State

Default state:

```text
disabled
aria-disabled="true"
data-active="false"
```

Active state:

```text
disabled = false
aria-disabled="false"
data-active="true"
```

## Safety Boundaries

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No `/api/devices` refetch for local state changes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.

## Qwen Adversarial Findings And PM Decisions

- Finding: static HTML should start disabled for no-JS safety.
  - Decision: accepted.
- Finding: `disabled`, `aria-disabled`, and `data-active` must stay synchronized.
  - Decision: accepted and covered by DOM tests.
- Finding: state sync should happen in `renderFilteredDevices()`.
  - Decision: accepted to keep all device control updates on the existing local render path.
- Finding: disabled style is required so the user can see the state.
  - Decision: accepted.
- Finding: add a JSDoc comment to clarify `isDeviceFilterResetActive`.
  - Decision: accepted.

## AGY Implementer Failure Signature

AGY was assigned the V0.41 implementer role. It exited with code 0, produced no stdout, and left the worktree unchanged. PM treated this as invalid worker output and used PM fallback implementation under the user's loop-engineering authorization.

## ZAI Final Verifier Note

The first ZAI verifier prompt returned the invalid fallback phrase `I don't have a specific response`; PM rejected it as non-evidence. A shorter English evidence-only prompt then returned `Status: PASS` and `Final verdict: ACCEPT`.
