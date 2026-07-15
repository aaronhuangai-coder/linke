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

export function buildReleaseHealthViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      versionText: '—',
      dataDirText: '—',
      timestampText: '—',
      messageText: '健康检查失败: ' + errorMessage,
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      versionText: '—',
      dataDirText: '—',
      timestampText: '—',
      messageText: '点击刷新状态获取 /api/health',
    };
  }

  let status = payload.status;
  const hasStatus = 'status' in payload;
  const hasVersion = 'version' in payload;
  const hasChecks = 'checks' in payload;
  const hasTimestamp = 'timestamp' in payload;

  if (!hasStatus && !hasVersion && !hasChecks && !hasTimestamp) {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      versionText: '—',
      dataDirText: '—',
      timestampText: '—',
      messageText: '点击刷新状态获取 /api/health',
    };
  }

  if (hasStatus && status !== 'ok' && status !== 'degraded') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      versionText: '—',
      dataDirText: '—',
      timestampText: '—',
      messageText: '点击刷新状态获取 /api/health',
    };
  }

  const checks = payload.checks && typeof payload.checks === 'object' ? payload.checks : {};
  const dataDirReadable = checks.dataDirReadable;
  let hasFailedCheck = false;
  for (const key in checks) {
    if (checks[key] !== 'ok') {
      hasFailedCheck = true;
      break;
    }
  }

  if (!hasStatus) {
    status = hasFailedCheck ? 'degraded' : 'ok';
  } else if (hasFailedCheck) {
    status = 'degraded';
  }

  const dataDirText = dataDirReadable === 'ok'
    ? '可读'
    : (dataDirReadable === 'unavailable' ? '不可用' : '未知');

  return {
    statusKey: status,
    statusText: status === 'degraded' ? '降级' : '正常',
    versionText: payload.version ? String(payload.version) : '—',
    dataDirText,
    timestampText: String(payload.timestamp || '—'),
    messageText: status === 'degraded'
      ? 'GET /api/health 成功，但 checks 显示服务降级'
      : 'GET /api/health 成功',
  };
}

function formatReadinessDisplayValue(value) {
  if (value === undefined || value === null || value === '') return '—';
  const text = String(value);
  if (text.includes('/') || text.includes('\\')) return '[redacted]';
  return text;
}

export function buildReleaseReadinessViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      expectedVersionText: '—',
      actualVersionText: '—',
      failedCountText: '—',
      timestampText: '—',
      checks: [],
      messageText: '发布就绪检查失败: ' + errorMessage,
    };
  }

  if (!payload || typeof payload !== 'object' || typeof payload.ready !== 'boolean') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      expectedVersionText: '—',
      actualVersionText: '—',
      failedCountText: '—',
      timestampText: '—',
      checks: [],
      messageText: '点击检查就绪获取 /api/release-readiness',
    };
  }

  const checks = Array.isArray(payload.checks)
    ? payload.checks.map((check) => ({
      id: formatReadinessDisplayValue(check?.id),
      ok: check?.ok === true,
      expected: formatReadinessDisplayValue(check?.expected),
      actual: formatReadinessDisplayValue(check?.actual),
    }))
    : [];
  const failedCount = checks.filter((check) => !check.ok).length;
  const ready = payload.ready === true;

  return {
    statusKey: ready ? 'ready' : 'not-ready',
    statusText: ready ? '已就绪' : '未就绪',
    expectedVersionText: formatReadinessDisplayValue(payload.expectedVersion),
    actualVersionText: formatReadinessDisplayValue(payload.actualVersion),
    failedCountText: String(failedCount),
    timestampText: formatReadinessDisplayValue(payload.checkedAt),
    checks,
    messageText: ready
      ? 'GET /api/release-readiness 成功，发布就绪'
      : 'GET /api/release-readiness 成功，存在 ' + String(failedCount) + ' 项未就绪',
  };
}

function formatGoldStatusText(status) {
  if (status === 'ready') return '已就绪';
  if (status === 'partial') return '部分就绪';
  if (status === 'blocked') return '阻塞';
  return '未检查';
}

function formatGoldItemStatusText(status) {
  if (status === 'ready') return '已就绪';
  if (status === 'partial') return '部分就绪';
  if (status === 'blocked') return '阻塞';
  return '未知';
}

function formatGoldCount(value) {
  return Number.isFinite(value) ? String(value) : '—';
}

function formatGoldEvidence(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '')).filter(Boolean).join(', ')
    : '';
}

function formatHardeningStatusText(status) {
  if (status === 'ready') return '已就绪';
  if (status === 'partial') return '部分就绪';
  if (status === 'blocked') return '阻塞';
  return '未检查';
}

function formatHardeningBoolean(value) {
  if (value === true) return '已配置';
  if (value === false) return '未配置';
  return '—';
}

function formatHardeningNumber(value) {
  return Number.isFinite(value) ? String(value) : '—';
}

function formatHardeningErrorMessage(value) {
  const text = String(value || '').trim();
  if (!text) return 'unknown';
  const lowerText = text.toLowerCase();
  const sensitiveKeywords = [
    'authorization',
    'bearer',
    'token',
    'password',
    'secret',
    'api key',
    'apikey',
    'credential',
    'private key',
    'access key',
  ];
  if (text.includes('/') || text.includes('\\')) return '[redacted]';
  if (sensitiveKeywords.some((keyword) => lowerText.includes(keyword))) return '[redacted]';
  return text;
}

function formatSupervisorState(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  if (text.includes('/') || text.includes('\\')) return '[redacted]';
  if (!/^[a-zA-Z0-9_.:-]+$/.test(text)) return '[redacted]';
  return text.slice(0, 80);
}

function formatSupervisorSafetyFlag(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'unknown';
}

function buildSupervisorSafetyText(safety) {
  const source = safety && typeof safety === 'object' ? safety : {};
  return [
    'launchctl:' + formatSupervisorSafetyFlag(source.launchctlCalled),
    'process:' + formatSupervisorSafetyFlag(source.processListRead),
    'install:' + formatSupervisorSafetyFlag(source.supervisorInstalled),
    'metadata:' + formatSupervisorSafetyFlag(source.metadataWritten),
    'NAS:' + formatSupervisorSafetyFlag(source.nasConnected),
    'backup:' + formatSupervisorSafetyFlag(source.backupTriggered),
    'restore:' + formatSupervisorSafetyFlag(source.restoreTriggered),
    'remote:' + formatSupervisorSafetyFlag(source.remoteCommandExecuted),
  ].join(' · ');
}

export function buildHardeningStatusViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      authText: '—',
      scopedTokensText: '—',
      rateLimitText: '—',
      auditRetentionText: '—',
      restoreRootText: '—',
      requestLimitText: '—',
      writeRoutesText: '—',
      messageText: '硬化状态检查失败: ' + formatHardeningErrorMessage(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object' || !['ready', 'partial', 'blocked'].includes(payload.status)) {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      authText: '—',
      scopedTokensText: '—',
      rateLimitText: '—',
      auditRetentionText: '—',
      restoreRootText: '—',
      requestLimitText: '—',
      writeRoutesText: '—',
      messageText: '点击检查硬化获取 /api/hardening-status',
    };
  }

  const hardening = payload.hardening && typeof payload.hardening === 'object' ? payload.hardening : {};
  const writeRoutes = Array.isArray(hardening.writeRoutes) ? hardening.writeRoutes : [];
  const statusKey = payload.status;

  return {
    statusKey,
    statusText: formatHardeningStatusText(statusKey),
    authText: formatHardeningBoolean(hardening.authConfigured),
    scopedTokensText: formatHardeningBoolean(hardening.scopedTokensConfigured),
    rateLimitText: formatHardeningBoolean(hardening.rateLimitConfigured),
    auditRetentionText: formatHardeningBoolean(hardening.auditRetentionConfigured),
    restoreRootText: formatHardeningBoolean(hardening.restoreRootConfigured),
    requestLimitText: formatHardeningNumber(hardening.requestBodyLimitBytes),
    writeRoutesText: String(writeRoutes.length),
    messageText: statusKey === 'ready'
      ? 'GET /api/hardening-status 成功，硬化状态已就绪'
      : (statusKey === 'blocked'
        ? 'GET /api/hardening-status 成功，硬化状态仍有阻塞项'
        : 'GET /api/hardening-status 成功，生产硬化仍为 partial'),
  };
}

export function buildSupervisorStatusViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      stateText: '—',
      installedText: '—',
      managedText: '—',
      launchdText: '—',
      watchdogText: '—',
      monitoringText: '—',
      recoveryText: '—',
      safetyText: '—',
      messageText: 'Supervisor 状态检查失败: ' + formatHardeningErrorMessage(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object' || !['ready', 'partial', 'blocked'].includes(payload.status)) {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      stateText: '—',
      installedText: '—',
      managedText: '—',
      launchdText: '—',
      watchdogText: '—',
      monitoringText: '—',
      recoveryText: '—',
      safetyText: '—',
      messageText: '点击检查 Supervisor 获取 /api/supervisor-status',
    };
  }

  const supervisor = payload.supervisor && typeof payload.supervisor === 'object' ? payload.supervisor : {};
  const statusKey = payload.status;
  return {
    statusKey,
    statusText: formatHardeningStatusText(statusKey),
    stateText: formatSupervisorState(supervisor.state),
    installedText: formatHardeningBoolean(supervisor.installed),
    managedText: formatHardeningBoolean(supervisor.managed),
    launchdText: formatHardeningBoolean(supervisor.launchdConfigured),
    watchdogText: formatHardeningBoolean(supervisor.watchdogConfigured),
    monitoringText: formatHardeningBoolean(supervisor.monitoringConfigured),
    recoveryText: formatHardeningBoolean(supervisor.recoveryConfigured),
    safetyText: buildSupervisorSafetyText(payload.safety),
    messageText: statusKey === 'ready'
      ? 'GET /api/supervisor-status 成功，Supervisor 状态已就绪'
      : (statusKey === 'blocked'
        ? 'GET /api/supervisor-status 成功，Supervisor 状态仍有阻塞项'
        : 'GET /api/supervisor-status 成功，Supervisor 仍为 not_configured / partial'),
  };
}

function formatAuditStatusText(status) {
  if (status === 'ready') return '已加载';
  if (status === 'empty') return '无事件';
  if (status === 'error') return '加载失败';
  return '未检查';
}

function formatAuditDisplayString(value, maxLength = 160) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, maxLength);
}

function formatAuditDisplayNumber(value) {
  return Number.isFinite(value) ? String(value) : '';
}

function buildAuditEventDisplay(event) {
  const source = event && typeof event === 'object' ? event : {};
  const type = formatAuditDisplayString(source.type) || 'unknown';
  const createdAt = formatAuditDisplayString(source.createdAt) || '—';
  const method = formatAuditDisplayString(source.method);
  const path = formatAuditDisplayString(source.path);
  const outcome = formatAuditDisplayString(source.outcome);
  const deviceId = formatAuditDisplayString(source.deviceId);
  const snapshotId = formatAuditDisplayString(source.snapshotId);
  const requestId = formatAuditDisplayString(source.requestId);
  const message = formatAuditDisplayString(source.message);
  const statusCode = formatAuditDisplayNumber(source.statusCode);
  const fileCount = formatAuditDisplayNumber(source.fileCount);

  const details = [
    method && path ? method + ' ' + path : '',
    outcome ? 'outcome=' + outcome : '',
    statusCode ? 'status=' + statusCode : '',
    deviceId ? 'device=' + deviceId : '',
    snapshotId ? 'snapshot=' + snapshotId : '',
    fileCount ? 'files=' + fileCount : '',
    requestId ? 'request=' + requestId : '',
    message ? 'message=' + message : '',
  ].filter(Boolean);

  return {
    createdAt,
    type,
    deviceId: deviceId || '—',
    statusCodeText: statusCode || '—',
    summaryText: createdAt + ' · ' + type + (details.length ? ' · ' + details.join(' · ') : ''),
  };
}

export function buildAuditLogViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: formatAuditStatusText('error'),
      eventCountText: '—',
      latestTypeText: '—',
      latestDeviceText: '—',
      events: [],
      messageText: '审计日志加载失败: ' + formatHardeningErrorMessage(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events)) {
    return {
      statusKey: 'unknown',
      statusText: formatAuditStatusText('unknown'),
      eventCountText: '—',
      latestTypeText: '—',
      latestDeviceText: '—',
      events: [],
      messageText: '点击查看审计日志获取 /api/audit-log',
    };
  }

  const events = payload.events.map(buildAuditEventDisplay);
  if (events.length === 0) {
    return {
      statusKey: 'empty',
      statusText: formatAuditStatusText('empty'),
      eventCountText: '0',
      latestTypeText: '—',
      latestDeviceText: '—',
      events,
      messageText: 'GET /api/audit-log 成功，暂无审计事件',
    };
  }

  return {
    statusKey: 'ready',
    statusText: formatAuditStatusText('ready'),
    eventCountText: String(events.length),
    latestTypeText: events[0].type,
    latestDeviceText: events[0].deviceId,
    events,
    messageText: 'GET /api/audit-log 成功，已加载 ' + String(events.length) + ' 条 sanitized 审计事件',
  };
}

export function buildGoldReadinessViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      readyCountText: '—',
      partialCountText: '—',
      blockedCountText: '—',
      totalCountText: '—',
      generatedAtText: '—',
      items: [],
      messageText: 'Gold 就绪检查失败: ' + errorMessage,
    };
  }

  if (!payload || typeof payload !== 'object' || !['ready', 'partial', 'blocked'].includes(payload.status)) {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      readyCountText: '—',
      partialCountText: '—',
      blockedCountText: '—',
      totalCountText: '—',
      generatedAtText: '—',
      items: [],
      messageText: '点击检查 Gold 获取 /api/gold-readiness',
    };
  }

  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  const items = Array.isArray(payload.items)
    ? payload.items.map((item) => ({
      id: String(item?.id || 'unknown'),
      area: String(item?.area || 'unknown'),
      label: String(item?.label || item?.id || 'unknown'),
      status: ['ready', 'partial', 'blocked'].includes(item?.status) ? item.status : 'unknown',
      statusText: formatGoldItemStatusText(item?.status),
      evidenceText: formatGoldEvidence(item?.evidence),
      nextStep: String(item?.nextStep || '—'),
    }))
    : [];

  return {
    statusKey: payload.status,
    statusText: formatGoldStatusText(payload.status),
    readyCountText: formatGoldCount(summary.ready),
    partialCountText: formatGoldCount(summary.partial),
    blockedCountText: formatGoldCount(summary.blocked),
    totalCountText: formatGoldCount(summary.total),
    generatedAtText: String(payload.generatedAt || '—'),
    items,
    messageText: payload.status === 'blocked'
      ? 'GET /api/gold-readiness 成功，Gold 仍有阻塞项'
      : (payload.status === 'partial'
        ? 'GET /api/gold-readiness 成功，Gold 部分就绪'
        : 'GET /api/gold-readiness 成功，Gold 已就绪'),
  };
}

function sanitizeSupervisorInstallErrorMessage(message) {
  const raw = String(message || '').trim();
  if (!raw) return '请求失败';
  return raw
    .replace(/https?:\/\/[^\s"']+/gi, '[redacted-url]')
    .replace(/\/Users\/[^\s"']+/g, '[redacted-path]')
    .replace(/secret[-_\w]*/gi, '[redacted-secret]')
    .replace(/token[-_\w]*/gi, '[redacted-token]')
    .slice(0, 180);
}

function normalizeStringList(values) {
  return Array.isArray(values)
    ? values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
    : [];
}

const SUPERVISOR_ROLLBACK_UNINSTALL_SAFETY_KEYS = [
  'dryRun',
  'planOnly',
  'rollbackExecuted',
  'uninstallExecuted',
  'recoverySupervisorStarted',
  'launchctlCalled',
  'processListRead',
  'filesystemWritten',
  'metadataWritten',
  'supervisorInstalled',
  'supervisorStarted',
  'launchdFileWritten',
  'launchdFileRemoved',
  'previousPlistRestored',
  'nasConnected',
  'backupTriggered',
  'restoreTriggered',
  'remoteCommandExecuted',
  'sensitiveValuesReturned',
];

function buildSupervisorRollbackUninstallSafetyLines(safety) {
  const source = safety && typeof safety === 'object' ? safety : null;
  if (!source) return [];
  return SUPERVISOR_ROLLBACK_UNINSTALL_SAFETY_KEYS.map((key) => `${key}:${source[key] === true ? 'true' : 'false'}`);
}

function buildSupervisorInstallSafetyLines(safety) {
  const source = safety && typeof safety === 'object' ? safety : {};
  return [
    'launchctlCalled',
    'processListRead',
    'launchdFileWritten',
    'metadataWritten',
    'nasConnected',
    'backupTriggered',
    'restoreTriggered',
    'remoteCommandExecuted',
  ].map((key) => `${key}:${source[key] === true ? 'true' : 'false'}`);
}

const SUPERVISOR_LIFECYCLE_APPROVAL_PREVIEW_SAFETY_KEYS = [
  'dryRun',
  'hostMutation',
  'launchctlCalled',
  'filesystemWritten',
  'metadataWritten',
  'rollbackAnchorWritten',
  'auditEventWritten',
  'approvalPersisted',
  'lifecycleApplied',
  'sensitiveValuesReturned',
];

const SUPERVISOR_LIFECYCLE_APPROVAL_PREVIEW_VALIDATION_KEYS = [
  'approvalValid',
  'acknowledgementCount',
  'windowWithinLimit',
  'operationMatchesPlan',
  'configHashMatchesPlan',
  'planHashMatchesPlan',
];

function buildSupervisorLifecycleApprovalPreviewSafetyLines(safety) {
  const source = safety && typeof safety === 'object' ? safety : {};
  return SUPERVISOR_LIFECYCLE_APPROVAL_PREVIEW_SAFETY_KEYS.map((key) => `${key}:${source[key] === true ? 'true' : 'false'}`);
}

function buildSupervisorLifecycleApprovalPreviewValidationLines(validation) {
  const source = validation && typeof validation === 'object' ? validation : {};
  return SUPERVISOR_LIFECYCLE_APPROVAL_PREVIEW_VALIDATION_KEYS.map((key) => {
    if (key === 'acknowledgementCount') {
      return `${key}:${Number.isFinite(Number(source[key])) ? Number(source[key]) : 0}`;
    }
    return `${key}:${source[key] === true ? 'true' : 'false'}`;
  });
}

export function buildSupervisorLifecycleApprovalPersistencePreviewViewModel(preview, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      approvalValidText: '—',
      persistenceText: '—',
      blockers: [],
      requiredFields: [],
      validationLines: [],
      safetyLines: [],
      messageText: 'Supervisor lifecycle approval persistence preview 检查失败: ' + sanitizeSupervisorInstallErrorMessage(errorMessage),
    };
  }

  if (!preview || typeof preview !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      approvalValidText: '—',
      persistenceText: '—',
      blockers: [],
      requiredFields: [],
      validationLines: [],
      safetyLines: [],
      messageText: '点击手动 POST /api/supervisor-lifecycle-approval-persistence-preview 获取 approval persistence preview',
    };
  }

  const persistence = preview.persistence && typeof preview.persistence === 'object' ? preview.persistence : {};
  const validation = persistence.validation && typeof persistence.validation === 'object' ? persistence.validation : {};
  const statusKey = ['ready', 'partial', 'blocked'].includes(preview.state) ? preview.state : 'blocked';
  return {
    statusKey,
    statusText: statusKey === 'blocked' ? '阻塞' : formatHardeningStatusText(statusKey),
    approvalValidText: preview.approvalValid === true ? 'true' : 'false',
    persistenceText: `previewOnly:${persistence.previewOnly === true ? 'true' : 'false'} / wouldPersist:${persistence.wouldPersist === true ? 'true' : 'false'}`,
    blockers: normalizeStringList(preview.blockers),
    requiredFields: normalizeStringList(persistence.requiredRecordFields),
    validationLines: buildSupervisorLifecycleApprovalPreviewValidationLines(validation),
    safetyLines: buildSupervisorLifecycleApprovalPreviewSafetyLines(preview.safety),
    messageText: 'POST /api/supervisor-lifecycle-approval-persistence-preview 成功，仍为 blocked preview',
  };
}

export function buildSupervisorLifecycleApprovalPersistViewModel(payload, httpStatus = 0, errorMessage = '') {
  if (errorMessage) {
    return buildSupervisorLifecycleApprovalPersistencePreviewViewModel(null, errorMessage);
  }

  if (httpStatus === 201 && payload?.command === 'supervisor-lifecycle-approval-record') {
    const safeOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
    const operation = safeOperations.has(payload.operation) ? payload.operation : 'unknown';
    return {
      statusKey: 'ready',
      statusText: '已记录',
      approvalValidText: payload.approvalValid === true ? 'true' : 'false',
      persistenceText: 'approvalRecord:persisted / lifecycleApply:false',
      blockers: normalizeStringList(payload.blockersResolved),
      requiredFields: [],
      validationLines: buildSupervisorLifecycleApprovalPreviewValidationLines(payload.validation),
      safetyLines: buildSupervisorLifecycleApprovalPreviewSafetyLines(payload.safety),
      messageText: `Persisted approval record for ${operation}; this is not lifecycle apply.`,
    };
  }

  return buildSupervisorLifecycleApprovalPersistencePreviewViewModel(payload);
}

function formatSafeApprovalRecordValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'unknown';
  if (/@|secret|token|sha256:|https?:|\/Users\//i.test(raw)) return '[redacted]';
  return raw.replace(/[^\w:.-]/g, '').slice(0, 80) || 'unknown';
}

function buildSupervisorLifecycleApprovalRecordLines(records) {
  return Array.isArray(records)
    ? records.slice(0, 20).map((record) => {
      const source = record && typeof record === 'object' ? record : {};
      const operation = ['install', 'uninstall', 'rollback', 'recover'].includes(source.operation)
        ? source.operation
        : 'unknown';
      const state = ['persisted', 'persistable', 'blocked', 'ready'].includes(source.state)
        ? source.state
        : 'unknown';
      return [
        `id:${formatSafeApprovalRecordValue(source.id)}`,
        `operation:${operation}`,
        `state:${state}`,
        `approvalValid:${source.approvalValid === true ? 'true' : 'false'}`,
      ].join(' ');
    })
    : [];
}

export function buildSupervisorLifecycleApprovalRecordsViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '加载失败',
      approvalValidText: '—',
      persistenceText: '—',
      blockers: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: [],
      messageText: 'Supervisor approval records 加载失败: ' + sanitizeSupervisorInstallErrorMessage(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      approvalValidText: 'records:0',
      persistenceText: 'readOnly:true / lifecycleApply:false',
      blockers: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: ['readOnly:true', 'lifecycleApplied:false'],
      messageText: '点击手动 GET /api/supervisor-lifecycle-approval-records 查看 sanitized approval records',
    };
  }

  const records = Array.isArray(payload.records) ? payload.records : [];
  const count = Number.isFinite(Number(payload.count)) ? Number(payload.count) : records.length;
  return {
    statusKey: 'ready',
    statusText: '已保存记录',
    approvalValidText: `records:${count}`,
    persistenceText: 'readOnly:true / lifecycleApply:false',
    blockers: [],
    requiredFields: [],
    recordLines: buildSupervisorLifecycleApprovalRecordLines(records),
    validationLines: [],
    safetyLines: [
      `readOnly:${payload.safety?.readOnly === true ? 'true' : 'false'}`,
      ...buildSupervisorLifecycleApprovalPreviewSafetyLines(payload.safety),
    ],
    messageText: 'GET /api/supervisor-lifecycle-approval-records 成功，仅显示 sanitized approval records',
  };
}

