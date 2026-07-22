/**
 * C2 — Persistent upload session store (TTL / terminal / reconcile).
 * TDD: RED first, then GREEN against src/upload-session-store.js only.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open as fsOpen,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import {
  projectCanonicalUploadManifest,
  UPLOAD_MANIFEST_LIMITS,
} from '../src/upload-manifest.js';
import { safeDevicePath, slugify } from '../src/storage.js';
import {
  createUploadSessionStore,
  UPLOAD_SESSION_TTL_MS,
  UPLOAD_CHUNK_SIZE,
  isActiveNonterminal,
  ACTIVE_NONTERMINAL_STATUSES,
  TERMINAL_STATUSES,
} from '../src/upload-session-store.js';

const DEVICE_A = 'device-alpha-001';
const DEVICE_B = 'device-beta-002';
const SNAPSHOT_A = '550e8400-e29b-41d4-a716-446655440000';
const SNAPSHOT_B = '550e8400-e29b-41d4-a716-446655440001';
const ZERO_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const T0 = '2026-07-22T12:00:00.000Z';

/** @type {string | undefined} */
let dataDir;
/** @type {ReturnType<typeof createClock>} */
let clock;
/** @type {ReturnType<typeof createUuidSeq>} */
let uuidSeq;
/** @type {ReturnType<typeof createUploadSessionStore>} */
let store;

function createClock(startIso = T0) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    set: (iso) => {
      ms = Date.parse(iso);
    },
    advanceMs: (delta) => {
      ms += delta;
    },
    iso: () => new Date(ms).toISOString(),
  };
}

function createUuidSeq(prefix = 'aaaaaaaa-bbbb-4ccc-8ddd') {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return `${prefix}-${String(n).padStart(12, '0')}`;
    },
    peek: (i) => `${prefix}-${String(i).padStart(12, '0')}`,
  };
}

/**
 * @param {{
 *   deviceId?: string,
 *   snapshotId?: string,
 *   files?: { path: string, size: number, content?: string }[],
 *   hostname?: string,
 *   sourcePath?: string,
 * }} [opts]
 */
function makeProjection(opts = {}) {
  const deviceId = opts.deviceId ?? DEVICE_A;
  const snapshotId = opts.snapshotId ?? SNAPSHOT_A;
  const files = opts.files ?? [{ path: 'a.txt', size: 0 }];
  const entries = files.map((f) => {
    const content = f.content ?? (f.size === 0 ? '' : 'x'.repeat(f.size));
    const sha256 =
      f.size === 0
        ? ZERO_SHA
        : createHash('sha256').update(content, 'utf8').digest('hex');
    return { path: f.path, size: f.size, sha256, content };
  });
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  /** @type {Record<string, unknown>} */
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
  if (opts.hostname !== undefined) input.hostname = opts.hostname;
  if (opts.sourcePath !== undefined) input.sourcePath = opts.sourcePath;
  const { manifest, manifestDigest } = projectCanonicalUploadManifest(input, {
    authenticatedDeviceId: deviceId,
  });
  return { manifest, manifestDigest, entries };
}

/**
 * @param {unknown} error
 * @param {string} code
 * @param {{ statusCode?: number | null, retryable?: boolean, leakTokens?: string[] }} [opts]
 */
function assertLinkeCode(error, code, opts = {}) {
  assert.ok(error instanceof LinkeError, 'must be LinkeError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  if (opts.statusCode !== undefined) assert.equal(error.statusCode, opts.statusCode);
  if (opts.retryable !== undefined) assert.equal(error.retryable, opts.retryable);
  const publicParts = [
    error.code,
    error.message,
    error.name,
    String(error.statusCode),
    String(error.retryable),
    // details may exist but must not leak paths
    error.details ? JSON.stringify(error.details) : '',
  ].join('\0');
  for (const token of opts.leakTokens ?? []) {
    if (!token || token.length < 2) continue;
    assert.ok(!publicParts.includes(token), `must not leak ${token}`);
  }
}

function sessionDirRel(deviceId, uploadId) {
  const { deviceRel } = safeDevicePath(dataDir, deviceId);
  return join(dataDir, deviceRel, 'upload-sessions', uploadId);
}

function sessionJsonAbs(deviceId, uploadId) {
  return join(sessionDirRel(deviceId, uploadId), 'session.json');
}

function stagingChunkAbs(deviceId, uploadId, fileIndex, chunkIndex) {
  return join(
    sessionDirRel(deviceId, uploadId),
    '.staging',
    'files',
    String(fileIndex),
    `chunk-${chunkIndex}.part`,
  );
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'linke-uss-'));
  clock = createClock(T0);
  uuidSeq = createUuidSeq();
  store = createUploadSessionStore({
    dataDir,
    now: () => clock.now(),
    randomUUID: () => uuidSeq.next(),
  });
});

afterEach(async () => {
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

// ── Constants / pure predicates ─────────────────────────────────────

describe('upload-session-store constants & predicates', () => {
  it('freezes 24h TTL and 8 MiB chunk size', () => {
    assert.equal(UPLOAD_SESSION_TTL_MS, 24 * 60 * 60 * 1000);
    assert.equal(UPLOAD_CHUNK_SIZE, 8 * 1024 * 1024);
    assert.deepEqual([...ACTIVE_NONTERMINAL_STATUSES], ['initialized', 'receiving', 'verifying']);
    assert.deepEqual([...TERMINAL_STATUSES], ['committed', 'aborted']);
  });

  it('isActiveNonterminal requires nonterminal status and strict before-TTL window', () => {
    const createdAt = T0;
    const createdMs = Date.parse(createdAt);
    const base = {
      status: 'initialized',
      createdAt,
    };
    assert.equal(isActiveNonterminal(base, new Date(createdMs)), true);
    assert.equal(isActiveNonterminal(base, new Date(createdMs + UPLOAD_SESSION_TTL_MS - 1)), true);
    // Boundary moment is expired (not active).
    assert.equal(isActiveNonterminal(base, new Date(createdMs + UPLOAD_SESSION_TTL_MS)), false);
    // Clock rollback fail-close.
    assert.equal(isActiveNonterminal(base, new Date(createdMs - 1)), false);
    assert.equal(isActiveNonterminal({ ...base, status: 'committed' }, new Date(createdMs)), false);
    assert.equal(isActiveNonterminal({ ...base, status: 'aborted' }, new Date(createdMs)), false);
    assert.equal(isActiveNonterminal({ ...base, status: 'receiving' }, new Date(createdMs)), true);
    assert.equal(isActiveNonterminal({ ...base, status: 'verifying' }, new Date(createdMs)), true);
  });
});

// ── Layout ──────────────────────────────────────────────────────────

describe('layout under repo/devices (never dataDir/devices)', () => {
  it('creates session under dataDir/repo/devices/<slug>/upload-sessions/<uuid>/', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });

    const slug = slugify(DEVICE_A);
    const expectedRel = join('repo', 'devices', slug, 'upload-sessions', session.uploadId);
    const abs = join(dataDir, expectedRel);
    const st = await lstat(abs);
    assert.ok(st.isDirectory());

    const sessionJson = await readFile(join(abs, 'session.json'), 'utf8');
    const manifestJson = await readFile(join(abs, 'manifest.canonical.json'), 'utf8');
    assert.ok(sessionJson.length > 0);
    assert.ok(manifestJson.length > 0);

    // Forbidden layout must not exist.
    await assert.rejects(() => lstat(join(dataDir, 'devices')), (e) => e && e.code === 'ENOENT');
    await assert.rejects(
      () => lstat(join(dataDir, 'devices', slug)),
      (e) => e && e.code === 'ENOENT',
    );
  });

  it('uploadId is server-generated; client cannot choose path or uploadId', async () => {
    const proj = makeProjection();
    const expectedId = uuidSeq.peek(1);
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.equal(session.uploadId, expectedId);
  });

  it('persists canonical manifest JSON (not raw client object) and safe session fields only', async () => {
    const proj = makeProjection({
      hostname: 'host.example',
      sourcePath: '/secret/client/path',
      files: [{ path: 'docs/readme.txt', size: 0 }],
    });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });

    const rawSession = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8'));
    const rawManifest = JSON.parse(
      await readFile(join(sessionDirRel(DEVICE_A, session.uploadId), 'manifest.canonical.json'), 'utf8'),
    );

    // Session must not store path-bearing / host fields.
    assert.equal(rawSession.sourcePath, undefined);
    assert.equal(rawSession.hostname, undefined);
    assert.equal(rawSession.path, undefined);
    for (const b of rawSession.boundaries) {
      assert.equal(b.path, undefined);
      assert.equal(typeof b.fileIndex, 'number');
      assert.equal(typeof b.size, 'number');
      assert.equal(typeof b.confirmedBytes, 'number');
      assert.equal(typeof b.confirmedChunks, 'number');
      assert.equal(typeof b.complete, 'boolean');
    }

    // Manifest retains opaque sourcePath only in canonical file (opaque, not session summary).
    assert.equal(rawManifest.sourcePath, '/secret/client/path');
    assert.equal(rawManifest.hostname, 'host.example');
    assert.deepEqual(rawManifest.files, proj.manifest.files);

    // Public summary has no sourcePath/hostname/path.
    assert.equal(session.sourcePath, undefined);
    assert.equal(session.hostname, undefined);
    assert.equal(session.path, undefined);
  });
});

