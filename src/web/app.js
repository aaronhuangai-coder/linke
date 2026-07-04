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

function formatDateOrFallback(value, fallback) {
  if (!value || !isValidDate(value)) return fallback;
  return new Date(value).toLocaleString();
}

export function formatLastHeartbeat(value) {
  return formatDateOrFallback(value, '无心跳');
}

export function formatLastBackup(value) {
  return formatDateOrFallback(value, '无备份');
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

export function parseBackupPreflightExcludePatterns(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

export function parseNasDryRunConfig(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return { ok: false, error: '配置 JSON 不能为空' };
  }
  try {
    return { ok: true, config: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: 'JSON 格式错误: ' + err.message };
  }
}

// ── V0.16 Device List Controls ────────────────────────────────────

export function normalizeDeviceStatus(status) {
  if (status === 'online' || status === 'offline') return status;
  return 'unknown';
}

function normalizeSearchValue(value) {
  return String(value || '').trim().toLowerCase();
}

export function matchesDeviceSearch(device, query) {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return true;
  return [
    device?.hostname,
    device?.deviceId,
    device?.ipAddress,
  ].some((value) => normalizeSearchValue(value).includes(normalizedQuery));
}

function getDeviceName(device) {
  return String(device?.hostname || device?.deviceId || '').toLowerCase();
}

function getDeviceIp(device) {
  return String(device?.ipAddress || '').toLowerCase();
}

function getDeviceHeartbeatTime(device) {
  const value = Date.parse(device?.lastHeartbeatAt || '');
  return Number.isFinite(value) ? value : 0;
}

export function compareDevicesForSort(a, b, sortKey) {
  if (sortKey === 'ip') {
    return getDeviceIp(a).localeCompare(getDeviceIp(b)) || getDeviceName(a).localeCompare(getDeviceName(b));
  }
  if (sortKey === 'heartbeat') {
    return getDeviceHeartbeatTime(b) - getDeviceHeartbeatTime(a) || getDeviceName(a).localeCompare(getDeviceName(b));
  }
  if (sortKey === 'snapshots') {
    return (b?.snapshotCount || 0) - (a?.snapshotCount || 0) || getDeviceName(a).localeCompare(getDeviceName(b));
  }
  return getDeviceName(a).localeCompare(getDeviceName(b));
}

export function applyDeviceListControls(devices, controls) {
  const status = controls?.status || 'all';
  const sort = controls?.sort || 'name';
  return [...devices]
    .filter((device) => matchesDeviceSearch(device, controls?.query || ''))
    .filter((device) => status === 'all' || normalizeDeviceStatus(device?.status) === status)
    .sort((a, b) => compareDevicesForSort(a, b, sort));
}

// ── Console Initializer ───────────────────────────────────────────

export function initConsole(doc, fetchImpl, intervalImpl) {
  const deviceListEl = doc.getElementById('device-list');
  const deviceDetailContentEl = doc.getElementById('device-detail-content');
  const snapshotListEl = doc.getElementById('snapshot-list');
  const snapshotDeviceName = doc.getElementById('snapshots-device-name');
  const snapshotDetailTitle = doc.getElementById('snapshot-detail-title');
  const snapshotDetailContent = doc.getElementById('snapshot-detail-content');
  const restoreDryRunTitle = doc.getElementById('restore-dry-run-title');
  const restoreDryRunTargetInput = doc.getElementById('restore-dry-run-target');
  const restoreDryRunCreateCountEl = doc.getElementById('restore-dry-run-create-count');
  const restoreDryRunOverwriteCountEl = doc.getElementById('restore-dry-run-overwrite-count');
  const restoreDryRunResultEl = doc.getElementById('restore-dry-run-result');
  const backupPreflightSourceInput = doc.getElementById('backup-preflight-source');
  const backupPreflightExcludesInput = doc.getElementById('backup-preflight-excludes');
  const backupPreflightRunButton = doc.getElementById('backup-preflight-run');
  const backupPreflightTotalCountEl = doc.getElementById('backup-preflight-total-count');
  const backupPreflightIncludedCountEl = doc.getElementById('backup-preflight-included-count');
  const backupPreflightExcludedCountEl = doc.getElementById('backup-preflight-excluded-count');
  const backupPreflightResultEl = doc.getElementById('backup-preflight-result');
  const nasDryRunConfigInput = doc.getElementById('nas-dry-run-config');
  const nasDryRunRunButton = doc.getElementById('nas-dry-run-run');
  const nasDryRunTargetCountEl = doc.getElementById('nas-dry-run-target-count');
  const nasDryRunJobCountEl = doc.getElementById('nas-dry-run-job-count');
  const nasDryRunResultEl = doc.getElementById('nas-dry-run-result');
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

  const deviceSearchInput = doc.getElementById('device-search');
  const deviceStatusFilter = doc.getElementById('device-status-filter');
  const deviceSortSelect = doc.getElementById('device-sort');
  const deviceFilterCountEl = doc.querySelector('[data-testid="device-filter-count"]');

  function getDeviceControls() {
    return {
      query: deviceSearchInput?.value || '',
      status: deviceStatusFilter?.value || 'all',
      sort: deviceSortSelect?.value || 'name',
    };
  }

  function renderDeviceFilterCount(visibleCount, totalCount) {
    if (deviceFilterCountEl) {
      deviceFilterCountEl.textContent = String(visibleCount) + ' / ' + String(totalCount);
    }
  }

  function renderFilteredDevices() {
    const visibleDevices = applyDeviceListControls(cachedDevices, getDeviceControls());
    renderDeviceFilterCount(visibleDevices.length, cachedDevices.length);
    renderDevices(visibleDevices);
  }

  if (retentionKeepLastInput && !retentionKeepLastInput.value) {
    retentionKeepLastInput.value = '3';
  }
  if (restoreDryRunTargetInput && !restoreDryRunTargetInput.value) {
    restoreDryRunTargetInput.value = './restore-preview';
  }
  if (backupPreflightExcludesInput && !backupPreflightExcludesInput.value) {
    backupPreflightExcludesInput.value = '*.tmp\nnode_modules';
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
      const selectedDevice = devices.find((d) => d.deviceId === selectedDeviceId) || null;
      if (!selectedDevice) selectedDeviceId = null;
      renderFleetSummary(devices);
      renderFilteredDevices();
      renderDeviceDetail(selectedDevice);
      logEvent('已加载 ' + devices.length + ' 台设备', 'info');
    } catch (err) {
      logEvent('加载设备失败: ' + err.message, 'error');
    }
  }

  function appendDeviceDetailRow(parent, testId, label, value) {
    const row = doc.createElement('div');
    row.className = 'device-detail-row';

    const term = doc.createElement('dt');
    term.textContent = label;

    const detail = doc.createElement('dd');
    detail.setAttribute('data-testid', testId);
    detail.textContent = value;

    row.appendChild(term);
    row.appendChild(detail);
    parent.appendChild(row);
  }

  function renderDeviceDetail(device) {
    clearElement(deviceDetailContentEl);
    if (!deviceDetailContentEl) return;

    if (!device) {
      const placeholder = doc.createElement('p');
      placeholder.className = 'placeholder';
      placeholder.setAttribute('data-testid', 'device-detail-placeholder');
      placeholder.textContent = '请选择一个设备';
      deviceDetailContentEl.appendChild(placeholder);
      return;
    }

    const grid = doc.createElement('dl');
    grid.className = 'device-detail-grid';

    appendDeviceDetailRow(grid, 'device-detail-device-id', 'Device ID', device.deviceId || 'unknown');
    appendDeviceDetailRow(grid, 'device-detail-hostname', 'Hostname', device.hostname || 'unknown');
    appendDeviceDetailRow(grid, 'device-detail-ip', 'IP 地址', device.ipAddress || 'unknown');
    appendDeviceDetailRow(grid, 'device-detail-status', '状态', device.status || 'unknown');
    appendDeviceDetailRow(grid, 'device-detail-heartbeat', '最后心跳', formatLastHeartbeat(device.lastHeartbeatAt));
    appendDeviceDetailRow(grid, 'device-detail-backup', '最后备份', formatLastBackup(device.lastBackupAt));
    appendDeviceDetailRow(grid, 'device-detail-snapshots', '快照数', String(device.snapshotCount || 0));

    deviceDetailContentEl.appendChild(grid);
  }

  function renderFleetSummary(devices) {
    const summary = computeFleetSummary(devices);
    fleetTotalEl.textContent = summary.total;
    fleetOnlineEl.textContent = summary.online;
    fleetOfflineEl.textContent = summary.offline;
    fleetSnapshotsEl.textContent = summary.totalSnapshots;
  }

  function renderDevices(devices) {
    clearElement(deviceListEl);
    if (devices.length === 0) {
      deviceListEl.innerHTML = '<li class="placeholder">无匹配设备</li>';
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
        renderDeviceDetail(device);
        renderFilteredDevices();
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

  function setBackupPreflightCounts(totalCount, includedCount, excludedCount) {
    if (backupPreflightTotalCountEl) backupPreflightTotalCountEl.textContent = String(totalCount);
    if (backupPreflightIncludedCountEl) backupPreflightIncludedCountEl.textContent = String(includedCount);
    if (backupPreflightExcludedCountEl) backupPreflightExcludedCountEl.textContent = String(excludedCount);
  }

  function setBackupPreflightPlaceholder(message) {
    clearElement(backupPreflightResultEl);
    setBackupPreflightCounts(0, 0, 0);
    if (!backupPreflightResultEl) return;
    const item = doc.createElement('p');
    item.className = 'placeholder';
    item.textContent = message;
    backupPreflightResultEl.appendChild(item);
  }

  function getBackupPreflightSourcePath() {
    return String(backupPreflightSourceInput?.value || '').trim();
  }

  function getBackupPreflightExcludePatterns() {
    return parseBackupPreflightExcludePatterns(backupPreflightExcludesInput?.value || '');
  }

  async function readErrorMessage(res) {
    try {
      const body = await res.json();
      if (body?.error) return body.error;
    } catch {
      // Ignore malformed error bodies and fall back to HTTP status.
    }
    return 'HTTP ' + res.status;
  }

  async function fetchBackupPreflightPlan() {
    if (!backupPreflightResultEl) return;

    const sourcePath = getBackupPreflightSourcePath();
    if (!sourcePath) {
      setBackupPreflightPlaceholder('请输入源路径');
      return;
    }

    const params = new URLSearchParams({ sourcePath });
    for (const pattern of getBackupPreflightExcludePatterns()) {
      params.append('exclude', pattern);
    }

    setBackupPreflightPlaceholder('加载中...');

    try {
      const res = await fetchImpl('/api/backup-preflight-dry-run?' + params.toString());
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const plan = await res.json();
      renderBackupPreflightPlan(plan);
      logEvent('已加载备份预检 (' + sourcePath + ')', 'info');
    } catch (err) {
      setBackupPreflightPlaceholder('加载失败: ' + err.message);
      logEvent('加载备份预检失败: ' + err.message, 'error');
    }
  }

  function appendBackupPreflightGroup(parent, title, files, className, renderItem) {
    const group = doc.createElement('div');
    group.className = 'backup-preflight-group ' + className;

    const heading = doc.createElement('h3');
    heading.textContent = title;
    group.appendChild(heading);

    const list = doc.createElement('ul');
    list.className = 'backup-preflight-file-list';

    if (files.length === 0) {
      const empty = doc.createElement('li');
      empty.className = 'placeholder';
      empty.textContent = '无';
      list.appendChild(empty);
    } else {
      files.forEach(function (file) {
        list.appendChild(renderItem(file));
      });
    }

    group.appendChild(list);
    parent.appendChild(group);
  }

  function renderIncludedPreflightFile(pathValue) {
    const item = doc.createElement('li');
    item.className = 'backup-preflight-file backup-preflight-included-file';

    const path = doc.createElement('span');
    path.className = 'backup-preflight-path';
    path.textContent = pathValue || 'unknown';

    item.appendChild(path);
    return item;
  }

  function renderExcludedPreflightFile(file) {
    const item = doc.createElement('li');
    item.className = 'backup-preflight-file backup-preflight-excluded-file';

    const path = doc.createElement('span');
    path.className = 'backup-preflight-path';
    path.textContent = file?.sourceRelativePath || 'unknown';

    const pattern = doc.createElement('span');
    pattern.className = 'backup-preflight-pattern';
    pattern.textContent = file?.matchedPattern || 'unknown';

    item.appendChild(path);
    item.appendChild(pattern);
    return item;
  }

  function renderBackupPreflightPlan(plan) {
    clearElement(backupPreflightResultEl);
    if (!backupPreflightResultEl) return;

    const included = Array.isArray(plan?.included) ? plan.included : [];
    const excluded = Array.isArray(plan?.excluded) ? plan.excluded : [];

    setBackupPreflightCounts(
      Number.isFinite(plan?.summary?.totalFiles) ? plan.summary.totalFiles : included.length + excluded.length,
      Number.isFinite(plan?.summary?.includedCount) ? plan.summary.includedCount : included.length,
      Number.isFinite(plan?.summary?.excludedCount) ? plan.summary.excludedCount : excluded.length,
    );

    appendBackupPreflightGroup(
      backupPreflightResultEl,
      '拟包含',
      included,
      'backup-preflight-included',
      renderIncludedPreflightFile,
    );
    appendBackupPreflightGroup(
      backupPreflightResultEl,
      '拟排除',
      excluded,
      'backup-preflight-excluded',
      renderExcludedPreflightFile,
    );
  }

  function setNasDryRunError(message) {
    if (!nasDryRunResultEl) return;
    clearElement(nasDryRunResultEl);
    const error = doc.createElement('div');
    error.className = 'nas-dry-run-error';
    error.textContent = message;
    nasDryRunResultEl.appendChild(error);
  }

  function renderNasDryRunPlan(plan) {
    if (!nasDryRunResultEl) return;
    const targets = Array.isArray(plan.targets) ? plan.targets : [];
    const jobs = Array.isArray(plan.jobs) ? plan.jobs : [];

    if (nasDryRunTargetCountEl) nasDryRunTargetCountEl.textContent = String(targets.length);
    if (nasDryRunJobCountEl) nasDryRunJobCountEl.textContent = String(jobs.length);
    clearElement(nasDryRunResultEl);

    if (targets.length === 0) {
      const placeholder = doc.createElement('p');
      placeholder.className = 'placeholder';
      placeholder.textContent = '未配置任何 NAS 目标';
      nasDryRunResultEl.appendChild(placeholder);
      return;
    }

    const list = doc.createElement('ul');
    list.className = 'nas-dry-run-target-list';

    targets.forEach(function (target) {
      const item = doc.createElement('li');
      item.className = 'nas-dry-run-target-item';

      const nameRow = doc.createElement('div');
      nameRow.className = 'nas-dry-run-target-name';

      const name = doc.createElement('span');
      name.textContent = (target.name || 'unnamed') + ' [' + (target.provider || 'unknown') + ']';

      const badge = doc.createElement('span');
      badge.className = 'nas-dry-run-badge ' + (target.enabled ? 'enabled' : 'disabled');
      badge.textContent = target.enabled ? '已启用' : '已禁用';

      nameRow.appendChild(name);
      nameRow.appendChild(badge);

      const detail = doc.createElement('div');
      detail.className = 'nas-dry-run-target-detail';
      detail.textContent = (target.endpoint || '') + ' · ' + (target.shareName || '') + ' · ' + (target.remotePath || '');

      item.appendChild(nameRow);
      item.appendChild(detail);

      const adapter = doc.createElement('div');
      adapter.className = 'nas-dry-run-adapter-plan';

      if (target.adapterPlan) {
        const adapterTitle = doc.createElement('div');
        adapterTitle.className = 'nas-dry-run-adapter-title';
        adapterTitle.textContent = `${target.adapterPlan.appId} · ${target.adapterPlan.operation} · wouldInvokeApp:false`;
        adapter.appendChild(adapterTitle);

        const steps = doc.createElement('ol');
        steps.className = 'nas-dry-run-adapter-steps';
        (target.adapterPlan.steps || []).forEach((step) => {
          const stepItem = doc.createElement('li');
          stepItem.textContent = step;
          steps.appendChild(stepItem);
        });
        adapter.appendChild(steps);
      } else {
        adapter.textContent = '未配置应用适配器';
      }

      item.appendChild(adapter);
      list.appendChild(item);
    });

    nasDryRunResultEl.appendChild(list);
  }

  async function fetchNasDryRunPlan() {
    if (!nasDryRunResultEl) return;

    const parsed = parseNasDryRunConfig(nasDryRunConfigInput ? nasDryRunConfigInput.value : '');
    if (!parsed.ok) {
      setNasDryRunError(parsed.error);
      return;
    }

    clearElement(nasDryRunResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '加载中...';
    nasDryRunResultEl.appendChild(loading);

    try {
      const res = await fetchImpl('/api/nas-dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.config),
      });
      if (!res.ok) {
        let errBody;
        try {
          errBody = await res.json();
        } catch (_) {
          errBody = {};
        }
        throw new Error(errBody.error || 'HTTP ' + res.status);
      }
      const plan = await res.json();
      renderNasDryRunPlan(plan);
      logEvent('已加载 NAS dry-run 预检', 'info');
    } catch (err) {
      setNasDryRunError(err.message);
      logEvent('加载 NAS dry-run 失败: ' + err.message, 'error');
    }
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

  if (backupPreflightRunButton?.addEventListener) {
    backupPreflightRunButton.addEventListener('click', fetchBackupPreflightPlan);
  }

  if (nasDryRunRunButton?.addEventListener) {
    nasDryRunRunButton.addEventListener('click', fetchNasDryRunPlan);
  }

  for (const control of [deviceSearchInput, deviceStatusFilter, deviceSortSelect]) {
    if (control?.addEventListener) {
      control.addEventListener('input', renderFilteredDevices);
      control.addEventListener('change', renderFilteredDevices);
    }
  }

  logEvent('Linke 控制台已启动', 'info');
  fetchDevices();
  intervalImpl(fetchDevices, 10000);
}

// ── Auto-init in browser ──────────────────────────────────────────

if (typeof globalThis.document !== 'undefined') {
  initConsole(document, fetch, setInterval);
}