function buildSupervisorLifecycleApplyReadinessSafetyLines(safety) {
  const source = safety && typeof safety === 'object' ? safety : {};
  return [
    'readOnly',
    ...SUPERVISOR_LIFECYCLE_APPROVAL_PREVIEW_SAFETY_KEYS,
  ].map((key) => `${key}:${source[key] === true ? 'true' : 'false'}`);
}

function buildSupervisorLifecycleApplyReadinessGateLines(gates) {
  const source = gates && typeof gates === 'object' ? gates : {};
  return [
    'lifecyclePlanValid',
    'applyFlag',
    'envGate',
    'approvalRecordPersisted',
    'approvalRecordValid',
    'approvalRecordOperationMatched',
    'executorImplemented',
  ].map((key) => `${key}:${source[key] === true ? 'true' : 'false'}`);
}

function buildSupervisorLifecycleApplyReadinessRecordLines(approvalRecords) {
  const source = approvalRecords && typeof approvalRecords === 'object' ? approvalRecords : {};
  const count = Number.isFinite(Number(source.count)) ? Number(source.count) : 0;
  const operationMatchCount = Number.isFinite(Number(source.operationMatchCount)) ? Number(source.operationMatchCount) : 0;
  const persistedMatchCount = Number.isFinite(Number(source.persistedMatchCount)) ? Number(source.persistedMatchCount) : 0;
  return [
    `records:${count}`,
    `operationMatches:${operationMatchCount}`,
    `persistedMatches:${persistedMatchCount}`,
  ];
}

function buildSupervisorLifecycleExecutorReadinessGateLines(gates) {
  const source = gates && typeof gates === 'object' ? gates : {};
  return [
    'lifecyclePlanValid',
    'applyReadinessValid',
    'approvalRecordReady',
    'executorImplemented',
  ].map((key) => `${key}:${source[key] === true ? 'true' : 'false'}`);
}

function sanitizeSupervisorLifecycleExecutorReadinessLine(value) {
  const line = String(value || '').trim();
  if (!line) return '';
  if (/^[a-z0-9:-]+$/i.test(line) && !/(sha256|secret|token|bearer|authorization)/i.test(line)) {
    return line;
  }
  return sanitizeSupervisorInstallErrorMessage(line);
}

export function buildSupervisorLifecycleApplyReadinessViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      approvalValidText: '—',
      persistenceText: '—',
      blockers: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: [],
      messageText: 'Supervisor lifecycle apply readiness 检查失败: ' + sanitizeSupervisorInstallErrorMessage(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      approvalValidText: 'records:0',
      persistenceText: 'readOnly:true / lifecycleApply:false',
      blockers: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: ['readOnly:true', 'lifecycleApplied:false'],
      messageText: '点击手动 POST /api/supervisor-lifecycle-apply-readiness 获取 apply readiness preflight',
    };
  }

  const statusKey = payload.approvalRecordReady === true ? 'ready' : 'blocked';
  const blockers = [
    ...normalizeStringList(payload.blockers),
    ...normalizeStringList(payload.nextBlockers).map((blocker) => `next:${blocker}`),
  ];
  return {
    statusKey,
    statusText: statusKey === 'ready' ? '批准记录就绪' : '阻塞',
    approvalValidText: `approvalRecordReady:${payload.approvalRecordReady === true ? 'true' : 'false'}`,
    persistenceText: 'readOnly:true / lifecycleApply:false',
    blockers,
    requiredFields: [],
    recordLines: buildSupervisorLifecycleApplyReadinessRecordLines(payload.approvalRecords),
    validationLines: buildSupervisorLifecycleApplyReadinessGateLines(payload.gates),
    safetyLines: buildSupervisorLifecycleApplyReadinessSafetyLines(payload.safety),
    messageText: statusKey === 'ready'
      ? 'Supervisor approval record gate ready; this is not lifecycle apply.'
      : 'POST /api/supervisor-lifecycle-apply-readiness completed; readiness remains fail-closed.',
  };
}

export function buildSupervisorLifecycleExecutorReadinessViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      approvalValidText: '—',
      persistenceText: '—',
      blockers: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: [],
      messageText: 'Supervisor lifecycle executor readiness 检查失败: ' + sanitizeSupervisorInstallErrorMessage(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      approvalValidText: 'executorReady:false',
      persistenceText: 'readOnly:true / executorReady:false',
      blockers: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: ['readOnly:true', 'lifecycleApplied:false'],
      messageText: '点击手动 POST /api/supervisor-lifecycle-executor-readiness 获取 executor readiness preflight',
    };
  }

  const statusKey = 'blocked';
  const statusText = '执行器未就绪';
  const approvalValidText = `executorReady:false / approvalRecordReady:${payload.approvalRecordReady === true ? 'true' : 'false'}`;
  const persistenceText = 'readOnly:true / executorReady:false';

  const blockers = [
    ...normalizeStringList(payload.blockers).map(sanitizeSupervisorLifecycleExecutorReadinessLine),
    ...normalizeStringList(payload.nextBlockers).map((blocker) => `next:${sanitizeSupervisorLifecycleExecutorReadinessLine(blocker)}`),
  ];

  const executorBlockers = Array.isArray(payload.executorBlockers) ? payload.executorBlockers : [];
  const requiredFields = executorBlockers.map((b) => {
    const actionId = sanitizeSupervisorLifecycleExecutorReadinessLine(b.actionId);
    const blocker = sanitizeSupervisorLifecycleExecutorReadinessLine(b.blocker);
    return `${actionId}:${blocker}:wouldRun:${b.wouldRun === true ? 'true' : 'false'}:wouldWrite:${b.wouldWrite === true ? 'true' : 'false'}`;
  });

  const safety = payload.safety && typeof payload.safety === 'object' ? payload.safety : {};
  const safetyLines = [
    'readOnly',
    ...SUPERVISOR_LIFECYCLE_APPROVAL_PREVIEW_SAFETY_KEYS,
  ].map((key) => `${key}:${safety[key] === true ? 'true' : 'false'}`);

  return {
    statusKey,
    statusText,
    approvalValidText,
    persistenceText,
    blockers,
    requiredFields,
    recordLines: [],
    validationLines: buildSupervisorLifecycleExecutorReadinessGateLines(payload.gates),
    safetyLines,
    messageText: 'POST /api/supervisor-lifecycle-executor-readiness completed; executor readiness remains fail-closed.',
  };
}

function sanitizeManifestReadinessValue(value) {
  let line = String(value || '').trim();
  if (!line) return '';

  // URL、路径、凭证、hash 与可执行命令都只作为状态码展示，不回显原值。
  line = line.replace(/https?:\/\/[^\s"']+/gi, '[redacted-url]');
  line = line.replace(/(?:\/[a-zA-Z0-9._-]+)+/g, '[redacted-path]');
  line = line.replace(/[a-zA-Z]:\\[a-zA-Z0-9._\\-]+/g, '[redacted-path]');
  line = line.replace(/(?:token|secret|bearer|authorization|auth|apiKey|credential)[-_\w]*/gi, '[redacted-token]');
  line = line.replace(/\b(?:sha256|md5|sha1):[a-fA-F0-9]+\b/g, '[redacted-hash]');
  line = line.replace(/\b[a-fA-F0-9]{32,64}\b/g, '[redacted-hash]');
  line = line.replace(/\b(?:launchctl|sudo|bash|sh|node|npm|git|curl|wget)\b.*/gi, '[redacted-command]');

  return line;
}

export function buildSupervisorLifecycleExecutorManifestReadinessViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      approvalValidText: '—',
      persistenceText: '—',
      blockers: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: [],
      messageText: 'Supervisor lifecycle executor manifest readiness 检查失败: ' + sanitizeSupervisorInstallErrorMessage(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      approvalValidText: 'manifestReady:false / executorReady:false',
      persistenceText: 'readOnly:true / executorReady:false',
      blockers: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: ['readOnly:true', 'lifecycleApplied:false'],
      messageText: '点击手动 POST /api/supervisor-lifecycle-executor-manifest-readiness 获取 executor manifest readiness preflight',
    };
  }

  const statusKey = 'blocked';
  const statusText = '执行器未就绪';
  const approvalValidText = `manifestReady:${payload.manifestReady === true ? 'true' : 'false'} / executorReady:false`;
  const persistenceText = 'readOnly:true / executorReady:false';

  const blockers = [
    ...normalizeStringList(payload.blockers).map(sanitizeManifestReadinessValue),
    ...normalizeStringList(payload.manifestBlockers).map((blocker) => `manifest:${sanitizeManifestReadinessValue(blocker)}`),
    ...normalizeStringList(payload.nextBlockers).map((blocker) => `next:${sanitizeManifestReadinessValue(blocker)}`),
  ].filter(Boolean);

  const actionManifests = Array.isArray(payload.actionManifests) ? payload.actionManifests : [];
  const requiredFields = actionManifests.map((m) => {
    const actionId = sanitizeManifestReadinessValue(m.actionId);
    const implId = sanitizeManifestReadinessValue(m.implementationId);
    const mode = sanitizeManifestReadinessValue(m.mode);
    return `action:${actionId}:impl:${implId}:mode:${mode}:wouldRun:${m.wouldRun === true ? 'true' : 'false'}:wouldWrite:${m.wouldWrite === true ? 'true' : 'false'}`;
  });

  const gates = payload.gates && typeof payload.gates === 'object' ? payload.gates : {};
  const validationLines = [
    `lifecyclePlanValid:${gates.lifecyclePlanValid === true ? 'true' : 'false'}`,
    `manifestReady:${gates.manifestReady === true ? 'true' : 'false'}`,
    `executorImplemented:${gates.executorImplemented === true ? 'true' : 'false'}`,
  ];

  const safety = payload.safety && typeof payload.safety === 'object' ? payload.safety : {};
  const safetyLines = [
    'readOnly',
    ...SUPERVISOR_LIFECYCLE_APPROVAL_PREVIEW_SAFETY_KEYS,
  ].map((key) => `${key}:${safety[key] === true ? 'true' : 'false'}`);

  return {
    statusKey,
    statusText,
    approvalValidText,
    persistenceText,
    blockers,
    requiredFields,
    recordLines: [],
    validationLines,
    safetyLines,
    messageText: 'POST /api/supervisor-lifecycle-executor-manifest-readiness completed; executor manifest readiness remains fail-closed.',
  };
}

const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_SAFETY_KEYS = [
  'readOnly',
  'dryRun',
  'hostMutation',
  'launchctlCalled',
  'processListRead',
  'filesystemWritten',
  'metadataWritten',
  'rollbackAnchorWritten',
  'auditEventWritten',
  'approvalPersisted',
  'lifecycleApplied',
  'nasConnected',
  'backupTriggered',
  'restoreTriggered',
  'remoteCommandExecuted',
  'sensitiveValuesReturned',
];

const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_COMMAND_PATTERN =
  /\b(?:launchctl|sudo|bash|sh|zsh|node|npm|pnpm|git|curl|wget|osascript|python3?|ruby|perl|php|powershell|pwsh)\b[^\n]*/gi;

const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_SECRET_PREFIX_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/gi;

