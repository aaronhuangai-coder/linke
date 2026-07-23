/**
 * C6 RED — Agent restore routes + path-aware restore limiter + dual-timer deadlines.
 *
 * Authority: design §8 / §12 / §19 + plan C6 Steps 1–4 + C55 production wiring.
 * Production surface (frozen; GREEN must implement without changing these contracts):
 *
 *   createAgentListener({
 *     identity, registry, onHeartbeat,
 *     rateLimit,              // G0a legacy pre-auth limiter (60/min default)
 *     uploadRateLimit,        // independent /agent/upload/* (1200/min)
 *     restoreRateLimit,       // independent /agent/restore/* (1200/min; third bucket)
 *     uploadService,          // G0b dual-gate
 *     restoreService,         // complete surface OR absent → all six restore paths fixed 404
 *     timers,                 // optional deadline test deps
 *   })
 *
 * Dual-gate fail-closed: routes match ONLY when BOTH complete restoreService AND
 * complete restoreRateLimit.check are present. Missing either → fixed 404, no half-exposure.
 *
 * Routes (only when dual-gate complete):
 *   POST /agent/restore/tasks/claim
 *   GET  /agent/restore/tasks/:taskId
 *   GET  /agent/restore/tasks/:taskId/files/:fileIndex/chunks/:chunkIndex
 *   POST /agent/restore/tasks/:taskId/progress
 *   POST /agent/restore/tasks/:taskId/receipts
 *   POST /agent/restore/tasks/:taskId/cleanup
 *
 * Wire order (every matched restore request):
 *   0. path-aware restoreRateLimit 1200/min → device-rate-limited 429 (no auth/body/lookup)
 *   1. exact-one Authorization / X-Linke-Device-Id / X-Linke-Protocol-Version
 *   2. registry.authenticate
 *   3. authenticated deviceId is scope SoT; only then body / taskId lookup / service
 *
 * Expected RED causes (current production gaps):
 *   - no restore routes / no restoreService / restoreRateLimit wiring
 *   - no third-bucket restore limiter isolation
 *   - no claim/task/chunk/progress/receipt/cleanup handlers
 *   - no 120s chunk / 15s JSON restore deadlines + AbortSignal single-settle
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceRegistry } from '../src/device-registry.js';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../src/tls-identity-store.js';
import { createAgentListener } from '../src/agent-listener.js';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { createUploadLocks } from '../src/upload-locks.js';
import { createRestoreService } from '../src/restore-service.js';

// ---------------------------------------------------------------------------
// Frozen constants (test-side; mirror design — do not import non-exported src)
// ---------------------------------------------------------------------------

const RESTORE_JSON_MAX_BYTES = 64 * 1024;
const RESTORE_JSON_TOTAL_MS = 15_000;
const RESTORE_CHUNK_TOTAL_MS = 120_000;
const SERVER_HEADERS_TIMEOUT_MS = 10_000;
const SERVER_REQUEST_TIMEOUT_MS = 0;
const RESTORE_DEFAULT_MAX_PER_MIN = 1200;
const UPLOAD_DEFAULT_MAX_PER_MIN = 1200;
const LEGACY_DEFAULT_MAX_PER_MIN = 60;
const CHUNK_SIZE = 8 * 1024 * 1024;

const TASK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TASK_ID_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-4466554400aa';
const DIGEST = 'a'.repeat(64);
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const RESTORE_PATHS = Object.freeze([
  ['POST', '/agent/restore/tasks/claim'],
  ['GET', `/agent/restore/tasks/${TASK_ID}`],
  ['GET', `/agent/restore/tasks/${TASK_ID}/files/0/chunks/0`],
  ['POST', `/agent/restore/tasks/${TASK_ID}/progress`],
  ['POST', `/agent/restore/tasks/${TASK_ID}/receipts`],
  ['POST', `/agent/restore/tasks/${TASK_ID}/cleanup`],
]);

const COMPLETE_RESTORE_METHODS = Object.freeze([
  'claim',
  'getTask',
  'getChunk',
  'updateProgress',
  'acceptReceipt',
  'acceptCleanup',
]);

const FORBIDDEN_RESPONSE_KEYS = Object.freeze([
  'sourcePath',
  'ipAddress',
  'ip',
  'token',
  'deviceToken',
  'fingerprint',
  'hostname',
  'rawError',
  'stack',
  'errno',
  'dataDir',
  'stagingPath',
  'absolutePath',
  'authorization',
  'targetPath',
  'anchorPath',
  'quarantinePath',
  'restoreRoot',
]);

// ---------------------------------------------------------------------------
// Manual timer harness
// ---------------------------------------------------------------------------

function createManualTimers(startMs = 1_000_000) {
  let nowMs = startMs;
  let nextId = 1;
  /** @type {Map<number, { id: number, fireAt: number, fn: Function, args: any[], cleared: boolean }>} */
  const pending = new Map();

  return {
    now: () => nowMs,
    setTimeout(fn, ms, ...args) {
      const id = nextId;
      nextId += 1;
      const delay = Number(ms);
      const safeDelay = Number.isFinite(delay) && delay >= 0 ? delay : 0;
      pending.set(id, {
        id,
        fireAt: nowMs + safeDelay,
        fn,
        args,
        cleared: false,
      });
      return id;
    },
    clearTimeout(id) {
      const entry = pending.get(id);
      if (entry) entry.cleared = true;
      pending.delete(id);
    },
    advance(ms) {
      nowMs += ms;
      const due = [...pending.values()]
        .filter((e) => !e.cleared && e.fireAt <= nowMs)
        .sort((a, b) => a.id - b.id);
      for (const entry of due) {
        if (entry.cleared) continue;
        pending.delete(entry.id);
        entry.fn(...entry.args);
      }
    },
    pendingCount() {
      return [...pending.values()].filter((e) => !e.cleared).length;
    },
    reset(start = 1_000_000) {
      nowMs = start;
      pending.clear();
      nextId = 1;
    },
  };
}

async function waitForTimerArmed(timers, { minPending = 1, maxTurns = 64 } = {}) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (timers.pendingCount() >= minPending) return;
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }
  assert.ok(
    timers.pendingCount() >= minPending,
    `expected >=${minPending} armed timer(s), got ${timers.pendingCount()} after ${maxTurns} turns`,
  );
}

// ---------------------------------------------------------------------------
// TLS / HTTPS helpers
// ---------------------------------------------------------------------------

