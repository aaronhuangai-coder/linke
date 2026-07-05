# Device Management State Summary & Quick Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.35 device "Management State Bucket Summary and Quick Switching" (管理态分桶统计与快速切换) in the Web Console.

**Architecture:** Pure UI-only derived aggregation in `src/web/app.js` using `buildDeviceManagementSummary(devices)`. Add a bucket summary panel in `src/web/index.html` with stable testids (`device-management-summary-all`, `device-management-summary-visible`, etc.), keep its presentation in `src/web/styles.css`, and wire click listeners to update the select value of `device-management-filter` (which triggers existing AND filtering logic). Maintain strict read-only boundaries: no backend changes, no database writes, no NAS connections, no commands, and no edit/fix operations.

**Tech Stack:** Node.js ESM, browser ESM, built-in `node:test`, zero external runtime dependencies.

## Global Constraints & Boundaries

- **Strict Read-Only Boundary**:
  - No new backend APIs.
  - No metadata write.
  - No remote command execution (no ping, wake, shell scripts).
  - No NAS connection setup.
  - No edit/fix/bulk actions (missing IPs are not corrected/configured via any UI interaction).
- **AND Semantics & Reuse**:
  - Quick switching must update the existing `device-management-filter` select value and trigger the list filtering under existing AND semantics (query + status + management filter).
- Use `npm test` as the verification command.

---

### Task 1: README, test/readme.test.js and test/web-console.test.js RED State setup

**Files:**
- Modify: `test/readme.test.js`
- Modify: `test/web-console.test.js`
- Create: `docs/superpowers/specs/2026-07-05-device-management-summary-design.md` (Completed)
- Create: `docs/superpowers/plans/2026-07-05-device-management-summary.md` (This file)

- [x] **Step 1: Write RED tests in `test/readme.test.js` expecting V0.35 documentation elements.**
- [x] **Step 2: Write RED tests in `test/web-console.test.js` for contract import, pure function behavior, HTML/source contracts, and DOM interaction.**
- [x] **Step 3: Run `node --test test/web-console.test.js test/readme.test.js` to verify all V0.35 tests fail as expected.**

---

### Task 2: Implement buildDeviceManagementSummary, UI, and Quick Switching (Completed)

Files:
- Modify: `src/web/app.js`
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`
- Modify: `README.md`

- [x] **Step 1: Implement buildDeviceManagementSummary pure function in `src/web/app.js`**
- [x] **Step 2: Add summary panel layout to `src/web/index.html` and styles to `src/web/styles.css`**
- [x] **Step 3: Update render/update logic and click listeners in `src/web/app.js`**
- [x] **Step 4: Update README.md to V0.35**
- [x] **Step 5: Run tests and verify GREEN status**
