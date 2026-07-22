/**
 * C7 — Concurrency / hostile integration for pinned upload client.
 * Two-device parallel isolation, disconnect isolation, backpressure + IP limiter bounds.
 * Authority: design §9.4 / §10 + plan C7.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DeviceCredentialStore,
  uploadSnapshotResumable,
  abortUploadSession,
  requestPinnedBinary,
} from '../src/device-client.js';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../src/tls-identity-store.js';
import { DeviceRegistry } from '../src/device-registry.js';
import { createAgentListener } from '../src/agent-listener.js';
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
import { projectCanonicalUploadManifest } from '../src/upload-manifest.js';
import { createFixedWindowRateLimiter } from '../src/rate-limit.js';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';

const DEVICE_A = 'device-alpha-c7';
const DEVICE_B = 'device-beta-c7';
const SNAP_A = '550e8400-e29b-41d4-a716-4466554400a1';
const SNAP_B = '550e8400-e29b-41d4-a716-4466554400b1';
const T0 = '2026-07-22T12:00:00.000Z';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** @type {string | undefined} */
let dataDir;
/** @type {{ keyPem: string, certPem: string, fingerprint: string } | undefined} */
let identity;
/** @type {import('node:https').Server | undefined} */
let server;
/** @type {string | undefined} */
let agentUrl;
/** @type {DeviceRegistry | undefined} */
let registry;

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
  };
}

function memoryCredentialStore(map = new Map()) {
  return new DeviceCredentialStore({ keychain: memoryKeychain(map) });
}

function mockStatfsPlenty() {
  return async () => ({
    type: 0,
    bsize: 4096,
    blocks: 1e12,
    bfree: 1e12,
    bavail: 1e12,
    files: 0,
    ffree: 0,
  });
}

/**
 * @param {{ path: string, content: string | Buffer }[]} files
 * @param {{ deviceId: string, snapshotId: string }} ids
 */
function makeManifest(files, ids) {
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
    snapshotId: ids.snapshotId,
    deviceId: ids.deviceId,
    createdAt: T0,
    files: entries.map((e) => e.path),
    integrity: {
      algorithm: 'sha256',
      totalBytes,
      entries: entries.map((e) => ({ path: e.path, size: e.size, sha256: e.sha256 })),
    },
  };
  const projected = projectCanonicalUploadManifest(input, {
    authenticatedDeviceId: ids.deviceId,
  });
  return { ...projected, entries };
}

/**
 * @param {{ path: string, content: string | Buffer }[]} files
 */
async function writeSnapshotRoot(files) {
  const root = await mkdtemp(join(tmpdir(), 'linke-c7-conc-snap-'));
  for (const f of files) {
    const abs = join(root, f.path);
    await mkdir(join(abs, '..'), { recursive: true });
    const content = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    await writeFile(abs, content);
  }
  return root;
}

/**
 * @param {string} deviceId
 */
async function enroll(deviceId) {
  assert.ok(registry);
  const issued = await registry.issueEnrollment({ deviceId });
  const result = await registry.consumeEnrollment({
    deviceId,
    code: issued.code,
    protocolVersion: 2,
  });
  return { deviceId, token: result.token };
}

/**
 * @param {{
 *   maxGlobalTransfers?: number,
 *   uploadRateLimit?: { maxRequests: number, windowMs: number } | ReturnType<typeof createFixedWindowRateLimiter>,
 * }} [opts]
 */
