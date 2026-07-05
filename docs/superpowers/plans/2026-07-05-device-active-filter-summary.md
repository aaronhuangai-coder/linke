# Device Active Filter Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.42 read-only device active filter summary.

**Architecture:** Keep the feature fully in the browser. Add a pure helper that formats the current device controls, then render that summary through the existing `renderFilteredDevices()` path so search, status, management, sort, bucket clicks, and reset all update one local state line.

**Tech Stack:** Node.js ESM, vanilla browser JavaScript, static HTML/CSS, `node:test`.

## Global Constraints

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.
- No new `/api/devices` refetch for local state changes.
- Preserve V0.39 `device-empty-filter-context`, V0.40 reset behavior, and V0.41 reset state.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Produces failing expectations for `buildDeviceActiveFilterSummary`, the static summary hook, DOM updates, reset behavior, and README V0.42 docs.

- [ ] **Step 1: Add failing pure-function tests**

Expected:

```js
buildDeviceActiveFilterSummary({}) === '默认筛选'
buildDeviceActiveFilterSummary({ query: '   ', status: 'all', management: 'all', sort: 'name' }) === '默认筛选'
buildDeviceActiveFilterSummary({ query: 'Beta', status: 'all', management: 'all', sort: 'name' })
  === '当前筛选: 搜索: Beta · 状态: 全部 · 管理态: 全部 · 排序: 名称'
buildDeviceActiveFilterSummary({ query: '', status: 'online', management: 'visible', sort: 'snapshots' })
  === '当前筛选: 搜索: 全部 · 状态: 在线 · 管理态: 在线可见 · 排序: 快照数'
```

- [ ] **Step 2: Add failing HTML/source tests**

Expected:

```text
HTML contains data-testid="device-active-filter-summary"
HTML contains role="status"
HTML contains aria-live="polite"
app.js exports buildDeviceActiveFilterSummary
app.js contains DEVICE_FILTER_SORT_LABELS
```

- [ ] **Step 3: Add failing DOM state test**

Expected:

```text
initial summary is 默认筛选
query/status/management/sort changes update summary text
reset click returns summary to 默认筛选
fetchCount remains 1
```

- [ ] **Step 4: Add failing README V0.42 tests**

Expected:

```text
# Linke V0.42
当前版本：V0.42
V0.41 historical row
device-active-filter-summary
当前筛选
aria-live
No API/refetch/metadata/NAS/remote changes
```

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`
- Modify: `README.md`
- Add: `docs/superpowers/specs/2026-07-05-device-active-filter-summary-design.md`
- Add: `docs/superpowers/plans/2026-07-05-device-active-filter-summary.md`

**Interfaces:**
- Consumes: existing `getDeviceControls()`, `renderFilteredDevices()`, `formatDeviceFilterValue()`, and `isDeviceFilterResetActive()`.
- Produces: `buildDeviceActiveFilterSummary(controls): string`.

- [ ] **Step 1: Add sort labels and pure helper**

```js
const DEVICE_FILTER_SORT_LABELS = {
  name: '名称',
  ip: 'IP',
  heartbeat: '最后心跳',
  snapshots: '快照数',
};

export function buildDeviceActiveFilterSummary(controls) {
  if (!isDeviceFilterResetActive(controls)) return '默认筛选';
  const query = String(controls?.query || '').trim() || '全部';
  const status = formatDeviceFilterValue(controls?.status, DEVICE_FILTER_STATUS_LABELS, 'all');
  const management = formatDeviceFilterValue(controls?.management, DEVICE_FILTER_MANAGEMENT_LABELS, 'all');
  const sort = formatDeviceFilterValue(controls?.sort, DEVICE_FILTER_SORT_LABELS, 'name');
  return '当前筛选: 搜索: ' + query + ' · 状态: ' + status + ' · 管理态: ' + management + ' · 排序: ' + sort;
}
```

- [ ] **Step 2: Add static HTML hook**

```html
<div class="device-active-filter-summary" data-testid="device-active-filter-summary" role="status" aria-live="polite">默认筛选</div>
```

- [ ] **Step 3: Sync summary in render path**

`renderFilteredDevices()` calls `renderDeviceActiveFilterSummary(controls)` after reading controls and before rendering derived views.

- [ ] **Step 4: Add compact CSS**

The summary uses compact muted text and spans the full control grid width.

### Task 3: Verification

- [ ] **Step 1: Run target tests**

```bash
node --test test/web-console.test.js test/readme.test.js
```

- [ ] **Step 2: Run full test suite**

```bash
node --test --test-reporter=dot test/*.test.js
```

- [ ] **Step 3: Run diff check**

```bash
git diff --check
```

- [ ] **Step 4: Run Qwen diff review**

Check blockers for overlap with V0.39, reset behavior, refetch, accessibility, documentation, and scope boundaries.

- [ ] **Step 5: Run HTTP smoke**

Verify `/`, `/app.js`, `/styles.css`, and `/api/devices`; downloaded resources must contain V0.42 hooks/state.

- [ ] **Step 6: Run ZAI final verifier**

Use strict English evidence-only prompt if file tools remain unreliable.

- [ ] **Step 7: Commit and push**

```bash
git add ...
git commit -m "feat: add device active filter summary"
git push
```
