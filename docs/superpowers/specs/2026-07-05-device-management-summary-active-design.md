# Linke V0.36 Device Management Summary Active Controls Design

## Summary

V0.36 upgrades the V0.35 management-state summary buckets into accessible active filter controls. The buckets remain a read-only browser-side view over already-loaded device data, but they now expose button semantics, active visual state, `aria-pressed`, and `data-active`.

## Goals

- Use the existing `device-management-filter` select value as the single source of truth.
- Render each summary bucket as a keyboard-accessible button with stable existing `data-testid` hooks.
- Keep bucket count semantics identical to V0.35 by reusing `buildDeviceManagementSummary(devices)` and `getDeviceManagementStateKey(device)`.
- Synchronize active state on initial load, bucket clicks, and manual `device-management-filter` changes.
- Preserve local-only filtering and the no-refetch guarantee for `/api/devices`.

## Non-Goals

- No backend API changes.
- No metadata writes.
- No NAS connection or remote command execution.
- No persistent filter state. Refreshing the page resets to the default filter state.
- No edit, fix, or bulk management action.

## Qwen Adversarial Findings And Decisions

- State drift risk: resolved by treating `device-management-filter.value` as the only source of truth.
- ARIA risk: resolved by setting `aria-pressed` from the same source of truth during every summary render.
- Layout risk: resolved by preserving the existing `.summary-bucket` dimensions and adding button-specific CSS reset.
- Semantics mismatch risk: resolved by continuing to use V0.34 `getDeviceManagementStateKey` and V0.35 summary counts.
- Persistence concern: explicitly non-goal; the UI does not promise persistence.

## Verification Strategy

- README tests require V0.36 current-version documentation, V0.35 historical row, safety boundaries, and test coverage notes.
- HTML contract tests require summary buckets to be buttons with declared filter values and initial `aria-pressed`.
- Source contract tests require active summary rendering logic, `aria-pressed`, and `data-active` updates.
- DOM tests verify initial active state, bucket-click state, manual select-change state, count updates, and no `/api/devices` refetch.
