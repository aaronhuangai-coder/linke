# Device Filter Reset Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.40 Web Console device filter reset button.

**Architecture:** Add one browser-only reset button to the existing device controls. The click handler resets existing DOM control values and calls the existing local render path once, preserving the cached `/api/devices` data flow and all existing derived views.

**Tech Stack:** Node.js ESM, vanilla browser JavaScript, static HTML/CSS, `node:test`.

## Global Constraints

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.
- No new `/api/devices` refetch for local reset.
- Preserve V0.16-V0.39 device list controls, management filters, summary active state, scoped counts, hints, and empty filter context.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: existing device control IDs `device-search`, `device-status-filter`, `device-management-filter`, `device-sort`.
- Produces: failing expectations for `device-filter-reset`, reset behavior, no refetch, and README V0.40 docs.

- [x] **Step 1: Add failing HTML/source contract tests**

Expected HTML contract:

```text
id="device-filter-reset"
data-testid="device-filter-reset"
重置筛选
```

Expected JS source contract:

```text
device-filter-reset
```

- [x] **Step 2: Add failing DOM behavior test**

Scenario:

```text
Initial local devices: 4
Set query = Beta
Set status = online
Set management = visible
Set sort = ip
Trigger local filtering
Expected visible count: 0 / 4
Click device-filter-reset
Expected query = empty string
Expected status = all
Expected management = all
Expected sort = name
Expected visible count: 4 / 4
Expected list rows: 4
Expected management all bucket active
Expected visible bucket inactive
Expected fetchCount remains 1
```

- [x] **Step 3: Add failing README V0.40 tests**

Expected docs:

```text
# Linke V0.40
当前版本：V0.40
V0.39 historical row
V0.40 current row
设备筛选重置
device-filter-reset
不重新请求 /api/devices
```

- [x] **Step 4: Run target tests and confirm RED**

Run:

```bash
node --test test/web-console.test.js test/readme.test.js
```

Expected: FAIL before implementation because the button, handler, and README V0.40 docs do not exist.

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Modify: `README.md`
- Add: `docs/superpowers/specs/2026-07-05-device-filter-reset-design.md`
- Add: `docs/superpowers/plans/2026-07-05-device-filter-reset.md`

**Interfaces:**
- Consumes: existing `renderFilteredDevices()` inside `initConsole`.
- Produces: `device-filter-reset` button and click behavior.

- [x] **Step 1: Add reset button**

Add to the device controls block:

```html
<button id="device-filter-reset" data-testid="device-filter-reset" type="button" class="device-filter-reset">重置筛选</button>
```

- [x] **Step 2: Bind reset handler**

Implementation behavior:

```js
if (deviceFilterResetButton?.addEventListener) {
  deviceFilterResetButton.addEventListener('click', function () {
    if (deviceSearchInput) deviceSearchInput.value = '';
    if (deviceStatusFilter) deviceStatusFilter.value = 'all';
    if (deviceManagementFilter) deviceManagementFilter.value = 'all';
    if (deviceSortSelect) deviceSortSelect.value = 'name';
    renderFilteredDevices();
  });
}
```

- [x] **Step 3: Add small button style**

The reset button stays in the device controls area, visually secondary, and does not use destructive styling.

- [x] **Step 4: Update README and docs**

README V0.40 documents the current version, behavior, DOM hook, safety boundaries, feature bullet, combined Web Console list, and testing coverage.

### Task 3: Verification

- [x] **Step 1: AGY implementer run**

Observed:

```text
AGY completed after a long silent run and returned status success with changed files.
```

PM verification remains mandatory.

- [x] **Step 2: Run target tests**

```bash
node --test test/web-console.test.js test/readme.test.js
```

- [x] **Step 3: Run full test suite**

```bash
node --test --test-reporter=dot test/*.test.js
```

- [x] **Step 4: Run diff check**

```bash
git diff --check
```

- [x] **Step 5: Run Qwen or PM adversarial review**

Qwen V0.40 design adversary first produced no stdout for the waiting budget. A second shorter read-only diff prompt returned:

```text
Status: PASS
Blockers: None
Concerns: None
Verdict: PASS
```

PM adversarial review also checked:

```text
No API change
No /api/devices refetch
No metadata write
Reset updates all four controls
Summary active state follows management all
README V0.40 and V0.39 history are correct
```

- [x] **Step 6: Run HTTP smoke**

Start a localhost server on a free port and verify:

```text
/
/app.js
/styles.css
/api/devices
```

Then verify downloaded HTML/JS/CSS contain:

```text
device-filter-reset
重置筛选
```

- [x] **Step 7: Run ZAI final verifier**

Use strict English evidence-only prompt if ZAI file tools fail again.

Observed:

```text
ZAI evidence-only verifier: PASS / ACCEPT
```

- [x] **Step 8: Commit and push**

```bash
git add ...
git commit -m "feat: add device filter reset"
git push
```