function sanitizeSupervisorLifecycleGuardedRunnerReadinessValue(value, key = '') {
  const keyText = String(key || '').trim().toLowerCase();
  if (/(authorization|token|secret|password|credential|hash|hostname|username|process|pid|command|cmd|path|url)/i.test(keyText)) {
    return '[redacted]';
  }

  const raw = String(value || '').trim();
  let line = String(value || '').trim();
  if (!line) return '';

  line = line.replace(/https?:\/\/[^\s"']+/gi, '[redacted-url]');
  line = line.replace(/\b(?:localhost|[a-z0-9.-]+\.(?:local|lan|internal|example|com|net|org|io|dev|cn))(?::\d+)?\b/gi, '[redacted-host]');
  line = line.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[redacted-host]');
  line = line.replace(/[a-zA-Z]:\\[^\s"']+/g, '[redacted-path]');
  line = line.replace(/\\\\[^\s"']+/g, '[redacted-path]');
  line = line.replace(/(?:~|\.{1,2})?\/[^\s"']+/g, '[redacted-path]');
  line = line.replace(/\b(?:authorization|bearer|token|secret|password|api[-_ ]?key|credential|private[-_ ]?key)[^\s"']*/gi, '[redacted-secret]');
  line = line.replace(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_SECRET_PREFIX_PATTERN, '[redacted-secret]');
  line = line.replace(/\b(?:sha256|sha1|md5):[a-f0-9]+\b/gi, '[redacted-hash]');
  line = line.replace(/\b[a-f0-9]{32,128}\b/gi, '[redacted-hash]');
  line = line.replace(/\b(?:host(?:name)?|user(?:name)?|process\s*id|processId|pid)\s*[:=]\s*[^\s,;]+/gi, '[redacted]');
  line = line.replace(/\b(?:command|cmd|argv)\s*[:=]\s*[^\n]+/gi, '[redacted-command]');
  line = line.replace(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_COMMAND_PATTERN, '[redacted-command]');
  line = line.replace(/\bcommand\b/gi, '[redacted-command]');

  if (keyText === 'runnerkind' && line !== raw) {
    return '[redacted]';
  }
  if (!keyText && line.includes('[redacted-path]')) {
    line = line.replace(/(\[redacted-path\]).*$/, '$1');
  }

  return line.slice(0, 180) || '[redacted]';
}

function sanitizeSupervisorLifecycleGuardedRunnerReadinessList(values) {
  return normalizeStringList(values)
    .map((value) => sanitizeSupervisorLifecycleGuardedRunnerReadinessValue(value))
    .filter(Boolean);
}

function buildSupervisorLifecycleGuardedRunnerReadinessSafetyLines(safety) {
  const source = safety && typeof safety === 'object' ? safety : {};
  return [
    ...SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_SAFETY_KEYS.map((key) => `${key}:${source[key] === true ? 'true' : 'false'}`),
    'executorReady:false',
    'wouldRun:false',
    'wouldWrite:false',
  ];
}

function buildSupervisorLifecycleGuardedRunnerExecutionSafetyLines(safety) {
  const source = safety && typeof safety === 'object' ? safety : {};
  return [
    ...SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_SAFETY_KEYS.map((key) => (
      `${key}:${key === 'readOnly' || source[key] === true ? 'true' : 'false'}`
    )),
    'executionReady:false',
    'executorReady:false',
    'wouldExecute:false',
    'wouldRun:false',
    'wouldWrite:false',
  ];
}

function buildSupervisorLifecycleGuardedRunnerExecutionGateSafetyLines() {
  return [
    'readOnly:true',
    'lifecycleApplied:false',
    'filesystemWritten:false',
    'auditEventWritten:false',
    'metadataWritten:false',
    'executionEligible:false',
    'executorReady:false',
    'wouldExecute:false',
    'wouldRun:false',
    'wouldWrite:false',
  ];
}

function buildSupervisorLifecycleGuardedRunnerReadinessGateLines(gates, runnerBindingsReady) {
  const source = gates && typeof gates === 'object' ? gates : {};
  return [
    `lifecyclePlanValid:${source.lifecyclePlanValid === true ? 'true' : 'false'}`,
    `manifestReady:${source.manifestReady === true ? 'true' : 'false'}`,
    `runnerBindingsReady:${runnerBindingsReady === true ? 'true' : 'false'}`,
    'executorReady:false',
  ];
}

function normalizeGuardedRunnerBindingBoolean(value) {
  return value === true ? 'true' : 'false';
}

function sanitizeSupervisorLifecycleGuardedRunnerBindingField(value, key) {
  const sanitized = sanitizeSupervisorLifecycleGuardedRunnerReadinessValue(value, key);
  return sanitized.includes('[redacted') ? '[redacted]' : sanitized;
}

function sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(value, key = '') {
  const sanitized = sanitizeSupervisorLifecycleGuardedRunnerReadinessValue(value, key);
  const redactedHighEntropy = sanitized.replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, '[redacted-secret]');
  return redactedHighEntropy.includes('[redacted') ? '[redacted]' : redactedHighEntropy;
}

const EXECUTION_POLICY_DECISION_BLOCKER_ALLOWLIST = new Set([
  'execution-policy-context-invalid',
  'execution-policy-operation-invalid',
  'lifecycle-plan-not-ready',
  'approval-record-gate-not-ready',
  'executor-manifest-not-ready',
  'guarded-runner-readiness-not-ready',
  'execution-preview-not-verified',
  'execute-request-missing',
  'action-candidates-not-ready',
  'runner-registry-not-ready',
  'host-mutation-adapter-not-ready',
  'rollback-anchor-not-ready',
  'attempt-audit-not-ready',
  'operator-recovery-not-ready',
]);

function sanitizeAllowlistedExecutionPolicyBlocker(value) {
  if (typeof value !== 'string') return null;
  return EXECUTION_POLICY_DECISION_BLOCKER_ALLOWLIST.has(value) ? value : null;
}

/**
 * V1.27 Web security boundary for requiredContracts rendering:
 * - `execution-policy` may display ready under its strict V1.24 contract.
 * - `runner-registry` ready only under shared C∧R∧G∧D canonical predicate
 *   (see isCanonicalRunnerRegistryReady); otherwise fixed blocked + missing.
 * - `host-mutation-adapter` ready only under shared C∧A∧G∧D_adapter canonical
 *   predicate (see isCanonicalHostMutationAdapterReady).
 * - `rollback-anchor` ready only under shared C∧A∧G∧D_anchor canonical
 *   predicate (see isCanonicalRollbackAnchorReady).
 * - `attempt-audit` ready only under shared C∧A∧G∧D_audit canonical
 *   predicate (see isCanonicalAttemptAuditReady).
 * - `operator-recovery` ready only under shared C∧A∧G∧D_recovery canonical
 *   predicate (see isCanonicalOperatorRecoveryReady).
 * - Unknown / redacted ids stay blocked without leaking payload blocker text.
 */
const WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS = Object.freeze({});

/**
 * Shared single canonical predicate for runner-registry wiring line,
 * registry readiness line, and validationLines.runnerRegistryReady.
 * Ready iff C ∧ R ∧ G ∧ D all hold; any missing/contradictory/side-effect
 * drift fails closed.
 */
function isCanonicalRunnerRegistryReady({ C, R, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'runner-registry-ready' &&
    C?.requiredForExecution === true &&
    R?.state === 'ready' &&
    R?.runnerRegistryReady === true &&
    R?.codeOwnedRegistryResolverReady === true &&
    R?.realRunnerImplementationsReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.registryReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realHostRunnerReady === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false
  );
}

function resolveCanonicalRunnerRegistryReady(payload) {
  const requiredContracts = Array.isArray(payload?.runnerWiringContract?.requiredContracts)
    ? payload.runnerWiringContract.requiredContracts
    : [];
  const C = requiredContracts.find((entry) => entry && entry.id === 'runner-registry') || null;
  const R = payload?.runnerWiringContract?.runnerRegistryReadiness || null;
  const G = payload?.gates?.runnerRegistryReady === true;
  const D = payload?.registryDecision || null;
  return isCanonicalRunnerRegistryReady({ C, R, G, D });
}

/**
 * Shared single canonical predicate for host-mutation-adapter wiring line,
 * adapter readiness line, and validationLines.hostMutationAdapterReady.
 * Ready iff C ∧ A ∧ G ∧ D all hold; any missing/contradictory/side-effect
 * drift (including wouldMutateHost / *Allowed true) fails closed.
 */
function isCanonicalHostMutationAdapterReady({ C, A, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'host-mutation-adapter-ready' &&
    C?.requiredForExecution === true &&
    A?.state === 'ready' &&
    A?.hostMutationAdapterReady === true &&
    A?.codeOwnedAdapterResolverReady === true &&
    A?.realHostMutationImplementationReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.adapterReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realHostMutationImplementationReady === false &&
    D?.wouldMutateHost === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false &&
    D?.launchctlAllowed === false &&
    D?.filesystemWriteAllowed === false &&
    D?.processListReadAllowed === false &&
    D?.metadataWriteAllowed === false &&
    D?.auditWriteAllowed === false &&
    D?.rollbackAnchorWriteAllowed === false
  );
}

function resolveCanonicalHostMutationAdapterReady(payload) {
  const requiredContracts = Array.isArray(payload?.runnerWiringContract?.requiredContracts)
    ? payload.runnerWiringContract.requiredContracts
    : [];
  const C = requiredContracts.find((entry) => entry && entry.id === 'host-mutation-adapter') || null;
  const A = payload?.runnerWiringContract?.hostMutationAdapterReadiness || null;
  const G = payload?.gates?.hostMutationAdapterReady === true;
  const D = payload?.adapterDecision || null;
  return isCanonicalHostMutationAdapterReady({ C, A, G, D });
}

/**
 * Shared single canonical predicate for rollback-anchor wiring line,
 * anchor readiness line, and validationLines.rollbackAnchorReady.
 * Ready iff C ∧ A ∧ G ∧ D all hold; any missing/contradictory/side-effect
 * drift (including wouldWriteAnchor / wouldRestore / *Allowed true) fails closed.
 */
function isCanonicalRollbackAnchorReady({ C, A, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'rollback-anchor-ready' &&
    C?.requiredForExecution === true &&
    A?.state === 'ready' &&
    A?.rollbackAnchorReady === true &&
    A?.codeOwnedAnchorResolverReady === true &&
    A?.realRollbackAnchorImplementationReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.anchorReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realRollbackAnchorImplementationReady === false &&
    D?.wouldWriteAnchor === false &&
    D?.wouldRestore === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false &&
    D?.filesystemWriteAllowed === false &&
    D?.metadataWriteAllowed === false &&
    D?.rollbackAnchorWriteAllowed === false &&
    D?.rollbackRestoreAllowed === false
  );
}

function resolveCanonicalRollbackAnchorReady(payload) {
  const requiredContracts = Array.isArray(payload?.runnerWiringContract?.requiredContracts)
    ? payload.runnerWiringContract.requiredContracts
    : [];
  const C = requiredContracts.find((entry) => entry && entry.id === 'rollback-anchor') || null;
  const A = payload?.runnerWiringContract?.rollbackAnchorReadiness || null;
  const G = payload?.gates?.rollbackAnchorReady === true;
  const D = payload?.anchorDecision || null;
  return isCanonicalRollbackAnchorReady({ C, A, G, D });
}

/**
 * Shared single canonical predicate for attempt-audit wiring line,
 * audit readiness line, and validationLines.attemptAuditReady.
 * Ready iff C ∧ A ∧ G ∧ D all hold; any missing/contradictory/side-effect
 * drift (including wouldPersistAudit / wouldWriteLog / *Allowed true) fails closed.
 */
function isCanonicalAttemptAuditReady({ C, A, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'attempt-audit-ready' &&
    C?.requiredForExecution === true &&
    A?.state === 'ready' &&
    A?.attemptAuditReady === true &&
    A?.codeOwnedAuditResolverReady === true &&
    A?.realAttemptAuditImplementationReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.auditReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realAttemptAuditImplementationReady === false &&
    D?.wouldPersistAudit === false &&
    D?.wouldWriteLog === false &&
    D?.wouldWriteAudit === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false &&
    D?.auditWriteAllowed === false &&
    D?.metadataWriteAllowed === false &&
    D?.filesystemWriteAllowed === false &&
    D?.immutableAuditReady === false
  );
}

function resolveCanonicalAttemptAuditReady(payload) {
  const requiredContracts = Array.isArray(payload?.runnerWiringContract?.requiredContracts)
    ? payload.runnerWiringContract.requiredContracts
    : [];
  const C = requiredContracts.find((entry) => entry && entry.id === 'attempt-audit') || null;
  const A = payload?.runnerWiringContract?.attemptAuditReadiness || null;
  const G = payload?.gates?.attemptAuditReady === true;
  const D = payload?.auditDecision || null;
  return isCanonicalAttemptAuditReady({ C, A, G, D });
}

/**
 * Shared single canonical predicate for operator-recovery wiring line,
 * recovery readiness line, and validationLines.operatorRecoveryReady.
 * Ready iff C ∧ A ∧ G ∧ D all hold; any missing/contradictory/side-effect
 * drift (including wouldRecover / wouldRestartService / *Allowed true) fails closed.
 */
function isCanonicalOperatorRecoveryReady({ C, A, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'operator-recovery-ready' &&
    C?.requiredForExecution === true &&
    A?.state === 'ready' &&
    A?.operatorRecoveryReady === true &&
    A?.codeOwnedRecoveryResolverReady === true &&
    A?.realOperatorRecoveryImplementationReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.recoveryReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realOperatorRecoveryImplementationReady === false &&
    D?.wouldRecover === false &&
    D?.wouldRetry === false &&
    D?.wouldNotifyOperator === false &&
    D?.wouldRestartService === false &&
    D?.wouldRestoreState === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false &&
    D?.metadataWriteAllowed === false &&
    D?.filesystemWriteAllowed === false &&
    D?.remoteCommandAllowed === false &&
    D?.operatorNotificationAllowed === false
  );
}

function resolveCanonicalOperatorRecoveryReady(payload) {
  const requiredContracts = Array.isArray(payload?.runnerWiringContract?.requiredContracts)
    ? payload.runnerWiringContract.requiredContracts
    : [];
  const C = requiredContracts.find((entry) => entry && entry.id === 'operator-recovery') || null;
  const A = payload?.runnerWiringContract?.operatorRecoveryReadiness || null;
  const G = payload?.gates?.operatorRecoveryReady === true;
  const D = payload?.recoveryDecision || null;
  return isCanonicalOperatorRecoveryReady({ C, A, G, D });
}

function isCanonicalPolicyDecisionAuthorized(pd) {
  return (
    pd?.state === 'authorized' &&
    pd?.authorized === true &&
    pd?.wouldAuthorizeExecution === true &&
    pd?.primaryBlocker === null &&
    Array.isArray(pd?.blockers) &&
    pd.blockers.length === 0 &&
    pd?.wouldRun === false &&
    pd?.wouldWrite === false
  );
}

function buildSupervisorLifecycleGuardedRunnerWiringContractLines(
  runnerWiringContract,
  canonicalRunnerRegistryReady = false,
  canonicalHostMutationAdapterReady = false,
  canonicalRollbackAnchorReady = false,
  canonicalAttemptAuditReady = false,
  canonicalOperatorRecoveryReady = false,
) {
  const requiredContracts = Array.isArray(runnerWiringContract?.requiredContracts)
    ? runnerWiringContract.requiredContracts
    : [];
  return requiredContracts.map((contract) => {
    const source = contract && typeof contract === 'object' ? contract : {};
    const id = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.id, 'id') || 'unknown';

    const fixedMissing = WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS[id];
    if (fixedMissing) {
      return `wiringContract:${id}:status:blocked:requiredForExecution:true:blocker:${fixedMissing}`;
    }

    if (id === 'execution-policy') {
      const strictReady =
        source.status === 'ready' &&
        source.blockerCode === null &&
        source.evidenceCode === 'execution-policy-ready';
      if (strictReady) {
        return 'wiringContract:execution-policy:status:ready:requiredForExecution:true:blocker:none';
      }
      return 'wiringContract:execution-policy:status:blocked:requiredForExecution:true:blocker:execution-policy-missing';
    }

    if (id === 'runner-registry') {
      if (canonicalRunnerRegistryReady === true) {
        return 'wiringContract:runner-registry:status:ready:requiredForExecution:true:blocker:none';
      }
      return 'wiringContract:runner-registry:status:blocked:requiredForExecution:true:blocker:runner-registry-missing';
    }

    if (id === 'host-mutation-adapter') {
      if (canonicalHostMutationAdapterReady === true) {
        return 'wiringContract:host-mutation-adapter:status:ready:requiredForExecution:true:blocker:none';
      }
      return 'wiringContract:host-mutation-adapter:status:blocked:requiredForExecution:true:blocker:host-mutation-adapter-missing';
    }

    if (id === 'rollback-anchor') {
      if (canonicalRollbackAnchorReady === true) {
        return 'wiringContract:rollback-anchor:status:ready:requiredForExecution:true:blocker:none';
      }
      return 'wiringContract:rollback-anchor:status:blocked:requiredForExecution:true:blocker:rollback-anchor-missing';
    }

    if (id === 'attempt-audit') {
      if (canonicalAttemptAuditReady === true) {
        return 'wiringContract:attempt-audit:status:ready:requiredForExecution:true:blocker:none';
      }
      return 'wiringContract:attempt-audit:status:blocked:requiredForExecution:true:blocker:attempt-audit-missing';
    }

    if (id === 'operator-recovery') {
      if (canonicalOperatorRecoveryReady === true) {
        return 'wiringContract:operator-recovery:status:ready:requiredForExecution:true:blocker:none';
      }
      return 'wiringContract:operator-recovery:status:blocked:requiredForExecution:true:blocker:operator-recovery-missing';
    }

    // Unknown / duplicate-unknown / redacted ids: never ready, never leak payload blockers.
    return `wiringContract:${id}:status:blocked:requiredForExecution:true:blocker:unknown`;
  });
}

function buildSupervisorLifecycleGuardedRunnerRegistryLines(canonicalRunnerRegistryReady = false) {
  // Always emit exactly one stable line; never copy payload would*/state/blocker text.
  if (canonicalRunnerRegistryReady === true) {
    return [
      'runnerRegistry:code-owned-runner-registry:state:ready:codeOwnedResolverWired:true:' +
        'realHostRunnerReady:false:wouldExecute:false:blocker:none',
    ];
  }
  return [
    'runnerRegistry:code-owned-runner-registry:state:blocked:codeOwnedResolverWired:true:' +
      'realHostRunnerReady:false:wouldExecute:false:blocker:runner-registry-not-ready',
  ];
}

function buildSupervisorLifecycleGuardedRunnerExecutionPolicyLines(runnerWiringContract) {
  const policyEntries = Array.isArray(runnerWiringContract?.executionPolicyReadiness?.policyEntries)
    ? runnerWiringContract.executionPolicyReadiness.policyEntries
    : [];
  if (policyEntries.length < 1) return [];
  // Fixed ready fail-closed policy line; ignore malicious payload policyKind/blocker content.
  return [
    'executionPolicy:fail-closed-execution-policy:state:ready:realImplementationReady:true:' +
      'wouldAuthorizeExecution:false:blocker:none',
  ];
}

/**
 * V1.29 方案 A: two independent UI loci.
 * - policyDecision: honest mirror of JSON pure policy (authorized or fail-closed denied)
 * - executionSentinel: always blocked until real guarded runner wiring exists
 * Never render authorized JSON as denied, never map null primary to unknown on authorized path,
 * and never echo raw malicious payload strings.
 */
function buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload) {
  const pd = payload?.policyDecision;
  const policyLine = isCanonicalPolicyDecisionAuthorized(pd)
    ? 'policyDecision:state:authorized:authorized:true:wouldAuthorizeExecution:true:primaryBlocker:none'
    : `policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false:primaryBlocker:${
      sanitizeAllowlistedExecutionPolicyBlocker(pd?.primaryBlocker) || 'unknown'
    }`;
  return [
    policyLine,
    'executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing',
  ];
}

function buildSupervisorLifecycleGuardedRunnerHostMutationAdapterLines(canonicalHostMutationAdapterReady = false) {
  // Always emit exactly one stable line; never copy payload adapterKind/would*/blocker text.
  if (canonicalHostMutationAdapterReady === true) {
    return [
      'hostMutationAdapter:code-owned-host-mutation-adapter:state:ready:codeOwnedResolverWired:true:' +
        'realHostMutationImplementationReady:false:wouldMutateHost:false:blocker:none',
    ];
  }
  return [
    'hostMutationAdapter:code-owned-host-mutation-adapter:state:blocked:codeOwnedResolverWired:true:' +
      'realHostMutationImplementationReady:false:wouldMutateHost:false:blocker:host-mutation-adapter-not-ready',
  ];
}

function buildSupervisorLifecycleGuardedRunnerRollbackAnchorLines(canonicalRollbackAnchorReady = false) {
  // Always emit exactly one stable line; never copy payload anchorKind/would*/blocker text.
  if (canonicalRollbackAnchorReady === true) {
    return [
      'rollbackAnchor:code-owned-rollback-anchor:state:ready:codeOwnedResolverWired:true:' +
        'realRollbackAnchorImplementationReady:false:wouldWriteAnchor:false:wouldRestore:false:blocker:none',
    ];
  }
  return [
    'rollbackAnchor:code-owned-rollback-anchor:state:blocked:codeOwnedResolverWired:true:' +
      'realRollbackAnchorImplementationReady:false:wouldWriteAnchor:false:wouldRestore:false:blocker:rollback-anchor-not-ready',
  ];
}

function buildSupervisorLifecycleGuardedRunnerAttemptAuditLines(canonicalAttemptAuditReady = false) {
  // Always emit exactly one stable line; never copy payload auditKind/would*/blocker text.
  if (canonicalAttemptAuditReady === true) {
    return [
      'attemptAudit:code-owned-attempt-audit:state:ready:codeOwnedResolverWired:true:' +
        'realAttemptAuditImplementationReady:false:wouldPersistAudit:false:wouldWriteLog:false:blocker:none',
    ];
  }
  return [
    'attemptAudit:code-owned-attempt-audit:state:blocked:codeOwnedResolverWired:true:' +
      'realAttemptAuditImplementationReady:false:wouldPersistAudit:false:wouldWriteLog:false:blocker:attempt-audit-not-ready',
  ];
}

function buildSupervisorLifecycleGuardedRunnerOperatorRecoveryLines(canonicalOperatorRecoveryReady = false) {
  // Always emit exactly one stable line; never copy payload recoveryKind/would*/blocker text.
  if (canonicalOperatorRecoveryReady === true) {
    return [
      'operatorRecovery:code-owned-operator-recovery:state:ready:codeOwnedResolverWired:true:' +
        'realOperatorRecoveryImplementationReady:false:wouldRecover:false:wouldRestartService:false:' +
        'wouldRestoreState:false:blocker:none',
    ];
  }
  return [
    'operatorRecovery:code-owned-operator-recovery:state:blocked:codeOwnedResolverWired:true:' +
      'realOperatorRecoveryImplementationReady:false:wouldRecover:false:wouldRestartService:false:' +
      'wouldRestoreState:false:blocker:operator-recovery-not-ready',
  ];
}

function buildSupervisorLifecycleGuardedRunnerBindingItems(runnerBindings) {
  if (!Array.isArray(runnerBindings)) return [];
  return runnerBindings.map((binding) => {
    const source = binding && typeof binding === 'object' ? binding : {};
    const maxAttempts = Number.isInteger(source.maxAttempts) && source.maxAttempts > 0
      ? String(source.maxAttempts)
      : 'unknown';
    return {
      actionId: sanitizeSupervisorLifecycleGuardedRunnerBindingField(source.actionId, 'actionId') || 'unknown',
      implementationId: sanitizeSupervisorLifecycleGuardedRunnerBindingField(source.implementationId, 'implementationId') || 'unknown',
      mode: sanitizeSupervisorLifecycleGuardedRunnerBindingField(source.mode, 'mode') || 'unknown',
      runnerKind: sanitizeSupervisorLifecycleGuardedRunnerBindingField(source.runnerKind, 'runnerKind') || 'unknown',
      requiresApprovalRecord: source.requiresApprovalRecord === true,
      maxAttempts,
      wouldRun: false,
      wouldWrite: false,
    };
  });
}

function buildSupervisorLifecycleGuardedRunnerBindingLines(runnerBindings) {
  return runnerBindings.map((binding) => (
    `binding:${binding.actionId}:impl:${binding.implementationId}:mode:${binding.mode}` +
    `:runner:${binding.runnerKind}:wouldRun:false:wouldWrite:false`
  ));
}

export function buildSupervisorLifecycleGuardedRunnerReadinessViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      approvalValidText: '—',
      persistenceText: '—',
      runnerBindingsReady: false,
      executorReady: false,
      runnerBlockers: [],
      blockers: [],
      nextBlockers: [],
      runnerBindings: [],
      runnerBindingLines: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: [],
      messageText: 'Guarded runner readiness 检查失败: ' + sanitizeSupervisorLifecycleGuardedRunnerReadinessValue(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      approvalValidText: 'runnerBindingsReady:false / executorReady:false',
      persistenceText: 'readOnly:true / executorReady:false',
      runnerBindingsReady: false,
      executorReady: false,
      runnerBlockers: [],
      blockers: [],
      nextBlockers: [],
      runnerBindings: [],
      runnerBindingLines: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: ['readOnly:true', 'lifecycleApplied:false', 'executorReady:false', 'wouldRun:false', 'wouldWrite:false'],
      messageText: '点击手动 POST /api/supervisor-lifecycle-guarded-runner-readiness 获取 guarded runner readiness',
    };
  }

  const runnerBindingsReady = payload.runnerBindingsReady === true;
  const runnerBindings = buildSupervisorLifecycleGuardedRunnerBindingItems(payload.runnerBindings);
  const runnerBindingLines = buildSupervisorLifecycleGuardedRunnerBindingLines(runnerBindings);
  return {
    statusKey: 'blocked',
    statusText: 'Guarded runner 未启用',
    approvalValidText: `runnerBindingsReady:${runnerBindingsReady ? 'true' : 'false'} / executorReady:false`,
    persistenceText: 'readOnly:true / executorReady:false',
    runnerBindingsReady,
    executorReady: false,
    runnerBlockers: sanitizeSupervisorLifecycleGuardedRunnerReadinessList(payload.runnerBlockers).map((blocker) => `runner:${blocker}`),
    blockers: sanitizeSupervisorLifecycleGuardedRunnerReadinessList(payload.blockers),
    nextBlockers: sanitizeSupervisorLifecycleGuardedRunnerReadinessList(payload.nextBlockers),
    runnerBindings,
    runnerBindingLines,
    requiredFields: runnerBindingLines,
    recordLines: [],
    validationLines: buildSupervisorLifecycleGuardedRunnerReadinessGateLines(payload.gates, runnerBindingsReady),
    safetyLines: buildSupervisorLifecycleGuardedRunnerReadinessSafetyLines(payload.safety),
    messageText: 'Guarded runner readiness completed; readiness remains fail-closed.',
  };
}

export function buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      approvalValidText: '—',
      persistenceText: '—',
      runnerBlockers: [],
      blockers: [],
      nextBlockers: [],
      runnerBindingLines: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: [],
      messageText: 'Guarded runner execution preview 检查失败: ' + sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      approvalValidText: 'executionReady:false / executorReady:false',
      persistenceText: 'readOnly:true / wouldExecute:false',
      runnerBlockers: [],
      blockers: [],
      nextBlockers: [],
      runnerBindingLines: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: ['readOnly:true', 'executionReady:false', 'executorReady:false', 'wouldExecute:false', 'wouldRun:false', 'wouldWrite:false'],
      messageText: '点击手动 POST /api/supervisor-lifecycle-guarded-runner-execution-preview 获取 guarded runner execution preview',
    };
  }

  const actionPreviews = Array.isArray(payload.actionPreviews) ? payload.actionPreviews : [];
  const actionLines = actionPreviews.map((action) => {
    const source = action && typeof action === 'object' ? action : {};
    const actionId = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.actionId, 'actionId') || 'unknown';
    const implementationId = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.implementationId, 'implementationId') || 'unknown';
    const mode = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.mode, 'mode') || 'unknown';
    const runnerKind = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.runnerKind, 'runnerKind') || 'unknown';
    return `action:${actionId}:impl:${implementationId}:mode:${mode}:runner:${runnerKind}:wouldExecute:false:wouldRun:false:wouldWrite:false`;
  });
  const gates = payload.gates && typeof payload.gates === 'object' ? payload.gates : {};
  const blockers = sanitizeSupervisorLifecycleGuardedRunnerReadinessList(payload.blockers);
  const nextBlockers = sanitizeSupervisorLifecycleGuardedRunnerReadinessList(payload.nextBlockers).map((blocker) => `next:${blocker}`);

  return {
    statusKey: 'blocked',
    statusText: '执行预览阻塞',
    approvalValidText: 'executionReady:false / executorReady:false',
    persistenceText: 'readOnly:true / wouldExecute:false',
    runnerBlockers: [],
    blockers: [...blockers, ...nextBlockers],
    nextBlockers,
    runnerBindingLines: [],
    requiredFields: actionLines,
    recordLines: [],
    validationLines: [
      `lifecyclePlanValid:${gates.lifecyclePlanValid === true ? 'true' : 'false'}`,
      `runnerBindingsReady:${gates.runnerBindingsReady === true ? 'true' : 'false'}`,
      `executionPreviewOnly:${gates.executionPreviewOnly === true ? 'true' : 'false'}`,
      'executorReady:false',
    ],
    safetyLines: buildSupervisorLifecycleGuardedRunnerExecutionSafetyLines(payload.safety),
    messageText: 'Guarded runner execution preview completed; execution remains fail-closed.',
  };
}