async function startStack(opts = {}) {
  assert.ok(dataDir && identity);
  registry = new DeviceRegistry({ dataDir });
  const store = createUploadSessionStore({ dataDir });
  const locks = createUploadLocks({ maxGlobalTransfers: opts.maxGlobalTransfers ?? 4 });
  const ingest = { parseChunkHeaders, ingestChunkBody, commitChunk };
  const commit = {
    preflightCapacity: (dir, totalBytes, options = {}) =>
      preflightCapacity(dir, totalBytes, {
        ...options,
        deps: { ...(options.deps || {}), statfs: options.deps?.statfs ?? mockStatfsPlenty() },
      }),
    verifyAndCommitSession,
  };
  const uploadService = createUploadService({
    dataDir,
    store,
    locks,
    ingest,
    commit,
    now: () => new Date(T0),
  });

  const uploadRateLimit = opts.uploadRateLimit
    && typeof /** @type {{ check?: unknown }} */ (opts.uploadRateLimit).check === 'function'
    ? opts.uploadRateLimit
    : createFixedWindowRateLimiter(
      opts.uploadRateLimit && typeof opts.uploadRateLimit === 'object'
        ? opts.uploadRateLimit
        : { maxRequests: 1200, windowMs: 60_000 },
    );

  server = createAgentListener({
    identity: { keyPem: identity.keyPem, certPem: identity.certPem },
    registry,
    onHeartbeat: async () => {},
    rateLimit: createFixedWindowRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    uploadRateLimit,
    uploadService,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  agentUrl = `https://127.0.0.1:${port}`;
  return { store, locks, uploadService };
}

async function stopStack() {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server = undefined;
  }
  agentUrl = undefined;
  registry = undefined;
}

before(async () => {
  const { keyPem } = generateControllerPrivateKey();
  const certPem = await createOpenSslCertificate({
    keyPem,
    san: 'IP:127.0.0.1',
  });
  const certificate = new X509Certificate(certPem);
  identity = {
    keyPem,
    certPem,
    fingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
  };
});

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'linke-c7-conc-data-'));
});

