/**
 * C7 — Pinned upload client: resume / abort / 429 dual-code / 507 / conflict fail-close.
 * Authority: design §6.5 / §9.4 / §10 + plan C7.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate, randomUUID } from 'node:crypto';
import https from 'node:https';
import { mkdir, writeFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DeviceCredentialStore,
  requestPinnedBinary,
  uploadSnapshotResumable,
  abortUploadSession,
  DEFAULT_UPLOAD_MAX_RESUME_ATTEMPTS,
} from '../src/device-client.js';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../src/tls-identity-store.js';
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';

const openServers = new Set();
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const DEVICE = 'device-upload-client';
const SNAP_A = '550e8400-e29b-41d4-a716-4466554400aa';
const SNAP_B = '550e8400-e29b-41d4-a716-4466554400bb';
const T0 = '2026-07-22T12:00:00.000Z';
const TOKEN = 'upload-client-fixture-token-32chars!!';

function memoryKeychain(map = new Map()) {
  return {
    async get(id) {
      if (!map.has(id)) {
        const error = new Error('keychain-item-missing');
        error.code = 'keychain-item-missing';
        throw error;
      }
      return map.get(id);
    },
    async set(id, value) {
      map.set(id, value);
    },
    async delete(id) {
      return map.delete(id);
    },
  };
}

function memoryCredentialStore(map = new Map()) {
  return new DeviceCredentialStore({ keychain: memoryKeychain(map) });
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

function errorText(error) {
  if (!error || typeof error !== 'object') return String(error);
  const err = /** @type {Error & { code?: string, retryAfterSec?: number }} */ (error);
  return `${err}\n${err.message || ''}\n${err.stack || ''}\n${err.code || ''}\n${err.retryAfterSec ?? ''}`;
}