// ── createSession identity & matrix ─────────────────────────────────

describe('createSession identity matrix', () => {
  it('creates initialized session with zero-size file complete and identity fields', async () => {
    const proj = makeProjection({ files: [{ path: 'empty.bin', size: 0 }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });

    assert.equal(session.status, 'initialized');
    assert.equal(session.deviceId, DEVICE_A);
    assert.equal(session.snapshotId, SNAPSHOT_A);
    assert.equal(session.manifestDigest, proj.manifestDigest);
    assert.equal(session.createdAt, T0);
    assert.equal(session.expiresAt, new Date(Date.parse(T0) + UPLOAD_SESSION_TTL_MS).toISOString());
    assert.equal(session.files.length, 1);
    assert.deepEqual(session.files[0], {
      fileIndex: 0,
      size: 0,
      confirmedBytes: 0,
      confirmedChunks: 0,
      complete: true,
    });
  });

  it('same identity active → idempotent return same uploadId (no conflict, no new dir)', async () => {
    const proj = makeProjection();
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const second = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.equal(second.uploadId, first.uploadId);
    assert.equal(second.status, 'initialized');

    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const dirs = await readdir(join(dataDir, deviceRel, 'upload-sessions'));
    assert.equal(dirs.length, 1);
  });

  it('same identity after receiving still idempotent', async () => {
    const size = 100;
    const content = 'y'.repeat(size);
    const proj = makeProjection({ files: [{ path: 'f.bin', size, content }] });
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: first.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      chunkBytes: size,
    });
    const again = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.equal(again.uploadId, first.uploadId);
    assert.equal(again.status, 'receiving');
  });

  it('same identity committed → return committed safe summary without new session', async () => {
    const proj = makeProjection({ files: [{ path: 'z.bin', size: 0 }] });
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    // zero-size file already complete → verifying → committed
    await store.markVerifying({ authenticatedDeviceId: DEVICE_A, uploadId: first.uploadId });
    await store.markCommitted({ authenticatedDeviceId: DEVICE_A, uploadId: first.uploadId });

    const again = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.equal(again.uploadId, first.uploadId);
    assert.equal(again.status, 'committed');

    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const dirs = await readdir(join(dataDir, deviceRel, 'upload-sessions'));
    assert.equal(dirs.length, 1);
  });

  it('different snapshotId with active session → UPLOAD_SESSION_CONFLICT + device-local locator only', async () => {
    const projA = makeProjection({ snapshotId: SNAPSHOT_A });
    const active = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: projA.manifest.snapshotId,
      manifestDigest: projA.manifestDigest,
      canonicalManifest: projA.manifest,
    });
    const projB = makeProjection({ snapshotId: SNAPSHOT_B });
    await assert.rejects(
      () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: projB.manifest.snapshotId,
          manifestDigest: projB.manifestDigest,
          canonicalManifest: projB.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_CONFLICT, {
          statusCode: 409,
          retryable: false,
          leakTokens: [dataDir, 'repo/devices', '/secret', 'host.example'],
        });
        assert.ok(error.details && error.details.active);
        assert.deepEqual(error.details.active, {
          uploadId: active.uploadId,
          status: 'initialized',
          snapshotId: SNAPSHOT_A,
          manifestDigest: projA.manifestDigest,
        });
        // No path fields in locator
        assert.equal(error.details.active.path, undefined);
        assert.equal(error.details.path, undefined);
        return true;
      },
    );
    // Must not preempt/abort old session
    const still = await store.getSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: active.uploadId,
    });
    assert.equal(still.status, 'initialized');
  });

  it('different manifestDigest with active session → conflict', async () => {
    const proj1 = makeProjection({ files: [{ path: 'a.txt', size: 0 }] });
    const active = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj1.manifest.snapshotId,
      manifestDigest: proj1.manifestDigest,
      canonicalManifest: proj1.manifest,
    });
    const proj2 = makeProjection({ files: [{ path: 'b.txt', size: 0 }] });
    // same snapshotId, different digest (different files)
    // Force same snapshotId as proj1
    const input = {
      schemaVersion: 2,
      snapshotId: SNAPSHOT_A,
      deviceId: DEVICE_A,
      createdAt: T0,
      files: ['b.txt'],
      integrity: {
        algorithm: 'sha256',
        totalBytes: 0,
        entries: [{ path: 'b.txt', size: 0, sha256: ZERO_SHA }],
      },
    };
    const { manifest, manifestDigest } = projectCanonicalUploadManifest(input, {
      authenticatedDeviceId: DEVICE_A,
    });
    assert.notEqual(manifestDigest, proj1.manifestDigest);

    await assert.rejects(
      () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: SNAPSHOT_A,
          manifestDigest,
          canonicalManifest: manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_CONFLICT, { statusCode: 409 });
        assert.equal(error.details.active.uploadId, active.uploadId);
        assert.equal(error.details.active.manifestDigest, proj1.manifestDigest);
        return true;
      },
    );
  });

  it('after abort, create is allowed (new uploadId); old dir retained', async () => {
    const proj = makeProjection();
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.abortSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: first.uploadId,
    });
    const second = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.notEqual(second.uploadId, first.uploadId);
    assert.equal(second.status, 'initialized');
    // Old retained
    const old = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, first.uploadId), 'utf8'));
    assert.equal(old.status, 'aborted');
  });

  it('after expired nonterminal, create is allowed; old record retained; findActive ignores expired', async () => {
    const proj = makeProjection();
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    clock.advanceMs(UPLOAD_SESSION_TTL_MS); // boundary = expired
    const active = await store.findActiveSession(DEVICE_A);
    assert.equal(active, null);

    const second = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.notEqual(second.uploadId, first.uploadId);
    const old = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, first.uploadId), 'utf8'));
    assert.equal(old.status, 'initialized'); // not deleted / not rewritten
  });

  it('concurrent same-identity creates serialize to one session', async () => {
    const proj = makeProjection();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: proj.manifest.snapshotId,
          manifestDigest: proj.manifestDigest,
          canonicalManifest: proj.manifest,
        }),
      ),
    );
    const ids = new Set(results.map((r) => r.uploadId));
    assert.equal(ids.size, 1);
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const dirs = await readdir(join(dataDir, deviceRel, 'upload-sessions'));
    assert.equal(dirs.length, 1);
  });

  it('corrupt session.json during scan fail-closes and does not create past active lock', async () => {
    const proj = makeProjection();
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    // Corrupt the only session record
    await writeFile(sessionJsonAbs(DEVICE_A, first.uploadId), '{not-json', 'utf8');

    const projB = makeProjection({ snapshotId: SNAPSHOT_B });
    await assert.rejects(
      () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: projB.manifest.snapshotId,
          manifestDigest: projB.manifestDigest,
          canonicalManifest: projB.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          leakTokens: [dataDir, first.uploadId, 'session.json', '{not-json'],
        });
        return true;
      },
    );
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const dirs = await readdir(join(dataDir, deviceRel, 'upload-sessions'));
    assert.equal(dirs.length, 1, 'must not create new session when scan fails');
  });

  it('symlink under upload-sessions fail-closes create scan', async () => {
    const proj = makeProjection();
    await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const sessionsAbs = join(dataDir, deviceRel, 'upload-sessions');
    const outside = await mkdtemp(join(tmpdir(), 'linke-uss-out-'));
    try {
      await symlink(outside, join(sessionsAbs, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 'dir');
      const projB = makeProjection({ snapshotId: SNAPSHOT_B });
      await assert.rejects(
        () =>
          store.createSession({
            authenticatedDeviceId: DEVICE_A,
            snapshotId: projB.manifest.snapshotId,
            manifestDigest: projB.manifestDigest,
            canonicalManifest: projB.manifest,
          }),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
            leakTokens: [outside, dataDir, 'upload-sessions'],
          });
          return true;
        },
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// ── device scope / not-found ────────────────────────────────────────

describe('authenticated deviceId scope', () => {
  it('getSession for other device uploadId → NOT_FOUND (no existence leak)', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_B,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_NOT_FOUND, {
          statusCode: 404,
          leakTokens: [session.uploadId, DEVICE_A, dataDir],
        });
        return true;
      },
    );
  });

  it('abortSession for cross-device → NOT_FOUND', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await assert.rejects(
      () =>
        store.abortSession({
          authenticatedDeviceId: DEVICE_B,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_NOT_FOUND, { statusCode: 404 });
        return true;
      },
    );
  });

  it('unknown uploadId in scope → NOT_FOUND', async () => {
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_NOT_FOUND, { statusCode: 404 });
        return true;
      },
    );
  });

  it('findActiveSession is device-scoped', async () => {
    const proj = makeProjection();
    await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.equal(await store.findActiveSession(DEVICE_B), null);
    const a = await store.findActiveSession(DEVICE_A);
    assert.ok(a);
    assert.equal(a.deviceId, DEVICE_A);
  });
});

// ── TTL ─────────────────────────────────────────────────────────────

