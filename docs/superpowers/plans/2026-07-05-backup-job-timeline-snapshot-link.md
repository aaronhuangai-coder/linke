# Linke V0.19 Backup Job Timeline Snapshot Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Web Console interaction where clicking a backup-job timeline snapshot row reuses the existing snapshot manifest detail and restore dry-run panels.

**Architecture:** Keep V0.19 frontend-only. Add a small shared snapshot-selection helper inside `src/web/app.js`, reuse the existing manifest and restore dry-run fetchers, and make V0.18 timeline rows selectable without adding any API route or write path.

**Tech Stack:** Node.js ESM, browser ESM, built-in `node:test`, existing mock DOM utilities in `test/web-console.test.js`, no new dependencies.

## Global Constraints

- Only modify `src/web/app.js`, `src/web/styles.css`, `test/web-console.test.js`, `test/readme.test.js`, `README.md`, and this V0.19 plan/spec area.
- Do not add backend routes.
- Do not call `POST /api/backups`.
- Do not call `POST /api/restore`.
- Do not call `POST /api/nas-dry-run`.
- Do not write metadata.
- Do not create, restore, delete, overwrite, copy, or transfer files.
- Do not connect to NAS or call NAS apps.
- Do not read or output `.env`, token, API key, SSH key, or credential files.
- Worker must not commit. Commit/push remain PM/user hard gates.

---

## File Structure

- `src/web/app.js`
  - Owns Web Console state and DOM event wiring.
  - Add `selectSnapshotForDetail(deviceId, snapshotId)` helper.
  - Reuse existing `fetchSnapshotManifest()` and `fetchRestoreDryRunPlan()`.
  - Add click handling and selected state for `backup-job-timeline-item`.

- `src/web/styles.css`
  - Add pointer and selected visual state for timeline rows.
  - Keep styling clearly read-only; no action-button affordance.

- `test/web-console.test.js`
  - Add source-contract assertions for the new helper and timeline row data binding.
  - Add DOM interaction tests for clicking a timeline snapshot row.
  - Add stale-state clearing test for device switching after timeline selection.

- `test/readme.test.js`
  - Move current-version documentation assertions from V0.18 to V0.19.
  - Add V0.19 tests for read-only timeline snapshot linking.

- `README.md`
  - Update current version from V0.18 to V0.19.
  - Add V0.19 row and feature text.
  - Update V0.18 row to historical milestone.
  - Document that timeline row clicks load manifest detail and restore dry-run only.

---

### Task 1: Web Console Red Tests For Timeline Snapshot Selection

**Files:**
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: current `initConsole(doc, fetchImpl, intervalImpl)` behavior.
- Produces: failing tests that require `backup-job-timeline-item` rows to carry `data-snapshot-id`, become clickable, call existing manifest/restore dry-run endpoints, and render selected state.

- [ ] **Step 1: Add source contract assertions**

In the existing test `app.js wires backup job detail timeline into snapshot loading`, extend the assertions:

```js
assert.ok(js.includes('selectSnapshotForDetail'), 'app.js must share snapshot detail selection logic');
assert.ok(js.includes('dataset.snapshotId'), 'timeline rows must store snapshot id for selection');
```

- [ ] **Step 2: Add failing DOM test for clicking a backup job timeline snapshot**

Add this test inside `describe('initConsole DOM data-testid hooks', ...)`, near the existing V0.18 backup job detail tests:

```js
it('clicking a backup job timeline snapshot loads manifest detail and restore dry-run', async () => {
  const doc = buildMockDoc();
  const calls = [];
  const devices = [
    {
      deviceId: 'd5',
      hostname: 'host-five',
      status: 'online',
      ipAddress: '10.0.0.5',
      snapshotCount: 2,
      lastHeartbeatAt: '2026-07-05T10:00:00.000Z',
    },
  ];
  const snapshots = [
    {
      snapshotId: 'timeline-1111',
      jobName: 'documents',
      sourcePath: '/Users/ah/Documents',
      createdAt: '2026-07-05T10:00:00.000Z',
      fileCount: 3,
    },
    {
      snapshotId: 'timeline-2222',
      jobName: 'documents',
      sourcePath: '/Users/ah/Documents',
      createdAt: '2026-07-05T11:00:00.000Z',
      fileCount: 5,
    },
  ];
  const manifest = {
    snapshotId: 'timeline-2222',
    deviceId: 'd5',
    createdAt: '2026-07-05T11:00:00.000Z',
    sourcePath: '/Users/ah/Documents',
    files: ['new.txt', 'nested/version.md'],
  };
  const restorePlan = {
    mode: 'dry-run',
    wouldWrite: false,
    summary: { totalFiles: 2, wouldCreateCount: 1, wouldOverwriteCount: 1 },
    files: [
      { sourceRelativePath: 'new.txt', targetPath: '/tmp/linke/new.txt', action: 'would-create' },
      { sourceRelativePath: 'nested/version.md', targetPath: '/tmp/linke/nested/version.md', action: 'would-overwrite' },
    ],
  };
  const mockFetch = async (url) => {
    calls.push(url);
    if (url.includes('/restore-dry-run')) {
      return { ok: true, status: 200, json: async () => restorePlan };
    }
    if (url.includes('/manifest')) {
      return { ok: true, status: 200, json: async () => manifest };
    }
    if (url.includes('/retention-dry-run')) {
      return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
    }
    return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? snapshots : devices) };
  };
  const mockInterval = () => 0;

  initConsole(doc, mockFetch, mockInterval);
  await new Promise((r) => setTimeout(r, 20));

  doc.getElementById('restore-dry-run-target').value = '/tmp/linke';

  const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
  deviceItem._listeners.click();
  await new Promise((r) => setTimeout(r, 20));

  const backupJob = doc._created.find((el) => el.className && el.className.includes('backup-job-item'));
  backupJob._listeners.click();
  await new Promise((r) => setTimeout(r, 20));

  const timelineRows = doc._created.filter((el) => el.className && el.className.includes('backup-job-timeline-item'));
  const newestRow = timelineRows.find((el) => el.dataset.snapshotId === 'timeline-2222');
  assert.ok(newestRow, 'newest timeline row must expose data-snapshot-id');
  assert.ok(newestRow._listeners.click, 'timeline row must have click handler');
  newestRow._listeners.click();
  await new Promise((r) => setTimeout(r, 40));

  assert.ok(
    calls.includes('/api/devices/d5/snapshots/timeline-2222/manifest'),
    `must fetch manifest endpoint, got calls: ${calls.join(', ')}`,
  );
  assert.ok(
    calls.includes('/api/devices/d5/snapshots/timeline-2222/restore-dry-run?targetPath=%2Ftmp%2Flinke'),
    `must fetch restore dry-run endpoint, got calls: ${calls.join(', ')}`,
  );
  assert.match(newestRow.className, /selected/);
  assert.match(doc.getElementById('snapshot-detail-content').textContent, /nested\/version\.md/);
  assert.match(doc.getElementById('restore-dry-run-result').textContent, /would-overwrite/);
});
```

- [ ] **Step 3: Add failing DOM test for stale timeline selection clearing**

Add this test next to the existing stale-detail cleanup tests:

```js
it('clears selected backup job timeline snapshot when switching devices', async () => {
  const doc = buildMockDoc();
  const devices = [
    { deviceId: 'dev-A', hostname: 'A', status: 'online', ipAddress: '10.0.0.10', snapshotCount: 1 },
    { deviceId: 'dev-B', hostname: 'B', status: 'online', ipAddress: '10.0.0.11', snapshotCount: 0 },
  ];
  const snapshotsA = [
    {
      snapshotId: 'dev-a-snap',
      jobName: 'documents',
      sourcePath: '/Users/ah/Documents',
      createdAt: '2026-07-05T10:00:00.000Z',
      fileCount: 2,
    },
  ];
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(url);
    if (url.includes('/retention-dry-run')) {
      return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
    }
    if (url.includes('/manifest')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          snapshotId: 'dev-a-snap',
          deviceId: 'dev-A',
          sourcePath: '/Users/ah/Documents',
          createdAt: '2026-07-05T10:00:00.000Z',
          files: ['a.txt'],
        }),
      };
    }
    if (url.includes('/restore-dry-run')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          mode: 'dry-run',
          wouldWrite: false,
          summary: { totalFiles: 0, wouldCreateCount: 0, wouldOverwriteCount: 0 },
          files: [],
        }),
      };
    }
    if (url.includes('/api/devices/dev-A/snapshots')) {
      return { ok: true, status: 200, json: async () => snapshotsA };
    }
    if (url.includes('/api/devices/dev-B/snapshots')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: true, status: 200, json: async () => devices };
  };
  const mockInterval = () => 0;

  initConsole(doc, mockFetch, mockInterval);
  await new Promise((r) => setTimeout(r, 20));

  const deviceA = doc._created.find((el) => el.dataset.deviceId === 'dev-A');
  const deviceB = doc._created.find((el) => el.dataset.deviceId === 'dev-B');

  deviceA._listeners.click();
  await new Promise((r) => setTimeout(r, 20));

  const backupJob = doc._created.find((el) => el.className && el.className.includes('backup-job-item'));
  backupJob._listeners.click();
  await new Promise((r) => setTimeout(r, 20));

  const timelineRow = doc._created.find((el) => el.className && el.className.includes('backup-job-timeline-item'));
  timelineRow._listeners.click();
  await new Promise((r) => setTimeout(r, 40));
  assert.match(timelineRow.className, /selected/);

  deviceB._listeners.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.doesNotMatch(doc.getElementById('backup-job-detail-list').textContent, /dev-a-snap/);
  assert.strictEqual(doc.getElementById('backup-job-detail-title').textContent, '未选择');
  calls.length = 0;

  doc.getElementById('restore-dry-run-target')._listeners.change();
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(!calls.some((url) => String(url).includes('dev-a-snap')), 'old selected snapshot must not be reused after device switch');
});
```