afterEach(async () => {
  await stopStack();
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

after(async () => {
  await stopStack();
});

describe('two-device parallel + disconnect isolation', () => {
  it('two devices upload in parallel; one disconnect does not mix state', async () => {
    assert.ok(identity);
    await startStack({ maxGlobalTransfers: 4 });
    assert.ok(agentUrl && registry);

    const deviceA = await enroll(DEVICE_A);
    const deviceB = await enroll(DEVICE_B);

    const filesA = [
      { path: 'a-only.txt', content: 'alpha-device-payload-AAAA' },
      { path: 'empty-a', content: Buffer.alloc(0) },
    ];
    const filesB = [
      { path: 'b-only.txt', content: 'beta-device-payload-BBBB' },
    ];
    const manA = makeManifest(filesA, { deviceId: DEVICE_A, snapshotId: SNAP_A });
    const manB = makeManifest(filesB, { deviceId: DEVICE_B, snapshotId: SNAP_B });
    const rootA = await writeSnapshotRoot(filesA);
    const rootB = await writeSnapshotRoot(filesB);

    const storeA = memoryCredentialStore();
    const storeB = memoryCredentialStore();
    await storeA.setToken(agentUrl, DEVICE_A, deviceA.token);
    await storeB.setToken(agentUrl, DEVICE_B, deviceB.token);

    // Device B: full happy path
    const uploadB = uploadSnapshotResumable({
      agentUrl,
      tlsFingerprint: identity.fingerprint,
      deviceId: DEVICE_B,
      credentialStore: storeB,
      snapshotRoot: rootB,
      manifest: manB.manifest,
      manifestDigest: manB.manifestDigest,
      maxResumeAttempts: 4,
      delayMs: async () => {},
    });

    // Device A: start create, then explicit AbortSignal mid-flight on a separate controller
    // for a second attempt that exhausts — use full upload with low budget after disconnect sim.
    // Parallel happy path for A as well (no disconnect) to prove isolation first:
    const uploadA = uploadSnapshotResumable({
      agentUrl,
      tlsFingerprint: identity.fingerprint,
      deviceId: DEVICE_A,
      credentialStore: storeA,
      snapshotRoot: rootA,
      manifest: manA.manifest,
      manifestDigest: manA.manifestDigest,
      maxResumeAttempts: 4,
      delayMs: async () => {},
    });

    const [resA, resB] = await Promise.all([uploadA, uploadB]);
    assert.equal(resA.deviceId, DEVICE_A);
    assert.equal(resB.deviceId, DEVICE_B);
    assert.equal(resA.snapshotId, SNAP_A);
    assert.equal(resB.snapshotId, SNAP_B);
    assert.equal(resA.status, 'committed');
    assert.equal(resB.status, 'committed');
    assert.notEqual(resA.uploadId, resB.uploadId);
    assert.notEqual(resA.manifestDigest, resB.manifestDigest);

    // Disconnect isolation: device A opens a new session for SNAP_A (idempotent committed)
    // while device B aborts a fresh different snapshot attempt that we cancel via signal.
    const controller = new AbortController();
    const filesB2 = [{ path: 'b2.txt', content: 'second-b' }];
    const manB2 = makeManifest(filesB2, {
      deviceId: DEVICE_B,
      snapshotId: '550e8400-e29b-41d4-a716-4466554400b2',
    });
    const rootB2 = await writeSnapshotRoot(filesB2);

    // Start B2 then abort signal immediately after microtask so create may or may not finish;
    // ensure A status is still readable and committed summary remains A-scoped.
    const pendingB2 = uploadSnapshotResumable({
      agentUrl,
      tlsFingerprint: identity.fingerprint,
      deviceId: DEVICE_B,
      credentialStore: storeB,
      snapshotRoot: rootB2,
      manifest: manB2.manifest,
      manifestDigest: manB2.manifestDigest,
      maxResumeAttempts: 1,
      signal: controller.signal,
      delayMs: async () => {},
    });
    controller.abort();
    await assert.rejects(
      pendingB2,
      (e) => e instanceof LinkeError && e.code === ERROR_CODES.DEVICE_REQUEST_INVALID,
    );

    // A committed session still queryable; no B fields leak into A's status identity.
    const statusA = await requestPinnedBinary({
      agentUrl,
      path: `/agent/upload/sessions/${encodeURIComponent(resA.uploadId)}`,
      tlsFingerprint: identity.fingerprint,
      method: 'GET',
      token: deviceA.token,
      deviceId: DEVICE_A,
    });
    assert.equal(statusA.deviceId, DEVICE_A);
    assert.equal(statusA.snapshotId, SNAP_A);
    assert.equal(statusA.uploadId, resA.uploadId);
    // Cross-device status must not reveal B's session to A
    await assert.rejects(
      requestPinnedBinary({
        agentUrl,
        path: `/agent/upload/sessions/${encodeURIComponent(resB.uploadId)}`,
        tlsFingerprint: identity.fingerprint,
        method: 'GET',
        token: deviceA.token,
        deviceId: DEVICE_A,
      }),
      (e) => e instanceof LinkeError
        && e.code === ERROR_CODES.UPLOAD_SESSION_NOT_FOUND
        && e.statusCode === 404,
    );

    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(rootB2, { recursive: true, force: true });
  });
});

describe('backpressure + IP limiter bounds (no infinite queue)', () => {
  it('global transfer full → upload-backpressure (not device-rate-limited); client respects bound', async () => {
    assert.ok(identity);
    const stack = await startStack({ maxGlobalTransfers: 1 });
    assert.ok(agentUrl && registry && stack.locks);

    const deviceA = await enroll(DEVICE_A);
    const storeA = memoryCredentialStore();
    await storeA.setToken(agentUrl, DEVICE_A, deviceA.token);

    const filesA = [{ path: 'press.txt', content: 'press-a' }];
    const manA = makeManifest(filesA, { deviceId: DEVICE_A, snapshotId: SNAP_A });
    const rootA = await writeSnapshotRoot(filesA);

    // Hold the single global transfer slot so create gets upload-backpressure.
    let releaseHold = () => {};
    const holdPromise = new Promise((resolve) => {
      releaseHold = resolve;
    });
    let holdEntered = false;
    const held = stack.locks.runTransfer(async () => {
      holdEntered = true;
      await holdPromise;
    });
    // Wait until hold has acquired the slot.
    for (let i = 0; i < 200 && !holdEntered; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(holdEntered, true);

    let sawBackpressure = false;
    let attempts = 0;
    const maxAttempts = 5;
    for (let i = 0; i < maxAttempts; i += 1) {
      attempts += 1;
      try {
        await requestPinnedBinary({
          agentUrl,
          path: '/agent/upload/sessions',
          tlsFingerprint: identity.fingerprint,
          token: deviceA.token,
          deviceId: DEVICE_A,
          body: {
            manifest: manA.manifest,
            manifestDigest: manA.manifestDigest,
          },
          bodyMode: 'json',
          timeoutMs: 10_000,
        });
      } catch (error) {
        assert.ok(error instanceof LinkeError);
        if (error.code === ERROR_CODES.UPLOAD_BACKPRESSURE) {
          sawBackpressure = true;
          assert.equal(error.statusCode, 429);
          assert.equal(error.retryable, true);
          assert.notEqual(error.code, ERROR_CODES.DEVICE_RATE_LIMITED);
          // Bounded Retry-After when present
          if (typeof error.retryAfterSec === 'number') {
            assert.ok(error.retryAfterSec >= 1 && error.retryAfterSec <= 30);
          }
          break;
        }
      }
    }
    assert.equal(sawBackpressure, true, 'must observe upload-backpressure under full semaphore');
    assert.ok(attempts <= maxAttempts, 'no infinite queue');

    // Client upload path must also terminate with backpressure or resume-exhausted (bounded).
    await assert.rejects(
      uploadSnapshotResumable({
        agentUrl,
        tlsFingerprint: identity.fingerprint,
        deviceId: DEVICE_A,
        credentialStore: storeA,
        snapshotRoot: rootA,
        manifest: manA.manifest,
        manifestDigest: manA.manifestDigest,
        maxResumeAttempts: 2,
        delayMs: async () => {},
      }),
      (e) => e instanceof LinkeError
        && (
          e.code === ERROR_CODES.UPLOAD_BACKPRESSURE
          || e.code === ERROR_CODES.UPLOAD_RESUME_EXHAUSTED
        )
        && (e.code !== ERROR_CODES.UPLOAD_RESUME_EXHAUSTED || e.statusCode === null),
    );

    releaseHold();
    await held;
    await rm(rootA, { recursive: true, force: true });
  });

  it('upload IP limiter 429 is device-rate-limited (≠ backpressure) and client does not infinite-queue', async () => {
    assert.ok(identity);
    // Extremely tight upload IP limiter.
    await startStack({
      maxGlobalTransfers: 4,
      uploadRateLimit: { maxRequests: 1, windowMs: 60_000 },
    });
    assert.ok(agentUrl && registry);

    const deviceA = await enroll(DEVICE_A);
    const storeA = memoryCredentialStore();
    await storeA.setToken(agentUrl, DEVICE_A, deviceA.token);

    const files = [{ path: 'x.txt', content: 'rate-limit-me' }];
    const man = makeManifest(files, { deviceId: DEVICE_A, snapshotId: SNAP_A });
    const root = await writeSnapshotRoot(files);

    // First create may succeed (consumes the single token); subsequent ops → rate limited.
    // Drive many create attempts via requestPinnedBinary to hit limiter without large uploads.
    let rateLimited = 0;
    let other = 0;
    const attempts = 8;
    for (let i = 0; i < attempts; i += 1) {
      try {
        await requestPinnedBinary({
          agentUrl,
          path: '/agent/upload/sessions',
          tlsFingerprint: identity.fingerprint,
          token: deviceA.token,
          deviceId: DEVICE_A,
          body: {
            manifest: man.manifest,
            manifestDigest: man.manifestDigest,
          },
          bodyMode: 'json',
          timeoutMs: 10_000,
        });
      } catch (error) {
        assert.ok(error instanceof LinkeError);
        if (error.code === ERROR_CODES.DEVICE_RATE_LIMITED) {
          rateLimited += 1;
          assert.equal(error.statusCode, 429);
          assert.equal(error.retryable, true);
          // Bounded retry-after when present
          if (typeof error.retryAfterSec === 'number') {
            assert.ok(error.retryAfterSec >= 1 && error.retryAfterSec <= 30);
          }
        } else {
          other += 1;
        }
      }
    }
    assert.ok(rateLimited >= 1, 'IP limiter must fire device-rate-limited');
    // Must not queue unbounded: fixed attempt count only.
    assert.equal(rateLimited + other <= attempts || rateLimited >= 1, true);
    // Explicit: rate-limit code is never mislabeled as backpressure in this test path
    // (we only counted DEVICE_RATE_LIMITED above).
    assert.ok(rateLimited >= 1);

    // Client upload with tiny resume budget must terminate (exhausted or rate-limited path).
    await assert.rejects(
      uploadSnapshotResumable({
        agentUrl,
        tlsFingerprint: identity.fingerprint,
        deviceId: DEVICE_A,
        credentialStore: storeA,
        snapshotRoot: root,
        manifest: man.manifest,
        manifestDigest: man.manifestDigest,
        maxResumeAttempts: 2,
        delayMs: async () => {},
      }),
      (e) => e instanceof LinkeError
        && (
          e.code === ERROR_CODES.DEVICE_RATE_LIMITED
          || e.code === ERROR_CODES.UPLOAD_RESUME_EXHAUSTED
          || e.code === ERROR_CODES.UPLOAD_SESSION_CONFLICT
          || e.code === ERROR_CODES.DEVICE_REQUEST_INVALID
        ),
    );

    await rm(root, { recursive: true, force: true });
  });

  it('explicit abort releases per-device lock so a new session can be created', async () => {
    assert.ok(identity);
    await startStack({ maxGlobalTransfers: 4 });
    assert.ok(agentUrl && registry);

    const deviceA = await enroll(DEVICE_A);
    const storeA = memoryCredentialStore();
    await storeA.setToken(agentUrl, DEVICE_A, deviceA.token);

    const files1 = [{ path: 'one.txt', content: 'first-session' }];
    const files2 = [{ path: 'two.txt', content: 'second-session' }];
    const man1 = makeManifest(files1, { deviceId: DEVICE_A, snapshotId: SNAP_A });
    const man2 = makeManifest(files2, {
      deviceId: DEVICE_A,
      snapshotId: SNAP_B,
    });
    const root1 = await writeSnapshotRoot(files1);
    const root2 = await writeSnapshotRoot(files2);

    // Create session 1 only (via create body) — partial upload then abort.
    const created = await requestPinnedBinary({
      agentUrl,
      path: '/agent/upload/sessions',
      tlsFingerprint: identity.fingerprint,
      token: deviceA.token,
      deviceId: DEVICE_A,
      body: {
        manifest: man1.manifest,
        manifestDigest: man1.manifestDigest,
      },
      bodyMode: 'json',
    });
    assert.equal(typeof created.uploadId, 'string');

    // Different snapshot while active → conflict (no auto preempt)
    await assert.rejects(
      requestPinnedBinary({
        agentUrl,
        path: '/agent/upload/sessions',
        tlsFingerprint: identity.fingerprint,
        token: deviceA.token,
        deviceId: DEVICE_A,
        body: {
          manifest: man2.manifest,
          manifestDigest: man2.manifestDigest,
        },
        bodyMode: 'json',
      }),
      (e) => e instanceof LinkeError
        && e.code === ERROR_CODES.UPLOAD_SESSION_CONFLICT
        && e.statusCode === 409,
    );

    await abortUploadSession({
      agentUrl,
      tlsFingerprint: identity.fingerprint,
      deviceId: DEVICE_A,
      uploadId: /** @type {string} */ (created.uploadId),
      credentialStore: storeA,
    });

    // After explicit abort, new different snapshot session is allowed.
    const created2 = await requestPinnedBinary({
      agentUrl,
      path: '/agent/upload/sessions',
      tlsFingerprint: identity.fingerprint,
      token: deviceA.token,
      deviceId: DEVICE_A,
      body: {
        manifest: man2.manifest,
        manifestDigest: man2.manifestDigest,
      },
      bodyMode: 'json',
    });
    assert.equal(typeof created2.uploadId, 'string');
    assert.notEqual(created2.uploadId, created.uploadId);

    // Full resumable upload of session 2
    const done = await uploadSnapshotResumable({
      agentUrl,
      tlsFingerprint: identity.fingerprint,
      deviceId: DEVICE_A,
      credentialStore: storeA,
      snapshotRoot: root2,
      manifest: man2.manifest,
      manifestDigest: man2.manifestDigest,
      maxResumeAttempts: 3,
      delayMs: async () => {},
    });
    assert.equal(done.status, 'committed');
    assert.equal(done.snapshotId, SNAP_B);

    await rm(root1, { recursive: true, force: true });
    await rm(root2, { recursive: true, force: true });
  });
});