describe('TTL expiry', () => {
  it('getSession on expired nonterminal → EXPIRED and record retained', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    clock.advanceMs(UPLOAD_SESSION_TTL_MS);
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_EXPIRED, {
          statusCode: 410,
          retryable: false,
          leakTokens: [dataDir, session.uploadId],
        });
        return true;
      },
    );
    const raw = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8'));
    assert.equal(raw.status, 'initialized');
  });

  it('clock rollback treated as expired', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    clock.set('2026-07-21T12:00:00.000Z'); // before createdAt
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_EXPIRED, { statusCode: 410 });
        return true;
      },
    );
  });

  it('assertNotExpired throws EXPIRED at boundary', () => {
    const session = {
      status: 'receiving',
      createdAt: T0,
    };
    const atBoundary = new Date(Date.parse(T0) + UPLOAD_SESSION_TTL_MS);
    assert.throws(
      () => store.assertNotExpired(session, atBoundary),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_EXPIRED, { statusCode: 410 });
        return true;
      },
    );
  });

  it('abort on expired nonterminal → EXPIRED (no status rewrite)', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    clock.advanceMs(UPLOAD_SESSION_TTL_MS + 1);
    await assert.rejects(
      () =>
        store.abortSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_EXPIRED, { statusCode: 410 });
        return true;
      },
    );
    const raw = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8'));
    assert.equal(raw.status, 'initialized');
  });

  it('mutations on expired → EXPIRED', async () => {
    const proj = makeProjection({ files: [{ path: 'f.bin', size: 10, content: '0123456789' }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    clock.advanceMs(UPLOAD_SESSION_TTL_MS);
    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          chunkBytes: 10,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_EXPIRED, { statusCode: 410 });
        return true;
      },
    );
  });
});

// ── abort / terminal ────────────────────────────────────────────────

describe('abort and terminal transitions', () => {
  it('abort nonterminal → aborted; second abort idempotent', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const aborted = await store.abortSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(aborted.status, 'aborted');
    const again = await store.abortSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(again.status, 'aborted');
    assert.equal(again.uploadId, session.uploadId);
  });

  it('abort committed → unique UPLOAD_COMMIT_CONFLICT', async () => {
    const proj = makeProjection({ files: [{ path: 'z.bin', size: 0 }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.markVerifying({ authenticatedDeviceId: DEVICE_A, uploadId: session.uploadId });
    await store.markCommitted({ authenticatedDeviceId: DEVICE_A, uploadId: session.uploadId });
    await assert.rejects(
      () =>
        store.abortSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, {
          statusCode: 409,
          retryable: false,
        });
        return true;
      },
    );
  });

  it('markAborted mirrors abort terminal rules', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const aborted = await store.markAborted({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(aborted.status, 'aborted');
  });

  it('terminal cannot rollback: markVerifying/markCommitted invalid paths fail-close', async () => {
    const proj = makeProjection({ files: [{ path: 'z.bin', size: 0 }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.markVerifying({ authenticatedDeviceId: DEVICE_A, uploadId: session.uploadId });
    await store.markCommitted({ authenticatedDeviceId: DEVICE_A, uploadId: session.uploadId });

    await assert.rejects(
      () => store.markVerifying({ authenticatedDeviceId: DEVICE_A, uploadId: session.uploadId }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, { statusCode: 409 });
        return true;
      },
    );
    // markCommitted on already-committed is idempotent (not conflict).
    const again = await store.markCommitted({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(again.status, 'committed');
    assert.equal(again.uploadId, session.uploadId);
    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          chunkBytes: 1,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, { statusCode: 409 });
        return true;
      },
    );
  });

  it('markVerifying rejects when files incomplete', async () => {
    const proj = makeProjection({ files: [{ path: 'f.bin', size: 5, content: 'hello' }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await assert.rejects(
      () => store.markVerifying({ authenticatedDeviceId: DEVICE_A, uploadId: session.uploadId }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
  });

  it('markCommitted only from verifying', async () => {
    const proj = makeProjection({ files: [{ path: 'z.bin', size: 0 }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await assert.rejects(
      () => store.markCommitted({ authenticatedDeviceId: DEVICE_A, uploadId: session.uploadId }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
  });
});

// ── boundaries ──────────────────────────────────────────────────────

describe('boundaries', () => {
  it('listConfirmedBoundaries returns per-file contiguous state', async () => {
    const proj = makeProjection({
      files: [
        { path: 'a.bin', size: 0 },
        { path: 'b.bin', size: 10, content: '0123456789' },
      ],
    });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const list = await store.listConfirmedBoundaries({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.deepEqual(list, [
      { fileIndex: 0, size: 0, confirmedBytes: 0, confirmedChunks: 0, complete: true },
      { fileIndex: 1, size: 10, confirmedBytes: 0, confirmedChunks: 0, complete: false },
    ]);
  });

  it('first advance moves initialized → receiving; exact next only; no jump/regress', async () => {
    const size = 10;
    const proj = makeProjection({ files: [{ path: 'f.bin', size, content: '0123456789' }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });

    // Jump to chunkIndex 1 → out of order
    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 1,
          chunkBytes: size,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER, {
          statusCode: 409,
          retryable: true,
        });
        return true;
      },
    );

    const advanced = await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      chunkBytes: size,
    });
    assert.equal(advanced.status, 'receiving');
    assert.equal(advanced.files[0].confirmedBytes, size);
    assert.equal(advanced.files[0].confirmedChunks, 1);
    assert.equal(advanced.files[0].complete, true);

    // Duplicate exact boundary → idempotent
    const dup = await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      chunkBytes: size,
    });
    assert.equal(dup.files[0].confirmedBytes, size);
    assert.equal(dup.files[0].confirmedChunks, 1);

    // Oversize / past complete → out of order or invalid
    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 1,
          chunkBytes: 1,
        }),
      (error) => {
        assert.ok(error instanceof LinkeError);
        assert.ok(
          error.code === ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER
            || error.code === ERROR_CODES.UPLOAD_CHUNK_INVALID,
        );
        return true;
      },
    );
  });

  it('rejects chunkBytes exceeding remaining / non-positive / wrong fileIndex', async () => {
    const size = 10;
    const proj = makeProjection({ files: [{ path: 'f.bin', size, content: '0123456789' }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });

    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          chunkBytes: 11,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          chunkBytes: 0,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 3,
          chunkIndex: 0,
          chunkBytes: 1,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_OUT_OF_ORDER, { statusCode: 409 });
        return true;
      },
    );
  });

  it('multi-chunk file advances only exact next 8MiB boundaries', async () => {
    // Use size just over one chunk without allocating huge content for digest:
    // project with explicit sha for large size via synthetic entries through makeProjection content.
    // For test speed, use small CHUNK via... no, CHUNK is frozen 8MiB.
    // Simulate two logical steps by using size = CHUNK_SIZE + 1 with real content hash of zeros?
    // Hashing 8MiB+ is ok for a single test but heavy — use content 'a'.repeat for last chunk only.
    // Actually makeProjection hashes content — 8MiB of 'x' is fine for unit test (~few 10ms).
    const size = UPLOAD_CHUNK_SIZE + 5;
    const content = Buffer.alloc(size, 0x61).toString('latin1');
    const proj = makeProjection({
      files: [{ path: 'big.bin', size, content }],
    });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });

    // Wrong size for non-final chunk
    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          chunkBytes: UPLOAD_CHUNK_SIZE - 1,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );

    const mid = await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      chunkBytes: UPLOAD_CHUNK_SIZE,
    });
    assert.equal(mid.files[0].confirmedBytes, UPLOAD_CHUNK_SIZE);
    assert.equal(mid.files[0].complete, false);

    const done = await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 1,
      chunkBytes: 5,
    });
    assert.equal(done.files[0].confirmedBytes, size);
    assert.equal(done.files[0].confirmedChunks, 2);
    assert.equal(done.files[0].complete, true);
  });
});

// ── reconcile ───────────────────────────────────────────────────────

