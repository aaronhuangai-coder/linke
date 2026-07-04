/* Linke Web Console — app.js (browser ESM, testable) */

// ── Pure Functions ────────────────────────────────────────────────

export function computeFleetSummary(devices) {
  let online = 0;
  let offline = 0;
  let totalSnapshots = 0;
  for (const d of devices) {
    if (d.status === 'online') online++;
    else offline++;
    totalSnapshots += d.snapshotCount || 0;
  }
  return { total: devices.length, online, offline, totalSnapshots };
}

function isValidDate(value) {
  const d = new Date(value);
  return !isNaN(d.getTime());
}

export function formatLastHeartbeat(value) {
  if (!value || !isValidDate(value)) return '无心跳';
  return new Date(value).toLocaleString();
}

export function formatSnapshotJobName(snapshot) {
  return snapshot.jobName || '未命名任务';
}

export function formatSnapshotMeta(snapshot) {
  const date = (snapshot.createdAt && isValidDate(snapshot.createdAt))
    ? new Date(snapshot.createdAt).toLocaleString()
    : 'unknown';
  const fileCount = snapshot.fileCount || 0;
  return date + ' · ' + fileCount + ' files';
}

export function formatRetentionAction(action) {
  if (action === 'keep') return '保留';
  if (action === 'would-delete') return '拟淘汰';
  return action || 'unknown';
}

