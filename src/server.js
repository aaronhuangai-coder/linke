import { createServer as createHttpServer } from 'node:http';
import { constants, realpathSync, statSync } from 'node:fs';
import { readFile, access, realpath } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  recordHeartbeat,
  listDevices,
  getDevice,
  createBackup,
  listSnapshots,
  getSnapshotManifest,
  restoreSnapshot,
  slugify,
} from './storage.js';
import { buildRetentionDryRunPlan } from './retention.js';
import { buildSnapshotDiffDryRunPlan } from './snapshot-diff.js';
import { buildRestoreDryRunPlan, collectExistingTargetPaths } from './restore-dry-run.js';
import { runBackupPreflightDryRun } from './backup-preflight.js';
import { buildNasDryRunPlan } from './nas.js';
import { validateConfig } from './config.js';
import { buildSupervisorInstallDryRunPlan } from './agent.js';
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleApplyReadiness,
  buildSupervisorLifecycleApprovalPersistencePreview,
  buildSupervisorLifecycleExecutorReadiness,
  buildSupervisorLifecycleGuardedRunnerExecutionGate,
  buildSupervisorLifecycleGuardedRunnerExecutionPreview,
  buildSupervisorLifecycleGuardedRunnerReadiness,
  validateSupervisorLifecycleExecutorManifest,
} from './supervisor-lifecycle.js';
import {
  appendSupervisorLifecycleApprovalRecord,
  isPersistablePreview,
  readSupervisorLifecycleApprovalRecords,
} from './approval-store.js';
import { LINKE_RELEASE_VERSION } from './version.js';
import { buildReleaseReadinessReport } from './release-readiness.js';
import { buildGoldReadinessReport } from './gold-readiness.js';
import { appendAuditEvent, parseAuditRetentionMaxEvents, readAuditEvents } from './audit-log.js';
import { createFixedWindowRateLimiter, parseRateLimitPerMinute } from './rate-limit.js';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { DEVICE_PROTOCOL_VERSION } from './device-protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export const MAX_JSON_BODY_BYTES = 1024 * 1024;
const RESTORE_ROOT_ERROR = 'targetPath is outside the allowed restore root';
const SUPERVISOR_LIFECYCLE_APPROVAL_RECORDS_READ_ERROR = 'failed to read supervisor lifecycle approval records';
const SUPERVISOR_LIFECYCLE_EXECUTOR_MANIFEST_READINESS_CONFIG_ERROR = 'supervisor-lifecycle-executor-manifest-readiness failed; verify config is a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_EXECUTOR_MANIFEST_READINESS_VALIDATION_ERROR = 'supervisor-lifecycle-executor-manifest-readiness failed; manifest validation did not complete';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_CONFIG_ERROR = 'supervisor-lifecycle-guarded-runner-readiness failed; verify config is a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_VALIDATION_ERROR = 'supervisor-lifecycle-guarded-runner-readiness failed; guarded runner readiness validation did not complete';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_CONFIG_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; verify config is a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_VALIDATION_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_CONFIG_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; verify config is a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_VALIDATION_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; execution gate validation did not complete';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_EXECUTE_REQUESTED_ERROR = 'executeRequested must be a boolean when provided';
// 新增写入接口必须注册在这里，测试会捕获 auth gate 与 auth-status 的漂移。
export const API_WRITE_ROUTES = [
  { method: 'POST', path: '/api/heartbeat' },
  { method: 'POST', path: '/api/backups' },
  { method: 'POST', path: '/api/restore' },
  { method: 'POST', path: '/api/supervisor-lifecycle-approval-persist' },
  { method: 'POST', path: '/api/device-enrollment-codes' },
  { method: 'POST', path: '/api/device-revoke' },
];

/** Task4 deviceId grammar: lowercase alnum, optional hyphens, max 63 chars. */
const DEVICE_ADMIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function formatApiRoute(route) {
  return `${String(route.method).toUpperCase()} ${route.path}`;
}

/**
 * G0c restore-tasks write paths (pattern match; not listed in frozen API_WRITE_ROUTES).
 * @param {string} method
 * @param {string} pathname
 * @returns {boolean}
 */
function isRestoreTasksWriteRoute(method, pathname) {
  if (method !== 'POST' || typeof pathname !== 'string') return false;
  if (/^\/api\/devices\/[^/]+\/restore-tasks$/.test(pathname)) return true;
  if (/^\/api\/devices\/[^/]+\/restore-tasks\/[^/]+\/cancel$/.test(pathname)) return true;
  return false;
}

/**
 * 判断请求是否命中注册表中的写入接口；空 method 按非写入请求处理。
 * G0c: restore-tasks create/cancel are write routes via pattern (API_WRITE_ROUTES stays length 6).
 */
export function isApiWriteRoute(method, pathname) {
  const normalizedMethod = String(method || '').toUpperCase();
  if (API_WRITE_ROUTES.some((route) => route.method === normalizedMethod && route.path === pathname)) {
    return true;
  }
  return isRestoreTasksWriteRoute(normalizedMethod, pathname);
}

/**
 * Resolve complete restoreService surface for management restore task routes.
 * Incomplete / hostile → null (no half-exposure).
 * @param {unknown} restoreService
 * @returns {object | null}
 */
function resolveManagementRestoreService(restoreService) {
  if (restoreService == null) return null;
  if (typeof restoreService !== 'object' || Array.isArray(restoreService)) return null;
  try {
    for (const method of ['createTask', 'getStatus', 'cancelTask']) {
      const fn = /** @type {Record<string, unknown>} */ (restoreService)[method];
      if (typeof fn !== 'function') return null;
    }
  } catch {
    return null;
  }
  return restoreService;
}

/**
 * Management create/status summary allowlist (design §8.1).
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function projectRestoreManagementSummary(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  // Real store returns { httpHint, taskSummary }; mocks may return summary directly.
  let source = value;
  try {
    const nested = /** @type {{ taskSummary?: unknown }} */ (value).taskSummary;
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      source = nested;
    }
  } catch {
    source = value;
  }
  const keys = [
    'taskId',
    'deviceId',
    'snapshotId',
    'manifestDigest',
    'relativeTarget',
    'status',
    'fileCount',
    'totalBytes',
    'createdAt',
    'updatedAt',
    'cancelRequested',
    'cleanupAuthorized',
  ];
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of keys) {
    let has = false;
    try {
      has = Object.prototype.hasOwnProperty.call(source, key);
    } catch {
      continue;
    }
    if (!has) continue;
    let raw;
    try {
      raw = /** @type {Record<string, unknown>} */ (source)[key];
    } catch {
      continue;
    }
    if (
      raw === null
      || typeof raw === 'string'
      || typeof raw === 'boolean'
      || (typeof raw === 'number' && Number.isFinite(raw))
    ) {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Cancel response allowlist (design §9.4).
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function projectRestoreCancelSummary(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const keys = ['taskId', 'status', 'cancelRequested'];
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of keys) {
    let has = false;
    try {
      has = Object.prototype.hasOwnProperty.call(value, key);
    } catch {
      continue;
    }
    if (!has) continue;
    let raw;
    try {
      raw = /** @type {Record<string, unknown>} */ (value)[key];
    } catch {
      continue;
    }
    if (
      raw === null
      || typeof raw === 'string'
      || typeof raw === 'boolean'
      || (typeof raw === 'number' && Number.isFinite(raw))
    ) {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Map management restore LinkeError / plain code errors to public {error} body.
 * @param {unknown} err
 * @returns {{ statusCode: number, code: string } | null}
 */
function mapRestoreManagementError(err) {
  if (err instanceof LinkeError) {
    const statusCode = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode <= 599
      ? err.statusCode
      : 500;
    return { statusCode, code: err.code };
  }
  if (err && typeof err === 'object') {
    const code = /** @type {{ code?: unknown }} */ (err).code;
    const statusCode = /** @type {{ statusCode?: unknown }} */ (err).statusCode;
    if (
      typeof code === 'string'
      && code.length > 0
      && Number.isInteger(statusCode)
      && /** @type {number} */ (statusCode) >= 400
      && /** @type {number} */ (statusCode) <= 599
    ) {
      return { statusCode: /** @type {number} */ (statusCode), code };
    }
  }
  return null;
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNoStoreJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

const DEVICE_ADMIN_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

function isDeviceAdministrationService(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.issueEnrollment === 'function'
    && typeof value.revokeDevice === 'function'
    && typeof value.getStatus === 'function',
  );
}

function isExactApiRoute(url, method, expectedMethod, expectedPath) {
  return method === expectedMethod && url.pathname === expectedPath && url.search === '';
}

function parseAdminDeviceId(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.deviceId !== 'string' || !DEVICE_ADMIN_ID_PATTERN.test(body.deviceId)) return null;
  return body.deviceId;
}

function isValidAdminAgentUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.search || parsed.hash) return false;
  return true;
}

function isValidAdminTlsFingerprint(value) {
  return typeof value === 'string' && DEVICE_ADMIN_FINGERPRINT_PATTERN.test(value);
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string' || !value) return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return date.toISOString() === value;
}

function isValidEnrollmentCode(value) {
  return typeof value === 'string' && value.length > 0;
}

function toStrictBoolean(value) {
  return value === true;
}

function toNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Sanitize admin-route errors. LinkeError status codes outside 400-599 fail closed.
 * Body size/JSON failures map to registered device-request-invalid (status preserved).
 */
function sanitizeDeviceAdminError(err) {
  if (err instanceof LinkeError) {
    const statusCode = err.statusCode;
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
      return { statusCode, code: err.code };
    }
    return { statusCode: 500, code: ERROR_CODES.DEVICE_INTERNAL_ERROR };
  }
  if (err && err.message === 'Request body too large' && err.statusCode === 413) {
    return { statusCode: 413, code: ERROR_CODES.DEVICE_REQUEST_INVALID };
  }
  if (err && err.message === 'Invalid JSON body' && err.statusCode === 400) {
    return { statusCode: 400, code: ERROR_CODES.DEVICE_REQUEST_INVALID };
  }
  return { statusCode: 500, code: ERROR_CODES.DEVICE_INTERNAL_ERROR };
}

function createHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function recordAudit(dataDir, event, retention) {
  try {
    await appendAuditEvent(dataDir, event, { retention });
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

/**
 * Required pre-side-effect write-admission audit (fail-closed).
 * Exact-one append; any underlying failure remaps to AUDIT_DELIVERY_UNAVAILABLE.
 * Does not log raw err.message / path / token / stack / errno.
 */
async function recordRequiredWriteAdmissionAudit(dataDir, { method, path, requestId }, retention) {
  try {
    await appendAuditEvent(dataDir, {
      type: 'api.write.admission.started',
      method,
      path,
      outcome: 'started',
      requestId,
    }, { retention });
  } catch {
    throw new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE, {
      statusCode: 503,
      retryable: true,
    });
  }
}

function errorStatusCode(err) {
  return Number.isInteger(err.statusCode) ? err.statusCode : 500;
}

function auditDeviceId(deviceId) {
  return typeof deviceId === 'string' && deviceId.trim() ? slugify(deviceId) : undefined;
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function isPathInsideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function normalizeRestoreRoot(restoreRoot) {
  if (restoreRoot === undefined || restoreRoot === null || restoreRoot === '') return '';
  if (typeof restoreRoot !== 'string') throw new Error('restoreRoot must be a string');
  const trimmed = restoreRoot.trim();
  if (!trimmed) throw new Error('restoreRoot must be a non-empty string when provided');

  const resolved = resolve(trimmed);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error('restoreRoot must exist and be a directory');
  }
  if (!stats.isDirectory()) throw new Error('restoreRoot must exist and be a directory');
  return realpathSync(resolved);
}

async function realpathNearestExisting(candidate) {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = dirname(current);
      if (parent === current) throw createHttpError(400, RESTORE_ROOT_ERROR);
      current = parent;
    }
  }
}

export async function resolveRestoreTargetPath(targetPath, restoreRoot = '') {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw createHttpError(400, 'targetPath is required');
  }

  const normalizedRestoreRoot = normalizeRestoreRoot(restoreRoot);
  if (!normalizedRestoreRoot) return targetPath;

  const trimmedTargetPath = targetPath.trim();
  const resolvedTarget = isAbsolute(trimmedTargetPath)
    ? resolve(trimmedTargetPath)
    : resolve(normalizedRestoreRoot, trimmedTargetPath);

  if (!isPathInsideRoot(normalizedRestoreRoot, resolvedTarget)) {
    throw createHttpError(400, RESTORE_ROOT_ERROR);
  }

  const nearestExisting = await realpathNearestExisting(resolvedTarget);
  if (!isPathInsideRoot(normalizedRestoreRoot, nearestExisting)) {
    throw createHttpError(400, RESTORE_ROOT_ERROR);
  }

  return resolvedTarget;
}

function normalizeAuthToken(authToken) {
  if (authToken === undefined || authToken === null) return '';
  if (typeof authToken !== 'string') throw new Error('authToken must be a string');
  const token = authToken.trim();
  if (authToken.length > 0 && !token) {
    throw new Error('authToken must be a non-empty string when provided');
  }
  return token;
}

function normalizeReadToken(readToken) {
  if (readToken === undefined || readToken === null) return '';
  if (typeof readToken !== 'string') throw new Error('readToken must be a string');
  const token = readToken.trim();
  if (readToken.length > 0 && !token) {
    throw new Error('readToken must be a non-empty string when provided');
  }
  return token;
}

function normalizeWriteToken(writeToken) {
  if (writeToken === undefined || writeToken === null) return '';
  if (typeof writeToken !== 'string') throw new Error('writeToken must be a string');
  const token = writeToken.trim();
  if (writeToken.length > 0 && !token) {
    throw new Error('writeToken must be a non-empty string when provided');
  }
  return token;
}

function normalizeAdminToken(adminToken) {
  if (adminToken === undefined || adminToken === null) return '';
  if (typeof adminToken !== 'string') throw new Error('adminToken must be a string');
  const token = adminToken.trim();
  if (adminToken.length > 0 && !token) {
    throw new Error('adminToken must be a non-empty string when provided');
  }
  return token;
}

/**
 * 配置管理令牌后，需要 admin/full 权限的精确设备管理 POST 路由。
 * 不修改 API_WRITE_ROUTES。
 * 与 isExactApiRoute 保持相同的精确 URL 语义（路径匹配且无查询参数）。
 * @param {string} method
 * @param {URL} url
 * @returns {boolean}
 */
function isDeviceAdministrationApiRoute(method, url) {
  return isExactApiRoute(url, method, 'POST', '/api/device-enrollment-codes')
    || isExactApiRoute(url, method, 'POST', '/api/device-revoke');
}

function authTokensMatch(actualToken, expectedToken) {
  const actual = Buffer.from(actualToken);
  const expected = Buffer.from(expectedToken);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Fail closed: previous scoped tokens are overlap-only credentials.
 * They must never stand alone when the matching current token is absent
 * (hasAuth ignores previous*, so previous-only would open unauthenticated localhost).
 */
function assertPreviousScopedTokensRequireCurrent({
  readToken,
  previousReadToken,
  writeToken,
  previousWriteToken,
}) {
  if (previousReadToken && !readToken) {
    throw new Error('previousReadToken requires readToken');
  }
  if (previousWriteToken && !writeToken) {
    throw new Error('previousWriteToken requires writeToken');
  }
}

const MANAGEMENT_AUTH_SOURCE_DIRECT = 'direct';
const MANAGEMENT_AUTH_SOURCE_KEYCHAIN = 'keychain';

/**
 * Fail closed: managementAuthSource is an internal startup credential source selector.
 * undefined stays direct-compatible; only exact 'direct'/'keychain' are accepted.
 * Any other value (empty/blank, case or whitespace variants, null, unknown or
 * non-string) rejects with a fixed message that never echoes the illegal input.
 * @param {unknown} managementAuthSource
 * @returns {'direct'|'keychain'}
 */
function resolveManagementAuthSource(managementAuthSource) {
  if (managementAuthSource === undefined) {
    return MANAGEMENT_AUTH_SOURCE_DIRECT;
  }
  if (managementAuthSource === MANAGEMENT_AUTH_SOURCE_DIRECT
    || managementAuthSource === MANAGEMENT_AUTH_SOURCE_KEYCHAIN) {
    return managementAuthSource;
  }
  throw new Error('managementAuthSource must be exactly "direct" or "keychain"');
}

/**
 * Resolve the startup credential provenance mode from the startup source and the
 * normalized startup token snapshot: direct without any valid token reports 'none';
 * keychain without any valid token fails closed at construction/pure-response time.
 * The provenance is self-reported by the process and not attested; it is not an
 * authorization, security-auth or Gold/compliance signal.
 * @param {'direct'|'keychain'} source
 * @param {boolean} authConfigured
 * @returns {'none'|'direct'|'keychain'}
 */
function resolveStartupCredentialMode(source, authConfigured) {
  if (source === MANAGEMENT_AUTH_SOURCE_KEYCHAIN && !authConfigured) {
    throw new Error('managementAuthSource "keychain" requires at least one configured management token');
  }
  return authConfigured ? source : 'none';
}

/**
 * Fixed startup credential provenance shape for auth-status responses.
 * startupSnapshot:true / hotReload:false pin that the value is the startup snapshot
 * only; selfReported:true / attested:false pin that it is process self-report,
 * never a Gold/security attestation. No token, Keychain service/itemId, env value,
 * dataDir or Authorization/Bearer material is ever included.
 * @param {'none'|'direct'|'keychain'} mode
 */
function buildStartupCredentialSource(mode) {
  return {
    mode,
    startupSnapshot: true,
    hotReload: false,
    selfReported: true,
    attested: false,
  };
}

export function isAuthorizedRequest(req, authToken) {
  const expectedToken = normalizeAuthToken(authToken);
  if (!expectedToken) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return authTokensMatch(header.slice('Bearer '.length), expectedToken);
}

async function readBody(req) {
  const chunks = [];
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string' && Number(contentLength) > MAX_JSON_BODY_BYTES) {
    throw createHttpError(413, 'Request body too large');
  }

  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw createHttpError(413, 'Request body too large');
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf-8') || '{}';
  try {
    return JSON.parse(text);
  } catch {
    throw createHttpError(400, 'Invalid JSON body');
  }
}

