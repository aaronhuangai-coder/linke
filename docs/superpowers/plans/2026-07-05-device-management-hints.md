# Device Management Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.38 read-only management-state decision hints to device list rows and selected device details.

**Architecture:** Reuse the existing `getDeviceManagementStateKey(device)` classifier and add a small exported mapping helper. Render hint text in the existing browser-only Web Console DOM without new API calls or persistence.

**Tech Stack:** Node.js ESM, vanilla browser JavaScript, static HTML/CSS, `node:test`.

## Global Constraints

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.
- No new `/api/devices` refetch for local rendering.
- Preserve V0.33-V0.37 management-state labels, filtering, summary buttons, active state, and scoped counts.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: existing `getDeviceManagementStateKey(device)` and DOM mock helpers.
- Produces: failing expectations for `getDeviceManagementHint(device)`, `device-management-hint`, `device-detail-management-hint`, and README V0.38 docs.

- [x] **Step 1: Add failing pure-function tests**

Expected mapping:

```js
assert.strictEqual(getDeviceManagementHint({ status: 'online', ipAddress: '192.168.1.100' }), '在线且 IP 可用，可纳入统一管理');
assert.strictEqual(getDeviceManagementHint({ status: 'online', ipAddress: '' }), '设备在线但缺少可用 IP，需补充 IP 信息');
assert.strictEqual(getDeviceManagementHint({ status: 'offline', ipAddress: '192.168.1.100' }), '设备离线，保留历史记录和备份上下文');
assert.strictEqual(getDeviceManagementHint(null), '状态未知，需确认设备心跳');
```

- [x] **Step 2: Add failing DOM tests**

Expected hooks:

```text
data-testid="device-management-hint"
data-testid="device-detail-management-hint"
```

- [x] **Step 3: Add failing README V0.38 tests**

Expected docs:

```text
# Linke V0.38
当前版本：V0.38
管理态判定提示
device-management-hint
device-detail-management-hint
```

- [x] **Step 4: Run target tests and confirm RED**

Run:

```bash
node --test test/web-console.test.js test/readme.test.js
```

Expected: FAIL because `getDeviceManagementHint` and README V0.38 docs do not exist yet.

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/web/app.js`
- Modify: `README.md`
- Add: `docs/superpowers/specs/2026-07-05-device-management-hints-design.md`
- Add: `docs/superpowers/plans/2026-07-05-device-management-hints.md`

**Interfaces:**
- Consumes: `getDeviceManagementStateKey(device)`.
- Produces: `getDeviceManagementHint(device): string`, list/detail DOM hooks, README V0.38 docs.

- [x] **Step 1: Add `MANAGEMENT_STATE_HINTS` and `getDeviceManagementHint`**

Implementation:

```js
const MANAGEMENT_STATE_HINTS = {
  'visible': '在线且 IP 可用，可纳入统一管理',
  'missing-ip': '设备在线但缺少可用 IP，需补充 IP 信息',
  'offline-retained': '设备离线，保留历史记录和备份上下文',
  'unknown': '状态未知，需确认设备心跳',
};

export function getDeviceManagementHint(device) {
  const key = getDeviceManagementStateKey(device);
  return MANAGEMENT_STATE_HINTS[key] || MANAGEMENT_STATE_HINTS.unknown;
}
```

- [x] **Step 2: Render list hints**

Create a `span` with:

```text
className = "device-management-hint"
data-testid = "device-management-hint"
textContent = getDeviceManagementHint(device)
```

- [x] **Step 3: Render detail hints**

Add a detail row:

```js
appendDeviceDetailRow(grid, 'device-detail-management-hint', '管理提示', getDeviceManagementHint(device));
```

- [x] **Step 4: Update README to V0.38**

Required content:

```text
# Linke V0.38
当前版本：V0.38
| V0.37 | 管理态分桶作用域 | ... |
| V0.38 | 当前版本 | 管理态判定提示：设备列表与详情展示只读处理提示 |
```

- [x] **Step 5: Run target tests, full tests, diff check, and HTTP smoke**

Commands:

```bash
node --test test/web-console.test.js test/readme.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
```

HTTP smoke uses a local read-only server and checks `/`, `/app.js`, `/styles.css`, and `/api/devices`.

- [x] **Step 6: Run final verifier**

Expected: structured verifier `PASS` or a blocking finding that must be resolved before commit.
