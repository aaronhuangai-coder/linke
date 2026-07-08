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
  buildSupervisorLifecycleApprovalPersistencePreview,
} from './supervisor-lifecycle.js';
import {
  appendSupervisorLifecycleApprovalRecord,
  isPersistablePreview,
} from './approval-store.js';
import { LINKE_RELEASE_VERSION } from './version.js';
import { buildReleaseReadinessReport } from './release-readiness.js';
import { buildGoldReadinessReport } from './gold-readiness.js';
import { appendAuditEvent, parseAuditRetentionMaxEvents, readAuditEvents } from './audit-log.js';
import { createFixedWindowRateLimiter, parseRateLimitPerMinute } from './rate-limit.js';

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
// 新增写入接口必须注册在这里，测试会捕获 auth gate 与 auth-status 的漂移。
export const API_WRITE_ROUTES = [
  { method: 'POST', path: '/api/heartbeat' },
  { method: 'POST', path: '/api/backups' },
  { method: 'POST', path: '/api/restore' },
  { method: 'POST', path: '/api/supervisor-lifecycle-approval-persist' },
];

export function formatApiRoute(route) {
  return `${String(route.method).toUpperCase()} ${route.path}`;
}

/**
 * 判断请求是否命中注册表中的写入接口；空 method 按非写入请求处理。
 */
export function isApiWriteRoute(method, pathname) {
  const normalizedMethod = String(method || '').toUpperCase();
  return API_WRITE_ROUTES.some((route) => route.method === normalizedMethod && route.path === pathname);
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
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

function authTokensMatch(actualToken, expectedToken) {
  const actual = Buffer.from(actualToken);
  const expected = Buffer.from(expectedToken);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
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

export function buildAuthStatusResponse({ authToken, readToken, writeToken } = {}) {
  const normAuth = normalizeAuthToken(authToken);
  const normRead = normalizeReadToken(readToken);
  const normWrite = normalizeWriteToken(writeToken);
  const enabled = Boolean(normAuth || normRead || normWrite);

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
      },
      writeRoutes: API_WRITE_ROUTES.map(formatApiRoute),
    },
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
  restoreRoot,
  rateLimit,
  auditRetention,
} = {}) {
  const normAuth = normalizeAuthToken(authToken);
  const normRead = normalizeReadToken(readToken);
  const normWrite = normalizeWriteToken(writeToken);
  const authConfigured = Boolean(normAuth || normRead || normWrite);
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
      },
      scopedTokensConfigured: Boolean(normRead || normWrite),
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

async function isDataDirReadable(dataDir) {
  try {
    await access(dataDir, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function createServer({ dataDir, backupHooks, authToken, readToken, writeToken, restoreRoot, rateLimit, auditRetention } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const expectedAuthToken = normalizeAuthToken(authToken);
  const expectedReadToken = normalizeReadToken(readToken);
  const expectedWriteToken = normalizeWriteToken(writeToken);
  const normalizedRestoreRoot = normalizeRestoreRoot(restoreRoot);
  const apiRateLimiter = createFixedWindowRateLimiter(rateLimit);

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
        const hasAuth = expectedAuthToken || expectedReadToken || expectedWriteToken;
        if (hasAuth) {
          const header = req.headers.authorization;
          let authorized = false;
          let isWriteAllowed = false;

          if (typeof header === 'string' && header.startsWith('Bearer ')) {
            const token = header.slice('Bearer '.length);

            const matchesAuth = expectedAuthToken && authTokensMatch(token, expectedAuthToken);
            const matchesWrite = expectedWriteToken && authTokensMatch(token, expectedWriteToken);
            const matchesRead = expectedReadToken && authTokensMatch(token, expectedReadToken);

            if (matchesAuth || matchesWrite) {
              authorized = true;
              isWriteAllowed = true;
            } else if (matchesRead) {
              authorized = true;
              isWriteAllowed = false;
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
          writeToken: expectedWriteToken,
        }));
      }

      // GET /api/hardening-status
      if (method === 'GET' && pathname === '/api/hardening-status') {
        return sendJSON(res, 200, buildHardeningStatusResponse({
          authToken: expectedAuthToken,
          readToken: expectedReadToken,
          writeToken: expectedWriteToken,
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
  const writeToken = process.env.LINKE_WRITE_TOKEN;
  const restoreRoot = process.env.LINKE_RESTORE_ROOT;
  const normalizedRestoreRoot = normalizeRestoreRoot(restoreRoot);
  const rateLimit = parseRateLimitPerMinute(process.env.LINKE_RATE_LIMIT_PER_MINUTE);
  const auditRetention = parseAuditRetentionMaxEvents(process.env.LINKE_AUDIT_MAX_EVENTS);

  const server = createServer({ dataDir, authToken, readToken, writeToken, restoreRoot: normalizedRestoreRoot, rateLimit, auditRetention });
  server.listen(port, host, () => {
    console.log(`Linke server listening on http://${host}:${port}`);
    console.log(`Data directory: ${dataDir}`);
    if (normalizedRestoreRoot) {
      console.log(`Restore root: ${normalizedRestoreRoot}`);
    }
    if (authToken || readToken || writeToken) {
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