describe('reconcileStagingChunk', () => {
  it('advances only when exact next staging chunk size+sha256 match expected', async () => {
    const size = 12;
    const content = 'hello-world!';
    const sha = createHash('sha256').update(content, 'utf8').digest('hex');
    const proj = makeProjection({ files: [{ path: 'f.bin', size, content }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });

    // Place staging chunk without boundary advance (crash window).
    const chunkPath = stagingChunkAbs(DEVICE_A, session.uploadId, 0, 0);
    await mkdir(join(chunkPath, '..'), { recursive: true });
    await writeFile(chunkPath, content, 'utf8');

    const after = await store.reconcileStagingChunk({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      expectedSize: size,
      expectedSha256: sha,
    });
    assert.equal(after.status, 'receiving');
    assert.equal(after.files[0].confirmedBytes, size);
    assert.equal(after.files[0].complete, true);
  });

  it('mismatch size/hash does not advance and does not delete orphan', async () => {
    const size = 12;
    const content = 'hello-world!';
    const proj = makeProjection({ files: [{ path: 'f.bin', size, content }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const chunkPath = stagingChunkAbs(DEVICE_A, session.uploadId, 0, 0);
    await mkdir(join(chunkPath, '..'), { recursive: true });
    await writeFile(chunkPath, 'WRONG-CONTENT', 'utf8');

    const before = await store.getSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    const after = await store.reconcileStagingChunk({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      expectedSize: size,
      expectedSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    });
    assert.equal(after.files[0].confirmedBytes, before.files[0].confirmedBytes);
    // Orphan retained
    const still = await readFile(chunkPath, 'utf8');
    assert.equal(still, 'WRONG-CONTENT');
  });

  it('missing staging chunk is no-op (no throw advance)', async () => {
    const size = 4;
    const content = 'abcd';
    const proj = makeProjection({ files: [{ path: 'f.bin', size, content }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const after = await store.reconcileStagingChunk({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      expectedSize: size,
      expectedSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    });
    assert.equal(after.files[0].confirmedBytes, 0);
  });

  it('does not reconcile non-next chunkIndex (ignores without advance)', async () => {
    const size = UPLOAD_CHUNK_SIZE + 3;
    const content = Buffer.alloc(size, 0x62).toString('latin1');
    const proj = makeProjection({ files: [{ path: 'big.bin', size, content }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    // Write chunk-1 while next expected is chunk-0
    const chunkPath = stagingChunkAbs(DEVICE_A, session.uploadId, 0, 1);
    await mkdir(join(chunkPath, '..'), { recursive: true });
    await writeFile(chunkPath, content.slice(UPLOAD_CHUNK_SIZE), 'latin1');

    const after = await store.reconcileStagingChunk({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 1,
      expectedSize: 3,
      expectedSha256: createHash('sha256')
        .update(Buffer.from(content.slice(UPLOAD_CHUNK_SIZE), 'latin1'))
        .digest('hex'),
    });
    assert.equal(after.files[0].confirmedBytes, 0);
  });

  it('symlink staging chunk fail-closes with UPLOAD_IO_ERROR (no path leak)', async () => {
    const size = 4;
    const content = 'abcd';
    const proj = makeProjection({ files: [{ path: 'f.bin', size, content }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const chunkPath = stagingChunkAbs(DEVICE_A, session.uploadId, 0, 0);
    await mkdir(join(chunkPath, '..'), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), 'linke-uss-chunk-'));
    try {
      const target = join(outside, 'payload');
      await writeFile(target, content, 'utf8');
      await symlink(target, chunkPath);
      await assert.rejects(
        () =>
          store.reconcileStagingChunk({
            authenticatedDeviceId: DEVICE_A,
            uploadId: session.uploadId,
            fileIndex: 0,
            chunkIndex: 0,
            expectedSize: size,
            expectedSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
          }),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
            statusCode: 500,
            leakTokens: [outside, target, chunkPath, dataDir],
          });
          return true;
        },
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('expired reconcile → EXPIRED', async () => {
    const size = 4;
    const content = 'abcd';
    const proj = makeProjection({ files: [{ path: 'f.bin', size, content }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    clock.advanceMs(UPLOAD_SESSION_TTL_MS);
    await assert.rejects(
      () =>
        store.reconcileStagingChunk({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          expectedSize: size,
          expectedSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_EXPIRED, { statusCode: 410 });
        return true;
      },
    );
  });
});

// ── hostile / corrupt get ───────────────────────────────────────────

describe('hostile session records', () => {
  it('getSession on corrupt JSON → UPLOAD_IO_ERROR desensitized', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await writeFile(sessionJsonAbs(DEVICE_A, session.uploadId), '{"status":', 'utf8');
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          leakTokens: [dataDir, 'session.json', '{"status":'],
        });
        return true;
      },
    );
  });

  it('getSession rejects schema-hostile session (extra keys / bad status)', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const raw = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8'));
    raw.evilPath = '/etc/passwd';
    await writeFile(sessionJsonAbs(DEVICE_A, session.uploadId), JSON.stringify(raw), 'utf8');
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          leakTokens: ['/etc/passwd', dataDir],
        });
        return true;
      },
    );
  });

  it('session.json symlink → UPLOAD_IO_ERROR', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const abs = sessionJsonAbs(DEVICE_A, session.uploadId);
    const outside = await mkdtemp(join(tmpdir(), 'linke-uss-sj-'));
    try {
      const target = join(outside, 'session.json');
      await writeFile(target, await readFile(abs));
      await rm(abs);
      await symlink(target, abs);
      await assert.rejects(
        () =>
          store.getSession({
            authenticatedDeviceId: DEVICE_A,
            uploadId: session.uploadId,
          }),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
            leakTokens: [outside, target, dataDir],
          });
          return true;
        },
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// ── full happy path state machine ───────────────────────────────────

describe('state machine happy path', () => {
  it('initialized → receiving → verifying → committed', async () => {
    const size = 7;
    const content = 'payload';
    const proj = makeProjection({ files: [{ path: 'p.bin', size, content }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.equal(session.status, 'initialized');
    const r = await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      chunkBytes: size,
    });
    assert.equal(r.status, 'receiving');
    const v = await store.markVerifying({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(v.status, 'verifying');
    const c = await store.markCommitted({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(c.status, 'committed');
    // getSession still works for committed (terminal, not expired semantics for status)
    const got = await store.getSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(got.status, 'committed');
  });
});

// ── GLM P1/P2 + PM hardening regressions ────────────────────────────

describe('P1 per-file independent contiguous boundaries', () => {
  it('allows file1 exact next while file0 incomplete', async () => {
    const proj = makeProjection({
      files: [
        { path: 'a.bin', size: 10, content: '0123456789' },
        { path: 'b.bin', size: 4, content: 'zzzz' },
      ],
    });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    // Advance only fileIndex 1 while file 0 still at 0.
    const advanced = await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 1,
      chunkIndex: 0,
      chunkBytes: 4,
    });
    assert.equal(advanced.files[0].confirmedBytes, 0);
    assert.equal(advanced.files[0].complete, false);
    assert.equal(advanced.files[1].confirmedBytes, 4);
    assert.equal(advanced.files[1].complete, true);
    assert.equal(advanced.status, 'receiving');
  });
});

describe('P1 findActiveSession / listing read-only', () => {
  it('unknown device findActiveSession returns null without creating device tree', async () => {
    const unknown = 'device-never-seen-xyz';
    const before = await readdir(dataDir).catch(() => []);
    const found = await store.findActiveSession(unknown);
    assert.equal(found, null);
    // Must not create repo/devices/<slug>
    const slug = slugify(unknown);
    await assert.rejects(
      () => lstat(join(dataDir, 'repo', 'devices', slug)),
      (e) => e && e.code === 'ENOENT',
    );
    // dataDir should not gain a devices tree solely from find
    const repoExists = await lstat(join(dataDir, 'repo')).then(() => true).catch(() => false);
    if (repoExists) {
      const devicesExists = await lstat(join(dataDir, 'repo', 'devices'))
        .then(() => true)
        .catch(() => false);
      if (devicesExists) {
        const entries = await readdir(join(dataDir, 'repo', 'devices'));
        assert.ok(!entries.includes(slug));
      }
    }
    void before;
  });

  it('corrupt record on findActiveSession → UPLOAD_IO_ERROR (not null)', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await writeFile(sessionJsonAbs(DEVICE_A, session.uploadId), '{broken', 'utf8');
    await assert.rejects(
      () => store.findActiveSession(DEVICE_A),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          leakTokens: [dataDir, '{broken'],
        });
        return true;
      },
    );
  });

  it('symlink under upload-sessions on findActiveSession → UPLOAD_IO_ERROR', async () => {
    const proj = makeProjection();
    await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const sessionsAbs = join(dataDir, deviceRel, 'upload-sessions');
    const outside = await mkdtemp(join(tmpdir(), 'linke-uss-fa-'));
    try {
      await symlink(outside, join(sessionsAbs, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'), 'dir');
      await assert.rejects(
        () => store.findActiveSession(DEVICE_A),
        (error) => {
          assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
            leakTokens: [outside, dataDir],
          });
          return true;
        },
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('P1 crash-window create: session.json first, heal missing manifest', () => {
  it('retry same identity heals missing manifest and returns original uploadId', async () => {
    const proj = makeProjection({ files: [{ path: 'a.txt', size: 0 }] });
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    // Simulate crash after session.json: delete manifest
    const manifestAbs = join(
      sessionDirRel(DEVICE_A, first.uploadId),
      'manifest.canonical.json',
    );
    await rm(manifestAbs);

    const healed = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.equal(healed.uploadId, first.uploadId);
    const restored = await readFile(manifestAbs, 'utf8');
    assert.equal(restored, JSON.stringify(proj.manifest));
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const dirs = await readdir(join(dataDir, deviceRel, 'upload-sessions'));
    assert.equal(dirs.length, 1);
  });

  it('existing manifest with different content → UPLOAD_IO_ERROR (no overwrite)', async () => {
    const proj = makeProjection({ files: [{ path: 'a.txt', size: 0 }] });
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const manifestAbs = join(
      sessionDirRel(DEVICE_A, first.uploadId),
      'manifest.canonical.json',
    );
    await writeFile(manifestAbs, '{"tampered":true}', 'utf8');
    await assert.rejects(
      () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: proj.manifest.snapshotId,
          manifestDigest: proj.manifestDigest,
          canonicalManifest: proj.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          leakTokens: [manifestAbs, dataDir, 'tampered'],
        });
        return true;
      },
    );
    // Unchanged tampered content
    assert.equal(await readFile(manifestAbs, 'utf8'), '{"tampered":true}');
  });

  it('UUID dir missing session.json during scan → UPLOAD_IO_ERROR (not NOT_FOUND, not skip)', async () => {
    const proj = makeProjection();
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await rm(sessionJsonAbs(DEVICE_A, first.uploadId));
    const projB = makeProjection({ snapshotId: SNAPSHOT_B });
    await assert.rejects(
      () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: projB.manifest.snapshotId,
          manifestDigest: projB.manifestDigest,
          canonicalManifest: projB.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          leakTokens: [dataDir, first.uploadId],
        });
        assert.notEqual(error.code, ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
        return true;
      },
    );
  });
});

describe('P1 canonical binding via C1 projector', () => {
  it('digest mismatch → UPLOAD_MANIFEST_INVALID and creates no directories', async () => {
    const proj = makeProjection();
    const badDigest = 'a'.repeat(64);
    assert.notEqual(badDigest, proj.manifestDigest);
    await assert.rejects(
      () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: proj.manifest.snapshotId,
          manifestDigest: badDigest,
          canonicalManifest: proj.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_MANIFEST_INVALID, {
          statusCode: 400,
          leakTokens: [dataDir, badDigest],
        });
        return true;
      },
    );
    await assert.rejects(
      () => lstat(join(dataDir, 'repo', 'devices', slugify(DEVICE_A))),
      (e) => e && e.code === 'ENOENT',
    );
  });

  it('extra key on canonicalManifest → UPLOAD_MANIFEST_INVALID, no dirs', async () => {
    const proj = makeProjection();
    const hostile = { ...proj.manifest, evil: true };
    await assert.rejects(
      () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: proj.manifest.snapshotId,
          manifestDigest: proj.manifestDigest,
          canonicalManifest: hostile,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_MANIFEST_INVALID, { statusCode: 400 });
        return true;
      },
    );
    await assert.rejects(
      () => lstat(join(dataDir, 'repo', 'devices', slugify(DEVICE_A))),
      (e) => e && e.code === 'ENOENT',
    );
  });

  it('Proxy that mutates between project and later access does not fork on-disk identity', async () => {
    const base = makeProjection({ files: [{ path: 'a.txt', size: 0 }] });
    // Build a mutable plain object that project will accept, then wrap after?
    // Instead: Proxy over a valid structure that changes schemaVersion after first pass.
    // Projector reads once; store must not re-read raw for write — uses frozen projection JSON.
    const raw = {
      schemaVersion: 2,
      snapshotId: SNAPSHOT_A,
      deviceId: DEVICE_A,
      createdAt: T0,
      files: ['a.txt'],
      integrity: {
        algorithm: 'sha256',
        totalBytes: 0,
        entries: [{ path: 'a.txt', size: 0, sha256: ZERO_SHA }],
      },
    };
    let projectPasses = 0;
    const proxy = new Proxy(raw, {
      get(t, prop, recv) {
        if (prop === 'schemaVersion') {
          projectPasses += 1;
          // After successful project, subsequent reads would flip — store must not re-read.
          if (projectPasses > 8) return 999;
        }
        return Reflect.get(t, prop, recv);
      },
      ownKeys(t) {
        return Reflect.ownKeys(t);
      },
      getOwnPropertyDescriptor(t, p) {
        return Object.getOwnPropertyDescriptor(t, p);
      },
    });
    const { manifestDigest } = projectCanonicalUploadManifest(raw, {
      authenticatedDeviceId: DEVICE_A,
    });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      manifestDigest,
      canonicalManifest: proxy,
    });
    const onDisk = await readFile(
      join(sessionDirRel(DEVICE_A, session.uploadId), 'manifest.canonical.json'),
      'utf8',
    );
    // Must match C1 projection of the *original* valid shape, not a mutated re-read.
    const expected = JSON.stringify(
      projectCanonicalUploadManifest(raw, { authenticatedDeviceId: DEVICE_A }).manifest,
    );
    assert.equal(onDisk, expected);
    assert.equal(session.manifestDigest, manifestDigest);
  });
});

describe('P2 exact duplicate does not rewrite session', () => {
  it('3-chunk file: re-send chunk0 after advancing past it does not change updatedAt', async () => {
    const size = UPLOAD_CHUNK_SIZE * 2 + 7;
    const content = Buffer.alloc(size, 0x63).toString('latin1');
    const proj = makeProjection({ files: [{ path: 'triple.bin', size, content }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      chunkBytes: UPLOAD_CHUNK_SIZE,
    });
    const after1 = await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 1,
      chunkBytes: UPLOAD_CHUNK_SIZE,
    });
    const updatedAtBefore = after1.updatedAt;
    const rawBefore = await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8');

    // Advance wall clock so a rewrite would change updatedAt.
    clock.advanceMs(60_000);

    const dup = await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      chunkBytes: UPLOAD_CHUNK_SIZE,
    });
    assert.equal(dup.files[0].confirmedBytes, after1.files[0].confirmedBytes);
    assert.equal(dup.updatedAt, updatedAtBefore);
    const rawAfter = await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8');
    assert.equal(rawAfter, rawBefore);
  });
});