- [ ] **Step 4: Run red test**

Run:

```bash
node --test test/web-console.test.js
```

Expected: FAIL because timeline rows do not yet have `data-snapshot-id`, click handlers, selected state, or shared selection helper.

---

### Task 2: Implement Timeline Row Selection

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Test: `test/web-console.test.js`

**Interfaces:**
- Consumes: tests from Task 1.
- Produces:
  - `selectSnapshotForDetail(deviceId, snapshotId)` inside `initConsole`.
  - `backup-job-timeline-item` rows with `dataset.snapshotId`.
  - selected row class when `snapshot.snapshotId === selectedSnapshotId`.
  - no fetch when `snapshotId` is empty.

- [ ] **Step 1: Add shared snapshot selection helper**

In `src/web/app.js`, inside `initConsole`, add this helper before `renderSnapshots()`:

```js
  function selectSnapshotForDetail(deviceId, snapshotId) {
    const safeSnapshotId = String(snapshotId || '').trim();
    if (!deviceId || !safeSnapshotId) return;
    selectedSnapshotId = safeSnapshotId;
    if (selectedBackupJobKey) {
      renderBackupJobDetail(selectedBackupJobKey, cachedSnapshots, deviceId);
    }
    fetchSnapshotManifest(deviceId, safeSnapshotId);
    fetchRestoreDryRunPlan(deviceId, safeSnapshotId);
  }
```

- [ ] **Step 2: Reuse helper from the normal snapshot list**

Change the existing snapshot list click handler from:

```js
      li.addEventListener('click', function () {
        selectedSnapshotId = snap.snapshotId;
        fetchSnapshotManifest(deviceId, snap.snapshotId);
        fetchRestoreDryRunPlan(deviceId, snap.snapshotId);
      });
```

to:

```js
      li.addEventListener('click', function () {
        selectSnapshotForDetail(deviceId, snap.snapshotId);
      });
```

- [ ] **Step 3: Add data binding and selected state to timeline rows**

Inside `renderBackupJobDetail()`, after creating `item`, set the snapshot id and selected class:

```js
      item.className = 'backup-job-timeline-item'
        + (snapshot.snapshotId && snapshot.snapshotId === selectedSnapshotId ? ' selected' : '');
      item.setAttribute('data-testid', 'backup-job-timeline-item');
      item.dataset.snapshotId = snapshot.snapshotId;
```

Remove or replace the older `item.className = 'backup-job-timeline-item';` line so it is not duplicated.

- [ ] **Step 4: Add timeline row click handler**

Still inside the `timeline.snapshots.forEach(...)` block, after setting `dataset.snapshotId`, add:

```js
      item.addEventListener('click', function () {
        selectSnapshotForDetail(deviceId, snapshot.snapshotId);
      });
```

The helper already blocks empty snapshot IDs, so no endpoint call is made for invalid rows.

- [ ] **Step 5: Ensure device switching clears selected snapshot before async work**

Confirm the existing device click handler keeps this order:

```js
        selectedDeviceId = device.deviceId;
        selectedSnapshotId = null;
        selectedBackupJobKey = null;
        cachedSnapshots = [];
```

If the order differs after edits, restore this order.

- [ ] **Step 6: Add timeline selected styles**

In `src/web/styles.css`, after `.backup-job-timeline-item`, add:

```css
.backup-job-timeline-item {
  cursor: pointer;
}

.backup-job-timeline-item.selected {
  border-color: #2563eb;
  background: #eff6ff;
}
```

If `.backup-job-timeline-item` already exists, add only the new `cursor`, `.selected` rule, and do not duplicate unrelated declarations.

- [ ] **Step 7: Run focused Web Console tests**

Run:

```bash
node --test test/web-console.test.js
```

