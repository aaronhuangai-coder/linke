# Version Consistency Sort Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only sort controls to the Web Console backup version consistency panel.

**Architecture:** Extend the existing front-end-only version consistency control flow. `filterVersionConsistencyGroups()` remains the single in-memory transform point for status, search, and sort; `initConsole()` reads the new select value and re-renders cached consistency groups without API calls.

**Tech Stack:** Plain JavaScript ES modules, static HTML/CSS, Node test runner.

## Global Constraints

- Do not add API endpoints.
- Do not write metadata or persist sort state.
- Do not trigger backup, sync, restore, deletion, NAS connection, NAS app invocation, or remote transfer.
- Use TDD: write tests, verify RED, implement minimal code, verify GREEN.
- Keep changes scoped to Web Console, README, and focused docs.

---

### Task 1: Sort Control Contract

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `src/web/index.html`

**Interfaces:**
- Consumes: static HTML served by `src/server.js`.
- Produces: `select#version-consistency-sort[data-testid="version-consistency-sort"]`.

- [ ] **Step 1: Write the failing test**

Add assertions that the HTML contains `version-consistency-sort` and option values `risk`, `max-drift`, `stale-count`, `latest`, and `name`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/web-console.test.js`
Expected: FAIL because `data-testid="version-consistency-sort"` is missing.

- [ ] **Step 3: Write minimal implementation**

Add the sort label and select to `src/web/index.html`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/web-console.test.js`
Expected: PASS for the HTML contract.

### Task 2: In-Memory Sort Behavior

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `src/web/app.js`

**Interfaces:**
- Consumes: `filterVersionConsistencyGroups(consistency, controls)`.
- Produces: `controls.sort` support with `risk`, `max-drift`, `stale-count`, `latest`, and `name`.

- [ ] **Step 1: Write the failing tests**

Add pure-function tests for sorting by name and maximum drift. Add a DOM test that changing the sort select reorders cached rows and does not increase fetch calls.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/web-console.test.js`
Expected: FAIL because the filter function ignores `controls.sort` and the DOM has no sort listener.

- [ ] **Step 3: Write minimal implementation**

Add sort comparison helpers in `src/web/app.js`, read `version-consistency-sort`, include it in `getVersionConsistencyControls()`, and attach a `change` listener that calls `renderFilteredVersionConsistency()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/web-console.test.js`
Expected: PASS.

### Task 3: README V0.26

**Files:**
- Modify: `test/readme.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: README version history and feature sections.
- Produces: V0.26 documentation and safety boundary.

- [ ] **Step 1: Write the failing tests**

Update README tests to expect V0.26 title, current badge, version table row, feature bullet, safety copy, Web Console combined list entry, and testing coverage entry.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/readme.test.js`
Expected: FAIL because README still says V0.25.

- [ ] **Step 3: Write minimal documentation update**

Update README to V0.26 and add the sort control section.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/readme.test.js`
Expected: PASS.

### Task 4: Final Verification

**Files:**
- No source changes unless verification finds a defect.

**Interfaces:**
- Consumes: complete working tree.
- Produces: fresh verification evidence.

- [ ] **Step 1: Run target tests**

Run: `node --test test/web-console.test.js test/readme.test.js`
Expected: PASS.

- [ ] **Step 2: Run full tests**

Run: `node --test --test-reporter=dot test/*.test.js`
Expected: PASS.

- [ ] **Step 3: Run diff check**

Run: `git diff --check`
Expected: no output and exit 0.

- [ ] **Step 4: Run HTTP smoke**

Start server on a temporary localhost port and verify `/`, `/app.js`, and `/api/devices` respond.
Expected: all return successful responses.
