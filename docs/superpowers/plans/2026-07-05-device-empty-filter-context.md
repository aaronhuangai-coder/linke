# Device Empty Filter Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.39 read-only device-list empty-state context for active search, status, and management filters.

**Architecture:** Keep all behavior in the browser Web Console. Build the context with a pure exported helper, pass current controls explicitly through the render pipeline, and render empty-state DOM with `textContent`.

**Tech Stack:** Node.js ESM, vanilla browser JavaScript, static HTML/CSS, `node:test`.

## Global Constraints

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.
- No new `/api/devices` refetch for local rendering.
- Preserve V0.33-V0.38 management-state labels, filtering, summary buttons, active state, scoped counts, and hints.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Produces failing expectations for `buildDeviceEmptyFilterContext(controls)`, `device-empty-state`, `device-empty-filter-context`, and README V0.39 docs.

- [x] **Step 1: Add failing pure-function tests**

Expected default output:

```js
assert.strictEqual(
  buildDeviceEmptyFilterContext({}),
  '搜索: 全部 · 状态: 全部 · 管理态: 全部'
);
```

Expected mapped output:

```js
assert.strictEqual(
  buildDeviceEmptyFilterContext({ query: 'Beta', status: 'online', management: 'visible' }),
  '搜索: Beta · 状态: 在线 · 管理态: 在线可见'
);
```

- [x] **Step 2: Add failing DOM test**

Expected hooks:

```text
data-testid="device-empty-state"
data-testid="device-empty-filter-context"
```

Expected no local filter refetch:

```text
fetchCount === 1
```

- [x] **Step 3: Add failing README V0.39 tests**

Expected docs:

```text
# Linke V0.39
当前版本：V0.39
设备列表空态筛选上下文
device-empty-state
device-empty-filter-context
```

- [x] **Step 4: Run target tests and confirm RED**

Run:

```bash
node --test test/web-console.test.js test/readme.test.js
```

Observed: FAIL because `buildDeviceEmptyFilterContext` was not exported and README still documented V0.38 as current.

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Modify: `README.md`
- Add: `docs/superpowers/specs/2026-07-05-device-empty-filter-context-design.md`
- Add: `docs/superpowers/plans/2026-07-05-device-empty-filter-context.md`

**Interfaces:**
- Consumes: current device controls from `getDeviceControls()`.
- Produces: `buildDeviceEmptyFilterContext(controls): string`, list empty-state DOM hooks, README V0.39 docs.

- [x] **Step 1: Add filter label maps and pure helper**

Implementation expectations:

```text
query empty -> 全部
status online -> 在线
management visible -> 在线可见
```

- [x] **Step 2: Pass controls explicitly**

`renderFilteredDevices()` computes controls once and passes them into `renderDevices(visibleDevices, controls)`.

- [x] **Step 3: Render empty-state DOM with textContent**

The empty row uses:

```text
className = "placeholder"
data-testid = "device-empty-state"
child data-testid = "device-empty-filter-context"
```

- [x] **Step 4: Update README and docs**

README V0.39 documents behavior, DOM hooks, and safety boundaries.

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

- [x] **Step 4: Run HTTP smoke**

Start a localhost server on a free port and verify:

```text
/
/app.js
/styles.css
/api/devices
```

- [x] **Step 5: Run ZAI final verifier**

Use a strict English prompt with objective, project path, read-only boundaries, exact files, PM evidence, fixed verdict schema, and explicit ban on empty fallback phrases.

Observed:

```text
Qwen read-only adversary: DONE / PASS / no blocking issues
ZAI first attempt: invalid because internal file tool failed and output violated schema
ZAI second evidence-only attempt: PASS / ACCEPT
```

- [ ] **Step 6: Commit and push**

```bash
git add ...
git commit -m "feat: add device empty filter context"
git push
```
