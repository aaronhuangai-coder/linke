import { createServer as createHttpServer } from 'node:http';
import { constants } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  recordHeartbeat,
  listDevices,
  getDevice,
  createBackup,
  listSnapshots,
  getSnapshotManifest,
  restoreSnapshot,
} from './storage.js';
import { buildRetentionDryRunPlan } from './retention.js';
import { buildSnapshotDiffDryRunPlan } from './snapshot-diff.js';
import { buildRestoreDryRunPlan, collectExistingTargetPaths } from './restore-dry-run.js';
import { runBackupPreflightDryRun } from './backup-preflight.js';
import { buildNasDryRunPlan } from './nas.js';
import { LINKE_RELEASE_VERSION } from './version.js';
import { buildReleaseReadinessReport } from './release-readiness.js';
import { buildGoldReadinessReport } from './gold-readiness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export const MAX_JSON_BODY_BYTES = 1024 * 1024;

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

function normalizeAuthToken(authToken) {
  if (authToken === undefined || authToken === null) return '';
  if (typeof authToken !== 'string') throw new Error('authToken must be a string');
  const token = authToken.trim();
  if (authToken.length > 0 && !token) {
    throw new Error('authToken must be a non-empty string when provided');
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

async function isDataDirReadable(dataDir) {
  try {
    await access(dataDir, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function createServer({ dataDir, backupHooks, authToken } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const expectedAuthToken = normalizeAuthToken(authToken);

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, method } = { pathname: url.pathname, method: req.method };

    try {
      // ── API Routes ──────────────────────────────────────────
      if ((pathname === '/api' || pathname.startsWith('/api/')) && !isAuthorizedRequest(req, expectedAuthToken)) {
        return sendError(res, 401, 'Unauthorized');
      }

      // GET /api/health
      if (method === 'GET' && pathname === '/api/health') {
        const dataDirReadable = await isDataDirReadable(dataDir);
        return sendJSON(res, 200, buildHealthResponse({ dataDirReadable }));
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

      // POST /api/heartbeat
      if (method === 'POST' && pathname === '/api/heartbeat') {
        const body = await readBody(req);
        if (!body.deviceId) return sendError(res, 400, 'deviceId is required');
        const info = await recordHeartbeat(dataDir, body.deviceId, body.hostname, body.ipAddress);
        return sendJSON(res, 200, info);
      }

      // POST /api/backups
      if (method === 'POST' && pathname === '/api/backups') {
        const body = await readBody(req);
        if (!body.deviceId || !body.sourcePath) {
          return sendError(res, 400, 'deviceId and sourcePath are required');
        }
        const snapshot = await createBackup(
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

      // POST /api/restore
      if (method === 'POST' && pathname === '/api/restore') {
        const body = await readBody(req);
        if (!body.deviceId || !body.snapshotId || !body.targetPath) {
          return sendError(res, 400, 'deviceId, snapshotId, and targetPath are required');
        }
        const result = await restoreSnapshot(dataDir, {
          deviceId: body.deviceId,
          snapshotId: body.snapshotId,
          targetPath: body.targetPath,
        });
        return sendJSON(res, 200, result);
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
          existingTargetPaths = await collectExistingTargetPaths(targetPath);
        } catch (err) {
          return sendError(res, 400, `Unable to read targetPath: ${err.message}`);
        }

        let plan;
        try {
          plan = buildRestoreDryRunPlan(deviceId, manifest, targetPath, existingTargetPaths);
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

  const server = createServer({ dataDir, authToken });
  server.listen(port, host, () => {
    console.log(`Linke server listening on http://${host}:${port}`);
    console.log(`Data directory: ${dataDir}`);
    if (normalizeAuthToken(authToken)) {
      console.log('API bearer token authentication: enabled');
    }
  });
}