describe('P2 single now capture across TTL boundary', () => {
  it('uses one now snapshot for expiry check and updatedAt in same mutation', async () => {
    const proj = makeProjection({ files: [{ path: 'f.bin', size: 5, content: 'hello' }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    // now() first call: still valid; second call would cross TTL if captured twice.
    let calls = 0;
    const createdMs = Date.parse(T0);
    const flakyStore = createUploadSessionStore({
      dataDir,
      now: () => {
        calls += 1;
        if (calls === 1) return new Date(createdMs + UPLOAD_SESSION_TTL_MS - 1);
        // Subsequent calls would be past TTL — must not be used mid-op.
        return new Date(createdMs + UPLOAD_SESSION_TTL_MS + 1000);
      },
      randomUUID: () => uuidSeq.next(),
    });
    const advanced = await flakyStore.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      chunkBytes: 5,
    });
    assert.equal(advanced.files[0].complete, true);
    assert.equal(
      advanced.updatedAt,
      new Date(createdMs + UPLOAD_SESSION_TTL_MS - 1).toISOString(),
    );
    // Only one now() for the mutation critical section (may be 1).
    assert.equal(calls, 1);
  });
});

describe('P2 Dirent without methods fail-close', () => {
  it('list via create rejects entries missing isDirectory/isSymbolicLink', async () => {
    const proj = makeProjection();
    await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const sessionsAbs = join(dataDir, deviceRel, 'upload-sessions');
    const hostileStore = createUploadSessionStore({
      dataDir,
      now: () => clock.now(),
      randomUUID: () => uuidSeq.next(),
      readdir: async () => [
        { name: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }, // missing methods
      ],
    });
    const projB = makeProjection({ snapshotId: SNAPSHOT_B });
    await assert.rejects(
      () =>
        hostileStore.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: projB.manifest.snapshotId,
          manifestDigest: projB.manifestDigest,
          canonicalManifest: projB.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
    void sessionsAbs;
  });
});

describe('PM calendar-canonical ISO', () => {
  it('illegal calendar date in session record → UPLOAD_IO_ERROR', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const raw = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8'));
    // Feb 30 is not a real calendar day; Date.parse may roll but toISOString round-trip fails.
    raw.createdAt = '2026-02-30T12:00:00.000Z';
    raw.expiresAt = new Date(Date.parse(raw.createdAt) + UPLOAD_SESSION_TTL_MS).toISOString();
    await writeFile(sessionJsonAbs(DEVICE_A, session.uploadId), JSON.stringify(raw), 'utf8');
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          leakTokens: ['2026-02-30', dataDir],
        });
        return true;
      },
    );
  });

  it('writer persists exact three-digit millisecond ISO', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const raw = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8'));
    assert.match(raw.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(raw.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(new Date(raw.createdAt).toISOString(), raw.createdAt);
    assert.equal(new Date(raw.expiresAt).toISOString(), raw.expiresAt);
  });
});