Expected: PASS.

- [ ] **Step 8: PM-only diff check**

Run:

```bash
git diff -- src/web/app.js src/web/styles.css test/web-console.test.js
```

Expected: only V0.19 timeline snapshot selection changes; no backend file and no write endpoint added.

---

### Task 3: README And Documentation Tests For V0.19

**Files:**
- Modify: `test/readme.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: V0.19 behavior from Task 2.
- Produces: README current version V0.19 and tests asserting read-only snapshot linking documentation.

- [ ] **Step 1: Add V0.19 version coverage test**

In `test/readme.test.js`, after the V0.18 version coverage test, add:

```js
  it('mentions V0.19 (backup job timeline snapshot linking)', () => {
    assertReadmeContains(/V0\.19/, 'V0.19');
  });
```

- [ ] **Step 2: Rename current-version documentation describe block**

Change:

```js
describe('README — V0.18 backup job detail timeline', () => {
```

to:

```js
describe('README — V0.19 backup job timeline snapshot linking', () => {
```

- [ ] **Step 3: Update current-version tests**

Replace the title/current/table assertions in that block with:

```js
  it('title says V0.19', () => {
    assert.match(readme, /^# Linke V0\.19/m);
  });

  it('version badge says 当前版本：V0.19', () => {
    assert.match(readme, /当前版本：V0\.19/);
  });

  it('version table has V0.19 row with 当前版本 milestone', () => {
    assert.match(readme, /\| V0\.19 \| 当前版本 \|/);
  });

  it('version table has V0.18 row with 备份任务详情时间线 milestone', () => {
    assert.match(readme, /\| V0\.18 \| 备份任务详情时间线 \|/);
  });
```

- [ ] **Step 4: Add V0.19 read-only linking assertions**

In the same describe block, add:

```js
  it('documents timeline snapshot linking to manifest detail and restore dry-run', () => {
    assert.match(readme, /时间线 snapshot 联动/);
    assert.match(readme, /manifest detail|快照清单详情/);
    assert.match(readme, /restore dry-run|恢复预检/);
  });

  it('states timeline snapshot linking remains read-only and does not execute restore', () => {
    assert.match(readme, /时间线 snapshot 联动[\s\S]*只读/);
    assert.match(readme, /时间线 snapshot 联动[\s\S]*不执行恢复/);
    assert.match(readme, /时间线 snapshot 联动[\s\S]*不写入 metadata/);
    assert.match(readme, /时间线 snapshot 联动[\s\S]*不连接 NAS/);
  });

  it('documents test coverage includes 备份任务时间线 snapshot 联动', () => {
    assert.match(readme, /备份任务时间线 snapshot 联动/);
  });
```

- [ ] **Step 5: Run red README test**

Run:

```bash
node --test test/readme.test.js
```

Expected: FAIL because README still says V0.18.

- [ ] **Step 6: Update README heading and badge**

Change:

```md
# Linke V0.18
> **当前版本：V0.18** — 单机 localhost 原型阶段，尚未具备生产级安全隔离。
```

to:

```md
# Linke V0.19
> **当前版本：V0.19** — 单机 localhost 原型阶段，尚未具备生产级安全隔离。
```

- [ ] **Step 7: Update README version table**

Change V0.18 row from current version to:

```md
| V0.18 | 备份任务详情时间线 | Web Console 新增只读备份任务详情时间线，从既有 snapshot 元数据展示单个任务的历史版本 |
```

Add V0.19 row after V0.18:

```md
| V0.19 | 当前版本 | Web Console 备份任务时间线 snapshot 联动，可点击任务历史版本并复用快照清单详情与恢复预检 dry-run |
```

- [ ] **Step 8: Update feature bullets**

Add or update these bullets near the existing backup job bullets:

```md
- **备份任务时间线 snapshot 联动** — Web Console 可从备份任务详情时间线中选择单个历史 snapshot，并复用快照清单详情与恢复预检 dry-run 面板查看版本内容和恢复影响预览
```

Update the Web Console feature list to include `备份任务时间线 snapshot 联动`.

- [ ] **Step 9: Add README V0.19 section**

After the existing `### Web Console 备份任务详情时间线` section, add:

```md
### Web Console 备份任务时间线 snapshot 联动

V0.19 在 V0.18 的备份任务详情时间线上增加只读 snapshot 联动。选中设备并选择一个备份任务后，可以点击该任务时间线中的某个历史 snapshot。控制台会复用现有快照清单详情和恢复预检 dry-run 面板：

- 快照清单详情显示该 snapshot 的 manifest、sourcePath、createdAt 和文件列表
- 恢复预检 dry-run 使用当前目标目录输入，显示 would-create / would-overwrite 预览
- 时间线行会显示选中态，帮助确认当前查看的历史版本

该联动只读取既有 snapshot、manifest 和 restore-dry-run 结果，不新增 API 路由、不写入 metadata、不执行恢复、不复制文件、不覆盖文件、不创建目录、不删除快照、不连接 NAS、不调用 NAS app、不执行远程传输。点击备份任务本身不会自动选择 snapshot；只有点击具体时间线行才会加载 manifest detail 和 restore dry-run。
```

- [ ] **Step 10: Update safety and coverage text**

In README safety boundary and test coverage areas, include:

```md
- 备份任务时间线 snapshot 联动只调用既有 manifest detail 与 restore-dry-run 读取接口，不执行恢复、不写入 metadata、不连接 NAS。
```

Update test coverage summary to include:

```md
备份任务时间线 snapshot 联动
```

- [ ] **Step 11: Run README tests**

Run:

```bash
node --test test/readme.test.js
```

Expected: PASS.

---

### Task 4: PM Verification And HTTP Smoke

**Files:**
- Verify: all V0.19 touched files

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: final verification evidence for PM acceptance.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass with `fail 0`.

- [ ] **Step 2: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 3: Check changed files**

Run:

```bash
git status -sb
git diff --name-only
```

Expected changed files:

```text
README.md
docs/superpowers/specs/2026-07-05-backup-job-timeline-snapshot-link-design.md
docs/superpowers/plans/2026-07-05-backup-job-timeline-snapshot-link.md
src/web/app.js
src/web/styles.css
test/readme.test.js
test/web-console.test.js
```

- [ ] **Step 4: Start local smoke server**

Run with a scratch data dir:

```bash
PORT=3005 HOST=127.0.0.1 DATA_DIR=/Users/ah/linke/.worktrees/linke-v0.12-web-panel/scratch/v019-smoke-data node src/server.js
```

Expected: server listens on `http://127.0.0.1:3005`.

- [ ] **Step 5: Smoke static files and source contract**

In another shell, run:

```bash
node --input-type=module -e "const base='http://127.0.0.1:3005'; const html=await fetch(base+'/').then(r=>r.text()); const js=await fetch(base+'/app.js').then(r=>r.text()); const devices=await fetch(base+'/api/devices').then(r=>r.json()); console.log(JSON.stringify({html: html.includes('backup-job-detail-panel') && html.includes('restore-dry-run-panel'), js: js.includes('selectSnapshotForDetail') && js.includes('dataset.snapshotId'), devices: Array.isArray(devices)}));"
```

Expected:

```json
{"html":true,"js":true,"devices":true}
```

- [ ] **Step 6: Stop smoke server and confirm port released**

Stop the server with Ctrl-C, then run:

```bash
lsof -nP -iTCP:3005 -sTCP:LISTEN
```

Expected: no listener on port 3005.

- [ ] **Step 7: PM review for safety boundaries**

Run:

```bash
rg -n "POST /api/restore|POST /api/backups|POST /api/nas-dry-run|selectSnapshotForDetail|backup-job-timeline-item|V0\\.19|备份任务时间线 snapshot 联动" README.md src/web test docs/superpowers
```

Expected:

- `POST /api/restore`, `POST /api/backups`, and `POST /api/nas-dry-run` appear only in documentation or tests asserting they are not used.
- `selectSnapshotForDetail` appears only in `src/web/app.js` and source contract tests.
- V0.19 docs and tests mention read-only behavior.

---

## Self-Review

- Spec coverage:
  - Timeline row click: Task 1 and Task 2.
  - Reuse manifest detail and restore dry-run: Task 1 and Task 2.
  - Selected state: Task 1 and Task 2.
  - Device switch cleanup: Task 1 and Task 2.
  - README V0.19 update: Task 3.
  - Full verification and HTTP smoke: Task 4.
- Placeholder scan:
  - No unresolved placeholder markers or unspecified error-handling steps.
- Type consistency:
  - Uses existing `selectedSnapshotId`, `selectedBackupJobKey`, `cachedSnapshots`, `fetchSnapshotManifest(deviceId, snapshotId)`, `fetchRestoreDryRunPlan(deviceId, snapshotId)`, and `renderBackupJobDetail(jobKey, snapshots, deviceId)`.
  - New helper name is consistently `selectSnapshotForDetail(deviceId, snapshotId)`.
- Boundary check:
  - No backend route changes.
  - No real restore or backup execution path.
  - Worker commits are explicitly disallowed by the global hard gate.
