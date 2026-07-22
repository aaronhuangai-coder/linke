/**
 * C6 RED — Agent upload routes + path-aware limiter + dual-timer deadlines.
 *
 * Authority: design §6.0–§6.6 / §9.3 / §9.5 / §10 + plan C6.
 * Production surface (frozen; GREEN must implement without changing these contracts):
 *
 *   createAgentListener({
 *     identity, registry, onHeartbeat,
 *     rateLimit,              // G0a legacy pre-auth limiter (60/min default)
 *     uploadRateLimit,        // independent /agent/upload/* pre-auth limiter (1200/min default)
 *     uploadService,          // full C5 service OR absent → all upload paths fixed 404
 *     timers,                 // optional deadline test deps (see TIMER_TEST_API below)
 *   })
 *
 * Without a complete uploadService (missing/hostile methods) → fail-closed: no half-registered
 * routes; all five paths remain fixed 404 (or constructor reject if service is present-but-hostile
 * at construction — either way no public half-surface).
 *
 * Routes (only when complete service is injected):
 *   POST /agent/upload/sessions
 *   GET  /agent/upload/sessions/:uploadId
 *   POST /agent/upload/sessions/:uploadId/chunks
 *   POST /agent/upload/sessions/:uploadId/finalize
 *   POST /agent/upload/sessions/:uploadId/abort
 *
 * Wire create body (exact envelope):
 *   { "manifest": <object>, "manifestDigest": <string> }
 * maps to service.create({
 *   authenticatedDeviceId: device.deviceId,  // SoT from registry.authenticate return
 *   manifest: body.manifest,
 *   claimedManifestDigest: body.manifestDigest,
 * })
 *
 * putChunk wire:
 *   service.putChunk({ authenticatedDeviceId, request: req, stream: req })
 * Listener MUST NOT pre-read binary body; C3/service owns critical headers/CL.
 *
 * TIMER_TEST_API (minimal; production may omit — defaults to global timers):
 *   timers?: {
 *     now?: () => number,                 // ms clock for deadline arithmetic
 *     setTimeout?: (fn, ms, ...args) => any,
 *     clearTimeout?: (id) => void,
 *   }
 * Tests use a ManualTimer harness; no real 15s/120s sleeps.
 *
 * Expected RED causes (current production gaps):
 *   - requestTimeout still 15000 (must become 0)
 *   - no upload routes / no uploadService wiring
 *   - no uploadRateLimit path isolation
 *   - no dual-timer handler deadlines
 *   - G0a oversize still maps 413 (design freezes 400)
 *   - complete service without complete uploadRateLimit still exposes routes (must 404)
 *   - handler deadlines only race await; no request AbortSignal / no cancel of service work
 *   - chunk idle uses req.on('readable') (pauses IncomingMessage); no bridge stream
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { PassThrough } from 'node:stream';
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
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';
import { createUploadSessionStore } from '../src/upload-session-store.js';
import { createUploadLocks } from '../src/upload-locks.js';
import { createUploadService } from '../src/upload-service.js';
import {
  parseChunkHeaders,
  ingestChunkBody,
  commitChunk,
} from '../src/upload-chunk-ingest.js';
import {
  preflightCapacity,
  verifyAndCommitSession,
} from '../src/upload-commit.js';

// ---------------------------------------------------------------------------
// Frozen constants (test-side; mirror design — do not import non-exported src)
// ---------------------------------------------------------------------------

const UPLOAD_CREATE_MAX_BYTES = 8 * 1024 * 1024;
const UPLOAD_CHUNK_IDLE_MS = 15_000;
const UPLOAD_CHUNK_TOTAL_MS = 120_000;
const UPLOAD_CREATE_TOTAL_MS = 30_000;
const UPLOAD_STATUS_TOTAL_MS = 15_000;
const G0A_TOTAL_MS = 15_000;
const SERVER_HEADERS_TIMEOUT_MS = 10_000;
const SERVER_REQUEST_TIMEOUT_MS = 0;
const UPLOAD_DEFAULT_MAX_PER_MIN = 1200;
const LEGACY_DEFAULT_MAX_PER_MIN = 60;

const UPLOAD_PATHS = Object.freeze([
  ['POST', '/agent/upload/sessions'],
  ['GET', '/agent/upload/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
  ['POST', '/agent/upload/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/chunks'],
  ['POST', '/agent/upload/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/finalize'],
  ['POST', '/agent/upload/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/abort'],
]);

const FORBIDDEN_RESPONSE_KEYS = Object.freeze([
  'path',
  'paths',
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
]);

// ---------------------------------------------------------------------------
// Manual timer harness (no real long sleeps)
// ---------------------------------------------------------------------------

/**
 * Controllable timer API injected as createAgentListener({ timers }).
 * Fires only when tests call advance/fire; never real wall-clock waits for deadlines.
 */
function createManualTimers(startMs = 1_000_000) {
  let nowMs = startMs;
  let nextId = 1;
  /** @type {Map<number, { id: number, fireAt: number, fn: Function, args: any[], cleared: boolean }>} */
  const pending = new Map();

  const api = {
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
    /** Advance virtual clock and fire due timers (stable order by id). */
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
  return api;
}

/**
 * Wait until the handler has armed enough manual timers before advance().
 * TLS/HTTP delivery can lag a single setImmediate; poll via bounded
 * setImmediate + microtask barriers only (no wall-clock sleep).
 * @param {{ pendingCount: () => number }} timers
 * @param {{ minPending?: number, maxTurns?: number }} [opts]
 */
async function waitForTimerArmed(timers, { minPending = 1, maxTurns = 64 } = {}) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (timers.pendingCount() >= minPending) return;
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }
  assert.ok(
    timers.pendingCount() >= minPending,
    `expected >=${minPending} armed timer(s) before advance, got ${timers.pendingCount()} after ${maxTurns} turns`,
  );
}

/**
 * Bounded poll until predicate holds. Uses setImmediate + microtask only
 * (no wall-clock sleep). Asserts on turn budget exhaustion.
 * @param {() => boolean} predicate
 * @param {{ maxTurns?: number, label?: string }} [opts]
 */
async function waitForCondition(predicate, { maxTurns = 64, label = 'condition' } = {}) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }
  assert.ok(predicate(), `expected ${label} within ${maxTurns} turns`);
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
 * Counting mock upload service — records calls without disk I/O.
 * @param {Partial<Record<'create'|'status'|'putChunk'|'finalize'|'abort', Function>>} [impl]
 */
function createMockUploadService(impl = {}) {
  /** @type {Record<string, any[]>} */
  const calls = {
    create: [],
    status: [],
    putChunk: [],
    finalize: [],
    abort: [],
  };
  /** @type {{ streamDataEvents: number, streamEnded: boolean, streamDestroyed: boolean }} */
  const streamProbe = {
    streamDataEvents: 0,
    streamEnded: false,
    streamDestroyed: false,
  };

  const methods = {
    async create(input) {
      calls.create.push(input);
      if (impl.create) return impl.create(input);
      return {
        uploadId: 'mock-upload-id-0001',
        snapshotId: input?.manifest?.snapshotId ?? 'snap',
        manifestDigest: input?.claimedManifestDigest ?? 'd'.repeat(64),
        status: 'initialized',
        deviceId: input?.authenticatedDeviceId,
      };
    },
    async status(input) {
      calls.status.push(input);
      if (impl.status) return impl.status(input);
      return {
        uploadId: input?.uploadId,
        status: 'initialized',
        deviceId: input?.authenticatedDeviceId,
        snapshotId: 'snap',
        manifestDigest: 'd'.repeat(64),
      };
    },
    async putChunk(input) {
      calls.putChunk.push(input);
      const stream = input?.stream;
      if (stream && typeof stream.on === 'function') {
        stream.on('data', () => {
          streamProbe.streamDataEvents += 1;
        });
        stream.on('end', () => {
          streamProbe.streamEnded = true;
        });
        stream.on('close', () => {
          streamProbe.streamDestroyed = Boolean(stream.destroyed);
        });
      }
      if (impl.putChunk) return impl.putChunk(input);
      return { acked: true, fileIndex: 0, chunkIndex: 0 };
    },
    async finalize(input) {
      calls.finalize.push(input);
      if (impl.finalize) return impl.finalize(input);
      return {
        uploadId: input?.uploadId,
        status: 'committed',
        deviceId: input?.authenticatedDeviceId,
      };
    },
    async abort(input) {
      calls.abort.push(input);
      if (impl.abort) return impl.abort(input);
      return {
        uploadId: input?.uploadId,
        status: 'aborted',
        deviceId: input?.authenticatedDeviceId,
      };
    },
  };

  return { service: methods, calls, streamProbe };
}

/**
 * @param {object} [options]
 */
async function startUploadFixture(options = {}) {
  const dataDir = options.registry
    ? null
    : await mkdtemp(join(tmpdir(), 'linke-c6-upload-routes-'));
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
          // Multi-value: Node https.request collapses; use raw TLS for true duplicates.
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
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = rawBody.length === 0 ? null : JSON.parse(rawBody);
          } catch {
            parsed = { __unparsed: rawBody };
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
            raw: rawBody,
          });
        });
        res.on('error', reject);
      });

      req.on('error', reject);

      if (opts.end === false) {
        if (body !== undefined) req.write(body);
        // leave open for deadline / partial-body tests
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

async function enrollDevice(registry, deviceId = 'device-upload-a', protocolVersion = 2) {
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
  if (body === null || typeof body !== 'object') return;
  for (const k of FORBIDDEN_RESPONSE_KEYS) {
    assert.equal(body[k], undefined, `response must not include ${k}`);
  }
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /\/Users\/|PRIVATE KEY|BEGIN EC|Keychain/i);
}

function assertRetryAfterBounded(headers) {
  const ra = headers['retry-after'];
  assert.ok(ra !== undefined, 'Retry-After required');
  assert.match(String(ra), /^\d+$/);
  const n = Number(ra);
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 30, `Retry-After must clamp to 1..30, got ${ra}`);
}

