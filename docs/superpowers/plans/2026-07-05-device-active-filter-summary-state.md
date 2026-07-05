# Device Active Filter Summary State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.43 state metadata for the read-only device active filter summary.

**Architecture:** Keep the feature fully in the browser. Add a pure state helper that composes the existing V0.42 text helper, then sync `textContent` and `data-active` through the existing `renderFilteredDevices()` path.

**Tech Stack:** Node.js ESM, vanilla browser JavaScript, static HTML/CSS, `node:test`.

## Global Constraints

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.
- No new `/api/devices` refetch for local state changes.
- Preserve V0.39 `device-empty-filter-context`, V0.40 reset behavior, V0.41 reset state, and V0.42 visible summary text.
- Do not add `aria-label` to `device-active-filter-summary` in V0.43.
- Do not use a bare `[data-active="true"]` CSS selector.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Produces failing expectations for `buildDeviceActiveFilterSummaryState`, static summary state markup, DOM state transitions, scoped CSS contract, and README V0.43 docs.

- [x] **Step 1: Add failing pure-function tests**

Expected:

```js
buildDeviceActiveFilterSummaryState({}) === {
  text: '默认筛选',
  active: false,
}

buildDeviceActiveFilterSummaryState({ query: 'Beta', status: 'online', management: 'visible', sort: 'snapshots' }) === {
  text: '当前筛选: 搜索: Beta · 状态: 在线 · 管理态: 在线可见 · 排序: 快照数',
  active: true,
}

buildDeviceActiveFilterSummaryState(activeControls).text === buildDeviceActiveFilterSummary(activeControls)
```

- [x] **Step 2: Add failing HTML/source tests**

Expected:

```text
HTML summary has data-active="false"
HTML summary has aria-atomic="true"
HTML summary still has role="status"
HTML summary still has aria-live="polite"
HTML summary does not have aria-label
app.js exports buildDeviceActiveFilterSummaryState
styles.css contains .device-active-filter-summary[data-active="true"]
styles.css does not contain a bare [data-active="true"] selector
```

- [x] **Step 3: Add failing DOM state test**

Expected:

```text
initial text is 默认筛选
initial data-active is false
query/status/management/sort changes set data-active true while preserving visible text format
reset returns text to 默认筛选 and data-active false
fetchCount remains 1
```

- [x] **Step 4: Add failing README V0.43 tests**

Expected:

```text
# Linke V0.43
当前版本：V0.43
V0.42 historical row
设备筛选摘要状态
device-active-filter-summary
data-active
aria-atomic
No API/refetch/metadata/NAS/remote changes
```

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`
- Modify: `README.md`
- Add: `docs/superpowers/specs/2026-07-05-device-active-filter-summary-state-design.md`
- Add: `docs/superpowers/plans/2026-07-05-device-active-filter-summary-state.md`

**Interfaces:**
- Consumes: existing `buildDeviceActiveFilterSummary(controls)` and `isDeviceFilterResetActive(controls)`.
- Produces: `buildDeviceActiveFilterSummaryState(controls): { text: string, active: boolean }`.

- [x] **Step 1: Add pure state helper**

```js
export function buildDeviceActiveFilterSummaryState(controls) {
  return {
    text: buildDeviceActiveFilterSummary(controls),
    active: isDeviceFilterResetActive(controls),
  };
}
```

- [x] **Step 2: Add static HTML state**

```html
<div class="device-active-filter-summary" data-testid="device-active-filter-summary" role="status" aria-live="polite" aria-atomic="true" data-active="false">默认筛选</div>
```

- [x] **Step 3: Sync state in render path**

`renderDeviceActiveFilterSummary(controls)` calls `buildDeviceActiveFilterSummaryState(controls)`, assigns `textContent`, and sets `data-active` to `true` or `false`.

- [x] **Step 4: Add scoped active CSS**

```css
.device-active-filter-summary[data-active="true"] {
  color: #374151;
  font-weight: 600;
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

Check blockers for helper duplication, aria-label omission, scoped CSS, reset behavior, refetch, documentation, and scope boundaries.

- [x] **Step 5: Run HTTP smoke**

Verify `/`, `/app.js`, `/styles.css`, and `/api/devices`; downloaded resources must contain V0.43 hooks/state.

- [x] **Step 6: Run ZAI final verifier**

Use strict English evidence-only prompt. If ZAI repeats the V0.42 invalid fallback phrase, record `INCONCLUSIVE` and do not use it as acceptance evidence.

Verification notes:
- PM target tests: `node --test test/web-console.test.js test/readme.test.js` passed with 384 passing tests.
- PM full suite: `node --test --test-reporter=dot test/*.test.js` exited 0.
- PM diff check: `git diff --check` exited 0.
- Qwen read-only adversarial review returned `PASS` with no blockers.
- HTTP smoke on `127.0.0.1:3010` verified `/`, `/app.js`, `/styles.css`, and `/api/devices`; `/api/devices` returned `[]`.
- ZAI first direct verifier attempt returned `INCONCLUSIVE` because its file-view tool failed; second evidence-consistency prompt returned `ACCEPT`. ZAI was not used as primary fact evidence.

- [x] **Step 7: Commit and push**

```bash
git add ...
git commit -m "feat: add device active filter summary state"
git push
```