async function serveStatic(res, filePath) {
  try {
    const content = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': content.length,
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

export function buildHealthResponse({ dataDirReadable, now = new Date() } = {}) {
  const readable = Boolean(dataDirReadable);
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  return {
    status: readable ? 'ok' : 'degraded',
    service: 'linke',
    version: LINKE_RELEASE_VERSION,
    checks: {
      http: 'ok',
      dataDirReadable: readable ? 'ok' : 'unavailable',
    },
    timestamp,
  };
}

export function buildAuthStatusResponse({
  authToken,
  readToken,
  previousReadToken,
  writeToken,
  previousWriteToken,
  adminToken,
  managementAuthSource,
} = {}) {
  const normAuth = normalizeAuthToken(authToken);
  const normRead = normalizeReadToken(readToken);
  const normPreviousRead = normalizeReadToken(previousReadToken);
  const normWrite = normalizeWriteToken(writeToken);
  const normPreviousWrite = normalizeWriteToken(previousWriteToken);
  const normAdmin = normalizeAdminToken(adminToken);
  assertPreviousScopedTokensRequireCurrent({
    readToken: normRead,
    previousReadToken: normPreviousRead,
    writeToken: normWrite,
    previousWriteToken: normPreviousWrite,
  });
  const enabled = Boolean(normAuth || normRead || normWrite || normAdmin);
  const startupCredentialMode = resolveStartupCredentialMode(
    resolveManagementAuthSource(managementAuthSource),
    enabled,
  );

  return {
    status: 'ok',
    service: 'linke',
    version: LINKE_RELEASE_VERSION,
    auth: {
      enabled,
      configuredScopes: {
        full: Boolean(normAuth),
        read: Boolean(normRead),
        write: Boolean(normWrite),
        admin: Boolean(normAdmin),
      },
      previousTokenOverlapConfigured: {
        read: Boolean(normPreviousRead),
        write: Boolean(normPreviousWrite),
      },
      writeRoutes: API_WRITE_ROUTES.map(formatApiRoute),
    },
    startupCredentialSource: buildStartupCredentialSource(startupCredentialMode),
    safety: {
      tokenValuesReturned: false,
      successAuditEvent: false,
    },
  };
}

export function buildSupervisorStatusResponse() {
  return {
    status: 'partial',
    service: 'linke',
    version: LINKE_RELEASE_VERSION,
    supervisor: {
      installed: false,
      managed: false,
      launchdConfigured: false,
      watchdogConfigured: false,
      monitoringConfigured: false,
      recoveryConfigured: false,
      state: 'not_configured',
    },
    safety: {
      launchctlCalled: false,
      processListRead: false,
      supervisorInstalled: false,
      metadataWritten: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
    },
  };
}

export function buildHardeningStatusResponse({
  authToken,
  readToken,
  writeToken,
  adminToken,
  restoreRoot,
  rateLimit,
  auditRetention,
} = {}) {
  const normAuth = normalizeAuthToken(authToken);
  const normRead = normalizeReadToken(readToken);
  const normWrite = normalizeWriteToken(writeToken);
  const normAdmin = normalizeAdminToken(adminToken);
  const authConfigured = Boolean(normAuth || normRead || normWrite || normAdmin);
  const auditRetentionConfigured = Boolean(Number.isInteger(auditRetention?.maxEvents) && auditRetention.maxEvents > 0);

  return {
    status: 'partial',
    service: 'linke',
    version: LINKE_RELEASE_VERSION,
    hardening: {
      authConfigured,
      configuredAuthScopes: {
        full: Boolean(normAuth),
        read: Boolean(normRead),
        write: Boolean(normWrite),
        admin: Boolean(normAdmin),
      },
      scopedTokensConfigured: Boolean(normRead || normWrite || normAdmin),
      rateLimitConfigured: Boolean(rateLimit),
      auditRetentionConfigured,
      restoreRootConfigured: Boolean(restoreRoot),
      requestBodyLimitBytes: MAX_JSON_BODY_BYTES,
      writeRoutes: API_WRITE_ROUTES.map(formatApiRoute),
    },
    safety: {
      tokenValuesReturned: false,
      restoreRootValueReturned: false,
      auditPathReturned: false,
      environmentValuesReturned: false,
      successAuditEvent: false,
    },
  };
}

function sanitizeApprovalRecordValidation(validation = {}) {
  const source = validation && typeof validation === 'object' ? validation : {};
  return {
    approvalValid: source.approvalValid === true,
    acknowledgementCount: Number.isInteger(source.acknowledgementCount) && source.acknowledgementCount >= 0
      ? source.acknowledgementCount
      : 0,
    windowWithinLimit: source.windowWithinLimit === true,
    operationMatchesPlan: source.operationMatchesPlan === true,
    configHashMatchesPlan: source.configHashMatchesPlan === true,
    planHashMatchesPlan: source.planHashMatchesPlan === true,
  };
}

function sanitizeApprovalRecord(record = {}) {
  const source = record && typeof record === 'object' ? record : {};
  const safety = source.safety && typeof source.safety === 'object' ? source.safety : {};
  return {
    command: 'supervisor-lifecycle-approval-record',
    schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : 1,
    id: typeof source.id === 'string' ? source.id : '',
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : '',
    operation: typeof source.operation === 'string' ? source.operation : 'unknown',
    state: typeof source.state === 'string' ? source.state : 'unknown',
    approvalValid: source.approvalValid === true,
    blockersResolved: Array.isArray(source.blockersResolved)
      ? source.blockersResolved.filter((blocker) => typeof blocker === 'string')
      : [],
    validation: sanitizeApprovalRecordValidation(source.validation),
    safety: {
      approvalPersisted: safety.approvalPersisted === true,
      filesystemWritten: safety.filesystemWritten === true,
      hostMutation: false,
      launchctlCalled: false,
      lifecycleApplied: false,
      sensitiveValuesReturned: false,
    },
  };
}

export function buildSupervisorLifecycleApprovalRecordsResponse(records = []) {
  const sanitizedRecords = Array.isArray(records)
    ? records.map((record) => sanitizeApprovalRecord(record))
    : [];
  return {
    command: 'supervisor-lifecycle-approval-records',
    state: 'ready',
    count: sanitizedRecords.length,
    records: sanitizedRecords,
    safety: {
      readOnly: true,
      approvalPersisted: false,
      filesystemWritten: false,
      hostMutation: false,
      launchctlCalled: false,
      lifecycleApplied: false,
      sensitiveValuesReturned: false,
    },
  };
}

async function isDataDirReadable(dataDir) {
  try {
    await access(dataDir, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function createServer({
  dataDir,
  backupHooks,
  authToken,
  readToken,
  previousReadToken,
  writeToken,
  previousWriteToken,
  adminToken,
  managementAuthSource,
  restoreRoot,
  rateLimit,
  auditRetention,
  deviceAdministration,
  restoreService,
} = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const expectedAuthToken = normalizeAuthToken(authToken);
  const expectedReadToken = normalizeReadToken(readToken);
  const expectedPreviousReadToken = normalizeReadToken(previousReadToken);
  const expectedWriteToken = normalizeWriteToken(writeToken);
  const expectedPreviousWriteToken = normalizeWriteToken(previousWriteToken);
  const expectedAdminToken = normalizeAdminToken(adminToken);
  assertPreviousScopedTokensRequireCurrent({
    readToken: expectedReadToken,
    previousReadToken: expectedPreviousReadToken,
    writeToken: expectedWriteToken,
    previousWriteToken: expectedPreviousWriteToken,
  });
  // Startup credential source snapshot: resolved once at construction together with
  // the normalized tokens (undefined stays direct-compatible; keychain without any
  // valid startup token fails closed here). Request handlers only use the snapshot —
  // mutating the caller's options object later never hot-reloads source or tokens.
  const startupManagementAuthSource = resolveManagementAuthSource(managementAuthSource);
  resolveStartupCredentialMode(
    startupManagementAuthSource,
    Boolean(expectedAuthToken || expectedReadToken || expectedWriteToken || expectedAdminToken),
  );
  const normalizedRestoreRoot = normalizeRestoreRoot(restoreRoot);
  const apiRateLimiter = createFixedWindowRateLimiter(rateLimit);
  const adminAuthConfigured = Boolean(expectedAuthToken || expectedWriteToken || expectedAdminToken);
  const hasDeviceAdministration = isDeviceAdministrationService(deviceAdministration);
  // Dual-gate: incomplete restoreService → management restore task paths stay 404.
  const resolvedRestoreService = resolveManagementRestoreService(restoreService);

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, method } = { pathname: url.pathname, method: req.method };
    const requestId = randomUUID();

    try {
      // ── API Routes ──────────────────────────────────────────
      if (isApiPath(pathname) && apiRateLimiter) {
        const decision = apiRateLimiter.check(req.socket?.remoteAddress || 'unknown');
        if (!decision.allowed) {
          await recordAudit(dataDir, {
            type: 'api.rate_limited',
            method,
            path: pathname,
            statusCode: 429,
            outcome: 'limited',
            requestId,
          }, auditRetention);
          return sendError(res, 429, 'Rate limit exceeded');
        }
      }

      if (isApiPath(pathname)) {
        const hasAuth = expectedAuthToken || expectedReadToken || expectedWriteToken || expectedAdminToken;
        if (hasAuth) {
          const header = req.headers.authorization;
          let authorized = false;
          let isWriteAllowed = false;
          let isAdminAllowed = false;

          if (typeof header === 'string' && header.startsWith('Bearer ')) {
            const token = header.slice('Bearer '.length);

            const matchesAuth = expectedAuthToken && authTokensMatch(token, expectedAuthToken);
            const matchesAdmin = expectedAdminToken && authTokensMatch(token, expectedAdminToken);
            const matchesWrite = expectedWriteToken && authTokensMatch(token, expectedWriteToken);
            const matchesPreviousWrite = expectedPreviousWriteToken
              && authTokensMatch(token, expectedPreviousWriteToken);
            const matchesRead = expectedReadToken && authTokensMatch(token, expectedReadToken);
            const matchesPreviousRead = expectedPreviousReadToken
              && authTokensMatch(token, expectedPreviousReadToken);

            // Full/admin 权限最宽：同时拥有写入与管理权限。
            // 仅在未配置管理令牌时，写入凭证才保留管理权限。
            if (matchesAuth || matchesAdmin) {
              authorized = true;
              isWriteAllowed = true;
              isAdminAllowed = true;
            } else if (matchesWrite || matchesPreviousWrite) {
              authorized = true;
              isWriteAllowed = true;
              isAdminAllowed = !expectedAdminToken;
            } else if (matchesRead || matchesPreviousRead) {
              authorized = true;
              isWriteAllowed = false;
              isAdminAllowed = false;
            }
          }

          if (!authorized) {
            await recordAudit(dataDir, {
              type: 'auth.denied',
              method,
              path: pathname,
              statusCode: 401,
              outcome: 'denied',
              requestId,
            }, auditRetention);
            return sendError(res, 401, 'Unauthorized');
          }

          // 管理路由前置门：早于写权限检查、请求体解析和服务调用。
          if (!isAdminAllowed && isDeviceAdministrationApiRoute(method, url)) {
            await recordAudit(dataDir, {
              type: 'auth.forbidden',
              method,
              path: pathname,
              statusCode: 403,
              outcome: 'forbidden',
              requestId,
            }, auditRetention);
            return sendError(res, 403, 'Forbidden');
          }

          if (!isWriteAllowed) {
            if (isApiWriteRoute(method, pathname)) {
              await recordAudit(dataDir, {
                type: 'auth.forbidden',
                method,
                path: pathname,
                statusCode: 403,
                outcome: 'forbidden',
                requestId,
              }, auditRetention);
              return sendError(res, 403, 'Forbidden');
            }
          }
        }
      }

      // Required write-admission (fail-closed): after rate/auth, before any write body/mutation.
      if (isApiWriteRoute(method, pathname)) {
        await recordRequiredWriteAdmissionAudit(
          dataDir,
          { method, path: pathname, requestId },
          auditRetention,
        );
      }

      // POST /api/device-enrollment-codes — loopback admin; requires full/write token config
      if (isExactApiRoute(url, method, 'POST', '/api/device-enrollment-codes')) {
        if (!adminAuthConfigured) {
          await recordAudit(dataDir, {
            type: 'api.device-enrollment.failure',
            method,
            path: pathname,
            statusCode: 503,
            outcome: 'failure',
            requestId,
          }, auditRetention);
          return sendError(res, 503, ERROR_CODES.AUTH_ADMIN_REQUIRED);
        }
        if (!hasDeviceAdministration) {
          await recordAudit(dataDir, {
            type: 'api.device-enrollment.failure',
            method,
            path: pathname,
            statusCode: 503,
            outcome: 'failure',
            requestId,
          }, auditRetention);
          return sendError(res, 503, ERROR_CODES.DEVICE_REQUEST_INVALID);
        }

        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          const sanitized = sanitizeDeviceAdminError(err);
          await recordAudit(dataDir, {
            type: 'api.device-enrollment.failure',
            method,
            path: pathname,
            statusCode: sanitized.statusCode,
            outcome: 'failure',
            requestId,
          }, auditRetention);
          return sendError(res, sanitized.statusCode, sanitized.code);
        }

        const deviceId = parseAdminDeviceId(body);
        if (!deviceId) {
          await recordAudit(dataDir, {
            type: 'api.device-enrollment.failure',
            method,
            path: pathname,
            statusCode: 400,
            outcome: 'failure',
            requestId,
            deviceId: auditDeviceId(body?.deviceId),
          }, auditRetention);
          return sendError(res, 400, ERROR_CODES.DEVICE_REQUEST_INVALID);
        }

        // Validate public metadata before issuing so a bad injection never leaks a code.
        if (!isValidAdminAgentUrl(deviceAdministration.agentUrl)
          || !isValidAdminTlsFingerprint(deviceAdministration.tlsFingerprint)) {
          await recordAudit(dataDir, {
            type: 'api.device-enrollment.failure',
            method,
            path: pathname,
            statusCode: 500,
            outcome: 'failure',
            requestId,
            deviceId: auditDeviceId(deviceId),
          }, auditRetention);
          return sendError(res, 500, ERROR_CODES.DEVICE_INTERNAL_ERROR);
        }

        try {
          const enrollment = await deviceAdministration.issueEnrollment({ deviceId });
          const source = enrollment && typeof enrollment === 'object' && !Array.isArray(enrollment)
            ? enrollment
            : null;
          const codeValid = source && isValidEnrollmentCode(source.code);
          const expiresValid = source && isCanonicalIsoTimestamp(source.expiresAt);
          const deviceIdValid = source
            && (source.deviceId === undefined || source.deviceId === deviceId);
          if (!codeValid || !expiresValid || !deviceIdValid) {
            await recordAudit(dataDir, {
              type: 'api.device-enrollment.failure',
              method,
              path: pathname,
              statusCode: 500,
              outcome: 'failure',
              requestId,
              deviceId: auditDeviceId(deviceId),
            }, auditRetention);
            return sendError(res, 500, ERROR_CODES.DEVICE_INTERNAL_ERROR);
          }

          const responseBody = {
            deviceId,
            enrollmentCode: source.code,
            expiresAt: source.expiresAt,
            agentUrl: deviceAdministration.agentUrl,
            tlsFingerprint: deviceAdministration.tlsFingerprint,
            protocolVersion: DEVICE_PROTOCOL_VERSION,
          };
          await recordAudit(dataDir, {
            type: 'api.device-enrollment.success',
            method,
            path: pathname,
            statusCode: 201,
            outcome: 'success',
            requestId,
            deviceId: auditDeviceId(deviceId),
          }, auditRetention);
          return sendNoStoreJSON(res, 201, responseBody);
        } catch (err) {
          const sanitized = sanitizeDeviceAdminError(err);
          await recordAudit(dataDir, {
            type: 'api.device-enrollment.failure',
            method,
            path: pathname,
            statusCode: sanitized.statusCode,
            outcome: 'failure',
            requestId,
            deviceId: auditDeviceId(deviceId),
          }, auditRetention);
          return sendError(res, sanitized.statusCode, sanitized.code);
        }
      }

      // POST /api/device-revoke — loopback admin; requires full/write token config
      if (isExactApiRoute(url, method, 'POST', '/api/device-revoke')) {
        if (!adminAuthConfigured) {
          await recordAudit(dataDir, {
            type: 'api.device-revoke.failure',
            method,
            path: pathname,
            statusCode: 503,
            outcome: 'failure',
            requestId,
          }, auditRetention);
          return sendError(res, 503, ERROR_CODES.AUTH_ADMIN_REQUIRED);
        }
        if (!hasDeviceAdministration) {
          await recordAudit(dataDir, {
            type: 'api.device-revoke.failure',
            method,
            path: pathname,
            statusCode: 503,
            outcome: 'failure',
            requestId,
          }, auditRetention);
          return sendError(res, 503, ERROR_CODES.DEVICE_REQUEST_INVALID);
        }

        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          const sanitized = sanitizeDeviceAdminError(err);
          await recordAudit(dataDir, {
            type: 'api.device-revoke.failure',
            method,
            path: pathname,
            statusCode: sanitized.statusCode,
            outcome: 'failure',
            requestId,
          }, auditRetention);
          return sendError(res, sanitized.statusCode, sanitized.code);
        }

        const deviceId = parseAdminDeviceId(body);
        if (!deviceId) {
          await recordAudit(dataDir, {
            type: 'api.device-revoke.failure',
            method,
            path: pathname,
            statusCode: 400,
            outcome: 'failure',
            requestId,
            deviceId: auditDeviceId(body?.deviceId),
          }, auditRetention);
          return sendError(res, 400, ERROR_CODES.DEVICE_REQUEST_INVALID);
        }

        try {
          await deviceAdministration.revokeDevice(deviceId);
          await recordAudit(dataDir, {
            type: 'api.device-revoke.success',
            method,
            path: pathname,
            statusCode: 200,
            outcome: 'success',
            requestId,
            deviceId: auditDeviceId(deviceId),
          }, auditRetention);
          return sendJSON(res, 200, { deviceId, revoked: true });
        } catch (err) {
          const sanitized = sanitizeDeviceAdminError(err);
          await recordAudit(dataDir, {
            type: 'api.device-revoke.failure',
            method,
            path: pathname,
            statusCode: sanitized.statusCode,
            outcome: 'failure',
            requestId,
            deviceId: auditDeviceId(deviceId),
          }, auditRetention);
          return sendError(res, sanitized.statusCode, sanitized.code);
        }
      }

      // GET /api/agent-listener-status — read-only allowlist; not a write route
      if (isExactApiRoute(url, method, 'GET', '/api/agent-listener-status')) {
        if (!hasDeviceAdministration) {
          return sendError(res, 503, ERROR_CODES.DEVICE_REQUEST_INVALID);
        }
        try {
          const status = await deviceAdministration.getStatus();
          const source = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
          const listening = toStrictBoolean(source.listening);
          return sendJSON(res, 200, {
            status: listening ? 'ok' : 'degraded',
            listener: {
              bindConfigured: toStrictBoolean(source.bindConfigured),
              listening,
              tlsFingerprintConfigured: toStrictBoolean(source.tlsFingerprintConfigured),
            },
            devices: {
              active: toNonNegativeInteger(source.active),
              revoked: toNonNegativeInteger(source.revoked),
            },
          });
        } catch (err) {
          const sanitized = sanitizeDeviceAdminError(err);
          return sendError(res, sanitized.statusCode, sanitized.code);
        }
      }

      // GET /api/health
      if (method === 'GET' && pathname === '/api/health') {
        const dataDirReadable = await isDataDirReadable(dataDir);
        return sendJSON(res, 200, buildHealthResponse({ dataDirReadable }));
      }

      // GET /api/auth-status
      if (method === 'GET' && pathname === '/api/auth-status') {
        return sendJSON(res, 200, buildAuthStatusResponse({
          authToken: expectedAuthToken,
          readToken: expectedReadToken,
          previousReadToken: expectedPreviousReadToken,
          writeToken: expectedWriteToken,
          previousWriteToken: expectedPreviousWriteToken,
          adminToken: expectedAdminToken,
          managementAuthSource: startupManagementAuthSource,
        }));
      }

      // GET /api/hardening-status
      if (method === 'GET' && pathname === '/api/hardening-status') {
        return sendJSON(res, 200, buildHardeningStatusResponse({
          authToken: expectedAuthToken,
          readToken: expectedReadToken,
          writeToken: expectedWriteToken,
          adminToken: expectedAdminToken,
          restoreRoot: normalizedRestoreRoot,
          rateLimit: apiRateLimiter,
          auditRetention,
        }));
      }

      // GET /api/supervisor-status
      if (method === 'GET' && pathname === '/api/supervisor-status') {
        return sendJSON(res, 200, buildSupervisorStatusResponse());
      }

      // GET /api/release-readiness
      if (method === 'GET' && pathname === '/api/release-readiness') {
        const dataDirReadable = await isDataDirReadable(dataDir);
        const checkedAt = new Date();
        const health = buildHealthResponse({ dataDirReadable, now: checkedAt });
        return sendJSON(res, 200, buildReleaseReadinessReport(health, { now: checkedAt }));
      }

      // GET /api/gold-readiness
      if (method === 'GET' && pathname === '/api/gold-readiness') {
        return sendJSON(res, 200, buildGoldReadinessReport());
      }

      // GET /api/audit-log?limit=50
      if (method === 'GET' && pathname === '/api/audit-log') {
        const events = await readAuditEvents(dataDir, { limit: url.searchParams.get('limit') });
        return sendJSON(res, 200, { events });
      }

      // GET /api/supervisor-lifecycle-approval-records
      if (method === 'GET' && pathname === '/api/supervisor-lifecycle-approval-records') {
        const records = await readSupervisorLifecycleApprovalRecords(dataDir);
        return sendJSON(res, 200, buildSupervisorLifecycleApprovalRecordsResponse(records));
      }

      // POST /api/supervisor-lifecycle-apply-readiness
      // Read-only fail-closed preflight. It checks server-owned approval
      // records but never applies lifecycle changes and is not a write route.
      if (method === 'POST' && pathname === '/api/supervisor-lifecycle-apply-readiness') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400 || err.statusCode === 413) {
            return sendError(res, err.statusCode, err.message);
          }
          throw err;
        }

        const operation = body?.operation;
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(operation)) {
          return sendError(res, 400, 'operation must be one of: install, uninstall, rollback, recover');
        }

        try {
          const config = validateConfig(body?.config);
          const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
            operation,
            apply: true,
            envGateEnabled: true,
          });
          const approvalRecords = await readSupervisorLifecycleApprovalRecords(dataDir);
          const readiness = buildSupervisorLifecycleApplyReadiness(lifecyclePlan, approvalRecords);
          return sendJSON(res, 200, readiness);
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      // POST /api/supervisor-lifecycle-executor-readiness
      // Read-only fail-closed executor readiness preflight. It composes the
      // existing apply readiness with server-owned approval records, but never
      // executes lifecycle changes and is not a write route.
      if (method === 'POST' && pathname === '/api/supervisor-lifecycle-executor-readiness') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400 || err.statusCode === 413) {
            return sendError(res, err.statusCode, err.message);
          }
          throw err;
        }

        const operation = body?.operation;
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(operation)) {
          return sendError(res, 400, 'operation must be one of: install, uninstall, rollback, recover');
        }

        try {
          const config = validateConfig(body?.config);
          const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
            operation,
            apply: true,
            envGateEnabled: true,
          });
          let approvalRecords;
          try {
            approvalRecords = await readSupervisorLifecycleApprovalRecords(dataDir);
          } catch (err) {
            return sendError(res, 400, SUPERVISOR_LIFECYCLE_APPROVAL_RECORDS_READ_ERROR);
          }
          const applyReadiness = buildSupervisorLifecycleApplyReadiness(lifecyclePlan, approvalRecords);
          const executorReadiness = buildSupervisorLifecycleExecutorReadiness(lifecyclePlan, applyReadiness);
          return sendJSON(res, 200, executorReadiness);
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      // POST /api/supervisor-lifecycle-executor-manifest-readiness
      // 只读 fail-closed executor manifest readiness 校验。仅消费 inline JSON，
      // 不读取本地 manifest 路径或 approval storage，且刻意不注册为写路由。
      if (method === 'POST' && pathname === '/api/supervisor-lifecycle-executor-manifest-readiness') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400 || err.statusCode === 413) {
            return sendError(res, err.statusCode, err.message);
          }
          throw err;
        }

        const operation = body?.operation;
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(operation)) {
          return sendError(res, 400, 'operation must be one of: install, uninstall, rollback, recover');
        }

        let config;
        try {
          config = validateConfig(body?.config);
        } catch (err) {
          return sendError(res, 400, SUPERVISOR_LIFECYCLE_EXECUTOR_MANIFEST_READINESS_CONFIG_ERROR);
        }

        const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
          operation,
          apply: true,
          envGateEnabled: true,
        });

        try {
          const manifestReadiness = validateSupervisorLifecycleExecutorManifest(lifecyclePlan, body?.manifest);
          return sendJSON(res, 200, manifestReadiness);
        } catch (err) {
          return sendError(res, 400, SUPERVISOR_LIFECYCLE_EXECUTOR_MANIFEST_READINESS_VALIDATION_ERROR);
        }
      }

      // POST /api/supervisor-lifecycle-guarded-runner-readiness
      // 只读 fail-closed guarded runner binding readiness 校验。仅消费
      // inline JSON，不读取本地 path 或 approval storage，且刻意不注册为写路由。
      if (method === 'POST' && pathname === '/api/supervisor-lifecycle-guarded-runner-readiness') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400 || err.statusCode === 413) {
            return sendError(res, err.statusCode, err.message);
          }
          throw err;
        }

        const operation = body?.operation;
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(operation)) {
          return sendError(res, 400, 'operation must be one of: install, uninstall, rollback, recover');
        }

        let config;
        try {
          config = validateConfig(body?.config);
        } catch (err) {
          return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_CONFIG_ERROR);
        }

        const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
          operation,
          apply: true,
          envGateEnabled: true,
        });

        try {
          const manifestReadiness = validateSupervisorLifecycleExecutorManifest(lifecyclePlan, body?.manifest);
          const guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
            manifestReadiness,
            body?.runnerBinding,
          );
          return sendJSON(res, 200, guardedRunnerReadiness);
        } catch (err) {
          return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_VALIDATION_ERROR);
        }
      }

      // POST /api/supervisor-lifecycle-guarded-runner-execution-preview
      // 只读 fail-closed guarded runner execution preview。仅消费 inline JSON，
      // 不读取本地 path 或 approval storage，且刻意不注册为写路由。
      if (method === 'POST' && pathname === '/api/supervisor-lifecycle-guarded-runner-execution-preview') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400 || err.statusCode === 413) {
            return sendError(res, err.statusCode, err.message);
          }
          throw err;
        }

        const operation = body?.operation;
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(operation)) {
          return sendError(res, 400, 'operation must be one of: install, uninstall, rollback, recover');
        }

        let config;
        try {
          config = validateConfig(body?.config);
        } catch (err) {
          return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_CONFIG_ERROR);
        }

        const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
          operation,
          apply: true,
          envGateEnabled: true,
        });

        try {
          const manifestReadiness = validateSupervisorLifecycleExecutorManifest(lifecyclePlan, body?.manifest);
          if (manifestReadiness.manifestReady !== true) {
            return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_VALIDATION_ERROR);
          }
          const guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
            manifestReadiness,
            body?.runnerBinding,
          );
          const executionPreview = buildSupervisorLifecycleGuardedRunnerExecutionPreview(
            lifecyclePlan,
            guardedRunnerReadiness,
          );
          return sendJSON(res, 200, executionPreview);
        } catch (err) {
          return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_VALIDATION_ERROR);
        }
      }

      // POST /api/supervisor-lifecycle-guarded-runner-execution-gate
      // 只读 fail-closed guarded runner execution gate。仅消费 inline JSON，
      // approval records 只从 server-owned dataDir 读取，且刻意不注册为写路由。
      if (method === 'POST' && pathname === '/api/supervisor-lifecycle-guarded-runner-execution-gate') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400 || err.statusCode === 413) {
            return sendError(res, err.statusCode, err.message);
          }
          throw err;
        }

        const operation = body?.operation;
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(operation)) {
          return sendError(res, 400, 'operation must be one of: install, uninstall, rollback, recover');
        }

        if (body?.executeRequested !== undefined && typeof body.executeRequested !== 'boolean') {
          return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_EXECUTE_REQUESTED_ERROR);
        }

        let config;
        try {
          config = validateConfig(body?.config);
        } catch (err) {
          return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_CONFIG_ERROR);
        }

        const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
          operation,
          apply: true,
          envGateEnabled: true,
        });

        let approvalRecords;
        try {
          approvalRecords = await readSupervisorLifecycleApprovalRecords(dataDir);
        } catch (err) {
          return sendError(res, 400, SUPERVISOR_LIFECYCLE_APPROVAL_RECORDS_READ_ERROR);
        }

        try {
          const applyReadiness = buildSupervisorLifecycleApplyReadiness(lifecyclePlan, approvalRecords);
          const manifestReadiness = validateSupervisorLifecycleExecutorManifest(lifecyclePlan, body?.manifest);
          if (manifestReadiness.manifestReady !== true) {
            return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_VALIDATION_ERROR);
          }
          const guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
            manifestReadiness,
            body?.runnerBinding,
          );
          const executionPreview = buildSupervisorLifecycleGuardedRunnerExecutionPreview(
            lifecyclePlan,
            guardedRunnerReadiness,
          );
          const executionGate = buildSupervisorLifecycleGuardedRunnerExecutionGate(
            lifecyclePlan,
            applyReadiness,
            manifestReadiness,
            guardedRunnerReadiness,
            executionPreview,
            { executeRequested: body?.executeRequested === true },
          );
          return sendJSON(res, 200, executionGate);
        } catch (err) {
          return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_VALIDATION_ERROR);
        }
      }

      // POST /api/heartbeat
      if (method === 'POST' && pathname === '/api/heartbeat') {
        const body = await readBody(req);
        if (!body.deviceId) {
          await recordAudit(dataDir, {
            type: 'api.heartbeat.failure',
            method,
            path: pathname,
            statusCode: 400,
            outcome: 'failure',
            requestId,
            message: 'deviceId is required',
          }, auditRetention);
          return sendError(res, 400, 'deviceId is required');
        }
        const info = await recordHeartbeat(dataDir, body.deviceId, body.hostname, body.ipAddress);
        await recordAudit(dataDir, {
          type: 'api.heartbeat.success',
          method,
          path: pathname,
          statusCode: 200,
          outcome: 'success',
          requestId,
          deviceId: info.deviceId,
        }, auditRetention);
        return sendJSON(res, 200, info);
      }

      // POST /api/backups
      if (method === 'POST' && pathname === '/api/backups') {
        const body = await readBody(req);
        if (!body.deviceId || !body.sourcePath) {
          await recordAudit(dataDir, {
            type: 'api.backup.failure',
            method,
            path: pathname,
            statusCode: 400,
            outcome: 'failure',
            requestId,
            deviceId: auditDeviceId(body.deviceId),
            message: 'deviceId and sourcePath are required',
          }, auditRetention);
          return sendError(res, 400, 'deviceId and sourcePath are required');
        }
        let snapshot;
        try {
          snapshot = await createBackup(
            dataDir,
            {
              deviceId: body.deviceId,
              hostname: body.hostname,
              ipAddress: body.ipAddress,
              sourcePath: body.sourcePath,
              excludePatterns: body.excludePatterns,
              jobName: body.jobName,
            },
            backupHooks,
          );
        } catch (err) {
          const statusCode = errorStatusCode(err);
          await recordAudit(dataDir, {
            type: 'api.backup.failure',
            method,
            path: pathname,
            statusCode,
            outcome: 'failure',
            requestId,
            deviceId: auditDeviceId(body.deviceId),
            message: statusCode >= 500 ? 'Internal Server Error' : err.message,
          }, auditRetention);
          throw err;
        }
        await recordAudit(dataDir, {
          type: 'api.backup.created',
          method,
          path: pathname,
          statusCode: 201,
          outcome: 'success',
          requestId,
          deviceId: auditDeviceId(body.deviceId),
          snapshotId: snapshot.snapshotId,
          fileCount: snapshot.fileCount,
        }, auditRetention);
        return sendJSON(res, 201, snapshot);
      }

      // GET /api/backup-preflight-dry-run?sourcePath=/path&exclude=*.tmp&exclude=node_modules
      if (method === 'GET' && pathname === '/api/backup-preflight-dry-run') {
        const sourcePath = url.searchParams.get('sourcePath');
        if (!sourcePath) return sendError(res, 400, 'sourcePath is required');
        const excludePatterns = url.searchParams.getAll('exclude');

        try {
          const plan = await runBackupPreflightDryRun(sourcePath, excludePatterns);
          return sendJSON(res, 200, plan);
        } catch (err) {
          if (err.message.startsWith('Source path does not exist:')) {
            return sendError(res, 400, err.message);
          }
          throw err;
        }
      }

      // POST /api/nas-dry-run
      if (method === 'POST' && pathname === '/api/nas-dry-run') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400) {
            return sendError(res, 400, err.message);
          }
          throw err;
        }

        try {
          const plan = buildNasDryRunPlan(body);
          return sendJSON(res, 200, plan);
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      // POST /api/supervisor-install-dry-run
      // Dry-run preview only. This POST is not a write operation and must not
      // be copied for mutating routes without also updating API_WRITE_ROUTES.
      if (method === 'POST' && pathname === '/api/supervisor-install-dry-run') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400) {
            return sendError(res, 400, err.message);
          }
          throw err;
        }

        try {
          const config = validateConfig(body);
          const plan = buildSupervisorInstallDryRunPlan(config);
          return sendJSON(res, 200, plan);
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      // POST /api/supervisor-lifecycle-approval-persistence-preview
      // Manual preview only. This route does not apply lifecycle changes and
      // must not be registered as a write route.
      if (method === 'POST' && pathname === '/api/supervisor-lifecycle-approval-persistence-preview') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400) {
            return sendError(res, 400, err.message);
          }
          throw err;
        }

        try {
          const operation = body?.operation;
          const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
          if (!validOperations.has(operation)) {
            return sendError(res, 400, 'operation must be one of: install, uninstall, rollback, recover');
          }
          const config = validateConfig(body?.config);
          const approval = body && Object.hasOwn(body, 'approval') ? body.approval : undefined;
          const plan = buildSupervisorLifecycleApplyPlan(config, {
            operation,
            apply: true,
            envGateEnabled: true,
            approval,
          });
          const preview = buildSupervisorLifecycleApprovalPersistencePreview(plan, approval);
          return sendJSON(res, 200, preview);
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      // POST /api/supervisor-lifecycle-approval-persist
      // Manual approval record persistence only. This route writes sanitized
      // local JSONL records and never applies lifecycle changes.
      if (method === 'POST' && pathname === '/api/supervisor-lifecycle-approval-persist') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400 || err.statusCode === 413) {
            const statusCode = err.statusCode;
            await recordAudit(dataDir, {
              type: 'api.supervisor_lifecycle_approval_persist.failure',
              method,
              path: pathname,
              statusCode,
              outcome: 'failure',
              requestId,
              message: statusCode === 413 ? 'request body too large' : 'invalid request body',
            }, auditRetention);
            return sendError(res, statusCode, err.message);
          }
          throw err;
        }

        const operation = body?.operation;
        const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
        if (!validOperations.has(operation)) {
          await recordAudit(dataDir, {
            type: 'api.supervisor_lifecycle_approval_persist.failure',
            method,
            path: pathname,
            statusCode: 400,
            outcome: 'failure',
            requestId,
            message: 'invalid operation',
          }, auditRetention);
          return sendError(res, 400, 'operation must be one of: install, uninstall, rollback, recover');
        }

        if (!body?.approval || typeof body.approval !== 'object' || Array.isArray(body.approval)) {
          await recordAudit(dataDir, {
            type: 'api.supervisor_lifecycle_approval_persist.failure',
            method,
            path: pathname,
            statusCode: 400,
            outcome: 'failure',
            requestId,
            operation,
            message: 'approval object is required',
          }, auditRetention);
          return sendError(res, 400, 'approval object is required');
        }

        let config;
        try {
          config = validateConfig(body?.config);
        } catch (err) {
          await recordAudit(dataDir, {
            type: 'api.supervisor_lifecycle_approval_persist.failure',
            method,
            path: pathname,
            statusCode: 400,
            outcome: 'failure',
            requestId,
            operation,
            message: 'invalid config',
          }, auditRetention);
          return sendError(res, 400, err.message);
        }

        const approval = body.approval;
        const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
          operation,
          apply: true,
          envGateEnabled: true,
          approval,
        });
        const preview = buildSupervisorLifecycleApprovalPersistencePreview(lifecyclePlan, approval);

        if (!isPersistablePreview(preview)) {
          await recordAudit(dataDir, {
            type: 'api.supervisor_lifecycle_approval_persist.blocked',
            method,
            path: pathname,
            statusCode: 409,
            outcome: 'blocked',
            requestId,
            operation,
            message: 'approval persistence blocked',
          }, auditRetention);
          return sendJSON(res, 409, preview);
        }

        let record;
        try {
          record = await appendSupervisorLifecycleApprovalRecord(dataDir, preview, approval);
        } catch (err) {
          await recordAudit(dataDir, {
            type: 'api.supervisor_lifecycle_approval_persist.failure',
            method,
            path: pathname,
            statusCode: 500,
            outcome: 'failure',
            requestId,
            operation,
            message: 'failed to persist approval record',
          }, auditRetention);
          return sendError(res, 500, 'failed to persist approval record');
        }

        await recordAudit(dataDir, {
          type: 'api.supervisor_lifecycle_approval_persist.persisted',
          method,
          path: pathname,
          statusCode: 201,
          outcome: 'success',
          requestId,
          operation,
          message: 'approval record persisted',
        }, auditRetention);
        return sendJSON(res, 201, record);
      }

      // POST /api/restore
      if (method === 'POST' && pathname === '/api/restore') {
        let body = {};
        try {
          body = await readBody(req);
          if (!body.deviceId || !body.snapshotId || !body.targetPath) {
            await recordAudit(dataDir, {
              type: 'api.restore.failure',
              method,
              path: pathname,
              statusCode: 400,
              outcome: 'failure',
              requestId,
              deviceId: auditDeviceId(body.deviceId),
              snapshotId: body.snapshotId,
              message: 'deviceId, snapshotId, and targetPath are required',
            }, auditRetention);
            return sendError(res, 400, 'deviceId, snapshotId, and targetPath are required');
          }
          const targetPath = await resolveRestoreTargetPath(body.targetPath, normalizedRestoreRoot);
          const result = await restoreSnapshot(dataDir, {
            deviceId: body.deviceId,
            snapshotId: body.snapshotId,
            targetPath,
            restoreRoot: normalizedRestoreRoot,
          });
          await recordAudit(dataDir, {
            type: 'api.restore.completed',
            method,
            path: pathname,
            statusCode: 200,
            outcome: 'success',
            requestId,
            deviceId: auditDeviceId(body.deviceId),
            snapshotId: body.snapshotId,
          }, auditRetention);
          return sendJSON(res, 200, result);
        } catch (err) {
          const statusCode = errorStatusCode(err);
          await recordAudit(dataDir, {
            type: 'api.restore.failure',
            method,
            path: pathname,
            statusCode,
            outcome: 'failure',
            requestId,
            deviceId: auditDeviceId(body.deviceId),
            snapshotId: body.snapshotId,
            message: statusCode >= 500 ? 'Internal Server Error' : err.message,
          }, auditRetention);
          throw err;
        }
      }

      // GET /api/devices
      if (method === 'GET' && pathname === '/api/devices') {
        const devices = await listDevices(dataDir);
        return sendJSON(res, 200, devices);
      }

      // GET /api/devices/:deviceId/snapshots
      const snapMatch = pathname.match(/^\/api\/devices\/([^/]+)\/snapshots$/);
      if (method === 'GET' && snapMatch) {
        const deviceId = decodeURIComponent(snapMatch[1]);
        const device = await getDevice(dataDir, deviceId);
        if (!device) return sendError(res, 404, 'Device not found');
        const snapshots = await listSnapshots(dataDir, deviceId);
        return sendJSON(res, 200, snapshots);
      }

      // GET /api/devices/:deviceId/snapshots/:snapshotId/manifest
      const manifestMatch = pathname.match(/^\/api\/devices\/([^/]+)\/snapshots\/([^/]+)\/manifest$/);
      if (method === 'GET' && manifestMatch) {
        const deviceId = decodeURIComponent(manifestMatch[1]);
        const snapshotId = decodeURIComponent(manifestMatch[2]);
        const device = await getDevice(dataDir, deviceId);
        if (!device) return sendError(res, 404, 'Device not found');

        let manifest;
        try {
          manifest = await getSnapshotManifest(dataDir, deviceId, snapshotId);
        } catch (err) {
          if (err.message.startsWith('Invalid snapshotId:')) {
            return sendError(res, 400, 'Invalid snapshotId');
          }
          throw err;
        }
        if (!manifest) return sendError(res, 404, 'Snapshot manifest not found');
        return sendJSON(res, 200, manifest);
      }

      // GET /api/devices/:deviceId/snapshots/:snapshotId/restore-dry-run?targetPath=/path
      const restoreDryRunMatch = pathname.match(/^\/api\/devices\/([^/]+)\/snapshots\/([^/]+)\/restore-dry-run$/);
      if (method === 'GET' && restoreDryRunMatch) {
        const deviceId = decodeURIComponent(restoreDryRunMatch[1]);
        const snapshotId = decodeURIComponent(restoreDryRunMatch[2]);
        const device = await getDevice(dataDir, deviceId);
        if (!device) return sendError(res, 404, 'Device not found');

        const targetPath = url.searchParams.get('targetPath');
        if (!targetPath) return sendError(res, 400, 'targetPath is required');
        const resolvedTargetPath = await resolveRestoreTargetPath(targetPath, normalizedRestoreRoot);

        let manifest;
        try {
          manifest = await getSnapshotManifest(dataDir, deviceId, snapshotId);
        } catch (err) {
          if (err.message.startsWith('Invalid snapshotId:')) {
            return sendError(res, 400, 'Invalid snapshotId');
          }
          throw err;
        }
        if (!manifest) return sendError(res, 404, 'Snapshot manifest not found');

        let existingTargetPaths;
        try {
          existingTargetPaths = await collectExistingTargetPaths(resolvedTargetPath);
        } catch {
          return sendError(res, 400, 'Unable to read targetPath');
        }

        let plan;
        try {
          plan = buildRestoreDryRunPlan(deviceId, manifest, resolvedTargetPath, existingTargetPaths);
        } catch (err) {
          if (err.message.startsWith('Invalid manifest file path:')) {
            return sendError(res, 400, err.message);
          }
          throw err;
        }
        return sendJSON(res, 200, plan);
      }

      // GET /api/devices/:deviceId/snapshots/diff-dry-run?from=A&to=B
      const diffMatch = pathname.match(/^\/api\/devices\/([^/]+)\/snapshots\/diff-dry-run$/);
      if (method === 'GET' && diffMatch) {
        const deviceId = decodeURIComponent(diffMatch[1]);
        const device = await getDevice(dataDir, deviceId);
        if (!device) return sendError(res, 404, 'Device not found');

        const fromSnapshotId = url.searchParams.get('from');
        const toSnapshotId = url.searchParams.get('to');
        if (!fromSnapshotId || !toSnapshotId) {
          return sendError(res, 400, 'from and to snapshot ids are required');
        }

        let fromManifest, toManifest;
        try {
          fromManifest = await getSnapshotManifest(dataDir, deviceId, fromSnapshotId);
          toManifest = await getSnapshotManifest(dataDir, deviceId, toSnapshotId);
        } catch (err) {
          if (err.message.startsWith('Invalid snapshotId:')) {
            return sendError(res, 400, 'Invalid snapshotId');
          }
          throw err;
        }
        if (!fromManifest || !toManifest) return sendError(res, 404, 'Snapshot manifest not found');

        const plan = buildSnapshotDiffDryRunPlan(deviceId, fromManifest, toManifest);
        return sendJSON(res, 200, plan);
      }

      // GET /api/devices/:deviceId/retention-dry-run?keepLast=N
      const retMatch = pathname.match(/^\/api\/devices\/([^/]+)\/retention-dry-run$/);
      if (method === 'GET' && retMatch) {
        const deviceId = decodeURIComponent(retMatch[1]);
        const device = await getDevice(dataDir, deviceId);
        if (!device) return sendError(res, 404, 'Device not found');

        let keepLast = 3;
        const keepLastParam = url.searchParams.get('keepLast');
        if (keepLastParam !== null) {
          keepLast = Number(keepLastParam);
          if (!Number.isInteger(keepLast) || keepLast < 1) {
            return sendError(res, 400, 'keepLast must be a positive integer');
          }
        }

        const snapshots = await listSnapshots(dataDir, deviceId);
        const plan = buildRetentionDryRunPlan(deviceId, snapshots, { keepLast });
        return sendJSON(res, 200, plan);
      }

      // ── G0c restore-tasks management (after central write-admission gate) ──
      // Create / cancel are write routes (admission already ran above when matched).
      // GET status is read-only. Management create does NOT probe active upload.
      if (resolvedRestoreService) {
        // POST /api/devices/:deviceId/restore-tasks
        const restoreCreateMatch = pathname.match(/^\/api\/devices\/([^/]+)\/restore-tasks$/);
        if (method === 'POST' && restoreCreateMatch) {
          const deviceId = decodeURIComponent(restoreCreateMatch[1]);
          let body;
          try {
            body = await readBody(req);
          } catch (err) {
            const mapped = mapRestoreManagementError(err)
              || (err && err.statusCode === 413
                ? { statusCode: 413, code: ERROR_CODES.DEVICE_REQUEST_INVALID }
                : err && err.statusCode === 400
                  ? { statusCode: 400, code: ERROR_CODES.DEVICE_REQUEST_INVALID }
                  : { statusCode: 400, code: ERROR_CODES.RESTORE_TASK_INVALID });
            return sendNoStoreJSON(res, mapped.statusCode, { error: mapped.code });
          }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return sendNoStoreJSON(res, 400, { error: ERROR_CODES.RESTORE_TASK_INVALID });
          }
          const keys = Object.keys(body);
          if (
            keys.length !== 2
            || !Object.prototype.hasOwnProperty.call(body, 'snapshotId')
            || !Object.prototype.hasOwnProperty.call(body, 'relativeTarget')
          ) {
            return sendNoStoreJSON(res, 400, { error: ERROR_CODES.RESTORE_TASK_INVALID });
          }
          try {
            const result = await resolvedRestoreService.createTask({
              deviceId,
              snapshotId: body.snapshotId,
              relativeTarget: body.relativeTarget,
            });
            let httpStatus = 201;
            try {
              const hint = /** @type {{ httpHint?: unknown, httpStatus?: unknown }} */ (result)?.httpHint
                ?? /** @type {{ httpStatus?: unknown }} */ (result)?.httpStatus;
              if (hint === 200 || hint === 201) httpStatus = hint;
            } catch {
              httpStatus = 201;
            }
            return sendNoStoreJSON(res, httpStatus, projectRestoreManagementSummary(result));
          } catch (err) {
            const mapped = mapRestoreManagementError(err);
            if (mapped) {
              return sendNoStoreJSON(res, mapped.statusCode, { error: mapped.code });
            }
            throw err;
          }
        }

        // GET /api/devices/:deviceId/restore-tasks/:taskId
        const restoreGetMatch = pathname.match(/^\/api\/devices\/([^/]+)\/restore-tasks\/([^/]+)$/);
        if (method === 'GET' && restoreGetMatch) {
          const deviceId = decodeURIComponent(restoreGetMatch[1]);
          const taskId = decodeURIComponent(restoreGetMatch[2]);
          try {
            const result = await resolvedRestoreService.getStatus({ deviceId, taskId });
            return sendNoStoreJSON(res, 200, projectRestoreManagementSummary(result));
          } catch (err) {
            const mapped = mapRestoreManagementError(err);
            if (mapped) {
              return sendNoStoreJSON(res, mapped.statusCode, { error: mapped.code });
            }
            throw err;
          }
        }

        // POST /api/devices/:deviceId/restore-tasks/:taskId/cancel
        const restoreCancelMatch = pathname.match(
          /^\/api\/devices\/([^/]+)\/restore-tasks\/([^/]+)\/cancel$/,
        );
        if (method === 'POST' && restoreCancelMatch) {
          const deviceId = decodeURIComponent(restoreCancelMatch[1]);
          const taskId = decodeURIComponent(restoreCancelMatch[2]);
          // Consume optional body; cancel body is empty object or omit.
          try {
            await readBody(req);
          } catch (err) {
            const mapped = mapRestoreManagementError(err)
              || (err && err.statusCode === 413
                ? { statusCode: 413, code: ERROR_CODES.DEVICE_REQUEST_INVALID }
                : err && err.statusCode === 400
                  ? { statusCode: 400, code: ERROR_CODES.DEVICE_REQUEST_INVALID }
                  : { statusCode: 400, code: ERROR_CODES.RESTORE_TASK_INVALID });
            return sendNoStoreJSON(res, mapped.statusCode, { error: mapped.code });
          }
          try {
            const result = await resolvedRestoreService.cancelTask({ deviceId, taskId });
            let httpStatus = 200;
            try {
              const hint = /** @type {{ httpHint?: unknown, httpStatus?: unknown }} */ (result)?.httpHint
                ?? /** @type {{ httpStatus?: unknown }} */ (result)?.httpStatus;
              if (hint === 200 || hint === 202) httpStatus = hint;
            } catch {
              httpStatus = 200;
            }
            return sendNoStoreJSON(res, httpStatus, projectRestoreCancelSummary(result));
          } catch (err) {
            const mapped = mapRestoreManagementError(err);
            if (mapped) {
              return sendNoStoreJSON(res, mapped.statusCode, { error: mapped.code });
            }
            throw err;
          }
        }
      }

      // ── Static Web Console ──────────────────────────────────

      if (method === 'GET' && pathname === '/') {
        return serveStatic(res, join(__dirname, 'web', 'index.html'));
      }
      if (method === 'GET' && pathname === '/app.js') {
        return serveStatic(res, join(__dirname, 'web', 'app.js'));
      }
      if (method === 'GET' && pathname === '/styles.css') {
        return serveStatic(res, join(__dirname, 'web', 'styles.css'));
      }

      // ── 404 ─────────────────────────────────────────────────
      sendError(res, 404, 'Not Found');
    } catch (err) {
      if (
        err instanceof LinkeError
        && err.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE
      ) {
        return sendError(res, 503, ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
      }
      const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
      if (statusCode >= 400 && statusCode < 500) {
        return sendError(res, statusCode, err.message);
      }
      console.error('Server error:', err.message);
      return sendError(res, 500, 'Internal Server Error');
    }
  });

  return server;
}