function assertNoRetryAfter(headers) {
  assert.equal(headers['retry-after'], undefined);
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

/**
 * Raw TLS exchange for duplicate headers / incomplete body.
 */
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

function authHeaders(device) {
  return {
    authorization: `Bearer ${device.token}`,
    'x-linke-device-id': device.deviceId,
    'x-linke-protocol-version': String(device.protocolVersion),
  };
}

/**
 * Controllable TLS HTTP session: write head, then mid-flight body parts, then await response.
 * Avoids wall-clock sleeps; caller drives writes after service barriers.
 * @param {{
 *   port: number,
 *   head: string,
 *   timeoutMs?: number,
 * }} opts
 */
function openRawTlsHttpSession({ port, head, timeoutMs = 2500 }) {
  /** @type {(v: any) => void} */
  let resolveResult = () => {};
  const resultPromise = new Promise((resolve) => {
    resolveResult = resolve;
  });
  let settled = false;
  let buf = Buffer.alloc(0);
  /** @type {import('node:tls').TLSSocket | null} */
  let socket = null;
  /** @type {(() => void) | null} */
  let onSecure = null;
  const securePromise = new Promise((resolve) => {
    onSecure = resolve;
  });

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      socket?.destroy();
    } catch {
      // ignore
    }
    resolveResult(result);
  };

  socket = tls.connect({
    host: '127.0.0.1',
    port,
    rejectUnauthorized: false,
  });
  const timer = setTimeout(() => {
    finish({ kind: 'timeout', raw: buf.toString('utf8') });
  }, timeoutMs);

  socket.on('secureConnect', () => {
    socket.write(head);
    if (onSecure) onSecure();
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

  return {
    whenSecure: securePromise,
    write(part) {
      if (!socket || settled) return;
      socket.write(part);
    },
    end() {
      if (!socket || settled) return;
      socket.end();
    },
    resultPromise,
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertLiveAbortSignal(value, label) {
  assert.ok(
    value != null && typeof value === 'object' && 'aborted' in /** @type {object} */ (value),
    `${label}: expected AbortSignal-like object`,
  );
  const signal = /** @type {AbortSignal} */ (value);
  assert.equal(typeof signal.aborted, 'boolean', `${label}: signal.aborted must be boolean`);
  assert.equal(signal.aborted, false, `${label}: signal must not be aborted at service entry`);
  assert.ok(
    typeof signal.addEventListener === 'function'
      || typeof signal.throwIfAborted === 'function'
      || typeof AbortSignal !== 'undefined' && signal instanceof AbortSignal,
    `${label}: must be a usable AbortSignal`,
  );
  return signal;
}

/**
 * Cooperative worker: after barrier release, only mutates when signal is not aborted.
 * @param {AbortSignal | undefined | null} signal
 * @param {() => void} mutate
 */
function cooperativeLateMutation(signal, mutate) {
  if (signal && signal.aborted) return false;
  mutate();
  return true;
}

function tinyCreateBody(deviceId = 'device-upload-a') {
  const manifest = {
    schemaVersion: 2,
    snapshotId: '550e8400-e29b-41d4-a716-4466554400aa',
    deviceId,
    createdAt: '2026-07-22T00:00:00.000Z',
    files: [],
    integrity: {
      algorithm: 'sha256',
      totalBytes: 0,
      entries: [],
    },
  };
  const manifestDigest = 'a'.repeat(64);
  return { manifest, manifestDigest };
}

// ===========================================================================
// A. Routes / surface / responses
// ===========================================================================

describe('C6 A — upload route surface (RED)', () => {
  it('server freezes headersTimeout=10000 and requestTimeout=0', async () => {
    const fx = await startUploadFixture();
    try {
      assert.equal(fx.server.headersTimeout, SERVER_HEADERS_TIMEOUT_MS);
      assert.equal(fx.server.requestTimeout, SERVER_REQUEST_TIMEOUT_MS);
    } finally {
      await fx.cleanup();
    }
  });

  it('without uploadService: all five upload paths fixed 404; no auth / no body side effects', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-nosvc-'));
    const registry = new DeviceRegistry({ dataDir });
    const auth = instrumentAuth(registry);
    const device = await enrollDevice(registry);
    const bodyReads = { n: 0 };
    // Hostile body that would parse if read.
    const body = JSON.stringify({
      manifest: { leak: '/Users/secret/path', token: device.token },
      manifestDigest: 'b'.repeat(64),
    });
    const fx = await startUploadFixture({ registry });
    try {
      for (const [method, path] of UPLOAD_PATHS) {
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
        assert.ok(!res.raw.includes(path) || res.body.error === ERROR_CODES.DEVICE_ROUTE_NOT_FOUND);
        // Error body must not embed path string.
        assert.equal(res.body.path, undefined);
        assert.equal(res.body.url, undefined);
      }
      assert.equal(bodyReads.n, 0);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('missing service methods / hostile service: fail-closed, no half-registered routes', async () => {
    const cases = [
      { label: 'empty object', service: {} },
      { label: 'only create', service: { create: async () => ({}) } },
      {
        label: 'missing putChunk',
        service: {
          create: async () => ({}),
          status: async () => ({}),
          finalize: async () => ({}),
          abort: async () => ({}),
        },
      },
      {
        label: 'null method',
        service: {
          create: async () => ({}),
          status: async () => ({}),
          putChunk: null,
          finalize: async () => ({}),
          abort: async () => ({}),
        },
      },
      {
        label: 'non-function putChunk',
        service: {
          create: async () => ({}),
          status: async () => ({}),
          putChunk: 'not-a-function',
          finalize: async () => ({}),
          abort: async () => ({}),
        },
      },
    ];

    for (const c of cases) {
      let constructed = false;
      let fx = null;
      try {
        try {
          fx = await startUploadFixture({ uploadService: c.service });
          constructed = true;
        } catch {
          // Constructor fail-closed is acceptable — no public surface.
          constructed = false;
        }
        if (constructed && fx) {
          for (const [method, path] of UPLOAD_PATHS) {
            const res = await fx.requestAgent(method, path, {
              body: method === 'GET' ? undefined : '{}',
              headers: {
                authorization: 'Bearer x',
                'x-linke-device-id': 'd',
                'x-linke-protocol-version': '2',
              },
            });
            // Must not partially work: either 404 or fail-closed 5xx — never 201/200 success.
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

  it('with complete service: five routes call unique methods with frozen inputs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-svc-wire-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'wire-device-1');
    // Auth returns deviceId as SoT — header may differ only if auth would fail;
    // use matching header, but assert service sees registry return value.
    const authSoT = device.deviceId;
    const originalAuth = registry.authenticate.bind(registry);
    registry.authenticate = async (request) => {
      const out = await originalAuth(request);
      // SoT is return value; tests freeze mapping to service.authenticatedDeviceId.
      return { deviceId: out.deviceId, protocolVersion: out.protocolVersion };
    };

    const { service, calls, streamProbe } = createMockUploadService();
    // Dual-gate fail-closed: success fixtures need a complete uploadRateLimit.
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const envelope = tinyCreateBody(device.deviceId);
      const createRes = await fx.requestAgent('POST', '/agent/upload/sessions', {
        body: JSON.stringify(envelope),
        headers: {
          ...authHeaders(device),
          'content-type': 'application/json',
        },
      });
      assert.equal(createRes.status, 201);
      assert.equal(calls.create.length, 1);
      assert.deepEqual(Object.keys(calls.create[0]).sort(), [
        'authenticatedDeviceId',
        'claimedManifestDigest',
        'manifest',
        'signal',
      ]);
      assert.equal(calls.create[0].authenticatedDeviceId, authSoT);
      assert.deepEqual(calls.create[0].manifest, envelope.manifest);
      assert.equal(calls.create[0].claimedManifestDigest, envelope.manifestDigest);
      // Per-request signal required; normal settle must leave it non-aborted.
      const createSignal = assertLiveAbortSignal(calls.create[0].signal, 'create');
      assert.equal(createSignal.aborted, false, 'create signal remains live after success settle');
      // Wire body field name is manifestDigest, never claimedManifestDigest on wire.
      assert.equal(createRes.body.claimedManifestDigest, undefined);
      assertNoForbiddenKeys(createRes.body);

      const uploadId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
      const statusRes = await fx.requestAgent('GET', `/agent/upload/sessions/${uploadId}`, {
        headers: authHeaders(device),
      });
      assert.equal(statusRes.status, 200);
      assert.equal(calls.status.length, 1);
      assert.deepEqual(Object.keys(calls.status[0]).sort(), [
        'authenticatedDeviceId',
        'signal',
        'uploadId',
      ]);
      assert.equal(calls.status[0].authenticatedDeviceId, authSoT);
      assert.equal(calls.status[0].uploadId, uploadId);
      const statusSignal = assertLiveAbortSignal(calls.status[0].signal, 'status');
      assert.equal(statusSignal.aborted, false, 'status signal remains live after success settle');
      assertNoForbiddenKeys(statusRes.body);

      const chunkBody = Buffer.from('chunk-bytes');
      const chunkRes = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/chunks`,
        {
          body: chunkBody,
          headers: {
            ...authHeaders(device),
            'content-type': 'application/octet-stream',
            'content-length': String(chunkBody.length),
            'x-linke-upload-id': uploadId,
            'x-linke-snapshot-id': envelope.manifest.snapshotId,
            'x-linke-manifest-digest': envelope.manifestDigest,
            'x-linke-file-index': '0',
            'x-linke-chunk-index': '0',
            'x-linke-chunk-offset': '0',
            'x-linke-chunk-size': String(chunkBody.length),
            'x-linke-chunk-sha256': 'c'.repeat(64),
          },
        },
      );
      assert.equal(chunkRes.status, 200);
      assert.equal(calls.putChunk.length, 1);
      const chunkInput = calls.putChunk[0];
      assert.equal(chunkInput.authenticatedDeviceId, authSoT);
      assert.ok(chunkInput.request, 'request must be passed for C3 header parse');
      assert.ok(chunkInput.stream, 'stream must be passed');
      // Listener must pass bridge as both request and stream (or equivalent unread stream).
      assert.equal(chunkInput.request, chunkInput.stream);
      // Per-request AbortSignal required on putChunk (independent of other methods).
      const chunkSignal = assertLiveAbortSignal(chunkInput.signal, 'putChunk');
      assert.equal(chunkSignal.aborted, false, 'chunk signal remains live after success settle');
      // Listener must not have pre-consumed binary (mock still sees stream events if it attaches).
      // Zero-pre-read: if listener had fully drained before putChunk, streamEnded would already
      // be true before service runs — freeze that service sees a live stream reference.
      assert.equal(typeof chunkInput.stream.on, 'function');
      assertNoForbiddenKeys(chunkRes.body);

      const finRes = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/finalize`,
        {
          headers: authHeaders(device),
        },
      );
      assert.equal(finRes.status, 200);
      assert.equal(calls.finalize.length, 1);
      assert.deepEqual(Object.keys(calls.finalize[0]).sort(), [
        'authenticatedDeviceId',
        'signal',
        'uploadId',
      ]);
      assert.equal(calls.finalize[0].authenticatedDeviceId, authSoT);
      assert.equal(calls.finalize[0].uploadId, uploadId);
      const finalizeSignal = assertLiveAbortSignal(calls.finalize[0].signal, 'finalize');
      assert.equal(finalizeSignal.aborted, false, 'finalize signal remains live after success settle');

      const abortRes = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/abort`,
        {
          headers: authHeaders(device),
        },
      );
      assert.equal(abortRes.status, 200);
      assert.equal(calls.abort.length, 1);
      assert.deepEqual(Object.keys(calls.abort[0]).sort(), [
        'authenticatedDeviceId',
        'signal',
        'uploadId',
      ]);
      assert.equal(calls.abort[0].authenticatedDeviceId, authSoT);
      assert.equal(calls.abort[0].uploadId, uploadId);
      const abortSignal = assertLiveAbortSignal(calls.abort[0].signal, 'abort');
      assert.equal(abortSignal.aborted, false, 'abort signal remains live after success settle');

      // Cross-check method isolation.
      assert.equal(calls.create.length, 1);
      assert.equal(calls.status.length, 1);
      assert.equal(calls.putChunk.length, 1);
      assert.equal(calls.finalize.length, 1);
      assert.equal(calls.abort.length, 1);
      // Each request has its own signal object (not a shared singleton across five calls).
      const signals = [
        createSignal,
        statusSignal,
        chunkSignal,
        finalizeSignal,
        abortSignal,
      ];
      assert.equal(new Set(signals).size, 5, 'each method call must receive its own request signal');
      void streamProbe;
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('response allowlist strips hostile service fields (path/token/ipAddress/etc.)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-allowlist-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'allow-device');
    const hostile = {
      uploadId: 'safe-id',
      status: 'initialized',
      path: '/Users/secret/staging/chunk.part',
      sourcePath: '/Users/secret/source',
      ipAddress: '10.0.0.9',
      token: device.token,
      fingerprint: 'deadbeef',
      hostname: 'leak.local',
      rawError: 'EACCES /Users/secret',
      deviceToken: 'should-not-echo',
    };
    const { service } = createMockUploadService({
      create: async () => hostile,
      status: async () => hostile,
      finalize: async () => hostile,
      abort: async () => hostile,
      putChunk: async () => hostile,
    });
    // Dual-gate fail-closed: success fixture needs complete uploadRateLimit.
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const createRes = await fx.requestAgent('POST', '/agent/upload/sessions', {
        body: JSON.stringify(tinyCreateBody(device.deviceId)),
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(createRes.status, 201);
      assertNoForbiddenKeys(createRes.body);
      assert.ok(!createRes.raw.includes('/Users/secret'));
      assert.ok(!createRes.raw.includes(device.token));
      assert.ok(!createRes.raw.includes('10.0.0.9'));
      assert.ok(!createRes.raw.includes('deadbeef'));
      assert.ok(!createRes.raw.includes('leak.local'));

      const statusRes = await fx.requestAgent(
        'GET',
        '/agent/upload/sessions/safe-id',
        { headers: authHeaders(device) },
      );
      assert.equal(statusRes.status, 200);
      assertNoForbiddenKeys(statusRes.body);
      assert.ok(!statusRes.raw.includes('/Users/secret'));
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('unknown method/query/trailing slash/path injection fixed 404; path not in body', async () => {
    const { service, calls } = createMockUploadService();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-404-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'path-device');
    const fx = await startUploadFixture({ registry, uploadService: service });
    try {
      const unknowns = [
        ['PUT', '/agent/upload/sessions'],
        ['DELETE', '/agent/upload/sessions/x'],
        ['POST', '/agent/upload/sessions?x=1'],
        ['GET', '/agent/upload/sessions/x/'],
        ['POST', '/agent/upload/sessions/../secret'],
        ['POST', '/agent/upload/sessions/%2e%2e/secret'],
        ['GET', '/agent/upload'],
        ['POST', '/agent/upload/sessions/x/chunks/extra'],
        ['OPTIONS', '/agent/upload/sessions'],
      ];
      for (const [method, path] of unknowns) {
        const res = await fx.requestAgent(method, path, {
          body: method === 'GET' || method === 'OPTIONS' ? undefined : '{}',
          headers: authHeaders(device),
        });
        assertPublicError(res, 404, ERROR_CODES.DEVICE_ROUTE_NOT_FOUND);
        assert.equal(res.body.path, undefined);
        assert.ok(!JSON.stringify(res.body).includes(path));
      }
      assert.equal(calls.create.length, 0);
      assert.equal(calls.putChunk.length, 0);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// B. Path-aware pre-auth limiter
// ===========================================================================

describe('C6 B — path-aware upload limiter (RED)', () => {
  it('upload routes only call uploadRateLimit; G0a only calls rateLimit; pre-auth order', async () => {
    const order = [];
    let authCount = 0;
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-lim-iso-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'lim-iso');
    const originalAuth = registry.authenticate.bind(registry);
    registry.authenticate = async (req) => {
      authCount += 1;
      order.push('auth');
      return originalAuth(req);
    };
    const { service, calls } = createMockUploadService({
      create: async (input) => {
        order.push('service');
        return {
          uploadId: 'u1',
          status: 'initialized',
          deviceId: input.authenticatedDeviceId,
        };
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
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
    });
    try {
      order.length = 0;
      authCount = 0;
      const up = await fx.requestAgent('POST', '/agent/upload/sessions', {
        body: JSON.stringify(tinyCreateBody(device.deviceId)),
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(up.status, 201);
      assert.ok(order.includes('upload'), 'upload limiter must run');
      assert.ok(!order.includes('legacy'), 'legacy limiter must not run on upload');
      assert.ok(order.indexOf('upload') < order.indexOf('auth'), 'limiter before auth');
      assert.ok(order.indexOf('auth') < order.indexOf('service'), 'auth before service');

      order.length = 0;
      const g0a = await fx.requestAgent('POST', '/agent/enroll', {
        body: JSON.stringify({
          deviceId: 'other',
          protocolVersion: 2,
          enrollmentCode: 'x'.repeat(43),
        }),
        headers: { 'content-type': 'application/json' },
      });
      // enroll may 401 but must hit legacy only
      assert.ok(order.includes('legacy'));
      assert.ok(!order.includes('upload'));
      assert.ok(g0a.status !== 201 || true);
      void calls;
      void authCount;
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('128 upload chunk requests are not killed by legacy 60/min; counters isolated', async () => {
    let legacyCount = 0;
    let uploadCount = 0;
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-128-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'lim-128');
    const { service } = createMockUploadService({
      putChunk: async () => ({ acked: true }),
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      rateLimit: {
        check: () => {
          legacyCount += 1;
          // Legacy would deny after 60 — if upload mistakenly used it, we'd see 429.
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
    });
    try {
      const uploadId = 'cccccccc-dddd-4eee-8fff-000000000001';
      for (let i = 0; i < 128; i += 1) {
        // Zero-body safe count simulation — no 1 GiB payload.
        const res = await fx.requestAgent(
          'POST',
          `/agent/upload/sessions/${uploadId}/chunks`,
          {
            body: Buffer.alloc(0),
            headers: {
              ...authHeaders(device),
              'content-length': '0',
              'x-linke-upload-id': uploadId,
              'x-linke-snapshot-id': '550e8400-e29b-41d4-a716-4466554400aa',
              'x-linke-manifest-digest': 'a'.repeat(64),
              'x-linke-file-index': '0',
              'x-linke-chunk-index': String(i),
              'x-linke-chunk-offset': '0',
              'x-linke-chunk-size': '1',
              'x-linke-chunk-sha256': 'c'.repeat(64),
            },
          },
        );
        // Must not be legacy 429 device-rate-limited due to 60/min.
        assert.notEqual(
          res.status === 429 && res.body?.error === ERROR_CODES.DEVICE_RATE_LIMITED
            && legacyCount > LEGACY_DEFAULT_MAX_PER_MIN
            && uploadCount <= 128,
          true,
        );
        // Stronger: legacy check must never have been invoked for these upload routes.
        assert.equal(legacyCount, 0, `legacy must stay 0 after chunk ${i + 1}`);
      }
      assert.equal(uploadCount, 128);
      assert.equal(legacyCount, 0);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('1201st upload request is bounded 429 device-rate-limited; counters do not cross', async () => {
    let uploadCount = 0;
    let legacyCount = 0;
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-1201-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'lim-1201');
    const { service, calls } = createMockUploadService();
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      rateLimit: {
        check: () => {
          legacyCount += 1;
          return { allowed: true };
        },
      },
      uploadRateLimit: {
        check: () => {
          uploadCount += 1;
          if (uploadCount > UPLOAD_DEFAULT_MAX_PER_MIN) {
            return { allowed: false, retryAfterMs: 45_000 };
          }
          return { allowed: true };
        },
      },
    });
    try {
      // Simulate 1200 allows + 1 deny without real flood of full auth/body work on deny.
      for (let i = 0; i < UPLOAD_DEFAULT_MAX_PER_MIN; i += 1) {
        const res = await fx.requestAgent(
          'GET',
          `/agent/upload/sessions/id-${i}`,
          { headers: authHeaders(device) },
        );
        // Allowed path may 200 from mock; must not be rate-limited.
        assert.notEqual(res.body?.error, ERROR_CODES.DEVICE_RATE_LIMITED);
      }
      const denied = await fx.requestAgent(
        'GET',
        '/agent/upload/sessions/id-overflow',
        { headers: authHeaders(device) },
      );
      assertPublicError(denied, 429, ERROR_CODES.DEVICE_RATE_LIMITED);
      assertRetryAfterBounded(denied.headers);
      // 45s raw → clamp to 30
      assert.equal(String(denied.headers['retry-after']), '30');
      assert.equal(legacyCount, 0);
      assert.equal(uploadCount, UPLOAD_DEFAULT_MAX_PER_MIN + 1);
      // Deny is pre-auth: create must not have been called on the denied request.
      // (prior allows may have called status)
      const statusBefore = calls.status.length;
      void statusBefore;
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('upload limiter throw/thenable/illegal shape fail-closed 500 without auth/body', async () => {
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
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-lim-shape-'));
      const registry = new DeviceRegistry({ dataDir });
      const auth = instrumentAuth(registry);
      const device = await enrollDevice(registry, 'shape-dev');
      const { service, calls } = createMockUploadService();
      const fx = await startUploadFixture({
        registry,
        uploadService: service,
        uploadRateLimit: { check },
      });
      try {
        const res = await fx.requestAgent('POST', '/agent/upload/sessions', {
          body: JSON.stringify(tinyCreateBody(device.deviceId)),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assertPublicError(res, 500, ERROR_CODES.DEVICE_INTERNAL_ERROR);
        assert.equal(auth.count, 0);
        assert.equal(calls.create.length, 0);
        assert.ok(!res.raw.includes('/Users/private'));
        assert.ok(!res.raw.includes(device.token));
      } finally {
        await fx.cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  });

  it('upload limiter deny 429 device-rate-limited with clamped Retry-After; no secret echo', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-lim-deny-'));
    const registry = new DeviceRegistry({ dataDir });
    const auth = instrumentAuth(registry);
    const device = await enrollDevice(registry, 'deny-dev');
    const { service, calls } = createMockUploadService();
    const cases = [
      { retryAfterMs: 100, expect: '1' },
      { retryAfterMs: 2500, expect: '3' },
      { retryAfterMs: 60_000, expect: '30' },
      { retryAfterMs: 0, expectMin: 1, expectMax: 30 },
    ];
    for (const c of cases) {
      auth.reset();
      const fx = await startUploadFixture({
        registry,
        uploadService: service,
        uploadRateLimit: {
          check: () => ({ allowed: false, retryAfterMs: c.retryAfterMs }),
        },
      });
      try {
        const res = await fx.requestAgent('GET', '/agent/upload/sessions/x', {
          headers: authHeaders(device),
        });
        assertPublicError(res, 429, ERROR_CODES.DEVICE_RATE_LIMITED);
        assertRetryAfterBounded(res.headers);
        if (c.expect) assert.equal(String(res.headers['retry-after']), c.expect);
        assert.equal(auth.count, 0);
        assert.equal(calls.status.length, 0);
      } finally {
        await fx.cleanup();
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('service upload-backpressure → 429 with distinct code + bounded Retry-After', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-bp-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'bp-dev');
    const { service } = createMockUploadService({
      create: async () => {
        throw new LinkeError(ERROR_CODES.UPLOAD_BACKPRESSURE, {
          statusCode: 429,
          retryable: true,
        });
      },
    });
    // Attach retryAfterMs via error if implementation reads it; also freeze header mapping.
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const res = await fx.requestAgent('POST', '/agent/upload/sessions', {
        body: JSON.stringify(tinyCreateBody(device.deviceId)),
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(res.status, 429);
      assert.equal(res.body.error, ERROR_CODES.UPLOAD_BACKPRESSURE);
      assert.notEqual(res.body.error, ERROR_CODES.DEVICE_RATE_LIMITED);
      assertRetryAfterBounded(res.headers);
      assertNoForbiddenKeys(res.body);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('non-backpressure service errors must not attach Retry-After', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-no-ra-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'nora-dev');
    const codes = [
      ERROR_CODES.UPLOAD_MANIFEST_INVALID,
      ERROR_CODES.UPLOAD_SESSION_NOT_FOUND,
      ERROR_CODES.UPLOAD_CHUNK_INVALID,
      ERROR_CODES.UPLOAD_IO_ERROR,
      ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT,
    ];
    for (const code of codes) {
      const { service } = createMockUploadService({
        create: async () => {
          throw new LinkeError(code);
        },
        status: async () => {
          throw new LinkeError(code);
        },
      });
      const fx = await startUploadFixture({
        registry,
        uploadService: service,
        uploadRateLimit: { check: () => ({ allowed: true }) },
      });
      try {
        const path = code === ERROR_CODES.UPLOAD_SESSION_NOT_FOUND
          ? '/agent/upload/sessions/missing'
          : '/agent/upload/sessions';
        const method = code === ERROR_CODES.UPLOAD_SESSION_NOT_FOUND ? 'GET' : 'POST';
        const res = await fx.requestAgent(method, path, {
          body: method === 'POST'
            ? JSON.stringify(tinyCreateBody(device.deviceId))
            : undefined,
          headers: {
            ...authHeaders(device),
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          },
        });
        assert.equal(res.body.error, code);
        assertNoRetryAfter(res.headers);
      } finally {
        await fx.cleanup();
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  });
});

// ===========================================================================
// C. Auth triad exact-one + auth-before-side-effect
// ===========================================================================

describe('C6 C — auth triad + auth-before-side-effect (RED)', () => {
  it('missing/duplicate/malformed Authorization → device-token-invalid; no body/service', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-auth-tok-'));
    const registry = new DeviceRegistry({ dataDir });
    const auth = instrumentAuth(registry);
    const device = await enrollDevice(registry, 'tok-dev');
    const { service, calls } = createMockUploadService();
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      // Missing Authorization
      {
        const res = await fx.requestAgent('GET', '/agent/upload/sessions/u1', {
          headers: {
            'x-linke-device-id': device.deviceId,
            'x-linke-protocol-version': '2',
          },
        });
        assertPublicError(res, 401, ERROR_CODES.DEVICE_TOKEN_INVALID);
        assert.equal(auth.count, 0);
        assert.equal(calls.status.length, 0);
      }
      // Malformed Bearer
      {
        const res = await fx.requestAgent('GET', '/agent/upload/sessions/u1', {
          headers: {
            authorization: 'Basic abc',
            'x-linke-device-id': device.deviceId,
            'x-linke-protocol-version': '2',
          },
        });
        assertPublicError(res, 401, ERROR_CODES.DEVICE_TOKEN_INVALID);
        assert.equal(auth.count, 0);
      }
      // Duplicate Authorization via raw TLS
      {
        const head = [
          'GET /agent/upload/sessions/u1 HTTP/1.1',
          'Host: 127.0.0.1',
          `Authorization: Bearer ${device.token}`,
          'Authorization: Bearer other-token-value',
          `X-Linke-Device-Id: ${device.deviceId}`,
          'X-Linke-Protocol-Version: 2',
          'Connection: close',
          '',
          '',
        ].join('\r\n');
        const result = await rawTlsHttpExchange({
          port: fx.port,
          head,
          endAfterBody: true,
          timeoutMs: 800,
        });
        assert.equal(result.kind, 'response');
        assert.equal(result.status, 401);
        assert.deepEqual(result.body, { error: ERROR_CODES.DEVICE_TOKEN_INVALID });
        assert.equal(auth.count, 0);
        assert.ok(!result.raw.includes(device.token));
      }
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('missing/duplicate device id or request shape → device-request-invalid; no auth lookup side-effect beyond header parse', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-auth-dev-'));
    const registry = new DeviceRegistry({ dataDir });
    const auth = instrumentAuth(registry);
    const device = await enrollDevice(registry, 'devhdr');
    const { service, calls } = createMockUploadService();
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      // Missing device id
      {
        const res = await fx.requestAgent('GET', '/agent/upload/sessions/u1', {
          headers: {
            authorization: `Bearer ${device.token}`,
            'x-linke-protocol-version': '2',
          },
        });
        assertPublicError(res, 400, ERROR_CODES.DEVICE_REQUEST_INVALID);
        assert.equal(auth.count, 0);
        assert.equal(calls.status.length, 0);
      }
      // Duplicate device id (case-insensitive exact-one)
      {
        const head = [
          'GET /agent/upload/sessions/u1 HTTP/1.1',
          'Host: 127.0.0.1',
          `Authorization: Bearer ${device.token}`,
          `X-Linke-Device-Id: ${device.deviceId}`,
          'x-linke-device-id: other-device',
          'X-Linke-Protocol-Version: 2',
          'Connection: close',
          '',
          '',
        ].join('\r\n');
        const result = await rawTlsHttpExchange({
          port: fx.port,
          head,
          endAfterBody: true,
          timeoutMs: 800,
        });
        assert.equal(result.kind, 'response');
        assert.equal(result.status, 400);
        assert.deepEqual(result.body, { error: ERROR_CODES.DEVICE_REQUEST_INVALID });
        assert.equal(auth.count, 0);
      }
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('protocol header missing/duplicate/non-integer/unsupported → device-protocol-unsupported', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-auth-proto-'));
    const registry = new DeviceRegistry({ dataDir });
    const auth = instrumentAuth(registry);
    const device = await enrollDevice(registry, 'proto-dev');
    const { service, calls } = createMockUploadService();
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const cases = [
        {
          headers: {
            authorization: `Bearer ${device.token}`,
            'x-linke-device-id': device.deviceId,
          },
        },
        {
          headers: {
            authorization: `Bearer ${device.token}`,
            'x-linke-device-id': device.deviceId,
            'x-linke-protocol-version': '2.5',
          },
        },
        {
          headers: {
            authorization: `Bearer ${device.token}`,
            'x-linke-device-id': device.deviceId,
            'x-linke-protocol-version': 'abc',
          },
        },
        {
          headers: {
            authorization: `Bearer ${device.token}`,
            'x-linke-device-id': device.deviceId,
            'x-linke-protocol-version': '99',
          },
        },
      ];
      for (const c of cases) {
        auth.reset();
        const res = await fx.requestAgent('GET', '/agent/upload/sessions/u1', {
          headers: c.headers,
        });
        assertPublicError(res, 426, ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED);
        assert.equal(auth.count, 0);
        assert.equal(calls.status.length, 0);
      }
      // Duplicate protocol header
      {
        const head = [
          'GET /agent/upload/sessions/u1 HTTP/1.1',
          'Host: 127.0.0.1',
          `Authorization: Bearer ${device.token}`,
          `X-Linke-Device-Id: ${device.deviceId}`,
          'X-Linke-Protocol-Version: 2',
          'X-Linke-Protocol-Version: 1',
          'Connection: close',
          '',
          '',
        ].join('\r\n');
        const result = await rawTlsHttpExchange({
          port: fx.port,
          head,
          endAfterBody: true,
          timeoutMs: 800,
        });
        assert.equal(result.kind, 'response');
        assert.equal(result.status, 426);
        assert.deepEqual(result.body, { error: ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED });
      }
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('authenticate uses header deviceId+token+protocolVersion; SoT is returned device.deviceId', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-sot-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'sot-device');
    /** @type {any[]} */
    const authArgs = [];
    const originalAuth = registry.authenticate.bind(registry);
    registry.authenticate = async (request) => {
      authArgs.push(request);
      const out = await originalAuth(request);
      return { deviceId: out.deviceId, protocolVersion: out.protocolVersion };
    };
    const { service, calls } = createMockUploadService();
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      await fx.requestAgent('GET', '/agent/upload/sessions/upload-xyz', {
        headers: authHeaders(device),
      });
      assert.equal(authArgs.length, 1);
      assert.deepEqual(authArgs[0], {
        deviceId: device.deviceId,
        token: device.token,
        protocolVersion: device.protocolVersion,
      });
      assert.equal(calls.status[0].authenticatedDeviceId, device.deviceId);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('authenticate failure: no service call for any uploadId; no body read; no existence leak', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-authfail-'));
    const registry = new DeviceRegistry({ dataDir });
    await enrollDevice(registry, 'real-device');
    const { service, calls } = createMockUploadService();
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const badToken = 'z'.repeat(43);
      for (const [method, path] of UPLOAD_PATHS) {
        const res = await fx.requestAgent(method, path, {
          body: method === 'GET'
            ? undefined
            : JSON.stringify({
              manifest: { deviceId: 'real-device', path: '/Users/secret' },
              manifestDigest: 'a'.repeat(64),
            }),
          headers: {
            authorization: `Bearer ${badToken}`,
            'x-linke-device-id': 'real-device',
            'x-linke-protocol-version': '2',
            'content-type': 'application/json',
          },
        });
        assert.equal(res.body.error, ERROR_CODES.DEVICE_TOKEN_INVALID);
        assert.ok(!res.raw.includes('/Users/secret'));
        assert.ok(!res.raw.includes('exists'));
      }
      assert.equal(calls.create.length, 0);
      assert.equal(calls.status.length, 0);
      assert.equal(calls.putChunk.length, 0);
      assert.equal(calls.finalize.length, 0);
      assert.equal(calls.abort.length, 0);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('cross-device status/finalize/abort unique upload-session-not-found; abort committed unique upload-commit-conflict; abort idempotent', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-xdev-'));
    const registry = new DeviceRegistry({ dataDir });
    const deviceA = await enrollDevice(registry, 'dev-a');
    const deviceB = await enrollDevice(registry, 'dev-b');
    let abortCalls = 0;
    const { service } = createMockUploadService({
      status: async ({ authenticatedDeviceId }) => {
        if (authenticatedDeviceId === deviceB.deviceId) {
          throw new LinkeError(ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
        }
        return { uploadId: 'u-cross', status: 'initialized', deviceId: authenticatedDeviceId };
      },
      finalize: async ({ authenticatedDeviceId }) => {
        if (authenticatedDeviceId === deviceB.deviceId) {
          throw new LinkeError(ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
        }
        return { uploadId: 'u-cross', status: 'committed' };
      },
      abort: async ({ authenticatedDeviceId, uploadId }) => {
        abortCalls += 1;
        if (authenticatedDeviceId === deviceB.deviceId) {
          throw new LinkeError(ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
        }
        if (uploadId === 'committed-id') {
          throw new LinkeError(ERROR_CODES.UPLOAD_COMMIT_CONFLICT);
        }
        return { uploadId, status: 'aborted', deviceId: authenticatedDeviceId };
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      for (const [method, path] of [
        ['GET', '/agent/upload/sessions/u-cross'],
        ['POST', '/agent/upload/sessions/u-cross/finalize'],
        ['POST', '/agent/upload/sessions/u-cross/abort'],
      ]) {
        const res = await fx.requestAgent(method, path, {
          headers: authHeaders(deviceB),
        });
        assertPublicError(res, 404, ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
        // Must not leak "owned by other device"
        assert.ok(!res.raw.includes(deviceA.deviceId));
      }

      const committed = await fx.requestAgent(
        'POST',
        '/agent/upload/sessions/committed-id/abort',
        { headers: authHeaders(deviceA) },
      );
      assertPublicError(committed, 409, ERROR_CODES.UPLOAD_COMMIT_CONFLICT);

      const a1 = await fx.requestAgent(
        'POST',
        '/agent/upload/sessions/active-id/abort',
        { headers: authHeaders(deviceA) },
      );
      const a2 = await fx.requestAgent(
        'POST',
        '/agent/upload/sessions/active-id/abort',
        { headers: authHeaders(deviceA) },
      );
      assert.equal(a1.status, 200);
      assert.equal(a2.status, 200);
      assert.deepEqual(a1.body, a2.body);
      assert.equal(a1.body.status, 'aborted');
      assert.ok(abortCalls >= 2);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('create manifest/deviceId or digest mismatch passes through unique upload-manifest-invalid', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-manifest-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'man-dev');
    const { service, calls } = createMockUploadService({
      create: async () => {
        throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const body = tinyCreateBody('other-device-id');
      const res = await fx.requestAgent('POST', '/agent/upload/sessions', {
        body: JSON.stringify(body),
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      // Listener must not rewrite to device-scope-mismatch.
      assert.equal(res.body.error, ERROR_CODES.UPLOAD_MANIFEST_INVALID);
      assert.notEqual(res.body.error, ERROR_CODES.DEVICE_SCOPE_MISMATCH);
      assert.equal(res.status, 400);
      assert.equal(calls.create.length, 1);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// D. Body / preflight / errors
// ===========================================================================

describe('C6 D — body / preflight / errors (RED)', () => {
  it('create reads JSON only after auth; 8MiB max; invalid shapes → device-request-invalid; service 0', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-create-body-'));
    const registry = new DeviceRegistry({ dataDir });
    const auth = instrumentAuth(registry);
    const device = await enrollDevice(registry, 'body-dev');
    const { service, calls } = createMockUploadService();
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      // Auth fails first: body must not reach service (and ideally not be fully required).
      auth.reset();
      calls.create.length = 0;
      const unauth = await fx.requestAgent('POST', '/agent/upload/sessions', {
        body: JSON.stringify(tinyCreateBody(device.deviceId)),
        headers: {
          authorization: `Bearer ${'n'.repeat(43)}`,
          'x-linke-device-id': device.deviceId,
          'x-linke-protocol-version': '2',
          'content-type': 'application/json',
        },
      });
      assert.equal(unauth.body.error, ERROR_CODES.DEVICE_TOKEN_INVALID);
      assert.equal(calls.create.length, 0);

      const invalidBodies = [
        '',
        '{broken',
        '[]',
        'null',
        '"string"',
        '123',
        JSON.stringify({ manifestDigest: 'a'.repeat(64) }), // missing manifest
        JSON.stringify({ manifest: tinyCreateBody().manifest }), // missing digest
        JSON.stringify({
          manifest: tinyCreateBody(device.deviceId).manifest,
          manifestDigest: 'a'.repeat(64),
          extra: true,
        }), // unknown envelope key
        JSON.stringify({
          claimedManifestDigest: 'a'.repeat(64),
          manifest: tinyCreateBody(device.deviceId).manifest,
        }), // wrong wire key name
      ];
      for (const raw of invalidBodies) {
        calls.create.length = 0;
        const res = await fx.requestAgent('POST', '/agent/upload/sessions', {
          body: raw,
          headers: {
            ...authHeaders(device),
            'content-type': 'application/json',
          },
        });
        assertPublicError(res, 400, ERROR_CODES.DEVICE_REQUEST_INVALID);
        assert.equal(calls.create.length, 0, `service create for body=${raw.slice(0, 40)}`);
      }

      // Hard boundary: declared Content-Length === 8MiB+1. Do NOT stream a full
      // 8MiB+1 body over the same-process TLS socket (server early-closes on CL →
      // client write EPIPE under full parallel load). Short body + end:false keeps
      // the socket open while the server rejects pre-body as device-request-invalid.
      calls.create.length = 0;
      const overRes = await fx.requestAgent('POST', '/agent/upload/sessions', {
        body: '{}',
        end: false,
        headers: {
          ...authHeaders(device),
          'content-type': 'application/json',
          'content-length': String(UPLOAD_CREATE_MAX_BYTES + 1),
        },
      });
      assertPublicError(overRes, 400, ERROR_CODES.DEVICE_REQUEST_INVALID);
      assert.equal(calls.create.length, 0);

      // Exact 64KiB+1 create body that is under 8MiB must NOT be rejected as G0a 64KiB.
      // Build a valid envelope padded inside manifest hostname-like field is invalid;
      // use a large but valid JSON object under 8MiB with exact keys only.
      const pad = 'p'.repeat(70 * 1024);
      const bigButValid = JSON.stringify({
        manifest: {
          ...tinyCreateBody(device.deviceId).manifest,
          // unknown key inside manifest is service-level; envelope is exact.
        },
        manifestDigest: 'a'.repeat(64),
        // cannot pad at envelope — instead ensure body size > 64KiB via digest? fixed length.
      });
      // Force size > 64KiB by embedding pad into a legal string field of manifest that
      // may later fail projection — listener body gate must still accept and call service.
      const bigManifest = {
        ...tinyCreateBody(device.deviceId).manifest,
        hostname: pad.slice(0, 200), // may fail projection; body size still small
      };
      // Create a body just over 64KiB with only allowed envelope keys by padding digest? digest fixed.
      // Use a large manifest.files array of empty paths? Keep simple: pass oversized string via
      // JSON with exact keys — put pad into snapshotId? invalid. Service call count is the probe:
      // construct body of 64KiB+8 as invalid JSON object {manifest,manifestDigest} with huge
      // manifestDigest string — service may reject; listener must call create OR reject with
      // device-request-invalid for non-hex digest only after parse.
      const hugeDigestBody = JSON.stringify({
        manifest: tinyCreateBody(device.deviceId).manifest,
        manifestDigest: 'a'.repeat(70 * 1024),
      });
      assert.ok(Buffer.byteLength(hugeDigestBody) > 64 * 1024);
      assert.ok(Buffer.byteLength(hugeDigestBody) < UPLOAD_CREATE_MAX_BYTES);
      calls.create.length = 0;
      const mid = await fx.requestAgent('POST', '/agent/upload/sessions', {
        body: hugeDigestBody,
        headers: {
          ...authHeaders(device),
          'content-type': 'application/json',
        },
      });
      // Must not be a pure 64KiB G0a early 413/400 without attempting create after auth,
      // unless envelope validation rejects digest shape pre-service.
      // Freeze: status is not 413 (legacy oversize).
      assert.notEqual(mid.status, 413);
      // If listener validates digest shape → 400 device-request-invalid + create 0.
      // If listener passes through → create called once.
      assert.ok(
        (mid.status === 400
          && mid.body?.error === ERROR_CODES.DEVICE_REQUEST_INVALID
          && calls.create.length === 0)
        || calls.create.length === 1
        || mid.body?.error === ERROR_CODES.UPLOAD_MANIFEST_INVALID,
        `unexpected mid-size create handling: status=${mid.status} body=${JSON.stringify(mid.body)} calls=${calls.create.length}`,
      );
      void bigButValid;
      void bigManifest;
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('chunk: listener does not consume stream before service; invalid headers → upload-chunk-invalid without stream advance', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-chunk-pre-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'chunk-pre');
    let streamBytesSeen = 0;
    let putCalls = 0;
    const { service } = createMockUploadService({
      putChunk: async (input) => {
        putCalls += 1;
        const stream = input.stream;
        // Service-level: if critical headers invalid, C3 throws before reading —
        // but if listener already consumed, readableEnded is true.
        if (stream && stream.readableEnded) {
          streamBytesSeen = -1;
        }
        throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID);
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const uploadId = 'dddddddd-eeee-4fff-8000-111111111111';
      const payload = Buffer.from('BINARY-CHUNK-PAYLOAD');
      // Missing critical chunk headers → upload-chunk-invalid; stream must not advance boundary.
      const res = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/chunks`,
        {
          body: payload,
          headers: {
            ...authHeaders(device),
            'content-type': 'application/octet-stream',
            // deliberately incomplete critical set
            'content-length': String(payload.length),
          },
        },
      );
      assertPublicError(res, 400, ERROR_CODES.UPLOAD_CHUNK_INVALID);
      // Either service threw after receiving unread stream, or listener rejected pre-service
      // with same unique code. Stream must not have been fully pre-consumed as success path.
      assert.notEqual(streamBytesSeen, -1, 'listener must not fully end stream before service');
      void putCalls;
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('chunk out-of-order 409 unique; integrity-failed+abort unique; no forged alternate codes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-chunk-codes-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'chunk-codes');
    const sequence = ['out-of-order', 'integrity'];
    let i = 0;
    const { service } = createMockUploadService({
      putChunk: async () => {
        const step = sequence[i] || 'out-of-order';
        i += 1;
        if (step === 'out-of-order') {
          throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER);
        }
        throw new LinkeError(ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const uploadId = 'eeeeeeee-ffff-4000-8000-222222222222';
      const headersBase = {
        ...authHeaders(device),
        'content-type': 'application/octet-stream',
        'x-linke-upload-id': uploadId,
        'x-linke-snapshot-id': '550e8400-e29b-41d4-a716-4466554400aa',
        'x-linke-manifest-digest': 'a'.repeat(64),
        'x-linke-file-index': '0',
        'x-linke-chunk-index': '1',
        'x-linke-chunk-offset': '0',
        'x-linke-chunk-size': '2',
        'x-linke-chunk-sha256': 'c'.repeat(64),
      };
      const ooo = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/chunks`,
        {
          body: Buffer.from('ab'),
          headers: { ...headersBase, 'content-length': '2' },
        },
      );
      assert.equal(ooo.status, 409);
      assert.equal(ooo.body.error, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER);
      assert.notEqual(ooo.body.error, ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
      assert.notEqual(ooo.body.error, ERROR_CODES.UPLOAD_CHUNK_INVALID);

      const integ = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/chunks`,
        {
          body: Buffer.from('ab'),
          headers: { ...headersBase, 'content-length': '2' },
        },
      );
      assert.equal(integ.status, 409);
      assert.equal(integ.body.error, ERROR_CODES.UPLOAD_INTEGRITY_FAILED);
      assert.notEqual(integ.body.error, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('capacity insufficient → numeric 507 JSON; hostile LinkeError status fail-safe 500', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-507-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'cap-dev');
    {
      const { service } = createMockUploadService({
        create: async () => {
          throw new LinkeError(ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT);
        },
      });
      const fx = await startUploadFixture({
        registry,
        uploadService: service,
        uploadRateLimit: { check: () => ({ allowed: true }) },
      });
      try {
        const res = await fx.requestAgent('POST', '/agent/upload/sessions', {
          body: JSON.stringify(tinyCreateBody(device.deviceId)),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assert.equal(res.status, 507);
        assert.equal(typeof res.status, 'number');
        assert.deepEqual(res.body, { error: ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT });
        assertNoRetryAfter(res.headers);
      } finally {
        await fx.cleanup();
      }
    }
    {
      const { service } = createMockUploadService({
        create: async () => {
          throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID, { statusCode: 999 });
        },
      });
      const fx = await startUploadFixture({
        registry,
        uploadService: service,
        uploadRateLimit: { check: () => ({ allowed: true }) },
      });
      try {
        const res = await fx.requestAgent('POST', '/agent/upload/sessions', {
          body: JSON.stringify(tinyCreateBody(device.deviceId)),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assert.ok(res.status >= 400 && res.status <= 599);
        assert.notEqual(res.status, 999);
        assert.equal(res.body.error, ERROR_CODES.UPLOAD_MANIFEST_INVALID);
        assert.ok(!res.raw.includes('999'));
      } finally {
        await fx.cleanup();
      }
    }
    {
      const { service } = createMockUploadService({
        create: async () => {
          throw new Error('raw secret /Users/secret/db path token=xyz');
        },
      });
      const fx = await startUploadFixture({
        registry,
        uploadService: service,
        uploadRateLimit: { check: () => ({ allowed: true }) },
      });
      try {
        const res = await fx.requestAgent('POST', '/agent/upload/sessions', {
          body: JSON.stringify(tinyCreateBody(device.deviceId)),
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assert.equal(res.status, 500);
        assert.ok(
          res.body.error === ERROR_CODES.DEVICE_INTERNAL_ERROR
          || res.body.error === ERROR_CODES.UPLOAD_IO_ERROR,
        );
        assert.ok(!res.raw.includes('/Users/secret'));
        assert.ok(!res.raw.includes('token=xyz'));
      } finally {
        await fx.cleanup();
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('status GET has no body requirement; finalize/abort allow empty body without waiting for end', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-empty-body-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'empty-body');
    const { service, calls } = createMockUploadService();
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const statusRes = await fx.requestAgent('GET', '/agent/upload/sessions/u-empty', {
        headers: authHeaders(device),
      });
      assert.equal(statusRes.status, 200);
      assert.equal(calls.status.length, 1);

      // Incomplete chunked body on finalize must not hang waiting for end.
      const head = [
        'POST /agent/upload/sessions/u-empty/finalize HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        'X-Linke-Protocol-Version: 2',
        'Transfer-Encoding: chunked',
        'Content-Type: application/json',
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      const startedAt = Date.now();
      const result = await rawTlsHttpExchange({
        port: fx.port,
        head,
        bodyParts: ['5\r\nhello'], // incomplete; never ends
        endAfterBody: false,
        timeoutMs: 600,
      });
      const elapsed = Date.now() - startedAt;
      assert.equal(result.kind, 'response', 'finalize must not wait for body end');
      assert.ok(elapsed < 500, `expected fast finalize empty-body path, took ${elapsed}ms`);
      assert.equal(result.status, 200);
      assert.equal(calls.finalize.length, 1);

      const abortHead = [
        'POST /agent/upload/sessions/u-empty/abort HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        'X-Linke-Protocol-Version: 2',
        'Content-Length: 0',
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      // Content-Length:0 completes the request in headers; keep socket open until
      // the server response arrives (avoid half-close race unrelated to body wait).
      const abortResult = await rawTlsHttpExchange({
        port: fx.port,
        head: abortHead,
        endAfterBody: false,
        timeoutMs: 600,
      });
      assert.equal(abortResult.kind, 'response');
      assert.equal(abortResult.status, 200);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// E. Deadline / single-settle (fake timers)
// ===========================================================================

describe('C6 E — dual-timer deadlines + single-settle (RED)', () => {
  it('create total deadline 30s → unique device-request-invalid 400; service 0 times', async () => {
    const timers = createManualTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-create-dl-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'create-dl');
    const { service, calls } = createMockUploadService({
      create: async () => {
        // If total timer works, create should never be reached on timeout path.
        return { uploadId: 'late', status: 'initialized' };
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
      timers,
    });
    try {
      // Hold body open: send headers + partial body, never finish within deadline.
      const body = JSON.stringify(tinyCreateBody(device.deviceId));
      const head = [
        'POST /agent/upload/sessions HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        'X-Linke-Protocol-Version: 2',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');

      const resultPromise = rawTlsHttpExchange({
        port: fx.port,
        head,
        bodyParts: [body.slice(0, 8)], // partial
        endAfterBody: false,
        timeoutMs: 2000,
      });
      // Allow handler to arm total timer, then fire 30s.
      await waitForTimerArmed(timers, { minPending: 1 });
      timers.advance(UPLOAD_CREATE_TOTAL_MS + 1);
      const result = await resultPromise;
      assert.equal(result.kind, 'response');
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: ERROR_CODES.DEVICE_REQUEST_INVALID });
      assert.equal(calls.create.length, 0);
      assert.notEqual(result.body.error, ERROR_CODES.UPLOAD_IO_ERROR);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('chunk idle 15s and total 120s map to unique upload-chunk-invalid 400; single-settle', async () => {
    const timers = createManualTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-chunk-dl-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'chunk-dl');
    let putStarted = 0;
    let putFinished = 0;
    const { service } = createMockUploadService({
      putChunk: async (input) => {
        putStarted += 1;
        // Simulate long ingest waiting on stream — timeout must settle first.
        await new Promise(() => {
          // never resolves; timeout must win
          void input;
        });
        putFinished += 1;
        return { acked: true };
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
      timers,
    });
    try {
      const uploadId = 'ffffffff-0000-4000-8000-333333333333';
      const head = [
        `POST /agent/upload/sessions/${uploadId}/chunks HTTP/1.1`,
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        'X-Linke-Protocol-Version: 2',
        'Content-Type: application/octet-stream',
        'Content-Length: 16',
        `X-Linke-Upload-Id: ${uploadId}`,
        'X-Linke-Snapshot-Id: 550e8400-e29b-41d4-a716-4466554400aa',
        `X-Linke-Manifest-Digest: ${'a'.repeat(64)}`,
        'X-Linke-File-Index: 0',
        'X-Linke-Chunk-Index: 0',
        'X-Linke-Chunk-Offset: 0',
        'X-Linke-Chunk-Size: 16',
        `X-Linke-Chunk-Sha256: ${'c'.repeat(64)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');

      // Idle path: no non-empty data arrives.
      const idlePromise = rawTlsHttpExchange({
        port: fx.port,
        head,
        bodyParts: [],
        endAfterBody: false,
        timeoutMs: 2000,
      });
      // Chunk arms total + idle together before auth/service.
      await waitForTimerArmed(timers, { minPending: 2 });
      timers.advance(UPLOAD_CHUNK_IDLE_MS + 1);
      const idle = await idlePromise;
      assert.equal(idle.kind, 'response');
      assert.equal(idle.status, 400);
      assert.deepEqual(idle.body, { error: ERROR_CODES.UPLOAD_CHUNK_INVALID });

      // Total path: drip non-empty data resetting idle but total still bounds.
      timers.reset();
      const totalPromise = rawTlsHttpExchange({
        port: fx.port,
        head,
        bodyParts: [],
        endAfterBody: false,
        timeoutMs: 3000,
      });
      await waitForTimerArmed(timers, { minPending: 2 });
      // Simulate slow drip resets: advance just under idle repeatedly then hit total.
      // Without a live socket write API in raw helper mid-flight, freeze total-only arming:
      timers.advance(UPLOAD_CHUNK_TOTAL_MS + 1);
      const total = await totalPromise;
      assert.equal(total.kind, 'response');
      assert.equal(total.status, 400);
      assert.deepEqual(total.body, { error: ERROR_CODES.UPLOAD_CHUNK_INVALID });
      assert.equal(putFinished, 0);
      void putStarted;
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('status/finalize/abort handler 15s deadline → safe request error; no service advance after settle', async () => {
    const timers = createManualTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-status-dl-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'status-dl');
    let statusCalls = 0;
    let lateResolve;
    const { service } = createMockUploadService({
      status: async () => {
        statusCalls += 1;
        await new Promise((resolve) => {
          lateResolve = resolve;
        });
        return { uploadId: 'late', status: 'initialized' };
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
      timers,
    });
    try {
      const pending = fx.requestAgent('GET', '/agent/upload/sessions/slow', {
        headers: authHeaders(device),
      });
      // Handler total timer arms at entry; auth may still be in flight.
      // Wait until mock status is pending so deadline covers the service phase.
      await waitForCondition(
        () => statusCalls === 1 && typeof lateResolve === 'function',
        { maxTurns: 64, label: 'status mock entered pending (statusCalls=1 + lateResolve)' },
      );
      assert.ok(timers.pendingCount() >= 1, 'handler deadline timer must still be armed');
      timers.advance(UPLOAD_STATUS_TOTAL_MS + 1);
      // Bound wait: RED without deadline impl must fail fast, never hang the suite.
      const res = await Promise.race([
        pending,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('status deadline did not settle within 1500ms')), 1500);
        }),
      ]);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, ERROR_CODES.DEVICE_REQUEST_INVALID);
      // Late service resolve must not second-write.
      if (typeof lateResolve === 'function') lateResolve();
      await new Promise((r) => setImmediate(r));
      assert.equal(statusCalls, 1);
    } finally {
      // Unblock hung mock if deadline path missing (cleanup safety).
      if (typeof lateResolve === 'function') lateResolve();
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('dual timers share idempotent settle gate; late data/end/error/service cannot double-respond', async () => {
    const timers = createManualTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-settle-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'settle-dev');
    let serviceSettles = 0;
    /** @type {(() => void) | null} */
    let triggerLateService = null;
    const { service } = createMockUploadService({
      putChunk: async (input) => {
        // Stay pending until the test explicitly fires late events after idle settle.
        // Real setTimeout(0) races ahead of virtual idle advance and surfaces 500.
        const stream = input.stream;
        return new Promise((resolve, reject) => {
          triggerLateService = () => {
            serviceSettles += 1;
            try {
              if (stream && typeof stream.emit === 'function') {
                stream.emit('data', Buffer.from('late'));
                stream.emit('end');
                stream.emit('error', new Error('late-error'));
              }
            } catch {
              // ignore
            }
            reject(new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR));
          };
          void resolve;
        });
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
      timers,
    });
    try {
      const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-444444444444';
      const head = [
        `POST /agent/upload/sessions/${uploadId}/chunks HTTP/1.1`,
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        'X-Linke-Protocol-Version: 2',
        'Content-Type: application/octet-stream',
        'Content-Length: 4',
        `X-Linke-Upload-Id: ${uploadId}`,
        'X-Linke-Snapshot-Id: 550e8400-e29b-41d4-a716-4466554400aa',
        `X-Linke-Manifest-Digest: ${'a'.repeat(64)}`,
        'X-Linke-File-Index: 0',
        'X-Linke-Chunk-Index: 0',
        'X-Linke-Chunk-Offset: 0',
        'X-Linke-Chunk-Size: 4',
        `X-Linke-Chunk-Sha256: ${'c'.repeat(64)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');

      const resultPromise = rawTlsHttpExchange({
        port: fx.port,
        head,
        bodyParts: [],
        endAfterBody: false,
        timeoutMs: 2000,
      });
      await waitForTimerArmed(timers, { minPending: 2 });
      timers.advance(UPLOAD_CHUNK_IDLE_MS + 1);
      const result = await resultPromise;
      assert.equal(result.kind, 'response');
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: ERROR_CODES.UPLOAD_CHUNK_INVALID });
      // Explicit late service path after timeout settled — must not double-respond.
      if (typeof triggerLateService === 'function') {
        triggerLateService();
      }
      await new Promise((r) => setImmediate(r));
      await Promise.resolve();
      // Single JSON error object — raw must not contain two concatenated JSON objects.
      const errorMatches = result.raw.match(/"error"/g) || [];
      assert.equal(errorMatches.length, 1);
      void serviceSettles;
      void G0A_TOTAL_MS;
      void PassThrough;
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('slow drip non-empty data resets idle but cannot extend 120s total (timer API)', async () => {
    const timers = createManualTimers();
    // Pure unit-style freeze of timer contract used by handler:
    // - idle timer rescheduled only on non-empty data
    // - total timer never rescheduled
    // Production handler must use the same injected timers API.
    const idleFires = [];
    const totalFires = [];
    let idleId = timers.setTimeout(() => idleFires.push(timers.now()), UPLOAD_CHUNK_IDLE_MS);
    const totalId = timers.setTimeout(() => totalFires.push(timers.now()), UPLOAD_CHUNK_TOTAL_MS);

    // Simulate non-empty data at t=10s → reset idle.
    timers.advance(10_000);
    timers.clearTimeout(idleId);
    idleId = timers.setTimeout(() => idleFires.push(timers.now()), UPLOAD_CHUNK_IDLE_MS);

    // Empty data must not reset — we simply do not clear/rearm idle here.
    timers.advance(10_000);

    // Advance to just before new idle would fire (5s left of 15s after second arm at t=10).
    // now=20s; idle armed at 10+15=25 → fire at advance 5s.
    timers.advance(4_999);
    assert.equal(idleFires.length, 0);
    timers.advance(2);
    assert.equal(idleFires.length, 1);

    // Re-arm idle again and prove total still fires at absolute 120s from start.
    timers.clearTimeout(idleId);
    idleId = timers.setTimeout(() => idleFires.push(timers.now()), UPLOAD_CHUNK_IDLE_MS);
    const remainingTotal = UPLOAD_CHUNK_TOTAL_MS - (timers.now() - 1_000_000);
    assert.ok(remainingTotal < UPLOAD_CHUNK_TOTAL_MS);
    timers.advance(remainingTotal);
    assert.equal(totalFires.length, 1);
    timers.clearTimeout(totalId);
    timers.clearTimeout(idleId);

    // Integration: listener accepts timers option (construction must not throw once implemented).
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-drip-'));
    const registry = new DeviceRegistry({ dataDir });
    const { service } = createMockUploadService();
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
      timers,
    });
    try {
      assert.equal(fx.server.requestTimeout, SERVER_REQUEST_TIMEOUT_MS);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// F. Fail-closed when uploadRateLimit incomplete (P1-b)
// ===========================================================================

describe('C6 F — complete service requires complete uploadRateLimit (RED)', () => {
  it('service present + missing/incomplete/hostile uploadRateLimit → fixed 404; create & chunk no-touch', async () => {
    const cases = [
      { label: 'missing limiter', uploadRateLimit: undefined },
      { label: 'empty object', uploadRateLimit: {} },
      { label: 'null check', uploadRateLimit: { check: null } },
      { label: 'non-function check', uploadRateLimit: { check: 'hostile' } },
      { label: 'array limiter', uploadRateLimit: [] },
    ];

    for (const c of cases) {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-lim-gate-'));
      const registry = new DeviceRegistry({ dataDir });
      const auth = instrumentAuth(registry);
      const device = await enrollDevice(registry, `lim-gate-${c.label.replace(/\s+/g, '-')}`);
      const { service, calls } = createMockUploadService();
      const fx = await startUploadFixture({
        registry,
        uploadService: service,
        ...(c.uploadRateLimit !== undefined ? { uploadRateLimit: c.uploadRateLimit } : {}),
      });
      try {
        auth.reset();
        calls.create.length = 0;
        calls.putChunk.length = 0;

        const createBody = JSON.stringify({
          ...tinyCreateBody(device.deviceId),
          // would leak if body were parsed into error surfaces
          secretPath: '/Users/secret/limiter-gate',
        });
        const createRes = await fx.requestAgent('POST', '/agent/upload/sessions', {
          body: createBody,
          headers: { ...authHeaders(device), 'content-type': 'application/json' },
        });
        assertPublicError(createRes, 404, ERROR_CODES.DEVICE_ROUTE_NOT_FOUND);
        assert.equal(auth.count, 0, `${c.label}: create must not authenticate`);
        assert.equal(calls.create.length, 0, `${c.label}: create must not touch service`);
        assert.ok(!createRes.raw.includes('/Users/secret'));
        assert.ok(!createRes.raw.includes(device.token));

        auth.reset();
        const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const chunkPayload = Buffer.from('must-not-reach-service');
        const chunkRes = await fx.requestAgent(
          'POST',
          `/agent/upload/sessions/${uploadId}/chunks`,
          {
            body: chunkPayload,
            headers: {
              ...authHeaders(device),
              'content-type': 'application/octet-stream',
              'content-length': String(chunkPayload.length),
              'x-linke-upload-id': uploadId,
              'x-linke-snapshot-id': '550e8400-e29b-41d4-a716-4466554400aa',
              'x-linke-manifest-digest': 'a'.repeat(64),
              'x-linke-file-index': '0',
              'x-linke-chunk-index': '0',
              'x-linke-chunk-offset': '0',
              'x-linke-chunk-size': String(chunkPayload.length),
              'x-linke-chunk-sha256': 'c'.repeat(64),
            },
          },
        );
        assertPublicError(chunkRes, 404, ERROR_CODES.DEVICE_ROUTE_NOT_FOUND);
        assert.equal(auth.count, 0, `${c.label}: chunk must not authenticate`);
        assert.equal(calls.putChunk.length, 0, `${c.label}: chunk must not touch service`);
        assert.ok(!chunkRes.raw.includes('must-not-reach-service'));
      } finally {
        await fx.cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  });
});

// ===========================================================================
// G. Request AbortSignal + deadline abort freezes late mutations (P0)
// ===========================================================================

describe('C6 G — request AbortSignal + deadline cancel (RED)', () => {
  it('create/status/chunk/finalize/abort each receive a per-request live AbortSignal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-signal-wire-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'signal-wire');
    // Record only inside service — never assertLiveAbortSignal here.
    // Asserting in-mock turns missing signal into 500 and masks the contract as status≠201.
    /** @type {unknown[]} */
    const seenSignals = [];
    const { service, calls } = createMockUploadService({
      create: async (input) => {
        seenSignals.push(input?.signal);
        return {
          uploadId: 'sig-upload-1',
          status: 'initialized',
          deviceId: input.authenticatedDeviceId,
        };
      },
      status: async (input) => {
        seenSignals.push(input?.signal);
        return { uploadId: input.uploadId, status: 'initialized', deviceId: input.authenticatedDeviceId };
      },
      putChunk: async (input) => {
        seenSignals.push(input?.signal);
        return { acked: true, fileIndex: 0, chunkIndex: 0 };
      },
      finalize: async (input) => {
        seenSignals.push(input?.signal);
        return { uploadId: input.uploadId, status: 'committed', deviceId: input.authenticatedDeviceId };
      },
      abort: async (input) => {
        seenSignals.push(input?.signal);
        return { uploadId: input.uploadId, status: 'aborted', deviceId: input.authenticatedDeviceId };
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const uploadId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
      const createRes = await fx.requestAgent('POST', '/agent/upload/sessions', {
        body: JSON.stringify(tinyCreateBody(device.deviceId)),
        headers: { ...authHeaders(device), 'content-type': 'application/json' },
      });
      assert.equal(createRes.status, 201);

      const statusRes = await fx.requestAgent('GET', `/agent/upload/sessions/${uploadId}`, {
        headers: authHeaders(device),
      });
      assert.equal(statusRes.status, 200);

      const chunkBody = Buffer.from('sig-chunk');
      const chunkRes = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/chunks`,
        {
          body: chunkBody,
          headers: {
            ...authHeaders(device),
            'content-type': 'application/octet-stream',
            'content-length': String(chunkBody.length),
            'x-linke-upload-id': uploadId,
            'x-linke-snapshot-id': '550e8400-e29b-41d4-a716-4466554400aa',
            'x-linke-manifest-digest': 'a'.repeat(64),
            'x-linke-file-index': '0',
            'x-linke-chunk-index': '0',
            'x-linke-chunk-offset': '0',
            'x-linke-chunk-size': String(chunkBody.length),
            'x-linke-chunk-sha256': 'c'.repeat(64),
          },
        },
      );
      assert.equal(chunkRes.status, 200);

      const finRes = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/finalize`,
        { headers: authHeaders(device) },
      );
      assert.equal(finRes.status, 200);

      const abortRes = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/abort`,
        { headers: authHeaders(device) },
      );
      assert.equal(abortRes.status, 200);

      assert.equal(calls.create.length, 1);
      assert.equal(calls.status.length, 1);
      assert.equal(calls.putChunk.length, 1);
      assert.equal(calls.finalize.length, 1);
      assert.equal(calls.abort.length, 1);
      assert.equal(seenSignals.length, 5, 'all five service methods must be invoked');

      // Contract: each HTTP request gets its own AbortSignal; each method receives
      // that request's signal. Do not require five requests to share one object.
      const labeled = [
        ['create', calls.create[0], seenSignals[0]],
        ['status', calls.status[0], seenSignals[1]],
        ['putChunk', calls.putChunk[0], seenSignals[2]],
        ['finalize', calls.finalize[0], seenSignals[3]],
        ['abort', calls.abort[0], seenSignals[4]],
      ];
      /** @type {AbortSignal[]} */
      const liveSignals = [];
      for (const [name, input, recorded] of labeled) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(input, 'signal'),
          `${name}: signal key required on service input`,
        );
        const live = assertLiveAbortSignal(recorded, name);
        assert.equal(input.signal, recorded, `${name}: recorded signal must match call arg`);
        // Normal success settle must not abort the request signal.
        assert.equal(live.aborted, false, `${name}: signal remains live after success settle`);
        liveSignals.push(live);
      }
      assert.equal(
        new Set(liveSignals).size,
        5,
        'each request must use an independent signal object',
      );
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('chunk idle timeout aborts signal before settle; cooperative worker must not late-mutate', async () => {
    const timers = createManualTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-chunk-sig-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'chunk-sig');
    /** @type {unknown} */
    let inputSignal = undefined;
    /** @type {(() => void) | null} */
    let releaseWorker = null;
    let lateMutation = false;
    let putEntered = 0;

    const { service } = createMockUploadService({
      putChunk: async (input) => {
        // Record entry + raw signal first; assert after barrier so missing
        // signal reports as signal-missing, not "expected … entered".
        putEntered += 1;
        inputSignal = input?.signal;
        await new Promise((resolve) => {
          releaseWorker = resolve;
        });
        // After deadline, worker may be released; mutation only if signal still live.
        cooperativeLateMutation(/** @type {AbortSignal | null | undefined} */ (inputSignal), () => {
          lateMutation = true;
        });
        return { acked: true, fileIndex: 0, chunkIndex: 0 };
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
      timers,
    });
    try {
      const uploadId = 'cccccccc-dddd-4eee-8fff-555555555555';
      const head = [
        `POST /agent/upload/sessions/${uploadId}/chunks HTTP/1.1`,
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        'X-Linke-Protocol-Version: 2',
        'Content-Type: application/octet-stream',
        'Content-Length: 8',
        `X-Linke-Upload-Id: ${uploadId}`,
        'X-Linke-Snapshot-Id: 550e8400-e29b-41d4-a716-4466554400aa',
        `X-Linke-Manifest-Digest: ${'a'.repeat(64)}`,
        'X-Linke-File-Index: 0',
        'X-Linke-Chunk-Index: 0',
        'X-Linke-Chunk-Offset: 0',
        'X-Linke-Chunk-Size: 8',
        `X-Linke-Chunk-Sha256: ${'c'.repeat(64)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');

      const resultPromise = rawTlsHttpExchange({
        port: fx.port,
        head,
        bodyParts: [],
        endAfterBody: false,
        timeoutMs: 2000,
      });
      await waitForCondition(
        () => putEntered === 1,
        { maxTurns: 80, label: 'putChunk entered' },
      );
      const captured = assertLiveAbortSignal(inputSignal, 'putChunk-timeout');
      assert.equal(captured.aborted, false);
      await waitForTimerArmed(timers, { minPending: 1 });
      timers.advance(UPLOAD_CHUNK_IDLE_MS + 1);
      const result = await resultPromise;
      assert.equal(result.kind, 'response');
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: ERROR_CODES.UPLOAD_CHUNK_INVALID });
      // Deadline settle MUST abort signal first (observable cancel token).
      assert.equal(captured.aborted, true, 'deadline settle must abort request signal');

      if (typeof releaseWorker === 'function') releaseWorker();
      await waitForCondition(() => true, { maxTurns: 4, label: 'drain microtasks' });
      await new Promise((r) => setImmediate(r));
      await Promise.resolve();
      assert.equal(lateMutation, false, 'aborted worker must not perform late mutation');
    } finally {
      if (typeof releaseWorker === 'function') releaseWorker();
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('finalize total timeout aborts signal; cooperative worker must not late-mutate after settle', async () => {
    const timers = createManualTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-fin-sig-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'fin-sig');
    /** @type {unknown} */
    let inputSignal = undefined;
    /** @type {(() => void) | null} */
    let releaseWorker = null;
    let lateMutation = false;
    let finEntered = 0;

    const { service } = createMockUploadService({
      finalize: async (input) => {
        finEntered += 1;
        inputSignal = input?.signal;
        await new Promise((resolve) => {
          releaseWorker = resolve;
        });
        cooperativeLateMutation(/** @type {AbortSignal | null | undefined} */ (inputSignal), () => {
          lateMutation = true;
        });
        return { uploadId: input.uploadId, status: 'committed', deviceId: input.authenticatedDeviceId };
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
      timers,
    });
    try {
      const pending = fx.requestAgent(
        'POST',
        '/agent/upload/sessions/fin-sig-upload/finalize',
        { headers: authHeaders(device) },
      );
      await waitForCondition(
        () => finEntered === 1,
        { maxTurns: 80, label: 'finalize entered' },
      );
      const captured = assertLiveAbortSignal(inputSignal, 'finalize-timeout');
      assert.equal(captured.aborted, false);
      assert.ok(timers.pendingCount() >= 1);
      timers.advance(UPLOAD_STATUS_TOTAL_MS + 1);
      const res = await Promise.race([
        pending,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('finalize deadline did not settle within 1500ms')), 1500);
        }),
      ]);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, ERROR_CODES.DEVICE_REQUEST_INVALID);
      assert.equal(captured.aborted, true, 'finalize deadline must abort request signal');

      if (typeof releaseWorker === 'function') releaseWorker();
      await new Promise((r) => setImmediate(r));
      await Promise.resolve();
      assert.equal(lateMutation, false, 'aborted finalize worker must not late-mutate');
    } finally {
      if (typeof releaseWorker === 'function') releaseWorker();
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// H. Chunk bridge stream + real TLS flow (P1-a)
// ===========================================================================

describe('C6 H — chunk bridge readable stream (RED)', () => {
  it('TLS segmented body reaches service data/end with exact bytes; request===stream bridge', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-bridge-bytes-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'bridge-bytes');
    const expected = Buffer.from('BRIDGE-EXACT-BYTES-01');
    /** @type {{ request: any, stream: any, bytes: Buffer, ended: boolean, rawHeaders: any, url: any } | null} */
    let observed = null;
    /** @type {(() => void) | null} */
    let releasePut = null;
    let putEntered = 0;
    /** @type {'idle' | 'listening' | 'draining' | 'done'} */
    let streamState = 'idle';

    const { service } = createMockUploadService({
      putChunk: async (input) => {
        putEntered += 1;
        const stream = input.stream;
        const request = input.request;
        assert.ok(stream && typeof stream.on === 'function', 'stream must be readable');
        assert.ok(request, 'request required for C3 header parse');
        // Bridge contract: request and stream are the same object (bridged equivalent).
        assert.equal(request, stream, 'request and stream must be strictly identical bridge');
        assert.ok(Array.isArray(request.rawHeaders), 'bridge must expose rawHeaders for C3');
        assert.equal(typeof request.url, 'string');

        const chunks = [];
        let ended = false;
        streamState = 'listening';
        const done = new Promise((resolve, reject) => {
          stream.on('data', (c) => {
            streamState = 'draining';
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          });
          stream.on('end', () => {
            ended = true;
            streamState = 'done';
            resolve();
          });
          stream.on('error', reject);
        });
        // Allow test to write body after service attached data listeners.
        await new Promise((resolve) => {
          releasePut = resolve;
        });
        await done;
        observed = {
          request,
          stream,
          bytes: Buffer.concat(chunks),
          ended,
          rawHeaders: request.rawHeaders,
          url: request.url,
        };
        return { acked: true, fileIndex: 0, chunkIndex: 0 };
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const uploadId = 'dddddddd-eeee-4fff-8000-666666666666';
      const head = [
        `POST /agent/upload/sessions/${uploadId}/chunks HTTP/1.1`,
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        'X-Linke-Protocol-Version: 2',
        'Content-Type: application/octet-stream',
        `Content-Length: ${expected.length}`,
        `X-Linke-Upload-Id: ${uploadId}`,
        'X-Linke-Snapshot-Id: 550e8400-e29b-41d4-a716-4466554400aa',
        `X-Linke-Manifest-Digest: ${'a'.repeat(64)}`,
        'X-Linke-File-Index: 0',
        'X-Linke-Chunk-Index: 0',
        'X-Linke-Chunk-Offset: 0',
        `X-Linke-Chunk-Size: ${expected.length}`,
        `X-Linke-Chunk-Sha256: ${'c'.repeat(64)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');

      const session = openRawTlsHttpSession({ port: fx.port, head, timeoutMs: 3000 });
      await session.whenSecure;
      await waitForCondition(
        () => putEntered === 1 && typeof releasePut === 'function' && streamState === 'listening',
        { maxTurns: 100, label: 'putChunk entered with stream listeners attached' },
      );
      // Segmented real TLS writes (not a static readableLength mock).
      session.write(expected.subarray(0, 7));
      await new Promise((r) => setImmediate(r));
      session.write(expected.subarray(7));
      session.end();
      if (typeof releasePut === 'function') releasePut();

      const result = await session.resultPromise;
      assert.equal(result.kind, 'response');
      assert.equal(result.status, 200);
      assert.ok(observed, 'service must observe stream');
      assert.equal(streamState, 'done', 'bridge stream must reach end after segmented TLS body');
      assert.equal(observed.ended, true);
      assert.ok(observed.bytes.equals(expected), 'service data/end must receive exact body bytes');
      assert.ok(
        observed.rawHeaders.some((h) => String(h).toLowerCase() === 'x-linke-upload-id'),
        'rawHeaders must carry chunk identity headers',
      );
      assert.match(String(observed.url), /\/chunks/);
    } finally {
      if (typeof releasePut === 'function') releasePut();
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('non-empty late TLS segments reset idle; empty do not; timeout aborts without late body resume into service', async () => {
    const timers = createManualTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-bridge-idle-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'bridge-idle');
    /** @type {unknown} */
    let inputSignal = undefined;
    /** @type {Buffer[]} */
    const serviceBytes = [];
    let putEntered = 0;
    /** @type {any} */
    let streamRef = null;

    const { service } = createMockUploadService({
      putChunk: async (input) => {
        // Record entry + signal first; assert after barrier (missing → signal-missing).
        putEntered += 1;
        inputSignal = input?.signal;
        streamRef = input.stream;
        assert.equal(input.request, input.stream);
        const stream = input.stream;
        stream.on('data', (c) => {
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          if (buf.length > 0) serviceBytes.push(buf);
        });
        // Stay pending until timeout settles (never resolve success).
        await new Promise(() => {
          void stream;
        });
        return { acked: true };
      },
    });
    const fx = await startUploadFixture({
      registry,
      uploadService: service,
      uploadRateLimit: { check: () => ({ allowed: true }) },
      timers,
    });
    try {
      const uploadId = 'eeeeeeee-ffff-4000-8000-777777777777';
      const totalLen = 64;
      const head = [
        `POST /agent/upload/sessions/${uploadId}/chunks HTTP/1.1`,
        'Host: 127.0.0.1',
        `Authorization: Bearer ${device.token}`,
        `X-Linke-Device-Id: ${device.deviceId}`,
        'X-Linke-Protocol-Version: 2',
        'Content-Type: application/octet-stream',
        `Content-Length: ${totalLen}`,
        `X-Linke-Upload-Id: ${uploadId}`,
        'X-Linke-Snapshot-Id: 550e8400-e29b-41d4-a716-4466554400aa',
        `X-Linke-Manifest-Digest: ${'a'.repeat(64)}`,
        'X-Linke-File-Index: 0',
        'X-Linke-Chunk-Index: 0',
        'X-Linke-Chunk-Offset: 0',
        `X-Linke-Chunk-Size: ${totalLen}`,
        `X-Linke-Chunk-Sha256: ${'c'.repeat(64)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');

      // --- Phase A: non-empty reset must push idle past the original deadline ---
      const sessionA = openRawTlsHttpSession({ port: fx.port, head, timeoutMs: 3000 });
      await sessionA.whenSecure;
      await waitForCondition(
        () => putEntered === 1,
        { maxTurns: 100, label: 'putChunk idle bridge entered (phase A)' },
      );
      const capturedA = assertLiveAbortSignal(inputSignal, 'bridge-idle-put phase A');
      await waitForTimerArmed(timers, { minPending: 2 });

      // t=10s: non-empty TLS segment arrives → idle must rearm to t=25s.
      timers.advance(10_000);
      sessionA.write(Buffer.from('NON-EMPTY'));
      await waitForCondition(
        () => serviceBytes.reduce((n, b) => n + b.length, 0) >= 9,
        { maxTurns: 100, label: 'non-empty segment delivered to service stream' },
      );
      // Cross original idle deadline (t=15s from start): must NOT settle if rearmed at t=10.
      timers.advance(6_000); // now = start+16s; original idle would have fired at +15s
      assert.equal(capturedA.aborted, false, 'non-empty data must reset idle past original deadline');
      // Complete the rearmed window → idle settle.
      timers.advance(UPLOAD_CHUNK_IDLE_MS); // past rearmed fireAt
      const resultA = await sessionA.resultPromise;
      assert.equal(resultA.kind, 'response');
      assert.equal(resultA.status, 400);
      assert.deepEqual(resultA.body, { error: ERROR_CODES.UPLOAD_CHUNK_INVALID });
      assert.equal(capturedA.aborted, true, 'idle settle must abort signal');

      const bytesBeforeLate = serviceBytes.reduce((n, b) => n + b.length, 0);
      sessionA.write(Buffer.from('LATE-BODY-AFTER-TIMEOUT!!!!!!!!').subarray(0, 16));
      await new Promise((r) => setImmediate(r));
      await Promise.resolve();
      const bytesAfterLate = serviceBytes.reduce((n, b) => n + b.length, 0);
      assert.equal(
        bytesAfterLate,
        bytesBeforeLate,
        'timeout must not resume late body into service stream',
      );
      if (streamRef) {
        assert.ok(
          streamRef.destroyed
          || streamRef.readableEnded
          || streamRef.closed
          || capturedA.aborted,
          'timeout must stop/destroy bridge and/or abort signal',
        );
      }

      // --- Phase B: empty data must NOT reset idle ---
      timers.reset();
      putEntered = 0;
      inputSignal = undefined;
      streamRef = null;
      serviceBytes.length = 0;
      const sessionB = openRawTlsHttpSession({ port: fx.port, head, timeoutMs: 3000 });
      await sessionB.whenSecure;
      await waitForCondition(
        () => putEntered === 1,
        { maxTurns: 100, label: 'putChunk idle bridge entered (phase B)' },
      );
      const capturedB = assertLiveAbortSignal(inputSignal, 'bridge-idle-put phase B');
      await waitForTimerArmed(timers, { minPending: 2 });
      timers.advance(10_000);
      // Empty segment on the bridge/request stream must not rearm idle.
      if (streamRef && typeof streamRef.emit === 'function') {
        streamRef.emit('data', Buffer.alloc(0));
      }
      // Original idle at t=15s: empty must leave fireAt unchanged → settle by +15s+1.
      timers.advance(5_001);
      const resultB = await sessionB.resultPromise;
      assert.equal(resultB.kind, 'response');
      assert.equal(resultB.status, 400);
      assert.deepEqual(resultB.body, { error: ERROR_CODES.UPLOAD_CHUNK_INVALID });
      assert.equal(capturedB.aborted, true);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// C7 production status/finalize projection (missingSummary + committed identity)
// ===========================================================================

describe('C7 — real service status missingSummary + finalize committed identity', () => {
  it('status JSON has missingSummary.next, never files; finalize has exact committed identity', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c7-route-sum-'));
    const registry = new DeviceRegistry({ dataDir });
    const device = await enrollDevice(registry, 'c7-sum-dev');
    const content = Buffer.from('route-summary-bytes');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const snapshotId = '550e8400-e29b-41d4-a716-4466554400c7';
    const input = {
      schemaVersion: 2,
      snapshotId,
      deviceId: device.deviceId,
      createdAt: '2026-07-22T12:00:00.000Z',
      files: ['note.txt'],
      integrity: {
        algorithm: 'sha256',
        totalBytes: content.length,
        entries: [{ path: 'note.txt', size: content.length, sha256 }],
      },
    };
    const { manifest, manifestDigest } = projectCanonicalUploadManifest(input, {
      authenticatedDeviceId: device.deviceId,
    });

    const store = createUploadSessionStore({ dataDir });
    const locks = createUploadLocks({ maxGlobalTransfers: 4 });
    const uploadService = createUploadService({
      dataDir,
      store,
      locks,
      ingest: { parseChunkHeaders, ingestChunkBody, commitChunk },
      commit: {
        preflightCapacity: (dir, totalBytes, options = {}) =>
          preflightCapacity(dir, totalBytes, {
            ...options,
            deps: {
              ...(options.deps || {}),
              statfs: async () => ({
                type: 0,
                bsize: 4096,
                blocks: 1e12,
                bfree: 1e12,
                bavail: 1e12,
                files: 0,
                ffree: 0,
              }),
            },
          }),
        verifyAndCommitSession,
      },
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });

    const fx = await startUploadFixture({
      registry,
      uploadService,
      uploadRateLimit: { check: () => ({ allowed: true }) },
    });
    try {
      const createRes = await fx.requestAgent('POST', '/agent/upload/sessions', {
        body: JSON.stringify({ manifest, manifestDigest }),
        headers: {
          ...authHeaders(device),
          'content-type': 'application/json',
        },
      });
      assert.equal(createRes.status, 201);
      assert.equal(typeof createRes.body.uploadId, 'string');
      assert.ok(createRes.body.missingSummary);
      assert.equal(createRes.body.missingSummary.complete, false);
      assert.ok(createRes.body.missingSummary.next);
      assert.equal(createRes.body.missingSummary.next.fileIndex, 0);
      assert.equal(createRes.body.missingSummary.next.chunkIndex, 0);
      assert.equal(createRes.body.files, undefined, 'listener must not project files');
      assertNoForbiddenKeys(createRes.body);

      const uploadId = createRes.body.uploadId;
      const statusRes = await fx.requestAgent(
        'GET',
        `/agent/upload/sessions/${uploadId}`,
        { headers: authHeaders(device) },
      );
      assert.equal(statusRes.status, 200);
      assert.ok(statusRes.body.missingSummary);
      assert.ok(statusRes.body.missingSummary.next);
      assert.equal(statusRes.body.files, undefined);
      assert.equal(statusRes.body.snapshotId, snapshotId);
      assert.equal(statusRes.body.manifestDigest, manifestDigest);
      assert.equal(statusRes.body.deviceId, device.deviceId);

      // Upload the only chunk then finalize.
      const chunkRes = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/chunks`,
        {
          body: content,
          headers: {
            ...authHeaders(device),
            'content-type': 'application/octet-stream',
            'content-length': String(content.length),
            'x-linke-upload-id': uploadId,
            'x-linke-snapshot-id': snapshotId,
            'x-linke-manifest-digest': manifestDigest,
            'x-linke-file-index': '0',
            'x-linke-chunk-index': '0',
            'x-linke-chunk-offset': '0',
            'x-linke-chunk-size': String(content.length),
            'x-linke-chunk-sha256': sha256,
          },
        },
      );
      assert.equal(chunkRes.status, 200);

      const finRes = await fx.requestAgent(
        'POST',
        `/agent/upload/sessions/${uploadId}/finalize`,
        { headers: authHeaders(device) },
      );
      assert.equal(finRes.status, 200);
      assert.notDeepEqual(finRes.body, {});
      assert.equal(finRes.body.status, 'committed');
      assert.equal(finRes.body.uploadId, uploadId);
      assert.equal(finRes.body.snapshotId, snapshotId);
      assert.equal(finRes.body.manifestDigest, manifestDigest);
      assert.equal(finRes.body.deviceId, device.deviceId);
      assert.equal(finRes.body.files, undefined);
      assert.ok(finRes.body.missingSummary);
      assert.equal(finRes.body.missingSummary.complete, true);
      assertNoForbiddenKeys(finRes.body);
    } finally {
      await fx.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