async function buildTestIdentity() {
  const { keyPem } = generateControllerPrivateKey();
  const certPem = await createOpenSslCertificate({
    keyPem,
    san: 'IP:127.0.0.1',
  });
  return { keyPem, certPem };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Counting mock restore service — records calls without disk I/O.
 * @param {Partial<Record<string, Function>>} [impl]
 */
function createMockRestoreService(impl = {}) {
  /** @type {Record<string, any[]>} */
  const calls = {
    claim: [],
    getTask: [],
    getChunk: [],
    updateProgress: [],
    acceptReceipt: [],
    acceptCleanup: [],
    createTask: [],
    cancelTask: [],
    getStatus: [],
    hasActiveRestore: [],
  };
  /** @type {number} */
  let runTransferProbe = 0;

  const methods = {
    async claim(input) {
      calls.claim.push(input);
      if (impl.claim) return impl.claim(input);
      return {
        task: {
          taskId: TASK_ID,
          snapshotId: SNAPSHOT_ID,
          manifestDigest: DIGEST,
          relativeTarget: 'apps/demo',
          status: 'active',
          fileCount: 1,
          totalBytes: 12,
          chunkSize: CHUNK_SIZE,
          createdAt: '2026-07-23T12:00:00.000Z',
          claimedAt: '2026-07-23T12:00:01.000Z',
          cancelRequested: false,
        },
      };
    },
    async getTask(input) {
      calls.getTask.push(input);
      if (impl.getTask) return impl.getTask(input);
      return {
        taskId: input?.taskId ?? TASK_ID,
        snapshotId: SNAPSHOT_ID,
        manifestDigest: DIGEST,
        relativeTarget: 'apps/demo',
        status: 'active',
        cancelRequested: false,
        cleanupAuthorized: false,
        fileCount: 1,
        totalBytes: 12,
        chunkSize: CHUNK_SIZE,
        files: [
          {
            fileIndex: 0,
            path: 'docs/readme.txt',
            size: 12,
            sha256: createHash('sha256').update('hello-restore').digest('hex'),
            chunkCount: 1,
          },
        ],
      };
    },
    async getChunk(input) {
      calls.getChunk.push(input);
      if (impl.getChunk) return impl.getChunk(input);
      const body = Buffer.from('hello-restore');
      const chunkSha256 = createHash('sha256').update(body).digest('hex');
      return {
        body,
        headers: Object.freeze({
          contentType: 'application/octet-stream',
          contentLength: body.length,
          taskId: input?.taskId ?? TASK_ID,
          fileIndex: input?.fileIndex ?? 0,
          chunkIndex: input?.chunkIndex ?? 0,
          chunkOffset: 0,
          chunkSize: body.length,
          chunkSha256,
        }),
      };
    },
    async updateProgress(input) {
      calls.updateProgress.push(input);
      if (impl.updateProgress) return impl.updateProgress(input);
      return { ok: true, cancelRequested: false };
    },
    async acceptReceipt(input) {
      calls.acceptReceipt.push(input);
      if (impl.acceptReceipt) return impl.acceptReceipt(input);
      return {
        ok: true,
        taskId: input?.taskId ?? TASK_ID,
        status: 'completed',
        cleanupAuthorized: true,
        receiptId: input?.receipt?.receiptId ?? '11111111-1111-4111-8111-111111111111',
      };
    },
    async acceptCleanup(input) {
      calls.acceptCleanup.push(input);
      if (impl.acceptCleanup) return impl.acceptCleanup(input);
      return {
        ok: true,
        taskId: input?.taskId ?? TASK_ID,
        status: 'cleaned',
        cleanupId: input?.cleanupReceipt?.cleanupId ?? '22222222-2222-4222-8222-222222222222',
        cleanupAckAt: '2026-07-23T12:05:00.000Z',
      };
    },
    async createTask(input) {
      calls.createTask.push(input);
      if (impl.createTask) return impl.createTask(input);
      return {
        taskId: TASK_ID,
        deviceId: input?.deviceId,
        snapshotId: input?.snapshotId ?? SNAPSHOT_ID,
        manifestDigest: DIGEST,
        relativeTarget: input?.relativeTarget ?? 'apps/demo',
        status: 'pending',
        fileCount: 1,
        totalBytes: 12,
        createdAt: '2026-07-23T12:00:00.000Z',
      };
    },
    async cancelTask(input) {
      calls.cancelTask.push(input);
      if (impl.cancelTask) return impl.cancelTask(input);
      return {
        taskId: input?.taskId ?? TASK_ID,
        status: 'active',
        cancelRequested: true,
      };
    },
    async getStatus(input) {
      calls.getStatus.push(input);
      if (impl.getStatus) return impl.getStatus(input);
      return {
        taskId: input?.taskId ?? TASK_ID,
        status: 'active',
        cancelRequested: false,
        cleanupAuthorized: false,
      };
    },
    async hasActiveRestore(deviceId) {
      calls.hasActiveRestore.push(deviceId);
      if (impl.hasActiveRestore) return impl.hasActiveRestore(deviceId);
      return false;
    },
  };

  // Test-only probe: production routes must never invoke runTransfer themselves.
  methods.__probeRunTransfer = () => {
    runTransferProbe += 1;
  };

  return {
    service: methods,
    calls,
    get runTransferProbe() {
      return runTransferProbe;
    },
  };
}

/**
 * Complete dual-gate fixture options for success-path tests.
 * @param {object} [options]
 */
async function startRestoreFixture(options = {}) {
  const dataDir = options.registry
    ? null
    : await mkdtemp(join(tmpdir(), 'linke-c6-restore-routes-'));
  const registry = options.registry || new DeviceRegistry({ dataDir });
  const identity = options.identity || await buildTestIdentity();
  const timers = options.timers;
  const server = createAgentListener({
    identity,
    registry,
    onHeartbeat: options.onHeartbeat || (async () => {}),
    rateLimit: options.rateLimit,
    uploadRateLimit: options.uploadRateLimit,
    uploadService: options.uploadService,
    restoreRateLimit: options.restoreRateLimit,
    restoreService: options.restoreService,
    ...(timers ? { timers } : {}),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  /**
   * @param {string} method
   * @param {string} path
   * @param {{
   *   body?: string | Buffer,
   *   headers?: Record<string, string | string[]>,
   *   token?: string,
   *   deviceId?: string,
   *   protocolVersion?: string | number,
   *   chunked?: boolean,
   *   end?: boolean,
   * }} [opts]
   */
  function requestAgent(method, path, opts = {}) {
    return new Promise((resolve, reject) => {
      /** @type {Record<string, string>} */
      const headers = {};
      const raw = opts.headers || {};
      for (const [k, v] of Object.entries(raw)) {
        if (Array.isArray(v)) {
          headers[k] = v[0];
        } else if (v !== undefined) {
          headers[k] = v;
        }
      }
      if (opts.token !== undefined && headers.authorization === undefined) {
        headers.authorization = `Bearer ${opts.token}`;
      }
      if (opts.deviceId !== undefined && headers['x-linke-device-id'] === undefined) {
        headers['x-linke-device-id'] = opts.deviceId;
      }
      if (
        opts.protocolVersion !== undefined
        && headers['x-linke-protocol-version'] === undefined
      ) {
        headers['x-linke-protocol-version'] = String(opts.protocolVersion);
      }
      let body = opts.body;
      if (body !== undefined && !opts.chunked && headers['content-length'] === undefined) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        headers['content-length'] = String(buf.length);
        body = buf;
      }

      const req = https.request({
        host: '127.0.0.1',
        port,
        path,
        method,
        headers,
        rejectUnauthorized: false,
        agent: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          const text = rawBody.toString('utf8');
          let parsed;
          const ct = String(res.headers['content-type'] || '');
          if (ct.includes('application/octet-stream')) {
            parsed = { __binary: rawBody };
          } else {
            try {
              parsed = text.length === 0 ? null : JSON.parse(text);
            } catch {
              parsed = { __unparsed: text };
            }
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
            raw: text,
            rawBuf: rawBody,
          });
        });
        res.on('error', reject);
      });

      req.on('error', reject);

      if (opts.end === false) {
        if (body !== undefined) req.write(body);
        return;
      }
      if (opts.chunked && body !== undefined) {
        req.write(body);
        req.end();
      } else if (body !== undefined) {
        req.end(body);
      } else {
        req.end();
      }
    });
  }

  return {
    server,
    port,
    registry,
    identity,
    dataDir,
    requestAgent,
    async cleanup() {
      await closeServer(server);
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function enrollDevice(registry, deviceId = 'device-restore-a', protocolVersion = 2) {
  const issued = await registry.issueEnrollment({ deviceId });
  const result = await registry.consumeEnrollment({
    deviceId,
    code: issued.code,
    protocolVersion,
  });
  return { deviceId, token: result.token, protocolVersion };
}

function assertPublicError(response, status, code) {
  assert.equal(response.status, status, `status for ${code}`);
  assert.deepEqual(response.body, { error: code });
  assert.equal(Object.keys(response.body).length, 1);
}

function assertNoForbiddenKeys(body) {
  if (body === null || typeof body !== 'object' || body.__binary) return;
  for (const k of FORBIDDEN_RESPONSE_KEYS) {
    assert.equal(body[k], undefined, `response must not include ${k}`);
  }
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /\/Users\/|PRIVATE KEY|BEGIN EC|Keychain|ENOENT|EACCES/i);
  assert.doesNotMatch(text, /"stack"\s*:/);
  assert.doesNotMatch(text, /"errno"\s*:/);
}

function assertRetryAfterBounded(headers) {
  const ra = headers['retry-after'];
  assert.ok(ra !== undefined, 'Retry-After required');
  assert.match(String(ra), /^\d+$/);
  const n = Number(ra);
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 30, `Retry-After must clamp to 1..30, got ${ra}`);
}

function instrumentAuth(registry) {
  let count = 0;
  /** @type {any[]} */
  const args = [];
  const original = registry.authenticate.bind(registry);
  registry.authenticate = async (request) => {
    count += 1;
    args.push(request);
    return original(request);
  };
  return {
    get count() {
      return count;
    },
    args,
    reset() {
      count = 0;
      args.length = 0;
    },
  };
}

function authHeaders(device) {
  return {
    authorization: `Bearer ${device.token}`,
    'x-linke-device-id': device.deviceId,
    'x-linke-protocol-version': String(device.protocolVersion),
  };
}

function assertLiveAbortSignal(signal, label) {
  assert.ok(signal && typeof signal === 'object', `${label} must receive signal`);
  assert.equal(typeof signal.aborted, 'boolean', `${label} signal.aborted`);
  assert.equal(typeof signal.addEventListener, 'function', `${label} signal.addEventListener`);
  return signal;
}