export function buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      approvalValidText: 'executionEligible:false / executorReady:false',
      persistenceText: 'readOnly:true / wouldExecute:false',
      runnerBlockers: [],
      blockers: [],
      nextBlockers: [],
      runnerBindingLines: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [
        'realRunnerWiringReady:false',
        'runnerWiringContractReady:false',
        'executionPolicyReady:false',
        'runnerRegistryReady:false',
        'executionEligible:false',
        'executorReady:false',
        'hostMutationAdapterReady:false',
        'rollbackAnchorReady:false',
        'attemptAuditReady:false',
        'operatorRecoveryReady:false',
      ],
      safetyLines: buildSupervisorLifecycleGuardedRunnerExecutionGateSafetyLines(),
      messageText: 'Guarded runner execution gate 检查失败: ' + sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      approvalValidText: 'executionEligible:false / executorReady:false',
      persistenceText: 'readOnly:true / wouldExecute:false',
      runnerBlockers: [],
      blockers: [],
      nextBlockers: [],
      runnerBindingLines: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [
        'lifecyclePlanValid:false',
        'approvalRecordReady:false',
        'manifestReady:false',
        'runnerBindingsReady:false',
        'executeRequested:false',
        'executionPolicyReady:false',
        'runnerRegistryReady:false',
        'realRunnerWiringReady:false',
        'runnerWiringContractReady:false',
        'executionEligible:false',
        'executorReady:false',
        'hostMutationAdapterReady:false',
        'rollbackAnchorReady:false',
        'attemptAuditReady:false',
        'operatorRecoveryReady:false',
      ],
      safetyLines: buildSupervisorLifecycleGuardedRunnerExecutionGateSafetyLines(),
      messageText: '点击手动 POST /api/supervisor-lifecycle-guarded-runner-execution-gate 获取 guarded runner execution gate',
    };
  }

  const actionCandidates = Array.isArray(payload.actionCandidates) ? payload.actionCandidates : [];
  const actionLines = actionCandidates.map((action) => {
    const source = action && typeof action === 'object' ? action : {};
    const actionId = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.actionId, 'actionId') || 'unknown';
    const implementationId = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.implementationId, 'implementationId') || 'unknown';
    const mode = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.mode, 'mode') || 'unknown';
    const runnerKind = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.runnerKind, 'runnerKind') || 'unknown';
    return `candidate:${actionId}:impl:${implementationId}:mode:${mode}:runner:${runnerKind}:status:blocked:wouldExecute:false:wouldRun:false:wouldWrite:false`;
  });
  const gates = payload.gates && typeof payload.gates === 'object' ? payload.gates : {};
  const blockers = sanitizeSupervisorLifecycleGuardedRunnerReadinessList(payload.blockers);
  const nextBlockers = sanitizeSupervisorLifecycleGuardedRunnerReadinessList(payload.nextBlockers).map((blocker) => `next:${blocker}`);
  const executeRequestedText = gates.executeRequested === true ? ' / executeRequested:true' : '';
  // Single shared canonical booleans for wiring / registry / adapter / anchor / audit / recovery / validation lines.
  const canonicalRunnerRegistryReady = resolveCanonicalRunnerRegistryReady(payload) === true;
  const canonicalHostMutationAdapterReady = resolveCanonicalHostMutationAdapterReady(payload) === true;
  const canonicalRollbackAnchorReady = resolveCanonicalRollbackAnchorReady(payload) === true;
  const canonicalAttemptAuditReady = resolveCanonicalAttemptAuditReady(payload) === true;
  const canonicalOperatorRecoveryReady = resolveCanonicalOperatorRecoveryReady(payload) === true;
  const wiringContractLines = buildSupervisorLifecycleGuardedRunnerWiringContractLines(
    payload.runnerWiringContract,
    canonicalRunnerRegistryReady,
    canonicalHostMutationAdapterReady,
    canonicalRollbackAnchorReady,
    canonicalAttemptAuditReady,
    canonicalOperatorRecoveryReady,
  );
  const executionPolicyLines = buildSupervisorLifecycleGuardedRunnerExecutionPolicyLines(payload.runnerWiringContract);
  const policyDecisionLines = buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload);
  const runnerRegistryLines = buildSupervisorLifecycleGuardedRunnerRegistryLines(canonicalRunnerRegistryReady);
  const hostMutationAdapterLines = buildSupervisorLifecycleGuardedRunnerHostMutationAdapterLines(
    canonicalHostMutationAdapterReady,
  );
  const rollbackAnchorLines = buildSupervisorLifecycleGuardedRunnerRollbackAnchorLines(
    canonicalRollbackAnchorReady,
  );
  const attemptAuditLines = buildSupervisorLifecycleGuardedRunnerAttemptAuditLines(canonicalAttemptAuditReady);
  const operatorRecoveryLines = buildSupervisorLifecycleGuardedRunnerOperatorRecoveryLines(
    canonicalOperatorRecoveryReady,
  );

  return {
    statusKey: 'blocked',
    statusText: '执行 gate 阻塞',
    approvalValidText: 'executionEligible:false / executorReady:false',
    persistenceText: `readOnly:true${executeRequestedText} / wouldExecute:false`,
    runnerBlockers: [],
    blockers: [...blockers, ...nextBlockers],
    nextBlockers,
    runnerBindingLines: [],
    requiredFields: [
      ...actionLines,
      ...wiringContractLines,
      ...executionPolicyLines,
      ...policyDecisionLines,
      ...runnerRegistryLines,
      ...hostMutationAdapterLines,
      ...rollbackAnchorLines,
      ...attemptAuditLines,
      ...operatorRecoveryLines,
    ],
    recordLines: [],
    validationLines: [
      `lifecyclePlanValid:${gates.lifecyclePlanValid === true ? 'true' : 'false'}`,
      `approvalRecordReady:${gates.approvalRecordReady === true ? 'true' : 'false'}`,
      `manifestReady:${gates.manifestReady === true ? 'true' : 'false'}`,
      `runnerBindingsReady:${gates.runnerBindingsReady === true ? 'true' : 'false'}`,
      `executeRequested:${gates.executeRequested === true ? 'true' : 'false'}`,
      `executionPolicyReady:${gates.executionPolicyReady === true ? 'true' : 'false'}`,
      `runnerRegistryReady:${canonicalRunnerRegistryReady ? 'true' : 'false'}`,
      'realRunnerWiringReady:false',
      'runnerWiringContractReady:false',
      'executionEligible:false',
      'executorReady:false',
      `hostMutationAdapterReady:${canonicalHostMutationAdapterReady ? 'true' : 'false'}`,
      `rollbackAnchorReady:${canonicalRollbackAnchorReady ? 'true' : 'false'}`,
      `attemptAuditReady:${canonicalAttemptAuditReady ? 'true' : 'false'}`,
      `operatorRecoveryReady:${canonicalOperatorRecoveryReady ? 'true' : 'false'}`,
    ],
    safetyLines: buildSupervisorLifecycleGuardedRunnerExecutionGateSafetyLines(),
    messageText: 'Guarded runner execution gate completed; execution remains blocked and fail-closed.',
  };
}

export function buildSupervisorInstallDryRunViewModel(plan, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      installStateText: '—',
      approvalStateText: '—',
      rollbackStateText: '—',
      readinessBlockers: [],
      commandActions: [],
      preflightChecks: [],
      approvalControls: [],
      rollbackUninstallActions: [],
      rollbackUninstallSafetyLines: [],
      safetyLines: [],
      messageText: 'Supervisor install dry-run 检查失败: ' + sanitizeSupervisorInstallErrorMessage(errorMessage),
    };
  }

  if (!plan || typeof plan !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      installStateText: '—',
      approvalStateText: '—',
      rollbackStateText: '—',
      readinessBlockers: [],
      commandActions: [],
      preflightChecks: [],
      approvalControls: [],
      rollbackUninstallActions: [],
      rollbackUninstallSafetyLines: [],
      safetyLines: [],
      messageText: '点击 Supervisor install dry-run 手动 POST /api/supervisor-install-dry-run',
    };
  }

  const supervisor = plan.supervisor && typeof plan.supervisor === 'object' ? plan.supervisor : {};
  const readiness = plan.readinessSummary && typeof plan.readinessSummary === 'object' ? plan.readinessSummary : {};
  const commandPreview = plan.installCommandPreview && typeof plan.installCommandPreview === 'object' ? plan.installCommandPreview : {};
  const preflight = plan.installPreflight && typeof plan.installPreflight === 'object' ? plan.installPreflight : {};
  const manifest = plan.installApprovalManifest && typeof plan.installApprovalManifest === 'object' ? plan.installApprovalManifest : {};
  const approval = manifest.approval && typeof manifest.approval === 'object' ? manifest.approval : {};
  const rollback = manifest.rollback && typeof manifest.rollback === 'object' ? manifest.rollback : {};
  const rollbackUninstallPlan = plan.rollbackUninstallPlan && typeof plan.rollbackUninstallPlan === 'object' ? plan.rollbackUninstallPlan : {};
  const rollbackPlan = rollbackUninstallPlan.rollback && typeof rollbackUninstallPlan.rollback === 'object' ? rollbackUninstallPlan.rollback : null;
  const uninstallPlan = rollbackUninstallPlan.uninstall && typeof rollbackUninstallPlan.uninstall === 'object' ? rollbackUninstallPlan.uninstall : null;
  const recoveryPlan = rollbackUninstallPlan.recovery && typeof rollbackUninstallPlan.recovery === 'object' ? rollbackUninstallPlan.recovery : null;
  const hasRollbackUninstallPlan = Boolean(rollbackPlan || uninstallPlan || recoveryPlan || Array.isArray(rollbackUninstallPlan.actions));

  const statusKey = ['ready', 'partial', 'blocked'].includes(plan.status) ? plan.status : 'partial';

  return {
    statusKey,
    statusText: formatHardeningStatusText(statusKey),
    installStateText: `${formatAuditDisplayString(supervisor.state) || 'unknown'} / wouldInstall:${supervisor.wouldInstall === true ? 'true' : 'false'} / wouldStart:${supervisor.wouldStart === true ? 'true' : 'false'}`,
    approvalStateText: `approved:${approval.approved === true ? 'true' : 'false'}`,
    rollbackStateText: hasRollbackUninstallPlan
      ? `rollback:${rollbackPlan?.available === true ? 'true' : 'false'} / uninstall:${uninstallPlan?.available === true ? 'true' : 'false'} / recovery:${recoveryPlan?.available === true ? 'true' : 'false'}`
      : `available:${rollback.available === true ? 'true' : 'false'}`,
    readinessBlockers: normalizeStringList(readiness.blockers),
    commandActions: Array.isArray(commandPreview.actions)
      ? commandPreview.actions.map((action) => {
        const source = action && typeof action === 'object' ? action : {};
        return `${formatAuditDisplayString(source.id) || 'unknown'} · wouldRun:${source.wouldRun === true ? 'true' : 'false'} · wouldWrite:${source.wouldWrite === true ? 'true' : 'false'}`;
      })
      : [],
    preflightChecks: Array.isArray(preflight.checks)
      ? preflight.checks.map((check) => {
        const source = check && typeof check === 'object' ? check : {};
        return `${formatAuditDisplayString(source.id) || 'unknown'} · ${formatAuditDisplayString(source.status) || 'unknown'} · ${formatAuditDisplayString(source.blockerCode) || 'none'}`;
      })
      : [],
    approvalControls: Array.isArray(manifest.controls)
      ? manifest.controls.map((control) => {
        const source = control && typeof control === 'object' ? control : {};
        return `${formatAuditDisplayString(source.id) || 'unknown'} · ${formatAuditDisplayString(source.status) || 'unknown'} · ${formatAuditDisplayString(source.blockerCode) || 'none'}`;
      })
      : [],
    rollbackUninstallActions: Array.isArray(rollbackUninstallPlan.actions)
      ? rollbackUninstallPlan.actions.map((action) => {
        const source = action && typeof action === 'object' ? action : {};
        return `${formatAuditDisplayString(source.id) || 'unknown'} · ${formatAuditDisplayString(source.kind) || 'unknown'} · ${formatAuditDisplayString(source.status) || 'unknown'} · wouldRun:${source.wouldRun === true ? 'true' : 'false'} · wouldWrite:${source.wouldWrite === true ? 'true' : 'false'} · ${formatAuditDisplayString(source.blockerCode) || 'none'}`;
      })
      : [],
    rollbackUninstallSafetyLines: buildSupervisorRollbackUninstallSafetyLines(rollbackUninstallPlan.safety),
    safetyLines: buildSupervisorInstallSafetyLines(plan.safety),
    messageText: 'POST /api/supervisor-install-dry-run 成功，仍为 blocked dry-run 预览',
  };
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

export function getDeviceManagementStateKey(device) {
  if (!device) return 'unknown';
  const status = normalizeDeviceStatus(device.status);
  if (status === 'unknown') return 'unknown';
  const rawIp = device.ipAddress === null || device.ipAddress === undefined ? '' : device.ipAddress;
  const ip = String(rawIp).trim().toLowerCase();
  if (status === 'online') {
    if (ip === '' || ip === 'null' || ip === 'undefined' || ip === 'unknown') {
      return 'missing-ip';
    }
    return 'visible';
  }
  if (status === 'offline') {
    return 'offline-retained';
  }
  return 'unknown';
}

const MANAGEMENT_STATE_LABELS = {
  'visible': '在线可见',
  'missing-ip': '在线缺 IP',
  'offline-retained': '离线保留',
  'unknown': '未知待确认',
};

const MANAGEMENT_STATE_HINTS = {
  'visible': '在线且 IP 可用，可纳入统一管理',
  'missing-ip': '设备在线但缺少可用 IP，需补充 IP 信息',
  'offline-retained': '设备离线，保留历史记录和备份上下文',
  'unknown': '状态未知，需确认设备心跳',
};

const DEVICE_FILTER_STATUS_LABELS = {
  all: '全部',
  online: '在线',
  offline: '离线',
  unknown: '未知',
};

const DEVICE_FILTER_MANAGEMENT_LABELS = {
  all: '全部',
  ...MANAGEMENT_STATE_LABELS,
};

export function getDeviceManagementState(device) {
  const key = getDeviceManagementStateKey(device);
  return MANAGEMENT_STATE_LABELS[key] || '未知待确认';
}

export function getDeviceManagementHint(device) {
  const key = getDeviceManagementStateKey(device);
  return MANAGEMENT_STATE_HINTS[key] || MANAGEMENT_STATE_HINTS.unknown;
}

function formatDeviceFilterValue(value, labels, fallbackValue) {
  const key = value || fallbackValue;
  return labels[key] || String(key || fallbackValue);
}

export function buildDeviceEmptyFilterContext(controls) {
  const query = String(controls?.query || '').trim() || '全部';
  const status = formatDeviceFilterValue(controls?.status, DEVICE_FILTER_STATUS_LABELS, 'all');
  const management = formatDeviceFilterValue(controls?.management, DEVICE_FILTER_MANAGEMENT_LABELS, 'all');
  return '搜索: ' + query + ' · 状态: ' + status + ' · 管理态: ' + management;
}

/**
 * Returns true when any device list control differs from the default state.
 */
export function isDeviceFilterResetActive(controls) {
  return Boolean(String(controls?.query || '').trim())
    || (controls?.status || 'all') !== 'all'
    || (controls?.management || 'all') !== 'all'
    || (controls?.sort || 'name') !== 'name';
}