// ── Standalone entry point ─────────────────────────────────────────
// Only auto-start when executed directly (not when imported by tests)

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '127.0.0.1';
  const dataDir = process.env.DATA_DIR || resolve(join(process.cwd(), 'data'));
  const authToken = process.env.LINKE_AUTH_TOKEN || process.env.LINKE_TOKEN;
  const readToken = process.env.LINKE_READ_TOKEN;
  const previousReadToken = process.env.LINKE_PREVIOUS_READ_TOKEN;
  const writeToken = process.env.LINKE_WRITE_TOKEN;
  const previousWriteToken = process.env.LINKE_PREVIOUS_WRITE_TOKEN;
  const adminToken = process.env.LINKE_ADMIN_TOKEN;
  const restoreRoot = process.env.LINKE_RESTORE_ROOT;
  const normalizedRestoreRoot = normalizeRestoreRoot(restoreRoot);
  const rateLimit = parseRateLimitPerMinute(process.env.LINKE_RATE_LIMIT_PER_MINUTE);
  const auditRetention = parseAuditRetentionMaxEvents(process.env.LINKE_AUDIT_MAX_EVENTS);

  const server = createServer({
    dataDir,
    authToken,
    readToken,
    previousReadToken,
    writeToken,
    previousWriteToken,
    adminToken,
    restoreRoot: normalizedRestoreRoot,
    rateLimit,
    auditRetention,
  });
  server.listen(port, host, () => {
    console.log(`Linke server listening on http://${host}:${port}`);
    console.log(`Data directory: ${dataDir}`);
    if (normalizedRestoreRoot) {
      console.log(`Restore root: ${normalizedRestoreRoot}`);
    }
    if (authToken || readToken || writeToken || adminToken) {
      console.log('API bearer token authentication: enabled');
    }
    if (rateLimit) {
      console.log(`API rate limit: ${rateLimit.maxRequests} requests per minute`);
    }
    if (auditRetention) {
      console.log(`Audit retention: newest ${auditRetention.maxEvents} events`);
    }
  });
}