export function parseRetentionKeepLast(value) {
  const raw = String(value || '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return Number(raw);
}

// ── Console Initializer ───────────────────────────────────────────

export function initConsole(doc, fetchImpl, intervalImpl) {
  const deviceListEl = doc.getElementById('device-list');
  const snapshotListEl = doc.getElementById('snapshot-list');
  const snapshotDeviceName = doc.getElementById('snapshots-device-name');
  const snapshotDetailTitle = doc.getElementById('snapshot-detail-title');
  const snapshotDetailContent = doc.getElementById('snapshot-detail-content');
  const restoreDryRunTitle = doc.getElementById('restore-dry-run-title');
  const restoreDryRunTargetInput = doc.getElementById('restore-dry-run-target');
  const restoreDryRunCreateCountEl = doc.getElementById('restore-dry-run-create-count');
  const restoreDryRunOverwriteCountEl = doc.getElementById('restore-dry-run-overwrite-count');
  const restoreDryRunResultEl = doc.getElementById('restore-dry-run-result');
  const snapshotDiffDeviceName = doc.getElementById('snapshot-diff-device-name');
  const snapshotDiffFromSelect = doc.getElementById('snapshot-diff-from');
  const snapshotDiffToSelect = doc.getElementById('snapshot-diff-to');
  const snapshotDiffAddedCountEl = doc.getElementById('snapshot-diff-added-count');
  const snapshotDiffRemovedCountEl = doc.getElementById('snapshot-diff-removed-count');
  const snapshotDiffUnchangedCountEl = doc.getElementById('snapshot-diff-unchanged-count');
  const snapshotDiffResultEl = doc.getElementById('snapshot-diff-result');
  const eventLogEl = doc.getElementById('event-log');
  const retentionDeviceName = doc.getElementById('retention-device-name');
  const retentionKeepLastInput = doc.getElementById('retention-keep-last');
  const retentionKeepCountEl = doc.getElementById('retention-keep-count');
  const retentionDeleteCountEl = doc.getElementById('retention-delete-count');
  const retentionPlanListEl = doc.getElementById('retention-plan-list');
  const fleetTotalEl = doc.querySelector('[data-testid="fleet-total"]');
  const fleetOnlineEl = doc.querySelector('[data-testid="fleet-online"]');
  const fleetOfflineEl = doc.querySelector('[data-testid="fleet-offline"]');
  const fleetSnapshotsEl = doc.querySelector('[data-testid="fleet-snapshots"]');

  let selectedDeviceId = null;
  let selectedSnapshotId = null;
  let cachedDevices = [];

  if (retentionKeepLastInput && !retentionKeepLastInput.value) {
    retentionKeepLastInput.value = '3';
  }
  if (restoreDryRunTargetInput && !restoreDryRunTargetInput.value) {
    restoreDryRunTargetInput.value = './restore-preview';
  }

  function logEvent(msg, type) {
    type = type || 'info';
    const entry = doc.createElement('div');
    entry.className = 'event-entry event-' + type;
    const ts = new Date().toLocaleTimeString();
    entry.textContent = '[' + ts + '] ' + msg;
    eventLogEl.prepend(entry);
  }

  async function fetchDevices() {
    try {
      const res = await fetchImpl('/api/devices');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const devices = await res.json();
      cachedDevices = devices;
      renderFleetSummary(devices);
      renderDevices(devices);
      logEvent('已加载 ' + devices.length + ' 台设备', 'info');
    } catch (err) {
      logEvent('加载设备失败: ' + err.message, 'error');
    }
  }

  function renderFleetSummary(devices) {
    const summary = computeFleetSummary(devices);
    fleetTotalEl.textContent = summary.total;
    fleetOnlineEl.textContent = summary.online;
    fleetOfflineEl.textContent = summary.offline;
    fleetSnapshotsEl.textContent = summary.totalSnapshots;
  }

  function renderDevices(devices) {
    deviceListEl.innerHTML = '';
    if (devices.length === 0) {
      deviceListEl.innerHTML = '<li class="placeholder">暂无设备</li>';
      return;
    }
    devices.forEach(function (device) {
      const li = doc.createElement('li');
      li.setAttribute('data-testid', 'device-item');
      li.dataset.deviceId = device.deviceId;
      li.className = 'device-item' + (device.deviceId === selectedDeviceId ? ' selected' : '');

      const nameRow = doc.createElement('div');
      nameRow.className = 'device-name-row';

      const name = doc.createElement('span');
      name.className = 'device-name';
      name.textContent = device.hostname || device.deviceId;

      const statusBadge = doc.createElement('span');
      statusBadge.className = 'status-badge status-' + (device.status || 'unknown');
      statusBadge.textContent = device.status || 'unknown';
      statusBadge.setAttribute('data-testid', 'device-status');

      nameRow.appendChild(name);
      nameRow.appendChild(statusBadge);

      const meta = doc.createElement('span');
      meta.className = 'device-meta';
      meta.setAttribute('data-testid', 'device-heartbeat');
      const ip = device.ipAddress || 'unknown';
      const snaps = device.snapshotCount || 0;
      const lastHeartbeat = formatLastHeartbeat(device.lastHeartbeatAt);
      meta.textContent = ip + ' · ' + snaps + ' 快照 · 心跳 ' + lastHeartbeat;

      li.appendChild(nameRow);
      li.appendChild(meta);

      li.addEventListener('click', function () {
        selectedDeviceId = device.deviceId;
        selectedSnapshotId = null;
        renderDevices(devices);
        fetchSnapshots(device.deviceId);
        fetchRetentionPlan(device.deviceId);
      });

      deviceListEl.appendChild(li);
    });
  }

  async function fetchSnapshots(deviceId) {
    snapshotDeviceName.textContent = '— ' + deviceId;
    snapshotListEl.innerHTML = '<li class="placeholder">加载中…</li>';

    try {
      const res = await fetchImpl('/api/devices/' + encodeURIComponent(deviceId) + '/snapshots');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const snapshots = await res.json();
      renderSnapshots(snapshots, deviceId);
      renderSnapshotDiffControls(snapshots, deviceId);
      logEvent('已加载 ' + snapshots.length + ' 个快照 (' + deviceId + ')', 'info');
    } catch (err) {
      snapshotListEl.innerHTML = '<li class="placeholder">加载失败</li>';
      setSnapshotDiffPlaceholder('加载失败');
      setRestoreDryRunPlaceholder('加载失败');
      logEvent('加载快照失败: ' + err.message, 'error');
    }
  }

  function renderSnapshots(snapshots, deviceId) {
    snapshotListEl.innerHTML = '';
    if (snapshots.length === 0) {
      snapshotListEl.innerHTML = '<li class="placeholder">暂无快照</li>';
      return;
    }
    snapshots.forEach(function (snap) {
      const li = doc.createElement('li');
      li.className = 'snapshot-item';
      li.setAttribute('data-testid', 'snapshot-item');
      li.dataset.snapshotId = snap.snapshotId;
      li.addEventListener('click', function () {
        selectedSnapshotId = snap.snapshotId;
        fetchSnapshotManifest(deviceId, snap.snapshotId);
        fetchRestoreDryRunPlan(deviceId, snap.snapshotId);
      });

      const id = doc.createElement('span');
      id.className = 'snapshot-id';
      id.textContent = snap.snapshotId.slice(0, 8) + '…';

      const info = doc.createElement('div');
      info.className = 'snapshot-info';

      const jobNameEl = doc.createElement('span');
      jobNameEl.className = 'snapshot-job';
      jobNameEl.textContent = formatSnapshotJobName(snap);
      jobNameEl.setAttribute('data-testid', 'snapshot-jobname');

      const meta = doc.createElement('span');
      meta.className = 'snapshot-meta';
      meta.textContent = formatSnapshotMeta(snap);
      meta.setAttribute('data-testid', 'snapshot-files');

      info.appendChild(jobNameEl);
      info.appendChild(meta);

      li.appendChild(id);
      li.appendChild(info);
      snapshotListEl.appendChild(li);
    });
  }

  function clearElement(el) {
    if (!el) return;
    el.textContent = '';
    el.innerHTML = '';
    if (Array.isArray(el.children)) el.children.length = 0;
  }

  function setSnapshotDetailPlaceholder(message) {
    clearElement(snapshotDetailContent);
    if (!snapshotDetailContent) return;
    const item = doc.createElement('p');
    item.className = 'placeholder';
    item.textContent = message;
    snapshotDetailContent.appendChild(item);
  }

  async function fetchSnapshotManifest(deviceId, snapshotId) {
    if (!snapshotDetailContent) return;
    if (snapshotDetailTitle) snapshotDetailTitle.textContent = '— ' + String(snapshotId).slice(0, 8) + '...';
    setSnapshotDetailPlaceholder('加载中...');

    try {
      const res = await fetchImpl(
        '/api/devices/' + encodeURIComponent(deviceId)
        + '/snapshots/' + encodeURIComponent(snapshotId)
        + '/manifest',
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const manifest = await res.json();
      renderSnapshotManifest(manifest);
      logEvent('已加载快照清单 (' + snapshotId + ')', 'info');
    } catch (err) {
      setSnapshotDetailPlaceholder('加载失败');
      logEvent('加载快照清单失败: ' + err.message, 'error');
    }
  }

  function appendDetailRow(parent, label, value, testId) {
    const row = doc.createElement('div');
    row.className = 'manifest-row';

    const labelEl = doc.createElement('span');
    labelEl.className = 'manifest-label';
    labelEl.textContent = label;

    const valueEl = doc.createElement('span');
    valueEl.className = 'manifest-value';
    valueEl.textContent = value;
    valueEl.setAttribute('data-testid', testId);

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    parent.appendChild(row);
  }

  function renderSnapshotManifest(manifest) {
    clearElement(snapshotDetailContent);
    if (!snapshotDetailContent) return;

    const files = Array.isArray(manifest?.files) ? manifest.files : [];
    const summary = doc.createElement('div');
    summary.className = 'manifest-summary';

    appendDetailRow(summary, 'Snapshot', manifest?.snapshotId || 'unknown', 'manifest-snapshot-id');
    appendDetailRow(summary, 'Source', manifest?.sourcePath || 'unknown', 'manifest-source-path');
    appendDetailRow(summary, 'Created', manifest?.createdAt || 'unknown', 'manifest-created-at');
    appendDetailRow(summary, 'Files', files.length + ' files', 'manifest-file-count');

    const fileListTitle = doc.createElement('h3');
    fileListTitle.className = 'manifest-file-list-title';
    fileListTitle.textContent = '文件清单';

    const fileList = doc.createElement('ul');
    fileList.className = 'manifest-file-list';
    fileList.setAttribute('data-testid', 'manifest-file-list');

    if (files.length === 0) {
      const empty = doc.createElement('li');
      empty.className = 'placeholder';
      empty.textContent = '暂无文件';
      fileList.appendChild(empty);
    } else {
      files.forEach(function (file) {
        const item = doc.createElement('li');
        item.className = 'manifest-file-item';
        item.textContent = file;
        fileList.appendChild(item);
      });
    }

    snapshotDetailContent.appendChild(summary);
    snapshotDetailContent.appendChild(fileListTitle);
    snapshotDetailContent.appendChild(fileList);
  }

  function setRestoreDryRunCounts(wouldCreateCount, wouldOverwriteCount) {
    if (restoreDryRunCreateCountEl) restoreDryRunCreateCountEl.textContent = String(wouldCreateCount);
    if (restoreDryRunOverwriteCountEl) restoreDryRunOverwriteCountEl.textContent = String(wouldOverwriteCount);
  }

  function setRestoreDryRunPlaceholder(message) {
    clearElement(restoreDryRunResultEl);
    setRestoreDryRunCounts(0, 0);
    if (!restoreDryRunResultEl) return;
    const item = doc.createElement('p');
    item.className = 'placeholder';
    item.textContent = message;
    restoreDryRunResultEl.appendChild(item);
  }

  function getRestoreDryRunTargetPath() {
    return String(restoreDryRunTargetInput?.value || '').trim();
  }

  async function fetchRestoreDryRunPlan(deviceId, snapshotId) {
    if (!restoreDryRunResultEl) return;
    if (restoreDryRunTitle) restoreDryRunTitle.textContent = '— ' + String(snapshotId).slice(0, 8) + '...';

    const targetPath = getRestoreDryRunTargetPath();
    if (!targetPath) {
      setRestoreDryRunPlaceholder('请输入目标目录');
      return;
    }

    setRestoreDryRunPlaceholder('加载中...');

    try {
      const res = await fetchImpl(
        '/api/devices/' + encodeURIComponent(deviceId)
        + '/snapshots/' + encodeURIComponent(snapshotId)
        + '/restore-dry-run?targetPath=' + encodeURIComponent(targetPath),
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const plan = await res.json();
      renderRestoreDryRunPlan(plan);
      logEvent('已加载恢复预检 (' + snapshotId + ')', 'info');
    } catch (err) {
      setRestoreDryRunPlaceholder('加载失败');
      logEvent('加载恢复预检失败: ' + err.message, 'error');
    }
  }

  function renderRestoreDryRunPlan(plan) {
    clearElement(restoreDryRunResultEl);
    if (!restoreDryRunResultEl) return;

    const files = Array.isArray(plan?.files) ? plan.files : [];
    const wouldCreateCount = Number.isFinite(plan?.summary?.wouldCreateCount)
      ? plan.summary.wouldCreateCount
      : files.filter((file) => file.action === 'would-create').length;
    const wouldOverwriteCount = Number.isFinite(plan?.summary?.wouldOverwriteCount)
      ? plan.summary.wouldOverwriteCount
      : files.filter((file) => file.action === 'would-overwrite').length;

    setRestoreDryRunCounts(wouldCreateCount, wouldOverwriteCount);

    const list = doc.createElement('ul');
    list.className = 'restore-dry-run-file-list';

    if (files.length === 0) {
      const empty = doc.createElement('li');
      empty.className = 'placeholder';
      empty.textContent = '暂无拟恢复文件';
      list.appendChild(empty);
    } else {
      files.forEach(function (file) {
        const item = doc.createElement('li');
        item.className = 'restore-dry-run-file restore-action-' + (file.action || 'unknown');

        const path = doc.createElement('span');
        path.className = 'restore-file-path';
        path.textContent = file.sourceRelativePath || 'unknown';

        const action = doc.createElement('span');
        action.className = 'restore-action';
        action.textContent = file.action || 'unknown';

        const target = doc.createElement('span');
        target.className = 'restore-target-path';
        target.textContent = file.targetPath || '';

        item.appendChild(path);
        item.appendChild(action);
        item.appendChild(target);
        list.appendChild(item);
      });
    }

    restoreDryRunResultEl.appendChild(list);
  }

  function setSnapshotDiffCounts(addedCount, removedCount, unchangedCount) {
    if (snapshotDiffAddedCountEl) snapshotDiffAddedCountEl.textContent = String(addedCount);
    if (snapshotDiffRemovedCountEl) snapshotDiffRemovedCountEl.textContent = String(removedCount);
    if (snapshotDiffUnchangedCountEl) snapshotDiffUnchangedCountEl.textContent = String(unchangedCount);
  }

  function setSnapshotDiffPlaceholder(message) {
    clearElement(snapshotDiffResultEl);
    setSnapshotDiffCounts(0, 0, 0);
    if (!snapshotDiffResultEl) return;
    const item = doc.createElement('p');
    item.className = 'placeholder';
    item.textContent = message;
    snapshotDiffResultEl.appendChild(item);
  }

  function appendSnapshotOption(selectEl, snapshot) {
    const option = doc.createElement('option');
    option.value = snapshot.snapshotId;
    option.textContent = String(snapshot.snapshotId).slice(0, 8) + '... ' + formatSnapshotJobName(snapshot);
    selectEl.appendChild(option);
  }

  function renderSnapshotDiffControls(snapshots, deviceId) {
    if (!snapshotDiffFromSelect || !snapshotDiffToSelect) return;
    if (snapshotDiffDeviceName) snapshotDiffDeviceName.textContent = '— ' + deviceId;

    clearElement(snapshotDiffFromSelect);
    clearElement(snapshotDiffToSelect);

    snapshots.forEach(function (snapshot) {
      appendSnapshotOption(snapshotDiffFromSelect, snapshot);
      appendSnapshotOption(snapshotDiffToSelect, snapshot);
    });

    if (snapshots.length < 2) {
      snapshotDiffFromSelect.value = snapshots[0]?.snapshotId || '';
      snapshotDiffToSelect.value = '';
      setSnapshotDiffPlaceholder('至少需要两个快照');
      return;
    }

    snapshotDiffFromSelect.value = snapshots[0].snapshotId;
    snapshotDiffToSelect.value = snapshots[snapshots.length - 1].snapshotId;
    fetchSnapshotDiffPlan(deviceId);
  }

  async function fetchSnapshotDiffPlan(deviceId) {
    if (!snapshotDiffResultEl) return;
    const fromSnapshotId = snapshotDiffFromSelect?.value;
    const toSnapshotId = snapshotDiffToSelect?.value;
    if (!fromSnapshotId || !toSnapshotId) {
      setSnapshotDiffPlaceholder('请选择两个快照');
      return;
    }

    setSnapshotDiffPlaceholder('加载中...');

    try {
      const res = await fetchImpl(
        '/api/devices/' + encodeURIComponent(deviceId)
        + '/snapshots/diff-dry-run?from=' + encodeURIComponent(fromSnapshotId)
        + '&to=' + encodeURIComponent(toSnapshotId),
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const plan = await res.json();
      renderSnapshotDiffPlan(plan);
      logEvent('已加载快照差异 (' + fromSnapshotId + ' -> ' + toSnapshotId + ')', 'info');
    } catch (err) {
      setSnapshotDiffPlaceholder('加载失败');
      logEvent('加载快照差异失败: ' + err.message, 'error');
    }
  }

  function appendDiffGroup(parent, title, files, className) {
    const group = doc.createElement('div');
    group.className = 'snapshot-diff-group ' + className;

    const heading = doc.createElement('h3');
    heading.textContent = title;
    group.appendChild(heading);

    const list = doc.createElement('ul');
    list.className = 'snapshot-diff-file-list';

    if (files.length === 0) {
      const empty = doc.createElement('li');
      empty.className = 'placeholder';
      empty.textContent = '无';
      list.appendChild(empty);
    } else {
      files.forEach(function (file) {
        const item = doc.createElement('li');
        item.className = 'snapshot-diff-file';
        item.textContent = file;
        list.appendChild(item);
      });
    }

    group.appendChild(list);
    parent.appendChild(group);
  }

  function renderSnapshotDiffPlan(plan) {
    clearElement(snapshotDiffResultEl);
    if (!snapshotDiffResultEl) return;

    const added = Array.isArray(plan?.added) ? plan.added : [];
    const removed = Array.isArray(plan?.removed) ? plan.removed : [];
    const unchanged = Array.isArray(plan?.unchanged) ? plan.unchanged : [];

    setSnapshotDiffCounts(
      plan?.summary?.addedCount ?? added.length,
      plan?.summary?.removedCount ?? removed.length,
      plan?.summary?.unchangedCount ?? unchanged.length,
    );

    appendDiffGroup(snapshotDiffResultEl, '新增', added, 'diff-added');
    appendDiffGroup(snapshotDiffResultEl, '移除', removed, 'diff-removed');
    appendDiffGroup(snapshotDiffResultEl, '未变', unchanged, 'diff-unchanged');
  }

  function setRetentionPlaceholder(message) {
    clearElement(retentionPlanListEl);
    if (!retentionPlanListEl) return;
    const item = doc.createElement('li');
    item.className = 'placeholder';
    item.textContent = message;
    retentionPlanListEl.appendChild(item);
  }

  function getRetentionKeepLast() {
    const raw = retentionKeepLastInput ? retentionKeepLastInput.value : '3';
    return parseRetentionKeepLast(raw);
  }

  async function fetchRetentionPlan(deviceId) {
    if (!retentionPlanListEl) return;
    if (retentionDeviceName) retentionDeviceName.textContent = '— ' + deviceId;

    const keepLast = getRetentionKeepLast();
    if (!keepLast) {
      if (retentionKeepCountEl) retentionKeepCountEl.textContent = '0';
      if (retentionDeleteCountEl) retentionDeleteCountEl.textContent = '0';
      setRetentionPlaceholder('keepLast 必须是正整数');
      logEvent('保留计划参数无效: keepLast 必须是正整数', 'error');
      return;
    }

    setRetentionPlaceholder('加载中...');

    try {
      const res = await fetchImpl(
        '/api/devices/' + encodeURIComponent(deviceId) + '/retention-dry-run?keepLast=' + keepLast,
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const plan = await res.json();
      renderRetentionPlan(plan);
      logEvent('已加载保留计划 (' + deviceId + ', keepLast=' + keepLast + ')', 'info');
    } catch (err) {
      if (retentionKeepCountEl) retentionKeepCountEl.textContent = '0';
      if (retentionDeleteCountEl) retentionDeleteCountEl.textContent = '0';
      setRetentionPlaceholder('加载失败');
      logEvent('加载保留计划失败: ' + err.message, 'error');
    }
  }

  function renderRetentionPlan(plan) {
    const snapshots = Array.isArray(plan?.snapshots) ? plan.snapshots : [];
    const keepCount = Number.isFinite(plan?.keepCount) ? plan.keepCount : 0;
    const wouldDeleteCount = Number.isFinite(plan?.wouldDeleteCount) ? plan.wouldDeleteCount : 0;

    if (retentionKeepCountEl) retentionKeepCountEl.textContent = String(keepCount);
    if (retentionDeleteCountEl) retentionDeleteCountEl.textContent = String(wouldDeleteCount);

    clearElement(retentionPlanListEl);
    if (snapshots.length === 0) {
      setRetentionPlaceholder('暂无保留计划');
      return;
    }

    snapshots.forEach(function (snap) {
      const li = doc.createElement('li');
      li.className = 'retention-item retention-action-' + (snap.action || 'unknown');
      li.setAttribute('data-testid', 'retention-plan-item');

      const id = doc.createElement('span');
      id.className = 'retention-snapshot-id';
      id.textContent = String(snap.snapshotId || '').slice(0, 8) + '...';

      const info = doc.createElement('div');
      info.className = 'retention-info';

      const jobName = doc.createElement('span');
      jobName.className = 'retention-job';
      jobName.textContent = formatSnapshotJobName(snap);

      const meta = doc.createElement('span');
      meta.className = 'retention-meta';
      meta.textContent = formatSnapshotMeta(snap) + ' · ' + (snap.reason || 'unknown');

      const badge = doc.createElement('span');
      badge.className = 'retention-action-badge retention-badge-' + (snap.action || 'unknown');
      badge.textContent = formatRetentionAction(snap.action);

      info.appendChild(jobName);
      info.appendChild(meta);
      li.appendChild(id);
      li.appendChild(info);
      li.appendChild(badge);
      retentionPlanListEl.appendChild(li);
    });
  }

  if (retentionKeepLastInput?.addEventListener) {
    retentionKeepLastInput.addEventListener('change', function () {
      if (selectedDeviceId) {
        fetchRetentionPlan(selectedDeviceId);
      } else {
        setRetentionPlaceholder('请选择一个设备');
      }
    });
  }

  if (snapshotDiffFromSelect?.addEventListener) {
    snapshotDiffFromSelect.addEventListener('change', function () {
      if (selectedDeviceId) fetchSnapshotDiffPlan(selectedDeviceId);
    });
  }

  if (snapshotDiffToSelect?.addEventListener) {
    snapshotDiffToSelect.addEventListener('change', function () {
      if (selectedDeviceId) fetchSnapshotDiffPlan(selectedDeviceId);
    });
  }

  if (restoreDryRunTargetInput?.addEventListener) {
    restoreDryRunTargetInput.addEventListener('change', function () {
      if (selectedDeviceId && selectedSnapshotId) {
        fetchRestoreDryRunPlan(selectedDeviceId, selectedSnapshotId);
      } else {
        setRestoreDryRunPlaceholder('请选择一个快照进行恢复预检');
      }
    });
  }

  logEvent('Linke 控制台已启动', 'info');
  fetchDevices();
  intervalImpl(fetchDevices, 10000);
}

// ── Auto-init in browser ──────────────────────────────────────────

if (typeof globalThis.document !== 'undefined') {
  initConsole(document, fetch, setInterval);
}