function rawTlsHttpExchange({
  port,
  head,
  bodyParts = [],
  endAfterBody = false,
  timeoutMs = 500,
}) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      finish({ kind: 'timeout', raw: buf.toString('utf8') });
    }, timeoutMs);
    socket.on('secureConnect', () => {
      socket.write(head);
      for (const part of bodyParts) socket.write(part);
      if (endAfterBody) socket.end();
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString('utf8');
      const sep = text.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const headerText = text.slice(0, sep);
      const bodyText = text.slice(sep + 4);
      const statusMatch = /^HTTP\/1\.\d (\d+)/.exec(headerText);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const clMatch = /content-length:\s*(\d+)/i.exec(headerText);
      if (!clMatch) return;
      const need = Number(clMatch[1]);
      const bodyBuf = Buffer.from(bodyText, 'utf8');
      if (bodyBuf.length < need) return;
      const rawBody = bodyBuf.subarray(0, need).toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = { __unparsed: rawBody };
      }
      const headerLines = headerText.split('\r\n').slice(1);
      /** @type {Record<string, string>} */
      const headers = {};
      for (const line of headerLines) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
      }
      finish({ kind: 'response', status, body: parsed, raw: rawBody, headers });
    });
    socket.on('error', (error) => {
      finish({ kind: 'error', code: error && error.code });
    });
  });
}

function sampleReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    deviceId: 'device-restore-a',
    snapshotId: SNAPSHOT_ID,
    manifestDigest: DIGEST,
    outcome: 'completed',
    relativeTarget: 'apps/demo',
    totalBytes: 12,
    fileCount: 1,
    contentSha256: createHash('sha256').update('hello-restore').digest('hex'),
    structureFingerprint: 'b'.repeat(64),
    publishedVerifiedAt: '2026-07-23T12:04:00.000Z',
    rolledBackAt: null,
    anchorPresentBeforePublish: false,
    receiptId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

function sampleCleanup(overrides = {}) {
  return {
    schemaVersion: 1,
    cleanupId: '22222222-2222-4222-8222-222222222222',
    taskId: TASK_ID,
    deviceId: 'device-restore-a',
    outcome: 'completed',
    receiptId: '11111111-1111-4111-8111-111111111111',
    cleanedAt: '2026-07-23T12:05:00.000Z',
    ...overrides,
  };
}

// ===========================================================================
// A. Dual-gate surface: restoreService + restoreRateLimit
// ===========================================================================