describe('PM deep-frozen public summary', () => {
  it('mutating returned summary/files does not affect subsequent get', async () => {
    const proj = makeProjection({ files: [{ path: 'a.bin', size: 3, content: 'abc' }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.ok(Object.isFrozen(session));
    assert.ok(Object.isFrozen(session.files));
    assert.ok(Object.isFrozen(session.files[0]));
    assert.throws(() => {
      session.status = 'committed';
    });
    assert.throws(() => {
      session.files[0].confirmedBytes = 999;
    });
    const again = await store.getSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(again.status, 'initialized');
    assert.equal(again.files[0].confirmedBytes, 0);
  });
});

describe('PM parallel different-identity create + multi-active IO', () => {
  it('parallel different snapshot creates: one success, one conflict, one dir', async () => {
    const projA = makeProjection({ snapshotId: SNAPSHOT_A });
    const projB = makeProjection({ snapshotId: SNAPSHOT_B });
    const results = await Promise.allSettled([
      store.createSession({
        authenticatedDeviceId: DEVICE_A,
        snapshotId: projA.manifest.snapshotId,
        manifestDigest: projA.manifestDigest,
        canonicalManifest: projA.manifest,
      }),
      store.createSession({
        authenticatedDeviceId: DEVICE_A,
        snapshotId: projB.manifest.snapshotId,
        manifestDigest: projB.manifestDigest,
        canonicalManifest: projB.manifest,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assertLinkeCode(rejected[0].reason, ERROR_CODES.UPLOAD_SESSION_CONFLICT, {
      statusCode: 409,
    });
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const dirs = await readdir(join(dataDir, deviceRel, 'upload-sessions'));
    assert.equal(dirs.length, 1);
  });

  it('multi-active on-disk invariant → UPLOAD_IO_ERROR', async () => {
    const projA = makeProjection({ snapshotId: SNAPSHOT_A });
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: projA.manifest.snapshotId,
      manifestDigest: projA.manifestDigest,
      canonicalManifest: projA.manifest,
    });
    // Plant a second active session directory by cloning session.json with new ids.
    const raw = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, first.uploadId), 'utf8'));
    const plantedId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    raw.uploadId = plantedId;
    raw.snapshotId = SNAPSHOT_B;
    raw.manifestDigest = 'b'.repeat(64);
    const plantDir = sessionDirRel(DEVICE_A, plantedId);
    await mkdir(plantDir, { recursive: true });
    await writeFile(join(plantDir, 'session.json'), JSON.stringify(raw), 'utf8');
    await writeFile(join(plantDir, 'manifest.canonical.json'), '{}', 'utf8');

    await assert.rejects(
      () => store.findActiveSession(DEVICE_A),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
    const projC = makeProjection({
      snapshotId: '550e8400-e29b-41d4-a716-446655440099',
    });
    await assert.rejects(
      () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: projC.manifest.snapshotId,
          manifestDigest: projC.manifestDigest,
          canonicalManifest: projC.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
  });
});

// ── PM post-fix: session size cap + exclusive manifest write ──────

/**
 * Efficient C1-valid large manifest: N × 1-byte files, shared sha256 of "x".
 * @param {number} fileCount
 */
function makeLargeFileProjection(fileCount) {
  const oneByteSha = createHash('sha256').update('x', 'utf8').digest('hex');
  /** @type {string[]} */
  const files = [];
  /** @type {{ path: string, size: number, sha256: string }[]} */
  const entries = [];
  for (let i = 0; i < fileCount; i += 1) {
    // Fixed-width path keeps UTF-8 sort = lexical sort for this set.
    const path = `f${String(i).padStart(5, '0')}.bin`;
    files.push(path);
    entries.push({ path, size: 1, sha256: oneByteSha });
  }
  const input = {
    schemaVersion: 2,
    snapshotId: SNAPSHOT_A,
    deviceId: DEVICE_A,
    createdAt: T0,
    files,
    integrity: {
      algorithm: 'sha256',
      totalBytes: fileCount,
      entries,
    },
  };
  const { manifest, manifestDigest } = projectCanonicalUploadManifest(input, {
    authenticatedDeviceId: DEVICE_A,
  });
  return { manifest, manifestDigest, fileCount };
}

describe('PM-A C1/C2 session JSON size alignment (15000 files)', () => {
  it('create/get succeeds when canonical <8MiB but session.json >1MiB', async () => {
    const FILE_COUNT = 15_000;
    const { manifest, manifestDigest, fileCount } = makeLargeFileProjection(FILE_COUNT);
    const canonicalJson = JSON.stringify(manifest);
    const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');
    assert.ok(
      canonicalBytes < UPLOAD_MANIFEST_LIMITS.MAX_MANIFEST_JSON_UTF8_BYTES,
      `canonical must be <8MiB, got ${canonicalBytes}`,
    );
    assert.ok(canonicalBytes > 0);

    // Lower-bound estimate for session.json with FILE_COUNT boundaries (must exceed 1MiB).
    // Each boundary ≈ {"fileIndex":N,"size":1,"confirmedBytes":0,"confirmedChunks":0,"complete":false}
    // Rough ≥ 70 bytes × 15000 > 1MiB.
    const minSessionEstimate = FILE_COUNT * 70;
    assert.ok(
      minSessionEstimate > 1 * 1024 * 1024,
      'test fixture must stress >1MiB session records',
    );

    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: SNAPSHOT_A,
      manifestDigest,
      canonicalManifest: manifest,
    });
    assert.equal(session.status, 'initialized');
    assert.equal(session.files.length, fileCount);
    assert.equal(session.manifestDigest, manifestDigest);

    const sessionRaw = await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8');
    const sessionBytes = Buffer.byteLength(sessionRaw, 'utf8');
    assert.ok(
      sessionBytes > 1 * 1024 * 1024,
      `session.json must exceed 1MiB (got ${sessionBytes}) to pin the old cap bug`,
    );
    assert.ok(
      sessionBytes < 16 * 1024 * 1024,
      `session.json must stay under 16MiB hard cap (got ${sessionBytes})`,
    );

    const got = await store.getSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(got.files.length, FILE_COUNT);
    assert.equal(got.files[0].size, 1);
    assert.equal(got.files[FILE_COUNT - 1].fileIndex, FILE_COUNT - 1);
    assert.equal(got.files[FILE_COUNT - 1].complete, false);
  });
});

describe('PM-B exclusive manifest write / ENOENT TOCTOU', () => {
  it('exact existing manifest content is accepted idempotently (no overwrite path)', async () => {
    const proj = makeProjection({ files: [{ path: 'a.txt', size: 0 }] });
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const manifestAbs = join(
      sessionDirRel(DEVICE_A, first.uploadId),
      'manifest.canonical.json',
    );
    const before = await readFile(manifestAbs, 'utf8');
    const again = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    assert.equal(again.uploadId, first.uploadId);
    assert.equal(await readFile(manifestAbs, 'utf8'), before);
  });

  it('ENOENT then exclusive EEXIST with different content → IO, content unchanged', async () => {
    const proj = makeProjection({ files: [{ path: 'a.txt', size: 0 }] });
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const manifestAbs = join(
      sessionDirRel(DEVICE_A, first.uploadId),
      'manifest.canonical.json',
    );
    // Simulate crash window: remove store-written manifest, plant hostile different content.
    await rm(manifestAbs);
    const hostile = '{"hostile":"different-content-not-canonical"}';
    await writeFile(manifestAbs, hostile, 'utf8');

    // Inject TOCTOU: first read of manifest → ENOENT; exclusive create → EEXIST;
    // subsequent read → real planted hostile bytes.
    let manifestReadAttempts = 0;
    const raceStore = createUploadSessionStore({
      dataDir,
      now: () => clock.now(),
      randomUUID: () => uuidSeq.next(),
      safeDeps: {
        open: async (path, flags, mode) => {
          const p = String(path);
          if (p.endsWith('manifest.canonical.json') || p.endsWith('manifest.canonical.json/')) {
            const flagNum = typeof flags === 'number' ? flags : 0;
            const isExcl = (flagNum & constants.O_EXCL) !== 0;
            const isCreat = (flagNum & constants.O_CREAT) !== 0;
            if (isCreat && isExcl) {
              const err = new Error('EEXIST');
              err.code = 'EEXIST';
              throw err;
            }
            // Read path (O_RDONLY)
            if (!isCreat) {
              manifestReadAttempts += 1;
              if (manifestReadAttempts === 1) {
                const err = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
              }
            }
          }
          if (mode === undefined) return fsOpen(path, flags);
          return fsOpen(path, flags, mode);
        },
      },
    });

    await assert.rejects(
      () =>
        raceStore.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: proj.manifest.snapshotId,
          manifestDigest: proj.manifestDigest,
          canonicalManifest: proj.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          leakTokens: [manifestAbs, dataDir, 'hostile', hostile],
        });
        return true;
      },
    );
    // Planted content must not be overwritten by rename/atomic write.
    assert.equal(await readFile(manifestAbs, 'utf8'), hostile);
    assert.ok(manifestReadAttempts >= 2, 'must re-read after exclusive EEXIST');
  });
});

// ── GLM P2 + TEST_GAPS (post round-2) ───────────────────────────────

/**
 * Create a valid session then rewrite session.json with exact schema + mutator.
 * Ensures contradictions hit semantic checks, not missing-key schema rejects.
 * @param {(raw: Record<string, unknown>) => void} mutator
 * @param {{ files?: { path: string, size: number, content?: string }[] }} [opts]
 */
async function plantMutatedSession(mutator, opts = {}) {
  const proj = makeProjection(
    opts.files ? { files: opts.files } : { files: [{ path: 'p.bin', size: 5, content: 'hello' }] },
  );
  const session = await store.createSession({
    authenticatedDeviceId: DEVICE_A,
    snapshotId: proj.manifest.snapshotId,
    manifestDigest: proj.manifestDigest,
    canonicalManifest: proj.manifest,
  });
  const abs = sessionJsonAbs(DEVICE_A, session.uploadId);
  const raw = JSON.parse(await readFile(abs, 'utf8'));
  mutator(raw);
  // Preserve exact key set — mutator must not add keys.
  await writeFile(abs, JSON.stringify(raw), 'utf8');
  return { session, proj, abs, raw };
}

