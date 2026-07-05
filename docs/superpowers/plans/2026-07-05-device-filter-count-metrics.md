# Device Filter Count Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.45 read-only metrics on the Web Console `device-filter-count`.

**Architecture:** Keep the feature fully in the browser. Extend the existing count state helper to expose normalized numeric values, then sync the existing visible text plus `data-filtered`, `data-visible-count`, and `data-total-count` through the current render path.

**Tech Stack:** Node.js ESM, vanilla browser JavaScript, static HTML, `node:test`.

## Global Constraints

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.
- No new `/api/devices` refetch for local count state changes.
- Preserve V0.40 reset behavior, V0.41 reset state, V0.42 visible summary text, V0.43 summary state, and V0.44 `data-filtered` behavior.
- Do not add `aria-live` to `device-filter-count`.
- Do not change the visible count text format from `"<visible> / <total>"`.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Produces failing expectations for `buildDeviceFilterCountState()`, static `device-filter-count` markup, DOM count transitions, and README V0.45 docs.

- [x] **Step 1: Update pure-function expectations**

Change the existing count state test to expect normalized count metrics:

```js
assert.deepStrictEqual(buildDeviceFilterCountState(3, 3), {
  text: '3 / 3',
  filtered: false,
  visible: 3,
  total: 3,
});
assert.deepStrictEqual(buildDeviceFilterCountState(1, 3), {
  text: '1 / 3',
  filtered: true,
  visible: 1,
  total: 3,
});
assert.deepStrictEqual(buildDeviceFilterCountState(NaN, 3), {
  text: '0 / 3',
  filtered: true,
  visible: 0,
  total: 3,
});
assert.deepStrictEqual(buildDeviceFilterCountState(3, Infinity), {
  text: '3 / 0',
  filtered: false,
  visible: 3,
  total: 0,
});
assert.deepStrictEqual(buildDeviceFilterCountState(undefined, null), {
  text: '0 / 0',
  filtered: false,
  visible: 0,
  total: 0,
});
assert.deepStrictEqual(buildDeviceFilterCountState("foo", "bar"), {
  text: '0 / 0',
  filtered: false,
  visible: 0,
  total: 0,
});
```

Keep the existing `(0, 0)` assertion and add the same `visible: 0, total: 0` fields to it.

- [x] **Step 2: Update static HTML test**

The targeted `device-filter-count` tag must include all initial attributes:

```js
assert.ok(tag.includes('data-filtered="false"'));
assert.ok(tag.includes('data-visible-count="0"'));
assert.ok(tag.includes('data-total-count="0"'));
assert.ok(!tag.includes('aria-live'));
```

- [x] **Step 3: Update DOM transition test**

Extend the existing V0.44 DOM test so each transition checks text and attributes:

```js
assert.strictEqual(countEl.textContent, '2 / 2');
assert.strictEqual(countEl.getAttribute('data-filtered'), 'false');
assert.strictEqual(countEl.getAttribute('data-visible-count'), '2');
assert.strictEqual(countEl.getAttribute('data-total-count'), '2');
```

Rename the describe block to V0.45 and check all four values after each transition:

```text
initial: text 2 / 2, data-filtered false, data-visible-count 2, data-total-count 2
search Beta: text 1 / 2, data-filtered true, data-visible-count 1, data-total-count 2
reset after search: text 2 / 2, data-filtered false, data-visible-count 2, data-total-count 2
status unknown: text 0 / 2, data-filtered true, data-visible-count 0, data-total-count 2
reset after status: text 2 / 2, data-filtered false, data-visible-count 2, data-total-count 2
management missing-ip: text 1 / 2, data-filtered true, data-visible-count 1, data-total-count 2
reset after management: text 2 / 2, data-filtered false, data-visible-count 2, data-total-count 2
fetchCount: 1
```

- [x] **Step 4: Update README V0.45 tests**

Add a new top-level mention test after the existing V0.44 mention test:

```js
it('mentions V0.45 (device filter count metrics)', () => {
  assertReadmeContains(/V0\.45/, 'V0.45');
});
```

Update the V0.44 README describe block so it no longer expects current-version status:

```js
it('version table has V0.44 historical row', () => {
  assert.match(readme, /\| V0\.44 \| (历史版本|设备筛选计数状态|[^|]*) \|[^|]*(设备筛选计数状态|device-filter-count-state|device-filter-count)/i);
});
```

Add a new V0.45 README describe block with these signals:

```text
# Linke V0.45
当前版本：V0.45
V0.45 current row
设备筛选计数指标
device-filter-count
data-visible-count
data-total-count
No API/refetch/metadata/NAS/remote changes
测试覆盖：.*设备筛选计数指标
```

- [x] **Step 5: Verify RED**

Run:

```bash
node --test test/web-console.test.js test/readme.test.js
```

Expected: FAIL because `buildDeviceFilterCountState()` and static/rendered markup do not yet expose `visible`, `total`, `data-visible-count`, or `data-total-count`.

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/index.html`
- Modify: `README.md`

**Interfaces:**
- Produces: `buildDeviceFilterCountState(visibleCount, totalCount): { text: string, filtered: boolean, visible: number, total: number }`.

- [x] **Step 1: Extend pure count state helper**

Replace the helper return value with:

```js
return {
  text: String(visible) + ' / ' + String(total),
  filtered: total > 0 && visible < total,
  visible,
  total,
};
```

- [x] **Step 2: Extend static HTML state**

Update the count element:

```html
<span class="device-filter-count" data-testid="device-filter-count" data-filtered="false" data-visible-count="0" data-total-count="0">0 / 0</span>
```

- [x] **Step 3: Sync metrics in render path**

Update `renderDeviceFilterCount(visibleCount, totalCount)` so it assigns the new attributes from the state object:

```js
deviceFilterCountEl.textContent = state.text;
deviceFilterCountEl.setAttribute('data-filtered', state.filtered ? 'true' : 'false');
deviceFilterCountEl.setAttribute('data-visible-count', String(state.visible));
deviceFilterCountEl.setAttribute('data-total-count', String(state.total));
```

- [x] **Step 4: Update README**

Move V0.44 to historical status, add V0.45 as current, and document that the feature is read-only metadata with no API, refetch, metadata, NAS, or remote side effects.

- [x] **Step 5: Verify GREEN**

Run:

```bash
node --test test/web-console.test.js test/readme.test.js
```

Expected: PASS.

### Task 3: Verification

- [x] **Step 1: Run full suite**

```bash
node --test --test-reporter=dot test/*.test.js
```

- [x] **Step 2: Run diff check**

```bash
git diff --check
```

- [x] **Step 3: Run Qwen diff review**

Ask Qwen to check blockers for count text drift, duplicate live-region risk, normalized metrics, reset behavior, refetch, documentation, and scope boundaries.

- [x] **Step 4: Run HTTP smoke**

Verify `/`, `/app.js`, and `/api/devices` on a local server. `/` must contain `data-visible-count="0"` and `data-total-count="0"`, `/app.js` must contain the helper and render attributes, and `/api/devices` must return JSON.

- [x] **Step 5: Run ZAI final verifier**

Use a strict English evidence-only prompt. If ZAI returns tool errors, empty output, missing status fields, or `I don't have a specific response`, record `INCONCLUSIVE` and do not use it as primary acceptance evidence.

- [x] **Step 6: Commit and push**

```bash
git add README.md src/web/app.js src/web/index.html test/web-console.test.js test/readme.test.js docs/superpowers/specs/2026-07-05-device-filter-count-metrics-design.md docs/superpowers/plans/2026-07-05-device-filter-count-metrics.md
git commit -m "feat: add device filter count metrics"
git push
```

Verification notes:
- PM observed RED first: `node --test test/web-console.test.js test/readme.test.js` failed because V0.45 README docs, static `data-visible-count` / `data-total-count`, helper `visible` / `total`, and rendered DOM attributes were not implemented yet.
- AGY implemented GREEN changes in `README.md`, `src/web/app.js`, `src/web/index.html`, `test/web-console.test.js`, and `test/readme.test.js`; PM added one README feature-list assertion and corresponding README text after diff review.
- PM target tests: `node --test test/web-console.test.js test/readme.test.js` passed with 399 tests.
- PM full suite: `node --test --test-reporter=dot test/*.test.js` exited 0.
- PM diff check: `git diff --check` exited 0.
- HTTP smoke on `127.0.0.1:3010` verified `/`, `/app.js`, and `/api/devices`; smoke assertions passed for `data-visible-count`, `data-total-count`, no `aria-live` on `device-filter-count`, helper/render hooks, and JSON device array.
- Qwen diff review returned `DONE`; only minor residual risk was an untested `visible > total` pure-helper case, which PM classified as non-blocking because the production render path derives both numbers from the same filtered device array.
- ZAI final verifier was attempted twice. Both responses failed the required schema and returned the invalid fallback phrase, so ZAI evidence is recorded as `INCONCLUSIVE` and is not used as primary acceptance evidence.
