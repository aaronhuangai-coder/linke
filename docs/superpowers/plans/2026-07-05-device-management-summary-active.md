# Device Management Summary Active Controls Implementation Plan

**Goal:** Implement Linke V0.36 management-state summary active controls.

**Architecture:** Keep `device-management-filter` as the single source of truth. Render summary buckets as buttons in `src/web/index.html`, style them in `src/web/styles.css`, and update active/aria state in `src/web/app.js` whenever summary/list rendering occurs.

## Constraints

- Strictly read-only UI enhancement.
- No backend API changes.
- No metadata writes.
- No NAS connection or remote execution.
- No persistent filter state.
- Preserve V0.35 no-refetch behavior for bucket clicks.

## Tasks

### Task 1: RED Tests

Files:
- Modify: `test/readme.test.js`
- Modify: `test/web-console.test.js`

- [x] Add README V0.36 current-version expectations.
- [x] Downgrade V0.35 current-version checks to historical checks.
- [x] Add HTML/source contracts for accessible summary buttons.
- [x] Add DOM test for active `aria-pressed` / `data-active` state on initial load, bucket click, and manual select change.
- [x] Run target tests and confirm RED.

### Task 2: GREEN Implementation

Files:
- Modify: `README.md`
- Modify: `src/web/app.js`
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`
- Add: `docs/superpowers/specs/2026-07-05-device-management-summary-active-design.md`
- Add: `docs/superpowers/plans/2026-07-05-device-management-summary-active.md`

- [x] Convert summary buckets to semantic buttons.
- [x] Add `data-management-filter-value`, `aria-pressed`, and `data-active`.
- [x] Add `setDeviceManagementSummaryActive` and render active state from `device-management-filter`.
- [x] Ensure filter changes refresh active state without refetching `/api/devices`.
- [x] Update README to V0.36.
- [x] Run target tests, full tests, diff check, and HTTP smoke.