describe('P2 parseSessionRecord status/boundary semantic consistency', () => {
  it('initialized with confirmedBytes>0 → UPLOAD_IO_ERROR', async () => {
    const { session } = await plantMutatedSession((raw) => {
      raw.status = 'initialized';
      raw.boundaries[0].confirmedBytes = 5;
      raw.boundaries[0].confirmedChunks = 1;
      raw.boundaries[0].complete = true;
    });
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          leakTokens: [dataDir, 'confirmedBytes', session.uploadId],
        });
        return true;
      },
    );
  });

  it('receiving with all zero confirmedBytes → UPLOAD_IO_ERROR', async () => {
    const { session } = await plantMutatedSession((raw) => {
      raw.status = 'receiving';
      // boundaries remain at create defaults (all zero / zero-size complete)
    });
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
  });

  it('verifying with incomplete boundary → UPLOAD_IO_ERROR', async () => {
    const { session } = await plantMutatedSession((raw) => {
      raw.status = 'verifying';
      // size=5 file still incomplete at create defaults
      raw.boundaries[0].confirmedBytes = 0;
      raw.boundaries[0].confirmedChunks = 0;
      raw.boundaries[0].complete = false;
    });
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
  });

  it('committed with incomplete boundary → UPLOAD_IO_ERROR', async () => {
    const { session } = await plantMutatedSession((raw) => {
      raw.status = 'committed';
      raw.boundaries[0].confirmedBytes = 0;
      raw.boundaries[0].confirmedChunks = 0;
      raw.boundaries[0].complete = false;
    });
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
  });

  it('aborted with partial progress remains readable', async () => {
    const { session } = await plantMutatedSession((raw) => {
      raw.status = 'aborted';
      raw.boundaries[0].confirmedBytes = 5;
      raw.boundaries[0].confirmedChunks = 1;
      raw.boundaries[0].complete = true;
      raw.updatedAt = raw.createdAt;
    });
    const got = await store.getSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(got.status, 'aborted');
    assert.equal(got.files[0].confirmedBytes, 5);
  });
});

describe('P2 on-disk time invariants', () => {
  it('updatedAt < createdAt → UPLOAD_IO_ERROR', async () => {
    const { session } = await plantMutatedSession((raw) => {
      const createdMs = Date.parse(/** @type {string} */ (raw.createdAt));
      raw.updatedAt = new Date(createdMs - 1000).toISOString();
    });
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          leakTokens: [dataDir, 'updatedAt'],
        });
        return true;
      },
    );
  });

  it('updatedAt > expiresAt → UPLOAD_IO_ERROR', async () => {
    const { session } = await plantMutatedSession((raw) => {
      const expiresMs = Date.parse(/** @type {string} */ (raw.expiresAt));
      raw.updatedAt = new Date(expiresMs + 1000).toISOString();
    });
    await assert.rejects(
      () =>
        store.getSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
  });
});

describe('P2 dual same-identity committed fail-close', () => {
  it('two same-identity committed on disk → UPLOAD_IO_ERROR (no pick-latest)', async () => {
    const proj = makeProjection({ files: [{ path: 'z.bin', size: 0 }] });
    const first = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.markVerifying({
      authenticatedDeviceId: DEVICE_A,
      uploadId: first.uploadId,
    });
    await store.markCommitted({
      authenticatedDeviceId: DEVICE_A,
      uploadId: first.uploadId,
    });

    // Plant a second committed directory with same identity (exact schema clone).
    const raw = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, first.uploadId), 'utf8'));
    const plantedId = 'ffffffff-aaaa-4fff-8fff-ffffffffffff';
    raw.uploadId = plantedId;
    // Keep same snapshotId + manifestDigest + status committed + complete boundaries.
    const plantDir = sessionDirRel(DEVICE_A, plantedId);
    await mkdir(plantDir, { recursive: true });
    await writeFile(join(plantDir, 'session.json'), JSON.stringify(raw), 'utf8');
    await writeFile(
      join(plantDir, 'manifest.canonical.json'),
      await readFile(join(sessionDirRel(DEVICE_A, first.uploadId), 'manifest.canonical.json')),
    );

    await assert.rejects(
      () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: proj.manifest.snapshotId,
          manifestDigest: proj.manifestDigest,
          canonicalManifest: proj.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          leakTokens: [dataDir, plantedId, first.uploadId],
        });
        return true;
      },
    );
  });
});

