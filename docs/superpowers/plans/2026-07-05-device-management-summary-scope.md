# Device Management Summary Scoped Counts Implementation Plan

**Goal:** Implement Linke V0.37 management-state summary scoped counts.

**Architecture:** Add a pure helper that filters devices by search query and status before building management-state summary counts. Do not apply the management filter to the summary count scope.

## Constraints

- Frontend-only read-only behavior.
- No backend API changes.
- No `/api/devices` refetch on local filter changes.
- No metadata writes.
- No NAS connection or remote command execution.
- Preserve V0.36 button active/aria state.

## Tasks

### Task 1: RED Tests

Files:
- Modify: `test/readme.test.js`
- Modify: `test/web-console.test.js`

- [x] Add README V0.37 current-version expectations.
- [x] Downgrade V0.36 current-version checks to historical checks.
- [x] Add pure helper tests for search+status scoped counts while ignoring management filter.
- [x] Add DOM test for summary count changes on search/status and stability on management filter changes.
- [x] Run target tests and confirm RED.

### Task 2: GREEN Implementation

Files:
- Modify: `README.md`
- Modify: `src/web/app.js`
- Add: `docs/superpowers/specs/2026-07-05-device-management-summary-scope-design.md`
- Add: `docs/superpowers/plans/2026-07-05-device-management-summary-scope.md`

- [x] Add `buildDeviceManagementSummaryScope(devices, controls)`.
- [x] Wire summary rendering to use scoped counts.
- [x] Update README to V0.37.
- [x] Run target tests, full tests, diff check, and HTTP smoke.
- [x] Run final verifier.
