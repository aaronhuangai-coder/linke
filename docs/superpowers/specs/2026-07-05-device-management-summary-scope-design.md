# Linke V0.37 Device Management Summary Scoped Counts Design

## Summary

V0.37 changes management-state summary counts from whole-device-list counts to scoped counts. The scope is the current device search query plus the current device status filter. The current management-state filter is intentionally ignored when computing summary counts, so the buckets remain useful for switching between management states inside the same search/status context.

## Data Flow

```text
cachedDevices
  -> query filter
  -> status filter
  -> buildDeviceManagementSummary()
  -> summary buckets
```

The final device list still uses the existing full control pipeline:

```text
cachedDevices
  -> query filter
  -> status filter
  -> management filter
  -> sort
  -> device list
```

## Goals

- Add `buildDeviceManagementSummaryScope(devices, controls)`.
- Reuse `matchesDeviceSearch`, `normalizeDeviceStatus`, and `buildDeviceManagementSummary`.
- Update summary counts when search or status changes.
- Keep summary counts stable when only the management filter changes.
- Preserve V0.36 active `aria-pressed` / `data-active` behavior.
- Preserve no-refetch behavior for `/api/devices`.

## Non-Goals

- No backend API changes.
- No metadata writes.
- No NAS connection.
- No remote command execution.
- No persistent filter state.
- No pagination or lazy-loading support; counts reflect currently loaded `/api/devices` data.

## Qwen Adversarial Findings And Decisions

- Client-side count accuracy depends on all relevant devices being loaded: accepted for the current prototype because `/api/devices` is loaded as the device list source.
- Counts must come from search+status scope before management filtering: implemented as an explicit helper.
- Management filter changes must not change bucket counts: covered by DOM tests.
- Empty scoped results must show all zero counts: covered by pure-function tests.

## Verification Strategy

- Pure tests cover search+status scope, management-filter ignore behavior, no input mutation, and empty scoped results.
- DOM tests cover status/search changes, management-filter changes, bucket clicks, no-refetch behavior, and visible list count changes.
- README tests cover V0.37 current-version docs, V0.36 historical row, read-only safety, and test coverage text.
