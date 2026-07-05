# Device Management State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.33 device and IP address "Unified Management State" (统一管理态) in the Web Console.

**Architecture:** Pure UI-only derived state logic in `src/web/app.js` using `getDeviceManagementState(device)`. Render derived states in the device list items and the device detail view, utilizing stable test hooks (`device-management-state` and `device-detail-management-state`). Maintain strict read-only boundaries: no backend changes, no database writes, no NAS connections, no commands, and no edit/fix operations.

**Tech Stack:** Node.js ESM, browser ESM, built-in `node:test`, zero external runtime dependencies.

## Global Constraints & Boundaries

- **Strict Read-Only Boundary**:
  - No new backend APIs.
  - No metadata write.
  - No remote command execution (no ping, wake, shell scripts).
  - No NAS connection setup.
  - No edit/fix/bulk actions (missing IPs are not corrected/configured via any UI interaction).
- Missing/unknown statuses/IPs must use derived fallback states:
  - `online` + valid IP => `在线可见`
  - `online` + empty/whitespace/null/unknown IP after trim/lowercase normalization => `在线缺 IP`
  - `offline` => `离线保留`
  - Any other status or null device => `未知待确认`
- Use `npm test` as the verification command.

---

### Task 1: README, test/readme.test.js and test/web-console.test.js RED State setup

**Files:**
- Modify: `test/readme.test.js` (Completed)
- Modify: `test/web-console.test.js` (Completed)
- Modify: `docs/superpowers/specs/2026-07-05-device-management-state-design.md` (Completed)
- Modify: `docs/superpowers/plans/2026-07-05-device-management-state.md` (This file)

- [x] **Step 1: Write RED tests in `test/readme.test.js` expecting V0.33 documentation elements.**
- [x] **Step 2: Write RED tests in `test/web-console.test.js` for contract import, pure function behavior, and DOM elements.**
- [x] **Step 3: Run `npm test` to verify all V0.33 tests fail as expected.**

---

### Task 2: Implement getDeviceManagementState and DOM Rendering (Completed)

Files:
- Modify: `src/web/app.js` (Completed)
- Modify: `src/web/index.html` (Completed)
- Modify: `README.md` (Completed)

- [x] **Step 1: Implement getDeviceManagementState pure function in `src/web/app.js`**

Implement and export:
```javascript
export function getDeviceManagementState(device) {
  if (!device) return '未知待确认';
  const status = normalizeDeviceStatus(device.status);
  const rawIp = device.ipAddress === null || device.ipAddress === undefined ? '' : device.ipAddress;
  const ip = String(rawIp).trim().toLowerCase();
  
  if (status === 'online') {
    if (ip === '' || ip === 'unknown') {
      return '在线缺 IP';
    }
    return '在线可见';
  } else if (status === 'offline') {
    return '离线保留';
  } else {
    return '未知待确认';
  }
}
```

- [x] **Step 2: Add DOM hooks to `src/web/index.html`**

Update `device-detail-panel` in `src/web/index.html` to include a row for the management state:
```html
<div class="device-detail-row">
  <dt>管理状态</dt>
  <dd data-testid="device-detail-management-state">未知待确认</dd>
</div>
```

- [x] **Step 3: Update `renderDevices` and `renderDeviceDetail` in `src/web/app.js`**

In `renderDevices`, append a span element for management state in the list item:
```javascript
const stateBadge = doc.createElement('span');
stateBadge.className = 'management-state-badge';
stateBadge.setAttribute('data-testid', 'device-management-state');
stateBadge.textContent = getDeviceManagementState(device);
li.appendChild(stateBadge);
```

In `renderDeviceDetail`, populate the management state value:
```javascript
appendDeviceDetailRow(grid, 'device-detail-management-state', '管理状态', getDeviceManagementState(device));
```

- [x] **Step 4: Update README.md to V0.33**

- Bump version badge and title to V0.33.
- Move V0.32 to historical list.
- Document "统一管理态" features, safety guidelines, and test cases.

- [x] **Step 5: Run `npm test` and verify GREEN status**
