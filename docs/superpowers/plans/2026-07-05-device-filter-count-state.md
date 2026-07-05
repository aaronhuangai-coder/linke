# Device Filter Count State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.44 state metadata for the read-only device filter count.

**Architecture:** Keep the feature fully in the browser. Add a pure state helper for the count text and filtered state, then sync `textContent` and `data-filtered` through the existing `renderFilteredDevices()` path.

**Tech Stack:** Node.js ESM, vanilla browser JavaScript, static HTML/CSS, `node:test`.

## Global Constraints

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.
- No new `/api/devices` refetch for local count state changes.
- Preserve V0.40 reset behavior, V0.41 reset state, V0.42 visible summary text, and V0.43 summary state.
- Do not add a second live region to `device-filter-count`.
- Do not use a bare `[data-filtered="true"]` CSS selector.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Produces failing expectations for `buildDeviceFilterCountState`, static count state markup, DOM state transitions, scoped CSS contract, and README V0.44 docs.

- [x] **Step 1: Add failing pure-function tests**

Expected:

```js
buildDeviceFilterCountState(3, 3) === {
  text: '3 / 3',
  filtered: false,
}

buildDeviceFilterCountState(1, 3) === {
  text: '1 / 3',
  filtered: true,
}

buildDeviceFilterCountState(0, 0) === {
  text: '0 / 0',
  filtered: false,
}
```

- [x] **Step 2: Add failing HTML/source tests**

Expected:

```text
HTML device-filter-count has data-filtered="false"
HTML device-filter-count does not have aria-live
app.js exports buildDeviceFilterCountState
styles.css contains .device-filter-count[data-filtered="true"]
styles.css does not contain a bare [data-filtered="true"] selector
```

The HTML assertion must match the exact `device-filter-count` element before checking `data-filtered`; a broad page-level `includes('data-filtered="false"')` is not sufficient.

- [x] **Step 3: Add failing DOM state test**

Expected:

```text
initial text is 2 / 2
initial data-filtered is false
search/status/management changes can set data-filtered true while updating visible count
reset returns count to total and data-filtered false
fetchCount remains 1
```

- [x] **Step 4: Add failing README V0.44 tests**

Expected:

```text
# Linke V0.44
当前版本：V0.44
V0.43 historical row
V0.44 current row
设备筛选计数状态
device-filter-count
data-filtered
No API/refetch/metadata/NAS/remote changes
```

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`
- Modify: `README.md`
- Add: `docs/superpowers/specs/2026-07-05-device-filter-count-state-design.md`
- Add: `docs/superpowers/plans/2026-07-05-device-filter-count-state.md`

**Interfaces:**
- Produces: `buildDeviceFilterCountState(visibleCount, totalCount): { text: string, filtered: boolean }`.

- [x] **Step 1: Add pure count state helper**

```js
export function buildDeviceFilterCountState(visibleCount, totalCount) {
  const visible = Number.isFinite(Number(visibleCount)) ? Number(visibleCount) : 0;
  const total = Number.isFinite(Number(totalCount)) ? Number(totalCount) : 0;
  return {
    text: String(visible) + ' / ' + String(total),
    filtered: total > 0 && visible < total,
  };
}
```

- [x] **Step 2: Add static HTML state**

```html
<span class="device-filter-count" data-testid="device-filter-count" data-filtered="false">0 / 0</span>
```

- [x] **Step 3: Sync state in render path**

`renderDeviceFilterCount(visibleCount, totalCount)` calls `buildDeviceFilterCountState(visibleCount, totalCount)`, assigns `textContent`, and sets `data-filtered` to `true` or `false`.

- [x] **Step 4: Add scoped filtered CSS**

```css
.device-filter-count[data-filtered="true"] {
  color: #374151;
}
```

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

Check blockers for count text/state drift, duplicate live-region risk, scoped CSS, reset behavior, refetch, documentation, and scope boundaries.

- [x] **Step 5: Run HTTP smoke**

Verify `/`, `/app.js`, `/styles.css`, and `/api/devices`; downloaded resources must contain V0.44 hooks/state.

- [x] **Step 6: Run ZAI final verifier**

Use strict English evidence-only prompt. If ZAI returns tool errors, empty output, or the invalid fallback phrase, record `INCONCLUSIVE` and do not use it as primary acceptance evidence.

Verification notes:
- PM target tests: `node --test test/web-console.test.js test/readme.test.js` passed with 393 passing tests.
- PM full suite: `node --test --test-reporter=dot test/*.test.js` exited 0.
- PM diff check: `git diff --check` exited 0.
- Qwen implementation review returned `PASS` with no blockers.
- Qwen re-review returned `PASS` after PM strengthened the DOM test to cover search, status, management, reset, and no refetch.
- HTTP smoke on `127.0.0.1:3010` verified `/`, `/app.js`, `/styles.css`, and `/api/devices`; `/api/devices` returned `[]`.
- ZAI evidence-consistency verifier returned `ACCEPT`; PM did not use ZAI as primary fact evidence.

- [x] **Step 7: Commit and push**

```bash
git add ...
git commit -m "feat: add device filter count state"
git push
```
