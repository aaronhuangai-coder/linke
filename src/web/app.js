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

// ── V0.17 Backup Job Overview ──────────────────────────────────────

function normalizeBackupJobName(value) {
  const name = String(value || '').trim();
  return name || '未命名任务';
}

function normalizeSourcePath(value) {
  const sourcePath = String(value || '').trim();
  return sourcePath || 'unknown';
}

function getSnapshotCreatedAtTime(snapshot) {
  const value = Date.parse(snapshot?.createdAt || '');
  return Number.isFinite(value) ? value : 0;
}

function getSnapshotFileCount(snapshot) {
  return Number.isFinite(snapshot?.fileCount) ? snapshot.fileCount : 0;
}

function getBackupJobKey(snapshot) {
  const rawJobName = String(snapshot?.jobName || '').trim();
  const sourcePath = normalizeSourcePath(snapshot?.sourcePath);
  return rawJobName ? 'job:' + rawJobName : 'source:' + sourcePath;
}

export function buildBackupJobOverview(snapshots) {
  const safeSnapshots = Array.isArray(snapshots) ? snapshots : [];
  const groups = new Map();
  let latestBackupAt = null;
  let latestBackupTime = 0;

  for (const snapshot of safeSnapshots) {
    const rawJobName = String(snapshot?.jobName || '').trim();
    const sourcePath = normalizeSourcePath(snapshot?.sourcePath);
    const key = getBackupJobKey(snapshot);
    const createdAtTime = getSnapshotCreatedAtTime(snapshot);

    if (createdAtTime > latestBackupTime) {
      latestBackupAt = snapshot.createdAt;
      latestBackupTime = createdAtTime;
    }

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        jobName: normalizeBackupJobName(rawJobName),
        sourcePath,
        snapshotCount: 0,
        latestSnapshotId: null,
        latestCreatedAt: '',
        latestFileCount: 0,
        latestTime: 0,
      });
    }

    const group = groups.get(key);
    group.snapshotCount += 1;

    if (createdAtTime >= group.latestTime) {
      group.sourcePath = sourcePath;
      group.latestSnapshotId = snapshot?.snapshotId || null;
      group.latestCreatedAt = snapshot?.createdAt || '';
      group.latestFileCount = getSnapshotFileCount(snapshot);
      group.latestTime = createdAtTime;
    }
  }

  const jobs = [...groups.values()]
    .sort((a, b) => b.latestTime - a.latestTime || a.jobName.localeCompare(b.jobName))
    .map(({ latestTime, ...job }) => job);

  return {
    jobCount: jobs.length,
    snapshotCount: safeSnapshots.length,
    latestBackupAt,
    jobs,
  };
}

