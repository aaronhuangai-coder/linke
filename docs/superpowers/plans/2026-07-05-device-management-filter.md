# Device Management State Filter and Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.34 device "Management State Filter and Count" (管理态筛选与计数) in the Web Console.

**Architecture:** Pure UI-only derived filtering logic in `src/web/app.js` using `getDeviceManagementStateKey(device)`. Add a management state filter dropdown in `src/web/index.html` and wire it up to `applyDeviceListControls`. Keep strict read-only boundaries: no backend changes, no database writes, no NAS connections, no commands, and no edit/fix operations.

**Tech Stack:** Node.js ESM, browser ESM, built-in `node:test`, zero external runtime dependencies.

## Global Constraints & Boundaries

- **Strict Read-Only Boundary**:
  - No new backend APIs.
  - No metadata write.
  - No remote command execution (no ping, wake, shell scripts).
  - No NAS connection setup.
  - No edit/fix/bulk actions (missing IPs are not corrected/configured via any UI interaction).
- **AND Semantics**:
  - Combined filter status filter + management filter must use AND semantics.
- Use `npm test` as the verification command.

---

### Task 1: README, test/readme.test.js and test/web-console.test.js RED State setup

**Files:**
- Modify: `test/readme.test.js`
- Modify: `test/web-console.test.js`
- Create: `docs/superpowers/specs/2026-07-05-device-management-filter-design.md`
- Create: `docs/superpowers/plans/2026-07-05-device-management-filter.md` (This file)

- [x] **Step 1: Write RED tests in `test/readme.test.js` expecting V0.34 documentation elements.**
- [x] **Step 2: Write RED tests in `test/web-console.test.js` for contract import, pure function behavior, and DOM elements.**
- [x] **Step 3: Run `node --test test/web-console.test.js test/readme.test.js` to verify all V0.34 tests fail as expected.**

---

### Task 2: Implement getDeviceManagementStateKey and Filter UI (Completed)

Files:
- Modify: `src/web/app.js`
- Modify: `src/web/index.html`
- Modify: `README.md`

- [x] **Step 1: Implement getDeviceManagementStateKey pure function in `src/web/app.js`**
- [x] **Step 2: Add dropdown to `src/web/index.html`**
- [x] **Step 3: Update applyDeviceListControls and wire up DOM event listeners in `src/web/app.js`**
- [x] **Step 4: Update README.md to V0.34**
- [x] **Step 5: Run tests and verify GREEN status**