describe('C6 restore A — dual-gate route surface (RED)', () => {
  it('server freezes headersTimeout=10000 and requestTimeout=0', async () => {
    const fx = await startRestoreFixture();
    try {
      assert.equal(fx.server.headersTimeout, SERVER_HEADERS_TIMEOUT_MS);
      assert.equal(fx.server.requestTimeout, SERVER_REQUEST_TIMEOUT_MS);
    } finally {
      await fx.cleanup();
    }
  });

  it('without restoreService: all six restore paths fixed 404; no auth / no body side effects', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-nosvc-'));
    const registry = new DeviceRegistry({ dataDir });
    const auth = instrumentAuth(registry);
    const device = await enrollDevice(registry);
    const body = JSON.stringify({
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 1,
      leak: '/Users/secret/path',
      token: device.token,
    });
    const fx = await startRestoreFixture({
      registry,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      for (const [method, path] of RESTORE_PATHS) {
        auth.reset();
        const res = await fx.requestAgent(method, path, {
          body: method === 'GET' ? undefined : body,
          headers: {
            ...authHeaders(device),
            'content-type': 'application/json',
          },
        });
        assertPublicError(res, 404, ERROR_CODES.DEVICE_ROUTE_NOT_FOUND);
        assert.equal(auth.count, 0, `${method} ${path} must not authenticate`);
        assertNoForbiddenKeys(res.body);
        assert.ok(!res.raw.includes(device.token));
        assert.ok(!res.raw.includes('/Users/secret'));
        assert.equal(res.body.path, undefined);
        assert.equal(res.body.url, undefined);
      }
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('complete restoreService without complete restoreRateLimit → fixed 404; service untouched', async () => {
    const cases = [
      { label: 'missing limiter', restoreRateLimit: undefined },
      { label: 'empty object', restoreRateLimit: {} },
      { label: 'null check', restoreRateLimit: { check: null } },
      { label: 'non-function check', restoreRateLimit: { check: 'hostile' } },
      { label: 'array limiter', restoreRateLimit: [] },
    ];
    for (const c of cases) {
      const { service, calls } = createMockRestoreService();
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-half-lim-'));
      const registry = new DeviceRegistry({ dataDir });
      const auth = instrumentAuth(registry);
      const device = await enrollDevice(registry, 'half-lim');
      const fx = await startRestoreFixture({
        registry,
        restoreService: service,
        ...(c.restoreRateLimit !== undefined ? { restoreRateLimit: c.restoreRateLimit } : {}),
      });
      try {
        for (const [method, path] of RESTORE_PATHS) {
          auth.reset();
          const res = await fx.requestAgent(method, path, {
            body: method === 'GET' ? undefined : '{}',
            headers: { ...authHeaders(device), 'content-type': 'application/json' },
          });
          assertPublicError(res, 404, ERROR_CODES.DEVICE_ROUTE_NOT_FOUND);
          assert.equal(auth.count, 0, `${c.label} ${method} must not auth`);
        }
        for (const m of COMPLETE_RESTORE_METHODS) {
          assert.equal(calls[m].length, 0, `${c.label}: ${m} must stay 0`);
        }
      } finally {
        await fx.cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  });

  it('complete restoreRateLimit without complete restoreService → fixed 404; no half-exposure', async () => {
    const incomplete = [
      { label: 'empty object', service: {} },
      { label: 'only claim', service: { claim: async () => ({ task: null }) } },
      {
        label: 'missing getChunk',
        service: {
          claim: async () => ({ task: null }),
          getTask: async () => ({}),
          updateProgress: async () => ({}),
          acceptReceipt: async () => ({}),
          acceptCleanup: async () => ({}),
        },
      },
      {
        label: 'null method',
        service: {
          claim: async () => ({ task: null }),
          getTask: async () => ({}),
          getChunk: null,
          updateProgress: async () => ({}),
          acceptReceipt: async () => ({}),
          acceptCleanup: async () => ({}),
        },
      },
    ];
    for (const c of incomplete) {
      let constructed = false;
      let fx = null;
      try {
        try {
          fx = await startRestoreFixture({
            restoreService: c.service,
            restoreRateLimit: { check: () => ({ allowed: true }) },
          });
          constructed = true;
        } catch {
          constructed = false;
        }
        if (constructed && fx) {
          for (const [method, path] of RESTORE_PATHS) {
            const res = await fx.requestAgent(method, path, {
              body: method === 'GET' ? undefined : '{}',
              headers: {
                authorization: 'Bearer x',
                'x-linke-device-id': 'd',
                'x-linke-protocol-version': '2',
                'content-type': 'application/json',
              },
            });
            assert.ok(
              res.status === 404 || res.status >= 500,
              `${c.label} ${method} ${path} half-registered? status=${res.status}`,
            );
            if (res.status === 404) {
              assertPublicError(res, 404, ERROR_CODES.DEVICE_ROUTE_NOT_FOUND);
            }
          }
        }
      } finally {
        if (fx) await fx.cleanup();
      }
    }
  });

  it('with complete dual-gate: six routes call unique methods with frozen inputs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-wire-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'wire-restore-1');
    const authSoT = device.deviceId;
    const originalAuth = registry.authenticate.bind(registry);
    registry.authenticate = async (request) => {
      const out = await originalAuth(request);
      return { deviceId: out.deviceId, protocolVersion: out.protocolVersion };
    };
    const { service, calls } = createMockRestoreService();
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const claimRes = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(claimRes.status, 200);
      assert.equal(calls.claim.length, 1);
      assert.equal(calls.claim[0].deviceId, authSoT);
      assertLiveAbortSignal(calls.claim[0].signal, 'claim');
      assert.ok(claimRes.body.task);
      assert.equal(claimRes.body.task.status, 'active');
      assertNoForbiddenKeys(claimRes.body);

      const taskRes = await fx.requestAgent('GET', `/agent/restore/tasks/${TASK_ID}`, {
        headers: authHeaders(device),
      });
      assert.equal(taskRes.status, 200);
      assert.equal(calls.getTask.length, 1);
      assert.equal(calls.getTask[0].deviceId, authSoT);
      assert.equal(calls.getTask[0].taskId, TASK_ID);
      assertLiveAbortSignal(calls.getTask[0].signal, 'getTask');
      assert.ok(Array.isArray(taskRes.body.files));
      assert.equal(taskRes.body.files[0].path, 'docs/readme.txt');
      assertNoForbiddenKeys(taskRes.body);

      const chunkRes = await fx.requestAgent(
        'GET',
        `/agent/restore/tasks/${TASK_ID}/files/0/chunks/0`,
        { headers: authHeaders(device) },
      );
      assert.equal(chunkRes.status, 200);
      assert.equal(calls.getChunk.length, 1);
      assert.equal(calls.getChunk[0].deviceId, authSoT);
      assert.equal(calls.getChunk[0].taskId, TASK_ID);
      assert.equal(calls.getChunk[0].fileIndex, 0);
      assert.equal(calls.getChunk[0].chunkIndex, 0);
      assertLiveAbortSignal(calls.getChunk[0].signal, 'getChunk');
      assert.match(String(chunkRes.headers['content-type'] || ''), /application\/octet-stream/);
      assert.equal(String(chunkRes.headers['x-linke-task-id']), TASK_ID);
      assert.equal(String(chunkRes.headers['x-linke-file-index']), '0');
      assert.equal(String(chunkRes.headers['x-linke-chunk-index']), '0');
      assert.ok(chunkRes.headers['x-linke-chunk-offset'] !== undefined);
      assert.ok(chunkRes.headers['x-linke-chunk-size'] !== undefined);
      assert.match(String(chunkRes.headers['x-linke-chunk-sha256'] || ''), /^[a-f0-9]{64}$/);
      assert.equal(String(chunkRes.headers['cache-control'] || '').toLowerCase(), 'no-store');
      assert.ok(Buffer.isBuffer(chunkRes.rawBuf));
      assert.equal(chunkRes.rawBuf.toString('utf8'), 'hello-restore');

      const progressRes = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/progress`,
        {
          body: JSON.stringify({ fileIndex: 0, chunkIndex: 0, receivedBytes: 12 }),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assert.equal(progressRes.status, 200);
      assert.equal(calls.updateProgress.length, 1);
      assert.equal(calls.updateProgress[0].deviceId, authSoT);
      assert.equal(calls.updateProgress[0].taskId, TASK_ID);
      assertLiveAbortSignal(calls.updateProgress[0].signal, 'updateProgress');
      assert.equal(progressRes.body.ok, true);
      assert.equal(typeof progressRes.body.cancelRequested, 'boolean');
      assertNoForbiddenKeys(progressRes.body);

      const receipt = sampleReceipt({ deviceId: device.deviceId });
      const receiptRes = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/receipts`,
        {
          body: JSON.stringify(receipt),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assert.equal(receiptRes.status, 200);
      assert.equal(calls.acceptReceipt.length, 1);
      assert.equal(calls.acceptReceipt[0].deviceId, authSoT);
      assert.equal(receiptRes.body.cleanupAuthorized, true);
      assert.notEqual(receiptRes.body.status, 'cleaned');
      assert.ok(['completed', 'rolled-back'].includes(receiptRes.body.status));
      assertNoForbiddenKeys(receiptRes.body);

      const cleanup = sampleCleanup({ deviceId: device.deviceId });
      const cleanupRes = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/cleanup`,
        {
          body: JSON.stringify(cleanup),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assert.equal(cleanupRes.status, 200);
      assert.equal(calls.acceptCleanup.length, 1);
      assert.equal(calls.acceptCleanup[0].deviceId, authSoT);
      assert.ok(['cleaned', 'cancelled'].includes(cleanupRes.body.status));
      assertNoForbiddenKeys(cleanupRes.body);

      assert.equal(calls.claim.length, 1);
      assert.equal(calls.getTask.length, 1);
      assert.equal(calls.getChunk.length, 1);
      assert.equal(calls.updateProgress.length, 1);
      assert.equal(calls.acceptReceipt.length, 1);
      assert.equal(calls.acceptCleanup.length, 1);
      const signals = [
        calls.claim[0].signal,
        calls.getTask[0].signal,
        calls.getChunk[0].signal,
        calls.updateProgress[0].signal,
        calls.acceptReceipt[0].signal,
        calls.acceptCleanup[0].signal,
      ];
      assert.equal(new Set(signals).size, 6, 'each restore method gets its own request signal');
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('unknown method/query/trailing slash/path injection fixed 404; path not in error body', async () => {
    const { service, calls } = createMockRestoreService();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-404-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-404');
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const cases = [
        ['PUT', `/agent/restore/tasks/${TASK_ID}`],
        ['POST', `/agent/restore/tasks/${TASK_ID}/`],
        ['GET', `/agent/restore/tasks/${TASK_ID}?path=/Users/secret`],
        ['GET', `/agent/restore/tasks/${TASK_ID}/files/0/chunks/0?path=docs/x`],
        ['POST', '/agent/restore/tasks/claim/extra'],
        ['GET', '/agent/restore/../upload/sessions'],
      ];
      for (const [method, path] of cases) {
        const res = await fx.requestAgent(method, path, {
          body: method === 'GET' ? undefined : '{}',
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assertPublicError(res, 404, ERROR_CODES.DEVICE_ROUTE_NOT_FOUND);
        assert.equal(res.body.path, undefined);
        assert.ok(!res.raw.includes('/Users/secret'));
      }
      for (const m of COMPLETE_RESTORE_METHODS) {
        assert.equal(calls[m].length, 0);
      }
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// B. Path-aware restore limiter isolation (third bucket)
// ===========================================================================

describe('C6 restore B — restoreRateLimit isolation (RED)', () => {
  it('restore routes only call restoreRateLimit; G0a/upload never counted; pre-auth order', async () => {
    const order = [];
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-lim-iso-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-lim-iso');
    const originalAuth = registry.authenticate.bind(registry);
    registry.authenticate = async (req) => {
      order.push('auth');
      return originalAuth(req);
    };
    const { service, calls } = createMockRestoreService({
      claim: async (input) => {
        order.push('service');
        return { task: null };
      },
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      rateLimit: {
        check: () => {
          order.push('legacy');
          return { allowed: true };
        },
      },
      uploadRateLimit: {
        check: () => {
          order.push('upload');
          return { allowed: true };
        },
      },
      restoreRateLimit: {
        check: () => {
          order.push('restore');
          return { allowed: true };
        },
      },
    });
    try {
      order.length = 0;
      const claim = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(claim.status, 200);
      assert.ok(order.includes('restore'), 'restore limiter must run');
      assert.ok(!order.includes('legacy'), 'legacy must not run on restore');
      assert.ok(!order.includes('upload'), 'upload must not run on restore');
      assert.ok(order.indexOf('restore') < order.indexOf('auth'), 'limiter before auth');
      assert.ok(order.indexOf('auth') < order.indexOf('service'), 'auth before service');
      assert.equal(calls.claim.length, 1);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('128 restore claims are not killed by legacy 60/min; counters isolated from upload', async () => {
    let legacyCount = 0;
    let uploadCount = 0;
    let restoreCount = 0;
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-128-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-128');
    const { service } = createMockRestoreService({
      claim: async () => ({ task: null }),
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      rateLimit: {
        check: () => {
          legacyCount += 1;
          return legacyCount <= LEGACY_DEFAULT_MAX_PER_MIN
            ? { allowed: true }
            : { allowed: false, retryAfterMs: 1000 };
        },
      },
      uploadRateLimit: {
        check: () => {
          uploadCount += 1;
          return { allowed: true };
        },
      },
      restoreRateLimit: {
        check: () => {
          restoreCount += 1;
          return { allowed: true };
        },
      },
    });
    try {
      for (let i = 0; i < 128; i += 1) {
        const res = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
          body: '{}',
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assert.notEqual(
          res.status === 429 && res.body?.error === ERROR_CODES.DEVICE_RATE_LIMITED,
          true,
          `claim ${i + 1} must not be rate-limited by legacy`,
        );
        assert.equal(legacyCount, 0, `legacy must stay 0 after claim ${i + 1}`);
        assert.equal(uploadCount, 0, `upload must stay 0 after claim ${i + 1}`);
      }
      assert.equal(restoreCount, 128);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('1201st restore request is 429 device-rate-limited; three buckets isolated', async () => {
    let restoreCount = 0;
    let uploadCount = 0;
    let legacyCount = 0;
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-1201-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-1201');
    const { service, calls } = createMockRestoreService({
      claim: async () => ({ task: null }),
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      rateLimit: {
        check: () => {
          legacyCount += 1;
          return { allowed: true };
        },
      },
      uploadRateLimit: {
        check: () => {
          uploadCount += 1;
          return { allowed: true };
        },
      },
      restoreRateLimit: {
        check: () => {
          restoreCount += 1;
          if (restoreCount > RESTORE_DEFAULT_MAX_PER_MIN) {
            return { allowed: false, retryAfterMs: 45_000 };
          }
          return { allowed: true };
        },
      },
    });
    try {
      for (let i = 0; i < RESTORE_DEFAULT_MAX_PER_MIN; i += 1) {
        const res = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
          body: '{}',
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assert.notEqual(res.body?.error, ERROR_CODES.DEVICE_RATE_LIMITED);
      }
      const denied = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assertPublicError(denied, 429, ERROR_CODES.DEVICE_RATE_LIMITED);
      assertRetryAfterBounded(denied.headers);
      assert.equal(String(denied.headers['retry-after']), '30');
      assert.equal(legacyCount, 0);
      assert.equal(uploadCount, 0);
      assert.equal(restoreCount, RESTORE_DEFAULT_MAX_PER_MIN + 1);
      // Deny is pre-auth: the denied request must not add a claim call beyond the 1200 allows.
      assert.equal(calls.claim.length, RESTORE_DEFAULT_MAX_PER_MIN);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('restore limiter throw/thenable/illegal shape fail-closed 500 without auth/body/service', async () => {
    const shapes = [
      () => {
        throw new Error('limiter secret /Users/private/key.pem');
      },
      () => Promise.resolve({ allowed: true }),
      () => ({ then: (r) => r({ allowed: true }) }),
      () => null,
      () => ({ allowed: 'true' }),
      () => ({ allowed: 1 }),
      () => [],
      () => true,
    ];
    for (const check of shapes) {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-lim-shape-'));
      const registry = new DeviceRegistry({ dataDir });
      const auth = instrumentAuth(registry);
      const device = await enrollDevice(registry, 'rs-shape');
      const { service, calls } = createMockRestoreService();
      const fx = await startRestoreFixture({
        registry,
        restoreService: service,
        restoreRateLimit: { check },
      });
      try {
        const res = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
          body: JSON.stringify({ leak: '/Users/private/key.pem', token: device.token }),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assertPublicError(res, 500, ERROR_CODES.DEVICE_INTERNAL_ERROR);
        assert.equal(auth.count, 0, 'limiter fail-closed must not auth');
        assert.equal(calls.claim.length, 0, 'limiter fail-closed must not call service');
        assert.ok(!res.raw.includes('/Users/private'));
        assert.ok(!res.raw.includes(device.token));
      } finally {
        await fx.cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  });
});

// ===========================================================================
// C. Auth triad exact-one + auth-before-lookup/body
// ===========================================================================

describe('C6 restore C — auth triad + auth-before-side-effect (RED)', () => {
  it('missing/duplicate Authorization → device-token-invalid; lookup/body counters 0', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-auth-'));
    const registry = new DeviceRegistry({ dataDir });
    const auth = instrumentAuth(registry);
    const device = await enrollDevice(registry, 'rs-auth');
    const { service, calls } = createMockRestoreService();
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const missing = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: {
          'x-linke-device-id': device.deviceId,
          'x-linke-protocol-version': '2',
          'content-type': 'application/json',
        },
      });
      assertPublicError(missing, 401, ERROR_CODES.DEVICE_TOKEN_INVALID);
      assert.equal(auth.count, 0);
      assert.equal(calls.claim.length, 0);

      // Real duplicate Authorization via raw TLS.
      const body = '{}';
      const head = [
        'POST /agent/restore/tasks/claim HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        'X-Linke-Protocol-Version: 2',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      const dup = await rawTlsHttpExchange({
        port: fx.port,
        head,
        bodyParts: [body],
        endAfterBody: true,
        timeoutMs: 1500,
      });
      assert.equal(dup.kind, 'response');
      // Duplicate critical headers → device-request-invalid (or token-invalid); never success.
      assert.ok([400, 401].includes(dup.status));
      assert.ok(
        dup.body?.error === ERROR_CODES.DEVICE_REQUEST_INVALID
        || dup.body?.error === ERROR_CODES.DEVICE_TOKEN_INVALID,
      );
      assert.equal(calls.claim.length, 0);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('duplicate device-id or protocol → device-request-invalid / protocol-unsupported; service 0', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-dup-h-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-dup-h');
    const { service, calls } = createMockRestoreService();
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const body = '{}';
      const headDevice = [
        'POST /agent/restore/tasks/claim HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        `X-Linke-Device-Id: other-device`,
        'X-Linke-Protocol-Version: 2',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      const dupDev = await rawTlsHttpExchange({
        port: fx.port,
        head: headDevice,
        bodyParts: [body],
        endAfterBody: true,
        timeoutMs: 1500,
      });
      assert.equal(dupDev.kind, 'response');
      assertPublicError(
        { status: dupDev.status, body: dupDev.body },
        400,
        ERROR_CODES.DEVICE_REQUEST_INVALID,
      );

      const headProto = [
        'POST /agent/restore/tasks/claim HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        'X-Linke-Protocol-Version: 2',
        'X-Linke-Protocol-Version: 1',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      const dupProto = await rawTlsHttpExchange({
        port: fx.port,
        head: headProto,
        bodyParts: [body],
        endAfterBody: true,
        timeoutMs: 1500,
      });
      assert.equal(dupProto.kind, 'response');
      assert.ok([400, 426].includes(dupProto.status));
      assert.ok(
        dupProto.body?.error === ERROR_CODES.DEVICE_REQUEST_INVALID
        || dupProto.body?.error === ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED,
      );
      assert.equal(calls.claim.length, 0);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('authenticate failure: no service call / body read / existence leak on any restore route', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-authfail-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-authfail');
    // Real counter: incremented only when a body-bearing service method is entered
    // (post-auth body parse + service dispatch). Auth failure must keep this at 0.
    let bodyParseAttempts = 0;
    const { service, calls } = createMockRestoreService({
      claim: async () => {
        bodyParseAttempts += 1;
        throw new Error('should not run');
      },
      getTask: async () => {
        bodyParseAttempts += 1;
        throw new Error('should not run');
      },
      getChunk: async () => {
        bodyParseAttempts += 1;
        throw new Error('should not run');
      },
      updateProgress: async () => {
        bodyParseAttempts += 1;
        throw new Error('should not run');
      },
      acceptReceipt: async () => {
        bodyParseAttempts += 1;
        throw new Error('should not run');
      },
      acceptCleanup: async () => {
        bodyParseAttempts += 1;
        throw new Error('should not run');
      },
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      for (const [method, path] of RESTORE_PATHS) {
        const res = await fx.requestAgent(method, path, {
          body: method === 'GET'
            ? undefined
            : JSON.stringify({ fileIndex: 0, chunkIndex: 0, receivedBytes: 1, secret: 'x' }),
          headers: {
            authorization: 'Bearer totally-wrong-token-value-not-enrolled-xxx',
            'x-linke-device-id': device.deviceId,
            'x-linke-protocol-version': '2',
            'content-type': 'application/json',
          },
        });
        assert.ok([401, 403].includes(res.status), `${method} ${path} auth fail status`);
        assert.ok(
          res.body?.error === ERROR_CODES.DEVICE_TOKEN_INVALID
          || res.body?.error === ERROR_CODES.DEVICE_NOT_FOUND
          || res.body?.error === ERROR_CODES.DEVICE_REVOKED,
        );
        assert.ok(!res.raw.includes('secret'));
        assert.ok(!res.raw.includes(TASK_ID) || res.body.error !== undefined);
      }
      for (const m of COMPLETE_RESTORE_METHODS) {
        assert.equal(calls[m].length, 0, `${m} must stay 0 after auth fail`);
      }
      assert.equal(
        bodyParseAttempts,
        0,
        'auth failure must not parse body into any restore service method',
      );
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('cross-device all restore routes → unique restore-task-not-found; no existence leak', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-xdev-'));
    const registry = new DeviceRegistry({ dataDir });
    const deviceA = await enrollDevice(registry, 'device-a-rs');
    const deviceB = await enrollDevice(registry, 'device-b-rs');
    const { service, calls } = createMockRestoreService({
      getTask: async () => {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND);
      },
      getChunk: async () => {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND);
      },
      updateProgress: async () => {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND);
      },
      acceptReceipt: async () => {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND);
      },
      acceptCleanup: async () => {
        throw new LinkeError(ERROR_CODES.RESTORE_TASK_NOT_FOUND);
      },
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      // A authenticates but task belongs to B scope — service returns not-found;
      // routes must project only RESTORE_TASK_NOT_FOUND (never "belongs to other device").
      const routes = [
        ['GET', `/agent/restore/tasks/${TASK_ID}`],
        ['GET', `/agent/restore/tasks/${TASK_ID}/files/0/chunks/0`],
        ['POST', `/agent/restore/tasks/${TASK_ID}/progress`],
        ['POST', `/agent/restore/tasks/${TASK_ID}/receipts`],
        ['POST', `/agent/restore/tasks/${TASK_ID}/cleanup`],
      ];
      for (const [method, path] of routes) {
        const res = await fx.requestAgent(method, path, {
          body: method === 'GET'
            ? undefined
            : JSON.stringify(
              path.endsWith('/progress')
                ? { fileIndex: 0, chunkIndex: 0, receivedBytes: 1 }
                : path.endsWith('/receipts')
                  ? sampleReceipt({ deviceId: deviceA.deviceId })
                  : sampleCleanup({ deviceId: deviceA.deviceId }),
            ),
          headers: { ...authHeaders(deviceA), 'content-type': 'application/json' },
        });
        assertPublicError(res, 404, ERROR_CODES.RESTORE_TASK_NOT_FOUND);
        assert.ok(!res.raw.includes(deviceB.deviceId));
        assert.ok(!res.raw.toLowerCase().includes('other'));
        assert.ok(!res.raw.includes('belong'));
      }
      void calls;
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('authenticated deviceId is scope SoT even if header differs after successful auth remap', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-sot-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'canonical-device');
    const originalAuth = registry.authenticate.bind(registry);
    registry.authenticate = async (request) => {
      const out = await originalAuth(request);
      // Simulate SoT remap: header may be alias; return is storage scope.
      return { deviceId: 'canonical-device', protocolVersion: out.protocolVersion };
    };
    const { service, calls } = createMockRestoreService({
      claim: async () => ({ task: null }),
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const res = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: {
          authorization: `Bearer ${device.token}`,
          'x-linke-device-id': 'canonical-device',
          'x-linke-protocol-version': '2',
          'content-type': 'application/json',
        },
      });
      assert.equal(res.status, 200);
      assert.equal(calls.claim[0].deviceId, 'canonical-device');
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// D. Claim semantics
// ===========================================================================

describe('C6 restore D — claim semantics (RED)', () => {
  it('claim accepts empty body or {}; unknown keys → restore-task-invalid; never runTransfer', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-claim-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-claim');
    const { service, calls } = createMockRestoreService({
      claim: async () => ({ task: null }),
    });
    // Hostile: if routes called runTransfer it would throw via this stub (listener must not).
    let runTransferCalls = 0;
    service.runTransfer = async () => {
      runTransferCalls += 1;
      throw new Error('claim must not runTransfer');
    };
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const empty = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body, { task: null });
      assert.equal(runTransferCalls, 0);

      const omitBody = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        headers: {
          ...authHeaders(device),
          'content-length': '0',
        },
      });
      assert.equal(omitBody.status, 200);
      assert.deepEqual(omitBody.body, { task: null });

      const unknown = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: JSON.stringify({ extra: true }),
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assertPublicError(unknown, 400, ERROR_CODES.RESTORE_TASK_INVALID);
      // Invalid body after auth: service not called for invalid shape.
      // (two successful claims + zero for invalid)
      assert.equal(calls.claim.length, 2);
      assert.equal(runTransferCalls, 0);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('claim with global transfer full still 200; active upload conflict; no pending null', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-claim2-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-claim2');

    // Real live-transfer budget: fill all slots via createUploadLocks, then prove
    // claim still 200 (claim never runTransfer). Not a mock-only runTransferCalls=0 title.
    const locks = createUploadLocks({ maxGlobalTransfers: 1 });
    /** @type {(v?: unknown) => void} */
    let releaseSlot = () => {};
    const slotHeld = new Promise((resolve) => {
      releaseSlot = resolve;
    });
    let slotStarted = 0;
    const holdP = locks.runTransfer(async () => {
      slotStarted += 1;
      await slotHeld;
    });
    for (let turn = 0; turn < 20_000 && slotStarted < 1; turn += 1) {
      await new Promise((r) => setImmediate(r));
      await Promise.resolve();
    }
    assert.equal(slotStarted, 1, 'live-transfer slot must be held full');

    // Prove the slot is truly full: a second runTransfer must upload-backpressure.
    await assert.rejects(
      () => locks.runTransfer(async () => 'should-not-run'),
      (error) => {
        assert.ok(error instanceof LinkeError);
        assert.equal(error.code, ERROR_CODES.UPLOAD_BACKPRESSURE);
        return true;
      },
    );

    let mode = 'null';
    let runTransferCalls = 0;
    // Real createRestoreService shares the filled locks; claim must not touch runTransfer.
    const baseTaskStore = {
      claimNext: async () => {
        if (mode === 'conflict') {
          throw new LinkeError(ERROR_CODES.RESTORE_TASK_CONFLICT);
        }
        if (mode === 'active') {
          return {
            task: {
              taskId: TASK_ID,
              snapshotId: SNAPSHOT_ID,
              manifestDigest: DIGEST,
              relativeTarget: 'apps/demo',
              status: 'active',
              fileCount: 1,
              totalBytes: 12,
              chunkSize: CHUNK_SIZE,
              createdAt: '2026-07-23T12:00:00.000Z',
              claimedAt: '2026-07-23T12:00:01.000Z',
              cancelRequested: false,
            },
          };
        }
        return { task: null };
      },
      get: async () => ({ taskId: TASK_ID, status: 'active' }),
      updateProgress: async () => ({ ok: true, cancelRequested: false }),
      acceptReceipt: async () => ({
        ok: true,
        taskId: TASK_ID,
        status: 'completed',
        cleanupAuthorized: true,
        receiptId: '11111111-1111-4111-8111-111111111111',
      }),
      acceptCleanup: async () => ({
        ok: true,
        taskId: TASK_ID,
        status: 'cleaned',
        cleanupId: '22222222-2222-4222-8222-222222222222',
        cleanupAckAt: '2026-07-23T12:05:00.000Z',
      }),
      create: async () => ({ httpHint: 201, taskSummary: { taskId: TASK_ID } }),
      cancel: async () => ({ httpHint: 200, status: 'cancelled', cancelRequested: true }),
      hasActiveRestore: async () => false,
      buildTaskFilesPayload: async () => ({ files: [] }),
    };
    const service = createRestoreService({
      taskStore: baseTaskStore,
      locks: {
        runTransfer: async (fn) => {
          runTransferCalls += 1;
          return locks.runTransfer(fn);
        },
        runDevice: (id, fn) => locks.runDevice(id, fn),
      },
      storageReader: {
        readChunk: async () => {
          const body = Buffer.from('x');
          return {
            body,
            chunkOffset: 0,
            chunkSize: body.length,
            chunkSha256: createHash('sha256').update(body).digest('hex'),
          };
        },
      },
      findActiveUpload: async () => false,
    });
    let claimCalls = 0;
    // Explicit wrapper (not Proxy over Object.freeze): frozen service methods are
    // non-configurable/non-writable; a get-trap that returns a different claim
    // function violates ECMAScript Proxy invariants.
    const wrappedService = Object.freeze({
      ...service,
      claim: async (input) => {
        claimCalls += 1;
        return service.claim(input);
      },
    });

    const fx = await startRestoreFixture({
      registry,
      restoreService: wrappedService,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      // Global full is invisible to claim: still 200 with task null.
      mode = 'null';
      const noPending = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(noPending.status, 200);
      assert.deepEqual(noPending.body, { task: null });
      assert.equal(runTransferCalls, 0, 'claim must not invoke runTransfer when slots full');

      mode = 'active';
      const claimed = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(claimed.status, 200);
      assert.equal(claimed.body.task.status, 'active');
      assert.equal(claimed.body.task.taskId, TASK_ID);
      assertNoForbiddenKeys(claimed.body);
      assert.equal(runTransferCalls, 0, 'active claim must not runTransfer under full budget');

      mode = 'conflict';
      const conflict = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assertPublicError(conflict, 409, ERROR_CODES.RESTORE_TASK_CONFLICT);
      assert.equal(claimCalls, 3);
      assert.equal(runTransferCalls, 0, 'conflict claim must not runTransfer');
    } finally {
      releaseSlot();
      await holdP;
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// E. GET task + path rules + allowlist
// ===========================================================================

describe('C6 restore E — GET task files[].path (RED)', () => {
  it('GET task JSON must include files[].path; path forbidden in URL/header/query', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-task-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-task');
    const { service, calls } = createMockRestoreService();
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const res = await fx.requestAgent('GET', `/agent/restore/tasks/${TASK_ID}`, {
        headers: {
          ...authHeaders(device),
          // Hostile: path must never be accepted from headers.
          'x-linke-path': '/Users/secret/absolute/target',
          'x-restore-path': 'docs/readme.txt',
        },
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.files));
      assert.equal(res.body.files.length, 1);
      assert.equal(res.body.files[0].path, 'docs/readme.txt');
      assert.deepEqual(
        Object.keys(res.body.files[0]).sort(),
        ['chunkCount', 'fileIndex', 'path', 'sha256', 'size'],
      );
      assert.equal(typeof res.body.cancelRequested, 'boolean');
      assert.equal(typeof res.body.cleanupAuthorized, 'boolean');
      assert.equal(calls.getTask[0].path, undefined);
      assert.equal(calls.getTask[0].relativeTarget, undefined);
      assertNoForbiddenKeys(res.body);
      assert.ok(!res.raw.includes('/Users/secret'));

      // Query path must not route or leak into service.
      const q = await fx.requestAgent(
        'GET',
        `/agent/restore/tasks/${TASK_ID}?path=/Users/secret/abs`,
        { headers: authHeaders(device) },
      );
      // Either fixed 404 (strict path match) or same GET ignoring query — never echo abs path.
      if (q.status === 404) {
        assertPublicError(q, 404, ERROR_CODES.DEVICE_ROUTE_NOT_FOUND);
      } else {
        assert.equal(q.status, 200);
        assert.ok(!q.raw.includes('/Users/secret'));
      }
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('GET task allowlist strips absolute paths/stack/errno/token from hostile service payload', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-allow-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-allow');
    const { service } = createMockRestoreService({
      getTask: async () => ({
        taskId: TASK_ID,
        snapshotId: SNAPSHOT_ID,
        manifestDigest: DIGEST,
        relativeTarget: 'apps/demo',
        status: 'active',
        cancelRequested: false,
        cleanupAuthorized: false,
        fileCount: 1,
        totalBytes: 12,
        chunkSize: CHUNK_SIZE,
        files: [
          {
            fileIndex: 0,
            path: 'docs/readme.txt',
            size: 12,
            sha256: ZERO_SHA,
            chunkCount: 1,
          },
        ],
        // Hostile extras must be stripped by route projection.
        absolutePath: '/Users/secret/restore-root/apps/demo',
        stagingPath: '/Users/secret/.staging',
        stack: 'Error: boom\n    at Object.<anonymous>',
        errno: -2,
        token: device.token,
        dataDir: '/Users/secret/data',
      }),
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const res = await fx.requestAgent('GET', `/agent/restore/tasks/${TASK_ID}`, {
        headers: authHeaders(device),
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.files[0].path, 'docs/readme.txt');
      assertNoForbiddenKeys(res.body);
      assert.equal(res.body.absolutePath, undefined);
      assert.equal(res.body.stack, undefined);
      assert.equal(res.body.errno, undefined);
      assert.equal(res.body.token, undefined);
      assert.ok(!res.raw.includes('/Users/secret'));
      assert.ok(!res.raw.includes(device.token));
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// F. Chunk GET: indices, headers, backpressure, deadline, slot release
// ===========================================================================

describe('C6 restore F — chunk GET (RED)', () => {
  it('fileIndex/chunkIndex must be strict decimal safe integers; reject leading zeros/negatives', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-idx-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-idx');
    const { service, calls } = createMockRestoreService();
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const bad = [
        `/agent/restore/tasks/${TASK_ID}/files/01/chunks/0`,
        `/agent/restore/tasks/${TASK_ID}/files/0/chunks/01`,
        `/agent/restore/tasks/${TASK_ID}/files/-1/chunks/0`,
        `/agent/restore/tasks/${TASK_ID}/files/0/chunks/-1`,
        `/agent/restore/tasks/${TASK_ID}/files/1.5/chunks/0`,
        `/agent/restore/tasks/${TASK_ID}/files/0x1/chunks/0`,
        `/agent/restore/tasks/${TASK_ID}/files/9007199254740992/chunks/0`,
        `/agent/restore/tasks/${TASK_ID}/files/foo/chunks/0`,
      ];
      for (const path of bad) {
        const res = await fx.requestAgent('GET', path, { headers: authHeaders(device) });
        // Either route miss 404 or task-invalid 400 — never 200 success, never service with bad index.
        assert.ok([400, 404].includes(res.status), path);
        if (res.status === 400) {
          assertPublicError(res, 400, ERROR_CODES.RESTORE_TASK_INVALID);
        }
      }
      // Valid indices still work.
      const ok = await fx.requestAgent(
        'GET',
        `/agent/restore/tasks/${TASK_ID}/files/0/chunks/0`,
        { headers: authHeaders(device) },
      );
      assert.equal(ok.status, 200);
      assert.equal(calls.getChunk.length, 1);
      assert.equal(calls.getChunk[0].fileIndex, 0);
      assert.equal(calls.getChunk[0].chunkIndex, 0);
      // Path must never appear in chunk URL binding or service input.
      assert.equal(calls.getChunk[0].path, undefined);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('chunk RESTORE_BACKPRESSURE → 429 + Retry-After 1..30; no body leak', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-bp-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-bp');
    const { service } = createMockRestoreService({
      getChunk: async () => {
        throw new LinkeError(ERROR_CODES.RESTORE_BACKPRESSURE);
      },
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const res = await fx.requestAgent(
        'GET',
        `/agent/restore/tasks/${TASK_ID}/files/0/chunks/0`,
        { headers: authHeaders(device) },
      );
      assertPublicError(res, 429, ERROR_CODES.RESTORE_BACKPRESSURE);
      assertRetryAfterBounded(res.headers);
      assert.ok(!res.raw.includes('/Users/'));
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('chunk 120s total deadline + AbortSignal single-settle; timeout releases shared slot', async () => {
    const timers = createManualTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-chunk-dl-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-chunk-dl');
    /** @type {{ signal?: AbortSignal, released?: boolean }} */
    const probe = {};
    let settleCount = 0;
    const { service } = createMockRestoreService({
      getChunk: async (input) => {
        probe.signal = input.signal;
        assertLiveAbortSignal(input.signal, 'getChunk-deadline');
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            probe.released = true;
            // Slot release modeled as abort path; must not resolve success after settle.
            reject(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID));
          };
          if (input.signal.aborted) {
            onAbort();
            return;
          }
          input.signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
      timers,
    });
    try {
      const resultPromise = fx.requestAgent(
        'GET',
        `/agent/restore/tasks/${TASK_ID}/files/0/chunks/0`,
        { headers: authHeaders(device) },
      );
      await waitForTimerArmed(timers, { minPending: 1 });
      timers.advance(RESTORE_CHUNK_TOTAL_MS + 1);
      const res = await resultPromise;
      settleCount += 1;
      assert.equal(settleCount, 1);
      // Timeout settles unique request error; slot released via aborted signal.
      assert.ok([400, 408, 500].includes(res.status));
      assert.equal(typeof res.body?.error, 'string');
      assert.equal(probe.signal?.aborted, true, 'deadline must abort request signal');
      assert.equal(probe.released, true, 'timeout must release shared transfer slot');
      // Single-settle: no second writeHead after late service resolution.
      assert.equal(Object.keys(res.body).length, 1);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('chunk path must not be accepted via URL/header; only fileIndex/chunkIndex coordinates', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-nopath-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-nopath');
    const { service, calls } = createMockRestoreService();
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const res = await fx.requestAgent(
        'GET',
        `/agent/restore/tasks/${TASK_ID}/files/0/chunks/0`,
        {
          headers: {
            ...authHeaders(device),
            'x-linke-path': 'docs/readme.txt',
            'x-linke-file-path': '/Users/secret/docs/readme.txt',
          },
        },
      );
      assert.equal(res.status, 200);
      assert.equal(calls.getChunk[0].path, undefined);
      assert.equal(calls.getChunk[0].filePath, undefined);
      assert.ok(!res.raw.includes('/Users/secret'));
      // Response is binary — no path header echo.
      assert.equal(res.headers['x-linke-path'], undefined);
      assert.equal(res.headers['x-linke-file-path'], undefined);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// G. progress / receipts / cleanup
// ===========================================================================

describe('C6 restore G — progress/receipts/cleanup (RED)', () => {
  it('progress/receipts/cleanup: JSON 64KiB, auth-after-body order, 15s deadline, AbortSignal', async () => {
    const timers = createManualTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-json-'));
    const registry = new DeviceRegistry({ dataDir });
    const auth = instrumentAuth(registry);
    const device = await enrollDevice(registry, 'rs-json');
    const order = [];
    const originalAuth = registry.authenticate.bind(registry);
    registry.authenticate = async (req) => {
      order.push('auth');
      return originalAuth(req);
    };
    const { service, calls } = createMockRestoreService({
      updateProgress: async (input) => {
        order.push('service');
        assertLiveAbortSignal(input.signal, 'progress');
        return { ok: true, cancelRequested: false };
      },
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: {
        check: () => {
          order.push('limiter');
          return { allowed: true };
        },
      },
      timers,
    });
    try {
      order.length = 0;
      const ok = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/progress`,
        {
          body: JSON.stringify({ fileIndex: 0, chunkIndex: 0, receivedBytes: 4 }),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assert.equal(ok.status, 200);
      assert.ok(order.indexOf('limiter') < order.indexOf('auth'));
      assert.ok(order.indexOf('auth') < order.indexOf('service'));

      // Capture call count BEFORE oversize; service must not advance on oversize body.
      const progressBefore = calls.updateProgress.length;
      assert.equal(progressBefore, 1, 'baseline: successful progress called service once');

      // Oversize JSON after auth would be rejected; use raw size > 64KiB.
      auth.reset();
      const huge = 'x'.repeat(RESTORE_JSON_MAX_BYTES + 1);
      const over = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/progress`,
        {
          body: huge,
          headers: {
            ...authHeaders(device),
            'content-type': 'application/json',
          },
        },
      );
      assert.ok([400, 413].includes(over.status));
      assert.equal(typeof over.body?.error, 'string');
      // Body oversize after auth is allowed to auth; service must not receive parseable progress.
      assert.equal(
        calls.updateProgress.length,
        progressBefore,
        'oversize JSON must not call updateProgress',
      );

      // 15s total deadline single-settle.
      // Frozen design §18: small JSON body timeout → device-request-invalid (not loosened).
      const hanging = createMockRestoreService({
        updateProgress: async (input) => new Promise(() => {
          assertLiveAbortSignal(input.signal, 'progress-hang');
        }),
      });
      await fx.cleanup();
      const fx2 = await startRestoreFixture({
        registry,
        restoreService: hanging.service,
        restoreRateLimit: { check: () => ({ allowed: true }) },
        timers,
      });
      try {
        const p = fx2.requestAgent(
          'POST',
          `/agent/restore/tasks/${TASK_ID}/progress`,
          {
            body: JSON.stringify({ fileIndex: 0, chunkIndex: 0, receivedBytes: 1 }),
            headers: { ...authHeaders(device), 'content-type': 'application/json' },
          },
        );
        await waitForTimerArmed(timers, { minPending: 1 });
        timers.advance(RESTORE_JSON_TOTAL_MS + 1);
        const timed = await p;
        assert.equal(timed.status, 400);
        assert.deepEqual(timed.body, { error: ERROR_CODES.DEVICE_REQUEST_INVALID });
      } finally {
        await fx2.cleanup();
      }
    } finally {
      // fx already cleaned if we reached fx2; guard double-clean.
      try {
        await fx.cleanup();
      } catch {
        // ignore
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('progress rewind → restore-task-invalid (P2-5); unknown keys invalid', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-prog-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-prog');
    const { service } = createMockRestoreService({
      updateProgress: async (input) => {
        if (input?.receivedBytes === 5) {
          throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
        }
        if (input && Object.prototype.hasOwnProperty.call(input, 'extra')) {
          throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
        }
        return { ok: true, cancelRequested: false };
      },
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      // Route-level unknown key rejection preferred; service also fail-closes.
      const unknown = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/progress`,
        {
          body: JSON.stringify({
            fileIndex: 0,
            chunkIndex: 0,
            receivedBytes: 10,
            extra: true,
          }),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assertPublicError(unknown, 400, ERROR_CODES.RESTORE_TASK_INVALID);

      const rewind = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/progress`,
        {
          body: JSON.stringify({ fileIndex: 0, chunkIndex: 0, receivedBytes: 5 }),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assertPublicError(rewind, 400, ERROR_CODES.RESTORE_TASK_INVALID);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('receipt ACK: cleanupAuthorized true and status != cleaned; conflict 409', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-rcpt-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-rcpt');
    let mode = 'ok';
    const { service } = createMockRestoreService({
      acceptReceipt: async () => {
        if (mode === 'conflict') {
          throw new LinkeError(ERROR_CODES.RESTORE_TASK_CONFLICT);
        }
        return {
          ok: true,
          taskId: TASK_ID,
          status: 'completed',
          cleanupAuthorized: true,
          receiptId: '11111111-1111-4111-8111-111111111111',
        };
      },
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const res = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/receipts`,
        {
          body: JSON.stringify(sampleReceipt({ deviceId: device.deviceId })),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.cleanupAuthorized, true);
      assert.notEqual(res.body.status, 'cleaned');
      assert.equal(res.body.status, 'completed');
      assertNoForbiddenKeys(res.body);

      mode = 'conflict';
      const conflict = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/receipts`,
        {
          body: JSON.stringify(sampleReceipt({
            deviceId: device.deviceId,
            receiptId: '33333333-3333-4333-8333-333333333333',
          })),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assertPublicError(conflict, 409, ERROR_CODES.RESTORE_TASK_CONFLICT);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('cleanup truth table / conflict / RESTORE_CLEANUP_FAILED; response allowlist', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-clean-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-clean');
    /** @type {'ok'|'conflict'|'failed'|'cancelled'} */
    let mode = 'ok';
    const { service } = createMockRestoreService({
      acceptCleanup: async (input) => {
        if (mode === 'conflict') {
          throw new LinkeError(ERROR_CODES.RESTORE_TASK_CONFLICT);
        }
        if (mode === 'failed') {
          throw new LinkeError(ERROR_CODES.RESTORE_CLEANUP_FAILED);
        }
        if (mode === 'cancelled') {
          return {
            ok: true,
            taskId: TASK_ID,
            status: 'cancelled',
            cleanupId: input?.cleanupReceipt?.cleanupId
              ?? input?.cleanupId
              ?? '22222222-2222-4222-8222-222222222222',
            cleanupAckAt: '2026-07-23T12:06:00.000Z',
          };
        }
        return {
          ok: true,
          taskId: TASK_ID,
          status: 'cleaned',
          cleanupId: '22222222-2222-4222-8222-222222222222',
          cleanupAckAt: '2026-07-23T12:05:00.000Z',
          // Hostile extras
          absolutePath: '/Users/secret/anchor',
          stack: 'Error',
          errno: -1,
          token: device.token,
        };
      },
    });
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      mode = 'ok';
      const ok = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/cleanup`,
        {
          body: JSON.stringify(sampleCleanup({ deviceId: device.deviceId })),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true);
      assert.equal(ok.body.status, 'cleaned');
      assert.equal(ok.body.cleanupId, '22222222-2222-4222-8222-222222222222');
      assert.equal(typeof ok.body.cleanupAckAt, 'string');
      assertNoForbiddenKeys(ok.body);
      assert.equal(ok.body.absolutePath, undefined);
      assert.ok(!ok.raw.includes(device.token));

      mode = 'cancelled';
      const cancelled = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/cleanup`,
        {
          body: JSON.stringify(sampleCleanup({
            deviceId: device.deviceId,
            outcome: 'cancelled',
            receiptId: null,
            cleanupId: '44444444-4444-4444-8444-444444444444',
          })),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, 'cancelled');

      mode = 'conflict';
      const conflict = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/cleanup`,
        {
          body: JSON.stringify(sampleCleanup({ deviceId: device.deviceId })),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assertPublicError(conflict, 409, ERROR_CODES.RESTORE_TASK_CONFLICT);

      mode = 'failed';
      const failed = await fx.requestAgent(
        'POST',
        `/agent/restore/tasks/${TASK_ID}/cleanup`,
        {
          body: JSON.stringify(sampleCleanup({ deviceId: device.deviceId })),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        },
      );
      assertPublicError(failed, 500, ERROR_CODES.RESTORE_CLEANUP_FAILED);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// H. Management create coexistence note (agent-side claim vs createTask probe)
// ===========================================================================

describe('C6 restore H — claim never runTransfer; createTask not on agent claim path (RED)', () => {
  it('agent claim path never calls createTask or runTransfer', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-no-xfer-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'rs-no-xfer');
    const { service, calls } = createMockRestoreService({
      claim: async () => ({ task: null }),
    });
    let runTransfer = 0;
    service.runTransfer = async (fn) => {
      runTransfer += 1;
      return fn();
    };
    const fx = await startRestoreFixture({
      registry,
      restoreService: service,
      restoreRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const res = await fx.requestAgent('POST', '/agent/restore/tasks/claim', {
        body: '{}',
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(res.status, 200);
      assert.equal(calls.claim.length, 1);
      assert.equal(calls.createTask.length, 0);
      assert.equal(runTransfer, 0);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