describe('TEST_GAPS terminal / scope / alias', () => {
  it('reconcile on committed → UPLOAD_COMMIT_CONFLICT', async () => {
    const proj = makeProjection({ files: [{ path: 'z.bin', size: 0 }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.markVerifying({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    await store.markCommitted({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    await assert.rejects(
      () =>
        store.reconcileStagingChunk({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          expectedSize: 1,
          expectedSha256: ZERO_SHA,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, { statusCode: 409 });
        return true;
      },
    );
  });

  it('reconcile on aborted → UPLOAD_COMMIT_CONFLICT', async () => {
    const proj = makeProjection({ files: [{ path: 'a.bin', size: 4, content: 'abcd' }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.abortSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    await assert.rejects(
      () =>
        store.reconcileStagingChunk({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          expectedSize: 4,
          expectedSha256: createHash('sha256').update('abcd', 'utf8').digest('hex'),
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, { statusCode: 409 });
        return true;
      },
    );
  });

  it('advanceBoundary on verifying → UPLOAD_CHUNK_INVALID', async () => {
    const proj = makeProjection({ files: [{ path: 'z.bin', size: 0 }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.markVerifying({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          chunkBytes: 1,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_CHUNK_INVALID, { statusCode: 400 });
        return true;
      },
    );
  });

  it('reconcile cross-device → UPLOAD_SESSION_NOT_FOUND (no leak)', async () => {
    const proj = makeProjection({ files: [{ path: 'a.bin', size: 4, content: 'abcd' }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await assert.rejects(
      () =>
        store.reconcileStagingChunk({
          authenticatedDeviceId: DEVICE_B,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          expectedSize: 4,
          expectedSha256: createHash('sha256').update('abcd', 'utf8').digest('hex'),
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_NOT_FOUND, {
          statusCode: 404,
          leakTokens: [session.uploadId, DEVICE_A, dataDir],
        });
        return true;
      },
    );
  });

  it('markAborted on expired nonterminal → UPLOAD_SESSION_EXPIRED', async () => {
    const proj = makeProjection();
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    clock.advanceMs(UPLOAD_SESSION_TTL_MS);
    await assert.rejects(
      () =>
        store.markAborted({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_SESSION_EXPIRED, { statusCode: 410 });
        return true;
      },
    );
    const raw = JSON.parse(await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8'));
    assert.equal(raw.status, 'initialized');
  });
});

// ── GLM final P2 + remaining TEST_GAPS ──────────────────────────────

describe('P2 boundariesFromProjectedManifest early MAX_BOUNDARIES guard', () => {
  it('source checks entries.length before boundary allocation/loop (defense-in-depth)', async () => {
    const src = await readFile(
      new URL('../src/upload-session-store.js', import.meta.url),
      'utf8',
    );
    const start = src.indexOf('function boundariesFromProjectedManifest');
    assert.ok(start >= 0);
    const end = src.indexOf('\nfunction deviceScope', start);
    assert.ok(end > start);
    const body = src.slice(start, end);
    // Early bound: entryCount > MAX_BOUNDARIES failIo before boundaries alloc / loop.
    const checkIdx = body.indexOf('entryCount > MAX_BOUNDARIES');
    const allocIdx = body.indexOf('const boundaries = []');
    const loopIdx = body.indexOf('for (let i = 0; i < entryCount');
    assert.ok(checkIdx >= 0, 'must early-check entryCount > MAX_BOUNDARIES');
    assert.ok(allocIdx >= 0 && loopIdx >= 0);
    assert.ok(
      checkIdx < allocIdx && checkIdx < loopIdx,
      'MAX_BOUNDARIES check must precede boundaries allocation and entries loop',
    );
  });
});

describe('P2 confirmed-coordinate size conflict → INTEGRITY_FAILED + abort', () => {
  it('3-chunk: after two advances, wrong-size chunk0 aborts without boundary advance', async () => {
    const size = UPLOAD_CHUNK_SIZE * 2 + 7;
    const content = Buffer.alloc(size, 0x64).toString('latin1');
    const proj = makeProjection({ files: [{ path: 'triple.bin', size, content }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      chunkBytes: UPLOAD_CHUNK_SIZE,
    });
    const mid = await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 1,
      chunkBytes: UPLOAD_CHUNK_SIZE,
    });
    assert.equal(mid.files[0].confirmedChunks, 2);
    const confirmedBefore = mid.files[0].confirmedBytes;

    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          chunkBytes: UPLOAD_CHUNK_SIZE - 1, // wrong size on confirmed coordinate
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_INTEGRITY_FAILED, {
          statusCode: 409,
          retryable: false,
          leakTokens: [dataDir, session.uploadId, 'chunk'],
        });
        return true;
      },
    );

    const got = await store.getSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(got.status, 'aborted');
    assert.equal(got.files[0].confirmedBytes, confirmedBefore);
    assert.equal(got.files[0].confirmedChunks, 2);
  });
});

describe('P2 markCommitted idempotent on committed', () => {
  it('re-markCommitted returns frozen summary without rewrite', async () => {
    const proj = makeProjection({ files: [{ path: 'z.bin', size: 0 }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.markVerifying({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    const committed = await store.markCommitted({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    const rawBefore = await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8');
    clock.advanceMs(60_000);
    const again = await store.markCommitted({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    assert.equal(again.status, 'committed');
    assert.equal(again.updatedAt, committed.updatedAt);
    assert.ok(Object.isFrozen(again));
    assert.equal(await readFile(sessionJsonAbs(DEVICE_A, session.uploadId), 'utf8'), rawBefore);

    // aborted still conflicts
    const proj2 = makeProjection({
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'z.bin', size: 0 }],
    });
    const s2 = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj2.manifest.snapshotId,
      manifestDigest: proj2.manifestDigest,
      canonicalManifest: proj2.manifest,
    });
    await store.abortSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: s2.uploadId,
    });
    await assert.rejects(
      () =>
        store.markCommitted({
          authenticatedDeviceId: DEVICE_A,
          uploadId: s2.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, { statusCode: 409 });
        return true;
      },
    );
  });
});

describe('P2 toCanonicalIso RangeError / Invalid Date', () => {
  it('create with now near Date upper bound such that +TTL overflows → IO, no session dir', async () => {
    // ECMAScript time value max ≈ 8.64e15; +24h can push past and throw RangeError.
    const nearMax = 8.64e15 - 1000;
    const overflowStore = createUploadSessionStore({
      dataDir,
      now: () => new Date(nearMax),
      randomUUID: () => uuidSeq.next(),
    });
    const proj = makeProjection();
    await assert.rejects(
      () =>
        overflowStore.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: proj.manifest.snapshotId,
          manifestDigest: proj.manifestDigest,
          canonicalManifest: proj.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, {
          statusCode: 500,
          leakTokens: ['RangeError', 'Invalid time value', String(nearMax)],
        });
        assert.ok(!(error instanceof RangeError));
        return true;
      },
    );
    // No session records for device
    const slug = slugify(DEVICE_A);
    const sessionsPath = join(dataDir, 'repo', 'devices', slug, 'upload-sessions');
    const exists = await lstat(sessionsPath).then(() => true).catch(() => false);
    if (exists) {
      const dirs = await readdir(sessionsPath);
      assert.equal(dirs.length, 0);
    }
  });

  it('now() Invalid Date → UPLOAD_IO_ERROR', async () => {
    const badStore = createUploadSessionStore({
      dataDir,
      now: () => new Date(Number.NaN),
      randomUUID: () => uuidSeq.next(),
    });
    const proj = makeProjection();
    await assert.rejects(
      () =>
        badStore.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: proj.manifest.snapshotId,
          manifestDigest: proj.manifestDigest,
          canonicalManifest: proj.manifest,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_IO_ERROR, { statusCode: 500 });
        return true;
      },
    );
  });
});

describe('TEST_GAPS advance/verify on terminal + reconcile size mismatch', () => {
  it('advanceBoundary on aborted → UPLOAD_COMMIT_CONFLICT', async () => {
    const proj = makeProjection({ files: [{ path: 'a.bin', size: 4, content: 'abcd' }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    await store.abortSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
    });
    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId: session.uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          chunkBytes: 4,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, { statusCode: 409 });
        return true;
      },
    );
  });

  it('markVerifying on aborted/committed → UPLOAD_COMMIT_CONFLICT', async () => {
    const projA = makeProjection({ files: [{ path: 'z.bin', size: 0 }] });
    const aborted = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: projA.manifest.snapshotId,
      manifestDigest: projA.manifestDigest,
      canonicalManifest: projA.manifest,
    });
    await store.abortSession({
      authenticatedDeviceId: DEVICE_A,
      uploadId: aborted.uploadId,
    });
    await assert.rejects(
      () =>
        store.markVerifying({
          authenticatedDeviceId: DEVICE_A,
          uploadId: aborted.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, { statusCode: 409 });
        return true;
      },
    );

    const projB = makeProjection({
      snapshotId: SNAPSHOT_B,
      files: [{ path: 'z.bin', size: 0 }],
    });
    const committed = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: projB.manifest.snapshotId,
      manifestDigest: projB.manifestDigest,
      canonicalManifest: projB.manifest,
    });
    await store.markVerifying({
      authenticatedDeviceId: DEVICE_A,
      uploadId: committed.uploadId,
    });
    await store.markCommitted({
      authenticatedDeviceId: DEVICE_A,
      uploadId: committed.uploadId,
    });
    await assert.rejects(
      () =>
        store.markVerifying({
          authenticatedDeviceId: DEVICE_A,
          uploadId: committed.uploadId,
        }),
      (error) => {
        assertLinkeCode(error, ERROR_CODES.UPLOAD_COMMIT_CONFLICT, { statusCode: 409 });
        return true;
      },
    );
  });

  it('reconcile when staging size > expectedSize (still ≤8MiB) → no-op, file retained', async () => {
    const size = 4;
    const content = 'abcd';
    const proj = makeProjection({ files: [{ path: 'f.bin', size, content }] });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const chunkPath = stagingChunkAbs(DEVICE_A, session.uploadId, 0, 0);
    await mkdir(join(chunkPath, '..'), { recursive: true });
    // Actual on-disk size larger than expected, but still well under 8MiB.
    const oversized = `${content}EXTRA`;
    await writeFile(chunkPath, oversized, 'utf8');
    assert.ok(Buffer.byteLength(oversized, 'utf8') > size);
    assert.ok(Buffer.byteLength(oversized, 'utf8') <= UPLOAD_CHUNK_SIZE);

    const after = await store.reconcileStagingChunk({
      authenticatedDeviceId: DEVICE_A,
      uploadId: session.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      expectedSize: size,
      expectedSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    });
    assert.equal(after.files[0].confirmedBytes, 0);
    assert.equal(after.status, 'initialized');
    assert.equal(await readFile(chunkPath, 'utf8'), oversized);
  });
});

// ── AbortSignal write boundaries (P0 / C2) ───────────────────────────

describe('store AbortSignal write boundaries (RED)', () => {
  it('createSession with already-aborted signal does not create session dir', async () => {
    const proj = makeProjection();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () =>
        store.createSession({
          authenticatedDeviceId: DEVICE_A,
          snapshotId: proj.manifest.snapshotId,
          manifestDigest: proj.manifestDigest,
          canonicalManifest: proj.manifest,
          signal: ac.signal,
        }),
      (error) => error instanceof Error,
    );
    const { deviceRel } = safeDevicePath(dataDir, DEVICE_A);
    const root = join(dataDir, deviceRel, 'upload-sessions');
    let names = [];
    try {
      names = await readdir(root);
    } catch {
      names = [];
    }
    assert.equal(names.length, 0, 'aborted createSession must not leave upload-sessions entries');
  });

  it('abortSession/advanceBoundary/markVerifying/markCommitted refuse write when signal already aborted', async () => {
    const proj = makeProjection({
      files: [{ path: 'a.txt', size: 4, content: 'abcd' }],
    });
    const session = await store.createSession({
      authenticatedDeviceId: DEVICE_A,
      snapshotId: proj.manifest.snapshotId,
      manifestDigest: proj.manifestDigest,
      canonicalManifest: proj.manifest,
    });
    const uploadId = session.uploadId;
    const sessionPath = sessionJsonAbs(DEVICE_A, uploadId);
    const beforeRaw = await readFile(sessionPath, 'utf8');
    const before = JSON.parse(beforeRaw);

    const ac = new AbortController();
    ac.abort();

    await assert.rejects(
      () =>
        store.abortSession({
          authenticatedDeviceId: DEVICE_A,
          uploadId,
          signal: ac.signal,
        }),
      (error) => error instanceof Error,
    );
    assert.equal(JSON.parse(await readFile(sessionPath, 'utf8')).status, before.status);

    await assert.rejects(
      () =>
        store.advanceBoundary({
          authenticatedDeviceId: DEVICE_A,
          uploadId,
          fileIndex: 0,
          chunkIndex: 0,
          chunkBytes: 4,
          signal: ac.signal,
        }),
      (error) => error instanceof Error,
    );
    // Disk session.json uses C2 schema field `boundaries` (public summary uses `files`).
    assert.equal(
      JSON.parse(await readFile(sessionPath, 'utf8')).boundaries[0].confirmedBytes,
      before.boundaries[0].confirmedBytes,
    );

    // Prepare a complete session for markVerifying/markCommitted boundaries.
    await store.advanceBoundary({
      authenticatedDeviceId: DEVICE_A,
      uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      chunkBytes: 4,
    });
    const midRaw = await readFile(sessionPath, 'utf8');

    await assert.rejects(
      () =>
        store.markVerifying({
          authenticatedDeviceId: DEVICE_A,
          uploadId,
          signal: ac.signal,
        }),
      (error) => error instanceof Error,
    );
    assert.equal(await readFile(sessionPath, 'utf8'), midRaw);

    // Live markVerifying then aborted markCommitted.
    await store.markVerifying({
      authenticatedDeviceId: DEVICE_A,
      uploadId,
    });
    const verifyingRaw = await readFile(sessionPath, 'utf8');
    await assert.rejects(
      () =>
        store.markCommitted({
          authenticatedDeviceId: DEVICE_A,
          uploadId,
          signal: ac.signal,
        }),
      (error) => error instanceof Error,
    );
    assert.equal(await readFile(sessionPath, 'utf8'), verifyingRaw);
    assert.equal(JSON.parse(verifyingRaw).status, 'verifying');
  });
});