export function buildBackupJobTimeline(snapshots, jobKey) {
  const safeSnapshots = Array.isArray(snapshots) ? snapshots : [];
  const selectedKey = String(jobKey || '').trim();
  if (!selectedKey) return null;

  const matchingSnapshots = safeSnapshots
    .filter((snapshot) => getBackupJobKey(snapshot) === selectedKey)
    .map((snapshot) => ({
      snapshotId: snapshot?.snapshotId || '',
      createdAt: snapshot?.createdAt || '',
      sourcePath: normalizeSourcePath(snapshot?.sourcePath),
      fileCount: getSnapshotFileCount(snapshot),
      createdAtTime: getSnapshotCreatedAtTime(snapshot),
    }))
    .sort((a, b) => b.createdAtTime - a.createdAtTime || a.snapshotId.localeCompare(b.snapshotId));

  if (matchingSnapshots.length === 0) return null;

  const latestSnapshot = matchingSnapshots[0];
  const rawJobName = String(safeSnapshots.find((snapshot) => getBackupJobKey(snapshot) === selectedKey)?.jobName || '').trim();
  const sourcePath = latestSnapshot.sourcePath;
  const timelineSnapshots = matchingSnapshots.map(({ createdAtTime, ...snapshot }) => snapshot);

  return {
    key: selectedKey,
    jobName: normalizeBackupJobName(rawJobName),
    sourcePath,
    snapshotCount: timelineSnapshots.length,
    latestSnapshotId: latestSnapshot.snapshotId || null,
    latestCreatedAt: latestSnapshot.createdAt,
    latestFileCount: latestSnapshot.fileCount,
    snapshots: timelineSnapshots,
  };
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

const DEVICE_HEALTH_LABELS = {
  healthy: '健康',
  attention: '需关注',
  offline: '离线',
  unknown: '未知',
};

const DEVICE_HEALTH_REASONS = {
  healthy: '最近备份有效',
  attention: '缺少有效备份',
  offline: '设备离线',
  unknown: '状态未知',
};

const DEVICE_HEALTH_SORT_ORDER = {
  attention: 0,
  offline: 1,
  unknown: 2,
  healthy: 3,
};

function getValidDateTime(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeDeviceText(value) {
  const text = String(value || '').trim();
  return text || 'unknown';
}

function normalizeSnapshotCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getDeviceDisplayName(device) {
  return normalizeDeviceText(device?.hostname || device?.deviceId);
}

export function getDeviceBackupHealthStatus(device, now = new Date()) {
  const status = device?.status;
  if (status === 'offline') return 'offline';
  if (status !== 'online') return 'unknown';

  const snapshotCount = normalizeSnapshotCount(device?.snapshotCount);
  const backupTime = getValidDateTime(device?.lastBackupAt);
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);

  if (snapshotCount > 0 && backupTime > 0 && backupTime <= nowTime) {
    return 'healthy';
  }
  return 'attention';
}

export function buildDeviceBackupHealth(devices, now = new Date()) {
  const summary = {
    healthy: 0,
    attention: 0,
    offline: 0,
    unknown: 0,
    total: 0,
  };

  const safeDevices = Array.isArray(devices) ? devices : [];
  const items = safeDevices.map((device) => {
    const healthStatus = getDeviceBackupHealthStatus(device, now);
    summary[healthStatus] += 1;
    summary.total += 1;

    return {
      deviceId: normalizeDeviceText(device?.deviceId),
      hostname: getDeviceDisplayName(device),
      ipAddress: normalizeDeviceText(device?.ipAddress),
      status: normalizeDeviceStatus(device?.status),
      healthStatus,
      healthLabel: DEVICE_HEALTH_LABELS[healthStatus],
      healthReason: DEVICE_HEALTH_REASONS[healthStatus],
      snapshotCount: normalizeSnapshotCount(device?.snapshotCount),
      lastHeartbeatAt: device?.lastHeartbeatAt || '',
      lastBackupAt: device?.lastBackupAt || '',
    };
  }).sort((a, b) => (
    DEVICE_HEALTH_SORT_ORDER[a.healthStatus] - DEVICE_HEALTH_SORT_ORDER[b.healthStatus]
    || a.hostname.localeCompare(b.hostname)
    || a.deviceId.localeCompare(b.deviceId)
  ));

  return { summary, items };
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
  const eventTotalCountEl = doc.getElementById('event-total-count');
  const eventInfoCountEl = doc.getElementById('event-info-count');
  const eventErrorCountEl = doc.getElementById('event-error-count');
  const eventLatestMessageEl = doc.getElementById('event-latest-message');

  const deviceHealthHealthyCountEl = doc.getElementById('device-health-healthy-count');
  const deviceHealthAttentionCountEl = doc.getElementById('device-health-attention-count');
  const deviceHealthOfflineCountEl = doc.getElementById('device-health-offline-count');
  const deviceHealthUnknownCountEl = doc.getElementById('device-health-unknown-count');
  const deviceHealthListEl = doc.getElementById('device-health-list');

  const EVENT_LOG_VISIBLE_LIMIT = 50;
  let eventTotalCount = 0;
  let eventInfoCount = 0;
  let eventErrorCount = 0;
  const retentionDeviceName = doc.getElementById('retention-device-name');
  const retentionKeepLastInput = doc.getElementById('retention-keep-last');
  const retentionKeepCountEl = doc.getElementById('retention-keep-count');
  const retentionDeleteCountEl = doc.getElementById('retention-delete-count');
  const retentionPlanListEl = doc.getElementById('retention-plan-list');
  const backupJobsDeviceName = doc.getElementById('backup-jobs-device-name');
  const backupJobsTotalCountEl = doc.getElementById('backup-jobs-total-count');
  const backupJobsSnapshotCountEl = doc.getElementById('backup-jobs-snapshot-count');
  const backupJobsLastBackupEl = doc.getElementById('backup-jobs-last-backup');
  const backupJobsListEl = doc.getElementById('backup-jobs-list');
  const backupJobDetailDeviceName = doc.getElementById('backup-job-detail-device-name');
  const backupJobDetailTitleEl = doc.getElementById('backup-job-detail-title');
  const backupJobDetailSourceEl = doc.getElementById('backup-job-detail-source');
  const backupJobDetailCountEl = doc.getElementById('backup-job-detail-count');
  const backupJobDetailLatestEl = doc.getElementById('backup-job-detail-latest');
  const backupJobDetailListEl = doc.getElementById('backup-job-detail-list');
  const fleetTotalEl = doc.querySelector('[data-testid="fleet-total"]');
  const fleetOnlineEl = doc.querySelector('[data-testid="fleet-online"]');
  const fleetOfflineEl = doc.querySelector('[data-testid="fleet-offline"]');
  const fleetSnapshotsEl = doc.querySelector('[data-testid="fleet-snapshots"]');

  let selectedDeviceId = null;
  let selectedSnapshotId = null;
  let selectedBackupJobKey = null;
  let cachedSnapshots = [];
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
    if (!eventLogEl) return;
    const eventMessage = String(msg || '');

    let eventType = type;
    if (eventType !== 'info' && eventType !== 'error') {
      eventType = 'info';
    }

    eventTotalCount++;
    if (eventType === 'info') {
      eventInfoCount++;
    } else if (eventType === 'error') {
      eventErrorCount++;
    }

    if (eventTotalCountEl) {
      eventTotalCountEl.textContent = String(eventTotalCount);
    }
    if (eventInfoCountEl) {
      eventInfoCountEl.textContent = String(eventInfoCount);
    }
    if (eventErrorCountEl) {
      eventErrorCountEl.textContent = String(eventErrorCount);
    }
    if (eventLatestMessageEl) {
      eventLatestMessageEl.textContent = eventMessage;
    }

    const entry = doc.createElement('div');
    entry.className = 'event-entry event-' + eventType;
    entry.setAttribute('data-testid', 'event-entry');
    entry.setAttribute('data-event-type', eventType);

    const timeEl = doc.createElement('span');
    timeEl.className = 'event-entry-time';
    timeEl.setAttribute('data-testid', 'event-entry-time');
    timeEl.textContent = '[' + new Date().toLocaleTimeString() + '] ';

    const typeEl = doc.createElement('span');
    typeEl.className = 'event-entry-type';
    typeEl.setAttribute('data-testid', 'event-entry-type');
    typeEl.textContent = eventType;

    const messageEl = doc.createElement('span');
    messageEl.className = 'event-entry-message';
    messageEl.setAttribute('data-testid', 'event-entry-message');
    messageEl.textContent = eventMessage;

    entry.appendChild(timeEl);
    entry.appendChild(typeEl);
    entry.appendChild(messageEl);

    eventLogEl.prepend(entry);

    if (eventLogEl.children) {
      while (eventLogEl.children.length > EVENT_LOG_VISIBLE_LIMIT) {
        if (eventLogEl.removeChild && eventLogEl.lastChild) {
          eventLogEl.removeChild(eventLogEl.lastChild);
        } else {
          eventLogEl.children.pop();
          if (typeof eventLogEl.textContent === 'string') {
            eventLogEl.textContent = eventLogEl.children.map(c => c.textContent || '').join('');
          }
        }
      }
    }
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
      renderDeviceBackupHealth(devices);
      logEvent('已加载 ' + devices.length + ' 台设备', 'info');
    } catch (err) {
      renderDeviceBackupHealth([]);
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

  function selectDevice(device) {
    selectedDeviceId = device.deviceId;
    selectedSnapshotId = null;
    selectedBackupJobKey = null;
    cachedSnapshots = [];
    setBackupJobDetailPlaceholder('加载中…', device.deviceId);
    renderDeviceDetail(device);
    renderFilteredDevices();
    fetchSnapshots(device.deviceId);
    fetchRetentionPlan(device.deviceId);
  }

  function setDeviceHealthCounts(summary) {
    if (deviceHealthHealthyCountEl) deviceHealthHealthyCountEl.textContent = String(summary.healthy);
    if (deviceHealthAttentionCountEl) deviceHealthAttentionCountEl.textContent = String(summary.attention);
    if (deviceHealthOfflineCountEl) deviceHealthOfflineCountEl.textContent = String(summary.offline);
    if (deviceHealthUnknownCountEl) deviceHealthUnknownCountEl.textContent = String(summary.unknown);
  }

  function appendDeviceHealthField(parent, testId, value) {
    const field = doc.createElement('span');
    field.setAttribute('data-testid', testId);
    field.textContent = value;
    parent.appendChild(field);
    return field;
  }

  function renderDeviceBackupHealth(devices) {
    const health = buildDeviceBackupHealth(devices);
    setDeviceHealthCounts(health.summary);
    clearElement(deviceHealthListEl);
    if (!deviceHealthListEl) return;

    if (health.items.length === 0) {
      const item = doc.createElement('li');
      item.className = 'placeholder';
      item.textContent = '暂无设备健康数据';
      if (typeof deviceHealthListEl.appendChild === 'function') {
        deviceHealthListEl.appendChild(item);
      }
      return;
    }

    health.items.forEach(function (item) {
      const row = doc.createElement('li');
      row.className = 'device-health-item device-health-' + item.healthStatus
        + (item.deviceId === selectedDeviceId ? ' selected' : '');
      row.setAttribute('data-testid', 'device-health-item');
      row.setAttribute('data-device-id', item.deviceId);
      row.setAttribute('data-health-status', item.healthStatus);
      row.dataset.deviceId = item.deviceId;

      const sourceDevice = cachedDevices.find((device) => device.deviceId === item.deviceId) || {
        deviceId: item.deviceId,
        hostname: item.hostname,
        ipAddress: item.ipAddress,
        status: item.status,
        snapshotCount: item.snapshotCount,
        lastHeartbeatAt: item.lastHeartbeatAt,
        lastBackupAt: item.lastBackupAt,
      };

      row.addEventListener('click', function () {
        selectDevice(sourceDevice);
      });

      appendDeviceHealthField(row, 'device-health-name', item.hostname);
      appendDeviceHealthField(row, 'device-health-device-id', item.deviceId);
      appendDeviceHealthField(row, 'device-health-ip', item.ipAddress);
      appendDeviceHealthField(row, 'device-health-status', item.healthLabel);
      appendDeviceHealthField(row, 'device-health-reason', item.healthReason);
      appendDeviceHealthField(row, 'device-health-snapshots', String(item.snapshotCount) + ' 快照');
      appendDeviceHealthField(row, 'device-health-heartbeat', formatLastHeartbeat(item.lastHeartbeatAt));
      appendDeviceHealthField(row, 'device-health-backup', formatLastBackup(item.lastBackupAt));

      if (typeof deviceHealthListEl.appendChild === 'function') {
        deviceHealthListEl.appendChild(row);
      }
    });
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
        selectDevice(device);
      });

      deviceListEl.appendChild(li);
    });
  }

  function setBackupJobsCounts(jobCount, snapshotCount, latestBackupAt) {
    if (backupJobsTotalCountEl) backupJobsTotalCountEl.textContent = String(jobCount);
    if (backupJobsSnapshotCountEl) backupJobsSnapshotCountEl.textContent = String(snapshotCount);
    if (backupJobsLastBackupEl) backupJobsLastBackupEl.textContent = formatLastBackup(latestBackupAt);
  }

  function setBackupJobsPlaceholder(message) {
    clearElement(backupJobsListEl);
    setBackupJobsCounts(0, 0, null);
    if (!backupJobsListEl) return;
    const item = doc.createElement('li');
    item.className = 'placeholder';
    item.textContent = message;
    backupJobsListEl.appendChild(item);
  }

  function setBackupJobDetailSummary(title, sourcePath, snapshotCount, latestBackupAt) {
    if (backupJobDetailTitleEl) backupJobDetailTitleEl.textContent = title;
    if (backupJobDetailSourceEl) backupJobDetailSourceEl.textContent = 'sourcePath: ' + sourcePath;
    if (backupJobDetailCountEl) backupJobDetailCountEl.textContent = String(snapshotCount);
    if (backupJobDetailLatestEl) backupJobDetailLatestEl.textContent = formatLastBackup(latestBackupAt);
  }

  function setBackupJobDetailPlaceholder(message, deviceId) {
    if (backupJobDetailDeviceName) backupJobDetailDeviceName.textContent = deviceId ? '— ' + deviceId : '';
    setBackupJobDetailSummary('未选择', '—', 0, null);
    clearElement(backupJobDetailListEl);
    if (!backupJobDetailListEl) return;

    const item = doc.createElement('li');
    item.className = 'placeholder';
    item.setAttribute('data-testid', 'backup-job-detail-empty');
    item.textContent = message;
    backupJobDetailListEl.appendChild(item);
  }

  function renderBackupJobDetail(jobKey, snapshots, deviceId) {
    if (backupJobDetailDeviceName) backupJobDetailDeviceName.textContent = deviceId ? '— ' + deviceId : '';

    const timeline = buildBackupJobTimeline(snapshots, jobKey);
    if (!timeline) {
      setBackupJobDetailPlaceholder('请选择一个备份任务', deviceId);
      return;
    }

    setBackupJobDetailSummary(timeline.jobName, timeline.sourcePath, timeline.snapshotCount, timeline.latestCreatedAt);
    clearElement(backupJobDetailListEl);
    if (!backupJobDetailListEl) return;

    timeline.snapshots.forEach(function (snapshot) {
      const item = doc.createElement('li');
      item.className = 'backup-job-timeline-item'
        + (snapshot.snapshotId && snapshot.snapshotId === selectedSnapshotId ? ' selected' : '');
      item.setAttribute('data-testid', 'backup-job-timeline-item');
      item.dataset.snapshotId = snapshot.snapshotId;
      item.addEventListener('click', function () {
        const safeSnapshotId = String(snapshot.snapshotId || '').trim();
        if (!safeSnapshotId) return;
        const siblings = backupJobDetailListEl.children || [];
        for (let i = 0; i < siblings.length; i++) {
          if (siblings[i].className && siblings[i].className.indexOf('backup-job-timeline-item') === 0) {
            siblings[i].className = 'backup-job-timeline-item';
          }
        }
        item.className = 'backup-job-timeline-item selected';
        selectSnapshotForDetail(deviceId, safeSnapshotId);
      });

      const id = doc.createElement('span');
      id.className = 'backup-job-timeline-id';
      id.setAttribute('data-testid', 'backup-job-timeline-id');
      id.textContent = snapshot.snapshotId ? snapshot.snapshotId.slice(0, 8) + '…' : 'unknown';

      const created = doc.createElement('span');
      created.className = 'backup-job-timeline-created';
      created.setAttribute('data-testid', 'backup-job-timeline-created');
      created.textContent = '创建时间 ' + formatLastBackup(snapshot.createdAt);

      const fileCount = doc.createElement('span');
      fileCount.className = 'backup-job-timeline-file-count';
      fileCount.setAttribute('data-testid', 'backup-job-timeline-file-count');
      fileCount.textContent = String(snapshot.fileCount || 0) + ' files';

      const source = doc.createElement('span');
      source.className = 'backup-job-timeline-source';
      source.setAttribute('data-testid', 'backup-job-timeline-source');
      source.textContent = snapshot.sourcePath;

      item.appendChild(id);
      item.appendChild(created);
      item.appendChild(fileCount);
      item.appendChild(source);
      backupJobDetailListEl.appendChild(item);
    });
  }

  function renderBackupJobsOverview(snapshots, deviceId) {
    if (!backupJobsListEl) return;
    if (backupJobsDeviceName) backupJobsDeviceName.textContent = '— ' + deviceId;

    const overview = buildBackupJobOverview(snapshots);
    setBackupJobsCounts(overview.jobCount, overview.snapshotCount, overview.latestBackupAt);
    clearElement(backupJobsListEl);

    if (overview.jobs.length === 0) {
      const item = doc.createElement('li');
      item.className = 'placeholder';
      item.textContent = '暂无备份任务';
      backupJobsListEl.appendChild(item);
      return;
    }

    overview.jobs.forEach(function (job) {
      const item = doc.createElement('li');
      item.className = 'backup-job-item' + (job.key === selectedBackupJobKey ? ' selected' : '');
      item.setAttribute('data-testid', 'backup-job-item');
      item.dataset.backupJobKey = job.key;
      item.addEventListener('click', function () {
        selectedBackupJobKey = job.key;
        renderBackupJobsOverview(cachedSnapshots, deviceId);
        renderBackupJobDetail(selectedBackupJobKey, cachedSnapshots, deviceId);
      });

      const name = doc.createElement('span');
      name.className = 'backup-job-name';
      name.setAttribute('data-testid', 'backup-job-name');
      name.textContent = job.jobName;

      const source = doc.createElement('span');
      source.className = 'backup-job-source';
      source.setAttribute('data-testid', 'backup-job-source');
      source.textContent = job.sourcePath;

      const meta = doc.createElement('span');
      meta.className = 'backup-job-meta';
      meta.setAttribute('data-testid', 'backup-job-meta');
      meta.textContent = String(job.snapshotCount) + ' 快照 · 最近 '
        + formatLastBackup(job.latestCreatedAt) + ' · '
        + String(job.latestFileCount || 0) + ' files';

      item.appendChild(name);
      item.appendChild(source);
      item.appendChild(meta);
      backupJobsListEl.appendChild(item);
    });
  }

  async function fetchSnapshots(deviceId) {
    snapshotDeviceName.textContent = '— ' + deviceId;
    snapshotListEl.innerHTML = '<li class="placeholder">加载中…</li>';
    selectedBackupJobKey = null;
    cachedSnapshots = [];
    if (backupJobsDeviceName) backupJobsDeviceName.textContent = '— ' + deviceId;
    setBackupJobsPlaceholder('加载中…');
    setBackupJobDetailPlaceholder('加载中…', deviceId);

    try {
      const res = await fetchImpl('/api/devices/' + encodeURIComponent(deviceId) + '/snapshots');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const snapshots = await res.json();
      cachedSnapshots = Array.isArray(snapshots) ? snapshots : [];
      renderSnapshots(cachedSnapshots, deviceId);
      renderBackupJobsOverview(cachedSnapshots, deviceId);
      renderBackupJobDetail(null, cachedSnapshots, deviceId);
      renderSnapshotDiffControls(cachedSnapshots, deviceId);
      logEvent('已加载 ' + cachedSnapshots.length + ' 个快照 (' + deviceId + ')', 'info');
    } catch (err) {
      cachedSnapshots = [];
      selectedBackupJobKey = null;
      snapshotListEl.innerHTML = '<li class="placeholder">加载失败</li>';
      setBackupJobsPlaceholder('加载失败');
      setBackupJobDetailPlaceholder('加载失败', deviceId);
      setSnapshotDiffPlaceholder('加载失败');
      setRestoreDryRunPlaceholder('加载失败');
      logEvent('加载快照失败: ' + err.message, 'error');
    }
  }

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
        selectSnapshotForDetail(deviceId, snap.snapshotId);
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
