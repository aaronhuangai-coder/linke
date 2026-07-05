# Device Filter Reset State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.41 stateful device filter reset button.

**Architecture:** Keep behavior fully in the browser. Add a pure helper to decide whether reset is active, then sync the button state through the existing `renderFilteredDevices()` path so all control changes update list rendering and button state together.

**Tech Stack:** Node.js ESM, vanilla browser JavaScript, static HTML/CSS, `node:test`.

## Global Constraints

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.
- No new `/api/devices` refetch for local state changes.
- Preserve V0.40 reset behavior and V0.39 empty filter context.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Produces failing expectations for `isDeviceFilterResetActive`, static disabled reset markup, DOM state transitions, and README V0.41 docs.

- [x] **Step 1: Add failing pure-function tests**

Expected:

```js
isDeviceFilterResetActive({}) === false
isDeviceFilterResetActive({ query: 'Beta', status: 'all', management: 'all', sort: 'name' }) === true
isDeviceFilterResetActive({ query: '', status: 'online', management: 'all', sort: 'name' }) === true
isDeviceFilterResetActive({ query: '', status: 'all', management: 'visible', sort: 'name' }) === true
isDeviceFilterResetActive({ query: '', status: 'all', management: 'all', sort: 'snapshots' }) === true
```

- [x] **Step 2: Add failing HTML/source tests**

Expected:

```text
device-filter-reset starts disabled
aria-disabled="true"
data-active="false"
app.js exposes isDeviceFilterResetActive
app.js contains syncDeviceFilterResetState
```

- [x] **Step 3: Add failing DOM state test**

Expected:

```text
initial reset button disabled
query/status/management/sort changes enable reset button
reset click restores defaults and disables the button
fetchCount remains 1
```

- [x] **Step 4: Add failing README V0.41 tests**

Expected:

```text
# Linke V0.41
当前版本：V0.41
V0.40 historical row
disabled
aria-disabled
data-active
设备筛选重置状态
```

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`
- Modify: `README.md`
- Add: `docs/superpowers/specs/2026-07-05-device-filter-reset-state-design.md`
- Add: `docs/superpowers/plans/2026-07-05-device-filter-reset-state.md`

**Interfaces:**
- Consumes: existing `getDeviceControls()` and `renderFilteredDevices()`.
- Produces: `isDeviceFilterResetActive(controls): boolean` and reset button state sync.

- [x] **Step 1: Add pure helper**

```js
export function isDeviceFilterResetActive(controls) {
  return Boolean(String(controls?.query || '').trim())
    || (controls?.status || 'all') !== 'all'
    || (controls?.management || 'all') !== 'all'
    || (controls?.sort || 'name') !== 'name';
}
```

- [x] **Step 2: Add reset button static state**

```html
disabled aria-disabled="true" data-active="false"
```

- [x] **Step 3: Sync state in render path**

`renderFilteredDevices()` calls `syncDeviceFilterResetState(controls)` after reading controls and before rendering derived views.

- [x] **Step 4: Add disabled style**

The disabled state uses lower opacity and `not-allowed` cursor.

### Task 3: Verification

- [x] **Step 1: Run target tests**

```bash
node --test test/web-console.test.js test/readme.test.js
```

- [x] **Step 2: Run full test suite**

```bash
node --test --test-reporter=dot test/*.test.js
```

- [x] **Step 3: Run diff check**

```bash
git diff --check
```

- [x] **Step 4: Run Qwen diff review**

Check blockers for state sync, refetch, documentation, and accessibility state consistency.

- [x] **Step 5: Run HTTP smoke**

Verify `/`, `/app.js`, `/styles.css`, and `/api/devices`; downloaded resources must contain V0.41 hooks/state.

- [x] **Step 6: Run ZAI final verifier**

Use strict English evidence-only prompt if file tools remain unreliable.

- [x] **Step 7: Commit and push**

```bash
git add ...
git commit -m "feat: add device filter reset state"
git push
```