async function startHttpsFixture(handler) {
  const { keyPem } = generateControllerPrivateKey();
  const certPem = await createOpenSslCertificate({
    keyPem,
    san: 'IP:127.0.0.1',
  });
  const certificate = new X509Certificate(certPem);
  const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  const server = https.createServer({ key: keyPem, cert: certPem }, handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.add(server);
  const { port } = server.address();
  return {
    url: `https://127.0.0.1:${port}`,
    fingerprint,
    server,
    close: () => new Promise((resolve, reject) => {
      openServers.delete(server);
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/**
 * @param {{ path: string, content: Buffer | string }[]} files
 * @param {{ deviceId?: string, snapshotId?: string }} [opts]
 */
function makeManifest(files, opts = {}) {
  const deviceId = opts.deviceId ?? DEVICE;
  const snapshotId = opts.snapshotId ?? SNAP_A;
  const entries = files.map((f) => {
    const content = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    return {
      path: f.path,
      size: content.length,
      sha256: content.length === 0
        ? ZERO_SHA
        : createHash('sha256').update(content).digest('hex'),
      content,
    };
  });
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  const input = {
    schemaVersion: 2,
    snapshotId,
    deviceId,
    createdAt: T0,
    files: entries.map((e) => e.path),
    integrity: {
      algorithm: 'sha256',
      totalBytes,
      entries: entries.map((e) => ({ path: e.path, size: e.size, sha256: e.sha256 })),
    },
  };
  const { manifest, manifestDigest } = projectCanonicalUploadManifest(input, {
    authenticatedDeviceId: deviceId,
  });
  return { manifest, manifestDigest, entries, deviceId, snapshotId };
}

/**
 * @param {{ path: string, content: Buffer | string }[]} files
 */
async function writeSnapshotRoot(files) {
  const root = await mkdtemp(join(tmpdir(), 'linke-c7-snap-'));
  for (const f of files) {
    const abs = join(root, f.path);
    await mkdir(join(abs, '..'), { recursive: true });
    const content = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    await writeFile(abs, content);
  }
  return root;
}

after(async () => {
  for (const server of [...openServers]) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  openServers.clear();
});

describe('requestPinnedBinary pin / shape / 429 / 507', () => {
  it('pin mismatch never writes body (binary or JSON)', async () => {
    let sawBody = false;
    const server = await startHttpsFixture((req, res) => {
      req.on('data', () => {
        sawBody = true;
      });
      req.on('end', () => sendJson(res, 200, { ok: true }));
    });
    try {
      await assert.rejects(
        requestPinnedBinary({
          agentUrl: server.url,
          path: '/agent/upload/sessions',
          tlsFingerprint: '0'.repeat(64),
          token: TOKEN,
          deviceId: DEVICE,
          body: { manifest: { x: 1 }, manifestDigest: 'a'.repeat(64) },
          bodyMode: 'json',
        }),
        (e) => e.code === ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH,
      );
      assert.equal(sawBody, false);
    } finally {
      await server.close();
    }
  });

  it('distinguishes device-rate-limited vs upload-backpressure on 429 + bounded Retry-After', async () => {
    let n = 0;
    const server = await startHttpsFixture((req, res) => {
      n += 1;
      if (n === 1) {
        return sendJson(res, 429, { error: ERROR_CODES.DEVICE_RATE_LIMITED }, { 'retry-after': '45' });
      }
      return sendJson(res, 429, { error: ERROR_CODES.UPLOAD_BACKPRESSURE }, { 'retry-after': '0' });
    });
    try {
      await assert.rejects(
        requestPinnedBinary({
          agentUrl: server.url,
          path: '/agent/upload/sessions',
          tlsFingerprint: server.fingerprint,
          token: TOKEN,
          deviceId: DEVICE,
          bodyMode: 'none',
        }),
        (e) => e instanceof LinkeError
          && e.code === ERROR_CODES.DEVICE_RATE_LIMITED
          && e.statusCode === 429
          && e.retryable === true
          && e.retryAfterSec === 30, // clamped
      );
      await assert.rejects(
        requestPinnedBinary({
          agentUrl: server.url,
          path: '/agent/upload/sessions',
          tlsFingerprint: server.fingerprint,
          token: TOKEN,
          deviceId: DEVICE,
          bodyMode: 'none',
        }),
        (e) => e instanceof LinkeError
          && e.code === ERROR_CODES.UPLOAD_BACKPRESSURE
          && e.statusCode === 429
          && e.retryable === true
          && e.retryAfterSec === 1, // floor
      );
    } finally {
      await server.close();
    }
  });

  it('maps HTTP 507 + upload-capacity-insufficient by numeric status (not WebDAV special-case)', async () => {
    const server = await startHttpsFixture((req, res) => {
      sendJson(res, 507, { error: ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT });
    });
    try {
      await assert.rejects(
        requestPinnedBinary({
          agentUrl: server.url,
          path: '/agent/upload/sessions',
          tlsFingerprint: server.fingerprint,
          token: TOKEN,
          deviceId: DEVICE,
          body: { manifest: {}, manifestDigest: 'b'.repeat(64) },
          bodyMode: 'json',
        }),
        (e) => e instanceof LinkeError
          && e.code === ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT
          && e.statusCode === 507
          && e.retryable === false
          && !errorText(e).includes('WebDAV')
          && !errorText(e).includes('Insufficient Storage'),
      );
    } finally {
      await server.close();
    }
  });

  it('429 unknown / registered-but-wrong codes fail-close without retryAfterSec', async () => {
    let n = 0;
    const server = await startHttpsFixture((req, res) => {
      n += 1;
      if (n === 1) {
        return sendJson(res, 429, { error: 'not-a-registered-code' }, { 'retry-after': '5' });
      }
      if (n === 2) {
        // Registered but wrong for 429 (must not keep 429 semantics / Retry-After).
        return sendJson(res, 429, { error: ERROR_CODES.UPLOAD_SESSION_CONFLICT }, { 'retry-after': '9' });
      }
      return sendJson(res, 429, { error: ERROR_CODES.DEVICE_REQUEST_INVALID }, { 'retry-after': '3' });
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        await assert.rejects(
          requestPinnedBinary({
            agentUrl: server.url,
            path: '/agent/upload/sessions',
            tlsFingerprint: server.fingerprint,
            token: TOKEN,
            deviceId: DEVICE,
            bodyMode: 'none',
          }),
          (e) => e instanceof LinkeError
            && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
            && e.retryAfterSec === undefined
            && e.code !== ERROR_CODES.DEVICE_RATE_LIMITED
            && e.code !== ERROR_CODES.UPLOAD_BACKPRESSURE,
        );
      }
    } finally {
      await server.close();
    }
  });

  it('507 unknown / wrong codes fail-close (no coerce to capacity-insufficient)', async () => {
    let n = 0;
    const server = await startHttpsFixture((req, res) => {
      n += 1;
      if (n === 1) {
        return sendJson(res, 507, { error: 'totally-unknown' });
      }
      if (n === 2) {
        return sendJson(res, 507, { error: ERROR_CODES.UPLOAD_IO_ERROR });
      }
      // Non-object body
      const data = JSON.stringify(['x']);
      res.writeHead(507, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      });
      res.end(data);
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        await assert.rejects(
          requestPinnedBinary({
            agentUrl: server.url,
            path: '/agent/upload/sessions',
            tlsFingerprint: server.fingerprint,
            token: TOKEN,
            deviceId: DEVICE,
            bodyMode: 'none',
          }),
          (e) => e instanceof LinkeError
            && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
            && e.code !== ERROR_CODES.UPLOAD_CAPACITY_INSUFFICIENT,
        );
      }
    } finally {
      await server.close();
    }
  });

  it('fail-closes hostile non-object error bodies', async () => {
    const server = await startHttpsFixture((req, res) => {
      const data = JSON.stringify(['not-an-object']);
      res.writeHead(400, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      });
      res.end(data);
    });
    try {
      await assert.rejects(
        requestPinnedBinary({
          agentUrl: server.url,
          path: '/agent/upload/sessions/u',
          tlsFingerprint: server.fingerprint,
          method: 'GET',
          token: TOKEN,
          deviceId: DEVICE,
        }),
        (e) => e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
      );
    } finally {
      await server.close();
    }
  });
});

describe('uploadSnapshotResumable resume / corrupt / abort / conflict / exhausted', () => {
  it('disconnect mid-chunk then status resume completes remaining chunks', async () => {
    const files = [
      { path: 'a.txt', content: 'hello-resume-payload' },
      { path: 'empty.dat', content: Buffer.alloc(0) },
    ];
    const { manifest, manifestDigest, snapshotId } = makeManifest(files);
    const root = await writeSnapshotRoot(files);
    const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001';
    let chunkAttempts = 0;
    let createCount = 0;
    let statusCount = 0;
    let finalizeCount = 0;
    /** @type {string[]} */
    const methods = [];

    const server = await startHttpsFixture((req, res) => {
      methods.push(`${req.method} ${req.url}`);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/agent/upload/sessions') {
          createCount += 1;
          // assert auth triad present
          assert.equal(req.headers['x-linke-device-id'], DEVICE);
          assert.match(String(req.headers.authorization || ''), /^Bearer /);
          assert.equal(req.headers['x-linke-protocol-version'], '2');
          return sendJson(res, 201, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'initialized',
          });
        }
        if (req.method === 'GET' && req.url === `/agent/upload/sessions/${uploadId}`) {
          statusCount += 1;
          return sendJson(res, 200, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'receiving',
            missingSummary: {
              complete: false,
              next: {
                fileIndex: 0,
                chunkIndex: 0,
                offset: 0,
                size: files[0].content.length,
                complete: false,
              },
              remainingFiles: 1,
              remainingBytes: files[0].content.length,
              remainingChunks: 1,
            },
          });
        }
        if (req.method === 'POST' && req.url === `/agent/upload/sessions/${uploadId}/chunks`) {
          chunkAttempts += 1;
          if (chunkAttempts === 1) {
            // Simulate disconnect: destroy without response.
            res.socket?.destroy();
            return;
          }
          const body = Buffer.concat(chunks);
          assert.ok(body.length > 0);
          // empty file must never produce a chunk request
          assert.notEqual(body.length, 0);
          return sendJson(res, 200, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'receiving',
          });
        }
        if (req.method === 'POST' && req.url === `/agent/upload/sessions/${uploadId}/finalize`) {
          finalizeCount += 1;
          return sendJson(res, 200, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'committed',
          });
        }
        return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
      });
    });

    const credentialStore = memoryCredentialStore();
    await credentialStore.setToken(server.url, DEVICE, TOKEN);
    try {
      const result = await uploadSnapshotResumable({
        agentUrl: server.url,
        tlsFingerprint: server.fingerprint,
        deviceId: DEVICE,
        credentialStore,
        snapshotRoot: root,
        manifest,
        manifestDigest,
        maxResumeAttempts: 3,
        delayMs: async () => {},
      });
      assert.equal(result.status, 'committed');
      assert.equal(result.uploadId, uploadId);
      assert.equal(createCount, 1);
      assert.ok(chunkAttempts >= 2, 'first disconnect then retry');
      assert.ok(statusCount >= 1, 'status resume after disconnect');
      assert.equal(finalizeCount, 1);
      // 0-byte empty.dat must not generate a chunk route
      assert.ok(!methods.some((m) => m.includes('/chunks') && m.includes('empty')));
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('corrupt chunk body is rejected (integrity) and not auto-resumed forever', async () => {
    const files = [{ path: 'a.txt', content: 'good-bytes' }];
    const { manifest, manifestDigest, snapshotId } = makeManifest(files);
    // Write different bytes than manifest claims.
    const root = await writeSnapshotRoot([{ path: 'a.txt', content: 'BAD-BYTES!!' }]);
    const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0002';
    let integrityHits = 0;

    const server = await startHttpsFixture((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
          return sendJson(res, 201, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'initialized',
          });
        }
        if (String(req.url).endsWith('/chunks')) {
          // Server verifies body hash vs header; simulate integrity fail on mismatch path.
          // Client sends hash of actual (corrupt) bytes — mock rejects as integrity-failed.
          integrityHits += 1;
          return sendJson(res, 409, { error: ERROR_CODES.UPLOAD_INTEGRITY_FAILED });
        }
        return sendJson(res, 404, { error: ERROR_CODES.UPLOAD_SESSION_NOT_FOUND });
      });
    });

    const credentialStore = memoryCredentialStore();
    await credentialStore.setToken(server.url, DEVICE, TOKEN);
    try {
      await assert.rejects(
        uploadSnapshotResumable({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: DEVICE,
          credentialStore,
          snapshotRoot: root,
          manifest,
          manifestDigest,
          maxResumeAttempts: 5,
          delayMs: async () => {},
        }),
        (e) => e instanceof LinkeError
          && e.code === ERROR_CODES.UPLOAD_INTEGRITY_FAILED
          && e.statusCode === 409,
      );
      assert.equal(integrityHits, 1, 'non-retryable integrity must not loop');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('explicit abortUploadSession then new session create is allowed', async () => {
    const uploadIdOld = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee00a1';
    const uploadIdNew = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee00a2';
    let aborted = false;
    let creates = 0;
    const server = await startHttpsFixture((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (String(req.url).endsWith('/abort')) {
          assert.equal(req.headers['x-linke-device-id'], DEVICE);
          aborted = true;
          return sendJson(res, 200, {
            uploadId: uploadIdOld,
            status: 'aborted',
            deviceId: DEVICE,
          });
        }
        if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
          creates += 1;
          if (!aborted) {
            return sendJson(res, 201, {
              uploadId: uploadIdOld,
              snapshotId: SNAP_A,
              manifestDigest: 'c'.repeat(64),
              status: 'initialized',
              deviceId: DEVICE,
            });
          }
          return sendJson(res, 201, {
            uploadId: uploadIdNew,
            snapshotId: SNAP_B,
            manifestDigest: 'd'.repeat(64),
            status: 'initialized',
            deviceId: DEVICE,
          });
        }
        return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
      });
    });
    const credentialStore = memoryCredentialStore();
    await credentialStore.setToken(server.url, DEVICE, TOKEN);
    try {
      const abortedRes = await abortUploadSession({
        agentUrl: server.url,
        tlsFingerprint: server.fingerprint,
        deviceId: DEVICE,
        uploadId: uploadIdOld,
        credentialStore,
      });
      assert.equal(abortedRes.status, 'aborted');
      assert.equal(aborted, true);

      // Minimal create via requestPinnedBinary after abort
      const created = await requestPinnedBinary({
        agentUrl: server.url,
        path: '/agent/upload/sessions',
        tlsFingerprint: server.fingerprint,
        token: TOKEN,
        deviceId: DEVICE,
        body: {
          manifest: { snapshotId: SNAP_B },
          manifestDigest: 'd'.repeat(64),
        },
        bodyMode: 'json',
      });
      assert.equal(created.uploadId, uploadIdNew);
      assert.equal(creates, 1);
    } finally {
      await server.close();
    }
  });

  it('active different snapshot conflict fail-closes; client never auto-aborts/preempts', async () => {
    const files = [{ path: 'a.txt', content: 'x' }];
    const { manifest, manifestDigest } = makeManifest(files, { snapshotId: SNAP_B });
    const root = await writeSnapshotRoot(files);
    let abortCalls = 0;
    let createCalls = 0;

    const server = await startHttpsFixture((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (String(req.url).endsWith('/abort')) {
          abortCalls += 1;
          return sendJson(res, 200, { status: 'aborted' });
        }
        if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
          createCalls += 1;
          return sendJson(res, 409, { error: ERROR_CODES.UPLOAD_SESSION_CONFLICT });
        }
        return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
      });
    });

    const credentialStore = memoryCredentialStore();
    await credentialStore.setToken(server.url, DEVICE, TOKEN);
    try {
      await assert.rejects(
        uploadSnapshotResumable({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: DEVICE,
          credentialStore,
          snapshotRoot: root,
          manifest,
          manifestDigest,
          maxResumeAttempts: 3,
          delayMs: async () => {},
        }),
        (e) => e instanceof LinkeError
          && e.code === ERROR_CODES.UPLOAD_SESSION_CONFLICT
          && e.statusCode === 409,
      );
      assert.equal(createCalls, 1);
      assert.equal(abortCalls, 0, 'must not auto-abort active different snapshot');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resume budget exhausted → local UPLOAD_RESUME_EXHAUSTED with statusCode null (HTTP N/A)', async () => {
    const files = [{ path: 'a.txt', content: 'payload' }];
    const { manifest, manifestDigest, snapshotId } = makeManifest(files);
    const root = await writeSnapshotRoot(files);
    const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee00e1';
    let chunkHits = 0;

    const server = await startHttpsFixture((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
          return sendJson(res, 201, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'initialized',
          });
        }
        if (req.method === 'GET' && String(req.url).includes(uploadId)) {
          return sendJson(res, 200, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'receiving',
          });
        }
        if (String(req.url).endsWith('/chunks')) {
          chunkHits += 1;
          // Always transport-fail: destroy socket.
          res.socket?.destroy();
          return;
        }
        return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
      });
    });

    const credentialStore = memoryCredentialStore();
    await credentialStore.setToken(server.url, DEVICE, TOKEN);
    try {
      await assert.rejects(
        uploadSnapshotResumable({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: DEVICE,
          credentialStore,
          snapshotRoot: root,
          manifest,
          manifestDigest,
          maxResumeAttempts: 2,
          delayMs: async () => {},
        }),
        (e) => e instanceof LinkeError
          && e.code === ERROR_CODES.UPLOAD_RESUME_EXHAUSTED
          && e.statusCode === null
          && e.retryable === false
          && e.message === ERROR_CODES.UPLOAD_RESUME_EXHAUSTED
          && !errorText(e).includes('127.0.0.1')
          && !errorText(e).includes(TOKEN)
          && !errorText(e).includes(root),
      );
      assert.ok(chunkHits >= 1);
      assert.ok(chunkHits <= DEFAULT_UPLOAD_MAX_RESUME_ATTEMPTS + 3);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('local snapshot read rejects missing file without leaking path/errno', async () => {
    const files = [{ path: 'a.txt', content: 'data' }];
    const { manifest, manifestDigest, snapshotId } = makeManifest(files);
    const root = await mkdtemp(join(tmpdir(), 'linke-c7-missing-'));
    const uploadId = randomUUID();
    const server = await startHttpsFixture((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/agent/upload/sessions') {
          return sendJson(res, 201, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'initialized',
          });
        }
        return sendJson(res, 500, { error: ERROR_CODES.DEVICE_INTERNAL_ERROR });
      });
    });
    const credentialStore = memoryCredentialStore();
    await credentialStore.setToken(server.url, DEVICE, TOKEN);
    try {
      await assert.rejects(
        uploadSnapshotResumable({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: DEVICE,
          credentialStore,
          snapshotRoot: root,
          manifest,
          manifestDigest,
          maxResumeAttempts: 0,
          delayMs: async () => {},
        }),
        (e) => {
          const text = errorText(e);
          return e instanceof LinkeError
            && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
            && !text.includes(root)
            && !text.includes('a.txt')
            && !text.includes('ENOENT')
            && !text.includes('errno');
        },
      );
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('P0 ancestor symlink escape is rejected before any chunk body upload', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-c7-outside-'));
    const outsideFile = join(outside, 'secret-outside.bin');
    await writeFile(outsideFile, Buffer.from('OUTSIDE-SECRET-BYTES'));
    const root = await mkdtemp(join(tmpdir(), 'linke-c7-root-'));
    // root/legit is a symlink to outside dir; manifest path legit/evil points outside.
    await symlink(outside, join(root, 'legit'));
    const files = [{ path: 'legit/evil', content: Buffer.from('OUTSIDE-SECRET-BYTES') }];
    const { manifest, manifestDigest, snapshotId } = makeManifest(files);
    const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee00f1';
    let chunkCount = 0;
    let sawChunkBody = false;
    const server = await startHttpsFixture((req, res) => {
      const chunks = [];
      req.on('data', (c) => {
        if (String(req.url).includes('/chunks')) {
          sawChunkBody = true;
          chunkCount += 1;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
          return sendJson(res, 201, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'initialized',
          });
        }
        return sendJson(res, 500, { error: ERROR_CODES.DEVICE_INTERNAL_ERROR });
      });
    });
    const credentialStore = memoryCredentialStore();
    await credentialStore.setToken(server.url, DEVICE, TOKEN);
    try {
      await assert.rejects(
        uploadSnapshotResumable({
          agentUrl: server.url,
          tlsFingerprint: server.fingerprint,
          deviceId: DEVICE,
          credentialStore,
          snapshotRoot: root,
          manifest,
          manifestDigest,
          maxResumeAttempts: 0,
          delayMs: async () => {},
        }),
        (e) => {
          const text = errorText(e);
          return e instanceof LinkeError
            && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
            && !text.includes(outside)
            && !text.includes(outsideFile)
            && !text.includes('OUTSIDE-SECRET')
            && !text.includes('ENOENT')
            && !text.includes('ELOOP')
            && !text.includes('errno')
            && !text.includes(root);
        },
      );
      assert.equal(chunkCount, 0);
      assert.equal(sawChunkBody, false);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('create success with wrong identity/status/illegal uploadId fail-closes; zero chunk/finalize', async () => {
    const files = [{ path: 'a.txt', content: 'x' }];
    const { manifest, manifestDigest, snapshotId } = makeManifest(files);
    const root = await writeSnapshotRoot(files);
    const cases = [
      {
        label: 'wrong deviceId',
        body: {
          uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0101',
          snapshotId,
          manifestDigest,
          deviceId: 'other-device',
          status: 'initialized',
        },
      },
      {
        label: 'wrong snapshotId',
        body: {
          uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0102',
          snapshotId: SNAP_B,
          manifestDigest,
          deviceId: DEVICE,
          status: 'initialized',
        },
      },
      {
        label: 'wrong manifestDigest',
        body: {
          uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0103',
          snapshotId,
          manifestDigest: 'f'.repeat(64),
          deviceId: DEVICE,
          status: 'initialized',
        },
      },
      {
        label: 'illegal uploadId',
        body: {
          uploadId: 'not-a-uuid',
          snapshotId,
          manifestDigest,
          deviceId: DEVICE,
          status: 'initialized',
        },
      },
      {
        label: 'terminal status committed',
        body: {
          uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0104',
          snapshotId,
          manifestDigest,
          deviceId: DEVICE,
          status: 'committed',
        },
      },
      {
        label: 'bad status',
        body: {
          uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0105',
          snapshotId,
          manifestDigest,
          deviceId: DEVICE,
          status: 'aborted',
        },
      },
    ];

    for (const c of cases) {
      let chunkCount = 0;
      let finalizeCount = 0;
      const server = await startHttpsFixture((req, res) => {
        const chunks = [];
        req.on('data', (x) => chunks.push(x));
        req.on('end', () => {
          if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
            return sendJson(res, 201, c.body);
          }
          if (String(req.url).endsWith('/chunks')) {
            chunkCount += 1;
            return sendJson(res, 200, {
              uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0101',
              snapshotId: SNAP_A,
              manifestDigest: 'f'.repeat(64),
              deviceId: DEVICE,
              status: 'receiving',
            });
          }
          if (String(req.url).endsWith('/finalize')) {
            finalizeCount += 1;
            return sendJson(res, 200, { status: 'committed' });
          }
          return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
        });
      });
      const credentialStore = memoryCredentialStore();
      await credentialStore.setToken(server.url, DEVICE, TOKEN);
      try {
        await assert.rejects(
          uploadSnapshotResumable({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: DEVICE,
            credentialStore,
            snapshotRoot: root,
            manifest,
            manifestDigest,
            maxResumeAttempts: 1,
            delayMs: async () => {},
          }),
          (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
          c.label,
        );
        assert.equal(chunkCount, 0, c.label);
        assert.equal(finalizeCount, 0, c.label);
      } finally {
        await server.close();
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it('finalize {} / missing fields / wrong identity / non-committed fail-close', async () => {
    const files = [{ path: 'a.txt', content: 'ok' }];
    const { manifest, manifestDigest, snapshotId } = makeManifest(files);
    const root = await writeSnapshotRoot(files);
    const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0201';
    const finalizeBodies = [
      {},
      { uploadId, snapshotId, manifestDigest, deviceId: DEVICE }, // missing status
      {
        uploadId,
        snapshotId,
        manifestDigest,
        deviceId: 'wrong-device',
        status: 'committed',
      },
      {
        uploadId,
        snapshotId,
        manifestDigest,
        deviceId: DEVICE,
        status: 'receiving',
      },
      {
        uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee9999',
        snapshotId,
        manifestDigest,
        deviceId: DEVICE,
        status: 'committed',
      },
    ];

    for (const finBody of finalizeBodies) {
      let statusCount = 0;
      let finalizeCount = 0;
      const server = await startHttpsFixture((req, res) => {
        const chunks = [];
        req.on('data', (x) => chunks.push(x));
        req.on('end', () => {
          if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
            return sendJson(res, 201, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: DEVICE,
              status: 'initialized',
            });
          }
          if (req.method === 'GET' && String(req.url).includes(uploadId)) {
            statusCount += 1;
            return sendJson(res, 200, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: DEVICE,
              status: 'receiving',
            });
          }
          if (String(req.url).endsWith('/chunks')) {
            return sendJson(res, 200, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: DEVICE,
              status: 'receiving',
            });
          }
          if (String(req.url).endsWith('/finalize')) {
            finalizeCount += 1;
            return sendJson(res, 200, finBody);
          }
          return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
        });
      });
      const credentialStore = memoryCredentialStore();
      await credentialStore.setToken(server.url, DEVICE, TOKEN);
      try {
        await assert.rejects(
          uploadSnapshotResumable({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: DEVICE,
            credentialStore,
            snapshotRoot: root,
            manifest,
            manifestDigest,
            maxResumeAttempts: 3,
            delayMs: async () => {},
          }),
          (e) => e instanceof LinkeError
            && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
            && e.statusCode === 400
            && e.code !== ERROR_CODES.DEVICE_ROUTE_NOT_FOUND,
        );
        assert.equal(finalizeCount, 1, 'must reach finalize once');
        assert.equal(statusCount, 0, 'hostile finalize must not trigger status resume');
      } finally {
        await server.close();
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it('chunk 2xx empty object / wrong identity fail-close without resume status', async () => {
    const files = [{ path: 'a.txt', content: 'chunk-ack' }];
    const { manifest, manifestDigest, snapshotId } = makeManifest(files);
    const root = await writeSnapshotRoot(files);
    const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0401';
    const badAcks = [
      {},
      {
        uploadId,
        snapshotId,
        manifestDigest,
        deviceId: 'other-device',
        status: 'receiving',
      },
      {
        uploadId,
        snapshotId,
        manifestDigest,
        deviceId: DEVICE,
        status: 'committed',
      },
    ];
    for (const ack of badAcks) {
      let statusCount = 0;
      const server = await startHttpsFixture((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
            return sendJson(res, 201, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: DEVICE,
              status: 'initialized',
            });
          }
          if (req.method === 'GET') {
            statusCount += 1;
            return sendJson(res, 200, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: DEVICE,
              status: 'receiving',
            });
          }
          if (String(req.url).endsWith('/chunks')) {
            return sendJson(res, 200, ack);
          }
          return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
        });
      });
      const credentialStore = memoryCredentialStore();
      await credentialStore.setToken(server.url, DEVICE, TOKEN);
      try {
        await assert.rejects(
          uploadSnapshotResumable({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: DEVICE,
            credentialStore,
            snapshotRoot: root,
            manifest,
            manifestDigest,
            maxResumeAttempts: 3,
            delayMs: async () => {},
          }),
          (e) => e instanceof LinkeError
            && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
            && e.statusCode === 400,
        );
        assert.equal(statusCount, 0, 'hostile chunk ACK must not trigger status resume');
      } finally {
        await server.close();
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it('status resume identity mismatch / hostile missingSummary fail-close non-retry', async () => {
    const files = [{ path: 'a.txt', content: 'status-hostile' }];
    const { manifest, manifestDigest, snapshotId } = makeManifest(files);
    const root = await writeSnapshotRoot(files);
    const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0402';

    // Case 1: transport fail then status wrong deviceId
    {
      let statusCount = 0;
      const server = await startHttpsFixture((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
            return sendJson(res, 201, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: DEVICE,
              status: 'initialized',
            });
          }
          if (req.method === 'GET') {
            statusCount += 1;
            return sendJson(res, 200, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: 'other-device',
              status: 'receiving',
            });
          }
          if (String(req.url).endsWith('/chunks')) {
            res.socket?.destroy();
            return;
          }
          return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
        });
      });
      const credentialStore = memoryCredentialStore();
      await credentialStore.setToken(server.url, DEVICE, TOKEN);
      try {
        await assert.rejects(
          uploadSnapshotResumable({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: DEVICE,
            credentialStore,
            snapshotRoot: root,
            manifest,
            manifestDigest,
            maxResumeAttempts: 2,
            delayMs: async () => {},
          }),
          (e) => e instanceof LinkeError
            && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
            && e.statusCode === 400,
        );
        assert.ok(statusCount >= 1);
      } finally {
        await server.close();
      }
    }

    // Case 2: status next offset does not match plan
    {
      let statusCount = 0;
      const server = await startHttpsFixture((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
            return sendJson(res, 201, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: DEVICE,
              status: 'initialized',
            });
          }
          if (req.method === 'GET') {
            statusCount += 1;
            return sendJson(res, 200, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: DEVICE,
              status: 'receiving',
              missingSummary: {
                complete: false,
                next: {
                  fileIndex: 0,
                  chunkIndex: 0,
                  offset: 99, // not matching plan offset 0
                  size: files[0].content.length,
                  complete: false,
                },
              },
            });
          }
          if (String(req.url).endsWith('/chunks')) {
            res.socket?.destroy();
            return;
          }
          return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
        });
      });
      const credentialStore = memoryCredentialStore();
      await credentialStore.setToken(server.url, DEVICE, TOKEN);
      try {
        await assert.rejects(
          uploadSnapshotResumable({
            agentUrl: server.url,
            tlsFingerprint: server.fingerprint,
            deviceId: DEVICE,
            credentialStore,
            snapshotRoot: root,
            manifest,
            manifestDigest,
            maxResumeAttempts: 2,
            delayMs: async () => {},
          }),
          (e) => e instanceof LinkeError
            && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
            && e.statusCode === 400,
        );
        assert.ok(statusCount >= 1);
      } finally {
        await server.close();
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it('server-progress resume: first chunk confirmed but ACK disconnect; status next skips re-send', async () => {
    const files = [
      { path: 'a.txt', content: 'first-file-payload' },
      { path: 'b.txt', content: 'second-file-payload' },
    ];
    const { manifest, manifestDigest, snapshotId } = makeManifest(files);
    const root = await writeSnapshotRoot(files);
    const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0301';
    /** @type {string[]} */
    const chunkKeys = [];
    let file0ServerConfirmed = false;
    let statusHits = 0;

    const server = await startHttpsFixture((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/agent/upload/sessions' && req.method === 'POST') {
          return sendJson(res, 201, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'initialized',
            missingSummary: {
              complete: false,
              next: {
                fileIndex: 0,
                chunkIndex: 0,
                offset: 0,
                size: files[0].content.length,
                complete: false,
              },
              remainingFiles: 2,
              remainingBytes: files[0].content.length + files[1].content.length,
              remainingChunks: 2,
            },
          });
        }
        if (req.method === 'GET' && String(req.url).includes(uploadId)) {
          statusHits += 1;
          if (file0ServerConfirmed) {
            return sendJson(res, 200, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: DEVICE,
              status: 'receiving',
              missingSummary: {
                complete: false,
                next: {
                  fileIndex: 1,
                  chunkIndex: 0,
                  offset: 0,
                  size: files[1].content.length,
                  complete: false,
                },
                remainingFiles: 1,
                remainingBytes: files[1].content.length,
                remainingChunks: 1,
              },
            });
          }
          return sendJson(res, 200, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'receiving',
            missingSummary: {
              complete: false,
              next: {
                fileIndex: 0,
                chunkIndex: 0,
                offset: 0,
                size: files[0].content.length,
                complete: false,
              },
              remainingFiles: 2,
              remainingBytes: files[0].content.length + files[1].content.length,
              remainingChunks: 2,
            },
          });
        }
        if (String(req.url).endsWith('/chunks')) {
          const fi = req.headers['x-linke-file-index'];
          const ci = req.headers['x-linke-chunk-index'];
          const key = `${fi}:${ci}`;
          chunkKeys.push(key);
          if (fi === '0' && ci === '0') {
            // Server confirms progress but ACK is lost (disconnect).
            file0ServerConfirmed = true;
            res.socket?.destroy();
            return;
          }
          if (fi === '1' && ci === '0') {
            return sendJson(res, 200, {
              uploadId,
              snapshotId,
              manifestDigest,
              deviceId: DEVICE,
              status: 'receiving',
            });
          }
          // Unexpected re-send of file0 after status realign would hit here.
          return sendJson(res, 409, { error: ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER });
        }
        if (String(req.url).endsWith('/finalize')) {
          return sendJson(res, 200, {
            uploadId,
            snapshotId,
            manifestDigest,
            deviceId: DEVICE,
            status: 'committed',
          });
        }
        return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
      });
    });

    const credentialStore = memoryCredentialStore();
    await credentialStore.setToken(server.url, DEVICE, TOKEN);
    try {
      const result = await uploadSnapshotResumable({
        agentUrl: server.url,
        tlsFingerprint: server.fingerprint,
        deviceId: DEVICE,
        credentialStore,
        snapshotRoot: root,
        manifest,
        manifestDigest,
        maxResumeAttempts: 3,
        delayMs: async () => {},
      });
      assert.equal(result.status, 'committed');
      assert.ok(statusHits >= 1);
      // First chunk attempted once (ACK lost), then file1 only — no second 0:0 after realign.
      const file0Attempts = chunkKeys.filter((k) => k === '0:0').length;
      assert.equal(file0Attempts, 1, `file0 must not be re-sent after status next; got ${chunkKeys.join(',')}`);
      assert.ok(chunkKeys.includes('1:0'));
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