export const DEVICE_FILTER_SORT_LABELS = {
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

export function buildDeviceActiveFilterSummaryState(controls) {
  return {
    text: buildDeviceActiveFilterSummary(controls),
    active: isDeviceFilterResetActive(controls),
  };
}

export function buildDeviceFilterCountState(visibleCount, totalCount) {
  const visible = Number.isFinite(Number(visibleCount)) ? Number(visibleCount) : 0;
  const total = Number.isFinite(Number(totalCount)) ? Number(totalCount) : 0;
  return {
    text: String(visible) + ' / ' + String(total),
    filtered: total > 0 && visible < total,
    visible,
    total,
  };
}

export function buildDeviceManagementSummary(devices) {
  const summary = {
    all: 0,
    visible: 0,
    missingIp: 0,
    offlineRetained: 0,
    unknown: 0
  };
  if (!Array.isArray(devices)) {
    return summary;
  }
  for (let i = 0; i < devices.length; i++) {
    const key = getDeviceManagementStateKey(devices[i]);
    summary.all++;
    if (key === 'visible') {
      summary.visible++;
    } else if (key === 'missing-ip') {
      summary.missingIp++;
    } else if (key === 'offline-retained') {
      summary.offlineRetained++;
    } else {
      summary.unknown++;
    }
  }
  return summary;
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
  const management = controls?.management || 'all';
  const sort = controls?.sort || 'name';
  return [...devices]
    .filter((device) => matchesDeviceSearch(device, controls?.query || ''))
    .filter((device) => status === 'all' || normalizeDeviceStatus(device?.status) === status)
    .filter((device) => management === 'all' || getDeviceManagementStateKey(device) === management)
    .sort((a, b) => compareDevicesForSort(a, b, sort));
}

export function buildDeviceManagementSummaryScope(devices, controls) {
  if (!Array.isArray(devices)) {
    return buildDeviceManagementSummary(devices);
  }
  const status = controls?.status || 'all';
  const scopedDevices = devices
    .filter((device) => matchesDeviceSearch(device, controls?.query || ''))
    .filter((device) => status === 'all' || normalizeDeviceStatus(device?.status) === status);
  return buildDeviceManagementSummary(scopedDevices);
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

const VERSION_CONSISTENCY_LABELS = {
  drifted: '版本不一致',
  'single-device': '单设备',
  synced: '一致',
};

const VERSION_CONSISTENCY_REASONS = {
  drifted: '多台设备最新版本不同',
  'single-device': '仅一台设备有该任务快照',
  synced: '多台设备最新版本一致',
};

const VERSION_CONSISTENCY_SORT_ORDER = {
  drifted: 0,
  'single-device': 1,
  synced: 2,
};

const VERSION_CONSISTENCY_SORT_KEYS = ['risk', 'max-drift', 'stale-count', 'latest', 'name', 'coverage-gap'];

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

function getSnapshotDeviceMap(snapshotsByDevice) {
  return snapshotsByDevice && typeof snapshotsByDevice === 'object' ? snapshotsByDevice : {};
}

function getVersionState(status, row, latestTime, latestFileCount) {
  if (status === 'single-device') return 'single';
  if (status === 'synced') return 'latest';
  return row.latestTime === latestTime && row.latestFileCount === latestFileCount ? 'latest' : 'stale';
}

export function buildBackupVersionConsistency(devices, snapshotsByDevice, options = {}) {
  const excluded = new Set(options?.excludedCoverageDeviceIds || []);
  const safeDevices = Array.isArray(devices) ? devices : [];

  const expectedDevices = safeDevices.filter((d) => {
    const id = normalizeDeviceText(d?.deviceId);
    return id && id !== 'unknown' && !excluded.has(id);
  });

  const coverageDeviceCount = expectedDevices.length;
  const coverageExcludedDeviceCount = safeDevices.filter((d) => {
    const id = normalizeDeviceText(d?.deviceId);
    return id && id !== 'unknown' && excluded.has(id);
  }).length;

  const summary = {
    synced: 0,
    drifted: 0,
    singleDevice: 0,
    total: 0,
    coverage: {
      coverageDeviceCount,
      coverageExcludedDeviceCount,
      coverageGapCount: 0,
      fullyCoveredCount: 0,
    }
  };
  const snapshotMap = getSnapshotDeviceMap(snapshotsByDevice);
  const groups = new Map();

  for (const device of safeDevices) {
    const deviceId = normalizeDeviceText(device?.deviceId);
    if (deviceId === 'unknown') continue;

    const snapshots = Array.isArray(snapshotMap[deviceId]) ? snapshotMap[deviceId] : [];
    for (const snapshot of snapshots) {
      const key = getBackupJobKey(snapshot);
      if (!groups.has(key)) {
        const rawJobName = String(snapshot?.jobName || '').trim();
        groups.set(key, {
          key,
          jobName: normalizeBackupJobName(rawJobName),
          sourcePath: normalizeSourcePath(snapshot?.sourcePath),
          devices: new Map(),
          snapshotCount: 0,
        });
      }

      const group = groups.get(key);
      const latestTime = getSnapshotCreatedAtTime(snapshot);
      const latestFileCount = getSnapshotFileCount(snapshot);
      const current = group.devices.get(deviceId);

      group.snapshotCount += 1;
      if (!current || latestTime >= current.latestTime) {
        group.devices.set(deviceId, {
          deviceId,
          hostname: getDeviceDisplayName(device),
          ipAddress: normalizeDeviceText(device?.ipAddress),
          latestSnapshotId: snapshot?.snapshotId || '',
          latestCreatedAt: snapshot?.createdAt || '',
          latestTime,
          latestFileCount,
          snapshotCount: (current?.snapshotCount || 0) + 1,
        });
      } else if (current) {
        current.snapshotCount += 1;
      }
    }
  }

  const versionGroups = [...groups.values()].map((group) => {
    const rows = [...group.devices.values()].sort((a, b) => (
      b.latestTime - a.latestTime
      || a.hostname.localeCompare(b.hostname)
      || a.deviceId.localeCompare(b.deviceId)
    ));
    const latestTime = rows.reduce((max, row) => Math.max(max, row.latestTime), 0);
    const latestFileCount = rows.find((row) => row.latestTime === latestTime)?.latestFileCount || 0;

    let status = 'single-device';
    if (rows.length > 1) {
      const allSame = rows.every((row) => row.latestTime === latestTime && row.latestFileCount === latestFileCount);
      status = allSame ? 'synced' : 'drifted';
    }

    if (status === 'synced') summary.synced += 1;
    if (status === 'drifted') summary.drifted += 1;
    if (status === 'single-device') summary.singleDevice += 1;
    summary.total += 1;

    const devices = rows.map((row) => ({
      deviceId: row.deviceId,
      hostname: row.hostname,
      ipAddress: row.ipAddress,
      latestSnapshotId: row.latestSnapshotId,
      latestCreatedAt: row.latestCreatedAt,
      latestFileCount: row.latestFileCount,
      snapshotCount: row.snapshotCount,
      versionState: getVersionState(status, row, latestTime, latestFileCount),
    }));

    let latestCount = 0;
    let staleCount = 0;
    let singleCount = 0;
    const staleDeviceNames = [];

    devices.forEach((device) => {
      if (device.versionState === 'latest') {
        latestCount++;
      } else if (device.versionState === 'stale') {
        staleCount++;
        staleDeviceNames.push(device.hostname);
      } else if (device.versionState === 'single') {
        singleCount++;
      }
    });

    let maxTimeDriftMs = null;
    if (status === 'drifted') {
      const validRows = rows.filter((r) => r.latestTime > 0);
      if (validRows.length >= 2) {
        maxTimeDriftMs = validRows[0].latestTime - validRows[validRows.length - 1].latestTime;
      }
    }

    // 覆盖率字段
    const expectedDeviceCount = coverageDeviceCount;
    const coveredDeviceCount = expectedDevices.filter((d) => {
      const id = normalizeDeviceText(d?.deviceId);
      return group.devices.has(id);
    }).length;
    const missingDevices = expectedDevices.filter((d) => {
      const id = normalizeDeviceText(d?.deviceId);
      return !group.devices.has(id);
    });
    const missingDeviceCount = missingDevices.length;
    const missingDeviceNames = missingDevices
      .map((d) => getDeviceDisplayName(d))
      .sort((a, b) => a.localeCompare(b));

    if (expectedDeviceCount > 1 && missingDeviceCount > 0) {
      summary.coverage.coverageGapCount += 1;
    }
    if (expectedDeviceCount > 0 && missingDeviceCount === 0) {
      summary.coverage.fullyCoveredCount += 1;
    }

    return {
      key: group.key,
      jobName: group.jobName,
      sourcePath: group.sourcePath,
      status,
      statusLabel: VERSION_CONSISTENCY_LABELS[status],
      reason: rows.length > 1
        ? String(rows.length) + ' 台设备 · ' + VERSION_CONSISTENCY_REASONS[status]
        : VERSION_CONSISTENCY_REASONS[status],
      deviceCount: rows.length,
      snapshotCount: group.snapshotCount,
      latestCreatedAt: rows[0]?.latestCreatedAt || '',
      latestFileCount: latestFileCount,
      devices,
      latestCount,
      staleCount,
      singleCount,
      maxTimeDriftMs,
      staleDeviceNames,
      // V0.27 覆盖率字段
      expectedDeviceCount,
      coveredDeviceCount,
      missingDeviceCount,
      missingDeviceNames,
    };
  }).sort((a, b) => (
    VERSION_CONSISTENCY_SORT_ORDER[a.status] - VERSION_CONSISTENCY_SORT_ORDER[b.status]
    || getValidDateTime(b.latestCreatedAt) - getValidDateTime(a.latestCreatedAt)
    || a.jobName.localeCompare(b.jobName)
    || a.sourcePath.localeCompare(b.sourcePath)
  ));

  return { summary, groups: versionGroups };
}

function matchesVersionConsistencySearch(group, query) {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return true;

  const values = [
    group?.jobName,
    group?.sourcePath,
    group?.status,
    group?.statusLabel,
    group?.reason,
  ];

  for (const device of group?.devices || []) {
    values.push(
      device?.deviceId,
      device?.hostname,
      device?.ipAddress,
      device?.latestSnapshotId,
    );
  }

  return values.some((value) => normalizeSearchValue(value).includes(normalizedQuery));
}

function normalizeVersionConsistencySort(value) {
  return VERSION_CONSISTENCY_SORT_KEYS.includes(value) ? value : 'risk';
}

function getComparableNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function compareVersionConsistencyRisk(a, b) {
  return (
    (VERSION_CONSISTENCY_SORT_ORDER[a?.status] ?? 99) - (VERSION_CONSISTENCY_SORT_ORDER[b?.status] ?? 99)
    || getValidDateTime(b?.latestCreatedAt) - getValidDateTime(a?.latestCreatedAt)
    || String(a?.jobName || '').localeCompare(String(b?.jobName || ''))
    || String(a?.sourcePath || '').localeCompare(String(b?.sourcePath || ''))
  );
}

function compareVersionConsistencyName(a, b) {
  return (
    String(a?.jobName || '').localeCompare(String(b?.jobName || ''))
    || String(a?.sourcePath || '').localeCompare(String(b?.sourcePath || ''))
    || compareVersionConsistencyRisk(a, b)
  );
}

function compareVersionConsistencyGroups(a, b, sort) {
  if (sort === 'coverage-gap') {
    const missingA = a?.missingDeviceCount || 0;
    const missingB = b?.missingDeviceCount || 0;
    if (missingB !== missingA) {
      return missingB - missingA;
    }
    const expectedA = a?.expectedDeviceCount || 0;
    const expectedB = b?.expectedDeviceCount || 0;
    const ratioA = expectedA <= 0 ? 0 : missingA / expectedA;
    const ratioB = expectedB <= 0 ? 0 : missingB / expectedB;
    if (ratioB !== ratioA) {
      return ratioB - ratioA;
    }
    if (expectedB !== expectedA) {
      return expectedB - expectedA;
    }
    return compareVersionConsistencyRisk(a, b);
  }
  if (sort === 'max-drift') {
    return (
      getComparableNumber(b?.maxTimeDriftMs) - getComparableNumber(a?.maxTimeDriftMs)
      || compareVersionConsistencyRisk(a, b)
    );
  }
  if (sort === 'stale-count') {
    return (
      getComparableNumber(b?.staleCount) - getComparableNumber(a?.staleCount)
      || getComparableNumber(b?.maxTimeDriftMs) - getComparableNumber(a?.maxTimeDriftMs)
      || compareVersionConsistencyRisk(a, b)
    );
  }
  if (sort === 'latest') {
    return (
      getValidDateTime(b?.latestCreatedAt) - getValidDateTime(a?.latestCreatedAt)
      || compareVersionConsistencyName(a, b)
    );
  }
  if (sort === 'name') {
    return compareVersionConsistencyName(a, b);
  }
  return 0;
}

export function filterVersionConsistencyGroups(consistency, controls) {
  const groups = Array.isArray(consistency?.groups) ? consistency.groups : [];
  const status = controls?.status || 'all';
  const validStatus = ['all', 'drifted', 'single-device', 'synced'].includes(status) ? status : 'all';
  const sort = normalizeVersionConsistencySort(controls?.sort || 'risk');
  const coverage = controls?.coverage || 'all';
  const validCoverage = ['all', 'gap', 'full', 'unobservable'].includes(coverage) ? coverage : 'all';

  const filteredGroups = groups
    .filter((group) => validStatus === 'all' || group?.status === validStatus)
    .filter((group) => matchesVersionConsistencySearch(group, controls?.query || ''))
    .filter((group) => {
      if (validCoverage === 'gap') {
        return (group?.expectedDeviceCount || 0) > 0 && (group?.missingDeviceCount || 0) > 0;
      }
      if (validCoverage === 'full') {
        return (group?.expectedDeviceCount || 0) > 0 && (group?.missingDeviceCount || 0) === 0;
      }
      if (validCoverage === 'unobservable') {
        return (group?.expectedDeviceCount || 0) <= 0;
      }
      return true;
    });

  if (sort === 'risk') {
    return filteredGroups;
  }

  return filteredGroups.slice().sort((a, b) => compareVersionConsistencyGroups(a, b, sort));
}

export function isApiRequestUrl(url) {
  const value = String(url || '');
  const path = value.split('?')[0];
  return path === '/api' || path.startsWith('/api/');
}

export function buildApiFetchOptions(url, options = undefined, apiAuthToken = '') {
  if (!apiAuthToken || !isApiRequestUrl(url)) return options;
  const nextOptions = { ...(options || {}) };
  nextOptions.headers = { ...(nextOptions.headers || {}) };
  nextOptions.headers.Authorization = 'Bearer ' + apiAuthToken;
  return nextOptions;
}

// ── Console Initializer ───────────────────────────────────────────

export function initConsole(doc, fetchImpl, intervalImpl) {
  const apiTokenInput = doc.getElementById('api-token-input');
  const apiTokenApplyButton = doc.getElementById('api-token-apply');
  const apiTokenClearButton = doc.getElementById('api-token-clear');
  const apiTokenStatusEl = doc.getElementById('api-token-status');
  const releaseHealthPanelEl = doc.getElementById('release-health-panel');
  const releaseHealthStatusEl = doc.getElementById('release-health-status');
  const releaseHealthVersionEl = doc.getElementById('release-health-version');
  const releaseHealthDataDirEl = doc.getElementById('release-health-data-dir');
  const releaseHealthTimestampEl = doc.getElementById('release-health-timestamp');
  const releaseHealthMessageEl = doc.getElementById('release-health-message');
  const releaseHealthRefreshButton = doc.getElementById('release-health-refresh');
  const releaseReadinessPanelEl = doc.getElementById('release-readiness-panel');
  const releaseReadinessStatusEl = doc.getElementById('release-readiness-status');
  const releaseReadinessExpectedVersionEl = doc.getElementById('release-readiness-expected-version');
  const releaseReadinessActualVersionEl = doc.getElementById('release-readiness-actual-version');
  const releaseReadinessFailedCountEl = doc.getElementById('release-readiness-failed-count');
  const releaseReadinessTimestampEl = doc.getElementById('release-readiness-timestamp');
  const releaseReadinessChecklistEl = doc.getElementById('release-readiness-checklist');
  const releaseReadinessMessageEl = doc.getElementById('release-readiness-message');
  const releaseReadinessRefreshButton = doc.getElementById('release-readiness-refresh');
  const goldReadinessPanelEl = doc.getElementById('gold-readiness-panel');
  const goldReadinessStatusEl = doc.getElementById('gold-readiness-status');
  const goldReadinessReadyCountEl = doc.getElementById('gold-readiness-ready-count');
  const goldReadinessPartialCountEl = doc.getElementById('gold-readiness-partial-count');
  const goldReadinessBlockedCountEl = doc.getElementById('gold-readiness-blocked-count');
  const goldReadinessTotalCountEl = doc.getElementById('gold-readiness-total-count');
  const goldReadinessGeneratedAtEl = doc.getElementById('gold-readiness-generated-at');
  const goldReadinessListEl = doc.getElementById('gold-readiness-list');
  const goldReadinessMessageEl = doc.getElementById('gold-readiness-message');
  const goldReadinessRefreshButton = doc.getElementById('gold-readiness-refresh');
  const hardeningStatusPanelEl = doc.getElementById('hardening-status-panel');
  const hardeningStatusAuthEl = doc.getElementById('hardening-status-auth');
  const hardeningStatusScopedTokensEl = doc.getElementById('hardening-status-scoped-tokens');
  const hardeningStatusRateLimitEl = doc.getElementById('hardening-status-rate-limit');
  const hardeningStatusAuditRetentionEl = doc.getElementById('hardening-status-audit-retention');
  const hardeningStatusRestoreRootEl = doc.getElementById('hardening-status-restore-root');
  const hardeningStatusRequestLimitEl = doc.getElementById('hardening-status-request-limit');
  const hardeningStatusWriteRoutesEl = doc.getElementById('hardening-status-write-routes');
  const hardeningStatusMessageEl = doc.getElementById('hardening-status-message');
  const hardeningStatusRefreshButton = doc.getElementById('hardening-status-refresh');
  const supervisorStatusPanelEl = doc.getElementById('supervisor-status-panel');
  const supervisorStatusStateEl = doc.getElementById('supervisor-status-state');
  const supervisorStatusInstalledEl = doc.getElementById('supervisor-status-installed');
  const supervisorStatusManagedEl = doc.getElementById('supervisor-status-managed');
  const supervisorStatusLaunchdEl = doc.getElementById('supervisor-status-launchd');
  const supervisorStatusWatchdogEl = doc.getElementById('supervisor-status-watchdog');
  const supervisorStatusMonitoringEl = doc.getElementById('supervisor-status-monitoring');
  const supervisorStatusRecoveryEl = doc.getElementById('supervisor-status-recovery');
  const supervisorStatusSafetyEl = doc.getElementById('supervisor-status-safety');
  const supervisorStatusMessageEl = doc.getElementById('supervisor-status-message');
  const supervisorStatusRefreshButton = doc.getElementById('supervisor-status-refresh');
  const auditLogPanelEl = doc.getElementById('audit-log-panel');
  const auditLogStatusEl = doc.getElementById('audit-log-status');
  const auditLogCountEl = doc.getElementById('audit-log-count');
  const auditLogLatestTypeEl = doc.getElementById('audit-log-latest-type');
  const auditLogLatestDeviceEl = doc.getElementById('audit-log-latest-device');
  const auditLogListEl = doc.getElementById('audit-log-list');
  const auditLogMessageEl = doc.getElementById('audit-log-message');
  const auditLogRefreshButton = doc.getElementById('audit-log-refresh');

  let apiAuthToken = '';

  function renderApiTokenStatus(message, state = 'unset') {
    if (!apiTokenStatusEl) return;
    apiTokenStatusEl.textContent = message;
    if (apiTokenStatusEl.setAttribute) {
      apiTokenStatusEl.setAttribute('data-state', state);
    }
  }

  function setApiToken(token) {
    apiAuthToken = String(token || '').trim();
    if (apiAuthToken) {
      renderApiTokenStatus('已设置', 'set');
    } else {
      renderApiTokenStatus('未设置', 'unset');
    }
  }

  function clearApiToken(message = '已清除') {
    apiAuthToken = '';
    if (apiTokenInput) apiTokenInput.value = '';
    renderApiTokenStatus(message, message.includes('失败') ? 'error' : 'unset');
  }

  async function apiFetch(url, options = undefined) {
    const res = await fetchImpl(url, buildApiFetchOptions(url, options, apiAuthToken));
    if (res && res.status === 401 && apiAuthToken) {
      clearApiToken('认证失败，请重新输入');
    }
    return res;
  }

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
  const supervisorInstallDryRunConfigInput = doc.getElementById('supervisor-install-dry-run-config');
  const supervisorInstallDryRunRunButton = doc.getElementById('supervisor-install-dry-run-run');
  const supervisorInstallDryRunStatusEl = doc.getElementById('supervisor-install-dry-run-status');
  const supervisorInstallDryRunInstallStateEl = doc.getElementById('supervisor-install-dry-run-install-state');
  const supervisorInstallDryRunApprovalStateEl = doc.getElementById('supervisor-install-dry-run-approval-state');
  const supervisorInstallDryRunRollbackStateEl = doc.getElementById('supervisor-install-dry-run-rollback-state');
  const supervisorInstallDryRunResultEl = doc.getElementById('supervisor-install-dry-run-result');
  const supervisorLifecycleApprovalPreviewConfigInput = doc.getElementById('supervisor-lifecycle-approval-preview-config');
  const supervisorLifecycleApprovalPreviewApprovalInput = doc.getElementById('supervisor-lifecycle-approval-preview-approval');
  const supervisorLifecycleApprovalPreviewOperationInput = doc.getElementById('supervisor-lifecycle-approval-preview-operation');
  const supervisorLifecycleApprovalPreviewRunButton = doc.getElementById('supervisor-lifecycle-approval-preview-run');
  const supervisorLifecycleApprovalPersistButton = doc.getElementById('supervisor-lifecycle-approval-persist-button');
  const supervisorLifecycleApprovalRecordsButton = doc.getElementById('supervisor-lifecycle-approval-records-button');
  const supervisorLifecycleApplyReadinessButton = doc.getElementById('supervisor-lifecycle-apply-readiness-button');
  const supervisorLifecycleExecutorReadinessButton = doc.getElementById('supervisor-lifecycle-executor-readiness-button');
  const supervisorLifecycleExecutorManifestReadinessManifestInput = doc.getElementById('supervisor-lifecycle-executor-manifest-readiness-manifest');
  const supervisorLifecycleExecutorManifestReadinessButton = doc.getElementById('supervisor-lifecycle-executor-manifest-readiness-button');
  const supervisorLifecycleGuardedRunnerReadinessRunnerBindingInput = doc.getElementById('supervisor-lifecycle-guarded-runner-readiness-runner-binding');
  const supervisorLifecycleGuardedRunnerReadinessButton = doc.getElementById('supervisor-lifecycle-guarded-runner-readiness-button');
  const supervisorLifecycleGuardedRunnerExecutionPreviewButton = doc.getElementById('supervisor-lifecycle-guarded-runner-execution-preview-button');
  const supervisorLifecycleGuardedRunnerExecutionGateButton = doc.getElementById('supervisor-lifecycle-guarded-runner-execution-gate-button');
  const supervisorLifecycleApprovalPreviewStatusEl = doc.getElementById('supervisor-lifecycle-approval-preview-status');
  const supervisorLifecycleApprovalPreviewValidEl = doc.getElementById('supervisor-lifecycle-approval-preview-valid');
  const supervisorLifecycleApprovalPreviewPersistEl = doc.getElementById('supervisor-lifecycle-approval-preview-persist');
  const supervisorLifecycleApprovalPreviewResultEl = doc.getElementById('supervisor-lifecycle-approval-preview-result');
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
  const versionConsistencySyncedCountEl = doc.getElementById('version-consistency-synced-count');
  const versionConsistencyDriftedCountEl = doc.getElementById('version-consistency-drifted-count');
  const versionConsistencySingleCountEl = doc.getElementById('version-consistency-single-count');
  const versionConsistencyTotalCountEl = doc.getElementById('version-consistency-total-count');
  const versionConsistencyCoverageSummaryEl = doc.getElementById('version-consistency-coverage-summary');
  const versionConsistencyListEl = doc.getElementById('version-consistency-list');
  const versionConsistencySearchInput = doc.getElementById('version-consistency-search');
  const versionConsistencyStatusFilter = doc.getElementById('version-consistency-status-filter');
  const versionConsistencySortSelect = doc.getElementById('version-consistency-sort');
  const versionConsistencyCoverageFilter = doc.getElementById('version-consistency-coverage-filter');
  const versionConsistencyFilterCountEl = doc.getElementById('version-consistency-filter-count');

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
  let versionConsistencyRequestId = 0;
  let cachedVersionConsistency = {
    summary: { synced: 0, drifted: 0, singleDevice: 0, total: 0 },
    groups: [],
  };
  let cachedSnapshots = [];
  let cachedDevices = [];

  const deviceSearchInput = doc.getElementById('device-search');
  const deviceStatusFilter = doc.getElementById('device-status-filter');
  const deviceManagementFilter = doc.getElementById('device-management-filter');
  const deviceSortSelect = doc.getElementById('device-sort');
  const deviceFilterResetButton = doc.getElementById('device-filter-reset');
  const deviceFilterCountEl = doc.querySelector('[data-testid="device-filter-count"]');
  const deviceActiveFilterSummaryEl = doc.querySelector('[data-testid="device-active-filter-summary"]');

  const deviceManagementSummary = doc.querySelector('[data-testid="device-management-summary"]');
  const summaryAll = doc.querySelector('[data-testid="device-management-summary-all"]');
  const summaryVisible = doc.querySelector('[data-testid="device-management-summary-visible"]');
  const summaryMissingIp = doc.querySelector('[data-testid="device-management-summary-missing-ip"]');
  const summaryOfflineRetained = doc.querySelector('[data-testid="device-management-summary-offline-retained"]');
  const summaryUnknown = doc.querySelector('[data-testid="device-management-summary-unknown"]');

  const deviceManagementSummaryBuckets = [
    { el: summaryAll, filterValue: 'all', countKey: 'all', label: '全部' },
    { el: summaryVisible, filterValue: 'visible', countKey: 'visible', label: '在线可见' },
    { el: summaryMissingIp, filterValue: 'missing-ip', countKey: 'missingIp', label: '在线缺 IP' },
    { el: summaryOfflineRetained, filterValue: 'offline-retained', countKey: 'offlineRetained', label: '离线保留' },
    { el: summaryUnknown, filterValue: 'unknown', countKey: 'unknown', label: '未知待确认' },
  ];

  function getDeviceControls() {
    return {
      query: deviceSearchInput?.value || '',
      status: deviceStatusFilter?.value || 'all',
      management: deviceManagementFilter?.value || 'all',
      sort: deviceSortSelect?.value || 'name',
    };
  }

  function renderDeviceFilterCount(visibleCount, totalCount) {
    if (deviceFilterCountEl) {
      const state = buildDeviceFilterCountState(visibleCount, totalCount);
      deviceFilterCountEl.textContent = state.text;
      if (deviceFilterCountEl.setAttribute) {
        deviceFilterCountEl.setAttribute('data-filtered', state.filtered ? 'true' : 'false');
        deviceFilterCountEl.setAttribute('data-visible-count', String(state.visible));
        deviceFilterCountEl.setAttribute('data-total-count', String(state.total));
      }
    }
  }

  function syncDeviceFilterResetState(controls) {
    if (!deviceFilterResetButton) return;
    const active = isDeviceFilterResetActive(controls);
    deviceFilterResetButton.disabled = !active;
    if (deviceFilterResetButton.setAttribute) {
      deviceFilterResetButton.setAttribute('aria-disabled', active ? 'false' : 'true');
      deviceFilterResetButton.setAttribute('data-active', active ? 'true' : 'false');
    }
  }

  function renderDeviceActiveFilterSummary(controls) {
    if (deviceActiveFilterSummaryEl) {
      const state = buildDeviceActiveFilterSummaryState(controls);
      deviceActiveFilterSummaryEl.textContent = state.text;
      if (deviceActiveFilterSummaryEl.setAttribute) {
        deviceActiveFilterSummaryEl.setAttribute('data-active', state.active ? 'true' : 'false');
      }
    }
  }

  function renderFilteredDevices() {
    const controls = getDeviceControls();
    syncDeviceFilterResetState(controls);
    renderDeviceActiveFilterSummary(controls);
    renderDeviceManagementSummary(cachedDevices, controls);
    const visibleDevices = applyDeviceListControls(cachedDevices, controls);
    renderDeviceFilterCount(visibleDevices.length, cachedDevices.length);
    renderDevices(visibleDevices, controls);
  }

  function setDeviceManagementSummaryActive(summaryEl, active) {
    if (!summaryEl) return;
    const activeValue = active ? 'true' : 'false';
    if (summaryEl.setAttribute) {
      summaryEl.setAttribute('aria-pressed', activeValue);
      summaryEl.setAttribute('data-active', activeValue);
    }
    summaryEl.className = active ? 'summary-bucket is-active' : 'summary-bucket';
  }

  function renderDeviceManagementSummary(devices, controls = getDeviceControls()) {
    const summary = buildDeviceManagementSummaryScope(devices, controls);
    const activeManagement = controls.management;
    for (const bucket of deviceManagementSummaryBuckets) {
      if (!bucket.el) continue;
      bucket.el.textContent = bucket.label + ': ' + String(summary[bucket.countKey] || 0);
      setDeviceManagementSummaryActive(bucket.el, activeManagement === bucket.filterValue);
    }
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
  if (versionConsistencyStatusFilter && !versionConsistencyStatusFilter.value) {
    versionConsistencyStatusFilter.value = 'all';
  }
  if (versionConsistencySortSelect && !versionConsistencySortSelect.value) {
    versionConsistencySortSelect.value = 'risk';
  }
  if (versionConsistencyCoverageFilter && !versionConsistencyCoverageFilter.value) {
    versionConsistencyCoverageFilter.value = 'all';
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
      const res = await apiFetch('/api/devices');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const devices = await res.json();
      cachedDevices = devices;
      const selectedDevice = devices.find((d) => d.deviceId === selectedDeviceId) || null;
      if (!selectedDevice) selectedDeviceId = null;
      renderFleetSummary(devices);
      renderFilteredDevices();
      renderDeviceDetail(selectedDevice);
      renderDeviceBackupHealth(devices);
      fetchBackupVersionConsistency(devices);
      logEvent('已加载 ' + devices.length + ' 台设备', 'info');
    } catch (err) {
      renderDeviceManagementSummary([]);
      renderDeviceBackupHealth([]);
      renderBackupVersionConsistency([], {});
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
    appendDeviceDetailRow(grid, 'device-detail-management-state', '管理状态', getDeviceManagementState(device));
    appendDeviceDetailRow(grid, 'device-detail-management-hint', '管理提示', getDeviceManagementHint(device));
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

  function setVersionConsistencyCounts(summary) {
    if (versionConsistencySyncedCountEl) versionConsistencySyncedCountEl.textContent = String(summary.synced);
    if (versionConsistencyDriftedCountEl) versionConsistencyDriftedCountEl.textContent = String(summary.drifted);
    if (versionConsistencySingleCountEl) versionConsistencySingleCountEl.textContent = String(summary.singleDevice);
    if (versionConsistencyTotalCountEl) versionConsistencyTotalCountEl.textContent = String(summary.total);
    if (versionConsistencyCoverageSummaryEl) {
      if (summary.coverage) {
        const cov = summary.coverage;
        versionConsistencyCoverageSummaryEl.textContent =
          '基于 ' + String(cov.coverageDeviceCount) + ' 台可观测设备检测。' +
          '排除加载失败: ' + String(cov.coverageExcludedDeviceCount) + ' 台。' +
          '完全覆盖任务数: ' + String(cov.fullyCoveredCount) + '。' +
          '覆盖缺口任务数: ' + String(cov.coverageGapCount) +
          ' (按当前可观测设备口径存在缺失，包含单设备任务组)。';
      } else {
        versionConsistencyCoverageSummaryEl.textContent = '';
      }
    }
  }

  function setVersionConsistencyFilterCount(visibleCount, totalCount) {
    if (versionConsistencyFilterCountEl) {
      versionConsistencyFilterCountEl.textContent = String(visibleCount) + ' / ' + String(totalCount);
    }
  }

  function getVersionConsistencyControls() {
    return {
      query: versionConsistencySearchInput?.value || '',
      status: versionConsistencyStatusFilter?.value || 'all',
      sort: versionConsistencySortSelect?.value || 'risk',
      coverage: versionConsistencyCoverageFilter?.value || 'all',
    };
  }

  function setVersionConsistencyPlaceholder(message) {
    clearElement(versionConsistencyListEl);
    setVersionConsistencyCounts({ synced: 0, drifted: 0, singleDevice: 0, total: 0 });
    setVersionConsistencyFilterCount(0, 0);
    if (!versionConsistencyListEl) return;
    const item = doc.createElement('li');
    item.className = 'placeholder';
    item.textContent = message;
    if (typeof versionConsistencyListEl.appendChild === 'function') {
      versionConsistencyListEl.appendChild(item);
    }
  }

  function appendVersionConsistencyField(parent, testId, value) {
    const field = doc.createElement('span');
    field.setAttribute('data-testid', testId);
    field.textContent = value;
    parent.appendChild(field);
    return field;
  }

  function selectVersionConsistencySnapshot(deviceId, snapshotId) {
    const safeDeviceId = String(deviceId || '').trim();
    const safeSnapshotId = String(snapshotId || '').trim();
    if (!safeDeviceId || !safeSnapshotId) return;

    const sourceDevice = cachedDevices.find((device) => device.deviceId === safeDeviceId) || {
      deviceId: safeDeviceId,
      hostname: safeDeviceId,
    };

    selectedDeviceId = safeDeviceId;
    selectedSnapshotId = safeSnapshotId;
    selectedBackupJobKey = null;
    cachedSnapshots = [];
    setBackupJobDetailPlaceholder('加载中…', safeDeviceId);
    renderDeviceDetail(sourceDevice);
    renderFilteredDevices();
    fetchSnapshots(safeDeviceId);
    fetchRetentionPlan(safeDeviceId);
    fetchSnapshotManifest(safeDeviceId, safeSnapshotId);
    fetchRestoreDryRunPlan(safeDeviceId, safeSnapshotId);
  }

  function renderVersionConsistencyRows(groups, totalCount) {
    clearElement(versionConsistencyListEl);
    if (!versionConsistencyListEl) return;

    setVersionConsistencyFilterCount(groups.length, totalCount);

    if (groups.length === 0) {
      const item = doc.createElement('li');
      item.className = 'placeholder';
      item.textContent = totalCount === 0 ? '暂无版本一致性数据' : '无匹配版本一致性任务';
      if (typeof versionConsistencyListEl.appendChild === 'function') {
        versionConsistencyListEl.appendChild(item);
      }
      return;
    }

    groups.forEach(function (group) {
      const row = doc.createElement('li');
      row.className = 'version-consistency-item version-consistency-' + group.status;
      row.setAttribute('data-testid', 'version-consistency-item');
      row.setAttribute('data-version-status', group.status);
      row.dataset.versionStatus = group.status;

      appendVersionConsistencyField(row, 'version-consistency-name', group.jobName);
      appendVersionConsistencyField(row, 'version-consistency-source', group.sourcePath);
      appendVersionConsistencyField(row, 'version-consistency-status', group.statusLabel);
      appendVersionConsistencyField(row, 'version-consistency-reason', group.reason);
      appendVersionConsistencyField(row, 'version-consistency-latest', formatLastBackup(group.latestCreatedAt));
      appendVersionConsistencyField(row, 'version-consistency-snapshots', String(group.snapshotCount) + ' 快照');

      // V0.25 staleness summary
      const summaryEl = doc.createElement('div');
      summaryEl.className = 'version-consistency-staleness-summary';
      summaryEl.setAttribute('data-testid', 'version-consistency-staleness-summary');

      let staleText = '';
      if (group.staleDeviceNames && group.staleDeviceNames.length > 0) {
        if (group.staleDeviceNames.length <= 3) {
          staleText = group.staleDeviceNames.join(', ');
        } else {
          staleText = group.staleDeviceNames.slice(0, 3).join(', ') + ' +' + (group.staleDeviceNames.length - 3) + ' 更多';
        }
      }

      let text = '最新 ' + group.latestCount + ' · 非最新 ' + group.staleCount + ' · 单设备 ' + group.singleCount + ' · 最大时间差 ' + (group.maxTimeDriftMs !== null ? group.maxTimeDriftMs + 'ms' : '无');
      if (staleText) {
        text += ' · 非最新设备: ' + staleText;
      }
      summaryEl.textContent = text;
      row.appendChild(summaryEl);

      // V0.27 覆盖缺口元素
      const coverageEl = doc.createElement('div');
      coverageEl.className = 'version-consistency-coverage-gap';
      coverageEl.setAttribute('data-testid', 'version-consistency-coverage-gap');

      let missingText = '';
      if (group.missingDeviceNames && group.missingDeviceNames.length > 0) {
        if (group.missingDeviceNames.length <= 3) {
          missingText = group.missingDeviceNames.join(', ');
        } else {
          missingText = group.missingDeviceNames.slice(0, 3).join(', ') + ' +' + (group.missingDeviceNames.length - 3) + ' 更多';
        }
      }

      const expectedDeviceCount = Number(group.expectedDeviceCount) || 0;
      const coveredDeviceCount = Number(group.coveredDeviceCount) || 0;
      let coverageText = '覆盖 ' + String(group.coveredDeviceCount) + ' / ' + String(group.expectedDeviceCount);
      if (expectedDeviceCount > 0) {
        coverageText += ' · 覆盖率 ' + String(Math.round((coveredDeviceCount / expectedDeviceCount) * 100)) + '%';
      } else {
        coverageText += ' · 无可观测设备';
      }
      coverageEl.textContent = coverageText + (missingText ? ' · 缺 ' + missingText : '');
      row.appendChild(coverageEl);

      group.devices.forEach(function (device) {
        const deviceField = doc.createElement('span');
        deviceField.className = 'version-consistency-device version-state-' + device.versionState;
        deviceField.setAttribute('data-testid', 'version-consistency-device');
        deviceField.setAttribute('data-device-id', device.deviceId);
        deviceField.setAttribute('data-snapshot-id', device.latestSnapshotId);
        deviceField.setAttribute('data-version-state', device.versionState);
        deviceField.dataset.deviceId = device.deviceId;
        deviceField.dataset.snapshotId = device.latestSnapshotId;
        deviceField.dataset.versionState = device.versionState;
        deviceField.addEventListener('click', function () {
          selectVersionConsistencySnapshot(device.deviceId, device.latestSnapshotId);
        });
        deviceField.textContent = device.hostname + ' · ' + device.deviceId + ' · '
          + device.ipAddress + ' · ' + device.versionState + ' · '
          + formatLastBackup(device.latestCreatedAt) + ' · '
          + String(device.latestFileCount || 0) + ' files';
        row.appendChild(deviceField);
      });

      if (typeof versionConsistencyListEl.appendChild === 'function') {
        versionConsistencyListEl.appendChild(row);
      }
    });
  }

  function renderFilteredVersionConsistency() {
    const groups = filterVersionConsistencyGroups(cachedVersionConsistency, getVersionConsistencyControls());
    renderVersionConsistencyRows(groups, cachedVersionConsistency.groups.length);
  }

  function renderBackupVersionConsistency(devices, snapshotsByDevice, options = {}) {
    cachedVersionConsistency = buildBackupVersionConsistency(devices, snapshotsByDevice, options);
    setVersionConsistencyCounts(cachedVersionConsistency.summary);
    renderFilteredVersionConsistency();
  }

  async function fetchBackupVersionConsistency(devices) {
    const safeDevices = Array.isArray(devices) ? devices : [];
    const requestId = ++versionConsistencyRequestId;

    if (safeDevices.length === 0) {
      renderBackupVersionConsistency([], {});
      return;
    }

    setVersionConsistencyPlaceholder('加载中...');

    const entries = await Promise.all(safeDevices.map(async function (device) {
      const deviceId = String(device?.deviceId || '').trim();
      if (!deviceId) return null;
      try {
        const res = await apiFetch('/api/devices/' + encodeURIComponent(deviceId) + '/snapshots');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const snapshots = await res.json();
        return [deviceId, Array.isArray(snapshots) ? snapshots : [], false];
      } catch (err) {
        logEvent('加载版本一致性快照失败 (' + deviceId + '): ' + err.message, 'error');
        return [deviceId, [], true];
      }
    }));

    if (requestId !== versionConsistencyRequestId) return;

    const snapshotsByDevice = {};
    const excludedCoverageDeviceIds = [];
    entries.forEach(function (entry) {
      if (!entry) return;
      snapshotsByDevice[entry[0]] = entry[1];
      if (entry[2]) {
        excludedCoverageDeviceIds.push(entry[0]);
      }
    });
    renderBackupVersionConsistency(safeDevices, snapshotsByDevice, { excludedCoverageDeviceIds });
    const consistency = buildBackupVersionConsistency(safeDevices, snapshotsByDevice, { excludedCoverageDeviceIds });
    logEvent('已加载版本一致性 ' + consistency.summary.total + ' 个任务组', 'info');
  }

  function renderDevices(devices, controls = {}) {
    clearElement(deviceListEl);
    if (devices.length === 0) {
      const emptyItem = doc.createElement('li');
      emptyItem.className = 'placeholder';
      emptyItem.setAttribute('data-testid', 'device-empty-state');

      const message = doc.createElement('span');
      message.textContent = '无匹配设备';

      const context = doc.createElement('span');
      context.className = 'device-empty-filter-context';
      context.setAttribute('data-testid', 'device-empty-filter-context');
      context.textContent = buildDeviceEmptyFilterContext(controls);

      emptyItem.appendChild(message);
      emptyItem.appendChild(context);
      deviceListEl.appendChild(emptyItem);
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

      const managementState = doc.createElement('span');
      managementState.className = 'device-management-state';
      managementState.setAttribute('data-testid', 'device-management-state');
      managementState.textContent = getDeviceManagementState(device);
      li.appendChild(managementState);

      const managementHint = doc.createElement('span');
      managementHint.className = 'device-management-hint';
      managementHint.setAttribute('data-testid', 'device-management-hint');
      managementHint.textContent = getDeviceManagementHint(device);
      li.appendChild(managementHint);

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
      const res = await apiFetch('/api/devices/' + encodeURIComponent(deviceId) + '/snapshots');
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
      const res = await apiFetch(
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
      const res = await apiFetch(
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
      const res = await apiFetch('/api/backup-preflight-dry-run?' + params.toString());
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

    if (plan.executionGate) {
      const gateRow = doc.createElement('div');
      gateRow.className = 'nas-dry-run-gate-row';

      const statusSpan = doc.createElement('span');
      statusSpan.className = 'nas-gate-status';
      statusSpan.textContent = '远程执行：' + (plan.executionGate.remoteExecutionAllowed ? '已允许' : '已阻止');

      const reasonSpan = doc.createElement('span');
      reasonSpan.className = 'nas-gate-reason';
      reasonSpan.textContent = ' (阻止原因：' + (plan.executionGate.blockingReason || '无') + ')';

      const typeSpan = doc.createElement('span');
      typeSpan.className = 'nas-gate-type';
      typeSpan.textContent = ' · 当前仍为 dry-run 预检计划';

      gateRow.appendChild(statusSpan);
      gateRow.appendChild(reasonSpan);
      gateRow.appendChild(typeSpan);
      nasDryRunResultEl.appendChild(gateRow);
    }

    if (plan.readinessSummary) {
      const summaryDiv = doc.createElement('div');
      summaryDiv.className = 'nas-readiness-summary';

      const title = doc.createElement('h3');
      title.textContent = 'NAS 执行就绪性摘要';
      summaryDiv.appendChild(title);

      const countsRow = doc.createElement('div');
      countsRow.className = 'nas-readiness-counts';
      countsRow.textContent = `状态: ${plan.readinessSummary.state} | ` +
        `总目标: ${plan.readinessSummary.totalTargets} | ` +
        `已启用: ${plan.readinessSummary.enabledTargets} | ` +
        `已禁用: ${plan.readinessSummary.disabledTargets} | ` +
        `凭证配置: ${plan.readinessSummary.credentialRefConfiguredTargets} | ` +
        `启用缺凭证: ${plan.readinessSummary.enabledCredentialRefMissingTargets} | ` +
        `受阻目标: ${plan.readinessSummary.blockedTargets}`;
      summaryDiv.appendChild(countsRow);

      if (plan.readinessSummary.blockers && plan.readinessSummary.blockers.length > 0) {
        const blockersDiv = doc.createElement('div');
        blockersDiv.className = 'nas-readiness-blockers';
        blockersDiv.textContent = '就绪性卡点: ' + plan.readinessSummary.blockers.join(', ');
        summaryDiv.appendChild(blockersDiv);
      }

      nasDryRunResultEl.appendChild(summaryDiv);
    }

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

      const credRow = doc.createElement('div');
      credRow.className = 'nas-dry-run-cred-row';
      credRow.textContent = '凭证引用：' + (target.credentialRefConfigured ? '已配置' : '未配置');
      item.appendChild(credRow);

      if (target.executionReadiness) {
        const readinessRow = doc.createElement('div');
        readinessRow.className = 'nas-dry-run-readiness-row';
        readinessRow.textContent = `执行就绪状态: ${target.executionReadiness.state}` +
          (target.executionReadiness.blockers && target.executionReadiness.blockers.length > 0
            ? ` (卡点: ${target.executionReadiness.blockers.join(', ')})`
            : '');
        item.appendChild(readinessRow);
      }

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
      const res = await apiFetch('/api/nas-dry-run', {
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

  function setSupervisorInstallDryRunError(message) {
    const viewModel = buildSupervisorInstallDryRunViewModel(null, message);
    renderSupervisorInstallDryRun(viewModel);
  }

  function setSupervisorLifecycleApprovalPreviewError(message) {
    const viewModel = buildSupervisorLifecycleApprovalPersistencePreviewViewModel(null, message);
    renderSupervisorLifecycleApprovalPreview(viewModel);
  }

  function setSupervisorLifecycleApplyReadinessError(message) {
    const viewModel = buildSupervisorLifecycleApplyReadinessViewModel(null, message);
    renderSupervisorLifecycleApprovalPreview(viewModel);
  }

  function setSupervisorLifecycleExecutorReadinessError(message) {
    const viewModel = buildSupervisorLifecycleExecutorReadinessViewModel(null, message);
    renderSupervisorLifecycleApprovalPreview(viewModel);
  }

  function setSupervisorLifecycleGuardedRunnerReadinessError(message) {
    const viewModel = buildSupervisorLifecycleGuardedRunnerReadinessViewModel(null, message);
    renderSupervisorLifecycleApprovalPreview(viewModel);
  }

  function setSupervisorLifecycleGuardedRunnerExecutionPreviewError(message) {
    const viewModel = buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel(null, message);
    renderSupervisorLifecycleApprovalPreview(viewModel);
  }

  function setSupervisorLifecycleGuardedRunnerExecutionGateError(message) {
    const viewModel = buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(null, message);
    renderSupervisorLifecycleApprovalPreview(viewModel);
  }

  function appendSupervisorInstallGroup(titleText, lines) {
    if (!supervisorInstallDryRunResultEl || lines.length === 0) return;
    const group = doc.createElement('div');
    group.className = 'supervisor-install-dry-run-group';

    const title = doc.createElement('h3');
    title.textContent = titleText;
    if (typeof group.appendChild === 'function') {
      group.appendChild(title);
    }

    const list = doc.createElement('ul');
    lines.forEach((line) => {
      const item = doc.createElement('li');
      item.textContent = line;
      if (typeof list.appendChild === 'function') {
        list.appendChild(item);
      }
    });
    if (typeof group.appendChild === 'function') {
      group.appendChild(list);
    }
    if (typeof supervisorInstallDryRunResultEl.appendChild === 'function') {
      supervisorInstallDryRunResultEl.appendChild(group);
    }
  }

  function renderSupervisorInstallDryRun(viewModel) {
    const state = viewModel || buildSupervisorInstallDryRunViewModel(null);
    if (supervisorInstallDryRunStatusEl) supervisorInstallDryRunStatusEl.textContent = state.statusText;
    if (supervisorInstallDryRunInstallStateEl) supervisorInstallDryRunInstallStateEl.textContent = state.installStateText;
    if (supervisorInstallDryRunApprovalStateEl) supervisorInstallDryRunApprovalStateEl.textContent = state.approvalStateText;
    if (supervisorInstallDryRunRollbackStateEl) supervisorInstallDryRunRollbackStateEl.textContent = state.rollbackStateText;
    if (!supervisorInstallDryRunResultEl) return;

    clearElement(supervisorInstallDryRunResultEl);
    if (state.statusKey === 'error') {
      const error = doc.createElement('div');
      error.className = 'supervisor-install-dry-run-error';
      error.textContent = state.messageText;
      if (typeof supervisorInstallDryRunResultEl.appendChild === 'function') {
        supervisorInstallDryRunResultEl.appendChild(error);
      }
      return;
    }

    const message = doc.createElement('p');
    message.className = 'placeholder';
    message.textContent = state.messageText;
    if (typeof supervisorInstallDryRunResultEl.appendChild === 'function') {
      supervisorInstallDryRunResultEl.appendChild(message);
    }

    appendSupervisorInstallGroup('Readiness blockers', state.readinessBlockers);
    appendSupervisorInstallGroup('Command preview', state.commandActions);
    appendSupervisorInstallGroup('Install preflight', state.preflightChecks);
    appendSupervisorInstallGroup('Approval manifest', state.approvalControls);
    appendSupervisorInstallGroup('Rollback / uninstall plan', state.rollbackUninstallActions);
    appendSupervisorInstallGroup('Rollback / uninstall safety flags', state.rollbackUninstallSafetyLines);
    appendSupervisorInstallGroup('Safety flags', state.safetyLines);
  }

  function appendSupervisorLifecycleApprovalPreviewGroup(titleText, lines) {
    if (!supervisorLifecycleApprovalPreviewResultEl || lines.length === 0) return;
    const group = doc.createElement('div');
    group.className = 'supervisor-lifecycle-approval-preview-group';

    const title = doc.createElement('h3');
    title.textContent = titleText;
    if (typeof group.appendChild === 'function') {
      group.appendChild(title);
    }

    const list = doc.createElement('ul');
    lines.forEach((line) => {
      const item = doc.createElement('li');
      item.textContent = line;
      if (typeof list.appendChild === 'function') {
        list.appendChild(item);
      }
    });
    if (typeof group.appendChild === 'function') {
      group.appendChild(list);
    }
    if (typeof supervisorLifecycleApprovalPreviewResultEl.appendChild === 'function') {
      supervisorLifecycleApprovalPreviewResultEl.appendChild(group);
    }
  }

  function renderSupervisorLifecycleApprovalPreview(viewModel) {
    const state = viewModel || buildSupervisorLifecycleApprovalPersistencePreviewViewModel(null);
    if (supervisorLifecycleApprovalPreviewStatusEl) supervisorLifecycleApprovalPreviewStatusEl.textContent = state.statusText;
    if (supervisorLifecycleApprovalPreviewValidEl) supervisorLifecycleApprovalPreviewValidEl.textContent = state.approvalValidText;
    if (supervisorLifecycleApprovalPreviewPersistEl) supervisorLifecycleApprovalPreviewPersistEl.textContent = state.persistenceText;
    if (!supervisorLifecycleApprovalPreviewResultEl) return;

    clearElement(supervisorLifecycleApprovalPreviewResultEl);
    if (state.statusKey === 'error') {
      const error = doc.createElement('div');
      error.className = 'supervisor-lifecycle-approval-preview-error';
      error.textContent = state.messageText;
      if (typeof supervisorLifecycleApprovalPreviewResultEl.appendChild === 'function') {
        supervisorLifecycleApprovalPreviewResultEl.appendChild(error);
      }
      return;
    }

    const message = doc.createElement('p');
    message.className = 'placeholder';
    message.textContent = state.messageText;
    if (typeof supervisorLifecycleApprovalPreviewResultEl.appendChild === 'function') {
      supervisorLifecycleApprovalPreviewResultEl.appendChild(message);
    }

    appendSupervisorLifecycleApprovalPreviewGroup('Runner blockers', state.runnerBlockers || []);
    appendSupervisorLifecycleApprovalPreviewGroup('Blockers', state.blockers || []);
    appendSupervisorLifecycleApprovalPreviewGroup('Next blockers', state.nextBlockers || []);
    appendSupervisorLifecycleApprovalPreviewGroup('Runner bindings', state.runnerBindingLines || []);
    appendSupervisorLifecycleApprovalPreviewGroup('Required fields', state.requiredFields);
    appendSupervisorLifecycleApprovalPreviewGroup('Approval records', state.recordLines || []);
    appendSupervisorLifecycleApprovalPreviewGroup('Validation', state.validationLines);
    appendSupervisorLifecycleApprovalPreviewGroup('Safety flags', state.safetyLines);
  }

  async function fetchSupervisorInstallDryRunPlan() {
    if (!supervisorInstallDryRunResultEl || supervisorInstallDryRunInFlight) return;

    const parsed = parseNasDryRunConfig(supervisorInstallDryRunConfigInput ? supervisorInstallDryRunConfigInput.value : '');
    if (!parsed.ok) {
      setSupervisorInstallDryRunError(parsed.error);
      return;
    }

    supervisorInstallDryRunInFlight = true;
    if (supervisorInstallDryRunRunButton) supervisorInstallDryRunRunButton.disabled = true;
    clearElement(supervisorInstallDryRunResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '加载中...';
    supervisorInstallDryRunResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-install-dry-run', {
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
      renderSupervisorInstallDryRun(buildSupervisorInstallDryRunViewModel(plan));
      logEvent('已加载 Supervisor install dry-run 预检', 'info');
    } catch (err) {
      setSupervisorInstallDryRunError(err.message);
      logEvent('加载 Supervisor install dry-run 失败: ' + sanitizeSupervisorInstallErrorMessage(err.message), 'error');
    } finally {
      supervisorInstallDryRunInFlight = false;
      if (supervisorInstallDryRunRunButton) supervisorInstallDryRunRunButton.disabled = false;
    }
  }

  function parseSupervisorLifecycleApprovalPreviewPayload() {
    const configRaw = supervisorLifecycleApprovalPreviewConfigInput ? supervisorLifecycleApprovalPreviewConfigInput.value : '';
    if (!String(configRaw || '').trim()) {
      return { ok: false, error: '配置 JSON 不能为空' };
    }

    let config;
    try {
      config = JSON.parse(configRaw);
    } catch (err) {
      return { ok: false, error: '配置 JSON 格式错误' };
    }

    let approval;
    const approvalRaw = supervisorLifecycleApprovalPreviewApprovalInput ? supervisorLifecycleApprovalPreviewApprovalInput.value : '';
    if (String(approvalRaw || '').trim()) {
      try {
        approval = JSON.parse(approvalRaw);
      } catch (err) {
        return { ok: false, error: '批准 JSON 格式错误' };
      }
    }

    return {
      ok: true,
      payload: {
        operation: supervisorLifecycleApprovalPreviewOperationInput?.value || 'install',
        config,
        ...(approval === undefined ? {} : { approval }),
      },
    };
  }

  function parseSupervisorLifecycleApplyReadinessPayload() {
    const configRaw = supervisorLifecycleApprovalPreviewConfigInput ? supervisorLifecycleApprovalPreviewConfigInput.value : '';
    if (!String(configRaw || '').trim()) {
      return { ok: false, error: '配置 JSON 不能为空' };
    }

    let config;
    try {
      config = JSON.parse(configRaw);
    } catch (err) {
      return { ok: false, error: '配置 JSON 格式错误' };
    }

    return {
      ok: true,
      payload: {
        operation: supervisorLifecycleApprovalPreviewOperationInput?.value || 'install',
        config,
      },
    };
  }

  async function fetchSupervisorLifecycleApprovalPreview() {
    if (!supervisorLifecycleApprovalPreviewResultEl || supervisorLifecycleApprovalPreviewInFlight) return;

    const parsed = parseSupervisorLifecycleApprovalPreviewPayload();
    if (!parsed.ok) {
      setSupervisorLifecycleApprovalPreviewError(parsed.error);
      return;
    }

    supervisorLifecycleApprovalPreviewInFlight = true;
    if (supervisorLifecycleApprovalPreviewRunButton) supervisorLifecycleApprovalPreviewRunButton.disabled = true;
    clearElement(supervisorLifecycleApprovalPreviewResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '加载中...';
    supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-lifecycle-approval-persistence-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.payload),
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
      const preview = await res.json();
      renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleApprovalPersistencePreviewViewModel(preview));
      logEvent('已加载 Supervisor lifecycle approval persistence preview', 'info');
    } catch (err) {
      setSupervisorLifecycleApprovalPreviewError(err.message);
      logEvent('加载 Supervisor lifecycle approval persistence preview 失败: ' + sanitizeSupervisorInstallErrorMessage(err.message), 'error');
    } finally {
      supervisorLifecycleApprovalPreviewInFlight = false;
      if (supervisorLifecycleApprovalPreviewRunButton) supervisorLifecycleApprovalPreviewRunButton.disabled = false;
    }
  }

  async function persistSupervisorLifecycleApprovalRecord() {
    if (!supervisorLifecycleApprovalPreviewResultEl || supervisorLifecycleApprovalPersistInFlight) return;

    const parsed = parseSupervisorLifecycleApprovalPreviewPayload();
    if (!parsed.ok) {
      setSupervisorLifecycleApprovalPreviewError(parsed.error);
      return;
    }
    if (!parsed.payload.approval || typeof parsed.payload.approval !== 'object' || Array.isArray(parsed.payload.approval)) {
      setSupervisorLifecycleApprovalPreviewError('批准 JSON 不能为空');
      return;
    }

    supervisorLifecycleApprovalPersistInFlight = true;
    if (supervisorLifecycleApprovalPersistButton) supervisorLifecycleApprovalPersistButton.disabled = true;
    clearElement(supervisorLifecycleApprovalPreviewResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '写入批准记录中...';
    supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-lifecycle-approval-persist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.payload),
      });
      let body;
      try {
        body = await res.json();
      } catch (_) {
        body = {};
      }
      if (!res.ok && res.status !== 409) {
        throw new Error(body.error || 'HTTP ' + res.status);
      }
      renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleApprovalPersistViewModel(body, res.status));
      logEvent(
        'Supervisor approval record persist request completed',
        res.status === 201 ? 'info' : 'warning',
      );
    } catch (err) {
      setSupervisorLifecycleApprovalPreviewError(err.message);
      logEvent('Supervisor approval record persist failed: ' + sanitizeSupervisorInstallErrorMessage(err.message), 'error');
    } finally {
      supervisorLifecycleApprovalPersistInFlight = false;
      if (supervisorLifecycleApprovalPersistButton) supervisorLifecycleApprovalPersistButton.disabled = false;
    }
  }

  async function fetchSupervisorLifecycleApprovalRecords() {
    if (!supervisorLifecycleApprovalPreviewResultEl || supervisorLifecycleApprovalRecordsInFlight) return;

    supervisorLifecycleApprovalRecordsInFlight = true;
    if (supervisorLifecycleApprovalRecordsButton) supervisorLifecycleApprovalRecordsButton.disabled = true;
    clearElement(supervisorLifecycleApprovalPreviewResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '加载批准记录中...';
    supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-lifecycle-approval-records');
      let body;
      try {
        body = await res.json();
      } catch (_) {
        body = {};
      }
      if (!res.ok) {
        throw new Error(body.error || 'HTTP ' + res.status);
      }
      renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleApprovalRecordsViewModel(body));
      logEvent('已加载 Supervisor approval records', 'info');
    } catch (err) {
      renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleApprovalRecordsViewModel(null, err.message));
      logEvent('Supervisor approval records load failed: ' + sanitizeSupervisorInstallErrorMessage(err.message), 'error');
    } finally {
      supervisorLifecycleApprovalRecordsInFlight = false;
      if (supervisorLifecycleApprovalRecordsButton) supervisorLifecycleApprovalRecordsButton.disabled = false;
    }
  }

  async function fetchSupervisorLifecycleApplyReadiness() {
    if (!supervisorLifecycleApprovalPreviewResultEl || supervisorLifecycleApplyReadinessInFlight) return;

    const parsed = parseSupervisorLifecycleApplyReadinessPayload();
    if (!parsed.ok) {
      setSupervisorLifecycleApplyReadinessError(parsed.error);
      return;
    }

    supervisorLifecycleApplyReadinessInFlight = true;
    if (supervisorLifecycleApplyReadinessButton) supervisorLifecycleApplyReadinessButton.disabled = true;
    clearElement(supervisorLifecycleApprovalPreviewResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '检查 apply readiness 中...';
    supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-lifecycle-apply-readiness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.payload),
      });
      let body;
      try {
        body = await res.json();
      } catch (_) {
        body = {};
      }
      if (!res.ok) {
        throw new Error(body.error || 'HTTP ' + res.status);
      }
      renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleApplyReadinessViewModel(body));
      logEvent('Supervisor lifecycle apply readiness preflight completed', body.state === 'ready' ? 'info' : 'warning');
    } catch (err) {
      setSupervisorLifecycleApplyReadinessError(err.message);
      logEvent('Supervisor lifecycle apply readiness failed: ' + sanitizeSupervisorInstallErrorMessage(err.message), 'error');
    } finally {
      supervisorLifecycleApplyReadinessInFlight = false;
      if (supervisorLifecycleApplyReadinessButton) supervisorLifecycleApplyReadinessButton.disabled = false;
    }
  }

  async function fetchSupervisorLifecycleExecutorReadiness() {
    if (!supervisorLifecycleApprovalPreviewResultEl || supervisorLifecycleExecutorReadinessInFlight) return;

    const parsed = parseSupervisorLifecycleApplyReadinessPayload();
    if (!parsed.ok) {
      setSupervisorLifecycleExecutorReadinessError(parsed.error);
      return;
    }

    supervisorLifecycleExecutorReadinessInFlight = true;
    if (supervisorLifecycleExecutorReadinessButton) supervisorLifecycleExecutorReadinessButton.disabled = true;
    clearElement(supervisorLifecycleApprovalPreviewResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '检查 executor readiness 中...';
    supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-lifecycle-executor-readiness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.payload),
      });
      let body;
      try {
        body = await res.json();
      } catch (_) {
        body = {};
      }
      if (!res.ok) {
        throw new Error(body.error || 'HTTP ' + res.status);
      }
      renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleExecutorReadinessViewModel(body));
      logEvent('Supervisor lifecycle executor readiness preflight completed', 'warning');
    } catch (err) {
      setSupervisorLifecycleExecutorReadinessError(err.message);
      logEvent('Supervisor lifecycle executor readiness failed: ' + sanitizeSupervisorInstallErrorMessage(err.message), 'error');
    } finally {
      supervisorLifecycleExecutorReadinessInFlight = false;
      if (supervisorLifecycleExecutorReadinessButton) supervisorLifecycleExecutorReadinessButton.disabled = false;
    }
  }

  function parseSupervisorLifecycleExecutorManifestReadinessPayload() {
    const configRaw = supervisorLifecycleApprovalPreviewConfigInput ? supervisorLifecycleApprovalPreviewConfigInput.value : '';
    if (!String(configRaw || '').trim()) {
      return { ok: false, error: '配置 JSON 不能为空' };
    }

    let config;
    try {
      config = JSON.parse(configRaw);
    } catch (err) {
      return { ok: false, error: '配置 JSON 格式错误' };
    }

    const manifestRaw = supervisorLifecycleExecutorManifestReadinessManifestInput ? supervisorLifecycleExecutorManifestReadinessManifestInput.value : '';
    if (!String(manifestRaw || '').trim()) {
      return { ok: false, error: '执行器 Manifest JSON 不能为空' };
    }

    let manifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch (err) {
      return { ok: false, error: '执行器 Manifest JSON 格式错误' };
    }

    return {
      ok: true,
      payload: {
        operation: supervisorLifecycleApprovalPreviewOperationInput?.value || 'install',
        config,
        manifest,
      },
    };
  }

  async function fetchSupervisorLifecycleExecutorManifestReadiness() {
    if (!supervisorLifecycleApprovalPreviewResultEl || supervisorLifecycleExecutorManifestReadinessInFlight) return;

    const parsed = parseSupervisorLifecycleExecutorManifestReadinessPayload();
    if (!parsed.ok) {
      setSupervisorLifecycleExecutorManifestReadinessError(parsed.error);
      return;
    }

    supervisorLifecycleExecutorManifestReadinessInFlight = true;
    if (supervisorLifecycleExecutorManifestReadinessButton) supervisorLifecycleExecutorManifestReadinessButton.disabled = true;
    clearElement(supervisorLifecycleApprovalPreviewResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '检查 executor manifest readiness 中...';
    supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-lifecycle-executor-manifest-readiness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.payload),
      });
      let body;
      try {
        body = await res.json();
      } catch (_) {
        body = {};
      }
      if (!res.ok) {
        throw new Error(body.error || 'HTTP ' + res.status);
      }
      renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleExecutorManifestReadinessViewModel(body));
      logEvent('Supervisor lifecycle executor manifest readiness preflight completed', 'warning');
    } catch (err) {
      setSupervisorLifecycleExecutorManifestReadinessError(err.message);
      logEvent('Supervisor lifecycle executor manifest readiness failed: ' + sanitizeSupervisorInstallErrorMessage(err.message), 'error');
    } finally {
      supervisorLifecycleExecutorManifestReadinessInFlight = false;
      if (supervisorLifecycleExecutorManifestReadinessButton) supervisorLifecycleExecutorManifestReadinessButton.disabled = false;
    }
  }

  function setSupervisorLifecycleExecutorManifestReadinessError(message) {
    const viewModel = buildSupervisorLifecycleExecutorManifestReadinessViewModel(null, message);
    renderSupervisorLifecycleApprovalPreview(viewModel);
  }

  function parseSupervisorLifecycleGuardedRunnerReadinessPayload() {
    const parsed = parseSupervisorLifecycleExecutorManifestReadinessPayload();
    if (!parsed.ok) return parsed;

    const runnerBindingRaw = supervisorLifecycleGuardedRunnerReadinessRunnerBindingInput
      ? supervisorLifecycleGuardedRunnerReadinessRunnerBindingInput.value
      : '';
    if (!String(runnerBindingRaw || '').trim()) {
      return { ok: false, error: 'Runner Binding JSON 不能为空' };
    }

    let runnerBinding;
    try {
      runnerBinding = JSON.parse(runnerBindingRaw);
    } catch (err) {
      return { ok: false, error: 'Runner Binding JSON 格式错误' };
    }

    return {
      ok: true,
      payload: {
        operation: parsed.payload.operation,
        config: parsed.payload.config,
        manifest: parsed.payload.manifest,
        runnerBinding,
      },
    };
  }

  function hasSupervisorLifecycleSharedResultRequestInFlight() {
    return (
      supervisorLifecycleApprovalPreviewInFlight ||
      supervisorLifecycleApprovalPersistInFlight ||
      supervisorLifecycleApprovalRecordsInFlight ||
      supervisorLifecycleApplyReadinessInFlight ||
      supervisorLifecycleExecutorReadinessInFlight ||
      supervisorLifecycleExecutorManifestReadinessInFlight ||
      supervisorLifecycleGuardedRunnerReadinessInFlight ||
      supervisorLifecycleGuardedRunnerExecutionPreviewInFlight ||
      supervisorLifecycleGuardedRunnerExecutionGateInFlight
    );
  }

  function setSupervisorLifecycleSharedResultButtonsDisabled(disabled) {
    [
      supervisorLifecycleApprovalPreviewRunButton,
      supervisorLifecycleApprovalPersistButton,
      supervisorLifecycleApprovalRecordsButton,
      supervisorLifecycleApplyReadinessButton,
      supervisorLifecycleExecutorReadinessButton,
      supervisorLifecycleExecutorManifestReadinessButton,
      supervisorLifecycleGuardedRunnerReadinessButton,
      supervisorLifecycleGuardedRunnerExecutionPreviewButton,
      supervisorLifecycleGuardedRunnerExecutionGateButton,
    ].forEach((button) => {
      if (button) button.disabled = Boolean(disabled);
    });
  }

  async function fetchSupervisorLifecycleGuardedRunnerReadiness() {
    if (!supervisorLifecycleApprovalPreviewResultEl || supervisorLifecycleGuardedRunnerReadinessInFlight) return;

    const parsed = parseSupervisorLifecycleGuardedRunnerReadinessPayload();
    if (!parsed.ok) {
      setSupervisorLifecycleGuardedRunnerReadinessError(parsed.error);
      return;
    }

    supervisorLifecycleGuardedRunnerReadinessInFlight = true;
    if (supervisorLifecycleGuardedRunnerReadinessButton) supervisorLifecycleGuardedRunnerReadinessButton.disabled = true;
    clearElement(supervisorLifecycleApprovalPreviewResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '检查 guarded runner readiness 中...';
    supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-lifecycle-guarded-runner-readiness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.payload),
      });
      let body;
      try {
        body = await res.json();
      } catch (_) {
        body = {};
      }
      if (!res.ok) {
        throw new Error(body.error || 'HTTP ' + res.status);
      }
      renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleGuardedRunnerReadinessViewModel(body));
      logEvent('Supervisor lifecycle guarded runner readiness preflight completed', 'warning');
    } catch (err) {
      setSupervisorLifecycleGuardedRunnerReadinessError(err.message);
      logEvent('Supervisor lifecycle guarded runner readiness failed: ' + sanitizeSupervisorLifecycleGuardedRunnerReadinessValue(err.message), 'error');
    } finally {
      supervisorLifecycleGuardedRunnerReadinessInFlight = false;
      if (supervisorLifecycleGuardedRunnerReadinessButton) supervisorLifecycleGuardedRunnerReadinessButton.disabled = false;
    }
  }

  async function fetchSupervisorLifecycleGuardedRunnerExecutionPreview() {
    if (!supervisorLifecycleApprovalPreviewResultEl || hasSupervisorLifecycleSharedResultRequestInFlight()) return;

    const parsed = parseSupervisorLifecycleGuardedRunnerReadinessPayload();
    if (!parsed.ok) {
      setSupervisorLifecycleGuardedRunnerExecutionPreviewError(parsed.error);
      return;
    }

    supervisorLifecycleGuardedRunnerExecutionPreviewInFlight = true;
    setSupervisorLifecycleSharedResultButtonsDisabled(true);
    clearElement(supervisorLifecycleApprovalPreviewResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '生成 guarded runner execution preview 中...';
    supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-lifecycle-guarded-runner-execution-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.payload),
      });
      let body;
      try {
        body = await res.json();
      } catch (_) {
        body = {};
      }
      if (!res.ok) {
        throw new Error(body.error || 'HTTP ' + res.status);
      }
      renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel(body));
      logEvent('Supervisor lifecycle guarded runner execution preview completed', 'warning');
    } catch (err) {
      setSupervisorLifecycleGuardedRunnerExecutionPreviewError(err.message);
      logEvent('Supervisor lifecycle guarded runner execution preview failed: ' + sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(err.message), 'error');
    } finally {
      supervisorLifecycleGuardedRunnerExecutionPreviewInFlight = false;
      setSupervisorLifecycleSharedResultButtonsDisabled(false);
    }
  }

  async function fetchSupervisorLifecycleGuardedRunnerExecutionGate() {
    if (!supervisorLifecycleApprovalPreviewResultEl || hasSupervisorLifecycleSharedResultRequestInFlight()) return;

    const parsed = parseSupervisorLifecycleGuardedRunnerReadinessPayload();
    if (!parsed.ok) {
      setSupervisorLifecycleGuardedRunnerExecutionGateError(parsed.error);
      return;
    }

    supervisorLifecycleGuardedRunnerExecutionGateInFlight = true;
    setSupervisorLifecycleSharedResultButtonsDisabled(true);
    clearElement(supervisorLifecycleApprovalPreviewResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '检查 guarded runner execution gate 中...';
    supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-lifecycle-guarded-runner-execution-gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: parsed.payload.operation,
          config: parsed.payload.config,
          manifest: parsed.payload.manifest,
          runnerBinding: parsed.payload.runnerBinding,
          executeRequested: true,
        }),
      });
      let body;
      try {
        body = await res.json();
      } catch (_) {
        body = {};
      }
      if (!res.ok) {
        throw new Error(body.error || 'HTTP ' + res.status);
      }
      renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(body));
      logEvent('Supervisor lifecycle guarded runner execution gate completed', 'warning');
    } catch (err) {
      setSupervisorLifecycleGuardedRunnerExecutionGateError(err.message);
      logEvent('Supervisor lifecycle guarded runner execution gate failed: ' + sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(err.message), 'error');
    } finally {
      supervisorLifecycleGuardedRunnerExecutionGateInFlight = false;
      setSupervisorLifecycleSharedResultButtonsDisabled(false);
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
      const res = await apiFetch(
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
      const res = await apiFetch(
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

  renderSupervisorInstallDryRun(buildSupervisorInstallDryRunViewModel(null));

  if (supervisorInstallDryRunRunButton?.addEventListener) {
    supervisorInstallDryRunRunButton.addEventListener('click', fetchSupervisorInstallDryRunPlan);
  }

  renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleApprovalPersistencePreviewViewModel(null));

  if (supervisorLifecycleApprovalPreviewRunButton?.addEventListener) {
    supervisorLifecycleApprovalPreviewRunButton.addEventListener('click', fetchSupervisorLifecycleApprovalPreview);
  }

  if (supervisorLifecycleApprovalPersistButton?.addEventListener) {
    supervisorLifecycleApprovalPersistButton.addEventListener('click', persistSupervisorLifecycleApprovalRecord);
  }
  if (supervisorLifecycleApprovalRecordsButton?.addEventListener) {
    supervisorLifecycleApprovalRecordsButton.addEventListener('click', fetchSupervisorLifecycleApprovalRecords);
  }
  if (supervisorLifecycleApplyReadinessButton?.addEventListener) {
    supervisorLifecycleApplyReadinessButton.addEventListener('click', fetchSupervisorLifecycleApplyReadiness);
  }
  if (supervisorLifecycleExecutorReadinessButton?.addEventListener) {
    supervisorLifecycleExecutorReadinessButton.addEventListener('click', fetchSupervisorLifecycleExecutorReadiness);
  }
  if (supervisorLifecycleExecutorManifestReadinessButton?.addEventListener) {
    supervisorLifecycleExecutorManifestReadinessButton.addEventListener('click', fetchSupervisorLifecycleExecutorManifestReadiness);
  }
  if (supervisorLifecycleGuardedRunnerReadinessButton?.addEventListener) {
    supervisorLifecycleGuardedRunnerReadinessButton.addEventListener('click', fetchSupervisorLifecycleGuardedRunnerReadiness);
  }
  if (supervisorLifecycleGuardedRunnerExecutionPreviewButton?.addEventListener) {
    supervisorLifecycleGuardedRunnerExecutionPreviewButton.addEventListener('click', fetchSupervisorLifecycleGuardedRunnerExecutionPreview);
  }
  if (supervisorLifecycleGuardedRunnerExecutionGateButton?.addEventListener) {
    supervisorLifecycleGuardedRunnerExecutionGateButton.addEventListener('click', fetchSupervisorLifecycleGuardedRunnerExecutionGate);
  }

  for (const control of [deviceSearchInput, deviceStatusFilter, deviceManagementFilter, deviceSortSelect]) {
    if (control?.addEventListener) {
      control.addEventListener('input', renderFilteredDevices);
      control.addEventListener('change', renderFilteredDevices);
    }
  }

  if (deviceFilterResetButton?.addEventListener) {
    deviceFilterResetButton.addEventListener('click', function () {
      if (deviceSearchInput) deviceSearchInput.value = '';
      if (deviceStatusFilter) deviceStatusFilter.value = 'all';
      if (deviceManagementFilter) deviceManagementFilter.value = 'all';
      if (deviceSortSelect) deviceSortSelect.value = 'name';
      renderFilteredDevices();
    });
  }

  function bindBucketClick(summaryEl, filterValue) {
    if (summaryEl && summaryEl.addEventListener) {
      summaryEl.addEventListener('click', () => {
        if (deviceManagementFilter) {
          deviceManagementFilter.value = filterValue;
          if (typeof Event !== 'undefined') {
            try {
              deviceManagementFilter.dispatchEvent(new Event('change', { bubbles: true }));
              deviceManagementFilter.dispatchEvent(new Event('input', { bubbles: true }));
            } catch (e) {}
          }
          renderFilteredDevices();
        }
      });
    }
  }

  bindBucketClick(summaryAll, 'all');
  bindBucketClick(summaryVisible, 'visible');
  bindBucketClick(summaryMissingIp, 'missing-ip');
  bindBucketClick(summaryOfflineRetained, 'offline-retained');
  bindBucketClick(summaryUnknown, 'unknown');

  for (const control of [versionConsistencySearchInput, versionConsistencyStatusFilter, versionConsistencySortSelect, versionConsistencyCoverageFilter]) {
    if (control?.addEventListener) {
      control.addEventListener('input', renderFilteredVersionConsistency);
      control.addEventListener('change', renderFilteredVersionConsistency);
    }
  }

  let releaseHealthInFlight = false;
  let releaseReadinessInFlight = false;
  let goldReadinessInFlight = false;
  let hardeningStatusInFlight = false;
  let supervisorStatusInFlight = false;
  let auditLogInFlight = false;
  let supervisorInstallDryRunInFlight = false;
  let supervisorLifecycleApprovalPreviewInFlight = false;
  let supervisorLifecycleApprovalPersistInFlight = false;
  let supervisorLifecycleApprovalRecordsInFlight = false;
  let supervisorLifecycleApplyReadinessInFlight = false;
  let supervisorLifecycleExecutorReadinessInFlight = false;
  let supervisorLifecycleExecutorManifestReadinessInFlight = false;
  let supervisorLifecycleGuardedRunnerReadinessInFlight = false;
  let supervisorLifecycleGuardedRunnerExecutionPreviewInFlight = false;
  let supervisorLifecycleGuardedRunnerExecutionGateInFlight = false;

  function renderReleaseHealth(viewModel) {
    const state = viewModel || buildReleaseHealthViewModel(null);
    if (releaseHealthPanelEl?.setAttribute) {
      releaseHealthPanelEl.setAttribute('data-status', state.statusKey);
    }
    if (releaseHealthStatusEl) releaseHealthStatusEl.textContent = state.statusText;
    if (releaseHealthVersionEl) releaseHealthVersionEl.textContent = state.versionText;
    if (releaseHealthDataDirEl) releaseHealthDataDirEl.textContent = state.dataDirText;
    if (releaseHealthTimestampEl) releaseHealthTimestampEl.textContent = state.timestampText;
    if (releaseHealthMessageEl) releaseHealthMessageEl.textContent = state.messageText;
  }

  function setReleaseHealthRefreshBusy(busy) {
    if (!releaseHealthRefreshButton) return;
    releaseHealthRefreshButton.disabled = Boolean(busy);
    if (releaseHealthRefreshButton.setAttribute) {
      releaseHealthRefreshButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
    }
  }

  async function fetchReleaseHealth() {
    if (releaseHealthInFlight) return;
    releaseHealthInFlight = true;
    setReleaseHealthRefreshBusy(true);
    try {
      const res = await apiFetch('/api/health');
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const body = await res.json();
          if (body && body.message) {
            msg += ': ' + body.message;
          } else if (body && body.error) {
            msg += ': ' + body.error;
          }
        } catch (e) {}
        if (!msg.includes('错误')) {
          msg += ' 错误';
        }
        throw new Error(msg);
      }
      const payload = await res.json();
      renderReleaseHealth(buildReleaseHealthViewModel(payload));
      logEvent('已刷新发布健康检查', 'info');
    } catch (err) {
      renderReleaseHealth(buildReleaseHealthViewModel(null, err.message));
      logEvent('发布健康检查失败: ' + err.message, 'error');
    } finally {
      releaseHealthInFlight = false;
      setReleaseHealthRefreshBusy(false);
    }
  }

  function renderReleaseReadinessCheckList(checks) {
    clearElement(releaseReadinessChecklistEl);
    if (!releaseReadinessChecklistEl) return;

    const safeChecks = Array.isArray(checks) ? checks : [];
    if (safeChecks.length === 0) {
      const item = doc.createElement('li');
      item.className = 'placeholder';
      item.textContent = '尚未检查';
      if (typeof releaseReadinessChecklistEl.appendChild === 'function') {
        releaseReadinessChecklistEl.appendChild(item);
      }
      return;
    }

    safeChecks.forEach(function (check) {
      const item = doc.createElement('li');
      item.className = 'release-readiness-check ' + (check.ok ? 'is-ready' : 'is-blocked');
      item.setAttribute('data-testid', 'release-readiness-check');
      item.setAttribute('data-check-id', check.id);
      item.setAttribute('data-ok', check.ok ? 'true' : 'false');
      item.textContent = check.id + ': ' + (check.ok ? '通过' : '未通过')
        + ' (expected ' + check.expected + ', actual ' + check.actual + ')';
      if (typeof releaseReadinessChecklistEl.appendChild === 'function') {
        releaseReadinessChecklistEl.appendChild(item);
      }
    });
  }

  function renderReleaseReadiness(viewModel) {
    const state = viewModel || buildReleaseReadinessViewModel(null);
    if (releaseReadinessPanelEl?.setAttribute) {
      releaseReadinessPanelEl.setAttribute('data-status', state.statusKey);
    }
    if (releaseReadinessStatusEl) releaseReadinessStatusEl.textContent = state.statusText;
    if (releaseReadinessExpectedVersionEl) releaseReadinessExpectedVersionEl.textContent = state.expectedVersionText;
    if (releaseReadinessActualVersionEl) releaseReadinessActualVersionEl.textContent = state.actualVersionText;
    if (releaseReadinessFailedCountEl) releaseReadinessFailedCountEl.textContent = state.failedCountText;
    if (releaseReadinessTimestampEl) releaseReadinessTimestampEl.textContent = state.timestampText;
    if (releaseReadinessMessageEl) releaseReadinessMessageEl.textContent = state.messageText;
    renderReleaseReadinessCheckList(state.checks);
  }

  function setReleaseReadinessRefreshBusy(busy) {
    if (!releaseReadinessRefreshButton) return;
    releaseReadinessRefreshButton.disabled = Boolean(busy);
    if (releaseReadinessRefreshButton.setAttribute) {
      releaseReadinessRefreshButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
    }
  }

  async function fetchReleaseReadiness() {
    if (releaseReadinessInFlight) return;
    releaseReadinessInFlight = true;
    setReleaseReadinessRefreshBusy(true);
    try {
      const res = await apiFetch('/api/release-readiness');
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const body = await res.json();
          if (body && body.message) {
            msg += ': ' + body.message;
          } else if (body && body.error) {
            msg += ': ' + body.error;
          }
        } catch (e) {}
        throw new Error(msg);
      }
      const payload = await res.json();
      renderReleaseReadiness(buildReleaseReadinessViewModel(payload));
      logEvent('已刷新发布就绪检查', 'info');
    } catch (err) {
      renderReleaseReadiness(buildReleaseReadinessViewModel(null, err.message));
      logEvent('发布就绪检查失败: ' + err.message, 'error');
    } finally {
      releaseReadinessInFlight = false;
      setReleaseReadinessRefreshBusy(false);
    }
  }

  function renderGoldReadinessList(items) {
    clearElement(goldReadinessListEl);
    if (!goldReadinessListEl) return;

    const safeItems = Array.isArray(items) ? items : [];
    if (safeItems.length === 0) {
      const item = doc.createElement('li');
      item.className = 'placeholder';
      item.textContent = '尚未检查';
      if (typeof goldReadinessListEl.appendChild === 'function') {
        goldReadinessListEl.appendChild(item);
      }
      return;
    }

    safeItems.forEach(function (entry) {
      const item = doc.createElement('li');
      item.className = 'gold-readiness-item gold-readiness-item--' + entry.status;
      item.setAttribute('data-testid', 'gold-readiness-item');
      item.setAttribute('data-status', entry.status);
      item.setAttribute('data-item-id', entry.id);
      item.textContent = entry.id + ' · ' + entry.statusText + ' · ' + entry.label
        + ' · evidence: ' + entry.evidenceText
        + ' · next: ' + entry.nextStep;
      if (typeof goldReadinessListEl.appendChild === 'function') {
        goldReadinessListEl.appendChild(item);
      }
    });
  }

  function renderGoldReadiness(viewModel) {
    const state = viewModel || buildGoldReadinessViewModel(null);
    if (goldReadinessPanelEl?.setAttribute) {
      goldReadinessPanelEl.setAttribute('data-status', state.statusKey);
    }
    if (goldReadinessStatusEl) goldReadinessStatusEl.textContent = state.statusText;
    if (goldReadinessReadyCountEl) goldReadinessReadyCountEl.textContent = state.readyCountText;
    if (goldReadinessPartialCountEl) goldReadinessPartialCountEl.textContent = state.partialCountText;
    if (goldReadinessBlockedCountEl) goldReadinessBlockedCountEl.textContent = state.blockedCountText;
    if (goldReadinessTotalCountEl) goldReadinessTotalCountEl.textContent = state.totalCountText;
    if (goldReadinessGeneratedAtEl) goldReadinessGeneratedAtEl.textContent = state.generatedAtText;
    if (goldReadinessMessageEl) goldReadinessMessageEl.textContent = state.messageText;
    renderGoldReadinessList(state.items);
  }

  function setGoldReadinessRefreshBusy(busy) {
    if (!goldReadinessRefreshButton) return;
    goldReadinessRefreshButton.disabled = Boolean(busy);
    if (goldReadinessRefreshButton.setAttribute) {
      goldReadinessRefreshButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
    }
  }

  async function fetchGoldReadiness() {
    if (goldReadinessInFlight) return;
    goldReadinessInFlight = true;
    setGoldReadinessRefreshBusy(true);
    try {
      const res = await apiFetch('/api/gold-readiness');
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const body = await res.json();
          if (body && body.message) {
            msg += ': ' + body.message;
          } else if (body && body.error) {
            msg += ': ' + body.error;
          }
        } catch (e) {}
        throw new Error(msg);
      }
      const payload = await res.json();
      renderGoldReadiness(buildGoldReadinessViewModel(payload));
      logEvent('已刷新 Gold 就绪评分卡', 'info');
    } catch (err) {
      renderGoldReadiness(buildGoldReadinessViewModel(null, err.message));
      logEvent('Gold 就绪评分卡检查失败: ' + err.message, 'error');
    } finally {
      goldReadinessInFlight = false;
      setGoldReadinessRefreshBusy(false);
    }
  }

  function renderHardeningStatus(viewModel) {
    const state = viewModel || buildHardeningStatusViewModel(null);
    if (hardeningStatusPanelEl?.setAttribute) {
      hardeningStatusPanelEl.setAttribute('data-status', state.statusKey);
    }
    if (hardeningStatusAuthEl) hardeningStatusAuthEl.textContent = state.authText;
    if (hardeningStatusScopedTokensEl) hardeningStatusScopedTokensEl.textContent = state.scopedTokensText;
    if (hardeningStatusRateLimitEl) hardeningStatusRateLimitEl.textContent = state.rateLimitText;
    if (hardeningStatusAuditRetentionEl) hardeningStatusAuditRetentionEl.textContent = state.auditRetentionText;
    if (hardeningStatusRestoreRootEl) hardeningStatusRestoreRootEl.textContent = state.restoreRootText;
    if (hardeningStatusRequestLimitEl) hardeningStatusRequestLimitEl.textContent = state.requestLimitText;
    if (hardeningStatusWriteRoutesEl) hardeningStatusWriteRoutesEl.textContent = state.writeRoutesText;
    if (hardeningStatusMessageEl) hardeningStatusMessageEl.textContent = state.messageText;
  }

  function setHardeningStatusRefreshBusy(busy) {
    if (!hardeningStatusRefreshButton) return;
    hardeningStatusRefreshButton.disabled = Boolean(busy);
    if (hardeningStatusRefreshButton.setAttribute) {
      hardeningStatusRefreshButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
    }
  }

  async function fetchHardeningStatus() {
    if (hardeningStatusInFlight) return;
    hardeningStatusInFlight = true;
    setHardeningStatusRefreshBusy(true);
    try {
      const res = await apiFetch('/api/hardening-status');
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const body = await res.json();
          if (body && body.message) {
            msg += ': ' + body.message;
          } else if (body && body.error) {
            msg += ': ' + body.error;
          }
        } catch (e) {}
        throw new Error(msg);
      }
      const payload = await res.json();
      renderHardeningStatus(buildHardeningStatusViewModel(payload));
      logEvent('已刷新硬化状态', 'info');
    } catch (err) {
      const safeErrorMessage = formatHardeningErrorMessage(err.message);
      renderHardeningStatus(buildHardeningStatusViewModel(null, safeErrorMessage));
      logEvent('硬化状态检查失败: ' + safeErrorMessage, 'error');
    } finally {
      hardeningStatusInFlight = false;
      setHardeningStatusRefreshBusy(false);
    }
  }

  function renderSupervisorStatus(viewModel) {
    const state = viewModel || buildSupervisorStatusViewModel(null);
    if (supervisorStatusPanelEl?.setAttribute) {
      supervisorStatusPanelEl.setAttribute('data-status', state.statusKey);
    }
    if (supervisorStatusStateEl) supervisorStatusStateEl.textContent = state.stateText;
    if (supervisorStatusInstalledEl) supervisorStatusInstalledEl.textContent = state.installedText;
    if (supervisorStatusManagedEl) supervisorStatusManagedEl.textContent = state.managedText;
    if (supervisorStatusLaunchdEl) supervisorStatusLaunchdEl.textContent = state.launchdText;
    if (supervisorStatusWatchdogEl) supervisorStatusWatchdogEl.textContent = state.watchdogText;
    if (supervisorStatusMonitoringEl) supervisorStatusMonitoringEl.textContent = state.monitoringText;
    if (supervisorStatusRecoveryEl) supervisorStatusRecoveryEl.textContent = state.recoveryText;
    if (supervisorStatusSafetyEl) supervisorStatusSafetyEl.textContent = state.safetyText;
    if (supervisorStatusMessageEl) supervisorStatusMessageEl.textContent = state.messageText;
  }

  function setSupervisorStatusRefreshBusy(busy) {
    if (!supervisorStatusRefreshButton) return;
    supervisorStatusRefreshButton.disabled = Boolean(busy);
    if (supervisorStatusRefreshButton.setAttribute) {
      supervisorStatusRefreshButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
    }
  }

  async function fetchSupervisorStatus() {
    if (supervisorStatusInFlight) return;
    supervisorStatusInFlight = true;
    setSupervisorStatusRefreshBusy(true);
    try {
      const res = await apiFetch('/api/supervisor-status');
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const body = await res.json();
          if (body && body.message) {
            msg += ': ' + body.message;
          } else if (body && body.error) {
            msg += ': ' + body.error;
          }
        } catch (e) {}
        throw new Error(msg);
      }
      const payload = await res.json();
      renderSupervisorStatus(buildSupervisorStatusViewModel(payload));
      logEvent('已刷新 Supervisor 状态', 'info');
    } catch (err) {
      const safeErrorMessage = formatHardeningErrorMessage(err.message);
      renderSupervisorStatus(buildSupervisorStatusViewModel(null, safeErrorMessage));
      logEvent('Supervisor 状态检查失败: ' + safeErrorMessage, 'error');
    } finally {
      supervisorStatusInFlight = false;
      setSupervisorStatusRefreshBusy(false);
    }
  }

  function renderAuditLogList(events) {
    clearElement(auditLogListEl);
    if (!auditLogListEl) return;

    const safeEvents = Array.isArray(events) ? events : [];
    if (safeEvents.length === 0) {
      const item = doc.createElement('li');
      item.className = 'placeholder';
      item.textContent = '尚未加载审计事件';
      if (typeof auditLogListEl.appendChild === 'function') {
        auditLogListEl.appendChild(item);
      }
      return;
    }

    safeEvents.forEach(function (event) {
      const item = doc.createElement('li');
      item.className = 'audit-log-item';
      item.setAttribute('data-testid', 'audit-log-item');
      item.setAttribute('data-event-type', event.type);
      item.textContent = event.summaryText;
      if (typeof auditLogListEl.appendChild === 'function') {
        auditLogListEl.appendChild(item);
      }
    });
  }

  function renderAuditLog(viewModel) {
    const state = viewModel || buildAuditLogViewModel(null);
    if (auditLogPanelEl?.setAttribute) {
      auditLogPanelEl.setAttribute('data-status', state.statusKey);
    }
    if (auditLogStatusEl) auditLogStatusEl.textContent = state.statusText;
    if (auditLogCountEl) auditLogCountEl.textContent = state.eventCountText;
    if (auditLogLatestTypeEl) auditLogLatestTypeEl.textContent = state.latestTypeText;
    if (auditLogLatestDeviceEl) auditLogLatestDeviceEl.textContent = state.latestDeviceText;
    if (auditLogMessageEl) auditLogMessageEl.textContent = state.messageText;
    renderAuditLogList(state.events);
  }

  function setAuditLogRefreshBusy(busy) {
    if (!auditLogRefreshButton) return;
    auditLogRefreshButton.disabled = Boolean(busy);
    if (auditLogRefreshButton.setAttribute) {
      auditLogRefreshButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
    }
  }

  async function fetchAuditLog() {
    if (auditLogInFlight) return;
    auditLogInFlight = true;
    setAuditLogRefreshBusy(true);
    try {
      const res = await apiFetch('/api/audit-log?limit=20');
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const body = await res.json();
          if (body && body.message) {
            msg += ': ' + body.message;
          } else if (body && body.error) {
            msg += ': ' + body.error;
          }
        } catch (e) {}
        throw new Error(msg);
      }
      const payload = await res.json();
      renderAuditLog(buildAuditLogViewModel(payload));
      logEvent('已刷新审计日志', 'info');
    } catch (err) {
      const safeErrorMessage = formatHardeningErrorMessage(err.message);
      renderAuditLog(buildAuditLogViewModel(null, safeErrorMessage));
      logEvent('审计日志加载失败: ' + safeErrorMessage, 'error');
    } finally {
      auditLogInFlight = false;
      setAuditLogRefreshBusy(false);
    }
  }

  if (apiTokenApplyButton?.addEventListener) {
    apiTokenApplyButton.addEventListener('click', () => {
      const token = apiTokenInput ? apiTokenInput.value : '';
      if (!String(token || '').trim()) {
        clearApiToken('Token 为空');
        return;
      }
      setApiToken(token);
    });
  }

  if (apiTokenClearButton?.addEventListener) {
    apiTokenClearButton.addEventListener('click', () => {
      clearApiToken('已清除');
    });
  }

  renderApiTokenStatus('未设置', 'unset');
  renderReleaseHealth(buildReleaseHealthViewModel(null));
  renderReleaseReadiness(buildReleaseReadinessViewModel(null));
  renderGoldReadiness(buildGoldReadinessViewModel(null));
  renderHardeningStatus(buildHardeningStatusViewModel(null));
  renderSupervisorStatus(buildSupervisorStatusViewModel(null));
  renderAuditLog(buildAuditLogViewModel(null));

  if (releaseHealthRefreshButton?.addEventListener) {
    releaseHealthRefreshButton.addEventListener('click', fetchReleaseHealth);
  }
  if (releaseReadinessRefreshButton?.addEventListener) {
    releaseReadinessRefreshButton.addEventListener('click', fetchReleaseReadiness);
  }
  if (goldReadinessRefreshButton?.addEventListener) {
    goldReadinessRefreshButton.addEventListener('click', fetchGoldReadiness);
  }
  if (hardeningStatusRefreshButton?.addEventListener) {
    hardeningStatusRefreshButton.addEventListener('click', fetchHardeningStatus);
  }
  if (supervisorStatusRefreshButton?.addEventListener) {
    supervisorStatusRefreshButton.addEventListener('click', fetchSupervisorStatus);
  }
  if (auditLogRefreshButton?.addEventListener) {
    auditLogRefreshButton.addEventListener('click', fetchAuditLog);
  }

  logEvent('Linke 控制台已启动', 'info');
  fetchDevices();
  intervalImpl(fetchDevices, 10000);
}

// ── Auto-init in browser ──────────────────────────────────────────

if (typeof globalThis.document !== 'undefined') {
  initConsole(document, fetch, setInterval);
}
